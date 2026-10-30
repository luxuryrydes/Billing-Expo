/**
 * From a reviewed slip reading to a duty: matching the department and contract, converting dates, times and
 * numbers, and saving through the same checks and change-only rules as every other duty entry route.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { addDays } from '../engine/time.js';
import { assertDutyEditable, computeIssues, contractCtx, diffDuty, DutyInputSchema, findSameDuty, insertDuty, mergeDuty, updateDuty, validationSettings, type ContractCtx, type DutyInputT } from './duties.js';
import { matchClient, type ClientKeyRow } from './departmentRates.js';
import { parseDate, parseNumber, parseTime } from './import.js';
import { SLIP_FIELDS, type FieldRead } from './slipReader.js';
import type { ValidationSettings } from '../engine/validate.js';

export type Values = Record<string, string | null>;
export interface ReadingRow { id: string; page_id: string; batch_id: string; status: string; fields: Record<string, FieldRead>; edited: Record<string, string | null>; contract_id: string | null; duty_id: string | null }

/** What the duty will be made from: a person's edit wins over what the AI read. */
export function effectiveValues(r: Pick<ReadingRow, 'fields' | 'edited'>): Values {
  const out: Values = {};
  for (const f of SLIP_FIELDS) {
    const e = r.edited?.[f.key];
    out[f.key] = e !== undefined ? (e === '' ? null : e) : (r.fields?.[f.key]?.value ?? null);
  }
  return out;
}

