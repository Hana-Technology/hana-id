// The Hana API of the local stack: apps/api's own Worker (api-modules.ts) on node:sqlite D1 (d1.ts), the mocked chain
// (chain.ts) and in-process Durable Objects (workers.ts). Routing, CORS, the origin rule, GET /v1/app, the vault
// endpoints (KEK wrapping, counters, the real SQL) and the login relay (the LoginRelay class itself) are the Worker's.
// Only POST /v1/login and POST /v1/derive are mocked here, since they need the relayer and the MPC: they run the real
// app gate first, then check every signature and the session nonce, and keep sessions on the mocked chain, where the
// Worker's own get_session read finds them. They don't check the Google token's RS256 signature (the vault does; the
// API's own check has its own tests in apps/api).
//
// Control endpoints for the tests (`/__e2e/*`, no CORS, so no page can call them):
//   POST /__e2e/apps                  {name?, scopeId?, origins, status?, settings?, publishableKey?} → {appId, pk}
//                                     (with publishableKey: created once, then the same app is returned)
//   POST /__e2e/apps/<pk>/revoke      every live share of the app is revoked (an unlock then gets 410 share_revoked)
//   GET  /__e2e/apps/<pk>/shares      [{counter, revoked, partnerOrigin}], oldest first
//   GET  /__e2e/health                {ok, fingerprint} (fingerprint.ts)
import {
  base64UrlDecode,
  ckdPayload,
  fromUtf8,
  sessionMessage,
  sessionNonce,
  toHex,
  verifyEd25519,
} from '@hana-id/core';
import { base58 } from '@scure/base';
import { API_URL, AUTH_ORIGIN, E2E_ENV, ENV_NAME, NEAR_RPC, VAULT_ORIGIN } from '../stack.ts';
import type { ApiApp, ApiCtx, ApiEnv, ApiModules } from './api-modules.ts';
import { type Chain, mpcAnswer } from './chain.ts';
import type { D1Shim } from './d1.ts';
import { json } from './http.ts';
import { ExecContext, MemoryNamespace, allowAllLimiter } from './workers.ts';

const KEY_INDEX_LIMIT = 0x8000_0000;

type Body = Record<string, unknown>;

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

