import { buildApp } from './app';
import { config } from './config';
import { pool } from './db';
import { logger } from './lib/logger';
import { migrate } from './migrate';
import { closeQueues } from './queues';
import { httpRedis, redis } from './redis';
import { startWorkers } from './workers';

async function main() {
  if (config.AUTO_MIGRATE) await migrate();
  const app = await buildApp();
  // Single-process mode (cheap hosting). In production run `worker.ts` as a separate, scalable service.
  const workers = config.RUN_WORKERS_IN_API ? startWorkers() : null;

  await app.listen({ port: config.PORT, host: '0.0.0.0' });

  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down api');
    await app.close();
    await workers?.close();
    await closeQueues();
    await pool.end();
    redis.disconnect();
    httpRedis.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void stop('SIGTERM'));
  process.on('SIGINT', () => void stop('SIGINT'));
}

main().catch((err) => {
  logger.error({ err }, 'api crashed on startup');
  process.exit(1);
});
