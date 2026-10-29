import { D, type Dec, dec, roundDp, roundToUnit, type RoundMode } from './decimal.js';
import { evaluate, evaluateNumber, ExprError, truthy, type Scope, type Value } from './expr.js';
import { nightOverlap, toMinutes, weekday } from './time.js';
import type { CalcLine, DutyInput, RateComponent, RateConfig, SchemeVersion } from './types.js';

export const ENGINE_VERSION = '1.0.0';

export class DutyCalcError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Describes every built-in variable so the UI and test calculator can explain them. */
export const DUTY_VARIABLES: Record<string, string> = {
  start_km: 'Starting odometer reading',
  end_km: 'Closing odometer reading',
  actual_km: 'Closing − starting odometer',
  km_adjustment: 'Contractual kilometre adjustment (e.g. garage-to-garage)',
  billable_km: 'Actual km + adjustment, after km rounding',
  included_km: 'Kilometres included in the package',
  extra_km: 'max(0, billable_km − included_km)',
  duration_minutes: 'Minutes between start and closing date-time (handles cross-midnight)',
  duration_hours: 'duration_minutes ÷ 60 (exact)',
  billable_hours: 'Duration after hour rounding',
  included_hours: 'Hours included in the package',
  grace_minutes: 'Configured grace minutes',
  extra_minutes: 'Extra minutes beyond included hours after grace',
  extra_hours: 'Extra hours after grace and rounding',
  night_count: 'Number of night windows the duty overlaps',
  night_minutes: 'Minutes inside night windows',
  days_spanned: 'Calendar days touched by the duty',
  weekday: 'Day of week of the duty date (0 = Sunday)',
  is_sunday: '1 if the duty date is a Sunday',
  toll: 'Toll amount on the duty',
  parking: 'Parking amount on the duty',
  other_charges: 'Other contractual charges entered on the duty',
  duty_type: 'Duty type code (text)',
  vehicle_category: 'Vehicle category name (text)',
};

export const PERIOD_VARIABLES: Record<string, string> = {
  period_days: 'Days in the billing period',
  duty_count: 'Number of duties in the group',
  days_deployed: 'Distinct duty dates in the group',
  vehicle_count: 'Distinct vehicles in the group (bill scope)',
  total_km: 'Sum of billable_km',
  total_hours: 'Sum of billable_hours',
  total_extra_km: 'Sum of extra_km',
  total_extra_hours: 'Sum of extra_hours',
  monthly_included_km: 'Monthly included kilometres from scheme parameters',
  monthly_included_hours: 'Monthly included hours from scheme parameters',
  duty_charges: 'Sum of duty-level charge amounts (excluding reimbursements and deductions)',
};

export interface DutyVars {
  scope: Scope;
  /** Variables that could not be derived and why (e.g. missing odometer). */
  missing: Record<string, string>;
}

