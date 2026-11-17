// The sponsorship RPC client (evm/sponsor-chain.ts, D837): endpoint order, the per-isolate chain check, read failover,
// the broadcast's four outcomes, rejection classes, response checks, and no URL in any error or log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvmRpcError, SponsorChain, classifyRejection, forgetVerifiedChains, rawTxHash, sponsorRpcUrls } from '../src/evm/sponsor-chain.ts';
import { EvmMock, FALLBACK_RPC, type Hex, PRIMARY_RPC } from './evm-mock.ts';

const ADDRESS = `0x${'11'.repeat(20)}` as Hex;
const HASH = `0x${'22'.repeat(32)}` as Hex;

beforeEach(() => forgetVerifiedChains());
afterEach(() => vi.restoreAllMocks());

/** A fetch stub answering each method from `answers` (a function of the endpoint index and the call). */
function stubFetch(answer: (endpoint: number, method: string, params: unknown[], signal?: AbortSignal | null) => unknown): { calls: { endpoint: number; method: string }[] } {
  const calls: { endpoint: number; method: string }[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const endpoint = [PRIMARY_RPC, FALLBACK_RPC, 'https://keyed.test.invalid/v2/secret-api-key'].indexOf(url);
    const body = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    calls.push({ endpoint, method: body.method });
    if (body.method === 'eth_chainId') return Response.json({ jsonrpc: '2.0', id: body.id, result: '0x7a69' });
    const a = await answer(endpoint, body.method, body.params, init?.signal);
    if (a instanceof Response) return a;
    if (a === 'network') throw new TypeError('Network connection lost.');
    return Response.json({ jsonrpc: '2.0', id: body.id, ...(a as object) });
  });
  return { calls };
}

describe('sponsorRpcUrls', () => {
  const chain = { chainId: 84532, rpc: PRIMARY_RPC, rpcFallback: FALLBACK_RPC };
  it('puts the keyed secret first (https only), then rpc, then rpcFallback, each once', () => {
    expect(sponsorRpcUrls({}, chain)).toEqual([PRIMARY_RPC, FALLBACK_RPC]);
    expect(sponsorRpcUrls({ EVM_SPONSOR_RPC_84532: 'https://keyed.test.invalid/v2/secret' }, chain)).toEqual(['https://keyed.test.invalid/v2/secret', PRIMARY_RPC, FALLBACK_RPC]);
    expect(sponsorRpcUrls({ EVM_SPONSOR_RPC_84532: 'http://keyed.test.invalid/v2/secret' }, chain)).toEqual([PRIMARY_RPC, FALLBACK_RPC]);
    expect(sponsorRpcUrls({ EVM_SPONSOR_RPC_84532: 'not a url' }, chain)).toEqual([PRIMARY_RPC, FALLBACK_RPC]);
    expect(sponsorRpcUrls({ EVM_SPONSOR_RPC_1: 'https://keyed.test.invalid/' }, chain)).toEqual([PRIMARY_RPC, FALLBACK_RPC]);
    expect(sponsorRpcUrls({ EVM_SPONSOR_RPC_84532: PRIMARY_RPC }, { ...chain, rpcFallback: null })).toEqual([PRIMARY_RPC]);
  });
});

