/**
 * Parses duty sheets (xlsx / csv) into candidate duty rows. Cell text is
 * used for identifiers so registration numbers keep leading zeros exactly as
 * displayed in the workbook. Nothing is saved here.
 */
import ExcelJS from 'exceljs';
import { Readable } from 'node:stream';

export const IMPORT_FIELDS = {
  dutyDate: ['date', 'duty date', 'dt', 'duty dt', 'date of duty'],
  vendorName: ['vendor', 'vendor name', 'vender', 'vender name', 'supplier'],
  vehicleCategory: ['vehicle type', 'type of vehicle', 'vehicle category', 'category', 'car type', 'vehicle', 'vehicle model'],
  vehicleRegNo: ['vehicle no', 'vehicle number', 'vehicle no.', 'regn no', 'reg no', 'registration no', 'registration number', 'car no', 'vehicle regn no', 'vehicle reg no'],
  driverName: ['driver', 'driver name', 'name of driver'],
  department: ['department', 'dept', 'client', 'ministry'],
  fieldOfficer: ['user', 'user name', 'officer', 'field officer', 'used by', 'name of officer', 'officer name'],
  startKm: ['starting km', 'start km', 'opening km', 'km start', 'starting kms', 'opening kms', 'start kms', 'starting reading', 'opening reading', 'km out'],
  endKm: ['closing km', 'end km', 'km end', 'closing kms', 'end kms', 'closing reading', 'km in'],
  startTime: ['starting time', 'start time', 'time out', 'reporting time', 'opening time', 'time start'],
  endTime: ['closing time', 'end time', 'time in', 'release time', 'relieving time', 'time end'],
  endDate: ['closing date', 'end date', 'release date'],
  dutyType: ['duty type', 'type of duty'],
  toll: ['toll', 'toll tax', 'toll amount'],
  parking: ['parking', 'parking amount', 'parking charges'],
  remarks: ['remarks', 'remark', 'notes'],
} as const;
export type ImportField = keyof typeof IMPORT_FIELDS;

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function autoMap(headers: string[]): Partial<Record<ImportField, number>> {
  const out: Partial<Record<ImportField, number>> = {};
  const taken = new Set<number>();
  // exact matches first, then "contains"
  for (const pass of ['exact', 'contains'] as const) {
    for (const [field, syns] of Object.entries(IMPORT_FIELDS) as [ImportField, readonly string[]][]) {
      if (out[field] !== undefined) continue;
      const idx = headers.findIndex((h, i) => {
        if (taken.has(i) || !h) return false;
        const n = norm(h);
        return syns.some((s) => (pass === 'exact' ? n === norm(s) : n.includes(norm(s)) && norm(s).length >= 4));
      });
      if (idx >= 0) { out[field] = idx; taken.add(idx); }
    }
  }
  return out;
}

export interface SheetData {
  sheetName: string;
  headerRow: number;
  headers: string[];
  rows: { rowNumber: number; cells: CellVal[] }[];
}

export type CellVal = { text: string; date?: string; time?: string; num?: string };

const pad = (n: number) => String(n).padStart(2, '0');

function cellVal(cell: ExcelJS.Cell): CellVal {
  const v = cell.value as unknown;
  const text = (cell.text ?? '').toString().trim();
  if (v instanceof Date) {
    // ExcelJS gives Excel serial dates as UTC Date objects.
    const date = `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())}`;
    const time = `${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}`;
    return { text, date: v.getUTCFullYear() > 1900 ? date : undefined, time };
  }
  if (typeof v === 'number') {
    const out: CellVal = { text, num: String(v) };
    if (v >= 0 && v < 1) {
      const mins = Math.round(v * 1440);
      out.time = `${pad(Math.floor(mins / 60) % 24)}:${pad(mins % 60)}`;
    }
    return out;
  }
  if (v && typeof v === 'object' && 'result' in (v as object)) {
    const r = (v as { result: unknown }).result;
    if (typeof r === 'number') return { text, num: String(r) };
  }
  return { text };
}

export async function readSheet(buf: Buffer, ext: string): Promise<SheetData> {
  const wb = new ExcelJS.Workbook();
  if (ext === '.csv') await wb.csv.read(Readable.from(buf.toString('utf8')));
  else await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) throw new Error('The workbook has no data');
  // Header row = first row within the first 15 that maps at least 3 fields.
  let headerRow = 1;
  let best = -1;
  for (let r = 1; r <= Math.min(15, ws.rowCount); r++) {
    const hs = (ws.getRow(r).values as unknown[]).slice(1).map((x) => (x == null ? '' : String((x as { richText?: { text: string }[] }).richText ? (x as { richText: { text: string }[] }).richText.map((t) => t.text).join('') : x)));
    const n = Object.keys(autoMap(hs)).length;
    if (n > best) { best = n; headerRow = r; }
  }
  const hr = ws.getRow(headerRow);
  const width = Math.max(hr.cellCount, ws.columnCount);
  const headers = Array.from({ length: width }, (_, i) => hr.getCell(i + 1).text.trim());
  const rows: SheetData['rows'] = [];
  for (let r = headerRow + 1; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const cells = Array.from({ length: width }, (_, i) => cellVal(row.getCell(i + 1)));
    if (cells.every((c) => !c.text)) continue;
    rows.push({ rowNumber: r, cells });
  }
  return { sheetName: ws.name, headerRow, headers, rows };
}

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

