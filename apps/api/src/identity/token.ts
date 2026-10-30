// POST /v1/identity/token (docs/identity-token-spec.md "Minting: the session proof", "API endpoints"): the vault proves
// its live session with the session key and gets an ES256 identity token for its app. Called only from the vault origin
// (the vault gate). No step writes a share, moves a counter or slides `idle_until`: a mint is never activity (D55, D112),
// so a background tab refreshing tokens can't keep a session alive.
//
// Steps 1–4 of the spec's build order: no `email` claim yet (`emailStatus` is always 'off'; a `sealedEmail` in the body
// is covered by the session proof but not opened).
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
  identityTokenHeader,
  identityTokenPayload,
  verifyWalletProof,
  walletProofsHash,
} from '@hana-id/core/identity';
import { type App, usageDay } from '../apps.ts';
import { base64UrlEncode, hex, sha256 } from '../bytes.ts';
import type { Env } from '../env.ts';
import { PAUSED_RETRY_S, type Ctx, done, lap, limiter, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { log } from '../log.ts';
import { SESSION_RETRY_FOR_MS, SESSION_RETRY_INTERVAL_MS, vaultApp, vaultLimits } from '../vault/endpoints.ts';
import { parentOriginAllowed } from '../vault/origins.ts';
import { getSettingsRow } from '../vault/settings.ts';
import { getShareBySessionPk } from '../vault/shares.ts';
import { type SessionView, getConfig, getSession } from '../views.ts';
import { IDENTITY_GLOBAL_LIMITER, IDENTITY_GLOBAL_PER_HOUR, IDENTITY_LIMIT_PERIOD_S, identityProofLimiter, identitySessionKey } from './limits.ts';
import { type IdentityConfig, IdentitySignerError, identityConfig, workerSecretSigner } from './signer.ts';

export const IDENTITY_TOKEN_ENDPOINT = '/v1/identity/token';
/** The body is a few byte arrays and two addresses. */
export const MAX_IDENTITY_BODY = 4096;
const HOUR = 3_600_000;
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
async function verifyEd25519(publicKey: Uint8Array, signature: Uint8Array, message: Uint8Array): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey('raw', publicKey, { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify({ name: 'Ed25519' }, key, signature, message);
  } catch {
    return false;
  }
}

// ---- handler ----

type ShareCheck = { ok: true; share: { idleUntilMs: number; absCapMs: number } | null } | { ok: false; response: Response };

const sessionEnded = (ctx: Ctx, reason: string): Response => done(ctx, 410, { error: 'The Hana session has ended', code: 'session_ended', reason });

/**
 * The share in 'session' mode, judged as unlock judges it but read-only (docs/identity-token-spec.md "Minting" step 2):
 * not revoked, made for this parent (and its origin still allowed), the app still keeps logins, `now < idle_until` and
 * `now < min(abs_expires_at, created_at + current session_ttl_ms)`. A session key without a share passes only while the
 * app's persistence is 'none' (the session lives in the vault's memory alone, and the chain check decides).
 */
async function checkShare(env: Env, ctx: Ctx, app: App, parentOrigin: string, sessionPk: Uint8Array, now: number): Promise<ShareCheck> {
  let settings;
  let row;
  try {
    [settings, row] = await Promise.all([getSettingsRow(env.DB, app.id), getShareBySessionPk(env.DB, app.id, sessionPk)]);
  } catch {
    return { ok: false, response: reject(ctx, 503, 'config_unavailable', 'App config is unavailable, try again') };
  }
  if (!settings) return { ok: false, response: reject(ctx, 401, 'unknown_app', 'Unknown publishable key') };
  if (!row) return settings.persistence === 'session' ? { ok: false, response: sessionEnded(ctx, 'unknown_share') } : { ok: true, share: null };
  if (row.revoked_at !== null || !parentOriginAllowed(env.ENV_NAME, app, row.partner_origin)) return { ok: false, response: sessionEnded(ctx, 'share_revoked') };
  if (row.partner_origin !== parentOrigin) return { ok: false, response: sessionEnded(ctx, 'unknown_share') };
  if (settings.persistence !== 'session') return { ok: false, response: sessionEnded(ctx, 'persistence_off') };
  const absCapMs = Math.min(row.abs_expires_at, row.created_at + settings.session_ttl_ms);
  if (now >= row.idle_until || now >= absCapMs) return { ok: false, response: sessionEnded(ctx, 'share_expired') };
  return { ok: true, share: { idleUntilMs: row.idle_until, absCapMs } };
}

type ChainCheck = { ok: true; session: SessionView } | { ok: false; response: Response };

/**
 * The on-chain session (step 3): live (get_session answers null for a revoked session and for one before
 * `sessions_valid_from_ms`), in the app's scope, not expired. A cached answer that would refuse is re-read fresh, and
 * a missing one is re-read for a while (SESSION_RETRY_FOR_MS, as share creation does): the node that answers may be a
 * block behind the login that created the session, and a wrong "no session" would end the user's session in the vault.
 */
async function checkChainSession(env: Env, ctx: Ctx, app: App, sessionPk: Uint8Array, now: number): Promise<ChainCheck> {
  const judge = (s: SessionView | null): 'ok' | 'missing' | 'expired' | 'scope_mismatch' =>
    !s ? 'missing' : s.expires_at_ms <= now ? 'expired' : s.scope_id !== app.scope_id ? 'scope_mismatch' : 'ok';
  let read;
  try {
    read = await getSession(env, [...sessionPk]);
    if (read.cached && judge(read.session) !== 'ok') read = await getSession(env, [...sessionPk], { fresh: true });
    const deadline = Date.now() + SESSION_RETRY_FOR_MS;
    while (judge(read.session) === 'missing' && Date.now() + SESSION_RETRY_INTERVAL_MS <= deadline) {
      await new Promise((resolve) => setTimeout(resolve, SESSION_RETRY_INTERVAL_MS));
      read = await getSession(env, [...sessionPk], { fresh: true });
    }
  } catch {
    return { ok: false, response: reject(ctx, 502, 'near_unavailable', 'Could not read the session') };
  }
  const verdict = judge(read.session);
  if (verdict === 'missing' || verdict === 'expired') return { ok: false, response: sessionEnded(ctx, 'no_session') };
  if (verdict === 'scope_mismatch') return { ok: false, response: reject(ctx, 403, 'scope_mismatch', 'The session is for another scope') };
  return { ok: true, session: read.session! };
}

/** Counts one token per signing key and hour, and per app and day (after the response when it can). Never rejects. */
async function countIssuance(env: Env, ctx: Ctx, appId: string, kid: string, now: number, exec?: ExecutionContext): Promise<void> {
  const hour = Math.floor(now / HOUR) * HOUR;
  const write = env.DB.batch([
    env.DB.prepare('INSERT INTO identity_issuance_hourly (hour, kid, count) VALUES (?1, ?2, 1) ON CONFLICT (hour, kid) DO UPDATE SET count = count + 1').bind(hour, kid),
    env.DB.prepare('INSERT INTO identity_usage (app_id, day, tokens) VALUES (?1, ?2, 1) ON CONFLICT (app_id, day) DO UPDATE SET tokens = tokens + 1').bind(appId, usageDay(now)),
  ])
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

const bad = (ctx: Ctx): Response =>
  reject(ctx, 400, 'bad_request', 'Body must be {sessionPublicKey: 32 bytes, issuedAtMs, nonce: 16 bytes, signature: 64 bytes, walletProofs: {stellar, evm}[, sealedEmail]}');

export async function handleIdentityToken(request: Request, env: Env, requestId: string, exec?: ExecutionContext): Promise<Response> {
  const ctx = newCtx(env, requestId, IDENTITY_TOKEN_ENDPOINT, request);
  // The vault gate: key, app active, Origin = VAULT_ORIGIN, parent allowed, scope_conflict; then its IP and app limits.
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app, parentOrigin } = gate;
  const limited = await vaultLimits(request, env, ctx, app);
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

  // Per session key: a flood limit (binding, per location), then the proof's single-use marker.
  const pkHex = hex(req.sessionPk);
  try {
    const hit = await env.IDENTITY_SESSION_LIMIT.limit({ key: identitySessionKey(env.ENV_NAME, app.id, pkHex) });
    if (!hit.success) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (session per minute)', { 'retry-after': String(IDENTITY_LIMIT_PERIOD_S) });
    const marker = hex(await sha256(req.signature));
    if (!(await limiter(env, identityProofLimiter(pkHex)).reserve(marker, req.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return reject(ctx, 409, 'proof_replayed', 'This session proof was already used');
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  lap(ctx, 'limits');

  // Not paused (a forged-key incident stops identity tokens with logins). Fails closed: the pause is a security stop.
  try {
    if ((await getConfig(env)).paused) return done(ctx, 503, { error: 'Hana ID is paused, try again later', code: 'paused', retryAfterS: PAUSED_RETRY_S }, { 'retry-after': String(PAUSED_RETRY_S) });
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
  if (!lifetime) return reject(ctx, 410, 'session_ending', 'The Hana session ends in less than 30 seconds');

  // Each address proven by its own key for this session and app.
  const proofCtx = { signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: req.sessionPk };
  const wallets: Partial<Record<IdentityChain, string>> = {};
  for (const c of ['stellar', 'evm'] as const) {
    const address = verifyWalletProof(proofCtx, c, req.proofs[c]);
    if (address === null) return done(ctx, 400, { error: 'A wallet proof does not verify', code: 'bad_wallet_proof', chain: c });
    wallets[c] = address;
  }
  lap(ctx, 'wallets');

  // The global hourly ceiling: a breaker against a mint flood (on mainnet, paid KMS signatures).
  try {
    const hit = await limiter(env, IDENTITY_GLOBAL_LIMITER).hit([{ name: 'hour', windowMs: HOUR, max: globalCeiling(env) }], now);
    if (!hit.ok) {
      log({ event: 'identity_ceiling', requestId, appId: app.id, code: 'identity_busy' }, 'error');
      return reject(ctx, 503, 'identity_busy', 'Identity tokens are paused for a while, try again later', { 'retry-after': String(hit.retryAfterS) });
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }

  return sign(env, ctx, config, app, { ...lifetime, root, sessionPk: req.sessionPk, wallets: wallets as Record<IdentityChain, string> }, exec);
}

async function sign(
  env: Env,
  ctx: Ctx,
  config: IdentityConfig,
  app: App,
  t: { iat: number; exp: number; root: { provider: string; sub: string }; sessionPk: Uint8Array; wallets: Record<IdentityChain, string> },
  exec?: ExecutionContext,
): Promise<Response> {
  let token: string;
  let kid: string;
  try {
    const signer = await workerSecretSigner(env, config);
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
    });
    const input = identitySigningInput(identityTokenHeader(kid), claims);
    token = `${input.text}.${base64UrlEncode(await signer.sign(input.bytes))}`;
  } catch (e) {
    log({ event: 'identity_sign_failed', requestId: ctx.requestId, appId: app.id, code: e instanceof IdentitySignerError ? e.reason : 'internal' }, 'error');
    return reject(ctx, 503, 'identity_signer_unavailable', 'Identity tokens are unavailable, try again later');
  }
  lap(ctx, 'sign');
  await countIssuance(env, ctx, app.id, kid, Date.now(), exec);
  return done(ctx, 200, { identityToken: token, expiresAtMs: t.exp * 1000, emailStatus: 'off' });
}
