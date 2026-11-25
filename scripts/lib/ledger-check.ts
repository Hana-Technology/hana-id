// ledger-check.ts's body (D916; docs/partner-platform-spec.md A7, the deploy step of M9): a before-and-after comparison
// of the hot DB's ledger tables around a rebuild of them (migration 0027: `app_changes`, `guarded_changes`,
// `security_events`), so a rebuild that lost, changed or reordered a row, or dropped a rule, an index or a trigger, is
// seen at once and rolled back to the Time Travel bookmark taken before it (docs/operations.md "Ledger rebuild").
//
//   ledger-check <env> snapshot [--remote] [--d1-name <rehearsal db>] [--out <file>]
//   ledger-check <env> compare --before <file> [--remote] [--d1-name <rehearsal db>] [--out <file>]
//   ledger-check <env> feed-cursor --remote --before <snapshot file> [--yes]
//
// D1 has no hash function, so every row is read here, a page at a time in its key's order, and hashed locally with
// SHA-256: per table, the hash of every row's canonical JSON in order (the spec's aggregate hash), the row count and,
// for `app_changes`, max(seq); per row, two short hashes (all columns, and the columns no job ever updates) and the
// state of each column a job writes (NULL or a short hash of it; `status` as itself). A comparison then tells a row
// the rebuild damaged from one a running job moved on since (the API keeps running while the migration applies):
// only the moves the API's jobs make pass (`lifecycleProblem`). The tables' own SQL, their indexes and their triggers
// are compared too (`sqlite_schema`).
//
// The snapshot may be taken at any migration level from 0021 (sandbox-dev's D1 on 2026-11-25) to 0026, so one
// snapshot comes before a single `migrations apply` of 0022 to 0027 (D924): the expected after-SQL is the before-SQL
// changed by exactly what the migrations in between are known to change (`SECURITY_EVENT_KIND_STEPS`, held to the
// migration files by the tests). A relative `--before` or `--out` is relative to where the command was run (INIT_CWD).
//
// The rows are read like every statement that can hold personal data (`apiPrivateD1Execute`, D316): remotely through
// D1's REST API with the statement in the HTTPS body, locally from a 0600 file with wrangler's log file off, so no
// row lands in `~/.wrangler/logs`. A snapshot holds counts, hashes and statuses, never a row's value; it is written
// 0600 under `.secrets/<env>/` all the same. Nothing here prints a row or a value of one.
//
// `feed-cursor` is the rollback's last step: a Time Travel restore takes the hot DB back but not the admin feed's
// cursor in Neon (`ops.state` `feed.app_changes.seq`), which would then sit above the restored max(seq), so the rows
// written after the restore (which reuse those seqs) would never be emailed. It lowers the cursor (and an unfinished
// first walk's place) to the max(seq) of the snapshot taken before the migration (at most the restored one), never
// raises it: rows between that snapshot and the bookmark may be emailed a second time, none is skipped.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CliError, parseCli } from './cli.ts';
import { type SqlParam, sqlValue } from './sql.ts';

export const LEDGER_CHECK_USAGE = `Usage: ledger-check.ts <env> snapshot [--remote] [--d1-name <name>] [--out <file>]
       ledger-check.ts <env> compare --before <snapshot file> [--remote] [--d1-name <name>] [--out <file>] [--other-commit]
       ledger-check.ts <env> feed-cursor --remote --before <snapshot file> [--yes]
  snapshot     reads app_changes, guarded_changes and security_events (every row, in key order), their SQL, indexes and
               triggers; writes counts, max(seq), hashes and statuses (never a row's value) to .secrets/<env>/ (0600)
  compare      takes a new snapshot and compares it with --before: exits 1 when a row was lost or changed by anything
               but a running job's own move, a seq moved, a table's SQL is not the expected one, or an index or
               trigger is missing or changed (roll back to the bookmark), or when migration 0027 did not apply
  feed-cursor  after a Time Travel restore of the API's D1: lowers the admin feed's cursor in Neon
               (ops.state feed.app_changes.seq, and its .init) to the snapshot's max(seq) (--before; at most the
               restored max(seq)); without --yes, shows the plan
  --remote     the deployed database (default: local, wrangler dev's state, as admin.ts)
  --d1-name    a rehearsal database (its name must contain "rehearsal"; remote only), instead of the env's own
  --other-commit  compare a snapshot taken at another commit (both commits are printed)
  exit codes   0 identical or kept; 1 roll back or not applied; 2 can't judge (another commit, uncommitted
               migrations, a migration the checkout doesn't have); 3 unknown level`;

/** A table the check reads: its key (the order rows are read and hashed in), its columns, and those jobs update. */
export interface LedgerTable {
  name: 'app_changes' | 'guarded_changes' | 'security_events';
  key: string;
  numericKey: boolean;
  /** Every column, in the table's order. BLOB columns are read as hex(…) so the JSON is exact. */
  columns: readonly string[];
  blobs: readonly string[];
  /** Columns a running job legitimately updates (lifecycle); every other column is fixed once the row is written. */
  mutable: readonly string[];
}

export const LEDGER_TABLES: readonly LedgerTable[] = [
  {
    name: 'app_changes',
    key: 'seq',
    numericKey: true,
    columns: ['seq', 'at', 'org_id', 'app_id', 'scope_id', 'kind', 'detail_json', 'actor_kind', 'actor_id', 'actor_sub', 'request_id'],
    blobs: [],
    // Append-only (app_changes_no_update): nothing.
    mutable: [],
  },
  {
    name: 'guarded_changes',
    key: 'id',
    numericKey: false,
    columns: [
      'id', 'app_id', 'kind', 'origin', 'policy_json', 'policy_id', 'status', 'proposed_by_kind', 'proposed_by', 'proposer_sub', 'proposed_at', 'request_country', 'waiver',
      'notified_at', 'active_from', 'cancel_token_hash', 'activated_recorded_at', 'expedited_by', 'expedite_reason', 'ended_at', 'cancelled_by', 'cancelled_at', 'request_id',
    ],
    blobs: ['cancel_token_hash'],
    // The lifecycle (lifecycleProblem lists each writer): the notice's ack, expedite, activation, end, cancel.
    mutable: ['status', 'waiver', 'notified_at', 'active_from', 'cancel_token_hash', 'activated_recorded_at', 'expedited_by', 'expedite_reason', 'ended_at', 'cancelled_by', 'cancelled_at'],
  },
  {
    name: 'security_events',
    key: 'id',
    numericKey: false,
    columns: ['id', 'detected_at', 'kind', 'org_id', 'app_id', 'scope_id', 'detail_json', 'notified_at'],
    blobs: [],
    // The admin Worker marks an event emailed.
    mutable: ['notified_at'],
  },
];

