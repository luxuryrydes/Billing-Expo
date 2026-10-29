import type { FastifyInstance } from 'fastify';
import ExcelJS from 'exceljs';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { can, perm } from '../lib/auth.js';
import { badRequest, conflict, forbidden, notFound, optText, parse, uuid } from '../lib/http.js';
import { checkUpload, filePath, loadFile, saveFile } from '../lib/storage.js';
import { runWorker } from '../services/extraction.js';
import { learnFromPdf, learnFromXlsx, type LearnedTemplate } from '../services/sampleTemplate.js';
import { calculateBill } from '../engine/bill.js';
import { RateConfigSchema, type DutyInput } from '../engine/types.js';
import { BLOCK_COLUMN_KEYS, buildRenderModel, defaultDutyLayout, DUTY_COLUMN_KEYS, LayoutSchema, LINE_COLUMN_KEYS, lrStandardLayout, placeholders, type BillContext } from '../services/render.js';
import { renderMappedXlsx, XlsxMappingSchema } from '../services/excel.js';
import { renderBillXlsx } from '../services/excelLr.js';
import { renderPdf } from '../services/pdf.js';
import { getSetting } from './master.js';
import { loadBillContext } from '../services/billing.js';

/** Synthetic, clearly-labelled data used only for template previews. */
export function previewContext(): BillContext {
  const cfg = RateConfigSchema.parse({
    billingModel: 'daily_package',
    params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'ceil', unit: '60' }, night: { enabled: true, start: '22:00', end: '06:00' } },
    components: [
      { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '1000', unit: 'duty', taxCategory: 'taxable' },
      { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '10', unit: 'km', taxCategory: 'taxable' },
      { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: '100', unit: 'hr', taxCategory: 'taxable' },
      { code: 'NIGHT', label: 'Night charge', quantityExpr: 'night_count', rate: '100', unit: 'night', taxCategory: 'taxable' },
      { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
      { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
    ],
  });
  const duties: (DutyInput & { driverName: string; fieldOfficer: string; remarks: string })[] = Array.from({ length: 40 }, (_, i) => {
    const day = String((i % 28) + 1).padStart(2, '0');
    const km = 60 + ((i * 37) % 120);
    const endH = 17 + (i % 6);
    const overnight = i % 9 === 0;
    return {
      id: `p${i}`, dutyDate: `2025-01-${day}`, vehicleRegNo: i % 2 ? `DL01AB00${String(i).padStart(2, '0')}` : `0${i}12`, vehicleCategoryId: null,
      vehicleCategoryName: i % 3 ? 'Sample Sedan' : 'Sample SUV', dutyTypeCode: 'LOCAL', startKm: String(10000 + i * 300), endKm: String(10000 + i * 300 + km),
      startAt: `2025-01-${day} 09:00`, endAt: overnight ? `2025-01-${String((i % 28) + 2).padStart(2, '0')} 01:30` : `2025-01-${day} ${endH}:15`,
      toll: i % 4 === 0 ? '120' : null, parking: i % 5 === 0 ? '50' : null, otherCharges: null, driverName: `Sample Driver ${i % 7}`, fieldOfficer: `Officer ${i % 5}`, remarks: '',
    };
  });
  const output = calculateBill({
    periodStart: '2025-01-01', periodEnd: '2025-01-31', duties,
    schemes: [{ id: 'preview', schemeId: 'preview', schemeName: 'Preview', versionNo: 1, status: 'approved', effectiveFrom: '2000-01-01', effectiveTo: null, vehicleCategoryIds: [], dutyTypeCodes: [], config: cfg }],
    taxRules: [
      { id: 'pc', name: 'CGST (sample)', taxType: 'CGST', rate: '2.5', effectiveFrom: '2000-01-01', effectiveTo: null, status: 'approved' },
      { id: 'ps', name: 'SGST (sample)', taxType: 'SGST', rate: '2.5', effectiveFrom: '2000-01-01', effectiveTo: null, status: 'approved' },
    ],
    settings: { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'nearest_rupee' },
  });
  return {
    bill: { billNo: 'PREVIEW/2025-01/001', billDate: '2025-02-01', periodStart: '2025-01-01', periodEnd: '2025-01-31', revisionNo: 0 },
    client: { name: 'SAMPLE DEPARTMENT (preview data)', billing_address: 'Sample address line, New Delhi 110001', gstin: '07AAAAA0000A1Z5', pan: null, state_name: 'Delhi', state_code: '07' },
    supplier: { name: 'LR Taxi Services Pvt. Ltd.', address: 'Supplier address (from settings)', gstin: 'SUPPLIER-GSTIN', pan: null, state_name: 'Delhi', state_code: '07', phone: null, email: null, bank_details: null },
    contract: { title: 'Sample contract', reference_no: 'SAMPLE/REF/001', po_number: 'PO-SAMPLE' },
    duties,
    output,
  };
}

