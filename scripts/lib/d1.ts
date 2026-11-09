// Runs SQL against an env's D1 databases: the API's from apps/api with `wrangler d1 execute` (local state is the one
// `wrangler dev` uses, apps/api/.wrangler/state; needs apps/api/wrangler.jsonc from apps/api/scripts/gen-wrangler.ts),
// and the email issuer's own D1 from apps/email-issuer (needs its wrangler.jsonc from apps/email-issuer's `gen`).
//
// The issuer's statements can hold a user's address (`user:find --email`, `user:list --search`), so they never go in
// a process argument, where `ps` and endpoint monitoring see them (`issuerD1Execute`):
// - local: the statement is written to a 0600 file in `.secrets/tmp/` (0700, gitignored), passed to wrangler as
//   `--file`, and deleted in a `finally`;
// - remote: Cloudflare's D1 REST API (`POST …/d1/database/<uuid>/query`), the statement in the HTTPS body, with the
//   operator's own wrangler credentials (`wrangler auth token --json`, read over a pipe, never printed). Not
//   `wrangler d1 execute --remote --file`: in wrangler 4.151.1 that is D1's import (the file uploaded to Cloudflare's
//   import bucket, the database unavailable to queries while it runs), and it answers with counts, never the rows.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { type Manifest, repoRoot } from '@hana-id/env';
import { FILE_MODE, ensureSecretDir } from './secrets.ts';

export const apiDir = join(repoRoot, 'apps', 'api');
export const emailIssuerDir = join(repoRoot, 'apps', 'email-issuer');

export interface D1Options {
  remote: boolean;
}

/** wrangler d1 execute argv (exported for tests). */
export function d1Argv(m: Pick<Manifest, 'cloudflare'>, statement: string, opts: D1Options): string[] {
  return ['exec', 'wrangler', 'd1', 'execute', m.cloudflare.d1Name, opts.remote ? '--remote' : '--local', '--json', '--command', statement];
}

/** The email issuer's own D1 (`emailIssuer.cloudflare.d1Name`). */
export function issuerD1Name(m: Pick<Manifest, 'name' | 'emailIssuer'>): string {
  if (!m.emailIssuer) throw new Error(`envs/${m.name}.json has no emailIssuer`);
  return m.emailIssuer.cloudflare.d1Name;
}

/**
 * wrangler d1 execute argv for the issuer's local D1: the statement in a file (`--file`), never in the argv. Local
 * only: wrangler's `--remote --file` is an import that returns no rows (the header above).
 */
export function issuerLocalD1Argv(m: Pick<Manifest, 'name' | 'emailIssuer'>, sqlFile: string): string[] {
  return ['exec', 'wrangler', 'd1', 'execute', issuerD1Name(m), '--local', '--json', '--file', sqlFile];
}

/**
 * wrangler's environment for a statement or result that holds personal data (the issuer's user directory, D269):
 * no debug log file (wrangler otherwise copies every message, its JSON result included, to ~/.wrangler/logs), no usage
 * metrics, no error reports.
 */
export const PRIVATE_WRANGLER_ENV: Readonly<Record<string, string>> = { WRANGLER_WRITE_LOGS: 'false', WRANGLER_SEND_METRICS: 'false', WRANGLER_SEND_ERROR_REPORTS: 'false' };

function requireWranglerConfig(dir: string, genHint: string): void {
  const config = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'].find((f) => existsSync(join(dir, f)));
  if (!config) throw new Error(`No wrangler config in ${dir.slice(repoRoot.length + 1)}. Generate it first: ${genHint}`);
}