/** The triggers migration 0027 adds; their presence is how `compare` knows the migration applied. */
export const KIND_TRIGGERS = ['app_changes_actor_kind', 'app_changes_no_replace', 'guarded_changes_proposer_kind', 'guarded_changes_proposer_kind_update'] as const;

/**
 * `security_events`' kind CHECK at the deployed level (sandbox-dev's D1 through 0021, 2026-11-25) and the kinds each
 * later migration that rebuilds the table appends to it, in order. 0022 to 0025 and 0027 rebuild `security_events` to
 * widen that one CHECK and nothing else (every column, row and the index copied as they were); 0026 doesn't touch it.
 * None of 0022 to 0026 touches `app_changes` or `guarded_changes`, or writes a row in any of the three
 * (scripts/test/ledger-check.test.ts holds this list to the migration files). So one snapshot taken at any level from
 * 0021 to 0026 can be compared after a single `migrations apply` of everything up to 0027 (D924).
 */
export const SECURITY_EVENT_KINDS_AT_0021: readonly string[] = ['drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low'];
export const SECURITY_EVENT_KIND_STEPS: readonly { migration: string; added: readonly string[] }[] = [
  { migration: '0022', added: ['evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late', 'evm_relay_closed_slot_mined'] },
  { migration: '0023', added: ['near_billing_late', 'neon_compute_high'] },
  { migration: '0024', added: ['evm_relay_auto_resumed'] },
  { migration: '0025', added: ['label_proposed', 'label_blocked', 'label_live'] },
  { migration: '0027', added: ['platform_quota', 'platform_auth_failures', 'link_lookup_volume', 'shared_wallet_policy', 'shared_scope_unmarked'] },
];

/** The kind list after each level: index 0 is 0021's, index i the list after SECURITY_EVENT_KIND_STEPS[i - 1]. */
const KIND_LEVELS: readonly (readonly string[])[] = SECURITY_EVENT_KIND_STEPS.reduce<string[][]>((acc, s) => [...acc, [...acc.at(-1)!, ...s.added]], [[...SECURITY_EVENT_KINDS_AT_0021]]);
const KIND_CHECK_RE = /CHECK \(kind IN \(([^)]*)\)\)/gu;
const kindListSql = (kinds: readonly string[]): string => `CHECK (kind IN (${kinds.map((k) => `'${k}'`).join(', ')}))`;

/**
 * Which known level a `security_events` CREATE statement's kind CHECK is at: `'0021'`, or the migration of the step
 * whose list it has; null for a statement with no single kind CHECK or a list that is no known level (a rollback).
 */
export function securityEventsLevel(sql: string): string | null {
  const found = [...sql.matchAll(KIND_CHECK_RE)];
  if (found.length !== 1) return null;
  const at = KIND_LEVELS.findIndex((l) => kindListSql(l) === found[0]![0]);
  if (at < 0) return null;
  return at === 0 ? '0021' : SECURITY_EVENT_KIND_STEPS[at - 1]!.migration;
}

/**
 * A table's SQL expected after the migrations between two snapshots, from the snapshot before:
 * - `app_changes`, `guarded_changes`: unchanged until 0027; across 0027 the rename quotes the name and the kind CHECK
 *   that moved to a trigger is gone;
 * - `security_events`: the before statement with its kind list grown, by exactly the steps above, to the list of the
 *   level `toLevel` ('0021' … '0027'); a before list at no known level, or a level going backwards, gives null.
 * Anything else that differs (a CHECK, NOT NULL, default, UNIQUE or column dropped or changed) is a rollback.
 */
export function expectedTableSql(name: LedgerTable['name'], before: string, across0027: boolean, toLevel: string): string | null {
  if (name === 'app_changes') return across0027 ? before.replace('CREATE TABLE app_changes (', 'CREATE TABLE "app_changes" (').replace(" CHECK (actor_kind IN ('member', 'hana', 'system', 'link'))", '') : before;
  if (name === 'guarded_changes') return across0027 ? before.replace('CREATE TABLE guarded_changes (', 'CREATE TABLE "guarded_changes" (').replace(" CHECK (proposed_by_kind IN ('member', 'hana', 'system'))", '') : before;
  const from = securityEventsLevel(before);
  const levels = ['0021', ...SECURITY_EVENT_KIND_STEPS.map((s) => s.migration)];
  const i = from === null ? -1 : levels.indexOf(from);
  const j = levels.indexOf(toLevel);
  if (i < 0 || j < i) return null;
  return before.replace(kindListSql(KIND_LEVELS[i]!), kindListSql(KIND_LEVELS[j]!));
}

/** A row in a snapshot: its hashes and (for a table jobs update) the state of each job-written column. */
export interface RowMark {
  full: string;
  fixed: string;
  /** Aligned with the table's `mutable`: `status` as itself, any other column null when NULL, else a short hash. */
  state?: (string | null)[];
}

export interface TableSnapshot {
  rows: number;
  /** max(seq) for `app_changes`; null for the others. */
  maxSeq: number | null;
  /** SHA-256 (hex) over every row's canonical JSON line, in key order. */
  sha256: string;
  byKey: Record<string, RowMark>;
}

export const SNAPSHOT_FORMAT = 'hana-id/ledger-check/v3';

export interface LedgerSnapshot {
  format: typeof SNAPSHOT_FORMAT;
  env: string;
  /** The D1 database read: the env's own, or a rehearsal database (`--d1-name`). */
  database: string;
  remote: boolean;
  takenAt: string;
  tables: Record<string, TableSnapshot>;
  /** The three tables, their indexes and their triggers (automatic indexes have no SQL: null), by name. */
  /** `file` (a reference only, D929): the migration that creates the object. */
  schema: Record<string, { type: string; table: string; sql: string | null; file?: string }>;
  /** The migrations the database has recorded (`d1_migrations`, by name), or null without that table (a test). */
  applied: string[] | null;
  /** The checkout the snapshot was taken from (the CLI): its commit and whether its `apps/api/migrations` was dirty. */
  checkout: { commit: string; migrationsDirty: boolean } | null;
}