export async function templateRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/templates/columns', { preHandler: perm('view') }, async () => ({ duty: DUTY_COLUMN_KEYS, line: LINE_COLUMN_KEYS, block: BLOCK_COLUMN_KEYS, defaultLayout: defaultDutyLayout(), lrStandardLayout: lrStandardLayout() }));

  app.get('/templates', { preHandler: perm('view') }, async (req) => {
    const q = req.query as { clientId?: string; contractId?: string };
    return db.query(
      `SELECT t.*, c.name AS client_name, k.reference_no AS contract_ref,
              (SELECT json_agg(json_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'has_xlsx', v.xlsx_file_id IS NOT NULL) ORDER BY v.version_no) FROM billing_template_versions v WHERE v.template_id = t.id) AS versions
       FROM billing_templates t LEFT JOIN clients c ON c.id = t.client_id LEFT JOIN contracts k ON k.id = t.contract_id
       WHERE ($1::uuid IS NULL OR t.client_id = $1) AND ($2::uuid IS NULL OR t.contract_id = $2 OR t.contract_id IS NULL) ORDER BY c.name, t.name`,
      [q.clientId || null, q.contractId || null],
    );
  });

  app.post('/templates', { preHandler: perm('template.write') }, async (req) => {
    const b = parse(z.object({
      client_id: uuid, contract_id: uuid.nullable().optional(), name: z.string().trim().min(1), description: optText,
      /** lr_standard = the LR Taxi Services merged-invoice format (letterhead box, duty blocks, totals in the table) */
      preset: z.enum(['default', 'lr_standard']).default('default'),
      /** Also switch the contract to the LR exact printed arithmetic that this format is meant to be used with. */
      lr_arithmetic: z.boolean().default(false),
    }), req.body);
    if (b.lr_arithmetic) {
      if (!b.contract_id) throw badRequest('Choose the contract whose bills should use the LR exact arithmetic');
      if (!can(req.user, 'client.write')) throw forbidden('Changing the printed arithmetic of a contract needs the contract-edit permission');
    }
    const row = await db.tx(async (t) => {
      const tpl = await t.one<{ id: string }>('INSERT INTO billing_templates(client_id, contract_id, name, description) VALUES ($1,$2,$3,$4) RETURNING *', [b.client_id, b.contract_id ?? null, b.name, b.description]);
      await t.query('INSERT INTO billing_template_versions(template_id, version_no, layout, created_by) VALUES ($1, 1, $2, $3)', [tpl!.id, b.preset === 'lr_standard' ? lrStandardLayout() : defaultDutyLayout(), req.user!.id]);
      if (b.lr_arithmetic) {
        const k = await t.one<{ client_id: string; arithmetic: string }>('SELECT client_id, arithmetic FROM contracts WHERE id = $1', [b.contract_id]);
        if (!k || k.client_id !== b.client_id) throw badRequest('That contract belongs to a different department');
        if (k.arithmetic !== 'lr_exact') {
          await t.query(`UPDATE contracts SET arithmetic = 'lr_exact', updated_at = now() WHERE id = $1`, [b.contract_id]);
          await audit(t, req.user!.id, 'contract', b.contract_id!, 'set_arithmetic', { arithmetic: k.arithmetic }, { arithmetic: 'lr_exact' });
        }
      }
      return tpl;
    });
    await audit(db, req.user!.id, 'template', row!.id, 'create', undefined, b);
    return row;
  });

  /**
   * Import a sample bill / invoice format (PDF or Excel) for a department. Creates a DRAFT template
   * version learned from it — a new template, or a new version of an existing one (template_id).
   */
  app.post('/templates/from-sample', { preHandler: perm('template.write') }, async (req, reply) => {
    const file = await req.file();
    if (!file) throw badRequest('Choose the sample bill (PDF or Excel)');
    const buf = await file.toBuffer();
    const ext = checkUpload(file.filename, buf, ['.pdf', '.xlsx', '.png', '.jpg', '.jpeg']);
    const f = Object.fromEntries(Object.entries(file.fields).map(([k, v]) => [k, (v as { value?: string })?.value || undefined]));
    const meta = parse(z.object({ client_id: uuid, contract_id: uuid.optional(), template_id: uuid.optional(), name: z.string().trim().min(1).optional(), as_new: z.enum(['true', 'false']).optional() }), f);
    const client = await db.one<{ name: string; short_code: string }>('SELECT name, short_code FROM clients WHERE id = $1', [meta.client_id]);
    if (!client) throw notFound('Department');
    if (meta.contract_id) {
      const k = await db.one<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = $1', [meta.contract_id]);
      if (!k || k.client_id !== meta.client_id) throw badRequest('The contract does not belong to this department');
    }
    const name = meta.name ?? `${client.short_code} bill format`;
    if (meta.template_id) {
      const t = await db.one<{ client_id: string }>('SELECT client_id FROM billing_templates WHERE id = $1', [meta.template_id]);
      if (!t || t.client_id !== meta.client_id) throw badRequest('That template belongs to a different department');
    } else if (meta.as_new !== 'true') {
      const same = await db.one<{ id: string; name: string }>('SELECT id, name FROM billing_templates WHERE client_id = $1 AND lower(name) = lower($2)', [meta.client_id, name]);
      if (same) return reply.status(409).send({ error: `"${same.name}" already exists for this department. Add the sample as a new version of it, or save it under another name.`, existingTemplateId: same.id });
    }
    const stored = await saveFile(db, file.filename, buf, req.user!.id);
    const sup = await db.one<{ name: string }>(meta.contract_id
      ? 'SELECT s.name FROM contracts k JOIN supplier_profiles s ON s.id = k.supplier_profile_id WHERE k.id = $1'
      : 'SELECT name FROM supplier_profiles WHERE is_default AND $1::uuid IS NULL', [meta.contract_id ?? null]);
    let learned: LearnedTemplate;
    try {
      if (ext === '.pdf') learned = learnFromPdf((await runWorker(filePath(stored))).pages, sup?.name ?? '', stored.original_name);
      else if (ext === '.xlsx') learned = await learnFromXlsx(buf, stored.original_name);
      else learned = { layout: defaultDutyLayout(), xlsxMapping: null, unmatched: [], notes: ['Images are kept as the visual reference only; design the layout in the template designer.'] };
    } catch (e) {
      throw badRequest(`Could not read the sample: ${(e as Error).message}`);
    }
    const out = await db.tx(async (t) => {
      const templateId = meta.template_id ?? (await t.one<{ id: string }>('INSERT INTO billing_templates(client_id, contract_id, name, description) VALUES ($1,$2,$3,$4) RETURNING id',
        [meta.client_id, meta.contract_id ?? null, name, `Learned from ${stored.original_name}`]))!.id;
      const v = await t.one<{ id: string; version_no: number }>(
        `INSERT INTO billing_template_versions(template_id, version_no, layout, xlsx_file_id, xlsx_mapping, reference_file_id, notes, created_by)
         VALUES ($1, (SELECT COALESCE(max(version_no),0)+1 FROM billing_template_versions WHERE template_id = $1), $2, $3, $4, $5, $6, $7) RETURNING id, version_no`,
        [templateId, learned.layout, ext === '.xlsx' ? stored.id : null, learned.xlsxMapping, stored.id, learned.notes.join(' '), req.user!.id],
      );
      await audit(t, req.user!.id, 'template_version', v!.id, 'import_sample', undefined, { file: stored.original_name, template: templateId });
      return { templateId, versionId: v!.id, versionNo: v!.version_no };
    });
    return { ...out, notes: learned.notes, unmatched: learned.unmatched };
  });

  app.get('/template-versions/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const v = await db.one(
      `SELECT v.*, t.name AS template_name, t.client_id, t.contract_id, xf.original_name AS xlsx_name, rf.original_name AS reference_name, rf.mime_type AS reference_mime, au.name AS approved_by_name
       FROM billing_template_versions v JOIN billing_templates t ON t.id = v.template_id
       LEFT JOIN files xf ON xf.id = v.xlsx_file_id LEFT JOIN files rf ON rf.id = v.reference_file_id LEFT JOIN app_users au ON au.id = v.approved_by WHERE v.id = $1`, [id]);
    if (!v) throw notFound('Template version');
    return v;
  });

  app.post('/templates/:id/versions', { preHandler: perm('template.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ fromVersionId: uuid.optional() }), req.body ?? {});
    const src = b.fromVersionId
      ? await db.one<{ layout: unknown; xlsx_file_id: string | null; xlsx_mapping: unknown; reference_file_id: string | null }>('SELECT * FROM billing_template_versions WHERE id = $1 AND template_id = $2', [b.fromVersionId, id])
      : null;
    const row = await db.one<{ id: string }>(
      `INSERT INTO billing_template_versions(template_id, version_no, layout, xlsx_file_id, xlsx_mapping, reference_file_id, created_by)
       VALUES ($1, (SELECT COALESCE(max(version_no),0)+1 FROM billing_template_versions WHERE template_id = $1), $2, $3, $4, $5, $6) RETURNING *`,
      [id, src?.layout ?? defaultDutyLayout(), src?.xlsx_file_id ?? null, src?.xlsx_mapping ?? null, src?.reference_file_id ?? null, req.user!.id],
    );
    await audit(db, req.user!.id, 'template_version', row!.id, 'create', undefined, { from: b.fromVersionId });
    return row;
  });

  const assertDraft = async (id: string) => {
    const v = await db.one<{ status: string }>('SELECT status FROM billing_template_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Template version');
    if (v.status !== 'draft') throw conflict('Approved template versions are locked. Create a new version to change the layout.');
  };

  app.put('/template-versions/:id', { preHandler: perm('template.write') }, async (req) => {
    const { id } = req.params as { id: string };
    await assertDraft(id);
    const b = parse(z.object({ layout: LayoutSchema, xlsx_mapping: XlsxMappingSchema.nullable().optional(), notes: optText }), req.body);
    const row = await db.one('UPDATE billing_template_versions SET layout=$2, xlsx_mapping=$3, notes=$4 WHERE id=$1 RETURNING *', [id, b.layout, b.xlsx_mapping ?? null, b.notes]);
    await audit(db, req.user!.id, 'template_version', id, 'update');
    return row;
  });

  /** Upload the department's Excel workbook (kind=xlsx) or a reference sample bill (kind=reference). */
  app.post('/template-versions/:id/upload/:kind', { preHandler: perm('template.write') }, async (req) => {
    const { id, kind } = req.params as { id: string; kind: string };
    if (!['xlsx', 'reference'].includes(kind)) throw notFound('Upload kind');
    await assertDraft(id);
    const file = await req.file();
    if (!file) throw badRequest('Attach a file');
    const buf = await file.toBuffer();
    checkUpload(file.filename, buf, kind === 'xlsx' ? ['.xlsx'] : ['.pdf', '.png', '.jpg', '.jpeg', '.xlsx']);
    const stored = await saveFile(db, file.filename, buf, req.user!.id);
    await db.query(`UPDATE billing_template_versions SET ${kind === 'xlsx' ? 'xlsx_file_id' : 'reference_file_id'} = $2 WHERE id = $1`, [id, stored.id]);
    await audit(db, req.user!.id, 'template_version', id, `upload_${kind}`, undefined, { file: stored.original_name, sha256: stored.sha256 });
    return { fileId: stored.id, name: stored.original_name };
  });

  /** Shows the first rows of the uploaded workbook so cells can be mapped. */
  app.get('/template-versions/:id/xlsx-cells', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const v = await db.one<{ xlsx_file_id: string | null }>('SELECT xlsx_file_id FROM billing_template_versions WHERE id = $1', [id]);
    if (!v?.xlsx_file_id) throw notFound('Uploaded workbook');
    const f = (await loadFile(db, v.xlsx_file_id))!;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(f.buf as unknown as ArrayBuffer);
    return wb.worksheets.map((ws) => {
      const rows: { row: number; cells: { addr: string; text: string }[] }[] = [];
      for (let r = 1; r <= Math.min(ws.rowCount, 60); r++) {
        const cells: { addr: string; text: string }[] = [];
        ws.getRow(r).eachCell({ includeEmpty: false }, (c) => cells.push({ addr: c.address, text: c.text }));
        if (cells.length) rows.push({ row: r, cells });
      }
      return { sheet: ws.name, rowCount: ws.rowCount, columnCount: ws.columnCount, merges: (ws.model as { merges?: string[] }).merges ?? [], rows };
    });
  });

  /** Renders the version with preview sample data, or with a real bill's snapshot (billId). */
  app.post('/template-versions/:id/preview', { preHandler: perm('view') }, async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ format: z.enum(['pdf', 'xlsx']).default('pdf'), billId: uuid.optional(), layout: LayoutSchema.optional(), xlsx_mapping: XlsxMappingSchema.nullable().optional() }), req.body ?? {});
    const v = await db.one<{ layout: unknown; xlsx_file_id: string | null; xlsx_mapping: unknown }>('SELECT * FROM billing_template_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Template version');
    const ctx = q.billId ? await loadBillContext(db, q.billId) : previewContext();
    const layout = q.layout ?? v.layout;
    const model = buildRenderModel(ctx, layout);
    if (!q.billId) model.title = `PREVIEW — SAMPLE DATA — ${model.title}`;
    let buf: Buffer;
    const mapping = q.xlsx_mapping !== undefined ? q.xlsx_mapping : (v.xlsx_mapping as z.infer<typeof XlsxMappingSchema> | null);
    if (q.format === 'xlsx') {
      if (v.xlsx_file_id && mapping) {
        const f = (await loadFile(db, v.xlsx_file_id))!;
        buf = await renderMappedXlsx(f.buf, XlsxMappingSchema.parse(mapping), model, { ...placeholders(ctx), periodLabel: model.headerFields.find((h) => h.label === 'Period')?.value ?? '' });
      } else buf = await renderBillXlsx(model);
      reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      reply.header('Content-Disposition', 'attachment; filename="template-preview.xlsx"');
    } else {
      buf = await renderPdf(model);
      reply.header('Content-Type', 'application/pdf');
      reply.header('Content-Disposition', 'inline; filename="template-preview.pdf"');
    }
    return reply.send(buf);
  });

  app.post('/template-versions/:id/approve', { preHandler: perm('template.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ previewReviewed: z.literal(true, { message: 'Confirm that you reviewed the rendered preview against the department format' }), note: optText }), req.body);
    const v = await db.one<{ status: string; created_by: string; template_id: string; layout: unknown; xlsx_file_id: string | null; xlsx_mapping: unknown }>('SELECT * FROM billing_template_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Template version');
    if (v.status !== 'draft') throw conflict(`Version is ${v.status}`);
    if ((await getSetting<boolean>(db, 'makerChecker')) && v.created_by === req.user!.id) throw forbidden('Maker-checker is enabled: another user must approve this template.');
    LayoutSchema.parse(v.layout);
    if (v.xlsx_file_id && !v.xlsx_mapping) throw badRequest('Map the uploaded workbook cells before approving, or remove the workbook.');
    const row = await db.tx(async (t) => {
      await t.query(`UPDATE billing_template_versions SET status='retired' WHERE template_id=$1 AND status='approved'`, [v.template_id]);
      const r = await t.one(`UPDATE billing_template_versions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [id, req.user!.id]);
      await t.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('template_version',$1,'approve',$2,$3)`, [id, req.user!.id, b.note]);
      await audit(t, req.user!.id, 'template_version', id, 'approve', undefined, undefined, 'Preview reviewed by approver');
      return r;
    });
    return row;
  });
}
