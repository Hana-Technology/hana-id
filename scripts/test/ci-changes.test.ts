// Which CI jobs a change needs (scripts/ci-changes.mjs, D383): the path rules, the base-commit rules against a real
// git repository in a temp dir, that every file outside contracts/ the Rust tests read is a Rust input, and that
// .github/workflows/ci.yml gates its jobs on the outputs.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { repoRoot } from '@hana-id/env';
import { afterEach, describe, expect, it } from 'vitest';

const SCRIPT = join(repoRoot, 'scripts', 'ci-changes.mjs');

function classify(...files: string[]): { rust: boolean; web: boolean } {
  const res = spawnSync(process.execPath, [SCRIPT, '--classify', ...files], { encoding: 'utf8' });
  expect(res.status, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as { rust: boolean; web: boolean };
}

describe('path rules', () => {
  it('docs only: neither the Rust jobs nor the web jobs', () => {
    expect(classify('docs/operations.md', 'docs/decisions.md', 'README.md', 'apps/e2e/README.md')).toEqual({ rust: false, web: false });
  });

  it('a package README ships in the tarball, so it runs the pack check', () => {
    expect(classify('packages/web/README.md')).toEqual({ rust: false, web: true });
  });

  it('contracts only: the Rust jobs, not the web jobs (any file under contracts/, markdown included)', () => {
    expect(classify('contracts/hana-signer/src/lib.rs')).toEqual({ rust: true, web: false });
    expect(classify('contracts/hana-signer/rust-toolchain.toml')).toEqual({ rust: true, web: false });
    expect(classify('contracts/integration-tests/README.md')).toEqual({ rust: true, web: false });
  });

  it('app or package code: the web jobs, not the Rust jobs', () => {
    expect(classify('apps/api/src/login.ts')).toEqual({ rust: false, web: true });
    expect(classify('packages/core/src/index.ts')).toEqual({ rust: false, web: true });
    expect(classify('pnpm-lock.yaml')).toEqual({ rust: false, web: true });
  });

  it('the files the Rust tests read outside contracts/: both', () => {
    for (const f of ['scripts/lib/contract.ts', 'apps/api/src/gas.ts', 'apps/api/src/relayer-config.ts']) {
      expect(classify(f), f).toEqual({ rust: true, web: true });
    }
  });

  it('the CI definition itself: everything', () => {
    expect(classify('.github/workflows/ci.yml')).toEqual({ rust: true, web: true });
    expect(classify('scripts/ci-changes.mjs')).toEqual({ rust: true, web: true });
  });

  it('no files: nothing', () => {
    expect(classify()).toEqual({ rust: false, web: false });
  });
});

describe('base commit', () => {
  let dir = '';
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  const git = (...args: string[]) => {
    const res = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8' });
    expect(res.status, res.stderr).toBe(0);
    return res.stdout.trim();
  };
  const commit = (file: string) => {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), `${Math.random()}\n`);
    git('add', '-A');
    git('commit', '-q', '-m', file);
    return git('rev-parse', 'HEAD');
  };
  function run(env: Record<string, string>) {
    const out = join(dir, '.out');
    writeFileSync(out, '');
    const res = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: out, ...env } });
    expect(res.status, res.stderr).toBe(0);
    const outputs = Object.fromEntries(readFileSync(out, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]));
    return { outputs, log: res.stdout };
  }
  function repo() {
    dir = mkdtempSync(join(tmpdir(), 'hana-ci-changes-'));
    git('init', '-q', '-b', 'develop');
    return commit('docs/a.md');
  }
  const push = { CI_EVENT: 'push', CI_REF: 'refs/heads/develop' };

  it('a develop push measures from the last good run: a docs change after a contract change still runs Rust', () => {
    const good = repo();
    commit('contracts/hana-signer/src/lib.rs'); // its run was cancelled by the next push
    commit('docs/b.md');
    expect(run({ ...push, CI_BASE: good }).outputs).toEqual({ rust: 'true', web: 'false', playwright_args: '--project chromium' });
  });

  it('a develop push of docs only, measured from the last good run, skips both', () => {
    const good = repo();
    commit('docs/b.md');
    expect(run({ ...push, CI_BASE: good }).outputs).toEqual({ rust: 'false', web: 'false', playwright_args: '--project chromium' });
  });

  it('runs everything with no base, a malformed one, an unknown one, or one that is not an ancestor', () => {
    repo();
    const side = commit('apps/x.ts');
    git('reset', '-q', '--hard', 'HEAD~1');
    commit('docs/c.md');
    for (const base of ['', 'HEAD~1', 'f'.repeat(40), side]) {
      const { outputs, log } = run({ ...push, CI_BASE: base });
      expect(outputs, base).toEqual({ rust: 'true', web: 'true', playwright_args: '--project chromium' });
      expect(log).toMatch(/everything runs/u);
    }
  });

  it('main and a manual run: everything, all three browsers', () => {
    const good = repo();
    commit('docs/b.md');
    expect(run({ CI_EVENT: 'push', CI_REF: 'refs/heads/main', CI_BASE: good }).outputs).toEqual({ rust: 'true', web: 'true', playwright_args: '' });
    expect(run({ CI_EVENT: 'workflow_dispatch', CI_REF: 'refs/heads/develop', CI_BASE: good }).outputs).toEqual({ rust: 'true', web: 'true', playwright_args: '' });
  });

  it('a PR is measured from where it branched, not from its base branch’s newer commits', () => {
    repo();
    const fork = git('rev-parse', 'HEAD');
    git('checkout', '-q', '-b', 'feature');
    commit('docs/feature.md');
    git('checkout', '-q', 'develop');
    const baseHead = commit('contracts/x.rs'); // on develop after the fork, not part of the PR
    git('checkout', '-q', 'feature');
    expect(run({ CI_EVENT: 'pull_request', CI_REF: 'refs/pull/1/merge', CI_BASE: baseHead }).outputs).toEqual({ rust: 'false', web: 'false', playwright_args: '--project chromium' });
    expect(fork).toMatch(/^[0-9a-f]{40}$/u);
  });

  it('nightly: WebKit and Firefox when web code changed since the last good nightly run, never the Rust jobs', () => {
    const good = repo();
    commit('contracts/x.rs');
    const n = { CI_EVENT: 'schedule', CI_REF: 'refs/heads/develop' };
    expect(run({ ...n, CI_BASE: good }).outputs).toEqual({ rust: 'false', web: 'false', playwright_args: '--project webkit --project firefox' });
    commit('apps/api/src/login.ts');
    expect(run({ ...n, CI_BASE: good }).outputs).toEqual({ rust: 'false', web: 'true', playwright_args: '--project webkit --project firefox' });
    expect(run({ ...n, CI_BASE: '' }).outputs).toEqual({ rust: 'false', web: 'true', playwright_args: '--project webkit --project firefox' });
  });
});

