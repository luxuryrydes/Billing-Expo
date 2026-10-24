/**
 * Department & Rate Register (the "LR Taxi Services Department Rate Register" workbook):
 *   - Department Master sheet → departments (billing pattern, billing entity, GST registration, GST)
 *   - Department Rate Register sheet → each department's rate card
 * Upload rule (same as every import): only what changed is updated, new rows are added,
 * unchanged rows are not touched, and nothing is deleted because it is missing from the file.
 * Export writes the same workbook layout from the software so it can be edited and re-uploaded.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { addDays } from '../engine/time.js';
import { detectTable, type Workbook } from './sheets.js';
import {
  categoryFor, changedKeys, checkEntry, currentRates, dutyTypeFor, ENTRY_LABELS, findExistingRate, localPackages, matchClient, normaliseEntry, rateCardContract,
  registrationState, resolveTax, saveRate, syncTax, taxDisplay, type ClientKeyRow, type ConfigOptions, type RateEntry, type ResolvedTax,
} from './departmentRates.js';
import { GST_STATES } from './profile.js';

export const MASTER_SYNONYMS: Record<string, string[]> = {
  department: ['department / institution', 'department name', 'department', 'institution'],
  originalName: ['original department name'],
  gst: ['gst rate / mode (source list)', 'gst rate / mode', 'gst rate', 'gst'],
  billingPattern: ['billing pattern', 'billing'],
  billingEntity: ['billing entity (fy 2026–2027)', 'billing entity', 'fy-2026-2027', 'fy 2026 2027'],
  billingRegistration: ['billing gst / registration', 'billing gst', 'gst registration'],
  sourceKey: ['rate card source key', 'source key'],
  rateStatus: ['rate status'],
};
export const RATE_SYNONYMS: Record<string, string[]> = {
  department: ['department / institution', 'department'],
  originalName: ['original rate card name'],
  vehicle: ['vehicle'],
  package: ['package / duty plan', 'package'],
  rateType: ['rate type', 'type'],
  baseFare: ['base fare (₹)', 'base fare', 'base'],
  includedKm: ['included km', 'inc. km', 'inc km'],
  includedHours: ['included hours', 'inc. hrs', 'inc hrs'],
  extraKm: ['extra km rate (₹)', 'extra km rate', 'extra/km', 'extra km'],
  extraHour: ['extra hour rate (₹)', 'extra hour rate', 'extra/hr', 'extra hour'],
  nightCharge: ['night charge (₹/trip)', 'night charge', 'night ₹', 'night'],
  nightStart: ['night starts', 'night start'],
  nightEnd: ['night ends', 'night end'],
  driverAllowance: ['driver allowance (₹/day)', 'driver allowance', 'driver allow'],
  taxLabel: ['tax label (as shown)', 'tax label', 'tax'],
  taxMode: ['tax mode'],
  cgst: ['cgst (%)', 'cgst'],
  sgst: ['sgst (%)', 'sgst'],
  igst: ['igst (%)', 'igst'],
  gst: ['gst (%)', 'gst'],
  fixed: ['fixed price package?', 'fixed price package', 'fixed price'],
  source: ['source screenshot', 'source'],
  status: ['rate data status'],
  notes: ['notes'],
};

export interface RegisterOptions extends ConfigOptions {
  /** First rates for a department (or a vehicle/package it did not have) apply from this date. */
  newRatesFrom: string;
  /** Changed rates apply from this date; earlier duties keep the old rate. */
  changesFrom: string;
  /** Approve rates and tax rules on import (needs rate and tax approval rights). */
  approve: boolean;
}

/** "0.05" → 5, "5%" → 5, "RCM" → null */
const pct = (s: string) => {
  const v = s.replace('%', '').trim();
  if (!/^\d+(\.\d+)?$/.test(v)) return null;
  const x = Number(v);
  return x > 0 && x < 1 ? x * 100 : x;
};
const gstLabelOf = (s: string) => { const p = pct(s); return p !== null ? `${Number(p.toFixed(4))}%` : s.trim(); };
const totalRate = (label: string | null) => {
  if (!label) return null;
  const sp = /split\s*([\d.]+)\s*\+\s*([\d.]+)/i.exec(label);
  if (sp) return Number(sp[1]) + Number(sp[2]);
  const m = /([\d.]+)\s*%/.exec(label);
  return m ? Number(m[1]) : /rcm/i.test(label) ? -1 : null;
};

