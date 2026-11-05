// access-setup <env> against a fake Cloudflare API (fetch) and a temp .secrets root (D409): the dry run, create,
// idempotent re-run, update, --check drift, a missing login method, a token without the permissions, the sandbox
// (Google, exact emails) and production (GitHub team + Google emails) policies, --write-manifest, and that the token
// and response bodies never reach the output or an error.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Manifest, loadEnv, manifestPath, manifestSchema } from '@hana-id/env';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ACCESS_PERMISSIONS, FREE_TIER_SEATS, GITHUB_ORG, GITHUB_TEAM, accessSetup, accessVariant, adminHost, desiredAccess, freeTierProblems, ruleKey, type AccessSetupDeps } from '../lib/access-setup.ts';
import { CLOUDFLARE_ACCESS_TOKEN_FILE, CLOUDFLARE_API } from '../lib/cloudflare-api.ts';
import { CliError } from '../lib/cli.ts';
import { setAdminAccess } from '../lib/manifest-edit.ts';
import { DRY_RUN_LINE } from '../lib/vault-kek.ts';

// Placeholders of the shapes Cloudflare gives (not a real account, token or id).
const ACCOUNT = '0123456789abcdef0123456789abcdef';
const TOKEN = 'cf-token-not-real-0123456789abcdefABCDEF';
const TEAM = 'hana-test.cloudflareaccess.com';
const GOOGLE = '11111111-2222-3333-4444-555555555555';
const GITHUB = '66666666-7777-8888-9999-000000000000';
const IDP_SECRET = 'idp-client-secret-not-real-xyz';
const STAFF = ['alice@example.com', 'bob@example.com'];
const SANDBOX_HOST = 'hana-id-admin-sandbox-dev.tingtc.workers.dev';

const admin = (over: Partial<NonNullable<Manifest['admin']>> = {}): NonNullable<Manifest['admin']> => ({
  workerName: 'hana-id-admin-sandbox-dev',
  origin: `https://${SANDBOX_HOST}`,
  accessTeamDomain: TEAM,
  accessAud: 'UNSET',
  staffEmails: STAFF,
  ...over,
});
const sandbox = (over: Partial<NonNullable<Manifest['admin']>> = {}): Manifest => ({ ...loadEnv('sandbox-dev'), admin: admin(over) });
const staging = (over: Partial<NonNullable<Manifest['admin']>> = {}): Manifest => ({
  ...loadEnv('sandbox-dev'),
  name: 'staging',
  admin: admin({ workerName: 'hana-id-admin-staging', origin: 'https://admin.hana.example', ...over }),
});

type Obj = Record<string, unknown>;
interface Cf {
  org: Obj | null;
  idps: Obj[];
  policies: Map<string, Obj>;
  apps: Map<string, Obj>;
  perms: Set<'apps' | 'org'>;
  accounts: Obj[];
  /** Overrides an answer; undefined falls through. */
  override: (method: string, path: string) => Response | undefined;
}

let root: string;
let out: string[];
let requests: { method: string; path: string; body?: Obj }[];
let cf: Cf;
let seq: number;
let manifest: Manifest;

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const ok = (result: unknown, info?: Obj) => json(200, { success: true, errors: [], messages: [], result, ...(info ? { result_info: info } : {}) });
const fail = (status: number, code: number, message: string) => json(status, { success: false, errors: [{ code, message }], messages: [], result: null });
const hex = (n: number, len: number) => n.toString(16).padStart(len, '0');
const uuid = () => `aaaaaaaa-bbbb-cccc-dddd-${hex(++seq, 12)}`;

