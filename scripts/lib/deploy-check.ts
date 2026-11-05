// deploy-check.ts's body (D384, D406): after a deploy, does every deployed piece of an env run the same code, this
// checkout's? On 2026-11-05 sandbox-dev's page Workers served a vault bundle from an older build than the API (every
// wallet record 400), and a D1 migration was applied from a checkout older than the code deployed; nothing showed
// either. Each piece carries a build id (@hana-id/env/build-id: the commit's first 12 hex characters, `-dirty` for a
// tree with uncommitted changes), stamped by the shared deploy wrapper and the page builds. Each piece belongs to a
// group (`--only` / `--skip` name groups), read only when the env's manifest has it:
//
//   api           api                 GET {apiUrl}/v1/health                              `build`
//   pages         vault worker        GET {vaultOrigin}/.well-known/hana-build            `build`
//                 vault bundle        GET {vaultOrigin}/vault.js                          first line `/* hana-build <id> */`
//                 auth worker         GET {authOrigin}/.well-known/hana-build             `build`
//                 auth pages          GET {authOrigin}/login                              `<meta name="hana-build">`
//   issuer        email issuer        GET {emailIssuer.url}/v1/email/health               `build`
//   console       console worker      GET {console.origin}/.well-known/hana-build         `build`
//                 console spa         GET {console.origin}/                               `<meta name="hana-build">`
//   console-auth  console-auth worker GET {console.authOrigin}/.well-known/hana-build     `build`
//   files         files worker        GET {files.origin}/.well-known/hana-build           `build`
//   admin         admin worker        wrangler: the deployed version's HANA_BUILD var     (behind Cloudflare Access)
//   watchdog      watchdog worker     wrangler, on watchdog.cloudflare.accountId          (only with --only watchdog)
//
// The admin's origin is behind Cloudflare Access, which this script can't (and mustn't) pass, and the watchdog serves
// nothing without its bearer token; neither gets a public route (D406). For both, wrangler reads the deployed version's
// metadata (read-only: `wrangler deployments status --json`, then `wrangler versions view <id> --json`), whose
// plain-text vars include HANA_BUILD; only that var is read, and nothing else wrangler prints is shown. The watchdog is
// on its own Cloudflare account with its own login (D86), so a default run (the API's login) doesn't read it: run
// `deploy-check <env> --only watchdog` logged in to that account.
//
// A piece that can't be read, isn't stamped (deployed without the scripts, or before D384/D406), names another commit
// than the others or than HEAD fails the run (exit 1). A piece deployed from a dirty tree is a warning (`--strict`:
// a failure); so is a dirty checkout here. `--d1` also asks wrangler which of this checkout's D1 migrations the
// env's databases lack (`wrangler d1 migrations list <db> --remote`: it reads `d1_migrations`, and creates that
// table only if missing, which it never is on a migrated database), for the D1 of each group checked that has one:
// the API's, the issuer's, the console's and the watchdog's.
//
// It holds no secret and prints only public values: URLs and Worker names from the manifest, HTTP statuses, build ids
// that parse, and the last lines of a failed wrangler run's own error output (nothing else from an answer is printed).
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, emailIssuerUrl, loadEnv, repoRoot } from '@hana-id/env';
import { BUILD_PATH, BUILD_VAR, type BuildId, ISSUER_HEALTH_PATH, parseBuildId, parseBuildMeta, parseVaultBanner } from '@hana-id/env/build-id';
import { type LocalBuild, localBuild } from '@hana-id/env/local-build';
import { CliError, parseCli } from './cli.ts';

