// The simplified, fail-stop EVM relayer (evm-relayer.ts, D851) against a fake chain (test/evm-mock.ts) in the Workers
// test pool. One test per rule of the header: every record transition, every halt reason (reaching it, staying safe
// while halted, the staff tool that resolves it, staffResume), every staff tool's refusals, the in-object check, crashes
// at each step, concurrency, the caps, the daily backstop, RPC failures on the read endpoint and on the fallback, and
// no key, raw transaction or URL in a log or an error. Each object gets its own config (EVM_SPONSOR for the local chain
// 31337 in a `local*` env, a test relayer key) by replacing its instance's env, as test/near-relay.test.ts does; after
// a crash the new instance gets it again. The test clock starts in 2027, so no alarm fires on its own: tests run them.
import { type ExecuteInput, SPONSOR_DELEGATES, type SignedAuthorization, encodeExecuteCalldata, executeDigest, signAuthorization, signExecute, signSponsorTx } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { sha256 } from '@noble/hashes/sha256';
import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/env.ts';
import {
  EVM_RELAYER_ALARM_MAX_MS,
  EVM_RELAYER_ALARM_MS,
  EVM_RELAYER_BASE_FEE_TTL_MS,
  EVM_RELAYER_BUMP_AFTER_MS,
  EVM_RELAYER_IDLE_CHECK_MS,
  EVM_RELAYER_STAFF_GUARD,
  EVM_RELAYER_MAX_QUEUE,
  EVM_RELAYER_MAX_RECORDS,
  EVM_RELAYER_MAX_UNMINED,
  EVM_RELAYER_MAX_VERSIONS,
  EVM_RELAYER_REMEMBER_MS,
  EVM_RELAYER_STUCK_AFTER_DEADLINE_MS,
  type EvmRelayer,
  type EvmRelayerSendRequest,
  bumpedFees,
  cancelFees,
  evmRelayKeyAddress,
  evmRelayerError,
  evmRelayerName,
  hasFeeHeadroom,
  maxStartingFees,
  REJECTION_CAUSE,
  verifySend,
} from '../src/evm-relayer.ts';
import { evmRelayerStaffAdoptNonce, evmRelayerStaffCancel, evmRelayerStaffClose, evmRelayerStaffFill, evmRelayerStaffResume, evmRelayerStaffStatus } from '../src/evm-relayer-staff.ts';
import { EVM_REJECTIONS, classifyRejection, forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { checksumEvmAddress, evmSponsorVar, parseEvmSponsorConfig, sponsorChain } from '../src/evm/sponsor-config.ts';
import { uid } from './helpers.ts';
import { EvmMock, FALLBACK_RPC, type Hex, PRIMARY_RPC, addressOf, decodeRawTx } from './evm-mock.ts';

const CHAIN = 31337;
const DELEGATE = SPONSOR_DELEGATES[CHAIN]!.address as Hex;
const CHECK_IN = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e' as Hex;
const GWEI = 10n ** 9n;
const ETH = 10n ** 18n;
const KEYED_RPC = 'https://evm-keyed.test.invalid/v2/SECRET-PROVIDER-KEY';

/** Test-only keys, derived at run time (never literals). */
const testKey = (label: string): Uint8Array => sha256(new TextEncoder().encode(`hana-id evm-relayer test key: ${label}`));
const keyHex = (d: Uint8Array): string => `0x${Array.from(d, (b) => b.toString(16).padStart(2, '0')).join('')}`;
const addressFor = (d: Uint8Array): Hex => checksumEvmAddress(addressOf(secp256k1.getPublicKey(d, false))) as Hex;
const toHex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
const RELAYER_KEY = testKey('relayer');
const RELAYER = addressFor(RELAYER_KEY);
const OTHER_KEY = testKey('another relayer');
const OTHER = addressFor(OTHER_KEY);
const USER_KEY = testKey('user');
const USER = addressFor(USER_KEY);

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
const sponsorVar = (over: Record<string, unknown> = {}, relayerAddress: string = RELAYER): string => evmSponsorVar({ relayerAddress, chains: { [CHAIN]: chainSettings(over) as never }, apps: {} });
const overlay = (over: Partial<Record<string, string | undefined>> = {}): Partial<Env> => ({ ENV_NAME: 'local-evm-test', NETWORK: 'testnet', EVM_SPONSOR: sponsorVar(), EVM_RELAY_KEYS: JSON.stringify([keyHex(RELAYER_KEY)]), ...over });

type Stub = DurableObjectStub<EvmRelayer>;
async function configure(stub: Stub, over: Partial<Env> = overlay()): Promise<void> {
  await runInDurableObject(stub, (instance: EvmRelayer) => {
    const self = instance as unknown as { env: Env };
    self.env = { ...self.env, ...over } as Env;
  });
}
async function fresh(over: Partial<Env> = overlay()): Promise<Stub> {
  const ns = env.EVM_RELAYER!;
  const stub = ns.get(ns.idFromName(`${evmRelayerName(CHAIN)}-test-${uid()}`));
  await configure(stub, over);
  return stub;
}
/** Crashes the object (memory lost, storage kept) and returns a stub to the next instance, configured. */
async function crash(stub: Stub, over: Partial<Env> = overlay()): Promise<Stub> {
  await runInDurableObject(stub, (_i, state) => state.abort('test crash')).catch(() => undefined);
  const next = env.EVM_RELAYER!.get(stub.id);
  await configure(next, over);
  return next;
}

let now = 0;
const nowS = (): bigint => BigInt(Math.floor(now / 1000));
const advance = (ms: number): void => void (now += ms);
let executeNonce = 0n;

/** An Execute signature by `key` with no signer-side checks (so the object's own checks are what refuses). */
function signRaw(e: ExecuteInput, key: Uint8Array): Hex {
  let digest: Uint8Array;
  try {
    digest = executeDigest(e);
  } catch {
    return `0x${'11'.repeat(64)}1b`;
  }
  const sig = secp256k1.sign(digest, key);
  return `0x${sig.r.toString(16).padStart(64, '0')}${sig.s.toString(16).padStart(64, '0')}${(27 + sig.recovery).toString(16)}` as Hex;
}
let userSeq = 0;
/**
 * A request signed by `key` for its own account; without a key, by a fresh test user's (one unmined batch per account,
 * D851), or by USER_KEY when the test names the account itself.
 */
function request(over: Partial<Omit<EvmRelayerSendRequest, 'execute'>> & { execute?: Partial<ExecuteInput> } = {}, given?: Uint8Array): EvmRelayerSendRequest {
  const key = given ?? (over.execute?.account ? USER_KEY : testKey(`user ${userSeq++}`));
  const gas = over.gas ?? 200_000n;
  const maxFeePerGas = over.maxFeePerGas ?? GWEI / 10n;
  const execute: ExecuteInput = { chainId: CHAIN, account: addressFor(key), implementation: DELEGATE, calls: [{ to: CHECK_IN, value: 0n, data: '0x183ff085' }], nonce: executeNonce++, deadline: nowS() + 300n, relayer: RELAYER, minGas: 100_000n, ...over.execute };
  const { execute: _e, ...rest } = over;
  return { chainId: CHAIN, execute, signature: signRaw(execute, key), gas, maxFeePerGas, maxPriorityFeePerGas: GWEI / 1000n, reservedWei: gas * maxFeePerGas + 10n ** 12n, ...rest };
}
const digestOf = (req: EvmRelayerSendRequest): Hex => toHex(executeDigest(req.execute));
const authorization = (over: { nonce?: bigint } = {}, key = USER_KEY): SignedAuthorization => signAuthorization(key, { chainId: CHAIN, address: DELEGATE, nonce: over.nonce ?? 0n }, { enabledChains: [CHAIN] });
/** A transaction from the relayer's own key that this object did not send (the key used elsewhere). */
function foreign(nonce: number, maxFeePerGas = GWEI): ReturnType<typeof decodeRawTx> {
  return decodeRawTx(signSponsorTx(RELAYER_KEY, { type: 'eip1559', chainId: BigInt(CHAIN), nonce: BigInt(nonce), maxFeePerGas, maxPriorityFeePerGas: GWEI / 100n, gas: 21_000n, to: new Uint8Array(20).fill(0xee), value: 0n, data: new Uint8Array(), accessList: [] }));
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return 'no error';
  } catch (e) {
    const c = evmRelayerError(e);
    return c ? (c.reason ? `${c.code}:${c.reason}` : c.code) : `uncoded: ${(e as Error).message}`;
  }
}

