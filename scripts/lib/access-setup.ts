// access-setup's body (D409): the admin console's Cloudflare Access application and its staff policies, from the
// manifest's `admin` block, through Cloudflare's API. Dry run by default; `--yes` applies, `--check` reports drift.
//
// Endpoints (Cloudflare API v4, https://developers.cloudflare.com/api/resources/zero_trust/), all under
// /accounts/{account_id}:
//   GET  /access/organizations                 the team domain (`auth_domain`)            [Orgs/IdPs/Groups Read]
//   GET  /access/identity_providers            the Google (and GitHub) login methods       [Orgs/IdPs/Groups Read]
//   GET  /access/policies, POST, PUT /{id}     reusable policies "Hana staff (<env>)"...  [Apps and Policies Edit]
//   GET  /access/apps, GET/PUT /{id}, POST     the self-hosted application on admin.origin [Apps and Policies Edit]
//   GET  /accounts                             only when no account id is given (the token's only account)
// The token needs exactly "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups
// Read" (https://developers.cloudflare.com/fundamentals/api/reference/permissions/), on the one account; `--check`
// only reads, so "Access: Apps and Policies Read" is enough for it.
//
// What it sets: a self-hosted application on admin.origin's host (also on workers.dev: a hostname application covers
// everything the admin Worker serves there, since its config has `preview_urls: false` and no routes; D409), session
// 1 h, the cookie HttpOnly and SameSite=Lax (the admin Worker's CSRF check assumes Lax), not in the App Launcher, and
// reusable Allow policies, none with a service-token rule:
//   sandbox*      "Hana staff (<env>)": include each admin.staffEmails address (exact), require the Google login
//                 method; allowed IdPs = Google only, auto-redirect to Google. Inside Zero Trust's free tier (D408):
//                 only exact-email includes are ever written (freeTierProblems guards it), more than 50 staff emails
//                 are refused and more than 10 warned about, `--check` labels a non-email include or another IdP on
//                 the application as a free-tier breach, and other login methods on the account are pointed out
//   other envs    "Hana staff GitHub (<env>)": include the GitHub team hana-admins of Hana-Technology (D88), then
//                 "Hana staff (<env>)" as above (the exact-email Google fallback); allowed IdPs = GitHub and Google
// It never creates or edits a login method or the team (the user does both in the dashboard), never enables any other
// Zero Trust feature (it calls only the endpoints below), never deletes anything, and never prints the token or a
// response body.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { type Manifest, loadEnv, manifestPath } from '@hana-id/env';
import { ACCOUNT_ID_RE, CLOUDFLARE_ACCESS_TOKEN_FILE, CloudflareApi, type CloudflareApiDeps, readCloudflareToken, resolveAccount } from './cloudflare-api.ts';
import { CliError, parseCli } from './cli.ts';
import { setAdminAccess } from './manifest-edit.ts';
import { secretsDir } from './secrets.ts';
import { DRY_RUN_LINE } from './vault-kek.ts';

export const ACCESS_SETUP_USAGE = `Usage: access-setup.ts <env> [--yes | --check] [--write-manifest] [--account-id <id>]
                       [--google-idp <id>] [--github-idp <id>]
  Creates or updates the admin console's Cloudflare Access application on admin.origin and its staff policies
  from envs/<env>.json (admin.staffEmails), with the API token in .secrets/<env>/cloudflare-access-token (0600).
  sandbox* envs: Google, exact emails only, at most 50 (Zero Trust's free tier, D408). Other envs: the GitHub team hana-admins plus the exact-email Google
  fallback (D88). Session 1 h, no service tokens. The Zero Trust team and its login methods are made in the
  dashboard first (docs/operations.md "Admin Worker" step 1).
  --yes             apply (without it, print the plan only)
  --check           compare Cloudflare with the manifest; exit 1 on any difference; changes nothing
  --write-manifest  with --yes: put the team domain and the AUD tag into envs/<env>.json's admin block
  --account-id      the Cloudflare account (default: CLOUDFLARE_ACCOUNT_ID, else the token's only account)
  --google-idp, --github-idp  the login method's id, when the account has more than one of that type

Testnet envs only. Never prints the token.`;

