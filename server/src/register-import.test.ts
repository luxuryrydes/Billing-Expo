/**
 * The Department & Rate Register workbook (kept out of git in fixtures/master/): first import,
 * re-importing the same sheet, a changed copy, export → re-import, the per-department rate card,
 * and re-importing a duty sheet. Uploading the same data twice must never duplicate or change anything.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const REGISTER = path.resolve(here, '../fixtures/master/LR_Taxi_Services_Department_Rate_Register.xlsx');
const present = fs.existsSync(REGISTER);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-register-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

let app: any;
let db: any;
let token = '';
const OPTS = { newRatesFrom: '2026-04-01', changesFrom: '2026-10-25', approve: true };

async function call(method: string, url: string, body?: unknown, expectStatus = 200) {
  const res = await app.inject({ method, url: `/api${url}`, payload: body, headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 1500)}`);
  return res.headers['content-type']?.includes('json') ? res.json() : res;
}
async function upload(url: string, name: string, buf: Buffer, expectStatus = 200) {
  const boundary = '----rr' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
  if (res.statusCode !== expectStatus) throw new Error(`upload ${url} → ${res.statusCode}: ${res.body.slice(0, 1500)}`);
  return res.json();
}
/** Uploads the register and re-analyses it with fixed dates so the test does not depend on today. */
async function preview(buf: Buffer, name = 'register.xlsx') {
  const u = await upload('/imports/register/upload', name, buf);
  return { fileId: u.fileId, ...(await call('POST', '/imports/register/analyze', { fileId: u.fileId, options: OPTS })) };
}
const commit = (fileId: string, skipInvalid = false) => call('POST', '/imports/register/commit', { fileId, options: OPTS, skipInvalid });
const clientId = async (like: string) => (await db.one(`SELECT id FROM clients WHERE name ILIKE $1`, [like])).id as string;
const card = (id: string, date: string) => call('GET', `/clients/${id}/rate-card?date=${date}`);

