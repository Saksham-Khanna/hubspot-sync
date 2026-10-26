import { config } from '../config';
import { pool } from '../db';
import { logger } from '../lib/logger';
import { enqueueNotePush } from './notes';
import { enqueuePage, startSync } from './sync';

/**
 * Self-healing sweep, run every minute by a BullMQ job scheduler (any worker may run it; it is
 * idempotent). It closes the gaps between "DB committed" and "next job enqueued":
 *
 *  1. Sync chains that stopped (worker died after COMMIT but before enqueueing the next page,
 *     or Redis lost the job): re-enqueue from the checkpoint under a new `run` number.
 *  2. Outbox: notes still pending/syncing after 2 minutes (enqueue failed, worker crashed).
 *  3. Scheduling: periodic incremental sync as a safety net for missed webhooks.
 */
export async function sweep() {
  const stalled = await pool.query<{ id: string; run: number; pages: number }>(
    `UPDATE sync_jobs SET run = run + 1, updated_at = now()
      WHERE status IN ('pending','running') AND updated_at < now() - interval '3 minutes'
      RETURNING id, run, pages`,
  );
  for (const s of stalled.rows) {
    await enqueuePage(s.id, s.run, s.pages);
    logger.warn({ syncJobId: s.id, run: s.run, page: s.pages }, 'stalled sync re-enqueued from checkpoint');
  }

  const notes = await pool.query<{ id: string }>(
    `WITH due AS (
       SELECT id FROM notes
        WHERE (status = 'pending' AND updated_at < now() - interval '2 minutes')
           OR (status = 'syncing' AND locked_at < now() - interval '2 minutes')
        ORDER BY updated_at LIMIT 500
        FOR UPDATE SKIP LOCKED)
     UPDATE notes n SET updated_at = now() FROM due WHERE n.id = due.id RETURNING n.id`,
  );
  for (const n of notes.rows) await enqueueNotePush(n.id);
  if (notes.rowCount) logger.warn({ count: notes.rowCount }, 'outbox notes re-enqueued');

  const due = await pool.query<{ id: string }>(
    `SELECT a.id FROM accounts a
      WHERE a.status = 'connected' AND a.sync_watermark IS NOT NULL
        AND a.sync_watermark < now() - make_interval(mins => $1)
        AND NOT EXISTS (
          SELECT 1 FROM sync_jobs s
           WHERE s.account_id = a.id
             AND (s.status IN ('pending','running') OR s.created_at > now() - make_interval(mins => $1)))
      LIMIT 100`,
    [config.INCREMENTAL_INTERVAL_MIN],
  );
  for (const a of due.rows) await startSync(a.id, 'incremental');

  return { stalledSyncs: stalled.rowCount, notes: notes.rowCount, incremental: due.rowCount };
}
