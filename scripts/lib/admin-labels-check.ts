// admin.ts labels:check (D922; docs/operations.md "Before switching partner labels on in an env", D907/D908's review,
// item 4): every stored Request labels version that is waiting or in force, parsed again with this checkout's parser
// (core's `parseLabelDocument`) and its lines built again (`previewLabelDocument`, the address book's lines and what the
// document describes), so a version that a stricter rule now refuses, or one that would show users words nobody
// reviewed, is found before `partnerLabels.enabled` goes on or before a build with new label rules is deployed.
//
//   admin.ts <env> labels:check [--remote] [--save [--out <file>]] [--baseline <file>]
//
// "Reads differently" needs the lines the versions were reviewed with. The database keeps only each version's text
// (the API builds every preview again from it), so those lines come from a baseline: `--save` writes this checkout's
// lines for every version to a 0600 file under `.secrets/<env>/`; run it from a checkout of the build that is deployed
// (the one the versions were proposed and announced under), then `--baseline <that file>` from the checkout of the build
// to deploy. Without a baseline the lines are not compared, and the output says so.
//
// Read-only on the database. The rows are read with apiPrivateD1Execute (remote: D1's REST API, the statement in the
// HTTPS body; local: a 0600 file with wrangler's log file off), so no document reaches wrangler's logs. Per version it
// prints only its id, its apps' ids, its state and the verdict: "parses the same", "fails" with each error's code and
// where in the document (a path, never a value), or "reads differently" with the lines that changed (the only partner
// words printed). Exits 1 when any version fails, reads differently or could not be compared with the baseline given.
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { addressBookLines, labelContextKey, parseLabelDocument, previewLabelDocument, type LabelDocument } from '@hana-id/core/partner-labels';
import { CliError } from './cli.ts';
import { sqlValue } from './sql.ts';

export const LABELS_CHECK_USAGE = `  labels:check [--save [--out <file>]] [--baseline <file>]
               before partner labels go on in an env, and before deploying a build that changes the label rules
               (D907, D922): every stored Request labels version waiting or in force, parsed again with this
               checkout's parser; per version its id, apps, state and verdict (parses the same / fails: code at path /
               reads differently: the lines that changed). Read-only. --save: also write this checkout's lines for
               every version to .secrets/<env>/labels-lines-<time>.json (0600; --out <file> under a .secrets
               directory instead), from the deployed build's checkout; --baseline <file>: compare with such a file, from the checkout to deploy. Exits 1 when a
               version fails, reads differently or isn't in the baseline. Testnet envs only`;

/** One stored version as the check reads it. */
export interface LabelCheckRow {
  id: string;
  status: 'pending' | 'active';
  notified_at: number | null;
  active_from: number | null;
  doc_text: string;
  doc_sha256: string;
  /** JSON: [{id, name}] in the version's order (the API's `apps_named`). */
  apps_named: string;
}

const PAGE = 50;

/** The versions waiting or in force after `afterId`, in id order, a page at a time (each text is at most 16 KiB). */
export function labelsCheckSql(afterId: string | null): string {
  return `SELECT c.id, c.status, c.notified_at, c.active_from, c.doc_text, c.doc_sha256,
       (SELECT json_group_array(json_object('id', j.value, 'name', (SELECT name FROM apps WHERE id = j.value))) FROM json_each(c.apps_json) j) AS apps_named
  FROM label_changes c
 WHERE c.status IN ('pending', 'active')${afterId === null ? '' : ` AND c.id > ${sqlValue(afterId)}`}
 ORDER BY c.id LIMIT ${PAGE}`;
}

/**
 * A document's lines as a reviewer reads them, each keyed: what it describes, each account of its address book
 * (keyed by the account, so a rename is a change), and each format's line with its rows ("label: value"), in the
 * preview's plain-text form with its example values (the API's preview and diff, apps/api/src/labels/document.ts).
 */
export function renderedLines(doc: LabelDocument, appName: string): [string, string][] {
  const accounts = addressBookLines(doc);
  return [
    ['(describes)', labelContextKey(doc)],
    ...doc.metadata.addressBook.map((e, i): [string, string] => [`(account) ${e.account}`, accounts[i]!]),
    ...previewLabelDocument(doc, appName).map((f): [string, string] => [f.key, [f.line, ...f.fields.map((x) => `${x.label}: ${x.value}`)].join(' · ')]),
  ];
}

