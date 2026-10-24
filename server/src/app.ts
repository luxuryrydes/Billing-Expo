import fs from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import type { Db } from './db/index.js';
import { config } from './config.js';
import { errorHandler } from './lib/http.js';
import { resolveSession, SESSION_COOKIE } from './lib/auth.js';
import { authRoutes } from './routes/auth.js';
import { masterRoutes } from './routes/master.js';
import { clientRoutes } from './routes/clients.js';
import { documentRoutes } from './routes/documents.js';
import { rateRoutes } from './routes/rates.js';
import { dutyRoutes } from './routes/duties.js';
import { templateRoutes } from './routes/templates.js';
import { billRoutes } from './routes/bills.js';
import { reportRoutes } from './routes/reports.js';
import { onboardingRoutes } from './routes/onboarding.js';
import { importRoutes } from './routes/imports.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
  }
}

export async function buildApp(db: Db, opts: { logger?: boolean } = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ? { level: 'info', redact: ['req.headers.cookie', 'req.headers.authorization'] } : false,
    bodyLimit: 5 * 1024 * 1024,
  });
  app.decorate('db', db);
  app.setErrorHandler(errorHandler);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: config.maxUploadMb * 1024 * 1024, files: 1 } });

  app.addHook('onRequest', async (req) => {
    if (!req.url.startsWith('/api/')) return;
    const token = req.cookies[SESSION_COOKIE] ?? (req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : undefined);
    const user = await resolveSession(db, token);
    if (user) req.user = user;
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'SAMEORIGIN');
    reply.header('Referrer-Policy', 'same-origin');
  });

  await app.register(
    async (api) => {
      api.get('/health', async () => ({ ok: true }));
      await authRoutes(api);
      await masterRoutes(api);
      await clientRoutes(api);
      await documentRoutes(api);
      await rateRoutes(api);
      await dutyRoutes(api);
      await templateRoutes(api);
      await billRoutes(api);
      await reportRoutes(api);
      await onboardingRoutes(api);
      await importRoutes(api);
    },
    { prefix: '/api' },
  );

  // Serve the built frontend in production.
  if (fs.existsSync(config.webDist)) {
    await app.register(fastifyStatic, { root: config.webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.status(404).send({ error: 'Not found' });
      return reply.sendFile('index.html');
    });
  }
  return app;
}
