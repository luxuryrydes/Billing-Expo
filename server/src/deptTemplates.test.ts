/** Department bill workbooks: read, matched to the department record, filled in, and turned into an LR Standard template. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-dt-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');
const { parseDeptWorkbook } = await import('./services/deptTemplates.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
let token = '';

async function sheet(lines: string[], gstin: string) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('LR-2608-0001');
  lines.forEach((t, i) => { ws.getCell(`A${i + 1}`).value = t; });
  ws.getCell(`A${lines.length + 1}`).value = `CLIENT GSTIN : ${gstin}`;
  ws.getCell('F1').value = 'SAC :- 996601'; ws.getCell('F2').value = 'PAN NO :- AAGFL5356A'; ws.getCell('F3').value = 'GSTIN : 07AAGFL5356A1ZK';
  ws.getCell('A7').value = 'S.No.'; ws.getCell('D7').value = 'DESCRIPTION';
  ws.getCell('D8').value = 'Duty for ( Ciaz )'; ws.getCell('D9').value = 'Upto : 80kms/8hrs'; ws.getCell('E9').value = 1; ws.getCell('F9').value = 2400;
  return Buffer.from(await wb.xlsx.writeBuffer());
}
async function send(files: { name: string; buf: Buffer }[], fields: Record<string, string>) {
  const b = '----dt';
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  for (const f of files) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  const res = await app.inject({ method: 'POST', url: '/api/templates/department-import', payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}`, authorization: `Bearer ${token}` } });
  if (res.statusCode !== 200) throw new Error(`${res.statusCode}: ${res.body.slice(0, 300)}`);
  return res.json();
}

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  token = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  await app.inject({ method: 'POST', url: '/api/suppliers', payload: { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true }, headers: { authorization: `Bearer ${token}` } });
  await app.inject({ method: 'POST', url: '/api/clients', payload: { name: 'AIRPORTS AUTHORITY OF INDIA (AAI)', short_code: 'AAI', billing_address: '' }, headers: { authorization: `Bearer ${token}` } });
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('reading a department workbook', () => {
  it('tells our own company line from the department lines, and joins a PIN code to its address', async () => {
    const a = await parseDeptWorkbook(await sheet(['TOTAL TRANSPORT SOLUTION AND CONCEPT', 'Department of Telecommunication(Dot)', 'Ministry Of Communication', 'Room No -501, Sanchar Bhawan, New Delhi - 110001'], '07DELD08484A1DR'), 'DOT.xlsx', []);
    expect(a).toMatchObject({ title: null, clientLine: 'Department of Telecommunication(Dot)', subtitle: 'Ministry Of Communication', clientGstin: '07DELD08484A1DR', sac: '996601', supplierPan: 'AAGFL5356A' });
    const b = await parseDeptWorkbook(await sheet(['M/s SP CBI', 'CBI', 'EOIII 4th Floor CGO Complex', '110003'], ''), 'CBI_TEMPLATE.xlsx', ['LR Taxi Services Pvt. Ltd.']);
    expect(b).toMatchObject({ title: 'M/s SP CBI', clientLine: 'CBI', address: 'EOIII 4th Floor CGO Complex 110003' });
    const u = await parseDeptWorkbook(await sheet(['LR Taxi Services', 'UNION PUBLIC SERVICE COMMISSION', 'SHAHJAHAN ROAD, NEW DELHI'], '07AAGFL5356A1ZK'), 'UPSC.xlsx', ['LR Taxi Services Pvt. Ltd.']);
    expect(u.title).toBeNull();
    expect(a.sample[0]).toMatchObject({ vehicle: 'Ciaz', base: '2400' });
  });
});

describe('importing department workbooks', () => {
  const files = async () => [
    { name: 'AAI.xlsx', buf: await sheet(['TOTAL TRANSPORT SOLUTION AND CONCEPT', 'Airports Authority Of India(AAI)', 'Central E&M Workshop, Safdarjung Airport, New Delhi , 110003'], '07AAACA6412D2Z9') },
    { name: 'KINETIC_GROUP_TEMPLATE.xlsx', buf: await sheet(['KINETIC GROUP', 'KINETIC GROUP', 'PLOT NO.18/2, D-1 BLOCK, PUNE'], '27AAECK4013G1ZV') },
  ];
  it('previews: a matching department is found and the blank details are offered, an unknown one is left to choose', async () => {
    const r = await send(await files(), { mode: 'preview' });
    expect(r.results[0].matched.name).toBe('AIRPORTS AUTHORITY OF INDIA (AAI)');
    expect(r.results[0].changes.map((c: any) => c.field).sort()).toEqual(['Address', 'GSTIN']);
    expect(r.results[1].matched).toBeNull();
    expect(r.results[1].newShortCode).toBe('KINETICGROUP');
  });
  it('applies: fills the department, creates an LR Standard template awaiting approval, and repeating it creates nothing twice', async () => {
    const choices = { 'AAI.xlsx': { updateDetails: true }, 'KINETIC_GROUP_TEMPLATE.xlsx': { clientId: 'new' } };
    const r = await send(await files(), { mode: 'apply', choices: JSON.stringify(choices) });
    expect(r.results.map((x: any) => x.error ?? x.skipped ?? 'ok')).toEqual(['ok', 'ok']);
    const aai = await db.one<Record<string, any>>(`SELECT billing_address, gstin FROM clients WHERE short_code = 'AAI'`);
    expect(aai).toMatchObject({ billing_address: 'Central E&M Workshop, Safdarjung Airport, New Delhi , 110003', gstin: '07AAACA6412D2Z9' });
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM clients WHERE short_code = 'KINETICGROUP'`))!.n).toBe(1);
    const v = await db.query<{ status: string; layout: any; reference_file_id: string | null }>('SELECT v.status, v.layout, v.reference_file_id FROM billing_template_versions v JOIN billing_templates t ON t.id = v.template_id');
    expect(v).toHaveLength(2);
    expect(v.every((x) => x.status === 'draft' && x.layout.letterhead === 'box' && !!x.reference_file_id)).toBe(true);   // LR Standard, a draft until approved
    const kid = (await db.one<{ id: string }>(`SELECT id FROM clients WHERE short_code = 'KINETICGROUP'`))!.id;
    const again = await send(await files(), { mode: 'apply', choices: JSON.stringify({ 'AAI.xlsx': { updateDetails: true }, 'KINETIC_GROUP_TEMPLATE.xlsx': { clientId: kid } }) });
    expect(again.results.every((x: any) => /already exists/.test(x.skipped))).toBe(true);
    expect((await db.one<{ n: number }>('SELECT count(*)::int AS n FROM billing_templates'))!.n).toBe(2);
  });
});
