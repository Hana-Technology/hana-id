// A sponsored transaction's gas limit, fees, OP Stack L1 data fee and worst-case cost (D847, D836 addendum). Pure but
// for `l1FeeUpperBound` and `operatorFeeUpperBound`, which read the chain's GasPriceOracle through the chain port.
//
// gasLimit = ceil((intrinsic + delegated-code access + pre-loop overhead + minGas + event) × 1.1), never from
// eth_estimateGas (contracts/evm-delegate/README.md "Duties", "Gas"). The intrinsic part is the relayer's own
// `intrinsicGas` (evm-relayer.ts: 21 000, calldata at 4 gas a token and at least EIP-7623's floor of 10 a token, 25 000
// per EIP-7702 authorization), the very figure the relayer checks a batch's gas against, so the two can never disagree.
// The pre-loop overhead is the README's cold first-batch figure (29 719 for one call) plus 1 400 per further call
// (measured 33 785 for four, about 1 360 each) plus 2 gas per byte of the calls' data (copying and hashing it; the
// measured figures are for 4-byte calls). The worst case reserved is gasLimit × maxFeePerGas + the L1 data fee's and the
// operator fee's upper bounds. The starting fees are the relayer's `maxStartingFees` edge at most (room for two bumps).
import { intrinsicGas, maxStartingFees } from '../evm-relayer.ts';
import { type Hex, revertOf, type SponsorChainPort } from './sponsor-ports.ts';

export { maxStartingFees };

export const TX_BASE_GAS = 21_000n;
/** EIP-7702's PER_EMPTY_ACCOUNT_COST, charged per authorization in the list (inside intrinsicGas; eth_call has none). */
export const AUTHORIZATION_GAS = 25_000n;
/** Loading the delegate's code through the account's delegation designator (a cold account access). */
export const DELEGATION_ACCESS_GAS = 2_600n;
/** The delegate's pre-loop overhead, first batch, one call (README "Gas": 29 719, rounded up). */
export const PRE_LOOP_GAS = 29_800n;
export const PRE_LOOP_GAS_PER_EXTRA_CALL = 1_400n;
export const PRE_LOOP_GAS_PER_DATA_BYTE = 2n;
/** The `Executed` event and what follows the loop (README: about 1 700; the spec's 3 000). */
export const EVENT_GAS = 3_000n;

