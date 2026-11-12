// Derivation v1 (docs/batch-b-spec.md "Derivation v1"), exported as `@hana-id/core/derivation`. It is the only place
// that turns the CKD secret into chain keys; the vault, the export window and the tests all import it.
//
//   S   = the 48-byte compressed G1 point decryptCkd returns (after the pairing check against the pinned key)
//   PRK = HKDF-Extract(SHA-256, salt = utf8("hana-id/chain-keys/v1/extract"), IKM = S); S is zeroed straight after
//   info(ns, curve, account) = borsh("hana-id/chain-keys/v1/expand") ‖ borsh(ns) ‖ borsh(curve) ‖ u32le(account)
//   Stellar: seed = HKDF-Expand(PRK, info("stellar", "ed25519", account), 32), the RFC 8032 seed; address G… (StrKey)
//   EVM:     okm  = HKDF-Expand(PRK, info("eip155", "secp256k1", account), 48); d = (int_be(okm) mod (n − 1)) + 1
//            (@noble/curves mapHashToField, FIPS 186-5 A.2.1: can't fail, bias ≤ 2^-128); address EIP-55
//   NEAR:    seed = HKDF-Expand(PRK, info("near", "ed25519", account), 32), the RFC 8032 seed; address the implicit
//            account id (lowercase hex of the public key); added 2026-11-11 (D720) as an additive tuple
//
// FROZEN at the address freeze: every label, tuple and key rule here decides every user's address. Changing any of
// them changes every address; test/derivation.test.ts holds golden vectors (test/vectors/derivation-v1.json) and a
// SHA-256 guard that fails with "address-changing edit". A later scheme is a new opt-in version (salt
// "hana-id/chain-keys/v2/extract"); v1 stays derivable. New chains are new (namespace, curve) tuples: additive.
// NEAR is the first such tuple: DERIVATION_V1_NEAR, kept out of DERIVATION_V1 so the frozen constants (and their
// SHA-256 guard) stay byte for byte as they were; it has its own vectors file and guard (test/derivation-near.test.ts,
// test/vectors/derivation-v1-near.json), frozen at the address freeze like the rest.
//
// SECURITY: S, PRK, okm, seeds and d are full private keys. They are zeroed in `finally` on every path; only addresses
// and signatures leave the vault. Noble's outputs are used in place, never copied, so the buffer zeroed is the only one. JS can't zero the BigInts mapHashToField uses internally, nor noble's internal
// copies; those die with the garbage collector.
import { mapHashToField } from '@noble/curves/abstract/modular';
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { expand, extract } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { evmAddress, nearImplicitAccountId, stellarAddress } from './addresses.ts';
import { type Bytes, borshString, concatBytes, u32le, utf8 } from './bytes.ts';
import { CKD_SECRET_BYTES } from './ckd.ts';

export const DERIVATION_V1 = Object.freeze({
  version: 1,
  extractSalt: 'hana-id/chain-keys/v1/extract',
  expandLabel: 'hana-id/chain-keys/v1/expand',
  stellar: Object.freeze({ namespace: 'stellar', curve: 'ed25519', length: 32 }),
  evm: Object.freeze({ namespace: 'eip155', curve: 'secp256k1', length: 48 }),
} as const);

/**
 * NEAR's tuple: additive, in derivation v1 (same salt and expand label), not a member of DERIVATION_V1, whose
 * JSON is hashed by the Stellar and EVM guard. FROZEN at the address freeze like DERIVATION_V1.
 */
export const DERIVATION_V1_NEAR = Object.freeze({ namespace: 'near', curve: 'ed25519', length: 32 } as const);

export type DerivationChain = 'stellar' | 'evm' | 'near';

const NAMESPACE_PATTERN = /^[-a-z0-9]{3,8}$/u;
const CURVE_PATTERN = /^[a-z0-9]{1,16}$/u;
const SECP256K1_N = secp256k1.CURVE.n;

/**
 * PRK = HKDF-Extract(SHA-256, salt = "hana-id/chain-keys/v1/extract", IKM = S). Consumes S: it is zeroed before this
 * returns, also when it throws. The caller owns (and must zero) the returned PRK.
 */
export function extractPrk(s: Uint8Array): Bytes {
  try {
    if (s.length !== CKD_SECRET_BYTES) throw new Error(`CKD secret must be ${CKD_SECRET_BYTES} bytes`);
    return extract(sha256, s, utf8(DERIVATION_V1.extractSalt)) as Bytes;
  } finally {
    s.fill(0);
  }
}

/** info(ns, curve, account). `ns` must match ^[-a-z0-9]{3,8}$ (CAIP-2), `curve` ^[a-z0-9]{1,16}$, `account` a u32. */
export function derivationInfo(namespace: string, curve: string, account: number): Bytes {
  if (!NAMESPACE_PATTERN.test(namespace)) throw new Error('Derivation namespace must match ^[-a-z0-9]{3,8}$');
  if (!CURVE_PATTERN.test(curve)) throw new Error('Derivation curve must match ^[a-z0-9]{1,16}$');
  if (!Number.isInteger(account) || account < 0 || account > 0xffffffff) throw new RangeError('Derivation account must be a u32');
  return concatBytes(borshString(DERIVATION_V1.expandLabel), borshString(namespace), borshString(curve), u32le(account));
}

function expandPrk(prk: Uint8Array, info: Uint8Array, length: number): Bytes {
  if (prk.length !== 32) throw new Error('PRK must be 32 bytes');
  return expand(sha256, prk, info, length) as Bytes;
}

