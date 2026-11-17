// EVM gas sponsorship's pure parts (D847, D836 addendum): the gas limit and fee formulas, the L1 bound's encoding, the
// strict bodies, the revert data and success rules, and the minimal RPC client behind the chain port (failover, the
// chain ID check, reverts, malformed answers, nothing of a URL in a log or an error).
import { env } from 'cloudflare:workers';
import { keccak_256 } from '@noble/hashes/sha3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTHORIZATION_GAS,
  calldataTokens,
  DELEGATION_ACCESS_GAS,
  EVENT_GAS,
  L1_FEE_UPPER_BOUND_SELECTOR,
  l1FeeUpperBound,
  maxMinGasFor,
  PRE_LOOP_GAS,
  receiptCost,
  operatorFeeUpperBound,
  maxStartingFees,
  sponsorFees,
  sponsorGasLimit,
  unsignedTxSizeBound,
  worstCaseWei,
} from '../src/evm/op-fee.ts';
import { classifyDelegation, EXECUTED_TOPIC, executedIn, parseAddress, parseUint, revertDetails, toPrepareRequest, toSendRequest, toStatusQuery, U256_MAX } from '../src/evm/sponsor-checks.ts';
import { forgetSponsorChainChecks, minimalSponsorChain, parseReceipt, pendingAgeMs, relayerRefusal, revertOf, SponsorRpcError, sponsorRpcTiming, sponsorRpcUrls } from '../src/evm/sponsor-ports.ts';
import { CHECK_IN, CHECK_IN_DATA, DELEGATE, RELAYER, signedSend, testUser } from './evm-sponsor-helpers.ts';

const kHex = (s: string) => `0x${Array.from(keccak_256(new TextEncoder().encode(s)), (b) => b.toString(16).padStart(2, '0')).join('')}`;

describe('constants', () => {
  it('selectors and the event topic are the delegate’s and the oracle’s', () => {
    expect(EXECUTED_TOPIC).toBe(kHex('Executed(bytes32,uint256,uint256)'));
    expect(L1_FEE_UPPER_BOUND_SELECTOR).toBe(kHex('getL1FeeUpperBound(uint256)').slice(0, 10));
    expect(kHex('nonce()').slice(0, 10)).toBe('0xaffed0e0');
    expect(kHex('CallFailed(uint256,bytes)').slice(0, 10)).toBe('0x5c0dee5d');
    expect(kHex('getOperatorFee(uint256)').slice(0, 10)).toBe('0x275aedd2');
  });
});

describe('sponsorGasLimit', () => {
  it('is (21 000 + 10 per calldata token + 25 000 per authorization + delegated access + pre-loop + minGas + event) × 1.1, rounded up', () => {
    // 4 zero bytes and 2 non-zero: 4 + 8 tokens.
    const calldata = '0x00000000ffff';
    expect(calldataTokens(calldata)).toBe(12n);
    const body = 21_000n + 120n + DELEGATION_ACCESS_GAS + PRE_LOOP_GAS + 8n + 100_000n + EVENT_GAS;
    expect(sponsorGasLimit({ calldata, callData: ['0x183ff085'], minGas: 100_000n, authorizations: 0 })).toBe((body * 11n + 9n) / 10n);
    expect(sponsorGasLimit({ calldata, callData: ['0x183ff085'], minGas: 100_000n, authorizations: 1 })).toBe(((body + AUTHORIZATION_GAS) * 11n + 9n) / 10n);
    // Per extra call and per byte of the calls' data.
    const two = sponsorGasLimit({ calldata, callData: ['0x183ff085', '0x183ff085'], minGas: 100_000n, authorizations: 0 });
    expect(two).toBe(((body + 1_400n + 8n) * 11n + 9n) / 10n);
  });

  it('covers EIP-7623’s floor: the limit is never below 21 000 + 10 per token', () => {
    const calldata = `0x${'ff'.repeat(8000)}` as const;
    const limit = sponsorGasLimit({ calldata, callData: [`0x${'ff'.repeat(4)}`], minGas: 10_000n, authorizations: 0 });
    expect(limit >= 21_000n + 10n * calldataTokens(calldata)).toBe(true);
  });

  it('maxMinGasFor is the largest minGas that fits, exactly', () => {
    const i = { calldata: `0x${'11'.repeat(548)}` as const, callData: ['0x183ff085' as const], authorizations: 1 };
    const m = maxMinGasFor(i, 300_000n);
    expect(sponsorGasLimit({ ...i, minGas: m }) <= 300_000n).toBe(true);
    expect(sponsorGasLimit({ ...i, minGas: m + 1n }) > 300_000n).toBe(true);
    expect(maxMinGasFor(i, 50_000n)).toBe(0n);
  });
});

