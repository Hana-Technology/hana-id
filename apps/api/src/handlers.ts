// Request handlers: app endpoints (publishable key + origin), owner actions (OIDC proof in args), health.
import { identityRoot } from '@hana-id/core/identity';
import { appIdentityEmail } from './identity/email.ts';
import { JwksUnavailableError } from '@hana-id/oidc';
import { type App, HOT_DB_SCHEMA, PUBLISHABLE_KEY_RE, appSuspended, getAppByKey, markFirstLogin, markSession, startFirstSession } from './apps.ts';
import { appKeyPairs, appKeyProblem } from './bls.ts';
import { deployedBuild } from './build.ts';
import type { Env } from './env.ts';
import { type Headers_, corsHeaders, json, readJson } from './http.ts';
import { ipSubject } from './ip.ts';
import { eventId } from './changes/guard.ts';
import { logoUrl } from './changes/views.ts';
import { log } from './log.ts';
import { placedStub } from './placement.ts';
import { type Caller, PARENT_ORIGIN_HEADER, RELAY_KEY_HEADER, checkCaller, isTestApp, preflightAllows } from './origins.ts';
import { precheckOwnerAction, sha256Hex } from './owner-actions.ts';
import type { Limit, RateLimiter } from './rate-limiter.ts';
import type { RelayInstance, RelayResult } from './relayer-key.ts';
import { ALREADY_RELAYED } from './relayer-config.ts';
import { relay } from './relayer-pool.ts';
import { ckdPayload, createProofPayload, revokePayload, sessionNonce, verifySessionSignature } from './session-crypto.ts';
import { countEmailUsage } from './email-usage.ts';
import { countLinkUsage } from './link-usage.ts';
import { sessionSupportId } from './directory/store.ts';
import { type LoginTokenResult, verifyLoginToken } from './login-token.ts';
import { signerPanic } from './panics.ts';
import { recalledPanic, rememberPanic, requestKey } from './panic-cache.ts';
import { sessionStanding } from './session-standing.ts';
import { claimCounter, precheckSessionUse } from './session-use.ts';
import { type UsageDraft, beginUsage, finishUsage, finishUsageOnThrow, notePath, noteRelay } from './usage/event.ts';
import { MAX_BODY, isError, toCreateSession, toDeriveKey, toOwnerAction, toRevokeSession } from './validate.ts';
import { CONSENT_HEADER, type ConsentStatus, consentStatus, parseConsentHeader } from './vault/consent-store.ts';
import { parentOriginAllowed } from './vault/origins.ts';
import { type AppSettings, effectiveSettings, getSettingsRow } from './vault/settings.ts';
import { type LoginMethod, appLoginMethods } from './login-methods.ts';
import { mainnetDemoOn } from './mainnet-demo-setting.ts';
import { mainnetDemoPrices } from './mainnet-demo-prices.ts';
import { fixedMainnetDemoPrices } from '@hana-id/core/mainnet-demo-prices';
import { LINK_ADDS_PER_IP_MINUTE, LINK_CHANGES_PER_IP_MINUTE } from './links.ts';
import { TtlCache, effectiveSharedClients, forgetScope, forgetSession, getConfig, getScope, isIssuerKeyActive, isSessionView, isSharedClient, recordSessionUse, rememberSession, scopeForClient, sessionKeyInUse } from './views.ts';

const APP_ALLOW_HEADERS = `content-type, x-hana-key, ${PARENT_ORIGIN_HEADER}, ${RELAY_KEY_HEADER}, ${CONSENT_HEADER}`;
const APP_METHODS = 'GET, POST, OPTIONS';
/** Owner actions are unauthenticated at the API (the proof is in the args): keep them slow. */
export const OWNER_ACTIONS_PER_IP_MINUTE = 10;
/**
 * Caps on relayed owner actions (only requests that passed every off-chain check count; D100, security sweep APIW-3;
 * docs/batch-c-spec.md "On-chain owner actions" Limits, as reconciled in D236). They are paid from the owner pool
 * (OWNER_RELAYER_KEYS, small allowance), never from the login pool. Asked from the most specific in, so one owner's
 * excess stops at its own window and never reaches what other scopes share; a request refused by a later window is
 * taken back from the earlier ones (`unhit`), so a refusal costs nothing. Day windows are UTC days. Reaching a cap
 * writes an `owner_cap` security event (once per window, ownerCapEvent):
 * - propose_change: per owner identity (provider, sub), then per scope (10 a minute, 20 a UTC day), then the global
 *   ceiling that bounds the pool's spend. The per-owner windows are the scope's divided by CONTRACT_MAX_OWNERS (2 a
 *   minute, 4 a day; D236), so no one owner, nor any four of five, can use up the scope's proposals: within a scope
 *   only all of its owners together can fill them, as with the safety budget;
 * - execute_change (no auth, anyone may send it): its own per-scope window, never the one the scope's owners use, then
 *   the global ceiling;
 * - the safety budget, cancel_change, remove_client and disable_shared_login: none of the above. Its own allowance per
 *   owner identity, then per scope (keyed by the target scope: only that scope's on-chain owners pass the precheck, so
 *   only they can fill it, and it is sized for all CONTRACT_MAX_OWNERS of them at once), then a high safety-only global
 *   ceiling that is only a spend bound. No other scope's owners, no proposal flood and no execute flood can starve a
 *   timelock's cancel or a client removal; within the scope, only all of its owners together can. A safety action
 *   without an owner identity is refused (fail closed). Each one is also bounded by the scope's state: a cancel needs
 *   a pending change (≤ CONTRACT_MAX_PENDING), a removal one of the scope's clients, a disable shared login on.
 */
