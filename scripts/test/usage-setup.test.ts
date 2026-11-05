// usage-setup roles / hyperdrive / user-id-key against a temp .secrets root, PGlite as the Neon owner (D140), a fake
// Neon API (fetch) and a fake wrangler: the --yes gate, file modes, the API key file's checks, passwords Neon generates
// written to the role files (replaced on a re-run), the busy-retry and operation polling, a role whose reset didn't
// happen set NOLOGIN again, the Hyperdrive configs created through a fake Cloudflare API with the password only in the
// HTTPS body (D412), and that no password, URL or key ever reaches the output, an argument or an error (D403).
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite, type PGliteInterface } from '@electric-sql/pglite';
import { type Manifest, loadEnv, repoRoot } from '@hana-id/env';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CliError } from '../lib/cli.ts';
import { NEON_API, NEON_API_KEY_FILE } from '../lib/neon-api.ts';
import { applyMigrations, readMigrations, type SqlConn } from '../lib/usage-migrate.ts';
import { CLOUDFLARE_API } from '../lib/cloudflare-api.ts';
import { CLOUDFLARE_HYPERDRIVE_TOKEN_FILE, ROLE_FILES, USER_ID_KEY_FILE, type UsageSetupDeps, type WranglerResult, hyperdriveBody, hyperdriveNames, readRoleUrl, rolePasswordProblem, roleUrl, usageSetup } from '../lib/usage-setup.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';
import { PGLITE, PGLITE_HOOK_MS } from './pglite.ts';

const m: Manifest = { ...loadEnv('sandbox-dev'), name: 'usage-test', cloudflare: { workerName: 'hana-id-api-usage-test', d1Name: 'hana-id-usage-test' } };
// Placeholders of the shapes Neon gives (not a real endpoint, id, key or password).
const HOST = 'ep-quiet-sky-a1b2c3d4.ap-southeast-2.aws.neon.tech';
const OWNER = `postgresql://neondb_owner:owner-pw-not-real@${HOST}/neondb?sslmode=require&channel_binding=require`;
const PROJECT = 'quiet-sky-12345678';
const BRANCH = 'br-quiet-sky-a1b2c3d4';
const API_KEY = 'napi_not-a-real-key-0123456789abcdefghijklmnop';
const mode = (p: string) => statSync(p).mode & 0o777;
type Role = keyof typeof ROLE_FILES;
const ROLE_NAMES: Role[] = ['usage_writer', 'usage_admin'];

let root: string;
let dir: string;
let out: string[];
let calls: { args: string[]; input?: string }[];
let wranglerReply: (args: string[]) => WranglerResult;
/** The owner's ledger, migrated once (./pglite.ts). */
let template: PGlite;
/** This test's clone of it, made when the test first reaches the owner's database (not every test does). */
let ownerDb: Promise<PGliteInterface> | undefined;
const db = (): Promise<PGliteInterface> => (ownerDb ??= template.clone());
let ownerConnects: number;
let roleLogins: string[];
let seed: number;
let resets: number;
/** The password Neon "set" for each role (what a role login is checked against). */
let neonPasswords: Partial<Record<Role, string>>;
let requests: { method: string; url: string; auth: string | null }[];
let sleeps: number[];
/** Overrides the fake Neon API's answer for a request; undefined falls through to the default. */
let neonOverride: (method: string, path: string) => Response | Promise<Response> | undefined;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const op = (id: string, status: string) => ({ id, project_id: PROJECT, branch_id: BRANCH, endpoint_id: 'ep-quiet-sky-a1b2c3d4', action: 'apply_config', status, failures_count: 0 });
const pw = (n: number) => `npg_FakePw${String(n).padStart(4, '0')}notreal`;

/** Neon's API as far as roles uses it: endpoints, reset_password (a new password and one running op), operations. */
async function fakeNeon(url: string, init: RequestInit): Promise<Response> {
  const method = init.method ?? 'GET';
  const auth = new Headers(init.headers).get('authorization');
  requests.push({ method, url, auth });
  expect(url.startsWith(NEON_API)).toBe(true);
  expect(init.redirect).toBe('error');
  const path = url.slice(NEON_API.length);
  const over = await neonOverride(method, path);
  if (over) return over;
  if (auth !== `Bearer ${API_KEY}`) return json(401, { code: '', message: 'authorization failed' });
  if (method === 'GET' && path === `/projects/${PROJECT}/branches/${BRANCH}/endpoints`) {
    return json(200, { endpoints: [{ id: 'ep-quiet-sky-a1b2c3d4', host: HOST, branch_id: BRANCH, type: 'read_write' }] });
  }
  const reset = new RegExp(`^/projects/${PROJECT}/branches/${BRANCH}/roles/([a-z_]+)/reset_password$`, 'u').exec(path);
  if (method === 'POST' && reset) {
    const role = reset[1] as Role;
    if (!ROLE_NAMES.includes(role)) return json(404, { code: '', message: 'role not found' });
    const password = pw(++resets);
    neonPasswords[role] = password;
    return json(200, { role: { branch_id: BRANCH, name: role, password, protected: false }, operations: [op(`op-${resets}`, 'running')] });
  }
  const opm = new RegExp(`^/projects/${PROJECT}/operations/(op-\\d+)$`, 'u').exec(path);
  if (method === 'GET' && opm) return json(200, { operation: op(opm[1]!, 'finished') });
  return json(404, { code: '', message: `no route ${method} ${path}` });
}

