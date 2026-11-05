// admin.ts support:lookup: the Support ID lookup for Hana staff at the terminal (batch C15; D96, D144, D276 as amended
// by D346, D384, D387): the same answer as the admin console's `POST /api/support/lookup` (console-core support.ts),
// read the way `user:find` reads (D316): the wallet directory and the app rows from the API's D1 with the private
// executor (lib/d1.ts apiPrivateD1Execute: a code or an id never goes in a process argument), each identity's address
// from the email issuer's D1 when the env has one, and the usage ledger as `usage_admin` over
// `.secrets/<env>/neon-usage-admin.url` (the uid-erase connection). Without that file, or when Neon doesn't answer, the
// ledger part says "ledger unavailable" and the rest still prints.
//
// For each user the code names (every match: 40 bits collide rarely, the app the partner names tells them apart): its
// ids, identities with their addresses, and wallets; the scope's apps; the vault shares that haven't expired; the apps'
// changes over the window; the user's ok login, session and derive events by uid; and the events of the request IDs
// given (`--request-id`, errors included: the ledger keeps a uid on ok events only). Consents aren't shown (they live
// in the vault's browser storage).
//
// Read only. Like user:find, this is the operator's path (wrangler and Neon credentials of their own), printed to this
// terminal only: never redirect it to a file outside .secrets/. The admin console's path is the audited one (D386).
import { createHash } from 'node:crypto';
import {
  SUPPORT_CHANGES_MAX,
  SUPPORT_DAYS_DEFAULT,
  SUPPORT_DAYS_MAX,
  SUPPORT_MATCHES_MAX,
  SUPPORT_REQUEST_IDS_MAX,
  SUPPORT_SHARES_MAX,
  type SupportLedgerPart,
  type SupportQuery,
  LEDGER_UNAVAILABLE,
  formatSupportId,
  parseSupportQuery,
  sqlSupportLedger,
  supportSince,
  withSupportLedger,
} from '@hana-id/console-core';
import { formatTime } from './admin-lead-times.ts';
import { type WalletUser, formatWalletUser, parseUserRow, parseWalletUserRow, userSubsSql, walletUsersSql } from './admin-users.ts';
import { type Args, CliError } from './cli.ts';
import { sql } from './sql.ts';

const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,128}$/u;

export interface SupportLedgerConn {
  query(sql: string, params: unknown[]): Promise<Record<string, unknown>[]>;
  close(): Promise<void>;
}

export interface SupportCmdDeps {
  /** One read statement on the API's D1, privately (the wallet directory, apps, shares, changes). */
  apiD1: (statement: string) => Promise<Record<string, unknown>[]>;
  /** One read statement on the issuer's D1 (the identities' addresses); null for an env without an email issuer. */
  issuerD1: ((statement: string) => Promise<Record<string, unknown>[]>) | null;
  /** The usage_admin connection; null without `.secrets/<env>/neon-usage-admin.url`. Throws when it can't connect. */
  ledger: () => Promise<SupportLedgerConn | null>;
  /** Where the ledger comes from, for the "unavailable" line (`.secrets/<env>/neon-usage-admin.url`). */
  ledgerFile: string;
  now?: () => number;
  log: (line: string) => void;
  readLine: (prompt: string) => Promise<string>;
}

export interface CliSupportApp {
  appId: string;
  name: string;
  orgId: string;
  environment: 'test' | 'live' | null;
  persistence: string;
  deletedAt: number | null;
}

export interface CliSupportShare {
  appId: string;
  keyIndex: number;
  createdAt: number;
  idleUntil: number;
  absExpiresAt: number;
  revokedAt: number | null;
  live: boolean;
}

export interface CliSupportChange {
  seq: number;
  at: number;
  orgId: string;
  appId: string | null;
  scopeId: string | null;
  kind: string;
  detail: Record<string, unknown>;
  actorKind: string;
  actorId: string;
  requestId: string;
}

export interface CliSupportMatch {
  user: WalletUser;
  apps: CliSupportApp[];
  shares: CliSupportShare[];
  changes: CliSupportChange[];
}

