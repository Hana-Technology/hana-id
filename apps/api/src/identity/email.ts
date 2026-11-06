// Email sharing with partners (D411, D418–D421; docs/email-sharing-spec.md, docs/api.md "Email sharing"): the app
// setting `identity_email`, the consent rows (migration 0012 `email_consents`), the endpoints the vault and the auth
// popup call, and the address a mint puts in the identity token.
//
//   POST /v1/identity/email-consent/state    vault   {setting, state} for the session's sealed address
//   POST /v1/identity/email-consent          vault   a decision (`granted` / `declined`) for that address
//   POST /v1/identity/email-consent/revoke   vault   every address of this app and account → declined, copies gone
//   POST /v1/identity/email-consent/preview  popup   {email}: the sealed address, for the sheet (Origin AUTH_ORIGIN)
//
// Each takes the identity token's session proof over its own payload (core emailConsentPayload: the action, the parent
// origin and the sealed address), single use, then the share ('session' mode) and the on-chain session exactly as a
// mint checks them; the account is the session's path's root, and its consent key the identity token's `sub`.
//
// The address arrives only sealed by the email issuer (@hana-id/email sealedEmail, IDENTITY_SEAL_KEY, D418), bound to
// this app and session. A consent row keys it by EMAIL_CONSENT_KEY's MAC (one row per app × account × address, D419);
// the address itself is kept only in a `granted` row (the copy the partner console reads, D411 point 4).
//
// SECURITY: an address is personal data. Nothing here logs an address, a sealed blob, a MAC, a `sub` or a body; the
// request log has the app id, the endpoint, the outcome and the code.
import { openSealedEmail, parseSealKey, type SealKey } from '@hana-id/email/sealed';
import {
  type EmailConsentAction,
  type EmailConsentState,
  IDENTITY_PROOF_MARKER_MS,
  IDENTITY_PROOF_WINDOW_MS,
  type IdentityEmailSetting,
  type IdentityEmailStatus,
  emailConsentPayload,
  identityMessage,
  identityRoot,
  identitySub,
  isIdentityEmailSetting,
} from '@hana-id/core/identity';
import { getAppByKeyCached } from '../app-cache.ts';
import { type App, PUBLISHABLE_KEY_RE, appSuspended } from '../apps.ts';
import { base64Decode, concatBytes, hex } from '../bytes.ts';
import type { Env } from '../env.ts';
import { PAUSED_RETRY_S, type Ctx, done, lap, limiter, newCtx, reject } from '../handlers.ts';
import { corsHeaders, readJson } from '../http.ts';
import { log } from '../log.ts';
import { vaultApp, vaultIpLimit } from '../vault/endpoints.ts';
import { parentOriginAllowed } from '../vault/origins.ts';
import { getConfig } from '../views.ts';
import { IDENTITY_LIMIT_PERIOD_S, identityProofLimiter } from './limits.ts';
import { identitySubKey } from './signer.ts';
import { checkChainSession, checkShare, proofMarker, verifyEd25519 } from './token.ts';

export const EMAIL_CONSENT_ENDPOINTS = {
  state: '/v1/identity/email-consent/state',
  decide: '/v1/identity/email-consent',
  revoke: '/v1/identity/email-consent/revoke',
  preview: '/v1/identity/email-consent/preview',
} as const;
export type EmailConsentEndpoint = (typeof EMAIL_CONSENT_ENDPOINTS)[keyof typeof EMAIL_CONSENT_ENDPOINTS];
export const isEmailConsentEndpoint = (p: string): p is EmailConsentEndpoint => (Object.values(EMAIL_CONSENT_ENDPOINTS) as string[]).includes(p);

/** The MAC's domain label (D419). */
export const EMAIL_CONSENT_MAC_LABEL = 'hana-id/email-consent/v1';
const MAX_BODY = 4096;
const MAX_SEALED = 1024;
const CONSENT_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s);

// ---- the app setting ----

