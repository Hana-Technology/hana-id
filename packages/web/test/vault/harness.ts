// Test harness for the vault: a fake Hana API (app config, /v1/login, /v1/derive, /v1/sessions, the login relay and
// the vault share endpoints), a fake NEAR RPC over the same in-memory chain, a simulated MPC (real BLS, so the vault's
// pairing check runs), a fake Google (real RS256), fake windows and popups, a real MessageChannel port, fake-indexeddb
// storage, a lock manager and BroadcastChannel bus shared by the "tabs" of one browser, and timers whose long delays
// (approval and login timeouts) run only when a test advances the clock.
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { IDBFactory } from 'fake-indexeddb';
import {
  CKD_DST,
  type PortEventName,
  approvalDigest,
  base64Decode,
  base64Encode,
  base64UrlDecode,
  base64UrlEncode,
  ckdAppId,
  consentDigest,
  encryptRelayPayload,
  fromUtf8,
  relayIdFor,
  toHex,
  utf8,
  vaultMessage,
  vaultPayload,
  verifyEd25519,
} from '@hana-id/core';
import type { HanaEnv } from '../../src/hana-env.ts';
import type { VaultConfig } from '../../src/vault/config.ts';
import type { LauncherView } from '../../src/vault/launcher.ts';
import { type RecordStore, openRecordStore } from '../../src/vault/record.ts';
import { type Channel, type Locks, type Timers, type WindowMessageEvent, type WindowRef, localLocks } from '../../src/vault/runtime.ts';
import { type NavigationMarks, Vault, type VaultOptions } from '../../src/vault/vault.ts';

// ---- constants ----

export const PARTNER = 'https://partner.test';
export const SCOPE = 's1';
export const APP_ID = 'app_1';
export const CLIENT_ID = 'shared.apps.googleusercontent.com';
export const SUB = '110248495921238986420';
export const PK = 'pk_test_1111111111111111111111';
const G1 = bls.G1.ProjectivePoint;
const G2 = bls.G2.ProjectivePoint;
const MSK = 0x1234567890abcdefn;
export const NETWORK_KEY = `bls12381g2:${base58.encode(G2.BASE.multiply(MSK).toRawBytes(true))}`;

export const ENV: HanaEnv = Object.freeze({
  name: 'sandbox-test',
  network: 'testnet',
  apiUrl: 'https://api.test',
  vaultOrigin: 'https://vault.test',
  authOrigin: 'https://auth.test',
  signer: 'hana-signer.testnet',
  relayer: 'hana-relayer.testnet',
  rpc: 'https://rpc.test',
  ckdNetworkKey: NETWORK_KEY,
  devEnv: true,
});

/** A second RPC endpoint, for envs whose manifest sets rpcFallback (tests pass `{...ENV, rpcFallback: RPC_FALLBACK}`). */
export const RPC_FALLBACK = 'https://rpc-fallback.test';

export const HOUR = 3_600_000;
export const START_MS = 1_800_000_000_000;

export function makeConfig(over: Partial<Omit<VaultConfig, 'settings'>> & { settings?: Partial<VaultConfig['settings']> } = {}): VaultConfig {
  const { settings, ...rest } = over;
  return {
    v: 1,
    appId: APP_ID,
    appName: 'Partner',
    scopeId: SCOPE,
    origins: [PARTNER],
    publishableKey: PK,
    serverTimeMs: START_MS,
    ...rest,
    settings: { persistence: 'session', sessionTtlMs: 12 * HOUR, idleTtlMs: 2 * HOUR, rawSign: 'off', autoApprovePolicy: null, ...settings },
  };
}

// ---- timers ----

/** Delays up to this run on the next real tick (polls, backoffs); longer ones only when the test advances the clock. */
const WARP_MAX_MS = 5_000;

