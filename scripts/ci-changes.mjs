#!/usr/bin/env node
// Which CI jobs a change needs (D383; docs/operations.md "CI and git"). The `changes` job in .github/workflows/ci.yml
// runs it and the other jobs read its outputs:
//
//   rust             the Rust jobs (contract: cargo test + wasm; sandbox e2e) run
//   web              the Playwright suite and the SDK pack check run
//   playwright_args  the Playwright projects for this event ('' = all three browsers)
//
// gitleaks and the TypeScript job are not gated: they run on every push and PR (the TypeScript tests read docs/ and
// contracts/, so no path is safe to skip there).
//
//   node scripts/ci-changes.mjs                 (CI: reads CI_EVENT, CI_REF, CI_BASE; writes $GITHUB_OUTPUT)
//   node scripts/ci-changes.mjs --classify <file>...   (prints the classification of a file list as JSON)
//
// CI_BASE is the commit the change is measured from: for a push, the head of the last successful push run of CI on
// that branch (so a cancelled or failed run's changes are counted again by the next push); for a PR, its base; for
// the nightly run, the head of the last successful nightly run. With no base, or one that is not an ancestor of HEAD
// (a force push, say), everything runs. No dependencies beyond Node's standard library: the job runs it before any
// install.
import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Files outside contracts/ that the Rust tests read (contracts/integration-tests/tests/common/mod.rs). */
export const RUST_EXTERNAL_INPUTS = ['scripts/lib/contract.ts', 'apps/api/src/gas.ts', 'apps/api/src/relayer-config.ts'];

/** A change to these runs every job: they decide what CI runs. */
export const CI_FILES = ['.github/workflows/ci.yml', 'scripts/ci-changes.mjs'];

/** Docs that no Rust job, Playwright test or package tarball reads. Package READMEs ship in the tarballs. */
export function isDocOnly(file) {
  if (file.startsWith('docs/')) return true;
  return file.endsWith('.md') && !file.startsWith('packages/');
}

/** @param {string[]} files changed paths, relative to the repo root */
export function classify(files) {
  const ci = files.some((f) => CI_FILES.includes(f));
  const rust = ci || files.some((f) => f.startsWith('contracts/') || RUST_EXTERNAL_INPUTS.includes(f));
  const web = ci || files.some((f) => !isDocOnly(f) && !f.startsWith('contracts/'));
  return { rust, web };
}

/** The Playwright projects per event: Chromium on PRs and develop pushes, WebKit and Firefox nightly, all on main. */
export function playwrightArgs(event, ref) {
  if (event === 'schedule') return '--project webkit --project firefox';
  if (event === 'workflow_dispatch' || ref === 'refs/heads/main') return '';
  return '--project chromium';
}

function git(args) {
  return spawnSync('git', args, { encoding: 'utf8' });
}

/** The decision for one CI run. `files` is null when everything must run. */
export function decide({ event, ref, base }) {
  const all = { rust: event !== 'schedule', web: true };
  if (event === 'workflow_dispatch' || ref === 'refs/heads/main') return { ...all, reason: `${event} on ${ref}: everything runs`, files: null };
  if (!/^[0-9a-f]{40}$/u.test(base ?? '')) return { ...all, reason: 'no base commit (first run of its kind): everything runs', files: null };
  if (git(['cat-file', '-e', `${base}^{commit}`]).status !== 0) return { ...all, reason: `base ${base} is not in this clone: everything runs`, files: null };
  if (git(['merge-base', '--is-ancestor', base, 'HEAD']).status !== 0) {
    if (event !== 'pull_request') return { ...all, reason: `base ${base} is not an ancestor of HEAD: everything runs`, files: null };
  }
  // A PR is measured from where it branched (its base branch may have moved on).
  const from = event === 'pull_request' ? git(['merge-base', base, 'HEAD']).stdout.trim() : base;
  const diff = git(['diff', '--name-only', '--no-renames', from, 'HEAD']);
  if (diff.status !== 0 || !from) return { ...all, reason: `git diff from ${base} failed: everything runs`, files: null };
  const files = diff.stdout.split('\n').filter(Boolean);
  const c = classify(files);
  // The nightly run only adds the browsers the pushes skipped; the Rust jobs already ran on each push.
  return { rust: event === 'schedule' ? false : c.rust, web: c.web, reason: `${files.length} file(s) changed since ${base}`, files };
}

function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === '--classify') {
    process.stdout.write(`${JSON.stringify(classify(argv.slice(1)))}\n`);
    return;
  }
  const event = process.env.CI_EVENT ?? '';
  const ref = process.env.CI_REF ?? '';
  const d = decide({ event, ref, base: process.env.CI_BASE });
  const outputs = { rust: String(d.rust), web: String(d.web), playwright_args: playwrightArgs(event, ref) };
  console.log(d.reason);
  for (const f of d.files ?? []) console.log(`  ${f}`);
  for (const [k, v] of Object.entries(outputs)) console.log(`${k}=${v}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(outputs).map(([k, v]) => `${k}=${v}\n`).join(''));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
