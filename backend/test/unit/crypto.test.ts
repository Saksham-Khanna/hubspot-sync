import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, verifyHubSpotV3Signature } from '../../src/lib/crypto';

const KEY = Buffer.alloc(32, 1).toString('base64');

describe('token encryption (AES-256-GCM)', () => {
  it('round-trips and never repeats ciphertext for the same plaintext', () => {
    const a = encrypt('secret-token', KEY);
    const b = encrypt('secret-token', KEY);
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-token');
    expect(decrypt(a, KEY)).toBe('secret-token');
  });

  it('detects tampering', () => {
    const [v, iv, tag, ct] = encrypt('abc', KEY).split('.');
    const flipped = Buffer.from(ct, 'base64url');
    flipped[0] ^= 1;
    expect(() => decrypt([v, iv, tag, flipped.toString('base64url')].join('.'), KEY)).toThrow();
  });

  it('fails with the wrong key and rejects bad key sizes', () => {
    const enc = encrypt('abc', KEY);
    expect(() => decrypt(enc, Buffer.alloc(32, 2).toString('base64'))).toThrow();
    expect(() => encrypt('abc', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});

describe('HubSpot webhook v3 signature', () => {
  const secret = 's3cret';
  const url = 'https://api.example.com/api/webhooks/hubspot';
  const body = '[{"subscriptionType":"contact.creation","objectId":1,"portalId":9}]';
  const now = 1_700_000_000_000;
  const sign = (ts: string, b = body) => createHmac('sha256', secret).update(`POST${url}${b}${ts}`).digest('base64');

  it('accepts a valid signature', () => {
    const ts = String(now - 1000);
    expect(verifyHubSpotV3Signature({ secret, method: 'POST', url, rawBody: body, timestamp: ts, signature: sign(ts), now })).toBe(true);
  });
  it('rejects tampered body, wrong secret, stale timestamp and missing headers', () => {
    const ts = String(now);
    const base = { secret, method: 'POST', url, rawBody: body, timestamp: ts, signature: sign(ts), now };
    expect(verifyHubSpotV3Signature({ ...base, rawBody: body + ' ' })).toBe(false);
    expect(verifyHubSpotV3Signature({ ...base, secret: 'other' })).toBe(false);
    const old = String(now - 6 * 60 * 1000);
    expect(verifyHubSpotV3Signature({ ...base, timestamp: old, signature: sign(old) })).toBe(false);
    expect(verifyHubSpotV3Signature({ ...base, signature: undefined })).toBe(false);
    expect(verifyHubSpotV3Signature({ ...base, timestamp: undefined })).toBe(false);
  });
});
