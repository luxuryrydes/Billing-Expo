/**
 * Turns extracted document pages into a structured, source-referenced profile:
 *   - labelled fields (organisation, GSTIN, address, contract no., service dates…),
 *   - rate tables (packages, extra km/hour, outstation, night charges per category),
 *   - sample-bill observations (bill number pattern, columns, layout, taxes, totals).
 * Every value carries the page and text it came from. Nothing here is approved;
 * the onboarding wizard shows it to a person who confirms or corrects it.
 */
import type { ExtractedPage } from './extraction.js';

export interface Sourced<T = string> {
  value: T;
  page: number | null;
  text: string;
  doc?: string;
  confidence: number;
}

export interface RatePackage { hours: string; km: string; rate: Sourced }
export interface RateRow {
  category: string; // e.g. "SUV AC"
  description: string; // full cell text e.g. "SUV AC (Ertiga, Innova Marrazo, equivalent)"
  examples: string[]; // model names found in brackets
  packages: RatePackage[];
  extraKm?: Sourced;
  extraHour?: Sourced;
  outstationExtraKm?: Sourced;
  outstationExtraHour?: Sourced;
  nightLocal?: Sourced;
  nightOutstation?: Sourced;
  ratesExcludeGst: boolean;
}

export interface BillObservation {
  billNo?: Sourced;
  billDate?: Sourced;
  clientGstin?: Sourced;
  supplierGstin?: Sourced;
  supplierPan?: Sourced;
  sac?: Sourced;
  clientName?: Sourced;
  clientAddress?: Sourced;
  heading?: Sourced;
  columns: string[];
  layout: 'block' | 'table' | 'unknown';
  blockPatterns: { header?: string; package?: string; running?: string; components: string[] };
  taxes: { type: string; rate: string; amount: string | null; source: Sourced }[];
  taxableTotal?: Sourced;
  nonTaxableLabel?: string;
  nonTaxableTotal?: Sourced;
  grandTotal?: Sourced;
  dateFormat?: string;
  dutyCount: number;
  plainNumbers: boolean;
}

export interface DocProfile {
  kind: 'contract' | 'rate_schedule' | 'sample_bill' | 'duty_sheet' | 'combined' | 'other';
  parts: ('contract' | 'rate_schedule' | 'sample_bill' | 'duty_sheet')[];
  fields: Record<string, Sourced>;
  supplierGstins: Sourced[];
  rates: RateRow[];
  bill?: BillObservation;
  dutySheet?: { headers: string[]; departments: Record<string, number>; rows: number };
}

const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
/** Bilingual labels look like "संगठन का नाम|Organisation Name :" — keep the English part. */
const english = (s: string) => clean(s.includes('|') ? s.slice(s.lastIndexOf('|') + 1) : s);
// 15 characters with a 2-digit state code. Government (TAN-based) GSTINs such as 07DELD08333D1DX must match too.
const GSTIN_RE = /\b\d{2}[A-Z0-9]{13}\b/g;
const GSTIN = '(\\d{2}[A-Z0-9]{13})';

export const GST_STATES: Record<string, string> = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand', '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan',
  '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim', '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh', '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu',
  '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa', '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory',
};

// --- labelled fields ------------------------------------------------------------

type Section = 'org' | 'buyer' | 'paying' | 'consignee' | 'provider' | 'service' | 'none';
const SECTION_HEADINGS: [RegExp, Section][] = [
  [/organi[sz]ation details/i, 'org'], [/buyer details/i, 'buyer'], [/paying authority/i, 'paying'], [/financial approval/i, 'paying'],
  [/consignee details/i, 'consignee'], [/service provider details|seller details|vendor details/i, 'provider'], [/service details/i, 'service'],
];

