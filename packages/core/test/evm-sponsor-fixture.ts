// A fixture delegate table, mocked over src/evm-sponsor/delegates.ts (vi.mock) by the tests that need what the real
// table no longer has: a placeholder entry (the signers' refusal of one, and the test-only option that lets a test
// through), and the shared vector's arbitrary implementation on 31337 (`0x7702…7702`, the vector names its own; the
// vector is not regenerated for the real pin). The real table is tested as it is in evm-sponsor.test.ts.
//
//   vi.mock('../src/evm-sponsor/delegates.ts', async (importOriginal) =>
//     (await import('./evm-sponsor-fixture.ts')).withFixtureTable(await importOriginal()));
import type * as Delegates from '../src/evm-sponsor/delegates.ts';

export const FIXTURE_LOCAL = 31337;
/** The fixture's placeholder delegate on 31337: the shared vector's implementation for its local cases. */
export const FIXTURE_DELEGATE = '0x7702000000000000000000000000000000007702';

export function withFixtureTable(real: typeof Delegates): typeof Delegates {
  const table: Readonly<Record<number, Delegates.SponsorDelegate>> = Object.freeze({
    [FIXTURE_LOCAL]: Object.freeze({
      address: FIXTURE_DELEGATE,
      runtimeCodeHash: `0x${'0'.repeat(64)}`,
      domain: real.SPONSOR_DELEGATE_DOMAIN,
      abiVersion: real.SPONSOR_ABI_VERSION,
      placeholder: true,
    }),
  });
  return {
    ...real,
    SPONSOR_DELEGATES: table,
    sponsorDelegate: (chainId, t = table) => real.sponsorDelegate(chainId, t),
    isPinnedSponsorDelegate: (chainId, address) => {
      const d = real.sponsorDelegate(chainId, table);
      return d !== null && typeof address === 'string' && address.toLowerCase() === d.address.toLowerCase();
    },
  };
}