export class TestTimers implements Timers {
  now = START_MS;
  private seq = 0;
  private readonly manual = new Map<number, { at: number; fn: () => void }>();
  private readonly real = new Map<number, ReturnType<typeof setTimeout>>();

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    if (ms <= WARP_MAX_MS) {
      this.real.set(
        id,
        setTimeout(() => {
          this.real.delete(id);
          fn();
        }, 1),
      );
    } else this.manual.set(id, { at: this.now + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    const id = handle as number;
    this.manual.delete(id);
    const r = this.real.get(id);
    if (r !== undefined) clearTimeout(r);
    this.real.delete(id);
  }

  /** Moves the clock and fires every long timer now due, in order. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.manual.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.manual.delete(due[0]);
      due[1].fn();
    }
  }

  dispose(): void {
    for (const r of this.real.values()) clearTimeout(r);
    this.real.clear();
    this.manual.clear();
  }
}

// ---- Google ----

export interface Google {
  kid: string;
  jwk: { kid: string; n: string; e: string; kty: 'RSA'; alg: 'RS256' };
  token(claims: Record<string, unknown>): Promise<string>;
}

let googleKeys: Promise<CryptoKeyPair> | null = null;

export async function google(): Promise<Google> {
  googleKeys ??= crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const keys = await googleKeys;
  const jwk = (await crypto.subtle.exportKey('jwk', keys.publicKey)) as JsonWebKey;
  const kid = 'kid-1';
  return {
    kid,
    jwk: { kid, n: jwk.n!, e: jwk.e!, kty: 'RSA', alg: 'RS256' },
    async token(claims) {
      const enc = (o: unknown) => base64UrlEncode(utf8(JSON.stringify(o)));
      const input = `${enc({ alg: 'RS256', kid, typ: 'JWT' })}.${enc(claims)}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, utf8(input)));
      return `${input}.${base64UrlEncode(sig)}`;
    },
  };
}

// ---- MPC ----

const g1 = (p: InstanceType<typeof G1>): string => `bls12381g1:${base58.encode(p.toRawBytes(true))}`;

/** (Y, C) = (y·G1, msk·H(pk ‖ app_id) + y·A), as the MPC answers a CKD request. */
export function mpcAnswer(pk1: string, path: string, signer = ENV.signer): { big_y: string; big_c: string } {
  const appId = ckdAppId(signer, path);
  const pkBytes = G2.BASE.multiply(MSK).toRawBytes(true);
  const h = G1.fromAffine(bls.G1.hashToCurve(Uint8Array.from([...pkBytes, ...appId]), { DST: CKD_DST }).toAffine());
  const y = bls.G1.normPrivateKeyToScalar(bls.utils.randomPrivateKey());
  const a1 = G1.fromHex(base58.decode(pk1.slice('bls12381g1:'.length)));
  return { big_y: g1(G1.BASE.multiply(y)), big_c: g1(h.multiply(MSK).add(a1.multiply(y))) };
}

// ---- fake chain + API + RPC ----

export interface ChainSession {
  path: string;
  scope_id: string;
  expires_at_ms: number;
  max_uses: number;
  used: number;
}

interface FakeShare {
  shareId: Uint8Array;
  ks: Uint8Array;
  sessionPk: Uint8Array;
  appId: string;
  counter: number;
  revoked: boolean;
  createdAt: number;
}

export interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: ApiCall) => Response | Promise<Response> | undefined;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const apiError = (status: number, code: string, extra: Record<string, unknown> = {}): Response => json(status, { error: code, code, requestId: 'rq', ...extra });

export class FakeBackend {
  readonly sessions = new Map<string, ChainSession>();
  readonly shares = new Map<string, FakeShare>();
  readonly txs = new Map<string, unknown>();
  readonly relay = new Map<string, { iv: string; ct: string } | 'consumed'>();
  readonly calls: ApiCall[] = [];
  readonly rpcCalls: { method: string; params: Record<string, unknown>; endpoint: string }[] = [];
  readonly overrides = new Map<string, Handler>();
  /** The on-chain registry the RPC answers views from: `get_scope` by id, `scope_for_client` by `<provider>|<aud>`. */
  readonly scopes = new Map<string, { id: string; allow_shared: boolean }>([[SCOPE, { id: SCOPE, allow_shared: true }]]);
  readonly clientScopes = new Map<string, string>();
  /** RPC endpoints (origins) that fail every call with a network error. */
  readonly rpcDown = new Set<string>();
  /** What GET /v1/app answers. */
  app: Record<string, unknown> = { scopeId: SCOPE, signer: ENV.signer, google: { clientId: CLIENT_ID, mode: 'shared' }, name: 'Partner' };
  /** The auto-approve policy in force that GET /v1/app answers: each new tab's page sets it (the page is current). */
  autoApprovePolicy: Record<string, unknown> | null = null;
  /** The raw-signing setting in force that GET /v1/app answers (each new tab's page sets it, as for the policy). */
  rawSign: 'off' | 'approval' = 'off';
  serverNow: () => number = () => START_MS;
  /** The API's own timings to answer /v1/login, /v1/vault/shares and /v1/vault/unlock with (a pk_test_ API), or none. */
  serverTimings: { totalMs: number; phases: Record<string, number> } | null = null;
  /** The relay read's `heldMs`, or none (an older API). */
  relayHeldMs: number | null = null;
  /** What the callback adds to the relay slot for a pk_test_ login (its own and /login's stage durations), or none. */
  popupTimings: Record<string, number> | null = null;
  private txSeq = 0;
  private readonly relayWaiters = new Set<() => void>();

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  /** Writes the relay slot as the callback page would (encrypted under relayKey). */
  async writeRelay(relayId: string, relayKey: Uint8Array, payload: { idToken: string } | { error: string }): Promise<void> {
    const withTimings = this.popupTimings ? { ...payload, timings: { ...this.popupTimings } } : payload;
    this.relay.set(relayId, await encryptRelayPayload(relayKey, relayId, withTimings));
    for (const w of [...this.relayWaiters]) w();
  }

