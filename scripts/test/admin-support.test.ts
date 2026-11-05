// admin.ts support:lookup (lib/admin-support.ts; batch C15, D397) against the real migrations: the API's D1
// (node:sqlite, apps/api/migrations), the issuer's D1 (node:sqlite) and the usage ledger on PGlite as usage_admin. The
// code typed any way, every match of a shared code, the shares, the apps' changes in the window, the ledger's events by
// uid and by request ID, "ledger unavailable" without the ledger's file, the refusals, and the argument rules.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PGlite } from '@electric-sql/pglite';
import { formatSupportId, internalIdOf, uid } from '@hana-id/console-core';
import { repoRoot } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { type SupportCmdDeps, type SupportLedgerConn, supportChangesSql, supportLookupCommand, supportSharesSql } from '../lib/admin-support.ts';
import { parseCli } from '../lib/cli.ts';
import { newHotDb, seedHotApp } from './hot-db.ts';

const KEY = new Uint8Array(32).fill(5);
const SCOPE = 's9';
const ALICE = { provider: 'google', sub: '110000000000000000077' };
const DAY = 86_400_000;
const NOW = Date.now();
const SPEC = { strings: ['days'], multiple: ['request-id'], booleans: ['json', 'remote'] };

function issuerDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(repoRoot, 'apps', 'email-issuer', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}
async function ledgerDb(): Promise<PGlite> {
  const db = new PGlite();
  const dir = join(repoRoot, 'apps', 'api', 'migrations-usage');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) await db.exec(readFileSync(join(dir, f), 'utf8'));
  // The writer keeps partitions ahead; here the months the events fall in.
  await db.query('SELECT usage.ensure_partitions(1)');
  for (const t of [NOW - 60 * DAY, NOW - 30 * DAY]) {
    const d = new Date(t);
    const from = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const to = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
    await db.exec(`CREATE TABLE IF NOT EXISTS usage.events_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')} PARTITION OF usage.events FOR VALUES FROM ('${new Date(from).toISOString()}') TO ('${new Date(to).toISOString()}')`);
  }
  return db;
}
const asAdmin = (db: PGlite): SupportLedgerConn => ({
  async query(sql, params) {
    await db.exec('SET ROLE usage_admin');
    try {
      return (await db.query<Record<string, unknown>>(sql, params)).rows;
    } finally {
      await db.exec('RESET ROLE');
    }
  },
  close: async () => undefined,
});
const d1 = (db: DatabaseSync) => async (statement: string) => db.prepare(statement).all() as Record<string, unknown>[];
const sha = (s: string): Buffer => createHash('sha256').update(s, 'utf8').digest();

let api: DatabaseSync;
let issuer: DatabaseSync;
let ledger: PGlite;
let out: string[];
let aliceId: string;
const CODE = 'ABCD2345';
const ALICE_USER = `u1_${'A'.repeat(21)}A`;
const TWIN_USER = `u1_${'B'.repeat(21)}A`;

function deps(over: Partial<SupportCmdDeps> = {}): SupportCmdDeps {
  return {
    apiD1: d1(api),
    issuerD1: d1(issuer),
    ledger: async () => asAdmin(ledger),
    ledgerFile: '.secrets/sandbox-dev/neon-usage-admin.url',
    now: () => NOW,
    log: (l) => void out.push(l),
    readLine: async () => 'hana-abcd-2345',
    ...over,
  };
}

