/**
 * Calculation engine tests. Every expected amount below is worked out by hand
 * from the TEST rules defined in this file — they are not DRI contract rates.
 */
import { describe, expect, it } from 'vitest';
import { calculateBill } from './bill.js';
import { calculateDuty } from './duty.js';
import { evaluate, evaluateNumber, ExprError } from './expr.js';
import { nightOverlap, toMinutes } from './time.js';
import { RateConfigSchema, type DutyInput, type SchemeVersion, type TaxRuleInput, type BillSettings } from './types.js';
import { DEFAULT_VALIDATION, validateDuty } from './validate.js';

const INNOVA = 'cat-innova';
const DZIRE = 'cat-dzire';

function packageConfig(base: string, opts: Partial<{ extraKm: string; extraHr: string; hourMode: 'exact' | 'ceil'; grace: number; night: boolean }> = {}) {
  return RateConfigSchema.parse({
    billingModel: 'daily_package',
    params: {
      includedKm: '80',
      includedHours: '8',
      graceMinutes: opts.grace ?? 0,
      hourRounding: { mode: opts.hourMode ?? 'exact', unit: '60' },
      night: { enabled: opts.night ?? false, start: '22:00', end: '06:00', minOverlapMinutes: 1, countMode: 'per_night' },
    },
    components: [
      { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: base, unit: 'duty', taxCategory: 'taxable' },
      { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: opts.extraKm ?? '18', unit: 'km', taxCategory: 'taxable' },
      { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: opts.extraHr ?? '200', unit: 'hr', taxCategory: 'taxable' },
      { code: 'NIGHT', label: 'Night charge', quantityExpr: 'night_count', rate: '250', unit: 'night', taxCategory: 'taxable' },
      { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
      { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
    ],
  });
}

function version(id: string, cfg: ReturnType<typeof packageConfig>, o: Partial<SchemeVersion> = {}): SchemeVersion {
  return {
    id, schemeId: 's-' + id, schemeName: 'Test ' + id, versionNo: 1, status: 'approved',
    effectiveFrom: '2025-01-01', effectiveTo: null, vehicleCategoryIds: [INNOVA], dutyTypeCodes: [], config: cfg, ...o,
  };
}

let seq = 0;
function duty(o: Partial<DutyInput>): DutyInput {
  return {
    id: 'd' + ++seq, dutyDate: '2025-09-10', vehicleRegNo: 'DL01AB0012', vehicleCategoryId: INNOVA, vehicleCategoryName: 'Innova',
    dutyTypeCode: 'LOCAL', startKm: '1000', endKm: '1070', startAt: '2025-09-10 09:00', endAt: '2025-09-10 17:00',
    toll: null, parking: null, otherCharges: null, ...o,
  };
}

const amounts = (lines: { componentCode: string; amount: string }[]) => Object.fromEntries(lines.map((l) => [l.componentCode, l.amount]));

const GST: TaxRuleInput[] = [
  { id: 't1', name: 'CGST (test)', taxType: 'CGST', rate: '2.5', effectiveFrom: '2025-01-01', effectiveTo: null, status: 'approved' },
  { id: 't2', name: 'SGST (test)', taxType: 'SGST', rate: '2.5', effectiveFrom: '2025-01-01', effectiveTo: null, status: 'approved' },
];
const SETTINGS: BillSettings = { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'nearest_rupee' };

describe('expression language', () => {
  it('evaluates arithmetic with decimals exactly', () => {
    expect(evaluateNumber('0.1 + 0.2', {}).value.toString()).toBe('0.3');
    expect(evaluateNumber('max(0, 125 - 80) * 18', {}).value.toString()).toBe('810');
    expect(evaluateNumber('ceil(2.1)', {}).value.toString()).toBe('3');
    expect(evaluateNumber('ceil(2.1, 0.5)', {}).value.toString()).toBe('2.5');
    expect(evaluateNumber('round(93.345, 2)', {}).value.toString()).toBe('93.35');
  });
  it('supports conditions and strings', () => {
    expect(evaluate("if(duty_type == 'OUT', 2, 1)", { duty_type: 'OUT' }).value.toString()).toBe('2');
    expect(evaluate("in(duty_type, 'A', 'B')", { duty_type: 'C' }).value).toBe(false);
    expect(evaluate('x > 5 && y <= 2', evaluateScope({ x: '6', y: '2' })).value).toBe(true);
  });
  it('rejects unknown functions, variables and code', () => {
    expect(() => evaluate('process.exit(1)', {})).toThrow(ExprError);
    expect(() => evaluate('foo + 1', {})).toThrow(/Unknown variable "foo"/);
    expect(() => evaluate('1 / 0', {})).toThrow(/Division by zero/);
    expect(() => evaluate('1 +', {})).toThrow(ExprError);
  });
});

function evaluateScope(o: Record<string, string>) {
  return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, evaluateNumber(v, {}).value]));
}