  writeRelayRaw(relayId: string, value: { iv: string; ct: string }): void {
    this.relay.set(relayId, value);
    for (const w of [...this.relayWaiters]) w();
  }

  nextTx(): string {
    this.txSeq += 1;
    return `tx${this.txSeq}`;
  }

  /** The chain side of create_session (+ derive counter 1): used = 1 and the MPC's answer, or an error message. */
  createSession(body: Record<string, unknown>, derive: boolean): { ok: true; result?: unknown; session: ChainSession } | { ok: false; reason: string } {
    const pkHex = toHex(Uint8Array.from(body.sessionPublicKey as number[]));
    if (this.sessions.has(pkHex)) return { ok: false, reason: 'session_key_in_use' };
    const claims = JSON.parse(fromUtf8(base64UrlDecode((body.jwt as string).split('.')[1]!))) as { sub: string };
    const session: ChainSession = { path: `${SCOPE}#google#${claims.sub}#${body.keyIndex as number}`, scope_id: SCOPE, expires_at_ms: body.expiresAtMs as number, max_uses: body.maxUses as number, used: derive ? 1 : 0 };
    this.sessions.set(pkHex, session);
    return { ok: true, session, ...(derive ? { result: mpcAnswer(body.pk1 as string, session.path) } : {}) };
  }

  fetch: typeof fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
    if (url.origin === ENV.rpc || url.origin === RPC_FALLBACK) {
      if (this.rpcDown.has(url.origin)) throw new TypeError('Failed to fetch');
      return this.rpc(body as { method: string; params: Record<string, unknown> }, url.origin);
    }
    if (url.href === 'https://www.googleapis.com/oauth2/v3/certs') return json(200, { keys: [] });
    const call: ApiCall = { method: init?.method ?? 'GET', path: url.pathname, headers, body };
    this.calls.push(call);
    const override = this.overrides.get(url.pathname);
    if (override) {
      const r = await override(call);
      if (r) return r;
    }
    return this.route(call, url, init?.signal ?? undefined);
  };

