// Google OIDC implicit flow (docs/batch-b-spec.md "Login" steps 5 and 6): the authorization request the login popup
// navigates to, and the callback fragment Google returns. Google Identity Services is not used anywhere, and the
// endpoint is hard-coded: a bundle can't be pointed at another identity provider.
import { RELAY_ID_PATTERN } from '@hana-id/core';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** The callback path on authOrigin; the only redirect URI registered on the Google clients. */
export const CALLBACK_PATH = '/login/callback';
/** What the relay may carry for Google's `error` (Google's codes are lowercase snake case). */
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

export interface GoogleAuthRequest {
  clientId: string;
  authOrigin: string;
  nonce: string;
  /** The relayId, also the OAuth `state`. */
  state: string;
  /** Export: `max_age=0`, asking Google to re-authenticate. */
  forceReauth: boolean;
}

/** The authorization URL: id_token in the fragment, `scope=openid` only, with the account chooser. */
export function googleAuthUrl(r: GoogleAuthRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: `${r.authOrigin}${CALLBACK_PATH}`,
    response_type: 'id_token',
    response_mode: 'fragment',
    scope: 'openid',
    nonce: r.nonce,
    state: r.state,
    prompt: 'select_account',
  });
  if (r.forceReauth) params.set('max_age', '0');
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type CallbackFragment =
  | { readonly kind: 'token'; readonly state: string; readonly idToken: string }
  | { readonly kind: 'error'; readonly state: string; readonly error: string }
  /** No usable `state` (missing, malformed or repeated): nothing can be relayed. */
  | { readonly kind: 'no_state' }
  /** A valid `state` but neither a token nor an error (or both): relayed as an error so the vault stops waiting. */
  | { readonly kind: 'malformed'; readonly state: string };

/** Reads `#id_token=…&state=…` or `#error=…&state=…`. Never throws. */
export function parseCallbackFragment(hash: string): CallbackFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const states = params.getAll('state');
  const state = states.length === 1 ? (states[0] as string) : null;
  if (state === null || !RELAY_ID_PATTERN.test(state)) return { kind: 'no_state' };
  const tokens = params.getAll('id_token');
  const errors = params.getAll('error');
  if (tokens.length === 1 && errors.length === 0 && (tokens[0] as string).length > 0) return { kind: 'token', state, idToken: tokens[0] as string };
  if (errors.length === 1 && tokens.length === 0) {
    const error = errors[0] as string;
    return { kind: 'error', state, error: GOOGLE_ERROR.test(error) ? error : 'unknown_error' };
  }
  return { kind: 'malformed', state };
}
