import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import {
  createSession, destroySession, hashPassword, perm, requireUser, ROLE_PERMISSIONS, SESSION_COOKIE,
  validatePasswordStrength, verifyPassword, type Role,
} from '../lib/auth.js';
import { config } from '../config.js';
import { HttpError, notFound, parse } from '../lib/http.js';

const RoleEnum = z.enum(['admin', 'operator', 'reviewer', 'approver', 'readonly']);

// Simple in-memory login throttle per email+ip.
const attempts = new Map<string, { n: number; until: number }>();

export async function authRoutes(app: FastifyInstance) {
  const db = app.db;

  const cookieOpts = { path: '/', httpOnly: true, sameSite: 'strict' as const, secure: config.cookieSecure, maxAge: config.sessionHours * 3600 };

  app.get('/auth/status', async (req) => {
    const count = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM app_users');
    return {
      needsSetup: (count?.n ?? 0) === 0,
      user: req.user ?? null,
      permissions: req.user ? ROLE_PERMISSIONS[req.user.role] : [],
    };
  });

  // First-run: create the initial administrator. Only allowed while no users exist.
  app.post('/auth/setup', async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), name: z.string().min(1), password: z.string() }), req.body);
    validatePasswordStrength(body.password);
    const user = await db.tx(async (t) => {
      const count = await t.one<{ n: number }>('SELECT count(*)::int AS n FROM app_users');
      if ((count?.n ?? 0) > 0) throw new HttpError(409, 'Setup has already been completed');
      return t.one<{ id: string }>(
        `INSERT INTO app_users(email, name, role, password_hash) VALUES (lower($1), $2, 'admin', $3) RETURNING id, email, name, role`,
        [body.email, body.name, hashPassword(body.password)],
      );
    });
    await audit(db, user!.id, 'user', user!.id, 'setup_admin');
    const token = await createSession(db, user!.id);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { user, token };
  });

  app.post('/auth/login', async (req, reply) => {
    const body = parse(z.object({ email: z.string().email(), password: z.string() }), req.body);
    const key = `${body.email.toLowerCase()}|${req.ip}`;
    const a = attempts.get(key);
    if (a && a.until > Date.now()) throw new HttpError(429, 'Too many failed attempts. Try again in a few minutes.');
    const u = await db.one<{ id: string; email: string; name: string; role: Role; password_hash: string; active: boolean }>(
      'SELECT * FROM app_users WHERE email = lower($1)',
      [body.email],
    );
    if (!u || !u.active || !verifyPassword(body.password, u.password_hash)) {
      const n = (a?.n ?? 0) + 1;
      attempts.set(key, { n, until: n >= 5 ? Date.now() + 5 * 60_000 : 0 });
      throw new HttpError(401, 'Incorrect email or password');
    }
    attempts.delete(key);
    const token = await createSession(db, u.id);
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    await audit(db, u.id, 'user', u.id, 'login');
    return { user: { id: u.id, email: u.email, name: u.name, role: u.role }, token };
  });

  app.post('/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) await destroySession(db, token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.post('/auth/change-password', async (req) => {
    const user = requireUser(req);
    const body = parse(z.object({ currentPassword: z.string(), newPassword: z.string() }), req.body);
    const u = await db.one<{ password_hash: string }>('SELECT password_hash FROM app_users WHERE id = $1', [user.id]);
    if (!u || !verifyPassword(body.currentPassword, u.password_hash)) throw new HttpError(400, 'Current password is incorrect');
    validatePasswordStrength(body.newPassword);
    await db.query('UPDATE app_users SET password_hash = $1, updated_at = now() WHERE id = $2', [hashPassword(body.newPassword), user.id]);
    await audit(db, user.id, 'user', user.id, 'change_password');
    return { ok: true };
  });

  // User management -------------------------------------------------------
  app.get('/users', { preHandler: perm('user.admin') }, async () =>
    db.query('SELECT id, email, name, role, active, created_at FROM app_users ORDER BY name'),
  );

  app.post('/users', { preHandler: perm('user.admin') }, async (req) => {
    const body = parse(z.object({ email: z.string().email(), name: z.string().min(1), role: RoleEnum, password: z.string() }), req.body);
    validatePasswordStrength(body.password);
    const row = await db.one<{ id: string }>(
      'INSERT INTO app_users(email, name, role, password_hash) VALUES (lower($1),$2,$3,$4) RETURNING id, email, name, role, active',
      [body.email, body.name, body.role, hashPassword(body.password)],
    );
    await audit(db, req.user!.id, 'user', row!.id, 'create', undefined, { email: body.email, role: body.role });
    return row;
  });

  app.patch('/users/:id', { preHandler: perm('user.admin') }, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ name: z.string().min(1).optional(), role: RoleEnum.optional(), active: z.boolean().optional(), password: z.string().optional() }), req.body);
    const before = await db.one<{ id: string; role: string; active: boolean; name: string }>('SELECT id, name, role, active FROM app_users WHERE id = $1', [id]);
    if (!before) throw notFound('User');
    if (id === req.user!.id && (body.role && body.role !== 'admin' || body.active === false)) throw new HttpError(400, 'You cannot remove your own administrator access');
    if (body.password) validatePasswordStrength(body.password);
    const after = await db.one(
      `UPDATE app_users SET name = COALESCE($2, name), role = COALESCE($3, role), active = COALESCE($4, active),
         password_hash = COALESCE($5, password_hash), updated_at = now() WHERE id = $1 RETURNING id, email, name, role, active`,
      [id, body.name ?? null, body.role ?? null, body.active ?? null, body.password ? hashPassword(body.password) : null],
    );
    if (body.active === false || body.password) await db.query('DELETE FROM sessions WHERE user_id = $1', [id]);
    await audit(db, req.user!.id, 'user', id, 'update', before, { ...after, passwordReset: !!body.password });
    return after;
  });
}
