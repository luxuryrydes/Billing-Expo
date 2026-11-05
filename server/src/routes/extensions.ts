/**
 * Contract extension letters: upload, read the dates with AI, let a person confirm or correct them, then apply.
 * Nothing changes the contract until an extension is applied by a person with permission to edit contracts.
 */
import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, notFound, parse, uuid } from '../lib/http.js';
import { checkUpload, loadFile, saveFile } from '../lib/storage.js';
import { applyExtension, extensionSummary, findConflicts, isIso, period } from '../services/contractExtensions.js';
import { readExtensionLetter, readerAvailable } from '../services/extensionReader.js';

const dateOrNull = z.string().trim().nullable().optional().transform((v) => (v ? v : null)).refine((v) => v === null || isIso(v), 'Use a valid date (YYYY-MM-DD)');
const text = z.string().trim().max(500).nullable().optional().transform((v) => v || null);
const Confirmed = z.object({
  letter_no: text, letter_date: dateOrNull, department_name: text, contract_reference: text,
  previous_end_date: dateOrNull, extension_start: dateOrNull, new_end_date: dateOrNull, remarks: z.string().trim().max(2000).nullable().optional().transform((v) => v || null),
});

export async function extensionRoutes(app: FastifyInstance) {
  const db = app.db;
  const write = perm('client.write');

  app.get('/contracts/:id/extensions', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    return { ...(await extensionSummary(db, id)), reader: { available: readerAvailable() } };
  });

  app.post('/contracts/:id/extensions', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const k = await db.one<{ id: string; client_id: string; end_date: string | null }>('SELECT id, client_id, end_date FROM contracts WHERE id = $1', [id]);
    if (!k) throw notFound('Contract');
    const part = await (req as unknown as { file(): Promise<{ filename: string; toBuffer(): Promise<Buffer> } | undefined> }).file();
    if (!part) throw badRequest('Choose the extension letter (PDF, JPG or PNG).');
    const buf = await part.toBuffer();
    checkUpload(part.filename, buf, ['.pdf', '.jpg', '.jpeg', '.png']);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const dupe = await db.one<{ id: string; status: string }>(`SELECT id, status FROM contract_extensions WHERE contract_id = $1 AND sha256 = $2 AND status <> 'rejected'`, [id, sha]);
    if (dupe) throw conflict(`This letter was already uploaded for this contract (${dupe.status === 'applied' ? 'and applied' : 'waiting for approval'}).`);

    const userId = req.user!.id;
    const file = await saveFile(db, part.filename, buf, userId);
    let extracted: Record<string, unknown> = {};
    let reader: string | null = null;
    let readError: string | null = null;
    try {
      const hints = { departments: (await db.query<{ name: string }>(`SELECT name FROM clients WHERE status = 'active' ORDER BY name`)).map((c) => c.name) };
      const r = await readExtensionLetter(buf, hints);
      extracted = { ...r.fields, _notes: r.notes, _isExtensionLetter: r.isExtensionLetter };
      reader = r.model;
      if (!r.isExtensionLetter) readError = 'This does not look like a contract extension letter. Check the file, or type the dates in by hand.';
    } catch (e) { readError = (e as Error).message.slice(0, 500); }
    const val = (key: string) => ((extracted[key] as { value: string | null } | undefined)?.value ?? null);
    const date = (key: string) => (isIso(val(key)) ? val(key) : null);
    const row = await db.one<{ id: string }>(
      `INSERT INTO contract_extensions(contract_id, file_id, sha256, extracted, reader, read_error, letter_no, letter_date, department_name, contract_reference,
         previous_end_date, extension_start, new_end_date, remarks, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [id, file.id, sha, JSON.stringify(extracted), reader, readError, val('letter_no'), date('letter_date'), val('department_name'), val('contract_reference') ?? val('original_reference'),
        date('existing_end_date'), date('extension_start'), date('new_end_date'), val('remarks'), userId]);
    await audit(db, userId, 'contract', id, 'upload_extension', undefined, { extension: row!.id, file: part.filename, readError });
    return refreshConflicts(row!.id);
  });

  async function refreshConflicts(extId: string) {
    const e = await db.one<Record<string, any>>('SELECT * FROM contract_extensions WHERE id = $1', [extId]);
    if (!e) throw notFound('Extension');
    const k = await db.one<{ id: string; start_date: string; end_date: string | null; status: string }>('SELECT id, start_date, end_date, status FROM contracts WHERE id = $1', [e.contract_id]);
    const conflicts = e.status === 'pending' && k ? await findConflicts(db, e as never, k) : e.conflicts;
    if (e.status === 'pending') await db.query('UPDATE contract_extensions SET conflicts = $2 WHERE id = $1', [extId, JSON.stringify(conflicts)]);
    const from = e.extension_start ?? (k?.end_date ? new Date(Date.parse(k.end_date) + 86_400_000).toISOString().slice(0, 10) : null);
    return { ...e, conflicts, duration: from && e.new_end_date && e.new_end_date >= from ? period(from, e.new_end_date) : null };
  }

  /** A person confirms or corrects the values read from the letter. */
  app.put('/contract-extensions/:id', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(Confirmed, req.body);
    const cur = await db.one<{ status: string; contract_id: string }>('SELECT status, contract_id FROM contract_extensions WHERE id = $1', [id]);
    if (!cur) throw notFound('Extension');
    if (cur.status !== 'pending') throw conflict(`This extension is already ${cur.status}.`);
    await db.query(
      `UPDATE contract_extensions SET letter_no=$2, letter_date=$3, department_name=$4, contract_reference=$5, previous_end_date=$6, extension_start=$7, new_end_date=$8, remarks=$9, reviewed_by=$10 WHERE id=$1`,
      [id, b.letter_no, b.letter_date, b.department_name, b.contract_reference, b.previous_end_date, b.extension_start, b.new_end_date, b.remarks, req.user!.id]);
    await audit(db, req.user!.id, 'contract', cur.contract_id, 'review_extension', undefined, { extension: id, ...b });
    return refreshConflicts(id);
  });

  app.post('/contract-extensions/:id/apply', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ acknowledge: z.boolean().default(false) }), req.body ?? {});
    return applyExtension(db, id, req.user!.id, b.acknowledge);
  });

  app.post('/contract-extensions/:id/reject', { preHandler: write }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ reason: z.string().trim().min(1, 'Give a reason').max(500) }), req.body);
    const row = await db.one<{ contract_id: string }>(`UPDATE contract_extensions SET status = 'rejected', rejected_reason = $2, reviewed_by = $3 WHERE id = $1 AND status = 'pending' RETURNING contract_id`, [id, b.reason, req.user!.id]);
    if (!row) throw conflict('Only an extension waiting for approval can be rejected.');
    await audit(db, req.user!.id, 'contract', row.contract_id, 'reject_extension', undefined, { extension: id }, b.reason);
    return { ok: true };
  });

  /** The uploaded letter, for download. */
  app.get('/contract-extensions/:id/file', { preHandler: perm('view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const e = await db.one<{ file_id: string }>('SELECT file_id FROM contract_extensions WHERE id = $1', [id]);
    if (!e) throw notFound('Extension');
    const f = await loadFile(db, e.file_id);
    if (!f) throw notFound('File');
    reply.header('Content-Type', f.meta.mime_type);
    reply.header('Content-Disposition', `attachment; filename="${f.meta.original_name.replace(/["\r\n]/g, '_')}"`);
    return reply.send(f.buf);
  });

  void uuid;
}