interface StoredRec {
  nonce: number;
  digest: string | null;
  versions: { hash: string; kind: string; raw: string; maxFeePerGas: string; maxPriorityFeePerGas: string }[];
  accepted: boolean;
  rejected: string | null;
  seen: { hash: string; block: number } | null;
}
async function stored(stub: Stub) {
  return runInDurableObject(stub, async (_i, state) => {
    const kv = state.storage.kv;
    return {
      meta: kv.get<{ nextNonce: number | null; dayWei: string; alarmMs: number; remembered: number; address: string; gapSeen: number | null }>('meta'),
      recs: Array.from(kv.list<StoredRec>({ prefix: 'rec:' }), ([, v]) => v),
      digs: Array.from(kv.list({ prefix: 'dig:' }), ([k]) => k),
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
const halted = async (stub: Stub) => (await stub.status()).halted;
const WHO = 'staff@example.test';

let chain: EvmMock;
beforeEach(() => {
  forgetVerifiedChains();
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  chain = new EvmMock({ chainId: CHAIN }).install();
});
afterEach(() => vi.restoreAllMocks());

describe('verifySend: the in-object check', () => {
  const setting = parseEvmSponsorConfig(sponsorVar(), { network: 'testnet', envName: 'local-evm-test', pinnedDelegates: SPONSOR_DELEGATES });
  const chainCfg = sponsorChain((setting as { config: Parameters<typeof sponsorChain>[0] }).config, CHAIN)!;
  const ctx = (over: Partial<Parameters<typeof verifySend>[1]> = {}) => ({ chain: chainCfg, relayer: RELAYER, pinned: SPONSOR_DELEGATES, nowMs: now, ...over });
  const code = (req: EvmRelayerSendRequest, c = ctx()): string => {
    try {
      verifySend(req, c);
      return 'ok';
    } catch (e) {
      return evmRelayerError(e)?.code ?? 'uncoded';
    }
  };

  it('builds execute(...) to the account with value 0 from the Execute and its signature; the digest is its own', () => {
    const req = request({ authorization: authorization() }, USER_KEY);
    const v = verifySend(req, ctx());
    expect(v).toMatchObject({ digest: digestOf(req), to: USER.toLowerCase(), gas: req.gas, fees: { maxFeePerGas: req.maxFeePerGas, maxPriorityFeePerGas: req.maxPriorityFeePerGas }, deadline: Number(req.execute.deadline) });
    expect(v.data).toBe(encodeExecuteCalldata(req.execute, req.signature).toLowerCase());
    expect(v.authorization).toMatchObject({ chainId: CHAIN, address: DELEGATE, nonce: '0' });
  });

  it('refuses each unsafe field with its code', () => {
    const other = testKey('someone else');
    const cases: [EvmRelayerSendRequest, string][] = [
      [request({ execute: { account: USER } }, other), 'invalid_request'],
      [request({ execute: { relayer: OTHER } }), 'invalid_request'],
      [request({ execute: { implementation: CHECK_IN } }), 'invalid_request'],
      [request({ execute: { chainId: 84532 } }), 'invalid_request'],
      [{ ...request(), chainId: 84532 }, 'invalid_request'],
      [request({ execute: { calls: [{ to: CHECK_IN, value: 1n, data: '0x183ff085' }] } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: USER, value: 0n, data: '0x' }] } }, USER_KEY), 'invalid_request'],
      [request({ execute: { calls: [{ to: DELEGATE, value: 0n, data: '0x' }] } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: RELAYER, value: 0n, data: '0x' }] } }), 'invalid_request'],
      [request({ execute: { calls: [{ to: `0x${'0'.repeat(40)}`, value: 0n, data: '0x' }] } }), 'invalid_request'],
      [request({ execute: { calls: [] } }), 'invalid_request'],
      [request({ execute: { calls: Array.from({ length: 5 }, () => ({ to: CHECK_IN, value: 0n, data: '0x183ff085' as Hex })) } }), 'invalid_request'],
      [request({ execute: { minGas: 99_999n } }), 'invalid_request'],
      [request({ execute: { minGas: 200_001n } }), 'invalid_request'],
      [request({ execute: { account: RELAYER } }, RELAYER_KEY), 'invalid_request'],
      [request({ gas: 300_001n }), 'invalid_request'],
      [request({ gas: 20_999n, execute: { minGas: 100_000n } }), 'invalid_request'],
      [request({ maxFeePerGas: GWEI + 1n }), 'invalid_request'],
      [request({ maxFeePerGas: 0n }), 'invalid_request'],
      [request({ maxFeePerGas: 1000n, maxPriorityFeePerGas: 1001n, reservedWei: ETH }), 'invalid_request'],
      [request({ maxPriorityFeePerGas: GWEI / 100n }), 'fees_too_high'],
      [request({ reservedWei: 200_000n * (GWEI / 10n) - 1n }), 'invalid_request'],
      [request({ execute: { deadline: nowS() + 5n } }), 'deadline_passed'],
      [request({ execute: { deadline: nowS() + 661n } }), 'invalid_request'],
      [{ ...request(), signature: '0x1234' as Hex }, 'invalid_request'],
      [request({ authorization: { ...authorization(), chainId: 84532 } }, USER_KEY), 'invalid_request'],
      [request({ authorization: authorization({}, other) }, USER_KEY), 'invalid_request'],
      [request({ authorization: { ...authorization(), address: CHECK_IN } }, USER_KEY), 'invalid_request'],
      [request({ authorization: { ...authorization(), s: `0x${'f'.repeat(64)}` as Hex } }, USER_KEY), 'invalid_request'],
    ];
    for (const [req, want] of cases) expect([req.execute, code(req)]).toEqual([req.execute, want]);
    expect(code(request())).toBe('ok');
  });

  it('only a deployed (non-placeholder) pinned delegate that the config names: else relayer_unconfigured', () => {
    expect(code(request(), ctx({ pinned: { [CHAIN]: { address: DELEGATE, placeholder: true } } }))).toBe('relayer_unconfigured');
    expect(code(request(), ctx({ pinned: { [CHAIN]: { address: CHECK_IN, placeholder: false } } }))).toBe('relayer_unconfigured');
    expect(code(request(), ctx({ pinned: {} }))).toBe('relayer_unconfigured');
  });

  it('fee headroom: two bumps must fit under the caps; maxStartingFees is the edge; bumps are × 1.125 and at least +10%', () => {
    const caps = { maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n };
    const edge = maxStartingFees(caps);
    expect(hasFeeHeadroom(edge, caps)).toBe(true);
    expect(hasFeeHeadroom({ ...edge, maxFeePerGas: edge.maxFeePerGas + 1n }, caps)).toBe(false);
    expect(hasFeeHeadroom({ ...edge, maxPriorityFeePerGas: edge.maxPriorityFeePerGas + 1n }, caps)).toBe(false);
    expect(bumpedFees({ maxFeePerGas: 800n, maxPriorityFeePerGas: 8n }, caps)).toEqual({ maxFeePerGas: 900n, maxPriorityFeePerGas: 9n });
    expect(bumpedFees({ maxFeePerGas: GWEI, maxPriorityFeePerGas: GWEI / 100n }, caps)).toBeNull();
    expect(bumpedFees({ maxFeePerGas: (GWEI * 95n) / 100n, maxPriorityFeePerGas: 1n }, caps)).toBeNull();
  });
});

describe('send: new records', () => {
  it('a fresh object reads the pending count ONCE, signs type 2 at it, persists (alarm set) before the broadcast; the same Execute is a replay', async () => {
    chain.setMined(RELAYER, 7);
    const stub = await fresh();
    const req = request({}, USER_KEY);
    const sent = await stub.send(req);
    expect(sent).toMatchObject({ digest: digestOf(req), relayerNonce: 7, replay: false });
    const tx = chain.pooled(RELAYER, 7)!;
    expect(tx).toMatchObject({ type: 2, from: RELAYER.toLowerCase(), to: USER.toLowerCase(), nonce: 7, value: 0n, gas: req.gas, maxFeePerGas: req.maxFeePerGas });
    expect([sent.transactionHash, sent.raw]).toEqual([tx.hash, tx.raw]);
    expect((await stored(stub)).alarm).toBe(now + EVM_RELAYER_ALARM_MS);
    // Later sends never read the count again.
    const reads = () => chain.calls.filter((c) => c.method === 'eth_getTransactionCount').length;
    expect(reads()).toBe(1);
    expect((await stub.send(request())).relayerNonce).toBe(8);
    expect(reads()).toBe(1);
    // The same Execute from a real signer: the same digest, a replay, nothing new sent.
    expect(await stub.send({ ...req, signature: signExecute(USER_KEY, req.execute, { enabledChains: [CHAIN] }) })).toMatchObject({ transactionHash: sent.transactionHash, raw: sent.raw, replay: true });
    expect(chain.broadcasts).toHaveLength(2);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'pending', relayerNonce: 7, transactionHash: tx.hash, hashes: [tx.hash], minedHash: null, outcome: null, costWei: null, reservedWei: req.reservedWei });
  });

  it('type 4 with the user’s authorization', async () => {
    const stub = await fresh();
    const sent = await stub.send(request({ authorization: authorization() }, USER_KEY));
    expect(chain.pooled(RELAYER, sent.relayerNonce)).toMatchObject({ type: 4, authorizations: 1, to: USER.toLowerCase() });
  });

  it('refuses before reading or signing anything: a bad request, wrong chain, unconfigured chain, missing or wrong key', async () => {
    const stub = await fresh();
    expect(await codeOf(stub.send(request({ execute: { calls: [] } })))).toBe('invalid_request');
    expect(await codeOf(stub.send({ ...request(), chainId: 84532 }))).toBe('relayer_unconfigured');
    for (const keys of [undefined, 'not json', JSON.stringify([keyHex(OTHER_KEY)]), JSON.stringify([keyHex(RELAYER_KEY), keyHex(OTHER_KEY)])]) {
      await configure(stub, overlay({ EVM_RELAY_KEYS: keys }));
      expect(await codeOf(stub.send(request()))).toBe('relayer_misconfigured');
    }
    await configure(stub, overlay({ EVM_SPONSOR: undefined }));
    expect(await codeOf(stub.send(request()))).toBe('relayer_unconfigured');
    expect(chain.calls).toEqual([]);
    await configure(stub);
    await stub.send(request());
    expect(await codeOf(stub.send({ ...request(), chainId: 84532 }))).toBe('wrong_chain');
  });

  it('a fresh object whose read endpoint is down: rpc_unavailable, nothing stored, the fallback never read', async () => {
    chain.modes[0] = 'down';
    const stub = await fresh();
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect((await stored(stub)).meta).toBeUndefined();
    expect(chain.calls.filter((c) => c.endpoint === 1)).toEqual([]);
  });

  it(`caps: ${EVM_RELAYER_MAX_UNMINED} unmined (records seen mined don’t count), ${EVM_RELAYER_MAX_RECORDS} records in all, ${EVM_RELAYER_MAX_QUEUE} waiting`, async () => {
    const stub = await fresh();
    chain.safeDepth = 1000;
    for (let round = 0; round < EVM_RELAYER_MAX_RECORDS / EVM_RELAYER_MAX_UNMINED; round++) {
      for (let i = 0; i < EVM_RELAYER_MAX_UNMINED; i++) await stub.send(request());
      expect(await codeOf(stub.send(request()))).toBe('relayer_busy');
      chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
      await runDurableObjectAlarm(stub);
    }
    expect(await stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: EVM_RELAYER_MAX_RECORDS });
    expect(await codeOf(stub.send(request()))).toBe('relayer_busy');
    chain.safeDepth = 2;
    await runDurableObjectAlarm(stub);
    expect(await stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: EVM_RELAYER_MAX_RECORDS - 20 });
    // The queue: a send held mid-broadcast, then more than 16 waiting.
    let gate = true;
    let entered = false;
    chain.onSend = async () => {
      entered = true;
      while (gate) await new Promise((r) => setTimeout(r, 5));
      return undefined;
    };
    const slow = stub.send(request());
    await until(() => entered);
    const queued = Array.from({ length: 20 }, () => codeOf(stub.send(request())));
    await new Promise((r) => setTimeout(r, 100));
    gate = false;
    await slow;
    const out = await Promise.all(queued);
    expect(out.filter((x) => x === 'relayer_busy').length).toBeGreaterThanOrEqual(20 - EVM_RELAYER_MAX_QUEUE);
  });

  it('the daily backstop: worst cases (gas at the fee cap) past 2 × dailyBudgetEth a UTC day are refused, a mined one settles to its cost, the next day starts at 0', async () => {
    const stub = await fresh();
    const big = (): EvmRelayerSendRequest => request({ reservedWei: (15n * ETH) / 1000n });
    const worst = (15n * ETH) / 1000n + 200_000n * (GWEI - GWEI / 10n);
    await stub.send(big());
    await stub.send(big());
    expect(await codeOf(stub.send(big()))).toBe('daily_cap');
    expect((await stored(stub)).meta?.dayWei).toBe((2n * worst).toString());
    chain.mine(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).meta?.dayWei).toBe((worst + 21_000n * GWEI).toString());
    await stub.send(big());
    advance(24 * 60 * 60_000);
    expect(await codeOf(stub.send(big()))).toBe('no error');
  });
});

