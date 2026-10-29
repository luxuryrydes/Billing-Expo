/**
 * The "Consistent Design" register (kept out of git in fixtures/master/): monthly packages, fixed rows that
 * list their own extra rates, the reference row, partial rates and the AC Usage column. First the earlier
 * register is imported, then this one, the way a real update happens.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { calculateBill } from './engine/bill.js';
import { RateConfigSchema, type DutyInput, type SchemeVersion } from './engine/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MASTER = path.resolve(here, '../fixtures/master');
const OLD = path.join(MASTER, 'LR_Taxi_Services_Department_Rate_Register.xlsx');
const NEW = path.join(MASTER, 'LR_Taxi_Services_Department_Rate_Register_Consistent_Design.xlsx');
const present = fs.existsSync(OLD) && fs.existsSync(NEW);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-monthly-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

let app: any;
let db: any;
let token = '';
const OPTS = { newRatesFrom: '2026-04-01', changesFrom: '2026-10-28', approve: true };

async function call(method: string, url: string, body?: unknown, expectStatus = 200) {
  const res = await app.inject({ method, url: `/api${url}`, payload: body, headers: { authorization: `Bearer ${token}` } });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 1500)}`);
  return res.headers['content-type']?.includes('json') ? res.json() : res;
}
async function upload(file: string) {
  const boundary = '----rm' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${path.basename(file)}"\r\nContent-Type: application/octet-stream\r\n\r\n`), fs.readFileSync(file), Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: '/api/imports/register/upload', payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${token}` } });
  if (res.statusCode !== 200) throw new Error(`upload → ${res.statusCode}: ${res.body.slice(0, 600)}`);
  return res.json();
}
const preview = async (file: string) => { const u = await upload(file); return { fileId: u.fileId, ...(await call('POST', '/imports/register/analyze', { fileId: u.fileId, options: OPTS })) }; };
const commit = (fileId: string) => call('POST', '/imports/register/commit', { fileId, options: OPTS, skipInvalid: true });

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

/** The calculation rules saved for one department's rate. */
const schemeConfig = async (clientLike: string, name: string) => {
  const r = await db.one(
    `SELECT v.id, v.config, v.duty_type_codes FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id JOIN contracts k ON k.id = s.contract_id JOIN clients c ON c.id = k.client_id
     WHERE c.name ILIKE $1 AND s.name = $2 AND v.status = 'approved'`, [clientLike, name]);
  expect(r, `${clientLike} / ${name}`).toBeTruthy();
  return r as { id: string; config: unknown; duty_type_codes: string[] };
};
const version = (id: string, config: unknown): SchemeVersion => ({
  id, schemeId: 's', schemeName: 'Test', versionNo: 1, status: 'approved', effectiveFrom: '2026-04-01', effectiveTo: null, vehicleCategoryIds: ['c'], dutyTypeCodes: [], config: RateConfigSchema.parse(config),
});
const duty = (date: string, km: number, hours: number, o: Partial<DutyInput> = {}): DutyInput => ({
  id: `d-${date}-${km}`, dutyDate: date, vehicleRegNo: 'DL1CAA1001', vehicleCategoryId: 'c', dutyTypeCode: null, startKm: '1000', endKm: String(1000 + km),
  startAt: `${date} 09:00`, endAt: `${date} ${String(9 + Math.floor(hours)).padStart(2, '0')}:${String(Math.round((hours % 1) * 60)).padStart(2, '0')}`, toll: null, parking: null, otherCharges: null, ...o,
});
const GST_ZERO = [{ id: 't', name: 'IGST 0', taxType: 'IGST', rate: '0', effectiveFrom: '2026-01-01', effectiveTo: null, status: 'approved' }];
const SETTINGS = { taxMode: 'exclusive' as const, taxLevel: 'document' as const, invoiceRounding: 'none' as const };

