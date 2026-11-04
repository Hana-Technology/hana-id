// Google's side of the console's code flow (docs/batch-c-spec.md "Code flow"): the authorization request `/start`
// redirects to, PKCE S256, and the server-side code exchange the callback makes with CONSOLE_GOOGLE_CLIENT_SECRET.
// Both endpoints are fixed constants, never config, so no var can point the exchange (and the secret) elsewhere.
//
// SECURITY: the client secret, the code, the PKCE verifier and the tokens Google returns are credentials. Nothing here
// logs them, and no error carries them or Google's error text (which can echo the request).
import { b64url, sha256 } from '@hana-id/console-core';
import type { ConsoleScope } from './auth-token.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** The token exchange's time limit (connection, headers and body), and its body cap (Google's answer is ~2 KB). */
export const TOKEN_FETCH_TIMEOUT_MS = 8_000;
export const TOKEN_MAX_BODY_BYTES = 32 * 1024;
/** The contract's JWT limit (console-core JWT_MAX); a longer ID token is refused before any parse. */
const ID_TOKEN_MAX = 7168;

/** The redirect URI: the console client's only one (`<console.authOrigin>/callback`). */
export const redirectUri = (authOrigin: string): string => `${authOrigin}/callback`;

/** PKCE S256 challenge of a verifier (RFC 7636 §4.2). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await sha256(new TextEncoder().encode(verifier)));
}

export interface AuthRequest {
  clientId: string;
  authOrigin: string;
  scope: ConsoleScope;
  state: string;
  nonce: string;
  codeChallenge: string;
  /** The invite's address (a login with an invite), or the session's `sub` (a step-up). */
  loginHint: string | null;
}

/** The URL `/start` 303s to: `response_type=code` with PKCE, never an implicit-flow response type. */
export function authorizationUrl(r: AuthRequest): string {
  const u = new URL(GOOGLE_AUTH_URL);
  const p = u.searchParams;
  p.set('client_id', r.clientId);
  p.set('redirect_uri', redirectUri(r.authOrigin));
  p.set('response_type', 'code');
  p.set('scope', r.scope);
  p.set('prompt', 'select_account');
  p.set('state', r.state);
  p.set('nonce', r.nonce);
  p.set('code_challenge', r.codeChallenge);
  p.set('code_challenge_method', 'S256');
  if (r.loginHint) p.set('login_hint', r.loginHint);
  return u.toString();
}

export type Exchange = { ok: true; idToken: string; accessToken: string | undefined } | { ok: false; code: 'google_refused' | 'google_unavailable' | 'bad_answer' };

/** The token endpoint's JSON body, read up to the cap; null when it is larger or not JSON. */
async function readCapped(res: Response): Promise<unknown> {
  if (Number(res.headers.get('content-length')) > TOKEN_MAX_BODY_BYTES) return null;
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > TOKEN_MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

/**
 * Exchanges the authorization code (RFC 6749 §4.1.3 with RFC 7636's verifier). A 4xx (a used or wrong code, a wrong
 * verifier) is `google_refused`; a 5xx, a timeout or a network error is `google_unavailable`; an answer with no
 * well-formed ID token is `bad_answer`.
 */
export async function exchangeCode(e: { code: string; verifier: string; clientId: string; clientSecret: string; authOrigin: string }): Promise<Exchange> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: e.code,
    client_id: e.clientId,
    client_secret: e.clientSecret,
    redirect_uri: redirectUri(e.authOrigin),
    code_verifier: e.verifier,
  });
  let res: Response;
  try {
    res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body,
      signal: AbortSignal.timeout(TOKEN_FETCH_TIMEOUT_MS),
      redirect: 'manual',
    });
  } catch {
    return { ok: false, code: 'google_unavailable' };
  }
  if (res.status >= 500) return { ok: false, code: 'google_unavailable' };
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return { ok: false, code: 'google_refused' };
  }
  const json = await readCapped(res);
  if (typeof json !== 'object' || json === null) return { ok: false, code: 'bad_answer' };
  const { id_token: idToken, access_token: accessToken } = json as Record<string, unknown>;
  if (typeof idToken !== 'string' || idToken.length > ID_TOKEN_MAX || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u.test(idToken)) return { ok: false, code: 'bad_answer' };
  return { ok: true, idToken, accessToken: typeof accessToken === 'string' && accessToken.length <= 4096 ? accessToken : undefined };
}
