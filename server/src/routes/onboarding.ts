import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm, requirePerm } from '../lib/auth.js';
import { badRequest, conflict, notFound, parse, uuid } from '../lib/http.js';
import { applyProposal, ApplySchema, buildProposal } from '../services/onboarding.js';

export async function onboardingRoutes(app: FastifyInstance) {
  const db = app.db;

  /** Builds a set-up proposal from documents that have finished extraction. */
  app.post('/onboarding/analyze', { preHandler: perm('document.upload') }, async (req) => {
    const { versionIds } = parse(z.object({ versionIds: z.array(uuid).min(1).max(20) }), req.body);
    const rows = await db.query<{ id: string; document_id: string; title: string; extraction_status: string; extraction_error: string | null; extracted: { pages: { page: number; text: string; tables: string[][][] }[] } | null }>(
      `SELECT v.id, v.document_id, d.title, v.extraction_status, v.extraction_error, v.extracted FROM document_versions v JOIN documents d ON d.id = v.document_id WHERE v.id = ANY($1::uuid[])`,
      [versionIds],
    );
    if (rows.length !== versionIds.length) throw notFound('Document version');
    const pending = rows.filter((r) => r.extraction_status !== 'done');
    if (pending.some((r) => r.extraction_status === 'failed')) throw badRequest(`Could not read: ${pending.filter((r) => r.extraction_status === 'failed').map((r) => `${r.title} (${r.extraction_error})`).join('; ')}`);
    if (pending.length) throw conflict(`Still reading ${pending.map((r) => r.title).join(', ')} — try again in a moment`);
    const proposal = buildProposal(rows.map((r) => ({ versionId: r.id, documentId: r.document_id, title: r.title, pages: r.extracted?.pages ?? [] })));
    const s = await db.one<{ id: string }>(
      `INSERT INTO onboarding_sessions(document_version_ids, proposal, status, created_by) VALUES ($1::uuid[], $2, 'ready', $3) RETURNING id`,
      [versionIds, proposal, req.user!.id],
    );
    await audit(db, req.user!.id, 'onboarding', s!.id, 'analyze', undefined, { documents: rows.map((r) => r.title) });
    return { sessionId: s!.id, proposal };
  });

  app.get('/onboarding/:id', { preHandler: perm('view') }, async (req) => {
    const { id } = req.params as { id: string };
    const s = await db.one('SELECT * FROM onboarding_sessions WHERE id = $1', [id]);
    if (!s) throw notFound('Onboarding session');
    return s;
  });

  /** Creates the department, contract and DRAFT rules from the reviewed proposal. */
  app.post('/onboarding/:id/apply', { preHandler: perm('client.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const user = requirePerm(req, 'rate.write');
    const body = parse(ApplySchema, req.body);
    const s = await db.one<{ status: string; document_version_ids: string[] }>('SELECT status, document_version_ids FROM onboarding_sessions WHERE id = $1', [id]);
    if (!s) throw notFound('Onboarding session');
    if (s.status === 'applied') throw conflict('This proposal has already been applied');
    const created = await applyProposal(db, { ...body, documentVersionIds: body.documentVersionIds.length ? body.documentVersionIds : s.document_version_ids }, user.id);
    await db.query(`UPDATE onboarding_sessions SET status = 'applied', applied = $2, updated_at = now() WHERE id = $1`, [id, created]);
    await audit(db, user.id, 'onboarding', id, 'apply', undefined, created);
    return created;
  });
}
