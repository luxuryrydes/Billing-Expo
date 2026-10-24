import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, notFound, optText, parse, uuid } from '../lib/http.js';
import { checkUpload, filePath, loadFile, saveFile } from '../lib/storage.js';
import { profileDocument } from '../services/profile.js';
import { aiExtract, FIELD_LABELS, ruleExtract, runWorker, type Candidate } from '../services/extraction.js';

const DocType = z.enum(['contract', 'tender', 'scc', 'acc', 'rate_schedule', 'work_order', 'sample_invoice', 'billing_register', 'duty_sheet', 'other']);

/** Marks pending/accepted items that disagree on the same field + qualifier within a contract. */
export async function refreshConflicts(db: Db, contractId: string) {
  await db.query(
    `WITH live AS (
       SELECT id, field_key, lower(COALESCE(qualifier,'')) AS q, COALESCE(edited_value, value) AS v FROM extracted_items
       WHERE contract_id = $1 AND status IN ('pending','accepted','edited') AND field_key NOT IN ('reimbursement','deduction','billing_condition','km_adjustment','output_column')
     ), groups AS (SELECT field_key, q, count(DISTINCT v) > 1 AS c FROM live GROUP BY field_key, q)
     UPDATE extracted_items e SET conflict = COALESCE((SELECT g.c FROM live l JOIN groups g USING (field_key, q) WHERE l.id = e.id), false)
     WHERE e.contract_id = $1`,
    [contractId],
  );
}