/** The checkout `ledger-check` runs from: HEAD, whether `apps/api/migrations` has changes, and its migration files. */
export interface Checkout {
  commit: string;
  migrationsDirty: boolean;
  migrationFiles: string[];
}

/** Runs one SELECT on the API's D1 and returns its rows (apiPrivateD1Execute, or node:sqlite in tests). */
export type LedgerRead = (statement: string) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const short = (s: string): string => sha(s).slice(0, 32);

/** One value as it goes into the canonical JSON (numbers as numbers, NULL as null). */
function cell(t: LedgerTable, row: Record<string, unknown>, c: string): string | number | null {
  const v = row[c];
  if (v === undefined) throw new Error(`${t.name}: the read returned no column ${c}`);
  if (typeof v === 'bigint') return v.toString();
  if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new Error(`${t.name}.${c}: unexpected value type ${typeof v}`);
  return v;
}

/** One row's columns as canonical JSON: an array in the table's column order. */
export function canonicalRow(t: LedgerTable, row: Record<string, unknown>, columns: readonly string[] = t.columns): string {
  return JSON.stringify(columns.map((c) => cell(t, row, c)));
}

/**
 * The page query: every column (BLOBs as upper-case hex, NULL kept NULL: `hex(NULL)` is '', which would make a cleared
 * hash look like an empty one), after the last key read, in key order.
 */
export function pageSql(t: LedgerTable, after: SqlParam | undefined, pageSize: number): string {
  const cols = t.columns.map((c) => (t.blobs.includes(c) ? `CASE WHEN ${c} IS NULL THEN NULL ELSE hex(${c}) END AS ${c}` : c)).join(', ');
  const where = after === undefined ? '' : ` WHERE ${t.key} > ${sqlValue(after)}`;
  return `SELECT ${cols} FROM ${t.name}${where} ORDER BY ${t.key} LIMIT ${pageSize}`;
}

/**
 * The three tables, their indexes and triggers, and every other table's trigger whose body names one of them (a DROP
 * TABLE of a rebuild drops none of those, and a rename checks them: they must come out word for word). Matched in any
 * case (SQLite's names are case-insensitive: a trigger `ON APP_CHANGES` is on the table, after PR 151's review).
 */
export const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE (type IN ('table', 'index', 'trigger') AND lower(tbl_name) IN ('app_changes', 'guarded_changes', 'security_events')) OR (type = 'trigger' AND (instr(lower(sql), 'app_changes') > 0 OR instr(lower(sql), 'guarded_changes') > 0 OR instr(lower(sql), 'security_events') > 0)) ORDER BY name";

async function snapshotTable(read: LedgerRead, t: LedgerTable, pageSize: number): Promise<TableSnapshot> {
  const all = createHash('sha256');
  const byKey: TableSnapshot['byKey'] = {};
  const fixedCols = t.columns.filter((c) => !t.mutable.includes(c));
  let rows = 0;
  let maxSeq: number | null = null;
  let after: SqlParam | undefined;
  for (;;) {
    const page = await read(pageSql(t, after, pageSize));
    for (const r of page) {
      const line = canonicalRow(t, r);
      all.update(`${line}\n`, 'utf8');
      const key = r[t.key];
      if (t.numericKey ? typeof key !== 'number' : typeof key !== 'string') throw new Error(`${t.name}: a row's ${t.key} is not a ${t.numericKey ? 'number' : 'string'}`);
      const k = String(key);
      if (Object.hasOwn(byKey, k)) throw new Error(`${t.name}: the key ${t.key} came back twice (the read is not in key order)`);
      const mark: RowMark = { full: short(line), fixed: short(canonicalRow(t, r, fixedCols)) };
      if (t.mutable.length) {
        mark.state = t.mutable.map((c) => {
          const v = cell(t, r, c);
          if (c === 'status') return String(v);
          return v === null ? null : short(JSON.stringify(v)).slice(0, 16);
        });
      }
      byKey[k] = mark;
      if (t.name === 'app_changes') maxSeq = Math.max(maxSeq ?? 0, key as number);
      rows += 1;
      after = key as SqlParam;
    }
    if (page.length < pageSize) break;
  }
  return { rows, maxSeq: t.name === 'app_changes' ? maxSeq : null, sha256: all.digest('hex'), byKey };
}

export async function takeSnapshot(read: LedgerRead, o: { env: string; database: string; remote: boolean; now?: Date; pageSize?: number; checkout?: Checkout }): Promise<LedgerSnapshot> {
  const pageSize = o.pageSize ?? 500;
  const tables: Record<string, TableSnapshot> = {};
  for (const t of LEDGER_TABLES) tables[t.name] = await snapshotTable(read, t, pageSize);
  const schema: LedgerSnapshot['schema'] = {};
  for (const r of await read(SCHEMA_SQL)) schema[String(r.name)] = { type: String(r.type), table: String(r.tbl_name), sql: r.sql === null ? null : String(r.sql) };
  let appliedNames: string[] | null = null;
  const has = await read("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = 'd1_migrations'");
  if (has.length) appliedNames = (await read('SELECT name FROM d1_migrations ORDER BY name')).map((r) => String(r.name));
  return {
    format: SNAPSHOT_FORMAT,
    env: o.env,
    database: o.database,
    remote: o.remote,
    takenAt: (o.now ?? new Date()).toISOString(),
    tables,
    schema,
    applied: appliedNames,
    checkout: o.checkout ? { commit: o.checkout.commit, migrationsDirty: o.checkout.migrationsDirty } : null,
  };
}

/** The status moves a job makes: activation, a close or end (in force), a cancel (not yet in force). */
const STATUS_MOVES: ReadonlySet<string> = new Set(['pending>active', 'pending>cancelled', 'pending>ended', 'active>ended']);