export type LabelVerdict =
  | { kind: 'same' }
  | { kind: 'parses'; compared: false }
  | { kind: 'fails'; problems: string[] }
  | { kind: 'differs'; diff: string[] }
  | { kind: 'not_in_baseline' };

export const BASELINE_FORMAT = 'hana-id/labels-check/v1';

export interface LabelsBaseline {
  format: typeof BASELINE_FORMAT;
  env: string;
  database: string;
  remote: boolean;
  takenAt: string;
  /** Per version id: its text's sha256 (as stored) and its lines. */
  versions: Record<string, { sha256: string; lines: [string, string][] }>;
}

/** Checks a parsed file is a baseline of this format, env and database, never trusting its shape blindly. */
export function parseBaseline(v: unknown, env: string, database: string, remote: boolean): LabelsBaseline {
  const b = v as Partial<LabelsBaseline> | null;
  if (!b || b.format !== BASELINE_FORMAT || typeof b.versions !== 'object' || b.versions === null || typeof b.takenAt !== 'string') throw new CliError(`--baseline is not a ${BASELINE_FORMAT} file (write one with --save)`);
  if (b.env !== env) throw new CliError(`--baseline is of ${String(b.env)}, not ${env}`);
  if (b.database !== database || b.remote !== remote) throw new CliError(`--baseline is of ${String(b.database)}${b.remote ? '' : ' (local)'}, not ${database}${remote ? '' : ' (local)'}`);
  for (const [id, x] of Object.entries(b.versions)) {
    if (!x || typeof x.sha256 !== 'string' || !Array.isArray(x.lines) || !x.lines.every((l) => Array.isArray(l) && l.length === 2 && typeof l[0] === 'string' && typeof l[1] === 'string')) throw new CliError(`--baseline has no usable lines for ${id}`);
  }
  return b as LabelsBaseline;
}

const MAX_DIFF_LINES = 12;
const MAX_LINE = 160;
const cut = (s: string): string => (s.length > MAX_LINE ? `${s.slice(0, MAX_LINE - 1)}…` : s);

