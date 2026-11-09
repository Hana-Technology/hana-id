import { KeyPair, type KeyPairString } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GAS_TGAS, LINKED_LOGIN_TGAS, TGAS, gasEnvVar, gasFor } from '../src/gas.ts';
import { ALREADY_RELAYED, GOVERNANCE_METHODS, NOT_RELAYED_METHODS, POOL_METHODS, type Pool, UPDATER_METHODS } from '../src/relayer-config.ts';
import { CLAIM_MEMORY_MS, MAX_REMEMBERED_CLAIMS, NONCE_RESERVATION, type RelayerKey, type RelayResult, parseRelayerKeys } from '../src/relayer-key.ts';
import { claimId, claimKeyIndex, pickKeyIndex, relay, relayerKeyCount, relayerKeyName } from '../src/relayer-pool.ts';
import { clearViewCaches } from '../src/views.ts';
import { appHeaders, call, chain, seedApp, seedPlan, sessionBody, uid } from './helpers.ts';
import { NearMock } from './near-mock.ts';

afterEach(() => vi.restoreAllMocks());

const keys = parseRelayerKeys(env.RELAYER_KEYS);
const ownerKeys = parseRelayerKeys(env.OWNER_RELAYER_KEYS);
const publicKeyOf = (i: number, pool: Pool = 'session'): string => KeyPair.fromString((pool === 'session' ? keys : ownerKeys)[i] as KeyPairString).getPublicKey().toString();

/** A DO for a fresh name, so each test starts cold (nonce read from RPC). */
function freshKeyStub(): DurableObjectStub<RelayerKey> {
  return env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(`test-${uid()}`));
}

const revokeCall = (i: number) => ({ method: 'revoke_session', args: { session_public_key: Array(32).fill(i % 256), counter: 1, signature: Array(64).fill(1) } });

const RESERVE = BigInt(NONCE_RESERVATION);

/** The object's stored nonce reservation (see NONCE_RESERVATION). */
async function storedNonce(stub: DurableObjectStub<RelayerKey>): Promise<bigint> {
  return BigInt(await runInDurableObject(stub, (_instance, state) => state.storage.kv.get<string>('nonce') ?? '0'));
}

/** Counts the object's `storage.sync()` calls (confirmed reservation writes) from now on. */
async function countSyncs(stub: DurableObjectStub<RelayerKey>): Promise<() => number> {
  let spy: { mock: { calls: unknown[] } } | undefined;
  await runInDurableObject(stub, (_instance, state) => {
    spy = vi.spyOn(state.storage, 'sync');
  });
  return () => spy?.mock.calls.length ?? -1;
}

/** Crashes the object, as an eviction, deploy or runtime restart would: memory is lost, storage is kept. */
async function crash(stub: DurableObjectStub<RelayerKey>): Promise<void> {
  await runInDurableObject(stub, (_instance, state) => state.abort('test crash')).catch(() => undefined);
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; !cond(); i++) {
    if (i > 200) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

/**
 * A test clock for the timing tests: `Date.now` (in this isolate, so in the object too) stands still unless the test
 * moves it. Wall-clock timings drift under load (the runtime's clock moves with any I/O the isolate handles, the test
 * runner's included); on this clock every part of a relay's timing is exact.
 */
function testClock(start = 1_800_000_000_000): { readonly now: number; advance(ms: number): void; advanceTo(t: number): void } {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    get now() {
      return now;
    },
    advance: (ms) => void (now += ms),
    advanceTo: (t) => void (now = Math.max(now, t)),
  };
}

