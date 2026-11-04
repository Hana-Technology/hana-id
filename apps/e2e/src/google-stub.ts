// The OIDC stub that stands in for Google (docs/batch-b-spec.md "Tests → Playwright"). The bundles keep their
// hard-coded `https://accounts.google.com/o/oauth2/v2/auth` and `https://www.googleapis.com/oauth2/v3/certs`; the tests
// route those two URLs, inside the browser context only, to this stub. So nothing in a production bundle can select it.
//
// The authorization endpoint takes exactly the requests the popup makes, and refuses anything else:
//   - a login: id_token in the fragment, `scope=openid` only, the account chooser (`prompt=select_account`), a nonce,
//     a state: it shows an account chooser, one link per account, each carrying a freshly signed RS256 ID token with
//     only the claims Google sends for `scope=openid` (the spike's set), or `#error=access_denied`;
//   - a proof the vault asked for (build plan batch 8b: a link method's or a banner's): the same with `login_hint`
//     (the account's sub) instead of the chooser: it answers for that account at once;
//   - the second request for Google's verified email (batch 8b, two-request mode): `response_type=token`, `scope=email`,
//     `login_hint`, `prompt=none` (or no prompt, the interactive retry): it answers `#access_token=…` for that account.
// A request that would put the email in the ID token (`id_token` with the `email` scope) is refused. The JWKS endpoint
// serves the signing key's public part.
//
// Signing key: the stack's (src/server/google-backend.ts, fetched from `GET /__e2e/google-key`), so the email issuer,
// which verifies Google's tokens server side, knows it; a stub without a stack (the stack's unit tests) makes its own.
// Access tokens are self-describing test values the stack reads back (google-backend.ts `accessTokenFor`).
import { base64UrlEncode, utf8 } from '@hana-id/core';
import { accessTokenFor } from './server/google-backend.ts';
import { AUTH_ORIGIN, LIVE_AUTH_ORIGIN } from './stack.ts';

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_CERTS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const CALLBACK_URL = `${AUTH_ORIGIN}/login/callback`;
/** The registered redirect URIs: each env's authOrigin callback (E2E_ENV and live mode's LIVE_ENV). */
export const CALLBACK_URLS: readonly string[] = Object.freeze([CALLBACK_URL, `${LIVE_AUTH_ORIGIN}/login/callback`]);

export interface StubAccount {
  sub: string;
  label: string;
  /** The account's primary address as userinfo answers it (batch 8b), and whether Google verified it. */
  email?: string;
  emailVerified?: boolean;
  /** A Workspace account's domain (`hd`). */
  hd?: string;
}

export const DEFAULT_ACCOUNTS: readonly StubAccount[] = Object.freeze([
  { sub: '110248495921238986420', label: 'Ada (consumer)', email: 'ada.e2e.default@gmail.com', emailVerified: true },
  { sub: '104729384756102938475', label: 'Grace (Workspace)', email: 'grace@workspace-e2e.example.com', emailVerified: true, hd: 'workspace-e2e.example.com' },
]);

/** What a login must carry (everything else Google accepts is refused here). */
const LOGIN = { response_type: 'id_token', response_mode: 'fragment', scope: 'openid', prompt: 'select_account' } as const;
const ALLOWED_PARAMS = new Set(['client_id', 'redirect_uri', 'response_type', 'response_mode', 'scope', 'nonce', 'state', 'prompt', 'max_age', 'login_hint']);

export type AuthKind = 'login' | 'proof' | 'access';

export interface AuthRequest {
  clientId: string;
  /** Empty for an access request (no ID token). */
  nonce: string;
  state: string;
  maxAge: string | null;
  /** One of CALLBACK_URLS: where the chooser's links go. */
  redirectUri: string;
  kind?: AuthKind;
  /** The account a proof or an access request names. */
  loginHint?: string | null;
  /** An access request with `prompt=none`. */
  silent?: boolean;
}

export type AuthCheck = { ok: true; request: AuthRequest } | { ok: false; problem: string };

const one = (url: URL, k: string): string | null => (url.searchParams.getAll(k).length === 1 ? url.searchParams.get(k) : null);

