// A mocked Google for the console's code flow: a fixed RSA key published at Google's JWKS URL, and a token endpoint that
// checks what a real one checks (single-use codes, the client id and secret, the redirect URI, the PKCE verifier against
// the challenge sent at authorization) before it answers with an ID token signed for the authorization's nonce. The
// tests step through the real routes: `POST /api/auth/start`, `AuthHandler` `/start` and `/callback`, then
// `/api/auth/complete`, each with the cookies a browser would hold.
import { b64url, randomBytes, sha256 } from '@hana-id/console-core';
import { JWKS_URLS, clearJwksCache } from '@hana-id/oidc';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { FakeJwks, type RsaSigner, rsaSigner } from '../../../packages/oidc/test/helpers.ts';
import { AuthHandler } from '../src/auth-handler.ts';
import { GOOGLE_AUTH_URL, GOOGLE_TOKEN_URL } from '../src/auth-google.ts';
import { atHash } from '../src/auth-token.ts';
import { ORIGIN, post, request } from './helpers.ts';

export const AUTH = 'https://console-auth.test';
export const CLIENT_ID = 'console-client.apps.googleusercontent.com';
export const SECRET = 'test-console-client-secret';
const GOOGLE_JWKS_URL = JWKS_URLS.google!;

export interface Authorization {
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  nonce: string;
  challenge: string;
  loginHint: string | null;
  params: URLSearchParams;
}

export interface GoogleAccount {
  sub: string;
  email: string;
  hd?: string;
}

/** What the next token answer's ID token carries: the account, and claim overrides (`undefined` deletes a claim). */
export type ClaimEdits = Record<string, unknown>;

let sharedSigner: RsaSigner | undefined;

export class MockGoogle {
  signer!: RsaSigner;
  readonly jwks = new FakeJwks();
  /** code → what it was issued for. */
  private readonly codes = new Map<string, { auth: Authorization; account: GoogleAccount; edits: ClaimEdits; used: boolean }>();
  /** Every ID token and access token issued (to check none of them is ever echoed, logged or stored). */
  readonly issued: string[] = [];
  /** Every token-endpoint request body (form fields). */
  readonly exchanges: URLSearchParams[] = [];
  /** The token endpoint's next status, when set (one shot). */
  nextStatus: number | null = null;

  async init(): Promise<void> {
    // One key for the whole file: the API Worker (C10's step-ups, through the fake upstream) caches Google's JWKS by
    // kid in its own isolate, which a test can't clear, so a new key per test would fail its signature check there.
    sharedSigner ??= await rsaSigner('console-test-kid');
    this.signer = sharedSigner;
    this.jwks.body = { keys: [this.signer.jwk] };
    clearJwksCache();
    const real = globalThis.fetch.bind(globalThis);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = input instanceof Request ? input : new Request(input, init);
      if (req.url === GOOGLE_JWKS_URL) return this.jwks.fetch(req.url, init);
      if (req.url === GOOGLE_TOKEN_URL) return this.token(req);
      // The fake chain's NEAR RPC (test/chain.ts installChain) is answered underneath this mock.
      if (req.url.startsWith('https://') && !req.url.startsWith('https://rpc.test.invalid')) throw new Error(`Unexpected fetch to ${req.url}`);
      return real(input, init);
    });
  }

  /** Google's authorization endpoint: parses the request `/start` redirected to and issues a code for `account`. */
  authorize(location: string, account: GoogleAccount, edits: ClaimEdits = {}): { code: string; auth: Authorization } {
    const u = new URL(location);
    if (`${u.origin}${u.pathname}` !== GOOGLE_AUTH_URL) throw new Error(`not Google's authorization endpoint: ${u.origin}${u.pathname}`);
    const p = u.searchParams;
    const auth: Authorization = {
      clientId: p.get('client_id')!,
      redirectUri: p.get('redirect_uri')!,
      scope: p.get('scope')!,
      state: p.get('state')!,
      nonce: p.get('nonce')!,
      challenge: p.get('code_challenge')!,
      loginHint: p.get('login_hint'),
      params: p,
    };
    const code = `4/${b64url(randomBytes(24))}`;
    this.codes.set(code, { auth, account, edits, used: false });
    return { code, auth };
  }

  /** An ID token as Google signs one (for unit tests and hand-made answers). */
  async idToken(claims: Record<string, unknown>): Promise<string> {
    const t = await this.signer.sign(claims);
    this.issued.push(t);
    return t;
  }

  private async token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text());
    this.exchanges.push(form);
    if (this.nextStatus !== null) {
      const status = this.nextStatus;
      this.nextStatus = null;
      return Response.json({ error: 'server_error' }, { status });
    }
    const entry = this.codes.get(form.get('code') ?? '');
    const bad = (error: string) => Response.json({ error }, { status: 400 });
    if (!entry || entry.used) return bad('invalid_grant');
    entry.used = true;
    if (form.get('grant_type') !== 'authorization_code') return bad('unsupported_grant_type');
    if (form.get('client_id') !== entry.auth.clientId || form.get('client_secret') !== SECRET) return bad('invalid_client');
    if (form.get('redirect_uri') !== entry.auth.redirectUri) return bad('redirect_uri_mismatch');
    const verifier = form.get('code_verifier') ?? '';
    if (b64url(await sha256(new TextEncoder().encode(verifier))) !== entry.auth.challenge) return bad('invalid_grant');
    const accessToken = `ya29.${b64url(randomBytes(32))}`;
    this.issued.push(accessToken);
    const now = Math.floor(Date.now() / 1000);
    const claims: Record<string, unknown> = {
      iss: 'https://accounts.google.com',
      azp: entry.auth.clientId,
      aud: entry.auth.clientId,
      sub: entry.account.sub,
      ...(entry.auth.scope.split(' ').includes('email') ? { email: entry.account.email, email_verified: true, ...(entry.account.hd ? { hd: entry.account.hd } : {}) } : {}),
      at_hash: await atHash(accessToken),
      nonce: entry.auth.nonce,
      iat: now,
      exp: now + 3600,
    };
    for (const [k, v] of Object.entries(entry.edits)) {
      if (v === undefined) delete claims[k];
      else claims[k] = v;
    }
    const idToken = await this.idToken(claims);
    return Response.json({ access_token: accessToken, expires_in: 3599, scope: entry.auth.scope, token_type: 'Bearer', id_token: idToken });
  }
}

