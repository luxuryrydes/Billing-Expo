/**
 * Master-data and rate-card imports through the real upload workflow, using the
 * supplied departments/institutions workbooks (kept out of git in fixtures/master/),
 * plus document replace/restore and sample-bill template import.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const MASTER = path.resolve(here, '../fixtures/master');
const DRI = path.resolve(here, '../fixtures/dri');
const DEPTS = path.join(MASTER, 'departments-2026-10-24.xlsx');
const INSTS = path.join(MASTER, 'institutions-2026-10-24.xlsx');
const present = fs.existsSync(DEPTS) && fs.existsSync(INSTS);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-master-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

let app: any;
let db: any;
const tok: Record<string, string> = {};

async function call(method: string, url: string, body?: unknown, expectStatus = 200, who = 'admin') {
  const res = await app.inject({ method, url: `/api${url}`, payload: body, headers: { authorization: `Bearer ${tok[who]}` } });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 1200)}`);
  return res.headers['content-type']?.includes('json') ? res.json() : res;
}
async function upload(url: string, name: string, buf: Buffer, fields: Record<string, string> = {}, expectStatus = 200) {
  const boundary = '----mi' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`));
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${tok.admin}` } });
  if (res.statusCode !== expectStatus) throw new Error(`upload ${url} → ${res.statusCode}: ${res.body.slice(0, 1200)}`);
  return res.json();
}

/** Copies a workbook and edits it, the way a user would before re-importing. */
async function edited(file: string, edit: (ws: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  edit(wb.worksheets[0]);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const rowOf = (ws: ExcelJS.Worksheet, firstCell: string) => { let n = 0; ws.eachRow((r, i) => { if (r.getCell(1).text === firstCell) n = i; }); return ws.getRow(n); };

beforeAll(async () => {
  const { createDb } = await import('./db/index.js');
  const { migrate } = await import('./db/migrate.js');
  const { seedReferenceData } = await import('./db/seed.js');
  const { buildApp } = await import('./app.js');
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  // Test-only credentials for the in-memory database.
  tok.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!present)('department and institution Excel import', () => {
  it('previews the departments file with detected columns and row actions', async () => {
    const p = await upload('/imports/departments/upload', 'departments-2026-10-24.xlsx', fs.readFileSync(DEPTS));
    expect(p.sheet).toBe('departments');
    expect(p.headers).toEqual(['Name', 'Aliases', 'Invoice Prefix', 'Default Package', 'GST', 'Company', 'Client Address', 'Client GSTIN', 'Notes']);
    expect(Object.keys(p.mapping).sort()).toEqual(['aliases', 'billing_address', 'company', 'default_package', 'gst_label', 'gstin', 'invoice_prefix', 'name', 'notes'].sort());
    expect(p.summary).toMatchObject({ rows: 19, add: 19, update: 0, errors: 0 });
    const dri = p.results.find((r: any) => r.key === 'DRI');
    expect(dri.warnings.join(' ')).toMatch(/IGST or CGST/); // "18% GST" is ambiguous — flagged, not guessed
    const aai = p.results.find((r: any) => r.key === 'AAI');
    expect(aai.values).toMatchObject({ cgst_rate: '2.5', sgst_rate: '2.5', igst_rate: '0', gstin: '07AAACA6412D2Z9', state_name: 'Delhi' });
    // Nothing was written by the preview
    expect((await db.one(`SELECT count(*)::int AS n FROM clients`)).n).toBe(0);
    const c = await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping });
    expect(c).toMatchObject({ added: 19, updated: 0 });
  });

  it('re-importing the same file changes nothing and creates no duplicates', async () => {
    const p = await upload('/imports/departments/upload', 'departments-2026-10-24.xlsx', fs.readFileSync(DEPTS));
    expect(p.summary).toMatchObject({ add: 0, update: 0, unchanged: 19 });
    await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping });
    expect((await db.one(`SELECT count(*)::int AS n FROM clients WHERE kind = 'department'`)).n).toBe(19);
  });

  it('a modified file updates matching departments and adds new ones; missing rows are kept', async () => {
    const buf = await edited(DEPTS, (ws) => {
      rowOf(ws, 'AAI').getCell(7).value = 'Central E&M Workshop, Safdarjung Airport, New Delhi 110003 (updated)';
      rowOf(ws, 'MOH').getCell(5).value = '18% IGST';
      ws.spliceRows(rowOf(ws, 'YEIDA').number, 1); // removed from the file — must stay in the system
      ws.addRow(['NEWDEPT', 'ND', 'LRTS/26-27', '', 'Split 2.5+2.5%', 'NEW DEPT', 'New Delhi', '07AAACN0255D1ZO', 'added by test']);
    });
    const p = await upload('/imports/departments/upload', 'departments-edited.xlsx', buf);
    expect(p.summary).toMatchObject({ add: 1, update: 2, errors: 0 });
    const moh = p.results.find((r: any) => r.key === 'MOH');
    expect(moh.changes.igst_rate).toEqual({ from: '0.0000', to: '18' });
    await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping });
    expect((await db.one(`SELECT count(*)::int AS n FROM clients WHERE kind = 'department'`)).n).toBe(20);
    expect((await db.one(`SELECT billing_address FROM clients WHERE name = 'AAI'`)).billing_address).toMatch(/updated/);
    expect(await db.one(`SELECT id FROM clients WHERE name = 'YEIDA'`)).toBeTruthy();
  });

  it('refuses a file with invalid rows unless the user imports only the valid ones, and reports the errors', async () => {
    const buf = await edited(DEPTS, (ws) => {
      ws.addRow(['BADGST', '', '', '', 'Split 2.5+2.5%', 'X', 'Somewhere', '99NOTAGSTIN', '']);
      ws.addRow(['', 'no name', '', '', '', '', '', '', '']);
      ws.addRow(['ANOTHER', '', '', '', '', 'Y', 'Delhi', '', '']);
    });
    const p = await upload('/imports/departments/upload', 'departments-bad.xlsx', buf);
    expect(p.summary.errors).toBe(2);
    const bad = p.results.find((r: any) => r.key === 'BADGST');
    expect(bad.errors.join(' ')).toMatch(/not a valid GSTIN/);
    await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping }, 409);
    expect(await db.one(`SELECT id FROM clients WHERE name = 'ANOTHER'`)).toBeNull(); // all-or-nothing
    const c = await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping, skipInvalid: true });
    expect(c).toMatchObject({ added: 1, skipped: 2 });
    const report = await call('GET', `/imports/runs/${c.runId}/report.csv`);
    expect(report.body).toMatch(/BADGST.*not a valid GSTIN/);
  });

  it('keeps extra columns instead of discarding them', async () => {
    const buf = await edited(DEPTS, (ws) => { ws.getRow(1).getCell(10).value = 'Billing Contact'; rowOf(ws, 'ECI').getCell(10).value = 'Section Officer, Transport'; });
    const p = await upload('/imports/departments/upload', 'departments-extra.xlsx', buf);
    expect(p.unmapped).toContain(9);
    await call('POST', '/imports/departments/commit', { fileId: p.fileId, mapping: p.mapping, extras: p.extras });
    expect((await db.one(`SELECT extra FROM clients WHERE name = 'ECI'`)).extra).toEqual({ 'Billing Contact': 'Section Officer, Transport' });
  });

  it('imports institutions with tax settings, invoice prefix and custom fields', async () => {
    const p = await upload('/imports/institutions/upload', 'institutions-2026-10-24.xlsx', fs.readFileSync(INSTS));
    expect(p.summary).toMatchObject({ rows: 6, add: 6, errors: 0 });
    await call('POST', '/imports/institutions/commit', { fileId: p.fileId, mapping: p.mapping });
    const crri = await db.one(`SELECT * FROM clients WHERE kind = 'institution' AND code = 'crri'`);
    expect(crri).toMatchObject({ name: 'CRRI (Central Road Research Institute)', invoice_prefix: 'LRTS/26-27', gst_mode: 'include', cgst_rate: '2.5000', sgst_rate: '2.5000', vendor_sac: '996601', vendor_gstin: '07AAGFL5356A1ZK', gstin: '07AAATC2716R1ZH' });
    expect(crri.duty_fields).toEqual(['User Name', 'Division', 'Project Code', 'Scheme No.']);
    expect((await db.one(`SELECT igst_rate FROM clients WHERE code = 'mhrd'`)).igst_rate).toBe('18.0000');
    const again = await upload('/imports/institutions/upload', 'institutions-2026-10-24.xlsx', fs.readFileSync(INSTS));
    expect(again.summary).toMatchObject({ add: 0, unchanged: 6 });
  });

  it('manual entry uses the same rules and refuses duplicates', async () => {
    await call('POST', '/master/departments', { name: 'aai', gst_label: 'Split 2.5+2.5%' }, 409);
    await call('POST', '/master/institutions', { code: 'iitd', name: 'IIT Delhi', gstin: 'BAD' }, 400);
    const r = await call('POST', '/master/institutions', { code: 'IITD', name: 'IIT Delhi', igst_rate: '18', duty_fields: 'User Name, Lab' });
    expect(r).toMatchObject({ code: 'iitd', kind: 'institution', duty_fields: ['User Name', 'Lab'] });
    const u = await call('PUT', `/master/institutions/${r.id}`, { code: 'iitd', name: 'IIT Delhi', invoice_prefix: 'LRTS/26-27' });
    expect(u.invoice_prefix).toBe('LRTS/26-27');
    const exp = await call('GET', '/imports/institutions/export.xlsx');
    expect(exp.rawPayload.length).toBeGreaterThan(1000);
  });
});

