// The EVM relayer object (evm-relayer.ts, D837) against a fake chain (test/evm-mock.ts) in the Workers test pool:
// the Execute checked and built inside the object, idempotency, nonce order, crashes at every step, RPC failures and
// flapping, counts cross-checked across endpoints and confirmed before a record goes, reorgs, which hash mined,
// self-healing gaps, replacement and the deadline's self-transfer within fee headroom, definite rejections, the
// alarm's backoff and per-run limits, the daily cap, the key check and bounded storage. The probes of the 2026-11-17
// review (P1–P6) are tests here, named after them. Each object gets its own config (EVM_SPONSOR for the local chain
// 31337 in a `local*` env, a test relayer key) by replacing its instance's env, as test/near-relay.test.ts does for the
// NEAR relay; after a crash the new instance gets it again. The test clock starts in 2027, so no alarm fires on its
// own: the tests run them.
import { type ExecuteInput, SPONSOR_DELEGATES, type SignedAuthorization, encodeExecuteCalldata, executeDigest, signAuthorization, signExecute } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import {
  CANCEL_GAS,
  EVM_RELAYER_ALARM_MAX_MS,
  EVM_RELAYER_ALARM_MS,
  EVM_RELAYER_GAP_HEAL_MS,
  EVM_RELAYER_MAX_HASHES,
  EVM_RELAYER_MAX_PENDING,
  EVM_RELAYER_MAX_QUEUE,
  EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS,
  EVM_RELAYER_REPLACE_AFTER_MS,
  EVM_RELAYER_RUN_LIMITS,
  EVM_RELAYER_TAKEN_AFTER_MS,
  type EvmRelayer,
  type EvmRelayerSendRequest,
  bumpedFees,
  evmRelayKeyAddress,
  evmRelayerError,
  evmRelayerName,
  hasFeeHeadroom,
  maxStartingFees,
} from '../src/evm-relayer.ts';
import { checksumEvmAddress, evmSponsorVar } from '../src/evm/sponsor-config.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { uid } from './helpers.ts';
import { EvmMock, FALLBACK_RPC, type Hex, PRIMARY_RPC, addressOf } from './evm-mock.ts';

const CHAIN = 31337;
const DELEGATE = SPONSOR_DELEGATES[CHAIN]!.address;
const CHECK_IN = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e' as Hex;
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;

/** Test-only keys, derived at run time (never literals). */
const testKey = (label: string): Uint8Array => sha256(new TextEncoder().encode(`hana-id evm-relayer test key: ${label}`));
const keyHex = (d: Uint8Array): string => `0x${Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const addressFor = (d: Uint8Array): Hex => checksumEvmAddress(addressOf(secp256k1.getPublicKey(d, false))) as Hex;
const RELAYER_KEY = testKey('relayer');
const RELAYER_KEY_HEX = keyHex(RELAYER_KEY);
const RELAYER = addressFor(RELAYER_KEY);
const OTHER_KEY_HEX = keyHex(testKey('another relayer'));
const USER_KEY = testKey('user');
const USER = addressFor(USER_KEY);
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;

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
let executeNonce = 0n;

/** An Execute signature by `key` (any fields: no signer-side checks), 65 bytes r ‖ s ‖ v. */
function signRaw(e: ExecuteInput, key: Uint8Array): Hex {
  const sig = secp256k1.sign(executeDigest(e), key);
  return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${(27 + sig.recovery).toString(16)}` as Hex;
}

function request(over: Partial<Omit<EvmRelayerSendRequest, 'execute'>> & { execute?: Partial<ExecuteInput> } = {}, key = USER_KEY): EvmRelayerSendRequest {
  const gas = over.gas ?? 200_000n;
  const maxFeePerGas = over.maxFeePerGas ?? GWEI / 10n;
  const execute: ExecuteInput = {
    chainId: CHAIN,
    account: USER,
    implementation: DELEGATE as Hex,
    calls: [{ to: CHECK_IN, value: 0n, data: '0x183ff085' }],
    nonce: executeNonce++,
    deadline: nowS() + 300n,
    relayer: RELAYER,
    minGas: 100_000n,
    ...over.execute,
  };
  const { execute: _e, ...rest } = over;
  return {
    chainId: CHAIN,
    execute,
    signature: signRaw(execute, key),
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas: GWEI / 1000n,
    reservedWei: gas * maxFeePerGas + 10n ** 12n,
    ...rest,
  };
}
const digestOf = (req: EvmRelayerSendRequest): Hex => toHex(executeDigest(req.execute));

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
  meta: { nextNonce: number | null; remembered: number; chainId: number; address: string; gaps: Record<string, number>; alarmMs: number; dayReservedWei: string } | undefined;
  tx: { nonce: number; kind: string; versions: { hash: string; kind: string }[]; hash: string; maxFeePerGas: string; maxPriorityFeePerGas: string; to: string; data: string; gas: string; minedHash: string | null }[];
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
const nonces = async (stub: Stub): Promise<number[]> => (await stored(stub)).tx.map((t) => t.nonce);

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

