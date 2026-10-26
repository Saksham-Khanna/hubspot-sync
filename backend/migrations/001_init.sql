-- HubSpot sync schema. Plain SQL migrations, applied in filename order by src/migrate.ts.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- One row per connected HubSpot portal (tenant).
CREATE TABLE accounts (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  hub_id             bigint NOT NULL UNIQUE,
  hub_domain         text,
  user_email         text,
  status             text NOT NULL DEFAULT 'connected'
                       CHECK (status IN ('connected', 'needs_reauth', 'disconnected')),
  access_token_enc   text,            -- AES-256-GCM, see src/lib/crypto.ts
  refresh_token_enc  text,
  token_expires_at   timestamptz,
  scopes             text[] NOT NULL DEFAULT '{}',
  sync_watermark     timestamptz,     -- everything modified before this has been synced
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- Durable sync state + checkpoint. The queue is only the "driver"; this table is the truth.
CREATE TABLE sync_jobs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  type             text NOT NULL CHECK (type IN ('full', 'incremental')),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'running', 'completed', 'failed')),
  cursor           text,              -- HubSpot `after` cursor of the NEXT page to fetch
  run              integer NOT NULL DEFAULT 0,   -- bumped on every resume; part of queue job ids
  pages            integer NOT NULL DEFAULT 0,
  contacts_synced  bigint  NOT NULL DEFAULT 0,
  since            timestamptz,       -- incremental: lower bound for hs_lastmodifieddate
  last_error       text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
-- At most one active sync per account (prevents two chains walking the same cursor).
CREATE UNIQUE INDEX sync_jobs_one_active_per_account
  ON sync_jobs (account_id) WHERE status IN ('pending', 'running');
CREATE INDEX sync_jobs_account_created ON sync_jobs (account_id, created_at DESC);
CREATE INDEX sync_jobs_stalled ON sync_jobs (updated_at) WHERE status = 'running';

CREATE TABLE contacts (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  hubspot_id       text NOT NULL,
  email            text,
  first_name       text,
  last_name        text,
  phone            text,
  company          text,
  lifecycle_stage  text,
  properties       jsonb NOT NULL DEFAULT '{}',
  hs_created_at    timestamptz,
  hs_updated_at    timestamptz,
  synced_at        timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  search_text      text GENERATED ALWAYS AS (
    lower(coalesce(first_name,'') || ' ' || coalesce(last_name,'') || ' ' ||
          coalesce(email,'')      || ' ' || coalesce(company,''))
  ) STORED,
  -- The idempotency key for every contact write.
  CONSTRAINT contacts_account_hubspot_uniq UNIQUE (account_id, hubspot_id)
);
CREATE INDEX contacts_list ON contacts (account_id, hs_created_at DESC NULLS LAST, id) WHERE deleted_at IS NULL;
CREATE INDEX contacts_search_trgm ON contacts USING gin (search_text gin_trgm_ops);

-- Notes double as the outbox: a row in `pending` is a unit of work to push to HubSpot.
CREATE TABLE notes (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id       uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  body             text NOT NULL CHECK (length(body) BETWEEN 1 AND 10000),
  status           text NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'syncing', 'synced', 'failed')),
  hubspot_note_id  text,
  attempts         integer NOT NULL DEFAULT 0,
  last_error       text,
  locked_at        timestamptz,
  synced_at        timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notes_contact ON notes (contact_id, created_at DESC);
CREATE INDEX notes_outbox ON notes (updated_at) WHERE status IN ('pending', 'syncing');
