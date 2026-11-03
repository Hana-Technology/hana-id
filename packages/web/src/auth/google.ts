// Google OIDC implicit flow (docs/batch-b-spec.md "Login" steps 5 and 6): the authorization request the login popup
// navigates to, and the callback fragment Google returns. Google Identity Services is not used anywhere, and the
// endpoint is hard-coded: a bundle can't be pointed at another identity provider.
//
// Google's verified email (docs/email-login-spec.md "How the popup gets Google's verified email", build plan batch 8b),
// only in a login of an app with email: the vault's google-match needs an access token for the `email` scope, while
// the token that goes on chain must stay openid-only (D25). Two ways, chosen by GOOGLE_EMAIL_FLOW:
//   - 'second_request' (the default, the spec's fallback; works whatever the spike finds): the login's request stays
//     `response_type=id_token`, `scope=openid`; after it the callback makes a second, silent request
//     (`response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>`) and relays the access token in the
//     follow-up channel's slot 1. When Google needs the user for it (`consent_required`, `interaction_required`,
//     `login_required`: the first time the app asks for the email scope), it asks once more without `prompt=none`.
//   - 'one_request': one request, `response_type=id_token token`, `scope=openid email`. Only if the spike
//     (apps/smoke/spike-email.html) shows Google leaves `email` out of that ID token; if it doesn't, the vault and the
//     API refuse the login (`token_has_pii`), so a wrong switch can never put the address on chain.
import { RELAY_ID_PATTERN } from '@hana-id/core';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** The callback path on authOrigin; the only redirect URI registered on the Google clients. */
export const CALLBACK_PATH = '/login/callback';
/** What the relay may carry for Google's `error` (Google's codes are lowercase snake case). */
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

export type GoogleEmailFlow = 'second_request' | 'one_request';
/** How the popup asks Google for the email scope (above). Changed only by a reviewed code change, after the spike. */
export const GOOGLE_EMAIL_FLOW: GoogleEmailFlow = 'second_request';
/** The silent request's errors that mean "Google needs the user": the callback asks once more, interactively. */
export const SILENT_ERRORS: ReadonlySet<string> = new Set(['consent_required', 'interaction_required', 'login_required', 'account_selection_required']);

export interface GoogleAuthRequest {
  clientId: string;
  authOrigin: string;
  nonce: string;
  /** The relay slot's id, also the OAuth `state`. */
  state: string;
  /** Export: `max_age=0`, asking Google to re-authenticate. */
  forceReauth: boolean;
  /** One-request mode in a login of an app with email: `id_token token`, `scope=openid email`. */
  withEmailScope?: boolean;
  /** A proof the vault asks for (a link method's): the Google account to use (a `sub`), no account chooser. */
  loginHint?: string | null;
}

/** The authorization URL: id_token in the fragment, `scope=openid` only (unless `withEmailScope`), the account chooser. */
export function googleAuthUrl(r: GoogleAuthRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: `${r.authOrigin}${CALLBACK_PATH}`,
    response_type: r.withEmailScope ? 'id_token token' : 'id_token',
    response_mode: 'fragment',
    scope: r.withEmailScope ? 'openid email' : 'openid',
    nonce: r.nonce,
    state: r.state,
  });
  if (r.loginHint) params.set('login_hint', r.loginHint);
  else params.set('prompt', 'select_account');
  if (r.forceReauth) params.set('max_age', '0');
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleAccessRequest {
  clientId: string;
  authOrigin: string;
  /** The follow-up slot the access token goes to, also the OAuth `state`. */
  state: string;
  /** The ID token's `sub`: the account that just signed in. */
  loginHint: string;
  /** False after a silent attempt Google answered with SILENT_ERRORS. */
  silent: boolean;
}

/** The second request (two-request mode): an access token for `email` only, for the account that just signed in. */
export function googleAccessUrl(r: GoogleAccessRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: `${r.authOrigin}${CALLBACK_PATH}`,
    response_type: 'token',
    response_mode: 'fragment',
    scope: 'email',
    login_hint: r.loginHint,
    state: r.state,
  });
  if (r.silent) params.set('prompt', 'none');
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type CallbackFragment =
  /** An ID token, and in one-request mode an access token beside it. */
  | { readonly kind: 'token'; readonly state: string; readonly idToken: string; readonly accessToken: string | null }
  /** Only an access token (the second request's answer). */
  | { readonly kind: 'access'; readonly state: string; readonly accessToken: string }
  | { readonly kind: 'error'; readonly state: string; readonly error: string }
  /** No usable `state` (missing, malformed or repeated): nothing can be relayed. */
  | { readonly kind: 'no_state' }
  /** A valid `state` but neither a token nor an error (or both): relayed as an error so the vault stops waiting. */
  | { readonly kind: 'malformed'; readonly state: string };

const ACCESS_TOKEN = /^[\x21-\x7e]{1,2048}$/u;

/** Reads `#id_token=…&state=…`, `#access_token=…&state=…` (with `id_token` in one-request mode) or `#error=…&state=…`. Never throws. */
export function parseCallbackFragment(hash: string): CallbackFragment {
  const params = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const states = params.getAll('state');
  const state = states.length === 1 ? (states[0] as string) : null;
  if (state === null || !RELAY_ID_PATTERN.test(state)) return { kind: 'no_state' };
  const tokens = params.getAll('id_token');
  const access = params.getAll('access_token');
  const errors = params.getAll('error');
  if (access.length > 1 || (access.length === 1 && !ACCESS_TOKEN.test(access[0] as string))) return { kind: 'malformed', state };
  const accessToken = access.length === 1 ? (access[0] as string) : null;
  if (tokens.length === 1 && errors.length === 0 && (tokens[0] as string).length > 0) return { kind: 'token', state, idToken: tokens[0] as string, accessToken };
  if (tokens.length === 0 && errors.length === 0 && accessToken !== null) return { kind: 'access', state, accessToken };
  if (errors.length === 1 && tokens.length === 0 && accessToken === null) {
    const error = errors[0] as string;
    return { kind: 'error', state, error: GOOGLE_ERROR.test(error) ? error : 'unknown_error' };
  }
  return { kind: 'malformed', state };
}

/** The `sub` of a Google ID token, read without any check: only a `login_hint` for the second request. */
export function unverifiedSub(idToken: string): string | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (part.length % 4)) % 4));
    const sub = (JSON.parse(json) as { sub?: unknown }).sub;
    return typeof sub === 'string' && /^[0-9A-Za-z_-]{1,255}$/u.test(sub) ? sub : null;
  } catch {
    return null;
  }
}