/** A request to the auth origin, through the console's `AuthHandler` entrypoint (as console-auth forwards it). */
export function authOrigin(path: string, init: { cookie?: string; ip?: string } = {}): Promise<Response> {
  const headers = new Headers({ 'cf-connecting-ip': init.ip ?? `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });
  if (init.cookie) headers.set('cookie', init.cookie);
  return new AuthHandler(createExecutionContext(), env).fetch(new Request(`${AUTH}${path}`, { headers }));
}

/** The value a response's `Set-Cookie` gives `name`, or null. */
export function setCookie(res: Response, name: string): string | null {
  for (const c of res.headers.getSetCookie()) if (c.startsWith(`${name}=`)) return c.slice(name.length + 1).split(';')[0]!;
  return null;
}

/** The full `Set-Cookie` line for `name`. */
export const setCookieLine = (res: Response, name: string): string | undefined => res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));

export interface Browser {
  /** __Host-hana_pre on the console origin. */
  pre?: string;
  /** __Host-hana_af on the auth origin. */
  af?: string;
  /** __Host-hana_cs on the console origin. */
  cs?: string;
}

export interface SignInSteps {
  start: Response;
  startUrl?: string;
  toGoogle?: Response;
  auth?: Authorization;
  code?: string;
  callback?: Response;
  complete?: Response;
  browser: Browser;
}

/**
 * Steps through a whole sign-in as one browser, stopping at the first step that doesn't go on. `account` signs in at
 * Google; `edits` change the ID token's claims.
 */
export async function signIn(google: MockGoogle, account: GoogleAccount, o: { invite?: string; edits?: ClaimEdits; browser?: Browser; ip?: string; beforeComplete?: () => Promise<void> } = {}): Promise<SignInSteps> {
  const browser: Browser = o.browser ?? {};
  const start = await post('/api/auth/start', { purpose: 'login', ...(o.invite ? { invite: o.invite } : {}) }, o.ip ? { ip: o.ip } : {});
  const steps: SignInSteps = { start, browser };
  if (start.status !== 200) return steps;
  browser.pre = setCookie(start, '__Host-hana_pre') ?? undefined;
  const { startUrl } = (await start.json()) as { startUrl: string };
  steps.startUrl = startUrl;
  const u = new URL(startUrl);
  steps.toGoogle = await authOrigin(`${u.pathname}${u.search}`, o.ip ? { ip: o.ip } : {});
  if (steps.toGoogle.status !== 303) return steps;
  browser.af = setCookie(steps.toGoogle, '__Host-hana_af') ?? undefined;
  const { code, auth } = google.authorize(steps.toGoogle.headers.get('location')!, account, o.edits);
  steps.code = code;
  steps.auth = auth;
  steps.callback = await authOrigin(`/callback?code=${encodeURIComponent(code)}&state=${auth.state}`, { ...(browser.af ? { cookie: `__Host-hana_af=${browser.af}` } : {}), ...(o.ip ? { ip: o.ip } : {}) });
  if (steps.callback.status !== 303) return steps;
  const next = new URL(steps.callback.headers.get('location')!);
  await o.beforeComplete?.();
  steps.complete = await request(`${next.pathname}${next.search}`, { headers: browser.pre ? { cookie: `__Host-hana_pre=${browser.pre}` } : {}, ...(o.ip ? { ip: o.ip } : {}) });
  const cs = setCookie(steps.complete, '__Host-hana_cs');
  if (cs) browser.cs = cs;
  return steps;
}

/** Where `/api/auth/complete` sent the browser: `/` or `/signin#error=<code>`. */
export function landing(steps: SignInSteps): string | null {
  const loc = steps.complete?.headers.get('location');
  return loc ? loc.replace(ORIGIN, '') : null;
}

/** A signed-in GET with the session cookie. */
export const getWith = (cs: string | undefined, path: string) => request(path, { headers: cs ? { cookie: `__Host-hana_cs=${cs}` } : {} });

/** A unique Google account. */
export function account(o: Partial<GoogleAccount> = {}): GoogleAccount {
  const n = b64url(randomBytes(6)).toLowerCase().replace(/[^a-z0-9]/gu, 'x');
  return { sub: o.sub ?? `1${Math.floor(Math.random() * 1e15)}`, email: o.email ?? `member-${n}@partner.example`, ...(o.hd ? { hd: o.hd } : {}) };
}
