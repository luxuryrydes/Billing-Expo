/**
 * Contract extensions: the arithmetic on dates, the checks that flag a letter for a person's attention, and applying a
 * confirmed extension. The original dates are kept; each applied extension moves the contract's current end date,
 * and the dates it replaced are stored with the extension so the whole history can be shown.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { addDays, daysBetweenInclusive } from '../engine/time.js';

export const isIso = (s: string | null | undefined): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s)) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
export const today = () => new Date().toISOString().slice(0, 10);

/** Whole years, months and days from `from` to `to`, both days counted (31 Mar → 30 Sep is 6 months). */
export function period(from: string, to: string): { days: number; years: number; months: number; extraDays: number; text: string } {
  const days = daysBetweenInclusive(from, to);
  const end = addDays(to, 1);                                  // the day after the last day, so a full month ends on its last day
  const [fy, fm, fd] = from.split('-').map(Number);
  const [ey, em, ed] = end.split('-').map(Number);
  let months = (ey - fy) * 12 + (em - fm);
  if (ed < fd) months -= 1;
  const mid = new Date(Date.UTC(fy, fm - 1 + months, fd));
  const extraDays = Math.round((Date.UTC(ey, em - 1, ed) - mid.getTime()) / 86_400_000);
  const years = Math.floor(months / 12);
  const m = months % 12;
  const parts = [years ? `${years} year${years === 1 ? '' : 's'}` : '', m ? `${m} month${m === 1 ? '' : 's'}` : '', extraDays ? `${extraDays} day${extraDays === 1 ? '' : 's'}` : ''].filter(Boolean);
  return { days, years, months: m, extraDays, text: `${parts.join(' ') || '0 days'} (${days} days)` };
}

export interface Conflict { severity: 'error' | 'warning'; message: string }
interface ExtRow { id: string; contract_id: string; letter_no: string | null; letter_date: string | null; previous_end_date: string | null; extension_start: string | null; new_end_date: string | null; status: string }
interface ContractRow { id: string; start_date: string; end_date: string | null; status: string }

/** What a person must look at before this extension can be applied. Errors block it; warnings need an explicit acknowledgement. */
export async function findConflicts(db: Db, e: ExtRow, k: ContractRow): Promise<Conflict[]> {
  const out: Conflict[] = [];
  const err = (message: string) => out.push({ severity: 'error', message });
  const warn = (message: string) => out.push({ severity: 'warning', message });
  if (!k.end_date) { err('This contract has no end date to extend. Set its end date first (Edit contract).'); return out; }
  if (!isIso(e.new_end_date)) { err('The new end date is missing or not a valid date.'); return out; }
  if (e.new_end_date <= k.end_date) err(`The new end date ${e.new_end_date} is not after the contract's current end date ${k.end_date}, so this is not an extension.`);
  if (e.previous_end_date && e.previous_end_date !== k.end_date) warn(`The letter says the contract ended on ${e.previous_end_date}, but the contract here ends on ${k.end_date}. An earlier extension may be missing.`);
  if (e.extension_start) {
    if (!isIso(e.extension_start)) err('The extension start date is not a valid date.');
    else if (e.extension_start > addDays(k.end_date, 1)) warn(`The extension starts on ${e.extension_start}, leaving a gap after the contract end date ${k.end_date}.`);
    else if (e.extension_start <= k.end_date) warn(`The extension starts on ${e.extension_start}, which overlaps the current contract period (ends ${k.end_date}).`);
    if (isIso(e.extension_start) && e.extension_start >= e.new_end_date) err('The extension start date must be before the new end date.');
  }
  if (!e.letter_no) warn('The letter number is missing, so a repeat of this letter cannot be detected.');
  if (!e.letter_date) warn('The letter date is missing.');
  if (e.letter_date && !isIso(e.letter_date)) err('The letter date is not a valid date.');
  const from = e.extension_start && isIso(e.extension_start) ? e.extension_start : addDays(k.end_date, 1);
  if (e.new_end_date > from && daysBetweenInclusive(from, e.new_end_date) > 5 * 366) warn('This extension is longer than five years. Check the dates against the letter.');
  if (e.letter_no) {
    const same = await db.one<{ id: string }>(`SELECT id FROM contract_extensions WHERE contract_id = $1 AND id <> $2 AND status = 'applied' AND lower(letter_no) = lower($3)`, [k.id, e.id, e.letter_no]);
    if (same) err(`A letter numbered "${e.letter_no}" has already been applied to this contract.`);
  }
  const other = await db.one<{ id: string }>(`SELECT id FROM contract_extensions WHERE contract_id = $1 AND id <> $2 AND status = 'pending' AND new_end_date = $3`, [k.id, e.id, e.new_end_date]);
  if (other) warn(`Another extension waiting for approval ends on the same date (${e.new_end_date}). It may be the same letter.`);
  return out;
}

