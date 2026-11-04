// Key export encodings (docs/batch-b-spec.md "Key export", step 5): Stellar SEP-23 `S…` (version 18<<3) and EVM `0x`
// plus 64 lowercase hex characters. Only the export window calls exportKeyString, from a fresh login's own PRK (never
// the vault's cached one), and shows the result on Show key or copies it on Copy key (D268). No message type carries
// what it returns.
//
// SECURITY: the returned string is the private key. JS strings can't be zeroed; the export window drops every
// reference when it closes. The intermediate key bytes are zeroed here.
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { STRKEY_VERSION, decodeStrKey, encodeStrKey, evmAddress, stellarAddress } from './addresses.ts';
import { type Bytes, toHex } from './bytes.ts';
import { type DerivationChain, withChainKey } from './derivation.ts';

/** SEP-23 secret seed (S…) of a 32-byte Ed25519 seed. */
export const stellarSecretSeed = (seed: Uint8Array): string => encodeStrKey(STRKEY_VERSION.ed25519SecretSeed, seed);

/** `0x` + 64 lowercase hex characters of a 32-byte secp256k1 private key. */
export function evmPrivateKeyHex(d: Uint8Array): `0x${string}` {
  if (d.length !== 32) throw new Error('secp256k1 private key must be 32 bytes');
  return `0x${toHex(d)}`;
}

/** The export string of one chain account, derived from PRK. */
export function exportKeyString(prk: Uint8Array, chain: DerivationChain, account = 0): string {
  return withChainKey(prk, chain, account, (key) => (chain === 'stellar' ? stellarSecretSeed(key) : evmPrivateKeyHex(key)));
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
    if (!/^0x[0-9a-f]{64}$/u.test(exported)) throw new Error('Malformed EVM private key');
    key = Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(exported.slice(2 + 2 * i, 4 + 2 * i), 16));
    if (!secp256k1.utils.isValidPrivateKey(key)) throw new Error('EVM private key is out of range');
    return evmAddress(secp256k1.getPublicKey(key, false));
  } finally {
    key?.fill(0);
  }
}