export interface DeptResult { rowNumber: number; name: string; action: 'add' | 'update' | 'unchanged' | 'error'; clientId: string | null; matchedTo: string | null; how?: string; changes: Record<string, { from: unknown; to: unknown }>; warnings: string[]; errors: string[]; values: Record<string, unknown> }
export interface RateResult {
  rowNumber: number; department: string; clientId: string | null; clientName: string; vehicle: string; package: string;
  action: 'add' | 'update' | 'unchanged' | 'error'; errors: string[]; warnings: string[]; incoming: RateEntry; existing: RateEntry | null; existingSchemeId: string | null;
  existingFrom: string | null; changes: string[]; effectiveFrom: string; tax: string; dutyType: string;
}
export interface DeptRatePlan { clientId: string | null; department: string; contract: string; createsContract: boolean; tax: ResolvedTax | null; taxChange: string | null; kept: { vehicle: string; package: string }[]; warnings: string[] }

const val = (cells: string[], m: Record<string, number>, key: string) => (m[key] === undefined ? '' : (cells[m[key]] ?? '').trim());

export function readRegister(wb: Workbook) {
  const pick = (syn: Record<string, string[]>, must: string[]) => {
    let best: ReturnType<typeof detectTable> | null = null;
    for (const s of wb.sheets) {
      const t = detectTable({ sheets: [s] }, syn);
      if (must.every((f) => t.mapping[f] !== undefined) && (!best || Object.keys(t.mapping).length > Object.keys(best.mapping).length)) best = t;
    }
    return best;
  };
  const rates = pick(RATE_SYNONYMS, ['department', 'vehicle', 'baseFare']);
  const master = pick(MASTER_SYNONYMS, ['department', 'billingPattern']) ?? pick(MASTER_SYNONYMS, ['department', 'gst']);
  return { master: master && master.sheet !== rates?.sheet ? master : null, rates };
}

