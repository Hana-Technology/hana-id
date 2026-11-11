// Key export encodings (docs/batch-b-spec.md "Key export", step 5): Stellar SEP-23 `S…` (version 18<<3), EVM `0x`
// plus 64 lowercase hex characters, and NEAR `ed25519:` + base58(seed ‖ public key), the 64-byte secret key form
// near-cli, near-api-js and NEAR wallets import (D724). Only the export window calls exportKeyString, from a fresh login's own PRK (never
// the vault's cached one), and shows the result on Show key or copies it on Copy key (D268). No message type carries
// what it returns.
//
// SECURITY: the returned string is the private key. JS strings can't be zeroed; the export window drops every
// reference when it closes. The intermediate key bytes are zeroed here.
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { base58 } from '@scure/base';
import { STRKEY_VERSION, decodeStrKey, encodeStrKey, evmAddress, nearImplicitAccountId, stellarAddress } from './addresses.ts';
import { type Bytes, bytesEqual, concatBytes, toBytes, toHex } from './bytes.ts';
import { type DerivationChain, withChainKey } from './derivation.ts';

/** SEP-23 secret seed (S…) of a 32-byte Ed25519 seed. */
export const stellarSecretSeed = (seed: Uint8Array): string => encodeStrKey(STRKEY_VERSION.ed25519SecretSeed, seed);

/** `0x` + 64 lowercase hex characters of a 32-byte secp256k1 private key. */
export function evmPrivateKeyHex(d: Uint8Array): `0x${string}` {
  if (d.length !== 32) throw new Error('secp256k1 private key must be 32 bytes');
  return `0x${toHex(d)}`;
}

/**
 * `ed25519:` + base58(seed ‖ public key) of a 32-byte Ed25519 seed: NEAR's secret key string. The 64-byte buffer is
 * zeroed (base58 works on its own copy, which the garbage collector drops).
 */
export function nearSecretKey(seed: Uint8Array): string {
  if (seed.length !== 32) throw new Error('Ed25519 seed must be 32 bytes');
  const full = concatBytes(seed, ed25519.getPublicKey(seed));
  try {
    return `ed25519:${base58.encode(full)}`;
  } finally {
    full.fill(0);
  }
}

/** The export string of one chain's key, from its private key bytes (the Stellar or NEAR seed, the EVM `d`). */
export function exportStringOf(chain: DerivationChain, key: Uint8Array): string {
  if (chain === 'stellar') return stellarSecretSeed(key);
  if (chain === 'near') return nearSecretKey(key);
  return evmPrivateKeyHex(key);
}

/** The export string of one chain account, derived from PRK. */
export function exportKeyString(prk: Uint8Array, chain: DerivationChain, account = 0): string {
  return withChainKey(prk, chain, account, (key) => exportStringOf(chain, key));
}

/**
 * The address an export string imports as, after checking its encoding (StrKey version and CRC; 64 lowercase hex and
 * a valid scalar). The export window compares it with the vault's address before showing anything.
 */
export function addressOfExport(chain: DerivationChain, exported: string): string {
  let key: Bytes | null = null;
  try {
    if (chain === 'stellar') {
      key = decodeStrKey(STRKEY_VERSION.ed25519SecretSeed, exported);
      return stellarAddress(ed25519.getPublicKey(key));
    }
    if (chain === 'near') {
      const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]{80,90})$/u.exec(exported);
      if (!m) throw new Error('Malformed NEAR secret key');
      // The decoded buffer itself, not a copy: `finally` zeroes the only one there is.
      key = base58.decode(m[1]!) as Bytes;
      if (key.length !== 64 || base58.encode(key) !== m[1]) throw new Error('Malformed NEAR secret key');
      // The second half must be the first half's public key, as importers assume (they read the key from it).
      if (!bytesEqual(ed25519.getPublicKey(key.subarray(0, 32)), key.subarray(32))) throw new Error('NEAR secret key halves disagree');
      return nearImplicitAccountId(key.subarray(32));
    }
    if (!/^0x[0-9a-f]{64}$/u.test(exported)) throw new Error('Malformed EVM private key');
    key = Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(exported.slice(2 + 2 * i, 4 + 2 * i), 16));
    if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error('EVM private key is out of range');
    return evmAddress(secp256k1.getPublicKey(key, false));
  } finally {
    key?.fill(0);
  }
}
