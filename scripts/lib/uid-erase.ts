// uid-erase.ts: an end user's erasure request (docs/batch-c-spec.md "CLI" `uid:erase`, "Retention"; D90; batch C13,
// D361) across the three stores that index the user, for one scope:
//
//   the usage ledger (Neon)      usage.erase_uid as usage_admin: the user's app_users rows deleted, the uid NULLed on
//                                every event (the rows stay: billing and counts are unchanged)
//   the wallet directory         the API's D1 (migration 0011): the user's end_users rows (keyed by the internal id
//                                `hu_…`, the uid's encoding, D346) with their wallets and
//                                identities, through D1's REST API as the operator (lib/d1.ts apiPrivateD1Execute);
//                                and the user's `user_events` (migration 0013: key exports, mainnet demo signatures),
//                                by those internal ids and by every wallet address of theirs (readiness 7.17)
//   the issuer's user directory  the email issuer's D1 (D269): the identities' user_email_apps rows of the scope, and
//                                each identity's user_emails row once it has no app row left (D276's `user:erase`)
//
// The account is read from the chain, the source of truth (get_identity, get_account): the identity named, its account
// root and the account's members. Every uid that can carry the user's ledger rows is erased: the root's (the account's
// internal id, D312, D346) and each identity's own (from before it was linked), for every identity whose sub is known (the one
// named, the root, and the members the wallet directory has a sub for). The uid is recomputed with USER_ID_KEY from
// `.secrets/<env>/user-id-key`, never printed.
//
// Nothing that derivation depends on is touched: the identities, accounts and paths are on chain, so the user's wallets
// are exactly as before, and their next login through Hana writes new rows (a new erasure request covers those).
//
// Dry run by default: the plan with the counts per store, and the other scopes where the identity is seen (an erasure
// is per scope: run again for each). `--yes` erases, re-counts (all zero, or it fails) and records the erasure in
// ops.erasures (ticket, operator, scope, counts; never a uid, a sub or an address). Re-runnable: every step is
// idempotent. No address is ever printed; the sub is the operator's own input.
import { formatSupportId, internalIdOf, scopeIdInput, uid as uidOf, uidOfInternalId } from '@hana-id/console-core';
import type { Manifest } from '@hana-id/env';
import { type Args, CliError, parseCli } from './cli.ts';
import { sql } from './sql.ts';

export const UID_ERASE_USAGE = `Usage: uid-erase.ts <env> --scope <scope id> --provider <provider> --sub <sub | -> --ticket <ref> [--remote] [--no-ledger] [--yes]
  An end user's erasure request for one scope (D90, D361): the usage ledger's uids (usage.erase_uid, as usage_admin
  over .secrets/<env>/neon-usage-admin.url), the wallet directory's rows and the user's key export and mainnet demo
  events (the API's D1) and the issuer directory's rows (the email issuer's D1). The account (root and members) is
  read from the chain. Without --yes, prints the plan with the counts and changes nothing.
  --sub -       read the sub from stdin (kept out of the shell history)
  --ticket      the support reference of the request (no email address in it); recorded in ops.erasures
  --remote      the deployed D1 databases (default: local, as admin.ts)
  --no-ledger   an env without a usage ledger: skip it (nothing is recorded in ops.erasures then)`;

export interface LedgerConn {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  close(): Promise<void>;
}

export interface UidEraseDeps {
  loadManifest(env: string): Manifest;
  /** A view of the env's signer contract at FINAL (get_identity, get_account). */
  view(m: Manifest, method: 'get_identity' | 'get_account', args: Record<string, string>): Promise<unknown>;
  /** USER_ID_KEY, the 32 bytes of `.secrets/<env>/user-id-key` (0600). */
  userIdKey(env: string): Uint8Array;
  /** The usage_admin connection from `.secrets/<env>/neon-usage-admin.url`; null when the file doesn't exist. */
  ledger(env: string): Promise<LedgerConn | null>;
  /** One statement on the API's D1, privately (lib/d1.ts apiPrivateD1Execute). */
  apiD1(m: Manifest, statement: string, remote: boolean): Promise<Record<string, unknown>[]>;
  /** One statement on the issuer's D1, privately (lib/d1.ts issuerD1Execute); called only when the env has one. */
  issuerD1(m: Manifest, statement: string, remote: boolean): Promise<Record<string, unknown>[]>;
  readLine(prompt: string): Promise<string>;
  /** `cli:<login>` (admin-apps.ts cliActor). */
  operator: string;
  log(line: string): void;
}