/** label regex → field key, optionally restricted to sections */
const LABELS: [RegExp, string, Section[]?][] = [
  [/^contract no\.?$|^contract number$|^agreement no\.?$/i, 'contract_no'],
  [/^contract generated date$|^contract date$/i, 'contract_date'],
  [/^bid\/ra\/pbp no\.?$|^bid no\.?$|^tender no\.?$/i, 'bid_no'],
  [/^type$/i, 'org_type', ['org']],
  [/^ministry$/i, 'client_ministry'],
  [/^department$/i, 'client_department', ['org']],
  [/^organi[sz]ation name$/i, 'client_org_name'],
  [/^office zone$|^office$/i, 'client_office'],
  [/^designation$/i, 'client_contact_designation', ['buyer']],
  [/^contact no\.?$|^contact$|^phone$/i, 'client_phone', ['buyer', 'consignee']],
  [/^email id$|^email$/i, 'client_email', ['buyer', 'consignee']],
  [/^gstin$/i, 'client_gstin', ['buyer', 'consignee']],
  [/^address$/i, 'client_address', ['buyer']],
  [/^company name$|^service provider name$|^seller name$/i, 'supplier_name', ['provider']],
  [/^contact no\.?$/i, 'supplier_phone', ['provider']],
  [/^email id$/i, 'supplier_email', ['provider']],
  [/^address$/i, 'supplier_address', ['provider']],
  [/^msme registration number$|^udyam registration/i, 'supplier_msme', ['provider']],
  [/^gem seller id$/i, 'supplier_gem_id', ['provider']],
  [/^service start date/i, 'service_start'],
  [/^service end date$/i, 'service_end'],
  [/^billing cycle$/i, 'billing_cycle'],
  [/^total contract value including all duties and taxes/i, 'contract_value'],
  [/^payment mode$/i, 'payment_mode'],
];

const isLabelLine = (l: string) => /:\s*$/.test(l) || /\|[^|]*:\s*/.test(l);

function sectionOf(line: string): Section | null {
  for (const [re, s] of SECTION_HEADINGS) if (re.test(line)) return s;
  return null;
}

export function labelledFields(pages: ExtractedPage[], doc?: string): { fields: Record<string, Sourced>; supplierGstins: Sourced[] } {
  const fields: Record<string, Sourced> = {};
  const supplierGstins: Sourced[] = [];
  let section: Section = 'none';
  for (const p of pages) {
    const lines = p.text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      const sec = sectionOf(raw);
      if (sec && !/:/.test(english(raw).replace(/:\s*$/, ''))) section = sec;
      // "Label : value" on one line, or "Label :" with the value on following line(s)
      const eng = english(raw);
      const m = /^([^:]{2,80}?)\s*:-?\s*(.*)$/.exec(eng);
      if (!m) continue;
      const label = clean(m[1]).replace(/\s*\(.*?\)\s*$/, (x) => (/(latest|inr)/i.test(x) ? '' : x));
      let value = clean(m[2]);
      let lastLine = i;
      const multiline = /address/i.test(label);
      if (!value || multiline) {
        const parts = value ? [value] : [];
        for (let j = i + 1; j < Math.min(lines.length, i + (multiline ? 5 : 2)); j++) {
          const nxt = lines[j];
          if (isLabelLine(nxt) || sectionOf(nxt)) break;
          parts.push(clean(nxt));
          lastLine = j;
          if (!multiline) break;
        }
        value = parts.join(', ').replace(/,\s*,/g, ',').replace(/,\s*$/, '');
      }
      if (!value || value === '-') continue;
      for (const [re, key, secs] of LABELS) {
        if (!re.test(label)) continue;
        if (secs && !secs.includes(section)) continue;
        if (key === 'supplier_name' || section !== 'provider' || !/gstin/i.test(label)) {
          if (!fields[key]) fields[key] = { value, page: p.page, text: lines.slice(i, lastLine + 1).join(' ').slice(0, 300), doc, confidence: 0.8 };
        }
        break;
      }
      if (/^gstin$/i.test(label) && section === 'provider') {
        for (const g of value.matchAll(GSTIN_RE)) {
          const after = value.slice((g.index ?? 0) + g[0].length, (g.index ?? 0) + g[0].length + 5);
          supplierGstins.push({ value: g[0], page: p.page, text: `${g[0]}${/\(R\)/.test(after) ? ' (R)' : /\(B\)/.test(after) ? ' (B)' : ''}`, doc, confidence: 0.85 });
        }
      }
    }
  }
  if (!fields.contract_value) {
    // GeM prints this label without a colon, value on the next line.
    for (const p of pages) {
      const m = /Total Contract Value Including All Duties and Taxes\s*\(INR\)\s*\n\s*([\d,]+(?:\.\d+)?)/i.exec(p.text);
      if (m) { fields.contract_value = { value: m[1].replace(/,/g, ''), page: p.page, text: clean(m[0]), doc, confidence: 0.8 }; break; }
    }
  }
  return { fields, supplierGstins };
}

