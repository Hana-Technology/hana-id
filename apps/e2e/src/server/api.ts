// The Hana API of the local stack: apps/api's own Worker (api-modules.ts) on node:sqlite D1 (d1.ts), the mocked chain
// (chain.ts) and in-process Durable Objects (workers.ts). Routing, CORS, the origin rule, GET /v1/app, the vault
// endpoints (KEK wrapping, counters, the real SQL) and the login relay (the LoginRelay class itself) are the Worker's.
// Only POST /v1/login and POST /v1/derive (and batch 8b's /v1/sessions/revoke and /v1/link*, which need the relayer)
// are mocked here, since they need the relayer and the MPC: they run the real
// app gate first, then check every signature and the session nonce, and keep sessions on the mocked chain, where the
// Worker's own get_session read finds them. They don't check the Google token's RS256 signature (the vault does; the
// API's own check has its own tests in apps/api), but /v1/login applies the Worker's claim allow-list (apps/api
// claims.ts, `token_has_pii`). Every relayed transaction that carried a token is recorded (Chain.relayed).
//
// Control endpoints for the tests (`/__e2e/*`, no CORS, so no page can call them):
//   POST /__e2e/apps                  {name?, scopeId?, origins, status?, settings?, publishableKey?, live?, loginMethods?} → {appId, pk}
//                                     (with publishableKey: created once, then the same app is returned; live: a
//                                     pk_live_ key, on LIVE_SCOPE_ID unless scopeId says otherwise)
//   POST /__e2e/apps/<pk>/revoke      every live share of the app is revoked (an unlock then gets 410 share_revoked)
//   GET  /__e2e/apps/<pk>/shares      [{counter, revoked, partnerOrigin}], oldest first
//   GET  /__e2e/health                {ok, fingerprint} (fingerprint.ts)
//   GET  /__e2e/chain[?sub=<sub>]     {relayed: [{method, tokens: [{provider, sub, claims}]}], sessions}: the transactions
//                                     the relayer sent that carried a token (of `sub`), and the live sessions on its
//                                     path; claim names only, never a token
//   GET  /__e2e/wallets?address=<a>   [{userId, supportCode, internalId, scopeId, wallets: [{chain, address}],
//                                     identities: [{provider, sub, role, status}]}]: the wallet directory's users listing
//                                     that address (migration 0011, written by the Worker's own POST /v1/wallets/record;
//                                     userId is end_users.token_sub, internalId end_users.user_id, D346)
import {
  base64UrlDecode,
  ckdPayload,
  identityKeyHex,
  linkedCkdPayload,
  revokePayload,
  fromUtf8,
  sessionMessage,
  sessionNonce,
  toHex,
  verifyEd25519,
} from '@hana-id/core';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { base58 } from '@scure/base';
import { API_URL, AUTH_ORIGIN, E2E_ENV, ENV_NAME, LIVE_SCOPE_ID, NEAR_RPC, VAULT_ORIGIN } from '../stack.ts';
import type { ApiApp, ApiCtx, ApiEnv, ApiModules } from './api-modules.ts';
import { CHANGE_DELAY_MS, type Chain, type RelayedTx, mpcAnswer } from './chain.ts';
import type { D1Shim } from './d1.ts';
import { json } from './http.ts';
import { ExecContext, MemoryNamespace, allowAllLimiter, allowAllRateLimit } from './workers.ts';

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

/** The identity, nonce and claim names a token carries (an email token's JWS JSON payload, or a Google JWT's), unverified. */
function tokenIdentity(jwt: unknown): { provider: 'google' | 'email'; sub: string; nonce: unknown; claims: string[] } | null {
  if (typeof jwt !== 'string') return null;
  const email = jwt.startsWith('{');
  try {
    const payload = email ? (JSON.parse(jwt) as { payload?: unknown }).payload : jwt.split('.')[1];
    const claims = JSON.parse(fromUtf8(base64UrlDecode(typeof payload === 'string' ? payload : ''))) as { sub?: unknown; nonce?: unknown };
    if (!isObj(claims)) return null;
    return typeof claims.sub === 'string' ? { provider: email ? 'email' : 'google', sub: claims.sub, nonce: claims.nonce, claims: Object.keys(claims) } : null;
  } catch {
    return null;
  }
}

/** A relayed token as Chain.relayed records it: identity and claim names only. */
const relayedToken = (t: { provider: string; sub: string; claims: string[] }) => ({ provider: t.provider, sub: t.sub, claims: t.claims });

