import type { Db } from '../db/index.js';

export async function audit(
  db: Db,
  userId: string | null | undefined,
  entityType: string,
  entityId: string | null,
  action: string,
  before?: unknown,
  after?: unknown,
  note?: string,
) {
  await db.query(
    'INSERT INTO audit_events(user_id, entity_type, entity_id, action, before, after, note) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [userId ?? null, entityType, entityId, action, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after), note ?? null],
  );
}

/** Returns only keys whose values changed, for compact audit records. */
export function diff(before: Record<string, unknown>, after: Record<string, unknown>) {
  const b: Record<string, unknown> = {};
  const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(after[k])) {
      b[k] = before[k];
      a[k] = after[k];
    }
  }
  return { before: b, after: a, changed: Object.keys(a).length > 0 };
}
