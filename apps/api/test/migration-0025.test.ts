// Migration 0025 (D894): partner labels' tables, the scopes' `labels_version`, and `security_events` rebuilt with three
// more kinds. Applied after 0024 on a database that has rows: every security event kept, every scope at version 0; the
// triggers hold an entry to its scope's org, a version to its entry and to live apps of that scope, and a version's
// text to what was proposed; applying again changes nothing.
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
const SHA = 'ab'.repeat(32);
const change = (id: string, label: string, apps: string, o: { org?: string; scope?: string } = {}) =>
  accepted(
    `INSERT INTO label_changes (id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, status, proposed_by, proposer_sub, proposed_at, request_id)
     VALUES (?1, ?2, ?3, ?4, '{}', 'journear-labels/1', ?5, 2, 'near:testnet:x.testnet', ?6, 'pending', 'usr_1', 'sub-1', ?7, ?1)`,
    id,
    label,
    o.org ?? 'org_a',
    o.scope ?? 's1',
    SHA,
    apps,
    Date.now(),
  );

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === '0025_partner_labels.sql');
  // Later migrations (0026, the shared-scope rules) don't touch these tables.
  expect(at).toBeGreaterThan(0);
  expect(migrations[at - 1]!.name).toBe('0024_evm_relay_auto_resumed.sql');
  await applyD1Migrations(db, migrations.slice(0, at));
  const now = Date.now();
  await db.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s1', 'org_a', 'test', NULL, ?1, ?1), ('s2', 'org_b', 'test', NULL, ?1, ?1)").bind(now).run();
  await db.prepare("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_a1', 'A1', 's1', 'org_a', 'pk_test_AaaaaaaaaaaaaaaaaaaA'), ('app_b1', 'B1', 's2', 'org_b', 'pk_test_BbbbbbbbbbbbbbbbbbbB')").run();
  await db.prepare("INSERT INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES ('se_1', 5, 'evm_relay_auto_resumed', NULL, '{}'), ('se_2', 6, 'drift', 'org_a', '{\"what\":\"origin\"}')").run();
  expect(await accepted("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_x', 7, 'label_proposed', '{}')")).toBe(false);
  await applyD1Migrations(db, migrations);
});

describe('migration 0025_partner_labels', () => {
  it('keeps every security event and takes the three new kinds; every scope starts at labels_version 0', async () => {
    expect((await db.prepare('SELECT id, detected_at, kind, org_id, detail_json, notified_at FROM security_events ORDER BY id').all()).results).toEqual([
      { id: 'se_1', detected_at: 5, kind: 'evm_relay_auto_resumed', org_id: null, detail_json: '{}', notified_at: null },
      { id: 'se_2', detected_at: 6, kind: 'drift', org_id: 'org_a', detail_json: '{"what":"origin"}', notified_at: null },
    ]);
    for (const k of ['label_proposed', 'label_blocked', 'label_live']) expect(await accepted('INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES (?1, 7, ?2, ?3)', `se_${k}`, k, '{}'), k).toBe(true);
    expect(await accepted("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_y', 7, 'label_other', '{}')")).toBe(false);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name = 'security_events_unnotified'").first()).toEqual({ n: 1 });
    expect((await db.prepare('SELECT DISTINCT labels_version FROM scopes').all()).results).toEqual([{ labels_version: 0 }]);
  });

  it('an entry belongs to its scope’s org; a version to its entry, and only to live apps of that scope and org', async () => {
    expect(await accepted("INSERT INTO partner_labels (id, org_id, scope_id, created_at, created_by) VALUES ('pl_x', 'org_b', 's1', 1, 'u')")).toBe(false);
    expect(await accepted("INSERT INTO partner_labels (id, org_id, scope_id, created_at, created_by) VALUES ('pl_a', 'org_a', 's1', 1, 'u')")).toBe(true);
    expect(await change('lc_other_org_app', 'pl_a', '["app_b1"]')).toBe(false);
    expect(await change('lc_wrong_org', 'pl_a', '["app_a1"]', { org: 'org_b' })).toBe(false);
    expect(await change('lc_no_apps', 'pl_a', '[]')).toBe(false);
    expect(await change('lc_not_array', 'pl_a', '{"a":1}')).toBe(false);
    expect(await change('lc_ok', 'pl_a', '["app_a1"]')).toBe(true);
    // A blocked status needs its blocked_at, and the reverse.
    expect(await accepted("UPDATE label_changes SET status = 'blocked' WHERE id = 'lc_ok'")).toBe(false);
    expect(await accepted("UPDATE partner_labels SET org_id = 'org_b' WHERE id = 'pl_a'")).toBe(false);
  });

  it('a version’s text, hash, apps and proposer are never edited; its lifecycle columns are; it is kept 60 months; the switch log is append-only', async () => {
    for (const col of ["doc_text = '{\"x\":1}'", "doc_sha256 = '" + 'cd'.repeat(32) + "'", "apps_json = '[\"app_a1\",\"app_a2\"]'", "proposer_sub = 'other'", "context_key = 'near:testnet:y.testnet'", 'proposed_at = 2']) {
      expect(await accepted(`UPDATE label_changes SET ${col} WHERE id = 'lc_ok'`), col).toBe(false);
    }
    expect(await accepted("UPDATE label_changes SET notified_at = 3, active_from = 4 WHERE id = 'lc_ok'")).toBe(true);
    expect(await accepted("DELETE FROM label_changes WHERE id = 'lc_ok'")).toBe(false);
    expect(await accepted("INSERT INTO label_control_log (at, target, labels_off, review_required, actor_id, note, request_id) VALUES (?1, '*', 1, 0, 'staff', 'A note here', 'r1')", Date.now())).toBe(true);
    expect(await accepted("UPDATE label_control_log SET labels_off = 0")).toBe(false);
    expect(await accepted('DELETE FROM label_control_log')).toBe(false);
    expect(await accepted("INSERT INTO label_controls (target, labels_off, review_required, updated_at, updated_by) VALUES ('pl_a', 1, 0, 1, 's')")).toBe(false);
  });

  it('applying the migrations again changes nothing (each file once, in name order)', async () => {
    const before = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const after = (await db.prepare('SELECT name FROM d1_migrations ORDER BY id').all<{ name: string }>()).results.map((r) => r.name);
    expect(after).toEqual(before);
    const i = after.indexOf('0025_partner_labels.sql');
    expect(after.slice(i - 1, i + 1)).toEqual(['0024_evm_relay_auto_resumed.sql', '0025_partner_labels.sql']);
    expect(await db.prepare("SELECT COUNT(*) AS n FROM label_changes WHERE id = 'lc_ok'").first()).toEqual({ n: 1 });
  });
});
