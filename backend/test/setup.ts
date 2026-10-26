// Deterministic env for tests. Integration tests need a real Postgres + Redis:
//   TEST_DATABASE_URL=postgres://app:app@localhost:5432/hubspot_sync_test
//   TEST_REDIS_URL=redis://localhost:6379/1
const e = process.env;
e.NODE_ENV = 'test';
e.LOG_LEVEL = 'silent';
e.DATABASE_URL = e.TEST_DATABASE_URL ?? 'postgres://app:app@localhost:5432/hubspot_sync_test';
e.REDIS_URL = e.TEST_REDIS_URL ?? 'redis://localhost:6379/1';
e.HUBSPOT_CLIENT_ID = 'test-client-id';
e.HUBSPOT_CLIENT_SECRET = 'test-client-secret';
e.HUBSPOT_REDIRECT_URI = 'http://localhost:5173/api/auth/hubspot/callback';
e.FRONTEND_URL = 'http://localhost:5173';
e.COOKIE_SECRET = 'x'.repeat(40);
e.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
e.AUTO_MIGRATE = 'false';
e.HUBSPOT_RATE_LIMIT_MAX = '1000';
