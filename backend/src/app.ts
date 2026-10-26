import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import Fastify, { FastifyError } from 'fastify';
import { ZodError } from 'zod';
import { config } from './config';
import { pool } from './db';
import { HttpError } from './lib/errors';
import { logger } from './lib/logger';
import { registry } from './lib/metrics';
import { redis } from './redis';
import { authRoutes } from './routes/auth';
import { contactRoutes } from './routes/contacts';
import { syncRoutes } from './routes/sync';
import { webhookRoutes } from './routes/webhooks';

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 1_000_000 });

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(cors, { origin: config.FRONTEND_URL, credentials: true });
  await app.register(rateLimit, { max: 600, timeWindow: '1 minute', redis, skipOnError: true });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', message: err.issues.map((i) => i.message).join('; ') });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'error', message: status >= 500 ? 'Internal server error' : err.message });
  });

  // Liveness: process is up. Readiness: dependencies reachable.
  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/ready', async (_req, reply) => {
    try {
      await Promise.all([pool.query('SELECT 1'), redis.ping()]);
      return { ok: true };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });
  app.get('/metrics', async (_req, reply) => reply.header('Content-Type', registry.contentType).send(await registry.metrics()));

  await app.register(
    async (api) => {
      await api.register(authRoutes);
      await api.register(contactRoutes);
      await api.register(syncRoutes);
      await api.register(webhookRoutes);
    },
    { prefix: '/api' },
  );

  return app;
}
