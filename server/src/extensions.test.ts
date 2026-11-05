/**
 * Contract extensions (upload → read → confirm → apply, several in a row, duplicates and conflicts), the calculation behind
 * scanned slips (approved rate only, extra km / hours, night, toll, parking, review when no rate applies, saved with the duty),
 * and one approval event per rate version.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-ext-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.SLIP_READER = 'mock';
process.env.SCANNER_DRIVER = 'mock';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');
const { period } = await import('./services/contractExtensions.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const ctx: Record<string, any> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', ok = true) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: { authorization: `Bearer ${tokens[who]}` } });
  if (ok && res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 500)}`);
  return { status: res.statusCode, body: res.json() };
}
async function upload(url: string, name: string, buf: Buffer, who = 'admin') {
  const boundary = '----ext' + Math.random().toString(16).slice(2);
  const payload = Buffer.concat([Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`)]);
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${tokens[who]}` } });
  return { status: res.statusCode, body: res.json() };
}
/** A stand-in PDF carrying what the (mock) reader should find in it. */
const letter = (o: Record<string, string>) => Buffer.from(`%PDF-1.4\n% EXTENSION_JSON:${JSON.stringify(o)}\n%%EOF`, 'latin1');

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  tokens.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  for (const role of ['operator', 'approver'] as const) {
    await call('POST', '/users', { email: `${role}@test.local`, name: role, role, password: `Test${role}12345` });
    tokens[role] = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${role}@test.local`, password: `Test${role}12345` } })).json().token;
  }
  await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true });
  ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' })).body.id;
  ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' })).body.id;
  ctx.contract = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Vehicle hire', reference_no: 'TDR/01', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' })).body.id;
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('period arithmetic', () => {
  it('counts whole months and days between two dates, both days included', () => {
    expect(period('2027-04-01', '2027-09-30').text).toBe('6 months (183 days)');
    expect(period('2026-04-01', '2027-03-31').text).toBe('1 year (365 days)');
    expect(period('2027-10-01', '2028-03-31').months).toBe(6);
    expect(period('2027-04-01', '2027-04-10').text).toBe('10 days (10 days)');
  });
});

describe('contract extensions', () => {
  it('reads the dates from an uploaded letter and shows the extension period without changing the contract', async () => {
    const r = await upload(`/contracts/${ctx.contract}/extensions`, 'ext1.pdf', letter({ letter_no: 'GAD/EXT/12', letter_date: '2027-03-10', department_name: 'Test Directorate', existing_end_date: '2027-03-31', extension_start: '2027-04-01', new_end_date: '2027-09-30' }));
    expect(r.status).toBe(200);
    ctx.ext1 = r.body.id;
    expect(r.body).toMatchObject({ letter_no: 'GAD/EXT/12', new_end_date: '2027-09-30', status: 'pending' });
    expect(r.body.duration.months).toBe(6);
    expect(r.body.conflicts).toEqual([]);
    const k = (await call('GET', `/contracts/${ctx.contract}`)).body;
    expect(k.end_date).toBe('2027-03-31');
  });

  it('refuses the same letter twice and an operator cannot apply it', async () => {
    const again = await upload(`/contracts/${ctx.contract}/extensions`, 'copy.pdf', letter({ letter_no: 'GAD/EXT/12', letter_date: '2027-03-10', department_name: 'Test Directorate', existing_end_date: '2027-03-31', extension_start: '2027-04-01', new_end_date: '2027-09-30' }));
    expect(again.status).toBe(409);
    expect((await call('POST', `/contract-extensions/${ctx.ext1}/apply`, {}, 'operator', false)).status).toBe(403);
  });

  it('applies a corrected extension: the end date moves, the original is kept, and applying twice is refused', async () => {
    await call('PUT', `/contract-extensions/${ctx.ext1}`, { letter_no: 'GAD/EXT/12', letter_date: '2027-03-10', previous_end_date: '2027-03-31', extension_start: '2027-04-01', new_end_date: '2027-09-30', remarks: 'Corrected by hand' });
    const done = (await call('POST', `/contract-extensions/${ctx.ext1}/apply`, {})).body;
    expect(done).toMatchObject({ previousEnd: '2027-03-31', newEnd: '2027-09-30' });
    const k = (await call('GET', `/contracts/${ctx.contract}`)).body;
    expect(k).toMatchObject({ end_date: '2027-09-30', original_end_date: '2027-03-31', status: 'active' });
    expect((await call('POST', `/contract-extensions/${ctx.ext1}/apply`, {}, 'admin', false)).status).toBe(409);
  });

  it('supports a second extension and keeps the whole history and totals', async () => {
    const r = await upload(`/contracts/${ctx.contract}/extensions`, 'ext2.pdf', letter({ letter_no: 'GAD/EXT/31', letter_date: '2027-09-12', existing_end_date: '2027-09-30', extension_start: '2027-10-01', new_end_date: '2028-03-31' }));
    expect(r.status).toBe(200);
    await call('POST', `/contract-extensions/${r.body.id}/apply`, {});
    const s = (await call('GET', `/contracts/${ctx.contract}/extensions`)).body;
    expect(s.contract).toMatchObject({ startDate: '2026-04-01', originalEndDate: '2027-03-31', currentEndDate: '2028-03-31' });
    expect(s.extensions.filter((e: any) => e.status === 'applied')).toHaveLength(2);
    expect(s.totalAdded).toMatchObject({ years: 1, months: 0 });
    expect(s.totalAddedDays).toBe(366);   // 1 April 2027 – 31 March 2028 includes 29 February 2028
  });

  it('flags a letter that is not an extension, a stale previous date, and a letter number already applied', async () => {
    const wrongEnd = await upload(`/contracts/${ctx.contract}/extensions`, 'ext3.pdf', letter({ letter_no: 'GAD/EXT/40', existing_end_date: '2027-09-30', new_end_date: '2028-09-30' }));
    expect(wrongEnd.body.conflicts.some((c: any) => c.severity === 'warning' && /ended on 2027-09-30/.test(c.message))).toBe(true);
    expect((await call('POST', `/contract-extensions/${wrongEnd.body.id}/apply`, {}, 'admin', false)).status).toBe(400);   // warnings need a confirmation
    const before = await upload(`/contracts/${ctx.contract}/extensions`, 'ext4.pdf', letter({ letter_no: 'GAD/EXT/50', new_end_date: '2028-01-31' }));
    expect(before.body.conflicts.some((c: any) => c.severity === 'error')).toBe(true);
    expect((await call('POST', `/contract-extensions/${before.body.id}/apply`, { acknowledge: true }, 'admin', false)).status).toBe(400);   // not after the current end date
    const dup = await upload(`/contracts/${ctx.contract}/extensions`, 'ext5.pdf', letter({ letter_no: 'gad/ext/12', new_end_date: '2028-09-30', existing_end_date: '2028-03-31' }));
    expect(dup.body.conflicts.some((c: any) => c.severity === 'error' && /already been applied/.test(c.message))).toBe(true);
    await call('POST', `/contract-extensions/${dup.body.id}/reject`, { reason: 'Same letter' });
    const k = (await call('GET', `/contracts/${ctx.contract}`)).body;
    expect(k.end_date).toBe('2028-03-31');
  });

  it('puts an expired contract back to active when the new end date is in the future', async () => {
    const c2 = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Old hire', reference_no: 'TDR/02', start_date: '2020-01-01', end_date: '2020-12-31', status: 'expired' })).body.id;
    const r = await upload(`/contracts/${c2}/extensions`, 'old.pdf', letter({ letter_no: 'X/1', existing_end_date: '2020-12-31', extension_start: '2021-01-01', new_end_date: '2099-12-31' }));
    await call('POST', `/contract-extensions/${r.body.id}/apply`, { acknowledge: true });
    expect((await call('GET', `/contracts/${c2}`)).body).toMatchObject({ status: 'active', end_date: '2099-12-31', original_end_date: '2020-12-31' });
    const audit = (await call('GET', '/audit?entityType=contract')).body;
    expect(JSON.stringify(audit)).toContain('extend_contract');
  });
});

describe('scanned slip calculation', () => {
  const dutyBody = (o: Record<string, unknown> = {}) => ({ contractId: ctx.contract, vehicleCategoryId: ctx.innova, dutyTypeCode: 'LOCAL', dutyDate: '2027-05-10', vehicleRegNo: 'DL1CAA1001', startKm: '1000', endKm: '1100', startAt: '2027-05-10 08:00', endAt: '2027-05-10 18:00', ...o });
  it('uses only the approved rate; with none approved the slip needs review, and with one the extra km, hours and toll are worked out', async () => {
    const { previewCalculation } = await import('./services/slipCalc.js');
    const { DutyInputSchema } = await import('./services/duties.js');
    ctx.tax = [];
    for (const [name, type] of [['CGST', 'CGST'], ['SGST', 'SGST']]) ctx.tax.push((await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name, tax_type: type, rate: '2.5', effective_from: '2026-04-01', source_ref: 'Test clause' })).body);
    const cfg = {
      billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } },
      components: [
        { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '2000', unit: 'duty', taxCategory: 'taxable' },
        { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '10', unit: 'km', taxCategory: 'taxable' },
        { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: '100', unit: 'hr', taxCategory: 'taxable' },
        { code: 'TOLL', label: 'Toll', quantityExpr: 'toll', rate: '1', unit: '', taxCategory: 'non_taxable', kind: 'reimbursement' },
      ],
    };
    const s = (await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Innova package' })).body;
    const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [ctx.innova], config: cfg, clause_ref: 'Test' })).body;
    ctx.version = v.id;
    const input = DutyInputSchema.parse(dutyBody({ toll: '120' }));
    // 1. a draft version is never used
    const draft = await previewCalculation(db, input);
    expect(draft.status).toBe('review');
    expect(draft.message).toMatch(/no approved rate/i);
    // 2. approved: 100 km (20 extra), 10 hours (2 extra), toll 120
    await call('POST', `/rate-versions/${v.id}/submit`, {});
    for (const t of ctx.tax) await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
    await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
    const ok = await previewCalculation(db, input);
    expect(ok.status).toBe('ok');
    expect(ok.schemeVersionId).toBe(v.id);
    expect(ok.lines.map((l) => [l.label, l.amount])).toEqual([['Base duty', '2000.00'], ['Extra km', '200.00'], ['Extra hours', '200.00'], ['Toll', '120.00']]);
    expect(ok.totals).toMatchObject({ taxable: '2400.00', nonTaxable: '120.00', tax: '120.00' });
    // 3. missing readings are not guessed
    expect((await previewCalculation(db, DutyInputSchema.parse(dutyBody({ endKm: null })))).status).toBe('review');
    // 4. a date before the rate took effect has no rate
    expect((await previewCalculation(db, DutyInputSchema.parse(dutyBody({ dutyDate: '2026-01-05', startAt: '2026-01-05 08:00', endAt: '2026-01-05 18:00' })))).status).toBe('review');
  });

  it('shows the amount in the batch review, follows an edit, and stores the rate version with the saved duty once', async () => {
    const up = await app.inject({ method: 'POST', url: '/api/scan/batches/upload', payload: (() => {
      const b = '----s1'; return Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="a.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x31]), Buffer.from(`\r\n--${b}--\r\n`)]);
    })(), headers: { 'content-type': 'multipart/form-data; boundary=----s1', authorization: `Bearer ${tokens.admin}` } });
    expect(up.statusCode).toBe(200);
    const batch = up.json().batch.id;
    const pages = (await call('GET', `/scan/batches/${batch}`)).body.pages;
    await call('POST', `/scan/pages/${pages[0].id}/read`, {});
    const detail = (await call('GET', `/scan/batches/${batch}`)).body;
    const reading = detail.pages[0].reading;
    await call('PUT', `/scan/readings/${reading.id}`, { contractId: ctx.contract, edited: { department: 'Test Directorate', duty_date: '10-05-2027', vehicle_no: 'DL1CAA7777', vehicle_category: 'Innova', opening_km: '1000', closing_km: '1100', reporting_time: '08:00', release_time: '18:00', toll: '120' } });
    const calc1 = (await call('GET', `/scan/batches/${batch}/calculations`)).body[reading.id];
    expect(calc1.status).toBe('ok');
    expect(calc1.totals.subtotal).toBe('2520.00');
    await call('PUT', `/scan/readings/${reading.id}`, { edited: { closing_km: '1080' } });   // edit → recalculated at once
    expect((await call('GET', `/scan/batches/${batch}/calculations`)).body[reading.id].totals.subtotal).toBe('2320.00');
    for (let i = 0; i < 2; i++) await call('POST', `/scan/batches/${batch}/save`, { defaultDutyType: 'LOCAL' });   // saving twice must not duplicate
    const duties = (await call('GET', '/duties?contractId=' + ctx.contract)).body;
    const rows = Array.isArray(duties) ? duties : duties.rows ?? duties.items ?? [];
    expect(rows.filter((d: any) => d.vehicle_reg_no === 'DL1CAA7777' || d.vehicleRegNo === 'DL1CAA7777')).toHaveLength(1);
    const saved = await db.one<Record<string, any>>(`SELECT dc.scheme_version_id, dc.status, dc.version_no, dc.totals FROM duty_calculations dc JOIN duties d ON d.id = dc.duty_id WHERE d.vehicle_reg_no = 'DL1CAA7777'`);
    expect(saved).toMatchObject({ scheme_version_id: ctx.version, status: 'ok', version_no: 1 });
    expect(saved!.totals.subtotal).toBe('2320.00');
    // a later rate version does not change what was stored
    await call('POST', `/rate-versions/${ctx.version}/clone`, {});
    const still = await db.one<Record<string, any>>(`SELECT scheme_version_id FROM duty_calculations dc JOIN duties d ON d.id = dc.duty_id WHERE d.vehicle_reg_no = 'DL1CAA7777'`);
    expect(still!.scheme_version_id).toBe(ctx.version);
  });
});

describe('one approval per rate version', () => {
  it('a second approval of the same version is refused and leaves exactly one approval record', async () => {
    const s = (await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Other package' })).body;
    const cfg = { billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8' }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '3000', unit: 'duty', taxCategory: 'taxable' }] };
    const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [], config: cfg, clause_ref: 'Test' })).body;
    await call('POST', `/rate-versions/${v.id}/submit`, {});
    const [a, b] = await Promise.all([call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver', false), call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver', false)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const n = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM approvals WHERE entity_type = 'rate_version' AND entity_id = $1 AND action = 'approve'`, [v.id]);
    expect(n!.n).toBe(1);
    const events = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE entity_type = 'rate_version' AND entity_id = $1 AND action = 'approve'`, [v.id]);
    expect(events!.n).toBe(1);
  });

  it('retires draft copies of an already-approved version and leaves the approved one alone', async () => {
    const copy = (await call('POST', `/rate-versions/${ctx.version}/clone`, { effective_from: '2026-04-01' })).body;
    const r = (await call('POST', '/rate-versions/cleanup-duplicates', {}, 'approver')).body;
    expect(r.retired).toBeGreaterThanOrEqual(1);
    const rows = await db.query<{ id: string; status: string }>('SELECT id, status FROM rate_scheme_versions WHERE id = ANY($1::uuid[])', [[copy.id, ctx.version]]);
    expect(Object.fromEntries(rows.map((x) => [x.id, x.status]))).toMatchObject({ [copy.id]: 'retired', [ctx.version]: 'approved' });
  });
});
