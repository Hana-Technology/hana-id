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

/**
 * A caller's array, read once: its `length` once (checked against `max`), then each element once, into a plain copy.
 * Everything after uses only the copy.
 */
export function snapshotList(v: unknown, max: number, what: string): unknown[] {
  if (!Array.isArray(v)) refuse('invalid_input', `${what} must be an array`);
  const n: unknown = v.length;
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > max) refuse('invalid_input', `${what} must hold at most ${max} entries`);
  const out: unknown[] = [];
  for (let i = 0; i < n; i++) out.push((v as unknown[])[i]);
  return out;
}

/** A copy of caller bytes, made before anything is checked. */
export function bytesCopy(v: unknown, what: string): Bytes {
  if (!(v instanceof Uint8Array)) refuse('invalid_input', `${what} must be bytes`);
  return Uint8Array.from(v);
}

export interface SignerOptions {
  enabled: ReadonlySet<number>;
  revoke: boolean;
  allowPlaceholder: boolean;
}

/**
 * The signers' options, each read once: `enabledChains` (an array of positive safe integers), `revoke` (a boolean if
 * present) and the test-only `allowPlaceholderDelegateInTests` (exactly `true` if present).
 */
export function signerOptions(options: unknown, withRevoke: boolean): SignerOptions {
  if (typeof options !== 'object' || options === null) refuse('invalid_input', 'options must be an object');
  const o = options as { enabledChains?: unknown; revoke?: unknown; allowPlaceholderDelegateInTests?: unknown };
  const chains = snapshotList(o.enabledChains, 256, 'enabledChains');
  if (!chains.every((c) => typeof c === 'number' && Number.isSafeInteger(c) && c > 0)) refuse('invalid_input', 'enabledChains must be an array of chain IDs');
  const revoke: unknown = withRevoke ? o.revoke : undefined;
  if (revoke !== undefined && typeof revoke !== 'boolean') refuse('invalid_input', 'revoke must be a boolean');
  const allow: unknown = o.allowPlaceholderDelegateInTests;
  if (allow !== undefined && allow !== true) refuse('invalid_input', 'allowPlaceholderDelegateInTests must be true if given');
  return { enabled: new Set(chains as number[]), revoke: revoke === true, allowPlaceholder: allow === true };
}

/** Refuses anything but a valid 32-byte secp256k1 private key, with a fixed message (never the key). */
export function checkSigningKey(d: unknown): void {
  let ok = false;
  try {
    ok = d instanceof Uint8Array && d.length === 32 && secp256k1.utils.isValidPrivateKey(d);
  } catch {
    ok = false;
  }
  if (!ok) refuse('invalid_input', 'Invalid signing key');
}

/** Runs a signing step, turning any failure into a fixed EvmSponsorError (no key, digest or value in it). */
export function signing<T>(f: () => T): T {
  try {
    return f();
  } catch {
    return refuse('invalid_input', 'Signing failed');
  }
}
