/**
 * The LR Taxi Services merged-invoice workbook: an editable Excel bill with live formulas and a
 * "Calculation Kit" sheet, laid out like the Word / PDF bill. Used for templates that carry the
 * LR Standard layout; every other layout still goes through renderLayoutXlsx.
 */
import ExcelJS from 'exceljs';
import { INR_FMT, renderLayoutXlsx } from './excel.js';
import type { RenderModel } from './render.js';

const LR_KEYS = ['sno', 'dutyDate', 'vehicleRegNo', 'description', 'unit', 'rate', 'nonTaxable', 'amount'];
const LR_WIDTHS = [7, 12, 14, 44, 9, 12, 13, 14];
const LR_BRAND = 'FFC00000';
const LR_GREY = 'FFD9D9D9';
const FONT = 'Arial';

/** The LR layout is 8 fixed columns; a template that changes them falls back to the generic workbook. */
export const isLrStandard = (m: RenderModel) => m.letterhead === 'box' && m.columns.length === LR_KEYS.length && m.columns.every((c, i) => c.key === LR_KEYS[i]);

/** The bill workbook for a render model: the LR layout when the template uses it, the generic one otherwise. */
export const renderBillXlsx = (m: RenderModel): Promise<Buffer> => (isLrStandard(m) ? renderLrStandardXlsx(m) : renderLayoutXlsx(m));

const asNumber = (s: string | undefined): number | null => (s && /^-?\d+(\.\d+)?$/.test(s) ? Number(s) : null);
const shownNumber = (s: string): number | null => (s ? asNumber(s.replace(/,/g, '')) : null);

/**
 * With the LR exact arithmetic every amount is a live formula (unit × rate, SUM, ROUND(tax), ROUND(total, 0))
 * that also carries the calculated value, so the file can be edited and still reconciles when opened.
 * Under standard arithmetic the same layout holds plain values.
 */
