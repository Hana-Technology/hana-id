// Google OIDC implicit flow (docs/batch-b-spec.md "Login" steps 5 and 6): the authorization requests the login popup
// navigates to, and the callback fragment Google returns. Google Identity Services is not used anywhere, and the
// endpoints are hard-coded: a bundle can't be pointed at another identity provider.
//
// Google's verified email (docs/email-login-spec.md "How the popup gets Google's verified email", build plan batch 8b;
// D254, D264, D270, D273): the email issuer needs an access token for the `email` scope, while the ID token that goes
// on chain must stay openid-only (D25). How the popup gets it is GOOGLE_EMAIL_FLOW, a code constant:
//   - 'second_request' (the fallback, kept tested): only in a login of an app with email. The login's request stays
//     `response_type=id_token`, `scope=openid`; after it the callback makes a second, silent request
//     (`response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>`) and relays the access token in the
//     follow-up channel's slot 1. When Google needs the user for it (SILENT_ERRORS: the first time the app asks for
//     the email scope), Hana's explainer, then once more without `prompt=none` (D264).
//   - 'token_first' (in force since 2026-11-04, after the spike passed, D270): every Google login of an env with an email
//     issuer (apps without email login too: the issuer's directory only, D269). The login's request is
//     `response_type=token`, `scope=openid email` with the account chooser, so Google's one sign-in screen lists the
//     email. The callback reads the access token's client and `sub` from tokeninfo (`accessTokenSub`), relays the
//     access token to slot 1, then makes a silent `response_type=id_token`, `scope=openid`, `prompt=none`,
//     `login_hint=<sub>` request with the login's nonce; only that ID token is relayed for the chain. A silent failure
//     gets one interactive openid-only retry for the same account (D273); an ID token of another account ends the
//     login (`google_account_mismatch`).
// Whatever the flow, the request whose ID token is relayed asks for `scope=openid` only (`googleAuthUrl` can build
// nothing else), and the callback, the vault and the API refuse an ID token with a claim outside the allow-list
// (`token_has_pii`), so a Google change can lock logins out but never put the address on chain. `'one_request'`
// (`id_token token`, `openid email`) is gone (D273): Google puts `email` in that ID token (D270).
import { RELAY_ID_PATTERN } from '@hana-id/core';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** Google's tokeninfo: the access token's client and `sub`, POSTed from the callback under token_first. */
export const GOOGLE_TOKENINFO_URL = 'https://oauth2.googleapis.com/tokeninfo';
/** Its origin: the callback page's connect-src in an env with an email issuer (auth/pages.ts, apps/api pages/host.ts). */
export const GOOGLE_TOKENINFO_ORIGIN = 'https://oauth2.googleapis.com';
/** The callback path on authOrigin; the only redirect URI registered on the Google clients. */
export const CALLBACK_PATH = '/login/callback';
/** What the relay may carry for Google's `error` (Google's codes are lowercase snake case). */
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

export type GoogleEmailFlow = 'second_request' | 'token_first';
/**
 * How the popup asks Google for the email scope (above). Changed only by a reviewed one-line change: 'token_first'
 * since the user's spike run passed every leg on 2026-11-04 (apps/smoke/spike-email.html, D270); 'second_request'
 * stays built and tested as the fallback. The pages and the vault take the flow as a dependency (`googleEmailFlow`),
 * so the tests run every flow; this constant is only the default.
 */
export const GOOGLE_EMAIL_FLOW: GoogleEmailFlow = 'token_first';
/** The silent request's errors that mean "Google needs the user": the callback asks once more, interactively. */
export const SILENT_ERRORS: ReadonlySet<string> = new Set(['consent_required', 'interaction_required', 'login_required', 'account_selection_required']);

/**
 * Whether a login's own Google request starts with the email access token (token_first): only a login that carries
 * the follow-up key, never a link task's or a proof's request, nor the export window's (it has no follow-up key).
 */
