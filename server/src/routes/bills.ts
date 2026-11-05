import type { FastifyInstance } from 'fastify';
import type { Db } from '../db/index.js';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, forbidden, isoDate, notFound, optText, parse, uuid } from '../lib/http.js';
import { addDays } from '../engine/time.js';
import { calculate, EDITABLE_STATUSES, eligibleDuties, FINAL_STATUSES, generateOutputs, getBill, isStale, nextBillNo } from '../services/billing.js';
import { getSetting } from './master.js';
import { invoicePreview, periodDuties } from '../services/invoiceBuilder.js';

export async function billRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/bills', { preHandler: perm('view') }, async (req) => {
    const q = parse(z.object({ clientId: uuid.optional(), contractId: uuid.optional(), status: z.string().optional(), from: isoDate.optional(), to: isoDate.optional() }), req.query);
    return db.query(
      `SELECT b.*, c.name AS client_name, c.short_code, k.reference_no AS contract_ref, k.title AS contract_title,
              (SELECT count(*)::int FROM bill_duties bd WHERE bd.bill_id = b.id) AS duty_count,
              (SELECT count(*)::int FROM billing_exceptions e WHERE e.bill_id = b.id AND e.status = 'open') AS open_exceptions,
              (SELECT g.file_id FROM generated_files g WHERE g.bill_id = b.id AND g.kind = 'bill_pdf' ORDER BY g.created_at DESC LIMIT 1) AS pdf_file_id,
              (SELECT g.file_id FROM generated_files g WHERE g.bill_id = b.id AND g.kind = 'bill_xlsx' ORDER BY g.created_at DESC LIMIT 1) AS xlsx_file_id,
              b.period_type,
              u.name AS created_by_name
       FROM bills b JOIN clients c ON c.id = b.client_id JOIN contracts k ON k.id = b.contract_id LEFT JOIN app_users u ON u.id = b.created_by
       WHERE ($1::uuid IS NULL OR b.client_id = $1) AND ($2::uuid IS NULL OR b.contract_id = $2) AND ($3::text IS NULL OR b.status = $3)
         AND ($4::date IS NULL OR b.period_start >= $4) AND ($5::date IS NULL OR b.period_start <= $5)
       ORDER BY b.period_start DESC, c.name, b.revision_no DESC`,
      [q.clientId ?? null, q.contractId ?? null, q.status || null, q.from ?? null, q.to ?? null],
    );
  });

  const NewBill = z.object({
    contract_id: uuid, period_start: isoDate, period_end: isoDate, bill_date: isoDate.optional(), template_version_id: uuid.nullable().optional(),
    include_unverified: z.boolean().default(true), notes: optText, period_type: z.enum(['month', 'date', 'range']).optional(),
  });
  const createBill = async (b: z.infer<typeof NewBill>, userId: string, opts: { db?: Db; allowOverlap?: boolean } = {}) => {
    const q = opts.db ?? db;
    if (b.period_end < b.period_start) throw badRequest('Period end is before period start');
    const k = await q.one<{ client_id: string; status: string }>('SELECT client_id, status FROM contracts WHERE id = $1', [b.contract_id]);
    if (!k) throw notFound('Contract');
    const dup = await q.one<{ id: string; status: string; period_start: string; period_end: string }>(
      `SELECT id, status, period_start, period_end FROM bills WHERE contract_id = $1 AND status NOT IN ('cancelled','superseded') AND period_start <= $3 AND period_end >= $2 LIMIT 1`, [b.contract_id, b.period_start, b.period_end]);
    if (dup && !opts.allowOverlap) throw conflict(`A ${dup.status} bill (${dup.period_start} – ${dup.period_end}) already covers part of this period. Open it, or cancel it first.`);
    const isMonth = b.period_start.endsWith('-01') && b.period_start.slice(0, 7) === b.period_end.slice(0, 7) && addDays(b.period_end, 1).endsWith('-01');
    const periodType = b.period_type ?? (b.period_start === b.period_end ? 'date' : isMonth ? 'month' : 'range');
    // Default template: latest approved version for the contract, else for the client.
    const tv = b.template_version_id ?? (await q.one<{ id: string }>(
      `SELECT v.id FROM billing_template_versions v JOIN billing_templates t ON t.id = v.template_id
       WHERE v.status = 'approved' AND (t.contract_id = $1 OR (t.contract_id IS NULL AND t.client_id = $2)) ORDER BY (t.contract_id IS NOT NULL) DESC, v.approved_at DESC LIMIT 1`,
      [b.contract_id, k.client_id]))?.id ?? null;
    const row = await q.one<{ id: string }>(
      `INSERT INTO bills(client_id, contract_id, period_start, period_end, period_type, bill_date, template_version_id, include_unverified, notes, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [k.client_id, b.contract_id, b.period_start, b.period_end, periodType, b.bill_date ?? addDays(b.period_end, 1), tv, b.include_unverified, b.notes, userId],
    );
    await audit(q, userId, 'bill', row!.id, 'create', undefined, { ...b, period_type: periodType });
    return row!;
  };

  app.post('/bills', { preHandler: perm('bill.prepare') }, async (req) => createBill(parse(NewBill, req.body), req.user!.id));

  /** Date-wise billing: one draft bill per duty date of the month that has unbilled duties. */
  app.post('/bills/date-wise', { preHandler: perm('bill.prepare') }, async (req) => {
    const b = parse(z.object({ contract_id: uuid, month: z.string().regex(/^\d{4}-\d{2}$/), bill_date: isoDate.optional(), include_unverified: z.boolean().default(true) }), req.body);
    const from = `${b.month}-01`;
    const to = addDays(`${addDays(from, 32).slice(0, 7)}-01`, -1);
    const dates = await db.query<{ duty_date: string; n: number }>(
      `SELECT d.duty_date, count(*)::int AS n FROM duties d WHERE d.contract_id = $1 AND d.duty_date BETWEEN $2 AND $3 AND d.status <> 'void'
         AND NOT EXISTS (SELECT 1 FROM bill_duties bd WHERE bd.duty_id = d.id AND bd.active)
       GROUP BY d.duty_date ORDER BY d.duty_date`, [b.contract_id, from, to]);
    const created: { id: string; date: string; duties: number }[] = [];
    const skipped: { date: string; reason: string }[] = [];
    for (const d of dates) {
      try {
        const bill = await createBill({ contract_id: b.contract_id, period_start: d.duty_date, period_end: d.duty_date, bill_date: b.bill_date, include_unverified: b.include_unverified, notes: null, period_type: 'date' }, req.user!.id);
        created.push({ id: bill.id, date: d.duty_date, duties: d.n });
      } catch (e) {
        skipped.push({ date: d.duty_date, reason: (e as Error).message });
      }
    }
    return { created, skipped };
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

  /** Record that the money for a bill has arrived (or undo it if it was marked by mistake). The bill's amounts and status are not touched. */
  app.post('/bills/:id/mark-paid', { preHandler: perm('bill.submit') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ paid_on: isoDate.optional(), reference: z.string().trim().max(200).nullable().optional() }), req.body ?? {});
    const bill = await getBill(db, id);
    if (!['approved', 'generated', 'submitted'].includes(bill.status)) throw conflict('Only an approved bill can be marked paid.');
    const on = b.paid_on ?? new Date().toISOString().slice(0, 10);
    await db.query('UPDATE bills SET paid_at = $2, paid_by = $3, payment_ref = $4, updated_at = now() WHERE id = $1', [id, on, req.user!.id, b.reference ?? null]);
    await audit(db, req.user!.id, 'bill', id, 'mark_paid', undefined, { paid_on: on, reference: b.reference ?? null });
    return { paid_at: on };
  });
  app.post('/bills/:id/mark-unpaid', { preHandler: perm('bill.submit') }, async (req) => {
    const { id } = req.params as { id: string };
    await getBill(db, id);
    await db.query('UPDATE bills SET paid_at = NULL, paid_by = NULL, payment_ref = NULL, updated_at = now() WHERE id = $1', [id]);
    await audit(db, req.user!.id, 'bill', id, 'mark_unpaid');
    return { paid_at: null };
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
  // --- Department-wise invoices ------------------------------------------------------------------------------------
  const BuilderBase = z.object({ contractId: uuid, periodStart: isoDate, periodEnd: isoDate });
  /** Tax on amounts entered by hand: the contract's approved rules (default), none, or a rate typed on the invoice. */
  const ManualTaxSchema = z.object({ mode: z.enum(['contract', 'non_taxable', 'custom']), rate: z.string().regex(/^\d+(\.\d+)?$/).refine((v) => Number(v) <= 100, 'The GST rate must be between 0 and 100').optional(), included: z.boolean().optional() })
    .refine((v) => v.mode !== 'custom' || !!v.rate, 'Enter the GST rate for a custom tax');

  /** Saved duties of a contract and period, with how each stands for billing and what it would come to. */
  app.get('/invoice-builder/duties', { preHandler: perm('view') }, async (req) => {
    const q = parse(BuilderBase.extend({ schemeId: uuid.optional(), manualTax: z.string().optional() }), req.query);
    const rows = await periodDuties(db, q.contractId, q.periodStart, q.periodEnd);
    const open = rows.filter((r) => r.bill_state === 'unbilled' || r.bill_state === 'cancelled');
    const { perDuty, summary } = await invoicePreview(db, q.contractId, q.periodStart, q.periodEnd, open, q.manualTax ? parse(ManualTaxSchema, JSON.parse(q.manualTax)) : null);
    return {
      duties: rows.map((r) => {
        const p = perDuty.get(r.id);
        const applied = p?.schemeId ?? null;
        return {
          id: r.id, dutyDate: r.duty_date, vehicleRegNo: r.vehicle_reg_no, vehicleCategory: r.vehicle_category_name ?? null, dutyType: r.duty_type_code ?? null,
          startKm: r.start_km, endKm: r.end_km, fieldOfficer: r.field_officer ?? null, state: r.bill_state, billNo: r.bill_no, billId: r.bill_id,
          chosenRateCard: r.chosen_rate_card ?? null, manualAmount: r.manual_amount ?? null, manualNote: r.manual_note ?? null, tax: p?.tax ?? null, rateCard: p?.schemeName ?? null, rateSchemeId: applied, amount: p?.amount ?? null, message: p?.message ?? null,
          // A rate card is optional: a duty can be billed with an automatic rate, a chosen card, or an amount entered by hand.
          eligible: (r.bill_state === 'unbilled' || r.bill_state === 'cancelled') && !!p?.ok && (!q.schemeId || applied === q.schemeId || !!p?.manual),
        };
      }),
      summary,
    };
  });

  /** Enter, correct or clear an amount by hand for a saved duty that is not on a bill yet. No rate card is needed. */
  app.put('/invoice-builder/duties/:id/manual-amount', { preHandler: perm('duty.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ amount: z.string().trim().regex(/^\d+(\.\d{1,2})?$/, 'Enter the amount as a number, for example 1800 or 1800.50').nullable(), note: z.string().trim().max(300).nullable().optional() }), req.body);
    const d = await db.one<{ id: string; manual_amount: string | null }>('SELECT id, manual_amount FROM duties WHERE id = $1 AND status <> \'void\'', [id]);
    if (!d) throw notFound('Duty');
    const onBill = await db.one(`SELECT b.bill_no FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = $1 AND bd.active AND b.status NOT IN ('cancelled','superseded')`, [id]);
    if (onBill) throw conflict('This duty is already on a bill. Cancel or revise the bill to change its amount.');
    await db.query('UPDATE duties SET manual_amount = $2, manual_note = $3, updated_at = now() WHERE id = $1', [id, b.amount, b.note ?? null]);
    await audit(db, req.user!.id, 'duty', id, 'set_manual_amount', { amount: d.manual_amount }, { amount: b.amount }, b.note ?? undefined);
    return { ok: true, amount: b.amount };
  });

  /** What the chosen duties would come to, before an invoice is made. */
  app.post('/invoice-builder/summary', { preHandler: perm('view') }, async (req) => {
    const b = parse(BuilderBase.extend({ dutyIds: z.array(uuid).max(2000), manualTax: ManualTaxSchema.nullable().optional() }), req.body);
    const rows = (await periodDuties(db, b.contractId, b.periodStart, b.periodEnd)).filter((r) => b.dutyIds.includes(r.id) && (r.bill_state === 'unbilled' || r.bill_state === 'cancelled'));
    return (await invoicePreview(db, b.contractId, b.periodStart, b.periodEnd, rows, b.manualTax ?? null)).summary;
  });

  /**
   * Makes one invoice (a draft bill) from the chosen saved duties of one contract. The duties are claimed for the bill inside one
   * transaction under a lock, and the database allows a duty on only one active bill, so a repeated click or a second user cannot bill the
   * same duty twice. The invoice then goes through the normal review, approval and export steps.
   */
  app.post('/invoice-builder/generate', { preHandler: perm('bill.prepare') }, async (req) => {
    const b = parse(BuilderBase.extend({ dutyIds: z.array(uuid).min(1, 'Select at least one duty').max(2000), billDate: isoDate.optional(), templateVersionId: uuid.nullable().optional(), manualTax: ManualTaxSchema.nullable().optional() }), req.body);
    if (b.periodEnd < b.periodStart) throw badRequest('Period end is before period start');
    const userId = req.user!.id;
    const bill = await db.tx(async (t) => {
      await t.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`invoice:${b.contractId}`]);
      const all = await periodDuties(t, b.contractId, b.periodStart, b.periodEnd);
      const byId = new Map(all.map((r) => [r.id, r]));
      const missing = b.dutyIds.filter((id) => !byId.has(id));
      if (missing.length) throw badRequest(`${missing.length} selected duty(ies) are not in this contract and period, or were voided.`);
      const taken = b.dutyIds.map((id) => byId.get(id)!).filter((r) => r.bill_state === 'billed' || r.bill_state === 'draft');
      if (taken.length) throw conflict(`${taken.length} selected duty(ies) are already on a bill (${[...new Set(taken.map((r) => r.bill_no ?? 'a draft bill'))].join(', ')}). Deselect them.`);
      const chosen = new Set(b.dutyIds);
      const excluded = all.filter((r) => !chosen.has(r.id)).map((r) => ({ dutyId: r.id, reason: 'Not selected for this invoice', by: userId, at: new Date().toISOString() }));
      const created = await createBill({ contract_id: b.contractId, period_start: b.periodStart, period_end: b.periodEnd, bill_date: b.billDate, template_version_id: b.templateVersionId ?? null, include_unverified: true, notes: 'Department-wise invoice from selected duties', period_type: 'range' }, userId, { db: t, allowOverlap: true });
      await t.query('UPDATE bills SET excluded_duties = $2::jsonb, manual_tax = $3::jsonb WHERE id = $1', [created.id, JSON.stringify(excluded), b.manualTax ? JSON.stringify(b.manualTax) : null]);
      for (const id of b.dutyIds) await t.query('INSERT INTO bill_duties(bill_id, duty_id, active) VALUES ($1,$2,true)', [created.id, id]);
      await audit(t, userId, 'bill', created.id, 'invoice_from_duties', undefined, { duties: b.dutyIds.length, excluded: excluded.length });
      return created;
    });
    const calc = await calculate(db, bill.id, userId);
    return { billId: bill.id, duties: b.dutyIds.length, totals: calc.totals, exceptions: calc.exceptions };
  });

}
