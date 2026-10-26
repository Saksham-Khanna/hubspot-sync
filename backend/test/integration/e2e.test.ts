import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FakeHubSpot } from './fakeHubSpot';

/**
 * End-to-end: real Fastify app + real BullMQ workers + real Postgres/Redis, against a fake HubSpot.
 * Requires TEST_DATABASE_URL / TEST_REDIS_URL (defaults in test/setup.ts).
 */
const hs = new FakeHubSpot();
type Mods = {
  app: Awaited<ReturnType<(typeof import('../../src/app'))['buildApp']>>;
  pool: (typeof import('../../src/db'))['pool'];
  redis: (typeof import('../../src/redis'))['redis'];
  workers: { close(): Promise<void> };
  sweep: (typeof import('../../src/services/maintenance'))['sweep'];
  getAccessToken: (typeof import('../../src/services/tokens'))['getAccessToken'];
  withToken: (typeof import('../../src/services/tokens'))['withToken'];
  startSync: (typeof import('../../src/services/sync'))['startSync'];
  closeQueues: () => Promise<void>;
};
let m: Mods;
let cookie = '';
let accountId = '';

async function waitFor<T>(fn: () => Promise<T | false | undefined | null>, timeoutMs = 15_000, label = 'condition'): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}
const api = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
  m.app.inject({ method, url, payload: payload as object | undefined, headers: { cookie } });

beforeAll(async () => {
  hs.seed(250);
  await hs.start();
  process.env.HUBSPOT_API_BASE = hs.url;
  const [{ buildApp }, db, { redis, httpRedis }, { startWorkers }, { migrate }, { sweep }, tokens, sync, queues] = await Promise.all([
    import('../../src/app'),
    import('../../src/db'),
    import('../../src/redis'),
    import('../../src/workers'),
    import('../../src/migrate'),
    import('../../src/services/maintenance'),
    import('../../src/services/tokens'),
    import('../../src/services/sync'),
    import('../../src/queues'),
  ]);
  await migrate();
  await db.pool.query('TRUNCATE accounts CASCADE');
  await redis.flushdb();
  // The rate limiter uses its own fail-fast connection; wait until it is ready so tests do not race boot.
  await httpRedis.ping();
  const app = await buildApp();
  await app.ready();
  m = {
    app, pool: db.pool, redis, workers: startWorkers(), sweep,
    getAccessToken: tokens.getAccessToken, withToken: tokens.withToken, startSync: sync.startSync, closeQueues: queues.closeQueues,
  };
});

afterAll(async () => {
  await m.workers.close();
  await m.app.close();
  await m.closeQueues();
  await m.pool.end();
  m.redis.disconnect();
  await hs.stop();
});

describe('OAuth', () => {
  it('redirects to HubSpot with client_id, scopes and a state cookie', async () => {
    const res = await m.app.inject({ method: 'GET', url: '/api/auth/hubspot/start' });
    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location as string);
    expect(loc.searchParams.get('client_id')).toBe('test-client-id');
    expect(loc.searchParams.get('scope')).toContain('crm.objects.contacts.read');
    expect(loc.searchParams.get('redirect_uri')).toBe(process.env.HUBSPOT_REDIRECT_URI);
    expect(res.cookies.find((c) => c.name === 'oauth_state')).toBeTruthy();
  });

  it('rejects a callback that arrives without the state cookie (cross-host callback)', async () => {
    const res = await m.app.inject({ method: 'GET', url: '/api/auth/hubspot/callback?code=good-code&state=whatever' });
    expect(res.headers.location).toContain('auth_error=invalid_state');
  });

  it('rejects a callback whose state does not match (CSRF)', async () => {
    const start = await m.app.inject({ method: 'GET', url: '/api/auth/hubspot/start' });
    const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')!;
    const res = await m.app.inject({
      method: 'GET',
      url: '/api/auth/hubspot/callback?code=good-code&state=forged',
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    });
    expect(res.headers.location).toContain('auth_error=invalid_state');
    expect((await m.pool.query('SELECT count(*)::int n FROM accounts')).rows[0].n).toBe(0);
  });

  it('completes the flow, stores ENCRYPTED tokens, sets a session', async () => {
    const start = await m.app.inject({ method: 'GET', url: '/api/auth/hubspot/start' });
    const stateCookie = start.cookies.find((c) => c.name === 'oauth_state')!;
    const state = new URL(start.headers.location as string).searchParams.get('state')!;
    const res = await m.app.inject({
      method: 'GET',
      url: `/api/auth/hubspot/callback?code=good-code&state=${state}`,
      headers: { cookie: `oauth_state=${stateCookie.value}` },
    });
    expect(res.headers.location).toContain('connected=1');
    const sid = res.cookies.find((c) => c.name === 'sid')!;
    cookie = `sid=${sid.value}`;

    const acct = (await m.pool.query('SELECT * FROM accounts')).rows[0];
    accountId = acct.id;
    expect(acct.hub_id).toBe(12345);
    expect(acct.access_token_enc).not.toContain('at-1');
    expect(acct.access_token_enc.startsWith('v1.')).toBe(true);

    const status = (await api('GET', '/api/auth/status')).json();
    expect(status).toMatchObject({ connected: true, hubId: 12345 });
  });

  it('requires a session for data endpoints', async () => {
    const res = await m.app.inject({ method: 'GET', url: '/api/contacts' });
    expect(res.statusCode).toBe(401);
  });
});

