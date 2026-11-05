// The Support ID lookup (batch C15; D96, D144, D276 as amended by D346, D384–D387; docs/batch-c-spec.md "Support ID
// lookup"): what the API's `AdminRpc.supportLookup` / `userShares`, the admin Worker's `POST /api/support/lookup` and the
// CLI's `admin <env> support:lookup` agree on. Staff only: no partner reaches any of it (the partner console shows a
// user's Support ID, never a lookup, D310, D346).
//
// A lookup starts from what a user or a partner can hand staff: the Support ID (`HANA-XXXX-XXXX`, any case, with or
// without the prefix and dashes), the User ID (`u1_…`, the identity token's `sub`), or, for staff, the internal id
// (`hu_…`). It resolves through the wallet directory (`end_users.support_code`, `token_sub`, `user_id`; D312, D346):
// every user whose code matches is listed (40 bits collide rarely; the app the partner names tells them apart). For each
// match:
//
//   - the directory's user: its three ids, identities (with subs, for the email join) and wallets (`StaffUser`);
//   - the scope's apps, and the user's vault shares in them that haven't expired (`vault_shares` by app and
//     sha256(path), the account root's path at each key index the user's wallets show, and 0);
//   - the scope's apps' policy and setting changes (`app_changes`) over the window;
//   - from the usage ledger (Neon, as `usage_admin`), the user's ok `login`, `session` and `derive` events by uid (the
//     internal id's 16 bytes) over the window, at most SUPPORT_ACTIVITY_MAX, newest first;
//
// and, for the request IDs the escalation gives, those ledger events whatever their outcome (the ledger keeps a uid on
// ok events only, by design, so errors can't be listed per user), each marked whether it carries one of the matches'
// uids. Consents aren't shown: they live only in the vault's browser storage (D23).
//
// Never in any answer: a uid's bytes, an email address (the admin screen joins the issuer's directory itself through
// DirectoryRpc, after C8b), a share id, a session key or a counter.
import { z } from 'zod';
import { ctx, requestId } from './types.ts';
import type { AppChange } from './types.ts';
import { type StaffUser, parseUserSearch, uidOfInternalId } from './users.ts';

/** Request IDs one lookup may name. */
export const SUPPORT_REQUEST_IDS_MAX = 20;
/** The activity window: 30 days by default, up to the 24 months the ledger keeps a uid (D90). */
export const SUPPORT_DAYS_DEFAULT = 30;
export const SUPPORT_DAYS_MAX = 731;
/** Ledger events listed per match, newest first. */
export const SUPPORT_ACTIVITY_MAX = 400;
/** Matches resolved in full (a 40-bit code shared by more is a sign of something else: `truncated`). */
export const SUPPORT_MATCHES_MAX = 10;
/** app_changes rows per match's scope, newest first. */
export const SUPPORT_CHANGES_MAX = 50;
/** Vault shares listed per match. */
export const SUPPORT_SHARES_MAX = 100;
/** Ledger events listed for the request IDs (an id can carry more than one row only across a retry at another time). */
export const SUPPORT_REQUEST_ROWS_MAX = 100;
const DAY_MS = 86_400_000;

/** What a lookup starts from: a Support ID's stored code, a User ID or an internal id. */
export type SupportQuery = { kind: 'supportId'; code: string } | { kind: 'userId'; userId: string } | { kind: 'internalId'; internalId: string };

/**
 * A Support ID (any case; `HANA-` and dashes optional, as console-core's parseSupportId reads it), a User ID (`u1_…`,
 * exact case) or an internal id (`hu_…`, any case). Null for anything else: a wallet address or a sub goes to the
 * user search first (`AdminRpc.findUsers`), and the lookup then takes the User ID it gives.
 */
export function parseSupportQuery(input: string): SupportQuery | null {
  const s = parseUserSearch(input, { staff: true });
  if (!s) return null;
  if (s.kind === 'supportId') return { kind: 'supportId', code: s.code };
  if (s.kind === 'userId') return { kind: 'userId', userId: s.userId };
  if (s.kind === 'internalId') return { kind: 'internalId', internalId: s.internalId };
  return null;
}

/** The start of a lookup's window. */
export const supportSince = (now: number, days: number = SUPPORT_DAYS_DEFAULT): number => now - days * DAY_MS;

const days = z.number().int().min(1).max(SUPPORT_DAYS_MAX);
const query = z.string().min(1).max(64);

/** `AdminRpc.supportLookup`: the directory, shares and app changes of every user the query names. */
export const supportLookupInput = ctx.extend({ query, days: days.optional() }).strict();
export type SupportLookupInput = z.infer<typeof supportLookupInput>;

/** `AdminRpc.userShares`: the vault shares of one path in one app that haven't expired (the spec's planned method). */
export const userSharesInput = ctx.extend({ appId: z.string().min(1).max(64), path: z.string().min(3).max(512) }).strict();
export type UserSharesInput = z.infer<typeof userSharesInput>;

