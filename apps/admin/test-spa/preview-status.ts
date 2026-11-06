// The System status page's preview scenarios (D425; test-spa/preview.ts): the real `buildStatus` (src/status.ts) run
// over fake sources, so the page shows exactly what the Worker would answer: every Worker's build read, the watchdog's
// `/status`, the three health RPCs, NEAR, the ledger and R2, all answered here. Nothing reaches a network; every URL,
// key and id is made up (`.example`/`.invalid`).
//
//   green          every check passes: "All systems operational"
//   warnings       a few amber issues: the relayer's balance under its warn line, a watchdog alert channel off, blocking
//                  notices waiting 22 minutes, the console's cron record table missing
//   critical       an outage: the API Worker answering 503 (its status call failing too), NEAR's primary RPC down, an
//                  unacknowledged critical watchdog alert
//   mixed-build    a half-done deploy: the page Workers and their bundles on the previous build
//   watchdog-down  the watchdog unreachable: one red issue, what it reports unknown
import { CRON_LAST_RUN } from '../src/cron.ts';
import type { Env } from '../src/env.ts';
import { LEDGER_LAST_RUN } from '../src/ledger-cron.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { type StatusAnswer, buildStatus, resetStatusCache } from '../src/status.ts';

export const SCENARIOS = ['green', 'warnings', 'critical', 'mixed-build', 'watchdog-down'] as const;
export type Scenario = (typeof SCENARIOS)[number];

const BUILD = '8a797fe1c2d3';
const PREVIOUS = '22a4d7f90b1e';
const MIN = 60_000;
const E24 = '000000000000000000000000';
const PK_S = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const PK_S2 = 'ed25519:9kWv2yFJq7Bf3mPnZcLx4T8uDhR5sGaQ1eNoYiKjVbXw';
const PK_O = 'ed25519:3eNPkjVtn4cHy2BUUgnK3E2q4pCs3LMC5eEFrBsPpnnr';
const WATCHDOG = 'https://hana-id-watchdog-preview.preview.invalid';
const TOKEN = 'preview-only-watchdog-status-token-not-a-secret';
const RPC = 'https://rpc.preview.invalid';
const RPC_FALLBACK = 'https://rpc-fallback.preview.invalid';
const ORIGINS = { api: 'https://api.preview.invalid', vault: 'https://vault.preview.invalid', auth: 'https://auth.preview.invalid', issuer: 'https://email.preview.invalid', console: 'https://console.preview.invalid', consoleAuth: 'https://console-auth.preview.invalid', files: 'https://files.preview.invalid' };
const CHECK_IDS = ['config', 'jwks_fetch', 'chain_read', 'watchdog_role', 'pending_key_changes', 'active_keys', 'signer_policy', 'links', 'identity_on_chain', 'governance_diff', 'unexecuted_changes', 'relayer_funds', 'alert_delivery', 'digest', 'heartbeat', 'email_jwks', 'identity_jwks'];

interface World {
  builds: Record<string, string | null>;
  http: Map<string, () => Response>;
  watchdog: Record<string, unknown> | null;
  api: Record<string, unknown> | null;
  console: Record<string, unknown>;
  near: { primary: number | 'down'; fallback: number | 'down' };
  five: Record<string, unknown>;
  fifteen: Record<string, unknown>;
}