describe('EvmRelayer: the Execute is checked and built inside the object (M3)', () => {
  it('computes the digest, builds execute(...) to the account with value 0, signs a type-2 transaction at the chain’s nonce, persisted before the broadcast', async () => {
    chain.setMined(RELAYER, 7);
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    expect(sent).toMatchObject({ digest: digestOf(req), relayerNonce: 7, replay: false });
    const tx = chain.pooled(RELAYER, 7)!;
    expect(tx).toMatchObject({ type: 2, from: RELAYER.toLowerCase(), to: USER.toLowerCase(), nonce: 7, value: 0n, gas: req.gas, maxFeePerGas: req.maxFeePerGas, chainId: BigInt(CHAIN) });
    expect(tx.data).toBe(encodeExecuteCalldata(req.execute, req.signature).toLowerCase());
    expect(sent.transactionHash).toBe(tx.hash);
    expect(sent.raw).toBe(tx.raw);
    const s = await stored(stub);
    expect(s.meta).toMatchObject({ nextNonce: 8, remembered: 1, chainId: CHAIN, address: RELAYER });
    expect(s.alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
    // The digest is the Execute's: the same Execute (from a real signer) gives the same digest.
    const signed = signExecute(USER_KEY, req.execute, { enabledChains: [CHAIN] });
    expect(await stub.send({ ...req, signature: signed })).toMatchObject({ digest: sent.digest, transactionHash: sent.transactionHash, replay: true });
  });

  it('type 4 with the user’s authorization; an authorization for another delegate, chain or account, or malformed, is refused', async () => {
    const stub = await fresh();
    const sent = await stub.send(request({ authorization: authorization() }));
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ type: 4, authorizations: 1, to: USER.toLowerCase() });
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), chainId: 84532 } })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: authorization({}, testKey('someone else')) })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), address: USER } })))).toBe('invalid_request');
    expect(await codeOf(stub.send(request({ authorization: { ...authorization(), s: `0x${'f'.repeat(64)}` as Hex } })))).toBe('invalid_request');
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('refuses an Execute not signed by its account, for another relayer, implementation or chain, with value, forbidden targets, bad minGas; and over the caps', async () => {
    const stub = await fresh();
    const other = testKey('someone else');
    const cases: [ReturnType<typeof request>, string][] = [
      [request({}, other), 'invalid_request'],
      [request({ execute: { relayer: addressFor(other) } }), 'invalid_request'],
      [request({ execute: { implementation: CHECK_IN } }), 'invalid_request'],
      [request({ execute: { chainId: 84532 } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: CHECK_IN, value: 1n, data: '0x183ff085' }] } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: USER, value: 0n, data: '0x' }] } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: DELEGATE as Hex, value: 0n, data: '0x' }] } }), 'invalid_request'],
      [request({ execute: { calls: Array.from({ length: 5 }, () => ({ to: CHECK_IN, value: 0n, data: '0x183ff085' as Hex })) } }), 'invalid_request'],
      [request({ execute: { minGas: 99_999n } }), 'invalid_request'],
      [request({ execute: { minGas: 200_001n } }), 'invalid_request'],
      [request({ execute: { account: RELAYER } }, RELAYER_KEY), 'invalid_request'],
      [request({ gas: 300_001n }), 'invalid_request'],
      [request({ maxFeePerGas: GWEI + 1n }), 'invalid_request'],
      [request({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 1001n, reservedWei: ETH }), 'invalid_request'],
      [request({ reservedWei: 200_000n * (GWEI / 10n) - 1n }), 'invalid_request'],
      [request({ execute: { deadline: nowS() + 5n } }), 'deadline_passed'],
      [request({ execute: { deadline: nowS() + 661n } }), 'invalid_request'],
      [{ ...request(), signature: '0x1234' as Hex }, 'invalid_request'],
      [{ ...request(), chainId: 0 }, 'invalid_request'],
    ];
    for (const [req, code] of cases) expect([req.execute, await codeOf(stub.send(req))]).toEqual([req.execute, code]);
    expect(chain.broadcasts).toHaveLength(0);
    expect((await stored(stub)).tx).toEqual([]);
  });

  it('serves one chain for its life: another chain is wrong_chain, an unconfigured chain is relayer_unconfigured', async () => {
    const stub = await fresh();
    expect(await codeOf(stub.send({ ...request(), chainId: 84532 }))).toBe('relayer_unconfigured');
    await stub.send(request());
    expect(await codeOf(stub.send({ ...request(), chainId: 84532 }))).toBe('wrong_chain');
  });

  it('a daily backstop: reservations past 2 × dailyBudgetEth in a UTC day are refused (daily_cap); a freed nonce gives its share back', async () => {
    const stub = await fresh();
    const big = (): EvmRelayerSendRequest => request({ reservedWei: (15n * ETH) / 1000n });
    await stub.send(big());
    await stub.send(big());
    expect(await codeOf(stub.send(big()))).toBe('daily_cap');
    expect(chain.broadcasts).toHaveLength(2);
    expect((await stored(stub)).meta?.dayReservedWei).toBe(((30n * ETH) / 1000n).toString());
    // A rejected (freed) send doesn't count.
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    expect(await codeOf(stub.send(request({ reservedWei: (9n * ETH) / 1000n })))).toBe('rejected:insufficient_funds');
    expect((await stored(stub)).meta?.dayReservedWei).toBe(((30n * ETH) / 1000n).toString());
    chain.onSend = undefined;
    // The next UTC day starts at 0.
    clock.advance(24 * 60 * 60_000);
    expect(await codeOf(stub.send(request({ execute: { deadline: nowS() + 300n } })))).toBe('no error');
  });
});

