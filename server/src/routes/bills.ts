import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, forbidden, isoDate, notFound, optText, parse, uuid } from '../lib/http.js';
import { addDays } from '../engine/time.js';
import { calculate, EDITABLE_STATUSES, eligibleDuties, FINAL_STATUSES, generateOutputs, getBill, isStale, nextBillNo } from '../services/billing.js';
import { getSetting } from './master.js';

export async function billRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/bills', { preHandler: perm('view') }, async (req) => {
    const q = parse(z.object({ clientId: uuid.optional(), contractId: uuid.optional(), status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
    return db.query(
      `SELECT b.*, c.name AS client_name, c.short_code, k.reference_no AS contract_ref, k.title AS contract_title,
              (SELECT count(*)::int FROM bill_duties bd WHERE bd.bill_id = b.id) AS duty_count,
              (SELECT count(*)::int FROM billing_exceptions e WHERE e.bill_id = b.id AND e.status = 'open') AS open_exceptions,
              u.name AS created_by_name
       FROM bills b JOIN clients c ON c.id = b.client_id JOIN contracts k ON k.id = b.contract_id LEFT JOIN app_users u ON u.id = b.created_by
       WHERE ($1::uuid IS NULL OR b.client_id = $1) AND ($2::uuid IS NULL OR b.contract_id = $2) AND ($3::text IS NULL OR b.status = $3)
         AND ($4::date IS NULL OR b.period_start >= $4) AND ($5::date IS NULL OR b.period_start <= $5)
       ORDER BY b.period_start DESC, c.name, b.revision_no DESC`,
      [q.clientId ?? null, q.contractId ?? null, q.status || null, q.from ?? null, q.to ?? null],
    );
  });

  app.post('/bills', { preHandler: perm('bill.prepare') }, async (req) => {
    const b = parse(z.object({ contract_id: uuid, period_start: isoDate, period_end: isoDate, bill_date: isoDate.optional(), template_version_id: uuid.nullable().optional(), include_unverified: z.boolean().default(true), notes: optText }), req.body);
    if (b.period_end < b.period_start) throw badRequest('Period end is before period start');
    const k = await db.one<{ client_id: string; status: string }>('SELECT client_id, status FROM contracts WHERE id = $1', [b.contract_id]);
    if (!k) throw notFound('Contract');
    const dup = await db.one<{ id: string; status: string }>(
      `SELECT id, status FROM bills WHERE contract_id = $1 AND status NOT IN ('cancelled','superseded') AND period_start <= $3 AND period_end >= $2 LIMIT 1`, [b.contract_id, b.period_start, b.period_end]);
    if (dup) throw conflict(`A ${dup.status} bill already covers part of this period. Open it, or cancel it first.`);
    // Default template: latest approved version for the contract, else for the client.
    const tv = b.template_version_id ?? (await db.one<{ id: string }>(
      `SELECT v.id FROM billing_template_versions v JOIN billing_templates t ON t.id = v.template_id
       WHERE v.status = 'approved' AND (t.contract_id = $1 OR (t.contract_id IS NULL AND t.client_id = $2)) ORDER BY (t.contract_id IS NOT NULL) DESC, v.approved_at DESC LIMIT 1`,
      [b.contract_id, k.client_id]))?.id ?? null;
    const row = await db.one<{ id: string }>(
      `INSERT INTO bills(client_id, contract_id, period_start, period_end, bill_date, template_version_id, include_unverified, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [k.client_id, b.contract_id, b.period_start, b.period_end, b.bill_date ?? addDays(b.period_end, 1), tv, b.include_unverified, b.notes, req.user!.id],
    );
    await audit(db, req.user!.id, 'bill', row!.id, 'create', undefined, b);
    return row;
  });

  app.get('/bills/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const bill = await db.one<Record<string, unknown>>(
      `SELECT b.*, c.name AS client_name, c.short_code, k.reference_no AS contract_ref, k.title AS contract_title, k.approval_levels,
              cu.name AS created_by_name, ru.name AS reviewed_by_name, au.name AS approved_by_name, tv.version_no AS template_version_no, tv.status AS template_status, t.name AS template_name,
              s.created_at AS calculated_at, s.engine_version, s.content_hash, s.output->'checks' AS checks, s.output->'totals' AS totals
       FROM bills b JOIN clients c ON c.id = b.client_id JOIN contracts k ON k.id = b.contract_id
       LEFT JOIN app_users cu ON cu.id = b.created_by LEFT JOIN app_users ru ON ru.id = b.reviewed_by LEFT JOIN app_users au ON au.id = b.approved_by
       LEFT JOIN billing_template_versions tv ON tv.id = b.template_version_id LEFT JOIN billing_templates t ON t.id = tv.template_id
       LEFT JOIN calculation_snapshots s ON s.id = b.current_snapshot_id WHERE b.id = $1`, [id]);
    if (!bill) throw notFound('Bill');
    const [lines, taxLines, exceptions, approvals, files, revisions, duties] = await Promise.all([
      db.query(`SELECT l.*, d.duty_date FROM bill_lines l LEFT JOIN duties d ON d.id = l.duty_id WHERE l.bill_id = $1 ORDER BY l.sort_order`, [id]),
      db.query('SELECT * FROM bill_tax_lines WHERE bill_id = $1 ORDER BY name', [id]),
      db.query(`SELECT e.*, d.vehicle_reg_no, d.duty_date, u.name AS resolved_by_name FROM billing_exceptions e LEFT JOIN duties d ON d.id = e.duty_id LEFT JOIN app_users u ON u.id = e.resolved_by
                WHERE e.bill_id = $1 ORDER BY (e.severity = 'error') DESC, e.status, d.duty_date NULLS FIRST`, [id]),
      db.query(`SELECT a.*, u.name AS user_name FROM approvals a JOIN app_users u ON u.id = a.user_id WHERE a.entity_type = 'bill' AND a.entity_id = $1 ORDER BY a.created_at`, [id]),
      db.query(`SELECT g.*, f.original_name, f.size_bytes, f.sha256 FROM generated_files g JOIN files f ON f.id = g.file_id WHERE g.bill_id = $1 ORDER BY g.created_at DESC`, [id]),
      db.query(`SELECT id, revision_no, status, grand_total, revision_reason FROM bills WHERE bill_no IS NOT DISTINCT FROM $1 AND $1 IS NOT NULL OR id = $2 OR revision_of = $2 ORDER BY revision_no`, [bill.bill_no, id]),
      db.query(`SELECT d.id, d.duty_date, d.vehicle_reg_no, d.driver_name, d.status, d.start_km, d.end_km, d.start_at, d.end_at, bd.active,
                  (SELECT COALESCE(sum(amount),0) FROM bill_lines l WHERE l.bill_id = $1 AND l.duty_id = d.id) AS amount
                FROM bill_duties bd JOIN duties d ON d.id = bd.duty_id WHERE bd.bill_id = $1 ORDER BY d.duty_date, d.start_at`, [id]),
    ]);
    const stale = bill.current_snapshot_id && EDITABLE_STATUSES.includes(String(bill.status)) ? await isStale(db, id) : false;
    return { ...bill, stale, lines, taxLines, exceptions, approvals, files, revisions, duties };
  });

  /** Step 2–3: what would be billed, and what needs attention, before calculating. */
  app.get('/bills/:id/precheck', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const bill = await getBill(db, id);
    const rows = await eligibleDuties(db, bill);
    const excluded = new Set(bill.excluded_duties.map((e) => e.dutyId));
    const vehicles = new Map<string, Set<string>>();
    for (const r of rows) {
      const k = String(r.vehicle_reg_no);
      if (!vehicles.has(k)) vehicles.set(k, new Set());
      vehicles.get(k)!.add(String(r.duty_date));
    }
    const days: string[] = [];
    for (let d = bill.period_start; d <= bill.period_end; d = addDays(d, 1)) days.push(d);
    const gaps = [...vehicles].map(([v, set]) => ({ vehicle: v, daysWithDuty: set.size, missingDates: days.filter((d) => !set.has(d)) }));
    return {
      total: rows.length,
      excluded: bill.excluded_duties,
      alreadyBilled: rows.filter((r) => r.other_bill).map((r) => ({ id: r.id, vehicle: r.vehicle_reg_no, date: r.duty_date, bill: r.other_bill })),
      withErrors: rows.filter((r) => Number(r.error_count) > 0 && !excluded.has(String(r.id))).map((r) => ({ id: r.id, vehicle: r.vehicle_reg_no, date: r.duty_date, issues: r.issues })),
      withWarnings: rows.filter((r) => Number(r.warning_count) > 0 && !excluded.has(String(r.id))).length,
      unverified: rows.filter((r) => r.status !== 'verified' && !excluded.has(String(r.id))).length,
      unknownCategory: rows.filter((r) => !r.vehicle_category_id).length,
      vehicleCoverage: gaps,
      periodDays: days.length,
    };
  });

  const assertEditable = (status: string) => {
    if (!EDITABLE_STATUSES.includes(status)) throw conflict(`This bill is ${status} and cannot be changed. Create a revision instead.`);
  };

  app.patch('/bills/:id', { preHandler: perm('bill.prepare') }, async (req) => {
    const { id } = req.params as { id: string };
    const bill = await getBill(db, id);
    assertEditable(bill.status);
    const b = parse(z.object({ bill_date: isoDate.optional(), template_version_id: uuid.nullable().optional(), include_unverified: z.boolean().optional(), notes: optText }), req.body);
    if (b.template_version_id) {
      const tv = await db.one<{ status: string }>('SELECT status FROM billing_template_versions WHERE id = $1', [b.template_version_id]);
      if (!tv || tv.status !== 'approved') throw badRequest('Choose an approved template version');
    }
    const row = await db.one(
      `UPDATE bills SET bill_date = COALESCE($2, bill_date), template_version_id = COALESCE($3, template_version_id), include_unverified = COALESCE($4, include_unverified), notes = COALESCE($5, notes),
         status = CASE WHEN status = 'under_review' THEN 'validation_required' ELSE status END, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, b.bill_date ?? null, b.template_version_id ?? null, b.include_unverified ?? null, b.notes],
    );
    await audit(db, req.user!.id, 'bill', id, 'update', bill, row);
    return row;
  });

  app.post('/bills/:id/exclude', { preHandler: perm('bill.prepare') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ dutyId: uuid, reason: z.string().min(3, 'Give a reason'), include: z.boolean().default(false) }), req.body);
    const bill = await getBill(db, id);
    assertEditable(bill.status);
    const list = bill.excluded_duties.filter((e) => e.dutyId !== b.dutyId);
    if (!b.include) list.push({ dutyId: b.dutyId, reason: b.reason, by: req.user!.id, at: new Date().toISOString() } as never);
    await db.query(`UPDATE bills SET excluded_duties = $2::jsonb, status = 'calculation_pending', updated_at = now() WHERE id = $1`, [id, JSON.stringify(list)]);
    await audit(db, req.user!.id, 'bill', id, b.include ? 'include_duty' : 'exclude_duty', undefined, { dutyId: b.dutyId }, b.reason);
    return { excluded: list };
  });

  app.post('/bills/:id/calculate', { preHandler: perm('bill.prepare') }, async (req) => calculate(db, (req.params as { id: string }).id, req.user!.id));

  app.patch('/billing-exceptions/:id', { preHandler: perm('bill.review') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ status: z.enum(['waived', 'open']), note: optText }), req.body);
    const e = await db.one<{ bill_id: string; severity: string; status: string }>('SELECT * FROM billing_exceptions WHERE id = $1', [id]);
    if (!e) throw notFound('Exception');
    const bill = await getBill(db, e.bill_id);
    assertEditable(bill.status);
    if (b.status === 'waived' && e.severity === 'error') throw badRequest('Errors cannot be waived. Correct the duty or rule and recalculate, or exclude the duty with a reason.');
    if (b.status === 'waived' && !b.note) throw badRequest('Record why this warning is acceptable');
    const row = await db.one(`UPDATE billing_exceptions SET status=$2, resolution_note=$3, resolved_by=$4, resolved_at=now() WHERE id=$1 RETURNING *`, [id, b.status, b.note, req.user!.id]);
    const open = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM billing_exceptions WHERE bill_id = $1 AND status = 'open'`, [e.bill_id]);
    if (bill.status === 'validation_required' && open!.n === 0) await db.query(`UPDATE bills SET status = 'draft' WHERE id = $1`, [e.bill_id]);
    if (bill.status === 'draft' && open!.n > 0) await db.query(`UPDATE bills SET status = 'validation_required' WHERE id = $1`, [e.bill_id]);
    await audit(db, req.user!.id, 'billing_exception', id, `exception_${b.status}`, e, row, b.note ?? undefined);
    return row;
  });

  const readyChecks = async (id: string) => {
    const bill = await getBill(db, id);
    if (!bill.current_snapshot_id) throw badRequest('Calculate the bill first');
    if (await isStale(db, id)) throw conflict('Duties changed after the last calculation. Recalculate before continuing.');
    const open = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM billing_exceptions WHERE bill_id = $1 AND status = 'open'`, [id]);
    if (open!.n > 0) throw conflict(`${open!.n} exception(s) are still open`);
    return bill;
  };

  app.post('/bills/:id/submit-review', { preHandler: perm('bill.prepare') }, async (req) => {
    const { id } = req.params as { id: string };
    const bill = await readyChecks(id);
    if (!['draft', 'validation_required'].includes(bill.status)) throw conflict(`Bill is ${bill.status}`);
    if (!bill.template_version_id) throw badRequest('Select an approved billing template first');
    await db.query(`UPDATE bills SET status='under_review', updated_at=now() WHERE id=$1`, [id]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id) VALUES ('bill',$1,'submit_review',$2)`, [id, req.user!.id]);
    await audit(db, req.user!.id, 'bill', id, 'submit_review');
    return { status: 'under_review' };
  });

  app.post('/bills/:id/review', { preHandler: perm('bill.review') }, async (req) => {
    const { id } = req.params as { id: string };
    const { note } = parse(z.object({ note: optText }), req.body ?? {});
    const bill = await readyChecks(id);
    if (bill.status !== 'under_review') throw conflict('Only bills under review can be marked reviewed');
    if ((await getSetting<boolean>(db, 'makerChecker')) && bill.created_by === req.user!.id) throw forbidden('Maker-checker is enabled: the preparer cannot review their own bill.');
    await db.query(`UPDATE bills SET reviewed_by=$2, reviewed_at=now() WHERE id=$1`, [id, req.user!.id]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('bill',$1,'review',$2,$3)`, [id, req.user!.id, note]);
    await audit(db, req.user!.id, 'bill', id, 'review', undefined, undefined, note ?? undefined);
    return { ok: true };
  });

  app.post('/bills/:id/approve', { preHandler: perm('bill.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const { note } = parse(z.object({ note: optText }), req.body ?? {});
    const bill = await readyChecks(id);
    if (bill.status !== 'under_review') throw conflict('Only bills under review can be approved');
    const k = await db.one<{ approval_levels: number }>('SELECT approval_levels FROM contracts WHERE id = $1', [bill.contract_id]);
    if (k!.approval_levels === 2 && !bill.reviewed_by) throw conflict('This contract requires a reviewer sign-off before approval');
    if ((await getSetting<boolean>(db, 'makerChecker')) && [bill.created_by, bill.reviewed_by].includes(req.user!.id)) throw forbidden('Maker-checker is enabled: a different user must approve.');
    const tv = await db.one<{ status: string }>('SELECT status FROM billing_template_versions WHERE id = $1', [bill.template_version_id]);
    if (!tv || tv.status === 'draft') throw badRequest('The selected template version is not approved');
    return db.tx(async (t) => {
      const billNo = bill.bill_no ?? (await nextBillNo(t, bill));
      await t.query(`UPDATE bills SET bill_no=$2, status='approved', approved_by=$3, approved_at=now(), updated_at=now() WHERE id=$1`, [id, billNo, req.user!.id]);
      if (bill.revision_of) {
        // The revision replaces the original: move the duty links over.
        const family = await t.query<{ id: string }>(`SELECT id FROM bills WHERE bill_no = $1 AND id <> $2 AND status IN ('approved','generated','submitted')`, [billNo, id]);
        for (const f of family) {
          await t.query(`UPDATE bill_duties SET active = false WHERE bill_id = $1`, [f.id]);
          await t.query(`UPDATE bills SET status = 'superseded', updated_at = now() WHERE id = $1`, [f.id]);
          await audit(t, req.user!.id, 'bill', f.id, 'superseded', undefined, { by: id });
        }
        await t.query(`UPDATE bill_duties SET active = true WHERE bill_id = $1`, [id]);
      }
      await t.query(`UPDATE duties SET status = 'billed', updated_at = updated_at WHERE id IN (SELECT duty_id FROM bill_duties WHERE bill_id = $1)`, [id]);
      await t.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('bill',$1,'approve',$2,$3)`, [id, req.user!.id, note]);
      await audit(t, req.user!.id, 'bill', id, 'approve', { status: bill.status }, { status: 'approved', billNo }, note ?? undefined);
      return { status: 'approved', billNo };
    });
  });

  app.post('/bills/:id/reject', { preHandler: perm('bill.review') }, async (req) => {
    const { id } = req.params as { id: string };
    const { note } = parse(z.object({ note: z.string().min(3, 'Give a reason') }), req.body);
    const bill = await getBill(db, id);
    if (bill.status !== 'under_review') throw conflict('Only bills under review can be sent back');
    await db.query(`UPDATE bills SET status='validation_required', reviewed_by=NULL, reviewed_at=NULL, updated_at=now() WHERE id=$1`, [id]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('bill',$1,'reject',$2,$3)`, [id, req.user!.id, note]);
    await audit(db, req.user!.id, 'bill', id, 'reject', undefined, undefined, note);
    return { status: 'validation_required' };
  });

  app.post('/bills/:id/generate', { preHandler: perm('export') }, async (req) => {
    const { id } = req.params as { id: string };
    const bill = await getBill(db, id);
    if (!FINAL_STATUSES.includes(bill.status)) throw conflict('Customer bills are generated only after approval. Use the template preview for drafts.');
    return generateOutputs(db, id, req.user!.id);
  });

  app.post('/bills/:id/submit', { preHandler: perm('bill.submit') }, async (req) => {
    const { id } = req.params as { id: string };
    const { submission_ref } = parse(z.object({ submission_ref: z.string().min(1, 'Enter the submission / diary reference') }), req.body);
    const bill = await getBill(db, id);
    if (bill.status !== 'generated') throw conflict('Generate and check the bill files before marking it submitted');
    await db.query(`UPDATE bills SET status='submitted', submitted_at=now(), submission_ref=$2, updated_at=now() WHERE id=$1`, [id, submission_ref]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('bill',$1,'submit',$2,$3)`, [id, req.user!.id, submission_ref]);
    await audit(db, req.user!.id, 'bill', id, 'submit', undefined, { submission_ref });
    return { status: 'submitted' };
  });

  /** Controlled correction of an approved bill: a new revision; the original stays untouched until the revision is approved. */
  app.post('/bills/:id/revise', { preHandler: perm('bill.prepare') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().min(5, 'Explain why the bill is being revised') }), req.body);
    const bill = await getBill(db, id);
    if (!FINAL_STATUSES.includes(bill.status)) throw conflict('Only approved, generated or submitted bills are revised. Edit drafts directly.');
    const open = await db.one('SELECT id FROM bills WHERE revision_of = $1 AND status NOT IN (\'cancelled\')', [id]);
    if (open) throw conflict('A revision of this bill already exists');
    const row = await db.one<{ id: string }>(
      `INSERT INTO bills(client_id, contract_id, period_start, period_end, bill_no, bill_date, status, revision_no, revision_of, revision_reason, template_version_id, excluded_duties, include_unverified, created_by)
       SELECT client_id, contract_id, period_start, period_end, bill_no, bill_date, 'draft', revision_no + 1, id, $2, template_version_id, excluded_duties, include_unverified, $3 FROM bills WHERE id = $1 RETURNING *`,
      [id, reason, req.user!.id],
    );
    await audit(db, req.user!.id, 'bill', row!.id, 'create_revision', undefined, { of: id }, reason);
    return row;
  });

  app.post('/bills/:id/cancel', { preHandler: perm('bill.prepare') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().min(3) }), req.body);
    const bill = await getBill(db, id);
    assertEditable(bill.status);
    await db.query(`UPDATE bill_duties SET active = false WHERE bill_id = $1`, [id]);
    await db.query(`UPDATE bills SET status='cancelled', updated_at=now() WHERE id=$1`, [id]);
    await audit(db, req.user!.id, 'bill', id, 'cancel', undefined, undefined, reason);
    return { status: 'cancelled' };
  });
}
