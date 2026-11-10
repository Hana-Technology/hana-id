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
  followSlot,
  type RelayPayload,
  fromUtf8,
  identityKeyHex,
  identityMessage,
  identityTokenPayload,
  relayIdFor,
  toHex,
  utf8,
  vaultMessage,
  vaultPayload,
  verifyEd25519,
  verifyWalletProof,
  walletProofsHash,
} from '@hana-id/core';
import { consentRegisterPayload, consentRevokePayload } from '@hana-id/core/home';
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

/** FakeBackend.abortedRelayReads: how many reads with an aborted signal it takes before it breaks such a loop. */
export const ABORTED_READS_CAP = 100;

// ---- timers ----

/** Delays up to this run on the next real tick (polls, backoffs); longer ones only when the test advances the clock. */
const WARP_MAX_MS = 5_000;

export class TestTimers implements Timers {
  /** The device clock (Date.now). Assigning it moves only this clock: a device clock set forward or back. */
  now = START_MS;
  /**
   * A monotonic clock (performance.now) for tabs opened with `fakePerf`; `advance` moves it with `now`. Assigning it
   * moves only it; leaving it while `now` moves is a device that slept (a monotonic timer that stopped).
   */
  perf = 1_000;
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
    this.perf += ms;
    for (;;) {
      const due = [...this.manual.entries()].filter(([, t]) => t.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) return;
      this.manual.delete(due[0]);
      due[1].fn();
    }
  }

  /** When each long timer still pending is due (a test checks one was armed, or cleared). */
  dueAt(): number[] {
    return [...this.manual.values()].map((t) => t.at).sort((x, y) => x - y);
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
  /** min(session end, now + TTL), as the API sets it: a consent may not end after it (D513). */
  absExpiresAtMs: number;
}

/** A row of the fake API's `vault_consents`. */
export interface FakeConsent {
  shareId: Uint8Array | null;
  sessionPk: Uint8Array;
  expiresAtMs: number;
  revoked: boolean;
}