describe('time handling', () => {
  it('handles cross-midnight duty with full date-times', () => {
    const s = toMinutes('2025-09-10 20:00')!;
    const e = toMinutes('2025-09-11 02:30')!;
    expect(e - s).toBe(390);
  });
  it('rejects impossible dates', () => {
    expect(toMinutes('2025-02-30 10:00')).toBeNull();
    expect(toMinutes('2025-09-10 25:00')).toBeNull();
  });
  it('counts night windows', () => {
    const s = toMinutes('2025-09-10 20:00')!;
    expect(nightOverlap(s, toMinutes('2025-09-11 02:30')!, '22:00', '06:00', 1)).toEqual({ nights: 1, minutes: 270 });
    expect(nightOverlap(s, toMinutes('2025-09-12 01:00')!, '22:00', '06:00', 1).nights).toBe(2);
    expect(nightOverlap(toMinutes('2025-09-10 09:00')!, toMinutes('2025-09-10 17:00')!, '22:00', '06:00', 1).nights).toBe(0);
    // early-morning start inside previous evening's window
    expect(nightOverlap(toMinutes('2025-09-10 05:00')!, toMinutes('2025-09-10 12:00')!, '22:00', '06:00', 30)).toEqual({ nights: 1, minutes: 60 });
  });
});

describe('duty calculation', () => {
  const v = version('v1', packageConfig('3200'));
  it('base package only (70 km, 8 h)', () => {
    const r = calculateDuty(duty({}), v);
    expect(amounts(r.lines)).toEqual({ BASE: '3200.00' });
  });
  it('kilometre excess: 125 km → 45 extra km × 18 = 810', () => {
    const r = calculateDuty(duty({ endKm: '1125' }), v);
    expect(amounts(r.lines)).toEqual({ BASE: '3200.00', EXKM: '810.00' });
    expect(r.lines[1].trace.inputs.extra_km).toBe('45');
    expect(r.lines[1].trace.formula).toBe('45 km × ₹18.00 = ₹810.00');
  });
  it('hour excess exact: 10.5 h → 2.5 h × 200 = 500', () => {
    const r = calculateDuty(duty({ endAt: '2025-09-10 19:30' }), v);
    expect(amounts(r.lines)).toEqual({ BASE: '3200.00', EXHR: '500.00' });
  });
  it('hour excess with ceil-to-hour rounding: 2.5 h → 3 h × 200 = 600', () => {
    const r = calculateDuty(duty({ endAt: '2025-09-10 19:30' }), version('v', packageConfig('3200', { hourMode: 'ceil' })));
    expect(amounts(r.lines).EXHR).toBe('600.00');
  });
  it('both kilometre and hour excess', () => {
    const r = calculateDuty(duty({ endKm: '1100', endAt: '2025-09-10 19:00' }), v);
    expect(amounts(r.lines)).toEqual({ BASE: '3200.00', EXKM: '360.00', EXHR: '400.00' });
  });
  it('grace period waives small excess only', () => {
    const g = version('g', packageConfig('3200', { hourMode: 'ceil', grace: 15 }));
    expect(amounts(calculateDuty(duty({ endAt: '2025-09-10 17:10' }), g).lines).EXHR).toBeUndefined();
    expect(amounts(calculateDuty(duty({ endAt: '2025-09-10 17:20' }), g).lines).EXHR).toBe('200.00');
  });
  it('overnight duty is not a negative duration and earns a night charge', () => {
    const n = version('n', packageConfig('3200', { night: true }));
    const r = calculateDuty(duty({ startAt: '2025-09-10 20:00', endAt: '2025-09-11 02:30' }), n);
    expect(r.variables.duration_minutes).toBe('390');
    expect(amounts(r.lines)).toEqual({ BASE: '3200.00', NIGHT: '250.00' });
  });
  it('toll and parking reimbursements are non-taxable lines', () => {
    const r = calculateDuty(duty({ toll: '150', parking: '50' }), v);
    const toll = r.lines.find((l) => l.componentCode === 'TOLL')!;
    expect(toll.amount).toBe('150.00');
    expect(toll.taxCategory).toBe('non_taxable');
    expect(toll.kind).toBe('reimbursement');
  });
  it('rounds currency half-up with decimals, not floats', () => {
    const c = version('c', packageConfig('0', { extraKm: '13.335' }));
    const r = calculateDuty(duty({ endKm: '1087' }), c); // 7 extra km × 13.335 = 93.345
    expect(amounts(r.lines).EXKM).toBe('93.35');
  });
  it('missing odometer produces a clear error instead of a guess', () => {
    expect(() => calculateDuty(duty({ endKm: null }), v)).toThrow(/Odometer reading is missing/);
  });
  it('reversed odometer is never silently repaired', () => {
    expect(() => calculateDuty(duty({ startKm: '1200', endKm: '1100' }), v)).toThrow(/lower than starting/);
  });
});

