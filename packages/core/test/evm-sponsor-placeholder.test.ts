// The placeholder mechanism of @hana-id/core/evm-sponsor (docs/decisions.md D846), against a fixture table: the real
// table has no placeholder since the delegate's deterministic deployment was pinned for 31337. Both signers refuse a
// placeholder entry unless a test passes `allowPlaceholderDelegateInTests: true` (exactly true). Test-only keys.
import { keccak_256 } from '@noble/hashes/sha3';
import { describe, expect, it, vi } from 'vitest';
import { utf8 } from '../src/bytes.ts';
import {
  type EvmSponsorErrorCode,
  type ExecuteInput,
  EvmSponsorError,
  SPONSOR_DELEGATES,
  ZERO_ADDRESS,
  isPinnedSponsorDelegate,
  signAuthorization,
  signExecute,
  sponsorDelegate,
} from '../src/evm-sponsor/index.ts';
import { evmSignerAddress } from '../src/signers/evm.ts';
import { FIXTURE_DELEGATE, FIXTURE_LOCAL } from './evm-sponsor-fixture.ts';

vi.mock('../src/evm-sponsor/delegates.ts', async (importOriginal) =>
  (await import('./evm-sponsor-fixture.ts')).withFixtureTable(await importOriginal()),
);

const D = Uint8Array.from(keccak_256(utf8('hana-id evm-sponsor placeholder test account')));
const LOCAL = FIXTURE_LOCAL;

function codeOf(f: () => unknown): EvmSponsorErrorCode {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(EvmSponsorError);
    return (e as EvmSponsorError).code;
  }
  throw new Error('expected a refusal');
}

const baseInput = (): ExecuteInput => ({
  chainId: LOCAL,
  account: evmSignerAddress(D),
  implementation: FIXTURE_DELEGATE,
  calls: [{ to: evmSignerAddress(Uint8Array.from(keccak_256(utf8('a target')))), value: 0n, data: '0x183ff085' }],
  nonce: 0n,
  deadline: 1_800_000_000n,
  relayer: evmSignerAddress(Uint8Array.from(keccak_256(utf8('a relayer')))),
  minGas: 100_000n,
});

describe('the placeholder delegate is refused unless a test opts in (fixture table)', () => {
  it('the fixture is in force: a placeholder on 31337, nothing else', () => {
    expect(Object.keys(SPONSOR_DELEGATES)).toEqual([String(LOCAL)]);
    expect(SPONSOR_DELEGATES[LOCAL]!.placeholder).toBe(true);
    expect(sponsorDelegate(LOCAL)?.address).toBe(FIXTURE_DELEGATE);
    expect(isPinnedSponsorDelegate(LOCAL, FIXTURE_DELEGATE)).toBe(true);
  });

  it('signAuthorization and signExecute refuse a placeholder by default', () => {
    const a = { chainId: LOCAL, address: FIXTURE_DELEGATE, nonce: 0n } as const;
    expect(codeOf(() => signAuthorization(D, a, { enabledChains: [LOCAL] }))).toBe('delegate_not_pinned');
    expect(codeOf(() => signAuthorization(D, { ...a, address: ZERO_ADDRESS }, { enabledChains: [LOCAL], revoke: true }))).toBe('delegate_not_pinned');
    expect(codeOf(() => signExecute(D, baseInput(), { enabledChains: [LOCAL] }))).toBe('delegate_not_pinned');
  });

  it('the option must be exactly true', () => {
    const a = { chainId: LOCAL, address: FIXTURE_DELEGATE, nonce: 0n } as const;
    for (const opt of [false, 'true', 1]) {
      expect(codeOf(() => signAuthorization(D, a, { enabledChains: [LOCAL], allowPlaceholderDelegateInTests: opt } as never))).toBe('invalid_input');
      expect(codeOf(() => signExecute(D, baseInput(), { enabledChains: [LOCAL], allowPlaceholderDelegateInTests: opt } as never))).toBe('invalid_input');
    }
  });

  it('with the option, a test can sign for the placeholder', () => {
    const opts = { enabledChains: [LOCAL], allowPlaceholderDelegateInTests: true } as const;
    expect(signAuthorization(D, { chainId: LOCAL, address: FIXTURE_DELEGATE, nonce: 0n }, opts).address).toBe(FIXTURE_DELEGATE);
    expect(signExecute(D, baseInput(), opts)).toMatch(/^0x[0-9a-f]{130}$/u);
  });
});