export async function analyseRegister(db: Db, wb: Workbook, o: RegisterOptions) {
  const { master, rates } = readRegister(wb);
  if (!master && !rates) throw new Error('This workbook has neither a department sheet (Department / Institution, Billing Pattern…) nor a rate sheet (Department, Vehicle, Base Fare…).');
  const clients = await db.query<ClientKeyRow & { gst_label: string | null; billing_pattern: string | null; billing_entity: string | null; cgst_rate: string | null; sgst_rate: string | null; igst_rate: string | null }>('SELECT * FROM clients');
  const departments: DeptResult[] = [];
  const nameToDept = new Map<string, DeptResult>();
  const nk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

  // --- departments --------------------------------------------------------------------
  if (master) {
    const m = master.mapping;
    const sourceKeyCount = new Map<string, number>();
    for (const r of master.rows) { const sk = nk(val(r.cells, m, 'sourceKey')); if (sk) sourceKeyCount.set(sk, (sourceKeyCount.get(sk) ?? 0) + 1); }
    const used = new Map<string, number>();
    for (const r of master.rows) {
      const name = val(r.cells, m, 'department');
      if (!name || /^\d+$/.test(name)) continue;
      const original = val(r.cells, m, 'originalName');
      const sourceKey = val(r.cells, m, 'sourceKey');
      // A source key shared by several register departments (e.g. Ministry of Education – Ciaz / – Dzire) cannot identify one of them.
      const keys = [original, (sourceKeyCount.get(nk(sourceKey)) ?? 0) === 1 ? sourceKey : ''];
      const hit = matchClient(clients, name, keys);
      const gstRaw = val(r.cells, m, 'gst');
      const values: Record<string, unknown> = {
        billing_pattern: val(r.cells, m, 'billingPattern') || null,
        billing_entity: val(r.cells, m, 'billingEntity') || null,
        billing_registration: val(r.cells, m, 'billingRegistration') || null,
      };
      if (gstRaw) values.gst_label = gstLabelOf(gstRaw);
      const aliases = [...new Set([name, original, sourceKey].filter(Boolean))];
      const errors: string[] = [];
      const warnings: string[] = [];
      let action: DeptResult['action'] = 'add';
      const changes: DeptResult['changes'] = {};
      const c = hit.client;
      if (hit.ambiguous) { errors.push(`Matches more than one record (${hit.ambiguous.map((x) => x.name).join(', ')}). Add a distinct alias to one of them.`); action = 'error'; }
      else if (c) {
        if (used.has(c.id)) warnings.push(`Same department as row ${used.get(c.id)}`);
        used.set(c.id, r.rowNumber);
        const cur = c as unknown as Record<string, unknown>;
        for (const [key, v] of Object.entries(values)) {
          if (v == null) continue; // blank cells never clear existing values
          if (key === 'gst_label' && totalRate(String(cur.gst_label ?? '')) === totalRate(String(v))) continue; // "Split 2.5+2.5%" equals "5%"
          if (String(cur[key] ?? '') !== String(v)) changes[key] = { from: cur[key] ?? null, to: v };
        }
        const newAliases = aliases.filter((a) => nk(a) !== nk(c.name) && !(c.aliases ?? []).some((x) => nk(x) === nk(a)));
        if (newAliases.length) changes.aliases = { from: c.aliases ?? [], to: [...(c.aliases ?? []), ...newAliases] };
        action = Object.keys(changes).length ? 'update' : 'unchanged';
      } else {
        values.aliases = aliases.filter((a) => nk(a) !== nk(name));
      }
      if (values.billing_registration && !registrationState(String(values.billing_registration))) warnings.push(`Billing registration "${values.billing_registration}" is not a recognised state; GST type cannot be worked out from it.`);
      const res: DeptResult = { rowNumber: r.rowNumber, name, action, clientId: c?.id ?? null, matchedTo: c && nk(c.name) !== nk(name) ? c.name : null, how: hit.how, changes, warnings, errors, values: { ...values, name, aliases } };
      departments.push(res);
      for (const nm of aliases) nameToDept.set(nk(nm), res);
    }
  }

  // --- rates --------------------------------------------------------------------------
  const rateResults: RateResult[] = [];
  const plans = new Map<string, DeptRatePlan>();
  if (rates) {
    const m = rates.mapping;
    type Row = { rowNumber: number; dept: string; entry: RateEntry; clientId: string | null; clientName: string; deptRes?: DeptResult };
    const rows: Row[] = [];
    for (const r of rates.rows) {
      const dept = val(r.cells, m, 'department');
      const vehicle = val(r.cells, m, 'vehicle');
      if (!dept || /^\d+$/.test(dept)) continue;
      if (!vehicle) continue; // "No rate card found" placeholder rows carry no rate
      const fixedCol = val(r.cells, m, 'fixed');
      const entry = normaliseEntry({
        vehicle, package: val(r.cells, m, 'package'), rateType: /true|yes/i.test(fixedCol) || /fixed/i.test(val(r.cells, m, 'rateType')) ? 'fixed' : 'per_km_hr',
        baseFare: val(r.cells, m, 'baseFare'), includedKm: val(r.cells, m, 'includedKm'), includedHours: val(r.cells, m, 'includedHours'), extraKm: val(r.cells, m, 'extraKm'),
        extraHour: val(r.cells, m, 'extraHour'), nightCharge: val(r.cells, m, 'nightCharge'), nightStart: val(r.cells, m, 'nightStart'), nightEnd: val(r.cells, m, 'nightEnd'),
        driverAllowance: val(r.cells, m, 'driverAllowance'), taxLabel: val(r.cells, m, 'taxLabel'), taxMode: val(r.cells, m, 'taxMode'), cgst: val(r.cells, m, 'cgst'), sgst: val(r.cells, m, 'sgst'),
        igst: val(r.cells, m, 'igst'), gst: val(r.cells, m, 'gst'), source: val(r.cells, m, 'source'), notes: val(r.cells, m, 'notes'),
      });
      const deptRes = nameToDept.get(nk(dept));
      let clientId = deptRes?.clientId ?? null;
      let clientName = deptRes?.matchedTo ?? deptRes?.name ?? dept;
      if (!deptRes) {
        const hit = matchClient(clients, dept, [val(r.cells, m, 'originalName')]);
        clientId = hit.client?.id ?? null;
        clientName = hit.client?.name ?? dept;
      }
      rows.push({ rowNumber: r.rowNumber, dept, entry, clientId, clientName, deptRes });
    }
    const byDept = new Map<string, Row[]>();
    for (const r of rows) byDept.set(r.clientId ?? `new:${nk(r.dept)}`, [...(byDept.get(r.clientId ?? `new:${nk(r.dept)}`) ?? []), r]);
    for (const [key, list] of byDept) {
      const first = list[0];
      const client = first.clientId ? clients.find((c) => c.id === first.clientId)! : null;
      const knownDept = !!first.clientId || !!first.deptRes;
      const contract = client ? await rateCardContract(db, client.id, { create: false, startDate: o.newRatesFrom }) : { id: null, created: true, label: 'new rate-card contract' };
      const current = contract.id ? await currentRates(db, contract.id, o.changesFrom) : [];
      const registration = String(first.deptRes?.values.billing_registration ?? client?.billing_registration ?? '');
      const clientState = client?.gstin?.slice(0, 2) ?? null;
      const supState = registrationState(registration);
      const plan: DeptRatePlan = { clientId: first.clientId, department: first.clientName, contract: contract.label, createsContract: contract.created, tax: null, taxChange: null, kept: [], warnings: contract.warning ? [contract.warning] : [] };
      const seen = new Map<string, number>();
      const taxes: ResolvedTax[] = [];
      for (const r of list) {
        const { errors, warnings } = checkEntry(r.entry);
        if (!knownDept) errors.push(`Department "${r.dept}" is not in the software and not on the Department Master sheet — add it first.`);
        const dkey = `${r.entry.vehicle.toLowerCase()}|${r.entry.package.toLowerCase()}`;
        if (seen.has(dkey)) errors.push(`Same vehicle and package as row ${seen.get(dkey)}`);
        else seen.set(dkey, r.rowNumber);
        const cat = await categoryFor(db, r.entry.vehicle, false);
        const ex = findExistingRate(current, cat.id, r.entry);
        // A blank cell keeps the saved value; only filled-in cells can change a rate.
        if (ex) for (const k of Object.keys(r.entry) as (keyof RateEntry)[]) if (r.entry[k] === null && ex.entry[k] != null) (r.entry as unknown as Record<string, unknown>)[k] = ex.entry[k];
        const tax = resolveTax(r.entry, clientState, supState);
        if (tax.mode !== 'UNRESOLVED') taxes.push(tax);
        const changes = ex ? changedKeys(ex.entry, r.entry) : [];
        const isChange = !!ex && changes.length > 0;
        const effectiveFrom = ex ? o.changesFrom : o.newRatesFrom;
        if (isChange && ex!.status === 'approved' && o.changesFrom <= ex!.effectiveFrom) errors.push(`The current rate starts ${ex!.effectiveFrom}; changed rates need a later "apply from" date so earlier duties keep their rate.`);
        if (ex?.pending) warnings.push(`A change waiting for approval exists (from ${ex.pending.effectiveFrom}); this upload adds another version.`);
        if (cat.created) warnings.push(`New vehicle category "${r.entry.vehicle}" will be created`);
        rateResults.push({
          rowNumber: r.rowNumber, department: r.dept, clientId: r.clientId, clientName: r.clientName, vehicle: r.entry.vehicle, package: r.entry.package,
          action: errors.length ? 'error' : !ex ? 'add' : isChange ? 'update' : 'unchanged', errors, warnings, incoming: r.entry, existing: ex?.entry ?? null, existingSchemeId: ex?.schemeId ?? null,
          existingFrom: ex?.effectiveFrom ?? null, changes, effectiveFrom, tax: tax.mode === 'UNRESOLVED' ? `— (${tax.reason})` : `${taxDisplay(tax)}${tax.reason ? ` · ${tax.reason}` : ''}`, dutyType: dutyTypeFor(r.entry).name,
        });
      }
      // Rates in the software that this file does not list stay as they are.
      const listed = new Set(rateResults.filter((x) => (x.clientId ?? `new:${nk(x.department)}`) === key && x.existingSchemeId).map((x) => x.existingSchemeId));
      plan.kept = current.filter((c) => !listed.has(c.schemeId)).map((c) => ({ vehicle: c.entry.vehicle, package: c.entry.package }));
      const distinct = [...new Map(taxes.map((x) => [`${x.mode}|${x.cgst}|${x.sgst}|${x.igst}`, x])).values()];
      plan.tax = distinct[0] ?? null;
      if (distinct.length > 1) plan.warnings.push(`Rates show different taxes (${distinct.map(taxDisplay).join(' / ')}); the bill uses one tax for the department: ${taxDisplay(distinct[0])}. Check the contract's tax rules.`);
      if (!plan.tax && list.length) plan.warnings.push(`Tax could not be worked out (${resolveTax(list[0].entry, clientState, supState).reason}). Set it on the contract's Tax rules tab.`);
      if (plan.tax && contract.id) {
        const cur = await db.query<{ tax_type: string; rate: string }>(`SELECT tax_type, rate FROM tax_rules WHERE contract_id = $1 AND status = 'approved' AND effective_from <= $2 AND (effective_to IS NULL OR effective_to >= $2)`, [contract.id, o.changesFrom]);
        const want = plan.tax.mode === 'CGST_SGST' ? [['CGST', plan.tax.cgst], ['SGST', plan.tax.sgst]] : plan.tax.mode === 'IGST' ? [['IGST', plan.tax.igst]] : [['IGST', '0']];
        const same = cur.length === want.length && want.every(([ty, r]) => cur.some((c) => c.tax_type === ty && Number(c.rate) === Number(r)));
        plan.taxChange = same ? null : `${cur.length ? cur.map((c) => `${c.tax_type} ${Number(c.rate)}%`).join(' + ') : 'none'} → ${taxDisplay(plan.tax)}`;
      } else if (plan.tax) plan.taxChange = `none → ${taxDisplay(plan.tax)}`;
      plans.set(key, plan);
    }
  }
  const count = <T extends { action: string }>(xs: T[], a: string) => xs.filter((x) => x.action === a).length;
  return {
    sheets: { master: master?.sheet ?? null, rates: rates?.sheet ?? null },
    departments, rates: rateResults, plans: [...plans.values()],
    summary: {
      departments: { rows: departments.length, add: count(departments, 'add'), update: count(departments, 'update'), unchanged: count(departments, 'unchanged'), errors: count(departments, 'error') },
      rates: { rows: rateResults.length, add: count(rateResults, 'add'), update: count(rateResults, 'update'), unchanged: count(rateResults, 'unchanged'), errors: count(rateResults, 'error') },
      taxChanges: [...plans.values()].filter((p) => p.taxChange).length,
    },
  };
}