  private async route(call: ApiCall, url: URL, signal?: AbortSignal): Promise<Response> {
    const b = call.body as Record<string, unknown>;
    if (call.path === '/v1/app') return json(200, { autoApprovePolicy: this.autoApprovePolicy, rawSign: this.rawSign, ...this.app, serverTimeMs: this.serverNow(), requestId: 'rq' });
    if (call.path === '/v1/login') {
      const r = this.createSession(b, true);
      const nearTx = this.nextTx();
      if (!r.ok) return apiError(409, 'session_exists', { nearTx: null });
      this.txs.set(nearTx, r.result);
      return json(200, { result: r.result, session: { scope_id: SCOPE, expires_at_ms: b.expiresAtMs, max_uses: b.maxUses, used: 1 }, nearTx, ...this.timingsField(), requestId: 'rq' });
    }
    if (call.path === '/v1/sessions') {
      const r = this.createSession(b, false);
      if (!r.ok) return apiError(409, 'session_exists');
      return json(200, { result: r.session, nearTx: this.nextTx(), requestId: 'rq' });
    }
    if (call.path === '/v1/derive') {
      const s = this.sessions.get(toHex(Uint8Array.from(b.sessionPublicKey as number[])));
      if (!s) return apiError(409, 'no_session');
      if (b.counter !== s.used + 1 || s.used >= s.max_uses) return apiError(409, 'bad_counter', { nextCounter: s.used + 1 });
      s.used += 1;
      const nearTx = this.nextTx();
      const result = mpcAnswer(b.pk1 as string, s.path);
      this.txs.set(nearTx, result);
      return json(200, { result, nearTx, requestId: 'rq' });
    }
    if (call.path.startsWith('/v1/login-relay/')) {
      const relayId = call.path.slice('/v1/login-relay/'.length);
      const key = call.headers['x-hana-relay-key'];
      if (!key || base64UrlEncode(new Uint8Array(await crypto.subtle.digest('SHA-256', base64UrlDecode(key)))) !== relayId) return apiError(403, 'relay_forbidden');
      for (let i = 0; i < 2 && !this.relay.has(relayId); i++) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(done, 15);
          function done() {
            clearTimeout(t);
            waiters.delete(done);
            resolve();
          }
          const waiters = this.relayWaiters;
          waiters.add(done);
          signal?.addEventListener('abort', done, { once: true });
        });
        if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
      }
      const v = this.relay.get(relayId);
      if (v === undefined) return new Response(null, { status: 204 });
      if (v === 'consumed') return apiError(410, 'relay_gone');
      this.relay.set(relayId, 'consumed');
      return json(200, { ...v, serverTimeMs: this.serverNow(), ...(this.relayHeldMs === null ? {} : { heldMs: this.relayHeldMs }) });
    }
    if (call.path === '/v1/vault/shares') return this.createShare(call);
    if (call.path.startsWith('/v1/vault/')) return this.shareAction(call, call.path.slice('/v1/vault/'.length));
    void url;
    return apiError(404, 'not_found');
  }

  private timingsField(): { timings?: unknown } {
    return this.serverTimings ? { timings: structuredClone(this.serverTimings) } : {};
  }

  private async createShare(call: ApiCall): Promise<Response> {
    const b = call.body as { sessionPublicKey: number[]; signature: number[] };
    const pk = Uint8Array.from(b.sessionPublicKey);
    const msg = vaultMessage({ signer: ENV.signer, appId: APP_ID, shareId: new Uint8Array(16), counter: 0, payload: vaultPayload.createShare(call.headers['x-hana-parent-origin'] ?? '') });
    if (!(await verifyEd25519(pk, Uint8Array.from(b.signature), msg))) return apiError(401, 'invalid_signature');
    const session = this.sessions.get(toHex(pk));
    if (!session) return apiError(404, 'unknown_session');
    if (session.used !== session.max_uses) return apiError(409, 'session_not_spent');
    for (const s of this.shares.values()) if (toHex(s.sessionPk) === toHex(pk)) return apiError(409, 'share_exists');
    const shareId = crypto.getRandomValues(new Uint8Array(16));
    const ks = crypto.getRandomValues(new Uint8Array(32));
    this.shares.set(toHex(shareId), { shareId, ks, sessionPk: pk, appId: APP_ID, counter: 0, revoked: false, createdAt: this.serverNow() });
    return json(201, { shareId: Array.from(shareId), ks: Array.from(ks), absExpiresAtMs: session.expires_at_ms, idleUntilMs: this.serverNow() + 2 * HOUR, ...this.timingsField(), requestId: 'rq' });
  }

  private async shareAction(call: ApiCall, action: string): Promise<Response> {
    const b = call.body as { shareId: number[]; counter: number; signature: number[] };
    const share = this.shares.get(toHex(Uint8Array.from(b.shareId)));
    if (!share || share.appId !== APP_ID) return apiError(404, 'unknown_share');
    const payload = action === 'unlock' ? vaultPayload.unlock() : action === 'touch' ? vaultPayload.touch() : action === 'revoke' ? vaultPayload.revoke() : vaultPayload.revokeAll();
    const msg = vaultMessage({ signer: ENV.signer, appId: APP_ID, shareId: share.shareId, counter: b.counter, payload });
    if (!(await verifyEd25519(share.sessionPk, Uint8Array.from(b.signature), msg))) return apiError(401, 'invalid_signature');
    if (share.revoked) return apiError(410, 'share_revoked');
    if (b.counter !== share.counter + 1) return apiError(409, 'bad_counter', { expected: share.counter + 1 });
    share.counter = b.counter;
    if (action === 'unlock')
      return json(200, { ks: Array.from(share.ks), counter: share.counter, idleUntilMs: this.serverNow() + 2 * HOUR, absExpiresAtMs: this.serverNow() + 12 * HOUR, ...this.timingsField(), requestId: 'rq' });
    if (action === 'touch') return json(200, { counter: share.counter, idleUntilMs: this.serverNow() + 2 * HOUR, requestId: 'rq' });
    if (action === 'revoke') {
      share.revoked = true;
      return json(200, { revoked: true, requestId: 'rq' });
    }
    if (this.serverNow() - share.createdAt >= 5 * 60_000) return apiError(403, 'share_not_fresh');
    let revoked = 0;
    for (const s of this.shares.values()) {
      if (s !== share && !s.revoked) {
        s.revoked = true;
        revoked += 1;
      }
    }
    return json(200, { revoked, requestId: 'rq' });
  }

  private rpc(body: { method: string; params: Record<string, unknown> }, endpoint: string): Response {
    this.rpcCalls.push({ ...body, endpoint });
    if (body.method === 'query') {
      const args = JSON.parse(fromUtf8(base64Decode(body.params.args_base64 as string))) as Record<string, unknown>;
      const answer = (v: unknown) => json(200, { jsonrpc: '2.0', id: 'x', result: { result: Array.from(utf8(JSON.stringify(v))) } });
      if (body.params.method_name === 'get_scope') return answer(this.scopes.get(args.scope_id as string) ?? null);
      if (body.params.method_name === 'scope_for_client') return answer(this.clientScopes.get(`${args.provider as string}|${args.aud as string}`) ?? null);
      return answer(this.sessions.get(toHex(Uint8Array.from(args.session_public_key as number[]))) ?? null);
    }
    if (body.method === 'EXPERIMENTAL_tx_status') {
      const v = this.txs.get(body.params.tx_hash as string);
      if (v === undefined) return json(200, { jsonrpc: '2.0', id: 'x', error: { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_TRANSACTION' } } });
      if (v === 'failure') return json(200, { jsonrpc: '2.0', id: 'x', result: { status: { Failure: {} } } });
      return json(200, { jsonrpc: '2.0', id: 'x', result: { status: { SuccessValue: base64Encode(utf8(JSON.stringify(v))) } } });
    }
    return json(200, { jsonrpc: '2.0', id: 'x', error: { message: 'unknown method' } });
  }
}

// ---- windows ----

export interface Posted {
  message: Record<string, unknown>;
  targetOrigin: string;
}

export class FakeWindow implements WindowRef {
  closed = false;
  readonly posted: Posted[] = [];
  focused = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(
    readonly url: string = '',
    readonly name: string = '',
    readonly features: string = '',
    readonly opener: unknown = null,
  ) {}

  postMessage(message: unknown, targetOrigin: string): void {
    // A structured clone, as the browser delivers it (the sender may zero its copy afterwards).
    this.posted.push({ message: structuredClone(message) as Record<string, unknown>, targetOrigin });
    for (const w of this.waiters.splice(0)) w();
  }

  focus(): void {
    this.focused += 1;
  }

  close(): void {
    this.closed = true;
  }

  /** The `n`th (0-based) message of type `t`, waiting for it. */
  async next(t: string, n = 0, timeoutMs = 3000): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.posted.filter((p) => p.message.t === t)[n];
      if (found) return found.message;
      if (Date.now() > deadline) throw new Error(`No ${t} #${n} posted to ${this.url}`);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 20);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }
}

