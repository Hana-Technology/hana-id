// admin.ts user:list and user:find: the user directory (D269), for Hana staff. Read only, from the email issuer's own
// D1 (`emailIssuer.cloudflare.d1Name`, migration apps/email-issuer/migrations/0002_user_emails.sql) with `wrangler d1
// execute --file` locally and D1's REST API remotely (lib/d1.ts issuerD1Execute: never the statement in a process
// argument; wrangler's log file, metrics and error reports off). Partners never reach
// this: no API route, SDK call or partner console reads the issuer's D1.
//
// Addresses are printed to the operator's terminal on purpose, and nowhere else: never written to a file or a log.
// An address or sub to look up can come on stdin (`user:find` with no flag, `--search -`), so it stays out of the
// shell history, and the statement holding it never goes in a process argument (lib/d1.ts).
//
// A Google row with `email_verified = 0` is only a claim: anyone can put any address on a Google account without
// proving they own it, so such a row can be another person's claim to someone's address. It is never shown as the
// address's owner: `user:find --email` lists it apart under an UNVERIFIED warning, `user:list` marks it, and --json
// carries `unverifiedClaim: true`. Email rows are always verified (a sign-in code).
//
// Each user's path per app is its own on-chain path, `{scope}#{provider}#{sub}#0` (docs/architecture.md "Key
// derivation"; key_index 0 in the MVP). A linked member's wallet is its account root's path instead (`get_identity`
// on chain); an email identity recorded in case B has no wallet of its own yet.
//
// The wallet directory (D310, D316, D346; the API's own D1, migration 0011): each identity's user per scope with its
// three ids (the User ID `u1_…` partners see, the identity token's `sub`; its Support ID; the internal id `hu_…`, the
// ledger's uid, staff only), its role in the account and the account's wallets, read from the API's D1 with the same
// private executor (lib/d1.ts apiPrivateD1Execute: a sub or an address to look up never goes in a process argument).
// `user:find --address <G…|0x…|NEAR account>` and `--user <u1_…|hu_…|HANA-XXXX-XXXX>` start from the API's D1 and join each
// identity's address from the issuer's directory when the env has one.
import { INTERNAL_ID_RE, UNVERIFIED_CLAIM_WARNING, USER_ID_RE, formatSupportId, parseSupportId } from '@hana-id/console-core';
import { canonicalWalletAddress } from '@hana-id/core/identity';
import { normalizeEmail } from '@hana-id/email';
import { formatTime } from './admin-lead-times.ts';
import { type Args, CliError } from './cli.ts';
import { sql } from './sql.ts';

export const USER_PROVIDERS = ['email', 'google'] as const;
export type UserProvider = (typeof USER_PROVIDERS)[number];
export const USER_LIST_DEFAULT_LIMIT = 50;
export const USER_LIST_MAX_LIMIT = 1000;
const MAX_ADDRESS = 320;
const MAX_SUB = 255;
const APP_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/u;

export interface UserCmdDeps {
  /** Runs one read statement on the issuer's D1 and returns its rows; null for an env without an email issuer. */
  d1: ((statement: string) => Promise<Record<string, unknown>[]>) | null;
  /** Runs one read statement on the API's D1 (the wallet directory) privately; null to leave wallets out. */
  apiD1: ((statement: string) => Promise<Record<string, unknown>[]>) | null;
  now?: () => number;
  log: (line: string) => void;
  /** One line from stdin (an address or sub kept out of the shell history). */
  readLine: (prompt: string) => Promise<string>;
}

export interface UserApp {
  appId: string;
  scopeId: string;
  /** The identity's own on-chain path in that scope. */
  path: string;
  firstSeenMs: number;
  lastSeenMs: number;
}

