import { config } from '../config';
import { decrypt, encrypt } from '../lib/crypto';
import { pool, tx } from '../db';
import { hubspot } from '../hubspot/client';
import { HubSpotError, ReauthRequiredError } from '../lib/errors';

const SKEW_MS = 60_000; // refresh a minute early so a token never expires mid-request

interface AccountTokenRow {
  status: string;
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  token_expires_at: Date | null;
}

const fresh = (a: AccountTokenRow) => !!a.token_expires_at && a.token_expires_at.getTime() - Date.now() > SKEW_MS;

export async function saveTokens(
  accountId: string,
  t: { access_token: string; refresh_token: string; expires_in: number },
  db: Pick<typeof pool, 'query'> = pool,
) {
  await db.query(
    `UPDATE accounts SET access_token_enc=$2, refresh_token_enc=$3, token_expires_at=now() + make_interval(secs => $4),
            status='connected', updated_at=now() WHERE id=$1`,
    [accountId, encrypt(t.access_token, config.TOKEN_ENCRYPTION_KEY), encrypt(t.refresh_token, config.TOKEN_ENCRYPTION_KEY), t.expires_in],
  );
}

/**
 * Returns a valid access token, refreshing if needed.
 *
 * Concurrency: refreshing happens inside a transaction holding `SELECT ... FOR UPDATE` on the
 * account row, so only one worker refreshes at a time. Workers that were waiting re-check after
 * acquiring the lock and reuse the token the winner stored (no double refresh).
 *
 * `rejectedToken`: pass the token HubSpot just answered 401 to; we then refresh even if our
 * clock thinks it is still valid (revoked / clock skew), unless someone already replaced it.
 */
export async function getAccessToken(accountId: string, opts: { rejectedToken?: string } = {}): Promise<string> {
  const { rows } = await pool.query<AccountTokenRow>(
    'SELECT status, access_token_enc, refresh_token_enc, token_expires_at FROM accounts WHERE id=$1',
    [accountId],
  );
  const a = rows[0];
  if (!a || a.status === 'disconnected' || !a.access_token_enc) throw new ReauthRequiredError('Account is not connected');
  if (a.status === 'needs_reauth') throw new ReauthRequiredError();
  const current = decrypt(a.access_token_enc, config.TOKEN_ENCRYPTION_KEY);
  if (fresh(a) && current !== opts.rejectedToken) return current;

  const outcome = await tx<{ token: string } | { reauth: true }>(async (c) => {
    const locked = (
      await c.query<AccountTokenRow>(
        'SELECT status, access_token_enc, refresh_token_enc, token_expires_at FROM accounts WHERE id=$1 FOR UPDATE',
        [accountId],
      )
    ).rows[0];
    if (!locked || locked.status !== 'connected' || !locked.access_token_enc || !locked.refresh_token_enc) return { reauth: true };

    // Someone else refreshed while we waited for the lock.
    const latest = decrypt(locked.access_token_enc, config.TOKEN_ENCRYPTION_KEY);
    if (fresh(locked) && latest !== opts.rejectedToken) return { token: latest };

    try {
      const t = await hubspot.refreshToken(decrypt(locked.refresh_token_enc, config.TOKEN_ENCRYPTION_KEY));
      await saveTokens(accountId, t, c);
      return { token: t.access_token };
    } catch (err) {
      // 400/401/403 from the token endpoint: refresh token revoked or app uninstalled.
      if (err instanceof HubSpotError && [400, 401, 403].includes(err.status)) {
        await c.query("UPDATE accounts SET status='needs_reauth', updated_at=now() WHERE id=$1", [accountId]);
        return { reauth: true };
      }
      throw err; // 5xx / network: retryable, transaction rolls back, lock released
    }
  });

  if ('reauth' in outcome) throw new ReauthRequiredError();
  return outcome.token;
}

/** Run a HubSpot call with a valid token; on a 401, refresh once and retry. */
export async function withToken<T>(accountId: string, fn: (token: string) => Promise<T>): Promise<T> {
  const token = await getAccessToken(accountId);
  try {
    return await fn(token);
  } catch (err) {
    if (err instanceof HubSpotError && err.isUnauthorized) {
      const next = await getAccessToken(accountId, { rejectedToken: token });
      return fn(next);
    }
    throw err;
  }
}
