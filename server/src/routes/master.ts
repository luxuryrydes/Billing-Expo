import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { audit } from '../lib/audit.js';
import { perm } from '../lib/auth.js';
import { notFound, optText, parse, uuid } from '../lib/http.js';
import { regKey } from '../engine/validate.js';
import { DEFAULT_VALIDATION } from '../engine/validate.js';
import type { Db } from '../db/index.js';

export const SETTINGS_DEFAULTS: Record<string, unknown> = {
  validation: DEFAULT_VALIDATION,
  /** When true, the person who prepared a bill / rate cannot approve it. */
  makerChecker: false,
  billNoSequenceStart: 1,
};

export async function getSetting<T>(db: Db, key: string): Promise<T> {
  const r = await db.one<{ value: T }>('SELECT value FROM app_settings WHERE key = $1', [key]);
  return (r?.value ?? SETTINGS_DEFAULTS[key]) as T;
}

const SupplierSchema = z.object({
  name: z.string().trim().min(1),
  address: z.string().default(''),
  gstin: optText,
  pan: optText,
  state_name: optText,
  state_code: optText,
  phone: optText,
  email: optText,
  bank_details: optText,
  is_default: z.boolean().default(false),
});

export async function masterRoutes(app: FastifyInstance) {
  const db = app.db;

  // Settings ---------------------------------------------------------------
  app.get('/settings', { preHandler: perm('view') }, async () => {
    const rows = await db.query<{ key: string; value: unknown }>('SELECT key, value FROM app_settings');
    const out: Record<string, unknown> = { ...SETTINGS_DEFAULTS };
    for (const r of rows) out[r.key] = r.value;
    return out;
  });
  app.put('/settings/:key', { preHandler: perm('settings.write') }, async (req) => {
    const { key } = req.params as { key: string };
    if (!(key in SETTINGS_DEFAULTS)) throw notFound('Setting');
    const before = await getSetting(db, key);
    const value = (req.body as { value: unknown }).value;
    await db.query(
      `INSERT INTO app_settings(key, value) VALUES ($1, $2::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
    await audit(db, req.user!.id, 'setting', key, 'update', before, value);
    return { key, value };
  });

  // Supplier profiles --------------------------------------------------------
  app.get('/suppliers', { preHandler: perm('view') }, async () => db.query('SELECT * FROM supplier_profiles ORDER BY is_default DESC, name'));
  app.post('/suppliers', { preHandler: perm('settings.write') }, async (req) => {
    const b = parse(SupplierSchema, req.body);
    return db.tx(async (t) => {
      if (b.is_default) await t.query('UPDATE supplier_profiles SET is_default = false');
      const row = await t.one<{ id: string }>(
        `INSERT INTO supplier_profiles(name, address, gstin, pan, state_name, state_code, phone, email, bank_details, is_default)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [b.name, b.address, b.gstin, b.pan, b.state_name, b.state_code, b.phone, b.email, b.bank_details, b.is_default],
      );
      await audit(t, req.user!.id, 'supplier', row!.id, 'create', undefined, b);
      return row;
    });
  });
  app.put('/suppliers/:id', { preHandler: perm('settings.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(SupplierSchema, req.body);
    return db.tx(async (t) => {
      const before = await t.one('SELECT * FROM supplier_profiles WHERE id = $1', [id]);
      if (!before) throw notFound('Supplier profile');
      if (b.is_default) await t.query('UPDATE supplier_profiles SET is_default = false WHERE id <> $1', [id]);
      const row = await t.one(
        `UPDATE supplier_profiles SET name=$2, address=$3, gstin=$4, pan=$5, state_name=$6, state_code=$7, phone=$8, email=$9, bank_details=$10, is_default=$11, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [id, b.name, b.address, b.gstin, b.pan, b.state_name, b.state_code, b.phone, b.email, b.bank_details, b.is_default],
      );
      await audit(t, req.user!.id, 'supplier', id, 'update', before, row);
      return row;
    });
  });

  // Vehicle categories & duty types ------------------------------------------
  app.get('/vehicle-categories', { preHandler: perm('view') }, async () => db.query('SELECT * FROM vehicle_categories ORDER BY name'));
  app.post('/vehicle-categories', { preHandler: perm('settings.write') }, async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(1), description: optText }), req.body);
    const row = await db.one<{ id: string }>('INSERT INTO vehicle_categories(name, description) VALUES ($1,$2) RETURNING *', [b.name, b.description]);
    await audit(db, req.user!.id, 'vehicle_category', row!.id, 'create', undefined, b);
    return row;
  });
  app.put('/vehicle-categories/:id', { preHandler: perm('settings.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(z.object({ name: z.string().trim().min(1), description: optText }), req.body);
    const row = await db.one('UPDATE vehicle_categories SET name=$2, description=$3 WHERE id=$1 RETURNING *', [id, b.name, b.description]);
    if (!row) throw notFound('Vehicle category');
    await audit(db, req.user!.id, 'vehicle_category', id, 'update', undefined, b);
    return row;
  });

  app.get('/duty-types', { preHandler: perm('view') }, async () => db.query('SELECT * FROM duty_types ORDER BY code'));
  app.post('/duty-types', { preHandler: perm('settings.write') }, async (req) => {
    const b = parse(z.object({ code: z.string().trim().min(1).max(20).transform((s) => s.toUpperCase()), name: z.string().min(1), description: optText }), req.body);
    const row = await db.one(
      'INSERT INTO duty_types(code, name, description) VALUES ($1,$2,$3) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description RETURNING *',
      [b.code, b.name, b.description],
    );
    await audit(db, req.user!.id, 'duty_type', b.code, 'upsert', undefined, b);
    return row;
  });

  // Vehicles & drivers ---------------------------------------------------------
  app.get('/vehicles', { preHandler: perm('view') }, async (req) => {
    const q = (req.query as { q?: string }).q;
    return db.query(
      `SELECT v.*, c.name AS category_name, cl.name AS client_name FROM vehicles v
       LEFT JOIN vehicle_categories c ON c.id = v.category_id LEFT JOIN clients cl ON cl.id = v.client_id
       WHERE ($1::text IS NULL OR v.registration_no ILIKE '%' || $1 || '%') ORDER BY v.registration_no LIMIT 500`,
      [q || null],
    );
  });
  const VehicleSchema = z.object({
    registration_no: z.string().trim().min(1).max(20),
    category_id: uuid.nullable().optional(),
    vendor_name: optText,
    client_id: uuid.nullable().optional(),
    active: z.boolean().default(true),
  });
  app.post('/vehicles', { preHandler: perm('duty.write') }, async (req) => {
    const b = parse(VehicleSchema, req.body);
    const row = await db.one<{ id: string }>(
      `INSERT INTO vehicles(registration_no, reg_key, category_id, vendor_name, client_id, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.registration_no, regKey(b.registration_no), b.category_id ?? null, b.vendor_name, b.client_id ?? null, b.active],
    );
    await audit(db, req.user!.id, 'vehicle', row!.id, 'create', undefined, b);
    return row;
  });
  app.put('/vehicles/:id', { preHandler: perm('duty.write') }, async (req) => {
    const { id } = req.params as { id: string };
    const b = parse(VehicleSchema, req.body);
    const before = await db.one('SELECT * FROM vehicles WHERE id=$1', [id]);
    if (!before) throw notFound('Vehicle');
    const row = await db.one(
      `UPDATE vehicles SET registration_no=$2, reg_key=$3, category_id=$4, vendor_name=$5, client_id=$6, active=$7 WHERE id=$1 RETURNING *`,
      [id, b.registration_no, regKey(b.registration_no), b.category_id ?? null, b.vendor_name, b.client_id ?? null, b.active],
    );
    await audit(db, req.user!.id, 'vehicle', id, 'update', before, row);
    return row;
  });

  app.get('/drivers', { preHandler: perm('view') }, async () => db.query('SELECT * FROM drivers ORDER BY name LIMIT 1000'));
  app.post('/drivers', { preHandler: perm('duty.write') }, async (req) => {
    const b = parse(z.object({ name: z.string().trim().min(1), phone: optText, licence_no: optText }), req.body);
    const row = await db.one<{ id: string }>(
      'INSERT INTO drivers(name, name_key, phone, licence_no) VALUES ($1, upper(trim($1)), $2, $3) RETURNING *',
      [b.name, b.phone, b.licence_no],
    );
    await audit(db, req.user!.id, 'driver', row!.id, 'create', undefined, b);
    return row;
  });

  // Audit log ---------------------------------------------------------------
  app.get('/audit', { preHandler: perm('audit.view') }, async (req) => {
    const q = parse(
      z.object({ entityType: z.string().optional(), entityId: z.string().optional(), userId: z.string().optional(), limit: z.coerce.number().int().min(1).max(500).default(100), offset: z.coerce.number().int().min(0).default(0) }),
      req.query,
    );
    const rows = await db.query(
      `SELECT a.*, u.name AS user_name FROM audit_events a LEFT JOIN app_users u ON u.id = a.user_id
       WHERE ($1::text IS NULL OR a.entity_type = $1) AND ($2::text IS NULL OR a.entity_id = $2) AND ($3::uuid IS NULL OR a.user_id = $3)
       ORDER BY a.id DESC LIMIT $4 OFFSET $5`,
      [q.entityType ?? null, q.entityId ?? null, q.userId ?? null, q.limit, q.offset],
    );
    return rows;
  });
}
