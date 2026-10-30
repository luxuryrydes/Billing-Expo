/**
 * The extracted slip data as an Excel sheet people can correct in bulk, and the way back: only cells that
 * were changed in the sheet become edits; everything else stays as it was.
 */
import ExcelJS from 'exceljs';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/http.js';
import { effectiveValues, type ReadingRow } from './slipDuty.js';
import { SLIP_FIELDS } from './slipReader.js';

const ID_HEADER = 'Row ID';

export async function exportSlipsXlsx(title: string, rows: { reading: ReadingRow; position: number }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LR Billing';
  const ws = wb.addWorksheet('Duty slips');
  ws.addRow([`Duty slips — ${title}`]).font = { bold: true, size: 12 };
  ws.addRow(['Correct any cell and import the sheet back. Do not change or delete the Row ID column; only cells you change are applied, and nothing is saved as a duty until you save it in the software.']).font = { italic: true, size: 9 };
  const header = ws.addRow([ID_HEADER, 'Page', 'Low confidence', ...SLIP_FIELDS.map((f) => f.label)]);
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: 'middle' };
  header.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDEDED' } }; c.border = { bottom: { style: 'thin' } }; });
  for (const { reading, position } of rows) {
    const v = effectiveValues(reading);
    const low = SLIP_FIELDS.filter((f) => v[f.key] && reading.edited?.[f.key] === undefined && (reading.fields?.[f.key]?.confidence ?? 1) < 0.6).map((f) => f.label).join(', ');
    const r = ws.addRow([reading.id, position, low, ...SLIP_FIELDS.map((f) => v[f.key] ?? '')]);
    r.eachCell((c, i) => { if (i > 3) c.numFmt = '@'; }); // text, so vehicle numbers, dates and times stay as read
  }
  ws.columns = [{ width: 38 }, { width: 6 }, { width: 22 }, ...SLIP_FIELDS.map((f) => ({ width: f.kind === 'text' ? 22 : 13 }))];
  ws.getColumn(1).hidden = false;
  ws.views = [{ state: 'frozen', xSplit: 3, ySplit: 3 }];
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export interface SlipImportResult { rows: number; changedRows: number; changedCells: number; unknownRows: string[] }

export async function importSlipsXlsx(db: Db, userId: string, batchId: string, buf: Buffer): Promise<SlipImportResult> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as unknown as ArrayBuffer);
  const ws = wb.worksheets.find((s) => s.name === 'Duty slips') ?? wb.worksheets[0];
  let headerRow = 0;
  ws.eachRow((r, n) => { if (!headerRow && r.getCell(1).text.trim() === ID_HEADER) headerRow = n; });
  if (!headerRow) throw badRequest(`This is not an exported slip sheet: the "${ID_HEADER}" column is missing.`);
  const head = ws.getRow(headerRow);
  const colOf = new Map<string, number>();
  for (let c = 1; c <= ws.columnCount; c++) { const label = head.getCell(c).text.trim(); const f = SLIP_FIELDS.find((x) => x.label === label); if (f) colOf.set(f.key, c); }
  if (!colOf.size) throw badRequest('None of the duty slip columns were found in this sheet.');

  const result: SlipImportResult = { rows: 0, changedRows: 0, changedCells: 0, unknownRows: [] };
  await db.tx(async (t) => {
    for (let n = headerRow + 1; n <= ws.rowCount; n++) {
      const id = ws.getRow(n).getCell(1).text.trim();
      if (!id) continue;
      result.rows++;
      const reading = await t.one<ReadingRow>('SELECT * FROM slip_readings WHERE id = $1 AND batch_id = $2', [id, batchId]).catch(() => null);
      if (!reading) { result.unknownRows.push(id); continue; }
      const now = effectiveValues(reading);
      const edits: Record<string, string> = {};
      for (const [key, col] of colOf) {
        const next = ws.getRow(n).getCell(col).text.trim();
        if (next !== (now[key] ?? '')) edits[key] = next;
      }
      const keys = Object.keys(edits);
      if (!keys.length) continue;
      await t.query('UPDATE slip_readings SET edited = edited || $2::jsonb, updated_at = now() WHERE id = $1', [id, JSON.stringify(edits)]);
      await audit(t, userId, 'slip_reading', id, 'excel_edit', undefined, edits);
      result.changedRows++;
      result.changedCells += keys.length;
    }
  });
  return result;
}