describe('idempotency and the queue', () => {
  it('N concurrent sends get N consecutive nonces, each broadcast once, in nonce order', async () => {
    chain.setMined(RELAYER, 40);
    chain.onSend = () => new Promise((r) => setTimeout(() => r(undefined), Math.random() * 20));
    const stub = await fresh();
    const results = await Promise.all(Array.from({ length: 8 }, () => stub.send(request())));
    expect(results.map((r) => r.relayerNonce).sort((a, b) => a - b)).toEqual([40, 41, 42, 43, 44, 45, 46, 47]);
    expect(chain.broadcasts.map((b) => b.tx.nonce)).toEqual([40, 41, 42, 43, 44, 45, 46, 47]);
  });

  it('concurrent identical requests make one transaction; after it is mined the digest still answers (replay, lookup mined)', async () => {
    const stub = await fresh();
    const req = request();
    const results = await Promise.all(Array.from({ length: 10 }, () => stub.send(req)));
    expect(new Set(results.map((r) => r.transactionHash)).size).toBe(1);
    expect(results.filter((r) => !r.replay)).toHaveLength(1);
    expect(chain.broadcasts).toHaveLength(1);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toEqual([]);
    expect(await stub.send({ ...req, gas: 250_000n })).toMatchObject({ transactionHash: results[0]!.transactionHash, raw: null, replay: true, broadcast: 'accepted' });
    expect(chain.broadcasts).toHaveLength(1);
  });

  it('the alarm waits for a send in flight (no interleave across its RPC awaits)', async () => {
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
});

describe('crashes at each step never reuse a nonce or lose a transaction', () => {
  it('a failed write before persisting sends nothing; the next send uses that nonce', async () => {
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
    stub = await crash(stub);
    expect(await stub.send(req)).toMatchObject({ relayerNonce: 4, replay: false });
  });

  it('a crash during the fresh object’s one count read leaves nothing stored', async () => {
    let stub = await fresh();
    let release: (() => void) | undefined;
    chain.onRead = (method) => (method === 'eth_getTransactionCount' && !release ? new Promise<void>((r) => (release = r)) : undefined);
    const pending = stub.send(request()).then(
      () => 'sent',
      () => 'failed',
    );
    await until(() => release !== undefined);
    stub = await crash(stub);
    expect(await pending).toBe('failed');
    chain.onRead = undefined;
    expect((await stored(stub)).meta).toBeUndefined();
    expect((await stub.send(request())).relayerNonce).toBe(0);
  });

  it('a crash after persisting, before the broadcast reached a node: the alarm broadcasts the same raw; a resend is a replay', async () => {
    chain.setMined(RELAYER, 10);
    let stub = await fresh();
    chain.onSend = () => 'hang';
    const req = request();
    const first = stub.send(req).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 1);
    stub = await crash(stub);
    expect(await first).toBe('failed');
    chain.onSend = undefined;
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.nonce).toBe(10);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(chain.pooled(RELAYER, 10)?.hash).toBe(rec.versions[0]!.hash);
    expect(await stub.send(req)).toMatchObject({ transactionHash: rec.versions[0]!.hash, relayerNonce: 10, replay: true });
    expect((await stub.send(request())).relayerNonce).toBe(11);
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
    await runDurableObjectAlarm(stub);
    expect(new Set(chain.broadcasts.filter((b) => b.tx.nonce === 0).map((b) => b.tx.hash)).size).toBe(1);
    expect((await stored(stub)).recs[0]!.accepted).toBe(true);
  });

  it('a crash after signing a fee bump, before its broadcast: the next run broadcasts the stored bump', async () => {
    let stub = await fresh();
    await stub.send(request());
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    chain.onSend = () => 'hang';
    const alarm = runDurableObjectAlarm(stub).catch(() => 'failed');
    await until(() => chain.broadcasts.length === 2);
    stub = await crash(stub);
    await alarm;
    chain.onSend = undefined;
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions).toHaveLength(2);
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.versions[1]!.hash);
  });
});

describe('record transitions', () => {
  it('unmined → seen (receipt above confirmed depth) → mined at `safe`; cost includes the OP Stack fees; lookup and status follow', async () => {
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    chain.receiptExtras = { l1Fee: '0x3e8', operatorFeeScalar: '0x0', operatorFeeConstant: '0x7' };
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.seen).toEqual({ hash: sent.transactionHash, block: chain.receiptBlock(sent.transactionHash) });
    expect(await stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: 1 });
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'pending', transactionHash: sent.transactionHash, minedHash: null });
    // No read is needed while the seen block is above `safe`.
    const reads = chain.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length;
    await runDurableObjectAlarm(stub);
    expect(chain.calls.filter((c) => c.method === 'eth_getTransactionReceipt').length).toBe(reads);
    chain.addBlocks(chain.safeDepth);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toEqual({ digest: digestOf(req), relayerNonce: 0, transactionHash: sent.transactionHash, hashes: [sent.transactionHash], state: 'mined', minedHash: sent.transactionHash, outcome: 'execute', costWei: 21_000n * GWEI + 1000n + 7n, reservedWei: req.reservedWei });
    expect(await stub.status()).toMatchObject({ unmined: 0, awaitingConfirmation: 0, oldestUnminedMs: null, nextNonce: 1, halted: null });
  });

  it('without a `safe` tag, confirmed depth is head − 12', async () => {
    chain.supportsSafe = false;
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 11 });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toHaveLength(1);
    chain.addBlocks(1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toHaveLength(0);
  });

  it('a reorg before confirmed depth: seen → unmined, the same raw broadcast again, then mined', async () => {
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.seen).not.toBeNull();
    chain.unmine(RELAYER, 1, { drop: true });
    expect(chain.pooled(RELAYER, 0)).toBeUndefined();
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.seen).toBeNull();
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(sent.transactionHash);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', minedHash: sent.transactionHash });
    expect(await halted(stub)).toBeNull();
  });

  it('a dropped transaction is broadcast again, the same raw, to the fallback when the read endpoint refuses broadcasts', async () => {
    const stub = await fresh();
    const sent = await stub.send(request());
    chain.drop(RELAYER, 0);
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? 'network' : undefined);
    await runDurableObjectAlarm(stub);
    expect(chain.broadcasts.slice(-2).map((b) => [b.endpoint, b.tx.hash])).toEqual([
      [0, sent.transactionHash],
      [1, sent.transactionHash],
    ]);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(sent.transactionHash);
  });

  it(`fee bump: after 60 s the same nonce with both fees × 1.125, every version kept; at most ${EVM_RELAYER_MAX_VERSIONS - 1} for the batch`, async () => {
    const stub = await fresh();
    const req = request({ execute: { deadline: nowS() + 650n } });
    await stub.send(req);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions).toHaveLength(1);
    for (let i = 0; i < 9; i++) {
      advance(EVM_RELAYER_BUMP_AFTER_MS);
      await runDurableObjectAlarm(stub);
    }
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(Array(EVM_RELAYER_MAX_VERSIONS - 1).fill('execute'));
    expect(BigInt(rec.versions[1]!.maxFeePerGas)).toBe((req.maxFeePerGas * 9n + 7n) / 8n);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.versions.at(-1)!.hash);
    expect((await stub.lookup(digestOf(req)))!.hashes).toEqual(rec.versions.map((v) => v.hash));
  });

  it('the ORIGINAL mines instead of its replacement: minedHash is the original, outcome execute', async () => {
    const stub = await fresh();
    const req = request();
    const sent = await stub.send(req);
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions).toHaveLength(2);
    chain.admit(decodeRawTx(sent.raw!));
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', transactionHash: sent.transactionHash, minedHash: sent.transactionHash, outcome: 'execute', hashes: rec.versions.map((v) => v.hash) });
    expect(await stub.send(req)).toMatchObject({ transactionHash: sent.transactionHash, raw: null, replay: true });
  });

  it('past the deadline: a 0-value self-transfer at the same nonce (cancelling); when it mines, outcome cancel', async () => {
    const stub = await fresh();
    const req = request({ execute: { deadline: nowS() + 60n } });
    await stub.send(req);
    advance(61_000);
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect(chain.pooled(RELAYER, 0)).toMatchObject({ to: RELAYER.toLowerCase(), value: 0n, data: '0x', gas: 21_000n });
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'cancelling', transactionHash: rec.versions[1]!.hash });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', minedHash: rec.versions[1]!.hash, outcome: 'cancel' });
  });

  it('the batch mines after its cancel was signed: outcome execute', async () => {
    const stub = await fresh();
    const req = request({ execute: { deadline: nowS() + 60n } });
    const sent = await stub.send(req);
    advance(61_000);
    await runDurableObjectAlarm(stub);
    chain.admit(decodeRawTx(sent.raw!));
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', minedHash: sent.transactionHash, outcome: 'execute' });
  });

  it('the alarm backs off (15 s doubling to 5 minutes) while nothing changes; after the last record, hourly chain checks; batches forgotten after 7 days', async () => {
    const stub = await fresh();
    const req = request();
    await stub.send(req);
    const gaps: number[] = [];
    for (let i = 0; i < 6; i++) {
      await runDurableObjectAlarm(stub);
      gaps.push((await stored(stub)).alarm! - now);
    }
    expect(gaps).toEqual([30_000, 60_000, 120_000, 240_000, EVM_RELAYER_ALARM_MAX_MS, EVM_RELAYER_ALARM_MAX_MS]);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    // With no records: hourly chain checks (sooner than the 7-day forget time).
    expect((await stored(stub)).alarm).toBe(now + EVM_RELAYER_IDLE_CHECK_MS);
    advance(EVM_RELAYER_REMEMBER_MS - 1000);
    expect(await stub.lookup(digestOf(req))).not.toBeNull();
    advance(2000);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toBeNull();
    expect(await stored(stub)).toMatchObject({ digs: [], alarm: now + EVM_RELAYER_IDLE_CHECK_MS });
  });
});

