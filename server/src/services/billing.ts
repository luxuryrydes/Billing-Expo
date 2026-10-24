import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { calculateBill, type BillCalcOutput } from '../engine/bill.js';
import type { BillSettings, CalcException, SchemeVersion, TaxRuleInput } from '../engine/types.js';
import { dec } from '../engine/decimal.js';
import { badRequest, conflict, notFound } from '../lib/http.js';
import { loadFile, saveFile } from '../lib/storage.js';
import { audit } from '../lib/audit.js';
import { loadSchemeVersions } from '../routes/rates.js';
import { buildRenderModel, fmtDate, inr, placeholders, type BillContext, type RenderDuty } from './render.js';
import { inspectXlsx, renderLayoutXlsx, renderMappedXlsx, renderRegisterXlsx, XlsxMappingSchema } from './excel.js';
import { renderPdf } from './pdf.js';
import { runWorker } from './extraction.js';

export const EDITABLE_STATUSES = ['draft', 'calculation_pending', 'validation_required', 'under_review'];
export const FINAL_STATUSES = ['approved', 'generated', 'submitted'];

export interface SnapshotInput {
  period: { start: string; end: string };
  bill: { billDate: string; revisionNo: number };
  client: BillContext['client'];
  supplier: BillContext['supplier'];
  contract: BillContext['contract'] & { id: string; tax_mode: string; tax_level: string; invoice_rounding: string };
  settings: BillSettings;
  schemes: SchemeVersion[];
  taxRules: TaxRuleInput[];
  duties: RenderDuty[];
  excluded: { dutyId: string; reason: string }[];
}

interface BillRow {
  id: string; client_id: string; contract_id: string; period_start: string; period_end: string; bill_no: string | null; bill_date: string | null;
  status: string; revision_no: number; revision_of: string | null; template_version_id: string | null; current_snapshot_id: string | null;
  excluded_duties: { dutyId: string; reason: string }[]; include_unverified: boolean; created_by: string; reviewed_by: string | null;
}

export async function getBill(db: Db, id: string): Promise<BillRow> {
  const b = await db.one<BillRow>('SELECT * FROM bills WHERE id = $1', [id]);
  if (!b) throw notFound('Bill');
  return b;
}

/** Root of the revision chain (the original bill). */
async function revisionFamily(db: Db, bill: BillRow): Promise<string[]> {
  const ids = [bill.id];
  let cur = bill.revision_of;
  while (cur) {
    ids.push(cur);
    const p = await db.one<{ revision_of: string | null }>('SELECT revision_of FROM bills WHERE id = $1', [cur]);
    cur = p?.revision_of ?? null;
  }
  return ids;
}

/** Duties eligible for a bill and the problems that block or need review. */
export async function eligibleDuties(db: Db, bill: BillRow) {
  const family = await revisionFamily(db, bill);
  const rows = await db.query<Record<string, unknown>>(
    `SELECT d.*, vc.name AS vehicle_category_name,
            (SELECT b2.bill_no || ' (' || b2.status || ')' FROM bill_duties bd JOIN bills b2 ON b2.id = bd.bill_id WHERE bd.duty_id = d.id AND bd.active AND NOT (bd.bill_id = ANY($4::uuid[])) LIMIT 1) AS other_bill
     FROM duties d LEFT JOIN vehicle_categories vc ON vc.id = d.vehicle_category_id
     WHERE d.contract_id = $1 AND d.duty_date BETWEEN $2 AND $3 AND d.status <> 'void'
     ORDER BY d.duty_date, d.start_at, d.vehicle_reg_no`,
    [bill.contract_id, bill.period_start, bill.period_end, family],
  );
  return rows;
}

