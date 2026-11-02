// POST /v1/login (docs/batch-b-spec.md, "API changes"): one transaction per login. Relays hana-signer's
// create_session_and_derive, a literal composition of create_session and derive_key with counter 1, so a login costs
// one transaction instead of two. Called by the vault (and the export window on authOrigin) with the token it got
// through the relay; the vault computes the path itself and never uses what this returns beyond `result`.
import { usageDay } from './apps.ts';
import { appKeyPairs, appKeyProblem } from './bls.ts';
import { isJsonForm } from './email-token.ts';
import { countEmailUsage } from './email-usage.ts';
import type { Env } from './env.ts';
import { hex, sha256 } from './bytes.ts';
import { appGate, appQuota, chainGate, chainGateResponse, checkClientScope, done, firstSession, lap, lapRelay, limiter, loginTokenRefusal, newCtx, reject, settle } from './handlers.ts';
import { readJson } from './http.ts';
import { type LinkRefusal, checkKey, precheckAutoLink } from './link-precheck.ts';
import { getAccount, getIdentity } from './link-views.ts';
import { type LoginToken, verifyLoginToken } from './login-token.ts';
import { log } from './log.ts';
import { signerPanic } from './panics.ts';
import { isTestApp } from './origins.ts';
import type { RelayResult } from './relayer-key.ts';
import { relay } from './relayer-pool.ts';
import { ckdPayload, linkedCkdPayload, sessionNonce, sessionNoncePreimage, verifySessionSignature } from './session-crypto.ts';
import { claimCounter } from './session-use.ts';
import { type Checked, type CreateSessionRequest, MAX_BODY, isError, isToken, toCreateSession, toDeriveKey } from './validate.ts';
import { forgetSession, getConfig, sessionKeyInUse } from './views.ts';

export const LOGIN_ENDPOINT = '/v1/login';
/**
 * Key exports (the export window's /v1/login, from authOrigin) per user path per app (docs/batch-b-spec.md Q18): each
 * one is a relayer-paid transaction, so a page that keeps starting exports can't drain the allowance. Counted per
 * `(app, sha256(path))` once the token is verified, before anything is relayed.
 */
export const EXPORTS_PER_PATH_HOUR = 3;
const HOUR = 3_600_000;

/** The rate-limiter subject of a user's exports in one app: the path is hashed (it carries the Google `sub`). */
export async function exportLimiterKey(appId: string, path: string): Promise<string> {
  return `export:${appId}:${hex(await sha256(new TextEncoder().encode(path)))}`;
}
/** The contract's panic when the session key already holds a session (a front-run create_session or a replay). */
export const SESSION_KEY_IN_USE_PANIC = 'Session key already in use';

const CREATE_FIELDS: ReadonlySet<string> = new Set(['jwt', 'sessionPublicKey', 'expiresAtMs', 'salt', 'keyIndex', 'maxUses']);

export interface LoginCall {
  request: CreateSessionRequest & { signature: number[]; pk1: string; pk2: string; linkJwt: string | null; linkImmediate: boolean };
  method: 'create_session_and_derive';
  args: Record<string, unknown>;
}

/**
 * Checks 2–3: a /v1/sessions body plus `{signature, pk1, pk2}` and, for email login's automatic link, `linkJwt` (an
 * email token) and `linkImmediate` (a boolean, only with `linkJwt`), nothing else, each by the rules of /v1/sessions
 * and /v1/derive (keyIndex < 2^31 included). The scope is the app's (D1), never the client's; the counter is always 1.
 * Without a link the relayed arguments are exactly batch B's (no `link_jwt`, no `link_immediate`).
 */
