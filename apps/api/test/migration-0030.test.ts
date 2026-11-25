// Migration 0030 (D919, piece P6 of docs/partner-platform-spec.md, B3 and B7): `apps.user_ids` with its triggers and
// `end_user_apps`. Applied after 0027 on a database that has rows (apps on an unmarked, a marked and a live scope, the
// wallet directory's users): every app comes back 'scope' with every other value as it was; every trigger and view of
// the schema is there after with the same SQL (asked of `sqlite_schema`, not read from the files); an existing app's
// User ID and Support ID, computed by the API's own code from what it reads, are the values of before; the mode is set
// at creation by the scope's mark and fixed after; the new table takes only rows of a marked scope's apps.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { formatSupportId, supportCodeOf } from '@hana-id/console-core';
import { identitySub, subForApp } from '@hana-id/core/identity';
import { supportIdFromSub } from '@hana-id/core/support-id';
import { beforeAll, describe, expect, it } from 'vitest';
import { getAppByKey } from '../src/apps.ts';
import { sessionSupportId } from '../src/directory/store.ts';
import { identitySubKey } from '../src/identity/signer.ts';

const db = env.MIGRATION_DB;
const FILE = '0030_app_user_ids.sql';
const NEW_TRIGGERS = ['apps_app_ids_scope_fixed', 'apps_user_ids_fixed', 'apps_user_ids_insert', 'apps_user_ids_no_delete', 'end_user_apps_insert'];
const SUB_KEY = identitySubKey(env) as Uint8Array;
const ROOT = { provider: 'google', sub: '110248495921238986420' };
const KEYS = { a1: 'pk_test_Aaaaaaaaaaaaaaaaaaaaaa1', m1: 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm1', l1: 'pk_live_Llllllllllllllllllllll1' };

const accepted = (sql: string, ...binds: unknown[]): Promise<boolean> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => true,
      () => false,
    );
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
type Row = Record<string, unknown>;
const everyTriggerAndView = async (): Promise<Map<string, { type: string; tbl: string; sql: string | null }>> => {
  const { results } = await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('trigger', 'view') ORDER BY name").all<{ type: string; name: string; tbl_name: string; sql: string | null }>();
  return new Map(results.map((r) => [r.name, { type: r.type, tbl: r.tbl_name, sql: r.sql }]));
};
const columnsOf = async (t: string): Promise<Row[]> => (await db.prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}') ORDER BY cid`).all<Row>()).results;