describe('bill calculation', () => {
  it('selects rate version by effective date and category', () => {
    const v1 = version('v1', packageConfig('3200'), { effectiveTo: '2025-09-15' });
    const v2 = version('v2', packageConfig('3400'), { effectiveFrom: '2025-09-16', versionNo: 2 });
    const dz = version('dz', packageConfig('2600'), { vehicleCategoryIds: [DZIRE] });
    const out = calculateBill({
      periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v1, v2, dz], taxRules: GST, settings: SETTINGS,
      duties: [
        duty({ dutyDate: '2025-09-10' }),
        duty({ dutyDate: '2025-09-20', startAt: '2025-09-20 09:00', endAt: '2025-09-20 17:00' }),
        duty({ dutyDate: '2025-09-21', vehicleCategoryId: DZIRE, vehicleRegNo: 'DL02CD0099', startAt: '2025-09-21 09:00', endAt: '2025-09-21 17:00' }),
      ],
    });
    expect(out.exceptions).toEqual([]);
    expect(out.lines.map((l) => l.amount)).toEqual(['3200.00', '3400.00', '2600.00']);
    // 9200 taxable; CGST 230 + SGST 230 → 9660.00
    expect(out.totals.taxableValue).toBe('9200.00');
    expect(out.taxLines.map((t) => t.amount)).toEqual(['230.00', '230.00']);
    expect(out.totals.grandTotal).toBe('9660.00');
    expect(out.checks.every((c) => c.ok)).toBe(true);
  });

  it('mixed taxable/non-taxable with rupee rounding', () => {
    const v = version('v', packageConfig('3200'));
    const out = calculateBill({
      periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v], taxRules: GST, settings: SETTINGS,
      duties: [duty({ endKm: '1125', toll: '150', parking: '50' })],
    });
    // taxable 4010; tax 100.25 × 2 = 200.50; non-taxable 200 → 4410.50 → 4411 (round-off 0.50)
    expect(out.totals).toMatchObject({ taxableValue: '4010.00', taxTotal: '200.50', nonTaxableTotal: '200.00', preRoundTotal: '4410.50', roundOff: '0.50', grandTotal: '4411.00' });
  });

  it('line-level and inclusive tax modes', () => {
    const v = version('v', packageConfig('3200'));
    const d = [duty({ endKm: '1125' })];
    const line = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v], taxRules: GST, settings: { ...SETTINGS, taxLevel: 'line', invoiceRounding: 'none' }, duties: d });
    // 3200 → 80.00 each; 810 → 20.25 each → 100.25 each
    expect(line.taxLines.map((t) => t.amount)).toEqual(['100.25', '100.25']);
    const incl = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [version('v', packageConfig('3150'))], taxRules: GST, settings: { taxMode: 'inclusive', taxLevel: 'document', invoiceRounding: 'none' }, duties: [duty({})] });
    // 3150 incl 5% → base 3000.00, 75.00 + 75.00
    expect(incl.totals).toMatchObject({ taxableValue: '3000.00', taxTotal: '150.00', grandTotal: '3150.00' });
  });

  it('flags missing rate, missing tax treatment and calculation errors as exceptions', () => {
    const v = version('v', packageConfig('3200'));
    const out = calculateBill({
      periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v], taxRules: [], settings: SETTINGS,
      duties: [duty({}), duty({ vehicleCategoryId: DZIRE }), duty({ endKm: null })],
    });
    expect(out.exceptions.map((e) => e.code).sort()).toEqual(['MISSING_INPUT', 'NO_RATE', 'TAX_NOT_CONFIGURED']);
    expect(out.duties.filter((d) => d.ok)).toHaveLength(1);
  });

  it('flags ambiguous rate schemes rather than picking one', () => {
    const a = version('a', packageConfig('3200'));
    const b = version('b', packageConfig('3300'));
    const out = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [a, b], taxRules: GST, settings: SETTINGS, duties: [duty({})] });
    expect(out.exceptions[0].code).toBe('AMBIGUOUS_RATE');
  });

  it('ignores unapproved scheme versions', () => {
    const out = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [version('a', packageConfig('3200'), { status: 'draft' })], taxRules: GST, settings: SETTINGS, duties: [duty({})] });
    expect(out.exceptions[0].code).toBe('NO_RATE');
  });

  it('monthly package with monthly km limit and minimum guarantee', () => {
    const cfg = RateConfigSchema.parse({
      billingModel: 'monthly_limit',
      params: { monthlyIncludedKm: '200' },
      components: [
        { code: 'MONTHLY', label: 'Monthly hire', scope: 'vehicle_period', quantityExpr: 'days_deployed / period_days', quantityDp: 4, rate: '60000', unit: 'month', taxCategory: 'taxable' },
        { code: 'XKM', label: 'Km beyond monthly limit', scope: 'vehicle_period', quantityExpr: 'max(0, total_km - monthly_included_km)', rate: '12', unit: 'km', taxCategory: 'taxable' },
        { code: 'MINIMUM', label: 'Minimum guarantee top-up', scope: 'bill', quantityExpr: 'max(0, 50000 - duty_charges)', rate: '1', taxCategory: 'taxable' },
      ],
    });
    const v = version('m', cfg);
    // 15 duties of 20 km each over 15 distinct days in a 30-day month
    const duties = Array.from({ length: 15 }, (_, i) => {
      const day = String(i + 1).padStart(2, '0');
      return duty({ dutyDate: `2025-09-${day}`, startAt: `2025-09-${day} 09:00`, endAt: `2025-09-${day} 17:00`, startKm: String(1000 + i * 20), endKm: String(1020 + i * 20) });
    });
    const out = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v], taxRules: GST, settings: { ...SETTINGS, invoiceRounding: 'none' }, duties });
    const a = amounts(out.lines);
    // 15/30 = 0.5 × 60000 = 30000; 300 km − 200 = 100 × 12 = 1200; duty charges 0 → minimum 50000 top-up
    expect(a).toEqual({ MONTHLY: '30000.00', XKM: '1200.00', MINIMUM: '50000.00' });
  });

  it('handles a large monthly dataset deterministically', () => {
    const v = version('v', packageConfig('3200'));
    const duties = Array.from({ length: 3000 }, (_, i) => {
      const day = String((i % 30) + 1).padStart(2, '0');
      return duty({ vehicleRegNo: `DL1C${String(i).padStart(4, '0')}`, dutyDate: `2025-09-${day}`, startAt: `2025-09-${day} 09:00`, endAt: `2025-09-${day} 17:00` });
    });
    const t0 = Date.now();
    const out = calculateBill({ periodStart: '2025-09-01', periodEnd: '2025-09-30', schemes: [v], taxRules: GST, settings: SETTINGS, duties });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(out.totals.taxableValue).toBe('9600000.00');
    expect(out.totals.grandTotal).toBe('10080000.00');
  });
});