describe('EvmRelayer: fee headroom (L3)', () => {
  const caps = { maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n };
  it('P3: a send whose fees leave no room for two bumps is refused (fees_too_high); maxStartingFees is the edge', async () => {
    const stub = await fresh();
    const edge = maxStartingFees(caps);
    expect(hasFeeHeadroom(edge, caps)).toBe(true);
    expect(hasFeeHeadroom({ maxFeePerGas: edge.maxFeePerGas + 1n, maxPriorityFeePerGas: edge.maxPriorityFeePerGas }, caps)).toBe(false);
    expect(hasFeeHeadroom({ maxFeePerGas: edge.maxFeePerGas, maxPriorityFeePerGas: edge.maxPriorityFeePerGas + 1n }, caps)).toBe(false);
    expect(await codeOf(stub.send(request({ maxPriorityFeePerGas: GWEI / 100n })))).toBe('fees_too_high');
    expect(await codeOf(stub.send(request({ maxFeePerGas: edge.maxFeePerGas + 1n, reservedWei: ETH / 100n })))).toBe('fees_too_high');
    // At the edge: a replacement and the deadline's self-transfer both happen.
    const req = request({ ...edge, reservedWei: ETH / 100n, execute: { deadline: nowS() + 90n } });
    await stub.send(req);
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    clock.advance(31_000);
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).tx[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'execute', 'cancel']);
    expect(BigInt(rec.maxFeePerGas)).toBeLessThanOrEqual(GWEI);
  });
});

describe('EvmRelayer: idempotency and the queue', () => {
  it('N concurrent sends get N consecutive nonces, each broadcast once, in nonce order', async () => {
    chain.setMined(RELAYER, 40);
    chain.onSend = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 20));
    const stub = await fresh();
    const N = 12;
    const results = await Promise.all(Array.from({ length: N }, () => stub.send(request())));
    expect(results.map((r) => r.relayerNonce).sort((a, b) => a - b)).toEqual(Array.from({ length: N }, (_, i) => 40 + i));
    expect(chain.broadcasts.map((b) => b.tx.nonce)).toEqual(Array.from({ length: N }, (_, i) => 40 + i));
    expect(new Set(results.map((r) => r.transactionHash)).size).toBe(N);
  });

  it('concurrent identical requests make one transaction: one answer replay false, the rest replay true', async () => {
    const stub = await fresh();
    const req = request();
    const results = await Promise.all(Array.from({ length: 10 }, () => stub.send(req)));
    expect(new Set(results.map((r) => r.transactionHash)).size).toBe(1);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.send({ ...req, gas: 250_000n })).toMatchObject({ transactionHash: results[0]!.transactionHash, raw: results[0]!.raw, replay: true });
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', minedHash: results[0]!.transactionHash, outcome: 'execute' });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('P1: the alarm waits for a send in flight (no interleave across its RPC awaits)', async () => {
    const stub = await fresh();
    await stub.send(request());
    let gate = true;
    let entered = false;
    chain.onSend = async () => {
      entered = true;
      while (gate) await new Promise((r) => setTimeout(r, 5));
      return undefined;
    };
    const p = stub.send(request());
    await until(() => entered);
    const before = chain.calls.length;
    const alarm = runDurableObjectAlarm(stub);
    await new Promise((r) => setTimeout(r, 100));
    expect(chain.calls.length - before).toBe(0);
    gate = false;
    await p;
    await alarm;
  });

  it(`P6: beyond ${EVM_RELAYER_MAX_QUEUE} sends waiting, relayer_busy at once; the deadline is re-checked when a queued send runs`, async () => {
    const stub = await fresh();
    await stub.send(request());
    let gate = true;
    let entered = false;
    chain.onSend = async (tx) => {
      if (tx.nonce !== 1) return undefined;
      entered = true;
      while (gate) await new Promise((r) => setTimeout(r, 5));
      return undefined;
    };
    const slow = stub.send(request());
    await until(() => entered);
    const queued = Array.from({ length: 20 }, () => stub.send(request({ execute: { deadline: nowS() + 20n } })).then(() => 'sent', (e: unknown) => evmRelayerError(e)?.code ?? 'uncoded'));
    // Let every queued call reach the object before the slow one finishes.
    await new Promise((r) => setTimeout(r, 200));
    clock.advance(20_000);
    gate = false;
    await slow;
    const out = await Promise.all(queued);
    expect(out.filter((x) => x === 'relayer_busy')).toHaveLength(20 - EVM_RELAYER_MAX_QUEUE);
    expect(out.filter((x) => x === 'deadline_passed')).toHaveLength(EVM_RELAYER_MAX_QUEUE);
  });
});

