// The System status page's backend (D425; apps/admin/README.md "System status"): `GET /api/status`. Every check's
// green / amber / red / unknown mapping, issues with what they affect and since when, unknown never green, the
// subrequest count of a cold and a warm load (Workers Free: 50), the 30-second isolate cache and its shared read, the
// Access check, and no secret in the answer. The sources are stubbed (the isolate's fetch, the three RPCs, the ledger);
// one test crosses the real API, console and email issuer Workers to prove the three health methods are wired.
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHECK_IDS, RUN_INTERVAL_MS } from '../../watchdog/src/checks.ts';
import worker from '../src/index.ts';
import { CRON_LAST_RUN } from '../src/cron.ts';
import { LEDGER_LAST_RUN } from '../src/ledger-cron.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { probeTiming } from '../src/status-probes.ts';
import { STATUS_CACHE_MS, type StatusAnswer, type Tile, buildStatus, resetStatusCache, statusRoute } from '../src/status.ts';
import { MAX_NEAR_BACKUPS, nearEndpoints } from '../src/status-probes.ts';
import { ADMIN, CERTS_URL, RPC, STAFF_EMAIL, STAFF_SUB, WATCHDOG, WATCHDOG_TOKEN, accessSigner, adminRequest, envWith, json, overrideBinding, staffJwt } from './helpers.ts';
import { resetAccessVerifier } from '../src/access.ts';

const BUILD = '0485faa1c2d3';
const OTHER = '9f8e7d6c5b4a';
const FALLBACK = 'https://rpc-fallback.test.invalid';
const BACKUP = 'https://rpc-backup.test.invalid';
const PK_S = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const PK_O = 'ed25519:3eNPkjVtn4cHy2BUUgnK3E2q4pCs3LMC5eEFrBsPpnnr';
const PK_H = 'ed25519:4kqyRk2KyNBUm2oWT7m8n3fESEFJr3vV3YdBSiHVpDWp';
const E24 = '000000000000000000000000';
const MIN = 60_000;
let NOW = Date.now();

const staff = { actor: { kind: 'hana' as const, id: STAFF_SUB, email: STAFF_EMAIL }, requestId: 'req_statustest01', clientIp: '198.51.100.9' };

// ---- a healthy env, piece by piece (each test changes what it needs) ----

interface World {
  watchdog: Record<string, unknown> | (() => Response | Promise<Response>);
  api: Record<string, unknown> | (() => unknown);
  console: Record<string, unknown> | (() => unknown);
  issuer: Record<string, unknown> | (() => unknown);
  builds: Record<string, string | null>;
  /** Per URL: an answer instead of the healthy one. */
  http: Map<string, () => Response | Promise<Response>>;
  near: { primary: number | 'down'; fallback: number | 'down'; backup: number | 'down' };
  ledger: { ok: boolean; five: unknown; fifteen: unknown; partitions: number; settlement: { pending: number; oldestAt: number | null } } | 'down';
  over: Partial<typeof env>;
}

const relayerFunds = (over: Record<string, unknown> = {}) => ({
  account: 'relayer.test.near',
  exists: true,
  amount: `50${E24}`,
  locked: '0',
  storage_usage: 1000,
  available: `50${E24}`,
  keys: [
    { public_key: PK_S, pool: 'session', allowance: `2${E24}` },
    { public_key: PK_O, pool: 'owner', allowance: `5${E24.slice(1)}` },
    { public_key: PK_H, pool: 'home', allowance: `5${E24}` },
  ],
  other_keys: [],
  at: NOW - MIN,
  thresholds: { balance: { warn: `5${E24}`, critical: `1${E24}` }, session: { warn: `5${E24.slice(1)}`, critical: `1${E24.slice(1)}` }, owner: { warn: `1${E24.slice(1)}`, critical: `2${E24.slice(2)}` }, home: { warn: `1${E24}`, critical: `2${E24.slice(1)}` } },
  ...over,
});

const watchdogBody = (over: Record<string, unknown> = {}) => ({
  service: 'hana-id-watchdog',
  env: 'sandbox-test',
  build: BUILD,
  network: 'testnet',
  now: NOW,
  run_interval_ms: RUN_INTERVAL_MS,
  last_run: { id: 900, started_at: NOW - 70_000, finished_at: NOW - 60_000, outcome: 'ok', first_run: false, checks: CHECK_IDS.map((id) => ({ id, outcome: 'ok' })) },
  silent: false,
  heartbeat: { configured: true, last_ping_at: NOW - MIN, last_ok_at: NOW - MIN, ok: true, failures: 0 },
  channels: { pager: { provider: 'ntfy', configured: true }, slack: { configured: true }, email: { configured: true } },
  seen_kids: [],
  relayer_funds: relayerFunds(),
  actions: [],
  open_alerts: [],
  checks: {},
  alert_kinds: {},
  ...over,
});

const snapshot = (over: Record<string, unknown> = {}) => ({
  paused: false,
  keyChanges: [],
  watchdogs: [{ accountId: 'watchdog.test.near', confirmFromMs: 0, canConfirm: true }],
  updaterKeys: [],
  signerAccessKeys: [],
  pendingUpgrade: null,
  pendingOwner: null,
  pendingWithdrawal: null,
  pendingConsoleAudiences: [],
  delays: {},
  updater: { lastRuns: [], proposals: [] },
  issuers: [{ provider: 'google', activeKids: ['k1'], jwksKids: ['k1', 'k2'] }],
  ...over,
});

const apiAnswer = (over: Record<string, unknown> = {}) => ({
  ok: true,
  build: BUILD,
  hotDb: { ok: true, latencyMs: 3 },
  jwksSync: [{ job: 'jwks_sync:google', atMs: NOW - 5 * MIN, outcome: 'ok', detail: null }],
  notices: { pending: 0, oldestAt: null, truncated: false },
  relayerKeys: [
    { pool: 'session', publicKey: PK_S },
    { pool: 'owner', publicKey: PK_O },
    { pool: 'home', publicKey: PK_H },
  ],
  governance: { ok: true, snapshot: snapshot() },
  ...over,
});

