// POST /v1/home/login (docs/hana-home-spec.md "API changes", D463, H3): Hana Home's derive. A Home identity derives its
// own key in any registered scope, with no app gate: a suspended or deleted app, or one with no allowed origin left,
// doesn't stop it (Home is keyed by scope, D461). One `create_session_and_derive`, relayed from the Home pool. On chain
// a derive also records the identity as `opened`, for good (`note_opened`), and an opened identity can never be linked to
// another wallet. So a derive by an identity the chain shows hasn't opened a wallet in this scope is refused, before
// anything is counted or relayed: there is nothing to rescue, and it would cost that user a future link (D544). Only
// someone who already had `opened` gets here, or a member, or anyone where links aren't open yet and the view isn't read.
//
// What stands in for the app gate is the user: the request carries a fresh Home identity (homeGate: `Origin === AUTH_ORIGIN`,
// the per-IP limit, the Home token, its key's signature over this exact body, single use), and the body's own session
// token must be the same identity's, with a nonce committing to this session in this scope. So a token can only ever
// reach its own user's key, in the one scope its nonce names. In order: the gate; shape; the token and its nonce; the
// identity matches; the counter hold; the client admitted for the scope, the session key free, governance, the standing
// (a member reaches its root's path; a pending member is refused); the session key's signature; the BLS shape; every limit;
// then the relay. No limit is counted before the checks that a request can fail, and nothing is relayed unless every
// check and limit passed.
//
// The address is never affected: the contract derives from the token's identity and the chain-resolved root, exactly as
// a partner login does, `aud` never enters the path, and `key_index` is fixed to 0 here (Home opens only the address it
// shows). A Home session is one use and short-lived, so it can't be used past these limits afterwards.
//
// The derive is not a login of any app: it marks no app as launched (D462: no `first_login_at`, no `first_session_at`, no
// session marker) and counts in no app's quota. A derive that reaches the relay is one usage event (`home_login`, no app,
// no uid: usage/event.ts), written after the response for the org that pays for it (billing.ts, D461). It records `key_exported` for the account, with `app_id` NULL
// (D520) and, only for an identity the directory already holds as active or a confirmed linked member, refreshes its
// directory row (D500, D527), both after the response.
//
// SECURITY: nothing here logs a token, a `sub`, a path or a path hash. A limiter name is a hash, never a `sub`.
import { appKeyPairs, appKeyProblem } from '../bls.ts';
import { hex, sha256 } from '../bytes.ts';
import { eventId } from '../changes/guard.ts';
import { identityKeyHex, sessionSupportId } from '../directory/store.ts';
import { inBackground, syncAfterLogin } from '../directory/sync.ts';
import type { Env } from '../env.ts';
import { type OwnerActionWindow, NOT_EXECUTED, chainGate, chainGateResponse, checkClientScope, done, hitAll, lap, lapRelay, limiter, loginTokenRefusal, newCtx, reject, settle } from '../handlers.ts';
import { log } from '../log.ts';
import { type LoginCall, loginFailure, toLogin } from '../login.ts';
import { verifyLoginToken } from '../login-token.ts';
import { recordKeyExport } from '../mainnet-demo.ts';
import { sha256Hex } from '../owner-actions.ts';
import { recalledPanic, rememberPanic, requestKey } from '../panic-cache.ts';
import { ALREADY_RELAYED } from '../relayer-config.ts';
import { relay } from '../relayer-pool.ts';
import { ckdPayload, sessionNonce, verifySessionSignature } from '../session-crypto.ts';
import { beginUsage, finishUsageOnThrow } from '../usage/event.ts';
import { sessionStanding } from '../session-standing.ts';
import { claimCounter } from '../session-use.ts';
import { type Checked, isError } from '../validate.ts';
import { forgetSession, getConfig, getScope, isExitClient, sessionKeyInUse } from '../views.ts';
import { homeGate } from './identity.ts';

