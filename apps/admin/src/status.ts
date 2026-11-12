// `GET /api/status` (D425; apps/admin/README.md "System status"): the admin console's landing page, a bird's-eye view
// of the whole env. Every source is read in parallel and fails on its own; each check maps to a tile (ok, warning,
// critical, unknown, not measured) and each problem to an issue with what it affects, since when, what to do and the
// screen or playbook that resolves it. Unknown is never green: a check that should have answered and didn't is an
// issue (unless the failure that hid it is one already). Read-only: nothing here writes, acts or alerts.
//
// Budget (Workers Free: 50 subrequests, 10 ms CPU): one cold read makes at most 1 watchdog call, 3 RPCs, 10 public
// build reads, one NEAR read per endpoint (`nearEndpoints`: 3 on sandbox-dev, at most 5), 1 Hyperdrive connection and
// 2 R2 reads (20 on sandbox-dev, at most 22, counted in `calls`); the Access check before the route adds its certs
// fetch on a cold isolate. The answer is kept in the isolate for STATUS_CACHE_MS and
// concurrent misses share one read, so refreshes and other tabs cost nothing within that window. Nothing is added to
// any cron.
import { ACCESS_JWT_HEADER } from '@hana-id/oidc';
import { getPlaybook } from '@hana-id/playbooks';
import type { ApiSystemStatus, ConsoleHealth, CronRunView } from '@hana-id/console-core';
import { BUILD_ID_RE, parseBuildId } from '@hana-id/env/build-id';
import { CRON_LAST_RUN } from './cron.ts';
import type { Env } from './env.ts';
import { errorResponse, json } from './http.ts';
import { LEDGER_LAST_RUN } from './ledger-cron.ts';
import { ledgerSource } from './ledger.ts';
import { errorName, log } from './log.ts';
import { RUN_BUDGET, linkKey } from './mail.ts';
import { type WatchdogStatusView, findingsOf, statusView } from './monitoring.ts';
import { arr, num, obj, plainString, str } from './plain.ts';
import { type StaffRequest, staffCtx } from './rpc.ts';
import { MIN_PARTITIONS_AHEAD } from './security.ts';
import { type BuildRead, CallCount, type NearEndpoint, type NearRead, SLOW_MS, buildTargets, nearEndpoints, readBuild, readNear } from './status-probes.ts';
import { callWatchdog, watchdogConfigured } from './watchdog.ts';

/** How long one read serves every request of the isolate. */
export const STATUS_CACHE_MS = 30_000;
/** The Free plan's cron triggers per account (D417; docs/operations.md "Plan limits on sandbox-dev"). */
export const FREE_PLAN_CRON_LIMIT = 5;
/** A cron run's calls at or above this, of RUN_BUDGET, is a backlog (docs/operations.md "What to watch", D380). */
export const BUDGET_WARN_CALLS = 38;
/** A D1 probe slower than this is amber. */
export const DB_SLOW_MS = 1_000;
/** The watchdog's relayer reading older than this is stale (it reads every 5-minute run). */
export const FUNDS_STALE_MS = 30 * 60_000;
/** A NEAR endpoint's final block older than these is behind (amber) or stuck (red). */
export const NEAR_BEHIND_MS = 2 * 60_000;
export const NEAR_STUCK_MS = 10 * 60_000;
/** A blocking notice waiting longer than these (the 5-minute cron sends them). */
export const NOTICE_WARN_MS = 15 * 60_000;
export const NOTICE_CRITICAL_MS = 60 * 60_000;
/** The settlement backlog's oldest event older than this (settlement runs every 15 minutes). */
export const SETTLEMENT_WARN_MS = 2 * 60 * 60_000;

const MIN = 60_000;

/** Each cron: its interval, late after 2 intervals + 5 min (amber), stuck after 6 (red). */
export const CRON_INTERVALS = { apiSync: 15 * MIN, adminFive: 5 * MIN, adminFifteen: 15 * MIN, consoleHourly: 60 * MIN } as const;
export const lateAfter = (intervalMs: number): number => 2 * intervalMs + 5 * MIN;
export const stuckAfter = (intervalMs: number): number => 6 * intervalMs;

// ---- the answer ----

export type TileState = 'ok' | 'warning' | 'critical' | 'unknown' | 'not_measured';
export type Severity = 'critical' | 'warning';
export interface Link {
  path: string;
  label: string;
}

export interface Tile {
  id: string;
  group: GroupId;
  name: string;
  state: TileState;
  /** One line: what was seen (latency, build, counts, ages), or why it couldn't be. */
  detail: string;
  /** What breaks when this is down, in plain words. */
  affects: string;
  latencyMs: number | null;
  build: string | null;
  link: Link | null;
  /** One line per part of the component when it has several: the NEAR RPC tile's endpoints. Never a URL. */
  lines?: TileLine[];
}

export interface TileLine {
  label: string;
  state: TileState;
  detail: string;
}

export interface Issue {
  id: string;
  severity: Severity;
  /** The tile it belongs to. */
  component: string;
  componentName: string;
  title: string;
  affects: string;
  /** What to do, in plain words. */
  action: string;
  /** Since when: from the source (`source`), else when this isolate first saw it (`first_seen`). */
  since: number;
  sinceSource: 'source' | 'first_seen';
  link: Link | null;
  playbook: { id: string; title: string } | null;
}

export const GROUPS = [
  { id: 'workers', title: 'Workers' },
  { id: 'contract', title: 'Contract and watchdog' },
  { id: 'funds', title: 'Relayer funds' },
  { id: 'data', title: 'Data' },
  { id: 'jobs', title: 'Scheduled jobs' },
  { id: 'external', title: 'External services' },
  { id: 'headroom', title: 'Free-tier headroom' },
] as const;
export type GroupId = (typeof GROUPS)[number]['id'];

export interface StatusAnswer {
  checkedAt: number;
  env: string;
  verdict: { state: 'ok' | 'warning' | 'critical'; title: string; critical: number; warning: number };
  issues: Issue[];
  groups: { id: GroupId; title: string; tiles: Tile[] }[];
  builds: { majority: string | null; mixed: boolean; pieces: { component: string; build: string }[] };
  notMeasured: { what: string; why: string }[];
  /** This read's outbound calls (the page's subrequest budget). */
  calls: { total: number; byKind: Record<string, number> };
  cacheMs: number;
}

// ---- building it ----

interface Problem {
  /** `unknown`: the check couldn't be made (a warning issue, unless `issue` is false). */
  severity: Severity | 'unknown';
  title: string;
  action: string;
  /** False: the tile shows it, but another issue already says why (no duplicate). */
  issue?: boolean;
  since?: number | null;
  link?: Link | null;
  playbook?: string;
  key?: string;
}

interface TileInput {
  id: string;
  group: GroupId;
  name: string;
  affects: string;
  detail: string;
  latencyMs?: number | null;
  build?: string | null;
  link?: Link | null;
  notMeasured?: boolean;
  lines?: TileLine[];
}

const RANK: Record<TileState, number> = { critical: 4, warning: 3, unknown: 2, ok: 1, not_measured: 0 };

/** Issues this isolate has seen, with when it first saw each (the "since" of an issue whose source has no time). */
const firstSeen = new Map<string, number>();

class Report {
  readonly tiles: Tile[] = [];
  readonly issues: Issue[] = [];
  constructor(readonly now: number) {}

  add(t: TileInput, problems: Problem[] = []): void {
    let state: TileState = t.notMeasured ? 'not_measured' : 'ok';
    for (const p of problems) if (RANK[p.severity] > RANK[state]) state = p.severity;
    this.tiles.push({ id: t.id, group: t.group, name: t.name, state, detail: t.detail, affects: t.affects, latencyMs: t.latencyMs ?? null, build: t.build ?? null, link: t.link ?? null, ...(t.lines ? { lines: t.lines } : {}) });
    for (const p of problems) {
      if (p.issue === false) continue;
      const pb = p.playbook ? getPlaybook(p.playbook) : undefined;
      const id = `${t.id}:${p.key ?? p.title.slice(0, 80)}`;
      this.issues.push({
        id,
        severity: p.severity === 'critical' ? 'critical' : 'warning',
        component: t.id,
        componentName: t.name,
        title: p.title,
        affects: t.affects,
        action: p.action,
        since: typeof p.since === 'number' && Number.isFinite(p.since) ? p.since : 0,
        sinceSource: typeof p.since === 'number' && Number.isFinite(p.since) ? 'source' : 'first_seen',
        link: p.link ?? t.link ?? null,
        playbook: pb ? { id: pb.id, title: pb.title } : null,
      });
    }
  }

  /** The "since" of each issue without a source time: when this isolate first saw it; forgotten once it's gone. */
  settleSince(): void {
    const present = new Set(this.issues.map((i) => i.id));
    for (const k of [...firstSeen.keys()]) if (!present.has(k)) firstSeen.delete(k);
    for (const i of this.issues) {
      if (i.sinceSource === 'source') continue;
      const seen = firstSeen.get(i.id) ?? this.now;
      firstSeen.set(i.id, seen);
      i.since = seen;
    }
  }
}

const ago = (ms: number): string => (ms < 90_000 ? `${Math.max(0, Math.round(ms / 1000))} s` : ms < 90 * MIN ? `${Math.round(ms / MIN)} min` : ms < 48 * 60 * MIN ? `${Math.round(ms / (60 * MIN))} h` : `${Math.round(ms / (24 * 60 * MIN))} d`);
const ms = (v: number): string => (v < 1000 ? `${v} ms` : `${(v / 1000).toFixed(1)} s`);

/** yoctoNEAR (a decimal string) → "12.3456 NEAR"; null for anything else. */
export function nearAmount(yocto: unknown): string | null {
  if (typeof yocto !== 'string' || !/^\d{1,40}$/u.test(yocto)) return null;
  const v = BigInt(yocto);
  const whole = v / 10n ** 24n;
  const frac = ((v % 10n ** 24n) / 10n ** 20n).toString().padStart(4, '0').replace(/0+$/u, '');
  return `${whole}${frac ? `.${frac}` : ''} NEAR`;
}
const yocto = (v: unknown): bigint | null => (typeof v === 'string' && /^\d{1,40}$/u.test(v) ? BigInt(v) : null);

