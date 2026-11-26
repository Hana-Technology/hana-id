// Migration 0035 (D934, piece P12 of docs/partner-platform-spec.md): additive. Applied to a database holding rows in
// every table around it (every migration before it): every row and every schema object of before is there after,
// unchanged (asked of `sqlite_schema`: every table, index, trigger and view of the whole schema), but `app_origins`,
// which gains exactly one column, `frame_only`, 0 on every existing row (today's behaviour); only its two triggers are
// new; the ledger tables keep their shape. Then every rule against bare D1 writes: a frame-only web address is never
// made usable anywhere in place (an update, a replace, an upsert), the flag is 0 or 1 and never on the localhost
// wildcard; setting it (a tightening) and removing the row (the way back) still work. Applying it again changes
// nothing; every trigger it creates is there after the last migration, with its SQL (a later migration that adds one
// names it in `LATER`).
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.FRESH_DB;
const FILE = '0035_frame_only_origins.sql';
type Obj = { type: string; name: string; tbl_name: string; sql: string | null };
const schema = async (d: D1Database = db): Promise<Map<string, Obj>> =>
  new Map((await d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name NOT LIKE 'sqlite_%' ORDER BY name").all<Obj>()).results.map((r) => [r.name, r]));
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
const run = async (sql: string, ...binds: unknown[]) => {
  const r = await refusal(sql, ...binds);
  if (r !== 'accepted') throw new Error(`${sql}: ${r}`);
};
const KEPT = ['scopes', 'apps', 'app_keys', 'app_changes', 'guarded_changes', 'platform_origin_waits', 'staff_origin_waits', 'origin_confirmations', 'org_security_contacts'];
const rowsOf = async (t: string) => (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
const cols = async (t: string, d: D1Database = db) => (await d.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name);

const TRIGGERS_0035 = ['app_origins_frame_only_kept', 'app_origins_frame_only_no_replace', 'app_origins_fixed'] as const;
const KEPT_AGAIN = /becomes usable anywhere only by being removed and proposed again/u;

let before: Map<string, Obj>;
let beforeRows: Record<string, unknown[]>;
let beforeOrigins: Record<string, unknown>[];
let beforeCols: Record<string, string[]>;

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  await run("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('st', 'org_a', 'test', 1, 1, 1, 1), ('sl', 'org_a', 'live', 1, 1, 1, 0)");
  await run("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_by_kind, user_ids) VALUES ('app_w', 'W', 'st', 'org_a', 'pk_test_Wwwwwwwwwwwwwwwwwwwwww', 'hana', 'app'), ('app_l', 'L', 'sl', 'org_a', 'pk_live_Llllllllllllllllllllll', 'hana', 'scope')");
  await run("INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('org_a', 's@a.example', 't', 1)");
  // In force, waiting for an announcement (a staff proposal), the localhost wildcard on the test app.
  await run("INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_w', 'https://partner.example', 0), ('app_w', 'http://localhost:*', 0), ('app_l', 'https://live.example', 5)");
  await run("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_w', 'app_w', 'origin_add', 'https://widget.example', 'pending', 'member', 'usr_1', 1, 'r_w')");
  await run("INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_w', 'https://widget.example', NULL, 'gc_w')");
  before = await schema();
  beforeRows = Object.fromEntries(await Promise.all(KEPT.map(async (t) => [t, await rowsOf(t)])));
  beforeOrigins = (await rowsOf('app_origins')) as Record<string, unknown>[];
  beforeCols = Object.fromEntries(await Promise.all(['apps', 'guarded_changes', 'app_changes', 'app_origins', 'security_events'].map(async (t) => [t, await cols(t)])));
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0035_frame_only_origins', () => {
  it('every table, index, trigger and view of before is there with the same SQL, but app_origins, which gains one column; only its two triggers are new; the ledger’s tables keep their shape', async () => {
    const after = await schema();
    for (const [name, o] of before) {
      if (name === 'app_origins') continue;
      expect(after.get(name), name).toEqual(o);
    }
    expect(after.get('app_origins')!.sql).toBe(
      before.get('app_origins')!.sql!.replace(
        'change_id TEXT,',
        "change_id TEXT, frame_only INTEGER NOT NULL DEFAULT 0 CHECK (frame_only IN (0, 1) AND (frame_only = 0 OR origin <> 'http://localhost:*')),",
      ),
    );
    expect([...after.keys()].filter((k) => !before.has(k)).sort()).toEqual([...TRIGGERS_0035].sort());
    for (const t of TRIGGERS_0035) expect(after.get(t)?.tbl_name, t).toBe('app_origins');
    // `ledger-check` holds the ledger's tables to their shape: 0035 adds none of their columns, and only one to app_origins.
    for (const t of ['apps', 'guarded_changes', 'app_changes', 'security_events']) expect(await cols(t), t).toEqual(beforeCols[t]);
    expect(await cols('app_origins')).toEqual([...beforeCols.app_origins!, 'frame_only']);
  });

  it('every row is as it was, and every web address is usable anywhere (frame_only 0, today’s behaviour)', async () => {
    for (const t of KEPT) expect(await rowsOf(t), t).toEqual(beforeRows[t]);
    expect(await rowsOf('app_origins')).toEqual(beforeOrigins.map((r) => ({ ...r, frame_only: 0 })));
  });

  it('the flag is 0 or 1, never on the localhost wildcard; set on an insert or later (a tightening), on a row in force or waiting', async () => {
    expect(await refusal("UPDATE app_origins SET frame_only = 2 WHERE origin = 'https://partner.example'")).toMatch(/CHECK constraint failed/u);
    expect(await refusal("UPDATE app_origins SET frame_only = NULL WHERE origin = 'https://partner.example'")).toMatch(/NOT NULL constraint failed/u);
    expect(await refusal("UPDATE app_origins SET frame_only = 1 WHERE origin = 'http://localhost:*'")).toMatch(/CHECK constraint failed/u);
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from, frame_only) VALUES ('app_l', 'http://localhost:*', 0, 1)")).toMatch(/CHECK constraint failed/u);
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from, frame_only) VALUES ('app_l', 'https://frame.example', NULL, 1)")).toBe('accepted');
    expect(await refusal("UPDATE app_origins SET frame_only = 1 WHERE change_id = 'gc_w'")).toBe('accepted');
    expect(await refusal("UPDATE app_origins SET frame_only = 1 WHERE app_id = 'app_l' AND origin = 'https://live.example'")).toBe('accepted');
    // Setting it again, or another column of a frame-only row, changes nothing of the rule.
    expect(await refusal("UPDATE app_origins SET frame_only = 1, active_from = 6 WHERE app_id = 'app_l' AND origin = 'https://live.example'")).toBe('accepted');
  });

  it('a frame-only web address is never made usable anywhere in place: no update, replace or upsert; removing it, then adding it again, is the way back', async () => {
    for (const [what, sql] of [
      ['an update', "UPDATE app_origins SET frame_only = 0 WHERE change_id = 'gc_w'"],
      ['an update with other columns', "UPDATE app_origins SET frame_only = 0, active_from = 0 WHERE change_id = 'gc_w'"],
      ['UPDATE OR REPLACE', "UPDATE OR REPLACE app_origins SET frame_only = 0 WHERE change_id = 'gc_w'"],
      ['INSERT OR REPLACE', "INSERT OR REPLACE INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_w', 'https://widget.example', NULL, 'gc_w')"],
      ['REPLACE', "REPLACE INTO app_origins (app_id, origin, active_from, change_id, frame_only) VALUES ('app_w', 'https://widget.example', NULL, 'gc_w', 0)"],
      ['an upsert', "INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_w', 'https://widget.example', 0) ON CONFLICT DO UPDATE SET frame_only = 0"],
      ['an upsert of another column', "INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_w', 'https://widget.example', 0) ON CONFLICT DO UPDATE SET active_from = 0"],
    ] as const) {
      expect(await refusal(sql), what).toMatch(KEPT_AGAIN);
    }
    expect(await db.prepare("SELECT frame_only, active_from, change_id FROM app_origins WHERE app_id = 'app_w' AND origin = 'https://widget.example'").first()).toEqual({ frame_only: 1, active_from: null, change_id: 'gc_w' });
    // A replace that keeps it frame-only is not a loosening (the 0034 rules still apply to a guarded row's time).
    expect(await refusal("INSERT OR REPLACE INTO app_origins (app_id, origin, active_from, change_id, frame_only) VALUES ('app_l', 'https://frame.example', NULL, NULL, 1)")).toBe('accepted');
    // The way back: the row goes (a removal), and a new proposal inserts it as usable anywhere.
    await run("DELETE FROM app_origins WHERE app_id = 'app_l' AND origin = 'https://frame.example'");
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_l', 'https://frame.example', NULL, 'gc_again')")).toBe('accepted');
    // Another app listing the same web address is its own row: one app's flag never touches another's.
    expect(await refusal("INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_l', 'https://widget.example', 0)")).toBe('accepted');
  });

  it('a row keeps its web address and app: no rename (the review’s UPDATE OR REPLACE onto a frame-only row included)', async () => {
    await run("INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_w', 'https://spare.example', 0)");
    for (const sql of [
      "UPDATE OR REPLACE app_origins SET origin = 'https://widget.example' WHERE app_id = 'app_w' AND origin = 'https://spare.example'",
      "UPDATE app_origins SET origin = 'https://elsewhere.example' WHERE app_id = 'app_w' AND origin = 'https://spare.example'",
      "UPDATE app_origins SET app_id = 'app_l' WHERE app_id = 'app_w' AND origin = 'https://spare.example'",
    ]) {
      expect(await refusal(sql), sql).toMatch(/keeps its web address and app/u);
    }
    expect(await db.prepare("SELECT frame_only FROM app_origins WHERE app_id = 'app_w' AND origin = 'https://widget.example'").first()).toEqual({ frame_only: 1 });
    // Setting a column to its own value isn't a move.
    expect(await refusal("UPDATE app_origins SET origin = origin, active_from = 1 WHERE app_id = 'app_w' AND origin = 'https://spare.example'")).toBe('accepted');
  });

  it('the database is whole, and applying the migrations again changes nothing', async () => {
    expect(await db.prepare('PRAGMA quick_check').all()).toMatchObject({ results: [{ quick_check: 'ok' }] });
    const names = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    const s = await schema();
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, env.TEST_MIGRATIONS.findIndex((m) => m.name === FILE) + 1));
    expect((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name)).toEqual(names);
    expect(await schema()).toEqual(s);
  });
});

describe('0035’s triggers after every later migration (a later rebuild of app_origins must create them again)', () => {
  /** Triggers a later migration adds or replaces on app_origins, by name. */
  const LATER: string[] = [];
  it('every trigger 0035 creates is there after the last migration, with 0035’s SQL, and the column with its CHECK', async () => {
    const m = env.MIGRATION_DB;
    await applyD1Migrations(m, env.TEST_MIGRATIONS);
    const at35 = await schema(db);
    const last = await schema(m);
    for (const name of TRIGGERS_0035) if (!LATER.includes(name)) expect(last.get(name)?.sql, name).toBe(at35.get(name)!.sql);
    expect(last.get('app_origins')?.sql).toContain("frame_only INTEGER NOT NULL DEFAULT 0 CHECK (frame_only IN (0, 1) AND (frame_only = 0 OR origin <> 'http://localhost:*'))");
  });
});
