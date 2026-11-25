// Migration 0034 (D931, piece P10 of docs/partner-platform-spec.md, A7, A15; D914, D917): additive. Applied to a
// database holding rows in every table around it (every migration before it): every row and every schema object of
// before is there after, unchanged (asked of `sqlite_schema`: every table, index, trigger and view of the whole schema),
// but for exactly the three earliest-time triggers of 0033 it replaces; only its own tables, indexes and triggers are
// new; the ledger tables keep their shape. Then every rule against bare D1 writes: without a recorded confirmation no
// web address the platform (or staff, on a shared wallet) proposed comes into force a millisecond early, through
// `guarded_changes` or `app_origins`, by any update, insert or replace; a confirmation row is refused without its
// confirmer's ledger row, by its proposer, for any other kind or state (unannounced, in force, cancelled, a member's
// proposal, a staff proposal before 0034), when the key no longer works, the switch is off, the org is frozen, the app
// is deleted or suspended by Journear, or the app has left the key's reach; one per change, never replaced, fixed,
// its notice written once; a staff confirmer never the proposer by Access subject or by email; a staff proposal on a
// shared wallet never without its wait, never waived, never early. Applying it again changes nothing; every trigger it
// creates is there after the last migration, with its SQL (a later migration that adds one names it in `LATER`).
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.FRESH_DB;
const FILE = '0034_origin_confirmations.sql';
const DAY = 86_400_000;
const YEAR = 31_536_000_000;
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
const KEPT = ['scopes', 'apps', 'app_origins', 'app_keys', 'app_changes', 'guarded_changes', 'platform_keys', 'platform_orgs', 'platform_origin_waits', 'platform_requests', 'org_security_contacts'];
const rowsOf = async (t: string) => (await db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()).results;
const DB_NOW = async (): Promise<number> => (await db.prepare("SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS t").first<{ t: number }>())!.t;

/** Every trigger 0034 creates (or creates again), as its header lists them: a later rebuild of their tables must create each again. */
const TRIGGERS_0034 = [
  'origin_confirmations_insert',
  'origin_confirmations_update',
  'origin_confirmations_no_delete',
  'staff_origin_waits_insert',
  'staff_origin_waits_update',
  'staff_origin_waits_no_delete',
  'guarded_changes_second_person_insert',
  'guarded_changes_second_person_no_replace',
  'guarded_changes_second_person_update',
  'guarded_changes_second_person_no_replace_update',
  'guarded_changes_second_person_no_delete',
  'guarded_changes_confirmation_gone',
  'guarded_changes_platform_not_early',
  'app_origins_platform_not_early',
  'app_origins_platform_not_early_update',
] as const;
/** 0033's triggers 0034 replaces: dropped and created again under the same name. */
const REPLACED = ['guarded_changes_platform_not_early', 'app_origins_platform_not_early', 'app_origins_platform_not_early_update'];
const NEW = ['origin_confirmations', 'origin_confirmations_request', 'origin_confirmations_unnoticed', 'origin_confirmations_recent', 'staff_origin_waits', ...TRIGGERS_0034.filter((t) => !REPLACED.includes(t))];

let before: Map<string, Obj>;
let beforeRows: Record<string, unknown[]>;
let beforeCols: Record<string, string[]>;
let t0 = 0;

/** A member's key in force at once by the 0028 rules: registered, announced 110 s ago with a 60 s wait, recorded active. */
async function keyInForce(id: string, n: number, scopes: string[]) {
  const pk = new Uint8Array(65).fill(n);
  pk[0] = 4;
  await run(
    "INSERT INTO platform_keys (id, org_id, label, alg, public_key, thumbprint, scopes_json, status, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposed_at, four_eyes, min_delay_ms, request_id) VALUES (?1, 'org_a', 'K', 'ES256', ?2, ?3, ?4, 'pending', 'member', 'usr_reg', 'sub-reg', 'reg@a.example', ?5, 0, 60000, ?6)",
    id,
    pk,
    String.fromCharCode(64 + n).repeat(43),
    JSON.stringify(scopes),
    t0 - 200_000,
    `r_${id}`,
  );
  await run('UPDATE platform_keys SET notified_at = ?2, unconfirmed_active_from = ?3, active_from = ?3, expires_at = ?4 WHERE id = ?1', id, t0 - 110_000, t0 - 50_000, t0 - 50_000 + YEAR);
  await run("UPDATE platform_keys SET status = 'active', activated_recorded_at = ?2 WHERE id = ?1", id, t0);
}

