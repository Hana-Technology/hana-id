// The JWKS cron against hana-signer's delayed issuer-key changes (docs/governance-spec.md "Rotation and logins"):
// proposals, executions of matured changes, removals after 24 h missing from every fetch (never a key that signed a
// token in the last 24 h, never the last key; D422), cancelled proposals, and the updater key's method list.
import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { createExecutionContext, createScheduledController, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { base64UrlEncode } from '../src/bytes.ts';
import worker from '../src/index.ts';
import {
  GOOGLE_JWKS_URL,
  type Jwk,
  type KeyChange,
  JWKS_FETCHES_PER_RUN,
  KEEP_AFTER_LAST_TOKEN_MS,
  MAX_PENDING_KEY_CHANGES,
  REMOVE_AFTER_MISSING_MS,
  REPROPOSE_AFTER_CANCEL_MS,
  issuerKids,
  parseKeyChanges,
  planIssuerKeySync,
  sameKeyMaterial,
  syncIssuerKeys,
  usableJwks,
} from '../src/issuer-keys.ts';
import { rpcHealth } from '../src/near/rpc.ts';
import { UPDATER_METHODS } from '../src/relayer-config.ts';
import { NearMock, panic } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM issuer_key_missing'),
    env.DB.prepare('DELETE FROM issuer_key_proposals'),
    env.DB.prepare('DELETE FROM issuer_key_sync_runs'),
    env.DB.prepare('DELETE FROM issuer_key_observations'),
  ]);
});

/** A 2048-bit-sized modulus, distinct per seed, canonical base64url. */
const modulus = (seed: number): string => base64UrlEncode(Uint8Array.from({ length: 256 }, (_, i) => (seed * 31 + i * 7 + 1) % 256 || 1));
const seeds = new Map<string, number>();
const seedOf = (kid: string): number => {
  if (!seeds.has(kid)) seeds.set(kid, seeds.size + 1);
  return seeds.get(kid)!;
};
const jwk = (kid: string, extra: Partial<Jwk> = {}): Jwk => ({ kid, n: modulus(seedOf(kid)), e: 'AQAB', kty: 'RSA', alg: 'RS256', use: 'sig', ...extra });
const updaterPk = (): string => KeyPair.fromString(env.KEYS_UPDATER_KEY as KeyPairString).getPublicKey().toString();
const empty = { proposed: [], removalsProposed: [], executed: [], failed: [], cancelled: [], notes: [] };

const T0 = Date.UTC(2026, 9, 29, 12, 0);
const DELAY = 2 * 60 * 60_000;
const SIGNER = 'signer.test.near';

interface Gov extends NearMock {
  /** Active keys on chain: kid → key material. */
  active: Map<string, { n: string; e: string }>;
  changes: KeyChange[];
  paused: boolean;
  /** The contract's clock (block time). */
  clock: number;
}

/**
 * A NearMock with hana-signer's issuer-key rules: set_issuer_key / propose_issuer_key_removal queue a change due
 * after DELAY (the contract's checks, in its order), execute_issuer_key_change applies a matured one. Any other
 * method panics like a method the key may not call.
 */
function govChain(active: string[], opts: { jwks?: string[] } = {}): Gov {
  const near: Gov = Object.assign(new NearMock(), { active: new Map(active.map((kid) => [kid, { n: jwk(kid).n, e: 'AQAB' }])), changes: [] as KeyChange[], paused: false, clock: T0 });
  let nextId = 1;
  near.jwks = { keys: (opts.jwks ?? active).map((kid) => jwk(kid)) };
  near.views.get_issuer = (a) => (a.provider === 'google' ? { provider: 'google', iss_values: ['https://accounts.google.com'], kids: [...near.active.keys()] } : null);
  near.views.get_key_changes = () => near.changes.map((c) => ({ ...c }));
  near.views.get_config = () => ({ paused: near.paused, issuer_key_delay_ms: DELAY });
  const queue = (provider: string, kid: string, op: 'Add' | 'Remove', key: { n: string; e: string } | null, by: string): number => {
    if (near.changes.some((c) => c.provider === provider && c.kid === kid)) throw new Error('Kid already has a pending change');
    if (near.changes.length >= 6) throw new Error('Too many pending key changes');
    const id = nextId++;
    near.changes.push({ id, provider, kid, op, n: key?.n ?? null, e: key?.e ?? null, by, proposed_at_ms: near.clock, executable_at_ms: near.clock + DELAY });
    return id;
  };
  near.contract.set_issuer_key = (a, tx) => {
    if (near.active.has(a.kid as string)) throw new Error('Kid is already active');
    return queue(a.provider as string, a.kid as string, 'Add', { n: a.n as string, e: a.e as string }, tx.signerId);
  };
  near.contract.propose_issuer_key_removal = (a, tx) => {
    if (!near.active.has(a.kid as string)) throw new Error('No such key');
    const removals = near.changes.filter((c) => c.op === 'Remove').length;
    if (near.active.size - removals <= 1) throw new Error('Cannot remove the last key of an issuer');
    return queue(a.provider as string, a.kid as string, 'Remove', null, tx.signerId);
  };
  near.contract.execute_issuer_key_change = (a) => {
    if (near.paused) throw new Error('Paused');
    const c = near.changes.find((x) => x.id === a.id);
    if (!c) throw new Error('No such key change');
    if (near.clock < c.executable_at_ms) throw new Error('Key change is still delayed');
    if (c.op === 'Add') near.active.set(c.kid, { n: c.n!, e: c.e! });
    else {
      if (near.active.size <= 1) throw new Error('Cannot remove the last key of an issuer');
      near.active.delete(c.kid);
    }
    near.changes = near.changes.filter((x) => x !== c);
    return null;
  };
  near.contract.remove_issuer_key = () => {
    throw new Error('Only the owner can do this');
  };
  near.install();
  return near;
}

