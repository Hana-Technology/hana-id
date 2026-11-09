// POST /v1/vault/consents and /v1/vault/consents/revoke (docs/hana-home-spec.md "Vault messages"; D45, D98, D465, D510).
// The vault's half of an auto-approve consent: at Allow it registers the consent here, and it revokes it when the user
// stops auto-approving. Each call is a session-key signature over the vault message:
//
//   'session' mode: shareId and the share's next counter (single use, in order, on the same atomic rule as every other
//     share action; the share's checks come from the identity token's `checkShare`).
//   'none' mode: 16 zero bytes and counter 0 (no share, no counter). The on-chain session must be live in the app's
//     scope; the primary key is the replay check while the consent can still matter.
//
// The session key lives only in the vault, so a partner page can't prove anything here, and every row is keyed by that
// key: no user can register or revoke another user's consent. A consent row is narrow-only: it can stop auto-signing,
// never start it.
//
// SECURITY: nothing here logs a body, a consent id, a session key, a path hash or a `sub`.
import { CONSENT_ID_BYTES, CONSENT_POLICY_ID_BYTES, consentRegisterPayload, consentRevokePayload } from '@hana-id/core/home';
import type { App } from '../apps.ts';
import { hex, sha256 } from '../bytes.ts';
import type { Env } from '../env.ts';
import { type Ctx, done, lap, newCtx, reject } from '../handlers.ts';
import { readJson } from '../http.ts';
import { checkChainSession, checkShare } from '../identity/token.ts';
import { CONSENT_MAX_PER_SESSION_KEY, consentExists, consentRowsForKey, getConsent, registerConsent, revokeConsent } from './consent-store.ts';
import { refusal, shareLimit, vaultApp, vaultLimits } from './endpoints.ts';
import { NO_SHARE_ID, SHARE_ID_BYTES, verifyVaultSignature } from './message.ts';
import { effectiveSettings, getSettingsRow } from './settings.ts';

export const CONSENT_ENDPOINTS = ['/v1/vault/consents', '/v1/vault/consents/revoke'] as const;
export type ConsentEndpoint = (typeof CONSENT_ENDPOINTS)[number];
export const isConsentEndpoint = (path: string): path is ConsentEndpoint => (CONSENT_ENDPOINTS as readonly string[]).includes(path);

const REGISTER: ConsentEndpoint = '/v1/vault/consents';
/** Consent bodies are a few byte arrays and two integers. */
const MAX_BODY = 4096;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const toBytes = (v: unknown, n: number): Uint8Array | null =>
  Array.isArray(v) && v.length === n && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255) ? Uint8Array.from(v as number[]) : null;
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

interface ConsentBody {
  shareId: Uint8Array | null;
  sessionPk: Uint8Array;
  counter: number;
  signature: Uint8Array;
  consentId: Uint8Array;
}
interface RegisterBody extends ConsentBody {
  policyId: Uint8Array;
  expiresAtMs: number;
}

/** `shareId` present is 'session' mode (counter ≥ 1); absent is 'none' mode (counter exactly 0). */
function toBody(body: unknown, extra: readonly string[]): (Obj & ConsentBody) | null {
  if (!isObj(body)) return null;
  const hasShare = 'shareId' in body;
  const keys = ['sessionPublicKey', 'counter', 'signature', 'consentId', ...extra, ...(hasShare ? ['shareId'] : [])];
  if (Object.keys(body).length !== keys.length || !keys.every((k) => k in body)) return null;
  const shareId = hasShare ? toBytes(body.shareId, SHARE_ID_BYTES) : null;
  if (hasShare && !shareId) return null;
  const sessionPk = toBytes(body.sessionPublicKey, 32);
  const signature = toBytes(body.signature, 64);
  const consentId = toBytes(body.consentId, CONSENT_ID_BYTES);
  const { counter } = body;
  if (!sessionPk || !signature || !consentId || !Number.isSafeInteger(counter)) return null;
  if (shareId ? (counter as number) < 1 : counter !== 0) return null;
  return { ...body, shareId, sessionPk, counter: counter as number, signature, consentId };
}

function toRegisterBody(body: unknown): RegisterBody | null {
  const b = toBody(body, ['policyId', 'expiresAtMs']);
  if (!b) return null;
  const policyId = toBytes(b.policyId, CONSENT_POLICY_ID_BYTES);
  const { expiresAtMs } = b;
  if (!policyId || !Number.isSafeInteger(expiresAtMs) || (expiresAtMs as number) <= 0) return null;
  return { ...b, policyId, expiresAtMs: expiresAtMs as number };
}

const signedBy = (env: Env, app: App, b: ConsentBody, payload: Uint8Array): Promise<boolean> =>
  verifyVaultSignature(b.sessionPk, b.signature, { signer: env.SIGNER_ACCOUNT, appId: app.id, shareId: b.shareId ?? NO_SHARE_ID, counter: b.counter, payload });

export async function handleVaultConsent(request: Request, env: Env, endpoint: ConsentEndpoint, requestId: string): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const gate = await vaultApp(request, env, ctx);
  if (!gate.ok) return gate.response;
  const limited = await vaultLimits(request, env, ctx, gate.app);
  if (limited) return limited;
  const parsed = await readJson(request, MAX_BODY);
  if (!parsed.ok) return reject(ctx, parsed.status, 'bad_request', parsed.error);
  const register = endpoint === REGISTER;
  const body = register ? toRegisterBody(parsed.body) : toBody(parsed.body, []);
  if (!body) return reject(ctx, 400, 'bad_request', 'Malformed consent request');
  lap(ctx, 'limits');
  try {
    return register ? await registerRequest(env, ctx, gate.app, gate.parentOrigin, body as RegisterBody) : await revokeRequest(env, ctx, gate.app, body);
  } catch {
    return reject(ctx, 503, 'config_unavailable', 'Vault storage is unavailable, try again');
  }
}

