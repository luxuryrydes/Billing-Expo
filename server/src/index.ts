import Fastify, { type FastifyInstance } from 'fastify';
import type { Db } from './db/index.js';

/**
 * Everything the server needs is loaded inside this try, not at the top of the file. On a host such as
 * Vercel a module that fails to load (a missing package, a bad setting) would otherwise end the function
 * with a bare "500 FUNCTION_INVOCATION_FAILED"; here the reason is kept and shown to whoever opens the app.
 */
let db: Db | null = null;
let app: FastifyInstance;
let port = Number(process.env.PORT ?? 4000);
let host = process.env.VERCEL ? '0.0.0.0' : '127.0.0.1';
try {
  const { config } = await import('./config.js');
  port = config.port;
  host = config.host;
  if (config.onVercel && !/^postgres(ql)?:\/\//.test(config.databaseUrl)) {
    // The embedded database needs a lasting disk, which Vercel Functions do not have.
    throw new Error('DATABASE_URL is not set to a PostgreSQL connection string (Neon, Supabase…). Add it in the Vercel project settings → Environment Variables, then redeploy.');
  }
  const [{ buildApp }, { createDb }, { migrate }, { seedReferenceData }] = await Promise.all([import('./app.js'), import('./db/index.js'), import('./db/migrate.js'), import('./db/seed.js')]);
  db = await createDb();
  await migrate(db, (m) => console.log(m));
  await seedReferenceData(db);
  app = await buildApp(db, { logger: true });
} catch (e) {
  // Answer every request with the reason (connection strings hidden) so the problem is visible in the app.
  const reason = ((e as Error).message ?? String(e)).replace(/postgres(ql)?:\/\/\S+/gi, '[DATABASE_URL]');
  console.error('Billing server could not start:', e);
  app = Fastify({ logger: true });
  app.all('/*', async (_req, reply) => reply.status(503).send({ error: `The billing server could not start: ${reason}`, startup: true }));
}
await app.listen({ port, host });

const shutdown = async () => {
  await app.close();
  await db?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