// ---- the sources ----

type Settled<T> = { ok: true; value: T } | { ok: false; code: string };

async function rpc<T>(route: string, staff: StaffRequest, calls: CallCount, call: () => Promise<({ ok: true } & T) | { ok: false; code: string }>): Promise<Settled<T>> {
  calls.take('rpc');
  try {
    const r = await call();
    if (!r.ok) {
      log({ event: 'bff', route, requestId: staff.requestId, outcome: 'rejected', code: r.code });
      return { ok: false, code: r.code };
    }
    const { ok: _ok, ...rest } = r;
    return { ok: true, value: rest as unknown as T };
  } catch (err) {
    log({ event: 'bff', route, requestId: staff.requestId, outcome: 'error', code: 'upstream_unavailable', error: errorName(err) }, 'warn');
    return { ok: false, code: 'upstream_unavailable' };
  }
}

interface LedgerPart {
  bound: boolean;
  ok: boolean;
  state: Map<string, { value: string; updatedAt: number }>;
  partitionsAhead: number | null;
  settlement: { pending: number; oldestAt: number | null } | null;
}

async function ledgerPart(env: Env, staff: StaffRequest, calls: CallCount): Promise<LedgerPart> {
  if (!env.USAGE_DB) return { bound: false, ok: false, state: new Map(), partitionsAhead: null, settlement: null };
  calls.take('hyperdrive');
  try {
    const store = await ledgerSource.open(env.USAGE_DB);
    if (!store) return { bound: false, ok: false, state: new Map(), partitionsAhead: null, settlement: null };
    try {
      const state = await store.state.getState([CRON_LAST_RUN, LEDGER_LAST_RUN]);
      const partitionsAhead = await store.partitionsAhead();
      const settlement = await store.settlementBacklog();
      return { bound: true, ok: true, state, partitionsAhead, settlement };
    } finally {
      await store.close();
    }
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/status', requestId: staff.requestId, outcome: 'error', code: 'ledger_unavailable', error: errorName(err) }, 'warn');
    return { bound: true, ok: false, state: new Map(), partitionsAhead: null, settlement: null };
  }
}

/** A `get` of a key nothing writes (a Class B read; `get` and `put` are the only bucket methods this Worker uses). */
async function bucketPart(bucket: R2Bucket | undefined, calls: CallCount): Promise<'ok' | 'error' | null> {
  if (!bucket) return null;
  calls.take('r2');
  try {
    const o = await bucket.get('health/never-written');
    await o?.body.cancel().catch(() => {});
    return 'ok';
  } catch {
    return 'error';
  }
}

interface Sources {
  watchdog: { configured: boolean; ok: true; view: WatchdogStatusView; build: string | null | undefined } | { configured: boolean; ok: false; code: string };
  api: Settled<ApiSystemStatus>;
  console: Settled<ConsoleHealth>;
  issuer: Settled<{ build: string | null; db: { ok: boolean; latencyMs: number } }> | null;
  builds: Map<string, BuildRead>;
  near: { endpoint: NearEndpoint; read: NearRead }[];
  ledger: LedgerPart;
  statements: 'ok' | 'error' | null;
  exports: 'ok' | 'error' | null;
}

async function gatherSources(env: Env, staff: StaffRequest, accessJwt: string, now: number, calls: CallCount): Promise<Sources> {
  const ctx = staffCtx(staff);
  const targets = buildTargets(env);
  const watchdog = (async (): Promise<Sources['watchdog']> => {
    const configured = watchdogConfigured(env);
    if (configured) calls.take('watchdog');
    const a = await callWatchdog(env, 'status', '/status', { requestId: staff.requestId });
    if (!a.ok) return { configured, ok: false, code: a.code };
    if (a.status !== 200) return { configured, ok: false, code: 'watchdog_bad_answer' };
    const raw = obj(a.body)?.build;
    const build = raw === undefined ? undefined : typeof raw === 'string' && BUILD_ID_RE.test(raw) ? raw : null;
    return { configured, ok: true, view: statusView(a.body, now, env.NEAR_NETWORK), build };
  })();
  const [w, api, con, issuer, builds, near, ledger, statements, exportsBucket] = await Promise.all([
    watchdog,
    rpc<ApiSystemStatus>('GET /api/status api', staff, calls, () => env.API.systemStatus(ctx)),
    rpc<ConsoleHealth>('GET /api/status console', staff, calls, () => env.CONSOLE.health(ctx)),
    env.ISSUER ? rpc<{ build: string | null; db: { ok: boolean; latencyMs: number } }>('GET /api/status issuer', staff, calls, () => env.ISSUER!.health({ requestId: staff.requestId, accessJwt })) : Promise.resolve(null),
    Promise.all(targets.map(async (t) => [t.id, await readBuild(t, calls)] as const)).then((e) => new Map(e)),
    Promise.all(nearEndpoints(env).map(async (endpoint) => ({ endpoint, read: await readNear(endpoint.url, calls) }))),
    ledgerPart(env, staff, calls),
    bucketPart(env.STATEMENTS, calls),
    bucketPart(env.EXPORTS, calls),
  ]);
  return { watchdog: w, api, console: con, issuer, builds, near, ledger, statements, exports: exportsBucket };
}

// ---- the checks ----

const L = {
  monitoring: { path: '/security/monitoring', label: 'Security & monitoring' },
  upgrades: { path: '/security/upgrades', label: 'Pending upgrades' },
  feed: { path: '/security', label: 'Feed and notices' },
  retention: { path: '/retention', label: 'Retention' },
} as const;

const DEPLOY_ACTION = 'Check its logs in the Cloudflare dashboard (Workers & Pages → the Worker → Logs). If a deploy just went out, finish it or roll back (`wrangler rollback`), then run `deploy-check` (docs/operations.md "Checking a deploy").';

const WORKERS: Record<string, { name: string; affects: string; app: string }> = {
  api: { name: 'API', affects: 'Every login, wallet and partner app', app: 'api' },
  vault: { name: 'Vault Worker', affects: 'Logins and wallets (the vault page partners embed)', app: 'api (run deploy:pages)' },
  'vault-bundle': { name: 'Vault bundle (vault.js)', affects: 'Logins and wallets (the vault page partners embed)', app: 'api (run deploy:pages)' },
  auth: { name: 'Auth Worker', affects: 'The Google and email login pages', app: 'api (run deploy:pages)' },
  'auth-pages': { name: 'Auth pages', affects: 'The Google and email login pages', app: 'api (run deploy:pages)' },
  issuer: { name: 'Email issuer', affects: 'Email login, and the Users screen here', app: 'email-issuer' },
  console: { name: 'Partner console Worker', affects: 'The partner console', app: 'console' },
  'console-spa': { name: 'Partner console SPA', affects: 'The partner console', app: 'console' },
  'console-auth': { name: 'Console sign-in (console-auth)', affects: 'Signing in to the partner console', app: 'console-auth' },
  files: { name: 'Files (partner logos)', affects: 'Partner logos on the login pages and in the console', app: 'files' },
};

const FAILURE_WORDS: Record<string, string> = {
  timeout: 'didn’t answer within 5 s',
  unreachable: 'couldn’t be reached',
  redirect: 'answered with a redirect (not followed)',
  too_large: 'answered with more than expected',
  bad_answer: 'answered something that isn’t its build endpoint',
};

