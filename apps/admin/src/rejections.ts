// The rejection-rate check, 00:30 UTC for the previous UTC day (docs/batch-c-spec.md "Rejection-rate check"; D91): an
// org with at least REJECTION_MIN_RELAYED relayed attempts and a relayed-then-rejected share above REJECTION_PCT gets
// one `ops.rejection_alerts` row (one per org and day: the primary key), emailed once to the security alias by the
// alert step (alerts.ts) and shown on the security screen. The partner isn't billed for it by default.
import type { LedgerStore } from './ledger.ts';

export const REJECTION_MIN_RELAYED = 100;
/** Provisional (D91): a constant until real traffic sets it. */
export const REJECTION_PCT = 5;

/** Over the threshold: rejected / relayed > 5 %, in integers. */
export const overThreshold = (relayed: number, rejected: number): boolean => relayed >= REJECTION_MIN_RELAYED && rejected * 100 > relayed * REJECTION_PCT;

export async function runRejectionCheck(d: { store: LedgerStore; now: number }): Promise<{ day: string; orgs: number; alerts: number }> {
  const day = new Date(d.now - 86_400_000).toISOString().slice(0, 10);
  const rows = await d.store.rejectionRates(day);
  let alerts = 0;
  for (const r of rows) if (overThreshold(r.relayed, r.rejected) && (await d.store.addRejectionAlert({ orgId: r.orgId, day, relayed: r.relayed, rejected: r.rejected }))) alerts++;
  return { day, orgs: rows.length, alerts };
}
