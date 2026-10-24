import ExcelJS from 'exceljs';
import { z } from 'zod';
import { dec } from '../engine/decimal.js';
import { fill, type Cell, type RenderModel } from './render.js';
import { labelSep } from './pdf.js';

/** Indian-grouped number format (handles lakh / crore separators). */
export const INR_FMT = '[>=10000000]##\\,##\\,##\\,##0.00;[>=100000]##\\,##\\,##0.00;##,##0.00';

const thin = { style: 'thin' as const, color: { argb: 'FF555555' } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function setCell(c: ExcelJS.Cell, cell: Cell, plain = false) {
  const numeric = ['money', 'number', 'km', 'hours'].includes(cell.fmt) && /^-?\d+(\.\d+)?$/.test(cell.raw);
  if (numeric) {
    c.value = dec(cell.raw).toNumber(); // values are already rounded to 2dp by the engine
    c.numFmt = cell.fmt === 'money' ? (plain ? '0.00' : INR_FMT) : '0.##';
  } else if (cell.fmt === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(cell.raw)) {
    const [y, m, d] = cell.raw.split('-').map(Number);
    c.value = new Date(Date.UTC(y, m - 1, d));
    c.numFmt = 'dd-mm-yyyy';
  } else {
    c.value = cell.v; // text — vehicle numbers keep leading zeros
    c.numFmt = '@';
  }
  c.alignment = { horizontal: cell.align, vertical: 'middle', wrapText: true };
}

/** Writes a bill workbook laid out from the template designer. */
export async function renderLayoutXlsx(m: RenderModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LR Billing';
  const ws = wb.addWorksheet('Bill', {
    pageSetup: {
      paperSize: (m.page.size === 'A3' ? 8 : m.page.size === 'LEGAL' ? 5 : 9) as unknown as ExcelJS.PaperSize,
      orientation: m.page.orientation,
      fitToPage: true, fitToWidth: 1, fitToHeight: 0,
      margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 },
    },
    headerFooter: { oddFooter: '&L&8&K555555Page &P of &N&R&8&K555555' + m.title.replace(/&/g, '&&') },
  });
  const n = m.columns.length;
  ws.columns = m.columns.map((c) => ({ width: Math.max(6, Math.round(c.width * 11)) }));
  let r = 1;
  const merged = (row: number, text: string, opts: Partial<ExcelJS.Style> = {}, from = 1, to = n) => {
    ws.mergeCells(row, from, row, to);
    const c = ws.getCell(row, from);
    c.value = text;
    Object.assign(c, opts);
    return c;
  };
  merged(r++, m.title, { font: { bold: true, size: 14 }, alignment: { horizontal: 'center' } });
  const half = Math.max(1, Math.floor(n / 2));
  const blockRows = Math.max(m.supplierBlock.length, m.clientBlock.length);
  for (let i = 0; i < blockRows; i++) {
    if (m.supplierBlock[i] !== undefined) merged(r, m.supplierBlock[i], { font: { bold: i === 0, size: i === 0 ? 11 : 9 } }, 1, half);
    if (m.clientBlock[i] !== undefined) merged(r, m.clientBlock[i], { font: { bold: i <= 1, size: 9 } }, half + 1, n);
    r++;
  }
  r++;
  for (const h of m.headerFields) {
    merged(r, `${labelSep(h.label)}${h.value}`, { font: { size: 9 } }, 1, n);
    r++;
  }
  r++;
  // Table header (two rows when columns are grouped)
  const hasGroups = m.columns.some((c) => c.group);
  const headerStart = r;
  if (hasGroups) {
    let i = 0;
    while (i < n) {
      const g = m.columns[i].group;
      let j = i;
      while (g && j + 1 < n && m.columns[j + 1].group === g) j++;
      if (g) {
        ws.mergeCells(r, i + 1, r, j + 1);
        ws.getCell(r, i + 1).value = g;
        for (let k = i; k <= j; k++) ws.getCell(r + 1, k + 1).value = m.columns[k].label;
      } else {
        ws.mergeCells(r, i + 1, r + 1, i + 1);
        ws.getCell(r, i + 1).value = m.columns[i].label;
      }
      i = j + 1;
    }
    r += 2;
  } else {
    m.columns.forEach((c, i) => (ws.getCell(r, i + 1).value = c.label));
    r++;
  }
  for (let hr = headerStart; hr < r; hr++) {
    for (let ci = 1; ci <= n; ci++) {
      const c = ws.getCell(hr, ci);
      c.font = { bold: true, size: 9 };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
      c.border = BORDER;
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } };
    }
  }
  ws.pageSetup.printTitlesRow = `${headerStart}:${r - 1}`;
  ws.views = [{ state: 'frozen', ySplit: r - 1 }];
  for (const row of m.rows) {
    let span = 1;
    if (row.kind !== 'data') {
      const idx = row.cells.findIndex((c, i) => i > 0 && c.v !== '');
      span = idx === -1 ? n : idx;
    }
    row.cells.forEach((cell, i) => {
      const c = ws.getCell(r, i + 1);
      if (i === 0 || i >= span) setCell(c, cell, m.numberStyle === 'plain');
      c.border = BORDER;
      c.font = { size: 9, bold: row.kind !== 'data' };
    });
    if (span > 1) ws.mergeCells(r, 1, r, span);
    r++;
  }
  r++;
  for (const s of m.summary) {
    ws.mergeCells(r, 1, r, n - 2);
    const l = ws.getCell(r, 1);
    l.value = s.label;
    l.alignment = { horizontal: 'right' };
    l.font = { bold: !!s.strong, size: 10 };
    ws.mergeCells(r, n - 1, r, n);
    const v = ws.getCell(r, n - 1);
    const raw = s.value.replace(/,/g, '');
    if (/^-?\d+(\.\d+)?$/.test(raw)) { v.value = Number(raw); v.numFmt = m.numberStyle === 'plain' ? '0.00' : INR_FMT; } else v.value = s.value;
    v.alignment = { horizontal: 'right' };
    v.font = { bold: !!s.strong, size: 10 };
    v.border = BORDER;
    r++;
  }
  if (m.amountInWords) { r++; merged(r++, `Amount in words: ${m.amountInWords}`, { font: { italic: true, size: 9 } }); }
  for (const note of m.notes) merged(r++, note, { font: { size: 8 }, alignment: { wrapText: true } });
  if (m.declaration) { r++; merged(r++, m.declaration, { font: { size: 8 }, alignment: { wrapText: true } }); }
  r += 3;
  m.signatures.forEach((s, i) => {
    const per = Math.max(1, Math.floor(n / Math.max(1, m.signatures.length)));
    const from = i * per + 1;
    const to = i === m.signatures.length - 1 ? n : from + per - 1;
    merged(r, s, { font: { bold: true, size: 9 }, alignment: { horizontal: i === 0 ? 'left' : 'right' } }, from, to);
  });
  ws.pageSetup.printArea = `A1:${ws.getColumn(n).letter}${r}`;
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// --- Uploaded workbook templates ---------------------------------------------