type Analysis = Awaited<ReturnType<typeof analyseRegister>>;

/** Applies an analysis inside a transaction. Only add/update rows are written. */
export async function applyRegister(db: Db, a: Analysis, o: RegisterOptions, userId: string, skipInvalid: boolean, approveFn: (db: Db, id: string, userId: string, note: string | null) => Promise<unknown>) {
  const errs = a.summary.departments.errors + a.summary.rates.errors;
  if (errs && !skipInvalid) throw Object.assign(new Error(`${errs} row(s) have errors. Correct them, or choose to import only the valid rows.`), { status: 409 });
  const out = { departmentsAdded: 0, departmentsUpdated: 0, ratesAdded: 0, ratesUpdated: 0, contractsCreated: 0, taxUpdated: [] as string[] };
  const idByName = new Map<string, string>();
  const nk = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const { upsertRecord } = await import('./masterImport.js');
  for (const d of a.departments) {
    if (d.action === 'error') continue;
    if (d.action === 'add') {
      const r = await upsertRecord(db, 'departments', { name: d.name, aliases: d.values.aliases, gst_label: d.values.gst_label, billing_address: '' }, userId, undefined, 'import');
      await db.query('UPDATE clients SET billing_pattern = $2, billing_entity = $3, billing_registration = $4 WHERE id = $1', [r.id, d.values.billing_pattern, d.values.billing_entity, d.values.billing_registration]);
      d.clientId = r.id;
      out.departmentsAdded++;
    } else if (d.action === 'update') {
      const before = await db.one('SELECT * FROM clients WHERE id = $1', [d.clientId]);
      for (const [key, ch] of Object.entries(d.changes)) {
        if (key === 'aliases') await db.query('UPDATE clients SET aliases = $2::text[], updated_at = now() WHERE id = $1', [d.clientId, ch.to]);
        else await db.query(`UPDATE clients SET ${key} = $2, updated_at = now() WHERE id = $1`, [d.clientId, ch.to]);
      }
      await audit(db, userId, 'client', d.clientId, 'register_update', before, d.changes);
      out.departmentsUpdated++;
    }
    for (const nm of [d.name, ...((d.values.aliases as string[]) ?? [])]) if (d.clientId) idByName.set(nk(nm), d.clientId);
  }
  // Department GST defaults from the register (place of supply decides IGST vs CGST+SGST)
  for (const d of a.departments) {
    if (!d.clientId || d.action === 'error' || !d.values.gst_label) continue;
    const c = await db.one<{ gstin: string | null; billing_registration: string | null; cgst_rate: string | null; igst_rate: string | null }>('SELECT * FROM clients WHERE id = $1', [d.clientId]);
    const label = String(d.values.gst_label);
    const t = resolveTax({ taxMode: /rcm/i.test(label) ? 'RCM' : 'GST', gst: String(totalRate(label) ?? ''), taxLabel: label, cgst: null, sgst: null, igst: null }, c?.gstin?.slice(0, 2) ?? null, registrationState(c?.billing_registration));
    if (t.mode === 'CGST_SGST' || t.mode === 'IGST') await db.query('UPDATE clients SET cgst_rate = $2, sgst_rate = $3, igst_rate = $4 WHERE id = $1 AND (cgst_rate IS DISTINCT FROM $2 OR sgst_rate IS DISTINCT FROM $3 OR igst_rate IS DISTINCT FROM $4)', [d.clientId, t.cgst, t.sgst, t.igst]);
    if (t.mode === 'RCM') await db.query(`UPDATE clients SET gst_mode = 'rcm' WHERE id = $1`, [d.clientId]);
  }
  // Rates, department by department
  const groups = new Map<string, RateResult[]>();
  for (const r of a.rates) {
    const id = r.clientId ?? idByName.get(nk(r.department)) ?? null;
    if (!id) continue;
    r.clientId = id;
    groups.set(id, [...(groups.get(id) ?? []), r]);
  }
  for (const [clientId, list] of groups) {
    const writes = list.filter((r) => r.action === 'add' || r.action === 'update');
    const all = list.filter((r) => r.action !== 'error').map((r) => r.incoming);
    const plan = a.plans.find((p) => p.clientId === clientId) ?? a.plans.find((p) => p.department && list[0] && nk(p.department) === nk(list[0].clientName));
    if (!writes.length && !plan?.taxChange) continue;
    const contract = await rateCardContract(db, clientId, { create: true, startDate: o.newRatesFrom, userId });
    if (contract.created) out.contractsCreated++;
    const current = await currentRates(db, contract.id!, o.changesFrom);
    const local = localPackages(all);
    for (const r of writes) {
      const cat = await categoryFor(db, r.incoming.vehicle, false);
      const ex = findExistingRate(current, cat.id, r.incoming);
      const siblings = all.filter((e) => e.vehicle.toLowerCase() === r.incoming.vehicle.toLowerCase());
      await saveRate(db, { contractId: contract.id!, entry: r.incoming, siblings, effectiveFrom: ex ? o.changesFrom : o.newRatesFrom, options: o, userId, approve: o.approve, local: local.has(r.incoming), schemeId: ex?.schemeId, source: 'Department rate register' }, approveFn);
      if (ex) out.ratesUpdated++; else out.ratesAdded++;
    }
    if (plan?.tax) {
      const firstRates = !current.length;
      const changed = await syncTax(db, contract.id!, plan.tax, firstRates ? o.newRatesFrom : o.changesFrom, userId, o.approve);
      if (changed) out.taxUpdated.push(`${plan.department}: ${changed}`);
    }
  }
  return out;
}

