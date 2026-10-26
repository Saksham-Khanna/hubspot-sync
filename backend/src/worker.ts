import { config } from './config';
import { pool } from './db';
import { logger } from './lib/logger';
import { migrate } from './migrate';
import { closeQueues } from './queues';
import { redis } from './redis';
import { startWorkers } from './workers';

async function main() {
  if (config.AUTO_MIGRATE) {
    try {
      await migrate();
    } catch (err) {
      logger.error({ err }, 'startup failed: could not reach Postgres or apply migrations (check DATABASE_URL)');
      throw err;
    }
  }
  const workers = startWorkers();
  logger.info({ sync: config.SYNC_CONCURRENCY, notes: config.NOTES_CONCURRENCY }, 'worker started');

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down worker');
    await workers.close();
    await closeQueues();
    await pool.end();
    redis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'worker crashed on startup');
  process.exit(1);
});