function world(now: number, s: Scenario): World {
  const funds = {
    account: 'hana-id-relayer-preview.testnet',
    exists: true,
    amount: `42${E24}`,
    locked: '0',
    storage_usage: 2400,
    available: `41${E24}`,
    keys: [
      { public_key: PK_S, pool: 'session', allowance: `1${E24}` },
      { public_key: PK_S2, pool: 'session', allowance: `18${E24.slice(1)}` },
      { public_key: PK_O, pool: 'owner', allowance: `4${E24.slice(1)}` },
    ],
    other_keys: [],
    at: now - 3 * MIN,
    thresholds: { balance: { warn: `5${E24}`, critical: `1${E24}` }, session: { warn: `5${E24.slice(1)}`, critical: `1${E24.slice(1)}` }, owner: { warn: `1${E24.slice(1)}`, critical: `2${E24.slice(2)}` } },
  };
  const w: World = {
    builds: { api: BUILD, vault: BUILD, 'vault-bundle': BUILD, auth: BUILD, 'auth-pages': BUILD, issuer: BUILD, console: BUILD, 'console-spa': BUILD, 'console-auth': BUILD, files: BUILD },
    http: new Map(),
    watchdog: {
      service: 'hana-id-watchdog',
      env: 'sandbox-dev',
      build: BUILD,
      network: 'testnet',
      now,
      run_interval_ms: 5 * MIN,
      last_run: { id: 4120, started_at: now - 2 * MIN - 9_000, finished_at: now - 2 * MIN, outcome: 'ok', first_run: false, checks: CHECK_IDS.map((id) => ({ id, outcome: 'ok' })) },
      silent: false,
      heartbeat: { configured: true, last_ping_at: now - 2 * MIN, last_ok_at: now - 2 * MIN, ok: true, failures: 0 },
      channels: { pager: { provider: 'ntfy', configured: true }, slack: { configured: true }, email: { configured: true } },
      seen_kids: [],
      relayer_funds: funds,
      actions: [],
      open_alerts: [],
      checks: {},
      alert_kinds: {},
    },
    api: {
      ok: true,
      build: BUILD,
      hotDb: { ok: true, latencyMs: 4 },
      jwksSync: [{ job: 'jwks_sync:google', atMs: now - 6 * MIN, outcome: 'ok', detail: null }],
      notices: { pending: 0, oldestAt: null, truncated: false },
      relayerKeys: [
        { pool: 'session', publicKey: PK_S },
        { pool: 'session', publicKey: PK_S2 },
        { pool: 'owner', publicKey: PK_O },
      ],
      governance: {
        ok: true,
        snapshot: {
          paused: false,
          keyChanges: [],
          watchdogs: [{ accountId: 'hana-id-watchdog-preview.testnet', confirmFromMs: 0, canConfirm: true }],
          updaterKeys: [],
          signerAccessKeys: [],
          pendingUpgrade: null,
          pendingOwner: null,
          pendingWithdrawal: null,
          pendingConsoleAudiences: [],
          delays: {},
          updater: { lastRuns: [], proposals: [] },
          issuers: [{ provider: 'google', activeKids: ['a1b2c3', 'd4e5f6'], jwksKids: ['a1b2c3', 'd4e5f6'] }],
        },
      },
    },
    console: { ok: true, build: BUILD, db: { ok: true, latencyMs: 3 }, cron: { job: 'hourly', atMs: now - 34 * MIN, outcome: 'ok', detail: null }, notices: { pending: 0, oldestAt: null, truncated: false }, logos: 'ok' },
    near: { primary: now - 1_200, fallback: now - 1_500 },
    five: { at: now - 3 * MIN, notices: { acked: 1, failed: 0 }, feed: true, watcher: true, budgetLeft: 31, calls: { ops: 1, notices: 4, feed: 2, watcher: 2 } },
    fifteen: { at: now - 9 * MIN, budgetLeft: 36, calls: { ledger: 1, relayer_keys: 1, settlement: 2 }, failed: [] },
  };
  const wd = w.watchdog!;
  if (s === 'warnings') {
    // 3.2 NEAR: under the 5 NEAR warn line, above the 1 NEAR critical one.
    wd.relayer_funds = { ...funds, available: `32${E24.slice(1)}` };
    wd.channels = { pager: { provider: 'ntfy', configured: true }, slack: { configured: false }, email: { configured: true } };
    (w.api as Record<string, unknown>).notices = { pending: 2, oldestAt: now - 22 * MIN, truncated: false };
    w.console = { ...w.console, cron: 'missing' };
  }
  if (s === 'critical') {
    w.http.set(`${ORIGINS.api}/v1/health`, () => new Response('error code: 1101', { status: 503 }));
    w.api = null;
    w.near.primary = 'down';
    wd.open_alerts = [
      { id: 14, kind: 'forged_key_change', severity: 'critical', title: '[SANDBOX] Pending Google key change #31 doesn’t match Google’s published key', details: {}, created_at: now - 18 * MIN, resolved_at: null, acked_at: null, resends_until_ack: true, channels: ['pager', 'slack', 'email'], deliveries: [] },
    ];
    w.five = { ...w.five, notices: { acked: 0, failed: 3 } };
  }
  if (s === 'mixed-build') {
    for (const k of ['vault', 'vault-bundle', 'auth', 'auth-pages']) w.builds[k] = PREVIOUS;
  }
  if (s === 'watchdog-down') w.watchdog = null;
  return w;
}

const buildResponse = (id: string, build: string | null): Response => {
  if (id === 'vault-bundle') return new Response(`${build ? `/* hana-build ${build} */` : ''}\n(()=>{})();\n`);
  if (id === 'auth-pages' || id === 'console-spa') return new Response(`<!doctype html><html><head>${build ? `<meta name="hana-build" content="${build}">` : ''}</head><body></body></html>`);
  return Response.json({ ok: true, build });
};

const URLS: Record<string, string> = {
  api: `${ORIGINS.api}/v1/health`,
  vault: `${ORIGINS.vault}/.well-known/hana-build`,
  'vault-bundle': `${ORIGINS.vault}/vault.js`,
  auth: `${ORIGINS.auth}/.well-known/hana-build`,
  'auth-pages': `${ORIGINS.auth}/login`,
  issuer: `${ORIGINS.issuer}/v1/email/health`,
  console: `${ORIGINS.console}/.well-known/hana-build`,
  'console-spa': `${ORIGINS.console}/`,
  'console-auth': `${ORIGINS.consoleAuth}/.well-known/hana-build`,
  files: `${ORIGINS.files}/.well-known/hana-build`,
};

