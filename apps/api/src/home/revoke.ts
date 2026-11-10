// Hana Home's three stops (docs/hana-home-spec.md "Home: list and revoke", D45, D98 item 9, D411 point 6, D442's
// amendment, D465):
//
//   POST /v1/home/consents/revoke       {consentId}  stop one auto-approve consent (`revoked_by = 'home'`)
//   POST /v1/home/shares/revoke         {shareId}    "Sign out this device": the share ends, and its consent with it
//                                                    (`revoked_by = 'share'`, D513)
//   POST /v1/home/email-sharing/revoke  {appId}      stop sharing the account's email with one app, as the session-proof
//                                                    route does (identity/email.ts): every address → declined, copies gone
//
// Each loads the row, recomputes the signed-in identity's account root for the row's scope (root.ts, the rule the list
// uses) and acts only when the row is that root's: another user's id, an id that doesn't exist and an id of an app with
// nothing of this user's all answer the same 404, so ids can't be probed. The write is conditional on the same path hash
// or User ID, so nothing between the read and the write can move it onto another row. A root that is another identity's
// (a member's account) is confirmed on chain first, with one `get_identity` view (D661): a stale directory row must not
// let a removed login stop anything; the chain not answering is a retryable 503 and nothing is written.
//
// What a stop does in an open tab: the vault's status read (`GET /v1/app`, every 10 s before an auto-signature, D465)
// reads the consent as `'revoked'` and auto-signing stops there within about 10 s. A signed-out device's open tab learns
// it from the same read's `share` (D662): within about a minute in an app with a policy (its periodic read), else at its
// next read, touch, unlock or reload (D55). On chain the session is already used up. Signatures already made stay valid.
// No chain transaction, no key: these work through a governance pause (a view still answers), as stopping must never
// wait on an incident.
//
// SECURITY: `(provider, sub)` comes only from `homeGate`'s verified token. Nothing here logs an id, a path hash, a `sub`,
// an app id (which apps a Home user uses is theirs) or an address.
import { base64UrlDecode } from '../bytes.ts';
import type { Env } from '../env.ts';
import { type Ctx, done, lap, newCtx, reject } from '../handlers.ts';
import { blob } from '../vault/shares.ts';
import { homeGate } from './identity.ts';
import { type HomeRoot, confirmedRoot, sameBytes, scopeRoot } from './root.ts';

export const HOME_REVOKE_ENDPOINTS = {
  consent: '/v1/home/consents/revoke',
  share: '/v1/home/shares/revoke',
  email: '/v1/home/email-sharing/revoke',
} as const;
export type HomeRevokeEndpoint = (typeof HOME_REVOKE_ENDPOINTS)[keyof typeof HOME_REVOKE_ENDPOINTS];
export const isHomeRevokeEndpoint = (p: string): p is HomeRevokeEndpoint => (Object.values(HOME_REVOKE_ENDPOINTS) as string[]).includes(p);

/** docs/hana-home-spec.md "Rate limits": the three share one window per IP and one per Home key. */
export const HOME_REVOKE_PER_IP_MINUTE = 30;
export const HOME_REVOKE_PER_KEY_MINUTE = 30;

const ID_BYTES = 16;
const APP_RE = /^app_[A-Za-z0-9_-]{1,64}$/u;

/** A 16-byte id as the list gives it (base64url, no padding), or null. */
function toId(v: unknown): Uint8Array | null {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_-]{22}$/u.test(v)) return null;
  try {
    const b = base64UrlDecode(v);
    return b.length === ID_BYTES ? b : null;
  } catch {
    return null;
  }
}

type Body = { kind: 'consent'; consentId: Uint8Array } | { kind: 'share'; shareId: Uint8Array } | { kind: 'email'; appId: string };

