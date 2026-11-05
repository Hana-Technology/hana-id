// uid-erase (lib/uid-erase.ts; batch C13, D361) and admin retention:issuer (lib/admin-retention.ts, D365) against the
// real migrations of all three stores: the usage ledger on PGlite as usage_admin (apps/api/migrations-usage), the
// API's D1 (node:sqlite, apps/api/migrations: the wallet directory of 0011) and the issuer's D1 (node:sqlite,
// apps/email-issuer/migrations). The chain is a fake view of get_identity / get_account. An erasure covers the account
// (root and members) in one scope across the three stores, leaves other users and other scopes alone, is dry run by
// default, re-countable to zero, recorded in ops.erasures without whom, and never touches what derivation reads.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { internalIdOf, uid } from '@hana-id/console-core';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { retentionIssuer } from '../lib/admin-retention.ts';
import { supportDirectory, supportLedger } from '../lib/admin-support.ts';
import { parseCli } from '../lib/cli.ts';
import { type LedgerConn, type UidEraseDeps, checkTicket, uidErase } from '../lib/uid-erase.ts';
import { newHotDb } from './hot-db.ts';

const KEY = new Uint8Array(32).fill(9);
const SCOPE = 's7';
const GOOGLE = { provider: 'google', sub: '110000000000000000001' };
const EMAIL = { provider: 'email', sub: 'e1.alice' };
const OTHER = { provider: 'google', sub: '220000000000000000002' };
const K_G = 'a'.repeat(64);
const K_E = 'b'.repeat(64);
const K_O = 'c'.repeat(64);
const DAY = 86_400_000;

const BASE = loadEnv('sandbox-dev');
const M = { ...BASE, name: 'sandbox-dev' } as Manifest;

function issuerDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(repoRoot, 'apps', 'email-issuer', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}

/** D1 as the private executor answers: every statement's rows, concatenated (RETURNING included). */
const d1 = (db: DatabaseSync) => async (statement: string) => statement.split(';\n').flatMap((s) => db.prepare(s).all() as Record<string, unknown>[]);

async function ledgerDb(): Promise<PGlite> {
  const db = new PGlite();
  const dir = join(repoRoot, 'apps', 'api', 'migrations-usage');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}
const asAdmin = (db: PGlite): LedgerConn => ({
  async query<T>(sql: string, params: unknown[] = []) {
    await db.exec('SET ROLE usage_admin');
    try {
      return (await db.query<T>(sql, params)).rows;
    } finally {
      await db.exec('RESET ROLE');
    }
  },
  close: async () => undefined,
});

const uidHex = async (i: { provider: string; sub: string }) => Buffer.from(await uid(KEY, { scopeId: SCOPE, ...i })).toString('hex');
const userOf = async (i: { provider: string; sub: string }) => internalIdOf(await uid(KEY, { scopeId: SCOPE, ...i }));

let api: DatabaseSync;
let issuer: DatabaseSync;
let ledger: PGlite;
let lines: string[];
let views: string[];

/** The chain: Alice's account in s7 is rooted at her Google identity with her email linked; Olivia is on her own. */
async function view(_m: Manifest, method: string, args: Record<string, string>): Promise<unknown> {
  views.push(`${method}:${args.provider}:${args.sub}`);
  if (args.scope_id !== SCOPE) throw new Error('unexpected scope');
  if (method === 'get_identity') {
    if (args.provider === EMAIL.provider && args.sub === EMAIL.sub) return { key: K_E, status: 'member', opened: true, root: GOOGLE, effective_at_ms: 1, account_epoch: 1 };
    if (args.provider === GOOGLE.provider && args.sub === GOOGLE.sub) return { key: K_G, status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 1 };
    return { key: K_O, status: 'own', opened: true, root: null, effective_at_ms: null, account_epoch: 0 };
  }
  if (args.provider === GOOGLE.provider && args.sub === GOOGLE.sub) return { root: GOOGLE, members: [{ key: K_E, provider: 'email', effective_at_ms: 1, active: true, auto: false }], epoch: 1, unlinked: [] };
  return null;
}

function deps(over: Partial<UidEraseDeps> = {}): UidEraseDeps {
  return {
    loadManifest: () => M,
    view,
    userIdKey: () => new Uint8Array(KEY),
    ledger: async () => asAdmin(ledger),
    apiD1: (_m, s) => d1(api)(s),
    issuerD1: (_m, s) => d1(issuer)(s),
    readLine: async () => EMAIL.sub,
    operator: 'cli:ops',
    log: (l) => void lines.push(l),
    ...over,
  };
}

