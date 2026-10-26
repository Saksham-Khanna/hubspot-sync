import IORedis from 'ioredis';
import { config } from './config';
import { logger } from './lib/logger';

// BullMQ requires maxRetriesPerRequest=null (workers issue blocking commands), which means commands
// are queued in memory forever while the connection is down. That behaviour is fine for jobs, but it
// must never be used on the HTTP request path - see `httpRedis` below.
export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  connectTimeout: 5_000,
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});
// Without a listener ioredis turns connection failures into uncaught exceptions.
redis.on('error', (err) => logger.error({ err }, 'redis connection error'));

/**
 * Request-path client, used by the HTTP rate limiter (and the readiness probe). It must fail fast
 * instead of queueing commands: a queued command (maxRetriesPerRequest=null) would leave every HTTP
 * request hanging until the client timeout. `enableOfflineQueue: false` makes commands reject
 * immediately while disconnected; `app.ts` turns that state into a fast 503 for non-liveness routes.
 */
export const httpRedis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});
httpRedis.on('error', (err) => logger.warn({ err }, 'redis unavailable for rate limiting'));
