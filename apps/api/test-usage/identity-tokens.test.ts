// migrations-usage 0002: identity tokens per app and day, copied hourly by the API (src/usage/identity-sync.ts)
// through `usage.record_identity_tokens`. On PGlite (D140), as the writer role's Hyperdrive connection runs.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { failure, freshDb, type TestDb } from './db.ts';

let db: TestDb;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const row = (patch: Record<string, unknown> = {}) => ({ app_id: 'app_a', day: '2026-11-02', org_id: 'org_legacy', scope_id: 's1', tokens: 5, ...patch });
const copy = (rows: unknown) => db.asRole('usage_writer', () => db.query<{ n: number }>('SELECT usage.record_identity_tokens($1::jsonb) AS n', [JSON.stringify(rows)])).then((r) => r[0]!.n);
const stored = (appId: string) =>
  db.query<{ day: string; org_id: string; scope_id: string; tokens: string }>("SELECT to_char(day, 'YYYY-MM-DD') AS day, org_id, scope_id, tokens::text AS tokens FROM usage.identity_tokens WHERE app_id = $1 ORDER BY day", [appId]);

describe('usage.record_identity_tokens', () => {
  it('records each app and day, as the writer', async () => {
    expect(await copy([row(), row({ day: '2026-11-01', tokens: 2 })])).toBe(2);
    expect(await stored('app_a')).toEqual([
      { day: '2026-11-01', org_id: 'org_legacy', scope_id: 's1', tokens: '2' },
      { day: '2026-11-02', org_id: 'org_legacy', scope_id: 's1', tokens: '5' },
    ]);
  });

  it('keeps the larger count: a replay or a stale copy never lowers it; the org and scope of the first copy stay', async () => {
    await copy([row({ app_id: 'app_b', tokens: 4 })]);
    await copy([row({ app_id: 'app_b', tokens: 9, org_id: 'org_moved' })]);
    await copy([row({ app_id: 'app_b', tokens: 3 })]);
    expect(await stored('app_b')).toEqual([{ day: '2026-11-02', org_id: 'org_legacy', scope_id: 's1', tokens: '9' }]);
  });

  it('accepts an empty copy', async () => {
    expect(await copy([])).toBe(0);
  });

  const bad: [string, unknown][] = [
    ['not an array', row()],
    ['a non-object row', [1]],
    ['an unknown field', [{ ...row(), uid: 'x' }]],
    ['a missing app', [{ ...row(), app_id: undefined }]],
    ['an empty org', [row({ org_id: '' })]],
    ['a long scope', [row({ scope_id: 'x'.repeat(65) })]],
    ['a malformed day', [row({ day: '2026-11-2' })]],
    ['an impossible day', [row({ day: '2026-02-30' })]],
    ['negative tokens', [row({ tokens: -1 })]],
    ['fractional tokens', [row({ tokens: 1.5 })]],
    ['tokens as a string', [row({ tokens: '5' })]],
    ['an app and day twice', [row(), row()]],
    ['over 1000 rows', Array.from({ length: 1001 }, (_, i) => row({ app_id: `a${i}` }))],
  ];
  for (const [why, rows] of bad) {
    it(`refuses ${why} (22023), writing nothing`, async () => {
      const before = await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.identity_tokens');
      // A valid row first: all or nothing, so it isn't written either.
      const f = await failure(copy(Array.isArray(rows) ? [row({ app_id: 'app_valid_first' }), ...rows] : rows));
      expect(f?.code, why).toBe('22023');
      expect(await db.query<{ n: string }>('SELECT count(*)::text AS n FROM usage.identity_tokens')).toEqual(before);
    });
  }

  it('is the writer’s only path: no direct table access; the admin reads but can’t write or call it', async () => {
    for (const sql of ['SELECT 1 FROM usage.identity_tokens', "INSERT INTO usage.identity_tokens (app_id, day, org_id, scope_id, tokens) VALUES ('x', '2026-11-02', 'o', 's', 1)", 'UPDATE usage.identity_tokens SET tokens = 0', 'DELETE FROM usage.identity_tokens']) {
      expect((await failure(db.asRole('usage_writer', () => db.query(sql))))?.code, sql).toBe('42501');
    }
    expect((await db.asRole('usage_admin', () => db.query('SELECT count(*) FROM usage.identity_tokens'))).length).toBe(1);
    for (const sql of ['UPDATE usage.identity_tokens SET tokens = 0', 'DELETE FROM usage.identity_tokens', "SELECT usage.record_identity_tokens('[]'::jsonb)"]) {
      expect((await failure(db.asRole('usage_admin', () => db.query(sql))))?.code, sql).toBe('42501');
    }
  });
});