/** The staff ticket a lookup is recorded under (the support reference or a short reason; never an address). */
export const supportTicket = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[\x20-\x7e]+$/u, 'printable ASCII')
  .refine((t) => !t.includes('@'), 'no email address: the ticket is stored')
  .refine((t) => t.trim() === t, 'no leading or trailing space');

/** The admin Worker's `POST /api/support/lookup` body (the staff screen's call, after C8b). */
export const supportLookupBody = z
  .object({ query, ticket: supportTicket, requestIds: z.array(requestId).max(SUPPORT_REQUEST_IDS_MAX).optional(), days: days.optional() })
  .strict();
export type SupportLookupBody = z.infer<typeof supportLookupBody>;

// ---- answers ----

export interface SupportApp {
  appId: string;
  name: string;
  orgId: string;
  /** The scope's environment, or null for a scope the hot DB has no row for. */
  environment: 'test' | 'live' | null;
  /** 'session' keeps the wallet across reloads through a vault share; 'none' never stores one. */
  persistence: 'session' | 'none';
  deletedAt: number | null;
}

/** One vault share (no share id, session key or counter): live while not revoked and before both limits. */
export interface SupportShare {
  appId: string;
  keyIndex: number;
  createdAt: number;
  idleUntil: number;
  absExpiresAt: number;
  revokedAt: number | null;
  live: boolean;
}

/** `AdminRpc.userShares`' rows (the planned shape, D276). */
export interface UserShare {
  createdAt: number;
  idleUntil: number;
  absExpiresAt: number;
  revokedAt: number | null;
}

export interface SupportMatch {
  user: StaffUser;
  apps: SupportApp[];
  shares: SupportShare[];
  /** The scope's apps' changes in the window, newest first, at most SUPPORT_CHANGES_MAX. */
  changes: AppChange[];
}

/** `AdminRpc.supportLookup`'s answer. */
export interface SupportLookupResult {
  query: SupportQuery;
  since: number;
  matches: SupportMatch[];
  /** More users share the code than SUPPORT_MATCHES_MAX: the first ones (newest first by last seen) are listed. */
  truncated: boolean;
}

/** One ok ledger event of a match (by its uid): what the user did, never the uid. */
export interface SupportActivity {
  requestId: string;
  at: number;
  appId: string | null;
  endpoint: 'login' | 'session' | 'derive';
  status: number;
  latencyMs: number;
  relayed: boolean;
  nearTx: string | null;
}

/** One ledger event of a request ID the escalation named, whatever its outcome. */
export interface SupportRequestEvent {
  requestId: string;
  at: number;
  orgId: string;
  appId: string | null;
  scopeId: string;
  endpoint: string;
  outcome: 'ok' | 'rejected' | 'error';
  code: string | null;
  status: number;
  latencyMs: number;
  relayed: boolean;
  nearTx: string | null;
  /** The event carries the uid of one of the lookup's matches (only an ok login, session or derive can). */
  byMatch: boolean;
}

/** Whether the ledger part could be read: without it the directory part still answers. */
export type SupportLedgerState = { available: true } | { available: false; reason: string };

/** What the ledger adds to a lookup (withSupportLedger). */
export interface SupportLedgerPart {
  days: number;
  ledger: SupportLedgerState;
  /** Per match, in the same order: its ledger events, or null when the ledger is unavailable. */
  activity: (SupportActivity[] | null)[];
  /** The request IDs' events (empty without request IDs), or null when the ledger is unavailable. */
  requests: SupportRequestEvent[] | null;
  /** The request IDs the ledger has no event for (an unknown id, a gate rejection, or capture off then). */
  requestsNotFound: string[];
}

/** The whole lookup, as the admin Worker's route gives it (`support:lookup --json` has the CLI's user rows instead). */
export type SupportLookupView = SupportLookupResult & SupportLedgerPart;

export const LEDGER_UNAVAILABLE = 'ledger unavailable';

// ---- the ledger's reads (usage_admin; the admin Worker's USAGE_DB and the CLI's .secrets/<env>/neon-usage-admin.url) ----

/**
 * The ok login, session and derive events of one uid since a time, newest first: `events_uid_at` (Neon 0007, D362).
 * $1 the uid as 32 hex characters, $2 the window's start (timestamptz), $3 the row limit.
 */
export const SUPPORT_ACTIVITY_SQL =
  "SELECT request_id, at, app_id, endpoint, status, latency_ms, relayed, near_tx FROM usage.events WHERE uid = decode($1, 'hex') AND at >= $2::timestamptz AND outcome = 'ok' AND endpoint IN ('login', 'session', 'derive') ORDER BY at DESC LIMIT $3";

