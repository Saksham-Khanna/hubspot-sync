import { Job } from 'bullmq';
import { config } from '../config';
import { isUniqueViolation, pool, tx } from '../db';
import { hubspot } from '../hubspot/client';
import { HubSpotError } from '../lib/errors';
import { classify } from '../lib/errors';
import { logger } from '../lib/logger';
import { acquireHubSpotSlot, delayJob } from '../lib/rateLimiter';
import { RefreshContactsData, SyncPageData, addJob, syncQueue } from '../queues';
import { upsertContacts } from './contacts';
import { withToken } from './tokens';

// HubSpot's search API cannot page beyond 10,000 results per query.
const SEARCH_CAP = 10_000;
// An incremental sync re-reads a little before the watermark to absorb clock skew.
const WATERMARK_OVERLAP_MS = 5 * 60 * 1000;

export interface SyncJobRow {
  id: string;
  account_id: string;
  type: 'full' | 'incremental';
  status: 'pending' | 'running' | 'completed' | 'failed';
  cursor: string | null;
  run: number;
  pages: number;
  contacts_synced: number;
  since: Date | null;
  started_at: Date;
}

export const pageJobId = (syncJobId: string, run: number, page: number) => `sync-${syncJobId}-r${run}-p${page}`;

export function enqueuePage(syncJobId: string, run: number, page: number, delayMs = 0) {
  return addJob(syncQueue, 'sync-page', { syncJobId } satisfies SyncPageData, {
    jobId: pageJobId(syncJobId, run, page),
    delay: delayMs || undefined,
  });
}

/**
 * Start a sync unless one is already active for the account (partial unique index + check).
 * Full sync if the account has never completed one; otherwise incremental from the watermark.
 */
export async function startSync(accountId: string, forceType?: 'full' | 'incremental'): Promise<{ id: string; created: boolean }> {
  const active = await pool.query("SELECT id FROM sync_jobs WHERE account_id=$1 AND status IN ('pending','running')", [accountId]);
  if (active.rows[0]) return { id: active.rows[0].id, created: false };

  const acct = (await pool.query('SELECT sync_watermark FROM accounts WHERE id=$1', [accountId])).rows[0];
  const type = forceType ?? (acct?.sync_watermark ? 'incremental' : 'full');
  const since = type === 'incremental' && acct?.sync_watermark ? new Date(acct.sync_watermark.getTime() - WATERMARK_OVERLAP_MS) : null;
  try {
    const { rows } = await pool.query(
      'INSERT INTO sync_jobs (account_id, type, since) VALUES ($1, $2, $3) RETURNING id',
      [accountId, type === 'incremental' && !since ? 'full' : type, since],
    );
    await enqueuePage(rows[0].id, 0, 0);
    logger.info({ accountId, syncJobId: rows[0].id, type }, 'sync started');
    return { id: rows[0].id, created: true };
  } catch (err) {
    if (isUniqueViolation(err)) {
      const a = await pool.query("SELECT id FROM sync_jobs WHERE account_id=$1 AND status IN ('pending','running')", [accountId]);
      return { id: a.rows[0].id, created: false };
    }
    throw err;
  }
}

