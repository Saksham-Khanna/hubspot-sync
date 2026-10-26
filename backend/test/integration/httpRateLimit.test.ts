import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// A tiny HTTP budget proves both directions: normal routes are still limited, liveness is exempt.
process.env.HTTP_RATE_LIMIT_MAX = '2';

type App = Awaited<ReturnType<(typeof import('../../src/app'))['buildApp']>>;
type Client = (typeof import('../../src/redis'))['redis'];

let app: App;
let redis: Client;
let httpRedis: Client;
let closeQueues: () => Promise<void>;
let pool: (typeof import('../../src/db'))['pool'];

const get = (url: string) => app.inject({ method: 'GET', url });

beforeAll(async () => {
  const [{ buildApp }, db, clients, queues] = await Promise.all([
    import('../../src/app'),
    import('../../src/db'),
    import('../../src/redis'),
    import('../../src/queues'),
  ]);
  pool = db.pool;
  redis = clients.redis;
  httpRedis = clients.httpRedis;
  closeQueues = queues.closeQueues;
  // Keys are shared with other test files through the same Redis DB; start from a clean budget.
  await httpRedis.ping();
  const stale = await redis.keys('fastify-rate-limit-*');
  if (stale.length > 0) await redis.del(...stale);
  app = await buildApp();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await closeQueues?.();
  await pool?.end();
  redis?.disconnect();
  httpRedis?.disconnect();
});

describe('HTTP rate limiting', () => {
  it('still limits normal routes', async () => {
    expect((await get('/api/auth/status')).statusCode).toBe(200);
    expect((await get('/api/auth/status')).statusCode).toBe(200);
    const limited = await get('/api/auth/status');
    expect(limited.statusCode).toBe(429);
  });

  it('never limits /api/health, even after the route budget is exhausted', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await get('/api/health');
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });
    }
  });
});
