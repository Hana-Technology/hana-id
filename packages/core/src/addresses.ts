// Address and key encodings: Stellar StrKey (SEP-23), EVM EIP-55 and NEAR (implicit account ids, `ed25519:` keys,
// account id rules). Moved from apps/smoke/src/chain-keys.ts (its PROVISIONAL derivation is replaced by derivation.ts).
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak_256 } from '@noble/hashes/sha3';
import { base32, base58 } from '@scure/base';
import { type Bytes, toBytes, toHex, utf8 } from './bytes.ts';

/** SEP-23 version bytes. */
export const STRKEY_VERSION = {
  /** G…: Ed25519 public key (account ID). */
  ed25519PublicKey: 6 << 3,
  /** S…: Ed25519 secret seed. */
  ed25519SecretSeed: 18 << 3,
  /** C…: contract. */
  contract: 2 << 3,
} as const;

export type StrKeyVersion = (typeof STRKEY_VERSION)[keyof typeof STRKEY_VERSION];

function crc16xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** StrKey: base32(version ‖ 32-byte payload ‖ CRC16-XModem LE). The intermediate buffer is zeroed (it may be a seed). */
export function encodeStrKey(version: StrKeyVersion, payload32: Uint8Array): string {
  if (payload32.length !== 32) throw new Error('StrKey payload must be 32 bytes');
  const raw = new Uint8Array(35);
  raw[0] = version;
  raw.set(payload32, 1);
  const crc = crc16xmodem(raw.subarray(0, 33));
  raw[33] = crc & 0xff;
  raw[34] = crc >> 8;
  try {
    return base32.encode(raw);
  } finally {
    raw.fill(0);
  }
}

/** Decodes and checks a 56-character StrKey of the given version (version byte, length and CRC). */
export function decodeStrKey(version: StrKeyVersion, text: string): Bytes {
  if (!/^[A-Z2-7]{56}$/u.test(text)) throw new Error('Malformed StrKey');
  const raw = base32.decode(text);
  try {
    if (raw.length !== 35 || raw[0] !== version) throw new Error('Wrong StrKey version');
    const crc = crc16xmodem(raw.subarray(0, 33));
    if (raw[33] !== (crc & 0xff) || raw[34] !== crc >> 8) throw new Error('Bad StrKey checksum');
    // 35 bytes are exactly 56 base32 characters (no padding, no spare bits), so the decoding is canonical.
    return toBytes(raw.subarray(1, 33));
  } finally {
    raw.fill(0);
  }
}

/** Stellar account (G…) for an Ed25519 public key. */
export const stellarAddress = (publicKey: Uint8Array): string => encodeStrKey(STRKEY_VERSION.ed25519PublicKey, publicKey);

/** True for a well-formed G… account ID (checksum included). */
export function isStellarAddress(text: string): boolean {
  try {
    decodeStrKey(STRKEY_VERSION.ed25519PublicKey, text);
    return true;
  } catch {
    return false;
  }
}

/** EIP-55 checksummed form of 20 address bytes. */
export function checksumEvmAddress(address20: Uint8Array): `0x${string}` {
  if (address20.length !== 20) throw new Error('EVM address must be 20 bytes');
  const lower = toHex(address20);
  const hash = toHex(keccak_256(utf8(lower)));
  let out = '';
  for (let i = 0; i < lower.length; i++) out += Number.parseInt(hash[i]!, 16) >= 8 ? lower[i]!.toUpperCase() : lower[i]!;
  return `0x${out}`;
}

/** EIP-55 checksummed address of a secp256k1 public key (65-byte uncompressed or 33-byte compressed). */
export function evmAddress(publicKey: Uint8Array): `0x${string}` {
  const uncompressed = publicKey.length === 65 ? publicKey : secp256k1.ProjectivePoint.fromHex(publicKey).toRawBytes(false);
  return checksumEvmAddress(keccak_256(uncompressed.subarray(1)).subarray(-20));
}

