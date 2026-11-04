// admin.ts user:list and user:find (D269): the queries against the email issuer's real migrations (node:sqlite, with
// writes switched off: the commands are read only), the filters, the exact-address lookup (as typed and normalized),
// stdin input, the output (terminal lines and --json), and the wrangler call on the issuer's D1 with its log file off.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { deriveAddresses } from '@hana-id/core/derivation';
import { loadEnv, repoRoot } from '@hana-id/env';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { type DirectoryUser, UNVERIFIED_WARNING, type UserCmdDeps, type WalletUser, addressCandidates, ownPath, userFind, userFindCommand, userFindSql, userList, userListSql, walletQuery } from '../lib/admin-users.ts';
import { parseCli } from '../lib/cli.ts';
import { PRIVATE_WRANGLER_ENV, apiLocalD1Argv, issuerLocalD1Argv } from '../lib/d1.ts';
import { newHotDb } from './hot-db.ts';

const SPEC = { strings: ['app', 'provider', 'search', 'limit', 'email', 'sub', 'address', 'user'], booleans: ['json'] };
const T = Date.UTC(2026, 10, 4, 9);
const MIN = 60_000;
const WHERE = 'local D1 hana-id-email-issuer-test';

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(repoRoot, 'apps', 'email-issuer', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}

function seed(db: DatabaseSync): void {
  const u = db.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const a = db.prepare('INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)');
  // Alice: an email identity (normalized Gmail, dots removed) in two apps of two scopes.
  u.run('email', 'e1.alice', 'alicesmith@gmail.com', 1, null, T, T + 30 * MIN);
  a.run('email', 'e1.alice', 'app_demo', 's2', T, T + 10 * MIN);
  a.run('email', 'e1.alice', 'app_other', 's3', T + 5 * MIN, T + 30 * MIN);
  // Alice's Google account, the address as Google gives it (lowercased).
  u.run('google', '1100', 'alice.smith@gmail.com', 1, 1, T + MIN, T + 20 * MIN);
  a.run('google', '1100', 'app_demo', 's2', T + MIN, T + 20 * MIN);
  // Bob: Google, not Google-hosted, last seen first.
  u.run('google', '2200', 'bob@corp.example', 1, 0, T + 2 * MIN, T + 40 * MIN);
  a.run('google', '2200', 'app_other', 's3', T + 2 * MIN, T + 40 * MIN);
  // Carol: email, oldest.
  u.run('email', 'e1.carol', 'carol@example.com', 1, null, T, T);
  a.run('email', 'e1.carol', 'app_demo', 's2', T, T);
}

