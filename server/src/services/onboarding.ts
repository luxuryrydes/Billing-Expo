/**
 * Builds a "set up this department" proposal from uploaded documents and, once a
 * person has reviewed and edited it, creates the department, contract, supplier
 * profile, vehicle categories, DRAFT rate schemes, DRAFT tax rules and a DRAFT
 * bill template. Nothing created here can bill until it is approved through the
 * normal approval screens.
 */
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/http.js';
import { RateConfigSchema } from '../engine/types.js';
import { dec } from '../engine/decimal.js';
import { addDays } from '../engine/time.js';
import { defaultDutyLayout, LayoutSchema, type Layout } from './render.js';
import { GST_STATES, profileDocument, type DocProfile, type RateRow, type Sourced } from './profile.js';

export interface PField { value: string; source?: Sourced; alternatives?: Sourced[]; note?: string; confirm?: boolean }

export interface Proposal {
  documents: { versionId: string; documentId: string; title: string; kind: string }[];
  client: Record<string, PField>;
  clientAliases: string[];
  contract: Record<string, PField>;
  supplier: Record<string, PField>;
  supplierGstinOptions: Sourced[];
  categories: { name: string; description: string; aliases: string[]; source?: Sourced }[];
  rates: RateRow[];
  rateOptions: {
    hourRoundingMode: 'exact' | 'ceil' | 'floor' | 'nearest';
    hourRoundingUnit: string;
    nightEnabled: boolean;
    nightStart: string;
    nightEnd: string;
    createOutstation: boolean;
    notes: string[];
  };
  taxes: { tax_type: string; rate: string; source_ref: string; note: string }[];
  template: { layout: Layout; notes: string[] } | null;
  billSeries: { format: string; nextNumber: number | null; sample: string | null } | null;
  dutySheet: { headers: string[]; departments: Record<string, number>; rows: number; title: string } | null;
  sampleBill: { title: string; dutyCount: number; taxableTotal: string | null; nonTaxableTotal: string | null; grandTotal: string | null } | null;
  questions: string[];
}

const MONTHS: Record<string, string> = { jan: '01', feb: '02', mar: '03', apr: '04', may: '05', jun: '06', jul: '07', aug: '08', sep: '09', oct: '10', nov: '11', dec: '12' };

/** 06-Nov-2025, 23.10.2026, 2025-11-06 → ISO date, or '' if unreadable. */
export function isoDate(s: string | undefined): string {
  if (!s) return '';
  let m = /(\d{1,2})[-\s]([A-Za-z]{3})[A-Za-z]*[-\s,]+(\d{4})/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) return `${m[3]}-${MONTHS[m[2].toLowerCase()]}-${m[1].padStart(2, '0')}`;
  m = /(\d{1,2})[./-](\d{1,2})[./-](\d{4})/.exec(s);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  m = /(\d{4})-(\d{2})-(\d{2})/.exec(s);
  return m ? m[0] : '';
}

export function initials(name: string): string {
  const stop = new Set(['of', 'and', 'the', 'for', 'to', 'in', '&']);
  const w = name.replace(/\(.*?\)/g, ' ').split(/[\s,.-]+/).filter((x) => x && !stop.has(x.toLowerCase()));
  return w.map((x) => x[0]).join('').toUpperCase().slice(0, 10);
}

/** "LRTH/26-27/0767" → { format: "LRTH/{FYS}/{SEQ:4}", next: 768 } */
export function billNumberPattern(sample: string): { format: string; next: number | null } {
  let f = sample.replace(/\b(\d{2})-(\d{2})\b/, (x, a, b) => (Number(b) === (Number(a) + 1) % 100 ? '{FYS}' : x)).replace(/\b(20\d{2})-(\d{2})\b/, '{FY}');
  const m = /(\d+)(?!.*\d)/.exec(f);
  let next: number | null = null;
  if (m && !/\{FYS\}|\{FY\}/.test(m[0])) {
    next = Number(m[1]) + 1;
    f = f.slice(0, m.index) + `{SEQ:${m[1].length}}` + f.slice(m.index + m[1].length);
  }
  return { format: f, next };
}

const pf = (s: Sourced | undefined, note?: string, confirm?: boolean): PField => ({ value: s?.value ?? '', source: s, note, confirm });

