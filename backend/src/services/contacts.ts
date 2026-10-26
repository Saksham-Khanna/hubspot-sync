import { Queryable } from '../db';
import { MappedContact } from '../hubspot/client';
import { contactsSynced } from '../lib/metrics';

/**
 * Batched, idempotent upsert: ONE statement per page regardless of page size.
 *
 * - Key: UNIQUE (account_id, hubspot_id)  => replays never create duplicates.
 * - Last-write-wins guard: a stale payload (older hs_updated_at) never overwrites a newer row,
 *   so an out-of-order webhook refresh can't regress data written by a later full sync.
 * - Columns are passed as parallel arrays + unnest(): constant number of bind parameters.
 */
export async function upsertContacts(db: Queryable, accountId: string, input: MappedContact[]): Promise<number> {
  // ON CONFLICT cannot touch the same row twice in one statement: dedupe, keeping the newest.
  const byId = new Map<string, MappedContact>();
  for (const c of input) {
    const prev = byId.get(c.hubspotId);
    if (!prev || (c.hsUpdatedAt ?? '') >= (prev.hsUpdatedAt ?? '')) byId.set(c.hubspotId, c);
  }
  const rows = [...byId.values()];
  if (rows.length === 0) return 0;

  await db.query(
    `INSERT INTO contacts (account_id, hubspot_id, email, first_name, last_name, phone, company, lifecycle_stage,
                           hs_created_at, hs_updated_at, properties, synced_at, deleted_at)
     SELECT $1::uuid, t.hubspot_id, t.email, t.first_name, t.last_name, t.phone, t.company, t.lifecycle_stage,
            t.hs_created_at::timestamptz, t.hs_updated_at::timestamptz, t.properties::jsonb, now(), NULL
       FROM unnest($2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[],
                   $9::text[], $10::text[], $11::text[])
            AS t(hubspot_id, email, first_name, last_name, phone, company, lifecycle_stage,
                 hs_created_at, hs_updated_at, properties)
     ON CONFLICT (account_id, hubspot_id) DO UPDATE SET
       email = EXCLUDED.email, first_name = EXCLUDED.first_name, last_name = EXCLUDED.last_name,
       phone = EXCLUDED.phone, company = EXCLUDED.company, lifecycle_stage = EXCLUDED.lifecycle_stage,
       hs_created_at = EXCLUDED.hs_created_at, hs_updated_at = EXCLUDED.hs_updated_at,
       properties = EXCLUDED.properties, synced_at = now(), deleted_at = NULL, updated_at = now()
     WHERE contacts.hs_updated_at IS NULL
        OR EXCLUDED.hs_updated_at IS NULL
        OR EXCLUDED.hs_updated_at >= contacts.hs_updated_at`,
    [
      accountId,
      rows.map((r) => r.hubspotId),
      rows.map((r) => r.email),
      rows.map((r) => r.firstName),
      rows.map((r) => r.lastName),
      rows.map((r) => r.phone),
      rows.map((r) => r.company),
      rows.map((r) => r.lifecycleStage),
      rows.map((r) => r.hsCreatedAt),
      rows.map((r) => r.hsUpdatedAt),
      rows.map((r) => JSON.stringify(r.properties)),
    ],
  );
  contactsSynced.inc(rows.length);
  return rows.length;
}

export async function softDeleteContacts(db: Queryable, accountId: string, hubspotIds: string[]): Promise<void> {
  if (hubspotIds.length === 0) return;
  await db.query(
    'UPDATE contacts SET deleted_at = now(), updated_at = now() WHERE account_id = $1 AND hubspot_id = ANY($2::text[])',
    [accountId, hubspotIds],
  );
}
