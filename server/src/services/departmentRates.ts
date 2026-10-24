/**
 * Department rate cards.
 *
 * A rate-card row (vehicle, package, base fare, included km/hours, extra km/hour, night charge
 * and slot, driver allowance, tax) is the way the office thinks about rates. Billing runs on
 * versioned rate schemes. This module translates between the two so the Rate Card screen and
 * the Department Rate Register import/export are views over the same approved, versioned rates:
 *   - every change creates a new rate version from a chosen date (older versions stay for
 *     earlier duties; approved bills keep their snapshots),
 *   - unchanged rows are left exactly as they are,
 *   - rows missing from an upload are kept.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/http.js';
import { RateConfigSchema, type RateConfig } from '../engine/types.js';
import { addDays } from '../engine/time.js';
import { GST_STATES } from './profile.js';

export interface RateEntry {
  vehicle: string;
  package: string;
  rateType: 'per_km_hr' | 'fixed';
  baseFare: string | null;
  includedKm: string | null;
  includedHours: string | null;
  extraKm: string | null;
  extraHour: string | null;
  nightCharge: string | null;
  nightStart: string | null;
  nightEnd: string | null;
  driverAllowance: string | null;
  taxLabel: string | null;
  taxMode: string | null;          // CGST_SGST | IGST | GST | RCM | NONE | DEFAULT_UNSPECIFIED
  cgst: string | null;
  sgst: string | null;
  igst: string | null;
  gst: string | null;
  source: string | null;
  notes: string | null;
}

/** The fields that define a rate; source and notes do not count as a change. */
export const RATE_KEYS: (keyof RateEntry)[] = ['rateType', 'baseFare', 'includedKm', 'includedHours', 'extraKm', 'extraHour', 'nightCharge', 'nightStart', 'nightEnd', 'driverAllowance', 'taxMode', 'cgst', 'sgst', 'igst', 'gst'];
export const ENTRY_LABELS: Record<string, string> = {
  rateType: 'Type', baseFare: 'Base fare', includedKm: 'Included km', includedHours: 'Included hrs', extraKm: 'Extra/km', extraHour: 'Extra/hr', nightCharge: 'Night charge',
  nightStart: 'Night from', nightEnd: 'Night to', driverAllowance: 'Driver allowance/day', taxMode: 'Tax mode', cgst: 'CGST %', sgst: 'SGST %', igst: 'IGST %', gst: 'GST %',
};

const n = (v: unknown): string | null => {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).replace(/[,₹\s]/g, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? String(Number(s)) : null;
};
const t = (v: unknown): string | null => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim());
const time = (v: unknown): string | null => {
  const s = t(v);
  if (!s) return null;
  const m = /^(\d{1,2})[:.](\d{2})/.exec(s);
  return m ? `${m[1].padStart(2, '0')}:${m[2]}` : null;
};

/** Normalises a row from a form or a spreadsheet; blank stays blank (it is not ₹0). */
export function normaliseEntry(raw: Partial<Record<keyof RateEntry, unknown>>): RateEntry {
  const type = String(raw.rateType ?? '').toLowerCase();
  return {
    vehicle: t(raw.vehicle) ?? '',
    package: t(raw.package) ?? '',
    rateType: /fixed|true|yes/.test(type) ? 'fixed' : 'per_km_hr',
    baseFare: n(raw.baseFare), includedKm: n(raw.includedKm), includedHours: n(raw.includedHours), extraKm: n(raw.extraKm), extraHour: n(raw.extraHour),
    nightCharge: n(raw.nightCharge), nightStart: time(raw.nightStart), nightEnd: time(raw.nightEnd), driverAllowance: n(raw.driverAllowance),
    taxLabel: t(raw.taxLabel), taxMode: t(raw.taxMode)?.toUpperCase().replace(/[\s+]+/g, '_') ?? null,
    cgst: n(raw.cgst), sgst: n(raw.sgst), igst: n(raw.igst), gst: n(raw.gst), source: t(raw.source), notes: t(raw.notes),
  };
}

export const sameRate = (a: RateEntry, b: RateEntry) => RATE_KEYS.every((k) => (a[k] ?? null) === (b[k] ?? null) || (Number(a[k] ?? 0) === Number(b[k] ?? 0) && /^\d/.test(String(a[k] ?? '0')) && /^\d/.test(String(b[k] ?? '0')) && (a[k] === null) === (b[k] === null)));