/** Waits (in real time) until `n` relays are inside the object: dispatching, queued for it, or awaiting an outcome. */
async function untilBusy(stub: DurableObjectStub<RelayerKey>, n: number): Promise<void> {
  for (let i = 0; (await runInDurableObject(stub, (instance) => instance.busy)) < n; i++) {
    if (i > 2_000) throw new Error(`Timed out waiting for ${n} relays in the object`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function expectConsecutive(nonces: bigint[], from: bigint): void {
  const sorted = [...nonces].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  expect(new Set(sorted.map(String)).size).toBe(nonces.length);
  expect(sorted).toEqual(sorted.map((_, i) => from + BigInt(i)));
}

describe('RelayerKey Durable Object', () => {
  it('N parallel relays on one key get N distinct consecutive nonces, dispatched in order', async () => {
    const near = new NearMock();
    near.defaultNonce = 500n;
    // Slow, jittery broadcasts: outcomes resolve out of order, nonces must not.
    near.onSendTx = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 30));
    near.install();
    const stub = freshKeyStub();
    const N = 25;
    const results = (await Promise.all(Array.from({ length: N }, (_, i) => stub.relay('session', 0, revokeCall(i), `r${i}`)))) as RelayResult[];
    expect(results.every((r) => r.ok)).toBe(true);
    expect(near.sent).toHaveLength(N);
    expectConsecutive(near.sent.map((t) => t.nonce), 501n);
    expect(new Set(results.map((r) => (r.ok ? r.nearTx : ''))).size).toBe(N);
    // One access-key read on cold start, not one per request.
    expect(near.rpcMethods.filter((m) => m === 'query')).toHaveLength(1);
    expect(near.sent.every((t) => t.publicKey === publicKeyOf(0) && t.receiverId === env.SIGNER_ACCOUNT && t.signerId === env.RELAYER_ACCOUNT)).toBe(true);
  });

  it('waits for outcomes outside the critical section (a slow tx does not block the next dispatch)', async () => {
    const near = new NearMock();
    near.install();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let dispatched = 0;
    near.onSendTx = async (tx) => {
      dispatched++;
      if (tx.args.counter === 1 && (tx.args.session_public_key as number[])[0] === 0) await gate;
      return undefined;
    };
    const stub = freshKeyStub();
    const slow = stub.relay('session', 0, revokeCall(0), 'slow');
    // While the first broadcast is still pending, more requests go out.
    const others = await Promise.all([1, 2, 3].map((i) => stub.relay('session', 0, revokeCall(i), `o${i}`)));
    expect(others.every((r) => (r as RelayResult).ok)).toBe(true);
    expect(dispatched).toBe(4);
    release();
    expect(((await slow) as RelayResult).ok).toBe(true);
  });

  it('recovers from InvalidNonce: re-reads the nonce and retries once', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(11n);
    // Someone else used the key: the chain is now at 200.
    near.akNonce.set(publicKeyOf(0), 200n);
    const res = (await stub.relay('session', 0, revokeCall(2))) as RelayResult;
    expect(res.ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(201n);
    // Later requests continue from the recovered nonce.
    expect(((await stub.relay('session', 0, revokeCall(3))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(202n);
  });

  it('InvalidNonce recovery under concurrency keeps nonces unique', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    near.akNonce.set(publicKeyOf(0), 300n);
    const results = (await Promise.all(Array.from({ length: 8 }, (_, i) => stub.relay('session', 0, revokeCall(i + 10))))) as RelayResult[];
    expect(results.every((r) => r.ok)).toBe(true);
    const nonces = near.sent.slice(1).map((t) => t.nonce);
    expect(new Set(nonces.map(String)).size).toBe(8);
    expect(nonces.every((n) => n > 300n)).toBe(true);
  });

  it('gives up after a second InvalidNonce', async () => {
    const near = new NearMock();
    near.install();
    near.onSendTx = (tx) => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 1, tx_nonce: Number(tx.nonce) } } } } } });
    const res = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 503, code: 'relayer_busy' });
  });

  it('cold start trusts its stored reservation without reading the chain; a chain ahead of it is caught by InvalidNonce', async () => {
    const near = new NearMock();
    near.defaultNonce = 40n;
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put('publicKey', publicKeyOf(0));
      state.storage.kv.put('nonce', '75');
    });
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(76n);
    expect(await storedNonce(stub)).toBe(76n + RESERVE - 1n);
    // No access key read: the stored reservation is enough.
    expect(near.rpcMethods).not.toContain('query');
    // The chain ahead of the reservation (the key was used elsewhere): InvalidNonce, one chain read, then the chain wins.
    const ahead = freshKeyStub();
    await runInDurableObject(ahead, (_instance, state) => {
      state.storage.kv.put('publicKey', publicKeyOf(0));
      state.storage.kv.put('nonce', '30');
    });
    expect(((await ahead.relay('session', 0, revokeCall(2))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(77n);
    expect(near.rpcMethods.filter((m) => m === 'query')).toHaveLength(1);
  });

  it('restarts warm from storage: no chain reads while the stored block hash is fresh, one block read once it is old', async () => {
    const near = new NearMock();
    near.defaultNonce = 300n;
    near.install();
    const id = env.RELAYER_KEY.idFromName(`test-${uid()}`);
    expect(((await env.RELAYER_KEY.get(id).relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    await crash(env.RELAYER_KEY.get(id));
    const before = near.rpcMethods.length;
    const warm = (await env.RELAYER_KEY.get(id).relay('session', 0, revokeCall(2))) as RelayResult;
    expect(warm.ok).toBe(true);
    expect(warm.instance).toMatchObject({ cold: true, coldChainRead: false, blockRefresh: false, served: 0 });
    expect(near.rpcMethods.slice(before).filter((m) => m === 'query' || m === 'block')).toEqual([]);
    expect(near.sent.at(-1)!.nonce).toBe(301n + RESERVE);
    expect(near.sent.at(-1)!.blockHash).toBe(near.finalBlockHash);
    // Evicted again, more than 5 min later: the stored hash is too old, so only the block is re-read.
    await crash(env.RELAYER_KEY.get(id));
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 5 * 60_000 + 1_000);
    const mark = near.rpcMethods.length;
    const stale = (await env.RELAYER_KEY.get(id).relay('session', 0, revokeCall(3))) as RelayResult;
    expect(stale.ok).toBe(true);
    expect(stale.instance).toMatchObject({ cold: true, coldChainRead: false, blockRefresh: true });
    expect(near.rpcMethods.slice(mark).filter((m) => m === 'query' || m === 'block')).toEqual(['block']);
  });

  it('reserves nonces in blocks: one confirmed write per NONCE_RESERVATION relays, none in between', async () => {
    const near = new NearMock();
    near.defaultNonce = 500n;
    near.install();
    const stub = freshKeyStub();
    const syncs = await countSyncs(stub);
    expect(((await stub.relay('session', 0, revokeCall(0))) as RelayResult).ok).toBe(true);
    expect(near.sent[0]!.nonce).toBe(501n);
    expect(await storedNonce(stub)).toBe(500n + RESERVE);
    expect(syncs()).toBe(1);
    // The rest of the block: no writes, the stored reservation stays.
    const rest = (await Promise.all(Array.from({ length: NONCE_RESERVATION - 1 }, (_, i) => stub.relay('session', 0, revokeCall(i + 1))))) as RelayResult[];
    // No write and no wait: syncs() below proves it (a timing of exactly 0 ms is not reliable under load).
    expect(rest.every((r) => r.ok)).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(500n + RESERVE);
    expect(await storedNonce(stub)).toBe(500n + RESERVE);
    expect(syncs()).toBe(1);
    // The next nonce leaves the block: a new reservation is confirmed before it is sent.
    expect(((await stub.relay('session', 0, revokeCall(999))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(501n + RESERVE);
    expect(await storedNonce(stub)).toBe(500n + 2n * RESERVE);
    expect(syncs()).toBe(2);
    expectConsecutive(near.sent.map((t) => t.nonce), 501n);
  });

  it('never reuses a nonce after a crash, while its txs are still unconfirmed in the pool', async () => {
    const near = new NearMock();
    near.defaultNonce = 100n;
    const signed: bigint[] = [];
    // Broadcasts that never answer and are never included: the chain's nonce stays at 100.
    near.onSendTx = (tx) => {
      signed.push(tx.nonce);
      return new Promise(() => undefined);
    };
    near.install();
    const id = env.RELAYER_KEY.idFromName(`test-${uid()}`);
    const stub = env.RELAYER_KEY.get(id);
    const hung = Promise.allSettled(Array.from({ length: 3 }, (_, i) => stub.relay('session', 0, revokeCall(i))));
    await until(() => signed.length === 3);
    await crash(stub);
    // The in-flight requests fail with the reset (the Worker answers relayer_unavailable).
    expect((await hung).map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
    expect(signed).toEqual([101n, 102n, 103n]);
    expect(near.nonceOf(publicKeyOf(0))).toBe(100n);

    // Cold start (same object, new instance): starts above the reservation, never at 101–103 again.
    near.onSendTx = (tx) => void signed.push(tx.nonce);
    const restarted = env.RELAYER_KEY.get(id);
    expect(((await restarted.relay('session', 0, revokeCall(9))) as RelayResult).ok).toBe(true);
    expect(signed.at(-1)).toBe(101n + RESERVE);
    expect(await storedNonce(restarted)).toBe(100n + 2n * RESERVE);
    expect(new Set(signed.map(String)).size).toBe(signed.length);
  });

  it('a nonce recovered from InvalidNonce above the reservation is reserved before it is sent', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const id = env.RELAYER_KEY.idFromName(`test-${uid()}`);
    const stub = env.RELAYER_KEY.get(id);
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(await storedNonce(stub)).toBe(10n + RESERVE);
    // Someone else used the key, far past the reservation.
    near.akNonce.set(publicKeyOf(0), 10n + 5n * RESERVE);
    expect(((await stub.relay('session', 0, revokeCall(2))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(11n + 5n * RESERVE);
    expect(await storedNonce(stub)).toBe(10n + 6n * RESERVE);
    // Crash with the chain behind (the retried tx not yet included): the restart still starts above it.
    near.akNonce.set(publicKeyOf(0), 10n);
    await crash(stub);
    expect(((await env.RELAYER_KEY.get(id).relay('session', 0, revokeCall(3))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(11n + 6n * RESERVE);
  });

  it('a nonce recovered from InvalidNonce inside the reservation needs no write, and survives a crash', async () => {
    const near = new NearMock();
    near.defaultNonce = 10n;
    near.install();
    const id = env.RELAYER_KEY.idFromName(`test-${uid()}`);
    const stub = env.RELAYER_KEY.get(id);
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    const syncs = await countSyncs(stub);
    near.akNonce.set(publicKeyOf(0), 50n);
    const retried = (await stub.relay('session', 0, revokeCall(2))) as RelayResult;
    expect(retried.ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(51n);
    expect(syncs()).toBe(0);
    expect(await storedNonce(stub)).toBe(10n + RESERVE);
    await crash(stub);
    expect(((await env.RELAYER_KEY.get(id).relay('session', 0, revokeCall(3))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.nonce).toBe(11n + RESERVE);
  });

  it('sends nothing when the reservation write fails, and does not skip the nonce', async () => {
    const near = new NearMock();
    near.defaultNonce = 70n;
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (_instance, state) => {
      vi.spyOn(state.storage, 'sync').mockRejectedValueOnce(new Error('storage write failed'));
    });
    expect((await stub.relay('session', 0, revokeCall(1))) as RelayResult).toMatchObject({ ok: false, status: 502, code: 'near_unavailable' });
    expect(near.rpcMethods).not.toContain('send_tx');
    expect(((await stub.relay('session', 0, revokeCall(2))) as RelayResult).ok).toBe(true);
    expect(near.sent.map((t) => t.nonce)).toEqual([71n]);
    expect(await storedNonce(stub)).toBe(70n + RESERVE);
  });

  it('ignores a stored nonce that belonged to a different key', async () => {
    const near = new NearMock();
    near.defaultNonce = 40n;
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.kv.put('publicKey', 'ed25519:someoneelse');
      state.storage.kv.put('nonce', '9999');
    });
    await stub.relay('session', 0, revokeCall(1));
    expect(near.sent.at(-1)!.nonce).toBe(41n);
  });

  it('polls `tx` when send_tx times out', async () => {
    const near = new NearMock();
    near.sendTxTimesOut = true;
    near.contract.derive_key = () => ({ big_y: 'y', big_c: 'c' });
    near.install();
    const res = (await freshKeyStub().relay('session', 0, { method: 'derive_key', args: {} })) as RelayResult;
    expect(res).toMatchObject({ ok: true, result: { big_y: 'y', big_c: 'c' } });
    expect(near.rpcMethods).toContain('tx');
  });

  it('reports NEAR rejections (not nonce related) as 502', async () => {
    const near = new NearMock();
    near.install();
    near.onSendTx = () => ({ error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION' }, data: { TxExecutionError: { InvalidTxError: { NotEnoughBalance: {} } } } } });
    const res = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 502, code: 'near_rejected', error: 'NEAR rejected the transaction' });
  });

  it('never returns the RPC’s or the runtime’s error text: it can name the provider URL and its API key', async () => {
    const near = new NearMock();
    near.install();
    const mocked = globalThis.fetch;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const method = (JSON.parse(String(init?.body ?? '{}')) as { method?: string }).method;
      if (method === 'query') throw new TypeError('fetch failed: connect ECONNREFUSED https://rpc.provider.example/v1?apikey=SECRET-KEY');
      return mocked(input, init);
    });
    const res = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 502, code: 'near_unavailable', error: 'Could not reach NEAR, try again' });
    expect(JSON.stringify(res)).not.toMatch(/SECRET-KEY|rpc\.provider\.example|ECONNREFUSED/u);
  });

  it('a send_tx that fails without a definite rejection is polled, not reported as rejected', async () => {
    // The tx reached the network, then the proxy answered a non-JSON 502 / the connection dropped.
    for (const failure of [502, 520, 'network'] as const) {
      const near = new NearMock();
      near.contract.create_session = () => ({ path: 's1#google#1#0', scope_id: 's1', expires_at_ms: 1, max_uses: 1, used: 0 });
      near.sendTxTransportError = failure;
      near.install();
      const res = (await freshKeyStub().relay('session', 0, { method: 'create_session', args: {} })) as RelayResult;
      expect(res, String(failure)).toMatchObject({ ok: true, result: { scope_id: 's1' } });
      expect(near.rpcMethods).toContain('tx');
      vi.restoreAllMocks();
    }
  });

  it('keeps polling through transient RPC errors until the outcome arrives', async () => {
    const near = new NearMock();
    near.sendTxTimesOut = true;
    near.txPollFailures = 2;
    near.contract.derive_key = () => ({ big_y: 'y', big_c: 'c' });
    near.install();
    const res = (await freshKeyStub().relay('session', 0, { method: 'derive_key', args: {} })) as RelayResult;
    expect(res).toMatchObject({ ok: true, result: { big_y: 'y', big_c: 'c' } });
    expect(near.rpcMethods.filter((m) => m === 'tx')).toHaveLength(3);
  });

  it('resends a tx that was dropped because a later nonce of the key landed first', async () => {
    const near = new NearMock();
    near.defaultNonce = 50n;
    near.install();
    let first = true;
    near.onSendTx = (tx) => {
      if (!first) return undefined;
      first = false;
      // A higher nonce of this key was included first: this tx is gone from the pool (never executed).
      near.akNonce.set(tx.publicKey, tx.nonce + 1n);
      return { error: { name: 'HANDLER_ERROR', cause: { name: 'TIMEOUT_ERROR' }, message: 'Timeout', data: 'TIMEOUT' } };
    };
    const res = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(res.ok).toBe(true);
    // Executed exactly once, with a nonce above the one that superseded the dropped tx.
    expect(near.sent).toHaveLength(1);
    expect(near.sent[0]!.nonce).toBe(53n);
  });

  it('each pool relays only its own allowlist', async () => {
    const near = new NearMock();
    near.install();
    expect(POOL_METHODS).toEqual({
      session: ['create_session', 'create_session_and_derive', 'derive_key', 'revoke_session', 'link_identity', 'cancel_link', 'unlink_identity'],
      owner: ['propose_change', 'cancel_change', 'remove_client', 'disable_shared_login', 'execute_change'],
      home: ['create_session_and_derive'],
    });
    // Every governance and updater method of the governance batch too (docs/governance-spec.md "The API's keys").
    const never = [...GOVERNANCE_METHODS, ...UPDATER_METHODS, 'set_owner', 'sign', '__proto__'];
    for (const method of [...never, ...POOL_METHODS.owner]) {
      expect((await freshKeyStub().relay('session', 0, { method, args: {} })) as RelayResult, `session ${method}`).toMatchObject({ ok: false, code: 'method_not_allowed' });
    }
    for (const method of [...never, ...POOL_METHODS.session]) {
      expect((await freshKeyStub().relay('owner', 0, { method, args: {} })) as RelayResult, `owner ${method}`).toMatchObject({ ok: false, code: 'method_not_allowed' });
    }
    for (const method of [...never, 'derive_key', 'revoke_session', 'create_session', ...POOL_METHODS.owner]) {
      expect((await freshKeyStub().relay('home', 0, { method, args: {} })) as RelayResult, `home ${method}`).toMatchObject({ ok: false, code: 'method_not_allowed' });
    }
    expect((await freshKeyStub().relay('admin' as Pool, 0, revokeCall(1))) as RelayResult).toMatchObject({ ok: false, code: 'method_not_allowed' });
    expect(near.sent).toHaveLength(0);
  });

  it('no pool holds a method no endpoint relays (D456)', async () => {
    const near = new NearMock();
    near.install();
    expect(NOT_RELAYED_METHODS).toEqual(['prune_sessions', 'apply_pending_config', 'register_scope']);
    for (const method of NOT_RELAYED_METHODS) {
      expect(POOL_METHODS.session as readonly string[], method).not.toContain(method);
      expect(POOL_METHODS.owner as readonly string[], method).not.toContain(method);
      expect(await relay(env, 'session', { method, args: {} }, 'r'), method).toMatchObject({ ok: false, code: 'method_not_allowed' });
      expect(await relay(env, 'owner', { method, args: {} }, 'r'), method).toMatchObject({ ok: false, code: 'method_not_allowed' });
    }
    expect(near.sent).toHaveLength(0);
  });

  it('no pool shares a method with the updater key or the governance methods', () => {
    const pooled = [...POOL_METHODS.session, ...POOL_METHODS.owner] as string[];
    for (const m of [...GOVERNANCE_METHODS, ...UPDATER_METHODS]) expect(pooled, m).not.toContain(m);
    expect(GOVERNANCE_METHODS as readonly string[]).not.toContain('execute_issuer_key_change');
    expect(new Set(GOVERNANCE_METHODS).size).toBe(GOVERNANCE_METHODS.length);
  });

  it('signs with the pool’s own key, and an object never serves a second pool', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay('owner', 1, { method: 'execute_change', args: { scope_id: 's1', change_id: 0 } })) as RelayResult).ok).toBe(true);
    expect(near.sent[0]!.publicKey).toBe(publicKeyOf(1, 'owner'));
    expect(near.sent[0]!.publicKey).not.toBe(publicKeyOf(1));
    // Same object, other pool or other key index: refused.
    expect((await stub.relay('session', 1, revokeCall(1))) as RelayResult).toMatchObject({ ok: false, status: 503 });
    expect((await stub.relay('owner', 0, { method: 'execute_change', args: {} })) as RelayResult).toMatchObject({ ok: false, status: 503 });
    expect(near.sent).toHaveLength(1);
  });

  it('attaches per-method gas (env override included), never the caller’s', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    await stub.relay('session', 0, { ...revokeCall(1), gas: 300n * TGAS });
    await stub.relay('session', 0, { method: 'derive_key', args: {} });
    await stub.relay('session', 0, { method: 'create_session', args: {} });
    const owner = freshKeyStub();
    await owner.relay('owner', 0, { method: 'remove_client', args: {} });
    await owner.relay('owner', 0, { method: 'disable_shared_login', args: {} });
    expect(near.sent.map((t) => [t.method, t.gas / TGAS])).toEqual([
      ['revoke_session', 20n],
      ['derive_key', 60n],
      ['create_session', 100n],
      // GAS_REMOVE_CLIENT_TGAS=70 in vitest.config.ts.
      ['remove_client', 70n],
      ['disable_shared_login', 50n],
    ]);
  });

  it('returns once executed (EXECUTED_OPTIMISTIC), for send_tx and for outcome polls', async () => {
    const near = new NearMock();
    near.sendTxTimesOut = true;
    near.install();
    const result = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(result.ok).toBe(true);
    expect(near.waitUntil.map((w) => w.method)).toEqual(['send_tx', 'tx']);
    expect(near.waitUntil.every((w) => w.waitUntil === 'EXECUTED_OPTIMISTIC')).toBe(true);
  });

  it('signs against a final block read on cold start, not the access key view’s optimistic block', async () => {
    const near = new NearMock();
    near.finalBlockHash = baseEncode(new Uint8Array(32).fill(9));
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    expect(near.sent[0]!.blockHash).toBe(near.finalBlockHash);
    expect(near.sent[0]!.blockHash).not.toBe(near.blockHash);
  });

  it('re-reads a final block when recovering from InvalidNonce', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    expect(((await stub.relay('session', 0, revokeCall(1))) as RelayResult).ok).toBe(true);
    // Someone else used the key, and a new block became final.
    near.akNonce.set(publicKeyOf(0), near.nonceOf(publicKeyOf(0)) + 5n);
    near.finalBlockHash = baseEncode(new Uint8Array(32).fill(11));
    expect(((await stub.relay('session', 0, revokeCall(2))) as RelayResult).ok).toBe(true);
    expect(near.sent.at(-1)!.blockHash).toBe(near.finalBlockHash);
  });

  it('reports which instance served a relay: cold on its first, warm after; block refresh once the hash is 5 min old', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    const first = (await stub.relay('session', 0, revokeCall(1))) as RelayResult;
    expect(first.instance).toMatchObject({ cold: true, blockRefresh: false, served: 0 });
    const second = (await stub.relay('session', 0, revokeCall(2))) as RelayResult;
    expect(second.instance).toMatchObject({ cold: false, blockRefresh: false, served: 1 });
    expect(second.instance!.ageMs).toBeGreaterThanOrEqual(first.instance!.ageMs);
    const later = Date.now() + 5 * 60_000 + 1_000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    const third = (await stub.relay('session', 0, revokeCall(3))) as RelayResult;
    expect(third.instance).toMatchObject({ cold: false, blockRefresh: true, served: 2 });
    const methods = near.rpcMethods;
    // One cold read (access key + final block), then only the 5-min block refresh.
    expect(methods.filter((m) => m === 'query')).toHaveLength(1);
    expect(methods.filter((m) => m === 'block')).toHaveLength(2);
  });

  it('reports the time spent getting a nonce and broadcasting vs waiting for the outcome', async () => {
    const clock = testClock();
    const near = new NearMock();
    // The node answers send_tx 40 ms (test clock) after the broadcast. The macrotask runs after the object has marked
    // the broadcast (the microtasks that return from dispatch), so the 40 ms land in outcomeMs.
    near.onSendTx = () => new Promise((r) => setTimeout(() => r(void clock.advance(40)), 0));
    near.install();
    const result = (await freshKeyStub().relay('session', 0, revokeCall(1))) as RelayResult;
    expect(result.ok).toBe(true);
    expect(result.timing).toEqual({ dispatchMs: 0, outcomeMs: 40, queueMs: 0, chainReadMs: 0, signMs: 0, persistMs: 0 });
    const refused = (await freshKeyStub().relay('session', 0, { method: 'register_scope', args: {} })) as RelayResult;
    expect(refused.ok).toBe(false);
    expect(refused.timing).toEqual({ dispatchMs: 0, outcomeMs: 0, queueMs: 0, chainReadMs: 0, signMs: 0, persistMs: 0 });
  });

  it('splits the dispatch time into queue, chain reads, signing and reservation', async () => {
    const clock = testClock();
    const near = new NearMock();
    // A chain read answers 40 ms (test clock) after it arrives (reads sent together overlap); while `hold` is set, not
    // before it settles either.
    let hold: Promise<void> | undefined;
    near.onRead = async () => {
      const arrived = clock.now;
      await hold;
      clock.advanceTo(arrived + 40);
    };
    near.install();
    const stub = freshKeyStub();
    // A confirmed reservation write takes 5 ms (test clock).
    let syncs = 0;
    await runInDurableObject(stub, (_instance, state) => {
      const sync = state.storage.sync.bind(state.storage);
      vi.spyOn(state.storage, 'sync').mockImplementation(async () => {
        await sync();
        syncs++;
        clock.advance(5);
      });
    });
    // Cold start: the first relay reads the access key and a block; the second waits for it in the queue. The reads
    // are held until both relays are in the object, so the second is queued behind the first however slow the host.
    let release!: () => void;
    hold = new Promise<void>((r) => (release = r));
    const relays = Promise.all([stub.relay('session', 0, revokeCall(1)), stub.relay('session', 0, revokeCall(2))]);
    await untilBusy(stub, 2);
    release();
    hold = undefined;
    const [cold, queued] = (await relays) as RelayResult[];
    expect(cold!.ok && queued!.ok).toBe(true);
    // The first reserves a block of nonces (signing takes no test-clock time); the second waits for all of it, then
    // signs inside that reservation.
    expect(syncs).toBe(1);
    expect(cold!.timing).toEqual({ dispatchMs: 45, outcomeMs: 0, queueMs: 0, chainReadMs: 40, signMs: 0, persistMs: 5 });
    expect(queued!.timing).toEqual({ dispatchMs: 45, outcomeMs: 0, queueMs: 45, chainReadMs: 0, signMs: 0, persistMs: 0 });
    // Warm, inside the reservation: no RPC reads, no storage write.
    const reads = near.rpcMethods.length;
    const warm = (await stub.relay('session', 0, revokeCall(3))) as RelayResult;
    expect(warm.timing).toEqual({ dispatchMs: 0, outcomeMs: 0, queueMs: 0, chainReadMs: 0, signMs: 0, persistMs: 0 });
    expect(near.rpcMethods.slice(reads)).toEqual(['send_tx']);
    expect(syncs).toBe(1);
    // A recovery's re-read (access key and block, together) counts as chain reads.
    near.akNonce.set(publicKeyOf(0), near.nonceOf(publicKeyOf(0)) + 3n);
    const retried = (await stub.relay('session', 0, revokeCall(4))) as RelayResult;
    expect(retried.ok).toBe(true);
    expect(retried.timing).toEqual({ dispatchMs: 40, outcomeMs: 0, queueMs: 0, chainReadMs: 40, signMs: 0, persistMs: 0 });
    expect(syncs).toBe(1);
  });

  it('fails cleanly for a key index outside its pool', async () => {
    new NearMock().install();
    const res = (await freshKeyStub().relay('session', 99, revokeCall(1))) as RelayResult;
    expect(res).toMatchObject({ ok: false, status: 503 });
    expect((await freshKeyStub().relay('owner', 2, { method: 'execute_change', args: {} })) as RelayResult).toMatchObject({ ok: false, status: 503 });
  });
});

