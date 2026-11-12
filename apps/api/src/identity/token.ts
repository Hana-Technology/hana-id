// POST /v1/identity/token (docs/identity-token-spec.md "Minting: the session proof", "API endpoints"): the vault proves
// its live session with the session key and gets an ES256 identity token for its app. Called only from the vault origin
// (the vault gate). No step writes a share, moves a counter or slides `idle_until`: a mint is never activity (D55, D112),
// so a background tab refreshing tokens can't keep a session alive.
//
// The `email` claim (D411, D441; identity/email.ts mintEmail): the address the user shared with this app, when the app's
// `identity_email` isn't 'off' (`emailStatus` says why a token has none). A `sealedEmail` in the body is covered by the
// session proof and opened only for that.
//
// `given_name` and `family_name` (D714; identity/name.ts mintName): the name the user set in Hana Home, only for an app
// they shared it with there.
//
// SECURITY: the response carries a bearer credential for the partner's backend. Nothing here logs the token, `sub`,
// `sid`, an address or the body; the request log has the app id, outcome, code, kid and timings.
import {
  IDENTITY_PROOF_MARKER_MS,
  IDENTITY_PROOF_WINDOW_MS,
  IDENTITY_JTI_BYTES,
  type IdentityChain,
  type WalletProofs,
  buildIdentityClaims,
  identityLifetime,
  identityMessage,
  identityRoot,
  identitySid,
  identitySigningInput,
  identitySub,
  identitySubBytes,
  identityTokenHeader,
  identityTokenPayload,
  verifyWalletProof,
  walletProofsHash,
} from '@hana-id/core/identity';
import { type App, usageDay } from '../apps.ts';
import { base64UrlEncode, concatBytes, hex, sha256, u64le } from '../bytes.ts';
import type { Env } from '../env.ts';
import { PAUSED_RETRY_S, type Ctx, done, lap, limiter, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { log } from '../log.ts';
import type { Limit } from '../rate-limiter.ts';
import { SESSION_RETRY_FOR_MS, SESSION_RETRY_INTERVAL_MS, vaultApp, vaultIpLimit } from '../vault/endpoints.ts';
import { parentOriginAllowed } from '../vault/origins.ts';
import { getSettingsRow } from '../vault/settings.ts';
import { getShareBySessionPk } from '../vault/shares.ts';
import { type SessionView, getConfig, getSession } from '../views.ts';
import {
  HOUR_MS,
  IDENTITY_APP_MINUTE_FACTOR,
  IDENTITY_GLOBAL_ALERT_PER_HOUR,
  IDENTITY_GLOBAL_LIMITER,
  IDENTITY_GLOBAL_PER_HOUR,
  IDENTITY_LIMIT_PERIOD_S,
  IDENTITY_SCOPE_HOUR_FACTOR,
  MINUTE_MS,
  identityAppHourMax,
  identityProofLimiter,
  identityRootKey,
  identityScopeLimiter,
  identitySessionKey,
} from './limits.ts';
import { type IdentityConfig, IdentitySignerError, identityConfig } from './signer.ts';
import { type MintEmail, mintEmail } from './email.ts';
import { type ProfileName, mintName } from './name.ts';
import { identitySigner } from './signers.ts';

export const IDENTITY_TOKEN_ENDPOINT = '/v1/identity/token';
/** The body is a few byte arrays and two addresses. */
export const MAX_IDENTITY_BODY = 4096;
const HOUR = HOUR_MS;
const MAX_SEALED_EMAIL = 1024;

// ---- body ----

interface MintRequest {
  sessionPk: Uint8Array;
  issuedAtMs: number;
  nonce: Uint8Array;
  signature: Uint8Array;
  proofs: WalletProofs;
  sealedEmail: string | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (o: Obj, required: string[], optional: string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const toBytes = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;

function toProof(v: unknown, sigBytes: number): { address: string; signature: Uint8Array } | null {
  if (!isObj(v) || !keysAre(v, ['address', 'signature'])) return null;
  const signature = toBytes(v.signature, sigBytes);
  return typeof v.address === 'string' && v.address.length > 0 && v.address.length <= 64 && signature ? { address: v.address, signature } : null;
}

/** Exactly the spec's fields (`sealedEmail` optional), each well formed; null otherwise. */
export function toMintRequest(body: unknown): MintRequest | null {
  if (!isObj(body) || !keysAre(body, ['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature', 'walletProofs'], ['sealedEmail'])) return null;
  const sessionPk = toBytes(body.sessionPublicKey, 32);
  const nonce = toBytes(body.nonce, 16);
  const signature = toBytes(body.signature, 64);
  const { issuedAtMs, walletProofs, sealedEmail } = body;
  if (!sessionPk || !nonce || !signature || !Number.isSafeInteger(issuedAtMs) || (issuedAtMs as number) < 0) return null;
  if (!isObj(walletProofs) || !keysAre(walletProofs, ['stellar', 'evm'])) return null;
  const stellar = toProof(walletProofs.stellar, 64);
  const evm = toProof(walletProofs.evm, 65);
  if (!stellar || !evm) return null;
  if (sealedEmail !== undefined && (typeof sealedEmail !== 'string' || sealedEmail.length === 0 || sealedEmail.length > MAX_SEALED_EMAIL)) return null;
  return { sessionPk, issuedAtMs: issuedAtMs as number, nonce, signature, proofs: { stellar, evm }, sealedEmail: (sealedEmail as string | undefined) ?? null };
}

/** Ed25519 (WebCrypto) check of the session proof; false for any malformed key or signature. */
export async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}

// ---- handler ----

type ShareCheck = { ok: true; share: { shareId: Uint8Array; pathHash: Uint8Array; idleUntilMs: number; absCapMs: number } | null } | { ok: false; response: Response };

const sessionEnded = (ctx: Ctx, reason: string): Response => done(ctx, 410, { error: 'The Journear Passport session has ended', code: 'session_ended', reason });

/**
 * The share in 'session' mode, judged as unlock judges it but read-only (docs/identity-token-spec.md "Minting" step 2):
 * not revoked, made for this parent (and its origin still allowed), the app still keeps logins, `now < idle_until` and
 * `now < min(abs_expires_at, created_at + current session_ttl_ms)`. A session key whose share is another app's is
 * refused whatever this app's persistence (D178: a session revoked in one app of a scope must not go on minting in a
 * 'none' app of the same scope; the cron keeps dead shares as tombstones for the session's longest life). A session
 * key with no share anywhere passes only while the app's persistence is 'none' (the session lives in the vault's memory
 * alone, and the chain check decides).
 */
export async function checkShare(env: Env, ctx: Ctx, app: App, parentOrigin: string, sessionPk: Uint8Array, now: number): Promise<ShareCheck> {
  let settings;
  let row;
  try {
    [settings, row] = await Promise.all([getSettingsRow(env.DB, app.id), getShareBySessionPk(env.DB, sessionPk)]);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again') };
  }
  if (!settings) return { ok: false, response: reject(ctx, 401, 'unknown_app', 'Unknown publishable key') };
  if (!row) return settings.persistence === 'session' ? { ok: false, response: sessionEnded(ctx, 'unknown_share') } : { ok: true, share: null };
  if (row.app_id !== app.id) return { ok: false, response: sessionEnded(ctx, 'unknown_share') };
  if (row.revoked_at !== null || !parentOriginAllowed(env.ENV_NAME, app, row.partner_origin)) return { ok: false, response: sessionEnded(ctx, 'share_revoked') };
  if (row.partner_origin !== parentOrigin) return { ok: false, response: sessionEnded(ctx, 'unknown_share') };
  if (settings.persistence !== 'session') return { ok: false, response: sessionEnded(ctx, 'persistence_off') };
  const absCapMs = Math.min(row.abs_expires_at, row.created_at + settings.session_ttl_ms);
  if (now >= row.idle_until || now >= absCapMs) return { ok: false, response: sessionEnded(ctx, 'share_expired') };
  return { ok: true, share: { shareId: row.share_id, pathHash: row.path_hash, idleUntilMs: row.idle_until, absCapMs } };
}

export type ChainCheck = { ok: true; session: SessionView } | { ok: false; response: Response };

/**
 * The on-chain session (step 3): live (get_session answers null for a revoked session and for one before
 * `sessions_valid_from_ms`), in the app's scope, not expired. A cached answer that would refuse is re-read fresh, and
 * a missing one is re-read for a while (SESSION_RETRY_FOR_MS, as share creation does): the node that answers may be a
 * block behind the login that created the session, and a wrong "no session" would end the user's session in the vault.
 *
 * `singleRead`: at most one chain read and no re-reads, for a route any throwaway key can reach (D513). A missing session
 * then answers 503 `session_not_visible` with `retry-after`, so a lagging node ends nothing and the vault tries again.
 */
export async function checkChainSession(env: Env, ctx: Ctx, app: App, sessionPk: Uint8Array, now: number, opts: { singleRead?: boolean } = {}): Promise<ChainCheck> {
  const judge = (s: SessionView | null): 'ok' | 'missing' | 'expired' | 'scope_mismatch' =>
    !s ? 'missing' : s.expires_at_ms <= now ? 'expired' : s.scope_id !== app.scope_id ? 'scope_mismatch' : 'ok';
  let read;
  try {
    read = await getSession(env, [...sessionPk]);
    if (read.cached && judge(read.session) !== 'ok') read = await getSession(env, [...sessionPk], { fresh: true });
    const deadline = Date.now() + SESSION_RETRY_FOR_MS;
    while (!opts.singleRead && judge(read.session) === 'missing' && Date.now() + SESSION_RETRY_INTERVAL_MS <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_INTERVAL_MS));
      read = await getSession(env, [...sessionPk], { fresh: true });
    }
  } catch {
    return { ok: false, response: reject(ctx, 502, 'near_unavailable', 'Could not read the session') };
  }
  const verdict = judge(read.session);
  if (verdict === 'missing' && opts.singleRead) return { ok: false, response: reject(ctx, 503, 'session_not_visible', 'The session is not visible on chain yet, try again', { 'retry-after': '1' }) };
  if (verdict === 'missing' || verdict === 'expired') return { ok: false, response: sessionEnded(ctx, 'no_session') };
  if (verdict === 'scope_mismatch') return { ok: false, response: reject(ctx, 403, 'scope_mismatch', 'The session is for another scope') };
  return { ok: true, session: read.session! };
}

