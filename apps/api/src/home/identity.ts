// Hana Home's identity verifier (docs/hana-home-spec.md "Identity without a user database", D463, D473): every Home API
// call carries `x-hana-home`, a token whose nonce commits to a key only the /home page holds, and a fresh signature by
// that key over the request. `homeGate` answers who the user is, or the refusal, as `appGate` does for app endpoints:
// `{provider, sub}` with no chain transaction, no cookie (D70) and no stored account. Nothing here derives a key.
//
// The API checks, in the spec's order: `Origin === AUTH_ORIGIN`; the per-IP limit; the token (signature, `iss`, `exp`
// with 60 s skew, the claim allow-list, login-token.ts); `aud` is a shared or exit Google client in force or the email issuer's
// Home audience while it is on the chain's exit list, never a scope client (a partner-held client could mint a Home token
// for its users and read or revoke their consents in every app, since `sub` is global); nonce = `homeNonce`; `now < expiresAtMs ≤ now + 20 min`; the Home
// key's signature; the per-Home-key limit; then `(sha256(hk_pub), counter)` is marked single use until `expiresAtMs` in
// the RateLimiter object's `mark:` store. A failed check spends nothing that a later check would use.
//
// SECURITY: nothing here logs or returns the header, the token, a `sub` or a path hash; a refusal carries a fixed error
// and code only.
import { decodeHomeIdentity, HOME_EMAIL_AUDIENCE, HOME_IDENTITY_HEADER, HOME_IDENTITY_MAX_LIFETIME_MS, homeMessage, homeNonce, homeRequestPath } from '@hana-id/core/home';
import { GOOGLE_PROVIDER } from '@hana-id/jwks';
import { hex, sha256 } from '../bytes.ts';
import { EMAIL_PROVIDER } from '../email-token.ts';
import type { Env } from '../env.ts';
import { type Ctx, ipKey, limiter, reject } from '../handlers.ts';
import { corsHeaders, readBody } from '../http.ts';
import { verifyLoginToken } from '../login-token.ts';
import { hanaPage } from '../origins.ts';
import type { Limit } from '../rate-limiter.ts';
import { MAX_BODY, isToken } from '../validate.ts';
import { type ConfigView, getConfig, isExitClient, isSharedClient } from '../views.ts';

const HOME_ALLOW_HEADERS = `content-type, ${HOME_IDENTITY_HEADER}`;
const HOME_METHODS = 'GET, POST, OPTIONS';
const MINUTE = 60_000;
const NO_BODY = new Uint8Array(0);

/** Whether the request comes from the Hana auth origin, the only origin Home runs on (spec item 15; the API's origin rule, origins.ts). */
export const isHomeOrigin = (request: Request, env: Env): boolean => hanaPage(env, request.headers.get('origin')) === 'auth';

/** CORS for a Home response; only ever echoes `AUTH_ORIGIN`, which `isHomeOrigin` has just matched. */
export const homeCors = (origin: string): Record<string, string> => corsHeaders(origin, HOME_ALLOW_HEADERS, HOME_METHODS);

/** `OPTIONS` on a Home endpoint: `AUTH_ORIGIN` only (the browser doesn't send `x-hana-home` on a preflight). */
export function homePreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (origin && isHomeOrigin(request, env)) return new Response(null, { status: 204, headers: homeCors(origin) });
  return new Response(null, { status: 403, headers: { vary: 'Origin' } });
}

export type HomeRoute = 'shared' | 'email' | 'exit';

/**
 * Which route a token's audience makes it a Home identity through, or null: an exit Google client in force (D468,
 * only where a scope's normal route is gone, D490) or a shared Google client in force (retired and still-pending ones
 * refused), or the email issuer's Home audience while `("email", HOME_EMAIL_AUDIENCE)` is on the exit list in force (the
 * council's emergency removal stops email Home as it stops Google's exit, D483). Never a scope client: the contract keeps
 * exit, shared and scope clients disjoint (`exit.rs` `set_exit_clients`, registry.rs `assert_client_available`, lib.rs
 * `set_shared_clients`), and a retired shared or exit client can never be claimed by a scope. A partner login never reaches
 * this: `checkClientScope` stays closed to exit clients. No config, an old contract (no list), or an empty list reads as no
 * exit client, so those clients and the email audience are refused (fail closed): "never listed" and "removed in an
 * emergency" look the same here, and refusing is right for both.
 */
export function homeAudienceRoute(config: ConfigView | null, provider: string, aud: string, now: number): HomeRoute | null {
  if (provider === EMAIL_PROVIDER) return aud === HOME_EMAIL_AUDIENCE && config && isExitClient(config, provider, aud, now) ? 'email' : null;
  if (provider === GOOGLE_PROVIDER && config) {
    if (isExitClient(config, provider, aud, now)) return 'exit';
    if (isSharedClient(config, provider, aud, now)) return 'shared';
  }
  return null;
}

/** Who a verified Home request is for. `{provider, sub}` is the user's global identity (`sub` is the same across clients). */
export interface HomeIdentity {
  provider: string;
  sub: string;
  /** Which route admitted the token (`homeAudienceRoute`). */
  route: HomeRoute;
  expiresAtMs: number;
  /** hex(sha256(hk_pub)): names this Home key's limiter object. Internal, never logged or returned. */
  keyHash: string;
}

export type HomeGate = { ok: true; identity: HomeIdentity; body: Uint8Array } | { ok: false; response: Response };