export class FakeLauncherView implements LauncherView {
  label: string | null = null;
  private onClick: (() => void) | null = null;
  readonly history: string[] = [];

  show(label: string, onClick: (() => void) | null): void {
    this.label = label;
    this.onClick = onClick;
    this.history.push(label);
  }

  hide(): void {
    this.label = null;
    this.onClick = null;
  }

  click(): void {
    if (!this.onClick) throw new Error(`The launcher has no click action (${this.label ?? 'hidden'})`);
    this.onClick();
  }
}

// ---- the browser (shared by tabs) ----

export class Bus {
  private readonly members = new Map<string, Set<(d: unknown) => void>>();
  readonly sent: { name: string; data: unknown }[] = [];

  channel(name: string): Channel {
    const set = this.members.get(name) ?? new Set();
    this.members.set(name, set);
    let listener: ((d: unknown) => void) | null = null;
    const self = (d: unknown) => listener?.(d);
    set.add(self);
    return {
      postMessage: (m) => {
        const data = structuredClone(m);
        this.sent.push({ name, data });
        for (const other of set) if (other !== self) queueMicrotask(() => other(structuredClone(data)));
      },
      onMessage: (l) => {
        listener = l;
      },
      close: () => set.delete(self),
    };
  }
}

export class Browser {
  readonly idb = new IDBFactory();
  readonly locks: Locks = localLocks();
  readonly bus = new Bus();
  readonly backend = new FakeBackend();
  readonly timers = new TestTimers();
  storeFails = false;