/** The lines that changed, keyed as `renderedLines` keys them: "- key: before" and "+ key: after"; the same lines left out. */
export function linesDiff(before: readonly [string, string][], after: readonly [string, string][]): string[] {
  const b = new Map(before);
  const a = new Map(after);
  const out: string[] = [];
  for (const key of [...new Set([...b.keys(), ...a.keys()])]) {
    const x = b.get(key);
    const y = a.get(key);
    if (x === y) continue;
    if (x !== undefined) out.push(cut(`- ${key}: ${x}`));
    if (y !== undefined) out.push(cut(`+ ${key}: ${y}`));
  }
  // The order of the lines is what users read too.
  if (out.length === 0 && before.map(([k]) => k).join('\n') !== after.map(([k]) => k).join('\n')) out.push(`~ the same lines in another order: ${after.map(([k]) => k).join(', ')}`);
  return out.length > MAX_DIFF_LINES ? [...out.slice(0, MAX_DIFF_LINES), `… and ${out.length - MAX_DIFF_LINES} more changed lines`] : out;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');

/** One version's verdict and (when it parses) its lines. */
export function checkVersion(r: LabelCheckRow, baseline: LabelsBaseline | null): { verdict: LabelVerdict; lines: [string, string][] | null } {
  const problems: string[] = [];
  if (sha256Hex(r.doc_text) !== r.doc_sha256) problems.push('stored_text_changed (the text no longer matches its stored sha256)');
  const parsed = parseLabelDocument(r.doc_text);
  if (!parsed.ok) problems.push(...parsed.errors.map((e) => `${e.code} at ${e.path || '(the document)'}`));
  if (problems.length || !parsed.ok) return { verdict: { kind: 'fails', problems }, lines: null };
  const apps = JSON.parse(r.apps_named) as { id: string; name: string | null }[];
  // The API's own choice of name for a version's preview (labels/lifecycle.ts previewAndDiff).
  const lines = renderedLines(parsed.document, apps[0]?.name ?? apps[0]?.id ?? 'the app');
  if (baseline === null) return { verdict: { kind: 'parses', compared: false }, lines };
  const was = Object.hasOwn(baseline.versions, r.id) ? baseline.versions[r.id]! : null;
  if (was === null || was.sha256 !== r.doc_sha256) return { verdict: { kind: 'not_in_baseline' }, lines };
  const diff = linesDiff(was.lines, lines);
  return { verdict: diff.length ? { kind: 'differs', diff } : { kind: 'same' }, lines };
}

export interface LabelsCheckDeps {
  /** One SELECT on the API's D1 (apiPrivateD1Execute; node:sqlite in tests). */
  read(statement: string): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  secretsEnvDir(env: string): string;
  writeJson(file: string, value: unknown): void;
  readJson(file: string): unknown;
  log(line: string): void;
  now(): Date;
}

export interface LabelsCheckOptions {
  env: string;
  network: string;
  database: string;
  remote: boolean;
  /** --save: write the lines, to `out` or the default file under `.secrets/<env>/`. */
  save: boolean;
  out: string | undefined;
  baseline: string | undefined;
}

const stateOf = (r: LabelCheckRow, nowMs: number): string =>
  r.status === 'active' ? 'in force' : r.notified_at !== null && r.active_from !== null && r.active_from <= nowMs ? 'in force from its due time (unless held for review)' : 'waiting';

/** Runs the check; resolves to the exit code (0: every version parses the same, or parses when not compared). */
export async function labelsCheck(o: LabelsCheckOptions, deps: LabelsCheckDeps): Promise<number> {
  if (o.network === 'mainnet') throw new CliError(`${o.env} is a mainnet env: labels:check runs on testnet envs only`);
  if (o.out !== undefined && !o.save) throw new CliError('--out is where --save writes: add --save');
  const baseline = o.baseline === undefined ? null : parseBaseline(deps.readJson(o.baseline), o.env, o.database, o.remote);
  const now = deps.now();
  const rows: LabelCheckRow[] = [];
  for (let after: string | null = null; ; ) {
    const page = (await deps.read(labelsCheckSql(after))) as unknown as LabelCheckRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.id;
  }
  deps.log(`${o.env}: ${o.database} (${o.remote ? 'remote' : 'local'}): ${rows.length} Request labels version${rows.length === 1 ? '' : 's'} waiting or in force${baseline ? `, compared with ${o.baseline} (${baseline.takenAt})` : ''}`);
  const saved: LabelsBaseline['versions'] = {};
  let bad = 0;
  for (const r of rows) {
    const { verdict, lines } = checkVersion(r, baseline);
    if (lines) saved[r.id] = { sha256: r.doc_sha256, lines };
    const apps = (JSON.parse(r.apps_named) as { id: string }[]).map((a) => a.id).join(', ');
    const head = `  ${r.id} (apps ${apps}; ${stateOf(r, now.getTime())}):`;
    switch (verdict.kind) {
      case 'same':
        deps.log(`${head} parses the same`);
        break;
      case 'parses':
        deps.log(`${head} parses (lines not compared: no --baseline)`);
        break;
      case 'fails':
        bad += 1;
        deps.log(`${head} FAILS: ${verdict.problems.join('; ')}`);
        break;
      case 'differs':
        bad += 1;
        deps.log(`${head} READS DIFFERENTLY:`);
        for (const l of verdict.diff) deps.log(`      ${l}`);
        break;
      case 'not_in_baseline':
        bad += 1;
        deps.log(`${head} NOT COMPARED: not in the baseline (proposed after it, or its text differs): take the baseline again`);
        break;
    }
  }
  if (o.save) {
    const file = o.out ?? join(deps.secretsEnvDir(o.env), `labels-lines-${now.toISOString().replace(/[:.]/gu, '').replace(/-/gu, '')}.json`);
    const out: LabelsBaseline = { format: BASELINE_FORMAT, env: o.env, database: o.database, remote: o.remote, takenAt: now.toISOString(), versions: saved };
    deps.writeJson(file, out);
    deps.log(`Lines of ${Object.keys(saved).length} version${Object.keys(saved).length === 1 ? '' : 's'} written to ${file} (0600): pass it as --baseline from the checkout to deploy`);
  }
  if (bad) deps.log(`${bad} version${bad === 1 ? '' : 's'} to propose again (and the old one blocked with a note): docs/operations.md "Before switching partner labels on in an env"`);
  else if (rows.length && baseline === null) deps.log('Every version parses; the lines were not compared (run with --baseline to compare them)');
  return bad ? 1 : 0;
}
