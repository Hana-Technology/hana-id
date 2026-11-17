// The sponsorship RPC client (evm/sponsor-chain.ts, D837): endpoint order, the per-isolate chain check, read failover,
// the broadcast's four outcomes, rejection classes, response checks, and no URL in any error or log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVM_RPC_CHAIN_CHECK_RETRY_MS, EVM_RPC_CHAIN_CHECK_TTL_MS, EVM_RPC_MAX_RESPONSE_CHARS, EvmRpcError, SponsorChain, classifyRejection, forgetVerifiedChains, rawTxHash, sponsorRpcUrls } from '../src/evm/sponsor-chain.ts';
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
    // A new client (one per section): the old one skips the endpoints that gave no answer.
    const rpc2 = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    expect(await rpc2.balance(ADDRESS)).toBe(16n);
    const reverted = await rpc2.call({ to: ADDRESS, data: '0x' }).catch((e: unknown) => e);
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

describe('SponsorChain limits and caches (L1, L2, L4)', () => {
  it('an endpoint that timed out once is skipped for the rest of the client’s life (one section)', async () => {
    const { calls } = stubFetch((endpoint, _m, _p, signal) =>
      endpoint === 0 ? new Promise((_, reject) => signal?.addEventListener('abort', () => reject(new Error('timeout')))) : { result: '0x3' },
    );
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC], { timeoutMs: 50 });
    expect(await rpc.transactionCount(ADDRESS, 'pending')).toBe(3);
    expect(await rpc.transactionCount(ADDRESS, 'latest')).toBe(3);
    expect(await rpc.code(ADDRESS).catch(() => 'x')).toBe('x');
    expect(calls.filter((c) => c.endpoint === 0 && c.method !== 'eth_chainId')).toHaveLength(1);
  });

  it('a failed chain-ID check keeps the endpoint out for 30 s (unless every endpoint failed); a verified one is re-checked after 10 minutes', async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const chain = new EvmMock({ chainId: 31337 }).install();
    chain.modes[0] = 'down';
    expect(await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest')).toBe(0);
    chain.modes[0] = 'up';
    const before = chain.calls.filter((c) => c.endpoint === 0).length;
    expect(await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest')).toBe(0);
    expect(chain.calls.filter((c) => c.endpoint === 0).length).toBe(before);
    now += EVM_RPC_CHAIN_CHECK_RETRY_MS;
    await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest');
    expect(chain.calls.filter((c) => c.endpoint === 0).map((c) => c.method).slice(-2)).toEqual(['eth_chainId', 'eth_getTransactionCount']);
    // Both failed recently: both are tried anyway.
    forgetVerifiedChains();
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest').catch(() => undefined);
    chain.modes[0] = 'up';
    chain.modes[1] = 'up';
    expect(await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest')).toBe(0);
    // The verified answer expires after 10 minutes.
    const checks = () => chain.calls.filter((c) => c.method === 'eth_chainId').length;
    const n = checks();
    await new SponsorChain(31337, [PRIMARY_RPC]).transactionCount(ADDRESS, 'latest');
    expect(checks()).toBe(n);
    now += EVM_RPC_CHAIN_CHECK_TTL_MS;
    await new SponsorChain(31337, [PRIMARY_RPC]).transactionCount(ADDRESS, 'latest');
    expect(checks()).toBe(n + 1);
  });

  it('makes at most maxRequests fetches; past it reads fail as unavailable and a broadcast is unsent', async () => {
    const { calls } = stubFetch(() => ({ result: '0x1' }));
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC], { maxRequests: 3 });
    expect(await rpc.transactionCount(ADDRESS, 'latest')).toBe(1);
    expect(await rpc.transactionCount(ADDRESS, 'latest')).toBe(1);
    await expect(rpc.transactionCount(ADDRESS, 'latest')).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await rpc.broadcast(`0x02${'ab'.repeat(40)}` as Hex)).toEqual({ kind: 'unsent' });
    expect(calls).toHaveLength(3);
    expect(rpc.exhausted).toBe(true);
  });

  it('abandons a body past the size limit, read as a stream', async () => {
    stubFetch((endpoint) => (endpoint === 0 ? new Response(`{"jsonrpc":"2.0","id":2,"result":"0x1","pad":"${'x'.repeat(EVM_RPC_MAX_RESPONSE_CHARS)}"}`) : { result: '0x2' }));
    expect(await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).transactionCount(ADDRESS, 'latest')).toBe(2);
  });

  it('snapshot: each endpoint’s counts at ONE common block (the lowest head; the lowest safe block, else head − N); a lagging or inflated head never leaves anyone out', async () => {
    const chain = new EvmMock({ chainId: 31337 }).install();
    chain.setMined(ADDRESS, 4);
    chain.minedCount.set(ADDRESS.toLowerCase(), 6);
    (chain as unknown as { history: { number: number; counts: Map<string, number> }[] }).history.push({ number: 101, counts: new Map([[ADDRESS.toLowerCase(), 6]]) });
    chain.blockNumber = 102;
    chain.safeDepth = 2;
    const rpc = new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]);
    expect(await rpc.snapshot(ADDRESS, { confirmations: 3, safeTag: false, lagLimit: 8 })).toEqual({
      endpoints: [
        { endpoint: 0, head: 102, pending: 6, ownLatest: 6, latest: 6, confirmed: 4 },
        { endpoint: 1, head: 102, pending: 6, ownLatest: 6, latest: 6, confirmed: 4 },
      ],
      latestBlock: 102,
      confirmedBlock: 99,
      lagging: [],
    });
    expect((await rpc.snapshot(ADDRESS, { confirmations: 3, safeTag: true, lagLimit: 8 })).confirmedBlock).toBe(100);
    // A fallback 1 block behind: both are read at its head (block 101), where they agree.
    chain.lag[1] = 1;
    const one = await rpc.snapshot(ADDRESS, { confirmations: 0, safeTag: false, lagLimit: 8 });
    expect(one).toMatchObject({ latestBlock: 101, lagging: [] });
    expect(one.endpoints.map((c) => c.latest)).toEqual([6, 6]);
    // Far behind: reported as lagging, still the comparison block (the lowest head is the reference: no endpoint's
    // claimed head can push the others out).
    chain.lag[1] = 20;
    expect(await rpc.snapshot(ADDRESS, { confirmations: 3, safeTag: false, lagLimit: 8 })).toMatchObject({ latestBlock: 82, lagging: [1] });
    chain.lag[1] = 0;
    chain.headBoost[0] = 1_000;
    // (A new client: this one's request budget is spent.)
    const boosted = await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).snapshot(ADDRESS, { confirmations: 3, safeTag: false, lagLimit: 8 });
    expect(boosted).toMatchObject({ latestBlock: 102, lagging: [1] });
    chain.headBoost[0] = 0;
    chain.supportsSafe = false;
    chain.lag[1] = 0;
    expect((await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).snapshot(ADDRESS, { confirmations: 3, safeTag: true, lagLimit: 8 })).confirmedBlock).toBe(99);
  });

  it('logs and eth_call at a block', async () => {
    let seen: unknown[] = [];
    stubFetch((_e, method, params) => {
      seen = params;
      if (method === 'eth_getLogs') return { result: [{ address: ADDRESS, topics: [HASH], data: '0x', transactionHash: HASH, blockNumber: '0x5' }] };
      return { result: `0x${'00'.repeat(31)}07` };
    });
    const rpc = new SponsorChain(31337, [PRIMARY_RPC]);
    expect(await rpc.logs({ address: ADDRESS, topics: [HASH, null], fromBlock: 1n, toBlock: 9n })).toEqual([{ address: ADDRESS, topics: [HASH], data: '0x', transactionHash: HASH, blockNumber: 5n }]);
    expect(seen).toEqual([{ address: ADDRESS, topics: [HASH, null], fromBlock: '0x1', toBlock: '0x9' }]);
    expect(BigInt(await rpc.call({ to: ADDRESS, data: '0xaffed0e0' }, { block: 12n }))).toBe(7n);
    expect(seen).toEqual([{ to: ADDRESS, data: '0xaffed0e0' }, '0xc']);
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
      expect(await new SponsorChain(31337, [PRIMARY_RPC, FALLBACK_RPC]).broadcast(raw)).toEqual({ kind: 'unknown' });
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