const BRANDS = new Set(['maruti', 'suzuki', 'hyundai', 'hundai', 'honda', 'toyota', 'mahindra', 'tata', 'kia', 'mg', 'renault', 'nissan', 'skoda', 'volkswagen', 'ford', 'equivalent', 'or', 'and', 'etc']);

/** "Maruti Suzuki Ciaz Hyundai Verna, Honda City" → ["Ciaz", "Verna", "City"]: the model names used on duty sheets. */
export function modelNames(s: string): string[] {
  const words = s.split(/[\s,/&]+/).map((w) => w.replace(/[^A-Za-z0-9+-]/g, '')).filter((w) => w.length > 1 && !BRANDS.has(w.toLowerCase()));
  return [...new Set(words)];
}

// --- rate tables -------------------------------------------------------------------

const num = (s: string) => {
  const t = s.replace(/[,₹\s]/g, '').replace(/\/-$/, '').replace(/^rs\.?/i, '');
  return /^\d+(\.\d+)?$/.test(t) ? t : null;
};

/** Builds one header string per column from the header rows, forward-filling merged headings. */
function columnHeaders(header: string[][], width: number): string[] {
  const out = Array.from({ length: width }, () => '');
  for (const row of header) {
    let carry = '';
    for (let c = 0; c < width; c++) {
      const cell = clean(row[c] ?? '');
      if (cell) carry = cell;
      // Forward-fill only for wide group headings followed by empty cells.
      const v = cell || (carry && !/^(i|ii|iii|iv|v|vi|vii|viii|ix|x)$/i.test(carry) ? carry : '');
      if (v) out[c] = `${out[c]} ${v}`.trim();
      if (cell && c + 1 < width && clean(row[c + 1] ?? '') !== '') carry = '';
    }
  }
  return out.map((h) => h.toLowerCase());
}

