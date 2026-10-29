// admin.ts issuer-keys:lead-times: the query against apps/api's real migrations (node:sqlite), and the report.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { repoRoot } from '@hana-id/env';
import { describe, expect, it } from 'vitest';
import { assertCommandPositionals } from '../lib/admin-args.ts';
import { LEAD_TIMES_SQL, type ObservationRow, formatSpan, formatTime, leadTimeMs, leadTimesReport } from '../lib/admin-lead-times.ts';

const T = Date.UTC(2026, 9, 29, 12, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

function newDb(): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  const dir = join(repoRoot, 'apps', 'api', 'migrations');
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) db.exec(readFileSync(join(dir, f), 'utf8'));
  return db;
}

const row = (kid: string, r: Partial<ObservationRow> = {}): ObservationRow => ({
  provider: 'google',
  kid,
  first_seen_jwks_ms: null,
  last_seen_jwks_ms: null,
  removed_jwks_ms: null,
  first_token_ms: null,
  max_age_s_last: null,
  ...r,
});

describe('issuer-keys:lead-times', () => {
  it('reads every column of issuer_key_observations (migration 0004), oldest sighting first', () => {
    const db = newDb();
    const insert = db.prepare(
      'INSERT INTO issuer_key_observations (provider, kid, first_seen_jwks_ms, last_seen_jwks_ms, removed_jwks_ms, first_token_ms, max_age_s_last) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    insert.run('google', 'new', T + DAY, T + 2 * DAY, null, null, 20000);
    insert.run('google', 'old', T, T + 5 * DAY, T + 5 * DAY + 15 * MIN, T + 2 * DAY, 21000);
    insert.run('google', 'tokenOnly', null, null, null, T + DAY / 2, null);
    const rows = db.prepare(LEAD_TIMES_SQL).all() as unknown as ObservationRow[];
    expect(rows.map((r) => r.kid)).toEqual(['old', 'tokenOnly', 'new']);
    expect({ ...rows[0] }).toEqual(row('old', { first_seen_jwks_ms: T, last_seen_jwks_ms: T + 5 * DAY, removed_jwks_ms: T + 5 * DAY + 15 * MIN, first_token_ms: T + 2 * DAY, max_age_s_last: 21000 }));
  });

  it('formats times and spans', () => {
    expect(formatTime(T)).toBe('2026-10-29 12:00Z');
    expect(formatTime(null)).toBe('-');
    expect(formatSpan(0)).toBe('0m');
    expect(formatSpan(59_999)).toBe('0m');
    expect(formatSpan(2 * DAY + 3 * HOUR + 4 * MIN)).toBe('2d 3h 4m');
    expect(formatSpan(DAY)).toBe('1d');
    expect(formatSpan(-12 * MIN)).toBe('-12m');
    expect(leadTimeMs(row('a', { first_seen_jwks_ms: T, first_token_ms: T - 5 * MIN }))).toBe(-5 * MIN);
    expect(leadTimeMs(row('a', { first_seen_jwks_ms: T }))).toBeNull();
  });

  it('prints per kid: first seen, first token, lead time, lifetime in the JWKS, max-age; then the shortest lead time', () => {
    const now = T + 6 * DAY;
    const lines = leadTimesReport(
      [
        row('old', { first_seen_jwks_ms: T, last_seen_jwks_ms: T + 5 * DAY, removed_jwks_ms: T + 5 * DAY + 15 * MIN, first_token_ms: T + 2 * DAY + 30 * MIN, max_age_s_last: 21000 }),
        row('mid', { first_seen_jwks_ms: T + DAY, last_seen_jwks_ms: now, first_token_ms: T + 2 * DAY, max_age_s_last: 20000 }),
        row('new', { first_seen_jwks_ms: T + 5 * DAY, last_seen_jwks_ms: now }),
        row('early', { first_token_ms: T }),
      ],
      now,
      'remote D1 hana-id-test',
    );
    expect(lines).toEqual([
      'Issuer key observations (remote D1 hana-id-test), times UTC:',
      'provider  kid    first seen in JWKS  first token        lead time  lifetime in JWKS  max-age',
      'google    old    2026-10-29 12:00Z   2026-10-31 12:30Z  2d 30m     5d 15m            21000s',
      'google    mid    2026-10-30 12:00Z   2026-10-31 12:00Z  1d         5d+ (listed)      20000s',
      'google    new    2026-11-03 12:00Z   none yet           -          1d+ (listed)      -',
      'google    early  -                   2026-10-29 12:00Z  -          never listed      -',
      'Shortest lead time: 1d (mid), over 2 kid(s) with a token.',
      'First sightings are up to 15 min late (the cron polls every 15 min; token-time fetches add points), so a lead time can read up to 15 min short.',
    ]);
  });

  it('says so when there is nothing yet', () => {
    expect(leadTimesReport([], T, 'local D1 x')).toEqual(['No issuer key observations in local D1 x yet (the API cron records the JWKS every 15 min).']);
    expect(leadTimesReport([row('a', { first_seen_jwks_ms: T })], T + MIN, 'local D1 x')).toContain('No lead time yet: no kid has both a JWKS sighting and a token.');
  });

  it('takes no positional argument', () => {
    expect(() => assertCommandPositionals('issuer-keys:lead-times', [])).not.toThrow();
    expect(() => assertCommandPositionals('issuer-keys:lead-times', ['x'])).toThrow('Unexpected argument x');
  });
});