export interface Identity {
  provider: string;
  sub: string;
}

/** What the chain says about the request's identity. */
export interface ChainAccount {
  named: Identity & { key: string; status: string };
  root: Identity & { key: string };
  /** Every identity key of the account (root, members, the named one). */
  keys: string[];
}

export interface Plan {
  scopeId: string;
  account: ChainAccount;
  /** The identities whose uid is erased (their sub is known). */
  identities: Identity[];
  /** hex uids, the root's first. */
  uids: string[];
  /** The wallet directory's keys (`hu_…`) of those uids, in the same order. */
  internalIds: string[];
  /** The wallet directory's rows among them: the User ID partners see and its Support ID (for the operator to check). */
  users: { internalId: string; userId: string; supportId: string }[];
  /**
   * Every wallet address of those users (the directory's wallets and their own events'), for their `user_events` rows
   * by address. Never printed or recorded.
   */
  addresses: string[];
  ledger: { events: number; appUsers: number } | null;
  directory: { users: number; wallets: number; identities: number };
  /** The `user_events` rows by those internal ids or addresses; null when the env's D1 has no such table (0013). */
  events: number | null;
  issuer: { apps: number; emails: number } | null;
  otherScopes: string[];
}

const PROVIDER_RE = /^[a-z][a-z0-9_-]{0,31}$/u;
const KEY_RE = /^[0-9a-f]{64}$/u;
const MAX_SUB = 255;

function checkSub(s: string): string {
  const v = s.trim();
  if (!v || v.length > MAX_SUB || /\s/u.test(v) || v.includes('#')) throw new CliError('Not a sub');
  return v;
}

/** A support reference: printable, at most 128 characters, never an email address (it is stored). */
export function checkTicket(t: string | undefined): string {
  const v = (t ?? '').trim();
  if (!v) throw new CliError('--ticket is required (the support reference of the request)');
  if (v.length > 128 || !/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/u.test(v)) throw new CliError('--ticket: printable ASCII, at most 128 characters');
  if (v.includes('@')) throw new CliError('--ticket must not hold an email address: it is stored in ops.erasures');
  return v;
}

const hex = (b: Uint8Array): string => Buffer.from(b).toString('hex');
const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('malformed count');
  return n;
};
const list = (xs: readonly string[]): string => xs.map((x) => sql`${x}`).join(', ');
const pairs = (ids: readonly Identity[], alias = ''): string => (ids.length ? ids.map((i) => `(${alias}provider = ${sql`${i.provider}`} AND ${alias}sub = ${sql`${i.sub}`})`).join(' OR ') : '0');

function asIdentityView(v: unknown): { key: string; status: string; root: Identity | null } {
  const o = v as { key?: unknown; status?: unknown; root?: { provider?: unknown; sub?: unknown } | null } | null;
  if (!o || typeof o.key !== 'string' || !KEY_RE.test(o.key) || typeof o.status !== 'string') throw new Error('get_identity returned an unexpected answer');
  const root = o.root && typeof o.root.provider === 'string' && typeof o.root.sub === 'string' ? { provider: o.root.provider, sub: o.root.sub } : null;
  if (o.status !== 'own' && !root) throw new Error('get_identity names no account root for a linked identity');
  return { key: o.key, status: o.status, root };
}

