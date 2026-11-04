// The wallet directory's reads for AdminRpc and ConsoleRpc (D310 point 5, D315). Each call is one SELECT (a page of
// users with their identities and wallets as JSON aggregates), so a ConsoleRpc call stays far inside its hot-DB
// budget (two reads, changes/db.ts).
//
// - Staff (`StaffUser`): every scope; identities with their subs, roles, statuses and identity keys; wallets with
//   their key index and how many other users list the same address. The email is not here: the admin Worker joins
//   each identity's `directoryKey` with D275's DirectoryRpc (the API never reads the issuer).
// - Partners (`PartnerUser`): only users of the org's own scopes (`scopes.org_id`, the same filter every ConsoleRpc
//   query has); the user id, Support ID, times, the connected account kinds that are active or pending, and the
//   wallet addresses. The SELECT never names `sub` or `identity_key`, so no bug in the mapping can hand one out.
import {
  type PartnerUser,
  type StaffIdentity,
  type StaffUser,
  type UserSearch,
  type WalletChain,
  formatSupportId,
  parseUserSearch,
} from '@hana-id/console-core';
import { canonicalWalletAddress } from '@hana-id/core/identity';
import { refuse } from '../changes/cas.ts';
import type { HotDb } from '../changes/db.ts';
import { type Q, join, q, raw } from '../changes/sql.ts';

export const USER_PAGE_DEFAULT = 50;
export const USER_FIND_MAX = 50;

const STAFF_COLUMNS = raw(`u.user_id, u.support_code, u.scope_id, s.org_id, u.created_at, u.last_seen_at,
  (SELECT json_group_array(json_object('provider', i.provider, 'sub', i.sub, 'identity_key', i.identity_key, 'role', i.role, 'status', i.status,
     'effective_at', i.effective_at, 'first_seen_at', i.first_seen_at, 'observed_at', i.observed_at))
     FROM end_user_identities i WHERE i.user_id = u.user_id) AS identities_json,
  (SELECT json_group_array(json_object('chain', w.chain, 'address', w.address, 'key_index', w.key_index, 'first_seen_at', w.first_seen_at,
     'last_used_at', w.last_used_at,
     'shared', (SELECT COUNT(*) FROM end_user_wallets x WHERE x.chain = w.chain AND x.address = w.address AND x.user_id <> w.user_id)))
     FROM end_user_wallets w WHERE w.user_id = u.user_id) AS wallets_json`);

// Partners: no sub, no identity key, no key index; only active or pending identities.
const PARTNER_COLUMNS = raw(`u.user_id, u.support_code, u.scope_id, u.created_at, u.last_seen_at,
  (SELECT json_group_array(json_object('provider', i.provider, 'status', i.status, 'effective_at', i.effective_at, 'role', i.role))
     FROM end_user_identities i WHERE i.user_id = u.user_id AND i.status IN ('active', 'pending')) AS identities_json,
  (SELECT json_group_array(json_object('chain', w.chain, 'address', w.address, 'first_seen_at', w.first_seen_at, 'last_used_at', w.last_used_at))
     FROM end_user_wallets w WHERE w.user_id = u.user_id) AS wallets_json`);

const ORDER = raw(' ORDER BY u.last_seen_at DESC, u.user_id DESC');

interface Row {
  user_id: string;
  support_code: string;
  scope_id: string;
  org_id?: string | null;
  created_at: number;
  last_seen_at: number;
  identities_json: string;
  wallets_json: string;
}

type Json = Record<string, unknown>;
const list = (s: string): Json[] => (JSON.parse(s || '[]') as Json[]).filter((x) => x !== null);
const n = (v: unknown): number => v as number;
const nOrNull = (v: unknown): number | null => (typeof v === 'number' ? v : null);