/** Mallory: a Google account that claims Bob's address, unverified by Google (email_verified = 0). */
function seedClaim(db: DatabaseSync, lastSeenMs: number = T + 50 * MIN): void {
  db.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run('google', '6600', 'bob@corp.example', 0, 0, T + 3 * MIN, lastSeenMs);
  db.prepare('INSERT INTO user_email_apps (provider, sub, app_id, scope_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run('google', '6600', 'app_other', 's3', T + 3 * MIN, lastSeenMs);
}

interface H {
  db: DatabaseSync;
  out: string[];
  statements: string[];
  stdin: string[];
  deps: UserCmdDeps;
}
let h: H;

beforeEach(() => {
  const db = newDb();
  seed(db);
  // Read only from here on (the tests that add a claim switch it back briefly): a write would throw.
  db.exec('PRAGMA query_only = ON');
  const state = { db, out: [] as string[], statements: [] as string[], stdin: [] as string[] } as H;
  state.deps = {
    d1: async (s) => {
      state.statements.push(s);
      return db.prepare(s).all() as Record<string, unknown>[];
    },
    apiD1: null,
    log: (l) => state.out.push(l),
    readLine: async () => {
      const l = state.stdin.shift();
      if (l === undefined) throw new Error('no stdin');
      return l;
    },
  };
  h = state;
});

const list = (...argv: string[]) => userList(parseCli(argv, SPEC), WHERE, h.deps);
const find = (...argv: string[]) => userFind(parseCli(argv, SPEC), WHERE, h.deps);
const ids = (us: DirectoryUser[]) => us.map((u) => `${u.provider}:${u.sub}`);

describe('user:list', () => {
  it('every user newest first by last seen, with apps newest first and each app’s own path', async () => {
    const us = await list();
    expect(ids(us)).toEqual(['google:2200', 'email:e1.alice', 'google:1100', 'email:e1.carol']);
    const alice = us[1]!;
    expect(alice).toEqual({
      email: 'alicesmith@gmail.com',
      provider: 'email',
      sub: 'e1.alice',
      emailVerified: true,
      hosted: null,
      unverifiedClaim: false,
      firstSeenMs: T,
      lastSeenMs: T + 30 * MIN,
      apps: [
        { appId: 'app_other', scopeId: 's3', path: 's3#email#e1.alice#0', firstSeenMs: T + 5 * MIN, lastSeenMs: T + 30 * MIN },
        { appId: 'app_demo', scopeId: 's2', path: 's2#email#e1.alice#0', firstSeenMs: T, lastSeenMs: T + 10 * MIN },
      ],
      accounts: [],
    });
    expect(us[0]!.hosted).toBe(false);
    expect(us[2]!.hosted).toBe(true);
    expect(us[2]!.apps[0]!.path).toBe('s2#google#1100#0');
  });

  it('the terminal output: a header, the path note, each user with its apps', async () => {
    await list();
    expect(h.out[0]).toBe(`4 users (${WHERE}), newest first by last seen`);
    expect(h.out[1]).toMatch(/^path: the identity’s own on-chain path; a linked member’s wallet is its account root’s/u);
    const text = h.out.join('\n');
    expect(text).toContain(
      [
        'alicesmith@gmail.com',
        '  provider  email',
        '  sub       e1.alice',
        '  verified  yes (a sign-in code)',
        '  seen      2026-11-04 09:00Z first, 2026-11-04 09:30Z last',
        '  apps      app_other (scope s3)  path s3#email#e1.alice#0  seen 2026-11-04 09:05Z first, 2026-11-04 09:30Z last',
        '            app_demo (scope s2)  path s2#email#e1.alice#0  seen 2026-11-04 09:00Z first, 2026-11-04 09:10Z last',
      ].join('\n'),
    );
    expect(text).toContain('  verified  yes (Google), not Google-hosted');
    expect(text).toContain('  verified  yes (Google), Google-hosted');
  });

  it('--json prints the users as JSON, nothing else', async () => {
    const us = await list('--json');
    expect(h.out).toHaveLength(1);
    expect(JSON.parse(h.out[0]!)).toEqual(us);
  });

  it('--app, --provider, --search (a plain substring, any case) and --limit, alone and together', async () => {
    expect(ids(await list('--app', 'app_other'))).toEqual(['google:2200', 'email:e1.alice']);
    expect(ids(await list('--provider', 'email'))).toEqual(['email:e1.alice', 'email:e1.carol']);
    expect(ids(await list('--search', 'ALICE'))).toEqual(['email:e1.alice', 'google:1100']);
    expect(ids(await list('--search', '@corp.'))).toEqual(['google:2200']);
    expect(ids(await list('--provider', 'google', '--app', 'app_demo', '--search', 'gmail'))).toEqual(['google:1100']);
    expect(ids(await list('--limit', '2'))).toEqual(['google:2200', 'email:e1.alice']);
    expect(h.out.filter((l) => l.endsWith('newest first by last seen (the first 2: --limit for more)'))).toEqual([`2 users (${WHERE}), newest first by last seen (the first 2: --limit for more)`]);
    // An app only finds its own users, even where the address search would match more.
    expect(ids(await list('--app', 'app_none'))).toEqual([]);
    expect(h.out.at(-1)).toBe(`0 users (${WHERE}; app app_none), newest first by last seen`);
  });

  it('the search is escaped, never SQL: quotes and wildcards match literally', async () => {
    expect(await list('--search', "' OR 1=1 --")).toEqual([]);
    expect(await list('--search', '%')).toEqual([]);
    expect(await list('--search', '_')).toEqual([]);
    expect(userListSql({ search: "o'k", limit: 5 })).toContain("instr(u.email, 'o''k') > 0");
  });

  it('--search - reads the text from stdin (kept out of the shell history)', async () => {
    h.stdin.push('  Bob@ ');
    expect(ids(await list('--search', '-'))).toEqual(['google:2200']);
    expect(h.statements.at(-1)).toContain("instr(u.email, 'bob@')");
  });

  it('refuses a bad provider, app id, limit or empty search, before any query', async () => {
    await expect(list('--provider', 'apple')).rejects.toThrow('--provider must be email or google');
    await expect(list('--app', "app'; DROP")).rejects.toThrow('--app takes an app id');
    await expect(list('--limit', '0')).rejects.toThrow('--limit must be between 1 and 1000');
    await expect(list('--limit', '1001')).rejects.toThrow('--limit must be between 1 and 1000');
    await expect(list('--search', '  ')).rejects.toThrow('--search takes part of an address');
    expect(h.statements).toEqual([]);
  });
});

describe('user:find', () => {
  it('by exact address: as typed (Google rows, lowercased) and normalized (email rows, Gmail dots removed)', async () => {
    const us = await find('--email', ' Alice.Smith@GMAIL.com ');
    expect(ids(us)).toEqual(['email:e1.alice', 'google:1100']);
    expect(addressCandidates(' Alice.Smith@GMAIL.com ')).toEqual(['alice.smith@gmail.com', 'alicesmith@gmail.com']);
    expect(h.out[0]).toBe(`2 users (${WHERE})`);
  });

  it('exact only: a part of an address finds nothing; --provider narrows', async () => {
    expect(await find('--email', 'alice@gmail.com')).toEqual([]);
    expect(h.out[0]).toBe(`No user with that address (${WHERE})`);
    expect(ids(await find('--email', 'alice.smith@gmail.com', '--provider', 'google'))).toEqual(['google:1100']);
  });

  it('by sub', async () => {
    expect(ids(await find('--sub', 'e1.carol'))).toEqual(['email:e1.carol']);
    expect(ids(await find('--sub', '2200', '--provider', 'email'))).toEqual([]);
    expect(h.out.at(-1)).toBe(`No user with that sub (${WHERE})`);
  });

  it('with neither flag, one line on stdin: an address if it has an @, else a sub', async () => {
    h.stdin.push('bob@corp.example', '1100');
    expect(ids(await find())).toEqual(['google:2200']);
    expect(ids(await find('--json'))).toEqual(['google:1100']);
    expect(JSON.parse(h.out.at(-1)!)).toHaveLength(1);
  });

  it('refuses both flags, a non-address, a malformed sub', async () => {
    await expect(find('--email', 'a@b.c', '--sub', 'x')).rejects.toThrow('not both');
    await expect(find('--email', 'nobody')).rejects.toThrow('Not an email address');
    await expect(find('--sub', 'a b')).rejects.toThrow('Not a sub');
    expect(() => userFindSql({ kind: 'email', candidates: [] })).toThrow('No address');
    expect(h.statements).toEqual([]);
  });
});

describe('unverified Google rows (email_verified = 0): a claim, never the owner', () => {
  const addClaim = (lastSeenMs?: number) => {
    h.db.exec('PRAGMA query_only = OFF');
    seedClaim(h.db, lastSeenMs);
    h.db.exec('PRAGMA query_only = ON');
  };

  it('user:find --email lists the verified owner first and the claim apart, under the warning', async () => {
    addClaim();
    const us = await find('--email', 'bob@corp.example');
    expect(ids(us)).toEqual(['google:2200', 'google:6600']);
    expect(us.map((u) => u.unverifiedClaim)).toEqual([false, true]);
    expect(h.out[0]).toBe(`1 user (${WHERE})`);
    const text = h.out.join('\n');
    const warning = text.indexOf(`${UNVERIFIED_WARNING}.`);
    expect(UNVERIFIED_WARNING).toBe('UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner');
    // The owner's block comes before the warning, the claim's after it.
    expect(warning).toBeGreaterThan(text.indexOf('  sub       2200'));
    expect(text.indexOf('  sub       6600')).toBeGreaterThan(warning);
    expect(text).toContain('bob@corp.example  [UNVERIFIED: claimed, not verified by Google]');
    expect(text).toContain('  verified  NO: Google hasn’t verified this address; the account only claims it, not Google-hosted');
    // The owner's own block carries no marker.
    expect(text.slice(0, warning)).not.toContain('UNVERIFIED');
  });

  it('the claim stays apart even when it was seen last (the SQL order would put it first)', async () => {
    addClaim(T + 90 * MIN);
    expect(ids(await find('--email', 'bob@corp.example'))).toEqual(['google:2200', 'google:6600']);
    expect(h.statements.at(-1)).toContain('ORDER BY u.last_seen_ms DESC');
  });

  it('only a claim: "No verified user", then the warning; never counted as a user', async () => {
    h.db.exec('PRAGMA query_only = OFF');
    h.db.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run('google', '7700', 'dave@example.org', 0, 0, T, T);
    h.db.exec('PRAGMA query_only = ON');
    const us = await find('--email', 'dave@example.org');
    expect(ids(us)).toEqual(['google:7700']);
    expect(h.out[0]).toBe(`No verified user with that address (${WHERE})`);
    expect(h.out).toContain(`${UNVERIFIED_WARNING}.`);
    expect(h.out).toContain('dave@example.org  [UNVERIFIED: claimed, not verified by Google]');
  });

  it('several claims: the warning counts them', async () => {
    addClaim();
    h.db.exec('PRAGMA query_only = OFF');
    h.db.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?, ?, ?)').run('google', '8800', 'bob@corp.example', 0, 0, T, T);
    h.db.exec('PRAGMA query_only = ON');
    await find('--email', 'bob@corp.example');
    expect(h.out).toContain(`${UNVERIFIED_WARNING} (2 Google accounts).`);
  });

  it('user:find --sub shows an unverified row marked the same way', async () => {
    addClaim();
    await find('--sub', '6600');
    expect(h.out[0]).toBe(`No verified user with that sub (${WHERE})`);
    expect(h.out).toContain(`${UNVERIFIED_WARNING}.`);
  });

  it('user:find --json: the verified first, each with unverifiedClaim', async () => {
    addClaim(T + 90 * MIN);
    await find('--email', 'bob@corp.example', '--json');
    expect(h.out).toHaveLength(1);
    expect((JSON.parse(h.out[0]!) as DirectoryUser[]).map((u) => [u.sub, u.emailVerified, u.unverifiedClaim])).toEqual([['2200', true, false], ['6600', false, true]]);
  });

  it('user:list marks each unverified row on its address line and counts them in a note', async () => {
    addClaim();
    const us = await list();
    expect(ids(us)[0]).toBe('google:6600');
    expect(us[0]!.unverifiedClaim).toBe(true);
    expect(us.filter((u) => u.unverifiedClaim)).toHaveLength(1);
    expect(h.out[1]).toBe('1 of them is a Google account whose address Google hasn’t verified, marked [UNVERIFIED: claimed, not verified by Google]: a claim, never the address’s owner.');
    const text = h.out.join('\n');
    expect(text.match(/\[UNVERIFIED: claimed, not verified by Google\]/gu)).toHaveLength(2); // the note and the row
    expect(text).toContain('bob@corp.example  [UNVERIFIED: claimed, not verified by Google]\n  provider  google\n  sub       6600');
    // Bob's own (verified) row is plain.
    expect(text).toContain('bob@corp.example\n  provider  google\n  sub       2200');
  });

  it('user:list without unverified rows prints no note; email rows are never claims', async () => {
    const us = await list();
    expect(us.every((u) => !u.unverifiedClaim)).toBe(true);
    expect(h.out.join('\n')).not.toContain('UNVERIFIED');
  });
});

