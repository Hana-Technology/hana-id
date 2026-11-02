// admin.ts app:create, app:origins:add/remove, app:suspend/resume, app:list and app:changes:announce (docs/batch-c-spec.md
// §CLI) against a real SQLite database with every apps/api migration (0006 included), so each write also passes or is
// refused by the migrations' CHECKs and triggers. The rows they leave are the ones the API's gate reads
// (apps/api/test/guarded.test.ts covers the gate on rows of this shape).
import type { DatabaseSync } from 'node:sqlite';
import { loadEnv } from '@hana-id/env';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  type AppCmdDeps,
  appChangesAnnounce,
  appCreate,
  appList,
  appOriginsAdd,
  appOriginsRemove,
  appSuspension,
  cliActor,
  cliIds,
  findApp,
  STALE_WRITE,
  suspensionBits,
} from '../lib/admin-apps.ts';
import { addOriginsWrite, writeCommand } from '../lib/admin-sql.ts';
import { parseCli } from '../lib/cli.ts';
import { d1Of, newHotDb, seedHotApp, testIds } from './hot-db.ts';

const NOW = Date.UTC(2026, 10, 2, 9);
const sandbox = loadEnv('sandbox-dev');
const DELAY = sandbox.appChangeDelayMs;
const SPEC = { strings: ['org', 'name', 'scope', 'environment', 'plan', 'app'], multiple: ['origin'] };
/** Fixture publishable keys (public by design; low-entropy so they read as fixtures). */
const fixtureKey = (word: string) => `pk_test_${word.repeat(6)}`;
const APP_KEY = fixtureKey('App');
const OLD_KEY = fixtureKey('Old');
const OTHER_KEY = fixtureKey('Oth');
const REVOKED_KEY = fixtureKey('Rev');

interface H {
  db: DatabaseSync;
  out: string[];
  now: number;
  onChain: Set<string>;
  deps: AppCmdDeps;
}
let h: H;

beforeEach(() => {
  const db = newHotDb();
  const state = { db, out: [] as string[], now: NOW, onChain: new Set(['s1', 's7', 's8', 'global']) } as H;
  state.deps = {
    d1: d1Of(db),
    scopeOnChain: async (s) => state.onChain.has(s),
    now: () => state.now,
    log: (l) => state.out.push(l),
    actor: { id: 'cli:tester' },
    ids: testIds(),
  };
  h = state;
});

const out = () => h.out.join('\n');
const args = (argv: string[]) => parseCli(argv, SPEC);
const create = (argv: string[], m = sandbox) => appCreate(m, args(argv), 'local D1 test', h.deps);
const origins = (appId: string) => h.db.prepare('SELECT origin, active_from, change_id FROM app_origins WHERE app_id = ? ORDER BY origin').all(appId);
const change = (id: string) => h.db.prepare('SELECT id, kind, origin, status, waiver, notified_at, active_from, proposed_by_kind, proposed_by, cancelled_by, ended_at FROM guarded_changes WHERE id = ?').get(id);
const ledger = (appId: string) =>
  (h.db.prepare("SELECT kind, detail_json, actor_kind, actor_id FROM app_changes WHERE app_id = ? AND kind != 'migration.baseline' ORDER BY seq").all(appId) as { kind: string; detail_json: string; actor_kind: string; actor_id: string }[]).map(
    (r) => ({ ...r, detail: JSON.parse(r.detail_json) as Record<string, unknown> }),
  );
/** The gate's origin predicate (apps/api/src/apps.ts getAppByKey): the origins in force at `now`. */
const inForce = (appId: string, now: number) => (h.db.prepare('SELECT origin FROM app_origins WHERE app_id = ? AND active_from <= ? ORDER BY origin').all(appId, now) as { origin: string }[]).map((r) => r.origin);