describe('SponsorChain reads', () => {
  it('checks eth_chainId once per endpoint per isolate, and never reads from an endpoint on another chain', async () => {
    const chain = new EvmMock({ chainId: 31337 }).install();
    chain.minedCount.set(ADDRESS.toLowerCase(), 5);
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    expect(await rpc.transactionCount(ADDRESS, 'latest')).toBe(5);
    expect(await rpc.transactionCount(ADDRESS, 'pending')).toBe(5);
    expect(chain.calls.map((c) => c.method)).toEqual(['eth_chainId', 'eth_getTransactionCount', 'eth_getTransactionCount']);
    // A client for another chain on the same URLs: refused there (cached), nothing read.
    const other = new SponsorChain(84532, [PRIMARY_RPC, FALLBACK_RPC]);
    await expect(other.transactionCount(ADDRESS, 'latest')).rejects.toMatchObject({ kind: 'wrong_chain' });
    expect(chain.calls.filter((c) => c.method === 'eth_getTransactionCount')).toHaveLength(2);
  });

  it('fails over on no answer, HTTP errors, garbage, rate limits and a malformed result; a node’s own error is final', async () => {
    const chain = new EvmMock({ chainId: 31337 }).install();
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    for (const mode of ['down', 'http503', 'garbage', 'rate_limited', 'wrong_chain'] as const) {
      forgetVerifiedChains();
      chain.modes[0] = mode;
      expect([mode, await rpc.transactionCount(ADDRESS, 'latest')]).toEqual([mode, 0]);
    }
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    await expect(rpc.code(ADDRESS)).rejects.toMatchObject({ kind: 'unavailable' });

    vi.restoreAllMocks();
    forgetVerifiedChains();
    stubFetch((endpoint, method) => {
      if (method === 'eth_getBalance') return endpoint === 0 ? { result: 'not a quantity' } : { result: '0x10' };
      if (method === 'eth_call') return { error: { code: 3, message: 'execution reverted', data: '0x08c379a0' } };
      return { error: { code: -32601, message: 'nope' } };
    });
    expect(await rpc.balance(ADDRESS)).toBe(16n);
    const reverted = await rpc.call({ to: ADDRESS, data: '0x' }).catch((e: unknown) => e);
    expect(reverted).toBeInstanceOf(EvmRpcError);
    expect(reverted).toMatchObject({ kind: 'rpc_error', rpcCode: 3, data: '0x08c379a0' });
  });

  it('times out a hung endpoint and moves on', async () => {
    stubFetch((endpoint, _m, _p, signal) =>
      endpoint === 0 ? new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('timeout')))) : { result: '0x3' },
    );
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC], { timeoutMs: 50 });
    expect(await rpc.transactionCount(ADDRESS, 'pending')).toBe(3);
  });

  it('parses receipts (OP Stack l1Fee too), blocks and eth_call with a state override; refuses a receipt of another transaction', async () => {
    let seenParams: unknown[] = [];
    stubFetch((_e, method, params) => {
      if (method === 'eth_getTransactionReceipt')
        return {
          result: {
            transactionHash: params[0] === HASH ? HASH : `0x${'33'.repeat(32)}`,
            status: '0x1',
            blockNumber: '0x10',
            gasUsed: '0x5208',
            effectiveGasPrice: '0x3b9aca00',
            l1Fee: '0x64',
            logs: [{ address: ADDRESS, topics: [HASH], data: '0x00' }],
          },
        };
      if (method === 'eth_getBlockByNumber') return { result: { number: '0x10', timestamp: '0x20', baseFeePerGas: '0x7' } };
      seenParams = params;
      return { result: '0xabcd' };
    });
    const rpc = new SponsorChain(31337, [PRIMARY_RPC]);
    expect(await rpc.receipt(HASH)).toEqual({ transactionHash: HASH, status: 1, blockNumber: 16n, gasUsed: 21000n, effectiveGasPrice: 10n ** 9n, l1Fee: 100n, logs: [{ address: ADDRESS, topics: [HASH], data: '0x00' }] });
    await expect(rpc.receipt(`0x${'44'.repeat(32)}`)).rejects.toMatchObject({ kind: 'bad_response' });
    expect(await rpc.latestBlock()).toEqual({ number: 16n, timestamp: 32n, baseFeePerGas: 7n });
    expect(await rpc.call({ from: ADDRESS, to: ADDRESS, data: '0x12', gas: 100n }, { stateOverride: { [ADDRESS]: { code: '0xef01' } } })).toBe('0xabcd');
    expect(seenParams).toEqual([{ to: ADDRESS, data: '0x12', from: ADDRESS, gas: '0x64' }, 'latest', { [ADDRESS]: { code: '0xef01' } }]);
  });
});

