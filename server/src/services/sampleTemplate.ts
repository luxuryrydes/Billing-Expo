/**
 * Learns a starting bill layout from a department's sample bill.
 *  - PDF: column headings, duty-block wording, summary rows and number/date style are read
 *    from the extracted tables (the PDF itself is kept as the visual reference).
 *  - Excel: the workbook itself becomes the template; its table heading row is found and
 *    each column is mapped to a bill field, so bills are written into the department's own file.
 * The result is always a DRAFT that a person previews and approves.
 */
import path from 'node:path';
import ExcelJS from 'exceljs';
import { analyseBill } from './profile.js';
import { blockLayout } from './onboarding.js';
import { defaultDutyLayout, LayoutSchema, type Layout } from './render.js';
import type { XlsxMapping } from './excel.js';
import type { ExtractedPage } from './extraction.js';

/** Bill column heading → layout column (key, format). Order matters: first match wins. */
const COLUMN_GUESSES: [RegExp, string, Layout['columns'][number]['format']][] = [
  [/^(s\.?\s*no|sl\.?\s*no|sr\.?\s*no|sno)/i, 'sno', 'text'],
  [/date/i, 'dutyDate', 'date'],
  [/vehicle\s*(no|number|regn)|reg(istration)?\s*no|car\s*no/i, 'vehicleRegNo', 'text'],
  [/vehicle|car\s*type|model|category/i, 'vehicleCategory', 'text'],
  [/driver/i, 'driverName', 'text'],
  [/user|officer|booked by/i, 'fieldOfficer', 'text'],
  [/open(ing)?\s*km|start(ing)?\s*km|km\s*out/i, 'startKm', 'km'],
  [/clos(e|ing)\s*km|end\s*km|km\s*in/i, 'endKm', 'km'],
  [/(total|running)\s*km|^km$|kms?\s*run/i, 'totalKm', 'km'],
  [/(start|opening|out)\s*time|time\s*out/i, 'startTime', 'time'],
  [/(clos(e|ing)|end|in)\s*time|time\s*in/i, 'endTime', 'time'],
  [/(total|duty)\s*(hrs?|hours)/i, 'totalHours', 'hours'],
  [/extra\s*km.*amount|amount.*extra\s*km/i, 'comp:EXKM:amount', 'money'],
  [/extra\s*km/i, 'extraKm', 'km'],
  [/extra\s*(hr|hour).*amount/i, 'comp:EXHR:amount', 'money'],
  [/extra\s*(hr|hour)/i, 'extraHours', 'hours'],
  [/night/i, 'comp:NIGHT:amount', 'money'],
  [/toll|parking/i, 'tollParking', 'money'],
  [/non\s*taxable/i, 'nonTaxable', 'money'],
  [/taxable/i, 'taxable', 'money'],
  [/base|package|basic|rate/i, 'comp:BASE:amount', 'money'],
  [/description|particulars/i, 'remarks', 'text'],
  [/total|amount/i, 'dutyTotal', 'money'],
  [/remark/i, 'remarks', 'text'],
];

export function guessColumn(heading: string): { key: string; format: Layout['columns'][number]['format'] } | null {
  for (const [re, key, format] of COLUMN_GUESSES) if (re.test(heading.trim())) return { key, format };
  return null;
}

export interface LearnedTemplate { layout: Layout; xlsxMapping: XlsxMapping | null; notes: string[]; unmatched: string[] }