/** The endpoints the stack mocks (they need the relayer, or the MPC): the Worker's app gate runs first. */
const MOCKED = new Set(['/v1/login', '/v1/derive', '/v1/sessions/revoke', '/v1/link', '/v1/link/cancel', '/v1/link/unlink']);

/** A fresh VAULT_KEK per stack (`<id>:<base64 of 32 bytes>`, vault/kek.ts): shares live only as long as the stack. */
const newVaultKek = (): string => `1:${Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64')}`;

/**
 * The identity token's configuration per stack (docs/identity-token-spec.md; what gen-wrangler and identity-key.ts set
 * on a real env): a fresh P-256 signing key and a standby, their JWKS, and a sub key. Throwaway, never written anywhere.
 */
function identityBindings(apiUrl: string): Record<string, string> {
  const key = () => {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jwk = privateKey.export({ format: 'jwk' }) as { x: string; y: string; d: string };
    const kid = createHash('sha256').update(JSON.stringify({ crv: 'P-256', kty: 'EC', x: jwk.x, y: jwk.y })).digest('base64url');
    return { private: JSON.stringify({ kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }), public: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, kid, use: 'sig', alg: 'ES256' } };
  };
  const [active, standby] = [key(), key()];
  return {
    IDENTITY_ISS: `${apiUrl}/v1/identity`,
    IDENTITY_PUBLIC_KEYS: JSON.stringify([active.public, standby.public]),
    IDENTITY_ACTIVE_KID: active.public.kid,
    IDENTITY_SIGNING_KEY: active.private,
    IDENTITY_SIGNING_KEY_STANDBY: standby.private,
    IDENTITY_SUB_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
  };
}

export interface AppSpec {
  name?: string;
  scopeId?: string;
  origins: string[];
  status?: 'active' | 'suspended';
  settings?: { persistence?: 'session' | 'none'; rawSign?: 'off' | 'approval'; autoApprovePolicy?: Body | null };
  /** `apps.mainnet_demo` (migration 0013, D428): Hana staff's switch for the mainnet demo exception (a test app only). */
  mainnetDemo?: boolean;
  /** A fixed key, for a page that bakes its key in at build time (the demo): the app is created on first use only. */
  publishableKey?: string;
  /**
   * A live app: a `pk_live_` key, on LIVE_SCOPE_ID by default (D51: a test app on a live app's scope is refused). The
   * Worker and the vault then apply a live app's rules: no loopback origin (live mode's LIVE_PARTNER_ORIGIN instead,
   * src/stack.ts), raw signing when `rawSign` is 'approval', no timings.
   */
  live?: boolean;
  /** `apps.login_methods` (migration 0010): `'google,email'` turns email login on (default: Google only). */
  loginMethods?: 'google' | 'google,email';
}

export interface MockApiOptions {
  /** The NEAR RPC the Worker reads (default the stack's). */
  nearRpc?: string;
  /** What /__e2e/health reports (fingerprint.ts). */
  fingerprint?: string;
  /**
   * The env this Worker serves (default E2E_ENV): live mode's second Worker, on the same D1 and chain, serves LIVE_ENV
   * (src/stack.ts). It has no control endpoints: the tests create apps through the default one.
   */
  serves?: { envName: string; vaultOrigin: string; authOrigin: string; apiUrl: string };
  /** The email issuer's iss and public keys (gen-wrangler's EMAIL_ISS / EMAIL_PUBLIC_KEYS), when the env has one. */
  email?: { iss: string; publicKeys: unknown[] };
  /** The stack's Google signing key, for `GET /__e2e/google-key` (google-backend.ts; the tests' stub signs with it). */
  googleKey?: () => Promise<unknown>;
}

export class MockApi {
  /** The Worker's bindings. */
  readonly env: ApiEnv;
  private readonly exec = new ExecContext();
  private seq = 0;
  private readonly fingerprint: string;
  private readonly control: boolean;
  private readonly googleKey: (() => Promise<unknown>) | null;

