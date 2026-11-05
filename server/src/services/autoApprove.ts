/**
 * When approvals are not required (the default for this software), what a person uploads or saves is used straight away: tax rules, rate
 * versions and bill template versions waiting in draft are approved as soon as the request that created them has finished, as that
 * person. The technical checks stay (a rate version that overlaps another, a configuration with problems, a tax rule with no source
 * reference, an Excel template with unmapped cells are left as they are and keep their reason), and every approval is written to the audit log.
 */
import type { Db } from '../db/index.js';
import { audit } from '../lib/audit.js';
import { approveVersion, lintConfig } from '../routes/rates.js';
import { LayoutSchema } from './render.js';

/** Items that could not be approved, so they are not tried again on every request for a few minutes. */
const failed = new Map<string, number>();
const recentlyFailed = (id: string) => (failed.get(id) ?? 0) > Date.now() - 5 * 60_000;

export async function settleApprovals(db: Db, userId: string): Promise<{ tax: number; rates: number; templates: number }> {
  const done = { tax: 0, rates: 0, templates: 0 };

  for (const r of await db.query<{ id: string; created_by: string | null }>(`SELECT id, created_by FROM tax_rules WHERE status = 'draft' AND source_ref IS NOT NULL AND source_ref <> ''`)) {
    if (recentlyFailed(r.id)) continue;
    try {
      await db.query(`UPDATE tax_rules SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1 AND status = 'draft'`, [r.id, userId]);
      await db.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('tax_rule',$1,'approve',$2,'Used as uploaded')`, [r.id, userId]);
      await audit(db, userId, 'tax_rule', r.id, 'approve', undefined, undefined, 'Used as uploaded (approvals are not required)');
      done.tax++;
    } catch { failed.set(r.id, Date.now()); }
  }

  const versions = await db.query<{ id: string; status: string; config: unknown }>(
    `SELECT id, status, config FROM rate_scheme_versions WHERE status IN ('draft','pending_approval') AND (effective_to IS NULL OR effective_to >= current_date) ORDER BY created_at LIMIT 300`);
  for (const v of versions) {
    if (recentlyFailed(v.id)) continue;
    try {
      if (v.status === 'draft') {
        const lint = lintConfig(v.config);
        if (lint.problems.length) { failed.set(v.id, Date.now()); continue; }   // still being filled in
        await db.query(`UPDATE rate_scheme_versions SET status = 'pending_approval', submitted_by = $2 WHERE id = $1 AND status = 'draft'`, [v.id, userId]);
      }
      await db.tx((t) => approveVersion(t, v.id, userId, 'Used as uploaded'));
      done.rates++;
    } catch { failed.set(v.id, Date.now()); }
  }

  for (const v of await db.query<{ id: string; template_id: string; layout: unknown; xlsx_file_id: string | null; xlsx_mapping: unknown }>(`SELECT id, template_id, layout, xlsx_file_id, xlsx_mapping FROM billing_template_versions WHERE status = 'draft'`)) {
    if (recentlyFailed(v.id)) continue;
    try {
      LayoutSchema.parse(v.layout);
      if (v.xlsx_file_id && !v.xlsx_mapping) { failed.set(v.id, Date.now()); continue; }
      await db.tx(async (t) => {
        await t.query(`UPDATE billing_template_versions SET status = 'retired' WHERE template_id = $1 AND status = 'approved'`, [v.template_id]);
        await t.query(`UPDATE billing_template_versions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [v.id, userId]);
        await t.query(`INSERT INTO approvals(entity_type, entity_id, action, user_id, note) VALUES ('template_version',$1,'approve',$2,'Used as uploaded')`, [v.id, userId]);
        await audit(t, userId, 'template_version', v.id, 'approve', undefined, undefined, 'Used as uploaded (approvals are not required)');
      });
      done.templates++;
    } catch { failed.set(v.id, Date.now()); }
  }
  return done;
}
