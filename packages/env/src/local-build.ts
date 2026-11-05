// The build id of this checkout (./build-id.ts, D384), read from git, and the stamped `wrangler deploy` that each
// Worker's `deploy` script runs (apps/api, apps/email-issuer `scripts/deploy.ts`). Node only.
import { execFileSync, spawnSync } from 'node:child_process';
import { BUILD_VAR, type BuildId, formatBuildId, parseBuildId } from './build-id.ts';
import { repoRoot } from './index.ts';

/** Runs git with these arguments in the repository; returns stdout. */
export type Git = (args: readonly string[]) => string;

const runGit: Git = (args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

export interface LocalBuild extends BuildId {
  /** The full hash of HEAD. */
  head: string;
}

/**
 * HEAD's build id: `-dirty` when `git status` lists any change, tracked or untracked (an untracked source file is built
 * too); ignored files (dist/, generated configs, .secrets/) don't count. Throws outside a git checkout: an unstamped
 * build would pass for none.
 */
export function localBuild(git: Git = runGit): LocalBuild {
  let head: string;
  let status: string;
  try {
    head = git(['rev-parse', '--verify', 'HEAD']).trim();
    status = git(['status', '--porcelain=v1', '--untracked-files=normal']);
  } catch {
    throw new Error('Could not read the build id from git (git rev-parse HEAD, git status): build and deploy from a git checkout');
  }
  if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/u.test(head)) throw new Error('git rev-parse HEAD did not print a commit hash');
  const id = formatBuildId(head, status.trim() !== '');
  return { ...parseBuildId(id)!, head };
}

/** `wrangler deploy` argv with the build id as the HANA_BUILD var; refuses an argv that sets HANA_BUILD itself. */
export function stampedDeployArgv(id: string, argv: readonly string[]): string[] {
  if (argv.some((a) => a.includes(BUILD_VAR))) throw new Error(`${BUILD_VAR} is set by this script from git; don't pass it`);
  if (!parseBuildId(id)) throw new Error('Not a build id');
  return ['deploy', ...argv, '--var', `${BUILD_VAR}:${id}`];
}

export interface StampedDeployDeps {
  build?: () => LocalBuild;
  /** Runs wrangler with this argv in the current directory, output to the terminal; returns its exit status. */
  wrangler?: (argv: string[]) => number;
  log?: (line: string) => void;
}

const runWrangler = (argv: string[]): number => {
  const res = spawnSync('wrangler', argv, { stdio: 'inherit' });
  if (res.error) throw res.error;
  return res.status ?? 1;
};

/**
 * `wrangler deploy <argv…> --var HANA_BUILD:<id>` from the current directory. Returns wrangler's exit status. A dirty
 * tree still deploys (sandbox work does), stamped `-dirty`, which `deploy-check` reports.
 */
export function stampedDeploy(argv: readonly string[], deps: StampedDeployDeps = {}): number {
  const build = (deps.build ?? localBuild)();
  const log = deps.log ?? ((line: string) => console.log(line));
  const wranglerArgv = stampedDeployArgv(build.id, argv);
  log(`Build ${build.id} (HEAD ${build.head})${build.dirty ? ': the tree has uncommitted changes, so this deploy is stamped -dirty' : ''}`);
  return (deps.wrangler ?? runWrangler)(wranglerArgv);
}
