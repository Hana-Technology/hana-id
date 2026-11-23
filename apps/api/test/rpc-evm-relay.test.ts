// AdminRpc's EVM relayer view and staff tools (D843; the relayer is D851): `systemStatus.evmRelay`, `evmRelayDetail`
// and `evmRelayAct`, against a fake relayer namespace (every state and halt reason, every tool, refusals and failures)
// and a fake chain (the relayer's balance, the account helper's code). An env without `evm.sponsor` reads nothing and
// answers no `evmRelay`. One test drives the real object (a fresh one: `no_state`) through the same path.
import { SPONSOR_DELEGATES } from '@hana-id/core/evm-sponsor';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { sha256 } from '@noble/hashes/sha256';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import artifact from '../../../contracts/evm-delegate/artifacts/HanaDelegateExecutor.json';
import type { Env } from '../src/env.ts';
import type { EvmRelayerStaffEntry, EvmRelayerStaffResult, EvmRelayerStaffStatus } from '../src/evm-relayer.ts';
import { evmRelayerName } from '../src/evm-relayer.ts';
import { evmRelayerStaffAct, evmRelayerStaffTiming, forgetHelperCodes } from '../src/evm-relayer-staff.ts';
import { forgetVerifiedChains } from '../src/evm/sponsor-chain.ts';
import { checksumEvmAddress, evmSponsorVar } from '../src/evm/sponsor-config.ts';
import { AdminRpc } from '../src/rpc/admin.ts';
import { addressOf } from './evm-mock.ts';
import { governanceViews, hana, member, orgApp, ownerChain, system } from './rpc-helpers.ts';