/** The scope's windows divided by CONTRACT_MAX_OWNERS (a test keeps scope ≥ owners × owner), so co-owners can't be starved. */
export const OWNER_ACTIONS_PER_OWNER_MINUTE = 2;
export const OWNER_ACTIONS_PER_OWNER_DAY = 4;
export const OWNER_ACTIONS_PER_SCOPE_MINUTE = 10;
/** The spec's 20 owner actions per scope per UTC day (docs/batch-c-spec.md "On-chain owner actions", D93 Q23). */
export const OWNER_ACTIONS_PER_SCOPE_DAY = 20;
export const EXECUTES_PER_SCOPE_MINUTE = 10;
export const EXECUTES_PER_SCOPE_DAY = 50;
export const OWNER_ACTIONS_GLOBAL_MINUTE = 20;
export const OWNER_ACTIONS_GLOBAL_DAY = 200;
/** The safety budget's methods: they only stop or undo something, so no other traffic may exhaust them. */
export const SAFETY_METHODS: readonly string[] = ['cancel_change', 'remove_client', 'disable_shared_login'];
export const SAFETY_PER_OWNER_MINUTE = 5;
export const SAFETY_PER_OWNER_DAY = 20;
/** hana-signer's `MAX_OWNERS` per scope (registry.rs; scripts/test/contract-constants.test.ts keeps them equal). */
export const CONTRACT_MAX_OWNERS = 5;
/** hana-signer's `MAX_PENDING` changes per scope: at most this many cancels can pass the precheck at a time. */
export const CONTRACT_MAX_PENDING = 10;
/** Per scope: every owner's whole allowance at once, so fewer than all of a scope's owners can never fill it. */
export const SAFETY_PER_SCOPE_MINUTE = CONTRACT_MAX_OWNERS * SAFETY_PER_OWNER_MINUTE;
export const SAFETY_PER_SCOPE_DAY = CONTRACT_MAX_OWNERS * SAFETY_PER_OWNER_DAY;
/**
 * A spend bound only (the owner pool's allowance is the hard one). Filling the minute window takes 20 owner
 * identities at their own cap (≥ 4 scopes the attacker fully owns, at CONTRACT_MAX_OWNERS each); the day window takes
 * 50 identities (≥ 10 such scopes) and 1000 actions the scopes' state allows, which is ≥ 100 scopes' worth of
 * CONTRACT_MAX_PENDING cancels at once or more proposals than the shared OWNER_ACTIONS_GLOBAL_DAY lets through in five
 * days.
 */
export const SAFETY_GLOBAL_MINUTE = 100;
export const SAFETY_GLOBAL_DAY = 1000;
/** Clock skew tolerated on an ID token's `exp` (the contract checks `exp` against the block time again). */
export const TOKEN_EXP_SKEW_MS = 60_000;
const MINUTE = 60_000;
/** Relay failures after which the transaction certainly did not execute (see relayer-key.ts / relayer-pool.ts). */
export const NOT_EXECUTED: ReadonlySet<string> = new Set(['method_not_allowed', 'relayer_unconfigured', 'near_unavailable', 'near_rejected', 'relayer_busy']);
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
  /** POST /v1/identity/token: the signing key's kid (logged; never the token, `sub` or `sid`). */
  kid?: string;
  /** The request's usage event, open from its gate to its response (usage/event.ts; `done` closes it). */
  usage?: UsageDraft;
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
 * with the broadcast split into queue / chain reads / signing / nonce reservation (see RelayTiming). Also notes what
 * the relay sent for the request's usage event (the transaction, its key and nonce, its provisional gas).
 */
