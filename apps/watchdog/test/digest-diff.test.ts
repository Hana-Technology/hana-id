import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import type { ChainSnapshot } from '../src/chain.ts';
import { diffChain, stable, type StoredSnapshot } from '../src/diff.ts';
import { maybeSendDigest } from '../src/digest.ts';
import { Store } from '../src/store.ts';
import { iso } from '../src/time.ts';
import { baseConfig, baseGovernance, councilPolicy, HOUR, initialized, MIN, OWNER, RecordingNotifier, T0 } from './helpers.ts';

const DAO_CODE = 'DAOcode1111111111111111111111111111111111111';
const snap = (over: { config?: Partial<ChainSnapshot['config']>; governance?: Partial<ChainSnapshot['governance']>; owner?: ChainSnapshot['owner'] } = {}): ChainSnapshot => ({
  keyChanges: [],
  issuer: null,
  issuerKeys: null,
  email: { issuer: null, issuerKeys: null, selfIssued: null, hasSelfIssuedView: true },
  linkStats: null,
  linkStatsProblem: null,
  config: { ...baseConfig(), ...over.config },
  governance: { ...baseGovernance(), ...over.governance },
  owner: over.owner !== undefined ? over.owner : { account_id: OWNER, code_hash: DAO_CODE, policy: councilPolicy() },
});
const stored = (s: ChainSnapshot): StoredSnapshot => ({ at: T0, config: s.config, governance: s.governance, keyChanges: [], owner: s.owner });
const none = { paused: false, deletedUpdaterKeys: [] };

describe('diffChain', () => {
  it('finds nothing when nothing changed, whatever the key order', () => {
    const s = snap();
    const reordered = JSON.parse(JSON.stringify(stored(s)), (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)) as StoredSnapshot;
    expect(diffChain(reordered, s, T0, none)).toEqual({ critical: [], warning: [], matured: [] });
    expect(stable({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe('{"a":[2,{"c":2,"d":1}],"b":1}');
  });

  it('treats a shared-client addition maturing as scheduled as info', () => {
    const prev = snap({ config: { pending_shared_clients: [{ provider: 'google', aud: 's1', effective_at_ms: T0 }] } });
    const cur = snap({ config: { shared_clients: [['google', 's1']], pending_shared_clients: [] } });
    expect(diffChain(stored(prev), cur, T0 + MIN, none)).toMatchObject({ warning: [], matured: [{ field: 'shared_clients' }] });
  });

  it('alerts on an addition that appears without having been pending', () => {
    const cur = snap({ config: { console_audiences: [['google', 'console.apps'], ['google', 'evil.apps']] } });
    expect(diffChain(stored(snap()), cur, T0, none).critical.map((c) => c.field)).toEqual(['console_audiences']);
  });

  it('skips only its own pause and updater-key deletions', () => {
    const prev = stored(snap());
    const cur = snap({ config: { paused: true }, governance: { updater_keys: [] } });
    const self = { paused: true, deletedUpdaterKeys: [...baseGovernance().updater_keys] };
    expect(diffChain(prev, cur, T0, self).critical).toEqual([]);
    // One more key gone than it deleted: alerted.
    expect(diffChain(prev, cur, T0, { paused: true, deletedUpdaterKeys: [baseGovernance().updater_keys[0]!] }).critical.map((c) => c.field)).toEqual(['updater_keys']);
  });

  it("alerts critical on any change of the owner DAO's policy or code (a ChangePolicy, AddMember or RemoveMember)", () => {
    const prev = stored(snap());
    const owner = (policy: unknown, code_hash = DAO_CODE) => snap({ owner: { account_id: OWNER, code_hash, policy } });
    const p = councilPolicy() as { roles: { kind: { Group: string[] } }[]; default_vote_policy: object };
    // A fourth member, a 1-of-n threshold, an Everyone role, new DAO code: each is critical.
    const added = { ...p, roles: [{ ...p.roles[0], kind: { Group: ['a.test.near', 'b.test.near', 'c.test.near', 'x.test.near'] } }] };
    const oneOf = { ...p, default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 3] } };
    const everyone = { ...p, roles: [...p.roles, { name: 'all', kind: 'Everyone', permissions: ['*:AddProposal'], vote_policy: {} }] };
    for (const policy of [added, oneOf, everyone]) {
      const d = diffChain(prev, owner(policy), T0, none);
      expect(d.critical).toEqual([{ field: 'owner_policy', before: councilPolicy(), after: policy }]);
    }
    expect(diffChain(prev, owner(councilPolicy(), 'OtherCode111111111111111111111111111111111111'), T0, none).critical.map((c) => c.field)).toEqual(['owner_code_hash']);
    // The same policy with its keys in another order is no change.
    const reordered = JSON.parse(JSON.stringify(councilPolicy()), (_k, v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).reverse()) : v)) as unknown;
    expect(diffChain(prev, owner(reordered), T0, none).critical).toEqual([]);
    // A snapshot stored before the watchdog read the owner: no alert, this run becomes the baseline.
    const { owner: _o, ...older } = prev;
    expect(diffChain(older, owner(oneOf), T0, none).critical).toEqual([]);
    // First run: whatever the owner is now is the baseline.
    expect(diffChain(null, owner(oneOf), T0, none).critical).toEqual([]);
  });

  it('alerts critical on an unpause between two runs and on a raised session floor', () => {
    // Paused and unpaused between two runs: `paused` is false both times, unpaused_at_ms moved.
    expect(diffChain(stored(snap()), snap({ config: { unpaused_at_ms: T0 - MIN, changes_unlock_floor_ms: T0 + HOUR } }), T0, none).critical.map((c) => c.field)).toEqual(['unpaused_at_ms']);
    expect(diffChain(stored(snap()), snap({ config: { sessions_valid_from_ms: T0 - MIN } }), T0, none).critical.map((c) => c.field)).toEqual(['sessions_valid_from_ms']);
  });

  it('alerts critical on fields only an upgrade can change', () => {
    const cur = snap({ config: { mpc: 'other.near', ckd_domain_id: 3 }, governance: { state_version: 3 } });
    expect(diffChain(stored(snap()), cur, T0, none).critical.map((c) => c.field)).toEqual(['mpc', 'ckd_domain_id', 'state_version']);
  });
});