/**
 * Parses a `0x` + 40 hex address. All-lowercase and all-uppercase are accepted as is; mixed case must be a valid
 * EIP-55 checksum (a typo in a checksummed address is refused, not silently accepted).
 */
export function parseEvmAddress(text: string): Bytes {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(text)) throw new Error('Malformed EVM address');
  const body = text.slice(2);
  const bytes = Uint8Array.from({ length: 20 }, (_, i) => Number.parseInt(body.slice(2 * i, 2 * i + 2), 16));
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksumEvmAddress(bytes) !== text) throw new Error('Bad EIP-55 checksum');
  return bytes;
}

/** True for a well-formed EVM address (EIP-55 checked when mixed case). */
export function isEvmAddress(text: string): boolean {
  try {
    parseEvmAddress(text);
    return true;
  } catch {
    return false;
  }
}

// ---- NEAR ----

/**
 * A NEAR account id as nearcore validates it (2 to 64 characters; parts of `[a-z0-9]` runs joined by single `-` or
 * `_`, separated by `.`): named accounts (`alice.testnet`), implicit ones (64 lowercase hex) and ETH-implicit ones
 * (`0x` + 40 lowercase hex) all pass. Every such id is ASCII, so it is always safe to show.
 */
export const isNearAccountId = (v: unknown): v is string =>
  typeof v === 'string' && /^(?=.{2,64}$)(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/u.test(v);

/** A NEAR implicit account id: the 64 lowercase hex characters of an Ed25519 public key. */
export const isNearImplicitAccountId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/u.test(v);

/** The implicit account id of a 32-byte Ed25519 public key (lowercase hex, 64 characters). */
export function nearImplicitAccountId(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) throw new Error('NEAR Ed25519 public key must be 32 bytes');
  return toHex(publicKey);
}

/** The Ed25519 public key of an implicit account id (the inverse of nearImplicitAccountId). */
export function nearImplicitPublicKey(accountId: string): Bytes {
  if (!isNearImplicitAccountId(accountId)) throw new Error('Not a NEAR implicit account id');
  return Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(accountId.slice(2 * i, 2 * i + 2), 16));
}

/** The NEAR key types (borsh `KeyType`): 0 Ed25519 (32-byte keys, 64-byte signatures), 1 secp256k1 (64, 65). */
export type NearKeyType = 'ed25519' | 'secp256k1';
export const NEAR_KEY_LENGTHS: Readonly<Record<NearKeyType, number>> = Object.freeze({ ed25519: 32, secp256k1: 64 });

/** `ed25519:<base58>` (or `secp256k1:<base58>` for a 64-byte key), as NEAR RPCs and wallets print public keys. */
export function nearPublicKeyString(publicKey: Uint8Array, type: NearKeyType = 'ed25519'): string {
  if (publicKey.length !== NEAR_KEY_LENGTHS[type]) throw new Error(`NEAR ${type} public key must be ${NEAR_KEY_LENGTHS[type]} bytes`);
  return `${type}:${base58.encode(publicKey)}`;
}

/**
 * Parses `ed25519:<base58>` (or `secp256k1:<base58>`) strictly: the prefix is required, and the base58 must decode
 * to the key's exact length and encode back to the same text.
 */
export function parseNearPublicKey(text: string): { type: NearKeyType; bytes: Bytes } {
  const m = /^(ed25519|secp256k1):([1-9A-HJ-NP-Za-km-z]{1,100})$/u.exec(text);
  if (!m) throw new Error('Malformed NEAR public key');
  const type = m[1] as NearKeyType;
  const bytes = toBytes(base58.decode(m[2]!));
  if (bytes.length !== NEAR_KEY_LENGTHS[type] || base58.encode(bytes) !== m[2]) throw new Error('Malformed NEAR public key');
  return { type, bytes };
}

/** True for a well-formed `ed25519:` or `secp256k1:` NEAR public key string. */
export function isNearPublicKey(text: unknown): text is string {
  if (typeof text !== 'string') return false;
  try {
    parseNearPublicKey(text);
    return true;
  } catch {
    return false;
  }
}
