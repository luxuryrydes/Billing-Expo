import { createRequire } from 'node:module';
import type { Content, TableCell, TDocumentDefinitions } from 'pdfmake/interfaces.js';
import type { RenderModel } from './render.js';

type Printer = { createPdfKitDocument(def: TDocumentDefinitions): NodeJS.ReadableStream & { end(): void } };
let printer: Printer | null = null;
/** pdfmake and its fonts are loaded the first time a PDF is made, so a problem with them cannot stop the server from starting. */
function getPrinter(): Printer {
  if (!printer) {
    const require = createRequire(import.meta.url);
    // pdfmake 0.2 server-side printer (CommonJS)
    const PdfPrinter = require('pdfmake') as new (fonts: unknown) => Printer;
    const vfs = require('pdfmake/build/vfs_fonts.js') as Record<string, string>;
    const font = (n: string) => Buffer.from(vfs[n], 'base64');
    printer = new PdfPrinter({
      Roboto: { normal: font('Roboto-Regular.ttf'), bold: font('Roboto-Medium.ttf'), italics: font('Roboto-Italic.ttf'), bolditalics: font('Roboto-MediumItalic.ttf') },
    });
  }
  return printer;
}

/** "Bill No" → "Bill No: "; labels that already end in punctuation ("SAC:-", "DATE :") are kept as written. */
export const labelSep = (l: string) => (/[:\-.]\s*$/.test(l) ? `${l} ` : `${l}: `);

const PAGE_WIDTH: Record<string, [number, number]> = { A4: [595.28, 841.89], A3: [841.89, 1190.55], LEGAL: [612, 1008] };

const BRAND_RED = '#C00000';

/**
 * The LR Taxi Services merged-invoice page: a bordered letterhead (client on the left, SAC / PAN / GSTIN /
 * bill no / date on the right), the duty table, and the totals as rows of that table ending in the brand total.
 */
