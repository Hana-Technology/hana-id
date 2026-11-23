// The System status page's preview scenarios (D425; test-spa/preview.ts): the real `buildStatus` (src/status.ts) run
// over fake sources, so the page shows exactly what the Worker would answer: every Worker's build read, the watchdog's
// `/status`, the three health RPCs, NEAR, the ledger and R2, all answered here. Nothing reaches a network; every URL,
// key and id is made up (`.example`/`.invalid`).
//
//   green          every check passes: "All systems operational"
//   warnings       a few amber issues: the relayer's balance under its warn line, a watchdog alert channel off, blocking
//                  notices waiting 22 minutes, the console's cron record table missing
//   critical       an outage: the API Worker answering 503 (its status call failing too), every NEAR RPC endpoint down,
//                  an unacknowledged critical watchdog alert
//   mixed-build    a half-done deploy: the page Workers and their bundles on the previous build
//   watchdog-down  the watchdog unreachable: one red issue, what it reports unknown
//   relay-low      the NEAR relay account under `lowBalanceNear` (amber)
//   relay-budget   the NEAR relay at 86% of its daily budget (amber)
//   relay-key-missing  one of the API's two NEAR relay keys not on the relay account (red)
//   relay-off      no NEAR relay in this env (Not measured, no issue)
//   relay-stale    the NEAR relay's reading 40 minutes old (amber; the API reads it live, so only a test shows it)
//   fees-working   gas sponsorship on Base Sepolia (D843): working, two transactions waiting
//   fees-paused-money  paused: the relayer's wallet is out of money (`relayer_cannot_send` · `insufficient_funds`), before
//                  the refill: it restarts by itself once the wallet has enough (D890)
//   fees-money-arrived  the same pause, the money there: "Restarting by itself"
//   fees-money-held  the money there, but its second network server unreachable on two checks in a row: named, Resume
//   fees-auto-restarted  working again: it restarted by itself after the refill, 4 s ago
//   fees-money-limit  paused for money, but it already restarted by itself 3 times today: a person presses Resume
//   fees-money-limit-refilled  the same, the money there: press Resume, don't send more
//   fees-paused-money-leak  paused for money, then the relayer saw a sign of a leaked key (its `leakSeen` mark)
//   fees-paused-key    paused: someone else used the relayer's key (`foreign_transactions`)
//   fees-low       working, but the relayer's wallet under its low line
//   fees-no-endpoint  set up, but the relayer's trusted read endpoint secret missing (sponsorship off: Not set up)
// Every other scenario has no `evm.sponsor` (the API answers no `evmRelay`): the tile says "Not set up".
// `previewEvmDetail` and `previewEvmAct` answer the "Gas sponsorship" page and its tools through the Worker's own
// routes (src/evm-relay.ts) over the same fake views.
import { CRON_LAST_RUN } from '../src/cron.ts';
import type { Env } from '../src/env.ts';
import { LEDGER_LAST_RUN } from '../src/ledger-cron.ts';
import { type LedgerStore, ledgerSource } from '../src/ledger.ts';
import { type StatusAnswer, buildStatus, resetStatusCache } from '../src/status.ts';
import type { EvmRelayChainView, EvmRelayDetail, EvmRelayRecordView, EvmRelayStaffEntry } from '@hana-id/console-core';
import { evmRelayActRoute, evmRelayDetailRoute } from '../src/evm-relay.ts';
import type { RouteCtx } from '../src/routes.ts';

export const SCENARIOS = ['green', 'warnings', 'critical', 'mixed-build', 'watchdog-down', 'relay-low', 'relay-budget', 'relay-key-missing', 'relay-off', 'relay-stale', 'fees-working', 'fees-paused-money', 'fees-money-arrived', 'fees-money-held', 'fees-auto-restarted', 'fees-money-limit', 'fees-money-limit-refilled', 'fees-paused-money-leak', 'fees-paused-key', 'fees-low', 'fees-no-endpoint'] as const;
export type Scenario = (typeof SCENARIOS)[number];