/** The identity's account from the chain (the source of truth): never guessed when a read fails. */
export async function chainAccount(m: Manifest, scopeId: string, named: Identity, deps: Pick<UidEraseDeps, 'view'>): Promise<ChainAccount> {
  const ident = asIdentityView(await deps.view(m, 'get_identity', { scope_id: scopeId, provider: named.provider, sub: named.sub }));
  const root = ident.root ?? named;
  const rootIdent = ident.root ? asIdentityView(await deps.view(m, 'get_identity', { scope_id: scopeId, provider: root.provider, sub: root.sub })) : ident;
  const account = (await deps.view(m, 'get_account', { scope_id: scopeId, provider: root.provider, sub: root.sub })) as { members?: { key?: unknown }[] } | null;
  const members = (account?.members ?? []).map((x) => x.key).filter((k): k is string => typeof k === 'string' && KEY_RE.test(k));
  return { named: { ...named, key: ident.key, status: ident.status }, root: { ...root, key: rootIdent.key }, keys: [...new Set([rootIdent.key, ident.key, ...members])] };
}

interface Ctx {
  m: Manifest;
  remote: boolean;
  scopeId: string;
  ticket: string;
  deps: UidEraseDeps;
  ledger: LedgerConn | null;
}

/** The wallet directory's rows of the account's identity keys in the scope: their subs and user ids. */
async function directoryIdentities(c: Ctx, keys: readonly string[]): Promise<{ provider: string; sub: string | null; userId: string }[]> {
  const rows = await c.deps.apiD1(c.m, `SELECT provider, sub, user_id FROM end_user_identities WHERE scope_id = ${sql`${c.scopeId}`} AND identity_key IN (${list(keys)})`, c.remote);
  return rows.map((r) => ({ provider: String(r.provider), sub: typeof r.sub === 'string' ? r.sub : null, userId: String(r.user_id) }));
}

const walletWhere = (c: Ctx, p: Pick<Plan, 'internalIds' | 'account' | 'addresses'>) => ({
  users: `user_id IN (${list(p.internalIds)})`,
  identities: `(user_id IN (${list(p.internalIds)}) OR (scope_id = ${sql`${c.scopeId}`} AND identity_key IN (${list(p.account.keys)})))`,
  // By the user (in this scope: internal ids are per scope) or by their address anywhere: an address is derived per
  // scope and user, so another row carrying it came from the same key (an exported or reused one) and is theirs too.
  events: `(user_id IN (${list(p.internalIds)})${p.addresses.length ? ` OR address IN (${list(p.addresses)})` : ''})`,
});

/** Whether the API's D1 has `user_events` (migration 0013 is applied by hand, docs/operations.md "Migrations"). */
async function hasUserEvents(c: Ctx): Promise<boolean> {
  const [r] = await c.deps.apiD1(c.m, "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'user_events'", c.remote);
  return num(r?.n) > 0;
}

/** The users' wallet addresses: their directory wallets and the addresses of their own events. */
async function userAddresses(c: Ctx, internalIds: readonly string[], events: boolean): Promise<string[]> {
  const ids = list(internalIds);
  const rows = await c.deps.apiD1(
    c.m,
    `SELECT address FROM end_user_wallets WHERE user_id IN (${ids})${events ? ` UNION SELECT address FROM user_events WHERE user_id IN (${ids}) AND address IS NOT NULL` : ''}`,
    c.remote,
  );
  return [...new Set(rows.map((r) => String(r.address)))].sort();
}

