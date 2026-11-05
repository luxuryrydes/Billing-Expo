/**
 * Department bill templates from Excel workbooks (the LR Taxi Services "bill sheet" format): the header of each workbook gives the
 * department's name, address and GSTIN, and the sheet itself is the LR Standard layout the software already prints. Each workbook is
 * matched to a department record, the department's header details are filled in, and an LR Standard bill template is created for it
 * (awaiting the usual approval) with the workbook kept as its reference.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../db/index.js';
import { matchClient, type ClientKeyRow } from './departmentRates.js';

export interface DeptSheet {
  fileName: string;
  title: string | null;           // the client's own header title (blank when the first line is our company's name)
  clientLine: string;             // the department's name as printed
  subtitle: string | null;
  address: string;
  clientGstin: string | null;
  userNameLine: boolean;
  sac: string | null;
  supplierPan: string | null;
  supplierGstin: string | null;
  sample: { vehicle: string; package: string; base: string; extraKm: string | null; extraHr: string | null }[];
  hasToll: boolean;
  keyFromFile: string;
}

const text = (c: ExcelJS.Cell | undefined) => {
  if (!c) return '';
  const v = c.value as unknown;
  if (v && typeof v === 'object' && 'richText' in (v as object)) return (v as { richText: { text: string }[] }).richText.map((r) => r.text).join('').trim();
  return String(c.text ?? '').trim();
};
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '');
export const fileKey = (name: string) => name.replace(/\.xlsx$/i, '').replace(/^Institution_/i, '').replace(/_TEMPLATE$/i, '').replace(/_/g, ' ').trim();

export async function parseDeptWorkbook(buf: Buffer, fileName: string, supplierNames: string[]): Promise<DeptSheet> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error('The workbook has no sheet');
  const lines: string[] = [];
  let clientGstin: string | null = null;
  let userNameLine = false;
  for (let r = 1; r <= 7; r++) {
    const t = text(ws.getCell(`A${r}`));
    if (!t) continue;
    if (/^S\.?\s*No/i.test(t)) break;
    if (/^CLIENT\s*GSTIN/i.test(t)) { clientGstin = t.replace(/^CLIENT\s*GSTIN\s*[:\-]?\s*/i, '').trim() || null; continue; }
    if (/^User\s*Name/i.test(t)) { userNameLine = true; continue; }
    lines.push(t);
  }
  const supplier = new Set([...supplierNames, 'Total Transport Solution and Concept'].map(norm));
  const first = lines[0] ?? '';
  const nf = norm(first);
  // The first line is our own company when it is (part of) the supplier's name, as on most of the workbooks.
  const isSupplier = supplier.has(nf) || [...supplier].some((n) => n.length >= 6 && nf.length >= 6 && (n.startsWith(nf) || nf.startsWith(n)));
  const rest = lines.slice(1);
  // An address that was split over two lines, the second being only the PIN code.
  if (rest.length > 1 && /^\d{6}$/.test(rest[rest.length - 1])) { const pin = rest.pop()!; rest[rest.length - 1] = `${rest[rest.length - 1]} ${pin}`; }
  const title = isSupplier ? null : first || null;
  const clientLine = rest[0] ?? first;
  const address = rest.length > 1 ? rest[rest.length - 1] : '';
  const subtitle = rest.length > 2 ? rest.slice(1, -1).join(', ') : null;
  const side = (label: RegExp) => { for (let r = 1; r <= 6; r++) { const t = text(ws.getCell(`F${r}`)); if (label.test(t)) return t.replace(label, '').replace(/^[\s:\-]+/, '').trim() || null; } return null; };
  // The sample duty rows: the package line and the rates printed under it.
  const sample: DeptSheet['sample'] = [];
  let hasToll = false;
  let cur: DeptSheet['sample'][number] | null = null;
  ws.eachRow((row, n) => {
    if (n < 8) return;
    const d = text(row.getCell('D'));
    const f = text(row.getCell('F'));
    if (/^Duty for/i.test(d)) { cur = { vehicle: d.replace(/^Duty for\s*\(\s*/i, '').replace(/\s*\).*$/, ''), package: '', base: '', extraKm: null, extraHr: null }; sample.push(cur); return; }
    if (/Toll Tax/i.test(d)) hasToll = true;
    if (!cur) return;
    if (/^Extra Kms?/i.test(d)) cur.extraKm = f || null;
    else if (/^Extra Hrs?/i.test(d)) cur.extraHr = f || null;
    else if (/^(Upto|\d+\s*(hr|kms?)|\d+kms?\/|\d+hr)/i.test(d) && text(row.getCell('E')) && f) { cur.package = d; cur.base = f; }
    else if (/^Upto/i.test(d) && !cur.package) cur.package = d;
  });
  return {
    fileName, title, clientLine, subtitle, address, clientGstin, userNameLine,
    sac: side(/^SAC\s*:?-?/i), supplierPan: side(/^PAN\s*NO\s*:?-?/i), supplierGstin: side(/^GSTIN\s*:?/i),
    sample, hasToll, keyFromFile: fileKey(fileName),
  };
}

export async function loadClientKeys(db: Db): Promise<ClientKeyRow[]> {
  return db.query<ClientKeyRow>('SELECT id, name, code, short_code, aliases, kind, gstin, billing_registration, rate_card_contract_id FROM clients');
}

/** The department record a workbook belongs to, from the names printed in it and its file name. */
export function matchDepartmentFor(clients: ClientKeyRow[], s: DeptSheet): { client?: ClientKeyRow; ambiguous?: ClientKeyRow[] } {
  for (const name of [s.clientLine, s.title ?? '', s.keyFromFile]) {
    if (!name) continue;
    const hit = matchClient(clients, name, [s.title, s.keyFromFile, s.clientLine]);
    if (hit.client) return { client: hit.client };
    if (hit.ambiguous) return { ambiguous: hit.ambiguous };
  }
  return {};
}

/** Short code for a new department made from a workbook: the abbreviation in brackets, or the file's name in capitals. */
export function shortCodeFor(s: DeptSheet): string {
  const abbr = /\(([A-Za-z0-9 .&-]{2,12})\)\s*$/.exec(s.clientLine)?.[1];
  return (abbr ?? s.keyFromFile).replace(/[^A-Za-z0-9]+/g, '').toUpperCase().slice(0, 12) || 'DEPT';
}