export function lapRelay(ctx: Ctx, result: RelayResult): void {
  noteRelay(ctx, result);
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
      kid: ctx.kid,
    },
    status >= 500 ? 'error' : 'info',
  );
  // The request's usage event (when one is open) goes to the ledger after this response; it never changes or delays it.
  finishUsage(ctx, status, code);
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
export async function appGate(request: Request, env: Env, ctx: Ctx, kind: 'relay' | 'config' | 'link' | 'link-change'): Promise<Gate> {
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
  if (appSuspended(app)) return fail(403, 'app_suspended', 'This app is suspended');
  // A key whose prefix names the other environment than its scope (refused by the 0006 triggers; a second check):
  // a test key's dev-env privileges must never reach live users.
  if (app.scope_conflict) return fail(403, 'scope_conflict', 'This key’s environment is not its scope’s');

  // 2. Origin (and, from a Hana page, the partner origin it acts for).
  if (!caller.ok) return fail(403, 'origin_not_allowed', 'Origin not allowed for this app');

  // 3. The per-IP limit, before anything is parsed or verified: it bounds what one client can make the checks cost.
  //    The app's shared quota is counted later, after verification (appQuota).
  try {
    // The link relays (links.ts) count in windows of their own, with their own caps, adds and removals apart.
    const window = kind === 'relay' ? `${app.id}:minute` : kind === 'config' ? `${app.id}:config:minute` : `${app.id}:${kind}:minute`;
    const max = kind === 'link' ? LINK_ADDS_PER_IP_MINUTE : kind === 'link-change' ? LINK_CHANGES_PER_IP_MINUTE : app.per_ip_minute;
    const ipHit = await limiter(env, ipKey(request)).hit([{ name: window, windowMs: MINUTE, max }]);
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
 *
 * Email login (docs/email-login-spec.md "API changes"): `loginMethods` is what the app's D1 `login_methods` enables
 * and the scope's on-chain clients can serve, in the order google, email; `email: {aud}` (the scope's email client)
 * when email is among them. A Google-only app (every app until build plan batch 8) answers exactly as before, with
 * `loginMethods: ['google']` added, and its 409 `no_google_client`; an app with email on answers 409
 * `no_login_method` when neither method is available, and `google: null` when only email is.
 */
export async function handleAppConfig(request: Request, env: Env, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, APP_CONFIG_ENDPOINT, request);
  const gate = await appGate(request, env, ctx, 'config');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  ctx.exposeTimings = isTestApp(app);
  // The D1 rows and the registry views don't depend on each other, so they run side by side (phases `settings` and
  // `chain`, each from the gate's end to its own answer). `get_config` is read only when the scope says a shared
  // client is needed (no web client of the app's own, no Google client in the scope, shared login allowed), right
  // after `get_scope`. Both reads are awaited before any answer, on every path: an unawaited read could be cancelled
  // with the request and leave getConfig's shared in-flight promise unsettled for the isolate's later requests.
  const from = Date.now();
  const timed = <T>(phase: string, p: Promise<T>): Promise<Settled<T>> =>
    settle(p).then((r) => {
      if (ctx.phases) ctx.phases[phase] = Math.max(ctx.phases[phase] ?? 0, Date.now() - from);
      return r;
    });
  const settingsRead = timed(
    'settings',
    Promise.all([getSettingsRow(env.DB, app.id).then((row) => (row ? effectiveSettings(row, app.id, Date.now()) : null)), appLoginMethods(env.DB, app.id), appIdentityEmail(env.DB, app.id), mainnetDemoOn(env, app)]),
  );
  const web = app.google_web_client_id;
  const chainRead = timed(
    'chain',
    getScope(env, app.scope_id).then(async (scope) => {
      const needsShared = scope !== null && web === null && scope.allow_shared && !scope.clients.some(([p]) => p === 'google');
      // Settled here: its failure counts only where the shared client is used (an email-only app never uses it).
      return { scope, config: needsShared ? await settle(getConfig(env)) : null };
    }),
  );
  // The mainnet demo's prices (D436), beside the chain read, only once the app is known to have the demo on: a CoinGecko
  // call happens for no other request. Its own phase, only then. Never fails: the fixed table stands in.
  const pricesRead = settingsRead.then((s) => (s.ok && s.value[3] ? timed('prices', mainnetDemoPrices(env, exec)).then((p) => (p.ok ? p.value : fixedMainnetDemoPrices())) : null));
  // The consent's status (D465), only for the vault's own read: one uncached D1 statement. `undefined` is "no answer" (no
  // header, another origin, or a failed read): the field is left out, which is not 'unknown', so a D1 blip never makes a
  // vault drop a consent (D511).
  const consentHeader = env.VAULT_ORIGIN && request.headers.get('origin') === env.VAULT_ORIGIN ? request.headers.get(CONSENT_HEADER) : null;
  const consentRead: Promise<ConsentStatus | undefined> =
    consentHeader === null
      ? Promise.resolve(undefined)
      : timed('consent', readConsentStatus(env, app, consentHeader)).then((r) => {
          if (r.ok) return r.value;
          log({ event: 'consent_status_unavailable', requestId, appId: app.id, endpoint: ctx.endpoint }, 'warn');
          return undefined;
        });
  const [settingsDone, chainDone, demoPrices, consent] = await Promise.all([settingsRead, chainRead, pricesRead, consentRead]);
  if (!settingsDone.ok) return reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again');
  const [settings, methods, identityEmail, mainnetDemo] = settingsDone.value;
  const autoApprovePolicy: AppSettings['autoApprovePolicy'] = settings?.autoApprovePolicy ?? null;
  const rawSign: AppSettings['rawSign'] = settings?.rawSign ?? 'off';
  // A Google-only app keeps batch B's answers and errors exactly.
  const googleOnly = methods.length === 1 && methods[0] === 'google';
  try {
    if (!chainDone.ok) throw chainDone.error;
    const { scope, config } = chainDone.value;
    if (!scope) return reject(ctx, 409, 'scope_not_registered', 'The app’s scope is not registered on chain');
    let google: { clientId: string; mode: 'own' | 'shared' } | null = null;
    if (methods.includes('google')) {
      const own = scope.clients.find(([p, aud]) => p === 'google' && (web === null || aud === web));
      if (web !== null && !own && googleOnly) return reject(ctx, 409, 'no_google_client', 'The app’s Google web client is no longer one of its scope’s clients');
      if (own) google = { clientId: own[1], mode: 'own' };
      else if (web === null && scope.allow_shared) {
        if (config && !config.ok) throw config.error;
        const shared = config ? effectiveSharedClients(config.value).find(([p]) => p === 'google') : undefined;
        if (shared) google = { clientId: shared[1], mode: 'shared' };
      }
      if (!google && googleOnly) return reject(ctx, 409, 'no_google_client', 'The app has no Google client and shared login is not available');
    }
    // The scope's email client (`email:<scope_id>`, a scope client: an email `aud` is never shared, D123 Q4).
    const emailClient = methods.includes('email') ? scope.clients.find(([p]) => p === 'email') : undefined;
    const loginMethods: LoginMethod[] = [...(google ? (['google'] as const) : []), ...(emailClient ? (['email'] as const) : [])];
    if (loginMethods.length === 0) return reject(ctx, 409, 'no_login_method', 'The app has no sign-in method available');
    return done(ctx, 200, {
      name: app.name,
      scopeId: app.scope_id,
      signer: env.SIGNER_ACCOUNT,
      google,
      loginMethods,
      ...(emailClient ? { email: { aud: emailClient[1] } } : {}),
      serverTimeMs: Date.now(),
      autoApprovePolicy,
      rawSign,
      // D428: the mainnet demo, on only for a test app Hana staff switched on, in a dev testnet env.
      mainnetDemo,
      // D436: the prices in force, only with the demo on; older vaults ignore the field.
      ...(demoPrices ? { mainnetDemoPrices: demoPrices } : {}),
      // Batch C11: the app's logo on the files origin (`<FILES_ORIGIN>/<logo_key>`), or null (no logo, or no files
      // origin in this env). The auth pages show it beside the name; older clients ignore the field.
      logoUrl: logoUrl(env.FILES_ORIGIN, app.logo_key) ?? null,
      // D411: when the vault asks the user to share their address with the app (identity/email.ts).
      identityEmail,
      // D465: only on the vault's read with `x-hana-consent`; older vaults never send the header.
      ...(consent ? { consent } : {}),
    });
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
  }
}

