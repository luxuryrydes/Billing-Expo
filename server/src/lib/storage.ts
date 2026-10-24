import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { badRequest } from './http.js';

export interface StoredFile {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  sha256: string;
  storage_path: string;
}

export const ALLOWED_UPLOADS: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.xlsx': ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  '.xls': ['application/vnd.ms-excel'],
  '.csv': ['text/csv', 'application/vnd.ms-excel', 'text/plain'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.png': ['image/png'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.tif': ['image/tiff'],
  '.tiff': ['image/tiff'],
};

const MAGIC: Record<string, (b: Buffer) => boolean> = {
  '.pdf': (b) => b.subarray(0, 5).toString() === '%PDF-',
  '.xlsx': (b) => b[0] === 0x50 && b[1] === 0x4b,
  '.docx': (b) => b[0] === 0x50 && b[1] === 0x4b,
  '.png': (b) => b[0] === 0x89 && b.subarray(1, 4).toString() === 'PNG',
  '.jpg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.jpeg': (b) => b[0] === 0xff && b[1] === 0xd8,
  '.xls': (b) => b[0] === 0xd0 && b[1] === 0xcf,
};

/** Rejects macro-enabled or unexpected file types and checks file signatures. */
export function checkUpload(name: string, buf: Buffer, allowed = Object.keys(ALLOWED_UPLOADS)) {
  const ext = path.extname(name).toLowerCase();
  if (!allowed.includes(ext)) throw badRequest(`File type ${ext || '(none)'} is not accepted. Allowed: ${allowed.join(', ')}`);
  if (buf.length === 0) throw badRequest('File is empty');
  if (buf.length > config.maxUploadMb * 1024 * 1024) throw badRequest(`File exceeds ${config.maxUploadMb} MB`);
  const magic = MAGIC[ext];
  if (magic && !magic(buf)) throw badRequest(`File content does not match its ${ext} extension`);
  return ext;
}

export function mimeFor(ext: string): string {
  return ALLOWED_UPLOADS[ext]?.[0] ?? 'application/octet-stream';
}

export async function saveFile(db: Db, name: string, buf: Buffer, userId: string | null, mime?: string): Promise<StoredFile> {
  const ext = path.extname(name).toLowerCase();
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const rel = path.join(hash.slice(0, 2), `${hash}${ext}`);
  const abs = path.join(config.storageDir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  if (!fs.existsSync(abs)) fs.writeFileSync(abs, buf, { mode: 0o640 });
  const safeName = path.basename(name).replace(/[\u0000-\u001f<>:"/\\|?*]/g, '_').slice(0, 200);
  const row = await db.one<StoredFile>(
    `INSERT INTO files(original_name, mime_type, size_bytes, sha256, storage_path, created_by, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, original_name, mime_type, size_bytes, sha256, storage_path`,
    [safeName, mime ?? mimeFor(ext), buf.length, hash, rel.replace(/\\/g, '/'), userId, config.storeFilesInDb ? buf : null],
  );
  return row!;
}

/**
 * Makes sure the file is on this server's disk and returns its path. Where files live in the
 * database (Vercel), another instance may have received the upload, so it is copied down first.
 */
export async function localPath(db: Db, f: Pick<StoredFile, 'storage_path'>): Promise<string> {
  const abs = filePath(f);
  if (fs.existsSync(abs)) return abs;
  const r = await db.one<{ content: Buffer | Uint8Array | null }>('SELECT content FROM files WHERE storage_path = $1 AND content IS NOT NULL LIMIT 1', [f.storage_path]);
  if (!r?.content) throw new Error('The stored file is missing');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, Buffer.from(r.content), { mode: 0o640 });
  return abs;
}

export function filePath(f: Pick<StoredFile, 'storage_path'>): string {
  const abs = path.resolve(config.storageDir, f.storage_path);
  if (!abs.startsWith(path.resolve(config.storageDir))) throw new Error('Invalid storage path');
  return abs;
}

export async function loadFile(db: Db, id: string): Promise<{ meta: StoredFile; buf: Buffer } | null> {
  const meta = await db.one<StoredFile>('SELECT id, original_name, mime_type, size_bytes, sha256, storage_path FROM files WHERE id = $1', [id]);
  if (!meta) return null;
  return { meta, buf: fs.readFileSync(await localPath(db, meta)) };
}
