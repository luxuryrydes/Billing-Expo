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

/** A card covers a duty type when it lists it, or when it was set up for all duty types (cards from before this option count as all). */
const dutyTypeOk = (s: SchemeVersion, duty: DutyInput) =>
  s.dutyTypeCodes.length === 0 ? s.allDutyTypes !== false : duty.dutyTypeCode != null && s.dutyTypeCodes.includes(duty.dutyTypeCode);

/** Why a rate card does not fit a duty, one plain sentence per problem. An empty list means it fits. */
export function explainMismatch(duty: DutyInput, versions: SchemeVersion[], categoryNames: Record<string, string> = {}): string[] {
  if (versions.length === 0) return ['This rate card has no version.'];
  const live = versions.filter((v) => v.status === 'approved');
  const newest = [...versions].sort((a, b) => b.versionNo - a.versionNo)[0];
  if (live.length === 0) return [`The rate card is not approved yet (its latest version is ${newest.status.replace('_', ' ')}). Approve it in Rate Schemes.`];
  const best = live.find((v) => covers(v.effectiveFrom, v.effectiveTo, duty.dutyDate)) ?? live[0];
  const out: string[] = [];
  if (!covers(best.effectiveFrom, best.effectiveTo, duty.dutyDate)) out.push(`The duty date ${duty.dutyDate} is outside the card's dates (${best.effectiveFrom} to ${best.effectiveTo ?? 'open'}).`);
  if (best.vehicleCategoryIds.length && !(duty.vehicleCategoryId != null && best.vehicleCategoryIds.includes(duty.vehicleCategoryId))) {
    out.push(`The card is for ${best.vehicleCategoryIds.map((id) => categoryNames[id] ?? 'another vehicle category').join(', ')}, but the slip's vehicle category is "${duty.vehicleCategoryName ?? 'not set'}".`);
  }
  if (!dutyTypeOk(best, duty)) {
    out.push(best.dutyTypeCodes.length
      ? `The card is for duty type ${best.dutyTypeCodes.join(', ')}, but this slip's duty type is "${duty.dutyTypeCode ?? 'not set'}".`
      : 'The card has no duty type set (it is not marked for all duty types). Set it on the rate card.');
  }
  return out;
}

