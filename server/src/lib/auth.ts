import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { Db } from '../db/index.js';
import { config } from '../config.js';
import { HttpError, forbidden } from './http.js';

export type Role = 'admin' | 'operator' | 'reviewer' | 'approver' | 'readonly';

export const PERMISSIONS = [
  'view', 'export', 'audit.view',
  'client.write', 'document.upload', 'extraction.review',
  'rate.write', 'rate.approve', 'tax.write', 'tax.approve',
  'template.write', 'template.approve',
  'duty.write', 'duty.verify', 'duty.correct',
  'bill.prepare', 'bill.review', 'bill.approve', 'bill.submit',
  'user.admin', 'settings.write',
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLE_PERMISSIONS: Record<Role, Permission[]> = {
  admin: [...PERMISSIONS],
  operator: ['view', 'export', 'document.upload', 'duty.write', 'bill.prepare'],
  reviewer: ['view', 'export', 'audit.view', 'extraction.review', 'duty.verify', 'duty.correct', 'bill.prepare', 'bill.review'],
  approver: ['view', 'export', 'audit.view', 'extraction.review', 'rate.approve', 'tax.approve', 'template.approve', 'bill.approve', 'bill.submit'],
  readonly: ['view'],
};

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthUser;
  }
}

export function hashPassword(pw: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(pw, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export function verifyPassword(pw: string, stored: string): boolean {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const key = Buffer.from(keyB64, 'base64');
  const test = crypto.scryptSync(pw, Buffer.from(saltB64, 'base64'), key.length, { N: 16384, r: 8, p: 1 });
  return crypto.timingSafeEqual(key, test);
}

export function validatePasswordStrength(pw: string) {
  if (pw.length < 10) throw new HttpError(400, 'Password must be at least 10 characters');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new HttpError(400, 'Password must contain letters and digits');
}

const sha = (s: string) => crypto.createHash('sha256').update(s).digest('hex');

export const SESSION_COOKIE = 'lr_session';

export async function createSession(db: Db, userId: string): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  const expires = new Date(Date.now() + config.sessionHours * 3600_000).toISOString();
  await db.query('INSERT INTO sessions(token_hash, user_id, expires_at) VALUES ($1,$2,$3)', [sha(token), userId, expires]);
  await db.query('DELETE FROM sessions WHERE expires_at < now()');
  return token;
}

export async function destroySession(db: Db, token: string) {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha(token)]);
}

export async function resolveSession(db: Db, token: string | undefined): Promise<AuthUser | null> {
  if (!token) return null;
  return db.one<AuthUser>(
    `SELECT u.id, u.email, u.name, u.role FROM sessions s JOIN app_users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > now() AND u.active`,
    [sha(token)],
  );
}

export function can(user: AuthUser | undefined, p: Permission): boolean {
  return !!user && ROLE_PERMISSIONS[user.role].includes(p);
}

export function requireUser(req: FastifyRequest): AuthUser {
  if (!req.user) throw new HttpError(401, 'Please sign in');
  return req.user;
}

export function requirePerm(req: FastifyRequest, p: Permission): AuthUser {
  const u = requireUser(req);
  if (!can(u, p)) throw forbidden(`Your role (${u.role}) cannot perform "${p}"`);
  return u;
}

/** Fastify preHandler factory. */
export const perm = (p: Permission) => async (req: FastifyRequest, _reply: FastifyReply) => {
  requirePerm(req, p);
};