export interface DirectoryUser {
  email: string;
  provider: UserProvider;
  sub: string;
  emailVerified: boolean;
  /** Google: whether the address is Google-hosted (D158); null for email. */
  hosted: boolean | null;
  /**
   * A Google row whose address Google hasn't verified (`email_verified = 0`): the account only claims the address,
   * which can be someone else's. Never treat it as the owner.
   */
  unverifiedClaim: boolean;
  firstSeenMs: number;
  lastSeenMs: number;
  /** Newest first. */
  apps: UserApp[];
  /** The wallet directory's users this identity is in, one per scope (empty without the API's D1 or a record). */
  accounts: WalletAccount[];
}

export interface WalletRow {
  /** `near` since D755 (an SDK 0.4.0+ session's NEAR implicit account). */
  chain: 'stellar' | 'evm' | 'near';
  address: string;
  keyIndex: number;
  firstSeenMs: number;
  lastUsedMs: number;
  /** Other users listing the same address (0 normally; see D311). */
  sharedWith: number;
}

/** One identity's place in the wallet directory: its scope's user, its role there and the account's wallets. */
export interface WalletAccount {
  scopeId: string;
  /** The User ID: the identity token's `sub` (`u1_…`), what the partner sees. */
  userId: string;
  supportId: string;
  /** `hu_…`, the ledger's uid (staff only). */
  internalId: string;
  role: 'root' | 'member';
  /** As stored, a pending link read as active once its time passed. */
  status: 'active' | 'pending' | 'unlinked' | 'cancelled';
  effectiveAtMs: number | null;
  wallets: WalletRow[];
}

export interface WalletUserIdentity {
  provider: string;
  sub: string | null;
  role: 'root' | 'member';
  status: WalletAccount['status'];
  effectiveAtMs: number | null;
  /** The issuer's directory rows of this identity (its address), when the env has an issuer. */
  directory: DirectoryUser[];
}

/** A user of the wallet directory with its identities. */
export interface WalletUser {
  /** `u1_…`, the identity token's `sub`. */
  userId: string;
  supportId: string;
  /** `hu_…`, the ledger's uid. */
  internalId: string;
  scopeId: string;
  createdMs: number;
  lastSeenMs: number;
  wallets: WalletRow[];
  identities: WalletUserIdentity[];
}

/** The warning above an unverified Google row (user:find) and on its address line (both commands). */
/** The same words as the admin console's Users screen (console-core, D275). */
export const UNVERIFIED_WARNING = UNVERIFIED_CLAIM_WARNING;
const UNVERIFIED_TAG = '[UNVERIFIED: claimed, not verified by Google]';

export interface UserListFilter {
  app?: string;
  provider?: UserProvider;
  /** Lowercased; matched as a plain substring of the stored address. */
  search?: string;
  limit: number;
}

export type UserFindQuery = { kind: 'email'; candidates: string[]; provider?: UserProvider } | { kind: 'sub'; sub: string; provider?: UserProvider };
export type WalletFindQuery =
  | { kind: 'address'; chain: 'stellar' | 'evm' | 'near'; address: string }
  | { kind: 'userId'; userId: string }
  | { kind: 'internalId'; internalId: string }
  | { kind: 'supportId'; code: string };

/** `{scope}#{provider}#{sub}#0` (sessions.rs; docs/architecture.md "Key derivation"). */
export const ownPath = (scopeId: string, provider: string, sub: string): string => `${scopeId}#${provider}#${sub}#0`;

const SELECT_USERS =
  'SELECT u.provider, u.sub, u.email, u.email_verified, u.hosted, u.first_seen_ms, u.last_seen_ms, ' +
  "(SELECT json_group_array(json_object('app_id', a.app_id, 'scope_id', a.scope_id, 'first_seen_ms', a.first_seen_ms, 'last_seen_ms', a.last_seen_ms)) " +
  'FROM user_email_apps a WHERE a.provider = u.provider AND a.sub = u.sub) AS apps_json FROM user_emails u';
const ORDER = ' ORDER BY u.last_seen_ms DESC, u.provider, u.sub';

