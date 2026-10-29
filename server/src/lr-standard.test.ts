/**
 * The LR Standard invoice end to end on an in-memory database: a template made from the preset, a contract
 * switched to the LR exact arithmetic, a bill through approval, and the generated PDF and Excel.
 * Rates and departments are TEST data. The expected totals come from lr-reference.ts, a port of the
 * source app's arithmetic.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closingTime, refBill, type RefPkg } from './engine/lr-reference.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-lrstd-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');
const { runWorker } = await import('./services/extraction.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const PW = { admin: 'TestAdmin12345', operator: 'TestOperator12345', approver: 'TestApprover12345' };
const ctx: Record<string, string> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', expectStatus = 200) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 800)}`);
  return res.headers['content-type']?.toString().includes('json') ? res.json() : res;
}
const download = async (id: string) => (await app.inject({ method: 'GET', url: `/api/files/${id}/download`, headers: { authorization: `Bearer ${tokens.admin}` } })).rawPayload;

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
}, 60_000);
afterAll(async () => {
  await app?.close();
  await db?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

const PKG: RefPkg = { base: 2400, incKm: 80, incHr: 8, exKm: 20, exHr: 331.43 };
const TRIPS = [
  { km: 80, hr: 8 },
  { km: 95, hr: 10.75, toll: 120 },
  { km: 104, hr: 11.75, parking: 50 },
  { km: 33, hr: 4.25 },
  { km: 120, hr: 11.25, toll: 35 },
];

describe('LR Standard invoice', () => {
  it('sets up a department, an approved rate and tax rules', async () => {
    const r = await call('POST', '/auth/setup', { email: 'admin@test.local', name: 'Admin', password: PW.admin }, 'nobody');
    tokens.admin = r.token;
    for (const role of ['operator', 'approver'] as const) {
      await call('POST', '/users', { email: `${role}@test.local`, name: role, role, password: PW[role] });
      tokens[role] = (await call('POST', '/auth/login', { email: `${role}@test.local`, password: PW[role] }, 'nobody')).token;
    }
    await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', pan: 'TESTP1234A', state_name: 'Delhi', state_code: '07', is_default: true });
    ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' })).id;
    ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'Test Directorate\nCentral Workshop, New Delhi 110003', gstin: '07CLIENTGSTIN1Z' })).id;
    await db.query(`UPDATE clients SET header_title = 'Total Transport Solution and Concept', header_subtitle = 'Sample subtitle line', duty_fields = ARRAY['User Name'] WHERE id = $1`, [ctx.client]);
    // The contract starts on the standard arithmetic; the template button switches it.
    ctx.contract = (await call('POST', '/contracts', {
      client_id: ctx.client, title: 'Vehicle hire 2025', reference_no: 'TDR/2025/01', start_date: '2025-04-01', end_date: '2026-03-31', status: 'active',
      sac_code: '996601', approval_levels: 1, bill_no_format: 'LRTS/{FYS}/{SEQ:4}',
    })).id;
    expect((await call('GET', `/contracts/${ctx.contract}`)).arithmetic).toBe('standard');
    await call('POST', '/vehicles', { registration_no: 'DL1C0012', category_id: ctx.innova });

    for (const [name, type] of [['CGST (test)', 'CGST'], ['SGST (test)', 'SGST']]) {
      const t = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name, tax_type: type, rate: '2.5', effective_from: '2025-04-01', source_ref: 'Test clause 9' });
      await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
    }
    const cfg = {
      billingModel: 'daily_package',
      params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } },
      components: [
        { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '2400', unit: 'duty', taxCategory: 'taxable' },
        { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '20', unit: 'km', taxCategory: 'taxable' },
        { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: '331.43', unit: 'hr', taxCategory: 'taxable' },
        { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
        { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
      ],
    };
    const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Innova package' });
    const v = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2025-04-01', vehicle_category_ids: [ctx.innova], config: cfg, clause_ref: 'Test schedule' });
    await call('POST', `/rate-versions/${v.id}/submit`, {});
    await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
  });

  it('creates the LR Standard template from the preset and switches the contract to LR exact', async () => {
    await call('POST', '/templates', { client_id: ctx.client, contract_id: ctx.contract, name: 'LR Standard', preset: 'lr_standard', lr_arithmetic: true });
    expect((await call('GET', `/contracts/${ctx.contract}`)).arithmetic).toBe('lr_exact');
    // The switch needs a contract
    await call('POST', '/templates', { client_id: ctx.client, name: 'No contract', preset: 'lr_standard', lr_arithmetic: true }, 'admin', 400);
    const tpl = (await call('GET', `/templates?clientId=${ctx.client}`)).find((t: { name: string }) => t.name === 'LR Standard');
    ctx.tv = tpl.versions[0].id;
    const v = await call('GET', `/template-versions/${ctx.tv}`);
    expect(v.layout).toMatchObject({ letterhead: 'box', totalsInTable: true, rowMode: 'block', dateFormat: 'dd.mm.yy' });
    expect(v.layout.columns.map((c: { label: string }) => c.label)).toEqual(['S. NO', 'DATE', 'Car No', 'DESCRIPTION', 'UNIT', 'RATE', 'Non Taxable', 'Amount']);
    const prev = (await call('POST', `/template-versions/${ctx.tv}/preview`, { format: 'pdf' })) as { rawPayload: Buffer };
    expect(prev.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    const prevX = (await call('POST', `/template-versions/${ctx.tv}/preview`, { format: 'xlsx' })) as { rawPayload: Buffer };
    expect(prevX.rawPayload.subarray(0, 2).toString()).toBe('PK');
    await call('POST', `/template-versions/${ctx.tv}/approve`, { previewReviewed: true }, 'approver');
  });

  it('bills five duties and prints the same amounts as the source app', async () => {
    const base = { contractId: ctx.contract, vehicleCategoryId: ctx.innova, dutyTypeCode: 'LOCAL', driverName: 'Test Driver', fieldOfficer: 'Officer A' };
    const rows = TRIPS.map((t, i) => ({
      ...base, dutyDate: `2025-09-${String(10 + i).padStart(2, '0')}`, vehicleRegNo: 'DL1C0012', startKm: '1000', endKm: String(1000 + t.km),
      startAt: `2025-09-${String(10 + i).padStart(2, '0')} 09:00`, endAt: `2025-09-${String(10 + i).padStart(2, '0')} ${closingTime(t.hr)}`,
      toll: t.toll ? String(t.toll) : undefined, parking: t.parking ? String(t.parking) : undefined, customFields: { user_name: 'Officer A' },
    }));
    await call('POST', '/duties/bulk', { rows }, 'operator');
    const bill = await call('POST', '/bills', { contract_id: ctx.contract, period_start: '2025-09-01', period_end: '2025-09-30', bill_date: '2025-10-01' }, 'operator');
    ctx.bill = bill.id;
    expect(bill.template_version_id).toBe(ctx.tv);
    await call('POST', `/bills/${bill.id}/calculate`, {}, 'operator');
    let b = await call('GET', `/bills/${bill.id}`);
    expect(b.exceptions.filter((e: { severity: string }) => e.severity === 'error')).toEqual([]);
    for (const e of b.exceptions.filter((x: { status: string }) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked (test)' });
    const ref = refBill(TRIPS, PKG, { cgst: 2.5, sgst: 2.5 });
    b = await call('GET', `/bills/${bill.id}`);
    expect(b.taxable_value).toBe(ref.taxable.toFixed(2));
    expect(b.non_taxable_total).toBe(ref.nonTaxable.toFixed(2));
    expect(b.grand_total).toBe(`${ref.rounded}.00`);

    await call('POST', `/bills/${bill.id}/submit-review`, {}, 'operator');
    await call('POST', `/bills/${bill.id}/approve`, {}, 'approver');
    const gen = await call('POST', `/bills/${bill.id}/generate`, {}, 'approver');
    expect(gen.reconciliation.checks.filter((c: { ok: boolean }) => !c.ok)).toEqual([]);
    ctx.ref = JSON.stringify(ref);
    ctx.xlsx = gen.files.xlsx;
    ctx.pdf = gen.files.pdf;
  }, 120_000);

  it('the Excel bill has the letterhead, duty blocks, live formulas and the Calculation Kit', async () => {
    const ref = JSON.parse(ctx.ref) as ReturnType<typeof refBill>;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await download(ctx.xlsx)) as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['Bill', 'Calculation Kit']);
    const ws = wb.getWorksheet('Bill')!;
    const texts: string[] = [];
    const formulas: string[] = [];
    ws.eachRow((r) => r.eachCell((c) => {
      const v = c.value as { formula?: string } | null;
      if (v && typeof v === 'object' && 'formula' in v && v.formula) formulas.push(v.formula);
      else if (v != null) texts.push(c.text);
    }));
    for (const t of ['Total Transport Solution and Concept', 'Test Directorate', 'CLIENT GSTIN - 07CLIENTGSTIN1Z', 'User Name: Officer A', 'SAC :- 996601', 'PAN NO :- TESTP1234A', 'S. NO', 'Car No', 'Non Taxable',
      'Duty for ( Innova )', 'Upto : 80 kms/8 hrs duty', 'Total running : (95 kms/10.75 hrs)', 'Extra Hrs:', 'Extra Kms:', 'Toll Tax & Parking', 'Taxable Amount', 'CGST 2.5%', 'SGST 2.5%', 'Total Amount', 'L.R TAXI SERVICES']) {
      expect(texts.some((x) => x.includes(t)), `missing "${t}"`).toBe(true);
    }
    expect(texts.some((x) => /^BILL NO : LRTS\/\d{2}-\d{2}\/\d{4}$/.test(x))).toBe(true);
    expect(texts).toContain('10.09.25');
    // Live formulas: unit × rate per line, SUM ranges, ROUND on tax rows and on the total.
    expect(formulas.filter((f) => /^E\d+\*F\d+$/.test(f)).length).toBeGreaterThanOrEqual(10);
    expect(formulas.some((f) => /^SUM\(H\d+:H\d+\)$/.test(f))).toBe(true);
    expect(formulas.filter((f) => /^ROUND\(H\d+\*2\.5\/100,2\)$/.test(f))).toHaveLength(2);
    expect(formulas.some((f) => /^ROUND\(SUM\(.+\),0\)$/.test(f))).toBe(true);
    // The cached results are the calculated figures, so the file reconciles before Excel recalculates.
    const cached: number[] = [];
    ws.eachRow((r) => r.eachCell((c) => { const v = c.value as { result?: unknown } | null; if (v && typeof v === 'object' && typeof v.result === 'number') cached.push(v.result); }));
    expect(cached).toContain(ref.rounded);
    expect(wb.getWorksheet('Calculation Kit')).toBeTruthy();
  });

  it('the PDF carries the letterhead, the blocks and the brand total', async () => {
    const f = path.join(tmp, 'lr-standard.pdf');
    fs.writeFileSync(f, await download(ctx.pdf));
    const text = (await runWorker(f)).pages.map((p) => p.text).join('\n').replace(/\s+/g, ' ');
    const ref = JSON.parse(ctx.ref) as ReturnType<typeof refBill>;
    for (const t of ['Total Transport Solution and Concept', 'CLIENT GSTIN - 07CLIENTGSTIN1Z', 'SAC :- 996601', 'Duty for ( Innova )', 'Upto : 80 kms/8 hrs duty', 'Total running : (95 kms/10.75 hrs)', 'Taxable Amount', 'CGST 2.5%', 'Total Amount', 'L.R TAXI SERVICES', `${ref.rounded.toLocaleString('en-IN')}.00`]) {
      expect(text, `missing "${t}"`).toContain(t);
    }
  });

  it('a contract on the standard arithmetic is untouched by the new format code', async () => {
    const k = await call('GET', `/contracts/${ctx.contract}`);
    await call('PUT', `/contracts/${ctx.contract}`, { ...k, arithmetic: 'standard', end_date: k.end_date?.slice(0, 10), start_date: k.start_date.slice(0, 10) });
    expect((await call('GET', `/contracts/${ctx.contract}`)).arithmetic).toBe('standard');
  });
});