/** Counts one token per signing key and hour, and per app and day (after the response when it can). Never rejects. */
async function countIssuance(env: Env, ctx: Ctx, appId: string, kid: string, now: number, exec?: ExecutionContext): Promise<void> {
  const hour = Math.floor(now / HOUR) * HOUR;
  // Wrapped so that even a synchronous failure is a logged count, never a failed mint.
  const write = Promise.resolve()
    .then(() =>
      env.DB.batch([
        env.DB.prepare('INSERT INTO identity_issuance_hourly (hour, kid, count) VALUES (?1, ?2, 1) ON CONFLICT (hour, kid) DO UPDATE SET count = count + 1').bind(hour, kid),
        env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1) ON CONFLICT (app_id, day) DO UPDATE SET tokens = tokens + 1').bind(appId, usageDay(now)),
      ]),
    )
    .then(() => undefined)
    .catch(() => {
      log({ event: 'identity_count_failed', requestId: ctx.requestId, appId, endpoint: ctx.endpoint }, 'error');
    });
  if (exec) exec.waitUntil(write);
  else await write;
}

/** IDENTITY_GLOBAL_PER_HOUR, or the env's IDENTITY_GLOBAL_HOURLY_MAX when it is a positive integer. */
export function globalCeiling(env: Pick<Env, 'IDENTITY_GLOBAL_HOURLY_MAX'>): number {
  const v = Number(env.IDENTITY_GLOBAL_HOURLY_MAX);
  return Number.isSafeInteger(v) && v > 0 ? v : IDENTITY_GLOBAL_PER_HOUR;
}

