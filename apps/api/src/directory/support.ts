// The hot-DB part of the staff Support ID lookup (batch C15; console-core support.ts; D96, D144, D276 as amended by
// D346, D384): `AdminRpc.supportLookup` and `AdminRpc.userShares`. Read only, staff only (a `hana` actor; the admin
// Worker records the audit row before it calls, D386). The usage ledger's part (logins, sessions, derives by uid; errors
// by request ID) is read by the admin Worker and the CLI as `usage_admin`, never here: the API's ledger role can only
// write (D73).
//
// Code → user is the wallet directory (`end_users.support_code`, `token_sub`, `user_id`; D312, D346): every match is
// listed, at most SUPPORT_MATCHES_MAX in full. For each, the scope's apps, the user's vault shares in them that haven't
// expired, and the scope's apps' `app_changes` in the window.
//
// SECURITY: the answer is staff data (subs, wallet addresses, app changes); nothing here logs any of it. No share id,
// session key, counter or wrapped share is selected.
import {
  type AppChange,
  SUPPORT_CHANGES_MAX,
  SUPPORT_DAYS_DEFAULT,
  SUPPORT_MATCHES_MAX,
  SUPPORT_SHARES_MAX,
  type StaffUser,
  type SupportApp,
  type SupportLookupResult,
  type SupportMatch,
  type SupportShare,
  type UserShare,
  formatSupportId,
  parseSupportQuery,
  supportSince,
} from '@hana-id/console-core';
import { sha256 } from '../bytes.ts';
import { refuse } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { type Q, join, q, raw } from '../changes/sql.ts';
import { APP_CHANGE_COLUMNS, type AppChangeRow, appChangeView } from '../changes/views.ts';
import { adminFindUsers } from './read.ts';

const NOT_A_QUERY = 'query: not a Support ID (HANA-XXXX-XXXX), User ID (u1_…) or internal id (hu_…)';

const pathHash = async (path: string): Promise<ArrayBuffer> => {
  const h = await sha256(new TextEncoder().encode(path));
  return h.buffer.slice(h.byteOffset, h.byteOffset + h.byteLength) as ArrayBuffer;
};

/** `{scope}#{provider}#{sub}#{keyIndex}` (sessions.rs): the path a session of the account rooted at `root` opens. */
export const rootPath = (scopeId: string, root: { provider: string; sub: string }, keyIndex: number): string => `${scopeId}#${root.provider}#${root.sub}#${keyIndex}`;

const isLive = (r: { revoked_at: number | null; idle_until: number; abs_expires_at: number }, now: number): boolean => r.revoked_at === null && now < r.idle_until && now < r.abs_expires_at;

interface ShareRow {
  app_id: string;
  path_hash: unknown;
  created_at: number;
  idle_until: number;
  abs_expires_at: number;
  revoked_at: number | null;
}

/**
 * `AdminRpc.userShares` (the spec's planned method): the shares of `path` in `appId` that haven't expired (live,
 * idle-expired or revoked, until the hourly cron prunes them), newest first. The path is hashed here; it is never
 * stored or logged.
 */
export async function userShares(db: HotDb, i: { appId: string; path: string }, now: number): Promise<{ shares: UserShare[] }> {
  const rows = await db.all<ShareRow>(
    q`SELECT app_id, path_hash, created_at, idle_until, abs_expires_at, revoked_at FROM vault_shares
       WHERE app_id = ${i.appId} AND path_hash = ${await pathHash(i.path)} AND abs_expires_at > ${now} ORDER BY created_at DESC LIMIT ${SUPPORT_SHARES_MAX}`,
  );
  return { shares: rows.map((r) => ({ createdAt: r.created_at, idleUntil: r.idle_until, absExpiresAt: r.abs_expires_at, revokedAt: r.revoked_at })) };
}

interface AppRow {
  id: string;
  name: string;
  org_id: string;
  scope_id: string;
  environment: 'test' | 'live' | null;
  persistence: 'session' | 'none';
  deleted_at: number | null;
}

/** The scope's apps, deleted ones included (their changes and shares still say what happened). */
async function scopeApps(db: HotDb, scopeIds: string[]): Promise<AppRow[]> {
  if (scopeIds.length === 0) return [];
  return db.all<AppRow>(
    q`SELECT a.id, a.name, a.org_id, a.scope_id, s.environment, a.persistence, a.deleted_at FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id
       WHERE a.scope_id IN (${join(scopeIds.map((s) => q`${s}`), ', ')}) ORDER BY a.created_at, a.id`,
  );
}