export function rateTables(pages: ExtractedPage[], doc?: string): RateRow[] {
  const out: RateRow[] = [];
  for (const p of pages) {
    for (const t of p.tables ?? []) {
      if (t.length < 3) continue;
      const width = Math.max(...t.map((r) => r.length));
      const dataStart = t.findIndex((r) => /^\d{1,2}$/.test(clean(r[0] ?? '')) && r.filter((c) => num(c ?? '')).length >= 3);
      if (dataStart < 1) continue;
      const heads = columnHeaders(t.slice(0, dataStart), width);
      const allHead = heads.join(' ');
      if (!/(rate|charge|per km|per hour)/.test(allHead)) continue;
      const exclGst = /excluding gst|excl\.? gst|exclusive of gst/.test(allHead);
      // Classify columns
      type Col = { kind: string; hours?: string; km?: string };
      const cols: Col[] = heads.map((h) => {
        const pkg = /(\d{1,2})\s*(?:hours?|hrs?)\s*\/\s*(\d{2,4})\s*kms?/.exec(h) ?? /(\d{2,4})\s*kms?\s*\/\s*(\d{1,2})\s*(?:hours?|hrs?)/.exec(h);
        const outst = /outstation|out station/.test(h);
        if (/night/.test(h)) return { kind: /out\s*station|outstation/.test(h.replace(/.*night/, '')) ? 'night_out' : /local/.test(h) ? 'night_local' : 'night' };
        if (/per\s*km/.test(h) && /extra|more than|additional/.test(h)) return { kind: outst ? 'out_km' : 'extra_km' };
        if (/per\s*hour|per\s*hr/.test(h) && /extra|more than|additional/.test(h)) return { kind: outst ? 'out_hour' : 'extra_hour' };
        if (pkg) {
          const hoursFirst = /^\d{1,2}\s*(?:hours?|hrs?)/.test(pkg[0]);
          return { kind: 'package', hours: String(Number(hoursFirst ? pkg[1] : pkg[2])), km: String(Number(hoursFirst ? pkg[2] : pkg[1])) };
        }
        if (/make|model|vehicle|category|type/.test(h)) return { kind: 'name' };
        return { kind: 'other' };
      });
      if (!cols.some((c) => c.kind === 'package' || c.kind === 'extra_km')) continue;
      for (const r of t.slice(dataStart)) {
        const nameIdx = cols.findIndex((c) => c.kind === 'name');
        const nameCell = clean(r[nameIdx >= 0 ? nameIdx : 1] ?? '');
        if (!nameCell || /^total|price for evaluation/i.test(nameCell) || !/[a-z]/i.test(nameCell)) continue;
        const src = (v: string, what: string): Sourced => ({ value: v, page: p.page, text: `${nameCell} — ${what}: ${v}`, doc, confidence: 0.85 });
        const row: RateRow = {
          category: clean(nameCell.replace(/\(.*$/, '')) || nameCell,
          description: nameCell,
          examples: modelNames(/\(([^)]*)\)/.exec(nameCell)?.[1] ?? ''),
          packages: [],
          ratesExcludeGst: exclGst,
        };
        cols.forEach((c, i) => {
          const v = num(r[i] ?? '');
          if (!v) return;
          const h = heads[i];
          if (c.kind === 'package') row.packages.push({ hours: c.hours!, km: c.km!, rate: src(v, `${c.hours} hrs / ${c.km} km package`) });
          else if (c.kind === 'extra_km') row.extraKm = src(v, 'extra per km');
          else if (c.kind === 'extra_hour') row.extraHour = src(v, 'extra per hour');
          else if (c.kind === 'out_km') row.outstationExtraKm = src(v, 'outstation extra per km');
          else if (c.kind === 'out_hour') row.outstationExtraHour = src(v, 'outstation extra per hour');
          else if (c.kind === 'night_local' || c.kind === 'night') row.nightLocal = src(v, `night charge${/local/.test(h) ? ' (local)' : ''}`);
          else if (c.kind === 'night_out') row.nightOutstation = src(v, 'night charge (outstation)');
        });
        if (row.packages.length || row.extraKm) out.push(row);
      }
    }
  }
  return out;
}

// --- sample bill -------------------------------------------------------------------

const HEADER_WORDS = ['s. no', 's.no', 'sl', 'date', 'description', 'particulars', 'unit', 'qty', 'quantity', 'rate', 'amount', 'taxable', 'non taxable', 'vehicle', 'km', 'hrs', 'total'];