describe('duty validation', () => {
  const base = { dutyDate: '2025-09-10', vehicleRegNo: '0012', vehicleCategoryId: INNOVA, startKm: '100', endKm: '150', startAt: '2025-09-10 20:00', endAt: '2025-09-11 01:00' };
  it('accepts a valid overnight duty', () => {
    expect(validateDuty(base, DEFAULT_VALIDATION)).toEqual([]);
  });
  it('detects reversed odometer, reversed time, missing fields', () => {
    const codes = validateDuty({ ...base, endKm: '90', endAt: '2025-09-10 19:00', vehicleCategoryId: null }, DEFAULT_VALIDATION).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['ODOMETER_REVERSED', 'TIME_REVERSED', 'MISSING_FIELD']));
  });
  it('warns on implausible distance and duration', () => {
    const codes = validateDuty({ ...base, endKm: '2000', endAt: '2025-09-12 01:00' }, DEFAULT_VALIDATION).map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['HIGH_KM', 'LONG_DURATION']));
  });
  it('detects duplicates and overlaps for the same vehicle', () => {
    const other = { id: 'x', dutyDate: '2025-09-10', startAt: '2025-09-10 20:00', endAt: '2025-09-11 01:00', startKm: '100', endKm: '150' };
    expect(validateDuty({ ...base, id: 'y' }, DEFAULT_VALIDATION, { sameVehicleDuties: [other] })[0].code).toBe('DUPLICATE_DUTY');
    const overlap = { ...other, startAt: '2025-09-10 23:00', endAt: '2025-09-11 03:00' };
    expect(validateDuty({ ...base, id: 'y' }, DEFAULT_VALIDATION, { sameVehicleDuties: [overlap] })[0].code).toBe('OVERLAPPING_DUTY');
  });
  it('checks contract dates and promotes configured hard errors', () => {
    const issues = validateDuty({ ...base, endKm: '2000' }, { ...DEFAULT_VALIDATION, hardErrorCodes: ['HIGH_KM'] }, { contractEnd: '2025-08-31' });
    expect(issues.find((i) => i.code === 'HIGH_KM')!.severity).toBe('error');
    expect(issues.find((i) => i.code === 'OUTSIDE_CONTRACT')).toBeTruthy();
  });
});
