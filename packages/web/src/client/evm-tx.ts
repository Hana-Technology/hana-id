// Filling an EVM transaction for `eth_sendTransaction` and `eth_signTransaction` (docs/batch-b-spec.md "EIP-1193",
// "Signing and approval": the SDK, not the vault, fills fees and nonces, using the partner's RPC; the approval screen
// shows the final fields).
//
// normalizeTxInput takes the JSON-RPC transaction object a dapp library sends (viem, ethers, wagmi: `0x` quantities;
// numbers and bigints are accepted too) and refuses anything it doesn't know. fillTransaction then completes it:
// - `from` is the vault's address (a different `from` is 4100); `chainId` is the provider's current chain (a different
//   one is refused, so a dapp can't get a signature for a chain it didn't switch to);
// - `nonce` from `eth_getTransactionCount(from, 'pending')`, but never below `minNonce` (one past the last nonce the
//   provider broadcast, for an RPC node that lags), `gas` from `eth_estimateGas`;
// - fees: an explicit `gasPrice` (or `type: '0x0'`) keeps the legacy EIP-155 form, filled with `eth_gasPrice`.
//   Otherwise EIP-1559 when the latest block has `baseFeePerGas`: `maxPriorityFeePerGas` from
//   `eth_maxPriorityFeePerGas` (or `eth_gasPrice − baseFee` where that method is missing) and
//   `maxFeePerGas = 2 × baseFee + maxPriorityFeePerGas`, which survives six full blocks of base-fee growth. A chain
//   without a base fee falls back to legacy.
// The result is the port's `eth_signTransaction` tx: every quantity and `data` as `0x` hex strings, checked with the
// vault's own parser (parseEvmTxRequest) before it is sent.
import { ErrorCode, type EvmTxRequest, parseEvmTxRequest } from '@hana-id/core';
import { ProviderRpcError, RpcCode } from './errors.ts';

type Hex = `0x${string}`;

export interface NormalizedTx {
  type?: '0x0' | '0x2';
  from?: string;
  to?: string | null;
  chainId?: Hex;
  nonce?: Hex;
  gas?: Hex;
  gasPrice?: Hex;
  maxFeePerGas?: Hex;
  maxPriorityFeePerGas?: Hex;
  value?: Hex;
  data?: Hex;
  accessList?: { address: string; storageKeys: string[] }[];
}

const KNOWN_FIELDS = new Set(['type', 'from', 'to', 'chainId', 'nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value', 'data', 'input', 'accessList']);
const QUANTITY_FIELDS = ['chainId', 'nonce', 'gas', 'gasPrice', 'maxFeePerGas', 'maxPriorityFeePerGas', 'value'] as const;
const U256_MAX = (1n << 256n) - 1n;

const invalid = (message: string): ProviderRpcError => new ProviderRpcError(RpcCode.invalidParams, message);

/** A JSON-RPC quantity as canonical `0x` hex (no leading zeros), from a `0x` hex string, safe integer or bigint. */
export function toQuantity(v: unknown, what: string): Hex {
  let n: bigint;
  if (typeof v === 'bigint') n = v;
  else if (typeof v === 'number' && Number.isSafeInteger(v)) n = BigInt(v);
  else if (typeof v === 'string' && /^0x[0-9a-fA-F]{1,64}$/u.test(v)) n = BigInt(v);
  else throw invalid(`${what} must be a 0x hex quantity`);
  if (n < 0n || n > U256_MAX) throw invalid(`${what} is out of range`);
  return `0x${n.toString(16)}`;
}

