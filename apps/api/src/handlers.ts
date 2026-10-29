// Request handlers: app endpoints (publishable key + origin), owner actions (OIDC proof in args), health.
import { type App, PUBLISHABLE_KEY_RE, getAppByKey, incrementUsage } from './apps.ts';
import { appKeyPairs } from './bls.ts';
import { disallowedClaim } from './claims.ts';
import type { Env } from './env.ts';
import { type Headers_, corsHeaders, json, readJson } from './http.ts';
import { ipSubject } from './ip.ts';
import { log } from './log.ts';
import { placedStub } from './placement.ts';
import { JwksUnavailableError, verifyIdToken } from './jwks.ts';
import { keyObserver } from './key-observations.ts';
import { type Caller, PARENT_ORIGIN_HEADER, RELAY_KEY_HEADER, checkCaller, preflightAllows } from './origins.ts';
import { precheckOwnerAction, sha256Hex } from './owner-actions.ts';
import type { Limit, RateLimiter } from './rate-limiter.ts';
import type { RelayInstance, RelayTiming } from './relayer-key.ts';
import { relay } from './relayer-pool.ts';
import { ckdPayload, revokePayload, sessionNonce, verifySessionSignature } from './session-crypto.ts';
import { claimCounter, precheckSessionUse } from './session-use.ts';
import { MAX_BODY, isError, toCreateSession, toDeriveKey, toOwnerAction, toRevokeSession } from './validate.ts';
import { type AppSettings, effectiveSettings, getSettingsRow } from './vault/settings.ts';
import { effectiveSharedClients, forgetScope, forgetSession, getConfig, getScope, isIssuerKeyActive, isSessionView, isSharedClient, recordSessionUse, rememberSession, scopeForClient, sessionKeyInUse } from './views.ts';

const APP_ALLOW_HEADERS = `content-type, x-hana-key, ${PARENT_ORIGIN_HEADER}, ${RELAY_KEY_HEADER}`;
const APP_METHODS = 'GET, POST, OPTIONS';
/** Owner actions are unauthenticated at the API (the proof is in the args): keep them slow. */
export const OWNER_ACTIONS_PER_IP_MINUTE = 10;
/**
 * Caps on relayed owner actions (only requests that passed every off-chain check count; D100, security sweep APIW-3).
 * They are paid from the owner pool (OWNER_RELAYER_KEYS, small allowance), never from the login pool. Asked from the
 * most specific in, so one owner's excess stops at its own window and never reaches what other scopes share; a
 * request refused by a later window is taken back from the earlier ones (`unhit`), so a refusal costs nothing:
 * - authenticated actions (propose_change, remove_client, disable_shared_login): per owner identity (provider, sub),
 *   then per scope, then the global ceiling that bounds the pool's spend;
 * - execute_change (no auth, anyone may send it): its own per-scope window, never the one the scope's owners use, then
 *   the global ceiling;
 * - cancel_change: none of the above. Its own allowance per owner identity, then per scope (keyed by the target
 *   scope: only that scope's on-chain owners pass the precheck, so only they can fill it, and it is sized for all
 *   CONTRACT_MAX_OWNERS of them at once), then a high cancel-only global ceiling that is only a spend bound. No other
 *   scope's owners, no shared traffic and no execute flood can starve a timelock's cancel window; within the scope,
 *   only all of its owners together can. A cancel without an owner identity is refused (fail closed).
 */
