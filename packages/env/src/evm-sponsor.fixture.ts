// Test fixture (not shipped code): an `evm.sponsor` block with the spec's numbers (D836) for Base Sepolia, made-up
// addresses, and a made-up pinned delegate table in the shape of core's SPONSOR_DELEGATES. No env manifest carries the
// block: the env, gen-wrangler, gen-envs and API parser tests add it to a copy of sandbox-dev in memory.
import { checksumEvmAddress, type EvmSponsor, type PinnedSponsorDelegates } from './evm-sponsor.ts';

/** A made-up address: 40 hex characters from a repeated pattern, EIP-55 checksummed. */
export const fixtureAddress = (pattern: string): string => checksumEvmAddress(`0x${pattern.repeat(40).slice(0, 40)}`);

export const FIXTURE_RELAYER = fixtureAddress('a1c3');
export const FIXTURE_DELEGATE = fixtureAddress('def1');
export const FIXTURE_CHECK_IN = fixtureAddress('c4e7');
export const FIXTURE_APP = 'app_SponsorFixture1';
/** `checkIn()`'s selector (keccak-256 of "checkIn()", first 4 bytes). */
export const CHECK_IN_SELECTOR = '0x183ff085';

/** A valid block: one chain (Base Sepolia, 84532), one app with one target. A fresh copy each call. */
export function sponsorFixture(): EvmSponsor {
  return {
    relayerAddress: FIXTURE_RELAYER,
    chains: {
      '84532': {
        rpc: 'https://sepolia.base.org',
        rpcFallback: 'https://base-sepolia-rpc.publicnode.com',
        delegate: FIXTURE_DELEGATE,
        opStack: true,
        maxGasPerTx: 300_000,
        maxFeePerGasGwei: 1,
        maxPriorityFeePerGasGwei: 0.01,
        maxCallsPerBatch: 4,
        deadlineMaxS: 600,
        minGas: 100_000,
        dailyBudgetEth: 0.02,
        appDailyBudgetEth: 0.01,
        lowBalanceEth: 0.05,
        perUserPerDay: 30,
        perAppPerDay: 2000,
        sendsPerDay: 5000,
        sendsPerMinute: 60,
        requireKnownAccount: true,
      },
    },
    apps: { [FIXTURE_APP]: { '84532': [{ address: FIXTURE_CHECK_IN, selectors: [CHECK_IN_SELECTOR], label: 'Journear demo check-in' }] } },
  };
}

/** A pinned delegate table in core's shape, naming the fixture's delegate for 84532 only. */
export const FIXTURE_PINNED_DELEGATES: PinnedSponsorDelegates = Object.freeze({
  84532: Object.freeze({ address: FIXTURE_DELEGATE, runtimeCodeHash: `0x${'00'.repeat(32)}`, domain: { name: 'HanaDelegateExecutor', version: '1' }, abiVersion: 1 }),
});