export function toLogin(body: unknown, scopeId: string, now = Date.now()): Checked<LoginCall> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'Body must be a JSON object' };
  const { signature, pk1, pk2, linkJwt, linkImmediate, ...rest } = body as Record<string, unknown>;
  const create = toCreateSession(rest, scopeId, now);
  if (isError(create)) return create;
  const extra = Object.keys(rest).find((k) => !CREATE_FIELDS.has(k));
  if (extra !== undefined) return { error: `Unexpected field ${extra.slice(0, 64)}` };
  const derive = toDeriveKey({ sessionPublicKey: create.request.sessionPublicKey, counter: 1, signature, pk1, pk2 });
  if (isError(derive)) return derive;
  if (linkJwt !== undefined && !(isToken(linkJwt) && isJsonForm(linkJwt))) return { error: 'linkJwt must be an email token' };
  if (linkImmediate !== undefined && typeof linkImmediate !== 'boolean') return { error: 'linkImmediate must be a boolean' };
  if (linkImmediate !== undefined && linkJwt === undefined) return { error: 'linkImmediate needs a linkJwt' };
  const link = linkJwt === undefined ? null : { link_jwt: linkJwt, link_immediate: linkImmediate === true };
  return {
    request: { ...create.request, signature: derive.signature, pk1: derive.pk1, pk2: derive.pk2, linkJwt: link?.link_jwt ?? null, linkImmediate: link?.link_immediate ?? false },
    method: 'create_session_and_derive',
    args: { ...create.args, signature: derive.signature, pk1: derive.pk1, pk2: derive.pk2, ...(link ?? {}) },
  };
}

type Failure = Extract<RelayResult, { ok: false }>;

/**
 * Which part of the combined call failed, from the failing receipt's executor: the signer (the session was not
 * created, everything reverted), the MPC (the session is committed with `used = 1`, only the CKD failed), or neither
 * (unknown: the caller must look at the transaction).
 */
export function loginFailure(env: Pick<Env, 'SIGNER_ACCOUNT' | 'MPC_ACCOUNT'>, result: Failure): { status: number; body: Record<string, unknown> } {
  const { error, code, nearTx } = result;
  if (code !== 'contract_rejected') return { status: result.status, body: { error, code, nearTx } };
  // The email-login panics (a pending or linked sign-in method, links not open yet, a refused link): panics.ts.
  const mapped = signerPanic(env, result);
  if (mapped) return { status: mapped.status, body: { ...mapped.body, nearTx } };
  if (result.executor === env.SIGNER_ACCOUNT) {
    const reason = error.includes(SESSION_KEY_IN_USE_PANIC) ? { reason: 'session_key_in_use' } : {};
    return { status: 422, body: { error, code: 'contract_rejected', ...reason, nearTx } };
  }
  if (env.MPC_ACCOUNT && result.executor === env.MPC_ACCOUNT) {
    return { status: 422, body: { error: 'The key derivation failed; the session was created and its use spent', code: 'ckd_failed', session: { used: 1 }, nearTx } };
  }
  return { status: 502, body: { error: 'The transaction failed in an unexpected receipt', code: 'near_error', nearTx } };
}

