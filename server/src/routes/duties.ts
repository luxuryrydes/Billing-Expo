import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit, diff } from '../lib/audit.js';
import { can, perm } from '../lib/auth.js';
import { badRequest, forbidden, isoDate, notFound, parse, uuid } from '../lib/http.js';
import { checkUpload, loadFile, saveFile } from '../lib/storage.js';
import { addDays } from '../engine/time.js';
import {
  assertDutyEditable, computeIssues, contractCtx, DUTY_SELECT, DutyInputSchema, dutyRowToApi, insertDuty, updateDuty, validationSettings,
  type ContractCtx, type DutyInputT,
} from '../services/duties.js';
import { autoMap, IMPORT_FIELDS, parseDate, parseNumber, parseTime, readSheet, type ImportField } from '../services/import.js';
import type { ValidationSettings } from '../engine/validate.js';

const ListQuery = z.object({
  clientId: uuid.optional(),
  contractId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  vehicle: z.string().optional(),
  driver: z.string().optional(),
  status: z.enum(['entered', 'verified', 'billed', 'void']).optional(),
  billing: z.enum(['billed', 'unbilled']).optional(),
  issues: z.enum(['errors', 'warnings', 'clean']).optional(),
  createdToday: z.coerce.boolean().optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(1000).default(100),
});