/**
 * Whether one row's job-written columns moved only as the API's and the CLI's own writers move them, between two
 * snapshots (several moves may have happened in between). The writers (apps/api/src/changes, src/guarded/cron.ts,
 * scripts/lib/admin-sql.ts):
 * - the notice's ack (`ackNotice`, the CLI's announce): `notified_at` and `active_from` NULL → set, `waiver` NULL →
 *   set or left NULL, `cancel_token_hash` NULL → set (the API's only); the status stays pending;
 * - expedite: `active_from` changed, `expedited_by` and `expedite_reason` NULL → set;
 * - activation: pending → active, `activated_recorded_at` NULL → set;
 * - an end (a replaced policy, a close of one in force): active or pending → ended, `ended_at` NULL → set;
 * - a cancel (an owner, staff, the link, the hourly job, a close of one not in force): pending → cancelled,
 *   `cancelled_at` and `cancelled_by` NULL → set.
 * `security_events`: `notified_at` NULL → set, nothing else. Returns what broke the rules, or null.
 */
export function lifecycleProblem(t: LedgerTable, before: readonly (string | null)[], after: readonly (string | null)[]): string | null {
  const at = (s: readonly (string | null)[], c: string): string | null => s[t.mutable.indexOf(c)] ?? null;
  const problems: string[] = [];
  for (const c of t.mutable) {
    const b = at(before, c);
    const a = at(after, c);
    if (b === a) continue;
    if (c === 'status') {
      if (!STATUS_MOVES.has(`${b}>${a}`)) problems.push(`status ${b} → ${a}`);
    } else if (a === null) {
      problems.push(`${c} cleared`);
    } else if (b !== null && !(c === 'active_from' && at(before, 'expedited_by') === null && at(after, 'expedited_by') !== null)) {
      problems.push(`${c} changed`);
    }
  }
  if (t.name === 'guarded_changes') {
    const set = (c: string): boolean => at(before, c) === null && at(after, c) !== null;
    const status = at(after, 'status');
    if ((set('active_from') || set('waiver') || set('cancel_token_hash')) && !set('notified_at')) problems.push('announced without notified_at');
    if (set('notified_at') && !set('active_from')) problems.push('notified_at set without active_from');
    if (set('expedited_by') !== set('expedite_reason')) problems.push('expedited_by and expedite_reason apart');
    if (set('activated_recorded_at') && status !== 'active' && status !== 'ended') problems.push(`activated_recorded_at set with status ${status}`);
    if (set('ended_at') && status !== 'ended') problems.push(`ended_at set with status ${status}`);
    if ((set('cancelled_at') || set('cancelled_by')) && status !== 'cancelled') problems.push(`cancelled_* set with status ${status}`);
    if (at(before, 'status') !== status && status === 'cancelled' && !(set('cancelled_at') && set('cancelled_by'))) problems.push('cancelled without cancelled_at and cancelled_by');
    if (at(before, 'status') !== status && status === 'ended' && !set('ended_at')) problems.push('ended without ended_at');
    if (at(before, 'status') === 'pending' && status === 'active' && !set('activated_recorded_at')) problems.push('activated without activated_recorded_at');
  }
  return problems.length ? problems.join(', ') : null;
}

/**
 * `unknown_level`: a snapshot's `security_events` kind list is at no known level (nothing else wrong): don't restore on
 * this alone, find out which migrations the database has. `cannot_judge` (the CLI): the snapshots, the checkout and
 * the database don't belong together (another commit, dirty migrations, a migration this checkout doesn't have).
 */
export type Verdict = 'identical' | 'kept' | 'roll_back' | 'not_applied' | 'unknown_level' | 'cannot_judge';

/** The CLI's exit code per verdict: 0 when the migration is in and every row kept; 2 can't judge; 3 unknown level. */
export const VERDICT_EXIT: Readonly<Record<Verdict, number>> = { identical: 0, kept: 0, roll_back: 1, not_applied: 1, cannot_judge: 2, unknown_level: 3 };

export interface Comparison {
  verdict: Verdict;
  /** What to tell the operator, one finding a line (names, counts, column names and hashes only). */
  lines: string[];
}

const applied = (s: LedgerSnapshot): boolean => KIND_TRIGGERS.every((k) => Object.hasOwn(s.schema, k));

/**
 * Compares a snapshot taken before the migration with one taken after:
 * - `roll_back`: a row of before is gone; a column no job writes changed (any column of an `app_changes` row); a
 *   job-written column moved in a way no job moves it (`lifecycleProblem`); a new `app_changes` row sits at or below
 *   the old max(seq); a table's SQL is not the expected one; an index or trigger of before is gone or changed;
 * - `not_applied`: none of that, but 0027's triggers are not there;
 * - `kept`: every row of before is there, the differences only rows written since or the jobs' own moves;
 * - `identical`: the same counts and table hashes, every index and trigger as before.
 */
