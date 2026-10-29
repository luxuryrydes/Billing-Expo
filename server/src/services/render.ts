/**
 * Builds one format-neutral render model for a bill from its calculation
 * snapshot and an approved template layout. Excel and PDF are both produced
 * from this model so that they always agree; reconciliation then re-reads the
 * generated files and compares them against it.
 */
import { z } from 'zod';
import { D, dec, type Dec } from '../engine/decimal.js';
import type { BillCalcOutput } from '../engine/bill.js';
import type { CalcLine, DutyInput } from '../engine/types.js';

export const ColumnSchema = z.object({
  key: z.string().min(1),
  label: z.string(),
  group: z.string().optional(),
  width: z.number().positive().default(1),
  align: z.enum(['left', 'center', 'right']).optional(),
  format: z.enum(['text', 'date', 'time', 'datetime', 'number', 'money', 'km', 'hours']).default('text'),
  total: z.boolean().default(false),
});
export type Column = z.infer<typeof ColumnSchema>;

/** `column` puts the value under a named column instead of the last one (e.g. toll and parking under Non Taxable). */
export const SummarySchema = z.object({ label: z.string(), value: z.string(), column: z.enum(['amount', 'nonTaxable']).optional() });

/** Wording of the rows inside a duty block. Tokens: {vehicleShort} {vehicleRegNo} {vehicleModel} {vehicleCategory} {includedKm} {includedHours} {totalKm} {totalHours} {driverName} {fieldOfficer} */
export const BlockSchema = z.object({
  header: z.string().default('Duty for ({vehicleShort} {vehicleModel} )'),
  packageLabel: z.string().default('Upto : {includedKm} kms./{includedHours} hrs duty'),
  runningLabel: z.string().default('Total running : ( {totalKm} kms./{totalHours} hrs )'),
  componentLabels: z.record(z.string(), z.string()).default({}),
  /** Show toll + parking (all reimbursements) as one row */
  mergeReimbursements: z.boolean().default(true),
  reimbursementLabel: z.string().default('Toll Tax & Parking'),
  vehicleShortDigits: z.number().int().min(0).max(10).default(4),
  blankRowBetween: z.boolean().default(true),
  showPackageUnit: z.boolean().default(false),
  /**
   * The LR Taxi Services merged-invoice wording: a fixed-price duty is one heading row carrying its amount
   * (" - Airport Drop"), a multi-day package shows "(N Days × rate = amount)" and a "Days: N - Total running…" line.
   */
  lrWording: z.boolean().default(false),
  /** Wording of the running line for a multi-day duty. Tokens as above plus {days} {allowedKm}. */
  multiDayRunningLabel: z.string().default('Days: {days} - Total running: ({totalKm} kms/{totalHours} hrs) - Allowed: {allowedKm} kms'),
  /** Component codes in print order; other components follow in calculation order. */
  chargeOrder: z.array(z.string()).default([]),
});

export const LayoutSchema = z.object({
  page: z.object({
    size: z.enum(['A4', 'A3', 'LEGAL']).default('A4'),
    orientation: z.enum(['portrait', 'landscape']).default('landscape'),
    margins: z.tuple([z.number(), z.number(), z.number(), z.number()]).default([28, 28, 28, 36]),
    fontSize: z.number().min(5).max(14).default(8),
  }).default({ size: 'A4', orientation: 'landscape', margins: [28, 28, 28, 36], fontSize: 8 }),
  title: z.string().default('TAX INVOICE'),
  /** box = a bordered letterhead: supplier title, client, address and custom fields on the left, header fields on the right. */
  letterhead: z.enum(['standard', 'box']).default('standard'),
  /** Print the summary (taxable amount, tax, total) as rows inside the table instead of a block below it. */
  totalsInTable: z.boolean().default(false),
  /** Shown beside the total in the last row when totalsInTable is on. */
  brandLabel: z.string().default('L.R TAXI SERVICES'),
  showSupplier: z.boolean().default(true),
  showClient: z.boolean().default(true),
  headerFields: z.array(z.object({ label: z.string(), value: z.string() })).default([
    { label: 'Bill No.', value: '{billNo}' },
    { label: 'Bill Date', value: '{billDate}' },
    { label: 'Contract Ref.', value: '{contractRef}' },
    { label: 'Period', value: '{periodLabel}' },
  ]),
  periodLabel: z.string().default('{periodStart} to {periodEnd}'),
  /** duty = one row per duty; line = one row per charge; block = a heading row per duty followed by one row per charge (e.g. DRI format) */
  rowMode: z.enum(['duty', 'line', 'block']).default('duty'),
  block: BlockSchema.default(BlockSchema.parse({})),
  dateFormat: z.enum(['dd-mm-yyyy', 'dd.mm.yyyy', 'dd/mm/yyyy', 'dd.mm.yy']).default('dd-mm-yyyy'),
  /** indian = 1,23,456.00; plain = 123456.00 */
  numberStyle: z.enum(['indian', 'plain']).default('indian'),
  /** Label for each tax line when a summary row uses "taxLines". Tokens: {name} {taxType} {rate} {base} */
  taxLabel: z.string().default('{name} @ {rate}% on {base}'),
  clientBlockStyle: z.enum(['bill_to', 'name_address_gstin']).default('bill_to'),
  sortBy: z.enum(['date', 'vehicle']).default('date'),
  groupBy: z.enum(['none', 'vehicle', 'date']).default('none'),
  columns: z.array(ColumnSchema).min(1),
  summary: z.array(SummarySchema).default([
    { label: 'Taxable value', value: 'taxableValue' },
    { label: '{tax}', value: 'taxLines' },
    { label: 'Non-taxable (reimbursements)', value: 'nonTaxableTotal' },
    { label: 'Round off', value: 'roundOff' },
    { label: 'Total payable', value: 'grandTotal' },
  ]),
  amountInWords: z.boolean().default(true),
  notes: z.array(z.string()).default([]),
  declaration: z.string().default(''),
  signatures: z.array(z.string()).default(['Authorised Signatory']),
  includeDutyRegister: z.boolean().default(false),
});
export type Layout = z.infer<typeof LayoutSchema>;

