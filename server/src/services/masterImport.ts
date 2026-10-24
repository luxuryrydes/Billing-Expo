/**
 * Department and institution master data: one set of field definitions and
 * validation rules used by manual entry and by Excel import, so both produce
 * the same records. Import is create-or-update by a stable key (department
 * name, institution code); nothing is ever deleted because it is missing from
 * a file, and blank cells never clear existing values.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { GST_STATES } from './profile.js';

export type Entity = 'departments' | 'institutions';

export interface FieldDef {
  key: string;            // clients column
  label: string;          // column heading in templates / exports
  synonyms: string[];
  required?: boolean;
  type?: 'text' | 'gstin' | 'percent' | 'list' | 'sac';
}

export const FIELDS: Record<Entity, FieldDef[]> = {
  departments: [
    { key: 'name', label: 'Name', synonyms: ['name', 'department', 'department name', 'client', 'client name'], required: true },
    { key: 'aliases', label: 'Aliases', synonyms: ['aliases', 'alias', 'also known as', 'short names'], type: 'list' },
    { key: 'invoice_prefix', label: 'Invoice Prefix', synonyms: ['invoice prefix', 'bill prefix', 'prefix'] },
    { key: 'default_package', label: 'Default Package', synonyms: ['default package', 'package'] },
    { key: 'gst_label', label: 'GST', synonyms: ['gst', 'gst type', 'gst treatment', 'tax'] },
    { key: 'company', label: 'Company', synonyms: ['company', 'company name', 'billing name'] },
    { key: 'billing_address', label: 'Client Address', synonyms: ['client address', 'address', 'billing address'] },
    { key: 'gstin', label: 'Client GSTIN', synonyms: ['client gstin', 'gstin', 'gst no', 'gst number'], type: 'gstin' },
    { key: 'notes', label: 'Notes', synonyms: ['notes', 'remarks', 'note'] },
  ],
  institutions: [
    { key: 'code', label: 'Code', synonyms: ['code', 'institution code', 'short code'], required: true },
    { key: 'name', label: 'Name', synonyms: ['name', 'institution', 'institution name'], required: true },
    { key: 'header_title', label: 'Header Title', synonyms: ['header title', 'bill title', 'title'] },
    { key: 'header_subtitle', label: 'Header Subtitle', synonyms: ['header subtitle', 'subtitle', 'sub title'] },
    { key: 'invoice_prefix', label: 'Invoice Prefix', synonyms: ['invoice prefix', 'bill prefix', 'prefix'] },
    { key: 'gst_mode', label: 'GST Mode', synonyms: ['gst mode', 'tax mode'] },
    { key: 'cgst_rate', label: 'CGST %', synonyms: ['cgst %', 'cgst', 'cgst rate'], type: 'percent' },
    { key: 'sgst_rate', label: 'SGST %', synonyms: ['sgst %', 'sgst', 'sgst rate'], type: 'percent' },
    { key: 'igst_rate', label: 'IGST %', synonyms: ['igst %', 'igst', 'igst rate'], type: 'percent' },
    { key: 'vendor_sac', label: 'Vendor SAC', synonyms: ['vendor sac', 'sac', 'sac code'], type: 'sac' },
    { key: 'vendor_gstin', label: 'Vendor GSTIN', synonyms: ['vendor gstin', 'our gstin', 'supplier gstin'], type: 'gstin' },
    { key: 'billing_address', label: 'Client Address', synonyms: ['client address', 'address', 'billing address'] },
    { key: 'gstin', label: 'Client GSTIN', synonyms: ['client gstin', 'gstin'], type: 'gstin' },
    { key: 'duty_fields', label: 'Custom Fields', synonyms: ['custom fields', 'duty fields', 'extra fields'], type: 'list' },
    { key: 'terms', label: 'Terms', synonyms: ['terms', 'terms and conditions'] },
    { key: 'notes', label: 'Notes', synonyms: ['notes', 'remarks'] },
  ],
};

export const KEY_FIELD: Record<Entity, string> = { departments: 'name', institutions: 'code' };

export const synonymsFor = (e: Entity) => Object.fromEntries(FIELDS[e].map((f) => [f.key, f.synonyms]));

export interface RowResult {
  rowNumber: number;
  key: string;
  action: 'add' | 'update' | 'unchanged' | 'error';
  errors: string[];
  warnings: string[];
  values: Record<string, unknown>;
  changes: Record<string, { from: unknown; to: unknown }>;
  existingId?: string;
}

/** Interprets free-text GST settings such as "Split 2.5+2.5%", "18% IGST", "GST Under RCM(Invoice)". */
export function parseGstLabel(label: string): { cgst?: string; sgst?: string; igst?: string; mode?: string; warning?: string } {
  const s = label.trim();
  if (!s) return {};
  let m = /split\s*([\d.]+)\s*\+\s*([\d.]+)/i.exec(s) ?? /cgst\s*([\d.]+)\s*%?\s*\+\s*sgst\s*([\d.]+)/i.exec(s);
  if (m) return { cgst: m[1], sgst: m[2], igst: '0' };
  m = /([\d.]+)\s*%\s*igst|igst\s*@?\s*([\d.]+)/i.exec(s);
  if (m) return { igst: m[1] ?? m[2], cgst: '0', sgst: '0' };
  if (/rcm|reverse charge/i.test(s)) return { mode: 'rcm', warning: `GST "${s}" is reverse charge — the department pays the tax; check the bill format.` };
  if (/exempt|nil|^0\s*%?$/i.test(s)) return { cgst: '0', sgst: '0', igst: '0' };
  m = /([\d.]+)\s*%/.exec(s);
  if (m) return { warning: `GST "${s}" does not say whether it is IGST or CGST + SGST — set the rates on the record.` };
  return { warning: `GST "${s}" was kept as text; set the rates on the record.` };
}