  constructor(
    private readonly d1: D1Shim,
    private readonly chain: Chain,
    private readonly api: ApiModules,
    opts: MockApiOptions = {},
  ) {
    this.fingerprint = opts.fingerprint ?? '';
    this.control = opts.serves === undefined;
    this.googleKey = opts.googleKey ?? null;
    const serves = opts.serves ?? { envName: ENV_NAME, vaultOrigin: VAULT_ORIGIN, authOrigin: AUTH_ORIGIN, apiUrl: API_URL };
    const env: ApiEnv = {
      DB: d1,
      ENV_NAME: serves.envName,
      // As the manifest's `network` (gen-wrangler.ts): the mainnet demo (D428) exists only on testnet.
      NETWORK: 'testnet',
      NEAR_RPC: opts.nearRpc ?? NEAR_RPC,
      SIGNER_ACCOUNT: E2E_ENV.signer,
      RELAYER_ACCOUNT: E2E_ENV.relayer,
      VAULT_ORIGIN: serves.vaultOrigin,
      AUTH_ORIGIN: serves.authOrigin,
      API_URL: serves.apiUrl,
      VAULT_KEK: newVaultKek(),
      DO_LOCATION_HINT: '',
      RATE_LIMITER: allowAllLimiter,
      VAULT_IP_LIMIT: allowAllRateLimit,
      VAULT_SHARE_LIMIT: allowAllRateLimit,
      IDENTITY_SESSION_LIMIT: allowAllRateLimit,
      IDENTITY_ROOT_LIMIT: allowAllRateLimit,
      ...identityBindings(serves.apiUrl),
      // The wallet directory's user ids (D312): a throwaway uid key, as usage-setup sets it on a real env.
      USER_ID_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64'),
      ...(opts.email ? { EMAIL_ISS: opts.email.iss, EMAIL_PUBLIC_KEYS: JSON.stringify(opts.email.publicKeys) } : {}),
    };
    env.LOGIN_RELAY = new MemoryNamespace(api.LoginRelay, () => env);
    this.env = env;
  }

  // ---- apps (D1 rows, read back by apps/api's own queries) ----