/** A fetch that answers the scenario's URLs only (each after a short, realistic delay). */
function fakeFetch(w: World): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = input instanceof Request ? input.url : String(input);
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
    const special = w.http.get(url);
    if (special) return special();
    if (url === `${WATCHDOG}/status`) return w.watchdog ? Response.json(w.watchdog) : new Response('upstream connect error', { status: 502 });
    for (const [id, u] of Object.entries(URLS)) if (url === u) return buildResponse(id, w.builds[id] ?? null);
    if (url === RPC || url === RPC_FALLBACK) {
      const at = url === RPC ? w.near.primary : w.near.fallback;
      if (at === 'down') return new Response('bad gateway', { status: 502 });
      return Response.json({ jsonrpc: '2.0', id: 'hana-status', result: { header: { height: 276_481_337, timestamp_nanosec: String(BigInt(at) * 1_000_000n) }, chunks: [] } });
    }
    throw new TypeError(`preview: no fake for ${url}`);
  }) as typeof fetch;
}

const bucket = { get: async () => null } as unknown as R2Bucket;

function fakeEnv(w: World): Env {
  const linkKey = Buffer.alloc(32, 7).toString('base64');
  return {
    ENV_NAME: 'sandbox-dev',
    ENV_LABEL: '[SANDBOX]',
    ADMIN_ORIGIN: 'http://127.0.0.1:8788',
    CONSOLE_ORIGIN: ORIGINS.console,
    FILES_ORIGIN: ORIGINS.files,
    HANA_BUILD: BUILD,
    NEAR_RPC: RPC,
    NEAR_RPC_FALLBACK: RPC_FALLBACK,
    API_URL: ORIGINS.api,
    VAULT_ORIGIN: ORIGINS.vault,
    AUTH_ORIGIN: ORIGINS.auth,
    EMAIL_ISSUER_URL: ORIGINS.issuer,
    CONSOLE_AUTH_ORIGIN: ORIGINS.consoleAuth,
    ACCOUNT_CRONS: JSON.stringify([
      { worker: 'hana-id-api-sandbox-dev', crons: 1 },
      { worker: 'hana-id-console-sandbox-dev', crons: 1 },
      { worker: 'hana-id-admin-sandbox-dev', crons: 2 },
      { worker: 'hana-id-watchdog-sandbox-dev', crons: 1 },
    ]),
    SIGNER_ACCOUNT: 'hana-id-signer-preview.testnet',
    RELAYER_ACCOUNT: 'hana-id-relayer-preview.testnet',
    ACCESS_TEAM_DOMAIN: 'preview.cloudflareaccess.invalid',
    ACCESS_AUD: 'ab'.repeat(32),
    STAFF_EMAILS: '["tze@hana.example"]',
    EMAIL_FROM: 'Hana ID <team@hana.example>',
    SECURITY_ALIAS: 'security@hana.example',
    APP_CHANGE_DELAY_MS: '60000',
    OWNER_GRANT_DELAY_MS: '60000',
    EMAIL_API_KEY: 'preview-not-a-key',
    CANCEL_LINK_KEY: linkKey,
    INVITE_LINK_KEY: linkKey,
    WATCHDOG_URL: WATCHDOG,
    WATCHDOG_STATUS_TOKEN: TOKEN,
    NEAR_NETWORK: 'testnet',
    USAGE_DB: { connectionString: 'postgresql://preview.invalid/usage' } as unknown as Hyperdrive,
    STATEMENTS: bucket,
    EXPORTS: bucket,
    API: { systemStatus: async () => (w.api ? w.api : Promise.reject(new Error('Service unavailable'))) } as unknown as Env['API'],
    CONSOLE: { health: async () => w.console } as unknown as Env['CONSOLE'],
    ISSUER: { health: async () => ({ ok: true, build: w.builds.issuer, db: { ok: true, latencyMs: 5 } }) } as unknown as Env['ISSUER'],
    ASSETS: {} as Fetcher,
  };
}

/** The scenario's answer, as `GET /api/status` gives it (a fresh read each time: no cache). */
export async function previewStatus(s: Scenario, now = Date.now()): Promise<StatusAnswer & { cached: boolean; ageMs: number }> {
  const w = world(now, s);
  const realFetch = globalThis.fetch;
  const realOpen = ledgerSource.open;
  globalThis.fetch = fakeFetch(w);
  ledgerSource.open = async () =>
    ({
      state: {
        getState: async () =>
          new Map([
            [CRON_LAST_RUN, { value: JSON.stringify(w.five), updatedAt: now }],
            [LEDGER_LAST_RUN, { value: JSON.stringify(w.fifteen), updatedAt: now }],
          ]),
        setState: async () => {},
      },
      partitionsAhead: async () => 11,
      settlementBacklog: async () => ({ pending: 2, oldestAt: now - 11 * MIN }),
      close: async () => {},
    }) as unknown as LedgerStore;
  try {
    resetStatusCache();
    const staff = { actor: { kind: 'hana' as const, id: 'access-sub-1', email: 'tze@hana.example' }, requestId: 'req_preview', clientIp: '127.0.0.1' };
    return { ...(await buildStatus(fakeEnv(w), staff, 'preview-jwt', now)), cached: false, ageMs: 0 };
  } finally {
    globalThis.fetch = realFetch;
    ledgerSource.open = realOpen;
  }
}
