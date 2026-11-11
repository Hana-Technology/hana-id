// The local gate (scripts/verify.mjs, scripts/verify-hook.mjs, .githooks/pre-push; D413): which packages and jobs a
// change selects in each tier, against synthetic workspaces and this repo's own; that every CI job has its step with
// CI's commands; and the pre-push hook's branch filter and refusals, as functions and as the shell hook git runs, in
// temp git repositories.
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repoRoot } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';

type Pkg = { name: string; dir: string; deps: string[] };
type Reads = Map<string, { code: Set<string>; test: Set<string> }>;
type Selection = { all: true; reason: string } | { all: false; names: string[]; reason: string };
type Cmd = { cmd: string; args: string[]; cwd: string; env: Record<string, string> };
type Step = { id: string; title: string; phase: number; lane: string; run: Cmd[]; skip: string | null };
type Result = { result: string; ms: number; start: number };
type Run = { done: Promise<{ ok: boolean; ms: number; failed?: string; cwd?: string }>; stop: () => void };
type Plan = { mode: string; selection: Selection; jobs: { rust: boolean; web: boolean }; steps: Step[] };
type Mode = 'quick' | 'default' | 'full';
interface VerifyModule {
  VERIFY_FILES: string[];
  DOCS_PACKAGES: string[];
  workspaceGlobs(yaml: string): string[];
  workspacePackages(root?: string): Pkg[];
  ownerOf(file: string, pkgs: Pkg[]): Pkg | undefined;
  pathsNamed(file: string, text: string, ctx?: { rootFiles?: Set<string>; ownDirs?: Set<string> }): Set<string>;
  withoutComments(text: string): string;
  isTestFile(path: string): boolean;
  scanReads(pkgs: Pkg[], root?: string): Reads;
  selectPackages(files: string[] | null, pkgs: Pkg[], reads: Reads): Selection;
  changedFiles(base: string, cwd?: string): { files: string[] | null; reason: string };
  plan(o: { mode: Mode; files: string[] | null; pkgs: Pkg[]; reads: Reads; dirty?: boolean; cpus?: number }): Plan;
  parseArgs(argv: string[]): { mode: Mode; all: boolean; base: string; plan: boolean; json: boolean; files: string[] | null };
  summaryTable(rows: string[][]): string;
  summaryRows(steps: Step[], results: Map<string, Result>, failed: object | null, wallMs: number): string[][];
  lanes(steps: Step[], phase: number): [string, Step[]][];
  schedule(
    p: { steps: Step[] },
    deps?: { run?: (s: Step, logPath: string) => Run; log?: (line: string) => void; logDir?: string },
  ): Promise<{ results: Map<string, Result>; failed: { s: Step } | null; ms: number }>;
  fmt(ms: number): string;
  SANDBOX_TEST_THREADS: number;
}
type Update = { localRef: string; localSha: string; remoteRef: string; remoteSha: string };
type Decision = { action: 'skip' | 'refuse' | 'run'; message: string; args?: string[] };
interface HookModule {
  CONFIG_KEY: string;
  parseUpdates(text: string): Update[];
  decide(updates: Update[], repo: { head: string; dirty: boolean; hasCommit: (sha: string) => boolean }): Decision;
}

const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(repoRoot, 'scripts', file)).href)) as T;
const V = await load<VerifyModule>('verify.mjs');
const H = await load<HookModule>('verify-hook.mjs');

const names = (s: Selection) => (s.all ? 'all' : s.names);

describe('arguments', () => {
  it('takes one tier, a base, --all, and --files / --json only with --plan', () => {
    expect(V.parseArgs([])).toMatchObject({ mode: 'default', all: false, base: 'origin/develop', plan: false });
    expect(V.parseArgs(['--quick', '--all'])).toMatchObject({ mode: 'quick', all: true });
    expect(V.parseArgs(['--full', '--base', 'abc'])).toMatchObject({ mode: 'full', base: 'abc' });
    expect(V.parseArgs(['--plan', '--json', '--files', 'a', '--b'])).toMatchObject({ plan: true, json: true, files: ['a', '--b'] });
    expect(() => V.parseArgs(['--quick', '--full'])).toThrow(/exclude/u);
    expect(() => V.parseArgs(['--files', 'a'])).toThrow(/only for --plan/u);
    expect(() => V.parseArgs(['--json'])).toThrow(/only for --plan/u);
    expect(() => V.parseArgs(['--base'])).toThrow(/needs a ref/u);
    expect(() => V.parseArgs(['--base', '--quick'])).toThrow(/needs a ref/u);
    expect(() => V.parseArgs(['--fast'])).toThrow(/unknown option/u);
  });
});

