/**
 * Rate-card import for a contract. Rows from Excel/CSV (any column layout,
 * mapped by the user) or from a PDF rate table are normalised, compared with
 * the rates currently approved for the same vehicle category and duty type,
 * and turned into NEW DRAFT rate versions only where something changed.
 * Approved versions are never edited, and bills keep their calculation
 * snapshots, so history is preserved.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { ComponentSchema, RateConfigSchema, type RateConfig } from '../engine/types.js';
import { addDays } from '../engine/time.js';
import { isoDate } from './onboarding.js';
import type { RateRow } from './profile.js';

export const RATE_FIELDS: { key: string; label: string; synonyms: string[] }[] = [
  { key: 'category', label: 'Vehicle category / model', synonyms: ['vehicle category', 'category', 'vehicle type', 'vehicle', 'make and model of the vehicle', 'make and model', 'model', 'car type'] },
  { key: 'dutyType', label: 'Package / service type', synonyms: ['package', 'service type', 'duty type', 'package type', 'service', 'package name'] },
  { key: 'hours', label: 'Included hours', synonyms: ['included hours', 'package hours', 'hours', 'hrs'] },
  { key: 'km', label: 'Included km', synonyms: ['included km', 'package km', 'kms', 'km'] },
  { key: 'packageRate', label: 'Package / daily rate', synonyms: ['package rate', 'daily rate', 'base rate', 'duty rate', 'rate per day', 'per day', 'rate'] },
  { key: 'monthlyRate', label: 'Monthly package rate', synonyms: ['monthly rate', 'monthly package rate', 'monthly package', 'per month', 'monthly charges'] },
  { key: 'monthlyKm', label: 'Monthly km limit', synonyms: ['monthly km limit', 'monthly km', 'km per month', 'km limit'] },
  { key: 'monthlyHours', label: 'Monthly duty-hour limit', synonyms: ['monthly duty hours', 'monthly hours', 'hours per month', 'hour limit'] },
  { key: 'perKm', label: 'Per-km rate (all km)', synonyms: ['per km rate', 'rate per km', 'per km'] },
  { key: 'perHour', label: 'Per-hour rate (all hours)', synonyms: ['per hour rate', 'rate per hour', 'per hour'] },
  { key: 'transferRate', label: 'Airport / transfer rate', synonyms: ['airport transfer', 'airport', 'transfer rate', 'transfer', 'pickup drop'] },
  { key: 'extraKm', label: 'Extra km rate', synonyms: ['extra km rate', 'extra km', 'extra per km', 'additional km', 'extra kms'] },
  { key: 'extraHour', label: 'Extra hour rate', synonyms: ['extra hour rate', 'extra hour', 'extra hr', 'extra hrs', 'extra per hour', 'additional hour'] },
  { key: 'night', label: 'Night charge', synonyms: ['night charge', 'night charges', 'night halt', 'night'] },
  { key: 'effectiveFrom', label: 'Effective from', synonyms: ['effective from', 'w e f', 'wef', 'valid from', 'from date'] },
  { key: 'effectiveTo', label: 'Effective to', synonyms: ['effective to', 'valid till', 'valid to', 'to date'] },
];
export const RATE_SYNONYMS = Object.fromEntries(RATE_FIELDS.map((f) => [f.key, f.synonyms]));
const NUMERIC = ['hours', 'km', 'packageRate', 'monthlyRate', 'monthlyKm', 'monthlyHours', 'perKm', 'perHour', 'transferRate', 'extraKm', 'extraHour', 'night'];

export interface IncomingRate { rowNumber: number; category: string; dutyType: string; values: Record<string, string>; effectiveFrom?: string; effectiveTo?: string; source: string }

export interface RateOptions { effectiveFrom: string; hourRoundingMode: 'exact' | 'ceil' | 'floor' | 'nearest'; hourRoundingUnit: string; nightStart: string; nightEnd: string }

export interface RateRowResult {
  rowNumber: number;
  category: string;
  /** Configured category name when the sheet used an alias ("Innova" → "SUV AC") */
  categoryName: string;
  categoryId: string | null;
  newCategory: boolean;
  dutyTypeCode: string;
  dutyTypeName: string;
  newDutyType: boolean;
  model: RateConfig['billingModel'];
  action: 'add' | 'update' | 'unchanged' | 'error';
  errors: string[];
  warnings: string[];
  effectiveFrom: string;
  effectiveTo: string | null;
  existing: { versionId: string; versionNo: number; status: string; effectiveFrom: string; values: Record<string, string> } | null;
  incoming: Record<string, string>;
  changes: Record<string, { from: string | null; to: string }>;
  schemeId: string | null;
}