describe('fees and the worst case', () => {
  it('fees start at most at maxStartingFees (two × 9/8 bumps fit the caps); a base above it is refused; the tip never above maxFee', () => {
    const caps = { maxFeePerGasWei: 1_000_000_000n, maxPriorityFeePerGasWei: 10_000_000n };
    const start = maxStartingFees(caps);
    const bump = (x: bigint) => (x * 9n + 7n) / 8n;
    expect(bump(bump(start.maxFeePerGas)) <= caps.maxFeePerGasWei && bump(bump(start.maxFeePerGas + 1n)) > caps.maxFeePerGasWei).toBe(true);
    expect(bump(bump(start.maxPriorityFeePerGas)) <= caps.maxPriorityFeePerGasWei && bump(bump(start.maxPriorityFeePerGas + 1n)) > caps.maxPriorityFeePerGasWei).toBe(true);
    const tip = start.maxPriorityFeePerGas;
    expect(sponsorFees(100n, caps)).toEqual({ ok: true, maxFeePerGas: 200n + tip, maxPriorityFeePerGas: tip });
    expect(sponsorFees(600_000_000n, caps)).toEqual({ ok: true, maxFeePerGas: start.maxFeePerGas, maxPriorityFeePerGas: tip });
    expect(sponsorFees(start.maxFeePerGas, caps)).toEqual({ ok: true, maxFeePerGas: start.maxFeePerGas, maxPriorityFeePerGas: tip });
    expect(sponsorFees(start.maxFeePerGas + 1n, caps)).toEqual({ ok: false, baseFee: start.maxFeePerGas + 1n });
    expect(sponsorFees(0n, { maxFeePerGasWei: 100n, maxPriorityFeePerGasWei: 100n })).toEqual({ ok: true, maxFeePerGas: maxStartingFees({ maxFeePerGasWei: 100n, maxPriorityFeePerGasWei: 100n }).maxPriorityFeePerGas, maxPriorityFeePerGas: maxStartingFees({ maxFeePerGasWei: 100n, maxPriorityFeePerGasWei: 100n }).maxPriorityFeePerGas });
    expect(worstCaseWei(200_000n, 1_000n, 7n)).toBe(200_000_007n);
    expect(worstCaseWei(200_000n, 1_000n, 7n, 3n)).toBe(200_000_010n);
  });

  it('a receipt costs gasUsed × effectiveGasPrice + L1 fee + operator fee, each bounded by the reservation (else settled at it)', () => {
    const f = { gasLimit: 100_000n, feeCap: 10n, l1Bound: 99n, operatorBound: 0n, reservedWei: 1_000_099n };
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n }, true, f)).toEqual({ cost: 63_005n, odd: false });
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: null }, true, f)).toEqual({ cost: 63_099n, odd: false });
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n }, false, f)).toEqual({ cost: 63_000n, odd: false });
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n, operatorFee: 7n }, true, f)).toEqual({ cost: 63_012n, odd: false });
    // No operator fee in the receipt: its bound is charged.
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n }, true, { ...f, operatorBound: 40n })).toEqual({ cost: 63_045n, odd: false });
    for (const odd of [
      { gasUsed: 20_999n, effectiveGasPrice: 3n, l1Fee: 5n },
      { gasUsed: 100_001n, effectiveGasPrice: 3n, l1Fee: 5n },
      { gasUsed: 21_000n, effectiveGasPrice: 11n, l1Fee: 5n },
      { gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 199n },
      { gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n, operatorFee: 199n },
    ]) expect(receiptCost(odd, true, f), JSON.stringify(odd, (_k, v) => (typeof v === 'bigint' ? String(v) : v))).toEqual({ cost: 1_000_099n, odd: true });
  });

  it('the operator fee bound: 0 off the OP Stack; a revert (before Isthmus) is 0; a value is the bound; anything else fails closed', async () => {
    const port = (answer: () => Promise<string>) => ({ call: answer }) as unknown as Parameters<typeof operatorFeeUpperBound>[0];
    expect(await operatorFeeUpperBound(port(async () => '0x'), false, RELAYER, 1n)).toBe(0n);
    expect(await operatorFeeUpperBound(port(async () => Promise.reject(new SponsorRpcError('rpc_error', { rpcCode: 3, nodeMessage: 'execution reverted' }))), true, RELAYER, 1n)).toBe(0n);
    expect(await operatorFeeUpperBound(port(async () => `0x${(42n).toString(16).padStart(64, '0')}`), true, RELAYER, 1n)).toBe(42n);
    await expect(operatorFeeUpperBound(port(async () => Promise.reject(new SponsorRpcError('unavailable'))), true, RELAYER, 1n)).rejects.toThrow();
    await expect(operatorFeeUpperBound(port(async () => '0x12'), true, RELAYER, 1n)).rejects.toThrow();
  });

  it('the L1 bound: 0 off the OP Stack with no read; on it, getL1FeeUpperBound(size) from the predeploy, a malformed answer refused', async () => {
    const seen: unknown[] = [];
    const port = {
      call: async (req: unknown) => {
        seen.push(req);
        return `0x${(123n).toString(16).padStart(64, '0')}`;
      },
    } as unknown as Parameters<typeof l1FeeUpperBound>[0];
    expect(await l1FeeUpperBound(port, false, RELAYER, 500n)).toBe(0n);
    expect(seen).toEqual([]);
    expect(await l1FeeUpperBound(port, true, RELAYER, unsignedTxSizeBound(548, 1))).toBe(123n);
    expect(seen[0]).toEqual({ from: RELAYER, to: '0x420000000000000000000000000000000000000f', data: `0xf1c7a58b${(548n + 200n + 128n).toString(16).padStart(64, '0')}` });
    const bad = { call: async () => '0x' } as unknown as Parameters<typeof l1FeeUpperBound>[0];
    await expect(l1FeeUpperBound(bad, true, RELAYER, 1n)).rejects.toThrow();
  });
});

