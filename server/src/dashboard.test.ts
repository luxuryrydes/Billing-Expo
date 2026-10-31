/**
 * The numbers on the home dashboard, on an in-memory database: an empty system, one with work waiting
 * for approval, and one with an approved bill that must appear in this month's total, the monthly chart,
 * the department ranking and the bill pipeline.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-dash-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const PW = { admin: 'TestAdmin12345', operator: 'TestOperator12345', approver: 'TestApprover12345' };
const ctx: Record<string, any> = {};

async function call(method: string, url: string, body?: unknown, who = 'operator') {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 600)}`);
  return res.json();
}
const dash = () => call('GET', '/dashboard');

const now = new Date();
const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
  tokens.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: PW.admin } })).json().token;
  for (const role of ['operator', 'approver'] as const) {
    await call('POST', '/users', { email: `${role}@test.local`, name: role, role, password: PW[role] }, 'admin');
    tokens[role] = (await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${role}@test.local`, password: PW[role] } })).json().token;
  }
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('dashboard numbers', () => {
  it('an empty system shows zeros, twelve empty months and an unfinished set-up', async () => {
    const d = await dash();
    expect(d.attention).toEqual({ dutiesWithErrors: 0, slipsToSave: 0, dutiesToVerify: 0, billsToApprove: 0, ratesToApprove: 0, taxToApprove: 0, openExceptions: 0 });
    expect(d.byMonth).toHaveLength(12);
    expect(d.byMonth[11].month).toBe(ym);
    expect(d.byMonth.every((m: any) => m.total === '0.00' || m.total === '0')).toBe(true);
    expect(d.month).toMatchObject({ key: ym, bills: 0, duties: 0, notBilled: 0, billedChangePct: null });
    expect(d.topDepartments).toEqual([]);
    expect(d.pipeline).toEqual({ preparing: 0, review: 0, approved: 0, generated: 0, submitted: 0 });
    expect(d.setup).toMatchObject({ supplier: 0, clients: 0, rates: 0, duties: 0, bills: 0 });
  });

  it('counts the work waiting for a person', async () => {
    await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true }, 'admin');
    ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' }, 'admin')).id;
    ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' }, 'admin')).id;
    ctx.contract = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Vehicle hire', reference_no: 'TDR/01', start_date: '2020-01-01', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' }, 'admin')).id;
    ctx.tax = [];
    for (const [name, type] of [['CGST (test)', 'CGST'], ['SGST (test)', 'SGST']]) ctx.tax.push(await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name, tax_type: type, rate: '2.5', effective_from: '2020-01-01', source_ref: 'Test clause' }, 'admin'));
    const cfg = {
      billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } },
      components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '2000', unit: 'duty', taxCategory: 'taxable' }],
    };
    const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Innova package' }, 'admin');
    ctx.version = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2020-01-01', vehicle_category_ids: [ctx.innova], config: cfg, clause_ref: 'Test' }, 'admin');
    await call('POST', `/rate-versions/${ctx.version.id}/submit`, {}, 'admin');
    const d = await dash();
    expect(d.attention).toMatchObject({ ratesToApprove: 1, taxToApprove: 2 });
    expect(d.setup).toMatchObject({ supplier: 1, clients: 1, rates: 1, approved_rates: 0 });
  });

  it('shows duties entered this month that are not billed yet', async () => {
    for (const t of ctx.tax) await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
    await call('POST', `/rate-versions/${ctx.version.id}/approve`, {}, 'approver');
    const row = (reg: string) => ({ contractId: ctx.contract, vehicleCategoryId: ctx.innova, dutyTypeCode: 'LOCAL', dutyDate: `${ym}-01`, vehicleRegNo: reg, startKm: '1000', endKm: '1060', startAt: `${ym}-01 09:00`, endAt: `${ym}-01 16:00` });
    await call('POST', '/duties/bulk', { rows: [row('DL1CAA1001'), row('DL1CAA1002')] });
    const d = await dash();
    expect(d.attention).toMatchObject({ ratesToApprove: 0, taxToApprove: 0, dutiesToVerify: 2 });
    expect(d.month).toMatchObject({ duties: 2, notBilled: 2, bills: 0 });
    expect(d.setup).toMatchObject({ duties: 2, approved_rates: 1, bills: 0 });
  });

  it('an approved bill appears in the month total, the chart, the ranking and the pipeline', async () => {
    await call('POST', '/templates', { client_id: ctx.client, contract_id: ctx.contract, name: 'Bill' }, 'admin');
    const tpl = (await call('GET', `/templates?clientId=${ctx.client}`))[0];
    await call('POST', `/template-versions/${tpl.versions[0].id}/approve`, { previewReviewed: true }, 'approver');
    const bill = await call('POST', '/bills', { contract_id: ctx.contract, period_start: `${ym}-01`, period_end: `${ym}-${String(lastDay).padStart(2, '0')}`, bill_date: `${ym}-01` });
    await call('POST', `/bills/${bill.id}/calculate`, {});
    let b = await call('GET', `/bills/${bill.id}`);
    for (const e of b.exceptions.filter((x: any) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked (test)' }, 'admin');
    expect(await dash()).toMatchObject({ pipeline: { preparing: 1 } });
    await call('POST', `/bills/${bill.id}/submit-review`, {});
    expect((await dash()).attention.billsToApprove).toBe(1);
    await call('POST', `/bills/${bill.id}/approve`, {}, 'approver');
    b = await call('GET', `/bills/${bill.id}`);
    // 2 duties × 2000 = 4000 taxable, +5% tax = 4200
    expect(b.grand_total).toBe('4200.00');
    const d = await dash();
    expect(d.month).toMatchObject({ billed: '4200.00', bills: 1, notBilled: 0, billedChangePct: null });
    expect(d.byMonth[11]).toMatchObject({ month: ym, total: '4200.00', bills: 1 });
    expect(d.topDepartments).toEqual([{ id: ctx.client, name: 'Test Directorate', total: '4200.00', bills: 1 }]);
    expect(d.otherDepartments).toBeNull();
    expect(d.pipeline).toMatchObject({ preparing: 0, review: 0, approved: 1 });
    expect(d.attention.billsToApprove).toBe(0);
    expect(d.activity.length).toBeGreaterThan(3);
    expect(d.activity[0]).toHaveProperty('action');
  });
});