const num = (s: string | undefined) => {
  if (s == null) return undefined;
  const t = s.replace(/[,₹\s]/g, '').replace(/^rs\.?/i, '').replace(/\/-$/, '');
  return /^\d+(\.\d+)?$/.test(t) ? String(Number(t)) : t === '' ? undefined : `invalid:${s}`;
};

/** Spreadsheet rows → incoming rates, using the user's column mapping. */
export function rowsFromSheet(rows: { rowNumber: number; cells: string[] }[], mapping: Record<string, number>): IncomingRate[] {
  const get = (cells: string[], k: string) => (mapping[k] === undefined ? undefined : (cells[mapping[k]] ?? '').trim());
  return rows.map((r) => {
    const values: Record<string, string> = {};
    for (const k of NUMERIC) { const v = num(get(r.cells, k)); if (v !== undefined) values[k] = v; }
    return {
      rowNumber: r.rowNumber, category: get(r.cells, 'category') ?? '', dutyType: get(r.cells, 'dutyType') ?? '', values,
      effectiveFrom: isoDate(get(r.cells, 'effectiveFrom')) || undefined, effectiveTo: isoDate(get(r.cells, 'effectiveTo')) || undefined, source: `row ${r.rowNumber}`,
    };
  }).filter((r) => r.category || Object.keys(r.values).length);
}

/** PDF rate tables (as on the DRI rate schedule) → incoming rates: one row per package, plus outstation. */
export function rowsFromRateTables(tables: RateRow[]): IncomingRate[] {
  const out: IncomingRate[] = [];
  let n = 0;
  for (const t of tables) {
    const base = { extraKm: t.extraKm?.value, extraHour: t.extraHour?.value, night: t.nightLocal?.value };
    for (const p of t.packages) {
      out.push({ rowNumber: ++n, category: t.category, dutyType: '', source: p.rate.text, values: clean({ hours: p.hours, km: p.km, packageRate: p.rate.value, ...base }) });
    }
    const top = [...t.packages].sort((a, b) => Number(b.hours) - Number(a.hours))[0];
    if (top && (t.outstationExtraKm || t.outstationExtraHour)) {
      out.push({ rowNumber: ++n, category: t.category, dutyType: 'OUTSTATION', source: `${t.description} — outstation`,
        values: clean({ hours: top.hours, km: top.km, packageRate: top.rate.value, extraKm: t.outstationExtraKm?.value, extraHour: t.outstationExtraHour?.value, night: t.nightOutstation?.value }) });
    }
  }
  return out;
}
const clean = (o: Record<string, string | undefined>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== '')) as Record<string, string>;

/** The numbers a config carries, in the same vocabulary as an incoming row (for side-by-side comparison). */
export function configValues(c: RateConfig): Record<string, string> {
  const v: Record<string, string> = {};
  const rate = (code: string) => c.components.find((x) => x.code === code)?.rate;
  const set = (k: string, x: string | undefined) => { if (x !== undefined && x !== null) v[k] = String(Number(x)); };
  if (Number(c.params.includedHours)) set('hours', c.params.includedHours);
  if (Number(c.params.includedKm)) set('km', c.params.includedKm);
  set('packageRate', rate('BASE'));
  set('monthlyRate', rate('MONTHLY'));
  if (Number(c.params.monthlyIncludedKm)) set('monthlyKm', c.params.monthlyIncludedKm);
  if (Number(c.params.monthlyIncludedHours)) set('monthlyHours', c.params.monthlyIncludedHours);
  set('perKm', rate('KM'));
  set('perHour', rate('HR'));
  set('transferRate', rate('TRANSFER'));
  set('extraKm', rate('EXKM') ?? rate('MXKM'));
  set('extraHour', rate('EXHR') ?? rate('MXHR'));
  set('night', rate('NIGHT'));
  return v;
}

