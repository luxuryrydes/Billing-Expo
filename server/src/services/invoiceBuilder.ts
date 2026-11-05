/**
 * Department-wise invoices: which saved duties can go on an invoice, what the invoice would come to, and a summary a person
 * checks before generating it. The numbers come from the same engine, approved rates and approved tax rules as a bill; nothing is
 * stored by a preview.
 */
import type { Db } from '../db/index.js';
import { calculateBill } from '../engine/bill.js';
import type { BillSettings } from '../engine/types.js';
import { loadSchemeVersions } from '../routes/rates.js';
import { toRenderDuty } from './billing.js';

export interface DutyRow extends Record<string, unknown> { id: string }

/** The duties of a contract in a period, each with how it stands for billing. */
export async function periodDuties(db: Db, contractId: string, from: string, to: string): Promise<(DutyRow & { bill_state: string; bill_no: string | null; bill_id: string | null })[]> {
  return db.query(
    `SELECT d.*, vc.name AS vehicle_category_name,
            ab.id AS bill_id, ab.bill_no, ab.status AS bill_status,
            CASE WHEN ab.id IS NOT NULL AND ab.status IN ('approved','generated','submitted') THEN 'billed'
                 WHEN ab.id IS NOT NULL THEN 'draft'
                 WHEN EXISTS (SELECT 1 FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id WHERE bd.duty_id = d.id AND b.status = 'cancelled') THEN 'cancelled'
                 ELSE 'unbilled' END AS bill_state,
            rs.name AS chosen_rate_card
     FROM duties d LEFT JOIN vehicle_categories vc ON vc.id = d.vehicle_category_id
     LEFT JOIN rate_schemes rs ON rs.id = d.rate_scheme_id
     LEFT JOIN LATERAL (SELECT b.id, b.bill_no, b.status FROM bill_duties bd JOIN bills b ON b.id = bd.bill_id
                        WHERE bd.duty_id = d.id AND bd.active AND b.status NOT IN ('cancelled','superseded') LIMIT 1) ab ON true
     WHERE d.contract_id = $1 AND d.duty_date BETWEEN $2 AND $3 AND d.status <> 'void'
     ORDER BY d.duty_date, d.start_at, d.vehicle_reg_no`, [contractId, from, to]);
}

export interface InvoiceSummary {
  duties: number; totalKm: string; extraKm: string; extraKmAmount: string; extraHours: string; extraHoursAmount: string; nights: string; nightAmount: string;
  parking: string; toll: string; other: string; basicAmount: string; nonTaxable: string; gst: string; roundOff: string; finalAmount: string;
  problems: { dutyId: string | null; message: string }[];
}
export interface DutyPreview { dutyId: string; ok: boolean; amount: string | null; schemeId: string | null; schemeName: string | null; versionNo: number | null; message: string | null; manual: boolean; tax: string }
export type ManualTax = { mode: 'contract' | 'non_taxable' | 'custom'; rate?: string; included?: boolean };

const add = (a: number, b: string | number) => a + Math.round(Number(b) * 100);
const money = (c: number) => (c / 100).toFixed(2);
const sumVar = (vars: Record<string, string>[], k: string) => vars.reduce((a, v) => a + Number(v[k] ?? 0), 0);