describe('EvmRelayer: crashes at every step never reuse a nonce, leave a gap or lose a transaction', () => {
  it('a failed write before persisting (after the nonce was chosen) sends nothing; the nonce is used by the next send', async () => {
    chain.setMined(RELAYER, 3);
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
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 4, replay: false });
  });

  it('a crash while reading the chain (before any nonce) leaves nothing stored', async () => {
    let stub = await fresh();
    let release: (() => void) | undefined;
    chain.onRead = (method) => (method === 'eth_getTransactionCount' && !release ? new Promise<void>((r) => (release = r)) : undefined);
    const req = request();
    const pending = stub.send(req).then(
      () => 'sent',
      () => 'failed',
    );
    await until(() => release !== undefined);
    // The held read never answers (its object is gone).
    stub = await crash(stub);
    expect(await pending).toBe('failed');
    chain.onRead = undefined;
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 0, replay: false });
  });

  it('a crash after persisting, before the broadcast reached any node: the next instance broadcasts the same raw first', async () => {
    chain.setMined(RELAYER, 10);
    let stub = await fresh();
    chain.onSend = () => 'hang';
    const req = request();
    const first = stub.send(req).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 1);
    stub = await crash(stub);
    expect(await first).toBe('failed');
    const s = await stored(stub);
    expect(s.tx.map((t) => t.nonce)).toEqual([10]);
    chain.onSend = undefined;
    expect((await stub.send(request())).relayerNonce).toBe(11);
    expect(chain.pooled(RELAYER, 10)?.hash).toBe(s.tx[0]!.hash);
    expect(await stub.send(req)).toMatchObject({ transactionHash: s.tx[0]!.hash, relayerNonce: 10, replay: true });
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
    expect(chain.broadcasts.filter((b) => b.tx.nonce === 0)).toHaveLength(1);
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
  });
});

describe('EvmRelayer: RPC failures (and L1, L4)', () => {
  it('reads and sends fail over to the fallback; a primary that flaps keeps nonces consecutive and every raw single', async () => {
    const stub = await fresh();
    chain.modes[0] = 'down';
    expect((await stub.send(request())).relayerNonce).toBe(0);
    expect(chain.broadcasts.map((b) => b.endpoint)).toEqual([1]);
    let flip = 0;
    chain.onSend = (_tx, endpoint) => (endpoint === 0 && flip++ % 2 === 0 ? 'network' : undefined);
    const modes = ['up', 'down', 'http503', 'rate_limited'] as const;
    for (let i = 1; i <= 8; i++) {
      chain.modes[0] = modes[i % modes.length]!;
      clock.advance(31_000);
      expect((await stub.send(request())).relayerNonce).toBe(i);
    }
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const n of new Set(chain.broadcasts.map((b) => b.tx.nonce))) expect(new Set(chain.broadcasts.filter((b) => b.tx.nonce === n).map((b) => b.tx.hash)).size).toBe(1);
  });

  it('an endpoint on another chain is never read from or sent to', async () => {
    chain.modes[1] = 'wrong_chain';
    chain.modes[0] = 'down';
    const stub = await fresh();
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect(chain.calls.filter((c) => c.endpoint === 1).every((c) => c.method === 'eth_chainId')).toBe(true);
    expect(chain.broadcasts).toHaveLength(0);
    expect(await stub.status()).toMatchObject({ blockedReason: 'rpc_unavailable' });
  });

  it('cold with both endpoints down: rpc_unavailable, nothing stored; warm with the broadcast failing everywhere: stored, answered, broadcast by the alarm', async () => {
    const stub = await fresh();
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect((await stored(stub)).tx).toEqual([]);
    chain.modes[0] = 'up';
    chain.modes[1] = 'up';
    clock.advance(31_000);
    await stub.send(request());
    chain.onSend = () => 'network';
    const sent = await stub.send(request());
    expect(chain.pooled(RELAYER, 1)).toBeUndefined();
    chain.onSend = undefined;
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 1)?.hash).toBe(sent.transactionHash);
  });

  it('a body past the size limit is abandoned (read as a stream) and the fallback answers', async () => {
    const stub = await fresh();
    chain.hugeResponse = 2 * 1024 * 1024 + 10;
    expect((await stub.send(request())).relayerNonce).toBe(0);
    expect(chain.calls.some((c) => c.endpoint === 1 && c.method === 'eth_getTransactionCount')).toBe(true);
  });

  it(`rebroadcasts at most ${EVM_RELAYER_RUN_LIMITS.rebroadcasts} per run, the rest the next run`, async () => {
    const stub = await fresh();
    for (let i = 0; i < 6; i++) await stub.send(request());
    for (let n = 0; n < 6; n++) chain.drop(RELAYER, n);
    const before = chain.broadcasts.length;
    await runDurableObjectAlarm(stub);
    expect(chain.broadcasts.length - before).toBe(EVM_RELAYER_RUN_LIMITS.rebroadcasts);
    await runDurableObjectAlarm(stub);
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2, 3, 4, 5]);
  });
});

