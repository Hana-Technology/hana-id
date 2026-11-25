// Migration 0028 (D918, piece P2 of docs/partner-platform-spec.md, A7): `platform_keys` and `platform_orgs`, additive.
// Applied to a database holding rows in the tables around it: every row and every schema object of before is there
// after, unchanged; only the two tables, their indexes and their triggers are new; none of the new triggers reads the
// ledger's tables (so `ledger-check` and 0027's readers are untouched); the CHECK lists are console-core's; and each
// table rule refuses a bare D1 write that breaks it.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { PLATFORM_KEY_ACTOR_KINDS, PLATFORM_KEY_CONFIRM_KINDS, PLATFORM_KEY_STATUSES } from '@hana-id/console-core';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.FRESH_DB;
const FILE = '0028_platform_keys.sql';
const NEW_TABLES = ['platform_keys', 'platform_orgs'];
const now = Date.now();
type Obj = { type: string; name: string; tbl_name: string; sql: string | null };
const schema = async (): Promise<Map<string, Obj>> =>
  new Map((await db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' ORDER BY name").all<Obj>()).results.map((r) => [r.name, r]));
const refusal = (sql: string, ...binds: unknown[]): Promise<string> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => 'accepted',
      (e: unknown) => String(e instanceof Error ? e.message : e),
    );
const KEPT_TABLES = ['scopes', 'apps', 'app_changes', 'guarded_changes', 'app_origins', 'org_security_contacts', 'security_events'];
const rowsOf = async (t: string) => (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;

let before: Map<string, Obj>;
let beforeRows: Record<string, unknown[]>;
const point = new Uint8Array(65).fill(7);
point[0] = 4;

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('st', 'org_a', 'test', 1, 1, 1), ('st2', 'org_a', 'test', 1, 1, 1), ('sl', 'org_a', 'live', NULL, 1, 1), ('sb', 'org_b', 'test', 1, 1, 1)").run();
  await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_t', 'T', 'st', 'org_a', 'pk_test_Ttttttttttttttttttttttt')").run();
  await db.prepare("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app_t', 'app.created', '{}', 'hana', 's', 'r1'), (2, 'org_a', NULL, 'org.security_contacts', '{}', 'hana', 's', 'r2')").run();
  await db.prepare("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_1', 'app_t', 'origin_add', 'https://a.example', 'pending', 'platform', 'pkc_x', 1, 'r3')").run();
  await db.prepare("INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('org_a', 's@a.example', 't', 1)").run();
  before = await schema();
  beforeRows = Object.fromEntries(await Promise.all(KEPT_TABLES.map(async (t) => [t, await rowsOf(t)])));
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

/** A key row as the API writes a member's registration; `o` overrides columns. */
const insertKey = (o: Record<string, unknown> = {}) => {
  const row: Record<string, unknown> = {
    id: `pkc_${Math.random().toString(36).slice(2, 14).padEnd(12, 'x')}`,
    org_id: 'org_a',
    label: 'Backend',
    alg: 'ES256',
    public_key: (() => {
      const b = new Uint8Array(65);
      crypto.getRandomValues(b);
      b[0] = 4;
      return b;
    })(),
    thumbprint: (Math.random().toString(36).slice(2) + 'A'.repeat(43)).slice(0, 43),
    scopes_json: '["st"]',
    status: 'pending',
    proposed_by_kind: 'member',
    proposed_by: 'usr_a',
    proposer_sub: 'sub-a',
    proposer_email_key: 'a@a.example',
    proposed_at: now,
    four_eyes: 0,
    min_delay_ms: 86_400_000,
    request_id: `r_${Math.random()}`,
    ...o,
  };
  const cols = Object.keys(row);
  return refusal(`INSERT INTO platform_keys (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => row[c])).then((r) => ({ r, id: row.id as string }));
};

const DB_NOW = async (): Promise<number> => (await db.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t").first<{ t: number }>())!.t;

describe('migration 0028_platform_keys', () => {
  it('keeps every row and every schema object of before; adds only the two tables, their indexes and triggers', async () => {
    for (const t of KEPT_TABLES) expect(await rowsOf(t), t).toEqual(beforeRows[t]);
    const after = await schema();
    for (const [name, b] of before) expect(after.get(name), name).toEqual(b);
    const added = [...after.values()].filter((o) => !before.has(o.name));
    expect(new Set(added.map((o) => o.tbl_name))).toEqual(new Set([...NEW_TABLES, 'd1_migrations'].filter((t) => added.some((o) => o.tbl_name === t))));
    expect(added.filter((o) => o.type === 'table').map((o) => o.name).sort()).toEqual(NEW_TABLES);
    expect(added.filter((o) => o.type === 'index' && !o.name.startsWith('sqlite_autoindex_')).map((o) => o.name).sort()).toEqual(['platform_keys_due', 'platform_keys_expiry', 'platform_keys_org', 'platform_keys_unnotified']);
    expect(added.filter((o) => o.type === 'trigger').map((o) => o.name).sort()).toEqual([
      'platform_keys_active_on_time',
      'platform_keys_announced_now',
      'platform_keys_confirm_fixed',
      'platform_keys_fixed',
      'platform_keys_insert',
      'platform_keys_no_early_delete',
      'platform_keys_no_replace_update',
      'platform_keys_not_early',
      'platform_keys_status_moves',
      'platform_orgs_insert',
      'platform_orgs_switch_on',
    ]);
  });

  it('no new trigger reads the ledger’s tables (ledger-check and 0027’s readers are untouched)', async () => {
    const after = await schema();
    for (const o of after.values()) {
      if (before.has(o.name) || o.type !== 'trigger') continue;
      for (const t of ['app_changes', 'guarded_changes', 'security_events']) expect(o.sql!.includes(t), `${o.name} reads ${t}`).toBe(false);
    }
  });

  it('the CHECK lists are console-core’s', async () => {
    const sql = (await schema()).get('platform_keys')!.sql!;
    const list = (col: string) => [...new RegExp(`${col}\\s+TEXT[^,]*?CHECK \\(${col} IN \\(([^)]*)\\)\\)`, 'u').exec(sql)![1]!.matchAll(/'([^']*)'/gu)].map((m) => m[1]);
    expect(list('status')).toEqual([...PLATFORM_KEY_STATUSES]);
    expect(list('proposed_by_kind')).toEqual([...PLATFORM_KEY_ACTOR_KINDS]);
    expect(list('accepted_by_kind')).toEqual([...PLATFORM_KEY_ACTOR_KINDS]);
    expect(list('confirmed_kind')).toEqual([...PLATFORM_KEY_CONFIRM_KINDS]);
  });

  it('a key is a test scope’s of its own org, named once, starting as its registrant left it', async () => {
    expect((await insertKey()).r).toBe('accepted');
    expect((await insertKey({ scopes_json: '["st", "st2"]' })).r).toBe('accepted');
    expect((await insertKey({ scopes_json: '["sl"]' })).r).toMatch(/test scope of this org/u);
    expect((await insertKey({ scopes_json: '["sb"]' })).r).toMatch(/test scope of this org/u);
    expect((await insertKey({ scopes_json: '["st", "st"]' })).r).toMatch(/named once/u);
    expect((await insertKey({ scopes_json: '["st", "st2", "sb"]' })).r).toMatch(/CHECK|test scope/u);
    expect((await insertKey({ scopes_json: '[]' })).r).toMatch(/CHECK/u);
    expect((await insertKey({ scopes_json: '[1]' })).r).toMatch(/test scope/u);
    expect((await insertKey({ status: 'active', activated_recorded_at: now })).r).toMatch(/starts waiting/u);
    expect((await insertKey({ proposed_by_kind: 'hana', proposer_sub: null, proposal_note: 'phone', proposer_email: 's@h.example' })).r).toMatch(/starts waiting|awaiting/u);
    expect((await insertKey({ proposed_by_kind: 'hana', proposer_sub: null, proposal_note: 'phone', status: 'awaiting_acceptance' })).r).toBe('accepted');
    expect((await insertKey({ proposed_by_kind: 'hana', proposer_sub: null, status: 'awaiting_acceptance' })).r).toMatch(/CHECK/u); // no note
    expect((await insertKey({ proposer_sub: null })).r).toMatch(/CHECK/u); // a member without a step-up
    expect((await insertKey({ alg: 'RS256' })).r).toMatch(/CHECK/u);
    expect((await insertKey({ public_key: new Uint8Array(64) })).r).toMatch(/CHECK/u);
    expect((await insertKey({ public_key: new Uint8Array(65) })).r).toMatch(/CHECK/u); // not uncompressed (0x04)
    expect((await insertKey({ thumbprint: 'short' })).r).toMatch(/CHECK/u);
    expect((await insertKey({ label: 'x'.repeat(41) })).r).toMatch(/CHECK/u);
    expect((await insertKey({ four_eyes: 1, min_delay_ms: 60_000 })).r).toMatch(/CHECK/u);
    expect((await insertKey({ min_delay_ms: 1000 })).r).toMatch(/CHECK/u);
    expect((await insertKey({ notified_at: now })).r).toMatch(/CHECK|starts waiting/u);
    // One public key, one thumbprint, across every org.
    const k = await insertKey({ public_key: point, thumbprint: 'T'.repeat(43) });
    expect(k.r).toBe('accepted');
    expect((await insertKey({ public_key: point })).r).toMatch(/never replaced/u);
    expect((await insertKey({ thumbprint: 'T'.repeat(43) })).r).toMatch(/never replaced/u);
  });

  it('a key, its registrant, its four-eyes mark and its wait are fixed; it only moves forward; it is kept 60 months after it stopped', async () => {
    const { id } = await insertKey();
    for (const set of ["label = 'other'", "scopes_json = '[\"st2\"]'", "proposed_by = 'usr_b'", 'four_eyes = 1', 'min_delay_ms = 90000000', "org_id = 'org_b'", "thumbprint = '" + 'Z'.repeat(43) + "'"]) {
      expect(await refusal(`UPDATE platform_keys SET ${set} WHERE id = ?1`, id), set).toMatch(/never changed/u);
    }
    expect(await refusal('DELETE FROM platform_keys WHERE id = ?1', id)).toMatch(/kept 60 months/u);
    expect(await refusal("UPDATE platform_keys SET status = 'cancelled', cancelled_at = ?2, cancelled_by_kind = 'member', cancelled_by = 'usr_a' WHERE id = ?1", id, now)).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET status = 'pending', cancelled_at = NULL WHERE id = ?1", id)).toMatch(/never comes back/u);
    expect(await refusal('DELETE FROM platform_keys WHERE id = ?1', id)).toMatch(/kept 60 months/u);
    const old = await insertKey({ proposed_at: 1 });
    expect(await refusal("UPDATE platform_keys SET status = 'cancelled', cancelled_at = 2, cancelled_by_kind = 'system', cancelled_by = 'cron' WHERE id = ?1", old.id)).toBe('accepted');
    expect(await refusal('DELETE FROM platform_keys WHERE id = ?1', old.id)).toBe('accepted');
  });

  it('a key is in force only once announced, early only when confirmed, and four eyes holds in the table', async () => {
    const { id } = await insertKey({ four_eyes: 1 });
    expect(await refusal('UPDATE platform_keys SET active_from = ?2, expires_at = ?3 WHERE id = ?1', id, now, now + 1)).toMatch(/CHECK/u);
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3 WHERE id = ?1', id, now, now + 1000)).toMatch(/CHECK|back-dated/u); // shorter than its wait
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4 WHERE id = ?1', id, now, now + 86_400_000, now + 2 * 86_400_000)).toBe('accepted');
    expect(await refusal('UPDATE platform_keys SET active_from = ?2 WHERE id = ?1', id, now + 1)).toMatch(/early only when confirmed/u);
    expect(await refusal('UPDATE platform_keys SET unconfirmed_active_from = ?2 WHERE id = ?1', id, now + 90_000_000)).toMatch(/early only when confirmed/u);
    const confirm = (by: string, sub: string, mail: string) =>
      refusal("UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = ?2, confirmed_sub = ?3, confirmed_email_key = ?4, confirmed_at = ?5, active_from = ?5, status = 'active', activated_recorded_at = ?5 WHERE id = ?1", id, by, sub, mail, now + 5);
    expect(await confirm('usr_a', 'sub-b', 'b@a.example')).toMatch(/CHECK/u);
    expect(await confirm('usr_b', 'sub-a', 'b@a.example')).toMatch(/CHECK/u);
    expect(await confirm('usr_b', 'sub-b', 'a@a.example')).toMatch(/CHECK/u);
    expect(await refusal("UPDATE platform_keys SET confirmed_kind = 'acceptance', confirmed_by = 'usr_b', confirmed_sub = 'sub-b', confirmed_at = 1 WHERE id = ?1", id)).toMatch(/written once|CHECK/u);
    expect(await confirm('usr_b', 'sub-b', 'b@a.example')).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET confirmed_by = 'usr_c' WHERE id = ?1", id)).toMatch(/written once/u);
    expect(await refusal("UPDATE platform_keys SET status = 'pending' WHERE id = ?1", id)).toMatch(/never comes back/u);
  });

  it('a staff key is usable only once accepted by a member or approved by another staff member, each once', async () => {
    const { id } = await insertKey({ proposed_by_kind: 'hana', proposed_by: 'staff-1', proposer_sub: null, proposer_email_key: 's1@h.example', proposer_email: 's1@h.example', proposal_note: 'phone', status: 'awaiting_acceptance' });
    expect(await refusal("UPDATE platform_keys SET status = 'pending' WHERE id = ?1", id)).toMatch(/CHECK/u);
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = 'staff-1', accepted_email_key = 's9@h.example', accept_note = 'x', accepted_at = 1 WHERE id = ?1", id)).toMatch(/CHECK/u);
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = 'staff-2', accepted_email_key = 's1@h.example', accept_note = 'x', accepted_at = 1 WHERE id = ?1", id)).toMatch(/CHECK/u);
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'member', accepted_by = 'usr_b', accepted_at = 1 WHERE id = ?1", id)).toMatch(/CHECK/u); // no sub
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = 'staff-2', accepted_email_key = 's2@h.example', accept_note = 'x', accepted_at = 1 WHERE id = ?1", id)).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET accepted_by = 'staff-3' WHERE id = ?1", id)).toMatch(/written once/u);
    // An acceptance as the confirmation is a member's own acceptance only.
    const m = await insertKey({ proposed_by_kind: 'hana', proposed_by: 'staff-1', proposer_sub: null, proposal_note: 'phone', status: 'awaiting_acceptance' });
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'member', accepted_by = 'usr_b', accepted_sub = 'sub-b', accepted_at = 1, confirmed_kind = 'acceptance', confirmed_by = 'usr_c', confirmed_sub = 'sub-b', confirmed_at = 1 WHERE id = ?1", m.id)).toMatch(/CHECK/u);
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'member', accepted_by = 'usr_b', accepted_sub = 'sub-b', accepted_at = 1, confirmed_kind = 'acceptance', confirmed_by = 'usr_b', confirmed_sub = 'sub-b', confirmed_at = 1 WHERE id = ?1", m.id)).toBe('accepted');
    // A member's key is never "accepted".
    const own = await insertKey();
    expect(await refusal("UPDATE platform_keys SET accepted_by_kind = 'member', accepted_by = 'usr_b', accepted_sub = 's', accepted_at = 1 WHERE id = ?1", own.id)).toMatch(/CHECK|written once/u);
  });

  it('platform_orgs: one row per org, flags 0 or 1, sane quotas, defaults off', async () => {
    expect(await refusal("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_a', 's', 1)")).toBe('accepted');
    expect(await db.prepare("SELECT enabled, frozen, max_apps, creations_per_day, proposals_per_day, version FROM platform_orgs WHERE org_id = 'org_a'").first()).toEqual({ enabled: 0, frozen: 0, max_apps: 10, creations_per_day: 5, proposals_per_day: 30, version: 0 });
    expect(await refusal("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_a', 's', 1)")).toMatch(/never replaced/u);
    expect(await refusal("INSERT INTO platform_orgs (org_id, enabled, set_by, set_at) VALUES ('org_c', 2, 's', 1)")).toMatch(/CHECK/u);
    expect(await refusal("INSERT INTO platform_orgs (org_id, max_apps, set_by, set_at) VALUES ('org_d', -1, 's', 1)")).toMatch(/CHECK/u);
    expect(await refusal("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('nope', 's', 1)")).toMatch(/CHECK/u);
  });

  it('the database is whole, and applying the migrations again changes nothing', async () => {
    expect(await db.prepare('PRAGMA quick_check').all()).toMatchObject({ results: [{ quick_check: 'ok' }] });
    const names = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, env.TEST_MIGRATIONS.findIndex((m) => m.name === FILE) + 1));
    expect((await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name)).toEqual(names);
    expect(names).toContain(FILE);
  });
});

describe('0028 after PR 149’s review: no replace, no back-dating, the database’s clock, four eyes’ emails, the switch', () => {
  it('INSERT OR REPLACE never brings back a revoked key under its id, nor deletes a key by reusing its public key', async () => {
    const revoked = await insertKey();
    expect(await refusal("UPDATE platform_keys SET status = 'revoked', revoked_at = 1, revoked_by_kind = 'hana', revoked_by = 's' WHERE id = ?1", revoked.id)).toBe('accepted');
    const before = await db.prepare('SELECT * FROM platform_keys WHERE id = ?1').bind(revoked.id).first();
    const cols = 'id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id';
    const fresh = new Uint8Array(65).fill(9);
    fresh[0] = 4;
    // The same id, any public key: refused, the revoked row untouched.
    expect(await refusal(`INSERT OR REPLACE INTO platform_keys (${cols}) VALUES (?1, 'org_a', 'Back', 'ES256', ?2, ?3, '["st"]', 'pending', 'member', 'usr_x', 'sub-x', 'x@a.example', 1, 0, 86400000, 'r_replace_1')`, revoked.id, fresh, 'R'.repeat(43))).toMatch(/never replaced/u);
    expect(await refusal(`REPLACE INTO platform_keys (${cols}) VALUES (?1, 'org_a', 'Back', 'ES256', ?2, ?3, '["st"]', 'pending', 'member', 'usr_x', 'sub-x', 'x@a.example', 1, 0, 86400000, 'r_replace_2')`, revoked.id, fresh, 'Q'.repeat(43))).toMatch(/never replaced/u);
    expect(await db.prepare('SELECT * FROM platform_keys WHERE id = ?1').bind(revoked.id).first()).toEqual(before);
    // A new id with a key in force's public key, thumbprint or request id: refused, that row kept.
    const live = await insertKey();
    const row = (await db.prepare('SELECT public_key, thumbprint, request_id FROM platform_keys WHERE id = ?1').bind(live.id).first<{ public_key: ArrayBuffer; thumbprint: string; request_id: string }>())!;
    for (const [pk, tp, rid] of [
      [row.public_key, 'P'.repeat(43), 'r_x1'],
      [fresh, row.thumbprint, 'r_x2'],
      [fresh, 'O'.repeat(43), row.request_id],
    ] as const) {
      expect(await refusal(`INSERT OR REPLACE INTO platform_keys (${cols}) VALUES ('pkc_Newnewnewnew1', 'org_a', 'Thief', 'ES256', ?1, ?2, '["st"]', 'pending', 'member', 'usr_x', 'sub-x', 'x@a.example', 1, 0, 86400000, ?3)`, pk, tp, rid)).toMatch(/never replaced/u);
    }
    expect(await db.prepare('SELECT COUNT(*) AS n FROM platform_keys WHERE id = ?1').bind(live.id).first()).toEqual({ n: 1 });
    // An UPDATE OR REPLACE of a link hash onto another row's: refused, that row kept.
    const h = new Uint8Array(32).fill(3);
    expect(await refusal('UPDATE platform_keys SET cancel_token_hash = ?2 WHERE id = ?1', live.id, h)).toBe('accepted');
    const other = await insertKey();
    expect(await refusal('UPDATE OR REPLACE platform_keys SET cancel_token_hash = ?2 WHERE id = ?1', other.id, h)).toMatch(/never replaced/u);
    expect(await db.prepare('SELECT COUNT(*) AS n FROM platform_keys WHERE id = ?1').bind(live.id).first()).toEqual({ n: 1 });
  });

  it('an announcement is never back-dated, its unconfirmed date is at least its wait from the database’s now (2 min skew), and `active` needs its date or a confirmation', async () => {
    const now = await DB_NOW();
    const k = await insertKey({ four_eyes: 1 });
    // The review's write: back-dated two days, in force a day ago, recorded active, with four eyes.
    expect(await refusal("UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4, status = 'active', activated_recorded_at = ?3 WHERE id = ?1", k.id, now - 2 * 86_400_000, now - 86_400_000, now + 300 * 86_400_000)).toMatch(/back-dated/u);
    // Six minutes back: refused; a 24 h wait that would end in 23 h: refused.
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3 WHERE id = ?1', k.id, now - 360_000, now - 360_000 + 86_400_000)).toMatch(/back-dated/u);
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3 WHERE id = ?1', k.id, now, now + 23 * 3_600_000)).toMatch(/back-dated|CHECK/u);
    // A real announcement: then `active` before the date is refused without a confirmation.
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4 WHERE id = ?1', k.id, now, now + 86_400_000, now + 366 * 86_400_000)).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1", k.id, now)).toMatch(/only once its date has passed/u);
    // A short local* wait already passed (within the skew): accepted, then recorded active.
    const local = await insertKey({ min_delay_ms: 60_000 });
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4 WHERE id = ?1', local.id, now - 110_000, now - 50_000, now + 86_400_000)).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1", local.id, now)).toBe('accepted');
    // `active` with no date at all is refused by the CHECK.
    const bare = await insertKey();
    expect(await refusal("UPDATE platform_keys SET status = 'active', activated_recorded_at = 1 WHERE id = ?1", bare.id)).toMatch(/CHECK|date/u);
  });

  it('four eyes wants the confirmer’s email key and a staff approval’s; every registration records the registrant’s', async () => {
    const now = await DB_NOW();
    const k = await insertKey({ four_eyes: 1 });
    expect(await refusal('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4 WHERE id = ?1', k.id, now, now + 86_400_000, now + 366 * 86_400_000)).toBe('accepted');
    expect(await refusal("UPDATE platform_keys SET confirmed_kind = 'confirm', confirmed_by = 'usr_b', confirmed_sub = 'sub-b', confirmed_email_key = NULL, confirmed_at = ?2, active_from = ?2, status = 'active', activated_recorded_at = ?2 WHERE id = ?1", k.id, now)).toMatch(/CHECK/u);
    const s = await insertKey({ proposed_by_kind: 'hana', proposed_by: 'staff-1', proposer_sub: null, proposer_email_key: 's1@h.example', proposal_note: 'phone', status: 'awaiting_acceptance' });
    expect(await refusal("UPDATE platform_keys SET status = 'pending', accepted_by_kind = 'hana', accepted_by = 'staff-2', accepted_email_key = NULL, accept_note = 'x', accepted_at = 1 WHERE id = ?1", s.id)).toMatch(/CHECK/u);
    expect((await insertKey({ proposer_email_key: null })).r).toMatch(/CHECK/u);
  });

  it('platform_orgs: never replaced (the freeze kept), and the switch goes on only with the review of exactly the current keys, never while frozen', async () => {
    expect(await refusal("INSERT INTO platform_orgs (org_id, frozen, set_by, set_at) VALUES ('org_z', 1, 's', 1)")).toBe('accepted');
    expect(await refusal("INSERT OR REPLACE INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_z', 's', 2)")).toMatch(/never replaced/u);
    expect(await db.prepare("SELECT frozen FROM platform_orgs WHERE org_id = 'org_z'").first()).toEqual({ frozen: 1 });
    expect(await refusal("INSERT INTO platform_orgs (org_id, enabled, set_by, set_at) VALUES ('org_y', 1, 's', 1)")).toMatch(/review/u);
    // org_a has keys from the tests above; the review must name exactly its live ones.
    expect(await refusal("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_b', 's', 1)")).toBe('accepted');
    expect(await refusal("UPDATE platform_orgs SET enabled = 1, set_at = ?1 WHERE org_id = 'org_b'", Date.now())).toMatch(/review/u); // no review recorded at all
    expect(await refusal("UPDATE platform_orgs SET enabled = 1, review_json = '[]', set_at = ?1 WHERE org_id = 'org_b'", Date.now())).toBe('accepted'); // org_b has no key: the review is []
    expect(await refusal("UPDATE platform_orgs SET enabled = 0 WHERE org_id = 'org_b'")).toBe('accepted');
    expect(await refusal("UPDATE platform_orgs SET enabled = 1, review_json = '[\"pkc_nothing\"]', set_at = ?1 WHERE org_id = 'org_b'", Date.now())).toMatch(/review/u);
    const live = (await db.prepare("SELECT json_group_array(id) AS j FROM (SELECT id FROM platform_keys WHERE org_id = 'org_a' AND status IN ('awaiting_acceptance', 'pending', 'active') AND (expires_at IS NULL OR expires_at > ?1) ORDER BY id)").bind(Date.now()).first<{ j: string }>())!.j;
    expect(await refusal("UPDATE platform_orgs SET enabled = 1, review_json = '[]', set_at = ?1 WHERE org_id = 'org_a'", Date.now())).toMatch(/review/u);
    expect(await refusal('UPDATE platform_orgs SET enabled = 1, review_json = ?2, set_at = ?1 WHERE org_id = ?3', Date.now(), live, 'org_a')).toBe('accepted');
    expect(await refusal("UPDATE platform_orgs SET enabled = 0, frozen = 1 WHERE org_id = 'org_a'")).toBe('accepted');
    expect(await refusal('UPDATE platform_orgs SET enabled = 1, review_json = ?2, set_at = ?1 WHERE org_id = ?3', Date.now(), live, 'org_a')).toMatch(/review/u);
  });
});
