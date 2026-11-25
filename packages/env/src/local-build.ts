// The build id of this checkout (./build-id.ts, D384), read from git, and the stamped `wrangler deploy` that each
// Worker's `deploy` script runs through the one shared wrapper, ./stamped-deploy.ts (D406). Node only.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { BUILD_VAR, type BuildId, formatBuildId, parseBuildId } from './build-id.ts';
import { requireMigrations } from './require-migrations.ts';
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

/**
 * The wrapper's arguments (D931, after PR 159's second review): an allowlist, so nothing on the command line can change
 * which config wrangler deploys or the vars it carries. At most one `-c`/`--config <file>` (or `--config=<file>`),
 * `--require-migrations <D1 binding>:<NNNN_name.sql>` (an app's deploy script names it), and `--dry-run`. Anything else
 * (`--var`, `--define`, `--env`, `--cwd`, `--secrets-file`, `--script`, a positional entry, a second `-c`, …) is
 * refused, since wrangler would act on it after the check.
 */
export interface DeployArgs {
  config: string | undefined;
  migrations: { binding: string; required: string } | undefined;
  dryRun: boolean;
}

export function parseDeployArgs(argv: readonly string[]): DeployArgs | string {
  const out: DeployArgs = { config: undefined, migrations: undefined, dryRun: false };
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k]!;
    let value: string | undefined;
    if (a === '-c' || a === '--config') value = argv[++k];
    else if (a.startsWith('--config=')) value = a.slice('--config='.length);
    else if (a === '--require-migrations') {
      const m = /^([A-Z][A-Z0-9_]{0,63}):(\d{4}_[A-Za-z0-9_-]+\.sql)$/u.exec(argv[++k] ?? '');
      if (!m || out.migrations) return 'refused: --require-migrations takes one <D1 binding>:<NNNN_name.sql>, once';
      out.migrations = { binding: m[1]!, required: m[2]! };
      continue;
    } else if (a === '--dry-run') {
      out.dryRun = true;
      continue;
    } else {
      return `refused: ${a.split('=')[0]} isn't taken here: the wrapper deploys exactly the env's generated config, with its own vars (only -c <file> and --dry-run)`;
    }
    if (value === undefined || value === '' || value.startsWith('-')) return 'refused: -c/--config needs a file';
    if (out.config !== undefined) return 'refused: one -c/--config only';
    out.config = value;
  }
  return out;
}

/**
 * The one config this deploy uses, as an absolute path, or why there is none. With `-c`, that file (relative to `cwd`);
 * without, the first of wrangler's names in `cwd`, in wrangler's own order (`wrangler.json`, `wrangler.jsonc`,
 * `wrangler.toml`). It doesn't walk up to a parent directory or follow `.wrangler/deploy/config.json` as wrangler would:
 * the deploy then passes exactly this file to wrangler (`-c <absolute path>`), which does neither with `-c`.
 */
export function resolveDeployConfig(config: string | undefined, cwd: string, exists: (path: string) => boolean = existsSync): string | null {
  if (config !== undefined) return isAbsolute(config) ? config : join(cwd, config);
  const found = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'].map((f) => join(cwd, f)).find((f) => exists(f));
  return found ?? null;
}

/** Keys JSON.parse reads as ordinary keys but a JavaScript object parser (wrangler's) may treat as the prototype. */
const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * A generated config, parsed (JSON with `//` comment lines), or why it isn't one we deploy: not JSON (TOML, missing,
 * unreadable), or with a `__proto__`, `constructor` or `prototype` key at any depth (after PR 159's third review:
 * `JSON.parse` keeps `"__proto__": {"vars": …}` as a plain key, wrangler's parser makes it the object's prototype, so
 * the guard and wrangler would read different vars).
 */