describe('the workspace', () => {
  it('reads the package globs of pnpm-workspace.yaml, comments and later keys aside', () => {
    expect(V.workspaceGlobs("packages:\n  - apps/*\n  # a note\n  - 'scripts'\n\n  - examples/*\nallowBuilds:\n  esbuild: true\n")).toEqual(['apps/*', 'scripts', 'examples/*']);
  });

  it("finds this repo's packages, the nested React 18 one included, with their workspace dependencies only", () => {
    const pkgs = V.workspacePackages();
    const by = new Map(pkgs.map((p) => [p.name, p]));
    expect(by.get('@hana-id/react-on-react18')?.dir).toBe('packages/react/react18');
    expect(by.get('@hana-id/example-identity-verify')?.dir).toBe('examples/identity-verify');
    expect(by.get('@hana-id/scripts')?.dir).toBe('scripts');
    expect(by.get('@hana-id/oidc')?.deps).toEqual(['@hana-id/jwks']);
    for (const p of pkgs) for (const d of p.deps) expect(by.has(d), `${p.name} -> ${d}`).toBe(true);
  });

  it('gives a path to the deepest package containing it', () => {
    const pkgs = V.workspacePackages();
    expect(V.ownerOf('packages/react/react18/test/a.test.tsx', pkgs)?.name).toBe('@hana-id/react-on-react18');
    expect(V.ownerOf('packages/react/src/index.ts', pkgs)?.name).toBe('@hana-id/react');
    expect(V.ownerOf('apps/api', pkgs)?.name).toBe('@hana-id/api');
    expect(V.ownerOf('apps/apix/a.ts', pkgs)).toBeUndefined();
    expect(V.ownerOf('docs/operations.md', pkgs)).toBeUndefined();
  });

  it('finds the paths a file names: ../ paths, repoRoot joins, root-relative strings and root Markdown names', () => {
    const text = [
      "import x from '../../../contracts/hana-signer/src/test_fixture.json';",
      "const a = here('../api/src/shims/secp256k1.ts');",
      "readFileSync(join(repoRoot, 'docs', 'decisions.md'));",
      "const runbooks = ['docs/operations.md', 'README.md', 'NOT-THERE.md'];",
      "include: ['scripts/test/**/*.test.ts'],",
      "const url = 'https://example.test/docs/x';",
    ].join('\n');
    const got = V.pathsNamed('apps/admin/test/x.test.ts', text, { rootFiles: new Set(['README.md']), ownDirs: new Set(['scripts', 'src']) });
    expect([...got].sort()).toEqual(['apps/admin/api/src/shims/secp256k1.ts', 'contracts/hana-signer/src/test_fixture.json', 'docs/decisions.md', 'docs/operations.md', 'README.md'].sort());
    // From the package dir itself (a vitest config), `../api` is the sibling app.
    expect([...V.pathsNamed('apps/admin/vitest.config.ts', "here('../api/src/x.ts')")]).toEqual(['apps/api/src/x.ts']);
  });

  it('ignores paths named in comments', () => {
    const text = "// see docs/operations.md\n/* docs/a.md */\n * docs/b.md\nconst x = 1; // docs/c.md\nconst y = 'docs/d.md';";
    expect([...V.pathsNamed('scripts/a.ts', V.withoutComments(text))]).toEqual(['docs/d.md']);
  });

  it('tells tests and test configs from code', () => {
    for (const f of ['test/a.test.ts', 'test-usage/db.ts', 'scripts/test/gen.test.ts', 'tests/login.spec.ts', 'vitest.config.ts', 'vitest.usage.config.ts', 'playwright.config.ts', 'src/stamped-deploy.test.ts']) {
      expect(V.isTestFile(f), f).toBe(true);
    }
    for (const f of ['src/index.ts', 'scripts/gen-wrangler.ts', 'package.json', 'tsconfig.json', 'src/testing.ts']) expect(V.isTestFile(f), f).toBe(false);
  });
});

describe('package selection (synthetic workspace)', () => {
  // base <- mid <- top (declared deps); builder's code names a path in mid (bundles it); tester's tests name base;
  // reader's tests name docs/guide.md; loner stands alone.
  const pkgs: Pkg[] = [
    { name: 'base', dir: 'packages/base', deps: [] },
    { name: 'mid', dir: 'packages/mid', deps: ['base'] },
    { name: 'top', dir: 'apps/top', deps: ['mid'] },
    { name: 'builder', dir: 'apps/builder', deps: [] },
    { name: 'after-builder', dir: 'apps/after-builder', deps: ['builder'] },
    { name: 'tester', dir: 'apps/tester', deps: [] },
    { name: 'after-tester', dir: 'apps/after-tester', deps: ['tester'] },
    { name: 'reader', dir: 'packages/reader', deps: [] },
    { name: 'loner', dir: 'packages/loner', deps: [] },
  ];
  const reads: Reads = new Map(pkgs.map((p) => [p.name, { code: new Set<string>(), test: new Set<string>() }]));
  reads.get('builder')!.code.add('packages/mid/src');
  reads.get('tester')!.test.add('packages/base/test/helpers.ts');
  reads.get('reader')!.test.add('docs/guide.md');
  reads.get('loner')!.test.add('docs');
  const sel = (...files: string[]) => names(V.selectPackages(files, pkgs, reads));

  it("a package's change: it, its dependents and code readers transitively, and its test readers (not theirs)", () => {
    expect(sel('packages/base/src/a.ts')).toEqual(['base', 'mid', 'top', 'builder', 'after-builder', 'tester']);
    expect(sel('packages/mid/src/a.ts')).toEqual(['mid', 'top', 'builder', 'after-builder']);
    expect(sel('apps/top/src/a.ts')).toEqual(['top']);
    expect(sel('apps/tester/test/a.test.ts')).toEqual(['tester', 'after-tester']);
  });

  it('a doc outside the packages: the packages that name it or a dir above it, nothing transitive', () => {
    expect(sel('docs/guide.md')).toEqual(['reader', 'loner']);
    expect(sel('docs/other.md')).toEqual(['loner']);
    expect(sel('README.md')).toEqual([]);
  });

  it('anything else outside the packages, and the CI and verify definitions, run every package', () => {
    for (const f of ['contracts/hana-signer/src/lib.rs', 'envs/sandbox-dev.json', 'pnpm-lock.yaml', 'package.json', '.gitleaks.toml', '.github/workflows/ci.yml', 'scripts/ci-changes.mjs', ...V.VERIFY_FILES]) {
      const s = V.selectPackages(['packages/loner/a.ts', f], pkgs, reads);
      expect(s.all, f).toBe(true);
    }
    expect(V.selectPackages(null, pkgs, reads).all).toBe(true);
  });

  it('no change: no package', () => {
    expect(sel()).toEqual([]);
  });
});

