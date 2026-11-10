// The daily relayer nonce cross-check (apps/admin/src/nonce-check.ts): which chain nonces count as explained.
import { describe, expect, it } from 'vitest';
import type { LedgerStore } from '../src/ledger.ts';
import type { Budget } from '../src/mail.ts';
import type { NearReader } from '../src/near.ts';
import { NEW_KEY_NONCE_STEP, runNonceCheck } from '../src/nonce-check.ts';

const PK = 'ed25519:relayer';

function run(o: { nonce: bigint | null; prev?: bigint; relayed?: boolean; hasRows?: boolean }) {
  const recorded: { chainNonce: bigint; explained: boolean }[] = [];
  const store = {
    lastNonceCheck: async () => (o.prev === undefined ? null : { relayerPk: PK, checkedAt: 1, chainNonce: o.prev, explained: true, ledgerRelayedSinceLast: 0, alertedAt: null }),
    relayedWithNonce: async () => o.relayed ?? false,
    hasRelayedRows: async () => o.hasRows ?? false,
    relayedSince: async () => 3,
    recordNonceCheck: async (r: { chainNonce: bigint; explained: boolean }) => {
      recorded.push(r);
    },
    // The day's keys already tried (none yet).
    state: { getState: async () => new Map(), setState: async () => {} },
  } as unknown as LedgerStore;
  const near = { accessKeyNonce: async () => o.nonce } as unknown as NearReader;
  const budget = { take: () => true } as unknown as Budget;
  return runNonceCheck({ store, near, keys: [PK], relayerAccount: 'relayer.testnet', budget, now: 100 }).then((sum) => ({ sum, recorded }));
}

describe('runNonceCheck', () => {
  it('unchanged since the last check is explained', async () => {
    const { sum, recorded } = await run({ nonce: 5n, prev: 5n });
    expect(sum).toMatchObject({ checked: 1, unexplained: 0, rebaselined: 0 });
    expect(recorded[0]?.explained).toBe(true);
  });

  it('a relayed row at the nonce explains it', async () => {
    expect((await run({ nonce: 5n, prev: 4n, relayed: true })).sum).toMatchObject({ unexplained: 0, rebaselined: 0 });
  });

  it('a first check with an empty ledger is the baseline', async () => {
    expect((await run({ nonce: 5n })).sum).toMatchObject({ unexplained: 0, rebaselined: 0 });
  });

  it('a jump with no relayed row is unexplained', async () => {
    const { sum, recorded } = await run({ nonce: 5n + 41n, prev: 5n });
    expect(sum).toMatchObject({ unexplained: 1, rebaselined: 0 });
    expect(recorded[0]?.explained).toBe(false);
  });

  it('a re-added key starts at a whole multiple of 10^6: a new baseline, not an alert', async () => {
    const reAdded = 212_345_000_000n;
    expect(reAdded % NEW_KEY_NONCE_STEP).toBe(0n);
    const { sum, recorded } = await run({ nonce: reAdded, prev: 200_000_007n, hasRows: true });
    expect(sum).toMatchObject({ checked: 1, unexplained: 0, rebaselined: 1 });
    expect(recorded[0]).toMatchObject({ chainNonce: reAdded, explained: true });
  });

  it('a nonce just past a multiple of 10^6, with no relayed row, is not a re-add', async () => {
    expect((await run({ nonce: 212_345_000_001n, prev: 200_000_007n, hasRows: true })).sum).toMatchObject({ unexplained: 1, rebaselined: 0 });
  });

  it('skips a key the account does not have', async () => {
    expect((await run({ nonce: null })).sum).toMatchObject({ checked: 0, skipped: 1 });
  });
});