export function blockLayout(bill: NonNullable<DocProfile['bill']>, supplierName: string): Layout {
  const has = (re: RegExp) => bill.columns.some((c) => re.test(c));
  const columns = [
    { key: 'sno', label: bill.columns.find((c) => /s\.?\s*no|sl/i.test(c)) ?? 'S. NO', width: 0.6, format: 'text' as const, align: 'center' as const },
    { key: 'dutyDate', label: bill.columns.find((c) => /date/i.test(c)) ?? 'DATE', width: 1.1, format: 'date' as const, align: 'center' as const },
    { key: 'description', label: bill.columns.find((c) => /desc|particular/i.test(c)) ?? 'DESCRIPTION', width: 4, format: 'text' as const },
    { key: 'unit', label: bill.columns.find((c) => /unit|qty|quantity/i.test(c)) ?? 'UNIT', width: 0.8, format: 'number' as const },
    { key: 'rate', label: bill.columns.find((c) => /^rate/i.test(c)) ?? 'RATE', width: 0.9, format: 'number' as const },
    ...(has(/non\s*taxable/i) ? [{ key: 'nonTaxable', label: bill.columns.find((c) => /non\s*taxable/i.test(c))!, width: 1.1, format: 'money' as const }] : []),
    { key: has(/^taxable/i) ? 'taxable' : 'amount', label: bill.columns.find((c) => /^taxable|amount/i.test(c)) ?? 'AMOUNT', width: 1.1, format: 'money' as const },
  ];
  const tax = bill.taxes[0];
  const comp = (re: RegExp, fallback: string) => bill.blockPatterns.components.find((c) => re.test(c)) ?? fallback;
  return LayoutSchema.parse({
    page: { size: 'A4', orientation: 'portrait', margins: [28, 28, 28, 36], fontSize: 8 },
    title: bill.heading?.value ?? 'TAX INVOICE',
    showSupplier: false,
    showClient: true,
    clientBlockStyle: 'name_address_gstin',
    headerFields: [
      ...(bill.sac ? [{ label: 'SAC:-', value: '{sac}' }] : []),
      ...(bill.supplierPan ? [{ label: 'PAN No.-', value: '{supplierPan}' }] : []),
      ...(bill.supplierGstin ? [{ label: 'GSTIN-', value: '{supplierGstin}' }] : []),
      { label: 'BILL NO :', value: '{billNo}' },
      { label: 'DATE :', value: '{billDate}' },
    ],
    periodLabel: '{periodStart} to {periodEnd}',
    rowMode: 'block',
    dateFormat: (bill.dateFormat as Layout['dateFormat']) ?? 'dd-mm-yyyy',
    numberStyle: bill.plainNumbers ? 'plain' : 'indian',
    block: {
      header: bill.blockPatterns.header ? bill.blockPatterns.header.replace(/\(\s*\S+\s+\S+\s*\)/, '({vehicleShort} {vehicleModel} )') : 'Duty for ({vehicleShort} {vehicleModel} )',
      packageLabel: bill.blockPatterns.package ? bill.blockPatterns.package.replace(/\d+\s*kms?/i, '{includedKm} kms').replace(/\d+(\.\d+)?\s*hrs?/i, '{includedHours} hrs') : 'Upto : {includedKm} kms./{includedHours} hrs duty',
      runningLabel: bill.blockPatterns.running ? 'Total running : ( {totalKm} kms./{totalHours} hrs )' : '',
      componentLabels: {
        EXKM: comp(/extra\s*km/i, 'Extra Kms'),
        EXHR: comp(/extra\s*(hr|hour)/i, 'Extra Hrs'),
        NIGHT: comp(/night/i, 'Night Charges'),
        TOLL: comp(/toll|parking/i, 'Toll Tax & Parking'),
      },
      mergeReimbursements: bill.blockPatterns.components.some((c) => /toll.*parking|parking.*toll/i.test(c)),
      reimbursementLabel: comp(/toll|parking/i, 'Toll Tax & Parking'),
      vehicleShortDigits: 4,
      blankRowBetween: true,
      showPackageUnit: false,
    },
    columns,
    summary: [
      { label: 'Taxable Amount', value: 'taxableValue' },
      { label: tax ? `{taxType}-{rate}%` : '{tax}', value: 'taxLines' },
      { label: bill.nonTaxableLabel ?? 'Toll Tax & Parking', value: 'nonTaxableTotal' },
      { label: 'Round off', value: 'roundOff' },
      { label: 'Total Amount :-', value: 'grandTotal' },
    ],
    taxLabel: tax ? '{taxType}-{rate}%' : '{name} @ {rate}% on {base}',
    amountInWords: false,
    notes: [],
    declaration: '',
    signatures: [supplierName ? supplierName.toUpperCase() : '{supplierName}'],
  });
}