describe("package selection (this repo's workspace)", () => {
  const pkgs = V.workspacePackages();
  const reads = V.scanReads(pkgs);
  const sel = (...files: string[]) => V.selectPackages(files, pkgs, reads);
  const has = (s: Selection, n: string) => s.all || s.names.includes(n);

  it('a doc runs the suites that read it, not the whole workspace', () => {
    const ops = sel('docs/operations.md');
    expect(ops.all).toBe(false);
    for (const n of ['@hana-id/playbooks', '@hana-id/scripts']) expect(has(ops, n), n).toBe(true);
    expect(has(ops, '@hana-id/api')).toBe(false);
    const guide = sel('docs/integration.md');
    for (const n of ['@hana-id/core', '@hana-id/example-identity-verify']) expect(has(guide, n), n).toBe(true);
    // The playbooks doc is generated from @hana-id/playbooks; the admin Worker no longer names it (its security digest
    // pointed partners at it until D704), so a change to the doc alone doesn't run the admin's suites.
    expect(has(sel('docs/playbooks.md'), '@hana-id/playbooks')).toBe(true);
    expect(has(sel('docs/playbooks.md'), '@hana-id/admin')).toBe(false);
  });

  it('a leaf package runs with its readers only; @hana-id/react runs its React 18 suite too', () => {
    const leaf = sel('examples/identity-verify/src/verify.ts');
    expect(leaf.all).toBe(false);
    expect(has(leaf, '@hana-id/example-identity-verify')).toBe(true);
    for (const n of ['@hana-id/api', '@hana-id/web', '@hana-id/core', '@hana-id/admin']) expect(has(leaf, n), n).toBe(false);
    expect(has(sel('packages/react/src/index.ts'), '@hana-id/react-on-react18')).toBe(true);
  });

  it('the API reaches the admin suite (its vitest config bundles the API Worker) and the e2e suite', () => {
    for (const n of ['@hana-id/admin', '@hana-id/e2e', '@hana-id/api']) expect(has(sel('apps/api/src/index.ts'), n), n).toBe(true);
  });

  it('@hana-id/core reaches everything built on it', () => {
    const s = sel('packages/core/src/index.ts');
    for (const n of ['@hana-id/web', '@hana-id/react', '@hana-id/react-on-react18', '@hana-id/sodax', '@hana-id/console-core', '@hana-id/api']) expect(has(s, n), n).toBe(true);
  });

  it('contracts/ runs every package (the TS tests read its fixtures)', () => {
    expect(sel('contracts/hana-signer/src/test_fixture.json').all).toBe(true);
  });
});

