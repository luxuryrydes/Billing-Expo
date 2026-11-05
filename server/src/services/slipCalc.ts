/**
 * The amount for a duty read from a scanned slip, worked out by the same engine that calculates bills, from the
 * rate version that is APPROVED and in force on the duty date for that contract, vehicle category and duty type.
 * Nothing is assumed: if no approved rate applies, or a value the rate needs is missing, the duty is marked for
 * review and no amount is shown.
 */
import type { Db } from '../db/index.js';
import { calculateBill } from '../engine/bill.js';
import type { BillSettings } from '../engine/types.js';
import { loadSchemeVersions } from '../routes/rates.js';
import type { DutyInputT } from './duties.js';

export interface CalcLineOut { label: string; quantity: string; unit: string; rate: string; amount: string; kind: string; taxCategory: string; formula: string; inputs: Record<string, string>; scope: string }
export interface CalcPreview {
  status: 'ok' | 'review';
  message: string | null;
  schemeVersionId: string | null;
  schemeId?: string | null;
  schemeName: string | null;
  versionNo: number | null;
  effectiveFrom: string | null;
  variables: Record<string, string>;
  lines: CalcLineOut[];
  taxLines: { name: string; rate: string; amount: string }[];
  totals: { taxable: string; nonTaxable: string; subtotal: string; tax: string; total: string } | null;
}

const empty = (message: string, extra: Partial<CalcPreview> = {}): CalcPreview => ({ status: 'review', message, schemeVersionId: null, schemeName: null, versionNo: null, effectiveFrom: null, variables: {}, lines: [], taxLines: [], totals: null, ...extra });

export async function previewCalculation(db: Db, d: DutyInputT, schemeId: string | null = null): Promise<CalcPreview> {
  const k = await db.one<Record<string, string>>('SELECT tax_mode, tax_level, invoice_rounding, arithmetic, client_id FROM contracts WHERE id = $1', [d.contractId]);
  if (!k) return empty('The contract could not be found.');
  if (!d.startKm || !d.endKm) return empty('Opening and closing km are needed before the amount can be calculated.');
  if (Number(d.endKm) < Number(d.startKm)) return empty('Closing km is less than opening km.');
  const schemes = await loadSchemeVersions(db, d.contractId, true);
  if (!schemes.length) return empty('This contract has no approved rate. Approve its rate scheme first.');
  const taxRules = (await db.query<{ id: string; name: string; tax_type: string; rate: string; effective_from: string; effective_to: string | null; status: string; source_ref: string | null }>(
    `SELECT * FROM tax_rules WHERE contract_id = $1 AND status = 'approved'`, [d.contractId])).map((r) => ({
    id: r.id, name: r.name, taxType: r.tax_type, rate: r.rate, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, status: r.status, sourceRef: r.source_ref,
  }));
  const settings: BillSettings = { taxMode: k.tax_mode as BillSettings['taxMode'], taxLevel: k.tax_level as BillSettings['taxLevel'], invoiceRounding: k.invoice_rounding as BillSettings['invoiceRounding'] };
  if (k.arithmetic === 'lr_exact') {
    const gm = (await db.one<{ gst_mode: string }>('SELECT gst_mode FROM clients WHERE id = $1', [k.client_id]))?.gst_mode;
    settings.arithmetic = 'lr_exact';
    settings.gstPresentation = gm === 'show_separate' ? 'show_separate' : gm === 'rcm' ? 'rcm_note' : 'add';
  }
  const category = d.vehicleCategoryId ? (await db.one<{ name: string }>('SELECT name FROM vehicle_categories WHERE id = $1', [d.vehicleCategoryId]))?.name ?? null : null;
  let out;
  try {
    out = calculateBill({
      periodStart: d.dutyDate, periodEnd: d.dutyDate, schemes, taxRules, settings,
      duties: [{
        id: 'preview', dutyDate: d.dutyDate, vehicleRegNo: d.vehicleRegNo, vehicleCategoryId: d.vehicleCategoryId ?? null, vehicleCategoryName: category,
        schemeId, dutyTypeCode: d.dutyTypeCode ?? null, startKm: d.startKm ?? null, endKm: d.endKm ?? null, startAt: d.startAt ?? null, endAt: d.endAt ?? null,
        toll: d.toll ?? null, parking: d.parking ?? null, otherCharges: d.otherCharges ?? null, customFields: d.customFields ?? {},
      }],
    });
  } catch (e) {
    return empty(`The amount could not be calculated: ${(e as Error).message}`);
  }
  const res = out.duties[0];
  const errors = out.exceptions.filter((e) => e.severity === 'error');
  if (!res?.schemeVersionId || !res.ok || errors.length) {
    return empty(errors.map((e) => e.message).join(' ') || 'No approved rate applies to this department, vehicle category, duty type and date.', { variables: res?.variables ?? {} });
  }
  const v = schemes.find((s) => s.id === res.schemeVersionId)!;
  const t = out.totals;
  const sum = (xs: string[]) => xs.reduce((a, x) => a + Math.round(Number(x) * 100), 0) / 100;
  const dutyLines = out.lines.filter((l) => l.dutyId === 'preview' || l.dutyId === null);
  return {
    status: 'ok',
    message: out.exceptions.length ? out.exceptions.map((e) => e.message).join(' ') : null,
    schemeVersionId: v.id, schemeId: v.schemeId, schemeName: v.schemeName, versionNo: v.versionNo, effectiveFrom: v.effectiveFrom,
    variables: res.variables,
    lines: dutyLines.map((l) => ({ label: l.label, quantity: l.quantity, unit: l.unit, rate: l.rate, amount: l.amount, kind: l.kind, taxCategory: l.taxCategory, formula: l.trace.formula, inputs: l.trace.inputs, scope: l.scope })),
    taxLines: out.taxLines.map((x) => ({ name: x.name, rate: x.rate, amount: x.amount })),
    totals: { taxable: t.taxableValue, nonTaxable: t.nonTaxableTotal, subtotal: sum([t.taxableValue, t.nonTaxableTotal]).toFixed(2), tax: t.taxTotal, total: t.grandTotal },
  };
}

/** Stores the calculation with the saved duty: the exact rate version, the lines and the totals. */
export async function saveCalculation(db: Db, dutyId: string, p: CalcPreview, userId: string, source = 'scan') {
  await db.query(
    `INSERT INTO duty_calculations(duty_id, scheme_version_id, scheme_name, version_no, effective_from, status, message, variables, lines, totals, source, calculated_by, calculated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
     ON CONFLICT (duty_id) DO UPDATE SET scheme_version_id = $2, scheme_name = $3, version_no = $4, effective_from = $5, status = $6, message = $7,
       variables = $8, lines = $9, totals = $10, source = $11, calculated_by = $12, calculated_at = now()`,
    [dutyId, p.schemeVersionId, p.schemeName, p.versionNo, p.effectiveFrom, p.status, p.message, JSON.stringify(p.variables), JSON.stringify({ lines: p.lines, taxLines: p.taxLines }), JSON.stringify(p.totals ?? {}), source, userId],
  );
}
