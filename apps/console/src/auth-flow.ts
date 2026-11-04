// The console's Google code flow, steps 1–3 (docs/batch-c-spec.md "Partner sign-in" → "Code flow"; D75):
//
// 1. `POST /api/auth/start` (console origin, CSRF rules): stores an `auth_flows` row (the start handle's and state's
//    hashes, the PKCE verifier, the nonce, `scope = 'openid email'`, the invite when its token is live), sets
//    `__Host-hana_pre` and answers `{startUrl: "<authOrigin>/start?f=…"}`.
// 2. `GET <authOrigin>/start?f=` (through console-auth → `AuthHandler`): marks the flow started in the same statement
//    that finds it, sets `__Host-hana_af` on the auth origin, and 303s to Google with `response_type=code` and PKCE S256.
// 3. `GET <authOrigin>/callback`: answers a 3xx only for a query with `code` and `state` whose state names a started,
//    unused, unexpired flow carrying this browser's `__Host-hana_af`; marks it used in that lookup, exchanges the code
//    server-side, verifies the ID token (auth-token.ts) and, for a login, writes a 60-second handoff code and 303s to
//    `<console.origin>/api/auth/complete?h=…#`. Anything else is the static 400 page, with no `Location`.
//
// The implicit-flow guard: Google also answers `response_type=id_token` for a registered redirect URI, so a fragment
// with a token may reach `/callback`. A browser never sends a fragment to a server, and a redirect inherits the
// request's fragment unless its `Location` has one, so the callback redirects only after a valid code and state, and
// every success `Location` ends with an empty fragment (`#`): no fragment is ever carried on to the console.
//
// The state is derived from the start handle (sha256 of a label and f's bytes), so neither is stored in clear: a D1
// read gives the hashes, never a usable handle or state. Each of f, state, PKCE verifier and nonce is single use: a
// flow is started once and used once, inside its 5 minutes.
//
// SECURITY: the code, the verifier, the nonce, the cookies and the ID token are never logged or returned; only codes and
// claim names are logged.
import { authStartBody, b64url, concatBytes, consoleLoginNonce, fromB64url, randomBytes, sha256, utf8 } from '@hana-id/console-core';
import { authorizationUrl, exchangeCode, pkceChallenge } from './auth-google.ts';
import { type ConsoleScope, verifyConsoleToken } from './auth-token.ts';
import { AUTH_FLOW_TTL_MS, FLOW_COOKIE_MAX_AGE_S, HANDOFF_TTL_MS } from './config.ts';
import type { Env } from './env.ts';
import { errorResponse, json, readJson } from './http.ts';
import { ipSubject } from './ip.ts';
import { CONSOLE_LIMIT_PERIOD_S, consoleIpKey } from './limits.ts';
import type { RequestInfo } from './links.ts';
import { log } from './log.ts';
import { cookieHash, readCookie } from './sessions.ts';
import { lit } from './sql.ts';

/** The login flow's cookie on the console origin (create → complete). */
export const PRE_COOKIE = '__Host-hana_pre';
/** The flow's cookie on the auth origin (start → callback). */
export const AF_COOKIE = '__Host-hana_af';
/** Lax: a Strict cookie is withheld on the navigations back from Google. `__Host-`: Secure, Path=/, no Domain. */
const FLOW_COOKIE_ATTRS = 'Path=/; Secure; HttpOnly; SameSite=Lax';
export const flowCookie = (name: string, value: string): string => `${name}=${value}; ${FLOW_COOKIE_ATTRS}; Max-Age=${FLOW_COOKIE_MAX_AGE_S}`;
export const clearFlowCookie = (name: string): string => `${name}=; ${FLOW_COOKIE_ATTRS}; Max-Age=0`;

/** The state of a flow: b64url(sha256("hana-console/auth-state/v1\0" ‖ f)), from the start handle's 32 bytes. */
export async function flowState(f: Uint8Array): Promise<Uint8Array> {
  return sha256(concatBytes(utf8('hana-console/auth-state/v1\0'), f));
}

