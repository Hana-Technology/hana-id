// The daily nonce cross-check, 00:30 UTC (docs/batch-c-spec.md "Daily nonce cross-check"; D34, D93 Q13; D323). For each
// relayer key (`AdminRpc.relayerKeys`, both pools) the access key's nonce N at final is the nonce of the key's last
// landed transaction, and every API relay writes a ledger row with (relayer_pk, relayer_nonce), so:
//
// - N unchanged since the key's last check: idle, explained;
// - a relayed row with relayer_nonce = N: explained;
// - a key's first check when the ledger has never seen it: the baseline, explained (its earlier use predates the ledger);
// - otherwise `nonce_unexplained`: a usage write was lost, or something other than the API signed with a relayer key.
//
// Each check is one `ops.nonce_checks` row, with the ledger's relayed rows since the last check (shown, not alerted:
// reservations skip nonces, D21). The alert step (alerts.ts) emails unexplained rows to the security alias. One
// `view_access_key` per key from the run's budget.
import type { Budget } from './mail.ts';
import type { LedgerStore } from './ledger.ts';
import type { NearReader } from './near.ts';

export interface NonceDeps {
  store: LedgerStore;
  near: NearReader;
  keys: readonly string[];
  relayerAccount: string;
  budget: Budget;
  now: number;
}

export interface NonceSummary {
  checked: number;
  unexplained: number;
  skipped: number;
}

export async function runNonceCheck(d: NonceDeps): Promise<NonceSummary> {
  const sum: NonceSummary = { checked: 0, unexplained: 0, skipped: 0 };
  for (const pk of d.keys) {
    if (!d.budget.take()) {
      sum.skipped++;
      continue;
    }
    let n: bigint | null;
    try {
      n = await d.near.accessKeyNonce(d.relayerAccount, pk);
    } catch {
      sum.skipped++;
      continue;
    }
    // A pool key the account doesn't have (removed on chain, or not yet added) has no nonce to explain.
    if (n === null) {
      sum.skipped++;
      continue;
    }
    const prev = await d.store.lastNonceCheck(pk);
    let explained: boolean;
    if (prev && prev.chainNonce === n) explained = true;
    else if (await d.store.relayedWithNonce(pk, n)) explained = true;
    else explained = !prev && !(await d.store.hasRelayedRows(pk));
    const since = await d.store.relayedSince(pk, prev?.checkedAt ?? null, d.now);
    await d.store.recordNonceCheck({ relayerPk: pk, checkedAt: d.now, chainNonce: n, explained, ledgerRelayedSinceLast: since });
    sum.checked++;
    if (!explained) sum.unexplained++;
  }
  return sum;
}