/** The list query: every filter escaped through the `sql` tag, newest first by last seen. */
export function userListSql(f: UserListFilter): string {
  const where: string[] = [];
  if (f.provider) where.push(sql`u.provider = ${f.provider}`);
  if (f.app) where.push(sql`EXISTS (SELECT 1 FROM user_email_apps x WHERE x.provider = u.provider AND x.sub = u.sub AND x.app_id = ${f.app})`);
  if (f.search) where.push(sql`instr(u.email, ${f.search}) > 0`);
  if (!Number.isSafeInteger(f.limit) || f.limit < 1 || f.limit > USER_LIST_MAX_LIMIT) throw new CliError(`--limit must be between 1 and ${USER_LIST_MAX_LIMIT}`);
  return `${SELECT_USERS}${where.length ? ` WHERE ${where.join(' AND ')}` : ''}${ORDER} LIMIT ${f.limit}`;
}

/** The find query: an exact address (as typed lowercased, or normalized as email logins store it) or an exact sub. */
export function userFindSql(q: UserFindQuery): string {
  const where: string[] = [];
  if (q.kind === 'email') {
    if (q.candidates.length === 0) throw new CliError('No address to look up');
    where.push(`u.email IN (${q.candidates.map((c) => sql`${c}`).join(', ')})`);
  } else where.push(sql`u.sub = ${q.sub}`);
  if (q.provider) where.push(sql`u.provider = ${q.provider}`);
  return `${SELECT_USERS} WHERE ${where.join(' AND ')}${ORDER}`;
}

/** The directory rows of these subs (any provider; the caller keeps the matching ones). */
export function userSubsSql(subs: readonly string[]): string {
  if (subs.length === 0) throw new CliError('No sub to look up');
  return `${SELECT_USERS} WHERE u.sub IN (${subs.map((x) => sql`${x}`).join(', ')})${ORDER}`;
}

// ---- the wallet directory (the API's D1) ----

const WALLETS_JSON =
  "(SELECT json_group_array(json_object('chain', w.chain, 'address', w.address, 'key_index', w.key_index, 'first_seen_at', w.first_seen_at, 'last_used_at', w.last_used_at, " +
  "'shared', (SELECT COUNT(*) FROM end_user_wallets x WHERE x.chain = w.chain AND x.address = w.address AND x.user_id <> w.user_id))) FROM end_user_wallets w WHERE w.user_id = u.user_id) AS wallets_json";

/** Each identity row of these subs with its user and the user's wallets (the caller keeps the right providers). */
export function accountsBySubsSql(subs: readonly string[]): string {
  if (subs.length === 0) throw new CliError('No sub to look up');
  return (
    'SELECT i.provider, i.sub, i.scope_id, i.role, i.status, i.effective_at, u.user_id, u.token_sub, u.support_code, ' +
    WALLETS_JSON +
    ` FROM end_user_identities i JOIN end_users u ON u.user_id = i.user_id WHERE i.sub IN (${subs.map((x) => sql`${x}`).join(', ')}) ORDER BY u.last_seen_at DESC, u.user_id`
  );
}

/** Users by a wallet address (every user listing it), a User ID, an internal id or a Support ID, with identities and wallets. */
export function walletUsersSql(q: WalletFindQuery): string {
  const where =
    q.kind === 'address'
      ? sql`u.user_id IN (SELECT user_id FROM end_user_wallets WHERE chain = ${q.chain} AND address = ${q.address})`
      : q.kind === 'userId'
        ? sql`u.token_sub = ${q.userId}`
        : q.kind === 'internalId'
          ? sql`u.user_id = ${q.internalId}`
          : sql`u.support_code = ${q.code}`;
  return (
    'SELECT u.user_id, u.token_sub, u.support_code, u.scope_id, u.created_at, u.last_seen_at, ' +
    "(SELECT json_group_array(json_object('provider', i.provider, 'sub', i.sub, 'role', i.role, 'status', i.status, 'effective_at', i.effective_at)) FROM end_user_identities i WHERE i.user_id = u.user_id) AS identities_json, " +
    WALLETS_JSON +
    ` FROM end_users u WHERE ${where} ORDER BY u.last_seen_at DESC, u.user_id LIMIT 50`
  );
}