export function compareSnapshots(before: LedgerSnapshot, after: LedgerSnapshot, reference?: LedgerSnapshot['schema'], beforeReference?: LedgerSnapshot['schema']): Comparison {
  const lines: string[] = [];
  let broken = false;
  let moved = false;
  if (before.env !== after.env || before.remote !== after.remote || before.database !== after.database) {
    const where = (s: LedgerSnapshot) => `${s.env} ${s.database}${s.remote ? ' remote' : ' local'}`;
    return { verdict: 'roll_back', lines: [`The snapshots are of different databases (${where(before)} and ${where(after)}): nothing compared.`] };
  }
  for (const t of LEDGER_TABLES) {
    const b = before.tables[t.name];
    const a = after.tables[t.name];
    if (!b || !a) {
      broken = true;
      lines.push(`${t.name}: missing from a snapshot.`);
      continue;
    }
    const gone = Object.keys(b.byKey).filter((k) => !Object.hasOwn(a.byKey, k));
    const fixedChanged: string[] = [];
    const badMoves: string[] = [];
    const lifecycle: string[] = [];
    for (const [k, h] of Object.entries(b.byKey)) {
      const n = a.byKey[k];
      if (!n || n.full === h.full) continue;
      if (n.fixed !== h.fixed) {
        fixedChanged.push(k);
        continue;
      }
      const problem = h.state && n.state ? lifecycleProblem(t, h.state, n.state) : 'no column state recorded';
      if (problem) badMoves.push(`${k} (${problem})`);
      else lifecycle.push(k);
    }
    const added = Object.keys(a.byKey).filter((k) => !Object.hasOwn(b.byKey, k));
    const renumbered = t.name === 'app_changes' && b.maxSeq !== null ? added.filter((k) => Number(k) <= b.maxSeq!) : [];
    const same = a.rows === b.rows && a.sha256 === b.sha256;
    lines.push(`${t.name}: ${b.rows} → ${a.rows} rows${t.name === 'app_changes' ? `, max(seq) ${b.maxSeq ?? 'none'} → ${a.maxSeq ?? 'none'}` : ''}; hash ${same ? 'unchanged' : 'changed'} (${a.sha256.slice(0, 16)}…).`);
    if (gone.length) {
      broken = true;
      lines.push(`  LOST: ${gone.length} row(s) of before are gone (first ${t.key}s: ${gone.slice(0, 5).join(', ')}).`);
    }
    if (fixedChanged.length) {
      broken = true;
      lines.push(`  CHANGED: ${fixedChanged.length} row(s) differ in a column no job writes${t.mutable.length ? '' : ' (the table is append-only)'} (first ${t.key}s: ${fixedChanged.slice(0, 5).join(', ')}).`);
    }
    if (badMoves.length) {
      broken = true;
      lines.push(`  MOVED WRONG: ${badMoves.length} row(s) changed in a way no job changes them (first: ${badMoves.slice(0, 5).join('; ')}).`);
    }
    if (renumbered.length) {
      broken = true;
      lines.push(`  SEQ: ${renumbered.length} new row(s) at or below the old max(seq) ${b.maxSeq} (first: ${renumbered.slice(0, 5).join(', ')}): seq was renumbered.`);
    }
    if (t.name === 'app_changes' && b.maxSeq !== null && (a.maxSeq ?? 0) < b.maxSeq) {
      broken = true;
      lines.push(`  SEQ: max(seq) went down.`);
    }
    if (lifecycle.length) {
      moved = true;
      lines.push(`  ${lifecycle.length} row(s) moved on by a job since (only as the jobs move them: ${t.mutable.join(', ')}; first ${t.key}s: ${lifecycle.slice(0, 5).join(', ')}).`);
    }
    if (added.length - renumbered.length > 0) {
      moved = true;
      lines.push(`  ${added.length - renumbered.length} row(s) written since.`);
    }
  }
  // The tables' own SQL: the same, or (across the migration) the old one less the moved CHECK, nothing else.
  // The level each snapshot is at (D924): read from security_events' kind list, so a snapshot taken before 0022 to 0026
  // compares after one `migrations apply` of them and 0027; the after level must agree with 0027's triggers.
  const migrated = !applied(before) && applied(after);
  const fromLevel = before.schema.security_events?.sql ? securityEventsLevel(before.schema.security_events.sql) : null;
  const toLevel = after.schema.security_events?.sql ? securityEventsLevel(after.schema.security_events.sql) : null;
  let unknownLevel = false;
  if (fromLevel !== null && toLevel !== null && fromLevel !== toLevel) lines.push(`security_events' kinds: at migration ${fromLevel} before, ${toLevel} after (the kinds the migrations in between add).`);
  // A kind list at no known level is its own finding, not a damaged rebuild (after PR 151's review, L4), except after
  // 0027: its triggers present means 0027 rebuilt security_events (one transaction), so its list must be 0027's, and
  // any other is that rebuild's damage.
  if (applied(after) && !applied(before) && toLevel !== '0027' && after.schema.security_events?.sql) {
    broken = true;
    lines.push(`CHANGED table security_events: 0027's triggers are present but its kind list is ${toLevel === null ? 'at no known level' : `at ${toLevel}`}, not 0027's (the rebuild left a kind out or changed the CHECK).`);
  } else {
    for (const [which, level, snap] of [['before', fromLevel, before], ['after', toLevel, after]] as const) {
      if (level === null && snap.schema.security_events?.sql) {
        unknownLevel = true;
        lines.push(`UNKNOWN LEVEL: security_events' kind list ${which} is at no migration level this checkout knows (SECURITY_EVENT_KIND_STEPS): which migrations does the database have?`);
      }
    }
  }
  // A snapshot taken after 0027 can't show what 0027 did (L5).
  const lateBefore = applied(before);
  if (lateBefore) lines.push("WARNING: the snapshot before already has 0027's triggers: it was taken after the migration, so this comparison proves nothing about 0027.");
  if (toLevel !== null && toLevel === '0027' && !applied(after)) {
    broken = true;
    lines.push(`CHANGED schema: security_events' kinds are at ${toLevel} but 0027's triggers are ${applied(after) ? 'present' : 'absent'}.`);
  }
  for (const t of LEDGER_TABLES) {
    const b = before.schema[t.name];
    const a = after.schema[t.name];
    if (!b?.sql || !a?.sql) {
      broken = true;
      lines.push(`MISSING table ${t.name} in the schema.`);
      continue;
    }
    // security_events at an unknown level is reported above, once; the other two don't depend on the level.
    if (t.name === 'security_events' && (fromLevel === null || toLevel === null || (applied(after) && !applied(before) && toLevel !== '0027'))) continue;
    const expected = expectedTableSql(t.name, b.sql, migrated, toLevel ?? '0027');
    if (a.sql !== expected) {
      broken = true;
      const what = t.name === 'security_events' ? `the old one with the kinds of the migrations between (${fromLevel ?? 'unknown level'} → ${toLevel ?? 'unknown level'}) added` : migrated ? 'the old one less the CHECK 0027 moves' : 'the same as before';
      lines.push(`CHANGED table ${t.name}: its SQL is not ${what} (a column, CHECK, NOT NULL, default or key differs).`);
    }
  }
  for (const [name, s] of Object.entries(before.schema)) {
    if (s.type === 'table') continue;
    const n = after.schema[name];
    if (!n) {
      broken = true;
      lines.push(`MISSING ${s.type} ${name} (on ${s.table}).`);
    } else if (n.sql !== s.sql || n.table !== s.table || n.type !== s.type) {
      // D931: a trigger a later migration replaces (0034's of 0033's) reads as replaced, not changed, when the before
      // SQL is the checkout's at the level the snapshot before recorded and the after SQL the one at the level after.
      const was = beforeReference?.[name];
      const now = reference?.[name];
      if (was && now && was.sql === s.sql && was.table === s.table && was.type === s.type && now.sql === n.sql && now.table === n.table && now.type === n.type && now.file !== was.file) {
        lines.push(`Replaced by a later migration: ${s.type} ${name} (${now.file}).`);
      } else {
        broken = true;
        lines.push(`CHANGED ${s.type} ${name}: its SQL differs from before.`);
      }
    }
  }
  const addedSchema = Object.keys(after.schema).filter((k) => !Object.hasOwn(before.schema, k));
  if (addedSchema.length) lines.push(`New since: ${addedSchema.sort().join(', ')}.`);
  // With the checkout's migrations as the reference (the CLI always passes it, D924), an index or trigger that appeared
  // in between must be one those migrations create, word for word: from a snapshot at 0021, 0026's trigger on scopes
  // that reads guarded_changes appears in between, and 0027 drops and re-creates it.
  if (reference) {
    for (const name of addedSchema.sort()) {
      const n = after.schema[name]!;
      const r = reference[name];
      if (!r) {
        broken = true;
        lines.push(`UNEXPECTED ${n.type} ${name} (on ${n.table}): no migration of this checkout creates it.`);
      } else if (r.sql !== n.sql || r.table !== n.table || r.type !== n.type) {
        broken = true;
        lines.push(`CHANGED ${n.type} ${name}: its SQL is not the one this checkout's migrations create.`);
      }
    }
    // Once 0027 is in, every index and trigger the checkout's migrations create on (or naming) the three tables is
    // there: one created in between (0026's on scopes) and dropped again by a damaged 0027 is in neither snapshot.
    // D929: an object a later migration creates (0033's triggers naming guarded_changes) is required only once the
    // database recorded that migration; with no record, only those of 0027 and before.
    const required = (file: string | undefined): boolean => file === undefined || (after.applied !== null ? after.applied.includes(file) : file <= REBUILD_FILE);
    if (applied(after)) {
      for (const [name, r] of Object.entries(reference).sort(([x], [y]) => x.localeCompare(y))) {
        if (r.type === 'table' || Object.hasOwn(after.schema, name) || Object.hasOwn(before.schema, name) || !required(r.file)) continue;
        broken = true;
        lines.push(`MISSING ${r.type} ${name} (on ${r.table}): this checkout's migrations create it.`);
      }
    }
  }
  if (broken) {
    lines.push('Verdict: ROLL BACK to the Time Travel bookmark taken before the migration (docs/operations.md "Ledger rebuild").');
    return { verdict: 'roll_back', lines };
  }
  if (unknownLevel) {
    lines.push('Verdict: unknown level. No row or rule of the three tables was found damaged, but security_events\' kinds are at no level this checkout knows: don\'t restore on this; check the database\'s d1_migrations and the checkout, and ask.');
    return { verdict: 'unknown_level', lines };
  }
  if (!applied(after)) {
    lines.push(`Verdict: migration 0027 is not applied (no ${KIND_TRIGGERS.filter((k) => !Object.hasOwn(after.schema, k)).join(', ')}); every row of before is there. Nothing to roll back.`);
    return { verdict: 'not_applied', lines };
  }
  if (moved) {
    lines.push('Verdict: kept. Every row, seq, rule, index and trigger of before is there; the differences above are rows written or moved on by the running jobs since the first snapshot, each only as a job moves it.');
    return { verdict: 'kept', lines };
  }
  lines.push(lateBefore ? 'Verdict: identical, to a snapshot already taken after 0027 (see the warning): it says nothing about the migration itself.' : 'Verdict: identical. Every row, seq, rule, index and trigger is as before.');
  return { verdict: 'identical', lines };
}