export const DEPLOY_CHECK_USAGE = `Usage: deploy-check.ts <env> [--only <groups>] [--skip <groups>] [--d1] [--skip-head] [--strict]
  After a deploy: reads the build id of every deployed piece of envs/<env>.json and checks they all name one commit,
  this checkout's HEAD. Exits 1 when a piece can't be read, isn't stamped, or names another commit. Groups (each read
  only when the manifest has it): api, pages (the vault and auth Workers and bundles), issuer, console (Worker and
  SPA), console-auth, files, admin (through wrangler: the API's Cloudflare login), watchdog (through wrangler on its
  own account: read only when --only names it, logged in to that account).
  --only <g,…> read only these groups (comma-separated or repeated)
  --skip <g,…> read every group but these
  --d1         also list the D1 migrations of this checkout that the env's databases lack (the API's, the issuer's,
               the console's, the watchdog's, for the groups read), with \`wrangler d1 migrations list <db> --remote\`
               (read-only); any is a failure. Needs each app's wrangler.jsonc generated for <env>.
  --skip-head  compare the pieces with each other only, not with this checkout
  --strict     a piece deployed from a tree with uncommitted changes (…-dirty) fails instead of warning`;

export const CHECK_TIMEOUT_MS = 10_000;
/** The most read of a JSON or HTML answer; the vault bundle is read only as far as its first line. */
export const BODY_LIMIT = 16_384;
export const BANNER_LIMIT = 256;

/** What `--only` and `--skip` name, in the order the pieces are read and printed. */
export const GROUPS = ['api', 'pages', 'issuer', 'console', 'console-auth', 'files', 'admin', 'watchdog'] as const;
export type Group = (typeof GROUPS)[number];
/** Read only when `--only` names them: the watchdog's Cloudflare account has its own login (D86). */
export const OPT_IN_GROUPS: readonly Group[] = ['watchdog'];

export type TargetKind = 'json' | 'vault-js' | 'html-meta' | 'wrangler';

export interface WranglerSource {
  /** The Worker's name (manifest). */
  worker: string;
  /** The app whose installed wrangler runs (`apps/<app>`). */
  app: string;
  /** The Cloudflare account to ask (CLOUDFLARE_ACCOUNT_ID), or null for the login's own (the API's account). */
  accountId: string | null;
  /** Which login the operator needs, for a failure message. */
  login: string;
}

export interface Target {
  name: string;
  group: Group;
  /** Where the id is read: a URL, or `wrangler: <worker>` for a version's metadata. */
  url: string;
  kind: TargetKind;
  /** kind `wrangler` only. */
  wrangler?: WranglerSource;
}

/** Every piece the env's manifest has, in GROUPS order (the watchdog included; `selectGroups` decides what is read). */
export function checkTargets(m: Manifest): Target[] {
  const at = (base: string, path: string) => `${base.replace(/\/+$/u, '')}${path}`;
  const out: Target[] = [{ name: 'api', group: 'api', url: at(m.apiUrl, '/v1/health'), kind: 'json' }];
  if (m.vaultOrigin && m.authOrigin) {
    out.push(
      { name: 'vault worker', group: 'pages', url: at(m.vaultOrigin, BUILD_PATH), kind: 'json' },
      { name: 'vault bundle', group: 'pages', url: at(m.vaultOrigin, '/vault.js'), kind: 'vault-js' },
      { name: 'auth worker', group: 'pages', url: at(m.authOrigin, BUILD_PATH), kind: 'json' },
      { name: 'auth pages', group: 'pages', url: at(m.authOrigin, '/login'), kind: 'html-meta' },
    );
  }
  if (m.emailIssuer) out.push({ name: 'email issuer', group: 'issuer', url: at(emailIssuerUrl(m), ISSUER_HEALTH_PATH), kind: 'json' });
  if (m.console) {
    out.push(
      { name: 'console worker', group: 'console', url: at(m.console.origin, BUILD_PATH), kind: 'json' },
      { name: 'console spa', group: 'console', url: at(m.console.origin, '/'), kind: 'html-meta' },
      { name: 'console-auth worker', group: 'console-auth', url: at(m.console.authOrigin, BUILD_PATH), kind: 'json' },
    );
  }
  if (m.files) out.push({ name: 'files worker', group: 'files', url: at(m.files.origin, BUILD_PATH), kind: 'json' });
  if (m.admin) {
    const w = m.admin.workerName;
    out.push({ name: 'admin worker', group: 'admin', url: `wrangler: ${w}`, kind: 'wrangler', wrangler: { worker: w, app: 'admin', accountId: null, login: "the API's Cloudflare account" } });
  }
  if (m.watchdog) {
    const w = m.watchdog.cloudflare.workerName;
    out.push({
      name: 'watchdog worker',
      group: 'watchdog',
      url: `wrangler: ${w}`,
      kind: 'wrangler',
      wrangler: { worker: w, app: 'watchdog', accountId: m.watchdog.cloudflare.accountId, login: "the watchdog's own Cloudflare account (watchdog.cloudflare.accountId)" },
    });
  }
  return out;
}