export const OWNER_ACTIONS_PER_OWNER_MINUTE = 5;
export const OWNER_ACTIONS_PER_OWNER_DAY = 30;
export const OWNER_ACTIONS_PER_SCOPE_MINUTE = 10;
export const OWNER_ACTIONS_PER_SCOPE_DAY = 50;
export const EXECUTES_PER_SCOPE_MINUTE = 10;
export const EXECUTES_PER_SCOPE_DAY = 50;
export const OWNER_ACTIONS_GLOBAL_MINUTE = 20;
export const OWNER_ACTIONS_GLOBAL_DAY = 200;
export const CANCELS_PER_OWNER_MINUTE = 5;
export const CANCELS_PER_OWNER_DAY = 20;
/** hana-signer's `MAX_OWNERS` per scope (registry.rs; scripts/test/contract-constants.test.ts keeps them equal). */
export const CONTRACT_MAX_OWNERS = 5;
/** hana-signer's `MAX_PENDING` changes per scope: at most this many cancels can pass the precheck at a time. */
export const CONTRACT_MAX_PENDING = 10;
/** Per scope: every owner's whole allowance at once, so fewer than all of a scope's owners can never fill it. */
export const CANCELS_PER_SCOPE_MINUTE = CONTRACT_MAX_OWNERS * CANCELS_PER_OWNER_MINUTE;
export const CANCELS_PER_SCOPE_DAY = CONTRACT_MAX_OWNERS * CANCELS_PER_OWNER_DAY;
/**
 * A spend bound only (the owner pool's allowance is the hard one). Filling the minute window takes 20 owner
 * identities at their own cap (≥ 4 scopes the attacker fully owns, at CONTRACT_MAX_OWNERS each); the day window takes
 * 50 identities (≥ 10 such scopes) and 1000 cancellable changes, which is ≥ 100 scopes' CONTRACT_MAX_PENDING at once
 * or more proposals than the shared OWNER_ACTIONS_GLOBAL_DAY lets through in five days.
 */
export const CANCELS_GLOBAL_MINUTE = 100;
export const CANCELS_GLOBAL_DAY = 1000;
/** Clock skew tolerated on an ID token's `exp` (the contract checks `exp` against the block time again). */
export const TOKEN_EXP_SKEW_MS = 60_000;
const MINUTE = 60_000;
/** Relay failures after which the transaction certainly did not execute (see relayer-key.ts / relayer-pool.ts). */
const NOT_EXECUTED: ReadonlySet<string> = new Set(['method_not_allowed', 'relayer_unconfigured', 'near_unavailable', 'near_rejected', 'relayer_busy']);
const DAY = 24 * 60 * MINUTE;
/**
 * Retry-After of a token refused because its signing key is still in the contract's issuer-key delay
 * (`issuer_key_pending`): the vault retries the login once after it (docs/governance-spec.md "Rotation and logins").
 */
export const ISSUER_KEY_PENDING_RETRY_S = 30;
/** Retry-After while the contract is paused (`paused`): only the owner multisig unpauses. */
export const PAUSED_RETRY_S = 60;

export type AppEndpoint = '/v1/sessions' | '/v1/derive' | '/v1/sessions/revoke';
export const APP_ENDPOINTS: readonly string[] = ['/v1/sessions', '/v1/derive', '/v1/sessions/revoke'];
export const APP_CONFIG_ENDPOINT = '/v1/app';

export interface Ctx {
  env: Env;
  requestId: string;
  endpoint: string;
  started: number;
  cors: Headers_;
  appId?: string;
  /** Data center that ran the request (logged). */
  colo?: string;
  /** Stage durations for the request log, filled by `lap`. */
  phases?: Record<string, number>;
  /** The relayer key instance behind a relay (request log). */
  relayInstance?: RelayInstance;
  lapAt?: number;
  /**
   * A pk_test_ app's request to an endpoint that reports its timings (`/v1/login`, `/v1/vault/shares`,
   * `/v1/vault/unlock`): a success carries `timings` (see `done`). Never set for pk_live_ apps.
   */
  exposeTimings?: boolean;
}

export function newCtx(env: Env, requestId: string, endpoint: string, request?: Request, cors: Headers_ = {}): Ctx {
  const started = Date.now();
  const colo = (request as Request<unknown, IncomingRequestCfProperties> | undefined)?.cf?.colo;
  return { env, requestId, endpoint, started, cors, colo: typeof colo === 'string' ? colo : undefined, phases: {}, lapAt: started };
}

/** Records the time since the previous lap (or the start) as stage `name`. */
export function lap(ctx: Ctx, name: string): void {
  const now = Date.now();
  if (ctx.phases) ctx.phases[name] = now - (ctx.lapAt ?? ctx.started);
  ctx.lapAt = now;
}

/**
 * Records a relay's stages: the round trip to the relayer key object and, inside it, nonce + broadcast vs outcome,
 * with the broadcast split into queue / chain reads / signing / nonce reservation (see RelayTiming).
 */
export function lapRelay(ctx: Ctx, result: { timing?: RelayTiming; instance?: RelayInstance }): void {
  lap(ctx, 'relay');
  ctx.relayInstance = result.instance;
  const t = result.timing;
  if (ctx.phases && t) {
    ctx.phases.relayDispatch = t.dispatchMs;
    ctx.phases.relayQueue = t.queueMs;
    ctx.phases.relayChainRead = t.chainReadMs;
    ctx.phases.relaySign = t.signMs;
    ctx.phases.relayPersist = t.persistMs;
    ctx.phases.relayOutcome = t.outcomeMs;
  }
}

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };
/** Never rejects, so a check started early and then not needed can't become an unhandled rejection. */
export const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

