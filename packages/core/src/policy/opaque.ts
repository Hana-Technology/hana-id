// Argument types the address rule can't see into. A recipient doesn't have to be typed `address`: bridges carry it as
// `bytes32` (Wormhole, LayerZero, ERC-7683), as a `string` (Axelar `destinationAddress`), or inside opaque `bytes`.
// Under 'self-or-listed' such arguments are refused (by the validator when the signature is known, and by the matcher
// for every request as defence in depth), so an allowed function can't be pointed at an attacker's address through
// them. Fixed bytes shorter than 20 bytes (selectors, flags) can't hold an address on any supported chain and pass.
import type { AbiType, AbiValue } from '../decode/abi.ts';
import type { ParsedTypedDataType } from '../typed-data.ts';

/** The smallest fixed-bytes size that can hold an address (EVM, hash160 and others; Stellar and Solana keys are 32). */
export const ADDRESS_SIZED_BYTES = 20;

/** True for an ABI or EIP-712 type the address rule can't check: `bytes`, `string`, or `bytesN` with N ≥ 20. */
export function isOpaqueToAddressRule(t: AbiType | ParsedTypedDataType): boolean {
  return t.kind === 'bytes' || t.kind === 'string' || (t.kind === 'fixedBytes' && t.size >= ADDRESS_SIZED_BYTES);
}

/** The same check on a decoded ABI value (`bytesN` values carry their canonical type string). */
export function isOpaqueAbiValue(v: AbiValue): boolean {
  if (v.kind === 'string') return true;
  if (v.kind !== 'bytes') return false;
  if (v.type === 'bytes') return true;
  return Number(v.type.slice('bytes'.length)) >= ADDRESS_SIZED_BYTES;
}