export const HOME_LOGIN_ENDPOINT = '/v1/home/login';
/** docs/hana-home-spec.md "Rate limits". */
export const HOME_LOGIN_PER_IP_HOUR = 10;
/** Requests a minute per Home key (the per-IP hour is the binding one; a key's requests are still counted like every Home route's). */
export const HOME_LOGIN_PER_KEY_MINUTE = 10;
/** A derive per wallet (D59's bound): the same three an hour an export window gets per app. */
export const HOME_DERIVES_PER_PATH_HOUR = 3;
export const HOME_DERIVES_PER_USER_HOUR = 10;
export const HOME_DERIVES_PER_USER_DAY = 20;
/** Across the env, per UTC day (D98 item 11; about $10 a day at the default). */
export const HOME_DERIVES_PER_DAY_DEFAULT = 500;
/** How far ahead a Home session may end: the export window's 15 minutes with the Home identity's margin. Inside the contract's exit cap (30 minutes, D486). */
export const HOME_SESSION_MAX_MS = 20 * 60_000;
/** A `home_budget_high` security event is written when a day's derives reach this share of the ceiling (D85, D541). */
const HOME_USAGE_ALERT_PCT = 80;
/** The event is attempted on this many requests past the threshold, so one lost write doesn't lose the day's alert; its fixed id keeps it to one row. */
const HOME_USAGE_ALERT_TRIES = 5;
/** The share of the daily ceiling an identity with no directory row may use (D540). */
const HOME_UNRECORDED_PCT = 20;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const SCOPE_RE = /^[a-z0-9]{1,64}$/u;
/** What a Home body can't carry: a Home derive never links a sign-in method (the contract also refuses a link on an exit session, D486) and has no export window. */
const REFUSED_FIELDS: readonly string[] = ['linkJwt', 'linkImmediate', 'exportChain'];

export type HomeLoginCall = LoginCall & { scopeId: string };

/**
 * `/v1/login`'s body plus `scopeId`, and nothing a Home derive can't use: `key_index` 0, the only address Home shows (a
 * nonzero index would also escape the per-wallet limit, the path differing by index), and one use within
 * HOME_SESSION_MAX_MS, so the session can't serve further derives past these limits. The scope is the request's own here
 * (no app's), and the token's nonce must commit to it.
 */
export function toHomeLogin(body: unknown, now: number = Date.now()): Checked<HomeLoginCall> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object' };
  const { scopeId, ...rest } = body as Record<string, unknown>;
  if (typeof scopeId !== 'string' || !SCOPE_RE.test(scopeId)) return { error: 'scopeId must be 1 to 64 lower-case letters or digits' };
  const refused = REFUSED_FIELDS.find((f) => f in rest);
  if (refused !== undefined) return { error: `Unexpected field ${refused}` };
  const call = toLogin(rest, scopeId, now);
  if (isError(call)) return call;
  if (call.request.keyIndex !== 0) return { error: 'A Home derive uses keyIndex 0' };
  if (call.request.maxUses !== 1) return { error: 'A Home derive uses maxUses 1' };
  if (call.request.expiresAtMs > now + HOME_SESSION_MAX_MS) return { error: 'A Home session ends within 20 minutes' };
  return { ...call, scopeId };
}

/** The daily ceiling: the var HOME_DERIVES_PER_DAY when it is an integer of 0 or more (0 is a kill switch: no derive at all, D529), else the default. */
export function homeDerivesPerDay(env: Pick<Env, 'HOME_DERIVES_PER_DAY'>): number {
  const v = env.HOME_DERIVES_PER_DAY;
  return v !== undefined && /^(0|[1-9]\d{0,6})$/u.test(v) ? Number(v) : HOME_DERIVES_PER_DAY_DEFAULT;
}

const utcDay = (now: number): string => new Date(now).toISOString().slice(0, 10);
const secondsToNextUtcDay = (now: number): number => Math.max(1, Math.ceil((Math.ceil((now + 1) / DAY) * DAY - now) / 1000));

/**
 * What identities with no directory row may use of a ceiling of `max` (D540): 20%, rounded down, at least 1 so that they
 * aren't locked out at a small ceiling, and always leaving at least one derive for people with records (a ceiling of 1
 * gives them nothing).
 */
export const homeUnrecordedCeiling = (max: number): number => Math.max(0, Math.min(max - 1, Math.max(1, Math.floor((max * HOME_UNRECORDED_PCT) / 100))));

/**
 * One more Home derive for the day, atomically (one D1 statement): the new count, or null at the ceiling (the row stays
 * as it was). `unrecorded`: an identity with no directory row, also held to `homeUnrecordedCeiling`, in the same statement.
 * Throws when D1 can't be written: the caller refuses, since an uncounted derive is one the budget can't see.
 */
export async function countHomeDerive(env: Pick<Env, 'DB'>, day: string, max: number, unrecorded = false): Promise<number | null> {
  // The statements below always insert a day's first row, so a ceiling of 0 has to refuse before them.
  const share = homeUnrecordedCeiling(max);
  if (max <= 0 || (unrecorded && share <= 0)) return null;
  if (unrecorded) {
    const row = await env.DB.prepare('INSERT INTO home_usage (day, derives, unrecorded) VALUES (?1, 1, 1) ON CONFLICT (day) DO UPDATE SET derives = derives + 1, unrecorded = unrecorded + 1 WHERE derives < ?2 AND unrecorded < ?3 RETURNING derives')
      .bind(day, max, share)
      .first<{ derives: number }>();
    return row?.derives ?? null;
  }
  const row = await env.DB.prepare('INSERT INTO home_usage (day, derives) VALUES (?1, 1) ON CONFLICT (day) DO UPDATE SET derives = derives + 1 WHERE derives < ?2 RETURNING derives')
    .bind(day, max)
    .first<{ derives: number }>();
  return row?.derives ?? null;
}

