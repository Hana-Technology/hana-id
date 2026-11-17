// The EVM relayer object (evm-relayer.ts, D837) against a fake chain (test/evm-mock.ts) in the Workers test pool:
// idempotency, nonce order, crashes at every step, RPC failures and flapping, replacement, the deadline's
// self-transfer, definite rejections, cold-start reconciliation, the alarm, the key check and bounded storage.
// Each object gets its own config (EVM_SPONSOR for the local chain 31337 in a `local*` env, a test relayer key) by
// replacing its instance's env, as test/near-relay.test.ts does for the NEAR relay; after a crash the new instance gets
// it again (configure). The test clock starts in 2027, so no alarm fires on its own: the tests run them.
import { SPONSOR_DELEGATES, signAuthorization, type SignedAuthorization, EXECUTE_SELECTOR } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import {
  CANCEL_GAS,
  EVM_RELAYER_ALARM_MS,
  EVM_RELAYER_MAX_HASHES,
  EVM_RELAYER_MAX_PENDING,
  EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS,
  EVM_RELAYER_REPLACE_AFTER_MS,
  type EvmRelayer,
  type EvmRelayerSendRequest,
  bumpedFees,
  evmRelayKeyAddress,
  evmRelayerError,
  evmRelayerName,
} from '../src/evm-relayer.ts';
import { checksumEvmAddress, evmSponsorVar } from '../src/evm/sponsor-config.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { uid } from './helpers.ts';
import { EvmMock, FALLBACK_RPC, type Hex, PRIMARY_RPC, addressOf } from './evm-mock.ts';

const CHAIN = 31337;
const DELEGATE = SPONSOR_DELEGATES[CHAIN]!.address;
const GWEI = 10n ** 9n;

