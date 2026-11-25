// ledger-check.ts's body (D916; docs/partner-platform-spec.md A7, the deploy step of M9): a before-and-after comparison
// of the hot DB's ledger tables around a rebuild of them (migration 0027: `app_changes`, `guarded_changes`,
// `security_events`), so a rebuild that lost, changed or reordered a row, or dropped an index or trigger, is seen at
// once and rolled back to the Time Travel bookmark taken before it (docs/operations.md "Ledger rebuild").
//
//   ledger-check <env> snapshot [--remote] [--out <file>]
//   ledger-check <env> compare --before <file> [--remote] [--out <file>]
//
// D1 has no hash function, so every row is read here, a page at a time in its key's order (`wrangler d1 execute
// --json`), and hashed locally with SHA-256: per table, the hash of every row's canonical JSON in order (the spec's
// aggregate hash), the row count and, for `app_changes`, max(seq); per row, two short hashes (all columns, and the
// columns no job ever updates), so a comparison can tell a row the rebuild changed from one a job moved on since (a
// guarded change announced, an event emailed: the API keeps running while the migration applies). Indexes and
// triggers are compared by their SQL (`sqlite_schema`).
//
// A snapshot holds counts and hashes, never a row; it is written 0600 under `.secrets/<env>/` all the same (it is
// derived from the database). Nothing here prints a row or a value of one: only table names, keys' counts, column
// names, index and trigger names, and hashes.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { CliError, parseCli } from './cli.ts';
import { type SqlParam, sqlValue } from './sql.ts';

export const LEDGER_CHECK_USAGE = `Usage: ledger-check.ts <env> snapshot [--remote] [--out <file>]
       ledger-check.ts <env> compare --before <snapshot file> [--remote] [--out <file>]
  snapshot  reads app_changes, guarded_changes and security_events (every row, in key order) and their indexes and
            triggers; writes counts, max(seq) and SHA-256 hashes (never a row) to .secrets/<env>/ (0600)
  compare   takes a new snapshot and compares it with --before: exits 1 when a row was lost or changed by anything but
            a job's lifecycle update, a seq moved, or an index or trigger is missing or changed (roll back to the
            bookmark), or when migration 0027's kind triggers are not there (the migration did not apply)
  --remote  the deployed database (default: local, wrangler dev's state, as admin.ts)`;

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
    // The lifecycle: ackNotice (notified_at, active_from, waiver, cancel_token_hash), expedite (active_from,
    // expedited_*), the hourly job (status, activated_recorded_at, ended_at, cancelled_*), a cancel or close.
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
export const KIND_TRIGGERS = ['app_changes_actor_kind', 'guarded_changes_proposer_kind', 'guarded_changes_proposer_kind_update'] as const;

export interface TableSnapshot {
  rows: number;
  /** max(seq) for `app_changes`; null for the others. */
  maxSeq: number | null;
  /** SHA-256 (hex) over every row's canonical JSON line, in key order. */
  sha256: string;
  /** Per row (by key, as a string): `full` over every column, `fixed` over the columns no job updates (16 bytes hex each). */
  byKey: Record<string, { full: string; fixed: string }>;
}

export interface LedgerSnapshot {
  format: 'hana-id/ledger-check/v1';
  env: string;
  remote: boolean;
  takenAt: string;
  tables: Record<string, TableSnapshot>;
  /** Every index and trigger of the three tables (automatic indexes have no SQL: null), by name. */
  schema: Record<string, { type: string; table: string; sql: string | null }>;
}

/** Runs one SELECT on the API's D1 and returns its rows (wrangler d1 execute --json, or node:sqlite in tests). */
export type LedgerRead = (statement: string) => Promise<Record<string, unknown>[]> | Record<string, unknown>[];

const sha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');
const short = (s: string): string => sha(s).slice(0, 32);

/** One row's columns as canonical JSON: an array in the table's column order (numbers as numbers, NULL as null). */
export function canonicalRow(t: LedgerTable, row: Record<string, unknown>, columns: readonly string[] = t.columns): string {
  return JSON.stringify(
    columns.map((c) => {
      const v = row[c];
      if (v === undefined) throw new Error(`${t.name}: the read returned no column ${c}`);
      if (typeof v === 'bigint') return v.toString();
      if (v !== null && typeof v !== 'string' && typeof v !== 'number') throw new Error(`${t.name}.${c}: unexpected value type ${typeof v}`);
      return v;
    }),
  );
}