/** A stored member status as of `now`: a pending link whose activation time has passed is active. */
export function statusAt(status: string, effectiveAt: number | null, now: number): StaffIdentity['status'] {
  if (status === 'pending' && effectiveAt !== null && effectiveAt <= now) return 'active';
  return status as StaffIdentity['status'];
}

const byWallet = (a: { chain: string; address: string }, b: { chain: string; address: string }) => (a.chain === b.chain ? (a.address < b.address ? -1 : 1) : a.chain === 'stellar' ? -1 : 1);
const ROLE_ORDER = { root: 0, member: 1 } as const;

export function staffUser(r: Row, now: number): StaffUser {
  const identities = list(r.identities_json)
    .map((i): StaffIdentity => {
      const sub = typeof i.sub === 'string' ? i.sub : null;
      const provider = String(i.provider);
      const effectiveAt = nOrNull(i.effective_at);
      return {
        provider,
        sub,
        identityKey: String(i.identity_key),
        role: i.role === 'member' ? 'member' : 'root',
        status: statusAt(String(i.status), effectiveAt, now),
        effectiveAt,
        firstSeenAt: n(i.first_seen_at),
        observedAt: n(i.observed_at),
        directoryKey: sub === null ? null : { provider, sub },
      };
    })
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || a.firstSeenAt - b.firstSeenAt);
  const wallets = list(r.wallets_json)
    .map((w) => ({ chain: w.chain as WalletChain, address: String(w.address), keyIndex: n(w.key_index), firstSeenAt: n(w.first_seen_at), lastUsedAt: n(w.last_used_at), sharedWith: n(w.shared) }))
    .sort(byWallet);
  return {
    userId: r.user_id,
    supportId: formatSupportId(r.support_code),
    scopeId: r.scope_id,
    orgId: r.org_id ?? null,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    identities,
    wallets,
  };
}

export function partnerUser(r: Row, now: number): PartnerUser {
  const accounts = list(r.identities_json)
    .map((i) => ({ kind: String(i.provider), status: statusAt(String(i.status), nOrNull(i.effective_at), now) as 'active' | 'pending', root: i.role === 'root' }))
    .sort((a, b) => Number(b.root) - Number(a.root) || (a.kind < b.kind ? -1 : 1))
    .map(({ kind, status }) => ({ kind, status }));
  const wallets = list(r.wallets_json)
    .map((w) => ({ chain: w.chain as WalletChain, address: String(w.address), firstSeenAt: n(w.first_seen_at), lastUsedAt: n(w.last_used_at) }))
    .sort(byWallet);
  return { userId: r.user_id, supportId: formatSupportId(r.support_code), scopeId: r.scope_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, accounts, wallets };
}

/** `lastSeenAt:userId` of the page's last row, when the page is full. */
function nextCursor(rows: Row[], limit: number): string | null {
  const last = rows.at(-1);
  return rows.length === limit && last ? `${last.last_seen_at}:${last.user_id}` : null;
}

