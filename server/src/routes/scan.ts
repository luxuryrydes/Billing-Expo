/**
 * Duty Slip Scanning & Billing: scan (or upload) a stack of slips, tidy the pages, have each read by AI,
 * review and correct the values (on screen or in Excel), save them as duties, then bill them in the usual way.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, notFound, parse, uuid } from '../lib/http.js';
import { checkUpload, loadFile, saveFile } from '../lib/storage.js';
import { listScanners, scan, scannerBusy, scannerStatus, ScannerError, type ScanOptions } from '../services/scanner.js';
import { readSlip, SLIP_FIELDS } from '../services/slipReader.js';
import { effectiveValues, saveReadings, type ReadingRow } from '../services/slipDuty.js';
import { exportSlipsXlsx, importSlipsXlsx } from '../services/slipExcel.js';

const IMAGE_EXT = ['.jpg', '.jpeg', '.png'];
const ScanSettings = z.object({
  deviceId: z.string().min(1),
  mode: z.enum(['color', 'gray', 'bw']).default('color'),
  dpi: z.number().int().min(75).max(1200).default(200),
  source: z.enum(['feeder', 'flatbed']).default('feeder'),
  duplex: z.boolean().default(false),
});

export async function scanRoutes(app: FastifyInstance) {
  const db = app.db;
  const write = perm('duty.write');

  /** Adds one image to a batch and gives it an empty reading. */
  async function addPage(t: Db, batchId: string, name: string, buf: Buffer, userId: string) {
    const f = await saveFile(t, name, buf, userId);
    const pos = ((await t.one<{ m: number | null }>('SELECT max(position)::int AS m FROM scan_pages WHERE batch_id = $1', [batchId]))?.m ?? 0) + 1;
    const page = await t.one<{ id: string }>('INSERT INTO scan_pages(batch_id, position, file_id, original_file_id) VALUES ($1,$2,$3,$3) RETURNING id', [batchId, pos, f.id]);
    await t.query('INSERT INTO slip_readings(page_id, batch_id) VALUES ($1,$2)', [page!.id, batchId]);
    return page!.id;
  }
  const loadPage = async (id: string) => {
    const p = await db.one<{ id: string; batch_id: string; file_id: string; original_file_id: string; position: number }>('SELECT * FROM scan_pages WHERE id = $1', [id]);
    if (!p) throw notFound('Page');
    return p;
  };
  const stamp = () => new Date().toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
  const uploads = async (req: Parameters<typeof write>[0]) => {
    const files: { name: string; buf: Buffer }[] = [];
    for await (const part of (req as unknown as { parts(): AsyncIterable<{ type: string; filename?: string; toBuffer(): Promise<Buffer>; fieldname: string; value?: unknown }> }).parts()) {
      if (part.type !== 'file' || !part.filename) continue;
      const buf = await part.toBuffer();
      checkUpload(part.filename, buf, IMAGE_EXT);
      files.push({ name: part.filename, buf });
    }
    return files;
  };

  // --- what is available ---------------------------------------------------------------------
  app.get('/scan/status', { preHandler: perm('view') }, async () => ({
    scanner: { ...scannerStatus(), busy: scannerBusy() },
    ai: { configured: config.slipReader === 'mock' || !!config.anthropicApiKey, reader: config.slipReader, model: config.anthropicModel },
    fields: SLIP_FIELDS,
  }));

  app.get('/scan/devices', { preHandler: write }, async () => {
    try { return { devices: await listScanners() }; } catch (e) { throw badRequest((e as Error).message); }
  });

  // --- batches -------------------------------------------------------------------------------
  app.get('/scan/batches', { preHandler: perm('view') }, async () => db.query(
    `SELECT b.*, u.name AS created_by_name,
       (SELECT count(*)::int FROM scan_pages p WHERE p.batch_id = b.id AND NOT p.deleted) AS pages,
       (SELECT count(*)::int FROM slip_readings r JOIN scan_pages p ON p.id = r.page_id WHERE r.batch_id = b.id AND NOT p.deleted AND r.status = 'read') AS read_count,
       (SELECT count(*)::int FROM slip_readings r JOIN scan_pages p ON p.id = r.page_id WHERE r.batch_id = b.id AND NOT p.deleted AND r.duty_id IS NOT NULL) AS saved_count
     FROM scan_batches b LEFT JOIN app_users u ON u.id = b.created_by ORDER BY b.created_at DESC LIMIT 100`));

  async function batchDetail(id: string) {
    const b = await db.one('SELECT b.*, u.name AS created_by_name FROM scan_batches b LEFT JOIN app_users u ON u.id = b.created_by WHERE b.id = $1', [id]);
    if (!b) throw notFound('Scan batch');
    const rows = await db.query(
      `SELECT p.id, p.position, p.file_id, p.original_file_id, p.deleted, p.file_id <> p.original_file_id AS edited_image,
              r.id AS reading_id, r.status, r.fields, r.edited, r.notes, r.error, r.model, r.contract_id, r.duty_id
       FROM scan_pages p JOIN slip_readings r ON r.page_id = p.id WHERE p.batch_id = $1 ORDER BY p.deleted, p.position`, [id]);
    const duties = rows.filter((r) => r.duty_id).length
      ? await db.query(`SELECT id, duty_date, vehicle_reg_no, status, error_count, warning_count, contract_id FROM duties WHERE id = ANY($1::uuid[])`, [rows.filter((r) => r.duty_id).map((r) => r.duty_id)])
      : [];
    const dutyById = new Map(duties.map((d) => [d.id, d]));
    return {
      batch: b,
      pages: rows.map((r) => ({
        id: r.id, position: r.position, fileId: r.file_id, originalFileId: r.original_file_id, deleted: r.deleted, editedImage: r.edited_image,
        reading: { id: r.reading_id, status: r.status, fields: r.fields, edited: r.edited, values: effectiveValues({ fields: r.fields as ReadingRow['fields'], edited: r.edited as ReadingRow['edited'] }), notes: r.notes, error: r.error, contractId: r.contract_id, dutyId: r.duty_id, duty: r.duty_id ? dutyById.get(r.duty_id) ?? null : null },
      })),
    };
  }
  app.get('/scan/batches/:id', { preHandler: perm('view') }, async (req) => batchDetail((req.params as { id: string }).id));

  /** Starts scanning in the background; the screen polls the batch for the pages as they arrive. */
  app.post('/scan/batches', { preHandler: write }, async (req) => {
    const b = parse(ScanSettings.extend({ title: z.string().trim().max(120).optional(), contractId: uuid.nullable().optional() }), req.body);
    if (scannerBusy()) throw conflict('A scan is already running. Wait for it to finish.');
    const st = scannerStatus();
    if (!st.available) throw badRequest(st.reason ?? 'Scanning is not available here.');
    const devices = await listScanners().catch(() => []);
    const dev = devices.find((d) => d.id === b.deviceId);
    if (b.duplex && dev && !dev.duplex) throw badRequest('This scanner cannot scan both sides. Scan one side, turn the stack over and scan again; the pages are added to the same batch.');
    const userId = req.user!.id;
    const batch = await db.one<{ id: string }>(
      `INSERT INTO scan_batches(title, source, device_name, color_mode, dpi, scan_source, contract_id, created_by) VALUES ($1,'scanner',$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.title || `Scan ${stamp()}`, dev?.name ?? b.deviceId, b.mode, b.dpi, b.source, b.contractId ?? null, userId]);
    const batchId = batch!.id;
    await audit(db, userId, 'scan_batch', batchId, 'start_scan', undefined, { device: dev?.name, mode: b.mode, dpi: b.dpi, source: b.source });
    const opts: ScanOptions = { deviceId: b.deviceId, mode: b.mode, dpi: b.dpi, source: b.source, duplex: b.duplex };
    void (async () => {
      try {
        const n = await scan(opts, async (file, i) => { await addPage(db, batchId, `scan-${String(i).padStart(3, '0')}${path.extname(file)}`, fs.readFileSync(file), userId); });
        await db.query(`UPDATE scan_batches SET status = $2, error = $3 WHERE id = $1`, [batchId, n ? 'ready' : 'failed', n ? null : 'No pages were scanned.']);
      } catch (e) {
        const pages = (await db.one<{ n: number }>('SELECT count(*)::int AS n FROM scan_pages WHERE batch_id = $1', [batchId]))?.n ?? 0;
        await db.query(`UPDATE scan_batches SET status = $2, error = $3 WHERE id = $1`, [batchId, pages ? 'ready' : 'failed', e instanceof ScannerError || e instanceof Error ? e.message : String(e)]);
      }
    })();
    return batchDetail(batchId);
  });

  /** Images that were scanned elsewhere (or from the printer's own scan-to-folder): a new batch, or more pages for a batch. */
  app.post('/scan/batches/upload', { preHandler: write }, async (req) => {
    const files = await uploads(req);
    if (!files.length) throw badRequest('Choose one or more scanned images (JPG or PNG)');
    const userId = req.user!.id;
    const id = await db.tx(async (t) => {
      const b = await t.one<{ id: string }>(`INSERT INTO scan_batches(title, source, status, created_by) VALUES ($1,'upload','ready',$2) RETURNING id`, [`Upload ${stamp()}`, userId]);
      for (const f of files.sort((a, c) => a.name.localeCompare(c.name, undefined, { numeric: true }))) await addPage(t, b!.id, f.name, f.buf, userId);
      return b!.id;
    });
    return batchDetail(id);
  });
  app.post('/scan/batches/:id/pages', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    if (!(await db.one('SELECT 1 FROM scan_batches WHERE id = $1', [id]))) throw notFound('Scan batch');
    const files = await uploads(req);
    if (!files.length) throw badRequest('Choose one or more scanned images (JPG or PNG)');
    await db.tx(async (t) => { for (const f of files) await addPage(t, id, f.name, f.buf, req.user!.id); });
    return batchDetail(id);
  });

  app.patch('/scan/batches/:id', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ title: z.string().trim().min(1).max(120).optional(), contractId: uuid.nullable().optional() }), req.body);
    if (b.title !== undefined) await db.query('UPDATE scan_batches SET title = $2 WHERE id = $1', [id, b.title]);
    if (b.contractId !== undefined) await db.query('UPDATE scan_batches SET contract_id = $2 WHERE id = $1', [id, b.contractId]);
    return batchDetail(id);
  });

  // --- pages ---------------------------------------------------------------------------------
  app.post('/scan/pages/:id/delete', { preHandler: write }, async (req) => {
    const p = await loadPage((req.params as { id: string }).id);
    const { deleted } = parse(z.object({ deleted: z.boolean().default(true) }), req.body ?? {});
    await db.query('UPDATE scan_pages SET deleted = $2 WHERE id = $1', [p.id, deleted]);
    await audit(db, req.user!.id, 'scan_page', p.id, deleted ? 'delete_page' : 'restore_page');
    return { ok: true };
  });

  app.post('/scan/batches/:id/reorder', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const { pageIds } = parse(z.object({ pageIds: z.array(uuid).min(1) }), req.body);
    await db.tx(async (t) => { for (let i = 0; i < pageIds.length; i++) await t.query('UPDATE scan_pages SET position = $3 WHERE id = $1 AND batch_id = $2', [pageIds[i], id, i + 1]); });
    return batchDetail(id);
  });

  /** The page image after rotating or cropping in the browser. The scanned original is kept. */
  app.put('/scan/pages/:id/image', { preHandler: write }, async (req) => {
    const p = await loadPage((req.params as { id: string }).id);
    const [f] = await uploads(req);
    if (!f) throw badRequest('No image received');
    const stored = await saveFile(db, f.name, f.buf, req.user!.id);
    await db.query('UPDATE scan_pages SET file_id = $2 WHERE id = $1', [p.id, stored.id]);
    // The image changed, so what was read from the old one no longer applies.
    await db.query(`UPDATE slip_readings SET status = 'pending', fields = '{}'::jsonb, edited = '{}'::jsonb, notes = NULL, error = NULL, updated_at = now() WHERE page_id = $1 AND duty_id IS NULL`, [p.id]);
    await audit(db, req.user!.id, 'scan_page', p.id, 'edit_image');
    return { ok: true, fileId: stored.id };
  });
  app.post('/scan/pages/:id/restore-original', { preHandler: write }, async (req) => {
    const p = await loadPage((req.params as { id: string }).id);
    await db.query('UPDATE scan_pages SET file_id = original_file_id WHERE id = $1', [p.id]);
    await db.query(`UPDATE slip_readings SET status = 'pending', fields = '{}'::jsonb, edited = '{}'::jsonb, notes = NULL, error = NULL, updated_at = now() WHERE page_id = $1 AND duty_id IS NULL`, [p.id]);
    return { ok: true };
  });

  /** Scans this one page again and replaces the image. */
  app.post('/scan/pages/:id/rescan', { preHandler: write }, async (req) => {
    const p = await loadPage((req.params as { id: string }).id);
    const b = parse(ScanSettings, req.body);
    let file: string | null = null;
    try {
      await scan({ ...b, maxPages: 1, duplex: false }, async (f) => { file = f; const stored = await saveFile(db, `rescan${path.extname(f)}`, fs.readFileSync(f), req.user!.id); await db.query('UPDATE scan_pages SET file_id = $2, original_file_id = $2 WHERE id = $1', [p.id, stored.id]); });
    } catch (e) { throw badRequest((e as Error).message); }
    if (!file) throw badRequest('Nothing was scanned. Put the page in the scanner and try again.');
    await db.query(`UPDATE slip_readings SET status = 'pending', fields = '{}'::jsonb, edited = '{}'::jsonb, notes = NULL, error = NULL, updated_at = now() WHERE page_id = $1 AND duty_id IS NULL`, [p.id]);
    await audit(db, req.user!.id, 'scan_page', p.id, 'rescan');
    return { ok: true };
  });

  // --- reading and review ---------------------------------------------------------------------
  app.post('/scan/pages/:id/read', { preHandler: write }, async (req) => {
    const p = await loadPage((req.params as { id: string }).id);
    const { force } = parse(z.object({ force: z.boolean().default(false) }), req.body ?? {});
    const cur = await db.one<{ id: string; status: string }>('SELECT id, status FROM slip_readings WHERE page_id = $1', [p.id]);
    if (!cur) throw notFound('Reading');
    if (cur.status === 'read' && !force) return { id: cur.id, status: 'read' };
    await db.query(`UPDATE slip_readings SET status = 'reading', error = NULL, updated_at = now() WHERE id = $1`, [cur.id]);
    try {
      const file = await loadFile(db, p.file_id);
      if (!file) throw new Error('The page image is missing');
      const hints = {
        departments: (await db.query<{ name: string }>(`SELECT name FROM clients WHERE status = 'active' ORDER BY name`)).map((c) => c.name),
        categories: (await db.query<{ name: string }>('SELECT name FROM vehicle_categories ORDER BY name')).map((c) => c.name),
      };
      const r = await readSlip(file.buf, hints);
      await db.query(`UPDATE slip_readings SET status = 'read', fields = $2, notes = $3, model = $4, error = NULL, updated_at = now() WHERE id = $1`,
        [cur.id, JSON.stringify(r.fields), r.isDutySlip ? r.notes || null : `Not recognised as a duty slip. ${r.notes}`.trim(), r.model]);
      return { id: cur.id, status: 'read' };
    } catch (e) {
      await db.query(`UPDATE slip_readings SET status = 'failed', error = $2, updated_at = now() WHERE id = $1`, [cur.id, (e as Error).message.slice(0, 500)]);
      return { id: cur.id, status: 'failed', error: (e as Error).message };
    }
  });

  app.put('/scan/readings/:id', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ edited: z.record(z.string(), z.string().nullable()).optional(), contractId: uuid.nullable().optional() }), req.body);
    const keys = new Set(SLIP_FIELDS.map((f) => f.key));
    const edited = Object.fromEntries(Object.entries(b.edited ?? {}).filter(([k]) => keys.has(k)).map(([k, v]) => [k, (v ?? '').trim()]));
    const r = await db.one('SELECT id FROM slip_readings WHERE id = $1', [id]);
    if (!r) throw notFound('Reading');
    if (Object.keys(edited).length) await db.query('UPDATE slip_readings SET edited = edited || $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(edited)]);
    if (b.contractId !== undefined) await db.query('UPDATE slip_readings SET contract_id = $2, updated_at = now() WHERE id = $1', [id, b.contractId]);
    return { ok: true };
  });

  // --- save as duties --------------------------------------------------------------------------
  app.post('/scan/batches/:id/save', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ readingIds: z.array(uuid).optional(), contractIds: z.record(z.string(), uuid).optional(), defaultDutyType: z.string().trim().nullable().default('LOCAL'), dryRun: z.boolean().default(false) }), req.body);
    const batch = await db.one<{ id: string; title: string }>('SELECT id, title FROM scan_batches WHERE id = $1', [id]);
    if (!batch) throw notFound('Scan batch');
    const rows = await db.query<ReadingRow & { position: number }>(
      `SELECT r.*, p.position FROM slip_readings r JOIN scan_pages p ON p.id = r.page_id WHERE r.batch_id = $1 AND NOT p.deleted AND r.status = 'read' ORDER BY p.position`, [id]);
    const picked = rows.filter((r) => !b.readingIds || b.readingIds.includes(r.id));
    if (!picked.length) throw badRequest('No slips have been read yet.');
    const results = await saveReadings(db, req.user!.id, batch, picked, new Map(picked.map((r) => [r.page_id, r.position])), { contractIds: b.contractIds, defaultDutyType: b.defaultDutyType, dryRun: b.dryRun });
    const count = (a: string) => results.filter((r) => r.action === a).length;
    return { dryRun: b.dryRun, results, summary: { add: count('add'), update: count('update'), unchanged: count('unchanged'), locked: count('locked'), error: count('error') } };
  });

  // --- Excel -----------------------------------------------------------------------------------
  app.get('/scan/batches/:id/export.xlsx', { preHandler: perm('view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const batch = await db.one<{ title: string }>('SELECT title FROM scan_batches WHERE id = $1', [id]);
    if (!batch) throw notFound('Scan batch');
    const rows = await db.query<ReadingRow & { position: number }>(`SELECT r.*, p.position FROM slip_readings r JOIN scan_pages p ON p.id = r.page_id WHERE r.batch_id = $1 AND NOT p.deleted ORDER BY p.position`, [id]);
    const buf = await exportSlipsXlsx(batch.title, rows.map((r) => ({ reading: r, position: r.position })));
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="duty-slips-${batch.title.replace(/[^\w.-]+/g, '_')}.xlsx"`);
    return reply.send(buf);
  });

  app.post('/scan/batches/:id/import', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    if (!(await db.one('SELECT 1 FROM scan_batches WHERE id = $1', [id]))) throw notFound('Scan batch');
    const file = await req.file();
    if (!file) throw badRequest('Choose the Excel sheet exported from this batch');
    const buf = await file.toBuffer();
    checkUpload(file.filename, buf, ['.xlsx']);
    return importSlipsXlsx(db, req.user!.id, id, buf);
  });
}
