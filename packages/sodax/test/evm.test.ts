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

/** The receipt RPC (Base's): answers eth_chainId with Base's id, plus `answers`. */
function receipts(answers: Record<string, unknown> = {}, url = RECEIPTS, chainId = '0x2105') {
  net.rpc.set(url, { eth_chainId: chainId, ...answers });
}

beforeEach(() => {
  net = new FakeNetwork();
  vi.stubGlobal('fetch', net.fetch);
  chain(BASE_RPC);
  chain(ARB_RPC, `0x${'a1'.repeat(32)}`);
  receipts();
  receipts({}, 'https://arb.receipts.test', '0xa4b1');
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
  vi.restoreAllMocks();
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
    // Filling and broadcasting use createHana's RPC for the chain. The receipt RPC is only asked its chain id, first.
    expect(net.calls[0]).toMatchObject({ url: RECEIPTS, rpc: 'eth_chainId' });
    expect(net.calls.filter((c) => c.url !== BASE_RPC).map((c) => [c.url, c.rpc])).toEqual([[RECEIPTS, 'eth_chainId']]);
  });

  it("refuses a receipt rpcUrl on another chain with 4902 before anything is signed, and keeps refusing", async () => {
    const { hana } = setup();
    receipts({}, 'https://sepolia.test', '0xaa36a7');
    const base = createSodaxEvmProvider(hana, { chainId: BASE, rpcUrl: 'https://sepolia.test' });
    for (let i = 0; i < 2; i++) {
      expect(await rejection(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }))).toMatchObject({
        code: 4902,
        data: { reason: 'receipt_rpc_wrong_chain', chainId: '0x2105', rpcChainId: '0xaa36a7' },
      });
    }
    // A config error is not retried: one eth_chainId, and nothing switched, filled, signed or broadcast.
    expect(net.calls.map((c) => [c.url, c.rpc])).toEqual([['https://sepolia.test', 'eth_chainId']]);
    expect(port.calls).toEqual([]);
    expect(signed).toEqual([]);
    expect(hana.ethereum.chainId).toBe('0xa4b1');
  });

  it('an unreachable receipt RPC refuses the send (nothing signed), and the next send checks again', async () => {
    const { base } = setup();
    receipts({
      eth_chainId: () => {
        throw { code: -32005, message: 'rate limited' };
      },
    });
    expect(await rejection(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }))).toMatchObject({
      code: -32603,
      data: { reason: 'receipt_rpc_unreachable', chainId: '0x2105' },
    });
    expect(signed).toEqual([]);
    expect(net.rpcCalls(BASE_RPC)).toEqual([]);
    receipts();
    await expect(base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE })).resolves.toBe(HASH);
    await base.sendTransaction({ from: EVM, to: SPOKE, value: 0n, data: DEPOSIT });
    // Checked once it answered, then cached.
    expect(net.rpcCalls(RECEIPTS, 'eth_chainId')).toHaveLength(2);
  });

  it('opens the approval popup in the caller’s click (hana.prepareApproval, before the queue and any RPC), D95', async () => {
    const { hana } = setup();
    const cancel = vi.fn();
    const callsAtPrepare: number[] = [];
    const prepareApproval = vi.fn(() => {
      callsAtPrepare.push(net.calls.length);
      return { cancel };
    });
    const base = createSodaxEvmProvider({ ...hana, ethereum: hana.ethereum, addresses: hana.addresses, prepareApproval }, { chainId: BASE, rpcUrl: RECEIPTS });
    const p = base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE });
    expect(prepareApproval).toHaveBeenCalledTimes(1);
    expect(callsAtPrepare).toEqual([0]);
    await expect(p).resolves.toBe(HASH);
    expect(cancel).not.toHaveBeenCalled();
    // A send refused before anything was signed closes the window it opened.
    receipts({}, RECEIPTS, '0xaa36a7');
    const other = createSodaxEvmProvider({ ethereum: hana.ethereum, addresses: hana.addresses, prepareApproval }, { chainId: ARB, rpcUrl: RECEIPTS });
    await rejection(other.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE }));
    expect(cancel).toHaveBeenCalledTimes(1);
    // A from refused at once opens nothing.
    await rejection(base.sendTransaction({ from: OTHER_EVM, to: USDC, value: 0n, data: APPROVE }));
    expect(prepareApproval).toHaveBeenCalledTimes(2);
    expect(callsAtPrepare[1]).toBe(net.calls.length - 1); // before the second provider's own chain check
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
    const adapterSwitched = new Promise<void>((resolve) => hana.ethereum.on('chainChanged', (c) => c === '0x2105' && resolve()));
    const p = base.sendTransaction({ from: EVM, to: USDC, value: 0n, data: APPROVE });
    // Let the adapter's switch land (after its receipt-RPC check), then switch away while hana.ethereum fills.
    await adapterSwitched;
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
    receipts({ eth_getTransactionReceipt: () => (++n < 3 ? null : rpcReceipt()) });
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
    expect(net.rpcCalls(RECEIPTS, 'eth_getTransactionReceipt').map((c) => [c.rpc, c.params, c.at - 5_000_000])).toEqual([0, 2000, 4000].map((t) => ['eth_getTransactionReceipt', [HASH], t]));
    // The chain check runs once, before the first poll.
    expect(net.rpcCalls(RECEIPTS).map((c) => c.rpc)).toEqual(['eth_chainId', ...Array(3).fill('eth_getTransactionReceipt')]);
  });

  it('a receipt rpcUrl on another chain fails at once with 4902, without polling', async () => {
    const { hana } = setup();
    receipts({ eth_getTransactionReceipt: null }, 'https://testnet.base.test', '0x14a34');
    const base = createSodaxEvmProvider(hana, { chainId: BASE, rpcUrl: 'https://testnet.base.test' });
    expect(await rejection(base.waitForTransactionReceipt(HASH))).toMatchObject({ code: 4902, data: { reason: 'receipt_rpc_wrong_chain', rpcChainId: '0x14a34' } });
    expect(net.rpcCalls('https://testnet.base.test', 'eth_getTransactionReceipt')).toEqual([]);
  });

  it('a fault on the chain check is retried like a poll fault', async () => {
    vi.useFakeTimers();
    const { base } = setup();
    let n = 0;
    receipts({
      eth_chainId: () => {
        if (++n === 1) throw { code: -32000, message: 'busy' };
        return '0x2105';
      },
      eth_getTransactionReceipt: rpcReceipt(),
    });
    const p = base.waitForTransactionReceipt(HASH);
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_POLL_MS);
    await expect(p).resolves.toMatchObject({ status: 'success' });
    expect(net.rpcCalls(RECEIPTS).map((c) => c.rpc)).toEqual(['eth_chainId', 'eth_chainId', 'eth_getTransactionReceipt']);
  });

  it('maps a reverted status and the legacy type, stringifies blob fields, and keeps a contract address', async () => {
    const { base } = setup();
    const created = '0x00000000000000000000000000000000000000cc';
    receipts({ eth_getTransactionReceipt: rpcReceipt({ status: '0x0', type: '0x0', to: null, contractAddress: created, blobGasUsed: '0x20000', blobGasPrice: '0x1' }) });
    expect(await base.waitForTransactionReceipt(HASH)).toMatchObject({ status: 'reverted', type: 'legacy', to: null, contractAddress: created, blobGasUsed: '131072', blobGasPrice: '1' });
  });

  it('retries RPC faults, and gives up after 180 s with receipt_timeout (not before)', async () => {
    vi.useFakeTimers({ now: 5_000_000 });
    const { base } = setup();
    receipts({
      eth_getTransactionReceipt: () => {
        throw { code: -32005, message: 'rate limited' };
      },
    });
    const timeouts = vi.spyOn(AbortSignal, 'timeout');
    let settled = false;
    const p = base.waitForTransactionReceipt(HASH).finally(() => {
      settled = true;
    });
    const e = rejection(p);
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await e).toMatchObject({ code: -32603, data: { reason: 'receipt_timeout', hash: HASH, chainId: '0x2105', lastError: expect.stringMatching(/rate limited/u) } });
    const polls = net.rpcCalls(RECEIPTS, 'eth_getTransactionReceipt');
    expect(polls).toHaveLength(EVM_RECEIPT_TIMEOUT_MS / EVM_RECEIPT_POLL_MS + 1);
    expect(polls.at(-1)!.at - 5_000_000).toBe(EVM_RECEIPT_TIMEOUT_MS);
    // Every request, the last one at the deadline included, gets at least a poll interval (never a ~0 ms abort).
    expect(timeouts.mock.calls.at(-1)?.[0]).toBe(EVM_RECEIPT_POLL_MS);
    expect(Math.min(...timeouts.mock.calls.map((c) => c[0]))).toBeGreaterThanOrEqual(EVM_RECEIPT_POLL_MS);
  });

  it('a transient fault then the receipt resolves', async () => {
    vi.useFakeTimers();
    const { base } = setup();
    let n = 0;
    receipts({
      eth_getTransactionReceipt: () => {
        if (++n === 1) throw { code: -32000, message: 'header not found' };
        return rpcReceipt();
      },
    });
    const p = base.waitForTransactionReceipt(HASH);
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_POLL_MS);
    await expect(p).resolves.toMatchObject({ status: 'success' });
  });

  it('is lenient where viem is: a null type, an unknown status, leading zeros, missing optional fields', async () => {
    const { base } = setup();
    const cases: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ type: null }, { type: null, status: 'success' }],
      [{ type: '0x02' }, { type: 'eip1559' }],
      [{ type: '0x7e' }, { type: '0x7e' }],
      [{ status: null }, { status: null }],
      [{ status: '0x2' }, { status: '0x2' }],
      [{ blockNumber: '0x0123', gasUsed: '0x00b411', transactionIndex: null }, { blockNumber: '291', gasUsed: '46097', transactionIndex: null }],
      [{ blockNumber: 291, gasUsed: 46097 }, { blockNumber: '291', gasUsed: '46097' }],
      [{ logsBloom: undefined, from: undefined, effectiveGasPrice: undefined }, { blockNumber: '291' }],
      [{ logs: null }, { logs: null }],
    ];
    for (const [over, expected] of cases) {
      receipts({ eth_getTransactionReceipt: rpcReceipt(over) });
      const r = (await base.waitForTransactionReceipt(HASH)) as unknown as Record<string, unknown>;
      expect(r).toMatchObject(expected);
      for (const [k, v] of Object.entries(over)) if (v === undefined) expect(r).not.toHaveProperty(k);
    }
    // A log keeps the node's fields as given; absent block fields are null.
    receipts({ eth_getTransactionReceipt: rpcReceipt({ logs: [{ address: USDC, topics: [TOPIC], data: '0x' }] }) });
    expect((await base.waitForTransactionReceipt(HASH)).logs).toEqual([
      { address: USDC, topics: [TOPIC], data: '0x', blockHash: null, blockNumber: null, logIndex: null, transactionHash: null, transactionIndex: null, removed: false },
    ]);
  });

  it('a malformed receipt (another hash, no block, a garbled field) is polled again, not reported as a failure', async () => {
    vi.useFakeTimers();
    const { base } = setup();
    const bad = [
      { transactionHash: `0x${'00'.repeat(32)}` },
      { blockHash: null },
      { blockNumber: undefined },
      { blockNumber: 291.5 },
      { gasUsed: 'lots' },
      { logs: [null] },
    ];
    let n = 0;
    receipts({ eth_getTransactionReceipt: () => (n < bad.length ? rpcReceipt(bad[n++]) : rpcReceipt()) });
    const p = base.waitForTransactionReceipt(HASH);
    await vi.advanceTimersByTimeAsync(bad.length * EVM_RECEIPT_POLL_MS);
    await expect(p).resolves.toMatchObject({ transactionHash: HASH, status: 'success', blockNumber: '291' });
    expect(net.rpcCalls(RECEIPTS, 'eth_getTransactionReceipt')).toHaveLength(bad.length + 1);
  });

  it('a receipt that stays malformed ends in receipt_timeout naming the fault', async () => {
    vi.useFakeTimers();
    const { base } = setup();
    receipts({ eth_getTransactionReceipt: rpcReceipt({ blockHash: '0x12' }) });
    const e = rejection(base.waitForTransactionReceipt(HASH));
    await vi.advanceTimersByTimeAsync(EVM_RECEIPT_TIMEOUT_MS);
    expect(await e).toMatchObject({ code: -32603, data: { reason: 'receipt_timeout', lastError: expect.stringMatching(/malformed receipt \(blockHash\)/u) } });
  });

  it('refuses a malformed hash without a request', async () => {
    const { base } = setup();
    for (const h of ['', HASH.slice(0, 10), 'ab'.repeat(32), 42]) expect((await rejection(base.waitForTransactionReceipt(h as never))).code).toBe(-32602);
    expect(net.calls).toEqual([]);
  });
});
