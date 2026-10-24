import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;

export const config = {
  root,
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? '127.0.0.1',
  /** postgres://... for PostgreSQL/Supabase, a directory path for embedded PGlite, or memory:// */
  databaseUrl: env.DATABASE_URL ?? path.join(root, 'data', 'pglite'),
  databaseSsl: env.DATABASE_SSL === 'true',
  storageDir: path.resolve(root, env.STORAGE_DIR ?? 'data/files'),
  maxUploadMb: Number(env.MAX_UPLOAD_MB ?? 25),
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE === 'true',
  pythonBin: env.PYTHON_BIN ?? path.join(root, 'worker', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  workerScript: path.join(root, 'worker', 'extract.py'),
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  webDist: path.join(root, 'web', 'dist'),
  isTest: env.NODE_ENV === 'test' || env.VITEST === 'true',
};
