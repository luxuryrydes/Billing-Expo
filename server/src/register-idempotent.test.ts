/**
 * Importing the same register again must change nothing, even while earlier rates and tax rules are still
 * waiting for approval; a changed rate replaces the older unapproved version instead of piling up beside it.
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-idem-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

let app: any;
let db: any;
let token = '';
const OPTS = (approve: boolean) => ({ newRatesFrom: '2026-04-01', changesFrom: '2026-10-28', approve });

async function call(method: string, url: string, body?: unknown) {
  const res = await app.inject({ method, url: `/api${url}`, payload: body, headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 800)}`);
  return res.json();
}
async function upload(buf: Buffer) {
  const boundary = '----id' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="register.xlsx"\r\nContent-Type: application/octet-stream\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: '/api/imports/register/upload', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
  if (res.statusCode !== 200) throw new Error(`upload → ${res.statusCode}: ${res.body.slice(0, 600)}`);
  return res.json();
}
const run = async (buf: Buffer, approve: boolean) => {
  const u = await upload(buf);
  const p = await call('POST', '/imports/register/analyze', { fileId: u.fileId, options: OPTS(approve) });
  const c = await call('POST', '/imports/register/commit', { fileId: u.fileId, options: OPTS(approve), skipInvalid: true });
  return { p, c };
};
const counts = async () => (await db.one(`SELECT (SELECT count(*)::int FROM rate_scheme_versions) AS versions, (SELECT count(*)::int FROM rate_scheme_versions WHERE status = 'pending_approval') AS pending,
  (SELECT count(*)::int FROM tax_rules) AS tax, (SELECT count(*)::int FROM tax_rules WHERE status = 'draft') AS draft_tax, (SELECT count(*)::int FROM tax_rules WHERE status = 'approved') AS approved_tax`));

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

describe.skipIf(!present)('re-importing a register that has not been approved yet', () => {
  const base: Record<string, any> = {};

  it('the first import leaves rates and tax rules waiting for approval', async () => {
    await run(fs.readFileSync(REGISTER), false);
    base.c = await counts();
    expect(base.c.pending).toBeGreaterThan(80);
    expect(base.c.draft_tax).toBeGreaterThan(20);
    expect(base.c.approved_tax).toBe(0);
  });

  it('importing the same file again adds no rate versions and no duplicate tax rules', async () => {
    const { p } = await run(fs.readFileSync(REGISTER), false);
    expect(p.summary.rates).toMatchObject({ add: 0, update: 0 });
    expect(p.summary.taxChanges).toBe(0);
    expect(await counts()).toEqual(base.c);
  });

  it('a changed rate replaces the older unapproved version of that rate', async () => {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(REGISTER);
    const ws = wb.getWorksheet('Department Rate Register')!;
    let row: ExcelJS.Row | null = null;
    ws.eachRow((r) => { if (!row && r.getCell(2).text === 'CENTRAL ROAD RESEARCH INSTITUTE (CRRI)') row = r; });
    (row as unknown as ExcelJS.Row).getCell(7).value = Number((row as unknown as ExcelJS.Row).getCell(7).value) + 100;
    const { p } = await run(Buffer.from(await wb.xlsx.writeBuffer()), false);
    expect(p.summary.rates).toMatchObject({ add: 0, update: 1 });
    const c = await counts();
    expect(c.versions).toBe(base.c.versions + 1);
    expect(c.pending).toBe(base.c.pending); // the new version took the place of the old one
    expect(c.draft_tax).toBe(base.c.draft_tax);
    const crri = await db.query(`SELECT v.status FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id JOIN contracts k ON k.id = s.contract_id JOIN clients c ON c.id = k.client_id WHERE c.name ILIKE '%CRRI%' ORDER BY v.version_no`);
    expect(crri.map((r: { status: string }) => r.status)).toEqual(['retired', 'pending_approval']);
  });

  it('importing with approval approves the waiting tax rules without adding any', async () => {
    const before = await counts();
    await run(fs.readFileSync(REGISTER), true);
    const after = await counts();
    expect(after.tax).toBe(before.tax);
    expect(after.draft_tax).toBe(0);
    expect(after.approved_tax).toBe(before.draft_tax);
  });
});
