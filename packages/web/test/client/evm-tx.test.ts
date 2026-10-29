// Transaction normalization and filling for eth_sendTransaction / eth_signTransaction (docs/batch-b-spec.md
// "EIP-1193": the SDK fills nonce, gas and fees from the chain RPC; the port carries 0x hex strings only).
import { parseEvmTxRequest } from '@hana-id/core';
import { describe, expect, it, vi } from 'vitest';
import { ProviderRpcError } from '../../src/client/errors.ts';
import { type FillContext, fillTransaction, normalizeTxInput, toQuantity } from '../../src/client/evm-tx.ts';

const FROM = '0x00000000000000000000000000000000000000aa';
const TO = '0x00000000000000000000000000000000000000bb';
const GWEI = 1_000_000_000n;
const hex = (n: bigint) => `0x${n.toString(16)}`;

function ctx(answers: Record<string, unknown>, chainId = 11155111): FillContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    from: FROM,
    chainId,
    calls,
    rpc: vi.fn(async (method: string) => {
      calls.push(method);
      if (!Object.hasOwn(answers, method)) throw new ProviderRpcError(-32601, 'Method not found');
      const a = answers[method];
      if (a instanceof Error) throw a;
      return a;
    }),
  };
}

const CHAIN = { eth_getTransactionCount: '0x7', eth_estimateGas: '0x5208', eth_getBlockByNumber: { baseFeePerGas: hex(10n * GWEI) }, eth_maxPriorityFeePerGas: hex(2n * GWEI), eth_gasPrice: hex(15n * GWEI) };

async function refused(p: Promise<unknown> | (() => unknown), code = -32602): Promise<ProviderRpcError> {
  let e: unknown;
  try {
    await (typeof p === 'function' ? p() : p);
  } catch (err) {
    e = err;
  }
  expect(e).toBeInstanceOf(ProviderRpcError);
  expect((e as ProviderRpcError).code).toBe(code);
  return e as ProviderRpcError;
}

describe('toQuantity', () => {
  it('canonicalizes hex strings, safe integers and bigints', () => {
    expect(toQuantity('0x0001', 'x')).toBe('0x1');
    expect(toQuantity(255, 'x')).toBe('0xff');
    expect(toQuantity(10n ** 18n, 'x')).toBe('0xde0b6b3a7640000');
    expect(toQuantity('0x0', 'x')).toBe('0x0');
  });

  it('refuses decimals strings, negatives, floats and > 256 bits', async () => {
    for (const v of ['10', '-0x1', 1.5, -1, '0x', `0x1${'0'.repeat(64)}`, null, {}]) await refused(() => toQuantity(v, 'x'));
  });
});

describe('normalizeTxInput', () => {
  it('accepts viem/ethers shapes and maps input to data', () => {
    expect(normalizeTxInput({ from: FROM, to: TO, value: '0x1', input: '0xABCD', gas: 21000n })).toEqual({ from: FROM, to: TO, value: '0x1', data: '0xabcd', gas: '0x5208' });
    expect(normalizeTxInput({ to: TO, data: '0x12', input: '0x12' })).toEqual({ to: TO, data: '0x12' });
    expect(normalizeTxInput({ type: '0x02', to: null })).toEqual({ type: '0x2', to: null });
  });

  it('refuses unknown fields, unsupported types and conflicting fields', async () => {
    await refused(() => normalizeTxInput({ to: TO, blobs: [] }));
    await refused(() => normalizeTxInput({ to: TO, type: '0x1' }));
    await refused(() => normalizeTxInput({ to: TO, type: '0x4' }));
    await refused(() => normalizeTxInput({ to: TO, data: '0x12', input: '0x34' }));
    await refused(() => normalizeTxInput({ to: TO, gasPrice: '0x1', maxFeePerGas: '0x2' }));
    await refused(() => normalizeTxInput({ to: TO, type: '0x0', maxFeePerGas: '0x2' }));
    await refused(() => normalizeTxInput({ to: TO, type: '0x2', gasPrice: '0x2' }));
    await refused(() => normalizeTxInput({ to: TO, gasPrice: '0x2', accessList: [] }));
    await refused(() => normalizeTxInput({ to: TO, data: '0x123' }));
    await refused(() => normalizeTxInput({ to: 5 }));
    await refused(() => normalizeTxInput('0x'));
  });
});