const pgConn = (get: () => Promise<PGliteInterface>): SqlConn & { close(): Promise<void> } => ({
  exec: async (sql) => void (await (await get()).exec(sql)),
  query: async <T>(sql: string, params: unknown[] = []) => (await (await get()).query<T>(sql, params)).rows,
  close: async () => undefined,
});

/** The owner gets PGlite; a role URL logs in only with the password Neon last set for it. */
async function connect(url: string): Promise<SqlConn & { close(): Promise<void> }> {
  if (url === OWNER) {
    ownerConnects++;
    return pgConn(db);
  }
  const u = new URL(url);
  const role = u.username as Role;
  expect(u.host).toBe(HOST);
  if (!neonPasswords[role] || decodeURIComponent(u.password) !== neonPasswords[role]) throw new Error(`password authentication failed for user "${role}" (${url})`);
  roleLogins.push(role);
  return { exec: async () => undefined, query: async <T>() => [{ who: role }] as T[], close: async () => undefined };
}

const deps = (over: Partial<UsageSetupDeps> = {}): UsageSetupDeps => ({
  readNeonSecrets: () => ({ DATABASE_URL_DIRECT: OWNER, project_id: PROJECT, branch_id: BRANCH }),
  connect,
  fetch: fakeNeon,
  sleep: async (ms) => void sleeps.push(ms),
  wrangler: (args, input) => {
    calls.push({ args, input });
    return wranglerReply(args);
  },
  // Distinct, deterministic bytes per call.
  randomBytes: (n) => Uint8Array.from({ length: n }, (_, i) => (seed * 37 + i * 11) % 256).map((b, i) => (i === 0 ? ++seed % 256 : b)),
  log: (line) => out.push(line),
  secretsRoot: root,
  loadManifest: (name) => {
    if (name !== m.name) throw new Error(`No manifest ${name}`);
    return m;
  },
  ...over,
});
const run = (argv: string[], over: Partial<UsageSetupDeps> = {}) => usageSetup([m.name, ...argv], deps(over));
const printed = () => out.join('\n');
const writeKey = (value = API_KEY, fileMode = 0o600) => {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, NEON_API_KEY_FILE), `${value}\n`, { mode: fileMode });
  chmodSync(join(dir, NEON_API_KEY_FILE), fileMode);
};
const fileUrl = (role: Role) => new URL(readFileSync(join(dir, ROLE_FILES[role]), 'utf8').trim());
const filePassword = (role: Role) => decodeURIComponent(fileUrl(role).password);
const canLogin = async (role: string) => (await (await db()).query<{ rolcanlogin: boolean }>('SELECT rolcanlogin FROM pg_roles WHERE rolname = $1', [role])).rows[0]?.rolcanlogin;
/** Everything that must never be printed or thrown: the key, the owner's password, every password Neon handed out. */
const secrets = () => [API_KEY, 'owner-pw-not-real', ...Object.values(neonPasswords)];
const expectClean = (text: string) => {
  for (const s of secrets()) expect(text).not.toContain(s);
  expect(text).not.toMatch(/postgres(ql)?:\/\//u);
};

let stdout: string[];
beforeAll(async () => {
  template = new PGlite();
  await applyMigrations(pgConn(async () => template), readMigrations(join(repoRoot, 'apps', 'api', 'migrations-usage')));
}, PGLITE_HOOK_MS);
afterAll(async () => {
  await template.close();
}, PGLITE_HOOK_MS);
beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'usage-setup-'));
  dir = join(root, '.secrets', m.name);
  out = [];
  calls = [];
  ownerConnects = 0;
  roleLogins = [];
  seed = 1;
  resets = 0;
  neonPasswords = {};
  requests = [];
  sleeps = [];
  neonOverride = () => undefined;
  wranglerReply = () => ({ status: 0, stdout: '', stderr: '' });
  // The process's own stdout and stderr too: nothing may bypass deps.log.
  stdout = [];
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => (stdout.push(String(chunk)), true));
});
afterEach(async () => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  await (await ownerDb)?.close();
  ownerDb = undefined;
}, PGLITE_HOOK_MS);