describe('halt: nonce_consumed_elsewhere', () => {
  it('reached, safe while halted (later records still bumped; new sends refused; replays answer), staffClose(consumed_elsewhere), staffResume', async () => {
    const stub = await fresh();
    const a = request();
    await stub.send(a);
    await stub.send(request());
    chain.admit(foreign(0));
    chain.mine(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toEqual({ reason: 'nonce_consumed_elsewhere', since: now, nonce: 0 });
    expect(await codeOf(stub.send(request()))).toBe('relayer_halted');
    expect(await stub.send(a)).toMatchObject({ relayerNonce: 0, replay: true });
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs.find((r) => r.nonce === 1)!.versions).toHaveLength(2);
    expect(await evmRelayerStaffResume(stub, WHO, 'try')).toMatchObject({ done: false, refused: 'nonce_consumed_elsewhere' });
    const before = (await stored(stub)).meta!.dayWei;
    expect(await evmRelayerStaffClose(stub, WHO, 0, 'consumed_elsewhere', 'a foreign transaction took nonce 0')).toMatchObject({ done: true, refused: null });
    expect(await stub.lookup(digestOf(a))).toMatchObject({ state: 'closed', outcome: 'consumed_elsewhere', minedHash: null, costWei: null });
    expect((await stored(stub)).meta!.dayWei).toBe(before);
    const resumed = await evmRelayerStaffResume(stub, WHO, 'cause gone');
    expect(resumed).toMatchObject({ done: true, status: { halted: null } });
    expect(resumed.status.staffLog.map((e) => [e.action, e.done, e.refused, e.who])).toEqual([
      ['resume', true, null, WHO],
      ['close', true, null, WHO],
      ['resume', false, 'nonce_consumed_elsewhere', WHO],
    ]);
    expect((await stub.send(request())).relayerNonce).toBe(2);
  });

  it('staffClose(consumed_elsewhere) refuses: no record, nonce not consumed at confirmed depth, a receipt of its own, an incomplete check', async () => {
    const stub = await fresh();
    await stub.send(request());
    expect(await evmRelayerStaffClose(stub, WHO, 5, 'consumed_elsewhere', 'n')).toMatchObject({ refused: 'no_record' });
    expect(await evmRelayerStaffClose(stub, WHO, 0, 'consumed_elsewhere', 'n')).toMatchObject({ refused: 'nonce_not_consumed_at_confirmed_depth' });
    chain.mine(RELAYER);
    chain.receiptFailures = 1;
    expect(await evmRelayerStaffClose(stub, WHO, 0, 'consumed_elsewhere', 'n')).toMatchObject({ refused: 'incomplete_check' });
    expect(await evmRelayerStaffClose(stub, WHO, 0, 'consumed_elsewhere', 'n')).toMatchObject({ refused: 'receipt_found' });
  });
});

describe('halt: nonce_gap', () => {
  it('a nonce nobody holds, seen on two runs in a row; safe while halted; staffFill fills it; staffResume', async () => {
    chain.admit(foreign(0));
    const stub = await fresh();
    const req = request();
    expect((await stub.send(req)).relayerNonce).toBe(1);
    chain.drop(RELAYER, 0);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
    expect((await stored(stub)).meta!.gapSeen).toBe(0);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'nonce_gap', nonce: 0 });
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions).toHaveLength(2);
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'nonce_gap' });
    expect(await evmRelayerStaffFill(stub, WHO, 1, 'n')).toMatchObject({ refused: 'record_exists' });
    expect(await evmRelayerStaffFill(stub, WHO, 2, 'n')).toMatchObject({ refused: 'not_below_next_nonce' });
    expect(await evmRelayerStaffFill(stub, WHO, 0, 'fill the gap')).toMatchObject({ done: true });
    expect(chain.pooled(RELAYER, 0)).toMatchObject({ to: RELAYER.toLowerCase(), value: 0n, gas: 21_000n });
    expect(await evmRelayerStaffResume(stub, WHO, 'filled')).toMatchObject({ done: true });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toEqual([]);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', outcome: 'execute' });
  });

  it('one run that sees it and one that doesn’t: no halt', async () => {
    chain.admit(foreign(0));
    const stub = await fresh();
    await stub.send(request());
    const tx = chain.pooled(RELAYER, 0)!;
    chain.drop(RELAYER, 0);
    await runDurableObjectAlarm(stub);
    chain.admit(tx);
    await runDurableObjectAlarm(stub);
    chain.drop(RELAYER, 0);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
  });

  it('staffFill refuses: a key that can’t sign, a nonce that is not the chain’s next one', async () => {
    chain.admit(foreign(0));
    chain.admit(foreign(1));
    const stub = await fresh();
    await stub.send(request());
    chain.drop(RELAYER, 0);
    chain.drop(RELAYER, 1);
    expect(await evmRelayerStaffFill(stub, WHO, 1, 'n')).toMatchObject({ refused: 'not_the_chains_next_nonce' });
    await configure(stub, overlay({ EVM_RELAY_KEYS: undefined }));
    expect(await evmRelayerStaffFill(stub, WHO, 0, 'n')).toMatchObject({ refused: 'key_mismatch' });
  });
});

describe('halt: foreign_transactions', () => {
  it('the key used elsewhere (counts above nextNonce); safe while halted; staffAdoptNonce after the records are final; staffResume', async () => {
    const stub = await fresh();
    await stub.send(request());
    await stub.send(request());
    chain.admit(foreign(2));
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'foreign_transactions', nonce: 2 });
    expect(await codeOf(stub.send(request()))).toBe('relayer_halted');
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 3, 'n')).toMatchObject({ refused: 'unmined_records' });
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    await runDurableObjectAlarm(stub);
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 1, 'n')).toMatchObject({ refused: 'below_next_nonce' });
    chain.addBlocks(5);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toEqual([]);
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'foreign_transactions' });
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 2, 'n')).toMatchObject({ refused: 'chain_count_differs' });
    chain.admit(foreign(3));
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 3, 'n')).toMatchObject({ refused: 'chain_count_differs' });
    chain.mine(RELAYER);
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 4, 'the chain’s count')).toMatchObject({ done: true, status: { nextNonce: 4 } });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ done: true });
    expect((await stub.send(request())).relayerNonce).toBe(4);
  });
});

describe('halt: relayer_cannot_send', () => {
  it('at send: answered (not coded: the record may still land), halted; rebroadcasts go on; once accepted, staffResume', async () => {
    const stub = await fresh();
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    const sent = await stub.send(request());
    expect(sent.replay).toBe(false);
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'insufficient_funds' });
    expect(await codeOf(stub.send(request()))).toBe('relayer_halted');
    await runDurableObjectAlarm(stub);
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'relayer_cannot_send' });
    expect(sent.broadcast).toBe('rejected');
    chain.onSend = undefined;
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.versions[1]!.hash);
    expect(await evmRelayerStaffResume(stub, WHO, 'funded')).toMatchObject({ done: true });
  });

  it('later: the batch refused (a first broadcast with no answer) is cancelled; only our cancel refused too halts', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    await stub.send(request());
    expect(await halted(stub)).toBeNull();
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'insufficient_funds' });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
  });

  it('later, `nonce too low` for a record never accepted halts nothing by itself: receipts at confirmed depth decide', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    await stub.send(request());
    chain.onSend = () => ({ error: 'nonce too low' });
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
    expect((await stored(stub)).recs[0]).toMatchObject({ accepted: false, batchRejected: null, cannotSend: null });
  });

  it('a cancel that never goes out: staffCancel bumps it (the nonce is never freed); once one is taken and mined, staffResume', async () => {
    const stub = await fresh();
    chain.onSend = () => ({ error: 'insufficient funds' });
    const req = request();
    await stub.send(req);
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send' });
    chain.onSend = undefined;
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'funded, send the cancel again')).toMatchObject({ done: true });
    expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel', 'cancel']);
    expect((await stored(stub)).meta!.nextNonce).toBe(1);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', outcome: 'cancel' });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ done: true });
    expect((await stub.send(request())).relayerNonce).toBe(1);
  });
});

describe('halt: stuck_past_deadline', () => {
  it('unmined 30 minutes past the deadline (its cancel signed and sent all along); once the cancel mines, staffResume', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    const req = request({ execute: { deadline: nowS() + 60n } });
    await stub.send(req);
    advance(61_000);
    await runDurableObjectAlarm(stub);
    advance(EVM_RELAYER_STUCK_AFTER_DEADLINE_MS);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'stuck_past_deadline', nonce: 0 });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'stuck_past_deadline' });
    chain.onSend = undefined;
    await runDurableObjectAlarm(stub);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(req))).toMatchObject({ state: 'mined', outcome: 'cancel' });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ done: true });
  });
});

