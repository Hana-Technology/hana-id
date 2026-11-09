#!/usr/bin/env node
// `pnpm verify`: the local gate while CI is off (D387, D413; docs/operations.md "CI and git"). Runs what CI would run
// for the change, picked from the diff against origin/develop with CI's own rules (scripts/ci-changes.mjs, D383),
// cheapest first, failing fast:
//
//   pnpm verify --quick   lockfile, gitleaks, typecheck and unit tests of the affected packages, the docs checks
//   pnpm verify           + what a develop push ran in CI: contract (cargo test + wasm) and sandbox e2e if Rust
//                           changed; SDK pack check and Playwright on Chromium if web code changed
//   pnpm verify --full    everything whatever changed: all packages, the Rust jobs, the pack check, Playwright on
//                           Chromium, Firefox and WebKit
//
//   --all          ignore the diff: every package and job of the chosen tier (--full implies it)
//   --base <ref>   measure the change from merge-base(<ref>, HEAD) instead of origin/develop (the working tree and
//                  untracked files count too)
//   --plan         print what would run and exit; with --json as JSON; with --files <path>... (only with --plan, the
//                  rest of the arguments) for that list of changed files instead of the diff
//
// Phases run one after another; a phase's lanes run side by side, a lane's steps one after another (D423):
//
//   0  lockfile
//   1  gitleaks | typecheck | contract (cargo test + wasm) | dependency advisories (--full)
//   2  unit tests | docs checks                          (alone: see below)
//   3  sandbox e2e | SDK pack check                      (Rust nodes beside a short build)
//   4  Playwright                                        (alone: browsers beside 8 sandbox nodes made Firefox's
//                                                         timing-sensitive specs time out, 2026-11-06)
//
// Each step's output goes to a log in the system temp dir; a failing step's tail is printed, its running siblings are
// stopped and nothing after it starts. Unit tests run at pnpm's default of 4 packages at a time and never beside
// another heavy step: the PGlite suites start a WASM Postgres per test file (30 s / 60 s timeouts, D140) and time out
// on a loaded machine.
// No dependencies beyond Node's standard library.
import { spawn, spawnSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdtempSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CI_FILES, classify, isDocOnly } from './ci-changes.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A change to these runs everything, as CI_FILES do in CI: they decide what runs. */
export const VERIFY_FILES = ['scripts/verify.mjs', 'scripts/verify-hook.mjs', '.githooks/pre-push'];

/** Packages whose whole suites are docs checks (docs/playbooks.md generated from the package, and the commands and
 * decisions the playbooks cite; docs/integration.md's quoted example): they run in every tier, in the docs step. */
export const DOCS_PACKAGES = ['@hana-id/playbooks', '@hana-id/example-identity-verify'];
/** Docs-check files inside larger suites, also run in the docs step. */
export const DOCS_FILES = [{ pkg: '@hana-id/core', file: 'test/integration-doc.test.ts' }];

// ---------------------------------------------------------------------------------------------------------------
// The workspace: its packages, their declared workspace dependencies and the paths their files name.