/** A platform proposal on `app`, its wait written, then (unless `announce` is false) announced now with a day's wait. */
async function platformProposal(id: string, o: { app?: string; key?: string; announce?: boolean; request?: string } = {}) {
  const app = o.app ?? 'app_p';
  const key = o.key ?? 'pkc_Kkkkkkkkkkkkkk';
  const origin = `https://${id}.example`;
  await run('INSERT INTO platform_origin_waits (change_id, app_id, origin, key_id, min_delay_ms, at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)', id, app, origin, key, DAY, t0);
  await run("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES (?1, ?2, 'origin_add', ?3, 'pending', 'platform', ?4, ?5, ?6)", id, app, origin, key, t0, o.request ?? `pf_${id}`);
  await run('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)', app, origin, id);
  if (o.announce === false) return origin;
  const now = await DB_NOW();
  await run('UPDATE platform_origin_waits SET unconfirmed_active_from = ?2 WHERE change_id = ?1', id, now + DAY);
  await run('UPDATE guarded_changes SET notified_at = ?2, active_from = ?3 WHERE id = ?1', id, now, now + DAY);
  await run('UPDATE app_origins SET active_from = ?2 WHERE change_id = ?1', id, now + DAY);
  return origin;
}

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  t0 = await DB_NOW();
  // A shared wallet (st), a plain test scope (su), a live one (sl); a platform-created app and a staff one on the shared
  // wallet, a staff app on the plain scope.
  await run("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at, app_user_ids) VALUES ('st', 'org_a', 'test', 1, 1, 1, 1), ('su', 'org_a', 'test', 1, 1, 1, 0), ('sl', 'org_a', 'live', 1, 1, 1, 0)");
  await run(
    "INSERT INTO apps (id, name, scope_id, org_id, publishable_key, created_by_kind, user_ids) VALUES ('app_p', 'P', 'st', 'org_a', 'pk_test_Pppppppppppppppppppppp', 'platform', 'app'), ('app_h', 'H', 'st', 'org_a', 'pk_test_Hhhhhhhhhhhhhhhhhhhhhh', 'hana', 'app'), ('app_s', 'S', 'su', 'org_a', 'pk_test_Sssssssssssssssssssssss', 'hana', 'scope')",
  );
  await run("INSERT INTO org_security_contacts (org_id, email, added_by, added_at) VALUES ('org_a', 's@a.example', 't', 1)");
  await keyInForce('pkc_Kkkkkkkkkkkkkk', 5, ['st']);
  await keyInForce('pkc_Rrrrrrrrrrrrrr', 6, ['st']);
  await run("INSERT INTO platform_orgs (org_id, set_by, set_at) VALUES ('org_a', 's', 1)");
  await run("UPDATE platform_orgs SET enabled = 1, review_json = ?1 WHERE org_id = 'org_a'", JSON.stringify(['pkc_Kkkkkkkkkkkkkk', 'pkc_Rrrrrrrrrrrrrr']));
  await run("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (1, 'org_a', 'app_p', 'app.created', '{}', 'platform', 'pkc_Kkkkkkkkkkkkkk', 'pf_created')");
  // A platform proposal announced before 0034, and a staff proposal on the shared wallet written before 0034 (no wait).
  await platformProposal('gc_p33');
  await run("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, request_id) VALUES ('gc_h33', 'app_h', 'origin_add', 'https://h33.example', 'pending', 'hana', 'staff-1', 1, 'r_h33')");
  await run("INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_h', 'https://h33.example', NULL, 'gc_h33')");
  before = await schema();
  beforeRows = Object.fromEntries(await Promise.all(KEPT.map(async (t) => [t, await rowsOf(t)])));
  beforeCols = Object.fromEntries(await Promise.all(['apps', 'guarded_changes', 'app_changes', 'app_origins', 'security_events'].map(async (t) => [t, (await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name)])));
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