/** `x-hana-consent` → the consent's status for this app. A malformed value can't name a consent: 'unknown', no D1 read. */
function readConsentStatus(env: Env, app: App, header: string): Promise<ConsentStatus> {
  const consentId = parseConsentHeader(header);
  if (!consentId) return Promise.resolve('unknown');
  return consentStatus(env.DB, app.id, consentId, Date.now(), (origin) => parentOriginAllowed(env.ENV_NAME, app, origin));
}

// ---- App endpoints ----

/**
 * Clients wait for these: chain reads that do not depend on each other run concurrently, and usage is counted after
 * the response (`exec.waitUntil`) when the runtime gives an execution context.
 */
export async function handleAppEndpoint(request: Request, env: Env, endpoint: AppEndpoint, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  try {
    return await appEndpoint(request, env, endpoint, ctx, exec);
  } catch (err) {
    finishUsageOnThrow(ctx);
    throw err;
  }
}

async function appEndpoint(request: Request, env: Env, endpoint: AppEndpoint, ctx: Ctx, exec?: ExecutionContext): Promise<Response> {
  const { requestId } = ctx;
  const now = Date.now();
  const gate = await appGate(request, env, ctx, 'relay');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  // Past the gate: every outcome from here on is one usage event (usage/event.ts).
  beginUsage(ctx, { orgId: app.org_id, appId: app.id, scopeId: app.scope_id, exec });

  // 4. Argument shapes.
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);

  if (endpoint === '/v1/sessions') {
    // The scope is always the app's (D1), never the client's. The body carries the session key's proof of possession.
    const call = toCreateSession(parsed.body, app.scope_id, now, { proof: true });
    if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);
    const req = call.request;

    // 5. The token is genuine and unexpired: a Google ID token (RS256 against Google's JWKS), or an email token (JWS
    //    JSON against the email keys and the on-chain signer policy, for an app with email on), with a nonce...
    //    A Google token with a claim outside the allow-list is refused (400 token_has_pii), always (D271): nothing is relayed.
    const verified = await verifyLoginToken(env, req.jwt, now, { appId: app.id, exec });
    if (!verified.ok) return loginTokenRefusal(ctx, verified);
    const token = verified.token;
    if (token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');
    // 6. ...that commits to this session in this app's scope on this signer.
    const expected = await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId: app.scope_id, ...req });
    if (token.nonce !== expected) return reject(ctx, 400, 'nonce_mismatch', 'The ID token nonce does not commit to this session');
    // 6b. The session key proves possession (D137): its signature over session_message(0, "hana-id-create-v1:" ‖
    //     sha256(session nonce preimage)). Contract v3 checks it too; v2 ignores the argument.
    const proofPayload = await createProofPayload({ signer: env.SIGNER_ACCOUNT, scopeId: app.scope_id, ...req });
    if (!(await verifySessionSignature(req.sessionPublicKey, 0, req.signature ?? [], proofPayload))) {
      return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
    }
    // 6c. The same request already panicked for a link state in this isolate (panic-cache.ts): answered from here.
    const panicKey = await requestKey(call.method, call.args);
    const recalled = recalledPanic(panicKey);
    if (recalled) return done(ctx, recalled.status, { error: recalled.error, code: recalled.code });

    // 7 and 8 read the chain; only a verified token gets this far, and the two reads run side by side.
    // 7. Scope: a registered client must be this app's; a shared client needs a scope that allows shared login.
    // 8. The session key is not in use already (a replayed request would only fail on chain, at the relayer's
    //    cost). session_key_in_use also covers revoked sessions that have not expired, which get_session hides.
    // 9. The contract isn't paused and the token's kid is active on chain (not still in its issuer-key delay).
    // 9b. The session's identity isn't a pending member (session-standing.ts; read only once links can exist).
    const [scope, inUse, gov, standing] = await Promise.all([
      settle(checkClientScope(env, token.provider, token.aud, app.scope_id, now)),
      settle(sessionKeyInUse(env, req.sessionPublicKey, now)),
      chainGate(env, token.kid === null ? null : { provider: token.provider, kid: token.kid }, requestId),
      sessionStanding(env, app.scope_id, token.provider, token.sub, req.keyIndex),
    ]);
    if (!scope.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (scope.value) return reject(ctx, scope.value.status, scope.value.code, scope.value.error);
    if (!inUse.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (inUse.value) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
    if (gov) return chainGateResponse(ctx, gov);
    if (standing.pending) return reject(ctx, 409, 'link_pending', 'This sign-in method’s link is pending');
    lap(ctx, 'checks');
    // 10. The app's quota, counted only now that the request passed every check.
    const quota = await appQuota(env, ctx, app);
    if (quota) return quota;

    const relayed = relay(env, 'session', { method: call.method, args: call.args }, requestId, { sessionPublicKey: req.sessionPublicKey, expiresAtMs: req.expiresAtMs, counter: 0 });
    const noted = firstSession(env, app, ctx, relayed, exec);
    const result = await relayed;
    await noted;
    lapRelay(ctx, result);
    if (!result.ok && result.code === ALREADY_RELAYED) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
    if (!result.ok) return relayFailure(ctx, env, result, panicKey);
    if (!isSessionView(result.result)) return done(ctx, 502, { error: 'The contract returned no session', code: 'bad_contract_result', nearTx: result.nearTx });
    rememberSession(req.sessionPublicKey, result.result);
    await firstLogin(env, app, ctx, exec);
    // The uid's input: the new session's path (kept in memory, never sent).
    notePath(ctx, result.result.path);
    // An email session per app and day (D1 `email_usage`, copied hourly to the ledger, D233).
    if (token.email) await countEmailUsage(env, app.id, 'email_sessions', ctx, exec);
    await countLinkUsage(env, app.id, result.linkTally, ctx, exec);
    // The user's Support ID (C15, D276 as amended by D346), from the new session's own path (the chain's answer: its
    // account root's, for a member), the same code the wallet directory stores for that user.
    const root = identityRoot(result.result.path, app.scope_id);
    const supportId = root ? await sessionSupportId(env, app.scope_id, root) : undefined;
    return done(ctx, 200, { result: result.result, nearTx: result.nearTx, ...(supportId ? { supportId } : {}) });
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
  // The app key's shape, always (as /v1/login): each one compressed, non-identity point, so a client bug can never
  // ask the MPC for a CKD answer under a degenerate key (security sweep APIW-4). The pairing stays behind BLS_PRECHECK.
  if ('pk1' in call) {
    const keyProblem = appKeyProblem(call.pk1, call.pk2);
    if (keyProblem) return reject(ctx, 400, 'invalid_app_key', keyProblem);
  }
  // A derive that already panicked for a link state (`identity_linked`) in this isolate: answered from here.
  const panicKey = await requestKey(call.method, call.args);
  const recalled = recalledPanic(panicKey);
  if (recalled) return done(ctx, recalled.status, { error: recalled.error, code: recalled.code });

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
    // A derive's uid comes from the path of the session it is judged against (a revoke carries none).
    if ('pk1' in call) notePath(ctx, check.session.path);
    const gov = await paused;
    if (gov) return chainGateResponse(ctx, gov);
    // The app key's pairing check (bls.ts), last: it is the costly one.
    if ('pk1' in call && env.BLS_PRECHECK === '1' && !(await appKeyPairs(call.pk1, call.pk2))) return reject(ctx, 400, 'invalid_app_key', 'pk1 and pk2 are not the same key');
    lap(ctx, 'checks');
    // The app's quota, counted only now that the request passed every check.
    const quota = await appQuota(env, ctx, app);
    if (quota) return quota;

    const relayed = relay(env, 'session', { method: call.method, args: call.args }, requestId, { sessionPublicKey: call.sessionPublicKey, expiresAtMs: check.session.expires_at_ms, counter: call.counter });
    const noted = firstSession(env, app, ctx, relayed, exec);
    const result = await relayed;
    await noted;
    lapRelay(ctx, result);
    // A derive that succeeded used its counter: count it in the cached session, if that is still the session it was
    // judged against (the key may have opened a new one while the derive ran). Anything else may have changed the
    // session or not (a revoke ends it; a derive whose MPC call failed still counted the use; an unknown outcome may
    // land), so the next request reads it from chain.
    if (endpoint === '/v1/derive' && result.ok) recordSessionUse(call.sessionPublicKey, call.counter, check.session);
    else forgetSession(call.sessionPublicKey);
    // A copy relayed from another isolate: this counter is used, so the next one is at least one higher.
    if (!result.ok && result.code === ALREADY_RELAYED) return done(ctx, 409, { error: `Counter already used (replayed request); the next one is ${call.counter + 1}`, code: 'counter_used', nextCounter: call.counter + 1 });
    if (!result.ok) return relayFailure(ctx, env, result, panicKey);
    // A derive or a revoke can activate a pending link (the contract's `settle`, D445): counted like a login's.
    await countLinkUsage(env, app.id, result.linkTally, ctx, exec);
    if (endpoint === '/v1/derive') {
      const r = result.result as { big_y?: unknown; big_c?: unknown } | null;
      if (!r || typeof r.big_y !== 'string' || typeof r.big_c !== 'string') return done(ctx, 502, { error: 'The contract returned no key', code: 'bad_contract_result', nearTx: result.nearTx });
      return done(ctx, 200, { result: { big_y: r.big_y, big_c: r.big_c }, nearTx: result.nearTx });
    }
    return done(ctx, 200, { result: null, nearTx: result.nearTx });
  } finally {
    release();
  }
}

