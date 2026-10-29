import { D, type Dec, dec, roundDp } from './decimal.js';
import { calculateDuty, DutyCalcError, ENGINE_VERSION, evalComponent, lineTotal } from './duty.js';
import { daysBetweenInclusive } from './time.js';
import type { BillSettings, CalcException, CalcLine, DutyInput, SchemeVersion, TaxRuleInput } from './types.js';
import type { Scope } from './expr.js';

export interface BillCalcInput {
  periodStart: string;
  periodEnd: string;
  duties: DutyInput[];
  /** Candidate scheme versions for the contract. Non-approved versions are ignored. */
  schemes: SchemeVersion[];
  taxRules: TaxRuleInput[];
  settings: BillSettings;
}

export interface TaxLine {
  taxRuleId: string;
  name: string;
  taxType: string;
  rate: string;
  taxableBase: string;
  amount: string;
}

export interface BillTotals {
  chargesTotal: string;
  reimbursementsTotal: string;
  deductionsTotal: string;
  taxableGross: string;
  taxableValue: string;
  nonTaxableTotal: string;
  taxTotal: string;
  preRoundTotal: string;
  roundOff: string;
  grandTotal: string;
}

export interface DutyResult {
  dutyId: string;
  schemeVersionId: string | null;
  variables: Record<string, string>;
  total: string;
  ok: boolean;
}

export interface BillCalcOutput {
  engineVersion: string;
  lines: CalcLine[];
  taxLines: TaxLine[];
  totals: BillTotals;
  duties: DutyResult[];
  exceptions: CalcException[];
  checks: { name: string; ok: boolean; detail: string }[];
}

function covers(from: string, to: string | null, date: string): boolean {
  return from <= date && (to == null || date <= to);
}

/** Picks the single approved, effective scheme version for a duty, preferring the most specific match. */
export function selectScheme(duty: DutyInput, schemes: SchemeVersion[]): { version?: SchemeVersion; error?: CalcException } {
  const candidates = schemes.filter(
    (s) =>
      s.status === 'approved' &&
      covers(s.effectiveFrom, s.effectiveTo, duty.dutyDate) &&
      (s.vehicleCategoryIds.length === 0 || (duty.vehicleCategoryId != null && s.vehicleCategoryIds.includes(duty.vehicleCategoryId))) &&
      (s.dutyTypeCodes.length === 0 || (duty.dutyTypeCode != null && s.dutyTypeCodes.includes(duty.dutyTypeCode))),
  );
  if (candidates.length === 0) {
    return {
      error: {
        dutyId: duty.id,
        code: 'NO_RATE',
        severity: 'error',
        message: `No approved rate scheme is effective on ${duty.dutyDate} for vehicle category "${duty.vehicleCategoryName ?? 'not set'}" and duty type "${duty.dutyTypeCode ?? 'not set'}".`,
      },
    };
  }
  const score = (s: SchemeVersion) => (s.vehicleCategoryIds.length ? 2 : 0) + (s.dutyTypeCodes.length ? 1 : 0);
  const best = Math.max(...candidates.map(score));
  const top = candidates.filter((s) => score(s) === best);
  if (top.length > 1) {
    return {
      error: {
        dutyId: duty.id,
        code: 'AMBIGUOUS_RATE',
        severity: 'error',
        message: `More than one approved rate scheme applies on ${duty.dutyDate}: ${top.map((s) => `${s.schemeName} v${s.versionNo}`).join(', ')}. Narrow the effective dates, vehicle categories or duty types.`,
      },
    };
  }
  return { version: top[0] };
}

export function selectTaxRules(rules: TaxRuleInput[], periodStart: string, periodEnd: string): { rules: TaxRuleInput[]; warnings: CalcException[] } {
  const approved = rules.filter((r) => r.status === 'approved');
  const active = approved.filter((r) => covers(r.effectiveFrom, r.effectiveTo, periodEnd));
  const warnings: CalcException[] = [];
  for (const r of approved) {
    const changesInside = (r.effectiveFrom > periodStart && r.effectiveFrom <= periodEnd) || (r.effectiveTo != null && r.effectiveTo >= periodStart && r.effectiveTo < periodEnd);
    if (changesInside) {
      warnings.push({
        dutyId: null,
        code: 'TAX_RATE_CHANGES_IN_PERIOD',
        severity: 'warning',
        message: `Tax rule "${r.name}" starts or ends inside the billing period; rules effective on ${periodEnd} were applied. Confirm the treatment.`,
      });
    }
  }
  return { rules: active, warnings };
}