export function buildProposal(docs: { versionId: string; documentId: string; title: string; pages: { page: number; text: string; tables: string[][][] }[] }[]): Proposal {
  const profiles = docs.map((d) => ({ d, p: profileDocument(d.pages, d.title) }));
  const F: Record<string, Sourced[]> = {};
  const gstins: Sourced[] = [];
  let rates: RateRow[] = [];
  let bill: DocProfile['bill'] | undefined;
  let billDoc = '';
  let duty: Proposal['dutySheet'] = null;
  for (const { d, p } of profiles) {
    for (const [k, v] of Object.entries(p.fields)) (F[k] ??= []).push(v);
    gstins.push(...p.supplierGstins);
    if (p.rates.length && !rates.length) rates = p.rates;
    if (p.bill && !bill) { bill = p.bill; billDoc = d.title; }
    if (p.dutySheet && !duty) duty = { ...p.dutySheet, title: d.title };
  }
  const first = (k: string) => F[k]?.[0];
  const questions: string[] = [];

  // Department: prefer the name printed on the department's own bill, else the office/organisation in the contract.
  const nameCandidates = [bill?.clientName, first('client_office'), first('client_org_name')].filter(Boolean) as Sourced[];
  let name = nameCandidates[0];
  if (name && /,/.test(name.value) && /directorate|department|ministry|office|commission|authority/i.test(name.value)) {
    // "Delhi Zonal Unit, Directorate Of Revenue Intelligence" → keep the organisation part as an alternative
    const part = name.value.split(',').map((x) => x.trim()).find((x) => /directorate|department|ministry|commission|authority/i.test(x));
    if (part && part !== name.value) nameCandidates.push({ ...name, value: part, confidence: 0.6 });
  }
  const clientGstin = first('client_gstin') ?? bill?.clientGstin;
  const gstinAlt = [first('client_gstin'), bill?.clientGstin].filter((x): x is Sourced => !!x && x.value !== clientGstin?.value);
  if (gstinAlt.length) questions.push(`The contract and the sample bill show different department GSTINs (${[clientGstin?.value, ...gstinAlt.map((g) => g.value)].join(' / ')}). Choose the correct one.`);
  const stateCode = clientGstin?.value.slice(0, 2) ?? '';
  const client: Record<string, PField> = {
    name: { ...pf(name), alternatives: nameCandidates.filter((x) => x !== name) },
    short_code: { value: name ? initials(name.value) : '', note: 'Used in bill numbers and to recognise this department on shared duty sheets' },
    billing_address: { ...pf(first('client_address') ?? bill?.clientAddress), alternatives: bill?.clientAddress && first('client_address') ? [bill.clientAddress] : [] },
    gstin: { ...pf(clientGstin), alternatives: gstinAlt },
    state_code: { value: stateCode, note: 'From the first two digits of the GSTIN' },
    state_name: { value: GST_STATES[stateCode] ?? '' },
    contact_email: pf(first('client_email')),
    contact_phone: pf(first('client_phone')),
    contact_name: pf(first('client_contact_designation')),
    special_instructions: { value: [first('client_ministry')?.value, first('client_department')?.value, first('client_org_name')?.value, first('payment_mode') ? `Payment: ${first('payment_mode')!.value}` : ''].filter(Boolean).join(' · ') },
  };
  const shortCode = client.short_code.value;
  const clientAliases = [shortCode];
  if (duty) {
    const deps = Object.keys(duty.departments);
    const hit = deps.find((x) => x.toUpperCase() === shortCode.toUpperCase());
    if (!hit && deps.length) questions.push(`The duty sheet's Department column has ${deps.length} values; none equals "${shortCode}". Set the department code the sheet uses for this department.`);
  }

  // Supplier (LR Taxi Services): GSTIN used on the sample bill decides the invoicing registration.
  const billGstin = bill?.supplierGstin;
  const supplierGstin = billGstin ?? gstins.find((g) => /\(R\)/.test(g.text)) ?? gstins[0];
  const supState = supplierGstin?.value.slice(0, 2) ?? '';
  const supplier: Record<string, PField> = {
    name: pf(first('supplier_name')),
    gstin: { ...pf(supplierGstin, billGstin ? 'GSTIN used on the sample bill' : 'Registered (R) GSTIN from the contract'), alternatives: gstins.filter((g) => g.value !== supplierGstin?.value) },
    pan: pf(bill?.supplierPan ?? (supplierGstin ? { ...supplierGstin, value: supplierGstin.value.slice(2, 12) } : undefined), bill?.supplierPan ? undefined : 'Derived from the GSTIN (characters 3–12)'),
    address: pf(first('supplier_address')),
    email: pf(first('supplier_email')),
    phone: pf(first('supplier_phone')),
    msme: pf(first('supplier_msme')),
    state_code: { value: supState },
    state_name: { value: GST_STATES[supState] ?? '' },
    tagline: pf(bill?.heading, 'Heading printed at the top of the sample bill'),
  };

  // Contract
  const startIso = isoDate(first('service_start')?.value);
  const endIso = isoDate(first('service_end')?.value);
  const cycle = (first('billing_cycle')?.value ?? '').toLowerCase();
  const series = bill?.billNo ? billNumberPattern(bill.billNo.value) : null;
  let rounding = 'none';
  if (bill?.grandTotal && bill.taxableTotal) {
    const pre = dec(bill.taxableTotal.value).add(bill.taxes.reduce((a, t) => a.add(dec(t.amount ?? '0')), dec(0))).add(dec(bill.nonTaxableTotal?.value ?? '0'));
    const gt = dec(bill.grandTotal.value);
    if (!pre.eq(gt) && gt.isInteger()) rounding = pre.sub(gt).abs().lt(1) ? (pre.toDecimalPlaces(0).eq(gt) ? 'nearest_rupee' : pre.floor().eq(gt) ? 'down_rupee' : 'up_rupee') : 'none';
    if (!pre.sub(gt).abs().lt(1)) questions.push(`The sample bill's components add up to ${pre.toFixed(2)} but its total is ${gt.toFixed(2)}. Check the sample bill.`);
  }
  const contract: Record<string, PField> = {
    title: { value: 'Hiring of taxi service on day-to-day basis (rate contract)', note: 'Edit to the contract description you use' },
    reference_no: pf(first('contract_no')),
    bid_no: pf(first('bid_no')),
    po_number: pf(first('contract_no'), 'GeM contract number is usually quoted as the order reference'),
    start_date: { ...pf(first('service_start')), value: startIso },
    end_date: { ...pf(first('service_end')), value: endIso },
    billing_frequency: { ...pf(first('billing_cycle')), value: /month/.test(cycle) ? 'monthly' : /week/.test(cycle) ? 'weekly' : /daily|day/.test(cycle) ? 'daily' : 'monthly' },
    contract_value: pf(first('contract_value')),
    sac_code: pf(bill?.sac),
    tax_mode: { value: rates.some((r) => r.ratesExcludeGst) ? 'exclusive' : 'exclusive', note: rates.some((r) => r.ratesExcludeGst) ? 'Rate schedule says rates are excluding GST' : 'Not stated — confirm', confirm: !rates.some((r) => r.ratesExcludeGst) },
    invoice_rounding: { value: rounding, note: rounding !== 'none' && bill?.grandTotal ? `Sample bill total ${bill.grandTotal.value} is rounded to whole rupees` : undefined },
    bill_no_format: { value: series?.format ?? '{CLIENT}/{FY}/{SEQ}', source: bill?.billNo, note: series ? `From sample bill number ${bill!.billNo!.value}` : undefined },
  };
  if (!startIso) questions.push('Contract start date not found — enter it.');

  // Vehicle categories from the rate table, with aliases from model names and names seen on the sample bill / duty sheet.
  const categories = rates.map((r) => ({ name: r.category, description: r.description, aliases: r.examples, source: r.packages[0]?.rate }));

  // Taxes observed on the sample bill (never assumed).
  const taxes: Proposal['taxes'] = [];
  if (bill?.taxes.length) {
    for (const t of bill.taxes) {
      const arithmetic = t.amount && bill.taxableTotal ? dec(bill.taxableTotal.value).mul(t.rate).div(100).toDecimalPlaces(2).eq(dec(t.amount)) : null;
      taxes.push({
        tax_type: t.type, rate: t.rate,
        source_ref: `Observed on sample bill ${billDoc}: "${t.source.text}"`,
        note: `${arithmetic === true ? `Checks out: ${bill.taxableTotal!.value} × ${t.rate}% = ${t.amount}. ` : ''}${supplierGstin && clientGstin && supplierGstin.value.slice(0, 2) !== clientGstin.value.slice(0, 2) ? `Supplier state ${supState} ≠ department state ${stateCode}: inter-state supply (IGST). ` : ''}Confirm the rate against the contract / GST notification before approving.`,
      });
    }
  } else {
    questions.push('No tax treatment found in the documents. Add the tax rule on the contract before billing.');
  }

  const rateNotes: string[] = [];
  if (rates.length) {
    rateNotes.push('Hour rounding is not stated in the contract. The sample bill shows extra hours in half hours (e.g. 8.5, 11.5), so "round up to 30 minutes" is proposed — confirm.');
    rateNotes.push('The night-charge window is not stated in the documents. Enter the hours that count as a night duty.');
    if (rates.some((r) => r.outstationExtraKm)) rateNotes.push('Outstation extra rates are listed but no separate outstation package rate — the largest local package rate is proposed as the outstation daily rate. Confirm.');
    if (rates.some((r) => r.packages.length > 1)) rateNotes.push(`Several packages per vehicle (${[...new Set(rates.flatMap((r) => r.packages.map((p) => `${p.hours} hrs/${p.km} km`)))].join(', ')}). Each becomes its own duty type; duties choose the package through their duty type.`);
  } else {
    questions.push('No rate table was recognised. Upload the rate schedule, or create rate schemes manually.');
  }

  return {
    documents: docs.map((d, i) => ({ versionId: d.versionId, documentId: d.documentId, title: d.title, kind: profiles[i].p.parts.join(' + ') || 'other' })),
    client, clientAliases, contract, supplier, supplierGstinOptions: gstins,
    categories, rates,
    rateOptions: { hourRoundingMode: 'ceil', hourRoundingUnit: '30', nightEnabled: rates.some((r) => r.nightLocal), nightStart: '22:00', nightEnd: '06:00', createOutstation: rates.some((r) => r.outstationExtraKm || r.outstationExtraHour), notes: rateNotes },
    taxes,
    template: bill && bill.layout === 'block' ? { layout: blockLayout(bill, first('supplier_name')?.value ?? ''), notes: [`Layout learned from ${billDoc}: ${bill.columns.join(' | ')}; one block per duty (${bill.dutyCount} duties on the sample).`] }
      : bill ? { layout: { ...defaultDutyLayout(), title: bill.heading?.value ?? 'TAX INVOICE' }, notes: [`Columns on ${billDoc}: ${bill.columns.join(' | ') || 'not recognised'}. Adjust the columns in the template designer.`] } : null,
    billSeries: series ? { format: series.format, nextNumber: series.next, sample: bill!.billNo!.value } : null,
    dutySheet: duty,
    sampleBill: bill ? { title: billDoc, dutyCount: bill.dutyCount, taxableTotal: bill.taxableTotal?.value ?? null, nonTaxableTotal: bill.nonTaxableTotal?.value ?? null, grandTotal: bill.grandTotal?.value ?? null } : null,
    questions,
  };
}

