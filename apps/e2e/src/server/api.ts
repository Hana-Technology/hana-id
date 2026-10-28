// The mocked Hana API (docs/batch-b-spec.md "API changes"): the endpoints the vault, the login popup, the callback and
// the export window call, with the same origin rule as appGate for Hana origins (the caller's `Origin` and
// `x-hana-parent-origin`, checked with apps/api's own parentOriginAllowed), the same error codes, and state kept per
// run: apps in D1 (d1.ts), sessions and transactions on the mocked chain (chain.ts), shares and relay slots here.
//
// It is a test double: it checks every signature (session messages, vault messages) and the session nonce, but not the
// Google token's RS256 signature (the vault does; the API's own check has its own tests in apps/api).
//
// Control endpoints for the tests (`/__e2e/*`, no CORS, so no page can call them):
//   POST /__e2e/apps                  {name?, scopeId?, origins, status?, settings?} → {appId, pk}
//   POST /__e2e/apps/<pk>/revoke      every share of the app is revoked (an unlock then gets 410 share_revoked)
//   GET  /__e2e/apps/<pk>/shares      [{counter, revoked, partnerOrigin}]
//   GET  /__e2e/health
import {
  RELAY_ID_PATTERN,
  base64UrlDecode,
  ckdPayload,
  fromUtf8,
  relayIdFor,
  sessionMessage,
  sessionNonce,
  sha256,
  toHex,
  utf8,
  vaultMessage,
  vaultPayload,
  verifyEd25519,
} from '@hana-id/core';
import { base58 } from '@scure/base';
import { AUTH_ORIGIN, E2E_ENV, ENV_NAME, GOOGLE_CLIENT_ID, VAULT_ORIGIN } from '../stack.ts';
import type { ApiApp, ApiModules } from './api-modules.ts';
import { type Chain, mpcAnswer } from './chain.ts';
import type { D1Shim } from './d1.ts';
import { json } from './http.ts';

const RELAY_TTL_MS = 120_000;
const RELAY_MAX_BODY = 8 * 1024;
const RELAY_WAIT_MAX_S = 25;
const FRESH_SHARE_MS = 5 * 60_000;
const KEY_INDEX_LIMIT = 0x8000_0000;

type Body = Record<string, unknown>;

interface Share {
  shareId: Uint8Array;
  appId: string;
  sessionPk: Uint8Array;
  pathHash: string;
  partnerOrigin: string;
  ks: Uint8Array;
  counter: number;
  createdAt: number;
  idleUntil: number;
  absExpiresAt: number;
  revoked: boolean;
}

type Slot = { kind: 'value'; iv: string; ct: string } | { kind: 'consumed' } | { kind: 'expired' };

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly extra: Body = {},
  ) {
    super(code);
  }
}

const isBytes = (v: unknown, len?: number): v is number[] =>
  Array.isArray(v) && (len === undefined || v.length === len) && v.every((b) => Number.isInteger(b) && b >= 0 && b <= 255);
const isObj = (v: unknown): v is Body => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => Number.isSafeInteger(v);
const bytes = (v: number[]): Uint8Array => Uint8Array.from(v);

export interface AppSpec {
  name?: string;
  scopeId?: string;
  origins: string[];
  status?: 'active' | 'suspended';
  settings?: { persistence?: 'session' | 'none'; rawSign?: 'off' | 'approval'; autoApprovePolicy?: Body | null };
}

export class MockApi {
  readonly shares = new Map<string, Share>();
  private readonly relay = new Map<string, Slot>();
  private readonly relayWaiters = new Map<string, Set<() => void>>();
  private seq = 0;
  private requests = 0;

  constructor(
    private readonly d1: D1Shim,
    private readonly chain: Chain,
    private readonly api: ApiModules,
  ) {}

  // ---- apps (D1 rows, read back by apps/api's own queries) ----