describe('automatic contact sync', () => {
  it('starts on connect (no button) and loads every contact exactly once', async () => {
    // The OAuth callback already enqueued the sync; we only wait for it.
    const done = await waitFor(async () => {
      const r = await m.pool.query("SELECT * FROM sync_jobs WHERE status='completed' ORDER BY created_at LIMIT 1");
      return r.rows[0];
    }, 20_000, 'initial sync');
    expect(done.type).toBe('full');
    expect(done.pages).toBe(3); // 250 contacts / 100 per page
    expect(done.contacts_synced).toBe(250);
    const n = (await m.pool.query('SELECT count(*)::int n, count(DISTINCT hubspot_id)::int d FROM contacts')).rows[0];
    expect(n).toEqual({ n: 250, d: 250 });
  });

  it('is idempotent: re-running a full sync creates no duplicates', async () => {
    await m.startSync(accountId, 'full');
    await waitFor(async () => (await m.pool.query("SELECT 1 FROM sync_jobs WHERE status='completed' AND id <> (SELECT id FROM sync_jobs ORDER BY created_at LIMIT 1)")).rows[0], 20_000, 'second sync');
    const n = (await m.pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n;
    expect(n).toBe(250);
  });

  it('retries a transient HubSpot failure with backoff and still completes', async () => {
    await m.pool.query('DELETE FROM contacts');
    hs.failContactListOnce = 1;
    await m.startSync(accountId, 'full');
    await waitFor(async () => (await m.pool.query('SELECT 1 FROM contacts HAVING count(*) = 250')).rows[0], 25_000, 'sync after retry');
    expect(hs.failContactListOnce).toBe(0);
  });

  it('resumes an interrupted sync from its checkpoint via the sweeper', async () => {
    await m.pool.query('DELETE FROM contacts');
    // Simulate a worker that died after committing page 1 (cursor=100) and never enqueued page 2.
    const inserted = await m.pool.query(
      `INSERT INTO sync_jobs (account_id, type, status, cursor, pages, contacts_synced, updated_at)
       VALUES ($1, 'full', 'running', '100', 1, 100, now() - interval '10 minutes') RETURNING id`,
      [accountId],
    );
    const swept = await m.sweep();
    expect(swept.stalledSyncs).toBe(1);
    const job = await waitFor(async () => (await m.pool.query("SELECT * FROM sync_jobs WHERE id=$1 AND status='completed'", [inserted.rows[0].id])).rows[0], 20_000, 'resumed sync');
    expect(job.pages).toBe(3);
    expect(job.contacts_synced).toBe(250); // 100 before the "crash" + 150 after resume
    // It only fetched pages 2-3 (150 rows), proving it restarted from the cursor, not from scratch.
    expect((await m.pool.query('SELECT count(*)::int n FROM contacts')).rows[0].n).toBe(150);
  });

  it('serves contacts with pagination and search', async () => {
    await m.pool.query('DELETE FROM contacts');
    await m.startSync(accountId, 'full');
    await waitFor(async () => (await m.pool.query('SELECT 1 FROM contacts HAVING count(*) = 250')).rows[0], 20_000, 'reload');
    const page = (await api('GET', '/api/contacts?page=2&pageSize=100')).json();
    expect(page.total).toBe(250);
    expect(page.data).toHaveLength(100);
    const hit = (await api('GET', '/api/contacts?search=c7%40example')).json();
    expect(hit.data.map((c: { email: string }) => c.email)).toContain('c7@example.com');
    const pct = (await api('GET', '/api/contacts?search=%25')).json(); // literal % must not match everything
    expect(pct.total).toBe(0);
  });
});

describe('token refresh', () => {
  it('refreshes exactly once when many workers race on an expired token', async () => {
    await m.pool.query("UPDATE accounts SET token_expires_at = now() - interval '1 minute'");
    const before = hs.refreshCalls;
    const tokens = await Promise.all(Array.from({ length: 12 }, () => m.getAccessToken(accountId)));
    expect(hs.refreshCalls - before).toBe(1);
    expect(new Set(tokens).size).toBe(1);
  });

  it('on a 401 from HubSpot, refreshes and retries once', async () => {
    const current = await m.getAccessToken(accountId);
    hs.revokedTokens.add(current);
    const before = hs.refreshCalls;
    const page = await m.withToken<{ results: unknown[] }>(accountId, async (t) => {
      const r = await fetch(`${hs.url}/crm/v3/objects/contacts?limit=1`, { headers: { authorization: `Bearer ${t}` } });
      if (r.status === 401) {
        const { HubSpotError } = await import('../../src/lib/errors');
        throw new HubSpotError('unauthorized', 401, null);
      }
      return (await r.json()) as { results: unknown[] };
    });
    expect(page.results).toHaveLength(1);
    expect(hs.refreshCalls - before).toBe(1);
  });
});

describe('notes sync', () => {
  const firstContact = async () => (await api('GET', '/api/contacts?pageSize=1')).json().data[0] as { id: string; hubspot_id: string };

  it('stores the note locally, then pushes it to the HubSpot contact', async () => {
    const c = await firstContact();
    const res = await api('POST', `/api/contacts/${c.id}/notes`, { body: 'Called, wants a demo <b>Friday</b>' });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    const noteId = res.json().id;
    const synced = await waitFor(async () => (await m.pool.query("SELECT * FROM notes WHERE id=$1 AND status='synced'", [noteId])).rows[0], 10_000, 'note sync');
    const remote = hs.notes.find((n) => n.id === synced.hubspot_note_id)!;
    expect(remote.contactId).toBe(c.hubspot_id);
    expect(remote.body).toContain('&lt;b&gt;Friday&lt;/b&gt;');
  });

  it('validates input', async () => {
    const c = await firstContact();
    expect((await api('POST', `/api/contacts/${c.id}/notes`, { body: '   ' })).statusCode).toBe(400);
    expect((await api('POST', `/api/contacts/not-a-uuid/notes`, { body: 'x' })).statusCode).toBe(400);
    expect((await api('POST', `/api/contacts/00000000-0000-0000-0000-000000000000/notes`, { body: 'x' })).statusCode).toBe(404);
  });

  it('does not create a duplicate when HubSpot saved the note but the response was lost', async () => {
    const c = await firstContact();
    hs.noteMode = 'create_then_500';
    const before = hs.notes.length;
    const noteId = (await api('POST', `/api/contacts/${c.id}/notes`, { body: 'exactly-once please' })).json().id;
    const row = await waitFor(async () => (await m.pool.query("SELECT * FROM notes WHERE id=$1 AND status='synced'", [noteId])).rows[0], 20_000, 'recovered note');
    expect(row.attempts).toBeGreaterThanOrEqual(2);
    expect(hs.notes.length - before).toBe(1); // one note in HubSpot, not two
    expect(hs.notes.at(-1)!.id).toBe(row.hubspot_note_id);
  });

  it('marks a note failed on a permanent error and allows a manual retry', async () => {
    const c = await firstContact();
    hs.noteMode = 'contact_gone';
    const noteId = (await api('POST', `/api/contacts/${c.id}/notes`, { body: 'will fail' })).json().id;
    const failed = await waitFor(async () => (await m.pool.query("SELECT * FROM notes WHERE id=$1 AND status='failed'", [noteId])).rows[0], 10_000, 'failed note');
    expect(failed.last_error).toContain('404');
    expect((await api('POST', `/api/notes/${noteId}/retry`)).statusCode).toBe(200);
    hs.noteMode = 'ok';
    await waitFor(async () => (await m.pool.query("SELECT 1 FROM notes WHERE id=$1 AND status='synced'", [noteId])).rows[0], 10_000, 'retried note');
    expect((await api('POST', `/api/notes/${noteId}/retry`)).statusCode).toBe(409); // already synced
  });

  it('the outbox sweeper recovers a pending note whose enqueue was lost', async () => {
    const c = await firstContact();
    const { rows } = await m.pool.query(
      "INSERT INTO notes (account_id, contact_id, body, updated_at) SELECT account_id, id, 'orphaned', now() - interval '5 minutes' FROM contacts WHERE id=$1 RETURNING id",
      [c.id],
    );
    await m.sweep();
    await waitFor(async () => (await m.pool.query("SELECT 1 FROM notes WHERE id=$1 AND status='synced'", [rows[0].id])).rows[0], 10_000, 'outbox note');
  });
});

describe('webhooks (real-time incremental sync)', () => {
  const post = (events: unknown[], opts: { badSig?: boolean } = {}) => {
    const body = JSON.stringify(events);
    const ts = String(Date.now());
    const url = 'http://localhost:5173/api/webhooks/hubspot';
    const sig = createHmac('sha256', 'test-client-secret').update(`POST${url}${body}${ts}`).digest('base64');
    return m.app.inject({
      method: 'POST',
      url: '/api/webhooks/hubspot',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hubspot-request-timestamp': ts, 'x-hubspot-signature-v3': opts.badSig ? 'AAAA' : sig },
    });
  };

  it('rejects unsigned/forged requests', async () => {
    expect((await post([], { badSig: true })).statusCode).toBe(401);
  });

  it('refreshes a changed contact and soft-deletes a deleted one', async () => {
    hs.contacts[0].properties.firstname = 'Renamed';
    hs.contacts[0].updatedAt = new Date().toISOString();
    expect((await post([
      { subscriptionType: 'contact.propertyChange', objectId: 1000, portalId: 12345 },
      { subscriptionType: 'contact.deletion', objectId: 1001, portalId: 12345 },
      { subscriptionType: 'contact.creation', objectId: 1000, portalId: 99999 }, // unknown portal: ignored
    ])).statusCode).toBe(200);
    await waitFor(async () => (await m.pool.query("SELECT 1 FROM contacts WHERE hubspot_id='1000' AND first_name='Renamed'")).rows[0], 10_000, 'webhook refresh');
    expect((await m.pool.query("SELECT deleted_at FROM contacts WHERE hubspot_id='1001'")).rows[0].deleted_at).not.toBeNull();
    expect((await api('GET', '/api/contacts?pageSize=100')).json().total).toBe(249);
  });

  it('does not let a stale payload overwrite newer data (last-write-wins guard)', async () => {
    const stale = { ...hs.contacts[0], properties: { ...hs.contacts[0].properties, firstname: 'STALE' }, updatedAt: '2020-01-01T00:00:00.000Z' };
    const { upsertContacts } = await import('../../src/services/contacts');
    const { mapContact } = await import('../../src/hubspot/client');
    await upsertContacts(m.pool, accountId, [mapContact(stale)]);
    expect((await m.pool.query("SELECT first_name FROM contacts WHERE hubspot_id='1000'")).rows[0].first_name).toBe('Renamed');
  });
});

describe('revoked authorization', () => {
  it('flags the account as needs_reauth instead of retrying forever', async () => {
    hs.refreshMode = 'revoked';
    await m.pool.query("UPDATE accounts SET token_expires_at = now() - interval '1 minute'");
    await expect(m.getAccessToken(accountId)).rejects.toThrow(/reconnect/i);
    const status = (await api('GET', '/api/auth/status')).json();
    expect(status).toMatchObject({ connected: false, needsReauth: true });
  });
});

describe('ops endpoints', () => {
  it('exposes health, readiness, metrics and sync status', async () => {
    expect((await m.app.inject({ method: 'GET', url: '/api/health' })).statusCode).toBe(200);
    expect((await m.app.inject({ method: 'GET', url: '/api/ready' })).statusCode).toBe(200);
    const metrics = await m.app.inject({ method: 'GET', url: '/metrics' });
    expect(metrics.body).toContain('contacts_synced_total');
    const s = (await api('GET', '/api/sync/status')).json();
    expect(s.contacts).toBeGreaterThan(0);
    expect(s.latest).toBeTruthy();
  });
});
