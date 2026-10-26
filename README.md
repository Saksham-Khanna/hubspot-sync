# HubSpot Contact & Notes Sync

Full-stack app that connects to a HubSpot portal via OAuth, **automatically** imports its contacts, keeps them fresh, and pushes notes written in the app back to the matching HubSpot contact.

- **Backend:** Node 22 · TypeScript · Fastify · PostgreSQL · Redis + BullMQ
- **Frontend:** React 18 · Vite · TanStack Query (deployed on Vercel)
- **Deep dive:** [docs/TECHNICAL.md](docs/TECHNICAL.md) (architecture, schema, flows, retry/scaling strategy, trade-offs)

```
Browser ── Vercel (React) ──/api/* rewrite──▶ API (Fastify) ──▶ PostgreSQL  (source of truth)
                                                 │  ▲
                                          enqueue│  │webhooks
                                                 ▼  │
                                              Redis (BullMQ) ◀──▶ Workers (N replicas) ──▶ HubSpot API
```

## Features

| Requirement | Implementation |
|---|---|
| HubSpot OAuth | Authorization-code flow, CSRF `state`, AES-256-GCM encrypted tokens, automatic refresh with a DB row lock, 401-triggered refresh+retry, `needs_reauth` state |
| Automatic contact sync | Starts from the OAuth callback; no sync button. Cursor-paginated, one queue job per page, checkpointed in Postgres, resumable, idempotent batched upserts |
| Failure handling | Exponential backoff (8 attempts), honours `Retry-After`/429 without burning retries, permanent vs transient error classification, self-healing sweeper |
| Notes | Saved locally first (transactional outbox), pushed to HubSpot by a worker, duplicate-safe retries, per-note status + manual retry |
| UI | Connection status, Connect/Disconnect/Reconnect, searchable paginated contact list, details, notes with live delivery status, sync dashboard, loading/success/error states |
| Bonus | Webhooks (signature-verified) for real-time updates · scheduled incremental sync · sync dashboard · search + pagination · unit + end-to-end tests · Docker · CI · Prometheus metrics · structured logs · mock HubSpot server |

## Quick start (local, ~5 minutes)

Prerequisites: Node 22+, Docker (or local Postgres 16 + Redis 7).

```bash
# 1. Infra
docker compose up -d postgres redis

# 2. Backend
cd backend
cp .env.example .env          # fill in the values, see "Environment variables"
npm install
npm run dev                   # API + workers in one process (RUN_WORKERS_IN_API=true)

# 3. Frontend (new terminal)
cd frontend
npm install
npm run dev                   # http://localhost:5173  (proxies /api to :3000)
```

Open http://localhost:5173 → **Connect HubSpot** → approve → contacts begin importing immediately.

