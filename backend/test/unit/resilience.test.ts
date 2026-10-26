import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Point every dependency at a closed port BEFORE importing the app: config/redis read process.env
// at import time. This reproduces the production incident where REDIS_URL was missing on Render, so
// the rate limiter queued commands against a non-existent localhost Redis and every route hung.
process.env.REDIS_URL = 'redis://127.0.0.1:6399';
process.env.DATABASE_URL = 'postgres://nobody:nobody@127.0.0.1:6398/absent';

type App = Awaited<ReturnType<(typeof import('../../src/app'))['buildApp']>>;
type Client = (typeof import('../../src/redis'))['redis'];

let app: App;
let redis: Client;
let httpRedis: Client;

beforeAll(async () => {
  const [{ buildApp }, clients] = await Promise.all([import('../../src/app'), import('../../src/redis')]);
  redis = clients.redis;
  httpRedis = clients.httpRedis;
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  redis?.disconnect();
  httpRedis?.disconnect();
});

describe('unreachable Postgres/Redis', () => {
  it('answers /api/health without waiting for Redis', async () => {
    const t0 = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('answers /api/auth/status as disconnected without waiting for Redis', async () => {
    const t0 = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/auth/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ connected: false });
    expect(Date.now() - t0).toBeLessThan(2_000);
  });

  it('reports /api/ready as 503 quickly instead of hanging', async () => {
    const t0 = Date.now();
    const res = await app.inject({ method: 'GET', url: '/api/ready' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ ok: false });
    expect(Date.now() - t0).toBeLessThan(4_000);
  });
});