describe('app:create', () => {
  it('on a new scope: needs --org and --environment, writes the scope, the app, its key by environment, origins as proposals with the no_session waiver', async () => {
    await expect(create(['--name', 'W', '--scope', 's7', '--origin', 'https://w.example.com'])).rejects.toThrow('--org is required');
    await expect(create(['--org', 'org_other', '--name', 'W', '--scope', 's7', '--origin', 'https://w.example.com'])).rejects.toThrow('until the console database exists');
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--origin', 'https://w.example.com'])).rejects.toThrow('pass --environment test|live');
    await create(['--org', 'org_legacy', '--name', 'Wallet', '--scope', 's7', '--environment', 'live', '--origin', 'https://W.example.com', '--origin', 'https://w2.example.com']);
    expect(h.db.prepare("SELECT org_id, environment, first_session_at, created_at, assigned_at FROM scopes WHERE scope_id = 's7'").get()).toEqual({ org_id: 'org_legacy', environment: 'live', first_session_at: null, created_at: NOW, assigned_at: NOW });
    expect(h.db.prepare("SELECT id, org_id, scope_id, publishable_key, status, suspended_by, origins_version FROM apps WHERE id = 'app_1'").get()).toEqual({
      id: 'app_1',
      org_id: 'org_legacy',
      scope_id: 's7',
      publishable_key: 'pk_live_PkPkPkPkPkPkPkPk1',
      status: 'active',
      suspended_by: 0,
      origins_version: 1,
    });
    expect(h.db.prepare("SELECT id, key, created_by, revoked_at FROM app_keys WHERE app_id = 'app_1'").all()).toEqual([{ id: 'key_1', key: 'pk_live_PkPkPkPkPkPkPkPk1', created_by: 'cli:tester', revoked_at: null }]);
    expect(origins('app_1')).toEqual([
      { origin: 'https://w.example.com', active_from: null, change_id: 'gc_1' },
      { origin: 'https://w2.example.com', active_from: null, change_id: 'gc_2' },
    ]);
    expect(change('gc_1')).toMatchObject({ kind: 'origin_add', status: 'pending', waiver: 'no_session', proposed_by_kind: 'hana', proposed_by: 'cli:tester', notified_at: null });
    expect(ledger('app_1')).toMatchObject([{ kind: 'app.created', actor_kind: 'hana', actor_id: 'cli:tester', detail: { scopeCreated: true, waiver: 'no_session', environment: 'live' } }]);
    expect(out()).toContain('app:changes:announce gc_1 (nobody is emailed)');
    // Not in force for the gate until announced.
    expect(inForce('app_1', NOW + 10 * DELAY)).toEqual([]);
  });

  it('on an existing scope: its environment, its org, no waiver, and refused within appChangeDelayMs of its assignment', async () => {
    seedHotApp(h.db, { id: 'app_old', key: OLD_KEY, scope: 's1', assignedAt: NOW - DELAY + 1 });
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's1', '--origin', 'https://w.example.com'])).rejects.toThrow('staff proposals on it are refused until');
    h.now = NOW + 1;
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's1', '--environment', 'live', '--origin', 'https://w.example.com'])).rejects.toThrow('is a test scope');
    await create(['--org', 'org_legacy', '--name', 'W', '--scope', 's1', '--origin', 'https://w.example.com']);
    expect(h.db.prepare("SELECT publishable_key FROM apps WHERE id = 'app_1'").get()).toEqual({ publishable_key: 'pk_test_PkPkPkPkPkPkPkPk1' });
    expect(change('gc_1')).toMatchObject({ waiver: null });
    expect(ledger('app_1')[0]!.detail).toMatchObject({ scopeCreated: false, waiver: null });
  });

  it('refuses a scope of another org, an unregistered scope, an unknown plan, bad origins, more than 20', async () => {
    seedHotApp(h.db, { id: 'app_o', key: OTHER_KEY, scope: 's8', orgId: 'org_other' });
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's8', '--origin', 'https://w.example.com'])).rejects.toThrow('belongs to org_other');
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's99', '--environment', 'test', '--origin', 'https://w.example.com'])).rejects.toThrow('is not registered');
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'test', '--plan', 'gold', '--origin', 'https://w.example.com'])).rejects.toThrow('No plan "gold"');
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'live', '--origin', 'http://localhost:5173'])).rejects.toThrow(/refused \(loopback\)/u);
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'test', '--origin', sandbox.vaultOrigin!])).rejects.toThrow(/refused \(refused\)/u);
    const many = Array.from({ length: 21 }, (_, i) => ['--origin', `https://a${i}.example.com`]).flat();
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'test', ...many])).rejects.toThrow('At most 20 origins');
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM scopes WHERE scope_id = 's7'").get()).toEqual({ n: 0 });
  });

  it('a scope created meanwhile aborts the whole write (no app, key or origin row)', async () => {
    const real = h.deps.d1;
    let raced = false;
    h.deps.d1 = (statement) => {
      if (!raced && statement.includes('INSERT INTO scopes')) {
        raced = true;
        h.db.exec("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s7', 'org_legacy', 'test', NULL, 0, 0)");
      }
      return real(statement);
    };
    await expect(create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'test', '--origin', 'https://w.example.com'])).rejects.toThrow(/UNIQUE|constraint/iu);
    expect(h.db.prepare('SELECT (SELECT COUNT(*) FROM apps) AS apps, (SELECT COUNT(*) FROM app_keys) AS keys, (SELECT COUNT(*) FROM guarded_changes) AS changes').get()).toEqual({ apps: 0, keys: 0, changes: 0 });
  });
});

