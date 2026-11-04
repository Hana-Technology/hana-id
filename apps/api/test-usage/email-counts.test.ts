// migrations-usage 0004: email logins and new links per app and day, copied hourly by the API (src/usage/email-sync.ts)
// through `usage.record_email_counts`. On PGlite (D140), as the writer role's Hyperdrive connection runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const row = (patch: Record<string, unknown> = {}) => ({ app_id: 'app_a', day: '2026-11-02', org_id: 'org_legacy', scope_id: 's1', email_sessions: 5, links: 1, ...patch });
const copy = (rows: unknown) => db.asRole('usage_writer', () => db.query<{ n: number }>('SELECT usage.record_email_counts($1::jsonb) AS n', [JSON.stringify(rows)])).then((r) => r[0]!.n);
const stored = (appId: string) =>
  db.query<{ day: string; org_id: string; email_sessions: string; links: string }>(
    "SELECT to_char(day, 'YYYY-MM-DD') AS day, org_id, email_sessions::text AS email_sessions, links::text AS links FROM usage.email_counts WHERE app_id = $1 ORDER BY day",
    [appId],
  );

describe('usage.record_email_counts', () => {
  it('records each app and day, as the writer', async () => {
    expect(await copy([row(), row({ day: '2026-11-01', email_sessions: 2, links: 0 })])).toBe(2);
    expect(await stored('app_a')).toEqual([
      { day: '2026-11-01', org_id: 'org_legacy', email_sessions: '2', links: '0' },
      { day: '2026-11-02', org_id: 'org_legacy', email_sessions: '5', links: '1' },
    ]);
  });

  it('keeps the larger count of each column: a replay or a stale copy never lowers one; the first org stays', async () => {
    await copy([row({ app_id: 'app_b', email_sessions: 4, links: 3 })]);
    await copy([row({ app_id: 'app_b', email_sessions: 9, links: 1, org_id: 'org_moved' })]);
    await copy([row({ app_id: 'app_b', email_sessions: 3, links: 2 })]);
    expect(await stored('app_b')).toEqual([{ day: '2026-11-02', org_id: 'org_legacy', email_sessions: '9', links: '3' }]);
  });

  const bad: [string, unknown][] = [
    ['not an array', row()],
    ['an unknown field', [{ ...row(), uid: 'x' }]],
    ['a missing links count', [{ ...row(), links: undefined }]],
    ['an empty org', [row({ org_id: '' })]],
    ['an impossible day', [row({ day: '2026-02-30' })]],
    ['negative sessions', [row({ email_sessions: -1 })]],
    ['fractional links', [row({ links: 1.5 })]],
    ['links as a string', [row({ links: '5' })]],
    ['an app and day twice', [row(), row()]],
    ['over 1000 rows', Array.from({ length: 1001 }, (_, i) => row({ app_id: `a${i}` }))],
  ];
  for (const [why, rows] of bad) {
    it(`refuses ${why} (22023), writing nothing`, async () => {
      const before = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.email_counts');
      const f = await failure(copy(Array.isArray(rows) ? [row({ app_id: 'app_valid_first' }), ...rows] : rows));
      expect(f?.code, why).toBe('22023');
      expect(await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.email_counts')).toEqual(before);
    });
  }

  it('is the writer’s only path: no direct table access; the admin reads but can’t write or call it', async () => {
    for (const sql of ['SELECT 1 FROM usage.email_counts', "INSERT INTO usage.email_counts (app_id, day, org_id, scope_id, email_sessions, links) VALUES ('x', '2026-11-02', 'o', 's', 1, 0)", 'DELETE FROM usage.email_counts']) {
      expect((await failure(db.asRole('usage_writer', () => db.query(sql))))?.code, sql).toBe('42501');
    }
    expect((await db.asRole('usage_admin', () => db.query('SELECT count(*) FROM usage.email_counts'))).length).toBe(1);
    for (const sql of ['DELETE FROM usage.email_counts', "SELECT usage.record_email_counts('[]'::jsonb)"]) {
      expect((await failure(db.asRole('usage_admin', () => db.query(sql))))?.code, sql).toBe('42501');
    }
  });
});
