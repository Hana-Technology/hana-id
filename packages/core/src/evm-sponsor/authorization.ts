// EIP-7702 authorizations (docs/decisions.md D846). An authorization is the user's signature over
// keccak256(0x05 ‖ rlp([chain_id, address, nonce])); once a type-4 transaction carries it, the account's code becomes
// the delegation designator 0xef0100 ‖ address, so every later call to the account runs the delegate's code. That is
// the most powerful thing the wallet key signs, so signAuthorization refuses everything but the one safe shape:
// - chainId 0 (valid on every chain) never; a chain the caller did not pass in as enabled never;
// - the address must be the pinned delegate for that chain (delegates.ts);
// - the zero address (which clears a delegation) only with `revoke: true`, and `revoke: true` only with it.
// Signatures are RFC 6979 with low s, as EIP-7702 requires (s ≤ n/2); recoverAuthorization refuses a high s too.
import { keccak_256 } from '@noble/hashes/sha3';
import { checksumEvmAddress } from '../addresses.ts';
import { type Bytes, concatBytes, from0xHex, toBytes } from '../bytes.ts';
import { type Hex, bigIntBytes, recoverEvmAddress, rlpEncode, signEvmDigest } from '../signers/evm.ts';
import { sponsorDelegate } from './delegates.ts';
import { refuse } from './errors.ts';
import { U64_MAX, addressBytes, checkLowS, chainIdOf, enabledSet, hex0x, isZeroAddress, scalar32, uint, word32Hex } from './values.ts';

/** The EIP-7702 authorization's signing magic. */
export const AUTHORIZATION_MAGIC = 0x05;

/** EIP-7702 caps an authorization's nonce below 2^64 − 1. */
export const AUTHORIZATION_NONCE_MAX = U64_MAX - 1n;

/** The zero address: a delegation to it clears the account's code. */
export const ZERO_ADDRESS: Hex = '0x0000000000000000000000000000000000000000';

export interface Authorization {
  /** A positive safe integer. The hash accepts 0 (any chain) to recognise one; nothing here signs it. */
  readonly chainId: number;
  /** The delegate, EIP-55 or lowercase. */
  readonly address: Hex;
  /** The account's transaction nonce when the authorization is applied. */
  readonly nonce: bigint;
}

export interface SignedAuthorization extends Authorization {
  readonly yParity: 0 | 1;
  /** 32 bytes, `0x` lowercase hex. */
  readonly r: Hex;
  /** 32 bytes, `0x` lowercase hex, low s. */
  readonly s: Hex;
}

export interface SignAuthorizationOptions {
  /** The chains the caller has sponsorship switched on for (the manifest's chains, intersected with its own checks). */
  readonly enabledChains: readonly number[];
  /** Sign the zero address (clear the delegation) instead of the pinned delegate. */
  readonly revoke?: boolean;
}

// Every input field is read exactly once, into a plain snapshot that everything after uses (an object with getters can't
// pass one value to a check and another to the hash).
interface Tuple {
  chainId: number;
  address: Bytes;
  nonce: bigint;
}

function parsed(a: Authorization, allowChainZero: boolean): Tuple {
  if (typeof a !== 'object' || a === null) refuse('invalid_input', 'authorization must be an object');
  const rawChainId: unknown = a.chainId;
  const chainId = allowChainZero && rawChainId === 0 ? 0 : chainIdOf(rawChainId);
  return { chainId, address: addressBytes(a.address, 'authorization.address'), nonce: uint(a.nonce, AUTHORIZATION_NONCE_MAX, 'authorization.nonce') };
}

const tuple = (p: Tuple) => [bigIntBytes(BigInt(p.chainId)), p.address, bigIntBytes(p.nonce)];
const hashTuple = (p: Tuple): Bytes => toBytes(keccak_256(concatBytes(Uint8Array.of(AUTHORIZATION_MAGIC), rlpEncode(tuple(p)))));

/** keccak256(0x05 ‖ rlp([chainId, address, nonce])), the digest an EIP-7702 authorization signs. */
export const authorizationHash = (a: Authorization): Bytes => hashTuple(parsed(a, true));

