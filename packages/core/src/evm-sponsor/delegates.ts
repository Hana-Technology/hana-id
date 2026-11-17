// The pinned EIP-7702 delegate per chain (docs/decisions.md D846): the one contract a user's account may be delegated
// to for sponsored actions, `HanaDelegateExecutor` (contracts/evm-delegate, D841). Pinned data built into the vault and
// the API, like verified-contracts.ts: a code release changes it, never D1, the API or a manifest (the manifest's
// `evm.sponsor` block must agree with this table, D834). The authorization signer refuses any other address, and the
// Execute signer any other implementation, so no request can delegate an account elsewhere.
//
// Adding an entry: only once the contract is deployed on that chain from the reviewed source, the address checked to
// be the CREATE2 address the repo predicts, and `runtimeCodeHash` read from the chain and checked against the
// checked-in artifact (contracts/evm-delegate/artifacts/HanaDelegateExecutor.json). test/evm-sponsor.test.ts checks
// every entry's shape.
//
// Today: no deployed entry. Base Sepolia (84532) has none until the delegate is deployed there (after 2026-11-25);
// chain 31337 (a local Anvil or Hardhat node) has a PLACEHOLDER entry for tests only, marked `placeholder: true`, with
// an obviously fake address and a zero code hash. It is replaced by the predicted CREATE2 address once the contract's
// artifact lands.
import type { Hex } from '../signers/evm.ts';

/** The Execute domain's `name` and `version`, exactly as the contract hashes them. */
export const SPONSOR_DELEGATE_DOMAIN = Object.freeze({ name: 'HanaDelegateExecutor', version: '1' } as const);

/** The ABI and typed-data layout this module codes against (the delegate contract's interface v1). */
export const SPONSOR_ABI_VERSION = 1;

export interface SponsorDelegate {
  /** The delegate (implementation) address, EIP-55. Under EIP-7702 also the Execute domain's `salt`. */
  readonly address: Hex;
  /** keccak256 of the deployed runtime code, `0x` + 64 lowercase hex (all zeros only for a placeholder). */
  readonly runtimeCodeHash: Hex;
  /** The Execute domain's `name` and `version`. */
  readonly domain: { readonly name: string; readonly version: string };
  /** The interface version (SPONSOR_ABI_VERSION when this module can sign for it). */
  readonly abiVersion: number;
  /** True for an entry that is not a deployed contract (tests and local nodes only). */
  readonly placeholder: boolean;
}

const ZERO_HASH: Hex = `0x${'0'.repeat(64)}`;

export const SPONSOR_DELEGATES: Readonly<Record<number, SponsorDelegate>> = Object.freeze({
  // PLACEHOLDER for local tests (31337): not a deployed contract. Replace with the predicted CREATE2 address and the
  // artifact's runtime code hash once contracts/evm-delegate lands.
  31337: Object.freeze({
    address: '0x7702000000000000000000000000000000007702',
    runtimeCodeHash: ZERO_HASH,
    domain: SPONSOR_DELEGATE_DOMAIN,
    abiVersion: SPONSOR_ABI_VERSION,
    placeholder: true,
  }),
} satisfies Record<number, SponsorDelegate>);

/** The pinned delegate for a chain, or null. */
export function sponsorDelegate(chainId: number, table: Readonly<Record<number, SponsorDelegate>> = SPONSOR_DELEGATES): SponsorDelegate | null {
  if (!Number.isSafeInteger(chainId) || chainId <= 0 || !Object.hasOwn(table, chainId)) return null;
  return table[chainId] ?? null;
}

/** Whether `address` (any case) is the pinned delegate on `chainId`. */
export function isPinnedSponsorDelegate(chainId: number, address: string): boolean {
  const d = sponsorDelegate(chainId);
  return d !== null && typeof address === 'string' && address.toLowerCase() === d.address.toLowerCase();
}
