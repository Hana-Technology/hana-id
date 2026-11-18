// The sponsorship RPC client (evm/sponsor-chain.ts, D851) against the fake chain: one trusted read endpoint (the keyed
// secret, else `rpc`) with no failover, broadcasts to every configured URL with the same raw, the chain-ID check and
// its expiry, the fetch budget, the body limit, receipt parsing (OP Stack fees) and no URL in any error or log.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EVM_RPC_CHAIN_CHECK_RETRY_MS, EVM_RPC_CHAIN_CHECK_TTL_MS, EvmRpcError, SponsorChain, classifyRejection, forgetVerifiedChains, receiptCostWei, sponsorRpcEndpoints } from '../src/evm/sponsor-chain.ts';
import { EvmMock, FALLBACK_RPC, type Hex, PRIMARY_RPC } from './evm-mock.ts';

const KEYED = 'https://keyed.test.invalid/v2/SECRET-PROVIDER-KEY';
const ADDR = '0x1111111111111111111111111111111111111111' as Hex;
const chainCfg = { chainId: 31337, rpc: PRIMARY_RPC, rpcFallback: FALLBACK_RPC };
const client = (opts: { maxRequests?: number } = {}) => new SponsorChain(31337, sponsorRpcEndpoints({}, chainCfg), { timeoutMs: 200, ...opts });

let chain: EvmMock;
let now = 1_800_000_000_000;
beforeEach(() => {
  forgetVerifiedChains();
  now = 1_800_000_000_000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  chain = new EvmMock().install();
});
afterEach(() => vi.restoreAllMocks());

describe('sponsorRpcEndpoints', () => {
  it('reads from the keyed secret when it is an https URL, else from rpc; broadcasts to the read endpoint, then the others, each once', () => {
    expect(sponsorRpcEndpoints({}, chainCfg)).toEqual({ read: PRIMARY_RPC, broadcast: [PRIMARY_RPC, FALLBACK_RPC] });
    expect(sponsorRpcEndpoints({ EVM_SPONSOR_RPC_31337: KEYED }, chainCfg)).toEqual({ read: KEYED, broadcast: [KEYED, FALLBACK_RPC, PRIMARY_RPC] });
    expect(sponsorRpcEndpoints({ EVM_SPONSOR_RPC_31337: 'http://keyed.test.invalid' }, chainCfg).read).toBe(PRIMARY_RPC);
    expect(sponsorRpcEndpoints({ EVM_SPONSOR_RPC_31337: 'not a url' }, chainCfg).read).toBe(PRIMARY_RPC);
    expect(sponsorRpcEndpoints({ EVM_SPONSOR_RPC_84532: KEYED }, chainCfg).read).toBe(PRIMARY_RPC);
    expect(sponsorRpcEndpoints({}, { ...chainCfg, rpcFallback: null }).broadcast).toEqual([PRIMARY_RPC]);
  });
});