export const ACCESS_PERMISSIONS = {
  apps: 'Access: Apps and Policies Edit',
  /** Enough for --check, which only reads. */
  appsRead: 'Access: Apps and Policies Read',
  org: 'Access: Organizations, Identity Providers, and Groups Read',
} as const;
export const SESSION_DURATION = '1h';
/** D88: the production policy's GitHub team. */
export const GITHUB_ORG = 'Hana-Technology';
export const GITHUB_TEAM = 'hana-admins';
const TEAM_DOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u;
const AUD_RE = /^[0-9a-f]{64}$/u;
const IDP_ID_RE = /^[0-9a-f-]{8,64}$/u;

/**
 * D408: sandbox stays inside Zero Trust's Free plan (50 seats; a seat is a person who signs in through Access). The
 * script refuses more staff emails than that and warns well before it.
 */
export const FREE_TIER_SEATS = 50;
export const SEAT_WARN_ABOVE = 10;
/** The free-tier label on sandbox drift lines (D408). */
const FREE_EMAILS = ' (free tier, D408: exact emails only)';
const FREE_IDPS = ' (free tier, D408: Google only)';

export type AccessVariant = 'sandbox' | 'production';
/** sandbox* envs: Google with exact emails only (the user, 2026-11-05); every other env: D88's GitHub team too. */
export const accessVariant = (env: string): AccessVariant => (/^sandbox/u.test(env) ? 'sandbox' : 'production');

export interface AccessSetupDeps extends CloudflareApiDeps {
  env: Readonly<Record<string, string | undefined>>;
  /** Directory holding .secrets/ (default: the repo root). */
  secretsRoot?: string;
  loadManifest?: (name: string) => Manifest;
  /** The manifest file `--write-manifest` edits (default: envs/<env>.json). */
  manifestFile?: (name: string) => string;
}

export const defaultAccessSetupDeps = (): AccessSetupDeps => ({
  fetch: (url, init) => fetch(url, init),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log: (line) => console.log(line),
  env: process.env,
});

type Rule = Record<string, unknown>;

export interface DesiredPolicy {
  name: string;
  decision: 'allow';
  include: Rule[];
  require: Rule[];
  exclude: Rule[];
  session_duration: string;
}

export interface DesiredApp {
  name: string;
  type: 'self_hosted';
  domain: string;
  destinations: { type: 'public'; uri: string }[];
  session_duration: string;
  allowed_idps: string[];
  auto_redirect_to_identity: boolean;
  app_launcher_visible: false;
  http_only_cookie_attribute: true;
  same_site_cookie_attribute: 'lax';
}

/** The admin origin's host: https, no port, path or loopback (Access can't front a local Worker). */
export function adminHost(origin: string): string {
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    throw new Error(`admin.origin (${origin}) is not a URL`);
  }
  if (u.protocol !== 'https:' || u.port || u.origin !== origin) throw new Error(`admin.origin (${origin}) must be an https origin with no port or path: Cloudflare Access fronts only a deployed admin Worker`);
  if (u.hostname === 'localhost' || /^[\d.]+$/u.test(u.hostname) || u.hostname.startsWith('[')) throw new Error(`admin.origin (${origin}) is local: Access can't front it`);
  return u.hostname;
}

export const policyNames = (env: string) => ({ email: `Hana staff (${env})`, github: `Hana staff GitHub (${env})` });
export const appName = (env: string) => `Hana ID admin (${env})`;