function buildBoxPdfDefinition(m: RenderModel): TDocumentDefinitions {
  const [w, h] = PAGE_WIDTH[m.page.size];
  const pageW = m.page.orientation === 'landscape' ? h : w;
  const usable = pageW - m.page.margins[0] - m.page.margins[2];
  const totalWeight = m.columns.reduce((a, c) => a + c.width, 0);
  // Cell padding (4 + 4) and the cell border come on top of a column's width, so take them off its share of the page.
  const widths = m.columns.map((c) => Math.max(20, (c.width / totalWeight) * usable - 8.5));
  const fs = m.page.fontSize;
  const idx = (k: string) => m.columns.findIndex((c) => c.key === k);
  const nonTaxIdx = idx('nonTaxable');
  const amountIdx = idx('amount') >= 0 ? idx('amount') : m.columns.length - 1;
  // Totals: the label sits in the column before the first value column (RATE); values go under Non Taxable / Amount.
  const valueStart = Math.min(...[nonTaxIdx, amountIdx].filter((i) => i >= 0));
  const labelIdx = Math.max(1, valueStart - 1);
  const n = m.columns.length;

  const body: TableCell[][] = [m.columns.map((c) => ({ text: c.label, style: 'th' }))];
  for (const r of m.rows) {
    // A duty heading row (it carries the serial number) is printed in bold.
    const heading = r.cells[0]?.v !== '' && r.kind === 'data';
    body.push(r.cells.map((c) => ({ text: c.v, alignment: c.align, bold: heading || r.kind !== 'data', noWrap: c.fmt === 'money' })));
  }
  for (const s of m.summary) {
    const target = s.column === 'nonTaxable' && nonTaxIdx >= 0 ? nonTaxIdx : amountIdx;
    const row: TableCell[] = [];
    for (let i = 0; i < n; i++) {
      if (i === 0) row.push(s.strong && m.brandLabel
        ? { text: m.brandLabel, colSpan: labelIdx, bold: true, fontSize: fs + 2, color: BRAND_RED, margin: [0, 2, 0, 2] }
        : { text: '', colSpan: labelIdx });
      else if (i < labelIdx) row.push({});
      else if (i === labelIdx) row.push({ text: s.label, alignment: 'right', bold: true });
      else row.push({ text: i === target ? s.value : '', alignment: 'right', bold: true, noWrap: true });
    }
    body.push(row);
  }

  const left = m.box?.left ?? [];
  const right = m.box?.right ?? [];
  return {
    pageSize: m.page.size,
    pageOrientation: m.page.orientation,
    pageMargins: m.page.margins,
    defaultStyle: { font: 'Roboto', fontSize: fs },
    info: { title: m.box?.left[1]?.text ?? m.title, creator: 'LR Billing' },
    footer: (current: number, count: number) => ({ text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#555', margin: [0, 8, m.page.margins[2], 0] }),
    content: [
      {
        table: {
          widths: ['*', Math.round(usable * 0.38) - 17],
          body: [[
            { stack: left.map((l) => ({ text: l.text, bold: !!l.bold, fontSize: l.size ?? fs, margin: [0, 0, 0, 2] as [number, number, number, number] })) },
            { stack: right.map((t) => ({ text: t, fontSize: fs, margin: [0, 0, 0, 3] as [number, number, number, number] })) },
          ]],
        },
        // One outer box, no divider between the two halves.
        layout: { hLineWidth: () => 1, vLineWidth: (i: number) => (i === 0 || i === 2 ? 1 : 0), hLineColor: () => '#000', vLineColor: () => '#000', paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 8, paddingBottom: () => 8 },
        margin: [0, 0, 0, 10],
      },
      {
        table: { headerRows: 1, dontBreakRows: true, widths, body },
        layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#000', vLineColor: () => '#000', paddingLeft: () => 4, paddingRight: () => 4, paddingTop: () => 3, paddingBottom: () => 3 },
      },
    ],
    styles: { th: { bold: true, alignment: 'center', fillColor: '#ededed' } },
  };
}

export function buildPdfDefinition(m: RenderModel): TDocumentDefinitions {
  if (m.letterhead === 'box') return buildBoxPdfDefinition(m);
  const [w, h] = PAGE_WIDTH[m.page.size];
  const pageW = m.page.orientation === 'landscape' ? h : w;
  const usable = pageW - m.page.margins[0] - m.page.margins[2];
  const totalWeight = m.columns.reduce((a, c) => a + c.width, 0);
  const widths = m.columns.map((c) => Math.max(18, (c.width / totalWeight) * usable - 4));
  const fs = m.page.fontSize;

  const hasGroups = m.columns.some((c) => c.group);
  const headerRows: TableCell[][] = [];
  if (hasGroups) {
    const top: TableCell[] = [];
    const bottom: TableCell[] = [];
    let i = 0;
    while (i < m.columns.length) {
      const g = m.columns[i].group;
      let j = i;
      while (g && j + 1 < m.columns.length && m.columns[j + 1].group === g) j++;
      if (g) {
        top.push({ text: g, colSpan: j - i + 1, style: 'th' });
        for (let k = i + 1; k <= j; k++) top.push({});
        for (let k = i; k <= j; k++) bottom.push({ text: m.columns[k].label, style: 'th' });
      } else {
        top.push({ text: m.columns[i].label, rowSpan: 2, style: 'th' });
        bottom.push({});
      }
      i = j + 1;
    }
    headerRows.push(top, bottom);
  } else {
    headerRows.push(m.columns.map((c) => ({ text: c.label, style: 'th' })));
  }
  const body: TableCell[][] = [
    ...headerRows,
    ...m.rows.map((r) => {
      const cells: TableCell[] = r.cells.map((c) => ({ text: c.v, alignment: c.align, bold: r.kind !== 'data', fillColor: r.kind === 'data' ? undefined : '#f2f2f2', noWrap: c.fmt === 'money' }));
      if (r.kind !== 'data') {
        // Let the TOTAL / Subtotal label span the empty leading cells.
        const idx = r.cells.findIndex((c, i) => i > 0 && c.v !== '');
        const width = idx === -1 ? r.cells.length : idx;
        if (width > 1) cells[0] = { ...(cells[0] as object), colSpan: width, alignment: 'left' } as TableCell;
      }
      return cells;
    }),
  ];

  const header: Content[] = [
    { text: m.title, style: 'title' },
    {
      columns: [
        { width: '*', stack: m.supplierBlock.map((t, i) => ({ text: t, bold: i === 0, fontSize: i === 0 ? fs + 3 : fs })) },
        { width: '*', stack: m.clientBlock.map((t, i) => ({ text: t, bold: i <= 1, fontSize: fs })) },
      ],
      columnGap: 20,
      margin: [0, 6, 0, 6],
    },
    {
      table: { widths: ['*', '*'], body: chunk(m.headerFields.map((f) => ({ text: [{ text: labelSep(f.label), bold: true }, f.value], fontSize: fs })), 2) },
      layout: 'noBorders',
      margin: [0, 0, 0, 6],
    },
  ];

  const summary: Content = {
    unbreakable: true,
    margin: [0, 8, 0, 0],
    stack: [
      ...(m.summary.length === 0 ? [] : [{
        columns: [
          { width: '*', text: '' },
          {
            width: Math.min(320, usable * 0.5),
            table: {
              widths: ['*', 90],
              body: m.summary.map((s) => [
                { text: s.label, alignment: 'right', bold: !!s.strong, fontSize: fs + 1 },
                { text: s.value, alignment: 'right', bold: !!s.strong, fontSize: fs + 1, noWrap: true },
              ]),
            },
          },
        ],
      } as Content]),
      ...(m.amountInWords ? [{ text: `Amount in words: ${m.amountInWords}`, italics: true, margin: [0, 6, 0, 0] as [number, number, number, number], fontSize: fs + 1 }] : []),
      ...m.notes.map((n) => ({ text: n, fontSize: fs, margin: [0, 3, 0, 0] as [number, number, number, number] })),
      ...(m.declaration ? [{ text: m.declaration, fontSize: fs, margin: [0, 6, 0, 0] as [number, number, number, number] }] : []),
      {
        columns: m.signatures.map((s, i) => ({ text: s, bold: true, alignment: (i === 0 ? 'left' : 'right') as 'left' | 'right', fontSize: fs + 1 })),
        margin: [0, 36, 0, 0],
      },
    ],
  };

  return {
    pageSize: m.page.size,
    pageOrientation: m.page.orientation,
    pageMargins: m.page.margins,
    defaultStyle: { font: 'Roboto', fontSize: fs },
    info: { title: m.title, creator: 'LR Billing' },
    footer: (current: number, count: number) => ({ text: `Page ${current} of ${count}`, alignment: 'right', fontSize: 7, color: '#555', margin: [0, 8, m.page.margins[2], 0] }),
    content: [
      ...header,
      {
        table: { headerRows: headerRows.length, dontBreakRows: true, widths, body },
        layout: { hLineWidth: () => 0.5, vLineWidth: () => 0.5, hLineColor: () => '#555', vLineColor: () => '#555', paddingLeft: () => 2, paddingRight: () => 2, paddingTop: () => 2, paddingBottom: () => 2 },
      },
      summary,
    ],
    styles: {
      title: { fontSize: fs + 6, bold: true, alignment: 'center' },
      th: { bold: true, alignment: 'center', fillColor: '#ededed' },
    },
  };
}

function chunk<T>(xs: T[], n: number): (T | string)[][] {
  const out: (T | string)[][] = [];
  for (let i = 0; i < xs.length; i += n) {
    const row: (T | string)[] = xs.slice(i, i + n);
    while (row.length < n) row.push('');
    out.push(row);
  }
  return out.length ? out : [['', '']];
}

export function renderPdf(m: RenderModel): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = getPrinter().createPdfKitDocument(buildPdfDefinition(m));
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    doc.end();
  });
}