/** The snapshot's default file: `.secrets/<env>/ledger-<label>-<UTC time>.json`. */
export function snapshotFile(secretsEnvDir: string, label: 'before' | 'after' | 'snapshot', now: Date): string {
  return join(secretsEnvDir, `ledger-${label}-${now.toISOString().replace(/[:.]/gu, '').replace(/-/gu, '')}.json`);
}

/** Checks a parsed file is a snapshot of this format (and of this env), never trusting its shape blindly. */
export function parseSnapshot(v: unknown, env: string): LedgerSnapshot {
  const s = v as Partial<LedgerSnapshot> | null;
  if (!s || s.format !== SNAPSHOT_FORMAT || typeof s.tables !== 'object' || typeof s.schema !== 'object' || typeof s.remote !== 'boolean' || typeof s.database !== 'string') {
    throw new Error(`--before is not a ${SNAPSHOT_FORMAT} snapshot (take a new one with this version)`);
  }
  if (s.env !== env) throw new Error(`--before is a snapshot of ${String(s.env)}, not ${env}`);
  if (s.applied !== null && !Array.isArray(s.applied)) throw new Error('--before has no usable applied list');
  if (s.checkout !== null && (typeof s.checkout !== 'object' || typeof s.checkout?.commit !== 'string' || typeof s.checkout?.migrationsDirty !== 'boolean')) throw new Error('--before has no usable checkout');
  for (const t of LEDGER_TABLES) {
    const x = s.tables![t.name];
    if (!x || typeof x.rows !== 'number' || typeof x.sha256 !== 'string' || typeof x.byKey !== 'object') throw new Error(`--before has no usable ${t.name}`);
  }
  return s as LedgerSnapshot;
}

/** The admin feed's cursor of `app_changes` and an unfinished first walk's place (apps/admin/src/feed.ts FEED_CURSORS). */
export const FEED_CURSOR_KEYS = ['feed.app_changes.seq', 'feed.app_changes.seq.init'] as const;

export interface FeedState {
  get(keys: readonly string[]): Promise<Map<string, string>>;
  set(key: string, value: string): Promise<void>;
  close(): Promise<void>;
}