/** `--only`/`--skip` values: comma-separated or repeated, each a known group. */
export function parseGroups(values: readonly string[], flag: string): Group[] {
  const out: Group[] = [];
  for (const v of values.flatMap((x) => x.split(',')).map((x) => x.trim())) {
    if (!(GROUPS as readonly string[]).includes(v)) throw new CliError(`--${flag}: unknown group "${v}" (one of ${GROUPS.join(', ')})`);
    if (!out.includes(v as Group)) out.push(v as Group);
  }
  return out;
}

export interface Selection {
  /** The groups read, in GROUPS order. */
  groups: Group[];
  /** Groups the manifest has that this run doesn't read. */
  notRead: Group[];
  /** Lines to print about what isn't read and why. */
  notes: string[];
}

/** Which of the manifest's groups to read: `--only`'s (each must be in the manifest), or all but `--skip`'s and the opt-in ones. */
export function selectGroups(m: Manifest, targets: readonly Target[], only: readonly Group[], skip: readonly Group[]): Selection {
  if (only.length > 0 && skip.length > 0) throw new CliError('Pass --only or --skip, not both');
  const present = GROUPS.filter((g) => targets.some((t) => t.group === g));
  for (const g of only) if (!present.includes(g)) throw new CliError(`envs/${m.name}.json has no ${g}: nothing of it is deployed to check`);
  const groups = only.length > 0 ? present.filter((g) => only.includes(g)) : present.filter((g) => !skip.includes(g) && !OPT_IN_GROUPS.includes(g));
  if (groups.length === 0) throw new CliError('Nothing to check: every group is skipped');
  const notRead = present.filter((g) => !groups.includes(g));
  const notes: string[] = [];
  const skipped = notRead.filter((g) => skip.includes(g) || only.length > 0);
  if (skipped.length > 0) notes.push(`not read (${only.length > 0 ? '--only' : '--skip'}): ${skipped.join(', ')}`);
  if (only.length === 0 && notRead.includes('watchdog') && !skip.includes('watchdog')) {
    notes.push(`the watchdog (${m.watchdog!.cloudflare.workerName}) is on its own Cloudflare account (D86) and not read by default: check it with \`deploy-check ${m.name} --only watchdog\`, logged in to that account`);
  }
  return { groups, notRead, notes };
}

export interface Observed {
  name: string;
  url: string;
  build: BuildId | null;
  /** Why no build id was read (a fixed phrase, at most a status, or wrangler's own error lines), or null. */
  problem: string | null;
}

/** Up to `limit` bytes of the body, as text, and whether there was more (the rest is not downloaded). */
async function readPrefix(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: '', truncated: false };
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return { text: Buffer.concat(chunks).toString('utf8'), truncated: false };
    chunks.push(value);
    total += value.byteLength;
    if (total >= limit) {
      await reader.cancel().catch(() => undefined);
      return { text: Buffer.concat(chunks).subarray(0, limit).toString('utf8'), truncated: total > limit };
    }
  }
}

const UNSTAMPED = 'not stamped: deployed without its deploy script (a raw wrangler deploy?)';