const BUILD = '8a797fe1c2d3';
const PREVIOUS = '22a4d7f90b1e';
const MIN = 60_000;
const E24 = '000000000000000000000000';
const PK_S = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';
const PK_S2 = 'ed25519:9kWv2yFJq7Bf3mPnZcLx4T8uDhR5sGaQ1eNoYiKjVbXw';
const PK_O = 'ed25519:3eNPkjVtn4cHy2BUUgnK3E2q4pCs3LMC5eEFrBsPpnnr';
const PK_R2 = 'ed25519:8hR1jJ4tvsG5k3ZVxNw2yQe9eHPuQyD7Gq1b6T3m2dCx';
const WATCHDOG = 'https://hana-id-watchdog-preview.preview.invalid';
const TOKEN = 'preview-only-watchdog-status-token-not-a-secret';
const RPC = 'https://rpc.preview.invalid';
const RPC_FALLBACK = 'https://rpc-fallback.preview.invalid';
const RPC_BACKUP = 'https://rpc-backup.preview.invalid';
const ORIGINS = { api: 'https://api.preview.invalid', vault: 'https://vault.preview.invalid', auth: 'https://auth.preview.invalid', issuer: 'https://email.preview.invalid', console: 'https://console.preview.invalid', consoleAuth: 'https://console-auth.preview.invalid', files: 'https://files.preview.invalid' };
const CHECK_IDS = ['config', 'jwks_fetch', 'chain_read', 'watchdog_role', 'pending_key_changes', 'active_keys', 'signer_policy', 'links', 'identity_on_chain', 'governance_diff', 'unexecuted_changes', 'relayer_funds', 'alert_delivery', 'digest', 'heartbeat', 'email_jwks', 'identity_jwks'];

interface World {
  builds: Record<string, string | null>;
  http: Map<string, () => Response>;
  watchdog: Record<string, unknown> | null;
  api: Record<string, unknown> | null;
  console: Record<string, unknown>;
  near: { primary: number | 'down'; fallback: number | 'down'; backup: number | 'down' };
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
      nearRelay: {
        state: 'on',
        offReason: null,
        readAt: now - 1_000,
        account: 'hana-id-near-relay-preview.testnet',
        lowBalanceYocto: `2${E24}`,
        dailyBudgetYocto: `5${E24}`,
        budgetAlertPct: 80,
        chain: { ok: true, exists: true, availableYocto: `117${E24.slice(1)}`, fullAccessKeys: 3 },
        keys: { configured: 2, missing: [] },
        spend: { ok: true, day: new Date(now).toISOString().slice(0, 10), spentYocto: `62${E24.slice(2)}` },
      },
      evmRelay: { state: 'absent', chains: [] },
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
    near: { primary: now - 1_200, fallback: now - 1_500, backup: now - 1_800 },
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
    w.near = { primary: 'down', fallback: 'down', backup: 'down' };
    wd.open_alerts = [
      { id: 14, kind: 'forged_key_change', severity: 'critical', title: '[SANDBOX] Pending Google key change #31 doesn’t match Google’s published key', details: {}, created_at: now - 18 * MIN, resolved_at: null, acked_at: null, resends_until_ack: true, channels: ['pager', 'slack', 'email'], deliveries: [] },
    ];
    w.five = { ...w.five, notices: { acked: 0, failed: 3 } };
  }
  if (s === 'mixed-build') {
    for (const k of ['vault', 'vault-bundle', 'auth', 'auth-pages']) w.builds[k] = PREVIOUS;
  }
  if (s === 'watchdog-down') w.watchdog = null;
  const relay = ((w.api ?? {}) as { nearRelay?: Record<string, unknown> }).nearRelay ?? {};
  // 1.4 NEAR: under the 2 NEAR line, above the 0.4 NEAR critical one.
  if (s === 'relay-low') relay.chain = { ok: true, exists: true, availableYocto: `14${E24.slice(1)}`, fullAccessKeys: 3 };
  if (s === 'relay-budget') relay.spend = { ok: true, day: new Date(now).toISOString().slice(0, 10), spentYocto: `43${E24.slice(1)}` };
  if (s === 'relay-key-missing') relay.keys = { configured: 2, missing: [PK_R2] };
  if (s === 'relay-stale') relay.readAt = now - 40 * MIN;
  if (s.startsWith('fees-') && w.api) (w.api as Record<string, unknown>).evmRelay = { state: 'on', chains: [evmView(now, s)] };
  if (s === 'relay-off') (w.api as Record<string, unknown>).nearRelay = { state: 'off', offReason: 'none', readAt: now, account: null, lowBalanceYocto: null, dailyBudgetYocto: null, budgetAlertPct: null, chain: null, keys: null, spend: null };
  return w;
}