export async function renderLrStandardXlsx(m: RenderModel): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'LR Taxi Services';
  wb.created = new Date();
  wb.calcProperties = { fullCalcOnLoad: true } as unknown as ExcelJS.CalculationProperties;
  const ws = wb.addWorksheet('Bill', {
    pageSetup: { paperSize: 9 as unknown as ExcelJS.PaperSize, orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.6, header: 0.2, footer: 0.3 } },
    headerFooter: { oddFooter: '&L&8&K555555Page &P of &N' },
  });
  ws.columns = LR_WIDTHS.map((width) => ({ width }));
  const grey = { style: 'thin' as const, color: { argb: 'FF999999' } };
  const box = (row: number, bg?: string) => {
    for (let c = 1; c <= 8; c++) {
      const cell = ws.getRow(row).getCell(c);
      cell.border = { top: grey, left: grey, bottom: grey, right: grey };
      if (bg) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    }
  };

  // Letterhead: client on the left (A:E), SAC / PAN / GSTIN / bill no / date on the right (F:H).
  const left = m.box?.left ?? [];
  const right = m.box?.right ?? [];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const r = ws.addRow([]);
    ws.mergeCells(r.number, 1, r.number, 5);
    if (left[i]) { r.getCell(1).value = left[i].text; r.getCell(1).font = { bold: !!left[i].bold, size: left[i].size ?? 10, name: FONT }; }
    ws.mergeCells(r.number, 6, r.number, 8);
    if (right[i]) { r.getCell(6).value = right[i]; r.getCell(6).font = { bold: true, size: 10, name: FONT }; }
    r.alignment = { vertical: 'middle' };
  }
  ws.addRow([]);

  const head = ws.addRow(m.columns.map((c) => c.label));
  head.font = { bold: true, size: 10, name: FONT };
  head.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
  box(head.number, LR_GREY);

  const firstData = ws.rowCount + 1;
  for (const row of m.rows) {
    const r = ws.addRow([]);
    const [sno, date, car, desc, unit, rate, nonTax, amount] = row.cells;
    const heading = sno.v !== '';
    r.getCell(1).value = asNumber(sno.raw || sno.v) ?? sno.v;
    r.getCell(2).value = date.v;
    r.getCell(3).value = car.v;
    r.getCell(3).numFmt = '@';
    r.getCell(4).value = desc.v;
    const u = asNumber(unit.raw);
    const rt = asNumber(rate.raw);
    const am = asNumber(amount.raw);
    const nt = asNumber(nonTax.raw);
    if (u !== null) r.getCell(5).value = u;
    if (rt !== null) { r.getCell(6).value = rt; r.getCell(6).numFmt = INR_FMT; }
    if (nt !== null) { r.getCell(7).value = nt; r.getCell(7).numFmt = INR_FMT; }
    if (am !== null) {
      // A live formula only where it reproduces the calculated amount exactly.
      const live = m.exact && u !== null && rt !== null && Math.abs(u * rt - am) < 0.00005;
      r.getCell(8).value = live ? ({ formula: `E${r.number}*F${r.number}`, result: am } as ExcelJS.CellFormulaValue) : am;
      r.getCell(8).numFmt = INR_FMT;
    }
    r.font = { size: 10, name: FONT, bold: heading };
    r.alignment = { vertical: 'middle' };
    for (const c of [1, 2, 3, 5]) r.getCell(c).alignment = { horizontal: 'center', vertical: 'middle' };
    r.getCell(4).alignment = { horizontal: 'left', vertical: 'middle', wrapText: true };
    for (const c of [6, 7, 8]) r.getCell(c).alignment = { horizontal: 'right', vertical: 'middle' };
    box(r.number);
  }
  const lastData = ws.rowCount;
  const rangeH = `H${firstData}:H${lastData}`;
  const rangeG = `G${firstData}:G${lastData}`;

  let taxRow = 0;
  let tollRow = 0;
  let rcmRow = 0;
  const taxRows: number[] = [];
  for (const s of m.summary) {
    const r = ws.addRow([]);
    ws.mergeCells(r.number, 1, r.number, 5);
    r.getCell(6).value = s.label;
    const col = s.column === 'nonTaxable' ? 7 : 8;
    const shown = shownNumber(s.value);
    const put = (formula: string | null, result: number | null) => {
      if (result === null && formula === null) return;
      r.getCell(col).value = m.exact && formula ? ({ formula, result: result ?? 0 } as ExcelJS.CellFormulaValue) : result;
      r.getCell(col).numFmt = INR_FMT;
    };
    switch (s.key) {
      case 'taxableValue': taxRow = r.number; put(`SUM(${rangeH})`, shown); break;
      case 'tax': taxRows.push(r.number); put(`ROUND(H${taxRow}*${s.taxRate ?? 0}/100,2)`, shown); break;
      case 'nonTaxableTotal': tollRow = r.number; put(`SUM(${rangeG})`, shown); break;
      case 'rcmAmount': rcmRow = r.number; put(`SUM(${rangeH})+SUM(${rangeG})`, shown); break;
      case 'grandTotal': {
        // Tax is part of the total only when it is added; show_separate and reverse charge leave it out.
        const parts = m.presentation === 'add' ? [taxRow && `H${taxRow}`, ...taxRows.map((x) => `H${x}`), tollRow && `G${tollRow}`] : [taxRow && `H${taxRow}`, rcmRow && `H${rcmRow}`, tollRow && `G${tollRow}`];
        put(`ROUND(SUM(${parts.filter(Boolean).join(',') || '0'}),0)`, Number(m.grandTotal));
        break;
      }
      default: put(null, shown);
    }
    for (const c of [6, 7, 8]) {
      r.getCell(c).font = { bold: true, size: 10, name: FONT };
      r.getCell(c).alignment = { horizontal: 'right' };
    }
    if (s.strong && m.brandLabel) {
      r.getCell(1).value = m.brandLabel;
      r.getCell(1).font = { bold: true, size: 11, name: FONT, color: { argb: LR_BRAND } };
    }
    box(r.number);
  }
  if (m.exact) {
    ws.addRow([]);
    const note = ws.addRow(['', '', '', 'Amounts are live formulas — edit UNIT / RATE and the totals recalculate. The Calculation Kit sheet is for what-if checks.']);
    note.font = { italic: true, size: 9, name: FONT, color: { argb: 'FF666666' } };
  }

  addCalculationKit(wb, m);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

