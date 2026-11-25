// Migration 0027 (D916, piece P1 of docs/partner-platform-spec.md, A7 "Widening the actor kinds: the ledger rebuild"):
// `app_changes` and `guarded_changes` rebuilt with their actor and proposer kinds as triggers, `security_events` with
// three more kinds. Applied to a database already holding rows of every kind each table has held (every app change
// kind by every actor, every guarded change kind, status, proposer and waiver, every security event kind, a `seq` gap
// left by a purged row and a `seq` far above the rest): every row comes back unchanged and in order, `seq` included;
// every index and trigger is there with the same SQL; each table's SQL differs from before only by the one CHECK; every
// refusal of before still holds; `platform` is taken and an unknown kind refused.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { ACTOR_KINDS, APP_CHANGE_KINDS, PROPOSER_KINDS, SECURITY_EVENT_KINDS } from '@hana-id/console-core';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const FILE = '0027_platform_actor.sql';
const TABLES = ['app_changes', 'guarded_changes', 'security_events'] as const;
const KEY: Record<(typeof TABLES)[number], string> = { app_changes: 'seq', guarded_changes: 'id', security_events: 'id' };
/** The kinds each table took before 0027 (0006's CHECKs; security_events as 0025 left it). */
const OLD_ACTORS = ['member', 'hana', 'system', 'link'];
const OLD_PROPOSERS = ['member', 'hana', 'system'];
const NEW_EVENT_KINDS = ['platform_quota', 'platform_auth_failures', 'link_lookup_volume'];
const OLD_EVENT_KINDS = SECURITY_EVENT_KINDS.filter((k) => !NEW_EVENT_KINDS.includes(k));
const MONTH = 31 * 86_400_000;
const now = Date.now();

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
const rowsOf = async (t: (typeof TABLES)[number]): Promise<Row[]> => (await db.prepare(`SELECT * FROM ${t} ORDER BY ${KEY[t]}`).all<Row>()).results;
const columnsOf = async (t: string): Promise<Row[]> => (await db.prepare(`SELECT cid, name, type, "notnull", dflt_value, pk FROM pragma_table_info('${t}') ORDER BY cid`).all<Row>()).results;
/** Every index, trigger and table of the three tables, as `sqlite_schema` holds them. */
const schemaOf = async (): Promise<Map<string, { type: string; tbl: string; sql: string | null }>> => {
  const { results } = await db
    .prepare(`SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE tbl_name IN ('app_changes', 'guarded_changes', 'security_events') ORDER BY name`)
    .all<{ type: string; name: string; tbl_name: string; sql: string | null }>();
  return new Map(results.map((r) => [r.name, { type: r.type, tbl: r.tbl_name, sql: r.sql }]));
};
const hash32 = (n: number): Uint8Array => {
  const b = new Uint8Array(32);
  for (let i = 0; i < 32; i++) b[i] = (n * 31 + i * 7) & 0xff;
  return b;
};