/**
 * The app's `identity_email`. Before migration 0012 the column doesn't exist: every app is 'off' (as the default
 * says), so the API can be deployed before the migration without sharing or refusing anything. Throws on any other D1
 * error (callers answer 503, or a mint gives no email).
 */
export async function appIdentityEmail(db: D1Database, appId: string): Promise<IdentityEmailSetting> {
  try {
    const row = await db.prepare('SELECT identity_email FROM apps WHERE id = ?1').bind(appId).first<{ identity_email: string | null }>();
    return isIdentityEmailSetting(row?.identity_email) ? row.identity_email : 'off';
  } catch (err) {
    if (err instanceof Error && /no such column: identity_email/u.test(err.message)) return 'off';
    throw err;
  }
}

// ---- keys ----

export interface EmailKeys {
  /** EMAIL_CONSENT_KEY as an HMAC key (D419). */
  mac: CryptoKey;
  /** IDENTITY_SEAL_KEY, then IDENTITY_SEAL_KEY_PREVIOUS when set (a rotation's 24 h overlap). */
  seal: SealKey[];
}

/** Why email sharing is off in this env (logged as a code, never a value). */
export type EmailKeysProblem = 'no_email_consent_key' | 'bad_email_consent_key' | 'no_seal_key' | 'bad_seal_key';

const keyCache = new Map<string, Promise<EmailKeys | EmailKeysProblem>>();

async function loadKeys(consent: string | undefined, seal: string | undefined, previous: string | undefined): Promise<EmailKeys | EmailKeysProblem> {
  if (!consent) return 'no_email_consent_key';
  if (!CONSENT_KEY_RE.test(consent.trim())) return 'bad_email_consent_key';
  const raw = base64Decode(consent.trim());
  if (raw.length !== 32) return 'bad_email_consent_key';
  const mac = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  raw.fill(0);
  if (!seal) return 'no_seal_key';
  const current = await parseSealKey(seal);
  if (!current) return 'bad_seal_key';
  const prev = previous ? await parseSealKey(previous) : null;
  if (previous && !prev) return 'bad_seal_key';
  return { mac, seal: prev && prev.id !== current.id ? [current, prev] : [current] };
}

/** The env's email sharing keys (imported once per isolate and value), or the first problem. */
export function emailKeys(env: Pick<Env, 'EMAIL_CONSENT_KEY' | 'IDENTITY_SEAL_KEY' | 'IDENTITY_SEAL_KEY_PREVIOUS'>): Promise<EmailKeys | EmailKeysProblem> {
  const id = `${env.EMAIL_CONSENT_KEY ?? ''}\u0000${env.IDENTITY_SEAL_KEY ?? ''}\u0000${env.IDENTITY_SEAL_KEY_PREVIOUS ?? ''}`;
  let p = keyCache.get(id);
  if (!p) {
    p = loadKeys(env.EMAIL_CONSENT_KEY, env.IDENTITY_SEAL_KEY, env.IDENTITY_SEAL_KEY_PREVIOUS);
    keyCache.clear();
    keyCache.set(id, p);
  }
  return p;
}

/**
 * The address as a consent compares it: trimmed and lowercased, the same for Google's (already lowercased) and an
 * email login's normalized address. Exactly what the MAC covers.
 */
export const consentAddress = (email: string): string => email.trim().toLowerCase();

/** HMAC-SHA256(EMAIL_CONSENT_KEY, label ‖ 0x00 ‖ utf8(lowercase address)), 32 bytes. */
export async function emailMac(key: CryptoKey, email: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, concatBytes(utf8(EMAIL_CONSENT_MAC_LABEL), Uint8Array.of(0), utf8(consentAddress(email)))));
}

/** A full address as a search term (one `@` with text on both sides, no space): the only email search there is. */
export const isFullAddressTerm = (term: string): boolean => {
  const t = term.trim();
  const at = t.indexOf('@');
  return t.length >= 3 && t.length <= 254 && at > 0 && at === t.lastIndexOf('@') && at < t.length - 1 && !/\s/u.test(t);
};