describe('gas', () => {
  it('defaults (to measure on testnet) and overrides', () => {
    // D155: the session and link values cover issuer keys of 4096 bits.
    expect(DEFAULT_GAS_TGAS).toMatchObject({ create_session: 100, create_session_and_derive: 150, derive_key: 60, revoke_session: 20, link_identity: 250, cancel_link: 150, unlink_identity: 150 });
    // A linked login (create_session_and_derive with link_jwt) gets its own value and override.
    expect(gasFor('create_session_and_derive', {}, { link_jwt: '{}' })).toBe(BigInt(LINKED_LOGIN_TGAS) * TGAS);
    expect(LINKED_LOGIN_TGAS).toBe(250);
    expect(gasFor('create_session_and_derive', { GAS_CREATE_SESSION_AND_DERIVE_LINKED_TGAS: '280' }, { link_jwt: '{}' })).toBe(280n * TGAS);
    expect(gasFor('create_session_and_derive', { GAS_CREATE_SESSION_AND_DERIVE_LINKED_TGAS: '280' }, {})).toBe(150n * TGAS);
    expect(gasFor('create_session_and_derive', { GAS_CREATE_SESSION_AND_DERIVE_TGAS: '120' }, { link_jwt: '{}' })).toBe(BigInt(LINKED_LOGIN_TGAS) * TGAS);
    // Each token signature beyond the default's (a 2-of-2 email token): +70, capped at 300 (review L1).
    const two = JSON.stringify({ payload: 'p', signatures: [{}, {}] });
    expect(gasFor('cancel_link', {}, { jwt: two })).toBe(220n * TGAS);
    expect(gasFor('create_session', {}, { jwt: two })).toBe(170n * TGAS);
    expect(gasFor('create_session', {}, { jwt: 'a.b.c' })).toBe(100n * TGAS);
    expect(gasFor('create_session_and_derive', {}, { jwt: 'a.b.c', link_jwt: two })).toBe(300n * TGAS);
    expect(gasFor('link_identity', { GAS_LINK_IDENTITY_TGAS: '200' }, { account_jwt: two, new_jwt: two })).toBe(200n * TGAS);
    for (const m of POOL_METHODS.owner) expect(DEFAULT_GAS_TGAS[m], m).toBe(50);
    expect(gasEnvVar('derive_key')).toBe('GAS_DERIVE_KEY_TGAS');
    expect(gasFor('derive_key', {})).toBe(60n * TGAS);
    expect(gasFor('derive_key', { GAS_DERIVE_KEY_TGAS: '80' })).toBe(80n * TGAS);
    expect(gasFor('derive_key', { GAS_CREATE_SESSION_TGAS: '80' })).toBe(60n * TGAS);
    // Invalid overrides fall back to the default.
    for (const bad of ['0', '301', '12.5', 'lots', '-5']) expect(gasFor('revoke_session', { GAS_REVOKE_SESSION_TGAS: bad }), bad).toBe(20n * TGAS);
  });
});

