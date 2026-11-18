// EVM gas sponsorship's pure parts (D847, D836 addendum): the gas limit (the relayer's own intrinsic gas) and fee
// formulas, the L1 bound's encoding, the strict bodies, the revert data and success rules, the relayer's refusal codes,
// and the chain port (the real SponsorChain client, evm/sponsor-chain.ts, tested in evm-sponsor-chain.test.ts).
import { env } from 'cloudflare:workers';
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it } from 'vitest';
import { intrinsicGas, maxStartingFees as relayerStartingFees } from '../src/evm-relayer.ts';
import { SponsorChain } from '../src/evm/sponsor-chain.ts';
import {
  AUTHORIZATION_GAS,
  DELEGATION_ACCESS_GAS,
  EVENT_GAS,
  L1_FEE_UPPER_BOUND_SELECTOR,
  l1FeeUpperBound,
  maxMinGasFor,
  PRE_LOOP_GAS,
  paidGasPrice,
  receiptCost,
  operatorFeeUpperBound,
  maxStartingFees,
  sponsorFees,
  sponsorGasLimit,
  unsignedTxSizeBound,
  worstCaseWei,
} from '../src/evm/op-fee.ts';
import { classifyDelegation, EXECUTED_TOPIC, executedIn, parseAddress, parseUint, revertDetails, toPrepareRequest, toSendRequest, toStatusQuery, U256_MAX } from '../src/evm/sponsor-checks.ts';
import { blockTimestamp, DEFAULT_SPONSOR_PORTS, EvmRpcError, relayerRefusal, revertOf } from '../src/evm/sponsor-ports.ts';
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

const bytes = (h: string): Uint8Array => Uint8Array.from(h.slice(2).match(/../gu) ?? [], (x) => Number.parseInt(x, 16));

describe('sponsorGasLimit', () => {
  it('is (the relayer’s intrinsicGas + delegated access + pre-loop + minGas + event) × 1.1, rounded up: the relayer’s own figure', () => {
    // 4 zero bytes and 2 non-zero: 12 tokens. Without an authorization EIP-7623's floor (10 a token) is the larger sum.
    const calldata = '0x00000000ffff';
    expect(intrinsicGas(bytes(calldata), 0)).toBe(21_000n + 120n);
    const rest = DELEGATION_ACCESS_GAS + PRE_LOOP_GAS + 8n + 100_000n + EVENT_GAS;
    expect(sponsorGasLimit({ calldata, callData: ['0x183ff085'], minGas: 100_000n, authorizations: 0 })).toBe(((21_120n + rest) * 11n + 9n) / 10n);
    // With one: the standard sum (4 a token + 25 000), as nodes check it, not the floor plus 25 000.
    expect(intrinsicGas(bytes(calldata), 1)).toBe(21_000n + 48n + AUTHORIZATION_GAS);
    expect(sponsorGasLimit({ calldata, callData: ['0x183ff085'], minGas: 100_000n, authorizations: 1 })).toBe(((21_048n + AUTHORIZATION_GAS + rest) * 11n + 9n) / 10n);
    // Per extra call and per byte of the calls' data.
    const two = sponsorGasLimit({ calldata, callData: ['0x183ff085', '0x183ff085'], minGas: 100_000n, authorizations: 0 });
    expect(two).toBe(((21_120n + rest + 1_400n + 8n) * 11n + 9n) / 10n);
  });

  it('is always above the relayer’s own minimum (intrinsicGas + minGas), whatever the calldata and authorizations', () => {
    for (const calldata of [`0x${'ff'.repeat(8000)}`, `0x${'00'.repeat(8000)}`, '0x183ff085'] as const) {
      for (const authorizations of [0, 1]) {
        const limit = sponsorGasLimit({ calldata, callData: ['0x183ff085'], minGas: 10_000n, authorizations });
        expect(limit > intrinsicGas(bytes(calldata), authorizations) + 10_000n).toBe(true);
      }
    }
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
    // The relayer's own function, not a copy.
    expect(maxStartingFees).toBe(relayerStartingFees);
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

  it('a receipt reporting a gas price above the mined version’s own max fee is billed at that max fee, priceCapped (D868); within it, as reported', () => {
    const f = { gasLimit: 100_000n, feeCap: 10n, l1Bound: 99n, operatorBound: 0n, reservedWei: 1_000_099n };
    // The relayer signed this version with a max fee of 4; the receipt says 7 (≤ the fee cap, so not `odd`).
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 7n, l1Fee: 5n }, true, f, 4n)).toEqual({ cost: 84_005n, odd: false, priceCapped: true });
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 4n, l1Fee: 5n }, true, f, 4n)).toEqual({ cost: 84_005n, odd: false });
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 3n, l1Fee: 5n }, true, f, 4n)).toEqual({ cost: 63_005n, odd: false });
    // Not known (an old record): the fee cap alone bounds it, as before.
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 7n, l1Fee: 5n }, true, f, null)).toEqual({ cost: 147_005n, odd: false });
    // Above the fee cap stays `odd` (settled at the reservation), whatever the version's max fee.
    expect(receiptCost({ gasUsed: 21_000n, effectiveGasPrice: 11n, l1Fee: 5n }, true, f, 4n)).toEqual({ cost: 1_000_099n, odd: true });
    expect([paidGasPrice(9n, 5n), paidGasPrice(5n, 9n), paidGasPrice(9n, null), paidGasPrice(9n, 0n)]).toEqual([5n, 5n, 9n, 9n]);
  });

  it('the operator fee bound: 0 off the OP Stack; a revert (before Isthmus) is 0; a value is the bound; anything else fails closed', async () => {
    const port = (answer: () => Promise<string>) => ({ call: answer }) as unknown as Parameters<typeof operatorFeeUpperBound>[0];
    expect(await operatorFeeUpperBound(port(async () => '0x'), false, RELAYER, 1n)).toBe(0n);
    expect(await operatorFeeUpperBound(port(async () => Promise.reject(new EvmRpcError('rpc_error', { rpcCode: 3, nodeMessage: 'execution reverted' }))), true, RELAYER, 1n)).toBe(0n);
    expect(await operatorFeeUpperBound(port(async () => `0x${(42n).toString(16).padStart(64, '0')}`), true, RELAYER, 1n)).toBe(42n);
    await expect(operatorFeeUpperBound(port(async () => Promise.reject(new EvmRpcError('unavailable'))), true, RELAYER, 1n)).rejects.toThrow();
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
    const r = { transactionHash: digest, status: 1 as const, blockNumber: 1n, gasUsed: 1n, effectiveGasPrice: 1n, l1Fee: null, operatorFee: null, logs: [log] };
    expect(executedIn(r, account, digest)).toBe(true);
    expect(executedIn({ ...r, status: 0 }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, address: CHECK_IN.toLowerCase() as `0x${string}` }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, topics: [EXECUTED_TOPIC, `0x${'cd'.repeat(32)}`] }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [{ ...log, topics: [`0x${'00'.repeat(32)}`, digest] }] }, account, digest)).toBe(false);
    expect(executedIn({ ...r, logs: [] }, account, digest)).toBe(false);
  });

  it('relayerRefusal reads the relayer’s coded errors only, fees_too_low among them before its type lands (anything else is unknown)', () => {
    expect(relayerRefusal(new Error('evm_relayer:relayer_busy'))).toEqual({ code: 'relayer_busy', reason: null });
    expect(relayerRefusal(new Error('evm_relayer:relayer_busy:account'))).toEqual({ code: 'relayer_busy', reason: 'account' });
    expect(relayerRefusal(new Error('evm_relayer:fees_too_low'))).toEqual({ code: 'fees_too_low', reason: null });
    expect(relayerRefusal(new Error('evm_relayer:relayer_halted'))).toEqual({ code: 'relayer_halted', reason: null });
    for (const e of [new Error('evm_relayer:made_up'), new Error('boom'), new Error('evm_relayer:relayer_busy '), 'x', null]) expect(relayerRefusal(e)).toBeNull();
  });
});