describe('strict bodies', () => {
  it('addresses: lowercase, uppercase or exact EIP-55, returned as EIP-55; numbers: canonical decimal strings in range', () => {
    expect(parseAddress(DELEGATE.toLowerCase())).toBe(DELEGATE);
    expect(parseAddress(`0x${DELEGATE.slice(2).toUpperCase()}`)).toBe(DELEGATE);
    expect(parseAddress(DELEGATE)).toBe(DELEGATE);
    expect(parseAddress(`${DELEGATE.slice(0, 41)}x`)).toBeNull();
    expect(parseAddress(42)).toBeNull();
    for (const v of ['01', '-1', '1e3', ' 1', '0x1', 1, '']) expect(parseUint(v, U256_MAX), String(v)).toBeNull();
    expect(parseUint((U256_MAX + 1n).toString(), U256_MAX)).toBeNull();
    expect(parseUint('0', U256_MAX)).toBe(0n);
  });

  it('send: every field required in its shape, nothing else; prepare and status the same', () => {
    const { body } = signedSend(testUser(), { authNonce: 1n });
    expect(toSendRequest(body)).not.toBeNull();
    for (const k of Object.keys(body)) {
      if (k === 'authorization') continue;
      const { [k]: _gone, ...rest } = body;
      expect(toSendRequest(rest), k).toBeNull();
    }
    expect(toSendRequest({ ...body, authorization: { ...(body.authorization as object), yParity: 2 } })).toBeNull();
    expect(toSendRequest({ ...body, authorization: { ...(body.authorization as object), extra: 1 } })).toBeNull();
    expect(toSendRequest({ ...body, calls: [{ to: CHECK_IN, value: '0', data: '0x183ff08' }] })).toBeNull();
    expect(toSendRequest({ ...body, calls: Array.from({ length: 9 }, () => ({ to: CHECK_IN, value: '0', data: CHECK_IN_DATA })) })).toBeNull();
    expect(toSendRequest({ ...body, calls: [{ to: CHECK_IN, value: '0', data: `0x${'00'.repeat(8193)}` }] })).toBeNull();
    expect(toSendRequest({ ...body, chainId: '31337' })).toBeNull();
    expect(toSendRequest([body])).toBeNull();
    expect(toPrepareRequest({ chainId: 31337, account: RELAYER, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }] })).not.toBeNull();
    expect(toPrepareRequest({ chainId: 31337, account: RELAYER, calls: [{ to: CHECK_IN, value: '0', data: CHECK_IN_DATA }], minGas: '1' })).toBeNull();
    expect(toStatusQuery(new URL('https://x/?chainId=84532'))).toEqual({ chainId: 84532 });
    expect(toStatusQuery(new URL('https://x/?chainId=84532&chainId=1'))).toBeNull();
  });
});