function toRenderDuty(r: Record<string, unknown>): RenderDuty {
  return {
    id: String(r.id), dutyDate: String(r.duty_date), vehicleRegNo: String(r.vehicle_reg_no), vehicleCategoryId: (r.vehicle_category_id as string) ?? null,
    vehicleCategoryName: (r.vehicle_category_name as string) ?? null, dutyTypeCode: (r.duty_type_code as string) ?? null,
    startKm: (r.start_km as string) ?? null, endKm: (r.end_km as string) ?? null,
    startAt: r.start_at ? String(r.start_at).slice(0, 16) : null, endAt: r.end_at ? String(r.end_at).slice(0, 16) : null,
    toll: (r.toll_amount as string) ?? null, parking: (r.parking_amount as string) ?? null, otherCharges: (r.other_charges as string) ?? null,
    customFields: (r.custom_fields as Record<string, unknown>) ?? {}, driverName: (r.driver_name as string) ?? null, fieldOfficer: (r.field_officer as string) ?? null,
    remarks: (r.remarks as string) ?? null,
    vehicleModel: (r.vehicle_model as string) ?? null,
  };
}

const hashOf = (v: unknown) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

/**
 * Recalculates a bill from current duties and approved rules, writing a new
 * immutable snapshot and replacing the working lines and exceptions.
 */
