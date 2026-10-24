import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, decimalStr, forbidden, isoDate, notFound, optDecimal, optText, parse, uuid } from '../lib/http.js';
import { getSetting } from './master.js';

const ClientSchema = z.object({
  name: z.string().trim().min(1),
  short_code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase().replace(/\s+/g, '')),
  billing_address: z.string().default(''),
  gstin: optText,
  pan: optText,
  state_name: optText,
  state_code: optText,
  contact_name: optText,
  contact_email: optText,
  contact_phone: optText,
  special_instructions: optText,
  status: z.enum(['active', 'inactive']).default('active'),
  /** Codes this department is known by on shared duty sheets, e.g. DRI */
  aliases: z.array(z.string().trim().min(1)).default([]),
});

const CustomFieldSchema = z.object({
  key: z.string().regex(/^[a-z][a-z0-9_]*$/),
  label: z.string().min(1),
  type: z.enum(['number', 'text']),
  required: z.boolean().default(false),
});

const ContractSchema = z.object({
  client_id: uuid,
  supplier_profile_id: uuid.nullable().optional(),
  title: z.string().trim().min(1),
  reference_no: z.string().trim().min(1),
  po_number: optText,
  start_date: isoDate,
  end_date: isoDate.nullable().optional(),
  billing_frequency: z.enum(['monthly', 'fortnightly', 'weekly', 'daily', 'per_trip']).default('monthly'),
  status: z.enum(['draft', 'active', 'expired', 'terminated']).default('draft'),
  tax_mode: z.enum(['exclusive', 'inclusive']).default('exclusive'),
  tax_level: z.enum(['document', 'line']).default('document'),
  invoice_rounding: z.enum(['none', 'nearest_rupee', 'up_rupee', 'down_rupee']).default('none'),
  approval_levels: z.union([z.literal(1), z.literal(2)]).default(1),
  bill_no_format: z.string().min(1).default('{CLIENT}/{YYYY}-{MM}/{SEQ}'),
  bid_no: optText,
  sac_code: optText,
  contract_value: optDecimal,
  required_formats: optText,
  special_instructions: optText,
  validation: z
    .object({
      mandatoryFields: z.array(z.string()).optional(),
      maxKmPerDuty: z.number().positive().optional(),
      maxHoursPerDuty: z.number().positive().optional(),
      requireExpenseEvidence: z.boolean().optional(),
      hardErrorCodes: z.array(z.string()).optional(),
    })
    .default({}),
  custom_fields: z.array(CustomFieldSchema).default([]),
});

const TaxRuleSchema = z.object({
  name: z.string().trim().min(1),
  tax_type: z.enum(['CGST', 'SGST', 'IGST', 'UTGST', 'CESS', 'OTHER']),
  rate: decimalStr,
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  source_ref: optText,
});