export const startsWithAccessToken = (flow: GoogleEmailFlow, o: { follow: boolean; task: boolean }): boolean => flow === 'token_first' && o.follow && !o.task;

export interface GoogleAuthRequest {
  clientId: string;
  authOrigin: string;
  nonce: string;
  /** The relay slot's id, also the OAuth `state`. */
  state: string;
  /** Export: `max_age=0`, asking Google to re-authenticate. */
  forceReauth: boolean;
  /** The Google account to use (a `sub`), no account chooser: a proof the vault asks for, token_first's ID request. */
  loginHint?: string | null;
  /** With `loginHint`: `prompt=none` (token_first's silent ID request). */
  silent?: boolean;
}

/**
 * An ID token request: `response_type=id_token`, `scope=openid` and nothing else, in every flow (D25). It is the only
 * builder of a request whose answer is relayed for the chain. The account chooser, or `login_hint` (with
 * `prompt=none` when `silent`).
 */
export function googleAuthUrl(r: GoogleAuthRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: `${r.authOrigin}${CALLBACK_PATH}`,
    response_type: 'id_token',
    response_mode: 'fragment',
    scope: 'openid',
    nonce: r.nonce,
    state: r.state,
  });
  if (r.loginHint) {
    params.set('login_hint', r.loginHint);
    if (r.silent) params.set('prompt', 'none');
  } else {
    params.set('prompt', 'select_account');
  }
  if (r.forceReauth) params.set('max_age', '0');
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokenFirstRequest {
  clientId: string;
  authOrigin: string;
  /** The login's relay slot (its relayId), also the OAuth `state`; the ID token comes back to it after. */
  state: string;
}

/**
 * token_first's first request: an access token for `openid email`, with the account chooser. No ID token is asked
 * for (Google would put `email` in it, D270), so no nonce; the callback never relays an ID token answered to it.
 */
