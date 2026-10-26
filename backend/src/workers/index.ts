import { Job, UnrecoverableError, Worker } from 'bullmq';
import { config } from '../config';
import { logger } from '../lib/logger';
import { jobDuration } from '../lib/metrics';
import { MAINTENANCE_QUEUE, NOTES_QUEUE, SYNC_QUEUE, maintenanceQueue } from '../queues';
import { redis } from '../redis';
import { sweep } from '../services/maintenance';
import { markNoteFailed, processPushNote } from '../services/notes';
import { markSyncFailed, processRefreshContacts, processSyncPage } from '../services/sync';

/** Wraps a processor with timing metrics and structured logs. */
function instrument<T extends Job>(fn: (job: T, token?: string) => Promise<unknown>) {
  return async (job: T, token?: string) => {
    const end = jobDuration.startTimer({ job: job.name });
    try {
      const out = await fn(job, token);
      end({ outcome: 'ok' });
      logger.debug({ job: job.name, id: job.id, out }, 'job done');
      return out;
    } catch (err) {
      end({ outcome: (err as Error).name === 'DelayedError' ? 'delayed' : 'error' });
      throw err;
    }
  };
}

// True when BullMQ will not retry this job again.
const isFinalFailure = (job: Job, err: Error) => err instanceof UnrecoverableError || job.attemptsMade >= (job.opts.attempts ?? 1);

export function startWorkers() {
  const syncWorker = new Worker(
    SYNC_QUEUE,
    instrument(async (job, token) => {
      switch (job.name) {
        case 'sync-page':
          return processSyncPage(job, token);
        case 'refresh-contacts':
          return processRefreshContacts(job, token);
        default:
          throw new UnrecoverableError(`unknown job ${job.name}`);
      }
    }),
    { connection: redis, concurrency: config.SYNC_CONCURRENCY },
  );
  syncWorker.on('failed', (job, err) => {
    if (!job) return;
    logger.error({ job: job.name, id: job.id, attempt: job.attemptsMade, err: err.message }, 'sync job failed');
    if (job.name === 'sync-page' && isFinalFailure(job, err)) {
      markSyncFailed(job.data.syncJobId, err.message).catch((e) => logger.error({ e }, 'markSyncFailed failed'));
    }
  });

  const notesWorker = new Worker(NOTES_QUEUE, instrument(processPushNote), { connection: redis, concurrency: config.NOTES_CONCURRENCY });
  notesWorker.on('failed', (job, err) => {
    if (!job) return;
    logger.error({ job: job.name, id: job.id, attempt: job.attemptsMade, err: err.message }, 'note push failed');
    if (isFinalFailure(job, err)) markNoteFailed(job.data.noteId, err.message).catch((e) => logger.error({ e }, 'markNoteFailed failed'));
  });

  const maintenanceWorker = new Worker(
    MAINTENANCE_QUEUE,
    instrument(async () => sweep()),
    { connection: redis, concurrency: 1 },
  );
  maintenanceWorker.on('failed', (_j, err) => logger.error({ err: err.message }, 'sweep failed'));

  for (const w of [syncWorker, notesWorker, maintenanceWorker]) w.on('error', (err) => logger.error({ err: err.message }, 'worker error'));

  // One scheduler definition shared by every process (upsert by id => no duplicates).
  maintenanceQueue.upsertJobScheduler('sweep', { every: 60_000 }, { name: 'sweep' }).catch((err) => logger.error({ err }, 'could not schedule sweep'));

  return {
    async close() {
      // Waits for in-flight jobs to finish; unfinished ones are retried by BullMQ via stall detection.
      await Promise.all([syncWorker.close(), notesWorker.close(), maintenanceWorker.close()]);
    },
  };
}
