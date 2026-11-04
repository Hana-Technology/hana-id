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
  /** Runs one read statement on the issuer's D1 and returns its rows. */
  d1: (statement: string) => Promise<Record<string, unknown>[]>;
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
}

/** The warning above an unverified Google row (user:find) and on its address line (both commands). */
export const UNVERIFIED_WARNING = 'UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner';
const UNVERIFIED_TAG = '[UNVERIFIED: claimed, not verified by Google]';

export interface UserListFilter {
  app?: string;
  provider?: UserProvider;
  /** Lowercased; matched as a plain substring of the stored address. */
  search?: string;
  limit: number;
}

export type UserFindQuery = { kind: 'email'; candidates: string[]; provider?: UserProvider } | { kind: 'sub'; sub: string; provider?: UserProvider };

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
  const users = (await deps.d1(userListSql(filter))).map(parseUserRow);
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
  const users = (await deps.d1(userFindSql(q))).map(parseUserRow);
  findOutput(users, q.kind === 'email' ? 'address' : 'sub', where, args, deps);
  return [...users.filter((u) => !u.unverifiedClaim), ...users.filter((u) => u.unverifiedClaim)];
}