describe('one relay per signed request, across isolates (D455, security.md (g))', () => {
  const claim = () => `claim-${uid()}`;
  const derive = { method: 'derive_key', args: {} };
  const relayed = (r: unknown) => expect(r).toMatchObject({ ok: true });
  const refused = (r: unknown) => expect(r).toMatchObject({ ok: false, status: 409, code: ALREADY_RELAYED });

  it('a copy arriving while the original is in flight waits, then is refused without a transaction', async () => {
    const near = new NearMock();
    let answer!: () => void;
    const held = new Promise<void>((r) => (answer = r));
    near.onSendTx = async () => {
      await held;
      return undefined;
    };
    near.install();
    const stub = freshKeyStub();
    const id = claim();
    const first = stub.relay('session', 0, derive, 'a', id);
    await until(() => near.sent.length === 1 || near.rpcMethods.includes('send_tx'));
    const copy = stub.relay('session', 0, derive, 'b', id);
    answer();
    relayed(await first);
    refused(await copy);
    expect(near.sent).toHaveLength(1);
  });

  it('a later copy is refused while remembered, and relayed again once forgotten', async () => {
    const clock = testClock();
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    const id = claim();
    relayed(await stub.relay('session', 0, derive, 'a', id));
    clock.advance(CLAIM_MEMORY_MS - 1);
    refused(await stub.relay('session', 0, derive, 'b', id));
    expect(near.sent).toHaveLength(1);
    clock.advance(1);
    relayed(await stub.relay('session', 0, derive, 'c', id));
    expect(near.sent).toHaveLength(2);
  });

  it('a copy is relayed when the original failed: it may still succeed', async () => {
    const near = new NearMock();
    let fail = true;
    near.contract.derive_key = () => {
      if (fail) throw new Error('MPC unavailable');
      return { big_y: 'y', big_c: 'c' };
    };
    near.install();
    const stub = freshKeyStub();
    const id = claim();
    expect(await stub.relay('session', 0, derive, 'a', id)).toMatchObject({ ok: false, code: 'contract_rejected' });
    fail = false;
    relayed(await stub.relay('session', 0, derive, 'b', id));
    expect(near.sent).toHaveLength(2);
  });

  it('other claims and relays without a claim are untouched', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    const id = claim();
    relayed(await stub.relay('session', 0, derive, 'a', id));
    relayed(await stub.relay('session', 0, derive, 'b', claim()));
    relayed(await stub.relay('session', 0, derive, 'c'));
    relayed(await stub.relay('session', 0, derive, 'd'));
    expect(near.sent).toHaveLength(4);
  });

  it('remembers a bounded number of claims, dropping the oldest', async () => {
    const near = new NearMock();
    near.install();
    const stub = freshKeyStub();
    await runInDurableObject(stub, (instance) => {
      const remember = (instance as unknown as { rememberRelayed(c: string): void }).rememberRelayed.bind(instance);
      for (let i = 0; i < MAX_REMEMBERED_CLAIMS; i++) remember(`old-${i}`);
      remember('new');
      const map = (instance as unknown as { relayed: Map<string, number> }).relayed;
      expect(map.size).toBe(MAX_REMEMBERED_CLAIMS);
      expect(map.has('old-0')).toBe(false);
      expect(map.has('new')).toBe(true);
    });
  });

  it('routes every copy to the session’s key, whichever isolate sends it', async () => {
    const near = new NearMock();
    near.install();
    const count = relayerKeyCount(env);
    const sessionPublicKey = Array(32).fill(0).map((_, i) => (i * 7 + 3) % 256);
    const c = { sessionPublicKey, expiresAtMs: 1000, counter: 2 };
    const first = await relay(env, 'session', derive, 'a', c);
    relayed(first);
    expect(first.keyIndex).toBe(await claimKeyIndex('session', env.RELAYER_KEYS, sessionPublicKey, count));
    // The round-robin cursor moves between the two; the claim's key doesn't.
    pickKeyIndex(count);
    refused(await relay(env, 'session', derive, 'b', c));
    expect(near.sent).toHaveLength(1);
    // Another expiry is another session of that key: its counters start again.
    relayed(await relay(env, 'session', derive, 'c', { ...c, expiresAtMs: 2000 }));
    expect(near.sent).toHaveLength(2);
  });

  it('spreads sessions over the keys and names a claim by key, expiry and counter', async () => {
    const seen = new Set(await Promise.all(Array.from({ length: 64 }, (_, i) => claimKeyIndex('session', 'secret', [i, 255 - i, (i * 3) % 256, (i * 5) % 256], 3))));
    expect(seen).toEqual(new Set([0, 1, 2]));
    expect(await claimKeyIndex('session', 'secret', [255, 255, 255, 255], 1)).toBe(0);
    await expect(claimKeyIndex('session', 'secret', [1], 0)).rejects.toThrow();
    expect(claimId({ sessionPublicKey: [1, 255], expiresAtMs: 5, counter: 2 })).toBe('01ff:5:2');
  });

  it('routes by a keyed hash: the pool secret and the session key decide the index, never the key’s first bytes', async () => {
    const spk = Array(32).fill(0).map((_, i) => (i * 11 + 5) % 256);
    const again = await claimKeyIndex('session', 'one', spk, 1009);
    expect(await claimKeyIndex('session', 'one', spk, 1009)).toBe(again); // stable for one secret, whichever isolate asks
    const others = await Promise.all(['two', 'three', 'four', 'five'].map((secret) => claimKeyIndex('session', secret, spk, 1009)));
    expect(others.some((i) => i !== again)).toBe(true);
    // The pool is part of the label, so one secret can't tie a session pool's order to another pool's.
    expect(await claimKeyIndex('owner', 'one', spk, 1009)).not.toBe(again);
    // With the same first four bytes, the old unkeyed rule always chose the same index.
    const seen = new Set(await Promise.all(Array.from({ length: 32 }, (_, i) => claimKeyIndex('session', 'one', [1, 2, 3, 4, i], 8))));
    expect(seen.size).toBeGreaterThan(1);
  });
});

