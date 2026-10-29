/**
 * Test support: a TypeScript port of the row and total arithmetic in the LR Taxi Services source app
 * (src/lib/bill-template.ts, buildBillDoc). Units × rate are kept exactly, taxable is the sum of those
 * exact amounts, GST is charged on that sum and the grand total goes to the whole rupee.
 * Used only by tests, to prove the "LR exact" arithmetic reproduces what that app prints.
 */
export interface RefTrip { km: number; hr: number; days?: number; toll?: number; parking?: number }
export interface RefPkg { base: number; incKm: number; incHr: number; exKm: number; exHr: number; driver?: number }

export function refAmounts(t: RefTrip, p: RefPkg) {
  const days = Math.max(1, Math.floor(t.days ?? 1));
  const incKm = p.incKm * days;
  const incHr = p.incHr * days;
  const extraKm = Math.max(0, t.km - incKm);
  const extraHr = p.incHr > 0 ? Math.max(0, t.hr - incHr) : 0;
  const taxable = p.base * days + extraHr * p.exHr + extraKm * p.exKm + (p.driver ?? 0) * days;
  return { taxable, nonTaxable: (t.toll ?? 0) + (t.parking ?? 0) };
}

export type RefMode = 'include' | 'show_separate' | 'rcm_note';

export function refBill(trips: RefTrip[], p: RefPkg, pct: { cgst?: number; sgst?: number; igst?: number }, mode: RefMode = 'include') {
  let taxable = 0;
  let nonTaxable = 0;
  for (const t of trips) { const a = refAmounts(t, p); taxable += a.taxable; nonTaxable += a.nonTaxable; }
  const cgst = mode === 'rcm_note' ? 0 : (taxable * (pct.cgst ?? 0)) / 100;
  const sgst = mode === 'rcm_note' ? 0 : (taxable * (pct.sgst ?? 0)) / 100;
  const igst = mode === 'rcm_note' ? 0 : (taxable * (pct.igst ?? 0)) / 100;
  const grand = mode === 'include' ? taxable + cgst + sgst + igst + nonTaxable : taxable + nonTaxable;
  return { taxable, cgst, sgst, igst, nonTaxable, grand, rounded: Math.round(grand) };
}

/** Closing time for a duty that starts at 09:00 and runs `hours` (a multiple of 0.25). */
export function closingTime(hours: number): string {
  const mins = Math.round(hours * 60);
  return `${String(9 + Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}
