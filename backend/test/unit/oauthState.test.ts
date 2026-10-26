import { describe, expect, it } from 'vitest';
import { diagnoseOAuthState } from '../../src/lib/oauthState';

const ok = {
  hasCode: true,
  hasStateParam: true,
  hasCookie: true,
  cookieSignatureValid: true,
  stateMatches: true,
};

describe('diagnoseOAuthState', () => {
  it('returns ok when every check passes', () => {
    expect(diagnoseOAuthState(ok)).toBe('ok');
  });

  it('reports the provider error first', () => {
    expect(diagnoseOAuthState({ ...ok, providerError: 'access_denied', hasCode: false })).toBe('provider_error');
  });

  it('reports a missing authorization code', () => {
    expect(diagnoseOAuthState({ ...ok, hasCode: false })).toBe('missing_code');
  });

  it('reports a missing state query parameter', () => {
    expect(diagnoseOAuthState({ ...ok, hasStateParam: false })).toBe('missing_state_param');
  });

  it('reports a missing state cookie (cross-host callback)', () => {
    expect(diagnoseOAuthState({ ...ok, hasCookie: false, cookieSignatureValid: false, stateMatches: false })).toBe('missing_state_cookie');
  });

  it('reports a bad cookie signature (wrong or rotated COOKIE_SECRET)', () => {
    expect(diagnoseOAuthState({ ...ok, cookieSignatureValid: false, stateMatches: false })).toBe('state_cookie_bad_signature');
  });

  it('reports a state mismatch (stale tab or a second connect attempt)', () => {
    expect(diagnoseOAuthState({ ...ok, stateMatches: false })).toBe('state_mismatch');
  });
});
