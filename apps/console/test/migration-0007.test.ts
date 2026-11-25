// Console migration 0007 (D931, piece P10 of docs/partner-platform-spec.md, A15): `pending_actions` rebuilt with the
// `origin.confirm` step-up kind, as 0004 and 0005 did. Applied to a database holding rows of every kind of
// before (owner actions with their scope, nonce and args; used and unused; every optional column set and unset): every
// row comes back unchanged, every column and index the same, the table's SQL the old one with only the kinds added;
// no trigger or view anywhere reads the table (asked of `sqlite_schema`); the kind list is console-core's STEP_UP_KINDS;
// and the copy checks itself, so a damaged copy aborts the whole file with the old table untouched.
import { applyD1Migrations } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { STEP_UP_KINDS } from '@hana-id/console-core';
import { beforeAll, describe, expect, it } from 'vitest';

const db = env.MIGRATION_DB;
const FILE = '0007_origin_confirm_step_up.sql';
const NEW_KINDS = ['origin.confirm'];
const OLD_KINDS = STEP_UP_KINDS.filter((k) => !NEW_KINDS.includes(k));
const now = Date.now();
type Obj = { type: string; name: string; tbl_name: string; sql: string | null };
const schemaOf = async (d: D1Database) => new Map((await d.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' ORDER BY name").all<Obj>()).results.map((r) => [r.name, r]));
const rowsOf = async (d: D1Database) => (await d.prepare('SELECT * FROM pending_actions ORDER BY id').all()).results;
const columnsOf = async (d: D1Database) => (await d.prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('pending_actions') ORDER BY cid").all()).results;
const h32 = (n: number) => new Uint8Array(32).map((_, i) => (n * 13 + i) & 0xff);

async function seed(d: D1Database): Promise<number> {
  const ins = d.prepare(
    'INSERT INTO pending_actions (id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, used_at, outcome, created_at, expires_at, request_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)',
  );
  const batch: D1PreparedStatement[] = [];
  let n = 0;
  for (const kind of OLD_KINDS) {
    for (const used of [false, true]) {
      n += 1;
      const owner = kind === 'owner_action';
      batch.push(
        ins.bind(
          `act_${String(n).padStart(3, '0')}`,
          `usr_${n % 3}`,
          h32(n),
          n % 2 ? 'org_a' : 'org_b',
          kind,
          JSON.stringify({ action: { v: 1, kind, note: `ünïcødé “${kind}”`, n }, decoded: { list: [1, null, 'x'] }, returnTo: '/orgs/org_a' }),
          h32(n + 100),
          `nonce-${n}`,
          owner ? 's1' : null,
          owner ? n : null,
          owner ? new Uint8Array([1, 2, n]) : null,
          used ? now - n : null,
          used ? JSON.stringify({ status: n % 4 ? 'ok' : 'failed', code: 'x' }) : null,
          now - 1000 * n,
          now + 300_000 - n,
          `req-${String(n).padStart(8, '0')}`,
        ),
      );
    }
  }
  await d.batch(batch);
  return n;
}

let before: Map<string, Obj>;
let beforeRows: unknown[];
let beforeColumns: unknown[];
let readers: string[];
const READERS_SQL = "SELECT name FROM sqlite_schema WHERE type IN ('trigger', 'view') AND (tbl_name = 'pending_actions' OR instr(sql, 'pending_actions') > 0) ORDER BY name";

beforeAll(async () => {
  const migrations = env.TEST_MIGRATIONS;
  const at = migrations.findIndex((m) => m.name === FILE);
  expect(at).toBeGreaterThan(0);
  await applyD1Migrations(db, migrations.slice(0, at));
  expect(await seed(db)).toBe(OLD_KINDS.length * 2);
  before = await schemaOf(db);
  beforeRows = await rowsOf(db);
  beforeColumns = await columnsOf(db);
  readers = (await db.prepare(READERS_SQL).all<{ name: string }>()).results.map((r) => r.name);
  await applyD1Migrations(db, migrations.slice(0, at + 1));
});

describe('console migration 0007_origin_confirm_step_up', () => {
  it('keeps every row unchanged and every column, type, NOT NULL, default and key', async () => {
    expect(await rowsOf(db)).toEqual(beforeRows);
    expect(await columnsOf(db)).toEqual(beforeColumns);
  });

  it('every other schema object is the same SQL; the index is back; nothing new is left behind', async () => {
    const after = await schemaOf(db);
    for (const [name, b] of before) {
      if (name === 'pending_actions') continue;
      expect(after.get(name), name).toEqual(b);
    }
    expect([...after.keys()].filter((k) => !before.has(k))).toEqual([]);
    expect(after.get('pending_actions_expires')!.sql).toBe('CREATE INDEX pending_actions_expires ON pending_actions (expires_at)');
  });

  it('the table’s SQL is the old one with only the one kind added (its name quoted by the rename)', async () => {
    const old = before.get('pending_actions')!.sql!;
    const now_ = (await schemaOf(db)).get('pending_actions')!.sql!;
    const plain = (x: string) => x.replace('CREATE TABLE "pending_actions"', 'CREATE TABLE pending_actions');
    expect(plain(now_)).toBe(plain(old).replace("'platform.key_confirm'))", "'platform.key_confirm', 'origin.confirm'))"));
  });

  it('no trigger or view anywhere reads pending_actions (so the rebuild needs to re-create none)', async () => {
    expect(readers).toEqual([]);
    expect((await db.prepare(READERS_SQL).all()).results).toEqual([]);
  });

  it('the kind list is STEP_UP_KINDS: the new kinds go in, an unknown one is refused, the owner-action CHECK holds', async () => {
    const sql = (await schemaOf(db)).get('pending_actions')!.sql!;
    expect([.../kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]*)\)\)/u.exec(sql)![1]!.matchAll(/'([^']*)'/gu)].map((m) => m[1])).toEqual([...STEP_UP_KINDS]);
    const insert = (kind: string, owner = false) =>
      db
        .prepare('INSERT INTO pending_actions (id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, created_at, expires_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .bind(`act_${Math.random()}`, 'usr_a', h32(1), 'org_a', kind, '{}', h32(2), 'n', owner ? 's1' : null, owner ? 1 : null, owner ? new Uint8Array([1]) : null, now, now + 1, 'req-00000001')
        .run()
        .then(
          () => true,
          () => false,
        );
    for (const k of NEW_KINDS) expect(await insert(k), k).toBe(true);
    expect(await insert('origin.cancel')).toBe(false);
    expect(await insert('origin.confirm', true)).toBe(false);
    expect(await insert('owner_action', true)).toBe(true);
  });

  it('the database is whole', async () => {
    expect(await db.prepare('PRAGMA quick_check').all()).toMatchObject({ results: [{ quick_check: 'ok' }] });
    expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);
  });
});