export function learnFromPdf(pages: ExtractedPage[], supplierName: string, fileName: string): LearnedTemplate {
  const bill = analyseBill(pages, fileName);
  if (!bill) return { layout: defaultDutyLayout(), xlsxMapping: null, unmatched: [], notes: [`No bill number or bill table was recognised in ${fileName}; a standard layout was created. Adjust it in the designer.`] };
  if (bill.layout === 'block') {
    return { layout: blockLayout(bill, supplierName), xlsxMapping: null, unmatched: [], notes: [`Duty-block layout learned from ${fileName}: ${bill.columns.join(' | ')} (${bill.dutyCount} duties on the sample).`, 'Fonts, borders and exact spacing of the PDF are not copied; compare the preview with the sample before approving.'] };
  }
  const unmatched: string[] = [];
  const columns = bill.columns.map((h) => {
    const g = guessColumn(h);
    if (!g) unmatched.push(h);
    return { key: g?.key ?? 'remarks', label: h, width: g?.format === 'money' ? 1.1 : 1, format: g?.format ?? 'text', total: g?.format === 'money' };
  });
  const layout = LayoutSchema.parse({ ...defaultDutyLayout(), title: bill.heading?.value ?? 'TAX INVOICE', columns: columns.length ? columns : defaultDutyLayout().columns, dateFormat: bill.dateFormat ?? 'dd-mm-yyyy', numberStyle: bill.plainNumbers ? 'plain' : 'indian' });
  return { layout, xlsxMapping: null, unmatched, notes: [`Columns learned from ${fileName}: ${bill.columns.join(' | ') || 'none'}.`, ...(unmatched.length ? [`Check these columns — their meaning was not recognised: ${unmatched.join(', ')}.`] : [])] };
}

const HEADING = /(s\.?\s*no|date|vehicle|description|particulars|amount|rate|km|driver|taxable)/i;

export async function learnFromXlsx(buf: Buffer, fileName: string): Promise<LearnedTemplate> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw new Error(`${path.basename(fileName)} has no data`);
  let headerRow = 0;
  let best = 0;
  for (let r = 1; r <= Math.min(40, ws.rowCount); r++) {
    const texts: string[] = [];
    ws.getRow(r).eachCell((c) => texts.push(c.text));
    const n = texts.filter((t) => HEADING.test(t) && t.length < 40).length;
    if (n > best) { best = n; headerRow = r; }
  }
  if (best < 2) throw new Error('No bill table heading row was found in the workbook. Map the cells manually in the template designer.');
  const cols: { letter: string; heading: string }[] = [];
  ws.getRow(headerRow).eachCell((c) => { if (c.text.trim()) cols.push({ letter: ws.getColumn(c.col).letter, heading: c.text.trim() }); });
  const unmatched: string[] = [];
  const columns = cols.map((c) => {
    const g = guessColumn(c.heading);
    if (!g) unmatched.push(c.heading);
    return { key: g?.key ?? 'remarks', label: c.heading, width: 1, format: g?.format ?? 'text', total: g?.format === 'money' };
  });
  const layout = LayoutSchema.parse({ ...defaultDutyLayout(), columns, showSupplier: false, showClient: false });
  const mapping: XlsxMapping = {
    sheet: ws.name,
    cells: {},
    table: { startRow: headerRow + 1, columns: Object.fromEntries(cols.map((c, i) => [c.letter, i])), templateRows: 1 },
    afterTable: {},
  };
  // Header cells: look for labelled cells such as "Bill No", "Date" above the table and fill the cell to their right.
  for (let r = 1; r < headerRow; r++) {
    ws.getRow(r).eachCell((c) => {
      const t = c.text.trim().toLowerCase();
      const right = ws.getCell(r, c.col + 1).address;
      if (/bill\s*no|invoice\s*no/.test(t)) mapping.cells[right] = '{billNo}';
      else if (/^(bill\s*)?date/.test(t)) mapping.cells[right] = '{billDate}';
      else if (/gstin/.test(t) && /client|buyer|recipient/.test(t)) mapping.cells[right] = '{clientGstin}';
      else if (/period|month/.test(t)) mapping.cells[right] = '{periodLabel}';
    });
  }
  return {
    layout, xlsxMapping: mapping, unmatched,
    notes: [`The workbook's table starts below row ${headerRow} on sheet "${ws.name}"; ${cols.length} columns were mapped.`, `Header cells filled automatically: ${Object.keys(mapping.cells).join(', ') || 'none found'} — add totals and other cells in the mapping.`,
      ...(unmatched.length ? [`Check these columns — their meaning was not recognised: ${unmatched.join(', ')}.`] : [])],
  };
}