/** "Calculation Kit": an editable what-if sheet with the billing formulas of the merged invoice. */
function addCalculationKit(wb: ExcelJS.Workbook, m: RenderModel) {
  const ws = wb.addWorksheet('Calculation Kit');
  ws.columns = [{ width: 34 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 46 }];
  ws.addRow(['CALCULATION KIT — edit the blue inputs']).font = { bold: true, size: 13, name: FONT, color: { argb: LR_BRAND } };
  ws.addRow([]);
  const input = (label: string, value: number) => {
    const r = ws.addRow([label, value]);
    r.getCell(1).font = { size: 10, name: FONT };
    r.getCell(2).font = { size: 10, name: FONT, color: { argb: 'FF0000FF' }, bold: true };
    r.getCell(2).numFmt = INR_FMT;
    return `B${r.number}`;
  };
  const calc = (label: string, formula: string, note = '') => {
    const r = ws.addRow([label]);
    r.getCell(2).value = { formula } as ExcelJS.CellFormulaValue;
    r.getCell(2).numFmt = INR_FMT;
    r.getCell(1).font = { size: 10, name: FONT, bold: true };
    r.getCell(2).font = { size: 10, name: FONT, bold: true };
    r.getCell(5).value = note;
    r.getCell(5).font = { size: 9, name: FONT, italic: true, color: { argb: 'FF666666' } };
    return `B${r.number}`;
  };
  const section = (t: string) => {
    const r = ws.addRow([t]);
    r.getCell(1).font = { bold: true, size: 11, name: FONT };
    r.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LR_GREY } };
    ws.mergeCells(r.number, 1, r.number, 5);
  };
  section('Duty inputs');
  const baseFare = input('Base fare (package)', 0);
  const days = input('Days / duties', 1);
  const incKm = input('Included km', 0);
  const incHr = input('Included hours', 0);
  const runKm = input('Total run km', 0);
  const runHr = input('Total hours', 0);
  const rateKm = input('Extra km rate', 0);
  const rateHr = input('Extra hour rate', 0);
  const night = input('Night charge (per night)', 0);
  const nights = input('Nights', 0);
  const da = input('Driver allowance (per day)', 0);
  const parking = input('Parking', 0);
  const tolls = input('Toll tax', 0);
  ws.addRow([]);
  section('Charges (auto)');
  const baseAmt = calc('Base amount', `${baseFare}*${days}`, 'Base fare × days');
  const exKm = calc('Extra km', `MAX(0,${runKm}-${incKm}*${days})`, 'Run km − (included km × days)');
  const exKmAmt = calc('Extra km charge', `${exKm}*${rateKm}`);
  const exHr = calc('Extra hours', `MAX(0,${runHr}-${incHr}*${days})`, 'Run hrs − (included hrs × days)');
  const exHrAmt = calc('Extra hour charge', `${exHr}*${rateHr}`);
  const nightAmt = calc('Night charge', `${night}*${nights}`);
  const daAmt = calc('Driver allowance', `${da}*${days}`);
  const taxable = calc('Taxable amount', `${baseAmt}+${exKmAmt}+${exHrAmt}+${nightAmt}+${daAmt}`);
  ws.addRow([]);
  section('Tax & total');
  const pct = (type: string) => Number(m.summary.find((s) => s.key === 'tax' && s.label.toUpperCase().startsWith(type))?.taxRate ?? 0);
  const cgstP = input('CGST %', pct('CGST'));
  const sgstP = input('SGST %', pct('SGST'));
  const igstP = input('IGST %', pct('IGST'));
  const cgst = calc('CGST', `ROUND(${taxable}*${cgstP}/100,2)`);
  const sgst = calc('SGST', `ROUND(${taxable}*${sgstP}/100,2)`);
  const igst = calc('IGST', `ROUND(${taxable}*${igstP}/100,2)`);
  const nonTax = calc('Non taxable (parking + tolls)', `${parking}+${tolls}`);
  const grand = calc('Grand total', `${taxable}+${cgst}+${sgst}+${igst}+${nonTax}`);
  calc('Rounded total', `ROUND(${grand},0)`);
  ws.addRow([]);
  section('Example check (not part of the bill)');
  calc('TDS @ 1% of taxable', `ROUND(${taxable}*1%,2)`, 'Change 1% to any rate you need');
  calc('Amount after TDS', `${grand}-ROUND(${taxable}*1%,2)`);
}
