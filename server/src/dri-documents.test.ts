/**
 * End-to-end run on the real DRI documents (kept out of git in fixtures/dri/):
 * contract + rate schedule + sample bill → proposal → apply → approvals →
 * shared PDF duty sheet import (DRI rows only) → September bill → Excel/PDF.
 * Each calculated duty is then compared with the matching duty block on
 * "DRI Sep.pdf"; differences are written to fixtures/dri/comparison.json.
 * The comparison reports differences — it does not tune rules to match.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/dri');
const FILES = { contract: 'DRI Daily Taxi Contract 05-Nov-2026.pdf', rates: 'DRI Daily Taxi Contract Rates.pdf', bill: 'DRI Sep.pdf', duty: 'Day to Day Duty September.pdf' };
const present = Object.values(FILES).every((f) => fs.existsSync(path.join(dir, f)));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lrbill-dri-'));
process.env.STORAGE_DIR = tmp;
process.env.ANTHROPIC_API_KEY = '';

describe.skipIf(!present)('DRI documents end to end', () => {
  let app: any;
  let db: any;
  const tok: Record<string, string> = {};
  const ctx: Record<string, any> = {};

  const call = async (method: string, url: string, body?: unknown, who = 'admin', expectStatus = 200) => {
    const res = await app.inject({ method, url: `/api${url}`, payload: body, headers: { authorization: `Bearer ${tok[who]}` } });
    if (res.statusCode !== expectStatus) throw new Error(`${method} ${url} → ${res.statusCode}: ${res.body.slice(0, 1500)}`);
    return res.headers['content-type']?.includes('json') ? res.json() : res;
  };
  const upload = async (url: string, fields: Record<string, string>, name: string) => {
    const buf = fs.readFileSync(path.join(dir, name));
    const boundary = '----dri' + Date.now();
    const parts: Buffer[] = [];
    for (const [k, v] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/pdf\r\n\r\n`), buf, Buffer.from(`\r\n--${boundary}--\r\n`));
    const res = await app.inject({ method: 'POST', url: `/api${url}`, payload: Buffer.concat(parts), headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, authorization: `Bearer ${tok.admin}` } });
    if (res.statusCode !== 200) throw new Error(`upload → ${res.statusCode}: ${res.body}`);
    return res.json();
  };

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
    tok.admin = (await app.inject({ method: 'POST', url: '/api/auth/setup', payload: { email: 'admin@test.local', name: 'Admin', password: 'TestAdmin12345' } })).json().token;
  }, 60_000);
  afterAll(async () => { await app?.close(); await db?.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

  it('reads the documents and proposes the department, contract, rates, tax and bill format', async () => {
    const versions: Record<string, string> = {};
    for (const [k, f] of Object.entries(FILES)) versions[k] = (await upload('/documents', { doc_type: k === 'bill' ? 'sample_invoice' : k === 'rates' ? 'rate_schedule' : k === 'duty' ? 'duty_sheet' : 'contract', run_ai: 'false' }, f)).id;
    for (let i = 0; i < 120; i++) {
      const rows = await db.query(`SELECT extraction_status, extraction_error FROM document_versions WHERE id = ANY($1::uuid[])`, [Object.values(versions)]);
      if (rows.some((r: any) => r.extraction_status === 'failed')) throw new Error(rows.map((r: any) => r.extraction_error).join('; '));
      if (rows.every((r: any) => r.extraction_status === 'done')) break;
      await new Promise((r) => setTimeout(r, 500));
    }
    ctx.versions = versions;
    const res = await call('POST', '/onboarding/analyze', { versionIds: Object.values(versions) });
    const p = res.proposal;
    ctx.session = res.sessionId;
    ctx.proposal = p;
    expect(p.client.name.value).toBe('Directorate of Revenue Intelligence');
    expect(p.client.short_code.value).toBe('DRI');
    expect(p.client.gstin.value).toBe('07DELD08333D1DX');
    expect(p.client.state_name.value).toBe('Delhi');
    expect(p.contract.reference_no.value).toBe('GEMC-511687707217712');
    expect(p.contract.start_date.value).toBe('2025-11-06');
    expect(p.contract.end_date.value).toBe('2026-11-05');
    expect(p.contract.billing_frequency.value).toBe('monthly');
    expect(p.contract.bill_no_format.value).toBe('LRTH/{FYS}/{SEQ:4}');
    expect(p.contract.invoice_rounding.value).toBe('nearest_rupee');
    expect(p.supplier.gstin.value).toBe('06AAGFL5356A1ZM');
    expect(p.supplier.name.value).toBe('L.R. Taxi Services');
    expect(p.rates.map((r: any) => r.category)).toEqual(['SUV AC', 'Premium Sedan AC', 'Sedan AC']);
    expect(p.rates[0].packages.map((x: any) => `${x.hours}/${x.km}=${x.rate.value}`)).toEqual(['4/40=2200', '8/80=3200']);
    expect(p.categories[0].aliases).toEqual(expect.arrayContaining(['Innova', 'Ertiga']));
    expect(p.taxes).toEqual([expect.objectContaining({ tax_type: 'IGST', rate: '18' })]);
    expect(p.template.layout.rowMode).toBe('block');
    expect(p.billSeries).toMatchObject({ format: 'LRTH/{FYS}/{SEQ:4}', nextNumber: 768 });
    expect(p.dutySheet.departments.DRI).toBe(86);
  }, 180_000);

  it('creates everything as drafts, which approvers then approve', async () => {
    const p = ctx.proposal;
    const v = (f: any) => f?.value ?? null;
    const created = await call('POST', `/onboarding/${ctx.session}/apply`, {
      client: { name: v(p.client.name), short_code: v(p.client.short_code), billing_address: v(p.client.billing_address), gstin: v(p.client.gstin), state_name: v(p.client.state_name), state_code: v(p.client.state_code), contact_email: v(p.client.contact_email), contact_phone: v(p.client.contact_phone), aliases: p.clientAliases },
      supplier: { name: v(p.supplier.name), gstin: v(p.supplier.gstin), pan: v(p.supplier.pan), address: v(p.supplier.address), email: v(p.supplier.email), phone: v(p.supplier.phone), msme: v(p.supplier.msme), state_name: v(p.supplier.state_name), state_code: v(p.supplier.state_code), tagline: v(p.supplier.tagline) },
      contract: Object.fromEntries(Object.entries(p.contract).map(([k, f]: [string, any]) => [k, f.value || null])),
      categories: p.categories,
      rates: p.rates,
      // Contract is silent on these; the values are what LR uses and are flagged for confirmation in the wizard.
      rateOptions: { ...p.rateOptions, nightStart: '22:00', nightEnd: '06:00' },
      taxes: p.taxes,
      template: { name: 'DRI monthly bill', layout: p.template.layout },
      billSeries: p.billSeries,
    });
    ctx.created = created;
    expect(created.rateVersions).toHaveLength(9); // 3 categories × (2 packages + outstation)
    const st = await db.query(`SELECT status, count(*)::int AS n FROM rate_scheme_versions GROUP BY status`);
    expect(st).toEqual([{ status: 'draft', n: 9 }]);
    // Nothing is billable before approval: approve as a person would.
    for (const id of created.rateVersions) { await call('POST', `/rate-versions/${id}/submit`); await call('POST', `/rate-versions/${id}/approve`); }
    for (const id of created.taxRules) await call('POST', `/tax-rules/${id}/approve`);
    await call('POST', `/template-versions/${created.templateVersionId}/preview`, { format: 'pdf' });
    await call('POST', `/template-versions/${created.templateVersionId}/approve`, { previewReviewed: true });
  }, 60_000);

  it('imports only the DRI rows from the shared PDF duty sheet', async () => {
    const prev = await upload('/duties/import/preview', {}, FILES.duty);
    expect(prev.mapping).toMatchObject({ dutyDate: 0, vendorName: 1, vehicleCategory: 2, vehicleRegNo: 3, driverName: 4, department: 5, fieldOfficer: 6, startKm: 7, endKm: 8, startTime: 9, endTime: 10 });
    const dri = prev.departments.find((d: any) => d.value === 'DRI');
    expect(dri).toMatchObject({ rows: 86, contractId: ctx.created.contractId });
    const res = await call('POST', '/duties/import/commit', { fileId: prev.fileId, mapping: prev.mapping, departmentRouting: { DRI: ctx.created.contractId }, defaultDutyType: 'LOCAL' });
    ctx.import = res;
    expect(res.imported).toBe(86);
    const regs = await db.query(`SELECT vehicle_reg_no FROM duties WHERE vehicle_reg_no LIKE '0%' LIMIT 1`);
    expect(regs[0]?.vehicle_reg_no).toMatch(/^0\d{3}$/);
  }, 120_000);

  it('bills September, generates Excel + PDF, and compares with the DRI Sep bill', async () => {
    const bill = await call('POST', '/bills', { contract_id: ctx.created.contractId, period_start: '2026-09-01', period_end: '2026-09-30', bill_date: '2026-10-23' });
    await call('POST', `/bills/${bill.id}/calculate`);
    let b = await call('GET', `/bills/${bill.id}`);
    // Duties with errors (missing readings, "?" times, typos) are excluded with a reason, as an operator would after checking.
    const errDuties = [...new Set(b.exceptions.filter((e: any) => e.severity === 'error' && e.duty_id).map((e: any) => e.duty_id))];
    for (const d of errDuties) await call('POST', `/bills/${bill.id}/exclude`, { dutyId: d, reason: 'Duty sheet incomplete — check slip (test)' });
    await call('POST', `/bills/${bill.id}/calculate`);
    b = await call('GET', `/bills/${bill.id}`);
    for (const e of b.exceptions.filter((x: any) => x.status === 'open' && x.severity === 'warning')) await call('PATCH', `/billing-exceptions/${e.id}`, { status: 'waived', note: 'Checked (test)' });
    b = await call('GET', `/bills/${bill.id}`);
    expect(b.exceptions.filter((x: any) => x.status === 'open')).toEqual([]);
    await call('POST', `/bills/${bill.id}/submit-review`);
    const ap = await call('POST', `/bills/${bill.id}/approve`);
    expect(ap.billNo).toBe('LRTH/26-27/0768');
    const gen = await call('POST', `/bills/${bill.id}/generate`);
    expect(gen.reconciliation.checks.filter((c: any) => !c.ok)).toEqual([]);
    const pdf = (await app.inject({ method: 'GET', url: `/api/files/${gen.files.pdf}/download`, headers: { authorization: `Bearer ${tok.admin}` } })).rawPayload;
    const xlsx = (await app.inject({ method: 'GET', url: `/api/files/${gen.files.xlsx}/download`, headers: { authorization: `Bearer ${tok.admin}` } })).rawPayload;
    fs.writeFileSync(path.join(os.tmpdir(), 'lrbill-dri-sep.pdf'), pdf);
    fs.writeFileSync(path.join(os.tmpdir(), 'lrbill-dri-sep.xlsx'), xlsx);

    // --- Compare with the reference bill, duty by duty --------------------------------
    const ref = parseReferenceBill(JSON.parse((await db.one(`SELECT extracted FROM document_versions WHERE id = $1`, [ctx.versions.bill])).extracted ? JSON.stringify((await db.one(`SELECT extracted FROM document_versions WHERE id = $1`, [ctx.versions.bill])).extracted) : '{}'));
    const lines = b.lines as any[];
    const ours = new Map<string, any>();
    for (const d of b.duties as any[]) {
      const key = `${d.duty_date}|${String(d.vehicle_reg_no).slice(-4)}`;
      const ls = lines.filter((l) => l.duty_id === d.id);
      const amt = (c: string) => ls.filter((l) => l.component_code === c).reduce((a, l) => a + Math.round(Number(l.amount) * 100), 0) / 100;
      const qty = (c: string) => ls.find((l) => l.component_code === c)?.quantity;
      ours.set(key, { BASE: amt('BASE'), EXKM: amt('EXKM'), EXHR: amt('EXHR'), NIGHT: amt('NIGHT'), TOLLPARK: amt('TOLL') + amt('PARK'), exKmQty: qty('EXKM'), exHrQty: qty('EXHR'), start: d.start_at, end: d.end_at, km: d.start_km != null ? Number(d.end_km) - Number(d.start_km) : null });
    }
    const rows: any[] = [];
    let matched = 0;
    for (const r of ref.duties) {
      const key = `${r.date}|${r.vehicle}`;
      const o = ours.get(key);
      if (!o) { rows.push({ ref: `S.No ${r.sno}`, key, status: 'not in system (excluded or not on duty sheet)', reference: r }); continue; }
      ours.delete(key);
      const diffs = (['BASE', 'EXKM', 'EXHR', 'NIGHT', 'TOLLPARK'] as const).filter((c) => Math.abs((o[c] ?? 0) - (r[c] ?? 0)) > 0.001).map((c) => ({ component: c, bill: r[c] ?? 0, system: o[c] ?? 0 }));
      if (diffs.length === 0) matched++;
      else rows.push({ ref: `S.No ${r.sno}`, key, status: 'different', diffs, billRunning: r.running, systemDuty: { km: o.km, start: o.start, end: o.end, exKmQty: o.exKmQty, exHrQty: o.exHrQty } });
    }
    for (const [key, o] of ours) rows.push({ key, status: 'in system but not on reference bill', system: o });
    const summary = {
      referenceDuties: ref.duties.length,
      systemDuties: (b.duties as any[]).length,
      excludedForErrors: errDuties.length,
      identical: matched,
      different: rows.filter((r) => r.status === 'different').length,
      notInSystem: rows.filter((r) => r.status.startsWith('not in system')).length,
      notOnReference: rows.filter((r) => r.status.startsWith('in system but')).length,
      reference: { taxable: ref.taxable, tax: ref.tax, nonTaxable: ref.nonTaxable, total: ref.total },
      system: { taxable: b.taxable_value, tax: b.tax_total, nonTaxable: b.non_taxable_total, roundOff: b.round_off, total: b.grand_total },
    };
    // Formula check independent of the duty sheet: recalculate every reference duty from the bill's own
    // "Total running (km / hrs)" and its vehicle model, with the approved rate versions.
    const { calculateDuty } = await import('./engine/duty.js');
    const { loadSchemeVersions } = await import('./routes/rates.js');
    const versions = await loadSchemeVersions(db, ctx.created.contractId, true);
    const cats = await db.query(`SELECT id, name, aliases FROM vehicle_categories`);
    const catOf = (model: string) => cats.find((c: any) => [c.name, ...(c.aliases ?? [])].some((a: string) => a.toLowerCase() === model.toLowerCase()));
    const formula: any[] = [];
    for (const r of ref.duties) {
      const m = /\(\s*(\d+)\s*kms?\.?\s*\/\s*(\d+(?:\.\d+)?)\s*hrs?/i.exec(r.running ?? '');
      const cat = catOf(r.model);
      const ver = versions.find((v: any) => v.vehicleCategoryIds.includes(cat?.id) && v.dutyTypeCodes.includes('LOCAL'));
      if (!m || !ver) { formula.push({ sno: r.sno, status: 'not checkable', running: r.running, model: r.model }); continue; }
      const mins = Math.round(Number(m[2]) * 60);
      const end = new Date(Date.UTC(2026, 0, 1, 0, mins));
      const res = calculateDuty({ id: 'x', dutyDate: '2026-01-01', vehicleRegNo: r.vehicle, vehicleCategoryId: cat.id, dutyTypeCode: 'LOCAL', startKm: '0', endKm: m[1], startAt: '2026-01-01 00:00',
        endAt: `${end.toISOString().slice(0, 10)} ${end.toISOString().slice(11, 16)}`, toll: null, parking: null, otherCharges: null }, ver);
      const got = (c: string) => Number(res.lines.find((l) => l.componentCode === c)?.amount ?? 0);
      const d = (['BASE', 'EXKM', 'EXHR'] as const).filter((c) => Math.abs(got(c) - r[c]) > 0.001).map((c) => ({ c, bill: r[c], engine: got(c) }));
      formula.push({ sno: r.sno, model: r.model, running: r.running, status: d.length ? 'different' : 'same', diffs: d });
    }
    (summary as any).formulaCheckFromBillFigures = {
      checked: formula.filter((f) => f.status !== 'not checkable').length,
      sameBaseExtraKmExtraHours: formula.filter((f) => f.status === 'same').length,
      different: formula.filter((f) => f.status === 'different').map((f) => ({ sno: f.sno, model: f.model, running: f.running, diffs: f.diffs })),
    };
    fs.writeFileSync(path.join(dir, 'comparison.json'), JSON.stringify({ summary, rows }, null, 2));
    console.log('DRI comparison:', JSON.stringify(summary));
    expect(ref.duties.length).toBe(111);
    expect(matched).toBeGreaterThan(0);
  }, 240_000);

  it.skipIf(!fs.existsSync(path.join(dir, 'DRI Sep_merged.pdf')))('reads contract, rates and bill format from one combined PDF', async () => {
    const v = await upload('/documents', { doc_type: 'contract', run_ai: 'false' }, 'DRI Sep_merged.pdf');
    for (let i = 0; i < 120; i++) {
      const r = await db.one(`SELECT extraction_status FROM document_versions WHERE id = $1`, [v.id]);
      if (r.extraction_status === 'done') break;
      await new Promise((res) => setTimeout(res, 500));
    }
    const { proposal: p } = await call('POST', '/onboarding/analyze', { versionIds: [v.id] });
    expect(p.documents[0].kind).toBe('contract + rate_schedule + sample_bill');
    expect(p.client.gstin.value).toBe('07DELD08333D1DX');
    expect(p.contract.reference_no.value).toBe('GEMC-511687707217712');
    expect(p.rates).toHaveLength(3);
    expect(p.taxes).toEqual([expect.objectContaining({ tax_type: 'IGST', rate: '18' })]);
    expect(p.template.layout.rowMode).toBe('block');
    expect(p.sampleBill).toMatchObject({ dutyCount: 111, grandTotal: '932613' });
  }, 120_000);

  it('creates date-wise draft bills for a month', async () => {
    // October has no DRI duties yet: add two, then bill them date-wise.
    const base = { contractId: ctx.created.contractId, vehicleRegNo: '6503', vehicleModel: 'Innova', dutyTypeCode: 'LOCAL', startAt: '', endAt: '' };
    const cat = (await db.one(`SELECT id FROM vehicle_categories WHERE name = 'SUV AC'`)).id;
    await call('POST', '/duties/bulk', { rows: [
      { ...base, vehicleCategoryId: cat, dutyDate: '2026-10-01', startKm: '20000', endKm: '20090', startAt: '2026-10-01 09:00', endAt: '2026-10-01 18:00' },
      { ...base, vehicleCategoryId: cat, dutyDate: '2026-10-02', startKm: '20090', endKm: '20150', startAt: '2026-10-02 09:00', endAt: '2026-10-02 16:00' },
    ] });
    const r = await call('POST', '/bills/date-wise', { contract_id: ctx.created.contractId, month: '2026-10' });
    expect(r.created.map((x: any) => x.date)).toEqual(['2026-10-01', '2026-10-02']);
    const b = await call('GET', `/bills/${r.created[0].id}`);
    expect(b.period_type).toBe('date');
    await call('POST', `/bills/${r.created[0].id}/calculate`);
    const c = await call('GET', `/bills/${r.created[0].id}`);
    // 90 km, 9 h: 3200 + 10 km × 28 + 1 h × 250 = 3730
    expect(c.taxable_value).toBe('3730.00');
  }, 60_000);
});

/** Reads the duty blocks and totals from the extracted tables of the DRI sample bill. */
function parseReferenceBill(ex: any) {
  const duties: any[] = [];
  let cur: any = null;
  let taxable = '', tax = '', nonTaxable = '', total = '';
  for (const p of ex.pages ?? []) for (const t of p.tables ?? []) for (const row of t) {
    const c = row.map((x: string) => (x ?? '').replace(/\s+/g, ' ').trim());
    const desc = c[2] ?? '';
    const m = /^duty for \(\s*(\S+)\s+(\S+)/i.exec(desc);
    if (m && /^\d+$/.test(c[0])) {
      const [dd, mm, yy] = c[1].split('.');
      cur = { sno: Number(c[0]), date: `${yy}-${mm}-${dd}`, vehicle: m[1].slice(-4), model: m[2], BASE: 0, EXKM: 0, EXHR: 0, NIGHT: 0, TOLLPARK: 0 };
      duties.push(cur);
      continue;
    }
    const amt = (x: string) => (x && /^\d+(\.\d+)?$/.test(x) ? Number(x) : 0);
    if (/taxable amount/i.test(c[3] ?? '')) { taxable = c[6]; continue; }
    if (/gst/i.test(c[3] ?? '')) { tax = c[6]; continue; }
    if (/toll/i.test(c[3] ?? '')) { nonTaxable = c[6]; continue; }
    if (/total amount/i.test(c[3] ?? '')) { total = c[6]; continue; }
    if (!cur) continue;
    if (/^upto/i.test(desc)) cur.BASE = amt(c[6]);
    else if (/^total running/i.test(desc)) cur.running = desc;
    else if (/^extra km/i.test(desc)) cur.EXKM = amt(c[6]);
    else if (/^extra hr/i.test(desc)) cur.EXHR = amt(c[6]);
    else if (/^night/i.test(desc)) cur.NIGHT = amt(c[6]);
    else if (/toll|parking/i.test(desc)) cur.TOLLPARK = amt(c[5]) || amt(c[6]);
  }
  return { duties, taxable, tax, nonTaxable, total };
}