// --- apply ---------------------------------------------------------------------------

const RateRowSchema = z.object({
  category: z.string().min(1),
  packages: z.array(z.object({ hours: z.string(), km: z.string(), rate: z.object({ value: z.string() }).passthrough() })),
  extraKm: z.object({ value: z.string() }).passthrough().optional(),
  extraHour: z.object({ value: z.string() }).passthrough().optional(),
  outstationExtraKm: z.object({ value: z.string() }).passthrough().optional(),
  outstationExtraHour: z.object({ value: z.string() }).passthrough().optional(),
  nightLocal: z.object({ value: z.string() }).passthrough().optional(),
  nightOutstation: z.object({ value: z.string() }).passthrough().optional(),
}).passthrough();

export const ApplySchema = z.object({
  client: z.object({
    existingId: z.string().uuid().nullable().optional(),
    name: z.string().min(1), short_code: z.string().min(1).max(20), billing_address: z.string().default(''), gstin: z.string().nullable().optional(),
    state_name: z.string().nullable().optional(), state_code: z.string().nullable().optional(), contact_name: z.string().nullable().optional(),
    contact_email: z.string().nullable().optional(), contact_phone: z.string().nullable().optional(), special_instructions: z.string().nullable().optional(),
    aliases: z.array(z.string()).default([]),
  }),
  supplier: z.object({
    name: z.string().min(1), gstin: z.string().nullable().optional(), pan: z.string().nullable().optional(), address: z.string().default(''), email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(), msme: z.string().nullable().optional(), state_name: z.string().nullable().optional(), state_code: z.string().nullable().optional(),
    tagline: z.string().nullable().optional(), bank_details: z.string().nullable().optional(),
  }),
  contract: z.object({
    title: z.string().min(1), reference_no: z.string().min(1), bid_no: z.string().nullable().optional(), po_number: z.string().nullable().optional(),
    start_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), end_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    billing_frequency: z.enum(['monthly', 'fortnightly', 'weekly', 'daily', 'per_trip']).default('monthly'), contract_value: z.string().nullable().optional(),
    sac_code: z.string().nullable().optional(), tax_mode: z.enum(['exclusive', 'inclusive']).default('exclusive'),
    invoice_rounding: z.enum(['none', 'nearest_rupee', 'up_rupee', 'down_rupee']).default('none'), bill_no_format: z.string().min(1), status: z.enum(['draft', 'active']).default('active'),
  }),
  categories: z.array(z.object({ name: z.string().min(1), description: z.string().nullable().optional(), aliases: z.array(z.string()).default([]) })).default([]),
  rates: z.array(RateRowSchema).default([]),
  rateOptions: z.object({
    hourRoundingMode: z.enum(['exact', 'ceil', 'floor', 'nearest']), hourRoundingUnit: z.string(), nightEnabled: z.boolean(), nightStart: z.string().regex(/^\d{2}:\d{2}$/),
    nightEnd: z.string().regex(/^\d{2}:\d{2}$/), createOutstation: z.boolean(),
  }),
  taxes: z.array(z.object({ tax_type: z.enum(['CGST', 'SGST', 'IGST', 'UTGST', 'CESS', 'OTHER']), rate: z.string(), source_ref: z.string().min(3) })).default([]),
  template: z.object({ name: z.string().min(1), layout: z.unknown() }).nullable().optional(),
  billSeries: z.object({ format: z.string(), nextNumber: z.number().int().positive().nullable() }).nullable().optional(),
  documentVersionIds: z.array(z.string().uuid()).default([]),
});
export type ApplyInput = z.infer<typeof ApplySchema>;