/** Test-only keys, derived at run time (never literals). */
const testKey = (label: string): Uint8Array => sha256(new TextEncoder().encode(`hana-id evm-relayer test key: ${label}`));
const keyHex = (d: Uint8Array): string => `0x${Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const RELAYER_KEY = testKey('relayer');
const RELAYER_KEY_HEX = keyHex(RELAYER_KEY);
const RELAYER = checksumEvmAddress(addressOf(secp256k1.getPublicKey(RELAYER_KEY, false))) as Hex;
const OTHER_KEY_HEX = keyHex(testKey('another relayer'));
const USER_KEY = testKey('user');
const USER = checksumEvmAddress(addressOf(secp256k1.getPublicKey(USER_KEY, false))) as Hex;

const chainSettings = (over: Record<string, unknown> = {}) => ({
  rpc: PRIMARY_RPC,
  rpcFallback: FALLBACK_RPC,
  delegate: DELEGATE,
  opStack: false,
  maxGasPerTx: 300_000,
  maxFeePerGasGwei: 1,
  maxPriorityFeePerGasGwei: 0.01,
  maxCallsPerBatch: 4,
  deadlineMaxS: 600,
  minGas: 100_000,
  dailyBudgetEth: 0.02,
  appDailyBudgetEth: 0.01,
  lowBalanceEth: 0.05,
  perUserPerDay: 30,
  perAppPerDay: 2000,
  sendsPerDay: 5000,
  sendsPerMinute: 60,
  ...over,
});

function sponsorVar(over: Record<string, unknown> = {}, relayerAddress: string = RELAYER): string {
  return evmSponsorVar({ relayerAddress, chains: { [CHAIN]: chainSettings(over) as never }, apps: {} });
}

/** The env an object runs with: a local* env (chain 31337 is local-only), the config and the relayer key. */
const overlay = (over: Partial<Record<string, string | undefined>> = {}): Partial<Env> => ({
  ENV_NAME: 'local-evm-test',
  NETWORK: 'testnet',
  EVM_SPONSOR: sponsorVar(),
  EVM_RELAY_KEYS: JSON.stringify([RELAYER_KEY_HEX]),
  ...over,
});

type Stub = DurableObjectStub<EvmRelayer>;

async function configure(stub: Stub, over: Partial<Env> = overlay()): Promise<void> {
  await runInDurableObject(stub, (instance: EvmRelayer) => {
    const self = instance as unknown as { env: Env };
    self.env = { ...self.env, ...over } as Env;
  });
}

/** A fresh object (its own name, so its own storage), configured. */
async function fresh(over: Partial<Env> = overlay()): Promise<Stub> {
  const ns = env.EVM_RELAYER!;
  const stub = ns.get(ns.idFromName(`${evmRelayerName(CHAIN)}-test-${uid()}`));
  await configure(stub, over);
  return stub;
}

/**
 * Crashes the object (memory lost, storage kept), as an eviction, deploy or runtime restart would, and returns a new
 * stub (an aborted object's stub stays broken) to the next instance, configured.
 */
async function crash(stub: Stub, over: Partial<Env> = overlay()): Promise<Stub> {
  await runInDurableObject(stub, (_i, state) => state.abort('test crash')).catch(() => undefined);
  const next = env.EVM_RELAYER!.get(stub.id);
  await configure(next, over);
  return next;
}

let clock: { now: number; advance(ms: number): void };
function testClock(start = 1_800_000_000_000): typeof clock {
  let now = start;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  return {
    get now() {
      return now;
    },
    set now(v: number) {
      now = v;
    },
    advance: (ms: number) => void (now += ms),
  };
}

const nowS = (): bigint => BigInt(Math.floor(clock.now / 1000));
let digestCounter = 0;
const newDigest = (): Hex => `0x${(++digestCounter).toString(16).padStart(8, '0')}${uid().replace(/[^0-9a-f]/gu, '0').padEnd(56, '0').slice(0, 56)}`;

function request(over: Partial<EvmRelayerSendRequest> = {}): EvmRelayerSendRequest {
  const gas = 200_000n;
  const maxFeePerGas = GWEI / 10n;
  return {
    digest: newDigest(),
    chainId: CHAIN,
    to: USER,
    data: `${EXECUTE_SELECTOR}${'00'.repeat(96)}` as Hex,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: GWEI / 1000n,
    deadline: nowS() + 300n,
    reservedWei: gas * maxFeePerGas + 10n ** 12n,
    ...over,
  };
}

const authorization = (over: { nonce?: bigint } = {}, key = USER_KEY): SignedAuthorization =>
  signAuthorization(key, { chainId: CHAIN, address: DELEGATE, nonce: over.nonce ?? 0n }, { enabledChains: [CHAIN] });

async function codeOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    const c = evmRelayerError(e);
    return c ? (c.reason ? `${c.code}:${c.reason}` : c.code) : `uncoded: ${(e as Error).message}`;
  }
}

interface Stored {
  meta: { nextNonce: number | null; remembered: number; chainId: number; address: string } | undefined;
  tx: { nonce: number; kind: string; hashes: string[]; hash: string; maxFeePerGas: string; maxPriorityFeePerGas: string; to: string; data: string; gas: string }[];
  digests: string[];
  forget: string[];
  alarm: number | null;
}

async function stored(stub: Stub): Promise<Stored> {
  return runInDurableObject(stub, async (_i, state) => {
    const kv = state.storage.kv;
    return {
      meta: kv.get('meta'),
      tx: Array.from(kv.list<Stored['tx'][number]>({ prefix: 'tx:' }), ([, v]) => v),
      digests: Array.from(kv.list({ prefix: 'digest:' }), ([k]) => k),
      forget: Array.from(kv.list({ prefix: 'forget:' }), ([k]) => k),
      alarm: await state.storage.getAlarm(),
    };
  });
}

async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; !cond(); i++) {
    if (i > 2000) throw new Error('Timed out waiting for a condition');
    await new Promise((r) => setTimeout(r, 5));
  }
}

let chain: EvmMock;
beforeEach(() => {
  forgetVerifiedChains();
  clock = testClock();
  chain = new EvmMock({ chainId: CHAIN }).install();
});
afterEach(() => vi.restoreAllMocks());

describe('EvmRelayer: sending', () => {
  it('signs a type-2 transaction from the relayer to the account, at the chain’s nonce, and persists it before the broadcast', async () => {
    chain.minedCount.set(RELAYER.toLowerCase(), 7);
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    expect(sent).toMatchObject({ relayerNonce: 7, replay: false });
    const tx = chain.pooled(RELAYER, 7)!;
    expect(tx).toMatchObject({ type: 2, from: RELAYER.toLowerCase(), to: USER.toLowerCase(), nonce: 7, value: 0n, gas: req.gas, maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas, data: req.data, chainId: BigInt(CHAIN) });
    expect(sent.transactionHash).toBe(tx.hash);
    expect(sent.raw).toBe(tx.raw);
    const s = await stored(stub);
    expect(s.meta).toMatchObject({ nextNonce: 8, remembered: 1, chainId: CHAIN, address: RELAYER });
    expect(s.tx.map((t) => t.nonce)).toEqual([7]);
    expect(s.alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
    // The chain was checked first (eth_chainId), then read, then sent to.
    expect(chain.calls[0]).toEqual({ endpoint: 0, method: 'eth_chainId' });
  });

  it('a type-4 transaction carries the user’s authorization; an authorization for another delegate, chain or account is refused', async () => {
    const stub = await fresh();
    const sent = await stub.send(request({ authorization: authorization() }));
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ type: 4, authorizations: 1, to: USER.toLowerCase() });
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), chainId: 84532 } })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: authorization({}, testKey('someone else')) })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), address: USER } })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), s: `0x${'f'.repeat(64)}` as Hex } })))).toBe('invalid_request');
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('refuses what the handlers must never send: over the caps, a reservation below the worst case, other calldata, other destinations, bad deadlines', async () => {
    const stub = await fresh();
    const cases: [Partial<EvmRelayerSendRequest>, string][] = [
      [{ gas: 300_001n }, 'invalid_request'],
      [{ gas: 20_000n }, 'invalid_request'],
      [{ maxFeePerGas: GWEI + 1n }, 'invalid_request'],
      [{ maxPriorityFeePerGas: GWEI / 100n + 1n }, 'invalid_request'],
      [{ maxFeePerGas: 1000n, maxPriorityFeePerGas: 1001n, reservedWei: 10n ** 18n }, 'invalid_request'],
      [{ reservedWei: 200_000n * (GWEI / 10n) - 1n }, 'invalid_request'],
      [{ data: '0xa9059cbb' as Hex }, 'invalid_request'],
      [{ data: 'not hex' as Hex }, 'invalid_request'],
      [{ to: RELAYER }, 'invalid_request'],
      [{ to: DELEGATE as Hex }, 'invalid_request'],
      [{ to: `0x${'0'.repeat(40)}` as Hex }, 'invalid_request'],
      [{ deadline: nowS() + 5n }, 'deadline_passed'],
      [{ deadline: nowS() - 1n }, 'deadline_passed'],
      [{ deadline: nowS() + 661n }, 'invalid_request'],
      [{ gas: 1 as unknown as bigint }, 'invalid_request'],
      [{ digest: '0x1234' as Hex }, 'invalid_request'],
      [{ chainId: 0 }, 'invalid_request'],
    ];
    for (const [over, code] of cases) expect([over, await codeOf(stub.send(request(over)))]).toEqual([over, code]);
    expect(chain.broadcasts).toHaveLength(0);
    // Nothing was persisted for them.
    expect((await stored(stub)).tx).toEqual([]);
  });

  it('serves one chain for its life: another chain is wrong_chain, an unconfigured chain is relayer_unconfigured', async () => {
    const stub = await fresh();
    expect(await codeOf(stub.send(request({ chainId: 84532 })))).toBe('relayer_unconfigured');
    await stub.send(request());
    expect(await codeOf(stub.send(request({ chainId: 84532 })))).toBe('wrong_chain');
  });

  it('N concurrent sends get N consecutive nonces, each broadcast once, in nonce order', async () => {
    chain.minedCount.set(RELAYER.toLowerCase(), 40);
    // Slow, jittery broadcasts: the section still hands nonces out in order.
    chain.onSend = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 20));
    const stub = await fresh();
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => stub.send(request())));
    expect(results.map((r) => r.relayerNonce).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => 40 + i));
    expect(chain.broadcasts.map((b) => b.tx.nonce)).toEqual(Array.from({ length: N }, (_, i) => 40 + i));
    expect(chain.pendingCount(RELAYER)).toBe(40 + N);
    expect(new Set(results.map((r) => r.transactionHash)).size).toBe(N);
  });
});

describe('EvmRelayer: idempotency by digest', () => {
  it('concurrent identical requests make one transaction: one answer replay false, the rest the same hash with replay true', async () => {
    const stub = await fresh();
    const req = request();
    const results = await Promise.all(Array.from({ length: 10 }, () => stub.send(req)));
    expect(new Set(results.map((r) => r.transactionHash)).size).toBe(1);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(results.every((r) => r.relayerNonce === results[0]!.relayerNonce && r.raw === results[0]!.raw)).toBe(true);
    expect(chain.broadcasts).toHaveLength(1);
    // Later, and after the transaction is mined: still the same answer, nothing sent.
    expect(await stub.send(req)).toMatchObject({ transactionHash: results[0]!.transactionHash, replay: true });
    chain.mine(RELAYER);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.send({ ...req, gas: 250_000n })).toMatchObject({ transactionHash: results[0]!.transactionHash, raw: results[0]!.raw, replay: true });
    expect(await stub.lookup(req.digest)).toMatchObject({ state: 'mined', hashes: [results[0]!.transactionHash], relayerNonce: results[0]!.relayerNonce });
    expect(chain.broadcasts).toHaveLength(1);
    // The digest's case doesn't matter.
    expect(await stub.send({ ...req, digest: req.digest.toUpperCase().replace('0X', '0x') as Hex })).toMatchObject({ replay: true });
  });
});

describe('EvmRelayer: crashes at every step never reuse a nonce, leave a gap or lose a transaction', () => {
  it('a failed write before persisting (after the nonce was chosen) sends nothing; the nonce is used by the next send', async () => {
    chain.minedCount.set(RELAYER.toLowerCase(), 3);
    let stub = await fresh();
    await stub.send(request());
    await runInDurableObject(stub, (_i, state) => {
      vi.spyOn(state.storage, 'transactionSync').mockImplementationOnce(() => {
        throw new Error('storage write failed');
      });
    });
    const req = request();
    expect(await codeOf(stub.send(req))).toMatch(/^uncoded/u);
    expect(chain.broadcasts).toHaveLength(1);
    expect((await stored(stub)).meta?.nextNonce).toBe(4);
    stub = await crash(stub);
    const again = await stub.send(req);
    expect(again).toMatchObject({ relayerNonce: 4, replay: false });
    expect(chain.pendingCount(RELAYER)).toBe(5);
  });

  it('a crash while reading the chain (before any nonce) leaves nothing stored', async () => {
    let stub = await fresh();
    let release!: () => void;
    chain.onRead = (method) => (method === 'eth_getTransactionCount' ? new Promise<void>((r) => (release = r)) : undefined);
    const req = request();
    const pending = stub.send(req).then(
      () => 'sent',
      () => 'failed',
    );
    await until(() => release !== undefined);
    stub = await crash(stub);
    release();
    expect(await pending).toBe('failed');
    chain.onRead = undefined;
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 0, replay: false });
  });

  it('a crash after persisting, before the broadcast reached any node: the next instance broadcasts the same raw first', async () => {
    chain.minedCount.set(RELAYER.toLowerCase(), 10);
    let stub = await fresh();
    chain.onSend = () => 'hang';
    const req = request();
    const first = stub.send(req).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 1);
    stub = await crash(stub);
    expect(await first).toBe('failed');
    expect(chain.pooledAll(RELAYER)).toEqual([]);
    const s = await stored(stub);
    expect(s.tx.map((t) => t.nonce)).toEqual([10]);
    chain.onSend = undefined;
    // A different batch: the stored nonce 10 goes out again (same raw) before 11 is used.
    const next = await stub.send(request());
    expect(next.relayerNonce).toBe(11);
    expect(chain.pooled(RELAYER, 10)?.hash).toBe(s.tx[0]!.hash);
    expect(chain.pendingCount(RELAYER)).toBe(12);
    // The first batch again: its own transaction, never a second one.
    expect(await stub.send(req)).toMatchObject({ transactionHash: s.tx[0]!.hash, relayerNonce: 10, replay: true });
    expect(chain.broadcasts.filter((b) => b.tx.nonce === 10).map((b) => b.tx.hash)).toEqual([s.tx[0]!.hash, s.tx[0]!.hash]);
  });

  it('the same crash, then only the alarm: it broadcasts the stored transaction', async () => {
    let stub = await fresh();
    chain.onSend = () => 'hang';
    const p = stub.send(request()).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 1);
    stub = await crash(stub);
    await p;
    chain.onSend = undefined;
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(chain.pendingCount(RELAYER)).toBe(1);
    expect((await stored(stub)).alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
  });

  it('a crash after the broadcast was accepted: nothing is sent twice, the next nonce follows', async () => {
    let stub = await fresh();
    chain.onSend = () => 'accept_then_hang';
    const req = request();
    const first = stub.send(req).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 1);
    stub = await crash(stub);
    await first;
    chain.onSend = undefined;
    const hash = chain.pooled(RELAYER, 0)!.hash;
    expect(await stub.send(req)).toMatchObject({ transactionHash: hash, relayerNonce: 0, replay: true });
    expect((await stub.send(request())).relayerNonce).toBe(1);
    // Nonce 0 was in the pool: not broadcast again.
    expect(chain.broadcasts.filter((b) => b.tx.nonce === 0)).toHaveLength(1);
    expect(chain.pendingCount(RELAYER)).toBe(2);
  });

  it('three in flight, a crash, then the chain drops one: every nonce ends up in the pool once, no gap', async () => {
    let stub = await fresh();
    chain.onSend = (tx) => (tx.nonce === 2 ? 'hang' : undefined);
    const reqs = [request(), request(), request()];
    const results = Promise.allSettled(reqs.map((r) => stub.send(r)));
    await until(() => chain.broadcasts.length === 3);
    stub = await crash(stub);
    await results;
    chain.onSend = undefined;
    chain.drop(RELAYER, 1);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2]);
    for (const r of reqs) expect((await stub.send(r)).replay).toBe(true);
    expect(chain.mine(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2]);
  });
});

describe('EvmRelayer: RPC failures', () => {
  it('reads and sends fail over to the fallback; a primary that flaps keeps nonces consecutive and every transaction single', async () => {
    const stub = await fresh();
    chain.modes[0] = 'down';
    expect((await stub.send(request())).relayerNonce).toBe(0);
    expect(chain.broadcasts.map((b) => b.endpoint)).toEqual([1]);
    let flip = 0;
    chain.onSend = (_tx, endpoint) => (endpoint === 0 && flip++ % 2 === 0 ? 'network' : undefined);
    const modes: ('up' | 'down' | 'http503' | 'rate_limited')[] = ['up', 'down', 'http503', 'rate_limited'];
    for (let i = 1; i <= 8; i++) {
      chain.modes[0] = modes[i % modes.length]!;
      expect((await stub.send(request())).relayerNonce).toBe(i);
    }
    chain.modes[0] = 'up';
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(new Set(chain.pooledAll(RELAYER).map((t) => t.hash)).size).toBe(9);
    // A raw that the primary may have taken before its connection dropped goes to the fallback the same: never re-signed.
    for (const n of new Set(chain.broadcasts.map((b) => b.tx.nonce))) expect(new Set(chain.broadcasts.filter((b) => b.tx.nonce === n).map((b) => b.tx.hash)).size).toBe(1);
  });

  it('an endpoint on another chain is never read from or sent to', async () => {
    chain.modes[1] = 'wrong_chain';
    chain.modes[0] = 'down';
    const stub = await fresh();
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect(chain.calls.filter((c) => c.endpoint === 1).every((c) => c.method === 'eth_chainId')).toBe(true);
    expect(chain.broadcasts).toHaveLength(0);
    expect((await stored(stub)).tx).toEqual([]);
  });

  it('cold with both endpoints down: rpc_unavailable and nothing stored; warm with the broadcast failing everywhere: stored, answered, broadcast by the alarm', async () => {
    const stub = await fresh();
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect((await stored(stub)).tx).toEqual([]);
    chain.modes[0] = 'up';
    chain.modes[1] = 'up';
    await stub.send(request());
    chain.onSend = () => 'network';
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ relayerNonce: 1, replay: false });
    expect(chain.pooled(RELAYER, 1)).toBeUndefined();
    chain.onSend = undefined;
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 1)?.hash).toBe(sent.transactionHash);
  });

  it('the alarm with the chain unreadable changes nothing and tries again in 15 s', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS + 1);
    const before = await stored(stub);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const after = await stored(stub);
    expect(after.tx).toEqual(before.tx);
    expect(after.alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
  });
});

describe('EvmRelayer: stuck transactions', () => {
  it('after 60 s pending, the same nonce with both fees × 1.125 (up to the caps); both hashes remembered; none at the caps', async () => {
    const stub = await fresh();
    const req = request({ maxFeePerGas: (GWEI * 8n) / 10n, maxPriorityFeePerGas: GWEI / 200n, reservedWei: 10n ** 16n });
    const sent = await stub.send(req);
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS - 1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]!.hashes).toHaveLength(1);
    clock.advance(2);
    await runDurableObjectAlarm(stub);
    const one = (await stored(stub)).tx[0]!;
    expect(one.hashes).toEqual([sent.transactionHash, one.hash]);
    expect(BigInt(one.maxFeePerGas)).toBe(900_000_000n);
    expect(BigInt(one.maxPriorityFeePerGas)).toBe(5_625_000n);
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ hash: one.hash, to: USER.toLowerCase(), data: req.data, gas: req.gas });
    // Next: the fee hits its 1 gwei cap (×1.125 would be 1.0125), still ≥ 110%: replaced at the cap.
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    const two = (await stored(stub)).tx[0]!;
    expect(BigInt(two.maxFeePerGas)).toBe(GWEI);
    expect(two.hashes).toHaveLength(3);
    // At the cap no valid replacement exists: no new hash, the last one stays in the pool.
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]!.hashes).toHaveLength(3);
    expect(await stub.lookup(req.digest)).toMatchObject({ state: 'pending', hashes: two.hashes, transactionHash: two.hash });
    expect(await stub.send(req)).toMatchObject({ transactionHash: two.hash, replay: true });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(req.digest)).toMatchObject({ state: 'mined', hashes: two.hashes });
  });

  it('past the deadline, a 0-value self-transfer at the same nonce frees it', async () => {
    const stub = await fresh();
    const req = request({ deadline: nowS() + 30n, authorization: authorization() });
    const sent = await stub.send(req);
    clock.advance(31_000);
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).tx[0]!;
    expect(rec.kind).toBe('cancel');
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ type: 2, to: RELAYER.toLowerCase(), value: 0n, data: '0x', gas: CANCEL_GAS, authorizations: 0 });
    expect(BigInt(rec.maxFeePerGas)).toBe(((GWEI / 10n) * 9n) / 8n);
    expect(await stub.lookup(req.digest)).toMatchObject({ state: 'cancelling', hashes: [sent.transactionHash, rec.hash] });
    // A replay names the self-transfer: the handler finds no Executed event in its receipt (not executed).
    expect(await stub.send(req)).toMatchObject({ transactionHash: rec.hash, replay: true });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.status()).toMatchObject({ pending: 0, nextNonce: 1 });
  });

  it('replacements stop at 64 hashes per nonce (storage bound); the last version stays in the pool', async () => {
    const stub = await fresh(overlay({ EVM_SPONSOR: sponsorVar({ maxFeePerGasGwei: 100, maxPriorityFeePerGasGwei: 100, maxGasPerTx: 50_000, minGas: 10_000, deadlineMaxS: 3600 }) }));
    await stub.send(request({ gas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, reservedWei: 10n ** 15n, deadline: nowS() + 3600n }));
    for (let i = 0; i < EVM_RELAYER_MAX_HASHES + 4; i++) {
      clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
      await runDurableObjectAlarm(stub);
    }
    const rec = (await stored(stub)).tx[0]!;
    expect(rec.hashes).toHaveLength(EVM_RELAYER_MAX_HASHES);
    expect(new Set(rec.hashes).size).toBe(EVM_RELAYER_MAX_HASHES);
    // Past its deadline on the way: the later versions are self-transfers.
    expect(rec.kind).toBe('cancel');
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.hash);
  });
});

describe('EvmRelayer: definite rejections', () => {
  it('every endpoint refuses and the pending count confirms: the nonce, record and memory go back (rejected), and the digest may be sent again', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    const req = request();
    expect(await codeOf(stub.send(req))).toBe('rejected:insufficient_funds');
    expect(chain.broadcasts.slice(1).map((b) => b.endpoint)).toEqual([0, 1]);
    const s = await stored(stub);
    expect(s.meta).toMatchObject({ nextNonce: 1, remembered: 1 });
    expect(s.tx.map((t) => t.nonce)).toEqual([0]);
    chain.onSend = undefined;
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 1, replay: false });
  });

  it('a node that refuses but holds it anyway (pending count past the nonce): the record stays and the hash is answered', async () => {
    const stub = await fresh();
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? { error: 'insufficient funds for gas * price + value', keep: true } : { error: 'insufficient funds for gas * price + value' });
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ relayerNonce: 0, replay: false });
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([0]);
  });

  it('the pending count can’t be read, or one endpoint gave no answer: kept (unknown), never freed', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.onSend = () => ({ error: 'transaction underpriced' });
    chain.countFailures = 0;
    const realOnRead = chain.onRead;
    chain.onRead = () => {
      chain.countFailures = 2;
      chain.onRead = realOnRead;
    };
    // The next read after the rejection fails on both endpoints.
    const unread = await stub.send(request());
    expect(unread.relayerNonce).toBe(1);
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? { error: 'transaction underpriced' } : 'network');
    const mixed = await stub.send(request());
    expect(mixed.relayerNonce).toBe(2);
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([0, 1, 2]);
    expect((await stored(stub)).meta?.nextNonce).toBe(3);
  });

  it('nonce too low (the key was used elsewhere): dropped once the mined count is past it, then sent at the chain’s next nonce', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    // Another sender used nonces 1 and 2.
    chain.foreignMine(RELAYER, 3);
    const req = request();
    const sent = await stub.send(req);
    expect(sent).toMatchObject({ relayerNonce: 3, replay: false });
    expect(chain.broadcasts.filter((b) => b.outcome === 'nonce_too_low').map((b) => b.tx.nonce)).toEqual([1, 1]);
    const s = await stored(stub);
    expect(s.tx.map((t) => t.nonce).sort()).toEqual([3]);
    expect(s.meta?.nextNonce).toBe(4);
    expect(await stub.lookup(req.digest)).toMatchObject({ relayerNonce: 3, state: 'pending' });
  });
});

describe('EvmRelayer: reconciliation on a cold start', () => {
  it('takes the chain’s counts when they are ahead, never goes below what it stored, and clears records the chain mined', async () => {
    let stub = await fresh();
    await stub.send(request());
    await stub.send(request());
    // The chain mined both; meanwhile another sender's transactions sit in the pool at 2 and 3.
    chain.mine(RELAYER);
    const foreign = { ...chain.minedTxs[0]!, hash: `0x${'ab'.repeat(32)}` as Hex };
    chain.admit({ ...foreign, nonce: 2 });
    chain.admit({ ...foreign, nonce: 3, hash: `0x${'cd'.repeat(32)}` as Hex });
    stub = await crash(stub);
    expect((await stub.send(request())).relayerNonce).toBe(4);
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([4]);
    // A lagging node (counts far behind) after a restart: the stored next nonce stands.
    stub = await crash(stub);
    chain.modes[0] = 'down';
    chain.staleCounts.set(1, { latest: 0, pending: 0 });
    expect((await stub.send(request())).relayerNonce).toBe(5);
    // And the records it still holds are not deleted on the lagging node's word.
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([4, 5]);
  });

  it('confirmations out of order with a lagging node: only what the chain mined is cleared, nothing is resurrected', async () => {
    const stub = await fresh();
    const reqs = [request(), request(), request()];
    for (const r of reqs) await stub.send(r);
    chain.mine(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([1, 2]);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx).toEqual([]);
    // The fallback reports the chain as it was; the primary is down.
    chain.modes[0] = 'down';
    chain.staleCounts.set(1, { latest: 1, pending: 1 });
    const next = await stub.send(request());
    expect(next.relayerNonce).toBe(3);
    expect((await stored(stub)).tx.map((t) => t.nonce)).toEqual([3]);
    for (const r of reqs) expect(await stub.lookup(r.digest)).toMatchObject({ state: 'mined' });
  });

  it('a nonce below nextNonce with no record (never left by the rules) is filled with a self-transfer', async () => {
    const stub = await fresh();
    await stub.send(request());
    await stub.send(request());
    await stub.send(request());
    chain.drop(RELAYER, 1);
    await runInDurableObject(stub, (_i, state) => state.storage.kv.delete(`tx:${'1'.padStart(16, '0')}`));
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 1)).toMatchObject({ to: RELAYER.toLowerCase(), value: 0n, data: '0x', gas: CANCEL_GAS });
    expect(chain.mine(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2]);
  });
});

describe('EvmRelayer: the alarm and bounded storage', () => {
  it('runs every 15 s while anything is pending, then once at the forget time; mined records go at once, their memory after the deadline', async () => {
    const stub = await fresh();
    const req = request({ deadline: nowS() + 120n });
    await stub.send(req);
    expect((await stored(stub)).alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
    clock.advance(EVM_RELAYER_ALARM_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
    chain.mine(RELAYER);
    clock.advance(EVM_RELAYER_ALARM_MS);
    await runDurableObjectAlarm(stub);
    const forgetAt = Number(req.deadline) * 1000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS;
    const s = await stored(stub);
    expect(s.tx).toEqual([]);
    expect(s.digests).toHaveLength(1);
    expect(s.alarm).toBe(forgetAt + 1);
    clock.now = forgetAt + 1;
    await runDurableObjectAlarm(stub);
    const after = await stored(stub);
    expect(after).toMatchObject({ tx: [], digests: [], forget: [], alarm: null });
    expect(after.meta).toMatchObject({ remembered: 0, nextNonce: 1 });
    expect(await stub.lookup(req.digest)).toBeNull();
  });

  it('a pending batch is never forgotten at its forget time (stuck: kept and looked at later)', async () => {
    const stub = await fresh();
    chain.onSend = () => ({ error: 'transaction underpriced', keep: true });
    const req = request({ deadline: nowS() + 60n });
    await stub.send(req);
    chain.onSend = () => ({ error: 'max fee per gas less than block base fee' });
    clock.advance(60_000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS + 1);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(req.digest)).toMatchObject({ state: 'cancelling' });
    expect((await stored(stub)).digests).toHaveLength(1);
  });

  it(`refuses a send past ${EVM_RELAYER_MAX_PENDING} pending (relayer_busy), before signing`, async () => {
    const stub = await fresh();
    for (let i = 0; i < EVM_RELAYER_MAX_PENDING; i++) await stub.send(request());
    expect(await codeOf(stub.send(request()))).toBe('relayer_busy');
    expect(chain.broadcasts).toHaveLength(EVM_RELAYER_MAX_PENDING);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stub.send(request())).relayerNonce).toBe(EVM_RELAYER_MAX_PENDING);
  });

  it('status: address, pending, the oldest one’s age, the next nonce; from storage, no RPC', async () => {
    const stub = await fresh();
    expect(await stub.status()).toEqual({ address: RELAYER, pending: 0, oldestPendingMs: null, nextNonce: null });
    await stub.send(request());
    clock.advance(5_000);
    await stub.send(request());
    clock.advance(1_000);
    const calls = chain.calls.length;
    expect(await stub.status()).toEqual({ address: RELAYER, pending: 2, oldestPendingMs: 6_000, nextNonce: 2 });
    expect(chain.calls).toHaveLength(calls);
  });
});

describe('EvmRelayer: the key', () => {
  it('a key for another address, a missing, malformed or second key, or no config: everything refused, nothing signed or read', async () => {
    const stub = await fresh();
    await stub.send(request());
    const cases: [Partial<Env>, string][] = [
      [overlay({ EVM_RELAY_KEYS: JSON.stringify([OTHER_KEY_HEX]) }), 'relayer_misconfigured'],
      [overlay({ EVM_RELAY_KEYS: undefined }), 'relayer_misconfigured'],
      [overlay({ EVM_RELAY_KEYS: JSON.stringify([RELAYER_KEY_HEX, OTHER_KEY_HEX]) }), 'relayer_misconfigured'],
      [overlay({ EVM_RELAY_KEYS: JSON.stringify([RELAYER_KEY_HEX.toUpperCase().replace('0X', '0x')]) }), 'relayer_misconfigured'],
      [overlay({ EVM_RELAY_KEYS: RELAYER_KEY_HEX }), 'relayer_misconfigured'],
      [overlay({ EVM_RELAY_KEYS: JSON.stringify([`0x${'0'.repeat(64)}`]) }), 'relayer_misconfigured'],
      [overlay({ EVM_SPONSOR: undefined }), 'relayer_unconfigured'],
      [overlay({ ENV_NAME: 'sandbox-dev' }), 'relayer_unconfigured'],
      [overlay({ NETWORK: 'mainnet' }), 'relayer_unconfigured'],
    ];
    const calls = chain.calls.length;
    for (const [over, code] of cases) {
      await configure(stub, over);
      expect(await codeOf(stub.send(request()))).toBe(code);
      expect(await codeOf(stub.status())).toBe(code);
      clock.advance(EVM_RELAYER_REPLACE_AFTER_MS + 1);
      await runDurableObjectAlarm(stub);
    }
    expect(chain.calls).toHaveLength(calls);
    expect(chain.broadcasts).toHaveLength(1);
    // The pending transaction is kept, untouched, for when the key is right again.
    await configure(stub, overlay());
    expect(await stub.status()).toMatchObject({ pending: 1 });
  });

  it('a new key while the old one’s transactions are pending is refused; once they are mined it starts a new nonce life', async () => {
    const otherAddress = evmRelayKeyAddress(JSON.stringify([OTHER_KEY_HEX]))!;
    const stub = await fresh();
    await stub.send(request());
    const newKey = overlay({ EVM_RELAY_KEYS: JSON.stringify([OTHER_KEY_HEX]), EVM_SPONSOR: sponsorVar({}, otherAddress) });
    await configure(stub, newKey);
    expect(await codeOf(stub.send(request()))).toBe('relayer_misconfigured');
    await configure(stub, overlay());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    await configure(stub, newKey);
    chain.minedCount.set(otherAddress.toLowerCase(), 9);
    expect(await stub.send(request())).toMatchObject({ relayerNonce: 9 });
    expect(chain.pooled(otherAddress, 9)?.from).toBe(otherAddress.toLowerCase());
  });

  it('never logs the key, a raw transaction, calldata or an RPC URL', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const stub = await fresh();
    const req = request({ authorization: authorization() });
    const sent = await stub.send(req);
    chain.modes[0] = 'down';
    await stub.send(request());
    chain.onSend = () => ({ error: 'insufficient funds' });
    await stub.send(request()).catch(() => undefined);
    chain.onSend = undefined;
    clock.advance(10 * 60_000);
    await runDurableObjectAlarm(stub);
    await configure(stub, overlay({ EVM_RELAY_KEYS: JSON.stringify([OTHER_KEY_HEX]) }));
    await stub.send(request()).catch(() => undefined);
    const all = lines.join('\n').toLowerCase();
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of [RELAYER_KEY_HEX.slice(2), OTHER_KEY_HEX.slice(2), sent.raw.slice(2, 120), req.data.slice(2), 'evm-primary', 'evm-fallback', keyHex(USER_KEY).slice(2)]) {
      expect(all).not.toContain(secret.toLowerCase());
    }
  });
});

describe('bumpedFees', () => {
  const caps = { maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n };
  it('multiplies both by 9/8 rounding up, caps them, keeps the tip at most the fee, and refuses a replacement below +10%', () => {
    expect(bumpedFees({ maxFeePerGas: 800n, maxPriorityFeePerGas: 8n }, caps)).toEqual({ maxFeePerGas: 900n, maxPriorityFeePerGas: 9n });
    expect(bumpedFees({ maxFeePerGas: 1n, maxPriorityFeePerGas: 1n }, caps)).toEqual({ maxFeePerGas: 2n, maxPriorityFeePerGas: 2n });
    expect(bumpedFees({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 1n }, caps)).toBeNull();
    expect(bumpedFees({ maxFeePerGas: (GWEI * 95n) / 100n, maxPriorityFeePerGas: 1n }, caps)).toBeNull();
    expect(bumpedFees({ maxFeePerGas: (GWEI * 90n) / 100n, maxPriorityFeePerGas: 1n }, caps)).toEqual({ maxFeePerGas: GWEI, maxPriorityFeePerGas: 2n });
    expect(bumpedFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: GWEI / 100n }, caps)).toBeNull();
    expect(bumpedFees({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 0n }, caps)).toEqual({ maxFeePerGas: 1125n, maxPriorityFeePerGas: 0n });
  });
});

describe('evmRelayerError', () => {
  it('reads only the object’s own codes', () => {
    expect(evmRelayerError(new Error('evm_relayer:rejected:insufficient_funds'))).toEqual({ code: 'rejected', reason: 'insufficient_funds' });
    expect(evmRelayerError(new Error('evm_relayer:relayer_busy'))).toEqual({ code: 'relayer_busy', reason: null });
    expect(evmRelayerError(new Error('evm_relayer:made_up'))).toBeNull();
    expect(evmRelayerError(new Error('Durable Object reset'))).toBeNull();
    expect(evmRelayerError(null)).toBeNull();
  });
});