/**
 * On a scope with no `first_session_at` yet (as the gate read it): starts the scope's first-session write beside the
 * relay (apps.ts startFirstSession), and writes the app's session marker once `relayed` settles (apps.ts
 * markSession): two independent writes, so one lost write never leaves the `no_session` waiver open. With an
 * execution context both finish after the response (the returned promise is already resolved); without one, await
 * the returned promise after the relay. Never rejects.
 */
export function firstSession(env: Env, app: App, ctx: { requestId: string; endpoint: string }, relayed: Promise<unknown>, exec?: ExecutionContext): Promise<void> {
  const failed = (what: string) => (): void => log({ event: 'first_session_write_failed', requestId: ctx.requestId, appId: app.id, endpoint: ctx.endpoint, what }, 'error');
  const write = startFirstSession(env.DB, app, failed('scope'));
  if (!write) return Promise.resolve();
  const mark = (): Promise<void> => markSession(env.DB, app.id, failed('marker'));
  const both = Promise.all([write, relayed.then(mark, mark)]).then(() => undefined);
  if (exec) {
    exec.waitUntil(both);
    return Promise.resolve();
  }
  return both;
}

/**
 * After a login succeeded, on an app with no `first_login_at` yet (as the gate read it): writes it (apps.ts
 * markFirstLogin, D462), after the response when an execution context is there, so it can't slow or fail the login.
 */
