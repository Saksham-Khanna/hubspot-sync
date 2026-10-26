import pg from 'pg';
import { config } from './config';

// bigint (int8) -> number. Our counters and hub ids are far below 2^53.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  max: config.DB_POOL_MAX,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
});

export type Queryable = Pick<pg.Pool | pg.PoolClient, 'query'>;

/** Run `fn` in a transaction; commits on success, rolls back on any throw. */
export async function tx<T>(fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}