describe('usage-setup roles', PGLITE, () => {
  it('prints its plan (replace, the Hyperdrive warning) and changes nothing without --yes', async () => {
    writeKey();
    await run(['roles']);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(printed()).toContain(`Neon project ${PROJECT}, branch ${BRANCH}, endpoint ${HOST}`);
    expect(printed()).toContain(`write .secrets/${m.name}/neon-usage-writer.url`);
    expect(printed()).toMatch(/Every run resets both passwords and replaces both files/u);
    expect(printed()).toMatch(/Hyperdrive config created from an older file must be re-created/u);
    expect(requests).toEqual([]);
    expect(ownerConnects).toBe(0);
    expect(existsSync(join(dir, ROLE_FILES.usage_writer))).toBe(false);
    expect(await canLogin('usage_writer')).toBe(false);
    // With the files there, the plan says they are replaced.
    writeFileSync(join(dir, ROLE_FILES.usage_writer), 'old\n', { mode: 0o600 });
    out = [];
    await run(['roles']);
    expect(printed()).toContain(`REPLACE .secrets/${m.name}/neon-usage-writer.url`);
    expect(readFileSync(join(dir, ROLE_FILES.usage_writer), 'utf8')).toBe('old\n');
    expectClean(printed() + stdout.join(''));
  });

  it('gives both roles LOGIN, has Neon reset each password, writes it to the role file (0600), checks the logins; prints none of it', async () => {
    writeKey();
    await run(['roles', '--yes']);
    expect(mode(dir)).toBe(0o700);
    // Endpoint check, then per role: the reset, then its operation polled until finished.
    expect(requests.map((r) => `${r.method} ${r.url.slice(NEON_API.length)}`)).toEqual([
      `GET /projects/${PROJECT}/branches/${BRANCH}/endpoints`,
      `POST /projects/${PROJECT}/branches/${BRANCH}/roles/usage_writer/reset_password`,
      `GET /projects/${PROJECT}/operations/op-1`,
      `POST /projects/${PROJECT}/branches/${BRANCH}/roles/usage_admin/reset_password`,
      `GET /projects/${PROJECT}/operations/op-2`,
    ]);
    expect(requests.every((r) => r.auth === `Bearer ${API_KEY}`)).toBe(true);
    for (const role of ROLE_NAMES) {
      expect(mode(join(dir, ROLE_FILES[role]))).toBe(0o600);
      const u = fileUrl(role);
      const owner = new URL(OWNER);
      expect([u.protocol, u.username, u.host, u.pathname, u.search]).toEqual(['postgresql:', role, owner.host, owner.pathname, '?sslmode=require']);
      expect(filePassword(role)).toBe(neonPasswords[role]);
      expect(await canLogin(role)).toBe(true);
    }
    // SQL set only a throwaway (Neon's reset needs a role with a password, D403 amended); the files hold Neon's
    // passwords, never the throwaway, and the throwaway is printed nowhere.
    expect((await (await db()).query<{ n: number }>("SELECT count(*)::int AS n FROM pg_authid WHERE rolname LIKE 'usage_%' AND rolpassword IS NOT NULL")).rows[0]!.n).toBe(2);
    for (const role of ROLE_NAMES) {
      const stored = (await (await db()).query<{ p: string }>('SELECT rolpassword AS p FROM pg_authid WHERE rolname = $1', [role])).rows[0]!.p;
      expect(stored).toMatch(/^(SCRAM-SHA-256\$|md5)/u); // PGlite keeps a hash of the throwaway, not Neon's password
      expect(filePassword(role)).not.toMatch(/^[0-9a-f]{64}$/u);
    }
    expect(printed() + stdout.join('')).not.toMatch(/[0-9a-f]{64}/u);
    expect(roleLogins).toEqual(ROLE_NAMES);
    expect(filePassword('usage_writer')).not.toBe(filePassword('usage_admin'));
    expect(printed()).toMatch(/log in on usage-test's ledger with the new passwords/u);
    expectClean(printed() + stdout.join(''));
  });

  it('a re-run resets both again and replaces both files', async () => {
    writeKey();
    await run(['roles', '--yes']);
    const first = ROLE_NAMES.map(filePassword);
    await run(['roles', '--yes']);
    const second = ROLE_NAMES.map(filePassword);
    expect(second).toEqual([neonPasswords.usage_writer, neonPasswords.usage_admin]);
    expect(second[0]).not.toBe(first[0]);
    expect(second[1]).not.toBe(first[1]);
    for (const role of ROLE_NAMES) expect(mode(join(dir, ROLE_FILES[role]))).toBe(0o600);
    // No temp files left beside them.
    expect(readdirSync(dir).sort()).toEqual([NEON_API_KEY_FILE, ROLE_FILES.usage_admin, ROLE_FILES.usage_writer].sort());
  });

  it('refuses a missing, loose, empty or two-line API key file, naming the file and never the value', async () => {
    const key = `.secrets/${m.name}/${NEON_API_KEY_FILE}`;
    const err = await run(['roles']).catch((e: Error) => e);
    expect(String(err)).toContain(`${key} is missing`);
    expect(String(err)).toContain(`umask 077; pbpaste > ${key}`);
    writeKey(API_KEY, 0o644);
    await expect(run(['roles', '--yes'])).rejects.toThrow(/mode 644; it must be 0600/u);
    writeKey(API_KEY, 0o640);
    await expect(run(['roles'])).rejects.toThrow(/mode 640/u);
    writeKey('', 0o600);
    await expect(run(['roles', '--yes'])).rejects.toThrow(/is empty/u);
    writeKey(`${API_KEY}\nsecond line`, 0o600);
    const two = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(two)).toMatch(/doesn't hold one API key/u);
    expect(String(two)).not.toContain(API_KEY);
    expect(requests).toEqual([]);
    expect(ownerConnects).toBe(0);
  });

  it('refuses a missing or wrong owner URL, project_id or branch_id, a non-testnet env, a bad command', async () => {
    writeKey();
    const neon = { DATABASE_URL_DIRECT: OWNER, project_id: PROJECT, branch_id: BRANCH };
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => undefined })).rejects.toThrow(/no DATABASE_URL_DIRECT/u);
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => ({ ...neon, DATABASE_URL_DIRECT: OWNER.replace('ep-quiet-sky-a1b2c3d4', 'ep-quiet-sky-a1b2c3d4-pooler') }) })).rejects.toThrow(/direct endpoint/u);
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => ({ ...neon, project_id: undefined }) })).rejects.toThrow(/no valid project_id/u);
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => ({ ...neon, project_id: '../x' }) })).rejects.toThrow(/no valid project_id/u);
    await expect(run(['roles', '--yes'], { readNeonSecrets: () => ({ ...neon, branch_id: 'production' }) })).rejects.toThrow(/no valid branch_id/u);
    await expect(usageSetup(['mainnet-x', 'roles'], deps({ loadManifest: () => ({ ...m, name: 'mainnet-x', network: 'mainnet' }) as unknown as Manifest }))).rejects.toThrow(/not a testnet env/u);
    await expect(run(['nope'])).rejects.toBeInstanceOf(CliError);
    await expect(run([])).rejects.toBeInstanceOf(CliError);
    expect(requests).toEqual([]);
  });

  it('refuses an owner endpoint that is not the branch’s, before any change', async () => {
    writeKey();
    neonOverride = (method, path) => (path.endsWith('/endpoints') ? json(200, { endpoints: [{ host: 'ep-other-a9.ap-southeast-2.aws.neon.tech' }] }) : undefined);
    await expect(run(['roles', '--yes'])).rejects.toThrow(/is not one of branch br-quiet-sky-a1b2c3d4's \(ep-other-a9/u);
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(ownerConnects).toBe(0);
    expect(await canLogin('usage_writer')).toBe(false);
  });

  it('refuses when the roles don’t exist yet (usage-migrate first), resetting nothing', async () => {
    writeKey();
    await (await db()).exec('DROP OWNED BY usage_admin; DROP ROLE usage_admin');
    await expect(run(['roles', '--yes'])).rejects.toThrow(/role usage_admin doesn't exist on usage-test's ledger: run usage-migrate usage-test --yes first/u);
    expect(requests.filter((r) => r.method === 'POST')).toEqual([]);
    expect(await canLogin('usage_writer')).toBe(false);
  });

  it('a 4xx or 5xx gives the status and Neon’s code and message only, scrubbed; no file is written', async () => {
    writeKey();
    // A role Neon doesn't know (e.g. not synced to its control plane).
    neonOverride = (method) => (method === 'POST' ? json(404, { code: 'ROLE_NOT_FOUND', message: 'role usage_writer not found' }) : undefined);
    const notFound = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(notFound)).toMatch(/resetting usage_writer's password answered HTTP 404 \(ROLE_NOT_FOUND: role usage_writer not found\): not found \(check project_id and branch_id/u);
    expect(existsSync(join(dir, ROLE_FILES.usage_writer))).toBe(false);
    // A 500 whose message quotes the key and the owner's password, plus other fields: only code and message, scrubbed.
    neonOverride = (method) => (method === 'POST' ? json(500, { code: 'INTERNAL', message: `boom ${API_KEY} owner-pw-not-real`, request_id: 'r1', password: 'npg_bodyFieldNotShown' }) : undefined);
    const e500 = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(e500)).toMatch(/answered HTTP 500 \(INTERNAL: boom <redacted> <redacted>\)/u);
    expect(String(e500)).not.toMatch(/npg_bodyFieldNotShown|r1/u);
    // A body that isn't JSON is never shown.
    neonOverride = (method) => (method === 'POST' ? new Response('<html>npg_htmlNotShown</html>', { status: 502 }) : undefined);
    const e502 = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(e502)).toMatch(/answered HTTP 502\. Running roles --yes again/u);
    expect(String(e502)).not.toContain('npg_htmlNotShown');
    // A refused key.
    neonOverride = () => json(401, { code: '', message: 'authorization failed' });
    await expect(run(['roles', '--yes'])).rejects.toThrow(/HTTP 401 \(authorization failed\): the API key was refused/u);
    for (const e of [notFound, e500, e502]) expectClean(String(e));
    expect(existsSync(join(dir, ROLE_FILES.usage_writer))).toBe(false);
    expect(existsSync(join(dir, ROLE_FILES.usage_admin))).toBe(false);
    expectClean(printed() + stdout.join(''));
  });

  it('a success body without a password, or with one it can’t use, is refused without showing the body', async () => {
    writeKey();
    neonOverride = (method) => (method === 'POST' ? json(200, { role: { name: 'usage_writer' }, operations: [], note: 'npg_elsewhereNotShown' }) : undefined);
    const none = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(none)).toMatch(/has no password for usage_writer \(body not shown\)/u);
    expect(String(none)).not.toContain('npg_elsewhereNotShown');
    neonOverride = (method) => (method === 'POST' ? json(200, { role: { name: 'usage_writer', password: 'short pw' }, operations: [] }) : undefined);
    const bad = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(bad)).toMatch(/can't use \(not 12–512 characters; not shown\)/u);
    expect(String(bad)).not.toContain('short pw');
    expect(existsSync(join(dir, ROLE_FILES.usage_writer))).toBe(false);
  });

  it('retries a busy answer (423, 409, 503) politely, polls a running operation until it finishes', async () => {
    writeKey();
    let busy = 0;
    let polls = 0;
    neonOverride = (method, path) => {
      if (method === 'POST' && path.includes('usage_writer') && busy < 3) return json([423, 409, 503][busy++]!, { code: 'LOCKED', message: 'project already has running operations' });
      if (method === 'GET' && path.endsWith('/op-1') && polls++ < 2) return json(200, { operation: op('op-1', polls === 1 ? 'scheduling' : 'running') });
      return undefined;
    };
    await run(['roles', '--yes']);
    expect(busy).toBe(3);
    expect(sleeps.slice(0, 3)).toEqual([2000, 4000, 6000]);
    expect(printed()).toMatch(/answered HTTP 423 \(LOCKED: project already has running operations\); trying again \(1\/7\)/u);
    expect(requests.filter((r) => r.url.endsWith('/op-1'))).toHaveLength(3);
    for (const role of ROLE_NAMES) expect(filePassword(role)).toBe(neonPasswords[role]);
    expectClean(printed() + stdout.join(''));
  });

  it('gives up on a resource that stays busy, and on a failed operation, with clear messages', async () => {
    writeKey();
    neonOverride = (method) => (method === 'POST' ? json(423, { code: 'LOCKED', message: 'locked' }) : undefined);
    await expect(run(['roles', '--yes'])).rejects.toThrow(/HTTP 423 \(LOCKED: locked\): still busy after 8 tries; wait a minute and run it again/u);
    neonOverride = (method, path) => (method === 'GET' && path.includes('/operations/') ? json(200, { operation: op('op-x', 'failed') }) : undefined);
    const failed = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(failed)).toMatch(/operation op-x \(apply_config\) of usage_writer's reset ended failed\. Running roles --yes again resets both/u);
    // The password was handed out before the operation failed: its file holds it, and the error doesn't.
    expect(filePassword('usage_writer')).toBe(neonPasswords.usage_writer);
    expectClean(String(failed));
  });

  it('a lost answer to a reset is not sent again; a failure on the second role says the first is done', async () => {
    writeKey();
    neonOverride = (method) => {
      if (method === 'POST') throw new TypeError('fetch failed');
      return undefined;
    };
    await expect(run(['roles', '--yes'])).rejects.toThrow(/got no answer \(TypeError\); Neon may or may not have applied it/u);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
    neonOverride = (method, path) => (method === 'POST' && path.includes('usage_admin') ? json(500, { code: 'X', message: 'nope' }) : undefined);
    const second = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(second)).toMatch(/\(usage_writer already reset, its file written\)\. Running roles --yes again resets both\./u);
    expectClean(String(second));
  });

  it('a failed reset after the throwaway’s COMMIT sets the roles not reset NOLOGIN again; the reset one keeps LOGIN (D412)', async () => {
    writeKey();
    neonOverride = (method, path) => (method === 'POST' && path.includes('usage_admin') ? json(500, { code: 'X', message: 'nope' }) : undefined);
    const err = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(err)).toMatch(/\(usage_writer already reset, its file written\)\. Running roles --yes again resets both\. usage_admin set NOLOGIN again \(not reset: no login until roles succeeds\)\./u);
    expect(await canLogin('usage_admin')).toBe(false);
    expect(await canLogin('usage_writer')).toBe(true);
    expectClean(String(err));
    // The first reset failing: both roles lose LOGIN.
    neonOverride = (method) => (method === 'POST' ? json(500, { code: 'X', message: 'nope' }) : undefined);
    const both = await run(['roles', '--yes']).catch((e: Error) => e);
    expect(String(both)).toMatch(/usage_writer and usage_admin set NOLOGIN again/u);
    expect([await canLogin('usage_writer'), await canLogin('usage_admin')]).toEqual([false, false]);
    // A later run that succeeds gives LOGIN back.
    neonOverride = () => undefined;
    await run(['roles', '--yes']);
    expect([await canLogin('usage_writer'), await canLogin('usage_admin')]).toEqual([true, true]);
  });

  it('when NOLOGIN can’t be set either, the error says so and how, with the owner URL and every password removed', async () => {
    writeKey();
    let owners = 0;
    const flaky = async (url: string) => {
      if (url === OWNER && ++owners > 1) throw new Error(`connection to ${OWNER} refused (password owner-pw-not-real)`);
      return connect(url);
    };
    neonOverride = (method) => (method === 'POST' ? json(500, { code: 'X', message: 'nope' }) : undefined);
    const err = await run(['roles', '--yes'], { connect: flaky }).catch((e: Error) => e);
    expect(String(err)).toMatch(/could not set usage_writer and usage_admin NOLOGIN \(connection to <url> refused/u);
    expect(String(err)).toMatch(/run ALTER ROLE usage_writer, usage_admin NOLOGIN as the owner/u);
    expectClean(String(err));
    expect(await canLogin('usage_writer')).toBe(true);
  });

  it('a role that can’t log in with its file’s password fails the run, the URL and password removed', async () => {
    writeKey();
    const wrong = async (url: string) => {
      if (url === OWNER) return connect(url);
      throw new Error(`password authentication failed for user "${new URL(url).username}" at ${url}`);
    };
    const err = await run(['roles', '--yes'], { connect: wrong }).catch((e: Error) => e);
    expect(String(err)).toMatch(/usage_writer can't log in with the password in \.secrets\/usage-test\/neon-usage-writer\.url: password authentication failed/u);
    expectClean(String(err));
  });
});