const consoleAnswer = (over: Record<string, unknown> = {}) => ({ ok: true, build: BUILD, db: { ok: true, latencyMs: 2 }, cron: { job: 'hourly', atMs: NOW - 20 * MIN, outcome: 'ok', detail: null }, notices: { pending: 0, oldestAt: null, truncated: false }, logos: 'ok', ...over });
const issuerAnswer = (over: Record<string, unknown> = {}) => ({ ok: true, build: BUILD, db: { ok: true, latencyMs: 2 }, ...over });
const fiveRun = (over: Record<string, unknown> = {}) => ({ at: NOW - 2 * MIN, notices: { acked: 0, failed: 0 }, feed: true, watcher: true, budgetLeft: 35, calls: { ops: 1, notices: 2, feed: 1, watcher: 1 }, ...over });
const fifteenRun = (over: Record<string, unknown> = {}) => ({ at: NOW - 7 * MIN, budgetLeft: 37, calls: { ledger: 1, relayer_keys: 1, settlement: 1 }, failed: [], ...over });

const BUILD_URLS: Record<string, string> = {
  api: 'https://api.test/v1/health',
  vault: 'https://vault.test/.well-known/hana-build',
  'vault-bundle': 'https://vault.test/vault.js',
  auth: 'https://auth.test/.well-known/hana-build',
  'auth-pages': 'https://auth.test/login',
  issuer: 'https://api.test/v1/email/health',
  console: 'https://console.test/.well-known/hana-build',
  'console-spa': 'https://console.test/',
  'console-auth': 'https://console-auth.test/.well-known/hana-build',
  files: 'https://files.test/.well-known/hana-build',
};

let world: World;
const counts = { fetch: 0, rpc: 0, hyperdrive: 0, r2: 0 };

function healthyWorld(): World {
  return {
    watchdog: watchdogBody(),
    api: apiAnswer(),
    console: consoleAnswer(),
    issuer: issuerAnswer(),
    builds: Object.fromEntries(Object.keys(BUILD_URLS).map((k) => [k, BUILD])),
    http: new Map(),
    near: { primary: NOW - 1000, fallback: NOW - 1000, backup: NOW - 1000 },
    ledger: { ok: true, five: fiveRun(), fifteen: fifteenRun(), partitions: 11, settlement: { pending: 0, oldestAt: null } },
    over: {},
  };
}

function buildResponse(id: string, build: string | null): Response {
  if (id === 'vault-bundle') return new Response(`${build ? `/* hana-build ${build} */` : '/* no banner */'}\n(()=>{})();\n`, { headers: { 'content-type': 'text/javascript' } });
  if (id === 'auth-pages' || id === 'console-spa') return new Response(`<!doctype html><html><head>${build ? `<meta name="hana-build" content="${build}">` : ''}<title>x</title></head><body></body></html>`, { headers: { 'content-type': 'text/html' } });
  return Response.json(id === 'api' ? { ok: true, env: 'sandbox-test', build } : id === 'issuer' ? { ok: true, env: 'sandbox-test', build } : { build });
}

const nearBlock = (atMs: number) => Response.json({ jsonrpc: '2.0', id: 'hana-status', result: { header: { height: 4242, timestamp_nanosec: String(BigInt(atMs) * 1_000_000n) }, chunks: [] } });

