// One admin lane (admin-lane.ts), in a worker thread of its own: the staff admin portal (apps/admin's REAL Worker and
// SPA) on the lane's origin, behind the stack's Cloudflare Access stand-in, bound to its own copy of the API:
//
//   API      apps/api's real AdminRpc entrypoint, on the lane's own D1 (apps/api's migrations) and EVM gas sponsorship
//            with the REAL relayer object (EvmRelayer, in memory) on chain 31337 (lane-evm.ts), signing with a key
//            made when the lane starts. The relayer is the lane's alone: a test may pause it without touching the
//            relayer the rest of the suite sends through (api.ts), or another browser's lane.
//   CONSOLE  apps/console's real StaffRpc entrypoint on its own D1 (apps/console's migrations): the audit log.
//   ISSUER   the stack's email issuer's real DirectoryRpc, in the main thread, through admin-lane.ts's bridge: it
//            verifies the forwarded staff token itself.
//   NEAR     the stack's mocked NEAR chain (chain.ts), a copy of its own (the users' sessions on chain).
//   USAGE_DB the usage ledger: PGlite with apps/api's ledger migrations, reached by the admin's own `pg` client over a
//            loopback wire-protocol listener as role usage_admin (pglite-wire.ts), as through Hyperdrive. Empty: the
//            stack's API writes no usage events. Both Workers have NEON_PLAN (Neon's free plan, D872), as testnet's
//            manifest sets it: System status never opens the ledger (it reads what the admin's runs reported), the
//            pages that do report their wake-up to the API, and the "Neon compute this month" tile counts them.
//
// Each binding is called as workerd calls a service binding: arguments and answers are structured clones.
// Calls between the lane's parts that would cross the network (the API's chain reads, the Access certs) are answered
// in this thread's `fetch`; the rest of the stack is reached over HTTP (the status page's build reads).
//
// THE ACCESS STAND-IN (the edge, in front of the Worker, as Cloudflare Access is): it never decides anything. A request
// carrying the `CF_Authorization` cookie gets that cookie's value as `Cf-Access-Jwt-Assertion` (and any such header the
// client sent is dropped first); without the cookie it reaches the Worker with no token at all. The admin Worker's own
// code (apps/admin src/access.ts) verifies every token against the stand-in's certs and its staff list, so a forged,
// expired or missing token, or someone not on the list, is refused by the product itself. The sign-in is
// `GET /__e2e/access/sign-in?as=staff|outsider[&to=/path]`: a token signed at the real time by the stack's throwaway
// team key, set as the cookie (HttpOnly, SameSite=Lax), then a redirect to the page.
//
// THE CONTROLS (`/__e2e/lane/*`, no CORS, refused with an `Origin`, so no page can call them; served by this edge and
// never by the Worker):
//   GET  /__e2e/lane/state                 the relayer's slots and pause, the chain's counts, the lane's clock
//   POST /__e2e/lane/scenario {name}       puts the relayer in a state (SCENARIOS below); answers the state
//   POST /__e2e/lane/clock {advanceMs, keepStatusCache?}  moves the lane's clock forward (lane-clock.ts); the status
//                                          page's 30 s cache is emptied unless `keepStatusCache`
//   POST /__e2e/lane/run {times?}          time passes for the relayer: its alarm runs (then the API cron's relay check)
//   POST /__e2e/lane/acquire               waits until no other test holds the lane, then holds it → {lease}; a lease
//                                          ends by `release {lease}` or after 3 minutes (a test that died). The suite's
//                                          tests each hold their lane (tests/admin-fixtures.ts), so two runs or
//                                          `--repeat-each` never share a relayer at once; the hand test needs none.
// Test lanes run the relayer's alarm only when a control says so (`manualAlarms`); the hand-test lane also on its own,
// as deployed (soon after a change, then less often).
import './lane-clock-install.ts';
import { parentPort, workerData } from 'node:worker_threads';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ed25519 } from '@noble/curves/ed25519';
import { toHex } from '@hana-id/core';
import { type ExecuteInput, signAuthorization, signExecute } from '@hana-id/core/evm-sponsor';
import { signWalletProof, walletProofMessage } from '@hana-id/core/identity';
import { evmSponsorSessionMessage } from '@hana-id/core/sponsor-session';
import { type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { ACCESS_AUD, ACCESS_TEAM, type AccessKeys, E2E_OUTSIDER, E2E_STAFF, installAccessCerts, signAccessJwt } from './access.ts';
import { AUTH_ORIGIN, API_URL, E2E_CHECK_IN, E2E_ENV, E2E_SPONSOR_TARGETS, ENV_NAME, EVM_CHAIN_ID, ISSUER_URL, PARTNER_ORIGIN, VAULT_ORIGIN, e2eEvmSponsorVar } from '../stack.ts';
import { MockApi } from './api.ts';
import { loadApiModules } from './api-modules.ts';
import { Chain } from './chain.ts';
import { D1Shim } from './d1.ts';
import { json } from './http.ts';
import { LaneEvm } from './lane-evm.ts';
import { LedgerWire, type PGliteLike } from './pglite-wire.ts';
import { advanceLaneClock, laneClockOffset, realNow } from './lane-clock.ts';
import { ExecContext, MemoryNamespace } from './workers.ts';

export interface LaneData {
  name: string;
  /** The admin Worker's origin (ADMIN_ORIGIN). */
  origin: string;
  access: AccessKeys;
  /** The relayer's alarm only by the controls (the suite's lanes), or also by itself (the hand-test lane). */
  manualAlarms: boolean;
}

const data = workerData as LaneData;
const port = parentPort!;

// As the stack's own (main.ts): the Workers' info-level JSON lines only with LOG=1; warnings and errors always.
if (!process.env.LOG) {
  const info = console.log.bind(console);
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('{"level":"info"')) return;
    info(...args);
  };
}