let beforeRows: Record<string, Row[]>;
let beforeColumns: Record<string, Row[]>;
let beforeSchema: Map<string, { type: string; tbl: string; sql: string | null }>;
let maxSeqBefore: number;

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));

  // Two orgs, a test and a live scope, three apps (the guarded_changes insert trigger wants a real app).
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s_t', 'org_a', 'test', 1, 1, 1), ('s_l', 'org_a', 'live', NULL, 1, 1), ('s_b', 'org_b', 'test', 1, 1, 1)").run();
  await db
    .prepare(
      "INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_t', 'Test app', 's_t', 'org_a', 'pk_test_Ttttttttttttttttttttttt'), ('app_l', 'Live app', 's_l', 'org_a', 'pk_live_Lllllllllllllllllllllll'), ('app_b', 'B app', 's_b', 'org_b', 'pk_test_Bbbbbbbbbbbbbbbbbbbbbbb')",
    )
    .run();

  // app_changes: a row 61 months old (purged below, leaving a gap in seq), then every kind the API writes, each by
  // every actor of before; org-level rows (no app), a member's step-up sub, details with nesting, unicode and quotes.
  const ins = db.prepare('INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)');
  await ins.bind(now - 61 * MONTH, 'org_a', 'app_t', 's_t', 'app.created', '{}', 'hana', 'staff@hana.example', null, 'req_purged').run();
  let n = 0;
  const batch: D1PreparedStatement[] = [];
  for (const kind of APP_CHANGE_KINDS) {
    for (const actor of OLD_ACTORS) {
      n += 1;
      const orgLevel = kind.startsWith('org.') || kind.startsWith('labels.') || kind === 'scope.assigned';
      const app = orgLevel ? null : n % 3 === 0 ? 'app_l' : 'app_t';
      const detail = JSON.stringify({ n, kind, note: `ünïcødé “quoted” 'single' ${actor}`, nested: { list: [1, 'two', { three: null }], at: now - n } });
      batch.push(ins.bind(now - (1000 - n) * 60_000, n % 5 === 0 ? 'org_b' : 'org_a', app, n % 4 === 0 ? null : 's_t', kind, detail, actor, actor === 'link' ? `gc_${n}` : `${actor}_${n}`, actor === 'member' ? `sub-${n}` : null, `req_${String(n).padStart(4, '0')}`));
    }
  }
  await db.batch(batch);
  await db.prepare("DELETE FROM app_changes WHERE request_id = 'req_purged'").run();
  // A seq far above the rest (rows can be written with any seq; the next one must follow it, not fill the gap).
  await ins.bind(now, 'org_a', 'app_t', 's_t', 'key.created', '{"prefix":"pk_test_"}', 'member', 'usr_hi', 'sub-hi', 'req_high').run();
  await db.prepare("INSERT INTO app_changes (seq, at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (90000, ?1, 'org_a', 'org.security_contacts', '{\"contacts\":2}', 'hana', 'staff@hana.example', 'req_90000')").bind(now).run();

  // guarded_changes: every kind, status and proposer of before, with and without a waiver, announced or not, a cancel
  // link's hash, an expedite, an end, a cancel.
  const gc = db.prepare(
    `INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22, ?23)`,
  );
  const gcs: D1PreparedStatement[] = [];
  let g = 0;
  for (const kind of ['origin_add', 'policy_set', 'raw_sign_on'])
    for (const status of ['pending', 'active', 'cancelled', 'ended'])
      for (const by of OLD_PROPOSERS) {
        g += 1;
        const notified = status !== 'pending' || g % 2 === 0;
        gcs.push(
          gc.bind(
            `gc_${String(g).padStart(3, '0')}`,
            g % 4 === 0 ? 'app_l' : 'app_t',
            kind,
            kind === 'origin_add' ? (g % 3 === 0 ? 'https://xn--bcher-kva.example' : `https://o${g}.example.com:8443`) : null,
            kind === 'policy_set' ? JSON.stringify({ label: 'Swap “up to” 5', rules: [{ contract: 'swap.testnet', methods: ['swap'] }] }) : null,
            kind === 'policy_set' ? 'ab'.repeat(32) : null,
            status,
            by,
            by === 'member' ? 'usr_m' : by === 'hana' ? 'staff@hana.example' : 'cron',
            by === 'member' ? `sub-g${g}` : null,
            now - g * 3_600_000,
            by === 'member' ? 'SG' : null,
            g % 5 === 0 ? 'loopback' : g % 7 === 0 ? 'no_session' : null,
            notified ? now - g * 3_500_000 : null,
            notified ? now - g * 3_400_000 : null,
            notified ? hash32(g) : null,
            status === 'active' || status === 'ended' ? now - g * 3_300_000 : null,
            g % 6 === 0 && by === 'member' ? 'staff@hana.example' : null,
            g % 6 === 0 && by === 'member' ? 'Partner asked; ticket ZD-1' : null,
            status === 'ended' ? now - g * 1000 : null,
            status === 'cancelled' ? (g % 2 ? 'link' : 'usr_m') : null,
            status === 'cancelled' ? now - g * 1000 : null,
            `req_g${g}`,
          ),
        );
      }
  await db.batch(gcs);

  // security_events: every kind 0025 took, emailed or not, with and without an org, app and scope.
  await db.batch(
    OLD_EVENT_KINDS.map((k, i) =>
      db
        .prepare('INSERT INTO security_events (id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)')
        .bind(`se_${k}`, now - i, k, i % 2 ? 'org_a' : null, i % 3 ? 'app_t' : null, i % 4 ? 's_t' : null, JSON.stringify({ i, what: `${k} “x”` }), i % 2 ? now : null),
    ),
  );

  // Before 0027: platform is refused everywhere, as is a new event kind.
  expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app.renamed', '{}', 'platform', 'pkc_1', 'req_pf_before')")).toBe(false);
  expect(await accepted("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_pf_before', 'app_t', 'origin_add', 'https://x.example', 'pending', 'platform', 'pkc_1', 1, 'r')")).toBe(false);
  expect(await accepted("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_pf_before', 1, 'platform_quota', '{}')")).toBe(false);

  beforeRows = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await rowsOf(t)] as const)));
  beforeColumns = Object.fromEntries(await Promise.all(TABLES.map(async (t) => [t, await columnsOf(t)] as const)));
  beforeSchema = await schemaOf();
  maxSeqBefore = (await db.prepare('SELECT max(seq) AS m FROM app_changes').first<{ m: number }>())!.m;
  expect(beforeRows.app_changes!.length).toBe(APP_CHANGE_KINDS.length * OLD_ACTORS.length + 2);
  expect(beforeRows.guarded_changes!.length).toBe(36);
  expect(beforeRows.security_events!.length).toBe(OLD_EVENT_KINDS.length);
  expect(maxSeqBefore).toBe(90000);

  await applyD1Migrations(db, migrations);
});