/** The build id in a JSON answer's `build`, or why there is none. */
function fromJson(text: string, truncated: boolean): { build: BuildId | null; problem: string | null } {
  if (truncated) return { build: null, problem: 'answer too large' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { build: null, problem: 'answer is not JSON' };
  }
  if (typeof body !== 'object' || body === null || !('build' in body)) return { build: null, problem: 'no build id: deployed before D384 (D406 for the console, console-auth and files Workers)' };
  const value = (body as { build: unknown }).build;
  if (value === null) return { build: null, problem: UNSTAMPED };
  const build = parseBuildId(value);
  return build ? { build, problem: null } : { build: null, problem: 'malformed build id' };
}

/** Reads one piece's build id over HTTP. Never throws: a network failure, a redirect or another status is its problem. */
export async function observe(t: Target, fetchFn: typeof fetch = fetch): Promise<Observed> {
  const result = (build: BuildId | null, problem: string | null): Observed => ({ name: t.name, url: t.url, build, problem });
  let res: Response;
  try {
    res = await fetchFn(t.url, {
      redirect: 'manual',
      headers: { 'user-agent': 'hana-deploy-check', 'cache-control': 'no-cache', accept: t.kind === 'json' ? 'application/json' : '*/*' },
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
  } catch {
    return result(null, 'unreachable');
  }
  if (res.status !== 200) {
    await res.body?.cancel().catch(() => undefined);
    return result(null, res.status >= 300 && res.status < 400 ? `redirected (HTTP ${res.status})` : `HTTP ${res.status}`);
  }
  try {
    if (t.kind === 'json') {
      const { text, truncated } = await readPrefix(res, BODY_LIMIT);
      const { build, problem } = fromJson(text, truncated);
      return result(build, problem);
    }
    if (t.kind === 'vault-js') {
      const build = parseVaultBanner((await readPrefix(res, BANNER_LIMIT)).text);
      return result(build, build ? null : 'no build id in the bundle: built before D384, or not by the web build');
    }
    const build = parseBuildMeta((await readPrefix(res, BODY_LIMIT)).text);
    return result(build, build ? null : 'no build id in the page: built before D384 (D406 for the console SPA), or not by its build');
  } catch {
    return result(null, 'the answer could not be read');
  }
}

// ---- wrangler: the admin's and the watchdog's deployed version ----

export interface WranglerResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** `wrangler <argv>` as installed in `apps/<app>`, with these env vars added; its stdout and stderr apart. */
export type WranglerRun = (app: string, argv: string[], env: Record<string, string>) => WranglerResult;

/** The deployment serving the Worker now (read-only). */
export const deploymentStatusArgv = (worker: string): string[] => ['deployments', 'status', '--name', worker, '--json'];
/** One version's metadata: its bindings, plain-text vars with their values, secrets by name only (read-only). */
export const versionViewArgv = (versionId: string, worker: string): string[] => ['versions', 'view', versionId, '--name', worker, '--json'];

const VERSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

/** The JSON wrangler printed (from its first `{`), or null. */
function jsonOut(stdout: string): unknown {
  const i = stdout.indexOf('{');
  if (i < 0) return null;
  try {
    return JSON.parse(stdout.slice(i));
  } catch {
    return null;
  }
}

/** The versions a deployment serves, with their traffic share, or null for anything else. */
export function deployedVersions(out: unknown): { id: string; percentage: number }[] | null {
  const versions = (out as { versions?: unknown } | null)?.versions;
  if (!Array.isArray(versions) || versions.length === 0) return null;
  const parsed = versions.map((v: unknown) => {
    const { version_id: id, percentage } = (v ?? {}) as { version_id?: unknown; percentage?: unknown };
    return typeof id === 'string' && VERSION_ID_RE.test(id) && typeof percentage === 'number' ? { id, percentage } : null;
  });
  return parsed.every((v) => v !== null) ? (parsed as { id: string; percentage: number }[]) : null;
}

/** The HANA_BUILD var of a version's metadata (`resources.bindings`), or why there is none. Reads nothing else. */
export function versionBuild(out: unknown): { build: BuildId | null; problem: string | null } {
  const bindings = (out as { resources?: { bindings?: unknown } } | null)?.resources?.bindings;
  if (!Array.isArray(bindings)) return { build: null, problem: 'wrangler versions view printed something unexpected' };
  const var_ = bindings.find((b: unknown) => (b as { name?: unknown } | null)?.name === BUILD_VAR) as { type?: unknown; text?: unknown } | undefined;
  if (!var_) return { build: null, problem: `${UNSTAMPED}, or before D406` };
  if (var_.type !== 'plain_text') return { build: null, problem: `${BUILD_VAR} is not a plain-text var` };
  const build = parseBuildId(var_.text);
  return build ? { build, problem: null } : { build: null, problem: 'malformed build id' };
}

/** The last lines of wrangler's own error output, control characters removed, for a failure message. */
function stderrTail(stderr: string): string {
  const lines = stderr
    .replace(/\u001b\[[0-9;]*m/gu, '')
    .split('\n')
    .map((l) => [...l].filter((c) => c >= ' ' && c !== '\u007f').join('').trim().slice(0, 200))
    .filter((l) => l !== '');
  return lines.length > 0 ? `:\n${lines.slice(-4).map((l) => `    ${l}`).join('\n')}` : '';
}

/** Reads a Worker's build id from its deployed version's metadata. Never throws. */
export function observeWrangler(t: Target, run: WranglerRun): Observed {
  const result = (build: BuildId | null, problem: string | null): Observed => ({ name: t.name, url: t.url, build, problem });
  const w = t.wrangler!;
  if (w.accountId === 'UNSET') return result(null, 'watchdog.cloudflare.accountId is UNSET in the manifest: no account to read');
  const env: Record<string, string> = w.accountId ? { CLOUDFLARE_ACCOUNT_ID: w.accountId } : {};
  const failed = (what: string, res: WranglerResult) => result(null, `wrangler ${what} failed (exit ${res.status}): logged in to ${w.login}?${stderrTail(res.stderr)}`);

  const status = run(w.app, deploymentStatusArgv(w.worker), env);
  if (status.status !== 0) return failed('deployments status', status);
  const versions = deployedVersions(jsonOut(status.stdout));
  if (!versions) return result(null, 'wrangler deployments status printed something unexpected');
  if (versions.length !== 1 || versions[0]!.percentage !== 100) {
    return result(null, `a gradual deployment is in progress (${versions.map((v) => `${v.percentage}%`).join(' / ')}): finish it or roll it back, then check`);
  }
  const view = run(w.app, versionViewArgv(versions[0]!.id, w.worker), env);
  if (view.status !== 0) return failed('versions view', view);
  const { build, problem } = versionBuild(jsonOut(view.stdout));
  return result(build, problem);
}

/** Runs the wrangler installed in `apps/<app>` from a fresh empty directory, so no wrangler config (generated for whatever env) applies. */
function defaultWrangler(app: string, argv: string[], env: Record<string, string>): WranglerResult {
  const bin = join(repoRoot, 'apps', app, 'node_modules', '.bin', 'wrangler');
  if (!existsSync(bin)) return { status: 127, stdout: '', stderr: `wrangler is not installed in apps/${app}: run corepack pnpm install` };
  const cwd = mkdtempSync(join(tmpdir(), 'hana-deploy-check-'));
  try {
    const res = spawnSync(bin, argv, { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1', ...env } });
    if (res.error) return { status: 1, stdout: '', stderr: res.error.message };
    return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

// ---- judging ----

export interface Findings {
  failures: string[];
  warnings: string[];
}

/** The failures and warnings for what was read, against this checkout (`head`, or null for `--skip-head`). */
export function judge(observed: readonly Observed[], head: LocalBuild | null, opts: { strict?: boolean } = {}): Findings {
  const failures: string[] = [];
  const warnings: string[] = [];
  for (const o of observed) if (o.problem) failures.push(`${o.name}: ${o.problem} (${o.url})`);
  const stamped = observed.filter((o): o is Observed & { build: BuildId } => o.build !== null);
  if (head) {
    for (const o of stamped) if (o.build.commit !== head.commit) failures.push(`${o.name} runs ${o.build.id}, not this checkout's ${head.commit} (HEAD)`);
  } else if (new Set(stamped.map((o) => o.build.commit)).size > 1) {
    failures.push(`the pieces run different commits: ${stamped.map((o) => `${o.name} ${o.build.id}`).join(', ')}`);
  }
  for (const o of stamped) {
    if (!o.build.dirty) continue;
    const line = `${o.name} was deployed from a tree with uncommitted changes (${o.build.id}): its code is not exactly any commit`;
    (opts.strict ? failures : warnings).push(line);
  }
  if (head?.dirty) warnings.push(`this checkout has uncommitted changes: a deploy from it is stamped ${head.id}, and --d1 lists its migrations folder as it is, not HEAD's`);
  return { failures, warnings };
}

// ---- D1 migrations (--d1) ----

export interface D1Target {
  name: string;
  group: Group;
  db: string;
  dir: string;
  gen: string;
}

/** The D1 databases `--d1` lists for these groups (default: every group read by default), with the app directory whose wrangler.jsonc binds each. */
export function d1Targets(m: Manifest, groups?: readonly Group[]): D1Target[] {
  const app = (name: string) => join(repoRoot, 'apps', name);
  const all: D1Target[] = [{ name: 'api D1', group: 'api', db: m.cloudflare.d1Name, dir: app('api'), gen: `corepack pnpm --filter @hana-id/api gen ${m.name}` }];
  if (m.emailIssuer) all.push({ name: 'issuer D1', group: 'issuer', db: m.emailIssuer.cloudflare.d1Name, dir: app('email-issuer'), gen: `corepack pnpm --filter @hana-id/email-issuer gen ${m.name}` });
  if (m.console) all.push({ name: 'console D1', group: 'console', db: m.console.d1Name, dir: app('console'), gen: `corepack pnpm --filter @hana-id/console gen ${m.name} --d1-id <its id>` });
  if (m.watchdog) all.push({ name: 'watchdog D1', group: 'watchdog', db: m.watchdog.cloudflare.d1Name, dir: app('watchdog'), gen: `corepack pnpm --filter @hana-id/watchdog gen ${m.name} --d1-id <its id>` });
  return all.filter((t) => (groups ? groups.includes(t.group) : !OPT_IN_GROUPS.includes(t.group)));
}

/** `wrangler d1 migrations list` argv (through pnpm, in the app's directory). */
export const migrationsListArgv = (db: string): string[] => ['exec', 'wrangler', 'd1', 'migrations', 'list', db, '--remote'];

/** The migrations wrangler says are not applied ([] for none), or null when its output isn't one it prints. */
export function pendingMigrations(output: string): string[] | null {
  if (output.includes('No migrations to apply')) return [];
  if (!output.includes('Migrations to be applied')) return null;
  return [...new Set([...output.matchAll(/\b\d{4}_[A-Za-z0-9_-]+\.sql\b/gu)].map((m) => m[0]))];
}

export interface RunResult {
  status: number;
  output: string;
}

export interface DeployCheckDeps {
  fetch?: typeof fetch;
  localBuild?: () => LocalBuild;
  loadManifest?: (name: string) => Manifest;
  /** `pnpm <argv>` in `dir`; stdout and stderr together. */
  pnpm?: (dir: string, argv: string[]) => RunResult;
  /** `wrangler <argv>` of `apps/<app>`, outside any wrangler config (the admin's and the watchdog's version). */
  wrangler?: WranglerRun;
  /** True when `dir` has a wrangler config. */
  hasWranglerConfig?: (dir: string) => boolean;
  log?: (line: string) => void;
}

function defaultPnpm(dir: string, argv: string[]): RunResult {
  const res = spawnSync('pnpm', argv, { cwd: dir, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: '1' } });
  if (res.error) return { status: 1, output: res.error.message };
  return { status: res.status ?? 1, output: `${res.stdout ?? ''}\n${res.stderr ?? ''}` };
}

const defaultHasConfig = (dir: string): boolean => ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].some((f) => existsSync(join(dir, f)));

/** The last lines of wrangler's output, for a failure message. */
const tail = (output: string): string =>
  output
    .trim()
    .split('\n')
    .slice(-8)
    .map((l) => `    ${l}`)
    .join('\n');

/** Runs the check; returns the exit code (0: every piece read on one commit, HEAD's unless --skip-head). */
export async function deployCheck(argv: readonly string[], deps: DeployCheckDeps = {}): Promise<number> {
  const args = parseCli(argv, { booleans: ['d1', 'skip-head', 'strict'], multiple: ['only', 'skip'] });
  if (args.positionals.length !== 1) throw new CliError('Name one env');
  const envName = args.positionals[0]!;
  if (envName.startsWith('local')) throw new CliError('local* envs run on wrangler dev, never deployed: nothing to check');
  const only = parseGroups(args.list('only'), 'only');
  const skip = parseGroups(args.list('skip'), 'skip');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const log = deps.log ?? ((line: string) => console.log(line));
  const all = checkTargets(m);
  const selection = selectGroups(m, all, only, skip);
  const targets = all.filter((t) => selection.groups.includes(t.group));
  const head = (deps.localBuild ?? localBuild)();

  // Over HTTP at once; then wrangler's, one after another (each a child process).
  const http = await Promise.all(targets.filter((t) => t.kind !== 'wrangler').map((t) => observe(t, deps.fetch ?? fetch)));
  const wrangler = deps.wrangler ?? defaultWrangler;
  const viaWrangler = targets.filter((t) => t.kind === 'wrangler').map((t) => observeWrangler(t, wrangler));
  const byName = new Map([...http, ...viaWrangler].map((o) => [o.name, o]));
  const observed = targets.map((t) => byName.get(t.name)!);

  log(`${m.name}: this checkout is ${head.id} (HEAD ${head.head})`);
  const width = Math.max(...observed.map((o) => o.name.length));
  for (const o of observed) log(`  ${o.name.padEnd(width)}  ${o.build ? o.build.id.padEnd(18) : 'none'.padEnd(18)}  ${o.url}`);
  for (const n of selection.notes) log(`note: ${n}`);
  const { failures, warnings } = judge(observed, args.flag('skip-head') ? null : head, { strict: args.flag('strict') });

  if (args.flag('d1')) {
    const pnpm = deps.pnpm ?? defaultPnpm;
    const hasConfig = deps.hasWranglerConfig ?? defaultHasConfig;
    for (const t of d1Targets(m, selection.groups)) {
      if (!hasConfig(t.dir)) {
        failures.push(`${t.name}: no wrangler config in ${t.dir.slice(repoRoot.length + 1)}; generate it for ${m.name} first: ${t.gen}`);
        continue;
      }
      const res = pnpm(t.dir, migrationsListArgv(t.db));
      const pending = res.status === 0 ? pendingMigrations(res.output) : null;
      if (res.status !== 0 || pending === null) {
        failures.push(`${t.name}: wrangler d1 migrations list ${t.db} --remote ${res.status !== 0 ? `failed (exit ${res.status})` : 'printed something unexpected'} (is wrangler.jsonc generated for ${m.name}?):\n${tail(res.output)}`);
      } else if (pending.length > 0) {
        failures.push(`${t.name}: ${t.db} lacks ${pending.length} migration(s) of this checkout: ${pending.join(', ')}`);
      } else {
        log(`  ${t.name.padEnd(width)}  every migration of this checkout is applied (${t.db})`);
      }
    }
  }

  for (const w of warnings) log(`warning: ${w}`);
  for (const f of failures) log(`FAIL: ${f}`);
  const scope = selection.notRead.length > 0 ? `; not read: ${selection.notRead.join(', ')}` : '';
  log(failures.length === 0 ? `OK: every piece of ${m.name} runs ${observed[0]?.build?.id ?? ''}${args.flag('skip-head') ? '' : ' (this checkout)'}${scope}` : `${failures.length} failure(s)`);
  return failures.length === 0 ? 0 : 1;
}