async function seed(): Promise<void> {
  const root = await userOf(GOOGLE);
  const emailOwn = await userOf(EMAIL); // the email identity's own account, from before it was linked
  const other = await userOf(OTHER);
  let n = 0;
  // The User ID (`token_sub`, D346) is the identity token's sub: any well-formed one here.
  const u = { run: (id: string, code: string, scope: string) => api.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, 2)').run(id, `u1_${String(++n).padStart(21, 'A')}A`, code, scope) };
  const w = api.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?, 'stellar', ?, 0, 1, 2)");
  const i = api.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, first_seen_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, 2)");
  for (const [id, scope] of [[root, SCOPE], [emailOwn, SCOPE], [other, SCOPE], [`hu_${'1'.repeat(26)}`, 's8']] as const) u.run(id, id.slice(3, 11).toUpperCase(), scope);
  w.run(root, `G${'A'.repeat(55)}`);
  w.run(root, `G${'B'.repeat(55)}`);
  w.run(emailOwn, `G${'C'.repeat(55)}`);
  w.run(other, `G${'D'.repeat(55)}`);
  i.run(SCOPE, K_G, root, GOOGLE.provider, GOOGLE.sub, 'root');
  i.run(SCOPE, K_E, root, EMAIL.provider, EMAIL.sub, 'member');
  i.run(SCOPE, K_O, other, OTHER.provider, OTHER.sub, 'root');
  // The same Google account is also a user of another scope: not this erasure's.
  i.run('s8', 'd'.repeat(64), `hu_${'1'.repeat(26)}`, GOOGLE.provider, GOOGLE.sub, 'root');

  const e = issuer.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, 1, NULL, 1, 2)');
  const a = issuer.prepare('INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, 1, 2)');
  e.run(GOOGLE.provider, GOOGLE.sub, 'alice@gmail.com');
  e.run(EMAIL.provider, EMAIL.sub, 'alice@example.com');
  e.run(OTHER.provider, OTHER.sub, 'olivia@example.com');
  a.run(GOOGLE.provider, GOOGLE.sub, 'app_a', SCOPE);
  a.run(GOOGLE.provider, GOOGLE.sub, 'app_b', 's8');
  a.run(EMAIL.provider, EMAIL.sub, 'app_a', SCOPE);
  a.run(OTHER.provider, OTHER.sub, 'app_a', SCOPE);

  n = 0;
  for (const [who, app] of [[GOOGLE, 'app_a'], [GOOGLE, 'app_a2'], [EMAIL, 'app_a'], [OTHER, 'app_a']] as const) {
    const h = await uidHex(who);
    await ledger.query(
      `INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, status, latency_ms, relayed, uid) VALUES ($1, now(), 'org_a', $2, $3, 'login', 'ok', 200, 5, false, decode($4, 'hex'))`,
      [`erase-${++n}-xxxxxxxx`, app, SCOPE, h],
    );
    await ledger.query("INSERT INTO usage.app_users (app_id, uid, first_seen, last_seen) VALUES ($1, decode($2, 'hex'), now()::date, now()::date) ON CONFLICT DO NOTHING", [app, h]);
  }
}

const ledgerCount = async (who: { provider: string; sub: string }) => {
  const h = await uidHex(who);
  const [r] = (await ledger.query<{ e: number; u: number }>("SELECT (SELECT count(*)::int FROM usage.events WHERE uid = decode($1, 'hex')) AS e, (SELECT count(*)::int FROM usage.app_users WHERE uid = decode($1, 'hex')) AS u", [h])).rows;
  return r!;
};
const one = (db: DatabaseSync, s: string, ...p: (string | number)[]) => Number((db.prepare(s).get(...p) as { n: number }).n);

beforeEach(async () => {
  api = newHotDb();
  issuer = issuerDb();
  ledger = await ledgerDb();
  lines = [];
  views = [];
  await seed();
});
afterEach(async () => {
  await ledger.close();
});

const ARGV = ['sandbox-dev', '--scope', SCOPE, '--provider', EMAIL.provider, '--sub', EMAIL.sub, '--ticket', 'SUP-123'];

