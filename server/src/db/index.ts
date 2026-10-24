/**
 * Thin database layer over either a real PostgreSQL / Supabase server (`pg`)
 * or an embedded PGlite instance for local development and tests. Both run
 * the same SQL and migrations.
 */
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { config } from '../config.js';

export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T | null>;
  exec(sql: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

// Keep numerics, dates and timestamps as exact strings — never JS numbers or shifted Dates.
const OID = { INT8: 20, NUMERIC: 1700, DATE: 1082, TIMESTAMP: 1114, TIMESTAMPTZ: 1184 };
const asString = (v: string) => v;
const tsToIsoLike = (v: string) => v; // 'YYYY-MM-DD HH:MM:SS'

function normalizeParams(params: unknown[] = []): unknown[] {
  return params.map((p) => (p !== null && typeof p === 'object' && !(p instanceof Date) && !Array.isArray(p) ? JSON.stringify(p) : p));
}

function fromPg(pool: pg.Pool | pg.PoolClient, isClient = false): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await pool.query(sql, normalizeParams(params));
      return r.rows;
    },
    async one(sql, params) {
      const rows = await db.query(sql, params);
      return (rows[0] as never) ?? null;
    },
    async exec(sql) {
      await pool.query(sql);
    },
    async tx(fn) {
      if (isClient) return fn(db);
      const client = await (pool as pg.Pool).connect();
      try {
        await client.query('BEGIN');
        const r = await fn(fromPg(client, true));
        await client.query('COMMIT');
        return r;
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }
    },
    async close() {
      if (!isClient) await (pool as pg.Pool).end();
    },
  };
  return db;
}

const LITE_PARSERS = {
  [OID.INT8]: (v: string) => Number(v),
  [OID.NUMERIC]: asString,
  [OID.DATE]: asString,
  [OID.TIMESTAMP]: tsToIsoLike,
  [OID.TIMESTAMPTZ]: (v: string) => new Date(v).toISOString(),
};

type PgliteLike = Pick<PGlite, 'query' | 'exec'> & { transaction?: PGlite['transaction'] };

function fromPglite(lite: PgliteLike, root?: PGlite): Db {
  const db: Db = {
    async query(sql, params) {
      const r = await lite.query(sql, normalizeParams(params), { parsers: LITE_PARSERS });
      return r.rows as never[];
    },
    async one(sql, params) {
      const rows = await db.query(sql, params);
      return (rows[0] as never) ?? null;
    },
    async exec(sql) {
      await lite.exec(sql);
    },
    async tx(fn) {
      if (!lite.transaction) return fn(db);
      return lite.transaction(async (t) => fn(fromPglite(t as unknown as PgliteLike)));
    },
    async close() {
      await root?.close();
    },
  };
  return db;
}

export async function createDb(url = config.databaseUrl): Promise<Db> {
  if (url && /^postgres(ql)?:\/\//.test(url)) {
    pg.types.setTypeParser(OID.INT8, (v: string) => Number(v));
    pg.types.setTypeParser(OID.NUMERIC, asString);
    pg.types.setTypeParser(OID.DATE, asString);
    pg.types.setTypeParser(OID.TIMESTAMP, tsToIsoLike);
    pg.types.setTypeParser(OID.TIMESTAMPTZ, (v: string) => new Date(v).toISOString());
    const pool = new pg.Pool({ connectionString: url, max: 10, ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined });
    return fromPg(pool);
  }
  // Embedded PGlite: 'memory://' for tests, otherwise a directory path.
  const dir = url && url !== 'memory://' ? url.replace(/^pglite:\/\//, '') : undefined;
  if (dir) fs.mkdirSync(path.dirname(path.resolve(dir)), { recursive: true });
  const lite = new PGlite(dir);
  await lite.waitReady;
  return fromPglite(lite, lite);
}