export interface ApiCall {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

type Handler = (call: ApiCall) => Response | Promise<Response | undefined> | undefined;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export const apiError = (status: number, code: string, extra: Record<string, unknown> = {}): Response => json(status, { error: code, code, requestId: 'rq', ...extra });

/** The response headers every cross-origin page may read (Fetch's CORS-safelisted response-header names). */
const CORS_SAFELISTED = new Set(['cache-control', 'content-language', 'content-length', 'content-type', 'expires', 'last-modified', 'pragma']);

/**
 * A cross-origin response as the page's fetch sees it: a header that isn't safelisted is hidden unless the response
 * names it in `access-control-expose-headers` (as a browser does), so a test catches a server that forgets to expose one.
 */
export function corsView(res: Response): Response {
  const exposed = new Set((res.headers.get('access-control-expose-headers') ?? '').split(',').map((h) => h.trim().toLowerCase()));
  const headers = new Headers();
  res.headers.forEach((v, k) => {
    if (CORS_SAFELISTED.has(k) || exposed.has(k)) headers.set(k, v);
  });
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

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
  /** `get_config().shared_clients`: the shared Google client in force. */
  sharedClients: [string, string][] = [['google', CLIENT_ID]];
  /** RPC endpoints (origins) that fail every call with a network error. */
  readonly rpcDown = new Set<string>();
  /**
   * A lying (or stale) provider: per endpoint (origin), a view answer that differs from the chain's; `undefined` from
   * the function gives the honest answer.
   */
  readonly viewLies = new Map<string, (method: string, args: Record<string, unknown>) => unknown>();
  /** What GET /v1/app answers. */
  app: Record<string, unknown> = { scopeId: SCOPE, signer: ENV.signer, google: { clientId: CLIENT_ID, mode: 'shared' }, name: 'Partner' };
  /** The auto-approve policy in force that GET /v1/app answers: each new tab's page sets it (the page is current). */
  autoApprovePolicy: Record<string, unknown> | null = null;
  /** The raw-signing setting in force that GET /v1/app answers (each new tab's page sets it, as for the policy). */
  rawSign: 'off' | 'approval' = 'off';
  serverNow: () => number = () => START_MS;
  /** `vault_consents` (Hana Home), by consent id in hex. */
  readonly consents = new Map<string, FakeConsent>();
  /**
   * What GET /v1/app says about a consent when the vault names one: overrides the row's answer. `'omit'` leaves the
   * field out (a D1 failure, D511); any other value is sent as is (a value of an unknown shape).
   */
  consentAnswer: ((idHex: string) => unknown) | null = null;
  /** The same for `share` (the vault's `x-hana-share`): `'omit'` leaves it out (the API's D1 read failed). */
  shareAnswer: ((idHex: string) => unknown) | null = null;
  /** The API's own timings to answer /v1/login, /v1/vault/shares and /v1/vault/unlock with (a pk_test_ API), or none. */
  serverTimings: { totalMs: number; phases: Record<string, number> } | null = null;
  /** The relay read's `heldMs`, or none (an older API). */
  relayHeldMs: number | null = null;
  /** Batch C15: the `supportId` /v1/login and /v1/sessions answer with (any value, to test the vault's check), or none. */
  supportId: unknown = undefined;
  /** What the callback adds to the relay slot for a pk_test_ login (its own and /login's stage durations), or none. */
  popupTimings: Record<string, number> | null = null;
  /** The on-chain email keys (`get_issuer_keys("email")`) and signer policy (`get_self_issued("email")`), or none. */
  emailKeys: { kid: string; n: string; e: string }[] | null = null;
  emailPolicy: { provider: string; signers: { id: string; kids: string[] }[]; required: number; overlap_until_ms: null } | null = null;
  /** The identity tokens' lifetime this fake API mints with (seconds); the real one caps it at the session's end. */
  identityTtlS = 3600;
  /** D411: the mint's `emailStatus` (the vault keeps it as the session's consent state). */
  identityEmailStatus = 'off';
  /**
   * Accounts and links, as contract v3 keeps them (batches 7 and 8b): identities whose own path was derived (`opened`),
   * and accounts by root identity key, each with its members.
   */
  readonly opened = new Set<string>();
  readonly accounts = new Map<string, { root: { provider: string; sub: string }; members: { key: string; provider: string; sub: string; effective_at_ms: number; active: boolean; auto: boolean }[]; epoch: number; unlinked: string[] }>();
  /** `get_config().unrecorded_wallets` (links open only when it is false, D135). */
  unrecordedWallets = false;
  /** `change_delay_ms`: a pending link's wait. */
  changeDelayMs = 24 * HOUR;
  /** The email issuer's google-match: the test's answer for each call (the request is recorded), or a 503. */
  googleMatch: ((body: Record<string, unknown>) => Record<string, unknown> | Response) | null = null;
  readonly matchCalls: Record<string, unknown>[] = [];
  /**
   * The email issuer's google-record (token_first, D270): the test's answer (default `{accepted: true}`), a Response, or
   * a promise that never settles (a hung issuer). Each request is recorded.
   */
  googleRecord: (body: Record<string, unknown>) => Record<string, unknown> | Response | Promise<never> = () => ({ accepted: true });
  readonly recordCalls: Record<string, unknown>[] = [];
  /**
   * POST /v1/wallets/record (the wallet directory, D317): the test's answer (default `{recorded: true}`), a Response,
   * or a promise that never settles (a hung API). The requests are in `calls`.
   */
  walletRecord: (body: Record<string, unknown>, signal?: AbortSignal) => Record<string, unknown> | Response | Promise<never> = () => ({ recorded: true });
  /** POSTs to the login relay (the vault's follow-up notices, the popup's answers in tests). */
  readonly relayWrites: string[] = [];
  private txSeq = 0;
  private mintSeq = 0;
  private readonly relayWaiters = new Set<() => void>();
  /**
   * Relay reads sent with a signal that was already aborted. A browser's fetch rejects those at once, without a
   * request, so a poll loop that doesn't check its signal spins on microtasks and freezes the page; here the read
   * rejects at once too, and after ABORTED_READS_CAP of them it answers 410 instead, so such a loop ends (as
   * `token_invalid`) rather than hanging the test run.
   */
  abortedRelayReads = 0;

  count(path: string): number {
    return this.calls.filter((c) => c.path === path).length;
  }

  /** The account an identity key is in (as root or member), with its root key. */
  accountOf(key: string): { rootKey: string; account: NonNullable<ReturnType<FakeBackend['accounts']['get']>> } | null {
    for (const [rootKey, account] of this.accounts) if (rootKey === key || account.members.some((m) => m.key === key)) return { rootKey, account };
    return null;
  }

  /** Makes `member` a member of `root`'s account (pending until `effectiveAtMs` when not `active`). */
  link(root: { provider: string; sub: string }, member: { provider: string; sub: string }, o: { active?: boolean; effectiveAtMs?: number; auto?: boolean } = {}): void {
    const rootKey = identityKeyHex(SCOPE, root.provider, root.sub);
    const a = this.accounts.get(rootKey) ?? { root, members: [], epoch: 0, unlinked: [] };
    a.members.push({ key: identityKeyHex(SCOPE, member.provider, member.sub), provider: member.provider, sub: member.sub, effective_at_ms: o.effectiveAtMs ?? this.serverNow(), active: o.active ?? true, auto: o.auto ?? true });
    a.epoch += 1;
    this.accounts.set(rootKey, a);
  }

  /** `get_identity` as the contract answers it. */
  identityView(provider: string, sub: string): Record<string, unknown> {
    const key = identityKeyHex(SCOPE, provider, sub);
    const found = this.accountOf(key);
    const m = found?.account.members.find((x) => x.key === key);
    if (found && m) {
      return { key, status: m.active ? 'member' : 'pending', opened: this.opened.has(key), root: found.account.root, effective_at_ms: m.effective_at_ms, account_epoch: found.account.epoch };
    }
    return { key, status: 'own', opened: this.opened.has(key), account_epoch: found?.account.epoch ?? 0 };
  }

  accountView(provider: string, sub: string): Record<string, unknown> | null {
    const found = this.accountOf(identityKeyHex(SCOPE, provider, sub));
    if (!found) return null;
    const a = found.account;
    return { root: a.root, members: a.members.map(({ sub: _s, ...m }) => (void _s, m)), epoch: a.epoch, unlinked: a.unlinked };
  }

  /** The identity a token names (Google compact or email JWS JSON). */
  static tokenIdentity(jwt: string): { provider: 'google' | 'email'; sub: string } {
    const email = jwt.startsWith('{');
    const claims = JSON.parse(fromUtf8(base64UrlDecode(email ? (JSON.parse(jwt) as { payload: string }).payload : jwt.split('.')[1]!))) as { sub: string };
    return { provider: email ? 'email' : 'google', sub: claims.sub };
  }

  /** The contract's path identity for a session of `who` (an active member opens its root's path). */
  pathIdentityOf(who: { provider: string; sub: string }): { provider: string; sub: string } | 'pending' {
    const v = this.identityView(who.provider, who.sub);
    if (v.status === 'pending') return 'pending';
    return v.status === 'member' ? (v.root as { provider: string; sub: string }) : who;
  }

  /**
   * The contract's `auto_link` (the four cases, simplified): case A (the link identity has a wallet) joins the session
   * identity to its account at once; otherwise the link identity joins the session identity's account, at once or
   * pending. Returns an error reason, or null when linked.
   */
  autoLink(x: { provider: string; sub: string }, linkJwt: string, immediate: boolean): string | null {
    if (this.unrecordedWallets) return 'links_unavailable';
    const e = FakeBackend.tokenIdentity(linkJwt);
    const xKey = identityKeyHex(SCOPE, x.provider, x.sub);
    const eKey = identityKeyHex(SCOPE, e.provider, e.sub);
    const eFound = this.accountOf(eKey);
    const eHas = (eFound !== null && eFound.rootKey !== eKey) || this.opened.has(eKey);
    const xFound = this.accountOf(xKey);
    const xHas = (xFound !== null && xFound.rootKey !== xKey) || this.opened.has(xKey);
    if (xHas && eHas) return 'both_wallets';
    if (eHas) {
      if (!immediate) return 'link_mismatch';
      const root = eFound ? eFound.account.root : e;
      this.link(root, x, { active: true });
      return null;
    }
    const root = xFound ? xFound.account.root : x;
    this.link(root, e, immediate ? { active: true } : { active: false, effectiveAtMs: this.serverNow() + this.changeDelayMs });
    return null;
  }

  /** The vault's (or a test's) POST to a relay slot. */
  writeRelayValue(relayId: string, value: { iv: string; ct: string }): boolean {
    if (this.relay.has(relayId)) return false;
    this.relay.set(relayId, value);
    this.relayWrites.push(relayId);
    for (const w of [...this.relayWaiters]) w();
    return true;
  }

  /** Reads (and consumes) a slot a test plays the popup for, waiting up to 4 s. */
  async takeRelay(relayId: string): Promise<{ iv: string; ct: string }> {
    const deadline = Date.now() + 4000;
    for (;;) {
      const v = this.relay.get(relayId);
      if (v && v !== 'consumed') {
        this.relay.set(relayId, 'consumed');
        return v;
      }
      if (Date.now() > deadline) throw new Error(`Nothing in relay slot ${relayId.slice(0, 8)}…`);
      await new Promise((r) => setTimeout(r, 10));
    }
  }

  /** Writes the relay slot as the callback page would (encrypted under relayKey). */
  async writeRelay(relayId: string, relayKey: Uint8Array, payload: RelayPayload): Promise<void> {
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
    // The path identity, as contract v3 resolves it: the identity's own path, or its account root's (batch 7).
    const who = FakeBackend.tokenIdentity(body.jwt as string);
    const pi = this.pathIdentityOf(who);
    if (pi === 'pending') return { ok: false, reason: 'link_pending' };
    let path = `${SCOPE}#${pi.provider}#${pi.sub}#${body.keyIndex as number}`;
    if (typeof body.linkJwt === 'string') {
      const refused = this.autoLink(who, body.linkJwt, body.linkImmediate === true);
      if (refused) return { ok: false, reason: refused };
      const after = this.pathIdentityOf(who);
      if (after !== 'pending') path = `${SCOPE}#${after.provider}#${after.sub}#${body.keyIndex as number}`;
    }
    const session: ChainSession = { path, scope_id: SCOPE, expires_at_ms: body.expiresAtMs as number, max_uses: body.maxUses as number, used: derive ? 1 : 0 };
    this.sessions.set(pkHex, session);
    if (derive) this.opened.add(identityKeyHex(SCOPE, path.split('#')[1]!, path.split('#')[2]!));
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
    if (url.origin === 'https://issuer.test' && url.pathname === '/v1/email/google-match') {
      const b = body as Record<string, unknown>;
      this.matchCalls.push(b);
      if (!this.googleMatch) return corsView(apiError(503, 'unavailable'));
      const r = this.googleMatch(b);
      // The issuer is another origin: the vault reads only what its CORS exposes.
      return corsView(r instanceof Response ? r : json(200, r));
    }
    if (url.origin === 'https://issuer.test' && url.pathname === '/v1/email/google-record') {
      const b = body as Record<string, unknown>;
      this.recordCalls.push(b);
      const r = await this.googleRecord(b);
      return corsView(r instanceof Response ? r : json(200, r));
    }
    const call: ApiCall = { method: init?.method ?? 'GET', path: url.pathname, headers, body };
    this.calls.push(call);
    const override = this.overrides.get(url.pathname);
    if (override) {
      const r = await override(call);
      if (r) return r;
    }
    return this.route(call, url, init?.signal ?? undefined);
  };

  private supportIdField(): { supportId?: unknown } {
    return this.supportId === undefined ? {} : { supportId: this.supportId };
  }

  private async route(call: ApiCall, url: URL, signal?: AbortSignal): Promise<Response> {
    const b = call.body as Record<string, unknown>;
    if (call.path === '/v1/app') return json(200, { autoApprovePolicy: this.autoApprovePolicy, rawSign: this.rawSign, ...this.app, ...this.consentField(call.headers['x-hana-consent']), ...this.shareField(call.headers['x-hana-share']), serverTimeMs: this.serverNow(), ...this.timingsField(), requestId: 'rq' });
    if (call.path === '/v1/login') {
      const r = this.createSession(b, true);
      const nearTx = this.nextTx();
      if (!r.ok && r.reason === 'session_key_in_use') return apiError(409, 'session_exists', { nearTx: null });
      if (!r.ok && r.reason === 'link_pending') return apiError(409, 'link_pending');
      if (!r.ok && r.reason === 'links_unavailable') return apiError(409, 'links_unavailable');
      if (!r.ok) return apiError(422, 'link_refused', { reason: r.reason });
      this.txs.set(nearTx, r.result);
      return json(200, { result: r.result, session: { scope_id: SCOPE, expires_at_ms: b.expiresAtMs, max_uses: b.maxUses, used: 1 }, nearTx, ...this.timingsField(), ...this.supportIdField(), requestId: 'rq' });
    }
    if (call.path === '/v1/sessions') {
      const r = this.createSession(b, false);
      if (!r.ok) return apiError(409, 'session_exists');
      return json(200, { result: r.session, nearTx: this.nextTx(), ...this.supportIdField(), requestId: 'rq' });
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
    if (call.path === '/v1/sessions/revoke') {
      const s = this.sessions.get(toHex(Uint8Array.from(b.sessionPublicKey as number[])));
      if (!s) return apiError(409, 'no_session');
      if (b.counter !== s.used + 1) return apiError(409, 'bad_counter');
      (s as ChainSession & { revoked?: boolean }).revoked = true;
      this.sessions.delete(toHex(Uint8Array.from(b.sessionPublicKey as number[])));
      return json(200, { result: null, nearTx: this.nextTx(), requestId: 'rq' });
    }
    if (call.path === '/v1/link') {
      const n = FakeBackend.tokenIdentity(b.newJwt as string);
      const a = FakeBackend.tokenIdentity(b.accountJwt as string);
      const effectiveAtMs = this.serverNow() + this.changeDelayMs;
      this.link(a, n, { active: false, effectiveAtMs, auto: false });
      return json(200, { result: { effectiveAtMs }, nearTx: this.nextTx(), requestId: 'rq' });
    }
    if (call.path === '/v1/link/cancel' || call.path === '/v1/link/unlink') {
      for (const a of this.accounts.values()) {
        const i = a.members.findIndex((m) => m.key === b.memberKey);
        if (i >= 0) {
          a.members.splice(i, 1);
          a.epoch += 1;
          if (call.path === '/v1/link/unlink') a.unlinked.push(b.memberKey as string);
          return json(200, { result: null, nearTx: this.nextTx(), requestId: 'rq' });
        }
      }
      return apiError(422, 'contract_rejected', { reason: 'no_such_member' });
    }
    if (call.path.startsWith('/v1/login-relay/') && call.method === 'POST') {
      const relayId = call.path.slice('/v1/login-relay/'.length);
      return this.writeRelayValue(relayId, b as { iv: string; ct: string }) ? new Response(null, { status: 204 }) : apiError(409, 'relay_used');
    }
    if (call.path.startsWith('/v1/login-relay/')) {
      const relayId = call.path.slice('/v1/login-relay/'.length);
      const key = call.headers['x-hana-relay-key'];
      if (signal?.aborted) {
        this.abortedRelayReads += 1;
        if (this.abortedRelayReads > ABORTED_READS_CAP) return apiError(410, 'relay_gone');
        throw new DOMException('aborted', 'AbortError');
      }
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
    if (call.path === '/v1/identity/token') return this.identityToken(call);
    if (call.path === '/v1/wallets/record') {
      const r = await this.walletRecord(b, signal);
      return r instanceof Response ? r : json(200, { ...r, requestId: 'rq' });
    }
    if (call.path === '/v1/vault/consents' || call.path === '/v1/vault/consents/revoke') return this.consentCall(call, call.path === '/v1/vault/consents');
    if (call.path === '/v1/vault/shares') return this.createShare(call);
    if (call.path === '/v1/vault/share-status') return this.shareStatusCall(call);
    if (call.path.startsWith('/v1/vault/')) return this.shareAction(call, call.path.slice('/v1/vault/'.length));
    void url;
    return apiError(404, 'not_found');
  }

  private timingsField(): { timings?: unknown } {
    return this.serverTimings ? { timings: structuredClone(this.serverTimings) } : {};
  }

  /**
   * POST /v1/identity/token as the API judges it, in short: the session proof (signature, ±60 s), a live chain session,
   * an unrevoked share in 'session' mode, both wallet proofs. The token is a fake ES256 JWS: its payload has `iat`, `exp`
   * and a mint number `n`; the vault only reads `iat`.
   */
  private async identityToken(call: ApiCall): Promise<Response> {
    const b = call.body as { sessionPublicKey: number[]; issuedAtMs: number; nonce: number[]; signature: number[]; walletProofs: Record<'stellar' | 'evm', { address: string; signature: number[] }>; sealedEmail?: string };
    const pk = Uint8Array.from(b.sessionPublicKey);
    const proofs = {
      stellar: { address: b.walletProofs.stellar.address, signature: Uint8Array.from(b.walletProofs.stellar.signature) },
      evm: { address: b.walletProofs.evm.address, signature: Uint8Array.from(b.walletProofs.evm.signature) },
    };
    if (Math.abs(this.serverNow() - b.issuedAtMs) > 60_000) return apiError(400, 'stale_proof', { serverTimeMs: this.serverNow() });
    const payload = identityTokenPayload({ parentOrigin: call.headers['x-hana-parent-origin'] ?? '', walletProofsHash: walletProofsHash(proofs), sealedEmail: b.sealedEmail ?? null });
    const msg = identityMessage({ signer: ENV.signer, appId: APP_ID, sessionPublicKey: pk, issuedAtMs: b.issuedAtMs, nonce: Uint8Array.from(b.nonce), payload });
    if (!(await verifyEd25519(pk, Uint8Array.from(b.signature), msg))) return apiError(401, 'invalid_signature');
    const share = [...this.shares.values()].find((s) => toHex(s.sessionPk) === toHex(pk));
    if (share?.revoked) return apiError(410, 'session_ended', { reason: 'share_revoked' });
    if (!this.sessions.has(toHex(pk))) return apiError(410, 'session_ended', { reason: 'no_session' });
    for (const chain of ['stellar', 'evm'] as const) {
      if (verifyWalletProof({ signer: ENV.signer, appId: APP_ID, sessionPublicKey: pk }, chain, proofs[chain]) === null) return apiError(400, 'bad_wallet_proof', { chain });
    }
    const iat = Math.floor(this.serverNow() / 1000);
    const exp = iat + this.identityTtlS;
    this.mintSeq += 1;
    const part = (o: unknown) => base64UrlEncode(utf8(JSON.stringify(o)));
    const identityToken = `${part({ alg: 'ES256', kid: 'k'.repeat(43), typ: 'hana-identity+jwt' })}.${part({ iat, exp, n: this.mintSeq, wallets: [proofs.stellar.address, proofs.evm.address] })}.${'A'.repeat(86)}`;
    return json(200, { identityToken, expiresAtMs: exp * 1000, emailStatus: this.identityEmailStatus, requestId: 'rq' });
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
    this.shares.set(toHex(shareId), { shareId, ks, sessionPk: pk, appId: APP_ID, counter: 0, revoked: false, createdAt: this.serverNow(), absExpiresAtMs: session.expires_at_ms });
    return json(201, { shareId: Array.from(shareId), ks: Array.from(ks), absExpiresAtMs: session.expires_at_ms, idleUntilMs: this.serverNow() + 2 * HOUR, ...this.timingsField(), requestId: 'rq' });
  }

  /**
   * Whether the fake API has POST /v1/vault/share-status. `'old'`: an API older than it, as a browser sees it (the
   * unknown route's answer has no CORS headers, so the preflight fails and fetch rejects with a TypeError);
   * `'old-readable'`: the same API's `404 not_found`, readable (same origin).
   */
  shareStatusEndpoint: true | 'old' | 'old-readable' = true;

  /**
   * POST /v1/vault/share-status (D690), as the API answers it: `{share}` for the share named, no chain call. `shareAnswer`
   * applies as on GET /v1/app; its `'omit'` (the D1 read failed) is the endpoint's 503.
   */
  private shareStatusCall(call: ApiCall): Response {
    if (this.shareStatusEndpoint === 'old') throw new TypeError('Failed to fetch');
    if (this.shareStatusEndpoint === 'old-readable') return apiError(404, 'not_found');
    const b = call.body as { shareId?: unknown };
    if (!b || !Array.isArray(b.shareId) || b.shareId.length !== 16 || Object.keys(b).length !== 1) return apiError(400, 'bad_request');
    const hex = toHex(Uint8Array.from(b.shareId as number[]));
    const answered = this.shareAnswer?.(hex);
    if (answered === 'omit') return apiError(503, 'share_status_unavailable');
    if (answered !== undefined) return json(200, { share: answered, serverTimeMs: this.serverNow(), requestId: 'rq' });
    const share = this.shares.get(hex);
    return json(200, { share: !share || share.revoked ? 'revoked' : 'live', serverTimeMs: this.serverNow(), requestId: 'rq' });
  }

  /** `share` on GET /v1/app, for the vault's `x-hana-share` header (H9): 'revoked' for a revoked or unknown share. */
  private shareField(header: string | undefined): { share?: unknown } {
    if (header === undefined) return {};
    const hex = toHex(base64UrlDecode(header));
    const answered = this.shareAnswer?.(hex);
    if (answered === 'omit') return {};
    if (answered !== undefined) return { share: answered };
    const share = this.shares.get(hex);
    return { share: !share || share.revoked ? 'revoked' : 'live' };
  }

  /** `consent` on GET /v1/app, for the vault's `x-hana-consent` header. */
  private consentField(header: string | undefined): { consent?: unknown } {
    if (header === undefined) return {};
    const hex = toHex(base64UrlDecode(header));
    const answered = this.consentAnswer?.(hex);
    if (answered === 'omit') return {};
    return { consent: answered ?? this.consentStatusOf(hex) };
  }

  /** As the API's consentStatus: `'unknown'` for no row, `'revoked'` for a stopped or expired consent or a dead share. */
  consentStatusOf(hex: string): 'active' | 'revoked' | 'unknown' {
    const c = this.consents.get(hex);
    if (!c) return 'unknown';
    if (c.revoked || this.serverNow() >= c.expiresAtMs) return 'revoked';
    if (!c.shareId) return 'active';
    const share = this.shares.get(toHex(c.shareId));
    return !share || share.revoked ? 'revoked' : 'active';
  }

  /** POST /v1/vault/consents and /revoke, as the API judges them in short: a signature over the vault message, the counter in order, a repeated id refused. */
  private async consentCall(call: ApiCall, register: boolean): Promise<Response> {
    const b = call.body as { shareId?: number[]; sessionPublicKey: number[]; counter: number; signature: number[]; consentId: number[]; policyId?: number[]; expiresAtMs?: number };
    // As the API's `toBody`: exactly these keys, and a counter that fits the mode.
    const keys = ['sessionPublicKey', 'counter', 'signature', 'consentId', ...(register ? ['policyId', 'expiresAtMs'] : []), ...('shareId' in b ? ['shareId'] : [])];
    if (Object.keys(b).length !== keys.length || !keys.every((k) => k in b)) return apiError(400, 'bad_request');
    if ('shareId' in b ? b.counter < 1 : b.counter !== 0) return apiError(400, 'bad_request');
    const pk = Uint8Array.from(b.sessionPublicKey);
    const consentId = Uint8Array.from(b.consentId);
    const hex = toHex(consentId);
    const shareId = b.shareId ? Uint8Array.from(b.shareId) : null;
    const payload = register ? consentRegisterPayload({ consentId, policyId: Uint8Array.from(b.policyId!), expiresAtMs: b.expiresAtMs!, parentOrigin: call.headers['x-hana-parent-origin'] ?? '' }) : consentRevokePayload(consentId);
    const msg = vaultMessage({ signer: ENV.signer, appId: APP_ID, shareId: shareId ?? new Uint8Array(16), counter: b.counter, payload });
    if (!(await verifyEd25519(pk, Uint8Array.from(b.signature), msg))) return apiError(401, 'invalid_signature');
    const share = shareId ? this.shares.get(toHex(shareId)) : undefined;
    if (shareId) {
      if (!share || toHex(share.sessionPk) !== toHex(pk)) return apiError(404, 'unknown_share');
      if (share.revoked) return apiError(410, 'session_ended', { reason: 'share_revoked' });
      if (register && b.expiresAtMs! > share.absExpiresAtMs) return apiError(400, 'bad_expiry', { maxExpiresAtMs: share.absExpiresAtMs });
      if (register ? this.consents.has(hex) : false) return apiError(409, 'consent_exists');
      if (b.counter !== share.counter + 1) return apiError(409, 'bad_counter', { expected: share.counter + 1 });
      share.counter = b.counter;
    } else if (register && this.consents.has(hex)) {
      return apiError(409, 'consent_exists');
    }
    if (register) {
      for (const c of this.consents.values()) if (toHex(c.sessionPk) === toHex(pk)) c.revoked = true;
      this.consents.set(hex, { shareId, sessionPk: pk, expiresAtMs: b.expiresAtMs!, revoked: false });
      return json(201, { counter: b.counter, grantedAtMs: this.serverNow(), expiresAtMs: b.expiresAtMs, requestId: 'rq' });
    }
    const row = this.consents.get(hex);
    if (!row || toHex(row.sessionPk) !== toHex(pk)) return apiError(404, 'unknown_consent');
    const was = row.revoked;
    row.revoked = true;
    return json(200, { revoked: !was, counter: b.counter, requestId: 'rq' });
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
      const lie = this.viewLies.get(endpoint)?.(body.params.method_name as string, args);
      if (lie !== undefined) return answer(lie);
      if (body.params.method_name === 'get_scope') return answer(this.scopes.get(args.scope_id as string) ?? null);
      if (body.params.method_name === 'scope_for_client') return answer(this.clientScopes.get(`${args.provider as string}|${args.aud as string}`) ?? null);
      if (body.params.method_name === 'get_config') return answer({ shared_clients: this.sharedClients, pending_shared_clients: [], unrecorded_wallets: this.unrecordedWallets });
      if (body.params.method_name === 'get_identity') return answer(this.identityView(args.provider as string, args.sub as string));
      if (body.params.method_name === 'get_account') return answer(this.accountView(args.provider as string, args.sub as string));
      if (body.params.method_name === 'get_issuer_keys') return answer(args.provider === 'email' ? this.emailKeys : null);
      if (body.params.method_name === 'get_self_issued') return answer(args.provider === 'email' ? this.emailPolicy : null);
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
  hello(opts?: { origin?: string; source?: unknown; ports?: MessagePort[]; sdk?: string }): void;
  ready(): Promise<Record<string, unknown>>;
  /** `extra`: envelope fields beside the params (`popupOpened: true`, D99). */
  request(method: string, params?: unknown, extra?: Record<string, unknown>): Promise<Reply>;
  waitEvent(event: PortEventName, n?: number): Promise<unknown>;
  /** Waits until `check` is true, re-checking on every port message (and every 20 ms), for up to 4 s of real time. */
  waitUntil(check: () => boolean, what: string): Promise<void>;
  /** The tab is hidden or shown (document.visibilityState), with its `visibilitychange` event. */
  setVisibility(state: 'visible' | 'hidden'): void;
  /** A back/forward-cache restore: `pageshow` with `persisted` (no visibilitychange). */
  pageRestore(): void;
  close(): void;
}

let idSeq = 0;

export interface TabOptions {
  config?: VaultConfig;
  env?: HanaEnv;
  ancestorOrigin?: string;
  /** location.ancestorOrigins as a whole (parent first). */
  ancestorOrigins?: string[];
  loginFlow?: 'combined' | 'split';
  googleJwk?: Google['jwk'];
  options?: Partial<VaultOptions>;
  /** The vault document's navigation timing (unlock timings' `vault*` stages). */
  navigation?: NavigationMarks;
  /** The SDK version the tab's hello names (default '0.0.0': an SDK before every versioned field, e.g. supportId). */
  sdk?: string;
  /** The tab starts hidden (document.visibilityState; `Tab.setVisibility` changes it). */
  hidden?: boolean;
  /** A host without visibility (an older host, or a browser without the Page Visibility API): counts as shown. */
  noVisibility?: boolean;
  /** The vault's monotonic clock is `browser.timers.perf` (default: the real performance.now). */
  fakePerf?: boolean;
}

export function openTab(browser: Browser, o: TabOptions = {}): Tab {
  const parent = new FakeWindow('partner', '', '', null);
  const launcher = new FakeLauncherView();
  const opened: FakeWindow[] = [];
  const listeners: ((e: WindowMessageEvent) => void)[] = [];
  let visibility: 'visible' | 'hidden' = o.hidden ? 'hidden' : 'visible';
  const visibilityListeners: (() => void)[] = [];
  const restoreListeners: (() => void)[] = [];
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
      ancestorOrigins: () => o.ancestorOrigins,
      onMessage: (l) => listeners.push(l),
      open: (url, name, features) => {
        const w = new FakeWindow(url, name, features, null);
        opened.push(w);
        return w;
      },
      navigationTiming: () => o.navigation ?? null,
      ...(o.noVisibility ? {} : { visibility: () => visibility, onVisibilityChange: (l: () => void) => visibilityListeners.push(l), onPageRestore: (l: () => void) => restoreListeners.push(l) }),
    },
    openStore: browser.openStore,
    locks: browser.locks,
    channel: (name) => browser.bus.channel(name),
    launcherView: launcher,
    fetch: browser.backend.fetch,
    timers: browser.timers,
    deviceNow: () => browser.timers.now,
    ...(o.fakePerf ? { perfNow: () => browser.timers.perf } : {}),
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
      tab.dispatch({ data: { v: 1, t: 'hana:hello', sdk: h.sdk ?? o.sdk ?? '0.0.0' }, origin: h.origin ?? PARTNER, source: h.source ?? parent, ports: h.ports ?? [port2] });
    },
    ready: async () => (await waitFor(() => events.find((e) => e.event === 'ready'), 'ready')).data as Record<string, unknown>,
    request: (method, params, extra) => {
      idSeq += 1;
      const id = `r${idSeq}`;
      port1.postMessage({ ...(params === undefined ? { v: 1, id, method } : { v: 1, id, method, params }), ...extra });
      return waitFor(() => replies.find((r) => r.id === id), `reply to ${method}`, 8000);
    },
    waitEvent: async (event, n = 0) => (await waitFor(() => events.filter((e) => e.event === event)[n], `event ${event}`)).data,
    waitUntil: async (check, what) => {
      await waitFor(() => (check() ? true : undefined), what);
    },
    setVisibility: (state) => {
      visibility = state;
      for (const l of visibilityListeners) l();
    },
    pageRestore: () => {
      for (const l of restoreListeners) l();
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
  const relayKey = run.params.relayKey as Uint8Array;
  if (run.params.emailRecord === true) {
    // token_first's record-only login (an app without email login, D269, D270): the callback relays the access token
    // to follow-up slot 1, then the openid ID token with `access: 'follow'` (auth/callback-page.ts).
    const { id } = followSlot(run.params.followKey as Uint8Array, 1);
    tab.browser.backend.writeRelayRaw(id, await encryptRelayPayload(relayKey, id, { accessToken: ACCESS_TOKEN }));
    await tab.browser.backend.writeRelay(run.params.relayId as string, relayKey, { idToken: token, access: 'follow' });
    return token;
  }
  // A login of an app with email (batch 8b): the access token beside the ID token, a relay format the vault still
  // reads (D273; the popups send it in slot 1 instead, as the follow-up tests do).
  const extra = run.params.followKey ? { accessToken: ACCESS_TOKEN } : {};
  await tab.browser.backend.writeRelay(run.params.relayId as string, relayKey, { idToken: token, ...extra });
  return token;
}

/** The Google access token the tests' popup relays for google-match (never a real one). */
export const ACCESS_TOKEN = 'ya29.test-access-token';

// ---- email login (build plan batch 8a) ----

export const EMAIL_ISSUER = 'https://issuer.test';
export const EMAIL_ISS = `${EMAIL_ISSUER}/v1/email`;
export const EMAIL_SUB = `e1.${'Q'.repeat(43)}`;
/** The env with an email issuer pinned. */
export const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: EMAIL_ISSUER, emailIss: EMAIL_ISS });

export interface EmailIssuer {
  kid: string;
  chainKey: { kid: string; n: string; e: string };
  /** A token as Hana's issuer writes it: JWS General JSON, one RS256 signature. */
  token(claims: Record<string, unknown>): Promise<string>;
}

export async function emailIssuer(kid = 'email-kid-1'): Promise<EmailIssuer> {
  const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
  const pub = await crypto.subtle.exportKey('jwk', pair.publicKey);
  const b64 = (v: unknown) => base64UrlEncode(utf8(JSON.stringify(v)));
  return {
    kid,
    chainKey: { kid, n: pub.n as string, e: pub.e as string },
    async token(claims) {
      const payload = b64(claims);
      const protectedHeader = b64({ alg: 'RS256', kid });
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, utf8(`${protectedHeader}.${payload}`)));
      return JSON.stringify({ payload, signatures: [{ protected: protectedHeader, signature: base64UrlEncode(sig) }] });
    },
  };
}