describe('console migration 0007 checks its own copy before dropping anything', () => {
  const fresh = env.FRESH_DB;
  type Break = { what: string; replace?: [string, string]; after?: [string, string] };
  const broken: Break[] = [
    { what: 'a row skipped', replace: ['expires_at, request_id FROM pending_actions', "expires_at, request_id FROM pending_actions WHERE id > 'act_001'"] },
    { what: 'a value changed', replace: ['SELECT id, user_id, session_hash', 'SELECT id, user_id || \'x\', session_hash'] },
    { what: 'a used action made unused', after: ['INSERT INTO pending_actions_new', 'UPDATE pending_actions_new SET used_at = NULL'] },
    { what: 'an outcome lost', after: ['INSERT INTO pending_actions_new', 'UPDATE pending_actions_new SET outcome = NULL WHERE outcome IS NOT NULL'] },
    { what: 'an expiry moved', after: ['INSERT INTO pending_actions_new', 'UPDATE pending_actions_new SET expires_at = expires_at + 1'] },
  ];
  const apply = (queries: string[], b: Break): string[] =>
    queries.flatMap((q) => {
      if (b.replace && q.includes(b.replace[0])) return [q.replace(b.replace[0], b.replace[1])];
      if (b.after && q.trimStart().startsWith(b.after[0])) return [q, b.after[1]];
      return [q];
    });

  it('a copy that differs in any way aborts the whole file: the old table, its rows and the applied list untouched', async () => {
    const migrations = env.TEST_MIGRATIONS;
    const at = migrations.findIndex((m) => m.name === FILE);
    await applyD1Migrations(fresh, migrations.slice(0, at));
    await seed(fresh);
    const snapshot = async () => ({ rows: await rowsOf(fresh), schema: [...(await schemaOf(fresh)).values()], applied: (await fresh.prepare('SELECT name FROM d1_migrations ORDER BY id').all()).results });
    const start = await snapshot();
    for (const b of broken) {
      const bad = { ...migrations[at]!, queries: apply(migrations[at]!.queries, b) };
      expect(bad.queries.join('\n'), b.what).not.toBe(migrations[at]!.queries.join('\n'));
      const failed = await applyD1Migrations(fresh, [...migrations.slice(0, at), bad]).then(() => false, () => true);
      expect(failed, b.what).toBe(true);
      expect(await snapshot(), b.what).toEqual(start);
    }
    await applyD1Migrations(fresh, migrations.slice(0, at + 1));
    expect(await rowsOf(fresh)).toEqual(start.rows);
  });
});
