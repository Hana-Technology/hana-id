// Argument types the address rule can't see into. A recipient doesn't have to be typed `address`: bridges carry it as
// `bytes32` (Wormhole, LayerZero, ERC-7683), as a `string` (Axelar `destinationAddress`), as a `uint160` (an address
// cast to an integer), or inside opaque `bytes`. Such arguments are never auto-approved without a protocol decoder:
// the validator refuses them under either `addressArgs` rule when the signature is known, and the matcher refuses
// them in every request as defence in depth, so an allowed function can't be pointed at an attacker's address through
// them. Fixed bytes shorter than 20 bytes (selectors, flags) can't hold an address on any supported chain and pass.
//
// Integers: only those exactly 160 bits wide (`uint160`, `int160`) are treated as opaque, because that is the width
// of an EVM address and Solidity converts between the two directly. Wider integers (`uint256` and the like) stay
// allowed as amounts. Residual risk: a contract that casts a `uint256` argument to an address (`address(uint160(x))`)
// isn't caught; only contracts the partner lists are ever auto-approved, and the user sees the list on consent.
// Soroban has no 160-bit integer type (its integers are 32, 64, 128 and 256 bits), so the Soroban check has nothing
// to add here; a `u256`/`i256` cast to an address is the same residual risk.
import type { AbiType, AbiValue } from '../decode/abi.ts';
import type { ParsedTypedDataType } from '../typed-data.ts';

/** The smallest fixed-bytes size that can hold an address (EVM, hash160 and others; Stellar and Solana keys are 32). */
export const ADDRESS_SIZED_BYTES = 20;
/** The integer width that is an EVM address (`uint160`, `int160`). */
export const ADDRESS_SIZED_INT_BITS = 160;

/**
 * True for an ABI or EIP-712 type the address rule can't check: `bytes`, `string`, `bytesN` with N ≥ 20, or a
 * 160-bit integer. Not recursive (use abiTypeContains for arrays and tuples).
 */
export function isOpaqueToAddressRule(t: AbiType | ParsedTypedDataType): boolean {
  switch (t.kind) {
    case 'bytes':
    case 'string':
      return true;
    case 'fixedBytes':
      return t.size >= ADDRESS_SIZED_BYTES;
    case 'uint':
    case 'int':
      return t.bits === ADDRESS_SIZED_INT_BITS;
    default:
      return false;
  }
}

/** The same check on a decoded ABI value (values carry their canonical type string). Not recursive. */
export function isOpaqueAbiValue(v: AbiValue): boolean {
  switch (v.kind) {
    case 'string':
      return true;
    case 'bytes':
      return v.type === 'bytes' || Number(v.type.slice('bytes'.length)) >= ADDRESS_SIZED_BYTES;
    case 'uint':
    case 'int':
      return Number(v.type.slice(v.kind.length)) === ADDRESS_SIZED_INT_BITS;
    default:
      return false;
  }
}

/** The first opaque value in `values`, at any depth of arrays and tuples, or undefined. */
export function findOpaqueAbiValue(values: readonly AbiValue[]): AbiValue | undefined {
  for (const v of values) {
    if (isOpaqueAbiValue(v)) return v;
    if (v.kind === 'array' || v.kind === 'tuple') {
      const inner = findOpaqueAbiValue(v.items);
      if (inner) return inner;
    }
  }
  return undefined;
}