/** What these duties would come to as one invoice. Duties without an applicable approved rate are reported, not guessed. */
export async function invoicePreview(db: Db, contractId: string, from: string, to: string, rows: DutyRow[], manualTax: ManualTax | null = null): Promise<{ summary: InvoiceSummary; perDuty: Map<string, DutyPreview> }> {
  const k = await db.one<Record<string, string>>('SELECT tax_mode, tax_level, invoice_rounding, arithmetic, client_id FROM contracts WHERE id = $1', [contractId]);
  const empty: InvoiceSummary = { duties: rows.length, totalKm: '0', extraKm: '0', extraKmAmount: '0.00', extraHours: '0', extraHoursAmount: '0.00', nights: '0', nightAmount: '0.00', parking: '0.00', toll: '0.00', other: '0.00', basicAmount: '0.00', nonTaxable: '0.00', gst: '0.00', roundOff: '0.00', finalAmount: '0.00', problems: [] };
  if (!k || rows.length === 0) return { summary: empty, perDuty: new Map() };
  const schemes = await loadSchemeVersions(db, contractId, true);
  const taxRules = (await db.query<{ id: string; name: string; tax_type: string; rate: string; effective_from: string; effective_to: string | null; status: string; source_ref: string | null }>(
    `SELECT * FROM tax_rules WHERE contract_id = $1 AND status = 'approved'`, [contractId])).map((r) => ({
    id: r.id, name: r.name, taxType: r.tax_type, rate: r.rate, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, status: r.status, sourceRef: r.source_ref,
  }));
  const settings: BillSettings = { taxMode: k.tax_mode as BillSettings['taxMode'], taxLevel: k.tax_level as BillSettings['taxLevel'], invoiceRounding: k.invoice_rounding as BillSettings['invoiceRounding'] };
  if (k.arithmetic === 'lr_exact') {
    const gm = (await db.one<{ gst_mode: string }>('SELECT gst_mode FROM clients WHERE id = $1', [k.client_id]))?.gst_mode;
    settings.arithmetic = 'lr_exact';
    settings.gstPresentation = gm === 'show_separate' ? 'show_separate' : gm === 'rcm' ? 'rcm_note' : 'add';
  }
  if (manualTax) settings.manualTax = manualTax;
  const out = calculateBill({ periodStart: from, periodEnd: to, duties: rows.map(toRenderDuty), schemes, taxRules, settings });
  const perDuty = new Map<string, DutyPreview>();
  for (const r of out.duties) {
    const v = schemes.find((s) => s.id === r.schemeVersionId);
    const err = out.exceptions.find((e) => e.dutyId === r.dutyId && e.severity === 'error');
    const row = rows.find((x) => x.id === r.dutyId);
    const isManual = row?.manual_amount != null;
    const t = v?.config.tax;
    const tax = isManual ? (manualTax?.mode === 'non_taxable' ? 'Non-taxable' : manualTax?.mode === 'custom' ? `GST ${manualTax.rate}% ${manualTax.included ? 'included' : 'extra'}` : 'Contract tax rules') : t ? (t.taxable ? (t.rate ? `GST ${t.rate}% ${t.mode === 'included' ? 'included' : 'extra'}` : 'Contract tax rules') : 'Non-taxable') : 'Contract tax rules';
    perDuty.set(r.dutyId, { dutyId: r.dutyId, ok: r.ok && !err, amount: r.ok && !err ? r.total : null, schemeId: v?.schemeId ?? null, schemeName: isManual ? 'Amount entered by hand' : v?.schemeName ?? null, versionNo: v?.versionNo ?? null, message: err?.message ?? null, manual: isManual, tax });
  }
  const code = (c: string) => c.toUpperCase();
  let exKm = 0, exHr = 0, night = 0, park = 0, toll = 0, other = 0;
  for (const l of out.lines) {
    const c = code(l.componentCode);
    const cents = Math.round(Number(l.amount) * 100);
    if (/^EX.*KM|EXTRA.?KM/.test(c)) exKm += cents;
    else if (/^EX.*(HR|HOUR)|EXTRA.?H/.test(c)) exHr += cents;
    else if (/NIGHT/.test(c)) night += cents;
    else if (/PARK/.test(c)) park += cents;
    else if (/TOLL/.test(c)) toll += cents;
    else if (l.kind === 'reimbursement') other += cents;
  }
  const vars = out.duties.map((d) => d.variables);
  const t = out.totals;
  return {
    perDuty,
    summary: {
      duties: rows.length, totalKm: String(sumVar(vars, 'actual_km')), extraKm: String(sumVar(vars, 'extra_km')), extraKmAmount: money(exKm), extraHours: String(Math.round(sumVar(vars, 'extra_hours') * 100) / 100),
      extraHoursAmount: money(exHr), nights: String(sumVar(vars, 'night_count')), nightAmount: money(night), parking: money(park), toll: money(toll), other: money(other),
      basicAmount: t.taxableValue, nonTaxable: t.nonTaxableTotal, gst: t.taxTotal, roundOff: t.roundOff, finalAmount: t.grandTotal,
      problems: out.exceptions.filter((e) => e.severity === 'error').map((e) => ({ dutyId: e.dutyId, message: e.message })),
    },
  };
}
void add;