/**
 * Whether `(provider, aud)` may open a session in `scopeId` through Home: an exit client in force reaches any registered
 * scope (D468), and otherwise the scope's own client or a shared client, exactly as a partner login. Only here: a partner
 * login's `checkClientScope` stays closed to exit clients.
 */
export async function checkHomeClientScope(env: Env, provider: string, aud: string, scopeId: string, now: number): Promise<{ status: number; code: string; error: string } | null> {
  if (isExitClient(await getConfig(env), provider, aud, now)) {
    return (await getScope(env, scopeId)) ? null : { status: 403, code: 'unknown_scope', error: 'The scope is not registered' };
  }
  return checkClientScope(env, provider, aud, scopeId, now);
}

export async function handleHomeLogin(request: Request, env: Env, requestId: string, exec?: ExecutionContext, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, HOME_LOGIN_ENDPOINT, request);
  // 1. The Home identity (identity.ts): Origin, the per-IP hour, the Home token, its key's signature over this body, single use.
  const gate = await homeGate(request, env, ctx, { ipPerHour: HOME_LOGIN_PER_IP_HOUR, keyPerMinute: HOME_LOGIN_PER_KEY_MINUTE, window: 'login' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');

  // 2. Shape.
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(gate.body));
  } catch {
    return reject(ctx, 400, 'bad_request', 'Body must be JSON');
  }
  const call = toHomeLogin(parsed, now);
  if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);
  const req = call.request;
  const { scopeId } = call;

  // 3. A genuine token (no app to hold it to: login-token.ts `anyLoginMethod`), carrying only allow-listed claims, whose
  // nonce commits to this session in this scope on this signer.
  const verified = await verifyLoginToken(env, req.jwt, now, { anyLoginMethod: true, exec });
  if (!verified.ok) return loginTokenRefusal(ctx, verified);
  const token = verified.token;
  if (token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');
  if (token.nonce !== (await sessionNonce({ signer: env.SIGNER_ACCOUNT, scopeId, ...req }))) return reject(ctx, 400, 'nonce_mismatch', 'The ID token nonce does not commit to this session');
  // 4. The same identity as the Home sign-in (`sub` is global, so one Home user can't open another user's key).
  if (token.provider !== gate.identity.provider || token.sub !== gate.identity.sub) return reject(ctx, 403, 'home_account_mismatch', 'Sign in as the same account you used in Home');

  const panicKey = await requestKey(call.method, call.args);
  const recalled = recalledPanic(panicKey);
  if (recalled) return done(ctx, recalled.status, { error: recalled.error, code: recalled.code });

  // 5. A login uses counter 1: a copy of this request in this isolate waits for this one (session-use.ts).
  const release = await claimCounter(req.sessionPublicKey, 1);
  try {
    // 6. Beside each other (all read the chain): the client admitted for this scope, the session key free, the contract
    // not paused and the token's kid active on chain, and where the identity stands. A standing the chain didn't confirm
    // fails closed here (unlike a partner login): the per-wallet limit needs the real path.
    const [scope, inUse, gov, standing] = await Promise.all([
      settle(checkHomeClientScope(env, token.provider, token.aud, scopeId, now)),
      settle(sessionKeyInUse(env, req.sessionPublicKey, now)),
      chainGate(env, token.kid === null ? null : { provider: token.provider, kid: token.kid }, requestId),
      sessionStanding(env, scopeId, token.provider, token.sub, req.keyIndex),
    ]);
    if (!scope.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the scope');
    if (scope.value) return reject(ctx, scope.value.status, scope.value.code, scope.value.error);
    if (!inUse.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the scope');
    if (inUse.value) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
    if (gov) return chainGateResponse(ctx, gov);
    if (!standing.confirmed) return reject(ctx, 502, 'near_unavailable', 'Could not read this identity');
    if (standing.pending) return reject(ctx, 409, 'link_pending', 'This sign-in method’s link is pending');
    // Nothing to rescue (D544): from the view the standing already read, so no extra chain read. Not a member, and only
    // where links are open (`opened` is absent otherwise).
    if (standing.opened === false && !standing.member) return reject(ctx, 404, 'home_no_wallet', 'No wallet for this sign-in in that app');
    lap(ctx, 'checks');

    // 7. The session key signed the CKD request with counter 1.
    if (!(await verifySessionSignature(req.sessionPublicKey, 1, req.signature, ckdPayload(req.pk1, req.pk2)))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
    // 8. The app key: well-formed always; its pairing only behind BLS_PRECHECK (CPU-heavy, Workers Paid only).
    const keyProblem = appKeyProblem(req.pk1, req.pk2);
    if (keyProblem) return reject(ctx, 400, 'invalid_app_key', keyProblem);
    if (env.BLS_PRECHECK === '1' && !(await appKeyPairs(req.pk1, req.pk2))) return reject(ctx, 400, 'invalid_app_key', 'pk1 and pk2 are not the same key');

    // A user the directory already holds or a confirmed member is `recorded` (D527: only these get a directory row). The
    // chain's `opened` also counts as known for the daily share (D540): safe only because D544 refuses the unopened, so a
    // derive can't promote anyone. A D1 failure is retried, never charged to the smaller share.
    let recorded: boolean;
    try {
      recorded = standing.member !== undefined || (await holdsActiveRow(env, scopeId, token));
    } catch {
      return reject(ctx, 503, 'home_directory_unavailable', 'Try again', { 'retry-after': '1' });
    }
    const known = recorded || standing.opened === true;

    // 9. The limits, last: only a request every check passed counts (as appQuota, D100), so a refused request spends
    // nothing and the per-wallet and per-user windows can't be spent by a request that couldn't have been relayed.
    const hitAt = Date.now();
    const windows = await homeWindows(scopeId, standing.path, { provider: token.provider, sub: token.sub });
    const walletWindow = windows[0] as OwnerActionWindow;
    try {
      const refused = await hitAll(env, windows, requestId, HOME_LOGIN_ENDPOINT, hitAt);
      if (refused) return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (${refused.window.label} per ${refused.limit.endsWith('day') ? 'day' : 'hour'})`, { 'retry-after': String(refused.retryAfterS) });
    } catch {
      return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
    }
    const day = utcDay(hitAt);
    const max = homeDerivesPerDay(env);
    const takeBack = (): Promise<unknown> => Promise.allSettled(windows.map(async (w) => limiter(env, w.subject).unhit(w.limits, hitAt)));
    let count: number | null;
    try {
      count = await countHomeDerive(env, day, max, !known);
    } catch {
      await takeBack();
      return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
    }
    if (count === null) {
      await takeBack();
      return reject(ctx, 429, 'home_busy', 'Hana Home is busy, try again tomorrow', { 'retry-after': String(secondsToNextUtcDay(hitAt)) });
    }
    const alertAt = Math.ceil((max * HOME_USAGE_ALERT_PCT) / 100);
    if (count >= alertAt && count < alertAt + HOME_USAGE_ALERT_TRIES) await inBackground(exec, () => noteBudgetHigh(env, day, count as number, max, requestId));

    lap(ctx, 'limits');
    // From here on every outcome is one usage event (`lapRelay` notes the transaction, `done` closes it): a derive that
    // reached the relay. Its org is chosen after the response; with capture off nothing is built or read.
    beginUsage(ctx, { orgId: null, appId: null, scopeId, exec });
    const result = await relay(env, 'home', { method: call.method, args: call.args }, requestId, { sessionPublicKey: req.sessionPublicKey, expiresAtMs: req.expiresAtMs, counter: 1 });
    lapRelay(ctx, result);
    forgetSession(req.sessionPublicKey);
    if (!result.ok) {
      // A transaction that certainly never ran spends none of the budget. Anything else may have, and stays counted.
      if (result.code === ALREADY_RELAYED || NOT_EXECUTED.has(result.code)) await inBackground(exec, () => Promise.all([takeBack(), giveBackDerive(env, day, !known)]));
      if (result.code === ALREADY_RELAYED) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
      const failure = loginFailure(env, result);
      // The MPC failed after the session was committed and the one-use session is spent: no key came back, and the user
      // must sign in again to retry, so it shouldn't cost a wallet's 3 an hour. The per-user and daily counts stay (D528).
      if (failure.body.code === 'ckd_failed') await inBackground(exec, async () => limiter(env, walletWindow.subject).unhit(walletWindow.limits, hitAt));
      if (typeof failure.body.code === 'string' && typeof failure.body.error === 'string') rememberPanic(panicKey, { status: failure.status, code: failure.body.code, error: failure.body.error });
      return done(ctx, failure.status, failure.body);
    }
    const r = result.result as { big_y?: unknown; big_c?: unknown } | null;
    if (!r || typeof r.big_y !== 'string' || typeof r.big_c !== 'string') return done(ctx, 502, { error: 'The contract returned no key', code: 'bad_contract_result', nearTx: result.nearTx });

    // After the answer: the account's key_exported event (chain null: one derive opens every chain, D98 item 6, D770; app_id
    // null, D520) and, for a user the directory or the chain already knows here (D527), its directory row (D500: it is
    // what turns a linked member `mine` in Home's list). A stranger gets no row, so no `mine` and no unlaunched apps.
    const root = standing.member?.root ?? { provider: token.provider, sub: token.sub };
    if (recorded) await inBackground(exec, () => syncAfterLogin(env, scopeId, { provider: token.provider, sub: token.sub }, null, standing, { requestId, endpoint: ctx.endpoint }));
    await inBackground(exec, () => recordKeyExport(env, { appId: null, scopeId, root, chain: null, requestId }));
    // A code staff can't look up is worse than none (D395): none without a directory row.
    const supportId = recorded ? await sessionSupportId(env, scopeId, root) : undefined;
    return done(ctx, 200, {
      result: { big_y: r.big_y, big_c: r.big_c },
      session: { scope_id: scopeId, expires_at_ms: req.expiresAtMs, max_uses: req.maxUses, used: 1 },
      nearTx: result.nearTx,
      ...(supportId ? { supportId } : {}),
    });
  } catch (err) {
    // A throw after the relay still leaves its transaction in the ledger (500 `internal`); a no-op before the event opened.
    finishUsageOnThrow(ctx);
    throw err;
  } finally {
    release();
  }
}

/** The per-wallet and per-user windows, most specific first. A limiter subject is a hash: never a `sub`. */
async function homeWindows(scopeId: string, path: string, user: { provider: string; sub: string }): Promise<OwnerActionWindow[]> {
  const pathHash = hex(await sha256(new TextEncoder().encode(path)));
  return [
    { subject: `home-path:${scopeId}:${pathHash}`, label: 'derives per wallet', limits: [{ name: 'home:path:hour', windowMs: HOUR, max: HOME_DERIVES_PER_PATH_HOUR }] },
    {
      subject: `home-user:${await sha256Hex(`${user.provider}#${user.sub}`)}`,
      label: 'derives per user',
      limits: [
        { name: 'home:user:hour', windowMs: HOUR, max: HOME_DERIVES_PER_USER_HOUR },
        { name: 'home:user:day', windowMs: DAY, max: HOME_DERIVES_PER_USER_DAY },
      ],
    },
  ];
}

/** Whether the directory holds this identity as active in the scope (D527). Throws when D1 can't answer: the caller refuses, retryable. */
async function holdsActiveRow(env: Pick<Env, 'DB'>, scopeId: string, identity: { provider: string; sub: string }): Promise<boolean> {
  return (await env.DB.prepare("SELECT 1 AS ok FROM end_user_identities WHERE scope_id = ?1 AND identity_key = ?2 AND status = 'active'").bind(scopeId, await identityKeyHex(scopeId, identity)).first()) !== null;
}

/**
 * The day's alert (D541): one `home_budget_high` security event, which the admin's Security & monitoring view shows and its
 * feed emails. A fixed id per day, so at most one row. Counts only: no `sub`, path, scope or address. Never throws.
 */
async function noteBudgetHigh(env: Pick<Env, 'DB'>, day: string, derives: number, ceiling: number, requestId: string): Promise<void> {
  try {
    await env.DB.prepare("INSERT OR IGNORE INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, ?2, 'home_budget_high', ?3)")
      .bind(await eventId('home_budget_high', day), Date.now(), JSON.stringify({ day, derives, ceiling, thresholdPct: HOME_USAGE_ALERT_PCT }))
      .run();
  } catch {
    log({ event: 'home_budget_alert_failed', endpoint: HOME_LOGIN_ENDPOINT, requestId }, 'warn');
  }
}

/** Gives the day's budget back after a relay that never ran. Never throws: a failed give-back leaves the count high. */
async function giveBackDerive(env: Pick<Env, 'DB'>, day: string, unrecorded: boolean): Promise<void> {
  try {
    await env.DB.prepare('UPDATE home_usage SET derives = derives - 1, unrecorded = unrecorded - ?2 WHERE day = ?1 AND derives > 0 AND unrecorded >= ?2').bind(day, unrecorded ? 1 : 0).run();
  } catch {
    log({ event: 'home_usage_give_back_failed', endpoint: HOME_LOGIN_ENDPOINT }, 'warn');
  }
}