describe('rate-card import', () => {
  const ctx: Record<string, string> = {};
  const rateBook = async (rows: (string | number)[][]) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Rates');
    ws.addRow(['Vehicle Type', 'Package', 'Hours', 'KM', 'Daily Rate', 'Extra KM', 'Extra Hour', 'Night Charge']);
    rows.forEach((r) => ws.addRow(r));
    return Buffer.from(await wb.xlsx.writeBuffer());
  };

  it('maps a rate sheet, compares with current rates and keeps history', async () => {
    const client = await call('POST', '/master/departments', { name: 'RATE TEST' });
    ctx.contract = (await call('POST', '/contracts', { client_id: client.id, title: 'Test', reference_no: 'RT/1', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' })).id;
    await call('POST', '/vehicle-categories', { name: 'SUV AC', aliases: ['Innova', 'Ertiga'] });
    const p = await upload('/imports/rate_card/upload', 'rates.xlsx', await rateBook([['Innova', '', 8, 80, 3200, 28, 250, 350], ['Innova', '', 4, 40, 2200, 28, 250, 350], ['Dzire', '', 8, 80, 2600, 20, 150, 350]]), { contract_id: ctx.contract });
    expect(p.mapping).toMatchObject({ category: 0, dutyType: 1, hours: 2, km: 3, packageRate: 4, extraKm: 5, extraHour: 6, night: 7 });
    expect(p.summary).toMatchObject({ rows: 3, add: 3, errors: 0 });
    expect(p.results.map((r: any) => r.dutyTypeCode)).toEqual(['LOCAL', 'LOCAL_4H', 'LOCAL']);
    expect(p.results[2].newCategory).toBe(true);
    const c = await call('POST', '/imports/rate_card/commit', { fileId: p.fileId, mapping: p.mapping, contractId: ctx.contract, options: { effectiveFrom: '2026-04-01' } });
    expect(c.created).toHaveLength(3);
    // Drafts only: approve them as an approver would
    for (const v of c.created) { await call('POST', `/rate-versions/${v.versionId}/submit`); await call('POST', `/rate-versions/${v.versionId}/approve`); }

    // Re-upload with one changed rate: compare existing vs incoming; same effective date is refused
    const buf2 = await rateBook([['Innova', '', 8, 80, 3400, 28, 250, 350], ['Innova', '', 4, 40, 2200, 28, 250, 350], ['Dzire', '', 8, 80, 2600, 20, 150, 350]]);
    const p2 = await upload('/imports/rate_card/upload', 'rates-v2.xlsx', buf2, { contract_id: ctx.contract });
    const same = await call('POST', '/imports/rate_card/analyze', { fileId: p2.fileId, mapping: p2.mapping, contractId: ctx.contract, options: { effectiveFrom: '2026-04-01' } });
    const innova = same.results[0];
    expect(innova.action).toBe('error');
    expect(innova.errors.join(' ')).toMatch(/later effective date/);
    expect(same.results[1].action).toBe('unchanged');
    const a = await call('POST', '/imports/rate_card/analyze', { fileId: p2.fileId, mapping: p2.mapping, contractId: ctx.contract, options: { effectiveFrom: '2026-10-01' } });
    expect(a.results[0]).toMatchObject({ action: 'update', changes: { packageRate: { from: '3200', to: '3400' } } });
    expect(a.summary).toMatchObject({ update: 1, unchanged: 2 });
    const c2 = await call('POST', '/imports/rate_card/commit', { fileId: p2.fileId, mapping: p2.mapping, contractId: ctx.contract, options: { effectiveFrom: '2026-10-01' }, submitForApproval: true });
    expect(c2.created).toHaveLength(1);
    await call('POST', `/rate-versions/${c2.created[0].versionId}/approve`);
    const hist = await db.query(`SELECT v.version_no, v.status, v.effective_from, v.effective_to FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id WHERE s.name LIKE 'SUV AC — Local duty%' ORDER BY v.version_no`);
    expect(hist).toEqual([
      { version_no: 1, status: 'approved', effective_from: '2026-04-01', effective_to: '2026-09-30' }, // old rate kept for earlier duties
      { version_no: 2, status: 'approved', effective_from: '2026-10-01', effective_to: '2027-03-31' },
    ]);
  });

  it.skipIf(!fs.existsSync(path.join(DRI, 'DRI Daily Taxi Contract Rates.pdf')))('reads a PDF rate schedule as a rate card', async () => {
    const client = await call('POST', '/master/departments', { name: 'DRI TEST' });
    const k = (await call('POST', '/contracts', { client_id: client.id, title: 'DRI', reference_no: 'GEMC-X', start_date: '2025-11-06', end_date: '2026-11-05', status: 'active' })).id;
    const p = await upload('/imports/rate_card/upload', 'DRI Daily Taxi Contract Rates.pdf', fs.readFileSync(path.join(DRI, 'DRI Daily Taxi Contract Rates.pdf')), { contract_id: k });
    expect(p.summary).toMatchObject({ rows: 9, add: 9, errors: 0 });
    expect(p.results.find((r: any) => r.dutyTypeCode === 'OUTSTATION' && /SUV/.test(r.category)).incoming).toMatchObject({ packageRate: '3200', extraKm: '28', extraHour: '250', night: '350' });
  }, 60_000);
});

describe('documents and sample bills', () => {
  it('re-uploading a document offers the existing record, adds a version, and can restore an older one', async () => {
    const client = await call('POST', '/master/departments', { name: 'DOC TEST' });
    const other = await call('POST', '/master/departments', { name: 'OTHER DEPT' });
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const v1 = await upload('/documents', 'Rate schedule.pdf', pdf, { client_id: client.id, doc_type: 'rate_schedule', title: 'Rate schedule', run_ai: 'false' });
    const m = await call('POST', '/documents/match', { client_id: client.id, doc_type: 'rate_schedule', file_name: 'Rate schedule.pdf' });
    expect(m.matches).toHaveLength(1);
    expect(m.matches[0]).toMatchObject({ id: v1.document_id, sameName: true });
    // Same file name in another department is not offered
    expect((await call('POST', '/documents/match', { client_id: other.id, doc_type: 'rate_schedule', file_name: 'Rate schedule.pdf' })).matches).toEqual([]);
    const pdf2 = Buffer.from('%PDF-1.4\n% revised\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF');
    const v2 = await upload('/documents', 'Rate schedule.pdf', pdf2, { document_id: v1.document_id, client_id: client.id, note: 'Revised rates', run_ai: 'false' });
    expect(v2.version_no).toBe(2);
    await upload('/documents', 'x.pdf', pdf2, { document_id: v1.document_id, client_id: other.id, run_ai: 'false' }, 400);
    const r = await call('POST', `/document-versions/${v1.id}/restore`);
    expect(r.version_no).toBe(3);
    const doc = await call('GET', `/documents/${v1.document_id}`);
    expect(doc.versions.map((v: any) => v.version_no)).toEqual([3, 2, 1]);
    expect(doc.versions[0].note).toBe('Restored from version 1');
  });

  it.skipIf(!fs.existsSync(path.join(DRI, 'DRI Sep.pdf')))('learns a bill format from a sample PDF and versions it per department', async () => {
    const client = await call('POST', '/master/departments', { name: 'DRI SAMPLE' });
    const pdf = fs.readFileSync(path.join(DRI, 'DRI Sep.pdf'));
    const t = await upload('/templates/from-sample', 'DRI Sep.pdf', pdf, { client_id: client.id, name: 'DRI bill' });
    const v = await call('GET', `/template-versions/${t.versionId}`);
    expect(v.layout.rowMode).toBe('block');
    expect(v.status).toBe('draft');
    expect(v.reference_file_id).toBeTruthy();
    await upload('/templates/from-sample', 'DRI Sep.pdf', pdf, { client_id: client.id, name: 'DRI bill' }, 409);
    const t2 = await upload('/templates/from-sample', 'DRI Sep.pdf', pdf, { client_id: client.id, template_id: t.templateId });
    expect(t2.versionNo).toBe(2);
    const prev = await call('POST', `/template-versions/${t2.versionId}/preview`, { format: 'pdf' });
    expect(prev.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    // Excel sample: the workbook becomes the template with its table mapped
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Bill');
    ws.addRow(['LR TAXI SERVICES']);
    ws.addRow(['Bill No', '', '', 'Date', '']);
    ws.addRow([]);
    ws.addRow(['S.No', 'Date', 'Vehicle No', 'Total KM', 'Amount']);
    const x = await upload('/templates/from-sample', 'sample.xlsx', Buffer.from(await wb.xlsx.writeBuffer()), { client_id: client.id, name: 'Excel format' });
    const xv = await call('GET', `/template-versions/${x.versionId}`);
    expect(xv.xlsx_mapping.table).toMatchObject({ startRow: 5, columns: { A: 0, B: 1, C: 2, D: 3, E: 4 } });
    expect(xv.layout.columns.map((c: any) => c.key)).toEqual(['sno', 'dutyDate', 'vehicleRegNo', 'totalKm', 'dutyTotal']);
    expect(xv.xlsx_mapping.cells).toMatchObject({ B2: '{billNo}', E2: '{billDate}' });
  }, 60_000);
});
