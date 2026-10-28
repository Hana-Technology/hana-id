// createSodaxEvmProvider (docs/batch-b-spec.md "Sodax adapter"; Tests → Sodax → "EVM: one provider per chain; creating
// one for an unconfigured chain throws; sendTransaction(rawTx) with the SDK's one-argument call pins the bound chain,
// fills, approves and broadcasts; a from other than the vault's address is refused; receipt number fields are
// stringified"), over the real hana.ethereum, a scripted vault and fake chain RPCs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HanaError } from '@hana-id/web';
import { EVM_RECEIPT_POLL_MS, EVM_RECEIPT_TIMEOUT_MS, createSodaxEvmProvider } from '../src/index.ts';
import { EVM, FakeNetwork, FakePort, OTHER_EVM, evmHana, rejection } from './helpers.ts';

const BASE = 8453;
const ARB = 42161;
const BASE_RPC = 'https://base.rpc.test';
const ARB_RPC = 'https://arb.rpc.test';
const RECEIPTS = 'https://base.receipts.test';
const EVM_CONFIG = {
  chains: [
    { id: ARB, rpcUrl: ARB_RPC },
    { id: BASE, rpcUrl: BASE_RPC },
  ],
  defaultChainId: ARB,
};
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SPOKE = '0x00000000000000000000000000000000000000bb';
const HASH = `0x${'ab'.repeat(32)}` as const;
const BLOCK = `0x${'cd'.repeat(32)}`;
const TOPIC = `0x${'ef'.repeat(32)}`;
/** ERC20.approve(spender, amount), as the SDK encodes it before a deposit. */
const APPROVE = `0x095ea7b3${SPOKE.slice(2).padStart(64, '0')}${(10n ** 6n).toString(16).padStart(64, '0')}` as const;
const DEPOSIT = `0xb6b55f25${(10n ** 6n).toString(16).padStart(64, '0')}` as const;

let net: FakeNetwork;
let port: FakePort;
let signed: { tx: Record<string, string> }[];

/** A chain RPC whose pending nonce counts the raw transactions it has accepted. */
function chain(url: string, hash: string = HASH) {
  let sent = 0;
  net.rpc.set(url, {
    eth_getTransactionCount: () => `0x${(3 + sent).toString(16)}`,
    eth_estimateGas: '0xb411',
    eth_getBlockByNumber: { baseFeePerGas: '0x3b9aca00' },
    eth_maxPriorityFeePerGas: '0x59682f00',
    eth_sendRawTransaction: () => {
      sent += 1;
      return hash;
    },
  });
}