export function deriveDutyVariables(duty: DutyInput, cfg: RateConfig): DutyVars {
  const p = cfg.params;
  const scope: Scope = {};
  const missing: Record<string, string> = {};

  scope.included_km = dec(p.includedKm);
  scope.included_hours = dec(p.includedHours);
  scope.grace_minutes = dec(p.graceMinutes);
  scope.km_adjustment = dec(p.kmAdjustment);
  scope.toll = dec(duty.toll);
  scope.parking = dec(duty.parking);
  scope.other_charges = dec(duty.otherCharges);
  scope.duty_type = duty.dutyTypeCode ?? '';
  scope.vehicle_category = duty.vehicleCategoryName ?? '';
  scope.weekday = new D(weekday(duty.dutyDate));
  scope.is_sunday = new D(weekday(duty.dutyDate) === 0 ? 1 : 0);

  // Distance
  if (duty.startKm != null && duty.endKm != null && duty.startKm !== '' && duty.endKm !== '') {
    const s = dec(duty.startKm);
    const e = dec(duty.endKm);
    scope.start_km = s;
    scope.end_km = e;
    const actual = e.sub(s);
    if (actual.isNeg()) {
      for (const k of ['actual_km', 'billable_km', 'extra_km']) missing[k] = 'Closing odometer is lower than starting odometer';
    } else {
      scope.actual_km = actual;
      const billable = roundToUnit(actual.add(dec(p.kmAdjustment)), dec(p.kmRounding.unit), p.kmRounding.mode);
      scope.billable_km = billable;
      scope.extra_km = D.max(0, billable.sub(dec(p.includedKm)));
    }
  } else {
    for (const k of ['start_km', 'end_km', 'actual_km', 'billable_km', 'extra_km']) missing[k] = 'Odometer reading is missing';
  }

  // Time
  const sm = toMinutes(duty.startAt);
  const em = toMinutes(duty.endAt);
  const timeVars = ['duration_minutes', 'duration_hours', 'billable_hours', 'extra_minutes', 'extra_hours', 'night_count', 'night_minutes', 'days_spanned'];
  if (sm == null || em == null) {
    for (const k of timeVars) missing[k] = 'Start or closing date-time is missing or invalid';
  } else if (em < sm) {
    for (const k of timeVars) missing[k] = 'Closing date-time is before starting date-time';
  } else {
    const dur = new D(em - sm);
    scope.duration_minutes = dur;
    scope.duration_hours = dur.div(60);
    const unit = dec(p.hourRounding.unit);
    scope.billable_hours = roundToUnit(dur, unit, p.hourRounding.mode).div(60);
    let extra = D.max(0, dur.sub(dec(p.includedHours).mul(60)));
    if (p.graceMinutes > 0) {
      if (p.graceMode === 'waive_within') extra = extra.lte(p.graceMinutes) ? new D(0) : extra;
      else extra = D.max(0, extra.sub(p.graceMinutes));
    }
    scope.extra_minutes = extra;
    scope.extra_hours = roundToUnit(extra, unit, p.hourRounding.mode).div(60);
    if (p.night.enabled) {
      const n = nightOverlap(sm, em, p.night.start, p.night.end, p.night.minOverlapMinutes);
      scope.night_count = new D(p.night.countMode === 'once_per_duty' ? Math.min(1, n.nights) : n.nights);
      scope.night_minutes = new D(n.minutes);
    } else {
      scope.night_count = new D(0);
      scope.night_minutes = new D(0);
    }
    scope.days_spanned = new D(Math.floor(em / 1440) - Math.floor(sm / 1440) + 1);
  }

  for (const [k, v] of Object.entries(duty.customFields ?? {})) {
    const key = `f_${k.toLowerCase().replace(/[^a-z0-9_]/g, '_')}`;
    if (typeof v === 'number' || (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim()))) scope[key] = dec(String(v).trim());
    else if (typeof v === 'string') scope[key] = v;
    else if (typeof v === 'boolean') scope[key] = new D(v ? 1 : 0);
  }

  for (const vd of p.variables) {
    try {
      scope[vd.name] = evaluate(vd.expr, scope).value;
    } catch (e) {
      missing[vd.name] = `Custom variable could not be computed: ${(e as Error).message}`;
    }
  }
  return { scope, missing };
}