/**
 * The MAC of a search term a partner typed, or null when it isn't a full address (D315's rule: only an exact address
 * is looked up, so a prefix can't be probed). Compared as shared: trimmed and lowercased.
 */
export async function searchMac(key: CryptoKey, term: string): Promise<Uint8Array | null> {
  return isFullAddressTerm(term) ? emailMac(key, term) : null;
}

// ---- consent rows ----

interface ConsentRow {
  state: 'granted' | 'declined';
  email: string | null;
  decided_at: number;
}

const one = (db: D1Database, appId: string, userSub: string, mac: Uint8Array): Promise<ConsentRow | null> =>
  db.prepare('SELECT state, email, decided_at FROM email_consents WHERE app_id = ?1 AND user_sub = ?2 AND email_mac = ?3').bind(appId, userSub, mac).first<ConsentRow>();

/** The account's most recently shared address with the app, or null. */
export async function latestShared(db: D1Database, appId: string, userSub: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT email FROM email_consents WHERE app_id = ?1 AND user_sub = ?2 AND state = 'granted' ORDER BY decided_at DESC, email_mac LIMIT 1")
    .bind(appId, userSub)
    .first<{ email: string }>();
  return row?.email ?? null;
}

/** Records a decision for one address (an upsert: the latest decision wins). */
async function decide(db: D1Database, i: { appId: string; scopeId: string; userSub: string; mac: Uint8Array; email: string; decision: 'granted' | 'declined'; now: number }): Promise<void> {
  await db
    .prepare(
      'INSERT INTO email_consents (app_id, user_sub, email_mac, state, email, scope_id, decided_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ' +
        'ON CONFLICT (app_id, user_sub, email_mac) DO UPDATE SET state = excluded.state, email = excluded.email, scope_id = excluded.scope_id, decided_at = excluded.decided_at',
    )
    .bind(i.appId, i.userSub, i.mac, i.decision, i.decision === 'granted' ? i.email : null, i.scopeId, i.now)
    .run();
}

/** Every address of the app and account → declined, the copies cleared. The number of rows that were granted. */
async function revokeAll(db: D1Database, appId: string, userSub: string, now: number): Promise<number> {
  const r = await db
    .prepare("UPDATE email_consents SET state = 'declined', email = NULL, decided_at = ?3 WHERE app_id = ?1 AND user_sub = ?2 AND state = 'granted'")
    .bind(appId, userSub, now)
    .run();
  return r.meta.changes ?? 0;
}

// ---- the mint's email (D421) ----

export interface MintEmail {
  status: IdentityEmailStatus;
  email: string | null;
}

/**
 * What a mint puts in the token: nothing while the setting is off; the session's sealed address when it opens and its
 * consent is `granted`; with no readable seal, the account's latest shared address. Never an error: a D1 or key
 * problem gives no email (logged as a code).
 */
export async function mintEmail(env: Env, ctx: Ctx, i: { app: App; userSub: string; sessionPk: Uint8Array; sealedEmail: string | null; now: number }): Promise<MintEmail> {
  try {
    const setting = await appIdentityEmail(env.DB, i.app.id);
    if (setting === 'off') return { status: 'off', email: null };
    const keys = await emailKeys(env);
    if (typeof keys === 'string') {
      log({ event: 'email_sharing_unavailable', requestId: ctx.requestId, appId: i.app.id, code: keys }, 'error');
      return { status: 'missing', email: null };
    }
    if (i.sealedEmail !== null) {
      const opened = await openSealedEmail(keys.seal, i.sealedEmail, { appId: i.app.id, sessionPublicKey: i.sessionPk, nowMs: i.now });
      if (opened.ok) {
        const row = await one(env.DB, i.app.id, i.userSub, await emailMac(keys.mac, opened.email));
        if (!row) return { status: 'not_asked', email: null };
        return row.state === 'granted' ? { status: 'included', email: opened.email } : { status: 'declined', email: null };
      }
    }
    const shared = await latestShared(env.DB, i.app.id, i.userSub);
    if (shared) return { status: 'included', email: shared };
    return { status: i.sealedEmail === null ? 'missing' : 'invalid', email: null };
  } catch {
    log({ event: 'identity_email_failed', requestId: ctx.requestId, appId: i.app.id, code: 'internal' }, 'error');
    return { status: 'missing', email: null };
  }
}

