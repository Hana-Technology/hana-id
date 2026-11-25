// ledger-check (lib/ledger-check.ts, D916): the before-and-after comparison around migration 0027, on node:sqlite with
// the real migrations and rows of every kind the three tables have held. The real migration comes back `identical`;
// a broken rebuild (a row lost, a row changed, seq renumbered, an index or trigger dropped or altered) comes back
// `roll_back`; the running jobs' writes in between (a notice acknowledged, an event emailed, new rows) come back
// `kept`; a database the migration never reached `not_applied`. Paging doesn't change a hash, and no snapshot holds a
// row's value.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { APP_CHANGE_KINDS, SECURITY_EVENT_KINDS } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { type Checkout, type FeedState, type LedgerCheckDeps, type LedgerSnapshot, FEED_CURSOR_KEYS, VERDICT_EXIT, KIND_TRIGGERS, LEDGER_TABLES, SECURITY_EVENT_KINDS_AT_0021, SECURITY_EVENT_KIND_STEPS, compareSnapshots, expectedTableSql, ledgerCheck, lifecycleProblem, pageSql, referenceSchema, securityEventsLevel, takeSnapshot } from '../lib/ledger-check.ts';
import { MIGRATIONS_DIR, newHotDb } from './hot-db.ts';
import { repoRoot } from '@hana-id/env';

const MIGRATION = readFileSync(join(MIGRATIONS_DIR, '0027_platform_actor.sql'), 'utf8');
/**
 * The migration with its own copy check switched off: what a rebuild without it would leave, so these tests show
 * ledger-check catches the damage by itself (apps/api/test/migration-0027.test.ts shows the check aborts the file).
 */
const UNCHECKED = MIGRATION.replaceAll('CHECK (ok = 1)', 'CHECK (ok IN (0, 1))');
/** A statement run on a table's copy right after it was copied (a rebuild that damages the copy). */
const afterCopy = (table: 'guarded_changes' | 'security_events' | 'app_changes', stmt: string) => (sql: string) => sql.replace(`FROM ${table};`, `FROM ${table};\n${stmt};`);
const MONTH = 31 * 86_400_000;
const NOW = Date.UTC(2026, 10, 25, 3, 0);
/** A value that must never appear in a snapshot (it is in a row's detail). */
const SECRETISH = 'detail-that-must-not-leak-7f3a';

/**
 * A hot DB with rows of every kind each ledger table has held: before 0027 by default, or before another migration
 * (`'0022'`: sandbox-dev's level, through 0021), with only the event kinds that level's CHECK takes (D924).
 */
