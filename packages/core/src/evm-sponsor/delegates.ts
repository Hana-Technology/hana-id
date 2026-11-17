// The pinned EIP-7702 delegate per chain (docs/decisions.md D846): the one contract a user's account may be delegated
// to for sponsored actions, `HanaDelegateExecutor` (contracts/evm-delegate, D841). Pinned data built into the vault and
// the API, like verified-contracts.ts: a code release changes it, never D1, the API or a manifest (the manifest's
// `evm.sponsor` block must agree with this table, D834). The authorization signer refuses any other address, and the
// Execute signer any other implementation, so no request can delegate an account elsewhere.
//
// Adding an entry: only once the contract is deployed on that chain from the reviewed source, the address checked to
// be the CREATE2 address the repo predicts, and `runtimeCodeHash` read from the chain and checked against the
// checked-in artifact (contracts/evm-delegate/artifacts/HanaDelegateExecutor.json). test/evm-sponsor.test.ts checks
// every entry's shape, and that every entry that is not a placeholder has the artifact's address and code hash (so a
// contract change cannot leave a stale pin).
//
// Today: chain 31337 (a local Anvil or Hardhat node) has the delegate's deterministic deployment: the CREATE2 address
// through the deterministic deployment proxy and the runtime code hash at that address, from the artifact (anyone can
// deploy it there; the local lane does). Base Sepolia (84532) has none until the delegate is deployed there (after
// 2026-11-25) and the on-chain code hash is checked. `placeholder: true` marks an entry that is not a deployed contract;
// the signers refuse one unless a test opts in, and the tests exercise that with a fixture table.
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

export const SPONSOR_DELEGATES: Readonly<Record<number, SponsorDelegate>> = Object.freeze({
  // Local chain: the deterministic deployment of contracts/evm-delegate (artifacts/HanaDelegateExecutor.json `create2`
  // and `runtimeCodeHash`; a test checks they agree).
  31337: Object.freeze({
    address: '0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA',
    runtimeCodeHash: '0xfcc832fe6c7167e0d45589881b103fed92b3a44fe3dd5d489f43e9d44b1e5fd2',
    domain: SPONSOR_DELEGATE_DOMAIN,
    abiVersion: SPONSOR_ABI_VERSION,
    placeholder: false,
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