async function counts(c: Ctx, p: Pick<Plan, 'uids' | 'internalIds' | 'account' | 'identities' | 'addresses'> & { eventsTable: boolean }): Promise<Pick<Plan, 'ledger' | 'directory' | 'issuer' | 'events'>> {
  let ledger: Plan['ledger'] = null;
  if (c.ledger) {
    const [r] = await c.ledger.query<{ events: string; app_users: string }>(
      `SELECT (SELECT count(*) FROM usage.events WHERE uid IN (SELECT decode(h, 'hex') FROM unnest($1::text[]) AS h))::text AS events,
              (SELECT count(*) FROM usage.app_users WHERE uid IN (SELECT decode(h, 'hex') FROM unnest($1::text[]) AS h))::text AS app_users`,
      [p.uids],
    );
    ledger = { events: num(r?.events), appUsers: num(r?.app_users) };
  }
  const w = walletWhere(c, p);
  const [d] = await c.deps.apiD1(
    c.m,
    `SELECT (SELECT COUNT(*) FROM end_users WHERE ${w.users}) AS users, (SELECT COUNT(*) FROM end_user_wallets WHERE ${w.users}) AS wallets, (SELECT COUNT(*) FROM end_user_identities WHERE ${w.identities}) AS identities`,
    c.remote,
  );
  const directory = { users: num(d?.users), wallets: num(d?.wallets), identities: num(d?.identities) };
  const events = p.eventsTable ? num((await c.deps.apiD1(c.m, `SELECT COUNT(*) AS n FROM user_events WHERE ${w.events}`, c.remote))[0]?.n) : null;
  let issuer: Plan['issuer'] = null;
  if (c.m.emailIssuer) {
    const [i] = await c.deps.issuerD1(
      c.m,
      `SELECT (SELECT COUNT(*) FROM user_email_apps WHERE scope_id = ${sql`${c.scopeId}`} AND (${pairs(p.identities)})) AS apps,
              (SELECT COUNT(*) FROM user_emails u WHERE (${pairs(p.identities, 'u.')}) AND NOT EXISTS (SELECT 1 FROM user_email_apps a WHERE a.provider = u.provider AND a.sub = u.sub AND a.scope_id <> ${sql`${c.scopeId}`})) AS emails`,
      c.remote,
    );
    issuer = { apps: num(i?.apps), emails: num(i?.emails) };
  }
  return { ledger, directory, issuer, events };
}

/** The other scopes the account's identities are seen in (by either directory): each needs its own run. */
async function otherScopes(c: Ctx, identities: readonly Identity[]): Promise<string[]> {
  const out = new Set<string>();
  for (const r of await c.deps.apiD1(c.m, `SELECT DISTINCT scope_id FROM end_user_identities WHERE (${pairs(identities)}) AND scope_id <> ${sql`${c.scopeId}`}`, c.remote)) out.add(String(r.scope_id));
  if (c.m.emailIssuer) {
    for (const r of await c.deps.issuerD1(c.m, `SELECT DISTINCT scope_id FROM user_email_apps WHERE (${pairs(identities)}) AND scope_id <> ${sql`${c.scopeId}`}`, c.remote)) out.add(String(r.scope_id));
  }
  return [...out].sort();
}

export async function planErasure(c: Ctx, named: Identity): Promise<Plan> {
  const account = await chainAccount(c.m, c.scopeId, named, c.deps);
  const dir = await directoryIdentities(c, account.keys);
  const byKey = new Map<string, Identity>();
  for (const i of [account.root, named, ...dir.filter((x): x is typeof x & { sub: string } => x.sub !== null)]) byKey.set(`${i.provider}\n${i.sub}`, { provider: i.provider, sub: i.sub });
  const identities = [...byKey.values()];
  const key = c.deps.userIdKey(c.m.name);
  const uids: string[] = [];
  try {
    for (const i of identities) uids.push(hex(await uidOf(key, { scopeId: c.scopeId, provider: i.provider, sub: i.sub })));
  } finally {
    key.fill(0);
  }
  // Users the wallet directory has for these identities (an account the identity was root of before a link moved it).
  for (const d of dir) {
    const u = uidOfInternalId(d.userId);
    if (u && !uids.includes(hex(u))) uids.push(hex(u));
  }
  const internalIds = uids.map((h) => internalIdOf(Uint8Array.from(Buffer.from(h, 'hex'))));
  const users = (await c.deps.apiD1(c.m, `SELECT user_id, token_sub, support_code FROM end_users WHERE user_id IN (${list(internalIds)}) ORDER BY user_id`, c.remote)).map((r) => ({
    internalId: String(r.user_id),
    userId: String(r.token_sub),
    supportId: formatSupportId(String(r.support_code)),
  }));
  const eventsTable = await hasUserEvents(c);
  const addresses = await userAddresses(c, internalIds, eventsTable);
  const base = { scopeId: c.scopeId, account, identities, uids, internalIds, users, addresses };
  return { ...base, ...(await counts(c, { ...base, eventsTable })), otherScopes: await otherScopes(c, identities) };
}