// ---- the endpoints ----

interface ConsentBody {
  sessionPk: Uint8Array;
  issuedAtMs: number;
  nonce: Uint8Array;
  signature: Uint8Array;
  sealedEmail: string | null;
  decision: 'granted' | 'declined' | null;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const keysAre = (o: Obj, required: string[], optional: string[] = []): boolean =>
  required.every((k) => Object.hasOwn(o, k)) && Object.keys(o).every((k) => required.includes(k) || optional.includes(k));
const toBytes = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;

/** Which body fields each endpoint takes. */
const SHAPES: Record<EmailConsentEndpoint, { required: string[]; optional: string[] }> = {
  [EMAIL_CONSENT_ENDPOINTS.state]: { required: [], optional: ['sealedEmail'] },
  [EMAIL_CONSENT_ENDPOINTS.decide]: { required: ['sealedEmail', 'decision'], optional: [] },
  [EMAIL_CONSENT_ENDPOINTS.revoke]: { required: [], optional: [] },
  [EMAIL_CONSENT_ENDPOINTS.preview]: { required: ['sealedEmail'], optional: [] },
};

/** The body of `endpoint`, exactly its fields, each well formed; null otherwise. */
export function toConsentBody(endpoint: EmailConsentEndpoint, body: unknown): ConsentBody | null {
  const shape = SHAPES[endpoint];
  if (!isObj(body) || !keysAre(body, ['sessionPublicKey', 'issuedAtMs', 'nonce', 'signature', ...shape.required], shape.optional)) return null;
  const sessionPk = toBytes(body.sessionPublicKey, 32);
  const nonce = toBytes(body.nonce, 16);
  const signature = toBytes(body.signature, 64);
  if (!sessionPk || !nonce || !signature || !Number.isSafeInteger(body.issuedAtMs) || (body.issuedAtMs as number) < 0) return null;
  const { sealedEmail, decision } = body;
  if (sealedEmail !== undefined && (typeof sealedEmail !== 'string' || sealedEmail.length === 0 || sealedEmail.length > MAX_SEALED)) return null;
  if (decision !== undefined && decision !== 'granted' && decision !== 'declined') return null;
  return { sessionPk, issuedAtMs: body.issuedAtMs as number, nonce, signature, sealedEmail: (sealedEmail as string | undefined) ?? null, decision: (decision as 'granted' | 'declined' | undefined) ?? null };
}

const actionOf = (endpoint: EmailConsentEndpoint, b: ConsentBody): EmailConsentAction =>
  endpoint === EMAIL_CONSENT_ENDPOINTS.state ? 'state' : endpoint === EMAIL_CONSENT_ENDPOINTS.revoke ? 'revoke' : endpoint === EMAIL_CONSENT_ENDPOINTS.preview ? 'preview' : (b.decision as 'granted' | 'declined');

const AUTH_ALLOW_HEADERS = 'content-type, x-hana-key, x-hana-parent-origin';

/** The preview's preflight: only the auth popup's origin may call it. */
export function authPreflight(request: Request, env: Env): Response {
  const origin = request.headers.get('origin');
  if (origin && env.AUTH_ORIGIN && origin === env.AUTH_ORIGIN) return new Response(null, { status: 204, headers: corsHeaders(origin, AUTH_ALLOW_HEADERS) });
  return new Response(null, { status: 403, headers: { vary: 'Origin' } });
}

type Gate = { ok: true; app: App; parentOrigin: string } | { ok: false; response: Response };

/** The preview's gate: as the vault gate, with `Origin: AUTH_ORIGIN` (the popup) instead of the vault's. */
async function authApp(request: Request, env: Env, ctx: Ctx): Promise<Gate> {
  const fail = (status: number, code: string, error: string): Gate => ({ ok: false, response: reject(ctx, status, code, error) });
  const origin = request.headers.get('origin');
  const fromAuth = !!env.AUTH_ORIGIN && origin === env.AUTH_ORIGIN;
  if (fromAuth) ctx.cors = corsHeaders(origin, AUTH_ALLOW_HEADERS);
  const key = request.headers.get('x-hana-key');
  if (!key) return fail(401, 'missing_key', 'x-hana-key header is required');
  if (!PUBLISHABLE_KEY_RE.test(key)) return fail(401, 'unknown_app', 'Unknown publishable key');
  let app: App | null;
  try {
    app = await getAppByKeyCached(env.DB, key);
  } catch {
    return fail(503, 'config_unavailable', 'App config is unavailable, try again');
  }
  lap(ctx, 'app');
  if (!app) return fail(401, 'unknown_app', 'Unknown publishable key');
  ctx.appId = app.id;
  if (appSuspended(app)) return fail(403, 'app_suspended', 'This app is suspended');
  if (!fromAuth) return fail(403, 'origin_not_allowed', 'Origin not allowed for this endpoint');
  const parentOrigin = request.headers.get('x-hana-parent-origin');
  if (!parentOrigin || !parentOriginAllowed(env.ENV_NAME, app, parentOrigin)) return fail(403, 'origin_not_allowed', 'Parent origin not allowed for this app');
  if (app.scope_conflict) return fail(403, 'scope_conflict', 'This key’s environment is not its scope’s');
  return { ok: true, app, parentOrigin };
}

/** Per session key: the identity binding's flood limit (10 a minute), counted apart from the session's mints. */
export const emailSessionKey = (envName: string, appId: string, sessionPkHex: string): string => `${envName}:email-consent:${appId}:${sessionPkHex}`;

const unavailable = (ctx: Ctx): Response => reject(ctx, 503, 'email_sharing_unavailable', 'Email sharing is unavailable in this environment');
const noAddress = (ctx: Ctx, reason: string): Response => done(ctx, 400, { error: 'The session has no address Hana can read', code: 'email_unavailable', reason });

export async function handleEmailConsent(request: Request, env: Env, endpoint: EmailConsentEndpoint, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const preview = endpoint === EMAIL_CONSENT_ENDPOINTS.preview;
  const gate = preview ? await authApp(request, env, ctx) : await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const { app, parentOrigin } = gate;
  const limited = await vaultIpLimit(request, env, ctx, app);
  if (limited) return limited;
  const subKey = identitySubKey(env);
  const keys = await emailKeys(env);
  if (typeof subKey === 'string' || typeof keys === 'string') {
    log({ event: 'email_sharing_unavailable', requestId, appId: app.id, code: typeof subKey === 'string' ? subKey : (keys as EmailKeysProblem) }, 'error');
    return unavailable(ctx);
  }

  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const b = toConsentBody(endpoint, parsed.body);
  if (!b) return reject(ctx, 400, 'bad_request', 'Malformed email consent request');
  const action = actionOf(endpoint, b);

  const now = Date.now();
  if (Math.abs(now - b.issuedAtMs) > IDENTITY_PROOF_WINDOW_MS) return done(ctx, 400, { error: 'The session proof is too old or too new', code: 'stale_proof', serverTimeMs: now });
  const payload = emailConsentPayload({ action, parentOrigin, sealedEmail: b.sealedEmail });
  const message = identityMessage({ signer: env.SIGNER_ACCOUNT, appId: app.id, sessionPublicKey: b.sessionPk, issuedAtMs: b.issuedAtMs, nonce: b.nonce, payload });
  if (!(await verifyEd25519(b.sessionPk, b.signature, message))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  lap(ctx, 'proof');

  const pkHex = hex(b.sessionPk);
  try {
    const hit = await env.IDENTITY_SESSION_LIMIT.limit({ key: emailSessionKey(env.ENV_NAME, app.id, pkHex) });
    if (!hit.success) return reject(ctx, 429, 'rate_limited', 'Rate limit exceeded (session per minute)', { 'retry-after': String(IDENTITY_LIMIT_PERIOD_S) });
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  // A revoke works through a pause: stopping sharing must never wait on an incident.
  if (action !== 'revoke') {
    try {
      if ((await getConfig(env)).paused) return done(ctx, 503, { error: 'Hana ID is paused, try again later', code: 'paused', retryAfterS: PAUSED_RETRY_S }, { 'retry-after': String(PAUSED_RETRY_S) });
    } catch {
      return reject(ctx, 502, 'near_unavailable', 'Could not read the contract config');
    }
  }
  const share = await checkShare(env, ctx, app, parentOrigin, b.sessionPk, now);
  if (!share.ok) return share.response;
  const chain = await checkChainSession(env, ctx, app, b.sessionPk, now);
  if (!chain.ok) return chain.response;
  lap(ctx, 'session');
  const root = identityRoot(chain.session.path, app.scope_id);
  if (!root) {
    log({ event: 'identity_bad_session_path', requestId, appId: app.id }, 'error');
    return reject(ctx, 502, 'bad_contract_result', 'The session path is not one this API can read');
  }
  try {
    if (!(await limiter(env, identityProofLimiter(pkHex)).reserve(await proofMarker({ sessionPk: b.sessionPk, issuedAtMs: b.issuedAtMs, nonce: b.nonce }), b.issuedAtMs + IDENTITY_PROOF_MARKER_MS, now))) {
      return reject(ctx, 409, 'proof_replayed', 'This session proof was already used');
    }
  } catch {
    return reject(ctx, 503, 'rate_limiter_unavailable', 'Try again');
  }
  const userSub = identitySub(subKey, app.scope_id, root);

  try {
    const setting = await appIdentityEmail(env.DB, app.id);
    if (action === 'revoke') {
      const revoked = await revokeAll(env.DB, app.id, userSub, now);
      return done(ctx, 200, { state: 'declined', revoked });
    }
    const opened = b.sealedEmail === null ? null : await openSealedEmail(keys.seal, b.sealedEmail, { appId: app.id, sessionPublicKey: b.sessionPk, nowMs: now });
    if (action === 'state') {
      let state: EmailConsentState;
      if (opened?.ok) {
        const row = await one(env.DB, app.id, userSub, await emailMac(keys.mac, opened.email));
        state = row ? row.state : 'not_asked';
      } else {
        state = (await latestShared(env.DB, app.id, userSub)) ? 'granted' : 'unavailable';
      }
      return done(ctx, 200, { setting, state });
    }
    if (setting === 'off') return reject(ctx, 409, 'identity_email_off', 'Email sharing is off for this app');
    if (!opened?.ok) return noAddress(ctx, opened ? opened.reason : 'malformed');
    if (action === 'preview') return done(ctx, 200, { email: opened.email });
    await decide(env.DB, { appId: app.id, scopeId: app.scope_id, userSub, mac: await emailMac(keys.mac, opened.email), email: opened.email, decision: action, now });
    return done(ctx, 200, { state: action });
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'Could not read or write the consent, try again');
  }
}

/** ConsoleRpc.listUsers' email search (D411, D315): the term's MAC under this env's key, or null without one. */
export async function emailSearchMac(env: Pick<Env, 'EMAIL_CONSENT_KEY' | 'IDENTITY_SEAL_KEY' | 'IDENTITY_SEAL_KEY_PREVIOUS'>, term: string): Promise<Uint8Array | null> {
  const keys = await emailKeys(env);
  return typeof keys === 'string' ? null : searchMac(keys.mac, term);
}