async function fakeCloudflare(url: string, init: RequestInit): Promise<Response> {
  expect(url.startsWith(CLOUDFLARE_API)).toBe(true);
  expect(init.redirect).toBe('error');
  const method = init.method ?? 'GET';
  const u = new URL(url);
  const path = u.pathname.replace(/^\/client\/v4/u, '');
  const body = typeof init.body === 'string' ? (JSON.parse(init.body) as Obj) : undefined;
  requests.push({ method, path, ...(body ? { body } : {}) });
  const over = cf.override(method, path);
  if (over) return over;
  if (new Headers(init.headers).get('authorization') !== `Bearer ${TOKEN}`) return fail(401, 10000, 'Authentication error');
  if (method === 'GET' && path === '/accounts') return ok(cf.accounts, { page: 1, total_pages: 1 });
  const base = `/accounts/${ACCOUNT}/access`;
  if (!path.startsWith(base)) return fail(404, 7003, 'Could not route to /accounts/x, perhaps your object identifier is invalid?');
  const rest = path.slice(base.length);
  const need = rest.startsWith('/organizations') || rest.startsWith('/identity_providers') ? 'org' : 'apps';
  if (!cf.perms.has(need)) return fail(403, 10000, 'Authentication error');
  const list = (items: Obj[]) => {
    const page = Number(u.searchParams.get('page') ?? 1);
    const per = Number(u.searchParams.get('per_page') ?? 100);
    return ok(items.slice((page - 1) * per, page * per), { page, per_page: per, total_pages: Math.max(1, Math.ceil(items.length / per)) });
  };
  if (method === 'GET' && rest === '/organizations') return cf.org ? ok(cf.org) : fail(404, 12130, 'access.api.error.not_found');
  if (method === 'GET' && rest === '/identity_providers') return list(cf.idps);
  if (method === 'GET' && rest === '/policies') return list([...cf.policies.values()]);
  if (method === 'GET' && rest === '/apps') return list([...cf.apps.values()]);
  if (method === 'POST' && rest === '/policies') {
    const p = { ...body, id: uuid(), reusable: true, app_count: 0 };
    cf.policies.set(p.id, p);
    return ok(p);
  }
  const pid = /^\/policies\/([0-9a-f-]+)$/u.exec(rest)?.[1];
  if (method === 'PUT' && pid) {
    if (!cf.policies.has(pid)) return fail(404, 12130, 'access.api.error.not_found');
    const p = { ...body, id: pid, reusable: true };
    cf.policies.set(pid, p);
    return ok(p);
  }
  if (method === 'POST' && rest === '/apps') {
    const id = uuid();
    const a = { ...body, id, aud: hex(seq, 64), policies: withPolicies(body?.policies) };
    cf.apps.set(id, a);
    return ok(a);
  }
  const aid = /^\/apps\/([0-9a-f-]+)$/u.exec(rest)?.[1];
  if (aid && method === 'GET') return cf.apps.has(aid) ? ok(cf.apps.get(aid)) : fail(404, 12130, 'access.api.error.not_found');
  if (aid && method === 'PUT') {
    const old = cf.apps.get(aid);
    if (!old) return fail(404, 12130, 'access.api.error.not_found');
    const a = { ...body, id: aid, aud: old.aud, policies: withPolicies(body?.policies) };
    cf.apps.set(aid, a);
    return ok(a);
  }
  return fail(404, 7000, `No route for that URI`);
}

/** An app's policies as Cloudflare answers them: each linked reusable policy in full, with its precedence. */
const withPolicies = (links: unknown) => (Array.isArray(links) ? links : []).map((l: { id: string; precedence: number }) => ({ ...cf.policies.get(l.id), id: l.id, precedence: l.precedence }));

