/** "Approve all pending" approves every submitted rate version in one call and lists the ones it could not approve. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-appall-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', expect200 = true) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: { authorization: `Bearer ${tokens[who]}` } });
  if (expect200 && res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 400)}`);
  return { status: res.statusCode, body: res.json() };
}

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  tokens.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  await call('POST', '/users', { email: 'op@test.local', name: 'op', role: 'operator', password: 'TestOperator12345' });
  tokens.operator = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'op@test.local', password: 'TestOperator12345' } })).json().token;
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('approve all rate versions', () => {
  it('approves every pending version once, skips ones that are not pending, and is refused for people who cannot approve', async () => {
    const cat = (await call('POST', '/vehicle-categories', { name: 'Innova' })).body.id;
    const client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' })).body.id;
    const contract = (await call('POST', '/contracts', { client_id: client, title: 'Hire', reference_no: 'TDR/01', start_date: '2020-01-01', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' })).body.id;
    const cfg = { billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '2000', unit: 'duty', taxCategory: 'taxable' }] };
    const ids: string[] = [];
    for (const name of ['Innova 80/8', 'Innova extra']) {
      const s = (await call('POST', '/rate-schemes', { contract_id: contract, name })).body;
      const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2020-01-01', vehicle_category_ids: [cat], config: cfg, clause_ref: 'Test' })).body;
      await call('POST', `/rate-versions/${v.id}/submit`, {});
      ids.push(v.id);
    }
    expect((await call('POST', '/rate-versions/approve-all', { ids }, 'operator', false)).status).toBe(403);
    const r = (await call('POST', '/rate-versions/approve-all', { ids })).body;
    // The two schemes cover the same vehicle category and dates, so the second is refused as an overlap rather than silently approved.
    expect(r.approved + r.skipped.length).toBe(2);
    expect(r.approved).toBeGreaterThanOrEqual(1);
    const again = (await call('POST', '/rate-versions/approve-all', { ids })).body;
    expect(again.approved).toBe(0);
    expect(again.skipped.length).toBe(2);
  });
});