  openStore = (): Promise<RecordStore> => (this.storeFails ? Promise.reject(new Error('blocked')) : openRecordStore(this.idb));
}

// ---- one vault (a tab's iframe) ----

export interface Reply {
  id: string;
  result?: unknown;
  error?: { code: number | string; message: string; data?: unknown };
}

export interface Tab {
  vault: Vault;
  browser: Browser;
  parent: FakeWindow;
  launcher: FakeLauncherView;
  opened: FakeWindow[];
  port: MessagePort;
  events: { event: string; data: unknown }[];
  replies: Reply[];
  /** Every message the vault posted on its port (events and replies), as received. */
  portMessages: unknown[];
  dispatch(e: Partial<WindowMessageEvent> & { data: unknown }): void;
  hello(opts?: { origin?: string; source?: unknown; ports?: MessagePort[] }): void;
  ready(): Promise<Record<string, unknown>>;
  request(method: string, params?: unknown): Promise<Reply>;
  waitEvent(event: PortEventName, n?: number): Promise<unknown>;
  /** Waits until `check` is true, re-checking on every port message (and every 20 ms), for up to 4 s of real time. */
  waitUntil(check: () => boolean, what: string): Promise<void>;
  close(): void;
}

let idSeq = 0;

export interface TabOptions {
  config?: VaultConfig;
  env?: HanaEnv;
  ancestorOrigin?: string;
  loginFlow?: 'combined' | 'split';
  googleJwk?: Google['jwk'];
  options?: Partial<VaultOptions>;
  /** The vault document's navigation timing (unlock timings' `vault*` stages). */
  navigation?: NavigationMarks;
}