const notInForce = (ctx: Ctx): Response => reject(ctx, 409, 'policy_not_in_force', 'The consent is not for the policy in force');
const exists = (ctx: Ctx): Response => reject(ctx, 409, 'consent_exists', 'This consent id was already registered');

/**
 * The 10/min window, after the signature (D510): an unsigned request can't spend a real user's window, while the per-IP
 * limit (`vaultLimits`, before the body) still caps signature checks. A 'none'-mode consent has no share, so its session
 * key takes the share's place in the window.
 */
const consentLimit = (env: Env, ctx: Ctx, app: App, b: ConsentBody): Promise<Response | null> => shareLimit(env, ctx, app, b.shareId ?? b.sessionPk);

async function registerRequest(env: Env, ctx: Ctx, app: App, parentOrigin: string, b: RegisterBody): Promise<Response> {
  const payload = consentRegisterPayload({ consentId: b.consentId, policyId: b.policyId, expiresAtMs: b.expiresAtMs, parentOrigin });
  if (!(await signedBy(env, app, b, payload))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  lap(ctx, 'proof');
  const perShare = await consentLimit(env, ctx, app, b);
  if (perShare) return perShare;

  const now = Date.now();
  // The share's rules, as a mint reads them: 'session' apps need a live share of this app and parent; 'none' apps need
  // the session to have no share anywhere (D178). The body's mode must then match what the session really is.
  const checked = await checkShare(env, ctx, app, parentOrigin, b.sessionPk, now);
  if (!checked.ok) return checked.response;
  const { share } = checked;
  if (b.shareId ? !share || !same(share.shareId, b.shareId) : share !== null) return reject(ctx, 404, 'unknown_share', 'Unknown share');
  let cap: number;
  let pathHash: Uint8Array;
  if (share) {
    cap = share.absCapMs;
    pathHash = share.pathHash;
  } else {
    // One chain read at most (D513): a fresh throwaway key must not cost a retry loop of reads, and a session the node
    // hasn't caught up with answers a retryable 503, which the vault tries again.
    const chain = await checkChainSession(env, ctx, app, b.sessionPk, now, { singleRead: true });
    if (!chain.ok) return chain.response;
    cap = chain.session.expires_at_ms;
    pathHash = await sha256(new TextEncoder().encode(chain.session.path));
  }
  lap(ctx, 'session');

  const row = await getSettingsRow(env.DB, app.id);
  if (!row) return reject(ctx, 401, 'unknown_app', 'Unknown publishable key');
  const settings = await effectiveSettings(row, app.id, now);
  const policy = settings.autoApprovePolicy;
  if (!policy) return notInForce(ctx);
  const { policyId } = await import('@hana-id/core/policy');
  if (policyId(policy, { sessionTtlMs: settings.sessionTtlMs }) !== hex(b.policyId)) return notInForce(ctx);
  if (b.expiresAtMs <= now) return reject(ctx, 400, 'bad_expiry', 'The consent must end after now and no later than the session');
  // A vault that doesn't know the cap (the app lowered its session TTL since the tab loaded) learns it here, for its next Allow.
  if (b.expiresAtMs > cap) return done(ctx, 400, { error: 'The consent must end after now and no later than the session', code: 'bad_expiry', maxExpiresAtMs: cap });

  if (await consentExists(env.DB, b.consentId)) return exists(ctx);
  if ((await consentRowsForKey(env.DB, pathHash, b.sessionPk)) >= CONSENT_MAX_PER_SESSION_KEY) return reject(ctx, 429, 'too_many_consents', 'This session has registered too many consents');
  const { created, advanced } = await registerConsent(
    env.DB,
    { consentId: b.consentId, appId: app.id, shareId: b.shareId, sessionPk: b.sessionPk, pathHash, partnerOrigin: parentOrigin, policyId: b.policyId, label: policy.label, grantedAt: now, expiresAt: b.expiresAtMs },
    b.counter,
    now,
  );
  lap(ctx, 'insert');
  if (b.shareId && advanced === null) return await refusal(env, ctx, app, b.shareId, now);
  if (!created) return exists(ctx);
  return done(ctx, 201, { counter: advanced, grantedAtMs: now, expiresAtMs: b.expiresAtMs });
}

async function revokeRequest(env: Env, ctx: Ctx, app: App, b: ConsentBody): Promise<Response> {
  if (!(await signedBy(env, app, b, consentRevokePayload(b.consentId)))) return reject(ctx, 401, 'invalid_signature', 'Invalid session signature');
  lap(ctx, 'proof');
  const perShare = await consentLimit(env, ctx, app, b);
  if (perShare) return perShare;
  const now = Date.now();
  const row = await getConsent(env.DB, app.id, b.consentId);
  // The same answer for "no such consent" and "not yours": a key can only ever act on its own consents.
  const sameShare = row && (row.share_id && b.shareId ? same(row.share_id, b.shareId) : row.share_id === b.shareId);
  if (!row || !sameShare || !same(row.session_pk, b.sessionPk)) return reject(ctx, 404, 'unknown_consent', 'Unknown consent');
  const { revoked, advanced } = await revokeConsent(env.DB, app.id, b.consentId, b.shareId ? { shareId: b.shareId, counter: b.counter } : null, now);
  if (b.shareId && advanced === null) return await refusal(env, ctx, app, b.shareId, now);
  return done(ctx, 200, { revoked, counter: advanced });
}