const num = (s: string | undefined) => (s && /^\d+(\.\d+)?$/.test(s) ? s : null);

/** Derives the series prefix of a bill-number format so a "next number" can be recorded for it. */
export function seriesPrefix(format: string, ctx: { client: string; date: string }): string {
  const [y, m] = ctx.date.split('-').map(Number);
  const fy = m >= 4 ? y : y - 1;
  return format.replace('{CLIENT}', ctx.client).replace('{FYS}', `${String(fy % 100).padStart(2, '0')}-${String((fy + 1) % 100).padStart(2, '0')}`)
    .replace('{FY}', `${fy}-${String((fy + 1) % 100).padStart(2, '0')}`).replace('{YYYY}', String(y)).replace('{MM}', String(m).padStart(2, '0')).split(/\{SEQ(?::\d+)?\}/)[0];
}

export async function applyProposal(db: Db, a: ApplyInput, userId: string) {
  return db.tx(async (t) => {
    const created: Record<string, unknown> = { rateVersions: [] as string[], taxRules: [] as string[], categories: [] as string[] };

    // Supplier profile: reuse the one with the same GSTIN.
    let supplierId = a.supplier.gstin ? (await t.one<{ id: string }>('SELECT id FROM supplier_profiles WHERE gstin = $1', [a.supplier.gstin]))?.id : undefined;
    if (!supplierId) {
      const anyDefault = await t.one('SELECT id FROM supplier_profiles WHERE is_default');
      const s = await t.one<{ id: string }>(
        `INSERT INTO supplier_profiles(name, address, gstin, pan, state_name, state_code, phone, email, bank_details, msme_no, tagline, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
        [a.supplier.name, a.supplier.address, a.supplier.gstin ?? null, a.supplier.pan ?? null, a.supplier.state_name ?? null, a.supplier.state_code ?? null, a.supplier.phone ?? null,
          a.supplier.email ?? null, a.supplier.bank_details ?? null, a.supplier.msme ?? null, a.supplier.tagline ?? null, !anyDefault],
      );
      supplierId = s!.id;
      await audit(t, userId, 'supplier', supplierId, 'create_from_documents', undefined, a.supplier);
    }
    created.supplierId = supplierId;

    // Department
    const c = a.client;
    // Reuse an existing department/institution: same GSTIN, else same name, else known by the same code.
    let clientId = c.existingId
      ?? (c.gstin ? (await t.one<{ id: string }>('SELECT id FROM clients WHERE gstin = $1 ORDER BY created_at LIMIT 1', [c.gstin]))?.id : undefined)
      ?? (await t.one<{ id: string }>(`SELECT id FROM clients WHERE lower(name) = lower($1) OR upper(short_code) = upper($2) OR upper($2) = ANY(aliases) ORDER BY created_at LIMIT 1`, [c.name, c.short_code]))?.id;
    const aliases = [...new Set([c.short_code.toUpperCase(), ...c.aliases.map((x) => x.trim().toUpperCase()).filter(Boolean)])];
    if (clientId) {
      await t.query(`UPDATE clients SET aliases = (SELECT array_agg(DISTINCT x) FROM unnest(aliases || $2::text[]) x), updated_at = now() WHERE id = $1`, [clientId, aliases]);
    } else {
      const r = await t.one<{ id: string }>(
        `INSERT INTO clients(name, short_code, billing_address, gstin, state_name, state_code, contact_name, contact_email, contact_phone, special_instructions, aliases)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::text[]) RETURNING id`,
        [c.name, c.short_code.toUpperCase(), c.billing_address, c.gstin ?? null, c.state_name ?? null, c.state_code ?? null, c.contact_name ?? null, c.contact_email ?? null,
          c.contact_phone ?? null, c.special_instructions ?? null, aliases],
      );
      clientId = r!.id;
      await audit(t, userId, 'client', clientId, 'create_from_documents', undefined, c);
    }
    created.clientId = clientId;

    // Contract
    const k = a.contract;
    const dupe = await t.one('SELECT id FROM contracts WHERE client_id = $1 AND reference_no = $2', [clientId, k.reference_no]);
    if (dupe) throw badRequest(`Contract ${k.reference_no} already exists for this department`);
    const contract = await t.one<{ id: string }>(
      `INSERT INTO contracts(client_id, supplier_profile_id, title, reference_no, po_number, start_date, end_date, billing_frequency, status, tax_mode, invoice_rounding,
         bill_no_format, contract_value, bid_no, sac_code)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
      [clientId, supplierId, k.title, k.reference_no, k.po_number ?? null, k.start_date, k.end_date ?? null, k.billing_frequency, k.status, k.tax_mode, k.invoice_rounding,
        k.bill_no_format, num(k.contract_value ?? undefined), k.bid_no ?? null, k.sac_code ?? null],
    );
    const contractId = contract!.id;
    created.contractId = contractId;
    await audit(t, userId, 'contract', contractId, 'create_from_documents', undefined, k);

    // Vehicle categories (merge aliases into existing ones with the same name)
    const catIds = new Map<string, string>();
    for (const cat of a.categories) {
      const ex = await t.one<{ id: string }>('SELECT id FROM vehicle_categories WHERE lower(name) = lower($1)', [cat.name]);
      const al = cat.aliases.map((x) => x.trim()).filter(Boolean);
      if (ex) {
        await t.query(`UPDATE vehicle_categories SET aliases = (SELECT array_agg(DISTINCT x) FROM unnest(aliases || $2::text[]) x) WHERE id = $1`, [ex.id, al]);
        catIds.set(cat.name.toLowerCase(), ex.id);
      } else {
        const r = await t.one<{ id: string }>('INSERT INTO vehicle_categories(name, description, aliases) VALUES ($1,$2,$3::text[]) RETURNING id', [cat.name, cat.description ?? null, al]);
        catIds.set(cat.name.toLowerCase(), r!.id);
        (created.categories as string[]).push(r!.id);
      }
    }

    // Duty types per package; the largest package is the normal local duty.
    const allPkgs = [...new Map(a.rates.flatMap((r) => r.packages).map((p) => [`${Number(p.hours)}/${Number(p.km)}`, p])).values()].sort((x, y) => Number(y.hours) - Number(x.hours));
    const dutyTypeFor = new Map<string, string>();
    for (const [i, p] of allPkgs.entries()) {
      const code = i === 0 ? 'LOCAL' : `LOCAL_${Number(p.hours)}H`;
      const nameT = i === 0 ? `Local duty (${Number(p.hours)} hrs / ${Number(p.km)} km)` : `Local ${Number(p.hours)} hrs / ${Number(p.km)} km`;
      await t.query(`INSERT INTO duty_types(code, name) VALUES ($1,$2) ON CONFLICT (code) DO NOTHING`, [code, nameT]);
      dutyTypeFor.set(`${Number(p.hours)}/${Number(p.km)}`, code);
    }
    await t.query(`INSERT INTO duty_types(code, name) VALUES ('OUTSTATION','Outstation duty') ON CONFLICT (code) DO NOTHING`);

    // Draft rate schemes
    const o = a.rateOptions;
    const mkConfig = (base: string, km: string, hours: string, exKm?: string, exHr?: string, night?: string) => RateConfigSchema.parse({
      billingModel: 'daily_package',
      params: {
        includedKm: String(Number(km)), includedHours: String(Number(hours)),
        hourRounding: { mode: o.hourRoundingMode, unit: o.hourRoundingUnit }, kmRounding: { mode: 'exact', unit: '1' },
        night: { enabled: o.nightEnabled && !!night, start: o.nightStart, end: o.nightEnd, minOverlapMinutes: 1, countMode: 'per_night' },
      },
      components: [
        { code: 'BASE', label: `Upto ${Number(km)} kms / ${Number(hours)} hrs duty`, quantityExpr: '1', rate: base, unit: 'duty', taxCategory: 'taxable', clauseRef: 'Rate schedule' },
        ...(exKm ? [{ code: 'EXKM', label: 'Extra Kms', quantityExpr: 'extra_km', rate: exKm, unit: 'km', taxCategory: 'taxable', clauseRef: 'Rate schedule' }] : []),
        ...(exHr ? [{ code: 'EXHR', label: 'Extra Hrs', quantityExpr: 'extra_hours', rate: exHr, unit: 'hr', taxCategory: 'taxable', clauseRef: 'Rate schedule' }] : []),
        ...(night && o.nightEnabled ? [{ code: 'NIGHT', label: 'Night Charges', quantityExpr: 'night_count', rate: night, unit: 'night', taxCategory: 'taxable', clauseRef: 'Rate schedule' }] : []),
        { code: 'TOLL', label: 'Toll Tax', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
        { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
      ],
    });
    const addScheme = async (name: string, catId: string | undefined, duty: string, cfg: ReturnType<typeof mkConfig>, note: string) => {
      const s = await t.one<{ id: string }>('INSERT INTO rate_schemes(contract_id, name, description) VALUES ($1,$2,$3) RETURNING id', [contractId, name, 'Created from uploaded rate schedule']);
      const v = await t.one<{ id: string }>(
        `INSERT INTO rate_scheme_versions(scheme_id, version_no, effective_from, effective_to, vehicle_category_ids, duty_type_codes, config, clause_ref, notes, created_by)
         VALUES ($1,1,$2,$3,$4::uuid[],$5::text[],$6,$7,$8,$9) RETURNING id`,
        [s!.id, k.start_date, k.end_date ?? null, catId ? [catId] : [], [duty], cfg, 'Rate schedule (uploaded)', note, userId],
      );
      (created.rateVersions as string[]).push(v!.id);
    };
    for (const r of a.rates) {
      const catId = catIds.get(r.category.toLowerCase());
      for (const p of r.packages) {
        if (!num(p.rate.value)) continue;
        await addScheme(`${r.category} — ${Number(p.hours)} hrs / ${Number(p.km)} km`, catId, dutyTypeFor.get(`${Number(p.hours)}/${Number(p.km)}`)!,
          mkConfig(p.rate.value, p.km, p.hours, num(r.extraKm?.value) ?? undefined, num(r.extraHour?.value) ?? undefined, num(r.nightLocal?.value) ?? undefined),
          'Draft from uploaded rate schedule — check every rate against the contract, then submit for approval.');
      }
      const top = [...r.packages].sort((x, y) => Number(y.hours) - Number(x.hours))[0];
      if (o.createOutstation && top && (r.outstationExtraKm || r.outstationExtraHour)) {
        await addScheme(`${r.category} — outstation`, catId, 'OUTSTATION',
          mkConfig(top.rate.value, top.km, top.hours, num(r.outstationExtraKm?.value) ?? undefined, num(r.outstationExtraHour?.value) ?? undefined, num(r.nightOutstation?.value) ?? undefined),
          'Draft: outstation daily rate taken from the largest local package because the schedule lists only outstation extras — confirm.');
      }
    }

    // Draft tax rules
    for (const tx of a.taxes) {
      const r = await t.one<{ id: string }>(
        `INSERT INTO tax_rules(contract_id, name, tax_type, rate, effective_from, effective_to, source_ref, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [contractId, `${tx.tax_type} ${tx.rate}%`, tx.tax_type, tx.rate, k.start_date, k.end_date ?? null, tx.source_ref, userId],
      );
      (created.taxRules as string[]).push(r!.id);
    }

    // Draft bill template
    if (a.template) {
      const layout = LayoutSchema.parse(a.template.layout);
      const tpl = await t.one<{ id: string }>('INSERT INTO billing_templates(client_id, contract_id, name, description) VALUES ($1,$2,$3,$4) RETURNING id', [clientId, contractId, a.template.name, 'Learned from the uploaded sample bill']);
      const tv = await t.one<{ id: string }>('INSERT INTO billing_template_versions(template_id, version_no, layout, notes, created_by) VALUES ($1,1,$2,$3,$4) RETURNING id', [tpl!.id, layout, 'Created from sample bill', userId]);
      created.templateVersionId = tv!.id;
    }

    // Bill number series continuation
    if (a.billSeries?.nextNumber) {
      const prefix = seriesPrefix(a.billSeries.format, { client: c.short_code.toUpperCase(), date: addDays(new Date().toISOString().slice(0, 10), 0) });
      const cur = (await t.one<{ value: Record<string, number> }>(`SELECT value FROM app_settings WHERE key = 'billSeriesNext'`))?.value ?? {};
      cur[prefix] = Math.max(cur[prefix] ?? 0, a.billSeries.nextNumber);
      await t.query(`INSERT INTO app_settings(key, value) VALUES ('billSeriesNext', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(cur)]);
      created.billSeries = { prefix, next: cur[prefix] };
    }

    // Link the uploaded documents to the new contract
    if (a.documentVersionIds.length) {
      await t.query(`UPDATE documents SET client_id = $1, contract_id = $2 WHERE id IN (SELECT document_id FROM document_versions WHERE id = ANY($3::uuid[]))`, [clientId, contractId, a.documentVersionIds]);
      await t.query(`UPDATE extracted_items SET contract_id = $1 WHERE document_version_id = ANY($2::uuid[])`, [contractId, a.documentVersionIds]);
    }
    return created;
  });
}