export function analyseBill(pages: ExtractedPage[], doc?: string): BillObservation | null {
  const text = pages.map((p) => p.text).join('\n');
  const find = (re: RegExp, group = 1): Sourced | undefined => {
    for (const p of pages) {
      const m = re.exec(p.text);
      if (m) return { value: clean(m[group]), page: p.page, text: clean(m[0]).slice(0, 200), doc, confidence: 0.85 };
    }
    return undefined;
  };
  const billNo = find(/bill\s*no\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-_.]{3,})/i) ?? find(/invoice\s*no\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/\-_.]{3,})/i);
  if (!billNo && !/tax invoice|bill/i.test(text)) return null;
  const obs: BillObservation = {
    billNo,
    billDate: find(/\bdate\s*[:\-]\s*(\d{1,2}[./-]\d{1,2}[./-]\d{2,4})/i),
    clientGstin: find(new RegExp(`client\\s*gstin\\s*[:\\-]?\\s*${GSTIN}`, 'i')) ?? find(new RegExp(`(?:buyer|recipient|customer)'?s?\\s*gstin\\s*[:\\-]?\\s*${GSTIN}`, 'i')),
    supplierGstin: find(new RegExp(`(?:^|\\n)\\s*gstin\\s*[:\\-]\\s*${GSTIN}`, 'i')),
    supplierPan: find(/pan\s*no\.?\s*[:\-]?\s*([A-Z]{5}\d{4}[A-Z])/i),
    sac: find(/sac\s*(?:code)?\s*[:\-]*\s*(\d{6})/i),
    columns: [],
    layout: 'unknown',
    blockPatterns: { components: [] },
    taxes: [],
    dutyCount: 0,
    plainNumbers: false,
  };
  // Header block of the first table: lines before "Client GSTIN" in the first column
  const t0 = pages[0]?.tables?.[0];
  if (t0) {
    const firstCol = t0.map((r) => clean(r[0] ?? '')).filter(Boolean);
    const gIdx = firstCol.findIndex((x) => /gstin/i.test(x));
    const block = (gIdx > 0 ? firstCol.slice(0, gIdx) : []).flatMap((x) => x.split(/\n/)).map(clean).filter(Boolean);
    if (block.length >= 2) {
      obs.heading = { value: block[0], page: 1, text: block[0], doc, confidence: 0.4 };
      obs.clientName = { value: block[1], page: 1, text: block[1], doc, confidence: 0.5 };
      if (block.length > 2) obs.clientAddress = { value: block.slice(2).join(', '), page: 1, text: block.slice(2).join(' '), doc, confidence: 0.5 };
    }
  }
  // Column headings: the first table row containing at least three known heading words
  for (const p of pages) {
    for (const t of p.tables ?? []) {
      const hr = t.find((r) => r.filter((c) => HEADER_WORDS.some((w) => clean(c ?? '').toLowerCase().replace(/\s+/g, ' ').startsWith(w))).length >= 3);
      if (hr) { obs.columns = hr.map((c) => clean(c ?? '')).filter(Boolean); break; }
    }
    if (obs.columns.length) break;
  }
  // Duty blocks: rows whose description starts a duty followed by component rows
  const descs: string[] = [];
  for (const p of pages) for (const t of p.tables ?? []) for (const r of t) for (const c of r) if (c && /[a-z]/i.test(c) && c.length < 120) descs.push(clean(c));
  const headerRows = descs.filter((d) => /^duty for|^vehicle\s*:|^car\s*no/i.test(d));
  if (headerRows.length >= 2) {
    obs.layout = 'block';
    obs.dutyCount = headerRows.length;
    obs.blockPatterns.header = headerRows[0];
    obs.blockPatterns.package = descs.find((d) => /^up\s*to|^upto|package/i.test(d));
    obs.blockPatterns.running = descs.find((d) => /total running|total km|running/i.test(d));
    const comps = ['extra kms?', 'extra hrs?', 'extra hours?', 'night charges?', 'toll tax & parking', 'toll', 'parking', 'driver allowance', 'outstation'];
    obs.blockPatterns.components = [...new Set(descs.filter((d) => comps.some((c) => new RegExp(`^${c}$`, 'i').test(d))))];
  } else if (obs.columns.length) obs.layout = 'table';
  // Taxes and totals (last page usually)
  for (const m of text.matchAll(/\b(IGST|CGST|SGST|UTGST)\s*[-@:]?\s*(\d{1,2}(?:\.\d+)?)\s*%/gi)) {
    const tx = { type: m[1].toUpperCase(), rate: m[2], amount: null as string | null, source: { value: `${m[1].toUpperCase()} ${m[2]}%`, page: null, text: clean(m[0]), doc, confidence: 0.75 } as Sourced };
    if (!obs.taxes.some((x) => x.type === tx.type)) obs.taxes.push(tx);
  }
  // Summary rows in tables: label cell + last numeric cell
  for (const p of pages) for (const t of p.tables ?? []) for (const r of t) {
    const label = r.map((c) => clean(c ?? '')).find((c) => /taxable amount|igst|cgst|sgst|toll tax|total amount|grand total|net payable/i.test(c));
    if (!label) continue;
    const amount = [...r].reverse().map((c) => num(c ?? '')).find((x) => x);
    if (!amount) continue;
    const s: Sourced = { value: amount, page: p.page, text: `${label} ${amount}`, doc, confidence: 0.8 };
    if (/^taxable amount/i.test(label)) obs.taxableTotal = s;
    else if (/total amount|grand total|net payable/i.test(label)) obs.grandTotal = s;
    else if (/toll|parking/i.test(label)) { obs.nonTaxableTotal = s; obs.nonTaxableLabel = label; }
    else {
      const tx = obs.taxes.find((x) => label.toUpperCase().startsWith(x.type));
      if (tx) tx.amount = amount;
    }
  }
  const dateSample = /\b(\d{2})([./-])(\d{2})\2(\d{4})\b/.exec(text);
  if (dateSample) obs.dateFormat = `dd${dateSample[2]}mm${dateSample[2]}yyyy`;
  obs.plainNumbers = /\b\d{4,}\.\d{2}\b/.test(text) && !/\b\d{1,3},\d{2,3}(,\d{3})*\.\d{2}\b/.test(text);
  return obs;
}