/** What Cloudflare should hold for this env: the policies in precedence order, and the application. */
export function desiredAccess(env: string, admin: NonNullable<Manifest['admin']>, idps: { google: string; github?: string | undefined }): { policies: DesiredPolicy[]; app: DesiredApp } {
  const variant = accessVariant(env);
  if (variant === 'production' && !idps.github) throw new Error('A production Access policy needs the GitHub login method');
  const host = adminHost(admin.origin);
  const names = policyNames(env);
  const emailPolicy: DesiredPolicy = {
    name: names.email,
    decision: 'allow',
    include: [...new Set(admin.staffEmails)].map((email) => ({ email: { email } })),
    require: [{ login_method: { id: idps.google } }],
    exclude: [],
    session_duration: SESSION_DURATION,
  };
  const policies: DesiredPolicy[] =
    variant === 'sandbox' ? [emailPolicy]
    : [
        {
          name: names.github,
          decision: 'allow',
          include: [{ 'github-organization': { identity_provider_id: idps.github, name: GITHUB_ORG, team: GITHUB_TEAM } }],
          require: [],
          exclude: [],
          session_duration: SESSION_DURATION,
        },
        emailPolicy,
      ];
  const allowed = variant === 'sandbox' ? [idps.google] : [idps.github!, idps.google];
  const desired = {
    policies,
    app: {
      name: appName(env),
      type: 'self_hosted',
      domain: host,
      destinations: [{ type: 'public', uri: host }],
      session_duration: SESSION_DURATION,
      allowed_idps: allowed,
      // Cloudflare skips the IdP picker only with exactly one IdP.
      auto_redirect_to_identity: allowed.length === 1,
      app_launcher_visible: false,
      http_only_cookie_attribute: true,
      same_site_cookie_attribute: 'lax',
    } satisfies DesiredApp,
  };
  if (variant === 'sandbox') {
    const problems = freeTierProblems(desired, idps.google, admin.staffEmails.length);
    if (problems.length) throw new Error(`Refusing: sandbox stays on Zero Trust's free tier (D408): ${problems.join('; ')}`);
  }
  return desired;
}

/**
 * Why a sandbox Access setup could leave Zero Trust's free tier (D408), or []: more than 50 staff, a policy include
 * other than an exact email (a domain, `everyone`, a group or an IdP group admits people nobody counted), a requirement
 * other than the Google login method, or an IdP other than Google. A guard on what this script writes.
 */
export function freeTierProblems(d: { policies: readonly DesiredPolicy[]; app: Pick<DesiredApp, 'allowed_idps'> }, google: string, staff: number): string[] {
  const out: string[] = [];
  if (staff > FREE_TIER_SEATS) out.push(`admin.staffEmails has ${staff} addresses, over the free plan's ${FREE_TIER_SEATS} seats`);
  for (const p of d.policies) {
    const bad = keys(p.include).filter((k) => !k.startsWith('email:'));
    if (bad.length) out.push(`policy ${JSON.stringify(p.name)} includes ${bad.join(', ')}, not only exact emails`);
    const req = keys(p.require).filter((k) => k !== `login_method:${google}`);
    if (req.length) out.push(`policy ${JSON.stringify(p.name)} requires ${req.join(', ')}`);
  }
  if (d.app.allowed_idps.length !== 1 || d.app.allowed_idps[0] !== google) out.push('the application allows an IdP other than Google');
  return out;
}