export interface CliSupportLookup {
  query: SupportQuery;
  since: number;
  matches: CliSupportMatch[];
  truncated: boolean;
}

export type CliSupportView = CliSupportLookup & SupportLedgerPart;

const num = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new Error('support lookup: malformed row');
  return n;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const list = (xs: readonly string[]): string => xs.map((x) => sql`${x}`).join(', ');
const sha256Hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/** The scope's apps (deleted ones included). */
export function supportAppsSql(scopeIds: readonly string[]): string {
  return `SELECT a.id, a.name, a.org_id, a.scope_id, s.environment, a.persistence, a.deleted_at FROM apps a LEFT JOIN scopes s ON s.scope_id = a.scope_id WHERE a.scope_id IN (${list(scopeIds)}) ORDER BY a.created_at, a.id`;
}

/** The shares of these path hashes (hex sha256, computed here) in these apps that haven't expired, newest first. */
export function supportSharesSql(appIds: readonly string[], pathHashes: readonly string[], now: number): string {
  for (const h of pathHashes) if (!/^[0-9a-f]{64}$/u.test(h)) throw new Error('A path hash is 64 hex characters');
  return (
    'SELECT app_id, lower(hex(path_hash)) AS path_hash, created_at, idle_until, abs_expires_at, revoked_at FROM vault_shares ' +
    `WHERE app_id IN (${list(appIds)}) AND path_hash IN (${pathHashes.map((h) => `X'${h}'`).join(', ')}) AND abs_expires_at > ${sql`${now}`} ORDER BY created_at DESC LIMIT ${SUPPORT_SHARES_MAX}`
  );
}

/** The scope's apps' changes (and the scope's own) since `since`, newest first, through the orgs' index. */
export function supportChangesSql(scopeId: string, appIds: readonly string[], orgIds: readonly string[], since: number): string {
  const about = appIds.length ? `(scope_id = ${sql`${scopeId}`} OR app_id IN (${list(appIds)}))` : sql`scope_id = ${scopeId}`;
  return `SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id FROM app_changes WHERE org_id IN (${list(orgIds)}) AND ${about} AND at >= ${sql`${since}`} ORDER BY seq DESC LIMIT ${SUPPORT_CHANGES_MAX}`;
}

function parseDetail(text: unknown): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(String(text));
    return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : { value: v };
  } catch {
    return {};
  }
}

/** What a code, User ID or internal id names, as the wallet-directory query takes it; a CliError for anything else. */
export function supportQuery(input: string): SupportQuery {
  const q = parseSupportQuery(input);
  if (!q) throw new CliError('support:lookup takes a Support ID (HANA-XXXX-XXXX, any case, dashes optional), a User ID (u1_…) or an internal id (hu_…); find a wallet or a sub with user:find first');
  return q;
}