let appsBefore: Row[] = [];
let appColumnsBefore: Row[] = [];
let scopesBefore: Row[] = [];
let usersBefore: Row[] = [];
let schemaBefore = new Map<string, { type: string; tbl: string; sql: string | null }>();
/** What the API of before gave the person on each existing app: today's sub, and its Support ID. */
const before: Record<string, { sub: string; supportId: string }> = {};

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  const now = Date.now();
  // s1 unmarked, s2 marked before any app of it existed, s3 live.
  await db
    .prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('s1', 'org_a', 'test', ?1, ?1, ?1, 0), ('s2', 'org_a', 'test', ?1, ?1, ?1, 1), ('s3', 'org_a', 'live', ?1, ?1, ?1, 0)")
    .bind(now)
    .run();
  await db
    .prepare(
      `INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES
         ('app_a1', 'A1', 's1', 'org_a', ?1), ('app_m1', 'M1', 's2', 'org_a', ?2), ('app_l1', 'L1', 's3', 'org_a', ?3)`,
    )
    .bind(KEYS.a1, KEYS.m1, KEYS.l1)
    .run();
  for (const [id, key] of [['app_a1', KEYS.a1], ['app_m1', KEYS.m1], ['app_l1', KEYS.l1]] as const) {
    await db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', 1)").bind(`key_${id}`, id, key).run();
  }
  // The person's directory row in s2, as the API of before wrote it.
  const s2Sub = identitySub(SUB_KEY, 's2', ROOT);
  await db
    .prepare("INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES ('hu_AAAAAAAAAAAAAAAAAAAAAAAAAA', ?1, ?2, 's2', 1, 2)")
    .bind(s2Sub, supportCodeOf(s2Sub))
    .run();
  for (const [app, scope] of [['app_a1', 's1'], ['app_m1', 's2'], ['app_l1', 's3']] as const) {
    const sub = identitySub(SUB_KEY, scope, ROOT);
    before[app] = { sub, supportId: formatSupportId(supportCodeOf(sub)) };
  }
  appsBefore = (await db.prepare('SELECT * FROM apps ORDER BY id').all<Row>()).results;
  appColumnsBefore = await columnsOf('apps');
  scopesBefore = (await db.prepare('SELECT * FROM scopes ORDER BY scope_id').all<Row>()).results;
  usersBefore = (await db.prepare('SELECT * FROM end_users ORDER BY user_id').all<Row>()).results;
  schemaBefore = await everyTriggerAndView();
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0030_app_user_ids', () => {
  it("adds user_ids = 'scope' to every app, a marked scope's included, and changes no other value of any row", async () => {
    const apps = (await db.prepare('SELECT * FROM apps ORDER BY id').all<Row>()).results;
    expect(apps.map(({ user_ids, ...rest }) => (expect(user_ids).toBe('scope'), rest))).toEqual(appsBefore);
    expect((await columnsOf('apps')).slice(0, -1)).toEqual(appColumnsBefore);
    expect((await columnsOf('apps')).at(-1)).toMatchObject({ name: 'user_ids', type: 'TEXT', notnull: 1, dflt_value: "'scope'", pk: 0 });
    expect((await db.prepare('SELECT * FROM scopes ORDER BY scope_id').all<Row>()).results).toEqual(scopesBefore);
    expect((await db.prepare('SELECT * FROM end_users ORDER BY user_id').all<Row>()).results).toEqual(usersBefore);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM end_user_apps').first()).toEqual({ n: 0 });
  });

  it('every trigger and view of the schema is there after with the same SQL; only its own five triggers are new', async () => {
    const after = await everyTriggerAndView();
    expect([...after.keys()].filter((k) => !schemaBefore.has(k)).sort()).toEqual(NEW_TRIGGERS);
    expect([...schemaBefore.keys()].filter((k) => !after.has(k))).toEqual([]);
    for (const [name, b] of schemaBefore) expect(after.get(name), name).toEqual(b);
    // The readers of `apps` and `scopes` other triggers hold (0006's, 0026's) are among them, untouched.
    for (const name of ['apps_scope_insert', 'apps_scope_update', 'scopes_org_update', 'scopes_app_user_ids_no_policy', 'apps_created_by_kind_fixed']) expect(after.has(name), name).toBe(true);
  });

  it("an existing app's User ID and Support ID are what they were, through the API's own reads and code", async () => {
    for (const [app, key] of [['app_a1', KEYS.a1], ['app_m1', KEYS.m1], ['app_l1', KEYS.l1]] as const) {
      const row = (await getAppByKey(db, key))!;
      expect(row.user_ids, app).toBe('scope');
      const sub = subForApp(SUB_KEY, { scopeId: row.scope_id, appId: row.id, userIds: row.user_ids }, ROOT);
      expect(sub, app).toBe(before[app]!.sub);
      expect(supportIdFromSub(sub), app).toBe(before[app]!.supportId);
      expect(await sessionSupportId(env, row, ROOT), app).toBe(before[app]!.supportId);
    }
    // The marked scope's existing app keeps the directory's own User ID and Support ID.
    const u = (await db.prepare("SELECT token_sub, support_code FROM end_users WHERE scope_id = 's2'").first<{ token_sub: string; support_code: string }>())!;
    expect(u.token_sub).toBe(before.app_m1!.sub);
    expect(formatSupportId(u.support_code)).toBe(before.app_m1!.supportId);
  });

  it("the mode takes only 'scope' or 'app'", async () => {
    for (const v of ['APP', 'Scope', 'pairwise', '']) {
      expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_bad', 'Bad', 's1', 'org_a', 'pk_test_Badddddddddddddddddddd1', ?1)", v), v).toBe(false);
    }
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_bad', 'Bad', 's1', 'org_a', 'pk_test_Badddddddddddddddddddd1', NULL)")).toBe(false);
  });

  it("at creation it follows the scope's mark: INSERT … SELECT gives 'app' on a marked scope and 'scope' on another", async () => {
    const create = (id: string, scope: string, key: string) =>
      db
        .prepare(
          `INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids)
           SELECT ?1, ?1, ?2, 'org_a', ?3, CASE s.app_user_ids WHEN 1 THEN 'app' WHEN 0 THEN 'scope' END FROM scopes s WHERE s.scope_id = ?2`,
        )
        .bind(id, scope, key)
        .run();
    await create('app_m2', 's2', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm2');
    await create('app_a2', 's1', 'pk_test_Aaaaaaaaaaaaaaaaaaaaaa2');
    await create('app_l2', 's3', 'pk_live_Llllllllllllllllllllll2');
    expect((await db.prepare("SELECT id, user_ids FROM apps WHERE id IN ('app_m2', 'app_a2', 'app_l2') ORDER BY id").all()).results).toEqual([
      { id: 'app_a2', user_ids: 'scope' },
      { id: 'app_l2', user_ids: 'scope' },
      { id: 'app_m2', user_ids: 'app' },
    ]);
  });

  it('an insert whose mode contradicts the mark is refused, the default on a marked scope included (fail closed)', async () => {
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_m3', 'M3', 's2', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm3')")).toMatch(/user_ids must follow the scope's mark/u);
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m3', 'M3', 's2', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm3', 'scope')")).toMatch(/user_ids must follow/u);
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_a3', 'A3', 's1', 'org_a', 'pk_test_Aaaaaaaaaaaaaaaaaaaaaa3', 'app')")).toMatch(/user_ids must follow/u);
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_l3', 'L3', 's3', 'org_a', 'pk_live_Llllllllllllllllllllll3', 'app')")).toMatch(/user_ids must follow/u);
    // No scope row: refused (0006's trigger refuses it too; this one matches nothing).
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_x3', 'X3', 's_none', 'org_a', 'pk_test_Xxxxxxxxxxxxxxxxxxxxxx3')")).toBe(false);
    expect(await accepted("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_x3', 'X3', 's_none', 'org_a', 'pk_test_Xxxxxxxxxxxxxxxxxxxxxx3', 'app')")).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM apps WHERE id IN ('app_m3', 'app_a3', 'app_l3', 'app_x3')").first()).toEqual({ n: 0 });
  });

  it('the mode is fixed once written, in both directions; the same value and other columns still update', async () => {
    expect(await refusal("UPDATE apps SET user_ids = 'app' WHERE id = 'app_m1'")).toMatch(/user_ids is fixed/u);
    expect(await refusal("UPDATE apps SET user_ids = 'scope' WHERE id = 'app_m2'")).toMatch(/user_ids is fixed/u);
    expect(await refusal("UPDATE apps SET user_ids = 'app' WHERE id = 'app_a1'")).toMatch(/user_ids is fixed/u);
    expect(await accepted("UPDATE apps SET user_ids = 'app' WHERE id = 'app_m2'")).toBe(true);
    expect(await accepted("UPDATE apps SET name = 'M2 renamed', user_ids = user_ids WHERE id = 'app_m2'")).toBe(true);
    // Neither a replacing insert nor an upsert can carry another mode for an existing id.
    expect(await refusal("INSERT OR REPLACE INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m2', 'M2', 's2', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm2', 'scope')")).toMatch(/user_ids/u);
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m2', 'M2', 's2', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm2', 'app') ON CONFLICT (id) DO UPDATE SET user_ids = 'scope'")).toMatch(/user_ids is fixed/u);
    // The marked scope's app of before keeps 'scope': a replacing insert with 'app' would change its users' IDs.
    expect(await refusal("INSERT OR REPLACE INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m1', 'M1', 's2', 'org_a', ?1, 'app')", KEYS.m1)).toMatch(/user_ids is fixed/u);
    expect((await db.prepare("SELECT id, user_ids FROM apps WHERE id IN ('app_m1', 'app_m2') ORDER BY id").all()).results).toEqual([
      { id: 'app_m1', user_ids: 'scope' },
      { id: 'app_m2', user_ids: 'app' },
    ]);
  });

  it("an 'app' app keeps its scope; a 'scope' app's move is left to the older rules", async () => {
    await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s4', 'org_a', 'test', NULL, 1, 1)").run();
    expect(await refusal("UPDATE apps SET scope_id = 's4' WHERE id = 'app_m2'")).toMatch(/keeps its scope/u);
    expect(await accepted("UPDATE apps SET scope_id = 's2' WHERE id = 'app_m2'")).toBe(true);
    expect(await accepted("UPDATE apps SET scope_id = 's4' WHERE id = 'app_a2'")).toBe(true);
    expect(await accepted("UPDATE apps SET scope_id = 's1' WHERE id = 'app_a2'")).toBe(true);
  });

  it("after PR 148's review: a replacing insert can't move an 'app' app to another marked scope, even with the same mode", async () => {
    await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('s5', 'org_a', 'test', NULL, 1, 1, 1)").run();
    expect(await refusal("INSERT OR REPLACE INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m2', 'M2', 's5', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm2', 'app')")).toMatch(/keeps its scope/u);
    expect(await refusal("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, user_ids) VALUES ('app_m2', 'M2', 's5', 'org_a', 'pk_test_Mmmmmmmmmmmmmmmmmmmmmm9', 'app') ON CONFLICT (id) DO UPDATE SET name = excluded.name")).toMatch(/keeps its scope/u);
    // The same scope and mode still replaces (nothing moves; only the triggers' rules are checked).
    expect((await db.prepare("SELECT scope_id, user_ids FROM apps WHERE id = 'app_m2'").first())).toEqual({ scope_id: 's2', user_ids: 'app' });
  });

  it("after PR 148's review: an 'app' app, or any app on a marked scope, is never deleted (so never deleted and inserted again)", async () => {
    expect(await refusal("DELETE FROM apps WHERE id = 'app_m2'")).toMatch(/never deleted/u);
    // An app of before on a marked scope: deleting and re-inserting it would give it the mode 'app'.
    expect(await refusal("DELETE FROM apps WHERE id = 'app_m1'")).toMatch(/never deleted/u);
    expect(await refusal("DELETE FROM apps WHERE scope_id = 's2'")).toMatch(/never deleted/u);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM apps WHERE scope_id = 's2'").first()).toEqual({ n: 2 });
    // A 'scope' app on an unmarked scope can still be hard-deleted, as before (no code does; tests do).
    await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_tmp', 'Tmp', 's1', 'org_a', 'pk_test_Tmpppppppppppppppppppp1')").run();
    expect(await accepted("DELETE FROM apps WHERE id = 'app_tmp'")).toBe(true);
    // A soft delete is an update: allowed for every app.
    expect(await accepted("UPDATE apps SET deleted_at = 5 WHERE id = 'app_m2'")).toBe(true);
    expect(await accepted("UPDATE apps SET deleted_at = NULL WHERE id = 'app_m2'")).toBe(true);
  });

  describe('end_user_apps', () => {
    const SUB = 'u1_AAAAAAAAAAAAAAAAAAAAAA';
    const insert = (app: string, sub = SUB, code = 'ABCD1234', user = 'hu_AAAAAAAAAAAAAAAAAAAAAAAAAA') =>
      accepted('INSERT INTO end_user_apps (user_id, app_id, app_sub, support_code, first_seen_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, 1, 2)', user, app, sub, code);

    it("takes a row for an app of the person's own marked scope, whichever its mode", async () => {
      expect(await insert('app_m2')).toBe(true);
      expect(await insert('app_m1', 'u1_BBBBBBBBBBBBBBBBBBBBBA', 'ZZZZ0000')).toBe(true);
      expect(await insert('app_m2')).toBe(false); // the key: one row per person and app
    });

    it("refuses an app of another scope, an unmarked scope's app, an unknown app or person", async () => {
      await db.prepare("INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES ('hu_BBBBBBBBBBBBBBBBBBBBBBBBBB', 'u1_CCCCCCCCCCCCCCCCCCCCCA', 'CCCCCCCC', 's1', 1, 2)").run();
      expect(await insert('app_a1', SUB, 'ABCD1234', 'hu_BBBBBBBBBBBBBBBBBBBBBBBBBB')).toBe(false);
      expect(await insert('app_a1')).toBe(false);
      expect(await insert('app_none')).toBe(false);
      expect(await insert('app_m2', SUB, 'ABCD1234', 'hu_CCCCCCCCCCCCCCCCCCCCCCCCCC')).toBe(false);
    });

    it('checks the shapes of the User ID and the Support code; a u2_ re-key is allowed', async () => {
      await db.prepare("DELETE FROM end_user_apps WHERE app_id = 'app_m2'").run();
      for (const bad of ['u0_AAAAAAAAAAAAAAAAAAAAAA', 'ux_AAAAAAAAAAAAAAAAAAAAAA', 'u1_AAAA', 'x'.repeat(25)]) expect(await insert('app_m2', bad), bad).toBe(false);
      expect(await insert('app_m2', 'u2_AAAAAAAAAAAAAAAAAAAAAA')).toBe(true);
      await db.prepare("DELETE FROM end_user_apps WHERE app_id = 'app_m2'").run();
      for (const bad of ['ABCD123', 'ABCD12345', 'ABCDI234', 'ABCDL234', 'ABCDO234', 'ABCDU234', 'abcd1234']) expect(await insert('app_m2', SUB, bad), bad).toBe(false);
      expect(await insert('app_m2')).toBe(true);
    });

    it('names an existing app (a foreign key, ON DELETE CASCADE as name_shares)', async () => {
      const fk = (await db.prepare("SELECT \"table\", \"from\", \"to\", on_delete FROM pragma_foreign_key_list('end_user_apps') ORDER BY \"table\"").all()).results;
      expect(fk).toEqual([
        { table: 'apps', from: 'app_id', to: 'id', on_delete: 'CASCADE' },
        { table: 'end_users', from: 'user_id', to: 'user_id', on_delete: 'CASCADE' },
      ]);
    });

    it('goes with its person (ON DELETE CASCADE)', async () => {
      await db.prepare("DELETE FROM end_users WHERE user_id = 'hu_AAAAAAAAAAAAAAAAAAAAAAAAAA'").run();
      expect(await db.prepare('SELECT COUNT(*) AS n FROM end_user_apps').first()).toEqual({ n: 0 });
    });

    it('has its indexes', async () => {
      const names = (await db.prepare("SELECT name FROM sqlite_schema WHERE type = 'index' AND tbl_name = 'end_user_apps' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
      expect(names).toEqual(['end_user_apps_app', 'end_user_apps_sub', 'end_user_apps_support']);
    });
  });

  // Last: it applies every file again on the same database.
  it('applying the migrations again changes nothing', async () => {
    const apps = (await db.prepare('SELECT * FROM apps ORDER BY id').all()).results;
    const schema = await everyTriggerAndView();
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect((await db.prepare('SELECT * FROM apps ORDER BY id').all()).results).toEqual(apps);
    expect(await everyTriggerAndView()).toEqual(schema);
  });
});