/** Runs `pnpm <argv>` in `dir` (no shell); a failure throws with the output's tail, quoted spans redacted if `redact`. */
function runPnpm(dir: string, argv: string[], env: Readonly<Record<string, string>> | undefined, redact: boolean): string {
  const res = spawnSync('pnpm', argv, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    const text = `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
    throw new Error(`wrangler ${argv.slice(2, 4).join(' ')} failed (exit ${res.status}):\n${(redact ? redactQuoted(text) : text).slice(-2000)}`);
  }
  return res.stdout;
}

/**
 * Replaces every quoted span ('…', "…", `…`) with '…': error text from D1 or wrangler can quote part of a statement
 * (`near "…": syntax error`), and the issuer's statements can hold an address. Table and column names in D1's
 * messages are unquoted (`no such table: user_emails`), so they survive.
 */
export const redactQuoted = (text: string): string => text.replace(/'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/gu, "'…'");

/** Executes the statement(s) on the API's D1; returns the rows of every statement's result, concatenated. */
export function d1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options): Row[] {
  requireWranglerConfig(apiDir, `pnpm --filter @hana-id/api gen ${m.name}`);
  // argv array, no shell: the SQL is passed as one argument (the API's D1 holds no personal data).
  return parseD1Json<Row>(runPnpm(apiDir, d1Argv(m, statement, opts), undefined, false));
}

/** Where the issuer's local statements are written for `--file`: `<repo>/.secrets/tmp` (0700). */
export const PRIVATE_SQL_DIR = join(repoRoot, '.secrets', 'tmp');
/** A statement file older than this was left by a run that was killed (Ctrl-C during wrangler): removed. */
export const STALE_SQL_FILE_MS = 15 * 60_000;
const SQL_FILE_RE = /^d1-[0-9a-f]{24}\.sql$/u;

/**
 * Writes the statement to a new 0600 file in `dir` (created 0700, with its `.secrets` parent), runs `fn` with the
 * file's path and deletes the file in a `finally`. First removes this helper's own files older than
 * STALE_SQL_FILE_MS (a killed run's). The name is random; the content is never printed.
 */
export function withPrivateSqlFile<T>(statement: string, fn: (file: string) => T, dir: string = PRIVATE_SQL_DIR, nowMs: number = Date.now()): T {
  if (!dir.split(sep).includes('.secrets')) throw new Error('withPrivateSqlFile: the directory must be inside a .secrets directory');
  ensureSecretDir(dir);
  for (const name of readdirSync(dir)) {
    if (!SQL_FILE_RE.test(name)) continue;
    const old = join(dir, name);
    try {
      if (nowMs - statSync(old).mtimeMs > STALE_SQL_FILE_MS) rmSync(old, { force: true });
    } catch {
      // removed by another run meanwhile
    }
  }
  const file = join(dir, `d1-${randomBytes(12).toString('hex')}.sql`);
  try {
    writeFileSync(file, statement, { mode: FILE_MODE, flag: 'wx' });
    chmodSync(file, FILE_MODE);
    return fn(file);
  } finally {
    rmSync(file, { force: true });
  }
}

/** One Cloudflare API call: the response's JSON (the `{success, result, errors}` envelope) and its HTTP status. */
export type CloudflareFetch = (url: string, init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string }) => Promise<{ status: number; json: unknown }>;

export interface IssuerD1Deps {
  /** `pnpm <argv>` in apps/email-issuer with PRIVATE_WRANGLER_ENV; returns stdout, throws (redacted) on a failure. */
  wrangler: (argv: string[]) => string;
  /** Throws when apps/email-issuer has no wrangler config (the local D1 needs it; the env name is for the hint). */
  requireLocalConfig: (envName: string) => void;
  fetch: CloudflareFetch;
  env: Readonly<Record<string, string | undefined>>;
  /** Where local statement files go (default PRIVATE_SQL_DIR). */
  sqlDir?: string;
}

const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const CF_TIMEOUT_MS = 30_000;
const ACCOUNT_ID_RE = /^[0-9a-f]{32}$/u;
const D1_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

export const defaultIssuerD1Deps = (): IssuerD1Deps => ({
  wrangler: (argv) => runPnpm(emailIssuerDir, argv, PRIVATE_WRANGLER_ENV, true),
  requireLocalConfig: (envName) => requireWranglerConfig(emailIssuerDir, `pnpm --filter @hana-id/email-issuer gen ${envName} --d1-id <uuid>`),
  fetch: async (url, init) => {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(CF_TIMEOUT_MS) });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON: reported by its status
    }
    return { status: res.status, json };
  },
  env: process.env,
});

/** The API base: CLOUDFLARE_API_BASE_URL (as wrangler reads it) or the public API; FedRAMP and staging need the base. */
export function cloudflareApiBase(env: Readonly<Record<string, string | undefined>>): string {
  const base = env.CLOUDFLARE_API_BASE_URL;
  if (base) {
    if (!/^https:\/\/\S+$/u.test(base)) throw new Error('CLOUDFLARE_API_BASE_URL must be an https URL');
    return base.replace(/\/+$/u, '');
  }
  if (env.CLOUDFLARE_COMPLIANCE_REGION === 'fedramp_high' || env.WRANGLER_API_ENVIRONMENT === 'staging') {
    throw new Error('Set CLOUDFLARE_API_BASE_URL for this Cloudflare region or environment (the CLI only knows the public API)');
  }
  return CLOUDFLARE_API;
}

/**
 * The operator's Cloudflare credentials as request headers, from `wrangler auth token --json` (CLOUDFLARE_API_TOKEN,
 * CLOUDFLARE_API_KEY + CLOUDFLARE_EMAIL, or `wrangler login`'s OAuth token, which wrangler refreshes if expired). Read
 * over a pipe; never printed, logged or written anywhere.
 */
export function cloudflareAuthHeaders(deps: Pick<IssuerD1Deps, 'wrangler'>): Record<string, string> {
  let out: string;
  try {
    out = deps.wrangler(['exec', 'wrangler', 'auth', 'token', '--json']);
  } catch {
    // Its output is not quoted: it could hold a credential.
    throw new Error('No Cloudflare credentials: run `corepack pnpm --dir apps/email-issuer exec wrangler login` (or set CLOUDFLARE_API_TOKEN)');
  }
  const start = out.indexOf('{');
  let v: { type?: unknown; token?: unknown; key?: unknown; email?: unknown } | undefined;
  try {
    v = start >= 0 ? (JSON.parse(out.slice(start)) as typeof v) : undefined;
  } catch {
    v = undefined;
  }
  if (v && (v.type === 'oauth' || v.type === 'api_token') && typeof v.token === 'string' && v.token) return { Authorization: `Bearer ${v.token}` };
  if (v && v.type === 'api_key' && typeof v.key === 'string' && v.key && typeof v.email === 'string' && v.email) return { 'X-Auth-Key': v.key, 'X-Auth-Email': v.email };
  throw new Error('`wrangler auth token --json` returned no usable credentials');
}

type Envelope = { success?: unknown; result?: unknown; errors?: { code?: unknown; message?: unknown }[] };

/** Cloudflare's envelope → its `result`; a failure names the error codes and messages, quoted spans redacted. */
async function cfCall(deps: IssuerD1Deps, url: string, init: Parameters<CloudflareFetch>[1], what: string): Promise<unknown> {
  const { status, json } = await deps.fetch(url, init);
  const env = (json ?? {}) as Envelope;
  if (status >= 200 && status < 300 && env.success === true) return env.result;
  const errors = Array.isArray(env.errors)
    ? env.errors.map((e) => `${typeof e.code === 'number' ? `${e.code} ` : ''}${typeof e.message === 'string' ? redactQuoted(e.message).slice(0, 300) : ''}`.trim()).filter(Boolean)
    : [];
  const hint = status === 401 || status === 403 ? ' (check `wrangler whoami`: the credentials need D1 access on the account)' : '';
  throw new Error(`Cloudflare ${what} failed (HTTP ${status})${errors.length ? `: ${errors.join('; ')}` : ''}${hint}`);
}

/** CLOUDFLARE_ACCOUNT_ID, or the credentials' only account. */
async function accountId(deps: IssuerD1Deps, base: string, headers: Record<string, string>): Promise<string> {
  const fromEnv = deps.env.CLOUDFLARE_ACCOUNT_ID;
  if (fromEnv) {
    if (!ACCOUNT_ID_RE.test(fromEnv)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be 32 lowercase hex characters');
    return fromEnv;
  }
  const result = await cfCall(deps, `${base}/accounts?per_page=50`, { method: 'GET', headers }, 'account list');
  const ids = (Array.isArray(result) ? (result as { id?: unknown }[]) : []).map((a) => a.id).filter((id): id is string => typeof id === 'string' && ACCOUNT_ID_RE.test(id));
  if (ids.length === 1) return ids[0]!;
  throw new Error(ids.length === 0 ? 'These Cloudflare credentials reach no account' : `These Cloudflare credentials reach ${ids.length} accounts: set CLOUDFLARE_ACCOUNT_ID to the issuer's`);
}

/**
 * Executes the statement(s) on the email issuer's own D1. Its tables hold users' addresses, so the statement never
 * goes in a process argument (the header). Local: wrangler with `--file` (a 0600 file in `.secrets/tmp/`, deleted
 * after) and its log file, metrics and error reports off (`PRIVATE_WRANGLER_ENV`). Remote: D1's REST query endpoint
 * on the database named `emailIssuer.cloudflare.d1Name`. Errors never quote the statement.
 */
export async function issuerD1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options, deps: IssuerD1Deps = defaultIssuerD1Deps()): Promise<Row[]> {
  return privateD1Execute<Row>(m, issuerD1Name(m), (file) => issuerLocalD1Argv(m, file), statement, opts, deps);
}