### Create the HubSpot app (needed for real OAuth)
1. Create a free [HubSpot developer account](https://developers.hubspot.com/) and a **test account** to hold sample contacts.
2. Create an **app** (public app, OAuth). On its **Auth** settings:
   - Redirect URL: `http://localhost:5173/api/auth/hubspot/callback` (add your production URL too)
   - Scopes: `crm.objects.contacts.read`, `crm.objects.contacts.write`
3. Copy **Client ID / Client secret** into `backend/.env`.
4. *(Optional, for real-time updates)* In the app's **Webhooks** settings set the target URL to `https://<your-api-host>/api/webhooks/hubspot` and subscribe to `contact.creation`, `contact.propertyChange`, `contact.deletion`.

HubSpot's developer UI changes between releases; if a label differs, the concepts above are what matter. If creating a note returns `MISSING_SCOPES`, add the scope HubSpot names to both the app and `HUBSPOT_SCOPES`.

### Try it without a HubSpot account
```bash
cd backend
npm run mock:hubspot          # fake HubSpot on :4010 with 2,500 contacts
# in backend/.env uncomment:
#   HUBSPOT_API_BASE=http://127.0.0.1:4010
#   HUBSPOT_AUTH_URL=http://127.0.0.1:4010/oauth/authorize
# (any HUBSPOT_CLIENT_ID/SECRET values work against the mock)
```

### Everything in containers
```bash
cp backend/.env.example backend/.env
docker compose up --build     # postgres, redis, api, worker  (scale: --scale worker=3)
```

## Environment variables (`backend/.env`)

| Variable | Default | Purpose |
|---|---|---|
| `DATABASE_URL` | – | Postgres connection string |
| `DATABASE_SSL` | `false` | `true` for managed DBs that require TLS |
| `REDIS_URL` | `redis://localhost:6379` | BullMQ + rate limiter. **Must use `maxmemory-policy noeviction`** |
| `HUBSPOT_CLIENT_ID` / `HUBSPOT_CLIENT_SECRET` | – | From your HubSpot app |
| `HUBSPOT_REDIRECT_URI` | – | Exact redirect URL registered on the app; points at the **frontend origin** |
| `HUBSPOT_SCOPES` | `oauth crm.objects.contacts.read crm.objects.contacts.write` | Must match the app's configured scopes |
| `WEBHOOK_PUBLIC_URL` | derived | Exact URL HubSpot calls; required for signature verification behind proxies |
| `FRONTEND_URL` | – | Where the user is sent after OAuth; also the CORS origin |
| `COOKIE_SECRET` | – | ≥32 chars; signs the session + OAuth state cookies |
| `TOKEN_ENCRYPTION_KEY` | – | 32 random bytes, base64 (`openssl rand -base64 32`). Losing it forces everyone to reconnect |
| `SYNC_PAGE_SIZE` | `100` | Contacts per HubSpot page (max 100) |
| `SYNC_CONCURRENCY` / `NOTES_CONCURRENCY` | `10` / `10` | Parallel jobs per worker process |
| `HUBSPOT_RATE_LIMIT_MAX` / `_WINDOW_MS` | `90` / `10000` | Per-portal call budget; keep below HubSpot's published limit |
| `INCREMENTAL_INTERVAL_MIN` | `15` | Safety-net incremental sync cadence |
| `RUN_WORKERS_IN_API` | `false` | `true` = single process; `false` = run `npm run start:worker` separately |
| `AUTO_MIGRATE` | `true` | Apply SQL migrations on boot (advisory-locked) |
| `DB_POOL_MAX`, `PORT`, `LOG_LEVEL` | `20`, `3000`, `info` | Ops knobs |

The frontend needs **no** env vars: it always calls relative `/api/...` (Vite proxy locally, Vercel rewrite in production), which keeps the session cookie first-party.

## Tests
```bash
cd backend
# needs Postgres + Redis; defaults: postgres://app:app@localhost:5432/hubspot_sync_test, redis db 1
npm test
```
- **Unit:** encryption (tamper/wrong key), webhook signature (replay, tamper), HubSpot client (429/Retry-After, network errors, paging, note dedupe lookup), error classification.
- **End-to-end** (real Fastify + BullMQ + Postgres + Redis against an in-process fake HubSpot): OAuth + CSRF, encrypted token storage, auto-sync with no duplicates, retry after 500, resume-from-checkpoint via sweeper, 12 concurrent workers → exactly 1 token refresh, 401 → refresh → retry, notes sync, exactly-once on "saved but response lost", permanent failure + manual retry, outbox recovery, webhooks (refresh/delete/stale-write guard), `needs_reauth`, rate-limit + 429 back-pressure.
- CI: `.github/workflows/ci.yml`.

## Deployment

**Frontend → Vercel**
1. Import the repo, set **Root Directory = `frontend`** (framework auto-detects Vite).
2. Edit `frontend/vercel.json`: replace `YOUR-BACKEND-HOST.example.com` with your API host. This rewrite is what makes `/api/*` same-origin.
3. Register `https://<your-app>.vercel.app/api/auth/hubspot/callback` as a redirect URL in HubSpot.

**Backend → any container host** (Render blueprint in `render.yaml`; Railway/Fly/ECS work the same):
- Two services from `backend/Dockerfile`: **api** (`node dist/server.js`) and **worker** (`node dist/worker.js`), plus managed Postgres and Redis (`noeviction`).
- Set the env vars above (`HUBSPOT_REDIRECT_URI` and `FRONTEND_URL` use the Vercel URL; `WEBHOOK_PUBLIC_URL` uses the API's public URL).
- Health: `GET /api/health` (liveness), `GET /api/ready` (DB + Redis), `GET /metrics` (Prometheus; restrict at the proxy in production).
- For a minimal single-service deploy set `RUN_WORKERS_IN_API=true` and skip the worker service.

## Assumptions
- A browser session = one HubSpot portal (tenant). Whoever completes OAuth for a portal gets access to that portal's synced data. There are no per-user roles inside a portal.
- HubSpot limits (≈100 calls/10 s per portal for OAuth apps, 100 records/page for list, search capped at 10,000 results/query) are configurable assumptions; verify against current HubSpot docs.
- Notes flow **app → HubSpot only**. Edits/deletes of notes and notes created in HubSpot are not imported.

## Limitations (honest list)
- Verified end-to-end against a **fake HubSpot written from the documented API shapes**, not against a live HubSpot portal. The first real run may need scope or field-name adjustments (see `src/hubspot/client.ts`, the only file that knows HubSpot's wire format).
- Webhook signature verification implements HubSpot's documented v3 algorithm and is tested with our own signer, not real HubSpot traffic.
- `Dockerfile`, `docker-compose.yml`, `render.yaml`, `vercel.json` were written carefully but not executed in the authoring environment.
- One in-flight page per portal (cursor chain): large single portals are latency-bound (~18k contacts/min at 300 ms/page). See scaling section for the sharding design that is **not** implemented.
- A recreated-in-HubSpot note carries a visible `[ref:<uuid>]` footer, the price of duplicate detection (HubSpot has no idempotency keys).
- Contact list uses offset pagination + `count(*)`; fine to ~10⁵ rows/portal, switch to keyset beyond that.
- Contacts deleted in HubSpot are only noticed via webhooks; the incremental sync does not detect deletions.
- Session cookie is a signed account id (no server-side session store / revocation list).

## Future improvements
Range-sharded parallel fetch for huge portals · keyset pagination · deletion reconciliation · Bull Board / dead-letter UI · OpenTelemetry tracing · per-tenant fairness weights · inbound notes sync · token key rotation (`v2.` ciphertext prefix is reserved) · Redis Cluster / queue sharding · e2e browser tests.

## Repository layout
```
backend/
  migrations/001_init.sql        schema (accounts, sync_jobs, contacts, notes)
  src/
    app.ts server.ts worker.ts   API process / worker process entrypoints
    config.ts db.ts redis.ts queues.ts migrate.ts
    hubspot/client.ts            the only module that speaks HubSpot's wire format
    services/{tokens,sync,contacts,notes,maintenance}.ts   business logic
    workers/index.ts             BullMQ workers + failure handlers
    routes/{auth,contacts,sync,webhooks,session}.ts
    lib/{crypto,errors,rateLimiter,metrics,logger}.ts
  test/{unit,integration}        incl. fakeHubSpot.ts (also used by `npm run mock:hubspot`)
frontend/src/{App.tsx,components/,lib/api.ts,styles.css}
docs/TECHNICAL.md   docker-compose.yml   render.yaml   .github/workflows/ci.yml
```
