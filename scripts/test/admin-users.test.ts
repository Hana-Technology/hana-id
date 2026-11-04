// admin.ts user:list and user:find (D269): the queries against the email issuer's real migrations (node:sqlite, with
// writes switched off: the commands are read only), the filters, the exact-address lookup (as typed and normalized),
// stdin input, the output (terminal lines and --json), and the wrangler call on the issuer's D1 with its log file off.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { loadEnv, repoRoot } from '@hana-id/env';
import { beforeEach, describe, expect, it } from 'vitest';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { type DirectoryUser, type UserCmdDeps, addressCandidates, ownPath, userFind, userFindSql, userList, userListSql } from '../lib/admin-users.ts';
import { parseCli } from '../lib/cli.ts';
import { PRIVATE_WRANGLER_ENV, issuerD1Argv } from '../lib/d1.ts';

const SPEC = { strings: ['app', 'provider', 'search', 'limit', 'email', 'sub'], booleans: ['json'] };
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
  // Read only from here on: a write would throw.
  db.exec('PRAGMA query_only = ON');
  const state = { db, out: [] as string[], statements: [] as string[], stdin: [] as string[] } as H;
  state.deps = {
    d1: (s) => {
      state.statements.push(s);
      return db.prepare(s).all() as Record<string, unknown>[];
    },
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
      firstSeenMs: T,
      lastSeenMs: T + 30 * MIN,
      apps: [
        { appId: 'app_other', scopeId: 's3', path: 's3#email#e1.alice#0', firstSeenMs: T + 5 * MIN, lastSeenMs: T + 30 * MIN },
        { appId: 'app_demo', scopeId: 's2', path: 's2#email#e1.alice#0', firstSeenMs: T, lastSeenMs: T + 10 * MIN },
      ],
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

  it('wrangler runs on emailIssuer.cloudflare.d1Name with its log file, metrics and error reports off', () => {
    const m = loadEnv('sandbox-dev');
    expect(m.emailIssuer).toBeDefined();
    const argv = issuerD1Argv(m, 'SELECT 1', { remote: true });
    expect(argv).toEqual(['exec', 'wrangler', 'd1', 'execute', m.emailIssuer!.cloudflare.d1Name, '--remote', '--json', '--command', 'SELECT 1']);
    expect(issuerD1Argv(m, 'SELECT 1', { remote: false })).toContain('--local');
    expect(PRIVATE_WRANGLER_ENV).toEqual({ WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' });
    expect(() => issuerD1Argv({ name: 'x', emailIssuer: undefined }, 'SELECT 1', { remote: false })).toThrow('has no emailIssuer');
  });

  it('the commands take no positionals; ownPath is the contract’s path format', () => {
    expect(() => assertCommandPositionals('user:list', ['alice'])).toThrow('Unexpected argument');
    expect(() => assertCommandPositionals('user:find', ['alice@example.com'])).toThrow('Unexpected argument');
    expect(ownPath('s1', 'google', '1102')).toBe('s1#google#1102#0');
  });
});