export const XlsxMappingSchema = z.object({
  sheet: z.string().optional(),
  /** Fixed cells, e.g. { "B3": "{billNo}", "F3": "{billDate}" } */
  cells: z.record(z.string().regex(/^[A-Z]{1,3}\d+$/), z.string()).default({}),
  table: z.object({
    startRow: z.number().int().min(1),
    /** Column letter → render column index (0-based, from the layout) */
    columns: z.record(z.string().regex(/^[A-Z]{1,3}$/), z.number().int().min(0)),
    /** Number of rows that already exist in the template for line items (styled placeholder rows). */
    templateRows: z.number().int().min(1).default(1),
  }),
  /** Cells placed relative to the last table row: { "H:2": "{taxableValue}", "H:6": "=SUM(H{START}:H{END})" } */
  afterTable: z.record(z.string().regex(/^[A-Z]{1,3}:\d+$/), z.string()).default({}),
});
export type XlsxMapping = z.infer<typeof XlsxMappingSchema>;

function writeValue(c: ExcelJS.Cell, text: string, tokens: Record<string, string>, resultHint?: string) {
  if (text.startsWith('=')) {
    c.value = { formula: fill(text.slice(1), tokens), result: resultHint !== undefined ? Number(resultHint) : undefined } as ExcelJS.CellFormulaValue;
    return;
  }
  const v = fill(text, tokens);
  const raw = v.replace(/,/g, '');
  // Only pure amount placeholders become numbers; identifiers stay text.
  if (/^\{(taxableValue|nonTaxableTotal|taxTotal|roundOff|grandTotal|tax_\w+)\}$/.test(text) && /^-?\d+(\.\d+)?$/.test(raw)) {
    c.value = Number(raw);
    if (!c.numFmt || c.numFmt === 'General') c.numFmt = INR_FMT;
  } else c.value = v;
}

