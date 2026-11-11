// The wallet directory's reads for AdminRpc and ConsoleRpc (D310 point 5, D315). Each call is one SELECT (a page of
// users with their identities and wallets as JSON aggregates), so a ConsoleRpc call stays far inside its hot-DB
// budget (two reads, changes/db.ts).
//
// - Staff (`StaffUser`): every scope; the three ids (User ID `u1_…`, Support ID, internal id `hu_…`, D346);
//   identities with their subs, roles, statuses and identity keys; wallets with their key index and how many other
//   users list the same address. The email is not here: the admin Worker joins each identity's `directoryKey` with
//   D275's DirectoryRpc (the API never reads the issuer).
// - Partners (`PartnerUser`): only users of the org's own scopes (`scopes.org_id`, the same filter every ConsoleRpc
//   query has); the User ID (the identity token's `sub`), Support ID, times, the connected account kinds that are
//   active or pending, the wallet addresses, and the email the user shared with one of the org's live apps (D411:
//   the `granted` rows of migration 0014's `email_consents`, the API's own copy; null when none). An email search is a
//   full address, matched by its MAC among those shared rows only (D315: nothing else can be probed). The SELECT never names `u.user_id` (the internal id), `sub` or
//   `identity_key` as an output column, so no bug in the mapping can hand one out; a page cursor is `lastSeenAt:u1_…`.
import {
  STAFF_USER_EVENTS_MAX,
  type StaffUserEvent,
  type PartnerUser,
  type StaffIdentity,
  type StaffUser,
  type UserSearch,
  type AppNameView,
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

const STAFF_COLUMNS = raw(`u.user_id, u.token_sub, u.support_code, u.scope_id, s.org_id, u.created_at, u.last_seen_at,
  (SELECT json_group_array(json_object('provider', i.provider, 'sub', i.sub, 'identity_key', i.identity_key, 'role', i.role, 'status', i.status,
     'effective_at', i.effective_at, 'first_seen_at', i.first_seen_at, 'observed_at', i.observed_at))
     FROM end_user_identities i WHERE i.user_id = u.user_id) AS identities_json,
  (SELECT json_group_array(json_object('chain', w.chain, 'address', w.address, 'key_index', w.key_index, 'first_seen_at', w.first_seen_at,
     'last_used_at', w.last_used_at,
     'shared', (SELECT COUNT(*) FROM end_user_wallets x WHERE x.chain = w.chain AND x.address = w.address AND x.user_id <> w.user_id)))
     FROM end_user_wallets w WHERE w.user_id = u.user_id) AS wallets_json`);

// Partners: no internal id (`u.user_id` is only ever joined on, never selected), no sub, no identity key, no key index;
// only active or pending identities.
// D411: the shared copies, only of the org's live apps in the user's scope (`s` is the org's scope row).
const SHARED = `FROM email_consents c JOIN apps a ON a.id = c.app_id AND a.org_id = s.org_id AND a.scope_id = u.scope_id AND a.deleted_at IS NULL
     WHERE c.user_sub = u.token_sub AND c.state = 'granted'`;
const PARTNER_COLUMNS = raw(`u.token_sub, u.support_code, u.scope_id, u.created_at, u.last_seen_at,
  (SELECT c.email ${SHARED} ORDER BY c.decided_at DESC, c.app_id LIMIT 1) AS email,
  (SELECT json_group_array(json_object('provider', i.provider, 'status', i.status, 'effective_at', i.effective_at, 'role', i.role))
     FROM end_user_identities i WHERE i.user_id = u.user_id AND i.status IN ('active', 'pending')) AS identities_json,
  (SELECT json_group_array(json_object('chain', w.chain, 'address', w.address, 'first_seen_at', w.first_seen_at, 'last_used_at', w.last_used_at))
     FROM end_user_wallets w WHERE w.user_id = u.user_id) AS wallets_json`);

// Ties by the User ID, so a page cursor (`lastSeenAt:u1_…`) names no internal id.
const ORDER = raw(' ORDER BY u.last_seen_at DESC, u.token_sub DESC');

interface Row {
  /** Partner rows: the latest shared address (D411), or null. */
  email?: string | null;
  /** getUser only: every shared address, per app. */
  emails_json?: string;
  token_sub: string;
  support_code: string;
  scope_id: string;
  org_id?: string | null;
  created_at: number;
  last_seen_at: number;
  identities_json: string;
  wallets_json: string;
}

/** A staff row also carries the internal id; a partner row never selects it. */
interface StaffRow extends Row {
  user_id: string;
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

/** Stellar, EVM, then NEAR (D755), each chain's addresses in order. */
const CHAIN_ORDER: Record<string, number> = { stellar: 0, evm: 1, near: 2 };
const byWallet = (a: { chain: string; address: string }, b: { chain: string; address: string }) =>
  a.chain === b.chain ? (a.address < b.address ? -1 : 1) : (CHAIN_ORDER[a.chain] ?? 9) - (CHAIN_ORDER[b.chain] ?? 9);
const ROLE_ORDER = { root: 0, member: 1 } as const;

export function staffUser(r: StaffRow, now: number): StaffUser {
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
    userId: r.token_sub,
    supportId: formatSupportId(r.support_code),
    internalId: r.user_id,
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
  const user: PartnerUser = { userId: r.token_sub, supportId: formatSupportId(r.support_code), scopeId: r.scope_id, createdAt: r.created_at, lastSeenAt: r.last_seen_at, accounts, wallets, email: typeof r.email === 'string' ? r.email : null };
  if (r.emails_json !== undefined) {
    user.emails = list(r.emails_json)
      .map((e) => ({ appId: String(e.app_id), appName: String(e.app_name), email: String(e.email), sharedAt: n(e.decided_at) }))
      .sort((a, b) => b.sharedAt - a.sharedAt || (a.appId < b.appId ? -1 : 1));
  }
  return user;
}

/** `lastSeenAt:userId` (the User ID, `u1_…`) of the page's last row, when the page is full. */
function nextCursor(rows: Row[], limit: number): string | null {
  const last = rows.at(-1);
  return rows.length === limit && last ? `${last.last_seen_at}:${last.token_sub}` : null;
}

function afterCursor(cursor: string | undefined): Q | null {
  if (!cursor) return null;
  const at = cursor.indexOf(':');
  const seen = Number(cursor.slice(0, at));
  const id = cursor.slice(at + 1);
  return q`(u.last_seen_at < ${seen} OR (u.last_seen_at = ${seen} AND u.token_sub < ${id}))`;
}

const NOT_A_SEARCH = 'search: not a wallet address, user id or Support ID';

/**
 * The search's WHERE clause; refused (`bad_request`) when the string names nothing or an address that isn't one, and,
 * unless `staff`, for an internal id or a sub (parseUserSearch gives a partner neither; this is the second lock).
 */
function searchClause(s: UserSearch | null, opts: { staff: boolean; provider?: string; emailMac?: Uint8Array | null }): Q {
  if (!s) return refuse('bad_request', NOT_A_SEARCH);
  switch (s.kind) {
    case 'address': {
      const address = canonicalWalletAddress(s.chain, s.address);
      if (!address) return refuse('bad_request', 'search: not a valid address');
      return q`u.user_id IN (SELECT user_id FROM end_user_wallets WHERE chain = ${s.chain} AND address = ${address})`;
    }
    case 'userId':
      return q`u.token_sub = ${s.userId}`;
    case 'supportId':
      return q`u.support_code = ${s.code}`;
    case 'internalId':
      return opts.staff ? q`u.user_id = ${s.internalId}` : refuse('bad_request', NOT_A_SEARCH);
    case 'email':
      // Partners only, and only an address shared with one of the org's live apps (the MAC of the full address).
      if (opts.staff) return refuse('bad_request', NOT_A_SEARCH);
      if (!opts.emailMac) return refuse('bad_request', 'search: email search is unavailable');
      return q`EXISTS (SELECT 1 FROM email_consents c JOIN apps a ON a.id = c.app_id AND a.org_id = s.org_id AND a.scope_id = u.scope_id AND a.deleted_at IS NULL
        WHERE c.user_sub = u.token_sub AND c.state = 'granted' AND c.email_mac = ${opts.emailMac.slice().buffer as ArrayBuffer})`;
    case 'sub':
      if (!opts.staff) return refuse('bad_request', NOT_A_SEARCH);
      return opts.provider
        ? q`u.user_id IN (SELECT user_id FROM end_user_identities WHERE sub = ${s.sub} AND provider = ${opts.provider})`
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
  const rows = await db.all<StaffRow>(
    q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id${where([
      i.orgId ? q`s.org_id = ${i.orgId}` : null,
      i.scopeId ? q`u.scope_id = ${i.scopeId}` : null,
      afterCursor(i.cursor),
    ])}${ORDER} LIMIT ${limit}`,
  );
  return { users: rows.map((r) => staffUser(r, now)), nextCursor: nextCursor(rows, limit) };
}

/** One user by its User ID (`u1_…`) or its internal id (`hu_…`), exactly one given (the input schema checks it). */
export async function adminGetUser(db: HotDb, id: { userId?: string | undefined; internalId?: string | undefined }, now: number): Promise<StaffUser> {
  const by = id.userId !== undefined ? q`u.token_sub = ${id.userId}` : id.internalId !== undefined ? q`u.user_id = ${id.internalId}` : refuse('bad_request', 'Give userId or internalId');
  const row = await db.first<StaffRow>(q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id WHERE ${by}`);
  if (!row) return refuse('not_found', 'No such user');
  const [user] = await withEvents(db, [staffUser(row, now)]);
  return user!;
}

/**
 * The users with their `events` (D428, D430): each user's own rows (by internal id), newest first, at most
 * STAFF_USER_EVENTS_MAX **of each kind**, so no number of reported signatures can push a key export out of the staff
 * view (the security review of 2026-11-06). One read for all of them (ROW_NUMBER per user and kind). A missing table
 * (migration 0013 not applied) or a failed read leaves `events` empty, so the Users screen never breaks on it.
 */
export async function withEvents(db: HotDb, users: StaffUser[]): Promise<StaffUser[]> {
  if (users.length === 0) return users;
  const ids = users.map((u) => q`${u.internalId}`);
  let rows: { kind: string; app_id: string | null; user_id: string; chain: string | null; network: string | null; address: string | null; usd_micros: number | null; at: number }[];
  try {
    rows = await db.all(
      q`SELECT kind, app_id, user_id, chain, network, address, usd_micros, at FROM (
          SELECT e.*, ROW_NUMBER() OVER (PARTITION BY e.user_id, e.kind ORDER BY e.at DESC, e.id DESC) AS rn
            FROM user_events e WHERE e.user_id IN (${join(ids, ', ')})
        ) WHERE rn <= ${STAFF_USER_EVENTS_MAX} ORDER BY at DESC`,
    );
  } catch {
    return users.map((u) => ({ ...u, events: [] }));
  }
  return users.map((u) => {
    const events: StaffUserEvent[] = rows
      .filter((r) => r.user_id === u.internalId)
      .map((r) => ({
        kind: r.kind === 'key_exported' ? 'key_exported' : 'mainnet_signature',
        appId: r.app_id,
        chain: r.chain === 'stellar' || r.chain === 'evm' || r.chain === 'near' ? r.chain : null,
        network: r.network,
        address: r.address,
        usdMicros: r.usd_micros,
        at: r.at,
      }));
    return { ...u, events };
  });
}

/**
 * Staff search: a wallet address (every user listing it), a User ID, an internal id, a Support ID (every user whose
 * User ID starts with those 40 bits: they collide rarely, and the scope tells them apart), or a sub (`provider`
 * narrows it, and makes the query a sub whatever it looks like). At most USER_FIND_MAX, newest first.
 */
export async function adminFindUsers(db: HotDb, i: { query: string; provider?: string }, now: number): Promise<{ users: StaffUser[] }> {
  const s: UserSearch | null = i.provider ? (i.query.trim() && !/\s/u.test(i.query.trim()) ? { kind: 'sub', sub: i.query.trim() } : null) : parseUserSearch(i.query, { staff: true });
  const clause = searchClause(s, i.provider ? { staff: true, provider: i.provider } : { staff: true });
  const rows = await db.all<StaffRow>(q`SELECT ${STAFF_COLUMNS} FROM end_users u LEFT JOIN scopes s ON s.scope_id = u.scope_id WHERE ${clause}${ORDER} LIMIT ${USER_FIND_MAX}`);
  return { users: await withEvents(db, rows.map((r) => staffUser(r, now))) };
}

/**
 * The Users screen's app labels (C8b): one SELECT over the ids given (unknown ids are left out), deleted apps included.
 * Staff only (AdminRpc.appNames): the directory names apps by id, and getApp needs the org it doesn't know.
 */
export async function adminAppNames(db: HotDb, appIds: readonly string[]): Promise<AppNameView[]> {
  const ids = [...new Set(appIds)];
  const rows = await db.all<{ id: string; name: string; org_id: string; scope_id: string; environment: string | null; deleted_at: number | null }>(
    q`SELECT a.id, a.name, a.org_id, a.scope_id, s.environment, a.deleted_at FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id IN (${join(ids.map((id) => q`${id}`), ', ')}) ORDER BY a.id`,
  );
  return rows.map((r) => ({ id: r.id, name: r.name, orgId: r.org_id, scopeId: r.scope_id, environment: r.environment === 'test' || r.environment === 'live' ? r.environment : null, deletedAt: r.deleted_at ?? null }));
}

// ---- partners ----

const ORG_USERS = (orgId: string): Q => q`FROM end_users u JOIN scopes s ON s.scope_id = u.scope_id AND s.org_id = ${orgId}`;

/** The MAC of a partner's email search (identity/email.ts searchMac), or null when the env has no consent key. */
export type EmailSearchMac = (term: string) => Promise<Uint8Array | null>;

export async function consoleListUsers(
  db: HotDb,
  i: { orgId: string; scopeId?: string; search?: string; cursor?: string; limit?: number },
  now: number,
  macOf: EmailSearchMac = async () => null,
): Promise<{ users: PartnerUser[]; nextCursor: string | null }> {
  const limit = i.limit ?? USER_PAGE_DEFAULT;
  const search = i.search !== undefined ? parseUserSearch(i.search, { staff: false }) : null;
  const emailMac = search?.kind === 'email' ? await macOf(search.email) : null;
  const rows = await db.all<Row>(
    q`SELECT ${PARTNER_COLUMNS} ${ORG_USERS(i.orgId)}${where([
      i.scopeId ? q`u.scope_id = ${i.scopeId}` : null,
      // A wallet address, a User ID, a Support ID or a shared address; an internal id or a sub is `bad_request`.
      i.search !== undefined ? searchClause(search, { staff: false, emailMac }) : null,
      afterCursor(i.cursor),
    ])}${ORDER} LIMIT ${limit}`,
  );
  return { users: rows.map((r) => partnerUser(r, now)), nextCursor: nextCursor(rows, limit) };
}

export async function consoleGetUser(db: HotDb, i: { orgId: string; userId: string }, now: number): Promise<PartnerUser> {
  const emails = raw(`(SELECT json_group_array(json_object('app_id', c.app_id, 'app_name', a.name, 'email', c.email, 'decided_at', c.decided_at)) ${SHARED}) AS emails_json`);
  const row = await db.first<Row>(q`SELECT ${PARTNER_COLUMNS}, ${emails} ${ORG_USERS(i.orgId)} WHERE u.token_sub = ${i.userId}`);
  // Another org's user is the same `not_found` as no user: a partner learns nothing about other orgs' users.
  return row ? partnerUser(row, now) : refuse('not_found', 'No such user');
}