export async function runExtraction(db: Db, versionId: string, useAi = true) {
  const v = await db.one<{ id: string; file_id: string; contract_id: string | null; storage_path: string; title: string }>(
    `SELECT dv.id, dv.file_id, d.contract_id, d.title, f.storage_path FROM document_versions dv JOIN documents d ON d.id = dv.document_id JOIN files f ON f.id = dv.file_id WHERE dv.id = $1`,
    [versionId],
  );
  if (!v) return;
  await db.query(`UPDATE document_versions SET extraction_status='running', extraction_error=NULL WHERE id=$1`, [versionId]);
  try {
    const result = await runWorker(filePath(v));
    const cats = await db.query<{ name: string }>('SELECT name FROM vehicle_categories');
    const rule = ruleExtract(result.pages, cats.map((c) => c.name));
    let ai: Awaited<ReturnType<typeof aiExtract>> = { candidates: [], questions: [], dropped: 0 };
    if (useAi) {
      try { ai = await aiExtract(result.pages); } catch (e) { ai.note = `AI extraction failed: ${(e as Error).message}`; }
    }
    const warnings = [...result.warnings];
    if (ai.note) warnings.push(ai.note);
    if (ai.dropped) warnings.push(`${ai.dropped} AI-proposed value(s) were discarded because their quote could not be found in the document.`);
    await db.tx(async (t) => {
      await t.query(`DELETE FROM extracted_items WHERE document_version_id = $1 AND status = 'pending' AND method <> 'manual'`, [versionId]);
      const all: Candidate[] = [...rule, ...ai.candidates];
      for (const c of all) {
        await t.query(
          `INSERT INTO extracted_items(document_version_id, contract_id, field_key, label, value, unit, qualifier, source_page, source_text, confidence, method)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [versionId, v.contract_id, c.field_key, c.label, c.value, c.unit, c.qualifier, c.source_page, c.source_text, c.confidence.toFixed(3), c.method],
        );
      }
      await t.query(
        `UPDATE document_versions SET extraction_status='done', extraction_method=$2, page_count=$3, extracted=$4 WHERE id=$1`,
        [versionId, result.method + (useAi && !ai.note ? '+claude' : ''), result.pageCount, { pages: result.pages, warnings, questions: ai.questions, profile: profileDocument(result.pages, v.title) }],
      );
    });
    if (v.contract_id) await refreshConflicts(db, v.contract_id);
  } catch (e) {
    await db.query(`UPDATE document_versions SET extraction_status='failed', extraction_error=$2 WHERE id=$1`, [versionId, (e as Error).message.slice(0, 1000)]);
  }
}

export async function documentRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/documents', { preHandler: perm('view') }, async (req) => {
    const q = req.query as { clientId?: string; contractId?: string };
    return db.query(
      `SELECT d.*, c.name AS client_name, k.reference_no AS contract_ref,
              lv.id AS latest_version_id, lv.version_no AS latest_version, lv.extraction_status, lv.uploaded_at, u.name AS uploaded_by_name, f.original_name, f.size_bytes,
              (SELECT count(*)::int FROM extracted_items e WHERE e.document_version_id = lv.id AND e.status = 'pending') AS pending_items,
              (SELECT count(*)::int FROM extracted_items e WHERE e.document_version_id = lv.id AND e.conflict) AS conflicts
       FROM documents d LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN contracts k ON k.id = d.contract_id
       LEFT JOIN LATERAL (SELECT * FROM document_versions v WHERE v.document_id = d.id ORDER BY version_no DESC LIMIT 1) lv ON true
       LEFT JOIN files f ON f.id = lv.file_id LEFT JOIN app_users u ON u.id = lv.uploaded_by
       WHERE ($1::uuid IS NULL OR d.client_id = $1) AND ($2::uuid IS NULL OR d.contract_id = $2)
       ORDER BY lv.uploaded_at DESC NULLS LAST`,
      [q.clientId || null, q.contractId || null],
    );
  });

  /** Upload a new document, or a new version of an existing one (field document_id). */
  app.post('/documents', { preHandler: perm('document.upload') }, async (req) => {
    const file = await req.file();
    if (!file) throw badRequest('Attach a file');
    const buf = await file.toBuffer();
    checkUpload(file.filename, buf);
    const f = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: string })?.value]));
    const meta = parse(
      z.object({
        document_id: uuid.optional().or(z.literal('').transform(() => undefined)),
        client_id: uuid.optional().or(z.literal('').transform(() => undefined)),
        contract_id: uuid.optional().or(z.literal('').transform(() => undefined)),
        doc_type: DocType.default('other'),
        title: optText,
        run_ai: z.enum(['true', 'false']).default('true'),
        note: optText,
      }),
      f,
    );
    const stored = await saveFile(db, file.filename, buf, req.user!.id, file.mimetype);
    const version = await db.tx(async (t) => {
      let docId = meta.document_id;
      if (docId) {
        const d = await t.one<{ client_id: string | null; contract_id: string | null }>('SELECT id, client_id, contract_id FROM documents WHERE id = $1', [docId]);
        if (!d) throw notFound('Document');
        // A new version must stay with the same department / contract.
        if ((meta.contract_id && d.contract_id && meta.contract_id !== d.contract_id) || (meta.client_id && d.client_id && meta.client_id !== d.client_id)) {
          throw badRequest('That document belongs to a different department or contract; upload this file as a new document instead.');
        }
        await t.query('UPDATE documents SET updated_at = now() WHERE id = $1', [docId]);
      } else {
        let clientId = meta.client_id ?? null;
        if (meta.contract_id && !clientId) clientId = (await t.one<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = $1', [meta.contract_id]))?.client_id ?? null;
        const d = await t.one<{ id: string }>(
          'INSERT INTO documents(client_id, contract_id, doc_type, title) VALUES ($1,$2,$3,$4) RETURNING id',
          [clientId, meta.contract_id ?? null, meta.doc_type, meta.title ?? file.filename],
        );
        docId = d!.id;
      }
      const v = await t.one<{ id: string; version_no: number }>(
        `INSERT INTO document_versions(document_id, version_no, file_id, uploaded_by, note)
         VALUES ($1, (SELECT COALESCE(max(version_no),0)+1 FROM document_versions WHERE document_id = $1), $2, $3, $4) RETURNING id, version_no, document_id`,
        [docId, stored.id, req.user!.id, meta.note ?? null],
      );
      await audit(t, req.user!.id, 'document', docId!, 'upload_version', undefined, { version: v!.version_no, file: stored.original_name, sha256: stored.sha256 });
      return v!;
    });
    // Extraction runs in the background; the UI polls the version status.
    void runExtraction(db, version.id, meta.run_ai === 'true');
    return version;
  });

  /**
   * Before an upload: finds documents this file would update — only within the same contract
   * (or the same department when there is no contract) and the same document type. A matching
   * file name alone never links documents of different departments or contracts.
   */
  app.post('/documents/match', { preHandler: perm('document.upload') }, async (req) => {
    const b = parse(z.object({ client_id: uuid.nullable().optional(), contract_id: uuid.nullable().optional(), doc_type: z.string(), file_name: z.string(), sha256: z.string().optional() }), req.body);
    if (!b.client_id && !b.contract_id) return { matches: [], identical: null };
    const rows = await db.query<{ id: string; title: string; doc_type: string; latest_version: number; original_name: string; sha256: string; uploaded_at: string; uploaded_by_name: string | null }>(
      `SELECT d.id, d.title, d.doc_type, v.version_no AS latest_version, f.original_name, f.sha256, v.uploaded_at, u.name AS uploaded_by_name
       FROM documents d JOIN LATERAL (SELECT * FROM document_versions x WHERE x.document_id = d.id ORDER BY version_no DESC LIMIT 1) v ON true
       JOIN files f ON f.id = v.file_id LEFT JOIN app_users u ON u.id = v.uploaded_by
       WHERE d.doc_type = $1 AND (($2::uuid IS NOT NULL AND d.contract_id = $2) OR ($2::uuid IS NULL AND d.contract_id IS NULL AND d.client_id = $3))
       ORDER BY v.uploaded_at DESC`,
      [b.doc_type, b.contract_id ?? null, b.client_id ?? null],
    );
    const base = (n: string) => n.toLowerCase().replace(/\.[a-z0-9]+$/, '');
    const matches = rows.map((r) => ({ ...r, sameName: base(r.original_name) === base(b.file_name) || r.title.toLowerCase() === base(b.file_name), sameFile: !!b.sha256 && r.sha256 === b.sha256 }))
      .sort((a, c) => Number(c.sameFile) - Number(a.sameFile) || Number(c.sameName) - Number(a.sameName));
    return { matches, identical: matches.find((m) => m.sameFile) ?? null };
  });

  /** Makes an older version current again by adding it as a new version (nothing is deleted). */
  app.post('/document-versions/:id/restore', { preHandler: perm('document.upload') }, async (req) => {
    const { id } = req.params as { id: string };
    const old = await db.one<{ document_id: string; file_id: string; version_no: number; extracted: unknown; extraction_status: string; extraction_method: string | null; page_count: number | null }>('SELECT * FROM document_versions WHERE id = $1', [id]);
    if (!old) throw notFound('Document version');
    const v = await db.tx(async (t) => {
      const nv = await t.one<{ id: string; version_no: number }>(
        `INSERT INTO document_versions(document_id, version_no, file_id, uploaded_by, note, extraction_status, extraction_method, page_count, extracted)
         VALUES ($1, (SELECT max(version_no)+1 FROM document_versions WHERE document_id = $1), $2, $3, $4, $5, $6, $7, $8) RETURNING id, version_no`,
        [old.document_id, old.file_id, req.user!.id, `Restored from version ${old.version_no}`, old.extraction_status, old.extraction_method, old.page_count, old.extracted],
      );
      await t.query('UPDATE documents SET updated_at = now() WHERE id = $1', [old.document_id]);
      await audit(t, req.user!.id, 'document', old.document_id, 'restore_version', undefined, { from: old.version_no, to: nv!.version_no });
      return nv!;
    });
    if (old.extraction_status === 'done') {
      // Copy the reviewed candidates too, so earlier review decisions are not lost.
      await db.query(
        `INSERT INTO extracted_items(document_version_id, contract_id, field_key, label, value, unit, qualifier, source_page, source_text, confidence, method, status, edited_value, review_note, reviewed_by, reviewed_at, conflict)
         SELECT $2, contract_id, field_key, label, value, unit, qualifier, source_page, source_text, confidence, method, status, edited_value, review_note, reviewed_by, reviewed_at, conflict FROM extracted_items WHERE document_version_id = $1`,
        [id, v.id]);
    }
    return v;
  });

  app.get('/documents/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const d = await db.one(
      `SELECT d.*, c.name AS client_name, k.reference_no AS contract_ref, k.title AS contract_title FROM documents d
       LEFT JOIN clients c ON c.id = d.client_id LEFT JOIN contracts k ON k.id = d.contract_id WHERE d.id = $1`, [id]);
    if (!d) throw notFound('Document');
    const versions = await db.query(
      `SELECT v.id, v.version_no, v.uploaded_at, v.note, v.extraction_status, v.extraction_error, v.extraction_method, v.page_count,
              v.extracted->'warnings' AS warnings, v.extracted->'questions' AS questions, f.id AS file_id, f.original_name, f.size_bytes, f.sha256, u.name AS uploaded_by_name
       FROM document_versions v JOIN files f ON f.id = v.file_id LEFT JOIN app_users u ON u.id = v.uploaded_by WHERE v.document_id = $1 ORDER BY v.version_no DESC`, [id]);
    return { ...d, versions };
  });

  app.get('/document-versions/:id/items', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    return db.query(
      `SELECT e.*, u.name AS reviewed_by_name FROM extracted_items e LEFT JOIN app_users u ON u.id = e.reviewed_by
       WHERE e.document_version_id = $1 ORDER BY e.field_key, e.qualifier NULLS FIRST, e.source_page`, [id]);
  });

  app.get('/document-versions/:id/page/:page', { preHandler: perm('view') }, async (req) => {
    const { id, page } = req.params as { id: string; page: string };
    const r = await db.one<{ p: unknown }>(`SELECT (SELECT p FROM jsonb_array_elements(extracted->'pages') p WHERE (p->>'page')::int = $2) AS p FROM document_versions WHERE id = $1`, [id, Number(page)]);
    if (!r?.p) throw notFound('Page');
    return r.p;
  });

  app.post('/document-versions/:id/extract', { preHandler: perm('document.upload') }, async (req) => {
    const { id } = req.params as { id: string };
    const { useAi } = parse(z.object({ useAi: z.boolean().default(true) }), req.body ?? {});
    const v = await db.one('SELECT id FROM document_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Document version');
    void runExtraction(db, id, useAi);
    await audit(db, req.user!.id, 'document_version', id, 'rerun_extraction');
    return { status: 'running' };
  });

  /** Review: accept, reject or edit an extracted value. Every decision is a human decision. */
  app.patch('/extracted-items/:id', { preHandler: perm('extraction.review') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(
      z.object({ status: z.enum(['accepted', 'rejected', 'edited', 'pending']), edited_value: optText, review_note: optText }),
      req.body,
    );
    if (b.status === 'edited' && !b.edited_value) throw badRequest('Enter the corrected value');
    const before = await db.one<{ contract_id: string | null }>('SELECT * FROM extracted_items WHERE id = $1', [id]);
    if (!before) throw notFound('Extracted item');
    const row = await db.one(
      `UPDATE extracted_items SET status=$2, edited_value=$3, review_note=$4, reviewed_by=$5, reviewed_at=now() WHERE id=$1 RETURNING *`,
      [id, b.status, b.status === 'edited' ? b.edited_value : null, b.review_note, req.user!.id],
    );
    if (before.contract_id) await refreshConflicts(db, before.contract_id);
    await audit(db, req.user!.id, 'extracted_item', id, `review_${b.status}`, before, row, b.review_note ?? undefined);
    return row;
  });

  app.post('/document-versions/:id/items', { preHandler: perm('extraction.review') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ field_key: z.string(), value: z.string().min(1), unit: optText, qualifier: optText, source_page: z.number().int().nullable().optional(), source_text: z.string().min(1, 'Quote the clause'), }), req.body);
    const v = await db.one<{ contract_id: string | null }>('SELECT d.contract_id FROM document_versions dv JOIN documents d ON d.id = dv.document_id WHERE dv.id = $1', [id]);
    if (!v) throw notFound('Document version');
    const row = await db.one<{ id: string }>(
      `INSERT INTO extracted_items(document_version_id, contract_id, field_key, label, value, unit, qualifier, source_page, source_text, method, status, reviewed_by, reviewed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'manual','accepted',$10,now()) RETURNING *`,
      [id, v.contract_id, b.field_key, FIELD_LABELS[b.field_key] ?? b.field_key, b.value, b.unit, b.qualifier, b.source_page ?? null, b.source_text, req.user!.id],
    );
    if (v.contract_id) await refreshConflicts(db, v.contract_id);
    await audit(db, req.user!.id, 'extracted_item', row!.id, 'manual_add', undefined, b);
    return row;
  });

  app.get('/contracts/:id/extracted-terms', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    return db.query(
      `SELECT e.*, d.id AS document_id, d.title AS document_title, d.doc_type, dv.version_no FROM extracted_items e
       JOIN document_versions dv ON dv.id = e.document_version_id JOIN documents d ON d.id = dv.document_id
       WHERE e.contract_id = $1 AND e.status <> 'rejected' ORDER BY e.field_key, e.qualifier NULLS FIRST`, [id]);
  });

  app.get('/extraction/fields', { preHandler: perm('view') }, async () => FIELD_LABELS);

  app.get('/files/:id/download', { preHandler: perm('view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const f = await loadFile(db, id);
    if (!f) throw notFound('File');
    const inline = (req.query as { inline?: string }).inline === '1' && f.meta.mime_type === 'application/pdf';
    reply.header('Content-Type', f.meta.mime_type);
    reply.header('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.meta.original_name)}`);
    return reply.send(f.buf);
  });
}
