import { FastifyReply, FastifyRequest } from 'fastify';
import { config } from '../config';
import { pool } from '../db';
import { HttpError } from '../lib/errors';

export const SESSION_COOKIE = 'sid';
const THIRTY_DAYS = 30 * 24 * 3600;

declare module 'fastify' {
  interface FastifyRequest {
    accountId?: string;
    rawBody?: string;
  }
}

export function setSession(reply: FastifyReply, accountId: string) {
  reply.setCookie(SESSION_COOKIE, accountId, {
    signed: true,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.NODE_ENV === 'production',
    path: '/',
    maxAge: THIRTY_DAYS,
  });
}

export function readSession(req: FastifyRequest): string | null {
  const raw = req.cookies[SESSION_COOKIE];
  if (!raw) return null;
  const u = req.unsignCookie(raw);
  return u.valid && u.value ? u.value : null;
}

/** preHandler: requires a signed session cookie that points at a non-disconnected account. */
export async function requireAccount(req: FastifyRequest) {
  const id = readSession(req);
  if (!id) throw new HttpError(401, 'Not connected', 'unauthenticated');
  const r = await pool.query("SELECT id FROM accounts WHERE id=$1 AND status <> 'disconnected'", [id]);
  if (!r.rows[0]) throw new HttpError(401, 'Not connected', 'unauthenticated');
  req.accountId = id;
}
