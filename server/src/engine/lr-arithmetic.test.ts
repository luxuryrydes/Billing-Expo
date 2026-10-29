/**
 * "LR exact" arithmetic: the way the LR Taxi Services merged invoice prints its amounts.
 * The reference below is a TypeScript port of the row and total arithmetic in the source app's
 * bill-template.ts (src/lib/bill-template.ts, buildBillDoc): units × rate kept exactly, taxable =
 * sum of the exact amounts, GST on that sum, grand total rounded to the whole rupee.
 * Rates here are TEST values, not any department's contract rates.
 */
import { describe, expect, it } from 'vitest';
import { calculateBill } from './bill.js';
import { closingTime, refBill, type RefPkg, type RefTrip } from './lr-reference.js';
import { RateConfigSchema, type BillSettings, type DutyInput, type SchemeVersion, type TaxRuleInput } from './types.js';

// --- engine side ------------------------------------------------------------------------------
const CAT = 'cat-test';
const cfg = (p: RefPkg) => RateConfigSchema.parse({
  billingModel: 'daily_package',
  params: { includedKm: String(p.incKm), includedHours: String(p.incHr), hourRounding: { mode: 'exact', unit: '60' } },
  components: [
    { code: 'BASE', label: 'Base', quantityExpr: '1', rate: String(p.base), unit: 'duty', taxCategory: 'taxable' },
    { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: String(p.exKm), unit: 'km', taxCategory: 'taxable' },
    { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: String(p.exHr), unit: 'hr', taxCategory: 'taxable' },
    { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
    { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
  ],
});
const scheme = (p: RefPkg): SchemeVersion => ({
  id: 'v1', schemeId: 's1', schemeName: 'Test', versionNo: 1, status: 'approved', effectiveFrom: '2025-01-01', effectiveTo: null, vehicleCategoryIds: [CAT], dutyTypeCodes: [], config: cfg(p),
});
let seq = 0;
/** A one-day duty of `hours` (a multiple of 0.25) and `km` kilometres. */
const duty = (km: number, hours: number, o: Partial<DutyInput> = {}): DutyInput => (
  { id: 'd' + ++seq, dutyDate: '2025-09-10', vehicleRegNo: 'DL01AB0012', vehicleCategoryId: CAT, dutyTypeCode: null, startKm: '1000', endKm: String(1000 + km), startAt: '2025-09-10 09:00', endAt: `2025-09-10 ${closingTime(hours)}`, toll: null, parking: null, otherCharges: null, ...o }
);
const rule = (taxType: string, rate: string): TaxRuleInput => ({ id: 't-' + taxType, name: taxType, taxType, rate, effectiveFrom: '2025-01-01', effectiveTo: null, status: 'approved' });
const CGST_SGST = [rule('CGST', '2.5'), rule('SGST', '2.5')];
const LR: BillSettings = { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'none', arithmetic: 'lr_exact' };
const run = (duties: DutyInput[], p: RefPkg, taxRules: TaxRuleInput[], settings: BillSettings = LR) =>
  calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', duties, schemes: [scheme(p)], taxRules, settings });
const taxOf = (o: ReturnType<typeof run>, type: string) => Number(o.taxLines.find((t) => t.taxType === type)?.amount ?? 0);

const PKG: RefPkg = { base: 2400, incKm: 80, incHr: 8, exKm: 20, exHr: 331.43 };
const TRIPS: { t: RefTrip; d: DutyInput }[] = [
  { t: { km: 80, hr: 8 }, d: duty(80, 8) },
  { t: { km: 95, hr: 10.75, toll: 120 }, d: duty(95, 10.75, { toll: '120' }) },
  { t: { km: 104, hr: 11.75, parking: 50 }, d: duty(104, 11.75, { parking: '50' }) },
  { t: { km: 33, hr: 4.25 }, d: duty(33, 4.25) },
  { t: { km: 120, hr: 11.25, toll: 35 }, d: duty(120, 11.25, { toll: '35' }) },
];

describe('LR exact arithmetic matches the source app', () => {
  it('prints the same taxable amount, GST and whole-rupee total on a multi-duty bill', () => {
    const ref = refBill(TRIPS.map((x) => x.t), PKG, { cgst: 2.5, sgst: 2.5 });
    const out = run(TRIPS.map((x) => x.d), PKG, CGST_SGST);
    expect(out.exceptions).toEqual([]);
    expect(out.totals.taxableValue).toBe(ref.taxable.toFixed(2));
    expect(taxOf(out, 'CGST').toFixed(2)).toBe(ref.cgst.toFixed(2));
    expect(taxOf(out, 'SGST').toFixed(2)).toBe(ref.sgst.toFixed(2));
    expect(out.totals.nonTaxableTotal).toBe(ref.nonTaxable.toFixed(2));
    expect(out.totals.grandTotal).toBe(`${ref.rounded}.00`);
    expect(out.checks.every((c) => c.ok)).toBe(true);
  });

  it('keeps unit × rate exactly (3.25 h × 331.43 = 1077.1475) instead of rounding each line to paise', () => {
    const out = run([duty(80, 11.25)], PKG, CGST_SGST);
    expect(out.lines.find((l) => l.componentCode === 'EXHR')!.amount).toBe('1077.1475');
    const standard = run([duty(80, 11.25)], PKG, CGST_SGST, { ...LR, arithmetic: 'standard' });
    expect(standard.lines.find((l) => l.componentCode === 'EXHR')!.amount).toBe('1077.15');
  });

  it('rounds the grand total half-up to the whole rupee (1060.50 → 1061)', () => {
    const p: RefPkg = { base: 1010, incKm: 80, incHr: 8, exKm: 0, exHr: 0 };
    const ref = refBill([{ km: 10, hr: 2 }], p, { cgst: 2.5, sgst: 2.5 });
    expect(ref.grand).toBe(1060.5);
    const out = run([duty(10, 2)], p, CGST_SGST);
    expect(out.totals.grandTotal).toBe('1061.00');
    expect(out.totals.roundOff).toBe('0.50');
    expect(ref.rounded).toBe(1061);
  });

  it('IGST is taxable × rate / 100 with no rounding before the total', () => {
    const ref = refBill(TRIPS.map((x) => x.t), PKG, { igst: 18 });
    const out = run(TRIPS.map((x) => x.d), PKG, [rule('IGST', '18')]);
    expect(taxOf(out, 'IGST').toFixed(2)).toBe(ref.igst.toFixed(2));
    expect(out.totals.grandTotal).toBe(`${ref.rounded}.00`);
  });

  it('show_separate prints the tax but leaves it out of the amount payable (SAIL)', () => {
    const ref = refBill(TRIPS.map((x) => x.t), PKG, { cgst: 2.5, sgst: 2.5 }, 'show_separate');
    const out = run(TRIPS.map((x) => x.d), PKG, CGST_SGST, { ...LR, gstPresentation: 'show_separate' });
    expect(out.taxLines).toHaveLength(2);
    expect(taxOf(out, 'CGST')).toBeGreaterThan(0);
    expect(out.totals.grandTotal).toBe(`${ref.rounded}.00`);
    expect(out.checks.every((c) => c.ok)).toBe(true);
  });

  it('reverse charge adds no tax and needs no tax rule', () => {
    const ref = refBill(TRIPS.map((x) => x.t), PKG, { cgst: 2.5, sgst: 2.5 }, 'rcm_note');
    const out = run(TRIPS.map((x) => x.d), PKG, [], { ...LR, gstPresentation: 'rcm_note' });
    expect(out.exceptions.find((e) => e.code === 'TAX_NOT_CONFIGURED')).toBeUndefined();
    expect(out.taxLines).toHaveLength(0);
    expect(out.totals.grandTotal).toBe(`${ref.rounded}.00`);
  });

  it('standard arithmetic is unchanged: lines and tax are rounded to paise', () => {
    const out = run([duty(80, 11.25)], PKG, CGST_SGST, { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'none' });
    expect(out.lines.every((l) => /^-?\d+\.\d{2}$/.test(l.amount))).toBe(true);
    expect(out.totals.grandTotal).toMatch(/\.\d{2}$/);
    expect(out.totals.roundOff).toBe('0.00');
  });
});
