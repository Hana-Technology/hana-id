// ledger-check (lib/ledger-check.ts, D916): the before-and-after comparison around migration 0027, on node:sqlite with
// the real migrations and rows of every kind the three tables have held. The real migration comes back `identical`;
// a broken rebuild (a row lost, a row changed, seq renumbered, an index or trigger dropped or altered) comes back
// `roll_back`; the running jobs' writes in between (a notice acknowledged, an event emailed, new rows) come back
// `kept`; a database the migration never reached `not_applied`. Paging doesn't change a hash, and no snapshot holds a
// row's value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { APP_CHANGE_KINDS, SECURITY_EVENT_KINDS } from '@hana-id/console-core';
import { describe, expect, it } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { type FeedState, type LedgerCheckDeps, type LedgerSnapshot, FEED_CURSOR_KEYS, KIND_TRIGGERS, LEDGER_TABLES, compareSnapshots, ledgerCheck, lifecycleProblem, pageSql, takeSnapshot } from '../lib/ledger-check.ts';
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

/** A hot DB before 0027 with rows of every kind each ledger table has held. */
function populated(): DatabaseSync {
  const db = newHotDb({ before: '0027' });
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
  SECURITY_EVENT_KINDS.filter((k) => !['platform_quota', 'platform_auth_failures', 'link_lookup_volume', 'shared_wallet_policy', 'shared_scope_unmarked'].includes(k)).forEach((k, i) => se.run(`se_${k}`, NOW - i, k, i % 2 ? 'org_a' : null, '{}', i % 2 ? NOW : null));
  return db;
}

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
    const broken: [string, (sql: string) => string, RegExp][] = [
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
    for (const [what, mutate, finding] of broken) {
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
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/v1.json'], deps)).rejects.toThrow(/not a hana-id\/ledger-check\/v2 snapshot/u);
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