describe('SponsorChain.broadcast', () => {
  const raw = `0x02${'ab'.repeat(40)}` as Hex;

  it('accepted: the first endpoint that takes it (or already has it); the hash is always keccak256 of the raw', async () => {
    const { calls } = stubFetch((endpoint) => (endpoint === 0 ? 'network' : { result: HASH }));
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    expect(await rpc.broadcast(raw)).toEqual({ kind: 'accepted', hash: rawTxHash(raw) });
    expect(calls.filter((c) => c.method === 'eth_sendRawTransaction').map((c) => c.endpoint)).toEqual([0, 1]);
    vi.restoreAllMocks();
    stubFetch(() => ({ error: { code: -32000, message: 'already known' } }));
    expect(await rpc.broadcast(raw)).toEqual({ kind: 'accepted', hash: rawTxHash(raw) });
  });

  it('rejected only when every endpoint reached refused it definitely; unknown when any gave no definite answer; unsent when none was reached', async () => {
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    stubFetch(() => ({ error: { code: -32000, message: 'insufficient funds for gas * price + value' } }));
    expect(await rpc.broadcast(raw)).toEqual({ kind: 'rejected', reason: 'insufficient_funds' });
    vi.restoreAllMocks();
    stubFetch((endpoint) => (endpoint === 0 ? { error: { code: -32000, message: 'transaction underpriced' } } : { error: { code: -32000, message: 'nonce too low' } }));
    expect(await rpc.broadcast(raw)).toEqual({ kind: 'rejected', reason: 'nonce_too_low' });
    for (const second of ['network', new Response('bad gateway', { status: 502 }), { error: { code: -32005, message: 'limit exceeded' } }, { error: { code: -32000, message: 'something odd' } }, { result: 'not a hash' }]) {
      vi.restoreAllMocks();
      stubFetch((endpoint) => (endpoint === 0 ? { error: { code: -32000, message: 'insufficient funds' } } : second instanceof Response ? second.clone() : second));
      expect(await rpc.broadcast(raw)).toEqual({ kind: 'unknown' });
    }
    vi.restoreAllMocks();
    forgetVerifiedChains();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Network connection lost.'));
    expect(await rpc.broadcast(raw)).toEqual({ kind: 'unsent' });
    expect(await rpc.broadcast('nope' as Hex)).toEqual({ kind: 'unsent' });
  });

  it('classifies the nodes’ pool messages', () => {
    expect(classifyRejection('already known')).toBe('already_known');
    expect(classifyRejection('Known transaction: 0xabc')).toBe('already_known');
    expect(classifyRejection('nonce too low: next nonce 5, tx nonce 4')).toBe('nonce_too_low');
    expect(classifyRejection('replacement transaction underpriced')).toBe('replacement_underpriced');
    expect(classifyRejection('transaction underpriced: tip needed 1, tip permitted 0')).toBe('underpriced');
    expect(classifyRejection('insufficient funds for gas * price + value: balance 0')).toBe('insufficient_funds');
    expect(classifyRejection('max fee per gas less than block base fee: address 0x, maxFeePerGas: 1, baseFee: 2')).toBe('fee_below_base_fee');
    expect(classifyRejection('intrinsic gas too low')).toBe('gas_limit');
    expect(classifyRejection('exceeds block gas limit')).toBe('gas_limit');
    expect(classifyRejection('invalid sender')).toBe('invalid_transaction');
    expect(classifyRejection('nonce too high')).toBe('nonce_too_high');
    expect(classifyRejection('internal error')).toBeNull();
    expect(classifyRejection('limit exceeded')).toBeNull();
  });

  it('never puts a URL in an error or a log line', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    stubFetch(() => 'network');
    const rpc = new SponsorChain(31337, ['https://keyed.test.invalid/v2/secret-api-key', PRIMARY_RPC, FALLBACK_RPC]);
    const err = (await rpc.code(ADDRESS).catch((e: unknown) => e)) as Error;
    await rpc.broadcast(raw);
    expect(err.message).toBe('EVM RPC unavailable');
    const all = `${lines.join('\n')}\n${err.message}\n${err.stack ?? ''}`;
    for (const s of ['secret-api-key', 'keyed.test', 'evm-primary', 'evm-fallback']) expect(all).not.toContain(s);
  });
});