// --- export ---------------------------------------------------------------------------

const HEAD_FILL = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF1F4E8C' } };

/** Writes the register from the software, in the same layout as the uploaded workbook. */
export async function exportRegister(db: Db, onDate: string): Promise<Buffer> {
  const clients = await db.query<Record<string, unknown> & { id: string; name: string; aliases: string[]; gstin: string | null; billing_registration: string | null }>(`SELECT * FROM clients WHERE status = 'active' ORDER BY name`);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LR Billing';
  const title = (ws: ExcelJS.Worksheet, text: string, sub: string, width: number) => {
    ws.mergeCells(1, 1, 1, width); ws.getCell(1, 1).value = text; ws.getCell(1, 1).font = { bold: true, size: 14, color: { argb: 'FF1F4E8C' } };
    ws.mergeCells(2, 1, 2, width); ws.getCell(2, 1).value = sub; ws.getCell(2, 1).font = { italic: true, size: 9 };
    ws.mergeCells(4, 1, 4, width); ws.getCell(4, 1).value = 'Edit values and upload this workbook again: only changed rows are updated, new rows are added, and nothing is deleted. Blank means "not set" — it is not ₹0.';
    ws.getCell(4, 1).font = { size: 9, color: { argb: 'FF9A6200' } };
  };
  const header = (ws: ExcelJS.Worksheet, row: number, labels: string[]) => {
    const r = ws.getRow(row);
    labels.forEach((l, i) => { const c = r.getCell(i + 1); c.value = l; c.font = { bold: true, color: { argb: 'FFFFFFFF' } }; c.fill = HEAD_FILL; c.alignment = { wrapText: true, vertical: 'middle' }; });
    r.height = 30;
  };

  // Department Master
  const dm = wb.addWorksheet('Department Master');
  const dmHead = ['S.No', 'Department / Institution', 'Original Department Name', 'GST Rate / Mode (Source List)', 'Billing Pattern', 'Billing Entity (FY 2026–2027)', 'Billing GST / Registration', 'Rate Card Source Key', 'Rate Status', 'Rate Entries', 'Vehicles with Rates', 'Packages / Duty Plans with Rates', 'Client GSTIN', 'Data Notes'];
  title(dm, 'DEPARTMENT MASTER | EXPORTED FROM LR BILLING', `Exported ${onDate}`, dmHead.length);
  header(dm, 6, dmHead);
  // Department Rate Register
  const rr = wb.addWorksheet('Department Rate Register');
  const rrHead = ['S.No', 'Department / Institution', 'Original Rate Card Name', 'Vehicle', 'Package / Duty Plan', 'Rate Type', 'Base Fare (₹)', 'Included Km', 'Included Hours', 'Extra Km Rate (₹)', 'Extra Hour Rate (₹)', 'Night Charge (₹/trip)', 'Night Starts', 'Night Ends', 'Driver Allowance (₹/day)', 'Tax Label (as shown)', 'Tax Mode', 'CGST (%)', 'SGST (%)', 'IGST (%)', 'GST (%)', 'Fixed Price Package?', 'Source Screenshot', 'Rate Data Status', 'Notes', 'Effective From'];
  title(rr, 'DEPARTMENT RATE REGISTER | EXPORTED FROM LR BILLING', `Rates in force on ${onDate}. One row per vehicle/package.`, rrHead.length);
  header(rr, 6, rrHead);
  let sno = 0;
  let dsno = 0;
  const numOrBlank = (v: string | null) => (v === null || v === undefined ? null : Number(v));
  for (const c of clients) {
    const contractId = (c.rate_card_contract_id as string | null) ?? (await db.one<{ id: string }>(`SELECT id FROM contracts WHERE client_id = $1 AND status = 'active' ORDER BY start_date DESC LIMIT 1`, [c.id]))?.id ?? null;
    const rates = contractId ? await currentRates(db, contractId, onDate) : [];
    const shown = rates.filter((r) => r.status === 'approved');
    const vehicles = [...new Set(shown.map((r) => r.entry.vehicle))].join(', ');
    const pkgs = [...new Set(shown.map((r) => r.entry.package))].join('; ');
    // Names the department is known by: the first is the original list name, the last the rate-card key.
    const others = ((c.aliases as string[] | null) ?? []).filter((a) => a !== c.name);
    const sourceKey = others.length ? others[others.length - 1]! : null;
    dm.addRow([++dsno, c.name, others[0] ?? null, c.gst_label ?? null, c.billing_pattern ?? null, c.billing_entity ?? null, c.billing_registration ?? null,
      sourceKey, shown.length ? 'Rates available' : 'No rate card found', shown.length, vehicles || null, pkgs || null, c.gstin ?? null, null]);
    if (!shown.length) {
      rr.addRow([++sno, c.name, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, null, 'No rate card found', 'No rate entered in the software.', null]);
      continue;
    }
    for (const r of shown) {
      const e = r.entry;
      const row = rr.addRow([++sno, c.name, sourceKey, e.vehicle, e.package, e.rateType === 'fixed' ? 'Fixed price' : 'Per km/hr', numOrBlank(e.baseFare), numOrBlank(e.includedKm), numOrBlank(e.includedHours),
        numOrBlank(e.extraKm), numOrBlank(e.extraHour), numOrBlank(e.nightCharge), e.nightStart, e.nightEnd, numOrBlank(e.driverAllowance), e.taxLabel, e.taxMode, numOrBlank(e.cgst), numOrBlank(e.sgst),
        numOrBlank(e.igst), numOrBlank(e.gst), e.rateType === 'fixed', e.source, 'Rate available', e.notes, r.effectiveFrom]);
      row.getCell(13).numFmt = '@';
      row.getCell(14).numFmt = '@';
    }
  }
  dm.columns.forEach((col, i) => (col.width = [6, 44, 34, 14, 20, 22, 16, 30, 16, 8, 30, 40, 18, 40][i]));
  rr.columns.forEach((col, i) => (col.width = [6, 40, 26, 16, 28, 11, 11, 9, 9, 10, 10, 10, 9, 9, 11, 16, 14, 7, 7, 7, 7, 9, 24, 14, 30, 12][i]));
  dm.views = [{ state: 'frozen', ySplit: 6 }];
  rr.views = [{ state: 'frozen', ySplit: 6 }];
  const guide = wb.addWorksheet('Guide & Notes');
  guide.addRow(['How re-uploading works']).font = { bold: true, size: 13 };
  for (const line of [
    'Departments are matched by name, alias, code or the abbreviation in brackets; a department not found is added.',
    'Rates are matched by department + vehicle + package. Only rows whose values changed are updated; changed rates apply from the date chosen during upload, so earlier duties and approved bills keep their rate.',
    'Rows or departments missing from the file are left unchanged — nothing is deleted. To stop a rate, use "End rate" on the Rate Card screen.',
    'Blank cells mean "not set"; enter 0 for a real zero. "GST %" alone becomes IGST or CGST+SGST from the Billing GST / Registration and the department\'s GSTIN.',
    `State codes: ${Object.entries(GST_STATES).filter(([k]) => ['03', '06', '07', '09', '27'].includes(k)).map(([k, v]) => `${k} ${v}`).join(', ')}.`,
  ]) guide.addRow([line]);
  guide.getColumn(1).width = 140;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const defaultFyStart = (today: string) => { const [y, m] = today.split('-').map(Number); return `${m >= 4 ? y : y - 1}-04-01`; };
export { addDays, ENTRY_LABELS };