  createApp(spec: AppSpec): { appId: string; pk: string } {
    if (spec.publishableKey !== undefined) {
      if (spec.live) throw new Error('a live app gets a fresh key: publishableKey is for pk_test_ apps');
      if (!/^pk_test_[1-9A-HJ-NP-Za-km-z]{16,64}$/u.test(spec.publishableKey)) throw new Error('publishableKey must be a pk_test_ key');
      const existing = this.d1.db.prepare('SELECT app_id AS id FROM app_keys WHERE key = ?').get(spec.publishableKey) as { id: string } | undefined;
      if (existing) return { appId: existing.id, pk: spec.publishableKey };
    }
    this.seq += 1;
    const appId = `app_e2e_${this.seq}_${toHex(crypto.getRandomValues(new Uint8Array(4)))}`;
    const pk = spec.publishableKey ?? `${spec.live ? 'pk_live_' : 'pk_test_'}${base58.encode(crypto.getRandomValues(new Uint8Array(16)))}`;
    const s = spec.settings ?? {};
    const scopeId = spec.scopeId ?? (spec.live ? LIVE_SCOPE_ID : 'e2e');
    const now = Date.now();
    // The hot DB after migration 0006: the scope row (one environment per scope; a key of the other one is refused by
    // its triggers), the app, its key in app_keys, and its origins in force (active_from 0, as migrated).
    this.d1.db
      .prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?, 'org_legacy', ?, ?, ?, ?)")
      .run(scopeId, spec.live ? 'live' : 'test', now, now, now);
    this.d1.db
      .prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, persistence, raw_sign, auto_approve_policy) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(appId, spec.name ?? 'E2E Partner', scopeId, pk, spec.status ?? 'active', s.persistence ?? 'session', s.rawSign ?? 'off', s.autoApprovePolicy ? JSON.stringify(s.autoApprovePolicy) : null);
    if (spec.status === 'suspended') this.d1.db.prepare('UPDATE apps SET suspended_by = 1 WHERE id = ?').run(appId);
    if (spec.loginMethods) this.d1.db.prepare('UPDATE apps SET login_methods = ? WHERE id = ?').run(spec.loginMethods, appId);
    if (spec.mainnetDemo) this.d1.db.prepare('UPDATE apps SET mainnet_demo = 1 WHERE id = ?').run(appId);
    this.d1.db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?, ?, ?, 'e2e', ?)").run(`key_${appId}`, appId, pk, now);
    const insert = this.d1.db.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?, ?, 0)');
    for (const o of spec.origins) insert.run(appId, o);
    return { appId, pk };
  }

  /** Revokes every live share of the app (apps/api's vault_shares rows) and returns how many. */
  revokeApp(pk: string): number {
    const r = this.d1.db
      .prepare('UPDATE vault_shares SET revoked_at = ? WHERE app_id = (SELECT app_id FROM app_keys WHERE key = ?) AND revoked_at IS NULL')
      .run(Date.now(), pk);
    return Number(r.changes);
  }

  /** The app's shares, oldest first. */
  shares(pk: string): { counter: number; revoked: boolean; partnerOrigin: string }[] {
    return this.d1.db
      .prepare('SELECT counter, revoked_at, partner_origin FROM vault_shares WHERE app_id = (SELECT app_id FROM app_keys WHERE key = ?) ORDER BY created_at, rowid')
      .all(pk)
      .map((r) => ({ counter: Number(r.counter), revoked: r.revoked_at !== null, partnerOrigin: String(r.partner_origin) }));
  }

  // ---- HTTP ----

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/__e2e/')) return this.control ? this.controlEndpoint(req, url) : json(404, { error: 'not_found' });
    if (req.method === 'POST' && MOCKED.has(url.pathname)) return this.mocked(req, url.pathname);
    return this.api.worker.fetch(req, this.env, this.exec);
  }

  /** The mocked endpoints: the Worker's app gate (key, origin rule, CORS), then the mock. */
  private async mocked(req: Request, endpoint: string): Promise<Response> {
    const ctx = this.api.newCtx(this.env, crypto.randomUUID(), endpoint, req);
    const gate = await this.api.appGate(req, this.env, ctx, 'relay');
    if (!gate.ok) return gate.response;
    // As apps/api's /v1/login: a test-scope app's success carries the request's own timings.
    if (endpoint === '/v1/login') ctx.exposeTimings = gate.app.environment === 'test';
    try {
      const b = await this.body(req);
      if (endpoint === '/v1/login') return await this.login(ctx, gate.app, b);
      if (endpoint === '/v1/derive') return await this.derive(ctx, b);
      if (endpoint === '/v1/sessions/revoke') return await this.revoke(ctx, b);
      return this.links(ctx, gate.app, endpoint, b);
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
    // An automatic link (batch 8b, D133): an email token and its mode; the session signature is then over the linked
    // CKD payload. Its `auto_link` nonce is the vault's to check (and apps/api's precheck, with its own tests).
    if (b.linkJwt !== undefined && !(typeof b.linkJwt === 'string' && b.linkJwt.startsWith('{'))) throw new HttpError(400, 'bad_request');
    if (b.linkImmediate !== undefined && (typeof b.linkImmediate !== 'boolean' || b.linkJwt === undefined)) throw new HttpError(400, 'bad_request');
    // The export window's chain label (D430), as apps/api's toLogin checks it.
    if (b.exportChain !== undefined && b.exportChain !== 'stellar' && b.exportChain !== 'evm') throw new HttpError(400, 'bad_request');
    // An email token (JWS JSON, `{"payload":…}`) or a Google one; the path is the contract's (the identity's own, or its
    // account root's, batch 7). The token's signature is the vault's to check here (and apps/api's own tests'), as for
    // Google.
    const who = tokenIdentity(b.jwt);
    // apps/api's claim allow-list (claims.ts, the real function): a Google token with any other claim (an email, a
    // Workspace domain) is refused before it can be relayed, as the Worker's /v1/login does.
    const claim = who?.provider === 'google' ? this.api.disallowedClaim(b.jwt) : null;
    if (claim) throw new HttpError(400, 'token_has_pii', { data: { claim } });
    const sessionPublicKey = bytes(b.sessionPublicKey);
    const nonce = sessionNonce({ signer: E2E_ENV.signer, scopeId: app.scope_id, sessionPublicKey, expiresAtMs: b.expiresAtMs, keyIndex: b.keyIndex, maxUses: b.maxUses, salt: bytes(b.salt) });
    if (!who || who.nonce !== nonce) throw new HttpError(401, 'token_invalid');
    if (this.chain.session(sessionPublicKey)) throw new HttpError(409, 'session_exists');
    const link = typeof b.linkJwt === 'string' ? { jwt: b.linkJwt, immediate: b.linkImmediate === true } : null;
    const signed = link ? linkedCkdPayload(b.pk1, b.pk2, link.jwt, link.immediate) : ckdPayload(b.pk1, b.pk2);
    if (!(await verifyEd25519(sessionPublicKey, bytes(b.signature), sessionMessage(1, signed)))) throw new HttpError(401, 'invalid_signature');
    const self = { provider: who.provider, sub: who.sub };
    if (this.chain.pathIdentity(app.scope_id, self) === 'pending') throw new HttpError(409, 'link_pending');
    // The relayer sends create_session_and_derive: what reached the chain (the contract may still refuse a link below).
    const linkWho = typeof b.linkJwt === 'string' ? tokenIdentity(b.linkJwt) : null;
    this.chain.relayed.push({ method: 'create_session_and_derive', tokens: [relayedToken(who), ...(linkWho ? [relayedToken(linkWho)] : [])] });
    if (link) {
      const e = tokenIdentity(link.jwt);
      if (!e || e.provider !== 'email') throw new HttpError(400, 'bad_request');
      const refused = this.chain.autoLink(app.scope_id, self, { provider: 'email', sub: e.sub }, link.immediate);
      if (refused) throw new HttpError(422, 'link_refused', { reason: refused });
    }
    const pi = this.chain.pathIdentity(app.scope_id, self);
    if (pi === 'pending') throw new HttpError(409, 'link_pending');
    const session = { path: `${app.scope_id}#${pi.provider}#${pi.sub}#${b.keyIndex}`, scope_id: app.scope_id, expires_at_ms: b.expiresAtMs, max_uses: b.maxUses, used: 1 };
    this.chain.sessions.set(toHex(sessionPublicKey), session);
    // The path's identity has a wallet now (`opened`, D130).
    this.chain.opened.add(identityKeyHex(app.scope_id, pi.provider, pi.sub));
    const result = mpcAnswer(b.pk1, session.path);
    const nearTx = this.chain.newTxHash();
    this.chain.txs.set(nearTx, result);
    // As the Worker's /v1/login (C15): the account root's Support ID, by the Worker's own code.
    const supportId = await this.api.sessionSupportId(this.env, app.scope_id, pi);
    return this.api.done(ctx, 200, { result, session: { scope_id: session.scope_id, expires_at_ms: session.expires_at_ms, max_uses: session.max_uses, used: 1 }, nearTx, ...(supportId ? { supportId } : {}) });
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

  /** revoke_session (D137's recovery): the session's next counter, signed over "revoke". */
  private async revoke(ctx: ApiCtx, b: Body): Promise<Response> {
    if (!isBytes(b.sessionPublicKey, 32) || !isInt(b.counter) || !isBytes(b.signature, 64)) throw new HttpError(400, 'bad_request');
    const s = this.chain.session(bytes(b.sessionPublicKey));
    if (!s) throw new HttpError(409, 'no_session');
    if (b.counter !== s.used + 1) throw new HttpError(409, 'bad_counter', { nextCounter: s.used + 1 });
    if (!(await verifyEd25519(bytes(b.sessionPublicKey), bytes(b.signature), sessionMessage(b.counter, revokePayload())))) throw new HttpError(401, 'invalid_signature');
    this.chain.sessions.delete(toHex(bytes(b.sessionPublicKey)));
    return this.api.done(ctx, 200, { result: null, nearTx: this.chain.newTxHash() });
  }

  /**
   * link_identity, cancel_link, unlink_identity on the mocked chain (the tokens' signatures and nonces are the vault's
   * to check here, and apps/api's precheck's in its own tests): the epoch must be the account's.
   */
  private links(ctx: ApiCtx, app: ApiApp, endpoint: string, b: Body): Response {
    if (!isInt(b.epoch) || !isBytes(b.salt)) throw new HttpError(400, 'bad_request');
    if (endpoint === '/v1/link') {
      const a = tokenIdentity(b.accountJwt);
      const n = tokenIdentity(b.newJwt);
      if (!a || !n) throw new HttpError(400, 'bad_request');
      this.chain.relayed.push({ method: 'link_identity', tokens: [relayedToken(a), relayedToken(n)] });
      const root = this.chain.pathIdentity(app.scope_id, a);
      if (root === 'pending') throw new HttpError(409, 'link_pending');
      const account = this.chain.accountOf(identityKeyHex(app.scope_id, root.provider, root.sub));
      if ((account?.account.epoch ?? 0) !== b.epoch) throw new HttpError(422, 'contract_rejected', { reason: 'wrong_epoch' });
      if (this.chain.accountOf(identityKeyHex(app.scope_id, n.provider, n.sub)) || this.chain.opened.has(identityKeyHex(app.scope_id, n.provider, n.sub))) {
        throw new HttpError(422, 'contract_rejected', { reason: 'already_linked' });
      }
      const effectiveAtMs = Date.now() + CHANGE_DELAY_MS;
      this.chain.link(app.scope_id, root, n, { active: false, effectiveAtMs, auto: false });
      return this.api.done(ctx, 200, { result: { effectiveAtMs }, nearTx: this.chain.newTxHash() });
    }
    const t = tokenIdentity(b.jwt);
    if (typeof b.memberKey !== 'string' || !t) throw new HttpError(400, 'bad_request');
    this.chain.relayed.push({ method: endpoint === '/v1/link/unlink' ? 'unlink_identity' : 'cancel_link', tokens: [relayedToken(t)] });
    const found = this.chain.accountOf(b.memberKey);
    if (!found || found.account.epoch !== b.epoch) throw new HttpError(422, 'contract_rejected', { reason: 'wrong_epoch' });
    if (!this.chain.unlink(b.memberKey, endpoint === '/v1/link/unlink')) throw new HttpError(422, 'contract_rejected', { reason: 'no_such_member' });
    return this.api.done(ctx, 200, { result: null, nearTx: this.chain.newTxHash() });
  }

  /**
   * What reached the mocked chain: the relayed transactions that carried a token (with `sub`: of that `sub` only) and
   * the live sessions whose path names `sub`. Identities and claim names only, never a token.
   */
  chainView(sub: string | null): { relayed: RelayedTx[]; sessions: number } {
    const relayed = sub === null ? this.chain.relayed : this.chain.relayed.filter((t) => t.tokens.some((x) => x.sub === sub));
    const sessions = sub === null ? this.chain.sessions.size : [...this.chain.sessions.values()].filter((s) => s.path.split('#')[2] === sub).length;
    return { relayed, sessions };
  }

  /** The wallet directory's users that list `address`, with their wallets and identities (tests only). */
  walletUsers(address: string): {
    userId: string;
    supportCode: string;
    internalId: string;
    scopeId: string;
    wallets: { chain: string; address: string }[];
    identities: { provider: string; sub: string | null; role: string; status: string }[];
  }[] {
    const users = this.d1.db.prepare('SELECT u.user_id, u.token_sub, u.support_code, u.scope_id FROM end_users u WHERE u.user_id IN (SELECT user_id FROM end_user_wallets WHERE address = ?) ORDER BY u.user_id').all(address);
    return users.map((u) => ({
      userId: String(u.token_sub),
      supportCode: String(u.support_code),
      internalId: String(u.user_id),
      scopeId: String(u.scope_id),
      wallets: this.d1.db
        .prepare("SELECT chain, address FROM end_user_wallets WHERE user_id = ? ORDER BY chain = 'evm', address")
        .all(String(u.user_id))
        .map((w) => ({ chain: String(w.chain), address: String(w.address) })),
      identities: this.d1.db
        .prepare('SELECT provider, sub, role, status FROM end_user_identities WHERE user_id = ? ORDER BY role DESC, provider')
        .all(String(u.user_id))
        .map((i) => ({ provider: String(i.provider), sub: i.sub === null ? null : String(i.sub), role: String(i.role), status: String(i.status) })),
    }));
  }

  // ---- control ----

  private async controlEndpoint(req: Request, url: URL): Promise<Response> {
    // Pages can't reach these: no CORS, and a browser request always carries an Origin on POST.
    if (req.headers.get('origin') !== null) return json(403, { error: 'forbidden' });
    const p = url.pathname;
    if (p === '/__e2e/health') return json(200, { ok: true, fingerprint: this.fingerprint });
    if (p === '/__e2e/google-key' && req.method === 'GET' && this.googleKey) return json(200, await this.googleKey());
    if (p === '/__e2e/chain' && req.method === 'GET') return json(200, this.chainView(url.searchParams.get('sub')));
    if (p === '/__e2e/wallets' && req.method === 'GET') return json(200, this.walletUsers(url.searchParams.get('address') ?? ''));
    if (p === '/__e2e/apps' && req.method === 'POST') return json(201, this.createApp((await req.json()) as AppSpec));
    const m = /^\/__e2e\/apps\/(pk_(?:test|live)_[1-9A-HJ-NP-Za-km-z]+)\/(revoke|shares)$/u.exec(p);
    if (m?.[2] === 'revoke' && req.method === 'POST') return json(200, { revoked: this.revokeApp(m[1] as string) });
    if (m?.[2] === 'shares' && req.method === 'GET') return json(200, this.shares(m[1] as string));
    return json(404, { error: 'not_found' });
  }
}