const deps = (over: Partial<AccessSetupDeps> = {}): AccessSetupDeps => ({
  fetch: fakeCloudflare,
  sleep: async () => undefined,
  log: (l) => out.push(l),
  env: { CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
  secretsRoot: root,
  loadManifest: () => manifest,
  ...over,
});
const run = (args: string[], over: Partial<AccessSetupDeps> = {}) => accessSetup([manifest.name, ...args], deps(over));
const writes = () => requests.filter((r) => r.method !== 'GET');
const all = () => out.join('\n');

function tokenFile(env: string, value = TOKEN, mode = 0o600): string {
  const dir = join(root, '.secrets', env);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const f = join(dir, CLOUDFLARE_ACCESS_TOKEN_FILE);
  writeFileSync(f, `${value}\n`, { mode });
  chmodSync(f, mode);
  return f;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'access-setup-'));
  out = [];
  requests = [];
  seq = 0;
  manifest = sandbox();
  cf = {
    org: { auth_domain: TEAM, name: 'hana-test' },
    idps: [
      { id: GOOGLE, name: 'Google', type: 'google', config: { client_id: 'x.apps.googleusercontent.com', client_secret: IDP_SECRET } },
      { id: 'otp-1234-5678', name: 'One-time PIN', type: 'onetimepin', config: {} },
    ],
    policies: new Map(),
    apps: new Map(),
    perms: new Set(['apps', 'org']),
    accounts: [{ id: ACCOUNT, name: 'Hana' }],
    override: () => undefined,
  };
  tokenFile('sandbox-dev');
  tokenFile('staging');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Every line printed and every error message must leave out the token and any body field (the IdP's secret). */
function expectNoSecrets(extra = ''): void {
  for (const text of [all(), extra]) {
    expect(text).not.toContain(TOKEN);
    expect(text).not.toContain(IDP_SECRET);
  }
}

describe('variant and host', () => {
  it('sandbox* envs get Google with exact emails; every other env the production variant', () => {
    expect(accessVariant('sandbox-dev')).toBe('sandbox');
    expect(accessVariant('sandbox')).toBe('sandbox');
    expect(accessVariant('staging')).toBe('production');
    expect(accessVariant('testnet')).toBe('production');
  });

  it('the host is the https origin; local, port or path origins are refused', () => {
    expect(adminHost('https://admin.hana.example')).toBe('admin.hana.example');
    for (const bad of ['http://admin.hana.example', 'https://admin.hana.example:8443', 'https://admin.hana.example/x', 'https://localhost', 'https://127.0.0.1', 'nope']) {
      expect(() => adminHost(bad), bad).toThrow();
    }
  });

  it('rule keys: emails lowercased, the GitHub team, the login method; anything else is "other"', () => {
    expect(ruleKey({ email: { email: 'A@Example.com' } })).toBe('email:a@example.com');
    expect(ruleKey({ 'github-organization': { identity_provider_id: GITHUB, name: GITHUB_ORG, team: GITHUB_TEAM } })).toBe(`github:${GITHUB}:${GITHUB_ORG}:${GITHUB_TEAM}`);
    expect(ruleKey({ login_method: { id: GOOGLE } })).toBe(`login_method:${GOOGLE}`);
    expect(ruleKey({ any_valid_service_token: {} })).toBe('other:any_valid_service_token');
    expect(ruleKey({ email_domain: { domain: 'example.com' } })).toBe('other:email_domain');
  });
});

describe('sandbox (Google, exact emails)', () => {
  it('dry run: reads only, prints the plan', async () => {
    await run([]);
    expect(writes()).toEqual([]);
    expect(all()).toContain(`team domain   ${TEAM}`);
    expect(all()).toContain(`Google (${GOOGLE})`);
    expect(all()).toContain('policy "Hana staff (sandbox-dev)" (Allow, 2 exact email(s), Google only, 1h): create');
    expect(all()).toContain(`application "Hana ID admin (sandbox-dev)" on ${SANDBOX_HOST} (self-hosted, 1h, no service tokens): create`);
    expect(out.at(-1)).toBe(DRY_RUN_LINE);
    expectNoSecrets();
  });

  it('--yes creates the policy and the application, then prints the id, team domain and AUD tag', async () => {
    await run(['--yes']);
    const [policyReq, appReq] = writes();
    expect(writes()).toHaveLength(2);
    expect(policyReq).toMatchObject({ method: 'POST', path: `/accounts/${ACCOUNT}/access/policies` });
    expect(policyReq!.body).toEqual({
      name: 'Hana staff (sandbox-dev)',
      decision: 'allow',
      include: STAFF.map((email) => ({ email: { email } })),
      require: [{ login_method: { id: GOOGLE } }],
      exclude: [],
      session_duration: '1h',
    });
    const policyId = [...cf.policies.keys()][0]!;
    expect(appReq).toMatchObject({ method: 'POST', path: `/accounts/${ACCOUNT}/access/apps` });
    expect(appReq!.body).toEqual({
      name: 'Hana ID admin (sandbox-dev)',
      type: 'self_hosted',
      domain: SANDBOX_HOST,
      destinations: [{ type: 'public', uri: SANDBOX_HOST }],
      session_duration: '1h',
      allowed_idps: [GOOGLE],
      auto_redirect_to_identity: true,
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
      policies: [{ id: policyId, precedence: 1 }],
    });
    // No service-token rule anywhere.
    expect(JSON.stringify(writes())).not.toMatch(/service_token/u);
    const app = [...cf.apps.values()][0]!;
    expect(all()).toContain(`Application id  ${String(app.id)}`);
    expect(all()).toContain(`Team domain     ${TEAM}`);
    expect(all()).toContain(`AUD tag         ${String(app.aud)}`);
    expect(all()).toContain(`"accessAud": "${String(app.aud)}"`);
    expect(all()).toContain('--write-manifest');
    expectNoSecrets();
  });

  it('a second run with the manifest updated changes nothing (idempotent)', async () => {
    await run(['--yes']);
    manifest = sandbox({ accessAud: String([...cf.apps.values()][0]!.aud) });
    requests = [];
    out = [];
    await run(['--yes']);
    expect(writes()).toEqual([]);
    expect(all()).toMatch(/policy "Hana staff \(sandbox-dev\)".*: matches/u);
    expect(all()).toMatch(/application "Hana ID admin \(sandbox-dev\)".*: matches/u);
    expect(all()).toContain('already has this team domain and AUD tag');
    out = [];
    await run([]);
    expect(out.at(-1)).toBe('Nothing to change.');
  });

  it('updates a drifted policy and application in place (PUT, same ids and AUD)', async () => {
    await run(['--yes']);
    const [pid, policy] = [...cf.policies.entries()][0]!;
    const [aid, app] = [...cf.apps.entries()][0]!;
    cf.policies.set(pid, { ...policy, include: [{ email: { email: 'alice@example.com' } }, { email: { email: 'mallory@example.com' } }], session_duration: '24h' });
    cf.apps.set(aid, { ...app, session_duration: '24h', allowed_idps: [], auto_redirect_to_identity: false });
    manifest = sandbox({ accessAud: String(app.aud) });
    requests = [];
    out = [];
    await run(['--yes']);
    expect(all()).toContain('update (include: +bob@example.com, -mallory@example.com; session 24h → 1h)');
    expect(all()).toMatch(/update \(session 24h → 1h; allowed IdPs any → [0-9a-f-]+ \(free tier, D408: Google only\); auto-redirect false → true\)/u);
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual([`PUT /accounts/${ACCOUNT}/access/policies/${pid}`, `PUT /accounts/${ACCOUNT}/access/apps/${aid}`]);
    expect(cf.policies.get(pid)!.include).toEqual(STAFF.map((email) => ({ email: { email } })));
    expect(cf.apps.get(aid)).toMatchObject({ session_duration: '1h', allowed_idps: [GOOGLE], aud: app.aud });
    expect(cf.apps.size).toBe(1);
    expect(cf.policies.size).toBe(1);
  });

  it('finds the application by name when its domain moved, and moves it back', async () => {
    await run(['--yes']);
    const [aid, app] = [...cf.apps.entries()][0]!;
    cf.apps.set(aid, { ...app, domain: 'other.example', destinations: [{ type: 'public', uri: 'other.example' }] });
    requests = [];
    await run(['--yes']);
    expect(writes().map((r) => r.method)).toEqual(['PUT']);
    expect(cf.apps.get(aid)!.domain).toBe(SANDBOX_HOST);
  });

  it('a service-token rule or an extra policy on the application is drift, and --yes removes it', async () => {
    await run(['--yes']);
    const [pid, policy] = [...cf.policies.entries()][0]!;
    cf.policies.set(pid, { ...policy, include: [...(policy.include as Obj[]), { any_valid_service_token: {} }] });
    manifest = sandbox({ accessAud: String([...cf.apps.values()][0]!.aud) });
    out = [];
    await expect(run(['--check'])).rejects.toThrow('1 difference(s)');
    expect(all()).toContain('Drift: policy "Hana staff (sandbox-dev)": include: -other:any_valid_service_token (free tier, D408: exact emails only)');
    await run(['--yes']);
    expect(JSON.stringify(cf.policies.get(pid))).not.toContain('service_token');
  });
});

describe('--check', () => {
  it('no application yet: drift, exit non-zero, nothing written', async () => {
    await expect(run(['--check'])).rejects.toThrow(/difference\(s\) between envs\/sandbox-dev\.json and Cloudflare Access/u);
    expect(all()).toContain('Drift: policy "Hana staff (sandbox-dev)": missing');
    expect(all()).toContain('Drift: application "Hana ID admin (sandbox-dev)": missing');
    expect(writes()).toEqual([]);
  });

  it('in sync: no drift; then an email added to the manifest, a session change and a stale AUD are each drift', async () => {
    await run(['--yes']);
    const aud = String([...cf.apps.values()][0]!.aud);
    manifest = sandbox({ accessAud: aud });
    out = [];
    await run(['--check']);
    expect(all()).toContain('No drift: Cloudflare Access matches the manifest.');

    manifest = sandbox({ accessAud: aud, staffEmails: [...STAFF, 'carol@example.com'] });
    out = [];
    await expect(run(['--check'])).rejects.toThrow('1 difference(s)');
    expect(all()).toContain('Drift: policy "Hana staff (sandbox-dev)": include: +carol@example.com');

    const [aid, app] = [...cf.apps.entries()][0]!;
    cf.apps.set(aid, { ...app, session_duration: '24h' });
    manifest = sandbox({ accessAud: 'f'.repeat(64), accessTeamDomain: 'other.cloudflareaccess.com' });
    out = [];
    await expect(run(['--check'])).rejects.toThrow('3 difference(s)');
    expect(all()).toContain('Drift: application "Hana ID admin (sandbox-dev)": session 24h → 1h');
    expect(all()).toContain(`Drift: admin.accessTeamDomain is other.cloudflareaccess.com; the team domain is ${TEAM}`);
    expect(all()).toContain(`Drift: admin.accessAud is another AUD; the application's AUD tag is ${aud}`);
    expect(writes().filter((r) => r.method !== 'GET')).toHaveLength(2); // only the first --yes
  });

  it('refuses --check with --yes or --write-manifest', async () => {
    await expect(run(['--check', '--yes'])).rejects.toBeInstanceOf(CliError);
    await expect(run(['--check', '--write-manifest'])).rejects.toBeInstanceOf(CliError);
    expect(requests).toEqual([]);
  });
});

describe('production variant (GitHub team hana-admins, exact-email Google fallback)', () => {
  beforeEach(() => {
    manifest = staging();
    cf.idps.push({ id: GITHUB, name: 'GitHub', type: 'github', config: { client_id: 'gh', client_secret: IDP_SECRET } });
  });

  it('creates the GitHub policy first, then the email policy; both IdPs, no auto-redirect', async () => {
    await run(['--yes']);
    const [gh, email, app] = writes();
    expect(gh!.body).toEqual({
      name: 'Hana staff GitHub (staging)',
      decision: 'allow',
      include: [{ 'github-organization': { identity_provider_id: GITHUB, name: 'Hana-Technology', team: 'hana-admins' } }],
      require: [],
      exclude: [],
      session_duration: '1h',
    });
    expect(email!.body).toMatchObject({ name: 'Hana staff (staging)', include: STAFF.map((e) => ({ email: { email: e } })), require: [{ login_method: { id: GOOGLE } }] });
    const [ghId, emailId] = [...cf.policies.keys()];
    expect(app!.body).toMatchObject({
      domain: 'admin.hana.example',
      allowed_idps: [GITHUB, GOOGLE],
      auto_redirect_to_identity: false,
      session_duration: '1h',
      policies: [{ id: ghId, precedence: 1 }, { id: emailId, precedence: 2 }],
    });
    expect(all()).toContain('GitHub team hana-admins of Hana-Technology');
    expectNoSecrets();
  });

  it('policies attached in the wrong order are drift', async () => {
    await run(['--yes']);
    const [aid, app] = [...cf.apps.entries()][0]!;
    const pol = app.policies as Obj[];
    cf.apps.set(aid, { ...app, policies: [{ ...pol[1], precedence: 1 }, { ...pol[0], precedence: 2 }] });
    manifest = staging({ accessAud: String(app.aud) });
    out = [];
    await expect(run(['--check'])).rejects.toThrow('1 difference(s)');
    expect(all()).toContain('policies 2 attached → the 2 below, in order');
  });

  it('refuses without a GitHub login method, before any write', async () => {
    cf.idps = cf.idps.filter((i) => i.type !== 'github');
    await expect(run(['--yes'])).rejects.toThrow(/No GitHub login method in this Zero Trust account: add it in the Cloudflare dashboard/u);
    expect(writes()).toEqual([]);
  });
});

describe('sandbox stays on the free tier (D408)', () => {
  const emails = (n: number) => Array.from({ length: n }, (_, i) => `staff${i}@example.com`);

  it('more than 50 staff emails: refused before any request', async () => {
    manifest = sandbox({ staffEmails: emails(FREE_TIER_SEATS + 1) });
    await expect(run(['--yes'])).rejects.toThrow(/51 addresses; sandbox stays on Zero Trust's free tier, 50 seats \(D408\)/u);
    expect(requests).toEqual([]);
  });

  it('more than 10: a warning, then the usual run; 10 or fewer: no warning', async () => {
    manifest = sandbox({ staffEmails: emails(11) });
    await run([]);
    expect(all()).toContain('Warning: admin.staffEmails has 11 addresses, each a Zero Trust seat once used');
    out = [];
    manifest = sandbox({ staffEmails: emails(10) });
    await run([]);
    expect(all()).not.toContain('Warning:');
  });

  it('the production variant has no seat guard (D88 envs are planned separately)', async () => {
    manifest = staging({ staffEmails: emails(11) });
    cf.idps.push({ id: GITHUB, name: 'GitHub', type: 'github' });
    await run([]);
    expect(all()).not.toContain('Warning:');
  });

  it('only exact-email includes are written, and the guard refuses anything else', () => {
    const d = desiredAccess('sandbox-dev', admin(), { google: GOOGLE });
    expect(freeTierProblems(d, GOOGLE, 2)).toEqual([]);
    for (const rule of [{ everyone: {} }, { email_domain: { domain: 'example.com' } }, { group: { id: 'g' } }, { gsuite: { email: 'g@example.com', identity_provider_id: GOOGLE } }]) {
      const bad = { ...d, policies: [{ ...d.policies[0]!, include: [...d.policies[0]!.include, rule] }] };
      expect(freeTierProblems(bad, GOOGLE, 2).join(), JSON.stringify(rule)).toMatch(/not only exact emails/u);
    }
    expect(freeTierProblems({ ...d, app: { allowed_idps: [GOOGLE, 'otp'] } }, GOOGLE, 2)).toEqual(['the application allows an IdP other than Google']);
    expect(freeTierProblems({ ...d, policies: [{ ...d.policies[0]!, require: [{ login_method: { id: 'otp' } }] }] }, GOOGLE, 2).join()).toMatch(/requires login_method:otp/u);
    expect(freeTierProblems(d, GOOGLE, 51).join()).toMatch(/over the free plan's 50 seats/u);
  });

  it('--check: an everyone or domain include and another IdP on the application are drift, labelled', async () => {
    await run(['--yes']);
    const [pid, policy] = [...cf.policies.entries()][0]!;
    const [aid, app] = [...cf.apps.entries()][0]!;
    cf.policies.set(pid, { ...policy, include: [...(policy.include as Obj[]), { everyone: {} }, { email_domain: { domain: 'example.com' } }] });
    cf.apps.set(aid, { ...app, allowed_idps: [GOOGLE, 'otp-1234-5678'] });
    manifest = sandbox({ accessAud: String(app.aud) });
    out = [];
    await expect(run(['--check'])).rejects.toThrow('2 difference(s)');
    expect(all()).toContain('Drift: policy "Hana staff (sandbox-dev)": include: -other:email_domain, -other:everyone (free tier, D408: exact emails only)');
    expect(all()).toMatch(/Drift: application "Hana ID admin \(sandbox-dev\)": allowed IdPs [0-9a-f-]+, otp-1234-5678 → [0-9a-f-]+ \(free tier, D408: Google only\)/u);
    // --yes puts it back to exact emails and Google only.
    await run(['--yes']);
    expect(keysOf(cf.policies.get(pid)!.include)).toEqual(STAFF.map((e) => `email:${e}`));
    expect(cf.apps.get(aid)!.allowed_idps).toEqual([GOOGLE]);
  });

  it('other login methods on the account are pointed out (One-time PIN)', async () => {
    await run([]);
    expect(all()).toContain('Note: this account also has the login method(s) One-time PIN; on sandbox Google should be the only one (D408)');
  });

  it('touches only Access applications, policies, login methods (read) and the team (read)', async () => {
    await run(['--yes']);
    for (const r of requests) expect(r.path, r.path).toMatch(/^\/accounts\/[0-9a-f]{32}\/access\/(organizations|identity_providers|policies|apps)(\/[0-9a-f-]+)?$/u);
    for (const r of requests.filter((x) => x.method !== 'GET')) expect(r.path).toMatch(/\/access\/(policies|apps)/u);
  });
});

const keysOf = (rules: unknown) => (rules as unknown[]).map(ruleKey).sort();

describe('refusals', () => {
  it('no Google login method: tells the user to add it in the dashboard; writes nothing', async () => {
    cf.idps = cf.idps.filter((i) => i.type !== 'google');
    await expect(run(['--yes'])).rejects.toThrow(/No Google login method in this Zero Trust account: add it in the Cloudflare dashboard: Zero Trust → Settings → Authentication → Login methods → Add new → Google/u);
    expect(writes()).toEqual([]);
  });

  it('two Google login methods: asks for --google-idp, which picks one', async () => {
    const other = '99999999-8888-7777-6666-555555555555';
    cf.idps.push({ id: other, name: 'Google (old)', type: 'google' });
    await expect(run([])).rejects.toThrow(/2 Google login methods .*pass --google-idp <id>/u);
    await run(['--yes', '--google-idp', other]);
    expect(writes()[1]!.body).toMatchObject({ allowed_idps: [other] });
    await expect(run(['--google-idp', 'not an id'])).rejects.toBeInstanceOf(CliError);
  });

  it('no Zero Trust team yet', async () => {
    cf.org = null;
    await expect(run([])).rejects.toThrow(/HTTP 404 \(code 12130/u);
    cf.org = { name: 'x' };
    await expect(run([])).rejects.toThrow(/no Zero Trust team yet: create it in the Cloudflare dashboard/u);
  });

  it('a token without the IdP permission: HTTP 403, Cloudflare code and message, the permission it needs', async () => {
    cf.perms = new Set(['apps']);
    const err = await run(['--yes']).catch((e: Error) => e);
    expect(String(err)).toContain('Cloudflare API: reading the Zero Trust organization answered HTTP 403 (code 10000: Authentication error)');
    expect(String(err)).toContain(`the token lacks "${ACCESS_PERMISSIONS.org}"`);
    expect(writes()).toEqual([]);
    expectNoSecrets(String(err));
  });

  it('a token without the apps permission: refused at the first policy read', async () => {
    cf.perms = new Set(['org']);
    const err = await run(['--yes']).catch((e: Error) => e);
    expect(String(err)).toContain('listing the Access policies answered HTTP 403');
    expect(String(err)).toContain(`"${ACCESS_PERMISSIONS.apps}"`);
    expect(writes()).toEqual([]);
    // --check only reads, so it asks for the Read permission.
    const checkErr = await run(['--check']).catch((e: Error) => e);
    expect(String(checkErr)).toContain(`the token lacks "${ACCESS_PERMISSIONS.appsRead}"`);
  });

  it('a revoked or mistyped token: 401, named as such; the token is never in the message', async () => {
    tokenFile('sandbox-dev', 'cf-token-other-not-real-0123456789abcdef');
    const err = await run([]).catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 401 (code 10000: Authentication error): the token was refused');
    expect(String(err)).not.toContain('cf-token-other');
  });

  it("an error message quoting the token is scrubbed; a body's other fields are never shown", async () => {
    cf.override = (method, path) => (path.endsWith('/identity_providers') ? json(400, { success: false, errors: [{ code: 9109, message: `bad token ${TOKEN}` }], result: { client_secret: IDP_SECRET } }) : undefined);
    const err = await run([]).catch((e: Error) => e);
    expect(String(err)).toContain('HTTP 400 (code 9109: bad token <redacted>)');
    expectNoSecrets(String(err));
  });

  it('the token file: missing, readable by others, or two lines are refused before any request', async () => {
    rmSync(join(root, '.secrets', 'sandbox-dev', CLOUDFLARE_ACCESS_TOKEN_FILE));
    await expect(run([])).rejects.toThrow(/cloudflare-access-token is missing: create an account API token with "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups Read"/u);
    tokenFile('sandbox-dev', TOKEN, 0o644);
    await expect(run([])).rejects.toThrow(/has mode 644; it must be 0600/u);
    tokenFile('sandbox-dev', `${TOKEN}\nsecond line`);
    const err = await run([]).catch((e: Error) => e);
    expect(String(err)).toMatch(/doesn't hold one API token/u);
    expect(requests).toEqual([]);
    expectNoSecrets(String(err));
  });

  it('a mainnet manifest, a manifest without admin, an http origin', async () => {
    manifest = { ...sandbox(), network: 'mainnet' } as unknown as Manifest;
    await expect(run([])).rejects.toThrow('not a testnet env');
    manifest = { ...loadEnv('sandbox-dev') };
    await expect(run([])).rejects.toThrow('has no admin block');
    manifest = sandbox({ origin: 'http://127.0.0.1:8789' });
    await expect(run([])).rejects.toThrow(/must be an https origin/u);
    expect(requests).toEqual([]);
  });

  it('an application on every Worker, two matching applications, or a non-self-hosted one', async () => {
    cf.apps.set('a1', { id: 'a1', name: 'All workers', type: 'self_hosted', destinations: [{ type: 'all_workers' }] });
    await expect(run([])).rejects.toThrow(/protects every Worker of the account/u);
    cf.apps.clear();
    cf.apps.set('a1', { id: 'a1', name: 'Hana ID admin (sandbox-dev)', type: 'self_hosted', domain: 'x.example' });
    cf.apps.set('a2', { id: 'a2', name: 'Admin', type: 'self_hosted', domain: SANDBOX_HOST });
    await expect(run([])).rejects.toThrow(/2 Access applications match/u);
    cf.apps.delete('a1');
    cf.apps.set('a2', { id: 'a2', name: 'Admin', type: 'saas', domain: SANDBOX_HOST });
    await expect(run([])).rejects.toThrow(/is of type saas, not self_hosted/u);
    expect(writes()).toEqual([]);
  });

  it("a Worker-level application (the dashboard's workers.dev toggle) is pointed out", async () => {
    cf.apps.set('w1', { id: 'w1', name: 'hana-id-admin-sandbox-dev - Production', type: 'self_hosted', destinations: [{ type: 'worker', worker_id: 'abc' }] });
    await run([]);
    expect(all()).toContain('protects one Worker by id');
  });

  it('two policies with the same name', async () => {
    cf.policies.set('p1', { id: 'p1', name: 'Hana staff (sandbox-dev)' });
    cf.policies.set('p2', { id: 'p2', name: 'Hana staff (sandbox-dev)' });
    await expect(run([])).rejects.toThrow(/2 Access policies are named/u);
  });
});

describe('the account and the API client', () => {
  it('without an account id: the token\'s only account; several: asks for --account-id', async () => {
    await run([], { env: {} });
    expect(requests[0]!.path).toBe('/accounts');
    cf.accounts.push({ id: 'f'.repeat(32) });
    await expect(run([], { env: {} })).rejects.toThrow(/reaches 2 accounts: pass --account-id/u);
    requests = [];
    await run(['--account-id', ACCOUNT], { env: {} });
    expect(requests.some((r) => r.path === '/accounts')).toBe(false);
    await expect(run(['--account-id', 'NOPE'], { env: {} })).rejects.toBeInstanceOf(CliError);
  });

  it('retries a 503 on a read and a 429 on a create; never a 500 on a create', async () => {
    let n = 0;
    cf.override = (method, path) => (method === 'GET' && path.endsWith('/identity_providers') && n++ < 2 ? fail(503, 0, 'unavailable') : undefined);
    await run([]);
    expect(all()).toContain('answered HTTP 503 (code 0: unavailable); trying again (1/4)');
    let posts = 0;
    cf.override = (method, path) => (method === 'POST' && path.endsWith('/policies') && posts++ === 0 ? fail(429, 971, 'Please wait') : undefined);
    await run(['--yes']);
    expect(cf.policies.size).toBe(1);
    cf.policies.clear();
    cf.apps.clear();
    cf.override = (method, path) => (method === 'POST' && path.endsWith('/policies') ? fail(500, 0, 'internal') : undefined);
    requests = [];
    await expect(run(['--yes'])).rejects.toThrow(/HTTP 500 .*may or may not have applied it: run the command again/u);
    expect(requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });
});

describe('--write-manifest', () => {
  /** sandbox-dev's manifest with the dashboard blocks, as a file in the temp dir (its own formatting). */
  function manifestFile(): string {
    const raw = JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Obj;
    const text = `${JSON.stringify(
      {
        ...raw,
        console: { workerName: 'hana-id-console-sandbox-dev', d1Name: 'hana-id-console-sandbox-dev', origin: 'https://hana-id-console-sandbox-dev.tingtc.workers.dev', authWorkerName: 'hana-id-console-auth-sandbox-dev', authOrigin: 'https://hana-id-console-auth-sandbox-dev.tingtc.workers.dev' },
        files: { workerName: 'hana-id-files-sandbox-dev', origin: 'https://hana-id-files-sandbox-dev.tingtc.workers.dev', logosBucket: 'hana-id-logos-sandbox-dev', statementsBucket: 'hana-id-statements-sandbox-dev', exportsBucket: 'hana-id-exports-sandbox-dev' },
        admin: admin({ accessTeamDomain: 'placeholder.cloudflareaccess.com' }),
        usage: { neonRegion: 'aws-ap-southeast-2', writerHyperdrive: 'hana-id-usage-writer-sandbox-dev', adminHyperdrive: 'hana-id-usage-admin-sandbox-dev' },
        email: { from: 'Hana ID <no-reply@mail.example.com>', securityAlias: 'security@example.com' },
        ownerGrantDelayMs: 60_000,
      },
      null,
      2,
    )}\n`;
    const f = join(root, 'sandbox-dev.json');
    writeFileSync(f, text);
    return f;
  }

  it('with --yes: sets the two fields in place, the rest of the file unchanged, still valid', async () => {
    const f = manifestFile();
    const before = readFileSync(f, 'utf8');
    manifest = manifestSchema.parse(JSON.parse(before));
    await run(['--yes', '--write-manifest'], { manifestFile: () => f });
    const after = readFileSync(f, 'utf8');
    const aud = String([...cf.apps.values()][0]!.aud);
    const changed = after.split('\n').filter((l, i) => l !== before.split('\n')[i]);
    expect(changed.map((l) => l.trim())).toEqual([`"accessTeamDomain": "${TEAM}",`, `"accessAud": "${aud}",`]);
    expect(manifestSchema.parse(JSON.parse(after)).admin).toMatchObject({ accessTeamDomain: TEAM, accessAud: aud });
    expect(all()).toContain('Wrote admin.accessTeamDomain and admin.accessAud into envs/sandbox-dev.json');
  });

  it('without --yes it writes nothing', async () => {
    const f = manifestFile();
    const before = readFileSync(f, 'utf8');
    await run(['--write-manifest'], { manifestFile: () => f });
    expect(readFileSync(f, 'utf8')).toBe(before);
  });

  it('setAdminAccess refuses a manifest without admin and a value the schema refuses', () => {
    const text = readFileSync(manifestPath('sandbox-dev'), 'utf8');
    expect(() => setAdminAccess(text, { accessTeamDomain: TEAM, accessAud: 'a'.repeat(64) })).toThrow('no admin block');
    const f = manifestFile();
    expect(() => setAdminAccess(readFileSync(f, 'utf8'), { accessTeamDomain: TEAM, accessAud: 'XYZ' })).toThrow();
  });
});
