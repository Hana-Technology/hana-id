// The vault (docs/batch-b-spec.md "Partner ↔ vault handshake", "Port methods", "Login", "Key persistence",
// "Signing and approval", "Auto-approve policies", "Key export"): a hidden iframe on vaultOrigin that holds the keys.
//
// - It runs only inside a frame and only with the inlined config (boot.ts checks both before constructing it).
// - It accepts exactly one hana:hello: from window.parent, from an origin the app allows (and equal to
//   location.ancestorOrigins[0] where the browser has it), with one MessagePort. It pins that origin and port and drops
//   every later hello and every other window message from the parent.
// - After the handshake it unlocks a persisted record (one API call, no chain call), replies `ready`, then fetches
//   GET /v1/app in the background (never on the unlock path).
// - Requests arrive on the port only. Signatures need a guarded Approve in a Hana popup, or a match against an
//   auto-approve policy the user accepted. Key material never crosses postMessage or the BroadcastChannel.
// - The inlined policy is re-checked against GET /v1/app while the vault stays open (every POLICY_REFRESH_MS, and
//   before an auto-sign when the last check is older than POLICY_FRESH_MS): a policy removed or changed since the page
//   loaded no longer auto-signs anything, and the request goes to the approval popup. Raw signing is re-checked the
//   same way before every raw request: once GET /v1/app says 'off', raw requests are refused until a reload.
// - A pk_test_ app never signs for a mainnet (docs/decisions.md D39): the request is refused before any popup or
//   policy.
// - PRK is zeroed after the app's idle limit (`idleTtlMs`) without a request that uses the key (a signature, an
//   export, revoke-other-devices, an auto-approve consent request), not only at the session's end. Status, address and
//   auto-approve-status reads don't count, so polling them can't keep the key in memory. In 'session' mode the session
//   stays dormant (addresses known, no key; those reads keep answering) and the next request that uses the key unlocks
//   the record again, which works while the server share is alive; in 'none' mode it ends.
// - One session per app per device: a login replaces the record and revokes the shares it replaces, a logout ends
//   every tab's session, and a `revoked` broadcast ends only the tabs holding that share.
import {
  type AppConfig,
  ErrorCode,
  type Jwk,
  isTestPublishableKey,
  type LoginResult,
  NEVER_AUTO_APPROVED_KINDS,
  type PortEventMap,
  type PortEventName,
  type PortRequest,
  type PortResultMap,
  type StatusResult,
  ApiError,
  type Bytes,
  badCounterExpected,
  bytesEqual,
  ckdKeyHash,
  createShareId,
  fetchGoogleJwks,
  isSignMethod,
  parsePortRequest,
  parseVaultBroadcast,
  parseWindowMessage,
  signVaultMessage,
  unsupportedMethodId,
  vaultPayload,
} from '@hana-id/core';
import { deriveAddresses } from '@hana-id/core/derivation';
import { type AutoApproveResult, matchAutoApprovePolicy, recordAutoApproveUse } from '@hana-id/core/policy';
import type { HanaEnv } from '../hana-env.ts';
import { VaultApi } from './api.ts';
import { type ApprovalOutcome, Approvals } from './approvals.ts';
import { autoApproveStatus, consentActive, consentEnd, newConsent, withUsage } from './auto-approve.ts';
import { type Persistence, type PolicyInForce, type RawSign, type VaultConfig, parentAllowed, policyInForce } from './config.ts';
import { VaultError, apiErrorToVault, disconnected, notLoggedIn, toProtocolError, userRejected } from './errors.ts';
import { Launcher, type LauncherHandle, type LauncherView } from './launcher.ts';
import { type LoginMode, type LoginStage, type LoginSuccess, PendingLogin, serverDetail } from './login.ts';
import { NearView } from './near.ts';
import {
  type ConsentV1,
  DERIVATION_VERSION,
  type RecordStore,
  type RecordV1,
  openConsent,
  openPrk,
  parseRecord,
  recordKey,
  sameSession,
  sealConsent,
  sealPrk,
} from './record.ts';
import { type Channel, Clock, type Locks, type Timers, type WindowMessageEvent, type WindowRef, randomHex128, realTimers } from './runtime.ts';
import { type SignRequest, approvalSubject, signRequest } from './signing.ts';

/** performance.now where there is one (browsers, workers), else Date.now. */
const defaultPerfNow = (): number => (typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now());

/** The /v1/vault/shares phases (apps/api vault/endpoints.ts `lap`) behind each shareServer* detail. */
const SHARE_SERVER_GROUPS = { Gate: ['app', 'limits'], Session: ['session'] } as const;
/** The /v1/vault/unlock phases behind each unlockServer* detail. */
const UNLOCK_SERVER_GROUPS = { Gate: ['app', 'limits'], Share: ['shareLimit', 'share'], Advance: ['advance'] } as const;

/** Consecutive stages from `start` (pk_test_ timings): `mark(name)` adds the time since the previous mark to `name`. */
class Laps {
  readonly timings: Record<string, number> = {};
  /** Breakdowns of a stage (not added to the total). */
  readonly detail: Record<string, number> = {};
  private last: number;

  constructor(
    private readonly now: () => number,
    start: number,
  ) {
    this.last = start;
  }

  mark(name: string): void {
    const t = this.now();
    this.timings[name] = (this.timings[name] ?? 0) + Math.max(0, t - this.last);
    this.last = t;
  }

  has(name: string): boolean {
    return name in this.timings;
  }

  /** The time of the last mark. */
  get at(): number {
    return this.last;
  }
}

/** The vault's surroundings (boot.ts wires the browser's). */
export interface VaultHost {
  /** window.parent. */
  readonly parent: unknown;
  /** location.ancestorOrigins[0] where the browser provides it (Chromium, WebKit), else undefined. */
  ancestorOrigin(): string | undefined;
  /** Subscribes to the vault window's `message` events. */
  onMessage(listener: (e: WindowMessageEvent) => void): void;
  /** window.open from the vault's browsing context (inside a launcher click). */
  open(url: string, name: string, features: string): WindowRef | null;
  /** This document's navigation timing (ms since its navigation start), when the browser has it. */
  navigationTiming?(): NavigationMarks | null;
}

/** What the vault reads from its own PerformanceNavigationTiming: all on the vault document's clock. */
export interface NavigationMarks {
  responseEnd: number;
  /** 0 until the load event has run. */
  loadEventEnd: number;
}

/** entry.ts's mark on the vault document's clock (performance.now): when the bundle started running. */
export interface BootMarks {
  scriptStart: number;
}

export interface VaultOptions {
  env: HanaEnv;
  config: VaultConfig;
  host: VaultHost;
  /** Opens the record store; throwing means storage is unavailable ('none' and `storage_unavailable`). */
  openStore(): Promise<RecordStore>;
  locks: Locks;
  channel(name: string): Channel | null;
  launcherView: LauncherView;
  fetch?: typeof fetch;
  timers?: Timers;
  deviceNow?: () => number;
  /** Monotonic ms for pk_test_ timings; defaults to performance.now. */
  perfNow?: () => number;
  /** boot.ts's marks, for the unlock timings' `vault*` stages (pk_test_ apps). */
  boot?: BootMarks;
  /** Google's key for a kid; defaults to fetching and caching Google's JWKS. */
  jwks?: (kid: string) => Promise<Jwk | null>;
  /** The split login fallback (until the ship gate decides). Default 'combined'. */
  loginFlow?: 'combined' | 'split';
}

interface Share {
  shareId: Uint8Array;
  /** The last counter this tab knows (the record's is authoritative while it is this session's). */
  counter: number;
  /** Server-corrected time the share was made by a fresh login in this tab, or null (unlocked from a record). */
  createdAt: number | null;
}

interface Session {
  prk: Bytes;
  addresses: { stellar: string; evm: string };
  expiresAtMs: number;
  path: string;
  sessionPk: Uint8Array;
  keyPair: CryptoKeyPair;
  persistence: Persistence;
  share: Share | null;
  /**
   * 'none' mode: the consent lives here. 'session' mode: the record holds it (sealed under PRK); this is the last one
   * this tab read or wrote, kept so hana_autoApproveStatus can answer while the session is dormant.
   */
  consent: ConsentV1 | null;
  lastTouchAt: number;
  /** Server-corrected time of the partner page's last request for this session (the in-memory idle limit). */
  lastActivityAt: number;
  expiryTimer: unknown;
  idleTimer: unknown;
}

