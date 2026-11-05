/**
 * Rate cards are approved and carry a tax setting, but are never compulsory: a slip or duty with no fitting card can be billed with an amount
 * entered by hand, a card that does not fit is explained (not an error that stops anything), and the invoice can be made, approved and
 * exported (Excel and PDF) with the right tax.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-opt-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.SLIP_READER = 'mock';
process.env.SCANNER_DRIVER = 'mock';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');
const { previewCalculation } = await import('./services/slipCalc.js');
const { DutyInputSchema } = await import('./services/duties.js');

let app: Awaited<ReturnType<typeof buildApp>>;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const ctx: Record<string, any> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', ok = true) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: { authorization: `Bearer ${tokens[who]}` } });
  if (ok && res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 500)}`);
  return { status: res.statusCode, body: res.json() };
}
const card = async (name: string, o: { cat: string; types: string[]; all?: boolean; rate: string; tax?: unknown; from?: string; to?: string }) => {
  const cfg: Record<string, unknown> = { billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: o.rate, unit: 'duty', taxCategory: 'taxable' }] };
  if (o.tax) cfg.tax = o.tax;
  const s = (await call('POST', '/rate-schemes', { contract_id: ctx.contract, name })).body;
  const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: o.from ?? '2026-04-01', effective_to: o.to ?? null, vehicle_category_ids: [o.cat], duty_type_codes: o.types, ...(o.all === undefined ? {} : { all_duty_types: o.all }), config: cfg, clause_ref: 'Test' })).body;
  return { scheme: s.id as string, version: v.id as string };
};
const duty = (cat: string, type: string, reg: string, date = '2026-05-10') => ({ contractId: ctx.contract, vehicleCategoryId: cat, dutyTypeCode: type, dutyDate: date, vehicleRegNo: reg, startKm: '1000', endKm: '1080', startAt: `${date} 08:00`, endAt: `${date} 16:00` });

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
  for (const n of ['Ciaz', 'Dzire', 'Etios', 'Innova']) ctx[n] = (await call('POST', '/vehicle-categories', { name: n })).body.id;
  ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' })).body.id;
  ctx.contract = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Hire', reference_no: 'TDR/01', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' })).body.id;
  const tax = [];
  for (const [n, t] of [['CGST', 'CGST'], ['SGST', 'SGST']]) tax.push((await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name: n, tax_type: t, rate: '2.5', effective_from: '2026-04-01', source_ref: 'Test clause' })).body);
  for (const t of tax) await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
  await call('POST', '/templates', { client_id: ctx.client, contract_id: ctx.contract, name: 'Bill', preset: 'lr_standard' });
  const tpl = (await call('GET', `/templates?clientId=${ctx.client}`)).body[0];
  await call('POST', `/template-versions/${tpl.versions[0].id}/approve`, { previewReviewed: true }, 'approver');
}, 90_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('approving the existing rate cards', () => {
  it('approves cards that are waiting or still drafts, leaving ended and duplicate ones, and changes no rate or date', async () => {
    ctx.A = await card('Ciaz local 12% extra', { cat: ctx.Ciaz, types: ['LOCAL'], rate: '2000', tax: { taxable: true, rate: '12', mode: 'extra' } });
    ctx.B = await card('Ciaz outstation non-taxable', { cat: ctx.Ciaz, types: ['OUTSTATION'], rate: '3000', tax: { taxable: false } });
    ctx.C = await card('Dzire no duty type', { cat: ctx.Dzire, types: [], all: false, rate: '1800' });
    ctx.F = await card('Etios local 5% included', { cat: ctx.Etios, types: ['LOCAL'], rate: '1050', tax: { taxable: true, rate: '5', mode: 'included' } });
    ctx.D = await card('Innova all duty types', { cat: ctx.Innova, types: [], rate: '2400' });   // an old-style card: no duty type, no tax setting
    ctx.E = await card('Ended card', { cat: ctx.Ciaz, types: ['LOCAL'], rate: '1500', from: '2025-01-01', to: '2025-03-31' });
    await call('POST', `/rate-versions/${ctx.A.version}/submit`, {});   // A is waiting; the rest are still drafts
    const dup = (await call('POST', `/rate-versions/${ctx.D.version}/clone`, {})).body;   // a repeat of D
    const before = await db.query<Record<string, any>>('SELECT id, effective_from, effective_to, config->\'components\' AS comps, vehicle_category_ids, duty_type_codes FROM rate_scheme_versions ORDER BY id');
    const r = (await call('POST', '/rate-versions/approve-existing', {}, 'approver')).body;
    expect(r.retiredDuplicates).toBe(1);
    expect(r.approved).toBe(4);   // A, B, D, F; the ended card is left, and C has no duty type chosen so it waits
    expect(r.skipped.map((x: any) => x.name)).toEqual(['Dzire no duty type v1']);
    expect(r.skipped[0].reason).toMatch(/no duty type/i);
    const st = Object.fromEntries((await db.query<{ id: string; status: string }>('SELECT id, status FROM rate_scheme_versions')).map((x) => [x.id, x.status]));
    expect(st[ctx.A.version]).toBe('approved'); expect(st[ctx.B.version]).toBe('approved'); expect(st[ctx.D.version]).toBe('approved');
    expect(st[dup.id]).toBe('retired');
    expect(st[ctx.E.version]).toBe('draft');
    const after = await db.query<Record<string, any>>('SELECT id, effective_from, effective_to, config->\'components\' AS comps, vehicle_category_ids, duty_type_codes FROM rate_scheme_versions ORDER BY id');
    expect(JSON.stringify(after)).toEqual(JSON.stringify(before));   // rates, dates, categories and duty types are untouched
    expect((await call('POST', '/rate-versions/approve-existing', {}, 'operator', false)).status).toBe(403);
  });
});

describe('tax set on the rate card', () => {
  const calc = async (cat: string, type: string, schemeId: string | null = null, date = '2026-05-10', manual: string | null = null) => previewCalculation(db, DutyInputSchema.parse(duty(cat, type, 'DL1CAA9999', date)), schemeId, manual);
  it('a taxable card uses its own GST rate', async () => {
    const p = await calc(ctx.Ciaz, 'LOCAL');
    expect(p.status).toBe('ok');
    expect(p.totals).toMatchObject({ taxable: '2000.00', tax: '240.00', total: '2240.00' });   // 12% from the card, not the contract's 2.5 + 2.5
    expect(p.taxLines.map((x) => x.name)).toEqual(['GST @ 12%']);
  });
  it('a non-taxable card adds no GST', async () => {
    const p = await calc(ctx.Ciaz, 'OUTSTATION');
    expect(p.totals).toMatchObject({ taxable: '0.00', nonTaxable: '3000.00', tax: '0.00', total: '3000.00' });
  });
  it('a card with GST included carves the tax out of the price', async () => {
    const p = await calc(ctx.Etios, 'LOCAL');
    expect(p.totals).toMatchObject({ taxable: '1000.00', tax: '50.00', total: '1050.00' });
  });
  it('a card with no tax setting still follows the contract rules, as before', async () => {
    const p = await calc(ctx.Innova, 'LOCAL');
    expect(p.totals).toMatchObject({ taxable: '2400.00', tax: '120.00', total: '2520.00' });
  });
  it('the tax setting can be changed in bulk and is recorded', async () => {
    const r = (await call('POST', '/rate-versions/tax-config', { items: [{ id: ctx.D.version, taxable: false }] }, 'approver')).body;
    expect(r.changed).toBe(1);
    expect((await calc(ctx.Innova, 'LOCAL')).totals).toMatchObject({ tax: '0.00', total: '2400.00' });
    await call('POST', '/rate-versions/tax-config', { items: [{ id: ctx.D.version, taxable: true }] }, 'approver');   // back to the contract's rules
    expect((await calc(ctx.Innova, 'LOCAL')).totals).toMatchObject({ tax: '120.00' });
    expect((await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_events WHERE action = 'set_tax_config'`))!.n).toBe(2);
  });
});

describe('a card that does not fit is explained, not blocking', () => {
  it('gives the exact reason for each kind of mismatch', async () => {
    const mk = (cat: string, type: string, date = '2026-05-10') => DutyInputSchema.parse(duty(cat, type, 'DL1CAA9998', date));
    const noType = await previewCalculation(db, mk(ctx.Dzire, 'LOCAL'), ctx.C.scheme);
    expect(noType.status).toBe('review');
    expect(noType.message).toMatch(/not approved yet/i);   // it cannot be approved until a duty type (or all duty types) is chosen
    const wrongType = await previewCalculation(db, mk(ctx.Ciaz, 'OUTSTATION'), ctx.A.scheme);
    expect(wrongType.message).toMatch(/duty type LOCAL, but this slip's duty type is "OUTSTATION"/);
    const wrongCat = await previewCalculation(db, mk(ctx.Etios, 'LOCAL'), ctx.A.scheme);
    expect(wrongCat.message).toMatch(/card is for Ciaz/);
    const early = await previewCalculation(db, mk(ctx.Ciaz, 'LOCAL', '2026-03-01'), ctx.A.scheme);
    expect(early.message).toMatch(/outside the card's dates/);
    const notApproved = await previewCalculation(db, mk(ctx.Ciaz, 'LOCAL'), ctx.E.scheme);
    expect(notApproved.message).toMatch(/not approved yet/i);
    expect(noType.reasons!.length).toBeGreaterThan(0);
  });
});

describe('an invoice without a rate card for every duty', () => {
  const q = () => `contractId=${ctx.contract}&periodStart=2026-05-01&periodEnd=2026-05-31`;
  const body = (ids: string[], extra: Record<string, unknown> = {}) => ({ contractId: ctx.contract, periodStart: '2026-05-01', periodEnd: '2026-05-31', dutyIds: ids, ...extra });
  it('shows a duty with no fitting card as not billable yet, and lets an amount be entered by hand', async () => {
    await call('POST', '/duties/bulk', { rows: [duty(ctx.Ciaz, 'LOCAL', 'DL1CAA0001'), duty(ctx.Etios, 'LOCAL', 'DL1CAA0002'), duty(ctx.Dzire, 'LOCAL', 'DL1CAA0003'), duty(ctx.Ciaz, 'OUTSTATION', 'DL1CAA0004', '2026-05-11')] }, 'operator');
    const l = (await call('GET', `/invoice-builder/duties?${q()}`)).body;
    const by = Object.fromEntries(l.duties.map((d: any) => [d.vehicleRegNo, d]));
    ctx.ids = Object.fromEntries(l.duties.map((d: any) => [d.vehicleRegNo, d.id]));
    expect(by.DL1CAA0001.eligible).toBe(true);
    expect(by.DL1CAA0003.eligible).toBe(false);   // Dzire's card has no duty type: nothing is assumed, nothing is zero-filled
    expect(by.DL1CAA0003.amount).toBeNull();
    expect((await call('PUT', `/invoice-builder/duties/${ctx.ids.DL1CAA0003}/manual-amount`, { amount: '-5' }, 'admin', false)).status).toBe(400);
    await call('PUT', `/invoice-builder/duties/${ctx.ids.DL1CAA0003}/manual-amount`, { amount: '1500', note: 'Agreed on the phone' });
    const l2 = (await call('GET', `/invoice-builder/duties?${q()}`)).body;
    const d3 = l2.duties.find((d: any) => d.vehicleRegNo === 'DL1CAA0003');
    expect(d3).toMatchObject({ eligible: true, amount: '1500.00', manualAmount: '1500.00' });
  });

  it('summarises with the tax chosen on the invoice for the hand-entered amounts', async () => {
    const ids = [ctx.ids.DL1CAA0001, ctx.ids.DL1CAA0002, ctx.ids.DL1CAA0003];
    const none = (await call('POST', '/invoice-builder/summary', body(ids, { manualTax: { mode: 'non_taxable' } }))).body;
    expect(none).toMatchObject({ duties: 3, basicAmount: '3000.00', nonTaxable: '1500.00', gst: '290.00', finalAmount: '4790.00' });   // 2000 + 1000 taxed (GST 240 + 50); the 1500 is not taxed
    const custom = (await call('POST', '/invoice-builder/summary', body(ids, { manualTax: { mode: 'custom', rate: '18' } }))).body;
    expect(custom).toMatchObject({ basicAmount: '4500.00', nonTaxable: '0.00', gst: '560.00', finalAmount: '5060.00' });   // 240 + 50 + 270
    expect((await call('POST', '/invoice-builder/summary', body(ids, { manualTax: { mode: 'custom' } }), 'admin', false)).status).toBe(400);   // a custom tax needs a rate
  });

  it('generates the invoice with no card for one duty, then approves it and exports Excel and PDF', async () => {
    const ids = [ctx.ids.DL1CAA0001, ctx.ids.DL1CAA0002, ctx.ids.DL1CAA0003];
    const inv = (await call('POST', '/invoice-builder/generate', body(ids, { manualTax: { mode: 'custom', rate: '18' } }))).body;
    expect(inv.totals).toMatchObject({ taxableValue: '4500.00', taxTotal: '560.00', grandTotal: '5060.00' });
    const bill = (await call('GET', `/bills/${inv.billId}`)).body;
    expect(bill.manual_tax).toMatchObject({ mode: 'custom', rate: '18' });
    expect(bill.exceptions.filter((e: any) => e.severity === 'error')).toEqual([]);   // a missing card is not an error
    for (const e of bill.exceptions.filter((x: any) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked (test)' });
    await call('POST', `/bills/${inv.billId}/submit-review`, {}, 'operator');
    await call('POST', `/bills/${inv.billId}/approve`, {}, 'approver');
    // Sent / paid tracking: only an approved bill can be marked paid, the amounts are untouched, and it can be undone.
    expect((await call('POST', `/bills/${inv.billId}/mark-paid`, { paid_on: '2026-11-20', reference: 'UTR123' }, 'approver')).body.paid_at).toBe('2026-11-20');
    expect((await call('GET', `/bills/${inv.billId}`)).body).toMatchObject({ paid_at: '2026-11-20', payment_ref: 'UTR123', grand_total: '5060.00' });
    await call('POST', `/bills/${inv.billId}/mark-unpaid`, {}, 'approver');
    expect((await call('GET', `/bills/${inv.billId}`)).body.paid_at).toBeNull();
    const gen = (await call('POST', `/bills/${inv.billId}/generate`, {}, 'approver')).body;
    expect(gen.reconciliation.checks.filter((c: any) => !c.ok)).toEqual([]);
    const dl = async (id: string) => (await app.inject({ method: 'GET', url: `/api/files/${id}/download`, headers: { authorization: `Bearer ${tokens.admin}` } })).rawPayload;
    expect((await dl(gen.files.pdf)).subarray(0, 5).toString()).toBe('%PDF-');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((await dl(gen.files.xlsx)) as unknown as ArrayBuffer);
    const texts: string[] = [];
    const nums: number[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => { const v = c.value as { result?: unknown } | null; if (typeof c.value === 'number') nums.push(c.value); else if (v && typeof v === 'object' && typeof v.result === 'number') nums.push(v.result); else if (typeof c.value === 'string') texts.push(c.value); }));
    expect(texts).toEqual(expect.arrayContaining(['GST 12%', 'GST 5%', 'GST 18%']));   // each rate card's own GST, once each
    // The workbook carries live formulas even though this contract is not on LR exact arithmetic: amount lines, taxable total, tax and total.
    const formulas: string[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => { const v = c.value as { formula?: string } | null; if (v && typeof v === 'object' && v.formula) formulas.push(v.formula); }));
    expect(formulas.filter((f) => /^ROUND\(E\d+\*F\d+,2\)$/.test(f)).length).toBeGreaterThanOrEqual(3);
    // (this bill mixes three different tax treatments, so its totals are written as figures; a one-tax bill gets the formulas, see below)
    expect(nums).toContain(5060);   // the printed total
    expect(nums).toContain(1500);   // the amount entered by hand
  }, 120_000);

  it('a one-tax bill on the default arithmetic has live formulas for the amounts, the taxable total, the tax and the rounded total', async () => {
    await call('POST', '/duties/bulk', { rows: [duty(ctx.Ciaz, 'LOCAL', 'DL1CAA0101', '2026-06-10'), duty(ctx.Ciaz, 'LOCAL', 'DL1CAA0102', '2026-06-11')] }, 'operator');
    const l = (await call('GET', `/invoice-builder/duties?contractId=${ctx.contract}&periodStart=2026-06-01&periodEnd=2026-06-30`)).body;
    const inv = (await call('POST', '/invoice-builder/generate', { contractId: ctx.contract, periodStart: '2026-06-01', periodEnd: '2026-06-30', dutyIds: l.duties.map((d: any) => d.id) })).body;
    expect(inv.totals).toMatchObject({ taxableValue: '4000.00', taxTotal: '480.00', grandTotal: '4480.00' });
    const bill = (await call('GET', `/bills/${inv.billId}`)).body;
    for (const e of bill.exceptions.filter((x: any) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked (test)' });
    await call('POST', `/bills/${inv.billId}/submit-review`, {}, 'operator');
    await call('POST', `/bills/${inv.billId}/approve`, {}, 'approver');
    const gen = (await call('POST', `/bills/${inv.billId}/generate`, {}, 'approver')).body;
    const buf = (await app.inject({ method: 'GET', url: `/api/files/${gen.files.xlsx}/download`, headers: { authorization: `Bearer ${tokens.admin}` } })).rawPayload;
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const formulas: string[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => { const v = c.value as { formula?: string } | null; if (v && typeof v === 'object' && v.formula) formulas.push(v.formula); }));
    expect(formulas.filter((f) => /^ROUND\(E\d+\*F\d+,2\)$/.test(f))).toHaveLength(2);
    expect(formulas.some((f) => /^SUM\(H\d+:H\d+\)$/.test(f))).toBe(true);
    expect(formulas.filter((f) => /^ROUND\(H\d+\*12\/100,2\)$/.test(f))).toHaveLength(1);   // one GST row, not two
    expect(formulas.some((f) => /^ROUND\(SUM\(.+\),0\)$/.test(f))).toBe(true);
  }, 120_000);

  it('a non-taxable card bills without GST, and nothing can be billed twice', async () => {
    const inv = (await call('POST', '/invoice-builder/generate', body([ctx.ids.DL1CAA0004]))).body;
    expect(inv.totals).toMatchObject({ taxTotal: '0.00', nonTaxableTotal: '3000.00', grandTotal: '3000.00' });
    expect((await call('POST', '/invoice-builder/generate', body([ctx.ids.DL1CAA0004]), 'admin', false)).status).toBe(409);
    expect((await call('PUT', `/invoice-builder/duties/${ctx.ids.DL1CAA0003}/manual-amount`, { amount: '1' }, 'admin', false)).status).toBe(409);   // on a bill now
  });

  it('applying a card that does not fit leaves the slips as they were and does not stop anything', async () => {
    const b = '----opt';
    const part = (i: number) => Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x40 + i]), Buffer.from('\r\n')]);
    const up = await app.inject({ method: 'POST', url: '/api/scan/batches/upload', payload: Buffer.concat([part(1), part(2), Buffer.from(`--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}`, authorization: `Bearer ${tokens.admin}` } });
    const batch = up.json().batch.id;
    const pages = (await call('GET', `/scan/batches/${batch}`)).body.pages;
    const rids: string[] = [];
    for (let i = 0; i < 2; i++) {
      await call('POST', `/scan/pages/${pages[i].id}/read`, {});
      const rid = (await call('GET', `/scan/batches/${batch}`)).body.pages[i].reading.id;
      rids.push(rid);
      await call('PUT', `/scan/readings/${rid}`, { contractId: ctx.contract, edited: { department: 'Test Directorate', duty_date: '12-05-2026', vehicle_no: `DL1CBB000${i}`, vehicle_category: 'Dzire', opening_km: '1000', closing_km: '1080', reporting_time: '08:00', release_time: '16:00', toll: '', parking: '', other_expenses: '' } });
    }
    const r = (await call('POST', `/scan/batches/${batch}/apply-rate-card`, { readingIds: rids, schemeId: ctx.C.scheme })).body;
    expect(r.applied).toBe(0);
    expect(r.skipped).toHaveLength(2);
    expect(r.skipped[0].reason).toMatch(/not approved yet/i);
    // enter the amount for both at once, then save: the duties carry it and nothing is zero-filled
    expect((await call('GET', `/scan/batches/${batch}/calculations`)).body[rids[0]].amount ?? null).toBeNull();
    await call('POST', `/scan/batches/${batch}/apply-manual`, { readingIds: rids, amount: '1750' });
    const c = (await call('GET', `/scan/batches/${batch}/calculations`)).body[rids[0]];
    expect(c).toMatchObject({ status: 'ok', manual: true, manualAmount: '1750.00' });
    expect(c.totals.subtotal).toBe('1750.00');
    const saved = (await call('POST', `/scan/batches/${batch}/save`, { defaultDutyType: 'LOCAL' })).body;
    expect(saved.summary).toMatchObject({ add: 2, error: 0 });
    const row = await db.one<{ manual_amount: string }>(`SELECT manual_amount FROM duties WHERE vehicle_reg_no = 'DL1CBB0000'`);
    expect(row!.manual_amount).toBe('1750.00');
  });
});

describe('explaining a card with no duty type', () => {
  it('says the card has no duty type when it is approved but not marked for all duty types', async () => {
    const { explainMismatch } = await import('./engine/bill.js');
    const v = { id: 'v', schemeId: 's', schemeName: 'X', versionNo: 1, status: 'approved', effectiveFrom: '2026-04-01', effectiveTo: null, vehicleCategoryIds: [], dutyTypeCodes: [], allDutyTypes: false, config: {} } as never;
    const d = { id: 'd', dutyDate: '2026-05-10', vehicleRegNo: 'X', vehicleCategoryId: null, dutyTypeCode: 'LOCAL', startKm: null, endKm: null, startAt: null, endAt: null, toll: null, parking: null, otherCharges: null };
    expect(explainMismatch(d, [v]).join(' ')).toMatch(/no duty type set/i);
    expect(explainMismatch(d, [{ ...(v as object), allDutyTypes: true } as never])).toEqual([]);
  });
});

describe('a contract with no tax rules', () => {
  it('uses the GST set on the rate card, and a card with no setting only warns', async () => {
    const k2 = (await call('POST', '/contracts', { client_id: ctx.client, title: 'No tax rules', reference_no: 'TDR/02', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active' })).body.id;
    const mk = async (name: string, cat: string, rate: string, tax?: unknown) => {
      const cfg: Record<string, unknown> = { billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } }, components: [{ code: 'BASE', label: 'Base duty', quantityExpr: '1', rate, unit: 'duty', taxCategory: 'taxable' }] };
      if (tax) cfg.tax = tax;
      const s = (await call('POST', '/rate-schemes', { contract_id: k2, name })).body;
      const v = (await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [cat], config: cfg, clause_ref: 'Test' })).body;
      await call('POST', `/rate-versions/${v.id}/submit`, {});
      await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
    };
    await mk('With GST', ctx.Ciaz, '2000', { taxable: true, rate: '12', mode: 'extra' });
    await mk('No tax setting', ctx.Innova, '2400');
    const d = (cat: string) => DutyInputSchema.parse({ ...duty(cat, 'LOCAL', 'DL1CAA7000'), contractId: k2 });
    const gst = await previewCalculation(db, d(ctx.Ciaz));
    expect(gst.status).toBe('ok');
    expect(gst.totals).toMatchObject({ tax: '240.00', total: '2240.00' });
    expect(gst.message).toBeNull();
    const none = await previewCalculation(db, d(ctx.Innova));
    expect(none.status).toBe('ok');   // not an error: the amount is shown and the note says no GST was added
    expect(none.totals).toMatchObject({ subtotal: '2400.00', tax: '0.00' });
    expect(none.message).toMatch(/No GST was added/);
  });
});

describe('rules from the billing guide', () => {
  it('bills at least the minimum kilometres per duty day, counting a long duty as several days', async () => {
    const { calculateDuty } = await import('./engine/duty.js');
    const { RateConfigSchema } = await import('./engine/types.js');
    const cfg = RateConfigSchema.parse({ billingModel: 'daily_package', params: { includedKm: '60', includedHours: '8', minKmPerDay: '80' }, components: [{ code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '10', unit: 'km', taxCategory: 'taxable' }] });
    const v = { id: 'v', schemeId: 's', schemeName: 'X', versionNo: 1, status: 'approved', effectiveFrom: '2026-04-01', effectiveTo: null, vehicleCategoryIds: [], dutyTypeCodes: [], config: cfg };
    const base = { id: 'd', dutyDate: '2026-05-10', vehicleRegNo: 'X', vehicleCategoryId: null, dutyTypeCode: 'LOCAL', startKm: '1000', toll: null, parking: null, otherCharges: null };
    const one = calculateDuty({ ...base, endKm: '1050', startAt: '2026-05-10 08:00', endAt: '2026-05-10 16:00' }, v, false);
    expect(one.variables.billable_km).toBe('80');   // 50 km driven, 80 km minimum
    expect(one.variables.extra_km).toBe('20');
    const two = calculateDuty({ ...base, endKm: '1100', startAt: '2026-05-10 08:00', endAt: '2026-05-11 14:00' }, v, false);
    expect(two.variables.duty_days).toBe('2');
    expect(two.variables.billable_km).toBe('160');   // 100 km driven, 2 days × 80 km minimum
  });
  it('numbers invoices like LR-2611-0007 with {YY}{MM} and a four-digit sequence', async () => {
    const { nextBillNo } = await import('./services/billing.js');
    await db.query(`UPDATE contracts SET bill_no_format = 'LR-{YY}{MM}-{SEQ:4}' WHERE id = $1`, [ctx.contract]);
    const row = { id: 'x', client_id: ctx.client, contract_id: ctx.contract, period_start: '2026-11-01', period_end: '2026-11-30', bill_date: '2026-11-05' } as never;
    expect(await nextBillNo(db, row)).toBe('LR-2611-0001');
  });
});

describe('applying a card never stops on a missing time or an old date', () => {
  it('applies the card when the release time is missing (extra hours left out, with a note) and can apply anyway to a slip dated before the card', async () => {
    const b = '----len';
    const part = (i: number) => Buffer.concat([Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="s${i}.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`), Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x50 + i]), Buffer.from('\r\n')]);
    const up = await app.inject({ method: 'POST', url: '/api/scan/batches/upload', payload: Buffer.concat([part(1), part(2), Buffer.from(`--${b}--\r\n`)]), headers: { 'content-type': `multipart/form-data; boundary=${b}`, authorization: `Bearer ${tokens.admin}` } });
    const batch = up.json().batch.id;
    const pages = (await call('GET', `/scan/batches/${batch}`)).body.pages;
    const rids: string[] = [];
    const slips = [{ date: '12-06-2026', release: '' }, { date: '30-10-2024', release: '16:00' }];
    for (let i = 0; i < 2; i++) {
      await call('POST', `/scan/pages/${pages[i].id}/read`, {});
      const rid = (await call('GET', `/scan/batches/${batch}`)).body.pages[i].reading.id;
      rids.push(rid);
      await call('PUT', `/scan/readings/${rid}`, { contractId: ctx.contract, edited: { department: 'Test Directorate', duty_date: slips[i].date, vehicle_no: `DL1CCC000${i}`, vehicle_category: 'Ciaz', opening_km: '1000', closing_km: '1090', reporting_time: '08:00', release_time: slips[i].release, toll: '', parking: '', other_expenses: '' } });
    }
    const r = (await call('POST', `/scan/batches/${batch}/apply-rate-card`, { readingIds: rids, schemeId: ctx.A.scheme })).body;
    expect(r.applied).toBe(1);   // the one with no release time is applied
    expect(r.notes[0].message).toMatch(/release time is missing.*extra hours/i);
    expect(r.skipped).toHaveLength(1);   // the 2024 slip is outside the card's dates
    expect(r.skipped[0].reason).toMatch(/outside the card's dates/);
    const any = (await call('POST', `/scan/batches/${batch}/apply-rate-card`, { readingIds: [rids[1]], schemeId: ctx.A.scheme, ignoreDates: true })).body;
    expect(any.applied).toBe(1);
    const calc = (await call('GET', `/scan/batches/${batch}/calculations`)).body;
    expect(calc[rids[0]]).toMatchObject({ status: 'ok', rateCardChosen: true });
    expect(calc[rids[1]]).toMatchObject({ status: 'ok', rateCardChosen: true });
    expect(calc[rids[1]].lines.some((l: any) => l.label === 'Extra km')).toBe(false);   // card A has only a base charge; 90 km is within nothing extra here
    expect(calc[rids[1]].totals.subtotal).toBe('2000.00');
  });
});

describe('the same tax is never charged twice', () => {
  it('uses one rule per tax type when two rules of that type are both in force', async () => {
    const { calculateBill } = await import('./engine/bill.js');
    const { RateConfigSchema } = await import('./engine/types.js');
    const cfg = RateConfigSchema.parse({ billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8' }, components: [{ code: 'BASE', label: 'Base', quantityExpr: '1', rate: '1000', unit: 'duty', taxCategory: 'taxable' }] });
    const v = { id: 'v', schemeId: 's', schemeName: 'X', versionNo: 1, status: 'approved', effectiveFrom: '2026-04-01', effectiveTo: null, vehicleCategoryIds: [], dutyTypeCodes: [], config: cfg };
    const rule = (id: string, type: string, from: string) => ({ id, name: type, taxType: type, rate: '2.5', effectiveFrom: from, effectiveTo: '2026-11-04', status: 'approved', sourceRef: 'x' });
    const out = calculateBill({
      periodStart: '2026-10-01', periodEnd: '2026-10-31', schemes: [v], settings: { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'none' },
      taxRules: [rule('1', 'CGST', '2026-04-01'), rule('2', 'SGST', '2026-04-01'), rule('3', 'CGST', '2026-10-29'), rule('4', 'SGST', '2026-10-29')],
      duties: [{ id: 'd', dutyDate: '2026-10-10', vehicleRegNo: 'X', vehicleCategoryId: null, dutyTypeCode: 'LOCAL', startKm: '1000', endKm: '1050', startAt: '2026-10-10 08:00', endAt: '2026-10-10 14:00', toll: null, parking: null, otherCharges: null }],
    });
    expect(out.taxLines.map((t) => t.taxType)).toEqual(['CGST', 'SGST']);
    expect(out.totals).toMatchObject({ taxTotal: '50.00', grandTotal: '1050.00' });
  });
});