/** Runs the sync at the contract's clock. */
const run = (near: Gov, e: typeof env = env) => syncIssuerKeys(e, 'google', GOOGLE_JWKS_URL, near.clock);
const methods = (near: NearMock): [string, unknown][] => near.sent.map((t) => [t.method, t.method === 'execute_issuer_key_change' ? t.args.id : t.args.kid]);
const proposals = async (): Promise<Record<string, unknown>[]> => (await env.DB.prepare('SELECT kid, op, change_id, cancelled_seen_at FROM issuer_key_proposals ORDER BY kid, op').all()).results;

describe('JWKS parsing', () => {
  it('keeps only RS256 RSA signing keys', () => {
    const keys = usableJwks({
      keys: [jwk('ok'), jwk('noalg', { alg: undefined }), jwk('es', { kty: 'EC' }), jwk('ps', { alg: 'PS256' }), jwk('enc', { use: 'enc' }), jwk('bad-n', { n: 'a+b/' }), { kid: 5 }],
    });
    expect(keys.map((k) => k.kid)).toEqual(['ok', 'noalg']);
    expect(usableJwks(null)).toEqual([]);
    expect(usableJwks({ keys: 'x' })).toEqual([]);
  });

  it('reads kids from the get_issuer view in its accepted shapes', () => {
    expect(issuerKids({ kids: ['a'] })).toEqual(['a']);
    expect(issuerKids({ keys: ['a'] })).toEqual(['a']);
    expect(issuerKids(['a', 1])).toEqual(['a']);
    expect(issuerKids(null)).toBeNull();
  });

  it('reads get_key_changes, refusing a list with any malformed entry', () => {
    const add = { id: 1, provider: 'google', kid: 'a', op: 'Add', n: 'AQAB', e: 'AQAB', by: SIGNER, proposed_at_ms: 1, executable_at_ms: 2 };
    const remove = { ...add, id: 2, op: 'Remove', n: null, e: null };
    expect(parseKeyChanges([add, remove])).toEqual([add, remove]);
    expect(parseKeyChanges([])).toEqual([]);
    for (const bad of [null, {}, [{ ...add, op: 'Replace' }], [{ ...add, n: null }], [{ ...add, id: '1' }], [add, { ...remove, executable_at_ms: undefined }]]) expect(parseKeyChanges(bad)).toBeNull();
  });

  it('compares key material after stripping leading zeros, base64url or base64', () => {
    const n = modulus(9);
    const padded = base64UrlEncode(Uint8Array.from([0, 0, ...(Uint8Array.from(atob(n.replace(/-/gu, '+').replace(/_/gu, '/')), (c) => c.charCodeAt(0)))]));
    expect(sameKeyMaterial({ n, e: 'AQAB' }, { n: padded, e: 'AAEAAQ' })).toBe(true);
    expect(sameKeyMaterial({ n, e: 'AQAB' }, { n: n.replace(/-/gu, '+').replace(/_/gu, '/'), e: 'AQAB' })).toBe(true);
    expect(sameKeyMaterial({ n, e: 'AQAB' }, { n: modulus(10), e: 'AQAB' })).toBe(false);
    expect(sameKeyMaterial({ n, e: 'AQAB' }, { n, e: 'Aw' })).toBe(false);
    expect(sameKeyMaterial({ n, e: 'AQAB' }, { n: null, e: null })).toBe(false);
    // Non-canonical base64url never matches (the contract would refuse it).
    expect(sameKeyMaterial({ n: 'xx', e: 'AQAB' }, { n: 'xx', e: 'AQAB' })).toBe(false);
  });
});