export function googleTokenFirstUrl(r: GoogleTokenFirstRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: `${r.authOrigin}${CALLBACK_PATH}`,
    response_type: 'token',
    response_mode: 'fragment',
    scope: 'openid email',
    state: r.state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export interface LoginGoogleRequest {
  flow: GoogleEmailFlow;
  clientId: string;
  authOrigin: string;
  nonce: string;
  state: string;
  /** The login carries the follow-up key (an app with email, or token_first's record-only login). */
  follow: boolean;
  /** A `hana.linkAccount` popup: its new method's sign-in, never the email scope. */
  task: boolean;
  forceReauth: boolean;
}

/**
 * A login's own Google request under `flow` (/login, and case B's from /login/email), and whether it is token_first's
 * access token request (the callback's entry must then carry the nonce for the ID token request after it).
 */
export function loginGoogleRequest(r: LoginGoogleRequest): { url: string; tokenFirst: boolean } {
  if (startsWithAccessToken(r.flow, r) && !r.forceReauth) return { url: googleTokenFirstUrl(r), tokenFirst: true };
  return { url: googleAuthUrl({ clientId: r.clientId, authOrigin: r.authOrigin, nonce: r.nonce, state: r.state, forceReauth: r.forceReauth }), tokenFirst: false };
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

/** second_request's request (and D264's "Try Google again"): an access token for `email` only, for that account. */
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
  /** An ID token (and an access token beside it, which nothing asks for and nothing relays). */
  | { readonly kind: 'token'; readonly state: string; readonly idToken: string; readonly accessToken: string | null }
  /** Only an access token (second_request's second answer, token_first's first). */
  | { readonly kind: 'access'; readonly state: string; readonly accessToken: string }
  | { readonly kind: 'error'; readonly state: string; readonly error: string }
  /** No usable `state` (missing, malformed or repeated): nothing can be relayed. */
  | { readonly kind: 'no_state' }
  /** A valid `state` but neither a token nor an error (or both): relayed as an error so the vault stops waiting. */
  | { readonly kind: 'malformed'; readonly state: string };

const ACCESS_TOKEN = /^[\x21-\x7e]{1,2048}$/u;

/** Reads `#id_token=…&state=…`, `#access_token=…&state=…` or `#error=…&state=…`. Never throws. */
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

/** A Google `sub` as the pages accept it (a `login_hint`). */
export const GOOGLE_SUB = /^[0-9A-Za-z_-]{1,255}$/u;

/** A Google ID token's claims, read without any check (a hint, the claim allow-list before relaying), or null. */
export function unverifiedClaims(idToken: string): Record<string, unknown> | null {
  const part = idToken.split('.')[1];
  if (!part) return null;
  try {
    const json = atob(part.replace(/-/gu, '+').replace(/_/gu, '/') + '='.repeat((4 - (part.length % 4)) % 4));
    const v: unknown = JSON.parse(json);
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `sub` of a Google ID token, read without any check: only a `login_hint`, or a comparison with tokeninfo's. */
export function unverifiedSub(idToken: string): string | null {
  const sub = unverifiedClaims(idToken)?.sub;
  return typeof sub === 'string' && GOOGLE_SUB.test(sub) ? sub : null;
}

/** How long the callback waits for tokeninfo (the user is between two Google pages). */
export const TOKENINFO_TIMEOUT_MS = 8000;
const TOKENINFO_MAX_BYTES = 16 * 1024;

/**
 * tokeninfo's word on an access token: its `sub` when it was issued to `clientId` (`aud`, and `azp` when present) and
 * is unexpired. `unavailable`: no answer (network, a 5xx, a timeout, or the browser refused the response, CORS);
 * `wrong_client`: another client's token; `invalid`: any other refusal.
 */
export type AccessTokenSub = { ok: true; sub: string } | { ok: false; reason: 'unavailable' | 'wrong_client' | 'invalid' };

/**
 * token_first's login hint: the access token's `sub`, from Google's tokeninfo, as the email issuer reads it
 * (apps/email-issuer src/google.ts `checkAccessToken`). The token goes in a form body, never in a URL; no cookie or
 * referrer is sent. Never throws, and never puts the token or the answer in a result or an error.
 *
 * tokeninfo answers a browser's cross-origin POST with CORS headers the browser accepts (D270; the spike's leg E saw
 * it on 2026-11-04). If that ever stops, this returns `unavailable` and every token_first login ends there
 * (`tokeninfo_unavailable`); it never falls back to a request without the hint.
 */
export async function accessTokenSub(accessToken: string, clientId: string, fetchFn: typeof fetch = (...args) => fetch(...args)): Promise<AccessTokenSub> {
  let res: Response;
  try {
    res = await fetchFn(GOOGLE_TOKENINFO_URL, {
      method: 'POST',
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ access_token: accessToken }).toString(),
      signal: AbortSignal.timeout(TOKENINFO_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: 'unavailable' };
  }
  if (res.status >= 500) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, reason: 'unavailable' };
  }
  let body: unknown;
  try {
    const text = await res.text();
    if (text.length > TOKENINFO_MAX_BYTES) return { ok: false, reason: 'invalid' };
    body = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (res.status !== 200 || typeof body !== 'object' || body === null || Array.isArray(body)) return { ok: false, reason: 'invalid' };
  const o = body as Record<string, unknown>;
  if (o.aud !== clientId || (o.azp !== undefined && o.azp !== clientId)) return { ok: false, reason: 'wrong_client' };
  const expiresIn = typeof o.expires_in === 'string' ? Number(o.expires_in) : o.expires_in;
  if (typeof expiresIn !== 'number' || !(expiresIn > 0)) return { ok: false, reason: 'invalid' };
  if (typeof o.sub !== 'string' || !GOOGLE_SUB.test(o.sub)) return { ok: false, reason: 'invalid' };
  return { ok: true, sub: o.sub };
}
