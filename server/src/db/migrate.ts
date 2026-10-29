import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// Works from both src/db (tsx) and dist/db (compiled).
export const MIGRATIONS_DIR = path.resolve(here, '../../migrations');

/**
 * Every migration, named one by one so serverless bundlers (Vercel) see and include the files;
 * a directory listing is not traced. A test checks this list against the migrations folder.
 */
export const MIGRATIONS: [string, URL][] = [
  ['001_init.sql', new URL('../../migrations/001_init.sql', import.meta.url)],
  ['002_onboarding.sql', new URL('../../migrations/002_onboarding.sql', import.meta.url)],
  ['003_master_data.sql', new URL('../../migrations/003_master_data.sql', import.meta.url)],
  ['004_rate_register.sql', new URL('../../migrations/004_rate_register.sql', import.meta.url)],
  ['005_file_content.sql', new URL('../../migrations/005_file_content.sql', import.meta.url)],
  ['006_lr_arithmetic.sql', new URL('../../migrations/006_lr_arithmetic.sql', import.meta.url)],
];

export async function migrate(db: Db, log: (m: string) => void = () => {}): Promise<string[]> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
  const done = new Set((await db.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const applied: string[] = [];
  for (const [f, url] of MIGRATIONS) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(url, 'utf8');
    await db.tx(async (t) => {
      await t.exec(sql);
      await t.query('INSERT INTO schema_migrations(name) VALUES ($1)', [f]);
    });
    log(`applied migration ${f}`);
    applied.push(f);
  }
  return applied;
}