/** Turns email on for the backend: GET /v1/app offers it, the scope holds `email:<scope>`, the chain lists the key. */
export function enableEmail(backend: FakeBackend, issuer: EmailIssuer): void {
  backend.app = { ...backend.app, loginMethods: ['google', 'email'], email: { aud: `email:${SCOPE}` } };
  backend.clientScopes.set(`email|email:${SCOPE}`, SCOPE);
  backend.emailKeys = [issuer.chainKey];
  backend.emailPolicy = { provider: 'email', signers: [{ id: 'hana', kids: [issuer.kid] }], required: 1, overlap_until_ms: null };
  // google-match: no email identity matches (case C) unless a test says otherwise.
  backend.googleMatch = () => ({ decision: 'none', googleHosted: true, linkable: true });
}

export function emailClaims(params: Record<string, unknown>, over: Record<string, unknown> = {}, nowMs = START_MS): Record<string, unknown> {
  const now = Math.floor(nowMs / 1000);
  return { iss: EMAIL_ISS, aud: `email:${SCOPE}`, sub: EMAIL_SUB, iat: now, exp: now + 600, nonce: params.nonce, jti: 'jti-email-1', ...over };
}

/** /login/email: the issuer's token, encrypted under the popup's relayKey, into the relay slot. */
export async function deliverEmailToken(tab: Tab, issuer: EmailIssuer, run: LoginRun, over: Record<string, unknown> = {}): Promise<string> {
  const token = await issuer.token(emailClaims(run.params, over, tab.browser.timers.now));
  await tab.browser.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token });
  return token;
}

/**
 * Waits until the tab's background persist (the share and record made after a login was reported, D79) has settled.
 * Tests that look at the record, the share or the next reload right after a login wait for it.
 */
export async function persisted(tab: Tab): Promise<void> {
  const session = (tab.vault as unknown as { session: { persist: { done: Promise<void> } | null } | null }).session;
  await session?.persist?.done;
}

/** A whole partner-mode login: hana_login, the popup's hello, the token through the relay; then its persist settles. */
export async function login(tab: Tab, g: Google, over: Record<string, unknown> = {}): Promise<{ reply: Reply; run: LoginRun; token: string }> {
  const pending = tab.request('hana_login');
  const run = await popupHello(tab);
  const token = await deliverToken(tab, g, run, over);
  const reply = await pending;
  await persisted(tab);
  return { reply, run, token };
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

/**
 * An approval popup the partner page opened in the user's click (D99): `/approve?from=partner&v=…`, its opener the
 * partner window, saying hello to the vault.
 */
export function partnerApproval(tab: Tab, opener: unknown = tab.parent): FakeWindow {
  const popup = new FakeWindow(`${ENV.authOrigin}/approve?from=partner&v=hana-vault-x`, 'hana-approve-p', 'popup,width=420,height=680', opener);
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
