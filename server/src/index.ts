import { buildApp } from './app.js';
import { config } from './config.js';
import { createDb } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedReferenceData } from './db/seed.js';

if (config.onVercel && !/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
  // The embedded database needs a lasting disk, which Vercel Functions do not have.
  throw new Error('DATABASE_URL must be a PostgreSQL connection string (Neon, Supabase…) — set it in the Vercel project settings.');
}
const db = await createDb();
await migrate(db, (m) => console.log(m));
await seedReferenceData(db);
const app = await buildApp(db, { logger: true });
await app.listen({ port: config.port, host: config.host });

const shutdown = async () => {
  await app.close();
  await db.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