export async function calculate(db: Db, billId: string, userId: string) {
  return db.tx(async (t) => {
    const bill = await getBill(t, billId);
    if (!EDITABLE_STATUSES.includes(bill.status)) throw conflict(`A ${bill.status} bill cannot be recalculated. Create a revision instead.`);
    const k = await t.one<Record<string, string>>('SELECT * FROM contracts WHERE id = $1', [bill.contract_id]);
    const client = await t.one<BillContext['client']>('SELECT name, billing_address, gstin, pan, state_name, state_code FROM clients WHERE id = $1', [bill.client_id]);
    const supplier = k!.supplier_profile_id
      ? await t.one<NonNullable<BillContext['supplier']>>('SELECT name, address, gstin, pan, state_name, state_code, phone, email, bank_details FROM supplier_profiles WHERE id = $1', [k!.supplier_profile_id])
      : await t.one<NonNullable<BillContext['supplier']>>('SELECT name, address, gstin, pan, state_name, state_code, phone, email, bank_details FROM supplier_profiles WHERE is_default LIMIT 1');
    const schemes = await loadSchemeVersions(t, bill.contract_id, true);
    const taxRules = (await t.query<{ id: string; name: string; tax_type: string; rate: string; effective_from: string; effective_to: string | null; status: string; source_ref: string | null }>(
      `SELECT * FROM tax_rules WHERE contract_id = $1 AND status = 'approved'`, [bill.contract_id])).map((r) => ({
      id: r.id, name: r.name, taxType: r.tax_type, rate: r.rate, effectiveFrom: r.effective_from, effectiveTo: r.effective_to, status: r.status, sourceRef: r.source_ref,
    }));
    const settings: BillSettings = { taxMode: k!.tax_mode as BillSettings['taxMode'], taxLevel: k!.tax_level as BillSettings['taxLevel'], invoiceRounding: k!.invoice_rounding as BillSettings['invoiceRounding'] };

    const rows = await eligibleDuties(t, bill);
    const excludedIds = new Set(bill.excluded_duties.map((e) => e.dutyId));
    const pre: CalcException[] = [];
    const included: Record<string, unknown>[] = [];
    for (const r of rows) {
      const id = String(r.id);
      if (excludedIds.has(id)) continue;
      if (r.other_bill) { pre.push({ dutyId: id, code: 'ALREADY_BILLED', severity: 'error', message: `Duty is already on bill ${r.other_bill}. Exclude it here or cancel the other bill.` }); continue; }
      included.push(r);
      const issues = (r.issues as { code: string; severity: string; message: string }[]) ?? [];
      for (const i of issues.filter((x) => x.severity === 'error')) pre.push({ dutyId: id, code: `DUTY_${i.code}`, severity: 'error', message: i.message });
      for (const i of issues.filter((x) => x.severity === 'warning')) pre.push({ dutyId: id, code: `DUTY_${i.code}`, severity: 'warning', message: i.message });
      if (r.status !== 'verified') pre.push({ dutyId: id, code: 'UNVERIFIED_DUTY', severity: bill.include_unverified ? 'warning' : 'error', message: 'Duty has not been verified against the duty slip' });
    }
    if (included.length === 0) pre.push({ dutyId: null, code: 'NO_DUTIES', severity: 'error', message: 'No eligible duties for this contract and period.' });

    const duties = included.map(toRenderDuty);
    const output = calculateBill({ periodStart: bill.period_start, periodEnd: bill.period_end, duties, schemes, taxRules, settings });
    const exceptions = [...pre, ...output.exceptions];

    const input: SnapshotInput = {
      period: { start: bill.period_start, end: bill.period_end },
      bill: { billDate: bill.bill_date ?? bill.period_end, revisionNo: bill.revision_no },
      client: client!, supplier: supplier ?? null,
      contract: { id: k!.id, title: k!.title, reference_no: k!.reference_no, po_number: k!.po_number, sac_code: k!.sac_code, tax_mode: k!.tax_mode, tax_level: k!.tax_level, invoice_rounding: k!.invoice_rounding },
      settings, schemes, taxRules, duties, excluded: bill.excluded_duties,
    };
    const snap = await t.one<{ id: string }>(
      `INSERT INTO calculation_snapshots(bill_id, engine_version, input, output, content_hash, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [billId, output.engineVersion, input, output, hashOf({ input, output }), userId],
    );
    const snapshotId = snap!.id;

    // Carry forward waivers for identical warnings from the previous calculation.
    const prevWaivers = await t.query<{ code: string; duty_id: string | null; message: string; status: string; resolution_note: string | null; resolved_by: string | null }>(
      `SELECT code, duty_id, message, status, resolution_note, resolved_by FROM billing_exceptions WHERE bill_id = $1 AND status = 'waived'`, [billId]);
    await t.query('DELETE FROM bill_lines WHERE bill_id = $1', [billId]);
    await t.query('DELETE FROM bill_tax_lines WHERE bill_id = $1', [billId]);
    await t.query('DELETE FROM billing_exceptions WHERE bill_id = $1', [billId]);

    let order = 0;
    for (const l of output.lines) {
      await t.query(
        `INSERT INTO bill_lines(bill_id, snapshot_id, duty_id, vehicle_reg_no, scope, component_code, label, kind, quantity, unit, rate, amount, tax_category, trace, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [billId, snapshotId, l.dutyId, l.vehicleRegNo, l.scope, l.componentCode, l.label, l.kind, l.quantity, l.unit, l.rate, l.amount, l.taxCategory, l.trace, order++],
      );
    }
    for (const tl of output.taxLines) {
      await t.query(`INSERT INTO bill_tax_lines(bill_id, snapshot_id, tax_rule_id, name, tax_type, rate, taxable_base, amount) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [billId, snapshotId, tl.taxRuleId, tl.name, tl.taxType, tl.rate, tl.taxableBase, tl.amount]);
    }
    for (const e of exceptions) {
      const w = e.severity === 'warning' ? prevWaivers.find((p) => p.code === e.code && p.duty_id === e.dutyId && p.message === e.message) : undefined;
      await t.query(
        `INSERT INTO billing_exceptions(bill_id, snapshot_id, duty_id, code, severity, message, status, resolution_note, resolved_by, resolved_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [billId, snapshotId, e.dutyId, e.code, e.severity, e.message, w ? 'waived' : 'open', w?.resolution_note ?? null, w?.resolved_by ?? null, w ? new Date().toISOString() : null],
      );
    }
    // Link duties. A revision's links stay inactive until it is approved (the original keeps them).
    const isRevision = !!bill.revision_of;
    await t.query('DELETE FROM bill_duties WHERE bill_id = $1', [billId]);
    for (const d of duties) await t.query('INSERT INTO bill_duties(bill_id, duty_id, active) VALUES ($1,$2,$3)', [billId, d.id, !isRevision]);

    const open = exceptions.length > 0 && (await t.one<{ n: number }>(`SELECT count(*)::int AS n FROM billing_exceptions WHERE bill_id = $1 AND status = 'open'`, [billId]))!.n > 0;
    const tt = output.totals;
    await t.query(
      `UPDATE bills SET current_snapshot_id=$2, taxable_value=$3, non_taxable_total=$4, tax_total=$5, round_off=$6, grand_total=$7,
         status=$8, reviewed_by=NULL, reviewed_at=NULL, updated_at=now() WHERE id=$1`,
      [billId, snapshotId, tt.taxableValue, tt.nonTaxableTotal, tt.taxTotal, tt.roundOff, tt.grandTotal, open ? 'validation_required' : 'draft'],
    );
    await audit(t, userId, 'bill', billId, 'calculate', undefined, { snapshotId, duties: duties.length, grandTotal: tt.grandTotal, exceptions: exceptions.length });
    return { snapshotId, totals: tt, exceptions: exceptions.length, checks: output.checks };
  });
}

/** True if any duty on the bill changed after the last calculation. */
export async function isStale(db: Db, billId: string): Promise<boolean> {
  const r = await db.one<{ stale: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM bill_duties bd JOIN duties d ON d.id = bd.duty_id JOIN bills b ON b.id = bd.bill_id
       JOIN calculation_snapshots s ON s.id = b.current_snapshot_id
       WHERE bd.bill_id = $1 AND (d.updated_at > s.created_at OR d.status = 'void')
     ) OR EXISTS (
       SELECT 1 FROM duties d JOIN bills b ON b.id = $1 JOIN calculation_snapshots s ON s.id = b.current_snapshot_id
       WHERE d.contract_id = b.contract_id AND d.duty_date BETWEEN b.period_start AND b.period_end AND d.status <> 'void' AND d.created_at > s.created_at
     ) AS stale`,
    [billId],
  );
  return !!r?.stale;
}

export async function loadBillContext(db: Db, billId: string): Promise<BillContext> {
  const bill = await getBill(db, billId);
  if (!bill.current_snapshot_id) throw badRequest('The bill has not been calculated yet');
  const s = await db.one<{ input: SnapshotInput; output: BillCalcOutput }>('SELECT input, output FROM calculation_snapshots WHERE id = $1', [bill.current_snapshot_id]);
  const inp = s!.input;
  return {
    bill: { billNo: bill.bill_no ?? 'DRAFT', billDate: bill.bill_date ?? inp.bill.billDate, periodStart: inp.period.start, periodEnd: inp.period.end, revisionNo: bill.revision_no },
    client: inp.client,
    supplier: inp.supplier,
    contract: inp.contract,
    duties: inp.duties,
    output: s!.output,
  };
}

/** Financial-year aware bill number: tokens {CLIENT} {YYYY} {MM} {FY} {SEQ}. */
export async function nextBillNo(db: Db, bill: BillRow): Promise<string> {
  const k = await db.one<{ bill_no_format: string }>('SELECT bill_no_format FROM contracts WHERE id = $1', [bill.contract_id]);
  const c = await db.one<{ short_code: string }>('SELECT short_code FROM clients WHERE id = $1', [bill.client_id]);
  // GST invoice series run per financial year of the invoice date.
  const ref = bill.bill_date ?? bill.period_end;
  const [y, m, d] = ref.split('-').map(Number);
  const fyStart = m >= 4 ? y : y - 1;
  const fy = `${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const fys = `${String(fyStart % 100).padStart(2, '0')}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
  const [py, pm, pd] = bill.period_start.split('-');
  const base = k!.bill_no_format.replace('{CLIENT}', c!.short_code).replace('{YYYY}', String(y)).replace('{MM}', String(m).padStart(2, '0'))
    .replace('{DD}', String(d).padStart(2, '0')).replace('{PYYYY}', py).replace('{PMM}', pm).replace('{PDD}', pd).replace('{FYS}', fys).replace('{FY}', fy);
  const seq = /\{SEQ(?::(\d+))?\}/.exec(base);
  if (!seq) return base;
  const width = Number(seq[1] ?? 3);
  const prefix = base.slice(0, seq.index);
  const suffix = base.slice(seq.index + seq[0].length);
  // Highest number already issued in this series, or the configured continuation of an existing paper series.
  const issued = await db.query<{ bill_no: string }>(`SELECT DISTINCT bill_no FROM bills WHERE bill_no LIKE $1 || '%' AND revision_no = 0`, [prefix]);
  const maxIssued = issued.reduce((mx, r) => {
    const n = Number(r.bill_no.slice(prefix.length, r.bill_no.length - suffix.length || undefined));
    return Number.isFinite(n) && n > mx ? n : mx;
  }, 0);
  const configured = (await db.one<{ value: Record<string, number> }>(`SELECT value FROM app_settings WHERE key = 'billSeriesNext'`))?.value?.[prefix] ?? 1;
  return `${prefix}${String(Math.max(maxIssued + 1, configured)).padStart(width, '0')}${suffix}`;
}

export interface Reconciliation { ok: boolean; checks: { name: string; ok: boolean; detail: string }[] }

/** Generates the customer bill (xlsx + pdf) and the internal register from the frozen snapshot, then cross-checks them. */
export async function generateOutputs(db: Db, billId: string, userId: string) {
  const bill = await getBill(db, billId);
  if (!bill.template_version_id) throw badRequest('Select an approved billing template for this bill');
  const tv = await db.one<{ status: string; layout: unknown; xlsx_file_id: string | null; xlsx_mapping: unknown }>('SELECT * FROM billing_template_versions WHERE id = $1', [bill.template_version_id]);
  if (!tv) throw notFound('Template version');
  if (tv.status === 'draft') throw badRequest('The bill\'s template version is not approved');
  const ctx = await loadBillContext(db, billId);
  const model = buildRenderModel(ctx, tv.layout);
  const tokens = { ...placeholders(ctx), periodLabel: model.headerFields.find((h) => h.label === 'Period')?.value ?? '' };
  const xlsx = tv.xlsx_file_id && tv.xlsx_mapping
    ? await renderMappedXlsx((await loadFile(db, tv.xlsx_file_id))!.buf, XlsxMappingSchema.parse(tv.xlsx_mapping), model, tokens)
    : await renderLayoutXlsx(model);
  const pdf = await renderPdf(model);

  // Reconciliation -------------------------------------------------------
  const checks: Reconciliation['checks'] = [];
  const snapTotal = dec(ctx.output.totals.grandTotal);
  checks.push({ name: 'Snapshot lines reconcile to totals', ok: ctx.output.checks.every((c) => c.ok), detail: ctx.output.checks.filter((c) => !c.ok).map((c) => c.name).join('; ') || 'all engine checks passed' });
  checks.push({ name: 'Render model total = snapshot total', ok: dec(model.grandTotal).eq(snapTotal), detail: `${model.grandTotal} vs ${snapTotal.toFixed(2)}` });
  const ix = await inspectXlsx(xlsx);
  checks.push({ name: 'Excel contains grand total', ok: ix.numbers.includes(snapTotal.toFixed(2)), detail: inr(snapTotal) });
  checks.push({ name: 'Excel contains bill number', ok: ix.texts.some((t) => t.includes(ctx.bill.billNo)), detail: ctx.bill.billNo });
  const regs = new Set(ctx.duties.map((d) => d.vehicleRegNo));
  const xlsxRegs = [...regs].filter((r) => ix.texts.some((t) => t === r));
  if (model.columns.some((c) => c.key === 'vehicleRegNo')) checks.push({ name: 'Excel vehicle numbers kept as text', ok: xlsxRegs.length === regs.size, detail: `${xlsxRegs.length}/${regs.size}` });
  const tmp = path.join(os.tmpdir(), `lrbill-${billId}-${Date.now()}.pdf`);
  fs.writeFileSync(tmp, pdf);
  try {
    const pdfText = (await runWorker(tmp, 60_000)).pages.map((p) => p.text).join('\n');
    const flat = pdfText.replace(/\s+/g, ' ');
    // The total as this layout prints it (Indian grouping or plain digits).
    const shown = model.summary.find((x) => x.strong)?.value ?? inr(snapTotal);
    checks.push({ name: 'PDF contains grand total', ok: flat.includes(shown), detail: shown });
    checks.push({ name: 'PDF contains bill number', ok: flat.includes(ctx.bill.billNo), detail: ctx.bill.billNo });
    if (model.columns.some((c) => c.key === 'vehicleRegNo')) {
      const missing = [...regs].filter((r) => !flat.includes(r));
      checks.push({ name: 'PDF shows every vehicle number', ok: missing.length === 0, detail: missing.length ? `missing: ${missing.slice(0, 5).join(', ')}` : `${regs.size} vehicles` });
    }
    for (const s of model.summary) checks.push({ name: `PDF shows "${s.label}"`, ok: flat.includes(s.value), detail: s.value });
  } catch (e) {
    checks.push({ name: 'PDF text check', ok: false, detail: `Could not read the PDF back: ${(e as Error).message}` });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  const reconciliation: Reconciliation = { ok: checks.every((c) => c.ok), checks };

  const safeNo = (bill.bill_no ?? 'DRAFT').replace(/[^\w.-]+/g, '_');
  const rev = bill.revision_no ? `_R${bill.revision_no}` : '';
  const xf = await saveFile(db, `${safeNo}${rev}.xlsx`, xlsx, userId);
  const pf = await saveFile(db, `${safeNo}${rev}.pdf`, pdf, userId);
  const dutyDate = new Map(ctx.duties.map((d) => [d.id, d.dutyDate]));
  const exc = await db.query<Record<string, unknown>>(`SELECT e.*, d.vehicle_reg_no || ' ' || d.duty_date AS duty FROM billing_exceptions e LEFT JOIN duties d ON d.id = e.duty_id WHERE e.bill_id = $1`, [billId]);
  const reg = await renderRegisterXlsx(
    `Calculation register — ${ctx.client.name} — ${ctx.bill.billNo} — ${fmtDate(ctx.bill.periodStart)} to ${fmtDate(ctx.bill.periodEnd)} (internal)`,
    ctx.output.lines.map((l) => ({ ...l, dutyDate: l.dutyId ? fmtDate(dutyDate.get(l.dutyId)) : '', formula: l.trace.formula, inputs: Object.entries(l.trace.inputs).map(([k, v]) => `${k}=${v}`).join(', '), rule: `${l.trace.schemeName} v${l.trace.versionNo}`, clauseRef: l.trace.clauseRef })),
    exc,
  );
  const rf = await saveFile(db, `${safeNo}${rev}_calculation_register.xlsx`, reg, userId);
  await db.tx(async (t) => {
    for (const [kind, f] of [['bill_xlsx', xf], ['bill_pdf', pf], ['register_xlsx', rf]] as const) {
      await t.query(`INSERT INTO generated_files(bill_id, snapshot_id, template_version_id, kind, file_id, reconciliation, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [billId, bill.current_snapshot_id, bill.template_version_id, kind, f.id, reconciliation, userId]);
    }
    if (bill.status === 'approved') await t.query(`UPDATE bills SET status='generated', updated_at=now() WHERE id=$1`, [billId]);
    await audit(t, userId, 'bill', billId, 'generate', undefined, { reconciliation: reconciliation.ok, files: [xf.id, pf.id, rf.id] });
  });
  return { reconciliation, files: { xlsx: xf.id, pdf: pf.id, register: rf.id } };
}
