import Fastify from 'fastify';
import { buildApp } from './app.js';
import { config } from './config.js';
import { createDb, type Db } from './db/index.js';
import { migrate } from './db/migrate.js';
import { seedReferenceData } from './db/seed.js';

async function start() {
  if (config.onVercel && !/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    // The embedded database needs a lasting disk, which Vercel Functions do not have.
    throw new Error('DATABASE_URL is not set to a PostgreSQL connection string (Neon, Supabase…). Add it in the Vercel project settings → Environment Variables, then redeploy.');
  }
  const db = await createDb();
  await migrate(db, (m) => console.log(m));
  await seedReferenceData(db);
  return { db, app: await buildApp(db, { logger: true }) };
}

let db: Db | null = null;
let app;
try {
  ({ db, app } = await start());
} catch (e) {
  // A hosted server that cannot start would otherwise only show a bare 500. Answer every request
  // with the reason instead, so the setup problem is visible in the app. Connection strings are hidden.
  const reason = ((e as Error).message ?? String(e)).replace(/postgres(ql)?:\/\/\S+/gi, '[DATABASE_URL]');
  console.error('Billing server could not start:', e);
  app = Fastify({ logger: true });
  app.all('/*', async (_req, reply) => reply.status(503).send({ error: `The billing server could not start: ${reason}`, startup: true }));
}
await app.listen({ port: config.port, host: config.host });

const shutdown = async () => {
  await app.close();
  await db?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