describe.skipIf(!present)('Consistent Design register', () => {
  it('previews as an update of the earlier register: monthly packages, skipped reference row, partial rates', async () => {
    await commit((await upload(OLD)).fileId);
    const p = await preview(NEW);
    expect(p.summary.departments).toMatchObject({ rows: 24, update: 3, unchanged: 21, errors: 0 });
    // The 83 rates that were already there are unchanged; the two Ministry of Education rates changed.
    expect(p.summary.rates).toMatchObject({ unchanged: 83, update: 2, skipped: 1, errors: 2 });
    expect(p.skipped[0]).toMatchObject({ department: 'NMRC', package: 'Schedules A/B/C rate entries' });
    expect(p.rates.filter((r: any) => r.incoming.rateType === 'monthly')).toHaveLength(130);
    // The two partial UPSC monthly rows have no base fare, so they are not imported.
    expect(p.rates.filter((r: any) => r.errors.length).map((r: any) => r.errors[0])).toEqual(['A monthly package needs a monthly base fare', 'A monthly package needs a monthly base fare']);
    const nmrc = p.plans.find((x: any) => x.department === 'NMRC');
    expect(nmrc.warnings.join(' ')).toMatch(/120 monthly package/);
    expect(nmrc.warnings.join(' ')).toMatch(/AC usage rate on 140 row/);
    ctx.fileId = p.fileId;
  });

  const ctx: Record<string, string> = {};

  it('imports it, keeping the AC Usage rate and giving every package its own duty type', async () => {
    const c = await commit(ctx.fileId);
    expect(c.ratesAdded).toBe(185);
    expect(c.ratesUpdated).toBe(2);
    const nm = await db.one(`SELECT v.meta FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id WHERE s.name LIKE $1 || '%'`, ['4+1 Seater — Dzire/Amaze/Tigor/Aura or same category car (SUV/Sedan) — 25/26 days monthly | 1500 km | 12 hours/day']);
    expect(nm.meta.entry).toMatchObject({ rateType: 'monthly', baseFare: '49917.28', includedKm: '1500', acUsage: '62.72' });
    // No two approved rates of one contract may claim the same vehicle category and duty type (that would make billing ambiguous).
    const rows = await db.query(`SELECT s.contract_id, v.vehicle_category_ids[1] AS cat, unnest(v.duty_type_codes) AS code FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id WHERE v.status = 'approved' AND v.effective_to IS NULL`);
    const seen = new Map<string, number>();
    for (const r of rows) seen.set(`${r.contract_id}|${r.cat}|${r.code}`, (seen.get(`${r.contract_id}|${r.cat}|${r.code}`) ?? 0) + 1);
    expect([...seen].filter(([, n]) => n > 1)).toEqual([]);
    expect((await db.one(`SELECT count(*)::int AS n FROM duty_types WHERE code LIKE 'M\\_%'`)).n).toBeGreaterThan(10);
  });

  it('bills a monthly package once per vehicle per bill, with extra km over the monthly allowance', async () => {
    const s = await schemeConfig('NMRC', '4+1 Seater — Dzire/Amaze/Tigor/Aura or same category car (SUV/Sedan) — 25/26 days monthly | 1500 km | 12 hours/day');
    expect((s.config as any).billingModel).toBe('monthly_package');
    // Three duties of 600 km in a month: 1,800 km against 1,500 included.
    const out = calculateBill({ periodStart: '2026-09-01', periodEnd: '2026-09-30', duties: [duty('2026-09-01', 600, 9), duty('2026-09-02', 600, 9), duty('2026-09-03', 600, 9)], schemes: [version(s.id, s.config)], taxRules: GST_ZERO, settings: SETTINGS });
    expect(out.exceptions).toEqual([]);
    const monthly = out.lines.filter((l) => l.componentCode === 'MONTHLY');
    expect(monthly).toHaveLength(1);
    expect(monthly[0]).toMatchObject({ quantity: '1', amount: '49917.28' });
    expect(out.lines.find((l) => l.componentCode === 'EXKM')).toMatchObject({ quantity: '300', amount: '4116.00' }); // 300 × 13.72
    expect(out.lines.find((l) => l.componentCode === 'EXHR')).toBeUndefined(); // 9 h a day is inside 12 h/day
    expect(out.totals.taxableValue).toBe('54033.28');
  });

  it('UPSC monthly basis uses a monthly hours allowance', async () => {
    const s = await schemeConfig('%UNION PUBLIC%', 'Hatchback (AC) — Monthly basis 2400kms/240hrs');
    const cfg = s.config as any;
    expect(cfg.params).toMatchObject({ monthlyIncludedKm: '2400', monthlyIncludedHours: '240' });
    // 20 duties of 9 h and 130 km: 2,600 km (200 over) and 180 h (inside 240 h).
    const days = Array.from({ length: 20 }, (_, i) => duty(`2026-09-${String(i + 1).padStart(2, '0')}`, 130, 9));
    const out = calculateBill({ periodStart: '2026-09-01', periodEnd: '2026-09-30', duties: days, schemes: [version(s.id, s.config)], taxRules: GST_ZERO, settings: SETTINGS });
    expect(out.exceptions).toEqual([]);
    expect(out.lines.find((l) => l.componentCode === 'MONTHLY')).toMatchObject({ amount: '36000.00' });
    expect(out.lines.find((l) => l.componentCode === 'EXKM')).toMatchObject({ quantity: '200', amount: '2600.00' }); // 200 × 13
    expect(out.lines.find((l) => l.componentCode === 'EXHR')).toBeUndefined();
  });

  it('a fixed-price row that lists extra rates is billed as a package with those extras', async () => {
    const s = await schemeConfig('%UNION PUBLIC%', 'Hatchback (AC) — Full Day 80kms/10hrs');
    expect((s.config as any).billingModel).toBe('daily_package');
    const out = calculateBill({ periodStart: '2026-09-01', periodEnd: '2026-09-30', duties: [duty('2026-09-05', 100, 11)], schemes: [version(s.id, s.config)], taxRules: GST_ZERO, settings: SETTINGS });
    expect(out.exceptions).toEqual([]);
    expect(out.lines.find((l) => l.componentCode === 'BASE')).toMatchObject({ amount: '1300.00' });
    expect(out.lines.find((l) => l.componentCode === 'EXKM')).toMatchObject({ quantity: '20', amount: '260.00' }); // 20 × 13
    expect(out.lines.find((l) => l.componentCode === 'EXHR')).toMatchObject({ quantity: '1', amount: '75.00' }); // 1 × 75 (hours rounded up)
  });

  it('exporting the register and importing it again changes nothing, including the new fields', async () => {
    const res = await call('GET', '/imports/register/export.xlsx?date=2026-10-29');
    const exported = path.join(tmp, 'exported.xlsx');
    fs.writeFileSync(exported, res.rawPayload);
    const p = await preview(exported);
    const changed = [...p.departments, ...p.rates].filter((x: any) => x.action === 'add' || x.action === 'update');
    expect(changed.map((x: any) => `${x.name ?? x.department} ${x.vehicle ?? ''} ${JSON.stringify(x.changes)}`)).toEqual([]);
    expect(p.summary.rates.errors).toBe(0);
  });
});