describe('delegation, revert data, success', () => {
  it('classifies the account’s code', () => {
    expect(classifyDelegation('0x', DELEGATE)).toBe('none');
    expect(classifyDelegation(`0xef0100${DELEGATE.slice(2).toLowerCase()}`, DELEGATE)).toBe('journear');
    expect(classifyDelegation(`0xef0100${'00'.repeat(20)}`, DELEGATE)).toBe('other');
    expect(classifyDelegation(`0xef0100${DELEGATE.slice(2).toLowerCase()}00`, DELEGATE)).toBe('other');
    expect(classifyDelegation('0x60806040', DELEGATE)).toBe('other');
  });

  it('revert data: echoed only when well formed and ≤ 2 KiB; callIndex only from a CallFailed naming a call of the batch', () => {
    expect(revertDetails(null, 1)).toEqual({});
    expect(revertDetails('0x756688fe', 1)).toEqual({ revertData: '0x756688fe' });
    expect(revertDetails(`0x${'aa'.repeat(2048)}`, 1)).toEqual({ revertData: `0x${'aa'.repeat(2048)}` });
    expect(revertDetails(`0x${'aa'.repeat(2049)}`, 1)).toEqual({});
    expect(revertDetails('0xzz' as `0x${string}`, 1)).toEqual({});
    const cf = (i: bigint) => `0x5c0dee5d${i.toString(16).padStart(64, '0')}${'40'.padStart(64, '0')}${'00'.repeat(32)}` as const;
    expect(revertDetails(cf(1n), 2)).toEqual({ revertData: cf(1n), callIndex: 1 });
    expect(revertDetails(cf(2n), 2)).toEqual({ revertData: cf(2n) });
    expect(revertDetails('0x5c0dee5d01', 2)).toEqual({ revertData: '0x5c0dee5d01' });
  });

  it('success needs status 1 and Executed(digest) emitted by the account itself', () => {
    const account = RELAYER;
    const digest = `0x${'ab'.repeat(32)}` as const;
    const log = { address: account.toLowerCase() as `0x${string}`, topics: [EXECUTED_TOPIC, digest], data: '0x' as const };
    const r = { transactionHash: digest, status: 1 as const, gasUsed: 1n, effectiveGasPrice: 1n, l1Fee: null, logs: [log] };
    expect(executedIn(r, account, digest)).toBe(true);
    expect(executedIn({ ...r, status: 0 }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, address: CHECK_IN.toLowerCase() as `0x${string}` }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, topics: [EXECUTED_TOPIC, `0x${'cd'.repeat(32)}`] }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, topics: [`0x${'00'.repeat(32)}`, digest] }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [] }, account, digest)).toBe(false);
  });

  it('relayerRefusal reads the relayer’s coded errors only (anything else is unknown)', () => {
    expect(relayerRefusal(new Error('evm_relayer:relayer_busy'))).toEqual({ code: 'relayer_busy', reason: null });
    expect(relayerRefusal(new Error('evm_relayer:rejected:insufficient_funds'))).toEqual({ code: 'rejected', reason: 'insufficient_funds' });
    for (const e of [new Error('evm_relayer:made_up'), new Error('boom'), new Error('evm_relayer:relayer_busy '), 'x', null]) expect(relayerRefusal(e)).toBeNull();
  });

  it('pendingAgeMs reads an age or an epoch timestamp', () => {
    expect(pendingAgeMs(null, 5)).toBeNull();
    expect(pendingAgeMs(300_001, Date.now())).toBe(300_001);
    expect(pendingAgeMs(Date.now() - 400_000, Date.now())).toBeGreaterThanOrEqual(400_000);
  });
});