/** The lane's chain endpoints: `*.localhost` (loopback, as a local* env's sponsorship requires), answered in this thread. */
const LANE_NEAR = 'http://near.admin-lane.localhost';
const LANE_EVM = 'http://evm.admin-lane.localhost';
/**
 * The lane's second endpoint (`rpcFallback`), the same chain: broadcasts may reach it, and the relayer's automatic restart
 * after a refill asks it before restarting (D890: a `local*` env without one never restarts by itself).
 */
const LANE_EVM_FALLBACK = 'http://evm-fallback.admin-lane.localhost';
const CONSOLE_MIGRATIONS = fileURLToPath(new URL('../../../console/migrations/', import.meta.url));
const ADMIN_PUBLIC = fileURLToPath(new URL('../../../admin/public/', import.meta.url));
const SRC = (app: string, path: string): string => new URL(`../../../${app}/src/${path}`, import.meta.url).href;
const COOKIE = 'CF_Authorization';
/** The demo check-in: the one call the lane's app makes (on the lane's allowlist, as on the stack's). */
const CHECK_IN_CALL = { to: E2E_CHECK_IN, value: '0', data: '0x183ff085' };

// ---- the product modules (loaded after the lane's clock is in place) ----

const modules = await loadApiModules();
const { AdminRpc } = (await import(SRC('api', 'rpc/admin.ts'))) as { AdminRpc: new (ctx: unknown, env: unknown) => object };
const sponsor = (await import(SRC('api', 'evm/sponsor.ts'))) as {
  sponsorTiming: { receiptWaitMs: number; receiptPollMs: number };
  checkEvmSponsorRelay(env: unknown, now?: number): Promise<void>;
  forgetRelayerBalances(): void;
  forgetRelayerStatus(): void;
};
const staffTools = (await import(SRC('api', 'evm-relayer-staff.ts'))) as { evmRelayerStaffStatus(stub: unknown): Promise<RelayerStatus> };
const relayerMod = (await import(SRC('api', 'evm-relayer.ts'))) as { evmRelayerName(chainId: number): string };
const admin = (await import(SRC('admin', 'index.ts'))) as { default: { fetch(request: Request, env: unknown): Promise<Response> } };
const adminStatus = (await import(SRC('admin', 'status.ts'))) as { resetStatusCache(): void };
const { StaffRpc } = (await import(SRC('console', 'staff-rpc.ts'))) as { StaffRpc: new (ctx: unknown, env: unknown) => object };
const { PGlite } = (await import('@electric-sql/pglite')) as unknown as { PGlite: new () => PGliteLike };

/** The lane's usage ledger: every migration of apps/api's migrations-usage, then the admin role's connection string. */
async function startLedger(): Promise<{ wire: LedgerWire; url: string }> {
  const db = new PGlite();
  const dir = new URL('../../../api/migrations-usage/', import.meta.url);
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) await db.exec(readFileSync(new URL(f, dir), 'utf8'));
  const wire = new LedgerWire(db, 'usage_admin');
  return { wire, url: await wire.listen() };
}
const ledger = await startLedger();
/** `usage.neonPlan` as testnet's manifest has it (the free plan: 100 compute-hours a month at 0.25 CU), D872. */
const NEON_PLAN = JSON.stringify({ computeHoursPerMonth: 100, computeUnits: 0.25 });