describe('the plan', () => {
  const pkgs = V.workspacePackages();
  const reads = V.scanReads(pkgs);
  const plan = (mode: Mode, files: string[] | null, dirty = false) => V.plan({ mode, files, pkgs, reads, dirty, cpus: 8 });
  const step = (p: Plan, id: string) => {
    const s = p.steps.find((x) => x.id === id);
    if (!s) throw new Error(`no step ${id}`);
    return s;
  };
  const ran = (p: Plan) => p.steps.filter((s) => !s.skip).map((s) => s.id);
  const line = (c: Cmd) => [c.cmd, ...c.args].join(' ');

  it('--quick: lockfile, gitleaks, typecheck, unit tests and docs checks, never the Rust, pack or browser jobs', () => {
    const p = plan('quick', ['packages/web/src/index.ts', 'contracts/hana-signer/src/lib.rs']);
    expect(ran(p)).toEqual(['install', 'secrets', 'typecheck', 'unit', 'docs']);
    for (const id of ['contract', 'sandbox', 'pack', 'e2e']) expect(step(p, id).skip, id).toBe('not in --quick');
  });

  it('default: what a develop push ran, by CI’s rules (scripts/ci-changes.mjs)', () => {
    const web = plan('default', ['packages/web/src/index.ts']);
    expect(ran(web)).toEqual(['install', 'secrets', 'typecheck', 'unit', 'docs', 'pack', 'e2e']);
    expect(step(web, 'e2e').run.map(line)).toEqual(['pnpm --filter @hana-id/e2e run e2e --forbid-only --project chromium']);
    expect(step(web, 'contract').skip).toBe('no Rust change');

    const rust = plan('default', ['contracts/hana-signer/src/lib.rs']);
    expect(ran(rust)).toEqual(['install', 'secrets', 'typecheck', 'contract', 'unit', 'docs', 'sandbox']);
    expect(step(rust, 'pack').skip).toBe('no web change');

    const both = plan('default', ['apps/api/src/gas.ts']);
    expect(ran(both)).toContain('contract');
    expect(ran(both)).toContain('e2e');

    const docs = plan('default', ['docs/operations.md']);
    expect(ran(docs)).toEqual(['install', 'secrets', 'typecheck', 'unit', 'docs']);
  });

  it('a change to the verify or CI definitions runs every job', () => {
    for (const f of ['scripts/verify.mjs', '.githooks/pre-push', '.github/workflows/ci.yml']) {
      const p = plan('default', [f]);
      expect(p.jobs, f).toEqual({ rust: true, web: true });
      expect(p.selection.all, f).toBe(true);
    }
  });

  it('--full: every package and job whatever changed, Playwright on all three browsers', () => {
    const p = plan('full', ['docs/operations.md']);
    expect(ran(p)).toEqual(['install', 'secrets', 'typecheck', 'contract', 'audit', 'unit', 'docs', 'sandbox', 'pack', 'e2e']);
    expect(p.selection.all).toBe(true);
    expect(step(p, 'typecheck').run.map(line)).toEqual(['pnpm -r --workspace-concurrency=4 --reporter=append-only typecheck']);
    expect(step(p, 'e2e').run.map(line)).toEqual(['pnpm --filter @hana-id/e2e run e2e --forbid-only --project chromium --project firefox --project webkit']);
  });

  it('cheapest first: lockfile; gitleaks + typecheck + contract; unit + docs; sandbox beside pack then browsers (D423)', () => {
    const p = plan('full', null);
    expect(Object.fromEntries(p.steps.map((s) => [s.id, s.phase]))).toEqual({ install: 0, secrets: 1, typecheck: 1, contract: 1, audit: 1, unit: 2, docs: 2, sandbox: 3, pack: 3, e2e: 4 });
    const laneIds = (ph: number) => V.lanes(p.steps, ph).map(([lane, steps]) => [lane, steps.map((s) => s.id)]);
    expect(laneIds(1)).toEqual([['secrets', ['secrets']], ['typecheck', ['typecheck']], ['contract', ['contract']], ['audit', ['audit']]]);
    // The pack check and Playwright one after the other (both build @hana-id/web), beside the sandbox nodes.
    expect(laneIds(3)).toEqual([['sandbox', ['sandbox']], ['web', ['pack']]]);
    // Playwright alone, after the sandbox nodes are gone (Firefox timed out beside them, 2026-11-06).
    expect(laneIds(4)).toEqual([['e2e', ['e2e']]]);
    // The table lists the steps in the order they start.
    expect(p.steps.map((s) => s.id)).toEqual(['install', 'secrets', 'typecheck', 'contract', 'audit', 'unit', 'docs', 'sandbox', 'pack', 'e2e']);
  });

  it('the unit tests share their phase with the docs checks only, in every tier (D140: PGlite and workerd time out under load)', () => {
    for (const p of [plan('full', null), plan('default', ['apps/api/src/gas.ts']), plan('quick', ['apps/api/src/gas.ts'])]) {
      const unit = step(p, 'unit');
      expect(p.steps.filter((s) => s.phase === unit.phase).map((s) => s.id).sort()).toEqual(['docs', 'unit']);
    }
  });

  it('skipped steps leave their lane: a web-only change runs the pack check then Playwright alone in the last phase', () => {
    const web = plan('default', ['packages/web/src/index.ts']);
    expect(V.lanes(web.steps, 3).map(([lane, steps]) => [lane, steps.map((s) => s.id)])).toEqual([['web', ['pack']]]);
    expect(V.lanes(web.steps, 4).map(([lane, steps]) => [lane, steps.map((s) => s.id)])).toEqual([['e2e', ['e2e']]]);
    expect(V.lanes(plan('quick', null).steps, 3)).toEqual([]);
  });

  it(`sandbox e2e: ${V.SANDBOX_TEST_THREADS} tests at a time, each on its own sandbox node`, () => {
    expect(step(plan('full', null), 'sandbox').run.map(line)).toEqual([`cargo test --locked -- --test-threads=${V.SANDBOX_TEST_THREADS}`]);
  });

  it('unit tests: the selected packages but the docs ones, 4 at a time, CI=true (vitest refuses a stray .only)', () => {
    const p = plan('quick', ['docs/operations.md']);
    const unit = step(p, 'unit').run;
    expect(unit).toHaveLength(1);
    expect(unit[0]!.env).toEqual({ CI: 'true' });
    expect(unit[0]!.args).toContain('--workspace-concurrency=4');
    expect(unit[0]!.args).toContain('@hana-id/scripts');
    for (const d of V.DOCS_PACKAGES) expect(unit[0]!.args).not.toContain(d);
    expect(step(p, 'typecheck').run[0]!.args).toContain('@hana-id/playbooks');
    expect(step(p, 'docs').run.map(line)).toEqual([
      'pnpm --filter @hana-id/playbooks --filter @hana-id/example-identity-verify --reporter=append-only test',
      'pnpm --filter @hana-id/core exec vitest run test/integration-doc.test.ts',
    ]);
  });

  it('nothing changed: typecheck and unit tests skip; gitleaks and the docs checks still run', () => {
    const p = plan('default', []);
    expect(step(p, 'typecheck').skip).toBe('no package affected');
    expect(step(p, 'unit').skip).toBe('no package affected');
    expect(ran(p)).toEqual(['install', 'secrets', 'docs']);
  });

  it('gitleaks scans the history, and the uncommitted changes when the tree is dirty, then self-tests its rules', () => {
    expect(step(plan('quick', []), 'secrets').run.map(line)).toEqual([
      'gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 .',
      'node scripts/secret-scan-selftest.mjs gitleaks',
    ]);
    expect(step(plan('quick', [], true), 'secrets').run.map(line)).toEqual([
      'gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 .',
      'gitleaks git --pre-commit --no-banner --redact --config .gitleaks.toml --exit-code 1 .',
      'gitleaks git --pre-commit --staged --no-banner --redact --config .gitleaks.toml --exit-code 1 .',
      'node scripts/secret-scan-selftest.mjs gitleaks',
    ]);
  });
});