function computeTaxes(lines: CalcLine[], rules: TaxRuleInput[], settings: BillSettings, exact = false) {
  const taxable = lines.filter((l) => l.taxCategory === 'taxable');
  const gross = lineTotal(taxable);
  const totalRate = rules.reduce((a, r) => a.add(dec(r.rate)), new D(0));
  const units: Dec[] = settings.taxLevel === 'line' ? taxable.map((l) => dec(l.amount)) : [gross];
  const perRule = rules.map(() => new D(0));
  let base = new D(0);
  for (const u of units) {
    const rawBase = settings.taxMode === 'inclusive' ? u.mul(100).div(new D(100).add(totalRate)) : u;
    let unitTax = new D(0);
    rules.forEach((r, i) => {
      const raw = rawBase.mul(dec(r.rate)).div(100);
      const t = exact ? raw : roundDp(raw, 2);
      perRule[i] = perRule[i].add(t);
      unitTax = unitTax.add(t);
    });
    // For inclusive pricing, the base is what remains after the rounded taxes so that base + tax = price.
    base = base.add(settings.taxMode === 'inclusive' ? u.sub(unitTax) : u);
  }
  const taxLines: TaxLine[] = rules.map((r, i) => ({
    taxRuleId: r.id,
    name: r.name,
    taxType: r.taxType,
    rate: dec(r.rate).toString(),
    taxableBase: base.toFixed(2),
    amount: perRule[i].toFixed(2),
  }));
  // Exact arithmetic sums the unrounded taxes; the lines above only show them to the paisa.
  const taxExact = perRule.reduce((a, t) => a.add(t), new D(0));
  return { gross, base, taxLines, taxExact };
}

function applyInvoiceRounding(v: Dec, mode: BillSettings['invoiceRounding']): Dec {
  switch (mode) {
    case 'nearest_rupee': return roundDp(v, 0, 'half_up');
    case 'up_rupee': return v.ceil();
    case 'down_rupee': return v.floor();
    default: return v;
  }
}