/**
 * Populates an uploaded customer workbook. Line-item rows are inserted by
 * copying the template row's styles; header and total cells keep their
 * original formatting. Macros are never preserved (xlsx only).
 */
export async function renderMappedXlsx(templateBuf: Buffer, mapping: XlsxMapping, m: RenderModel, tokens: Record<string, string>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(templateBuf as unknown as ArrayBuffer);
  const ws = mapping.sheet ? wb.getWorksheet(mapping.sheet) : wb.worksheets[0];
  if (!ws) throw new Error(`Sheet "${mapping.sheet}" not found in the template`);
  for (const [addr, text] of Object.entries(mapping.cells)) writeValue(ws.getCell(addr), text, tokens);
  const { startRow, columns, templateRows } = mapping.table;
  const needed = m.rows.length;
  if (needed > templateRows) {
    const styleRow = ws.getRow(startRow + templateRows - 1);
    const extra = needed - templateRows;
    // duplicateRow copies values and styles; we overwrite values below.
    ws.duplicateRow(styleRow.number, extra, true);
  }
  m.rows.forEach((row, i) => {
    const r = ws.getRow(startRow + i);
    for (const [col, idx] of Object.entries(columns)) {
      const cell = row.cells[idx];
      const c = r.getCell(col);
      if (!cell) { c.value = null; continue; }
      const keepFmt = c.numFmt;
      setCell(c, cell, m.numberStyle === 'plain');
      if (keepFmt && keepFmt !== 'General' && cell.fmt !== 'text') c.numFmt = keepFmt;
      if (row.kind !== 'data') c.font = { ...(c.font ?? {}), bold: true };
    }
  });
  // Blank any unused template rows
  for (let i = needed; i < templateRows; i++) for (const col of Object.keys(columns)) ws.getRow(startRow + i).getCell(col).value = null;
  const lastRow = startRow + Math.max(needed, templateRows) - 1;
  const t = { ...tokens, START: String(startRow), END: String(startRow + needed - 1) };
  for (const [key, text] of Object.entries(mapping.afterTable)) {
    const [col, off] = key.split(':');
    writeValue(ws.getCell(`${col}${lastRow + Number(off)}`), text, t);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** Reads the workbook back for reconciliation: finds the grand total and counts data rows. */
export async function inspectXlsx(buf: Buffer): Promise<{ numbers: string[]; texts: string[] }> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const numbers: string[] = [];
  const texts: string[] = [];
  for (const ws of wb.worksheets) ws.eachRow((row) => row.eachCell((c) => {
    const v = c.value as unknown;
    if (typeof v === 'number') numbers.push(v.toFixed(2));
    else if (v && typeof v === 'object' && 'result' in (v as object) && typeof (v as { result: unknown }).result === 'number') numbers.push(((v as { result: number }).result).toFixed(2));
    else if (v != null) texts.push(String(c.text));
  }));
  return { numbers, texts };
}

/** Internal calculation register: every line with its formula and trace. Not for customer submission. */
export async function renderRegisterXlsx(title: string, lines: { [k: string]: unknown }[], exceptions: { [k: string]: unknown }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Calculation register');
  ws.addRow([title]).font = { bold: true, size: 12 };
  ws.addRow([]);
  const hdr = ws.addRow(['Duty date', 'Vehicle no.', 'Scope', 'Component', 'Description', 'Quantity', 'Unit', 'Rate', 'Amount', 'Tax category', 'Formula', 'Inputs', 'Rule (scheme / version)', 'Contract clause']);
  hdr.font = { bold: true };
  for (const l of lines) {
    const row = ws.addRow([l.dutyDate ?? '', l.vehicleRegNo ?? '', l.scope, l.componentCode, l.label, Number(l.quantity), l.unit, Number(l.rate), Number(l.amount), l.taxCategory, l.formula, l.inputs, l.rule, l.clauseRef ?? '']);
    row.getCell(2).numFmt = '@';
    row.getCell(9).numFmt = INR_FMT;
  }
  ws.columns.forEach((c, i) => (c.width = [12, 14, 10, 10, 26, 10, 8, 10, 12, 12, 36, 50, 26, 20][i] ?? 12));
  const ex = wb.addWorksheet('Exceptions');
  ex.addRow(['Severity', 'Code', 'Duty', 'Message', 'Status', 'Resolution']).font = { bold: true };
  for (const e of exceptions) ex.addRow([e.severity, e.code, e.duty ?? '', e.message, e.status, e.resolution_note ?? '']);
  ex.columns.forEach((c, i) => (c.width = [10, 22, 26, 80, 10, 40][i]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