const statusAt = (status: unknown, effectiveAt: number | null, now: number): WalletAccount['status'] => {
  const s = String(status) as WalletAccount['status'];
  return s === 'pending' && effectiveAt !== null && effectiveAt <= now ? 'active' : s;
};

const jsonRows = (v: unknown): Record<string, unknown>[] => (JSON.parse(typeof v === 'string' ? v : '[]') as (Record<string, unknown> | null)[]).filter((x): x is Record<string, unknown> => x !== null);
const msOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));

/** Stellar, EVM, then NEAR. */
const CHAIN_RANK: Record<WalletRow['chain'], number> = { stellar: 0, evm: 1, near: 2 };

function parseWallets(json: unknown): WalletRow[] {
  return jsonRows(json)
    .map((w) => ({ chain: w.chain as WalletRow['chain'], address: str(w.address), keyIndex: num(w.key_index), firstSeenMs: num(w.first_seen_at), lastUsedMs: num(w.last_used_at), sharedWith: num(w.shared) }))
    // A chain this CLI doesn't know yet sorts last (a stable rank, never NaN).
    .sort((a, b) => (a.chain === b.chain ? a.address.localeCompare(b.address) : (CHAIN_RANK[a.chain] ?? 9) - (CHAIN_RANK[b.chain] ?? 9)));
}

/** A row of accountsBySubsSql → the identity's account in that scope. */
export function parseAccountRow(r: Record<string, unknown>, now: number): WalletAccount & { provider: string; sub: string } {
  const effectiveAtMs = msOrNull(r.effective_at);
  return {
    provider: str(r.provider),
    sub: str(r.sub),
    scopeId: str(r.scope_id),
    userId: str(r.token_sub),
    supportId: formatSupportId(str(r.support_code)),
    internalId: str(r.user_id),
    role: r.role === 'member' ? 'member' : 'root',
    status: statusAt(r.status, effectiveAtMs, now),
    effectiveAtMs,
    wallets: parseWallets(r.wallets_json),
  };
}

/** A row of walletUsersSql → the user (its identities' directory rows are joined after). */
export function parseWalletUserRow(r: Record<string, unknown>, now: number): WalletUser {
  return {
    userId: str(r.token_sub),
    supportId: formatSupportId(str(r.support_code)),
    internalId: str(r.user_id),
    scopeId: str(r.scope_id),
    createdMs: num(r.created_at),
    lastSeenMs: num(r.last_seen_at),
    wallets: parseWallets(r.wallets_json),
    identities: jsonRows(r.identities_json)
      .map((i): WalletUserIdentity => {
        const effectiveAtMs = msOrNull(i.effective_at);
        return { provider: str(i.provider), sub: typeof i.sub === 'string' ? i.sub : null, role: i.role === 'member' ? 'member' : 'root', status: statusAt(i.status, effectiveAtMs, now), effectiveAtMs, directory: [] };
      })
      .sort((a, b) => (a.role === b.role ? a.provider.localeCompare(b.provider) : a.role === 'root' ? -1 : 1)),
  };
}

/** Adds each directory user's wallet-directory accounts (one query for all); a no-op without the API's D1. */
async function withAccounts(users: DirectoryUser[], deps: UserCmdDeps): Promise<DirectoryUser[]> {
  if (!deps.apiD1 || users.length === 0) return users;
  const now = (deps.now ?? Date.now)();
  const rows = (await deps.apiD1(accountsBySubsSql([...new Set(users.map((u) => u.sub))]))).map((r) => parseAccountRow(r, now));
  for (const u of users) {
    u.accounts = rows.filter((r) => r.provider === u.provider && r.sub === u.sub).map(({ provider: _p, sub: _s, ...a }) => a);
  }
  return users;
}

const num = (v: unknown): number => {
  if (typeof v === 'number' && Number.isSafeInteger(v)) return v;
  throw new Error('user directory: malformed row');
};
const str = (v: unknown): string => {
  if (typeof v === 'string') return v;
  throw new Error('user directory: malformed row');
};