const bytesOf = (h: Hex): Uint8Array => {
  const out = new Uint8Array((h.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(2 + 2 * i, 4 + 2 * i), 16);
  return out;
};

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
  const intrinsic = intrinsicGas(bytesOf(i.calldata), i.authorizations);
  const dataBytes = i.callData.reduce((n, d) => n + BigInt((d.length - 2) / 2), 0n);
  const overhead = PRE_LOOP_GAS + PRE_LOOP_GAS_PER_EXTRA_CALL * BigInt(Math.max(0, i.callData.length - 1)) + PRE_LOOP_GAS_PER_DATA_BYTE * dataBytes;
  const body = intrinsic + DELEGATION_ACCESS_GAS + overhead + i.minGas + EVENT_GAS;
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

/**
 * maxFee = min(2 × baseFee + tip, the starting cap), the tip at most its starting cap and the max fee; a base fee above
 * the starting cap is refused (`gas_price_too_high`).
 */
export function sponsorFees(baseFee: bigint, caps: { maxFeePerGasWei: bigint; maxPriorityFeePerGasWei: bigint }): FeeQuote {
  const start = maxStartingFees(caps);
  if (baseFee > start.maxFeePerGas) return { ok: false, baseFee };
  const tip = caps.maxPriorityFeePerGasWei < start.maxPriorityFeePerGas ? caps.maxPriorityFeePerGasWei : start.maxPriorityFeePerGas;
  const want = 2n * baseFee + tip;
  const maxFeePerGas = want < start.maxFeePerGas ? want : start.maxFeePerGas;
  return { ok: true, maxFeePerGas, maxPriorityFeePerGas: tip < maxFeePerGas ? tip : maxFeePerGas };
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

/** `getOperatorFee(uint256 gasUsed)`'s selector (OP Stack Isthmus and later). */
export const OPERATOR_FEE_SELECTOR: Hex = '0x275aedd2';

/**
 * The OP Stack operator fee's upper bound (wei) for a transaction using at most `gasLimit` (Isthmus:
 * `gasUsed × operatorFeeScalar ÷ 10^6 + operatorFeeConstant`, increasing in gas used, so its value at the gas limit
 * bounds it). 0 off the OP Stack, and on a chain whose oracle has no `getOperatorFee` (it reverts: before Isthmus there
 * is no operator fee). Any other failure or answer is refused (L1FeeUnavailable): sponsorship fails closed.
 */
export async function operatorFeeUpperBound(chain: SponsorChainPort, opStack: boolean, from: Hex, gasLimit: bigint): Promise<bigint> {
  if (!opStack) return 0n;
  let r: Hex;
  try {
    r = await chain.call({ from, to: GAS_PRICE_ORACLE, data: `${OPERATOR_FEE_SELECTOR}${gasLimit.toString(16).padStart(64, '0')}` });
  } catch (e) {
    if (revertOf(e)) return 0n;
    throw new L1FeeUnavailable();
  }
  if (!/^0x[0-9a-f]{64}$/u.test(r.toLowerCase())) throw new L1FeeUnavailable();
  return BigInt(r);
}

/**
 * The reservation: gasLimit × the chain's fee cap (the relayer may replace the transaction with fees up to it) + the L1
 * data fee's bound + the operator fee's bound.
 */
export const worstCaseWei = (gasLimit: bigint, feeCap: bigint, l1Bound: bigint, operatorBound = 0n): bigint => gasLimit * feeCap + l1Bound + operatorBound;

/** What the reservation was made of, for bounding a receipt's figures (receiptCost). */
export interface ReservedFor {
  gasLimit: bigint;
  feeCap: bigint;
  l1Bound: bigint;
  operatorBound: bigint;
  reservedWei: bigint;
}

/** A receipt's L1 fee may exceed the oracle's bound by this factor (the L1 base fee moves between the read and inclusion). */
export const L1_FEE_SLACK = 2n;

/**
 * The gas price a mined transaction can have been charged: its receipt's effectiveGasPrice, but never above the max fee
 * per gas the relayer signed for that very version (`maxFeePerGas`, from its own record; null when not known). An
 * EIP-1559 node charges min(max fee, base fee + tip), so a receipt reporting more misreports (anvil 1.5.1 reports base
 * fee + tip when the max fee binds, D868).
 */
export const paidGasPrice = (effectiveGasPrice: bigint, maxFeePerGas: bigint | null | undefined): bigint =>
  typeof maxFeePerGas === 'bigint' && maxFeePerGas > 0n && effectiveGasPrice > maxFeePerGas ? maxFeePerGas : effectiveGasPrice;

/**
 * What a mined transaction cost the relayer: gasUsed × its gas price + its L1 fee + its operator fee, each checked
 * against what the reservation assumed: 21 000 ≤ gasUsed ≤ the gas limit, effectiveGasPrice ≤ the fee cap, l1Fee ≤ 2 ×
 * the bound, operatorFee ≤ its bound (or 2 × the L1 bound when the oracle had none). A receipt outside that (a lying or
 * broken RPC) is settled at the reservation and reported `odd`. On the OP Stack a receipt without `l1Fee` is charged
 * the bound. Within those bounds the gas price is also bounded by the mined version's own max fee (`maxFeePerGas`,
 * paidGasPrice): a receipt reporting more is billed at that max fee and reported `priceCapped` (never more than could
 * have been paid, D868).
 */
export function receiptCost(
  r: { gasUsed: bigint; effectiveGasPrice: bigint; l1Fee: bigint | null; operatorFee?: bigint | null },
  opStack: boolean,
  f: ReservedFor,
  maxFeePerGas: bigint | null = null,
): { cost: bigint; odd: boolean; priceCapped?: true } {
  const l1 = opStack ? (r.l1Fee ?? f.l1Bound) : 0n;
  // A receipt that doesn't report the operator fee (a client that doesn't read it) is charged its bound.
  const op = opStack ? (r.operatorFee ?? f.operatorBound) : 0n;
  const opCap = f.operatorBound > 0n ? f.operatorBound : f.l1Bound * L1_FEE_SLACK;
  const odd = r.gasUsed < TX_BASE_GAS || r.gasUsed > f.gasLimit || r.effectiveGasPrice > f.feeCap || l1 > f.l1Bound * L1_FEE_SLACK || l1 < 0n || op > opCap;
  if (odd) return { cost: f.reservedWei, odd: true };
  const price = paidGasPrice(r.effectiveGasPrice, maxFeePerGas);
  return { cost: r.gasUsed * price + l1 + op, odd: false, ...(price !== r.effectiveGasPrice ? { priceCapped: true as const } : {}) };
}