/** Applies a confirmed extension: the contract's end date moves, the original is kept, the old dates are recorded. */
export async function applyExtension(db: Db, id: string, userId: string, acknowledge: boolean) {
  return db.tx(async (t) => {
    const e = await t.one<ExtRow & { status: string }>('SELECT * FROM contract_extensions WHERE id = $1 FOR UPDATE', [id]);
    if (!e) throw notFound('Extension');
    if (e.status !== 'pending') throw conflict(`This extension is already ${e.status}.`);
    const k = await t.one<ContractRow>('SELECT id, start_date, end_date, status FROM contracts WHERE id = $1 FOR UPDATE', [e.contract_id]);
    if (!k) throw notFound('Contract');
    const conflicts = await findConflicts(t, e, k);
    const errors = conflicts.filter((c) => c.severity === 'error');
    if (errors.length) throw badRequest(`This extension cannot be applied: ${errors.map((c) => c.message).join(' ')}`, conflicts);
    if (conflicts.length && !acknowledge) throw badRequest(`Please review these points and confirm you want to apply the extension anyway: ${conflicts.map((c) => c.message).join(' ')}`, conflicts);
    const newEnd = e.new_end_date!;
    // A contract that had been marked expired is active again when the new end date is still ahead; other statuses are left as they are.
    const status = k.status === 'expired' && newEnd >= today() ? 'active' : k.status;
    await t.query('UPDATE contracts SET original_end_date = COALESCE(original_end_date, end_date), end_date = $2, status = $3, updated_at = now() WHERE id = $1', [k.id, newEnd, status]);
    await t.query(
      `UPDATE contract_extensions SET status = 'applied', applied_by = $2, applied_at = now(), reviewed_by = $2, conflicts = $3,
         applied_prev_start = $4, applied_prev_end = $5, applied_prev_status = $6 WHERE id = $1`,
      [id, userId, JSON.stringify(conflicts), k.start_date, k.end_date, k.status]);
    await audit(t, userId, 'contract', k.id, 'extend_contract', { end_date: k.end_date, status: k.status }, { end_date: newEnd, status, extension: id, letter_no: e.letter_no }, e.letter_no ? `Extension letter ${e.letter_no}` : undefined);
    return { contractId: k.id, previousEnd: k.end_date, newEnd, status };
  });
}

/** The contract's dates and every extension, for the Contracts screen. */
export async function extensionSummary(db: Db, contractId: string) {
  const k = await db.one<{ start_date: string; end_date: string | null; original_end_date: string | null; status: string }>('SELECT start_date, end_date, original_end_date, status FROM contracts WHERE id = $1', [contractId]);
  if (!k) throw notFound('Contract');
  const rows = await db.query<Record<string, unknown>>(
    `SELECT x.*, f.original_name AS file_name, f.mime_type, u.name AS uploaded_by_name, a.name AS applied_by_name
     FROM contract_extensions x JOIN files f ON f.id = x.file_id LEFT JOIN app_users u ON u.id = x.uploaded_by LEFT JOIN app_users a ON a.id = x.applied_by
     WHERE x.contract_id = $1 ORDER BY x.uploaded_at`, [contractId]);
  const applied = rows.filter((r) => r.status === 'applied');
  const originalEnd = k.original_end_date ?? k.end_date;
  const extensions = rows.map((r) => {
    const from = r.status === 'applied' ? (r.extension_start as string | null) ?? (r.applied_prev_end ? addDays(String(r.applied_prev_end), 1) : null) : (r.extension_start as string | null);
    const to = r.new_end_date as string | null;
    return { ...r, duration: from && isIso(from) && to && isIso(to) && to >= from ? period(from, to) : null };
  });
  const added = applied.reduce((a, r) => a + (r.applied_prev_end && r.new_end_date ? daysBetweenInclusive(String(r.applied_prev_end), String(r.new_end_date)) - 1 : 0), 0);
  return {
    contract: { startDate: k.start_date, originalEndDate: originalEnd, currentEndDate: k.end_date, status: k.status },
    totalAddedDays: added,
    totalAdded: applied.length && originalEnd && k.end_date ? period(addDays(originalEnd, 1), k.end_date) : null,
    totalValidity: k.end_date ? period(k.start_date, k.end_date) : null,
    extensions,
  };
}