export function formatPlan(p: Plan, where: string): string[] {
  const lines = [
    `Erasure plan for scope ${p.scopeId} (${where})`,
    `  account   root ${p.account.root.provider} (the named identity is ${p.account.named.status === 'own' ? 'the root' : p.account.named.status === 'pending' ? 'a pending member' : 'a linked member'}); ${p.account.keys.length} identit${p.account.keys.length === 1 ? 'y' : 'ies'} on chain`,
    `  uids      ${p.uids.length} (the account's and each known identity's own): ${p.internalIds
      .map((id) => {
        const u = p.users.find((x) => x.internalId === id);
        return u ? `${id} (User ID ${u.userId}, ${u.supportId})` : `${id} (no wallet-directory row)`;
      })
      .join(', ')}`,
    p.ledger ? `  ledger    ${p.ledger.events} event(s) lose their uid, ${p.ledger.appUsers} app_users row(s) deleted` : '  ledger    skipped (--no-ledger)',
    `  wallets   ${p.directory.users} user row(s), ${p.directory.wallets} wallet row(s), ${p.directory.identities} identity row(s) deleted (the API's D1)`,
    p.events === null
      ? '  events    none (the API\'s D1 has no user_events: migration 0013 not applied)'
      : `  events    ${p.events} key export / mainnet demo signature row(s) deleted, by these users and their ${p.addresses.length} wallet address(es) (the API's D1)`,
    p.issuer ? `  issuer    ${p.issuer.apps} app row(s) of the scope deleted, ${p.issuer.emails} address row(s) deleted (no app row left in another scope)` : '  issuer    none (this env has no email issuer)',
  ];
  const unknown = p.account.keys.length - p.identities.length;
  if (unknown > 0) lines.push(`  note      ${unknown} identit${unknown === 1 ? 'y' : 'ies'} of the account have no known sub: their own uids from before the link can't be computed (their rows under the account's uid are erased)`);
  if (p.otherScopes.length) lines.push(`  also seen in scope(s) ${p.otherScopes.join(', ')} (these identities): an erasure is per scope; run again with --scope for each`);
  lines.push('  on chain  untouched: identities, accounts and paths stay; the wallets are the same, and a later login writes new rows');
  return lines;
}

async function erase(c: Ctx, p: Plan): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  if (c.ledger) {
    let events = 0;
    let appUsers = 0;
    for (const h of p.uids) {
      const [r] = await c.ledger.query<{ app_users: string; events: string }>("SELECT app_users::text AS app_users, events::text AS events FROM usage.erase_uid(decode($1, 'hex'))", [h]);
      events += num(r?.events);
      appUsers += num(r?.app_users);
    }
    out.ledgerEvents = events;
    out.ledgerAppUsers = appUsers;
  }
  const w = walletWhere(c, p);
  const dir = await c.deps.apiD1(
    c.m,
    [
      // The events first: their addresses come from the wallets, so a run stopped half-way still finds them next time.
      ...(p.events !== null ? [`DELETE FROM user_events WHERE ${w.events} RETURNING 'v' AS t`] : []),
      `DELETE FROM end_user_wallets WHERE ${w.users} RETURNING 'w' AS t`,
      `DELETE FROM end_user_identities WHERE ${w.identities} RETURNING 'i' AS t`,
      `DELETE FROM end_users WHERE ${w.users} RETURNING 'u' AS t`,
    ].join(';\n'),
    c.remote,
  );
  out.directoryWallets = dir.filter((r) => r.t === 'w').length;
  out.directoryIdentities = dir.filter((r) => r.t === 'i').length;
  out.directoryUsers = dir.filter((r) => r.t === 'u').length;
  if (p.events !== null) out.userEvents = dir.filter((r) => r.t === 'v').length;
  if (c.m.emailIssuer) {
    const iss = await c.deps.issuerD1(
      c.m,
      [
        `DELETE FROM user_email_apps WHERE scope_id = ${sql`${c.scopeId}`} AND (${pairs(p.identities)}) RETURNING 'a' AS t`,
        `DELETE FROM user_emails WHERE (${pairs(p.identities)}) AND NOT EXISTS (SELECT 1 FROM user_email_apps a WHERE a.provider = user_emails.provider AND a.sub = user_emails.sub) RETURNING 'e' AS t`,
      ].join(';\n'),
      c.remote,
    );
    out.issuerApps = iss.filter((r) => r.t === 'a').length;
    out.issuerEmails = iss.filter((r) => r.t === 'e').length;
  }
  return out;
}