// ---- gas sponsorship (D843) ----

const EVM_RELAYER = '0x7aD3c18E50fB2a6D9e4C31b0F5A7E8c2d1B9f640';
const EVM_HELPER = '0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA';
const EVM_HELPER_HASH = '0xfcc832fe6c7167e0d45589881b103fed92b3a44fe3dd5d489f43e9d44b1e5fd2';
const MILLI = 10n ** 15n;
const hashOf = (n: number, k = 'a'): string => `0x${k.repeat(56)}${String(n).padStart(8, '0')}`;
const staffEntry = (seq: number, at: number, over: Partial<EvmRelayStaffEntry> = {}): EvmRelayStaffEntry => ({ seq, at, who: 'tze@hana.example', tool: 'resume', slot: null, note: 'Sent 0.1 test ETH from the faucet; balance now 0.11', done: true, refused: null, ...over });

/** Paused for money (before or after the refill, D890), and (`-leak`) a sign of a leaked key seen since (the relayer's mark, D843 re-check M). */
const isMoney = (s: string): boolean => ['fees-paused-money', 'fees-money-arrived', 'fees-money-held', 'fees-money-limit', 'fees-money-limit-refilled', 'fees-paused-money-leak'].includes(s);
/** The money there again (D890): 0.25 test ETH. */
const refilled = (s: string): boolean => s === 'fees-money-arrived' || s === 'fees-money-held' || s === 'fees-money-limit-refilled';
const AUTO_NOTE = 'Restarted by itself after a refill (D890). Trusted endpoint: balance 250000000000000000 wei (at least 53800000000000000 needed), count 41 (pending 44, next slot 44) after block 18402211, no code at the wallet. Second endpoint: count 41 (pending 44), balance 250000000000000000 wei, no code.';

/** The relayer's automatic restart (D890) as each scenario has it. */
function autoOf(now: number, s: Scenario | 'fees-resumed'): NonNullable<Extract<EvmRelayChainView['relayer'], { ok: true }>['autoRestart']> {
  const limited = s === 'fees-money-limit' || s === 'fees-money-limit-refilled';
  const recent = s === 'fees-auto-restarted' ? [now - 4_000] : limited ? [now - 70 * MIN, now - 3 * 60 * MIN, now - 5 * 60 * MIN] : [];
  const pause = isMoney(s) ? { blocked: s === 'fees-paused-money-leak' ? 'leak_seen' : limited ? 'daily_limit' : null, restartWei: (538n * 10n ** 14n).toString(), resumeWei: (5n * 10n ** 13n).toString(), check: s === 'fees-money-held' ? { at: now - 20_000, blocked: 'second_endpoint_unavailable', balanceWei: (250n * MILLI).toString(), streak: 2 } : { at: now - 20_000, blocked: 'relayer_cannot_send', balanceWei: (2n * 10n ** 13n).toString(), streak: 30 } } : null;
  return { limit: 3, today: s === 'fees-auto-restarted' ? 1 : limited ? 3 : 0, recent, pause };
}

