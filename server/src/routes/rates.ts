import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { badRequest, conflict, forbidden, isoDate, notFound, optText, parse, uuid } from '../lib/http.js';
import { calculateDuty, DUTY_VARIABLES, PERIOD_VARIABLES } from '../engine/duty.js';
import { calculateBill } from '../engine/bill.js';
import { parse as parseExpr, referencedVariables } from '../engine/expr.js';
import { RateConfigSchema, type RateConfig, type SchemeVersion } from '../engine/types.js';
import { addDays } from '../engine/time.js';
import { getSetting } from './master.js';

const VersionSchema = z.object({
  effective_from: isoDate,
  effective_to: isoDate.nullable().optional(),
  vehicle_category_ids: z.array(uuid).default([]),
  duty_type_codes: z.array(z.string()).default([]),
  config: z.unknown(),
  clause_ref: optText,
  notes: optText,
});

/** Checks the configuration and every expression; returns problems rather than throwing. */
export function lintConfig(raw: unknown, customFieldKeys: string[] = []): { config?: RateConfig; problems: string[] } {
  const r = RateConfigSchema.safeParse(raw);
  if (!r.success) return { problems: r.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  const cfg = r.data;
  const problems: string[] = [];
  const dutyVars = new Set([...Object.keys(DUTY_VARIABLES), ...customFieldKeys.map((k) => `f_${k}`)]);
  for (const v of cfg.params.variables) {
    try {
      for (const ref of referencedVariables(v.expr)) if (!dutyVars.has(ref)) problems.push(`Variable ${v.name}: unknown name "${ref}"`);
    } catch (e) {
      problems.push(`Variable ${v.name}: ${(e as Error).message}`);
    }
    dutyVars.add(v.name);
  }
  const codes = new Set<string>();
  for (const c of cfg.components) {
    if (codes.has(c.code)) problems.push(`Duplicate component code ${c.code}`);
    codes.add(c.code);
    const allowed = c.scope === 'duty' ? dutyVars : new Set(Object.keys(PERIOD_VARIABLES).concat(['included_km', 'included_hours']));
    for (const [what, expr] of [['quantity', c.quantityExpr], ['condition', c.condition]] as const) {
      if (!expr) continue;
      try {
        parseExpr(expr);
        for (const ref of referencedVariables(expr)) if (!allowed.has(ref)) problems.push(`${c.code} ${what}: "${ref}" is not available for ${c.scope} components`);
      } catch (e) {
        problems.push(`${c.code} ${what}: ${(e as Error).message}`);
      }
    }
  }
  return { config: cfg, problems };
}

export async function loadSchemeVersions(db: Db, contractId: string, onlyApproved = true): Promise<SchemeVersion[]> {
  const rows = await db.query<{
    id: string; scheme_id: string; name: string; version_no: number; status: string; effective_from: string; effective_to: string | null;
    vehicle_category_ids: string[]; duty_type_codes: string[]; config: unknown;
  }>(
    `SELECT v.*, s.name FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id
     WHERE s.contract_id = $1 AND ($2::boolean = false OR v.status = 'approved')`,
    [contractId, onlyApproved],
  );
  return rows.map((r) => ({
    id: r.id, schemeId: r.scheme_id, schemeName: r.name, versionNo: r.version_no, status: r.status, effectiveFrom: r.effective_from,
    effectiveTo: r.effective_to, vehicleCategoryIds: r.vehicle_category_ids ?? [], dutyTypeCodes: r.duty_type_codes ?? [],
    config: RateConfigSchema.parse(r.config),
  }));
}

const overlaps = (aFrom: string, aTo: string | null, bFrom: string, bTo: string | null) => aFrom <= (bTo ?? '9999-12-31') && bFrom <= (aTo ?? '9999-12-31');
const setsIntersect = (a: string[], b: string[]) => a.length === 0 || b.length === 0 || a.some((x) => b.includes(x));

/**
 * Approves a submitted rate version (inside the caller's transaction): maker-checker, configuration
 * check, closing the previous version of the same scheme the day before, and refusing overlaps.
 */
export async function approveVersion(t: Db, id: string, userId: string, note: string | null = null) {
  const v = await t.one<{ id: string; scheme_id: string; status: string; config: unknown; effective_from: string; effective_to: string | null; vehicle_category_ids: string[]; duty_type_codes: string[]; created_by: string; submitted_by: string; clause_ref: string | null }>(
    'SELECT * FROM rate_scheme_versions WHERE id = $1 FOR UPDATE', [id]);
  if (!v) throw notFound('Rate version');
  if (v.status !== 'pending_approval') throw conflict('Only versions submitted for approval can be approved');
  if ((await getSetting<boolean>(t, 'makerChecker')) && [v.created_by, v.submitted_by].includes(userId)) throw forbidden('Maker-checker is enabled: a different user must approve this rate version.');
  const lint = lintConfig(v.config);
  if (lint.problems.length) throw badRequest('Configuration has problems', lint.problems);
  // Close the previous open-ended version of the same scheme when the new one starts later.
  const prev = await t.query<{ id: string; effective_from: string; effective_to: string | null }>(
    `SELECT id, effective_from, effective_to FROM rate_scheme_versions WHERE scheme_id = $1 AND status = 'approved' AND id <> $2`, [v.scheme_id, id]);
  for (const p of prev) {
    if (p.effective_from < v.effective_from && (p.effective_to == null || p.effective_to >= v.effective_from)) {
      const newTo = addDays(v.effective_from, -1);
      await t.query('UPDATE rate_scheme_versions SET effective_to = $2 WHERE id = $1', [p.id, newTo]);
      await audit(t, userId, 'rate_version', p.id, 'auto_close', { effective_to: p.effective_to }, { effective_to: newTo }, `Superseded by version ${id}`);
    }
  }
  // Any remaining overlap with another approved version (same contract, same categories/duty types) would be ambiguous.
  const contract = await t.one<{ contract_id: string }>('SELECT contract_id FROM rate_schemes WHERE id = $1', [v.scheme_id]);
  const others = await t.query<{ id: string; name: string; version_no: number; effective_from: string; effective_to: string | null; vehicle_category_ids: string[]; duty_type_codes: string[] }>(
    `SELECT v.id, s.name, v.version_no, v.effective_from, v.effective_to, v.vehicle_category_ids, v.duty_type_codes FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id
     WHERE s.contract_id = $1 AND v.status = 'approved' AND v.id <> $2`, [contract!.contract_id, id]);
  const clashes = others.filter(
    (o) => overlaps(o.effective_from, o.effective_to, v.effective_from, v.effective_to) &&
      setsIntersect(o.vehicle_category_ids ?? [], v.vehicle_category_ids ?? []) && setsIntersect(o.duty_type_codes ?? [], v.duty_type_codes ?? []) &&
      (o.vehicle_category_ids ?? []).length === (v.vehicle_category_ids ?? []).length && (o.duty_type_codes ?? []).length === (v.duty_type_codes ?? []).length,
  );
  if (clashes.length) throw conflict(`Overlaps approved version(s): ${clashes.map((c) => `${c.name} v${c.version_no} (${c.effective_from} – ${c.effective_to ?? 'open'})`).join(', ')}. Adjust dates or categories.`);
  const row = await t.one(`UPDATE rate_scheme_versions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1 RETURNING *`, [id, userId]);
  await t.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('rate_version',$1,'approve',$2,$3)`, [id, userId, note]);
  await audit(t, userId, 'rate_version', id, 'approve', { status: v.status }, { status: 'approved' }, note ?? undefined);
  return row;
}

export async function rateRoutes(app: FastifyInstance) {
  const db = app.db;

  app.get('/rates/variables', { preHandler: perm('view') }, async () => ({ duty: DUTY_VARIABLES, period: PERIOD_VARIABLES }));

  app.get('/rate-schemes', { preHandler: perm('view') }, async (req) => {
    const q = req.query as { contractId?: string };
    return db.query(
      `SELECT s.*, k.title AS contract_title, k.reference_no, c.name AS client_name,
              (SELECT json_agg(json_build_object('id', v.id, 'version_no', v.version_no, 'status', v.status, 'effective_from', v.effective_from, 'effective_to', v.effective_to, 'billing_model', v.config->>'billingModel') ORDER BY v.version_no)
               FROM rate_scheme_versions v WHERE v.scheme_id = s.id) AS versions
       FROM rate_schemes s JOIN contracts k ON k.id = s.contract_id JOIN clients c ON c.id = k.client_id
       WHERE ($1::uuid IS NULL OR s.contract_id = $1) ORDER BY c.name, s.name`,
      [q.contractId || null],
    );
  });

  app.post('/rate-schemes', { preHandler: perm('rate.write') }, async (req) => {
    const b = parse(z.object({ contract_id: uuid, name: z.string().trim().min(1), description: optText }), req.body);
    const row = await db.one<{ id: string }>('INSERT INTO rate_schemes(contract_id, name, description) VALUES ($1,$2,$3) RETURNING *', [b.contract_id, b.name, b.description]);
    await audit(db, req.user!.id, 'rate_scheme', row!.id, 'create', undefined, b);
    return row;
  });

  app.get('/rate-versions/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const v = await db.one(
      `SELECT v.*, s.name AS scheme_name, s.contract_id, k.title AS contract_title, k.custom_fields, cu.name AS created_by_name, au.name AS approved_by_name
       FROM rate_scheme_versions v JOIN rate_schemes s ON s.id = v.scheme_id JOIN contracts k ON k.id = s.contract_id
       LEFT JOIN app_users cu ON cu.id = v.created_by LEFT JOIN app_users au ON au.id = v.approved_by WHERE v.id = $1`,
      [id],
    );
    if (!v) throw notFound('Rate version');
    return v;
  });

  app.post('/rate-schemes/:id/versions', { preHandler: perm('rate.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(VersionSchema, req.body);
    const lint = lintConfig(b.config);
    if (!lint.config) throw badRequest('Rate configuration is invalid', lint.problems);
    const row = await db.tx(async (t) => {
      const next = await t.one<{ n: number }>('SELECT COALESCE(max(version_no),0)+1 AS n FROM rate_scheme_versions WHERE scheme_id = $1', [id]);
      return t.one<{ id: string }>(
        `INSERT INTO rate_scheme_versions(scheme_id, version_no, effective_from, effective_to, vehicle_category_ids, duty_type_codes, config, clause_ref, notes, created_by)
         VALUES ($1,$2,$3,$4,$5::uuid[],$6::text[],$7,$8,$9,$10) RETURNING *`,
        [id, next!.n, b.effective_from, b.effective_to ?? null, b.vehicle_category_ids, b.duty_type_codes, lint.config, b.clause_ref, b.notes, req.user!.id],
      );
    });
    await audit(db, req.user!.id, 'rate_version', row!.id, 'create', undefined, b);
    return { ...row, problems: lint.problems };
  });

  app.put('/rate-versions/:id', { preHandler: perm('rate.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(VersionSchema, req.body);
    const before = await db.one<{ status: string }>('SELECT * FROM rate_scheme_versions WHERE id = $1', [id]);
    if (!before) throw notFound('Rate version');
    if (!['draft', 'rejected'].includes(before.status)) throw conflict(`A ${before.status} version cannot be edited. Create a new version.`);
    const lint = lintConfig(b.config);
    if (!lint.config) throw badRequest('Rate configuration is invalid', lint.problems);
    const row = await db.one(
      `UPDATE rate_scheme_versions SET effective_from=$2, effective_to=$3, vehicle_category_ids=$4::uuid[], duty_type_codes=$5::text[], config=$6, clause_ref=$7, notes=$8, status='draft'
       WHERE id=$1 RETURNING *`,
      [id, b.effective_from, b.effective_to ?? null, b.vehicle_category_ids, b.duty_type_codes, lint.config, b.clause_ref, b.notes],
    );
    await audit(db, req.user!.id, 'rate_version', id, 'update', before, row);
    return { ...row, problems: lint.problems };
  });

  app.post('/rate-versions/:id/clone', { preHandler: perm('rate.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const src = await db.one<{ scheme_id: string; config: unknown; vehicle_category_ids: string[]; duty_type_codes: string[]; clause_ref: string | null; effective_from: string }>(
      'SELECT * FROM rate_scheme_versions WHERE id = $1', [id]);
    if (!src) throw notFound('Rate version');
    const b = parse(z.object({ effective_from: isoDate.optional() }), req.body ?? {});
    const row = await db.tx(async (t) => {
      const next = await t.one<{ n: number }>('SELECT COALESCE(max(version_no),0)+1 AS n FROM rate_scheme_versions WHERE scheme_id = $1', [src.scheme_id]);
      return t.one<{ id: string }>(
        `INSERT INTO rate_scheme_versions(scheme_id, version_no, effective_from, vehicle_category_ids, duty_type_codes, config, clause_ref, notes, created_by)
         VALUES ($1,$2,$3,$4::uuid[],$5::text[],$6,$7,$8,$9) RETURNING *`,
        [src.scheme_id, next!.n, b.effective_from ?? src.effective_from, src.vehicle_category_ids, src.duty_type_codes, src.config, src.clause_ref, `Copied from version ${id}`, req.user!.id],
      );
    });
    await audit(db, req.user!.id, 'rate_version', row!.id, 'clone', undefined, { from: id });
    return row;
  });

  app.post('/rate-versions/:id/submit', { preHandler: perm('rate.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const v = await db.one<{ status: string; config: unknown }>('SELECT * FROM rate_scheme_versions WHERE id = $1', [id]);
    if (!v) throw notFound('Rate version');
    if (!['draft', 'rejected'].includes(v.status)) throw conflict(`Version is ${v.status}`);
    const lint = lintConfig(v.config);
    if (lint.problems.length) throw badRequest('Fix the configuration problems before submitting', lint.problems);
    const row = await db.one(`UPDATE rate_scheme_versions SET status='pending_approval', submitted_by=$2 WHERE id=$1 RETURNING *`, [id, req.user!.id]);
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id) VALUES ('rate_version',$1,'submit',$2)`, [id, req.user!.id]);
    await audit(db, req.user!.id, 'rate_version', id, 'submit');
    return row;
  });

  app.post('/rate-versions/:id/approve', { preHandler: perm('rate.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const note = parse(z.object({ note: optText }), req.body ?? {}).note;
    return db.tx((t) => approveVersion(t, id, req.user!.id, note));
  });

  /** Approve many pending versions at once. Each one goes through the normal approval checks on its own; the ones that fail are listed, not hidden. */
  app.post('/rate-versions/approve-all', { preHandler: perm('rate.approve') }, async (req) => {
    const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(2000), note: optText }), req.body);
    const approved: string[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const id of b.ids) {
      try { await db.tx((t) => approveVersion(t, id, req.user!.id, b.note ?? 'Approved in bulk')); approved.push(id); }
      catch (e) { skipped.push({ id, reason: (e as Error).message }); }
    }
    await audit(db, req.user!.id, 'rate_version', approved[0] ?? b.ids[0], 'approve_all', undefined, { approved: approved.length, skipped: skipped.length });
    return { approved: approved.length, skipped };
  });

  app.post('/rate-versions/:id/reject', { preHandler: perm('rate.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const { note } = parse(z.object({ note: z.string().min(1, 'Give a reason') }), req.body);
    const row = await db.one(`UPDATE rate_scheme_versions SET status='rejected' WHERE id=$1 AND status='pending_approval' RETURNING *`, [id]);
    if (!row) throw conflict('Only versions pending approval can be rejected');
    await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('rate_version',$1,'reject',$2,$3)`, [id, req.user!.id, note]);
    await audit(db, req.user!.id, 'rate_version', id, 'reject', undefined, undefined, note);
    return row;
  });

  app.post('/rate-versions/:id/retire', { preHandler: perm('rate.approve') }, async (req) => {
    const { id } = req.params as { id: string };
    const row = await db.one(`UPDATE rate_scheme_versions SET status='retired' WHERE id=$1 AND status='approved' RETURNING *`, [id]);
    if (!row) throw conflict('Only approved versions can be retired');
    await audit(db, req.user!.id, 'rate_version', id, 'retire');
    return row;
  });

  /** Test calculator: works on unsaved or draft configurations, never writes anything. */
  app.post('/rates/test', { preHandler: perm('view') }, async (req) => {
    const b = parse(
      z.object({
        config: z.unknown(),
        duties: z.array(z.object({
          dutyDate: isoDate, vehicleRegNo: z.string().default('TEST'), startKm: z.string().nullable().optional(), endKm: z.string().nullable().optional(),
          startAt: z.string().nullable().optional(), endAt: z.string().nullable().optional(), toll: z.string().nullable().optional(), parking: z.string().nullable().optional(),
          otherCharges: z.string().nullable().optional(), dutyTypeCode: z.string().nullable().optional(), vehicleCategoryName: z.string().nullable().optional(),
          customFields: z.record(z.string(), z.unknown()).optional(),
        })).min(1).max(100),
        periodStart: isoDate.optional(),
        periodEnd: isoDate.optional(),
      }),
      req.body,
    );
    const lint = lintConfig(b.config);
    if (!lint.config) return { problems: lint.problems, results: [] };
    const version: SchemeVersion = {
      id: 'test', schemeId: 'test', schemeName: 'Test calculator', versionNo: 0, status: 'approved', effectiveFrom: '0001-01-01', effectiveTo: null,
      vehicleCategoryIds: [], dutyTypeCodes: [], config: lint.config,
    };
    const duties = b.duties.map((d, i) => ({
      id: `test-${i + 1}`, dutyDate: d.dutyDate, vehicleRegNo: d.vehicleRegNo, vehicleCategoryId: null, vehicleCategoryName: d.vehicleCategoryName ?? null,
      dutyTypeCode: d.dutyTypeCode ?? null, startKm: d.startKm ?? null, endKm: d.endKm ?? null, startAt: d.startAt ?? null, endAt: d.endAt ?? null,
      toll: d.toll ?? null, parking: d.parking ?? null, otherCharges: d.otherCharges ?? null, customFields: d.customFields,
    }));
    const results = duties.map((d) => {
      try {
        const r = calculateDuty(d, version);
        return { dutyId: d.id, ok: true, lines: r.lines, variables: r.variables, missing: r.missing };
      } catch (e) {
        return { dutyId: d.id, ok: false, error: (e as Error).message, lines: [], variables: {}, missing: {} };
      }
    });
    const dates = duties.map((d) => d.dutyDate).sort();
    const bill = calculateBill({
      periodStart: b.periodStart ?? dates[0], periodEnd: b.periodEnd ?? dates[dates.length - 1], duties, schemes: [version], taxRules: [],
      settings: { taxMode: 'exclusive', taxLevel: 'document', invoiceRounding: 'none' },
    });
    return {
      problems: lint.problems,
      results,
      periodLines: bill.lines.filter((l) => l.scope !== 'duty'),
      totals: bill.totals,
      note: 'Test calculation only — taxes are not applied here; they come from the contract\'s approved tax rules.',
    };
  });
}