export function changedKeys(a: RateEntry | null, b: RateEntry): string[] {
  if (!a) return [];
  return RATE_KEYS.filter((k) => {
    const x = a[k] ?? null;
    const y = b[k] ?? null;
    if (x === null || y === null) return x !== y;
    // Only plain numbers compare by value ("2400.00" = "2400"); times such as "22:00" compare as text.
    const isNum = (v: unknown) => /^-?\d+(\.\d+)?$/.test(String(v));
    return isNum(x) && isNum(y) ? Number(x) !== Number(y) : String(x) !== String(y);
  });
}

// --- package and duty type ------------------------------------------------------

/** "4:30hrs/40kms" → 4.5 h; "80 kms./8 hrs duty" → 80 km, 8 h; "Outstation 250km" → outstation. */
export function parsePackage(p: string): { km: number | null; hours: number | null; outstation: boolean } {
  const s = p.toLowerCase();
  const km = /(\d+(?:\.\d+)?)\s*k(?:m|ms)?\b\.?/.exec(s);
  const hm = /(\d+)\s*:\s*(\d{2})\s*h/.exec(s) ?? null;
  const h = hm ? null : /(\d+(?:\.\d+)?)\s*h(?:r|rs|ours?)?\b/.exec(s);
  return {
    km: km ? Number(km[1]) : null,
    hours: hm ? Number(hm[1]) + Number(hm[2]) / 60 : h ? Number(h[1]) : null,
    outstation: /out\s*station/.test(s),
  };
}

export function dutyTypeFor(e: RateEntry): { code: string; name: string } {
  const p = parsePackage(e.package);
  const hrs = p.hours ?? (Number(e.includedHours) || null);
  const km = p.km ?? (Number(e.includedKm) || null);
  const slug = e.package.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 20) || 'PACKAGE';
  if (p.outstation) return { code: `OUT_${km ?? slug}`.slice(0, 20) + (km ? 'KM' : ''), name: e.package };
  if (hrs && km) return { code: `${String(hrs).replace('.', '_')}H_${km}KM`, name: `${hrs} hrs / ${km} km` };
  return { code: slug, name: e.package };
}

// --- tax ------------------------------------------------------------------------

const REG_STATE: [RegExp, string][] = [[/delhi/i, '07'], [/\bhr\b|haryana/i, '06'], [/\bup\b|uttar/i, '09'], [/punjab|\bpb\b/i, '03'], [/maharashtra|\bmh\b/i, '27']];
export const registrationState = (reg: string | null | undefined) => (reg ? REG_STATE.find(([re]) => re.test(reg))?.[1] ?? null : null);

export interface ResolvedTax { mode: 'CGST_SGST' | 'IGST' | 'RCM' | 'NONE' | 'UNRESOLVED'; cgst: string; sgst: string; igst: string; label: string; reason?: string }

/**
 * Turns a rate's tax into the tax that applies on the bill. "GST 18%" becomes IGST 18% when our
 * billing registration is in a different state from the department, else CGST 9% + SGST 9%.
 */
export function resolveTax(e: Pick<RateEntry, 'taxMode' | 'cgst' | 'sgst' | 'igst' | 'gst' | 'taxLabel'>, clientState: string | null, supplierState: string | null): ResolvedTax {
  const mode = e.taxMode ?? '';
  const label = e.taxLabel ?? mode;
  if (mode === 'CGST_SGST' || (n(e.cgst) && !n(e.igst))) return { mode: 'CGST_SGST', cgst: n(e.cgst) ?? '0', sgst: n(e.sgst) ?? n(e.cgst) ?? '0', igst: '0', label };
  if (mode === 'IGST' || n(e.igst)) return { mode: 'IGST', cgst: '0', sgst: '0', igst: n(e.igst) ?? n(e.gst) ?? '0', label };
  if (mode === 'RCM' || /rcm|reverse/i.test(label)) return { mode: 'RCM', cgst: '0', sgst: '0', igst: '0', label, reason: 'Reverse charge: the department pays the tax' };
  if (mode === 'NONE' || /exempt|nil|no tax/i.test(label)) return { mode: 'NONE', cgst: '0', sgst: '0', igst: '0', label };
  const g = n(e.gst);
  if (g) {
    if (!clientState || !supplierState) return { mode: 'UNRESOLVED', cgst: '0', sgst: '0', igst: '0', label, reason: `GST ${g}%: IGST or CGST+SGST depends on our billing registration and the department's state${!clientState ? ' (department GSTIN not recorded)' : ' (billing registration not recorded)'}` };
    if (clientState === supplierState) return { mode: 'CGST_SGST', cgst: String(Number(g) / 2), sgst: String(Number(g) / 2), igst: '0', label, reason: `Same state (${GST_STATES[clientState] ?? clientState}): CGST + SGST` };
    return { mode: 'IGST', cgst: '0', sgst: '0', igst: g, label, reason: `Inter-state (${GST_STATES[supplierState] ?? supplierState} → ${GST_STATES[clientState] ?? clientState}): IGST` };
  }
  return { mode: 'UNRESOLVED', cgst: '0', sgst: '0', igst: '0', label, reason: 'Tax not stated on this rate' };
}

