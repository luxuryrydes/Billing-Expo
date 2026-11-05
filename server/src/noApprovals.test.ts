/** With approvals not required (the default), what is uploaded or saved is used straight away; the technical checks still hold. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-noappr-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.APPROVALS_REQUIRED = 'false';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
let token = '';
const ctx: Record<string, any> = {};
async function call(method: string, url: string, body?: unknown, ok = true) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: { authorization: `Bearer ${token}` } });
  if (ok && res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 400)}`);
  return res.json();
}
const cfg = (rate: string) => ({ billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate, unit: 'duty', taxCategory: 'taxable' }] });

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  token = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true });
  ctx.ciaz = (await call('POST', '/vehicle-categories', { name: 'Ciaz' })).id;
  ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'Delhi' })).id;
  ctx.contract = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Hire', reference_no: 'TDR/01', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' })).id;
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('no approvals required', () => {
  it('hides the approval permissions from the screens but keeps managing rates and tax', async () => {
    const st = await call('GET', '/auth/status');
    expect(st.approvalsRequired).toBe(false);
    expect(st.permissions).not.toContain('rate.approve');
    expect(st.permissions).not.toContain('tax.approve');
    expect(st.permissions).not.toContain('template.approve');
    expect(st.permissions).toEqual(expect.arrayContaining(['rate.manage', 'tax.manage', 'rate.write']));
  });

  it('a tax rule is used as soon as it is saved (it still needs its source)', async () => {
    const t = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name: 'CGST', tax_type: 'CGST', rate: '2.5', effective_from: '2026-04-01', source_ref: 'Clause 4' });
    expect((await db.one<{ status: string }>('SELECT status FROM tax_rules WHERE id = $1', [t.id]))!.status).toBe('approved');   // the answer is the saved rule; the approval follows before the next screen reads it
    const noRef = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name: 'Other', tax_type: 'SGST', rate: '2.5', effective_from: '2026-04-01', source_ref: '' }, false);
    expect(noRef.id === undefined || (await db.one<{ status: string }>('SELECT status FROM tax_rules WHERE id = $1', [noRef.id]))!.status === 'draft').toBe(true);
  });

  it('a rate version is approved when it is saved with a valid configuration, and a blank one waits until it is filled in', async () => {
    const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Ciaz 80/8' });
    const v = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [ctx.ciaz], config: cfg('2000'), clause_ref: 'Rate card' });
    expect((await call('GET', `/rate-versions/${v.id}`)).status).toBe('approved');
    // New version from the page: blank until saved
    const blank = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-09-01', vehicle_category_ids: [ctx.ciaz], config: { ...cfg('2000'), components: [] } }, false);
    if (blank.id) expect((await call('GET', `/rate-versions/${blank.id}`)).status).toBe('draft');
    const next = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-09-01', vehicle_category_ids: [ctx.ciaz], config: cfg('2200'), clause_ref: 'Revised' });
    const after = await db.query<{ version_no: number; status: string; effective_to: string | null }>('SELECT version_no, status, effective_to FROM rate_scheme_versions WHERE scheme_id = $1 ORDER BY version_no', [s.id]);
    const cur = after.find((x) => x.version_no === 1)!;
    expect(cur.status).toBe('approved');
    expect(cur.effective_to).toBe('2026-08-31');   // the earlier version ends the day before the new one starts
    expect((await call('GET', `/rate-versions/${next.id}`)).status).toBe('approved');
  });

  it('an upload that overlaps an approved version is not approved silently', async () => {
    const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Other Ciaz card' });
    const v = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [ctx.ciaz], config: cfg('1900'), clause_ref: 'Duplicate' });
    expect((await call('GET', `/rate-versions/${v.id}`)).status).not.toBe('approved');
  });

  it('a bill template version is ready to use when it is created', async () => {
    await call('POST', '/templates', { client_id: ctx.client, contract_id: ctx.contract, name: 'LR Standard', preset: 'lr_standard' });
    const tpl = (await call('GET', `/templates?clientId=${ctx.client}`))[0];
    expect((await call('GET', `/template-versions/${tpl.versions[0].id}`)).status).toBe('approved');
  });
});
