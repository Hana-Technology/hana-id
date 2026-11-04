// Google sign-in for the direct page: Google's OIDC implicit flow with `scope=openid` only (`response_type=id_token`),
// as the Hana login popup asks it (packages/web/src/auth/google.ts), in a popup that redirects to
// direct-callback.html on this origin. An openid-only token carries no email, name, picture or Workspace domain, so
// the API's claim allow-list (`token_has_pii`, always on since D271) accepts it. Google Identity Services is not
// used: its tokens carry `email`. The token is handed straight to POST /v1/sessions; the page never displays, logs or
// stores it.
import { base64UrlDecode, base64UrlEncode, disallowedClaim } from '@hana-id/core';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
/** The redirect URI's path on this page's origin: the direct page's Google client lists `<origin>/direct-callback.html`. */
export const CALLBACK_PATH = '/direct-callback.html';
/** The message type direct-callback.html posts, and its same-origin storage key when the opener was severed. */
export const CALLBACK_MESSAGE = 'hana-smoke-direct-callback';
const GOOGLE_ERROR = /^[a-z_]{1,64}$/u;

export interface GoogleAuthRequest {
  clientId: string;
  redirectUri: string;
  nonce: string;
  state: string;
}

/** The authorization URL: an ID token in the fragment, `scope=openid` only, the account chooser. */
export function googleAuthUrl(r: GoogleAuthRequest): string {
  const params = new URLSearchParams({
    client_id: r.clientId,
    redirect_uri: r.redirectUri,
    response_type: 'id_token',
    response_mode: 'fragment',
    scope: 'openid',
    nonce: r.nonce,
    state: r.state,
    prompt: 'select_account',
  });
  return `${GOOGLE_AUTH_URL}?${params.toString()}`;
}

export type CallbackResult = { kind: 'token'; idToken: string } | { kind: 'error'; error: string } | { kind: 'ignored' };

/**
 * Reads the callback fragment for the sign-in waiting on `state`: exactly one `state`, equal to it, and either one
 * `id_token` or one `error`. Anything else (another sign-in's fragment, a repeated `state`) is ignored.
 */
export function readCallback(hash: string, state: string): CallbackResult {
  const p = new URLSearchParams(hash.startsWith('#') ? hash.slice(1) : hash);
  const states = p.getAll('state');
  if (states.length !== 1 || states[0] !== state) return { kind: 'ignored' };
  const tokens = p.getAll('id_token');
  const errors = p.getAll('error');
  if (tokens.length === 1 && errors.length === 0 && tokens[0]) return { kind: 'token', idToken: tokens[0] };
  if (errors.length === 1 && tokens.length === 0) return { kind: 'error', error: GOOGLE_ERROR.test(errors[0]!) ? errors[0]! : 'unknown_error' };
  return { kind: 'error', error: 'malformed_response' };
}

export interface GoogleSignIn {
  /** The ID token, or an error (Google's, or the popup being blocked). */
  readonly token: Promise<string>;
  /** Stops waiting (a new session): a later callback is ignored. */
  cancel(): void;
}

/**
 * Opens Google's sign-in popup for `clientId` with `nonce`; call it from a click (popups need user activation).
 * Resolves with the ID token the callback page hands back, by postMessage or, when Google's pages severed the opener,
 * by a same-origin BroadcastChannel (nothing is stored). Only the fragment carrying this sign-in's `state` counts.
 */
export function openGoogleSignIn(clientId: string, nonce: string, win: Window & typeof globalThis = window): GoogleSignIn {
  const state = base64UrlEncode(crypto.getRandomValues(new Uint8Array(32)));
  const url = googleAuthUrl({ clientId, redirectUri: `${win.location.origin}${CALLBACK_PATH}`, nonce, state });
  let settle: { resolve: (jwt: string) => void; reject: (err: Error) => void } | null = null;
  const token = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  const channel = typeof win.BroadcastChannel === 'function' ? new win.BroadcastChannel(CALLBACK_MESSAGE) : null;
  const stop = (): void => {
    win.removeEventListener('message', onMessage);
    channel?.close();
    settle = null;
  };
  const handle = (data: unknown): void => {
    const d = data as { t?: unknown; hash?: unknown } | null;
    if (d?.t !== CALLBACK_MESSAGE || typeof d.hash !== 'string' || !settle) return;
    const r = readCallback(d.hash, state);
    if (r.kind === 'ignored') return;
    const s: { resolve: (jwt: string) => void; reject: (err: Error) => void } = settle;
    stop();
    if (r.kind === 'token') s.resolve(r.idToken);
    else s.reject(new Error(`Google sign-in failed: ${r.error}`));
  };
  function onMessage(e: MessageEvent): void {
    if (e.origin === win.location.origin) handle(e.data);
  }
  win.addEventListener('message', onMessage);
  if (channel) channel.onmessage = (e: MessageEvent) => handle(e.data);
  const popup = win.open(url, 'hana-smoke-google', 'popup,width=500,height=640');
  if (!popup) {
    stop();
    return { token: Promise.reject(new Error('The browser blocked the Google sign-in popup: allow popups for this page')), cancel: () => undefined };
  }
  return { token, cancel: stop };
}

export interface TokenClaims {
  aud: string;
  sub: string;
  nonce: string | null;
  /** The first claim outside the API's allow-list (`@hana-id/core` TOKEN_CLAIM_ALLOW_LIST), or null. */
  disallowed: string | null;
}

/** Reads (does not verify) the claims the page checks before sending the token: aud, nonce and the allow-list. */
export function readClaims(jwt: string): TokenClaims {
  const part = jwt.split('.')[1];
  if (!part) throw new Error('Google returned a malformed ID token');
  let c: Record<string, unknown>;
  try {
    c = JSON.parse(new TextDecoder().decode(base64UrlDecode(part))) as Record<string, unknown>;
  } catch {
    throw new Error('Google returned a malformed ID token');
  }
  if (typeof c !== 'object' || c === null || Array.isArray(c)) throw new Error('Google returned a malformed ID token');
  if (typeof c.aud !== 'string' || typeof c.sub !== 'string') throw new Error('Google returned an ID token without aud/sub');
  return { aud: c.aud, sub: c.sub, nonce: typeof c.nonce === 'string' ? c.nonce : null, disallowed: disallowedClaim(c) };
}