describe('reads: the trusted endpoint only', () => {
  it('never read from the fallback, even when the read endpoint fails: unavailable, wrong_chain or bad_response', async () => {
    chain.setMined(ADDR, 4);
    expect(await client().transactionCount(ADDR, 'pending')).toBe(4);
    for (const [mode, kind] of [
      ['down', 'unavailable'],
      ['http503', 'unavailable'],
      ['rate_limited', 'unavailable'],
      ['garbage', 'unavailable'],
    ] as const) {
      chain.modes[0] = mode;
      await expect(client().transactionCount(ADDR, 'latest')).rejects.toMatchObject({ kind });
    }
    expect(chain.calls.filter((c) => c.endpoint === 1)).toEqual([]);
    forgetVerifiedChains();
    chain.modes[0] = 'wrong_chain';
    await expect(client().blockNumber()).rejects.toMatchObject({ kind: 'wrong_chain' });
    expect(chain.calls.filter((c) => c.endpoint === 1)).toEqual([]);
  });

  it('checks eth_chainId once per isolate, again after 10 minutes; a failed check keeps the endpoint out for 30 s', async () => {
    await client().blockNumber();
    await client().blockNumber();
    expect(chain.calls.filter((c) => c.method === 'eth_chainId')).toHaveLength(1);
    now += EVM_RPC_CHAIN_CHECK_TTL_MS;
    await client().blockNumber();
    expect(chain.calls.filter((c) => c.method === 'eth_chainId')).toHaveLength(2);
    forgetVerifiedChains();
    chain.modes[0] = 'down';
    await expect(client().blockNumber()).rejects.toBeInstanceOf(EvmRpcError);
    chain.modes[0] = 'up';
    const before = chain.calls.length;
    await expect(client().blockNumber()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(chain.calls.length).toBe(before);
    now += EVM_RPC_CHAIN_CHECK_RETRY_MS;
    expect(await client().blockNumber()).toBe(100);
  });

  it('a node’s own error is final (rpc_error with its revert data); safe falls back to null when the node has no such tag', async () => {
    await expect(client().call({ to: ADDR, data: '0x' })).rejects.toMatchObject({ kind: 'rpc_error', rpcCode: 3, data: '0x08c379a0' });
    expect(await client().safeBlockNumber()).toBe(98);
    chain.supportsSafe = false;
    expect(await client().safeBlockNumber()).toBeNull();
  });

  it('parses receipts with the OP Stack fees (l1Fee, operator fee) and refuses a receipt of another transaction', async () => {
    const { signSponsorTx } = await import('@hana-id/core/evm-sponsor');
    const key = new Uint8Array(32).fill(7);
    const raw = signSponsorTx(key, { type: 'eip1559', chainId: 31337n, nonce: 0n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gas: 21_000n, to: new Uint8Array(20).fill(1), value: 0n, data: new Uint8Array(), accessList: [] });
    const c = client();
    expect(await c.broadcast(raw)).toMatchObject({ kind: 'accepted' });
    const [tx] = chain.mine(chain.broadcasts[0]!.tx.from);
    chain.receiptExtras = { l1Fee: '0x64', operatorFeeScalar: '0xf4240', operatorFeeConstant: '0x5' };
    const r = (await client().receipt(tx!.hash))!;
    expect(r).toMatchObject({ status: 1, gasUsed: 21_000n, effectiveGasPrice: 1_000_000_000n, l1Fee: 100n, operatorFee: 21_005n });
    expect(receiptCostWei(r)).toBe(21_000n * 1_000_000_000n + 100n + 21_005n);
    chain.receiptExtras = { transactionHash: `0x${'ab'.repeat(32)}` };
    await expect(client().receipt(tx!.hash)).rejects.toMatchObject({ kind: 'bad_response' });
    chain.receiptExtras = {};
    expect(await client().receipt(`0x${'cd'.repeat(32)}`)).toBeNull();
  });

  it('makes at most maxRequests fetches, then fails as unavailable (and a broadcast is unsent); a body past 2 MiB is abandoned', async () => {
    const c = client({ maxRequests: 3 });
    await c.blockNumber();
    await c.blockNumber();
    await expect(c.blockNumber()).rejects.toMatchObject({ kind: 'unavailable' });
    expect(await c.broadcast('0x02c0')).toEqual({ kind: 'unsent' });
    chain.hugeResponse = 2 * 1024 * 1024 + 10;
    await expect(client().transactionCount(ADDR, 'latest')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('broadcast', () => {
  const raw = async (nonce = 0n) => {
    const { signSponsorTx } = await import('@hana-id/core/evm-sponsor');
    return signSponsorTx(new Uint8Array(32).fill(9), { type: 'eip1559', chainId: 31337n, nonce, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n, gas: 21_000n, to: new Uint8Array(20).fill(1), value: 0n, data: new Uint8Array(), accessList: [] });
  };

  it('the same raw to the read endpoint, then the fallback when it gives no answer; accepted or already known; the hash is keccak256 of the raw', async () => {
    const r = await raw();
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? 'network' : undefined);
    const out = await client().broadcast(r);
    expect(out).toMatchObject({ kind: 'accepted', hash: chain.broadcasts[1]!.tx.hash });
    expect(chain.broadcasts.map((b) => [b.endpoint, b.tx.raw])).toEqual([
      [0, r.toLowerCase()],
      [1, r.toLowerCase()],
    ]);
    chain.onSend = undefined;
    expect(await client().broadcast(r)).toMatchObject({ kind: 'accepted' });
    expect(chain.broadcasts.at(-1)!.outcome).toBe('already_known');
  });

  it('rejected only when every endpoint reached refused it definitely; unknown when any gave no definite answer; unsent when none was reached', async () => {
    const r = await raw();
    chain.onSend = () => ({ error: 'insufficient funds for gas * price + value' });
    expect(await client().broadcast(r)).toEqual({ kind: 'rejected', reason: 'insufficient_funds', byRead: 'insufficient_funds' });
    chain.onSend = (_tx, endpoint) => (endpoint === 0 ? { error: 'insufficient funds' } : 'network');
    expect(await client().broadcast(r)).toEqual({ kind: 'unknown' });
    chain.onSend = undefined;
    chain.modes[0] = 'down';
    chain.modes[1] = 'down';
    forgetVerifiedChains();
    expect(await client().broadcast(r)).toEqual({ kind: 'unsent' });
  });

  it('a classified refusal whose text says "limit" is still definite (only unclassified texts can be transient)', async () => {
    const r = await raw();
    for (const [message, reason] of [
      ['exceeds block gas limit', 'gas_limit'],
      ['in-flight transaction limit reached for delegated accounts', 'sender_restricted'],
    ] as const) {
      chain.onSend = () => ({ error: message });
      expect(await client().broadcast(r)).toEqual({ kind: 'rejected', reason, byRead: reason });
    }
    chain.onSend = () => ({ error: 'rate limit exceeded' });
    expect(await client().broadcast(r)).toEqual({ kind: 'unknown' });
  });

  it('classifies the pools\' 7702 texts (go-ethereum and op-geth txpool)', () => {
    expect(classifyRejection('authority already reserved')).toBe('authority_reserved');
    expect(classifyRejection('in-flight transaction limit reached for delegated accounts')).toBe('sender_restricted');
    expect(classifyRejection('gapped-nonce tx from delegated accounts')).toBe('sender_restricted');
    expect(classifyRejection('address already reserved')).toBe('sender_restricted');
    expect(classifyRejection('transaction gas price below minimum')).toBe('underpriced');
    expect(classifyRejection('exceeds maximum per-transaction gas limit')).toBe('gas_limit');
  });

  it('classifies the nodes’ pool messages', () => {
    expect(classifyRejection('nonce too low: next nonce 5, tx nonce 4')).toBe('nonce_too_low');
    expect(classifyRejection('already known')).toBe('already_known');
    expect(classifyRejection('replacement transaction underpriced')).toBe('replacement_underpriced');
    expect(classifyRejection('max fee per gas less than block base fee')).toBe('fee_below_base_fee');
    expect(classifyRejection('transaction underpriced')).toBe('underpriced');
    expect(classifyRejection('intrinsic gas too low')).toBe('gas_limit');
    expect(classifyRejection('something else')).toBeNull();
  });

  it('classifies anvil’s own wording of the same conditions (captured by the anvil lane, D868)', () => {
    expect(classifyRejection('intrinsic gas too high -- tx.gas_limit > env.block.gas_limit')).toBe('gas_limit');
    expect(classifyRejection('Failed to decode transaction')).toBe('invalid_transaction');
    expect(classifyRejection('transaction already imported')).toBe('already_known');
    expect(classifyRejection('Insufficient funds for gas * price + value')).toBe('insufficient_funds');
    expect(classifyRejection('invalid chain id for signer')).toBe('invalid_transaction');
  });

  it('never puts a URL in an error or a log line', async () => {
    const lines: string[] = [];
    for (const m of ['log', 'warn', 'error'] as const) vi.spyOn(console, m).mockImplementation((...a: unknown[]) => void lines.push(a.map(String).join(' ')));
    const keyed = new EvmMock({ urls: [KEYED, PRIMARY_RPC, FALLBACK_RPC] }).install();
    keyed.modes[0] = 'wrong_chain';
    const c = new SponsorChain(31337, sponsorRpcEndpoints({ EVM_SPONSOR_RPC_31337: KEYED }, chainCfg));
    const err = (await c.blockNumber().then(() => new Error("no error"), (e: unknown) => e)) as Error;
    await c.broadcast(await raw());
    expect(`${err.message} ${String(err.stack)} ${lines.join('\n')}`).not.toMatch(/test\.invalid|SECRET-PROVIDER-KEY/u);
    expect(lines.length).toBeGreaterThan(0);
  });
});