/** A fresh VAULT_KEK per stack (`<id>:<base64 of 32 bytes>`, vault/kek.ts): shares live only as long as the stack. */
const newVaultKek = (): string => `1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

export interface AppSpec {
  name?: string;
  scopeId?: string;
  origins: string[];
  status?: 'active' | 'suspended';
  settings?: { persistence?: 'session' | 'none'; rawSign?: 'off' | 'approval'; autoApprovePolicy?: Body | null };
  /** A fixed key, for a page that bakes its key in at build time (the demo): the app is created on first use only. */
  publishableKey?: string;
}

export interface MockApiOptions {
  /** The NEAR RPC the Worker reads (default the stack's). */
  nearRpc?: string;
  /** What /__e2e/health reports (fingerprint.ts). */
  fingerprint?: string;
}

export class MockApi {
  /** The Worker's bindings. */
  readonly env: ApiEnv;
  private readonly exec = new ExecContext();
  private seq = 0;
  private readonly fingerprint: string;

  constructor(
    private readonly d1: D1Shim,
    private readonly chain: Chain,
    private readonly api: ApiModules,
    opts: MockApiOptions = {},
  ) {
    this.fingerprint = opts.fingerprint ?? '';
    const env: ApiEnv = {
      DB: d1,
      ENV_NAME,
      NEAR_RPC: opts.nearRpc ?? NEAR_RPC,
      SIGNER_ACCOUNT: E2E_ENV.signer,
      RELAYER_ACCOUNT: E2E_ENV.relayer,
      VAULT_ORIGIN,
      AUTH_ORIGIN,
      API_URL,
      VAULT_KEK: newVaultKek(),
      DO_LOCATION_HINT: '',
      RATE_LIMITER: allowAllLimiter,
    };
    env.LOGIN_RELAY = new MemoryNamespace(api.LoginRelay, () => env);
    this.env = env;
  }

  // ---- apps (D1 rows, read back by apps/api's own queries) ----

  createApp(spec: AppSpec): { appId: string; pk: string } {
    if (spec.publishableKey !== undefined) {
      if (!/^pk_test_[1-9A-HJ-NP-Za-km-z]{16,64}$/u.test(spec.publishableKey)) throw new Error('publishableKey must be a pk_test_ key');
      const existing = this.d1.db.prepare('SELECT id FROM apps WHERE publishable_key = ?').get(spec.publishableKey) as { id: string } | undefined;
      if (existing) return { appId: existing.id, pk: spec.publishableKey };
    }
    this.seq += 1;
    const appId = `app_e2e_${this.seq}_${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
    const pk = spec.publishableKey ?? `pk_test_${base58.encode(crypto.getRandomValues(new Uint8Array(16)))}`;
    const s = spec.settings ?? {};
    this.d1.db
      .prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, persistence, raw_sign, auto_approve_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(appId, spec.name ?? 'E2E Partner', spec.scopeId ?? 'e2e', pk, spec.status ?? 'active', s.persistence ?? 'session', s.rawSign ?? 'off', s.autoApprovePolicy ? JSON.stringify(s.autoApprovePolicy) : null);
    const insert = this.d1.db.prepare('INSERT INTO app_origins (app_id, origin) VALUES (?, ?)');
    for (const o of spec.origins) insert.run(appId, o);
    return { appId, pk };
  }

  /** Revokes every live share of the app (apps/api's vault_shares rows) and returns how many. */
  revokeApp(pk: string): number {
    const r = this.d1.db
      .prepare('UPDATE vault_shares SET revoked_at = ? WHERE app_id = (SELECT id FROM apps WHERE publishable_key = ?) AND revoked_at IS NULL')
      .run(Date.now(), pk);
    return Number(r.changes);
  }

  /** The app's shares, oldest first. */
  shares(pk: string): { counter: number; revoked: boolean; partnerOrigin: string }[] {
    return this.d1.db
      .prepare('SELECT counter, revoked_at, partner_origin FROM vault_shares WHERE app_id = (SELECT id FROM apps WHERE publishable_key = ?) ORDER BY created_at, rowid')
      .all(pk)
      .map((r) => ({ counter: Number(r.counter), revoked: r.revoked_at !== null, partnerOrigin: String(r.partner_origin) }));
  }

  // ---- HTTP ----

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__e2e/')) return this.control(req, url);
    if (req.method === 'POST' && (url.pathname === '/v1/login' || url.pathname === '/v1/derive')) return this.mocked(req, url.pathname);
    return this.api.worker.fetch(req, this.env, this.exec);
  }

  /** /v1/login and /v1/derive: the Worker's app gate (key, origin rule, CORS), then the mock. */
  private async mocked(req: Request, endpoint: '/v1/login' | '/v1/derive'): Promise<Response> {
    const ctx = this.api.newCtx(this.env, crypto.randomUUID(), endpoint, req);
    const gate = await this.api.appGate(req, this.env, ctx, 'relay');
    if (!gate.ok) return gate.response;
    // As apps/api's /v1/login: a pk_test_ app's success carries the request's own timings.
    if (endpoint === '/v1/login') ctx.exposeTimings = gate.app.publishable_key.startsWith('pk_test_');
    try {
      const b = await this.body(req);
      return endpoint === '/v1/login' ? await this.login(ctx, gate.app, b) : await this.derive(ctx, b);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      return this.api.done(ctx, e.status, { error: e.code, code: e.code, ...e.extra });
    }
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

  // ---- /v1/login, /v1/derive (the chain side is chain.ts) ----

  private async login(ctx: ApiCtx, app: ApiApp, b: Body): Promise<Response> {
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
    return this.api.done(ctx, 200, { result, session: { scope_id: session.scope_id, expires_at_ms: session.expires_at_ms, max_uses: session.max_uses, used: 1 }, nearTx });
  }

  private async derive(ctx: ApiCtx, b: Body): Promise<Response> {
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
    return this.api.done(ctx, 200, { result, nearTx });
  }

  // ---- control ----

  private async control(req: Request, url: URL): Promise<Response> {
    // Pages can't reach these: no CORS, and a browser request always carries an Origin on POST.
    if (req.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
    const p = url.pathname;
    if (p === '/__e2e/health') return json(200, { ok: true, fingerprint: this.fingerprint });
    if (p === '/__e2e/apps' && req.method === 'POST') return json(201, this.createApp((await req.json()) as AppSpec));
    const m = /^\/__e2e\/apps\/(pk_test_[1-9A-HJ-NP-Za-km-z]+)\/(revoke|shares)$/u.exec(p);
    if (m?.[2] === 'revoke' && req.method === 'POST') return json(200, { revoked: this.revokeApp(m[1] as string) });
    if (m?.[2] === 'shares' && req.method === 'GET') return json(200, this.shares(m[1] as string));
    return json(404, { error: 'not_found' });
  }
}