function modelOf(v: Record<string, string>): RateConfig['billingModel'] {
  if (v.monthlyRate) return v.monthlyKm || v.monthlyHours ? 'monthly_limit' : 'monthly_package';
  if (v.transferRate && !v.packageRate) return 'fixed_trip';
  if ((v.perKm || v.perHour) && !v.packageRate) return 'hourly_km';
  return 'daily_package';
}

/** Builds a config: starts from the current approved config (keeping its rounding, night window, extra components) and applies the incoming numbers. */
export function buildConfig(v: Record<string, string>, base: RateConfig | null, o: RateOptions): RateConfig {
  const model = modelOf(v);
  const cfg: RateConfig = base ? structuredClone(base) : RateConfigSchema.parse({
    billingModel: model,
    params: { hourRounding: { mode: o.hourRoundingMode, unit: o.hourRoundingUnit }, night: { enabled: !!v.night, start: o.nightStart, end: o.nightEnd, minOverlapMinutes: 1, countMode: 'per_night' } },
    components: [
      { code: 'TOLL', label: 'Toll Tax', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
      { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
    ],
  });
  cfg.billingModel = model;
  if (v.hours) cfg.params.includedHours = v.hours;
  if (v.km) cfg.params.includedKm = v.km;
  if (v.monthlyKm) cfg.params.monthlyIncludedKm = v.monthlyKm;
  if (v.monthlyHours) cfg.params.monthlyIncludedHours = v.monthlyHours;
  if (v.night) cfg.params.night.enabled = true;
  const upsert = (code: string, rate: string | undefined, def: Record<string, unknown>) => {
    if (rate === undefined) return;
    const c = cfg.components.find((x) => x.code === code);
    if (c) c.rate = rate;
    else cfg.components.splice(Math.max(0, cfg.components.findIndex((x) => x.kind === 'reimbursement')), 0, ComponentSchema.parse({ code, rate, taxCategory: 'taxable', clauseRef: 'Rate card import', ...def }));
  };
  upsert('BASE', v.packageRate, { label: v.hours ? `Upto ${v.km ?? '0'} kms / ${v.hours} hrs duty` : 'Base duty charge', quantityExpr: '1', unit: 'duty' });
  upsert('TRANSFER', v.transferRate, { label: 'Transfer', quantityExpr: '1', unit: 'trip' });
  upsert('KM', v.perKm, { label: 'Kilometre charge', quantityExpr: 'billable_km', unit: 'km' });
  upsert('HR', v.perHour, { label: 'Hourly charge', quantityExpr: 'billable_hours', unit: 'hr' });
  if (model === 'monthly_package' || model === 'monthly_limit') {
    upsert('MONTHLY', v.monthlyRate, { label: 'Monthly hire charge', scope: 'vehicle_period', quantityExpr: '1', unit: 'month' });
    upsert('MXKM', v.extraKm, { label: 'Km beyond monthly limit', scope: 'vehicle_period', quantityExpr: 'max(0, total_km - monthly_included_km)', unit: 'km' });
    upsert('MXHR', v.extraHour, { label: 'Hours beyond monthly limit', scope: 'vehicle_period', quantityExpr: 'max(0, total_hours - monthly_included_hours)', unit: 'hr' });
  } else {
    upsert('EXKM', v.extraKm, { label: 'Extra Kms', quantityExpr: 'extra_km', unit: 'km' });
    upsert('EXHR', v.extraHour, { label: 'Extra Hrs', quantityExpr: 'extra_hours', unit: 'hr' });
  }
  upsert('NIGHT', v.night, { label: 'Night Charges', quantityExpr: 'night_count', unit: 'night' });
  return RateConfigSchema.parse(cfg);
}

const dutyCode = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20);

export async function analyseRates(db: Db, contractId: string, incoming: IncomingRate[], o: RateOptions): Promise<RateRowResult[]> {
  const contract = await db.one<{ start_date: string; end_date: string | null }>('SELECT start_date, end_date FROM contracts WHERE id = $1', [contractId]);
  if (!contract) throw new Error('Contract not found');
  const cats = await db.query<{ id: string; name: string; aliases: string[] }>('SELECT id, name, aliases FROM vehicle_categories');
  const types = await db.query<{ code: string; name: string }>('SELECT code, name FROM duty_types');
  const norm = (s: string) => s.toLowerCase().replace(/[\s.-]+/g, '');
  const catOf = (s: string) => cats.find((c) => norm(c.name) === norm(s) || (c.aliases ?? []).some((a) => norm(a) === norm(s)));
  // Largest package per category is the ordinary local duty; others get their own duty type (same rule as document set-up).
  const maxHours = new Map<string, number>();
  for (const r of incoming) if (r.values.hours) maxHours.set(norm(r.category), Math.max(maxHours.get(norm(r.category)) ?? 0, Number(r.values.hours)));
  const versions = await db.query<{ id: string; scheme_id: string; version_no: number; status: string; effective_from: string; effective_to: string | null; vehicle_category_ids: string[]; duty_type_codes: string[]; config: unknown }>(
    `SELECT v.* FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id WHERE s.contract_id = $1 AND v.status IN ('approved','pending_approval','draft') ORDER BY v.version_no DESC`, [contractId]);
  const seen = new Map<string, number>();
  const out: RateRowResult[] = [];
  for (const r of incoming) {
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const [k, v] of Object.entries(r.values)) if (v.startsWith('invalid:')) errors.push(`${RATE_FIELDS.find((f) => f.key === k)?.label}: "${v.slice(8)}" is not a number`);
    const values = Object.fromEntries(Object.entries(r.values).filter(([, v]) => !v.startsWith('invalid:')));
    if (!r.category) errors.push('Vehicle category is missing');
    if (!values.packageRate && !values.monthlyRate && !values.perKm && !values.perHour && !values.transferRate) errors.push('No rate on this row (package, monthly, per-km, per-hour or transfer)');
    const cat = r.category ? catOf(r.category) : undefined;
    if (r.category && !cat) warnings.push(`New vehicle category "${r.category}" will be created`);
    const model = modelOf(values);
    let code = '';
    let name = '';
    if (r.dutyType) {
      const t = types.find((x) => x.code.toLowerCase() === r.dutyType.toLowerCase() || x.name.toLowerCase() === r.dutyType.toLowerCase());
      code = t?.code ?? dutyCode(r.dutyType);
      name = t?.name ?? r.dutyType;
    } else if (model === 'monthly_package' || model === 'monthly_limit') { code = 'MONTHLY'; name = 'Monthly hire'; }
    else if (model === 'fixed_trip') { code = 'AIRPORT'; name = 'Airport transfer'; }
    else if (values.hours && Number(values.hours) < (maxHours.get(norm(r.category)) ?? 0)) { code = `LOCAL_${values.hours}H`; name = `Local ${values.hours} hrs / ${values.km ?? '?'} km`; }
    else { code = 'LOCAL'; name = values.hours ? `Local duty (${values.hours} hrs / ${values.km ?? '?'} km)` : 'Local duty'; }
    const newDutyType = !types.some((t) => t.code === code);
    const key = `${norm(r.category)}|${code}`;
    if (seen.has(key)) errors.push(`Same vehicle category and package as row ${seen.get(key)}`);
    else seen.set(key, r.rowNumber);
    const effectiveFrom = r.effectiveFrom ?? o.effectiveFrom;
    const effectiveTo = r.effectiveTo ?? contract.end_date;
    if (effectiveFrom < contract.start_date) errors.push(`Effective from ${effectiveFrom} is before the contract start ${contract.start_date}`);
    if (contract.end_date && effectiveFrom > contract.end_date) errors.push(`Effective from ${effectiveFrom} is after the contract end ${contract.end_date}`);
    const matches = cat ? versions.filter((v) => (v.vehicle_category_ids ?? []).length === 1 && v.vehicle_category_ids[0] === cat.id && (v.duty_type_codes ?? []).length === 1 && v.duty_type_codes[0] === code) : [];
    const current = matches.find((v) => v.status === 'approved' && v.effective_from <= effectiveFrom && (!v.effective_to || v.effective_to >= effectiveFrom))
      ?? matches.find((v) => v.status === 'approved') ?? matches[0] ?? null;
    const existingVals = current ? configValues(RateConfigSchema.parse(current.config)) : null;
    const changes: RateRowResult['changes'] = {};
    for (const [k, v] of Object.entries(values)) if ((existingVals?.[k] ?? null) !== v) changes[k] = { from: existingVals?.[k] ?? null, to: v };
    if (current && current.status === 'approved' && Object.keys(changes).length && effectiveFrom <= current.effective_from) {
      errors.push(`The approved rates (v${current.version_no}) start ${current.effective_from}. New rates need a later effective date so earlier duties and bills keep their rates.`);
    }
    if (current && current.status !== 'approved') warnings.push(`An unapproved version v${current.version_no} (${current.status.replace('_', ' ')}) already exists for this rate; a newer draft will be added.`);
    out.push({
      rowNumber: r.rowNumber, category: r.category, categoryName: cat?.name ?? r.category, categoryId: cat?.id ?? null, newCategory: !!r.category && !cat, dutyTypeCode: code, dutyTypeName: name, newDutyType, model,
      action: errors.length ? 'error' : !current ? 'add' : Object.keys(changes).length ? 'update' : 'unchanged',
      errors, warnings, effectiveFrom, effectiveTo: effectiveTo ?? null,
      existing: current ? { versionId: current.id, versionNo: current.version_no, status: current.status, effectiveFrom: current.effective_from, values: existingVals! } : null,
      incoming: values, changes, schemeId: current?.scheme_id ?? null,
    });
  }
  return out;
}