/** Column keys available in a duty-row layout. Component columns use comp:<CODE>:amount|qty|rate. */
export const DUTY_COLUMN_KEYS: Record<string, string> = {
  sno: 'Serial number',
  dutyDate: 'Duty date',
  vehicleRegNo: 'Vehicle number',
  vehicleCategory: 'Vehicle category',
  driverName: 'Driver',
  fieldOfficer: 'User / officer',
  dutyType: 'Duty type',
  startKm: 'Starting km',
  endKm: 'Closing km',
  totalKm: 'Billable km',
  startTime: 'Starting time',
  endTime: 'Closing time',
  startDateTime: 'Start date & time',
  endDateTime: 'Closing date & time',
  totalHours: 'Duty hours (billable)',
  durationHours: 'Duty hours (exact)',
  permitted: 'Permitted km / hours',
  extraKm: 'Extra km',
  extraHours: 'Extra hours',
  nightCount: 'Nights',
  toll: 'Toll',
  parking: 'Parking',
  tollParking: 'Toll + parking',
  taxable: 'Taxable amount',
  nonTaxable: 'Non-taxable amount',
  dutyTotal: 'Duty total',
  remarks: 'Remarks',
};
export const BLOCK_COLUMN_KEYS: Record<string, string> = {
  sno: 'Serial number (on the duty heading row)', dutyDate: 'Duty date (heading row)', vehicleRegNo: 'Vehicle number (heading row)', description: 'Description (heading, package, running, charges)',
  unit: 'Quantity / unit', rate: 'Rate', amount: 'Amount', taxable: 'Taxable amount', nonTaxable: 'Non-taxable amount',
};
export const LINE_COLUMN_KEYS: Record<string, string> = {
  sno: 'Serial number', dutyDate: 'Duty date', vehicleRegNo: 'Vehicle number', label: 'Description', quantity: 'Quantity', unit: 'Unit', rate: 'Rate', amount: 'Amount', taxCategory: 'Taxable / non-taxable',
};

export interface RenderDuty extends DutyInput {
  driverName?: string | null;
  fieldOfficer?: string | null;
  remarks?: string | null;
  /** Vehicle type as written on the duty slip, e.g. "Innova" */
  vehicleModel?: string | null;
}

export interface BillContext {
  bill: { billNo: string; billDate: string; periodStart: string; periodEnd: string; revisionNo: number };
  client: { name: string; billing_address: string; gstin: string | null; pan: string | null; state_name: string | null; state_code: string | null; header_title?: string | null; header_subtitle?: string | null; gst_mode?: string | null; duty_fields?: string[] | null };
  supplier: { name: string; address: string; gstin: string | null; pan: string | null; state_name: string | null; state_code: string | null; phone: string | null; email: string | null; bank_details: string | null } | null;
  contract: { title: string; reference_no: string; po_number: string | null; sac_code?: string | null; arithmetic?: string | null };
  duties: RenderDuty[];
  output: BillCalcOutput;
  /** LR exact arithmetic only: how tax is presented (add / show_separate / rcm_note). */
  presentation?: 'add' | 'show_separate' | 'rcm_note';
}

export type Cell = { v: string; raw: string; fmt: Column['format']; align: 'left' | 'center' | 'right' };
export type BoxLine = { text: string; bold?: boolean; size?: number };
export interface RenderModel {
  title: string;
  letterhead: Layout['letterhead'];
  /** Letterhead box content when letterhead is 'box'. */
  box: { left: BoxLine[]; right: string[] } | null;
  totalsInTable: boolean;
  brandLabel: string;
  supplierBlock: string[];
  clientBlock: string[];
  headerFields: { label: string; value: string }[];
  columns: Column[];
  rows: { cells: Cell[]; kind: 'data' | 'subtotal' | 'total' }[];
  /** `key` says what the row is (taxableValue, tax, nonTaxableTotal, grandTotal…); `taxRate` is the percentage of a tax row. */
  summary: { label: string; value: string; strong?: boolean; column?: 'amount' | 'nonTaxable'; key?: string; taxRate?: string }[];
  /** True when the bill uses the LR exact arithmetic, so spreadsheet formulas reproduce its numbers. */
  exact: boolean;
  presentation: 'add' | 'show_separate' | 'rcm_note';
  amountInWords: string | null;
  notes: string[];
  declaration: string;
  signatures: string[];
  grandTotal: string;
  dataRowCount: number;
  page: Layout['page'];
  numberStyle: Layout['numberStyle'];
}

