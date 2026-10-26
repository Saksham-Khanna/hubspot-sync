import IORedis from 'ioredis';
import { config } from './config';
import { logger } from './lib/logger';

// BullMQ requires maxRetriesPerRequest=null (workers issue blocking commands), which means commands
// are queued in memory forever while the connection is down. That behaviour is fine for jobs, but it
// must never be used on the HTTP request path - see `httpRedis` below.
export const redis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: null,
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});
// Without a listener ioredis turns connection failures into uncaught exceptions.
redis.on('error', (err) => logger.error({ err }, 'redis connection error'));

/**
 * Request-path client, used by the HTTP rate limiter. It must fail fast instead of queueing
 * commands: if Redis is unreachable the limiter's `skipOnError` lets the request through, whereas a
 * queued command (maxRetriesPerRequest=null) would leave the HTTP request hanging until timeout.
 */
export const httpRedis = new IORedis(config.REDIS_URL, {
  maxRetriesPerRequest: 1,
  connectTimeout: 2_000,
  enableOfflineQueue: false,
  retryStrategy: (times) => Math.min(times * 500, 5_000),
});
httpRedis.on('error', (err) => logger.warn({ err }, 'redis unavailable for rate limiting'));
