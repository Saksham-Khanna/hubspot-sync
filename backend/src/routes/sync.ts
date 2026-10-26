import { FastifyInstance } from 'fastify';
import { pool } from '../db';
import { HttpError } from '../lib/errors';
import { syncQueue, withQueueTimeout } from '../queues';
import { resumeFailedSync, startSync } from '../services/sync';
import { requireAccount } from './session';

const JOB_COLS = 'id, type, status, pages, contacts_synced, last_error, started_at, finished_at, updated_at';

export async function syncRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAccount);

  app.get('/sync/status', async (req) => {
    const id = req.accountId!;
    const [latest, contacts, notes, queue] = await Promise.all([
      pool.query(`SELECT ${JOB_COLS} FROM sync_jobs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 1`, [id]),
      pool.query('SELECT count(*)::int AS n FROM contacts WHERE account_id=$1 AND deleted_at IS NULL', [id]),
      pool.query('SELECT status, count(*)::int AS n FROM notes WHERE account_id=$1 GROUP BY status', [id]),
      withQueueTimeout(syncQueue.getJobCounts('waiting', 'active', 'delayed', 'failed'), 'queue.getJobCounts'),
    ]);
    const noteCounts: Record<string, number> = { pending: 0, syncing: 0, synced: 0, failed: 0 };
    for (const r of notes.rows) noteCounts[r.status] = r.n;
    return { latest: latest.rows[0] ?? null, contacts: contacts.rows[0].n, notes: noteCounts, queue };
  });

  app.get('/sync/jobs', async (req) => {
    const { rows } = await pool.query(`SELECT ${JOB_COLS} FROM sync_jobs WHERE account_id=$1 ORDER BY created_at DESC LIMIT 10`, [req.accountId]);
    return { data: rows };
  });

  // Not a "sync contacts" button: recovery for a sync that exhausted its retries. Resumes from the
  // stored cursor; falls back to starting a fresh incremental/full run if nothing failed.
  app.post('/sync/retry', async (req, reply) => {
    const resumed = await resumeFailedSync(req.accountId!);
    if (resumed) return reply.code(202).send({ resumed: true, id: resumed.id });
    const started = await startSync(req.accountId!);
    if (!started.created) throw new HttpError(409, 'A sync is already running', 'sync_active');
    return reply.code(202).send({ resumed: false, id: started.id });
  });
}
