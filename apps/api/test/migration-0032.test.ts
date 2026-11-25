// Migration 0032 (D927, piece P3 of docs/partner-platform-spec.md, A7 `platform_calls`, L7): the platform API's call
// log, additive. Applied to a database holding rows in the tables around it (every migration before it): every row and
// every schema object of before is there after with the same SQL (asked of `sqlite_schema`); only the table, its two
// indexes and its three triggers are new, and none of them reads another table; each rule refuses a bare D1 write that
// breaks it (an update, an early delete, a replace, a value out of its CHECK); a row 13 months old may go, and the API's
// purge takes exactly those.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';
import { purgePlatformCalls } from '../src/changes/retention.ts';
import { HotDb } from '../src/changes/db.ts';

const db = env.FRESH_DB;
const FILE = '0032_platform_calls.sql';
const NEW = ['platform_calls', 'platform_calls_org', 'platform_calls_at', 'platform_calls_no_replace', 'platform_calls_no_update', 'platform_calls_no_early_delete'];
type Obj = { type: string; name: string; tbl_name: string; sql: string | null };
const schema = async (): Promise<Map<string, Obj>> =>
  new Map((await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<Obj>()).results.map((r) => [r.name, r]));
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
const KEPT = ['scopes', 'apps', 'app_changes', 'guarded_changes', 'platform_keys', 'platform_orgs', 'security_events'];
const rowsOf = async (t: string) => (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
const DAY = 86_400_000;
const insert = (o: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = { at: Date.now(), org_id: 'org_a', key_id: 'pkc_4Rm8Vq2Lz7Wx9Kd', method: 'GET', route: '/v1/platform/credential', app_id: null, status: 200, code: null, request_id: 'ray-1', ip_prefix: '203.0.113.0/24', ...o };
  const cols = Object.keys(row);
  return refusal(`INSERT INTO platform_calls (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => row[c]));
};

let before: Map<string, Obj>;
let beforeRows: Record<string, unknown[]>;

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('st', 'org_a', 'test', 1, 1, 1)").run();
  await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_t', 'T', 'st', 'org_a', 'pk_test_Ttttttttttttttttttttttt')").run();
  await db.prepare("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app_t', 'app.created', '{}', 'hana', 's', 'r1')").run();
  await db.prepare("INSERT INTO platform_orgs (org_id, enabled, frozen, set_by, set_at) VALUES ('org_a', 0, 0, 't', 1)").run();
  before = await schema();
  beforeRows = Object.fromEntries(await Promise.all(KEPT.map(async (t) => [t, await rowsOf(t)])));
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0032', () => {
  it('keeps every row and every schema object of before, and adds only its own', async () => {
    const after = await schema();
    for (const [name, obj] of before) expect(after.get(name), name).toEqual(obj);
    expect([...after.keys()].filter((n) => !before.has(n)).sort()).toEqual([...NEW].sort());
    for (const t of KEPT) expect(await rowsOf(t), t).toEqual(beforeRows[t]);
    // None of its triggers reads another table (so no reader elsewhere depends on it, nor it on them).
    for (const n of NEW.filter((x) => after.get(x)!.type === 'trigger')) {
      const sql = after.get(n)!.sql!;
      for (const t of KEPT) expect(new RegExp(`\\b${t}\\b`, 'u').test(sql), `${n} reads ${t}`).toBe(false);
    }
  });

  it('takes a well-formed row and refuses one out of its CHECKs', async () => {
    expect(await insert()).toBe('accepted');
    expect(await insert({ status: 401, code: 'unauthenticated', method: 'POST', route: '/v1/platform/credential/revoke', app_id: 'app_t', ip_prefix: null })).toBe('accepted');
    for (const [col, v] of [['org_id', 'acme'], ['key_id', 'key_x'], ['method', 'PUT'], ['route', '/v1/apps'], ['route', `/v1/platform/${'x'.repeat(130)}`], ['app_id', 'x'], ['status', 199], ['status', 600], ['code', 'Bad Code'], ['request_id', ''], ['ip_prefix', 'x'.repeat(65)]] as const) {
      expect(await insert({ [col]: v }), `${col}=${String(v)}`).toMatch(/CHECK constraint failed/u);
    }
  });

  it('is append-only: no update, no replace, no delete before 13 months', async () => {
    const { seq } = (await db.prepare('SELECT MIN(seq) AS seq FROM platform_calls').first<{ seq: number }>())!;
    expect(await refusal('UPDATE platform_calls SET status = 500 WHERE seq = ?1', seq)).toMatch(/append-only/u);
    expect(await refusal("INSERT OR REPLACE INTO platform_calls (seq, at, org_id, key_id, method, route, status, request_id) VALUES (?1, 1, 'org_a', 'pkc_4Rm8Vq2Lz7Wx9Kd', 'GET', '/v1/platform/x', 200, 'r')", seq)).toMatch(/append-only/u);
    expect(await refusal('DELETE FROM platform_calls WHERE seq = ?1', seq)).toMatch(/kept 13 months/u);
  });

  it('no row can sit at seq ≤ 0 and block every automatic insert (after PR 156\'s review, F6)', async () => {
    // In a BEFORE INSERT trigger an automatic rowid reads as -1: a stored -1 would make every later insert a "replace".
    for (const seq of [-1, 0]) expect(await refusal("INSERT INTO platform_calls (seq, at, org_id, key_id, method, route, status, request_id) VALUES (?1, 1, 'org_a', 'pkc_4Rm8Vq2Lz7Wx9Kd', 'GET', '/v1/platform/x', 200, 'r')", seq), String(seq)).toMatch(/CHECK constraint failed/u);
    expect(await insert({ request_id: 'automatic-1' })).toBe('accepted');
    expect(await insert({ request_id: 'automatic-2' })).toBe('accepted');
    const { seq } = (await db.prepare("SELECT seq FROM platform_calls WHERE request_id = 'automatic-2'").first<{ seq: number }>())!;
    expect(seq).toBeGreaterThan(0);
  });

  it('0027\'s app_changes_no_replace has the pattern F6 fixed here (an open point of D927, for a later migration): a bare row at seq -1 blocks the ledger', async () => {
    const ledgerInsert = (rid: string) => refusal("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app.created', '{}', 'hana', 's', ?1)", rid);
    expect(await ledgerInsert('ok-before')).toBe('accepted');
    expect(await refusal("INSERT INTO app_changes (seq, at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (-1, 0, 'org_a', 'app.created', '{}', 'hana', 's', 'bad-minus-one')")).toBe('accepted');
    expect(await ledgerInsert('blocked')).toMatch(/already recorded/u);
    // Only a bare D1 write can do it (nothing in the code names a seq); deleting the row (its `at` 0 is past 60 months) restores it.
    expect(await refusal('DELETE FROM app_changes WHERE seq = -1')).toBe('accepted');
    expect(await ledgerInsert('ok-after')).toBe('accepted');
  });

  it('a row past 13 months may go, and the purge takes exactly those, oldest first, up to its limit', async () => {
    const old = Date.now() - 400 * DAY;
    for (let i = 0; i < 3; i++) expect(await insert({ at: old + i, request_id: `old-${i}` })).toBe('accepted');
    expect(await insert({ at: Date.now() - 380 * DAY, request_id: 'recent' })).toBe('accepted'); // 12.5 months: kept
    const purge = (limit: number) => purgePlatformCalls(new HotDb(db), { before: Date.now(), limit });
    expect(await purge(2)).toEqual({ platformCalls: 2 });
    expect(await purge(10)).toEqual({ platformCalls: 1 });
    expect(await purge(10)).toEqual({ platformCalls: 0 });
    expect((await db.prepare("SELECT request_id FROM platform_calls WHERE request_id LIKE 'old-%' OR request_id = 'recent'").all<{ request_id: string }>()).results).toEqual([{ request_id: 'recent' }]);
    // `before` can only narrow it: never a younger row.
    expect(await purgePlatformCalls(new HotDb(db), { before: Date.now() + 1000 * DAY, limit: 10 })).toEqual({ platformCalls: 0 });
  });

  it('an env without the migration purges nothing and fails nothing', async () => {
    expect(await purgePlatformCalls(new HotDb(env.PRE_0018_DB), { before: Date.now(), limit: 10 })).toEqual({ platformCalls: 0 });
  });
});