export function evmView(now: number, s: Scenario | 'fees-resumed'): EvmRelayChainView {
  const paused = isMoney(s) || s === 'fees-paused-key';
  const balance = refilled(s) ? 250n * MILLI : isMoney(s) ? 2n * 10n ** 13n : s === 'fees-low' ? 31n * MILLI : s === 'fees-auto-restarted' ? 249n * MILLI : 112n * MILLI;
  const base = [staffEntry(3, now - 26 * 60 * MIN), staffEntry(2, now - 27 * 60 * MIN, { tool: 'cancel', slot: 38, note: 'Time limit long gone; slot 39 waiting behind it', done: false, refused: 'nonce_mined' }), staffEntry(1, now - 50 * 60 * MIN)];
  const log = s === 'fees-auto-restarted' ? [staffEntry(4, now - 4_000, { who: 'relayer (automatic)', note: AUTO_NOTE, auto: true }), ...base] : base;
  return {
    chainId: 84532,
    readAt: now,
    relayerAddress: EVM_RELAYER,
    key: 'ok',
    readEndpoint: s === 'fees-no-endpoint' ? 'missing' : 'keyed',
    lowBalanceWei: (50n * MILLI).toString(),
    dailyBudgetWei: (20n * MILLI).toString(),
    oneSendWorstWei: (6n * 10n ** 14n).toString(),
    relayer: {
      ok: true,
      started: true,
      signerAddress: EVM_RELAYER,
      halted: isMoney(s) ? { reason: 'relayer_cannot_send', since: now - 12 * MIN, slot: 42, code: 'insufficient_funds', leakSeen: s === 'fees-paused-money-leak' } : s === 'fees-paused-key' ? { reason: 'foreign_transactions', since: now - 4 * MIN, slot: null, code: null, leakSeen: true } : null,
      waiting: s === 'fees-paused-key' ? 0 : 2,
      awaitingConfirmation: s === 'fees-working' || s === 'fees-resumed' || s === 'fees-auto-restarted' ? 1 : 0,
      oldestWaitingMs: s === 'fees-paused-key' ? null : paused ? 13 * MIN : 40_000,
      oldestNotTakenMs: isMoney(s) ? 13 * MIN : null,
      nextSlot: 44,
      spentTodayWei: (isMoney(s) ? 7n * MILLI : 3n * MILLI).toString(),
      unconfirmedRefusals: null,
      lastStaffSeq: log[0]!.seq,
      staffLog: log,
      autoRestart: autoOf(now, s),
    },
    budget: { ok: true, spentWei: (isMoney(s) ? 7n * MILLI : 3n * MILLI).toString() },
    balance: { ok: true, wei: balance.toString() },
    helper: { address: EVM_HELPER, pinnedCodeHash: EVM_HELPER_HASH, ok: true, codeHash: EVM_HELPER_HASH, matches: true },
  };
}

function evmRecords(now: number, s: Scenario | 'fees-resumed'): EvmRelayRecordView[] {
  if (s === 'fees-paused-key') return [];
  const app = { id: 'app_01jdzdemo', name: 'Journear demo' };
  const stamps = { id: 'app_01jdzstamps', name: 'Journear stamps' };
  if (isMoney(s))
    return [
      { slot: 42, kind: 'action', onChain: false, taken: false, cancelling: true, sentAt: now - 13 * MIN, deadlineAt: now - 8 * MIN, copies: [{ hash: hashOf(42), kind: 'action' }, { hash: hashOf(42, 'c'), kind: 'cancel' }], refusedCode: 'insufficient_funds', app },
      { slot: 43, kind: 'action', onChain: false, taken: true, cancelling: false, sentAt: now - 11 * MIN, deadlineAt: now - 6 * MIN, copies: [{ hash: hashOf(43), kind: 'action' }, { hash: hashOf(43, 'b'), kind: 'action' }], refusedCode: null, app: stamps },
    ];
  return [
    { slot: 41, kind: 'action', onChain: true, taken: true, cancelling: false, sentAt: now - 70_000, deadlineAt: now + 230_000, copies: [{ hash: hashOf(41), kind: 'action' }], refusedCode: null, app },
    { slot: 42, kind: 'action', onChain: false, taken: true, cancelling: false, sentAt: now - 6 * MIN, deadlineAt: now - 60_000, copies: [{ hash: hashOf(42), kind: 'action' }, { hash: hashOf(42, 'b'), kind: 'action' }], refusedCode: null, app: stamps },
    { slot: 43, kind: 'action', onChain: false, taken: false, cancelling: false, sentAt: now - 9_000, deadlineAt: now + 291_000, copies: [{ hash: hashOf(43), kind: 'action' }], refusedCode: null, app },
  ];
}