/** The RFC 8032 Ed25519 seed for Stellar account `account`. The caller zeroes it. */
export function stellarSeed(prk: Uint8Array, account = 0): Bytes {
  const { namespace, curve, length } = DERIVATION_V1.stellar;
  return expandPrk(prk, derivationInfo(namespace, curve, account), length);
}

/** The RFC 8032 Ed25519 seed for NEAR account `account`. The caller zeroes it. */
export function nearSeed(prk: Uint8Array, account = 0): Bytes {
  const { namespace, curve, length } = DERIVATION_V1_NEAR;
  return expandPrk(prk, derivationInfo(namespace, curve, account), length);
}

/** d = (int_be(okm) mod (n − 1)) + 1, 32 bytes big-endian (FIPS 186-5 A.2.1). `okm` must be 48 bytes. */
export function reduceSecp256k1(okm: Uint8Array): Bytes {
  if (okm.length !== DERIVATION_V1.evm.length) throw new Error(`okm must be ${DERIVATION_V1.evm.length} bytes`);
  return mapHashToField(okm, SECP256K1_N) as Bytes;
}

/** The secp256k1 private key `d` (32 bytes) for EVM account `account`. The caller zeroes it. */
export function evmPrivateKey(prk: Uint8Array, account = 0): Bytes {
  const { namespace, curve, length } = DERIVATION_V1.evm;
  const okm = expandPrk(prk, derivationInfo(namespace, curve, account), length);
  try {
    return reduceSecp256k1(okm);
  } finally {
    okm.fill(0);
  }
}

/** The private key bytes of one chain: the Stellar or NEAR Ed25519 seed, or the EVM `d`. The caller zeroes it. */
export function chainPrivateKey(prk: Uint8Array, chain: DerivationChain, account = 0): Bytes {
  switch (chain) {
    case 'stellar':
      return stellarSeed(prk, account);
    case 'evm':
      return evmPrivateKey(prk, account);
    case 'near':
      return nearSeed(prk, account);
    default:
      throw new Error('Unknown derivation chain');
  }
}

/**
 * Derives the chain key, calls `use` with it and zeroes it in `finally`. `use` must be synchronous and must not keep
 * the bytes (every signer in signers/ is synchronous).
 */
export function withChainKey<T>(prk: Uint8Array, chain: DerivationChain, account: number, use: (key: Bytes) => T): T {
  const key = chainPrivateKey(prk, chain, account);
  try {
    const out = use(key);
    if (out instanceof Promise) throw new Error('withChainKey callbacks must be synchronous');
    return out;
  } finally {
    key.fill(0);
  }
}

/** Address of one chain account. */
export function chainAddress(prk: Uint8Array, chain: DerivationChain, account = 0): string {
  return withChainKey(prk, chain, account, (key) => {
    if (chain === 'stellar') return stellarAddress(ed25519.getPublicKey(key));
    if (chain === 'near') return nearImplicitAccountId(ed25519.getPublicKey(key));
    return evmAddress(secp256k1.getPublicKey(key, false));
  });
}

/** The 32-byte Ed25519 public key of NEAR account `account` (its implicit account id is this key's hex). */
export const nearPublicKey = (prk: Uint8Array, account = 0): Bytes => withChainKey(prk, 'near', account, (seed) => Uint8Array.from(ed25519.getPublicKey(seed)));

export interface Addresses {
  /** Stellar account (G…). */
  stellar: string;
  /** EIP-55 checksummed EVM address, one key for every EVM chain. */
  evm: `0x${string}`;
}

/**
 * Every wallet address: Addresses plus NEAR's implicit account id. A separate type, so the frozen
 * deriveAddresses, the wallet proofs and the wallet record (which the API takes as exactly Stellar and EVM) keep their
 * shape.
 */
export interface WalletAddresses extends Addresses {
  /** NEAR implicit account id: 64 lowercase hex characters, the Ed25519 public key. */
  near: string;
}

/** Both addresses of `account` (0 in the MVP). */
export const deriveAddresses = (prk: Uint8Array, account = 0): Addresses => ({
  stellar: chainAddress(prk, 'stellar', account),
  evm: chainAddress(prk, 'evm', account) as `0x${string}`,
});

/** Every wallet address of `account`: Stellar, EVM and NEAR. */
export const deriveWalletAddresses = (prk: Uint8Array, account = 0): WalletAddresses => ({ ...deriveAddresses(prk, account), near: chainAddress(prk, 'near', account) });

/** S → PRK → addresses, zeroing S and PRK. For callers that only need the addresses (tests and tooling). */
export function addressesFromCkdSecret(s: Uint8Array, account = 0): Addresses {
  const prk = extractPrk(s);
  try {
    return deriveAddresses(prk, account);
  } finally {
    prk.fill(0);
  }
}

export interface AccountDescriptor {
  derivation: 1;
  keyIndex: number;
  namespace: string;
  curve: string;
  account: number;
  address: string;
}

/** The descriptors of both chains for one `key_index` (the path's) and `account`. */
export function accountDescriptors(prk: Uint8Array, keyIndex: number, account = 0): AccountDescriptor[] {
  return (['stellar', 'evm'] as const).map((chain) => ({
    derivation: DERIVATION_V1.version,
    keyIndex,
    namespace: DERIVATION_V1[chain].namespace,
    curve: DERIVATION_V1[chain].curve,
    account,
    address: chainAddress(prk, chain, account),
  }));
}