type Hex = `0x${string}`;
const CHAIN = 31337;
const RPC = 'https://evm-admin-primary.test.invalid';
const DELEGATE = SPONSOR_DELEGATES[CHAIN]!.address;
const PINNED = SPONSOR_DELEGATES[CHAIN]!.runtimeCodeHash;
const ETH = 10n ** 18n;
const NOW = Date.now();
const hex = (b: Uint8Array): Hex => `0x${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
/** A test-only key, derived at run time (never a literal). */
const KEY = sha256(new TextEncoder().encode('hana-id rpc-evm-relay test relayer key'));
const RELAYER = checksumEvmAddress(addressOf(secp256k1.getPublicKey(KEY, false)));
const OTHER_KEY = sha256(new TextEncoder().encode('hana-id rpc-evm-relay another key'));

/** The delegate's runtime code as deployed: the artifact's, with the implementation's address in its immutables. */
function deployedCode(): Hex {
  const a = artifact as unknown as { deployedBytecode: string; immutableReferences: { start: number; length: number }[]; create2: { address: string } };
  const code = Uint8Array.from(Buffer.from(a.deployedBytecode.slice(2), 'hex'));
  const word = Uint8Array.from(Buffer.from(a.create2.address.slice(2).toLowerCase().padStart(64, '0'), 'hex'));
  for (const r of a.immutableReferences) code.set(word, r.start);
  return hex(code);
}
const CODE = deployedCode();

const sponsorVar = (over: Record<string, unknown> = {}) =>
  evmSponsorVar({
    relayerAddress: RELAYER,
    chains: {
      [CHAIN]: {
        rpc: RPC,
        delegate: DELEGATE,
        opStack: false,
        maxGasPerTx: 300_000,
        maxFeePerGasGwei: 1,
        maxPriorityFeePerGasGwei: 0.01,
        maxCallsPerBatch: 4,
        deadlineMaxS: 300,
        minGas: 100_000,
        dailyBudgetEth: 0.02,
        appDailyBudgetEth: 0.01,
        lowBalanceEth: 0.05,
        perUserPerDay: 30,
        perAppPerDay: 2000,
        sendsPerDay: 5000,
        sendsPerMinute: 60,
        ...over,
      } as never,
    },
    apps: {},
  });

// ---- the fake relayer ----

const entry = (seq: number, over: Partial<EvmRelayerStaffEntry> = {}): EvmRelayerStaffEntry => ({ seq, at: NOW - seq * 60_000, who: 'staff@hana.example', action: 'resume', nonce: null, verdict: null, note: 'Topped up from the faucet', done: true, refused: null, ...over });
const record = (nonce: number, over: Record<string, unknown> = {}) => ({
  nonce,
  digest: `0x${'d'.repeat(63)}${nonce % 10}` as Hex,
  account: '0x1111111111111111111111111111111111111111' as Hex,
  deadline: Math.floor(NOW / 1000) + 120,
  reservedWei: '1000',
  day: Math.floor(NOW / 86_400_000),
  worstWei: '1000',
  gas: '200000',
  sentAt: NOW - 90_000,
  signedAt: NOW - 90_000,
  versions: [{ hash: `0x${'a'.repeat(63)}${nonce % 10}` as Hex, kind: 'execute' as const, maxFeePerGas: '2', maxPriorityFeePerGas: '1' }],
  accepted: true,
  batchRejected: null,
  cannotSend: null,
  seen: null,
  ...over,
});
function staffStatus(over: Partial<EvmRelayerStaffStatus> = {}): EvmRelayerStaffStatus {
  return {
    address: RELAYER as Hex,
    unmined: 0,
    awaitingConfirmation: 0,
    oldestUnminedMs: null,
    oldestUnacceptedMs: null,
    nextNonce: 7,
    halted: null,
    chainId: CHAIN,
    day: Math.floor(NOW / 86_400_000),
    dayWei: 1_200_000_000_000_000n,
    gapSeen: null,
    unconfirmedRefusal: null,
    records: [],
    staffLog: [],
    ...over,
  } as EvmRelayerStaffStatus;
}

interface Fake {
  ns: DurableObjectNamespace;
  calls: { method: string; args: unknown[] }[];
  names: string[];
}
type Tool = 'staffResume' | 'staffCancel' | 'staffClose' | 'staffFill' | 'staffAdoptNonce';
function fakeRelayer(status: EvmRelayerStaffStatus | (() => EvmRelayerStaffStatus | Promise<EvmRelayerStaffStatus>), tools: Partial<Record<Tool, (...a: unknown[]) => Promise<EvmRelayerStaffResult>>> = {}): Fake {
  const calls: Fake['calls'] = [];
  const names: string[] = [];
  const read = async () => (typeof status === 'function' ? status() : status);
  const tool = (method: Tool) => async (...args: unknown[]) => {
    calls.push({ method, args });
    const t = tools[method];
    if (!t) throw new Error(`unexpected ${method}`);
    return t(...args);
  };
  const stub = {
    staffStatus: async (...args: unknown[]) => {
      calls.push({ method: 'staffStatus', args });
      return read();
    },
    staffResume: tool('staffResume'),
    staffCancel: tool('staffCancel'),
    staffClose: tool('staffClose'),
    staffFill: tool('staffFill'),
    staffAdoptNonce: tool('staffAdoptNonce'),
  };
  const ns = {
    idFromName: (n: string) => {
      names.push(n);
      return n;
    },
    get: () => stub,
  } as unknown as DurableObjectNamespace;
  return { ns, calls, names };
}

// ---- the fake chain ----

interface ChainFake {
  balance: bigint | 'down';
  code: Hex | 'down';
  /** The relayer's transaction counts (latest, pending), or down. */
  count: { latest: number; pending: number } | 'down';
  /** Never answer the balance (a hanging endpoint). */
  hang?: boolean;
  calls: string[];
}
function fakeChain(c: Partial<ChainFake> = {}): ChainFake {
  const chain: ChainFake = { balance: 80_000_000_000_000_000n, code: CODE, count: { latest: 7, pending: 7 }, calls: [], ...c };
  const prev = vi.isMockFunction(globalThis.fetch) ? (globalThis.fetch as unknown as { getMockImplementation(): typeof fetch | undefined }).getMockImplementation() : undefined;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url !== RPC && url !== `${RPC}/`) {
      if (prev) return prev(input, init);
      throw new Error(`unexpected fetch ${url}`);
    }
    const body = JSON.parse(String(init?.body)) as { id: number; method: string };
    chain.calls.push(body.method);
    const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: body.id, result });
    if (body.method === 'eth_chainId') return reply(`0x${CHAIN.toString(16)}`);
    if (body.method === 'eth_getBalance') {
      if (chain.hang) return new Promise<Response>(() => {});
      if (chain.balance === 'down') throw new TypeError('Network connection lost.');
      return reply(`0x${chain.balance.toString(16)}`);
    }
    if (body.method === 'eth_getCode') {
      if (chain.code === 'down') throw new TypeError('Network connection lost.');
      return reply(chain.code);
    }
    if (body.method === 'eth_getTransactionCount') {
      if (chain.count === 'down') throw new TypeError('Network connection lost.');
      const tag = (body as unknown as { params: [string, string] }).params[1];
      return reply(`0x${(tag === 'pending' ? chain.count.pending : chain.count.latest).toString(16)}`);
    }
    return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'no such method' } });
  });
  return chain;
}

const sponsorEnv = (relayer: Fake | null, over: Partial<Env> = {}): Env =>
  ({ ...env, ENV_NAME: 'local-evm-test', NETWORK: 'testnet', EVM_SPONSOR: sponsorVar(), EVM_RELAY_KEYS: JSON.stringify([hex(KEY)]), EVM_RELAYER: relayer?.ns, ...over }) as unknown as Env;
const rpcOf = (e: Env) => new AdminRpc(createExecutionContext(), e);

beforeEach(() => {
  forgetVerifiedChains();
  forgetHelperCodes();
  evmRelayerStaffTiming.overviewMs = 6_000;
  evmRelayerStaffTiming.relayerMs = 5_000;
  evmRelayerStaffTiming.chainMs = 5_000;
  evmRelayerStaffTiming.budgetMs = 2_500;
});
afterEach(() => vi.restoreAllMocks());

type Ok<T> = Extract<T, { ok: true }>;
async function status(e: Env) {
  const r = await rpcOf(e).systemStatus(hana());
  if (!r.ok) throw new Error(`systemStatus: ${r.code}`);
  return r as Ok<typeof r>;
}

describe('AdminRpc.systemStatus evmRelay', () => {
  it('an env without evm.sponsor answers no evmRelay and reads nothing for it: no relayer, no chain call', async () => {
    governanceViews(ownerChain());
    const chain = fakeChain();
    const relayer = fakeRelayer(staffStatus());
    const r = await status(sponsorEnv(relayer, { EVM_SPONSOR: undefined }));
    expect(r.evmRelay).toEqual({ state: 'absent', chains: [] });
    expect(relayer.calls).toEqual([]);
    expect(relayer.names).toEqual([]);
    expect(chain.calls).toEqual([]);
    // The test Worker's own env has no block either.
    expect((await status({ ...env, EVM_RELAYER: relayer.ns } as unknown as Env)).evmRelay).toEqual({ state: 'absent', chains: [] });
    expect(relayer.calls).toEqual([]);
  });

  it('D890: the relayer’s automatic restart and an automatic staff entry come through; an object older than D890 gives none', async () => {
    governanceViews(ownerChain());
    fakeChain();
    const auto = { limit: 3, today: 1, recent: [NOW - 4_000], pause: { blocked: null, restartWei: '50021000000000000', resumeWei: '21000000000000', check: { at: NOW - 5_000, blocked: 'balance_short', balanceWei: '1000' } } };
    const restarted = { ...entry(1), who: 'relayer (automatic)', auto: true as const };
    const relayer = fakeRelayer({ ...staffStatus({ staffLog: [restarted] }), autoRestart: auto } as EvmRelayerStaffStatus);
    const v = (await status(sponsorEnv(relayer))).evmRelay!.chains[0]!.relayer as { autoRestart?: unknown; staffLog: { auto?: boolean }[] };
    expect(v.autoRestart).toEqual(auto);
    expect(v.staffLog[0]).toMatchObject({ who: 'relayer (automatic)', auto: true });
    const old = (await status(sponsorEnv(fakeRelayer(staffStatus())))).evmRelay!.chains[0]!.relayer as { autoRestart?: unknown };
    expect(old.autoRestart).toBeUndefined();
  });

  it('a block the API refuses is bad_config, and nothing is read', async () => {
    governanceViews(ownerChain());
    const chain = fakeChain();
    const relayer = fakeRelayer(staffStatus());
    for (const over of [{ EVM_SPONSOR: '{"not":"valid"}' }, { NETWORK: 'mainnet' }]) {
      const r = await status(sponsorEnv(relayer, over));
      expect(r.evmRelay).toEqual({ state: 'bad_config', chains: [] });
    }
    expect(relayer.calls).toEqual([]);
    expect(chain.calls).toEqual([]);
  });

  it('running: the address, balance, limits, today’s spend, waiting counts, the helper’s code against the pin, the last 5 staff actions', async () => {
    governanceViews(ownerChain());
    const chain = fakeChain();
    const log = Array.from({ length: 7 }, (_, i) => entry(7 - i, i === 0 ? { action: 'cancel', nonce: 6, done: false, refused: 'nonce_mined' } : {}));
    const relayer = fakeRelayer(staffStatus({ unmined: 2, awaitingConfirmation: 1, oldestUnminedMs: 95_000, oldestUnacceptedMs: 20_000, unconfirmedRefusal: { count: 3, lastAt: NOW - 600_000, nonce: 5, code: 'insufficient_funds' }, staffLog: log }));
    const r = await status(sponsorEnv(relayer));
    expect(r.evmRelay?.state).toBe('on');
    const c = r.evmRelay!.chains[0]!;
    expect(c).toMatchObject({
      chainId: CHAIN,
      relayerAddress: RELAYER,
      key: 'ok',
      // A local* env without the keyed secret reads the manifest's rpc (outside local* the API turns sponsorship off: `missing`).
      readEndpoint: 'public',
      lowBalanceWei: (5n * ETH / 100n).toString(),
      dailyBudgetWei: (2n * ETH / 100n).toString(),
      // 300 000 gas × 1 gwei (not doubled: the local chain isn't an OP Stack chain).
      oneSendWorstWei: (300_000n * 10n ** 9n).toString(),
      balance: { ok: true, wei: '80000000000000000' },
      helper: { address: DELEGATE, pinnedCodeHash: PINNED, ok: true, codeHash: PINNED, matches: true },
      relayer: {
        ok: true,
        started: true,
        signerAddress: RELAYER,
        halted: null,
        waiting: 2,
        awaitingConfirmation: 1,
        oldestWaitingMs: 95_000,
        oldestNotTakenMs: 20_000,
        nextSlot: 7,
        spentTodayWei: '1200000000000000',
        unconfirmedRefusals: { count: 3, lastAt: NOW - 600_000, slot: 5, code: 'insufficient_funds' },
        lastStaffSeq: 7,
      },
    });
    if (!c.relayer.ok) throw new Error('relayer');
    // Nothing reserved on the env's day budget yet in this test's clock window.
    expect(c.budget).toEqual({ ok: true, spentWei: '0' });
    expect(c.relayer.staffLog.map((e) => e.seq)).toEqual([7, 6, 5, 4, 3]);
    expect(c.relayer.staffLog[0]).toEqual({ seq: 7, at: NOW - 420_000, who: 'staff@hana.example', tool: 'cancel', slot: 6, note: 'Topped up from the faucet', done: false, refused: 'nonce_mined' });
    // One object, by its name; the guard passed; two chain reads after the endpoint's chain check (the two reads run
    // together, so a cold isolate may check it twice: at most 4 fetches).
    expect(relayer.names).toEqual([evmRelayerName(CHAIN)]);
    expect(relayer.calls).toEqual([{ method: 'staffStatus', args: ['hana-id/evm-relayer/staff/v1'] }]);
    expect(chain.calls.filter((m) => m !== 'eth_chainId').sort()).toEqual(['eth_getBalance', 'eth_getCode']);
    expect(chain.calls.length).toBeLessThanOrEqual(4);
    // No record list, no account, no raw transaction in the status answer.
    expect(JSON.stringify(c)).not.toMatch(/records|account|raw/u);
  });

  it('every halt reason comes through with its slot and code; an earlier day’s spend is not today’s', async () => {
    governanceViews(ownerChain());
    fakeChain();
    const reasons = [
      { reason: 'nonce_consumed_elsewhere', nonce: 4 },
      { reason: 'nonce_gap', nonce: 9 },
      { reason: 'foreign_transactions' },
      { reason: 'relayer_cannot_send', nonce: 3, code: 'insufficient_funds' },
      { reason: 'relayer_cannot_send', nonce: 3, code: 'fee_cap_too_low' },
      { reason: 'relayer_cannot_send', nonce: 3, code: 'replacement_underpriced' },
      { reason: 'stuck_past_deadline', nonce: 2 },
      { reason: 'key_mismatch' },
      { reason: 'storage_inconsistent' },
    ] as const;
    for (const h of reasons) {
      const relayer = fakeRelayer(staffStatus({ halted: { ...h, since: NOW - 300_000 } as never, day: Math.floor(NOW / 86_400_000) - 1 }));
      const c = (await status(sponsorEnv(relayer))).evmRelay!.chains[0]!;
      expect(c.relayer, h.reason).toMatchObject({ ok: true, halted: { reason: h.reason, since: NOW - 300_000, slot: 'nonce' in h ? h.nonce : null, code: 'code' in h ? h.code : null, leakSeen: false }, spentTodayWei: '0' });
    }
  });

  it('a fresh relayer (never sent) is not started; the key missing or wrong is said, never shown', async () => {
    governanceViews(ownerChain());
    fakeChain();
    const fresh = fakeRelayer(staffStatus({ chainId: null, nextNonce: null, day: null, dayWei: 0n }));
    expect((await status(sponsorEnv(fresh))).evmRelay!.chains[0]!.relayer).toMatchObject({ ok: true, started: false, nextSlot: null, spentTodayWei: '0', lastStaffSeq: 0 });
    expect((await status(sponsorEnv(fresh, { EVM_RELAY_KEYS: undefined }))).evmRelay!.chains[0]!.key).toBe('missing');
    expect((await status(sponsorEnv(fresh, { EVM_RELAY_KEYS: JSON.stringify([hex(OTHER_KEY)]) }))).evmRelay!.chains[0]!.key).toBe('wrong');
    expect((await status(sponsorEnv(fresh, { EVM_RELAY_KEYS: '["not a key"]' }))).evmRelay!.chains[0]!.key).toBe('wrong');
    const text = JSON.stringify(await status(sponsorEnv(fresh)));
    expect(text).not.toContain(hex(KEY).slice(2));
    expect(text).not.toContain(RPC);
  });

  it('the helper with other code, or none, is said; each part fails on its own (balance, code, the relayer, its timeout)', async () => {
    governanceViews(ownerChain());
    let chain = fakeChain({ code: '0x6000' });
    let c = (await status(sponsorEnv(fakeRelayer(staffStatus())))).evmRelay!.chains[0]!;
    expect(c.helper).toEqual({ address: DELEGATE, pinnedCodeHash: PINNED, ok: true, codeHash: hex(keccak_256(Uint8Array.of(0x60, 0x00))), matches: false });
    vi.restoreAllMocks();
    forgetHelperCodes();
    governanceViews(ownerChain());
    chain = fakeChain({ code: '0x' });
    c = (await status(sponsorEnv(fakeRelayer(staffStatus())))).evmRelay!.chains[0]!;
    expect(c.helper).toMatchObject({ ok: true, codeHash: null, matches: false });
    vi.restoreAllMocks();
    forgetHelperCodes();
    governanceViews(ownerChain());
    chain = fakeChain({ balance: 'down', code: 'down' });
    const broken = fakeRelayer(() => Promise.reject(new Error('object reset')));
    const r = await status(sponsorEnv(broken));
    c = r.evmRelay!.chains[0]!;
    expect(c.balance).toEqual({ ok: false, code: 'rpc_unavailable' });
    expect(c.helper).toMatchObject({ ok: false, code: 'rpc_unavailable' });
    expect(c.relayer).toEqual({ ok: false, code: 'relayer_unavailable' });
    // The rest of the answer stands.
    expect(r.hotDb.ok).toBe(true);
    expect(chain.calls).toContain('eth_getBalance');
    evmRelayerStaffTiming.relayerMs = 20;
    const slow = fakeRelayer(() => new Promise(() => {}));
    expect((await status(sponsorEnv(slow))).evmRelay!.chains[0]!.relayer).toEqual({ ok: false, code: 'relayer_timeout' });
    expect((await status(sponsorEnv(null))).evmRelay!.chains[0]!.relayer).toEqual({ ok: false, code: 'relayer_unbound' });
  });

  it('today’s spend is the handlers’ own count on the env’s day budget (the budget alert’s), read only; its failure is said', async () => {
    governanceViews(ownerChain());
    fakeChain();
    const chainId = CHAIN;
    // Reserve on the env's budget exactly as the send handler does (sponsor.ts reserveBudgets).
    const lim = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`evm-sponsor:budget:${chainId}`)) as unknown as { spend(n: string, w: number, max: string, amount: string, now?: number): Promise<{ ok: boolean }> };
    const before = (await status(sponsorEnv(fakeRelayer(staffStatus())))).evmRelay!.chains[0]!.budget;
    expect(before.ok).toBe(true);
    const base = before.ok ? BigInt(before.spentWei) : 0n;
    expect(await lim.spend(`evm-sponsor:${chainId}:wei`, 86_400_000, (2n * ETH / 100n).toString(), '4000000000000000')).toMatchObject({ ok: true });
    expect((await status(sponsorEnv(fakeRelayer(staffStatus())))).evmRelay!.chains[0]!.budget).toEqual({ ok: true, spentWei: (base + 4_000_000_000_000_000n).toString() });
    evmRelayerStaffTiming.budgetMs = 1;
    const slow = { ...env.RATE_LIMITER, idFromName: () => ({}), get: () => ({ spent: () => new Promise(() => {}) }) } as unknown as Env['RATE_LIMITER'];
    expect((await status(sponsorEnv(fakeRelayer(staffStatus()), { RATE_LIMITER: slow }))).evmRelay!.chains[0]!.budget).toEqual({ ok: false, code: 'rate_limiter_unavailable' });
  });

  it('only this part degrades: reads that hang give state timeout, the rest of the status stands; the helper’s code is read once per 10 minutes', async () => {
    governanceViews(ownerChain());
    const chain = fakeChain({ hang: true });
    evmRelayerStaffTiming.overviewMs = 50;
    const r = await status(sponsorEnv(fakeRelayer(staffStatus())));
    expect(r.evmRelay).toEqual({ state: 'timeout', chains: [] });
    expect(r.hotDb.ok).toBe(true);
    evmRelayerStaffTiming.overviewMs = 6_000;
    chain.hang = false;
    await status(sponsorEnv(fakeRelayer(staffStatus())));
    const codeReads = chain.calls.filter((m) => m === 'eth_getCode').length;
    await status(sponsorEnv(fakeRelayer(staffStatus())));
    expect(chain.calls.filter((m) => m === 'eth_getCode').length).toBe(codeReads);
  });
});

describe('AdminRpc.evmRelayDetail', () => {
  it('every transaction the relayer holds: slot, kind, where it stands, its copies, the app when recorded; no account', async () => {
    fakeChain();
    const records = [
      record(8, { seen: { hash: `0x${'a'.repeat(63)}8`, block: 90 } }),
      record(6, { accepted: false, batchRejected: 'gas_limit', versions: [{ hash: `0x${'b'.repeat(64)}`, kind: 'execute', maxFeePerGas: '2', maxPriorityFeePerGas: '1' }, { hash: `0x${'c'.repeat(64)}`, kind: 'cancel', maxFeePerGas: '3', maxPriorityFeePerGas: '2' }] }),
      record(7, { digest: null, account: null }),
    ];
    const relayer = fakeRelayer(staffStatus({ unmined: 2, awaitingConfirmation: 1, records: records as never, staffLog: Array.from({ length: 50 }, (_, i) => entry(50 - i)) }));
    const r = await rpcOf(sponsorEnv(relayer)).evmRelayDetail({ ...hana(), chainId: CHAIN });
    if (!r.ok) throw new Error(r.code);
    const d = (r as unknown as { detail: import('@hana-id/console-core').EvmRelayDetail }).detail;
    // No send record names these digests: the app is unknown, and said so.
    expect(d.apps).toBe('recorded');
    expect(d.records.map((x) => x.app)).toEqual([null, null, null]);
    expect(d.records.map((x) => [x.slot, x.kind, x.onChain, x.taken, x.cancelling, x.refusedCode, x.copies.length])).toEqual([
      [6, 'action', false, false, true, 'gas_limit', 2],
      [7, 'filler', false, true, false, null, 1],
      [8, 'action', true, true, false, null, 1],
    ]);
    expect(d.records[0]!.copies).toEqual([
      { hash: `0x${'b'.repeat(64)}`, kind: 'action' },
      { hash: `0x${'c'.repeat(64)}`, kind: 'cancel' },
    ]);
    expect(d.records[0]!.deadlineAt).toBe(records[1]!.deadline * 1000);
    // The network's own count for the relayer's address, as the relayer reads it (never an explorer's list).
    expect(d.chainCount).toEqual({ ok: true, latest: 7, pending: 7 });
    expect(d.chain.relayer.ok && d.chain.relayer.staffLog.length).toBe(50);
    expect(JSON.stringify(d)).not.toMatch(/0x1111111111111111111111111111111111111111|account|digest|reservedWei|maxFeePerGas/u);
  });

  it('each user action names its app from the sponsorship’s send records (evm_sponsor_sends, by chain and digest)', async () => {
    fakeChain();
    const app = await orgApp();
    const id = `es_${'r'.repeat(29)}${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    await env.DB.prepare(
      `INSERT INTO evm_sponsor_sends (id, app_id, chain_id, account, digest, execute_nonce, reserved_wei, deadline, gas_limit, fee_cap_wei, l1_bound_wei, op_bound_wei,
         call_count, targets_json, with_setup, status, request_id, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, '0', '1000', ?6, '200000', '1000000000', '0', '0', 1, '[]', 0, 'sent', 'req_test_apps', ?7, ?7)`,
    )
      .bind(id, app.id, CHAIN, '0x1111111111111111111111111111111111111111', record(6).digest, Math.floor(NOW / 1000) + 120, NOW)
      .run();
    const relayer = fakeRelayer(staffStatus({ records: [record(6), record(7, { digest: `0x${'e'.repeat(64)}` })] as never }));
    const r = await rpcOf(sponsorEnv(relayer)).evmRelayDetail({ ...hana(), chainId: CHAIN });
    if (!r.ok) throw new Error(r.code);
    const d = (r as unknown as { detail: import('@hana-id/console-core').EvmRelayDetail }).detail;
    expect(d.apps).toBe('recorded');
    expect(d.records.map((x) => x.app)).toEqual([{ id: app.id, name: expect.any(String) }, null]);
    // The send record's account stays out of the answer.
    expect(JSON.stringify(d)).not.toContain('0x1111111111111111111111111111111111111111');
  });

  it('is staff only, takes a sponsored chain only, and refuses an env without the block', async () => {
    fakeChain();
    const relayer = fakeRelayer(staffStatus());
    const rpc = rpcOf(sponsorEnv(relayer));
    expect(await rpc.evmRelayDetail({ ...member(), chainId: CHAIN })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc.evmRelayDetail({ ...system(), chainId: CHAIN })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc.evmRelayDetail({ ...hana(), chainId: 84532 })).toMatchObject({ ok: false, code: 'not_found' });
    for (const chainId of [0, -1, 1.5, '31337', 2 ** 53]) expect(await rpc.evmRelayDetail({ ...hana(), chainId })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpc.evmRelayDetail({ ...hana(), chainId: CHAIN, extra: 1 })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(await rpcOf(sponsorEnv(relayer, { EVM_SPONSOR: undefined })).evmRelayDetail({ ...hana(), chainId: CHAIN })).toMatchObject({ ok: false, code: 'not_found' });
    expect(relayer.calls).toEqual([]);
  });
});

