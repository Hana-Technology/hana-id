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

  it('keeps the indexes, and adds one: at most one NEAR account per user and key index (D762)', async () => {
    const names = (await db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('end_user_wallets', 'user_events') AND name NOT LIKE 'sqlite_%' ORDER BY name").all<{ name: string }>()).results.map((r) => r.name);
    expect(names).toEqual(['end_user_wallets_address', 'end_user_wallets_one_near', 'user_events_address', 'user_events_app', 'user_events_user']);
    const sql = async (name: string) => (await db.prepare("SELECT sql FROM sqlite_master WHERE name = ?1").bind(name).first<{ sql: string }>())!.sql.replace(/\s+/gu, ' ');
    expect(await sql('end_user_wallets_address')).toBe('CREATE INDEX end_user_wallets_address ON end_user_wallets (address)');
    expect(await sql('end_user_wallets_one_near')).toBe("CREATE UNIQUE INDEX end_user_wallets_one_near ON end_user_wallets (user_id, key_index) WHERE chain = 'near'");
    expect(await sql('user_events_user')).toBe('CREATE INDEX user_events_user ON user_events (user_id, kind, at DESC)');
    expect(await sql('user_events_address')).toBe('CREATE INDEX user_events_address ON user_events (address, at DESC)');
    expect(await sql('user_events_app')).toBe('CREATE INDEX user_events_app ON user_events (app_id, kind, at DESC)');
  });

  it('keeps every column, type, NOT NULL, key, foreign key and CHECK of both tables', async () => {
    const cols = async (t: string) => (await db.prepare(`PRAGMA table_info(${t})`).all<{ name: string; type: string; notnull: number; dflt_value: unknown; pk: number }>()).results.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]);
    expect(await cols('end_user_wallets')).toEqual([
      ['user_id', 'TEXT', 1, null, 1],
      ['chain', 'TEXT', 1, null, 2],
      ['address', 'TEXT', 1, null, 3],
      ['key_index', 'INTEGER', 1, null, 0],
      ['first_seen_at', 'INTEGER', 1, null, 0],
      ['last_used_at', 'INTEGER', 1, null, 0],
    ]);
    expect(await cols('user_events')).toEqual([
      ['id', 'INTEGER', 0, null, 1],
      ['kind', 'TEXT', 1, null, 0],
      ['app_id', 'TEXT', 0, null, 0],
      ['scope_id', 'TEXT', 1, null, 0],
      ['user_id', 'TEXT', 0, null, 0],
      ['chain', 'TEXT', 0, null, 0],
      ['network', 'TEXT', 0, null, 0],
      ['address', 'TEXT', 0, null, 0],
      ['usd_micros', 'INTEGER', 0, null, 0],
      ['request_id', 'TEXT', 1, null, 0],
      ['at', 'INTEGER', 1, null, 0],
    ]);
    const fks = (await db.prepare('PRAGMA foreign_key_list(end_user_wallets)').all<{ table: string; from: string; to: string; on_delete: string }>()).results.map((f) => [f.table, f.from, f.to, f.on_delete]);
    expect(fks).toEqual([['end_users', 'user_id', 'user_id', 'CASCADE']]);
    expect((await db.prepare('PRAGMA foreign_key_list(user_events)').all()).results).toEqual([]);
    const tableSql = async (t: string) => (await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1").bind(t).first<{ sql: string }>())!.sql.replace(/\s+/gu, ' ');
    const wallets = await tableSql('end_user_wallets');
    for (const check of [
      "CHECK (chain IN ('stellar', 'evm', 'near'))",
      'CHECK (length(address) BETWEEN 42 AND 64)',
      'CHECK (key_index >= 0 AND key_index < 2147483648)',
      'CHECK (first_seen_at >= 0)',
      'CHECK (last_used_at >= first_seen_at)',
      'REFERENCES end_users (user_id) ON DELETE CASCADE',
      'PRIMARY KEY (user_id, chain, address)',
    ]) expect(wallets, check).toContain(check);
    const events = await tableSql('user_events');
    for (const check of [
      "CHECK (kind IN ('key_exported', 'mainnet_signature'))",
      "CHECK (user_id IS NULL OR (user_id GLOB 'hu_*' AND length(user_id) = 29))",
      "CHECK (chain IS NULL OR chain IN ('stellar', 'evm', 'near'))",
      'CHECK (network IS NULL OR (length(network) BETWEEN 1 AND 16))',
      'CHECK (address IS NULL OR (length(address) BETWEEN 42 AND 56))',
      'CHECK (usd_micros IS NULL OR usd_micros >= 0)',
      'CHECK (at >= 0)',
      "CHECK (kind <> 'key_exported' OR user_id IS NOT NULL)",
      "CHECK (kind <> 'mainnet_signature' OR (user_id IS NOT NULL AND address IS NOT NULL AND chain IS NOT NULL AND network IS NOT NULL))",
      "CHECK (kind <> 'mainnet_signature' OR chain <> 'near')",
      "CHECK (app_id IS NOT NULL OR kind = 'key_exported')",
    ]) expect(events, check).toContain(check);
  });

  it('a second NEAR account for one user and key index is refused by the index; another key index, or Stellar and EVM, are not', async () => {
    const V = `hu_${'v'.repeat(26)}`;
    await db.prepare("INSERT INTO end_users (user_id, token_sub, support_code, scope_id, created_at, last_seen_at) VALUES (?1, ?2, 'ABCDEFGH', 's1', 1, 2)").bind(V, `u1_${'B'.repeat(21)}A`).run();
    const add = (chain: string, address: string, keyIndex: number) => accepted('INSERT INTO end_user_wallets (user_id, chain, address, key_index, first_seen_at, last_used_at) VALUES (?1, ?2, ?3, ?4, 1, 2)', V, chain, address, keyIndex);
    expect(await add('near', 'cd'.repeat(32), 0)).toBe(true);
    expect(await add('near', 'ef'.repeat(32), 0)).toBe(false);
    expect(await add('near', 'ef'.repeat(32), 1)).toBe(true);
    expect(await add('stellar', `G${'B'.repeat(55)}`, 0)).toBe(true);
    expect(await add('stellar', `G${'C'.repeat(55)}`, 0)).toBe(true);
  });
});