describe('migration 0027_platform_actor', () => {
  it('keeps every row of the three tables, unchanged and in the same order, seq included', async () => {
    for (const t of TABLES) expect(await rowsOf(t), t).toEqual(beforeRows[t]);
    expect((await db.prepare('SELECT max(seq) AS m FROM app_changes').first<{ m: number }>())!.m).toBe(maxSeqBefore);
    // The gap the purged row left is still a gap; seq 1 (that row) is gone, seq 2 is the first kind's first row.
    expect(beforeRows.app_changes![0]!.seq).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM app_changes WHERE seq = 1').first()).toEqual({ n: 0 });
  });

  it('keeps every column, type, NOT NULL, default and key of the three tables', async () => {
    for (const t of TABLES) expect(await columnsOf(t), t).toEqual(beforeColumns[t]);
  });

  it('recreates every index and trigger with the same SQL, adds only the three kind triggers', async () => {
    const after = await schemaOf();
    const added = [...after.keys()].filter((k) => !beforeSchema.has(k));
    expect(added.sort()).toEqual(['app_changes_actor_kind', 'guarded_changes_proposer_kind', 'guarded_changes_proposer_kind_update']);
    expect([...beforeSchema.keys()].filter((k) => !after.has(k))).toEqual([]);
    for (const [name, b] of beforeSchema) {
      if (b.type === 'table') continue;
      expect(after.get(name), name).toEqual(b);
    }
    // The ones A7 names, by name (an index or trigger missing before would hide here otherwise).
    for (const name of ['app_changes_org_seq', 'guarded_changes_app', 'guarded_changes_unnotified', 'guarded_changes_due', 'security_events_unnotified', 'app_changes_no_update', 'app_changes_no_early_delete', 'guarded_changes_insert']) {
      expect(after.has(name), name).toBe(true);
    }
    // The UNIQUE constraints' automatic indexes (request_id, cancel_token_hash, the text keys) are there too.
    expect([...after.keys()].filter((k) => k.startsWith('sqlite_autoindex_')).sort()).toEqual([...beforeSchema.keys()].filter((k) => k.startsWith('sqlite_autoindex_')).sort());
  });

  it('each table’s SQL is the old one less the kind CHECK it moved (security_events: three kinds more)', async () => {
    const after = await schemaOf();
    const quoted = (sql: string, t: string) => sql.replace(`CREATE TABLE ${t} (`, `CREATE TABLE "${t}" (`);
    expect(after.get('app_changes')!.sql).toBe(quoted(beforeSchema.get('app_changes')!.sql!, 'app_changes').replace(" CHECK (actor_kind IN ('member', 'hana', 'system', 'link'))", ''));
    expect(after.get('guarded_changes')!.sql).toBe(quoted(beforeSchema.get('guarded_changes')!.sql!, 'guarded_changes').replace(" CHECK (proposed_by_kind IN ('member', 'hana', 'system'))", ''));
    expect(after.get('security_events')!.sql).toBe(beforeSchema.get('security_events')!.sql!.replace("'label_live')", "'label_live', 'platform_quota', 'platform_auth_failures', 'link_lookup_volume')"));
  });

  it('the trigger lists and the CHECK list are console-core’s ACTOR_KINDS, PROPOSER_KINDS and SECURITY_EVENT_KINDS', async () => {
    const list = (sql: string) => [.../NOT IN \(([^)]*)\)/u.exec(sql)![1]!.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    const after = await schemaOf();
    expect(list(after.get('app_changes_actor_kind')!.sql!)).toEqual([...ACTOR_KINDS]);
    expect(list(after.get('guarded_changes_proposer_kind')!.sql!)).toEqual([...PROPOSER_KINDS]);
    expect(list(after.get('guarded_changes_proposer_kind_update')!.sql!)).toEqual([...PROPOSER_KINDS]);
    const events = [.../kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/u.exec(after.get('security_events')!.sql!)![1]!.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    expect([...events].sort()).toEqual([...SECURITY_EVENT_KINDS].sort());
  });

  it('takes platform as an actor and a proposer; refuses an unknown kind, in any case or spelling, and NULL', async () => {
    const change = (actor: string | null, rid: string) =>
      refusal("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, 'org_a', 'app_t', 'origin.proposed', '{}', ?2, 'pkc_1', ?3)", now, actor, rid);
    expect(await change('platform', 'req_pf_ok')).toBe('accepted');
    for (const k of OLD_ACTORS) expect(await change(k, `req_ok_${k}`), k).toBe('accepted');
    for (const bad of ['staff', 'Platform', 'platform ', '', 'owner']) expect(await change(bad, `req_bad_${bad}`), bad).toMatch(/unknown actor_kind/u);
    expect(await change(null, 'req_null')).toMatch(/NOT NULL/u);

    const prop = (by: string | null, id: string) =>
      refusal("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, 'app_t', 'origin_add', 'https://p.example', 'pending', ?2, 'pkc_1', 1, ?1)", id, by);
    expect(await prop('platform', 'gc_pf_ok')).toBe('accepted');
    for (const k of OLD_PROPOSERS) expect(await prop(k, `gc_ok_${k}`), k).toBe('accepted');
    // `link` is an actor (a cancel), never a proposer, as before.
    for (const bad of ['link', 'staff', 'PLATFORM', '']) expect(await prop(bad, `gc_bad_${bad}`), bad).toMatch(/unknown proposed_by_kind/u);
    expect(await prop(null, 'gc_null')).toMatch(/NOT NULL/u);
    // The proposer's kind is held on update too, as the CHECK held it.
    expect(await refusal("UPDATE guarded_changes SET proposed_by_kind = 'staff' WHERE id = 'gc_pf_ok'")).toMatch(/unknown proposed_by_kind/u);
    expect(await refusal("UPDATE guarded_changes SET proposed_by_kind = 'hana' WHERE id = 'gc_pf_ok'")).toBe('accepted');
    // Lifecycle updates are unaffected.
    expect(await refusal("UPDATE guarded_changes SET status = 'cancelled', cancelled_by = 'pkc_1', cancelled_at = 5 WHERE id = 'gc_ok_member'")).toBe('accepted');
  });

  it('a new ledger row follows the highest seq (never fills a gap), so the admin feed’s changesSince(seq) misses nothing', async () => {
    const top = (await db.prepare('SELECT max(seq) AS m FROM app_changes').first<{ m: number }>())!.m;
    expect(top).toBeGreaterThanOrEqual(maxSeqBefore);
    await db.prepare("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, 'org_a', 'app.renamed', '{}', 'platform', 'pkc_1', 'req_next')").bind(now).run();
    expect(await db.prepare("SELECT seq FROM app_changes WHERE request_id = 'req_next'").first()).toEqual({ seq: top + 1 });
  });

  it('keeps every refusal of before: append-only, 60 months, unique request id, JSON, the guarded change rules', async () => {
    const recent = beforeRows.app_changes![5]!;
    expect(await refusal('UPDATE app_changes SET kind = ?1 WHERE seq = ?2', 'x', recent.seq)).toMatch(/append-only/u);
    expect(await refusal("UPDATE app_changes SET actor_kind = 'platform' WHERE seq = ?1", recent.seq)).toMatch(/append-only/u);
    expect(await refusal('DELETE FROM app_changes WHERE seq = ?1', recent.seq)).toMatch(/kept 60 months/u);
    expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (?1, 'org_a', 'app.renamed', '{}', 'system', 't', 'req_old')", now - 61 * MONTH)).toBe(true);
    expect(await accepted("DELETE FROM app_changes WHERE request_id = 'req_old'")).toBe(true);
    expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', '{}', 'system', 't', ?1)", recent.request_id)).toBe(false); // unique
    expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', 'not json', 'platform', 't', 'req_json')")).toBe(false);
    expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, NULL, 'k', '{}', 'platform', 't', 'req_noorg')")).toBe(false);
    expect(await accepted("INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'o', 'k', '{}', 'platform', 't', NULL)")).toBe(false);

    const g = (id: string, cols: string) =>
      accepted(`INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposed_at, request_id, waiver, cancel_token_hash) VALUES ('${id}', ${cols}, 'r', NULL, NULL)`);
    expect(await g('gc_r1', "'nope', 'origin_add', 'https://x.example', NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(false); // no such app
    expect(await g('gc_r2', "'app_t', 'origin_add', NULL, NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(false); // origin_add needs its origin
    expect(await g('gc_r3', "'app_t', 'policy_set', NULL, '{}', NULL, 'pending', 'platform', 'p', 1")).toBe(false); // and policy_set both fields
    expect(await g('gc_r4', "'app_t', 'raw_sign_on', 'https://x.example', NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(false);
    expect(await g('gc_r5', "'app_t', 'other_kind', NULL, NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(false);
    expect(await g('gc_r6', "'app_t', 'origin_add', 'https://x.example', NULL, NULL, 'waiting', 'platform', 'p', 1")).toBe(false);
    expect(await g('gc_001', "'app_t', 'origin_add', 'https://x.example', NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(false); // primary key
    expect(await g('gc_r7', "'app_t', 'origin_add', 'https://x.example', NULL, NULL, 'pending', 'platform', 'p', 1")).toBe(true);
    expect(await accepted("UPDATE guarded_changes SET waiver = 'expedite' WHERE id = 'gc_r7'")).toBe(false);
    expect(await accepted("UPDATE guarded_changes SET status = 'gone' WHERE id = 'gc_r7'")).toBe(false);
    expect(await accepted("UPDATE guarded_changes SET origin = NULL WHERE id = 'gc_r7'")).toBe(false);
    // The cancel link's hash is still unique.
    const taken = beforeRows.guarded_changes!.find((r) => r.cancel_token_hash !== null)!;
    expect(await accepted('UPDATE guarded_changes SET cancel_token_hash = (SELECT cancel_token_hash FROM guarded_changes WHERE id = ?1) WHERE id = ?2', taken.id, 'gc_r7')).toBe(false);
  });

  it('security_events takes the three new kinds and every old one; refuses another', async () => {
    for (const k of SECURITY_EVENT_KINDS) expect(await accepted('INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, 1, ?2, ?3)', `se_new_${k}`, k, '{}'), k).toBe(true);
    expect(await accepted("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_x', 1, 'platform_other', '{}')")).toBe(false);
    expect(await accepted("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_y', 1, 'platform_quota', 'not json')")).toBe(false);
    expect(await accepted("UPDATE security_events SET kind = 'nope' WHERE id = 'se_drift'")).toBe(false);
    expect(await accepted('UPDATE security_events SET notified_at = 9 WHERE id = ?1', 'se_drift')).toBe(true);
  });

  it('the database is whole: quick_check and the foreign key check come back clean', async () => {
    expect(await db.prepare('PRAGMA quick_check').all()).toMatchObject({ results: [{ quick_check: 'ok' }] });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });

  it('applying the migrations again changes nothing (each file once, in name order)', async () => {
    const before = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    const rows = await rowsOf('app_changes');
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    expect((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name)).toEqual(before);
    expect(before).toContain(FILE);
    expect(await rowsOf('app_changes')).toEqual(rows);
  });
});
