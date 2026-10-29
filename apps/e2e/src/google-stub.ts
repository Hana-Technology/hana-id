// The OIDC stub that stands in for Google (docs/batch-b-spec.md "Tests → Playwright"). The bundles keep their
// hard-coded `https://accounts.google.com/o/oauth2/v2/auth` and `https://www.googleapis.com/oauth2/v3/certs`; the tests
// route those two URLs, inside the browser context only, to this stub. So nothing in a production bundle can select it.
//
// The authorization endpoint checks the request is the implicit flow the spec fixes (id_token in the fragment,
// `scope=openid` only, the account chooser, the callback on an authOrigin of the stack, a nonce and a state), then shows an account
// chooser: one link per account, each carrying a freshly signed RS256 ID token with only the claims Google sends for
// `scope=openid` (the spike's set), or `#error=access_denied`. The JWKS endpoint serves the stub's public key.
import { base64UrlEncode, utf8 } from '@hana-id/core';
import { AUTH_ORIGIN, LIVE_AUTH_ORIGIN } from './stack.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const CALLBACK_URL = `${AUTH_ORIGIN}/login/callback`;
/** The registered redirect URIs: each env's authOrigin callback (E2E_ENV and live mode's LIVE_ENV). */
export const CALLBACK_URLS: readonly string[] = Object.freeze([CALLBACK_URL, `${LIVE_AUTH_ORIGIN}/login/callback`]);

export interface StubAccount {
  sub: string;
  label: string;
}

export const DEFAULT_ACCOUNTS: readonly StubAccount[] = Object.freeze([
  { sub: '110248495921238986420', label: 'Ada (consumer)' },
  { sub: '104729384756102938475', label: 'Grace (Workspace)' },
]);

/** What an authorization request must carry (everything else Google accepts is refused here). */
const REQUIRED = { response_type: 'id_token', response_mode: 'fragment', scope: 'openid', prompt: 'select_account' } as const;
const ALLOWED_PARAMS = new Set(['client_id', 'redirect_uri', 'response_type', 'response_mode', 'scope', 'nonce', 'state', 'prompt', 'max_age']);

export interface AuthRequest {
  clientId: string;
  nonce: string;
  state: string;
  maxAge: string | null;
  /** One of CALLBACK_URLS: where the chooser's links go. */
  redirectUri: string;
}

export type AuthCheck = { ok: true; request: AuthRequest } | { ok: false; problem: string };

/** Checks an authorization URL against the spec's request (docs/batch-b-spec.md "Login" step 5). */
export function checkAuthRequest(url: URL): AuthCheck {
  if (`${url.origin}${url.pathname}` !== GOOGLE_AUTH_URL) return { ok: false, problem: `unexpected endpoint ${url.pathname}` };
  for (const k of url.searchParams.keys()) if (!ALLOWED_PARAMS.has(k)) return { ok: false, problem: `unexpected parameter ${k}` };
  for (const [k, v] of Object.entries(REQUIRED)) if (url.searchParams.getAll(k).length !== 1 || url.searchParams.get(k) !== v) return { ok: false, problem: `${k} must be ${v}` };
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1 || !CALLBACK_URLS.includes(redirects[0] as string)) return { ok: false, problem: `redirect_uri must be one of ${CALLBACK_URLS.join(', ')}` };
  const redirectUri = redirects[0] as string;
  const clientId = url.searchParams.get('client_id');
  const nonce = url.searchParams.get('nonce');
  const state = url.searchParams.get('state');
  if (!clientId || !nonce || !state) return { ok: false, problem: 'client_id, nonce and state are required' };
  const maxAge = url.searchParams.get('max_age');
  if (maxAge !== null && maxAge !== '0') return { ok: false, problem: 'max_age must be 0' };
  return { ok: true, request: { clientId, nonce, state, maxAge, redirectUri } };
}

const escapeHtml = (s: string): string => s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export class GoogleStub {
  readonly kid = `e2e-${base64UrlEncode(crypto.getRandomValues(new Uint8Array(6)))}`;
  accounts: readonly StubAccount[] = DEFAULT_ACCOUNTS;
  /** A COOP header on the chooser (`same-origin` makes the popup switch browsing context groups, as Google may). */
  coop: string | null = null;
  /** Every authorization request seen, checked or not (tests assert on them). */
  readonly requests: AuthCheck[] = [];
  private keys: Promise<CryptoKeyPair> | null = null;

  private keyPair(): Promise<CryptoKeyPair> {
    this.keys ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    return this.keys;
  }

  /** `{keys: [jwk]}`, as Google's JWKS endpoint answers. */
  async jwks(): Promise<{ keys: Record<string, string>[] }> {
    const jwk = (await crypto.subtle.exportKey('jwk', (await this.keyPair()).publicKey)) as JsonWebKey;
    return { keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid: this.kid, n: jwk.n as string, e: jwk.e as string }] };
  }

  /** An RS256 JWT over `claims`, signed with the stub's key. */
  async sign(claims: Record<string, unknown>): Promise<string> {
    const enc = (o: unknown) => base64UrlEncode(utf8(JSON.stringify(o)));
    const input = `${enc({ alg: 'RS256', kid: this.kid, typ: 'JWT' })}.${enc(claims)}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', (await this.keyPair()).privateKey, utf8(input)));
    return `${input}.${base64UrlEncode(sig)}`;
  }

  /** The claims Google sends for an openid-only request (the spike's set: no email, name, picture or hd). */
  async idToken(r: AuthRequest, account: StubAccount, nowMs = Date.now()): Promise<string> {
    const now = Math.floor(nowMs / 1000);
    return this.sign({
      iss: 'https://accounts.google.com',
      azp: r.clientId,
      aud: r.clientId,
      sub: account.sub,
      nonce: r.nonce,
      nbf: now - 30,
      iat: now,
      exp: now + 3600,
      jti: base64UrlEncode(crypto.getRandomValues(new Uint8Array(16))),
    });
  }

  /** The chooser page for an authorization URL: 200 with one link per account, or 400 with the problem. */
  async authorize(url: URL): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const check = checkAuthRequest(url);
    this.requests.push(check);
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (this.coop) headers['cross-origin-opener-policy'] = this.coop;
    if (!check.ok) return { status: 400, headers, body: `<!doctype html><title>Error</title><p id="problem">${escapeHtml(check.problem)}</p>` };
    const r = check.request;
    const fragment = (p: Record<string, string>) => `${r.redirectUri}#${new URLSearchParams(p).toString()}`;
    const links = await Promise.all(
      this.accounts.map(async (a, i) => `<li><a id="account-${i}" href="${escapeHtml(fragment({ state: r.state, id_token: await this.idToken(r, a) }))}">${escapeHtml(a.label)}</a></li>`),
    );
    const deny = `<li><a id="deny" href="${escapeHtml(fragment({ state: r.state, error: 'access_denied' }))}">Cancel</a></li>`;
    return { status: 200, headers, body: `<!doctype html><meta charset="utf-8"><title>Choose an account</title><h1>Choose an account</h1><ul>${links.join('')}${deny}</ul>` };
  }
}