/** The lookup's directory and hot-DB part (the CLI's AdminRpc.supportLookup). */
export async function supportDirectory(q: SupportQuery, days: number, deps: Pick<SupportCmdDeps, 'apiD1' | 'issuerD1' | 'now'>): Promise<CliSupportLookup> {
  const now = (deps.now ?? Date.now)();
  const since = supportSince(now, days);
  const users = (await deps.apiD1(walletUsersSql(q))).map((r) => parseWalletUserRow(r, now));
  const listed = users.slice(0, SUPPORT_MATCHES_MAX);
  // The identities' addresses (the issuer's directory), as user:find --user joins them.
  const subs = [...new Set(listed.flatMap((u) => u.identities.map((i) => i.sub)).filter((x): x is string => x !== null))];
  if (deps.issuerD1 && subs.length) {
    const rows = (await deps.issuerD1(userSubsSql(subs))).map(parseUserRow);
    for (const u of listed) for (const i of u.identities) i.directory = rows.filter((r) => r.provider === i.provider && r.sub === i.sub);
  }
  const scopeIds = [...new Set(listed.map((u) => u.scopeId))];
  const appRows = scopeIds.length ? await deps.apiD1(supportAppsSql(scopeIds)) : [];
  const matches: CliSupportMatch[] = [];
  for (const user of listed) {
    const apps: CliSupportApp[] = appRows
      .filter((a) => a.scope_id === user.scopeId)
      .map((a) => ({ appId: String(a.id), name: String(a.name), orgId: String(a.org_id), environment: (a.environment ?? null) as CliSupportApp['environment'], persistence: String(a.persistence), deletedAt: numOrNull(a.deleted_at) }));
    const appIds = apps.map((a) => a.appId);
    const root = user.identities.find((i) => i.role === 'root' && i.sub !== null);
    let shares: CliSupportShare[] = [];
    if (root && appIds.length) {
      const indexes = [...new Set([0, ...user.wallets.map((w) => w.keyIndex)])].sort((a, b) => a - b);
      const byHash = new Map(indexes.map((k) => [sha256Hex(`${user.scopeId}#${root.provider}#${root.sub}#${k}`), k]));
      shares = (await deps.apiD1(supportSharesSql(appIds, [...byHash.keys()], now))).map((r) => {
        const revokedAt = numOrNull(r.revoked_at);
        const idleUntil = num(r.idle_until);
        const absExpiresAt = num(r.abs_expires_at);
        return { appId: String(r.app_id), keyIndex: byHash.get(String(r.path_hash)) ?? 0, createdAt: num(r.created_at), idleUntil, absExpiresAt, revokedAt, live: revokedAt === null && now < idleUntil && now < absExpiresAt };
      });
    }
    const orgIds = [...new Set(apps.map((a) => a.orgId))];
    const changes: CliSupportChange[] = orgIds.length
      ? (await deps.apiD1(supportChangesSql(user.scopeId, appIds, orgIds, since))).map((r) => ({
          seq: num(r.seq),
          at: num(r.at),
          orgId: String(r.org_id),
          appId: r.app_id === null ? null : String(r.app_id),
          scopeId: r.scope_id === null ? null : String(r.scope_id),
          kind: String(r.kind),
          detail: parseDetail(r.detail_json),
          actorKind: String(r.actor_kind),
          actorId: String(r.actor_id),
          requestId: String(r.request_id),
        }))
      : [];
    matches.push({ user, apps, shares, changes });
  }
  return { query: q, since, matches, truncated: users.length > SUPPORT_MATCHES_MAX };
}

/** The ledger part over the usage_admin connection; "ledger unavailable" without one or when it fails. */
export async function supportLedger(r: CliSupportLookup, days: number, requestIds: string[], deps: Pick<SupportCmdDeps, 'ledger' | 'ledgerFile'>): Promise<CliSupportView> {
  let conn: SupportLedgerConn | null = null;
  let unavailable = `${LEDGER_UNAVAILABLE}: no ${deps.ledgerFile} (usage capture off in this env, or usage-setup not run)`;
  try {
    conn = await deps.ledger();
  } catch {
    unavailable = `${LEDGER_UNAVAILABLE}: no connection`;
  }
  try {
    return await withSupportLedger(r, { days, requestIds, reader: conn ? sqlSupportLedger((s, p) => conn!.query(s, p)) : null, unavailable });
  } finally {
    await conn?.close().catch(() => undefined);
  }
}

const shareLine = (s: CliSupportShare, now: number): string =>
  `    ${s.appId} key ${s.keyIndex}  created ${formatTime(s.createdAt)}  ${s.live ? `live, idle until ${formatTime(s.idleUntil)}, ends ${formatTime(s.absExpiresAt)}` : s.revokedAt !== null ? `revoked ${formatTime(s.revokedAt)}` : now >= s.absExpiresAt ? 'ended' : `idle since ${formatTime(s.idleUntil)}`}`;

