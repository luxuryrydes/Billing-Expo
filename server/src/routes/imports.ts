import path from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm, requirePerm } from '../lib/auth.js';
import { badRequest, conflict, notFound, parse, uuid } from '../lib/http.js';
import { checkUpload, filePath, loadFile, saveFile } from '../lib/storage.js';
import { analyseRows, FIELDS, KEY_FIELD, normaliseRecord, synonymsFor, upsertRecord, type Entity, type RowResult } from '../services/masterImport.js';
import { analyseRates, applyRates, RATE_FIELDS, RATE_SYNONYMS, rowsFromRateTables, rowsFromSheet, todayIso, type RateOptions, type RateRowResult } from '../services/rateCard.js';
import { detectTable, readWorkbook, toCsv } from '../services/sheets.js';
import { runWorker } from '../services/extraction.js';
import { rateTables } from '../services/profile.js';
import type { Db } from '../db/index.js';

const MASTER = ['departments', 'institutions'] as const;
const Entities = z.enum(['departments', 'institutions', 'rate_card']);
type AnyEntity = z.infer<typeof Entities>;
const permFor = (e: AnyEntity) => (e === 'rate_card' ? 'rate.write' : 'client.write') as 'rate.write' | 'client.write';

const AnalyzeBody = z.object({
  fileId: uuid,
  sheet: z.string().optional(),
  mapping: z.record(z.string(), z.number().int().min(0)).optional(),
  /** Columns without a dedicated field that should be kept (stored as extra fields). */
  extras: z.array(z.number().int().min(0)).optional(),
  contractId: uuid.optional(),
  options: z.object({
    effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hourRoundingMode: z.enum(['exact', 'ceil', 'floor', 'nearest']).default('ceil'),
    hourRoundingUnit: z.string().default('30'),
    nightStart: z.string().default('22:00'),
    nightEnd: z.string().default('06:00'),
  }).optional(),
  /** Commit only: write the valid rows and report the invalid ones. Otherwise any invalid row stops the import. */
  skipInvalid: z.boolean().default(false),
  /** Rate cards: put the new versions straight into the approval queue. */
  submitForApproval: z.boolean().default(false),
});
type AnalyzeInput = z.infer<typeof AnalyzeBody>;

interface Loaded { fileName: string; ext: string; sheets: string[]; sheet: string; headerRow: number; headers: string[]; rows: { rowNumber: number; cells: string[] }[]; mapping: Record<string, number>; pdfRates?: ReturnType<typeof rowsFromRateTables> }

async function loadSheet(db: Db, entity: AnyEntity, fileId: string, sheet?: string): Promise<Loaded> {
  const f = await loadFile(db, fileId);
  if (!f) throw notFound('Uploaded file');
  const ext = path.extname(f.meta.original_name).toLowerCase();
  if (ext === '.pdf') {
    if (entity !== 'rate_card') throw badRequest('PDF files can be imported as rate cards only. Use Excel or CSV for departments and institutions.');
    const res = await runWorker(filePath(f.meta));
    const tables = rateTables(res.pages, f.meta.original_name);
    if (!tables.length) throw badRequest('No rate table was recognised in this PDF. Use an Excel copy and map the columns.');
    return { fileName: f.meta.original_name, ext, sheets: ['PDF rate table'], sheet: 'PDF rate table', headerRow: 0, headers: [], rows: [], mapping: {}, pdfRates: rowsFromRateTables(tables) };
  }
  const wb = await readWorkbook(f.buf, ext, filePath(f.meta));
  const syn = entity === 'rate_card' ? RATE_SYNONYMS : synonymsFor(entity);
  const t = detectTable(wb, syn, sheet);
  return { fileName: f.meta.original_name, ext, sheets: t.sheets, sheet: t.sheet, headerRow: t.headerRow, headers: t.headers, rows: t.rows, mapping: t.mapping };
}

const mappedFields = (entity: AnyEntity) => (entity === 'rate_card' ? RATE_FIELDS.map(({ key, label }) => ({ key, label })) : FIELDS[entity].map(({ key, label, required }) => ({ key, label, required: !!required })));