/** The `packages:` globs of pnpm-workspace.yaml (`dir/*` or a literal dir). */
export function workspaceGlobs(yaml) {
  const out = [];
  let inList = false;
  for (const line of yaml.split('\n')) {
    if (/^packages:\s*$/u.test(line)) {
      inList = true;
      continue;
    }
    if (!inList || /^\s*(?:#.*)?$/u.test(line)) continue;
    if (/^\S/u.test(line)) break;
    const m = /^\s+-\s+['"]?([^'"#\s]+)['"]?/u.exec(line);
    if (m?.[1]) out.push(m[1]);
  }
  return out;
}

/** @returns {{ name: string, dir: string, deps: string[] }[]} dirs relative to the root; deps: workspace ones only */
export function workspacePackages(root = ROOT) {
  const dirs = [];
  for (const glob of workspaceGlobs(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))) {
    if (glob.endsWith('/*')) {
      const base = glob.slice(0, -2);
      for (const d of readdirSync(join(root, base)).sort()) if (existsSync(join(root, base, d, 'package.json'))) dirs.push(`${base}/${d}`);
    } else if (existsSync(join(root, glob, 'package.json'))) dirs.push(glob);
  }
  const pkgs = dirs.map((dir) => {
    const p = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
    return { name: p.name, dir, allDeps: Object.keys({ ...p.dependencies, ...p.devDependencies, ...p.peerDependencies, ...p.optionalDependencies }) };
  });
  const names = new Set(pkgs.map((p) => p.name));
  return pkgs.map(({ allDeps, ...p }) => ({ ...p, deps: allDeps.filter((d) => names.has(d)) }));
}

/** The package a repo path belongs to (the deepest package dir containing it), or undefined. */
export function ownerOf(file, pkgs) {
  let best;
  for (const p of pkgs) {
    if ((file === p.dir || file.startsWith(`${p.dir}/`)) && (!best || p.dir.length > best.dir.length)) best = p;
  }
  return best;
}

const SCAN_EXT = /\.(?:[cm]?[jt]sx?|json|jsonc|html)$/u;
const RELATIVE = /(?<![\w.$/-])((?:\.\.\/)+[\w.@-]*(?:\/[\w.@-]+)*)/gu;
const REPO_ROOT_JOIN = /repoRoot\s*,\s*((?:['"][^'"]+['"]\s*,\s*)*['"][^'"]+['"])/gu;
const ROOT_RELATIVE = /['"`]((?:apps|packages|examples|scripts|docs|contracts|envs|legacy|\.github)\/[^'"`\s$]*)/gu;
const ROOT_MARKDOWN = /['"`]([\w.-]+\.md)['"`]/gu;

/**
 * Repo paths a file names: `../` paths from its dir, `join(repoRoot, '…', …)`, quoted root-relative paths (unless the
 * package has an entry of that name, as in a vitest config's `'scripts/test/**'`) and quoted names of root Markdown
 * files. Over-reporting only runs more tests.
 *
 * @param {string} file the file's repo path
 * @param {{ rootFiles?: Set<string>, ownDirs?: Set<string> }} [ctx] the repo root's entries; the package dir's entries
 */
export function pathsNamed(file, text, { rootFiles = new Set(), ownDirs = new Set() } = {}) {
  const out = new Set();
  const add = (p) => {
    const n = posix.normalize(p).replace(/\/+$/u, '');
    if (n && n !== '.' && !n.startsWith('..')) out.add(n);
  };
  for (const m of text.matchAll(RELATIVE)) add(posix.join(posix.dirname(file), m[1]));
  for (const m of text.matchAll(REPO_ROOT_JOIN)) add([...m[1].matchAll(/['"]([^'"]+)['"]/gu)].map((s) => s[1]).join('/'));
  for (const m of text.matchAll(ROOT_RELATIVE)) if (!ownDirs.has(m[1].split('/')[0])) add(m[1]);
  for (const m of text.matchAll(ROOT_MARKDOWN)) if (rootFiles.has(m[1])) add(m[1]);
  return out;
}

/** The text without comment lines (`//`, `/*`, ` * `) and trailing ` // …` comments: paths named in prose are not
 * reads. URLs (`https://`) are kept. */
export function withoutComments(text) {
  return text
    .split('\n')
    .filter((l) => !/^\s*(?:\/\/|\/\*|\*)/u.test(l))
    .map((l) => l.replace(/\s\/\/\s.*$/u, ''))
    .join('\n');
}

/** A test or a test config (path inside its package): no other package imports it. */
export function isTestFile(pathInPackage) {
  const parts = pathInPackage.split('/');
  const name = parts.at(-1) ?? '';
  return (
    parts.slice(0, -1).some((d) => d === 'test' || d === 'tests' || d.startsWith('test-')) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/u.test(name) ||
    /^(?:vitest|playwright)(?:\.[\w-]+)*\.config\.[cm]?[jt]s$/u.test(name)
  );
}

/**
 * The paths each package's tracked files name (git ls-files: nothing under node_modules, nothing generated), split
 * into what its code names (`code`: other packages may import that code) and what its tests and test configs name.
 *
 * @returns {Map<string, { code: Set<string>, test: Set<string> }>}
 */
export function scanReads(pkgs, root = ROOT) {
  const ls = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (ls.status !== 0) throw new Error(`git ls-files failed: ${ls.stderr}`);
  const rootFiles = new Set(readdirSync(root));
  const ownDirs = new Map(pkgs.map((p) => [p.name, new Set(readdirSync(join(root, p.dir)))]));
  const reads = new Map(pkgs.map((p) => [p.name, { code: new Set(), test: new Set() }]));
  for (const f of ls.stdout.split('\0')) {
    if (!f || !SCAN_EXT.test(f)) continue;
    const owner = ownerOf(f, pkgs);
    if (!owner) continue;
    let text;
    try {
      const abs = join(root, f);
      if (statSync(abs).size > 2 * 1024 * 1024) continue;
      text = readFileSync(abs, 'utf8');
    } catch {
      continue; // deleted in the working tree
    }
    const into = reads.get(owner.name)[isTestFile(f.slice(owner.dir.length + 1)) ? 'test' : 'code'];
    for (const p of pathsNamed(f, withoutComments(text), { rootFiles, ownDirs: ownDirs.get(owner.name) })) into.add(p);
  }
  return reads;
}

/** Whether a set of named paths covers a repo path (the path itself, or a dir above it). */
export function covers(paths, file) {
  for (const p of paths) if (file === p || file.startsWith(`${p}/`)) return true;
  return false;
}

/** Whether a named path reaches into a package (a path inside it, its dir, or a dir above it). */
const reaches = (path, pkg) => path === pkg.dir || path.startsWith(`${pkg.dir}/`) || pkg.dir.startsWith(`${path}/`);

/**
 * The packages to typecheck and test for a change. Conservative:
 *
 * - a file outside every package that is not documentation (contracts/, envs/, root config, the CI and verify
 *   definitions) runs every package: the tests read such files;
 * - a package's own change changes its code, and so the code of every package that depends on it or whose code
 *   names a path in it (a build script bundling another app), transitively; each of those runs, and so does every
 *   package whose tests or test configs name a path in one of them (a vitest config bundling another Worker, a test
 *   importing another app's helpers);
 * - documentation outside the packages (docs/, root Markdown) runs the packages that name it, without the transitive
 *   step (no code changed).
 *
 * @param {string[] | null} files changed paths; null = everything
 * @param {Map<string, { code: Set<string>, test: Set<string> }>} reads from scanReads
 * @returns {{ all: true, reason: string } | { all: false, names: string[], reason: string }}
 */
export function selectPackages(files, pkgs, reads) {
  if (files === null) return { all: true, reason: 'everything (--all, --full or no usable base)' };
  const changed = new Set();
  const docs = [];
  for (const f of files) {
    if (CI_FILES.includes(f) || VERIFY_FILES.includes(f)) return { all: true, reason: `${f} decides what runs: every package` };
    const owner = ownerOf(f, pkgs);
    if (owner) changed.add(owner.name);
    else if (isDocOnly(f)) docs.push(f);
    else return { all: true, reason: `${f} is outside every package (the tests read such files): every package` };
  }
  const byName = new Map(pkgs.map((p) => [p.name, p]));
  const named = (n, kinds) => kinds.flatMap((k) => [...(reads.get(n)?.[k] ?? [])]);
  const affected = new Set(changed);
  const queue = [...changed];
  while (queue.length) {
    const x = byName.get(queue.pop());
    for (const p of pkgs) {
      if (affected.has(p.name)) continue;
      if (p.deps.includes(x.name) || named(p.name, ['code']).some((path) => reaches(path, x))) {
        affected.add(p.name);
        queue.push(p.name);
      }
    }
  }
  const selected = new Set(affected);
  let readers = 0;
  for (const p of pkgs) {
    if (selected.has(p.name)) continue;
    const paths = named(p.name, ['code', 'test']);
    if (paths.some((path) => [...affected].some((a) => reaches(path, byName.get(a)))) || docs.some((d) => covers(paths, d))) {
      selected.add(p.name);
      readers++;
    }
  }
  const names = pkgs.map((p) => p.name).filter((n) => selected.has(n));
  const why = `${changed.size} changed, ${affected.size - changed.size} depend on them, ${readers} read them${docs.length ? ` or the ${docs.length} changed doc(s)` : ''}`;
  if (names.length === pkgs.length) return { all: true, reason: `every package: ${why}` };
  return { all: false, names, reason: why };
}

// ---------------------------------------------------------------------------------------------------------------
// The change.

function git(args, cwd = ROOT) {
  return spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/** Changed paths since merge-base(base, HEAD), the working tree and untracked files included; null = everything. */
export function changedFiles(base, cwd = ROOT) {
  if (git(['rev-parse', '--verify', '--quiet', `${base}^{commit}`], cwd).status !== 0) return { files: null, reason: `base ${base} not found: everything runs` };
  const from = git(['merge-base', base, 'HEAD'], cwd).stdout.trim();
  if (!from) return { files: null, reason: `no merge base with ${base}: everything runs` };
  const diff = git(['diff', '--name-only', '--no-renames', from], cwd);
  const untracked = git(['ls-files', '--others', '--exclude-standard'], cwd);
  if (diff.status !== 0 || untracked.status !== 0) return { files: null, reason: `git diff from ${base} failed: everything runs` };
  const files = [...new Set([...diff.stdout.split('\n'), ...untracked.stdout.split('\n')].filter(Boolean))].sort();
  return { files, from, reason: `${files.length} file(s) changed since ${base} (merge base ${from.slice(0, 9)}, working tree included)` };
}

// ---------------------------------------------------------------------------------------------------------------
// The plan.

const GITLEAKS = ['--no-banner', '--redact', '--config', '.gitleaks.toml', '--exit-code', '1'];
export const BROWSERS = ['chromium', 'firefox', 'webkit'];

/** Sandbox tests run this many at a time, each with its own sandbox node (D423; CI's e2e job runs the same). */
export const SANDBOX_TEST_THREADS = 8;

/**
 * The steps of a run, in phases, cheapest first: phases one after another; in a phase, lanes side by side and a
 * lane's steps in plan order (a step's lane defaults to its id: a lane of its own).
 *
 * @param {{ mode: 'quick' | 'default' | 'full', files: string[] | null, pkgs: object[],
 *   reads: Map<string, { code: Set<string>, test: Set<string> }>, dirty?: boolean, cpus?: number }} o
 */
export function plan({ mode, files, pkgs, reads, dirty = false, cpus = availableParallelism() }) {
  const scope = mode === 'full' ? null : files;
  const sel = selectPackages(scope, pkgs, reads);
  const jobs = scope === null || scope.some((f) => VERIFY_FILES.includes(f)) ? { rust: true, web: true } : classify(scope);
  const unit = sel.all ? sel : { ...sel, names: sel.names.filter((n) => !DOCS_PACKAGES.includes(n)) };
  const notQuick = mode === 'quick' ? 'not in --quick' : null;
  const browsers = mode === 'full' ? BROWSERS : ['chromium'];

  const step = (id, title, phase, run, skip = null, lane = id) => ({ id, title, phase, lane, run, skip });
  const cmd = (c, args, cwd = '.', env = {}) => ({ cmd: c, args, cwd, env });
  const recursive = (script, s, concurrency, env = {}) =>
    cmd('pnpm', ['-r', ...(s.all ? [] : s.names.flatMap((n) => ['--filter', n])), `--workspace-concurrency=${concurrency}`, '--reporter=append-only', script], '.', env);
  const count = (s) => (s.all ? 'all packages' : `${s.names.length} package${s.names.length === 1 ? '' : 's'}`);
  const empty = (s) => (!s.all && s.names.length === 0 ? 'no package affected' : null);

  const secrets = [cmd('gitleaks', ['git', ...GITLEAKS, '.'])];
  if (dirty) secrets.push(cmd('gitleaks', ['git', '--pre-commit', ...GITLEAKS, '.']), cmd('gitleaks', ['git', '--pre-commit', '--staged', ...GITLEAKS, '.']));
  secrets.push(cmd('node', ['scripts/secret-scan-selftest.mjs', 'gitleaks']));

  const steps = [
    // About 2 s when node_modules already match the lockfile; a lockfile out of step fails here, as in CI.
    step('install', 'lockfile (pnpm install --frozen-lockfile)', 0, [cmd('pnpm', ['install', '--frozen-lockfile', '--prefer-offline'])]),
    step('secrets', `gitleaks (history${dirty ? ', uncommitted' : ''}, rule self-test)`, 1, secrets),
    step('typecheck', `typecheck (${count(sel)})`, 1, [recursive('typecheck', sel, Math.max(4, Math.floor(cpus / 2)))], empty(sel)),
    // Beside the typecheck, not the unit tests: from cold its cargo builds use every core for minutes (D140).
    step('contract', 'contract (cargo test + wasm)', 1, [
      cmd('cargo', ['test', '--locked'], 'contracts/hana-signer'),
      cmd('cargo', ['near', 'build', 'non-reproducible-wasm'], 'contracts/hana-signer'),
    ], notQuick ?? (jobs.rust ? null : 'no Rust change')),
    // Needs the network and cargo-audit, and an advisory can fail it with no change here: before a deploy, not each merge.
    step('audit', 'dependency advisories', 1, [cmd('node', ['scripts/dep-audit.mjs'])], mode === 'full' ? null : 'only in --full'),
    // CI=true as in CI: vitest then fails on a stray `.only`. pnpm's default 4 at a time, for the PGlite suites; a
    // phase of their own with the light docs checks.
    step('unit', `unit tests (${count(unit)})`, 2, [recursive('test', unit, 4, { CI: 'true' })], empty(unit)),
    step('docs', 'docs checks (playbooks, integration guide)', 2, [
      cmd('pnpm', [...DOCS_PACKAGES.flatMap((n) => ['--filter', n]), '--reporter=append-only', 'test'], '.', { CI: 'true' }),
      ...DOCS_FILES.map((d) => cmd('pnpm', ['--filter', d.pkg, 'exec', 'vitest', 'run', d.file], '.', { CI: 'true' })),
    ]),
    // The sandbox nodes take ephemeral ports (near-sandbox asks the OS for free ones); the Playwright stack its fixed
    // HANA_E2E_PORT_BASE … +50 (4410 by default), below the ephemeral range. The pack check and Playwright share a
    // lane, one after the other as before: pack's `build:lib` rewrites packages/web/src/envs.generated.ts and the SDK's
    // dist/ while the stack's build bundles @hana-id/web's pages.
    step('sandbox', 'sandbox e2e (near-workspaces)', 3, [cmd('cargo', ['test', '--locked', '--', `--test-threads=${SANDBOX_TEST_THREADS}`], 'contracts/integration-tests')], notQuick ?? (jobs.rust ? null : 'no Rust change')),
    step('pack', 'SDK pack check', 3, [cmd('pnpm', ['run', 'pack:check'])], notQuick ?? (jobs.web ? null : 'no web change'), 'web'),
    step('e2e', `Playwright (${browsers.join(', ')})`, 4, [cmd('pnpm', ['--filter', '@hana-id/e2e', 'run', 'e2e', '--forbid-only', ...browsers.flatMap((b) => ['--project', b])])], notQuick ?? (jobs.web ? null : 'no web change')),
  ];
  return { mode, selection: sel, jobs, steps };
}

// ---------------------------------------------------------------------------------------------------------------
// The run.

export const fmt = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${String(Math.floor((ms % 60_000) / 1000)).padStart(2, '0')}s`);

function tail(path, lines) {
  try {
    return readFileSync(path, 'utf8').split('\n').slice(-lines).join('\n');
  } catch {
    return '';
  }
}

/** Runs a step's commands in order, output to its log. `done` resolves to { ok, ms, failed? }; `stop()` kills the
 * running command's process group. */
function runStep(s, logPath) {
  const fd = openSync(logPath, 'a');
  let child = null;
  let stopped = false;
  const started = Date.now();
  const done = (async () => {
    try {
      for (const c of s.run) {
        if (stopped) return { ok: false, ms: Date.now() - started };
        appendFileSync(fd, `$ ${c.cwd === '.' ? '' : `(cd ${c.cwd}) `}${c.cmd} ${c.args.join(' ')}\n`);
        const code = await new Promise((res) => {
          child = spawn(c.cmd, c.args, { cwd: join(ROOT, c.cwd), env: { ...process.env, ...c.env }, stdio: ['ignore', fd, fd], detached: true });
          child.on('error', (e) => {
            appendFileSync(fd, `verify: could not start ${c.cmd}: ${e.message}\n`);
            res(127);
          });
          child.on('close', (code, signal) => res(code ?? (signal ? 128 : 1)));
        });
        child = null;
        if (code !== 0) return { ok: false, ms: Date.now() - started, failed: `${c.cmd} ${c.args.join(' ')}`, cwd: c.cwd };
      }
      return { ok: true, ms: Date.now() - started };
    } finally {
      closeSync(fd);
    }
  })();
  const stop = () => {
    stopped = true;
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // already gone
      }
    }
  };
  return { done, stop };
}

/** A phase's lanes, of its steps that run (not skipped), in plan order: [lane, steps][]. */
export function lanes(steps, phase) {
  const out = new Map();
  for (const s of steps) if (s.phase === phase && !s.skip) out.set(s.lane, [...(out.get(s.lane) ?? []), s]);
  return [...out];
}

/** @param {string[][]} rows [step, result, start, duration] */
export function summaryTable(rows) {
  const head = ['step', 'result', 'start', 'duration'];
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r) => r.map((c, i) => c.padEnd(w[i])).join('  ').trimEnd();
  return [line(head), line(w.map((n) => '-'.repeat(n))), ...rows.map(line)].join('\n');
}

/** The summary's rows: each step with its result, its start (from the run's start) and its duration; then the
 * wall-clock total and the steps' durations added up (what the run took one step at a time). */
export function summaryRows(steps, results, failed, wallMs) {
  const rows = steps.map((s) => {
    if (s.skip) return [s.title, `skip: ${s.skip}`, '', ''];
    const r = results.get(s.id);
    return [s.title, r?.result ?? 'not run', r ? `+${fmt(r.start)}` : '', r ? fmt(r.ms) : ''];
  });
  const summed = [...results.values()].reduce((n, r) => n + r.ms, 0);
  rows.push(['total (wall clock)', failed ? 'FAIL' : 'pass', '', fmt(wallMs)], ['steps added up', '', '', fmt(summed)]);
  return rows;
}

/**
 * Runs the plan: phases in order; a phase's lanes side by side, a lane's steps one after another. At the first
 * failure the running steps are stopped (result "stopped") and nothing else starts ("not run" in the table).
 *
 * @param {{ steps: object[] }} p
 * @param {{ run?: (s: object, logPath: string) => { done: Promise<object>, stop: () => void },
 *   log?: (line: string) => void, logDir?: string }} [deps] stand-ins for the tests
 * @returns {Promise<{ results: Map<string, { result: string, ms: number, start: number }>, failed: object | null,
 *   ms: number, logDir: string }>}
 */
export async function schedule(p, { run = runStep, log = console.log, logDir } = {}) {
  const dir = logDir ?? mkdtempSync(join(tmpdir(), 'hana-verify-'));
  const results = new Map();
  const running = new Map();
  let failed = null;
  const t0 = Date.now();
  const onSignal = () => {
    for (const r of running.values()) r.stop();
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  const heartbeat = setInterval(() => {
    if (running.size) log(`  …      still running: ${[...running.keys()].join(', ')} (${fmt(Date.now() - t0)} in)`);
  }, 60_000);

  const runLane = async (steps) => {
    for (const s of steps) {
      if (failed) return;
      const logPath = join(dir, `${s.id}.log`);
      const start = Date.now() - t0;
      log(`  start  ${s.title}`);
      const r = run(s, logPath);
      running.set(s.id, r);
      const out = await r.done;
      running.delete(s.id);
      if (out.ok) {
        results.set(s.id, { result: 'pass', ms: out.ms, start });
        log(`  pass   ${s.title} (${fmt(out.ms)})`);
      } else if (failed) {
        results.set(s.id, { result: 'stopped', ms: out.ms, start });
        log(`  stop   ${s.title} (${fmt(out.ms)}: ${failed.s.title} failed)`);
      } else {
        failed = { s, log: logPath, out };
        results.set(s.id, { result: 'FAIL', ms: out.ms, start });
        log(`  FAIL   ${s.title} (${fmt(out.ms)})`);
        for (const [id, other] of running) if (id !== s.id) other.stop();
      }
    }
  };
  try {
    for (const ph of [...new Set(p.steps.map((s) => s.phase))].sort((a, b) => a - b)) {
      if (failed) break;
      await Promise.all(lanes(p.steps, ph).map(([, steps]) => runLane(steps)));
    }
  } finally {
    clearInterval(heartbeat);
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
  return { results, failed, ms: Date.now() - t0, logDir: dir };
}

async function execute(p) {
  const { results, failed, ms, logDir } = await schedule(p);
  if (failed) {
    console.log(`\n--- ${failed.s.title}: \`${failed.out.failed}\`${failed.out.cwd === '.' ? '' : ` (in ${failed.out.cwd})`} failed. Last lines of ${failed.log}:\n`);
    console.log(tail(failed.log, 60));
    console.log('---');
  }
  console.log(`\n${summaryTable(summaryRows(p.steps, results, failed, ms))}\n\nLogs: ${logDir}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------------------------

export function parseArgs(argv) {
  const o = { mode: 'default', all: false, base: 'origin/develop', plan: false, json: false, files: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--quick' || a === '--full') {
      const m = a.slice(2);
      if (o.mode !== 'default' && o.mode !== m) throw new Error('--quick and --full exclude each other');
      o.mode = m;
    } else if (a === '--all') o.all = true;
    else if (a === '--base') {
      o.base = argv[++i];
      if (!o.base || o.base.startsWith('-')) throw new Error('--base needs a ref');
    } else if (a === '--plan') o.plan = true;
    else if (a === '--json') o.json = true;
    else if (a === '--files') {
      o.files = argv.slice(i + 1);
      break;
    } else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown option ${a} (see --help)`);
  }
  if (o.files && !o.plan) throw new Error('--files is only for --plan: a real run measures the diff');
  if (o.json && !o.plan) throw new Error('--json is only for --plan');
  return o;
}