  createApp(spec: AppSpec): { appId: string; pk: string } {
    this.seq += 1;
    const appId = `app_e2e_${this.seq}_${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
    const pk = `pk_test_${base58.encode(crypto.getRandomValues(new Uint8Array(16)))}`;
    const s = spec.settings ?? {};
    this.d1.db
      .prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, persistence, raw_sign, auto_approve_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(appId, spec.name ?? 'E2E Partner', spec.scopeId ?? 'e2e', pk, spec.status ?? 'active', s.persistence ?? 'session', s.rawSign ?? 'off', s.autoApprovePolicy ? JSON.stringify(s.autoApprovePolicy) : null);
    const insert = this.d1.db.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?, ?)');
    for (const o of spec.origins) insert.run(appId, o);
    return { appId, pk };
  }

  private async app(pk: string | null): Promise<ApiApp> {
    if (!pk) throw new HttpError(401, 'missing_key');
    const app = await this.api.getAppByKey(this.d1, pk);
    if (!app) throw new HttpError(401, 'unknown_app');
    if (app.status !== 'active') throw new HttpError(403, 'app_suspended');
    if (app.scope_conflict) throw new HttpError(403, 'scope_conflict');
    return app;
  }

  private async settings(app: ApiApp): Promise<{ persistence: string; session_ttl_ms: number; idle_ttl_ms: number; policy: Body | null }> {
    const row = await this.api.getSettingsRow(this.d1, app.id);
    if (!row) throw new HttpError(401, 'unknown_app');
    const effective = await this.api.effectiveSettings(row, app.id, Date.now());
    return { persistence: String(row.persistence), session_ttl_ms: Number(row.session_ttl_ms), idle_ttl_ms: Number(row.idle_ttl_ms), policy: effective.autoApprovePolicy };
  }

  /**
   * appGate's origin rule for this mock: a Hana origin from `callers` must name a parent the app allows; a partner
   * origin is accepted only where `partnerOk` (GET /v1/app), and only if the app lists it.
   */
  private async gate(req: Request, callers: readonly string[], partnerOk = false): Promise<{ app: ApiApp; parentOrigin: string }> {
    const app = await this.app(req.headers.get('x-hana-key'));
    const origin = req.headers.get('origin');
    if (origin !== null && callers.includes(origin)) {
      const parent = req.headers.get('x-hana-parent-origin');
      if (!this.api.parentOriginAllowed(ENV_NAME, app, parent)) throw new HttpError(403, 'origin_not_allowed');
      return { app, parentOrigin: parent as string };
    }
    if (partnerOk && origin !== null && this.api.parentOriginAllowed(ENV_NAME, app, origin)) return { app, parentOrigin: origin };
    throw new HttpError(403, 'origin_not_allowed');
  }

  revokeApp(pk: string): number {
    let n = 0;
    const appId = this.d1.db.prepare('SELECT id FROM apps WHERE publishable_key = ?').get(pk)?.id;
    for (const s of this.shares.values()) {
      if (s.appId === appId && !s.revoked) {
        s.revoked = true;
        n += 1;
      }
    }
    return n;
  }

  // ---- HTTP ----

  async handle(req: Request, signal: AbortSignal): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__e2e/')) return this.control(req, url);
    const origin = req.headers.get('origin');
    const cors = this.cors(origin, url.pathname);
    if (req.method === 'OPTIONS') return new Response(null, { status: cors ? 204 : 403, headers: cors ?? {} });
    const requestId = `rq_${(this.requests += 1)}`;
    try {
      const res = await this.route(req, url, signal);
      const out = new Response(res.body, res);
      for (const [k, v] of Object.entries(cors ?? {})) out.headers.set(k, v);
      out.headers.set('x-request-id', requestId);
      return out;
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return json(e.status, { error: e.code, code: e.code, requestId, ...e.extra }, { ...(cors ?? {}), 'x-request-id': requestId });
    }
  }

  /** CORS: the two Hana origins everywhere; a partner origin only on GET /v1/app (as the real API). */
  private cors(origin: string | null, path: string): Record<string, string> | null {
    if (origin === null) return null;
    if (origin !== VAULT_ORIGIN && origin !== AUTH_ORIGIN && path !== '/v1/app') return null;
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type, accept, x-hana-key, x-hana-parent-origin, x-hana-relay-key',
      'access-control-expose-headers': 'x-request-id, retry-after',
      'access-control-max-age': '600',
      vary: 'origin',
    };
  }

  private async body(req: Request): Promise<Body> {
    let v: unknown;
    try {
      v = await req.json();
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    if (!isObj(v)) throw new HttpError(400, 'bad_request');
    return v;
  }

  private async route(req: Request, url: URL, signal: AbortSignal): Promise<Response> {
    const p = url.pathname;
    if (p === '/v1/app' && req.method === 'GET') return this.getApp(req);
    if (p === '/v1/login' && req.method === 'POST') return this.login(req);
    if (p === '/v1/derive' && req.method === 'POST') return this.derive(req);
    if (p.startsWith('/v1/login-relay/')) {
      const relayId = p.slice('/v1/login-relay/'.length);
      if (!RELAY_ID_PATTERN.test(relayId)) throw new HttpError(400, 'bad_relay_id');
      if (req.method === 'POST') return this.relayWrite(req, relayId);
      if (req.method === 'GET') return this.relayRead(req, url, relayId, signal);
    }
    if (p === '/v1/vault/shares' && req.method === 'POST') return this.createShare(req);
    const action = /^\/v1\/vault\/(unlock|touch|revoke|revoke-all)$/u.exec(p)?.[1];
    if (action && req.method === 'POST') return this.shareAction(req, action as 'unlock' | 'touch' | 'revoke' | 'revoke-all');
    throw new HttpError(404, 'not_found');
  }

  private async getApp(req: Request): Promise<Response> {
    const { app } = await this.gate(req, [VAULT_ORIGIN, AUTH_ORIGIN], true);
    const s = await this.settings(app);
    return json(200, {
      scopeId: app.scope_id,
      signer: E2E_ENV.signer,
      google: { clientId: app.google_web_client_id ?? GOOGLE_CLIENT_ID, mode: 'shared' },
      name: app.name,
      autoApprovePolicy: s.policy,
      serverTimeMs: Date.now(),
    });
  }

  // ---- /v1/login, /v1/derive (the chain side is chain.ts) ----

  private async login(req: Request): Promise<Response> {
    const { app } = await this.gate(req, [VAULT_ORIGIN, AUTH_ORIGIN]);
    const b = await this.body(req);
    if (
      typeof b.jwt !== 'string' ||
      !isBytes(b.sessionPublicKey, 32) ||
      !isInt(b.expiresAtMs) ||
      !isBytes(b.salt) ||
      !isInt(b.keyIndex) ||
      !isInt(b.maxUses) ||
      !isBytes(b.signature, 64) ||
      typeof b.pk1 !== 'string' ||
      typeof b.pk2 !== 'string'
    ) {
      throw new HttpError(400, 'bad_request');
    }
    if (b.keyIndex < 0 || b.keyIndex >= KEY_INDEX_LIMIT) throw new HttpError(400, 'bad_request');
    let claims: { sub?: unknown; nonce?: unknown };
    try {
      claims = JSON.parse(fromUtf8(base64UrlDecode(b.jwt.split('.')[1] ?? ''))) as typeof claims;
    } catch {
      throw new HttpError(401, 'token_invalid');
    }
    const sessionPublicKey = bytes(b.sessionPublicKey);
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: app.scope_id, sessionPublicKey, expiresAtMs: b.expiresAtMs, keyIndex: b.keyIndex, maxUses: b.maxUses, salt: bytes(b.salt) });
    if (claims.nonce !== nonce || typeof claims.sub !== 'string') throw new HttpError(401, 'token_invalid');
    if (this.chain.session(sessionPublicKey)) throw new HttpError(409, 'session_exists');
    if (!(await verifyEd25519(sessionPublicKey, bytes(b.signature), sessionMessage(1, ckdPayload(b.pk1, b.pk2))))) throw new HttpError(401, 'invalid_signature');
    const session = { path: `${app.scope_id}#google#${claims.sub}#${b.keyIndex}`, scope_id: app.scope_id, expires_at_ms: b.expiresAtMs, max_uses: b.maxUses, used: 1 };
    this.chain.sessions.set(toHex(sessionPublicKey), session);
    const result = mpcAnswer(b.pk1, session.path);
    const nearTx = this.chain.newTxHash();
    this.chain.txs.set(nearTx, result);
    return json(200, { result, session: { scope_id: session.scope_id, expires_at_ms: session.expires_at_ms, max_uses: session.max_uses, used: 1 }, nearTx });
  }

