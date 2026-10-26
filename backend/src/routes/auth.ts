import { randomBytes } from 'node:crypto';
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { config } from '../config';
import { pool } from '../db';
import { hubspot } from '../hubspot/client';
import { encrypt } from '../lib/crypto';
import { logger } from '../lib/logger';
import { diagnoseOAuthState } from '../lib/oauthState';
import { startSync } from '../services/sync';
import { SESSION_COOKIE, readSession, setSession } from './session';

const STATE_COOKIE = 'oauth_state';
const STATE_PATH = '/api/auth';

const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

// Safe diagnostics: origins are public, but the state value, code, cookies and tokens never are.
const requestOrigin = (req: { protocol: string; hostname: string }) => `${req.protocol}://${req.hostname}`;
const redirectOrigin = new URL(config.HUBSPOT_REDIRECT_URI).origin;

export async function authRoutes(app: FastifyInstance) {
  // Step 1: the "Connect HubSpot" button navigates here. We mint a random `state`, remember it in a
  // signed httpOnly cookie and send the browser to HubSpot's consent screen.
  app.get('/auth/hubspot/start', async (req, reply) => {
    const state = randomBytes(24).toString('base64url');
    req.log.info(
      { requestOrigin: requestOrigin(req), redirectOrigin, secureCookie: config.NODE_ENV === 'production', cookiePath: STATE_PATH },
      'oauth start issued',
    );
    reply.setCookie(STATE_COOKIE, state, {
      signed: true,
      httpOnly: true,
      sameSite: 'lax',
      secure: config.NODE_ENV === 'production',
      path: STATE_PATH,
      maxAge: 600,
    });
    return reply.redirect(hubspot.buildAuthorizeUrl(state));
  });

  // Step 2: HubSpot redirects back with ?code&state.
  app.get('/auth/hubspot/callback', async (req, reply) => {
    const back = (qs: string) => reply.redirect(`${config.FRONTEND_URL}/?${qs}`);
    const q = callbackQuery.parse(req.query);

    const cookie = req.cookies[STATE_COOKIE];
    const unsigned = cookie ? req.unsignCookie(cookie) : null;
    const signatureValid = unsigned?.valid === true;
    const stateMatches = Boolean(q.state) && signatureValid && unsigned?.value === q.state;
    const failure = diagnoseOAuthState({
      providerError: q.error,
      hasCode: Boolean(q.code),
      hasStateParam: Boolean(q.state),
      hasCookie: Boolean(cookie),
      cookieSignatureValid: signatureValid,
      stateMatches,
    });

    reply.clearCookie(STATE_COOKIE, { path: STATE_PATH });

    if (failure !== 'ok') {
      // `missing_state_cookie` here usually means the callback host differs from the host that
      // served /auth/hubspot/start: the cookie is host-only, so a cross-host redirect loses it.
      req.log.warn(
        {
          reason: failure,
          requestOrigin: requestOrigin(req),
          redirectOrigin,
          hasStateParam: Boolean(q.state),
          hasCookie: Boolean(cookie),
          cookieSignatureValid: signatureValid,
          stateMatches,
        },
        'oauth callback rejected',
      );
      if (failure === 'provider_error') return back(`auth_error=${encodeURIComponent(q.error!)}`);
      return back('auth_error=invalid_state');
    }

    req.log.info({ requestOrigin: requestOrigin(req), redirectOrigin }, 'oauth callback state validated');

    try {
      const tokens = await hubspot.exchangeCode(q.code!);
      const info = await hubspot.getTokenInfo(tokens.access_token);
      const { rows } = await pool.query<{ id: string }>(
        `INSERT INTO accounts (hub_id, hub_domain, user_email, status, access_token_enc, refresh_token_enc, token_expires_at, scopes)
         VALUES ($1, $2, $3, 'connected', $4, $5, now() + make_interval(secs => $6), $7)
         ON CONFLICT (hub_id) DO UPDATE SET
           hub_domain = EXCLUDED.hub_domain, user_email = EXCLUDED.user_email, status = 'connected',
           access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
           token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, updated_at = now()
         RETURNING id`,
        [
          info.hub_id,
          info.hub_domain ?? null,
          info.user ?? null,
          encrypt(tokens.access_token, config.TOKEN_ENCRYPTION_KEY),
          encrypt(tokens.refresh_token, config.TOKEN_ENCRYPTION_KEY),
          tokens.expires_in,
          info.scopes ?? [],
        ],
      );
      const accountId = rows[0].id;
      // Automatic synchronisation: no button. Reconnects resume incrementally from the watermark.
      await startSync(accountId);
      setSession(reply, accountId);
      return back('connected=1');
    } catch (err) {
      logger.error({ err }, 'oauth callback failed');
      return back('auth_error=exchange_failed');
    }
  });

  app.get('/auth/status', async (req) => {
    const id = readSession(req);
    const empty = { connected: false as const };
    if (!id) return empty;
    const { rows } = await pool.query(
      'SELECT id, hub_id, hub_domain, user_email, status, token_expires_at, sync_watermark FROM accounts WHERE id=$1',
      [id],
    );
    const a = rows[0];
    if (!a || a.status === 'disconnected') return empty;
    return {
      connected: a.status === 'connected',
      needsReauth: a.status === 'needs_reauth',
      hubId: a.hub_id,
      hubDomain: a.hub_domain,
      userEmail: a.user_email,
      lastSyncedAt: a.sync_watermark,
    };
  });

  app.post('/auth/disconnect', async (req, reply) => {
    const id = readSession(req);
    if (id) {
      await pool.query(
        "UPDATE accounts SET status='disconnected', access_token_enc=NULL, refresh_token_enc=NULL, token_expires_at=NULL, updated_at=now() WHERE id=$1",
        [id],
      );
      await pool.query(
        "UPDATE sync_jobs SET status='failed', last_error='disconnected', finished_at=now(), updated_at=now() WHERE account_id=$1 AND status IN ('pending','running')",
        [id],
      );
    }
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });
}