describe('parseReceipt', () => {
  const ok = { transactionHash: `0x${'aa'.repeat(32)}`, status: '0x1', gasUsed: '0x5208', effectiveGasPrice: '0x3b9aca00', logs: [{ address: RELAYER, topics: [EXECUTED_TOPIC], data: '0x' }] };
  it('reads a receipt, with l1Fee when the node gives it', () => {
    expect(parseReceipt(ok)).toEqual({ transactionHash: ok.transactionHash, status: 1, gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n, l1Fee: null, operatorFee: null, logs: [{ address: RELAYER.toLowerCase(), topics: [EXECUTED_TOPIC], data: '0x' }] });
    expect(parseReceipt({ ...ok, l1Fee: '0x10' })?.l1Fee).toBe(16n);
    // Isthmus: gasUsed × operatorFeeScalar ÷ 10^6 + operatorFeeConstant.
    expect(parseReceipt({ ...ok, operatorFeeScalar: '0xf4240', operatorFeeConstant: '0x5' })?.operatorFee).toBe(21_005n);
    expect(parseReceipt(ok)?.operatorFee).toBeNull();
    expect(parseReceipt(null)).toBeNull();
  });
  it('refuses anything malformed', () => {
    for (const bad of [{ ...ok, status: '0x2' }, { ...ok, gasUsed: 21000 }, { ...ok, transactionHash: '0x12' }, { ...ok, logs: 'x' }, { ...ok, logs: [{ address: 'x', topics: [], data: '0x' }] }, { ...ok, logs: Array(65).fill(ok.logs[0]) }, 'receipt']) {
      expect(() => parseReceipt(bad)).toThrow(SponsorRpcError);
    }
  });
});

