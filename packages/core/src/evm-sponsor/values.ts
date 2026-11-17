// Shared field checks for the evm-sponsor module (not exported from its entry). Every check throws EvmSponsorError
// with a fixed message naming the field (a literal chosen here, never an input value).
import { secp256k1 } from '@noble/curves/secp256k1';
import { checksumEvmAddress, parseEvmAddress } from '../addresses.ts';
import { type Bytes, from0xHex, toHex } from '../bytes.ts';
import type { Hex } from '../signers/evm.ts';
import { refuse } from './errors.ts';

export const U64_MAX = (1n << 64n) - 1n;
export const U256_MAX = (1n << 256n) - 1n;
const N = secp256k1.CURVE.n;
const HALF_N = N >> 1n;

const HEX_DATA = /^0x(?:[0-9a-fA-F]{2})*$/u;

/** A `0x` + 40 hex address (EIP-55 checked when mixed case) → its 20 bytes. */
export function addressBytes(v: unknown, what: string): Bytes {
  if (typeof v !== 'string') refuse('invalid_input', `${what} must be an EVM address`);
  try {
    return parseEvmAddress(v);
  } catch {
    return refuse('invalid_input', `${what} must be an EVM address`);
  }
}

/** The EIP-55 form of an address field. */
export const addressHex = (v: unknown, what: string): Hex => checksumEvmAddress(addressBytes(v, what));

export const isZeroAddress = (b: Uint8Array): boolean => b.length === 20 && b.every((x) => x === 0);

/** A bigint in [0, max]. */
export function uint(v: unknown, max: bigint, what: string): bigint {
  if (typeof v !== 'bigint' || v < 0n || v > max) refuse('invalid_input', `${what} must be an integer in range`);
  return v;
}

/** A chain ID: a positive safe integer (never 0). */
export function chainIdOf(v: unknown): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) refuse('chain_id_invalid', 'chainId must be a positive safe integer');
  return v;
}

/** `0x` hex bytes of at most `maxLen` bytes (the length is checked before anything is decoded). */
export function dataBytes(v: unknown, maxLen: number, what: string): Bytes {
  if (typeof v !== 'string' || v.length > 2 + 2 * maxLen || !HEX_DATA.test(v)) refuse('invalid_input', `${what} must be 0x hex bytes within the size limit`);
  return from0xHex(v);
}

/** Lowercase `0x` hex. */
export const hex0x = (b: Uint8Array): Hex => `0x${toHex(b)}`;

/** A 32-byte big-endian word as lowercase `0x` hex. */
export function word32Hex(n: bigint): Hex {
  return `0x${n.toString(16).padStart(64, '0')}`;
}

/** A 32-byte `0x` hex scalar (as r and s are carried) → bigint. */
export function scalar32(v: unknown, what: string): bigint {
  if (typeof v !== 'string' || !/^0x[0-9a-fA-F]{64}$/u.test(v)) refuse('invalid_signature', `${what} must be 32 bytes of 0x hex`);
  return BigInt(v);
}

/** Refuses r or s outside [1, n−1], and a high s (s > n/2, which EIP-2 and EIP-7702 and OpenZeppelin's ECDSA refuse). */
export function checkLowS(r: bigint, s: bigint): void {
  if (r <= 0n || r >= N || s <= 0n || s > HALF_N) refuse('invalid_signature', 'Signature must have r, s in range and a low s');
}

/** A 65-byte `r ‖ s ‖ v` signature (`0x` hex or bytes), v ∈ {27, 28}, low s. */
export function rsvParts(sig: unknown): { r: bigint; s: bigint; recovery: 0 | 1 } {
  let b: Uint8Array;
  if (sig instanceof Uint8Array) b = sig;
  else if (typeof sig === 'string' && /^0x[0-9a-fA-F]{130}$/u.test(sig)) b = from0xHex(sig);
  else return refuse('invalid_signature', 'Signature must be 65 bytes r ‖ s ‖ v');
  if (b.length !== 65 || (b[64] !== 27 && b[64] !== 28)) refuse('invalid_signature', 'Signature must be 65 bytes r ‖ s ‖ v with v 27 or 28');
  const r = BigInt(hex0x(b.subarray(0, 32)));
  const s = BigInt(hex0x(b.subarray(32, 64)));
  checkLowS(r, s);
  return { r, s, recovery: b[64] === 27 ? 0 : 1 };
}

/** The `enabledChains` option: an array of positive safe integers. */
export function enabledSet(enabled: unknown): ReadonlySet<number> {
  if (!Array.isArray(enabled) || !enabled.every((c) => typeof c === 'number' && Number.isSafeInteger(c) && c > 0)) {
    refuse('invalid_input', 'enabledChains must be an array of chain IDs');
  }
  return new Set(enabled as number[]);
}
