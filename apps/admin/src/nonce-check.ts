// The daily nonce cross-check, from 00:30 UTC (docs/batch-c-spec.md "Daily nonce cross-check"; D34, D93 Q13; D323). For each
// relayer key (`AdminRpc.relayerKeys`: the session, owner and Home pools) the access key's nonce N at final is the nonce of the key's last
// landed transaction, and every API relay writes a ledger row with (relayer_pk, relayer_nonce), so:
//
// - N unchanged since the key's last check: idle, explained;
// - a relayed row with relayer_nonce = N: explained;
// - a key's first check when the ledger has never seen it: the baseline, explained (its earlier use predates the ledger);
// - a nonce on a whole multiple of 10^6 with no relayed row: the key was re-added on chain, and NEAR starts a new key at
//   (block height - 1) x 10^6 (AddKey, ACCESS_KEY_NONCE_RANGE_MULTIPLIER): a new baseline, explained and counted as
//   `rebaselined` in the run's summary; it is not a relay by anyone. Only such a nonce is passed, so anything else stays
//   unexplained. A key's holder could deliberately pick such a nonce for one transaction, which is why it is counted
//   and documented (docs/security.md, the check), not silent. A key is re-added on purpose only by `deploy-contract`.
// - otherwise `nonce_unexplained`: a usage write was lost, or something other than the API signed with a relayer key.
//
// Usage capture off (D596): the API says whether it writes usage events (`relayerKeys`' `capture`). While it doesn't,
// no relay has a ledger row, so nothing can be explained and nothing is judged: each key's nonce is recorded as an
// explained baseline with reason `capture_off`, no alert is raised, and the status page says the check isn't measuring.
// The first check after capture is back on is a fresh baseline (`capture_on`): the nonces that moved meanwhile have no
// rows and never will. From the next check on the rules above apply.
//
// A bounded share of each run (D598): at most NONCE_READS_PER_RUN keys are read in one 15-minute run, and the day's
// remaining keys in the runs after it, so an env with many keys in a pool can't take the calls the alerts, statement
// notices, rates and settlement need. `ops.state` holds the day's keys already tried (read or skipped), so each key is
// tried once a day whatever the outcome.
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
  /** Whether the API writes usage events. False: baselines only, no alert. Absent (an older API): judged as before. */
  captureOn?: boolean;
}

export interface NonceSummary {
  checked: number;
  unexplained: number;
  skipped: number;
  /** Keys whose nonce was a new key's (a whole multiple of 10^6, no relayed row): see above. */
  rebaselined: number;
  /** Keys recorded as a baseline because capture is off, or just came back on. */
  baselined: number;
  /** Keys of the day still to try, in a later run. */
  pending: number;
}

/** NEAR starts a new access key's nonce at a multiple of this (see above). */
export const NEW_KEY_NONCE_STEP = 1_000_000n;
/** Keys read in one run at most: one per pool at the default of one check a day each. */
export const NONCE_READS_PER_RUN = 3;
/** `ops.state`: `{day, tried: string[]}`, the check day's keys already tried. */
export const NONCE_CHECK_STATE = 'nonce_check.day';
/** The check day starts at 00:30 UTC. */
export const NONCE_DAY_START_MS = 30 * 60_000;
export const nonceDay = (now: number): string => new Date(now - NONCE_DAY_START_MS).toISOString().slice(0, 10);

async function triedToday(store: LedgerStore, day: string): Promise<string[]> {
  try {
    const raw = (await store.state.getState([NONCE_CHECK_STATE])).get(NONCE_CHECK_STATE)?.value;
    const v = raw ? (JSON.parse(raw) as { day?: unknown; tried?: unknown }) : null;
    return v && v.day === day && Array.isArray(v.tried) ? v.tried.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export async function runNonceCheck(d: NonceDeps): Promise<NonceSummary> {
  const sum: NonceSummary = { checked: 0, unexplained: 0, skipped: 0, rebaselined: 0, baselined: 0, pending: 0 };
  const day = nonceDay(d.now);
  const tried = await triedToday(d.store, day);
  const todo = d.keys.filter((k) => !tried.includes(k));
  const now = todo.slice(0, NONCE_READS_PER_RUN);
  sum.pending = todo.length - now.length;
  const done: string[] = [];
  for (const pk of now) {
    // No call left: the key stays pending for the next run.
    if (!d.budget.take()) {
      sum.skipped++;
      sum.pending++;
      continue;
    }
    done.push(pk);
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
    let reason: 'capture_off' | 'capture_on' | null = null;
    if (d.captureOn === false) {
      explained = true;
      reason = 'capture_off';
      sum.baselined++;
    } else if (prev?.reason === 'capture_off') {
      explained = true;
      reason = 'capture_on';
      sum.baselined++;
    } else if (prev && prev.chainNonce === n) explained = true;
    else if (await d.store.relayedWithNonce(pk, n)) explained = true;
    else if (n % NEW_KEY_NONCE_STEP === 0n) {
      explained = true;
      sum.rebaselined++;
    } else explained = !prev && !(await d.store.hasRelayedRows(pk));
    const since = await d.store.relayedSince(pk, prev?.checkedAt ?? null, d.now);
    await d.store.recordNonceCheck({ relayerPk: pk, checkedAt: d.now, chainNonce: n, explained, ledgerRelayedSinceLast: since, reason });
    sum.checked++;
    if (!explained) sum.unexplained++;
  }
  // If the day's list can't be written the keys are read again next run: three calls at most, never a lost check.
  if (done.length) await d.store.state.setState(NONCE_CHECK_STATE, JSON.stringify({ day, tried: [...tried, ...done] })).catch(() => undefined);
  return sum;
}