describe('app:changes:announce', () => {
  const announce = (id: string, m = sandbox) => appChangesAnnounce(m, id, 'local D1 test', h.deps);

  it('starts the clock: active_from = now + appChangeDelayMs on the change and its origin row; recorded with channel cli, emailed none', async () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1', origins: ['https://old.example.com'] });
    appOriginsAdd(sandbox, args(['--app', 'app_a', '--origin', 'https://new.example.com']), 'local D1 test', h.deps);
    h.now = NOW + 5;
    announce('gc_1');
    expect(change('gc_1')).toMatchObject({ status: 'pending', notified_at: NOW + 5, active_from: NOW + 5 + DELAY, waiver: null });
    expect(origins('app_a')).toContainEqual({ origin: 'https://new.example.com', active_from: NOW + 5 + DELAY, change_id: 'gc_1' });
    expect(ledger('app_a').at(-1)).toMatchObject({ kind: 'change.announced', detail: { changeId: 'gc_1', channel: 'cli', emailed: 'none', activeFrom: NOW + 5 + DELAY } });
    expect(out()).toContain('Nobody was emailed');
    // The gate's predicate: refused until the clock passes, then allowed with no executor.
    expect(inForce('app_a', NOW + 5 + DELAY - 1)).toEqual(['https://old.example.com']);
    expect(inForce('app_a', NOW + 5 + DELAY)).toEqual(['https://new.example.com', 'https://old.example.com']);
    // Once only.
    expect(() => announce('gc_1')).toThrow('was already announced');
  });

  it('no_session waiver: in force at once while the scope has no login; the full delay once it has', async () => {
    await create(['--org', 'org_legacy', '--name', 'W', '--scope', 's7', '--environment', 'test', '--origin', 'https://a.example.com', '--origin', 'https://b.example.com']);
    announce('gc_1');
    expect(change('gc_1')).toMatchObject({ active_from: NOW, waiver: 'no_session' });
    h.db.exec("UPDATE scopes SET first_session_at = 1 WHERE scope_id = 's7'");
    announce('gc_2');
    expect(change('gc_2')).toMatchObject({ active_from: NOW + DELAY, waiver: null });
  });

  it('is refused with an admin Worker, on a production network, and for a change that is not pending', async () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1' });
    appOriginsAdd(sandbox, args(['--app', 'app_a', '--origin', 'https://new.example.com']), 'local D1 test', h.deps);
    const withAdmin = { ...sandbox, admin: {} as NonNullable<typeof sandbox.admin> };
    expect(() => announce('gc_1', withAdmin)).toThrow('has an admin Worker');
    expect(() => announce('gc_1', { ...sandbox, network: 'mainnet' as 'testnet' })).toThrow('refused on a production network');
    expect(() => announce('gc_nope')).toThrow('No guarded change gc_nope');
    appOriginsRemove(args(['--app', 'app_a', '--origin', 'https://new.example.com']), 'local D1 test', h.deps);
    expect(() => announce('gc_1')).toThrow('is cancelled, not pending');
    expect(change('gc_1')).toMatchObject({ notified_at: null });
  });
});