/** A 'session'-mode session whose PRK was zeroed for idleness: the record can unlock it again (same share only). */
interface Dormant {
  addresses: { stellar: string; evm: string };
  expiresAtMs: number;
  sessionPk: Uint8Array;
  shareId: Uint8Array;
  /** The consent this tab last read or wrote (not secret: policy id, end time, counters), for hana_autoApproveStatus. */
  consent: ConsentV1 | null;
  /** Ends it at expiresAtMs, as a live session's expiry timer would. */
  expiryTimer: unknown;
}

interface ExportJob {
  chain: 'stellar' | 'evm';
  address: string;
  window: WindowRef | null;
  contextSent: boolean;
  intent: LauncherHandle | null;
  timer: unknown;
  poll: unknown;
  resolve(): void;
  reject(e: VaultError): void;
}

/** A touch slides the server idle limit at most this often, and only after an approved signature. */
export const TOUCH_EVERY_MS = 10 * 60_000;
/** revoke-all needs a share made by a fresh login this recently (R12). */
export const FRESH_LOGIN_MS = 5 * 60_000;
/** An export must start (launcher click) within this long; the export window counts as running up to EXPORT_MAX_MS. */
export const EXPORT_START_MS = 5 * 60_000;
export const EXPORT_MAX_MS = 15 * 60_000;
/** "Signed by Hana under {label}" shows this long. */
export const AUTO_APPROVED_FLASH_MS = 3_000;
/** While logged in with a policy in force, GET /v1/app is re-read this often (keeps hana_autoApproveStatus current). */
export const POLICY_REFRESH_MS = 60_000;
/**
 * An auto-sign needs the policy confirmed by GET /v1/app this recently, else it re-reads it first (or, if that fails,
 * asks). This bounds how long a removed policy can still auto-sign in an open tab; a burst of requests within it shares
 * one read, so GET /v1/app stays far below its per-IP limit.
 */