describe('halt: key_mismatch', () => {
  it('a new key with records in flight: halted, nothing signed (no bump), rebroadcasts and receipts go on; the old key back, staffResume', async () => {
    const stub = await fresh();
    const a = request();
    await stub.send(a);
    await stub.send(request());
    const other = overlay({ EVM_RELAY_KEYS: JSON.stringify([keyHex(OTHER_KEY)]), EVM_SPONSOR: sponsorVar({}, OTHER) });
    await configure(stub, other);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'key_mismatch' });
    expect(await codeOf(stub.send(request({ execute: { relayer: OTHER } })))).toBe('relayer_halted');
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    chain.drop(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs.map((r) => r.versions.length)).toEqual([1, 1]);
    expect(chain.pooled(RELAYER, 1)).toBeDefined();
    chain.mine(RELAYER, 1);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(digestOf(a))).toMatchObject({ state: 'mined' });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'key_mismatch' });
    await configure(stub);
    expect(await evmRelayerStaffResume(stub, WHO, 'the old key is back')).toMatchObject({ done: true });
  });

  it('a key whose address is not relayerAddress, with records: halted; a missing key halts nothing but signs nothing', async () => {
    const stub = await fresh();
    await stub.send(request());
    await configure(stub, overlay({ EVM_RELAY_KEYS: undefined }));
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
    expect((await stored(stub)).recs[0]!.versions).toHaveLength(1);
    await configure(stub, overlay({ EVM_RELAY_KEYS: JSON.stringify([keyHex(OTHER_KEY)]) }));
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'key_mismatch' });
  });

  it('a new key with nothing in flight starts a new nonce life (its own pending count)', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    chain.setMined(OTHER, 9);
    await configure(stub, overlay({ EVM_RELAY_KEYS: JSON.stringify([keyHex(OTHER_KEY)]), EVM_SPONSOR: sponsorVar({}, OTHER) }));
    expect((await stub.send(request({ execute: { relayer: OTHER } }))).relayerNonce).toBe(9);
    expect(await stub.status()).toMatchObject({ address: OTHER, nextNonce: 10, halted: null });
  });
});

describe('halt: storage_inconsistent', () => {
  it('a record whose batch entry is gone: sends refused and halted; staffResume refuses while it persists', async () => {
    const stub = await fresh();
    const a = request();
    await stub.send(a);
    await runInDurableObject(stub, (_i, state) => void state.storage.kv.delete(`dig:${digestOf(a)}`));
    expect(await codeOf(stub.send(request()))).toBe('relayer_halted');
    expect(await halted(stub)).toMatchObject({ reason: 'storage_inconsistent' });
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ refused: 'storage_inconsistent' });
  });
});

describe('staff tools: input and records', () => {
  it('refuse a wrong guard, a missing or oversized who or note; nothing clears a halt but staffResume; resume refuses when not halted', async () => {
    const stub = await fresh();
    await stub.send(request());
    expect(await codeOf(stub.staffResume('nope', WHO, 'n'))).toBe('invalid_request');
    expect(await codeOf(stub.staffStatus('nope'))).toBe('invalid_request');
    expect(await codeOf(evmRelayerStaffResume(stub, '', 'n'))).toBe('invalid_request');
    expect(await codeOf(evmRelayerStaffResume(stub, WHO, 'x'.repeat(501)))).toBe('invalid_request');
    expect(await codeOf(evmRelayerStaffResume(stub, WHO, 'line\nbreak'))).toBe('invalid_request');
    expect(await codeOf(evmRelayerStaffFill(stub, WHO, -1, 'n'))).toBe('invalid_request');
    expect(await codeOf(stub.staffClose('hana-id/evm-relayer/staff/v1', WHO, 0, 'taken' as never, 'n'))).toBe('invalid_request');
    expect(await evmRelayerStaffResume(stub, WHO, 'n')).toMatchObject({ done: false, refused: 'not_halted' });
    const s = await evmRelayerStaffStatus(stub);
    expect(s).toMatchObject({ chainId: CHAIN, address: RELAYER, nextNonce: 1, halted: null, gapSeen: null });
    expect(s.records[0]).toMatchObject({ nonce: 0, accepted: true, batchRejected: null, cannotSend: null, seen: null });
    expect(JSON.stringify(s, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v))).not.toMatch(/"raw"|"data"/u);
    expect(s.staffLog[0]).toMatchObject({ seq: 1, at: now, who: WHO, action: 'resume', note: 'n', done: false, refused: 'not_halted' });
  });
});

describe('RPC failures', () => {
  it('the read endpoint down: the alarm changes nothing and backs off; a send is refused before anything is stored', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.modes[0] = 'down';
    forgetVerifiedChains();
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions).toHaveLength(1);
    expect(await halted(stub)).toBeNull();
    // A send needs the base fee from the read endpoint: refused, nothing stored, the fallback never read.
    expect(await codeOf(stub.send(request()))).toBe('rpc_unavailable');
    expect((await stored(stub)).recs).toHaveLength(1);
    expect(chain.calls.filter((c) => c.endpoint === 1)).toEqual([]);
  });

  it('read endpoint and fallback both fail the broadcast: the record is kept and answered, broadcast by the next run', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    const sent = await stub.send(request());
    expect(chain.pooled(RELAYER, 0)).toBeUndefined();
    chain.onSend = undefined;
    await runDurableObjectAlarm(stub);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(sent.transactionHash);
  });

  it('with the keyed secret set, every read goes to it alone; broadcasts go to it, then the others', async () => {
    chain = new EvmMock({ chainId: CHAIN, urls: [KEYED_RPC, PRIMARY_RPC, FALLBACK_RPC] }).install();
    const stub = await fresh(overlay({ EVM_SPONSOR_RPC_31337: KEYED_RPC }));
    await stub.send(request());
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? 'network' : undefined);
    await stub.send(request());
    await runDurableObjectAlarm(stub);
    expect(chain.calls.filter((c) => c.endpoint > 0 && c.method !== 'eth_sendRawTransaction' && c.method !== 'eth_chainId')).toEqual([]);
    // Urls here: 0 the keyed one, 1 `rpc`, 2 `rpcFallback`. Broadcast order: the read endpoint, the fallback, then `rpc`.
    expect(chain.broadcasts.filter((b) => b.tx.nonce === 1).map((b) => b.endpoint)).toEqual([0, 2, 0]);
    chain.onSend = (_tx, endpoint) => (endpoint !== 1 ? 'network' : undefined);
    await stub.send(request());
    expect(chain.broadcasts.filter((b) => b.tx.nonce === 2).map((b) => b.endpoint)).toEqual([0, 2, 1]);
  });

  it('an endpoint on another chain is never read from or sent to', async () => {
    chain.modes[1] = 'wrong_chain';
    const stub = await fresh();
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? 'network' : undefined);
    await stub.send(request());
    expect(chain.calls.filter((c) => c.endpoint === 1).map((c) => c.method)).toEqual(['eth_chainId']);
  });
});

describe('secrets stay out of logs and errors', () => {
  it('never logs the key, a raw transaction, calldata, a signature, an authorization or an RPC URL', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    chain = new EvmMock({ chainId: CHAIN, urls: [KEYED_RPC, PRIMARY_RPC, FALLBACK_RPC] }).install();
    const stub = await fresh(overlay({ EVM_SPONSOR_RPC_31337: KEYED_RPC }));
    const req = request({ authorization: authorization() }, USER_KEY);
    const sent = await stub.send(req);
    chain.onSend = () => ({ error: 'insufficient funds' });
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    await runDurableObjectAlarm(stub);
    chain.modes[0] = 'down';
    forgetVerifiedChains();
    const err = await codeOf(stub.send(request()));
    await evmRelayerStaffResume(stub, WHO, 'n');
    const text = `${lines.join('\n')} ${err}`;
    const auth = req.authorization!;
    for (const secret of [keyHex(RELAYER_KEY).slice(2), sent.raw!.slice(2), req.signature.slice(2), encodeExecuteCalldata(req.execute, req.signature).slice(2), auth.r.slice(2), auth.s.slice(2), 'test.invalid', 'SECRET-PROVIDER-KEY']) {
      expect(text.toLowerCase()).not.toContain(secret.toLowerCase());
    }
    expect(lines.length).toBeGreaterThan(3);
    expect(evmRelayKeyAddress(JSON.stringify([keyHex(RELAYER_KEY)]))).toBe(RELAYER);
  });

  it('evmRelayerError reads only the object’s own codes', () => {
    expect(evmRelayerError(new Error('evm_relayer:relayer_halted'))).toEqual({ code: 'relayer_halted', reason: null });
    expect(evmRelayerError(new Error('evm_relayer:rejected:insufficient_funds'))).toEqual({ code: 'rejected', reason: 'insufficient_funds' });
    expect(evmRelayerError(new Error('evm_relayer:made_up'))).toBeNull();
    expect(evmRelayerError(new Error('Network connection lost.'))).toBeNull();
  });
});

// ---- The independent review of PR 75 (2026-11-18): each finding and probe as a test (probe-pr75 L1–L6). ----

const userKeyFor = (label: string) => {
  const key = testKey(label);
  return { key, addr: addressFor(key) };
};
/** A request from another user's account (their own key signs it). */
function reqFor(label: string, over: Parameters<typeof request>[0] = {}): EvmRelayerSendRequest {
  const u = userKeyFor(label);
  return request({ ...over, execute: { account: u.addr, ...(over.execute ?? {}) } }, u.key);
}
/** Rejects every transaction that is not the relayer's own self-transfer (the user-shaped batch), with `message`. */
const rejectBatches = (message: string) => (tx: { to: string }) => (tx.to === RELAYER.toLowerCase() ? undefined : { error: message });
/** Wraps the mock's fetch on the read endpoint: `edit` may return a replacement JSON-RPC result. */
function intercept(edit: (method: string, params: unknown[]) => unknown) {
  const f = globalThis.fetch as unknown as { getMockImplementation(): (i: RequestInfo | URL, init?: RequestInit) => Promise<Response> };
  const inner = f.getMockImplementation();
  vi.mocked(globalThis.fetch).mockImplementation(async (input, init) => {
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(PRIMARY_RPC)) {
      const r = edit(body.method, body.params);
      if (r !== undefined) return Response.json({ jsonrpc: '2.0', id: body.id, result: r });
    }
    return inner(input, init);
  });
}