/** Process ONE page, checkpoint it, enqueue the next. See docs/TECHNICAL.md#synchronization-flow. */
export async function processSyncPage(job: Job<SyncPageData>, token?: string): Promise<Record<string, unknown>> {
  const { syncJobId } = job.data;
  const sj = (await pool.query<SyncJobRow>('SELECT * FROM sync_jobs WHERE id=$1', [syncJobId])).rows[0];
  if (!sj || sj.status === 'completed' || sj.status === 'failed') return { skipped: true };
  if (sj.status === 'pending') {
    await pool.query("UPDATE sync_jobs SET status='running', updated_at=now() WHERE id=$1 AND status='pending'", [syncJobId]);
  }

  const wait = await acquireHubSpotSlot(sj.account_id);
  if (wait > 0) return delayJob(job, token, wait, 'limiter');

  let page;
  try {
    page = await withToken(sj.account_id, (t) =>
      sj.type === 'full'
        ? hubspot.listContacts(t, { after: sj.cursor, limit: config.SYNC_PAGE_SIZE })
        : hubspot.searchModifiedContacts(t, { since: sj.since ?? new Date(0), after: sj.cursor, limit: config.SYNC_PAGE_SIZE }),
    );
  } catch (err) {
    if (err instanceof HubSpotError && err.isRateLimit) return delayJob(job, token, err.retryAfterMs ?? 10_000, 'hubspot_429');
    throw classify(err);
  }

  // Too many changes to page through the search API: do a full sync instead.
  if (sj.type === 'incremental' && !sj.cursor && (page.total ?? 0) > SEARCH_CAP) {
    await pool.query("UPDATE sync_jobs SET status='completed', finished_at=now(), updated_at=now(), last_error='superseded by full sync (>10k changes)' WHERE id=$1", [syncJobId]);
    await startSync(sj.account_id, 'full');
    return { escalated: true };
  }

  const finished = page.next === null;
  const advanced = await tx(async (c) => {
    await upsertContacts(c, sj.account_id, page.contacts);
    // Compare-and-swap on the cursor: if a stalled duplicate of this job already committed this
    // page, we match 0 rows, roll back, and quietly stop. Upserts are idempotent either way.
    const r = await c.query<{ pages: number; run: number }>(
      `UPDATE sync_jobs
          SET cursor=$2::text, pages=pages+1, contacts_synced=contacts_synced+$3,
              status=CASE WHEN $4::boolean THEN 'completed' ELSE 'running' END,
              finished_at=CASE WHEN $4::boolean THEN now() END, last_error=NULL, updated_at=now()
        WHERE id=$1 AND status='running' AND cursor IS NOT DISTINCT FROM $5::text
        RETURNING pages, run`,
      [syncJobId, page.next, page.contacts.length, finished, sj.cursor],
    );
    if (r.rowCount === 0) return null;
    if (finished) {
      await c.query('UPDATE accounts SET sync_watermark=$2, updated_at=now() WHERE id=$1 AND (sync_watermark IS NULL OR sync_watermark < $2)', [
        sj.account_id,
        sj.started_at,
      ]);
    }
    return r.rows[0];
  });

  if (!advanced) return { skipped: 'stale-cursor' };
  // Crash between COMMIT and this line is healed by the stalled-sync sweeper (src/services/maintenance.ts).
  if (!finished) await enqueuePage(syncJobId, advanced.run, advanced.pages);
  return { contacts: page.contacts.length, page: advanced.pages, finished };
}

/** Webhook-triggered refresh of specific contacts. Idempotent; safe to retry or duplicate. */
export async function processRefreshContacts(job: Job<RefreshContactsData>, token?: string): Promise<Record<string, unknown>> {
  const { accountId, hubspotIds } = job.data;
  const wait = await acquireHubSpotSlot(accountId);
  if (wait > 0) return delayJob(job, token, wait, 'limiter');
  try {
    const contacts = await withToken(accountId, (t) => hubspot.batchReadContacts(t, hubspotIds.slice(0, 100)));
    await upsertContacts(pool, accountId, contacts);
    return { refreshed: contacts.length };
  } catch (err) {
    if (err instanceof HubSpotError && err.isRateLimit) return delayJob(job, token, err.retryAfterMs ?? 10_000, 'hubspot_429');
    throw classify(err);
  }
}

export async function markSyncFailed(syncJobId: string, message: string) {
  await pool.query(
    "UPDATE sync_jobs SET status='failed', last_error=$2, finished_at=now(), updated_at=now() WHERE id=$1 AND status IN ('pending','running')",
    [syncJobId, message.slice(0, 1000)],
  );
}

/** Resume the latest failed sync from its checkpoint (cursor is preserved). */
export async function resumeFailedSync(accountId: string): Promise<{ id: string } | null> {
  const failed = (
    await pool.query("SELECT id FROM sync_jobs WHERE account_id=$1 AND status='failed' ORDER BY created_at DESC LIMIT 1", [accountId])
  ).rows[0];
  if (!failed) return null;
  try {
    const { rows } = await pool.query<{ run: number; pages: number }>(
      "UPDATE sync_jobs SET status='running', run=run+1, last_error=NULL, finished_at=NULL, updated_at=now() WHERE id=$1 AND status='failed' RETURNING run, pages",
      [failed.id],
    );
    if (!rows[0]) return null;
    await enqueuePage(failed.id, rows[0].run, rows[0].pages);
    return { id: failed.id };
  } catch (err) {
    if (isUniqueViolation(err)) return null; // another sync became active in the meantime
    throw err;
  }
}
