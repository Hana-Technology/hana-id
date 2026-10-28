// Hex and EVM address helpers shared by the decoders, normalizeTypedData and the policy code.
import { keccak_256 } from '@noble/hashes/sha3';
import { bytesToHex } from '@noble/hashes/utils';
import { fail } from './errors.ts';

/** bytes → `0x` + lowercase hex. */
export const toHex0x = (bytes: Uint8Array): string => `0x${bytesToHex(bytes)}`;

/** `0x` + even-length hex (either case) → bytes; `length` pins the byte length. Throws DecodeError('invalid_value'). */
export function parseHex0x(text: string, length?: number): Uint8Array {
  if (!/^0x(?:[0-9a-fA-F]{2})*$/u.test(text)) fail('invalid_value', 'Expected 0x-prefixed, even-length hex');
  const out = new Uint8Array((text.length - 2) / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(text.slice(2 + 2 * i, 4 + 2 * i), 16);
  if (length !== undefined && out.length !== length) fail('invalid_value', `Expected ${length} bytes of hex`);
  return out;
}

/** EIP-55 checksummed form of a 20-byte address. */
export function checksumAddress(address: Uint8Array): string {
  if (address.length !== 20) throw new RangeError('An EVM address is 20 bytes');
  const lower = bytesToHex(address);
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = '0x';
  for (let i = 0; i < 40; i++) {
    const ch = lower[i] as string;
    out += Number.parseInt(hash[i] as string, 16) >= 8 ? ch.toUpperCase() : ch;
  }
  return out;
}

/**
 * Parses an EVM address: `0x` + 40 hex. All-lowercase and all-uppercase are accepted; mixed case must be a valid
 * EIP-55 checksum (a typo'd checksummed address is refused, as wallets do). Returns the checksummed form.
 */
export function parseEvmAddress(text: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/u.test(text)) fail('invalid_value', 'Expected an EVM address (0x + 40 hex)');
  const body = text.slice(2);
  const checksummed = checksumAddress(parseHex0x(text));
  const mixed = body !== body.toLowerCase() && body !== body.toUpperCase();
  if (mixed && checksummed !== text) fail('invalid_value', 'EVM address has a bad EIP-55 checksum');
  return checksummed;
}

/** True when `text` parses with parseEvmAddress. */
export function isEvmAddress(text: string): boolean {
  try {
    parseEvmAddress(text);
    return true;
  } catch {
    return false;
  }
}

/** Big-endian unsigned bytes → bigint (empty → 0n). */
export function bytesToBigInt(bytes: Uint8Array): bigint {
  return bytes.length === 0 ? 0n : BigInt(`0x${bytesToHex(bytes)}`);
}