export const POLICY_FRESH_MS = 10_000;
const SEEN_IDS_MAX = 4096;
const JWKS_REFETCH_MS = 60_000;
export const LOGIN_FEATURES = 'popup,width=480,height=640';

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export class Vault {
  private readonly env: HanaEnv;
  private readonly config: VaultConfig;
  private readonly host: VaultHost;
  private readonly timers: Timers;
  private readonly deviceNow: () => number;
  private readonly perfNow: () => number;
  /** When the constructor finished (perfNow): the end of the `vaultConfig` stage. */
  private readonly constructedAt: number;
  /** When the hello was taken (perfNow): the start of the unlock stages after the handshake. */
  private helloAt = 0;
  private readonly clock: Clock;
  /** The inlined policy while GET /v1/app still serves it; null once removed or changed (until a reload). */
  private policy: PolicyInForce | null;
  /** Server-corrected time of the last GET /v1/app (or page render) that confirmed `policy`. */
  private policyCheckedAt: number;
  private policyCheck: Promise<void> | null = null;
  private policyTimer: unknown = null;
  /** The raw-signing setting in force: the inlined one until GET /v1/app says 'off' (then 'off' until a reload). */
  private rawSign: RawSign;
  /** Server-corrected time of the last GET /v1/app (or page render) that confirmed `rawSign`. */
  private rawSignCheckedAt: number;
  private readonly testApp: boolean;
  private readonly launcher: Launcher;
  private readonly lockName: string;
  private readonly recordId: string;
  private readonly bundleCkdKeyHash: Uint8Array;

  private parentOrigin: string | null = null;
  private port: MessagePort | null = null;
  private api: VaultApi | null = null;
  private near: NearView | null = null;
  private approvals: Approvals | null = null;
  private channel: Channel | null = null;
  private store: RecordStore | null = null;
  private storageBroken = false;
  private started: Promise<void> | null = null;
  private session: Session | null = null;
  private dormant: Dormant | null = null;
  private waking: Promise<void> | null = null;
  private pending: PendingLogin | null = null;
  private continueIntent: LauncherHandle | null = null;
  private exportJob: ExportJob | null = null;
  private appConfigPromise: Promise<AppConfig> | null = null;
  private declinedPolicyId: string | null = null;
  private readonly seenIds = new Set<string>();
  private jwksCache: { keys: Jwk[]; at: number } | null = null;

  constructor(private readonly o: VaultOptions) {
    this.env = o.env;
    this.config = o.config;
    this.host = o.host;
    this.timers = o.timers ?? realTimers;
    this.deviceNow = o.deviceNow ?? (() => Date.now());
    this.perfNow = o.perfNow ?? defaultPerfNow;
    this.clock = new Clock(o.config.serverTimeMs, this.deviceNow);
    this.policy = policyInForce(o.config.settings);
    this.policyCheckedAt = o.config.serverTimeMs;
    this.rawSign = o.config.settings.rawSign;
    this.rawSignCheckedAt = o.config.serverTimeMs;
    this.testApp = isTestPublishableKey(o.config.publishableKey);
    this.launcher = new Launcher(o.launcherView, (ui) => this.emit('ui', ui), this.timers);
    this.lockName = `hana-vault-unlock:${o.config.appId}`;
    this.recordId = recordKey(o.env.signer, o.config.appId, o.config.scopeId, 0);
    this.bundleCkdKeyHash = ckdKeyHash(o.env.ckdNetworkKey);
    o.host.onMessage((e) => this.onWindowMessage(e));
    this.constructedAt = this.perfNow();
  }

  /** The server-corrected time (tests). */
  now(): number {
    return this.clock.now();
  }

  // ---- handshake ----

  private onWindowMessage(e: WindowMessageEvent): void {
    if (this.parentOrigin === null) {
      this.tryHello(e);
      return;
    }
    // After the handshake the parent talks only on its port.
    if (e.source === this.host.parent) return;
    const t = isObj(e.data) ? e.data.t : undefined;
    if (t === 'hana:auth-hello') {
      if (this.pending && parseWindowMessage(e.data, ['hana:auth-hello'])) this.pending.acceptHello(e);
      return;
    }
    if (t === 'hana:export-hello') {
      if (parseWindowMessage(e.data, ['hana:export-hello'])) this.onExportHello(e);
      return;
    }
    this.approvals?.handleMessage(e);
  }

  private tryHello(e: WindowMessageEvent): void {
    if (!parseWindowMessage(e.data, ['hana:hello'])) return;
    if (e.source !== this.host.parent || e.ports.length !== 1) return;
    if (!parentAllowed(this.config, e.origin, this.env.devEnv)) return;
    const ancestor = this.host.ancestorOrigin();
    if (ancestor !== undefined && ancestor !== e.origin) return;
    const port = e.ports[0]!;
    this.helloAt = this.perfNow();
    this.parentOrigin = e.origin;
    this.port = port;
    const fetchFn = this.o.fetch;
    this.api = new VaultApi({
      apiUrl: this.env.apiUrl,
      publishableKey: this.config.publishableKey,
      parentOrigin: e.origin,
      ...(fetchFn ? { fetch: fetchFn } : {}),
      onServerTime: (t) => this.clock.refresh(t),
    });
    this.near = new NearView({ rpc: this.env.rpc, rpcFallback: this.env.rpcFallback }, this.env.signer, this.env.relayer, fetchFn);
    this.approvals = new Approvals({
      authOrigin: this.env.authOrigin,
      appName: this.config.appName,
      parentOrigin: e.origin,
      open: (url, name, features) => this.host.open(url, name, features),
      launcher: this.launcher,
      timers: this.timers,
      now: this.deviceNow,
      testApp: this.testApp,
      onStop: () => void this.revokeAutoApprove(),
    });
    port.onmessage = (m) => void this.onPortMessage(m.data);
    this.started = this.start();
  }

  private async start(): Promise<void> {
    const t = new Laps(this.perfNow, this.helloAt);
    // The per-app channel first: an unlock broadcasts its counter (or a revocation) on it.
    this.channel = this.o.channel(`hana-vault:${this.config.appId}`);
    this.channel?.onMessage((d) => this.onBroadcast(d));
    let warning: 'storage_unavailable' | undefined;
    if (this.config.settings.persistence === 'session') {
      try {
        this.store = await this.o.openStore();
      } catch {
        this.storageBroken = true;
        warning = 'storage_unavailable';
      }
    }
    t.mark('store');
    try {
      await this.unlock(undefined, t);
    } catch {
      // An unlock that fails for any unexpected reason leaves the vault logged out.
    }
    if (this.storageBroken) warning = 'storage_unavailable';
    const status = this.statusResult();
    // An unlock that got as far as PRK ends with the addresses; any other path ends where the record was read.
    t.mark(t.has('unwrap') ? 'addresses' : 'record');
    const timings = this.testApp ? { ...this.bootTimings(), ...t.timings, ...t.detail, vault: t.at - this.helloAt } : null;
    this.emit('ready', { ...status, ...(warning ? { warning } : {}), ...(timings ? { timings } : {}) });
    // The Google client (read from chain by the API) and the policy in force, in the background: never on the unlock
    // path.
    void this.appConfig().catch(() => undefined);
    this.schedulePolicyRefresh();
  }

  /**
   * The vault document's own load, as unlock stages (pk_test_ apps): `vaultFetch` (navigation start → the vault page's
   * last byte), `vaultScript` (→ vault.js running), `vaultConfig` (→ config read and the vault constructed),
   * `vaultLoad` (→ the load event done, which is when the partner sends its hello). All on this document's clock.
   */
  private bootTimings(): Record<string, number> {
    const nav = this.o.host.navigationTiming?.() ?? null;
    const boot = this.o.boot;
    if (!nav || !boot) return {};
    const loadEnd = nav.loadEventEnd > 0 ? nav.loadEventEnd : this.helloAt;
    return {
      vaultFetch: Math.max(0, nav.responseEnd),
      vaultScript: Math.max(0, boot.scriptStart - nav.responseEnd),
      vaultConfig: Math.max(0, this.constructedAt - boot.scriptStart),
      vaultLoad: Math.max(0, loadEnd - this.constructedAt),
    };
  }

  /** The persistence in force: the app's, unless storage is unavailable. */
  private get persistence(): Persistence {
    return this.config.settings.persistence === 'session' && !this.storageBroken ? 'session' : 'none';
  }

  private statusResult(): StatusResult {
    const s = this.live();
    if (s) return { status: 'logged_in', addresses: { ...s.addresses }, expiresAtMs: s.expiresAtMs, persistence: s.persistence };
    const d = this.liveDormant();
    if (d) return { status: 'logged_in', addresses: { ...d.addresses }, expiresAtMs: d.expiresAtMs, persistence: 'session' };
    return { status: 'logged_out', persistence: this.persistence };
  }

  /** The addresses of the session, live or dormant, or null. */
  private addresses(): { stellar: string; evm: string } | null {
    return this.live()?.addresses ?? this.liveDormant()?.addresses ?? null;
  }

  /** GET /v1/app, cached on success. Every fresh answer also re-checks the policy and raw signing in force. */
  private appConfig(): Promise<AppConfig> {
    if (!this.appConfigPromise) {
      const at = this.clock.now();
      const p = this.api!.app().then((app) => {
        this.applyServedPolicy(app, at);
        this.applyServedRawSign(app, at);
        return app;
      });
      this.appConfigPromise = p;
      p.catch(() => {
        if (this.appConfigPromise === p) this.appConfigPromise = null;
      });
    }
    return this.appConfigPromise;
  }

  // ---- the policy in force ----

  /**
   * Keeps the inlined policy only while GET /v1/app (asked at `at`) serves the same policyId. A removal or a change
   * drops it until a reload: the new policy, if any, then needs its own consent.
   */
  private applyServedPolicy(app: AppConfig, at: number): void {
    const current = this.policy;
    if (!current) return;
    const served = app.autoApprovePolicy ? policyInForce({ ...this.config.settings, autoApprovePolicy: app.autoApprovePolicy }) : null;
    if (served?.policyId === current.policyId) {
      this.policyCheckedAt = Math.max(this.policyCheckedAt, at);
      return;
    }
    this.policy = null;
    this.timers.clearTimeout(this.policyTimer);
    this.policyTimer = null;
  }

  /** Raw signing stays on only while GET /v1/app (asked at `at`) serves 'approval'; a missing value counts as 'off'. */
  private applyServedRawSign(app: AppConfig, at: number): void {
    if (this.rawSign !== 'approval') return;
    if (app.rawSign === 'approval') this.rawSignCheckedAt = Math.max(this.rawSignCheckedAt, at);
    else this.rawSign = 'off';
  }

  /**
   * The raw-signing setting a raw request may use: 'approval' only when GET /v1/app confirmed it within POLICY_FRESH_MS
   * (re-read first when older). A re-read that fails refuses the request (raw signing fails closed).
   */
  private async freshRawSign(): Promise<RawSign> {
    if (this.rawSign !== 'approval') return 'off';
    if (this.clock.now() - this.rawSignCheckedAt >= POLICY_FRESH_MS) await this.refreshPolicy().catch(() => undefined);
    if (this.rawSign !== 'approval') return 'off';
    if (this.clock.now() - this.rawSignCheckedAt >= POLICY_FRESH_MS) {
      throw new VaultError('api_unavailable', 'Could not confirm that raw signing is on for this app', { reason: 'raw_sign_unconfirmed' });
    }
    return 'approval';
  }

  /** A fresh GET /v1/app (one at a time). */
  private refreshPolicy(): Promise<void> {
    this.policyCheck ??= (async () => {
      try {
        this.appConfigPromise = null;
        await this.appConfig();
      } finally {
        this.policyCheck = null;
      }
    })();
    return this.policyCheck;
  }

  /** The background re-check, while a policy is in force (it only fetches while logged in). */
  private schedulePolicyRefresh(): void {
    if (!this.policy || this.policyTimer !== null) return;
    this.policyTimer = this.timers.setTimeout(() => {
      this.policyTimer = null;
      const check = this.session ? this.refreshPolicy().catch(() => undefined) : Promise.resolve();
      void check.then(() => this.schedulePolicyRefresh());
    }, POLICY_REFRESH_MS);
  }

  /**
   * The policy an auto-sign may use: one GET /v1/app confirmed within POLICY_FRESH_MS (re-read first when older), or
   * null, and the request then goes to the approval popup. A failed re-read also gives null for this request.
   */
  private async freshPolicy(): Promise<PolicyInForce | null> {
    if (this.policy && this.clock.now() - this.policyCheckedAt >= POLICY_FRESH_MS) await this.refreshPolicy().catch(() => undefined);
    const policy = this.policy;
    return policy && this.clock.now() - this.policyCheckedAt < POLICY_FRESH_MS ? policy : null;
  }

  private async jwks(kid: string): Promise<Jwk | null> {
    if (this.o.jwks) return this.o.jwks(kid);
    const fresh = this.jwksCache && this.deviceNow() - this.jwksCache.at < JWKS_REFETCH_MS;
    const cached = this.jwksCache?.keys.find((k) => k.kid === kid);
    if (cached) return cached;
    if (fresh) return null;
    const fetchFn = this.o.fetch;
    const keys = await fetchGoogleJwks(fetchFn ? (...a) => fetchFn(...a) : undefined);
    this.jwksCache = { keys, at: this.deviceNow() };
    return keys.find((k) => k.kid === kid) ?? null;
  }

  // ---- port ----

  private emit<E extends PortEventName>(event: E, data: PortEventMap[E]): void {
    this.port?.postMessage({ v: 1, event, data });
  }

  private reply(id: string, result: unknown): void {
    this.port?.postMessage({ v: 1, id, result });
  }

  private replyError(id: string, e: unknown): void {
    this.port?.postMessage({ v: 1, id, error: toProtocolError(e) });
  }

  private async onPortMessage(data: unknown): Promise<void> {
    const request = parsePortRequest(data);
    if (!request) {
      const id = unsupportedMethodId(data);
      if (id !== null && this.claimId(id)) this.replyError(id, new VaultError(ErrorCode.unsupportedMethod, 'Unsupported method'));
      return;
    }
    if (!this.claimId(request.id)) return;
    await this.started;
    try {
      this.reply(request.id, await this.dispatch(request));
    } catch (e) {
      this.replyError(request.id, e);
    }
  }

  /** Ids are unique per port: a repeated id is dropped. */
  private claimId(id: string): boolean {
    if (this.seenIds.has(id)) return false;
    if (this.seenIds.size >= SEEN_IDS_MAX) this.seenIds.delete(this.seenIds.values().next().value as string);
    this.seenIds.add(id);
    return true;
  }

  /** Requests that read or use the session: each one counts as activity for the in-memory idle limit. */
  /**
   * Requests that use the key, besides the sign methods: only these count as activity for the in-memory idle limit, and
   * a dormant session is unlocked before them. Reads (hana_status, eth_accounts, stellar_getAddress,
   * hana_autoApproveStatus) neither keep PRK in memory nor wake a dormant session: polling them can't hold the key.
   */
  private static readonly KEY_METHODS: ReadonlySet<string> = new Set(['hana_export', 'hana_revokeOtherDevices', 'hana_requestAutoApprove']);

  private async dispatch(r: PortRequest): Promise<unknown> {
    const usesKey = isSignMethod(r.method) || Vault.KEY_METHODS.has(r.method);
    if (usesKey) {
      this.noteActivity();
      await this.wake();
    }
    const sign = isSignMethod(r.method);
    if (sign) return this.sign(r as SignRequest);
    switch (r.method) {
      case 'hana_status':
        return this.statusResult();
      case 'hana_login':
        return this.login(r.params?.popupBlocked === true);
      case 'hana_cancelLogin':
        this.pending?.abort(this.pending.popupBlocked ? new VaultError('popup_blocked', 'The sign-in window was blocked') : new VaultError('login_cancelled', 'The sign-in was cancelled'));
        return null;
      case 'hana_logout':
        await this.logout();
        return null;
      case 'hana_export':
        return this.startExport(r.params.chain);
      case 'hana_revokeOtherDevices':
        return this.revokeOtherDevices();
      case 'stellar_getAddress': {
        const a = this.addresses();
        if (!a) throw notLoggedIn();
        return { address: a.stellar } satisfies PortResultMap['stellar_getAddress'];
      }
      case 'eth_accounts': {
        const a = this.addresses();
        return a ? [a.evm] : [];
      }
      case 'hana_requestAutoApprove':
        return this.requestAutoApprove();
      case 'hana_autoApproveStatus':
        return this.autoApproveStatusResult();
      case 'hana_revokeAutoApprove':
        await this.revokeAutoApprove();
        return null;
      default:
        throw new VaultError(ErrorCode.unsupportedMethod, 'Unsupported method');
    }
  }

  // ---- login ----

  private newPending(mode: LoginMode, popupBlocked: boolean): PendingLogin {
    this.pending?.abort(new VaultError('login_cancelled', 'A newer sign-in replaced this one'));
    this.continueIntent?.remove();
    this.continueIntent = null;
    const pending = new PendingLogin(
      {
        env: this.env,
        config: this.config,
        parentOrigin: this.parentOrigin!,
        persistence: this.persistence,
        api: this.api!,
        near: this.near!,
        clock: this.clock,
        timers: this.timers,
        jwks: (kid) => this.jwks(kid),
        appConfig: () => this.appConfig(),
        parentWindow: this.host.parent,
        progress: (stage: LoginStage) => {
          if (this.pending === pending) this.emit('loginProgress', { stage });
        },
        flow: this.o.loginFlow ?? 'combined',
        perfNow: this.perfNow,
      },
      mode,
      popupBlocked,
    );
    this.pending = pending;
    return pending;
  }

  /** Opens `/login?from=vault` inside a launcher click and hands the window to the pending login. */
  private openLoginPopup(pending: PendingLogin): boolean {
    if (pending.aborted) return true;
    const popup = this.host.open(`${this.env.authOrigin}/login?from=vault`, `hana-login-${randomHex128()}`, LOGIN_FEATURES);
    if (!popup) return false;
    pending.popup = popup;
    return true;
  }

  private async login(popupBlocked: boolean): Promise<LoginResult> {
    const pending = this.newPending(popupBlocked ? 'vault' : 'partner', popupBlocked);
    let intent: LauncherHandle | null = null;
    if (popupBlocked) {
      intent = this.launcher.push('Sign in with Hana', () => {
        if (this.openLoginPopup(pending)) {
          intent?.remove();
          intent = null;
        }
      });
    }
    try {
      return await this.finishLogin(pending);
    } catch (e) {
      if (e instanceof VaultError && e.code === 'session_consumed') this.offerContinue();
      throw e;
    } finally {
      intent?.remove();
      if (this.pending === pending) this.pending = null;
    }
  }

  /** session_consumed: a "Continue signing in" launcher, whose click starts a fresh login in vault mode. */
  private offerContinue(): void {
    this.continueIntent?.remove();
    const intent = this.launcher.push('Continue signing in', () => {
      const pending = this.newPending('vault', false);
      if (!this.openLoginPopup(pending)) {
        pending.abort(new VaultError('login_cancelled', 'The sign-in window was blocked'));
        if (this.pending === pending) this.pending = null;
        this.offerContinue();
        return;
      }
      void this.finishLogin(pending)
        .catch((e: unknown) => {
          if (e instanceof VaultError && e.code === 'session_consumed') this.offerContinue();
        })
        .finally(() => {
          if (this.pending === pending) this.pending = null;
        });
    });
    this.continueIntent = intent;
  }

  /** Waits for the pending login, then persists it and switches the vault to the new session. */
  private async finishLogin(pending: PendingLogin): Promise<LoginResult> {
    const success = await pending.done;
    if (pending.aborted) {
      success.prk.fill(0);
      throw new VaultError('login_cancelled', 'A newer sign-in replaced this one');
    }
    let persistence = this.persistence;
    // The app keeps the wallet across reloads but this browser's storage can't: say so with the result too.
    let warning: 'storage_unavailable' | undefined = this.storageBroken ? 'storage_unavailable' : undefined;
    let share: Share | null = null;
    let replaced: RecordV1 | null = null;
    const timings = success.timings;
    // From the end of `decrypt`, so the vault's stages add up to its `vault` total.
    const persistStarted = success.markedAt;
    if (persistence === 'session') {
      try {
        ({ share, replaced } = await this.persistLogin(success, timings));
      } catch {
        persistence = 'none';
        warning = 'storage_unavailable';
      }
    }
    const finishStarted = this.perfNow();
    timings.persist = finishStarted - persistStarted;
    if (pending.aborted) {
      // Superseded while persisting: the share and record of this login must not outlive it.
      if (share) void this.dropPersistedLogin(success, share, replaced);
      success.prk.fill(0);
      throw new VaultError('login_cancelled', 'A newer sign-in replaced this one');
    }
    const previous = this.session;
    // A new login replaces the app's session on this device: this tab's previous share and the share of the record it
    // overwrote (another tab's login) are revoked, and the tabs still holding them are told to drop them.
    if (previous) this.endSession(false);
    const old: { keyPair: CryptoKeyPair; share: Share }[] = [];
    if (previous?.share) old.push({ keyPair: previous.keyPair, share: { ...previous.share } });
    if (replaced) {
      const same = old.find((o) => bytesEqual(o.share.shareId, replaced.shareId));
      if (same) same.share.counter = Math.max(same.share.counter, replaced.counter);
      else old.push({ keyPair: replaced.sessionKeyPair, share: { shareId: replaced.shareId, counter: replaced.counter, createdAt: null } });
    }
    for (const o of old) {
      if (share && bytesEqual(o.share.shareId, share.shareId)) continue;
      this.broadcastRevoked(o.share.shareId);
      void this.revokeDetached(o).catch(() => undefined);
    }
    const s: Session = {
      prk: success.prk,
      addresses: { stellar: success.addresses.stellar, evm: success.addresses.evm },
      expiresAtMs: success.expiresAtMs,
      path: success.path,
      sessionPk: success.sessionKey.publicKey,
      keyPair: success.sessionKey.keyPair,
      persistence,
      share,
      consent: null,
      lastTouchAt: this.clock.now(),
      lastActivityAt: this.clock.now(),
      expiryTimer: null,
      idleTimer: null,
    };
    this.adopt(s);
    if (this.pending === pending) this.emit('loginProgress', { stage: 'done' });
    this.emit('accountsChanged', { addresses: { ...s.addresses } });
    const result: LoginResult = { addresses: { ...s.addresses }, expiresAtMs: s.expiresAtMs, persistence };
    if (warning) result.warning = warning;
    if (this.testApp) {
      const end = this.perfNow();
      result.timings = { ...timings, finish: end - finishStarted, vault: end - pending.startedAt };
    }
    return result;
  }

  /**
   * Share creation and the record (docs/batch-b-spec.md "Share creation"). Returns the share and the record it
   * overwrote, if that was another session's. Throws on any failure.
   */
  private async persistLogin(success: LoginSuccess, timings: Record<string, number>): Promise<{ share: Share; replaced: RecordV1 | null }> {
    const store = this.store;
    if (!store) throw new Error('No storage');
    const api = this.api!;
    const parentOrigin = this.parentOrigin!;
    const signature = await signVaultMessage(success.sessionKey.keyPair.privateKey, {
      signer: this.env.signer,
      appId: this.config.appId,
      shareId: createShareId(),
      counter: 0,
      payload: vaultPayload.createShare(parentOrigin),
    });
    const sent = this.perfNow();
    const created = await api.createShare(success.sessionKey.publicKey, signature);
    timings.shareRtt = this.perfNow() - sent;
    Object.assign(timings, serverDetail('share', created.timings, SHARE_SERVER_GROUPS));
    const ks = Uint8Array.from(created.ks);
    created.ks.fill(0);
    const shareId = Uint8Array.from(created.shareId);
    const binding = {
      signer: this.env.signer,
      appId: this.config.appId,
      path: success.path,
      sessionPk: success.sessionKey.publicKey,
      derivationVersion: DERIVATION_VERSION,
      ckdKeyHash: this.bundleCkdKeyHash,
      parentOrigin,
      expiresAtMs: success.expiresAtMs,
    };
    let sealed;
    try {
      sealed = await sealPrk(ks, success.prk, binding);
    } finally {
      ks.fill(0);
    }
    const record: RecordV1 = {
      v: 1,
      ...binding,
      scopeId: this.config.scopeId,
      keyIndex: 0,
      sessionKeyPair: success.sessionKey.keyPair,
      shareId,
      counter: 0,
      iv: sealed.iv,
      ct: sealed.ct,
      addresses: { stellar: success.addresses.stellar, evm: success.addresses.evm },
    };
    let replaced: RecordV1 | null = null;
    try {
      await this.o.locks.request(this.lockName, async () => {
        const read = await this.readRecord().catch(() => null);
        replaced = read && read !== 'invalid' ? read : null;
        await store.put(this.recordId, record);
      });
    } catch (e) {
      // The share is useless without the record: revoke it (best effort) before falling back to 'none'.
      void this.callShare(success.sessionKey.keyPair, shareId, 1, 'revoke').catch(() => undefined);
      throw e;
    }
    return { share: { shareId, counter: 0, createdAt: this.clock.now() }, replaced };
  }

  /**
   * A login superseded after it persisted: if its record is still the one stored, the record it overwrote is put back
   * (or the record deleted when there was none), and its share is revoked. Best effort.
   */
  private async dropPersistedLogin(success: LoginSuccess, share: Share, replaced: RecordV1 | null): Promise<void> {
    const store = this.store;
    if (store) {
      await this.o.locks
        .request(this.lockName, async () => {
          const r = await this.readRecord();
          if (r === 'invalid') await store.delete(this.recordId);
          else if (r && sameSession(r, { sessionPk: success.sessionKey.publicKey, shareId: share.shareId })) {
            if (replaced) await store.put(this.recordId, replaced);
            else await store.delete(this.recordId);
          }
        })
        .catch(() => undefined);
    }
    await this.revokeDetached({ keyPair: success.sessionKey.keyPair, share }).catch(() => undefined);
  }

  /** Revokes a share this tab no longer uses (best effort; one retry on 409 bad_counter). No record change. */
  private async revokeDetached(s: { keyPair: CryptoKeyPair; share: Share | null }): Promise<void> {
    const share = s.share;
    if (!share) return;
    try {
      await this.callShare(s.keyPair, share.shareId, share.counter + 1, 'revoke');
    } catch (e) {
      const expected = e instanceof ApiError ? badCounterExpected(e) : null;
      if (expected === null) throw e;
      await this.callShare(s.keyPair, share.shareId, expected, 'revoke');
    }
  }

  /**
   * The session, or null once it has passed expiresAtMs: it is then ended here, so a timer delayed by background-tab
   * throttling or device sleep never keeps PRK alive (or signing) after the session's end.
   */
  private live(): Session | null {
    const s = this.session;
    if (s && this.clock.now() >= s.expiresAtMs) {
      void this.expire(s);
      return null;
    }
    // The idle limit, for the same reason: a delayed idle timer never keeps PRK in memory past it.
    if (s && this.clock.now() - s.lastActivityAt >= this.config.settings.idleTtlMs) {
      this.goIdle(s);
      return null;
    }
    return s;
  }

  /** The dormant session, or null (ended here once past its absolute end). */
  private liveDormant(): Dormant | null {
    const d = this.dormant;
    if (d && this.clock.now() >= d.expiresAtMs) {
      this.expireDormant(d);
      return null;
    }
    return d;
  }

  /** A dormant session reached its absolute end: as expire() (record deleted if still its own, sessionExpired). */
  private expireDormant(d: Dormant): void {
    if (this.dormant !== d) return;
    this.clearDormant();
    void this.deleteRecordIf({ sessionPk: d.sessionPk, share: { shareId: d.shareId, counter: 0, createdAt: null } }).catch(() => undefined);
    this.emit('sessionExpired', null);
    this.emit('accountsChanged', { addresses: null });
  }

  private clearDormant(): void {
    if (this.dormant) this.timers.clearTimeout(this.dormant.expiryTimer);
    this.dormant = null;
  }

  /** A request that uses the key: restarts the in-memory idle limit. */
  private noteActivity(): void {
    const s = this.session;
    if (s && this.live() === s) s.lastActivityAt = this.clock.now();
  }

  /** Arms the idle check for `s` at its current deadline (re-armed on firing while there was activity since). */
  private scheduleIdle(s: Session): void {
    this.timers.clearTimeout(s.idleTimer);
    const delay = Math.max(0, s.lastActivityAt + this.config.settings.idleTtlMs - this.clock.now());
    s.idleTimer = this.timers.setTimeout(() => {
      s.idleTimer = null;
      if (this.session !== s) return;
      if (this.clock.now() - s.lastActivityAt >= this.config.settings.idleTtlMs) this.goIdle(s);
      else this.scheduleIdle(s);
    }, Math.min(delay, 0x7fffffff));
  }

  /**
   * The in-memory idle limit passed (docs/batch-b-spec.md Q28): PRK is zeroed. A 'session'-mode session with its record
   * goes dormant and the next request that needs the key unlocks it again; otherwise it ends as at expiry.
   */
  private goIdle(s: Session): void {
    if (this.session !== s) return;
    if (s.persistence !== 'session' || !s.share || !this.store) {
      void this.expire(s);
      return;
    }
    const dormant: Dormant = {
      addresses: { ...s.addresses },
      expiresAtMs: s.expiresAtMs,
      sessionPk: s.sessionPk,
      shareId: Uint8Array.from(s.share.shareId),
      consent: s.consent ? { ...s.consent, valueWeiByChain: { ...s.consent.valueWeiByChain } } : null,
      expiryTimer: null,
    };
    this.endSession(false);
    this.dormant = dormant;
    const delay = Math.max(0, s.expiresAtMs - this.clock.now());
    dormant.expiryTimer = this.timers.setTimeout(() => this.expireDormant(dormant), Math.min(delay, 0x7fffffff));
  }

  /**
   * Unlocks a dormant session (one signed API call, as on reload) before a request that needs the key. Only the same
   * share is unlocked: if the record is gone, belongs to another session or the API refuses (the server share passed
   * its idle or absolute limit, or was revoked), the session ends.
   */
  private async wake(): Promise<void> {
    if (this.session || !this.liveDormant()) return;
    this.waking ??= (async () => {
      const d = this.dormant!;
      try {
        await this.unlock(d.shareId);
      } catch {
        // As a failed unlock: the session ends below.
      }
      if (this.dormant === d) {
        this.clearDormant();
        this.emit('sessionExpired', null);
        this.emit('accountsChanged', { addresses: null });
      }
    })().finally(() => {
      this.waking = null;
    });
    await this.waking;
  }

  /** Drops a dormant session for good (logout, revocation); `announce` tells the partner page. */
  private dropDormant(announce: boolean): void {
    if (!this.dormant) return;
    this.clearDormant();
    if (announce) {
      this.emit('disconnect', { code: ErrorCode.disconnected });
      this.emit('accountsChanged', { addresses: null });
    }
  }

  /** Tells this app's other tabs that `shareId` is dead: the ones holding it end their session. */
  private broadcastRevoked(shareId: Uint8Array): void {
    this.channel?.postMessage({ v: 1, t: 'revoked', shareId: Uint8Array.from(shareId) });
  }

  private adopt(s: Session): void {
    this.session = s;
    this.clearDormant();
    const delay = Math.max(0, s.expiresAtMs - this.clock.now());
    s.expiryTimer = this.timers.setTimeout(() => void this.expire(s), Math.min(delay, 0x7fffffff));
    this.scheduleIdle(s);
  }

  /** Zeroes PRK and drops the session; pending approvals and an export end. */
  private endSession(announce: boolean, code: number = ErrorCode.disconnected): void {
    const s = this.session;
    if (!s) return;
    this.session = null;
    this.timers.clearTimeout(s.expiryTimer);
    this.timers.clearTimeout(s.idleTimer);
    s.prk.fill(0);
    this.approvals?.cancelAll('cancelled');
    this.cancelExport(disconnected());
    if (announce) {
      this.emit('disconnect', { code });
      this.emit('accountsChanged', { addresses: null });
    }
  }

  private async expire(s: Session): Promise<void> {
    if (this.session !== s) return;
    this.endSession(false);
    await this.deleteRecordIf(s).catch(() => undefined);
    this.emit('sessionExpired', null);
    this.emit('accountsChanged', { addresses: null });
  }

  // ---- record ----

  private async readRecord(): Promise<RecordV1 | null | 'invalid'> {
    const raw = await this.store!.get(this.recordId);
    if (raw === undefined || raw === null) return null;
    return parseRecord(raw) ?? 'invalid';
  }

  private async deleteRecord(): Promise<void> {
    await this.store?.delete(this.recordId);
  }

  /** Deletes the record if it is still `s`'s (not a newer login's from another tab). */
  private async deleteRecordIf(s: Pick<Session, 'sessionPk' | 'share'>): Promise<void> {
    const store = this.store;
    const share = s.share;
    if (!store || !share) return;
    await this.o.locks.request(this.lockName, async () => {
      const r = await this.readRecord();
      if (r === 'invalid' || (r && sameSession(r, { sessionPk: s.sessionPk, shareId: share.shareId }))) await store.delete(this.recordId);
    });
  }

  /** Checks that don't need the API (docs/batch-b-spec.md "Record", "Unlock" step 1). False means delete it. */
  private recordUsable(r: RecordV1): boolean {
    return (
      r.signer === this.env.signer &&
      r.appId === this.config.appId &&
      r.scopeId === this.config.scopeId &&
      r.keyIndex === 0 &&
      r.derivationVersion === DERIVATION_VERSION &&
      bytesEqual(r.ckdKeyHash, this.bundleCkdKeyHash) &&
      r.path.startsWith(`${this.config.scopeId}#google#`) &&
      this.clock.now() < r.expiresAtMs
    );
  }

  /**
   * Unlock (docs/batch-b-spec.md "Unlock"): one signed API call returns K_s; no chain call. `onlyShare` (waking a
   * dormant session) unlocks the record only if it still holds that share.
   */
  private async unlock(onlyShare?: Uint8Array, t?: Laps): Promise<void> {
    const store = this.store;
    if (!store) return;
    let read: RecordV1 | null | 'invalid';
    try {
      read = await this.readRecord();
    } catch {
      this.storageBroken = true;
      return;
    }
    if (read === null) return;
    if (read === 'invalid' || !this.recordUsable(read)) {
      await this.deleteRecord().catch(() => undefined);
      return;
    }
    const first: RecordV1 = read;
    if (onlyShare && !bytesEqual(first.shareId, onlyShare)) return;
    // Another parent origin on this top-level site: not this parent's record (left alone).
    if (first.parentOrigin !== this.parentOrigin || !parentAllowed(this.config, first.parentOrigin, this.env.devEnv)) return;

    const unlocked = await this.o.locks.request(this.lockName, async () => {
      const r = await this.readRecord();
      if (r === null || r === 'invalid' || !sameSession(r, first) || !this.recordUsable(r)) return null;
      t?.mark('record');
      let counter = r.counter + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const sent = this.perfNow();
          const res = await this.callShare(r.sessionKeyPair, r.shareId, counter, 'unlock');
          if (t) {
            // Signing (~0.1 ms) and the round trip of the attempt that answered, next to the API's own time for it.
            t.detail.unlockRtt = this.perfNow() - sent;
            Object.assign(t.detail, serverDetail('unlock', res.timings, UNLOCK_SERVER_GROUPS));
            t.mark('unlock');
          }
          const ks = Uint8Array.from(res.ks);
          res.ks.fill(0);
          r.counter = res.counter;
          // The counter is written before the lock is released.
          await store.put(this.recordId, r);
          t?.mark('counter');
          return { record: r, ks };
        } catch (e) {
          if (!(e instanceof ApiError)) return null;
          const expected = badCounterExpected(e);
          if (expected !== null && attempt === 0) {
            counter = expected;
            continue;
          }
          if (e.status === 404 || e.status === 410 || e.status === 401 || e.code === 'bad_counter') {
            await store.delete(this.recordId);
            if (e.status === 410) this.broadcastRevoked(r.shareId);
          }
          return null;
        }
      }
    });
    if (!unlocked) return;
    const { record, ks } = unlocked;
    let prk: Bytes;
    try {
      prk = await openPrk(ks, record);
    } catch {
      await this.deleteRecord().catch(() => undefined);
      return;
    } finally {
      ks.fill(0);
    }
    t?.mark('unwrap');
    let consentOk = true;
    try {
      const addresses = deriveAddresses(prk);
      if (addresses.stellar !== record.addresses.stellar || addresses.evm !== record.addresses.evm) consentOk = false;
      else await openConsent(prk, record);
    } catch {
      consentOk = false;
    }
    if (!consentOk) {
      prk.fill(0);
      await this.deleteRecord().catch(() => undefined);
      return;
    }
    this.adopt({
      prk,
      addresses: { ...record.addresses },
      expiresAtMs: record.expiresAtMs,
      path: record.path,
      sessionPk: record.sessionPk,
      keyPair: record.sessionKeyPair,
      persistence: 'session',
      share: { shareId: record.shareId, counter: record.counter, createdAt: null },
      consent: null,
      lastTouchAt: this.clock.now(),
      lastActivityAt: this.clock.now(),
      expiryTimer: null,
      idleTimer: null,
    });
    this.channel?.postMessage({ v: 1, t: 'counter', shareId: Uint8Array.from(record.shareId), counter: record.counter });
  }

  /** One signed share call with an explicit counter. */
  private callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'unlock'): Promise<{ ks: number[]; counter: number; timings?: unknown }>;
  private callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'touch' | 'revoke' | 'revoke-all'): Promise<unknown>;
  private async callShare(keyPair: CryptoKeyPair, shareId: Uint8Array, counter: number, action: 'unlock' | 'touch' | 'revoke' | 'revoke-all'): Promise<unknown> {
    const payload = action === 'unlock' ? vaultPayload.unlock() : action === 'touch' ? vaultPayload.touch() : action === 'revoke' ? vaultPayload.revoke() : vaultPayload.revokeAll();
    const signature = await signVaultMessage(keyPair.privateKey, { signer: this.env.signer, appId: this.config.appId, shareId, counter, payload });
    const body = { shareId: Array.from(shareId), counter, signature: Array.from(signature) };
    const api = this.api!;
    switch (action) {
      case 'unlock':
        return api.unlock(body);
      case 'touch':
        return api.touch(body);
      case 'revoke':
        return api.revoke(body);
      case 'revoke-all':
        return api.revokeAll(body);
    }
  }

  /**
   * A signed share action for the current session, under the per-app lock, with the counter re-read from the record
   * (`n + 1`; one retry with the API's `expected` on 409 bad_counter). The new counter is written and broadcast.
   */
  private async shareAction<T>(action: 'touch' | 'revoke' | 'revoke-all', after?: (r: RecordV1 | null) => Promise<void>): Promise<T> {
    const s = this.live();
    if (!s?.share) throw notLoggedIn();
    const share = s.share;
    return this.o.locks.request(this.lockName, async () => {
      const read = this.store ? await this.readRecord().catch(() => null) : null;
      const record = read && read !== 'invalid' && sameSession(read, { sessionPk: s.sessionPk, shareId: share.shareId }) ? read : null;
      let counter = Math.max(share.counter, record?.counter ?? 0) + 1;
      for (let attempt = 0; ; attempt++) {
        try {
          const result = (await this.callShare(s.keyPair, share.shareId, counter, action)) as T;
          share.counter = counter;
          if (record) {
            record.counter = counter;
            await this.store!.put(this.recordId, record);
          }
          await after?.(record);
          this.channel?.postMessage({ v: 1, t: 'counter', shareId: Uint8Array.from(share.shareId), counter });
          return result;
        } catch (e) {
          const expected = e instanceof ApiError ? badCounterExpected(e) : null;
          if (expected !== null && attempt === 0) {
            counter = expected;
            continue;
          }
          throw e;
        }
      }
    });
  }

  private onBroadcast(data: unknown): void {
    const m = parseVaultBroadcast(data);
    if (!m) return;
    const s = this.session;
    if (m.t === 'counter') {
      if (s?.share && bytesEqual(s.share.shareId, m.shareId)) s.share.counter = Math.max(s.share.counter, m.counter);
      return;
    }
    if (m.t === 'revoked') {
      // Only the tabs holding that share: a stale tab's 410 must not end a newer session in another tab.
      if (s?.share && bytesEqual(s.share.shareId, m.shareId)) this.endSession(true);
      if (this.dormant && bytesEqual(this.dormant.shareId, m.shareId)) this.dropDormant(true);
      return;
    }
    // logout: the user logged out of this app on this device.
    if (s) this.endSession(true);
    this.dropDormant(true);
  }

  // ---- logout and lost device ----

  /**
   * Logout (docs/batch-b-spec.md "Logout") is app-wide on this device. Under the per-app lock: this tab's share is
   * revoked, so is the record's when it belongs to another session (a newer login in another tab, with the record's own
   * session key), and the record is deleted. Then PRK is zeroed and `logout` is broadcast, so every tab of the app ends
   * its session. 404 and 410 mean already revoked; anything else (network) still ends the session here: a share left
   * live dies at its idle limit, and without the record its K_s opens nothing.
   */
  private async logout(): Promise<void> {
    const s = this.live();
    this.pending?.abort(new VaultError('login_cancelled', 'Logged out'));
    const store = this.store;
    const own = s?.share ? { keyPair: s.keyPair, sessionPk: s.sessionPk, share: s.share } : null;
    if (store || own) {
      await this.o.locks
        .request(this.lockName, async () => {
          const read = store ? await this.readRecord().catch(() => null) : null;
          const record = read && read !== 'invalid' ? read : null;
          const mine = own && record && sameSession(record, { sessionPk: own.sessionPk, shareId: own.share.shareId }) ? record : null;
          if (own) await this.revokeDetached({ keyPair: own.keyPair, share: { ...own.share, counter: Math.max(own.share.counter, mine?.counter ?? 0) } }).catch(() => undefined);
          if (record && !mine) {
            await this.revokeDetached({ keyPair: record.sessionKeyPair, share: { shareId: record.shareId, counter: record.counter, createdAt: null } }).catch(() => undefined);
          }
          await store?.delete(this.recordId).catch(() => undefined);
        })
        .catch(() => undefined);
    }
    if (s && this.session === s) this.endSession(false);
    const wasDormant = this.dormant !== null;
    this.dropDormant(false);
    this.channel?.postMessage({ v: 1, t: 'logout' });
    if (s || wasDormant) this.emit('accountsChanged', { addresses: null });
  }

  private async revokeOtherDevices(): Promise<PortResultMap['hana_revokeOtherDevices']> {
    const s = this.live();
    if (!s) throw notLoggedIn();
    const share = s.share;
    if (!share) throw new VaultError(ErrorCode.unauthorized, 'This app does not keep the wallet across reloads', { reason: 'persistence_off' });
    if (share.createdAt === null || this.clock.now() - share.createdAt >= FRESH_LOGIN_MS) {
      throw new VaultError(ErrorCode.unauthorized, 'Only within 5 minutes of a fresh sign-in', { reason: 'share_not_fresh' });
    }
    try {
      const r = await this.shareAction<{ revoked: number }>('revoke-all');
      return { revoked: r.revoked };
    } catch (e) {
      if (e instanceof ApiError && e.code === 'share_not_fresh') throw new VaultError(ErrorCode.unauthorized, 'Only within 5 minutes of a fresh sign-in', { reason: 'share_not_fresh' });
      if (e instanceof ApiError && (e.status === 404 || e.status === 410)) {
        await this.deleteRecordIf(s).catch(() => undefined);
        this.broadcastRevoked(share.shareId);
        if (this.session === s) this.endSession(true);
        throw disconnected('This session was revoked');
      }
      throw e instanceof ApiError ? apiErrorToVault(e) : e;
    }
  }

  /** Slides the server idle limit after an approved signature, at most once per 10 min. Best effort. */
  private maybeTouch(): void {
    const s = this.live();
    const share = s?.share;
    if (!s || !share || this.clock.now() - s.lastTouchAt < TOUCH_EVERY_MS) return;
    s.lastTouchAt = this.clock.now();
    void this.shareAction('touch').catch((e: unknown) => {
      if (e instanceof ApiError && (e.status === 404 || e.status === 410) && this.session === s) {
        void this.deleteRecordIf(s).catch(() => undefined);
        this.broadcastRevoked(share.shareId);
        this.endSession(true);
      }
    });
  }

  // ---- signing ----

  private async sign(request: SignRequest): Promise<unknown> {
    const s = this.live();
    if (!s) throw notLoggedIn();
    // Raw signing is re-read before every raw request (setting it to 'off' takes effect in open tabs).
    // A test app's raw request is refused outright (approvalSubject), with no API read.
    const rawSign: RawSign = request.method === 'hana_signRaw' && !this.testApp ? await this.freshRawSign() : 'off';
    if (this.live() !== s) throw disconnected();
    const subject = approvalSubject(request, s.addresses, { rawSign, testApp: this.testApp });
    const policy = NEVER_AUTO_APPROVED_KINDS.has(subject.kind) ? null : await this.freshPolicy();
    if (this.live() !== s) throw disconnected();
    let note: { label: string; active: boolean; reason?: string } | undefined;
    if (policy) {
      let auto = await this.tryAutoSign(s, request, subject, policy);
      if (auto.kind === 'signed') return auto.result;
      if (auto.kind === 'no_consent' && this.declinedPolicyId !== policy.policyId) {
        // A request the policy would cover: ask for consent first (the same popup), then sign under it.
        const would = matchAutoApprovePolicy(policy.policy, subject, { usage: null, nowMs: this.clock.now() });
        if (would.ok) {
          const granted = await this.askConsent(s, policy);
          if (this.live() !== s) throw disconnected();
          // The consent screen can stay up for minutes: the policy must still be in force to sign under it.
          if (granted && (await this.freshPolicy())?.policyId === policy.policyId) {
            auto = await this.tryAutoSign(s, request, subject, policy);
            if (auto.kind === 'signed') return auto.result;
          }
        }
      }
      note = { label: policy.policy.label, active: auto.kind === 'miss' };
      if (auto.kind === 'miss') note.reason = auto.reason;
    }
    const outcome = await this.approvals!.requestApproval(subject, note);
    if (outcome === 'cancelled' || this.live() !== s) throw disconnected();
    if (outcome !== 'approved') throw userRejected();
    if (this.live() !== s) throw disconnected();
    const result = signRequest(s.prk, request, subject);
    this.maybeTouch();
    return result;
  }

  /**
   * Signs under the accepted policy if it covers the request: under the per-app lock, with the consent and today's
   * counters re-read (from the record in 'session' mode, so tabs share them), and the counters written back.
   */
  private async tryAutoSign(
    s: Session,
    request: SignRequest,
    subject: ReturnType<typeof approvalSubject>,
    policy: PolicyInForce,
  ): Promise<{ kind: 'signed'; result: unknown } | { kind: 'no_consent' } | { kind: 'miss'; reason: string }> {
    type Outcome = { kind: 'signed'; result: unknown; match: Extract<AutoApproveResult, { ok: true }> } | { kind: 'no_consent' } | { kind: 'miss'; reason: string };
    const outcome = await this.withConsent<Outcome>(s, async (consent) => {
      // A logout or expiry while the lock was awaited zeroed PRK: never sign with it.
      if (this.live() !== s) throw disconnected();
      const now = this.clock.now();
      if (!consentActive(consent, policy, now, s.expiresAtMs)) return { value: { kind: 'no_consent' } };
      const match = matchAutoApprovePolicy(policy.policy, subject, { usage: consent, nowMs: now });
      if (!match.ok) return { value: { kind: 'miss', reason: match.reason } };
      const result = signRequest(s.prk, request, subject);
      const usage = recordAutoApproveUse(consent, now, match.spend);
      return { value: { kind: 'signed', result, match }, write: withUsage(consent, usage) };
    });
    if (outcome.kind === 'signed') {
      this.emit('autoApproved', { kind: request.method, chain: outcome.match.chain, contract: outcome.match.contract.slice(0, 128), function: outcome.match.function.slice(0, 128) });
      this.launcher.flash(`Signed by Hana under ${policy.policy.label}`, AUTO_APPROVED_FLASH_MS);
      return { kind: 'signed', result: outcome.result };
    }
    return outcome;
  }

  /**
   * Runs `fn` with the current consent and writes back what it returns (`write`; null clears it). In 'session' mode
   * this holds the per-app lock and reads and seals the consent in the record; a consent that fails to open deletes
   * the record and ends the session.
   */
  private async withConsent<T>(s: Session, fn: (consent: ConsentV1 | null) => Promise<{ value: T; write?: ConsentV1 | null }>): Promise<T> {
    if (!s.share || !this.store) {
      const out = await fn(s.consent);
      if (out.write !== undefined) s.consent = out.write;
      return out.value;
    }
    const share = s.share;
    const store = this.store;
    let tampered = false;
    const value = await this.o.locks.request(this.lockName, async () => {
      const read = await this.readRecord().catch(() => null);
      const record = read && read !== 'invalid' && sameSession(read, { sessionPk: s.sessionPk, shareId: share.shareId }) ? read : null;
      let consent: ConsentV1 | null = s.consent;
      if (record) {
        try {
          consent = await openConsent(s.prk, record);
        } catch {
          tampered = true;
          await store.delete(this.recordId);
          return null;
        }
      }
      s.consent = consent;
      const out = await fn(consent);
      if (out.write !== undefined) {
        s.consent = out.write;
        if (record) {
          if (out.write === null) delete record.consent;
          else record.consent = await sealConsent(s.prk, record, out.write);
          await store.put(this.recordId, record);
        }
      }
      return { v: out.value };
    });
    if (tampered || value === null) {
      this.endSession(true);
      throw disconnected('The vault record was tampered with');
    }
    return value.v;
  }

  /** The consent screen; on Allow, stores a consent for the policy. */
  private async askConsent(s: Session, policy: PolicyInForce): Promise<boolean> {
    const expiresAtMs = consentEnd(policy, this.clock.now(), s.expiresAtMs);
    const outcome: ApprovalOutcome = await this.approvals!.requestConsent(policy.policy, policy.policyId, expiresAtMs);
    if (outcome === 'cancelled' || this.live() !== s) throw disconnected();
    if (outcome !== 'approved') {
      this.declinedPolicyId = policy.policyId;
      return false;
    }
    this.declinedPolicyId = null;
    await this.withConsent(s, async () => ({ value: null, write: newConsent(policy, this.clock.now(), expiresAtMs) }));
    return true;
  }

  private async requestAutoApprove(): Promise<PortResultMap['hana_requestAutoApprove']> {
    const s = this.live();
    if (!s) throw notLoggedIn();
    // A stale policy is re-read first; if that fails, the consent screen still shows the cached one (signing re-checks).
    const policy = (await this.freshPolicy()) ?? this.policy;
    if (this.live() !== s) throw disconnected();
    if (!policy) throw new VaultError(ErrorCode.unauthorized, 'This app has no auto-approve policy in force');
    const active = await this.withConsent(s, async (c) => ({ value: consentActive(c, policy, this.clock.now(), s.expiresAtMs) ? c : null }));
    if (active) return { granted: true, policyId: policy.policyId, expiresAtMs: active.expiresAtMs };
    const granted = await this.askConsent(s, policy);
    if (!granted) return { granted: false };
    const now = await this.withConsent(s, async (c) => ({ value: c }));
    return now ? { granted: true, policyId: policy.policyId, expiresAtMs: now.expiresAtMs } : { granted: false };
  }

  /**
   * The active consent's status. Live: read from the record (it is sealed under PRK, so reading it needs the key in
   * memory). Dormant: this tab's last known consent, without waking the session (a status poll must not bring PRK
   * back); its counters may lag auto-signs made by other tabs since, until the next request that uses the key.
   */
  private async autoApproveStatusResult(): Promise<PortResultMap['hana_autoApproveStatus']> {
    const s = this.live();
    const policy = this.policy;
    if (!policy) return null;
    if (!s) {
      const d = this.liveDormant();
      const now = this.clock.now();
      return d && consentActive(d.consent, policy, now, d.expiresAtMs) ? autoApproveStatus(d.consent, policy, now) : null;
    }
    return this.withConsent(s, async (c) => ({ value: consentActive(c, policy, this.clock.now(), s.expiresAtMs) ? autoApproveStatus(c, policy, this.clock.now()) : null }));
  }

  private async revokeAutoApprove(): Promise<void> {
    const s = this.session;
    if (!s) return;
    await this.withConsent(s, async () => ({ value: null, write: null }));
  }

  // ---- export (vault side; docs/batch-b-spec.md "Key export" steps 1–2) ----

  private startExport(chain: 'stellar' | 'evm'): Promise<null> {
    const s = this.live();
    if (!s) return Promise.reject(notLoggedIn());
    if (this.exportJob) return Promise.reject(new VaultError('busy', 'An export is already running'));
    return new Promise<null>((resolve, reject) => {
      const job: ExportJob = {
        chain,
        address: chain === 'stellar' ? s.addresses.stellar : s.addresses.evm,
        window: null,
        contextSent: false,
        intent: null,
        timer: null,
        poll: null,
        resolve: () => resolve(null),
        reject,
      };
      this.exportJob = job;
      job.intent = this.launcher.push('Export key in Hana', () => this.openExportWindow(job));
      job.timer = this.timers.setTimeout(() => {
        if (!job.contextSent) this.finishExport(job, userRejected('The export was not started'));
      }, EXPORT_START_MS);
    });
  }

  /** The launcher click: a top-level window on authOrigin with a random name (no `popup` feature). */
  private openExportWindow(job: ExportJob): void {
    if (this.exportJob !== job || job.window) return;
    const w = this.host.open(`${this.env.authOrigin}/export`, `hana-export-${randomHex128()}`, '');
    if (!w) return;
    job.window = w;
    job.intent?.remove();
    job.intent = null;
    const started = this.deviceNow();
    const tick = () => {
      job.poll = null;
      if (this.exportJob !== job) return;
      let closed = true;
      try {
        closed = w.closed;
      } catch {
        // Treat an unreadable handle as closed.
      }
      if (closed || this.deviceNow() - started >= EXPORT_MAX_MS) {
        this.finishExport(job, job.contextSent ? null : userRejected('The export window was closed'));
        return;
      }
      job.poll = this.timers.setTimeout(tick, 1_000);
    };
    job.poll = this.timers.setTimeout(tick, 1_000);
  }

  private onExportHello(e: WindowMessageEvent): void {
    const job = this.exportJob;
    if (!job || !job.window || job.contextSent || e.source !== job.window || e.origin !== this.env.authOrigin) return;
    // The session may have ended (expiry with a delayed timer) since the export started: no context for it.
    if (!this.live()) {
      this.cancelExport(disconnected());
      return;
    }
    job.contextSent = true;
    job.window.postMessage(
      {
        v: 1,
        t: 'hana:export-context',
        pk: this.config.publishableKey,
        appName: this.config.appName,
        parentOrigin: this.parentOrigin!,
        scopeId: this.config.scopeId,
        signer: this.env.signer,
        keyIndex: 0,
        chain: job.chain,
        address: job.address,
      },
      this.env.authOrigin,
    );
    // The vault's part is done; the job stays (busy) until the export window closes.
    job.resolve();
  }

  private finishExport(job: ExportJob, error: VaultError | null): void {
    if (this.exportJob !== job) return;
    this.exportJob = null;
    job.intent?.remove();
    this.timers.clearTimeout(job.timer);
    if (job.poll !== null) this.timers.clearTimeout(job.poll);
    if (error) job.reject(error);
  }

  private cancelExport(error: VaultError): void {
    const job = this.exportJob;
    if (!job) return;
    if (job.window && !job.contextSent) {
      try {
        job.window.close();
      } catch {
        // Already gone.
      }
    }
    this.finishExport(job, job.contextSent ? null : error);
  }
}
