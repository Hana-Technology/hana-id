#!/usr/bin/env node
// The optional pre-push gate (D413; docs/operations.md "CI and git"): a push to develop or main first runs
// `pnpm verify --quick`, and a failure stops the push. Feature branches and tags push as before.
//
//   pnpm verify:install-hook              turn it on for this clone (every worktree shares it)
//   pnpm verify:install-hook --uninstall  turn it off
//   pnpm verify:install-hook --status     say whether it is on
//
// The hook itself is .githooks/pre-push, beside the gitleaks pre-commit hook: `pnpm install` points git at
// .githooks (package.json "prepare"), and the pre-push hook acts only when `git config hana.verifyPrePush` is true,
// which `install` sets. It checks the working tree it runs in, so the pushed commit must be the checked-out HEAD
// with nothing uncommitted; otherwise it stops the push and says why. It has no skip switch of its own.
//
//   node scripts/verify-hook.mjs pre-push <remote> <url>   (git runs it, the ref updates on stdin)
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The branches whose pushes are gated. */
export const PROTECTED = { 'refs/heads/develop': 'develop', 'refs/heads/main': 'main' };
export const CONFIG_KEY = 'hana.verifyPrePush';

const ZERO = /^0+$/u;

/** Parses git's pre-push stdin: `<local ref> <local sha> <remote ref> <remote sha>` per line. */
export function parseUpdates(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [localRef, localSha, remoteRef, remoteSha] = l.split(/\s+/u);
      return { localRef, localSha, remoteRef, remoteSha };
    });
}

/**
 * What the hook does for a push.
 *
 * @param {{ localRef: string, localSha: string, remoteRef: string, remoteSha: string }[]} updates
 * @param {{ head: string, dirty: boolean, hasCommit: (sha: string) => boolean }} repo
 * @returns {{ action: 'skip' | 'refuse' | 'run', message: string, args?: string[] }}
 */
export function decide(updates, repo) {
  const gated = updates.filter((u) => u.remoteRef in PROTECTED && !ZERO.test(u.localSha));
  if (gated.length === 0) return { action: 'skip', message: 'no push to develop or main' };
  const names = [...new Set(gated.map((u) => PROTECTED[u.remoteRef]))].join(' and ');
  const shas = [...new Set(gated.map((u) => u.localSha))];
  if (shas.length > 1) return { action: 'refuse', message: `this push sends different commits to ${names}: push them one at a time, each from a checkout of that commit` };
  const [sha] = shas;
  if (sha !== repo.head) {
    return { action: 'refuse', message: `the commit pushed to ${names} (${sha.slice(0, 9)}) is not the checked-out HEAD (${repo.head.slice(0, 9)}). The check runs on the working tree: check out the commit you push, then push again` };
  }
  if (repo.dirty) return { action: 'refuse', message: `the working tree has uncommitted or untracked changes, which the check would include: commit them or move them aside, then push to ${names} again` };
  // main: CI ran everything there; develop: the change since the remote's tip, or everything with none to compare.
  const toMain = gated.some((u) => u.remoteRef === 'refs/heads/main');
  const base = gated[0].remoteSha;
  const args = toMain || !base || ZERO.test(base) || !repo.hasCommit(base) ? ['--quick', '--all'] : ['--quick', '--base', base];
  return { action: 'run', message: `pushing to ${names}: pnpm verify ${args.join(' ')}`, args };
}

function git(args) {
  return spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
}

function repoState() {
  return {
    head: git(['rev-parse', 'HEAD']).stdout.trim(),
    dirty: git(['status', '--porcelain']).stdout.trim() !== '',
    hasCommit: (sha) => /^[0-9a-f]{40}$/u.test(sha) && git(['cat-file', '-e', `${sha}^{commit}`]).status === 0,
  };
}

function prePush(stdin) {
  const d = decide(parseUpdates(stdin), repoState());
  if (d.action === 'skip') return 0;
  if (d.action === 'refuse') {
    console.error(`pre-push (D413): push stopped: ${d.message}.`);
    return 1;
  }
  console.error(`pre-push (D413): ${d.message}`);
  // stdin is git's ref list, already read: the checks get none.
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'verify.mjs'), ...d.args], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  if (r.status === 0) {
    console.error('pre-push (D413): verify passed; pushing.');
    return 0;
  }
  console.error('pre-push (D413): verify failed, so the push was stopped. Fix what failed (the table above names the step and its log) and push again.');
  return 1;
}

function install(argv) {
  if (argv.includes('--status')) {
    const on = git(['config', '--bool', CONFIG_KEY]).stdout.trim() === 'true';
    const hooks = git(['config', 'core.hooksPath']).stdout.trim();
    console.log(`pre-push verify: ${on ? 'on' : 'off'} (${CONFIG_KEY}); core.hooksPath: ${hooks || '(unset: run pnpm install)'}`);
    return 0;
  }
  if (argv.includes('--uninstall')) {
    git(['config', '--unset', CONFIG_KEY]);
    console.log('pre-push verify: off. Pushes to develop and main no longer run pnpm verify --quick first.');
    return 0;
  }
  // The same hooks dir the pre-commit hook uses (package.json "prepare").
  for (const args of [['config', 'core.hooksPath', '.githooks'], ['config', '--bool', CONFIG_KEY, 'true']]) {
    const r = git(args);
    if (r.status !== 0) {
      console.error(`verify:install-hook: git ${args.join(' ')} failed: ${r.stderr.trim()}`);
      return 1;
    }
  }
  console.log('pre-push verify: on for this clone and all its worktrees. A push to develop or main runs pnpm verify --quick first and stops on a failure; other branches push as before. Off: pnpm verify:install-hook --uninstall');
  return 0;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'pre-push') process.exit(prePush(readFileSync(0, 'utf8')));
  if (cmd === 'install') process.exit(install(rest));
  console.error('usage: verify-hook.mjs install [--uninstall | --status] | pre-push <remote> <url>');
  process.exit(2);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