/**
 * The request's own timings, as a pk_test_ app's response carries them (docs/api.md "Timings"): `totalMs` since the
 * request reached this Worker and the logged phases. Durations only (the Workers clock moves on I/O, so CPU-only work
 * shows as 0); nothing else from the request.
 */
export function serverTimings(ctx: Ctx, now = Date.now()): { totalMs: number; phases: Record<string, number> } {
  return { totalMs: Math.max(0, now - ctx.started), phases: { ...(ctx.phases ?? {}) } };
}

export function done(ctx: Ctx, status: number, body: Record<string, unknown>, extra: Headers_ = {}): Response {
  const ok = status < 400;
  const code = typeof body.code === 'string' ? body.code : undefined;
  const nearTx = typeof body.nearTx === 'string' ? body.nearTx : undefined;
  const timings = ok && ctx.exposeTimings ? serverTimings(ctx) : null;
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
      phases: ctx.phases && Object.keys(ctx.phases).length > 0 ? ctx.phases : undefined,
      colo: ctx.colo,
      relayInstance: ctx.relayInstance,
    },
    status >= 500 ? 'error' : 'info',
  );
  return json(status, { ...body, ...(timings ? { timings } : {}), requestId: ctx.requestId }, { ...ctx.cors, 'x-request-id': ctx.requestId, ...extra });
}

export const reject = (ctx: Ctx, status: number, code: string, error: string, extra: Headers_ = {}): Response => done(ctx, status, { error, code }, extra);

/** Per-IP limiter subject: IPv4 address, or the IPv6 /64 (see ip.ts). */
export function ipKey(request: Request): string {
  return `ip:${ipSubject(request.headers.get('cf-connecting-ip'))}`;
}

/** Per-IP limiters are created near their client; shared ones (per app, owner actions) in the configured region. */
export function limiter(env: Env, name: string): DurableObjectStub<RateLimiter> {
  return name.startsWith('ip:') ? env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name)) : placedStub(env, env.RATE_LIMITER, name);
}

// ---- Preflight ----

export async function appPreflight(request: Request, env: Env): Promise<Response> {
  const origin = request.headers.get('origin');
  if (origin && (await preflightAllows(env.DB, env, origin))) return new Response(null, { status: 204, headers: corsHeaders(origin, APP_ALLOW_HEADERS, APP_METHODS) });
  return new Response(null, { status: 403, headers: { vary: 'Origin' } });
}

export function openPreflight(): Response {
  return new Response(null, { status: 204, headers: corsHeaders('*', 'content-type') });
}

// ---- App checks shared by every app endpoint ----

/** `caller`: who called (a Hana page and the partner origin it acts for, or a partner page), see origins.ts. */
export type Gate = { ok: true; app: App; caller: Caller } | { ok: false; response: Response };

/**
 * Checks 1–3: the app exists and is active, the caller may call this endpoint (`ctx.endpoint`) for it (origins.ts:
 * Hana pages for an allowed `x-hana-parent-origin`, partner pages by key type and env), and the per-IP limit. `relay`
 * endpoints count against the plan's per-IP window here, and against the app's minute and day quota only once every
 * off-chain check has passed, right before the relay (`appQuota`, D100): the publishable key and the Origin headers
 * are public and forgeable, so a request that fails a token, nonce or signature check must never use up the quota
 * every user of the app shares. `config` (GET /v1/app, no transaction) counts only against a per-IP window of its
 * own, so reading the config never uses up the app's relay quota.
 */