/** Runs `uid-erase <argv>`; returns the plan (and with --yes the counts erased), or null for --help. */
export async function uidErase(argv: readonly string[], deps: UidEraseDeps): Promise<{ plan: Plan; erased?: Record<string, number> } | null> {
  const args: Args = parseCli(argv, { strings: ['scope', 'provider', 'sub', 'ticket'], booleans: ['remote', 'no-ledger', 'yes', 'help'] });
  if (args.flag('help')) {
    deps.log(UID_ERASE_USAGE);
    return null;
  }
  const [envName, ...rest] = args.positionals;
  if (!envName || rest.length) throw new CliError('Expected <env>');
  const m = deps.loadManifest(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env (testnet only until the mainnet readiness review)`);
  const scope = scopeIdInput.safeParse(args.required('scope'));
  if (!scope.success) throw new CliError('--scope takes a scope id (s…)');
  const provider = args.required('provider');
  if (!PROVIDER_RE.test(provider)) throw new CliError('--provider takes a provider name (google, email, …)');
  let sub = args.required('sub');
  if (sub === '-') sub = await deps.readLine('Sub: ');
  const named = { provider, sub: checkSub(sub) };
  const ticket = checkTicket(args.str('ticket'));
  const remote = args.flag('remote');
  const where = `${remote ? 'remote' : 'local'} D1s, ${args.flag('no-ledger') ? 'no ledger' : `${m.name}'s ledger`}`;

  const ledger = args.flag('no-ledger') ? null : await deps.ledger(m.name);
  if (!args.flag('no-ledger') && !ledger) throw new CliError(`No .secrets/${m.name}/neon-usage-admin.url: run usage-setup ${m.name} roles, or pass --no-ledger for an env without a ledger`);
  const c: Ctx = { m, remote, scopeId: scope.data, ticket, deps, ledger };
  try {
    const plan = await planErasure(c, named);
    for (const l of formatPlan(plan, where)) deps.log(l);
    if (!args.flag('yes')) {
      deps.log('Dry run: nothing changed. Run again with --yes to erase.');
      return { plan };
    }
    const erased = await erase(c, plan);
    const after = await counts(c, { ...plan, eventsTable: plan.events !== null });
    const left = [after.ledger?.events, after.ledger?.appUsers, after.directory.users, after.directory.wallets, after.directory.identities, after.events, after.issuer?.apps, after.issuer?.emails].reduce<number>((a, b) => a + (b ?? 0), 0);
    if (left > 0) throw new Error(`Rows remain after the erasure (${left}); nothing was recorded. Run it again: every step is idempotent.`);
    if (c.ledger) {
      await c.ledger.query('INSERT INTO ops.erasures (ticket, operator, scope_id, rows) VALUES ($1, $2, $3, $4::jsonb)', [ticket, deps.operator.slice(0, 128), scope.data, JSON.stringify(erased)]);
    }
    deps.log(`Erased: ${Object.entries(erased).map(([k, v]) => `${k} ${v}`).join(', ')}.`);
    deps.log(c.ledger ? `Recorded in ops.erasures under ticket ${ticket}.` : 'No ledger: record the ticket and these counts in the support log by hand.');
    if (plan.otherScopes.length) deps.log(`Still to do: scope(s) ${plan.otherScopes.join(', ')}.`);
    return { plan, erased };
  } finally {
    await ledger?.close().catch(() => undefined);
  }
}
