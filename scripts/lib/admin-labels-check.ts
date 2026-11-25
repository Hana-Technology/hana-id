// admin.ts labels:check (D922; docs/operations.md "Before switching partner labels on in an env", D907/D908's review,
// item 4): every stored Request labels version that is waiting or in force, parsed again with this checkout's parser
// (core's `parseLabelDocument`) and its lines built again, so a version that a stricter rule now refuses, or one that
// would show users words nobody reviewed or match requests differently, is found before `partnerLabels.enabled` goes
// on or before a build with new label rules is deployed.
//
//   admin.ts <env> labels:check [--remote] [--save [--out <file>]] [--baseline <file> [--same-build]]
//
// "Reads the same" needs what the versions were reviewed with. The database keeps only each version's text (the API
// builds every preview again from it), so that comes from a baseline: `--save` writes this checkout's lines for every
// version to a new 0600 file `labels-lines-<time>.json` in `.secrets/<env>/`, with the commit it was written from and,
// with `--remote`, the API's deployed build id; run it from a checkout of the deployed commit (the one the versions were
// proposed and announced under), then `--baseline <that file>` from the checkout of the commit to deploy. A baseline
// from this very commit is refused unless `--same-build` says that is meant (it would compare a build with itself).
//
// What "the same" covers, per version (`renderedLines`): what it describes; every attached app's id and name, and
// whether it is deleted; each address book line; each format's preview line and rows (core's example values); and a
// hash of each format's parsed rules (the call's constraints: amounts, assets, memo, deposit, gas, relayed, every
// argument's spec) and of the document's parsed context and metadata. It does not cover how this build's matcher
// treats a real request beyond those rules: that is code, named by the two commits the comparison prints.
//
// Read-only on the database. The rows are read with apiPrivateD1Execute (remote: D1's REST API, the statement in the
// HTTPS body; local: a 0600 file with wrangler's log file off), so no document reaches wrangler's logs. Per version it
// prints its id, its apps' ids, its state and the verdict: "parses the same"; "FAILS" with each error's code and where
// in the document (a path, which can hold the partner's own key names); or "READS DIFFERENTLY" with the lines that
// changed (the only other partner words printed). Every printed line goes through core's `displaySafeLine` (controls,
// bidi and invisible characters as "?"), so a partner's key can't send the terminal an escape sequence. Exits 1 when any
// version fails, reads differently or could not be compared with the baseline given.
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { displaySafeLine } from '@hana-id/core';
import { addressBookLines, labelContextKey, parseLabelDocument, previewLabelDocument, type LabelDocument } from '@hana-id/core/partner-labels';
import { CliError } from './cli.ts';
import { FILE_MODE, assertPrivate, ensureSecretDir, parseSecretJson } from './secrets.ts';
import { sqlValue } from './sql.ts';

export const LABELS_CHECK_USAGE = `  labels:check [--save [--out <file>]] [--baseline <file> [--same-build]]
               before partner labels go on in an env, and before deploying a build that changes the label rules
               (D907, D922): every stored Request labels version waiting or in force, parsed again with this
               checkout's parser; per version its id, apps, state and verdict (parses the same / FAILS: code at path /
               READS DIFFERENTLY: the lines that changed). Read-only. --save: also write this checkout's lines for
               every version, with this commit, to a new .secrets/<env>/labels-lines-<time>.json (0600; --out names
               another new labels-lines-*.json there), from a checkout of the deployed commit; --baseline <file>:
               compare with such a file, from the checkout of the commit to deploy (a baseline of this same commit
               is refused without --same-build). Exits 1 when a version fails, reads differently or isn't in the
               baseline. Testnet envs only`;

/** One stored version as the check reads it. */
export interface LabelCheckRow {
  id: string;
  status: 'pending' | 'active';
  notified_at: number | null;
  active_from: number | null;
  doc_text: string;
  doc_sha256: string;
  /** JSON: [{id, name, deleted}] in the version's order (the API's `apps_named`, with whether each is deleted). */
  apps_named: string;
}

interface AttachedApp {
  id: string;
  name: string | null;
  deleted: boolean | number;
}

const PAGE = 50;

/** The versions waiting or in force after `afterId`, in id order, a page at a time (each text is at most 16 KiB). */
export function labelsCheckSql(afterId: string | null): string {
  return `SELECT c.id, c.status, c.notified_at, c.active_from, c.doc_text, c.doc_sha256,
       (SELECT json_group_array(json_object('id', j.value, 'name', (SELECT name FROM apps WHERE id = j.value), 'deleted', (SELECT deleted_at IS NOT NULL FROM apps WHERE id = j.value))) FROM json_each(c.apps_json) j) AS apps_named
  FROM label_changes c
 WHERE c.status IN ('pending', 'active')${afterId === null ? '' : ` AND c.id > ${sqlValue(afterId)}`}
 ORDER BY c.id LIMIT ${PAGE}`;
}

