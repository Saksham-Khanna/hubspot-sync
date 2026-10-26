import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHubSpot } from './fakeHubSpot';

/**
 * Proves back-pressure works: a tiny per-portal budget and HubSpot 429s only DELAY work. Nothing is
 * dropped, nothing is marked failed, and no retry attempts are burned.
 */
const hs = new FakeHubSpot();
let pool: (typeof import('../../src/db'))['pool'];
let redis: (typeof import('../../src/redis'))['redis'];
let workers: { close(): Promise<void> };
let closeQueues: () => Promise<void>;
let startSync: (typeof import('../../src/services/sync'))['startSync'];
let metrics: (typeof import('../../src/lib/metrics'))['registry'];
let accountId = '';

beforeAll(async () => {
  hs.seed(350); // 4 pages
  await hs.start();
  process.env.HUBSPOT_API_BASE = hs.url;
  process.env.HUBSPOT_RATE_LIMIT_MAX = '2'; // 2 HubSpot calls per window ...
  process.env.HUBSPOT_RATE_LIMIT_WINDOW_MS = '1000'; // ... per second
  const [db, r, w, mig, q, s, m, tokens] = await Promise.all([
    import('../../src/db'), import('../../src/redis'), import('../../src/workers'), import('../../src/migrate'),
    import('../../src/queues'), import('../../src/services/sync'), import('../../src/lib/metrics'), import('../../src/services/tokens'),
  ]);
  pool = db.pool; redis = r.redis; closeQueues = q.closeQueues; startSync = s.startSync; metrics = m.registry;
  await mig.migrate();
  await pool.query('TRUNCATE accounts CASCADE');
  await redis.flushdb();
  const acct = await pool.query("INSERT INTO accounts (hub_id, status) VALUES (777, 'connected') RETURNING id");
  accountId = acct.rows[0].id;
  await tokens.saveTokens(accountId, { access_token: 'at-seed', refresh_token: 'rt-1', expires_in: 1800 });
  workers = w.startWorkers();
});

afterAll(async () => {
  await workers.close();
  await closeQueues();
  await pool.end();
  redis.disconnect();
  await hs.stop();
});

const done = async () => {
  for (let i = 0; i < 300; i++) {
    const r = await pool.query("SELECT * FROM sync_jobs WHERE account_id=$1 AND status IN ('completed','failed')", [accountId]);
    if (r.rows[0]) return r.rows[0];
    await new Promise((x) => setTimeout(x, 100));
  }
  throw new Error('sync did not finish');
};

describe('rate limiting and 429 handling', () => {
  it('completes a sync under a tiny budget plus HubSpot 429s, without failing or losing contacts', async () => {
    hs.rateLimitContactListTimes = 2;
    await startSync(accountId, 'full');
    const job = await done();
    expect(job.status).toBe('completed');
    expect(job.contacts_synced).toBe(350);
    expect((await pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(350);

    // 2 x 429 were honoured via Retry-After and the limiter spaced the remaining calls out.
    expect(hs.contactListCalls).toBeGreaterThanOrEqual(6); // 4 pages + 2 rate-limited calls
    const delays = (await metrics.getSingleMetricAsString('rate_limit_delays_total')).split('\n').filter((l) => l.startsWith('rate_limit_delays_total{'));
    const count = (src: string) => Number(delays.find((l) => l.includes(`source="${src}"`))?.split(' ').pop() ?? 0);
    expect(count('hubspot_429')).toBe(2);
    expect(count('limiter')).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