  private async derive(req: Request): Promise<Response> {
    await this.gate(req, [VAULT_ORIGIN]);
    const b = await this.body(req);
    if (!isBytes(b.sessionPublicKey, 32) || !isInt(b.counter) || !isBytes(b.signature, 64) || typeof b.pk1 !== 'string' || typeof b.pk2 !== 'string') {
      throw new HttpError(400, 'bad_request');
    }
    const s = this.chain.session(bytes(b.sessionPublicKey));
    if (!s) throw new HttpError(409, 'no_session');
    if (b.counter !== s.used + 1 || s.used >= s.max_uses) throw new HttpError(409, 'bad_counter', { nextCounter: s.used + 1 });
    if (!(await verifyEd25519(bytes(b.sessionPublicKey), bytes(b.signature), sessionMessage(b.counter, ckdPayload(b.pk1, b.pk2))))) {
      throw new HttpError(401, 'invalid_signature');
    }
    s.used += 1;
    const result = mpcAnswer(b.pk1, s.path);
    const nearTx = this.chain.newTxHash();
    this.chain.txs.set(nearTx, result);
    return json(200, { result, nearTx });
  }

  // ---- the login relay (docs/batch-b-spec.md "Relay Durable Object") ----

  private wake(relayId: string): void {
    for (const w of this.relayWaiters.get(relayId) ?? []) w();
  }