export async function firstLogin(env: Env, app: App, ctx: { requestId: string; endpoint: string }, exec?: ExecutionContext): Promise<void> {
  const write = markFirstLogin(env.DB, app, () => log({ event: 'first_login_write_failed', requestId: ctx.requestId, appId: app.id, endpoint: ctx.endpoint }, 'error'));
  if (!write) return;
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

/** A failed relay's answer: a known email-login panic as its own error (panics.ts), else the relay's. */
export function relayFailure(ctx: Ctx, env: Env, result: Extract<RelayResult, { ok: false }>, panicKey?: string): Response {
  const mapped = signerPanic(env, result);
  if (mapped && panicKey) rememberPanic(panicKey, { status: mapped.status, code: mapped.body.code, error: mapped.body.error });
  if (mapped) return done(ctx, mapped.status, { ...mapped.body, nearTx: result.nearTx });
  return done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx });
}

/** The response for a refused session or link token (login-token.ts): its code, any `data`, and Retry-After when retryable. */
export function loginTokenRefusal(ctx: Ctx, r: Extract<LoginTokenResult, { ok: false }>): Response {
  const retry = r.retryAfterS === undefined ? {} : { retryAfterS: r.retryAfterS };
  return done(ctx, r.status, { error: r.error, code: r.code, ...(r.data ? { data: r.data } : {}), ...retry }, r.retryAfterS === undefined ? {} : { 'retry-after': String(r.retryAfterS) });
}

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
/** The safety budget's per-scope subject: only the target scope's owners (checked on chain state first) count here. */
export const safetyScopeLimiterKey = (scopeId: string): string => `owner-actions:safety:${scopeId}`;
export const SAFETY_GLOBAL_LIMITER = 'owner-actions:safety-global';
export const OWNER_GLOBAL_LIMITER = 'owner-actions:global';

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
  const global = { subject: OWNER_GLOBAL_LIMITER, label: 'owner actions', limits: pair('', OWNER_ACTIONS_GLOBAL_MINUTE, OWNER_ACTIONS_GLOBAL_DAY) };
  if (method === 'execute_change') {
    return [{ subject: executeLimiterKey(check.scopeId), label: 'executes per scope', limits: pair('', EXECUTES_PER_SCOPE_MINUTE, EXECUTES_PER_SCOPE_DAY) }, global];
  }
  // Every other method carries an OIDC owner proof (toOwnerAction, precheckOwnerAction); without one, fail closed.
  if (!check.owner) return null;
  const owner = await ownerLimiterKey(check.owner);
  if (SAFETY_METHODS.includes(method)) {
    return [
      { subject: owner, label: 'safety actions per owner', limits: pair('safety:', SAFETY_PER_OWNER_MINUTE, SAFETY_PER_OWNER_DAY) },
      { subject: safetyScopeLimiterKey(check.scopeId), label: 'safety actions per scope', limits: pair('', SAFETY_PER_SCOPE_MINUTE, SAFETY_PER_SCOPE_DAY) },
      { subject: SAFETY_GLOBAL_LIMITER, label: 'safety actions', limits: pair('', SAFETY_GLOBAL_MINUTE, SAFETY_GLOBAL_DAY) },
    ];
  }
  return [
    { subject: owner, label: 'owner actions per owner', limits: pair('', OWNER_ACTIONS_PER_OWNER_MINUTE, OWNER_ACTIONS_PER_OWNER_DAY) },
    { subject: scopeLimiterKey(check.scopeId), label: 'owner actions per scope', limits: pair('', OWNER_ACTIONS_PER_SCOPE_MINUTE, OWNER_ACTIONS_PER_SCOPE_DAY) },
    global,
  ];
}

