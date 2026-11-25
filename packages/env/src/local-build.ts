// The build id of this checkout (./build-id.ts, D384), read from git, and the stamped `wrangler deploy` that each
// Worker's `deploy` script runs through the one shared wrapper, ./stamped-deploy.ts (D406). Node only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
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

/**
 * D931 (the `local*` guard, docs/partner-platform-spec.md A15): why this deploy is refused, or null. A `local*` env runs
 * on wrangler dev only (its 24 h platform minimum is waived), so the wrapper reads the wrangler config the deploy uses
 * (`-c`/`--config <file>`, else `wrangler.jsonc` in the current directory) and refuses one whose `vars.ENV_NAME` is
 * `local…`, and one it can't read (wrangler couldn't deploy it either). A Worker whose config names no env (console-auth,
 * files) is not refused: the platform's exceptions are the API's, whose config always names its env.
 */
export function localDeployProblem(argv: readonly string[], cwd: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8'), exists: (path: string) => boolean = existsSync): string | null {
  // After PR 159's review: no command-line value of the vars the `local*` exception and the platform's rules read
  // (`--var ENV_NAME:…`, `--var=API_URL:…`, `--define NETWORK:…`, a repeated flag's later values), in any spelling.
  const guarded = /^(?:--(?:var|define)=)?(?:ENV_NAME|NETWORK|API_URL)\s*[:=]/iu;
  const hit = argv.find((a) => guarded.test(a));
  if (hit !== undefined) return `refused: ${hit.split(/[:=]/u)[0]!.replace(/^--(?:var|define)=?/iu, '')} is set by the env's generated config, never on the command line`;
  if (argv.some((a) => a === '--env' || a.startsWith('--env=') || a === '-e')) return 'refused: --env is not used here (each env has its own generated config)';
  let file: string | undefined;
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    if ((a === '-c' || a === '--config') && argv[k + 1] !== undefined) file = argv[k + 1]!;
    else if (a.startsWith('--config=')) file = a.slice('--config='.length);
    else if (a.startsWith('-c=')) file = a.slice(3);
  }
  // Without -c, wrangler takes the first of its config names that exists: the same here; none is a refusal.
  if (file === undefined) file = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((f) => exists(isAbsolute(f) ? f : join(cwd, f))) ?? 'wrangler.jsonc';
  const path = isAbsolute(file) ? file : join(cwd, file);
  let config: { vars?: Record<string, unknown> };
  try {
    if (!/\.jsonc?$/u.test(file)) throw new Error('not JSON');
    // The generated configs are JSON with `//` comment lines (their header); nothing else is JSONC in them.
    const text = read(path)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
    config = JSON.parse(text) as { vars?: Record<string, unknown> };
  } catch {
    return `refused: can't read ${file} to check which env it deploys (only the generated JSON configs are deployed; generate it with the app's gen script first)`;
  }
  const name = config?.vars?.ENV_NAME;
  if (typeof name === 'string' && /^local/u.test(name)) return `refused: ${file} is for ${name}, a local* env: local* envs run on wrangler dev, never deployed`;
  return null;
}

export interface StampedDeployDeps {
  build?: () => LocalBuild;
  /** Reads the wrangler config the deploy uses (the `local*` guard); the default reads the file. */
  readConfig?: (path: string) => string;
  /** The directory wrangler runs in (the default: the current directory). */
  cwd?: string;
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
  const log = deps.log ?? ((line: string) => console.log(line));
  const problem = localDeployProblem(argv, deps.cwd ?? process.cwd(), deps.readConfig);
  if (problem) {
    log(`Deploy ${problem}`);
    return 1;
  }
  const build = (deps.build ?? localBuild)();
  const wranglerArgv = stampedDeployArgv(build.id, argv);
  log(`Build ${build.id} (HEAD ${build.head})${build.dirty ? ': the tree has uncommitted changes, so this deploy is stamped -dirty' : ''}`);
  return (deps.wrangler ?? runWrangler)(wranglerArgv);
}