export async function clientRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/clients', { preHandler: perm('view') }, async (req) => {
    const q = (req.query as { q?: string }).q || null;
    return db.query(
      `SELECT c.*, (SELECT count(*)::int FROM contracts k WHERE k.client_id = c.id) AS contract_count,
              (SELECT count(*)::int FROM contracts k WHERE k.client_id = c.id AND k.status = 'active') AS active_contracts
       FROM clients c WHERE ($1::text IS NULL OR c.name ILIKE '%'||$1||'%' OR c.short_code ILIKE '%'||$1||'%') ORDER BY c.name`,
      [q],
    );
  });
  app.get('/clients/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const c = await db.one('SELECT * FROM clients WHERE id = $1', [id]);
    if (!c) throw notFound('Client');
    const contracts = await db.query('SELECT * FROM contracts WHERE client_id = $1 ORDER BY start_date DESC', [id]);
    return { ...c, contracts };
  });
  app.post('/clients', { preHandler: perm('client.write') }, async (req) => {
    const b = parse(ClientSchema, req.body);
    const row = await db.one<{ id: string }>(
      `INSERT INTO clients(name, short_code, billing_address, gstin, pan, state_name, state_code, contact_name, contact_email, contact_phone, special_instructions, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [b.name, b.short_code, b.billing_address, b.gstin, b.pan, b.state_name, b.state_code, b.contact_name, b.contact_email, b.contact_phone, b.special_instructions, b.status],
    );
    await db.query('UPDATE clients SET aliases = $2::text[] WHERE id = $1', [row!.id, b.aliases.map((x) => x.toUpperCase())]);
    await audit(db, req.user!.id, 'client', row!.id, 'create', undefined, b);
    return row;
  });
  app.put('/clients/:id', { preHandler: perm('client.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(ClientSchema, req.body);
    const before = await db.one('SELECT * FROM clients WHERE id = $1', [id]);
    if (!before) throw notFound('Client');
    const row = await db.one(
      `UPDATE clients SET name=$2, short_code=$3, billing_address=$4, gstin=$5, pan=$6, state_name=$7, state_code=$8, contact_name=$9, contact_email=$10, contact_phone=$11, special_instructions=$12, status=$13, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, b.name, b.short_code, b.billing_address, b.gstin, b.pan, b.state_name, b.state_code, b.contact_name, b.contact_email, b.contact_phone, b.special_instructions, b.status],
    );
    await db.query('UPDATE clients SET aliases = $2::text[] WHERE id = $1', [id, b.aliases.map((x) => x.toUpperCase())]);
    await audit(db, req.user!.id, 'client', id, 'update', before, row);
    return row;
  });

  // Contracts --------------------------------------------------------------
  app.get('/contracts', { preHandler: perm('view') }, async (req) => {
    const q = req.query as { clientId?: string; status?: string };
    return db.query(
      `SELECT k.*, c.name AS client_name, c.short_code AS client_code FROM contracts k JOIN clients c ON c.id = k.client_id
       WHERE ($1::uuid IS NULL OR k.client_id = $1) AND ($2::text IS NULL OR k.status = $2) ORDER BY c.name, k.start_date DESC`,
      [q.clientId || null, q.status || null],
    );
  });
  app.get('/contracts/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const k = await db.one(
      `SELECT k.*, c.name AS client_name, c.short_code AS client_code FROM contracts k JOIN clients c ON c.id = k.client_id WHERE k.id = $1`,
      [id],
    );
    if (!k) throw notFound('Contract');
    const [taxRules, schemes, documents, templates] = await Promise.all([
      db.query('SELECT t.*, u.name AS approved_by_name FROM tax_rules t LEFT JOIN app_users u ON u.id = t.approved_by WHERE contract_id = $1 ORDER BY effective_from DESC, name', [id]),
      db.query(
        `SELECT s.*, (SELECT json_agg(json_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'effective_from', v.effective_from, 'effective_to', v.effective_to) ORDER BY v.version_no)
                FROM rate_scheme_versions v WHERE v.scheme_id = s.id) AS versions
         FROM rate_schemes s WHERE s.contract_id = $1 ORDER BY s.name`,
        [id],
      ),
      db.query(
        `SELECT d.*, (SELECT max(version_no) FROM document_versions v WHERE v.document_id = d.id) AS latest_version FROM documents d WHERE d.contract_id = $1 ORDER BY d.created_at DESC`,
        [id],
      ),
      db.query('SELECT * FROM billing_templates WHERE contract_id = $1 OR (contract_id IS NULL AND client_id = (SELECT client_id FROM contracts WHERE id = $1))', [id]),
    ]);
    return { ...k, taxRules, schemes, documents, templates };
  });
  app.post('/contracts', { preHandler: perm('client.write') }, async (req) => {
    const b = parse(ContractSchema, req.body);
    const row = await db.one<{ id: string }>(
      `INSERT INTO contracts(client_id, supplier_profile_id, title, reference_no, po_number, start_date, end_date, billing_frequency, status, tax_mode, tax_level,
         invoice_rounding, approval_levels, bill_no_format, required_formats, special_instructions, validation, custom_fields)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
      [b.client_id, b.supplier_profile_id ?? null, b.title, b.reference_no, b.po_number, b.start_date, b.end_date ?? null, b.billing_frequency, b.status, b.tax_mode, b.tax_level,
        b.invoice_rounding, b.approval_levels, b.bill_no_format, b.required_formats, b.special_instructions, b.validation, JSON.stringify(b.custom_fields)],
    );
    await db.query('UPDATE contracts SET bid_no = $2, sac_code = $3, contract_value = $4 WHERE id = $1', [row!.id, b.bid_no, b.sac_code, b.contract_value]);
    await audit(db, req.user!.id, 'contract', row!.id, 'create', undefined, b);
    return row;
  });
  app.put('/contracts/:id', { preHandler: perm('client.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(ContractSchema, req.body);
    const before = await db.one('SELECT * FROM contracts WHERE id = $1', [id]);
    if (!before) throw notFound('Contract');
    const row = await db.one(
      `UPDATE contracts SET client_id=$2, supplier_profile_id=$3, title=$4, reference_no=$5, po_number=$6, start_date=$7, end_date=$8, billing_frequency=$9, status=$10,
         tax_mode=$11, tax_level=$12, invoice_rounding=$13, approval_levels=$14, bill_no_format=$15, required_formats=$16, special_instructions=$17, validation=$18, custom_fields=$19, updated_at=now()
       WHERE id=$1 RETURNING *`,
      [id, b.client_id, b.supplier_profile_id ?? null, b.title, b.reference_no, b.po_number, b.start_date, b.end_date ?? null, b.billing_frequency, b.status,
        b.tax_mode, b.tax_level, b.invoice_rounding, b.approval_levels, b.bill_no_format, b.required_formats, b.special_instructions, b.validation, JSON.stringify(b.custom_fields)],
    );
    await db.query('UPDATE contracts SET bid_no = $2, sac_code = $3, contract_value = $4 WHERE id = $1', [id, b.bid_no, b.sac_code, b.contract_value]);
    await audit(db, req.user!.id, 'contract', id, 'update', before, row);
    return row;
  });

  // Tax rules ---------------------------------------------------------------
  app.post('/contracts/:id/tax-rules', { preHandler: perm('tax.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(TaxRuleSchema, req.body);
    const row = await db.one<{ id: string }>(
      `INSERT INTO tax_rules(contract_id, name, tax_type, rate, effective_from, effective_to, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [id, b.name, b.tax_type, b.rate, b.effective_from, b.effective_to ?? null, b.source_ref, req.user!.id],
    );
    await audit(db, req.user!.id, 'tax_rule', row!.id, 'create', undefined, b);
    return row;
  });
  app.put('/tax-rules/:id', { preHandler: perm('tax.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(TaxRuleSchema, req.body);
    const before = await db.one<{ status: string }>('SELECT * FROM tax_rules WHERE id = $1', [id]);
    if (!before) throw notFound('Tax rule');
    if (before.status === 'approved') throw conflict('Approved tax rules cannot be edited. Retire it and create a new rule.');
    const row = await db.one(
      `UPDATE tax_rules SET name=$2, tax_type=$3, rate=$4, effective_from=$5, effective_to=$6, source_ref=$7 WHERE id=$1 RETURNING *`,
      [id, b.name, b.tax_type, b.rate, b.effective_from, b.effective_to ?? null, b.source_ref],
    );
    await audit(db, req.user!.id, 'tax_rule', id, 'update', before, row);
    return row;
  });
  app.post('/tax-rules/:id/approve', { preHandler: perm('tax.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const r = await db.one<{ status: string; created_by: string; source_ref: string | null }>('SELECT * FROM tax_rules WHERE id = $1', [id]);
    if (!r) throw notFound('Tax rule');
    if (r.status !== 'draft') throw conflict(`Tax rule is already ${r.status}`);
    if (!r.source_ref) throw badRequest('Record the contract clause or authority for this tax treatment (source reference) before approving.');
    if ((await getSetting<boolean>(db, 'makerChecker')) && r.created_by === req.user!.id) throw forbidden('Maker-checker is enabled: another user must approve this tax rule.');
    const row = await db.one(`UPDATE tax_rules SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [id, req.user!.id]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id) VALUES ('tax_rule',$1,'approve',$2)`, [id, req.user!.id]);
    await audit(db, req.user!.id, 'tax_rule', id, 'approve', r, row);
    return row;
  });
  app.post('/tax-rules/:id/retire', { preHandler: perm('tax.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ effective_to: isoDate.optional() }), req.body ?? {});
    const before = await db.one('SELECT * FROM tax_rules WHERE id = $1', [id]);
    if (!before) throw notFound('Tax rule');
    const row = b.effective_to
      ? await db.one(`UPDATE tax_rules SET effective_to=$2 WHERE id=$1 RETURNING *`, [id, b.effective_to])
      : await db.one(`UPDATE tax_rules SET status='retired' WHERE id=$1 RETURNING *`, [id]);
    await audit(db, req.user!.id, 'tax_rule', id, 'retire', before, row);
    return row;
  });
}