describe('.github/workflows/ci.yml: every job has its step, with the same commands', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const jobs = [...yml.slice(yml.indexOf('\njobs:\n')).matchAll(/\n {2}([a-z0-9-]+):\n/gu)].map((m) => m[1]);
  const p = V.plan({ mode: 'full', files: null, pkgs: V.workspacePackages(), reads: V.scanReads(V.workspacePackages()), cpus: 8 });
  const cmds = (...ids: string[]) => p.steps.filter((s) => ids.includes(s.id)).flatMap((s) => s.run.map((c) => [c.cmd, ...c.args].join(' ')));

  it('knows every CI job (a new job needs a verify step, or a reason here)', () => {
    const covered: Record<string, string[]> = { audit: ['audit'], changes: [], secrets: ['secrets'], contract: ['contract'], typescript: ['install', 'typecheck', 'unit'], packages: ['pack'], playwright: ['e2e'], e2e: ['sandbox'] };
    expect(jobs.sort()).toEqual(Object.keys(covered).sort());
  });

  it("runs CI's commands", () => {
    expect(yml).toContain('gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 .');
    expect(cmds('secrets')).toContain('gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 .');
    expect(yml).toContain('node scripts/secret-scan-selftest.mjs ./gitleaks');
    expect(cmds('secrets')).toContain('node scripts/secret-scan-selftest.mjs gitleaks');
    for (const c of ['cargo test --locked', 'cargo near build non-reproducible-wasm', `cargo test --locked -- --test-threads=${V.SANDBOX_TEST_THREADS}`, 'pnpm run pack:check', 'pnpm -r typecheck', 'pnpm -r test', 'pnpm install --frozen-lockfile']) {
      expect(yml, c).toContain(`run: ${c}`);
    }
    expect(cmds('contract')).toEqual(['cargo test --locked', 'cargo near build non-reproducible-wasm']);
    expect(cmds('sandbox')).toEqual([`cargo test --locked -- --test-threads=${V.SANDBOX_TEST_THREADS}`]);
    expect(cmds('pack')).toEqual(['pnpm run pack:check']);
    expect(p.steps.find((s) => s.id === 'contract')!.run[0]!.cwd).toBe('contracts/hana-signer');
    expect(p.steps.find((s) => s.id === 'sandbox')!.run[0]!.cwd).toBe('contracts/integration-tests');
  });
});

describe('the summary', () => {
  it('formats durations and lines up the table', () => {
    expect(V.fmt(1234)).toBe('1.2s');
    expect(V.fmt(125_000)).toBe('2m05s');
    expect(V.summaryTable([['typecheck (all packages)', 'pass', '+2.0s', '17.0s'], ['e2e', 'skip: no web change', '', '']]).split('\n')).toEqual([
      'step                      result               start  duration',
      '------------------------  -------------------  -----  --------',
      'typecheck (all packages)  pass                 +2.0s  17.0s',
      'e2e                       skip: no web change',
    ]);
  });

  it("rows: each step's result, start and duration, steps not reached, the wall-clock total and the steps added up", () => {
    const st = (id: string, skip: string | null = null): Step => ({ id, title: id, phase: 0, lane: id, run: [], skip });
    const results = new Map<string, Result>([
      ['a', { result: 'pass', ms: 60_000, start: 0 }],
      ['b', { result: 'FAIL', ms: 30_000, start: 1_000 }],
    ]);
    expect(V.summaryRows([st('a'), st('b'), st('c'), st('d', 'no web change')], results, {}, 61_000)).toEqual([
      ['a', 'pass', '+0.0s', '1m00s'],
      ['b', 'FAIL', '+1.0s', '30.0s'],
      ['c', 'not run', '', ''],
      ['d', 'skip: no web change', '', ''],
      ['total (wall clock)', 'FAIL', '', '1m01s'],
      ['steps added up', '', '', '1m30s'],
    ]);
    expect(V.summaryRows([st('a')], new Map([['a', { result: 'pass', ms: 1_000, start: 0 }]]), null, 1_200).at(-2)).toEqual(['total (wall clock)', 'pass', '', '1.2s']);
  });
});