export function openTab(browser: Browser, o: TabOptions = {}): Tab {
  const parent = new FakeWindow('partner', '', '', null);
  const launcher = new FakeLauncherView();
  const opened: FakeWindow[] = [];
  const listeners: ((e: WindowMessageEvent) => void)[] = [];
  const config = o.config ?? makeConfig();
  // The page a tab loads inlines what the API serves at that moment.
  browser.backend.autoApprovePolicy = config.settings.autoApprovePolicy;
  browser.backend.rawSign = config.settings.rawSign;
  const vault = new Vault({
    env: o.env ?? ENV,
    config,
    host: {
      parent,
      ancestorOrigin: () => o.ancestorOrigin,
      onMessage: (l) => listeners.push(l),
      open: (url, name, features) => {
        const w = new FakeWindow(url, name, features, null);
        opened.push(w);
        return w;
      },
      navigationTiming: () => o.navigation ?? null,
    },
    openStore: browser.openStore,
    locks: browser.locks,
    channel: (name) => browser.bus.channel(name),
    launcherView: launcher,
    fetch: browser.backend.fetch,
    timers: browser.timers,
    deviceNow: () => browser.timers.now,
    jwks: async (kid) => (o.googleJwk && o.googleJwk.kid === kid ? o.googleJwk : null),
    ...(o.loginFlow ? { loginFlow: o.loginFlow } : {}),
    ...o.options,
  });
  const { port1, port2 } = new MessageChannel();
  const events: { event: string; data: unknown }[] = [];
  const replies: Reply[] = [];
  const portMessages: unknown[] = [];
  const waiters: (() => void)[] = [];
  port1.onmessage = (m) => {
    portMessages.push(m.data);
    const d = m.data as Record<string, unknown>;
    if ('event' in d) events.push({ event: d.event as string, data: d.data });
    else replies.push(d as unknown as Reply);
    for (const w of waiters.splice(0)) w();
  };
  const waitFor = async <T>(find: () => T | undefined, what: string, timeoutMs = 4000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = find();
      if (v !== undefined) return v;
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, 20);
        waiters.push(() => {
          clearTimeout(t);
          resolve();
        });
      });
    }
  };
  const tab: Tab = {
    vault,
    browser,
    parent,
    launcher,
    opened,
    port: port1,
    events,
    replies,
    portMessages,
    dispatch: (e) => {
      const full: WindowMessageEvent = { origin: e.origin ?? ENV.authOrigin, source: e.source ?? null, ports: e.ports ?? [], data: e.data };
      for (const l of listeners) l(full);
    },
    hello: (h = {}) => {
      tab.dispatch({ data: { v: 1, t: 'hana:hello', sdk: '0.0.0' }, origin: h.origin ?? PARTNER, source: h.source ?? parent, ports: h.ports ?? [port2] });
    },
    ready: async () => (await waitFor(() => events.find((e) => e.event === 'ready'), 'ready')).data as Record<string, unknown>,
    request: (method, params) => {
      idSeq += 1;
      const id = `r${idSeq}`;
      port1.postMessage(params === undefined ? { v: 1, id, method } : { v: 1, id, method, params });
      return waitFor(() => replies.find((r) => r.id === id), `reply to ${method}`, 8000);
    },
    waitEvent: async (event, n = 0) => (await waitFor(() => events.filter((e) => e.event === event)[n], `event ${event}`)).data,
    waitUntil: async (check, what) => {
      await waitFor(() => (check() ? true : undefined), what);
    },
    close: () => {
      port1.close();
      port2.close();
    },
  };
  return tab;
}

// ---- the login popup and callback, as the auth pages would run them ----

export interface LoginRun {
  popup: FakeWindow;
  params: Record<string, unknown>;
}