function workerTiles(r: Report, env: Env, s: Sources): void {
  for (const [id, meta] of Object.entries(WORKERS)) {
    const read = s.builds.get(id);
    const base: TileInput = { id, group: 'workers', name: meta.name, affects: meta.affects, detail: '' };
    if (!read) {
      r.add({ ...base, detail: 'Not part of this env (no URL in the manifest)', notMeasured: true });
      continue;
    }
    const problems: Problem[] = [];
    if (!read.ok) {
      const what = read.failure === 'http_error' ? `answered HTTP ${read.status}` : FAILURE_WORDS[read.failure ?? 'unreachable'];
      problems.push({ severity: 'critical', title: `${meta.name} is down: it ${what}`, action: DEPLOY_ACTION, key: 'down' });
      r.add({ ...base, detail: `Down: ${what}`, latencyMs: read.latencyMs }, problems);
      continue;
    }
    if (read.latencyMs > SLOW_MS) problems.push({ severity: 'warning', title: `${meta.name} is slow: ${ms(read.latencyMs)} to answer`, action: 'Check Cloudflare’s status page and the Worker’s logs; it usually passes.', key: 'slow' });
    if (!read.build) problems.push({ severity: 'warning', title: `${meta.name} carries no build id`, action: `It was deployed without its \`run deploy\` (or before build ids, D406): redeploy it with \`corepack pnpm --filter @hana-id/${meta.app} run deploy\` from a clean checkout.`, key: 'unstamped' });
    r.add({ ...base, detail: `Up · ${ms(read.latencyMs)} · ${read.build ? `build ${read.build}` : 'no build id'}`, latencyMs: read.latencyMs, build: read.build }, problems);
  }

  // This Worker: it answered. Its build and the secrets its crons need (present or missing; never a value).
  const own = typeof env.HANA_BUILD === 'string' && BUILD_ID_RE.test(env.HANA_BUILD) ? env.HANA_BUILD : null;
  const adminProblems: Problem[] = [];
  const missing = [!env.EMAIL_API_KEY ? 'EMAIL_API_KEY' : null, !linkKey(env.CANCEL_LINK_KEY) ? 'CANCEL_LINK_KEY' : null, !linkKey(env.INVITE_LINK_KEY) ? 'INVITE_LINK_KEY' : null].filter((x): x is string => x !== null);
  if (missing.length) adminProblems.push({ severity: 'critical', title: `This console’s Worker is missing ${missing.join(', ')}: no blocking notice can go out`, action: 'Set the secret (docs/operations.md "Admin Worker", step 3). Until then guarded changes, invites and owner grants stay unannounced.', key: 'secrets' });
  if (!own) adminProblems.push({ severity: 'warning', title: 'This console’s Worker carries no build id', action: 'Redeploy it with `corepack pnpm --filter @hana-id/admin run deploy` from a clean checkout.', key: 'unstamped' });
  r.add({ id: 'admin', group: 'workers', name: 'Admin console (this Worker)', affects: 'This console, and its emails: blocking notices, the feed, the watcher', detail: `Up · ${own ? `build ${own}` : 'no build id'} · ${missing.length ? `missing ${missing.join(', ')}` : 'email and link keys set'}`, build: own }, adminProblems);

  // The watchdog Worker: reachable from here, and its build (served from D425).
  const w = s.watchdog;
  const wd: TileInput = { id: 'watchdog-worker', group: 'workers', name: 'Watchdog', affects: 'Alerts: the watchdog pages and emails on its own, and pauses the contract on a forged key', detail: '', link: L.monitoring };
  if (!w.ok) {
    const why = w.code === 'watchdog_unconfigured' ? 'isn’t configured for this console (WATCHDOG_URL or its status token missing)' : w.code === 'watchdog_unauthorized' ? 'refused this console’s status token (the two copies differ)' : w.code === 'watchdog_timeout' ? 'didn’t answer within 8 s' : w.code === 'watchdog_unavailable' ? 'didn’t answer (a network error or a server error)' : 'didn’t answer as expected';
    r.add({ ...wd, detail: `Can’t be read: ${w.code}` }, [{ severity: 'critical', title: `The watchdog ${why}: its heartbeat, checks and alerts are unknown here`, action: 'Its own alerts don’t depend on this console. Follow the playbook; the table in docs/operations.md "Security & monitoring" maps each code to a fix.', playbook: 'watchdog-down', key: 'down' }]);
  } else {
    const problems: Problem[] = [];
    if (w.build === undefined) problems.push({ severity: 'warning', title: 'The watchdog doesn’t report its build (deployed before D425)', action: 'Redeploy it with `corepack pnpm --filter @hana-id/watchdog run deploy` from this checkout.', key: 'unstamped' });
    else if (w.build === null) problems.push({ severity: 'warning', title: 'The watchdog carries no build id', action: 'Redeploy it with `corepack pnpm --filter @hana-id/watchdog run deploy` from a clean checkout.', key: 'unstamped' });
    r.add({ ...wd, detail: `Up · ${w.build ? `build ${w.build}` : 'no build id'}`, build: w.build ?? null }, problems);
  }

  // One build everywhere (as deploy-check): the stamped pieces compared by commit.
  const pieces = r.tiles.filter((t) => t.group === 'workers' && t.build).map((t) => ({ component: t.id, name: t.name, build: t.build! }));
  const byCommit = new Map<string, string[]>();
  for (const p of pieces) {
    const c = parseBuildId(p.build)!.commit;
    byCommit.set(c, [...(byCommit.get(c) ?? []), p.name]);
  }
  const ranked = [...byCommit.entries()].sort((a, b) => b[1].length - a[1].length);
  const majority = ranked[0]?.[0] ?? null;
  const dirty = pieces.filter((p) => p.build.endsWith('-dirty')).length;
  const problems: Problem[] = [];
  if (ranked.length > 1) {
    const others = ranked.slice(1).map(([c, names]) => `${names.join(', ')} on ${c}`).join('; ');
    problems.push({ severity: 'warning', title: `Mixed builds: ${others}; the rest on ${majority}`, action: 'A deploy is half done: deploy the lagging pieces from the same checkout, then run `deploy-check <env>` (docs/operations.md "Checking a deploy").', key: 'mixed' });
  }
  r.add(
    { id: 'builds', group: 'workers', name: 'Same build everywhere', affects: 'Every piece talking to the others as tested (a stale vault bundle broke wallet records on 2026-11-05)', detail: pieces.length === 0 ? 'No stamped piece to compare' : ranked.length > 1 ? `${ranked.length} builds across ${pieces.length} pieces` : `All ${pieces.length} stamped pieces on ${majority}${dirty ? ` (${dirty} from a tree with uncommitted changes)` : ''}` },
    pieces.length === 0 ? [{ severity: 'unknown', title: 'No piece reported a build id to compare', action: 'See the Workers above.', issue: false }] : problems,
  );
}

const apiRpcProblem = (code: string): Problem => ({
  severity: 'unknown',
  title: `The API didn’t answer this page’s status call (${code})`,
  action: code === 'upstream_unavailable' ? 'If the API was deployed before this release it lacks AdminRpc.systemStatus: deploy it. Else check the API Worker’s logs.' : 'Check the API Worker’s logs for `admin.systemStatus`.',
  key: 'rpc',
});

function contractTiles(r: Report, env: Env, s: Sources): void {
  const base: TileInput = { id: 'contract', group: 'contract', name: 'Contract (hana-signer)', affects: 'Logins (a paused contract refuses derivation and new sessions) and every on-chain change', detail: '', link: L.monitoring };
  if (!s.api.ok) r.add({ ...base, detail: 'Unknown: the API didn’t answer' }, [{ ...apiRpcProblem(s.api.code), issue: false }]);
  else if (!s.api.value.governance.ok) r.add({ ...base, detail: `Unknown: the API couldn’t read the contract (${s.api.value.governance.code})` }, [{ severity: 'unknown', title: `The contract’s governance state can’t be read (${s.api.value.governance.code})`, action: 'Usually NEAR RPC: see External services. The playbook covers an RPC outage.', playbook: 'near-rpc-outage', key: 'unreadable' }]);
  else {
    const g = s.api.value.governance.snapshot;
    const findings = findingsOf({ env: env.ENV_NAME, now: r.now, watchdog: { ok: false, code: 'watchdog_unconfigured' }, governance: { ok: true, data: g } }).filter((f) => f.source === 'governance' && f.severity !== 'info');
    const up = obj(g.pendingUpgrade);
    const changes = arr(g.keyChanges).map((c) => obj(c) ?? {});
    const problems: Problem[] = findings.map((f) => {
      const change = /\(change (\d+)\)/u.exec(f.text);
      const kc = change ? changes.find((c) => num(c.id) === Number(change[1])) : undefined;
      const since = f.text.startsWith('Upgrade proposed') ? num(up?.proposedAtMs) : kc ? num(kc.proposedAtMs) : null;
      return { severity: f.severity === 'critical' ? 'critical' : 'warning', title: f.text, action: 'Open the screen and follow the playbook: check whether it was expected (an owner action you planned) before anything else.', since, link: f.text.startsWith('Upgrade proposed') ? L.upgrades : L.monitoring, ...(f.playbook ? { playbook: f.playbook.id } : {}), key: f.text.slice(0, 80) };
    });
    const queued = [up ? 'an upgrade' : null, obj(g.pendingOwner) ? 'an owner transfer' : null, obj(g.pendingWithdrawal) ? 'a withdrawal' : null].filter(Boolean);
    r.add({ ...base, detail: `${g.paused === true ? 'Paused' : 'Not paused'} · ${queued.length ? `queued: ${queued.join(', ')}` : 'no owner action queued'} · ${changes.length} Google key change${changes.length === 1 ? '' : 's'} pending` }, problems);
  }

  const wbase: TileInput = { id: 'watchdog', group: 'contract', name: 'Watchdog checks', affects: 'Alerts and the watchdog’s protective actions (pause, cancel a forged key change)', detail: '', link: L.monitoring };
  const w = s.watchdog;
  if (!w.ok) {
    r.add({ ...wbase, detail: 'Unknown: the watchdog can’t be read (see Workers)' }, [{ severity: 'unknown', title: 'Watchdog unreadable', action: '', issue: false }]);
    return;
  }
  const v = w.view;
  const problems: Problem[] = [];
  const hb = obj(v.heartbeat);
  if (hb && hb.configured === false) problems.push({ severity: 'warning', title: 'The watchdog’s dead-man’s switch isn’t configured: nobody hears if it stops', action: 'Set it up (docs/operations.md "Watchdog service").', playbook: 'watchdog-degraded', key: 'heartbeat-off' });
  else if (hb && hb.ok === false) problems.push({ severity: 'warning', title: 'The watchdog’s dead-man’s switch ping is failing', action: 'Follow the playbook.', since: num(hb.last_ok_at), playbook: 'watchdog-degraded', key: 'heartbeat-failing' });
  const ch = obj(v.channels);
  const off = ['pager', 'slack', 'email'].filter((n) => ch && obj(ch[n])?.configured === false);
  for (const n of off) problems.push({ severity: 'warning', title: `The watchdog’s ${n} alert channel is off`, action: 'Alerts of this kind reach nobody on that channel: configure it (docs/operations.md "Watchdog service").', playbook: 'watchdog-degraded', key: `channel-${n}` });
  for (const a of v.openAlerts) {
    if (a.severity !== 'critical' && a.severity !== 'warning') continue;
    problems.push({
      severity: a.severity,
      title: `Watchdog alert #${a.id}: ${plainString(a.title, 200)}${a.canAck ? ' (not acknowledged: re-sent every 15 min)' : ''}`,
      action: a.canAck ? 'Read it in Security & monitoring; if it’s expected, acknowledge it there (that stops the re-sends only). Then follow its playbook.' : 'Follow its playbook; the alert clears when the condition does.',
      since: a.createdAt,
      ...(a.playbook ? { playbook: a.playbook.id } : {}),
      key: `alert-${a.id}`,
    });
  }
  for (const c of v.checks) if (c.outcome === 'error') problems.push({ severity: 'warning', title: `The watchdog’s check “${c.title}” failed${c.detail ? `: ${plainString(c.detail, 200)}` : ''}`, action: 'See the checks table in Security & monitoring.', key: `check-${c.id}` });
  const unacked = v.openAlerts.filter((a) => a.canAck).length;
  r.add({ ...wbase, detail: `Heartbeat ${hb?.configured === false ? 'off' : hb?.ok === false ? 'failing' : 'ok'} · ${3 - off.length} of 3 channels on · ${v.openAlerts.length} open alert${v.openAlerts.length === 1 ? '' : 's'}${unacked ? ` (${unacked} not acknowledged)` : ''}` }, problems);
}