describe('daily digest', () => {
  it('is sent once a day after the digest hour, with the alerts and actions since the last one', async () => {
    const w = await initialized();
    w.chain.propose('Add', 'ghost');
    await w.run();
    const n = new RecordingNotifier();
    const store = new Store(env.DB);
    const nextDay = T0 + 24 * HOUR;
    expect(await maybeSendDigest(store, n, nextDay - 13 * HOUR, 0, 'sandbox-test')).toBe('not_due'); // same day as T0's digest
    expect(await maybeSendDigest(store, n, nextDay, 13, 'sandbox-test')).toBe('not_due'); // 12:00 < 13:00
    expect(await maybeSendDigest(store, n, nextDay, 12, 'sandbox-test')).toBe('sent');
    expect(n.digests).toHaveLength(1);
    expect(n.digests[0]?.subject).toBe(`[Hana ID sandbox-test] Watchdog daily digest ${iso(nextDay).slice(0, 10)}`);
    expect(n.digests[0]?.text).toContain('[critical] Forged issuer key ghost');
    expect(n.digests[0]?.text).toContain('cancel_issuer_key_change {"id":10}: ok tx tx1');
    expect(n.digests[0]?.text).toMatch(/Unacknowledged critical alerts: 1 /u);
    expect(await maybeSendDigest(store, n, nextDay + HOUR, 12, 'sandbox-test')).toBe('not_due');
  });

  it('retries on the next run when the send fails, and skips without email credentials', async () => {
    const store = new Store(env.DB);
    const n = new RecordingNotifier();
    n.failing.add('digest');
    expect(await maybeSendDigest(store, n, T0, 0, 'e')).toBe('failed');
    n.failing.clear();
    expect(await maybeSendDigest(store, n, T0 + 5 * MIN, 0, 'e')).toBe('sent');
    const off = new RecordingNotifier();
    (off.digest as { configured: boolean }).configured = false;
    await env.DB.prepare('DELETE FROM meta').run();
    expect(await maybeSendDigest(store, off, T0, 0, 'e')).toBe('not_configured');
  });
});

describe('iso', () => {
  it('never throws on an out-of-range time', () => {
    expect(iso(T0)).toBe('2026-10-29T12:00:00.000Z');
    expect(iso(Number.MAX_SAFE_INTEGER)).toBe(`${Number.MAX_SAFE_INTEGER} ms`);
  });
});
