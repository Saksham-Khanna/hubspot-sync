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
import { httpRedis } from './redis';
import { authRoutes } from './routes/auth';
import { contactRoutes } from './routes/contacts';
import { syncRoutes } from './routes/sync';
import { webhookRoutes } from './routes/webhooks';

/** Rejects if `p` does not settle within `ms`, so readiness probes answer instead of hanging. */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} check timed out after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

const READY_TIMEOUT_MS = 3_000;
// These two must never depend on Redis, otherwise an outage makes the platform health check hang/fail.
const LIVENESS_PATHS = new Set(['/api/health', '/api/ready']);
const isLivenessPath = (url: string) => LIVENESS_PATHS.has(url.split('?')[0]);

interface DependencyCheck {
  ok: boolean;
  error?: string;
}

async function checkDependency(name: string, probe: () => Promise<unknown>): Promise<DependencyCheck> {
  try {
    await withTimeout(probe(), READY_TIMEOUT_MS, name);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message.slice(0, 200) };
  }
}

/** ioredis surfaces a lost/failed connection with these shapes (no offline queue => immediate reject). */
function isRedisUnavailableError(err: unknown): boolean {
  const e = err as { name?: string; code?: string; message?: string } | null;
  return (
    e?.name === 'MaxRetriesPerRequestError' ||
    e?.code === 'NR_CLOSED' ||
    /(stream isn't writeable|connection is closed|enableOfflineQueue|max retries per request)/i.test(e?.message ?? '')
  );
}

export async function buildApp() {
  const app = Fastify({ loggerInstance: logger, trustProxy: true, bodyLimit: 1_000_000 });

  // The OAuth state cookie is host-only (no Domain attribute). Start and callback must therefore be
  // served from the same origin; otherwise the callback arrives without the cookie -> invalid_state.
  const frontendOrigin = new URL(config.FRONTEND_URL).origin;
  const oauthRedirectOrigin = new URL(config.HUBSPOT_REDIRECT_URI).origin;
  if (frontendOrigin !== oauthRedirectOrigin) {
    logger.warn(
      { frontendOrigin, oauthRedirectOrigin },
      'HUBSPOT_REDIRECT_URI origin differs from FRONTEND_URL: the OAuth state cookie will not reach the callback (invalid_state)',
    );
  }

  await app.register(cookie, { secret: config.COOKIE_SECRET });
  await app.register(cors, { origin: config.FRONTEND_URL, credentials: true });

  // Rate limiting is fail-closed: while the Redis client used by the limiter is not ready, every
  // non-liveness route gets a fast 503 instead of waiting for a connection that may never exist.
  // We do not fall back to an in-memory limiter (it would not be shared across instances).
  let limiterState = '';
  app.addHook('onRequest', async (req, reply) => {
    if (isLivenessPath(req.url)) return;
    const state = httpRedis.status;
    if (state !== 'ready') {
      if (state !== limiterState) {
        limiterState = state;
        req.log.warn({ redis: state }, 'rate limiter unavailable; failing closed with 503');
      }
      reply.header('retry-after', '5');
      return reply.code(503).send({
        error: 'rate_limiter_unavailable',
        message: 'Rate limiting backend is unavailable; retry shortly',
      });
    }
    limiterState = 'ready';
  });

  await app.register(rateLimit, {
    max: config.HTTP_RATE_LIMIT_MAX,
    timeWindow: '1 minute',
    redis: httpRedis,
    allowList: (req) => isLivenessPath(req.url),
    // Fail closed if Redis fails between the readiness check above and the limiter command
    // (handled as a 503 below); never silently bypass limiting.
    skipOnError: false,
  });

  app.setErrorHandler((err: FastifyError | HttpError | ZodError, req, reply) => {
    if (err instanceof ZodError) {
      return reply.code(400).send({ error: 'validation_error', message: err.issues.map((i) => i.message).join('; ') });
    }
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    }
    if (isRedisUnavailableError(err)) {
      req.log.warn({ err: (err as Error).message }, 'rate limiter unavailable; failing closed');
      reply.header('retry-after', '5');
      return reply.code(503).send({
        error: 'rate_limiter_unavailable',
        message: 'Rate limiting backend is unavailable; retry shortly',
      });
    }
    const status = (err as FastifyError).statusCode ?? 500;
    if (status >= 500) req.log.error({ err }, 'unhandled error');
    return reply.code(status).send({ error: status >= 500 ? 'internal_error' : 'error', message: status >= 500 ? 'Internal server error' : err.message });
  });

  // Liveness: the process is up. No Postgres, Redis, HubSpot or worker dependency.
  app.get('/api/health', { config: { rateLimit: false } }, async (_req, reply) =>
    reply.header('cache-control', 'no-store').send({ ok: true }),
  );

  // Readiness: every dependency is probed with a bounded timeout and reported individually.
  app.get('/api/ready', { config: { rateLimit: false } }, async (_req, reply) => {
    const [database, redis] = await Promise.all([
      checkDependency('postgres', () => pool.query('SELECT 1')),
      checkDependency('redis', () => httpRedis.ping()),
    ]);
    const ok = database.ok && redis.ok;
    if (!ok) reply.header('retry-after', '5');
    return reply.code(ok ? 200 : 503).send({ ok, dependencies: { database, redis } });
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

  app.addHook('onClose', async () => {
    httpRedis.disconnect();
  });

  return app;
}
