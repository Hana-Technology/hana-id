// AutoApprovePolicyV1 (docs/batch-b-spec.md "Auto-approve policies"). An app owner sets one per app; the vault signs a
// matching request without a popup only after the user accepted that exact policy (its policyId) in a Hana popup.
// These are the normalized shapes validateAutoApprovePolicy returns: every function entry carries exactly one of
// `addressArgs` (default 'self-or-listed') or `decoder`, EVM addresses are EIP-55 and selectors are lowercase.

/**
 * 'self-or-listed': every address-typed argument, at any depth, must be the user's own address, a listed contract or a
 * policy `addresses` entry. 'any': no check on typed addresses (shown to the user as "can send to any address"). Under
 * either rule, opaque arguments (policy/opaque.ts) are never auto-approved: such functions need a protocol decoder.
 */
export type AddressArgsRule = 'self-or-listed' | 'any';

/** How a listed function's arguments are checked: the address rule, or a protocol decoder's effects. */
export type FunctionRule =
  | { readonly addressArgs: AddressArgsRule; readonly decoder?: undefined }
  | { readonly decoder: string; readonly addressArgs?: undefined };

export type StellarPolicyFunction = { readonly name: string } & FunctionRule;

export interface StellarPolicyContract {
  /** Contract StrKey, C…. */
  readonly id: string;
  /** Partner-supplied name shown on the consent screen next to the id. */
  readonly name: string;
  readonly functions: readonly StellarPolicyFunction[];
}

export interface StellarPolicy {
  readonly networkPassphrases: readonly string[];
  /** Per transaction, stroops, decimal. */
  readonly maxFeeStroops: string;
  readonly contracts: readonly StellarPolicyContract[];
  /** `CODE:ISSUER`: the only classic operation a policy may cover is changeTrust for these. */
  readonly changeTrustAssets?: readonly string[];
  /** Extra G…/C… addresses allowed as call arguments. */
  readonly addresses?: readonly string[];
}

export type EvmPolicySelector = {
  /** `0x` + 8 lowercase hex; must equal the first 4 bytes of keccak256(signature). */
  readonly selector: string;
  /** Canonical signature, e.g. `transfer(address,uint256)`; calldata must decode against it. */
  readonly signature: string;
} & FunctionRule;

export interface EvmPolicyContract {
  /** EIP-55 address. */
  readonly address: string;
  readonly name: string;
  readonly selectors: readonly EvmPolicySelector[];
}

export interface EvmPolicyTypedData {
  readonly verifyingContract: string;
  readonly primaryType: string;
}

export interface EvmPolicyChain {
  readonly chainId: number;
  /**
   * Per transaction, wei, decimal: the most an auto-signed transaction may take from the native balance, its value
   * plus its maximum fee (gasLimit × maxFeePerGas, or gasPrice for legacy). So a non-zero value is needed even for
   * calls that send no value: at least the fee they may pay.
   */
  readonly maxValueWei: string;
  /** Per UTC day, wei, decimal: today's auto-signed value plus maximum fees on this chain, this transaction included. */
  readonly maxValueWeiPerDay: string;
  /**
   * Per transaction, wei, decimal, at least 1: the most the transaction may pay in fees (gasLimit × maxFeePerGas, or
   * gasPrice for legacy). The SDK fills gas and fee fields on the partner page, so without this cap an injected script
   * could burn the user's native balance in priority fees. The EVM counterpart of `maxFeeStroops`. The fee also counts
   * against maxValueWei and maxValueWeiPerDay.
   */
  readonly maxFeeWei: string;
  readonly contracts: readonly EvmPolicyContract[];
  readonly typedData?: readonly EvmPolicyTypedData[];
  readonly addresses?: readonly string[];
}

export interface AutoApprovePolicyV1 {
  readonly v: 1;
  /** ≤ 80 characters, shown to the user ("Swaps on Sodax"). */
  readonly label: string;
  /** ≤ the app's session_ttl_ms; the consent ends earlier with the session. */
  readonly maxConsentMs: number;
  /** Auto-signed requests per user per UTC day, 1 to 500. */
  readonly limits: { readonly perDayCount: number };
  readonly stellar?: StellarPolicy;
  readonly evm?: { readonly chains: readonly EvmPolicyChain[] };
}