/** A D1 row of SELECT_USERS → a user, its apps newest first with their paths. */
export function parseUserRow(r: Record<string, unknown>): DirectoryUser {
  const provider = str(r.provider);
  if (!(USER_PROVIDERS as readonly string[]).includes(provider)) throw new Error('user directory: unknown provider');
  const sub = str(r.sub);
  const rawApps = JSON.parse(typeof r.apps_json === 'string' ? r.apps_json : '[]') as Record<string, unknown>[];
  const apps = rawApps
    .map((a) => ({ appId: str(a.app_id), scopeId: str(a.scope_id), path: ownPath(str(a.scope_id), provider, sub), firstSeenMs: num(a.first_seen_ms), lastSeenMs: num(a.last_seen_ms) }))
    .sort((x, y) => y.lastSeenMs - x.lastSeenMs || x.appId.localeCompare(y.appId));
  const emailVerified = num(r.email_verified) === 1;
  return {
    email: str(r.email),
    provider: provider as UserProvider,
    sub,
    emailVerified,
    hosted: r.hosted === null || r.hosted === undefined ? null : num(r.hosted) === 1,
    unverifiedClaim: provider === 'google' && !emailVerified,
    firstSeenMs: num(r.first_seen_ms),
    lastSeenMs: num(r.last_seen_ms),
    apps,
    accounts: [],
  };
}

/** One user, for the terminal. */
export function formatUser(u: DirectoryUser): string[] {
  const hosted = u.hosted === null ? '' : u.hosted ? ', Google-hosted' : ', not Google-hosted';
  const verified = u.provider === 'email' ? 'yes (a sign-in code)' : u.unverifiedClaim ? `NO: Google hasn’t verified this address; the account only claims it${hosted}` : `yes (Google)${hosted}`;
  const lines = [u.unverifiedClaim ? `${u.email}  ${UNVERIFIED_TAG}` : u.email, `  provider  ${u.provider}`, `  sub       ${u.sub}`, `  verified  ${verified}`, `  seen      ${formatTime(u.firstSeenMs)} first, ${formatTime(u.lastSeenMs)} last`];
  if (u.apps.length === 0) lines.push('  apps      none');
  for (const [i, a] of u.apps.entries()) {
    lines.push(`  ${i === 0 ? 'apps' : '    '}      ${a.appId} (scope ${a.scopeId})  path ${a.path}  seen ${formatTime(a.firstSeenMs)} first, ${formatTime(a.lastSeenMs)} last`);
  }
  for (const a of u.accounts) {
    lines.push(`  user      ${a.userId} (${a.supportId}; internal ${a.internalId}) in scope ${a.scopeId}: ${accountRole(a)}`);
    lines.push(...walletLines(a.wallets));
  }
  return lines;
}

function accountRole(a: Pick<WalletAccount, 'role' | 'status' | 'effectiveAtMs'>): string {
  if (a.role === 'root') return 'the account root';
  return a.status === 'pending' ? `a member, pending until ${formatTime(a.effectiveAtMs)}` : `a member, ${a.status}`;
}

/** The wallet lines: none yet (no login recorded since D310), or each address with its key index and times. */
export function walletLines(wallets: readonly WalletRow[]): string[] {
  if (wallets.length === 0) return ['  wallets   none recorded yet (recorded at the next login)'];
  return wallets.map(
    (w, i) =>
      `  ${i === 0 ? 'wallets' : '       '}   ${w.chain.padEnd(7)} ${w.address}  key ${w.keyIndex}  seen ${formatTime(w.firstSeenMs)} first, ${formatTime(w.lastUsedMs)} last used` +
      (w.sharedWith > 0 ? `  [ALSO LISTED UNDER ${w.sharedWith} OTHER USER${w.sharedWith === 1 ? '' : 'S'}: a reused key or a raw-signed record, D311]` : ''),
  );
}