/**
 * Every event of these request IDs (the primary key's leading column), newest first, each with whether its uid is one
 * of $2's (hex); the uid itself is never selected. $1 text[] of request IDs, $2 text[] of hex uids, $3 the row limit.
 */
export const SUPPORT_REQUESTS_SQL =
  "SELECT request_id, at, org_id, app_id, scope_id, endpoint, outcome, code, status, latency_ms, relayed, near_tx, COALESCE(uid = ANY (ARRAY(SELECT decode(x, 'hex') FROM unnest($2::text[]) AS x)), false) AS by_match FROM usage.events WHERE request_id = ANY ($1::text[]) ORDER BY at DESC LIMIT $3";

const msOf = (v: unknown): number => {
  const t = v instanceof Date ? v.getTime() : new Date(String(v)).getTime();
  if (!Number.isFinite(t)) throw new TypeError('support lookup: malformed time');
  return t;
};
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export function supportActivityOf(r: Record<string, unknown>): SupportActivity {
  return {
    requestId: String(r.request_id),
    at: msOf(r.at),
    appId: strOrNull(r.app_id),
    endpoint: String(r.endpoint) as SupportActivity['endpoint'],
    status: Number(r.status),
    latencyMs: Number(r.latency_ms),
    relayed: r.relayed === true,
    nearTx: strOrNull(r.near_tx),
  };
}

export function supportRequestOf(r: Record<string, unknown>): SupportRequestEvent {
  return {
    requestId: String(r.request_id),
    at: msOf(r.at),
    orgId: String(r.org_id),
    appId: strOrNull(r.app_id),
    scopeId: String(r.scope_id),
    endpoint: String(r.endpoint),
    outcome: String(r.outcome) as SupportRequestEvent['outcome'],
    code: strOrNull(r.code),
    status: Number(r.status),
    latencyMs: Number(r.latency_ms),
    relayed: r.relayed === true,
    nearTx: strOrNull(r.near_tx),
    byMatch: r.by_match === true,
  };
}

/** The uid (32 hex characters) of an internal id, for the ledger's parameters; a TypeError for anything else. */
export function uidHexOfInternalId(internalId: string): string {
  const bytes = uidOfInternalId(internalId);
  if (!bytes) throw new TypeError('Not an internal id');
  let s = '';
  for (const b of bytes) s += b.toString(16).padStart(2, '0');
  return s;
}

/** What a ledger reader must give the lookup: the two reads above, over one connection. */
export interface SupportLedgerReader {
  activity(uidHex: string, since: number, limit: number): Promise<SupportActivity[]>;
  requests(requestIds: string[], uidHexes: string[], limit: number): Promise<SupportRequestEvent[]>;
}

/** The two reads over a `query(sql, params)` function (pg in the Worker, PGlite in tests, the CLI's client). */
export function sqlSupportLedger(query: (sql: string, params: unknown[]) => Promise<Record<string, unknown>[]>): SupportLedgerReader {
  return {
    async activity(uidHex, since, limit) {
      return (await query(SUPPORT_ACTIVITY_SQL, [uidHex, new Date(since).toISOString(), limit])).map(supportActivityOf);
    },
    async requests(requestIds, uidHexes, limit) {
      if (requestIds.length === 0) return [];
      return (await query(SUPPORT_REQUESTS_SQL, [requestIds, uidHexes, limit])).map(supportRequestOf);
    },
  };
}

/**
 * The ledger part of a lookup, added to the directory part: each match's activity and the request IDs' events. A null
 * reader (no binding, no connection) or a failed read gives `ledger: {available: false, reason}` and nulls, never a
 * guess: the directory part still answers.
 */
export async function withSupportLedger<R extends { since: number; matches: { user: { internalId: string } }[] } = SupportLookupResult>(
  result: R,
  o: { days: number; requestIds: readonly string[]; reader: SupportLedgerReader | null; unavailable?: string },
): Promise<R & SupportLedgerPart> {
  const requestIds = [...new Set(o.requestIds)];
  const base = { ...result, days: o.days };
  const down = (reason: string): R & SupportLedgerPart => ({ ...base, ledger: { available: false, reason }, activity: result.matches.map(() => null), requests: null, requestsNotFound: [] });
  if (!o.reader) return down(o.unavailable ?? LEDGER_UNAVAILABLE);
  try {
    const uids = result.matches.map((m) => uidHexOfInternalId(m.user.internalId));
    const activity = await Promise.all(uids.map((u) => o.reader!.activity(u, result.since, SUPPORT_ACTIVITY_MAX)));
    const requests = await o.reader.requests(requestIds, uids, SUPPORT_REQUEST_ROWS_MAX);
    const seen = new Set(requests.map((r) => r.requestId));
    return { ...base, ledger: { available: true }, activity, requests, requestsNotFound: requestIds.filter((id) => !seen.has(id)) };
  } catch {
    return down(`${LEDGER_UNAVAILABLE}: the read failed`);
  }
}