const previewStaff = { actor: { kind: 'hana' as const, id: 'access-sub-1', email: 'tze@hana.example' }, requestId: 'req_preview_fees', clientIp: '127.0.0.1' };

/** `GET /api/evm-relay/84532` for a fees scenario (any other scenario: the env has no sponsorship: not found). */
export async function previewEvmDetail(s: Scenario | 'fees-resumed', now = Date.now()): Promise<{ status: number; body: unknown }> {
  const on = s.startsWith('fees-');
  const detail: EvmRelayDetail = { chain: evmView(now, s), records: evmRecords(now, s), apps: 'recorded', chainCount: s === 'fees-paused-key' ? { ok: true, latest: 47, pending: 47 } : { ok: true, latest: 41, pending: 44 } };
  const env = { API: { evmRelayDetail: async () => (on ? { ok: true, detail } : { ok: false, code: 'not_found', error: 'EVM sponsorship is not set up in this environment' }) } } as unknown as Env;
  const res = await evmRelayDetailRoute({ env, staff: previewStaff, params: { chain: '84532' }, body: {} } as unknown as RouteCtx);
  return { status: res.status, body: await res.json() };
}

/** `POST /api/evm-relay/84532/act`: a resume is done (the scenario then shows it working); every other tool is refused as the relayer would. */
export async function previewEvmAct(body: Record<string, unknown>, s: Scenario | 'fees-resumed', now = Date.now()): Promise<{ status: number; body: unknown; resumed: boolean }> {
  const refused = body.tool === 'resume' ? ((s === 'fees-paused-key' || s === 'fees-paused-money-leak') && body.keyConfirmed !== true ? 'key_confirmation_required' : null) : body.tool === 'cancel' ? 'nonce_mined' : body.tool === 'fill' ? 'not_the_chains_next_nonce' : body.tool === 'close' ? 'nonce_not_consumed_at_confirmed_depth' : 'unmined_records';
  const view = evmView(now, refused === null ? 'fees-resumed' : s);
  const env = {
    CONSOLE: { recordStaffAction: async () => ({ ok: true }) },
    API: { evmRelayVersion: async () => ({ ok: true, version: 1 }), evmRelayAct: async () => ({ ok: true, result: { done: refused === null, refused, relayer: view.relayer.ok ? view.relayer : null } }) },
  } as unknown as Env;
  const res = await evmRelayActRoute({ env, staff: previewStaff, params: { chain: '84532' }, body } as unknown as RouteCtx);
  return { status: res.status, body: await res.json(), resumed: res.status === 200 && refused === null };
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
    if (url === RPC || url === RPC_FALLBACK || url === RPC_BACKUP) {
      const at = url === RPC ? w.near.primary : url === RPC_FALLBACK ? w.near.fallback : w.near.backup;
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
    NEAR_RPC_FALLBACKS: JSON.stringify([RPC_FALLBACK, RPC_BACKUP]),
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
    EMAIL_FROM: 'Journear Passport <team@hana.example>',
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
