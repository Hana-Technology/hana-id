// Whose rows a Hana Home identity may see and stop in a scope (docs/hana-home-spec.md "Home: list and revoke"): the
// account root its partner logins derive, so a linked member reaches its root's shares, consents and email consents.
//
// The root comes from the wallet directory (D466), by the same rule `GET /v1/home/apps` uses for "mine": only a row the
// directory records as `active` for this `(provider, sub)` counts, and its account's root row gives the root. With no such
// row (an unlinked user Hana never recorded, a purged scope, a link still in its delay), the identity's own path is used:
// it finds an unlinked user's rows and no one else's. Every list and every revoke takes the root from here, so whatever
// the list shows can be stopped and nothing else can.
//
// The path is `{scope}#{provider}#{sub}#0`: key index 0 is the only one the vault opens (vault/login.ts `KEY_INDEX`), so it
// is the only path a share or a consent is ever recorded under. Its sha256 is what `vault_shares.path_hash` and
// `vault_consents.path_hash` hold. Nothing here derives a key or changes a path.
//
// SECURITY: `(provider, sub)` comes only from `homeGate`'s verified token. Nothing here logs a `sub`, a root, a path or a
// path hash.
import { identitySub } from '@hana-id/core/identity';
import { sha256 } from '../bytes.ts';
import type { Env } from '../env.ts';
import { identitySubKey } from '../identity/signer.ts';
import type { HomeIdentity } from './identity.ts';

/** The only key index a vault opens, so the only one shares and consents are recorded under. */
export const HOME_KEY_INDEX = 0;

export interface HomeRoot {
  scopeId: string;
  /** The account root the identity's partner logins derive in this scope: its own when the directory records no account. */
  root: { provider: string; sub: string };
  /** sha256(utf8(path)) of the root's path at key index 0. */
  pathHash: Uint8Array;
  /** The account's User ID in the scope (`email_consents.user_sub`), or null when the env has no IDENTITY_SUB_KEY. */
  userSub: string | null;
}

interface RootRow {
  scope_id: string;
  root_provider: string;
  root_sub: string;
  token_sub: string;
}

/** The identity's `active` directory rows joined to their account's root. */
const ROOTS = `SELECT i.scope_id, r.provider AS root_provider, r.sub AS root_sub, u.token_sub
  FROM end_user_identities i
  JOIN end_user_identities r ON r.scope_id = i.scope_id AND r.user_id = i.user_id AND r.role = 'root' AND r.status = 'active' AND r.sub IS NOT NULL
  JOIN end_users u ON u.user_id = i.user_id
 WHERE i.sub = ?1 AND i.provider = ?2 AND i.status = 'active'`;

export const rootPathHash = async (scopeId: string, root: { provider: string; sub: string }): Promise<Uint8Array> =>
  sha256(new TextEncoder().encode(`${scopeId}#${root.provider}#${root.sub}#${HOME_KEY_INDEX}`));

const toRoot = async (r: RootRow): Promise<HomeRoot> => {
  const root = { provider: r.root_provider, sub: r.root_sub };
  return { scopeId: r.scope_id, root, pathHash: await rootPathHash(r.scope_id, root), userSub: r.token_sub };
};

/**
 * The scopes where the directory records this identity, in scope order after `after`, at most `limit + 1` (so the caller
 * can tell whether there is a next page). Throws when D1 can't answer.
 */
export async function overlayRoots(db: D1Database, identity: Pick<HomeIdentity, 'provider' | 'sub'>, after: string | null, limit: number): Promise<HomeRoot[]> {
  const { results } = await db
    .prepare(`${ROOTS} AND i.scope_id > ?3 ORDER BY i.scope_id LIMIT ?4`)
    .bind(identity.sub, identity.provider, after ?? '', limit + 1)
    .all<RootRow>();
  const out: HomeRoot[] = [];
  for (const r of results) if (!out.some((x) => x.scopeId === r.scope_id)) out.push(await toRoot(r));
  return out;
}

/** One scope's root for this identity: the directory's account root, else the identity's own. Throws when D1 can't answer. */
export async function scopeRoot(env: Pick<Env, 'DB' | 'IDENTITY_SUB_KEY'>, scopeId: string, identity: Pick<HomeIdentity, 'provider' | 'sub'>): Promise<HomeRoot> {
  const row = await env.DB.prepare(`${ROOTS} AND i.scope_id = ?3 LIMIT 1`).bind(identity.sub, identity.provider, scopeId).first<RootRow>();
  if (row) return toRoot(row);
  const root = { provider: identity.provider, sub: identity.sub };
  const key = identitySubKey(env);
  return { scopeId, root, pathHash: await rootPathHash(scopeId, root), userSub: typeof key === 'string' ? null : identitySub(key, scopeId, root) };
}

export const sameBytes = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((x, i) => x === b[i]);