// --- formatting ---------------------------------------------------------------

/** Indian digit grouping: 12,34,567.89 */
export function inr(v: string | Dec): string {
  const d = typeof v === 'string' ? dec(v) : v;
  const neg = d.isNeg();
  const [i, f] = d.abs().toFixed(2).split('.');
  const last3 = i.slice(-3);
  const rest = i.slice(0, -3).replace(/\B(?=(\d{2})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${rest ? rest + ',' : ''}${last3}.${f}`;
}

export function fmtDate(iso: string | null | undefined, style: Layout['dateFormat'] = 'dd-mm-yyyy'): string {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  const sep = style === 'dd.mm.yyyy' || style === 'dd.mm.yy' ? '.' : style === 'dd/mm/yyyy' ? '/' : '-';
  return `${d}${sep}${m}${sep}${style === 'dd.mm.yy' ? y.slice(-2) : y}`;
}

interface Fmt { date: (s: string) => string; money: (s: string) => string }
const fmtFor = (l: Pick<Layout, 'dateFormat' | 'numberStyle'>): Fmt => ({
  date: (s) => fmtDate(s, l.dateFormat),
  money: (s) => (l.numberStyle === 'plain' ? dec(s).toFixed(2) : inr(s)),
});
const DEFAULT_FMT = fmtFor({ dateFormat: 'dd-mm-yyyy', numberStyle: 'indian' });
/** 80.0 → "80", 11.50 → "11.5" */
const plainNum = (s: string | undefined) => (s && /^-?\d+(\.\d+)?$/.test(s) ? dec(s).toString() : s ?? '');

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
function twoDigits(n: number): string {
  return n < 20 ? ONES[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ' ' + ONES[n % 10] : ''}`;
}
function threeDigits(n: number): string {
  const h = Math.floor(n / 100);
  const r = n % 100;
  return [h ? `${ONES[h]} Hundred` : '', r ? twoDigits(r) : ''].filter(Boolean).join(' ');
}
function intWords(n: bigint): string {
  if (n === 0n) return 'Zero';
  const parts: string[] = [];
  const crore = n / 10000000n;
  let rem = n % 10000000n;
  if (crore > 0n) parts.push(`${intWords(crore)} Crore`);
  const lakh = Number(rem / 100000n); rem %= 100000n;
  const thousand = Number(rem / 1000n); rem %= 1000n;
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rem) parts.push(threeDigits(Number(rem)));
  return parts.join(' ');
}
/** Indian-system amount in words, e.g. "Rupees Four Thousand Four Hundred Eleven and Fifty Paise Only". */
export function amountInWords(v: string): string {
  const d = dec(v);
  const [i, f] = d.abs().toFixed(2).split('.');
  const paise = Number(f);
  return `${d.isNeg() ? 'Minus ' : ''}Rupees ${intWords(BigInt(i))}${paise ? ` and ${twoDigits(paise)} Paise` : ''} Only`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

export function placeholders(ctx: BillContext, fmt: Fmt = DEFAULT_FMT): Record<string, string> {
  const t = ctx.output.totals;
  const [y, m] = ctx.bill.periodStart.split('-');
  const inr = fmt.money;
  const p: Record<string, string> = {
    billNo: ctx.bill.billNo + (ctx.bill.revisionNo ? ` (Rev. ${ctx.bill.revisionNo})` : ''),
    billDate: fmt.date(ctx.bill.billDate),
    periodStart: fmt.date(ctx.bill.periodStart),
    periodEnd: fmt.date(ctx.bill.periodEnd),
    monthName: MONTHS[Number(m) - 1],
    year: y,
    clientName: ctx.client.name,
    clientAddress: ctx.client.billing_address,
    clientGstin: ctx.client.gstin ?? '',
    clientPan: ctx.client.pan ?? '',
    clientState: ctx.client.state_name ?? '',
    clientStateCode: ctx.client.state_code ?? '',
    supplierName: ctx.supplier?.name ?? '',
    supplierAddress: ctx.supplier?.address ?? '',
    supplierGstin: ctx.supplier?.gstin ?? '',
    supplierPan: ctx.supplier?.pan ?? '',
    supplierState: ctx.supplier?.state_name ?? '',
    supplierStateCode: ctx.supplier?.state_code ?? '',
    supplierPhone: ctx.supplier?.phone ?? '',
    supplierEmail: ctx.supplier?.email ?? '',
    bankDetails: ctx.supplier?.bank_details ?? '',
    contractRef: ctx.contract.reference_no,
    contractTitle: ctx.contract.title,
    poNumber: ctx.contract.po_number ?? '',
    sac: ctx.contract.sac_code ?? '',
    dutyCount: String(ctx.duties.length),
    taxableValue: inr(t.taxableValue),
    nonTaxableTotal: inr(t.nonTaxableTotal),
    taxTotal: inr(t.taxTotal),
    roundOff: inr(t.roundOff),
    grandTotal: inr(t.grandTotal),
    amountInWords: amountInWords(t.grandTotal),
  };
  for (const tl of ctx.output.taxLines) p[`tax_${tl.taxType}`] = inr(tl.amount);
  return p;
}

/** Address lines often repeat the department name; drop it when it is the leading part. */
function stripLeading(address: string, name: string): string {
  const a = address.trim();
  return a.toLowerCase().startsWith(name.toLowerCase()) ? a.slice(name.length).replace(/^[\s,]+/, '') : a;
}

export function fill(tpl: string, p: Record<string, string>): string {
  return tpl.replace(/\{(\w+)\}/g, (m, k) => (k in p ? p[k] : m));
}

function cellFor(col: Column, v: string | null | undefined, fmt: Fmt = DEFAULT_FMT): Cell {
  const raw = v ?? '';
  let out = raw;
  const isNum = /^-?\d+(\.\d+)?$/.test(raw);
  if (raw !== '') {
    if (col.format === 'money' && isNum) out = fmt.money(raw);
    else if (col.format === 'date') out = fmt.date(raw);
    else if (col.format === 'datetime') out = `${fmt.date(raw.slice(0, 10))} ${raw.slice(11, 16)}`;
    else if (col.format === 'time') out = raw.length > 5 ? raw.slice(11, 16) : raw;
    else if ((col.format === 'hours' || col.format === 'km' || col.format === 'number') && isNum) out = dec(raw).toDecimalPlaces(2).toString();
  }
  const numeric = ['money', 'number', 'km', 'hours'].includes(col.format);
  return { v: out, raw, fmt: col.format, align: col.align ?? (numeric ? 'right' : col.format === 'text' ? 'left' : 'center') };
}

function dutyValue(key: string, d: RenderDuty, vars: Record<string, string>, lines: CalcLine[], sno: number): string | null {
  const sumLines = (pred: (l: CalcLine) => boolean) => {
    const xs = lines.filter(pred);
    return xs.length ? xs.reduce((a, l) => a.add(dec(l.amount)), new D(0)).toFixed(2) : null;
  };
  if (key.startsWith('comp:')) {
    const [, code, what = 'amount'] = key.split(':');
    const l = lines.filter((x) => x.componentCode === code);
    if (!l.length) return null;
    if (what === 'qty') return l.reduce((a, x) => a.add(dec(x.quantity)), new D(0)).toString();
    if (what === 'rate') return l[0].rate;
    return sumLines((x) => x.componentCode === code);
  }
  if (key.startsWith('var:')) return vars[key.slice(4)] ?? null;
  switch (key) {
    case 'sno': return String(sno);
    case 'dutyDate': return d.dutyDate;
    case 'vehicleRegNo': return d.vehicleRegNo;
    case 'vehicleCategory': return d.vehicleCategoryName ?? '';
    case 'driverName': return d.driverName ?? '';
    case 'fieldOfficer': return d.fieldOfficer ?? '';
    case 'dutyType': return d.dutyTypeCode ?? '';
    case 'startKm': return d.startKm;
    case 'endKm': return d.endKm;
    case 'totalKm': return vars.billable_km ?? null;
    case 'startTime': return d.startAt?.slice(11, 16) ?? '';
    case 'endTime': return d.endAt?.slice(11, 16) ?? '';
    case 'startDateTime': return d.startAt;
    case 'endDateTime': return d.endAt;
    case 'totalHours': return vars.billable_hours ?? null;
    case 'durationHours': return vars.duration_hours ?? null;
    case 'permitted': return vars.included_km ? `${vars.included_km} km / ${vars.included_hours} hrs` : '';
    case 'extraKm': return vars.extra_km ?? null;
    case 'extraHours': return vars.extra_hours ?? null;
    case 'nightCount': return vars.night_count ?? null;
    case 'toll': return d.toll;
    case 'parking': return d.parking;
    case 'tollParking': return sumLines((l) => l.kind === 'reimbursement');
    case 'taxable': return sumLines((l) => l.taxCategory === 'taxable');
    case 'nonTaxable': return sumLines((l) => l.taxCategory === 'non_taxable');
    case 'dutyTotal': return sumLines(() => true) ?? '0.00';
    case 'remarks': return d.remarks ?? '';
  }
  return null;
}

export function buildRenderModel(ctx: BillContext, layoutRaw: unknown): RenderModel {
  const layout = LayoutSchema.parse(layoutRaw);
  const fmt = fmtFor(layout);
  const inr = fmt.money;
  const p = placeholders(ctx, fmt);
  p.periodLabel = fill(layout.periodLabel, p);
  const out = ctx.output;
  const varsById = new Map(out.duties.map((d) => [d.dutyId, d.variables]));
  const linesByDuty = new Map<string, CalcLine[]>();
  for (const l of out.lines) if (l.dutyId) linesByDuty.set(l.dutyId, [...(linesByDuty.get(l.dutyId) ?? []), l]);

  const duties = [...ctx.duties].filter((d) => out.duties.some((r) => r.dutyId === d.id && r.ok)).sort((a, b) =>
    layout.sortBy === 'vehicle'
      ? a.vehicleRegNo.localeCompare(b.vehicleRegNo) || a.dutyDate.localeCompare(b.dutyDate) || (a.startAt ?? '').localeCompare(b.startAt ?? '')
      : a.dutyDate.localeCompare(b.dutyDate) || (a.startAt ?? '').localeCompare(b.startAt ?? '') || a.vehicleRegNo.localeCompare(b.vehicleRegNo),
  );

  const rows: RenderModel['rows'] = [];
  const totals = layout.columns.map(() => new D(0));
  const group = layout.columns.map(() => new D(0));
  let groupKey: string | null = null;
  const flushGroup = (label: string) => {
    if (layout.groupBy === 'none' || groupKey === null) return;
    rows.push({
      kind: 'subtotal',
      cells: layout.columns.map((c, i) => (i === 0 ? { v: `Subtotal ${label}`, raw: '', fmt: 'text', align: 'left' } : c.total ? cellFor(c, group[i].toFixed(2), fmt) : { v: '', raw: '', fmt: 'text', align: 'left' })),
    });
    group.forEach((_, i) => (group[i] = new D(0)));
  };
  let sno = 0;
  const addRow = (vals: (string | null)[]) => {
    rows.push({ kind: 'data', cells: layout.columns.map((c, i) => cellFor(c, vals[i], fmt)) });
    layout.columns.forEach((c, i) => {
      if (c.total && vals[i] && /^-?\d+(\.\d+)?$/.test(vals[i]!)) { totals[i] = totals[i].add(dec(vals[i]!)); group[i] = group[i].add(dec(vals[i]!)); }
    });
  };

  if (layout.rowMode === 'block') {
    const b = layout.block;
    const keyed = (vals: Record<string, string | null | undefined>) => addRow(layout.columns.map((c) => vals[c.key] ?? null));
    const amountCols = (l: { taxCategory: string; amount: string }) => ({
      // The LR format lists toll and parking only under Non Taxable.
      amount: b.lrWording && l.taxCategory === 'non_taxable' ? null : l.amount,
      taxable: l.taxCategory === 'taxable' ? l.amount : null,
      nonTaxable: l.taxCategory === 'non_taxable' ? l.amount : null,
    });
    const orderOf = (code: string) => { const i = b.chargeOrder.indexOf(code); return i === -1 ? b.chargeOrder.length : i; };
    for (const d of duties) {
      sno++;
      const vars = varsById.get(d.id) ?? {};
      const lines = linesByDuty.get(d.id) ?? [];
      const reg = d.vehicleRegNo;
      const baseLines = lines.filter((x) => x.componentCode === 'BASE');
      const baseQty = baseLines.length ? dec(baseLines[0].quantity) : new D(1);
      const multiDay = b.lrWording && baseQty.gt(1);
      const fixed = b.lrWording && baseLines.length > 0 && baseLines[0].trace.billingModel === 'fixed_trip';
      const tok: Record<string, string> = {
        ...p,
        vehicleRegNo: reg,
        vehicleShort: b.vehicleShortDigits && reg.length > b.vehicleShortDigits ? reg.slice(-b.vehicleShortDigits) : reg,
        vehicleModel: d.vehicleModel || d.vehicleCategoryName || '',
        vehicleCategory: d.vehicleCategoryName ?? '',
        includedKm: plainNum(vars.included_km),
        includedHours: plainNum(vars.included_hours),
        totalKm: plainNum(vars.billable_km),
        totalHours: plainNum(vars.billable_hours),
        driverName: d.driverName ?? '',
        fieldOfficer: d.fieldOfficer ?? '',
        dutyDate: fmt.date(d.dutyDate),
        days: baseQty.toString(),
        allowedKm: dec(vars.included_km || '0').mul(baseQty).toString(),
      };
      const heading = fill(b.header, tok) + (fixed ? ` - ${baseLines[0].label}` : '');
      // A fixed-price duty is a single row: its charge sits on the heading row.
      keyed({ sno: String(sno), dutyDate: d.dutyDate, vehicleRegNo: reg, description: heading, ...(fixed ? { unit: plainNum(baseLines[0].quantity), rate: plainNum(baseLines[0].rate), ...amountCols(baseLines[0]) } : {}) });
      if (!fixed) {
        for (const l of baseLines) {
          const breakdown = multiDay || (b.lrWording && /outstation/i.test(`${l.trace.schemeName} ${l.label}`))
            ? `  (${plainNum(l.quantity)} Days × ${fmt.money(l.rate)} = ${fmt.money(l.amount)})` : '';
          keyed({ description: fill(b.packageLabel, tok) + breakdown, unit: b.showPackageUnit ? plainNum(l.quantity) : null, rate: plainNum(l.rate), ...amountCols(l) });
        }
        if (b.runningLabel) keyed({ description: fill(multiDay ? b.multiDayRunningLabel : b.runningLabel, tok) });
      }
      const others = lines.filter((x) => x.componentCode !== 'BASE' && !(b.mergeReimbursements && x.kind === 'reimbursement'));
      const ordered = b.chargeOrder.length ? others.map((l, i) => ({ l, i })).sort((x, y) => orderOf(x.l.componentCode) - orderOf(y.l.componentCode) || x.i - y.i).map((x) => x.l) : others;
      for (const l of ordered) {
        keyed({ description: b.componentLabels[l.componentCode] ?? l.label, unit: plainNum(l.quantity), rate: plainNum(l.rate), ...amountCols(l) });
      }
      const reimb = lines.filter((x) => b.mergeReimbursements && x.kind === 'reimbursement');
      if (reimb.length) {
        const sum = reimb.reduce((a, l) => a.add(dec(l.amount)), new D(0)).toFixed(2);
        keyed({ description: b.reimbursementLabel, ...amountCols({ taxCategory: reimb[0].taxCategory, amount: sum }) });
      }
      if (b.blankRowBetween) keyed({});
    }
    for (const l of out.lines.filter((x) => x.scope !== 'duty')) {
      sno++;
      keyed({ sno: String(sno), description: `${l.label}${l.vehicleRegNo ? ` (${l.vehicleRegNo})` : ''}`, unit: plainNum(l.quantity), rate: plainNum(l.rate), ...amountCols(l) });
    }
  } else if (layout.rowMode === 'duty') {
    for (const d of duties) {
      const gk = layout.groupBy === 'vehicle' ? d.vehicleRegNo : layout.groupBy === 'date' ? d.dutyDate : null;
      if (gk !== groupKey) { flushGroup(groupKey ?? ''); groupKey = gk; }
      sno++;
      addRow(layout.columns.map((c) => dutyValue(c.key, d, varsById.get(d.id) ?? {}, linesByDuty.get(d.id) ?? [], sno)));
    }
    flushGroup(groupKey ?? '');
    // Period/bill-scope lines (monthly hire, minimum guarantee) appear as their own rows.
    for (const l of out.lines.filter((x) => x.scope !== 'duty')) {
      sno++;
      addRow(layout.columns.map((c) => {
        if (c.key === 'sno') return String(sno);
        if (c.key === 'vehicleRegNo') return l.vehicleRegNo ?? '';
        if (['dutyTotal', 'taxable', 'nonTaxable'].includes(c.key)) {
          if (c.key === 'taxable' && l.taxCategory !== 'taxable') return null;
          if (c.key === 'nonTaxable' && l.taxCategory !== 'non_taxable') return null;
          return l.amount;
        }
        if (c.key.startsWith('comp:') && c.key.split(':')[1] === l.componentCode) return c.key.endsWith(':qty') ? l.quantity : c.key.endsWith(':rate') ? l.rate : l.amount;
        if (c.key === 'remarks' || c.key === 'vehicleCategory') return `${l.label} (${l.quantity}${l.unit ? ' ' + l.unit : ''} × ${l.rate})`;
        return null;
      }));
    }
  } else {
    const dutyById = new Map(ctx.duties.map((d) => [d.id, d]));
    for (const l of out.lines) {
      const d = l.dutyId ? dutyById.get(l.dutyId) : undefined;
      sno++;
      addRow(layout.columns.map((c) => {
        switch (c.key) {
          case 'sno': return String(sno);
          case 'dutyDate': return d?.dutyDate ?? '';
          case 'vehicleRegNo': return l.vehicleRegNo ?? '';
          case 'label': return l.label;
          case 'quantity': return l.quantity;
          case 'unit': return l.unit;
          case 'rate': return l.rate;
          case 'amount': return l.amount;
          case 'taxCategory': return l.taxCategory === 'taxable' ? 'Taxable' : 'Non-taxable';
        }
        return d ? dutyValue(c.key, d, varsById.get(d.id) ?? {}, [l], sno) : null;
      }));
    }
  }
  const dataRowCount = rows.filter((r) => r.kind === 'data').length;
  if (layout.columns.some((c) => c.total)) {
    rows.push({ kind: 'total', cells: layout.columns.map((c, i) => (i === 0 ? { v: 'TOTAL', raw: '', fmt: 'text', align: 'left' } : c.total ? cellFor(c, totals[i].toFixed(2), fmt) : { v: '', raw: '', fmt: 'text', align: 'left' })) });
  }

  const t = out.totals as unknown as Record<string, string>;
  const summary: RenderModel['summary'] = [];
  // Reverse charge: no tax rows, the taxable value and the reimbursements are one non-taxable amount.
  const rcmNote = layout.totalsInTable && ctx.presentation === 'rcm_note';
  if (rcmNote) {
    summary.push({ label: 'Amount (Non Taxable)', value: inr(dec(t.taxableValue).add(dec(t.nonTaxableTotal)).toFixed(2)), key: 'rcmAmount' });
    summary.push({ label: 'GST Under RCM(Invoice)', value: '', key: 'rcmNote' });
    summary.push({ label: 'Total Amount', value: inr(t.grandTotal), strong: true, key: 'grandTotal' });
  }
  for (const s of rcmNote ? [] : layout.summary) {
    if (s.value === 'taxLines') {
      for (const tl of out.taxLines) summary.push({ label: fill(layout.taxLabel, { name: tl.name, taxType: tl.taxType, rate: plainNum(tl.rate), base: inr(tl.taxableBase) }), value: inr(tl.amount), key: 'tax', taxRate: plainNum(tl.rate) });
    } else if (s.value.startsWith('tax:')) {
      const tl = out.taxLines.find((x) => x.taxType === s.value.slice(4));
      if (tl) summary.push({ label: fill(s.label, { ...p, rate: tl.rate }), value: inr(tl.amount) });
    } else if (s.value in t) {
      if (s.value === 'roundOff' && dec(t.roundOff).isZero()) continue;
      summary.push({ label: fill(s.label, p), value: inr(t[s.value]), strong: s.value === 'grandTotal', key: s.value, ...(s.column ? { column: s.column } : {}) });
    } else {
      summary.push({ label: fill(s.label, p), value: fill(s.value, p) });
    }
  }

  const sup = ctx.supplier;
  const joinLabel = (l: string) => (/[:\-.]\s*$/.test(l) ? `${l} ` : `${l}: `);
  const headerFields = layout.headerFields.map((h) => ({ label: h.label, value: fill(h.value, p) }));
  let box: RenderModel['box'] = null;
  if (layout.letterhead === 'box') {
    const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
    const custom = (ctx.client.duty_fields ?? []).flatMap((label) => {
      const vals = [...new Set(ctx.duties.map((d) => String((d.customFields ?? {})[slug(label)] ?? '').trim()).filter(Boolean))];
      return vals.length ? [`${label}: ${vals.join(', ')}`] : [];
    });
    box = {
      left: [
        { text: ctx.client.header_title || sup?.name || '', bold: true, size: 11 },
        { text: ctx.client.name, bold: true, size: 14 },
        ...(ctx.client.header_subtitle ? [{ text: ctx.client.header_subtitle, size: 9 }] : []),
        ...stripLeading(ctx.client.billing_address, ctx.client.name).split(/\r?\n/).map((x) => x.trim()).filter(Boolean).map((text) => ({ text, size: 9 })),
        ...(ctx.client.gstin ? [{ text: `CLIENT GSTIN - ${ctx.client.gstin}`, size: 9 }] : []),
        ...custom.map((text) => ({ text, bold: true, size: 9 })),
      ],
      right: headerFields.map((h) => `${joinLabel(h.label)}${h.value}`),
    };
  }
  return {
    title: fill(layout.title, p),
    letterhead: layout.letterhead,
    box,
    totalsInTable: layout.totalsInTable,
    brandLabel: layout.brandLabel,
    exact: ctx.contract.arithmetic === 'lr_exact',
    presentation: ctx.presentation ?? 'add',
    supplierBlock: layout.showSupplier && sup ? [sup.name, sup.address, sup.gstin ? `GSTIN: ${sup.gstin}` : '', sup.pan ? `PAN: ${sup.pan}` : '', sup.state_name ? `State: ${sup.state_name}${sup.state_code ? ` (${sup.state_code})` : ''}` : '', [sup.phone, sup.email].filter(Boolean).join(' · ')].filter(Boolean) : [],
    clientBlock: !layout.showClient ? [] : layout.clientBlockStyle === 'name_address_gstin'
      ? [ctx.client.name, stripLeading(ctx.client.billing_address, ctx.client.name), ctx.client.gstin ? `Client GSTIN: ${ctx.client.gstin}` : ''].filter(Boolean)
      : ['Bill to:', ctx.client.name, ctx.client.billing_address, ctx.client.gstin ? `GSTIN: ${ctx.client.gstin}` : '', ctx.client.state_name ? `State: ${ctx.client.state_name}${ctx.client.state_code ? ` (${ctx.client.state_code})` : ''}` : ''].filter(Boolean),
    headerFields,
    columns: layout.columns,
    rows,
    summary,
    amountInWords: layout.amountInWords ? amountInWords(out.totals.grandTotal) : null,
    notes: layout.notes.map((n) => fill(n, p)),
    declaration: fill(layout.declaration, p),
    signatures: layout.signatures.map((s) => fill(s, p)),
    grandTotal: out.totals.grandTotal,
    dataRowCount,
    page: layout.page,
    numberStyle: layout.numberStyle,
  };
}

/** A starting layout modelled on a typical daily-package duty bill. Users adapt it per department. */
export function defaultDutyLayout(): Layout {
  return LayoutSchema.parse({
    title: 'TAX INVOICE',
    columns: [
      { key: 'sno', label: 'S.No.', width: 0.5, format: 'text', align: 'center' },
      { key: 'dutyDate', label: 'Date', width: 1.1, format: 'date' },
      { key: 'vehicleCategory', label: 'Vehicle', width: 1.2 },
      { key: 'vehicleRegNo', label: 'Vehicle No.', width: 1.2 },
      { key: 'comp:BASE:amount', label: 'Base Charges', width: 1, format: 'money', total: true },
      { key: 'permitted', label: 'Permitted Km/Hrs', width: 1.2 },
      { key: 'totalKm', label: 'Total Km', width: 0.8, format: 'km', group: 'Usage' },
      { key: 'totalHours', label: 'Total Hrs', width: 0.8, format: 'hours', group: 'Usage' },
      { key: 'extraKm', label: 'Extra Km', width: 0.8, format: 'km', group: 'Extra Km' },
      { key: 'comp:EXKM:amount', label: 'Amount', width: 0.9, format: 'money', total: true, group: 'Extra Km' },
      { key: 'extraHours', label: 'Extra Hrs', width: 0.8, format: 'hours', group: 'Extra Hours' },
      { key: 'comp:EXHR:amount', label: 'Amount', width: 0.9, format: 'money', total: true, group: 'Extra Hours' },
      { key: 'comp:NIGHT:amount', label: 'Night', width: 0.8, format: 'money', total: true },
      { key: 'tollParking', label: 'Toll / Parking', width: 0.9, format: 'money', total: true },
      { key: 'taxable', label: 'Taxable', width: 1, format: 'money', total: true },
      { key: 'nonTaxable', label: 'Non-taxable', width: 1, format: 'money', total: true },
      { key: 'dutyTotal', label: 'Total', width: 1, format: 'money', total: true },
    ],
    notes: ['Duty slips signed by the user officer are enclosed.'],
    declaration: 'Certified that the particulars given above are true and correct and the amount indicated is the actual amount charged.',
    signatures: ['For {supplierName}', 'Authorised Signatory'],
  });
}

/**
 * The LR Taxi Services "merged invoice" format used on the other billing app: a bordered letterhead,
 * a duty block per trip (Duty for / Upto / Total running / extra charges) and the totals as rows of the
 * same table, ending in the brand total. Pair it with the contract's "LR exact" printed arithmetic.
 */
export function lrStandardLayout(): Layout {
  return LayoutSchema.parse({
    title: '',
    page: { size: 'A4', orientation: 'landscape', margins: [28, 28, 28, 36], fontSize: 9 },
    letterhead: 'box',
    totalsInTable: true,
    brandLabel: 'L.R TAXI SERVICES',
    showSupplier: false,
    showClient: false,
    headerFields: [
      { label: 'SAC :-', value: '{sac}' },
      { label: 'PAN NO :-', value: '{supplierPan}' },
      { label: 'GSTIN :', value: '{supplierGstin}' },
      { label: 'BILL NO :', value: '{billNo}' },
      { label: 'DATE :', value: '{billDate}' },
    ],
    rowMode: 'block',
    block: {
      header: 'Duty for ( {vehicleModel} )',
      packageLabel: 'Upto : {includedKm} kms/{includedHours} hrs duty',
      runningLabel: 'Total running : ({totalKm} kms/{totalHours} hrs)',
      componentLabels: { EXHR: 'Extra Hrs:', EXKM: 'Extra Kms:', NIGHT: 'Night Charges', DRIVER: 'Driver Allowance' },
      chargeOrder: ['EXHR', 'EXKM', 'NIGHT', 'DRIVER'],
      mergeReimbursements: true,
      reimbursementLabel: 'Toll Tax & Parking',
      vehicleShortDigits: 0,
      blankRowBetween: false,
      showPackageUnit: true,
      lrWording: true,
    },
    dateFormat: 'dd.mm.yy',
    numberStyle: 'indian',
    taxLabel: '{taxType} {rate}%',
    columns: [
      { key: 'sno', label: 'S. NO', width: 38, format: 'text', align: 'center' },
      { key: 'dutyDate', label: 'DATE', width: 62, format: 'date', align: 'center' },
      { key: 'vehicleRegNo', label: 'Car No', width: 60, format: 'text', align: 'center' },
      { key: 'description', label: 'DESCRIPTION', width: 240, format: 'text', align: 'left' },
      { key: 'unit', label: 'UNIT', width: 55, format: 'number', align: 'center' },
      { key: 'rate', label: 'RATE', width: 70, format: 'money', align: 'right' },
      { key: 'nonTaxable', label: 'Non Taxable', width: 85, format: 'money', align: 'right' },
      { key: 'amount', label: 'Amount', width: 95, format: 'money', align: 'right' },
    ],
    summary: [
      { label: 'Taxable Amount', value: 'taxableValue' },
      { label: '{tax}', value: 'taxLines' },
      { label: 'Toll Tax & Parking', value: 'nonTaxableTotal', column: 'nonTaxable' },
      { label: 'Total Amount', value: 'grandTotal' },
    ],
    amountInWords: false,
    notes: [],
    declaration: '',
    signatures: [],
  });
}