function afterCursor(cursor: string | undefined): Q | null {
  if (!cursor) return null;
  const at = cursor.indexOf(':');
  const seen = Number(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return q`(u.last_seen_at < ${seen} OR (u.last_seen_at = ${seen} AND u.user_id < ${id}))`;
}

/** The search's WHERE clause; refused (`bad_request`) when the string names nothing or an address that isn't one. */
function searchClause(s: UserSearch | null, provider?: string): Q {
  if (!s) return refuse('bad_request', 'search: not a wallet address, user id or Support ID');
  switch (s.kind) {
    case 'address': {
      const address = canonicalWalletAddress(s.chain, s.address);
      if (!address) return refuse('bad_request', 'search: not a valid address');
      return q`u.user_id IN (SELECT user_id FROM end_user_wallets WHERE chain = ${s.chain} AND address = ${address})`;
    }
    case 'userId':
      return q`u.user_id = ${s.userId}`;
    case 'supportId':
      return q`u.support_code = ${s.code}`;
    case 'sub':
      return provider
        ? q`u.user_id IN (SELECT user_id FROM end_user_identities WHERE sub = ${s.sub} AND provider = ${provider})`
        : q`u.user_id IN (SELECT user_id FROM end_user_identities WHERE sub = ${s.sub})`;
  }
}

const where = (parts: (Q | null)[]): Q => {
  const p = parts.filter((x): x is Q => x !== null);
  return p.length ? q` WHERE ${join(p, ' AND ')}` : raw('');
};

// ---- staff ----

export async function adminListUsers(db: HotDb, i: { orgId?: string; scopeId?: string; cursor?: string; limit?: number }, now: number): Promise<{ users: StaffUser[]; nextCursor: string | null }> {
  const limit = i.limit ?? USER_PAGE_DEFAULT;
  const rows = await db.all<Row>(
    q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id${where([
      i.orgId ? q`s.org_id = ${i.orgId}` : null,
      i.scopeId ? q`u.scope_id = ${i.scopeId}` : null,
      afterCursor(i.cursor),
    ])}${ORDER} LIMIT ${limit}`,
  );
  return { users: rows.map((r) => staffUser(r, now)), nextCursor: nextCursor(rows, limit) };
}

export async function adminGetUser(db: HotDb, userId: string, now: number): Promise<StaffUser> {
  const row = await db.first<Row>(q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id WHERE u.user_id = ${userId}`);
  return row ? staffUser(row, now) : refuse('not_found', 'No such user');
}

/**
 * Staff search: a wallet address (every user listing it), a user id, a Support ID (every user whose id starts with
 * it: 40 bits collide rarely, and the scope tells them apart), or a sub (`provider` narrows it, and makes the query a
 * sub whatever it looks like). At most USER_FIND_MAX, newest first.
 */
export async function adminFindUsers(db: HotDb, i: { query: string; provider?: string }, now: number): Promise<{ users: StaffUser[] }> {
  const s: UserSearch | null = i.provider ? (i.query.trim() && !/\s/u.test(i.query.trim()) ? { kind: 'sub', sub: i.query.trim() } : null) : parseUserSearch(i.query, { allowSub: true });
  const rows = await db.all<Row>(q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id WHERE ${searchClause(s, i.provider)}${ORDER} LIMIT ${USER_FIND_MAX}`);
  return { users: rows.map((r) => staffUser(r, now)) };
}

// ---- partners ----

const ORG_USERS = (orgId: string): Q => q`FROM end_users u JOIN scopes s ON s.scope_id = u.scope_id AND s.org_id = ${orgId}`;

export async function consoleListUsers(
  db: HotDb,
  i: { orgId: string; scopeId?: string; search?: string; cursor?: string; limit?: number },
  now: number,
): Promise<{ users: PartnerUser[]; nextCursor: string | null }> {
  const limit = i.limit ?? USER_PAGE_DEFAULT;
  const rows = await db.all<Row>(
    q`SELECT ${PARTNER_COLUMNS} ${ORG_USERS(i.orgId)}${where([
      i.scopeId ? q`u.scope_id = ${i.scopeId}` : null,
      i.search !== undefined ? searchClause(parseUserSearch(i.search, { allowSub: false })) : null,
      afterCursor(i.cursor),
    ])}${ORDER} LIMIT ${limit}`,
  );
  return { users: rows.map((r) => partnerUser(r, now)), nextCursor: nextCursor(rows, limit) };
}

export async function consoleGetUser(db: HotDb, i: { orgId: string; userId: string }, now: number): Promise<PartnerUser> {
  const row = await db.first<Row>(q`SELECT ${PARTNER_COLUMNS} ${ORG_USERS(i.orgId)} WHERE u.user_id = ${i.userId}`);
  // Another org's user is the same `not_found` as no user: a partner learns nothing about other orgs' users.
  return row ? partnerUser(row, now) : refuse('not_found', 'No such user');
}