export async function appGate(request: Request, env: Env, ctx: Ctx, kind: 'relay' | 'config'): Promise<Gate> {
  const fail = (status: number, code: string, error: string, extra: Headers_ = {}): Gate => ({ ok: false, response: reject(ctx, status, code, error, extra) });
  // 1. App exists and is active.
  const key = request.headers.get('x-hana-key');
  if (!key) return fail(401, 'missing_key', 'x-hana-key header is required');
  if (!PUBLISHABLE_KEY_RE.test(key)) return fail(401, 'unknown_app', 'Unknown publishable key');
  let app: App | null;
  try {
    app = await getAppByKey(env.DB, key);
  } catch {
    return fail(503, 'config_unavailable', 'App config is unavailable, try again');
  }
  lap(ctx, 'app');
  if (!app) return fail(401, 'unknown_app', 'Unknown publishable key');
  ctx.appId = app.id;
  const caller = checkCaller(env, app, ctx.endpoint, request.headers);
  if (caller.cors) ctx.cors = corsHeaders(caller.cors, APP_ALLOW_HEADERS, APP_METHODS);
  if (app.status !== 'active') return fail(403, 'app_suspended', 'This app is suspended');
  // A test key on a scope that a live key also uses: its dev-env privileges must never reach live users.
  if (app.scope_conflict) return fail(403, 'scope_conflict', 'This test key’s scope is also used by a live app');

  // 2. Origin (and, from a Hana page, the partner origin it acts for).
  if (!caller.ok) return fail(403, 'origin_not_allowed', 'Origin not allowed for this app');

  // 3. The per-IP limit, before anything is parsed or verified: it bounds what one client can make the checks cost.
  //    The app's shared quota is counted later, after verification (appQuota).
  try {
    const window = kind === 'relay' ? `${app.id}:minute` : `${app.id}:config:minute`;
    const ipHit = await limiter(env, ipKey(request)).hit([{ name: window, windowMs: MINUTE, max: app.per_ip_minute }]);
    if (!ipHit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(ipHit.retryAfterS) });
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }
  lap(ctx, 'limits');
  return { ok: true, app, caller };
}

/**
 * The app's relay quota (plan `per_minute` and `per_day`, one RateLimiter object per app): asked right before a
 * relay, once the request passed every off-chain check (token, nonce, session signature, scope, session precheck), so
 * only requests that would plausibly succeed count. Null when it accepts; a refusal is 429 with Retry-After, a
 * limiter that fails refuses (503), never lets through.
 */