describe('app:origins:add', () => {
  beforeEach(() => seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1', origins: ['https://old.example.com'] }));
  const add = (...o: string[]) => appOriginsAdd(sandbox, args(['--app', 'app_a', ...o.flatMap((x) => ['--origin', x])]), 'local D1 test', h.deps);

  it('is a staff proposal: active_from NULL, a pending guarded change, one version bump and one app_changes row; never in force by itself', () => {
    add('https://new.example.com', 'http://localhost:5173');
    expect(origins('app_a')).toEqual([
      { origin: 'http://localhost:5173', active_from: null, change_id: 'gc_2' },
      { origin: 'https://new.example.com', active_from: null, change_id: 'gc_1' },
      { origin: 'https://old.example.com', active_from: 0, change_id: null },
    ]);
    expect(change('gc_2')).toMatchObject({ kind: 'origin_add', status: 'pending', proposed_by_kind: 'hana', waiver: null });
    expect(h.db.prepare("SELECT origins_version FROM apps WHERE id = 'app_a'").get()).toEqual({ origins_version: 1 });
    expect(ledger('app_a')).toMatchObject([{ kind: 'origin.proposed', detail: { changes: [{ changeId: 'gc_1' }, { changeId: 'gc_2' }] } }]);
    expect(inForce('app_a', NOW + 100 * DELAY)).toEqual(['https://old.example.com']);
  });

  it('skips origins already listed or proposed, and caps active-or-pending origins at 20', () => {
    add('https://new.example.com');
    add('https://new.example.com', 'https://old.example.com');
    expect(out()).toContain('https://new.example.com: already proposed, not announced (gc_1)');
    expect(out()).toContain('https://old.example.com: already in force (from before 0006)');
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM guarded_changes WHERE app_id = 'app_a'").get()).toEqual({ n: 1 });
    expect(() => add(...Array.from({ length: 19 }, (_, i) => `https://m${i}.example.com`))).toThrow('At most 20 active or pending origins');
    add(...Array.from({ length: 18 }, (_, i) => `https://m${i}.example.com`));
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM app_origins WHERE app_id = 'app_a'").get()).toEqual({ n: 20 });
  });

  it('refuses by the console-core rules, a deleted app, and a stale read', () => {
    expect(() => add('http://plain.example.com')).toThrow(/not_https/u);
    expect(() => add(sandbox.authOrigin!)).toThrow(/refused \(refused\)/u);
    h.db.exec("UPDATE apps SET deleted_at = 1 WHERE id = 'app_a'");
    expect(() => add('https://new.example.com')).toThrow('is deleted');
    h.db.exec("UPDATE apps SET deleted_at = NULL WHERE id = 'app_a'");
    const app = findApp(h.deps, 'app_a');
    h.db.exec("UPDATE apps SET origins_version = 1 WHERE id = 'app_a'");
    const rows = h.deps.d1(writeCommand(addOriginsWrite(app, [{ changeId: 'gc_s', origin: 'https://s.example.com' }], { now: NOW, actor: { id: 'x' }, requestId: 'stale' })));
    expect(rows.at(-1)).toEqual({ committed: 0 });
    expect(h.db.prepare("SELECT COUNT(*) AS n FROM guarded_changes WHERE id = 'gc_s'").get()).toEqual({ n: 0 });
    expect(STALE_WRITE).toContain('nothing was written');
  });
});

describe('app:origins:remove', () => {
  it('is immediate: rows gone, an origin in force ends, a pending one is cancelled, one version bump', () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1', origins: ['https://old.example.com'] });
    appOriginsAdd(sandbox, args(['--app', 'app_a', '--origin', 'https://p.example.com', '--origin', 'https://q.example.com']), 'local D1 test', h.deps);
    appChangesAnnounce(sandbox, 'gc_2', 'local D1 test', h.deps);
    h.now = NOW + DELAY;
    appOriginsRemove(args(['--app', APP_KEY, '--origin', 'https://old.example.com', '--origin', 'https://P.example.com', '--origin', 'https://q.example.com', '--origin', 'https://never.example.com']), 'local D1 test', h.deps);
    expect(origins('app_a')).toEqual([]);
    expect(change('gc_1')).toMatchObject({ status: 'cancelled', cancelled_by: 'cli:tester', ended_at: null });
    expect(change('gc_2')).toMatchObject({ status: 'ended', ended_at: NOW + DELAY, cancelled_by: null });
    expect(h.db.prepare("SELECT origins_version FROM apps WHERE id = 'app_a'").get()).toEqual({ origins_version: 2 });
    expect(ledger('app_a').at(-1)).toMatchObject({ kind: 'origin.removed' });
    expect(out()).toContain('https://never.example.com: not listed');
  });

  it('removes an entry the rules would now refuse, matched as given', () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1', origins: ['https://a;b.example.com'] });
    appOriginsRemove(args(['--app', 'app_a', '--origin', 'https://a;b.example.com']), 'local D1 test', h.deps);
    expect(origins('app_a')).toEqual([]);
  });
});

