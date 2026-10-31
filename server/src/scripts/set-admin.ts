/**
 * Creates an administrator, or resets the password of an existing user and makes them an active administrator.
 * Stop the app first (the embedded database allows one process), then:
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD=... npm run set-admin
 * The password is read from the environment and is never written to a file.
 */
import { createDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { hashPassword } from '../lib/auth.js';

const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
const password = process.env.ADMIN_PASSWORD;
const name = process.env.ADMIN_NAME?.trim() || 'Administrator';
if (!email || !password) { console.error('Set ADMIN_EMAIL and ADMIN_PASSWORD first.'); process.exit(1); }
if (password.length < 10) { console.error('Use a password of at least 10 characters.'); process.exit(1); }

const db = await createDb();
await migrate(db);
const hash = hashPassword(password);
const existing = await db.one<{ id: string }>('SELECT id FROM app_users WHERE email = $1', [email]);
if (existing) {
  await db.query(`UPDATE app_users SET password_hash = $1, role = 'admin', active = true, updated_at = now() WHERE id = $2`, [hash, existing.id]);
  console.log(`Updated ${email}: administrator, active, password reset.`);
} else {
  await db.query(`INSERT INTO app_users(email, name, role, password_hash) VALUES ($1, $2, 'admin', $3)`, [email, name, hash]);
  console.log(`Created administrator ${email}.`);
}
await db.close();
