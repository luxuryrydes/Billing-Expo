/**
 * Duty Slip Scanning & Billing end to end on an in-memory database, with the stand-in scanner and reader
 * (SCANNER_DRIVER=mock, SLIP_READER=mock): scan → tidy pages → read → review edits → save as duties →
 * Excel round trip → bill. The real scanner and the AI are exercised by hand on the computer with the scanner.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-scan-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';
process.env.SCANNER_DRIVER = 'mock';
process.env.SLIP_READER = 'mock';
process.env.SLIP_MOCK_DEPARTMENT = 'Test Directorate';
process.env.SCANNER_MOCK_PAGES = '3';

const { createDb } = await import('./db/index.js');
const { migrate } = await import('./db/migrate.js');
const { seedReferenceData } = await import('./db/seed.js');
const { buildApp } = await import('./app.js');

type App = Awaited<ReturnType<typeof buildApp>>;
let app: App;
let db: Awaited<ReturnType<typeof createDb>>;
const tokens: Record<string, string> = {};
const PW = { admin: 'TestAdmin12345', operator: 'TestOperator12345', approver: 'TestApprover12345' };
const ctx: Record<string, any> = {};
const TINY = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');

async function call(method: string, url: string, body?: unknown, who = 'operator', expectStatus = 200) {
  const res = await app.inject({ method: method as 'GET', url: `/api${url}`, payload: body as object, headers: tokens[who] ? { authorization: `Bearer ${tokens[who]}` } : {} });
  if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 800)}`);
  return res.headers['content-type']?.toString().includes('json') ? res.json() : res;
}
async function multipart(method: 'POST' | 'PUT', url: string, files: { name: string; buf: Buffer }[], who = 'operator') {
  const boundary = '----scan' + Math.random().toString(16).slice(2);
  const parts: Buffer[] = [];
  for (const f of files) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${f.name}"\r\nContent-Type: application/octet-stream\r\n\r\n`), f.buf, Buffer.from('\r\n'));
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  const res = await app.inject({ method, url: `/api${url}`, payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${tokens[who]}` } });
  if (res.statusCode !== 200) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 600)}`);
  return res.headers['content-type']?.toString().includes('json') ? res.json() : res;
}
const waitReady = async (id: string) => {
  for (let i = 0; i < 60; i++) {
    const d = await call('GET', `/scan/batches/${id}`);
    if (d.batch.status !== 'scanning') return d;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('scan did not finish');
};

beforeAll(async () => {
  db = await createDb('memory://');
  await migrate(db);
  await seedReferenceData(db);
  app = await buildApp(db);
}, 60_000);
afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('Duty Slip Scanning & Billing', () => {
  it('sets up a department with an approved rate and tax', async () => {
    const r = await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: PW.admin } });
    tokens.admin = r.json().token;
    for (const role of ['operator', 'approver'] as const) {
      await call('POST', '/users', { email: `${role}@test.local`, name: role, role, password: PW[role] }, 'admin');
      tokens[role] = (await call('POST', '/auth/login', { email: `${role}@test.local`, password: PW[role] }, 'nobody')).token;
    }
    await call('POST', '/suppliers', { name: 'LR Taxi Services Pvt. Ltd.', address: 'Test address', gstin: '07TESTGSTIN1Z5', state_name: 'Delhi', state_code: '07', is_default: true }, 'admin');
    ctx.innova = (await call('POST', '/vehicle-categories', { name: 'Innova' }, 'admin')).id;
    ctx.client = (await call('POST', '/clients', { name: 'Test Directorate', short_code: 'TDR', billing_address: 'New Delhi', gstin: '07CLIENTGSTIN1Z' }, 'admin')).id;
    ctx.contract = (await call('POST', '/contracts', { client_id: ctx.client, title: 'Vehicle hire 2026', reference_no: 'TDR/2026/01', start_date: '2026-04-01', end_date: '2027-03-31', status: 'active', invoice_rounding: 'nearest_rupee', bill_no_format: 'LR/{CLIENT}/{FY}/{SEQ}' }, 'admin')).id;
    for (const [name, type] of [['CGST (test)', 'CGST'], ['SGST (test)', 'SGST']]) {
      const t = await call('POST', `/contracts/${ctx.contract}/tax-rules`, { name, tax_type: type, rate: '2.5', effective_from: '2026-04-01', source_ref: 'Test clause' }, 'admin');
      await call('POST', `/tax-rules/${t.id}/approve`, {}, 'approver');
    }
    const cfg = {
      billingModel: 'daily_package', params: { includedKm: '80', includedHours: '8', hourRounding: { mode: 'exact', unit: '60' } },
      components: [
        { code: 'BASE', label: 'Base duty', quantityExpr: '1', rate: '2400', unit: 'duty', taxCategory: 'taxable' },
        { code: 'EXKM', label: 'Extra km', quantityExpr: 'extra_km', rate: '20', unit: 'km', taxCategory: 'taxable' },
        { code: 'EXHR', label: 'Extra hours', quantityExpr: 'extra_hours', rate: '250', unit: 'hr', taxCategory: 'taxable' },
        { code: 'TOLL', label: 'Toll', kind: 'reimbursement', quantityExpr: 'toll', rate: '1', taxCategory: 'non_taxable' },
      ],
    };
    const s = await call('POST', '/rate-schemes', { contract_id: ctx.contract, name: 'Innova package' }, 'admin');
    const v = await call('POST', `/rate-schemes/${s.id}/versions`, { effective_from: '2026-04-01', vehicle_category_ids: [ctx.innova], config: cfg, clause_ref: 'Test' }, 'admin');
    await call('POST', `/rate-versions/${v.id}/submit`, {}, 'admin');
    await call('POST', `/rate-versions/${v.id}/approve`, {}, 'approver');
  });

  it('reports the scanner and the reader, and lists the scanner', async () => {
    const s = await call('GET', '/scan/status');
    expect(s.scanner).toMatchObject({ driver: 'mock', available: true });
    expect(s.ai.configured).toBe(true);
    expect(s.fields).toHaveLength(25);
    expect((await call('GET', '/scan/devices')).devices).toEqual([{ id: 'mock-1', name: 'Test scanner', feeder: true, flatbed: true, duplex: false }]);
    // Scanning needs permission to enter duties
    await call('GET', '/scan/devices', undefined, 'nobody', 401);
  });

  it('scans a stack from the document feeder into a batch', async () => {
    const b = await call('POST', '/scan/batches', { deviceId: 'mock-1', mode: 'color', dpi: 200, source: 'feeder', duplex: false, title: 'Sept slips' });
    const d = await waitReady(b.batch.id);
    ctx.batch = b.batch.id;
    expect(d.batch).toMatchObject({ status: 'ready', title: 'Sept slips', color_mode: 'color', dpi: 200 });
    expect(d.pages.map((p: any) => p.position)).toEqual([1, 2, 3]);
    ctx.pages = d.pages.map((p: any) => p.id);
    // A scanner that cannot do both sides says so instead of pretending
    await call('POST', '/scan/batches', { deviceId: 'mock-1', mode: 'color', dpi: 200, source: 'feeder', duplex: true }, 'operator', 400);
  });

  it('removes, restores, reorders and replaces pages', async () => {
    await call('POST', `/scan/pages/${ctx.pages[2]}/delete`, { deleted: true });
    expect((await call('GET', `/scan/batches/${ctx.batch}`)).pages.filter((p: any) => !p.deleted)).toHaveLength(2);
    await call('POST', `/scan/pages/${ctx.pages[2]}/delete`, { deleted: false });
    const re = await call('POST', `/scan/batches/${ctx.batch}/reorder`, { pageIds: [...ctx.pages].reverse() });
    expect(re.pages.map((p: any) => p.id)).toEqual([...ctx.pages].reverse());
    await call('POST', `/scan/batches/${ctx.batch}/reorder`, { pageIds: ctx.pages }); // back to scan order
    // An edited (rotated / cropped) image is stored next to the original
    const before = (await call('GET', `/scan/batches/${ctx.batch}`)).pages[0];
    const after = await multipart('PUT', `/scan/pages/${ctx.pages[0]}/image`, [{ name: 'rotated.jpg', buf: Buffer.concat([TINY, Buffer.from('1')]) }]);
    expect(after.fileId).not.toBe(before.fileId);
    const d = await call('GET', `/scan/batches/${ctx.batch}`);
    expect(d.pages[0]).toMatchObject({ originalFileId: before.originalFileId, editedImage: true });
    await call('POST', `/scan/pages/${ctx.pages[0]}/restore-original`, {});
    expect((await call('GET', `/scan/batches/${ctx.batch}`)).pages[0].editedImage).toBe(false);
  });

  it('reads every page into the duty slip fields', async () => {
    for (const id of ctx.pages) expect((await call('POST', `/scan/pages/${id}/read`, {})).status).toBe('read');
    const d = await call('GET', `/scan/batches/${ctx.batch}`);
    const p2 = d.pages[1].reading;
    expect(p2.values).toMatchObject({ slip_no: 'S-2', duty_date: '02/09/2026', vehicle_no: 'DL1CAA1001', department: 'Test Directorate', reporting_time: '09:00', release_time: '17:30', toll: '120' });
    expect(p2.fields.closing_km.confidence).toBeLessThan(0.6); // flagged for the reviewer
  });

  it('saves nothing until asked, then saves the slips as duties for the matched contract', async () => {
    expect((await call('GET', '/duties?pageSize=10')).total ?? (await call('GET', '/duties?pageSize=10')).rows?.length ?? 0).toBe(0);
    const dry = await call('POST', `/scan/batches/${ctx.batch}/save`, { dryRun: true });
    expect(dry.summary).toMatchObject({ add: 3, error: 0 });
    expect((await db.one('SELECT count(*)::int AS n FROM duties')).n).toBe(0);
    const saved = await call('POST', `/scan/batches/${ctx.batch}/save`, {});
    expect(saved.summary).toMatchObject({ add: 3, update: 0, unchanged: 0, error: 0 });
    const duties = await db.query(`SELECT duty_date, vehicle_reg_no, start_km, end_km, start_at, end_at, toll_amount, field_officer, driver_name, vehicle_category_id, contract_id, supporting_doc_ref, remarks, source FROM duties ORDER BY duty_date`);
    expect(duties).toHaveLength(3);
    expect(duties[1]).toMatchObject({ duty_date: '2026-09-02', vehicle_reg_no: 'DL1CAA1001', field_officer: 'Shri A. Kumar', driver_name: 'Ram Singh', vehicle_category_id: ctx.innova, contract_id: ctx.contract });
    expect(Number(duties[1].toll_amount)).toBe(120);
    expect(String(duties[1].start_at)).toContain('09:00');
    expect(duties[1].supporting_doc_ref).toContain('Sept slips');
    expect(duties[1].remarks).toMatch(/Slip no\. S-2.*Shastri Bhawan → Airport.*Driver mobile 9810012345/);
  });

  it('saving again changes nothing; a correction updates the same duty', async () => {
    const again = await call('POST', `/scan/batches/${ctx.batch}/save`, {});
    expect(again.summary).toMatchObject({ add: 0, update: 0, unchanged: 3 });
    expect((await db.one('SELECT count(*)::int AS n FROM duties')).n).toBe(3);
    const rid = (await call('GET', `/scan/batches/${ctx.batch}`)).pages[1].reading.id;
    await call('PUT', `/scan/readings/${rid}`, { edited: { closing_km: '1170' } }); // the reviewer fixed the doubtful reading
    const upd = await call('POST', `/scan/batches/${ctx.batch}/save`, {});
    expect(upd.summary).toMatchObject({ add: 0, update: 1, unchanged: 2 });
    expect((await db.one(`SELECT end_km FROM duties WHERE duty_date = '2026-09-02'`)).end_km).toBe('1170.0');
    expect((await db.one('SELECT count(*)::int AS n FROM duties')).n).toBe(3);
  });

  it('a slip for an unknown department or with a missing vehicle is held back, not guessed', async () => {
    const rid = (await call('GET', `/scan/batches/${ctx.batch}`)).pages[0].reading.id;
    await call('PUT', `/scan/readings/${rid}`, { edited: { vehicle_no: '', duty_date: '31/02/2026' } });
    const r = await call('POST', `/scan/batches/${ctx.batch}/save`, { readingIds: [rid], dryRun: true });
    expect(r.summary.error).toBe(1);
    expect(r.results[0].problems.map((p: any) => p.field).sort()).toEqual(['duty_date', 'vehicle_no']);
    await call('PUT', `/scan/readings/${rid}`, { edited: { vehicle_no: 'DL1CAA1001', duty_date: '01/09/2026' } });
  });

  it('exports the data to Excel and applies only the cells that were changed there', async () => {
    const x = await call('GET', `/scan/batches/${ctx.batch}/export.xlsx`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load((x as any).rawPayload);
    const ws = wb.getWorksheet('Duty slips')!;
    expect(ws.getRow(3).getCell(1).text).toBe('Row ID');
    expect(ws.rowCount).toBe(6); // title, note, header, 3 slips
    const labels = ws.getRow(3).values as string[];
    const col = labels.indexOf('Parking');
    ws.getRow(4).getCell(col).value = '35';
    const out = Buffer.from(await wb.xlsx.writeBuffer());
    const res = await multipart('POST', `/scan/batches/${ctx.batch}/import`, [{ name: 'edited.xlsx', buf: out }]);
    expect(res).toMatchObject({ rows: 3, changedRows: 1, changedCells: 1, unknownRows: [] });
    expect((await call('GET', `/scan/batches/${ctx.batch}`)).pages[0].reading.values.parking).toBe('35');
    await call('POST', `/scan/batches/${ctx.batch}/save`, {});
    expect(Number((await db.one(`SELECT parking_amount FROM duties WHERE duty_date = '2026-09-01'`)).parking_amount)).toBe(35);
  });

  it('bills the saved duties through the normal billing workflow', async () => {
    const bill = await call('POST', '/bills', { contract_id: ctx.contract, period_start: '2026-09-01', period_end: '2026-09-30', bill_date: '2026-10-01' });
    await call('POST', `/bills/${bill.id}/calculate`, {});
    const b = await call('GET', `/bills/${bill.id}`);
    expect(b.exceptions.filter((e: any) => e.severity === 'error')).toEqual([]);
    // Three duties of 80 km / 8.5 h (page 2: 170 km): base 2400 each, extra hours 0.5 × 250, extra km on page 2
    expect(Number(b.taxable_value)).toBeGreaterThan(7200);
    expect(b.status).toMatch(/draft|validation_required/);
  });

  it('adds scanned images from files and keeps them in a batch of their own', async () => {
    const u = await multipart('POST', '/scan/batches/upload', [{ name: 'b.jpg', buf: Buffer.concat([TINY, Buffer.from('2')]) }, { name: 'a.jpg', buf: Buffer.concat([TINY, Buffer.from('1')]) }]);
    expect(u.batch.source).toBe('upload');
    expect(u.pages).toHaveLength(2);
    // Only images are accepted
    const bad = await app.inject({ method: 'POST', url: '/api/scan/batches/upload', payload: Buffer.from('x'), headers: { authorization: `Bearer ${tokens.operator}`, 'content-type': 'multipart/form-data; boundary=zz' } });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
    expect((await call('GET', '/scan/batches')).length).toBe(2);
  });
});