describe('rolePasswordProblem / readRoleUrl', () => {
  it('takes Neon’s passwords and the earlier 43-character ones; refuses short, spaced or control-character ones', () => {
    expect(rolePasswordProblem('npg_AbCdEfGh1234')).toBeNull();
    expect(rolePasswordProblem('A'.repeat(43))).toBeNull();
    expect(rolePasswordProblem('short')).toMatch(/12–512/u);
    expect(rolePasswordProblem('has a space in it')).toMatch(/whitespace/u);
    expect(rolePasswordProblem('tab\there-123456')).toMatch(/whitespace/u);
  });

  it('reads back a URL with a password that needs encoding', () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, ROLE_FILES.usage_writer);
    writeFileSync(file, `${roleUrl(OWNER, 'usage_writer', 'npg_a/b@c:d%e#f')}\n`, { mode: 0o600 });
    expect(readRoleUrl(file, 'usage_writer', 'f').password).toBe('npg_a/b@c:d%e#f');
  });
});

describe('usage-setup hyperdrive', PGLITE, () => {
  const ID_W = '0123456789abcdef0123456789abcdef';
  const ID_A = 'fedcba9876543210fedcba9876543210';
  const ACCOUNT = '0123456789abcdef0123456789abcdef'.split('').reverse().join('');
  const CF_TOKEN = 'cf-hyperdrive-token-not-real-0123456789abcdef';
  let cfCalls: { method: string; path: string; auth: string | null; body: Record<string, any> | undefined; init: RequestInit }[];
  let cfOverride: (method: string, path: string, body: Record<string, any> | undefined) => Response | undefined;
  const envelope = (result: unknown, status = 200) => json(status, { success: status < 300, result, errors: [], messages: [] });

  /** Cloudflare's API as hyperdrive uses it: the token's accounts, and creating a config (the password write-only). */
  async function fakeCloudflare(url: string, init: RequestInit): Promise<Response> {
    expect(url.startsWith(CLOUDFLARE_API)).toBe(true);
    expect(init.redirect).toBe('error');
    const path = url.slice(CLOUDFLARE_API.length);
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, any>) : undefined;
    cfCalls.push({ method, path, auth: new Headers(init.headers).get('authorization'), body, init });
    const over = cfOverride(method, path, body);
    if (over) return over;
    if (method === 'GET' && path.startsWith('/accounts?')) return envelope([{ id: ACCOUNT, name: 'Hana testnet' }]);
    if (method === 'POST' && path === `/accounts/${ACCOUNT}/hyperdrive/configs`) {
      const { password: _pw, ...origin } = body!.origin;
      return envelope({ id: body!.name === hyperdriveNames(m).usage_writer ? ID_W : ID_A, name: body!.name, origin, caching: body!.caching });
    }
    return json(404, { success: false, errors: [{ code: 7003, message: `no route ${method} ${path}` }] });
  }
  const writeCfToken = (value = CF_TOKEN, fileMode = 0o600) => {
    writeFileSync(join(dir, CLOUDFLARE_HYPERDRIVE_TOKEN_FILE), `${value}\n`, { mode: fileMode });
    chmodSync(join(dir, CLOUDFLARE_HYPERDRIVE_TOKEN_FILE), fileMode);
  };
  const cfDeps = { fetch: fakeCloudflare, env: {} };

  beforeEach(() => {
    cfCalls = [];
    cfOverride = () => undefined;
  });

  it('creates both configs with caching disabled through Cloudflare’s API, the password only in the HTTPS body; no wrangler, no argument; prints names and ids', async () => {
    writeKey();
    await run(['roles', '--yes']);
    out = [];
    calls = [];
    // Without the token file: refused, naming the file and the one permission.
    await expect(run(['hyperdrive'], cfDeps)).rejects.toThrow(/cloudflare-hyperdrive-token is missing: create an account API token with only "Account › Hyperdrive › Edit"/u);
    writeCfToken();
    await run(['hyperdrive'], cfDeps);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(printed()).toMatch(/in account \(the token's only account\) with \.secrets\/usage-test\/cloudflare-hyperdrive-token; each password goes only in the HTTPS body/u);
    expect(cfCalls).toEqual([]);
    await run(['hyperdrive', '--yes'], cfDeps);
    expect(calls).toEqual([]);
    expect(cfCalls.map((c) => [c.method, c.path])).toEqual([
      ['GET', '/accounts?page=1&per_page=50'],
      ['POST', `/accounts/${ACCOUNT}/hyperdrive/configs`],
      ['POST', `/accounts/${ACCOUNT}/hyperdrive/configs`],
    ]);
    for (const c of cfCalls) expect(c.auth).toBe(`Bearer ${CF_TOKEN}`);
    expect(cfCalls[1]!.body).toEqual({ name: 'hana-id-usage-writer-usage-test', origin: { scheme: 'postgres', host: HOST, port: 5432, database: 'neondb', user: 'usage_writer', password: filePassword('usage_writer') }, caching: { disabled: true } });
    expect(cfCalls[2]!.body).toMatchObject({ name: 'hana-id-usage-admin-usage-test', origin: { user: 'usage_admin', password: filePassword('usage_admin') }, caching: { disabled: true } });
    // The password is in the body only: never the URL or a header.
    for (const c of cfCalls) {
      expect(c.path).not.toContain(filePassword('usage_writer'));
      expect(JSON.stringify(c.init.headers)).not.toMatch(/npg_/u);
    }
    expect(out).toEqual(expect.arrayContaining([`hana-id-usage-writer-usage-test (usage_writer): ${ID_W}`, `hana-id-usage-admin-usage-test (usage_admin): ${ID_A}`]));
    expect(printed()).not.toMatch(/neon\.tech|postgresql:/u);
    expectClean(printed() + stdout.join(''));
    expect(printed() + stdout.join('')).not.toContain(CF_TOKEN);
  });

  it('takes the account from --account-id or the manifest without listing; refuses a malformed one and a token reaching several', async () => {
    writeKey();
    await run(['roles', '--yes']);
    writeCfToken();
    await run(['hyperdrive', '--yes', '--account-id', ACCOUNT], cfDeps);
    expect(cfCalls.map((c) => c.method)).toEqual(['POST', 'POST']);
    cfCalls = [];
    await run(['hyperdrive', '--yes'], { ...cfDeps, loadManifest: () => ({ ...m, cloudflare: { ...m.cloudflare, accountId: ACCOUNT } }) });
    expect(cfCalls.map((c) => c.method)).toEqual(['POST', 'POST']);
    await expect(run(['hyperdrive', '--yes', '--account-id', 'nope'], cfDeps)).rejects.toThrow(CliError);
    await expect(run(['roles', '--account-id', ACCOUNT], cfDeps)).rejects.toThrow(/--account-id is for hyperdrive only/u);
    cfOverride = (method) => (method === 'GET' ? envelope([{ id: ACCOUNT }, { id: ID_W }]) : undefined);
    await expect(run(['hyperdrive', '--yes'], cfDeps)).rejects.toThrow(/The token reaches 2 accounts: pass --account-id/u);
  });

  it('a refusal gives Cloudflare’s code and message with the password, URL and token removed; a taken name says how to re-create; a lost answer isn’t sent again', async () => {
    writeKey();
    await run(['roles', '--yes']);
    writeCfToken();
    const pw = filePassword('usage_writer');
    const url = fileUrl('usage_writer').toString();
    cfOverride = (method) => (method === 'POST' ? json(400, { success: false, errors: [{ code: 2008, message: `could not connect to ${url} with ${pw} (token ${CF_TOKEN})` }] }) : undefined);
    const err = await run(['hyperdrive', '--yes', '--account-id', ACCOUNT], cfDeps).catch((e: Error) => e);
    expect(String(err)).toMatch(/creating Hyperdrive config hana-id-usage-writer-usage-test answered HTTP 400 \(code 2008: could not connect to/u);
    expectClean(String(err));
    expect(String(err)).not.toContain(CF_TOKEN);
    cfOverride = (method) => (method === 'POST' ? json(409, { success: false, errors: [{ code: 2017, message: 'A Hyperdrive config with the given name already exists' }] }) : undefined);
    await expect(run(['hyperdrive', '--yes', '--account-id', ACCOUNT], cfDeps)).rejects.toThrow(/already exists: delete it .*wrangler hyperdrive delete <id>/u);
    cfCalls = [];
    cfOverride = (method) => {
      if (method === 'POST') throw new TypeError('fetch failed');
      return undefined;
    };
    await expect(run(['hyperdrive', '--yes', '--account-id', ACCOUNT], cfDeps)).rejects.toThrow(/got no answer \(TypeError\); Cloudflare may or may not have applied it/u);
    expect(cfCalls.filter((c) => c.method === 'POST')).toHaveLength(1);
    // Success without a config id: refused, never a guessed id.
    cfOverride = (method) => (method === 'POST' ? envelope({ name: 'x' }) : undefined);
    await expect(run(['hyperdrive', '--yes', '--account-id', ACCOUNT], cfDeps)).rejects.toThrow(/answered no config id/u);
  });

  it('refuses without the role files, a loosened role or token file', async () => {
    await expect(run(['hyperdrive', '--yes'], cfDeps)).rejects.toThrow();
    writeKey();
    await run(['roles', '--yes']);
    writeCfToken(CF_TOKEN, 0o644);
    await expect(run(['hyperdrive', '--yes'], cfDeps)).rejects.toThrow(/0600/u);
    writeCfToken();
    chmodSync(join(dir, ROLE_FILES.usage_admin), 0o644);
    await expect(run(['hyperdrive', '--yes'], cfDeps)).rejects.toThrow(/0600/u);
    expect(cfCalls).toEqual([]);
  });

  it('the body: the URL’s host, port, database and user, the password decoded; the manifest’s usage block names', () => {
    expect(hyperdriveNames({ name: 'x', usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'w-x', adminHyperdrive: 'a-x' } })).toEqual({ usage_writer: 'w-x', usage_admin: 'a-x' });
    const url = roleUrl(`postgresql://o:p@${HOST}:6543/ledger?sslmode=require`, 'usage_admin', 'npg_a/b@c:d%e#f');
    expect(hyperdriveBody('n', url)).toEqual({ name: 'n', origin: { scheme: 'postgres', host: HOST, port: 6543, database: 'ledger', user: 'usage_admin', password: 'npg_a/b@c:d%e#f' }, caching: { disabled: true } });
    expect(() => hyperdriveBody('n', `postgresql://u:p@${HOST}/`)).toThrow(/no database/u);
  });
});

describe('usage-setup user-id-key', () => {
  it('generates the key once (0600), sets it on the API Worker through stdin, never prints it; a re-run keeps the file', async () => {
    await run(['user-id-key']);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expect(existsSync(join(dir, USER_ID_KEY_FILE))).toBe(false);
    await run(['user-id-key', '--yes']);
    const file = join(dir, USER_ID_KEY_FILE);
    expect(mode(file)).toBe(0o600);
    const value = readFileSync(file, 'utf8');
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
    expect(calls).toEqual([{ args: ['secret', 'put', 'USER_ID_KEY', '--name', m.cloudflare.workerName], input: value }]);
    expect(printed()).toMatch(/offline backup/u);
    await run(['user-id-key', '--yes']);
    expect(readFileSync(file, 'utf8')).toBe(value);
    expect(calls.map((c) => c.input)).toEqual([value, value]);
    expect(printed()).not.toContain(value);
    expect(printed()).not.toContain(value.slice(0, 20));
  });

  it('refuses a malformed key file and a failed wrangler', async () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, USER_ID_KEY_FILE), 'not-a-key', { mode: 0o600 });
    await expect(run(['user-id-key', '--yes'])).rejects.toThrow(/not base64 of 32 bytes/u);
    rmSync(join(dir, USER_ID_KEY_FILE));
    wranglerReply = () => ({ status: 1, stdout: '', stderr: 'nope' });
    await expect(run(['user-id-key', '--yes'])).rejects.toThrow(/secret put USER_ID_KEY failed/u);
  });
});

describe('roleUrl', () => {
  it('keeps the owner’s endpoint and database, drops its other options, requires TLS', () => {
    expect(roleUrl(OWNER, 'usage_admin', 'pw_0')).toBe(`postgresql://usage_admin:pw_0@${HOST}/neondb?sslmode=require`);
  });
});
