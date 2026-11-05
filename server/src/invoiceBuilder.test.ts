/**
 * Slips from several departments in one batch: matched to the department records, one approved rate card applied to the slips it fits
 * (an incompatible slip is refused), amounts calculated, and a separate invoice per department that can never bill a duty twice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-inv-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.SLIP_READER = 'mock';
process.env.SCANNER_DRIVER = 'mock';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const ctx: Record<string, any> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', ok = true) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: { authorization: `Bearer ${tokens[who]}` } });
  if (ok && res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 500)}`);
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  tokens.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  await call('POST', '/users', { email: 'approver@test.local', name: 'approver', role: 'approver', password: 'TestApprover12345' });
  tokens.approver = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'approver@test.local', password: 'TestApprover12345' } })).json().token;
  await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true });
  ctx.ciaz = (await call('POST', '/vehicle-categories', { name: 'Ciaz' })).body.id;
  ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' })).body.id;
  for (const [key, name, code] of [['sail', 'STEEL AUTHORITY OF INDIA LIMITED (SAIL)', 'SAIL'], ['isro', 'DEPARTMENT OF SPACE (ISRO)', 'ISRO']]) {
    const client = (await call('POST', '/clients', { name, short_code: code, billing_address: 'New Delhi', gstin: `07${code}GSTIN1Z5` })).body.id;
    const contract = (await call('POST', '/contracts', { client_id: client, title: `${code} hire`, reference_no: `${code}/RATE-CARD`, start_date: '2026-04-01', end_date: '2027-03-31', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' })).body.id;
    const tax = [];
    for (const [n, t] of [['CGST', 'CGST'], ['SGST', 'SGST']]) tax.push((await call('POST', `/contracts/${contract}/tax-rules`, { name: n, tax_type: t, rate: '2.5', effective_from: '2026-04-01', source_ref: 'Test clause' })).body);
    for (const t of tax) await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
    const cards: Record<string, any> = {};
    for (const [label, cat, rate] of [['Ciaz 80/8', ctx.ciaz, '1800'], ['Innova 80/8', ctx.innova, '2400']] as const) {
      const cfg = { billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate, unit: 'duty', taxCategory: 'taxable' }] };
      const s = (await call('POST', '/rate-schemes', { contract_id: contract, name: label })).body;
      const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [cat], config: cfg, clause_ref: 'Test' })).body;
      await call('POST', `/rate-versions/${v.id}/submit`, {});
      await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
      cards[label] = { scheme: s.id, version: v.id };
    }
    ctx[key] = { client, contract, name, cards };
  }
}, 90_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const jpeg = (n: number) => Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x30 + n]);
async function uploadSlips(n: number) {
  const b = '----inv';
  const parts: Buffer[] = [];
  for (let i = 1; i <= n; i++) parts.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), jpeg(i), Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${b}--\r\n`));
  const res = await app.inject({ method: 'POST', url: '/api/scan/batches/upload', payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${b}`, authorization: `Bearer ${tokens.admin}` } });
  return res.json().batch.id as string;
}

describe('department-wise slips and invoices', () => {
  const slips = [
    { dept: 'SAIL', cat: 'Ciaz', reg: 'DL1CAA0001' },
    { dept: 'STEEL AUTHORITY OF INDIA LIMITED (SAIL)', cat: 'Ciaz', reg: 'DL1CAA0002' },
    { dept: 'SAIL', cat: 'Innova', reg: 'DL1CAA0003' },
    { dept: 'DEPARTMENT OF SPACE (ISRO)', cat: 'Ciaz', reg: 'DL1CAA0004' },
  ];
  it('matches each slip to the department record and shows its contract', async () => {
    ctx.batch = await uploadSlips(slips.length);
    const pages = (await call('GET', `/scan/batches/${ctx.batch}`)).body.pages;
    ctx.readings = [];
    for (let i = 0; i < slips.length; i++) {
      await call('POST', `/scan/pages/${pages[i].id}/read`, {});
      const reading = (await call('GET', `/scan/batches/${ctx.batch}`)).body.pages[i].reading;
      ctx.readings.push(reading.id);
      await call('PUT', `/scan/readings/${reading.id}`, { edited: { department: slips[i].dept, duty_date: '10-05-2026', vehicle_no: slips[i].reg, vehicle_category: slips[i].cat, opening_km: '1000', closing_km: '1080', reporting_time: '08:00', release_time: '16:00', toll: '', parking: '', other_expenses: '' } });
    }
    const calc = (await call('GET', `/scan/batches/${ctx.batch}/calculations`)).body;
    const names = ctx.readings.map((id: string) => calc[id].match.clientName);
    expect(names).toEqual([ctx.sail.name, ctx.sail.name, ctx.sail.name, ctx.isro.name]);
    expect(calc[ctx.readings[3]].match.contractRef).toBe('ISRO/RATE-CARD');
    expect(calc[ctx.readings[0]].status).toBe('ok');   // automatic: the Ciaz card fits a Ciaz slip
    expect(calc[ctx.readings[0]].rateCardChosen).toBe(false);
  });

  it('lists the approved cards and applies one to the slips it fits, refusing the Innova slip', async () => {
    const cards = (await call('GET', `/scan/rate-cards?contractIds=${ctx.sail.contract}`)).body;
    expect(cards.map((c: any) => c.name).sort()).toEqual(['Ciaz 80/8', 'Innova 80/8']);
    const r = (await call('POST', `/scan/batches/${ctx.batch}/apply-rate-card`, { readingIds: ctx.readings.slice(0, 3), schemeId: ctx.sail.cards['Ciaz 80/8'].scheme })).body;
    expect(r.applied).toBe(2);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/does not fit this slip.*vehicle category/i);
    expect(r.total).toBe('3600.00');
    const calc = (await call('GET', `/scan/batches/${ctx.batch}/calculations`)).body;
    expect(calc[ctx.readings[0]]).toMatchObject({ rateCardChosen: true, rateCardName: 'Ciaz 80/8' });
    expect(calc[ctx.readings[2]].rateCardChosen).toBe(false);   // the Innova slip was left alone
    // a card of another department is refused
    const wrong = (await call('POST', `/scan/batches/${ctx.batch}/apply-rate-card`, { readingIds: [ctx.readings[3]], schemeId: ctx.sail.cards['Ciaz 80/8'].scheme })).body;
    expect(wrong.applied).toBe(0);
    expect(wrong.skipped[0].reason).toMatch(/different contract/i);
  });

  it('saves the slips as duties that keep their rate card and the version used', async () => {
    const res = (await call('POST', `/scan/batches/${ctx.batch}/save`, { defaultDutyType: 'LOCAL' })).body;
    expect(res.summary).toMatchObject({ add: 4, error: 0 });
    const saved = await db.query<{ vehicle_reg_no: string; rate_scheme_id: string | null; scheme_version_id: string }>(
      `SELECT d.vehicle_reg_no, d.rate_scheme_id, dc.scheme_version_id FROM duties d JOIN duty_calculations dc ON dc.duty_id = d.id ORDER BY d.vehicle_reg_no`);
    expect(saved.map((x) => [x.vehicle_reg_no, x.rate_scheme_id === ctx.sail.cards['Ciaz 80/8'].scheme, x.scheme_version_id === ctx.sail.cards['Ciaz 80/8'].version || x.scheme_version_id === ctx.sail.cards['Innova 80/8'].version || x.scheme_version_id === ctx.isro.cards['Ciaz 80/8'].version]))
      .toEqual([['DL1CAA0001', true, true], ['DL1CAA0002', true, true], ['DL1CAA0003', false, true], ['DL1CAA0004', false, true]]);
  });

  const q = (c: any, extra = '') => `contractId=${c.contract}&periodStart=2026-05-01&periodEnd=2026-05-31${extra}`;
  it('shows a department\'s saved duties, filters by rate card and summarises the chosen ones', async () => {
    const all = (await call('GET', `/invoice-builder/duties?${q(ctx.sail)}`)).body;
    expect(all.duties).toHaveLength(3);
    expect(all.duties.every((d: any) => d.state === 'unbilled')).toBe(true);
    const ciaz = (await call('GET', `/invoice-builder/duties?${q(ctx.sail, `&schemeId=${ctx.sail.cards['Ciaz 80/8'].scheme}`)}`)).body;
    expect(ciaz.duties.filter((d: any) => d.eligible)).toHaveLength(2);
    ctx.sailCiaz = ciaz.duties.filter((d: any) => d.eligible).map((d: any) => d.id);
    ctx.sailInnova = all.duties.filter((d: any) => d.vehicleRegNo === 'DL1CAA0003').map((d: any) => d.id);
    const sum = (await call('POST', '/invoice-builder/summary', { contractId: ctx.sail.contract, periodStart: '2026-05-01', periodEnd: '2026-05-31', dutyIds: ctx.sailCiaz })).body;
    expect(sum).toMatchObject({ duties: 2, totalKm: '160', basicAmount: '3600.00', gst: '180.00', finalAmount: '3780.00' });
  });

  it('generates one invoice for the chosen duties, refuses a second click, and bills the rest separately', async () => {
    const body = { contractId: ctx.sail.contract, periodStart: '2026-05-01', periodEnd: '2026-05-31', dutyIds: ctx.sailCiaz };
    const inv = (await call('POST', '/invoice-builder/generate', body)).body;
    expect(inv).toMatchObject({ duties: 2, totals: { grandTotal: '3780.00' } });
    // a repeated click (or a second user) cannot bill the same duties again
    const again = await call('POST', '/invoice-builder/generate', body, 'admin', false);
    expect(again.status).toBe(409);
    const bill = (await call('GET', `/bills/${inv.billId}`)).body;
    expect(['draft', 'validation_required']).toContain(bill.status);   // warnings such as "duty not verified" still go through the normal review
    expect(bill.lines.filter((l: any) => l.component_code === 'BASE')).toHaveLength(2);
    // the Innova duty of the same department and month goes on its own invoice, at the Innova rate
    const second = (await call('POST', '/invoice-builder/generate', { ...body, dutyIds: ctx.sailInnova })).body;
    expect(second.totals.grandTotal).toBe('2520.00');
    expect(second.billId).not.toBe(inv.billId);
    // ISRO is a different contract: its own invoice, with only its own duty
    const isroDuties = (await call('GET', `/invoice-builder/duties?${q(ctx.isro)}`)).body.duties;
    expect(isroDuties).toHaveLength(1);
    const isro = (await call('POST', '/invoice-builder/generate', { contractId: ctx.isro.contract, periodStart: '2026-05-01', periodEnd: '2026-05-31', dutyIds: [isroDuties[0].id] })).body;
    expect(isro.totals.grandTotal).toBe('1890.00');
    // the states now show what is billed, and nothing is left to bill
    const after = (await call('GET', `/invoice-builder/duties?${q(ctx.sail)}`)).body;
    expect(after.duties.every((d: any) => d.state === 'draft')).toBe(true);
    expect(after.duties.filter((d: any) => d.eligible)).toHaveLength(0);
    // a duty of one department can never be sent to another contract's invoice
    const mixed = await call('POST', '/invoice-builder/generate', { contractId: ctx.isro.contract, periodStart: '2026-05-01', periodEnd: '2026-05-31', dutyIds: ctx.sailCiaz }, 'admin', false);
    expect(mixed.status).toBe(400);
    const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM bill_duties WHERE active`);
    expect(n!.n).toBe(4);
  });

  it('leaves the rate version stored with each duty unchanged when a newer version is approved later', async () => {
    const v = ctx.sail.cards['Ciaz 80/8'].version;
    await call('POST', `/rate-versions/${v}/clone`, { effective_from: '2026-06-01' });
    const rows = await db.query<{ scheme_version_id: string }>(`SELECT dc.scheme_version_id FROM duty_calculations dc JOIN duties d ON d.id = dc.duty_id WHERE d.vehicle_reg_no IN ('DL1CAA0001','DL1CAA0002')`);
    expect(rows.every((r) => r.scheme_version_id === v)).toBe(true);
  });
});

describe('deleting an invoice', () => {
  it('removes only the invoice: its duties can be billed again, and departments, rate cards and tax rules are untouched', async () => {
    const counts = async () => (await db.one<Record<string, number>>(`SELECT (SELECT count(*)::int FROM clients) AS clients, (SELECT count(*)::int FROM rate_scheme_versions) AS rates, (SELECT count(*)::int FROM tax_rules) AS tax, (SELECT count(*)::int FROM duties) AS duties`))!;
    const before = await counts();
    const sailBills = await db.query<{ id: string }>(`SELECT id FROM bills WHERE contract_id = $1 ORDER BY created_at`, [ctx.sail.contract]);
    expect(sailBills.length).toBeGreaterThanOrEqual(2);
    expect((await call('POST', `/bills/${sailBills[0].id}/delete`, { reason: 'Test' }, 'approver', false)).status).toBe(403);   // only people with the delete permission
    expect((await call('POST', `/bills/${sailBills[0].id}/delete`, { reason: '' }, 'admin', false)).status).toBe(400);   // a reason is needed
    const r = (await call('POST', `/bills/${sailBills[0].id}/delete`, { reason: 'Wrong period' })).body;
    expect(r.deleted).toBe(sailBills[0].id);
    expect(await db.one('SELECT 1 FROM bills WHERE id = $1', [sailBills[0].id])).toBeNull();
    expect(await counts()).toEqual(before);   // not one department, rate, tax rule or duty was deleted
    const free = (await call('GET', `/invoice-builder/duties?contractId=${ctx.sail.contract}&periodStart=2026-05-01&periodEnd=2026-05-31`)).body.duties.filter((d: any) => d.eligible);
    expect(free.length).toBeGreaterThanOrEqual(2);   // the released duties can go on a new invoice
    const log = await db.one<{ action: string; reason: string | null }>(`SELECT action, note AS reason FROM audit_events WHERE entity_type = 'bill' AND entity_id = $1 AND action = 'delete'`, [sailBills[0].id]).catch(() => null);
    expect(log).not.toBeNull();
    const many = (await call('POST', '/bills/delete-many', { ids: sailBills.slice(1).map((b) => b.id), reason: 'Clean up' })).body;
    expect(many.deleted).toBe(sailBills.length - 1);
    expect(await counts()).toEqual(before);
  });
});

describe('deleting duty slips', () => {
  it('deletes duties that were never billed, refuses billed ones with the reason, and needs the permission', async () => {
    await call('POST', '/duties/bulk', { rows: [
      { contractId: ctx.sail.contract, vehicleCategoryId: ctx.ciaz, dutyTypeCode: 'LOCAL', dutyDate: '2026-07-10', vehicleRegNo: 'DL1CDD0001', startKm: '1000', endKm: '1080', startAt: '2026-07-10 08:00', endAt: '2026-07-10 16:00' },
      { contractId: ctx.sail.contract, vehicleCategoryId: ctx.ciaz, dutyTypeCode: 'LOCAL', dutyDate: '2026-07-11', vehicleRegNo: 'DL1CDD0002', startKm: '1000', endKm: '1080', startAt: '2026-07-11 08:00', endAt: '2026-07-11 16:00' },
    ] });
    const list = (await call('GET', `/invoice-builder/duties?contractId=${ctx.sail.contract}&periodStart=2026-07-01&periodEnd=2026-07-31`)).body.duties;
    const ids = list.map((d: any) => d.id);
    expect((await call('POST', '/duties/delete-many', { ids, reason: 'Entered twice' }, 'approver', false)).status).toBe(403);
    // put one on a draft invoice: it can no longer be deleted
    await call('POST', '/invoice-builder/generate', { contractId: ctx.sail.contract, periodStart: '2026-07-01', periodEnd: '2026-07-31', dutyIds: [ids[0]] });
    const r = (await call('POST', '/duties/delete-many', { ids, reason: 'Entered twice' })).body;
    expect(r.deleted).toBe(1);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0].reason).toMatch(/on .*bill/i);
    expect(await db.one('SELECT 1 FROM duties WHERE id = $1', [ids[1]])).toBeNull();
    expect(await db.one('SELECT 1 FROM duties WHERE id = $1', [ids[0]])).not.toBeNull();
    expect((await call('POST', '/duties/delete-many', { ids: [ids[1]], reason: '' }, 'admin', false)).status).toBe(400);
  });
});
