import { Queue } from 'bullmq';
import { redis } from './redis';

export interface SyncPageData {
  syncJobId: string;
}
export interface RefreshContactsData {
  accountId: string;
  hubspotIds: string[];
}
export interface PushNoteData {
  noteId: string;
}

const defaultJobOptions = {
  attempts: 8,
  // 2s, 4s, 8s ... 4m16s between retries (exponential), BullMQ adds no jitter by default.
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 24 * 3600, count: 5000 },
  // Failed jobs are kept as a dead-letter set for inspection (Bull Board / redis-cli).
  removeOnFail: { age: 14 * 24 * 3600, count: 20000 },
};

export const SYNC_QUEUE = 'sync';
export const NOTES_QUEUE = 'notes';
export const MAINTENANCE_QUEUE = 'maintenance';

export const syncQueue = new Queue(SYNC_QUEUE, { connection: redis, defaultJobOptions });
export const notesQueue = new Queue(NOTES_QUEUE, { connection: redis, defaultJobOptions });
export const maintenanceQueue = new Queue(MAINTENANCE_QUEUE, {
  connection: redis,
  defaultJobOptions: { removeOnComplete: 10, removeOnFail: 50, attempts: 1 },
});

export async function closeQueues() {
  await Promise.all([syncQueue.close(), notesQueue.close(), maintenanceQueue.close()]);
}