describe('EvmRelayer: counts are cross-checked and confirmed (M1)', () => {
  it('P2: one endpoint over-reporting while the other answers truly: counts disagree, nothing deleted or adopted', async () => {
    const stub = await fresh();
    const a = await stub.send(request());
    chain.staleCounts.set(0, { latest: 3, pending: 3, confirmed: 3 });
    await runDurableObjectAlarm(stub);
    expect(await nonces(stub)).toEqual([0]);
    expect((await stored(stub)).meta?.nextNonce).toBe(1);
    expect(await stub.status()).toMatchObject({ blockedReason: 'counts_disagree' });
    chain.staleCounts.delete(0);
    expect((await stub.send(request())).relayerNonce).toBe(1);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'mined', minedHash: a.transactionHash });
    expect(await stub.status()).toMatchObject({ blockedReason: null, pending: 0 });
  });

  it('P2 (alone): the only endpoint answering over-reports: the live record stays, the skipped nonces are filled after 5 minutes, all mine', async () => {
    let stub = await fresh();
    await stub.send(request());
    chain.modes[1] = 'down';
    chain.staleCounts.set(0, { latest: 3, pending: 3, confirmed: 3 });
    stub = await crash(stub);
    const b = await stub.send(request());
    expect(b.relayerNonce).toBe(3);
    expect(await nonces(stub)).toEqual([0, 3]);
    chain.staleCounts.delete(0);
    chain.modes[1] = 'up';
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ blockedReason: 'nonce_gap' });
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 3]);
    clock.advance(EVM_RELAYER_GAP_HEAL_MS);
    await runDurableObjectAlarm(stub);
    expect(chain.pooledAll(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2, 3]);
    expect(chain.pooled(RELAYER, 1)).toMatchObject({ to: RELAYER.toLowerCase(), value: 0n, data: '0x', gas: CANCEL_GAS });
    expect(chain.mine(RELAYER).map((t) => t.nonce)).toEqual([0, 1, 2, 3]);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ pending: 0, blockedReason: null });
  });

  it('a reorg: mined but not confirmed keeps the record (its mined hash noted); un-mined, the same raw goes out again; confirmed, it goes', async () => {
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    chain.mine(RELAYER, 1, { confirmations: 0 });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]).toMatchObject({ nonce: 0, minedHash: sent.transactionHash });
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'pending', minedHash: sent.transactionHash, outcome: 'execute' });
    chain.unmine(RELAYER, 1, { drop: true });
    expect(chain.pooledAll(RELAYER)).toEqual([]);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]).toMatchObject({ nonce: 0, minedHash: null });
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(sent.transactionHash);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx).toEqual([]);
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'mined', minedHash: sent.transactionHash });
  });

  it('P5: another sender’s pending transaction, later dropped, leaves a gap that heals itself (or at once through reconcile)', async () => {
    let stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    chain.admit({ ...chain.minedTxs[0]!, hash: `0x${'ab'.repeat(32)}` as Hex, nonce: 1 });
    stub = await crash(stub);
    const b = await stub.send(request());
    expect(b.relayerNonce).toBe(2);
    chain.drop(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ blockedReason: 'nonce_gap' });
    const report = await stub.reconcile({ fillGapsNow: true });
    expect(report).toMatchObject({ agreed: true, gapsFilled: [1], gaps: [] });
    expect(chain.mine(RELAYER).map((t) => t.nonce)).toEqual([1, 2]);
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ pending: 0, blockedReason: null });
  });

  it('a confirmed nonce none of whose hashes mined (another sender’s) is taken only after 2 minutes; the batch did not run', async () => {
    const stub = await fresh();
    const sent = await stub.send(request());
    chain.foreignMine(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect(await nonces(stub)).toEqual([0]);
    clock.advance(EVM_RELAYER_TAKEN_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect(await nonces(stub)).toEqual([]);
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'taken', minedHash: null, outcome: null });
    expect(await stub.send(request())).toMatchObject({ relayerNonce: 1 });
  });

  it('cold start: the chain’s confirmed and pending counts are adopted when ahead (another sender’s), never below what was stored', async () => {
    let stub = await fresh();
    await stub.send(request());
    await stub.send(request());
    chain.mine(RELAYER);
    chain.admit({ ...chain.minedTxs[0]!, nonce: 2, hash: `0x${'ab'.repeat(32)}` as Hex });
    chain.admit({ ...chain.minedTxs[0]!, nonce: 3, hash: `0x${'cd'.repeat(32)}` as Hex });
    stub = await crash(stub);
    expect((await stub.send(request())).relayerNonce).toBe(4);
    expect(await nonces(stub)).toEqual([4]);
    // A lagging node alone after a restart: the stored next nonce stands, nothing deleted.
    stub = await crash(stub);
    chain.modes[0] = 'down';
    chain.staleCounts.set(1, { latest: 0, pending: 0, confirmed: 0 });
    expect((await stub.send(request())).relayerNonce).toBe(5);
    expect(await nonces(stub)).toEqual([4, 5]);
  });

  it('reconcile (staff): reports each endpoint’s counts, agreement, pending records and gaps', async () => {
    const stub = await fresh();
    await stub.send(request());
    const report = await stub.reconcile();
    expect(report).toMatchObject({ chainId: CHAIN, address: RELAYER, agreed: true, nextNonce: 1, finalized: 0, gapsFilled: [], gaps: [], pending: [{ nonce: 0, kind: 'execute', included: false, minedHash: null }], blockedReason: null });
    expect(report.counts.map((c) => c.endpoint)).toEqual([0, 1]);
  });
});