function masterRows(l: Loaded, entity: Entity, mapping: Record<string, number>, extras: number[]) {
  return l.rows.map((r) => {
    const raw: Record<string, unknown> = {};
    for (const [k, i] of Object.entries(mapping)) raw[k] = r.cells[i] ?? '';
    const extra: Record<string, string> = {};
    for (const i of extras) { const v = (r.cells[i] ?? '').trim(); if (v && l.headers[i]) extra[l.headers[i]] = v; }
    return { rowNumber: r.rowNumber, raw, extra };
  }).filter((r) => Object.values(r.raw).some((v) => String(v ?? '').trim() !== '') || Object.keys(r.extra).length);
}

const rateOptions = (b: AnalyzeInput): RateOptions => ({
  effectiveFrom: b.options?.effectiveFrom ?? todayIso(),
  hourRoundingMode: b.options?.hourRoundingMode ?? 'ceil',
  hourRoundingUnit: b.options?.hourRoundingUnit ?? '30',
  nightStart: b.options?.nightStart ?? '22:00',
  nightEnd: b.options?.nightEnd ?? '06:00',
});

async function analyse(db: Db, entity: AnyEntity, b: AnalyzeInput) {
  const l = await loadSheet(db, entity, b.fileId, b.sheet);
  const mapping = b.mapping ?? l.mapping;
  const used = new Set(Object.values(mapping));
  const defaultExtras = l.headers.map((h, i) => i).filter((i) => !used.has(i) && l.headers[i] && l.rows.some((r) => (r.cells[i] ?? '').trim()));
  const extras = b.extras ?? (entity === 'rate_card' ? [] : defaultExtras);
  let results: (RowResult | RateRowResult)[];
  if (entity === 'rate_card') {
    if (!b.contractId) throw badRequest('Choose the contract the rate card belongs to');
    const incoming = l.pdfRates ?? rowsFromSheet(l.rows, mapping);
    results = await analyseRates(db, b.contractId, incoming, rateOptions(b));
  } else {
    const missing = FIELDS[entity].filter((f) => f.required && mapping[f.key] === undefined);
    if (missing.length) throw badRequest(`Map a column to: ${missing.map((f) => f.label).join(', ')}`);
    results = await analyseRows(db, entity, masterRows(l, entity, mapping, extras));
  }
  const count = (a: string) => results.filter((r) => r.action === a).length;
  return {
    fileName: l.fileName, sheet: l.sheet, sheets: l.sheets, headerRow: l.headerRow, headers: l.headers, mapping, extras, unmapped: defaultExtras,
    fields: mappedFields(entity),
    summary: { rows: results.length, add: count('add'), update: count('update'), unchanged: count('unchanged'), errors: count('error'), warnings: results.filter((r) => r.warnings.length).length },
    sample: l.rows.slice(0, 15).map((r) => ({ rowNumber: r.rowNumber, cells: r.cells })),
    results,
  };
}

