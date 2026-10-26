// Request handlers: app endpoints (publishable key + origin), owner actions (OIDC proof in args), health.
import { type App, PUBLISHABLE_KEY_RE, anyActiveAppAllowsOrigin, getAppByKey, incrementUsage, originAllowed } from './apps.ts';
import type { Env } from './env.ts';
import { type Headers_, corsHeaders, json, readJson } from './http.ts';
import { decodeUnverifiedClaims, providerForIssuer } from './jwt.ts';
import { ipSubject } from './ip.ts';
import { log } from './log.ts';
import { JwksUnavailableError } from './jwks.ts';
import { precheckOwnerAction } from './owner-actions.ts';
import type { RateLimiter } from './rate-limiter.ts';
import { relay } from './relayer-pool.ts';
import { MAX_BODY, isError, toCreateSession, toDeriveKey, toOwnerAction, toRevokeSession } from './validate.ts';
import { forgetScope, forgetSession, getSession, isSessionView, rememberSession, scopeForClient } from './views.ts';

const APP_ALLOW_HEADERS = 'content-type, x-hana-key';
/** Owner actions are unauthenticated at the API (the proof is in the args): keep them slow. */
export const OWNER_ACTIONS_PER_IP_MINUTE = 10;
/**
 * Global caps on relayed owner actions (only requests that passed every off-chain check count). They share the
 * relayer allowance with logins, so this bounds what they can ever spend: legitimate use is a handful a day.
 */
export const OWNER_ACTIONS_GLOBAL_MINUTE = 20;
export const OWNER_ACTIONS_GLOBAL_DAY = 200;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export type AppEndpoint = '/v1/sessions' | '/v1/derive' | '/v1/sessions/revoke';
export const APP_ENDPOINTS: readonly string[] = ['/v1/sessions', '/v1/derive', '/v1/sessions/revoke'];

interface Ctx {
  env: Env;
  requestId: string;
  endpoint: string;
  started: number;
  cors: Headers_;
  appId?: string;
}

function done(ctx: Ctx, status: number, body: Record<string, unknown>, extra: Headers_ = {}): Response {
  const ok = status < 400;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const nearTx = typeof body.nearTx === 'string' ? body.nearTx : undefined;
  log(
    {
      event: 'request',
      requestId: ctx.requestId,
      appId: ctx.appId,
      endpoint: ctx.endpoint,
      outcome: ok ? 'ok' : status >= 500 ? 'error' : 'rejected',
      status,
      code,
      nearTx,
      latencyMs: Date.now() - ctx.started,
    },
    status >= 500 ? 'error' : 'info',
  );
  return json(status, { ...body, requestId: ctx.requestId }, { ...ctx.cors, 'x-request-id': ctx.requestId, ...extra });
}

const reject = (ctx: Ctx, status: number, code: string, error: string, extra: Headers_ = {}): Response => done(ctx, status, { error, code }, extra);

/** Per-IP limiter subject: IPv4 address, or the IPv6 /64 (see ip.ts). */
function ipKey(request: Request): string {
  return `ip:${ipSubject(request.headers.get('cf-connecting-ip'))}`;
}

function limiter(env: Env, name: string): DurableObjectStub<RateLimiter> {
  return env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));
}

// ---- Preflight ----

export async function appPreflight(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && (await anyActiveAppAllowsOrigin(env.DB, origin))) return new Response(null, { status: 204, headers: corsHeaders(origin, APP_ALLOW_HEADERS) });
  return new Response(null, { status: 403, headers: { vary: 'Origin' } });
}

export function openPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders('*', 'content-type') });
}

// ---- App endpoints ----