describe('the issuer’s D1 and the command line', () => {
  it('every statement is one SELECT', async () => {
    h.stdin.push('carol@example.com');
    await list('--app', 'app_demo', '--search', 'a', '--provider', 'email');
    await find();
    await find('--sub', 'e1.alice');
    expect(h.statements).toHaveLength(3);
    for (const s of h.statements) {
      expect(s.startsWith('SELECT ')).toBe(true);
      expect(s).not.toMatch(/;|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/iu);
    }
  });

  it('wrangler runs on emailIssuer.cloudflare.d1Name, the statement in a file, with its log file, metrics and error reports off', () => {
    const m = loadEnv('sandbox-dev');
    expect(m.emailIssuer).toBeDefined();
    expect(issuerLocalD1Argv(m, '/r/.secrets/tmp/d1-x.sql')).toEqual(['exec', 'wrangler', 'd1', 'execute', m.emailIssuer!.cloudflare.d1Name, '--local', '--json', '--file', '/r/.secrets/tmp/d1-x.sql']);
    expect(PRIVATE_WRANGLER_ENV).toEqual({ WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' });
    expect(() => issuerLocalD1Argv({ name: 'x', emailIssuer: undefined }, 'f')).toThrow('has no emailIssuer');
  });

  it('the commands take no positionals; ownPath is the contract’s path format', () => {
    expect(() => assertCommandPositionals('user:list', ['alice'])).toThrow('Unexpected argument');
    expect(() => assertCommandPositionals('user:find', ['alice@example.com'])).toThrow('Unexpected argument');
    expect(ownPath('s1', 'google', '1102')).toBe('s1#google#1102#0');
  });
});

// ---- the wallet directory (D310, D316): the API's D1, migration 0011 ----

const ALICE_S2 = `hu_${'a'.repeat(26)}`;
const ALICE_S3 = `hu_${'b'.repeat(26)}`;
const BOB_S3 = `hu_${'c'.repeat(26)}`;
const ALICE_WALLET = deriveAddresses(new Uint8Array(32).fill(1));
const G_ALICE = ALICE_WALLET.stellar;
const EVM_ALICE = ALICE_WALLET.evm;
const G_BOB = deriveAddresses(new Uint8Array(32).fill(2)).stellar;
const G_NOBODY = deriveAddresses(new Uint8Array(32).fill(3)).stellar;

function walletDb(): DatabaseSync {
  const db = newHotDb();
  const u = db.prepare('INSERT INTO end_users (user_id, support_code, scope_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)');
  const w = db.prepare('INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?, ?, ?, 0, ?, ?)');
  const i = db.prepare('INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, effective_at, first_seen_at, observed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  // Alice in s2: her email identity is the root, her Google account a member; in s3: her email identity alone.
  u.run(ALICE_S2, 'AAAAAAAA', 's2', T, T + 10 * MIN);
  w.run(ALICE_S2, 'stellar', G_ALICE, T, T + 10 * MIN);
  w.run(ALICE_S2, 'evm', EVM_ALICE, T, T + 10 * MIN);
  i.run('s2', '1'.repeat(64), ALICE_S2, 'email', 'e1.alice', 'root', 'active', null, T, T);
  i.run('s2', '2'.repeat(64), ALICE_S2, 'google', '1100', 'member', 'active', T + MIN, T + MIN, T + MIN);
  u.run(ALICE_S3, 'BBBBBBBB', 's3', T + 5 * MIN, T + 30 * MIN);
  i.run('s3', '3'.repeat(64), ALICE_S3, 'email', 'e1.alice', 'root', 'active', null, T, T);
  // Bob in s3, with Alice's Stellar address too (a reused key: listed under two users).
  u.run(BOB_S3, 'CCCCCCCC', 's3', T + 2 * MIN, T + 40 * MIN);
  w.run(BOB_S3, 'stellar', G_BOB, T + 2 * MIN, T + 40 * MIN);
  w.run(BOB_S3, 'stellar', G_ALICE, T + 3 * MIN, T + 3 * MIN);
  i.run('s3', '4'.repeat(64), BOB_S3, 'google', '2200', 'root', 'active', null, T, T);
  db.exec('PRAGMA query_only = ON');
  return db;
}

function withWallets(): string[] {
  const db = walletDb();
  const apiStatements: string[] = [];
  h.deps.apiD1 = async (s) => {
    apiStatements.push(s);
    return db.prepare(s).all() as Record<string, unknown>[];
  };
  h.deps.now = () => T + 60 * MIN;
  return apiStatements;
}

const findAny = (...argv: string[]) => userFindCommand(parseCli(argv, SPEC), { issuer: WHERE, api: 'local D1 hana-id-test' }, h.deps);
const walletJson = (): WalletUser[] => JSON.parse(h.out.at(-1)!) as WalletUser[];

describe('user:list and user:find with the wallet directory', () => {
  it('each identity gets its user id, Support ID, role and the account’s wallets, per scope', async () => {
    withWallets();
    const us = await list();
    const alice = us.find((u) => u.sub === 'e1.alice')!;
    expect(alice.accounts.map((a) => [a.scopeId, a.userId, a.supportId, a.role])).toEqual([
      ['s3', ALICE_S3, 'HANA-BBBB-BBBB', 'root'],
      ['s2', ALICE_S2, 'HANA-AAAA-AAAA', 'root'],
    ]);
    expect(alice.accounts[1]!.wallets.map((w) => [w.chain, w.address])).toEqual([
      ['stellar', G_ALICE],
      ['evm', EVM_ALICE],
    ]);
    const google = us.find((u) => u.sub === '1100')!;
    expect(google.accounts.map((a) => [a.userId, a.role, a.status])).toEqual([[ALICE_S2, 'member', 'active']]);
    const text = h.out.join('\n');
    expect(text).toContain(`  user      ${ALICE_S2} (HANA-AAAA-AAAA) in scope s2: the account root`);
    expect(text).toContain(`  wallets   stellar ${G_ALICE}  key 0`);
    expect(text).toContain(`  user      ${ALICE_S2} (HANA-AAAA-AAAA) in scope s2: a member, active`);
    expect(text).toContain(`  user      ${ALICE_S3} (HANA-BBBB-BBBB) in scope s3: the account root\n  wallets   none recorded yet`);
  });

  it('user:find --email shows the wallets too; carol, never recorded, has none', async () => {
    withWallets();
    await find('--email', 'carol@example.com');
    expect(h.out.join('\n')).not.toContain('  user  ');
    h.out.length = 0;
    const [alice] = await find('--email', 'alicesmith@gmail.com');
    expect(alice!.accounts).toHaveLength(2);
  });

  it('user:find --address: every user listing the wallet, with each account’s sub, role and address; any EVM case', async () => {
    withWallets();
    await findAny('--address', EVM_ALICE.toLowerCase(), '--json');
    const [u] = walletJson();
    expect(u!.userId).toBe(ALICE_S2);
    expect(u!.identities.map((i) => [i.provider, i.sub, i.role, i.directory.map((d) => d.email)])).toEqual([
      ['email', 'e1.alice', 'root', ['alicesmith@gmail.com']],
      ['google', '1100', 'member', ['alice.smith@gmail.com']],
    ]);
    h.out.length = 0;
    await findAny('--address', G_ALICE);
    const text = h.out.join('\n');
    expect(h.out[0]).toBe('2 users with that wallet (local D1 hana-id-test)');
    expect(text).toContain('listed under more than one user');
    expect(text).toContain(`${BOB_S3} (HANA-CCCC-CCCC)  scope s3`);
    expect(text).toContain('[ALSO LISTED UNDER 1 OTHER USER');
    expect(text).toContain('  accounts  email   sub e1.alice  the account root  alicesmith@gmail.com');
    expect(text).toContain('            google  sub 1100  a member, active  alice.smith@gmail.com');
    h.out.length = 0;
    await findAny('--address', G_NOBODY);
    expect(h.out).toEqual(['No user with that wallet (local D1 hana-id-test)']);
  });

  it('user:find --user takes a user id or a Support ID in any form; a stdin line is read as whichever it is', async () => {
    withWallets();
    for (const v of [ALICE_S3, ALICE_S3.toUpperCase().replace('HU_', 'hu_'), 'HANA-BBBB-BBBB', 'hana bbbb bbbb', 'bbbbbbbb']) {
      h.out.length = 0;
      await findAny('--user', v, '--json');
      expect(walletJson().map((u) => u.userId), v).toEqual([ALICE_S3]);
    }
    h.out.length = 0;
    h.stdin.push(G_BOB);
    await findAny('--json');
    expect(walletJson().map((u) => u.userId)).toEqual([BOB_S3]);
    h.stdin.push('carol@example.com');
    await findAny();
    expect(h.out.join('\n')).toContain('carol@example.com');
  });

  it('refuses mixed or malformed flags, and works without an email issuer (no addresses)', async () => {
    withWallets();
    await expect(findAny('--address', 'hu_x')).rejects.toThrow('--address takes');
    await expect(findAny('--user', G_ALICE)).rejects.toThrow('--user takes');
    await expect(findAny('--address', G_ALICE, '--email', 'a@b.c')).rejects.toThrow('not --email and --address');
    await expect(findAny('--address', G_ALICE, '--provider', 'email')).rejects.toThrow('--provider goes with');
    expect(walletQuery(`G${'A'.repeat(54)}1`)).toBeNull();
    h.deps.d1 = null;
    h.out.length = 0;
    await findAny('--address', G_BOB);
    expect(h.out.join('\n')).toContain('This env has no email issuer: no addresses.');
    await expect(find('--sub', '2200')).rejects.toThrow('no emailIssuer');
  });

  it('every wallet-directory statement is one SELECT; the API’s D1 is read with the statement in a file', async () => {
    const apiStatements = withWallets();
    await list();
    await findAny('--address', G_ALICE);
    await findAny('--user', 'HANA-AAAA-AAAA');
    expect(apiStatements).toHaveLength(3);
    for (const s of apiStatements) {
      expect(s.startsWith('SELECT ')).toBe(true);
      expect(s).not.toMatch(/;|\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|PRAGMA)\b/iu);
    }
    const m = loadEnv('sandbox-dev');
    expect(apiLocalD1Argv(m, '/r/.secrets/tmp/d1-x.sql')).toEqual(['exec', 'wrangler', 'd1', 'execute', m.cloudflare.d1Name, '--local', '--json', '--file', '/r/.secrets/tmp/d1-x.sql']);
  });
});