/** The page query: every column (BLOBs as upper-case hex), after the last key read, in key order. */
export function pageSql(t: LedgerTable, after: SqlParam | undefined, pageSize: number): string {
  const cols = t.columns.map((c) => (t.blobs.includes(c) ? `hex(${c}) AS ${c}` : c)).join(', ');
  const where = after === undefined ? '' : ` WHERE ${t.key} > ${sqlValue(after)}`;
  return `SELECT ${cols} FROM ${t.name}${where} ORDER BY ${t.key} LIMIT ${pageSize}`;
}

export const SCHEMA_SQL =
  "SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE type IN ('index', 'trigger') AND tbl_name IN ('app_changes', 'guarded_changes', 'security_events') ORDER BY name";

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
      byKey[k] = { full: short(line), fixed: short(canonicalRow(t, r, fixedCols)) };
      if (t.name === 'app_changes') maxSeq = Math.max(maxSeq ?? 0, key as number);
      rows += 1;
      after = key as SqlParam;
    }
    if (page.length < pageSize) break;
  }
  return { rows, maxSeq: t.name === 'app_changes' ? maxSeq : null, sha256: all.digest('hex'), byKey };
}

export async function takeSnapshot(read: LedgerRead, o: { env: string; remote: boolean; now?: Date; pageSize?: number }): Promise<LedgerSnapshot> {
  const pageSize = o.pageSize ?? 500;
  const tables: Record<string, TableSnapshot> = {};
  for (const t of LEDGER_TABLES) tables[t.name] = await snapshotTable(read, t, pageSize);
  const schema: LedgerSnapshot['schema'] = {};
  for (const r of await read(SCHEMA_SQL)) schema[String(r.name)] = { type: String(r.type), table: String(r.tbl_name), sql: r.sql === null ? null : String(r.sql) };
  return { format: 'hana-id/ledger-check/v1', env: o.env, remote: o.remote, takenAt: (o.now ?? new Date()).toISOString(), tables, schema };
}

export type Verdict = 'identical' | 'kept' | 'roll_back' | 'not_applied';

export interface Comparison {
  verdict: Verdict;
  /** What to tell the operator, one finding a line (names, counts and hashes only). */
  lines: string[];
}

/**
 * Compares a snapshot taken before the migration with one taken after:
 * - `roll_back`: a row of before is gone, a fixed column of one changed (any column of an `app_changes` row), a new
 *   `app_changes` row sits at or below the old max(seq) (seq was renumbered), or an index or trigger of before is gone
 *   or has other SQL;
 * - `not_applied`: none of that, but 0027's kind triggers are not there;
 * - `kept`: every row of before is there, and differences are only rows written since or lifecycle updates by a job;
 * - `identical`: the same counts and table hashes, every index and trigger as before.
 */
export function compareSnapshots(before: LedgerSnapshot, after: LedgerSnapshot): Comparison {
  const lines: string[] = [];
  let broken = false;
  let moved = false;
  if (before.env !== after.env || before.remote !== after.remote) {
    return { verdict: 'roll_back', lines: [`The snapshots are of different databases (${before.env}${before.remote ? ' remote' : ' local'} and ${after.env}${after.remote ? ' remote' : ' local'}): nothing compared.`] };
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
    const lifecycle: string[] = [];
    for (const [k, h] of Object.entries(b.byKey)) {
      const n = a.byKey[k];
      if (!n || n.full === h.full) continue;
      if (n.fixed !== h.fixed) fixedChanged.push(k);
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
      lines.push(`  ${lifecycle.length} row(s) moved on by a job since (they differ only in columns a job writes: ${t.mutable.join(', ')}; first ${t.key}s: ${lifecycle.slice(0, 5).join(', ')}).`);
    }
    if (added.length - renumbered.length > 0) {
      moved = true;
      lines.push(`  ${added.length - renumbered.length} row(s) written since.`);
    }
  }
  for (const [name, s] of Object.entries(before.schema)) {
    const n = after.schema[name];
    if (!n) {
      broken = true;
      lines.push(`MISSING ${s.type} ${name} (on ${s.table}).`);
    } else if (n.sql !== s.sql || n.table !== s.table || n.type !== s.type) {
      broken = true;
      lines.push(`CHANGED ${s.type} ${name}: its SQL differs from before.`);
    }
  }
  const addedSchema = Object.keys(after.schema).filter((k) => !Object.hasOwn(before.schema, k));
  if (addedSchema.length) lines.push(`New since: ${addedSchema.sort().join(', ')}.`);
  if (broken) {
    lines.push('Verdict: ROLL BACK to the Time Travel bookmark taken before the migration (docs/operations.md "Ledger rebuild").');
    return { verdict: 'roll_back', lines };
  }
  if (!KIND_TRIGGERS.every((k) => Object.hasOwn(after.schema, k))) {
    lines.push(`Verdict: migration 0027 is not applied (no ${KIND_TRIGGERS.filter((k) => !Object.hasOwn(after.schema, k)).join(', ')}); every row of before is there. Nothing to roll back.`);
    return { verdict: 'not_applied', lines };
  }
  if (moved) {
    lines.push('Verdict: kept. Every row, seq, index and trigger of before is there; the differences above are rows written or moved on by the running jobs since the first snapshot.');
    return { verdict: 'kept', lines };
  }
  lines.push('Verdict: identical. Every row, seq, index and trigger is as before.');
  return { verdict: 'identical', lines };
}