/** A rule as a comparable string: `email:a@b`, `github:<idp>:<org>:<team>`, `login_method:<id>`, else `other:<keys>`. */
export function ruleKey(rule: unknown): string {
  const r = (rule ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const email = r.email?.email;
  if (typeof email === 'string' && Object.keys(r).length === 1) return `email:${email.toLowerCase()}`;
  const gh = r['github-organization'];
  if (gh && Object.keys(r).length === 1) return `github:${String(gh.identity_provider_id ?? '')}:${String(gh.name ?? '')}:${String(gh.team ?? '')}`;
  const lm = r.login_method?.id;
  if (typeof lm === 'string' && Object.keys(r).length === 1) return `login_method:${lm}`;
  return `other:${Object.keys(r).sort().join('+') || 'empty'}`;
}

const keys = (rules: unknown): string[] => (Array.isArray(rules) ? rules.map(ruleKey).sort() : []);
const show = (k: string) => (k.startsWith('email:') ? k.slice(6) : k);

/** `+added, -removed` between two rule lists, or null when equal. */
function ruleDiff(live: unknown, want: Rule[]): string | null {
  const l = keys(live);
  const w = keys(want);
  const added = w.filter((k) => !l.includes(k));
  const removed = l.filter((k) => !w.includes(k));
  if (!added.length && !removed.length && l.length === w.length) return null;
  return [...added.map((k) => `+${show(k)}`), ...removed.map((k) => `-${show(k)}`)].join(', ') || 'duplicates';
}

interface LivePolicy {
  id: string;
  name: string;
  decision?: unknown;
  include?: unknown;
  require?: unknown;
  exclude?: unknown;
  session_duration?: unknown;
}

/** How a live policy differs from the desired one (empty: equal). */
export function policyDiffs(want: DesiredPolicy, live: LivePolicy, variant: AccessVariant = 'production'): string[] {
  const out: string[] = [];
  if (live.decision !== want.decision) out.push(`decision ${String(live.decision)} → ${want.decision}`);
  for (const field of ['include', 'require', 'exclude'] as const) {
    const d = ruleDiff(live[field], want[field]);
    // On sandbox an include that isn't an exact email is a free-tier breach (D408), named as such.
    const free = variant === 'sandbox' && field === 'include' && keys(live.include).some((k) => !k.startsWith('email:')) ? FREE_EMAILS : '';
    if (d) out.push(`${field}: ${d}${free}`);
  }
  if (live.session_duration !== want.session_duration) out.push(`session ${String(live.session_duration ?? 'unset')} → ${want.session_duration}`);
  return out;
}

interface LiveApp {
  id: string;
  name?: unknown;
  type?: unknown;
  domain?: unknown;
  aud?: unknown;
  destinations?: unknown;
  session_duration?: unknown;
  allowed_idps?: unknown;
  auto_redirect_to_identity?: unknown;
  app_launcher_visible?: unknown;
  http_only_cookie_attribute?: unknown;
  same_site_cookie_attribute?: unknown;
  policies?: unknown;
}

const destinationKeys = (d: unknown): string[] =>
  (Array.isArray(d) ? d : []).map((x) => {
    const { type, uri } = (x ?? {}) as { type?: unknown; uri?: unknown };
    return type === 'public' && typeof uri === 'string' ? `public:${uri.toLowerCase()}` : `${String(type)}`;
  }).sort();

/** The live app's policy ids in precedence order. */
export function appPolicyIds(app: LiveApp): string[] {
  const list = (Array.isArray(app.policies) ? app.policies : []) as { id?: unknown; precedence?: unknown }[];
  return list
    .map((p, i) => ({ id: typeof p === 'string' ? p : String(p?.id ?? ''), at: typeof p?.precedence === 'number' ? p.precedence : i + 1 }))
    .sort((a, b) => a.at - b.at)
    .map((p) => p.id);
}

/** How a live application differs from the desired one and its policy ids (empty: equal). */
export function appDiffs(want: DesiredApp, live: LiveApp, policyIds: readonly (string | undefined)[], variant: AccessVariant = 'production'): string[] {
  const out: string[] = [];
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (live.type !== want.type) out.push(`type ${String(live.type)} → ${want.type}`);
  if (typeof live.domain !== 'string' || live.domain.toLowerCase() !== want.domain) out.push(`domain ${String(live.domain)} → ${want.domain}`);
  if (live.name !== want.name) out.push(`name ${JSON.stringify(live.name)} → ${JSON.stringify(want.name)}`);
  if (!same(destinationKeys(live.destinations), destinationKeys(want.destinations))) out.push(`destinations ${destinationKeys(live.destinations).join(', ') || 'none'} → public:${want.domain}`);
  if (live.session_duration !== want.session_duration) out.push(`session ${String(live.session_duration ?? 'unset')} → ${want.session_duration}`);
  const idps = (Array.isArray(live.allowed_idps) ? live.allowed_idps.map(String) : []).sort();
  if (!same(idps, [...want.allowed_idps].sort())) out.push(`allowed IdPs ${idps.join(', ') || 'any'} → ${want.allowed_idps.join(', ')}${variant === 'sandbox' ? FREE_IDPS : ''}`);
  if (Boolean(live.auto_redirect_to_identity) !== want.auto_redirect_to_identity) out.push(`auto-redirect ${String(Boolean(live.auto_redirect_to_identity))} → ${String(want.auto_redirect_to_identity)}`);
  if (live.app_launcher_visible !== want.app_launcher_visible) out.push(`App Launcher visible ${String(live.app_launcher_visible ?? 'default')} → false`);
  if (live.http_only_cookie_attribute !== want.http_only_cookie_attribute) out.push(`HttpOnly cookie ${String(live.http_only_cookie_attribute ?? 'unset')} → true`);
  if (live.same_site_cookie_attribute !== want.same_site_cookie_attribute) out.push(`SameSite ${String(live.same_site_cookie_attribute ?? 'unset')} → lax`);
  const ids = appPolicyIds(live);
  if (!same(ids, policyIds)) out.push(`policies ${ids.length} attached → the ${policyIds.length} below, in order`);
  return out;
}

interface LiveIdp {
  id: string;
  name: string;
  type: string;
}

/** The one login method of `type` (or the one with id `pick`); refuses none or several. */
export function pickIdp(idps: readonly LiveIdp[], type: 'google' | 'github', pick: string | undefined): LiveIdp {
  const label = type === 'google' ? 'Google' : 'GitHub';
  const how = `add it in the Cloudflare dashboard: Zero Trust → Settings → Authentication → Login methods → Add new → ${label} (docs/operations.md "Admin Worker" step 1), then run this again`;
  const all = idps.filter((i) => i.type === type);
  if (pick !== undefined) {
    const one = all.find((i) => i.id === pick);
    if (!one) throw new Error(`No ${label} login method with id ${pick} in this Zero Trust account`);
    return one;
  }
  if (all.length === 0) throw new Error(`No ${label} login method in this Zero Trust account: ${how}`);
  if (all.length > 1) throw new Error(`${all.length} ${label} login methods (${all.map((i) => `${i.name} = ${i.id}`).join(', ')}): pass --${type}-idp <id>`);
  return all[0]!;
}

function asIdps(list: unknown[]): LiveIdp[] {
  return list.flatMap((x) => {
    const { id, name, type } = (x ?? {}) as Record<string, unknown>;
    return typeof id === 'string' && typeof type === 'string' ? [{ id, type, name: typeof name === 'string' ? name : '' }] : [];
  });
}

function asPolicies(list: unknown[]): LivePolicy[] {
  return list.flatMap((x) => {
    const p = (x ?? {}) as Record<string, unknown>;
    return typeof p.id === 'string' && typeof p.name === 'string' ? [p as unknown as LivePolicy] : [];
  });
}

function asApp(x: unknown): LiveApp | undefined {
  const a = (x ?? {}) as Record<string, unknown>;
  return typeof a.id === 'string' ? (a as unknown as LiveApp) : undefined;
}

/**
 * The application for `host`: by domain, a public destination on the host, or the name. Refuses several matches, a
 * match that isn't self-hosted, and an application on every Worker (`all_workers`: it would front the admin Worker
 * with another AUD); warns about Worker-level applications (`worker`: this token can't tell which Worker) and
 * applications on a path of the host.
 */
export function findApp(apps: unknown[], host: string, name: string, log: (l: string) => void): LiveApp | undefined {
  const matches: LiveApp[] = [];
  for (const raw of apps) {
    const a = asApp(raw);
    if (!a) continue;
    const domain = typeof a.domain === 'string' ? a.domain.toLowerCase() : '';
    const dests = destinationKeys(a.destinations);
    if (dests.includes('all_workers')) {
      throw new Error(`Access application ${JSON.stringify(a.name)} (${a.id}) protects every Worker of the account: it would front the admin Worker with its own AUD. Narrow or delete it in the dashboard first`);
    }
    if (dests.includes('worker')) log(`Note: Access application ${JSON.stringify(a.name)} (${a.id}) protects one Worker by id; if it is the admin Worker (the dashboard's workers.dev "Enable Cloudflare Access"), delete it in the dashboard: the admin Worker accepts only this application's AUD.`);
    if (domain === host || dests.includes(`public:${host}`) || a.name === name) matches.push(a);
    else if (domain.startsWith(`${host}/`)) log(`Note: Access application ${JSON.stringify(a.name)} (${a.id}) is on a path of ${host}; its requests carry another AUD, which the admin Worker refuses.`);
  }
  if (matches.length > 1) throw new Error(`${matches.length} Access applications match ${host} or ${JSON.stringify(name)} (${matches.map((a) => a.id).join(', ')}): delete the extras in the dashboard, then run this again`);
  const [one] = matches;
  if (one && one.type !== 'self_hosted') throw new Error(`Access application ${one.id} on ${host} is of type ${String(one.type)}, not self_hosted: delete it in the dashboard, then run this again`);
  return one;
}

const policyBody = (p: DesiredPolicy) => ({ name: p.name, decision: p.decision, include: p.include, require: p.require, exclude: p.exclude, session_duration: p.session_duration });
const appBody = (a: DesiredApp, policyIds: readonly string[]) => ({ ...a, policies: policyIds.map((id, i) => ({ id, precedence: i + 1 })) });

function writeFileAtomic(file: string, text: string): void {
  const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  writeFileSync(tmp, text, { flag: 'wx' });
  renameSync(tmp, file);
}

export async function accessSetup(argv: readonly string[], deps: AccessSetupDeps): Promise<void> {
  const args = parseCli(argv, { booleans: ['yes', 'check', 'write-manifest'], strings: ['account-id', 'google-idp', 'github-idp'] });
  const [envName, ...rest] = args.positionals;
  if (!envName) throw new CliError('Expected <env>');
  if (rest.length) throw new CliError(`Unexpected argument ${rest.join(' ')}`);
  const apply = args.flag('yes');
  const check = args.flag('check');
  const writeManifest = args.flag('write-manifest');
  if (apply && check) throw new CliError('--check changes nothing: use it without --yes');
  if (check && writeManifest) throw new CliError('--check changes nothing: use --write-manifest with --yes');
  for (const f of ['google-idp', 'github-idp'] as const) {
    const v = args.str(f);
    if (v !== undefined && !IDP_ID_RE.test(v)) throw new CliError(`--${f} is a login method id (hex and hyphens)`);
  }

  const m = (deps.loadManifest ?? loadEnv)(envName);
  if (m.network !== 'testnet') throw new Error(`envs/${m.name}.json is not a testnet env`);
  const admin = m.admin;
  if (!admin) throw new Error(`envs/${m.name}.json has no admin block (docs/batch-c-build-plan.md setup step 12)`);
  const host = adminHost(admin.origin);
  const variant = accessVariant(m.name);
  const log = deps.log;
  if (variant === 'sandbox') {
    // D408, before any request: a seat per person who signs in; the free plan has 50.
    const n = admin.staffEmails.length;
    if (n > FREE_TIER_SEATS) throw new Error(`Refusing: admin.staffEmails has ${n} addresses; sandbox stays on Zero Trust's free tier, ${FREE_TIER_SEATS} seats (D408)`);
    if (n > SEAT_WARN_ABOVE) log(`Warning: admin.staffEmails has ${n} addresses, each a Zero Trust seat once used; sandbox's free tier ends at ${FREE_TIER_SEATS} (D408). Check seat usage in Zero Trust → Settings → Account.`);
  }

  const tokenFile = join(secretsDir(m.name, deps.secretsRoot), CLOUDFLARE_ACCESS_TOKEN_FILE);
  const api = new CloudflareApi(readCloudflareToken(tokenFile, `.secrets/${m.name}/${CLOUDFLARE_ACCESS_TOKEN_FILE}`), deps);
  const account = await resolveAccount(api, args.str('account-id') ?? deps.env.CLOUDFLARE_ACCOUNT_ID);
  const base = `/accounts/${account}/access`;

  // Read everything first: a refusal changes nothing.
  const org = (await api.request('GET', `${base}/organizations`, 'reading the Zero Trust organization', ACCESS_PERMISSIONS.org)).result as { auth_domain?: unknown } | null;
  const teamDomain = typeof org?.auth_domain === 'string' ? org.auth_domain.toLowerCase() : '';
  if (!teamDomain) throw new Error('This account has no Zero Trust team yet: create it in the Cloudflare dashboard (Zero Trust, Free plan), then run this again');
  if (!TEAM_DOMAIN_RE.test(teamDomain)) throw new Error(`The team domain ${teamDomain} isn't <team>.cloudflareaccess.com, which the manifest and the Workers expect`);
  const idps = asIdps(await api.list(`${base}/identity_providers`, 'listing the login methods', ACCESS_PERMISSIONS.org));
  const google = pickIdp(idps, 'google', args.str('google-idp'));
  const github = variant === 'production' ? pickIdp(idps, 'github', args.str('github-idp')) : undefined;
  if (variant === 'sandbox') {
    const others = [...new Set(idps.filter((i) => i.id !== google.id).map((i) => i.name || i.type))];
    if (others.length) log(`Note: this account also has the login method(s) ${others.join(', ')}; on sandbox Google should be the only one (D408): remove the others in Zero Trust → Settings → Authentication. The application allows Google only either way.`);
  }
  const want = desiredAccess(m.name, admin, { google: google.id, github: github?.id });
  // --check only reads: a token with the Read permission is enough for it.
  const readPerm = check ? ACCESS_PERMISSIONS.appsRead : ACCESS_PERMISSIONS.apps;
  const livePolicies = asPolicies(await api.list(`${base}/policies`, 'listing the Access policies', readPerm));
  const found = findApp(await api.list(`${base}/apps`, 'listing the Access applications', readPerm), host, want.app.name, log);
  const liveApp = found ? asApp((await api.request('GET', `${base}/apps/${found.id}`, 'reading the admin application', readPerm)).result) : undefined;
  if (found && !liveApp) throw new Error(`Cloudflare API: the admin application ${found.id} has no id in its answer`);

  const policyPlans = want.policies.map((p) => {
    const same = livePolicies.filter((l) => l.name === p.name);
    if (same.length > 1) throw new Error(`${same.length} Access policies are named ${JSON.stringify(p.name)}: delete the extras in the dashboard, then run this again`);
    const live = same[0];
    return { want: p, live, diffs: live ? policyDiffs(p, live, variant) : ['missing'] };
  });
  const appDiffList = liveApp ? appDiffs(want.app, liveApp, policyPlans.map((p) => p.live?.id), variant) : ['missing'];
  const liveAud = typeof liveApp?.aud === 'string' && AUD_RE.test(liveApp.aud) ? liveApp.aud : undefined;
  const manifestDiffs = (aud: string | undefined): string[] => [
    ...(admin.accessTeamDomain !== teamDomain ? [`admin.accessTeamDomain is ${admin.accessTeamDomain}; the team domain is ${teamDomain}`] : []),
    ...(aud && admin.accessAud !== aud ? [`admin.accessAud is ${admin.accessAud === 'UNSET' ? 'UNSET' : 'another AUD'}; the application's AUD tag is ${aud}`] : []),
    ...(!aud && admin.accessAud !== 'UNSET' ? ['admin.accessAud is set but no application exists yet'] : []),
  ];

  log(`Cloudflare Access for the admin console of envs/${m.name}.json (${variant === 'sandbox' ? 'Google, exact emails only' : `GitHub team ${GITHUB_TEAM} of ${GITHUB_ORG}, plus exact emails with Google`}):`);
  log(`  account       ${account}`);
  log(`  team domain   ${teamDomain}`);
  log(`  login methods ${[github && `GitHub (${github.id})`, `Google (${google.id})`].filter(Boolean).join(', ')}`);
  for (const p of policyPlans) {
    const what = p.want.name === policyNames(m.name).email ? `${admin.staffEmails.length} exact email(s), Google only` : `GitHub team ${GITHUB_ORG}/${GITHUB_TEAM}`;
    log(`  policy ${JSON.stringify(p.want.name)} (Allow, ${what}, ${SESSION_DURATION}): ${!p.live ? 'create' : p.diffs.length ? `update (${p.diffs.join('; ')})` : `matches (${p.live.id})`}`);
  }
  log(`  application ${JSON.stringify(want.app.name)} on ${host} (self-hosted, ${SESSION_DURATION}, no service tokens): ${!liveApp ? 'create' : appDiffList.length ? `update (${appDiffList.join('; ')})` : `matches (${liveApp.id})`}`);

  if (check) {
    const drift = [
      ...policyPlans.flatMap((p) => p.diffs.map((d) => `policy ${JSON.stringify(p.want.name)}: ${d}`)),
      ...appDiffList.map((d) => `application ${JSON.stringify(want.app.name)}: ${d}`),
      ...manifestDiffs(liveAud),
    ];
    if (!drift.length) return void log('No drift: Cloudflare Access matches the manifest.');
    for (const d of drift) log(`Drift: ${d}`);
    throw new Error(`${drift.length} difference(s) between envs/${m.name}.json and Cloudflare Access: run access-setup ${m.name} to see the plan, then with --yes to fix it`);
  }

  const changes = policyPlans.some((p) => p.diffs.length) || appDiffList.length > 0;
  if (!apply) {
    for (const d of manifestDiffs(liveAud)) log(`Manifest: ${d}`);
    return void log(changes || manifestDiffs(liveAud).length ? DRY_RUN_LINE : 'Nothing to change.');
  }

  const policyIds: string[] = [];
  for (const p of policyPlans) {
    if (!p.live) {
      const { result } = await api.request('POST', `${base}/policies`, `creating the policy ${JSON.stringify(p.want.name)}`, ACCESS_PERMISSIONS.apps, policyBody(p.want));
      const id = (result as { id?: unknown } | null)?.id;
      if (typeof id !== 'string') throw new Error(`Cloudflare API: the new policy ${JSON.stringify(p.want.name)} has no id in the answer; run this again (it finds the policy by name)`);
      log(`Created policy ${JSON.stringify(p.want.name)} (${id}).`);
      policyIds.push(id);
    } else {
      if (p.diffs.length) {
        await api.request('PUT', `${base}/policies/${p.live.id}`, `updating the policy ${JSON.stringify(p.want.name)}`, ACCESS_PERMISSIONS.apps, policyBody(p.want));
        log(`Updated policy ${JSON.stringify(p.want.name)} (${p.live.id}).`);
      }
      policyIds.push(p.live.id);
    }
  }

  let app = liveApp;
  if (!liveApp || appDiffs(want.app, liveApp, policyIds, variant).length) {
    const body = appBody(want.app, policyIds);
    const { result } = liveApp
      ? await api.request('PUT', `${base}/apps/${liveApp.id}`, 'updating the admin application', ACCESS_PERMISSIONS.apps, body)
      : await api.request('POST', `${base}/apps`, 'creating the admin application', ACCESS_PERMISSIONS.apps, body);
    app = asApp(result);
    if (!app) throw new Error('Cloudflare API: the admin application has no id in the answer; run this again (it finds the application by host)');
    log(`${liveApp ? 'Updated' : 'Created'} application ${JSON.stringify(want.app.name)} (${app.id}).`);
  }
  const aud = typeof app!.aud === 'string' && AUD_RE.test(app!.aud) ? app!.aud : undefined;
  if (!aud) throw new Error(`Cloudflare API: the admin application ${app!.id} has no 64-hex AUD tag in the answer`);

  log('');
  log(`Application id  ${app!.id}`);
  log(`Team domain     ${teamDomain}`);
  log(`AUD tag         ${aud}`);
  const pending = manifestDiffs(aud);
  if (!pending.length) return void log(`envs/${m.name}.json already has this team domain and AUD tag.`);
  if (writeManifest) {
    const file = (deps.manifestFile ?? manifestPath)(m.name);
    if (!existsSync(file)) throw new Error(`${file} is missing`);
    writeFileAtomic(file, setAdminAccess(readFileSync(file, 'utf8'), { accessTeamDomain: teamDomain, accessAud: aud }));
    log(`Wrote admin.accessTeamDomain and admin.accessAud into envs/${m.name}.json: commit it, then re-run the admin Worker's gen and deploy (and the email issuer's, whose ADMIN_ACCESS_AUD comes from it).`);
    return;
  }
  log(`Put them into envs/${m.name}.json's admin block ("accessTeamDomain": "${teamDomain}", "accessAud": "${aud}"), or run this again with --yes --write-manifest; then the admin Worker's gen and deploy.`);
}