describe('the run: phases in order, lanes side by side, a lane one step at a time, stopping at the first failure', () => {
  const st = (id: string, phase: number, lane = id, skip: string | null = null): Step => ({ id, title: `step ${id}`, phase, lane, run: [], skip });
  /** A stand-in for runStep: step `id` takes `ms[id]` ms (default 5) and fails when listed in `fail`; stop() ends it
   * at once, failed, as a killed command does. Records the start, end and stop events in order. */
  function fake(ms: Record<string, number>, fail: string[] = []) {
    const events: string[] = [];
    const run = (s: Step): Run => {
      events.push(`start ${s.id}`);
      let finish: (ok: boolean) => void = () => {};
      const done = new Promise<{ ok: boolean; ms: number }>((res) => {
        const t = setTimeout(() => finish(!fail.includes(s.id)), ms[s.id] ?? 5);
        finish = (ok) => {
          clearTimeout(t);
          finish = () => {};
          events.push(`end ${s.id}`);
          res({ ok, ms: ms[s.id] ?? 5 });
        };
      });
      return {
        done,
        stop: () => {
          events.push(`stop ${s.id}`);
          finish(false);
        },
      };
    };
    return { events, run };
  }
  const steps = [st('install', 0), st('unit', 1), st('docs', 1), st('sandbox', 2), st('pack', 2, 'web'), st('e2e', 2, 'web'), st('skipped', 2, 'web', 'not here')];
  const quiet = { log: () => {}, logDir: tmpdir() };

  it('runs the lanes of a phase side by side and a lane in order; the next phase waits for every lane', async () => {
    const f = fake({ sandbox: 80, pack: 10, e2e: 10 });
    const out = await V.schedule({ steps }, { ...quiet, run: f.run });
    expect(out.failed).toBeNull();
    // The first two phases, then the third phase's two lanes starting together. How the lanes then interleave depends on
    // real timers (on a loaded machine the 80 ms sandbox can end before the web lane's two 10 ms steps), so the rest is
    // checked as what must hold: the web lane runs in order, and every step of the phase ends.
    expect(f.events.slice(0, 8)).toEqual(['start install', 'end install', 'start unit', 'start docs', 'end unit', 'end docs', 'start sandbox', 'start pack']);
    const rest = f.events.slice(8);
    expect([...rest].sort()).toEqual(['end e2e', 'end pack', 'end sandbox', 'start e2e']);
    expect(rest.filter((e) => e !== 'end sandbox')).toEqual(['end pack', 'start e2e', 'end e2e']);
    expect([...out.results.keys()].sort()).toEqual(['docs', 'e2e', 'install', 'pack', 'sandbox', 'unit']);
    for (const r of out.results.values()) expect(r.result).toBe('pass');
    expect(out.results.get('e2e')!.start).toBeGreaterThanOrEqual(out.results.get('pack')!.start + 10);
  });

  it('a failure stops the running siblings, starts nothing after it in their lanes, and runs no later phase', async () => {
    const f = fake({ sandbox: 5, pack: 1_000 }, ['sandbox']);
    const out = await V.schedule({ steps: [...steps, st('later', 3)] }, { ...quiet, run: f.run });
    expect(out.failed?.s.id).toBe('sandbox');
    expect(f.events.slice(-3)).toEqual(['end sandbox', 'stop pack', 'end pack']);
    expect(out.results.get('sandbox')!.result).toBe('FAIL');
    expect(out.results.get('pack')!.result).toBe('stopped');
    expect(out.results.has('e2e')).toBe(false);
    expect(out.results.has('later')).toBe(false);
  });

  it('a failure in an early phase starts nothing after it', async () => {
    const f = fake({ docs: 1_000 }, ['unit']);
    const out = await V.schedule({ steps }, { ...quiet, run: f.run });
    expect(out.failed?.s.id).toBe('unit');
    expect(f.events.filter((e) => e.startsWith('start'))).toEqual(['start install', 'start unit', 'start docs']);
    expect(out.results.get('docs')!.result).toBe('stopped');
  });
});