const B64URL32 = /^[A-Za-z0-9_-]{43}$/u;
/** The longest authorization `code` accepted (Google's are ~73 characters). */
const MAX_CODE = 512;

/** The per-IP flood limit shared by `/api/auth/*` and the auth origin's routes (10 a minute per IP or IPv6 /64). */
export async function authLimited(env: Env, info: RequestInfo): Promise<boolean> {
  const { success } = await env.CONSOLE_IP_LIMIT.limit({ key: consoleIpKey(env.ENV_NAME, 'auth', ipSubject(info.clientIp)) });
  return !success;
}

// ---- 1. create (console origin) ----

/**
 * `POST /api/auth/start {purpose: "login", invite?}` → `{startUrl}` and `__Host-hana_pre`. An invite token that names no
 * live, notified invite is refused here (403 `invite_invalid`, D293) rather than carried into a sign-in that would end
 * `not_invited`.
 */
export async function createLoginFlow(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  if (await authLimited(env, info)) return errorResponse('rate_limited', undefined, { 'retry-after': String(CONSOLE_LIMIT_PERIOD_S) });
  const body = await readJson(request);
  if (!body.ok) return errorResponse(body.code);
  const parsed = authStartBody.safeParse(body.value);
  if (!parsed.success) return errorResponse('bad_request', 'Expected {purpose: "login", invite?}');
  const now = Date.now();
  let invite: { id: string; email_norm: string } | null = null;
  if (parsed.data.invite !== undefined) {
    const tokenHash = await sha256(fromB64url(parsed.data.invite));
    invite = await env.CONSOLE_DB.prepare(`SELECT id, email_norm FROM invites WHERE token_hash = ? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > ${lit(now)}`)
      .bind(tokenHash)
      .first<{ id: string; email_norm: string }>();
    if (!invite) {
      log({ event: 'auth_start', requestId: info.requestId, outcome: 'rejected', code: 'invite_invalid' });
      return errorResponse('invite_invalid', 'This invite link is not valid any more: it was used, revoked or has expired');
    }
  }
  const f = randomBytes(32);
  const state = await flowState(f);
  const pre = b64url(randomBytes(32));
  await env.CONSOLE_DB.prepare(
    `INSERT INTO auth_flows (state_hash, start_hash, purpose, pre_cookie_hash, pkce_verifier, nonce, scope, invite_id, login_hint, created_at, expires_at)
     VALUES (?, ?, 'login', ?, ?, ?, 'openid email', ?, ?, ?, ?)`,
  )
    // The PKCE verifier (43 characters, RFC 7636's minimum), and the login nonce in its own domain (spec "Nonce and
    // digest layouts": no step-up, origin-change, settings-change or owner-action nonce can equal one).
    .bind(await sha256(state), await sha256(f), (await cookieHash(pre))!, b64url(randomBytes(32)), await consoleLoginNonce(randomBytes(32)), invite?.id ?? null, invite?.email_norm ?? null, now, now + AUTH_FLOW_TTL_MS)
    .run();
  log({ event: 'auth_start', requestId: info.requestId, outcome: 'ok' });
  return json(200, { startUrl: `${env.CONSOLE_AUTH_ORIGIN}/start?f=${b64url(f)}` }, { 'set-cookie': flowCookie(PRE_COOKIE, pre) });
}

// ---- the auth origin's answers ----

/** The auth origin's CSP: it serves no script, style, image or frame, posts no form and can't be framed. */
export const AUTH_ORIGIN_CSP = "default-src 'none'; frame-ancestors 'none'; form-action 'none'; base-uri 'none'";

/** Every auth-origin response's headers (the console-auth Worker sets them again). */
export function authOriginHeaders(): Record<string, string> {
  return {
    'content-security-policy': AUTH_ORIGIN_CSP,
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'cross-origin-opener-policy': 'same-origin',
    'strict-transport-security': 'max-age=63072000; includeSubDomains',
  };
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/gu, (c) => `&#${c.charCodeAt(0)};`);

