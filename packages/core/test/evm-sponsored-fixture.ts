// Sponsored-action approval subjects for the tests (kind `evm_sponsored`, D850): what the vault will build from the
// API's prepare answer and its manifest, on the local chain 31337 whose delegate core pins (SPONSOR_DELEGATES). The
// relayer is anvil's published second dev account's address (a public test vector; no key here).
import type { ApprovalSubject } from '../src/approval.ts';
import { SPONSOR_DELEGATES } from '../src/evm-sponsor/delegates.ts';
import { type EvmSponsorSubject, encodeSponsorSubject } from '../src/evm-sponsor/subject.ts';
import type { Hex } from '../src/signers/evm.ts';
import { parseFunctionSignature } from '../src/decode/index.ts';

export const SPONSOR_CHAIN = 31337;
export const SPONSOR_DELEGATE = (SPONSOR_DELEGATES[SPONSOR_CHAIN] as { address: Hex }).address;
export const SPONSOR_RELAYER: Hex = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
/** The user (the same EVM address as the other approval tests). */
export const SPONSOR_ME: Hex = '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826';
/** The build's sponsor chains (HanaEnv.evmSponsor's shape). */
export const SPONSOR_CHAINS = Object.freeze({ [String(SPONSOR_CHAIN)]: Object.freeze({ delegate: SPONSOR_DELEGATE, relayer: SPONSOR_RELAYER }) });

export const CHECK_IN: Hex = '0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e';
export const TOKEN: Hex = '0x1111111111111111111111111111111111111111';
export const SPENDER: Hex = '0x3333333333333333333333333333333333333333';
export const RECIPIENT: Hex = '0x000000000000000000000000000000000000dEaD';
export const UINT256_MAX = 2n ** 256n - 1n;

const word = (v: bigint | string | boolean) => (typeof v === 'string' ? v.slice(2).toLowerCase().padStart(64, '0') : (typeof v === 'boolean' ? (v ? 1n : 0n) : v).toString(16).padStart(64, '0'));
/** ABI calldata for `sig` with static arguments. */
export const calldata = (sig: string, ...args: (bigint | string | boolean)[]): Hex => `${parseFunctionSignature(sig).selector}${args.map(word).join('')}` as Hex;
/** The demo's `checkIn()` (exactly its selector). */
export const CHECK_IN_DATA: Hex = '0x183ff085';

export const sponsoredCall = (to: Hex, data: Hex) => ({ to, value: 0n, data });

export function sponsorSubject(over: Partial<EvmSponsorSubject> = {}): EvmSponsorSubject {
  return {
    chainId: SPONSOR_CHAIN,
    account: SPONSOR_ME,
    delegate: SPONSOR_DELEGATE,
    authNonce: null,
    calls: [sponsoredCall(CHECK_IN, CHECK_IN_DATA)],
    executeNonce: 0n,
    deadline: 1_900_000_000n,
    relayer: SPONSOR_RELAYER,
    minGas: 100_000n,
    ...over,
  };
}

/** The approval subject the vault will queue for `s`. */
export function sponsoredApproval(s: EvmSponsorSubject = sponsorSubject(), address: string = SPONSOR_ME): ApprovalSubject {
  return { kind: 'evm_sponsored', chain: 'evm', address, context: { chainId: s.chainId }, bytes: encodeSponsorSubject(s) };
}
