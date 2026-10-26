import { z } from 'zod';

const bool = z
  .enum(['true', 'false'])
  .transform((v) => v === 'true');

// URLs are stored without a trailing slash: CORS matches origins byte-for-byte and the OAuth
// callback builds redirects as `${FRONTEND_URL}/?...`, which would otherwise produce `//?`.
const url = z
  .string()
  .url()
  .transform((v) => v.replace(/\/+$/, ''));

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(3000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: bool.default('false'),
  DB_POOL_MAX: z.coerce.number().int().default(20),
  // Required: a silent localhost fallback made production hang on an unreachable Redis.
  REDIS_URL: z.string().min(1),

  HUBSPOT_CLIENT_ID: z.string().min(1),
  HUBSPOT_CLIENT_SECRET: z.string().min(1),
  HUBSPOT_REDIRECT_URI: url,
  // Must match the scopes configured on the HubSpot app exactly.
  HUBSPOT_SCOPES: z.string().default('oauth crm.objects.contacts.read crm.objects.contacts.write'),
  HUBSPOT_API_BASE: url.default('https://api.hubapi.com'),
  HUBSPOT_AUTH_URL: url.default('https://app.hubspot.com/oauth/authorize'),
  // Per-portal budget enforced by our Redis limiter (HubSpot publishes its own limit; keep below it).
  HUBSPOT_RATE_LIMIT_MAX: z.coerce.number().int().default(90),
  HUBSPOT_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().default(10_000),
  // Public URL HubSpot calls for webhooks; used when verifying v3 signatures.
  WEBHOOK_PUBLIC_URL: url.optional(),

  FRONTEND_URL: url,
  COOKIE_SECRET: z.string().min(32),
  // 32 random bytes, base64. Generate: openssl rand -base64 32
  TOKEN_ENCRYPTION_KEY: z.string().min(1),

  SYNC_PAGE_SIZE: z.coerce.number().int().min(1).max(100).default(100),
  SYNC_CONCURRENCY: z.coerce.number().int().default(10),
  NOTES_CONCURRENCY: z.coerce.number().int().default(10),
  INCREMENTAL_INTERVAL_MIN: z.coerce.number().int().default(15),

  RUN_WORKERS_IN_API: bool.default('false'),
  AUTO_MIGRATE: bool.default('true'),

  // Global HTTP rate limit per client IP (existing default: 600 requests/minute).
  HTTP_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(600),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join('.')}: ${i.message}`).join('\n');
  throw new Error(`Invalid environment configuration:\n${issues}`);
}

export const config = parsed.data;
export type Config = typeof config;