/** The lookup for the terminal. */
export function formatSupportView(v: CliSupportView, now: number): string[] {
  const what = v.query.kind === 'supportId' ? formatSupportId(v.query.code) : v.query.kind === 'userId' ? v.query.userId : v.query.internalId;
  const lines = [`${v.matches.length} user${v.matches.length === 1 ? '' : 's'} for ${what}, the last ${v.days} days (from ${formatTime(v.since)})${v.truncated ? `: the first ${SUPPORT_MATCHES_MAX}, more share this code` : ''}`];
  if (v.matches.length > 1) lines.push('More than one user has this code (40 bits): the app the partner names tells them apart.');
  if (v.matches.length === 0) lines.push('No user with it in the wallet directory: a user who hasn’t logged in since the directory’s deploy has no resolvable code. Ask the partner for the User ID (u1_…) or a wallet address (user:find).');
  if (!v.ledger.available) lines.push(`Usage ledger: ${v.ledger.reason}.`);
  for (const [n, m] of v.matches.entries()) {
    lines.push('');
    lines.push(...formatWalletUser(m.user));
    lines.push(`  apps      ${m.apps.length ? m.apps.map((a) => `${a.appId} "${a.name}" (${a.environment ?? '?'}, ${a.persistence}${a.deletedAt !== null ? `, deleted ${formatTime(a.deletedAt)}` : ''})`).join('; ') : 'none in this scope'}`);
    lines.push(`  shares    ${m.shares.length ? `${m.shares.filter((s) => s.live).length} live of ${m.shares.length} not expired` : 'none'}`);
    for (const s of m.shares) lines.push(shareLine(s, now));
    const activity = v.activity[n];
    if (activity === null || activity === undefined) lines.push('  activity  ledger unavailable');
    else {
      lines.push(`  activity  ${activity.length} ok login/session/derive event${activity.length === 1 ? '' : 's'}${activity.length ? ', newest first' : ''}`);
      for (const e of activity) lines.push(`    ${formatTime(e.at)}  ${e.endpoint.padEnd(7)} ${e.appId ?? '-'}  ${e.latencyMs} ms  ${e.requestId}${e.nearTx ? `  tx ${e.nearTx}` : ''}`);
    }
    lines.push(`  changes   ${m.changes.length ? `${m.changes.length}, newest first` : 'none in the window'}`);
    for (const c of m.changes) lines.push(`    ${formatTime(c.at)}  ${c.kind}  ${c.appId ?? c.scopeId ?? ''}  by ${c.actorKind}:${c.actorId}  ${c.requestId}`);
  }
  if (v.requests !== null && (v.requests.length || v.requestsNotFound.length)) {
    lines.push('');
    lines.push(`Request IDs: ${v.requests.length} event${v.requests.length === 1 ? '' : 's'}${v.requestsNotFound.length ? `; no event for ${v.requestsNotFound.join(', ')} (unknown, a gate rejection, or capture off then)` : ''}`);
    for (const e of v.requests) {
      lines.push(`  ${e.requestId}  ${formatTime(e.at)}  ${e.endpoint} ${e.outcome}${e.code ? ` ${e.code}` : ''} (${e.status})  ${e.appId ?? e.scopeId} of ${e.orgId}  ${e.latencyMs} ms${e.nearTx ? `  tx ${e.nearTx}` : ''}${e.byMatch ? '  [this user]' : ''}`);
    }
  }
  return lines;
}

/** `support:lookup <HANA-XXXX-XXXX | u1_… | hu_… | -> [--request-id <id>]… [--days 30] [--json]`. */
export async function supportLookupCommand(input: string, args: Args, deps: SupportCmdDeps): Promise<CliSupportView> {
  const text = input === '-' ? await deps.readLine('Support ID, User ID or internal id: ') : input;
  const q = supportQuery(text);
  const requestIds = [...new Set(args.list('request-id').map((r) => r.trim()))];
  if (requestIds.length > SUPPORT_REQUEST_IDS_MAX) throw new CliError(`At most ${SUPPORT_REQUEST_IDS_MAX} --request-id`);
  for (const r of requestIds) if (!REQUEST_ID_RE.test(r)) throw new CliError('--request-id takes a request ID as the API answers it (x-request-id, 8–128 of A–Z a–z 0–9 _ -)');
  const days = args.int('days', SUPPORT_DAYS_DEFAULT, { min: 1, max: SUPPORT_DAYS_MAX });
  const view = await supportLedger(await supportDirectory(q, days, deps), days, requestIds, deps);
  if (args.flag('json')) deps.log(JSON.stringify(view, null, 2));
  else for (const l of formatSupportView(view, (deps.now ?? Date.now)())) deps.log(l);
  return view;
}