function populated(before = '0027'): DatabaseSync {
  const db = newHotDb({ before });
  db.exec("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES ('s_t', 'org_a', 'test', 1, 1, 1), ('s_l', 'org_a', 'live', NULL, 1, 1)");
  db.exec("INSERT INTO apps (id, name, scope_id, org_id, publishable_key) VALUES ('app_t', 'T', 's_t', 'org_a', 'pk_test_Ttttttttttttttttttttttt'), ('app_l', 'L', 's_l', 'org_a', 'pk_live_Lllllllllllllllllllllll')");
  const ins = db.prepare('INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  ins.run(NOW - 61 * MONTH, 'org_a', 'app_t', 's_t', 'app.created', '{}', 'hana', 'staff', null, 'req_purged');
  let n = 0;
  for (const kind of APP_CHANGE_KINDS)
    for (const actor of ['member', 'hana', 'system', 'link']) {
      n += 1;
      ins.run(NOW - n, 'org_a', n % 3 ? 'app_t' : null, 's_t', kind, JSON.stringify({ n, note: `${SECRETISH} ünï “q”`, nested: [1, { two: null }] }), actor, `${actor}_${n}`, actor === 'member' ? `sub-${n}` : null, `req_${n}`);
    }
  db.exec("DELETE FROM app_changes WHERE request_id = 'req_purged'");
  db.exec(`INSERT INTO app_changes (seq, at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (70000, ${NOW}, 'org_a', 'scope.assigned', '{}', 'hana', 'staff', 'req_70000')`);
  const gc = db.prepare(
    'INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, waiver, notified_at, active_from, cancel_token_hash, cancelled_by, cancelled_at, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  let g = 0;
  for (const kind of ['origin_add', 'policy_set', 'raw_sign_on'])
    for (const status of ['pending', 'active', 'cancelled', 'ended'])
      for (const by of ['member', 'hana', 'system']) {
        g += 1;
        const notified = status !== 'pending' || g % 2 === 0;
        gc.run(
          `gc_${String(g).padStart(3, '0')}`,
          g % 2 ? 'app_t' : 'app_l',
          kind,
          kind === 'origin_add' ? `https://o${g}.example.com` : null,
          kind === 'policy_set' ? '{"label":"x"}' : null,
          kind === 'policy_set' ? 'ab'.repeat(32) : null,
          status,
          by,
          `${by}_p`,
          by === 'member' ? 'sub-p' : null,
          NOW - g,
          g % 5 === 0 ? 'loopback' : null,
          notified ? NOW - g : null,
          notified ? NOW + g : null,
          notified ? new Uint8Array(32).fill(g) : null,
          status === 'cancelled' ? 'link' : null,
          status === 'cancelled' ? NOW : null,
          `req_g${g}`,
        );
      }
  const se = db.prepare('INSERT INTO security_events (id, detected_at, kind, org_id, detail_json, notified_at) VALUES (?, ?, ?, ?, ?, ?)');
  const takes = (k: string) => (db.prepare("SELECT sql FROM sqlite_schema WHERE name = 'security_events'").get() as { sql: string }).sql.includes(`'${k}'`);
  SECURITY_EVENT_KINDS.filter((k) => !['platform_quota', 'platform_auth_failures', 'link_lookup_volume', 'shared_wallet_policy', 'shared_scope_unmarked'].includes(k) && takes(k)).forEach((k, i) => se.run(`se_${k}`, NOW - i, k, i % 2 ? 'org_a' : null, '{}', i % 2 ? NOW : null));
  return db;
}

/** Damaged copies of 0027 (its own copy check off): what each must make the comparison say. */
const BROKEN: [string, (sql: string) => string, RegExp][] = [
  // A job-written column moved by the rebuild, not by a job (PR 143's review, F1): each reproduced as "kept" before.
  ['active_from copied from notified_at', afterCopy('guarded_changes', 'UPDATE guarded_changes_new SET active_from = notified_at'), /MOVED WRONG: \d+ row\(s\) .*active_from changed/u],
  ['every cancel link hash lost', afterCopy('guarded_changes', 'UPDATE guarded_changes_new SET cancel_token_hash = NULL'), /MOVED WRONG: .*cancel_token_hash cleared/u],
  ['cancelled changes made pending again', afterCopy('guarded_changes', "UPDATE guarded_changes_new SET status = 'pending' WHERE status = 'cancelled'"), /MOVED WRONG: .*status cancelled → pending/u],
  ['ended changes made active again', afterCopy('guarded_changes', "UPDATE guarded_changes_new SET status = 'active', ended_at = NULL WHERE status = 'ended'"), /MOVED WRONG: .*status ended → active/u],
  ['every event unsent again', afterCopy('security_events', 'UPDATE security_events_new SET notified_at = NULL'), /security_events: .*\n {2}MOVED WRONG: \d+ row\(s\) .*notified_at cleared/u],
  ['an announcement without its time', afterCopy('guarded_changes', 'UPDATE guarded_changes_new SET notified_at = 1 WHERE notified_at IS NULL'), /MOVED WRONG: .*notified_at set without active_from/u],
  ['a cancel with nobody who cancelled', afterCopy('guarded_changes', "UPDATE guarded_changes_new SET status = 'cancelled' WHERE status = 'pending'"), /MOVED WRONG: .*cancelled without cancelled_at and cancelled_by/u],
  // A table's own rules dropped by the rebuild (F3): each came back "identical" before.
  ['the status CHECK dropped', (s) => s.replace("status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'ended')),", 'status                TEXT NOT NULL,'), /CHANGED table guarded_changes/u],
  ['json_valid dropped', (s) => s.replace("detail_json TEXT NOT NULL CHECK (json_valid(detail_json)), -- allowlisted fields only", 'detail_json TEXT NOT NULL, -- allowlisted fields only'), /CHANGED table app_changes/u],
  ['a NOT NULL dropped', (s) => s.replace('  at          INTEGER NOT NULL,\n  org_id      TEXT NOT NULL,\n  app_id      TEXT,', '  at          INTEGER,\n  org_id      TEXT NOT NULL,\n  app_id      TEXT,'), /CHANGED table app_changes/u],
  ['a new event kind left out', (s) => s.replace("'link_lookup_volume', 'shared_wallet_policy'", "'shared_wallet_policy'"), /CHANGED table security_events/u],
  ['a lost ledger row', (s) => s.replace('FROM app_changes;', 'FROM app_changes WHERE seq <> 70000;'), /app_changes: .*\n {2}LOST: 1 row\(s\)/u],
  ['a lost guarded change', (s) => s.replace('FROM guarded_changes;', "FROM guarded_changes WHERE id <> 'gc_007';"), /LOST: 1 row\(s\) of before are gone \(first ids: gc_007\)/u],
  ['a changed ledger row', (s) => s.replace('SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind', "SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, CASE actor_kind WHEN 'link' THEN 'system' ELSE actor_kind END"), /CHANGED: \d+ row\(s\) differ in a column no job writes \(the table is append-only\)/u],
  ['a changed proposer', (s) => s.replace('proposed_at, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id FROM guarded_changes', 'proposed_at + 1, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id FROM guarded_changes'), /guarded_changes: .*\n {2}CHANGED: 36/u],
  ['seq renumbered', (s) => s.replace('SELECT seq, at, org_id', 'SELECT NULL, at, org_id'), /SEQ: /u],
  ['a dropped index', (s) => s.replace('CREATE INDEX guarded_changes_due ON guarded_changes (status, active_from);', ''), /MISSING index guarded_changes_due/u],
  // 0026's trigger on scopes reads guarded_changes: 0027 re-creates it, and the comparison holds it to its SQL.
  ['0026’s trigger re-created altered', (s) => s.replace("g.status IN ('pending', 'active'))));\nEND;", "g.status IN ('pending'))));\nEND;"), /CHANGED trigger scopes_app_user_ids_no_policy/u],
  ['0026’s trigger not re-created', (s) => s.replace(/CREATE TRIGGER scopes_app_user_ids_no_policy [\s\S]*?\nEND;/u, ''), /MISSING trigger scopes_app_user_ids_no_policy \(on scopes\)/u],
  ['an altered trigger', (s) => s.replace("'-60 months') * 1000)\nBEGIN\n  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months')", "'-6 months') * 1000)\nBEGIN\n  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months')"), /CHANGED trigger app_changes_no_early_delete/u],
];

const reader = (db: DatabaseSync) => (s: string) => db.prepare(s).all() as Record<string, unknown>[];
const snap = (db: DatabaseSync, pageSize = 7): Promise<LedgerSnapshot> => takeSnapshot(reader(db), { env: 'sandbox-dev', database: 'hana-id-sandbox-dev', remote: true, now: new Date(NOW), pageSize });

describe('ledger-check: snapshot and compare around migration 0027', () => {
  it('the real migration: identical (every row, seq, index and trigger); the kind triggers new since', async () => {
    const db = populated();
    const before = await snap(db);
    expect(before.tables.app_changes!.rows).toBe(APP_CHANGE_KINDS.length * 4 + 1);
    expect(before.tables.app_changes!.maxSeq).toBe(70000);
    expect(before.tables.guarded_changes!.rows).toBe(36);
    db.exec(MIGRATION);
    const after = await snap(db);
    const c = compareSnapshots(before, after);
    expect(c.verdict).toBe('identical');
    expect(c.lines.join('\n')).toContain(`New since: ${[...KIND_TRIGGERS].sort().join(', ')}.`);
    for (const t of LEDGER_TABLES) expect(after.tables[t.name]!.sha256, t.name).toBe(before.tables[t.name]!.sha256);
    // The other table's trigger that reads guarded_changes is in the comparison.
    expect(Object.keys(before.schema)).toContain('scopes_app_user_ids_no_policy');
    expect(after.schema.scopes_app_user_ids_no_policy).toEqual(before.schema.scopes_app_user_ids_no_policy);
  });

  it('paging changes no hash; a snapshot holds no row value', async () => {
    const db = populated();
    const small = await snap(db, 1);
    const big = await snap(db, 500);
    expect(small.tables).toEqual(big.tables);
    const text = JSON.stringify(small);
    expect(text).not.toContain(SECRETISH);
    expect(text).not.toContain('o3.example.com');
    expect(text).not.toContain('0303030303'); // a cancel link hash's hex
    expect(text).not.toContain('sub-1"');
  });

  it('a rebuild that loses a row, changes one, moves a job-written column as no job does, renumbers seq, drops a table rule, or drops or alters an index or trigger: roll back', async () => {
    for (const [what, mutate, finding] of BROKEN) {
      const db = populated();
      const before = await snap(db);
      const bad = mutate(UNCHECKED);
      expect(bad, what).not.toBe(UNCHECKED);
      db.exec(bad);
      const c = compareSnapshots(before, await snap(db));
      expect(c.verdict, what).toBe('roll_back');
      expect(c.lines.join('\n'), what).toMatch(finding);
      expect(c.lines.at(-1), what).toMatch(/^Verdict: ROLL BACK/u);
    }
  });

  it('the jobs’ writes in between (a notice acknowledged, an event emailed, new rows): kept, each named', async () => {
    const db = populated();
    const before = await snap(db);
    db.exec(MIGRATION);
    db.exec("UPDATE guarded_changes SET notified_at = 1, active_from = 2, cancel_token_hash = randomblob(32) WHERE id = 'gc_001'");
    db.exec("UPDATE security_events SET notified_at = 5 WHERE id = 'se_drift'");
    db.exec(`INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (${NOW}, 'org_a', 'change.announced', '{}', 'system', 'admin', 'req_since')`);
    db.exec("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_since', 1, 'breaker', '{}')");
    const c = compareSnapshots(before, await snap(db));
    expect(c.verdict).toBe('kept');
    const text = c.lines.join('\n');
    expect(text).toContain('guarded_changes: 36 → 36 rows; hash changed');
    expect(text).toMatch(/1 row\(s\) moved on by a job since \(only as the jobs move them: status, waiver, notified_at, active_from, cancel_token_hash, .*first ids: gc_001\)/u);
    expect(text).toMatch(/security_events: .*\n {2}1 row\(s\) moved on by a job since \(only as the jobs move them: notified_at; first ids: se_drift\)\.\n {2}1 row\(s\) written since/u);
    expect(text).toMatch(/app_changes: \d+ → \d+ rows, max\(seq\) 70000 → 70001; hash changed .*\n {2}1 row\(s\) written since/u);
  });

  it('every move the jobs make, alone or several between the snapshots, is kept: ack, expedite, activation, end, cancel', async () => {
    const db = populated();
    const before = await snap(db);
    db.exec(MIGRATION);
    // gc_001: pending, not announced → announced (the API's ack), then expedited, then activated.
    db.exec("UPDATE guarded_changes SET notified_at = 10, active_from = 99, waiver = NULL, cancel_token_hash = randomblob(32) WHERE id = 'gc_001'");
    db.exec("UPDATE guarded_changes SET active_from = 11, expedited_by = 'staff', expedite_reason = 'asked' WHERE id = 'gc_001'");
    db.exec("UPDATE guarded_changes SET status = 'active', activated_recorded_at = 12 WHERE id = 'gc_001'");
    // gc_002: pending and announced → in force, then closed by a removal (pending → ended).
    db.exec("UPDATE guarded_changes SET status = 'ended', ended_at = 13 WHERE id = 'gc_002'");
    // gc_003: pending, not announced → cancelled by the hourly job.
    db.exec("UPDATE guarded_changes SET status = 'cancelled', cancelled_by = 'system', cancelled_at = 14 WHERE id = 'gc_003'");
    // gc_004..: active → ended (a replaced policy).
    db.exec("UPDATE guarded_changes SET status = 'ended', ended_at = 15 WHERE status = 'active' AND id <> 'gc_001'");
    // The CLI's announce (no cancel link hash) of another unannounced one.
    db.exec("UPDATE guarded_changes SET notified_at = 16, active_from = 17, waiver = 'no_session' WHERE id = 'gc_013'");
    const c = compareSnapshots(before, await snap(db));
    expect(c.lines.join('\n')).not.toContain('MOVED WRONG');
    expect(c.verdict).toBe('kept');
  });

  it('lifecycleProblem: each rule by itself', () => {
    const t = LEDGER_TABLES.find((x) => x.name === 'guarded_changes')!;
    const row = (o: Record<string, string | null>) => t.mutable.map((c) => (Object.hasOwn(o, c) ? o[c]! : null));
    const pending = row({ status: 'pending' });
    const announced = row({ status: 'pending', notified_at: 'n', active_from: 'a', cancel_token_hash: 'h' });
    expect(lifecycleProblem(t, pending, announced)).toBeNull();
    expect(lifecycleProblem(t, announced, row({ status: 'pending', notified_at: 'n', active_from: 'b', cancel_token_hash: 'h', expedited_by: 's', expedite_reason: 'r' }))).toBeNull();
    expect(lifecycleProblem(t, announced, row({ status: 'pending', notified_at: 'n', active_from: 'b', cancel_token_hash: 'h' }))).toBe('active_from changed');
    expect(lifecycleProblem(t, announced, row({ status: 'pending', notified_at: 'n', active_from: 'a', cancel_token_hash: 'h', expedited_by: 's' }))).toBe('expedited_by and expedite_reason apart');
    expect(lifecycleProblem(t, announced, row({ status: 'active', notified_at: 'n', active_from: 'a', cancel_token_hash: 'h' }))).toBe('activated without activated_recorded_at');
    expect(lifecycleProblem(t, announced, row({ status: 'pending', notified_at: 'n', active_from: 'a', cancel_token_hash: 'h', ended_at: 'e' }))).toBe('ended_at set with status pending');
    expect(lifecycleProblem(t, pending, row({ status: 'pending', waiver: 'w' }))).toBe('announced without notified_at');
    expect(lifecycleProblem(t, row({ status: 'ended', ended_at: 'e' }), row({ status: 'cancelled', ended_at: 'e', cancelled_at: 'c', cancelled_by: 'b' }))).toBe('status ended → cancelled');
    const se = LEDGER_TABLES.find((x) => x.name === 'security_events')!;
    expect(lifecycleProblem(se, [null], ['x'])).toBeNull();
    expect(lifecycleProblem(se, ['x'], ['y'])).toBe('notified_at changed');
    expect(lifecycleProblem(se, ['x'], [null])).toBe('notified_at cleared');
  });

  it('a lifecycle update can’t hide a fixed column’s change, and a job can’t make a lost row look kept', async () => {
    const db = populated();
    const before = await snap(db);
    db.exec(MIGRATION);
    db.exec("UPDATE guarded_changes SET notified_at = 1, origin = 'https://other.example' WHERE id = 'gc_001'");
    db.exec("DELETE FROM security_events WHERE id = 'se_breaker'");
    db.exec(`INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_zz', 1, 'breaker', '{}')`);
    const c = compareSnapshots(before, await snap(db));
    expect(c.verdict).toBe('roll_back');
    expect(c.lines.join('\n')).toMatch(/CHANGED: 1 row\(s\) differ in a column no job writes \(first ids: gc_001\)/u);
    expect(c.lines.join('\n')).toMatch(/LOST: 1 row\(s\) of before are gone \(first ids: se_breaker\)/u);
  });

  it('before the migration, or on another database: not applied; refused', async () => {
    const db = populated();
    const a = await snap(db);
    const b = await snap(db);
    expect(compareSnapshots(a, b).verdict).toBe('not_applied');
    expect(compareSnapshots(a, { ...b, remote: false }).verdict).toBe('roll_back');
  });

  it('pages by key in order with escaped keys, blobs as hex', () => {
    const t = LEDGER_TABLES.find((x) => x.name === 'guarded_changes')!;
    expect(pageSql(t, undefined, 2)).toMatch(/^SELECT id, app_id, .*CASE WHEN cancel_token_hash IS NULL THEN NULL ELSE hex\(cancel_token_hash\) END AS cancel_token_hash, .* FROM guarded_changes ORDER BY id LIMIT 2$/u);
    expect(pageSql(t, "gc_'x", 2)).toContain("WHERE id > 'gc_''x' ORDER BY id LIMIT 2");
    expect(pageSql(LEDGER_TABLES[0]!, 41, 500)).toBe('SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id FROM app_changes WHERE seq > 41 ORDER BY seq LIMIT 500');
  });
});

describe('ledger-check: the CLI', () => {
  const setup = (db: DatabaseSync, o: { network?: string; feed?: Map<string, string> } = {}) => {
    const files = new Map<string, unknown>();
    const lines: string[] = [];
    const reads: string[] = [];
    const feed = o.feed ?? new Map<string, string>();
    let closed = 0;
    let t = NOW;
    const deps: LedgerCheckDeps = {
      manifest: () => ({ network: o.network ?? 'testnet', d1Name: 'hana-id-sandbox-dev' }),
      read: (_env, d1Name, s) => {
        reads.push(d1Name);
        return reader(db)(s);
      },
      feedState: async (): Promise<FeedState> => ({
        get: async (keys) => new Map(keys.filter((k) => feed.has(k)).map((k) => [k, feed.get(k)!])),
        set: async (k, v) => void feed.set(k, v),
        close: async () => void (closed += 1),
      }),
      secretsEnvDir: (env) => `/repo/.secrets/${env}`,
      writeJson: (f, v) => files.set(f, JSON.parse(JSON.stringify(v))),
      readJson: (f) => {
        if (!files.has(f)) throw new Error(`no ${f}`);
        return files.get(f);
      },
      log: (l) => lines.push(l),
      now: () => new Date((t += 60_000)),
    };
    return { files, lines, reads, feed, closed: () => closed, deps };
  };

  it('snapshot, migrate, compare: exit 0, files under .secrets/<env>/, hashes printed, no row printed', async () => {
    const db = populated();
    const { files, lines, reads, deps } = setup(db);
    expect(await ledgerCheck(['sandbox-dev', 'snapshot', '--remote'], deps)).toBe(0);
    const [first] = [...files.keys()];
    expect(first).toMatch(/^\/repo\/\.secrets\/sandbox-dev\/ledger-snapshot-20261125T030100000Z\.json$/u);
    db.exec(MIGRATION);
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', first!], deps)).toBe(0);
    expect([...files.keys()][1]).toMatch(/ledger-after-/u);
    const out = lines.join('\n');
    expect(out).toMatch(/app_changes: \d+ rows, max\(seq\) 70000, sha256 [0-9a-f]{64}/u);
    expect(out).toContain("0027's triggers present");
    expect(out).toContain('Verdict: identical.');
    expect(out).not.toContain(SECRETISH);
    expect(new Set(reads)).toEqual(new Set(['hana-id-sandbox-dev']));
  });

  it('exit 1 on a broken rebuild or a migration not applied; a snapshot of the other database or env refused', async () => {
    const db = populated();
    const { files, lines, deps } = setup(db);
    await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', '/repo/.secrets/sandbox-dev/b.json'], deps);
    expect(files.has('/repo/.secrets/sandbox-dev/b.json')).toBe(true);
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).toBe(1);
    expect(lines.join('\n')).toContain('migration 0027 is not applied');
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).rejects.toThrow(/run compare with --remote/u);
    await expect(ledgerCheck(['local', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).rejects.toThrow(/a snapshot of sandbox-dev, not local/u);
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--remote', '--d1-name', 'hana-id-sandbox-dev-rehearsal-0027', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).rejects.toThrow(/a snapshot of hana-id-sandbox-dev, not hana-id-sandbox-dev-rehearsal-0027/u);
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--remote'], deps)).rejects.toThrow(CliError);
    await expect(ledgerCheck(['sandbox-dev', 'apply'], deps)).rejects.toThrow(CliError);
    files.set('/repo/.secrets/sandbox-dev/v1.json', { ...(files.get('/repo/.secrets/sandbox-dev/b.json') as object), format: 'hana-id/ledger-check/v1' });
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/v1.json'], deps)).rejects.toThrow(/not a hana-id\/ledger-check\/v3 snapshot/u);
    db.exec(UNCHECKED.replace('FROM security_events;', "FROM security_events WHERE id <> 'se_drift';"));
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/Verdict: ROLL BACK/u);
  });

  it('--d1-name reads a rehearsal database (remote only); anything else, and a mainnet env, refused', async () => {
    const db = populated();
    const { reads, deps } = setup(db);
    expect(await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--d1-name', 'hana-id-sandbox-dev-rehearsal-0027'], deps)).toBe(0);
    expect(new Set(reads)).toEqual(new Set(['hana-id-sandbox-dev-rehearsal-0027']));
    await expect(ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--d1-name', 'hana-id-sandbox-dev'], deps)).rejects.toThrow(/containing "rehearsal"/u);
    await expect(ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--d1-name', 'hana-id-mainnet-rehearsal'], deps)).rejects.toThrow(/production/u);
    await expect(ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--d1-name', 'Rehearsal;DROP'], deps)).rejects.toThrow(/containing "rehearsal"/u);
    await expect(ledgerCheck(['sandbox-dev', 'snapshot', '--d1-name', 'hana-id-sandbox-dev-rehearsal-0027'], deps)).rejects.toThrow(/add --remote/u);
    await expect(ledgerCheck(['prod', 'snapshot', '--remote'], setup(db, { network: 'mainnet' }).deps)).rejects.toThrow(/mainnet env/u);
  });

  it('feed-cursor: lowers the admin feed’s cursor (and an unfinished first walk) to the snapshot’s max(seq), at most the restored one, never raises it; a dry run without --yes', async () => {
    const db = populated(); // max(seq) 70000 when the snapshot is taken
    const feed = new Map([[FEED_CURSOR_KEYS[0], '70012'], [FEED_CURSOR_KEYS[1], '69000']]);
    const s = setup(db, { feed });
    await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', '/repo/.secrets/sandbox-dev/b.json'], s.deps);
    // After the restore the API already wrote two rows (70001, 70002): the cursor goes to the snapshot's 70000, so they are emailed.
    db.exec(`INSERT INTO app_changes (at, org_id, kind, detail_json, actor_kind, actor_id, request_id) VALUES (${NOW}, 'org_a', 'app.renamed', '{}', 'system', 'x', 'req_r1'), (${NOW}, 'org_a', 'app.renamed', '{}', 'system', 'x', 'req_r2')`);
    const run = (...extra: string[]) => ledgerCheck(['sandbox-dev', 'feed-cursor', '--remote', '--before', '/repo/.secrets/sandbox-dev/b.json', ...extra], s.deps);
    expect(await run()).toBe(0);
    expect(feed.get(FEED_CURSOR_KEYS[0])).toBe('70012');
    expect(s.lines.join('\n')).toContain('has max(seq) 70002; the snapshot before the migration had 70000: the cursor goes no higher than 70000.');
    expect(s.lines.join('\n')).toContain('feed.app_changes.seq: 70012 → 70000 (planned).');
    expect(s.lines.join('\n')).toContain('Dry run: nothing written.');
    expect(await run('--yes')).toBe(0);
    expect(feed.get(FEED_CURSOR_KEYS[0])).toBe('70000');
    expect(feed.get(FEED_CURSOR_KEYS[1])).toBe('69000');
    expect(s.lines.join('\n')).toContain('feed.app_changes.seq.init: 69000, at or below 70000: left as it is.');
    expect(s.closed()).toBe(2);
    expect(await run('--yes')).toBe(0);
    expect(s.lines.at(-1)).toBe('Nothing to lower.');
    // Without the snapshot it falls back to the current max(seq), and says what that risks.
    feed.set(FEED_CURSOR_KEYS[0], '70100');
    expect(await ledgerCheck(['sandbox-dev', 'feed-cursor', '--remote', '--yes'], s.deps)).toBe(0);
    expect(feed.get(FEED_CURSOR_KEYS[0])).toBe('70002');
    expect(s.lines.join('\n')).toContain('No --before: rows the API wrote since the restore');
    await expect(ledgerCheck(['sandbox-dev', 'feed-cursor'], s.deps)).rejects.toThrow(/--remote/u);
    await expect(ledgerCheck(['sandbox-dev', 'feed-cursor', '--remote', '--d1-name', 'x-rehearsal'], s.deps)).rejects.toThrow(/rehearsal copy/u);
    feed.set(FEED_CURSOR_KEYS[0], 'garbage');
    await expect(run('--yes')).rejects.toThrow(/not a seq/u);
  });

  it('reads through apiPrivateD1Execute, never d1Execute: no row in wrangler’s log file (PR 143’s review, F4)', () => {
    const cli = readFileSync(join(repoRoot, 'scripts', 'ledger-check.ts'), 'utf8');
    expect(cli).toMatch(/apiPrivateD1Execute\(/u);
    expect(cli).not.toMatch(/\bd1Execute\(/u);
    expect(cli).not.toMatch(/console\.log\([^)]*row/iu);
  });
});

// D924: sandbox-dev's D1 is at 0021, so the deploy takes one snapshot and applies 0022 to 0027 in one
// `migrations apply`. Every starting level from 0021 to 0026 must give the true verdict, from the real migration files.
describe('ledger-check: a snapshot taken at any level from 0021 to 0026 (D924)', () => {
  const FILES = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
  const file = (prefix: string) => FILES.find((f) => f.startsWith(prefix))!;
  /** Applies the real migrations whose names sort in [from, to). */
  const applyRange = (db: DatabaseSync, from: string, to: string) => {
    for (const f of FILES) if (f >= from && f < to) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  };
  const REFERENCE = referenceSchema(MIGRATIONS_DIR);
  const LEVELS = ['0021', '0022', '0023', '0024', '0025', '0026'] as const;
  const next = (level: string) => String(Number(level) + 1).padStart(4, '0');
  const kindsIn = (sql: string): string[] => [...(/CHECK \(kind IN \(([^)]*)\)\)/u.exec(sql)?.[1] ?? '').matchAll(/'([^']+)'/gu)].map((m) => m[1]!);

  it('the kind steps are exactly what the migration files after 0021 do to security_events (and they touch nothing else of the three tables)', () => {
    // Every file after 0021 that rebuilds security_events, with the kinds it appends; a new rebuild (P2, P6, …) fails
    // here until its step is added.
    let kinds = [...SECURITY_EVENT_KINDS_AT_0021];
    const steps: { migration: string; added: string[] }[] = [];
    // Any statement that creates, drops, alters or renames into `security_events` (any case, any quoting, any copy's
    // name) marks a file that changes the table (after PR 151's review, L3); each must be a step with its kind list.
    const touches = /\b(?:CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`\[]?security_events\w*|\bRENAME\s+TO\s+["'`\[]?security_events\b/iu;
    for (const f of FILES.filter((n) => n >= '0022')) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/gu, '');
      if (!touches.test(sql)) continue;
      const create = /CREATE TABLE security_events_new \(([\s\S]*?)\n\);/u.exec(sql);
      expect(create, `${f} changes security_events but not as a known rebuild (CREATE TABLE security_events_new …)`).not.toBeNull();
      if (!create) continue;
      const now = kindsIn(create[0]);
      expect(now.slice(0, kinds.length), f).toEqual(kinds);
      steps.push({ migration: f.slice(0, 4), added: now.slice(kinds.length) });
      kinds = now;
    }
    expect(steps).toEqual(SECURITY_EVENT_KIND_STEPS.map((x) => ({ migration: x.migration, added: [...x.added] })));
    // No migration after 0021 writes a row of the three tables (only their rebuilds' own copies, `…_new`), 0027 included,
    // and none but 0027 creates, drops or alters app_changes or guarded_changes (after PR 151's review, L3: a row
    // written above max(seq) would read as "kept").
    const write = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|REPLACE\s+INTO|UPDATE(?:\s+OR\s+\w+)?|DELETE\s+FROM)\s+["'`\[]?(?:app_changes|guarded_changes|security_events)\b(?!_)/iu;
    const shape = /\b(?:CREATE\s+TABLE|DROP\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?["'`\[]?(?:app_changes|guarded_changes)\b(?!_)|\bRENAME\s+TO\s+["'`\[]?(?:app_changes|guarded_changes)\b/iu;
    for (const f of FILES.filter((n) => n >= '0022')) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8').replace(/--[^\n]*/gu, '');
      expect(sql, `${f} writes a ledger row`).not.toMatch(write);
      if (!f.startsWith('0027')) expect(sql, `${f} reshapes app_changes or guarded_changes`).not.toMatch(shape);
    }
    // The patterns themselves catch the forms a review named: another case, quoting, OR REPLACE.
    for (const bad of ['insert into APP_CHANGES (seq) values (1)', 'INSERT OR REPLACE INTO "guarded_changes" VALUES (1)', 'update `security_events` set x = 1', 'DELETE FROM [app_changes]']) expect(bad).toMatch(write);
    for (const bad of ['ALTER TABLE "APP_CHANGES" ADD COLUMN x', 'drop table if exists guarded_changes', 'ALTER TABLE x RENAME TO app_changes']) expect(bad).toMatch(shape);
    for (const bad of ['CREATE TABLE "Security_Events_copy" (x)', 'DROP TABLE security_events', 'ALTER TABLE security_events_x RENAME TO "security_events"']) expect(bad).toMatch(touches);
    // The table SQL itself, level by level on the real files: each step is the before-SQL with exactly its kinds added.
    for (const level of LEVELS) {
      const db = newHotDb({ before: next(level) });
      const sqlOf = (t: string) => (db.prepare('SELECT sql FROM sqlite_schema WHERE type = ? AND name = ?').get('table', t) as { sql: string }).sql;
      const before = Object.fromEntries(LEDGER_TABLES.map((t) => [t.name, sqlOf(t.name)]));
      for (const to of LEVELS.filter((l) => l > level)) {
        applyRange(db, next(String(Number(to) - 1)), next(to));
        const toLevel = securityEventsLevel(sqlOf('security_events'));
        for (const t of LEDGER_TABLES) expect(sqlOf(t.name), `${t.name} ${level} → ${to}`).toBe(expectedTableSql(t.name, before[t.name]!, false, toLevel!));
      }
      applyRange(db, '0027', '0028');
      for (const t of LEDGER_TABLES) expect(sqlOf(t.name), `${t.name} ${level} → 0027`).toBe(expectedTableSql(t.name, before[t.name]!, true, '0027'));
    }
  });

  it('one snapshot at each level, then 0022 … 0027 in one go: identical, every row and hash as before', async () => {
    for (const level of LEVELS) {
      const db = populated(next(level));
      const before = await snap(db);
      applyRange(db, next(level), '0028');
      const after = await snap(db);
      const c = compareSnapshots(before, after, REFERENCE);
      expect(c.verdict, `${level}: ${c.lines.join('\n')}`).toBe('identical');
      for (const t of LEDGER_TABLES) expect(after.tables[t.name]!.sha256, `${level} ${t.name}`).toBe(before.tables[t.name]!.sha256);
      if (level < '0025') expect(c.lines.join('\n'), level).toContain(`security_events' kinds: at migration ${securityEventsLevel(before.schema.security_events!.sql!)} before, 0027 after`);
      // 0026's trigger that reads guarded_changes is new since a snapshot before 0026, and held to its SQL.
      if (level < '0026') expect(c.lines.join('\n'), level).toMatch(/New since: .*scopes_app_user_ids_no_policy/u);
    }
  });

  it('D929: a later migration’s trigger naming the ledger (0033’s) is required only once the database recorded that migration', async () => {
    const db = populated('0027');
    const before = await snap(db);
    applyRange(db, '0027', '0028');
    const after = await snap(db);
    const upTo27 = FILES.filter((f) => f < '0028');
    expect(compareSnapshots(before, { ...after, applied: upTo27 }, REFERENCE).verdict).toBe('identical');
    expect(REFERENCE.guarded_changes_platform_not_early?.file).toBe(file('0033'));
    const claims33 = compareSnapshots(before, { ...after, applied: [...upTo27, file('0033')] }, REFERENCE);
    expect(claims33.verdict).toBe('roll_back');
    expect(claims33.lines.join('\n')).toMatch(/MISSING trigger guarded_changes_platform_not_early \(on guarded_changes\)/u);
    // With 0033 applied for real, its triggers are there and held to their SQL.
    applyRange(db, '0028', '0034');
    const all = await snap(db);
    const c = compareSnapshots(before, { ...all, applied: FILES.filter((f) => f < '0034') }, REFERENCE);
    expect(c.lines.join('\n')).not.toMatch(/MISSING|UNEXPECTED|CHANGED trigger/u);
  });

  it('from 0021: every damaged copy of 0027 is still a rollback', async () => {
    for (const [what, mutate, finding] of BROKEN) {
      const db = populated('0022');
      const before = await snap(db);
      applyRange(db, '0022', '0027');
      db.exec(mutate(UNCHECKED));
      const c = compareSnapshots(before, await snap(db), REFERENCE);
      expect(c.verdict, what).toBe('roll_back');
      // 0026's trigger did not exist at 0021: a damaged re-creation is caught against the checkout's migrations.
      const expected = what.startsWith('0026’s trigger re-created') ? /CHANGED trigger scopes_app_user_ids_no_policy: its SQL is not the one this checkout/u : what.startsWith('0026’s trigger not re-created') ? /MISSING trigger scopes_app_user_ids_no_policy \(on scopes\): this checkout's migrations create it/u : finding;
      expect(c.lines.join('\n'), what).toMatch(expected);
    }
  });

  it('from 0021: a row lost or changed by a migration in between, or 0027 ending without a kind or rule of theirs, is a rollback', async () => {
    const cases: [string, string, (sql: string) => string, RegExp][] = [
      ['0023 loses an event', '0023', (s) => s.replace('FROM security_events;', "FROM security_events WHERE id <> 'se_drift';"), /LOST: 1 row\(s\) of before are gone \(first ids: se_drift\)/u],
      ['0024 marks every event sent', '0024', (s) => s.replace('SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at FROM security_events', 'SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, 1 FROM security_events'), /MOVED WRONG|notified_at changed/u],
      // A kind of a migration in between left out of 0027's own list: the end state is wrong.
      ['0027 leaves out a kind of 0023', '0027', (s) => s.replace("'near_billing_late', ", ''), /CHANGED table security_events/u],
      // (A rule a migration in between drops is restored by 0027's own rebuild, so only the end state is judged.)
      ['0027 drops security_events’ json_valid', '0027', (s) => s.replace(/(CREATE TABLE security_events_new \([\s\S]*?)detail_json TEXT NOT NULL CHECK \(json_valid\(detail_json\)\)/u, '$1detail_json TEXT NOT NULL'), /CHANGED table security_events/u],
    ];
    for (const [what, level, mutate, finding] of cases) {
      const db = populated('0022');
      const before = await snap(db);
      for (const f of FILES.filter((n) => n >= '0022' && n < '0028')) {
        const sql = readFileSync(join(MIGRATIONS_DIR, f), 'utf8');
        const used = f.startsWith(level) ? mutate(sql) : sql;
        if (f.startsWith(level)) expect(used, what).not.toBe(sql);
        db.exec(f.startsWith('0027') ? (level === '0027' ? mutate(UNCHECKED) : UNCHECKED) : used);
      }
      const c = compareSnapshots(before, await snap(db), REFERENCE);
      expect(c.verdict, what).toBe('roll_back');
      expect(c.lines.join('\n'), what).toMatch(finding);
    }
  });

  it('from 0021: the jobs’ moves while 0022 … 0027 apply are kept; 0022 … 0026 alone are “not applied”, nothing to roll back', async () => {
    const db = populated('0022');
    const before = await snap(db);
    applyRange(db, '0022', '0025');
    db.exec("UPDATE guarded_changes SET notified_at = 10, active_from = 99, cancel_token_hash = randomblob(32) WHERE id = 'gc_001'");
    db.exec("UPDATE security_events SET notified_at = 5 WHERE id = 'se_drift'");
    applyRange(db, '0025', '0027');
    const partway = compareSnapshots(before, await snap(db), REFERENCE);
    expect(partway.verdict, partway.lines.join('\n')).toBe('not_applied');
    applyRange(db, '0027', '0028');
    db.exec("UPDATE guarded_changes SET status = 'cancelled', cancelled_by = 'system', cancelled_at = 14 WHERE id = 'gc_003'");
    db.exec("INSERT INTO security_events (id, detected_at, kind, detail_json) VALUES ('se_since', 1, 'shared_wallet_policy', '{}')");
    const c = compareSnapshots(before, await snap(db), REFERENCE);
    expect(c.lines.join('\n')).not.toContain('MOVED WRONG');
    expect(c.verdict).toBe('kept');
  });

  it('an unknown kind list before 0027: its own verdict, nothing else reported CHANGED; kinds at 0027 without its triggers, or an object no migration creates: rollback', async () => {
    const seSql = (sql: string) => ({ type: 'table', table: 'security_events', sql });
    const db = populated('0024');
    const before = await snap(db);
    expect(securityEventsLevel(before.schema.security_events!.sql!)).toBe('0023');
    expect(expectedTableSql('security_events', before.schema.security_events!.sql!, false, '0022')).toBeNull();
    const odd = { ...before, schema: { ...before.schema, security_events: seSql(before.schema.security_events!.sql!.replace("'neon_compute_high'", "'neon_compute_high', 'made_up'")) } };
    expect(securityEventsLevel(odd.schema.security_events.sql)).toBeNull();
    const unknown = compareSnapshots(before, odd as LedgerSnapshot, REFERENCE);
    expect(unknown.verdict).toBe('unknown_level');
    expect(unknown.lines.join('\n')).toContain("UNKNOWN LEVEL: security_events' kind list after is at no migration level");
    expect(unknown.lines.join('\n')).not.toMatch(/CHANGED table (app_changes|guarded_changes)/u);
    // The same unknown list before the snapshot: also its own verdict, and only that.
    const unknownBefore = compareSnapshots(odd as LedgerSnapshot, before, REFERENCE);
    expect(unknownBefore.verdict).toBe('unknown_level');
    expect(unknownBefore.lines.join('\n')).not.toMatch(/CHANGED/u);
    const level0027 = expectedTableSql('security_events', before.schema.security_events!.sql!, false, '0027')!;
    const noTriggers = { ...before, schema: { ...before.schema, security_events: seSql(level0027) } };
    const c = compareSnapshots(before, noTriggers as LedgerSnapshot, REFERENCE);
    expect(c.verdict).toBe('roll_back');
    expect(c.lines.join('\n')).toContain("security_events' kinds are at 0027 but 0027's triggers are absent");
    applyRange(db, '0024', '0028');
    db.exec("CREATE TRIGGER app_changes_sneaky BEFORE INSERT ON app_changes BEGIN SELECT 1; END");
    const sneaky = compareSnapshots(before, await snap(db), REFERENCE);
    expect(sneaky.verdict).toBe('roll_back');
    expect(sneaky.lines.join('\n')).toContain('UNEXPECTED trigger app_changes_sneaky (on app_changes): no migration of this checkout creates it.');
  });

  it('the CLI: a relative --before or --out is relative to where the command was run (INIT_CWD), not scripts/', async () => {
    const db = populated('0022');
    const files = new Map<string, unknown>();
    const lines: string[] = [];
    let t = NOW;
    const deps: LedgerCheckDeps = {
      manifest: () => ({ network: 'testnet', d1Name: 'hana-id-sandbox-dev' }),
      read: (_e, _d, s) => reader(db)(s),
      feedState: async () => ({ get: async () => new Map(), set: async () => undefined, close: async () => undefined }),
      secretsEnvDir: (env) => `/repo/.secrets/${env}`,
      writeJson: (f, v) => files.set(f, JSON.parse(JSON.stringify(v))),
      readJson: (f) => {
        if (!files.has(f)) throw new Error(`no ${f}`);
        return files.get(f);
      },
      log: (l) => lines.push(l),
      now: () => new Date((t += 60_000)),
      cwd: '/repo',
      referenceSchema: () => REFERENCE,
    };
    expect(await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', '.secrets/sandbox-dev/b.json'], deps)).toBe(0);
    expect([...files.keys()]).toEqual(['/repo/.secrets/sandbox-dev/b.json']);
    applyRange(db, '0022', '0028');
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '.secrets/sandbox-dev/b.json'], deps)).toBe(0);
    expect(lines.join('\n')).toContain('Compared with /repo/.secrets/sandbox-dev/b.json');
    expect(lines.at(-1)).toContain('Verdict: identical');
    const cli = readFileSync(join(repoRoot, 'scripts', 'ledger-check.ts'), 'utf8');
    expect(cli).toMatch(/cwd: invocationDir\(\)/u);
    expect(cli).toMatch(/referenceSchema: \(\) => referenceSchema\(/u);
  });
});

describe('ledger-check after PR 151’s review (D924)', () => {
  const FILES = readdirSync(MIGRATIONS_DIR).filter((n) => n.endsWith('.sql')).sort();
  const REFERENCE = referenceSchema(MIGRATIONS_DIR);
  const applyRange = (db: DatabaseSync, from: string, to: string) => {
    for (const f of FILES) if (f >= from && f < to) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'));
  };
  /** wrangler's own table: the migrations the database recorded, by name. */
  const recordApplied = (db: DatabaseSync, upTo: string) => {
    db.exec('CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TEXT)');
    const ins = db.prepare('INSERT OR IGNORE INTO d1_migrations (name, applied_at) VALUES (?, ?)');
    for (const f of FILES) if (f < upTo) ins.run(f, 'x');
  };

  it('L1: an index or trigger on the tables in another case, or another table’s trigger naming them in capitals, is in the snapshot and caught', async () => {
    for (const [what, extra, finding] of [
      ['a RAISE(IGNORE) trigger ON APP_CHANGES', 'CREATE TRIGGER quiet_drop BEFORE INSERT ON APP_CHANGES BEGIN SELECT RAISE(IGNORE); END;', /UNEXPECTED trigger quiet_drop \(on (APP_CHANGES|app_changes)\)/u],
      ['a scopes trigger writing APP_CHANGES', "CREATE TRIGGER sneaky_scope AFTER UPDATE ON scopes BEGIN DELETE FROM APP_CHANGES WHERE seq < 0; END;", /UNEXPECTED trigger sneaky_scope \(on scopes\)/u],
      ['an index on Guarded_Changes', 'CREATE INDEX odd_index ON Guarded_Changes (proposed_at);', /UNEXPECTED index odd_index/u],
    ] as const) {
      const db = populated('0022');
      const before = await snap(db);
      applyRange(db, '0022', '0027');
      db.exec(`${UNCHECKED}\n${extra}`);
      const c = compareSnapshots(before, await snap(db), REFERENCE);
      expect(c.verdict, what).toBe('roll_back');
      expect(c.lines.join('\n'), what).toMatch(finding);
    }
  });

  it('L5: a snapshot already taken after 0027 is warned about, and “identical” says it proves nothing', async () => {
    const db = populated();
    db.exec(MIGRATION);
    const a = await snap(db);
    const c = compareSnapshots(a, await snap(db), REFERENCE);
    expect(c.verdict).toBe('identical');
    expect(c.lines.join('\n')).toContain("WARNING: the snapshot before already has 0027's triggers");
    expect(c.lines.at(-1)).toContain('says nothing about the migration itself');
  });

  describe('L2: the checkout and the database must belong to the snapshots (exit 2, “can’t judge”)', () => {
    const run = () => {
      const db = populated('0022');
      recordApplied(db, '0022');
      const files = new Map<string, unknown>();
      const lines: string[] = [];
      let t = NOW;
      const co: Checkout = { commit: 'a'.repeat(40), migrationsDirty: false, migrationFiles: FILES };
      const deps: LedgerCheckDeps = {
        manifest: () => ({ network: 'testnet', d1Name: 'hana-id-sandbox-dev' }),
        read: (_e, _d, st) => reader(db)(st),
        feedState: async () => ({ get: async () => new Map(), set: async () => undefined, close: async () => undefined }),
        secretsEnvDir: (env) => `/repo/.secrets/${env}`,
        writeJson: (f, v) => files.set(f, JSON.parse(JSON.stringify(v))),
        readJson: (f) => files.get(f),
        log: (l) => lines.push(l),
        now: () => new Date((t += 60_000)),
        referenceSchema: () => REFERENCE,
        checkout: () => ({ ...co }),
      };
      const migrate = () => {
        applyRange(db, '0022', '0028');
        recordApplied(db, '0028');
      };
      return { db, files, lines, co, deps, migrate };
    };
    const B = '/repo/.secrets/sandbox-dev/b.json';
    const compare = (deps: LedgerCheckDeps, ...extra: string[]) => ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', B, ...extra], deps);

    it('the snapshot records the commit, whether the migrations were dirty, and what the database recorded; the same commit compares', async () => {
      const r = run();
      expect(await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', B], r.deps)).toBe(0);
      const snapFile = r.files.get(B) as LedgerSnapshot;
      expect(snapFile.checkout).toEqual({ commit: 'a'.repeat(40), migrationsDirty: false });
      expect(snapFile.applied).toEqual(FILES.filter((f) => f < '0022'));
      r.migrate();
      expect(await compare(r.deps)).toBe(VERDICT_EXIT.identical);
      expect(r.lines.at(-1)).toContain('Verdict: identical');
    });

    it('another commit: can’t judge (exit 2), unless --other-commit, which prints both commits', async () => {
      const r = run();
      await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', B], r.deps);
      r.migrate();
      r.co.commit = 'b'.repeat(40);
      expect(await compare(r.deps)).toBe(2);
      expect(r.lines.join('\n')).toMatch(/CAN'T JUDGE: the snapshot before was taken at a{40}, this checkout is at b{40}/u);
      expect(r.lines.at(-1)).toContain("Verdict: can't judge");
      expect(await compare(r.deps, '--other-commit')).toBe(0);
      expect(r.lines.join('\n')).toMatch(/--other-commit: the snapshot before is from a{40}, this checkout is b{40}/u);
    });

    it('uncommitted migrations, now or when the snapshot was taken: can’t judge, even with --other-commit', async () => {
      const r = run();
      r.co.migrationsDirty = true;
      await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', B], r.deps);
      expect(r.lines.join('\n')).toContain('WARNING: apps/api/migrations has uncommitted changes');
      r.migrate();
      expect(await compare(r.deps, '--other-commit')).toBe(2);
      r.co.migrationsDirty = false;
      expect(await compare(r.deps, '--other-commit')).toBe(2);
      expect(r.lines.join('\n')).toContain('taken from a checkout with uncommitted changes in apps/api/migrations');
    });

    it('a migration the database recorded that this checkout doesn’t have, or no d1_migrations: can’t judge', async () => {
      const r = run();
      await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', B], r.deps);
      r.migrate();
      r.db.exec("INSERT INTO d1_migrations (name, applied_at) VALUES ('0031_from_elsewhere.sql', 'x')");
      expect(await compare(r.deps)).toBe(2);
      expect(r.lines.join('\n')).toContain("the database recorded migration(s) this checkout doesn't have: 0031_from_elsewhere.sql");
      r.db.exec('DROP TABLE d1_migrations');
      expect(await compare(r.deps)).toBe(2);
      expect(r.lines.join('\n')).toContain('the database has no d1_migrations table');
    });

    it('a locally edited 0027, applied and used as the reference, is refused (dirty), never “identical”', async () => {
      const r = run();
      await ledgerCheck(['sandbox-dev', 'snapshot', '--remote', '--out', B], r.deps);
      applyRange(r.db, '0022', '0027');
      r.db.exec(`${UNCHECKED}\nCREATE TRIGGER quiet BEFORE INSERT ON app_changes BEGIN SELECT RAISE(IGNORE); END;`);
      recordApplied(r.db, '0028');
      r.co.migrationsDirty = true; // the edit is in apps/api/migrations
      expect(await compare(r.deps)).toBe(2);
      expect(r.lines.join('\n')).not.toContain('Verdict: identical');
    });

    it('the CLI checks the real git checkout (rev-parse HEAD, status --porcelain apps/api/migrations) and passes --other-commit', () => {
      const cli = readFileSync(join(repoRoot, 'scripts', 'ledger-check.ts'), 'utf8');
      expect(cli).toMatch(/git\('rev-parse', 'HEAD'\)/u);
      expect(cli).toMatch(/git\('status', '--porcelain', '--untracked-files=all', '--', 'apps\/api\/migrations'\)/u);
      expect(VERDICT_EXIT).toEqual({ identical: 0, kept: 0, roll_back: 1, not_applied: 1, cannot_judge: 2, unknown_level: 3 });
    });
  });
});