/** Writes new draft rate versions for the rows that add or change rates. Runs inside the caller's transaction. */
export async function applyRates(db: Db, contractId: string, results: RateRowResult[], o: RateOptions, userId: string, submit: boolean) {
  const created: { versionId: string; schemeName: string; rowNumber: number }[] = [];
  for (const r of results.filter((x) => x.action === 'add' || x.action === 'update')) {
    let catId = r.categoryId;
    if (!catId) {
      const c = await db.one<{ id: string }>('INSERT INTO vehicle_categories(name, aliases) VALUES ($1, $2::text[]) RETURNING id', [r.category, [r.category]]);
      catId = c!.id;
    }
    if (r.newDutyType) await db.query('INSERT INTO duty_types(code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [r.dutyTypeCode, r.dutyTypeName]);
    let schemeId = r.schemeId;
    let schemeName = '';
    let base: RateConfig | null = null;
    if (schemeId) {
      schemeName = (await db.one<{ name: string }>('SELECT name FROM rate_schemes WHERE id = $1', [schemeId]))!.name;
      base = RateConfigSchema.parse((await db.one<{ config: unknown }>('SELECT config FROM rate_scheme_versions WHERE id = $1', [r.existing!.versionId]))!.config);
    } else {
      schemeName = `${r.categoryName} — ${r.dutyTypeName}`;
      const ex = await db.one<{ id: string }>('SELECT id FROM rate_schemes WHERE contract_id = $1 AND name = $2', [contractId, schemeName]);
      schemeId = ex?.id ?? (await db.one<{ id: string }>('INSERT INTO rate_schemes(contract_id, name, description) VALUES ($1,$2,$3) RETURNING id', [contractId, schemeName, 'Created by rate-card import']))!.id;
    }
    const cfg = buildConfig(r.incoming, base, o);
    const v = await db.one<{ id: string }>(
      `INSERT INTO rate_scheme_versions(scheme_id, version_no, status, effective_from, effective_to, vehicle_category_ids, duty_type_codes, config, clause_ref, notes, created_by, submitted_by)
       VALUES ($1, (SELECT COALESCE(max(version_no),0)+1 FROM rate_scheme_versions WHERE scheme_id = $1), $2, $3, $4, $5::uuid[], $6::text[], $7, $8, $9, $10, $11) RETURNING id`,
      [schemeId, submit ? 'pending_approval' : 'draft', r.effectiveFrom, r.effectiveTo, [catId], [r.dutyTypeCode], cfg, 'Rate card import',
        `Imported (row ${r.rowNumber})${r.existing ? `; replaces v${r.existing.versionNo} from ${r.effectiveFrom} after approval` : ''}`, userId, submit ? userId : null],
    );
    await audit(db, userId, 'rate_version', v!.id, 'import', r.existing?.values ?? undefined, r.incoming, `Rate card import row ${r.rowNumber}`);
    created.push({ versionId: v!.id, schemeName, rowNumber: r.rowNumber });
  }
  return created;
}

export const todayIso = () => addDays(new Date().toISOString().slice(0, 10), 0);