export interface LedgerCheckDeps {
  /** The env's manifest, as far as the check needs it. */
  manifest(env: string): { network: string; d1Name: string };
  /**
   * Reads the API's D1 (`apiPrivateD1Execute`): `d1Name` is the database to read (the env's own, or a rehearsal
   * database the CLI checked).
   */
  read(env: string, d1Name: string, statement: string, remote: boolean): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /** The admin Worker's `ops.state` in the env's Neon ledger (as usage_admin, `.secrets/<env>/neon-usage-admin.url`). */
  feedState(env: string): Promise<FeedState>;
  /** `.secrets/<env>` (validates the env's name). */
  secretsEnvDir(env: string): string;
  writeJson(file: string, value: unknown): void;
  readJson(file: string): unknown;
  log(line: string): void;
  now(): Date;
  /**
   * The directory a relative `--before` or `--out` is relative to: where the operator ran the command (pnpm's
   * INIT_CWD, `invocationDir`), not scripts/, which `pnpm --filter @hana-id/scripts run ledger-check` runs in (D924).
   */
  cwd?: string;
  /**
   * The three tables' indexes and triggers, and every trigger naming them, as this checkout's migrations create them
   * (`referenceSchema`): what an object that appeared between the snapshots must be, word for word (D924).
   */
  referenceSchema?: (applied?: readonly string[] | null) => LedgerSnapshot['schema'];
  /** The checkout (`git rev-parse HEAD`, `git status --porcelain apps/api/migrations`, its files): the CLI's. */
  checkout?: () => Checkout;
}

/**
 * Whether the snapshots, this checkout and the database belong together (after PR 151's review, L2): the checkout's
 * migrations clean and committed, both snapshots from this commit (`otherCommit` accepts another one, printing both),
 * and every migration the database recorded a file of this checkout. Returns the reasons it can't judge (empty = fine).
 */
export function cannotJudge(before: LedgerSnapshot, after: LedgerSnapshot, checkout: Checkout, otherCommit: boolean): string[] {
  const out: string[] = [];
  if (checkout.migrationsDirty) out.push('this checkout has uncommitted changes in apps/api/migrations: the reference and the applied files could be anything');
  if (before.checkout === null) out.push('the snapshot before records no checkout');
  else if (before.checkout.migrationsDirty) out.push('the snapshot before was taken from a checkout with uncommitted changes in apps/api/migrations');
  else if (before.checkout.commit !== checkout.commit && !otherCommit) {
    out.push(`the snapshot before was taken at ${before.checkout.commit}, this checkout is at ${checkout.commit} (--other-commit to compare anyway)`);
  }
  if (after.applied === null) out.push("the database has no d1_migrations table: which migrations it has can't be read");
  else {
    const files = new Set(checkout.migrationFiles);
    const foreign = after.applied.filter((n) => !files.has(n));
    if (foreign.length) out.push(`the database recorded migration(s) this checkout doesn't have: ${foreign.join(', ')}`);
  }
  return out;
}

/** The rebuild's own file: with no record of what a database applied, objects of later files aren't required (D929). */
const REBUILD_FILE = '0027_platform_actor.sql';

/**
 * The latest of `applied` that `files` has (the level a database recorded, as this checkout knows it), or undefined
 * (no record, or none known: the whole checkout). A foreign file is `cannotJudge`'s finding, not this one's.
 */
export function levelOf(applied: readonly string[] | null | undefined, files: readonly string[]): string | undefined {
  if (!applied) return undefined;
  const known = new Set(files);
  return applied.filter((f) => known.has(f)).sort().at(-1);
}

/**
 * `SCHEMA_SQL` on a fresh in-memory SQLite with every migration in `dir` applied in name order (as a fresh D1 gets
 * them), or (D931) only those up to `upTo`, the level a database recorded: an object a later migration replaces (0034
 * replaces three of 0033's triggers) is then the version a database at that level has, not the checkout's final one.
 * Each object carries the file that last created it (`file`: its first creation, or the migration that created it
 * again, D929, D931).
 */
export function referenceSchema(dir: string, upTo?: string): LedgerSnapshot['schema'] {
  const db = new DatabaseSync(':memory:');
  try {
    const schema: LedgerSnapshot['schema'] = {};
    const created: Record<string, string> = {};
    const sqlAt: Record<string, string | null> = {};
    for (const f of readdirSync(dir).filter((n) => n.endsWith('.sql')).sort()) {
      if (upTo !== undefined && f > upTo) break;
      db.exec(readFileSync(join(dir, f), 'utf8'));
      for (const r of db.prepare(SCHEMA_SQL).all() as Record<string, unknown>[]) {
        const name = String(r.name);
        const sql = r.sql === null ? null : String(r.sql);
        // The file that created it, or created it again with other SQL (a replacement).
        if (!(name in created) || sqlAt[name] !== sql) created[name] = f;
        sqlAt[name] = sql;
      }
    }
    for (const r of db.prepare(SCHEMA_SQL).all() as Record<string, unknown>[]) {
      const name = String(r.name);
      schema[name] = { type: String(r.type), table: String(r.tbl_name), sql: r.sql === null ? null : String(r.sql), file: created[name]! };
    }
    return schema;
  } finally {
    db.close();
  }
}

/** `--d1-name`: a rehearsal database only (as admin.ts's), never one that names a production network. */
export function rehearsalD1(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  if (!/^[a-z0-9-]{1,64}$/u.test(name) || !name.includes('rehearsal')) throw new CliError('--d1-name is for rehearsal databases: a D1 name containing "rehearsal"');
  if (name.includes('mainnet') || name.includes('prod')) throw new CliError('--d1-name must not name a production database');
  return name;
}

const seqValue = (v: string | undefined): number | null => (v !== undefined && /^\d{1,15}$/u.test(v) ? Number(v) : null);

