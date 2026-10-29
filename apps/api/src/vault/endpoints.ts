// Vault endpoints (docs/batch-b-spec.md "Share creation", "Unlock", "Logout and lost device", "Vault endpoints").
// Called only by the vault page (`Origin: VAULT_ORIGIN`) on behalf of the parent it serves (`x-hana-parent-origin`).
// A share is the server half of a persisted login: the vault stores PRK encrypted under K_s, and the API hands K_s
// back only for a signed, in-order, unexpired and unrevoked request. No endpoint here makes a chain transaction, and
// only share creation reads the chain.
import { type App, PUBLISHABLE_KEY_RE, getAppByKey } from '../apps.ts';
import { hex, sha256 } from '../bytes.ts';
import type { Env } from '../env.ts';
import { type Ctx, done, ipKey, lap, limiter, newCtx, reject } from '../handlers.ts';
import { type Headers_, corsHeaders, readJson } from '../http.ts';
import { log } from '../log.ts';
import { Rpc } from '../near/rpc.ts';
import { type SessionView, isSessionView } from '../views.ts';
import { type Keks, SHARE_KEY_BYTES, kekFor, loadKeks, unwrapShareKey, wrapShareKey } from './kek.ts';
import { NO_SHARE_ID, SHARE_ID_BYTES, type ShareAction, actionPayload, createSharePayload, verifyVaultSignature } from './message.ts';
import { parentOriginAllowed } from './origins.ts';
import { effectiveSettings, getSettingsRow } from './settings.ts';
import { type ShareRow, type ShareUpdate, advanceShare, capExpiry, getShare, incrementUnlocks, insertShare, markRevoked, revokeAllFrom } from './shares.ts';

export const VAULT_ENDPOINTS = ['/v1/vault/shares', '/v1/vault/unlock', '/v1/vault/touch', '/v1/vault/revoke', '/v1/vault/revoke-all'] as const;
export type VaultEndpoint = (typeof VAULT_ENDPOINTS)[number];
export const isVaultEndpoint = (path: string): path is VaultEndpoint => (VAULT_ENDPOINTS as readonly string[]).includes(path);

const ACTIONS: Record<Exclude<VaultEndpoint, '/v1/vault/shares'>, ShareAction> = {
  '/v1/vault/unlock': 'unlock',
  '/v1/vault/touch': 'touch',
  '/v1/vault/revoke': 'revoke',
  '/v1/vault/revoke-all': 'revoke-all',
};

const VAULT_ALLOW_HEADERS = 'content-type, x-hana-key, x-hana-parent-origin';
const VAULT_METHODS = 'POST, OPTIONS';
const MINUTE = 60_000;
/** Vault bodies are a few byte arrays. */
const MAX_VAULT_BODY = 4096;

/**
 * The `'vault'` gate's windows (starting values). They never touch the relay counters (`<appId>:minute` per IP,
 * `minute`/`day` per app), so page reloads never use up the login quota.
 */
export const VAULT_PER_IP_MINUTE = 60;
export const VAULT_APP_MINUTE_FACTOR = 10;
export const SHARE_PER_MINUTE = 10;
/** Share creation re-reads a lagging session (POST /v1/login answers at EXECUTED_OPTIMISTIC) this often, for this long. */
export const SESSION_RETRY_INTERVAL_MS = 300;
export const SESSION_RETRY_FOR_MS = 2000;
/** revoke-all needs a share this young: it proves a fresh Google login (R12). */
export const REVOKE_ALL_FRESH_MS = 5 * 60_000;

// ---- Preflight ----

/** Only the vault origin calls these endpoints, so preflight needs no app lookup. */
export function vaultPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (origin && env.VAULT_ORIGIN && origin === env.VAULT_ORIGIN) return new Response(null, { status: 204, headers: corsHeaders(origin, VAULT_ALLOW_HEADERS, VAULT_METHODS) });
  return new Response(null, { status: 403, headers: { vary: 'Origin' } });
}

// ---- Gate ----

type Gate = { ok: true; app: App; parentOrigin: string } | { ok: false; response: Response };