/** wrangler d1 execute argv for the API's local D1 with the statement in a file (apiPrivateD1Execute). */
export function apiLocalD1Argv(m: Pick<Manifest, 'cloudflare'>, sqlFile: string): string[] {
  return ['exec', 'wrangler', 'd1', 'execute', m.cloudflare.d1Name, '--local', '--json', '--file', sqlFile];
}

/** The private executor's deps for the API's D1 (wrangler in apps/api, its log file off). */
export const defaultApiPrivateD1Deps = (): IssuerD1Deps => ({
  ...defaultIssuerD1Deps(),
  wrangler: (argv) => runPnpm(apiDir, argv, PRIVATE_WRANGLER_ENV, true),
  requireLocalConfig: (envName) => requireWranglerConfig(apiDir, `pnpm --filter @hana-id/api gen ${envName}`),
});

/**
 * Executes a read on the API's own D1 the way issuerD1Execute reads the issuer's: for statements that hold personal
 * data (the wallet directory, migration 0011: a wallet address or a sub to look up, D316), so the statement never goes
 * in a process argument, wrangler's log file stays off, and errors never quote it. `m.cloudflare.d1Name` (the CLI's
 * `--d1-name` rehearsal database included).
 */
export async function apiPrivateD1Execute<Row = Record<string, unknown>>(m: Manifest, statement: string, opts: D1Options, deps: IssuerD1Deps = defaultApiPrivateD1Deps()): Promise<Row[]> {
  return privateD1Execute<Row>(m, m.cloudflare.d1Name, (file) => apiLocalD1Argv(m, file), statement, opts, deps);
}

