// usage-setup's body (batch C4, docs/batch-c-spec.md "Bindings": Hyperdrive; "uid"): what the usage ledger's
// Workers need besides the schema (usage-migrate), for one testnet env.
//
//   roles        give `usage_writer` and `usage_admin` LOGIN and a generated password each, as the owner over the
//                direct URL from .secrets/<env>/neon.json; keep each role's URL in .secrets/<env>/neon-usage-*.url
//   hyperdrive   create the two Hyperdrive configs (caching disabled) from those URLs and print their ids (not secret)
//   user-id-key  generate USER_ID_KEY (32 random bytes, base64) into .secrets/<env>/user-id-key and set it as the
//                API Worker's secret through wrangler's stdin
//
// Every command prints its plan and changes nothing without --yes, and each can be run again: `roles` reuses the
// passwords already in the files (it only generates a missing one), `user-id-key` never replaces the key file (a new
// key would make every user a new user, D96) and sets the existing one again. Nothing prints a password, a URL or the
// key; the role passwords reach Neon only as SCRAM-SHA-256 verifiers (never as plain text in a statement).
import { spawnSync } from 'node:child_process';
import { createHash, createHmac, pbkdf2Sync, randomBytes as nodeRandomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { CliError, parseCli } from './cli.ts';
import { FILE_MODE, assertPrivate, ensureSecretDir, secretsDir } from './secrets.ts';
import { ownerUrlProblem, redact, type SqlConn } from './usage-migrate.ts';
import { DRY_RUN_LINE, writeNewSecretFile } from './vault-kek.ts';

export const USAGE_SETUP_USAGE = `Usage: usage-setup.ts <env> <roles | hyperdrive | user-id-key> [--yes]
  roles        LOGIN and a generated password for usage_writer and usage_admin (as the Neon owner, over
               DATABASE_URL_DIRECT from .secrets/<env>/neon.json); writes .secrets/<env>/neon-usage-writer.url and
               neon-usage-admin.url (0600). Re-running reuses the passwords in those files.
  hyperdrive   creates the Hyperdrive configs hana-id-usage-writer-<env> and hana-id-usage-admin-<env> (or the
               manifest's usage block names), caching disabled, from those files; prints their ids for
               \`gen --usage-hyperdrive-id\` (the writer's) and the admin Worker (batch C8)
  user-id-key  generates USER_ID_KEY into .secrets/<env>/user-id-key (0600, never replaced) and sets it on the API
               Worker; make an offline backup of the file
  --yes        do it (without it, only print the plan)

Testnet envs only. Never prints a password, a URL or the key.`;

export const ROLES = ['usage_writer', 'usage_admin'] as const;
export type LedgerRole = (typeof ROLES)[number];
export const ROLE_FILES: Record<LedgerRole, string> = { usage_writer: 'neon-usage-writer.url', usage_admin: 'neon-usage-admin.url' };
export const USER_ID_KEY_FILE = 'user-id-key';
const USER_ID_KEY_RE = /^[A-Za-z0-9+/]{43}=$/u;
const PASSWORD_RE = /^[A-Za-z0-9_-]{43}$/u;
const HYPERDRIVE_ID_RE = /\b[0-9a-f]{32}\b/u;
/** Postgres's default for SCRAM-SHA-256 verifiers (scram_iterations). */
export const SCRAM_ITERATIONS = 4096;

export interface WranglerResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface UsageSetupDeps {
  /** .secrets/<env>/neon.json, read with the 0600 check; undefined when absent. */
  readNeonSecrets(env: string): { DATABASE_URL_DIRECT?: unknown } | undefined;
  /** Opens the owner's connection. */
  connect(url: string): Promise<SqlConn & { close(): Promise<void> }>;
  /** Runs `wrangler <args>` from apps/api (stdin `input`); output captured, never echoed by this function. */
  wrangler(args: string[], input?: string): WranglerResult;
  randomBytes(n: number): Uint8Array;
  log(line: string): void;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
}

const apiDir = join(repoRoot, 'apps', 'api');

export function defaultUsageSetupDeps(connect: UsageSetupDeps['connect'], readNeonSecrets: UsageSetupDeps['readNeonSecrets']): UsageSetupDeps {
  return {
    readNeonSecrets,
    connect,
    wrangler: (args, input) => {
      const res = spawnSync('pnpm', ['exec', 'wrangler', ...args], { cwd: apiDir, input, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
      if (res.error) throw res.error;
      return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
    },
    randomBytes: (n) => new Uint8Array(nodeRandomBytes(n)),
    log: (line) => console.log(line),
  };
}

/**
 * A SCRAM-SHA-256 verifier for `password` (RFC 5802/7677, as Postgres stores it in pg_authid): `ALTER ROLE … PASSWORD`
 * with it sets the password without sending it. `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`, base64.
 */
export function scramVerifier(password: string, salt: Uint8Array, iterations = SCRAM_ITERATIONS): string {
  const salted = pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = createHash('sha256').update(clientKey).digest();
  const serverKey = createHmac('sha256', salted).update('Server Key').digest();
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64');
  return `SCRAM-SHA-256$${iterations}:${b64(salt)}$${b64(storedKey)}:${b64(serverKey)}`;
}

/** A role's URL: the owner's direct endpoint and database, TLS required, as the role (Hyperdrive pools for it). */
export function roleUrl(ownerUrl: string, role: LedgerRole, password: string): string {
  const u = new URL(ownerUrl);
  u.username = role;
  u.password = password;
  // Only TLS: the owner URL's other options (e.g. Neon's channel_binding) are for its own client.
  u.search = '';
  u.searchParams.set('sslmode', 'require');
  return u.toString();
}

/** A role's URL from its file: 0600, the role's name, a generated password, on the owner's Neon endpoint. */
export function readRoleUrl(file: string, role: LedgerRole, shown: string): { url: string; password: string } {
  assertPrivate(file);
  const url = readFileSync(file, 'utf8').trim();
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`${shown} is not a URL`);
  }
  const password = decodeURIComponent(u.password);
  if (u.username !== role || !PASSWORD_RE.test(password)) throw new Error(`${shown} is not a ${role} URL written by usage-setup roles`);
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

/** The Hyperdrive config names: the manifest's `usage` block when it has one, else the spec's defaults. */
export function hyperdriveNames(m: Pick<Manifest, 'name' | 'usage'>): Record<LedgerRole, string> {
  return {
    usage_writer: m.usage?.writerHyperdrive ?? `hana-id-usage-writer-${m.name}`,
    usage_admin: m.usage?.adminHyperdrive ?? `hana-id-usage-admin-${m.name}`,
  };
}

/** Runs `usage-setup <argv>`. */
export async function usageSetup(argv: readonly string[], deps: UsageSetupDeps): Promise<void> {
  const args = parseCli(argv, { booleans: ['yes', 'help'] });
  if (args.flag('help')) return void deps.log(USAGE_SETUP_USAGE);
  const [envName, command, ...rest] = args.positionals;
  if (!envName || !command) throw new CliError('Expected <env> <roles | hyperdrive | user-id-key>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  if (command !== 'roles' && command !== 'hyperdrive' && command !== 'user-id-key') throw new CliError(`Unknown command ${command}`);
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

  if (command === 'hyperdrive') {
    const names = hyperdriveNames(m);
    const urls = ROLES.map((role) => ({ role, ...readRoleUrl(join(dir, ROLE_FILES[role]), role, shown(ROLE_FILES[role])) }));
    deps.log(`Plan (env ${m.name}): create Hyperdrive configs ${ROLES.map((r) => names[r]).join(' and ')} (caching disabled) from ${ROLES.map((r) => shown(ROLE_FILES[r])).join(' and ')}.`);
    if (!apply) return void deps.log(DRY_RUN_LINE);
    for (const { role, url } of urls) {
      const res = deps.wrangler(['hyperdrive', 'create', names[role], `--connection-string=${url}`, '--caching-disabled']);
      // wrangler echoes the origin (host, user); only the id is printed, and an error has the URL and password removed.
      const out = redact(`${res.stdout}\n${res.stderr}`, url);
      if (res.status !== 0) throw new Error(`wrangler hyperdrive create ${names[role]} failed (exit ${res.status}): ${out.trim().split('\n').slice(-3).join(' ').slice(0, 400)}`);
      const id = HYPERDRIVE_ID_RE.exec(res.stdout)?.[0];
      if (!id) throw new Error(`wrangler hyperdrive create ${names[role]} printed no config id; find it with \`wrangler hyperdrive list\``);
      deps.log(`${names[role]} (${role}): ${id}`);
    }
    return void deps.log('Pass the writer id to the API: corepack pnpm --filter @hana-id/api gen <env> --usage-hyperdrive-id <id>.');
  }

  // roles
  const owner = deps.readNeonSecrets(m.name)?.DATABASE_URL_DIRECT;
  if (typeof owner !== 'string') throw new Error(`${shown('neon.json')} has no DATABASE_URL_DIRECT (docs/operations.md "Usage ledger")`);
  const problem = ownerUrlProblem(owner);
  if (problem) throw new Error(`DATABASE_URL_DIRECT in ${shown('neon.json')} ${problem}`);
  const existing = ROLES.filter((r) => existsSync(join(dir, ROLE_FILES[r])));
  deps.log(
    `Plan (env ${m.name}): ${ROLES.map((r) => (existing.includes(r) ? `reuse the password in ${shown(ROLE_FILES[r])}` : `generate a password for ${r} into ${shown(ROLE_FILES[r])} (0600)`)).join('; ')}; ` +
      `then, as the owner, ALTER ROLE … LOGIN PASSWORD (a SCRAM verifier) for ${ROLES.join(' and ')}.`,
  );
  if (!apply) return void deps.log(DRY_RUN_LINE);
  const passwords = {} as Record<LedgerRole, string>;
  for (const role of ROLES) {
    const file = join(dir, ROLE_FILES[role]);
    if (existsSync(file)) {
      passwords[role] = readRoleUrl(file, role, shown(ROLE_FILES[role])).password;
      continue;
    }
    const raw = deps.randomBytes(32);
    if (raw.length !== 32) throw new Error('randomBytes returned the wrong length');
    passwords[role] = Buffer.from(raw).toString('base64url');
    raw.fill(0);
    // On disk before Neon has it: a stop in between is resumed by running roles again.
    writeSecretText(file, `${roleUrl(owner, role, passwords[role])}\n`);
    deps.log(`Wrote ${shown(ROLE_FILES[role])} (0600, value not shown).`);
  }
  let db: (SqlConn & { close(): Promise<void> }) | undefined;
  try {
    db = await deps.connect(owner);
    await db.exec('BEGIN');
    for (const role of ROLES) {
      const verifier = scramVerifier(passwords[role], deps.randomBytes(16));
      // The verifier is base64 and `$:` only: no quote can end the literal.
      await db.exec(`ALTER ROLE ${role} WITH LOGIN PASSWORD '${verifier}'`);
    }
    await db.exec('COMMIT');
  } catch (e) {
    await db?.exec('ROLLBACK').catch(() => undefined);
    let message = redact(e instanceof Error ? e.message : String(e), owner);
    for (const role of ROLES) message = message.split(passwords[role]).join('<password>');
    // A driver may quote the statement: its verifier is a password hash.
    message = message.replace(/SCRAM-SHA-256\$[^'\s]*/gu, '<verifier>');
    throw new Error(message);
  } finally {
    await db?.close().catch(() => undefined);
  }
  deps.log(`${ROLES.join(' and ')} can now log in on ${m.name}'s ledger. Next: usage-setup ${m.name} hyperdrive.`);
}