describe('the chain port', () => {
  it('is the relayer’s own client (sponsorChainFor): one trusted endpoint, the keyed secret first', () => {
    const cfg = { chainId: 84532, rpc: 'https://primary.example', rpcFallback: 'https://fallback.example' };
    const port = DEFAULT_SPONSOR_PORTS.chain(env, cfg as never);
    expect(port).toBeInstanceOf(SponsorChain);
    expect((port as SponsorChain).chainId).toBe(84532);
  });

  it('a revert is an rpc_error with its data; out of gas has none; any other failure is no revert', () => {
    expect(revertOf(new EvmRpcError('rpc_error', { rpcCode: 3, nodeMessage: 'execution reverted', data: '0x756688fe' }))).toEqual({ revertData: '0x756688fe' });
    expect(revertOf(new EvmRpcError('rpc_error', { rpcCode: -32000, nodeMessage: 'out of gas' }))).toEqual({ revertData: null });
    expect(revertOf(new EvmRpcError('rpc_error', { rpcCode: -32000, nodeMessage: 'header not found' }))).toBeNull();
    expect(revertOf(new EvmRpcError('unavailable'))).toBeNull();
    expect(revertOf(new Error('x'))).toBeNull();
  });

  it('a block’s timestamp for the billing record, through the client’s read; a malformed one throws', async () => {
    const port = { read: async (_m: string, _p: unknown[], parse: (r: unknown) => unknown) => parse({ timestamp: '0x6553f100' }) } as never;
    expect(await blockTimestamp(port, 7n)).toBe(0x6553f100n);
    const bad = { read: async (_m: string, _p: unknown[], parse: (r: unknown) => unknown) => parse({ timestamp: 12 }) } as never;
    await expect(blockTimestamp(bad, 7n)).rejects.toThrow();
  });
});