describe('the Rust tests’ inputs outside contracts/', () => {
  function rustFiles(d: string): string[] {
    return readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      if (n === 'target' || n === 'node_modules') return [];
      return statSync(p).isDirectory() ? rustFiles(p) : n.endsWith('.rs') ? [p] : [];
    });
  }
  const sources = rustFiles(join(repoRoot, 'contracts')).map((p) => ({ p, text: readFileSync(p, 'utf8') }));

  it('every repo-root path the Rust tests read is a Rust input of the classifier', () => {
    const found = new Set<string>();
    for (const { text } of sources) {
      for (const m of text.matchAll(/expect\("repo root"\)((?:\s*\.join\("[^"]+"\))+)/gu)) {
        found.add([...(m[1] ?? '').matchAll(/\.join\("([^"]+)"\)/gu)].map((j) => j[1]).join('/'));
      }
    }
    expect([...found].sort()).toEqual(['apps/api/src/gas.ts', 'apps/api/src/relayer-config.ts', 'scripts/lib/contract.ts']);
    for (const f of found) expect(classify(f).rust, f).toBe(true);
  });

  it('no Rust source reads outside the repo root by another route (relative paths stay inside contracts/)', () => {
    const contracts = join(repoRoot, 'contracts');
    for (const { p, text } of sources) {
      for (const m of text.matchAll(/include_(?:str|bytes)!\("([^"]+)"\)/gu)) {
        const target = resolve(dirname(p), m[1] ?? '');
        expect(relative(contracts, target).startsWith('..'), `${relative(repoRoot, p)}: ${m[1]}`).toBe(false);
      }
      for (const m of text.matchAll(/CARGO_MANIFEST_DIR"\)\)\.join\("([^"]+)"\)/gu)) {
        const crate = join(contracts, relative(contracts, p).split('/')[0] ?? '');
        expect(relative(contracts, resolve(crate, m[1] ?? '')).startsWith('..'), `${relative(repoRoot, p)}: ${m[1]}`).toBe(false);
      }
    }
  });
});

describe('.github/workflows/ci.yml', () => {
  const yml = readFileSync(join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');
  const job = (id: string) => {
    const start = yml.indexOf(`\n  ${id}:\n`);
    expect(start, id).toBeGreaterThan(0);
    const next = yml.slice(start + 1).search(/\n {2}[a-z0-9-]+:\n/u);
    return next < 0 ? yml.slice(start) : yml.slice(start, start + 1 + next);
  };

  it('gates the Rust jobs on `rust` and the web jobs on `web`', () => {
    for (const id of ['contract', 'e2e']) expect(job(id), id).toContain("needs.changes.outputs.rust == 'true'");
    for (const id of ['playwright', 'packages']) expect(job(id), id).toContain("needs.changes.outputs.web == 'true'");
  });

  it('runs gitleaks and the TypeScript job on every push and PR, not on the nightly run', () => {
    for (const id of ['secrets', 'typescript']) {
      expect(job(id), id).not.toContain('needs.changes');
      expect(job(id), id).toContain("github.event_name != 'schedule'");
    }
  });

  it('passes the Playwright projects through and runs the changes script', () => {
    expect(job('playwright')).toContain('needs.changes.outputs.playwright_args');
    expect(job('changes')).toContain('node scripts/ci-changes.mjs');
  });
});