const gstinOk = (g: string) => /^\d{2}[A-Z0-9]{13}$/.test(g) && !!GST_STATES[g.slice(0, 2)];

/** Normalises and validates one record (from a form or an Excel row). Shared by manual entry and import. */
export function normaliseRecord(entity: Entity, raw: Record<string, unknown>): { values: Record<string, unknown>; errors: string[]; warnings: string[] } {
  const values: Record<string, unknown> = {};
  const errors: string[] = [];
  const warnings: string[] = [];
  for (const f of FIELDS[entity]) {
    const r = raw[f.key];
    if (r === undefined) continue;
    const s = Array.isArray(r) ? r.join(', ') : String(r ?? '').trim();
    if (s === '') { if (f.required) errors.push(`${f.label} is required`); continue; }
    switch (f.type) {
      case 'gstin': {
        const g = s.toUpperCase().replace(/\s+/g, '');
        if (!gstinOk(g)) errors.push(`${f.label} "${s}" is not a valid GSTIN (15 characters starting with a state code)`);
        values[f.key] = g;
        break;
      }
      case 'percent': {
        const n = s.replace(/%/g, '').trim();
        if (!/^\d+(\.\d+)?$/.test(n) || Number(n) > 100) errors.push(`${f.label} "${s}" must be a percentage between 0 and 100`);
        values[f.key] = n;
        break;
      }
      case 'sac': {
        if (!/^\d{4,8}$/.test(s)) warnings.push(`${f.label} "${s}" does not look like a SAC code`);
        values[f.key] = s;
        break;
      }
      case 'list':
        values[f.key] = [...new Set(s.split(/[,;\n]/).map((x) => x.trim()).filter(Boolean))];
        break;
      default:
        values[f.key] = s;
    }
  }
  if (entity === 'institutions' && typeof values.code === 'string') values.code = values.code.toLowerCase();
  if (typeof values.gst_label === 'string') {
    const g = parseGstLabel(values.gst_label);
    if (g.cgst !== undefined) values.cgst_rate = g.cgst;
    if (g.sgst !== undefined) values.sgst_rate = g.sgst;
    if (g.igst !== undefined) values.igst_rate = g.igst;
    if (g.mode) values.gst_mode = g.mode;
    if (g.warning) warnings.push(g.warning);
  }
  const rates = ['cgst_rate', 'sgst_rate', 'igst_rate'].map((k) => Number(values[k] ?? 0));
  if (rates[0] > 0 && rates[2] > 0) warnings.push('Both CGST and IGST are set — only one applies to a supply');
  if (rates[0] !== rates[1] && (rates[0] > 0 || rates[1] > 0)) warnings.push('CGST and SGST differ');
  if (typeof values.gstin === 'string') {
    values.state_code = values.gstin.slice(0, 2);
    values.state_name = GST_STATES[values.gstin.slice(0, 2)] ?? null;
  }
  return { values, errors, warnings };
}

const COLUMNS = ['name', 'code', 'company', 'header_title', 'header_subtitle', 'invoice_prefix', 'default_package', 'gst_label', 'gst_mode', 'cgst_rate', 'sgst_rate', 'igst_rate',
  'vendor_sac', 'vendor_gstin', 'billing_address', 'gstin', 'state_code', 'state_name', 'terms', 'notes', 'aliases', 'duty_fields', 'extra'] as const;