beforeEach(async () => {
  api = newHotDb();
  issuer = issuerDb();
  ledger = await ledgerDb();
  out = [];
  aliceId = internalIdOf(await uid(KEY, { scopeId: SCOPE, ...ALICE }));
  seedHotApp(api, { id: 'app_s9', key: 'pk_test_S9S9S9S9S9S9S9S9S9', scope: SCOPE, name: 'Demo', orgId: 'org_demo' });
  seedHotApp(api, { id: 'app_other', key: 'pk_test_OtherOtherOther1', scope: 's10', orgId: 'org_demo' });
  const u = api.prepare('INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?, ?, ?, ?, 1, ?)');
  u.run(aliceId, ALICE_USER, CODE, SCOPE, NOW - DAY);
  // Another user of another scope whose User ID shares the first 40 bits (a collision).
  u.run(`hu_${'2'.repeat(25)}0`, TWIN_USER, CODE, 's10', NOW - 2 * DAY);
  api.prepare("INSERT INTO end_user_identities (scope_id, identity_key, user_id, provider, sub, role, status, first_seen_at, observed_at) VALUES (?, ?, ?, ?, ?, 'root', 'active', 1, 2)").run(SCOPE, 'a'.repeat(64), aliceId, ALICE.provider, ALICE.sub);
  api.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?, 'evm', ?, 0, 1, 2)").run(aliceId, `0x${'1'.repeat(40)}`);
  // Two shares of Alice's path (one live, one revoked), one expired (not shown) and someone else's.
  const s = api.prepare('INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at, revoked_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)');
  const path = `${SCOPE}#${ALICE.provider}#${ALICE.sub}#0`;
  let n = 0;
  const share = (p: string, created: number, idle: number, abs: number, revoked: number | null) => s.run(Buffer.alloc(16, ++n), 'app_s9', Buffer.alloc(32, n), sha(p), 'https://app.example', Buffer.alloc(40), created, idle, abs, revoked);
  share(path, NOW - 2000, NOW + 3600_000, NOW + 7200_000, null);
  share(path, NOW - 3000, NOW + 3600_000, NOW + 7200_000, NOW - 1000);
  share(path, NOW - 9 * DAY, NOW - 8 * DAY, NOW - 8 * DAY, null);
  share(`${SCOPE}#google#someone-else#0`, NOW - 1000, NOW + 3600_000, NOW + 7200_000, null);
  // The app's changes: one in the window, one before it, one of another scope.
  const c = api.prepare("INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?, 'org_demo', ?, ?, ?, '{}', 'hana', 'staff', ?)");
  c.run(NOW - 40 * DAY, 'app_s9', SCOPE, 'origin.removed', 'req_change_old');
  c.run(NOW - DAY, 'app_s9', SCOPE, 'origin.added', 'req_change_recent');
  c.run(NOW - DAY, 'app_other', 's10', 'origin.added', 'req_change_elsewhere');
  issuer.prepare('INSERT INTO user_emails (provider, sub, email, email_verified, hosted, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, 1, 1, 1, 2)').run(ALICE.provider, ALICE.sub, 'alice@gmail.com');
  // The ledger: Alice's ok events (two in the window, one older), a failed request without a uid.
  const hex = Buffer.from(await uid(KEY, { scopeId: SCOPE, ...ALICE })).toString('hex');
  const ev = (rid: string, at: number, endpoint: string, outcome: string, code: string | null, uidHex: string | null) =>
    ledger.query(
      `INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, code, status, latency_ms, relayed, uid) VALUES ($1, $2, 'org_demo', 'app_s9', $3, $4, $5, $6, 200, 50, false, ${uidHex ? `decode('${uidHex}', 'hex')` : 'NULL'})`,
      [rid, new Date(at).toISOString(), SCOPE, endpoint, outcome, code],
    );
  await ev('req_login_00001', NOW - DAY, 'login', 'ok', null, hex);
  await ev('req_derive_0001', NOW - DAY / 2, 'derive', 'ok', null, hex);
  await ev('req_login_00old', NOW - 45 * DAY, 'login', 'ok', null, hex);
  await ev('req_failed_0001', NOW - DAY / 4, 'login', 'rejected', 'nonce_mismatch', null);
});
afterEach(async () => {
  await ledger.close();
});

const run = (input: string, argv: string[] = [], o: Partial<SupportCmdDeps> = {}) => supportLookupCommand(input, parseCli(argv, SPEC), deps(o));