describe('a claimed relay fails over to the next key once (D455)', () => {
  const sessionPublicKey = Array(32).fill(0).map((_, i) => (i * 13 + 1) % 256);
  const claim = { sessionPublicKey, expiresAtMs: 1000, counter: 2 };
  const derive = { method: 'derive_key', args: {} };
  const ok: RelayResult = { ok: true, result: { big_y: 'y', big_c: 'c' }, nearTx: 'tx-b', relayerPk: 'pk-b', relayerNonce: '7' };
  const failed = (code: string, status: number, extra: Record<string, unknown> = {}): RelayResult => ({ ok: false, status, code, error: code, ...extra });

  /** `relay()` against a scripted pool: each key index's object answers or throws from `script` (default `ok`). */
  function scripted(script: Record<number, () => RelayResult>, keysJson: string = env.RELAYER_KEYS) {
    const calls: { index: number; claim?: string }[] = [];
    const ns = {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        relay: (_pool: Pool, index: number, _call: unknown, _requestId?: string, c?: string) => {
          expect(name).toBe(relayerKeyName('session', index));
          calls.push({ index, claim: c });
          return Promise.resolve().then(() => (script[index] ?? (() => ok))());
        },
      }),
    };
    return { calls, e: { ...env, RELAYER_KEYS: keysJson, RELAYER_KEY: ns as unknown as typeof env.RELAYER_KEY } };
  }

  const primaryIndex = () => claimKeyIndex('session', env.RELAYER_KEYS, sessionPublicKey, relayerKeyCount(env));

  for (const [name, bad] of [
    ['near_rejected', failed('near_rejected', 502, { nearTx: 'tx-a' })],
    ['near_unavailable', failed('near_unavailable', 502)],
    ['relayer_busy', failed('relayer_busy', 503, { nearTx: 'tx-a' })],
    ['relayer_unavailable (no transaction)', failed('relayer_unavailable', 503)],
  ] as const) {
    it(`${name}: tried once more on the next index with the same claim, and that answer returned`, async () => {
      const first = await primaryIndex();
      const count = relayerKeyCount(env);
      const { calls, e } = scripted({ [first]: () => bad });
      const out = await relay(e, 'session', derive, 'r', claim);
      expect(out).toMatchObject({ ok: true, nearTx: 'tx-b', keyIndex: (first + 1) % count });
      expect(calls.map((c) => c.index)).toEqual([first, (first + 1) % count]);
      expect(calls[0]!.claim).toBe(claimId(claim));
      expect(calls[1]!.claim).toBe(claimId(claim));
    });
  }

  it('a thrown object call (the object reset or was unavailable) is covered too', async () => {
    const first = await primaryIndex();
    const { calls, e } = scripted({
      [first]: () => {
        throw new Error('Durable Object reset');
      },
    });
    const out = await relay(e, 'session', derive, 'r', claim);
    expect(out).toMatchObject({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('every copy sees the same next key: a retried copy is refused by the object it fails over to', async () => {
    const first = await primaryIndex();
    const count = relayerKeyCount(env);
    const { calls, e } = scripted({ [first]: () => failed('near_rejected', 502, { nearTx: 'tx-a' }), [(first + 1) % count]: () => failed(ALREADY_RELAYED, 409) });
    const out = await relay(e, 'session', derive, 'r2', claim);
    expect(out).toMatchObject({ ok: false, code: ALREADY_RELAYED, keyIndex: (first + 1) % count });
    expect(calls.map((c) => c.index)).toEqual([first, (first + 1) % count]);
  });

  for (const [name, final] of [
    ['contract_rejected (it ran and panicked)', failed('contract_rejected', 422, { nearTx: 'tx-a' })],
    ['timeout (it may still land)', failed('timeout', 504, { nearTx: 'tx-a' })],
    ['near_error (it landed or may have)', failed('near_error', 502, { nearTx: 'tx-a' })],
    ['already_relayed (a copy already went through)', failed(ALREADY_RELAYED, 409)],
    ['relayer_unavailable with a nearTx (a named transaction)', failed('relayer_unavailable', 503, { nearTx: 'tx-a' })],
  ] as const) {
    it(`${name}: not retried, one object called`, async () => {
      const first = await primaryIndex();
      const { calls, e } = scripted({ [first]: () => final });
      const out = await relay(e, 'session', derive, 'r', claim);
      expect(out).toMatchObject({ ok: false, code: final.ok ? '' : final.code });
      expect(calls.map((c) => c.index)).toEqual([first]);
    });
  }

  it('fails over once only; two definite failures answer with the second', async () => {
    const first = await primaryIndex();
    const count = relayerKeyCount(env);
    const { calls, e } = scripted({ [first]: () => failed('near_rejected', 502, { nearTx: 'tx-a' }), [(first + 1) % count]: () => failed('near_unavailable', 502) });
    const out = await relay(e, 'session', derive, 'r', claim);
    expect(out).toMatchObject({ ok: false, code: 'near_unavailable', keyIndex: (first + 1) % count });
    expect(calls).toHaveLength(2);
  });

  it('a first call that may have left the object stays the answer over a second that did not execute', async () => {
    const first = await primaryIndex();
    const count = relayerKeyCount(env);
    const { calls, e } = scripted({
      [first]: () => {
        throw new Error('reset');
      },
      [(first + 1) % count]: () => failed('near_rejected', 502, { nearTx: 'tx-b' }),
    });
    const out = await relay(e, 'session', derive, 'r', claim);
    // The vault polls or re-syncs on this code; near_rejected (NOT_EXECUTED) would tell it the request surely didn't run.
    expect(out).toMatchObject({ ok: false, code: 'relayer_unavailable', keyIndex: first });
    expect(calls).toHaveLength(2);
  });

  it('a pool of one key has nowhere to fail over to', async () => {
    const one = JSON.stringify([keys[0]]);
    const { calls, e } = scripted({ 0: () => failed('near_rejected', 502, { nearTx: 'tx-a' }) }, one);
    expect(await relay(e, 'session', derive, 'r', claim)).toMatchObject({ ok: false, code: 'near_rejected' });
    expect(calls).toHaveLength(1);
  });

  it('a relay without a claim is not failed over (a resend picks another key round-robin)', async () => {
    const { calls, e } = scripted({ 0: () => failed('near_rejected', 502), 1: () => failed('near_rejected', 502), 2: () => failed('near_rejected', 502) });
    expect(await relay(e, 'session', derive, 'r')).toMatchObject({ ok: false, code: 'near_rejected' });
    expect(calls).toHaveLength(1);
  });

  it('through the real objects: a key that lost its allowance, a claimed derive lands on the next key', async () => {
    const near = new NearMock();
    near.install();
    const first = await primaryIndex();
    const count = relayerKeyCount(env);
    const badKey = publicKeyOf(first);
    const rejected = { error: { name: 'HANDLER_ERROR', cause: { name: 'INVALID_TRANSACTION', info: { InvalidAccessKeyError: 'NotEnoughAllowance' } }, data: { TxExecutionError: { InvalidTxError: 'NotEnoughAllowance' } }, message: 'InvalidTxError' } };
    near.onSendTx = (tx) => (tx.publicKey === badKey ? rejected : undefined);
    const out = await relay(env, 'session', derive, 'r', { ...claim, sessionPublicKey });
    expect(out).toMatchObject({ ok: true, keyIndex: (first + 1) % count });
    expect(near.sent.map((t) => t.publicKey)).toEqual([publicKeyOf((first + 1) % count)]);
  });
});

describe('relayer pool', () => {
  it('answers 503 when no relayer keys are configured', async () => {
    const near = new NearMock();
    near.install();
    for (const RELAYER_KEYS of ['[]', '', 'not json', '[1]']) {
      expect(await relay({ ...env, RELAYER_KEYS }, 'session', revokeCall(1), 'r')).toMatchObject({ ok: false, status: 503, code: 'relayer_unconfigured' });
    }
    // The owner pool is configured separately: without it owner actions fail, logins don't.
    for (const OWNER_RELAYER_KEYS of [undefined, '[]', 'not json']) {
      expect(await relay({ ...env, OWNER_RELAYER_KEYS }, 'owner', { method: 'execute_change', args: {} }, 'r')).toMatchObject({ ok: false, status: 503, code: 'relayer_unconfigured' });
    }
    expect(near.rpcMethods).toHaveLength(0);
  });

  it('routes each method to its pool and refuses the other pool’s methods', async () => {
    const near = new NearMock();
    near.install();
    expect(await relay(env, 'session', { method: 'execute_change', args: {} }, 'r')).toMatchObject({ ok: false, code: 'method_not_allowed' });
    expect(await relay(env, 'owner', revokeCall(1), 'r')).toMatchObject({ ok: false, code: 'method_not_allowed' });
    expect(near.sent).toHaveLength(0);
    const owner = await relay(env, 'owner', { method: 'execute_change', args: { scope_id: 's1', change_id: 0 } }, 'r');
    const session = await relay(env, 'session', revokeCall(7), 'r');
    expect(owner.ok && session.ok).toBe(true);
    expect(near.sent.map((t) => [t.method, t.publicKey])).toEqual([
      ['execute_change', publicKeyOf(owner.keyIndex!, 'owner')],
      ['revoke_session', publicKeyOf(session.keyIndex!)],
    ]);
    expect(relayerKeyCount(env, 'owner')).toBe(ownerKeys.length);
  });

  it('pins relayer key objects to DO_LOCATION_HINT through their name; an unknown hint is ignored', async () => {
    const near = new NearMock();
    near.install();
    const placed = await relay({ ...env, DO_LOCATION_HINT: 'apac' }, 'session', revokeCall(1), 'r-apac');
    expect(placed.ok).toBe(true);
    const name = `${relayerKeyName('session', placed.keyIndex!)}@apac`;
    // The named object holds the reservation covering the nonce it sent.
    expect(await storedNonce(env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(name)))).toBe(near.sent[0]!.nonce + RESERVE - 1n);
    const unknown = await relay({ ...env, DO_LOCATION_HINT: 'mars' }, 'session', revokeCall(2), 'r-mars');
    expect(unknown.ok).toBe(true);
    // Earlier tests may have relayed through this unhinted object: its reservation covers the nonce, maybe more.
    const reserved = await storedNonce(env.RELAYER_KEY.get(env.RELAYER_KEY.idFromName(relayerKeyName('session', unknown.keyIndex!))));
    expect(reserved).toBeGreaterThanOrEqual(near.sent[1]!.nonce);
    expect(reserved).toBeLessThan(near.sent[1]!.nonce + RESERVE);
  });

  it('round-robins across keys', () => {
    const picks = Array.from({ length: 6 }, () => pickKeyIndex(3));
    expect(new Set(picks).size).toBe(3);
    for (let i = 1; i < picks.length; i++) expect(picks[i]).toBe((picks[i - 1]! + 1) % 3);
    expect(relayerKeyName('session', 1)).toBe('relayer-key-1');
    expect(relayerKeyName('owner', 1)).toBe('owner-relayer-key-1');
  });

  it('N parallel HTTP requests: every key’s nonces are distinct and consecutive', async () => {
    clearViewCaches();
    const plan = `p${uid()}`;
    await seedPlan(plan, 1000, 1000, 1000);
    const app = await seedApp({ plan });
    const aud = `${uid()}.apps.googleusercontent.com`;
    const near = chain({ [aud]: app.scope });
    near.onSendTx = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 20));
    const before = new Map(keys.map((_, i) => [publicKeyOf(i), near.nonceOf(publicKeyOf(i))]));
    const N = 20;
    const bodies = await Promise.all(Array.from({ length: N }, () => sessionBody(app.scope, aud)));
    const responses = await Promise.all(bodies.map((b) => call('/v1/sessions', { headers: appHeaders(app), body: b })));
    expect(responses.map((r) => r.status)).toEqual(Array(N).fill(200));
    expect(near.sent).toHaveLength(N);
    const byKey = new Map<string, bigint[]>();
    for (const t of near.sent) byKey.set(t.publicKey, [...(byKey.get(t.publicKey) ?? []), t.nonce]);
    expect(byKey.size).toBe(keys.length);
    for (const [pk, nonces] of byKey) {
      // The pool DOs may have relayed in earlier tests; within this burst each key's nonces are consecutive.
      const min = nonces.reduce((a, b) => (b < a ? b : a));
      expect(min).toBeGreaterThan(before.get(pk)!);
      expectConsecutive(nonces, min);
    }
  });
});