/** Exactly the endpoint's one field, well formed; null otherwise. */
function toBody(endpoint: HomeRevokeEndpoint, bytes: Uint8Array): Body | null {
  let v: unknown;
  try {
    v = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const field = endpoint === HOME_REVOKE_ENDPOINTS.consent ? 'consentId' : endpoint === HOME_REVOKE_ENDPOINTS.share ? 'shareId' : 'appId';
  if (Object.keys(o).length !== 1 || !Object.hasOwn(o, field)) return null;
  if (field === 'appId') return typeof o.appId === 'string' && APP_RE.test(o.appId) ? { kind: 'email', appId: o.appId } : null;
  const b = toId(o[field]);
  if (!b) return null;
  return field === 'consentId' ? { kind: 'consent', consentId: b } : { kind: 'share', shareId: b };
}

const SHAPE: Readonly<Record<HomeRevokeEndpoint, string>> = {
  [HOME_REVOKE_ENDPOINTS.consent]: 'Body must be {consentId: 16 bytes, base64url}',
  [HOME_REVOKE_ENDPOINTS.share]: 'Body must be {shareId: 16 bytes, base64url}',
  [HOME_REVOKE_ENDPOINTS.email]: 'Body must be {appId}',
};

/** The one answer for "no such row" and "not yours". */
const UNKNOWN: Readonly<Record<Body['kind'], [string, string]>> = {
  consent: ['unknown_consent', 'Unknown consent'],
  share: ['unknown_share', 'Unknown device'],
  email: ['unknown_email_share', 'Nothing shared with this app'],
};

export async function handleHomeRevoke(request: Request, env: Env, endpoint: HomeRevokeEndpoint, requestId: string, now: number = Date.now()): Promise<Response> {
  const ctx = newCtx(env, requestId, endpoint, request);
  const gate = await homeGate(request, env, ctx, { ipPerMinute: HOME_REVOKE_PER_IP_MINUTE, keyPerMinute: HOME_REVOKE_PER_KEY_MINUTE, window: 'revoke' }, now);
  if (!gate.ok) return gate.response;
  lap(ctx, 'identity');
  const body = toBody(endpoint, gate.body);
  if (!body) return reject(ctx, 400, 'bad_request', SHAPE[endpoint]);
  const unknown = (): Response => reject(ctx, 404, ...UNKNOWN[body.kind]);
  try {
    if (body.kind === 'consent') return await revokeConsentRow(env, ctx, gate.identity, body.consentId, now, unknown);
    if (body.kind === 'share') return await revokeShareRow(env, ctx, gate.identity, body.shareId, now, unknown);
    return await revokeEmail(env, ctx, gate.identity, body.appId, now, unknown);
  } catch {
    return reject(ctx, 503, 'home_directory_unavailable', 'Could not reach the records, try again');
  }
}

type Who = { provider: string; sub: string };

/**
 * A member-resolved root confirmed on chain before any write (D661): a stale `active` directory row (an unlink whose sync
 * failed) must not let a removed login stop the account's devices or sharing. Null when the chain can't answer.
 */
async function confirmed(env: Env, ctx: Ctx, r: HomeRoot, who: Who): Promise<HomeRoot | null> {
  if (!r.member) return r;
  try {
    const out = await confirmedRoot(env, r, who);
    lap(ctx, 'chain');
    return out;
  } catch {
    return null;
  }
}

/** The chain couldn't confirm the account: retryable, and nothing was written. */
const chainDown = (ctx: Ctx): Response => reject(ctx, 503, 'near_unavailable', 'Could not confirm the account on NEAR, try again', { 'retry-after': '2' });

/** The row's scope and path hash, by its id, in any app; null when there is no such row. */
async function rowOf(db: D1Database, table: 'vault_consents' | 'vault_shares', idColumn: 'consent_id' | 'share_id', rowId: Uint8Array): Promise<{ appId: string; scopeId: string; pathHash: Uint8Array } | null> {
  const r = await db.prepare(`SELECT t.app_id, a.scope_id, t.path_hash FROM ${table} t JOIN apps a ON a.id = t.app_id WHERE t.${idColumn} = ?1`).bind(rowId).first<{ app_id: string; scope_id: string; path_hash: unknown }>();
  return r ? { appId: r.app_id, scopeId: r.scope_id, pathHash: blob(r.path_hash) } : null;
}

/** Stops one consent. `revoked: false` when it had already ended (a repeat, or the device stopped it first). */
async function revokeConsentRow(env: Env, ctx: Ctx, who: Who, consentId: Uint8Array, now: number, unknown: () => Response): Promise<Response> {
  const row = await rowOf(env.DB, 'vault_consents', 'consent_id', consentId);
  if (!row) return unknown();
  const root = await confirmed(env, ctx, await scopeRoot(env, row.scopeId, who), who);
  if (!root) return chainDown(ctx);
  if (!sameBytes(root.pathHash, row.pathHash)) return unknown();
  lap(ctx, 'row');
  const res = await env.DB.prepare("UPDATE vault_consents SET revoked_at = ?3, revoked_by = 'home' WHERE consent_id = ?1 AND path_hash = ?2 AND revoked_at IS NULL")
    .bind(consentId, root.pathHash, now)
    .run();
  return done(ctx, 200, { revoked: res.meta.changes === 1 });
}

/**
 * "Sign out this device": the share ends and its consents with it, in one D1 batch. `revoked: false` when the share had
 * already ended. The vault's next unlock or touch then gets `410 share_revoked`, and its status read `'revoked'`.
 */
async function revokeShareRow(env: Env, ctx: Ctx, who: Who, shareId: Uint8Array, now: number, unknown: () => Response): Promise<Response> {
  const row = await rowOf(env.DB, 'vault_shares', 'share_id', shareId);
  if (!row) return unknown();
  const root = await confirmed(env, ctx, await scopeRoot(env, row.scopeId, who), who);
  if (!root) return chainDown(ctx);
  if (!sameBytes(root.pathHash, row.pathHash)) return unknown();
  lap(ctx, 'row');
  const [share] = await env.DB.batch([
    env.DB.prepare('UPDATE vault_shares SET revoked_at = ?3 WHERE share_id = ?1 AND path_hash = ?2 AND revoked_at IS NULL').bind(shareId, root.pathHash, now),
    env.DB.prepare("UPDATE vault_consents SET revoked_at = ?3, revoked_by = 'share' WHERE share_id = ?1 AND path_hash = ?2 AND revoked_at IS NULL").bind(shareId, root.pathHash, now),
  ]);
  return done(ctx, 200, { revoked: (share?.meta.changes ?? 0) === 1 });
}

/**
 * Stops sharing the account's email with one app: what `POST /v1/identity/email-consent/revoke` does, keyed by the account's
 * User ID in the app's scope instead of a session proof. 404 when the app is unknown or this account never decided
 * anything there (nothing to stop, and nothing to tell apart from another user's). `revoked`: addresses that were shared.
 */
async function revokeEmail(env: Env, ctx: Ctx, who: Who, appId: string, now: number, unknown: () => Response): Promise<Response> {
  const app = await env.DB.prepare('SELECT scope_id FROM apps WHERE id = ?1').bind(appId).first<{ scope_id: string }>();
  if (!app) return unknown();
  const root = await confirmed(env, ctx, await scopeRoot(env, app.scope_id, who), who);
  if (!root) return chainDown(ctx);
  if (root.userSub === null) return reject(ctx, 503, 'email_sharing_unavailable', 'Email sharing is unavailable in this environment');
  lap(ctx, 'row');
  let revoked: number;
  try {
    const [res, any] = await env.DB.batch<{ hit: number }>([
      env.DB.prepare("UPDATE email_consents SET state = 'declined', email = NULL, decided_at = ?3 WHERE app_id = ?1 AND user_sub = ?2 AND state = 'granted'").bind(appId, root.userSub, now),
      env.DB.prepare('SELECT 1 AS hit FROM email_consents WHERE app_id = ?1 AND user_sub = ?2 LIMIT 1').bind(appId, root.userSub),
    ]);
    revoked = res?.meta.changes ?? 0;
    if (revoked === 0 && (any?.results.length ?? 0) === 0) return unknown();
  } catch (err) {
    // Before migration 0014 nothing can have been shared.
    if (err instanceof Error && /no such table: email_consents/u.test(err.message)) return unknown();
    throw err;
  }
  return done(ctx, 200, { state: 'declined', revoked });
}