/**
 * The `'vault'` kind of the app gate: the app exists and is active, the caller is the vault origin, the parent it
 * serves is allowed for the app (dev-env loopback rule included), then the vault's own rate-limit windows.
 */
async function vaultGate(request: Request, env: Env, ctx: Ctx): Promise<Gate> {
  const fail = (status: number, code: string, error: string, extra: Headers_ = {}): Gate => ({ ok: false, response: reject(ctx, status, code, error, extra) });
  const origin = request.headers.get('origin');
  const fromVault = !!env.VAULT_ORIGIN && origin === env.VAULT_ORIGIN;
  // The vault can read every answer, including the ones before the app lookup.
  if (fromVault) ctx.cors = corsHeaders(origin, VAULT_ALLOW_HEADERS, VAULT_METHODS);

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
  if (app.status !== 'active') return fail(403, 'app_suspended', 'This app is suspended');
  if (!fromVault) return fail(403, 'origin_not_allowed', 'Origin not allowed for this endpoint');
  const parentOrigin = request.headers.get('x-hana-parent-origin');
  if (!parentOrigin || !parentOriginAllowed(env.ENV_NAME, app, parentOrigin)) return fail(403, 'origin_not_allowed', 'Parent origin not allowed for this app');
  if (app.scope_conflict) return fail(403, 'scope_conflict', 'This test app shares its scope with a live app');

  try {
    const ipHit = await limiter(env, ipKey(request)).hit([{ name: `${app.id}:vault:minute`, windowMs: MINUTE, max: VAULT_PER_IP_MINUTE }]);
    if (!ipHit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (per IP per minute)', { 'retry-after': String(ipHit.retryAfterS) });
    const appHit = await limiter(env, `app:${app.id}`).hit([{ name: 'vault:minute', windowMs: MINUTE, max: VAULT_APP_MINUTE_FACTOR * app.per_minute }]);
    if (!appHit.ok) return fail(429, 'rate_limited', 'Rate limit exceeded (app per minute)', { 'retry-after': String(appHit.retryAfterS) });
  } catch {
    return fail(503, 'rate_limiter_unavailable', 'Try again');
  }
  lap(ctx, 'limits');
  return { ok: true, app, parentOrigin };
}

// ---- Bodies ----

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const exactKeys = (o: Obj, keys: string[]): boolean => Object.keys(o).length === keys.length && keys.every((k) => k in o);
const toBytes = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;

function toCreateShare(body: unknown): { sessionPk: Uint8Array; signature: Uint8Array } | null {
  if (!isObj(body) || !exactKeys(body, ['sessionPublicKey', 'signature'])) return null;
  const sessionPk = toBytes(body.sessionPublicKey, 32);
  const signature = toBytes(body.signature, 64);
  return sessionPk && signature ? { sessionPk, signature } : null;
}

function toShareRequest(body: unknown): { shareId: Uint8Array; counter: number; signature: Uint8Array } | null {
  if (!isObj(body) || !exactKeys(body, ['shareId', 'counter', 'signature'])) return null;
  const shareId = toBytes(body.shareId, SHARE_ID_BYTES);
  const signature = toBytes(body.signature, 64);
  const { counter } = body;
  if (!shareId || !signature || !Number.isSafeInteger(counter) || (counter as number) < 1) return null;
  return { shareId, counter: counter as number, signature };
}

const arr = (b: Uint8Array): number[] => [...b];

// ---- Handlers ----

export async function handleVaultEndpoint(request: Request, env: Env, endpoint: VaultEndpoint, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const gate = await vaultGate(request, env, ctx);
  if (!gate.ok) return gate.response;
  const parsed = await readJson(request, MAX_VAULT_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  if (endpoint === '/v1/vault/shares') return createShare(env, ctx, gate.app, gate.parentOrigin, parsed.body);
  return shareAction(env, ctx, gate.app, ACTIONS[endpoint], parsed.body, exec);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type SpentSession = { ok: true; session: SessionView } | { ok: false; status: number; code: string; error: string };

/**
 * The session for `sessionPk`, read fresh from chain (never the cache), if it is live, in `scopeId` and used up
 * (`used === max_uses`): then the share is the only way back to the key. A missing or not-yet-spent session is
 * re-read for a while, since the node that answers may be a block behind the login that created it.
 */
async function spentSession(env: Env, sessionPk: Uint8Array, scopeId: string): Promise<SpentSession> {
  const deadline = Date.now() + SESSION_RETRY_FOR_MS;
  let last: 'missing' | 'not_spent' | 'error' = 'missing';
  for (;;) {
    let session: SessionView | null = null;
    try {
      // Straight from the node, bypassing the session cache and the use counts this isolate merges into it.
      const view = await new Rpc(env.NEAR_RPC).view<unknown>(env.SIGNER_ACCOUNT, 'get_session', { session_public_key: [...sessionPk] });
      session = isSessionView(view) ? view : null;
      last = session ? 'not_spent' : 'missing';
    } catch {
      last = 'error';
    }
    if (session) {
      if (session.scope_id !== scopeId) return { ok: false, status: 403, code: 'scope_mismatch', error: 'The session is for another scope' };
      // get_session still returns an expired session until it is pruned; it can't come back to life.
      if (session.expires_at_ms <= Date.now()) return { ok: false, status: 404, code: 'unknown_session', error: 'No live session for this key' };
      if (session.used === session.max_uses) return { ok: true, session };
    }
    if (Date.now() + SESSION_RETRY_INTERVAL_MS > deadline) break;
    await sleep(SESSION_RETRY_INTERVAL_MS);
  }
  if (last === 'error') return { ok: false, status: 502, code: 'near_unavailable', error: 'Could not read the session' };
  if (last === 'missing') return { ok: false, status: 404, code: 'unknown_session', error: 'No live session for this key' };
  return { ok: false, status: 409, code: 'session_not_spent', error: 'The session can still derive: a share needs a used-up session' };
}

/** POST /v1/vault/shares: after a login in 'session' mode, store a new share for its (used-up) session key. */
async function createShare(env: Env, ctx: Ctx, app: App, parentOrigin: string, body: unknown): Promise<Response> {
  const req = toCreateShare(body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Body must be {sessionPublicKey: 32 bytes, signature: 64 bytes}');
  const keks = await loadKeks(env);
  if (!keks) return vaultKeyUnavailable(ctx);

  // 1. (after the gate) The app keeps logins across reloads.
  let settings;
  try {
    const row = await getSettingsRow(env.DB, app.id);
    if (!row) return reject(ctx, 401, 'unknown_app', 'Unknown publishable key');
    settings = await effectiveSettings(row, app.id, Date.now());
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again');
  }
  if (settings.persistence !== 'session') return reject(ctx, 409, 'persistence_off', 'This app does not keep logins across reloads');

  // 2. The session key signed the create-share message for this app and this parent.
  const signed = await verifyVaultSignature(req.sessionPk, req.signature, {
    signer: env.SIGNER_ACCOUNT,
    appId: app.id,
    shareId: NO_SHARE_ID,
    counter: 0,
    payload: createSharePayload(parentOrigin),
  });
  if (!signed) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');

  // 3. The session is live, in the app's scope and used up. (4, the parent origin, was checked by the gate.)
  const spent = await spentSession(env, req.sessionPk, app.scope_id);
  lap(ctx, 'session');
  if (!spent.ok) return reject(ctx, spent.status, spent.code, spent.error);
  const { session } = spent;

  // 5. One share per session key (the insert is the check, so two concurrent requests can't both create one).
  const now = Date.now();
  const shareId = crypto.getRandomValues(new Uint8Array(SHARE_ID_BYTES));
  const ks = crypto.getRandomValues(new Uint8Array(SHARE_KEY_BYTES));
  const absExpiresAt = Math.min(session.expires_at_ms, now + settings.sessionTtlMs);
  const idleUntil = Math.min(now + settings.idleTtlMs, absExpiresAt);
  try {
    const shareEnc = await wrapShareKey(keks.current, { shareId, appId: app.id, sessionPk: req.sessionPk }, ks);
    const created = await insertShare(env.DB, {
      shareId,
      appId: app.id,
      sessionPk: req.sessionPk,
      pathHash: await sha256(new TextEncoder().encode(session.path)),
      partnerOrigin: parentOrigin,
      shareEnc,
      kekId: keks.current.id,
      createdAt: now,
      idleUntil,
      absExpiresAt,
    });
    if (!created) return reject(ctx, 409, 'share_exists', 'This session key already has a share');
    return done(ctx, 201, { shareId: arr(shareId), ks: arr(ks), absExpiresAtMs: absExpiresAt, idleUntilMs: idleUntil });
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'Vault storage is unavailable, try again');
  } finally {
    ks.fill(0);
  }
}

function vaultKeyUnavailable(ctx: Ctx): Response {
  log({ event: 'vault_kek_unavailable', requestId: ctx.requestId, appId: ctx.appId, endpoint: ctx.endpoint }, 'error');
  return reject(ctx, 503, 'vault_key_unavailable', 'The vault is unavailable, try again later');
}

/**
 * unlock and touch keep a share alive, so they follow the app's settings as they are now, not as they were when the
 * share was made: an app that no longer keeps logins (`persistence = 'none'`) gets its share revoked, and the share
 * never outlives created_at + the current session TTL (a lowered TTL shortens it; the stored limit is lowered too).
 * Null when the share may go on. advanceShare applies the same rules in its statement, against a change made since.
 */
async function settingsRefusal(env: Env, ctx: Ctx, app: App, row: ShareRow, now: number): Promise<Response | null> {
  const settings = await getSettingsRow(env.DB, app.id);
  if (!settings) return reject(ctx, 401, 'unknown_app', 'Unknown publishable key');
  if (settings.persistence !== 'session') {
    await markRevoked(env.DB, app.id, row.share_id, now);
    return reject(ctx, 410, 'share_revoked', 'This share was revoked: the app no longer keeps logins across reloads');
  }
  const capAt = row.created_at + settings.session_ttl_ms;
  if (capAt < row.abs_expires_at) await capExpiry(env.DB, app.id, row.share_id, capAt);
  if (now >= capAt) return reject(ctx, 410, 'share_expired', 'This share has expired');
  return null;
}

/** Why an advance changed nothing: re-read the share (and, for unlock and touch, the settings) and name the first reason. */
async function refusal(env: Env, ctx: Ctx, app: App, shareId: Uint8Array, now: number, checkSettings = false): Promise<Response> {
  const row = await getShare(env.DB, app.id, shareId);
  if (!row) return reject(ctx, 404, 'unknown_share', 'Unknown share');
  if (row.revoked_at !== null) return reject(ctx, 410, 'share_revoked', 'This share was revoked');
  if (now >= row.abs_expires_at || now >= row.idle_until) return reject(ctx, 410, 'share_expired', 'This share has expired');
  const refused = checkSettings ? await settingsRefusal(env, ctx, app, row, now) : null;
  if (refused) return refused;
  return done(ctx, 409, { error: 'Wrong counter (replayed or out of order)', code: 'bad_counter', expected: row.counter + 1 });
}

/** POST /v1/vault/unlock, /touch, /revoke, /revoke-all: one signed, in-order use of a share. */
async function shareAction(env: Env, ctx: Ctx, app: App, action: ShareAction, body: unknown, exec?: ExecutionContext): Promise<Response> {
  const req = toShareRequest(body);
  if (!req) return reject(ctx, 400, 'bad_request', 'Body must be {shareId: 16 bytes, counter: integer ≥ 1, signature: 64 bytes}');

  try {
    const hit = await limiter(env, `share:${hex(req.shareId)}`).hit([{ name: 'minute', windowMs: MINUTE, max: SHARE_PER_MINUTE }]);
    if (!hit.ok) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (share per minute)', { 'retry-after': String(hit.retryAfterS) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const keks = action === 'unlock' ? await loadKeks(env) : null;
  if (action === 'unlock' && !keks) return vaultKeyUnavailable(ctx);

  try {
    // Another app's share (same scope or not) is unknown here.
    const row = await getShare(env.DB, app.id, req.shareId);
    if (!row) return reject(ctx, 404, 'unknown_share', 'Unknown share');
    const now = Date.now();
    // Removing an origin from the app kills the shares made for it, for good.
    if (!parentOriginAllowed(env.ENV_NAME, app, row.partner_origin)) {
      await markRevoked(env.DB, app.id, req.shareId, now);
      return reject(ctx, 410, 'share_revoked', 'This share was revoked');
    }
    const keepsAlive = action === 'unlock' || action === 'touch';
    if (keepsAlive) {
      const refused = await settingsRefusal(env, ctx, app, row, now);
      if (refused) return refused;
    }
    const signed = await verifyVaultSignature(row.session_pk, req.signature, {
      signer: env.SIGNER_ACCOUNT,
      appId: app.id,
      shareId: req.shareId,
      counter: req.counter,
      payload: actionPayload(action),
    });
    if (!signed) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');

    if (action === 'unlock') return await unlock(env, ctx, app, row, req.counter, now, keks!, exec);
    if (action === 'revoke-all') {
      if (now - row.created_at >= REVOKE_ALL_FRESH_MS) {
        return reject(ctx, 403, 'share_not_fresh', 'Revoking other devices needs a share from a login in the last 5 minutes');
      }
      const result = await revokeAllFrom(env.DB, app.id, req.shareId, row.path_hash, req.counter, now);
      if (!result) return await refusal(env, ctx, app, req.shareId, now);
      return done(ctx, 200, { revoked: result.revoked });
    }
    const update: ShareUpdate = action === 'touch' ? { kind: 'slide' } : { kind: 'revoke' };
    const advanced = await advanceShare(env.DB, app.id, req.shareId, req.counter, now, update);
    if (!advanced) return await refusal(env, ctx, app, req.shareId, now, keepsAlive);
    if (action === 'touch') return done(ctx, 200, { counter: advanced.counter, idleUntilMs: advanced.idleUntil });
    return done(ctx, 200, { revoked: true });
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'Vault storage is unavailable, try again');
  }
}

/**
 * Unwraps K_s before the counter moves (a share this API can't read never burns a counter), re-wrapping it under the
 * current KEK in the same statement when the row is still under the previous one. Counts one unlock.
 */
async function unlock(env: Env, ctx: Ctx, app: App, row: ShareRow, counter: number, now: number, keks: Keks, exec?: ExecutionContext): Promise<Response> {
  const kek = kekFor(keks, row.kek_id);
  if (!kek) return vaultKeyUnavailable(ctx);
  const binding = { shareId: row.share_id, appId: app.id, sessionPk: row.session_pk };
  const ks = await unwrapShareKey(kek, binding, row.share_enc);
  if (!ks) {
    log({ event: 'vault_share_unreadable', requestId: ctx.requestId, appId: app.id, endpoint: ctx.endpoint }, 'error');
    return reject(ctx, 500, 'internal', 'Internal error');
  }
  try {
    const rewrap = kek === keks.current ? undefined : { shareEnc: await wrapShareKey(keks.current, binding, ks), kekId: keks.current.id };
    const advanced = await advanceShare(env.DB, app.id, row.share_id, counter, now, { kind: 'slide', rewrap });
    if (!advanced) return await refusal(env, ctx, app, row.share_id, now, true);
    const write = incrementUnlocks(env.DB, app.id, now).catch(() => {
      log({ event: 'usage_increment_failed', requestId: ctx.requestId, appId: app.id, endpoint: ctx.endpoint }, 'error');
    });
    if (exec) exec.waitUntil(write);
    else await write;
    return done(ctx, 200, { ks: arr(ks), counter: advanced.counter, idleUntilMs: advanced.idleUntil, absExpiresAtMs: advanced.absExpiresAt });
  } finally {
    ks.fill(0);
  }
}