/** A confirmation row with its defaults (a member, on gc_p33 unless told), as a bare insert. */
const confirmRow = (o: Record<string, unknown> = {}) => {
  const r: Record<string, unknown> = {
    change_id: 'gc_p33',
    app_id: 'app_p',
    origin: 'https://gc_p33.example',
    proposal_request_id: 'pf_gc_p33',
    request_id: 'rq_c1',
    confirmed_by_kind: 'member',
    confirmed_by: 'usr_owner',
    confirmed_sub: 'sub-owner',
    confirmed_email_key: 'owner@a.example',
    token_sha256: 'a'.repeat(64),
    confirmed_at: Date.now(),
    ...o,
  };
  const cols = Object.keys(r);
  return refusal(`INSERT INTO origin_confirmations (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
};
/** The confirmer's ledger row (`origin.confirmed`), as the confirmation's batch writes it first. */
const ledgerRow = (requestId: string, appId: string, kind: 'member' | 'hana', id: string, sub: string | null) =>
  run("INSERT INTO app_changes (at, org_id, app_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id) VALUES (?1, 'org_a', ?2, 'origin.confirmed', '{}', ?3, ?4, ?5, ?6)", Date.now(), appId, kind, id, sub, requestId);
const ONLY = /only a waiting, announced web address/u;
const EARLY = /no earlier than its wait allows/u;

describe('migration 0034_origin_confirmations', () => {
  it('every table, index, trigger and view of before is there with the same SQL, but the three of 0033 it replaces; only its own objects are new; the ledger’s tables keep their shape', async () => {
    const after = await schema();
    for (const [name, o] of before) {
      if (REPLACED.includes(name)) continue;
      expect(after.get(name), name).toEqual(o);
    }
    for (const name of REPLACED) {
      expect(after.get(name)?.type, name).toBe('trigger');
      expect(after.get(name)?.tbl_name, name).toBe(before.get(name)!.tbl_name);
      expect(after.get(name)?.sql, name).not.toBe(before.get(name)!.sql);
      expect(after.get(name)?.sql, name).toMatch(/origin_confirmations/u);
    }
    expect([...after.keys()].filter((k) => !before.has(k)).sort()).toEqual([...NEW].sort());
    // `ledger-check` (0027's deploy step) holds the ledger's tables to their shape: 0034 adds none of their columns.
    for (const t of ['apps', 'guarded_changes', 'app_changes', 'app_origins', 'security_events']) {
      expect((await db.prepare(`SELECT name FROM pragma_table_info('${t}')`).all<{ name: string }>()).results.map((r) => r.name), t).toEqual(beforeCols[t]);
    }
  });

  it('every row is as it was; the new tables are empty', async () => {
    for (const t of KEPT) expect(await rowsOf(t), t).toEqual(beforeRows[t]);
    for (const t of ['origin_confirmations', 'staff_origin_waits']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first(), t).toEqual({ n: 0 });
  });

  it('without a recorded confirmation, no bare write brings a platform web address in early: guarded_changes or app_origins, update, insert or replace', async () => {
    const g = (await db.prepare("SELECT active_from FROM guarded_changes WHERE id = 'gc_p33'").first<{ active_from: number }>())!.active_from;
    const now = Date.now();
    for (const [what, sql, args] of [
      ['the change now', "UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_p33'", [now]],
      ['the change a millisecond early', "UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_p33'", [g - 1]],
      ['the gate now', "UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_p33'", [now]],
      ['the gate with its change id cleared', "UPDATE app_origins SET active_from = ?1, change_id = NULL WHERE change_id = 'gc_p33'", [now]],
      ['the gate replaced', "INSERT OR REPLACE INTO app_origins (app_id, origin, active_from) VALUES ('app_p', 'https://gc_p33.example', ?1)", [now]],
      ['the gate upserted', "INSERT INTO app_origins (app_id, origin, active_from) VALUES ('app_p', 'https://gc_p33.example', ?1) ON CONFLICT DO UPDATE SET active_from = excluded.active_from", [now]],
    ] as const) {
      expect(await refusal(sql, ...args), what).toMatch(EARLY);
    }
    // Its own time still works (as 0033's did).
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_p33'", g)).toBe('accepted');
  });

  it('a confirmation row: only with its confirmer’s ledger row, now by the database’s clock, with no notice yet, of a waiting announced platform web address, by a member', async () => {
    await ledgerRow('rq_c1', 'app_p', 'member', 'usr_owner', 'sub-owner');
    expect(await confirmRow({ request_id: 'rq_none' })).toMatch(/no ledger row/u);
    expect(await confirmRow({ confirmed_by: 'usr_other' })).toMatch(/no ledger row/u);
    expect(await confirmRow({ confirmed_sub: 'sub-other' })).toMatch(/no ledger row/u);
    expect(await confirmRow({ app_id: 'app_h' })).toMatch(/no ledger row|only a waiting/u);
    expect(await confirmRow({ confirmed_at: Date.now() - 10 * 60_000 })).toMatch(/never back-dated/u);
    expect(await confirmRow({ notice_at: Date.now(), removal_token_hash: new Uint8Array(32), removal_until: Date.now() + 7 * DAY })).toMatch(/no notice/u);
    expect(await confirmRow({ confirmed_sub: null })).toMatch(/CHECK|no ledger row/u);
    expect(await confirmRow({ token_sha256: null })).toMatch(/CHECK/u);
    expect(await confirmRow({ token_sha256: 'Z'.repeat(64) })).toMatch(/CHECK/u);
    expect(await confirmRow({ reason: 'x'.repeat(25) })).toMatch(/CHECK/u);
    // Another origin, another proposing request: not this change.
    expect(await confirmRow({ origin: 'https://other.example' })).toMatch(ONLY);
    expect(await confirmRow({ proposal_request_id: 'pf_other' })).toMatch(ONLY);
    // Staff never confirm a platform proposal (only an owner does, in the partner portal).
    await ledgerRow('rq_staff_p', 'app_p', 'hana', 'staff-2', null);
    expect(await confirmRow({ request_id: 'rq_staff_p', confirmed_by_kind: 'hana', confirmed_by: 'staff-2', confirmed_sub: null, token_sha256: null, reason: 'Checked with the network by phone today' })).toMatch(ONLY);
    // The proposer itself (the key's id as a confirmer) never.
    await ledgerRow('rq_self', 'app_p', 'member', 'pkc_Kkkkkkkkkkkkkk', 'sub-owner');
    expect(await confirmRow({ request_id: 'rq_self', confirmed_by: 'pkc_Kkkkkkkkkkkkkk' })).toMatch(ONLY);
    // Not yet announced: never.
    await platformProposal('gc_p_unannounced', { announce: false });
    await ledgerRow('rq_un', 'app_p', 'member', 'usr_owner', 'sub-owner');
    expect(await confirmRow({ change_id: 'gc_p_unannounced', origin: 'https://gc_p_unannounced.example', proposal_request_id: 'pf_gc_p_unannounced', request_id: 'rq_un' })).toMatch(ONLY);
  });

  it('accepted once for the right change; then the change and its gate row may move to the confirmation’s time and no earlier; never twice, never replaced, fixed; its notice once, for 7 days; kept while its change exists', async () => {
    const at = Date.now();
    expect(await confirmRow({ confirmed_at: at })).toBe('accepted');
    expect(await confirmRow({ confirmed_at: at })).toMatch(/confirmed once|UNIQUE/u);
    expect(await refusal('INSERT OR REPLACE INTO origin_confirmations (change_id, app_id, origin, proposal_request_id, request_id, confirmed_by_kind, confirmed_by, confirmed_sub, confirmed_email_key, token_sha256, confirmed_at) SELECT change_id, app_id, origin, proposal_request_id, request_id, confirmed_by_kind, confirmed_by, confirmed_sub, confirmed_email_key, ?1, confirmed_at FROM origin_confirmations WHERE change_id = ?2', 'b'.repeat(64), 'gc_p33')).toMatch(/confirmed once/u);
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_p33'", at - 1)).toMatch(EARLY);
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_p33'", at - 1)).toMatch(EARLY);
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_p33'", at)).toBe('accepted');
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_p33'", at)).toBe('accepted');
    // Fixed once written: every column but the notice's.
    for (const set of ["confirmed_by = 'usr_x'", "confirmed_sub = 'x'", 'confirmed_at = confirmed_at - 1', "token_sha256 = '" + 'c'.repeat(64) + "'", "request_id = 'rq_x'", "change_id = 'gc_x'", "origin = 'https://x.example'", "confirmed_email_key = 'x@x.example'", "step_up_id = 'act_x'"]) {
      expect(await refusal(`UPDATE origin_confirmations SET ${set} WHERE change_id = 'gc_p33'`), set).toMatch(/is fixed/u);
    }
    // The notice: its hash and exactly 7 days, once, not back-dated.
    const n = Date.now();
    expect(await refusal("UPDATE origin_confirmations SET notice_at = ?1, removal_token_hash = ?2, removal_until = ?3 WHERE change_id = 'gc_p33'", n, new Uint8Array(32).fill(1), n + 8 * DAY)).toMatch(/CHECK/u);
    expect(await refusal("UPDATE origin_confirmations SET notice_at = ?1, removal_token_hash = ?2, removal_until = ?3 WHERE change_id = 'gc_p33'", n - 10 * 60_000, new Uint8Array(32).fill(1), n - 10 * 60_000 + 7 * DAY)).toMatch(/is fixed/u);
    expect(await refusal("UPDATE origin_confirmations SET notice_at = ?1, removal_token_hash = ?2 WHERE change_id = 'gc_p33'", n, new Uint8Array(32).fill(1))).toMatch(/CHECK/u);
    expect(await refusal("UPDATE origin_confirmations SET notice_at = ?1, removal_token_hash = ?2, removal_until = ?3 WHERE change_id = 'gc_p33'", n, new Uint8Array(32).fill(1), n + 7 * DAY)).toBe('accepted');
    expect(await refusal("UPDATE origin_confirmations SET notice_at = ?1, removal_token_hash = ?2, removal_until = ?3 WHERE change_id = 'gc_p33'", n + 1, new Uint8Array(32).fill(2), n + 1 + 7 * DAY)).toMatch(/is fixed/u);
    expect(await refusal('DELETE FROM origin_confirmations')).toMatch(/kept while its change exists/u);
    // In force now, it can't be confirmed again by anyone.
    await ledgerRow('rq_c2', 'app_p', 'member', 'usr_owner', 'sub-owner');
    expect(await confirmRow({ request_id: 'rq_c2', token_sha256: 'd'.repeat(64) })).toMatch(/confirmed once/u);
  });

  it('one fresh sign-in confirms one set: the same token under another request is refused', async () => {
    await platformProposal('gc_t1', { request: 'pf_t' });
    await platformProposal('gc_t2', { request: 'pf_t2' });
    const token = 'e'.repeat(64);
    await ledgerRow('rq_t1', 'app_p', 'member', 'usr_owner', 'sub-owner');
    await ledgerRow('rq_t2', 'app_p', 'member', 'usr_owner', 'sub-owner');
    expect(await confirmRow({ change_id: 'gc_t1', origin: 'https://gc_t1.example', proposal_request_id: 'pf_t', request_id: 'rq_t1', token_sha256: token })).toBe('accepted');
    expect(await confirmRow({ change_id: 'gc_t2', origin: 'https://gc_t2.example', proposal_request_id: 'pf_t2', request_id: 'rq_t2', token_sha256: token })).toMatch(/one fresh sign-in confirms one set/u);
  });

  it('refused once the key is revoked, the switch is off, the org is frozen, the app is suspended by Journear or deleted, or left the key’s reach', async () => {
    const ok = async (id: string, rid: string) => confirmRow({ change_id: id, origin: `https://${id}.example`, proposal_request_id: `pf_${id}`, request_id: rid, token_sha256: rid.padEnd(64, '0').replace(/[^0-9a-f]/gu, 'f').slice(0, 64) });
    await platformProposal('gc_rev', { key: 'pkc_Rrrrrrrrrrrrrr' });
    await platformProposal('gc_state');
    await ledgerRow('rq_rev', 'app_p', 'member', 'usr_owner', 'sub-owner');
    await run("UPDATE platform_keys SET status = 'revoked', revoked_at = ?1, revoked_by_kind = 'hana', revoked_by = 's' WHERE id = 'pkc_Rrrrrrrrrrrrrr'", Date.now());
    expect(await ok('gc_rev', 'rq_rev')).toMatch(ONLY);
    const tries: [string, string, string][] = [
      ['switch off', "UPDATE platform_orgs SET enabled = 0 WHERE org_id = 'org_a'", "UPDATE platform_orgs SET enabled = 1, review_json = '[\"pkc_Kkkkkkkkkkkkkk\"]' WHERE org_id = 'org_a'"],
      ['frozen', "UPDATE platform_orgs SET frozen = 1, frozen_at = 1 WHERE org_id = 'org_a'", "UPDATE platform_orgs SET frozen = 0 WHERE org_id = 'org_a'"],
      ['suspended by Journear', "UPDATE apps SET suspended_by = 1 WHERE id = 'app_p'", "UPDATE apps SET suspended_by = 0 WHERE id = 'app_p'"],
      ['the org suspended by Journear', "UPDATE apps SET suspended_by = 2 WHERE id = 'app_p'", "UPDATE apps SET suspended_by = 0 WHERE id = 'app_p'"],
    ];
    let k = 0;
    for (const [what, set, back] of tries) {
      if (!back) continue;
      const rid = `rq_state_${k++}`;
      await ledgerRow(rid, 'app_p', 'member', 'usr_owner', 'sub-owner');
      await run(set);
      expect(await ok('gc_state', rid), what).toMatch(ONLY);
      await run(back);
    }
    // A partner's own suspension (bit 4) doesn't stop a confirmation.
    await run("UPDATE apps SET suspended_by = 4, partner_bit_by = 'member' WHERE id = 'app_p'");
    await ledgerRow('rq_state_ok', 'app_p', 'member', 'usr_owner', 'sub-owner');
    expect(await ok('gc_state', 'rq_state_ok')).toBe('accepted');
    await run("UPDATE apps SET suspended_by = 0, partner_bit_by = NULL WHERE id = 'app_p'");
    // Outside the key's reach (an app the platform didn't create, on a scope the key doesn't name): refused.
    await platformProposal('gc_reach', { app: 'app_s' });
    await ledgerRow('rq_reach', 'app_s', 'member', 'usr_owner', 'sub-owner');
    expect(await confirmRow({ change_id: 'gc_reach', app_id: 'app_s', origin: 'https://gc_reach.example', proposal_request_id: 'pf_gc_reach', request_id: 'rq_reach', token_sha256: '9'.repeat(64) })).toMatch(ONLY);
    // Deleted: refused.
    await platformProposal('gc_del');
    await ledgerRow('rq_del', 'app_p', 'member', 'usr_owner', 'sub-owner');
    await run("UPDATE apps SET deleted_at = 1 WHERE id = 'app_p'");
    expect(await ok('gc_del', 'rq_del')).toMatch(ONLY);
    await run("UPDATE apps SET deleted_at = NULL WHERE id = 'app_p'");
  });

  it('a member’s proposal, a plain staff proposal and a staff proposal written before 0034 are never confirmable', async () => {
    await run("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, notified_at, active_from, request_id) VALUES ('gc_mem', 'app_s', 'origin_add', 'https://mem.example', 'pending', 'member', 'usr_m', 'sub-m', 1, ?1, ?2, 'r_mem')", Date.now(), Date.now() + DAY);
    await run("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, notified_at, active_from, request_id) VALUES ('gc_plain', 'app_s', 'origin_add', 'https://plain.example', 'pending', 'hana', 'staff-1', 1, ?1, ?2, 'r_plain')", Date.now(), Date.now() + DAY);
    await run("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_h33'", Date.now(), Date.now() + DAY);
    for (const [id, app, origin, request] of [['gc_mem', 'app_s', 'https://mem.example', 'r_mem'], ['gc_plain', 'app_s', 'https://plain.example', 'r_plain'], ['gc_h33', 'app_h', 'https://h33.example', 'r_h33']] as const) {
      const rid = `rq_${id}`;
      await ledgerRow(rid, app, 'member', 'usr_owner', 'sub-owner');
      expect(await confirmRow({ change_id: id, app_id: app, origin, proposal_request_id: request, request_id: rid, token_sha256: 'f'.repeat(63) + String(id.length % 10) }), id).toMatch(ONLY);
    }
    // Their own rules are unchanged: a plain staff proposal may still be brought in by a bare write (no four eyes there).
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_plain'", Date.now())).toBe('accepted');
  });

  it('a staff web address on a shared wallet or a platform-created app: never without its wait, never waived, announced once with its earliest time, never early, never back, never replaced or deleted while waiting', async () => {
    const add = (id: string, o: Record<string, unknown> = {}) => {
      const r: Record<string, unknown> = { id, app_id: 'app_h', kind: 'origin_add', origin: `https://${id}.example`, status: 'pending', proposed_by_kind: 'hana', proposed_by: 'staff-1', proposed_at: 1, request_id: `r_${id}`, ...o };
      const cols = Object.keys(r);
      return refusal(`INSERT INTO guarded_changes (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
    };
    const wait = (id: string, o: Record<string, unknown> = {}) => {
      const r: Record<string, unknown> = { change_id: id, app_id: 'app_h', origin: `https://${id}.example`, proposed_by: 'staff-1', proposer_email_key: 'staff1@hana.example', min_delay_ms: DAY, at: Date.now(), ...o };
      const cols = Object.keys(r);
      return refusal(`INSERT INTO staff_origin_waits (${cols.join(', ')}) VALUES (${cols.map((_, i) => `?${i + 1}`).join(', ')})`, ...cols.map((c) => r[c]));
    };
    const SP = /starts waiting with its wait/u;
    expect(await add('gc_sp_nowait')).toMatch(SP);
    expect(await add('gc_sp_p', { app_id: 'app_p' })).toMatch(SP);
    expect(await wait('gc_sp', { min_delay_ms: 59_999 })).toMatch(/CHECK/u);
    expect(await wait('gc_sp', { unconfirmed_active_from: Date.now() + DAY })).toMatch(/written once, before its proposal/u);
    expect(await wait('gc_h33', { origin: 'https://h33.example' })).toMatch(/written once, before its proposal/u);
    expect(await wait('gc_sp')).toBe('accepted');
    expect(await wait('gc_sp')).toMatch(/written once/u);
    for (const [what, o] of [
      ['another staff member', { proposed_by: 'staff-9' }],
      ['another origin', { origin: 'https://other.example' }],
      ['with a waiver', { waiver: 'no_session' }],
      ['announced at once', { notified_at: Date.now() }],
      ['in force at once', { active_from: Date.now() }],
      ['expedited', { expedited_by: 'x' }],
    ] as const) {
      expect(await add('gc_sp', o), what).toMatch(SP);
    }
    expect(await add('gc_sp')).toBe('accepted');
    await run("INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES ('app_h', 'https://gc_sp.example', NULL, 'gc_sp')");
    // Never replaced, whatever the new row says it is.
    expect(await refusal("INSERT OR REPLACE INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_id) VALUES ('gc_sp', 'app_s', 'origin_add', 'https://gc_sp.example', 'active', 'member', 'usr_m', 's', 1, 'r_x')")).toMatch(/never replaced/u);
    expect(await refusal("UPDATE OR REPLACE guarded_changes SET id = 'gc_sp' WHERE id = 'gc_plain'")).toMatch(/never replaced/u);
    // Announced only with its earliest time, at least its wait away, once; never back-dated.
    const now = Date.now();
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_sp'", now, now + DAY)).toMatch(/announced once/u);
    expect(await refusal("UPDATE staff_origin_waits SET unconfirmed_active_from = ?1 WHERE change_id = 'gc_sp'", now + DAY - 200_000)).toMatch(/only the earliest time/u);
    expect(await refusal("UPDATE staff_origin_waits SET proposer_email_key = 'x@x.example' WHERE change_id = 'gc_sp'")).toMatch(/only the earliest time/u);
    expect(await refusal("UPDATE staff_origin_waits SET unconfirmed_active_from = ?1 WHERE change_id = 'gc_sp'", now + DAY)).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_sp'", now - 400_000, now + DAY)).toMatch(/announced once/u);
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_sp'", now, now + DAY - 1)).toMatch(EARLY);
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1, active_from = ?2 WHERE id = 'gc_sp'", now, now + DAY)).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET notified_at = ?1 WHERE id = 'gc_sp'", now + 1)).toMatch(/announced once/u);
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_sp'", now)).toMatch(EARLY);
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_sp'", now + DAY)).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_sp'", now)).toMatch(EARLY);
    expect(await refusal("UPDATE guarded_changes SET waiver = 'no_session' WHERE id = 'gc_sp'")).toMatch(/no waiver/u);
    expect(await refusal("UPDATE guarded_changes SET expedited_by = 's', expedite_reason = 'x' WHERE id = 'gc_sp'")).toMatch(/no waiver/u);
    expect(await refusal("UPDATE guarded_changes SET status = 'active' WHERE id = 'gc_sp'")).toMatch(/only once its time has passed/u);
    for (const set of ["proposed_by = 'staff-9'", "origin = 'https://o.example'", "app_id = 'app_s'", "request_id = 'r_o'", "proposed_by_kind = 'member'"]) {
      expect(await refusal(`UPDATE guarded_changes SET ${set} WHERE id = 'gc_sp'`), set).toMatch(/keeps its web address/u);
    }
    expect(await refusal("DELETE FROM guarded_changes WHERE id = 'gc_sp'")).toMatch(/never deleted/u);
    expect(await refusal("DELETE FROM staff_origin_waits WHERE change_id = 'gc_sp'")).toMatch(/kept while its proposal exists/u);
    // A staff proposal on a plain scope needs none of it.
    expect(await refusal("INSERT INTO guarded_changes (id, app_id, kind, origin, status, proposed_by_kind, proposed_by, proposed_at, waiver, request_id) VALUES ('gc_plain2', 'app_s', 'origin_add', 'https://plain2.example', 'pending', 'hana', 's', 1, 'no_session', 'r_p2')")).toBe('accepted');
  });

  it('a staff proposal under four eyes: never confirmed by its proposer (by Access subject or by email), by another staff member or an owner yes; then in force at that time and no earlier', async () => {
    const base = { change_id: 'gc_sp', app_id: 'app_h', origin: 'https://gc_sp.example', proposal_request_id: 'r_gc_sp' };
    const staff = (rid: string, by: string, email: string) => confirmRow({ ...base, request_id: rid, confirmed_by_kind: 'hana', confirmed_by: by, confirmed_sub: null, token_sha256: null, confirmed_email_key: email, reason: 'Checked with the network by phone today' });
    await ledgerRow('rq_sp_self', 'app_h', 'hana', 'staff-1', null);
    expect(await staff('rq_sp_self', 'staff-1', 'other@hana.example')).toMatch(ONLY);
    await ledgerRow('rq_sp_twin', 'app_h', 'hana', 'staff-2', null);
    expect(await staff('rq_sp_twin', 'staff-2', 'staff1@hana.example')).toMatch(ONLY);
    // An owner (a member) with the proposing staff member's email: the same person, refused.
    await ledgerRow('rq_sp_member_twin', 'app_h', 'member', 'usr_twin', 'sub-twin');
    expect(await confirmRow({ ...base, request_id: 'rq_sp_member_twin', confirmed_by: 'usr_twin', confirmed_sub: 'sub-twin', confirmed_email_key: 'staff1@hana.example', token_sha256: '7'.repeat(64) })).toMatch(ONLY);
    expect(await confirmRow({ ...base, request_id: 'rq_sp_twin', confirmed_by_kind: 'hana', confirmed_by: 'staff-2', confirmed_sub: null, token_sha256: null, confirmed_email_key: 'staff2@hana.example', reason: 'short' })).toMatch(/CHECK/u);
    const at = Date.now();
    expect(await confirmRow({ ...base, request_id: 'rq_sp_twin', confirmed_by_kind: 'hana', confirmed_by: 'staff-2', confirmed_sub: null, token_sha256: null, confirmed_email_key: 'staff2@hana.example', reason: 'Checked with the network by phone today', confirmed_at: at })).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_sp'", at - 1)).toMatch(EARLY);
    expect(await refusal("UPDATE guarded_changes SET active_from = ?1 WHERE id = 'gc_sp'", at)).toBe('accepted');
    expect(await refusal("UPDATE app_origins SET active_from = ?1 WHERE change_id = 'gc_sp'", at)).toBe('accepted');
  });

  it('retention’s delete of an ended change takes its wait and its confirmation with it; a cancelled one never comes back', async () => {
    expect(await refusal("UPDATE guarded_changes SET status = 'ended', ended_at = ?1 WHERE id = 'gc_sp'", Date.now())).toBe('accepted');
    expect(await refusal("UPDATE guarded_changes SET status = 'pending' WHERE id = 'gc_sp'")).toMatch(/never comes back/u);
    await run("DELETE FROM app_origins WHERE change_id = 'gc_sp'");
    expect(await refusal("DELETE FROM guarded_changes WHERE id = 'gc_sp'")).toBe('accepted');
    for (const t of ['origin_confirmations', 'staff_origin_waits']) expect(await db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE change_id = 'gc_sp'`).first(), t).toEqual({ n: 0 });
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

describe('0034’s triggers after every later migration (a later rebuild of their tables must create them again)', () => {
  /** Triggers a later migration adds or replaces on these tables, by name. */
  const LATER: string[] = [];
  it('every trigger 0034 creates is there after the last migration, with 0034’s SQL', async () => {
    const m = env.MIGRATION_DB;
    await applyD1Migrations(m, env.TEST_MIGRATIONS);
    const at34 = await schema(db);
    const last = await schema(m);
    for (const name of TRIGGERS_0034) if (!LATER.includes(name)) expect(last.get(name)?.sql, name).toBe(at34.get(name)!.sql);
  });
});
