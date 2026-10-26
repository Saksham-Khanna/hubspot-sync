# Technical Documentation

1. [System architecture](#system-architecture)
2. [OAuth implementation](#oauth-implementation)
3. [Database schema](#database-schema)
4. [Synchronization flow](#synchronization-flow)
5. [Background processing strategy](#background-processing-strategy)
6. [Error handling](#error-handling)
7. [Retry strategy](#retry-strategy)
8. [Scalability approach](#scalability-approach)
9. [Observability](#observability)
10. [Security](#security)
11. [Design decisions and trade-offs](#design-decisions-and-trade-offs)
12. [Testing](#testing)

## System architecture

```
                   ┌──────────────────────────────────────────────┐
 Browser ──────▶   │ Vercel: React SPA, /api/* rewritten to API   │
                   └───────────────────────┬──────────────────────┘
                                           ▼
 HubSpot ─webhooks─▶  ┌──────────── API (Fastify, stateless, N replicas) ────────────┐
                      │ OAuth · contacts/notes/sync REST · webhook intake · /metrics │
                      └───────┬──────────────────────────────────────┬───────────────┘
                              │ SQL                                  │ enqueue
                              ▼                                      ▼
                    ┌──────────────────┐                 ┌───────────────────────┐
                    │ PostgreSQL       │◀── SQL ────────▶│ Redis (BullMQ queues, │
                    │ source of truth: │                 │ rate-limit counters)  │
                    │ tokens, cursors, │                 └───────────┬───────────┘
                    │ contacts, notes  │                             │ jobs
                    └──────────────────┘                             ▼
                              ▲                        ┌──────────────────────────────┐
                              └──────── SQL ──────────▶│ Workers (stateless, N replicas)│──▶ HubSpot API
                                                       │ sync · notes · maintenance    │
                                                       └──────────────────────────────┘
```

Principles:
- **Postgres is the source of truth, Redis is only the engine.** Cursor, counters, note state and tokens live in Postgres. Losing Redis loses *scheduling*, never *data or progress*; the sweeper rebuilds the work from Postgres.
- **API and workers are separate, stateless processes** so each scales independently (`RUN_WORKERS_IN_API=true` collapses them for small deployments).
- **One module speaks HubSpot** (`src/hubspot/client.ts`); everything else deals in `MappedContact`s and typed errors.

## OAuth implementation

Authorization-code flow, `src/routes/auth.ts`.

1. `GET /api/auth/hubspot/start` generates 24 random bytes as `state`, stores it in a **signed, httpOnly, SameSite=Lax cookie** (10 min, path `/api/auth`) and redirects to HubSpot's consent URL.
2. HubSpot redirects to `HUBSPOT_REDIRECT_URI` (`/api/auth/hubspot/callback`). We compare `state` to the signed cookie (CSRF defence), clear the cookie, then exchange `code` for tokens.
3. `GET /oauth/v1/access-tokens/{token}` resolves `hub_id`, domain and user. The account is **upserted by `hub_id`** (reconnecting the same portal reuses its row and data).
4. Access and refresh tokens are encrypted (**AES-256-GCM**, random 96-bit IV per value, format `v1.<iv>.<tag>.<ct>`, key from `TOKEN_ENCRYPTION_KEY`) before they touch the database.
5. A sync is started automatically and a signed session cookie (`sid`, httpOnly, 30 days) is set; the browser returns to the SPA.

The redirect URI intentionally points at the **frontend origin**; Vercel rewrites `/api/*` to the backend. That way every cookie is first-party, avoiding third-party-cookie blocking that would break a cross-site API.

**Token refresh** (`src/services/tokens.ts`):
- Tokens are refreshed 60 s before expiry.
- Refresh runs inside a transaction holding `SELECT … FOR UPDATE` on the account row. Concurrent workers queue on the lock; after acquiring it each re-reads the row and reuses the token the winner stored. *Verified by test:* 12 concurrent callers → exactly one call to HubSpot's token endpoint.
- A 401 from HubSpot triggers one forced refresh (`rejectedToken` stops a second refresh if someone else already replaced it) and one retry of the call.
- If HubSpot rejects the refresh token (400/401/403) the account becomes `needs_reauth` and jobs fail permanently (`ReauthRequiredError`, no retries). The UI shows a Reconnect banner; data is kept. 5xx/network failures roll back and are retried normally.

## Database schema

`backend/migrations/001_init.sql`.

| Table | Purpose | Notable constraints / indexes |
|---|---|---|
| `accounts` | One row per HubSpot portal (tenant). Encrypted tokens, `status` (`connected`/`needs_reauth`/`disconnected`), `sync_watermark` | `UNIQUE(hub_id)` |
| `sync_jobs` | Durable sync state: `type` (full/incremental), `status`, **`cursor`** (next page), `run`, `pages`, `contacts_synced`, `since`, `last_error` | **Partial unique index: one `pending`/`running` job per account**; partial index for stalled-job scans |
| `contacts` | Synced contacts, typed columns + raw `properties jsonb`, `deleted_at` soft delete, generated `search_text` | **`UNIQUE(account_id, hubspot_id)`** = idempotency key; trigram GIN on `search_text`; list index `(account_id, hs_created_at DESC, id) WHERE deleted_at IS NULL` |
| `notes` | Local notes **and** the outbox: `status` (`pending`/`syncing`/`synced`/`failed`), `hubspot_note_id`, `attempts`, `locked_at`, `last_error` | Partial index on `status IN ('pending','syncing')` for the sweeper |

Choices: every table is keyed by `account_id` (tenant isolation in every query, easy hash-partitioning later); `properties jsonb` keeps unmodelled HubSpot fields without schema churn; `search_text` is a generated stored column so search uses an index instead of `ILIKE` across four columns; migrations are plain SQL applied under an advisory lock so API and worker can boot simultaneously.

## Synchronization flow

```
OAuth callback ──▶ startSync(): INSERT sync_jobs (one active per account) ─▶ enqueue sync-page(run 0, page 0)

sync-page job (one HubSpot page):
  1. load sync_jobs row (skip if completed/failed)
  2. limiter.acquire(account)  ── over budget? ─▶ delay job (no retry consumed)
  3. GET /crm/v3/objects/contacts?after=<cursor>&limit=100   (401→refresh+retry once; 429→delay by Retry-After)
  4. BEGIN
       upsert page (one statement, ON CONFLICT (account_id,hubspot_id) DO UPDATE ... WHERE not stale)
       UPDATE sync_jobs SET cursor=<next>, pages+1, contacts_synced+n
                      WHERE id=? AND status='running' AND cursor IS NOT DISTINCT FROM <old cursor>   ◀ compare-and-swap
       (last page: status='completed', accounts.sync_watermark = job.started_at)
     COMMIT
  5. if more pages: enqueue sync-page(run, pages)   (deterministic jobId → duplicate adds ignored)
```

Why it is safe to interrupt anywhere:
- **Crash before COMMIT:** nothing changed; the retry re-reads the same cursor.
- **Crash after COMMIT, before enqueue:** the checkpoint is durable but the chain is broken; the sweeper (below) notices `updated_at` is stale and re-enqueues from the stored cursor.
- **Duplicate or stalled job runs the same page twice:** upserts are idempotent and the cursor compare-and-swap matches 0 rows for the loser, which rolls back and stops. Two chains cannot both advance.
- **Duplicates:** impossible by `UNIQUE(account_id, hubspot_id)`; in-batch duplicates are collapsed before the statement.
- **Out-of-order writes:** the `WHERE contacts.hs_updated_at <= EXCLUDED.hs_updated_at` guard means a stale webhook refresh can't overwrite newer data.

**Incremental sync** uses the Search API (`lastmodifieddate >= watermark − 5 min`, oldest first). It runs (a) on reconnect and (b) every `INCREMENTAL_INTERVAL_MIN` as a safety net for missed webhooks. If a window has more than 10,000 changes (Search cannot page past that) it escalates to a full sync.

**Webhooks** (`routes/webhooks.ts`): verify HubSpot's v3 signature (HMAC-SHA256 over method+URL+body+timestamp, 5-minute replay window, constant-time compare), apply deletions inline (cheap), enqueue `refresh-contacts` jobs (≤100 ids → one `batch/read`) and return 200 quickly. Events are at-least-once and unordered; refreshes are idempotent upserts, so duplicates are harmless.

**Notes flow:** `POST /contacts/:id/notes` inserts a `pending` row (this *is* the outbox entry) and then enqueues `push-note`. The worker:
1. atomically claims the row (`pending → syncing`, increments `attempts`; a stale `syncing` lock older than 2 min can be reclaimed),
2. if `attempts > 1`, first looks for the note's `[ref:<uuid>]` marker among the contact's existing HubSpot notes (covers "HubSpot saved it but we never got the response"),
3. otherwise `POST /crm/v3/objects/notes` associated to the contact,
4. stores `hubspot_note_id` and sets `synced`.

Re-delivery of an already-synced note is a no-op. *Verified by test:* HubSpot stores the note and returns 500; the retry finds it and does not create a second one.

## Background processing strategy

| Queue | Jobs | Notes |
|---|---|---|
| `sync` | `sync-page`, `refresh-contacts` | `SYNC_CONCURRENCY` parallel jobs per worker process |
| `notes` | `push-note` | `NOTES_CONCURRENCY` |
| `maintenance` | `sweep` (every 60 s via a BullMQ job scheduler) | concurrency 1; idempotent, any replica may run it |

- **One job per page** (not one long job): bounded job duration, fair interleaving of tenants on the same workers, natural horizontal scaling, and per-page retries instead of restarting an import.
- **Per-portal rate limiter:** a Redis fixed-window counter (atomic Lua `INCRBY`) shared by all workers. When over budget the job is moved to the delayed set (`moveToDelayed` + `DelayedError`) so it frees its worker slot and **does not count as a retry**. HubSpot 429s are handled the same way using `Retry-After`.
- **Sweeper** (`services/maintenance.ts`) closes every "committed in Postgres but not yet handed to the queue" gap:
  1. sync jobs `pending/running` with no progress for 3 min → bump `run`, re-enqueue from the checkpoint,
  2. notes `pending` > 2 min (enqueue lost) or `syncing` with an expired lock (worker died) → re-enqueue,
  3. connected accounts due for incremental sync → start one.
- **Graceful shutdown:** SIGTERM closes workers (waits for in-flight jobs) before closing queues, Postgres, Redis; anything unfinished is recovered by BullMQ stall detection and the sweeper.

## Error handling

| Situation | Behaviour |
|---|---|
| HubSpot 429 | Job delayed by `Retry-After` (fallback 10 s); no attempt consumed |
| HubSpot 5xx / timeout / network | Retryable: exponential backoff |
| HubSpot 401 | Refresh token once, retry; refresh rejected → `needs_reauth` (permanent) |
| HubSpot other 4xx (400, 403, 404…) | Permanent (`PermanentError`): no retries. Note → `failed` with `last_error`; sync job → `failed` |
| Retries exhausted | Sync job → `failed` (cursor preserved; **Resume sync** button continues from it). Note → `failed` (**Try again** button). BullMQ keeps the failed job 14 days as a dead-letter set |
| Stale cursor / duplicate job | Detected by compare-and-swap, quietly skipped |
| Redis down when adding a note | Note is already durable; sweeper delivers it later |
| Invalid input | Zod validation → 400 with a readable message; unknown contact → 404 |
| Unexpected exception in API | Logged with request id, client gets generic 500 (no internals leaked) |

## Retry strategy

- BullMQ `attempts: 8`, `backoff: exponential, delay 2 s` → waits of 2, 4, 8, … 128 s (≈ 4 minutes in total).
- Rate-limit delays are *not* retries (see above), so a busy portal never "fails" for being busy.
- Permanent errors skip retries (`UnrecoverableError`).
- Persistent failure surfaces as `failed` state in the UI with a human-triggered resume, never silent loss.
- Layered recovery: BullMQ retry (transient) → stall detection (worker death) → sweeper (lost enqueue / Redis loss) → manual resume (exhausted).

## Scalability approach

**Target: 100,000 contacts/min ≈ 1,670 contacts/s ≈ 17 page-fetches/s at 100 per page.**

Where the limit really is: *HubSpot*, not this system. With the assumed ~100 calls/10 s per portal budget (configure `HUBSPOT_RATE_LIMIT_*`; verify current numbers), one portal tops out near 9 pages/s ≈ 54k contacts/min even if every call were perfect. So 100k/min is only reachable as **aggregate throughput across many portals** (or one very high-limit portal with sharded fetching). Our job is to ensure our side never becomes the bottleneck:

| Concern | How it scales | Rough numbers (estimates, not benchmarks) |
|---|---|---|
| Fetch parallelism | One page per job; any worker takes any job; different portals interleave freely | 17 pages/s × ~0.3 s ≈ 5–6 jobs in flight → one worker (concurrency 10) is already enough; add replicas for headroom |
| Per-portal ceiling | Limiter budget prevents 429 storms; one in-flight page per portal ⇒ ~3 pages/s ≈ 18k contacts/min per portal at 300 ms latency | ≥ 6 portals syncing concurrently ≈ 100k/min with the current design |
| Single huge portal | **Not implemented.** Design: partition by `createdate` range (Search API, ranges sized ≤ 10k), one chain per range, all drawing from the same limiter; ceiling becomes the limiter (≈ 54k/min) | Needs range planning + per-range cursors in `sync_jobs` (child table) |
| DB writes | One batched `INSERT … ON CONFLICT` per 100 rows via `unnest` (constant bind params, one round trip) | ~17 statements/s: trivial. Headroom: batch several pages, `synchronous_commit=off` for bulk loads, partition `contacts` by `account_id` hash, bigger pool/PgBouncer |
| Redis | A handful of commands per job; limiter is one Lua call | ~hundreds ops/s; single instance fine; shard queues by account hash if ever needed |
| API tier | Stateless; scale replicas behind a load balancer; limiter store is Redis so limits hold across replicas | – |
| Hot tenants / fairness | Per-page jobs interleave tenants FIFO; a limiter-delayed tenant doesn't block workers | Future: per-tenant concurrency caps / weighted queues |
| Memory | Pages are streamed, never accumulated | Constant per job |

The mock run in this repo imported 2,500 contacts (25 pages) in about 0.4 s in a single process with **zero upstream latency**. It shows our pipeline overhead is small; it is not a throughput benchmark.

Monitoring knobs for scaling decisions: queue depth (`waiting`/`delayed`), job duration histogram, `rate_limit_delays_total`, Postgres write latency.

## Observability

- **Logs:** structured JSON (pino) with request ids; tokens/cookies redacted.
- **Metrics** (`GET /metrics`, Prometheus): `hubspot_requests_total{endpoint,status}`, `contacts_synced_total`, `notes_push_total{outcome}`, `queue_job_duration_seconds{job,outcome}`, `rate_limit_delays_total{source}`, plus Node process metrics. Protect `/metrics` at the proxy in production.
- **Health:** `/api/health` (liveness), `/api/ready` (Postgres + Redis).
- **In-app:** sync dashboard (`GET /api/sync/status`, `/api/sync/jobs`): progress, pages, last error, note delivery counts, queue counts.
- Suggested alerts: `failed` queue growth, stalled-sync sweeps > 0 sustained, sync jobs in `failed`, 5xx rate, `needs_reauth` count.

## Security

- Tokens encrypted at rest (AES-256-GCM, authenticated); key only in env.
- OAuth `state` in a signed httpOnly cookie; session cookie signed, httpOnly, `SameSite=Lax`, `Secure` in production. SameSite plus JSON-only mutation endpoints is the CSRF posture for the API.
- Every data query is scoped by the session's `account_id`; ids are validated as UUIDs.
- Webhooks: HMAC-SHA256 v3 signature, constant-time comparison, 5-minute timestamp window.
- Global rate limit (600/min per client, Redis-backed), 1 MB body limit, note length ≤ 10,000, HTML-escaped note bodies before sending to HubSpot, parameterised SQL only.
- Known gap: session is a signed account id with no server-side revocation list; disconnecting revokes access by nulling tokens and status, not by invalidating the cookie everywhere.

## Design decisions and trade-offs

| Decision | Why | Cost / alternative |
|---|---|---|
| Postgres row lock for token refresh instead of a Redis lock | No lock-expiry/ownership edge cases; lock is released automatically if the process dies; correct by construction | Holds a DB connection for the refresh HTTP call (≤ 15 s timeout). Redis lock would avoid that but needs fencing |
| Checkpoint in Postgres, not in the job payload | Progress survives Redis loss and can be shown/resumed in the UI | One small extra write per page (same transaction as the data) |
| Page-per-job chain | Fairness, bounded jobs, resumability | Throughput per portal is latency-bound; sharding is the next step |
| Cursor compare-and-swap + deterministic job ids | Makes at-least-once delivery safe without distributed locks | Slightly more SQL |
| Notes as outbox rows | No dual-write problem between DB and queue | Needs a sweeper for lost enqueues |
| `[ref:<uuid>]` marker for duplicate detection | HubSpot offers no idempotency key; this is the only reliable way to detect "created but unacknowledged" | Marker is visible in the HubSpot note; lookup covers the first 500 associated notes |
| One-way notes (app → HubSpot) | Matches the requirement and avoids conflict resolution | No inbound/edited notes |
| Redirect URI on frontend origin + Vercel rewrite | First-party cookies, no CORS/3rd-party-cookie problems | Backend URL lives in `vercel.json`; the proxy adds a hop |
| Fixed-window limiter | Simple, atomic, cheap | Allows a burst at window boundaries (up to 2× budget over a short span); token bucket would smooth it. Budget default (90) leaves headroom |
| Soft deletes for contacts | Webhook deletions are reversible and keep FK integrity for notes | Table grows; add a purge job |
| Offset pagination | Simple and enough for the UI | O(offset) at large scale → keyset later |
| Plain SQL migrations | Zero dependencies, reviewable | No down-migrations / tooling |

## Testing

- `test/unit`: crypto, webhook signature, HubSpot client behaviours, error classification.
- `test/integration/e2e.test.ts`: the full system against `fakeHubSpot.ts` (see README for the scenario list).
- `test/integration/rateLimit.test.ts`: back-pressure with a 2-calls/second budget plus injected 429s: sync completes, nothing fails, delays are recorded.
- Not covered: live HubSpot, browser/UI tests, load tests, multi-process worker races beyond what BullMQ + SQL guarantees.