/** Checks an authorization URL against the popup's requests (docs/batch-b-spec.md "Login" step 5; batch 8b). */
export function checkAuthRequest(url: URL): AuthCheck {
  if (`${url.origin}${url.pathname}` !== GOOGLE_AUTH_URL) return { ok: false, problem: `unexpected endpoint ${url.pathname}` };
  for (const k of url.searchParams.keys()) if (!ALLOWED_PARAMS.has(k)) return { ok: false, problem: `unexpected parameter ${k}` };
  for (const k of url.searchParams.keys()) if (url.searchParams.getAll(k).length !== 1) return { ok: false, problem: `${k} repeated` };
  const redirects = url.searchParams.getAll('redirect_uri');
  if (redirects.length !== 1 || !CALLBACK_URLS.includes(redirects[0] as string)) return { ok: false, problem: `redirect_uri must be one of ${CALLBACK_URLS.join(', ')}` };
  const redirectUri = redirects[0] as string;
  if (one(url, 'response_mode') !== 'fragment') return { ok: false, problem: 'response_mode must be fragment' };
  const clientId = one(url, 'client_id');
  const state = one(url, 'state');
  if (!clientId || !state) return { ok: false, problem: 'client_id and state are required' };
  const maxAge = url.searchParams.get('max_age');
  if (maxAge !== null && maxAge !== '0') return { ok: false, problem: 'max_age must be 0' };
  const loginHint = url.searchParams.get('login_hint');
  const responseType = url.searchParams.get('response_type');
  const scope = url.searchParams.get('scope');
  const prompt = url.searchParams.get('prompt');
  if (responseType === 'token') {
    // The second request: an access token for the email scope only, for the account that just signed in; no nonce.
    if (scope !== 'email') return { ok: false, problem: 'an access request asks for scope=email only' };
    if (!loginHint) return { ok: false, problem: 'an access request names its account (login_hint)' };
    if (prompt !== null && prompt !== 'none') return { ok: false, problem: 'an access request is silent (prompt=none) or plain' };
    if (url.searchParams.has('nonce') || maxAge !== null) return { ok: false, problem: 'an access request has no nonce or max_age' };
    return { ok: true, request: { clientId, nonce: '', state, maxAge: null, redirectUri, kind: 'access', loginHint, silent: prompt === 'none' } };
  }
  // An ID token: never with the email scope (the on-chain token stays openid-only, D25).
  if (responseType !== LOGIN.response_type) return { ok: false, problem: `response_type must be ${LOGIN.response_type}` };
  if (scope !== LOGIN.scope) return { ok: false, problem: `scope must be ${LOGIN.scope}` };
  const nonce = one(url, 'nonce');
  if (!nonce) return { ok: false, problem: 'client_id, nonce and state are required' };
  if (loginHint !== null) {
    if (prompt !== null) return { ok: false, problem: 'a proof names its account (login_hint) and shows no chooser' };
    return { ok: true, request: { clientId, nonce, state, maxAge, redirectUri, kind: 'proof', loginHint } };
  }
  if (prompt !== LOGIN.prompt) return { ok: false, problem: `prompt must be ${LOGIN.prompt}` };
  return { ok: true, request: { clientId, nonce, state, maxAge, redirectUri, kind: 'login' } };
}

const escapeHtml = (s: string): string => s.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');

export interface GoogleStubOptions {
  /** The signing key (the stack's: src/server/google-backend.ts); default a key of its own. */
  key?: () => Promise<{ pair: CryptoKeyPair; kid: string }>;
}

export class GoogleStub {
  accounts: readonly StubAccount[] = DEFAULT_ACCOUNTS;
  /** A COOP header on the chooser (`same-origin` makes the popup switch browsing context groups, as Google may). */
  coop: string | null = null;
  /** Every authorization request seen, checked or not (tests assert on them). */
  readonly requests: AuthCheck[] = [];
  private keys: Promise<{ pair: CryptoKeyPair; kid: string }> | null = null;

  constructor(private readonly o: GoogleStubOptions = {}) {}

