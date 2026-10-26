import { Job, UnrecoverableError } from 'bullmq';
import { pool, tx } from '../db';
import { buildNoteHtml, hubspot } from '../hubspot/client';
import { HttpError, HubSpotError, classify } from '../lib/errors';
import { logger } from '../lib/logger';
import { notesPushed } from '../lib/metrics';
import { acquireHubSpotSlot, delayJob } from '../lib/rateLimiter';
import { PushNoteData, addJob, notesQueue } from '../queues';
import { withToken } from './tokens';

export function enqueueNotePush(noteId: string) {
  return addJob(notesQueue, 'push-note', { noteId } satisfies PushNoteData);
}

/**
 * Create a note locally. The INSERT *is* the outbox entry (status='pending'): once the transaction
 * commits the note is durable and will be delivered even if enqueueing below fails, because the
 * outbox sweeper re-enqueues stale pending rows.
 */
export async function createNote(accountId: string, contactId: string, body: string) {
  const note = await tx(async (c) => {
    const contact = await c.query('SELECT id FROM contacts WHERE id=$1 AND account_id=$2 AND deleted_at IS NULL', [contactId, accountId]);
    if (!contact.rows[0]) throw new HttpError(404, 'Contact not found', 'contact_not_found');
    const r = await c.query(
      'INSERT INTO notes (account_id, contact_id, body) VALUES ($1,$2,$3) RETURNING id, contact_id, body, status, hubspot_note_id, last_error, created_at, synced_at',
      [accountId, contactId, body],
    );
    return r.rows[0];
  });
  try {
    await enqueueNotePush(note.id);
  } catch (err) {
    logger.warn({ err, noteId: note.id }, 'enqueue failed; outbox sweeper will pick the note up');
  }
  return note;
}

export async function retryNote(accountId: string, noteId: string): Promise<boolean> {
  const r = await pool.query(
    "UPDATE notes SET status='pending', attempts=0, last_error=NULL, updated_at=now() WHERE id=$1 AND account_id=$2 AND status='failed'",
    [noteId, accountId],
  );
  if (r.rowCount) await enqueueNotePush(noteId);
  return !!r.rowCount;
}

async function releaseClaim(noteId: string) {
  await pool.query("UPDATE notes SET status='pending', attempts=GREATEST(attempts-1,0), locked_at=NULL, updated_at=now() WHERE id=$1 AND status='syncing'", [noteId]);
}

/**
 * Push one note to HubSpot. At-least-once delivery from the queue, made effectively-once by:
 *  1. an atomic DB claim (pending -> syncing) so two workers can't push the same note,
 *  2. persisting hubspot_note_id on success (re-delivery of a synced note is a no-op),
 *  3. on any retry (attempts > 1) first looking for our [ref:<id>] marker in HubSpot, to catch
 *     the "POST succeeded but we crashed before saving the id" case.
 */
export async function processPushNote(job: Job<PushNoteData>, token?: string): Promise<Record<string, unknown>> {
  const { noteId } = job.data;

  // Cheap pre-check so already-synced/failed notes don't burn rate-limit budget.
  const state = (await pool.query('SELECT status FROM notes WHERE id=$1', [noteId])).rows[0];
  if (!state || state.status === 'synced' || state.status === 'failed') return { skipped: state?.status ?? 'missing' };

  const claimed = (
    await pool.query(
      `UPDATE notes n SET status='syncing', locked_at=now(), attempts=n.attempts+1, updated_at=now()
         FROM contacts c
        WHERE n.id=$1 AND c.id=n.contact_id
          AND (n.status='pending' OR (n.status='syncing' AND n.locked_at < now() - interval '2 minutes'))
        RETURNING n.id, n.account_id, n.body, n.attempts, n.created_at, n.hubspot_note_id, c.hubspot_id AS contact_hubspot_id`,
      [noteId],
    )
  ).rows[0];
  if (!claimed) return { skipped: 'claimed-elsewhere' };

  const checkExisting = claimed.attempts > 1;
  const wait = await acquireHubSpotSlot(claimed.account_id, checkExisting ? 3 : 1);
  if (wait > 0) {
    await releaseClaim(noteId);
    return delayJob(job, token, wait, 'limiter');
  }

  try {
    let hubspotNoteId: string | null = claimed.hubspot_note_id;
    if (!hubspotNoteId && checkExisting) {
      hubspotNoteId = await withToken(claimed.account_id, (t) => hubspot.findNoteByRef(t, claimed.contact_hubspot_id, claimed.id));
    }
    if (!hubspotNoteId) {
      hubspotNoteId = await withToken(claimed.account_id, (t) =>
        hubspot.createNote(t, claimed.contact_hubspot_id, buildNoteHtml(claimed.body, claimed.id), claimed.created_at),
      );
    }
    await pool.query(
      "UPDATE notes SET status='synced', hubspot_note_id=$2, synced_at=now(), last_error=NULL, locked_at=NULL, updated_at=now() WHERE id=$1",
      [noteId, hubspotNoteId],
    );
    notesPushed.inc({ outcome: 'synced' });
    return { synced: true, hubspotNoteId };
  } catch (err) {
    if (err instanceof HubSpotError && err.isRateLimit) {
      await releaseClaim(noteId);
      return delayJob(job, token, err.retryAfterMs ?? 10_000, 'hubspot_429');
    }
    const classified = classify(err);
    const permanent = classified instanceof UnrecoverableError;
    notesPushed.inc({ outcome: permanent ? 'failed_permanent' : 'retry' });
    // Retryable: back to pending so the next attempt can claim it. Permanent: terminal 'failed'.
    await pool.query(
      "UPDATE notes SET status=$2, last_error=$3, locked_at=NULL, updated_at=now() WHERE id=$1",
      [noteId, permanent ? 'failed' : 'pending', classified.message.slice(0, 1000)],
    );
    throw classified;
  }
}

export async function markNoteFailed(noteId: string, message: string) {
  await pool.query("UPDATE notes SET status='failed', last_error=$2, locked_at=NULL, updated_at=now() WHERE id=$1 AND status<>'synced'", [noteId, message.slice(0, 1000)]);
}