/** Parses Indian-style dates (DD-MM-YYYY, DD/MM/YY, 05-Sep-2025, ISO). */
export function parseDate(c: CellVal | undefined): string | null {
  if (!c) return null;
  if (c.date) return c.date;
  const s = c.text.trim();
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`;
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})$/.exec(s);
  if (m) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    if (+m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) return `${y}-${pad(+m[2])}-${pad(+m[1])}`;
  }
  m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ,]+(\d{2,4})$/.exec(s);
  if (m && MONTHS[m[2].toLowerCase()]) {
    const y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    return `${y}-${pad(MONTHS[m[2].toLowerCase()])}-${pad(+m[1])}`;
  }
  return null;
}

/** Parses 09:30, 9.30, 9:30 PM, 2130, or an Excel time fraction. */
export function parseTime(c: CellVal | undefined): string | null {
  if (!c) return null;
  if (c.time && !c.text.match(/[ap]\.?m/i)) return c.time;
  if (isBlankMark(c.text)) return null;
  const s = c.text.trim().toLowerCase().replace(/\s+/g, ' ');
  let m = /^(\d{1,2})[:.](\d{2})(?::\d{2})? ?([ap])\.?m?\.?$/.exec(s);
  if (m) {
    let h = +m[1] % 12;
    if (m[3] === 'p') h += 12;
    return +m[2] < 60 ? `${pad(h)}:${m[2]}` : null;
  }
  m = /^(\d{1,2}) ?([ap])\.?m\.?$/.exec(s);
  if (m) return `${pad((+m[1] % 12) + (m[2] === 'p' ? 12 : 0))}:00`;
  m = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(s);
  if (m && +m[1] < 24 && +m[2] < 60) return `${pad(+m[1])}:${m[2]}`;
  m = /^(\d{2})(\d{2})$/.exec(s);
  if (m && +m[1] < 24 && +m[2] < 60) return `${m[1]}:${m[2]}`;
  return c.time ?? null;
}

export function parseNumber(c: CellVal | undefined): string | null {
  if (!c) return null;
  if (c.num !== undefined) return c.num;
  if (isBlankMark(c.text)) return null;
  const s = c.text.replace(/[,₹\s]/g, '').replace(/^rs\.?/i, '');
  return /^-?\d+(\.\d+)?$/.test(s) ? s : s === '' ? null : s; // keep invalid text so validation reports it
}

/** Placeholders duty sheets use for "not recorded": ?, -, ., NA, nil. Treated as empty, never as a value. */
export function isBlankMark(s: string): boolean {
  return /^(\?+|-+|\.+|n\/?a|nil|none)$/i.test(s.trim());
}

/** Reads a duty sheet from Excel, CSV or a PDF table (via the document worker). */
export async function readAnySheet(buf: Buffer, ext: string, storedPath: string): Promise<SheetData> {
  if (ext !== '.pdf') return readSheet(buf, ext);
  const { runWorker } = await import('./extraction.js');
  const res = await runWorker(storedPath);
  const rows = res.pages.flatMap((p) => (p.tables ?? []).flatMap((t) => t.map((r) => ({ page: p.page, cells: r.map((c) => (c ?? '').replace(/\s+/g, ' ').trim()) }))));
  if (!rows.length) throw new Error('No table was found in the PDF. Scanned sheets need OCR or an Excel copy.');
  let headerIdx = 0;
  let best = -1;
  for (let i = 0; i < Math.min(15, rows.length); i++) {
    const n = Object.keys(autoMap(rows[i].cells)).length;
    if (n > best) { best = n; headerIdx = i; }
  }
  const headers = rows[headerIdx].cells;
  const sig = headers.join('|').toLowerCase();
  const width = headers.length;
  const data: SheetData['rows'] = [];
  rows.forEach((r, i) => {
    if (i <= headerIdx) return;
    if (r.cells.join('|').toLowerCase() === sig) return; // header repeated on each page
    if (r.cells.every((c) => !c)) return;
    const cells = Array.from({ length: width }, (_, j) => ({ text: r.cells[j] ?? '' }));
    data.push({ rowNumber: i + 1, cells });
  });
  return { sheetName: `PDF (${res.pages.length} pages)`, headerRow: headerIdx + 1, headers, rows: data };
}