describe('app:suspend and app:resume', () => {
  it('set and clear Hana’s bit only; status follows the bitmask (trigger); resume keeps the org and partner bits', () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1' });
    const run = (suspend: boolean) => appSuspension(suspend, args(['--app', 'app_a']), 'local D1 test', h.deps);
    const state = () => h.db.prepare("SELECT status, suspended_by FROM apps WHERE id = 'app_a'").get();
    run(true);
    expect(state()).toEqual({ status: 'suspended', suspended_by: 1 });
    run(true);
    expect(out()).toContain('already suspended by Hana');
    h.db.exec("UPDATE apps SET suspended_by = 5 WHERE id = 'app_a'");
    run(false);
    expect(state()).toEqual({ status: 'suspended', suspended_by: 4 });
    expect(out()).toContain('Still suspended by another bit');
    h.db.exec("UPDATE apps SET suspended_by = 1 WHERE id = 'app_a'");
    run(false);
    expect(state()).toEqual({ status: 'active', suspended_by: 0 });
    expect(ledger('app_a').map((r) => r.kind)).toEqual(['suspension.set', 'suspension.cleared', 'suspension.cleared']);
    // A legacy status left 'suspended' with no bit (a pre-0006 CLI after the migration) is resumed too.
    h.db.exec("UPDATE apps SET status = 'suspended' WHERE id = 'app_a'");
    run(false);
    expect(state()).toEqual({ status: 'active', suspended_by: 0 });
    expect(suspensionBits(7)).toBe('hana+org+partner');
  });
});

describe('app:list', () => {
  it('shows the org, environment, suspension bits, keys (revoked marked), origins in force and pending changes', async () => {
    seedHotApp(h.db, { id: 'app_a', key: APP_KEY, scope: 's1', origins: ['https://old.example.com'] });
    appOriginsAdd(sandbox, args(['--app', 'app_a', '--origin', 'https://new.example.com']), 'local D1 test', h.deps);
    h.db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at, revoked_at) VALUES ('key_r', 'app_a', ?, 't', 2, 3)").run(REVOKED_KEY);
    h.db.exec("UPDATE apps SET suspended_by = 2 WHERE id = 'app_a'");
    appList('local D1 test', h.deps);
    expect(out()).toContain('app_a  suspended(org) org=org_legacy test scope=s1 plan=free  "Settings test"');
    expect(out()).toContain(`keys: ${APP_KEY} ${REVOKED_KEY} (revoked)`);
    expect(out()).toContain('origins: https://old.example.com');
    expect(out()).toContain('pending gc_1 origin_add https://new.example.com: not announced');
  });
});

describe('ids and actor', () => {
  it('uses console-core ids and the operator login as the actor', () => {
    expect(cliIds.change()).toMatch(/^gc_[1-9A-HJ-NP-Za-km-z]{12,17}$/u);
    expect(cliIds.key()).toMatch(/^key_/u);
    expect(cliIds.app()).toMatch(/^app_/u);
    expect(cliIds.publishableKey('live')).toMatch(/^pk_live_/u);
    expect(cliIds.request()).toMatch(/^cli_[0-9a-f-]{36}$/u);
    expect(cliActor().id).toMatch(/^cli:[A-Za-z0-9._-]+$/u);
  });
});