/**
 * The static refusal page: no script, no `Location`, one plain link to `<console.origin>/signin#`. The same page for
 * every refusal (`status` 400; 429 rate-limited; 503 when Google, its keys or the secret are unavailable), so it says
 * nothing about which check failed.
 */
export function staticPage(consoleOrigin: string, status: 400 | 429 | 503, setCookie?: string): Response {
  const text = status === 429 ? 'Too many sign-in attempts from your network. Wait a minute, then start again.' : status === 503 ? 'Sign-in is unavailable right now. Try again in a few minutes.' : 'This sign-in link didn’t work. Start again from the console.';
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Hana ID console sign-in</title></head><body><h1>Sign-in didn’t work</h1><p>${escapeHtml(text)}</p><p><a href="${escapeHtml(consoleOrigin)}/signin#">Back to sign-in</a></p></body></html>`;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', ...authOriginHeaders() });
  if (status === 429) headers.set('retry-after', String(CONSOLE_LIMIT_PERIOD_S));
  if (setCookie) headers.append('set-cookie', setCookie);
  return new Response(body, { status, headers });
}

/** The one value of a query parameter, or null when it is missing or repeated. */
function single(url: URL, name: string): string | null {
  const all = url.searchParams.getAll(name);
  return all.length === 1 ? all[0]! : null;
}

// ---- 2. start (auth origin) ----

/** `GET <authOrigin>/start?f=`: 303 to Google, or the static 400 page. */
export async function startFlow(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  if (await authLimited(env, info)) return staticPage(env.CONSOLE_ORIGIN, 429);
  const url = new URL(request.url);
  const f = single(url, 'f');
  if (!f || !B64URL32.test(f) || [...url.searchParams.keys()].length !== 1) return staticPage(env.CONSOLE_ORIGIN, 400);
  if (!env.CONSOLE_GOOGLE_CLIENT_ID) {
    log({ event: 'auth_start', requestId: info.requestId, outcome: 'error', code: 'not_configured' }, 'error');
    return staticPage(env.CONSOLE_ORIGIN, 503);
  }
  const fBytes = fromB64url(f);
  const now = Date.now();
  const af = b64url(randomBytes(32));
  // Found and marked started in one statement: a second /start with the same handle finds nothing.
  const row = await env.CONSOLE_DB.prepare(
    `UPDATE auth_flows SET started_at = ?, af_cookie_hash = ? WHERE start_hash = ? AND started_at IS NULL AND expires_at > ${lit(now)} RETURNING scope, nonce, pkce_verifier, login_hint`,
  )
    .bind(now, (await cookieHash(af))!, await sha256(fBytes))
    .first<{ scope: ConsoleScope; nonce: string; pkce_verifier: string; login_hint: string | null }>();
  if (!row) {
    log({ event: 'auth_start', requestId: info.requestId, outcome: 'rejected', code: 'unknown_flow' });
    return staticPage(env.CONSOLE_ORIGIN, 400);
  }
  const location = authorizationUrl({
    clientId: env.CONSOLE_GOOGLE_CLIENT_ID,
    authOrigin: env.CONSOLE_AUTH_ORIGIN,
    scope: row.scope,
    state: b64url(await flowState(fBytes)),
    nonce: row.nonce,
    codeChallenge: await pkceChallenge(row.pkce_verifier),
    loginHint: row.login_hint,
  });
  const headers = new Headers({ location, ...authOriginHeaders() });
  headers.append('set-cookie', flowCookie(AF_COOKIE, af));
  return new Response(null, { status: 303, headers });
}

// ---- 3. callback (auth origin) ----

/** The handoff row's result: the verified identity only, never a token (D291). Scrubbed when the code is used. */
export interface HandoffResult {
  provider: string;
  sub: string;
  email: string;
  hd: string | null;
}

/** `GET <authOrigin>/callback?code&state`: 303 to `<console.origin>/api/auth/complete?h=…#`, or the static page. */
export async function callback(request: Request, env: Env, info: RequestInfo): Promise<Response> {
  if (await authLimited(env, info)) return staticPage(env.CONSOLE_ORIGIN, 429);
  const url = new URL(request.url);
  const refuse = (code: string, status: 400 | 503 = 400, claim?: string) => {
    log({ event: 'auth_callback', requestId: info.requestId, outcome: status === 503 ? 'error' : 'rejected', code, ...(claim ? { claim } : {}) }, status === 503 ? 'error' : 'info');
    return staticPage(env.CONSOLE_ORIGIN, status, clearFlowCookie(AF_COOKIE));
  };
  // Google's `error=` (access_denied, …) and every malformed query: no flow is touched.
  if (url.searchParams.has('error')) return refuse('google_error');
  const code = single(url, 'code');
  const state = single(url, 'state');
  if (!code || !state || code.length > MAX_CODE || !B64URL32.test(state)) return refuse('bad_query');
  const afHash = await cookieHash(readCookie(request.headers.get('cookie'), AF_COOKIE));
  if (!afHash) return refuse('no_flow_cookie');
  const now = Date.now();
  const stateHash = await sha256(fromB64url(state));
  // Found and marked used in one statement, only with this browser's flow cookie: a wrong cookie consumes nothing.
  const flow = await env.CONSOLE_DB.prepare(
    `UPDATE auth_flows SET used_at = ? WHERE state_hash = ? AND af_cookie_hash = ? AND started_at IS NOT NULL AND used_at IS NULL AND expires_at > ${lit(now)}
      RETURNING purpose, scope, nonce, pkce_verifier`,
  )
    .bind(now, stateHash, afHash)
    .first<{ purpose: 'login' | 'step_up'; scope: ConsoleScope; nonce: string; pkce_verifier: string }>();
  if (!flow) return refuse('unknown_flow');
  // The verifier is needed once, now: it doesn't stay in D1 for the daily purge.
  await env.CONSOLE_DB.prepare("UPDATE auth_flows SET pkce_verifier = '' WHERE state_hash = ?").bind(stateHash).run();
  // Step-ups (fresh sign-in) are batch C10's: no step-up flow can be created yet, so none can arrive here.
  if (flow.purpose !== 'login') return refuse('step_up_unsupported');
  if (!env.CONSOLE_GOOGLE_CLIENT_ID || !env.CONSOLE_GOOGLE_CLIENT_SECRET) return refuse('not_configured', 503);
  const exchange = await exchangeCode({ code, verifier: flow.pkce_verifier, clientId: env.CONSOLE_GOOGLE_CLIENT_ID, clientSecret: env.CONSOLE_GOOGLE_CLIENT_SECRET, authOrigin: env.CONSOLE_AUTH_ORIGIN });
  if (!exchange.ok) return refuse(exchange.code, exchange.code === 'google_unavailable' ? 503 : 400);
  const verified = await verifyConsoleToken(exchange.idToken, { clientId: env.CONSOLE_GOOGLE_CLIENT_ID, nonce: flow.nonce, scope: flow.scope, now, accessToken: exchange.accessToken });
  if (!verified.ok) return refuse(verified.code, verified.code === 'jwks_unavailable' ? 503 : 400, verified.claim);
  const id = verified.identity;
  const result: HandoffResult = { provider: id.provider, sub: id.sub, email: id.email!, hd: id.hd };
  const h = randomBytes(32);
  await env.CONSOLE_DB.prepare('INSERT INTO handoff_codes (code_hash, state_hash, result_json, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256(h), stateHash, JSON.stringify(result), now + HANDOFF_TTL_MS)
    .run();
  log({ event: 'auth_callback', requestId: info.requestId, outcome: 'ok' });
  const headers = new Headers({ location: `${env.CONSOLE_ORIGIN}/api/auth/complete?h=${b64url(h)}#`, ...authOriginHeaders() });
  headers.append('set-cookie', clearFlowCookie(AF_COOKIE));
  return new Response(null, { status: 303, headers });
}