beforeEach(() => {
  net = new FakeNetwork();
  vi.stubGlobal('fetch', net.fetch);
  chain(BASE_RPC);
  chain(ARB_RPC, `0x${'a1'.repeat(32)}`);
  signed = [];
  port = new FakePort({
    eth_accounts: () => [EVM],
    eth_signTransaction: (p) => {
      signed.push(p as { tx: Record<string, string> });
      return `0x02f8${signed.length.toString(16).padStart(2, '0')}`;
    },
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => {
  const hana = evmHana(port, net, EVM_CONFIG);
  return { hana, base: createSodaxEvmProvider(hana, { chainId: BASE, rpcUrl: RECEIPTS }) };
};

describe('creation', () => {
  it("is chainType 'EVM' with every IEvmWalletProvider member, frozen", () => {
    const { base } = setup();
    expect(base.chainType).toBe('EVM');
    for (const m of ['getWalletAddress', 'sendTransaction', 'waitForTransactionReceipt'] as const) expect(typeof base[m]).toBe('function');
    expect(Object.isFrozen(base)).toBe(true);
  });

  it("throws 4902 for a chain that isn't in the client's evm.chains, or without evm config", () => {
    const hana = evmHana(port, net, EVM_CONFIG);
    const e = (() => {
      try {
        createSodaxEvmProvider(hana, { chainId: 1, rpcUrl: RECEIPTS });
      } catch (err) {
        return err;
      }
      return null;
    })();
    expect(e).toBeInstanceOf(HanaError);
    expect(e).toMatchObject({ code: 4902, data: { chainId: '0x1' } });
    expect(() => createSodaxEvmProvider(evmHana(port, net, undefined), { chainId: BASE, rpcUrl: RECEIPTS })).toThrow(/evm\.chains/u);
  });

  it('validates the client and the config', () => {
    const hana = evmHana(port, net, EVM_CONFIG);
    expect(() => createSodaxEvmProvider({} as never, { chainId: BASE, rpcUrl: RECEIPTS })).toThrow(/Hana client/u);
    expect(() => createSodaxEvmProvider(hana, null as never)).toThrow(TypeError);
    for (const chainId of [0, -1, 1.5, '8453', Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => createSodaxEvmProvider(hana, { chainId: chainId as never, rpcUrl: RECEIPTS })).toThrow(/chainId/u);
    }
    expect(() => createSodaxEvmProvider(hana, { chainId: BASE, rpcUrl: 'ws://base.test' })).toThrow(/rpcUrl/u);
  });
});

describe('getWalletAddress', () => {
  it('is eth_requestAccounts: the address at once when logged in, a login when not', async () => {
    const { hana, base } = setup();
    await expect(base.getWalletAddress()).resolves.toBe(EVM);
    expect(hana.session.login).not.toHaveBeenCalled();
    hana.session.addresses = null;
    await expect(base.getWalletAddress()).resolves.toBe(EVM);
    expect(hana.session.login).toHaveBeenCalledTimes(1);
  });
});

describe('sendTransaction', () => {
  it("the SDK's one-argument call pins the bound chain, fills from its RPC, signs with approval and broadcasts", async () => {
    const { hana, base } = setup();
    const changed: string[] = [];
    hana.ethereum.on('chainChanged', (c) => changed.push(c));
    expect(hana.ethereum.chainId).toBe('0xa4b1');
    // As @sodax/sdk 2.1.0 calls it: getWalletAddress(), then sendTransaction({from, to, value: 0n, data}).
    const from = await base.getWalletAddress();
    await expect(base.sendTransaction({ from, to: USDC, value: 0n, data: APPROVE })).resolves.toBe(HASH);
    expect(hana.ethereum.chainId).toBe('0x2105');
    expect(changed).toEqual(['0x2105']);
    expect(signed).toEqual([
      { tx: { type: '0x2', from: EVM, chainId: '0x2105', nonce: '0x3', gas: '0xb411', to: USDC, value: '0x0', data: APPROVE, maxFeePerGas: '0xd09dc300', maxPriorityFeePerGas: '0x59682f00' } },
    ]);
    expect(net.rpcCalls(BASE_RPC, 'eth_sendRawTransaction').map((c) => c.params)).toEqual([['0x02f801']]);
    // Filling and broadcasting use createHana's RPC for the chain; the receipt RPC isn't touched.
    expect(net.calls.every((c) => c.url === BASE_RPC)).toBe(true);
  });

  it('passes a native value as a 0x quantity, and accepts `from` in any case', async () => {
    const { base } = setup();
    await base.sendTransaction({ from: EVM.toLowerCase() as `0x${string}`, to: SPOKE, value: 10n ** 18n, data: '0x' });
    expect(signed[0]?.tx).toMatchObject({ from: EVM, value: '0xde0b6b3a7640000', data: '0x' });
  });

  it('back-to-back sends (approve, then deposit) get consecutive nonces', async () => {
    const { base } = setup();
    await base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE });
    await base.sendTransaction({ from: EVM, to: SPOKE, value: 0n, data: DEPOSIT });
    expect(signed.map((s) => [s.tx.nonce, s.tx.to])).toEqual([
      ['0x3', USDC],
      ['0x4', SPOKE],
    ]);
  });

  it('one provider per chain: providers for two chains sending at once each sign and broadcast on their own chain', async () => {
    const { hana, base } = setup();
    const arb = createSodaxEvmProvider(hana, { chainId: ARB, rpcUrl: 'https://arb.receipts.test' });
    const results = await Promise.all([base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }), arb.sendTransaction({ from: EVM, to: SPOKE, value: 0n, data: DEPOSIT })]);
    expect(results).toEqual([HASH, `0x${'a1'.repeat(32)}`]);
    expect(signed.map((s) => [s.tx.chainId, s.tx.to])).toEqual([
      ['0x2105', USDC],
      ['0xa4b1', SPOKE],
    ]);
    expect(net.rpcCalls(BASE_RPC, 'eth_sendRawTransaction')).toHaveLength(1);
    expect(net.rpcCalls(ARB_RPC, 'eth_sendRawTransaction')).toHaveLength(1);
  });

  it('refuses a from other than the vault address (4100), and a logged-out user (4100), before anything else', async () => {
    const { hana, base } = setup();
    expect(await rejection(base.sendTransaction({ from: OTHER_EVM, to: USDC, value: 0n, data: APPROVE }))).toMatchObject({ code: 4100 });
    hana.session.addresses = null;
    expect(await rejection(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }))).toMatchObject({ code: 4100 });
    expect(port.calls).toEqual([]);
    expect(net.calls).toEqual([]);
    expect(hana.ethereum.chainId).toBe('0xa4b1');
  });

  it('refuses a malformed raw transaction (-32602) without a request', async () => {
    const { base } = setup();
    const ok = { from: EVM, to: USDC, value: 0n, data: APPROVE };
    for (const bad of [null, { ...ok, from: 'me' }, { ...ok, to: undefined }, { ...ok, to: '0x12' }, { ...ok, value: 1 }, { ...ok, value: -1n }, { ...ok, value: 1n << 256n }, { ...ok, data: '0xabc' }, { ...ok, data: 'ab' }]) {
      expect((await rejection(base.sendTransaction(bad as never))).code).toBe(-32602);
    }
    expect(port.calls).toEqual([]);
    expect(net.calls).toEqual([]);
  });

  it('a rejected approval is 4001, broadcasts nothing, and does not block the next send', async () => {
    const { base } = setup();
    const approve = port.handlers.eth_signTransaction!;
    port.handlers.eth_signTransaction = () => {
      throw new HanaError(4001, 'User rejected');
    };
    expect((await rejection(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }))).code).toBe(4001);
    expect(net.rpcCalls(BASE_RPC, 'eth_sendRawTransaction')).toEqual([]);
    port.handlers.eth_signTransaction = approve;
    await expect(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE })).resolves.toBe(HASH);
  });

  it('a partner page switching chains while the transaction is filled gets a refusal, never a send on another chain', async () => {
    const { hana, base } = setup();
    const p = base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE });
    // Let the adapter's switch land, then switch away while hana.ethereum fills from the RPC.
    await Promise.resolve();
    await Promise.resolve();
    await hana.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0xa4b1' }] });
    const e = await rejection(p);
    expect(e.message).toMatch(/chain changed/u);
    expect(signed).toEqual([]);
  });
});

