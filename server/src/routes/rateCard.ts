import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { can, perm, requirePerm } from '../lib/auth.js';
import { badRequest, forbidden, isoDate, notFound, parse, uuid } from '../lib/http.js';
import { checkUpload, filePath, loadFile, saveFile } from '../lib/storage.js';
import { readWorkbook } from '../services/sheets.js';
import { analyseRegister, applyRegister, defaultFyStart, exportRegister, type RegisterOptions } from '../services/registerImport.js';
import {
  categoryFor, checkEntry, currentRates, endRate, findExistingRate, localPackages, normaliseEntry, rateCardContract, registrationState, resolveTax, saveRate, syncTax, taxDisplay,
} from '../services/departmentRates.js';
import { approveVersion } from './rates.js';
import { addDays } from '../engine/time.js';

const today = () => new Date().toISOString().slice(0, 10);

const Options = z.object({
  newRatesFrom: isoDate.optional(),
  changesFrom: isoDate.optional(),
  approve: z.boolean().optional(),
  hourRoundingMode: z.enum(['exact', 'ceil', 'floor', 'nearest']).default('ceil'),
  hourRoundingUnit: z.string().default('30'),
}).default({ hourRoundingMode: 'ceil', hourRoundingUnit: '30' });

export async function rateCardRoutes(app: FastifyInstance) {
  const db = app.db;

  const options = (req: Parameters<typeof requirePerm>[0], o: z.infer<typeof Options>): RegisterOptions => {
    const mayApprove = can(req.user, 'rate.approve') && can(req.user, 'tax.approve');
    if (o.approve && !mayApprove) throw forbidden('Approving rates and tax needs approver rights; import without approval so an approver can approve them.');
    return {
      newRatesFrom: o.newRatesFrom ?? defaultFyStart(today()),
      changesFrom: o.changesFrom ?? today(),
      approve: o.approve ?? mayApprove,
      hourRoundingMode: o.hourRoundingMode,
      hourRoundingUnit: o.hourRoundingUnit,
    };
  };
  const loadWb = async (fileId: string) => {
    const f = await loadFile(db, fileId);
    if (!f) throw notFound('Uploaded file');
    return readWorkbook(f.buf, path.extname(f.meta.original_name).toLowerCase(), filePath(f.meta));
  };

  // --- Department & Rate Register ------------------------------------------------------
  app.post('/imports/register/upload', async (req) => {
    requirePerm(req, 'rate.write');
    requirePerm(req, 'client.write');
    const file = await req.file();
    if (!file) throw badRequest('Choose the register workbook');
    const buf = await file.toBuffer();
    const ext = checkUpload(file.filename, buf, ['.xlsx', '.xls']);
    const stored = await saveFile(db, file.filename, buf, req.user!.id);
    const o = options(req, {} as never);
    const wb = await readWorkbook(buf, ext, filePath(stored));
    try {
      return { fileId: stored.id, fileName: stored.original_name, options: o, canApprove: can(req.user, 'rate.approve') && can(req.user, 'tax.approve'), ...(await analyseRegister(db, wb, o)) };
    } catch (e) { throw badRequest((e as Error).message); }
  });

  app.post('/imports/register/analyze', async (req) => {
    requirePerm(req, 'rate.write');
    const b = parse(z.object({ fileId: uuid, options: Options }), req.body);
    const o = options(req, b.options);
    return { options: o, ...(await analyseRegister(db, await loadWb(b.fileId), o)) };
  });

  app.post('/imports/register/commit', async (req) => {
    requirePerm(req, 'rate.write');
    requirePerm(req, 'client.write');
    const b = parse(z.object({ fileId: uuid, options: Options, skipInvalid: z.boolean().default(false) }), req.body);
    const o = options(req, b.options);
    const wb = await loadWb(b.fileId);
    const userId = req.user!.id;
    try {
      return await db.tx(async (t) => {
        const a = await analyseRegister(t, wb, o);
        const res = await applyRegister(t, a, o, userId, b.skipInvalid, approveVersion);
        const run = await t.one<{ id: string }>(
          `INSERT INTO import_runs(entity, context, file_id, sheet, added, updated, unchanged, skipped, errors, results, created_by)
           VALUES ('rate_register',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [{ options: o }, b.fileId, [a.sheets.master, a.sheets.rates].filter(Boolean).join(' + '), res.departmentsAdded + res.ratesAdded, res.departmentsUpdated + res.ratesUpdated,
            a.summary.departments.unchanged + a.summary.rates.unchanged, a.summary.departments.errors + a.summary.rates.errors, a.summary.departments.errors + a.summary.rates.errors,
            JSON.stringify([...a.departments.map((d) => ({ rowNumber: d.rowNumber, key: `Department: ${d.name}`, action: d.action, errors: d.errors, warnings: d.warnings })),
              ...a.rates.map((r) => ({ rowNumber: r.rowNumber, key: `${r.clientName} — ${r.vehicle} — ${r.package}`, action: r.action, errors: r.errors, warnings: r.warnings }))]), userId],
        );
        await audit(t, userId, 'import', run!.id, 'import_rate_register', undefined, res);
        return { runId: run!.id, ...res };
      });
    } catch (e) {
      if ((e as { status?: number }).status === 409) throw Object.assign(e as Error, { statusCode: 409 });
      throw e;
    }
  });

  app.get('/imports/register/export.xlsx', { preHandler: perm('export') }, async (req, reply) => {
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    const d = q.date ?? today();
    reply.header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    reply.header('Content-Disposition', `attachment; filename="LR_Taxi_Services_Department_Rate_Register_${d}.xlsx"`);
    return reply.send(await exportRegister(db, d));
  });

  // --- One department's rate card -----------------------------------------------------
  app.get('/clients/:id/rate-card', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const q = parse(z.object({ date: isoDate.optional() }), req.query);
    const c = await db.one<{ id: string; name: string; gstin: string | null; billing_registration: string | null }>('SELECT * FROM clients WHERE id = $1', [id]);
    if (!c) throw notFound('Department');
    const contract = await rateCardContract(db, id, { create: false, startDate: today() });
    const date = q.date ?? today();
    const rates = contract.id ? await currentRates(db, contract.id, date) : [];
    const cs = c.gstin?.slice(0, 2) ?? null;
    const ss = registrationState(c.billing_registration);
    const contracts = await db.query(`SELECT id, reference_no, title, status FROM contracts WHERE client_id = $1 ORDER BY start_date DESC`, [id]);
    const taxRules = contract.id ? await db.query(`SELECT tax_type, rate, status, effective_from, effective_to FROM tax_rules WHERE contract_id = $1 AND status <> 'retired' ORDER BY effective_from DESC`, [contract.id]) : [];
    return {
      client: { id: c.id, name: c.name, gstin: c.gstin, billingRegistration: c.billing_registration },
      contract: { id: contract.id, label: contract.label, warning: contract.warning ?? null }, contracts, taxRules, date,
      rates: rates.map((r) => ({ ...r, taxShown: taxDisplay(resolveTax(r.entry, cs, ss)) })),
      canApprove: can(req.user, 'rate.approve') && can(req.user, 'tax.approve'),
    };
  });

  /** Add or change one rate. A change is a new version from `effectiveFrom`; earlier duties keep the old rate. */
  app.post('/clients/:id/rate-card', async (req) => {
    requirePerm(req, 'rate.write');
    const { id } = req.params as { id: string };
    const b = parse(z.object({
      entry: z.record(z.string(), z.unknown()), schemeId: uuid.nullable().optional(), effectiveFrom: isoDate, approve: z.boolean().default(false),
      hourRoundingMode: z.enum(['exact', 'ceil', 'floor', 'nearest']).default('ceil'), hourRoundingUnit: z.string().default('30'),
    }), req.body);
    if (b.approve) { requirePerm(req, 'rate.approve'); requirePerm(req, 'tax.approve'); }
    const entry = normaliseEntry(b.entry as never);
    const { errors } = checkEntry(entry);
    if (errors.length) throw badRequest(errors.join('; '), errors);
    const userId = req.user!.id;
    return db.tx(async (t) => {
      const c = await t.one<{ gstin: string | null; billing_registration: string | null }>('SELECT gstin, billing_registration FROM clients WHERE id = $1', [id]);
      if (!c) throw notFound('Department');
      const contract = await rateCardContract(t, id, { create: true, startDate: b.effectiveFrom, userId });
      const current = await currentRates(t, contract.id!, b.effectiveFrom);
      const cat = await categoryFor(t, entry.vehicle, false);
      const ex = b.schemeId ? current.find((r) => r.schemeId === b.schemeId) : findExistingRate(current, cat.id, entry);
      if (ex && ex.status === 'approved' && b.effectiveFrom <= ex.effectiveFrom) {
        throw badRequest(`This rate is in force from ${ex.effectiveFrom}. Apply the change from a later date so earlier duties keep their rate.`);
      }
      const all = [...current.filter((r) => r.schemeId !== ex?.schemeId).map((r) => r.entry), entry];
      const siblings = all.filter((e) => e.vehicle.toLowerCase() === entry.vehicle.toLowerCase());
      const saved = await saveRate(t, { contractId: contract.id!, entry, siblings, effectiveFrom: b.effectiveFrom, options: b, userId, approve: b.approve, local: localPackages(all).has(entry), schemeId: ex?.schemeId, source: 'Rate card screen' }, approveVersion);
      const tax = resolveTax(entry, c.gstin?.slice(0, 2) ?? null, registrationState(c.billing_registration));
      const taxChange = await syncTax(t, contract.id!, tax, current.length ? b.effectiveFrom : b.effectiveFrom, userId, b.approve);
      return { ...saved, contract: contract.label, taxChange, approved: b.approve };
    });
  });

  /** Stops a rate after `lastDay`. Earlier duties keep it; nothing is deleted. */
  app.post('/clients/:id/rate-card/:schemeId/end', async (req) => {
    requirePerm(req, 'rate.approve');
    const { schemeId } = req.params as { id: string; schemeId: string };
    const b = parse(z.object({ lastDay: isoDate.default(addDays(today(), -1)) }), req.body ?? {});
    await db.tx((t) => endRate(t, schemeId, b.lastDay, req.user!.id));
    return { ok: true };
  });

  app.put('/clients/:id/rate-card-contract', async (req) => {
    requirePerm(req, 'rate.write');
    const { id } = req.params as { id: string };
    const { contractId } = parse(z.object({ contractId: uuid }), req.body);
    const k = await db.one<{ client_id: string }>('SELECT client_id FROM contracts WHERE id = $1', [contractId]);
    if (!k || k.client_id !== id) throw badRequest('That contract belongs to a different department');
    await db.query('UPDATE clients SET rate_card_contract_id = $2 WHERE id = $1', [id, contractId]);
    await audit(db, req.user!.id, 'client', id, 'set_rate_card_contract', undefined, { contractId });
    return { ok: true };
  });
}