export interface HomeGateOptions {
  /** Requests a minute per IP (the spec's table), counted before anything is parsed. */
  ipPerMinute: number;
  /** Requests a minute per Home key, counted once the signature checks out. */
  keyPerMinute: number;
  /** Names the two windows, so endpoints with limits of their own don't share them (e.g. `apps`). */
  window: string;
}

/**
 * The gate of every Home endpoint that needs an identity (see the top of this file). A POST's body is read here (at most
 * MAX_BODY) because the signature covers it; the raw bytes come back with the identity for the handler to parse.
 */
export async function homeGate(request: Request, env: Env, ctx: Ctx, opts: HomeGateOptions, now: number = Date.now()): Promise<HomeGate> {
  const fail = (status: number, code: string, error: string, extra: Record<string, string> = {}): HomeGate => ({ ok: false, response: reject(ctx, status, code, error, extra) });

  // 1. Origin: AUTH_ORIGIN only. The answer is readable only by it (no CORS headers until this passes).
  if (!isHomeOrigin(request, env)) return fail(403, 'origin_not_allowed', 'Origin not allowed');
  const origin = request.headers.get('origin') as string;
  ctx.cors = homeCors(origin);

  // 2. Per-IP limit, before any work on the request (as appGate).
  try {
    const hit = await limiter(env, ipKey(request)).hit([{ name: `home:${opts.window}:ip`, windowMs: MINUTE, max: opts.ipPerMinute }], now);
    if (!hit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }

  // 3. The header: its shape and sizes, without touching the token yet.
  const headerValue = request.headers.get(HOME_IDENTITY_HEADER);
  if (headerValue === null) return fail(401, 'missing_home_identity', 'x-hana-home header is required');
  const header = decodeHomeIdentity(headerValue);
  if (!header || !isToken(header.jwt)) return fail(401, 'invalid_home_identity', 'Malformed x-hana-home header');

  // 4. The token: signature, iss, exp (60 s skew), the claim allow-list.
  const verified = await verifyLoginToken(env, header.jwt, now, { anyLoginMethod: true });
  if (!verified.ok) {
    // A credential problem is a 401 for the page ("sign in again"); only an outage stays 5xx. Never `data`.
    const status = verified.status >= 500 ? verified.status : 401;
    return fail(status, verified.code, verified.error, verified.retryAfterS !== undefined ? { 'retry-after': String(verified.retryAfterS) } : {});
  }
  const token = verified.token;

  // 5. aud: a shared or exit Google client in force, or the issuer's Home audience while the exit list has it (the cached
  // `get_config`, so a client removed in an emergency can pass for up to 60 s more on an isolate, as for Google).
  let config: ConfigView;
  try {
    config = await getConfig(env);
  } catch {
    return fail(502, 'near_unavailable', 'Could not read the Home clients');
  }
  const route = homeAudienceRoute(config, token.provider, token.aud, now);
  if (!route) return fail(401, 'not_a_home_client', 'The token is not for a client Hana Home accepts');

  // 6. Nonce = homeNonce(key, expiresAtMs, salt): the token commits to this Home key.
  const nonce = homeNonce({ signer: env.SIGNER_ACCOUNT, homePublicKey: header.key, expiresAtMs: header.expiresAtMs, salt: header.salt });
  if (token.nonce !== nonce) return fail(401, 'nonce_mismatch', 'The token’s nonce is not this Home key’s');

  // 7. now < expiresAtMs ≤ now + 20 min.
  if (header.expiresAtMs <= now) return fail(401, 'home_identity_expired', 'The Home sign-in has ended, sign in again');
  if (header.expiresAtMs > now + HOME_IDENTITY_MAX_LIFETIME_MS) return fail(401, 'invalid_home_identity', 'The Home sign-in lasts too long');

  // 8. The Home key's signature over this request.
  let body: Uint8Array = NO_BODY;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const read = await readBody(request, MAX_BODY);
    if (!read.ok) return fail(read.status, 'bad_request', read.error);
    body = read.bytes;
  }
  const url = new URL(request.url);
  const message = homeMessage({ signer: env.SIGNER_ACCOUNT, counter: header.counter, method: request.method, path: homeRequestPath(url), body });
  if (!(await verifyHomeSignature(header.key, header.sig, message))) return fail(401, 'invalid_signature', 'Invalid Home key signature');

  // 9. The per-Home-key limit: only signed requests count, and a refused one doesn't spend its counter.
  const keyHash = hex(await sha256(header.key));
  const keyLimiter = limiter(env, `home-key:${keyHash}`);
  const keyWindow: Limit[] = [{ name: `home:${opts.window}:key`, windowMs: MINUTE, max: opts.keyPerMinute }];
  try {
    const hit = await keyLimiter.hit(keyWindow, now);
    if (!hit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (per Home key per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }

  // 10. Single use: (sha256(hk_pub), counter) until expiresAtMs (a counter is any unused u64, so concurrent calls work).
  try {
    if (!(await keyLimiter.reserve(`counter:${header.counter}`, header.expiresAtMs, now))) return fail(409, 'counter_reused', 'This Home request was already sent');
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }

  return { ok: true, identity: { provider: token.provider, sub: token.sub, route, expiresAtMs: header.expiresAtMs, keyHash }, body };
}

/** Ed25519 (WebCrypto, native: well inside sandbox-dev's 10 ms CPU, D417) over the Home message. False on any malformed key or signature. */
async function verifyHomeSignature(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey as BufferSource, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature as BufferSource, message as BufferSource);
  } catch {
    return false;
  }
}
