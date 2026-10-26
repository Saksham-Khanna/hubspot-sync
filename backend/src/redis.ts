import IORedis from 'ioredis';
import { config } from './config';

// maxRetriesPerRequest must be null for BullMQ workers (blocking commands).
export const redis = new IORedis(config.REDIS_URL, { maxRetriesPerRequest: null });