export function calculateBill(input: BillCalcInput): BillCalcOutput {
  // LR exact arithmetic (opt-in per contract): lines keep unit × rate to 4 decimals, tax is not rounded
  // before it is summed, and the bill total goes to the whole rupee.
  const exact = input.settings.arithmetic === 'lr_exact';
  const presentation = exact ? input.settings.gstPresentation ?? 'add' : 'add';
  const invoiceRounding = exact ? 'nearest_rupee' : input.settings.invoiceRounding;
  const exceptions: CalcException[] = [];
  const lines: CalcLine[] = [];
  const dutyResults: DutyResult[] = [];
  const periodDays = daysBetweenInclusive(input.periodStart, input.periodEnd);

  // Per-version groupings for period and bill scope components.
  const byVersion = new Map<string, { version: SchemeVersion; duties: { duty: DutyInput; vars: Record<string, string> }[] }>();

  const sorted = [...input.duties].sort((a, b) =>
    a.dutyDate.localeCompare(b.dutyDate) || (a.startAt ?? '').localeCompare(b.startAt ?? '') || a.vehicleRegNo.localeCompare(b.vehicleRegNo),
  );

  for (const duty of sorted) {
    if (duty.dutyDate < input.periodStart || duty.dutyDate > input.periodEnd) {
      exceptions.push({ dutyId: duty.id, code: 'OUTSIDE_PERIOD', severity: 'error', message: `Duty date ${duty.dutyDate} is outside the billing period.` });
      dutyResults.push({ dutyId: duty.id, schemeVersionId: null, variables: {}, total: '0.00', ok: false });
      continue;
    }
    const sel = selectScheme(duty, input.schemes);
    if (!sel.version) {
      exceptions.push(sel.error!);
      dutyResults.push({ dutyId: duty.id, schemeVersionId: null, variables: {}, total: '0.00', ok: false });
      continue;
    }
    try {
      const r = calculateDuty(duty, sel.version, exact);
      lines.push(...r.lines);
      dutyResults.push({ dutyId: duty.id, schemeVersionId: sel.version.id, variables: r.variables, total: lineTotal(r.lines).toFixed(2), ok: true });
      const g = byVersion.get(sel.version.id) ?? { version: sel.version, duties: [] };
      g.duties.push({ duty, vars: r.variables });
      byVersion.set(sel.version.id, g);
    } catch (e) {
      const code = e instanceof DutyCalcError ? e.code : 'CALC_ERROR';
      exceptions.push({ dutyId: duty.id, code, severity: 'error', message: (e as Error).message });
      dutyResults.push({ dutyId: duty.id, schemeVersionId: sel.version.id, variables: {}, total: '0.00', ok: false });
    }
  }

  const sumVar = (rows: { vars: Record<string, string> }[], k: string) => rows.reduce((a, r) => a.add(dec(r.vars[k] || '0')), new D(0));
  const dutyChargeTotal = (ids: Set<string>) =>
    lineTotal(lines, (l) => l.scope === 'duty' && l.kind === 'charge' && l.dutyId != null && ids.has(l.dutyId));

  for (const { version, duties } of byVersion.values()) {
    const cfg = version.config;
    const periodComps = cfg.components.filter((c) => c.scope === 'vehicle_period');
    const billComps = cfg.components.filter((c) => c.scope === 'bill');
    const base = (rows: typeof duties): Scope => ({
      period_days: new D(periodDays),
      duty_count: new D(rows.length),
      days_deployed: new D(new Set(rows.map((r) => r.duty.dutyDate)).size),
      vehicle_count: new D(new Set(rows.map((r) => r.duty.vehicleRegNo)).size),
      total_km: sumVar(rows, 'billable_km'),
      total_hours: sumVar(rows, 'billable_hours'),
      total_extra_km: sumVar(rows, 'extra_km'),
      total_extra_hours: sumVar(rows, 'extra_hours'),
      monthly_included_km: dec(cfg.params.monthlyIncludedKm),
      monthly_included_hours: dec(cfg.params.monthlyIncludedHours),
      included_km: dec(cfg.params.includedKm),
      included_hours: dec(cfg.params.includedHours),
      duty_charges: dutyChargeTotal(new Set(rows.map((r) => r.duty.id))),
    });
    if (periodComps.length) {
      const byVehicle = new Map<string, typeof duties>();
      for (const d of duties) byVehicle.set(d.duty.vehicleRegNo, [...(byVehicle.get(d.duty.vehicleRegNo) ?? []), d]);
      for (const [reg, rows] of byVehicle) {
        const scope = base(rows);
        for (const comp of periodComps) {
          try {
            const l = evalComponent(comp, cfg, scope, {}, { dutyId: null, vehicleRegNo: reg, version, exact });
            if (l) lines.push(l);
          } catch (e) {
            exceptions.push({ dutyId: null, code: 'PERIOD_CALC_ERROR', severity: 'error', message: `${reg}: ${(e as Error).message}` });
          }
        }
      }
    }
    if (billComps.length) {
      const scope = base(duties);
      for (const comp of billComps) {
        try {
          const l = evalComponent(comp, cfg, scope, {}, { dutyId: null, vehicleRegNo: null, version, exact });
          if (l) lines.push(l);
        } catch (e) {
          exceptions.push({ dutyId: null, code: 'BILL_CALC_ERROR', severity: 'error', message: (e as Error).message });
        }
      }
    }
  }

  // Taxes
  const { rules, warnings } = selectTaxRules(input.taxRules, input.periodStart, input.periodEnd);
  exceptions.push(...warnings);
  const hasTaxable = lines.some((l) => l.taxCategory === 'taxable' && !dec(l.amount).isZero());
  // Reverse charge: no tax is charged on the bill, so no tax rule is needed.
  if (hasTaxable && rules.length === 0 && presentation !== 'rcm_note') {
    exceptions.push({
      dutyId: null,
      code: 'TAX_NOT_CONFIGURED',
      severity: 'error',
      message: 'Taxable charges exist but no approved tax rule is effective for this contract. Configure and approve the tax treatment (use a 0% rule to confirm an exemption).',
    });
  }
  const { gross, base, taxLines: computedTaxLines, taxExact } = computeTaxes(lines, presentation === 'rcm_note' ? [] : rules, input.settings, exact);
  const taxLines = computedTaxLines;
  const nonTaxable = lineTotal(lines, (l) => l.taxCategory === 'non_taxable');
  const taxTotal = exact ? taxExact : taxLines.reduce((a, t) => a.add(dec(t.amount)), new D(0));
  // show_separate: the tax is printed on the bill but is not part of the amount payable.
  const taxAdded = presentation === 'add' ? taxTotal : new D(0);
  const preRound = base.add(taxAdded).add(nonTaxable);
  const grand = applyInvoiceRounding(preRound, invoiceRounding);
  const roundOff = grand.sub(preRound);

  const totals: BillTotals = {
    chargesTotal: lineTotal(lines, (l) => l.kind === 'charge').toFixed(2),
    reimbursementsTotal: lineTotal(lines, (l) => l.kind === 'reimbursement').toFixed(2),
    deductionsTotal: lineTotal(lines, (l) => l.kind === 'deduction').toFixed(2),
    taxableGross: gross.toFixed(2),
    taxableValue: base.toFixed(2),
    nonTaxableTotal: nonTaxable.toFixed(2),
    taxTotal: taxTotal.toFixed(2),
    preRoundTotal: preRound.toFixed(2),
    roundOff: roundOff.toFixed(2),
    grandTotal: grand.toFixed(2),
  };

  const allLines = lineTotal(lines);
  const checks = [
    {
      name: 'Lines = taxable + non-taxable',
      ok: allLines.eq(gross.add(nonTaxable)),
      detail: `${allLines.toFixed(2)} vs ${gross.add(nonTaxable).toFixed(2)}`,
    },
    {
      name: 'Charges + reimbursements + deductions = lines',
      ok: lineTotal(lines, (l) => l.kind === 'charge').add(lineTotal(lines, (l) => l.kind === 'reimbursement')).add(lineTotal(lines, (l) => l.kind === 'deduction')).eq(allLines),
      detail: allLines.toFixed(2),
    },
    {
      name: 'Grand total = taxable value + tax + non-taxable + round-off',
      ok: base.add(taxAdded).add(nonTaxable).add(roundOff).eq(grand),
      detail: grand.toFixed(2),
    },
    {
      name: 'Every duty is calculated or has an exception',
      ok: dutyResults.every((d) => d.ok || exceptions.some((e) => e.dutyId === d.dutyId)),
      detail: `${dutyResults.filter((d) => d.ok).length}/${dutyResults.length} duties calculated`,
    },
  ];

  return { engineVersion: ENGINE_VERSION, lines, taxLines, totals, duties: dutyResults, exceptions, checks };
}