/** One wallet-directory user, for the terminal. */
export function formatWalletUser(u: WalletUser): string[] {
  const lines = [`${u.userId} (${u.supportId}; internal ${u.internalId})  scope ${u.scopeId}`, `  seen     ${formatTime(u.createdMs)} first, ${formatTime(u.lastSeenMs)} last`, ...walletLines(u.wallets)];
  for (const [n, i] of u.identities.entries()) {
    const emails = i.directory.map((d) => (d.unverifiedClaim ? `${d.email} ${UNVERIFIED_TAG}` : d.email));
    lines.push(`  ${n === 0 ? 'accounts' : '        '}  ${i.provider.padEnd(7)} sub ${i.sub ?? '(only seen on chain)'}  ${accountRole(i)}  ${emails.length ? emails.join(', ') : 'no address in the directory'}`);
  }
  return lines;
}

const PATH_NOTE = 'path: the identity’s own on-chain path; a linked member’s wallet is its account root’s (get_identity).';

function provider(args: Args): UserProvider | undefined {
  const p = args.str('provider');
  if (p === undefined) return undefined;
  if (!(USER_PROVIDERS as readonly string[]).includes(p)) throw new CliError('--provider must be email or google');
  return p as UserProvider;
}

function printUsers(users: DirectoryUser[], deps: UserCmdDeps): void {
  for (const u of users) {
    deps.log('');
    for (const l of formatUser(u)) deps.log(l);
  }
}

/** user:list: every user in order, unverified Google rows marked on their address line. */
function output(users: DirectoryUser[], header: string, args: Args, deps: UserCmdDeps): void {
  if (args.flag('json')) return void deps.log(JSON.stringify(users, null, 2));
  const claims = users.filter((u) => u.unverifiedClaim).length;
  deps.log(header);
  if (claims) deps.log(`${claims} of them ${claims === 1 ? 'is a Google account' : 'are Google accounts'} whose address Google hasn’t verified, marked ${UNVERIFIED_TAG}: a claim, never the address’s owner.`);
  if (users.length) deps.log(PATH_NOTE);
  printUsers(users, deps);
}

/**
 * user:find: the verified users first; unverified Google rows apart, after the warning, never counted as the owner
 * (--json: the verified first, each row's `unverifiedClaim`).
 */
function findOutput(users: DirectoryUser[], what: 'address' | 'sub', where: string, args: Args, deps: UserCmdDeps): void {
  const owners = users.filter((u) => !u.unverifiedClaim);
  const claims = users.filter((u) => u.unverifiedClaim);
  if (args.flag('json')) return void deps.log(JSON.stringify([...owners, ...claims], null, 2));
  const n = (k: number, noun: string): string => `${k} ${noun}${k === 1 ? '' : 's'}`;
  if (owners.length) deps.log(`${n(owners.length, 'user')} (${where})`);
  else deps.log(claims.length ? `No verified user with that ${what} (${where})` : `No user with that ${what} (${where})`);
  if (users.length) deps.log(PATH_NOTE);
  printUsers(owners, deps);
  if (!claims.length) return;
  deps.log('');
  deps.log(`${UNVERIFIED_WARNING}${claims.length > 1 ? ` (${claims.length} Google accounts)` : ''}.`);
  printUsers(claims, deps);
}

/** The address candidates of an exact lookup: as typed (trimmed, lowercased: Google rows) and normalized (email rows). */
export function addressCandidates(input: string): string[] {
  const typed = input.trim().toLowerCase();
  if (!typed.includes('@') || typed.length > MAX_ADDRESS) throw new CliError('Not an email address');
  const n = normalizeEmail(input);
  return [...new Set([typed, ...(n.ok ? [n.email] : [])])];
}

function checkSub(sub: string): string {
  const s = sub.trim();
  if (!s || s.length > MAX_SUB || /\s/u.test(s)) throw new CliError('Not a sub');
  return s;
}

