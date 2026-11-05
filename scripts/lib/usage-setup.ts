// usage-setup's body (batch C4, docs/batch-c-spec.md "Bindings": Hyperdrive; "uid"): what the usage ledger's
// Workers need besides the schema (usage-migrate), for one testnet env.
//
//   roles        give `usage_writer` and `usage_admin` LOGIN (SQL, as the owner over the direct URL from
//                .secrets/<env>/neon.json), have Neon's API reset each role's password (Neon generates it; D403) and
//                write each role's URL with it to .secrets/<env>/neon-usage-*.url, replacing the file
//   hyperdrive   create the two Hyperdrive configs (caching disabled) from those URLs through Cloudflare's API, the
//                password only in the HTTPS body (D411), and print their ids (not secret)
//   user-id-key  generate USER_ID_KEY (32 random bytes, base64) into .secrets/<env>/user-id-key and set it as the
//                API Worker's secret through wrangler's stdin
//
// Every command prints its plan and changes nothing without --yes, and each can be run again: `roles` resets both
// passwords again and replaces the files (a reset invalidates the old password, so a Hyperdrive config made from an
// older file must be re-created), `user-id-key` never replaces the key file (a new key would make every user a new
// user, D96) and sets the existing one again. Nothing prints a password, a URL, the Neon API key or the uid key. Neon
// accepts only plain-text passwords (not the SCRAM verifiers D224 first sent), so Neon generates them: no role
// password travels in SQL, an argument or an environment variable, only in the HTTPS answer to Neon's API call and, for
// `hyperdrive`, in the HTTPS body of Cloudflare's (never `wrangler hyperdrive create --connection-string`, whose
// argument any local process can read; D411, mainnet-readiness 4.18). The one SQL password is `roles`' throwaway
// (random, never stored or printed, replaced by the reset within seconds); a role whose reset doesn't happen after
// the throwaway's COMMIT is set NOLOGIN again, best effort (D411).
import { spawnSync } from 'node:child_process';
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { CloudflareApi, CloudflareApiError, readCloudflareToken, resolveAccount } from './cloudflare-api.ts';
import { NEON_API_KEY_FILE, NeonApi, readNeonApiKey, scrub } from './neon-api.ts';
import { FILE_MODE, assertPrivate, ensureSecretDir, secretsDir } from './secrets.ts';
import { ownerUrlProblem, redact, type SqlConn } from './usage-migrate.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const USAGE_SETUP_USAGE = `Usage: usage-setup.ts <env> <roles | hyperdrive | user-id-key> [--yes] [--account-id <id>]
  roles        LOGIN for usage_writer and usage_admin (SQL as the Neon owner, over DATABASE_URL_DIRECT from
               .secrets/<env>/neon.json), then resets each role's password through Neon's API (project_id and
               branch_id from neon.json, the key from .secrets/<env>/neon-api-key, 0600; Neon generates the
               password) and REPLACES .secrets/<env>/neon-usage-writer.url and neon-usage-admin.url (0600) with it;
               checks each role logs in. A reset invalidates the old password: re-create any Hyperdrive config made
               from an older file (roles first, then hyperdrive).
  hyperdrive   creates the Hyperdrive configs hana-id-usage-writer-<env> and hana-id-usage-admin-<env> (or the
               manifest's usage block names), caching disabled, from those files, through Cloudflare's API (the
               token from .secrets/<env>/cloudflare-hyperdrive-token, 0600, "Hyperdrive Edit"; the account from
               --account-id, the manifest's cloudflare.accountId or the token's only account); prints their ids for
               \`gen --usage-hyperdrive-id\` (the writer's) and the admin Worker (batch C8)
  user-id-key  generates USER_ID_KEY into .secrets/<env>/user-id-key (0600, never replaced) and sets it on the API
               Worker; make an offline backup of the file
  --yes        do it (without it, only print the plan)

Testnet envs only. Never prints a password, a URL or a key.`;

export const ROLES = ['usage_writer', 'usage_admin'] as const;
export type LedgerRole = (typeof ROLES)[number];
export const ROLE_FILES: Record<LedgerRole, string> = { usage_writer: 'neon-usage-writer.url', usage_admin: 'neon-usage-admin.url' };
export const USER_ID_KEY_FILE = 'user-id-key';
/** The Cloudflare API token `hyperdrive` uses (one line, 0600): an account token with Hyperdrive Edit only (D411). */
export const CLOUDFLARE_HYPERDRIVE_TOKEN_FILE = 'cloudflare-hyperdrive-token';
/** The permission's name in the dashboard's token form (the API reference calls it "Hyperdrive Write"). */
export const HYPERDRIVE_PERMISSION = 'Account › Hyperdrive › Edit';
/** Cloudflare's error code for a config name already taken. */
export const HYPERDRIVE_NAME_TAKEN = 2017;
const USER_ID_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;
/** Neon's project and branch ids (`quiet-sky-12345678`, `br-quiet-sky-a1b2c3d4`), as neon.json holds them. */
const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/u;
const BRANCH_ID_RE = /^br-[a-z0-9-]{1,60}$/u;
const HYPERDRIVE_ID_RE = /^[0-9a-f]{32}$/u;

export interface WranglerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface NeonSecrets {
  DATABASE_URL_DIRECT?: unknown;
  project_id?: unknown;
  branch_id?: unknown;
}

export interface UsageSetupDeps {
  /** .secrets/<env>/neon.json, read with the 0600 check; undefined when absent. */
  readNeonSecrets(env: string): NeonSecrets | undefined;
  /** Opens a connection: the owner's, or a role's (to check its new password). */
  connect(url: string): Promise<SqlConn & { close(): Promise<void> }>;
  /** Neon's API, in process (the key only in a request header). */
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  sleep: (ms: number) => Promise<void>;
  /** Runs `wrangler <args>` from apps/api (stdin `input`); output captured, never echoed by this function. */
  wrangler(args: string[], input?: string): WranglerResult;
  randomBytes(n: number): Uint8Array;
  log(line: string): void;
  /** CLOUDFLARE_ACCOUNT_ID and the like (default: process.env). */
  env?: Record<string, string | undefined>;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
}

const apiDir = join(repoRoot, 'apps', 'api');

export function defaultUsageSetupDeps(connect: UsageSetupDeps['connect'], readNeonSecrets: UsageSetupDeps['readNeonSecrets']): UsageSetupDeps {
  return {
    readNeonSecrets,
    connect,
    fetch: (url, init) => fetch(url, init),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    wrangler: (args, input) => {
      const res = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: apiDir, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (res.error) throw res.error;
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    },
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    log: (line) => console.log(line),
  };
}

/** A role's URL: the owner's direct endpoint and database, TLS required, as the role (Hyperdrive pools for it). */
export function roleUrl(ownerUrl: string, role: LedgerRole, password: string): string {
  const u = new URL(ownerUrl);
  u.username = role;
  // Encoded first: the URL setter leaves `%` as it is, which a reader would then decode wrongly.
  u.password = encodeURIComponent(password);
  // Only TLS: the owner URL's other options (e.g. Neon's channel_binding) are for its own client.
  u.search = '';
  u.searchParams.set('sslmode', 'require');
  return u.toString();
}

/**
 * Why a role password can't be used, or null: 12–512 characters, no whitespace or control characters. Neon generates
 * them (`npg_` and random letters and digits); files written before D403 hold 43 base64url characters.
 */
export function rolePasswordProblem(password: string): string | null {
  if (password.length < 12 || password.length > 512) return 'not 12–512 characters';
  if (/[\s\x00-\x1f\x7f]/u.test(password)) return 'has whitespace or control characters';
  return null;
}

/** A role's URL from its file: 0600, the role's name, a usable password, on the owner's Neon endpoint. */
export function readRoleUrl(file: string, role: LedgerRole, shown: string): { url: string; password: string } {
  assertPrivate(file);
  const url = readFileSync(file, 'utf8').trim();
  let u: URL;
  let password: string;
  try {
    u = new URL(url);
    password = decodeURIComponent(u.password);
  } catch {
    throw new Error(`${shown} is not a URL`);
  }
  if (u.username !== role || rolePasswordProblem(password)) throw new Error(`${shown} is not a ${role} URL written by usage-setup roles`);
  const problem = ownerUrlProblem(url);
  if (problem) throw new Error(`${shown} ${problem}`);
  return { url, password };
}

/** Writes (or replaces) a secret text file atomically, 0600. */
function writeSecretText(file: string, value: string): void {
  const abs = resolve(file);
  if (!abs.split(sep).includes('.secrets')) throw new Error('Refusing to write a secret outside a .secrets directory');
  ensureSecretDir(resolve(abs, '..'));
  const tmp = `${abs}.${Buffer.from(nodeRandomBytes(6)).toString('hex')}.tmp`;
  writeFileSync(tmp, value, { mode: FILE_MODE, flag: 'wx' });
  chmodSync(tmp, FILE_MODE);
  renameSync(tmp, abs);
}

/**
 * Cloudflare's create-config body (POST /accounts/{id}/hyperdrive/configs): the role URL's parts, the password a
 * write-only field Cloudflare never returns, caching disabled. Hyperdrive connects to a Postgres origin over TLS.
 */
export function hyperdriveBody(name: string, url: string): { name: string; origin: { scheme: 'postgres'; host: string; port: number; database: string; user: string; password: string }; caching: { disabled: true } } {
  const u = new URL(url);
  const database = decodeURIComponent(u.pathname.replace(/^\//u, ''));
  if (!database || database.includes('/')) throw new Error('the role URL names no database');
  const port = u.port ? Number(u.port) : 5432;
  return { name, origin: { scheme: 'postgres', host: u.hostname, port, database, user: decodeURIComponent(u.username), password: decodeURIComponent(u.password) }, caching: { disabled: true } };
}

/** The Hyperdrive config names: the manifest's `usage` block when it has one, else the spec's defaults. */
export function hyperdriveNames(m: Pick<Manifest, 'name' | 'usage'>): Record<LedgerRole, string> {
  return {
    usage_writer: m.usage?.writerHyperdrive ?? `hana-id-usage-writer-${m.name}`,
    usage_admin: m.usage?.adminHyperdrive ?? `hana-id-usage-admin-${m.name}`,
  };
}

/** Runs `usage-setup <argv>`. */
export async function usageSetup(argv: readonly string[], deps: UsageSetupDeps): Promise<void> {
  const args = parseCli(argv, { booleans: ['yes', 'help'], strings: ['account-id'] });
  if (args.flag('help')) return void deps.log(USAGE_SETUP_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <roles | hyperdrive | user-id-key>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  if (command !== 'roles' && command !== 'hyperdrive' && command !== 'user-id-key') throw new CliError(`Unknown command ${command}`);
  if (args.str('account-id') !== undefined && command !== 'hyperdrive') throw new CliError('--account-id is for hyperdrive only');
  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const dir = secretsDir(m.name, deps.secretsRoot ?? repoRoot);
  const shown = (f: string) => `.secrets/${m.name}/${f}`;
  const apply = args.flag('yes');

  if (command === 'user-id-key') {
    const file = join(dir, USER_ID_KEY_FILE);
    const exists = existsSync(file);
    const worker = m.cloudflare.workerName;
    deps.log(`Plan (env ${m.name}): ${exists ? `keep ${shown(USER_ID_KEY_FILE)}` : `generate USER_ID_KEY into ${shown(USER_ID_KEY_FILE)} (0600)`}, set USER_ID_KEY on Worker ${worker}.`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    if (!exists) {
      const raw = deps.randomBytes(32);
      if (raw.length !== 32) throw new Error('randomBytes returned the wrong length');
      writeNewSecretFile(file, Buffer.from(raw).toString('base64'));
      raw.fill(0);
      deps.log(`Wrote ${shown(USER_ID_KEY_FILE)} (0600, value not shown). Make an offline backup of it now: losing it makes every user a new user.`);
    }
    assertPrivate(file);
    const value = readFileSync(file, 'utf8').trim();
    if (!USER_ID_KEY_RE.test(value) || Buffer.from(value, 'base64').length !== 32) throw new Error(`${shown(USER_ID_KEY_FILE)} is not base64 of 32 bytes`);
    const res = deps.wrangler(['secret', 'put', 'USER_ID_KEY', '--name', worker], value);
    if (res.status !== 0) throw new Error(`wrangler secret put USER_ID_KEY failed (exit ${res.status})`);
    return void deps.log(`Set USER_ID_KEY on Worker ${worker}.`);
  }

  if (command === 'hyperdrive') return hyperdriveCommand(m, dir, shown, apply, args.str('account-id'), deps);

  return rolesCommand(m, dir, shown, apply, deps);
}

type Conn = SqlConn & { close(): Promise<void> };

/**
 * `hyperdrive` (D411): both configs through Cloudflare's API, each role's password only in the HTTPS body (Cloudflare
 * keeps it write-only). A POST whose answer is lost isn't sent again (CloudflareApi): the next run finds the name taken.
 */
async function hyperdriveCommand(m: Manifest, dir: string, shown: (f: string) => string, apply: boolean, accountFlag: string | undefined, deps: UsageSetupDeps): Promise<void> {
  const names = hyperdriveNames(m);
  const urls = ROLES.map((role) => ({ role, ...readRoleUrl(join(dir, ROLE_FILES[role]), role, shown(ROLE_FILES[role])) }));
  const tokenShown = shown(CLOUDFLARE_HYPERDRIVE_TOKEN_FILE);
  const how = `create an account API token with only "${HYPERDRIVE_PERMISSION}" on this env's account, and save it with \`umask 077; pbpaste > ${tokenShown}\` (docs/operations.md "Usage capture" step 3); revoke it after`;
  const token = readCloudflareToken(join(dir, CLOUDFLARE_HYPERDRIVE_TOKEN_FILE), tokenShown, how);
  const given = accountFlag ?? m.cloudflare.accountId ?? (deps.env ?? process.env).CLOUDFLARE_ACCOUNT_ID;
  deps.log(
    `Plan (env ${m.name}): create Hyperdrive configs ${ROLES.map((r) => names[r]).join(' and ')} (caching disabled) from ${ROLES.map((r) => shown(ROLE_FILES[r])).join(' and ')}, ` +
      `through Cloudflare's API in account ${given ?? "(the token's only account)"} with ${tokenShown}; each password goes only in the HTTPS body.`,
  );
  if (!apply) return void deps.log(DRY_RUN_LINE);
  const api = new CloudflareApi(token, { fetch: deps.fetch, sleep: deps.sleep, log: deps.log });
  // Every message that leaves: the token, every role URL and password removed.
  const clean = (e: unknown) => scrub(urls.reduce((t, u) => redact(t, u.url), e instanceof Error ? e.message : String(e)), [token, ...urls.flatMap((u) => [u.url, u.password])]);
  let account: string;
  try {
    account = await resolveAccount(api, given);
  } catch (e) {
    if (e instanceof CliError) throw e;
    throw new Error(clean(e));
  }
  for (const { role, url } of urls) {
    let result: unknown;
    try {
      ({ result } = await api.request('POST', `/accounts/${account}/hyperdrive/configs`, `creating Hyperdrive config ${names[role]}`, HYPERDRIVE_PERMISSION, hyperdriveBody(names[role], url)));
    } catch (e) {
      // A config of that name from before a `roles` re-run: its password is the old one, so it is re-created.
      const taken = e instanceof CloudflareApiError && (e.codes.includes(HYPERDRIVE_NAME_TAKEN) || /already exists/iu.test(e.message));
      const hint = taken ? ` A config named ${names[role]} already exists: delete it (\`wrangler hyperdrive list\`, then \`wrangler hyperdrive delete <id>\`) and run hyperdrive again; pass the new ids on (docs/operations.md "Usage capture" step 3).` : '';
      throw new Error(`${clean(e)}${hint}`);
    }
    const id = (result as { id?: unknown } | null)?.id;
    if (typeof id !== 'string' || !HYPERDRIVE_ID_RE.test(id)) throw new Error(`Cloudflare created ${names[role]} but answered no config id; find it with \`wrangler hyperdrive list\``);
    deps.log(`${names[role]} (${role}): ${id}`);
  }
  deps.log('Pass the writer id to the API: corepack pnpm --filter @hana-id/api gen <env> --usage-hyperdrive-id <id>. Then revoke the Hyperdrive token and delete its file.');
}

/**
 * After a failed reset: `ALTER ROLE … NOLOGIN` as the owner, over a new connection (a reset drops the old one), for
 * each role still holding the throwaway password. Best effort: the sentence for the error, its own failure scrubbed.
 */
async function lockRoles(owner: string, roles: readonly LedgerRole[], deps: UsageSetupDeps, clean: (s: string) => string): Promise<string> {
  if (roles.length === 0) return '';
  let db: Conn | undefined;
  const locked: LedgerRole[] = [];
  try {
    db = await deps.connect(owner);
    for (const role of roles) {
      await db.exec(`ALTER ROLE ${role} NOLOGIN`);
      locked.push(role);
    }
  } catch (e) {
    const left = roles.filter((r) => !locked.includes(r));
    return `${locked.length ? `${locked.join(' and ')} set NOLOGIN; ` : ''}could not set ${left.join(' and ')} NOLOGIN (${clean(e instanceof Error ? e.message : String(e)).slice(0, 200)}): it still has LOGIN with the throwaway password nobody holds; run ALTER ROLE ${left.join(', ')} NOLOGIN as the owner if roles isn't re-run soon.`;
  } finally {
    await db?.close().catch(() => undefined);
  }
  return `${locked.join(' and ')} set NOLOGIN again (not reset: no login until roles succeeds).`;
}

/** `roles`: LOGIN by SQL, then a password reset per role through Neon's API, each written to its file (D403). */
async function rolesCommand(m: Manifest, dir: string, shown: (f: string) => string, apply: boolean, deps: UsageSetupDeps): Promise<void> {
  const neon = deps.readNeonSecrets(m.name);
  const owner = neon?.DATABASE_URL_DIRECT;
  if (typeof owner !== 'string') throw new Error(`${shown('neon.json')} has no DATABASE_URL_DIRECT (docs/operations.md "Usage ledger")`);
  const problem = ownerUrlProblem(owner);
  if (problem) throw new Error(`DATABASE_URL_DIRECT in ${shown('neon.json')} ${problem}`);
  const projectId = neon?.project_id;
  const branchId = neon?.branch_id;
  if (typeof projectId !== 'string' || !PROJECT_ID_RE.test(projectId)) throw new Error(`${shown('neon.json')} has no valid project_id (Neon's project id, e.g. quiet-sky-12345678)`);
  if (typeof branchId !== 'string' || !BRANCH_ID_RE.test(branchId)) throw new Error(`${shown('neon.json')} has no valid branch_id (Neon's branch id, br-…)`);
  const key = readNeonApiKey(join(dir, NEON_API_KEY_FILE), shown(NEON_API_KEY_FILE));
  const ownerParts = new URL(owner);
  const host = ownerParts.hostname;
  const ownerPassword = decodeURIComponent(ownerParts.password);

  const files = ROLES.map((r) => `${existsSync(join(dir, ROLE_FILES[r])) ? 'REPLACE' : 'write'} ${shown(ROLE_FILES[r])}`);
  deps.log(
    `Plan (env ${m.name}): Neon project ${projectId}, branch ${branchId}, endpoint ${host}. Check the endpoint is the branch's; ` +
      `as the owner, check ${ROLES.join(' and ')} exist and ALTER ROLE … WITH LOGIN with a random throwaway password (never stored); reset each role's password ` +
      `through Neon's API (Neon generates it; open connections to the endpoint are dropped); ${files.join(' and ')} (0600) ` +
      `with the new passwords; check each role logs in with its file.`,
  );
  deps.log(
    `Every run resets both passwords and replaces both files: the old passwords stop working at once. A Hyperdrive config ` +
      `created from an older file must be re-created afterwards (usage-setup ${m.name} hyperdrive; docs/operations.md "Usage capture" step 3).`,
  );
  if (!apply) return void deps.log(DRY_RUN_LINE);

  const api = new NeonApi(key, { fetch: deps.fetch, sleep: deps.sleep, log: deps.log }, [owner, ownerPassword]);
  const urls: string[] = [];
  const passwords: string[] = [];
  // Every message that leaves: the owner URL, the key, every password and role URL removed.
  const fail = (e: unknown): never => {
    throw new Error(scrub(redact(e instanceof Error ? e.message : String(e), owner), [key, ownerPassword, ...urls, ...passwords]));
  };

  try {
    // The owner URL's endpoint must be this branch's: otherwise the resets change another branch's roles.
    const hosts = await api.branchEndpointHosts(projectId, branchId);
    if (!hosts.includes(host)) {
      throw new Error(`the endpoint of DATABASE_URL_DIRECT (${host}) is not one of branch ${branchId}'s (${hosts.join(', ') || 'none'}); check project_id, branch_id and the URLs in ${shown('neon.json')}`);
    }
  } catch (e) {
    fail(e);
  }

  let db: Conn | undefined;
  try {
    db = await deps.connect(owner);
    const found = (await db.query<{ rolname: string }>('SELECT rolname FROM pg_roles WHERE rolname = ANY($1::text[])', [[...ROLES]])).map((r) => r.rolname);
    const missing = ROLES.filter((r) => !found.includes(r));
    if (missing.length) throw new Error(`role ${missing.join(' and ')} doesn't exist on ${m.name}'s ledger: run usage-migrate ${m.name} --yes first`);
    await db.exec('BEGIN');
    // LOGIN with a throwaway password (D403 as amended 2026-11-05): Neon's reset refuses a role that has no password
    // (`ROLE_PASSWORD_NOT_AVAILABLE`), and Neon takes only plain-text passwords in SQL. The throwaway is random, never
    // stored or printed, and dead within seconds, when the reset below replaces it with Neon's own.
    for (const role of ROLES) {
      const raw = deps.randomBytes(32);
      if (raw.length !== 32) throw new Error('randomBytes returned the wrong length');
      const throwaway = Buffer.from(raw).toString('hex');
      raw.fill(0);
      passwords.push(throwaway);
      await db.exec(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${throwaway}'`);
    }
    await db.exec('COMMIT');
  } catch (e) {
    await db?.exec('ROLLBACK').catch(() => undefined);
    await db?.close().catch(() => undefined);
    fail(e);
  }
  // A reset drops the endpoint's open connections: this one is closed first.
  await db?.close().catch(() => undefined);

  // Roles whose reset has happened (Neon answered a password): the throwaway is dead for them.
  const reset = new Set<LedgerRole>();
  for (const [i, role] of ROLES.entries()) {
    try {
      const { password, operations } = await api.resetRolePassword(projectId, branchId, role);
      reset.add(role);
      passwords.push(password);
      const why = rolePasswordProblem(password);
      if (why) throw new Error(`Neon returned a password for ${role} this script can't use (${why}; not shown)`);
      const url = roleUrl(owner, role, password);
      urls.push(url);
      // On disk before anything else: Neon answers the password only once.
      writeSecretText(join(dir, ROLE_FILES[role]), `${url}\n`);
      deps.log(`Reset ${role}'s password; wrote ${shown(ROLE_FILES[role])} (0600, value not shown).`);
      await api.waitForOperations(projectId, operations, `${role}'s reset`);
    } catch (e) {
      const done = ROLES.slice(0, i);
      const note = done.length ? ` (${done.join(' and ')} already reset, its file written)` : '';
      // The roles not reset still have LOGIN with the throwaway password: take LOGIN away again (D411).
      const lock = await lockRoles(owner, ROLES.filter((r) => !reset.has(r)), deps, (x) => scrub(redact(x, owner), [key, ownerPassword, ...urls, ...passwords]));
      fail(new Error(`${e instanceof Error ? e.message : String(e)}${note}. Running roles --yes again resets both.${lock ? ` ${lock}` : ''}`));
    }
  }

  // Each role logs in with the password in its file: that file is what Hyperdrive gets.
  for (const role of ROLES) {
    let conn: Conn | undefined;
    try {
      const { url } = readRoleUrl(join(dir, ROLE_FILES[role]), role, shown(ROLE_FILES[role]));
      conn = await deps.connect(url);
      const [row] = await conn.query<{ who: string }>('SELECT current_user AS who');
      if (row?.who !== role) throw new Error(`logged in as ${String(row?.who)}, not ${role}`);
    } catch (e) {
      await conn?.close().catch(() => undefined);
      fail(new Error(`${role} can't log in with the password in ${shown(ROLE_FILES[role])}: ${e instanceof Error ? e.message : String(e)}`));
    }
    await conn?.close().catch(() => undefined);
  }
  deps.log(
    `${ROLES.join(' and ')} log in on ${m.name}'s ledger with the new passwords. Next: usage-setup ${m.name} hyperdrive ` +
      `(a config made from the old files is deleted and created again first; docs/operations.md "Usage capture" step 3).`,
  );
}