/** The single-use marker of a session proof: sha256(sessionPk ‖ u64le(issuedAtMs) ‖ nonce), whatever the signature's encoding (D176). */
export async function proofMarker(req: Pick<MintRequest, 'sessionPk' | 'issuedAtMs' | 'nonce'>): Promise<string> {
  return hex(await sha256(concatBytes(req.sessionPk, u64le(req.issuedAtMs), req.nonce)));
}

/** At most one critical "past the alert line" log per isolate per 10 minutes. */
let lastGlobalAlertAt = 0;

interface QuotaWindow {
  subject: string;
  label: string;
  limits: Limit[];
}

/**
 * The quota windows, asked in turn (identity/limits.ts, D176): per app (minute and hour, its own windows), per scope
 * (hour), then global (the hard breaker, and a soft alert line). Sliding windows, counted only for a request that passed
 * every other check; a refusal by a later window takes the hit back from the earlier ones. Null when all accept.
 */
async function identityQuota(env: Env, ctx: Ctx, app: App, now: number): Promise<Response | null> {
  const appHour = identityAppHourMax(app);
  const windows: QuotaWindow[] = [
    {
      subject: `app:${app.id}`,
      label: 'app',
      limits: [
        { name: 'identity:minute', windowMs: MINUTE_MS, max: IDENTITY_APP_MINUTE_FACTOR * app.per_minute },
        { name: 'identity:hour', windowMs: HOUR_MS, max: appHour },
      ],
    },
    { subject: identityScopeLimiter(app.scope_id), label: 'scope', limits: [{ name: 'identity:hour', windowMs: HOUR_MS, max: IDENTITY_SCOPE_HOUR_FACTOR * appHour }] },
    {
      subject: IDENTITY_GLOBAL_LIMITER,
      label: 'global',
      limits: [
        { name: 'hour', windowMs: HOUR_MS, max: globalCeiling(env) },
        { name: 'alert:hour', windowMs: HOUR_MS, max: IDENTITY_GLOBAL_ALERT_PER_HOUR, soft: true },
      ],
    },
  ];
  const accepted: QuotaWindow[] = [];
  try {
    for (const w of windows) {
      const hit = await limiter(env, w.subject).hitSliding(w.limits, now);
      if (!hit.ok) {
        for (const a of accepted) await limiter(env, a.subject).unhitSliding(a.limits, now).catch(() => undefined);
        if (w.label === 'global') {
          log({ event: 'identity_ceiling', requestId: ctx.requestId, appId: app.id, code: 'identity_busy' }, 'error');
          return reject(ctx, 503, 'identity_busy', 'Identity tokens are paused for a while, try again later', { 'retry-after': String(hit.retryAfterS) });
        }
        return reject(ctx, 429, 'rate_limited', `Rate limit exceeded (identity tokens per ${w.label} per ${hit.limit.endsWith('minute') ? 'minute' : 'hour'})`, {
          'retry-after': String(hit.retryAfterS),
        });
      }
      if (hit.soft && now - lastGlobalAlertAt >= 10 * MINUTE_MS) {
        lastGlobalAlertAt = now;
        log({ event: 'identity_volume_alert', requestId: ctx.requestId, appId: app.id, code: 'past_alert_line' }, 'error');
      }
      accepted.push(w);
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  return null;
}

const bad = (ctx: Ctx): Response =>
  reject(ctx, 400, 'bad_request', 'Body must be {sessionPublicKey: 32 bytes, issuedAtMs, nonce: 16 bytes, signature: 64 bytes, walletProofs: {stellar, evm}[, sealedEmail]}');

export async function handleIdentityToken(request: Request, env: Env, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, IDENTITY_TOKEN_ENDPOINT, request);
  // The vault gate: key, app active, Origin = VAULT_ORIGIN, parent allowed, scope_conflict; then its IP and app limits.
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app, parentOrigin } = gate;
  // Per IP only: the app's quota is counted in windows of its own, after verification (identityQuota, D176).
  const limited = await vaultIpLimit(request, env, ctx, app);
  if (limited) return limited;
  // An env without the identity configuration (or with a broken one) can't mint: say so before any work.
  const config = identityConfig(env);
  if (typeof config === 'string') {
    log({ event: 'identity_unavailable', requestId, appId: app.id, code: config }, 'error');
    return reject(ctx, 503, 'identity_unavailable', 'Identity tokens are unavailable in this environment');
  }

  // Body shape.
  const parsed = await readJson(request, MAX_IDENTITY_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const req = toMintRequest(parsed.body);
  if (!req) return bad(ctx);

  // Clock: ±60 s of the API's.
  const now = Date.now();
  if (Math.abs(now - req.issuedAtMs) > IDENTITY_PROOF_WINDOW_MS) return done(ctx, 400, { error: 'The session proof is too old or too new', code: 'stale_proof', serverTimeMs: now });

  // The session key signed this mint for this app, signer, parent, wallet proofs and sealed email.
  const payload = identityTokenPayload({ parentOrigin, walletProofsHash: walletProofsHash(req.proofs), sealedEmail: req.sealedEmail });
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: req.sessionPk, issuedAtMs: req.issuedAtMs, nonce: req.nonce, payload });
  if (!(await verifyEd25519(req.sessionPk, req.signature, message))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  lap(ctx, 'proof');

  // Per session key: a flood limit (binding, per location). Only the key's holder gets this far.
  const pkHex = hex(req.sessionPk);
  try {
    const hit = await env.IDENTITY_SESSION_LIMIT.limit({ key: identitySessionKey(env.ENV_NAME, app.id, pkHex) });
    if (!hit.success) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (session per minute)', { 'retry-after': String(IDENTITY_LIMIT_PERIOD_S) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  // Not paused (a forged-key incident stops identity tokens with logins). Fails closed: the pause is a security stop.
  try {
    if ((await getConfig(env)).paused) return done(ctx, 503, { error: 'Journear Passport is paused, try again later', code: 'paused', retryAfterS: PAUSED_RETRY_S }, { 'retry-after': String(PAUSED_RETRY_S) });
  } catch {
    return reject(ctx, 502, 'near_unavailable', 'Could not read the contract config');
  }

  // The share ('session' mode), without moving it; then the session on chain.
  const share = await checkShare(env, ctx, app, parentOrigin, req.sessionPk, now);
  if (!share.ok) return share.response;
  lap(ctx, 'share');
  const chain = await checkChainSession(env, ctx, app, req.sessionPk, now);
  if (!chain.ok) return chain.response;
  lap(ctx, 'session');
  const root = identityRoot(chain.session.path, app.scope_id);
  if (!root) {
    log({ event: 'identity_bad_session_path', requestId, appId: app.id }, 'error');
    return reject(ctx, 502, 'bad_contract_result', 'The session path is not one this API can read');
  }

  // Lifetime: ≤ 1 h, never past the session (and in 'session' mode its share's idle and absolute limits).
  const lifetime = identityLifetime({ nowMs: now, sessionExpiresAtMs: chain.session.expires_at_ms, ...(share.share ? { share: share.share } : {}) });
  if (!lifetime) return reject(ctx, 410, 'session_ending', 'The Journear Passport session ends in less than 30 seconds');

  // Each address proven by its own key for this session and app.
  const proofCtx = { signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: req.sessionPk };
  const wallets: Partial<Record<IdentityChain, string>> = {};
  for (const c of ['stellar', 'evm'] as const) {
    const address = verifyWalletProof(proofCtx, c, req.proofs[c]);
    if (address === null) return done(ctx, 400, { error: 'A wallet proof does not verify', code: 'bad_wallet_proof', chain: c });
    wallets[c] = address;
  }
  lap(ctx, 'wallets');

  // Single use, once the proof is known to be a live session's (D176): an atomic test-and-set on the session's own
  // object (swept by an alarm), so random keys never create markers. Then the account root's flood limit.
  try {
    if (!(await limiter(env, identityProofLimiter(pkHex)).reserve(await proofMarker(req), req.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return reject(ctx, 409, 'proof_replayed', 'This session proof was already used');
    }
    const subBytes = identitySubBytes(config.subKey, app.scope_id, root);
    const hit = await env.IDENTITY_ROOT_LIMIT.limit({ key: identityRootKey(env.ENV_NAME, app.scope_id, hex(subBytes)) });
    if (!hit.success) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (account per minute)', { 'retry-after': String(IDENTITY_LIMIT_PERIOD_S) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const quota = await identityQuota(env, ctx, app, now);
  if (quota) return quota;
  lap(ctx, 'limits');

  // The email (never an error: `emailStatus` says why a token has none).
  const userSub = identitySub(config.subKey, app.scope_id, root);
  const email = await mintEmail(env, ctx, { app, userSub, sessionPk: req.sessionPk, sealedEmail: req.sealedEmail, now });
  lap(ctx, 'email');
  // The name the user shared with this app from Hana Home (D714; never an error).
  const name = await mintName(env, ctx, { appId: app.id, userSub, now });
  lap(ctx, 'name');

  return sign(env, ctx, config, app, { ...lifetime, root, sessionPk: req.sessionPk, wallets: wallets as Record<IdentityChain, string>, email, name }, exec);
}

async function sign(
  env: Env,
  ctx: Ctx,
  config: IdentityConfig,
  app: App,
  t: { iat: number; exp: number; root: { provider: string; sub: string }; sessionPk: Uint8Array; wallets: Record<IdentityChain, string>; email: MintEmail; name: ProfileName | null },
  exec?: ExecutionContext,
): Promise<Response> {
  let token: string;
  let kid: string;
  try {
    const signer = await identitySigner(env, config);
    kid = signer.kid;
    ctx.kid = kid;
    const claims = buildIdentityClaims({
      iss: config.iss,
      aud: app.id,
      sub: identitySub(config.subKey, app.scope_id, t.root),
      sid: identitySid(config.subKey, app.id, t.sessionPk),
      iat: t.iat,
      exp: t.exp,
      jti: crypto.getRandomValues(new Uint8Array(IDENTITY_JTI_BYTES)),
      wallets: t.wallets,
      // Without account linking (email login, D119) an account has one method: its root's provider.
      loginMethods: [t.root.provider],
      email: t.email.email,
      givenName: t.name?.givenName ?? null,
      familyName: t.name?.familyName ?? null,
    });
    const input = identitySigningInput(identityTokenHeader(kid), claims);
    token = `${input.text}.${base64UrlEncode(await signer.sign(input.bytes))}`;
  } catch (e) {
    log({ event: 'identity_sign_failed', requestId: ctx.requestId, appId: app.id, code: e instanceof IdentitySignerError ? e.reason : 'internal' }, 'error');
    return reject(ctx, 503, 'identity_signer_unavailable', 'Identity tokens are unavailable, try again later');
  }
  lap(ctx, 'sign');
  await countIssuance(env, ctx, app.id, kid, Date.now(), exec);
  return done(ctx, 200, { identityToken: token, expiresAtMs: t.exp * 1000, emailStatus: t.email.status });
}