export const taxDisplay = (r: ResolvedTax) => (r.mode === 'CGST_SGST' ? `C ${r.cgst}% + S ${r.sgst}%` : r.mode === 'IGST' ? `IGST ${r.igst}%` : r.mode === 'RCM' ? 'RCM' : r.mode === 'NONE' ? 'No tax' : '—');

// --- rate entry → engine configuration -----------------------------------------------

export interface ConfigOptions { hourRoundingMode: 'exact' | 'ceil' | 'floor' | 'nearest'; hourRoundingUnit: string }

/**
 * Builds the calculation rules for one rate-card row. `siblings` are the department's other rows
 * for the same vehicle: a fixed package with a separate "extra km / hrs" row (as on the AAI card)
 * is billed as one package with those extras.
 */
export function entryConfig(e: RateEntry, siblings: RateEntry[], o: ConfigOptions): { config: RateConfig; notes: string[] } {
  const notes: string[] = [];
  const p = parsePackage(e.package);
  const extrasRow = e.rateType === 'fixed' ? siblings.find((s) => s !== e && s.rateType === 'per_km_hr' && !Number(s.baseFare) && !Number(s.includedKm) && !Number(s.includedHours) && (Number(s.extraKm) || Number(s.extraHour))) : undefined;
  const comps: Record<string, unknown>[] = [];
  const params: Record<string, unknown> = { hourRounding: { mode: o.hourRoundingMode, unit: o.hourRoundingUnit }, kmRounding: { mode: 'exact', unit: '1' } };
  let model: RateConfig['billingModel'] = 'daily_package';
  const base = Number(e.baseFare ?? 0);
  if (e.rateType === 'fixed' && !extrasRow) {
    model = 'fixed_trip';
    comps.push({ code: 'BASE', label: e.package, quantityExpr: '1', rate: e.baseFare ?? '0', unit: 'trip', taxCategory: 'taxable' });
    notes.push('Fixed price: base fare only; extra km/hours and night charges are not added.');
  } else if (e.rateType === 'fixed' && extrasRow) {
    const km = p.km ?? Number(e.includedKm ?? 0);
    const hrs = p.hours ?? Number(e.includedHours ?? 0);
    params.includedKm = String(km);
    params.includedHours = String(hrs);
    comps.push({ code: 'BASE', label: e.package, quantityExpr: '1', rate: e.baseFare ?? '0', unit: 'duty', taxCategory: 'taxable' });
    if (Number(extrasRow.extraKm)) comps.push({ code: 'EXKM', label: 'Extra Kms', quantityExpr: 'extra_km', rate: extrasRow.extraKm!, unit: 'km', taxCategory: 'taxable' });
    if (Number(extrasRow.extraHour)) comps.push({ code: 'EXHR', label: 'Extra Hrs', quantityExpr: 'extra_hours', rate: extrasRow.extraHour!, unit: 'hr', taxCategory: 'taxable' });
    notes.push(`Package ${km} km / ${hrs} hrs at ₹${e.baseFare} with extras from the "${extrasRow.package}" row (₹${extrasRow.extraKm ?? 0}/km, ₹${extrasRow.extraHour ?? 0}/hr).`);
  } else if (!base && !Number(e.includedKm) && !Number(e.includedHours)) {
    model = 'hourly_km';
    if (Number(e.extraKm)) comps.push({ code: 'KM', label: 'Kilometre charge', quantityExpr: 'billable_km', rate: e.extraKm!, unit: 'km', taxCategory: 'taxable' });
    if (Number(e.extraHour)) comps.push({ code: 'HR', label: 'Hourly charge', quantityExpr: 'billable_hours', rate: e.extraHour!, unit: 'hr', taxCategory: 'taxable' });
    notes.push('No base fare: every km and hour is charged at the per-km / per-hour rate.');
  } else if (p.outstation) {
    params.includedKm = e.includedKm ?? '0';
    params.includedHours = e.includedHours ?? '0';
    comps.push({ code: 'BASE', label: e.package, quantityExpr: 'max(1, days_spanned)', rate: e.baseFare ?? '0', unit: 'day', taxCategory: 'taxable' });
    if (Number(e.extraKm)) comps.push({ code: 'EXKM', label: 'Extra Kms', quantityExpr: 'max(0, billable_km - included_km * max(1, days_spanned))', rate: e.extraKm!, unit: 'km', taxCategory: 'taxable' });
    if (Number(e.extraHour) && Number(e.includedHours)) comps.push({ code: 'EXHR', label: 'Extra Hrs', quantityExpr: 'max(0, billable_hours - included_hours * max(1, days_spanned))', rate: e.extraHour!, unit: 'hr', taxCategory: 'taxable' });
    notes.push('Outstation: base fare and included km per day of the trip.');
  } else {
    params.includedKm = e.includedKm ?? '0';
    params.includedHours = e.includedHours ?? '0';
    comps.push({ code: 'BASE', label: e.package, quantityExpr: '1', rate: e.baseFare ?? '0', unit: 'duty', taxCategory: 'taxable' });
    if (Number(e.extraKm)) comps.push({ code: 'EXKM', label: 'Extra Kms', quantityExpr: 'extra_km', rate: e.extraKm!, unit: 'km', taxCategory: 'taxable' });
    if (Number(e.extraHour)) comps.push({ code: 'EXHR', label: 'Extra Hrs', quantityExpr: 'extra_hours', rate: e.extraHour!, unit: 'hr', taxCategory: 'taxable' });
  }
  if (model !== 'fixed_trip' && Number(e.nightCharge)) {
    if (e.nightStart && e.nightEnd) {
      params.night = { enabled: true, start: e.nightStart, end: e.nightEnd, minOverlapMinutes: 1, countMode: 'per_night' };
      comps.push({ code: 'NIGHT', label: 'Night Charges', quantityExpr: 'night_count', rate: e.nightCharge!, unit: 'night', taxCategory: 'taxable' });
    } else notes.push('Night charge has no time slot, so it is not applied — add the night start and end times.');
  }
  if (Number(e.driverAllowance)) comps.push({ code: 'DRIVER', label: 'Driver allowance', quantityExpr: 'max(1, days_spanned)', rate: e.driverAllowance!, unit: 'day', taxCategory: 'taxable' });
  comps.push({ code: 'TOLL', label: 'Toll Tax', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' });
  comps.push({ code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' });
  if (!comps.some((c) => c.code !== 'TOLL' && c.code !== 'PARK')) throw badRequest(`"${e.vehicle} — ${e.package}" has no rate to charge`);
  return { config: RateConfigSchema.parse({ billingModel: model, params, components: comps }), notes };
}

/** Row-level checks shared by the form and the import. */
export function checkEntry(e: RateEntry): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!e.vehicle) errors.push('Vehicle is required');
  if (!e.package) errors.push('Package is required');
  for (const k of ['baseFare', 'includedKm', 'includedHours', 'extraKm', 'extraHour', 'nightCharge', 'driverAllowance', 'cgst', 'sgst', 'igst', 'gst'] as const) {
    if (e[k] !== null && Number(e[k]) < 0) errors.push(`${ENTRY_LABELS[k]} cannot be negative`);
  }
  for (const k of ['cgst', 'sgst', 'igst', 'gst'] as const) if (e[k] !== null && Number(e[k]) > 100) errors.push(`${ENTRY_LABELS[k]} must be a percentage`);
  if (!Number(e.baseFare) && !Number(e.extraKm) && !Number(e.extraHour)) errors.push('No base fare and no per-km / per-hour rate');
  const p = parsePackage(e.package);
  if (e.rateType === 'per_km_hr' && p.hours !== null && e.includedHours !== null && Number(e.includedHours) && Math.abs(p.hours - Number(e.includedHours)) > 0.001)
    warnings.push(`Package says ${p.hours} hrs but included hours is ${e.includedHours}${/:/.test(e.package) ? ' (4:30 means 4.5 hours)' : ''}`);
  if (e.rateType === 'per_km_hr' && p.km !== null && e.includedKm !== null && Number(e.includedKm) && p.km !== Number(e.includedKm) && !p.outstation)
    warnings.push(`Package says ${p.km} km but included km is ${e.includedKm}`);
  if (Number(e.nightCharge) && (!e.nightStart || !e.nightEnd) && e.rateType !== 'fixed') warnings.push('Night charge without a time slot will not be applied');
  return { errors, warnings };
}

// --- department matching ------------------------------------------------------------

export interface ClientKeyRow { id: string; name: string; code: string | null; short_code: string; aliases: string[]; kind: string; gstin: string | null; billing_registration: string | null; rate_card_contract_id: string | null }

const k = (s: string | null | undefined) => (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const parenAbbr = (s: string) => /\(\s*([A-Za-z][A-Za-z0-9 .&-]{1,15})\s*\)/.exec(s)?.[1] ?? null;

/** Finds the existing department/institution a register name refers to. */
export function matchClient(clients: ClientKeyRow[], name: string, extraKeys: (string | null | undefined)[] = []): { client?: ClientKeyRow; ambiguous?: ClientKeyRow[]; how?: string } {
  const exact = clients.filter((c) => k(c.name) === k(name) || (c.aliases ?? []).some((a) => k(a) === k(name)));
  if (exact.length === 1) return { client: exact[0], how: 'name' };
  if (exact.length > 1) return { ambiguous: exact };
  const keys = [parenAbbr(name), ...extraKeys].map(k).filter(Boolean);
  const hit = (c: ClientKeyRow) => keys.some((x) => x === k(c.code) || x === k(c.short_code) || x === k(c.name) || x === k(parenAbbr(c.name)) || (c.aliases ?? []).some((a) => k(a) === x));
  const found = clients.filter(hit);
  if (found.length === 1) return { client: found[0], how: 'code or alias' };
  if (found.length > 1) return { ambiguous: found };
  return {};
}

// --- current rate card ------------------------------------------------------------

export interface CurrentRate { schemeId: string; schemeName: string; versionId: string; versionNo: number; status: string; effectiveFrom: string; effectiveTo: string | null; categoryId: string | null; dutyTypes: string[]; entry: RateEntry; pending: { versionId: string; status: string; effectiveFrom: string; entry: RateEntry } | null }

/** Reconstructs a rate-card row from a version made outside the rate card (e.g. document set-up). */
function entryFromConfig(cfg: RateConfig, vehicle: string, pkg: string): RateEntry {
  const rate = (c: string) => cfg.components.find((x) => x.code === c)?.rate ?? null;
  return normaliseEntry({
    vehicle, package: pkg, rateType: cfg.billingModel === 'fixed_trip' ? 'fixed' : 'per_km_hr', baseFare: rate('BASE') ?? rate('TRANSFER'), includedKm: cfg.params.includedKm, includedHours: cfg.params.includedHours,
    extraKm: rate('EXKM') ?? rate('KM'), extraHour: rate('EXHR') ?? rate('HR'), nightCharge: rate('NIGHT'), nightStart: cfg.params.night.enabled ? cfg.params.night.start : null,
    nightEnd: cfg.params.night.enabled ? cfg.params.night.end : null, driverAllowance: rate('DRIVER'),
  });
}

export async function currentRates(db: Db, contractId: string, onDate: string): Promise<CurrentRate[]> {
  const rows = await db.query<{ id: string; scheme_id: string; name: string; version_no: number; status: string; effective_from: string; effective_to: string | null; vehicle_category_ids: string[]; duty_type_codes: string[]; config: unknown; meta: { entry?: RateEntry }; category_name: string | null }>(
    `SELECT v.*, s.name, (SELECT c.name FROM vehicle_categories c WHERE c.id = v.vehicle_category_ids[1]) AS category_name
     FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id WHERE s.contract_id = $1 AND v.status IN ('approved','pending_approval','draft') ORDER BY v.version_no DESC`, [contractId]);
  const bySchema = new Map<string, typeof rows>();
  for (const r of rows) bySchema.set(r.scheme_id, [...(bySchema.get(r.scheme_id) ?? []), r]);
  const out: CurrentRate[] = [];
  for (const [schemeId, vs] of bySchema) {
    const approved = vs.filter((v) => v.status === 'approved');
    const cur = approved.find((v) => v.effective_from <= onDate && (!v.effective_to || v.effective_to >= onDate))
      ?? approved.filter((v) => !v.effective_to || v.effective_to >= onDate).sort((a, b) => a.effective_from.localeCompare(b.effective_from))[0];
    const pend = vs.find((v) => v.status !== 'approved' && (!cur || v.version_no > cur.version_no));
    const base = cur ?? pend;
    if (!base) continue; // ended rate
    const toEntry = (v: typeof rows[number]) => v.meta?.entry ? normaliseEntry(v.meta.entry) : entryFromConfig(RateConfigSchema.parse(v.config), v.category_name ?? '', v.name.split(' — ').slice(1).join(' — ') || v.name);
    out.push({
      schemeId, schemeName: base.name, versionId: base.id, versionNo: base.version_no, status: base.status, effectiveFrom: base.effective_from, effectiveTo: base.effective_to,
      categoryId: base.vehicle_category_ids?.[0] ?? null, dutyTypes: base.duty_type_codes ?? [], entry: toEntry(base),
      pending: cur && pend ? { versionId: pend.id, status: pend.status, effectiveFrom: pend.effective_from, entry: toEntry(pend) } : null,
    });
  }
  return out.sort((a, b) => a.entry.vehicle.localeCompare(b.entry.vehicle) || a.entry.package.localeCompare(b.entry.package));
}

/** The contract a department's rate card belongs to; created when the department has none. */
export async function rateCardContract(db: Db, clientId: string, opts: { create: boolean; startDate: string; userId?: string }): Promise<{ id: string | null; created: boolean; label: string; warning?: string }> {
  const c = await db.one<{ id: string; name: string; short_code: string; rate_card_contract_id: string | null; billing_pattern: string | null; billing_registration: string | null }>('SELECT * FROM clients WHERE id = $1', [clientId]);
  if (!c) throw badRequest('Department not found');
  if (c.rate_card_contract_id) {
    const k = await db.one<{ id: string; reference_no: string; title: string }>('SELECT id, reference_no, title FROM contracts WHERE id = $1', [c.rate_card_contract_id]);
    if (k) return { id: k.id, created: false, label: `${k.reference_no} — ${k.title}` };
  }
  const active = await db.query<{ id: string; reference_no: string; title: string }>(`SELECT id, reference_no, title FROM contracts WHERE client_id = $1 AND status = 'active' ORDER BY start_date DESC`, [clientId]);
  if (active.length) {
    if (opts.create) await db.query('UPDATE clients SET rate_card_contract_id = $2 WHERE id = $1', [clientId, active[0].id]);
    return { id: active[0].id, created: false, label: `${active[0].reference_no} — ${active[0].title}`, warning: active.length > 1 ? `Several active contracts; using ${active[0].reference_no}. Choose another on the Rate Card screen if needed.` : undefined };
  }
  if (!opts.create) return { id: null, created: true, label: `${c.short_code}/RATE-CARD (will be created)` };
  const supState = registrationState(c.billing_registration);
  const sup = supState ? await db.one<{ id: string }>('SELECT id FROM supplier_profiles WHERE state_code = $1 OR gstin LIKE $1 || \'%\' ORDER BY is_default DESC LIMIT 1', [supState]) : null;
  const freq = /^\s*day\s*to\s*day\s*$/i.test(c.billing_pattern ?? '') ? 'daily' : 'monthly';
  const k = await db.one<{ id: string }>(
    `INSERT INTO contracts(client_id, supplier_profile_id, title, reference_no, start_date, billing_frequency, status, bill_no_format)
     VALUES ($1,$2,$3,$4,$5,$6,'active',$7) RETURNING id`,
    [clientId, sup?.id ?? null, `${c.name} — rate card`, `${c.short_code}/RATE-CARD`, opts.startDate, freq, '{CLIENT}/{FY}/{SEQ}'],
  );
  await db.query('UPDATE clients SET rate_card_contract_id = $2 WHERE id = $1', [clientId, k!.id]);
  if (opts.userId) await audit(db, opts.userId, 'contract', k!.id, 'create_for_rate_card', undefined, { client: c.name });
  return { id: k!.id, created: true, label: `${c.short_code}/RATE-CARD` };
}

/** Finds the vehicle category for a rate-card vehicle (by name or alias), creating it when new. */
export async function categoryFor(db: Db, vehicle: string, create: boolean): Promise<{ id: string | null; name: string; created: boolean }> {
  const cats = await db.query<{ id: string; name: string; aliases: string[] }>('SELECT id, name, aliases FROM vehicle_categories');
  const kk = (s: string) => s.toLowerCase().replace(/[\s.-]+/g, '');
  const hit = cats.find((c) => kk(c.name) === kk(vehicle)) ?? cats.find((c) => (c.aliases ?? []).some((a) => kk(a) === kk(vehicle)));
  if (hit) return { id: hit.id, name: hit.name, created: false };
  if (!create) return { id: null, name: vehicle, created: true };
  const r = await db.one<{ id: string }>('INSERT INTO vehicle_categories(name, aliases) VALUES ($1, $2::text[]) RETURNING id', [vehicle, [vehicle]]);
  return { id: r!.id, name: vehicle, created: true };
}

/**
 * Writes one rate-card row as a new rate version (inside the caller's transaction).
 * Reuses the scheme that already carries this vehicle + package; otherwise creates one.
 */
export async function saveRate(db: Db, a: {
  contractId: string; entry: RateEntry; siblings: RateEntry[]; effectiveFrom: string; options: ConfigOptions; userId: string; approve: boolean; local: boolean; schemeId?: string | null; source: string;
}, approveFn: (db: Db, id: string, userId: string, note: string | null) => Promise<unknown>) {
  const cat = await categoryFor(db, a.entry.vehicle, true);
  const dt = dutyTypeFor(a.entry);
  await db.query('INSERT INTO duty_types(code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING', [dt.code, dt.name]);
  const dutyTypes = a.local ? [dt.code, 'LOCAL'] : [dt.code];
  const { config, notes } = entryConfig(a.entry, a.siblings, a.options);
  let schemeId = a.schemeId ?? null;
  if (!schemeId) {
    const name = `${a.entry.vehicle} — ${a.entry.package}`;
    schemeId = (await db.one<{ id: string }>('SELECT id FROM rate_schemes WHERE contract_id = $1 AND lower(name) = lower($2)', [a.contractId, name]))?.id
      ?? (await db.one<{ id: string }>('INSERT INTO rate_schemes(contract_id, name, description) VALUES ($1,$2,$3) RETURNING id', [a.contractId, name, 'Department rate card']))!.id;
  }
  const contract = await db.one<{ end_date: string | null }>('SELECT end_date FROM contracts WHERE id = $1', [a.contractId]);
  const v = await db.one<{ id: string; version_no: number }>(
    `INSERT INTO rate_scheme_versions(scheme_id, version_no, status, effective_from, effective_to, vehicle_category_ids, duty_type_codes, config, clause_ref, notes, created_by, submitted_by, meta)
     VALUES ($1, (SELECT COALESCE(max(version_no),0)+1 FROM rate_scheme_versions WHERE scheme_id = $1), 'pending_approval', $2, $3, $4::uuid[], $5::text[], $6, $7, $8, $9, $9, $10) RETURNING id, version_no`,
    [schemeId, a.effectiveFrom, contract?.end_date ?? null, [cat.id], dutyTypes, config, a.entry.source ?? a.source, notes.join(' '), a.userId, { entry: a.entry, source: a.source }],
  );
  await audit(db, a.userId, 'rate_version', v!.id, 'rate_card_save', undefined, a.entry, a.source);
  if (a.approve) await approveFn(db, v!.id, a.userId, `Approved with the rate card (${a.source})`);
  return { versionId: v!.id, versionNo: v!.version_no, schemeId, categoryCreated: cat.created, notes };
}

/** Ends a rate from a date (the rate stays in history for earlier duties). */
export async function endRate(db: Db, schemeId: string, lastDay: string, userId: string) {
  const vs = await db.query<{ id: string; status: string; effective_from: string; effective_to: string | null }>('SELECT id, status, effective_from, effective_to FROM rate_scheme_versions WHERE scheme_id = $1', [schemeId]);
  for (const v of vs) {
    if (v.status !== 'approved') { if (['draft', 'pending_approval'].includes(v.status)) await db.query(`UPDATE rate_scheme_versions SET status = 'rejected' WHERE id = $1`, [v.id]); continue; }
    if (v.effective_from > lastDay) await db.query(`UPDATE rate_scheme_versions SET status = 'retired' WHERE id = $1`, [v.id]);
    else if (!v.effective_to || v.effective_to > lastDay) await db.query('UPDATE rate_scheme_versions SET effective_to = $2 WHERE id = $1', [v.id, lastDay]);
  }
  await audit(db, userId, 'rate_scheme', schemeId, 'end_rate', undefined, { lastDay });
}

/** Keeps the contract's tax rules in line with the department's rates (new rules from a date; old ones end the day before). */
export async function syncTax(db: Db, contractId: string, tax: ResolvedTax, effectiveFrom: string, userId: string, approve: boolean): Promise<string | null> {
  if (tax.mode === 'UNRESOLVED') return null;
  const want = tax.mode === 'CGST_SGST' ? [['CGST', tax.cgst], ['SGST', tax.sgst]] : tax.mode === 'IGST' ? [['IGST', tax.igst]] : [['IGST', '0']];
  const current = await db.query<{ id: string; tax_type: string; rate: string; effective_from: string; effective_to: string | null; status: string }>(
    `SELECT * FROM tax_rules WHERE contract_id = $1 AND status = 'approved' AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`, [contractId, effectiveFrom]);
  const same = current.length === want.length && want.every(([ty, r]) => current.some((c) => c.tax_type === ty && Number(c.rate) === Number(r)));
  if (same) return null;
  for (const c of current) {
    if (c.effective_from >= effectiveFrom) await db.query(`UPDATE tax_rules SET status = 'retired' WHERE id = $1`, [c.id]);
    else await db.query('UPDATE tax_rules SET effective_to = $2 WHERE id = $1', [c.id, addDays(effectiveFrom, -1)]);
  }
  for (const [ty, r] of want) {
    await db.query(
      `INSERT INTO tax_rules(contract_id, name, tax_type, rate, effective_from, status, source_ref, created_by, approved_by, approved_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [contractId, tax.mode === 'RCM' ? 'Reverse charge (no GST on bill)' : tax.mode === 'NONE' ? 'No tax' : `${ty} ${r}%`, ty, r, effectiveFrom, approve ? 'approved' : 'draft',
        `Department rate card: ${tax.label}${tax.reason ? ` — ${tax.reason}` : ''}`, userId, approve ? userId : null, approve ? new Date().toISOString() : null],
    );
  }
  await audit(db, userId, 'contract', contractId, 'tax_from_rate_card', current, want);
  return `${tax.mode === 'CGST_SGST' ? `CGST ${tax.cgst}% + SGST ${tax.sgst}%` : tax.mode === 'IGST' ? `IGST ${tax.igst}%` : tax.mode === 'RCM' ? 'RCM (no GST on bill)' : 'No tax'} from ${effectiveFrom}`;
}

/**
 * The current rate a row updates: same vehicle category and either the same package (duty type)
 * or the same included km/hours — so rates created elsewhere (e.g. from contract documents) are
 * updated rather than duplicated.
 */
export function findExistingRate(current: CurrentRate[], categoryId: string | null, e: RateEntry): CurrentRate | undefined {
  if (!categoryId) return undefined;
  const code = dutyTypeFor(e).code;
  const mine = current.filter((c) => c.categoryId === categoryId);
  const byName = mine.find((c) => c.entry.package.toLowerCase() === e.package.toLowerCase());
  if (byName) return byName;
  const byCode = mine.find((c) => c.dutyTypes.includes(code));
  if (byCode) return byCode;
  const p = parsePackage(e.package);
  return mine.find((c) => {
    const q = parsePackage(c.entry.package);
    const sameKm = Number(c.entry.includedKm ?? q.km ?? 0) === Number(e.includedKm ?? p.km ?? 0);
    const sameHrs = Number(c.entry.includedHours ?? q.hours ?? 0) === Number(e.includedHours ?? p.hours ?? 0);
    return sameKm && sameHrs && q.outstation === p.outstation && c.entry.rateType === e.rateType && Number(e.includedKm ?? 0) > 0;
  });
}

/** The department's main package per vehicle (largest included hours, not outstation) also serves ordinary "LOCAL" duties. */
export function localPackages(entries: RateEntry[]): Set<RateEntry> {
  const out = new Set<RateEntry>();
  const byVehicle = new Map<string, RateEntry[]>();
  for (const e of entries) byVehicle.set(e.vehicle.toLowerCase(), [...(byVehicle.get(e.vehicle.toLowerCase()) ?? []), e]);
  for (const list of byVehicle.values()) {
    const cands = list.filter((e) => !parsePackage(e.package).outstation && (Number(e.baseFare) > 0));
    if (!cands.length) continue;
    const hours = (e: RateEntry) => parsePackage(e.package).hours ?? Number(e.includedHours ?? 0);
    out.add(cands.sort((a, b) => hours(b) - hours(a) || Number(b.baseFare) - Number(a.baseFare))[0]);
  }
  return out;
}
