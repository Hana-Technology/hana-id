// admin home:client:add and home:listing: the chain check, the dry run, the writes and the refusals, on a real hot DB.
import { describe, expect, it } from 'vitest';
import { HOME_DRY_RUN_LINE, homeClientAdd, homeListing } from '../lib/admin-home.ts';
import { parseCli } from '../lib/cli.ts';
import { d1Of, newHotDb, seedHotApp } from './hot-db.ts';

const CLIENT = 'hana-branded.apps.googleusercontent.com';
const M = { name: 'sandbox-test', network: 'testnet', signer: 'signer.test.near', rpc: 'https://rpc.test' } as const;
const argv = (...a: string[]) => parseCli(a, { strings: ['scope'], multiple: ['client'], booleans: ['yes', 'quiet', 'normal'] });

function setup(view: unknown = { clients: [['google', CLIENT]] }, chainId = 'testnet') {
  const db = newHotDb();
  const logs: string[] = [];
  const calls: unknown[] = [];
  const deps = {
    d1: d1Of(db),
    rpc: {
      chainId: async () => chainId,
      view: async (_a: string, _m: string, args: unknown) => {
        calls.push(args);
        return view as never;
      },
    } as never,
    now: () => 1_700_000_000_000,
    log: (l: string) => logs.push(l),
  };
  const rows = () => db.prepare('SELECT provider, aud, scope_id, added_at FROM hana_held_clients').all() as Record<string, unknown>[];
  return { db, deps, logs, rows, calls };
}

describe('home:client:add', () => {
  it('without --yes only prints; with --yes records (google, client, scope), once', async () => {
    const t = setup();
    await homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT), 'local D1', t.deps);
    expect(t.logs).toContain(HOME_DRY_RUN_LINE);
    expect(t.rows()).toEqual([]);
    expect(t.calls).toEqual([{ scope_id: 's1' }]);

    await homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', t.deps);
    expect(t.rows()).toEqual([{ provider: 'google', aud: CLIENT, scope_id: 's1', added_at: 1_700_000_000_000 }]);

    await homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', t.deps);
    expect(t.rows()).toHaveLength(1);
    expect(t.logs.at(-1)).toContain('already recorded');
  });

  it('refuses a client the chain doesn’t list in the scope, and a scope the chain doesn’t have', async () => {
    const t = setup({ clients: [['google', 'another']] });
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', t.deps)).rejects.toThrow(/doesn't list/u);
    expect(t.rows()).toEqual([]);
    const email = setup({ clients: [['email', CLIENT]] });
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', email.deps)).rejects.toThrow(/doesn't list/u);
    const none = setup(null);
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', none.deps)).rejects.toThrow(/No scope/u);
  });

  it('refuses to move a client recorded for another scope, and writes nothing', async () => {
    const t = setup();
    t.db.prepare('INSERT INTO hana_held_clients (provider, aud, scope_id, added_at) VALUES (?, ?, ?, 1)').run('google', CLIENT, 's9');
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--yes'), 'local D1', t.deps)).rejects.toThrow(/s9/u);
    expect(t.rows()).toEqual([{ provider: 'google', aud: CLIENT, scope_id: 's9', added_at: 1 }]);
  });

  it('refuses a malformed scope or client, the wrong number of clients, and anything but testnet', async () => {
    const t = setup();
    await expect(homeClientAdd(M, argv('--scope', 'Bad!', '--client', CLIENT), 'local D1', t.deps)).rejects.toThrow(/Invalid scope id/u);
    await expect(homeClientAdd(M, argv('--scope', 's1'), 'local D1', t.deps)).rejects.toThrow(/exactly one --client/u);
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', 'a b'), 'local D1', t.deps)).rejects.toThrow(/Invalid client/u);
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT, '--client', 'x'), 'local D1', t.deps)).rejects.toThrow(/exactly one/u);
    await expect(homeClientAdd({ ...M, network: 'mainnet' as never }, argv('--scope', 's1', '--client', CLIENT), 'local D1', t.deps)).rejects.toThrow(/testnet/u);
    const mainnetRpc = setup(undefined, 'mainnet');
    await expect(homeClientAdd(M, argv('--scope', 's1', '--client', CLIENT), 'local D1', mainnetRpc.deps)).rejects.toThrow(/not a testnet RPC/u);
  });
});

describe('home:listing', () => {
  const seeded = () => {
    const t = setup();
    seedHotApp(t.db, { id: 'app_1', key: `pk_live_${'A'.repeat(32)}`, scope: 's1' });
    const quiet = () => (t.db.prepare("SELECT home_quiet AS q FROM scopes WHERE scope_id = 's1'").get() as { q: number }).q;
    return { ...t, quiet };
  };

  it('a new scope is normally listed; --quiet and --normal switch it, each dry unless --yes', () => {
    const t = seeded();
    expect(t.quiet()).toBe(0);
    homeListing(M, argv('--scope', 's1', '--quiet'), 'local D1', t.deps);
    expect(t.logs).toContain(HOME_DRY_RUN_LINE);
    expect(t.quiet()).toBe(0);
    homeListing(M, argv('--scope', 's1', '--quiet', '--yes'), 'local D1', t.deps);
    expect(t.quiet()).toBe(1);
    homeListing(M, argv('--scope', 's1', '--quiet', '--yes'), 'local D1', t.deps);
    expect(t.logs.at(-1)).toContain('already');
    homeListing(M, argv('--scope', 's1', '--normal', '--yes'), 'local D1', t.deps);
    expect(t.quiet()).toBe(0);
  });

  it('refuses an unknown scope, neither or both flags, and anything but testnet', () => {
    const t = seeded();
    expect(() => homeListing(M, argv('--scope', 's2', '--quiet', '--yes'), 'local D1', t.deps)).toThrow(/No scope/u);
    expect(() => homeListing(M, argv('--scope', 's1'), 'local D1', t.deps)).toThrow(/exactly one of/u);
    expect(() => homeListing(M, argv('--scope', 's1', '--quiet', '--normal'), 'local D1', t.deps)).toThrow(/exactly one of/u);
    expect(() => homeListing({ ...M, network: 'mainnet' as never }, argv('--scope', 's1', '--quiet'), 'local D1', t.deps)).toThrow(/testnet/u);
  });
});

describe('migration 0016', () => {
  it('home_quiet accepts 0 and 1 only and defaults to 0', () => {
    const db = newHotDb();
    seedHotApp(db, { id: 'app_1', key: `pk_live_${'B'.repeat(32)}`, scope: 's1' });
    expect((db.prepare("SELECT home_quiet AS q FROM scopes WHERE scope_id = 's1'").get() as { q: number }).q).toBe(0);
    expect(() => db.prepare("UPDATE scopes SET home_quiet = 2 WHERE scope_id = 's1'").run()).toThrow();
  });

  it('a client id is held at most once', () => {
    const db = newHotDb();
    const ins = db.prepare('INSERT INTO hana_held_clients (provider, aud, scope_id, added_at) VALUES (?, ?, ?, 1)');
    ins.run('google', 'c1', 's1');
    expect(() => ins.run('google', 'c1', 's2')).toThrow();
    ins.run('email', 'c1', 's2');
  });
});