async function feedCursor(env: string, remote: boolean, yes: boolean, d1Name: string, before: LedgerSnapshot | undefined, deps: LedgerCheckDeps): Promise<number> {
  if (!remote) throw new CliError('feed-cursor acts on the deployed env (--remote): the admin feed runs only there');
  const [r] = await deps.read(env, d1Name, 'SELECT max(seq) AS m FROM app_changes', true);
  const current = r?.m === null || r?.m === undefined ? 0 : Number(r.m);
  if (!Number.isSafeInteger(current) || current < 0) throw new Error('app_changes: max(seq) is not a number');
  // The snapshot's max(seq) when given: the API may have written rows since the restore, which a cursor at the
  // current max would skip; at the snapshot's, rows between it and the bookmark are emailed once more (a repeat, never
  // a gap).
  const snapMax = before?.tables.app_changes?.maxSeq ?? null;
  const max = snapMax === null ? current : Math.min(snapMax, current);
  const state = await deps.feedState(env);
  try {
    const now = await state.get(FEED_CURSOR_KEYS);
    deps.log(`${env}: the API's D1 ${d1Name} has max(seq) ${current}${snapMax === null ? '' : `; the snapshot before the migration had ${snapMax}`}: the cursor goes no higher than ${max}.`);
    if (snapMax === null) deps.log('  (No --before: rows the API wrote since the restore, if any, are at or below this and would not be emailed. Give the snapshot file.)');
    let changes = 0;
    for (const key of FEED_CURSOR_KEYS) {
      const raw = now.get(key);
      const v = seqValue(raw);
      if (raw === undefined) {
        deps.log(`  ${key}: not set (nothing to lower).`);
        continue;
      }
      if (v === null) throw new Error(`${key} in ops.state is not a seq: fix it by hand`);
      if (v <= max) {
        deps.log(`  ${key}: ${v}, at or below ${max}: left as it is.`);
        continue;
      }
      changes += 1;
      if (yes) {
        await state.set(key, String(max));
        deps.log(`  ${key}: ${v} → ${max}. Rows written after the restore (seq ${max + 1} on) will be emailed.`);
      } else {
        deps.log(`  ${key}: ${v} → ${max} (planned).`);
      }
    }
    if (!yes && changes) deps.log('Dry run: nothing written. Re-run with --yes to lower the cursor.');
    if (!changes) deps.log('Nothing to lower.');
    return 0;
  } finally {
    await state.close();
  }
}

/** The CLI (scripts/ledger-check.ts). Returns the exit code (1 for roll_back or not_applied). */
export async function ledgerCheck(argv: readonly string[], deps: LedgerCheckDeps): Promise<number> {
  const args = parseCli(argv, { strings: ['before', 'out', 'd1-name'], booleans: ['remote', 'yes', 'other-commit'] });
  const [env, step, ...rest] = args.positionals;
  if (!env || (step !== 'snapshot' && step !== 'compare' && step !== 'feed-cursor') || rest.length) throw new CliError('Give an env and one step: snapshot, compare or feed-cursor');
  const remote = args.flag('remote');
  const m = deps.manifest(env);
  if (m.network === 'mainnet') throw new CliError(`${env} is a mainnet env: ledger-check runs on testnet envs only`);
  const rehearsal = rehearsalD1(args.str('d1-name'));
  if (rehearsal !== undefined && !remote) throw new CliError('--d1-name is a remote rehearsal database: add --remote');
  if (rehearsal !== undefined && step === 'feed-cursor') throw new CliError('feed-cursor is for the env’s own database: the feed reads no rehearsal copy');
  const database = rehearsal ?? m.d1Name;
  const fromCaller = (p: string | undefined): string | undefined => (p === undefined ? undefined : resolve(deps.cwd ?? process.cwd(), p));
  const beforeFile = fromCaller(step === 'compare' ? args.required('before') : args.str('before'));
  const before = beforeFile === undefined ? undefined : parseSnapshot(deps.readJson(beforeFile), env);
  if (step === 'feed-cursor') {
    if (before && (before.database !== database || !before.remote)) throw new CliError(`--before is a snapshot of ${before.database}${before.remote ? '' : ' (local)'}, not the deployed ${database}`);
    return feedCursor(env, remote, args.flag('yes'), database, before, deps);
  }
  const dir = deps.secretsEnvDir(env);
  const now = deps.now();
  if (before && before.remote !== remote) throw new CliError(`--before is a snapshot of the ${before.remote ? 'remote' : 'local'} database: run compare ${before.remote ? 'with' : 'without'} --remote`);
  if (before && before.database !== database) throw new CliError(`--before is a snapshot of ${before.database}, not ${database}`);
  const checkout = deps.checkout?.();
  const snap = await takeSnapshot((s) => deps.read(env, database, s, remote), { env, database, remote, now, ...(checkout ? { checkout } : {}) });
  const out = fromCaller(args.str('out')) ?? snapshotFile(dir, step === 'compare' ? 'after' : 'snapshot', now);
  deps.writeJson(out, snap);
  deps.log(`${env}: ${database} (${remote ? 'remote' : 'local'}), ${snap.takenAt}: snapshot written to ${out}`);
  for (const t of LEDGER_TABLES) {
    const s = snap.tables[t.name]!;
    deps.log(`  ${t.name}: ${s.rows} rows${s.maxSeq !== null ? `, max(seq) ${s.maxSeq}` : ''}, sha256 ${s.sha256}`);
  }
  deps.log(`  ${Object.keys(snap.schema).length} tables, indexes and triggers; 0027's triggers ${applied(snap) ? 'present' : 'absent'}`);
  if (checkout) deps.log(`  checkout ${checkout.commit}${checkout.migrationsDirty ? ' (apps/api/migrations has uncommitted changes)' : ''}; the database recorded ${snap.applied === null ? 'no d1_migrations' : `${snap.applied.length} migration(s)`}`);
  if (step === 'snapshot' && checkout?.migrationsDirty) deps.log('  WARNING: apps/api/migrations has uncommitted changes: a compare against this snapshot will refuse to judge.');
  if (!before) return 0;
  deps.log(`Compared with ${beforeFile} (${before.takenAt}):`);
  if (checkout) {
    const why = cannotJudge(before, snap, checkout, args.flag('other-commit'));
    if (args.flag('other-commit') && before.checkout && before.checkout.commit !== checkout.commit) deps.log(`  --other-commit: the snapshot before is from ${before.checkout.commit}, this checkout is ${checkout.commit}.`);
    if (why.length) {
      for (const w of why) deps.log(`  CAN'T JUDGE: ${w}.`);
      deps.log("  Verdict: can't judge. Nothing compared: don't restore on this; fix what is named above and run compare again.");
      return VERDICT_EXIT.cannot_judge;
    }
  }
  // D931: each snapshot against the checkout's schema at the level its database recorded (a trigger a later migration
  // replaces is judged by the version that database should have).
  const c = compareSnapshots(before, snap, deps.referenceSchema?.(snap.applied), deps.referenceSchema?.(before.applied));
  for (const l of c.lines) deps.log(`  ${l}`);
  return VERDICT_EXIT[c.verdict];
}