async function editedRegister(edit: (rates: ExcelJS.Worksheet, master: ExcelJS.Worksheet) => void): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(REGISTER);
  edit(wb.getWorksheet('Department Rate Register')!, wb.getWorksheet('Department Master')!);
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const rowWhere = (ws: ExcelJS.Worksheet, col: number, text: string, col2?: number, text2?: string) => {
  let found: ExcelJS.Row | null = null;
  ws.eachRow((r) => { if (!found && r.getCell(col).text === text && (col2 === undefined || r.getCell(col2).text === text2)) found = r; });
  if (!found) throw new Error(`No row with "${text}"`);
  return found as ExcelJS.Row;
};

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
  token = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe.skipIf(!present)('Department & Rate Register', () => {
  it('first import adds every department and rate, with nothing written by the preview', async () => {
    const p = await preview(fs.readFileSync(REGISTER));
    expect(p.sheets).toMatchObject({ master: 'Department Master', rates: 'Department Rate Register' });
    expect(p.summary.departments).toMatchObject({ rows: 24, add: 24, update: 0, errors: 0 });
    expect(p.summary.rates.add).toBeGreaterThanOrEqual(80);
    expect((await db.one(`SELECT count(*)::int AS n FROM clients`)).n).toBe(0);
    const c = await commit(p.fileId, p.summary.rates.errors > 0);
    expect(c.departmentsAdded).toBe(24);
    expect(c.ratesAdded).toBe(p.summary.rates.add);
  });

  it('shows a department rate card like the Rate Card screen', async () => {
    const crri = await card(await clientId('%CRRI%'), '2026-10-24');
    expect(crri.rates).toHaveLength(1);
    expect(crri.rates[0].entry).toMatchObject({ vehicle: 'Dzire', rateType: 'per_km_hr' });
    expect(crri.rates[0].taxShown).toBe('C 2.5% + S 2.5%');
    // DRI: "GST 18%" billed from the HR registration to a Delhi department → IGST, not guessed halves
    const dri = await card(await clientId('%(DRI)%'), '2026-10-24');
    expect(dri.rates.length).toBe(6);
    for (const r of dri.rates) expect(r.taxShown).toMatch(/IGST 18|—/);
  });

  it('re-importing the same register changes nothing', async () => {
    const before = (await db.one(`SELECT count(*)::int AS n FROM rate_scheme_versions`)).n;
    const p = await preview(fs.readFileSync(REGISTER));
    expect(p.summary.departments).toMatchObject({ add: 0, update: 0, unchanged: 24 });
    expect(p.summary.rates).toMatchObject({ add: 0, update: 0 });
    expect(p.summary.taxChanges).toBe(0);
    await commit(p.fileId, true);
    expect((await db.one(`SELECT count(*)::int AS n FROM rate_scheme_versions`)).n).toBe(before);
    expect((await db.one(`SELECT count(*)::int AS n FROM clients`)).n).toBe(24);
  });

  it('a changed copy updates only the changed department and rate; earlier duties keep the old rate', async () => {
    const buf = await editedRegister((rates, master) => {
      const r = rowWhere(rates, 2, 'CENTRAL ROAD RESEARCH INSTITUTE (CRRI)');
      r.getCell(7).value = Number(r.getCell(7).value) + 100;
      rowWhere(master, 2, 'KINETIC GROUP').getCell(5).value = 'MONTHLY';
      rates.spliceRows(rowWhere(rates, 2, 'TELECOM REGULATORY AUTHORITY OF INDIA (TRAI)').number, 1); // missing from the sheet → kept
    });
    const crriId = await clientId('%CRRI%');
    const old = (await card(crriId, '2026-10-24')).rates[0].entry.baseFare;
    const p = await preview(buf);
    expect(p.summary.departments).toMatchObject({ add: 0, update: 1 });
    expect(p.summary.rates).toMatchObject({ add: 0, update: 1 });
    expect(p.departments.find((d: any) => d.action === 'update').changes.billing_pattern.to).toBe('MONTHLY');
    await commit(p.fileId, true);
    expect(Number((await card(crriId, '2026-10-24')).rates[0].entry.baseFare)).toBe(Number(old));
    expect(Number((await card(crriId, '2026-10-26')).rates[0].entry.baseFare)).toBe(Number(old) + 100);
    expect((await card(await clientId('%TRAI%'), '2026-10-26')).rates.length).toBe(3);
  });

  it('the exported register re-imports with no changes', async () => {
    const res = await call('GET', '/imports/register/export.xlsx?date=2026-10-26');
    const buf = res.rawPayload as Buffer;
    const p = await preview(buf, 'exported.xlsx');
    const changed = [...p.departments, ...p.rates].filter((x: any) => x.action === 'add' || x.action === 'update');
    expect(changed.map((x: any) => `${x.name ?? x.department} ${x.vehicle ?? ''} ${JSON.stringify(x.changes)}`)).toEqual([]);
    expect(p.summary.taxChanges).toBe(0);
  });

  it('adds and changes a rate from the Rate Card screen as new versions', async () => {
    const id = await clientId('%CRRI%');
    const entry = { vehicle: 'Innova Crysta', package: '8hr/80km', rateType: 'per_km_hr', baseFare: '3200', includedKm: '80', includedHours: '8', extraKm: '22', extraHour: '250', nightCharge: '300', nightStart: '22:00', nightEnd: '06:00', driverAllowance: '', taxMode: 'CGST_SGST', cgst: '2.5', sgst: '2.5' };
    await call('POST', `/clients/${id}/rate-card`, { entry, effectiveFrom: '2026-10-01', approve: true });
    let c = await card(id, '2026-10-26');
    const row = c.rates.find((r: any) => r.entry.package === '8hr/80km' && /Crysta/i.test(r.entry.vehicle));
    expect(row.entry).toMatchObject({ baseFare: '3200', nightStart: '22:00' });
    // Same date as the version in force → refused, so earlier duties keep their rate
    await call('POST', `/clients/${id}/rate-card`, { entry: { ...entry, baseFare: '3300' }, schemeId: row.schemeId, effectiveFrom: '2026-10-01', approve: true }, 400);
    await call('POST', `/clients/${id}/rate-card`, { entry: { ...entry, baseFare: '3300' }, schemeId: row.schemeId, effectiveFrom: '2026-11-01', approve: true });
    c = await card(id, '2026-11-02');
    expect(c.rates.find((r: any) => r.schemeId === row.schemeId).entry.baseFare).toBe('3300');
    expect((await card(id, '2026-10-26')).rates.find((r: any) => r.schemeId === row.schemeId).entry.baseFare).toBe('3200');
    // Stopping a rate ends it; history stays
    await call('POST', `/clients/${id}/rate-card/${row.schemeId}/end`, { lastDay: '2026-11-30' });
    expect((await card(id, '2026-12-05')).rates.find((r: any) => r.schemeId === row.schemeId)).toBeUndefined();
    expect((await card(id, '2026-11-15')).rates.find((r: any) => r.schemeId === row.schemeId)).toBeTruthy();
  });

  it('re-importing a duty sheet adds only new duties and updates changed ones', async () => {
    const id = await clientId('%CRRI%');
    const contractId = (await card(id, '2026-10-26')).contract.id;
    const sheet = (rows: string[][]) => Buffer.from(['Date,Vehicle Type,Vehicle No,Driver,Starting Km,Closing Km,Starting Time,Closing Time', ...rows.map((r) => r.join(','))].join('\r\n'));
    const base = [['26/10/2026', 'Dzire', 'DL1CA1234', 'Ram', '1000', '1080', '09:00', '17:00'], ['27/10/2026', 'Dzire', 'DL1CA1234', 'Ram', '1080', '1150', '09:00', '18:00']];
    const run = async (buf: Buffer) => {
      const p = await upload('/duties/import/preview', 'duties.csv', buf);
      return call('POST', '/duties/import/commit', { fileId: p.fileId, contractId, mapping: p.mapping });
    };
    expect(await run(sheet(base))).toMatchObject({ added: 2, updated: 0, unchanged: 0 });
    expect(await run(sheet(base))).toMatchObject({ added: 0, updated: 0, unchanged: 2 });
    const changed = [base[0]!, ['27/10/2026', 'Dzire', 'DL1CA1234', 'Ram', '1080', '1160', '09:00', '18:00'], ['28/10/2026', 'Dzire', 'DL1CA1234', 'Ram', '1160', '1200', '09:00', '13:00']];
    const r = await run(sheet(changed));
    expect(r).toMatchObject({ added: 1, updated: 1, unchanged: 1 });
    expect(r.results.find((x: any) => x.action === 'update').changes).toEqual([{ field: 'endKm', from: '1150', to: '1160' }]);
    expect((await db.one(`SELECT count(*)::int AS n FROM duties WHERE contract_id = $1`, [contractId])).n).toBe(3);
  });
});