describe('the root scripts', () => {
  it('pnpm verify and pnpm verify:install-hook run the scripts; pnpm install points git at .githooks', () => {
    const scripts = (JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { scripts: Record<string, string> }).scripts;
    expect(scripts.verify).toBe('node scripts/verify.mjs');
    expect(scripts['verify:install-hook']).toBe('node scripts/verify-hook.mjs install');
    expect(scripts.prepare).toBe('git config core.hooksPath .githooks');
  });
});

// ---------------------------------------------------------------------------------------------------------------

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const C = 'c'.repeat(40);
const Z = '0'.repeat(40);
const up = (remoteRef: string, localSha = A, remoteSha = B, localRef = 'refs/heads/x'): Update => ({ localRef, localSha, remoteRef, remoteSha });
const clean = { head: A, dirty: false, hasCommit: (s: string) => s === B };

describe('the pre-push decision', () => {
  it('parses the ref lines git writes on stdin', () => {
    expect(H.parseUpdates(`refs/heads/develop ${A} refs/heads/develop ${B}\n\nrefs/tags/v1 ${C} refs/tags/v1 ${Z}\n`)).toEqual([
      { localRef: 'refs/heads/develop', localSha: A, remoteRef: 'refs/heads/develop', remoteSha: B },
      { localRef: 'refs/tags/v1', localSha: C, remoteRef: 'refs/tags/v1', remoteSha: Z },
    ]);
  });

  it('feature branches, tags, and deleting a branch push unchecked', () => {
    expect(H.decide([up('refs/heads/feat/x')], clean).action).toBe('skip');
    expect(H.decide([up('refs/tags/v1.0.0')], clean).action).toBe('skip');
    expect(H.decide([up('refs/heads/develop', Z)], clean).action).toBe('skip');
    expect(H.decide([up('refs/heads/developer')], clean).action).toBe('skip');
    expect(H.decide([], clean).action).toBe('skip');
    // A feature branch's checks don't depend on the working tree.
    expect(H.decide([up('refs/heads/feat/x', C)], { ...clean, dirty: true }).action).toBe('skip');
  });

  it('develop: --quick from the tip it replaces; everything when that tip is unknown here or the branch is new', () => {
    expect(H.decide([up('refs/heads/develop')], clean)).toMatchObject({ action: 'run', args: ['--quick', '--base', B] });
    expect(H.decide([up('refs/heads/develop', A, C)], clean)).toMatchObject({ action: 'run', args: ['--quick', '--all'] });
    expect(H.decide([up('refs/heads/develop', A, Z)], clean)).toMatchObject({ action: 'run', args: ['--quick', '--all'] });
  });

  it('main: --quick on every package (CI ran everything on main)', () => {
    expect(H.decide([up('refs/heads/main')], clean)).toMatchObject({ action: 'run', args: ['--quick', '--all'] });
    expect(H.decide([up('refs/heads/develop'), up('refs/heads/main')], clean)).toMatchObject({ action: 'run', args: ['--quick', '--all'] });
  });

  it('a feature branch pushed with develop: develop is checked', () => {
    expect(H.decide([up('refs/heads/feat/x', C), up('refs/heads/develop')], clean)).toMatchObject({ action: 'run', args: ['--quick', '--base', B] });
  });

  it('refuses what it cannot check: a commit other than HEAD, a dirty tree, two commits at once', () => {
    expect(H.decide([up('refs/heads/develop', C)], clean)).toMatchObject({ action: 'refuse', message: expect.stringMatching(/not the checked-out HEAD/u) });
    expect(H.decide([up('refs/heads/develop')], { ...clean, dirty: true })).toMatchObject({ action: 'refuse', message: expect.stringMatching(/uncommitted/u) });
    expect(H.decide([up('refs/heads/develop'), up('refs/heads/main', C)], clean)).toMatchObject({ action: 'refuse', message: expect.stringMatching(/one at a time/u) });
  });

  it('never offers a way around it', () => {
    const src = readFileSync(join(repoRoot, 'scripts', 'verify-hook.mjs'), 'utf8') + readFileSync(join(repoRoot, '.githooks', 'pre-push'), 'utf8');
    expect(src).not.toMatch(/--no-verify|process\.env\.(?!PATH)[A-Z_]*SKIP/u);
    for (const d of [H.decide([up('refs/heads/develop', C)], clean), H.decide([up('refs/heads/develop')], { ...clean, dirty: true })]) expect(d.message).not.toMatch(/no-verify/u);
  });
});