describe('review H1: no user can halt sponsorship', () => {
  it('(a) the object computes the intrinsic gas (calldata at the EIP-7623 floor, 25 000 per authorization) and refuses a gas below it plus minGas', async () => {
    const stub = await fresh();
    const big = `0x183ff085${'ff'.repeat(8000)}` as Hex;
    expect(await codeOf(stub.send(reqFor('attacker', { execute: { calls: [{ to: CHECK_IN, value: 0n, data: big }] } })))).toBe('invalid_request');
    // Plain calldata: 200 000 gas is enough for the execute's own calldata, but not with minGas 190 000 on top.
    expect(await codeOf(stub.send(reqFor('attacker', { execute: { minGas: 190_000n } })))).toBe('invalid_request');
    expect(chain.broadcasts).toEqual([]);
  });

  it('(b) probe L4: a definite rejection of the batch at send: its own cancel at the same nonce at once, broadcast "rejected", no halt; the next user is served', async () => {
    const stub = await fresh();
    chain.onSend = rejectBatches('intrinsic gas too low');
    const req = reqFor('attacker', { execute: { calls: [{ to: CHECK_IN, value: 0n, data: `0x183ff085${'ff'.repeat(400)}` as Hex }] } });
    const sent = await stub.send(req);
    expect(sent).toMatchObject({ relayerNonce: 0, replay: false, broadcast: 'rejected' });
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect(chain.pooled(RELAYER, 0)).toMatchObject({ to: RELAYER.toLowerCase(), value: 0n });
    expect(await halted(stub)).toBeNull();
    chain.onSend = undefined;
    expect(await stub.send(reqFor('victim'))).toMatchObject({ relayerNonce: 1, broadcast: 'accepted' });
    expect(await stub.send(req)).toMatchObject({ replay: true, broadcast: 'rejected' });
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(sent.digest)).toMatchObject({ state: 'mined', outcome: 'cancel' });
  });

  it('(b) our own cancel refused (for a request-caused batch refusal) halts too: relayer_cannot_send with the cancel\'s code', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.to === RELAYER.toLowerCase() ? { error: 'insufficient funds for gas * price + value' } : { error: 'intrinsic gas too low' });
    expect(await stub.send(request())).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'request', code: 'gas_limit' } });
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'insufficient_funds' });
  });

  it('no request-shaped input causes a halt: a refusal caused by the batch itself (or an unclassified error) only cancels it, at send or later', async () => {
    const messages = ['intrinsic gas too low', 'transaction too large', 'oversized data', 'authority already reserved', 'something unknown'];
    for (const [i, message] of messages.entries()) {
      const stub = await fresh();
      chain.onSend = rejectBatches(message);
      const sent = await stub.send(reqFor(`shaper ${i}`, { authorization: i % 2 ? authorization({}, userKeyFor(`shaper ${i}`).key) : undefined }));
      if (i < 3) expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'request' } });
      chain.onSend = (tx) => (i % 2 && tx.to !== RELAYER.toLowerCase() ? 'network' : rejectBatches(message)(tx));
      advance(EVM_RELAYER_BUMP_AFTER_MS);
      await runDurableObjectAlarm(stub);
      expect([message, await halted(stub)]).toEqual([message, null]);
      chain.onSend = undefined;
    }
    // Later: a first broadcast with no answer, then a refusal caused by the batch: the next version is its cancel.
    const stub = await fresh();
    chain.onSend = () => 'network';
    await stub.send(request());
    chain.onSend = rejectBatches('intrinsic gas too low');
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect(await halted(stub)).toBeNull();
  });

  it('a refusal only our side can cause (funds, our nonce, our signature) cancels the batch AND halts: relayer_cannot_send with its code', async () => {
    const ours: [string, string][] = [
      ['insufficient funds for gas * price + value', 'insufficient_funds'],
      ['nonce too low', 'nonce_too_low'],
      ['nonce too high', 'nonce_too_high'],
      ['invalid sender', 'invalid_transaction'],
    ];
    for (const [i, [message, code]] of ours.entries()) {
      chain = new EvmMock({ chainId: CHAIN }).install();
      const stub = await fresh();
      chain.onSend = rejectBatches(message);
      const sent = await stub.send(reqFor(`ours ${i}`));
      expect([code, sent.broadcast, sent.rejection]).toEqual([code, 'rejected', { cause: 'relayer', code }]);
      expect([code, await halted(stub)]).toEqual([code, { reason: 'relayer_cannot_send', since: now, nonce: 0, code }]);
      expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
      chain.onSend = undefined;
    }
  });

  it('every classified refusal code has an explicit cause (adding a code forces a decision)', () => {
    const samples: Record<string, string> = {
      nonce_too_low: 'nonce too low',
      nonce_too_high: 'nonce too high',
      replacement_underpriced: 'replacement transaction underpriced',
      underpriced: 'transaction underpriced',
      insufficient_funds: 'insufficient funds for gas * price + value',
      fee_below_base_fee: 'max fee per gas less than block base fee',
      gas_limit: 'intrinsic gas too low',
      oversized: 'transaction too large',
      invalid_transaction: 'invalid sender',
    };
    expect([...EVM_REJECTIONS].sort()).toEqual(Object.keys(samples).sort());
    for (const code of EVM_REJECTIONS) expect(classifyRejection(samples[code]!)).toBe(code);
    // The cause of a refusal of a BATCH version (our own cancel or filler refused for any reason halts).
    expect(REJECTION_CAUSE).toEqual({ gas_limit: 'request', oversized: 'request', underpriced: 'pricing', fee_below_base_fee: 'pricing', replacement_underpriced: 'pricing', nonce_too_low: 'relayer', nonce_too_high: 'relayer', insufficient_funds: 'relayer', invalid_transaction: 'relayer' });
    expect(new Set(Object.values(REJECTION_CAUSE))).toEqual(new Set(['request', 'pricing', 'relayer']));
  });

  it('probe N1: the relayer short of funds for batches but not for cancels halts at the first send, the user is not blamed', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.gas > 21_000n ? { error: 'insufficient funds for gas * price + value' } : undefined);
    expect(await stub.send(reqFor('first'))).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'relayer', code: 'insufficient_funds' } });
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', code: 'insufficient_funds' });
    expect(await codeOf(stub.send(reqFor('second')))).toBe('relayer_halted');
  });

  it('a batch the pool turns away over its fees (the handler priced it early, the base fee jumped): cancelled at once, cause pricing, no halt', async () => {
    for (const [message, code] of [
      ['transaction underpriced', 'underpriced'],
      ['max fee per gas less than block base fee', 'fee_below_base_fee'],
    ] as const) {
      chain = new EvmMock({ chainId: CHAIN }).install();
      const stub = await fresh();
      chain.onSend = rejectBatches(message);
      const sent = await stub.send(reqFor(`priced ${code}`));
      expect([code, sent.broadcast, sent.rejection]).toEqual([code, 'rejected', { cause: 'pricing', code }]);
      expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
      expect([code, await halted(stub)]).toEqual([code, null]);
      // Later too: a batch never accepted, then refused over its fees, gets its cancel; nothing halts.
      chain.onSend = () => 'network';
      await stub.send(reqFor(`later ${code}`));
      chain.onSend = rejectBatches(message);
      await runDurableObjectAlarm(stub);
      await runDurableObjectAlarm(stub);
      expect([code, await halted(stub)]).toEqual([code, null]);
      chain.onSend = undefined;
    }
  });

  it('our own cancel refused over its price retries with a fresh price on the next run: no halt', async () => {
    const stub = await fresh();
    let refuseCancels = true;
    chain.onSend = (tx) => (tx.to === RELAYER.toLowerCase() ? (refuseCancels ? { error: 'transaction underpriced' } : undefined) : { error: 'intrinsic gas too low' });
    await stub.send(request());
    expect(await halted(stub)).toBeNull();
    refuseCancels = false;
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'cancel', 'cancel']);
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(rec.versions[2]!.hash);
    expect(await halted(stub)).toBeNull();
  });

  it('a base-fee jump of more than 12.5%: the cancel is priced from a FRESH base fee (2 × base + tip), not from the refused batch; if that too is overtaken, the next run reprices; no halt', async () => {
    const stub = await fresh();
    await stub.send(request());
    // The pool refuses anything below the current base fee; each refusal of ours is followed by a jump.
    // The base fee jumps as each new transaction reaches the read endpoint (to 0.25 gwei for the batch, 0.6 for its
    // first cancel, priced at 2 × 0.25 + tip).
    let jumps = [GWEI / 4n, (GWEI * 6n) / 10n];
    chain.onSend = (tx, endpoint) => {
      const next = endpoint === 0 ? jumps.shift() : undefined;
      if (next !== undefined) chain.baseFee = next;
      return tx.maxFeePerGas < chain.baseFee ? { error: 'max fee per gas less than block base fee' } : undefined;
    };
    chain.baseFee = GWEI / 8n;
    const sent = await stub.send(reqFor('jumped', { maxFeePerGas: GWEI / 10n }));
    expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'pricing', code: 'fee_below_base_fee' } });
    expect(await halted(stub)).toBeNull();
    expect((await stored(stub)).recs.find((r) => r.nonce === 1)!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect(chain.pooled(RELAYER, 1)).toBeUndefined();
    jumps = [];
    await runDurableObjectAlarm(stub);
    const rec = (await stored(stub)).recs.find((r) => r.nonce === 1)!;
    expect(rec.versions.map((v) => v.kind)).toEqual(['execute', 'cancel', 'cancel']);
    const last = rec.versions.at(-1)!;
    expect(last.kind).toBe('cancel');
    // 2 × 0.6 gwei + tip, capped at the chain's 1 gwei: still above the base fee × 1.125.
    expect(BigInt(last.maxFeePerGas)).toBe(GWEI);
    expect(chain.pooled(RELAYER, 1)?.hash).toBe(last.hash);
    expect(await halted(stub)).toBeNull();
  });

  it('a stale base-fee cache (the base fee rose within 5 s): the send passes our floor, the pool turns it away over its price, its cancel is priced fresh; no halt', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.maxFeePerGas < chain.baseFee ? { error: 'max fee per gas less than block base fee' } : undefined);
    await stub.send(request());
    chain.baseFee = GWEI / 5n;
    advance(EVM_RELAYER_BASE_FEE_TTL_MS - 1);
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'pricing', code: 'fee_below_base_fee' } });
    expect(chain.pooled(RELAYER, 1)).toMatchObject({ to: RELAYER.toLowerCase() });
    expect(await halted(stub)).toBeNull();
  });

  it('fee caps too low for any valid cancel (the base fee above the cap): halt, relayer_cannot_send with code fee_cap_too_low', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.maxFeePerGas < chain.baseFee ? { error: 'max fee per gas less than block base fee' } : undefined);
    await stub.send(request());
    chain.baseFee = 2n * GWEI;
    await stub.send(request());
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 1, code: 'fee_cap_too_low' });
  });

  it('replacement_underpriced on a batch\'s FIRST version is no pricing problem: a foreign transaction from our key holds the nonce: halt', async () => {
    const stub = await fresh();
    await stub.send(request());
    // Someone else, with the relayer's key, has a transaction waiting at our next nonce (fees just under our cancel's).
    chain.admit(foreign(1, GWEI / 9n));
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'relayer', code: 'replacement_underpriced' } });
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 1, code: 'replacement_underpriced' });
  });

  it('a first version\'s replacement refusal the trusted endpoint does not confirm (its pending count == the nonce) is pricing: cancel priced fresh, no halt, noted for staff', async () => {
    const stub = await fresh();
    chain.onSend = rejectBatches('replacement transaction underpriced');
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'pricing', code: 'replacement_underpriced' } });
    expect(await halted(stub)).toBeNull();
    expect(chain.pooled(RELAYER, 0)).toMatchObject({ to: RELAYER.toLowerCase() });
    expect((await evmRelayerStaffStatus(stub)).unconfirmedRefusal).toEqual({ count: 1, lastAt: now, nonce: 0, code: 'replacement_underpriced' });
  });

  it('a first version\'s replacement refusal from the fallback alone (the read endpoint not reached) is pricing: no halt', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.admit(foreign(1, GWEI / 9n));
    forgetVerifiedChains();
    chain.modes[0] = 'down';
    const sent = await stub.send(request());
    expect(sent.rejection).toEqual({ cause: 'pricing', code: 'replacement_underpriced' });
    expect(await halted(stub)).toBeNull();
  });

  it('a refusal only we can cause, heard from the fallback alone (the read endpoint not reached), halts nothing: noted for staff', async () => {
    const stub = await fresh();
    await stub.send(request());
    forgetVerifiedChains();
    chain.modes[0] = 'down';
    chain.onSend = rejectBatches('insufficient funds for gas * price + value');
    const sent = await stub.send(request());
    expect(sent).toMatchObject({ broadcast: 'rejected', rejection: { cause: 'relayer', code: 'insufficient_funds' } });
    expect(await halted(stub)).toBeNull();
    expect((await evmRelayerStaffStatus(stub)).unconfirmedRefusal).toMatchObject({ count: 1, nonce: 1, code: 'insufficient_funds' });
  });

  it('a first version\'s replacement refusal whose confirming read fails is pricing: no halt', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.admit(foreign(1, GWEI / 9n));
    chain.onRead = (method) => (method === 'eth_getTransactionCount' ? Promise.reject(new TypeError('Network connection lost.')) : undefined);
    const sent = await stub.send(request());
    chain.onRead = undefined;
    expect(sent.rejection).toEqual({ cause: 'pricing', code: 'replacement_underpriced' });
    expect(await halted(stub)).toBeNull();
  });

  it('a routine bump that the caps can\'t price higher (an accepted cancel at the cap past the bump interval): the latest is broadcast again, no halt', async () => {
    const stub = await fresh();
    const caps = { maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n };
    await stub.send(request({ ...maxStartingFees(caps), reservedWei: ETH / 100n, execute: { deadline: nowS() + 60n } }));
    advance(61_000);
    await runDurableObjectAlarm(stub);
    for (let i = 0; i < 3; i++) {
      advance(EVM_RELAYER_BUMP_AFTER_MS);
      await runDurableObjectAlarm(stub);
    }
    const rec = (await stored(stub)).recs[0]!;
    expect(rec.accepted).toBe(true);
    const last = rec.versions.at(-1)!;
    // No higher valid cancel exists under the caps: the routine bump stops, the latest goes out again.
    expect(cancelFees({ maxFeePerGas: BigInt(last.maxFeePerGas), maxPriorityFeePerGas: BigInt(last.maxPriorityFeePerGas) }, chain.baseFee, caps)).toBeNull();
    expect(chain.broadcasts.at(-1)!.tx.hash).toBe(last.hash);
    expect(await halted(stub)).toBeNull();
  });

  it('a REQUIRED reprice (our cancel refused over its price) that the caps make impossible halts: fee_cap_too_low', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.to === RELAYER.toLowerCase() ? { error: 'transaction underpriced' } : { error: 'intrinsic gas too low' });
    await stub.send(request());
    expect(await halted(stub)).toBeNull();
    chain.baseFee = 2n * GWEI;
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'relayer_cannot_send', nonce: 0, code: 'fee_cap_too_low' });
  });

  it('replacement_underpriced of a batch\'s own later bump is pricing: no halt', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    await stub.send(request());
    advance(EVM_RELAYER_BUMP_AFTER_MS);
    chain.onSend = (tx) => (tx.to === RELAYER.toLowerCase() ? undefined : { error: 'replacement transaction underpriced' });
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'execute', 'cancel']);
    expect(await halted(stub)).toBeNull();
  });

  it('fees_too_low before anything is stored: a max fee below the latest base fee × 1.125, or no tip at all', async () => {
    const stub = await fresh();
    chain.baseFee = GWEI / 10n;
    const base = chain.baseFee;
    expect(await codeOf(stub.send(request({ maxFeePerGas: (base * 9n) / 8n - 1n, reservedWei: ETH / 100n })))).toBe('fees_too_low');
    expect(await codeOf(stub.send(request({ maxPriorityFeePerGas: 0n })))).toBe('fees_too_low');
    expect(chain.broadcasts).toEqual([]);
    expect((await stored(stub)).recs).toEqual([]);
    expect(await stub.send(request({ maxFeePerGas: (base * 9n) / 8n, reservedWei: ETH / 100n }))).toMatchObject({ broadcast: 'accepted' });
    // The base fee is read at most once every few seconds.
    const priced = () => request({ maxFeePerGas: (base * 9n) / 8n, reservedWei: ETH / 100n });
    await stub.send(priced());
    expect(chain.calls.filter((c) => c.method === 'eth_getBlockByNumber').length).toBe(1);
    advance(EVM_RELAYER_BASE_FEE_TTL_MS);
    await stub.send(priced());
    expect(chain.calls.filter((c) => c.method === 'eth_getBlockByNumber').length).toBe(2);
    expect(evmRelayerError(new Error('evm_relayer:fees_too_low'))).toEqual({ code: 'fees_too_low', reason: null });
  });

  it('probe: refused at send over its fees, then the original lands anyway: outcome execute with its own hash', async () => {
    const stub = await fresh();
    chain.onSend = rejectBatches('transaction underpriced');
    const a = await stub.send(request());
    chain.onSend = undefined;
    chain.drop(RELAYER, 0);
    chain.admit(decodeRawTx(a.raw!));
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'mined', outcome: 'execute', minedHash: a.transactionHash });
    expect(await halted(stub)).toBeNull();
  });

  it('probe L3: accounts whose type-4 batches no pool takes fill the unmined cap only until their deadline; nothing halts', async () => {
    const stub = await fresh();
    chain.onSend = (tx) => (tx.type === 4 ? { error: 'authority already reserved' } : undefined);
    for (let i = 0; i < EVM_RELAYER_MAX_UNMINED; i++) {
      const u = userKeyFor(`attacker ${i}`);
      await stub.send(request({ authorization: authorization({}, u.key), execute: { account: u.addr, deadline: nowS() + 120n } }, u.key));
    }
    expect(await codeOf(stub.send(reqFor('victim')))).toBe('relayer_busy');
    advance(121_000);
    for (let i = 0; i < 3; i++) await runDurableObjectAlarm(stub);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.send(reqFor('victim'))).toMatchObject({ broadcast: 'accepted' });
    expect(await halted(stub)).toBeNull();
  });
});

