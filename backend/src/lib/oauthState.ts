/**
 * Classifies why an OAuth callback failed the state/CSRF check. Pure (no I/O) so it can be unit
 * tested. Callers log the returned reason plus request/redirect origins - never the state value,
 * the authorization code, cookies or tokens.
 */
export type OAuthStateFailure =
  | 'provider_error'
  | 'missing_code'
  | 'missing_state_param'
  | 'missing_state_cookie'
  | 'state_cookie_bad_signature'
  | 'state_mismatch';

export interface OAuthStateInput {
  providerError?: string;
  hasCode: boolean;
  hasStateParam: boolean;
  hasCookie: boolean;
  cookieSignatureValid: boolean;
  stateMatches: boolean;
}

export function diagnoseOAuthState(input: OAuthStateInput): OAuthStateFailure | 'ok' {
  if (input.providerError) return 'provider_error';
  if (!input.hasCode) return 'missing_code';
  if (!input.hasStateParam) return 'missing_state_param';
  if (!input.hasCookie) return 'missing_state_cookie';
  if (!input.cookieSignatureValid) return 'state_cookie_bad_signature';
  if (!input.stateMatches) return 'state_mismatch';
  return 'ok';
}