describe('waitForTransactionReceipt', () => {
  const rpcReceipt = (over: Record<string, unknown> = {}) => ({
    transactionHash: HASH,
    transactionIndex: '0x5',
    blockHash: BLOCK,
    blockNumber: '0x123',
    from: EVM.toLowerCase(),
    to: USDC.toLowerCase(),
    cumulativeGasUsed: '0x1e8480',
    gasUsed: '0xb411',
    contractAddress: null,
    logs: [
      {
        address: USDC.toLowerCase(),
        topics: [TOPIC],
        data: `0x${'00'.repeat(31)}01`,
        blockHash: BLOCK,
        blockNumber: '0x123',
        logIndex: '0x0',
        transactionHash: HASH,
        transactionIndex: '0x5',
        removed: false,
      },
    ],
    logsBloom: `0x${'00'.repeat(256)}`,
    status: '0x1',
    type: '0x2',
    effectiveGasPrice: '0x3b9aca00',
    ...over,
  });

  it("polls the provider's rpcUrl every 2 s and returns the receipt with number fields stringified", async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { base } = setup();
    let n = 0;
    net.rpc.set(RECEIPTS, { eth_getTransactionReceipt: () => (++n < 3 ? null : rpcReceipt()) });
    const p = base.waitForTransactionReceipt(HASH);
    await vi.advanceTimersByTimeAsync(2 * EVM_RECEIPT_POLL_MS);
    const r = await p;
    expect(r).toEqual({
      ...rpcReceipt(),
      transactionIndex: '5',
      blockNumber: '291',
      cumulativeGasUsed: '2000000',
      gasUsed: '46097',
      effectiveGasPrice: '1000000000',
      status: 'success',
      type: 'eip1559',
    });
    // Logs keep the RPC's hex, as EvmRawLog declares.
    expect(r.logs[0]).toEqual(rpcReceipt().logs[0]);
    expect(net.rpcCalls(RECEIPTS).map((c) => [c.rpc, c.params, c.at - 5_000_000])).toEqual([0, 2000, 4000].map((t) => ['eth_getTransactionReceipt', [HASH], t]));
  });

  it('maps a reverted status and the legacy type, stringifies blob fields, and keeps a contract address', async () => {
    const { base } = setup();
    const created = '0x00000000000000000000000000000000000000cc';
    net.rpc.set(RECEIPTS, { eth_getTransactionReceipt: rpcReceipt({ status: '0x0', type: '0x0', to: null, contractAddress: created, blobGasUsed: '0x20000', blobGasPrice: '0x1' }) });
    expect(await base.waitForTransactionReceipt(HASH)).toMatchObject({ status: 'reverted', type: 'legacy', to: null, contractAddress: created, blobGasUsed: '131072', blobGasPrice: '1' });
  });

  it('retries RPC faults, and gives up after 180 s with receipt_timeout (not before)', async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { base } = setup();
    net.rpc.set(RECEIPTS, {
      eth_getTransactionReceipt: () => {
        throw { code: -32005, message: 'rate limited' };
      },
    });
    let settled = false;
    const p = base.waitForTransactionReceipt(HASH).finally(() => {
      settled = true;
    });
    const e = rejection(p);
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await e).toMatchObject({ code: -32603, data: { reason: 'receipt_timeout', hash: HASH, chainId: '0x2105', lastError: expect.stringMatching(/rate limited/u) } });
    expect(net.rpcCalls(RECEIPTS)).toHaveLength(EVM_RECEIPT_TIMEOUT_MS / EVM_RECEIPT_POLL_MS + 1);
  });

  it('a transient fault then the receipt resolves', async () => {
    vi.useFakeTimers();
    const { base } = setup();
    let n = 0;
    net.rpc.set(RECEIPTS, {
      eth_getTransactionReceipt: () => {
        if (++n === 1) throw { code: -32000, message: 'header not found' };
        return rpcReceipt();
      },
    });
    const p = base.waitForTransactionReceipt(HASH);
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_POLL_MS);
    await expect(p).resolves.toMatchObject({ status: 'success' });
  });

  it('a receipt for another transaction or with malformed fields is refused', async () => {
    const { base } = setup();
    for (const over of [
      { transactionHash: `0x${'00'.repeat(32)}` },
      { blockNumber: 291 },
      { blockNumber: '0x0123' },
      { gasUsed: undefined },
      { status: '0x2' },
      { logs: [{ address: 'x' }] },
      { logs: null },
      { from: '0x12' },
    ]) {
      net.rpc.set(RECEIPTS, { eth_getTransactionReceipt: rpcReceipt(over) });
      expect((await rejection(base.waitForTransactionReceipt(HASH))).message).toMatch(/malformed receipt/u);
    }
  });

  it('refuses a malformed hash without a request', async () => {
    const { base } = setup();
    for (const h of ['', HASH.slice(0, 10), 'ab'.repeat(32), 42]) expect((await rejection(base.waitForTransactionReceipt(h as never))).code).toBe(-32602);
    expect(net.calls).toEqual([]);
  });
});
