import pino from 'pino';
import { config } from '../config';

// Fastify ships pino; we reuse it so API and worker logs share one JSON format.
export const logger = pino({
  level: config.LOG_LEVEL,
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.access_token', '*.refresh_token'],
});
