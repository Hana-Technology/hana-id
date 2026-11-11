// Migration 0019 (D756): `end_user_wallets` and `user_events` rebuilt with wider CHECKs (NEAR). Rows written before it
// keep every column, their keys and indexes; `near` is accepted where it should be and nowhere else.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const U = `hu_${'a'.repeat(26)}`;
const G = `G${'A'.repeat(55)}`;
const EVM = '0x52908400098527886E0F7030069857D2E4169EE7';
const NEAR = 'ab'.repeat(32);

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
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === '0019_near_wallets.sql');
  expect(at).toBe(migrations.length - 1);
  await applyD1Migrations(db, migrations.slice(0, at));
  // Before 0019: NEAR is refused, as an API ahead of the migration finds it.
  await db.prepare("INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, 'ABCDEFGH', 's1', 1, 2)").bind(U, `u1_${'A'.repeat(22)}`).run();
  await db.prepare("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'stellar', ?2, 0, 1, 2), (?1, 'evm', ?3, 0, 1, 2)").bind(U, G, EVM).run();
  await db.prepare("INSERT INTO user_events (id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES (5, 'key_exported', 'app_1', 's1', ?1, 'evm', NULL, NULL, NULL, 'r5', 3), (6, 'key_exported', NULL, 's1', ?1, NULL, NULL, NULL, NULL, 'r6', 4)").bind(U).run();
  expect(await accepted("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'near', ?2, 0, 1, 2)", U, NEAR)).toBe(false);
  expect(await accepted("INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, request_id, at) VALUES ('key_exported', 'app_1', 's1', ?1, 'near', 'rx', 5)", U)).toBe(false);
  await applyD1Migrations(db, migrations);
});

describe('migration 0019_near_wallets', () => {
  it('keeps every wallet and event row as it was', async () => {
    expect((await db.prepare('SELECT * FROM end_user_wallets ORDER BY chain DESC').all()).results).toEqual([
      { user_id: U, chain: 'stellar', address: G, key_index: 0, first_seen_at: 1, last_used_at: 2 },
      { user_id: U, chain: 'evm', address: EVM, key_index: 0, first_seen_at: 1, last_used_at: 2 },
    ]);
    expect((await db.prepare('SELECT id, kind, app_id, chain, request_id, at FROM user_events ORDER BY id').all()).results).toEqual([
      { id: 5, kind: 'key_exported', app_id: 'app_1', chain: 'evm', request_id: 'r5', at: 3 },
      { id: 6, kind: 'key_exported', app_id: null, chain: null, request_id: 'r6', at: 4 },
    ]);
  });

  it('takes a NEAR wallet (64 characters) and a NEAR export; refuses a NEAR mainnet signature, another chain and a longer address', async () => {
    expect(await accepted("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'near', ?2, 0, 1, 2)", U, NEAR)).toBe(true);
    expect(await accepted("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'solana', ?2, 0, 1, 2)", U, NEAR)).toBe(false);
    expect(await accepted("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'near', ?2, 0, 1, 2)", U, `${NEAR}a`)).toBe(false);
    expect(await accepted("INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, request_id, at) VALUES ('key_exported', 'app_1', 's1', ?1, 'near', 'rn', 5)", U)).toBe(true);
    expect(await accepted("INSERT INTO user_events (kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at) VALUES ('mainnet_signature', 'app_1', 's1', ?1, 'near', 'mainnet', ?2, 1, 'rm', 6)", U, EVM)).toBe(false);
    // The foreign key and its cascade still hold: a wallet of no user is refused, deleting the user deletes its wallets.
    expect(await accepted("INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, 'near', ?2, 0, 1, 2)", `hu_${'b'.repeat(26)}`, NEAR)).toBe(false);
    await db.prepare('DELETE FROM end_users WHERE user_id = ?1').bind(U).run();
    expect(await db.prepare('SELECT COUNT(*) AS n FROM end_user_wallets').first()).toEqual({ n: 0 });
  });

  it('keeps the indexes', async () => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('end_user_wallets', 'user_events') AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(['end_user_wallets_address', 'user_events_address', 'user_events_app', 'user_events_user']);
  });
});
