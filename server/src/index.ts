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
  const message = (e as Error).message ?? String(e);
  console.error('Billing server could not start:', e);
  if (!process.env.VERCEL) {
    // On your own computer there is nothing to answer requests with: say what is wrong and stop.
    const dbBusy = /Aborted\(\)|could not open file/i.test(message) && !/^postgres/i.test(process.env.DATABASE_URL ?? '');
    console.error(dbBusy
      ? '\nThe embedded database could not be opened. Most likely another copy of the server (npm run dev, npm start or start-windows.bat) is still running and is using the same data folder. Close it, then start this again. If no other copy is running, the data/pglite folder may be damaged: stop everything, copy it somewhere safe, and ask for help restoring it.'
      : `\nThe billing server could not start: ${message}`);
    process.exit(1);
  }
  // On a host (Vercel): answer every request with the reason (connection strings hidden) so it is visible in the app.
  const reason = message.replace(/postgres(ql)?:\/\/\S+/gi, '[DATABASE_URL]');
  app = Fastify({ logger: true });
  app.all('/*', async (_req, reply) => reply.status(503).send({ error: `The billing server could not start: ${reason}`, startup: true }));
}
try {
  await app.listen({ port, host });
} catch (e) {
  if ((e as { code?: string }).code === 'EADDRINUSE') {
    console.error(`\nPort ${port} is already in use — the app is probably already running at http://localhost:${port}. Close the other copy (npm start, start-windows.bat or another npm run dev) or set a different PORT in .env, then start again.`);
    process.exit(1);
  }
  throw e;
}

const shutdown = async () => {
  await app.close();
  await db?.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
