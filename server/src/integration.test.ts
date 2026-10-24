/**
 * End-to-end API test on an in-memory PostgreSQL (PGlite): client → contract →
 * tax + rate approval → template → duties (incl. import) → bill → review →
 * approval → Excel/PDF generation with reconciliation → revision.
 * Expected amounts are hand-calculated from the TEST rates defined below.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-test-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};

async function call(method: string, url: string, body?: unknown, who = 'admin', expectStatus = 200) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 800)}`);
  return res.headers['content-type']?.toString().includes('json') ? res.json() : res;
}

function multipart(fields: Record<string, string>, file: { name: string; buf: Buffer; type: string }) {
  const boundary = '----lrtest' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.buf, Buffer.from(`\r\n--${boundary}--\r\n`));
  return { payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}
async function upload(url: string, fields: Record<string, string>, file: { name: string; buf: Buffer; type: string }, who = 'admin') {
  const m = multipart(fields, file);
  const res = await app.inject({ method: 'POST', url: `/api${url}`, payload: m.payload, headers: { ...m.headers, authorization: `Bearer ${tokens[who]}` } });
  if (res.statusCode !== 200) throw new Error(`upload ${url} → ${res.statusCode}: ${res.body}`);
  return res.json();
}

// Test-only credentials for the in-memory database.
const PW = { admin: 'TestAdmin12345', operator: 'TestOperator12345', approver: 'TestApprover12345' };

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

const ctx: Record<string, string> = {};

describe('billing workflow', () => {
  it('requires sign-in and supports first-run setup', async () => {
    await call('GET', '/clients', undefined, 'nobody', 401);
    const st = await call('GET', '/auth/status', undefined, 'nobody');
    expect(st.needsSetup).toBe(true);
    const r = await call('POST', '/auth/setup', { email: 'admin@test.local', name: 'Admin', password: PW.admin }, 'nobody');
    tokens.admin = r.token;
    await call('POST', '/auth/setup', { email: 'x@test.local', name: 'X', password: PW.admin }, 'nobody', 409);
    for (const role of ['operator', 'approver'] as const) {
      await call('POST', '/users', { email: `${role}@test.local`, name: role, role, password: PW[role] });
      tokens[role] = (await call('POST', '/auth/login', { email: `${role}@test.local`, password: PW[role] }, 'nobody')).token;
    }
    await call('POST', '/clients', { name: 'X', short_code: 'X' }, 'operator', 403);
  });

  it('sets up supplier, categories, client and contract', async () => {
    await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true });
    ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' })).id;
    ctx.dzire = (await call('POST', '/vehicle-categories', { name: 'Dzire' })).id;
    ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' })).id;
    ctx.contract = (await call('POST', '/contracts', {
      client_id: ctx.client, title: 'Vehicle hire 2025', reference_no: 'TDR/2025/01', start_date: '2025-04-01', end_date: '2026-03-31', status: 'active',
      invoice_rounding: 'nearest_rupee', approval_levels: 1, bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}',
    })).id;
    await call('POST', '/vehicles', { registration_no: 'DL1C0012', category_id: ctx.innova });
  });

  it('requires a source reference before a tax rule can be approved', async () => {
    const t1 = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name: 'CGST (test)', tax_type: 'CGST', rate: '2.5', effective_from: '2025-04-01' });
    const t2 = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name: 'SGST (test)', tax_type: 'SGST', rate: '2.5', effective_from: '2025-04-01', source_ref: 'Test clause 9' });
    await call('POST', `/tax-rules/${t1.id}/approve`, {}, 'approver', 400);
    await call('PUT', `/tax-rules/${t1.id}`, { name: 'CGST (test)', tax_type: 'CGST', rate: '2.5', effective_from: '2025-04-01', source_ref: 'Test clause 9' });
    await call('POST', `/tax-rules/${t1.id}/approve`, {}, 'approver');
    await call('POST', `/tax-rules/${t2.id}/approve`, {}, 'approver');
  });

  it('configures, tests and approves rate schemes', async () => {
    const cfg = (base: string) => ({
      billingModel: 'daily_package',
      params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'ceil', unit: '60' }, night: { enabled: true, start: '22:00', end: '06:00', minOverlapMinutes: 1, countMode: 'per_night' } },
      components: [
        { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: base, unit: 'duty', taxCategory: 'taxable', clauseRef: 'Test schedule A' },
        { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '18', unit: 'km', taxCategory: 'taxable' },
        { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: '200', unit: 'hr', taxCategory: 'taxable' },
        { code: 'NIGHT', label: 'Night charge', quantityExpr: 'night_count', rate: '250', unit: 'night', taxCategory: 'taxable' },
        { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
        { code: 'PARK', label: 'Parking', kind: 'reimbursement', quantityExpr: 'parking', rate: '1', taxCategory: 'non_taxable' },
      ],
    });
    // Broken expression is rejected at submit
    const bad = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Broken' });
    const badV = await call('POST', `/rate-schemes/${bad.id}/versions`, { effective_from: '2025-04-01', config: { ...cfg('1'), components: [{ code: 'X', label: 'X', quantityExpr: 'extra_kms + 1', rate: '1', taxCategory: 'taxable' }] } });
    expect(badV.problems.join(' ')).toMatch(/extra_kms/);
    await call('POST', `/rate-versions/${badV.id}/submit`, {}, 'admin', 400);

    const test = await call('POST', '/rates/test', { config: cfg('3200'), duties: [{ dutyDate: '2025-09-10', startKm: '1000', endKm: '1125', startAt: '2025-09-10 09:00', endAt: '2025-09-10 19:30' }] }, 'operator');
    expect(test.results[0].lines.map((l: { amount: string }) => l.amount)).toEqual(['3200.00', '810.00', '600.00']);

    for (const [name, cat, base] of [['Innova package', ctx.innova, '3200'], ['Dzire package', ctx.dzire, '2600']] as const) {
      const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name });
      const v = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2025-04-01', vehicle_category_ids: [cat], config: cfg(base), clause_ref: 'Test schedule A' });
      await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver', 409); // must be submitted first
      await call('POST', `/rate-versions/${v.id}/submit`, {});
      await call('POST', `/rate-versions/${v.id}/approve`, {}, 'operator', 403);
      await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
      ctx[`ver_${name}`] = v.id;
      ctx[`scheme_${name}`] = s.id;
    }
    // Approved versions are immutable
    await call('PUT', `/rate-versions/${ctx['ver_Innova package']}`, { effective_from: '2025-04-01', config: cfg('1') }, 'admin', 409);
    // A new Innova version from 16 Sep auto-closes v1
    const v2 = await call('POST', `/rate-schemes/${ctx['scheme_Innova package']}/versions`, { effective_from: '2025-09-16', vehicle_category_ids: [ctx.innova], config: cfg('3400') });
    await call('POST', `/rate-versions/${v2.id}/submit`, {});
    await call('POST', `/rate-versions/${v2.id}/approve`, {}, 'approver');
    const v1 = await call('GET', `/rate-versions/${ctx['ver_Innova package']}`);
    expect(v1.effective_to).toBe('2025-09-15');
  });

  it('approves a billing template only after preview review', async () => {
    const t = await call('POST', '/templates', { client_id: ctx.client, contract_id: ctx.contract, name: 'TDR monthly bill' });
    const tpl = (await call('GET', `/templates?clientId=${ctx.client}`))[0];
    ctx.tv = tpl.versions[0].id;
    const prev = (await call('POST', `/template-versions/${ctx.tv}/preview`, { format: 'pdf' })) as { body: string; rawPayload: Buffer };
    expect(prev.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');
    await call('POST', `/template-versions/${ctx.tv}/approve`, {}, 'approver', 400);
    await call('POST', `/template-versions/${ctx.tv}/approve`, { previewReviewed: true }, 'approver');
    void t;
  });

  it('records duties with validation, keeps leading zeros and handles overnight duty', async () => {
    const base = { contractId: ctx.contract, vehicleCategoryId: ctx.innova, dutyTypeCode: 'LOCAL', driverName: 'Test Driver', fieldOfficer: 'Officer A' };
    const res = await call('POST', '/duties/bulk', {
      rows: [
        { ...base, dutyDate: '2025-09-10', vehicleRegNo: 'DL1C0012', startKm: '1000', endKm: '1070', startAt: '2025-09-10 09:00', endAt: '2025-09-10 17:00' }, // 3200
        { ...base, dutyDate: '2025-09-11', vehicleRegNo: 'DL1C0012', startKm: '1070', endKm: '1195', startAt: '2025-09-11 09:00', endAt: '2025-09-11 19:30', toll: '150', parking: '50' }, // 3200 + 45×18 + 3×200 = 4610 ; +200 nt
        { ...base, dutyDate: '2025-09-12', vehicleRegNo: 'DL1C0012', startKm: '1195', endKm: '1255', startAt: '2025-09-12 20:00', endAt: '2025-09-13 02:30' }, // overnight 6.5h → 3200 + 250 night = 3450
        { ...base, dutyDate: '2025-09-20', vehicleRegNo: '0012', startKm: '500', endKm: '560', startAt: '2025-09-20 09:00', endAt: '2025-09-20 17:00' }, // v2 rate 3400
        { ...base, vehicleCategoryId: ctx.dzire, dutyDate: '2025-09-21', vehicleRegNo: 'DL2C0099', startKm: '10', endKm: '60', startAt: '2025-09-21 09:00', endAt: '2025-09-21 15:00' }, // 2600
      ],
    }, 'operator');
    expect(res.rows).toHaveLength(5);
    expect(res.rows[3].vehicleRegNo).toBe('0012');
    expect(res.rows[2].errorCount).toBe(0);
    ctx.duties = JSON.stringify(res.rows.map((r: { id: string }) => r.id));
    // Duplicate and reversed odometer are flagged, not repaired
    const dup = await call('POST', '/duties/bulk', { rows: [{ ...base, dutyDate: '2025-09-10', vehicleRegNo: 'DL1C0012', startKm: '1100', endKm: '1090', startAt: '2025-09-10 09:00', endAt: '2025-09-10 17:00' }] }, 'operator');
    const codes = dup.rows[0].issues.map((i: { code: string }) => i.code);
    expect(codes).toEqual(expect.arrayContaining(['DUPLICATE_DUTY', 'ODOMETER_REVERSED']));
    expect(dup.rows[0].endKm).toBe('1090.0');
    ctx.badDuty = dup.rows[0].id;
  });

  it('imports an Excel duty sheet with text vehicle numbers and overnight closing times', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sept');
    ws.addRow(['Day to Day Duty']);
    ws.addRow(['Date', 'Vendor', 'Vehicle Type', 'Vehicle No.', 'Driver Name', 'Department', 'User Name', 'Starting KM', 'Closing KM', 'Starting Time', 'Closing Time']);
    ws.addRow(['25-09-2025', 'Own', 'Dzire', '0099', 'Imported Driver', 'TDR', 'Officer B', 100, 150, '21:00', '01:00']);
    ws.addRow(['26/09/2025', 'Own', 'Unknown Car', 'HR55X0001', 'Imported Driver', 'TDR', 'Officer B', 200, 260, '9:00 AM', '5:00 PM']);
    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const prev = await upload('/duties/import/preview', {}, { name: 'duty.xlsx', buf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }, 'operator');
    expect(prev.headerRow).toBe(2);
    expect(prev.mapping).toMatchObject({ dutyDate: 0, vehicleCategory: 2, vehicleRegNo: 3, startKm: 7, endKm: 8, startTime: 9, endTime: 10 });
    const res = await call('POST', '/duties/import/commit', { fileId: prev.fileId, contractId: ctx.contract, mapping: prev.mapping, defaultDutyType: 'LOCAL' }, 'operator');
    expect(res.imported).toBe(2);
    const r0 = res.results[0];
    expect(r0.input.vehicleRegNo).toBe('0099');
    expect(r0.input.endAt).toBe('2025-09-26 01:00');
    expect(r0.issues.map((i: { code: string }) => i.code)).toContain('ASSUMED_NEXT_DAY');
    expect(res.results[1].issues.map((i: { code: string }) => i.code)).toContain('UNKNOWN_CATEGORY');
    expect(res.results[1].input.startAt).toBe('2025-09-26 09:00');
  });

  it('runs the month-end workflow to an approved, generated bill', async () => {
    const bill = await call('POST', '/bills', { contract_id: ctx.contract, period_start: '2025-09-01', period_end: '2025-09-30', bill_date: '2025-10-01' }, 'operator');
    ctx.bill = bill.id;
    expect(bill.template_version_id).toBe(ctx.tv);
    await call('POST', '/bills', { contract_id: ctx.contract, period_start: '2025-09-15', period_end: '2025-10-15' }, 'operator', 409);
    const pre = await call('GET', `/bills/${bill.id}/precheck`);
    expect(pre.total).toBe(8);
    await call('POST', `/bills/${bill.id}/calculate`, {}, 'operator');
    let b = await call('GET', `/bills/${bill.id}`);
    expect(b.status).toBe('validation_required');
    const errs = b.exceptions.filter((e: { severity: string }) => e.severity === 'error');
    expect(errs.length).toBeGreaterThan(0);
    // Errors cannot be waived
    await call('PATCH', `/billing-exceptions/${errs[0].id}`, { status: 'waived', note: 'x' }, 'admin', 400);
    // Exclude the bad duplicate and the unknown-category import, then recalc
    const imported = b.exceptions.filter((e: { code: string }) => e.code === 'DUTY_UNKNOWN_CATEGORY' || e.code === 'NO_RATE').map((e: { duty_id: string }) => e.duty_id);
    for (const d of new Set([ctx.badDuty, ...imported])) await call('POST', `/bills/${bill.id}/exclude`, { dutyId: d, reason: 'Excluded in test' }, 'operator');
    await call('POST', `/bills/${bill.id}/calculate`, {}, 'operator');
    b = await call('GET', `/bills/${bill.id}`);
    expect(b.exceptions.filter((e: { severity: string; status: string }) => e.severity === 'error')).toEqual([]);
    for (const e of b.exceptions.filter((x: { status: string }) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked against duty slip (test)' });
    // Duties: 3200 + 4610 + 3450 + 3400 + 2600 + imported Dzire overnight (50 km, 4h, 1 night: 2600 + 250) = 20110
    b = await call('GET', `/bills/${bill.id}`);
    expect(b.taxable_value).toBe('20110.00');
    expect(b.non_taxable_total).toBe('200.00');
    expect(b.tax_total).toBe('1005.50'); // 502.75 × 2
    expect(b.round_off).toBe('0.50');
    expect(b.grand_total).toBe('21316.00');
    expect(b.status).toBe('draft');

    await call('POST', `/bills/${bill.id}/submit-review`, {}, 'operator');
    await call('POST', `/bills/${bill.id}/approve`, {}, 'operator', 403);
    const ap = await call('POST', `/bills/${bill.id}/approve`, {}, 'approver');
    expect(ap.billNo).toBe('LR/TDR/2025-26/001');
    await call('POST', `/bills/${bill.id}/calculate`, {}, 'operator', 409);

    const gen = await call('POST', `/bills/${bill.id}/generate`, {}, 'approver');
    const failed = gen.reconciliation.checks.filter((c: { ok: boolean }) => !c.ok);
    expect(failed).toEqual([]);
    const x = await app.inject({ method: 'GET', url: `/api/files/${gen.files.xlsx}/download`, headers: { authorization: `Bearer ${tokens.admin}` } });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(x.rawPayload as unknown as ArrayBuffer);
    const texts: string[] = [];
    wb.worksheets[0].eachRow((r) => r.eachCell((c) => texts.push(c.text)));
    expect(texts).toContain('0012');
    expect(texts.some((t) => t.includes('Twenty One Thousand Three Hundred Sixteen'))).toBe(true);
    fs.writeFileSync(path.join(os.tmpdir(), 'lrbill-sample.pdf'), (await app.inject({ method: 'GET', url: `/api/files/${gen.files.pdf}/download`, headers: { authorization: `Bearer ${tokens.admin}` } })).rawPayload);
    fs.writeFileSync(path.join(os.tmpdir(), 'lrbill-sample.xlsx'), x.rawPayload);
    b = await call('GET', `/bills/${bill.id}`);
    expect(b.status).toBe('generated');
  }, 120_000);

  it('blocks editing billed duties and double billing; corrects via revision', async () => {
    const ids = JSON.parse(ctx.duties) as string[];
    const d = await call('GET', `/duties/${ids[0]}`);
    const row = { ...d, contractId: ctx.contract, endKm: '1080' };
    await call('POST', '/duties/bulk', { rows: [row] }, 'admin', 400);
    // Another bill for the same period is refused
    await call('POST', '/bills', { contract_id: ctx.contract, period_start: '2025-09-01', period_end: '2025-09-30' }, 'operator', 409);

    await call('POST', `/duties/${ctx.badDuty}/void`, { reason: 'Duplicate entry (test)' }, 'operator');
    const rev = await call('POST', `/bills/${ctx.bill}/revise`, { reason: 'Odometer correction on 10 Sep (test)' }, 'operator');
    await call('POST', '/duties/bulk', { rows: [{ ...row, correctionReason: 'Duty slip shows 1080 (test)' }] }, 'admin');
    await call('POST', `/bills/${rev.id}/calculate`, {}, 'operator');
    let r = await call('GET', `/bills/${rev.id}`);
    expect(r.exceptions.filter((x: { severity: string }) => x.severity === 'error').map((x: { code: string; message: string }) => `${x.code}: ${x.message}`)).toEqual([]);
    for (const e of r.exceptions.filter((x: { status: string }) => x.status === 'open')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'ok (test)' });
    r = await call('GET', `/bills/${rev.id}`);
    expect(r.taxable_value).toBe('20110.00'); // 80 km is still within the package
    await call('POST', `/bills/${rev.id}/submit-review`, {}, 'operator');
    const ap = await call('POST', `/bills/${rev.id}/approve`, {}, 'approver');
    expect(ap.billNo).toBe('LR/TDR/2025-26/001');
    const orig = await call('GET', `/bills/${ctx.bill}`);
    expect(orig.status).toBe('superseded');
    expect(orig.grand_total).toBe('21316.00');
    // The superseded original cannot be changed at the database level either
    await expect(db.query(`UPDATE bills SET grand_total = 1 WHERE id = $1`, [ctx.bill])).rejects.toThrow(/cannot be modified/);
    const audit = await call('GET', `/audit?entityType=duty&entityId=${ids[0]}`);
    expect(audit.some((a: { action: string; note: string }) => a.action === 'correct' && a.note.includes('1080'))).toBe(true);
  }, 120_000);

  it('extracts candidate terms from an uploaded document for human review', async () => {
    const { renderPdf } = await import('./services/pdf.js');
    const pdf = await renderPdf({
      title: 'RATE SCHEDULE (TEST)', supplierBlock: [], clientBlock: [], headerFields: [], page: { size: 'A4', orientation: 'portrait', margins: [40, 40, 40, 40], fontSize: 10 },
      columns: [{ key: 'a', label: 'Vehicle', width: 1, format: 'text', total: false }, { key: 'b', label: 'Terms', width: 3, format: 'text', total: false }],
      rows: [
        { kind: 'data', cells: [{ v: 'Innova', raw: '', fmt: 'text', align: 'left' }, { v: 'Rs. 3,200/- per duty for 80 km and 8 hrs', raw: '', fmt: 'text', align: 'left' }] },
        { kind: 'data', cells: [{ v: 'Innova', raw: '', fmt: 'text', align: 'left' }, { v: 'Extra km Rs. 18 per km', raw: '', fmt: 'text', align: 'left' }] },
      ],
      summary: [], amountInWords: null, notes: ['Toll and parking will be reimbursed at actuals on production of receipts.', 'GST: CGST 2.5% and SGST 2.5% (test text)'], declaration: '', signatures: [], grandTotal: '0', dataRowCount: 2,
    });
    const v = await upload('/documents', { contract_id: ctx.contract, doc_type: 'rate_schedule', title: 'Test schedule' }, { name: 'rates.pdf', buf: pdf, type: 'application/pdf' }, 'operator');
    let status = 'pending';
    for (let i = 0; i < 60 && !['done', 'failed'].includes(status); i++) {
      await new Promise((r) => setTimeout(r, 500));
      const doc = await call('GET', `/documents/${v.document_id}`);
      status = doc.versions[0].extraction_status;
      if (status === 'failed') throw new Error(doc.versions[0].extraction_error);
    }
    expect(status).toBe('done');
    const items = await call('GET', `/document-versions/${v.id}/items`);
    const find = (k: string) => items.filter((i: { field_key: string }) => i.field_key === k).map((i: { value: string }) => i.value);
    expect(find('base_rate')).toContain('3200');
    expect(find('package_km')).toContain('80');
    expect(find('package_hours')).toContain('8');
    expect(find('extra_km_rate')).toContain('18');
    expect(find('tax_rate')).toEqual(expect.arrayContaining(['2.5']));
    expect(items.every((i: { status: string }) => i.status === 'pending')).toBe(true);
    // Operators cannot approve extracted values; reviewers/approvers can
    await call('PATCH', `/extracted-items/${items[0].id}`, { status: 'accepted' }, 'operator', 403);
    await call('PATCH', `/extracted-items/${items[0].id}`, { status: 'accepted' }, 'approver');
  }, 60_000);

  it('serves dashboard figures from the database', async () => {
    const d = await call('GET', '/dashboard', undefined, 'operator');
    expect(d.counts.clients).toBe(1);
    expect(d.counts.activeContracts).toBe(1);
    expect(d.recentBills.find((b: { status: string }) => b.status === 'approved').grand_total).toBe('21316.00');
    const sum = await call('GET', '/reports/billing-summary?from=2025-09-01&to=2025-09-30');
    expect(sum.map((r: { status: string }) => r.status)).toEqual(['approved']);
  });
});