export async function dutyRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/duties', { preHandler: perm('view') }, async (req) => {
    const q = parse(ListQuery, req.query);
    const where = `WHERE ($1::uuid IS NULL OR d.client_id = $1) AND ($2::uuid IS NULL OR d.contract_id = $2)
      AND ($3::date IS NULL OR d.duty_date >= $3) AND ($4::date IS NULL OR d.duty_date <= $4)
      AND ($5::text IS NULL OR d.vehicle_reg_no ILIKE '%'||$5||'%') AND ($6::text IS NULL OR d.driver_name ILIKE '%'||$6||'%')
      AND ($7::text IS NULL OR d.status = $7) AND ($7::text IS NOT NULL OR d.status <> 'void')
      AND ($8::text IS NULL OR ($8 = 'billed') = EXISTS (SELECT 1 FROM bill_duties bd WHERE bd.duty_id = d.id AND bd.active))
      AND ($9::text IS NULL OR ($9 = 'errors' AND d.error_count > 0) OR ($9 = 'warnings' AND d.warning_count > 0) OR ($9 = 'clean' AND d.error_count = 0 AND d.warning_count = 0))
      AND ($10::boolean IS NOT TRUE OR d.created_at::date = current_date)`;
    const params = [q.clientId ?? null, q.contractId ?? null, q.from ?? null, q.to ?? null, q.vehicle || null, q.driver || null, q.status ?? null, q.billing ?? null, q.issues ?? null, q.createdToday ?? null];
    const total = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM duties d ${where}`, params);
    const rows = await db.query(`${DUTY_SELECT} ${where} ORDER BY d.duty_date, d.start_at NULLS LAST, d.vehicle_reg_no LIMIT $11 OFFSET $12`, [...params, q.pageSize, (q.page - 1) * q.pageSize]);
    return { total: total!.n, page: q.page, pageSize: q.pageSize, rows: rows.map(dutyRowToApi) };
  });

  app.get('/duties/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await db.one(`${DUTY_SELECT} WHERE d.id = $1`, [id]);
    if (!row) throw notFound('Duty');
    const history = await db.query(
      `SELECT a.*, u.name AS user_name FROM audit_events a LEFT JOIN app_users u ON u.id = a.user_id WHERE a.entity_type = 'duty' AND a.entity_id = $1 ORDER BY a.id DESC`,
      [id],
    );
    return { ...dutyRowToApi(row), history };
  });

  /** Saves a batch of grid rows: new rows are inserted, rows with id are updated. All-or-nothing. */
  app.post('/duties/bulk', { preHandler: perm('duty.write') }, async (req) => {
    const body = parse(z.object({ rows: z.array(z.unknown()).min(1).max(1000) }), req.body);
    const parsed: DutyInputT[] = [];
    const rowErrors: { index: number; error: string }[] = [];
    body.rows.forEach((r, i) => {
      const p = DutyInputSchema.safeParse(r);
      if (p.success) parsed.push(p.data);
      else rowErrors.push({ index: i, error: p.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ') });
    });
    if (rowErrors.length) throw badRequest(`${rowErrors.length} row(s) have invalid values`, rowErrors);
    const user = req.user!;
    return db.tx(async (t) => {
      const ctxCache = new Map<string, { k: ContractCtx; s: ValidationSettings }>();
      const saved = [];
      for (const d of parsed) {
        let c = ctxCache.get(d.contractId);
        if (!c) { const k = await contractCtx(t, d.contractId); c = { k, s: await validationSettings(t, k) }; ctxCache.set(d.contractId, c); }
        const issues = await computeIssues(t, d, c.k, c.s);
        if (d.id) {
          const before = await assertDutyEditable(t, d.id);
          if (before.status === 'verified' || before.status === 'billed') {
            if (!can(user, 'duty.correct')) throw forbidden('Verified duties can only be corrected by a reviewer or administrator');
            if (!d.correctionReason) throw badRequest('Give a correction reason when changing a verified duty');
          }
          const row = await updateDuty(t, d, c.k, issues, user.id);
          const ch = diff(before, row!);
          delete ch.before.updated_at; delete ch.after.updated_at;
          if (ch.changed) await audit(t, user.id, 'duty', d.id, before.status === 'entered' ? 'update' : 'correct', ch.before, ch.after, d.correctionReason ?? undefined);
          saved.push(row);
        } else {
          const row = await insertDuty(t, d, c.k, issues, user.id);
          await audit(t, user.id, 'duty', String(row!.id), 'create', undefined, { ...d, issues: issues.length });
          saved.push(row);
        }
      }
      const ids = saved.map((s) => s!.id);
      const rows = await t.query(`${DUTY_SELECT} WHERE d.id = ANY($1::uuid[])`, [ids]);
      const byId = new Map(rows.map((r) => [r.id, r]));
      return { rows: ids.map((id) => dutyRowToApi(byId.get(id)!)) };
    });
  });

  app.post('/duties/:id/void', { preHandler: perm('duty.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const { reason } = parse(z.object({ reason: z.string().min(3, 'Give a reason') }), req.body);
    const before = await assertDutyEditable(db, id);
    const onBill = await db.one('SELECT 1 FROM bill_duties WHERE duty_id = $1 AND active', [id]);
    if (onBill) throw badRequest('This duty is on a bill in preparation. Remove it by recalculating the bill without it, or cancel the bill first.');
    await db.query(`UPDATE duties SET status = 'void', updated_by = $2, updated_at = now() WHERE id = $1`, [id, req.user!.id]);
    await audit(db, req.user!.id, 'duty', id, 'void', { status: before.status }, { status: 'void' }, reason);
    return { ok: true };
  });

  app.post('/duties/verify', { preHandler: perm('duty.verify') }, async (req) => {
    const { ids } = parse(z.object({ ids: z.array(uuid).min(1).max(2000) }), req.body);
    const rows = await db.query<{ id: string; error_count: number }>(
      `SELECT id, error_count FROM duties WHERE id = ANY($1::uuid[]) AND status = 'entered'`, [ids]);
    const blocked = rows.filter((r) => r.error_count > 0).map((r) => r.id);
    const ok = rows.filter((r) => r.error_count === 0).map((r) => r.id);
    if (ok.length) {
      await db.query(`UPDATE duties SET status = 'verified', verified_by = $2, updated_at = now() WHERE id = ANY($1::uuid[])`, [ok, req.user!.id]);
      for (const id of ok) await audit(db, req.user!.id, 'duty', id, 'verify');
    }
    return { verified: ok.length, blockedByErrors: blocked.length };
  });

  app.post('/duties/revalidate', { preHandler: perm('duty.write') }, async (req) => {
    const { contractId, from, to } = parse(z.object({ contractId: uuid, from: isoDate, to: isoDate }), req.body);
    const k = await contractCtx(db, contractId);
    const s = await validationSettings(db, k);
    const rows = await db.query(`${DUTY_SELECT} WHERE d.contract_id = $1 AND d.duty_date BETWEEN $2 AND $3 AND d.status <> 'void'`, [contractId, from, to]);
    let changed = 0;
    for (const r of rows) {
      const api = dutyRowToApi(r);
      const d = DutyInputSchema.parse({ ...api, contractId });
      const issues = await computeIssues(db, d, k, s);
      if (JSON.stringify(issues) !== JSON.stringify(r.issues)) {
        const errs = issues.filter((i) => i.severity === 'error').length;
        await db.query('UPDATE duties SET issues = $2::jsonb, error_count = $3, warning_count = $4 WHERE id = $1', [r.id, JSON.stringify(issues), errs, issues.length - errs]);
        changed++;
      }
    }
    return { checked: rows.length, changed };
  });

  // Import -------------------------------------------------------------------
  app.post('/duties/import/preview', { preHandler: perm('duty.write') }, async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Attach an .xlsx or .csv duty sheet');
    const buf = await file.toBuffer();
    const ext = checkUpload(file.filename, buf, ['.xlsx', '.csv']);
    const sheet = await readSheet(buf, ext).catch((e) => { throw badRequest(`Could not read the sheet: ${(e as Error).message}`); });
    const stored = await saveFile(db, file.filename, buf, req.user!.id);
    return {
      fileId: stored.id,
      fileName: path.basename(file.filename),
      sheetName: sheet.sheetName,
      headerRow: sheet.headerRow,
      headers: sheet.headers,
      mapping: autoMap(sheet.headers),
      fields: Object.keys(IMPORT_FIELDS),
      rowCount: sheet.rows.length,
      sample: sheet.rows.slice(0, 20).map((r) => ({ rowNumber: r.rowNumber, cells: r.cells.map((c) => c.text) })),
    };
  });

  app.post('/duties/import/commit', { preHandler: perm('duty.write') }, async (req) => {
    const b = parse(
      z.object({
        fileId: uuid,
        contractId: uuid,
        mapping: z.record(z.string(), z.number().int().min(0)),
        overnightRule: z.enum(['next_day', 'flag']).default('next_day'),
        defaultDutyType: z.string().nullable().optional(),
        dryRun: z.boolean().default(false),
      }),
      req.body,
    );
    const f = await db.one<{ storage_path: string; original_name: string }>('SELECT * FROM files WHERE id = $1', [b.fileId]);
    if (!f) throw notFound('Uploaded file');
    const loaded = (await loadFile(db, b.fileId))!;
    const sheet = await readSheet(loaded.buf, path.extname(f.original_name).toLowerCase());
    const k = await contractCtx(db, b.contractId);
    const s = await validationSettings(db, k);
    const cats = await db.query<{ id: string; name: string }>('SELECT id, name FROM vehicle_categories');
    const catByName = new Map(cats.map((c) => [c.name.toLowerCase().replace(/\s+/g, ''), c.id]));
    const m = b.mapping as Partial<Record<ImportField, number>>;
    const cell = (cells: (typeof sheet.rows)[number]['cells'], fld: ImportField) => (m[fld] === undefined ? undefined : cells[m[fld]!]);

    const prepared = sheet.rows.map((r) => {
      const extra: { code: string; severity: 'error' | 'warning'; message: string; field?: string }[] = [];
      const date = parseDate(cell(r.cells, 'dutyDate'));
      if (!date) extra.push({ code: 'INVALID_DATE', severity: 'error', field: 'dutyDate', message: `Duty date "${cell(r.cells, 'dutyDate')?.text ?? ''}" could not be read` });
      const endDate = parseDate(cell(r.cells, 'endDate')) ?? date;
      const st = parseTime(cell(r.cells, 'startTime'));
      const et = parseTime(cell(r.cells, 'endTime'));
      let endAt = endDate && et ? `${endDate} ${et}` : null;
      if (date && st && et && endDate === date && m.endDate === undefined && et < st) {
        if (b.overnightRule === 'next_day') {
          endAt = `${addDays(date, 1)} ${et}`;
          extra.push({ code: 'ASSUMED_NEXT_DAY', severity: 'warning', field: 'endAt', message: `Closing time ${et} is earlier than starting time ${st}; treated as next-day closing (${addDays(date, 1)}). Confirm against the duty slip.` });
        }
      }
      const catText = cell(r.cells, 'vehicleCategory')?.text ?? '';
      const catId = catText ? catByName.get(catText.toLowerCase().replace(/\s+/g, '')) ?? null : null;
      if (catText && !catId) extra.push({ code: 'UNKNOWN_CATEGORY', severity: 'error', field: 'vehicleCategoryId', message: `Vehicle type "${catText}" does not match a configured vehicle category` });
      const input = {
        contractId: b.contractId,
        dutyDate: date ?? '1900-01-01',
        vendorName: cell(r.cells, 'vendorName')?.text || null,
        vehicleCategoryId: catId,
        vehicleRegNo: (cell(r.cells, 'vehicleRegNo')?.text || '').trim() || '(missing)',
        driverName: cell(r.cells, 'driverName')?.text || null,
        fieldOfficer: cell(r.cells, 'fieldOfficer')?.text || null,
        dutyTypeCode: (cell(r.cells, 'dutyType')?.text || b.defaultDutyType || null)?.toUpperCase() ?? null,
        startKm: parseNumber(cell(r.cells, 'startKm')),
        endKm: parseNumber(cell(r.cells, 'endKm')),
        startAt: date && st ? `${date} ${st}` : null,
        endAt,
        toll: parseNumber(cell(r.cells, 'toll')),
        parking: parseNumber(cell(r.cells, 'parking')),
        remarks: cell(r.cells, 'remarks')?.text || null,
        supportingDocRef: `${f.original_name} row ${r.rowNumber}`,
        customFields: {},
      };
      return { rowNumber: r.rowNumber, input, extra };
    });

    const results: { rowNumber: number; issues: unknown[]; parseError?: string; input: unknown }[] = [];
    const doWork = async (t: typeof db) => {
      let batchId: string | null = null;
      if (!b.dryRun) {
        const batch = await t.one<{ id: string }>('INSERT INTO duty_import_batches(file_id, client_id, contract_id, row_count, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id', [b.fileId, k.client_id, k.id, prepared.length, req.user!.id]);
        batchId = batch!.id;
      }
      for (const p of prepared) {
        const parsedRow = DutyInputSchema.safeParse(p.input);
        if (!parsedRow.success) {
          results.push({ rowNumber: p.rowNumber, issues: p.extra, parseError: parsedRow.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; '), input: p.input });
          continue;
        }
        const issues = [...p.extra, ...(await computeIssues(t, parsedRow.data, k, s))];
        results.push({ rowNumber: p.rowNumber, issues, input: parsedRow.data });
        if (!b.dryRun) {
          const row = await insertDuty(t, parsedRow.data, k, issues, req.user!.id, 'import', batchId);
          await audit(t, req.user!.id, 'duty', String(row!.id), 'import', undefined, { file: f.original_name, row: p.rowNumber });
        }
      }
      return batchId;
    };
    const batchId = b.dryRun ? await doWork(db) : await db.tx(doWork);
    const failed = results.filter((r) => r.parseError);
    return {
      batchId,
      dryRun: b.dryRun,
      total: results.length,
      imported: b.dryRun ? 0 : results.length - failed.length,
      notImported: failed.length,
      withErrors: results.filter((r) => (r.issues as { severity: string }[]).some((i) => i.severity === 'error')).length,
      withWarnings: results.filter((r) => (r.issues as { severity: string }[]).some((i) => i.severity === 'warning')).length,
      results: results.slice(0, 500),
    };
  });

  // Daily report: counts per client/vehicle for a date
  app.get('/duties/daily-report', { preHandler: perm('view') }, async (req) => {
    const { date, clientId } = parse(z.object({ date: isoDate, clientId: uuid.optional() }), req.query);
    const rows = await db.query(`${DUTY_SELECT} WHERE d.duty_date = $1 AND d.status <> 'void' AND ($2::uuid IS NULL OR d.client_id = $2) ORDER BY c.name, d.vehicle_reg_no, d.start_at`, [date, clientId ?? null]);
    return rows.map(dutyRowToApi);
  });
}