describe('EvmRelayer: which hash mined (M2)', () => {
  it('P4: after a replacement the ORIGINAL mines: lookup and replay name the original, outcome execute', async () => {
    const stub = await fresh();
    const req = request();
    const first = await stub.send(req);
    const original = chain.pooled(RELAYER, 0)!;
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 0)!.hash).not.toBe(first.transactionHash);
    chain.admit(original);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    const l = await stub.lookup(first.digest);
    expect(l).toMatchObject({ state: 'mined', transactionHash: first.transactionHash, minedHash: first.transactionHash, outcome: 'execute' });
    expect(l!.hashes).toHaveLength(2);
    expect(await stub.send(req)).toMatchObject({ transactionHash: first.transactionHash, raw: first.raw, replay: true });
  });

  it('past the deadline the self-transfer mines: outcome cancel (the batch did not run)', async () => {
    const stub = await fresh();
    const req = request({ authorization: authorization(), execute: { deadline: nowS() + 30n } });
    const sent = await stub.send(req);
    clock.advance(31_000);
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).tx[0]!;
    expect(rec.kind).toBe('cancel');
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ type: 2, to: RELAYER.toLowerCase(), value: 0n, data: '0x', gas: CANCEL_GAS, authorizations: 0 });
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'cancelling', hashes: [sent.transactionHash, rec.hash] });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'mined', minedHash: rec.hash, outcome: 'cancel', transactionHash: rec.hash });
  });
});