export interface Lookups {
  clients: ClientKeyRow[];
  contracts: { id: string; client_id: string; reference_no: string; status: string; start_date: string; end_date: string | null }[];
  categories: { id: string; name: string; aliases: string[] }[];
}
export async function loadLookups(db: Db): Promise<Lookups> {
  return {
    clients: await db.query<ClientKeyRow>('SELECT id, name, code, short_code, aliases, kind, gstin, billing_registration, rate_card_contract_id FROM clients'),
    contracts: await db.query(`SELECT id, client_id, reference_no, status, start_date, end_date FROM contracts WHERE status IN ('active','draft') ORDER BY start_date DESC`),
    categories: await db.query('SELECT id, name, aliases FROM vehicle_categories'),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[\s.-]+/g, '');

/** The client a slip's department name refers to, and the contract that covers the duty date. */
export function matchDepartment(lk: Lookups, department: string | null, dutyDate: string | null): { clientId: string; clientName: string; contractId: string | null } | null {
  if (!department?.trim()) return null;
  const hit = matchClient(lk.clients, department.trim());
  let client = hit.client;
  if (!client) { // "Ministry of Health" on the slip, "MINISTRY OF HEALTH AND WELFARE" in the master: accept a single unambiguous containment
    const d = norm(department);
    const found = lk.clients.filter((c) => d.length >= 5 && (norm(c.name).includes(d) || d.includes(norm(c.name)) || (c.aliases ?? []).some((a) => norm(a).length >= 4 && (norm(a) === d))));
    if (found.length === 1) client = found[0];
  }
  if (!client) return null;
  const mine = lk.contracts.filter((k) => k.client_id === client!.id);
  const covering = dutyDate ? mine.filter((k) => k.status === 'active' && k.start_date <= dutyDate && (!k.end_date || dutyDate <= k.end_date)) : mine.filter((k) => k.status === 'active');
  const preferred = covering.find((k) => k.id === client!.rate_card_contract_id) ?? covering[0] ?? null;
  return { clientId: client.id, clientName: client.name, contractId: preferred?.id ?? null };
}

export function matchCategory(lk: Lookups, ...texts: (string | null)[]): { id: string; name: string } | null {
  for (const t of texts) {
    if (!t) continue;
    const n = norm(t);
    const hit = lk.categories.find((c) => norm(c.name) === n) ?? lk.categories.find((c) => (c.aliases ?? []).some((a) => norm(a) === n));
    if (hit) return { id: hit.id, name: hit.name };
  }
  return null;
}

export interface Problem { field: string | null; severity: 'error' | 'warning'; message: string }
const cell = (v: string | null) => (v === null ? undefined : { text: v });

export interface BuiltDuty { input: DutyInputT | null; contractId: string | null; problems: Problem[] }

/** Converts reviewed values to a duty. Anything that cannot be converted is reported, never guessed. */
export function buildDuty(values: Values, o: { contractId: string | null; lookups: Lookups; batchTitle: string; position: number; defaultDutyType: string | null }): BuiltDuty {
  const problems: Problem[] = [];
  const bad = (field: string | null, message: string, severity: Problem['severity'] = 'error') => problems.push({ field, severity, message });

  const dutyDate = parseDate(cell(values.duty_date));
  if (!dutyDate) bad('duty_date', values.duty_date ? `The date "${values.duty_date}" could not be read` : 'The date of duty is missing');
  const reg = values.vehicle_no?.replace(/\s+/g, '').toUpperCase() || null;
  if (!reg) bad('vehicle_no', 'The vehicle number is missing');

  const match = matchDepartment(o.lookups, values.department, dutyDate);
  let contractId = o.contractId ?? match?.contractId ?? null;
  if (!contractId) bad('department', values.department ? `No active contract was found for "${values.department}"${match ? ` (${match.clientName})` : ''} on that date: choose the contract` : 'Choose the contract for this slip');

  const st = parseTime(cell(values.reporting_time));
  const et = parseTime(cell(values.release_time));
  for (const [k, raw, v] of [['reporting_time', values.reporting_time, st], ['release_time', values.release_time, et]] as const) if (raw && !v) bad(k, `The time "${raw}" could not be read`);
  let startAt: string | null = dutyDate && st ? `${dutyDate} ${st}` : null;
  let endAt: string | null = dutyDate && et ? `${dutyDate} ${et}` : null;
  if (dutyDate && st && et && et < st) { endAt = `${addDays(dutyDate, 1)} ${et}`; bad('release_time', `Release time ${et} is earlier than reporting time ${st}; treated as next-day release (${addDays(dutyDate, 1)}). Confirm against the slip.`, 'warning'); }

  const num = (k: string) => parseNumber(cell(values[k] ?? null));
  for (const f of SLIP_FIELDS.filter((x) => x.kind === 'number')) {
    const v = num(f.key);
    if (v !== null && !/^-?\d+(\.\d+)?$/.test(v)) bad(f.key, `${f.label} "${values[f.key]}" is not a number`);
  }
  const open = num('opening_km');
  const close = num('closing_km');
  const total = num('total_km');
  if (open !== null && close !== null && total !== null && /^[\d.]+$/.test(open + close + total) && Math.abs(Number(close) - Number(open) - Number(total)) > 0.5) {
    bad('total_km', `Closing − opening km is ${Number(close) - Number(open)}, but the slip says total km ${total}. Check the odometer figures on the slip.`, 'warning');
  }
  if (values.signature && /not signed|unclear/i.test(values.signature)) bad('signature', values.signature.toLowerCase().includes('not') ? 'The slip is not signed by the user' : 'The signature could not be confirmed', 'warning');

  const cat = matchCategory(o.lookups, values.vehicle_category, values.vehicle_model);
  if (!cat && (values.vehicle_category || values.vehicle_model)) bad('vehicle_category', `Vehicle type "${values.vehicle_category ?? values.vehicle_model}" does not match a vehicle category or its alias names`, 'warning');

  if (!dutyDate || !reg || !contractId) return { input: null, contractId, problems };
  const remarks = [
    values.slip_no ? `Slip no. ${values.slip_no}` : null,
    values.reporting_location || values.destination ? `${values.reporting_location ?? '—'} → ${values.destination ?? '—'}` : null,
    values.driver_mobile ? `Driver mobile ${values.driver_mobile}` : null,
    num('night_charges') && Number(num('night_charges')) > 0 ? `Night charges on slip: ${num('night_charges')}` : null,
    values.signature ? `Signature: ${values.signature}` : null,
    values.remarks,
  ].filter(Boolean).join(' | ');
  const parsed = DutyInputSchema.safeParse({
    contractId, dutyDate, vehicleCategoryId: cat?.id ?? null, vehicleModel: values.vehicle_model || values.vehicle_category || null, vehicleRegNo: reg,
    driverName: values.driver_name, fieldOfficer: values.officer, dutyTypeCode: o.defaultDutyType,
    startKm: open, endKm: close, startAt, endAt, toll: num('toll'), parking: num('parking'), otherCharges: num('other_expenses'),
    remarks: remarks || null, supportingDocRef: `Scan "${o.batchTitle}" page ${o.position}${values.slip_no ? ` · slip ${values.slip_no}` : ''}`, customFields: {},
  });
  if (!parsed.success) {
    for (const i of parsed.error.issues) bad(String(i.path[0] ?? ''), `${i.path.join('.')}: ${i.message}`);
    return { input: null, contractId, problems };
  }
  return { input: parsed.data, contractId, problems };
}

export interface SaveResult {
  readingId: string; pageId: string; action: 'add' | 'update' | 'unchanged' | 'locked' | 'error'; dutyId: string | null;
  problems: Problem[]; issues: { code: string; severity: string; message: string }[]; changes?: { field: string; from: string | null; to: string | null }[];
}

/**
 * Saves reviewed slips as duties. A slip already saved is updated in place; a slip that matches a duty already
 * in the register (same contract, vehicle, date and start) fills it in without creating a second one. Duties on
 * an approved bill are left as they are and reported.
 */
export async function saveReadings(db: Db, userId: string, batch: { id: string; title: string }, readings: ReadingRow[], positions: Map<string, number>,
  o: { contractIds?: Record<string, string>; defaultDutyType: string | null; dryRun: boolean }): Promise<SaveResult[]> {
  const lookups = await loadLookups(db);
  const results: SaveResult[] = [];
  const work = async (t: Db) => {
    const ctxCache = new Map<string, { k: ContractCtx; s: ValidationSettings }>();
    const taken = new Set<string>();
    for (const r of readings) {
      const built = buildDuty(effectiveValues(r), { contractId: o.contractIds?.[r.id] ?? r.contract_id, lookups, batchTitle: batch.title, position: positions.get(r.page_id) ?? 0, defaultDutyType: o.defaultDutyType });
      const base = { readingId: r.id, pageId: r.page_id, problems: built.problems, issues: [] as SaveResult['issues'] };
      if (!built.input) { results.push({ ...base, action: 'error', dutyId: r.duty_id }); continue; }
      let c = ctxCache.get(built.input.contractId);
      if (!c) { const k = await contractCtx(t, built.input.contractId); c = { k, s: await validationSettings(t, k) }; ctxCache.set(built.input.contractId, c); }
      let existing: Record<string, unknown> | null = null;
      if (r.duty_id) existing = await t.one('SELECT * FROM duties WHERE id = $1', [r.duty_id]);
      else existing = await findSameDuty(t, built.input, taken);
      if (existing) {
        taken.add(String(existing.id));
        const locked = await assertDutyEditable(t, String(existing.id)).then(() => null, (e: Error) => e.message);
        // A slip that was saved before is replaced by exactly what is on screen; otherwise blank cells keep the saved value.
        const { merged, changes } = r.duty_id ? { merged: { ...built.input, id: String(existing.id) } as DutyInputT, changes: diffDuty(existing, built.input) } : mergeDuty(existing, built.input);
        if (!changes.length) { results.push({ ...base, action: 'unchanged', dutyId: String(existing.id) }); if (!o.dryRun) await t.query('UPDATE slip_readings SET duty_id = $2, contract_id = $3, updated_at = now() WHERE id = $1', [r.id, existing.id, built.contractId]); continue; }
        if (locked) { results.push({ ...base, action: 'locked', dutyId: String(existing.id), problems: [...built.problems, { field: null, severity: 'warning', message: locked }], changes }); continue; }
        const issues = await computeIssues(t, merged, c.k, c.s);
        results.push({ ...base, action: 'update', dutyId: String(existing.id), issues, changes });
        if (!o.dryRun) {
          await updateDuty(t, merged, c.k, issues, userId);
          await audit(t, userId, 'duty', String(existing.id), 'scan_update', undefined, { batch: batch.id, reading: r.id, changes });
          await t.query('UPDATE slip_readings SET duty_id = $2, contract_id = $3, updated_at = now() WHERE id = $1', [r.id, existing.id, built.contractId]);
        }
        continue;
      }
      const issues = await computeIssues(t, built.input, c.k, c.s);
      if (o.dryRun) { results.push({ ...base, action: 'add', dutyId: null, issues }); continue; }
      const row = await insertDuty(t, built.input, c.k, issues, userId, 'import');
      taken.add(String(row!.id));
      await audit(t, userId, 'duty', String(row!.id), 'scan_import', undefined, { batch: batch.id, reading: r.id });
      await t.query('UPDATE slip_readings SET duty_id = $2, contract_id = $3, updated_at = now() WHERE id = $1', [r.id, row!.id, built.contractId]);
      results.push({ ...base, action: 'add', dutyId: String(row!.id), issues });
    }
  };
  if (o.dryRun) await work(db); else await db.tx(work);
  return results;
}