describe('sync plan', () => {
  const change = (id: number, kid: string, op: 'Add' | 'Remove', executableAt: number, extra: Partial<KeyChange> = {}): KeyChange => ({
    id,
    provider: 'google',
    kid,
    op,
    n: op === 'Add' ? jwk(kid).n : null,
    e: op === 'Add' ? 'AQAB' : null,
    by: SIGNER,
    proposed_at_ms: 0,
    executable_at_ms: executableAt,
    ...extra,
  });
  const base = { provider: 'google', paused: false, now: 100, dueRemovals: [] as string[], held: new Set<string>() };

  it('proposes new kids once, skipping active and pending ones', () => {
    const plan = planIssuerKeySync({ ...base, jwks: [jwk('a'), jwk('b'), jwk('c'), jwk('c')], active: ['a'], changes: [change(1, 'b', 'Add', 500)] });
    expect(plan).toEqual({ execute: [], propose: [jwk('c')], proposeRemoval: [], notes: [] });
  });

  it('executes matured changes that agree with the JWKS, in id order, and nothing while paused', () => {
    const changes = [change(3, 'old', 'Remove', 50), change(2, 'b', 'Add', 100), change(4, 'c', 'Add', 101)];
    const input = { ...base, jwks: [jwk('a'), jwk('b'), jwk('c')], active: ['a', 'old'], changes };
    expect(planIssuerKeySync(input).execute.map((c) => c.id)).toEqual([2, 3]);
    const paused = planIssuerKeySync({ ...input, paused: true });
    expect(paused.execute).toEqual([]);
    expect(paused.notes).toEqual([{ code: 'paused', kid: 'b', id: 2 }]);
  });

  it('leaves changes that disagree with the JWKS to the watchdog and the owner', () => {
    const changes = [
      change(1, 'forged', 'Add', 0, { by: 'owner.test.near' }),
      change(2, 'swapped', 'Add', 0, { n: modulus(99) }),
      change(3, 'live', 'Remove', 0),
    ];
    const plan = planIssuerKeySync({ ...base, jwks: [jwk('live'), jwk('swapped')], active: ['live', 'x'], changes });
    expect(plan.execute).toEqual([]);
    expect(plan.propose).toEqual([]);
    expect(plan.notes).toEqual([
      { code: 'unpublished_change', kid: 'forged', id: 1 },
      { code: 'pending_mismatch', kid: 'swapped', id: 2 },
      { code: 'removal_of_published_kid', kid: 'live', id: 3 },
    ]);
  });

  it('never plans away the last active key, at proposal or execution', () => {
    expect(planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['old'], changes: [], dueRemovals: ['old'] })).toMatchObject({ proposeRemoval: [], notes: [{ code: 'last_key_kept', kid: 'old' }] });
    // A matured Remove of the only key (e.g. queued by the owner): not executed.
    expect(planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['old'], changes: [change(1, 'old', 'Remove', 0)] })).toMatchObject({
      execute: [],
      notes: [{ code: 'last_key_kept', kid: 'old', id: 1 }],
    });
    // Two keys, both due for removal: only one goes.
    expect(planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['a', 'b'], changes: [change(1, 'new', 'Add', 500)], dueRemovals: ['a', 'b'] }).proposeRemoval).toEqual(['a']);
    // A matured Add executed in the same run makes room for a matured Remove.
    expect(planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['old'], changes: [change(1, 'new', 'Add', 0), change(2, 'old', 'Remove', 0)] }).execute.map((c) => c.id)).toEqual([1, 2]);
  });

  it('respects the queue and issuer caps, and holds what was cancelled', () => {
    const full = Array.from({ length: MAX_PENDING_KEY_CHANGES }, (_, i) => change(i + 1, `p${i}`, 'Add', 500, { provider: i % 2 ? 'other' : 'google' }));
    expect(planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['a'], changes: full })).toMatchObject({ propose: [], notes: [{ code: 'queue_full', kid: 'new' }] });
    const tenActive = Array.from({ length: 9 }, (_, i) => `k${i}`);
    const plan = planIssuerKeySync({ ...base, jwks: [jwk('n1'), jwk('n2')], active: tenActive, changes: [] });
    expect(plan.propose.map((k) => k.kid)).toEqual(['n1']);
    expect(plan.notes).toEqual([{ code: 'issuer_full', kid: 'n2' }]);
    const held = planIssuerKeySync({ ...base, jwks: [jwk('new')], active: ['a', 'b'], changes: [], dueRemovals: ['b'], held: new Set(['Add:new', 'Remove:b']) });
    expect(held).toMatchObject({ propose: [], proposeRemoval: [], notes: [{ code: 'held_after_cancel', kid: 'new' }, { code: 'held_after_cancel', kid: 'b' }] });
  });
});

