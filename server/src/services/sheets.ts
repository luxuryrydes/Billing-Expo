/**
 * Reads any spreadsheet the importers accept (.xlsx, .xls, .csv) into plain
 * text rows per worksheet. Cell text is taken as displayed so codes, GSTINs and
 * vehicle numbers keep leading zeros. Formulas are read as their cached values.
 */
import { Readable } from 'node:stream';
import ExcelJS from 'exceljs';
import { runWorker } from './extraction.js';

export interface Workbook { sheets: { name: string; rows: string[][] }[] }

const text = (c: ExcelJS.Cell): string => {
  const v = c.value as unknown;
  if (v instanceof Date) {
    const iso = v.toISOString();
    return iso.slice(11, 16) === '00:00' ? iso.slice(0, 10) : `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
  }
  return (c.text ?? '').toString().trim();
};

export async function readWorkbook(buf: Buffer, ext: string, storedPath: string): Promise<Workbook> {
  if (ext === '.xls') {
    const r = await runWorker(storedPath);
    return { sheets: r.pages.map((p) => ({ name: p.sheet ?? `Sheet ${p.page}`, rows: (p.tables?.[0] ?? []).map((row) => row.map((c) => (c ?? '').trim())) })) };
  }
  const wb = new ExcelJS.Workbook();
  if (ext === '.csv') await wb.csv.read(Readable.from(buf.toString('utf8').replace(/^﻿/, '')));
  else await wb.xlsx.load(buf as unknown as ArrayBuffer);
  return {
    sheets: wb.worksheets.map((ws) => {
      const width = ws.columnCount;
      const rows: string[][] = [];
      for (let r = 1; r <= ws.rowCount; r++) {
        const row = ws.getRow(r);
        rows.push(Array.from({ length: width }, (_, i) => text(row.getCell(i + 1))));
      }
      return { name: ws.name, rows };
    }),
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9%]+/g, ' ').trim();

/** Picks the sheet and header row that best match the field synonyms, and maps each field to a column. */
export function detectTable(wb: Workbook, synonyms: Record<string, string[]>, sheetName?: string) {
  let best = { sheet: '', headerRow: 0, score: -1, headers: [] as string[] };
  for (const s of wb.sheets) {
    if (sheetName && s.name !== sheetName) continue;
    for (let r = 0; r < Math.min(15, s.rows.length); r++) {
      const hs = s.rows[r];
      const score = Object.values(autoMapHeaders(hs, synonyms)).length;
      if (score > best.score) best = { sheet: s.name, headerRow: r, score, headers: hs };
    }
  }
  const sheet = wb.sheets.find((s) => s.name === best.sheet) ?? wb.sheets[0];
  const headers = (best.headers.length ? best.headers : sheet?.rows[0] ?? []).map((h) => h.trim());
  const rows = (sheet?.rows ?? []).slice(best.headerRow + 1)
    .map((cells, i) => ({ rowNumber: best.headerRow + i + 2, cells }))
    .filter((r) => r.cells.some((c) => c.trim() !== ''));
  return { sheet: sheet?.name ?? '', sheets: wb.sheets.map((s) => s.name), headerRow: best.headerRow + 1, headers, rows, mapping: autoMapHeaders(headers, synonyms) };
}

export function autoMapHeaders(headers: string[], synonyms: Record<string, string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  const taken = new Set<number>();
  for (const pass of ['exact', 'contains'] as const) {
    for (const [field, syns] of Object.entries(synonyms)) {
      if (out[field] !== undefined) continue;
      const idx = headers.findIndex((h, i) => {
        if (taken.has(i) || !h) return false;
        const n = norm(h);
        return syns.some((s) => (pass === 'exact' ? n === norm(s) : norm(s).length >= 4 && n.includes(norm(s))));
      });
      if (idx >= 0) { out[field] = idx; taken.add(idx); }
    }
  }
  return out;
}

export function toCsv(rows: (string | number | null | undefined)[][]): string {
  return rows.map((r) => r.map((c) => {
    const s = c == null ? '' : String(c);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
