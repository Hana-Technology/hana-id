// Protocol decoders (docs/batch-b-spec.md "Protocol decoders (interface only in batch B)"). A policy function entry may
// name a decoder (`decoder: 'sodax-intent-v1'`) instead of `addressArgs`, for protocols that carry instructions in
// opaque bytes. The vault then applies the address rule to the decoder's `recipients` and `targets`. Batch B ships the
// interface and an empty registry: the validator refuses any decoder id the bundle doesn't ship, so Sodax swaps,
// bridges and hub actions always get the approval popup (Q42). Adding a decoder later changes neither the policy format
// nor existing consents, since a policy that names it has a new policyId.
import type { AbiValue } from '../decode/abi.ts';
import type { StellarScVal } from '../decode/stellar.ts';

/** A listed call handed to a decoder: the contract, the function and its decoded, typed arguments. */
export type ProtocolCall =
  | {
      readonly chain: 'stellar';
      /** C… */
      readonly contract: string;
      readonly function: string;
      readonly args: readonly StellarScVal[];
    }
  | {
      readonly chain: 'evm';
      /** EIP-55 */
      readonly contract: string;
      readonly selector: string;
      readonly signature: string;
      readonly args: readonly AbiValue[];
      readonly valueWei: bigint;
    };

export type ProtocolDecoderContext =
  | { readonly user: string; readonly chainId: number }
  | { readonly user: string; readonly networkPassphrase: string };

export interface ProtocolEffects {
  /** Everyone who receives assets or positions (on any chain, in that chain's address format). */
  readonly recipients: readonly string[];
  /** Every contract the call makes act (approvals, executions). */
  readonly targets: readonly string[];
  /** Token movements, for display (amount caps are Q39, not enforced in batch B). */
  readonly tokens: readonly { readonly asset: string; readonly amount: string }[];
}

export type ProtocolDecodeResult =
  | { readonly ok: true; readonly effects: ProtocolEffects }
  | { readonly ok: false; readonly reason: string };

export interface ProtocolDecoder {
  /** Stable id named by policies, e.g. 'sodax-intent-v1'. */
  readonly id: string;
  readonly chain: 'stellar' | 'evm';
  /** True when this decoder understands `call` (contract and function shape); false sends it to the popup. */
  matches(call: ProtocolCall): boolean;
  /** Decodes the opaque arguments into effects, or refuses. Must never throw for a call it `matches`. */
  decode(call: ProtocolCall, ctx: ProtocolDecoderContext): ProtocolDecodeResult;
}

export type ProtocolDecoderRegistry = ReadonlyMap<string, ProtocolDecoder>;

/** The decoders this bundle ships: none in batch B. */
export const PROTOCOL_DECODERS: ProtocolDecoderRegistry = new Map();

/** Builds a registry (tests, and later bundles that ship decoders). Throws on a duplicate id. */
export function protocolDecoderRegistry(decoders: readonly ProtocolDecoder[]): ProtocolDecoderRegistry {
  const out = new Map<string, ProtocolDecoder>();
  for (const d of decoders) {
    if (out.has(d.id)) throw new Error(`Duplicate protocol decoder ${d.id}`);
    out.set(d.id, d);
  }
  return out;
}