/** JSON with every object's keys sorted (a null-prototype map too) and bigints as strings: one text per value. */
export function canonicalJson(v: unknown): string {
  if (typeof v === 'bigint') return JSON.stringify(`${v}n`);
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(',')}}`;
}

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
/** A parsed part's rules as one short line: the first 16 hex characters of its canonical JSON's sha256. */
const rulesHash = (v: unknown): string => `sha256 ${sha256Hex(canonicalJson(v)).slice(0, 16)}`;

/**
 * A document's lines as a reviewer reads them, each keyed: what it describes; the attached apps (each id, name and
 * whether it is deleted, in order); each account of its address book (keyed by the account, so a rename is a change);
 * each format's line with its rows ("label: value"), in the preview's plain-text form with its example values (the
 * API's preview and diff, apps/api/src/labels/document.ts, with the first app's name, as the API does); and the hash
 * of each format's parsed rules and of the parsed context and metadata, so a rule a parser reads differently (an
 * amount's bound, the assets, the memo, a deposit, the gas, `relayed`, an argument's spec) is a changed line even when
 * every example line is the same.
 */
export function renderedLines(doc: LabelDocument, apps: readonly AttachedApp[]): [string, string][] {
  const accounts = addressBookLines(doc);
  const appName = apps[0]?.name ?? apps[0]?.id ?? 'the app';
  const formats = previewLabelDocument(doc, appName);
  return [
    ['(describes)', labelContextKey(doc)],
    ['(apps)', apps.map((a) => `${a.id} “${a.name ?? '(no name)'}”${a.deleted ? ' (deleted)' : ''}`).join(', ')],
    ...doc.metadata.addressBook.map((e, i): [string, string] => [`(account) ${e.account}`, accounts[i]!]),
    ...formats.map((f): [string, string] => [f.key, [f.line, ...f.fields.map((x) => `${x.label}: ${x.value}`)].join(' · ')]),
    ['(rules) context and metadata', rulesHash({ context: doc.context, metadata: doc.metadata })],
    ...Object.keys(doc.formats)
      .sort()
      .map((k): [string, string] => [`(rules) ${k}`, rulesHash(doc.formats[k])]),
  ];
}

export type LabelVerdict =
  | { kind: 'same' }
  | { kind: 'parses'; compared: false }
  | { kind: 'fails'; problems: string[] }
  | { kind: 'differs'; diff: string[] }
  | { kind: 'not_in_baseline' };

export const BASELINE_FORMAT = 'hana-id/labels-check/v2';

/** Which code wrote a baseline, or runs the check. */
export interface LabelsBuild {
  /** HEAD's full hash, or null outside a git checkout. */
  commit: string | null;
  /** The tree had uncommitted changes: not exactly any commit. */
  dirty: boolean;
  /** The API's deployed build id (`GET /v1/health`'s `build`, as deploy-check reads it), with --remote; else null. */
  deployed: string | null;
}

export interface LabelsBaseline {
  format: typeof BASELINE_FORMAT;
  env: string;
  database: string;
  remote: boolean;
  takenAt: string;
  build: LabelsBuild;
  /** Per version id: its text's sha256 (as stored) and its lines. */
  versions: Record<string, { sha256: string; lines: [string, string][] }>;
}

const isBuild = (b: unknown): b is LabelsBuild => {
  const x = b as Partial<LabelsBuild> | null;
  return !!x && (x.commit === null || (typeof x.commit === 'string' && /^[0-9a-f]{40,64}$/u.test(x.commit))) && typeof x.dirty === 'boolean' && (x.deployed === null || typeof x.deployed === 'string');
};

/** Checks a parsed file is a baseline of this format, env and database, never trusting its shape blindly. */
export function parseBaseline(v: unknown, env: string, database: string, remote: boolean): LabelsBaseline {
  const b = v as Partial<LabelsBaseline> | null;
  if (!b || typeof b !== 'object' || b.format !== BASELINE_FORMAT || typeof b.versions !== 'object' || b.versions === null || Array.isArray(b.versions) || typeof b.takenAt !== 'string' || !isBuild(b.build)) {
    throw new CliError(`--baseline is not a ${BASELINE_FORMAT} file (write one with --save from this version of the command)`);
  }
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
  if (out.length === 0 && before.map(([k]) => k).join('\n') !== after.map(([k]) => k).join('\n')) out.push(cut(`~ the same lines in another order: ${after.map(([k]) => k).join(', ')}`));
  return out.length > MAX_DIFF_LINES ? [...out.slice(0, MAX_DIFF_LINES), `… and ${out.length - MAX_DIFF_LINES} more changed lines`] : out;
}

/** One version's verdict and (when it parses) its lines. */
export function checkVersion(r: LabelCheckRow, baseline: LabelsBaseline | null): { verdict: LabelVerdict; lines: [string, string][] | null } {
  const problems: string[] = [];
  if (sha256Hex(r.doc_text) !== r.doc_sha256) problems.push('stored_text_changed (the text no longer matches its stored sha256)');
  const parsed = parseLabelDocument(r.doc_text);
  if (!parsed.ok) problems.push(...parsed.errors.map((e) => `${e.code} at ${e.path || '(the document)'}`));
  if (problems.length || !parsed.ok) return { verdict: { kind: 'fails', problems }, lines: null };
  const lines = renderedLines(parsed.document, JSON.parse(r.apps_named) as AttachedApp[]);
  if (baseline === null) return { verdict: { kind: 'parses', compared: false }, lines };
  const was = Object.hasOwn(baseline.versions, r.id) ? baseline.versions[r.id]! : null;
  if (was === null || was.sha256 !== r.doc_sha256) return { verdict: { kind: 'not_in_baseline' }, lines };
  const diff = linesDiff(was.lines, lines);
  return { verdict: diff.length ? { kind: 'differs', diff } : { kind: 'same' }, lines };
}

/** The name `--save` writes, and the only one `--out` may name: `labels-lines-<letters, digits, . _ ->.json`. */
const BASELINE_NAME = /^labels-lines-[A-Za-z0-9._-]{1,64}\.json$/u;

/**
 * Where `--save` writes: `out`, which must be a new `labels-lines-*.json` directly in `.secrets/<env>/` (so it can't
 * replace another secret, or land outside the env's folder), else the default name there.
 */
export function baselineTarget(out: string | undefined, envDir: string, now: Date): string {
  const file = resolve(out ?? `${envDir}/labels-lines-${now.toISOString().replace(/[:.]/gu, '').replace(/-/gu, '')}.json`);
  if (dirname(file) !== resolve(envDir)) throw new CliError(`--out must be in ${envDir}`);
  if (!BASELINE_NAME.test(basename(file))) throw new CliError('--out must be named labels-lines-<name>.json');
  return file;
}

/** Writes a NEW 0600 JSON file (created exclusively: an existing file is never replaced), its folder 0700. */
export function writeNewSecretJson(file: string, value: unknown): void {
  ensureSecretDir(dirname(file));
  try {
    writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE, flag: 'wx' });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new CliError(`${file} already exists: --save never replaces a file`);
    throw e;
  }
  chmodSync(file, FILE_MODE);
}

/** Reads a baseline file: 0600 only, JSON (an error names the file, never its text). */
export function readBaselineFile(file: string): unknown {
  try {
    assertPrivate(file);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new CliError(`--baseline: no file ${file}`);
    throw e;
  }
  return parseSecretJson<unknown>(readFileSync(file, 'utf8'), file);
}

export interface LabelsCheckDeps {
  /** One SELECT on the API's D1 (apiPrivateD1Execute; node:sqlite in tests). */
  read(statement: string): Promise<Record<string, unknown>[]> | Record<string, unknown>[];
  /** This checkout's commit and tree, and (remote only) the API's deployed build id. */
  build(remote: boolean): Promise<LabelsBuild> | LabelsBuild;
  secretsEnvDir(env: string): string;
  /** Creates a new file (writeNewSecretJson); never replaces one. */
  writeNew(file: string, value: unknown): void;
  /** Reads a baseline file (readBaselineFile). */
  readJson(file: string): unknown;
  log(line: string): void;
  now(): Date;
}

export interface LabelsCheckOptions {
  env: string;
  network: string;
  database: string;
  remote: boolean;
  /** --save: write the lines, to `out` or the default file in `.secrets/<env>/`. */
  save: boolean;
  out: string | undefined;
  baseline: string | undefined;
  /** --same-build: comparing with a baseline of this same commit is meant. */
  sameBuild: boolean;
}

const stateOf = (r: LabelCheckRow, nowMs: number): string =>
  r.status === 'active' ? 'in force' : r.notified_at !== null && r.active_from !== null && r.active_from <= nowMs ? 'in force from its due time (unless held for review)' : 'waiting';

const buildText = (b: LabelsBuild): string => `${b.commit ? b.commit.slice(0, 12) : 'no commit'}${b.dirty ? ' with uncommitted changes' : ''}`;

/** Runs the check; resolves to the exit code (0: every version parses the same, or parses when not compared). */
export async function labelsCheck(o: LabelsCheckOptions, deps: LabelsCheckDeps): Promise<number> {
  // Every line printed: a partner's key or words, or a baseline's values, never reach the terminal as controls.
  const log = (line: string): void => deps.log(displaySafeLine(line));
  try {
    return await run(o, deps, log);
  } catch (e) {
    if (e instanceof CliError) throw new CliError(displaySafeLine(e.message));
    throw e;
  }
}

async function run(o: LabelsCheckOptions, deps: LabelsCheckDeps, log: (line: string) => void): Promise<number> {
  if (o.network === 'mainnet') throw new CliError(`${o.env} is a mainnet env: labels:check runs on testnet envs only`);
  if (o.out !== undefined && !o.save) throw new CliError('--out is where --save writes: add --save');
  if (o.sameBuild && o.baseline === undefined) throw new CliError('--same-build is for --baseline');
  const now = deps.now();
  const target = o.save ? baselineTarget(o.out, deps.secretsEnvDir(o.env), now) : null;
  const baseline = o.baseline === undefined ? null : parseBaseline(deps.readJson(o.baseline), o.env, o.database, o.remote);
  const build = await deps.build(o.remote);
  if (baseline) {
    log(`Baseline: written by ${buildText(baseline.build)} at ${baseline.takenAt}${baseline.build.deployed ? `; the API then ran ${baseline.build.deployed}` : ''}`);
    log(`This checkout: ${buildText(build)}${build.deployed ? `; the API runs ${build.deployed}` : ''}`);
    if (baseline.build.commit !== null && baseline.build.commit === build.commit && !o.sameBuild) {
      throw new CliError('The baseline was written by this same commit, so it would compare a build with itself: take it from a checkout of the deployed commit (or pass --same-build if that is what you mean)');
    }
    if (baseline.build.deployed && baseline.build.commit && !baseline.build.deployed.startsWith(baseline.build.commit.slice(0, 12))) {
      log(`Warning: the baseline was not written from the deployed commit (${baseline.build.deployed}): what it holds may not be what the versions were reviewed with`);
    }
    if (baseline.build.dirty) log('Warning: the baseline was written from a tree with uncommitted changes');
  }
  if (build.dirty) log('Warning: this checkout has uncommitted changes: what it parses is not exactly any commit');
  const rows: LabelCheckRow[] = [];
  for (let after: string | null = null; ; ) {
    const page = (await deps.read(labelsCheckSql(after))) as unknown as LabelCheckRow[];
    rows.push(...page);
    if (page.length < PAGE) break;
    after = page[page.length - 1]!.id;
  }
  log(`${o.env}: ${o.database} (${o.remote ? 'remote' : 'local'}): ${rows.length} Request labels version${rows.length === 1 ? '' : 's'} waiting or in force${baseline ? `, compared with ${o.baseline}` : ''}`);
  const saved: LabelsBaseline['versions'] = {};
  let bad = 0;
  for (const r of rows) {
    const { verdict, lines } = checkVersion(r, baseline);
    if (lines) saved[r.id] = { sha256: r.doc_sha256, lines };
    const apps = (JSON.parse(r.apps_named) as AttachedApp[]).map((a) => a.id).join(', ');
    const head = `  ${r.id} (apps ${apps}; ${stateOf(r, now.getTime())}):`;
    switch (verdict.kind) {
      case 'same':
        log(`${head} parses the same`);
        break;
      case 'parses':
        log(`${head} parses (lines not compared: no --baseline)`);
        break;
      case 'fails':
        bad += 1;
        log(`${head} FAILS: ${verdict.problems.join('; ')}`);
        break;
      case 'differs':
        bad += 1;
        log(`${head} READS DIFFERENTLY:`);
        for (const l of verdict.diff) log(`      ${l}`);
        break;
      case 'not_in_baseline':
        bad += 1;
        log(`${head} NOT COMPARED: not in the baseline (proposed after it, or its text differs): take the baseline again`);
        break;
    }
  }
  if (target) {
    const out: LabelsBaseline = { format: BASELINE_FORMAT, env: o.env, database: o.database, remote: o.remote, takenAt: now.toISOString(), build, versions: saved };
    deps.writeNew(target, out);
    log(`Lines of ${Object.keys(saved).length} version${Object.keys(saved).length === 1 ? '' : 's'} written by ${buildText(build)} to ${target} (0600): pass it as --baseline from the checkout of the commit to deploy`);
  }
  if (bad) log(`${bad} version${bad === 1 ? '' : 's'} to propose again (and the old one blocked with a note): docs/operations.md "Before switching partner labels on in an env"`);
  else if (rows.length && baseline === null) log('Every version parses; the lines were not compared (run with --baseline to compare them)');
  return bad ? 1 : 0;
}