const comparable = (v: unknown) => (v == null ? '' : Array.isArray(v) ? [...v].map(String).sort().join('|') : typeof v === 'object' ? JSON.stringify(v) : /^\d+(\.\d+)?$/.test(String(v)) ? String(Number(v)) : String(v));

export async function findExisting(db: Db, entity: Entity, key: string) {
  return entity === 'departments'
    ? db.one<Record<string, unknown>>(`SELECT * FROM clients WHERE kind = 'department' AND lower(name) = lower($1)`, [key])
    : db.one<Record<string, unknown>>(`SELECT * FROM clients WHERE kind = 'institution' AND lower(code) = lower($1)`, [key]);
}

/** Works out what each row would do, without writing anything. */
export async function analyseRows(db: Db, entity: Entity, rows: { rowNumber: number; raw: Record<string, unknown>; extra: Record<string, string> }[]): Promise<RowResult[]> {
  const seen = new Map<string, number>();
  const out: RowResult[] = [];
  for (const r of rows) {
    const { values, errors, warnings } = normaliseRecord(entity, r.raw);
    const key = String(values[KEY_FIELD[entity]] ?? '').trim();
    if (key) {
      const k = key.toLowerCase();
      if (seen.has(k)) errors.push(`Same ${KEY_FIELD[entity]} as row ${seen.get(k)} — each record may appear once`);
      else seen.set(k, r.rowNumber);
    }
    if (Object.keys(r.extra).length) values.extra = r.extra;
    const existing = key ? await findExisting(db, entity, key) : null;
    const changes: RowResult['changes'] = {};
    if (existing) {
      for (const [k, v] of Object.entries(values)) {
        const cur = k === 'extra' ? { ...((existing.extra as object) ?? {}), ...(v as object) } : v;
        if (comparable(existing[k]) !== comparable(cur)) changes[k] = { from: existing[k] ?? null, to: cur };
      }
    }
    out.push({
      rowNumber: r.rowNumber, key, errors, warnings, values, changes,
      existingId: existing?.id as string | undefined,
      action: errors.length ? 'error' : !existing ? 'add' : Object.keys(changes).length ? 'update' : 'unchanged',
    });
  }
  return out;
}

async function uniqueShortCode(db: Db, base: string, exceptId?: string): Promise<string> {
  const root = base.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16) || 'CLIENT';
  for (let i = 0; i < 100; i++) {
    const code = i === 0 ? root : `${root}${i + 1}`;
    const hit = await db.one<{ id: string }>('SELECT id FROM clients WHERE short_code = $1', [code]);
    if (!hit || hit.id === exceptId) return code;
  }
  throw new Error('Could not allocate a short code');
}

/** Creates or updates one record. Blank incoming values never clear existing ones. */
export async function upsertRecord(db: Db, entity: Entity, values: Record<string, unknown>, userId: string, existingId?: string, source = 'manual'): Promise<{ id: string; action: 'add' | 'update' }> {
  const kind = entity === 'departments' ? 'department' : 'institution';
  const cols = COLUMNS.filter((c) => values[c] !== undefined);
  const val = (c: string) => (c === 'extra' ? JSON.stringify(values[c]) : values[c]);
  if (existingId) {
    const before = await db.one<Record<string, unknown>>('SELECT * FROM clients WHERE id = $1', [existingId]);
    const sets = cols.map((c, i) => (c === 'aliases' || c === 'duty_fields' ? `${c} = $${i + 2}::text[]` : c === 'extra' ? `extra = extra || $${i + 2}::jsonb` : `${c} = $${i + 2}`));
    await db.query(`UPDATE clients SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, [existingId, ...cols.map(val)]);
    const after = await db.one('SELECT * FROM clients WHERE id = $1', [existingId]);
    await audit(db, userId, 'client', existingId, source === 'manual' ? 'update' : 'import_update', before, after);
    return { id: existingId, action: 'update' };
  }
  const shortCode = await uniqueShortCode(db, String(values.code ?? values.name));
  const allCols = ['kind', 'short_code', ...cols];
  const params = [kind, shortCode, ...cols.map(val)];
  const placeholders = allCols.map((c, i) => (c === 'aliases' || c === 'duty_fields' ? `$${i + 1}::text[]` : c === 'extra' ? `$${i + 1}::jsonb` : `$${i + 1}`));
  const row = await db.one<{ id: string }>(`INSERT INTO clients(${allCols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING id`, params);
  if (values.aliases === undefined) await db.query('UPDATE clients SET aliases = ARRAY[$2]::text[] WHERE id = $1', [row!.id, shortCode]);
  await audit(db, userId, 'client', row!.id, source === 'manual' ? 'create' : 'import_create', undefined, values);
  return { id: row!.id, action: 'add' };
}