export async function appQuota(env: Env, ctx: Ctx, app: App): Promise<Response | null> {
  try {
    const appHit = await limiter(env, `app:${app.id}`).hit([
      { name: 'minute', windowMs: MINUTE, max: app.per_minute },
      { name: 'day', windowMs: DAY, max: app.per_day },
    ]);
    if (!appHit.ok) return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (app per ${appHit.limit})`, { 'retry-after': String(appHit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  return null;
}

// ---- GET /v1/app ----

/**
 * What the SDK needs to start a login: the app's name and scope, the signer contract, which Google client to use and
 * the server clock (`serverTimeMs`, which the vault corrects its clock with). `own` when the scope has a Google client
 * of its own (the app's `google_web_client_id` when set, which must still be one of the scope's clients; else the
 * first one), else `shared` (the first shared client in force) when the scope allows shared login, else 409.
 * `autoApprovePolicy` is the policy in force now (D1, validated and normalized as the vault page inlines it), or null, and
 * `rawSign` the raw-signing setting in force now: an open vault re-reads both (within 10 s of a request), so removing a
 * policy stops auto-approval, and setting raw signing to 'off' stops raw requests, without a reload.
 */
export async function handleAppConfig(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, APP_CONFIG_ENDPOINT, request);
  const gate = await appGate(request, env, ctx, 'config');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  let autoApprovePolicy: AppSettings['autoApprovePolicy'];
  let rawSign: AppSettings['rawSign'];
  try {
    const row = await getSettingsRow(env.DB, app.id);
    const settings = row ? await effectiveSettings(row, app.id, Date.now()) : null;
    autoApprovePolicy = settings?.autoApprovePolicy ?? null;
    rawSign = settings?.rawSign ?? 'off';
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again');
  }
  try {
    const scope = await getScope(env, app.scope_id);
    if (!scope) return reject(ctx, 409, 'scope_not_registered', 'The app’s scope is not registered on chain');
    const web = app.google_web_client_id;
    const own = scope.clients.find(([p, aud]) => p === 'google' && (web === null || aud === web));
    if (web !== null && !own) return reject(ctx, 409, 'no_google_client', 'The app’s Google web client is no longer one of its scope’s clients');
    let google: { clientId: string; mode: 'own' | 'shared' } | null = own ? { clientId: own[1], mode: 'own' } : null;
    if (!google && scope.allow_shared) {
      const shared = effectiveSharedClients(await getConfig(env)).find(([p]) => p === 'google');
      if (shared) google = { clientId: shared[1], mode: 'shared' };
    }
    if (!google) return reject(ctx, 409, 'no_google_client', 'The app has no Google client and shared login is not available');
    return done(ctx, 200, { name: app.name, scopeId: app.scope_id, signer: env.SIGNER_ACCOUNT, google, serverTimeMs: Date.now(), autoApprovePolicy, rawSign });
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
  }
}

// ---- App endpoints ----

/**
 * Clients wait for these: chain reads that do not depend on each other run concurrently, and usage is counted after
 * the response (`exec.waitUntil`) when the runtime gives an execution context.
 */
export async function handleAppEndpoint(request: Request, env: Env, endpoint: AppEndpoint, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const now = Date.now();
  const gate = await appGate(request, env, ctx, 'relay');
  if (!gate.ok) return gate.response;
  const { app } = gate;

  // 4. Argument shapes.
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);

  if (endpoint === '/v1/sessions') {
    // The scope is always the app's (D1), never the client's.
    const call = toCreateSession(parsed.body, app.scope_id, now);
    if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);
    const req = call.request;

    // 5. The token is a genuine, unexpired Google ID token (RS256 against Google's JWKS) with a nonce...
    let verified;
    try {
      verified = await verifyIdToken(req.jwt, now, { skewMs: TOKEN_EXP_SKEW_MS, observer: keyObserver(env, exec) });
    } catch (err) {
      if (err instanceof JwksUnavailableError) return reject(ctx, 503, 'issuer_keys_unavailable', 'Could not read the token issuer keys, try again');
      throw err;
    }
    if (!verified.ok) return reject(ctx, verified.code === 'invalid_token' ? 401 : 400, verified.code, verified.error);
    const token = verified.token;
    // The claim allow-list (claims.ts), here only once REJECT_PII_ON_SESSIONS is on: smoke's GIS tokens carry `email`.
    const claim = env.REJECT_PII_ON_SESSIONS === '1' ? disallowedClaim(req.jwt) : null;
    if (claim) return done(ctx, 400, { error: 'The ID token carries a claim outside the allow-list', code: 'token_has_pii', data: { claim } });
    if (token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');
    // 6. ...that commits to this session in this app's scope on this signer.
    const expected = await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId: app.scope_id, ...req });
    if (token.nonce !== expected) return reject(ctx, 400, 'nonce_mismatch', 'The ID token nonce does not commit to this session');

    // 7 and 8 read the chain; only a verified token gets this far, and the two reads run side by side.
    // 7. Scope: a registered client must be this app's; a shared client needs a scope that allows shared login.
    // 8. The session key is not in use already (a replayed request would only fail on chain, at the relayer's
    //    cost). session_key_in_use also covers revoked sessions that have not expired, which get_session hides.
    // 9. The contract isn't paused and the token's kid is active on chain (not still in its issuer-key delay).
    const [scope, inUse, gov] = await Promise.all([
      settle(checkClientScope(env, token.provider, token.aud, app.scope_id, now)),
      settle(sessionKeyInUse(env, req.sessionPublicKey, now)),
      chainGate(env, token, requestId),
    ]);
    if (!scope.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (scope.value) return reject(ctx, scope.value.status, scope.value.code, scope.value.error);
    if (!inUse.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (inUse.value) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
    if (gov) return chainGateResponse(ctx, gov);
    lap(ctx, 'checks');
    // 10. The app's quota, counted only now that the request passed every check.
    const quota = await appQuota(env, ctx, app);
    if (quota) return quota;

    const result = await relay(env, 'session', { method: call.method, args: call.args }, requestId);
    lapRelay(ctx, result);
    if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
    if (!isSessionView(result.result)) return done(ctx, 502, { error: 'The contract returned no session', code: 'bad_contract_result', nearTx: result.nearTx });
    rememberSession(req.sessionPublicKey, result.result);
    await countUsage(env, app.id, 'sessions', ctx, exec);
    return done(ctx, 200, { result: result.result, nearTx: result.nearTx });
  }

  let call;
  let payload: Uint8Array;
  if (endpoint === '/v1/derive') {
    const derive = toDeriveKey(parsed.body);
    if (isError(derive)) return reject(ctx, 400, 'bad_request', derive.error);
    call = derive;
    payload = ckdPayload(derive.pk1, derive.pk2);
  } else {
    const revoke = toRevokeSession(parsed.body);
    if (isError(revoke)) return reject(ctx, 400, 'bad_request', revoke.error);
    call = revoke;
    payload = revokePayload();
  }

  // 5. The session key signed this request (Ed25519 over the session message).
  if (!(await verifySessionSignature(call.sessionPublicKey, call.counter, call.signature, payload))) {
    return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  }

  // 6. The session belongs to this app's scope, is live and can still take this counter (the contract's rules,
  //    session-use.ts): a replayed request or one past the use limit would only fail on chain, at the relayer's cost.
  //    A second request for the same counter waits here for the first.
  const release = await claimCounter(call.sessionPublicKey, call.counter);
  try {
    // derive_key panics while the contract is paused; revoke_session doesn't (revocation always works). Read beside
    // the session check (chainGate never rejects), reported after it.
    const paused = 'pk1' in call ? chainGate(env, null, requestId) : Promise.resolve(null);
    let check;
    try {
      check = await precheckSessionUse(env, app.scope_id, call.method, call.sessionPublicKey, call.counter);
    } catch {
      return reject(ctx, 502, 'near_unavailable', 'Could not read the session');
    }
    const { rejection } = check;
    if (rejection) return done(ctx, rejection.status, { error: rejection.error, code: rejection.code, nextCounter: rejection.nextCounter });
    const gov = await paused;
    if (gov) return chainGateResponse(ctx, gov);
    // The app key's pairing check (bls.ts), last: it is the costly one.
    if ('pk1' in call && env.BLS_PRECHECK === '1' && !(await appKeyPairs(call.pk1, call.pk2))) return reject(ctx, 400, 'invalid_app_key', 'pk1 and pk2 are not the same key');
    lap(ctx, 'checks');
    // The app's quota, counted only now that the request passed every check.
    const quota = await appQuota(env, ctx, app);
    if (quota) return quota;

    const result = await relay(env, 'session', { method: call.method, args: call.args }, requestId);
    lapRelay(ctx, result);
    // A derive that succeeded used its counter: count it in the cached session, if that is still the session it was
    // judged against (the key may have opened a new one while the derive ran). Anything else may have changed the
    // session or not (a revoke ends it; a derive whose MPC call failed still counted the use; an unknown outcome may
    // land), so the next request reads it from chain.
    if (endpoint === '/v1/derive' && result.ok) recordSessionUse(call.sessionPublicKey, call.counter, check.session);
    else forgetSession(call.sessionPublicKey);
    if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
    if (endpoint === '/v1/derive') {
      const r = result.result as { big_y?: unknown; big_c?: unknown } | null;
      if (!r || typeof r.big_y !== 'string' || typeof r.big_c !== 'string') return done(ctx, 502, { error: 'The contract returned no key', code: 'bad_contract_result', nearTx: result.nearTx });
      await countUsage(env, app.id, 'derives', ctx, exec);
      return done(ctx, 200, { result: { big_y: r.big_y, big_c: r.big_c }, nearTx: result.nearTx });
    }
    return done(ctx, 200, { result: null, nearTx: result.nearTx });
  } finally {
    release();
  }
}

/**
 * Counts a successful call. With an execution context the D1 write runs after the response is sent (waitUntil);
 * without one it is awaited here. Never rejects.
 */
async function countUsage(env: Env, appId: string, field: 'sessions' | 'derives', ctx: Ctx, exec?: ExecutionContext): Promise<void> {
  const write = incrementUsage(env.DB, appId, field).catch(() => {
    log({ event: 'usage_increment_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint }, 'error');
  });
  if (exec) exec.waitUntil(write);
  else await write;
}

type ScopeRejection = { status: number; code: string; error: string };

/** A 503 the client may retry after `retryAfterS` (also sent as Retry-After). */
export type ChainGateRejection = ScopeRejection & { retryAfterS: number };

/**
 * Governance checks before a relay that verifies `token` on chain or derives (docs/governance-spec.md "Pause",
 * "Rotation and logins"): the contract isn't paused (`get_config`, cached ≤ 60 s, ≤ 10 s while paused) and, with a
 * token, its kid is an active issuer key on chain (`get_issuer`, cached ≤ 60 s, re-read on an unknown kid). Either
 * would only make the transaction panic at the relayer's cost. Fails open (null) when the views can't be read: these
 * checks only save gas, the contract decides. Never rejects.
 */
export async function chainGate(env: Env, token: { provider: string; kid: string } | null, requestId?: string): Promise<ChainGateRejection | null> {
  const [config, active] = await Promise.all([settle(getConfig(env)), token ? settle(isIssuerKeyActive(env, token.provider, token.kid)) : Promise.resolve(null)]);
  if (!config.ok || (active && !active.ok)) log({ event: 'chain_gate_unavailable', requestId, code: !config.ok ? 'get_config_failed' : 'get_issuer_failed' }, 'warn');
  if (config.ok && config.value.paused) return { status: 503, code: 'paused', error: 'Hana ID is paused, try again later', retryAfterS: PAUSED_RETRY_S };
  if (active?.ok && !active.value) {
    return { status: 503, code: 'issuer_key_pending', error: 'The token’s signing key is not active on chain yet, try again shortly', retryAfterS: ISSUER_KEY_PENDING_RETRY_S };
  }
  return null;
}

/** The response for a chainGate rejection: `retryAfterS` in the body and the Retry-After header. */
export const chainGateResponse = (ctx: Ctx, r: ChainGateRejection): Response =>
  done(ctx, r.status, { error: r.error, code: r.code, retryAfterS: r.retryAfterS }, { 'retry-after': String(r.retryAfterS) });

/**
 * Check 7: the client (provider, aud) may log in to `appScope`, or why not. A registered client must be the app's own;
 * otherwise it must be a shared client in force (config, cached 60 s) and the app's scope must allow shared login.
 */
export async function checkClientScope(env: Env, provider: string, aud: string, appScope: string, now: number): Promise<ScopeRejection | null> {
  const scope = await scopeForClient(env, provider, aud);
  if (scope !== null) return scope === appScope ? null : { status: 403, code: 'scope_mismatch', error: 'Token is for a different app' };
  if (!isSharedClient(await getConfig(env), provider, aud, now)) return { status: 403, code: 'unregistered_client', error: 'Token is for an unregistered app' };
  const scopeView = await getScope(env, appScope);
  if (!scopeView) return { status: 403, code: 'unknown_scope', error: 'The app’s scope is not registered' };
  if (!scopeView.allow_shared) return { status: 403, code: 'shared_login_disabled', error: 'This app does not allow shared login' };
  return null;
}

// ---- Owner actions ----

/** RateLimiter subject of an owner identity's caps: a hash, so no Google `sub` is part of an object name. */
export const ownerLimiterKey = async (owner: { provider: string; sub: string }): Promise<string> => `owner-actions:owner:${await sha256Hex(`${owner.provider}#${owner.sub}`)}`;
export const scopeLimiterKey = (scopeId: string): string => `owner-actions:scope:${scopeId}`;
/** execute_change's own per-scope subject: unauthenticated, so it never shares the window the scope's owners use. */
export const executeLimiterKey = (scopeId: string): string => `owner-actions:execute:${scopeId}`;
/** cancel_change's per-scope subject: only the target scope's owners (checked on chain state first) count here. */
export const cancelScopeLimiterKey = (scopeId: string): string => `owner-actions:cancel:${scopeId}`;
export const CANCEL_GLOBAL_LIMITER = 'owner-actions:cancel-global';

export interface OwnerActionWindow {
  subject: string;
  label: string;
  limits: Limit[];
}

/**
 * The windows a checked owner action counts against, in the order they are asked (see OWNER_ACTIONS_PER_OWNER_*), or
 * null when it must be refused: an action that needs an owner identity (every method but execute_change) without one.
 */
export async function ownerActionWindows(method: string, check: { scopeId: string; owner: { provider: string; sub: string } | null }): Promise<OwnerActionWindow[] | null> {
  const pair = (prefix: string, minute: number, day: number): Limit[] => [
    { name: `${prefix}minute`, windowMs: MINUTE, max: minute },
    { name: `${prefix}day`, windowMs: DAY, max: day },
  ];
  const global = { subject: 'owner-actions:global', label: 'owner actions', limits: pair('', OWNER_ACTIONS_GLOBAL_MINUTE, OWNER_ACTIONS_GLOBAL_DAY) };
  if (method === 'execute_change') {
    return [{ subject: executeLimiterKey(check.scopeId), label: 'executes per scope', limits: pair('', EXECUTES_PER_SCOPE_MINUTE, EXECUTES_PER_SCOPE_DAY) }, global];
  }
  // Every other method carries an OIDC owner proof (toOwnerAction, precheckOwnerAction); without one, fail closed.
  if (!check.owner) return null;
  const owner = await ownerLimiterKey(check.owner);
  if (method === 'cancel_change') {
    return [
      { subject: owner, label: 'cancels per owner', limits: pair('cancel:', CANCELS_PER_OWNER_MINUTE, CANCELS_PER_OWNER_DAY) },
      { subject: cancelScopeLimiterKey(check.scopeId), label: 'cancels per scope', limits: pair('', CANCELS_PER_SCOPE_MINUTE, CANCELS_PER_SCOPE_DAY) },
      { subject: CANCEL_GLOBAL_LIMITER, label: 'cancels', limits: pair('', CANCELS_GLOBAL_MINUTE, CANCELS_GLOBAL_DAY) },
    ];
  }
  return [
    { subject: owner, label: 'owner actions per owner', limits: pair('', OWNER_ACTIONS_PER_OWNER_MINUTE, OWNER_ACTIONS_PER_OWNER_DAY) },
    { subject: scopeLimiterKey(check.scopeId), label: 'owner actions per scope', limits: pair('', OWNER_ACTIONS_PER_SCOPE_MINUTE, OWNER_ACTIONS_PER_SCOPE_DAY) },
    global,
  ];
}

/**
 * Asks `windows` in turn at one instant; the first refusal takes back the hits the earlier ones accepted (`unhit`), so
 * a refused request uses up no window. Returns the refusal, or null when every window accepted. Throws when a limiter
 * can't be reached (the caller refuses: fail closed); a failed take-back is logged and leaves that count in place.
 */
export async function hitAll(env: Env, windows: readonly OwnerActionWindow[], requestId?: string): Promise<{ window: OwnerActionWindow; limit: string; retryAfterS: number } | null> {
  const now = Date.now();
  const accepted: OwnerActionWindow[] = [];
  for (const w of windows) {
    const hit = await limiter(env, w.subject).hit(w.limits, now);
    if (!hit.ok) {
      for (const a of accepted) {
        try {
          await limiter(env, a.subject).unhit(a.limits, now);
        } catch {
          log({ event: 'rate_limit_unhit_failed', requestId, endpoint: '/v1/owner-actions' }, 'warn');
        }
      }
      return { window: w, limit: hit.limit, retryAfterS: hit.retryAfterS };
    }
    accepted.push(w);
  }
  return null;
}

export async function handleOwnerAction(request: Request, env: Env, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, '/v1/owner-actions', request, corsHeaders('*', 'content-type'));
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
  const token = check.authToken;
  const release = async (): Promise<void> => {
    if (!token) return;
    try {
      await tokens.release(token.hash);
    } catch {
      log({ event: 'owner_token_release_failed', requestId, endpoint: ctx.endpoint }, 'warn');
    }
  };
  try {
    // An owner token is bound to one action by its nonce: once relayed it can only fail. Reserve it atomically
    // before relaying, so concurrent copies of one request can't all pass.
    if (token && !(await tokens.reserve(token.hash, token.expMs))) return reject(ctx, 409, 'token_used', 'This owner token was already used, get a fresh one');
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  try {
    const windows = await ownerActionWindows(call.method, check);
    if (!windows) {
      await release();
      return reject(ctx, 403, 'not_owner', 'This owner action needs an owner token');
    }
    const refused = await hitAll(env, windows, requestId);
    if (refused) {
      await release();
      return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (${refused.window.label} per ${refused.limit.replace(/^cancel:/u, '')})`, { 'retry-after': String(refused.retryAfterS) });
    }
  } catch {
    await release();
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  lap(ctx, 'checks');
  const result = await relay(env, 'owner', call, requestId);
  lapRelay(ctx, result);
  forgetScope(check.scopeId);
  // The reservation stays unless the transaction certainly never executed (an unknown outcome may still land).
  if (!result.ok && NOT_EXECUTED.has(result.code)) await release();
  if (!result.ok) return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
  return done(ctx, 200, { result: result.result ?? null, nearTx: result.nearTx });
}

// ---- Health ----

export function handleHealth(env: Env, requestId: string): Response {
  return json(200, { ok: true, env: env.ENV_NAME, signer: env.SIGNER_ACCOUNT, requestId }, { 'access-control-allow-origin': '*', 'x-request-id': requestId });
}