export async function importRoutes(app: FastifyInstance) {
  const db = app.db;
  const entityOf = (req: FastifyRequest) => {
    const e = parse(Entities, (req.params as { entity: string }).entity);
    requirePerm(req, permFor(e));
    return e;
  };

  app.get('/imports/:entity/fields', { preHandler: perm('view') }, async (req) => mappedFields(parse(Entities, (req.params as { entity: string }).entity)));

  /** Blank workbook with the expected column headings. */
  app.get('/imports/:entity/template.xlsx', { preHandler: perm('view') }, async (req, reply) => {
    const e = parse(Entities, (req.params as { entity: string }).entity);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(e === 'rate_card' ? 'rates' : e);
    ws.addRow(mappedFields(e).map((f) => f.label)).font = { bold: true };
    ws.columns.forEach((c) => (c.width = 22));
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${e}-template.xlsx"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  /** Current departments / institutions in the import format, to edit and re-import. */
  app.get('/imports/:entity/export.xlsx', { preHandler: perm('export') }, async (req, reply) => {
    const e = parse(z.enum(MASTER), (req.params as { entity: string }).entity);
    const rows = await db.query<Record<string, unknown>>(`SELECT * FROM clients WHERE kind = $1 ORDER BY ${e === 'departments' ? 'name' : 'code'}`, [e === 'departments' ? 'department' : 'institution']);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(e);
    const extraKeys = [...new Set(rows.flatMap((r) => Object.keys((r.extra as object) ?? {})))];
    ws.addRow([...FIELDS[e].map((f) => f.label), ...extraKeys]).font = { bold: true };
    for (const r of rows) {
      const row = ws.addRow([...FIELDS[e].map((f) => {
        const v = r[f.key];
        return Array.isArray(v) ? v.join(', ') : v == null ? '' : /^\d+\.\d+$/.test(String(v)) ? String(Number(v)) : String(v);
      }), ...extraKeys.map((k) => String((r.extra as Record<string, unknown>)?.[k] ?? ''))]);
      row.eachCell((c) => (c.numFmt = '@'));
    }
    ws.columns.forEach((c) => (c.width = 22));
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="${e}-${todayIso()}.xlsx"`);
    return reply.send(Buffer.from(await wb.xlsx.writeBuffer()));
  });

  /** Step 1: store the file and return a preview with the detected sheet, headings, mapping and row analysis. */
  app.post('/imports/:entity/upload', async (req) => {
    const entity = entityOf(req);
    const file = await req.file();
    if (!file) throw badRequest('Choose an Excel or CSV file');
    const buf = await file.toBuffer();
    checkUpload(file.filename, buf, entity === 'rate_card' ? ['.xlsx', '.xls', '.csv', '.pdf'] : ['.xlsx', '.xls', '.csv']);
    const stored = await saveFile(db, file.filename, buf, req.user!.id);
    const contractId = (file.fields.contract_id as { value?: string } | undefined)?.value || undefined;
    try {
      return { fileId: stored.id, ...(await analyse(db, entity, { fileId: stored.id, contractId, skipInvalid: false, submitForApproval: false })) };
    } catch (e) {
      // Keep the file so the user can fix the mapping (e.g. a required column was not recognised).
      const l = await loadSheet(db, entity, stored.id).catch(() => null);
      if (l && (e as { status?: number }).status === 400) {
        return { fileId: stored.id, fileName: l.fileName, sheet: l.sheet, sheets: l.sheets, headerRow: l.headerRow, headers: l.headers, mapping: l.mapping, extras: [], unmapped: [], fields: mappedFields(entity),
          summary: null, sample: l.rows.slice(0, 15), results: [], problem: (e as Error).message };
      }
      throw e;
    }
  });

  /** Step 2 (repeatable): re-analyse with a different sheet, mapping or options. */
  app.post('/imports/:entity/analyze', async (req) => analyse(db, entityOf(req), parse(AnalyzeBody, req.body)));

  /** Step 3: commit in one transaction. Nothing is written if any row fails, unless skipInvalid was chosen. */
  app.post('/imports/:entity/commit', async (req) => {
    const entity = entityOf(req);
    const b = parse(AnalyzeBody, req.body);
    const user = req.user!;
    return db.tx(async (t) => {
      const a = await analyse(t, entity, b);
      if (a.summary.errors && !b.skipInvalid) throw conflict(`${a.summary.errors} row(s) have errors. Correct them, or choose to import only the valid rows.`);
      let created: unknown = null;
      let added = 0;
      let updated = 0;
      if (entity === 'rate_card') {
        const c = await applyRates(t, b.contractId!, a.results as RateRowResult[], rateOptions(b), user.id, b.submitForApproval);
        created = c;
        added = (a.results as RateRowResult[]).filter((r) => r.action === 'add').length;
        updated = (a.results as RateRowResult[]).filter((r) => r.action === 'update').length;
      } else {
        for (const r of a.results as RowResult[]) {
          if (r.action !== 'add' && r.action !== 'update') continue;
          const res = await upsertRecord(t, entity, r.values, user.id, r.existingId, 'import');
          if (res.action === 'add') added++; else updated++;
        }
      }
      const run = await t.one<{ id: string }>(
        `INSERT INTO import_runs(entity, context, file_id, sheet, mapping, added, updated, unchanged, skipped, errors, results, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [entity, { contractId: b.contractId ?? null }, b.fileId, a.sheet, a.mapping, added, updated, a.summary.unchanged, a.summary.errors, a.summary.errors,
          JSON.stringify(a.results.map((r) => ({ rowNumber: r.rowNumber, action: r.action, errors: r.errors, warnings: r.warnings, key: (r as RowResult).key ?? `${(r as RateRowResult).category} / ${(r as RateRowResult).dutyTypeName}` }))), user.id],
      );
      await audit(t, user.id, 'import', run!.id, `import_${entity}`, undefined, { file: a.fileName, added, updated, unchanged: a.summary.unchanged, skipped: a.summary.errors });
      return { runId: run!.id, added, updated, unchanged: a.summary.unchanged, skipped: a.summary.errors, created };
    });
  });

  app.get('/imports/runs', { preHandler: perm('view') }, async (req) => {
    const q = req.query as { entity?: string; contractId?: string };
    return db.query(
      `SELECT r.id, r.entity, r.context, r.sheet, r.added, r.updated, r.unchanged, r.skipped, r.errors, r.created_at, f.original_name, u.name AS user_name
       FROM import_runs r LEFT JOIN files f ON f.id = r.file_id LEFT JOIN app_users u ON u.id = r.created_by
       WHERE ($1::text IS NULL OR r.entity = $1) AND ($2::text IS NULL OR r.context->>'contractId' = $2) ORDER BY r.created_at DESC LIMIT 50`,
      [q.entity || null, q.contractId || null],
    );
  });

  /** Error report of a completed import, as CSV. */
  app.get('/imports/runs/:id/report.csv', { preHandler: perm('view') }, async (req, reply) => {
    const r = await db.one<{ results: { rowNumber: number; key: string; action: string; errors: string[]; warnings: string[] }[] }>('SELECT results FROM import_runs WHERE id = $1', [(req.params as { id: string }).id]);
    if (!r) throw notFound('Import');
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="import-report.csv"');
    return reply.send('﻿' + toCsv([['Row', 'Record', 'Result', 'Errors', 'Warnings'], ...r.results.map((x) => [x.rowNumber, x.key, x.action, x.errors.join('; '), x.warnings.join('; ')])]));
  });

  // --- Manual entry: same validation as import -------------------------------------
  const kindOf = (e: Entity) => (e === 'departments' ? 'department' : 'institution');

  app.get('/master/:entity', { preHandler: perm('view') }, async (req) => {
    const e = parse(z.enum(MASTER), (req.params as { entity: string }).entity);
    const q = (req.query as { q?: string }).q || null;
    return db.query(
      `SELECT c.*, (SELECT count(*)::int FROM contracts k WHERE k.client_id = c.id) AS contract_count,
              (SELECT count(*)::int FROM contracts k WHERE k.client_id = c.id AND k.status = 'active') AS active_contracts
       FROM clients c WHERE kind = $1 AND ($2::text IS NULL OR c.name ILIKE '%'||$2||'%' OR c.code ILIKE '%'||$2||'%' OR c.gstin ILIKE '%'||$2||'%' OR array_to_string(c.aliases, ' ') ILIKE '%'||$2||'%')
       ORDER BY ${e === 'departments' ? 'c.name' : 'c.code'}`,
      [kindOf(e), q],
    );
  });

  const saveManual = async (req: FastifyRequest, id?: string) => {
    const e = parse(z.enum(MASTER), (req.params as { entity: string }).entity);
    requirePerm(req, 'client.write');
    const body = parse(z.record(z.string(), z.unknown()), req.body);
    const { values, errors } = normaliseRecord(e, body);
    if (errors.length) throw badRequest(errors.join('; '), errors);
    // Manual edits may also clear a field: blank values are written as empty.
    for (const f of FIELDS[e]) if (body[f.key] !== undefined && values[f.key] === undefined && !f.required) values[f.key] = f.type === 'list' ? [] : null;
    if (typeof body.extra === 'object' && body.extra) values.extra = body.extra;
    return db.tx(async (t) => {
      const key = String(values[KEY_FIELD[e]] ?? '');
      const clash = await t.one<{ id: string }>(e === 'departments' ? `SELECT id FROM clients WHERE kind = 'department' AND lower(name) = lower($1)` : `SELECT id FROM clients WHERE kind = 'institution' AND lower(code) = lower($1)`, [key]);
      if (clash && clash.id !== id) throw conflict(`A ${e === 'departments' ? 'department named' : 'institution with code'} "${key}" already exists — edit that record instead`);
      if (id) {
        const ex = await t.one<{ kind: string }>('SELECT kind FROM clients WHERE id = $1', [id]);
        if (!ex || ex.kind !== kindOf(e)) throw notFound('Record');
      }
      const r = await upsertRecord(t, e, values, req.user!.id, id);
      return t.one('SELECT * FROM clients WHERE id = $1', [r.id]);
    });
  };
  app.post('/master/:entity', async (req) => saveManual(req));
  app.put('/master/:entity/:id', async (req) => saveManual(req, (req.params as { id: string }).id));
}