describe('the pre-push hook in a git repository', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };
  /** A repo with the real hook and hook script, and a stand-in scripts/verify.mjs that records its arguments and
   * exits with the code in verify-exit (the real one would run the whole gate). */
  function repo() {
    dir = mkdtempSync(join(tmpdir(), 'hana-verify-hook-'));
    git('init', '-q', '-b', 'develop');
    mkdirSync(join(dir, 'scripts'));
    mkdirSync(join(dir, '.githooks'));
    copyFileSync(join(repoRoot, 'scripts', 'verify-hook.mjs'), join(dir, 'scripts', 'verify-hook.mjs'));
    copyFileSync(join(repoRoot, '.githooks', 'pre-push'), join(dir, '.githooks', 'pre-push'));
    chmodSync(join(dir, '.githooks', 'pre-push'), 0o755);
    writeFileSync(
      join(dir, 'scripts', 'verify.mjs'),
      "import { readFileSync, writeFileSync } from 'node:fs';\nwriteFileSync(new URL('../verify-args', import.meta.url), JSON.stringify(process.argv.slice(2)));\nprocess.exit(Number(readFileSync(new URL('../verify-exit', import.meta.url), 'utf8')));\n",
    );
    writeFileSync(join(dir, '.gitignore'), 'verify-args\nverify-exit\n');
    writeFileSync(join(dir, 'verify-exit'), '0');
    git('add', '-A');
    git('commit', '-q', '-m', 'one');
    const first = git('rev-parse', 'HEAD');
    writeFileSync(join(dir, 'a.txt'), 'a\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'two');
    return { first, head: git('rev-parse', 'HEAD') };
  }
  const hook = (stdin: string) => spawnSync('sh', ['.githooks/pre-push', 'origin', 'https://example.test/r.git'], { cwd: dir, input: stdin, encoding: 'utf8' });
  const argsSeen = () => {
    try {
      return JSON.parse(readFileSync(join(dir, 'verify-args'), 'utf8')) as string[];
    } catch {
      return null;
    }
  };

  it('does nothing until turned on with verify:install-hook, then gates develop', () => {
    const { first, head } = repo();
    const line = `refs/heads/develop ${head} refs/heads/develop ${first}\n`;
    expect(hook(line).status).toBe(0);
    expect(argsSeen()).toBeNull();

    const on = spawnSync(process.execPath, ['scripts/verify-hook.mjs', 'install'], { cwd: dir, encoding: 'utf8' });
    expect(on.status, on.stderr).toBe(0);
    expect(git('config', '--bool', H.CONFIG_KEY)).toBe('true');
    expect(git('config', 'core.hooksPath')).toBe('.githooks');
    expect(spawnSync(process.execPath, ['scripts/verify-hook.mjs', 'install', '--status'], { cwd: dir, encoding: 'utf8' }).stdout).toMatch(/pre-push verify: on/u);

    const r = hook(line);
    expect(r.status, r.stderr).toBe(0);
    expect(argsSeen()).toEqual(['--quick', '--base', first]);
    expect(r.stderr).toMatch(/verify passed/u);

    const off = spawnSync(process.execPath, ['scripts/verify-hook.mjs', 'install', '--uninstall'], { cwd: dir, encoding: 'utf8' });
    expect(off.status).toBe(0);
    rmSync(join(dir, 'verify-args'));
    expect(hook(line).status).toBe(0);
    expect(argsSeen()).toBeNull();
  });

  it('stops the push when verify fails', () => {
    const { first, head } = repo();
    git('config', '--bool', H.CONFIG_KEY, 'true');
    writeFileSync(join(dir, 'verify-exit'), '1');
    const r = hook(`refs/heads/develop ${head} refs/heads/develop ${first}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/verify failed, so the push was stopped/u);
  });

  it('feature branches push without running verify', () => {
    const { first, head } = repo();
    git('config', '--bool', H.CONFIG_KEY, 'true');
    const r = hook(`refs/heads/feat/x ${head} refs/heads/feat/x ${first}\n`);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(argsSeen()).toBeNull();
  });

  it('refuses a dirty tree and a commit other than HEAD without running verify', () => {
    const { first, head } = repo();
    git('config', '--bool', H.CONFIG_KEY, 'true');
    let r = hook(`refs/heads/develop ${first} refs/heads/develop ${Z}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not the checked-out HEAD/u);
    writeFileSync(join(dir, 'b.txt'), 'untracked\n');
    r = hook(`refs/heads/main ${head} refs/heads/main ${first}\n`);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/uncommitted or untracked/u);
    expect(argsSeen()).toBeNull();
  });
});

describe('changed files', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });
  const git = (...args: string[]) => {
    const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
    return r.stdout.trim();
  };

  it('from the merge base with the base ref, with the working tree and untracked files; everything without a base', () => {
    dir = mkdtempSync(join(tmpdir(), 'hana-verify-diff-'));
    git('init', '-q', '-b', 'develop');
    writeFileSync(join(dir, 'a.md'), '1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'a');
    git('checkout', '-q', '-b', 'feat');
    writeFileSync(join(dir, 'b.ts'), '1\n');
    git('add', '-A');
    git('commit', '-q', '-m', 'b');
    git('checkout', '-q', 'develop');
    writeFileSync(join(dir, 'later.ts'), '1\n'); // develop moved on: not part of the branch's change
    git('add', '-A');
    git('commit', '-q', '-m', 'later');
    git('checkout', '-q', 'feat');
    writeFileSync(join(dir, 'a.md'), '2\n');
    writeFileSync(join(dir, 'new.ts'), '1\n');
    expect(V.changedFiles('develop', dir).files).toEqual(['a.md', 'b.ts', 'new.ts']);
    expect(V.changedFiles('origin/nope', dir)).toMatchObject({ files: null, reason: expect.stringMatching(/everything runs/u) });
  });
});