const toData = (v: unknown, what: string): Hex => {
  if (typeof v !== 'string' || !/^0x(?:[0-9a-fA-F]{2})*$/u.test(v)) throw invalid(`${what} must be 0x hex bytes`);
  return v.toLowerCase() as Hex;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The dapp's transaction object, normalized; refuses unknown fields, unsupported types and conflicting fields. */
export function normalizeTxInput(raw: unknown): NormalizedTx {
  if (!isObject(raw)) throw invalid('The transaction must be an object');
  const out: NormalizedTx = {};
  for (const [k, v] of Object.entries(raw)) {
    if (!KNOWN_FIELDS.has(k)) throw invalid(`Unsupported transaction field: ${k}`);
    if (v === undefined) continue;
    if ((QUANTITY_FIELDS as readonly string[]).includes(k)) out[k as (typeof QUANTITY_FIELDS)[number]] = toQuantity(v, `tx.${k}`);
  }
  if (raw.type !== undefined) {
    const t = toQuantity(raw.type, 'tx.type');
    if (t !== '0x0' && t !== '0x2') throw invalid(`Unsupported transaction type ${t} (only EIP-1559 0x2 and legacy 0x0)`);
    out.type = t;
  }
  if (raw.from !== undefined) {
    if (typeof raw.from !== 'string') throw invalid('tx.from must be an address');
    out.from = raw.from;
  }
  if (raw.to !== undefined) {
    if (raw.to !== null && typeof raw.to !== 'string') throw invalid('tx.to must be an address');
    out.to = raw.to;
  }
  const data = raw.data !== undefined ? toData(raw.data, 'tx.data') : undefined;
  const input = raw.input !== undefined ? toData(raw.input, 'tx.input') : undefined;
  if (data !== undefined && input !== undefined && data !== input) throw invalid('tx.data and tx.input differ');
  const bytes = data ?? input;
  if (bytes !== undefined) out.data = bytes;
  if (raw.accessList !== undefined) {
    if (!Array.isArray(raw.accessList)) throw invalid('tx.accessList must be an array');
    out.accessList = raw.accessList as NormalizedTx['accessList'];
  }
  const has1559 = out.maxFeePerGas !== undefined || out.maxPriorityFeePerGas !== undefined;
  if (has1559 && out.gasPrice !== undefined) throw invalid('tx has both gasPrice and EIP-1559 fees');
  if (out.type === '0x0' && has1559) throw invalid('A legacy (0x0) transaction has no EIP-1559 fees');
  if (out.type === '0x2' && out.gasPrice !== undefined) throw invalid('An EIP-1559 (0x2) transaction has no gasPrice');
  if (out.accessList !== undefined && (out.type === '0x0' || out.gasPrice !== undefined)) throw invalid('Legacy transactions have no accessList');
  return out;
}

export interface FillContext {
  /** The vault's EVM address. */
  from: string;
  /** The provider's current chain. */
  chainId: number;
  /** JSON-RPC on the current chain's rpcUrl. */
  rpc: (method: string, params: readonly unknown[]) => Promise<unknown>;
  /** A floor for a filled nonce (one past the last one broadcast from this page); a dapp's own nonce is kept as is. */
  minNonce?: bigint;
}

const rpcQuantity = (v: unknown, what: string): bigint => {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{1,64}$/u.test(v)) throw new ProviderRpcError(RpcCode.internal, `EVM RPC returned a malformed ${what}`);
  return BigInt(v);
};

const hex = (n: bigint): Hex => `0x${n.toString(16)}`;

