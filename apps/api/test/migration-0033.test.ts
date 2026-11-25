// Migration 0033 (D929, piece P4 of docs/partner-platform-spec.md, A7, A9, A15, L3, L4): additive. Applied to a database
// holding rows in every table around it (every migration before it): every row and every schema object of before is
// there after, unchanged (asked of `sqlite_schema`: every table, index, trigger and view of the whole schema); only its
// own table, index, columns and triggers are new; each rule refuses a bare D1 write that breaks it (a platform
// proposal's earliest time; who holds the partner suspension; the idempotency record's insert, update, replace, upsert,
// delete-then-insert and early delete); applying it again changes nothing; and every trigger it creates is there after
// the last migration, with its SQL (a later migration that adds one names it in `LATER`).
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.FRESH_DB;
const FILE = '0033_platform_ops.sql';
const DAY = 86_400_000;
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
const KEPT = ['scopes', 'apps', 'app_origins', 'app_keys', 'app_changes', 'guarded_changes', 'platform_keys', 'platform_orgs', 'platform_calls', 'security_events', 'org_security_contacts'];
const rowsOf = async (t: string) => (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
const DB_NOW = async (): Promise<number> => (await db.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t").first<{ t: number }>())!.t;

/** Every trigger 0033 creates, as its header lists them: a later rebuild of their tables must create each again. */
const TRIGGERS_0033 = [
  'platform_requests_insert',
  'platform_requests_no_update',
  'platform_requests_no_early_delete',
  'platform_origin_waits_insert',
  'platform_origin_waits_update',
  'platform_origin_waits_no_delete',
  'guarded_changes_platform_insert',
  'guarded_changes_platform_fixed',
  'guarded_changes_platform_announced',
  'guarded_changes_platform_not_early',
  'guarded_changes_platform_no_waiver',
  'guarded_changes_platform_active_on_time',
  'guarded_changes_platform_status_moves',
  'guarded_changes_platform_no_delete',
  'guarded_changes_platform_wait_gone',
  'guarded_changes_platform_no_replace_update',
  'app_origins_platform_not_early',
  'app_origins_platform_not_early_update',
  'apps_partner_bit_by',
  'apps_platform_insert',
] as const;
const NEW = ['platform_requests', 'platform_requests_at', 'platform_origin_waits', ...TRIGGERS_0033];

let before: Map<string, Obj>;
let beforeRows: Record<string, unknown[]>;
let beforeCols: Record<string, string[]>;

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  const pk = new Uint8Array(65).fill(5);
  pk[0] = 4;
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('st', 'org_a', 'test', 1, 1, 1, 1), ('su', 'org_a', 'test', 1, 1, 1, 0), ('sl', 'org_a', 'live', 1, 1, 1, 0)").run();
  await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_by_kind, user_ids) VALUES ('app_p', 'P', 'st', 'org_a', 'pk_test_Pppppppppppppppppppppp', 'platform', 'app'), ('app_s', 'S', 'su', 'org_a', 'pk_test_Sssssssssssssssssssssss', 'hana', 'scope')").run();
  await db.prepare("UPDATE apps SET suspended_by = 4 WHERE id = 'app_s'").run();
  await db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES ('key_p', 'app_p', 'pk_test_Pppppppppppppppppppppp', 'x', 1)").run();
  await db.prepare("INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_s', 'https://s.example', 1)").run();
  await db.prepare("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app_p', 'app.created', '{}', 'platform', 'pkc_Mmmmmmmmmmmmm', 'pf_before')").run();
  // A platform proposal written before 0033 (no wait recorded): kept as it is.
  await db.prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, notified_at, active_from, request_id) VALUES ('gc_old', 'app_p', 'origin_add', 'https://old.example', 'pending', 'platform', 'pkc_Mmmmmmmmmmmmm', 1, 2, 3, 'pf_before')").run();
  await db.prepare("INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id) VALUES ('pkc_Mmmmmmmmmmmmm', 'org_a', 'K', 'ES256', ?1, ?2, '[\"st\"]', 'pending', 'member', 'usr_a', 'sub-a', 'a@a.example', 1, 0, 86400000, 'r_k')").bind(pk, 'M'.repeat(43)).run();
  await db.prepare("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_a', 's', 1)").run();
  await db.prepare("INSERT INTO platform_calls (at, org_id, key_id, method, route, status, request_id) VALUES (1, 'org_a', 'pkc_Mmmmmmmmmmmmm', 'GET', '/v1/platform/credential', 200, 'r')").run();
  await db.prepare("INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('org_a', 's@a.example', 't', 1)").run();
  before = await schema();
  beforeRows = Object.fromEntries(await Promise.all(KEPT.map(async (t) => [t, await rowsOf(t)])));
  beforeCols = Object.fromEntries(await Promise.all(['apps', 'guarded_changes', 'app_changes', 'security_events'].map(async (t) => [t, (await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name)])));
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('migration 0033_platform_ops', () => {
  it('every table, index, trigger and view of before is there with the same SQL (apps given its one column); only its own objects are new; the ledger’s tables keep their shape', async () => {
    const after = await schema();
    for (const [name, o] of before) {
      if (name === 'apps') continue;
      expect(after.get(name), name).toEqual(o);
    }
    expect([...after.keys()].filter((k) => !before.has(k)).sort()).toEqual([...NEW].sort());
    // apps: its SQL is the old one with the new column added, nothing else.
    const now = (await db.prepare("SELECT name FROM pragma_table_info('apps')").all<{ name: string }>()).results.map((r) => r.name);
    expect(now).toEqual([...beforeCols.apps!, 'partner_bit_by']);
    const squash = (x: string) => x.replace(/\s+/gu, ' ').trim();
    expect(squash(after.get('apps')!.sql!.replace(/,\s*partner_bit_by TEXT CHECK \(partner_bit_by IN \('member', 'platform'\)\)/u, ''))).toBe(squash(before.get('apps')!.sql!));
    // `ledger-check` (0027's deploy step) holds the ledger's tables to their shape: 0033 adds none of their columns.
    for (const t of ['app_changes', 'guarded_changes', 'security_events']) {
      expect((await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name), t).toEqual(beforeCols[t]);
    }
  });

  it('every row is as it was; the new column is NULL on every existing app (a suspension of before reads as a member’s)', async () => {
    for (const t of KEPT) {
      const stripped = (await rowsOf(t)).map((r) => {
        if (t !== 'apps') return r;
        const { partner_bit_by: _p, ...rest } = r as Record<string, unknown>;
        return rest;
      });
      expect(stripped, t).toEqual(beforeRows[t]);
    }
    expect((await db.prepare('SELECT DISTINCT partner_bit_by AS v FROM apps').all()).results).toEqual([{ v: null }]);
    expect((await db.prepare('SELECT COUNT(*) AS n FROM platform_origin_waits').first())).toEqual({ n: 0 });
  });

  it('platform_requests: a row only beside its own credential’s ledger row; never updated, replaced, upserted or deleted within 7 days (so never deleted and inserted again)', async () => {
    const h = 'a'.repeat(64);
    const ins = (o: Record<string, unknown> = {}) => {
      const r: Record<string, unknown> = { org_id: 'org_a', idem_hash: h, key_id: 'pkc_Mmmmmmmmmmmmm', method: 'POST', path: '/v1/platform/apps', body_sha256: 'b'.repeat(64), request_id: 'pf_before', at: Date.now(), ...o };
      const cols = Object.keys(r);
      return refusal(`INSERT INTO platform_requests (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
    };
    expect(await ins({ request_id: 'pf_nothing' })).toMatch(/no ledger row of this credential/u);
    expect(await ins({ key_id: 'pkc_Otherotherothr' })).toMatch(/no ledger row of this credential/u);
    expect(await ins({ org_id: 'org_b' })).toMatch(/no ledger row of this credential/u);
    for (const [col, v] of [['idem_hash', 'x'], ['method', 'GET'], ['path', '/v1/apps'], ['body_sha256', 'Z'.repeat(64)], ['request_id', 'req_x'], ['key_id', 'key_x'], ['org_id', 'acme']] as const) {
      expect(await ins({ [col]: v }), col).toMatch(/CHECK constraint failed|no ledger row/u);
    }
    expect(await ins()).toBe('accepted');
    const row = await db.prepare('SELECT * FROM platform_requests').all();
    expect(await refusal("UPDATE platform_requests SET body_sha256 = ?1", 'c'.repeat(64))).toMatch(/append-only/u);
    expect(await refusal("INSERT OR REPLACE INTO platform_requests (org_id, idem_hash, key_id, method, path, body_sha256, request_id, at) VALUES ('org_a', ?1, 'pkc_Mmmmmmmmmmmmm', 'POST', '/v1/platform/apps/x', ?2, 'pf_before', 1)", h, 'c'.repeat(64))).toMatch(/never replaced/u);
    expect(await refusal("INSERT INTO platform_requests (org_id, idem_hash, key_id, method, path, body_sha256, request_id, at) VALUES ('org_a', ?1, 'pkc_Mmmmmmmmmmmmm', 'POST', '/v1/platform/apps/x', ?2, 'pf_before', 1) ON CONFLICT DO UPDATE SET body_sha256 = excluded.body_sha256", h, 'c'.repeat(64))).toMatch(/never replaced|append-only/u);
    expect(await refusal('DELETE FROM platform_requests')).toMatch(/kept 7 days/u);
    expect(await db.prepare('SELECT * FROM platform_requests').all()).toEqual(row);
    // Past 7 days a row may go (the purge's): one 8 days old.
    await db.prepare("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app_p', 'key.created', '{}', 'platform', 'pkc_Mmmmmmmmmmmmm', 'pf_old')").run();
    expect(await ins({ idem_hash: 'd'.repeat(64), request_id: 'pf_old', at: Date.now() - 8 * DAY })).toBe('accepted');
    expect(await refusal('DELETE FROM platform_requests WHERE request_id = ?1', 'pf_old')).toBe('accepted');
  });

  it('a platform proposal: its wait first, then the change waiting, nothing announced; announced once, never back-dated, its earliest time at least its wait away; never in force sooner, never waived or expedited', async () => {
    const t = await DB_NOW();
    const wait = (id: string, o: Record<string, unknown> = {}) => {
      const r: Record<string, unknown> = { change_id: id, app_id: 'app_p', origin: `https://${id}.example`, key_id: 'pkc_Mmmmmmmmmmmmm', min_delay_ms: DAY, at: t, ...o };
      const cols = Object.keys(r);
      return refusal(`INSERT INTO platform_origin_waits (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
    };
    const add = (id: string, o: Record<string, unknown> = {}) => {
      const r: Record<string, unknown> = { id, app_id: 'app_p', kind: 'origin_add', origin: `https://${id}.example`, status: 'pending', proposed_by_kind: 'platform', proposed_by: 'pkc_Mmmmmmmmmmmmm', proposed_at: t, request_id: `pf_${id}`, ...o };
      const cols = Object.keys(r);
      return refusal(`INSERT INTO guarded_changes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
    };
    // The wait: at least 60 s, its earliest time left for the ack, written once and never for a change that exists.
    expect(await wait('gc_short', { min_delay_ms: 59_999 })).toMatch(/CHECK/u);
    expect(await wait('gc_early', { unconfirmed_active_from: t + DAY })).toMatch(/written once, before its proposal/u);
    expect(await wait('gc_old')).toMatch(/written once, before its proposal/u);
    // A platform change without its wait, or with another's, or not starting as it should: refused.
    expect(await add('gc_nowait')).toMatch(/starts as a waiting web address/u);
    expect(await wait('gc_a')).toBe('accepted');
    expect(await wait('gc_a')).toMatch(/written once/u);
    expect(await refusal("INSERT OR REPLACE INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES ('gc_a', 'app_p', 'https://gc_a.example', 'pkc_Mmmmmmmmmmmmm', 60000, 1)")).toMatch(/written once/u);
    for (const [what, o] of [
      ['another key', { proposed_by: 'pkc_Otherotherothr' }],
      ['another origin', { origin: 'https://other.example' }],
      ['announced at once', { notified_at: t }],
      ['in force at once', { active_from: t }],
      ['with a waiver', { waiver: 'no_session' }],
      ['expedited', { expedited_by: 'x' }],
      ['in force already', { status: 'active' }],
      ['another kind', { kind: 'raw_sign_on', origin: null }],
    ] as const) {
      expect(await add('gc_a', o), what).toMatch(/starts as a waiting web address|CHECK/u);
    }
    expect(await add('gc_a')).toBe('accepted');
    expect(await add('gc_a', { proposed_by_kind: 'hana' })).toMatch(/never replaced|UNIQUE/u);
    expect(await refusal("INSERT OR REPLACE INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_a', 'app_p', 'origin_add', 'https://gc_a.example', 'active', 'hana', 's', 1, 'r')")).toMatch(/never replaced/u);
    await db.prepare("INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_p', 'https://gc_a.example', NULL, 'gc_a')").run();
    // Announced only with its earliest time written, at least its wait from now and from the announcement.
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1 WHERE id = 'gc_a'", t)).toMatch(/announced once/u);
    expect(await refusal("UPDATE platform_origin_waits SET unconfirmed_active_from = ?1 WHERE change_id = 'gc_a'", t + DAY - 200_000)).toMatch(/only the earliest time/u);
    expect(await refusal("UPDATE platform_origin_waits SET min_delay_ms = 60000 WHERE change_id = 'gc_a'")).toMatch(/only the earliest time/u);
    expect(await refusal("UPDATE platform_origin_waits SET unconfirmed_active_from = ?1 WHERE change_id = 'gc_a'", t + DAY)).toBe('accepted');
    expect(await refusal("UPDATE platform_origin_waits SET unconfirmed_active_from = ?1 WHERE change_id = 'gc_a'", t + 2 * DAY)).toMatch(/only the earliest time/u);
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_a'", t - 400_000, t + DAY)).toMatch(/announced once/u);
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_a'", t + 60_000, t + DAY)).toMatch(/announced once/u); // the earliest time less than its wait after the announcement
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_a'", t, t + DAY - 1)).toMatch(/no earlier than its wait/u);
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_a'", t, t + DAY)).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1 WHERE id = 'gc_a'", t + 1)).toMatch(/announced once/u);
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_a'", t + DAY - 1)).toMatch(/no earlier than its wait/u);
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_a'", t + 2 * DAY)).toBe('accepted'); // later is allowed
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_a'", t + DAY)).toBe('accepted');
    // The gate's row follows, never sooner.
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_a'", t + DAY - 1)).toMatch(/no earlier than its wait/u);
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_a'", t + DAY)).toBe('accepted');
    expect(await refusal("INSERT OR REPLACE INTO app_origins (app_id, origin, active_from) VALUES ('app_p', 'https://gc_a.example', ?1)", t)).toMatch(/no earlier than its wait/u);
    // Not recorded in force before its time; no waiver, no expedite; its proposer and web address fixed.
    expect(await refusal("UPDATE guarded_changes SET status = 'active' WHERE id = 'gc_a'")).toMatch(/only once its time has passed/u);
    expect(await refusal("UPDATE guarded_changes SET waiver = 'loopback' WHERE id = 'gc_a'")).toMatch(/no waiver/u);
    expect(await refusal("UPDATE guarded_changes SET expedited_by = 'x', expedite_reason = 'y' WHERE id = 'gc_a'")).toMatch(/no waiver/u);
    for (const set of ["proposed_by_kind = 'hana'", "proposed_by = 'pkc_Otherotherothr'", "origin = 'https://other.example'", "app_id = 'app_s'", "request_id = 'r_other'"]) {
      expect(await refusal(`UPDATE guarded_changes SET ${set} WHERE id = 'gc_a'`), set).toMatch(/are fixed/u);
    }
    // Never deleted while waiting (nor its wait); never replaced through another row; a staff row never becomes a platform one.
    expect(await refusal("DELETE FROM guarded_changes WHERE id = 'gc_a'")).toMatch(/never deleted/u);
    expect(await refusal("DELETE FROM platform_origin_waits WHERE change_id = 'gc_a'")).toMatch(/kept while its proposal exists/u);
    expect(await refusal("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_staff', 'app_s', 'origin_add', 'https://staff.example', 'pending', 'hana', 's', 1, 'r_s')")).toBe('accepted');
    expect(await refusal("UPDATE OR REPLACE guarded_changes SET id = 'gc_a' WHERE id = 'gc_staff'")).toMatch(/never replaced/u);
    expect(await refusal("UPDATE guarded_changes SET proposed_by_kind = 'platform' WHERE id = 'gc_staff'")).toMatch(/are fixed/u);
    // A cancelled one never comes back; then it may go (retention), and its wait goes with it.
    expect(await refusal("UPDATE guarded_changes SET status = 'cancelled', cancelled_at = 1, cancelled_by = 'x' WHERE id = 'gc_a'")).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET status = 'pending' WHERE id = 'gc_a'")).toMatch(/never comes back/u);
    expect(await refusal("DELETE FROM app_origins WHERE change_id = 'gc_a'")).toBe('accepted');
    expect(await refusal("DELETE FROM guarded_changes WHERE id = 'gc_a'")).toBe('accepted');
    expect(await db.prepare("SELECT COUNT(*) AS n FROM platform_origin_waits WHERE change_id = 'gc_a'").first()).toEqual({ n: 0 });
    // A platform proposal written before 0033 (no wait) is never announced: fail closed.
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1 WHERE id = 'gc_old'", t)).toMatch(/announced once/u);
    // Staff and member proposals are untouched by these rules.
    expect(await refusal("UPDATE guarded_changes SET notified_at = 1, active_from = 1, waiver = 'no_session' WHERE id = 'gc_staff'")).toBe('accepted');
  });

  it('who holds the partner suspension: only while bit 4 is set; a replacing insert can’t change it, nor who created the app', async () => {
    expect(await refusal("UPDATE apps SET partner_bit_by = 'platform' WHERE id = 'app_p'")).toMatch(/only while it is set/u);
    expect(await refusal("UPDATE apps SET suspended_by = 4, partner_bit_by = 'platform' WHERE id = 'app_p'")).toBe('accepted');
    expect(await refusal("UPDATE apps SET suspended_by = 0 WHERE id = 'app_p'")).toMatch(/only while it is set/u);
    expect(await refusal("UPDATE apps SET partner_bit_by = 'other' WHERE id = 'app_p'")).toMatch(/CHECK/u);
    const cols = 'id, name, scope_id, org_id, publishable_key, created_by_kind, user_ids, suspended_by, partner_bit_by';
    expect(await refusal(`INSERT OR REPLACE INTO apps (${cols}) VALUES ('app_p', 'P', 'st', 'org_a', 'pk_test_Pppppppppppppppppppppp', 'platform', 'app', 4, 'member')`)).toMatch(/changes only with the suspension/u);
    expect(await refusal(`INSERT OR REPLACE INTO apps (${cols}) VALUES ('app_s', 'S', 'su', 'org_a', 'pk_test_Sssssssssssssssssssssss', 'platform', 'scope', 4, NULL)`)).toMatch(/created_by_kind is fixed/u);
    expect(await refusal(`INSERT INTO apps (${cols}) VALUES ('app_n', 'N', 'su', 'org_a', 'pk_test_Nnnnnnnnnnnnnnnnnnnnnnn', 'hana', 'scope', 0, 'platform')`)).toMatch(/only while it is set/u);
    expect(await db.prepare("SELECT suspended_by, partner_bit_by, created_by_kind FROM apps WHERE id IN ('app_p', 'app_s') ORDER BY id").all()).toMatchObject({
      results: [
        { suspended_by: 4, partner_bit_by: 'platform', created_by_kind: 'platform' },
        { suspended_by: 4, partner_bit_by: null, created_by_kind: 'hana' },
      ],
    });
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

describe('0033’s triggers after every later migration (a later rebuild of their tables must create them again)', () => {
  /** Triggers a later migration adds or replaces on these tables, by name (P10 replaces the not-early ones). */
  const LATER: string[] = [];
  it('every trigger 0033 creates is there after the last migration, with 0033’s SQL; and every trigger and view of 0033’s schema too', async () => {
    const m = env.MIGRATION_DB;
    await applyD1Migrations(m, env.TEST_MIGRATIONS);
    const at33 = await schema(db);
    const last = await schema(m);
    for (const name of TRIGGERS_0033) if (!LATER.includes(name)) expect(last.get(name)?.sql, name).toBe(at33.get(name)!.sql);
    for (const [name, o] of at33) if ((o.type === 'trigger' || o.type === 'view') && !LATER.includes(name)) expect(last.get(name), name).toEqual(o);
  });
});