describe('admin support:lookup', () => {
  it('resolves the code typed any way to every user sharing it, each with its accounts, apps, shares, changes and events', async () => {
    for (const input of ['HANA-ABCD-2345', 'hana-abcd-2345', 'abcd2345', 'ABCD-2345', 'hana abcd 2345']) {
      out = [];
      const v = await run(input);
      expect(v.matches.map((m) => m.user.userId), input).toEqual([ALICE_USER, TWIN_USER]);
    }
    const v = await run('HANA-ABCD-2345');
    const alice = v.matches[0]!;
    expect(alice.user.identities[0]!.directory.map((d) => d.email)).toEqual(['alice@gmail.com']);
    expect(alice.apps).toEqual([{ appId: 'app_s9', name: 'Demo', orgId: 'org_demo', environment: 'test', persistence: 'session', deletedAt: null }]);
    expect(alice.shares.map((s) => [s.live, s.revokedAt !== null, s.keyIndex])).toEqual([
      [true, false, 0],
      [false, true, 0],
    ]);
    expect(alice.changes.map((c) => c.requestId)).toEqual(['req_change_recent']);
    expect(v.ledger).toEqual({ available: true });
    expect(v.activity[0]!.map((e) => e.requestId)).toEqual(['req_derive_0001', 'req_login_00001']);
    expect(v.activity[1]).toEqual([]);
    const text = out.join('\n');
    expect(text).toMatch(/2 users for HANA-ABCD-2345/u);
    expect(text).toMatch(/More than one user has this code/u);
    expect(text).toMatch(/1 live of 2 not expired/u);
  });

  it('takes a User ID or an internal id, a wider window with --days, and the request IDs’ events with errors (--json)', async () => {
    const v = await run(ALICE_USER, ['--days', '60', '--request-id', 'req_failed_0001', '--request-id', 'req_login_00001', '--request-id', 'req_unknown_001', '--json']);
    expect(v.matches.map((m) => m.user.internalId)).toEqual([aliceId]);
    expect(v.activity[0]!.map((e) => e.requestId)).toEqual(['req_derive_0001', 'req_login_00001', 'req_login_00old']);
    expect(v.matches[0]!.changes.map((c) => c.requestId)).toEqual(['req_change_recent', 'req_change_old']);
    expect(v.requests!.map((r) => [r.requestId, r.outcome, r.code, r.byMatch])).toEqual([
      ['req_failed_0001', 'rejected', 'nonce_mismatch', false],
      ['req_login_00001', 'ok', null, true],
    ]);
    expect(v.requestsNotFound).toEqual(['req_unknown_001']);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ days: 60, ledger: { available: true } });
    expect((await run(aliceId.toUpperCase().replace('HU_', 'hu_'))).matches).toHaveLength(1);
  });

  it('says "ledger unavailable" without the ledger’s file or when it can’t connect, and still prints the rest', async () => {
    const v = await run('HANA-ABCD-2345', [], { ledger: async () => null });
    expect(v.ledger).toEqual({ available: false, reason: expect.stringMatching(/^ledger unavailable: no \.secrets\/sandbox-dev\/neon-usage-admin\.url/u) });
    expect([v.activity, v.requests, v.matches.length]).toEqual([[null, null], null, 2]);
    expect(out.join('\n')).toMatch(/Usage ledger: ledger unavailable/u);
    out = [];
    const down = await run('HANA-ABCD-2345', [], { ledger: async () => Promise.reject(new Error('ECONNREFUSED postgres://usage_admin:secret@host')) });
    expect(down.ledger).toEqual({ available: false, reason: 'ledger unavailable: no connection' });
    // A driver message (which can carry the URL) is never printed.
    expect(out.join('\n')).not.toMatch(/secret|postgres:/u);
  });

  it('a code nobody has: no match, and what to ask the partner for; the code on stdin with -', async () => {
    const v = await run('HANA-0000-0000');
    expect(v.matches).toEqual([]);
    expect(out.join('\n')).toMatch(/Ask the partner for the User ID/u);
    expect((await run('-')).matches).toHaveLength(2);
  });

  it('refuses a wallet, a sub, a bad request ID, too many of them and a window out of range', async () => {
    await expect(run(`0x${'1'.repeat(40)}`)).rejects.toThrow(/user:find first/u);
    await expect(run('some-google-sub')).rejects.toThrow(/Support ID/u);
    await expect(run('HANA-ABCD-2345', ['--request-id', 'short'])).rejects.toThrow(/--request-id/u);
    await expect(run('HANA-ABCD-2345', Array.from({ length: 21 }, (_, i) => ['--request-id', `req_${String(i).padStart(8, '0')}`]).flat())).rejects.toThrow(/At most 20/u);
    await expect(run('HANA-ABCD-2345', ['--days', '0'])).rejects.toThrow();
    await expect(run('HANA-ABCD-2345', ['--days', '732'])).rejects.toThrow();
  });

  it('takes exactly one positional; the SQL escapes every value and builds the path hashes itself', () => {
    expect(() => assertCommandPositionals('support:lookup', [])).toThrow(/exactly one/u);
    expect(() => assertCommandPositionals('support:lookup', ['a', 'b'])).toThrow(/exactly one/u);
    expect(() => assertCommandPositionals('support:lookup', ['HANA-ABCD-2345'])).not.toThrow();
    expect(() => supportSharesSql(['app'], ["0' OR 1=1 --"], NOW)).toThrow(/64 hex/u);
    expect(supportChangesSql("s'1", ["a'pp"], ["o'rg"], 0)).toContain("'s''1'");
    expect(formatSupportId(CODE)).toBe('HANA-ABCD-2345');
  });
});