export async function handleLogin(request: Request, env: Env, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, LOGIN_ENDPOINT, request);
  const now = Date.now();
  // 1. App, caller (the vault or the export window, for an allowed parent origin), the per-IP limit.
  const gate = await appGate(request, env, ctx, 'relay');
  if (!gate.ok) return gate.response;
  const { app } = gate;
  // Test-scope apps: the success response carries the request's own timings (apps/smoke's login breakdown).
  ctx.exposeTimings = isTestApp(app);

  // 2–3. Size and shape.
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const call = toLogin(parsed.body, app.scope_id, now);
  if (isError(call)) return reject(ctx, 400, 'bad_request', call.error);
  const req = call.request;

  // 4. A genuine, unexpired token, carrying only allow-listed claims, whose nonce commits to this session in this app's
  //    scope on this signer: a Google ID token, or an email token for an app with email on (login-token.ts). A link
  //    token is an email token too, for the same app.
  const verified = await verifyLoginToken(env, req.jwt, now, { claimAllowList: true, appId: app.id, exec });
  if (!verified.ok) return loginTokenRefusal(ctx, verified);
  const token = verified.token;
  if (token.nonce === null) return reject(ctx, 400, 'nonce_mismatch', 'The ID token has no nonce');
  const session = { signer: env.SIGNER_ACCOUNT, scopeId: app.scope_id, ...req };
  const expected = await sessionNonce(session);
  if (token.nonce !== expected) return reject(ctx, 400, 'nonce_mismatch', 'The ID token nonce does not commit to this session');
  let link: LoginToken | null = null;
  if (req.linkJwt !== null) {
    // An export window never links (it opens an existing path), and a link comes only from the email issuer.
    if (gate.caller.page === 'auth') return reject(ctx, 400, 'bad_request', 'An export does not carry a link');
    const linked = await verifyLoginToken(env, req.linkJwt, now, { claimAllowList: true, appId: app.id, exec });
    if (!linked.ok) return loginTokenRefusal(ctx, linked);
    if (!linked.token.email) return reject(ctx, 400, 'bad_request', 'linkJwt must be an email token');
    link = linked.token;
  }

  // An export (the auth origin's window): at most EXPORTS_PER_PATH_HOUR per user path per app.
  if (gate.caller.page === 'auth') {
    try {
      const key = await exportLimiterKey(app.id, `${app.scope_id}#${token.provider}#${token.sub}#${req.keyIndex}`);
      const hit = await limiter(env, key).hit([{ name: 'export:hour', windowMs: HOUR, max: EXPORTS_PER_PATH_HOUR }]);
      if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Too many key exports for this account, try again later', { 'retry-after': String(hit.retryAfterS) });
    } catch {
      return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
    }
  }

  // A login uses counter 1: a copy of this request in this isolate waits for this one rather than being relayed
  // beside it (at most one can succeed), and is then refused by session_key_in_use.
  const release = await claimCounter(req.sessionPublicKey, 1);
  try {
    // 5. Scope, session key, and governance (not paused; the token's kid active on chain, not still in its
    //    issuer-key delay), side by side (all read the chain).
    const [scope, inUse, gov, linkScope] = await Promise.all([
      settle(checkClientScope(env, token.provider, token.aud, app.scope_id, now)),
      settle(sessionKeyInUse(env, req.sessionPublicKey, now)),
      chainGate(env, token.kid === null ? null : { provider: token.provider, kid: token.kid }, requestId),
      link ? settle(checkClientScope(env, link.provider, link.aud, app.scope_id, now)) : Promise.resolve(null),
    ]);
    if (!scope.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (scope.value) return reject(ctx, scope.value.status, scope.value.code, scope.value.error);
    if (linkScope && !linkScope.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (linkScope?.value) return reject(ctx, linkScope.value.status, linkScope.value.code, `The link token: ${linkScope.value.error}`);
    if (!inUse.ok) return reject(ctx, 502, 'near_unavailable', 'Could not read the app registry');
    if (inUse.value) return reject(ctx, 409, 'session_exists', 'This session key is already in use');
    if (gov) return chainGateResponse(ctx, gov);

    // 6. The session key signed the CKD request with counter 1: with a link, the linked CKD payload, which binds the
    //    link token and its mode (D133), so only the key holder decides whether a link is attached and which.
    const payload = req.linkJwt === null ? ckdPayload(req.pk1, req.pk2) : await linkedCkdPayload(req.pk1, req.pk2, req.linkJwt, req.linkImmediate);
    if (!(await verifySessionSignature(req.sessionPublicKey, 1, req.signature, payload))) {
      return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
    }
    // 6b. The link the token commits to is the one the contract would make now (link-precheck.ts, D133).
    if (link) {
      const refusal = await precheckLoginLink(env, app.scope_id, session, token, link, req.linkImmediate);
      if (refusal) return done(ctx, refusal.status, { error: refusal.error, code: refusal.code, ...(refusal.reason ? { reason: refusal.reason } : {}) });
    }
    // 7–8. The app key: well-formed always; its pairing only behind BLS_PRECHECK (CPU-heavy, Workers Paid only).
    const keyProblem = appKeyProblem(req.pk1, req.pk2);
    if (keyProblem) return reject(ctx, 400, 'invalid_app_key', keyProblem);
    if (env.BLS_PRECHECK === '1' && !(await appKeyPairs(req.pk1, req.pk2))) return reject(ctx, 400, 'invalid_app_key', 'pk1 and pk2 are not the same key');
    lap(ctx, 'checks');
    // 9. The app's quota (plan per_minute / per_day), counted only now that the request passed every check (D100).
    const quota = await appQuota(env, ctx, app);
    if (quota) return quota;

    const noted = firstSession(env, app, ctx, exec);
    const result = await relay(env, 'session', { method: call.method, args: call.args }, requestId);
    await noted;
    lapRelay(ctx, result);
    // Whatever happened, the session (if any) is read from chain next time.
    forgetSession(req.sessionPublicKey);
    if (!result.ok) {
      const failure = loginFailure(env, result);
      // The session was committed even though the CKD failed: it counts as one.
      if (failure.body.code === 'ckd_failed') await countLogin(env, app.id, false, ctx, exec);
      return done(ctx, failure.status, failure.body);
    }
    const r = result.result as { big_y?: unknown; big_c?: unknown } | null;
    if (!r || typeof r.big_y !== 'string' || typeof r.big_c !== 'string') return done(ctx, 502, { error: 'The contract returned no key', code: 'bad_contract_result', nearTx: result.nearTx });
    await countLogin(env, app.id, true, ctx, exec);
    if (token.email) await countEmailUsage(env, app.id, 'email_sessions', ctx, exec);
    if (link) await countEmailUsage(env, app.id, 'links', ctx, exec);
    return done(ctx, 200, {
      result: { big_y: r.big_y, big_c: r.big_c },
      // Informational: what the session must look like now. The vault reads the chain, never this.
      session: { scope_id: app.scope_id, expires_at_ms: req.expiresAtMs, max_uses: req.maxUses, used: 1 },
      nearTx: result.nearTx,
    });
  } finally {
    release();
  }
}

/** Counts a session and, when the CKD succeeded, a derive (one D1 write, after the response when it can). Never rejects. */
async function countLogin(env: Env, appId: string, derived: boolean, ctx: { requestId: string; endpoint: string }, exec?: ExecutionContext): Promise<void> {
  const derives = derived ? 1 : 0;
  const write = env.DB.prepare(
    `INSERT INTO usage (app_id, day, sessions, derives) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (app_id, day) DO UPDATE SET sessions = sessions + 1, derives = derives + ?3`,
  )
    .bind(appId, usageDay(Date.now()), derives)
    .run()
    .then(() => undefined)
    .catch(() => {
      log({ event: 'usage_increment_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint }, 'error');
    });
  if (exec) exec.waitUntil(write);
  else await write;
}

/**
 * The link precheck of a login with `linkJwt` (link-precheck.ts): links open on chain (contract v3, the owner accepted
 * the pre-v3 wallets, D135), then both identities and their accounts read fresh, then the contract's auto_link rules.
 * Null when the login may be relayed; otherwise the refusal (502 when the chain can't be read).
 */
async function precheckLoginLink(
  env: Env,
  scopeId: string,
  session: Parameters<typeof sessionNoncePreimage>[0],
  token: LoginToken,
  link: LoginToken,
  immediate: boolean,
): Promise<LinkRefusal | null> {
  const unavailable: LinkRefusal = { status: 502, code: 'near_unavailable', error: 'Could not read the sign-in methods on chain' };
  try {
    const config = await getConfig(env);
    if (!config.links_open) return { status: 409, code: 'links_unavailable', error: 'Links wait until the owner accepts the wallets opened before v3' };
    const [xi, ei, xa, ea] = await Promise.all([
      getIdentity(env, scopeId, token.provider, token.sub),
      getIdentity(env, scopeId, link.provider, link.sub),
      getAccount(env, scopeId, token.provider, token.sub),
      getAccount(env, scopeId, link.provider, link.sub),
    ]);
    const x = { provider: token.provider, sub: token.sub, identity: xi, account: xa };
    const e = { provider: link.provider, sub: link.sub, identity: ei, account: ea };
    if (!(await checkKey(scopeId, x)) || !(await checkKey(scopeId, e))) return unavailable;
    return await precheckAutoLink({ signer: env.SIGNER_ACCOUNT, scopeId, sessionHash: await sha256(sessionNoncePreimage(session)), session: x, link: e, linkNonce: link.nonce, immediate });
  } catch {
    return unavailable;
  }
}