/** Picks the single approved, effective scheme version for a duty, preferring the most specific match. */
export function selectScheme(duty: DutyInput, schemes: SchemeVersion[]): { version?: SchemeVersion; error?: CalcException } {
  const pool = duty.schemeId ? schemes.filter((s) => s.schemeId === duty.schemeId) : schemes;
  const skipDates = !!duty.schemeId && !!duty.ignoreCardDates;
  const candidates = pool.filter(
    (s) =>
      s.status === 'approved' &&
      (skipDates || covers(s.effectiveFrom, s.effectiveTo, duty.dutyDate)) &&
      (s.vehicleCategoryIds.length === 0 || (duty.vehicleCategoryId != null && s.vehicleCategoryIds.includes(duty.vehicleCategoryId))) &&
      dutyTypeOk(s, duty),
  );
  if (candidates.length === 0) {
    return {
      error: {
        dutyId: duty.id,
        code: 'NO_RATE',
        severity: 'error',
        message: duty.schemeId
          ? `The rate card "${schemes.find((s) => s.schemeId === duty.schemeId)?.schemeName ?? 'chosen'}" does not fit this slip. ${explainMismatch(duty, pool).join(' ') || 'No approved version applies.'}`
          : `No approved rate scheme is effective on ${duty.dutyDate} for vehicle category "${duty.vehicleCategoryName ?? 'not set'}" and duty type "${duty.dutyTypeCode ?? 'not set'}".`,
      },
    };
  }
  const score = (s: SchemeVersion) => (s.vehicleCategoryIds.length ? 2 : 0) + (s.dutyTypeCodes.length ? 1 : 0);
  const best = Math.max(...candidates.map(score));
  let top = candidates.filter((s) => score(s) === best);
  if (skipDates && top.length > 1) {
    // Several versions and none in force on the date: the one that starts nearest to it.
    const dist = (s: SchemeVersion) => Math.abs(Date.parse(s.effectiveFrom) - Date.parse(duty.dutyDate));
    const inForce = top.filter((s) => covers(s.effectiveFrom, s.effectiveTo, duty.dutyDate));
    top = inForce.length ? inForce : [[...top].sort((a, b) => dist(a) - dist(b))[0]];
  }
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
    if (duty.manualAmount != null && duty.manualAmount !== '') {
      // An amount entered by hand is used as it is; no rate card is needed or assumed.
      const amt = dec(duty.manualAmount);
      lines.push({ dutyId: duty.id, vehicleRegNo: duty.vehicleRegNo, scope: 'duty', componentCode: 'MANUAL', label: 'Duty charge', kind: 'charge', quantity: '1', unit: 'duty', rate: amt.toFixed(2), amount: amt.toFixed(2), taxCategory: 'taxable', versionId: null,
        trace: { quantityExpr: '1', inputs: {}, formula: `Amount entered by hand: ${amt.toFixed(2)}`, schemeVersionId: '', schemeName: 'Amount entered by hand', versionNo: 0 } });
      dutyResults.push({ dutyId: duty.id, schemeVersionId: null, variables: {}, total: amt.toFixed(2), ok: true });
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
      if (duty.timeOptional && (!duty.startAt || !duty.endAt)) exceptions.push({ dutyId: duty.id, code: 'TIME_MISSING', severity: 'warning', message: 'The reporting or release time is missing, so extra hours and night charges were not included. Enter the times to include them.' });
      if (duty.schemeId && duty.ignoreCardDates && !covers(sel.version.effectiveFrom, sel.version.effectiveTo, duty.dutyDate)) exceptions.push({ dutyId: duty.id, code: 'CARD_DATES_OVERRIDDEN', severity: 'warning', message: `${sel.version.schemeName} was used although the duty date ${duty.dutyDate} is outside its dates (${sel.version.effectiveFrom} to ${sel.version.effectiveTo ?? 'open'}), as chosen.` });
      for (const l of r.lines) l.versionId = sel.version.id;
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
            if (l) { l.versionId = version.id; lines.push(l); }
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
          if (l) { l.versionId = version.id; lines.push(l); }
        } catch (e) {
          exceptions.push({ dutyId: null, code: 'BILL_CALC_ERROR', severity: 'error', message: (e as Error).message });
        }
      }
    }
  }

  // Taxes
  const { rules, warnings } = selectTaxRules(input.taxRules, input.periodStart, input.periodEnd);
  exceptions.push(...warnings);
  // Each line is taxed by its own rate card's tax setting: a card marked non-taxable carries no GST, a card with its own GST rate uses it
  // (extra or included), and everything else (cards with no tax setting, as before) uses the contract's approved tax rules.
  // Amounts entered by hand follow the invoice's choice (contract rules, none, or a rate typed on the invoice).
  const versionTax = new Map(input.schemes.map((v) => [v.id, v.config.tax]));
  const manualTax = input.settings.manualTax ?? { mode: 'contract' as const };
  for (const l of lines) {
    const t = l.versionId ? versionTax.get(l.versionId) : undefined;
    if (t && t.taxable === false) l.taxCategory = 'non_taxable';
    if (!l.versionId && l.componentCode === 'MANUAL' && manualTax.mode === 'non_taxable') l.taxCategory = 'non_taxable';
  }
  const profileOf = (l: CalcLine): string => {
    if (l.taxCategory !== 'taxable') return 'none';
    const t = l.versionId ? versionTax.get(l.versionId) : undefined;
    if (t?.taxable && t.rate != null && t.rate !== '') return `own:${t.rate}:${t.mode}`;
    if (!l.versionId && manualTax.mode === 'custom' && manualTax.rate) return `own:${manualTax.rate}:${manualTax.included ? 'included' : 'extra'}`;
    return 'contract';
  };
  const contractLines = lines.filter((l) => profileOf(l) === 'contract');
  const ownGroups = new Map<string, CalcLine[]>();
  for (const l of lines) { const k = profileOf(l); if (k.startsWith('own:')) ownGroups.set(k, [...(ownGroups.get(k) ?? []), l]); }
  const hasTaxable = contractLines.some((l) => !dec(l.amount).isZero());
  // Reverse charge: no tax is charged on the bill, so no tax rule is needed.
  if (hasTaxable && rules.length === 0 && presentation !== 'rcm_note') {
    exceptions.push({
      dutyId: null,
      code: 'TAX_NOT_CONFIGURED',
      // Information, not a stop: a card with its own GST setting never gets here. No GST is added for these charges; set Taxable / Non-taxable on the rate card (or approve a tax rule) if GST applies.
      severity: 'warning',
      message: 'No GST was added: these charges come from a rate card with no tax setting and the contract has no approved tax rule. Set Taxable or Non-taxable on the rate card (Rate Schemes → Set tax for rate cards) if GST applies.',
    });
  }
  let gross: Dec = new D(0);
  let base: Dec = new D(0);
  let taxExact: Dec = new D(0);
  const taxLines: TaxLine[] = [];
  const addGroup = (ls: CalcLine[], rs: TaxRuleInput[], st: BillSettings) => {
    const r = computeTaxes(ls, presentation === 'rcm_note' ? [] : rs, st, exact);
    gross = gross.add(r.gross); base = base.add(r.base); taxExact = taxExact.add(r.taxExact); taxLines.push(...r.taxLines);
  };
  if (contractLines.length || ownGroups.size === 0) addGroup(contractLines, rules, input.settings);
  for (const [key, ls] of ownGroups) {
    const [, rate, mode] = key.split(':');
    addGroup(ls, [{ id: '', name: `GST @ ${dec(rate).toString()}%`, taxType: 'GST', rate, effectiveFrom: input.periodStart, effectiveTo: null, status: 'approved', sourceRef: null }], { ...input.settings, taxMode: mode === 'included' ? 'inclusive' : 'exclusive' });
  }
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