export function readDeployConfig(path: string, read: (path: string) => string = (p) => readFileSync(p, 'utf8')): Record<string, unknown> | string {
  const unreadable = `refused: can't read ${path} to check which env it deploys (only the generated JSON configs are deployed)`;
  if (!/\.jsonc?$/u.test(path)) return unreadable;
  let text: string;
  try {
    text = read(path)
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('//'))
      .join('\n');
  } catch {
    return unreadable;
  }
  let unsafe: string | null = null;
  let c: unknown;
  try {
    c = JSON.parse(text, (key, value: unknown) => {
      if (UNSAFE_KEYS.has(key)) unsafe ??= key;
      return value;
    });
  } catch {
    return unreadable;
  }
  if (unsafe !== null) return `refused: ${path} has a "${unsafe}" key, which wrangler may read differently from this check`;
  return c !== null && typeof c === 'object' && !Array.isArray(c) ? (c as Record<string, unknown>) : unreadable;
}

/**
 * D931 (the `local*` guard, docs/partner-platform-spec.md A15): why this config may not be deployed, or null. A `local*`
 * env runs on wrangler dev only (its 24 h platform minimum is waived): a config whose `vars.ENV_NAME` is `local…` is
 * refused. A Worker whose config names no env (console-auth, files) is not refused: the platform's exceptions are the
 * API's, whose config always names its env.
 */
export function localConfigProblem(config: Record<string, unknown>, file: string): string | null {
  // After PR 159's third review: an `env` section's vars replace the top-level ones when wrangler is given that env
  // (`--env`, or CLOUDFLARE_ENV), so a config with one isn't checked as wrangler would read it. Generated configs have none.
  if (Object.hasOwn(config, 'env')) return `refused: ${file} has an "env" section (each env has its own generated config, with none)`;
  const name = (config.vars as Record<string, unknown> | undefined)?.ENV_NAME;
  if (typeof name === 'string' && /^local/u.test(name)) return `refused: ${file} is for ${name}, a local* env: local* envs run on wrangler dev, never deployed`;
  return null;
}

/**
 * Environment variables that change what wrangler deploys from a config: `CLOUDFLARE_ENV` picks one of its `env`
 * sections (with no such section, wrangler warns and deploys under that env name), `WRANGLER_CI_OVERRIDE_NAME` the
 * Worker's name. The wrapper refuses them in its own environment and in a `.env` file wrangler would load, and runs
 * wrangler with them removed (after PR 159's third review).
 */
export const WRANGLER_ENV_REFUSED = ['CLOUDFLARE_ENV', 'WRANGLER_CI_OVERRIDE_NAME'] as const;

/** The process environment for wrangler: this one without WRANGLER_ENV_REFUSED. */
export function wranglerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const k of WRANGLER_ENV_REFUSED) delete out[k];
  return out;
}

/**
 * Why the environment wrangler would run with is refused, or null: one of WRANGLER_ENV_REFUSED set in this process, or
 * set by a `.env`/`.env.*` file in `dirs` (wrangler loads `.env` and `.env.local` from the directory it runs in, and
 * `.env.<env>` with an env; every `.env*` there and in the config's directory is read, to be safe).
 */
export function wranglerEnvProblem(env: NodeJS.ProcessEnv, dirs: readonly string[], listDir: (dir: string) => string[], read: (path: string) => string): string | null {
  const set = WRANGLER_ENV_REFUSED.find((k) => env[k] !== undefined);
  if (set) return `refused: ${set} is set: it changes what wrangler deploys from the config; unset it`;
  const assigns = new RegExp(`^\\s*(?:export\\s+)?(${WRANGLER_ENV_REFUSED.join('|')})\\s*[=:]`, 'mu');
  for (const dir of new Set(dirs)) {
    let names: string[];
    try {
      names = listDir(dir);
    } catch {
      continue;
    }
    for (const name of names.filter((n) => /^\.env(?:\..+)?$/u.test(n)).sort()) {
      let text: string;
      try {
        text = read(join(dir, name));
      } catch {
        return `refused: can't read ${join(dir, name)} to check what wrangler would load from it`;
      }
      const m = assigns.exec(text);
      if (m) return `refused: ${join(dir, name)} sets ${m[1]}, which changes what wrangler deploys from the config; remove it`;
    }
  }
  return null;
}