  private key(): Promise<{ pair: CryptoKeyPair; kid: string }> {
    this.keys ??=
      this.o.key?.() ??
      crypto.subtle
        .generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])
        .then((pair) => ({ pair, kid: `e2e-${base64UrlEncode(crypto.getRandomValues(new Uint8Array(6)))}` }));
    return this.keys;
  }

  /** The signing key's kid. */
  async kid(): Promise<string> {
    return (await this.key()).kid;
  }

  /** The logins (account chooser) seen, the proofs and the access requests left out. */
  get logins(): AuthCheck[] {
    return this.requests.filter((r) => !r.ok || r.request.kind === undefined || r.request.kind === 'login');
  }

  /** `{keys: [jwk]}`, as Google's JWKS endpoint answers. */
  async jwks(): Promise<{ keys: Record<string, string>[] }> {
    const { pair, kid } = await this.key();
    const jwk = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
    return { keys: [{ kty: 'RSA', alg: 'RS256', use: 'sig', kid, n: jwk.n as string, e: jwk.e as string }] };
  }

  /** An RS256 JWT over `claims`, signed with the stub's key. */
  async sign(claims: Record<string, unknown>): Promise<string> {
    const { pair, kid } = await this.key();
    const enc = (o: unknown) => base64UrlEncode(utf8(JSON.stringify(o)));
    const input = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
    const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, utf8(input)));
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

  /** The access token for the email scope (a test value the stack reads back, google-backend.ts). */
  accessToken(r: AuthRequest, account: StubAccount, nowMs = Date.now()): string {
    return accessTokenFor({ aud: r.clientId, sub: account.sub, email: account.email ?? null, emailVerified: account.emailVerified ?? false, hd: account.hd ?? null, expMs: nowMs + 3_599_000 });
  }

  /** The page for an authorization URL: 200 with the chooser (or an answer at once for a named account), or 400. */
  async authorize(url: URL): Promise<{ status: number; headers: Record<string, string>; body: string }> {
    const check = checkAuthRequest(url);
    this.requests.push(check);
    const headers: Record<string, string> = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
    if (this.coop) headers['cross-origin-opener-policy'] = this.coop;
    if (!check.ok) return { status: 400, headers, body: `<!doctype html><title>Error</title><p id="problem">${escapeHtml(check.problem)}</p>` };
    const r = check.request;
    const fragment = (p: Record<string, string>) => `${r.redirectUri}#${new URLSearchParams(p).toString()}`;
    if (r.kind === 'proof' || r.kind === 'access') {
      // A named account: Google answers without a chooser (the account is signed in in this browser).
      const account = this.accounts.find((a) => a.sub === r.loginHint);
      const to = !account
        ? fragment({ state: r.state, error: r.kind === 'access' && r.silent ? 'login_required' : 'access_denied' })
        : r.kind === 'access'
          ? fragment({ access_token: this.accessToken(r, account), token_type: 'Bearer', expires_in: '3599', scope: 'email', state: r.state })
          : fragment({ state: r.state, id_token: await this.idToken(r, account) });
      return { status: 200, headers, body: `<!doctype html><meta charset="utf-8"><title>Signing in</title><script>location.replace(${JSON.stringify(to)})</script>` };
    }
    const links = await Promise.all(
      this.accounts.map(async (a, i) => `<li><a id="account-${i}" href="${escapeHtml(fragment({ state: r.state, id_token: await this.idToken(r, a) }))}">${escapeHtml(a.label)}</a></li>`),
    );
    const deny = `<li><a id="deny" href="${escapeHtml(fragment({ state: r.state, error: 'access_denied' }))}">Cancel</a></li>`;
    return { status: 200, headers, body: `<!doctype html><meta charset="utf-8"><title>Choose an account</title><h1>Choose an account</h1><ul>${links.join('')}${deny}</ul>` };
  }
}

/** The stack's Google signing key (src/server/google-backend.ts), fetched once per test process. */
let stackKey: Promise<{ pair: CryptoKeyPair; kid: string }> | null = null;

export function stackGoogleKey(apiUrl: string): () => Promise<{ pair: CryptoKeyPair; kid: string }> {
  return () => {
    stackKey ??= (async () => {
      const res = await fetch(`${apiUrl}/__e2e/google-key`);
      if (!res.ok) throw new Error(`the stack's Google key: ${res.status}`);
      const jwk = (await res.json()) as JsonWebKey & { kid: string };
      const alg = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' };
      const privateKey = await crypto.subtle.importKey('jwk', jwk, alg, true, ['sign']);
      const publicKey = await crypto.subtle.importKey('jwk', { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true }, alg, true, ['verify']);
      return { pair: { privateKey, publicKey }, kid: jwk.kid };
    })();
    return stackKey;
  };
}