/** A login popup the partner opened (its opener is the partner window): hello, then the vault's auth-params. */
export async function popupHello(tab: Tab, popup = new FakeWindow(`${ENV.authOrigin}/login`, 'hana-login-x', '', tab.parent)): Promise<LoginRun> {
  const deadline = Date.now() + 4000;
  // The popup repeats its hello every 100 ms until the vault answers (it ignores hellos until the login is prepared).
  while (!popup.posted.some((p) => p.message.t === 'hana:auth-params')) {
    if (Date.now() > deadline) throw new Error('No auth-params');
    tab.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: popup });
    await new Promise((r) => setTimeout(r, 10));
  }
  return { popup, params: await popup.next('hana:auth-params') };
}

export function tokenClaims(params: Record<string, unknown>, over: Record<string, unknown> = {}, nowMs = START_MS): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return { iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, sub: SUB, iat: now, exp: now + 3600, nonce: params.nonce, jti: 'j1', ...over };
}

/** The callback: Google's answer, encrypted under the popup's relayKey, into the relay slot. */
export async function deliverToken(tab: Tab, g: Google, run: LoginRun, over: Record<string, unknown> = {}, nowMs?: number): Promise<string> {
  const token = await g.token(tokenClaims(run.params, over, nowMs ?? tab.browser.timers.now));
  await tab.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token });
  return token;
}

/** A whole partner-mode login: hana_login, the popup's hello, the token through the relay. */
export async function login(tab: Tab, g: Google, over: Record<string, unknown> = {}): Promise<{ reply: Reply; run: LoginRun; token: string }> {
  const pending = tab.request('hana_login');
  const run = await popupHello(tab);
  const token = await deliverToken(tab, g, run, over);
  return { reply: await pending, run, token };
}

export async function readyTab(browser: Browser, o: TabOptions = {}): Promise<Tab> {
  const tab = openTab(browser, o);
  tab.hello();
  await tab.ready();
  return tab;
}

/**
 * Waits until the launcher shows `label` (null: hidden) and the partner page has been told so: the vault sets its view
 * synchronously but the `ui` event crosses the port later, so a test that reads the events must wait for both.
 */
export async function waitLauncher(tab: Tab, label: string | null): Promise<void> {
  await tab.waitUntil(() => {
    if (tab.launcher.label !== label) return false;
    const ui = tab.events.filter((e) => e.event === 'ui').at(-1)?.data as { launcher: string; label: string } | undefined;
    return label === null ? ui === undefined || ui.launcher === 'hide' : ui?.launcher === 'show' && ui.label === label;
  }, `launcher ${label ?? 'hidden'}`);
}

// ---- the approval popup, as the auth page would run it ----

/** Clicks the launcher and connects the approval popup it opens. */
export function openApproval(tab: Tab): FakeWindow {
  tab.launcher.click();
  const popup = tab.opened.at(-1)!;
  tab.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: popup });
  return popup;
}

export function approveDigest(m: Record<string, unknown>): Uint8Array {
  return approvalDigest({
    id: m.id as string,
    kind: m.kind as never,
    chain: m.chain as 'stellar' | 'evm',
    address: m.address as string,
    parentOrigin: m.parentOrigin as string,
    context: m.context as never,
    bytes: m.bytes as Uint8Array,
  });
}

export function answer(tab: Tab, popup: FakeWindow, m: Record<string, unknown>, approved: boolean, digest: Uint8Array = approveDigest(m)): void {
  tab.dispatch({ data: { v: 1, t: 'hana:approve-result', id: m.id, approved, digest }, origin: ENV.authOrigin, source: popup });
}

export function answerConsent(tab: Tab, popup: FakeWindow, m: Record<string, unknown>, allowed: boolean): void {
  const digest = consentDigest({ id: m.id as string, policyId: m.policyId as string, parentOrigin: m.parentOrigin as string, expiresAtMs: m.expiresAtMs as number });
  tab.dispatch({ data: { v: 1, t: 'hana:consent-result', id: m.id, allowed, digest }, origin: ENV.authOrigin, source: popup });
}

export const relayIdOf = relayIdFor;
export const sleepReal = (ms: number) => new Promise((r) => setTimeout(r, ms));