describe('fillTransaction', () => {
  it('fills nonce (pending), gas and EIP-1559 fees (2 × baseFee + priority), every field a 0x hex string', async () => {
    const c = ctx(CHAIN);
    const tx = await fillTransaction(normalizeTxInput({ to: TO, value: '0x10' }), c);
    expect(tx).toEqual({
      type: '0x2',
      from: FROM,
      chainId: '0xaa36a7',
      nonce: '0x7',
      gas: '0x5208',
      to: TO,
      value: '0x10',
      data: '0x',
      maxFeePerGas: hex(22n * GWEI),
      maxPriorityFeePerGas: hex(2n * GWEI),
    });
    for (const [k, v] of Object.entries(tx)) if (k !== 'to' && k !== 'from') expect(v).toMatch(/^0x[0-9a-f]*$/u);
    expect(() => parseEvmTxRequest(tx)).not.toThrow();
    expect(c.rpc).toHaveBeenCalledWith('eth_getTransactionCount', [FROM, 'pending']);
    expect(c.rpc).toHaveBeenCalledWith('eth_estimateGas', [{ from: FROM, to: TO, value: '0x10', data: '0x' }]);
    expect(c.rpc).toHaveBeenCalledWith('eth_getBlockByNumber', ['latest', false]);
  });

  it('a filled nonce is never below minNonce; a higher pending count wins; a dapp nonce is kept as is', async () => {
    expect((await fillTransaction(normalizeTxInput({ to: TO }), { ...ctx(CHAIN), minNonce: 9n })).nonce).toBe('0x9');
    expect((await fillTransaction(normalizeTxInput({ to: TO }), { ...ctx(CHAIN), minNonce: 5n })).nonce).toBe('0x7');
    expect((await fillTransaction(normalizeTxInput({ to: TO, nonce: '0x2' }), { ...ctx(CHAIN), minNonce: 9n })).nonce).toBe('0x2');
  });

  it('makes no RPC call for fields already given', async () => {
    const c = ctx({});
    const tx = await fillTransaction(normalizeTxInput({ to: TO, nonce: '0x1', gas: '0x5208', maxFeePerGas: '0x10', maxPriorityFeePerGas: '0x1', chainId: '0xaa36a7' }), c);
    expect(c.calls).toEqual([]);
    expect(tx.nonce).toBe('0x1');
  });

  it('keeps legacy for an explicit gasPrice or type 0x0, filling gasPrice from eth_gasPrice', async () => {
    const c = ctx(CHAIN);
    const tx = await fillTransaction(normalizeTxInput({ to: TO, type: '0x0' }), c);
    expect(tx.type).toBe('0x0');
    expect(tx.gasPrice).toBe(hex(15n * GWEI));
    expect(tx.maxFeePerGas).toBeUndefined();
    const tx2 = await fillTransaction(normalizeTxInput({ to: TO, gasPrice: '0x3' }), ctx(CHAIN));
    expect(tx2).toMatchObject({ type: '0x0', gasPrice: '0x3' });
  });

  it('falls back to legacy on a chain without baseFeePerGas', async () => {
    const tx = await fillTransaction(normalizeTxInput({ to: TO }), ctx({ ...CHAIN, eth_getBlockByNumber: { number: '0x1' } }));
    expect(tx).toMatchObject({ type: '0x0', gasPrice: hex(15n * GWEI) });
  });

  it('refuses an explicit EIP-1559 transaction on a chain without a base fee', async () => {
    await refused(fillTransaction(normalizeTxInput({ to: TO, type: '0x2' }), ctx({ ...CHAIN, eth_getBlockByNumber: {} })));
  });

  it('uses gasPrice − baseFee as priority when eth_maxPriorityFeePerGas is missing', async () => {
    const { eth_maxPriorityFeePerGas: _, ...noPriority } = CHAIN;
    const tx = await fillTransaction(normalizeTxInput({ to: TO }), ctx(noPriority));
    expect(tx.maxPriorityFeePerGas).toBe(hex(5n * GWEI));
    expect(tx.maxFeePerGas).toBe(hex(25n * GWEI));
  });

  it('passes on other RPC failures', async () => {
    await refused(fillTransaction(normalizeTxInput({ to: TO }), ctx({ ...CHAIN, eth_maxPriorityFeePerGas: new ProviderRpcError(-32000, 'down') })), -32000);
  });

  it('fills the missing fee from a given one, and clamps a computed priority to a given maxFeePerGas', async () => {
    const tx = await fillTransaction(normalizeTxInput({ to: TO, maxFeePerGas: hex(GWEI) }), ctx(CHAIN));
    expect(tx).toMatchObject({ maxFeePerGas: hex(GWEI), maxPriorityFeePerGas: hex(GWEI) });
    const tx2 = await fillTransaction(normalizeTxInput({ to: TO, maxPriorityFeePerGas: hex(3n * GWEI) }), ctx(CHAIN));
    expect(tx2).toMatchObject({ maxFeePerGas: hex(23n * GWEI), maxPriorityFeePerGas: hex(3n * GWEI) });
    await refused(fillTransaction(normalizeTxInput({ to: TO, maxPriorityFeePerGas: '0x10', maxFeePerGas: '0x1' }), ctx(CHAIN)));
  });

  it("refuses a from other than the vault's address (4100) and a chainId other than the current chain", async () => {
    await refused(fillTransaction(normalizeTxInput({ from: TO, to: TO }), ctx(CHAIN)), 4100);
    await refused(fillTransaction(normalizeTxInput({ to: TO, chainId: '0x1' }), ctx(CHAIN)));
    // The vault's address in another case is the same account.
    await expect(fillTransaction(normalizeTxInput({ from: FROM.toUpperCase().replace('0X', '0x'), to: TO }), ctx(CHAIN))).resolves.toMatchObject({ from: FROM });
  });

  it('a contract creation has no `to` (the vault shows it and never auto-approves it)', async () => {
    const tx = await fillTransaction(normalizeTxInput({ data: '0x6080' }), ctx(CHAIN));
    expect(tx.to).toBeUndefined();
    expect(tx.data).toBe('0x6080');
  });

  it('refuses malformed RPC answers (-32603)', async () => {
    await refused(fillTransaction(normalizeTxInput({ to: TO }), ctx({ ...CHAIN, eth_getTransactionCount: 7 })), -32603);
    await refused(fillTransaction(normalizeTxInput({ to: TO }), ctx({ ...CHAIN, eth_estimateGas: '21000' })), -32603);
  });
});