describe('review M1: one unmined batch per account', () => {
  it('a second batch from an account with one unmined is relayer_busy:account; other accounts go on; once mined the account may send again', async () => {
    const stub = await fresh();
    await stub.send(request({}, USER_KEY));
    expect(await codeOf(stub.send(request({}, USER_KEY)))).toBe('relayer_busy:account');
    expect((await stub.send(reqFor('someone else'))).relayerNonce).toBe(1);
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    await runDurableObjectAlarm(stub);
    expect((await stub.send(request({}, USER_KEY))).relayerNonce).toBe(2);
  });

  it('the second action right after the first mined (no run since): one on-demand check sees it, marks it seen, lets the second through', async () => {
    const stub = await fresh();
    const first = await stub.send(request({}, USER_KEY));
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    const reads = chain.calls.length;
    expect(await stub.send(request({}, USER_KEY))).toMatchObject({ relayerNonce: 1, broadcast: 'accepted' });
    expect((await stored(stub)).recs.find((r) => r.nonce === 0)!.seen).toEqual({ hash: first.transactionHash, block: chain.receiptBlock(first.transactionHash) });
    // Bounded: the latest count and at most one receipt per version, on top of the send's own reads.
    expect(chain.calls.slice(reads).filter((c) => c.method === 'eth_getTransactionReceipt').length).toBe(1);
  });

  it('the first still pending: refused relayer_busy:account (the check finds no receipt)', async () => {
    const stub = await fresh();
    await stub.send(request({}, USER_KEY));
    expect(await codeOf(stub.send(request({}, USER_KEY)))).toBe('relayer_busy:account');
    expect((await stored(stub)).recs).toHaveLength(1);
  });

  it('a receipt that exists while the latest count is not past the nonce is not enough: refused', async () => {
    const stub = await fresh();
    const first = await stub.send(request({}, USER_KEY));
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    intercept((m, p) => (m === 'eth_getTransactionCount' && p[1] === 'latest' ? '0x0' : undefined));
    expect(await codeOf(stub.send(request({}, USER_KEY)))).toBe('relayer_busy:account');
    expect((await stored(stub)).recs.find((r) => r.nonce === 0)!.seen).toBeNull();
    void first;
  });

  it('the check\'s receipt read fails: refused relayer_busy:account, nothing happens to the first batch', async () => {
    const stub = await fresh();
    const first = await stub.send(request({}, USER_KEY));
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    chain.receiptFailures = 1;
    expect(await codeOf(stub.send(request({}, USER_KEY)))).toBe('relayer_busy:account');
    chain.addBlocks(5);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(first.digest)).toMatchObject({ state: 'mined', outcome: 'execute' });
    expect(await halted(stub)).toBeNull();
  });

  it('a reorg after the second was let through: the first goes back to unmined and out again; relayer nonce order keeps the account\'s two batches in order; both mine', async () => {
    const stub = await fresh();
    const first = await stub.send(request({}, USER_KEY));
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    const second = await stub.send(request({}, USER_KEY));
    expect(second.relayerNonce).toBe(1);
    chain.unmine(RELAYER, 1, { drop: true });
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs.find((r) => r.nonce === 0)!.seen).toBeNull();
    expect(chain.pooledAll(RELAYER).map((t) => t.hash)).toEqual([first.transactionHash, second.transactionHash]);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(first.digest)).toMatchObject({ state: 'mined', minedHash: first.transactionHash });
    expect(await stub.lookup(second.digest)).toMatchObject({ state: 'mined', minedHash: second.transactionHash });
    expect(await halted(stub)).toBeNull();
  });
});

