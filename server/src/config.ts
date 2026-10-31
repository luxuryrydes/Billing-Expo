import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
dotenv.config({ path: path.join(root, '.env'), quiet: true });

const env = process.env;

/**
 * A folder path in DATABASE_URL is taken from the project root, like STORAGE_DIR, so every way of starting the
 * server (npm run dev, npm start, run-local.cmd) opens the same database. PostgreSQL URLs and memory:// are kept as they are.
 */
function databaseUrl(value: string | undefined): string {
  if (!value) return path.join(root, 'data', 'pglite');
  if (/^postgres(ql)?:\/\//.test(value) || value === 'memory://') return value;
  return path.resolve(root, value.replace(/^pglite:\/\//, ''));
}
/** Running as a Vercel Function: no lasting local disk, HTTPS, 4.5 MB request limit. */
const onVercel = !!env.VERCEL;

export const config = {
  root,
  onVercel,
  port: Number(env.PORT ?? 4000),
  host: env.HOST ?? (onVercel ? '0.0.0.0' : '127.0.0.1'),
  /** postgres://... for PostgreSQL/Supabase, a directory path for embedded PGlite, or memory:// */
  databaseUrl: databaseUrl(env.DATABASE_URL),
  databaseSsl: env.DATABASE_SSL === 'true',
  /** Local copies of uploaded files. On Vercel only a temporary cache: the database holds the files. */
  storageDir: env.STORAGE_DIR ? path.resolve(root, env.STORAGE_DIR) : onVercel ? path.join(os.tmpdir(), 'lrbill-files') : path.join(root, 'data', 'files'),
  /** Keep file contents in the database so every server instance can read them. */
  storeFilesInDb: env.STORE_FILES_IN_DB ? env.STORE_FILES_IN_DB === 'true' : onVercel,
  maxUploadMb: Number(env.MAX_UPLOAD_MB ?? (onVercel ? 4 : 25)),
  sessionHours: Number(env.SESSION_HOURS ?? 12),
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : onVercel,
  pythonBin: env.PYTHON_BIN ?? path.join(root, 'worker', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python'),
  workerScript: path.join(root, 'worker', 'extract.py'),
  /** Document worker as a web service (Vercel injects this through the service binding). Empty = run Python locally. */
  workerUrl: env.WORKER_URL ?? '',
  /** Scanner access: wia (Windows, this computer's scanner) or mock (tests). Not available on a hosted server. */
  scannerDriver: env.SCANNER_DRIVER ?? 'wia',
  /** Duty slip reading: claude (AI vision) or mock (tests). */
  slipReader: env.SLIP_READER ?? 'claude',
  anthropicApiKey: env.ANTHROPIC_API_KEY ?? '',
  anthropicModel: env.ANTHROPIC_MODEL ?? 'claude-opus-5-5',
  webDist: path.join(root, 'web', 'dist'),
  isTest: env.NODE_ENV === 'test' || env.VITEST === 'true',
};
