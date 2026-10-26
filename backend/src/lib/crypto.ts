import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const VERSION = 'v1';

function parseKey(b64: string): Buffer {
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  return key;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (all base64url). Fresh random IV per call. */
export function encrypt(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', parseKey(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

export function decrypt(payload: string, keyB64: string): string {
  const [v, iv, tag, ct] = payload.split('.');
  if (v !== VERSION || !iv || !tag || !ct) throw new Error('Unsupported ciphertext format');
  const decipher = createDecipheriv('aes-256-gcm', parseKey(keyB64), Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * HubSpot webhook signature v3: base64(HMAC-SHA256(secret, method + uri + body + timestamp)).
 * Rejects requests older than 5 minutes (replay protection).
 */
export function verifyHubSpotV3Signature(args: {
  secret: string;
  method: string;
  url: string;
  rawBody: string;
  timestamp: string | undefined;
  signature: string | undefined;
  now?: number;
}): boolean {
  const { secret, method, url, rawBody, timestamp, signature, now = Date.now() } = args;
  if (!timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > 5 * 60 * 1000) return false;
  const expected = createHmac('sha256', secret).update(`${method.toUpperCase()}${url}${rawBody}${timestamp}`).digest();
  let given: Buffer;
  try {
    given = Buffer.from(signature, 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
