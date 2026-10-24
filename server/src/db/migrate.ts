import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/db (compiled).
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    log(`applied migration ${f}`);
    applied.push(f);
  }
  return applied;
}