export interface CapRefusal {
  window: OwnerActionWindow;
  /** The refusing window's name (`minute`, `day`, `safety:minute`, …). */
  limit: string;
  retryAfterS: number;
  /** The instant every window was asked at. */
  at: number;
}

/**
 * Asks `windows` in turn at one instant; the first refusal takes back the hits the earlier ones accepted (`unhit`), so
 * a refused request uses up no window. Returns the refusal, or null when every window accepted. Throws when a limiter
 * can't be reached (the caller refuses: fail closed); a failed take-back is logged and leaves that count in place.
 */
export async function hitAll(env: Env, windows: readonly OwnerActionWindow[], requestId?: string, endpoint: string = '/v1/owner-actions', now: number = Date.now()): Promise<CapRefusal | null> {
  const accepted: OwnerActionWindow[] = [];
  for (const w of windows) {
    const hit = await limiter(env, w.subject).hit(w.limits, now);
    if (!hit.ok) {
      for (const a of accepted) {
        try {
          await limiter(env, a.subject).unhit(a.limits, now);
        } catch {
          log({ event: 'rate_limit_unhit_failed', requestId, endpoint }, 'warn');
        }
      }
      return { window: w, limit: hit.limit, retryAfterS: hit.retryAfterS, at: now };
    }
    accepted.push(w);
  }
  return null;
}

/** Event ids this isolate wrote recently: a flood of refusals of one full window costs one D1 write, not one each. */
const capEventsSeen = new TtlCache<true>(10 * 60_000, 512);
/** Tests only. */
export const forgetCapEvents = (): void => capEventsSeen.clear();

/**
 * The `owner_cap` security event of a refusal (docs/batch-c-spec.md "On-chain owner actions" Limits): one per window,
 * subject and window start (a deterministic id), with the scope and its org (from `scopes`, when the hot DB has it).
 * The detail names the window, never the owner (an owner's window is keyed by a hash). A failure is logged, never
 * thrown: the refusal stands either way.
 */