export async function handleAppEndpoint(request: Request, env: Env, endpoint: AppEndpoint, requestId: string): Promise<Response> {
  const ctx: Ctx = { env, requestId, endpoint, started: Date.now(), cors: {} };
  const now = Date.now();

  // 1. App exists and is active.
  const key = request.headers.get('x-hana-key');
  if (!key) return reject(ctx, 401, 'missing_key', 'x-hana-key header is required');
  if (!PUBLISHABLE_KEY_RE.test(key)) return reject(ctx, 401, 'unknown_app', 'Unknown publishable key');
  let app: App | null;
  try {
    app = await getAppByKey(env.DB, key);
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again');
  }
  if (!app) return reject(ctx, 401, 'unknown_app', 'Unknown publishable key');
  ctx.appId = app.id;
  const origin = request.headers.get('origin');
  const allowed = originAllowed(app, origin);
  if (allowed && origin) ctx.cors = corsHeaders(origin, APP_ALLOW_HEADERS);
  if (app.status !== 'active') return reject(ctx, 403, 'app_suspended', 'This app is suspended');

  // 2. Origin.
  if (!allowed) return reject(ctx, 403, 'origin_not_allowed', 'Origin not allowed for this app');

  // 3. Rate limits: per IP per minute first, then per app per minute and per day. The IP check comes first so a
  //    request it rejects never uses up the app's shared quota (one client could otherwise lock out every user).
  try {
    const ipHit = await limiter(env, ipKey(request)).hit([{ name: `${app.id}:minute`, windowMs: MINUTE, max: app.per_ip_minute }]);
    if (!ipHit.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(ipHit.retryAfterS) });
    const appHit = await limiter(env, `app:${app.id}`).hit([
      { name: 'minute', windowMs: MINUTE, max: app.per_minute },
      { name: 'day', windowMs: DAY, max: app.per_day },
    ]);
    if (!appHit.ok) return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (app per ${appHit.limit})`, { 'retry-after': String(appHit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  // 4. Argument shapes.
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);

  if (endpoint === '/v1/sessions') {
    const call = toCreateSession(parsed.body, now);
    if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);

    // 5. The token must be for a client registered to this app's scope.
    const claims = decodeUnverifiedClaims(call.jwt);
    if (!claims) return reject(ctx, 400, 'bad_request', 'jwt is not a readable ID token');
    const provider = providerForIssuer(claims.iss);
    if (!provider) return reject(ctx, 400, 'unsupported_issuer', 'Unsupported token issuer');
    if (claims.exp !== null && claims.exp * 1000 <= now) return reject(ctx, 400, 'token_expired', 'The ID token has expired');
    let scope: string | null;
    try {
      scope = await scopeForClient(env, provider, claims.aud);
    } catch {
      return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    }
    if (scope === null) return reject(ctx, 403, 'unregistered_client', 'Token is for an unregistered app');
    if (scope !== app.scope_id) return reject(ctx, 403, 'scope_mismatch', 'Token is for a different app');

    const result = await relay(env, { method: call.method, args: call.args }, requestId);
    if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
    if (!isSessionView(result.result)) return done(ctx, 502, { error: 'The contract returned no session', code: 'bad_contract_result', nearTx: result.nearTx });
    rememberSession(call.args.session_public_key as number[], result.result);
    await countUsage(env, app.id, 'sessions', ctx);
    return done(ctx, 200, { result: result.result, nearTx: result.nearTx });
  }

  const call = endpoint === '/v1/derive' ? toDeriveKey(parsed.body) : toRevokeSession(parsed.body);
  if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);

  // 5. The session must belong to this app's scope.
  let session;
  try {
    session = await getSession(env, call.sessionPublicKey);
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the session');
  }
  if (!session) return reject(ctx, 404, 'unknown_session', 'Unknown or expired session');
  if (session.scope_id !== app.scope_id) return reject(ctx, 403, 'scope_mismatch', 'Session belongs to a different app');
  if (session.expires_at_ms <= now) return reject(ctx, 404, 'unknown_session', 'Unknown or expired session');

  const result = await relay(env, { method: call.method, args: call.args }, requestId);
  if (endpoint === '/v1/sessions/revoke') forgetSession(call.sessionPublicKey);
  if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
  if (endpoint === '/v1/derive') {
    const r = result.result as { big_y?: unknown; big_c?: unknown } | null;
    if (!r || typeof r.big_y !== 'string' || typeof r.big_c !== 'string') return done(ctx, 502, { error: 'The contract returned no key', code: 'bad_contract_result', nearTx: result.nearTx });
    await countUsage(env, app.id, 'derives', ctx);
    return done(ctx, 200, { result: { big_y: r.big_y, big_c: r.big_c }, nearTx: result.nearTx });
  }
  return done(ctx, 200, { result: null, nearTx: result.nearTx });
}

async function countUsage(env: Env, appId: string, field: 'sessions' | 'derives', ctx: Ctx): Promise<void> {
  try {
    await incrementUsage(env.DB, appId, field);
  } catch {
    log({ event: 'usage_increment_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint }, 'error');
  }
}

// ---- Owner actions ----

export async function handleOwnerAction(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx: Ctx = { env, requestId, endpoint: '/v1/owner-actions', started: Date.now(), cors: corsHeaders('*', 'content-type') };
  try {
    const hit = await limiter(env, ipKey(request)).hit([{ name: 'owner-actions:minute', windowMs: MINUTE, max: OWNER_ACTIONS_PER_IP_MINUTE }]);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const call = toOwnerAction(parsed.body);
  if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);

  // Off-chain checks: a request that would certainly fail on chain is not relayed (it would still cost gas).
  let check;
  try {
    check = await precheckOwnerAction(env, call);
  } catch (err) {
    if (err instanceof JwksUnavailableError) return reject(ctx, 503, 'issuer_keys_unavailable', 'Could not read the token issuer keys, try again');
    return reject(ctx, 502, 'near_unavailable', 'Could not read the registry');
  }
  if (!check.ok) return reject(ctx, check.status, check.code, check.error);

  const tokens = limiter(env, 'owner-actions:tokens');
  try {
    // An owner token is bound to one action by its nonce: once it has been used on chain it can only fail.
    if (check.authToken && (await tokens.isMarked(check.authToken.hash))) return reject(ctx, 409, 'token_used', 'This owner token was already used, get a fresh one');
    const global = await limiter(env, 'owner-actions:global').hit([
      { name: 'minute', windowMs: MINUTE, max: OWNER_ACTIONS_GLOBAL_MINUTE },
      { name: 'day', windowMs: DAY, max: OWNER_ACTIONS_GLOBAL_DAY },
    ]);
    if (!global.ok) return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (owner actions per ${global.limit})`, { 'retry-after': String(global.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  const result = await relay(env, call, requestId);
  forgetScope(check.scopeId);
  if (check.authToken && (result.ok || result.code === 'contract_rejected')) {
    try {
      await tokens.mark(check.authToken.hash, check.authToken.expMs);
    } catch {
      log({ event: 'owner_token_mark_failed', requestId, endpoint: ctx.endpoint }, 'warn');
    }
  }
  if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
  return done(ctx, 200, { result: result.result ?? null, nearTx: result.nearTx });
}

// ---- Health ----

export function handleHealth(env: Env, requestId: string): Response {
  return json(200, { ok: true, env: env.ENV_NAME, signer: env.SIGNER_ACCOUNT, requestId }, { 'access-control-allow-origin': '*', 'x-request-id': requestId });
}