describe('minimalSponsorChain (the handlers’ RPC reads)', () => {
  const cfg = { chainId: 84532, rpc: 'https://primary.example', rpcFallback: 'https://fallback.example' };
  let replies: Map<string, (method: string, params: unknown[]) => unknown>;
  let asked: { url: string; method: string }[];
  beforeEach(() => {
    forgetSponsorChainChecks();
    asked = [];
    replies = new Map();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).replace(/\/$/u, '');
      const { method, params } = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      asked.push({ url, method });
      const reply = replies.get(url);
      if (!reply) return new Response('down', { status: 502 });
      const out = reply(method, params);
      return new Response(JSON.stringify(out), { status: 200 });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const node = (chainId: number, extra: (method: string, params: unknown[]) => unknown = () => ({ jsonrpc: '2.0', id: 1, result: '0x' })) => (method: string, params: unknown[]) =>
    method === 'eth_chainId' ? { jsonrpc: '2.0', id: 1, result: `0x${chainId.toString(16)}` } : extra(method, params);

  it('checks eth_chainId once per endpoint, fails over to the fallback, and refuses an endpoint on another chain', async () => {
    replies.set('https://primary.example', node(1));
    replies.set('https://fallback.example', node(84532, () => ({ jsonrpc: '2.0', id: 1, result: '0x7' })));
    const port = minimalSponsorChain(env, cfg);
    expect(await port.transactionCount(RELAYER, 'pending')).toBe(7);
    expect(await port.transactionCount(RELAYER, 'pending')).toBe(7);
    // The primary was asked its chain each time (it never matched); the fallback once.
    expect(asked.filter((a) => a.url === 'https://fallback.example' && a.method === 'eth_chainId').length).toBe(1);
    expect(asked.filter((a) => a.url === 'https://primary.example' && a.method !== 'eth_chainId').length).toBe(0);
  });

  it('a JSON-RPC error is an answer (rpc_error, not a failover): a revert with its data, anything else a node failure; messages carry no URL', async () => {
    replies.set('https://primary.example', node(84532, () => ({ jsonrpc: '2.0', id: 1, error: { code: 3, message: 'execution reverted', data: '0x756688fe' } })));
    const port = minimalSponsorChain(env, cfg);
    const reverted = await port.call({ from: RELAYER, to: RELAYER, data: '0x' }).then(() => null, (e: unknown) => e);
    expect(revertOf(reverted)).toEqual({ revertData: '0x756688fe' });
    expect(asked.some((a) => a.url === 'https://fallback.example')).toBe(false);
    replies.set('https://primary.example', node(84532, () => ({ jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'header not found at https://primary.example' } })));
    const err = await port.code(RELAYER).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SponsorRpcError);
    expect(revertOf(err)).toBeNull();
    expect(String((err as Error).message)).not.toContain('example');
    // Out of gas has no data; an unavailable chain is no revert.
    expect(revertOf(new SponsorRpcError('rpc_error', { rpcCode: -32000, nodeMessage: 'out of gas' }))).toEqual({ revertData: null });
    expect(revertOf(new SponsorRpcError('unavailable'))).toBeNull();
  });

  it('sends the state override and the gas as eth_call takes them; reads the base fee', async () => {
    const params: unknown[][] = [];
    replies.set('https://primary.example', node(84532, (method, p) => {
      params.push(p);
      return method === 'eth_getBlockByNumber' ? { jsonrpc: '2.0', id: 1, result: { baseFeePerGas: '0x5f5e100' } } : { jsonrpc: '2.0', id: 1, result: '0x' };
    }));
    const port = minimalSponsorChain(env, cfg);
    await port.call({ from: RELAYER, to: DELEGATE, data: '0x00', gas: 300_000n }, { stateOverride: { [DELEGATE]: { code: '0xef01' } } });
    expect(params[0]).toEqual([{ to: DELEGATE, data: '0x00', from: RELAYER, gas: '0x493e0' }, 'latest', { [DELEGATE]: { code: '0xef01' } }]);
    expect((await port.latestBlock()).baseFeePerGas).toBe(100_000_000n);
  });

  it('a keyed RPC secret comes first; the URLs are never logged', async () => {
    const lines: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => void lines.push(a.join(' ')));
    const keyed = { ...env, 'EVM_SPONSOR_RPC_84532': 'https://keyed.example/secret-key' } as typeof env;
    expect(sponsorRpcUrls(keyed, cfg)).toEqual(['https://keyed.example/secret-key', 'https://primary.example', 'https://fallback.example']);
    sponsorRpcTiming.timeoutMs = 1000;
    replies.set('https://fallback.example', node(84532, () => ({ jsonrpc: '2.0', id: 1, result: '0x1' })));
    expect(await minimalSponsorChain(keyed, cfg).balance(RELAYER)).toBe(1n);
    sponsorRpcTiming.timeoutMs = 5000;
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(/example|secret-key/u.test(l), l).toBe(false);
  });
});
