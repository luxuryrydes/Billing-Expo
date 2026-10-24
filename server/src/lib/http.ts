import type { FastifyReply, FastifyRequest } from 'fastify';
import { z, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);
export const badRequest = (msg: string, details?: unknown) => new HttpError(400, msg, details);
export const conflict = (msg: string, details?: unknown) => new HttpError(409, msg, details);
export const forbidden = (msg = 'You do not have permission for this action') => new HttpError(403, msg);

export function parse<S extends ZodType>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) {
    const issues = r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
    throw new HttpError(400, `Invalid input: ${issues.map((i) => `${i.path || 'value'} — ${i.message}`).join('; ')}`, issues);
  }
  return r.data;
}

export function errorHandler(err: unknown, req: FastifyRequest, reply: FastifyReply) {
  if (err instanceof HttpError) return reply.status(err.status).send({ error: err.message, details: err.details });
  const e = err as { statusCode?: number; message?: string; code?: string };
  // PostgreSQL constraint violations → readable 409/400
  if (e.code === '23505') return reply.status(409).send({ error: 'A record with the same unique values already exists', details: e.message });
  if (e.code === '23503') return reply.status(400).send({ error: 'A referenced record does not exist or is still in use', details: e.message });
  if (e.code === '23514') return reply.status(400).send({ error: 'A value failed a database check', details: e.message });
  if (e.code === 'P0001') return reply.status(409).send({ error: e.message });
  if (e.statusCode && e.statusCode < 500) return reply.status(e.statusCode).send({ error: e.message });
  req.log.error(err);
  return reply.status(500).send({ error: 'Internal server error' });
}

export const uuid = z.string().uuid();
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const optText = z.string().trim().optional().nullable().transform((v) => (v ? v : null));
export const decimalStr = z
  .union([z.string(), z.number()])
  .transform((v) => String(v).trim())
  .refine((v) => /^-?\d+(\.\d+)?$/.test(v), 'Must be a number');
export const optDecimal = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => (v === null || v === undefined || String(v).trim() === '' ? null : String(v).trim()))
  .refine((v) => v === null || /^-?\d+(\.\d+)?$/.test(v), 'Must be a number');