describe('uid-erase: the plan (dry run)', () => {
  it('reads the account from the chain and counts every store; changes nothing', async () => {
    const out = await uidErase(ARGV, deps());
    expect(views).toEqual([`get_identity:${EMAIL.provider}:${EMAIL.sub}`, `get_identity:${GOOGLE.provider}:${GOOGLE.sub}`, `get_account:${GOOGLE.provider}:${GOOGLE.sub}`]);
    const plan = out!.plan;
    expect(plan.account).toMatchObject({ root: { ...GOOGLE, key: K_G }, named: { ...EMAIL, key: K_E, status: 'member' } });
    expect(plan.account.keys.sort()).toEqual([K_G, K_E].sort());
    // The root's uid (the account's user id) and the member's own (from before the link).
    expect(plan.uids).toEqual([await uidHex(GOOGLE), await uidHex(EMAIL)]);
    expect(plan.ledger).toEqual({ events: 3, appUsers: 3 });
    expect(plan.directory).toEqual({ users: 2, wallets: 3, identities: 2 });
    // Alice's two app rows of s7; her email address row goes (no app row elsewhere), her Google one stays (s8).
    expect(plan.issuer).toEqual({ apps: 2, emails: 1 });
    expect(plan.otherScopes).toEqual(['s8']);
    expect(lines.join('\n')).toMatch(/Dry run: nothing changed/u);
    expect(lines.join('\n')).toMatch(/also seen in scope\(s\) s8/u);
    // The plan names each internal id with the User ID and Support ID partners and support see, when it has a row.
    expect(lines.join('\n')).toMatch(/hu_[0-9a-z]{26} \(User ID u1_A+1A, HANA-/u);
    // No address and no key in the output.
    expect(lines.join('\n')).not.toMatch(/@|alice@|olivia/u);
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_users')).toBe(4);
    expect((await ledgerCount(GOOGLE)).e).toBe(2);
  });
});

describe('uid-erase --yes: across the three stores', () => {
  it('erases the account’s rows in the ledger, the wallet directory and the issuer, records it, and leaves everyone else alone', async () => {
    const out = await uidErase([...ARGV, '--yes'], deps());
    expect(out!.erased).toEqual({ ledgerEvents: 3, ledgerAppUsers: 3, directoryWallets: 3, directoryIdentities: 2, directoryUsers: 2, issuerApps: 2, issuerEmails: 1 });
    // Ledger: the uids are gone, the rows stay (billing and counts unchanged).
    expect(await ledgerCount(GOOGLE)).toEqual({ e: 0, u: 0 });
    expect(await ledgerCount(EMAIL)).toEqual({ e: 0, u: 0 });
    expect(await ledgerCount(OTHER)).toEqual({ e: 1, u: 1 });
    expect(Number((await ledger.query<{ n: number }>('SELECT count(*)::int AS n FROM usage.events')).rows[0]!.n)).toBe(4);
    // Wallet directory: Alice's users in s7 with their wallets and identities; Olivia and s8 untouched.
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_users WHERE user_id IN (?, ?)', await userOf(GOOGLE), await userOf(EMAIL))).toBe(0);
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_user_identities WHERE scope_id = ? AND identity_key IN (?, ?)', SCOPE, K_G, K_E)).toBe(0);
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_users')).toBe(2);
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_user_wallets')).toBe(1);
    expect(one(api, "SELECT COUNT(*) AS n FROM end_user_identities WHERE scope_id = 's8'")).toBe(1);
    // Issuer: s7's app rows of both identities; the email address row; the Google row stays for s8.
    expect(one(issuer, 'SELECT COUNT(*) AS n FROM user_email_apps WHERE scope_id = ? AND provider IN (?, ?) AND sub IN (?, ?)', SCOPE, GOOGLE.provider, EMAIL.provider, GOOGLE.sub, EMAIL.sub)).toBe(0);
    expect(one(issuer, 'SELECT COUNT(*) AS n FROM user_emails WHERE provider = ? AND sub = ?', EMAIL.provider, EMAIL.sub)).toBe(0);
    expect(one(issuer, 'SELECT COUNT(*) AS n FROM user_emails WHERE provider = ? AND sub = ?', GOOGLE.provider, GOOGLE.sub)).toBe(1);
    expect(one(issuer, "SELECT COUNT(*) AS n FROM user_email_apps WHERE scope_id = 's8'")).toBe(1);
    expect(one(issuer, 'SELECT COUNT(*) AS n FROM user_emails WHERE provider = ? AND sub = ?', OTHER.provider, OTHER.sub)).toBe(1);
    // The record: ticket, operator, scope, counts; never a uid, a sub or an address.
    const rec = (await ledger.query<{ ticket: string; operator: string; scope_id: string; rows: Record<string, number> }>('SELECT ticket, operator, scope_id, rows FROM ops.erasures')).rows;
    expect(rec).toEqual([{ ticket: 'SUP-123', operator: 'cli:ops', scope_id: SCOPE, rows: out!.erased }]);
    expect(JSON.stringify(rec)).not.toMatch(new RegExp(`${EMAIL.sub}|${GOOGLE.sub}|${await uidHex(GOOGLE)}|@`, 'u'));
    expect(lines.join('\n')).toMatch(/Still to do: scope\(s\) s8/u);
  });

  it('leaves the Support ID lookup (C15) nothing to show for the account: no directory match, no ledger events by its uids', async () => {
    const root = await userOf(GOOGLE);
    const other = await userOf(OTHER);
    const lookup = async (internalId: string) => {
      const sources = { apiD1: d1(api), issuerD1: d1(issuer) };
      const byCode = await supportDirectory({ kind: 'supportId', code: internalId.slice(3, 11).toUpperCase() }, 30, sources);
      const byId = await supportDirectory({ kind: 'internalId', internalId }, 30, sources);
      return { byCode, byId };
    };
    const before = await lookup(root);
    expect([before.byCode.matches.length, before.byId.matches.length]).toEqual([1, 1]);
    const ledgerPart = await supportLedger(before.byId, 30, [], { ledger: async () => asAdmin(ledger), ledgerFile: 'x' });
    expect(ledgerPart.activity[0]).toHaveLength(2);
    await uidErase([...ARGV, '--yes'], deps());
    const after = await lookup(root);
    expect([after.byCode.matches, after.byId.matches]).toEqual([[], []]);
    // The ledger part is by the directory's internal ids, and the uids are NULLed besides: a lookup by the old uid finds nothing.
    const stale = await supportLedger({ ...before.byId }, 30, [], { ledger: async () => asAdmin(ledger), ledgerFile: 'x' });
    expect(stale.activity).toEqual([[]]);
    // The request IDs' events stay (billing), but carry no uid: none is this user's any more.
    const req = await supportLedger({ ...before.byId }, 30, ['erase-1-xxxxxxxx'], { ledger: async () => asAdmin(ledger), ledgerFile: 'x' });
    expect(req.requests!.map((r) => r.byMatch)).toEqual([false]);
    // Everyone else is still found.
    expect((await lookup(other)).byId.matches).toHaveLength(1);
  });

  it('is re-runnable: a second run finds nothing and still answers', async () => {
    await uidErase([...ARGV, '--yes'], deps());
    const again = await uidErase([...ARGV, '--yes'], deps());
    expect(again!.erased).toEqual({ ledgerEvents: 0, ledgerAppUsers: 0, directoryWallets: 0, directoryIdentities: 0, directoryUsers: 0, issuerApps: 0, issuerEmails: 0 });
  });

  it('works from the root identity too, with the sub on stdin', async () => {
    const out = await uidErase(['sandbox-dev', '--scope', SCOPE, '--provider', GOOGLE.provider, '--sub', '-', '--ticket', 'SUP-124', '--yes'], deps({ readLine: async () => GOOGLE.sub }));
    expect(out!.plan.account.named.status).toBe('own');
    expect(out!.erased).toMatchObject({ ledgerEvents: 3, directoryUsers: 2, issuerApps: 2 });
  });

  it('an env without an issuer erases the ledger and the wallet directory; --no-ledger skips the ledger and records nothing', async () => {
    const noIssuer = { ...M, emailIssuer: undefined } as Manifest;
    const out = await uidErase([...ARGV, '--yes', '--no-ledger'], deps({ loadManifest: () => noIssuer, issuerD1: async () => Promise.reject(new Error('no issuer')) }));
    expect(out!.erased).toEqual({ directoryWallets: 3, directoryIdentities: 2, directoryUsers: 2 });
    expect((await ledgerCount(GOOGLE)).e).toBe(2);
    expect((await ledger.query('SELECT 1 FROM ops.erasures')).rows).toEqual([]);
    expect(lines.join('\n')).toMatch(/record the ticket and these counts in the support log by hand/u);
  });
});

describe('uid-erase refusals', () => {
  it('needs a ticket without an address, a scope, a provider and a sub; testnet only; the ledger’s file unless --no-ledger', async () => {
    await expect(uidErase(ARGV.filter((a) => a !== '--ticket' && a !== 'SUP-123'), deps())).rejects.toThrow(/--ticket is required/u);
    expect(() => checkTicket('alice@example.com')).toThrow(/email address/u);
    expect(() => checkTicket('x'.repeat(129))).toThrow();
    await expect(uidErase(['sandbox-dev', '--scope', 'bad', '--provider', 'email', '--sub', 'x', '--ticket', 'T'], deps())).rejects.toThrow(/--scope/u);
    await expect(uidErase(['sandbox-dev', '--scope', SCOPE, '--provider', 'email', '--sub', 'a b', '--ticket', 'T'], deps())).rejects.toThrow(/Not a sub/u);
    await expect(uidErase(ARGV, deps({ loadManifest: () => ({ ...M, network: 'mainnet' }) as unknown as Manifest }))).rejects.toThrow(/not a testnet env/u);
    await expect(uidErase(ARGV, deps({ ledger: async () => null }))).rejects.toThrow(/neon-usage-admin\.url/u);
  });

  it('a chain read that fails stops before anything changes (the root is never guessed)', async () => {
    await expect(uidErase([...ARGV, '--yes'], deps({ view: async () => Promise.reject(new Error('RPC down')) }))).rejects.toThrow(/RPC down/u);
    await expect(uidErase([...ARGV, '--yes'], deps({ view: async () => ({ key: 'nope', status: 'own' }) }))).rejects.toThrow(/unexpected answer/u);
    expect(one(api, 'SELECT COUNT(*) AS n FROM end_users')).toBe(4);
    expect((await ledgerCount(GOOGLE)).e).toBe(2);
  });

  it('zeroes its copy of USER_ID_KEY after computing the uids', async () => {
    const copy = new Uint8Array(KEY);
    await uidErase(ARGV, deps({ userIdKey: () => copy }));
    expect([...copy].every((b) => b === 0)).toBe(true);
  });
});

describe('admin retention:issuer (the issuer’s part of the monthly job)', () => {
  it('deletes the user_email_apps rows of apps deleted 30 days ago and staff audit older than 60 months; dry run by default', async () => {
    const now = Date.UTC(2031, 0, 15);
    api.exec("INSERT INTO scopes (scope_id, org_id, environment, created_at, assigned_at) VALUES ('s9', 'org_legacy', 'test', 0, 0)");
    for (const [id, deleted] of [['app_old', now - 31 * DAY], ['app_new', now - 10 * DAY], ['app_live', null]] as const) {
      api.prepare("INSERT INTO apps (id, name, scope_id, publishable_key, created_at) VALUES (?, 'x', 's9', ?, 1)").run(id, `pk_test_${id}`);
      if (deleted !== null) api.prepare('UPDATE apps SET deleted_at = ? WHERE id = ?').run(deleted, id);
    }
    const a = issuer.prepare("INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES ('email', ?, ?, 's9', 1, 2)");
    a.run('e1.u1', 'app_old');
    a.run('e1.u2', 'app_old');
    a.run('e1.u1', 'app_new');
    a.run('e1.u1', 'app_live');
    const audit = issuer.prepare("INSERT INTO email_admin_audit (at_ms, staff, action, ticket) VALUES (?, 'staff@hana.example', 'unlock', 'T-1')");
    audit.run(Date.UTC(2025, 11, 1)); // more than 60 months before 2031-01-15
    audit.run(Date.UTC(2026, 1, 1));
    const run = (argv: string[]) =>
      retentionIssuer(parseCli(argv, { booleans: ['yes'] }), { api: 'local D1 api', issuer: 'local D1 issuer' }, { apiD1: (s) => api.prepare(s).all() as Record<string, unknown>[], issuerD1: d1(issuer), now: () => now, log: (l) => void lines.push(l) });
    expect(await run([])).toEqual({ apps: 1, appRows: 2, auditRows: 1 });
    expect(one(issuer, "SELECT COUNT(*) AS n FROM user_email_apps WHERE scope_id = 's9'")).toBe(4);
    expect(await run(['--yes'])).toEqual({ apps: 1, appRows: 2, auditRows: 1 });
    expect((issuer.prepare("SELECT app_id FROM user_email_apps WHERE scope_id = 's9' ORDER BY app_id").all() as { app_id: string }[]).map((r) => r.app_id)).toEqual(['app_live', 'app_new']);
    expect(one(issuer, 'SELECT COUNT(*) AS n FROM email_admin_audit')).toBe(1);
    // The identities' address rows stay (D269); only an erasure request removes them.
    expect(await run(['--yes'])).toEqual({ apps: 1, appRows: 0, auditRows: 0 });
  });
});
