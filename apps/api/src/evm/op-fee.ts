// A sponsored transaction's gas limit, fees, OP Stack L1 data fee and worst-case cost (D847, D836 addendum). Pure but
// for `l1FeeUpperBound`, which reads the chain's GasPriceOracle through the chain port.
//
// gasLimit = ceil((intrinsic + 25 000 per authorization + delegated-code access + pre-loop overhead + minGas + event)
//            × 1.1), never from eth_estimateGas (contracts/evm-delegate/README.md "Duties", "Gas"). The intrinsic part is
// 21 000 plus the calldata at EIP-7623's floor price (10 gas per token, a token being a zero byte or a quarter of a
// non-zero one), which is above the standard price (4 per token), so the limit covers both of EIP-7623's sums. The
// pre-loop overhead is the README's cold first-batch figure (29 719 for one call) plus 1 400 per further call (measured
// 33 785 for four, about 1 360 each) plus 2 gas per byte of the calls' data (copying and hashing it; the measured
// figures are for 4-byte calls). The worst case reserved is gasLimit × maxFeePerGas + the L1 data fee's upper bound.
import type { Hex, SponsorChainPort } from './sponsor-ports.ts';

export const TX_BASE_GAS = 21_000n;
/** EIP-7623's floor price per calldata token. */
export const FLOOR_GAS_PER_TOKEN = 10n;
/** EIP-7702's PER_EMPTY_ACCOUNT_COST, charged per authorization in the list. */
export const AUTHORIZATION_GAS = 25_000n;
/** Loading the delegate's code through the account's delegation designator (a cold account access). */
export const DELEGATION_ACCESS_GAS = 2_600n;
/** The delegate's pre-loop overhead, first batch, one call (README "Gas": 29 719, rounded up). */
export const PRE_LOOP_GAS = 29_800n;
export const PRE_LOOP_GAS_PER_EXTRA_CALL = 1_400n;
export const PRE_LOOP_GAS_PER_DATA_BYTE = 2n;
/** The `Executed` event and what follows the loop (README: about 1 700; the spec's 3 000). */
export const EVENT_GAS = 3_000n;

/** Calldata tokens: a zero byte is 1, a non-zero byte 4 (EIP-7623). */
export function calldataTokens(data: Hex): bigint {
  let tokens = 0n;
  for (let i = 2; i < data.length; i += 2) tokens += data.slice(i, i + 2) === '00' ? 1n : 4n;
  return tokens;
}

export interface GasInput {
  /** The `execute(...)` calldata the transaction carries. */
  calldata: Hex;
  /** The batch's calls' data (their sizes). */
  callData: readonly Hex[];
  minGas: bigint;
  /** 1 when the transaction carries the user's authorization (type 4), else 0. */
  authorizations: number;
}

/** The transaction's gas limit for a batch (see the file header). */
export function sponsorGasLimit(i: GasInput): bigint {
  const intrinsic = TX_BASE_GAS + FLOOR_GAS_PER_TOKEN * calldataTokens(i.calldata);
  const dataBytes = i.callData.reduce((n, d) => n + BigInt((d.length - 2) / 2), 0n);
  const overhead = PRE_LOOP_GAS + PRE_LOOP_GAS_PER_EXTRA_CALL * BigInt(Math.max(0, i.callData.length - 1)) + PRE_LOOP_GAS_PER_DATA_BYTE * dataBytes;
  const body = intrinsic + AUTHORIZATION_GAS * BigInt(i.authorizations) + DELEGATION_ACCESS_GAS + overhead + i.minGas + EVENT_GAS;
  return (body * 11n + 9n) / 10n;
}

/**
 * The largest minGas whose gas limit stays within `maxGasPerTx` for this calldata shape (prepare's `maxMinGas`):
 * the limit grows by 1.1 per unit of minGas, so it is found exactly by solving and stepping down. 0n when none fits.
 */
export function maxMinGasFor(i: Omit<GasInput, 'minGas'>, maxGasPerTx: bigint): bigint {
  const zero = sponsorGasLimit({ ...i, minGas: 0n });
  if (zero > maxGasPerTx) return 0n;
  let m = ((maxGasPerTx - zero) * 10n) / 11n + 2n;
  while (m > 0n && sponsorGasLimit({ ...i, minGas: m }) > maxGasPerTx) m -= 1n;
  return m;
}

export type FeeQuote = { ok: true; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint } | { ok: false; baseFee: bigint };

/** maxFee = min(2 × baseFee + tip, cap); a base fee above the cap is refused (`gas_price_too_high`). */
export function sponsorFees(baseFee: bigint, tip: bigint, cap: bigint): FeeQuote {
  if (baseFee > cap) return { ok: false, baseFee };
  const want = 2n * baseFee + tip;
  return { ok: true, maxFeePerGas: want < cap ? want : cap, maxPriorityFeePerGas: tip };
}

/** The OP Stack GasPriceOracle predeploy. */
export const GAS_PRICE_ORACLE: Hex = '0x420000000000000000000000000000000000000f';
/** `getL1FeeUpperBound(uint256)`'s selector (Fjord and later). */
export const L1_FEE_UPPER_BOUND_SELECTOR: Hex = '0xf1c7a58b';

/**
 * An upper bound of the unsigned transaction's RLP size, as `getL1FeeUpperBound` takes it: the calldata, the fixed
 * fields (chain id, nonces, fees, gas, `to`, value, the list headers: at most 150 bytes) and per authorization its tuple
 * (chain id, address, nonce, y parity, r, s: at most 110 bytes), rounded up generously.
 */
export function unsignedTxSizeBound(calldataBytes: number, authorizations: number): bigint {
  return BigInt(calldataBytes + 200 + 128 * authorizations);
}

/** The L1 data fee's upper bound (wei) for a transaction of this size, from the GasPriceOracle (0 off the OP Stack). */
export async function l1FeeUpperBound(chain: SponsorChainPort, opStack: boolean, from: Hex, txSize: bigint): Promise<bigint> {
  if (!opStack) return 0n;
  const arg = txSize.toString(16).padStart(64, '0');
  let r: Hex;
  try {
    r = await chain.call({ from, to: GAS_PRICE_ORACLE, data: `${L1_FEE_UPPER_BOUND_SELECTOR}${arg}` });
  } catch {
    throw new L1FeeUnavailable();
  }
  if (!/^0x[0-9a-f]{64}$/u.test(r.toLowerCase())) throw new L1FeeUnavailable();
  return BigInt(r);
}

/** The oracle's answer was not a uint256 (an older OP Stack chain, or a broken node): sponsorship fails closed. */
export class L1FeeUnavailable extends Error {
  constructor() {
    super('L1 fee unavailable');
    this.name = 'L1FeeUnavailable';
  }
}

/** The reservation: gasLimit × maxFeePerGas + the L1 bound. */
export const worstCaseWei = (gasLimit: bigint, maxFeePerGas: bigint, l1Bound: bigint): bigint => gasLimit * maxFeePerGas + l1Bound;

/**
 * What a mined transaction cost the relayer: gasUsed × effectiveGasPrice + its L1 fee. On the OP Stack a receipt without
 * `l1Fee` is charged the bound (the budget errs on the side of spending less).
 */
export function receiptCostWei(r: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee: bigint | null }, opStack: boolean, l1Bound: bigint): bigint {
  return r.gasUsed * r.effectiveGasPrice + (opStack ? (r.l1Fee ?? l1Bound) : 0n);
}