describe('EvmRelayer: stuck transactions', () => {
  it('after 60 s pending, the same nonce with both fees × 1.125 (capped); no replacement past the caps', async () => {
    const stub = await fresh();
    const req = request({ maxFeePerGas: (GWEI * 7n) / 10n, maxPriorityFeePerGas: GWEI / 200n, reservedWei: ETH / 100n });
    const sent = await stub.send(req);
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS - 1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]!.versions).toHaveLength(1);
    clock.advance(2);
    await runDurableObjectAlarm(stub);
    const one = (await stored(stub)).tx[0]!;
    expect(one.versions.map((v) => v.hash)).toEqual([sent.transactionHash, one.hash]);
    expect(BigInt(one.maxFeePerGas)).toBe(787_500_000n);
    expect(BigInt(one.maxPriorityFeePerGas)).toBe(5_625_000n);
    for (let i = 0; i < 4; i++) {
      clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
      await runDurableObjectAlarm(stub);
    }
    // 0.7 → 0.7875 → 0.8859… → 0.9967 gwei; the next (1.121, capped at 1) is under +10%: no replacement from there.
    const last = (await stored(stub)).tx[0]!;
    expect(BigInt(last.maxFeePerGas)).toBe(996_679_688n);
    expect(last.versions).toHaveLength(4);
    const count = last.versions.length;
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx[0]!.versions).toHaveLength(count);
  });

  it(`replacements stop at ${EVM_RELAYER_MAX_HASHES} versions per nonce; the last stays in the pool`, async () => {
    const stub = await fresh(overlay({ EVM_SPONSOR: sponsorVar({ maxFeePerGasGwei: 100, maxPriorityFeePerGasGwei: 100, maxGasPerTx: 50_000, minGas: 10_000, deadlineMaxS: 3600 }) }));
    await stub.send(request({ gas: 50_000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 1n, reservedWei: 10n ** 15n, execute: { deadline: nowS() + 3600n, minGas: 10_000n } }));
    for (let i = 0; i < EVM_RELAYER_MAX_HASHES + 4; i++) {
      clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
      await runDurableObjectAlarm(stub);
    }
    const rec = (await stored(stub)).tx[0]!;
    expect(rec.versions).toHaveLength(EVM_RELAYER_MAX_HASHES);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.hash);
  });

  it(`advances at most ${EVM_RELAYER_RUN_LIMITS.records} records per run (free-plan subrequests), the rest the next run`, async () => {
    const stub = await fresh();
    for (let i = 0; i < 8; i++) await stub.send(request());
    clock.advance(EVM_RELAYER_REPLACE_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx.filter((t) => t.versions.length === 2)).toHaveLength(EVM_RELAYER_RUN_LIMITS.records);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).tx.filter((t) => t.versions.length === 2)).toHaveLength(8);
  });
});

describe('EvmRelayer: definite rejections', () => {
  it('every endpoint refuses and no pending count holds it: the nonce, record and memory go back (rejected); the Execute may be sent again', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    const req = request();
    expect(await codeOf(stub.send(req))).toBe('rejected:insufficient_funds');
    expect(chain.broadcasts.slice(1).map((b) => b.endpoint)).toEqual([0, 1]);
    expect((await stored(stub)).meta).toMatchObject({ nextNonce: 1, remembered: 1 });
    chain.onSend = undefined;
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 1, replay: false });
  });

  it('a node that refuses but holds it anyway (its pending count past the nonce): the record stays, the hash is answered', async () => {
    const stub = await fresh();
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? { error: 'insufficient funds for gas * price + value', keep: true } : { error: 'insufficient funds for gas * price + value' });
    expect(await stub.send(request())).toMatchObject({ relayerNonce: 0, replay: false });
    expect(await nonces(stub)).toEqual([0]);
  });

  it('one endpoint gave no answer: unknown, kept', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? { error: 'transaction underpriced' } : 'network');
    expect((await stub.send(request())).relayerNonce).toBe(1);
    expect(await nonces(stub)).toEqual([0, 1]);
  });

  it('nonce too low (the key was used elsewhere): dropped once the confirmed count is past it, then sent at the chain’s next nonce', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    chain.foreignMine(RELAYER, 3);
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ relayerNonce: 3, replay: false });
    expect(chain.broadcasts.filter((b) => b.outcome === 'nonce_too_low').map((b) => b.tx.nonce)).toEqual([1, 1]);
    // Nonce 0 was mined and confirmed: the repair after the refusal finalized it.
    expect(await nonces(stub)).toEqual([3]);
  });
});