describe('AdminRpc.evmRelayAct', () => {
  const result = (s: EvmRelayerStaffStatus, refused: string | null = null): EvmRelayerStaffResult => ({ done: refused === null, refused, status: s });
  const SEEN = { haltSince: NOW - 300_000, lastStaffSeq: 2 };
  const act = (over: Record<string, unknown> = {}) => ({ ...hana(), chainId: CHAIN, tool: 'resume', note: 'Sent 0.1 test ETH from the faucet', seen: { haltSince: NOW - 300_000, lastStaffSeq: 2 }, ...over });
  const halted = staffStatus({ halted: { reason: 'relayer_cannot_send', since: NOW - 300_000, nonce: 3, code: 'insufficient_funds' }, staffLog: [entry(2), entry(1)] });

  it('runs each tool as the staffer with the note, and answers done with the relayer afterwards', async () => {
    const after = staffStatus({ staffLog: [entry(3), entry(2), entry(1)] });
    const tools = {
      staffResume: async () => result(after),
      staffCancel: async () => result(after),
      staffClose: async () => result(after),
      staffFill: async () => result(after),
      staffAdoptNonce: async () => result(after),
    };
    const relayer = fakeRelayer(halted, tools);
    const rpc = rpcOf(sponsorEnv(relayer));
    const cases: [string, number | undefined, string, unknown[]][] = [
      ['resume', undefined, 'staffResume', ['staff@hana.example', 'Sent 0.1 test ETH from the faucet', SEEN, false]],
      ['cancel', 3, 'staffCancel', ['staff@hana.example', 3, 'Sent 0.1 test ETH from the faucet', SEEN]],
      ['close', 4, 'staffClose', ['staff@hana.example', 4, 'consumed_elsewhere', 'Sent 0.1 test ETH from the faucet', SEEN]],
      ['fill', 5, 'staffFill', ['staff@hana.example', 5, 'Sent 0.1 test ETH from the faucet', SEEN]],
      ['adopt_nonce', 9, 'staffAdoptNonce', ['staff@hana.example', 9, 'Sent 0.1 test ETH from the faucet', SEEN]],
    ];
    for (const [tool, slot, method, args] of cases) {
      relayer.calls.length = 0;
      const r = await rpc.evmRelayAct(act({ tool, ...(slot === undefined ? {} : { slot }) }));
      expect(r, tool).toMatchObject({ ok: true, result: { done: true, refused: null, relayer: { halted: null, lastStaffSeq: 3 } } });
      // First the page's view is read, then the one tool, with the guard, the staffer's email, the note, and the view the
      // page showed (checked again inside the relayer's queue).
      expect(relayer.calls.map((c) => c.method)).toEqual(['staffStatus', method]);
      expect(relayer.calls[1]!.args).toEqual(['hana-id/evm-relayer/staff/v1', ...args]);
    }
  });

  it('the relayer’s refusal is the answer, as it gave it (never retried); a coded error is a refusal; anything else is unknown', async () => {
    let answer: () => Promise<EvmRelayerStaffResult> = async () => result(halted, 'relayer_cannot_send');
    const relayer = fakeRelayer(halted, { staffResume: () => answer(), staffCancel: () => answer() });
    const rpc = rpcOf(sponsorEnv(relayer));
    expect(await rpc.evmRelayAct(act())).toMatchObject({ ok: true, result: { done: false, refused: 'relayer_cannot_send' } });
    expect(relayer.calls.filter((c) => c.method === 'staffResume')).toHaveLength(1);
    answer = async () => result(halted, 'nonce_mined');
    expect(await rpc.evmRelayAct(act({ tool: 'cancel', slot: 3 }))).toMatchObject({ ok: true, result: { done: false, refused: 'nonce_mined' } });
    answer = () => Promise.reject(new Error('evm_relayer:invalid_request'));
    expect(await rpc.evmRelayAct(act())).toMatchObject({ ok: true, result: { done: false, refused: 'invalid_request', relayer: null } });
    answer = () => Promise.reject(new Error('Network connection lost.'));
    expect(await rpc.evmRelayAct(act())).toMatchObject({ ok: true, result: { done: false, refused: 'unknown', relayer: null } });
  });

  it('the relayer’s own view check (inside its queue) answers version_conflict as the stale-page refusal', async () => {
    const relayer = fakeRelayer(halted, { staffResume: async () => result(halted, 'version_conflict') });
    expect(await rpcOf(sponsorEnv(relayer)).evmRelayAct(act())).toMatchObject({ ok: false, code: 'version_conflict' });
  });

  it('Cancel only past the slot’s time limit or in a stuck_past_deadline pause: else not_past_deadline, the relayer not called', async () => {
    const rec = (deadline: number) => ({ ...(staffStatus().records[0] ?? {}), nonce: 3, digest: `0x${'d'.repeat(64)}`, account: null, deadline, reservedWei: '0', day: 0, worstWei: '0', gas: '0', sentAt: NOW, signedAt: NOW, versions: [{ hash: `0x${'a'.repeat(64)}`, kind: 'execute', maxFeePerGas: '1', maxPriorityFeePerGas: '1' }], accepted: true, batchRejected: null, cannotSend: null, seen: null });
    const early = staffStatus({ halted: { reason: 'relayer_cannot_send', since: NOW - 300_000, nonce: 3, code: 'insufficient_funds' }, staffLog: [entry(2), entry(1)], records: [rec(Math.floor(Date.now() / 1000) + 600)] as never });
    let relayer = fakeRelayer(early, { staffCancel: async () => result(early) });
    expect(await rpcOf(sponsorEnv(relayer)).evmRelayAct(act({ tool: 'cancel', slot: 3 }))).toMatchObject({ ok: true, result: { done: false, refused: 'not_past_deadline', relayer: null } });
    expect(relayer.calls.map((c) => c.method)).toEqual(['staffStatus']);
    const stuck = staffStatus({ halted: { reason: 'stuck_past_deadline', since: NOW - 300_000, nonce: 3 }, staffLog: [entry(2), entry(1)], records: [rec(Math.floor(Date.now() / 1000) + 600)] as never });
    relayer = fakeRelayer(stuck, { staffCancel: async () => result(stuck) });
    expect(await rpcOf(sponsorEnv(relayer)).evmRelayAct(act({ tool: 'cancel', slot: 3 }))).toMatchObject({ ok: true, result: { done: true } });
    const past = staffStatus({ halted: { reason: 'relayer_cannot_send', since: NOW - 300_000, nonce: 3, code: 'insufficient_funds' }, staffLog: [entry(2), entry(1)], records: [rec(Math.floor(Date.now() / 1000) - 10)] as never });
    relayer = fakeRelayer(past, { staffCancel: async () => result(past) });
    expect(await rpcOf(sponsorEnv(relayer)).evmRelayAct(act({ tool: 'cancel', slot: 3 }))).toMatchObject({ ok: true, result: { done: true } });
  });

  it('a pause that means the key may be someone else’s: Resume needs keyConfirmed (else refused, the relayer not called); the confirmation goes into the relayer’s note', async () => {
    // The last: paused for money, but the relayer marked a sign of a leak seen since (D843 re-check M).
    for (const h of [{ reason: 'foreign_transactions' }, { reason: 'nonce_consumed_elsewhere', nonce: 4 }, { reason: 'nonce_gap', nonce: 4 }, { reason: 'relayer_cannot_send', nonce: 4, code: 'sender_restricted' }, { reason: 'relayer_cannot_send', nonce: 4, code: 'insufficient_funds', leakSeen: true }]) {
      const st = staffStatus({ halted: { ...h, since: NOW - 300_000 } as never, staffLog: [entry(2), entry(1)] });
      const relayer = fakeRelayer(st, { staffResume: async () => result(staffStatus({ staffLog: [entry(3), entry(2), entry(1)] })) });
      const rpc = rpcOf(sponsorEnv(relayer));
      expect(await rpc.evmRelayAct(act()), h.reason).toMatchObject({ ok: true, result: { done: false, refused: 'key_confirmation_required' } });
      expect(relayer.calls.map((c) => c.method)).toEqual(['staffStatus']);
      expect(await rpc.evmRelayAct(act({ keyConfirmed: true }))).toMatchObject({ ok: true, result: { done: true } });
      expect(relayer.calls.at(-1)!.args[2]).toBe('[An engineer confirmed the key is safe or replaced] Sent 0.1 test ETH from the faucet');
      // The confirmation reaches the relayer, which checks the same on its own.
      expect(relayer.calls.at(-1)!.args[4]).toBe(true);
    }
    // Not a leak (out of money): no confirmation needed, none added.
    const relayer = fakeRelayer(halted, { staffResume: async () => result(halted) });
    await rpcOf(sponsorEnv(relayer)).evmRelayAct(act());
    expect(relayer.calls.at(-1)!.args[2]).toBe('Sent 0.1 test ETH from the faucet');
  });

  it('a tool this code doesn’t know is refused, never mapped to another one', async () => {
    const relayer = fakeRelayer(halted, { staffAdoptNonce: async () => result(halted) });
    const r = await evmRelayerStaffAct(sponsorEnv(relayer), { ...act({ tool: 'drain', slot: 3 }) } as never, 'staff@hana.example');
    expect(r).toEqual({ done: false, refused: 'invalid_request', relayer: null });
    expect(relayer.calls.map((c) => c.method)).toEqual(['staffStatus']);
  });

  it('a stale page does nothing: another halt, a new halt, a resume elsewhere, or a staff action since it was read', async () => {
    const relayer = fakeRelayer(halted, { staffResume: async () => result(halted) });
    const rpc = rpcOf(sponsorEnv(relayer));
    for (const seen of [{ haltSince: null, lastStaffSeq: 2 }, { haltSince: NOW - 1, lastStaffSeq: 2 }, { haltSince: NOW - 300_000, lastStaffSeq: 1 }, { haltSince: NOW - 300_000, lastStaffSeq: 3 }]) {
      expect(await rpc.evmRelayAct(act({ seen })), JSON.stringify(seen)).toMatchObject({ ok: false, code: 'version_conflict' });
    }
    expect(relayer.calls.every((c) => c.method === 'staffStatus')).toBe(true);
  });

  it('validates every input before anything is read: staff only, slot as a safe integer, a plain one-line note, no extra field', async () => {
    const relayer = fakeRelayer(halted, { staffResume: async () => result(halted) });
    const rpc = rpcOf(sponsorEnv(relayer));
    expect(await rpc.evmRelayAct({ ...act(), ...member() })).toMatchObject({ ok: false, code: 'forbidden' });
    expect(await rpc.evmRelayAct({ ...act(), ...system() })).toMatchObject({ ok: false, code: 'forbidden' });
    const bad: Record<string, unknown>[] = [
      { tool: 'resume', slot: 3 },
      { tool: 'cancel' },
      { tool: 'cancel', slot: -1 },
      { tool: 'cancel', slot: 1.5 },
      { tool: 'cancel', slot: 2 ** 53 },
      { tool: 'cancel', slot: '3' },
      { tool: 'drain' },
      { tool: 'close', slot: 3, verdict: 'never_sent' },
      { note: 'short' },
      { note: 'x'.repeat(301) },
      { note: 'Two lines\nof a note here' },
      { note: 'A note with a ‮right-to-left override' },
      { note: 'A note with a \u0000 control character' },
      { note: 'A note with a zero-width\u200bspace inside' },
      { note: 'A note with an invisible\u2062times inside' },
      { note: 'A note with a byte\ufefforder mark inside' },
      { note: 'A note with an Arabic\u061cletter mark' },
      { keyConfirmed: false },
      { tool: 'cancel', slot: 3, keyConfirmed: true },
      { seen: { haltSince: null } },
      { seen: { haltSince: null, lastStaffSeq: -1 } },
      { seen: { haltSince: null, lastStaffSeq: 0, extra: 1 } },
      { chainId: 0 },
    ];
    for (const b of bad) expect(await rpc.evmRelayAct(act(b)), JSON.stringify(b)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(relayer.calls).toEqual([]);
    // A note is trimmed before it is kept.
    await rpc.evmRelayAct(act({ note: '   Sent 0.1 test ETH from the faucet   ' }));
    expect(relayer.calls.find((c) => c.method === 'staffResume')?.args[2]).toBe('Sent 0.1 test ETH from the faucet');
  });

  it('an env without the block, or another chain, is not_found; nothing is called', async () => {
    const relayer = fakeRelayer(halted);
    expect(await rpcOf(sponsorEnv(relayer, { EVM_SPONSOR: undefined })).evmRelayAct(act())).toMatchObject({ ok: false, code: 'not_found' });
    expect(await rpcOf(sponsorEnv(relayer)).evmRelayAct(act({ chainId: 84532 }))).toMatchObject({ ok: false, code: 'not_found' });
    expect(relayer.calls).toEqual([]);
  });

  it('reaches the real object through the same path: a fresh relayer has no state to act on', async () => {
    fakeChain();
    const e = sponsorEnv(null, { EVM_RELAYER: env.EVM_RELAYER });
    const d = await rpcOf(e).evmRelayDetail({ ...hana(), chainId: CHAIN });
    expect(d).toMatchObject({ ok: true, detail: { chain: { relayer: { ok: true, started: false, lastStaffSeq: 0 } }, records: [] } });
    const r = await rpcOf(e).evmRelayAct(act({ seen: { haltSince: null, lastStaffSeq: 0 } }));
    expect(r).toMatchObject({ ok: true, result: { done: false, refused: 'no_state' } });
  });
});