/** `user:list [--app <app id>] [--provider email|google] [--search <substring> | -] [--limit 50] [--json]`. */
export async function userList(args: Args, where: string, deps: UserCmdDeps): Promise<DirectoryUser[]> {
  const app = args.str('app');
  if (app !== undefined && !APP_ID_RE.test(app)) throw new CliError('--app takes an app id (app_…)');
  let search = args.str('search');
  if (search === '-') search = await deps.readLine('Part of the address: ');
  if (search !== undefined) {
    search = search.trim().toLowerCase();
    if (!search || search.length > MAX_ADDRESS) throw new CliError('--search takes part of an address');
  }
  const filter: UserListFilter = { limit: args.int('limit', USER_LIST_DEFAULT_LIMIT, { min: 1, max: USER_LIST_MAX_LIMIT }) };
  const p = provider(args);
  if (p) filter.provider = p;
  if (app) filter.app = app;
  if (search) filter.search = search;
  const users = await withAccounts((await issuer(deps)(userListSql(filter))).map(parseUserRow), deps);
  const filters = [p && `provider ${p}`, app && `app ${app}`, search !== undefined && 'an address search'].filter(Boolean).join(', ');
  output(users, `${users.length} user${users.length === 1 ? '' : 's'} (${where}${filters ? `; ${filters}` : ''}), newest first by last seen${users.length === filter.limit ? ` (the first ${filter.limit}: --limit for more)` : ''}`, args, deps);
  return users;
}

/** `user:find [--email <address> | --sub <sub>] [--provider email|google] [--json]`; neither flag: one line on stdin. */
export async function userFind(args: Args, where: string, deps: UserCmdDeps): Promise<DirectoryUser[]> {
  const email = args.str('email');
  const sub = args.str('sub');
  if (email !== undefined && sub !== undefined) throw new CliError('user:find takes --email or --sub, not both');
  const p = provider(args);
  let q: UserFindQuery;
  if (email !== undefined) q = { kind: 'email', candidates: addressCandidates(email) };
  else if (sub !== undefined) q = { kind: 'sub', sub: checkSub(sub) };
  else {
    const line = await deps.readLine('Address or sub: ');
    q = line.includes('@') ? { kind: 'email', candidates: addressCandidates(line) } : { kind: 'sub', sub: checkSub(line) };
  }
  if (p) q.provider = p;
  const users = await withAccounts((await issuer(deps)(userFindSql(q))).map(parseUserRow), deps);
  findOutput(users, q.kind === 'email' ? 'address' : 'sub', where, args, deps);
  return [...users.filter((u) => !u.unverifiedClaim), ...users.filter((u) => u.unverifiedClaim)];
}

/** The issuer's D1 reader, or a clear error for an env without one. */
function issuer(deps: UserCmdDeps): (statement: string) => Promise<Record<string, unknown>[]> {
  if (!deps.d1) throw new CliError('This env has no emailIssuer: no user directory (user:find --address or --user still read the wallet directory)');
  return deps.d1;
}

/** What `--address` / `--user` (or a stdin line) names in the wallet directory, or null when it isn't one. */
export function walletQuery(input: string): WalletFindQuery | null {
  const v = input.trim();
  if (/^G[A-Z2-7]{55}$/u.test(v)) {
    const address = canonicalWalletAddress('stellar', v);
    if (!address) throw new CliError('Not a valid Stellar address');
    return { kind: 'address', chain: 'stellar', address };
  }
  if (/^0x[0-9a-fA-F]{40}$/u.test(v)) {
    const address = canonicalWalletAddress('evm', v);
    if (!address) throw new CliError('Not a valid EVM address');
    return { kind: 'address', chain: 'evm', address };
  }
  // A NEAR implicit account id (D755), in any case: stored lowercase.
  if (/^[0-9a-fA-F]{64}$/u.test(v)) return { kind: 'address', chain: 'near', address: v.toLowerCase() };
  // A User ID is case-sensitive (base64url); an internal id is read in any case.
  if (USER_ID_RE.test(v)) return { kind: 'userId', userId: v };
  if (INTERNAL_ID_RE.test(v.toLowerCase())) return { kind: 'internalId', internalId: v.toLowerCase() };
  if (/^hana[\s-]?/iu.test(v) || /^[0-9a-z]{4}-?[0-9a-z]{4}$/iu.test(v)) {
    const code = parseSupportId(v);
    if (code) return { kind: 'supportId', code };
  }
  return null;
}

