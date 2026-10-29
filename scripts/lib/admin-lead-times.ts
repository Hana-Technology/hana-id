// admin.ts issuer-keys:lead-times: Google's signing-key lead time from D1 `issuer_key_observations` (migration 0004,
// written by the API's cron and token verification: apps/api/src/key-observations.ts). Sets D33's issuer-key delay
// (docs/operations.md "Issuer key lead times"). Public data only: kids and timestamps.

export const LEAD_TIMES_SQL =
  'SELECT provider, kid, first_seen_jwks_ms, last_seen_jwks_ms, removed_jwks_ms, first_token_ms, max_age_s_last ' +
  'FROM issuer_key_observations ORDER BY provider, COALESCE(first_seen_jwks_ms, first_token_ms), kid';

export interface ObservationRow {
  provider: string;
  kid: string;
  first_seen_jwks_ms: number | null;
  last_seen_jwks_ms: number | null;
  removed_jwks_ms: number | null;
  first_token_ms: number | null;
  max_age_s_last: number | null;
}

/** `2026-10-29 12:00Z` (UTC, minutes), or `-`. */
export function formatTime(ms: number | null): string {
  if (ms === null) return '-';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')}Z`;
}

/** `1d 4h 5m`, `-12m`, `0m` (whole minutes, rounded toward zero). */
export function formatSpan(ms: number): string {
  const sign = ms < 0 ? '-' : '';
  let m = Math.floor(Math.abs(ms) / 60_000);
  const d = Math.floor(m / 1440);
  m -= d * 1440;
  const h = Math.floor(m / 60);
  m -= h * 60;
  const parts = [d ? `${d}d` : '', h ? `${h}h` : '', m || (!d && !h) ? `${m}m` : ''].filter(Boolean);
  return sign + parts.join(' ');
}

/** First token − first seen in the JWKS; negative when a token arrived before any fetch listed the kid. */
export function leadTimeMs(r: ObservationRow): number | null {
  return r.first_seen_jwks_ms !== null && r.first_token_ms !== null ? r.first_token_ms - r.first_seen_jwks_ms : null;
}

function lifetime(r: ObservationRow, now: number): string {
  if (r.first_seen_jwks_ms === null) return 'never listed';
  if (r.removed_jwks_ms !== null) return formatSpan(r.removed_jwks_ms - r.first_seen_jwks_ms);
  return `${formatSpan(now - r.first_seen_jwks_ms)}+ (listed)`;
}

/** The report's lines: one row per kid, then the shortest lead time (what the delay must stay under). */
export function leadTimesReport(rows: readonly ObservationRow[], now: number, where: string): string[] {
  if (!rows.length) return [`No issuer key observations in ${where} yet (the API cron records the JWKS every 15 min).`];
  const header = ['provider', 'kid', 'first seen in JWKS', 'first token', 'lead time', 'lifetime in JWKS', 'max-age'];
  const table = rows.map((r) => {
    const lead = leadTimeMs(r);
    return [
      r.provider,
      r.kid,
      formatTime(r.first_seen_jwks_ms),
      r.first_token_ms === null ? 'none yet' : formatTime(r.first_token_ms),
      lead === null ? '-' : formatSpan(lead),
      lifetime(r, now),
      r.max_age_s_last === null ? '-' : `${r.max_age_s_last}s`,
    ];
  });
  const widths = header.map((h, i) => Math.max(h.length, ...table.map((row) => row[i]!.length)));
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => c.padEnd(widths[i]!))
      .join('  ')
      .trimEnd();
  const out = [`Issuer key observations (${where}), times UTC:`, line(header), ...table.map(line)];
  const leads = rows.flatMap((r) => {
    const lead = leadTimeMs(r);
    return lead === null ? [] : [{ kid: r.kid, lead }];
  });
  if (leads.length) {
    const min = leads.reduce((a, b) => (b.lead < a.lead ? b : a));
    out.push(`Shortest lead time: ${formatSpan(min.lead)} (${min.kid}), over ${leads.length} kid(s) with a token.`);
  } else {
    out.push('No lead time yet: no kid has both a JWKS sighting and a token.');
  }
  out.push('First sightings are up to 15 min late (the cron polls every 15 min; token-time fetches add points), so a lead time can read up to 15 min short.');
  return out;
}
