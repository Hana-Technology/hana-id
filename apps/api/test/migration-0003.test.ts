import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;

/** Runs a statement and reports whether SQLite accepted it. */
const accepted = async (sql: string, ...binds: unknown[]): Promise<boolean> =>
  db
    .prepare(sql)
    .bind(...binds)
    .run()
    .then(
      () => true,
      () => false,
    );

beforeAll(async () => {
  // Rows written before 0003 (as a deployed env has them), then 0003 (and later migrations) on top.
  const migrations = env.TEST_MIGRATIONS;
  expect(migrations.map((m) => m.name)).toEqual(['0001_init.sql', '0002_issuer_key_missing.sql', '0003_vault.sql', '0004_issuer_key_observations.sql', '0005_issuer_key_sync.sql', '0006_dashboard_expand.sql', '0008_identity_token.sql', '0009_session_markers.sql', '0010_login_methods.sql', '0011_wallet_directory.sql', '0012_issuer_key_last_token.sql']);
  await applyD1Migrations(db, migrations.slice(0, 2));
  await db.prepare("INSERT INTO apps (id, name, scope_id, publishable_key) VALUES ('old', 'Old', 's1', 'pk_test_old')").run();
  await db.prepare("INSERT INTO usage (app_id, day, sessions, derives) VALUES ('old', '2026-10-01', 3, 4)").run();
  await applyD1Migrations(db, migrations);
});

describe('migration 0003_vault', () => {
  it('gives existing apps and usage rows the defaults', async () => {
    expect(await db.prepare("SELECT persistence, session_ttl_ms, idle_ttl_ms, raw_sign, raw_sign_pending, raw_sign_effective_at, auto_approve_policy, auto_approve_pending, auto_approve_effective_at, google_web_client_id FROM apps WHERE id = 'old'").first()).toEqual({
      persistence: 'session',
      session_ttl_ms: 43_200_000,
      idle_ttl_ms: 7_200_000,
      raw_sign: 'off',
      raw_sign_pending: null,
      raw_sign_effective_at: null,
      auto_approve_policy: null,
      auto_approve_pending: null,
      auto_approve_effective_at: null,
      google_web_client_id: null,
    });
    expect(await db.prepare("SELECT sessions, derives, unlocks FROM usage WHERE app_id = 'old'").first()).toEqual({ sessions: 3, derives: 4, unlocks: 0 });
  });

  const update = (set: string, ...binds: unknown[]): Promise<boolean> => accepted(`UPDATE apps SET ${set} WHERE id = 'old'`, ...binds);

  it('checks persistence and raw_sign values', async () => {
    expect(await update("persistence = 'none'")).toBe(true);
    expect(await update("persistence = 'session'")).toBe(true);
    expect(await update("persistence = 'local'")).toBe(false);
    expect(await update("raw_sign = 'approval'")).toBe(true);
    expect(await update("raw_sign = 'off'")).toBe(true);
    expect(await update("raw_sign = 'app_signed'")).toBe(false);
    expect(await update("raw_sign_pending = 'approval', raw_sign_effective_at = 1")).toBe(true);
    expect(await update("raw_sign_pending = 'off', raw_sign_effective_at = 1")).toBe(false);
    // A pending value always comes with its effective time, and vice versa.
    expect(await update('raw_sign_pending = NULL')).toBe(false);
    expect(await update('raw_sign_effective_at = NULL')).toBe(false);
    expect(await update('raw_sign_pending = NULL, raw_sign_effective_at = NULL')).toBe(true);
  });

  it('checks the TTL ranges at their bounds', async () => {
    expect(await update('session_ttl_ms = 3600000, idle_ttl_ms = 900000')).toBe(true);
    expect(await update('session_ttl_ms = 3599999')).toBe(false);
    expect(await update('session_ttl_ms = 85800000')).toBe(true);
    expect(await update('session_ttl_ms = 85800001')).toBe(false);
    expect(await update('idle_ttl_ms = 899999')).toBe(false);
    expect(await update('idle_ttl_ms = 85800000')).toBe(true);
    // idle ≤ session, whichever changes.
    expect(await update('session_ttl_ms = 3600000')).toBe(false);
    expect(await update('idle_ttl_ms = 3600001, session_ttl_ms = 3600000')).toBe(false);
    expect(await update('idle_ttl_ms = 7200000, session_ttl_ms = 43200000')).toBe(true);
    expect(await update('session_ttl_ms = NULL')).toBe(false);
  });

  it('auto-approve columns hold JSON, pending with its effective time', async () => {
    expect(await update('auto_approve_policy = ?1', '{"v":1}')).toBe(true);
    expect(await update('auto_approve_policy = ?1', '{not json')).toBe(false);
    expect(await update('auto_approve_pending = ?1, auto_approve_effective_at = 5', '{"v":1}')).toBe(true);
    expect(await update('auto_approve_pending = ?1', 'nope')).toBe(false);
    expect(await update('auto_approve_effective_at = NULL')).toBe(false);
    expect(await update('auto_approve_policy = NULL, auto_approve_pending = NULL, auto_approve_effective_at = NULL')).toBe(true);
  });

  it('vault_shares: one share per session key, cascades with its app', async () => {
    const insert = (shareId: number, sessionPk: number, appId = 'old'): Promise<boolean> =>
      accepted(
        `INSERT INTO vault_shares (share_id, app_id, session_pk, path_hash, partner_origin, share_enc, kek_id, created_at, idle_until, abs_expires_at)
         VALUES (?1, ?2, ?3, ?4, 'https://a.example', ?5, 1, 1, 2, 3)`,
        new Uint8Array(16).fill(shareId),
        appId,
        new Uint8Array(32).fill(sessionPk),
        new Uint8Array(32),
        new Uint8Array(60),
      );
    expect(await insert(1, 1)).toBe(true);
    expect(await insert(2, 1)).toBe(false);
    expect(await insert(1, 2)).toBe(false);
    expect(await insert(3, 3, 'missing-app')).toBe(false);
    const row = await db.prepare('SELECT counter, revoked_at FROM vault_shares').first();
    expect(row).toEqual({ counter: 0, revoked_at: null });
    await db.prepare("DELETE FROM apps WHERE id = 'old'").run();
    expect((await db.prepare('SELECT COUNT(*) AS n FROM vault_shares').first<{ n: number }>())!.n).toBe(0);
  });
});