async function privateD1Execute<Row>(m: Manifest, name: string, localArgv: (file: string) => string[], statement: string, opts: D1Options, deps: IssuerD1Deps): Promise<Row[]> {
  if (!opts.remote) {
    deps.requireLocalConfig(m.name);
    return withPrivateSqlFile(statement, (file) => parseD1Json<Row>(deps.wrangler(localArgv(file)), true), deps.sqlDir);
  }
  const base = cloudflareApiBase(deps.env);
  const headers = cloudflareAuthHeaders(deps);
  const account = await accountId(deps, base, headers);
  const db = (await cfCall(deps, `${base}/accounts/${account}/d1/database/${encodeURIComponent(name)}`, { method: 'GET', headers }, `D1 lookup of ${name}`)) as {
    uuid?: unknown;
    name?: unknown;
  } | null;
  if (!db || db.name !== name || typeof db.uuid !== 'string' || !D1_UUID_RE.test(db.uuid)) throw new Error(`No D1 database named ${name} on the Cloudflare account`);
  const result = await cfCall(
    deps,
    `${base}/accounts/${account}/d1/database/${db.uuid}/query`,
    { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ sql: statement }) },
    `D1 query on ${name}`,
  );
  return d1Results<Row>(result, true);
}

/**
 * Parses `wrangler d1 execute --json` output: an array of `{results, success}` (tolerates leading log lines).
 * `redact`: a failed statement's error is reported with its quoted spans redacted (the issuer's statements).
 */
export function parseD1Json<Row>(stdout: string, redact = false): Row[] {
  let parsed: unknown[] | undefined;
  // The JSON array starts at the beginning of a line; earlier lines may be logs (some contain '[').
  for (const m of stdout.matchAll(/^\[/gmu)) {
    try {
      const value = JSON.parse(stdout.slice(m.index)) as unknown;
      if (Array.isArray(value)) {
        parsed = value;
        break;
      }
    } catch {
      // not the JSON block
    }
  }
  if (!parsed) throw new Error('wrangler returned no JSON');
  return d1Results<Row>(parsed, redact);
}

/** D1's per-statement results (wrangler's `--json` array, or the REST query's `result`), concatenated. */
export function d1Results<Row>(value: unknown, redact: boolean): Row[] {
  type Result = { results?: Row[]; success?: boolean; error?: unknown };
  if (!Array.isArray(value)) throw new Error('D1 returned no results');
  const parsed = value as Result[];
  const failed = parsed.find((r) => r.success === false);
  if (failed) {
    const err = failed.error ?? failed;
    if (!redact) throw new Error(`D1 error: ${JSON.stringify(err)}`);
    // Only a message string is shown, its quoted spans redacted; any other shape could carry the statement.
    const message = typeof err === 'string' ? err : typeof (err as { message?: unknown }).message === 'string' ? (err as { message: string }).message : undefined;
    throw new Error(`D1 error: ${message === undefined ? '(details withheld: they could quote the statement)' : redactQuoted(message).slice(0, 500)}`);
  }
  return parsed.flatMap((r) => r.results ?? []);
}