async function stubWorld(): Promise<void> {
  const s = await accessSigner();
  resetAccessVerifier();
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === CERTS_URL) return Response.json({ keys: [s.jwk] }, { headers: { 'cache-control': 'max-age=300' } });
    counts.fetch += 1;
    const special = world.http.get(url);
    if (special) return special();
    if (url === `${WATCHDOG}/status`) {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${WATCHDOG_TOKEN}`) return new Response('no', { status: 401 });
      return typeof world.watchdog === 'function' ? world.watchdog() : Response.json(world.watchdog);
    }
    for (const [id, u] of Object.entries(BUILD_URLS)) if (url === u) return buildResponse(id, world.builds[id] ?? null);
    if (url === RPC || url === FALLBACK || url === BACKUP) {
      const at = url === RPC ? world.near.primary : url === FALLBACK ? world.near.fallback : world.near.backup;
      return at === 'down' ? new Response('bad gateway', { status: 502 }) : nearBlock(at);
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
  vi.spyOn(ledgerSource, 'open').mockImplementation(async () => {
    counts.hyperdrive += 1;
    const l = world.ledger;
    if (l === 'down') throw new Error('connect ECONNREFUSED');
    const state = new Map<string, { value: string; updatedAt: number }>();
    if (l.five) state.set(CRON_LAST_RUN, { value: JSON.stringify(l.five), updatedAt: NOW });
    if (l.fifteen) state.set(LEDGER_LAST_RUN, { value: JSON.stringify(l.fifteen), updatedAt: NOW });
    return { state: { getState: async () => state, setState: async () => {} }, partitionsAhead: async () => l.partitions, settlementBacklog: async () => l.settlement, close: async () => {} } as unknown as LedgerStore;
  });
}

const answerOf = async (v: Record<string, unknown> | (() => unknown)) => {
  counts.rpc += 1;
  return typeof v === 'function' ? v() : v;
};

const countedBucket = (b: R2Bucket | undefined): R2Bucket | undefined =>
  b && new Proxy(b, { get: (t, p) => (p === 'get' ? (...a: unknown[]) => ((counts.r2 += 1), (t.get as (...x: unknown[]) => unknown)(...a)) : (Reflect.get(t, p) as unknown)) });

function worldEnv(): typeof env {
  return envWith({
    HANA_BUILD: BUILD,
    NEAR_RPC_FALLBACK: FALLBACK,
    NEAR_RPC_FALLBACKS: JSON.stringify([FALLBACK, BACKUP]),
    USAGE_DB: { connectionString: 'postgresql://stub' } as unknown as Hyperdrive,
    API: overrideBinding(env.API, { systemStatus: () => answerOf(world.api) }),
    CONSOLE: overrideBinding(env.CONSOLE, { health: () => answerOf(world.console) }),
    ISSUER: overrideBinding(env.ISSUER!, { health: () => answerOf(world.issuer) }),
    STATEMENTS: countedBucket(env.STATEMENTS),
    EXPORTS: countedBucket(env.EXPORTS),
    ...world.over,
  });
}

const read = (): Promise<StatusAnswer> => buildStatus(worldEnv(), staff, 'jwt-not-checked-by-the-stub', NOW);
const tiles = (a: StatusAnswer): Tile[] => a.groups.flatMap((g) => g.tiles);
const tile = (a: StatusAnswer, id: string): Tile => {
  const t = tiles(a).find((x) => x.id === id);
  if (!t) throw new Error(`no tile ${id}`);
  return t;
};
const issuesOf = (a: StatusAnswer, component: string) => a.issues.filter((i) => i.component === component);

/** The invariant of every scenario: unknown is never green, and an unknown or bad tile never leaves the verdict green. */
function invariants(a: StatusAnswer): void {
  const bad = tiles(a).filter((t) => t.state === 'unknown' || t.state === 'warning' || t.state === 'critical');
  if (bad.length) expect(a.verdict.state, bad.map((t) => t.id).join(',')).not.toBe('ok');
  expect(a.verdict.title === 'All systems operational').toBe(a.issues.length === 0);
  for (const i of a.issues) expect(['critical', 'warning']).toContain(i.severity);
  // Critical first.
  const sev = a.issues.map((i) => i.severity);
  expect(sev).toEqual([...sev].sort((x, y) => (x === y ? 0 : x === 'critical' ? -1 : 1)));
}

beforeEach(async () => {
  NOW = Date.now();
  resetStatusCache();
  counts.fetch = counts.rpc = counts.hyperdrive = counts.r2 = 0;
  world = healthyWorld();
  await stubWorld();
});
afterEach(() => {
  vi.restoreAllMocks();
  probeTiming.timeoutMs = 5_000;
});

describe('all green', () => {
  it('says "All systems operational" with no issue when every check passes; every tile is ok or not measured', async () => {
    const a = await read();
    invariants(a);
    expect(a.issues).toEqual([]);
    expect(a.verdict).toEqual({ state: 'ok', title: 'All systems operational', critical: 0, warning: 0 });
    const notOk = tiles(a).filter((t) => t.state !== 'ok');
    expect(notOk.map((t) => [t.id, t.state])).toEqual([['usage-limits', 'not_measured']]);
    expect(a.builds).toMatchObject({ majority: BUILD, mixed: false });
    expect(tile(a, 'builds').detail).toContain(`All 12 stamped pieces on ${BUILD}`);
    expect(tile(a, 'cron-triggers').detail).toContain('5 of 5 (full');
    expect(a.notMeasured.length).toBeGreaterThan(0);
  });
});

describe('Workers', () => {
  it('a Worker answering 503 is red, with what it affects and the deploy advice', async () => {
    world.http.set(BUILD_URLS.console!, () => new Response('oops', { status: 503 }));
    const a = await read();
    invariants(a);
    expect(tile(a, 'console').state).toBe('critical');
    expect(issuesOf(a, 'console')).toEqual([expect.objectContaining({ severity: 'critical', title: 'Partner console Worker is down: it answered HTTP 503', affects: 'The partner console', sinceSource: 'first_seen', since: NOW })]);
    expect(a.verdict).toMatchObject({ state: 'critical', title: '1 issue (1 critical)' });
  });

  it('no answer within the deadline, an unreachable host and a redirect are red too', async () => {
    probeTiming.timeoutMs = 50;
    world.http.set(BUILD_URLS.files!, () => new Promise<Response>(() => {}));
    world.http.set(BUILD_URLS.auth!, () => Promise.reject(new TypeError('Network connection lost.')));
    world.http.set(BUILD_URLS['console-auth']!, () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.example/' } }));
    const a = await read();
    expect(issuesOf(a, 'files')[0]?.title).toBe('Files (partner logos) is down: it didn’t answer within 5 s');
    expect(issuesOf(a, 'auth')[0]?.title).toBe('Auth Worker is down: it couldn’t be reached');
    expect(issuesOf(a, 'console-auth')[0]?.title).toContain('redirect');
    for (const id of ['files', 'auth', 'console-auth']) expect(tile(a, id).state).toBe('critical');
  });

  it('an unstamped piece is amber (deploy-check would fail it), and not counted in the build comparison', async () => {
    world.builds['vault-bundle'] = null;
    const a = await read();
    invariants(a);
    expect(tile(a, 'vault-bundle')).toMatchObject({ state: 'warning', build: null });
    expect(issuesOf(a, 'vault-bundle')[0]?.title).toBe('Vault bundle (vault.js) carries no build id');
    expect(tile(a, 'builds').state).toBe('ok');
  });

  it('mixed builds name the pieces off the majority’s build (a half-done deploy)', async () => {
    world.builds.vault = OTHER;
    world.builds['vault-bundle'] = OTHER;
    const a = await read();
    invariants(a);
    expect(tile(a, 'builds').state).toBe('warning');
    expect(a.builds).toMatchObject({ majority: BUILD, mixed: true });
    expect(issuesOf(a, 'builds')).toEqual([expect.objectContaining({ severity: 'warning', title: `Mixed builds: Vault Worker, Vault bundle (vault.js) on ${OTHER}; the rest on ${BUILD}` })]);
    // A dirty build of the same commit isn't mixed.
    world.builds.vault = `${BUILD}-dirty`;
    world.builds['vault-bundle'] = BUILD;
    expect(tile(await read(), 'builds').state).toBe('ok');
  });

  it('this Worker without its email or link keys is red: no blocking notice can go out (said once)', async () => {
    world.over = { EMAIL_API_KEY: undefined, CANCEL_LINK_KEY: 'too-short' };
    const a = await read();
    invariants(a);
    expect(tile(a, 'admin').state).toBe('critical');
    expect(issuesOf(a, 'admin')[0]?.title).toContain('missing EMAIL_API_KEY, CANCEL_LINK_KEY');
    expect(tile(a, 'email').state).toBe('critical');
    expect(issuesOf(a, 'email')).toEqual([]);
  });

  it('a watchdog before D425 (no build field) is amber; one that can’t be read is one red issue, its dependents unknown', async () => {
    const { build: _b, ...old } = watchdogBody();
    world.watchdog = old;
    let a = await read();
    expect(tile(a, 'watchdog-worker').state).toBe('warning');
    expect(issuesOf(a, 'watchdog-worker')[0]?.title).toContain('before D425');

    world.watchdog = () => new Response('down', { status: 500 });
    resetStatusCache();
    a = await read();
    invariants(a);
    expect(tile(a, 'watchdog-worker').state).toBe('critical');
    for (const id of ['watchdog', 'cron-watchdog', 'relayer-balance', 'session-pool', 'owner-pool', 'home-pool']) expect(tile(a, id).state, id).toBe('unknown');
    expect(a.issues.map((i) => i.component)).toEqual(['watchdog-worker']);
    expect(a.issues[0]).toMatchObject({ severity: 'critical', playbook: { id: 'watchdog-down' } });
  });
});

describe('Contract and watchdog', () => {
  it('a paused contract is red with its playbook; a pending upgrade is red since its proposal, linked to Pending upgrades', async () => {
    world.api = apiAnswer({ governance: { ok: true, snapshot: snapshot({ paused: true, pendingUpgrade: { codeHash: '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp', proposedAtMs: NOW - 3_600_000, executableAtMs: NOW + 3_600_000, due: false } }) } });
    const a = await read();
    invariants(a);
    expect(tile(a, 'contract').state).toBe('critical');
    const [paused, upgrade] = [issuesOf(a, 'contract').find((i) => /paused/u.test(i.title)), issuesOf(a, 'contract').find((i) => /Upgrade proposed/u.test(i.title))];
    expect(paused).toMatchObject({ severity: 'critical', playbook: { id: 'contract-paused' }, link: { path: '/security/monitoring' } });
    expect(upgrade).toMatchObject({ severity: 'critical', since: NOW - 3_600_000, sinceSource: 'source', link: { path: '/security/upgrades' } });
    expect(tile(a, 'contract').detail).toContain('Paused');
  });

  it('a governance state the API can’t read is unknown, with an issue', async () => {
    world.api = apiAnswer({ governance: { ok: false, code: 'near_unavailable' } });
    const a = await read();
    invariants(a);
    expect(tile(a, 'contract').state).toBe('unknown');
    expect(tile(a, 'google-jwks').state).toBe('unknown');
    expect(issuesOf(a, 'contract')).toEqual([expect.objectContaining({ severity: 'warning', title: 'The contract’s governance state can’t be read (near_unavailable)' })]);
    expect(issuesOf(a, 'google-jwks')).toEqual([]);
  });

  it('an open, unacknowledged critical alert is red since it was raised; a warning alert amber; info alerts aren’t issues', async () => {
    const alert = (id: number, severity: string, over: Record<string, unknown> = {}) => ({ id, kind: 'governance_change', severity, title: `alert ${id}`, details: {}, created_at: NOW - 7_200_000, resolved_at: null, acked_at: null, resends_until_ack: severity === 'critical', channels: [], deliveries: [], ...over });
    world.watchdog = watchdogBody({ open_alerts: [alert(11, 'critical'), alert(12, 'warning'), alert(13, 'info')] });
    const a = await read();
    invariants(a);
    expect(tile(a, 'watchdog').state).toBe('critical');
    const is = issuesOf(a, 'watchdog');
    expect(is.map((i) => [i.severity, i.title])).toEqual([
      ['critical', 'Watchdog alert #11: alert 11 (not acknowledged: re-sent every 15 min)'],
      ['warning', 'Watchdog alert #12: alert 12'],
    ]);
    expect(is[0]).toMatchObject({ since: NOW - 7_200_000, sinceSource: 'source', playbook: { id: 'governance-change' } });
    // Acknowledged: still an open condition, without the re-send note.
    world.watchdog = watchdogBody({ open_alerts: [alert(11, 'critical', { acked_at: NOW - 60_000 })] });
    expect(issuesOf(await read(), 'watchdog')[0]?.title).toBe('Watchdog alert #11: alert 11');
  });

  it('a failing heartbeat, a channel off and a failed check are amber', async () => {
    world.watchdog = watchdogBody({
      heartbeat: { configured: true, last_ok_at: NOW - 3_600_000, ok: false, failures: 9 },
      channels: { pager: { configured: true }, slack: { configured: false }, email: { configured: true } },
      last_run: { id: 1, finished_at: NOW - 60_000, outcome: 'ok', checks: CHECK_IDS.map((id) => ({ id, outcome: id === 'chain_read' ? 'error' : 'ok', detail: id === 'chain_read' ? 'rpc down' : undefined })) },
    });
    const a = await read();
    invariants(a);
    expect(tile(a, 'watchdog').state).toBe('warning');
    expect(issuesOf(a, 'watchdog').map((i) => i.title)).toEqual(['The watchdog’s dead-man’s switch ping is failing', 'The watchdog’s slack alert channel is off', expect.stringContaining('failed: rpc down')]);
    expect(issuesOf(a, 'watchdog')[0]).toMatchObject({ since: NOW - 3_600_000, playbook: { id: 'watchdog-degraded' } });
  });

  it('a silent watchdog is red in Scheduled jobs', async () => {
    world.watchdog = watchdogBody({ silent: true, last_run: { id: 1, finished_at: NOW - 30 * MIN, outcome: 'ok', checks: [] } });
    const a = await read();
    expect(tile(a, 'cron-watchdog').state).toBe('critical');
    expect(issuesOf(a, 'cron-watchdog')[0]).toMatchObject({ title: 'The watchdog has been silent for 30 min (more than two 5 min intervals)', playbook: { id: 'watchdog-down' } });
  });
});

describe('Relayer funds', () => {
  it('below warn is amber, below critical red, a missing account red', async () => {
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ available: `3${E24}` }) });
    expect(tile(await read(), 'relayer-balance').state).toBe('warning');
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ available: `5${E24.slice(1)}` }) });
    const a = await read();
    expect(tile(a, 'relayer-balance').state).toBe('critical');
    expect(issuesOf(a, 'relayer-balance')[0]).toMatchObject({ title: 'The relayer’s balance is low: 0.5 NEAR available', playbook: { id: 'relayer-out-of-funds' } });
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ exists: false }) });
    expect(tile(await read(), 'relayer-balance').state).toBe('critical');
  });

  it('a session key’s allowance below critical is red; an API pool key missing on chain is red (its relays fail)', async () => {
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ keys: [{ public_key: PK_S, pool: 'session', allowance: `5${E24.slice(2)}` }, { public_key: PK_O, pool: 'owner', allowance: `5${E24.slice(1)}` }] }) });
    let a = await read();
    expect(tile(a, 'session-pool').state).toBe('critical');
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ keys: [{ public_key: PK_O, pool: 'owner', allowance: `5${E24.slice(1)}` }] }) });
    a = await read();
    invariants(a);
    expect(tile(a, 'session-pool').state).toBe('critical');
    expect(issuesOf(a, 'session-pool').map((i) => i.title)).toEqual(['No session-pool key on the relayer account', '1 of the API’s session-pool keys isn’t on the relayer account: relays from it fail']);
  });

  it('the Home pool has its own tile (readiness 7.4a): its key and allowance, a low allowance, a key the chain lacks, and an env without Home', async () => {
    const SESSION = { public_key: PK_S, pool: 'session', allowance: `2${E24}` };
    const OWNER = { public_key: PK_O, pool: 'owner', allowance: `5${E24.slice(1)}` };
    let a = await read();
    expect(tile(a, 'home-pool')).toMatchObject({ state: 'ok', name: 'Home pool keys', detail: '1 key on chain · lowest allowance 5 NEAR · 1 in the API' });

    // Below the watchdog's warn (1 NEAR), then its critical (0.2 NEAR).
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ keys: [SESSION, OWNER, { public_key: PK_H, pool: 'home', allowance: `5${E24.slice(1)}` }] }) });
    a = await read();
    expect(tile(a, 'home-pool').state).toBe('warning');
    expect(issuesOf(a, 'home-pool')[0]).toMatchObject({ title: expect.stringMatching(/^A Home-pool key’s allowance is low: 0\.5 NEAR left/u), playbook: { id: 'relayer-out-of-funds' } });
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ keys: [SESSION, OWNER, { public_key: PK_H, pool: 'home', allowance: `1${E24.slice(1)}` }] }) });
    expect(tile(await read(), 'home-pool').state).toBe('critical');

    // The API holds a Home key the relayer account doesn't have: Home derives fail, logins don't (a warning, not red).
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ keys: [SESSION, OWNER] }) });
    a = await read();
    invariants(a);
    expect(tile(a, 'home-pool').state).toBe('warning');
    expect(issuesOf(a, 'home-pool').map((i) => i.title)).toEqual(['No Home-pool key on the relayer account', '1 of the API’s Home-pool keys isn’t on the relayer account: relays from it fail']);
    expect(tile(a, 'session-pool').state).toBe('ok');

    // No Home key anywhere (the API has none, the chain has none): Home derives are off here, nothing to judge.
    world.api = apiAnswer({ relayerKeys: [{ pool: 'session', publicKey: PK_S }, { pool: 'owner', publicKey: PK_O }] });
    a = await read();
    invariants(a);
    expect(tile(a, 'home-pool')).toMatchObject({ state: 'not_measured', detail: 'No Home key in this env: Hana Home derives are off' });
    expect(a.issues.filter((i) => /Home/u.test(i.title))).toEqual([]);

    // A Home key on chain that the API doesn't hold is still shown and judged.
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds() });
    a = await read();
    expect(tile(a, 'home-pool')).toMatchObject({ state: 'ok', detail: '1 key on chain · lowest allowance 5 NEAR · 0 in the API' });
  });

  it('a reading older than 30 minutes is amber (said once); none yet is unknown with an issue', async () => {
    world.watchdog = watchdogBody({ relayer_funds: relayerFunds({ at: NOW - 45 * MIN }) });
    let a = await read();
    expect(['relayer-balance', 'session-pool', 'owner-pool', 'home-pool'].map((id) => tile(a, id).state)).toEqual(['warning', 'warning', 'warning', 'warning']);
    expect(a.issues.filter((i) => i.title.startsWith('The relayer reading'))).toHaveLength(1);
    world.watchdog = watchdogBody({ relayer_funds: null });
    a = await read();
    invariants(a);
    expect(tile(a, 'relayer-balance').state).toBe('unknown');
    expect(issuesOf(a, 'relayer-balance')).toHaveLength(1);
  });
});

describe('Data', () => {
  it('a D1 that fails its probe is red; a slow one amber', async () => {
    world.api = apiAnswer({ hotDb: { ok: false, latencyMs: 30 } });
    world.console = consoleAnswer({ db: { ok: true, latencyMs: 1500 } });
    const a = await read();
    invariants(a);
    expect(tile(a, 'hot-db').state).toBe('critical');
    expect(issuesOf(a, 'hot-db')[0]).toMatchObject({ affects: 'Every login and partner app', playbook: { id: 'd1-data-loss' } });
    expect(tile(a, 'console-db').state).toBe('warning');
  });

  it('a Worker that doesn’t answer its status call is one unknown issue; what it would have told is unknown, silently', async () => {
    world.console = () => Promise.reject(new Error('Service unavailable'));
    const a = await read();
    invariants(a);
    expect(tile(a, 'console-db').state).toBe('unknown');
    expect(tile(a, 'cron-console').state).toBe('unknown');
    expect(tile(a, 'r2-logos').state).toBe('unknown');
    expect(a.issues.map((i) => [i.component, i.severity])).toEqual([['console-db', 'warning']]);
    expect(a.issues[0]!.title).toBe('The console didn’t answer this page’s status call (upstream_unavailable)');
  });

  it('the usage ledger: unreachable red (its crons’ records unknown), unbound amber, partitions below 2 amber and 0 red', async () => {
    world.ledger = 'down';
    let a = await read();
    invariants(a);
    expect(tile(a, 'ledger').state).toBe('critical');
    expect(tile(a, 'cron-admin-5').state).toBe('unknown');
    expect(a.issues.map((i) => i.component)).toEqual(['ledger']);
    world.ledger = { ok: true, five: fiveRun(), fifteen: fifteenRun(), partitions: 1, settlement: { pending: 3, oldestAt: NOW - 3 * 3_600_000 } };
    a = await read();
    expect(tile(a, 'ledger').state).toBe('warning');
    expect(issuesOf(a, 'ledger').map((i) => i.title)).toEqual(['The usage ledger has 1 monthly partition ahead (fewer than 2)', 'Gas settlement is behind: the oldest unsettled event is 3 h old']);
    world.ledger = { ...world.ledger, partitions: 0 };
    expect(tile(await read(), 'ledger').state).toBe('critical');
    world.over = { USAGE_DB: undefined };
    a = await read();
    expect(tile(a, 'ledger').state).toBe('warning');
    expect(counts.hyperdrive).toBe(3);
  });

  it('an R2 bucket that throws is amber; one not bound is not measured (and not an issue)', async () => {
    world.over = { STATEMENTS: { get: () => Promise.reject(new Error('r2 down')) } as unknown as R2Bucket, EXPORTS: undefined };
    const a = await read();
    expect(tile(a, 'r2-statements').state).toBe('warning');
    expect(tile(a, 'r2-exports').state).toBe('not_measured');
    expect(issuesOf(a, 'r2-exports')).toEqual([]);
  });
});

describe('Scheduled jobs', () => {
  it('a cron is amber after 2 intervals + 5 min and red after 6, “since” one interval after its last run', async () => {
    world.api = apiAnswer({ jwksSync: [{ job: 'jwks_sync:google', atMs: NOW - 40 * MIN, outcome: 'ok', detail: null }] });
    world.ledger = { ok: true, five: fiveRun({ at: NOW - 31 * MIN }), fifteen: fifteenRun(), partitions: 11, settlement: { pending: 0, oldestAt: null } };
    world.console = consoleAnswer({ cron: { job: 'hourly', atMs: NOW - 7 * 3_600_000, outcome: 'ok', detail: null } });
    const a = await read();
    invariants(a);
    expect(tile(a, 'cron-api').state).toBe('warning');
    expect(issuesOf(a, 'cron-api')[0]).toMatchObject({ since: NOW - 25 * MIN, playbook: { id: 'key-sync-stalled' } });
    expect(tile(a, 'cron-admin-5').state).toBe('critical');
    expect(tile(a, 'cron-console').state).toBe('critical');
    expect(tile(a, 'cron-admin-15').state).toBe('ok');
  });

  it('a skipped or failed run is amber with its code or steps', async () => {
    world.api = apiAnswer({ jwksSync: [{ job: 'jwks_sync:google', atMs: NOW - 5 * MIN, outcome: 'skipped', detail: 'no_keys_updater_key' }] });
    world.ledger = { ok: true, five: fiveRun({ watcher: false }), fifteen: fifteenRun({ failed: ['settlement'] }), partitions: 11, settlement: { pending: 0, oldestAt: null } };
    world.console = consoleAnswer({ cron: { job: 'hourly', atMs: NOW - 10 * MIN, outcome: 'error', detail: 'logos' } });
    const a = await read();
    invariants(a);
    expect(issuesOf(a, 'cron-api')[0]?.title).toBe('The API’s Google key sync last ended skipped (no_keys_updater_key)');
    expect(issuesOf(a, 'cron-admin-5')[0]?.title).toContain('on-chain watcher');
    expect(issuesOf(a, 'cron-admin-15')[0]?.title).toBe('Steps of the admin’s 15-minute cron failed: settlement');
    expect(issuesOf(a, 'cron-console')[0]?.title).toBe('Steps of the console’s hourly cron failed: logos');
  });

  it('no run recorded is unknown with an issue; the console without migration 0003 is amber', async () => {
    world.ledger = { ok: true, five: fiveRun(), fifteen: null, partitions: 11, settlement: { pending: 0, oldestAt: null } };
    world.console = consoleAnswer({ cron: 'missing' });
    const a = await read();
    invariants(a);
    expect(tile(a, 'cron-admin-15').state).toBe('unknown');
    expect(issuesOf(a, 'cron-admin-15')).toHaveLength(1);
    expect(tile(a, 'cron-console').state).toBe('warning');
    expect(issuesOf(a, 'cron-console')[0]?.title).toContain('migration 0003');
  });
});

describe('External services', () => {
  it('Google’s JWKS unreadable by the API is red; by the watchdog amber', async () => {
    world.api = apiAnswer({ governance: { ok: true, snapshot: snapshot({ issuers: [{ provider: 'google', activeKids: ['k1'], jwksKids: null }] }) } });
    world.watchdog = watchdogBody({ last_run: { id: 1, finished_at: NOW - MIN, outcome: 'ok', checks: CHECK_IDS.map((id) => ({ id, outcome: id === 'jwks_fetch' ? 'error' : 'ok' })) } });
    const a = await read();
    invariants(a);
    expect(tile(a, 'google-jwks').state).toBe('critical');
    expect(issuesOf(a, 'google-jwks').map((i) => i.severity)).toEqual(['critical', 'warning']);
    expect(issuesOf(a, 'google-jwks')[0]).toMatchObject({ affects: 'Google login', playbook: { id: 'google-jwks-outage' } });
  });

  describe('NEAR RPC: every endpoint the API can use, one tile (D435)', () => {
    const lines = (a: StatusAnswer) => tile(a, 'near-rpc').lines!.map((l) => [l.label, l.state]);

    it('one line per endpoint, in the API’s order, all green; no URL in the answer', async () => {
      const a = await read();
      invariants(a);
      expect(tile(a, 'near-rpc')).toMatchObject({ name: 'NEAR RPC', state: 'ok', detail: '3 of 3 endpoints up' });
      expect(lines(a)).toEqual([['Primary', 'ok'], ['Backup 1', 'ok'], ['Backup 2', 'ok']]);
      const text = JSON.stringify(a);
      for (const url of [RPC, FALLBACK, BACKUP]) expect(text).not.toContain(url);
    });

    it('a backup down while the primary answers is a warning, not an outage', async () => {
      world.near = { ...world.near, backup: 'down' };
      const a = await read();
      invariants(a);
      expect(tile(a, 'near-rpc').state).toBe('warning');
      expect(lines(a)).toEqual([['Primary', 'ok'], ['Backup 1', 'ok'], ['Backup 2', 'warning']]);
      expect(issuesOf(a, 'near-rpc')).toEqual([expect.objectContaining({ severity: 'warning', title: 'NEAR RPC: Backup 2 is down: it answered an error', playbook: expect.objectContaining({ id: 'near-rpc-outage' }) })]);
      expect(a.verdict.state).toBe('warning');
    });

    it('the primary down while a backup serves is a warning that says who serves; the tile too', async () => {
      world.near = { ...world.near, primary: 'down' };
      const a = await read();
      invariants(a);
      expect(tile(a, 'near-rpc')).toMatchObject({ state: 'warning', detail: '2 of 3 endpoints up · the API is using Backup 1' });
      expect(issuesOf(a, 'near-rpc')).toEqual([expect.objectContaining({ severity: 'warning', title: 'NEAR RPC: Primary is down: it answered an error; the API is using Backup 1' })]);
      expect(a.verdict.state).toBe('warning');
    });

    it('every endpoint the API can use down is one critical issue, not one each', async () => {
      world.near = { primary: 'down', fallback: 'down', backup: 'down' };
      const a = await read();
      invariants(a);
      expect(tile(a, 'near-rpc')).toMatchObject({ state: 'critical', detail: 'None of the API’s 3 endpoints answers' });
      expect(lines(a)).toEqual([['Primary', 'critical'], ['Backup 1', 'critical'], ['Backup 2', 'critical']]);
      expect(issuesOf(a, 'near-rpc')).toEqual([expect.objectContaining({ severity: 'critical', title: 'NEAR RPC is down: none of the API’s 3 endpoints answers' })]);
      expect(a.verdict.state).toBe('critical');
    });

    it('the vault’s two endpoints down is an outage even with another of the API’s backups up (the vault and watchdog have only those two)', async () => {
      world.near = { ...world.near, primary: 'down', fallback: 'down' };
      const a = await read();
      invariants(a);
      expect(tile(a, 'near-rpc').state).toBe('critical');
      expect(issuesOf(a, 'near-rpc').map((i) => [i.severity, i.title])).toEqual([
        ['critical', 'NEAR RPC: Primary is down: it answered an error; the vault and the watchdog have no endpoint left'],
        ['warning', 'NEAR RPC: Backup 1 is down: it answered an error'],
      ]);
    });

    it('a stuck endpoint is red only when the API is on it: an answer isn’t failed over', async () => {
      world.near = { primary: NOW - 20 * MIN, fallback: NOW - 1000, backup: NOW - 1000 };
      let a = await read();
      expect(issuesOf(a, 'near-rpc')).toEqual([expect.objectContaining({ severity: 'critical', title: 'NEAR RPC: Primary is 20 min behind' })]);
      world.near = { primary: 'down', fallback: NOW - 20 * MIN, backup: NOW - 1000 };
      a = await read();
      expect(issuesOf(a, 'near-rpc').map((i) => [i.severity, i.title])).toEqual([
        ['critical', 'NEAR RPC: Backup 1 is 20 min behind'],
        ['warning', 'NEAR RPC: Primary is down: it answered an error; the API is using Backup 1'],
      ]);
      world.near = { primary: NOW - 1000, fallback: NOW - 20 * MIN, backup: NOW - 5 * MIN };
      a = await read();
      expect(tile(a, 'near-rpc').state).toBe('warning');
      expect(lines(a)).toEqual([['Primary', 'ok'], ['Backup 1', 'warning'], ['Backup 2', 'warning']]);
    });

    it('no backup in the manifest: the primary alone, its line and a Not measured line; down is an outage', async () => {
      world.over = { NEAR_RPC_FALLBACK: undefined, NEAR_RPC_FALLBACKS: undefined };
      let a = await read();
      expect(lines(a)).toEqual([['Primary', 'ok'], ['Backup', 'not_measured']]);
      expect(tile(a, 'near-rpc').state).toBe('ok');
      world.near = { ...world.near, primary: 'down' };
      a = await read();
      expect(tile(a, 'near-rpc').state).toBe('critical');
      expect(issuesOf(a, 'near-rpc')[0]).toMatchObject({ title: 'NEAR RPC is down: the API’s only endpoint doesn’t answer' });
    });

    it('rpcFallback outside the API’s list stays probed, as the vault’s; without the new var the API list is rpcFallback alone', async () => {
      world.over = { NEAR_RPC_FALLBACKS: JSON.stringify([BACKUP]) };
      let a = await read();
      expect(lines(a)).toEqual([['Primary', 'ok'], ['Backup 1', 'ok'], ['Vault’s fallback', 'ok']]);
      world.near = { ...world.near, fallback: 'down' };
      a = await read();
      expect(issuesOf(a, 'near-rpc')).toEqual([expect.objectContaining({ severity: 'warning', title: 'NEAR RPC: Vault’s fallback is down: it answered an error' })]);
      world.over = { NEAR_RPC_FALLBACKS: undefined };
      world.near = { ...world.near, fallback: NOW - 1000 };
      expect(lines(await read())).toEqual([['Primary', 'ok'], ['Backup 1', 'ok']]);
    });

    it('the endpoint list ignores junk, duplicates and the primary, and keeps at most the manifest’s number of backups', () => {
      const list = (fallbacks: string | undefined, fallback?: string) => nearEndpoints({ NEAR_RPC: RPC, ...(fallback ? { NEAR_RPC_FALLBACK: fallback } : {}), ...(fallbacks !== undefined ? { NEAR_RPC_FALLBACKS: fallbacks } : {}) }).map((e) => e.label);
      expect(list('not json', FALLBACK)).toEqual(['Primary', 'Backup 1']);
      expect(list(JSON.stringify([RPC, BACKUP, BACKUP, 42, 'ftp://x']))).toEqual(['Primary', 'Backup 1']);
      const many = ['https://a.invalid', 'https://b.invalid', 'https://c.invalid', 'https://d.invalid'];
      expect(list(JSON.stringify(many))).toEqual(['Primary', 'Backup 1', 'Backup 2', 'Backup 3']);
      expect(MAX_NEAR_BACKUPS).toBe(3);
    });
  });

  it('blocking notices waiting 20 min are amber, 2 h red since the oldest; a failed send amber', async () => {
    world.api = apiAnswer({ notices: { pending: 2, oldestAt: NOW - 20 * MIN, truncated: false } });
    let a = await read();
    expect(tile(a, 'email').state).toBe('warning');
    world.console = consoleAnswer({ notices: { pending: 1, oldestAt: NOW - 2 * 3_600_000, truncated: false } });
    a = await read();
    expect(tile(a, 'email').state).toBe('critical');
    expect(issuesOf(a, 'email')[0]).toMatchObject({ title: '3 blocking notices waiting, the oldest for 2 h', since: NOW - 2 * 3_600_000 });
    world.api = apiAnswer();
    world.console = consoleAnswer();
    world.ledger = { ok: true, five: fiveRun({ notices: { acked: 1, failed: 2 } }), fifteen: fifteenRun(), partitions: 11, settlement: { pending: 0, oldestAt: null } };
    expect(issuesOf(await read(), 'email')[0]?.title).toBe('2 email sends weren’t accepted by SendGrid in the last 5-minute run');
  });
});

describe('Free-tier headroom', () => {
  it('cron triggers: at 5 green with a note, over 5 red, uncounted unknown with an issue', async () => {
    world.over = { ACCOUNT_CRONS: JSON.stringify([{ worker: 'a', crons: 4 }, { worker: 'b', crons: 2 }]) };
    let a = await read();
    expect(tile(a, 'cron-triggers').state).toBe('critical');
    world.over = { ACCOUNT_CRONS: undefined };
    a = await read();
    invariants(a);
    expect(tile(a, 'cron-triggers').state).toBe('unknown');
    expect(a.verdict.state).toBe('warning');
  });

  it('a cron run using 38 of its 40 calls is amber', async () => {
    world.ledger = { ok: true, five: fiveRun({ calls: { ops: 1, notices: 37 } }), fifteen: fifteenRun(), partitions: 11, settlement: { pending: 0, oldestAt: null } };
    const a = await read();
    expect(tile(a, 'call-budget').state).toBe('warning');
  });
});

describe('since: first seen by this isolate when the source has no time', () => {
  it('keeps the first sighting across reads and forgets it once the issue is gone', async () => {
    world.http.set(BUILD_URLS.files!, () => new Response('x', { status: 500 }));
    const first = await buildStatus(worldEnv(), staff, 'jwt', NOW);
    const later = await buildStatus(worldEnv(), staff, 'jwt', NOW + 120_000);
    expect(issuesOf(later, 'files')[0]).toMatchObject({ since: NOW, sinceSource: 'first_seen' });
    expect(issuesOf(first, 'files')[0]?.since).toBe(NOW);
    world.http.clear();
    await buildStatus(worldEnv(), staff, 'jwt', NOW + 180_000);
    world.http.set(BUILD_URLS.files!, () => new Response('x', { status: 500 }));
    expect(issuesOf(await buildStatus(worldEnv(), staff, 'jwt', NOW + 240_000), 'files')[0]?.since).toBe(NOW + 240_000);
  });
});

describe('the subrequest budget and the cache (Workers Free: 50 a request)', () => {
  it('the most endpoints the manifest allows (the primary, 3 backups and a separate rpcFallback) stay under 50 with the certs fetch', async () => {
    world.over = { NEAR_RPC_FALLBACKS: JSON.stringify([BACKUP, 'https://b.test.invalid', 'https://c.test.invalid']) };
    for (const u of ['https://b.test.invalid', 'https://c.test.invalid']) world.http.set(u, () => nearBlock(NOW - 1000));
    const a = await read();
    expect(a.calls.byKind.fetch).toBe(10 + 5); // the build reads and the NEAR reads
    expect(a.calls.total).toBe(22);
    expect(a.calls.total + 1).toBeLessThanOrEqual(25);
  });

  it('a cold load makes 20 outbound calls (sandbox-dev’s three NEAR endpoints), counted the same inside and out; a warm one none, for 30 s', async () => {
    const req = new Request(`${ADMIN}/api/status`, { headers: { 'cf-access-jwt-assertion': await staffJwt() } });
    const res = await statusRoute(worldEnv(), staff, req, NOW);
    const a = await json<StatusAnswer & { cached: boolean }>(res);
    const outside = counts.fetch + counts.rpc + counts.hyperdrive + counts.r2;
    expect({ ...counts }).toEqual({ fetch: 14, rpc: 3, hyperdrive: 1, r2: 2 });
    expect(a.calls).toEqual({ total: 20, byKind: { watchdog: 1, rpc: 3, fetch: 13, hyperdrive: 1, r2: 2 } });
    expect(outside).toBe(a.calls.total);
    // With the Access certs fetch of a cold isolate (before the route), far under 50; and 3 Worker invocations of 32.
    expect(a.calls.total + 1).toBeLessThanOrEqual(25);
    expect(a.cached).toBe(false);

    const warm = await json<{ cached: boolean; ageMs: number; checkedAt: number }>(await statusRoute(worldEnv(), staff, req, NOW + STATUS_CACHE_MS - 1));
    expect(warm).toMatchObject({ cached: true, ageMs: STATUS_CACHE_MS - 1, checkedAt: NOW });
    expect(counts.fetch + counts.rpc + counts.hyperdrive + counts.r2).toBe(outside);

    const again = await json<{ cached: boolean }>(await statusRoute(worldEnv(), staff, req, NOW + STATUS_CACHE_MS));
    expect(again.cached).toBe(false);
    expect(counts.fetch + counts.rpc + counts.hyperdrive + counts.r2).toBe(2 * outside);
  });

  it('concurrent cold requests share one read', async () => {
    const req = new Request(`${ADMIN}/api/status`);
    const [a, b, c] = await Promise.all([statusRoute(worldEnv(), staff, req, NOW), statusRoute(worldEnv(), staff, req, NOW), statusRoute(worldEnv(), staff, req, NOW)]);
    expect([a.status, b.status, c.status]).toEqual([200, 200, 200]);
    expect(counts.rpc).toBe(3);
    expect(counts.fetch).toBe(14);
  });
});

describe('the route', () => {
  it('is staff only behind Access, GET only, no-store, and answers no secret', async () => {
    expect((await adminRequest('/api/status', { jwt: null })).status).toBe(401);
    expect((await adminRequest('/api/status', { jwt: await staffJwt({ email: 'intruder@hana.example' }) })).status).toBe(403);
    const post = await adminRequest('/api/status', { method: 'POST', body: {} });
    expect(post.status).toBe(405);
    const res = await worker.fetch(new Request(`${ADMIN}/api/status`, { headers: { 'cf-access-jwt-assertion': await staffJwt() } }), worldEnv());
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('no-store');
    const text = await res.text();
    for (const secret of [WATCHDOG_TOKEN, env.EMAIL_API_KEY, env.CANCEL_LINK_KEY, env.INVITE_LINK_KEY].filter((s): s is string => typeof s === 'string')) expect(text).not.toContain(secret);
    expect(text).not.toContain('cf-access-jwt-assertion');
  });

  it('crosses the real API, console and email issuer Workers: their health methods answer (the D1 tiles green)', async () => {
    vi.restoreAllMocks();
    await stubWorld();
    const real = envWith({ HANA_BUILD: BUILD, NEAR_RPC_FALLBACK: FALLBACK, USAGE_DB: { connectionString: 'postgresql://stub' } as unknown as Hyperdrive });
    const a = await buildStatus(real, staff, await staffJwt(), NOW);
    expect(tile(a, 'hot-db').state).toBe('ok');
    expect(tile(a, 'console-db').state).toBe('ok');
    expect(tile(a, 'issuer-db').state).toBe('ok');
    // The test API's own NEAR RPC is an invalid host: its governance read fails, honestly unknown.
    expect(tile(a, 'contract').state).toBe('unknown');
    invariants(a);
  });
});