/** The account root of a directory user (its `root` identity; the ids were computed from it, so it has a sub). */
function rootOf(u: StaffUser): { provider: string; sub: string } | null {
  const r = u.identities.find((i) => i.role === 'root' && i.sub !== null);
  return r ? { provider: r.provider, sub: r.sub! } : null;
}

/** The user's shares in the scope's apps: the root's path at key index 0 and at each key index its wallets show. */
async function matchShares(db: HotDb, u: StaffUser, apps: AppRow[], now: number): Promise<SupportShare[]> {
  const root = rootOf(u);
  if (!root || apps.length === 0) return [];
  const indexes = [...new Set([0, ...u.wallets.map((w) => w.keyIndex)])].sort((a, b) => a - b);
  const hashes = await Promise.all(indexes.map(async (k) => ({ k, h: await pathHash(rootPath(u.scopeId, root, k)) })));
  const hexOf = (b: ArrayBuffer | Uint8Array): string => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
  const byHash = new Map(hashes.map(({ k, h }) => [hexOf(h), k]));
  const rows = await db.all<ShareRow>(
    q`SELECT app_id, path_hash, created_at, idle_until, abs_expires_at, revoked_at FROM vault_shares
       WHERE app_id IN (${join(apps.map((a) => q`${a.id}`), ', ')}) AND path_hash IN (${join(hashes.map(({ h }) => q`${h}`), ', ')}) AND abs_expires_at > ${now}
       ORDER BY created_at DESC LIMIT ${SUPPORT_SHARES_MAX}`,
  );
  return rows.map((r) => ({
    appId: r.app_id,
    keyIndex: byHash.get(hexOf(blobOf(r.path_hash))) ?? 0,
    createdAt: r.created_at,
    idleUntil: r.idle_until,
    absExpiresAt: r.abs_expires_at,
    revokedAt: r.revoked_at,
    live: isLive(r, now),
  }));
}

function blobOf(v: unknown): Uint8Array {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (Array.isArray(v)) return Uint8Array.from(v as number[]);
  throw new Error('Expected a BLOB');
}

/** The scope's apps' changes (and the scope's own, e.g. its assignment) since `since`, newest first, by the orgs' index. */
async function scopeChanges(db: HotDb, scopeId: string, apps: AppRow[], orgIds: string[], since: number): Promise<AppChange[]> {
  if (orgIds.length === 0) return [];
  const appIds = apps.map((a) => a.id);
  const about: Q = appIds.length ? q`(scope_id = ${scopeId} OR app_id IN (${join(appIds.map((a) => q`${a}`), ', ')}))` : q`scope_id = ${scopeId}`;
  const rows = await db.all<AppChangeRow>(
    q`SELECT ${raw(APP_CHANGE_COLUMNS)} FROM app_changes WHERE org_id IN (${join(orgIds.map((o) => q`${o}`), ', ')}) AND ${about} AND at >= ${since}
       ORDER BY seq DESC LIMIT ${SUPPORT_CHANGES_MAX}`,
  );
  return rows.map(appChangeView);
}

/** `AdminRpc.supportLookup`: every user the query names, each with its scope's apps, its shares and the apps' changes. */
export async function supportLookup(db: HotDb, i: { query: string; days?: number | undefined }, now: number): Promise<SupportLookupResult> {
  const query = parseSupportQuery(i.query);
  if (!query) return refuse('bad_request', NOT_A_QUERY);
  const since = supportSince(now, i.days ?? SUPPORT_DAYS_DEFAULT);
  // adminFindUsers reads the same three indexed columns (support_code, token_sub, user_id) and gives StaffUser rows.
  const text = query.kind === 'supportId' ? formatSupportId(query.code) : query.kind === 'userId' ? query.userId : query.internalId;
  const { users } = await adminFindUsers(db, { query: text }, now);
  const listed = users.slice(0, SUPPORT_MATCHES_MAX);
  const scopeIds = [...new Set(listed.map((u) => u.scopeId))];
  const apps = await scopeApps(db, scopeIds);
  const matches: SupportMatch[] = [];
  for (const user of listed) {
    const mine = apps.filter((a) => a.scope_id === user.scopeId);
    const orgIds = [...new Set([...(user.orgId ? [user.orgId] : []), ...mine.map((a) => a.org_id)])];
    const [shares, changes] = await Promise.all([matchShares(db, user, mine, now), scopeChanges(db, user.scopeId, mine, orgIds, since)]);
    const appViews: SupportApp[] = mine.map((a) => ({ appId: a.id, name: a.name, orgId: a.org_id, environment: a.environment ?? null, persistence: a.persistence, deletedAt: a.deleted_at }));
    matches.push({ user, apps: appViews, shares, changes });
  }
  return { query, since, matches, truncated: users.length > SUPPORT_MATCHES_MAX };
}