/** The snapshot's default file: `.secrets/<env>/ledger-<label>-<UTC time>.json`. */
export function snapshotFile(secretsEnvDir: string, label: 'before' | 'after' | 'snapshot', now: Date): string {
  return join(secretsEnvDir, `ledger-${label}-${now.toISOString().replace(/[:.]/gu, '').replace(/-/gu, '')}.json`);
}

/** Checks a parsed file is a snapshot of this format (and of this env), never trusting its shape blindly. */
export function parseSnapshot(v: unknown, env: string): LedgerSnapshot {
  const s = v as Partial<LedgerSnapshot> | null;
  if (!s || s.format !== 'hana-id/ledger-check/v1' || typeof s.tables !== 'object' || typeof s.schema !== 'object' || typeof s.remote !== 'boolean') throw new Error('--before is not a ledger-check snapshot');
  if (s.env !== env) throw new Error(`--before is a snapshot of ${String(s.env)}, not ${env}`);
  for (const t of LEDGER_TABLES) {
    const x = s.tables![t.name];
    if (!x || typeof x.rows !== 'number' || typeof x.sha256 !== 'string' || typeof x.byKey !== 'object') throw new Error(`--before has no usable ${t.name}`);
  }
  return s as LedgerSnapshot;
}

export interface LedgerCheckDeps {
  /** The API's D1 of the env, local or remote (`d1Execute`). */
  read(env: string, statement: string, remote: boolean): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /** `.secrets/<env>` (validates the env's name). */
  secretsEnvDir(env: string): string;
  writeJson(file: string, value: unknown): void;
  readJson(file: string): unknown;
  log(line: string): void;
  now(): Date;
}

/** The CLI (scripts/ledger-check.ts): `snapshot` or `compare`. Returns the exit code (1 for roll_back or not_applied). */
export async function ledgerCheck(argv: readonly string[], deps: LedgerCheckDeps): Promise<number> {
  const args = parseCli(argv, { strings: ['before', 'out'], booleans: ['remote'] });
  const [env, step, ...rest] = args.positionals;
  if (!env || (step !== 'snapshot' && step !== 'compare') || rest.length) throw new CliError('Give an env and one step: snapshot or compare');
  const remote = args.flag('remote');
  const dir = deps.secretsEnvDir(env);
  const now = deps.now();
  const beforeFile = step === 'compare' ? args.required('before') : undefined;
  const before = beforeFile === undefined ? undefined : parseSnapshot(deps.readJson(beforeFile), env);
  if (before && before.remote !== remote) throw new CliError(`--before is a snapshot of the ${before.remote ? 'remote' : 'local'} database: run compare ${before.remote ? 'with' : 'without'} --remote`);
  const snap = await takeSnapshot((s) => deps.read(env, s, remote), { env, remote, now });
  const out = args.str('out') ?? snapshotFile(dir, step === 'compare' ? 'after' : 'snapshot', now);
  deps.writeJson(out, snap);
  deps.log(`${env} (${remote ? 'remote' : 'local'}), ${snap.takenAt}: snapshot written to ${out}`);
  for (const t of LEDGER_TABLES) {
    const s = snap.tables[t.name]!;
    deps.log(`  ${t.name}: ${s.rows} rows${s.maxSeq !== null ? `, max(seq) ${s.maxSeq}` : ''}, sha256 ${s.sha256}`);
  }
  deps.log(`  ${Object.keys(snap.schema).length} indexes and triggers; 0027's kind triggers ${KIND_TRIGGERS.every((k) => Object.hasOwn(snap.schema, k)) ? 'present' : 'absent'}`);
  if (!before) return 0;
  const c = compareSnapshots(before, snap);
  deps.log(`Compared with ${beforeFile} (${before.takenAt}):`);
  for (const l of c.lines) deps.log(`  ${l}`);
  return c.verdict === 'identical' || c.verdict === 'kept' ? 0 : 1;
}