describe('scheduled JWKS sync', () => {
  it('runs on every 15-minute trigger: proposes new kids with the updater key, records them, never installs', async () => {
    const near = govChain(['kept'], { jwks: ['kept', 'new1', 'new2'] });
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: '*/15 * * * *', scheduledTime: T0 + 15 * 60_000 }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(methods(near)).toEqual([
      ['set_issuer_key', 'new1'],
      ['set_issuer_key', 'new2'],
    ]);
    expect(near.sent[0]!.args).toEqual({ provider: 'google', kid: 'new1', n: jwk('new1').n, e: 'AQAB' });
    // Signed by the keys-updater key on the signer account itself, consecutive nonces, 30 Tgas.
    expect(near.sent.every((t) => t.signerId === SIGNER && t.receiverId === SIGNER && t.publicKey === updaterPk())).toBe(true);
    expect(near.sent.map((t) => t.nonce)).toEqual([101n, 102n]);
    expect(near.sent.every((t) => t.gas === 30_000_000_000_000n)).toBe(true);
    // Queued, not active: logins with them wait (handlers.ts chainGate).
    expect([...near.active.keys()]).toEqual(['kept']);
    expect(near.changes.map((c) => [c.id, c.kid, c.op])).toEqual([
      [1, 'new1', 'Add'],
      [2, 'new2', 'Add'],
    ]);
    expect(await proposals()).toEqual([
      { kid: 'new1', op: 'Add', change_id: 1, cancelled_seen_at: null },
      { kid: 'new2', op: 'Add', change_id: 2, cancelled_seen_at: null },
    ]);
  });

  it('skips kids already pending, then executes them once due, and forgets the proposals once applied', async () => {
    const near = govChain(['kept'], { jwks: ['kept', 'new'] });
    expect(await run(near)).toEqual({ ...empty, proposed: ['new'] });
    near.clock += 15 * 60_000;
    expect(await run(near)).toEqual(empty);
    near.clock = T0 + DELAY - 1;
    expect(await run(near)).toEqual(empty);
    expect(near.sent).toHaveLength(1);
    near.clock = T0 + DELAY;
    expect(await run(near)).toEqual({ ...empty, executed: [1] });
    expect(methods(near).at(-1)).toEqual(['execute_issuer_key_change', 1]);
    expect([...near.active.keys()].sort()).toEqual(['kept', 'new']);
    near.clock += 15 * 60_000;
    expect(await run(near)).toEqual(empty);
    expect(await proposals()).toEqual([]);
  });

  it('executes matured changes proposed by others only when they agree with the JWKS', async () => {
    const near = govChain(['a', 'b'], { jwks: ['a', 'b', 'c'] });
    // The owner's matching post of c, a forged kid, and c's twin with other key material under another kid name.
    near.changes.push({ id: 7, provider: 'google', kid: 'c', op: 'Add', n: jwk('c').n, e: 'AQAB', by: 'owner.test.near', proposed_at_ms: 0, executable_at_ms: T0 });
    near.changes.push({ id: 8, provider: 'google', kid: 'forged', op: 'Add', n: modulus(77), e: 'AQAB', by: SIGNER, proposed_at_ms: 0, executable_at_ms: T0 });
    near.changes.push({ id: 9, provider: 'google', kid: 'b', op: 'Remove', n: null, e: null, by: SIGNER, proposed_at_ms: 0, executable_at_ms: T0 });
    const result = await run(near);
    expect(result.executed).toEqual([7]);
    expect(result.notes).toEqual([
      { code: 'unpublished_change', kid: 'forged', id: 8 },
      { code: 'removal_of_published_kid', kid: 'b', id: 9 },
    ]);
    expect(methods(near)).toEqual([['execute_issuer_key_change', 7]]);
    expect([...near.active.keys()].sort()).toEqual(['a', 'b', 'c']);
  });

  it('does not execute while paused or when the pause state is unreadable; still proposes', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b', 'c'] });
    near.changes.push({ id: 5, provider: 'google', kid: 'b', op: 'Add', n: jwk('b').n, e: 'AQAB', by: SIGNER, proposed_at_ms: 0, executable_at_ms: T0 });
    near.paused = true;
    const result = await run(near);
    expect(result).toMatchObject({ executed: [], proposed: ['c'], notes: [{ code: 'paused', kid: 'b', id: 5 }] });
    near.paused = false;
    delete near.views.get_config;
    expect((await run(near)).executed).toEqual([]);
    expect(methods(near)).toEqual([['set_issuer_key', 'c']]);
  });

  it('proposes a removal only after 24 h missing from every fetch, executes it after the delay, and never the last key', async () => {
    const near = govChain(['old', 'kept'], { jwks: ['kept'] });
    expect(await run(near)).toEqual(empty);
    near.clock += REMOVE_AFTER_MISSING_MS - 1;
    expect(await run(near)).toEqual(empty);
    near.clock += 1;
    expect(await run(near)).toEqual({ ...empty, removalsProposed: ['old'] });
    expect(near.sent.at(-1)!.args).toEqual({ provider: 'google', kid: 'old' });
    near.clock += DELAY;
    expect(await run(near)).toEqual({ ...empty, executed: [1] });
    expect([...near.active.keys()]).toEqual(['kept']);
    // 'kept' is now the last key: Google dropping it too removes nothing.
    near.jwks = { keys: [jwk('next')] };
    near.clock += 15 * 60_000;
    expect(await run(near)).toEqual({ ...empty, proposed: ['next'] });
    // 24 h on, 'next' (matured long ago) is executed in the same run that finds 'kept' due: removals are judged on the
    // state before the run's executions, so 'kept' is still the last key there.
    near.clock += REMOVE_AFTER_MISSING_MS;
    expect(await run(near)).toMatchObject({ executed: [2], removalsProposed: [], notes: [{ code: 'last_key_kept', kid: 'kept' }] });
    // Once 'next' is active, 'kept' can go.
    near.clock += 15 * 60_000;
    expect(await run(near)).toMatchObject({ removalsProposed: ['kept'] });
    expect(near.sent.map((t) => t.method)).not.toContain('remove_issuer_key');
  });

  it('a run fetches the JWKS JWKS_FETCHES_PER_RUN times', async () => {
    const near = govChain(['a', 'b']);
    await run(near);
    expect(near.jwksFetches).toBe(JWKS_FETCHES_PER_RUN);
    expect(JWKS_FETCHES_PER_RUN).toBe(3);
    expect(REMOVE_AFTER_MISSING_MS).toBe(24 * 60 * 60_000);
    expect(KEEP_AFTER_LAST_TOKEN_MS).toBe(24 * 60 * 60_000);
  });

  it('a kid one fetch of three lists is published: no missing row, no removal, and a new kid one fetch lists is proposed (D422)', async () => {
    const near = govChain(['k1', 'k2', 'k3'], { jwks: ['k1', 'k2'] });
    const all = { keys: [jwk('k1'), jwk('k2'), jwk('k3'), jwk('new')] };
    for (let i = 0; i < 8; i++) {
      // Every run: two stale answers without k3 and new, one fresh answer with both (Google's edges mid-rollout).
      near.jwksSequence = [{ keys: [jwk('k1'), jwk('k2')] }, all, { keys: [jwk('k1'), jwk('k2')] }];
      const r = await run(near);
      if (i === 0) expect(r.proposed).toEqual(['new']);
      else expect(r).toMatchObject({ proposed: [], removalsProposed: [] });
      near.clock += 6 * 60 * 60_000;
    }
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM issuer_key_missing').first()).toEqual({ n: 0 });
    expect(near.sent.map((t) => t.method)).not.toContain('propose_issuer_key_removal');
  });

  it('a kid that comes and goes between runs is never removed: each run that lists it restarts its 24 h (D422)', async () => {
    const near = govChain(['k1', 'k2', 'k3'], { jwks: ['k1', 'k2'] });
    for (let i = 0; i < 10; i++) {
      // 20 h missing from every fetch, then one run that lists it, again and again.
      near.jwks = { keys: [jwk('k1'), jwk('k2')] };
      for (let h = 0; h < 20; h += 5) {
        expect((await run(near)).removalsProposed).toEqual([]);
        near.clock += 5 * 60 * 60_000;
      }
      near.jwks = { keys: [jwk('k1'), jwk('k2'), jwk('k3')] };
      expect((await run(near)).removalsProposed).toEqual([]);
      near.clock += 15 * 60_000;
    }
    expect(near.sent).toHaveLength(0);
  });

  it('a run with a failed or empty fetch neither starts, resets nor completes a removal (D422)', async () => {
    const near = govChain(['old', 'kept'], { jwks: ['kept'] });
    expect(await run(near)).toEqual(empty);
    // Past the 24 h, but this run's second fetch failed and its third was empty: no proposal, the clock kept.
    near.clock += REMOVE_AFTER_MISSING_MS;
    near.jwksSequence = [{ keys: [jwk('kept')] }, 503, { keys: [] }];
    expect(await run(near)).toMatchObject({ removalsProposed: [] });
    expect(await env.DB.prepare("SELECT first_missing_at FROM issuer_key_missing WHERE kid = 'old'").first()).toEqual({ first_missing_at: T0 });
    // The next complete run proposes it.
    near.clock += 15 * 60_000;
    expect(await run(near)).toMatchObject({ removalsProposed: ['old'] });
    // A matured Remove isn't executed by an incomplete run either.
    near.clock += DELAY;
    near.jwksSequence = [503];
    expect(await run(near)).toMatchObject({ executed: [], notes: [{ code: 'removal_evidence_incomplete', kid: 'old', id: 1 }] });
    near.clock += 15 * 60_000;
    expect(await run(near)).toMatchObject({ executed: [1] });
  });

  it('never proposes or executes the removal of a kid that signed a verified token in the last 24 h (D422)', async () => {
    const near = govChain(['old', 'kept'], { jwks: ['kept'] });
    const sawToken = (at: number) =>
      env.DB.prepare(
        `INSERT INTO issuer_key_observations (provider, kid, first_token_ms, last_token_ms) VALUES ('google', 'old', ?1, ?1)
         ON CONFLICT (provider, kid) DO UPDATE SET last_token_ms = excluded.last_token_ms`,
      )
        .bind(at)
        .run();
    expect(await run(near)).toEqual(empty);
    near.clock += REMOVE_AFTER_MISSING_MS;
    await sawToken(near.clock - KEEP_AFTER_LAST_TOKEN_MS + 60_000);
    expect(await run(near)).toMatchObject({ removalsProposed: [], notes: [{ code: 'recent_token_kept', kid: 'old' }] });
    near.clock += 60_001;
    expect(await run(near)).toMatchObject({ removalsProposed: ['old'] });
    // A token signed with it while the removal waits keeps the matured Remove from executing.
    near.clock += DELAY;
    await sawToken(near.clock - 1);
    expect(await run(near)).toMatchObject({ executed: [], notes: [{ code: 'recent_token_kept', kid: 'old', id: 1 }] });
    expect([...near.active.keys()].sort()).toEqual(['kept', 'old']);
  });

  it('does not start a removal that one JWKS fetch omitted but the next one lists again', async () => {
    const near = govChain(['k1', 'k2', 'k3'], { jwks: ['k1', 'k2'] });
    expect(await run(near)).toEqual(empty);
    near.jwks = { keys: [jwk('k1'), jwk('k2'), jwk('k3')] };
    near.clock += 60 * 60_000;
    expect(await run(near)).toEqual(empty);
    near.jwks = { keys: [jwk('k1'), jwk('k2')] };
    near.clock += 60 * 60_000;
    expect(await run(near)).toEqual(empty);
    near.clock += REMOVE_AFTER_MISSING_MS - 1;
    expect(await run(near)).toEqual(empty);
    expect(near.sent).toHaveLength(0);
  });

  it('sees a cancelled proposal once, holds it, and proposes it again after REPROPOSE_AFTER_CANCEL_MS', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b'] });
    expect((await run(near)).proposed).toEqual(['b']);
    // A watchdog (or the owner) cancels it.
    near.changes = [];
    near.clock += 15 * 60_000;
    expect(await run(near)).toEqual({ ...empty, cancelled: ['Add:b'], notes: [{ code: 'held_after_cancel', kid: 'b' }] });
    expect(await proposals()).toEqual([{ kid: 'b', op: 'Add', change_id: 1, cancelled_seen_at: near.clock }]);
    const cancelledAt = near.clock;
    near.clock = cancelledAt + REPROPOSE_AFTER_CANCEL_MS - 1;
    expect(await run(near)).toEqual({ ...empty, notes: [{ code: 'held_after_cancel', kid: 'b' }] });
    near.clock = cancelledAt + REPROPOSE_AFTER_CANCEL_MS;
    // The hold has run out: the row is forgotten and the kid proposed again.
    expect((await run(near)).proposed).toEqual(['b']);
    expect(await proposals()).toEqual([{ kid: 'b', op: 'Add', change_id: 2, cancelled_seen_at: null }]);
    expect(methods(near)).toEqual([
      ['set_issuer_key', 'b'],
      ['set_issuer_key', 'b'],
    ]);
  });

  it('adopts a pending change of the updater it has no record of (an outcome it never saw), so its cancel is seen', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b'] });
    // The proposal landed, but this cron's send timed out before the outcome (no row written).
    near.changes.push({ id: 4, provider: 'google', kid: 'b', op: 'Add', n: jwk('b').n, e: 'AQAB', by: SIGNER, proposed_at_ms: T0 - 1, executable_at_ms: T0 + DELAY });
    // The owner's proposals are not ours to track.
    near.changes.push({ id: 5, provider: 'google', kid: 'a', op: 'Remove', n: null, e: null, by: 'owner.test.near', proposed_at_ms: T0 - 1, executable_at_ms: T0 + DELAY });
    expect(await run(near)).toEqual({ ...empty, notes: [{ code: 'removal_of_published_kid', kid: 'a', id: 5 }] });
    expect(await proposals()).toEqual([{ kid: 'b', op: 'Add', change_id: 4, cancelled_seen_at: null }]);
    near.changes = [];
    near.clock += 15 * 60_000;
    expect(await run(near)).toMatchObject({ cancelled: ['Add:b'], proposed: [] });
  });

  it('a cancelled removal is held too', async () => {
    const near = govChain(['old', 'kept'], { jwks: ['kept'] });
    await run(near);
    near.clock += REMOVE_AFTER_MISSING_MS;
    expect((await run(near)).removalsProposed).toEqual(['old']);
    near.changes = [];
    near.clock += 15 * 60_000;
    expect(await run(near)).toMatchObject({ cancelled: ['Remove:old'], removalsProposed: [] });
  });

  it('treats an execution someone else beat it to as a race, not a failure', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b'] });
    near.changes.push({ id: 3, provider: 'google', kid: 'b', op: 'Add', n: jwk('b').n, e: 'AQAB', by: SIGNER, proposed_at_ms: 0, executable_at_ms: T0 });
    // A watchdog confirms it between our read and our transaction.
    near.contract.execute_issuer_key_change = () => panic('No such key change');
    expect(await run(near)).toEqual({ ...empty, notes: [{ code: 'execute_raced', kid: 'b', id: 3 }] });
    near.contract.execute_issuer_key_change = () => panic('Paused');
    expect(await run(near)).toMatchObject({ failed: ['execute_issuer_key_change:3'] });
  });

  it('keeps removals back when a proposal failed', async () => {
    const near = govChain(['old', 'kept'], { jwks: ['kept', 'new'] });
    near.contract.set_issuer_key = () => panic('Only the owner or the contract account can do this');
    await run(near);
    near.clock += REMOVE_AFTER_MISSING_MS;
    const result = await run(near);
    expect(result).toMatchObject({ proposed: [], removalsProposed: [], failed: ['set_issuer_key:new'] });
    expect(near.sent.map((t) => t.method)).toEqual(['set_issuer_key', 'set_issuer_key']);
  });

  it('proposes nothing without a readable pending list (e.g. a contract still on v1)', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b'] });
    delete near.views.get_key_changes;
    expect((await run(near)).skipped).toBe('key_changes_unavailable');
    near.views.get_key_changes = () => [{ id: 'x' }];
    expect((await run(near)).skipped).toBe('key_changes_unavailable');
    expect(near.sent).toHaveLength(0);
  });

  it('touches nothing when the JWKS fetch fails or is empty', async () => {
    const near = govChain(['a']);
    near.jwksStatus = 500;
    expect((await run(near)).skipped).toBe('jwks_fetch_failed');
    near.jwksStatus = 200;
    near.jwks = { keys: [] };
    expect((await run(near)).skipped).toBe('jwks_empty');
    near.jwks = { keys: [jwk('x', { kty: 'EC' })] };
    expect((await run(near)).skipped).toBe('jwks_empty');
    expect(near.sent).toHaveLength(0);
  });

  it('skips when the issuer is not configured on chain', async () => {
    const near = govChain([], { jwks: ['a'] });
    near.views.get_issuer = () => null;
    expect((await run(near)).skipped).toBe('issuer_not_configured');
    expect(near.sent).toHaveLength(0);
  });

  it('recovers from InvalidNonce once', async () => {
    const near = govChain([], { jwks: ['a'] });
    let first = true;
    near.onSendTx = (tx) => {
      if (!first) return undefined;
      first = false;
      near.akNonce.set(tx.publicKey, 500n);
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 500, tx_nonce: Number(tx.nonce) } } } } } };
    };
    expect(await run(near)).toMatchObject({ proposed: ['a'], failed: [] });
    expect(near.sent.map((t) => t.nonce)).toEqual([501n]);
  });

  it('a broadcast that failed over after NEAR_RPC took it is polled by hash, never signed again (D432)', async () => {
    const near = govChain([], { jwks: ['a'] });
    const FALLBACK = 'https://rpc-fallback.test.invalid';
    const sameChain = vi.mocked(globalThis.fetch).getMockImplementation()!;
    // NEAR_RPC includes the tx, then answers like a broken proxy; the fallback is another node of the same chain, so
    // the same signed bytes get InvalidNonce there (the nonce is used). Re-signing on that would send a second tx.
    near.sendTxTransportError = 503;
    vi.mocked(globalThis.fetch).mockImplementation((input, init) => {
      if ((input instanceof Request ? input.url : String(input)) !== FALLBACK) return sameChain(input, init);
      near.sendTxTransportError = undefined;
      return sameChain(env.NEAR_RPC, init);
    });
    try {
      expect(await run(near, { ...env, NEAR_RPC_FALLBACKS: JSON.stringify([FALLBACK]) })).toMatchObject({ proposed: ['a'], failed: [] });
      expect(near.sent).toHaveLength(1);
      expect(near.rpcMethods.filter((m) => m === 'send_tx')).toHaveLength(2);
    } finally {
      rpcHealth.clear();
    }
  });

  it('skips with a malformed keys-updater key', async () => {
    const near = govChain([], { jwks: ['a'] });
    expect((await run(near, { ...env, KEYS_UPDATER_KEY: 'not-a-key' })).skipped).toBe('bad_keys_updater_key');
    expect(near.sent).toHaveLength(0);
  });

  it('skips without a keys-updater key', async () => {
    const near = govChain([]);
    expect((await run(near, { ...env, KEYS_UPDATER_KEY: undefined })).skipped).toBe('no_keys_updater_key');
    expect(near.rpcMethods).toHaveLength(0);
  });

  it('records each run for GET /v1/governance', async () => {
    const near = govChain(['a'], { jwks: ['a', 'b'] });
    await run(near);
    const row = await env.DB.prepare("SELECT at_ms, outcome, code, summary FROM issuer_key_sync_runs WHERE provider = 'google'").first<{ at_ms: number; outcome: string; code: string | null; summary: string }>();
    expect(row).toMatchObject({ at_ms: T0, outcome: 'ok', code: null });
    expect(JSON.parse(row!.summary)).toEqual({ ...empty, proposed: ['b'] });
    near.clock += 1;
    await run(near, { ...env, KEYS_UPDATER_KEY: undefined });
    expect(await env.DB.prepare("SELECT at_ms, outcome, code FROM issuer_key_sync_runs WHERE provider = 'google'").first()).toEqual({ at_ms: T0 + 1, outcome: 'skipped', code: 'no_keys_updater_key' });
    near.contract.set_issuer_key = () => panic('Too many pending key changes');
    near.changes = [];
    await env.DB.prepare('DELETE FROM issuer_key_proposals').run();
    near.clock += 1;
    await run(near);
    expect(await env.DB.prepare("SELECT outcome, code FROM issuer_key_sync_runs WHERE provider = 'google'").first()).toEqual({ outcome: 'error', code: 'call_failed' });
  });
});

describe('updater key', () => {
  it('signs only the contract’s UPDATER_METHODS, never remove_issuer_key', () => {
    expect(UPDATER_METHODS).toEqual(['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change']);
    expect(UPDATER_METHODS as readonly string[]).not.toContain('remove_issuer_key');
  });

  it('a full rotation sends nothing outside UPDATER_METHODS', async () => {
    const near = govChain(['k1'], { jwks: ['k1', 'k2'] });
    await run(near);
    near.jwks = { keys: [jwk('k2')] };
    near.clock += DELAY;
    await run(near);
    near.clock += REMOVE_AFTER_MISSING_MS;
    await run(near);
    near.clock += DELAY;
    await run(near);
    expect(methods(near)).toEqual([
      ['set_issuer_key', 'k2'],
      ['execute_issuer_key_change', 1],
      ['propose_issuer_key_removal', 'k1'],
      ['execute_issuer_key_change', 2],
    ]);
    expect(near.sent.every((t) => (UPDATER_METHODS as readonly string[]).includes(t.method))).toBe(true);
    expect([...near.active.keys()]).toEqual(['k2']);
  });
});