/** The relayer's staff status (apps/api evm-relayer.ts EvmRelayerStaffStatus), the fields the controls read. */
interface RelayerStatus {
  nextNonce: number | null;
  halted: null | { reason: string; nonce?: number; code?: string; leakSeen?: true; since: number };
  unmined: number;
  records: { nonce: number; digest: string | null; seen: unknown; accepted: boolean; deadline: number; versions: { hash: string; kind: string }[] }[];
  staffLog: { seq: number; action: string; done: boolean; refused: string | null; who: string; note: string; auto?: true }[];
}

// A held transaction would keep a send waiting for its receipt for 30 s: the lane's sends give up after 1.5 s (504),
// as the anvil lane's do; the relayer keeps the transaction either way.
sponsor.sponsorTiming.receiptWaitMs = 1_500;
sponsor.sponsorTiming.receiptPollMs = 50;

// ---- bindings ----

/** A service binding to `target`: every call's arguments and answer are structured clones, as over workerd's RPC. */
function binding<T extends object>(target: T): T {
  return new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return undefined;
      const v = (t as Record<PropertyKey, unknown>)[prop];
      if (typeof v !== 'function') return undefined;
      return async (...args: unknown[]) => structuredClone(await (v as (...a: unknown[]) => unknown).apply(t, structuredClone(args)));
    },
  });
}

let rpcSeq = 0;
const pendingRpc = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
/** The main thread's issuer DirectoryRpc (admin-lane.ts answers): a structured clone each way, as a service binding. */
const issuerBridge = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === 'then' || typeof prop !== 'string') return undefined;
      return (...args: unknown[]) =>
        new Promise((resolve, reject) => {
          rpcSeq += 1;
          pendingRpc.set(rpcSeq, { resolve, reject });
          port.postMessage({ type: 'rpc', id: rpcSeq, target: 'issuer', method: prop, args });
        });
    },
  },
);

const TYPES: Record<string, string> = { '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8' };