// --- duty sheets ---------------------------------------------------------------------

export function analyseDutySheet(pages: ExtractedPage[]): DocProfile['dutySheet'] | undefined {
  const rows = pages.flatMap((p) => (p.tables ?? []).flat());
  const hIdx = rows.findIndex((r) => r.filter((c) => /date|vehicle|driver|km|time/i.test(c ?? '')).length >= 4);
  if (hIdx < 0) return undefined;
  const headers = rows[hIdx].map((c) => clean(c ?? ''));
  const depCol = headers.findIndex((h) => /^department|^dept|^client/i.test(h));
  const departments: Record<string, number> = {};
  let count = 0;
  for (const r of rows.slice(hIdx + 1)) {
    if (r.map((c) => clean(c ?? '')).join('|') === headers.join('|')) continue;
    if (!/\d/.test(r[0] ?? '')) continue;
    count++;
    if (depCol >= 0) {
      const d = clean(r[depCol] ?? '').toUpperCase();
      if (d) departments[d] = (departments[d] ?? 0) + 1;
    }
  }
  return { headers, departments, rows: count };
}

export function profileDocument(pages: ExtractedPage[], doc?: string): DocProfile {
  const { fields, supplierGstins } = labelledFields(pages, doc);
  const rates = rateTables(pages, doc);
  const ratePages = new Set(pages.filter((p) => rateTables([p], doc).length).map((p) => p.page));
  const duty = analyseDutySheet(pages.filter((p) => !ratePages.has(p.page)));
  // A single PDF may hold the contract, the rate schedule and a sample bill one after another:
  // the bill is read from the first page that carries a bill/invoice number onwards.
  const firstBill = pages.findIndex((p) => /\b(bill|invoice)\s*no\b/i.test(p.text) || /^\s*duty for\b/im.test(p.text));
  const billPages = firstBill >= 0 ? pages.slice(firstBill).filter((p) => !ratePages.has(p.page)) : [];
  const realDuty = duty && duty.rows > 5 ? duty : undefined;
  const billObs = billPages.length && !realDuty ? analyseBill(billPages, doc) : null;
  const bill = billObs && (billObs.billNo || billObs.layout !== 'unknown') ? billObs : null;
  const parts: DocProfile['parts'] = [];
  if (fields.contract_no || fields.client_org_name) parts.push('contract');
  if (rates.length) parts.push('rate_schedule');
  if (bill) parts.push('sample_bill');
  if (realDuty) parts.push('duty_sheet');
  const kind: DocProfile['kind'] = parts.length > 1 ? 'combined' : parts[0] ?? 'other';
  return { kind, parts, fields, supplierGstins, rates, bill: bill ?? undefined, dutySheet: realDuty };
}
