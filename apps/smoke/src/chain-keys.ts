// PROVISIONAL chain-key derivation: the legacy PoC convention (legacy/client/ckd.ts deriveChainKeys), HKDF-SHA256 with
// salt "hana-embed-ckd-v1" and one `info` per chain. Batch B (SDK) decides the final HKDF salt/info before the address
// freeze, so every address shown by this page is PROVISIONAL and will change.
//
// SECURITY: the CKD secret and the derived private keys exist only inside deriveAddresses. Only public results leave
// it (addresses); the intermediate buffers are zeroed before it returns, even on error.
import { ed25519 } from '@noble/curves/ed25519';
import { secp256k1 } from '@noble/curves/secp256k1';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha2';
import { keccak_256 } from '@noble/hashes/sha3';
import { base32 } from '@scure/base';
import { toHex, utf8 } from './bytes.ts';

/** PROVISIONAL: the legacy PoC's HKDF salt and info strings (batch B picks the final ones). */
export const PROVISIONAL_HKDF = {
  salt: 'hana-embed-ckd-v1',
  info: { evm: 'hana-embed evm secp256k1 v1', stellar: 'hana-embed stellar ed25519 v1' },
} as const;

export interface PublicAddresses {
  /** Stellar account (G…), from the Ed25519 seed. */
  stellar: string;
  /** EIP-55 checksummed EVM address. */
  evm: `0x${string}`;
}

/** Stellar StrKey for an Ed25519 public key: base32(version 6<<3 ‖ key ‖ CRC16-XModem LE). */
export function stellarAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('Ed25519 public key must be 32 bytes');
  const payload = Uint8Array.from([6 << 3, ...publicKey]);
  const crc = crc16xmodem(payload);
  return base32.encode(Uint8Array.from([...payload, crc & 0xff, crc >> 8]));
}

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** EIP-55 checksummed address of a secp256k1 public key (65-byte uncompressed or 33-byte compressed). */
export function evmAddress(publicKey: Uint8Array): `0x${string}` {
  const uncompressed = publicKey.length === 65 ? publicKey : secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  const lower = toHex(keccak_256(uncompressed.subarray(1)).subarray(-20));
  const hash = toHex(keccak_256(utf8(lower)));
  let out = '';
  for (let i = 0; i < lower.length; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return `0x${out}`;
}

/**
 * PROVISIONAL. CKD secret → per-chain private keys (HKDF as in legacy) → public addresses. The secret is not modified;
 * the caller zeroes it. The derived private keys never leave this function.
 */
export function deriveAddresses(secret: Uint8Array): PublicAddresses {
  const salt = utf8(PROVISIONAL_HKDF.salt);
  const evmKey = hkdf(sha256, secret, salt, utf8(PROVISIONAL_HKDF.info.evm), 32);
  const stellarSeed = hkdf(sha256, secret, salt, utf8(PROVISIONAL_HKDF.info.stellar), 32);
  try {
    if (!secp256k1.utils.isValidPrivateKey(evmKey)) throw new Error('Derived EVM key is out of range');
    return { evm: evmAddress(secp256k1.getPublicKey(evmKey, false)), stellar: stellarAddress(ed25519.getPublicKey(stellarSeed)) };
  } finally {
    evmKey.fill(0);
    stellarSeed.fill(0);
  }
}