function fundsTiles(r: Report, s: Sources): void {
  const tiles = [
    { id: 'relayer-balance', name: 'Relayer balance', affects: 'Every relayed call: logins and owner actions (it pays their gas)' },
    { id: 'session-pool', name: 'Session pool keys', affects: 'Logins (each session-pool key pays a login’s gas within its allowance)' },
    { id: 'owner-pool', name: 'Owner pool keys', affects: 'Owner actions from the partner console' },
    { id: 'home-pool', name: 'Home pool keys', affects: 'Passport Home: a user opening their wallet without the partner’s app' },
  ] as const;
  const add = (i: 0 | 1 | 2 | 3, detail: string, problems: Problem[]) => r.add({ ...tiles[i], group: 'funds', detail, link: L.monitoring }, problems);
  const w = s.watchdog;
  if (!w.ok) {
    for (const i of [0, 1, 2, 3] as const) add(i, 'Unknown: read by the watchdog, which can’t be read (see Workers)', [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
    return;
  }
  const f = obj(w.view.relayerFunds);
  if (!f) {
    add(0, 'Unknown: the watchdog has no relayer reading yet', [{ severity: 'unknown', title: 'The watchdog has no relayer reading yet', action: 'It reads the relayer every run: wait one run, else check its `relayer_funds` check in Security & monitoring.', key: 'no-reading' }]);
    for (const i of [1, 2, 3] as const) add(i, 'Unknown: no relayer reading yet', [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
    return;
  }
  const at = num(f.at);
  const stale: Problem[] = at !== null && r.now - at > FUNDS_STALE_MS ? [{ severity: 'warning', title: `The relayer reading is ${ago(r.now - at)} old`, action: 'The watchdog reads it every run: check its `relayer_funds` check.', since: at, key: 'stale' }] : [];
  const t = obj(f.thresholds) ?? {};
  const pair = (k: string) => {
    const p = obj(t[k]);
    return { warn: yocto(p?.warn), critical: yocto(p?.critical) };
  };
  const judge = (v: bigint | null, th: { warn: bigint | null; critical: bigint | null }): Severity | null => (v === null ? null : th.critical !== null && v < th.critical ? 'critical' : th.warn !== null && v < th.warn ? 'warning' : null);

  // Balance.
  const avail = yocto(f.available);
  const balanceProblems: Problem[] = [...stale];
  if (f.exists === false) balanceProblems.push({ severity: 'critical', title: `The relayer account ${str(f.account) ?? ''} doesn’t exist on chain`, action: 'Follow the playbook.', playbook: 'relayer-out-of-funds', key: 'missing' });
  else {
    const sev = judge(avail, pair('balance'));
    if (sev) balanceProblems.push({ severity: sev, title: `The relayer’s balance is low: ${nearAmount(f.available)} available`, action: 'Top up the relayer account (the playbook says how much and from where).', playbook: 'relayer-out-of-funds', key: 'low' });
  }
  add(0, `${nearAmount(f.available) ?? 'unknown'} available${at !== null ? ` · read ${ago(r.now - at)} ago` : ''}`, balanceProblems);

  // Each pool: the keys on the account, their lowest allowance, and the API's pool keys that aren't there.
  const keys = arr(f.keys).map((k) => obj(k) ?? {});
  const apiKeys = s.api.ok ? s.api.value.relayerKeys : null;
  for (const [i, pool, label] of [[1, 'session', 'session'], [2, 'owner', 'owner'], [3, 'home', 'Home']] as const) {
    const mine = keys.filter((k) => k.pool === pool);
    // An env with no Home key anywhere (none in the API, none on chain) doesn't run Home derives: nothing to judge. With
    // none on chain and the API unreadable it can't be told apart from that, and the API's own tile already says so.
    if (pool === 'home' && mine.length === 0 && !apiKeys?.some((k) => k.pool === 'home')) {
      r.add({ ...tiles[i], group: 'funds', detail: apiKeys ? 'No Home key in this env: Passport Home derives are off' : 'No Home key on chain; the API’s pool can’t be read', notMeasured: true, link: L.monitoring });
      continue;
    }
    const problems: Problem[] = [...stale.map((p) => ({ ...p, issue: false }))];
    const limited = mine.map((k) => ({ pk: str(k.public_key) ?? '', allowance: k.allowance === null ? null : yocto(k.allowance) }));
    const finite = limited.filter((k): k is { pk: string; allowance: bigint } => k.allowance !== null);
    const lowest = finite.sort((a, b) => (a.allowance < b.allowance ? -1 : a.allowance > b.allowance ? 1 : 0))[0];
    if (mine.length === 0) problems.push({ severity: pool === 'session' ? 'critical' : 'warning', title: `No ${label}-pool key on the relayer account`, action: 'Add the pool’s keys (docs/operations.md "Relayer keys (either pool)").', playbook: 'relayer-out-of-funds', key: 'none' });
    else if (lowest) {
      const sev = judge(lowest.allowance, pair(pool));
      if (sev) problems.push({ severity: sev, title: `A ${label}-pool key’s allowance is low: ${nearAmount(lowest.allowance.toString())} left (${lowest.pk.slice(0, 16)}…)`, action: 'Rotate in a fresh key (docs/operations.md "Relayer keys (either pool)").', playbook: 'relayer-out-of-funds', key: 'low' });
    }
    if (apiKeys) {
      const onChain = new Set(mine.map((k) => k.public_key));
      const absent = apiKeys.filter((k) => k.pool === pool && !onChain.has(k.publicKey));
      if (absent.length) problems.push({ severity: pool === 'session' ? 'critical' : 'warning', title: `${absent.length} of the API’s ${label}-pool keys ${absent.length === 1 ? 'isn’t' : 'aren’t'} on the relayer account: relays from ${absent.length === 1 ? 'it' : 'them'} fail`, action: 'Add the key on chain or remove it from the API’s pool (docs/operations.md "Relayer keys (either pool)").', key: 'absent' });
    }
    add(i, `${mine.length} key${mine.length === 1 ? '' : 's'} on chain${lowest ? ` · lowest allowance ${nearAmount(lowest.allowance.toString())}` : mine.length ? ' · unlimited allowances' : ''}${apiKeys ? ` · ${apiKeys.filter((k) => k.pool === pool).length} in the API` : ''}`, problems);
  }
}

/** The NEAR relay's balance: amber below `lowBalanceNear`, red below a fifth of it (the watchdog's pairs: 5 / 1 NEAR, D786). */
export const NEAR_RELAY_CRITICAL_DIVISOR = 5n;

const pct = (part: bigint, whole: bigint): number => (whole > 0n ? Number((part * 1000n) / whole) / 10 : 0);
const NEAR_ACCOUNT = /^[a-z0-9._-]{2,64}$/u;
const PUBLIC_KEY = /^ed25519:[1-9A-HJ-NP-Za-km-z]{32,50}$/u;
/** A code from the API's answer, shown only when it looks like one. */
const codeOf = (v: unknown): string => (typeof v === 'string' && /^[a-z_]{1,40}$/u.test(v) ? v : 'no answer');

/**
 * The NEAR meta-transaction relay (D784–D786): `AdminRpc.systemStatus`'s `nearRelay`, read live by the API at each cold
 * read (no stored reading: the page's 30 s cache is its only age). Off (no `near.relay`, empty receivers, not testnet)
 * is Not measured, never an issue. Otherwise one line each for the balance, today's spend and the keys.
 */
function nearRelayTile(r: Report, s: Sources): void {
  const base: TileInput = { id: 'near-relay', group: 'funds', name: 'NEAR relay', affects: 'Users’ gasless NEAR calls (the relay pays their gas)', detail: '', link: L.feed };
  if (!s.api.ok) return r.add({ ...base, detail: 'Unknown: the API didn’t answer' }, [{ ...apiRpcProblem(s.api.code), issue: false }]);
  const n = obj(s.api.value.nearRelay);
  if (!n) return r.add({ ...base, detail: 'Unknown: the API doesn’t report the NEAR relay' }, [{ severity: 'unknown', title: 'The API doesn’t report the NEAR relay (deployed before this release)', action: 'Deploy the API (`corepack pnpm --filter @hana-id/api run deploy`), then check again.', key: 'unreported' }]);
  const state = str(n.state);
  if (state === 'off') {
    const why = n.offReason === 'no_receivers' ? 'its `receivers` list is empty' : n.offReason === 'not_testnet' ? 'the relay runs on testnet only' : 'no `near.relay` in this env’s manifest';
    return r.add({ ...base, detail: `Off: ${why}`, notMeasured: true });
  }
  const problems: Problem[] = [];
  const lines: TileLine[] = [];
  const line = (label: string, own: Problem[], floor: TileState, detail: string) => {
    lines.push({ label, state: own.reduce<TileState>((a, p) => (RANK[p.severity] > RANK[a] ? p.severity : a), floor), detail });
    problems.push(...own);
  };
  const OFF_SWITCH = 'every relay answers 503 relayer_unconfigured';
  if (state === 'bad_config') {
    return r.add({ ...base, detail: 'Off: the API refuses its NEAR_RELAY config' }, [{ severity: 'critical', title: `The API refuses this env’s NEAR relay config: ${OFF_SWITCH}`, action: 'Run `corepack pnpm --filter @hana-id/api gen <env>` and deploy the API; the manifest’s rules are in docs/operations.md "NEAR relay" (Settings).', key: 'config' }]);
  }
  if (state === 'no_keys') problems.push({ severity: 'warning', title: `The NEAR relay has no keys (NEAR_RELAY_KEYS isn’t set): ${OFF_SWITCH}`, action: 'Deleting that secret is the relay’s off switch. If nobody meant to turn it off, upload it again (docs/operations.md "NEAR relay", step 4).', key: 'no-keys' });
  else if (state === 'bad_keys') problems.push({ severity: 'critical', title: `NEAR_RELAY_KEYS is unreadable, repeats a key or shares one with a relayer pool: ${OFF_SWITCH}`, action: 'Upload it again from `.secrets/<env>/near-relay-keys.json` (docs/operations.md "NEAR relay", step 4).', key: 'bad-keys' });
  else if (state !== 'on') return r.add({ ...base, detail: 'Unknown: the API’s answer isn’t one this console knows' }, [{ severity: 'unknown', title: 'The API reports a NEAR relay state this console doesn’t know', action: 'Deploy the API and this console from the same checkout.', key: 'state' }]);

  const account = str(n.account) !== null && NEAR_ACCOUNT.test(str(n.account)!) ? str(n.account)! : 'the relay account';
  const readAt = num(n.readAt);
  const stale: Problem[] = readAt !== null && r.now - readAt > FUNDS_STALE_MS ? [{ severity: 'warning', title: `The NEAR relay reading is ${ago(r.now - readAt)} old`, action: 'The API reads it at each check: check again.', since: readAt, key: 'stale' }] : [];
  problems.push(...stale);

  // Balance: the manifest's lowBalanceNear and a fifth of it.
  const chain = obj(n.chain);
  const low = yocto(n.lowBalanceYocto);
  const critical = low === null ? null : low / NEAR_RELAY_CRITICAL_DIVISOR;
  const available = yocto(chain?.availableYocto);
  const rpcDown = !s.near.some((e) => e.endpoint.api && e.read.ok);
  let exists = true;
  if (!chain || chain.ok !== true) {
    line('Balance', [{ severity: 'unknown', title: `The NEAR relay account can’t be read (${codeOf(chain?.code)})`, action: 'Usually NEAR RPC: see External services. The playbook covers an RPC outage.', playbook: 'near-rpc-outage', key: 'unreadable', issue: !rpcDown }], 'unknown', 'Unknown: the account couldn’t be read');
  } else if (chain.exists === false) {
    exists = false;
    line('Balance', [{ severity: 'critical', title: `The NEAR relay account ${account} doesn’t exist on chain: every relay fails`, action: 'Re-create and fund it, then re-add its keys (the playbook).', playbook: 'near-relay-balance-low', key: 'missing' }], 'ok', 'The account doesn’t exist');
  } else if (available === null || low === null || critical === null) {
    // A balance or a line that doesn't parse is never OK.
    line('Balance', [{ severity: 'unknown', title: 'The NEAR relay’s balance or its lines can’t be read from the API’s answer', action: 'Deploy the API and this console from the same checkout; else check the API’s `system_status` log lines.', key: 'unparsed' }], 'unknown', 'Unknown: the balance couldn’t be read');
  } else {
    const own: Problem[] = [];
    const sev = available < critical ? 'critical' : available < low ? 'warning' : null;
    if (sev) own.push({ severity: sev, title: `The NEAR relay’s balance is low: ${nearAmount(chain.availableYocto)} available`, action: 'Top up the relay account (the playbook says how much and from where).', playbook: 'near-relay-balance-low', key: 'low' });
    line('Balance', own, 'ok', `${nearAmount(chain.availableYocto)} available · amber below ${nearAmount(low.toString())}, red below ${nearAmount(critical.toString())}`);
  }

  // Today's spend against the budget (UTC day).
  const spend = obj(n.spend);
  const cap = yocto(n.dailyBudgetYocto);
  const alertPct = num(n.budgetAlertPct) ?? 80;
  const spent = yocto(spend?.spentYocto);
  if (!spend || spend.ok !== true || spent === null || cap === null) {
    line('Today’s spend', [{ severity: 'unknown', title: `The NEAR relay’s spend today can’t be read (${codeOf(spend?.code)})`, action: 'Check the API’s logs; it usually passes.', key: 'spend' }], 'unknown', 'Unknown');
  } else {
    const share = pct(spent, cap);
    const own: Problem[] = [];
    if (spent >= cap) own.push({ severity: 'critical', title: `The NEAR relay’s daily budget is used up (${nearAmount(spent.toString())} of ${nearAmount(cap.toString())}): relays answer 503 until 00:00 UTC`, action: 'Real use: raise `dailyBudgetNear`. Unexplained: follow the playbook.', playbook: 'near-relay-budget-high', key: 'budget' });
    else if (share >= alertPct) own.push({ severity: 'warning', title: `The NEAR relay has spent ${share}% of today’s budget (${nearAmount(spent.toString())} of ${nearAmount(cap.toString())})`, action: 'At 100% relays are refused until 00:00 UTC. Real use: raise `dailyBudgetNear`. Unexplained: follow the playbook.', playbook: 'near-relay-budget-high', key: 'budget' });
    line('Today’s spend', own, 'ok', `${nearAmount(spent.toString())} of ${nearAmount(cap.toString())} (${share}%)${typeof spend.day === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(spend.day) ? ` · UTC day ${spend.day}` : ''}`);
  }

  // The API's keys on the account as full-access keys.
  const k = obj(n.keys);
  if (state !== 'on') line('Keys', [], 'not_measured', state === 'no_keys' ? 'None in the API' : 'The API’s keys are unusable');
  else if (!k || !exists) line('Keys', [], exists ? 'unknown' : 'critical', exists ? 'Unknown: the account couldn’t be read' : 'The account doesn’t exist');
  else {
    const configured = num(k.configured) ?? 0;
    // The count and the severity from the answer's list as it is; only what is shown is filtered (a malformed entry
    // still counts as missing).
    const raw = arr(k.missing);
    const absent = raw.length;
    const shown = raw.filter((x): x is string => typeof x === 'string' && PUBLIC_KEY.test(x)).map((x) => `${x.slice(0, 16)}…`);
    const names = shown.length ? ` (${shown.join(', ')}${shown.length < absent ? `, ${absent - shown.length} more` : ''})` : '';
    const own: Problem[] = absent ? [{ severity: 'critical', title: `${absent} of the API’s ${configured} NEAR relay keys ${absent === 1 ? 'isn’t' : 'aren’t'} a full-access key on ${account}: relays through ${absent === 1 ? 'it' : 'them'} fail${names}`, action: 'Add the key on chain as a full-access key (docs/operations.md "NEAR relay", step 2) or upload the keys again (step 4).', key: 'absent' }] : [];
    line('Keys', own, 'ok', `${Math.max(0, configured - absent)} of ${configured} on the account as full-access keys`);
  }

  const head = state === 'on' ? 'On' : state === 'no_keys' ? 'Off: no keys' : 'Off: keys unusable';
  const bal = chain?.ok === true && chain.exists === false ? 'account missing' : chain?.ok === true && available !== null ? `${nearAmount(chain.availableYocto)} available` : 'balance unknown';
  const today = spent !== null && cap !== null ? `${nearAmount(spent.toString())} of ${nearAmount(cap.toString())} spent today` : 'spend unknown';
  r.add({ ...base, detail: `${head} · ${bal} · ${today}`, lines }, problems);
}

/** The daily nonce check: it measures only while the API writes usage events (D596). */
function nonceTile(r: Report, s: Sources): void {
  const base: TileInput = { id: 'nonce-check', group: 'funds', name: 'Relayer nonce check', affects: 'Seeing a relayer key (session, owner or Home) used outside the API', detail: '', link: L.feed };
  if (!s.api.ok) return r.add({ ...base, detail: 'Unknown: the API didn’t answer' }, [{ ...apiRpcProblem(s.api.code), issue: false }]);
  const capture = s.api.value.usageCapture;
  if (capture === false) return r.add({ ...base, detail: 'Not measured: usage capture is off in the API, so the check records each key’s nonce as a baseline and raises no alert', notMeasured: true });
  r.add({ ...base, detail: capture === true ? 'Usage capture is on: each key’s nonce is checked daily against the ledger (Feed and notices lists the checks)' : 'Checked daily against the ledger (the API doesn’t say whether usage capture is on: deploy it)' });
}

function dataTiles(r: Report, s: Sources): void {
  const db = (id: string, name: string, affects: string, part: Settled<{ db: { ok: boolean; latencyMs: number } }> | null, rpcFailure: (code: string) => Problem) => {
    const base: TileInput = { id, group: 'data', name, affects, detail: '' };
    if (part === null) return r.add({ ...base, detail: 'Not part of this env', notMeasured: true });
    if (!part.ok) return r.add({ ...base, detail: `Unknown: the Worker didn’t answer (${part.code})` }, [rpcFailure(part.code)]);
    const d = part.value.db;
    if (!d.ok) return r.add({ ...base, detail: `Failed after ${ms(d.latencyMs)}`, latencyMs: d.latencyMs }, [{ severity: 'critical', title: `${name} didn’t answer a query`, action: 'Check Cloudflare’s D1 status and the Worker’s logs; the playbook covers losing data.', playbook: 'd1-data-loss', key: 'down' }]);
    const problems: Problem[] = d.latencyMs > DB_SLOW_MS ? [{ severity: 'warning', title: `${name} is slow: ${ms(d.latencyMs)} for one query`, action: 'Check Cloudflare’s D1 status; it usually passes.', key: 'slow' }] : [];
    r.add({ ...base, detail: `Answering · ${ms(d.latencyMs)}`, latencyMs: d.latencyMs }, problems);
  };
  db('hot-db', 'Hot D1 (API)', 'Every login and partner app', s.api.ok ? { ok: true, value: { db: s.api.value.hotDb } } : s.api, (c) => ({ ...apiRpcProblem(c), issue: true }));
  db('console-db', 'Console D1', 'The partner console', s.console, (c) => ({
    severity: 'unknown',
    title: `The console didn’t answer this page’s status call (${c})`,
    action: c === 'upstream_unavailable' ? 'If the console was deployed before this release it lacks StaffRpc.health: deploy it. Else check the console Worker’s logs.' : 'Check the console Worker’s logs for `staff.health`.',
    key: 'rpc',
  }));
  db('issuer-db', 'Email issuer D1', 'Email login and the Users screen', s.issuer, (c) => ({
    severity: 'unknown',
    title: `The email issuer didn’t answer this page’s status call (${c})`,
    action: c === 'upstream_unavailable' ? 'If the issuer was deployed before this release it lacks DirectoryRpc.health: deploy it. Else see the Users screen’s table in docs/operations.md.' : 'The same causes as the Users screen’s failures: docs/operations.md "Users screen (C8b)".',
    key: 'rpc',
  }));

  // The usage ledger.
  const l = s.ledger;
  const lbase: TileInput = { id: 'ledger', group: 'data', name: 'Usage ledger (Neon)', affects: 'Reports, statements, gas settlement, and the security feed and watcher emails (logins don’t wait for it)', detail: '', link: L.feed };
  if (!l.bound) r.add({ ...lbase, detail: 'USAGE_DB isn’t bound here' }, [{ severity: 'warning', title: 'The usage ledger isn’t bound to this console: the feed, the watcher, settlement and reports are off', action: 'Bind it: `gen <env> --admin-hyperdrive-id <id>` and redeploy (docs/operations.md "Admin Worker").', key: 'unbound' }]);
  else if (!l.ok) r.add({ ...lbase, detail: 'Unreachable' }, [{ severity: 'critical', title: 'The usage ledger can’t be reached (Neon or Hyperdrive)', action: 'Check Neon’s status and the Hyperdrive config; logins keep working (usage capture fails open), the feed and settlement catch up when it’s back.', key: 'down' }]);
  else {
    const problems: Problem[] = [];
    const ahead = l.partitionsAhead ?? 0;
    if (ahead < MIN_PARTITIONS_AHEAD) problems.push({ severity: ahead === 0 ? 'critical' : 'warning', title: `The usage ledger has ${ahead} monthly partition${ahead === 1 ? '' : 's'} ahead (fewer than ${MIN_PARTITIONS_AHEAD})`, action: 'Both keepers create them (the API hourly, this console daily): check their logs (`usage_partitions_failed`).', key: 'partitions' });
    const oldest = l.settlement?.oldestAt ?? null;
    if (oldest !== null && r.now - oldest > SETTLEMENT_WARN_MS) problems.push({ severity: 'warning', title: `Gas settlement is behind: the oldest unsettled event is ${ago(r.now - oldest)} old`, action: 'See the ledger part of Feed and notices; a burst drains over a few runs.', since: oldest, key: 'settlement' });
    r.add({ ...lbase, detail: `Reachable · ${ahead} months ahead · ${l.settlement?.pending ?? 0} event${l.settlement?.pending === 1 ? '' : 's'} to settle` }, problems);
  }

  // R2.
  const bucket = (id: string, name: string, affects: string, v: 'ok' | 'error' | null) => {
    const base: TileInput = { id, group: 'data', name, affects, detail: '' };
    if (v === null) return r.add({ ...base, detail: 'Not bound here', notMeasured: true });
    r.add({ ...base, detail: v === 'ok' ? 'Answering' : 'Failed' }, v === 'ok' ? [] : [{ severity: 'warning', title: `${name} didn’t answer a read`, action: 'Check Cloudflare’s R2 status.', key: 'down' }]);
  };
  bucket('r2-statements', 'R2: statements', 'Issuing and downloading monthly statements', s.statements);
  bucket('r2-exports', 'R2: exports', 'Ledger exports', s.exports);
  if (!s.console.ok) r.add({ id: 'r2-logos', group: 'data', name: 'R2: logos', affects: 'Partner logo uploads and the logos the login pages show', detail: 'Unknown: read by the console, which didn’t answer' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else bucket('r2-logos', 'R2: logos', 'Partner logo uploads and the logos the login pages show', s.console.value.logos);
}

function cronProblems(name: string, at: number | null, intervalMs: number, now: number, playbook?: string): Problem[] {
  if (at === null) return [];
  const age = now - at;
  if (age > stuckAfter(intervalMs)) return [{ severity: 'critical', title: `${name} hasn’t run for ${ago(age)} (every ${ago(intervalMs)} expected)`, action: 'Check the Worker’s cron triggers and logs in the Cloudflare dashboard (Workers & Pages → the Worker → Settings → Triggers; Logs).', since: at + intervalMs, ...(playbook ? { playbook } : {}), key: 'late' }];
  if (age > lateAfter(intervalMs)) return [{ severity: 'warning', title: `${name} is late: last run ${ago(age)} ago (every ${ago(intervalMs)} expected)`, action: 'Check the Worker’s cron triggers and logs in the Cloudflare dashboard.', since: at + intervalMs, ...(playbook ? { playbook } : {}), key: 'late' }];
  return [];
}

function parseRun(raw: string | undefined): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return obj(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

const sumCalls = (run: Record<string, unknown> | null): number | null => {
  const c = obj(run?.calls);
  return c ? Object.values(c).reduce<number>((a, b) => a + (typeof b === 'number' && Number.isFinite(b) ? b : 0), 0) : null;
};

function jobTiles(r: Report, s: Sources): void {
  const now = r.now;
  // The API's 15-minute run (the Google-key sync records every run).
  const apiBase: TileInput = { id: 'cron-api', group: 'jobs', name: 'API every 15 min (Google key sync)', affects: 'Google key rotations followed on chain (Google logins break when Google rotates without it), and the API’s hourly housekeeping', detail: '', link: L.monitoring };
  if (!s.api.ok) r.add({ ...apiBase, detail: 'Unknown: the API didn’t answer' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else if (s.api.value.jwksSync === null) r.add({ ...apiBase, detail: 'Unknown: its record couldn’t be read' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else {
    const run: CronRunView | undefined = s.api.value.jwksSync.find((x) => x.job === 'jwks_sync:google') ?? s.api.value.jwksSync[0];
    if (!run) r.add({ ...apiBase, detail: 'No run recorded yet' }, [{ severity: 'unknown', title: 'The API’s 15-minute cron has no recorded run', action: 'A fresh env records its first within 15 minutes; else check the API’s cron trigger.', key: 'never' }]);
    else {
      const problems = cronProblems('The API’s 15-minute cron', run.atMs, CRON_INTERVALS.apiSync, now, 'key-sync-stalled');
      if (run.outcome !== 'ok') problems.push({ severity: 'warning', title: `The API’s Google key sync last ended ${run.outcome}${run.detail ? ` (${run.detail})` : ''}`, action: 'See the API’s `jwks_sync` log lines; the playbook covers a stalled sync.', playbook: 'key-sync-stalled', key: 'outcome' });
      r.add({ ...apiBase, detail: `Last run ${ago(now - run.atMs)} ago · ${run.outcome}${run.detail ? ` (${run.detail})` : ''}` }, problems);
    }
  }

  // This Worker's two crons (their records in ops.state).
  const ledgerDown = !s.ledger.ok;
  const five = parseRun(s.ledger.state.get(CRON_LAST_RUN)?.value);
  const fiveBase: TileInput = { id: 'cron-admin-5', group: 'jobs', name: 'Admin every 5 min (notices, feed, watcher)', affects: 'Blocking notices (partner changes, invites and owner grants wait for them), the security feed, the on-chain watcher', detail: '', link: L.feed };
  if (ledgerDown) r.add({ ...fiveBase, detail: 'Unknown: its record is in the usage ledger, which can’t be read' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else if (!five || num(five.at) === null) r.add({ ...fiveBase, detail: 'No run recorded yet' }, [{ severity: 'unknown', title: 'The admin’s 5-minute cron has no recorded run', action: 'It records each run once it reaches the ops store: wait 5 minutes, else check this Worker’s logs (`cron`).', key: 'never' }]);
  else {
    const at = num(five.at)!;
    const problems = cronProblems('The admin’s 5-minute cron', at, CRON_INTERVALS.adminFive, now);
    if (five.feed === false) problems.push({ severity: 'warning', title: 'The security feed didn’t complete in the last 5-minute run', action: 'See this Worker’s `feed` log lines.', key: 'feed' });
    if (five.watcher === false) problems.push({ severity: 'warning', title: 'The on-chain watcher didn’t complete in the last 5-minute run', action: 'See this Worker’s `watcher` log lines (often NEAR RPC).', key: 'watcher' });
    r.add({ ...fiveBase, detail: `Last run ${ago(now - at)} ago · ${sumCalls(five) ?? '?'} of ${RUN_BUDGET} calls` }, problems);
  }
  const fifteen = parseRun(s.ledger.state.get(LEDGER_LAST_RUN)?.value);
  const fifBase: TileInput = { id: 'cron-admin-15', group: 'jobs', name: 'Admin every 15 min (ledger)', affects: 'Gas settlement, the ledger’s alerts, statement notices, and the daily checks and rate', detail: '', link: L.feed };
  if (ledgerDown) r.add({ ...fifBase, detail: 'Unknown: its record is in the usage ledger, which can’t be read' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else if (!fifteen || num(fifteen.at) === null) r.add({ ...fifBase, detail: 'No run recorded yet' }, [{ severity: 'unknown', title: 'The admin’s 15-minute cron has no recorded run', action: 'It records each run from this release on: wait 15 minutes, else check this Worker’s logs (`ledger_cron`).', key: 'never' }]);
  else {
    const at = num(fifteen.at)!;
    const failed = arr(fifteen.failed).filter((x): x is string => typeof x === 'string').map((x) => plainString(x, 40));
    const problems = cronProblems('The admin’s 15-minute cron', at, CRON_INTERVALS.adminFifteen, now);
    if (failed.length) problems.push({ severity: 'warning', title: `Steps of the admin’s 15-minute cron failed: ${failed.join(', ')}`, action: 'See this Worker’s `ledger_cron` log lines for those steps.', key: 'failed' });
    r.add({ ...fifBase, detail: `Last run ${ago(now - at)} ago · ${sumCalls(fifteen) ?? '?'} of ${RUN_BUDGET} calls${failed.length ? ` · failed: ${failed.join(', ')}` : ''}` }, problems);
  }

  // The console's hourly cron.
  const conBase: TileInput = { id: 'cron-console', group: 'jobs', name: 'Console hourly', affects: 'Invite expiry, owner grants taking effect, housekeeping and replaced logos', detail: '' };
  if (!s.console.ok) r.add({ ...conBase, detail: 'Unknown: the console didn’t answer' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else {
    const c = s.console.value.cron;
    if (c === 'missing') r.add({ ...conBase, detail: 'Its record table is missing' }, [{ severity: 'warning', title: 'The console’s cron can’t record its runs: console D1 migration 0003 isn’t applied', action: 'Apply it from the deployed checkout: `wrangler d1 migrations apply <console.d1Name> --remote` in apps/console, then `deploy-check <env> --d1`.', key: 'missing' }]);
    else if (c === null) r.add({ ...conBase, detail: 'No run recorded yet' }, [{ severity: 'unknown', title: 'The console’s hourly cron has no recorded run', action: 'It records each run from this release on: wait an hour, else check the console Worker’s cron trigger and logs (`console_cron`).', key: 'never' }]);
    else {
      const problems = cronProblems('The console’s hourly cron', c.atMs, CRON_INTERVALS.consoleHourly, now);
      if (c.outcome !== 'ok') problems.push({ severity: 'warning', title: `Steps of the console’s hourly cron failed${c.detail ? `: ${c.detail}` : ''}`, action: 'See the console Worker’s `console_cron` log lines.', key: 'failed' });
      r.add({ ...conBase, detail: `Last run ${ago(now - c.atMs)} ago · ${c.outcome}` }, problems);
    }
  }

  // The watchdog's own 5-minute runs (its silence rule: no finished run within two intervals).
  const wdBase: TileInput = { id: 'cron-watchdog', group: 'jobs', name: 'Watchdog every 5 min', affects: 'Every watchdog check and alert', detail: '', link: L.monitoring };
  const w = s.watchdog;
  if (!w.ok) r.add({ ...wdBase, detail: 'Unknown: the watchdog can’t be read (see Workers)' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else {
    const v = w.view;
    const problems: Problem[] = [];
    if (v.silent) problems.push({ severity: 'critical', title: v.sinceLastRunMs === null ? 'The watchdog has never finished a run' : `The watchdog has been silent for ${ago(v.sinceLastRunMs)} (more than two ${ago(v.runIntervalMs)} intervals)`, action: 'Follow the playbook.', since: v.lastRun?.finishedAt ?? null, playbook: 'watchdog-down', key: 'silent' });
    else if (v.lastRun?.outcome && v.lastRun.outcome !== 'ok') problems.push({ severity: 'warning', title: `The watchdog’s last run ended ${v.lastRun.outcome}`, action: 'See its checks in Security & monitoring.', key: 'outcome' });
    r.add({ ...wdBase, detail: v.sinceLastRunMs === null ? 'No finished run' : `Last run ${ago(v.sinceLastRunMs)} ago · ${v.lastRun?.outcome ?? 'no outcome'}` }, problems);
  }
}

/**
 * The NEAR RPC tile (D425, D435's note): one line per endpoint, in the API's order, and a verdict from what the
 * failover actually does. The API moves on only when an endpoint gives no answer, so the one serving it is the first
 * that answers: it's an outage when none answers, or when that one is stuck (a stale answer isn't failed over). The
 * vault and the watchdog have only `rpc` and `rpcFallback`, so losing both is an outage too, even with another of the
 * API's backups up. Anything else (a backup down, the primary down while a backup serves) is a warning. Labels only,
 * never a URL: a provider's URL can carry an API key.
 */
function nearTile(r: Report, s: Sources): void {
  const base: TileInput = { id: 'near-rpc', group: 'external', name: 'NEAR RPC', affects: 'Every login and relay (the API fails over between these endpoints, in order), the vault’s and the watchdog’s chain reads, and this console’s chain reads', detail: '' };
  const serving = s.near.find((e) => e.endpoint.api && e.read.ok);
  const pagesUp = s.near.some((e) => e.endpoint.pages && e.read.ok);
  const apiCount = s.near.filter((e) => e.endpoint.api).length;
  const problems: Problem[] = [];
  const lines: TileLine[] = [];
  const worst = (from: Problem[], floor: TileState): TileState => from.reduce<TileState>((a, p) => (RANK[p.severity] > RANK[a] ? p.severity : a), floor);
  if (!serving) {
    problems.push({ severity: 'critical', title: apiCount === 1 ? 'NEAR RPC is down: the API’s only endpoint doesn’t answer' : `NEAR RPC is down: none of the API’s ${apiCount} endpoints answers`, action: 'Follow the playbook (switching an RPC is a manifest change and a deploy).', playbook: 'near-rpc-outage', key: 'all-down' });
  }
  for (const [i, { endpoint, read }] of s.near.entries()) {
    const own: Problem[] = [];
    const name = `NEAR RPC: ${endpoint.label}`;
    if (!read.ok) {
      const what = read.failure === 'http_error' ? 'answered an error' : FAILURE_WORDS[read.failure ?? 'unreachable'];
      if (!serving && endpoint.api) {
        // Said once, by the outage above.
        lines.push({ label: endpoint.label, state: 'critical', detail: `Down: it ${what}` });
        continue;
      }
      const primary = i === 0;
      const blind = primary && !pagesUp;
      const consequence = blind ? '; the vault and the watchdog have no endpoint left' : primary && serving ? `; the API is using ${serving.endpoint.label}` : '';
      const waits = primary && serving ? ' This console’s on-chain watcher reads only the primary, so it waits meanwhile.' : '';
      own.push({ severity: blind ? 'critical' : 'warning', title: `${name} is down: it ${what}${consequence}`, action: `The API fails over on its own.${waits} Follow the playbook if it lasts (switching an RPC is a manifest change and a deploy).`, playbook: 'near-rpc-outage', key: `down:${i}` });
      lines.push({ label: endpoint.label, state: worst(own, 'warning'), detail: `Down: it ${what}` });
    } else {
      const lag = read.blockAtMs === null ? null : r.now - read.blockAtMs;
      if (lag !== null && lag > NEAR_STUCK_MS) own.push({ severity: endpoint === serving?.endpoint ? 'critical' : 'warning', title: `${name} is ${ago(lag)} behind`, action: 'Follow the playbook.', playbook: 'near-rpc-outage', key: `behind:${i}` });
      else if (lag !== null && lag > NEAR_BEHIND_MS) own.push({ severity: 'warning', title: `${name} is ${ago(lag)} behind`, action: 'Watch it; past 10 minutes follow the playbook.', playbook: 'near-rpc-outage', key: `behind:${i}` });
      if (read.latencyMs > SLOW_MS) own.push({ severity: 'warning', title: `${name} is slow: ${ms(read.latencyMs)}`, action: 'Usually passes; logins get slower meanwhile.', key: `slow:${i}` });
      lines.push({ label: endpoint.label, state: worst(own, 'ok'), detail: `Up · ${ms(read.latencyMs)} · block ${read.height}${lag !== null ? `, ${ago(Math.max(0, lag))} old` : ''}` });
    }
    problems.push(...own);
  }
  if (s.near.length === 1) lines.push({ label: 'Backup', state: 'not_measured', detail: 'No fallback in the manifest' });
  const up = s.near.filter((e) => e.read.ok).length;
  const detail = !serving ? `None of the API’s ${apiCount} endpoints answers` : `${up} of ${s.near.length} endpoints up${serving === s.near[0] ? '' : ` · the API is using ${serving.endpoint.label}`}`;
  r.add({ ...base, detail, latencyMs: serving?.read.latencyMs ?? null, lines }, problems);
}

function externalTiles(r: Report, env: Env, s: Sources): void {
  // Google's JWKS: the API's own fetch (from the governance snapshot), and the watchdog's check.
  const gBase: TileInput = { id: 'google-jwks', group: 'external', name: 'Google signing keys (JWKS)', affects: 'Google login', detail: '', link: L.monitoring };
  const gov = s.api.ok && s.api.value.governance.ok ? s.api.value.governance.snapshot : null;
  if (!gov) r.add({ ...gBase, detail: 'Unknown: read with the contract’s state, which couldn’t be read (see Contract)' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else {
    const google = arr(gov.issuers).map((i) => obj(i) ?? {}).find((i) => i.provider === 'google');
    const kids = google ? google.jwksKids : undefined;
    const problems: Problem[] = [];
    if (!google || kids === null || kids === undefined) problems.push({ severity: 'critical', title: 'The API can’t fetch Google’s signing keys', action: 'Follow the playbook: Google logins fail once the API’s cached keys expire.', playbook: 'google-jwks-outage', key: 'down' });
    const check = s.watchdog.ok ? s.watchdog.view.checks.find((c) => c.id === 'jwks_fetch') : undefined;
    if (check?.outcome === 'error') problems.push({ severity: 'warning', title: `The watchdog can’t fetch Google’s signing keys${check.detail ? `: ${plainString(check.detail, 200)}` : ''}`, action: 'Its forged-key checks need them: follow the playbook.', playbook: 'google-jwks-outage', key: 'watchdog' });
    const active = arr(google?.activeKids).length;
    r.add({ ...gBase, detail: Array.isArray(kids) ? `${kids.length} key${kids.length === 1 ? '' : 's'} published · ${active} active on chain` : 'Not fetched' }, problems);
  }

  nearTile(r, s);

  // Email: this Worker's key, the blocking notices waiting, the last run's failed sends.
  const eBase: TileInput = { id: 'email', group: 'external', name: 'Email (SendGrid)', affects: 'Blocking notices (changes, invites and owner grants wait for them), statements and staff alerts by email', detail: '', link: L.feed };
  const problems: Problem[] = [];
  if (!env.EMAIL_API_KEY) problems.push({ severity: 'critical', title: 'This console has no SendGrid key: no email leaves, so no blocking notice goes out', action: 'Set EMAIL_API_KEY (docs/operations.md "Admin Worker", step 3).', key: 'key', issue: false }); // the admin tile's missing-secrets issue says it once
  const backlogs = [s.api.ok ? s.api.value.notices : null, s.console.ok ? s.console.value.notices : null];
  const known = backlogs.filter((b): b is NonNullable<typeof b> => b !== null);
  const pending = known.reduce((a, b) => a + b.pending, 0);
  const oldest = known.map((b) => b.oldestAt).filter((t): t is number => t !== null).sort((a, b) => a - b)[0] ?? null;
  if (oldest !== null && r.now - oldest > NOTICE_CRITICAL_MS) problems.push({ severity: 'critical', title: `${pending} blocking notice${pending === 1 ? '' : 's'} waiting, the oldest for ${ago(r.now - oldest)}`, action: 'Partners’ changes, invites and owner grants are held until their notices go out: check SendGrid and this Worker’s `notice` log lines (Feed and notices lists them).', since: oldest, key: 'backlog' });
  else if (oldest !== null && r.now - oldest > NOTICE_WARN_MS) problems.push({ severity: 'warning', title: `${pending} blocking notice${pending === 1 ? '' : 's'} waiting, the oldest for ${ago(r.now - oldest)}`, action: 'They go out every 5 minutes: check SendGrid and this Worker’s `notice` log lines.', since: oldest, key: 'backlog' });
  const five = s.ledger.ok ? parseRun(s.ledger.state.get(CRON_LAST_RUN)?.value) : null;
  const failed = num(obj(five?.notices)?.failed);
  if (failed !== null && failed > 0) problems.push({ severity: 'warning', title: `${failed} email send${failed === 1 ? '' : 's'} weren’t accepted by SendGrid in the last 5-minute run`, action: 'They’re retried every run: check SendGrid’s status and the key (docs/operations.md "Admin Worker" → What to watch).', key: 'failed' });
  if (known.length < backlogs.length) problems.push({ severity: 'unknown', title: 'n/a', action: '', issue: false });
  r.add({ ...eBase, detail: `${env.EMAIL_API_KEY ? 'Key set' : 'No key'} · ${known.length < backlogs.length ? 'backlog partly unknown' : `${pending} notice${pending === 1 ? '' : 's'} waiting`}${failed !== null ? ` · last run ${failed} failed` : ''}` }, problems);
}

function headroomTiles(r: Report, env: Env, s: Sources): void {
  // Cron triggers on this account (from the manifest, gen's ACCOUNT_CRONS).
  type Crons = { worker: string; crons: number }[];
  let crons: Crons | null = null;
  try {
    const v = JSON.parse(env.ACCOUNT_CRONS ?? '') as unknown;
    if (Array.isArray(v) && v.every((x) => obj(x) && typeof (x as { worker: unknown }).worker === 'string' && Number.isSafeInteger((x as { crons: unknown }).crons))) crons = v as Crons;
  } catch {
    crons = null;
  }
  const cBase: TileInput = { id: 'cron-triggers', group: 'headroom', name: 'Cron triggers on this account', affects: 'Adding any Worker with a cron to this Cloudflare account (Free plan: 5)', detail: '' };
  if (!crons) r.add({ ...cBase, detail: 'Unknown: this Worker’s config predates the count' }, [{ severity: 'unknown', title: 'The account’s cron triggers aren’t counted in this Worker’s config', action: 'Run `corepack pnpm --filter @hana-id/admin gen <env>` and redeploy (it writes ACCOUNT_CRONS).', key: 'unknown' }]);
  else {
    const total = crons.reduce((a, c) => a + c.crons, 0);
    const problems: Problem[] = total > FREE_PLAN_CRON_LIMIT ? [{ severity: 'critical', title: `${total} cron triggers on an account that allows ${FREE_PLAN_CRON_LIMIT}`, action: 'A deploy past the limit is refused: remove one, or ask the user about the plan (D417).', key: 'over' }] : [];
    r.add({ ...cBase, detail: `${total} of ${FREE_PLAN_CRON_LIMIT}${total === FREE_PLAN_CRON_LIMIT ? ' (full: nothing else with a cron may be added)' : ''} · counted from the manifest` }, problems);
  }

  // The crons' call budget (D380).
  const runs = s.ledger.ok ? [parseRun(s.ledger.state.get(CRON_LAST_RUN)?.value), parseRun(s.ledger.state.get(LEDGER_LAST_RUN)?.value)] : [null, null];
  const used = runs.map(sumCalls);
  const bBase: TileInput = { id: 'call-budget', group: 'headroom', name: 'Admin crons’ call budget', affects: 'How fast the admin crons’ backlog drains (each run has 40 outbound calls of its 50 subrequests)', detail: '' };
  if (used.every((u) => u === null)) r.add({ ...bBase, detail: 'Unknown: no run recorded' }, [{ severity: 'unknown', title: 'n/a', action: '', issue: false }]);
  else {
    const top = Math.max(...used.filter((u): u is number => u !== null));
    const problems: Problem[] = top >= BUDGET_WARN_CALLS ? [{ severity: 'warning', title: `An admin cron run used ${top} of its ${RUN_BUDGET} calls: a backlog`, action: 'It drains over the next runs, blocking notices first (docs/operations.md "The crons’ call budget"); if it lasts hours, see the plan question.', key: 'budget' }] : [];
    r.add({ ...bBase, detail: `Last runs: 5-minute ${used[0] ?? '?'} and 15-minute ${used[1] ?? '?'} of ${RUN_BUDGET} calls` }, problems);
  }

  r.add({ id: 'usage-limits', group: 'headroom', name: 'Requests, D1, Hyperdrive, R2 and SendGrid against free limits', affects: 'Staying on the free tiers (D417)', detail: 'Not measured: needs Cloudflare’s and SendGrid’s usage APIs (see below)', notMeasured: true });
}

export const NOT_MEASURED: readonly { what: string; why: string }[] = [
  { what: 'Workers requests (100 000 a day), D1 reads, writes and storage, Durable Objects, Hyperdrive queries (100 000 a day), R2 storage and operations', why: 'Cloudflare’s GraphQL Analytics API needs an API token this Worker doesn’t hold; check Cloudflare → Billing and R2 → Overview by hand monthly (D417).' },
  { what: 'SendGrid’s daily sends against its free 100 a day', why: 'SendGrid’s stats need a key with more than Mail Send; this Worker’s is Mail Send only (D401).' },
  { what: 'The email issuer’s own sends (login codes) and its daily send budget', why: 'DirectoryRpc.health answers the issuer’s D1 only; its send outcomes are in its logs (`send_budget_exhausted`, `email_budget`).' },
  { what: 'The API’s hourly jobs (vault maintenance, drift detection, usage copies, the owner pool’s allowance)', why: 'Only in the API’s logs; this page sees the 15-minute run that carries them (its Google key sync).' },
  { what: 'NEAR’s MPC network (key derivation)', why: 'A derivation needs a user’s session; nothing here probes it (the playbook mpc-ckd-outage).' },
];

/** The whole read: the sources, every check, the verdict. */
export async function buildStatus(env: Env, staff: StaffRequest, accessJwt: string, now = Date.now()): Promise<StatusAnswer> {
  const calls = new CallCount();
  const s = await gatherSources(env, staff, accessJwt, now, calls);
  const r = new Report(now);
  workerTiles(r, env, s);
  contractTiles(r, env, s);
  fundsTiles(r, s);
  nonceTile(r, s);
  nearRelayTile(r, s);
  dataTiles(r, s);
  jobTiles(r, s);
  externalTiles(r, env, s);
  headroomTiles(r, env, s);
  r.settleSince();
  const order = new Map(r.tiles.map((t, i) => [t.id, i]));
  const issues = [...r.issues].sort((a, b) => (a.severity === b.severity ? (order.get(a.component) ?? 0) - (order.get(b.component) ?? 0) : a.severity === 'critical' ? -1 : 1));
  const critical = issues.filter((i) => i.severity === 'critical').length;
  const warning = issues.length - critical;
  const title = issues.length === 0 ? 'All systems operational' : `${issues.length} issue${issues.length === 1 ? '' : 's'}${critical ? ` (${critical} critical)` : ''}`;
  const pieces = r.tiles.filter((t) => t.group === 'workers' && t.build).map((t) => ({ component: t.id, build: t.build! }));
  const builds = r.tiles.find((t) => t.id === 'builds');
  const commits = new Map<string, number>();
  for (const p of pieces) commits.set(p.build.slice(0, 12), (commits.get(p.build.slice(0, 12)) ?? 0) + 1);
  const majority = [...commits.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return {
    checkedAt: now,
    env: env.ENV_NAME,
    verdict: { state: critical ? 'critical' : warning ? 'warning' : 'ok', title, critical, warning },
    issues,
    groups: GROUPS.map((g) => ({ id: g.id, title: g.title, tiles: r.tiles.filter((t) => t.group === g.id) })),
    builds: { majority, mixed: builds?.state === 'warning', pieces },
    notMeasured: [...NOT_MEASURED],
    calls: { total: calls.total, byKind: { ...calls.byKind } },
    cacheMs: STATUS_CACHE_MS,
  };
}

// ---- the route, with the isolate's cache ----

let cached: { at: number; body: StatusAnswer } | null = null;
let inflight: Promise<StatusAnswer> | null = null;

/** Tests only: forget the cached answer and the first-seen times. */
export function resetStatusCache(): void {
  cached = null;
  inflight = null;
  firstSeen.clear();
}

export async function statusRoute(env: Env, staff: StaffRequest, request: Request, now = Date.now()): Promise<Response> {
  if (cached && now - cached.at >= 0 && now - cached.at < STATUS_CACHE_MS) return json(200, { ...cached.body, cached: true, ageMs: now - cached.at });
  if (!inflight) {
    const jwt = request.headers.get(ACCESS_JWT_HEADER) ?? '';
    inflight = buildStatus(env, staff, jwt, now).finally(() => {
      inflight = null;
    });
  }
  let body: StatusAnswer;
  try {
    body = await inflight;
  } catch (err) {
    log({ event: 'bff', route: 'GET /api/status', requestId: staff.requestId, outcome: 'error', code: 'internal', error: errorName(err) }, 'error');
    return errorResponse('internal');
  }
  cached = { at: body.checkedAt, body };
  log({ event: 'bff', route: 'GET /api/status', requestId: staff.requestId, outcome: 'ok', count: body.calls.total });
  return json(200, { ...body, cached: false, ageMs: Math.max(0, now - body.checkedAt) });
}