  private async relayWrite(req: Request, relayId: string): Promise<Response> {
    if (req.headers.get('origin') !== AUTH_ORIGIN) throw new HttpError(403, 'origin_not_allowed');
    const text = await req.text();
    if (text.length > RELAY_MAX_BODY) throw new HttpError(413, 'too_large');
    let b: unknown;
    try {
      b = JSON.parse(text);
    } catch {
      throw new HttpError(400, 'bad_request');
    }
    if (!isObj(b) || typeof b.iv !== 'string' || typeof b.ct !== 'string' || Object.keys(b).length !== 2) throw new HttpError(400, 'bad_request');
    if (this.relay.has(relayId)) throw new HttpError(409, 'relay_used');
    this.relay.set(relayId, { kind: 'value', iv: b.iv, ct: b.ct });
    setTimeout(() => {
      if (this.relay.get(relayId)?.kind === 'value') this.relay.set(relayId, { kind: 'expired' });
      setTimeout(() => this.relay.delete(relayId), RELAY_TTL_MS).unref();
    }, RELAY_TTL_MS).unref();
    this.wake(relayId);
    return new Response(null, { status: 204 });
  }

  private async relayRead(req: Request, url: URL, relayId: string, signal: AbortSignal): Promise<Response> {
    const origin = req.headers.get('origin');
    if (origin !== VAULT_ORIGIN && origin !== AUTH_ORIGIN) throw new HttpError(403, 'origin_not_allowed');
    const key = req.headers.get('x-hana-relay-key');
    let keyOk = false;
    try {
      keyOk = key !== null && relayIdFor(base64UrlDecode(key)) === relayId;
    } catch {
      keyOk = false;
    }
    if (!keyOk) throw new HttpError(403, 'relay_forbidden');
    const wait = Math.min(RELAY_WAIT_MAX_S, Math.max(1, Number.parseInt(url.searchParams.get('wait') ?? '1', 10) || 1));
    if (!this.relay.has(relayId)) {
      await new Promise<void>((resolve) => {
        const waiters = this.relayWaiters.get(relayId) ?? new Set<() => void>();
        this.relayWaiters.set(relayId, waiters);
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          if (waiters.size === 0) this.relayWaiters.delete(relayId);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, wait * 1000);
        waiters.add(done);
        signal.addEventListener('abort', done, { once: true });
      });
    }
    const slot = this.relay.get(relayId);
    if (slot === undefined) return new Response(null, { status: 204 });
    if (slot.kind !== 'value') throw new HttpError(410, 'relay_gone');
    this.relay.set(relayId, { kind: 'consumed' });
    return json(200, { iv: slot.iv, ct: slot.ct, serverTimeMs: Date.now() });
  }

  // ---- vault shares (docs/batch-b-spec.md "Vault endpoints") ----

  private async createShare(req: Request): Promise<Response> {
    const { app, parentOrigin } = await this.gate(req, [VAULT_ORIGIN]);
    const s = await this.settings(app);
    if (s.persistence !== 'session') throw new HttpError(409, 'persistence_off');
    const b = await this.body(req);
    if (!isBytes(b.sessionPublicKey, 32) || !isBytes(b.signature, 64)) throw new HttpError(400, 'bad_request');
    const sessionPk = bytes(b.sessionPublicKey);
    const msg = vaultMessage({ signer: E2E_ENV.signer, appId: app.id, shareId: new Uint8Array(16), counter: 0, payload: vaultPayload.createShare(parentOrigin) });
    if (!(await verifyEd25519(sessionPk, bytes(b.signature), msg))) throw new HttpError(401, 'invalid_signature');
    const session = this.chain.session(sessionPk);
    if (!session) throw new HttpError(404, 'unknown_session');
    if (session.scope_id !== app.scope_id) throw new HttpError(403, 'scope_mismatch');
    if (session.used !== session.max_uses) throw new HttpError(409, 'session_not_spent');
    for (const sh of this.shares.values()) if (toHex(sh.sessionPk) === toHex(sessionPk)) throw new HttpError(409, 'share_exists');
    const now = Date.now();
    const share: Share = {
      shareId: crypto.getRandomValues(new Uint8Array(16)),
      appId: app.id,
      sessionPk,
      pathHash: toHex(sha256(utf8(session.path))),
      partnerOrigin: parentOrigin,
      ks: crypto.getRandomValues(new Uint8Array(32)),
      counter: 0,
      createdAt: now,
      idleUntil: now + s.idle_ttl_ms,
      absExpiresAt: Math.min(session.expires_at_ms, now + s.session_ttl_ms),
      revoked: false,
    };
    this.shares.set(toHex(share.shareId), share);
    return json(201, { shareId: Array.from(share.shareId), ks: Array.from(share.ks), absExpiresAtMs: share.absExpiresAt, idleUntilMs: share.idleUntil });
  }

  private async shareAction(req: Request, action: 'unlock' | 'touch' | 'revoke' | 'revoke-all'): Promise<Response> {
    const { app } = await this.gate(req, [VAULT_ORIGIN]);
    const s = await this.settings(app);
    const b = await this.body(req);
    if (!isBytes(b.shareId, 16) || !isInt(b.counter) || !isBytes(b.signature, 64)) throw new HttpError(400, 'bad_request');
    const share = this.shares.get(toHex(bytes(b.shareId)));
    if (!share || share.appId !== app.id) throw new HttpError(404, 'unknown_share');
    if (!this.api.parentOriginAllowed(ENV_NAME, app, share.partnerOrigin)) throw new HttpError(410, 'share_revoked');
    const payload = { unlock: vaultPayload.unlock, touch: vaultPayload.touch, revoke: vaultPayload.revoke, 'revoke-all': vaultPayload.revokeAll }[action]();
    const msg = vaultMessage({ signer: E2E_ENV.signer, appId: app.id, shareId: share.shareId, counter: b.counter, payload });
    if (!(await verifyEd25519(share.sessionPk, bytes(b.signature), msg))) throw new HttpError(401, 'invalid_signature');
    const now = Date.now();
    if (share.revoked) throw new HttpError(410, 'share_revoked');
    if (now >= share.idleUntil || now >= share.absExpiresAt) throw new HttpError(410, 'share_expired');
    if (b.counter !== share.counter + 1) throw new HttpError(409, 'bad_counter', { expected: share.counter + 1 });
    if (action === 'revoke-all' && now - share.createdAt >= FRESH_SHARE_MS) throw new HttpError(403, 'share_not_fresh');
    share.counter = b.counter;
    if (action === 'unlock' || action === 'touch') share.idleUntil = Math.min(now + s.idle_ttl_ms, share.absExpiresAt);
    switch (action) {
      case 'unlock':
        return json(200, { ks: Array.from(share.ks), counter: share.counter, idleUntilMs: share.idleUntil, absExpiresAtMs: share.absExpiresAt });
      case 'touch':
        return json(200, { counter: share.counter, idleUntilMs: share.idleUntil });
      case 'revoke':
        share.revoked = true;
        return json(200, { revoked: true });
      case 'revoke-all': {
        let revoked = 0;
        for (const other of this.shares.values()) {
          if (other !== share && !other.revoked && other.appId === app.id && other.pathHash === share.pathHash) {
            other.revoked = true;
            revoked += 1;
          }
        }
        return json(200, { revoked });
      }
    }
  }

  // ---- control ----

  private async control(req: Request, url: URL): Promise<Response> {
    // Pages can't reach these: no CORS, and a browser request always carries an Origin on POST.
    if (req.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
    const p = url.pathname;
    if (p === '/__e2e/health') return json(200, { ok: true });
    if (p === '/__e2e/apps' && req.method === 'POST') return json(201, this.createApp((await req.json()) as AppSpec));
    const m = /^\/__e2e\/apps\/(pk_test_[1-9A-HJ-NP-Za-km-z]+)\/(revoke|shares)$/u.exec(p);
    if (m?.[2] === 'revoke' && req.method === 'POST') return json(200, { revoked: this.revokeApp(m[1] as string) });
    if (m?.[2] === 'shares' && req.method === 'GET') {
      const appId = this.d1.db.prepare('SELECT id FROM apps WHERE publishable_key = ?').get(m[1] as string)?.id;
      const list = [...this.shares.values()].filter((s) => s.appId === appId).map((s) => ({ counter: s.counter, revoked: s.revoked, partnerOrigin: s.partnerOrigin }));
      return json(200, list);
    }
    return json(404, { error: 'not_found' });
  }
}
