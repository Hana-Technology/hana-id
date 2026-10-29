/**
 * ISO time of a millisecond timestamp, or the bare number when it is outside the Date range: chain values (e.g. a
 * `confirm_from_ms` near u64::MAX) must never make a run throw.
 */
export function iso(ms: number): string {
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? `${ms} ms` : d.toISOString();
}