function fmtVal(v: Value | undefined): string {
  if (v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return v.toString();
}

/**
 * Evaluates one component against a scope. Returns null when the component
 * does not apply (condition false, or zero amount that should be hidden).
 */
export function evalComponent(
  comp: RateComponent,
  cfg: RateConfig,
  scope: Scope,
  missing: Record<string, string>,
  ctx: { dutyId: string | null; vehicleRegNo: string | null; version: SchemeVersion; /** LR exact arithmetic: keep unit × rate to 4 decimals instead of rounding to paise */ exact?: boolean },
): CalcLine | null {
  const wrap = <T>(fn: () => T, what: string): T => {
    try {
      return fn();
    } catch (e) {
      if (e instanceof ExprError) {
        const m = /Unknown variable "([^"]+)"/.exec(e.message);
        if (m && missing[m[1]]) throw new DutyCalcError('MISSING_INPUT', `${comp.label}: ${missing[m[1]]} (needs ${m[1]})`);
        throw new DutyCalcError('RULE_ERROR', `${comp.label}: ${what} — ${e.message}`);
      }
      throw e;
    }
  };
  const inputs: Record<string, string> = {};
  if (comp.condition && comp.condition.trim()) {
    const r = wrap(() => evaluate(comp.condition!, scope), 'condition');
    r.used.forEach((u) => (inputs[u] = fmtVal(scope[u])));
    if (!truthy(r.value)) return null;
  }
  const q = wrap(() => evaluateNumber(comp.quantityExpr, scope), 'quantity');
  q.used.forEach((u) => (inputs[u] = fmtVal(scope[u])));
  const qty = roundDp(q.value, comp.quantityDp, comp.quantityRoundMode as RoundMode);
  const rate = dec(comp.rate);
  let amount = ctx.exact ? roundDp(qty.mul(rate), 4) : roundDp(qty.mul(rate), cfg.amountDp, cfg.amountRoundMode);
  let capped: string | undefined;
  if (comp.minAmount !== undefined && amount.lt(dec(comp.minAmount)) && !qty.isZero()) {
    capped = `raised to minimum ₹${dec(comp.minAmount).toFixed(2)}`;
    amount = dec(comp.minAmount);
  }
  if (comp.maxAmount !== undefined && amount.gt(dec(comp.maxAmount))) {
    capped = `capped at maximum ₹${dec(comp.maxAmount).toFixed(2)}`;
    amount = dec(comp.maxAmount);
  }
  if (comp.kind === 'deduction') amount = amount.abs().neg();
  if (amount.isZero() && !comp.showWhenZero) return null;
  const qtyStr = qty.toString();
  const amountDigits = ctx.exact ? 4 : 2;
  const formula = `${qtyStr}${comp.unit ? ' ' + comp.unit : ''} × ₹${rate.toFixed(2)} = ₹${amount.toFixed(amountDigits)}${capped ? ` (${capped})` : ''}`;
  return {
    dutyId: ctx.dutyId,
    vehicleRegNo: ctx.vehicleRegNo,
    scope: comp.scope,
    componentCode: comp.code,
    label: comp.label,
    kind: comp.kind,
    quantity: qtyStr,
    unit: comp.unit,
    rate: rate.toFixed(2),
    amount: amount.toFixed(amountDigits),
    taxCategory: comp.taxCategory,
    trace: {
      quantityExpr: comp.quantityExpr,
      condition: comp.condition || undefined,
      inputs,
      formula,
      clauseRef: comp.clauseRef,
      schemeVersionId: ctx.version.id,
      schemeName: ctx.version.schemeName,
      versionNo: ctx.version.versionNo,
      capped,
      billingModel: cfg.billingModel,
    },
  };
}

export interface DutyCalcResult {
  lines: CalcLine[];
  variables: Record<string, string>;
  missing: Record<string, string>;
}

/** Calculates all duty-scope components for one duty under one scheme version. */
export function calculateDuty(duty: DutyInput, version: SchemeVersion, exact = false): DutyCalcResult {
  const cfg = version.config;
  const { scope, missing } = deriveDutyVariables(duty, cfg);
  const lines: CalcLine[] = [];
  for (const comp of cfg.components) {
    if (comp.scope !== 'duty') continue;
    const line = evalComponent(comp, cfg, scope, missing, { dutyId: duty.id, vehicleRegNo: duty.vehicleRegNo, version, exact });
    if (line) lines.push(line);
  }
  const variables: Record<string, string> = {};
  for (const [k, v] of Object.entries(scope)) variables[k] = fmtVal(v);
  return { lines, variables, missing };
}

export function lineTotal(lines: CalcLine[], pred: (l: CalcLine) => boolean = () => true): Dec {
  return lines.filter(pred).reduce((a, l) => a.add(dec(l.amount)), new D(0));
}