/**
 * user:find --address / --user: the wallet directory's users (every user listing an address; every user whose id a
 * Support ID starts), each identity with its sub, role and status and, when the env has an issuer, its address rows.
 */
export async function userFindWallets(q: WalletFindQuery, args: Args, where: string, deps: UserCmdDeps): Promise<WalletUser[]> {
  if (!deps.apiD1) throw new CliError('No API database to read the wallet directory from');
  const now = (deps.now ?? Date.now)();
  const users = (await deps.apiD1(walletUsersSql(q))).map((r) => parseWalletUserRow(r, now));
  const subs = [...new Set(users.flatMap((u) => u.identities.map((i) => i.sub)).filter((x): x is string => x !== null))];
  if (deps.d1 && subs.length) {
    const rows = (await deps.d1(userSubsSql(subs))).map(parseUserRow);
    for (const u of users) for (const i of u.identities) i.directory = rows.filter((r) => r.provider === i.provider && r.sub === i.sub);
  }
  if (args.flag('json')) {
    deps.log(JSON.stringify(users, null, 2));
    return users;
  }
  const what = { address: 'wallet', userId: 'User ID', internalId: 'internal id', supportId: 'Support ID' }[q.kind];
  deps.log(users.length ? `${users.length} user${users.length === 1 ? '' : 's'} with that ${what} (${where})` : `No user with that ${what} (${where})`);
  if (q.kind === 'address' && users.length > 1) deps.log('The address is listed under more than one user: a reused or exported key, or a record made from an approved raw signature (D311). Never treat it as proof of who owns the wallet.');
  if (!deps.d1 && users.length) deps.log('This env has no email issuer: no addresses.');
  for (const u of users) {
    deps.log('');
    for (const l of formatWalletUser(u)) deps.log(l);
  }
  return users;
}

/**
 * `user:find [--email <address> | --sub <sub> | --address <G…|0x…|NEAR account> | --user <u1_…|hu_…|HANA-XXXX-XXXX>] [--provider …] [--json]`;
 * no flag: one line on stdin, read as whichever it is.
 */
export async function userFindCommand(args: Args, where: { issuer: string; api: string }, deps: UserCmdDeps): Promise<void> {
  const given = ['email', 'sub', 'address', 'user'].filter((f) => args.str(f) !== undefined);
  if (given.length > 1) throw new CliError(`user:find takes one of --email, --sub, --address or --user, not ${given.map((g) => `--${g}`).join(' and ')}`);
  const address = args.str('address');
  const user = args.str('user');
  if (address !== undefined || user !== undefined) {
    if (args.str('provider') !== undefined) throw new CliError('--provider goes with --email or --sub');
    const q = walletQuery(address ?? user ?? '');
    if (!q || (address !== undefined && q.kind !== 'address') || (user !== undefined && q.kind === 'address')) {
      throw new CliError(address !== undefined ? '--address takes a Stellar G…, an EVM 0x… address or a NEAR account (64 hex)' : '--user takes a User ID (u1_…), an internal id (hu_…) or a Support ID (HANA-XXXX-XXXX)');
    }
    await userFindWallets(q, args, where.api, deps);
    return;
  }
  if (given.length === 0) {
    const line = await deps.readLine('Address, sub, wallet, user id or Support ID: ');
    const q = line.includes('@') ? null : walletQuery(line);
    if (q) {
      await userFindWallets(q, args, where.api, deps);
      return;
    }
    await userFind(args, where.issuer, { ...deps, readLine: async () => line });
    return;
  }
  await userFind(args, where.issuer, deps);
}
