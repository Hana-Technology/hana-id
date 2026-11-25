// Migration 0026 (D915): the shared-scope rules' two columns and three triggers. Applied after 0025 on a database that
// has rows: every scope unmarked and every app created by Journear staff, nothing else moved; the flag is one way and
// refused while an app of the scope has a policy in force, waiting or proposed (a deleted app aside); who created an
// app never changes; applying again changes nothing.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const accepted = (sql: string, ...binds: unknown[]): Promise<boolean> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => true,
      () => false,
    );
const POLICY = '{"v":1}';

let appsBefore: unknown[] = [];
let scopesBefore: unknown[] = [];

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === '0026_shared_scope_rules.sql');
  expect(at).toBeGreaterThan(0);
  expect(migrations[at - 1]!.name).toBe('0025_partner_labels.sql');
  await applyD1Migrations(db, migrations.slice(0, at));
  const now = Date.now();
  await db
    .prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s1', 'org_a', 'test', NULL, ?1, ?1), ('s2', 'org_a', 'live', ?1, ?1, ?1), ('s3', 'org_b', 'test', NULL, ?1, ?1), ('s4', 'org_b', 'test', NULL, ?1, ?1), ('s5', 'org_b', 'test', NULL, ?1, ?1)")
    .bind(now)
    .run();
  await db
    .prepare(
      `INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES
         ('app_a1', 'A1', 's1', 'org_a', 'pk_test_AaaaaaaaaaaaaaaaaaaA'), ('app_a2', 'A2', 's2', 'org_a', 'pk_live_AaaaaaaaaaaaaaaaaaaB'),
         ('app_b1', 'B1', 's3', 'org_b', 'pk_test_BbbbbbbbbbbbbbbbbbbB'), ('app_b2', 'B2', 's4', 'org_b', 'pk_test_BbbbbbbbbbbbbbbbbbbC'),
         ('app_b3', 'B3', 's5', 'org_b', 'pk_test_BbbbbbbbbbbbbbbbbbbD')`,
    )
    .run();
  // A policy in force on s2's app, one waiting in s3's app's columns, and a proposed one (an open change) on s4's app.
  await db.prepare("UPDATE apps SET auto_approve_policy = ?1 WHERE id = 'app_a2'").bind(POLICY).run();
  await db.prepare("UPDATE apps SET auto_approve_pending = ?1, auto_approve_effective_at = ?2 WHERE id = 'app_b1'").bind(POLICY, now + 60_000).run();
  await db
    .prepare("INSERT INTO guarded_changes (id, app_id, kind, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_1', 'app_b2', 'policy_set', ?1, ?2, 'pending', 'hana', 'staff', ?3, 'r1')")
    .bind(POLICY, 'a'.repeat(64), now)
    .run();
  // s5's only app is deleted with a policy still stored: it serves nothing, so it doesn't hold the flag back.
  await db.prepare("UPDATE apps SET auto_approve_policy = ?1, deleted_at = ?2 WHERE id = 'app_b3'").bind(POLICY, now).run();
  appsBefore = (await db.prepare('SELECT * FROM apps ORDER BY id').all()).results;
  scopesBefore = (await db.prepare('SELECT * FROM scopes ORDER BY scope_id').all()).results;
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0026_shared_scope_rules', () => {
  it('adds the two columns at their defaults and changes no other value of any row', async () => {
    const apps = (await db.prepare('SELECT * FROM apps ORDER BY id').all<Record<string, unknown>>()).results;
    expect(apps.map(({ created_by_kind, ...rest }) => (expect(created_by_kind).toBe('hana'), rest))).toEqual(appsBefore);
    const scopes = (await db.prepare('SELECT * FROM scopes ORDER BY scope_id').all<Record<string, unknown>>()).results;
    expect(scopes.map(({ app_user_ids, ...rest }) => (expect(app_user_ids).toBe(0), rest))).toEqual(scopesBefore);
  });

  it('the columns take only their values; a new app is created by staff unless it says otherwise', async () => {
    expect(await accepted("UPDATE scopes SET app_user_ids = 2 WHERE scope_id = 's1'")).toBe(false);
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_by_kind) VALUES ('app_x', 'X', 's1', 'org_a', 'pk_test_XxxxxxxxxxxxxxxxxxxX', 'member')")).toBe(false);
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_by_kind) VALUES ('app_p', 'P', 's1', 'org_a', 'pk_test_PpppppppppppppppppP', 'platform')")).toBe(true);
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_h', 'H', 's1', 'org_a', 'pk_test_HhhhhhhhhhhhhhhhhhH')")).toBe(true);
    expect((await db.prepare("SELECT id, created_by_kind FROM apps WHERE id IN ('app_p', 'app_h') ORDER BY id").all()).results).toEqual([
      { id: 'app_h', created_by_kind: 'hana' },
      { id: 'app_p', created_by_kind: 'platform' },
    ]);
  });

  it('who created an app never changes', async () => {
    expect(await accepted("UPDATE apps SET created_by_kind = 'platform' WHERE id = 'app_a1'")).toBe(false);
    expect(await accepted("UPDATE apps SET created_by_kind = 'hana' WHERE id = 'app_p'")).toBe(false);
    // Writing the same value (an UPDATE that lists every column) is no change.
    expect(await accepted("UPDATE apps SET created_by_kind = 'hana', name = 'A1' WHERE id = 'app_a1'")).toBe(true);
  });

  it('the flag is refused while an app of the scope has a policy in force, waiting or proposed; a deleted app aside', async () => {
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's2'")).toBe(false);
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's3'")).toBe(false);
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's4'")).toBe(false);
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's5'")).toBe(true);
    // Once the change is closed, the flag goes on.
    await db.prepare("UPDATE guarded_changes SET status = 'cancelled', cancelled_at = 1, cancelled_by = 'staff' WHERE id = 'gc_1'").run();
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's4'")).toBe(true);
    expect((await db.prepare("SELECT scope_id FROM scopes WHERE app_user_ids = 1 ORDER BY scope_id").all()).results).toEqual([{ scope_id: 's4' }, { scope_id: 's5' }]);
  });

  it('the flag is one way', async () => {
    expect(await accepted("UPDATE scopes SET app_user_ids = 1 WHERE scope_id = 's1'")).toBe(true);
    expect(await accepted("UPDATE scopes SET app_user_ids = 0 WHERE scope_id = 's1'")).toBe(false);
    // Another column of a marked scope still changes, and setting it on again is no change.
    expect(await accepted("UPDATE scopes SET assigned_at = 7, app_user_ids = 1 WHERE scope_id = 's1'")).toBe(true);
    expect(await db.prepare("SELECT app_user_ids, assigned_at FROM scopes WHERE scope_id = 's1'").first()).toEqual({ app_user_ids: 1, assigned_at: 7 });
  });

  it('applying the migrations again changes nothing', async () => {
    const before = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const after = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    expect(after.slice(0, before.length)).toEqual(before);
    expect(before).toContain('0026_shared_scope_rules.sql');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND name IN ('scopes_app_user_ids_one_way', 'scopes_app_user_ids_no_policy', 'apps_created_by_kind_fixed')").first()).toEqual({ n: 3 });
  });
});