describe('review M2/M3: a nonce is never freed', () => {
  it('probe L5: staffClose(never_sent) is gone; staffCancel signs a cancel at the SAME nonce, keeps the old versions; if the old raw lands, it resolves as execute', async () => {
    const stub = await fresh();
    chain.onSend = () => 'network';
    const a = await stub.send(request({ execute: { deadline: nowS() + 600n } }));
    expect(await codeOf(stub.staffClose(EVM_RELAYER_STAFF_GUARD, WHO, 0, 'never_sent' as never, 'n'))).toBe('invalid_request');
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'free it')).toMatchObject({ done: true });
    expect((await stored(stub)).recs[0]!.versions.map((v) => v.kind)).toEqual(['execute', 'cancel']);
    expect((await stored(stub)).meta!.nextNonce).toBe(1);
    chain.onSend = undefined;
    const b = await stub.send(reqFor('second user'));
    expect(b.relayerNonce).toBe(1);
    chain.drop(RELAYER, 0);
    chain.admit(decodeRawTx(a.raw!));
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'mined', outcome: 'execute', minedHash: a.transactionHash });
    expect(await stub.lookup(b.digest)).toMatchObject({ state: 'mined', outcome: 'execute' });
    expect(await halted(stub)).toBeNull();
  });

  it('staffCancel refuses: no record, a key that can’t sign, a nonce mined at head, a receipt of its own, no valid replacement left', async () => {
    const stub = await fresh();
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'n')).toMatchObject({ refused: 'no_state' });
    await stub.send(request());
    expect(await evmRelayerStaffCancel(stub, WHO, 5, 'n')).toMatchObject({ refused: 'no_record' });
    await configure(stub, overlay({ EVM_RELAY_KEYS: undefined }));
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'n')).toMatchObject({ refused: 'key_mismatch' });
    await configure(stub);
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'n')).toMatchObject({ refused: 'nonce_mined' });
    // Started at the fee caps' edge: a few cancels later the caps leave no valid one.
    await stub.send(reqFor('b', { maxFeePerGas: maxStartingFees({ maxFeePerGasWei: GWEI, maxPriorityFeePerGasWei: GWEI / 100n }).maxFeePerGas, reservedWei: ETH / 100n }));
    for (let i = 0; i < 3; i++) await evmRelayerStaffCancel(stub, WHO, 1, 'again');
    expect(await evmRelayerStaffCancel(stub, WHO, 1, 'n')).toMatchObject({ refused: 'fee_cap_too_low' });
    // Started low: 8 versions come first.
    await stub.send(reqFor('c', { maxFeePerGas: 1_000_000n, maxPriorityFeePerGas: 1_000n }));
    for (let i = 0; i < 7; i++) await evmRelayerStaffCancel(stub, WHO, 2, 'again');
    expect((await stored(stub)).recs.find((r) => r.nonce === 2)!.versions).toHaveLength(EVM_RELAYER_MAX_VERSIONS);
    expect(await evmRelayerStaffCancel(stub, WHO, 2, 'n')).toMatchObject({ refused: 'no_valid_replacement' });
  });

  it('staffCancel on a staff filler: a bumped self-transfer at the same nonce, earlier versions kept', async () => {
    chain.admit(foreign(0));
    const stub = await fresh();
    await stub.send(request());
    chain.drop(RELAYER, 0);
    expect(await evmRelayerStaffFill(stub, WHO, 0, 'fill')).toMatchObject({ done: true });
    const before = (await stored(stub)).recs.find((r) => r.nonce === 0)!;
    expect(await evmRelayerStaffCancel(stub, WHO, 0, 'bump the filler')).toMatchObject({ done: true });
    const after = (await stored(stub)).recs.find((r) => r.nonce === 0)!;
    expect(after.digest).toBeNull();
    expect(after.versions.map((v) => v.kind)).toEqual(['cancel', 'cancel']);
    expect(after.versions[0]!.hash).toBe(before.versions[0]!.hash);
    expect(BigInt(after.versions[1]!.maxFeePerGas)).toBeGreaterThan(BigInt(before.versions[0]!.maxFeePerGas));
    expect(chain.pooled(RELAYER, 0)?.hash).toBe(after.versions[1]!.hash);
  });

  it('probe L6: staffAdoptNonce never lowers nextNonce', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    intercept((m) => (m === 'eth_getTransactionCount' ? '0x0' : undefined));
    expect(await evmRelayerStaffAdoptNonce(stub, WHO, 0, 'n')).toMatchObject({ refused: 'below_next_nonce' });
    expect((await stored(stub)).meta!.nextNonce).toBe(1);
  });
});

describe('review L1, L3 and storage', () => {
  it('probe L1: a receipt alone (the confirmed count not yet past the nonce) never finalizes', async () => {
    const stub = await fresh();
    const a = await stub.send(request());
    chain.mine(RELAYER, Number.POSITIVE_INFINITY, { after: 0 });
    intercept((m, p) => (m === 'eth_getTransactionReceipt' && (p[0] as string) === a.transactionHash ? { transactionHash: a.transactionHash, status: '0x1', blockNumber: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] } : undefined));
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'pending' });
    chain.addBlocks(chain.safeDepth);
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'mined' });
  });

  it('probe L1b (documented limit): a read endpoint lying about both the receipt and the counts finalizes a transaction that never landed; the honest counts later halt it (nonce_gap)', async () => {
    const stub = await fresh();
    const a = await stub.send(request());
    chain.drop(RELAYER, 0);
    let lie = true;
    intercept((m, p) => (!lie ? undefined : m === 'eth_getTransactionReceipt' ? { transactionHash: p[0], status: '0x1', blockNumber: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x1', logs: [] } : m === 'eth_getTransactionCount' ? '0x1' : undefined));
    await runDurableObjectAlarm(stub);
    expect(await stub.lookup(a.digest)).toMatchObject({ state: 'mined' });
    lie = false;
    await stub.send(reqFor('next'));
    await runDurableObjectAlarm(stub);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'nonce_gap', nonce: 0 });
  });

  it('with no records the alarm still checks the chain hourly: foreign transactions halt before the next send', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toEqual([]);
    expect((await stored(stub)).alarm).toBe(now + EVM_RELAYER_IDLE_CHECK_MS);
    chain.admit(foreign(1));
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'foreign_transactions', nonce: 1 });
  });

  it('with no records, a nonce_gap seen on two hourly runs in a row halts', async () => {
    const stub = await fresh();
    await stub.send(request());
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    expect((await stored(stub)).recs).toEqual([]);
    intercept((m, p) => (m === 'eth_getTransactionCount' && p[1] === 'pending' ? '0x0' : undefined));
    advance(EVM_RELAYER_IDLE_CHECK_MS);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toBeNull();
    expect((await stored(stub)).meta!.gapSeen).toBe(0);
    advance(EVM_RELAYER_IDLE_CHECK_MS);
    await runDurableObjectAlarm(stub);
    expect(await halted(stub)).toMatchObject({ reason: 'nonce_gap', nonce: 0 });
  });

  it('a final batch keeps only hashes, no raw transaction; its replay answers raw null', async () => {
    const stub = await fresh();
    const req = request();
    await stub.send(req);
    chain.mine(RELAYER);
    await runDurableObjectAlarm(stub);
    const dig = await runInDurableObject(stub, (_i, state) => state.storage.kv.get<Record<string, unknown>>(`dig:${digestOf(req)}`));
    expect(dig).not.toHaveProperty('raw');
    expect(await stub.send(req)).toMatchObject({ replay: true, raw: null, broadcast: 'accepted' });
  });
});

describe('review M4: CPU-relevant counts', () => {
  it('derives the relayer address once per isolate; each send and run logs its signatures, recoveries, fetches and key derivations', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const stub = await fresh();
    await stub.send(request());
    await stub.send(reqFor('other', { authorization: authorization({}, userKeyFor('other').key) }));
    await runDurableObjectAlarm(stub);
    const ops = lines.filter((l) => l.includes('"evmOps"')).map((l) => (JSON.parse(l) as { event: string; evmOps: Record<string, number> }));
    expect(ops.map((o) => o.event)).toEqual(['evm_relay_sent', 'evm_relay_sent', 'evm_relayer_run']);
    expect(ops[1]!.evmOps).toMatchObject({ signatures: 1, recoveries: 2, keyDerivations: 0 });
    expect(ops[1]!.evmOps.fetches).toBeGreaterThan(0);
  });
});