function signatureOf(a: SignedAuthorization): { yParity: 0 | 1; r: bigint; s: bigint } {
  const yParity: unknown = a.yParity;
  if (yParity !== 0 && yParity !== 1) refuse('invalid_signature', 'yParity must be 0 or 1');
  const r = scalar32(a.r, 'r');
  const s = scalar32(a.s, 's');
  checkLowS(r, s);
  return { yParity, r, s };
}

/**
 * The RLP item of a signed authorization in a type-4 transaction's authorization list, with its chain ID. Refuses
 * chainId 0 and a malformed or high-s signature.
 */
export function authorizationListItem(a: SignedAuthorization): { chainId: number; item: Uint8Array[] } {
  const p = parsed(a, false);
  const { yParity, r, s } = signatureOf(a);
  return { chainId: p.chainId, item: [...tuple(p), bigIntBytes(BigInt(yParity)), bigIntBytes(r), bigIntBytes(s)] };
}

/**
 * Signs an EIP-7702 authorization with the user's key `d`. Refuses (EvmSponsorError) chainId 0, a chain outside
 * `enabledChains` or without a pinned delegate, any address but that chain's pinned delegate, and the zero address
 * unless `revoke` is true (which allows only the zero address). The key is used for this one signature, never kept.
 */
export function signAuthorization(d: Uint8Array, a: Authorization, options: SignAuthorizationOptions): SignedAuthorization {
  const p = parsed(a, false);
  if (typeof options !== 'object' || options === null) refuse('invalid_input', 'options must be an object');
  const enabled = enabledSet(options.enabledChains);
  if (options.revoke !== undefined && typeof options.revoke !== 'boolean') refuse('invalid_input', 'revoke must be a boolean');
  const revoke = options.revoke === true;
  const pinned = sponsorDelegate(p.chainId);
  if (!enabled.has(p.chainId) || pinned === null) refuse('chain_not_enabled', 'Sponsorship is not enabled on this chain');
  if (revoke) {
    if (!isZeroAddress(p.address)) refuse('delegate_not_pinned', 'A revoke authorization names the zero address');
  } else if (hex0x(p.address) !== pinned.address.toLowerCase()) {
    refuse('delegate_not_pinned', 'Only the pinned delegate can be authorized on this chain');
  }
  const sig = signEvmDigest(d, hashTuple(p));
  return Object.freeze({
    chainId: p.chainId,
    address: checksumEvmAddress(p.address),
    nonce: p.nonce,
    yParity: sig[64] === 27 ? 0 : 1,
    r: hex0x(sig.subarray(0, 32)),
    s: hex0x(sig.subarray(32, 64)),
  });
}

/**
 * The EIP-55 address that signed this authorization (the account it delegates). Refuses a malformed tuple, a yParity
 * other than 0 or 1, r or s out of range and a high s. chainId 0 is recovered too, so a caller can recognise and refuse
 * one.
 */
export function recoverAuthorization(a: SignedAuthorization): Hex {
  const digest = authorizationHash(a);
  const { yParity, r, s } = signatureOf(a);
  return recoverEvmAddress(digest, concatBytes(from0xHex(word32Hex(r)), from0xHex(word32Hex(s)), Uint8Array.of(27 + yParity)));
}

/** The code EIP-7702 sets on a delegated account: 0xef0100 ‖ address. */
export function delegationDesignator(address: Hex): Bytes {
  return concatBytes(Uint8Array.of(0xef, 0x01, 0x00), addressBytes(address, 'address'));
}

/**
 * The delegate an account's code points to (EIP-55), or null when the code is not exactly a delegation designator
 * (no code, contract code, a wrong length or prefix). A designator to the zero address returns the zero address.
 */
export function delegationTarget(code: Uint8Array): Hex | null {
  if (!(code instanceof Uint8Array) || code.length !== 23 || code[0] !== 0xef || code[1] !== 0x01 || code[2] !== 0x00) return null;
  return checksumEvmAddress(code.subarray(3));
}