/** The SPA's assets binding (apps/admin `public/`, `not_found_handling: single-page-application`): a file, else index.html. */
const assets = {
  async fetch(request: Request): Promise<Response> {
    const path = decodeURIComponent(new URL(request.url).pathname);
    const file = normalize(join(ADMIN_PUBLIC, path === '/' ? 'index.html' : path));
    const inside = file.startsWith(ADMIN_PUBLIC.endsWith(sep) ? ADMIN_PUBLIC : `${ADMIN_PUBLIC}${sep}`);
    try {
      if (!inside) throw new Error('outside');
      return new Response(await readFile(file), { headers: { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' } });
    } catch {
      return new Response(await readFile(join(ADMIN_PUBLIC, 'index.html')), { headers: { 'content-type': TYPES['.html']! } });
    }
  },
};

// ---- the lane ----

const randomKey = (): string => Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64');

/** The API's EVM_SPONSOR for the lane: the stack's chain settings, the lane's relayer and chain endpoint, its one app. */
function laneSponsorVar(relayer: string, appId: string): string {
  const v = JSON.parse(e2eEvmSponsorVar(relayer, [appId], E2E_SPONSOR_TARGETS)) as { chains: Record<string, { rpc: string; rpcFallback?: string; autoRestart?: boolean }> };
  v.chains[String(EVM_CHAIN_ID)]!.rpc = LANE_EVM;
  v.chains[String(EVM_CHAIN_ID)]!.rpcFallback = LANE_EVM_FALLBACK;
  // D890: on for the hand test and the suite (default off until the checks on Base Sepolia).
  v.chains[String(EVM_CHAIN_ID)]!.autoRestart = true;
  return JSON.stringify(v);
}

interface Sent {
  status: number;
  code: string | null;
  deadlineMs: number;
}

class Lane {
  readonly d1 = new D1Shim();
  readonly chain = new Chain();
  readonly api: MockApi;
  readonly consoleEnv = { CONSOLE_DB: new D1Shim(CONSOLE_MIGRATIONS), ENV_NAME, NETWORK: 'testnet', OWNER_GRANT_DELAY_MS: String(24 * 3_600_000) };
  readonly adminEnv: Record<string, unknown>;
  evm!: LaneEvm;
  relayerAddress!: Hex;
  app!: { appId: string; pk: string };
  scope = '';
  private apps = 0;
  private readonly exec = new ExecContext();

  constructor() {
    this.api = new MockApi(this.d1, this.chain, modules, { nearRpc: LANE_NEAR, fingerprint: `admin-lane-${data.name}` });
    this.api.env.NEON_PLAN = NEON_PLAN;
    const apiRpc = binding(new AdminRpc(new ExecContext(), this.api.env));
    const staffRpc = binding(new StaffRpc(new ExecContext(), this.consoleEnv));
    this.adminEnv = {
      ENV_NAME,
      ENV_LABEL: '[LOCAL]',
      ADMIN_ORIGIN: data.origin,
      // The stack has no partner console or files Worker: `.invalid` hosts (RFC 6761) the status page doesn't read.
      CONSOLE_ORIGIN: 'http://console.e2e.invalid',
      FILES_ORIGIN: 'http://files.e2e.invalid',
      NEAR_RPC: LANE_NEAR,
      API_URL,
      VAULT_ORIGIN,
      AUTH_ORIGIN,
      EMAIL_ISSUER_URL: ISSUER_URL,
      EMAIL_SIGNER_KIND: 'worker-secret',
      SIGNER_ACCOUNT: E2E_ENV.signer,
      RELAYER_ACCOUNT: E2E_ENV.relayer,
      ACCESS_TEAM_DOMAIN: ACCESS_TEAM,
      ACCESS_AUD,
      STAFF_EMAILS: JSON.stringify([E2E_STAFF]),
      EMAIL_FROM: 'Journear Passport E2E <security@e2e.invalid>',
      SECURITY_ALIAS: 'security@e2e.invalid',
      APP_CHANGE_DELAY_MS: String(24 * 3_600_000),
      OWNER_GRANT_DELAY_MS: String(24 * 3_600_000),
      NEAR_NETWORK: 'testnet',
      // The link keys (throwaway, per lane); no EMAIL_API_KEY: no mail leaves the stack (the status page says so).
      CANCEL_LINK_KEY: randomKey(),
      INVITE_LINK_KEY: randomKey(),
      API: apiRpc,
      CONSOLE: staffRpc,
      ISSUER: issuerBridge,
      ASSETS: assets,
      USAGE_DB: { connectionString: ledger.url },
      NEON_PLAN,
    };
    this.fresh();
  }

  /**
   * A new relayer (key, object, chain) and a new app with its own sponsorship, the API's per-isolate caches and the
   * status page's cache emptied. The D1s (the audit log, the security events), the ledger and the lane's clock (it only
   * moves forward, so the audit log's times stay in order) stay.
   */
  fresh(): void {
    const key = generatePrivateKey();
    this.relayerAddress = privateKeyToAddress(key);
    this.evm = new LaneEvm(key);
    this.apps += 1;
    this.scope = `stafflane${this.apps}`;
    this.app = this.api.createApp({ name: 'Check-in demo', scopeId: this.scope, origins: [PARTNER_ORIGIN], settings: { persistence: 'none' } });
    const env = this.api.env;
    env.EVM_SPONSOR = laneSponsorVar(this.relayerAddress, this.app.appId);
    env.EVM_RELAY_KEYS = JSON.stringify([key]);
    env.EVM_RELAYER = new MemoryNamespace(modules.EvmRelayer, () => env, data.manualAlarms ? { manualAlarms: true } : { soonAlarmMs: 250 });
    sponsor.forgetRelayerBalances();
    sponsor.forgetRelayerStatus();
    adminStatus.resetStatusCache();
  }

  relayer(): { alarm(): Promise<void> } {
    const ns = this.api.env.EVM_RELAYER as MemoryNamespace<{ alarm(): Promise<void> }>;
    return ns.get(ns.idFromName(relayerMod.evmRelayerName(EVM_CHAIN_ID)));
  }

  async status(): Promise<RelayerStatus> {
    return staffTools.evmRelayerStaffStatus(this.relayer());
  }

  /** Time passes for the relayer: its alarm runs `times` times, then the API cron's relay check (its security events). */
  async run(times = 1): Promise<void> {
    for (let i = 0; i < times; i += 1) await this.relayer().alarm();
    await sponsor.checkEvmSponsorRelay(this.api.env);
  }

  /**
   * One sponsored check-in by a new user of the lane's app, as the vault sends it: a session on the lane's chain, the
   * session proof (D856) on prepare and send, the Execute (and the account's setup) signed with the user's key, through
   * apps/api's own routes, which hand it to the relayer.
   */
  async sendCheckIn(): Promise<Sent> {
    const sessionKey = ed25519.utils.randomPrivateKey();
    const spk = ed25519.getPublicKey(sessionKey);
    const userKey = Uint8Array.from(Buffer.from(generatePrivateKey().slice(2), 'hex'));
    const account = privateKeyToAddress(`0x${Buffer.from(userKey).toString('hex')}`);
    const scope = this.scope;
    this.chain.sessions.set(toHex(spk), { path: `${scope}#google#lane${toHex(spk).slice(0, 12)}#0`, scope_id: scope, expires_at_ms: Date.now() + 24 * 3_600_000, max_uses: 1000, used: 1 });
    const call = async (route: 'prepare' | 'send', body: Record<string, unknown>) => {
      const nonce = crypto.getRandomValues(new Uint8Array(16));
      const issuedAtMs = Date.now();
      const walletSignature = signWalletProof('evm', userKey, walletProofMessage({ signer: E2E_ENV.signer, appId: this.app.appId, sessionPublicKey: spk }, 'evm', account));
      const walletProof = { address: account, signature: walletSignature };
      const message = evmSponsorSessionMessage({ signer: E2E_ENV.signer, appId: this.app.appId, parentOrigin: PARTNER_ORIGIN }, { method: route, body, sessionPublicKey: spk, issuedAtMs, nonce, walletProof });
      const sessionProof = { sessionPublicKey: [...spk], issuedAtMs, nonce: [...nonce], signature: [...ed25519.sign(message, sessionKey)], walletProof: { address: account, signature: [...walletSignature] } };
      const req = new Request(`${API_URL}/v1/evm/sponsor/${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: VAULT_ORIGIN, 'x-hana-key': this.app.pk, 'x-hana-parent-origin': PARTNER_ORIGIN, 'cf-connecting-ip': '198.18.0.1' },
        body: JSON.stringify({ ...body, sessionProof }),
      });
      const res = await modules.worker.fetch(req, this.api.env, this.exec);
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const base = { chainId: EVM_CHAIN_ID, account, calls: [CHECK_IN_CALL] };
    const p = await call('prepare', base);
    if (p.status !== 200 || p.body.allowed !== true) return { status: p.status, code: String(p.body.code ?? p.body.reason ?? 'prepare_refused'), deadlineMs: 0 };
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 240);
    const input: ExecuteInput = { chainId: EVM_CHAIN_ID, account, implementation: String(p.body.implementation) as Hex, calls: [{ to: CHECK_IN_CALL.to as Hex, value: 0n, data: CHECK_IN_CALL.data as Hex }], nonce: BigInt(String(p.body.executeNonce ?? '0')), deadline, relayer: String(p.body.relayer) as Hex, minGas: BigInt(String(p.body.maxMinGas)) };
    const signature = signExecute(userKey, input, { enabledChains: [EVM_CHAIN_ID] });
    const a = p.body.delegation === 'none' ? signAuthorization(userKey, { chainId: EVM_CHAIN_ID, address: input.implementation, nonce: BigInt(String(p.body.accountNonce)) }, { enabledChains: [EVM_CHAIN_ID] }) : null;
    const s = await call('send', {
      ...base,
      executeNonce: input.nonce.toString(),
      deadline: deadline.toString(),
      relayer: input.relayer,
      minGas: input.minGas.toString(),
      signature,
      ...(a ? { authorization: { chainId: a.chainId, address: a.address, nonce: a.nonce.toString(), yParity: a.yParity, r: a.r, s: a.s } } : {}),
    });
    return { status: s.status, code: typeof s.body.code === 'string' ? s.body.code : typeof s.body.status === 'string' ? s.body.status : null, deadlineMs: Number(deadline) * 1000 };
  }

  /** The lane as the tests read it: the relayer, the chain, the clock. No key, raw transaction or signature. */
  async state(): Promise<Record<string, unknown>> {
    const s = await this.status();
    return {
      appId: this.app.appId,
      relayer: this.relayerAddress,
      nextSlot: s.nextNonce,
      halted: s.halted,
      waiting: s.unmined,
      records: s.records.map((r) => ({ slot: r.nonce, kind: r.digest ? 'action' : 'filler', onChain: r.seen !== null, taken: r.accepted, deadlineMs: r.deadline * 1000, copies: r.versions.map((v) => v.kind) })),
      staffLog: s.staffLog.map((e) => ({ seq: e.seq, tool: e.action, done: e.done, refused: e.refused, who: e.who, note: e.note, auto: e.auto === true })),
      chain: this.evm.view(),
      clockOffsetMs: laneClockOffset(),
      nowMs: Date.now(),
      ledgerConnections: ledger.wire.connections,
    };
  }

  /** Runs the relayer until `done` says so (at most `max` runs): a scenario's state, reached without waiting on a clock. */
  private async until(done: (s: RelayerStatus) => boolean, what: string, max = 4): Promise<void> {
    for (let i = 0; i < max; i += 1) {
      if (done(await this.status())) return;
      await this.relayer().alarm();
    }
    if (!done(await this.status())) throw new Error(`the relayer did not reach "${what}": ${JSON.stringify((await this.status()).halted)}`);
  }

  private async expectSent(r: Sent, ok: (r: Sent) => boolean, what: string): Promise<Sent> {
    if (!ok(r)) throw new Error(`the check-in for "${what}" was answered ${r.status} ${r.code}`);
    return r;
  }

  /** SCENARIOS: each starts from a fresh relayer (but `past-deadline`, `money-arrives`, `refill` and `out-of-money-again`, which continue the one before). */
  async scenario(name: string): Promise<void> {
    const halted = (reason: string) => (s: RelayerStatus) => s.halted?.reason === reason;
    switch (name) {
      // Nothing sent yet: "Ready".
      case 'ready':
        this.fresh();
        break;
      // One check-in sent and on the network: "Working · the next transaction gets slot 1".
      case 'working':
        this.fresh();
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 200 && r.code === 'executed', name);
        await this.run();
        break;
      // Working, but the wallet is below the low line (0.01 test ETH) and above one send's worst case: "Low on money".
      case 'low-money':
        await this.scenario('working');
        this.evm.balanceWei = 5_000_000_000_000_000n;
        sponsor.forgetRelayerBalances();
        await this.run();
        break;
      // One check-in sent, not yet on the network (the node holds it): a waiting transaction in slot 0.
      case 'waiting':
        this.fresh();
        this.evm.hold = true;
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 504, name);
        break;
      // The waiting check-in's time limit (4 minutes) passed: the lane's clock moves past it.
      case 'past-deadline': {
        const rec = (await this.status()).records.find((r) => r.seen === null);
        if (!rec) throw new Error('past-deadline: nothing is waiting (run the "waiting" scenario first)');
        const ahead = rec.deadline * 1000 - Date.now() + 1_000;
        if (ahead > 0) advanceLaneClock(ahead);
        adminStatus.resetStatusCache();
        break;
      }
      // The node refuses the relayer's check-in: its wallet is out of money (drained between the API's balance read
      // and the broadcast, as the anvil lane's 9c). Paused at once, relayer_cannot_send · insufficient_funds; the
      // wallet then shows almost nothing left.
      case 'out-of-money':
        this.fresh();
        this.evm.refuse = true;
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 503 && r.code === 'sponsorship_paused', name);
        this.evm.balanceWei = 100_000_000_000_000n;
        await this.until(halted('relayer_cannot_send'), name);
        await this.run();
        break;
      // The money is back (1 test ETH), and nothing has run yet: "Restarting by itself" (D890), or, when it can't
      // restart by itself, "has money again" with Resume. The status page's cache is left alone.
      case 'money-arrives':
        this.evm.refuse = false;
        this.evm.balanceWei = 10n ** 18n;
        sponsor.forgetRelayerBalances();
        break;
      // The money is back and time passes for the relayer: its stored cancel goes out and lands, and (D890) once the
      // pause is 60 s old (the lane's clock moves there) it restarts by itself, or stays paused for a person (below).
      case 'refill': {
        await this.scenario('money-arrives');
        const since = (await this.status()).halted?.since;
        if (since !== undefined && Date.now() - since < 61_000) advanceLaneClock(61_000 - (Date.now() - since));
        await this.run(2);
        break;
      }
      // Restarted by itself after a refill, and the very next check-in finds the wallet empty again: paused within
      // 30 minutes of the restart, so this pause waits for a person (D890); `refill` then ends with Resume needed.
      case 'out-of-money-again': {
        if ((await this.status()).halted) throw new Error('out-of-money-again: the relayer is paused (run "out-of-money" then "refill" first)');
        this.evm.refuse = true;
        sponsor.forgetRelayerStatus();
        sponsor.forgetRelayerBalances();
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 503 && r.code === 'sponsorship_paused', name);
        this.evm.balanceWei = 100_000_000_000_000n;
        await this.until(halted('relayer_cannot_send'), name);
        await this.run();
        break;
      }
      // Someone else used the relayer's key: a transaction it never sent took slot 0 while its check-in waited there.
      // Paused, nonce_consumed_elsewhere (the leak steps; the fix: Close slot 0, then Resume with the engineer's word).
      case 'key-used-elsewhere':
        this.fresh();
        this.evm.hold = true;
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 504, name);
        await this.evm.foreign(0);
        this.evm.hold = false;
        await this.until(halted('nonce_consumed_elsewhere'), name);
        await this.run();
        break;
      // Someone else used the key after the relayer's last transaction: the network counts one more than it sent.
      // Paused, foreign_transactions (the fix: Set the next slot number to the network's, then Resume).
      case 'foreign-transactions':
        this.fresh();
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 200 && r.code === 'executed', name);
        await this.evm.foreign(1);
        await this.until(halted('foreign_transactions'), name);
        await this.run();
        break;
      // A slot left empty: someone else's transaction with the key was pending at slot 0 when the relayer started
      // (so it took slot 1), then the node dropped it. Paused, nonce_gap at slot 0 after two runs (the fix: Fill a gap
      // at slot 0, then Resume).
      case 'gap': {
        this.fresh();
        this.evm.hold = true;
        const foreign = await this.evm.foreign(0, { pool: true });
        await this.expectSent(await this.sendCheckIn(), (r) => r.status === 504, name);
        this.evm.drop(foreign);
        this.evm.hold = false;
        await this.until(halted('nonce_gap'), name);
        await this.run();
        break;
      }
      default:
        throw new Error(`unknown scenario ${JSON.stringify(name)}: ${SCENARIOS.join(', ')}`);
    }
  }
}

export const SCENARIOS = ['ready', 'working', 'low-money', 'waiting', 'past-deadline', 'out-of-money', 'money-arrives', 'refill', 'out-of-money-again', 'key-used-elsewhere', 'foreign-transactions', 'gap'] as const;

installAccessCerts(data.access.certs);
const lane = new Lane();

// The lane's chain endpoints, in this thread's fetch (after the certs' interception, which stays in front).
{
  const before = globalThis.fetch;
  const near = lane.chain.handler();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith(LANE_NEAR)) return near(new Request(input, init), new AbortController().signal);
    if (url.startsWith(LANE_EVM) || url.startsWith(LANE_EVM_FALLBACK)) return lane.evm.handler()(new Request(input, init));
    return before(input, init);
  }) as typeof fetch;
}

// ---- one test at a time per lane ----

const LEASE_MS = 3 * 60_000;
let holder: { lease: string; timer: ReturnType<typeof setTimeout>; done: () => void } | null = null;
let queue: Promise<void> = Promise.resolve();

/** Waits until the lane is free, then holds it; the lease ends by release or after LEASE_MS of real time. */
function acquire(): Promise<string> {
  const before = queue;
  let done!: () => void;
  queue = new Promise<void>((r) => (done = r));
  return before.then(() => {
    const lease = crypto.randomUUID();
    const timer = setTimeout(() => release(lease), LEASE_MS);
    timer.unref();
    holder = { lease, timer, done };
    return lease;
  });
}

function release(lease: string): boolean {
  if (holder?.lease !== lease) return false;
  clearTimeout(holder.timer);
  const { done } = holder;
  holder = null;
  done();
  return true;
}

// ---- the edge: the Access stand-in and the controls ----

function cookieOf(request: Request): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=') || null;
  }
  return null;
}

const SIGN_IN_AS: Record<string, string> = { staff: E2E_STAFF, outsider: E2E_OUTSIDER };

async function control(request: Request, url: URL): Promise<Response> {
  if (url.pathname === '/__e2e/access/sign-in' && request.method === 'GET') {
    const who = SIGN_IN_AS[url.searchParams.get('as') ?? 'staff'];
    if (!who) return json(400, { error: 'as: staff or outsider' });
    const to = url.searchParams.get('to') ?? '/';
    const target = /^\/(?!\/)[^\s\\]*$/u.test(to) ? to : '/';
    // Issued at the real time and expiring 24 hours after the lane's (its clock may run ahead): the admin's check (the
    // lane's clock) and the issuer's (the real one) both take it.
    const token = signAccessJwt(data.access, { email: who, nowMs: realNow(), expFromMs: Date.now() });
    return new Response(null, { status: 302, headers: { location: target, 'set-cookie': `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax`, 'cache-control': 'no-store' } });
  }
  if (url.pathname === '/__e2e/access/sign-out' && request.method === 'GET') {
    return new Response('Signed out of the local stack’s Access stand-in.\n', { headers: { 'content-type': 'text/plain; charset=utf-8', 'set-cookie': `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, 'cache-control': 'no-store' } });
  }
  // Tests and the hand-test script only: no CORS, and a browser request (which always has an Origin on a POST) is refused.
  if (!url.pathname.startsWith('/__e2e/lane/') || request.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
  try {
    if (url.pathname === '/__e2e/lane/state' && request.method === 'GET') return json(200, await lane.state());
    if (request.method !== 'POST') return json(405, { error: 'method_not_allowed' });
    const b = ((await request.json().catch(() => ({}))) ?? {}) as { name?: unknown; advanceMs?: unknown; keepStatusCache?: unknown; times?: unknown; lease?: unknown };
    if (url.pathname === '/__e2e/lane/acquire') return json(200, { lease: await acquire() });
    if (url.pathname === '/__e2e/lane/release') return json(200, { released: typeof b.lease === 'string' && release(b.lease) });
    if (url.pathname === '/__e2e/lane/scenario' && typeof b.name === 'string') {
      await lane.scenario(b.name);
      return json(200, await lane.state());
    }
    if (url.pathname === '/__e2e/lane/clock' && typeof b.advanceMs === 'number') {
      advanceLaneClock(b.advanceMs);
      // `keepStatusCache`: the status page keeps its reading (D890's tile Check again is then what reads it fresh).
      if (b.keepStatusCache !== true) adminStatus.resetStatusCache();
      return json(200, await lane.state());
    }
    if (url.pathname === '/__e2e/lane/run') {
      await lane.run(typeof b.times === 'number' && b.times >= 1 && b.times <= 10 ? b.times : 1);
      return json(200, await lane.state());
    }
    return json(404, { error: 'not_found' });
  } catch (e) {
    return json(409, { error: e instanceof Error ? e.message : String(e) });
  }
}

async function edge(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname.startsWith('/__e2e/')) return control(request, url);
  // localhost and 127.0.0.1 are different origins: the Worker serves its one origin, so the edge points there.
  if (url.origin !== data.origin && url.hostname === 'localhost') return new Response(null, { status: 308, headers: { location: `${data.origin}${url.pathname}${url.search}` } });
  const headers = new Headers(request.headers);
  headers.delete('cf-access-jwt-assertion');
  headers.set('cf-connecting-ip', '127.0.0.1');
  const token = cookieOf(request);
  if (token) headers.set('cf-access-jwt-assertion', token);
  const init: RequestInit = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD') init.body = await request.arrayBuffer();
  return admin.default.fetch(new Request(request.url, init), lane.adminEnv);
}

// ---- the thread's messages ----

port.on('message', (m: { type: string; id: number; method?: string; url?: string; headers?: [string, string][]; body?: ArrayBuffer | null; ok?: boolean; value?: unknown; error?: string }) => {
  if (m.type === 'rpc') {
    const p = pendingRpc.get(m.id);
    pendingRpc.delete(m.id);
    if (p) m.ok ? p.resolve(m.value) : p.reject(new Error(m.error ?? 'rpc failed'));
    return;
  }
  if (m.type !== 'http') return;
  void (async () => {
    let res: Response;
    try {
      res = await edge(new Request(m.url!, { method: m.method, headers: m.headers, ...(m.body ? { body: m.body } : {}) }));
    } catch (e) {
      console.error(`[e2e] admin lane ${data.name}: ${m.method} ${m.url} failed:`, e instanceof Error ? e.message : e);
      res = new Response('Internal error\n', { status: 500 });
    }
    const body = await res.arrayBuffer();
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    // set-cookie headers are kept apart (Headers.forEach joins them).
    port.postMessage({ type: 'http', id: m.id, status: res.status, headers, setCookie: res.headers.getSetCookie(), body }, [body]);
  })();
});

port.postMessage({ type: 'ready' });
