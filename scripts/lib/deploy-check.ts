// deploy-check.ts's body (D384): after a deploy, does every deployed piece of an env run the same code, this
// checkout's? On 2026-11-05 sandbox-dev's page Workers served a vault bundle from an older build than the API (every
// wallet record 400), and a D1 migration was applied from a checkout older than the code deployed; nothing showed
// either. Each piece carries a build id (@hana-id/env/build-id: the commit's first 12 hex characters, `-dirty` for a
// tree with uncommitted changes), stamped by the `deploy` scripts and the page build:
//
//   api           GET {apiUrl}/v1/health                          `build`
//   vault worker  GET {vaultOrigin}/.well-known/hana-build        `build`
//   vault bundle  GET {vaultOrigin}/vault.js                      first line `/* hana-build <id> */`
//   auth worker   GET {authOrigin}/.well-known/hana-build         `build`
//   auth pages    GET {authOrigin}/login                          `<meta name="hana-build">`
//   email issuer  GET {emailIssuer.url}/v1/email/health           `build` (envs with an issuer)
//
// A piece that can't be read, isn't stamped (deployed without the scripts, or before D384), names another commit
// than the others or than HEAD fails the run (exit 1). A piece deployed from a dirty tree is a warning (`--strict`:
// a failure); so is a dirty checkout here. `--d1` also asks wrangler which of this checkout's D1 migrations the
// env's databases lack (`wrangler d1 migrations list <db> --remote`: it reads `d1_migrations`, and creates that
// table only if missing, which it never is on a migrated database), for the API's D1 and the issuer's.
//
// It holds no secret and prints only public values: URLs from the manifest, HTTP statuses, and build ids that parse
// (nothing else from an answer is printed).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { type Manifest, emailIssuerUrl, loadEnv, repoRoot } from '@hana-id/env';
import { BUILD_PATH, type BuildId, ISSUER_HEALTH_PATH, parseBuildId, parseBuildMeta, parseVaultBanner } from '@hana-id/env/build-id';
import { type LocalBuild, localBuild } from '@hana-id/env/local-build';
import { CliError, parseCli } from './cli.ts';

export const DEPLOY_CHECK_USAGE = `Usage: deploy-check.ts <env> [--d1] [--skip-head] [--strict]
  After a deploy: reads the build id of every deployed piece of envs/<env>.json (the API, the vault and auth page
  Workers, the vault bundle and auth pages they serve, the email issuer) and checks they all name one commit, this
  checkout's HEAD. Exits 1 when a piece can't be read, isn't stamped, or names another commit.
  --d1         also list the D1 migrations of this checkout that the env's databases (the API's, the issuer's) lack,
               with \`wrangler d1 migrations list <db> --remote\` (read-only); any is a failure. Needs the generated
               wrangler.jsonc of apps/api (and apps/email-issuer) for <env>.
  --skip-head  compare the pieces with each other only, not with this checkout
  --strict     a piece deployed from a tree with uncommitted changes (…-dirty) fails instead of warning`;

export const CHECK_TIMEOUT_MS = 10_000;
/** The most read of a JSON or HTML answer; the vault bundle is read only as far as its first line. */
export const BODY_LIMIT = 16_384;
export const BANNER_LIMIT = 256;

export type TargetKind = 'json' | 'vault-js' | 'auth-html';

export interface Target {
  name: string;
  url: string;
  kind: TargetKind;
}

/** What to read for an env: the API, both page origins (Worker and bundle) and the issuer, as its manifest has them. */
export function checkTargets(m: Manifest): Target[] {
  const at = (base: string, path: string) => `${base.replace(/\/+$/u, '')}${path}`;
  const out: Target[] = [{ name: 'api', url: at(m.apiUrl, '/v1/health'), kind: 'json' }];
  if (m.vaultOrigin && m.authOrigin) {
    out.push(
      { name: 'vault worker', url: at(m.vaultOrigin, BUILD_PATH), kind: 'json' },
      { name: 'vault bundle', url: at(m.vaultOrigin, '/vault.js'), kind: 'vault-js' },
      { name: 'auth worker', url: at(m.authOrigin, BUILD_PATH), kind: 'json' },
      { name: 'auth pages', url: at(m.authOrigin, '/login'), kind: 'auth-html' },
    );
  }
  if (m.emailIssuer) out.push({ name: 'email issuer', url: at(emailIssuerUrl(m), ISSUER_HEALTH_PATH), kind: 'json' });
  return out;
}