/** `wrangler deploy -c <absolute config> [--dry-run] --var HANA_BUILD:<id>`. */
export function stampedDeployArgv(id: string, configPath: string, dryRun = false): string[] {
  if (!parseBuildId(id)) throw new Error('Not a build id');
  if (!isAbsolute(configPath)) throw new Error('The config path must be absolute');
  return ['deploy', '-c', configPath, ...(dryRun ? ['--dry-run'] : []), '--var', `${BUILD_VAR}:${id}`];
}

export interface StampedDeployDeps {
  build?: () => LocalBuild;
  /** Reads the wrangler config the deploy uses; the default reads the file. */
  readConfig?: (path: string) => string;
  /** Whether a file exists (the config's discovery); the default asks the file system. */
  exists?: (path: string) => boolean;
  /** The directory the deploy runs from (the default: the current directory). */
  cwd?: string;
  /** Runs wrangler with this argv and environment, output to the terminal; returns its exit status. */
  wrangler?: (argv: string[], env: NodeJS.ProcessEnv) => number;
  /** This process's environment (the default: process.env). */
  env?: NodeJS.ProcessEnv;
  /** The names in a directory (the `.env` files' check); the default reads the directory. */
  listDir?: (dir: string) => string[];
  /** The migration check (./require-migrations.ts), on the same resolved config. */
  requireMigrations?: (i: { configPath: string; config: Record<string, unknown>; binding: string; required: string; env: NodeJS.ProcessEnv }) => string | null;
  log?: (line: string) => void;
}

const runWrangler = (argv: string[], env: NodeJS.ProcessEnv): number => {
  const res = spawnSync('wrangler', argv, { stdio: 'inherit', env });
  if (res.error) throw res.error;
  return res.status ?? 1;
};

/**
 * The shared deploy (D406, D931): resolves ONE config, refuses a `local*` one and anything it can't read, runs the
 * app's migration check against that same config when its deploy script asks (`--require-migrations`), then
 * `wrangler deploy -c <that file, absolute> --var HANA_BUILD:<id>`. Returns wrangler's exit status (1 for a refusal). A
 * dirty tree still deploys (sandbox work does), stamped `-dirty`, which `deploy-check` reports.
 */
export function stampedDeploy(argv: readonly string[], deps: StampedDeployDeps = {}): number {
  const log = deps.log ?? ((line: string) => console.log(line));
  const refuse = (why: string): number => {
    log(`Deploy ${why}`);
    return 1;
  };
  if (argv.some((a) => a.includes(BUILD_VAR))) throw new Error(`${BUILD_VAR} is set by this script from git; don't pass it`);
  const args = parseDeployArgs(argv);
  if (typeof args === 'string') return refuse(args);
  const cwd = deps.cwd ?? process.cwd();
  const path = resolveDeployConfig(args.config, cwd, deps.exists);
  if (path === null) return refuse("refused: no wrangler config here (generate it with the app's gen script first)");
  const config = readDeployConfig(path, deps.readConfig);
  if (typeof config === 'string') return refuse(config);
  const local = localConfigProblem(config, path);
  if (local) return refuse(local);
  const read = deps.readConfig ?? ((p: string) => readFileSync(p, 'utf8'));
  const env = deps.env ?? process.env;
  const envProblem = wranglerEnvProblem(env, [cwd, dirname(path)], deps.listDir ?? ((d) => readdirSync(d)), read);
  if (envProblem) return refuse(envProblem);
  const clean = wranglerEnv(env);
  if (args.migrations) {
    const why = (deps.requireMigrations ?? defaultRequireMigrations)({ configPath: path, config, ...args.migrations, env: clean });
    if (why) return refuse(why);
  }
  const build = (deps.build ?? localBuild)();
  log(`Build ${build.id} (HEAD ${build.head})${build.dirty ? ': the tree has uncommitted changes, so this deploy is stamped -dirty' : ''}`);
  return (deps.wrangler ?? runWrangler)(stampedDeployArgv(build.id, path, args.dryRun), clean);
}

const defaultRequireMigrations = (i: { configPath: string; config: Record<string, unknown>; binding: string; required: string; env: NodeJS.ProcessEnv }): string | null => requireMigrations(i);
