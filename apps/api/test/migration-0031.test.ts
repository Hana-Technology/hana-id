// Migration 0031 (D925 after PR 153's review): one index on `end_user_apps`, so a person's apps are read newest first
// and the read stops at its cap. Applied after 0030 on a database with rows: every row of every table it could touch is
// as it was, every trigger and view of the schema is there after with the same SQL (asked of `sqlite_schema`), the only
// new object is the index, and the linking view's per-person read uses it.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const FILE = '0031_end_user_apps_recent.sql';
type Row = Record<string, unknown>;
const schema = async (): Promise<Map<string, { type: string; sql: string | null }>> => {
  const { results } = await db.prepare("SELECT type, name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> 'd1_migrations' ORDER BY name").all<{ type: string; name: string; sql: string | null }>();
  return new Map(results.map((r) => [r.name, { type: r.type, sql: r.sql }]));
};

let before = new Map<string, { type: string; sql: string | null }>();
let rowsBefore: Row[] = [];

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('s9', 'org_a', 'test', 1, 1, 1, 1)").run();
  await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_x1', 'X1', 's9', 'org_a', 'pk_test_Xxxxxxxxxxxxxxxxxxxxxx1', 'app')").run();
  await db.prepare("INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES ('hu_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'u1_BBBBBBBBBBBBBBBBBBBBBA', 'BBBBBBBB', 's9', 1, 2)").run();
  await db.prepare("INSERT INTO end_user_apps (user_id, app_id, app_sub, support_code, first_seen_at, last_seen_at) VALUES ('hu_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'app_x1', 'u1_CCCCCCCCCCCCCCCCCCCCCA', 'CCCCCCCC', 1, 2)").run();
  before = await schema();
  rowsBefore = (await db.prepare('SELECT * FROM end_user_apps').all<Row>()).results;
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0031_end_user_apps_recent', () => {
  it('adds only the index; every table, trigger, view and index of before is there with the same SQL; no row changes', async () => {
    const after = await schema();
    expect([...after.keys()].filter((k) => !before.has(k))).toEqual(['end_user_apps_user_recent']);
    expect(after.get('end_user_apps_user_recent')).toEqual({ type: 'index', sql: 'CREATE INDEX end_user_apps_user_recent ON end_user_apps (user_id, last_seen_at DESC, app_id)' });
    for (const [name, v] of before) expect(after.get(name), name).toEqual(v);
    expect((await db.prepare('SELECT * FROM end_user_apps').all<Row>()).results).toEqual(rowsBefore);
  });

  it('a person’s apps newest first come down the index (no sort of every row)', async () => {
    const plan = (await db.prepare("EXPLAIN QUERY PLAN SELECT app_id FROM end_user_apps WHERE user_id = 'hu_BBBBBBBBBBBBBBBBBBBBBBBBBB' ORDER BY last_seen_at DESC, app_id LIMIT 101").all<{ detail: string }>()).results.map((r) => r.detail).join('\n');
    expect(plan).toContain('end_user_apps_user_recent');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
