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
import { type LedgerCheckDeps, type LedgerSnapshot, KIND_TRIGGERS, LEDGER_TABLES, compareSnapshots, ledgerCheck, pageSql, takeSnapshot } from '../lib/ledger-check.ts';
import { MIGRATIONS_DIR, newHotDb } from './hot-db.ts';

const MIGRATION = readFileSync(join(MIGRATIONS_DIR, '0027_platform_actor.sql'), 'utf8');
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
  SECURITY_EVENT_KINDS.filter((k) => !['platform_quota', 'platform_auth_failures', 'link_lookup_volume'].includes(k)).forEach((k, i) => se.run(`se_${k}`, NOW - i, k, i % 2 ? 'org_a' : null, '{}', i % 2 ? NOW : null));
  return db;
}

const reader = (db: DatabaseSync) => (s: string) => db.prepare(s).all() as Record<string, unknown>[];
const snap = (db: DatabaseSync, pageSize = 7): Promise<LedgerSnapshot> => takeSnapshot(reader(db), { env: 'sandbox-dev', remote: true, now: new Date(NOW), pageSize });

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

  it('a rebuild that loses a row, changes one, renumbers seq, or drops or alters an index or trigger: roll back', async () => {
    const broken: [string, (sql: string) => string, RegExp][] = [
      ['a lost ledger row', (s) => s.replace('FROM app_changes;', 'FROM app_changes WHERE seq <> 70000;'), /app_changes: .*\n {2}LOST: 1 row\(s\)/u],
      ['a lost guarded change', (s) => s.replace('FROM guarded_changes;', "FROM guarded_changes WHERE id <> 'gc_007';"), /LOST: 1 row\(s\) of before are gone \(first ids: gc_007\)/u],
      ['a changed ledger row', (s) => s.replace('SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind', "SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, CASE actor_kind WHEN 'link' THEN 'system' ELSE actor_kind END"), /CHANGED: \d+ row\(s\) differ in a column no job writes \(the table is append-only\)/u],
      ['a changed proposer', (s) => s.replace('proposed_at, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id FROM guarded_changes', 'proposed_at + 1, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id FROM guarded_changes'), /guarded_changes: .*\n {2}CHANGED: 36/u],
      ['seq renumbered', (s) => s.replace('SELECT seq, at, org_id', 'SELECT NULL, at, org_id'), /SEQ: /u],
      ['a dropped index', (s) => s.replace('CREATE INDEX guarded_changes_due ON guarded_changes (status, active_from);', ''), /MISSING index guarded_changes_due/u],
      ['an altered trigger', (s) => s.replace("'-60 months') * 1000)\nBEGIN\n  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months')", "'-6 months') * 1000)\nBEGIN\n  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months')"), /CHANGED trigger app_changes_no_early_delete/u],
    ];
    for (const [what, mutate, finding] of broken) {
      const db = populated();
      const before = await snap(db);
      const bad = mutate(MIGRATION);
      expect(bad, what).not.toBe(MIGRATION);
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
    expect(text).toMatch(/1 row\(s\) moved on by a job since \(they differ only in columns a job writes: status, waiver, notified_at, active_from, cancel_token_hash, .*first ids: gc_001\)/u);
    expect(text).toMatch(/security_events: .*\n {2}1 row\(s\) moved on by a job since \(they differ only in columns a job writes: notified_at; first ids: se_drift\)\.\n {2}1 row\(s\) written since/u);
    expect(text).toMatch(/app_changes: \d+ → \d+ rows, max\(seq\) 70000 → 70001; hash changed .*\n {2}1 row\(s\) written since/u);
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
    expect(pageSql(t, undefined, 2)).toMatch(/^SELECT id, app_id, .*hex\(cancel_token_hash\) AS cancel_token_hash, .* FROM guarded_changes ORDER BY id LIMIT 2$/u);
    expect(pageSql(t, "gc_'x", 2)).toContain("WHERE id > 'gc_''x' ORDER BY id LIMIT 2");
    expect(pageSql(LEDGER_TABLES[0]!, 41, 500)).toBe('SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id FROM app_changes WHERE seq > 41 ORDER BY seq LIMIT 500');
  });
});

describe('ledger-check: the CLI', () => {
  const setup = (db: DatabaseSync) => {
    const files = new Map<string, unknown>();
    const lines: string[] = [];
    let t = NOW;
    const deps: LedgerCheckDeps = {
      read: (_env, s) => reader(db)(s),
      secretsEnvDir: (env) => `/repo/.secrets/${env}`,
      writeJson: (f, v) => files.set(f, JSON.parse(JSON.stringify(v))),
      readJson: (f) => {
        if (!files.has(f)) throw new Error(`no ${f}`);
        return files.get(f);
      },
      log: (l) => lines.push(l),
      now: () => new Date((t += 60_000)),
    };
    return { files, lines, deps };
  };

  it('snapshot, migrate, compare: exit 0, files under .secrets/<env>/, hashes printed, no row printed', async () => {
    const db = populated();
    const { files, lines, deps } = setup(db);
    expect(await ledgerCheck(['sandbox-dev', 'snapshot', '--remote'], deps)).toBe(0);
    const [first] = [...files.keys()];
    expect(first).toMatch(/^\/repo\/\.secrets\/sandbox-dev\/ledger-snapshot-20261125T030100000Z\.json$/u);
    db.exec(MIGRATION);
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', first!], deps)).toBe(0);
    expect([...files.keys()][1]).toMatch(/ledger-after-/u);
    const out = lines.join('\n');
    expect(out).toMatch(/app_changes: \d+ rows, max\(seq\) 70000, sha256 [0-9a-f]{64}/u);
    expect(out).toContain("0027's kind triggers present");
    expect(out).toContain('Verdict: identical.');
    expect(out).not.toContain(SECRETISH);
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
    await expect(ledgerCheck(['sandbox-dev', 'compare', '--remote'], deps)).rejects.toThrow(CliError);
    await expect(ledgerCheck(['sandbox-dev', 'apply'], deps)).rejects.toThrow(CliError);
    db.exec(MIGRATION.replace('FROM security_events;', "FROM security_events WHERE id <> 'se_drift';"));
    expect(await ledgerCheck(['sandbox-dev', 'compare', '--remote', '--before', '/repo/.secrets/sandbox-dev/b.json'], deps)).toBe(1);
    expect(lines.at(-1)).toMatch(/Verdict: ROLL BACK/u);
  });
});