describe('EvmRelayer: the alarm and bounded storage (L2)', () => {
  it('backs off while nothing changes (15 s doubling to 5 minutes), back to 15 s after a change; once at the forget time when idle', async () => {
    const stub = await fresh();
    const req = request({ execute: { deadline: nowS() + 120n } });
    await stub.send(req);
    expect((await stored(stub)).alarm).toBe(clock.now + EVM_RELAYER_ALARM_MS);
    const intervals: number[] = [];
    for (let i = 0; i < 6; i++) {
      clock.advance(1_000);
      await runDurableObjectAlarm(stub);
      intervals.push((await stored(stub)).alarm! - clock.now);
    }
    // The replacement (60 s) counts as a change: the first runs here come within a few seconds, so none happens yet.
    expect(intervals).toEqual([30_000, 60_000, 120_000, 240_000, EVM_RELAYER_ALARM_MAX_MS, EVM_RELAYER_ALARM_MAX_MS]);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    const forgetAt = Number(req.execute.deadline) * 1000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS;
    expect((await stored(stub)).alarm).toBe(forgetAt + 1);
    clock.now = forgetAt + 1;
    await runDurableObjectAlarm(stub);
    expect(await stored(stub)).toMatchObject({ tx: [], digests: [], forget: [], alarm: null });
    expect(await stub.lookup(digestOf(req))).toBeNull();
  });

  it('a pending batch is never forgotten at its forget time', async () => {
    const stub = await fresh();
    chain.onSend = () => ({ error: 'transaction underpriced', keep: true });
    const req = request({ execute: { deadline: nowS() + 60n } });
    await stub.send(req);
    chain.onSend = () => ({ error: 'max fee per gas less than block base fee' });
    clock.advance(60_000 + EVM_RELAYER_REMEMBER_AFTER_DEADLINE_MS + 1);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'cancelling' });
    expect((await stored(stub)).digests).toHaveLength(1);
  });

  it(`refuses a send past ${EVM_RELAYER_MAX_PENDING} pending; the cold repair runs before that check (L4)`, async () => {
    let stub = await fresh();
    for (let i = 0; i < EVM_RELAYER_MAX_PENDING; i++) await stub.send(request());
    expect(await codeOf(stub.send(request()))).toBe('relayer_busy');
    chain.mine(RELAYER);
    stub = await crash(stub);
    // No alarm ran: the cold repair confirms them, then the busy check passes.
    expect((await stub.send(request())).relayerNonce).toBe(EVM_RELAYER_MAX_PENDING);
  });

  it('status: address, pending, the oldest one’s age, the next nonce, blockedReason; from storage, no RPC', async () => {
    const stub = await fresh();
    expect(await stub.status()).toEqual({ address: RELAYER, pending: 0, oldestPendingMs: null, nextNonce: null, blockedReason: null });
    await stub.send(request());
    clock.advance(5_000);
    await stub.send(request());
    clock.advance(1_000);
    const calls = chain.calls.length;
    expect(await stub.status()).toEqual({ address: RELAYER, pending: 2, oldestPendingMs: 6_000, nextNonce: 2, blockedReason: null });
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
    await configure(stub, overlay());
    expect(await stub.status()).toMatchObject({ pending: 1 });
  });

  it('a new key while the old one’s transactions are pending blocks (status says so); once they are confirmed it starts a new nonce life', async () => {
    const otherAddress = evmRelayKeyAddress(JSON.stringify([OTHER_KEY_HEX]))!;
    const stub = await fresh();
    await stub.send(request());
    const newKey = overlay({ EVM_RELAY_KEYS: JSON.stringify([OTHER_KEY_HEX]), EVM_SPONSOR: sponsorVar({}, otherAddress) });
    await configure(stub, newKey);
    expect(await codeOf(stub.send(request({ execute: { relayer: otherAddress } })))).toBe('relayer_misconfigured');
    expect(await stub.status()).toMatchObject({ address: otherAddress, pending: 1, blockedReason: 'key_changed_with_pending' });
    await configure(stub, overlay());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    await configure(stub, newKey);
    chain.setMined(otherAddress, 9);
    expect(await stub.send(request({ execute: { relayer: otherAddress } }))).toMatchObject({ relayerNonce: 9 });
    expect(chain.pooled(otherAddress, 9)?.from).toBe(otherAddress.toLowerCase());
  });

  it('never logs the key, a raw transaction, calldata, a signature or an RPC URL', async () => {
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
    await stub.reconcile({ fillGapsNow: true }).catch(() => undefined);
    await configure(stub, overlay({ EVM_RELAY_KEYS: JSON.stringify([OTHER_KEY_HEX]) }));
    await stub.send(request()).catch(() => undefined);
    const all = lines.join('\n').toLowerCase();
    expect(lines.length).toBeGreaterThan(3);
    for (const secret of [RELAYER_KEY_HEX.slice(2), OTHER_KEY_HEX.slice(2), sent.raw.slice(2, 120), req.signature.slice(2), encodeExecuteCalldata(req.execute, req.signature).slice(10), 'evm-primary', 'evm-fallback', keyHex(USER_KEY).slice(2)]) {
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
    expect(evmRelayerError(new Error('evm_relayer:fees_too_high'))).toEqual({ code: 'fees_too_high', reason: null });
    expect(evmRelayerError(new Error('evm_relayer:daily_cap'))).toEqual({ code: 'daily_cap', reason: null });
    expect(evmRelayerError(new Error('evm_relayer:made_up'))).toBeNull();
    expect(evmRelayerError(new Error('Durable Object reset'))).toBeNull();
    expect(evmRelayerError(null)).toBeNull();
  });
});