/** The filled port transaction (see the file comment). Only the missing fields cost RPC calls, made in parallel. */
export async function fillTransaction(input: NormalizedTx, ctx: FillContext): Promise<EvmTxRequest> {
  if (input.from !== undefined && input.from.toLowerCase() !== ctx.from.toLowerCase()) {
    throw new ProviderRpcError(ErrorCode.unauthorized, 'tx.from is not the Hana ID account');
  }
  const chainId = hex(BigInt(ctx.chainId));
  if (input.chainId !== undefined && input.chainId !== chainId) {
    throw invalid(`tx.chainId ${input.chainId} is not the current chain ${chainId}; switch chains first`);
  }
  const value = input.value ?? '0x0';
  const data = input.data ?? '0x';
  const to = input.to ?? null;

  const floor = ctx.minNonce ?? 0n;
  const nonceP =
    input.nonce !== undefined
      ? Promise.resolve(input.nonce)
      : ctx.rpc('eth_getTransactionCount', [ctx.from, 'pending']).then((r) => {
          const n = rpcQuantity(r, 'nonce');
          return hex(n > floor ? n : floor);
        });
  const estimate: Record<string, unknown> = { from: ctx.from, value, data };
  if (to !== null) estimate.to = to;
  const gasP = input.gas !== undefined ? Promise.resolve(input.gas) : ctx.rpc('eth_estimateGas', [estimate]).then((r) => hex(rpcQuantity(r, 'gas estimate')));
  const feesP = fillFees(input, ctx);
  const [nonce, gas, fees] = await Promise.all([nonceP, gasP, feesP]);

  const tx: EvmTxRequest = { type: fees.type, from: ctx.from, chainId, nonce, gas, value, data, ...fees.fields };
  if (to !== null) tx.to = to;
  if (fees.type === '0x2' && input.accessList !== undefined) tx.accessList = input.accessList;
  try {
    parseEvmTxRequest(tx);
  } catch (e) {
    throw invalid(e instanceof Error ? e.message : 'Invalid transaction');
  }
  return tx;
}

type Fees = { type: '0x0'; fields: { gasPrice: Hex } } | { type: '0x2'; fields: { maxFeePerGas: Hex; maxPriorityFeePerGas: Hex } };

async function fillFees(input: NormalizedTx, ctx: FillContext): Promise<Fees> {
  const gasPrice = async (): Promise<bigint> => rpcQuantity(await ctx.rpc('eth_gasPrice', []), 'gas price');
  const legacy = input.type === '0x0' || input.gasPrice !== undefined;
  if (legacy) return { type: '0x0', fields: { gasPrice: input.gasPrice ?? hex(await gasPrice()) } };
  if (input.maxFeePerGas !== undefined && input.maxPriorityFeePerGas !== undefined) {
    return { type: '0x2', fields: { maxFeePerGas: input.maxFeePerGas, maxPriorityFeePerGas: input.maxPriorityFeePerGas } };
  }
  const block = await ctx.rpc('eth_getBlockByNumber', ['latest', false]);
  const baseFeeRaw = isObject(block) ? block.baseFeePerGas : undefined;
  if (baseFeeRaw === undefined || baseFeeRaw === null) {
    if (input.type === '0x2' || input.maxFeePerGas !== undefined || input.maxPriorityFeePerGas !== undefined) {
      throw invalid("This chain's latest block has no base fee, so it can't take an EIP-1559 transaction");
    }
    return { type: '0x0', fields: { gasPrice: hex(await gasPrice()) } };
  }
  const baseFee = rpcQuantity(baseFeeRaw, 'base fee');
  let priority: bigint;
  if (input.maxPriorityFeePerGas !== undefined) priority = BigInt(input.maxPriorityFeePerGas);
  else {
    try {
      priority = rpcQuantity(await ctx.rpc('eth_maxPriorityFeePerGas', []), 'priority fee');
    } catch (e) {
      // Only a node without the method falls back; any other failure is the caller's to see.
      if (!(e instanceof ProviderRpcError) || (e.code !== -32601 && e.code !== -32600)) throw e;
      const price = await gasPrice();
      priority = price > baseFee ? price - baseFee : 0n;
    }
  }
  const maxFee = input.maxFeePerGas !== undefined ? BigInt(input.maxFeePerGas) : 2n * baseFee + priority;
  if (priority > maxFee) {
    if (input.maxPriorityFeePerGas !== undefined) throw invalid('tx.maxPriorityFeePerGas exceeds tx.maxFeePerGas');
    priority = maxFee;
  }
  return { type: '0x2', fields: { maxFeePerGas: hex(maxFee), maxPriorityFeePerGas: hex(priority) } };
}