export async function ownerCapEvent(env: Env, refusal: CapRefusal, c: { method: string; scopeId: string }): Promise<void> {
  const limit = refusal.window.limits.find((l) => l.name === refusal.limit);
  const windowStart = limit ? Math.floor(refusal.at / limit.windowMs) * limit.windowMs : refusal.at;
  const id = await eventId('owner_cap', refusal.window.subject, refusal.limit, String(windowStart));
  if (capEventsSeen.get(id)) return;
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, scope_id, detail_json)
       VALUES (?1, ?2, 'owner_cap', (SELECT org_id FROM scopes WHERE scope_id = ?3), ?3, ?4)`,
    )
      .bind(id, refusal.at, c.scopeId, JSON.stringify({ method: c.method, window: refusal.window.label, limit: refusal.limit.replace(/^safety:/u, ''), max: limit?.max ?? null, windowStart }))
      .run();
    capEventsSeen.set(id, true);
  } catch {
    log({ event: 'owner_cap_event_failed', endpoint: '/v1/owner-actions' }, 'error');
  }
}

export async function handleOwnerAction(request: Request, env: Env, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, '/v1/owner-actions', request, corsHeaders('*', 'content-type'));
  try {
    return (
      await runOwnerAction(env, ctx, {
        clientIp: request.headers.get('cf-connecting-ip'),
        body: () => readJson(request, MAX_BODY),
        ...(exec ? { exec } : {}),
      })
    ).response;
  } catch (err) {
    finishUsageOnThrow(ctx);
    throw err;
  }
}

/** Where an owner action comes from: the public endpoint, or ConsoleRpc.ownerAction (rpc/console.ts). */
export interface OwnerActionSource {
  /** The caller's address for the per-IP limiter (`cf-connecting-ip`, or the console's `clientIp`). */
  clientIp: string | null;
  /** The body, read after the per-IP limit. */
  body: () => Promise<{ ok: true; body: unknown } | { ok: false; status: number; error: string }>;
  exec?: ExecutionContext;
  /**
   * ConsoleRpc only: the org the action is for (its scope must be one of the org's in the hot DB, else 404
   * `unknown_scope`, before any chain read) and the console's token rules (precheck `console`).
   */
  console?: { orgId: string };
}

/**
 * One owner action, from the per-IP limit to the relay; the answer is the HTTP response /v1/owner-actions sends
 * (ConsoleRpc maps it). `relayed`: the transaction was sent (the outcome, good or bad, is the contract's).
 */
export async function runOwnerAction(env: Env, ctx: Ctx, src: OwnerActionSource): Promise<{ response: Response; relayed: boolean }> {
  const { requestId } = ctx;
  const no = (status: number, code: string, error: string, extra: Headers_ = {}) => ({ response: reject(ctx, status, code, error, extra), relayed: false });
  try {
    const hit = await limiter(env, `ip:${ipSubject(src.clientIp)}`).hit([{ name: 'owner-actions:minute', windowMs: MINUTE, max: OWNER_ACTIONS_PER_IP_MINUTE }]);
    if (!hit.ok) return no(429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return no(503, 'rate_limiter_unavailable', 'Try again');
  }
  const parsed = await src.body();
  if (!parsed.ok) return no(parsed.status, 'bad_request', parsed.error);
  const call = toOwnerAction(parsed.body);
  if (isError(call)) return no(400, 'bad_request', call.error);
  if (src.console) {
    // The org filter is a backstop against console bugs (spec §RPC "Trust in the actor"): one hot-DB read.
    const scopeId = call.args.scope_id as string;
    const mine = await env.DB.prepare('SELECT 1 AS ok FROM scopes WHERE scope_id = ?1 AND org_id = ?2').bind(scopeId, src.console.orgId).first();
    if (!mine) return no(404, 'unknown_scope', `No scope ${scopeId} in this org`);
  }

  // Off-chain checks: a request that would certainly fail on chain is not relayed (it would still cost gas).
  let check;
  try {
    check = await precheckOwnerAction(env, call, Date.now(), src.console ? { console: true } : {});
  } catch (err) {
    if (err instanceof JwksUnavailableError) return no(503, 'issuer_keys_unavailable', 'Could not read the token issuer keys, try again');
    return no(502, 'near_unavailable', 'Could not read the registry');
  }
  if (!check.ok) return { response: done(ctx, check.status, { error: check.error, code: check.code, ...(check.data ? { data: check.data } : {}) }), relayed: false };
  // Past the owner check: every outcome from here on is one usage event, for the scope (owner actions have no gate
  // row: the scope's org is read after the response, or is the console's, checked above).
  beginUsage(ctx, { orgId: src.console?.orgId ?? null, appId: null, scopeId: check.scopeId, ...(src.exec ? { exec: src.exec } : {}) });

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
    if (token && !(await tokens.reserve(token.hash, token.expMs))) return no(409, 'token_used', 'This owner token was already used, get a fresh one');
  } catch {
    return no(503, 'rate_limiter_unavailable', 'Try again');
  }
  try {
    const windows = await ownerActionWindows(call.method, check);
    if (!windows) {
      await release();
      return no(403, 'not_owner', 'This owner action needs an owner token');
    }
    const refused = await hitAll(env, windows, requestId);
    if (refused) {
      await release();
      await ownerCapEvent(env, refused, { method: call.method, scopeId: check.scopeId });
      return no(429, 'rate_limited', `Rate limit exceeded (${refused.window.label} per ${refused.limit.replace(/^safety:/u, '')})`, { 'retry-after': String(refused.retryAfterS) });
    }
  } catch {
    await release();
    return no(503, 'rate_limiter_unavailable', 'Try again');
  }

  lap(ctx, 'checks');
  const result = await relay(env, 'owner', call, requestId);
  lapRelay(ctx, result);
  forgetScope(check.scopeId);
  // The reservation stays unless the transaction certainly never executed (an unknown outcome may still land).
  if (!result.ok && NOT_EXECUTED.has(result.code)) await release();
  if (!result.ok) return { response: done(ctx, result.status, { error: result.error, code: result.code, nearTx: result.nearTx }), relayed: true };
  return { response: done(ctx, 200, { result: result.result ?? null, nearTx: result.nearTx }), relayed: true };
}

// ---- Health ----

/**
 * What this build does that deploy tooling must check before a step that depends on it (batch 6 review M2):
 * `createProof`: `/v1/sessions` requires and relays create_session's proof of possession (D137), so contract v3 may be
 * deployed (`deploy-contract --upgrade` refuses without it on the env's API).
 */
export const API_CAPABILITIES = { createProof: true } as const;

/**
 * `hotDb`: the hot-DB migration this build needs (apps.ts HOT_DB_SCHEMA). The admin CLI refuses guarded proposals
 * until the deployed API reports 6 or more (an API from before batch C3 would treat an origin that is only proposed as
 * in force; docs/operations.md "Rolling the API back below batch C3"), and announcements until it reports 9 or more
 * (the batch C4 API writes the session markers the `no_session` waiver reads).
 * `build`: the build id this Worker was deployed with, or null (build.ts, D384), which `deploy-check` compares with the
 * page Workers', their bundles' and the email issuer's.
 */
export function handleHealth(env: Env, requestId: string): Response {
  return json(
    200,
    { ok: true, env: env.ENV_NAME, signer: env.SIGNER_ACCOUNT, hotDb: HOT_DB_SCHEMA, capabilities: API_CAPABILITIES, usageCapture: env.USAGE_DB !== undefined, build: deployedBuild(env.HANA_BUILD), requestId },
    { 'access-control-allow-origin': '*', 'x-request-id': requestId },
  );
}