export interface Observed {
  name: string;
  url: string;
  build: BuildId | null;
  /** Why no build id was read (a fixed phrase and at most a status), or null. */
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

/** The build id in a JSON answer's `build`, or why there is none. */
function fromJson(text: string, truncated: boolean): { build: BuildId | null; problem: string | null } {
  if (truncated) return { build: null, problem: 'answer too large' };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { build: null, problem: 'answer is not JSON' };
  }
  if (typeof body !== 'object' || body === null || !('build' in body)) return { build: null, problem: 'no build id: deployed before D384' };
  const value = (body as { build: unknown }).build;
  if (value === null) return { build: null, problem: 'not stamped: deployed without its deploy script (a raw wrangler deploy?)' };
  const build = parseBuildId(value);
  return build ? { build, problem: null } : { build: null, problem: 'malformed build id' };
}

/** Reads one piece's build id. Never throws: a network failure, a redirect or another status is its problem. */
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
    return result(build, build ? null : 'no build id in the page: built before D384, or not by the web build');
  } catch {
    return result(null, 'the answer could not be read');
  }
}

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

/** The D1 databases `--d1` lists, with the app directory whose wrangler.jsonc binds each. */
export function d1Targets(m: Manifest): { name: string; db: string; dir: string; gen: string }[] {
  const out = [{ name: 'api D1', db: m.cloudflare.d1Name, dir: join(repoRoot, 'apps', 'api'), gen: `corepack pnpm --filter @hana-id/api gen ${m.name}` }];
  if (m.emailIssuer) {
    out.push({ name: 'issuer D1', db: m.emailIssuer.cloudflare.d1Name, dir: join(repoRoot, 'apps', 'email-issuer'), gen: `corepack pnpm --filter @hana-id/email-issuer gen ${m.name}` });
  }
  return out;
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

/** Runs the check; returns the exit code (0: every piece on one commit, HEAD's unless --skip-head). */
export async function deployCheck(argv: readonly string[], deps: DeployCheckDeps = {}): Promise<number> {
  const args = parseCli(argv, { booleans: ['d1', 'skip-head', 'strict'] });
  if (args.positionals.length !== 1) throw new CliError('Name one env');
  const envName = args.positionals[0]!;
  if (envName.startsWith('local')) throw new CliError('local* envs run on wrangler dev, never deployed: nothing to check');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  const log = deps.log ?? ((line: string) => console.log(line));
  const head = (deps.localBuild ?? localBuild)();

  const observed = await Promise.all(checkTargets(m).map((t) => observe(t, deps.fetch ?? fetch)));
  log(`${m.name}: this checkout is ${head.id} (HEAD ${head.head})`);
  const width = Math.max(...observed.map((o) => o.name.length));
  for (const o of observed) log(`  ${o.name.padEnd(width)}  ${o.build ? o.build.id.padEnd(18) : 'none'.padEnd(18)}  ${o.url}`);
  const { failures, warnings } = judge(observed, args.flag('skip-head') ? null : head, { strict: args.flag('strict') });

  if (args.flag('d1')) {
    const pnpm = deps.pnpm ?? defaultPnpm;
    const hasConfig = deps.hasWranglerConfig ?? defaultHasConfig;
    for (const t of d1Targets(m)) {
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
  log(failures.length === 0 ? `OK: every piece of ${m.name} runs ${observed[0]?.build?.id ?? ''}${args.flag('skip-head') ? '' : ' (this checkout)'}` : `${failures.length} failure(s)`);
  return failures.length === 0 ? 0 : 1;
}