function help() {
  return readFileSync(fileURLToPath(import.meta.url), 'utf8')
    .split('\n')
    .slice(1)
    .filter((l) => l.startsWith('//'))
    .map((l) => l.replace(/^\/\/ ?/u, ''))
    .join('\n');
}

async function main() {
  let o;
  try {
    o = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`verify: ${e.message}`);
    process.exit(2);
  }
  if (o.help) {
    console.log(help());
    return;
  }
  const pkgs = workspacePackages();
  const reads = scanReads(pkgs);
  const change = o.files
    ? { files: o.files, reason: `${o.files.length} file(s) given` }
    : o.all || o.mode === 'full'
      ? { files: null, reason: 'everything (--all or --full)' }
      : changedFiles(o.base);
  const dirty = !o.files && git(['status', '--porcelain']).stdout.trim() !== '';
  const p = plan({ mode: o.mode, files: change.files, pkgs, reads, dirty });
  if (o.json) {
    console.log(JSON.stringify({ mode: p.mode, change: change.reason, files: change.files, selection: p.selection, jobs: p.jobs, steps: p.steps }, null, 2));
    return;
  }
  const head = git(['rev-parse', '--short', 'HEAD']).stdout.trim();
  console.log(`verify ${o.mode === 'default' ? '(default)' : `--${o.mode}`} at ${head}${dirty ? ' + uncommitted changes' : ''}`);
  console.log(`  change:   ${change.reason}`);
  console.log(`  packages: ${p.selection.all ? 'all' : p.selection.names.join(', ') || 'none'} (${p.selection.reason})`);
  console.log(`  jobs:     Rust ${p.jobs.rust ? 'affected' : 'not affected'}, web ${p.jobs.web ? 'affected' : 'not affected'}\n`);
  if (o.plan) {
    for (const s of p.steps) {
      console.log(`${s.skip ? 'skip   ' : `phase ${s.phase}`}  ${s.title}${s.skip ? ` (${s.skip})` : s.lane === s.id ? '' : ` (lane ${s.lane}: one step after another)`}`);
      if (!s.skip) for (const c of s.run) console.log(`         ${c.cwd === '.' ? '' : `(cd ${c.cwd}) `}${Object.entries(c.env).map(([k, v]) => `${k}=${v} `).join('')}${c.cmd} ${c.args.join(' ')}`);
    }
    return;
  }
  process.exitCode = await execute(p);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
