import { KeyPair } from '@near-js/crypto';
import { baseEncode } from '@near-js/utils';
import { bls12_381 } from '@noble/curves/bls12-381';
import { createExecutionContext, waitOnExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import worker from '../src/index.ts';
import { ckdPayload, createProofPayload, revokePayload, sessionMessage, sessionNonce } from '../src/session-crypto.ts';
import { NearMock, type RsaSigner, rsaSigner } from './near-mock.ts';

export const GOOGLE_ISS = 'https://accounts.google.com';
export const ORIGIN = 'https://wallet.example.com';
/**
 * The claims refused by name (docs/batch-b-spec.md "Claim allow-list"), as @hana-id/core NAMED_PII_CLAIMS; the worker
 * tests can't import core's root (scripts/test/relayed-tokens.test.ts checks the two lists agree).
 */
export const NAMED_PII_CLAIMS: readonly string[] = ['hd', 'email', 'email_verified', 'name', 'picture', 'given_name', 'family_name', 'locale', 'profile'];
/** "Google": the RSA key behind the mock JWKS that every chain() serves. */
export const google = await rsaSigner('google-test-kid');

let counter = 0;
/** Unique-ish suffix so tests don't share rate-limit windows or cache entries. */
export const uid = (): string => `${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
/** A valid-looking base58 publishable key. */
export const newKey = (prefix: 'pk_test_' | 'pk_live_' = 'pk_test_'): string => {
  const alphabet = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let s = '';
  for (let i = 0; i < 32; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return prefix + s;
};

export interface SeededApp {
  id: string;
  key: string;
  scope: string;
}

export async function seedPlan(id: string, perMinute: number, perDay: number, perIpMinute: number): Promise<void> {
  await env.DB.prepare('INSERT INTO plans (id, per_minute, per_day, per_ip_minute) VALUES (?1, ?2, ?3, ?4)').bind(id, perMinute, perDay, perIpMinute).run();
}

/**
 * An app as the hot DB holds it after migration 0006: its scope row (created when missing, in `org_legacy`, with the
 * environment its key's prefix names and `first_session_at` set unless `firstSession: null`), the app row, its key in
 * `app_keys`, and its origins in force (`active_from = 0`). A key on a scope of the other environment is refused by
 * the 0006 triggers, as in a deployed env.
 */
export async function seedApp(
  opts: { scope?: string; key?: string; status?: string; suspendedBy?: number; plan?: string; origins?: string[]; firstSession?: number | null; firstLogin?: number | null; db?: D1Database } = {},
): Promise<SeededApp> {
  const db = opts.db ?? env.DB;
  const id = `app_${uid()}`;
  const key = opts.key ?? newKey();
  const scope = opts.scope ?? `s${uid()}`;
  const now = Date.now();
  const environment = key.startsWith('pk_live_') ? 'live' : 'test';
  await db
    .prepare("INSERT OR IGNORE INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, 'org_legacy', ?2, ?3, ?4, ?4)")
    .bind(scope, environment, opts.firstSession === undefined ? now : opts.firstSession, now)
    .run();
  await db.prepare('INSERT INTO apps (id, name, scope_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, ?5, ?6)')
    .bind(id, `Test ${id}`, scope, key, opts.status ?? 'active', opts.plan ?? 'free')
    .run();
  // A given `db` may predate migration 0016 (rpc-issuer's pre-0010 database), so it isn't marked.
  const firstLogin = opts.firstLogin === undefined ? now : opts.firstLogin;
  if (!opts.db && firstLogin !== null) await db.prepare('UPDATE apps SET first_login_at = ?2 WHERE id = ?1').bind(id, firstLogin).run();
  if (opts.suspendedBy) await db.prepare('UPDATE apps SET suspended_by = ?2 WHERE id = ?1').bind(id, opts.suspendedBy).run();
  await db.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, id, key, now).run();
  for (const origin of opts.origins ?? [ORIGIN]) await db.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(id, origin).run();
  return { id, key, scope };
}

/**
 * Gives the app's key the other environment's prefix by a direct D1 edit (app_keys has no update trigger), so the
 * gate's scope_conflict check, which the 0006 triggers otherwise make unreachable, can be tested.
 */
export async function forgeKeyEnvironment(app: SeededApp): Promise<SeededApp> {
  const key = newKey(app.key.startsWith('pk_live_') ? 'pk_test_' : 'pk_live_');
  await env.DB.prepare('UPDATE app_keys SET key = ?2 WHERE key = ?1').bind(app.key, key).run();
  return { ...app, key };
}

export async function call(
  path: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: unknown;
    rawBody?: string;
    /** Bindings to override for this request (e.g. DO_LOCATION_HINT). */
    env?: Partial<typeof env>;
    /** Incoming `request.cf` (e.g. `{ colo: 'SIN' }`). */
    cf?: Record<string, unknown>;
    /** Execution context to pass instead of a fresh one (its waitUntil promises are then the caller's to await). */
    exec?: ExecutionContext;
  } = {},
): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  let body: string | undefined;
  if (init.rawBody !== undefined) body = init.rawBody;
  else if (init.body !== undefined) {
    body = JSON.stringify(init.body);
    headers.set('content-type', 'application/json');
  }
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', `10.0.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
  const request = new Request(`https://api.test${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, cf: init.cf }) as Request<unknown, IncomingRequestCfProperties>;
  const bindings = init.env ? { ...env, ...init.env } : env;
  if (init.exec) return worker.fetch(request, bindings, init.exec);
  const ctx = createExecutionContext();
  const res = await worker.fetch(request, bindings, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

export const appHeaders = (app: { key: string }, origin = ORIGIN): Record<string, string> => ({ 'x-hana-key': app.key, origin });

export const bytes = (n: number, fill: number): number[] => Array.from({ length: n }, (_, i) => (fill + i) % 256);

/** Session key pairs by public key (JSON of the byte array), so bodies can be signed by the right key. */
const sessionKeys = new Map<string, KeyPair>();

/** A fresh Ed25519 session key; returns its 32-byte public key. */
export function newSessionKey(): number[] {
  const kp = KeyPair.fromRandom('ed25519');
  const pk = [...kp.getPublicKey().data];
  sessionKeys.set(JSON.stringify(pk), kp);
  return pk;
}

/** The key pair behind a test session key (tests that sign custom messages). */
export function sessionKeyPair(spk: number[]): KeyPair {
  const kp = sessionKeys.get(JSON.stringify(spk));
  if (!kp) throw new Error('Unknown test session key');
  return kp;
}

/** Ed25519 signature of the session key over sessionMessage(counter, payload). */
export async function signSession(spk: number[], counter: number, payload: Uint8Array): Promise<number[]> {
  return [...sessionKeyPair(spk).sign(await sessionMessage(counter, payload)).signature];
}

/**
 * A /v1/sessions body with a genuine RS256 token (signed by `google`) whose nonce commits to the body for `scope` on
 * SIGNER_ACCOUNT. `overrides` replace body fields after the nonce is computed only when `jwt` is among them; `claims`
 * replace token claims (e.g. `nonce`, `exp`, `aud`); `signer` signs the token (default `google`).
 */
export async function sessionBody(
  scope: string,
  aud: string,
  overrides: Record<string, unknown> = {},
  claims: Record<string, unknown> = {},
  signer: RsaSigner = google,
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    sessionPublicKey: newSessionKey(),
    expiresAtMs: Date.now() + 60 * 60 * 1000,
    salt: bytes(16, 3),
    keyIndex: 0,
    maxUses: 10,
    ...overrides,
  };
  if ('jwt' in overrides) return body;
  let nonce = 'unused';
  try {
    const input = {
      signer: env.SIGNER_ACCOUNT,
      scopeId: scope,
      sessionPublicKey: body.sessionPublicKey as number[],
      expiresAtMs: body.expiresAtMs as number,
      keyIndex: body.keyIndex as number,
      maxUses: body.maxUses as number,
      salt: body.salt as number[],
    };
    nonce = await sessionNonce(input);
    // The session key's proof of possession (D137), as POST /v1/sessions requires it (/v1/login replaces it).
    if (!('signature' in overrides)) body.signature = await signSession(input.sessionPublicKey, 0, await createProofPayload(input));
  } catch {
    // Malformed fields (shape tests): any nonce will do, the request is rejected first.
  }
  body.jwt = await signer.sign({ iss: GOOGLE_ISS, aud, sub: '1234567890', nonce, exp: Math.floor(Date.now() / 1000) + 3600, ...claims });
  return body;
}

/** A well-formed BLS app key (3·G1, 3·G2): /v1/derive refuses undecodable points and the identity (APIW-4). */
export const DERIVE_KEY = {
  pk1: `bls12381g1:${baseEncode(bls12_381.G1.ProjectivePoint.BASE.multiply(3n).toRawBytes(true))}`,
  pk2: `bls12381g2:${baseEncode(bls12_381.G2.ProjectivePoint.BASE.multiply(3n).toRawBytes(true))}`,
};

/** A /v1/derive body signed by the session key (unless `signature` is overridden). */
export async function deriveBody(spk: number[], overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const b: Record<string, unknown> = { sessionPublicKey: spk, counter: 1, pk1: DERIVE_KEY.pk1, pk2: DERIVE_KEY.pk2, ...overrides };
  if (!('signature' in overrides)) b.signature = await signSession(spk, b.counter as number, ckdPayload(b.pk1 as string, b.pk2 as string));
  return b;
}

/** A /v1/sessions/revoke body signed by the session key (unless `signature` is overridden). */
export async function revokeBody(spk: number[], overrides: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const b: Record<string, unknown> = { sessionPublicKey: spk, counter: 2, ...overrides };
  if (!('signature' in overrides)) b.signature = await signSession(spk, b.counter as number, revokePayload());
  return b;
}

export interface Chain extends NearMock {
  sessions: Map<string, Record<string, unknown>>;
  /** aud → scope id (registered own clients, provider google). */
  clients: Record<string, string>;
  /** Shared Google client ids in force. */
  shared: string[];
  /** get_config().pending_shared_clients. */
  pendingShared: unknown[];
  /** Exit Google client ids in force; null: a pre-v4 contract (no such fields in get_config). */
  exit: (string | [string, string])[] | null;
  /** get_config().pending_exit_clients (contract v4). */
  pendingExit: unknown[];
  /** Scopes with allow_shared. */
  allowShared: Set<string>;
  /** Scope ids get_scope answers null for. */
  missingScopes: Set<string>;
  /** Google kids active on chain (get_issuer); `google`'s kid by default. */
  activeKids: Set<string>;
  /** get_config().paused. */
  paused: boolean;
}

/**
 * A NearMock wired with a tiny registry: `clients` maps aud → scope, `shared` lists shared clients, `allowShared` the
 * scopes that allow them. create_session resolves the scope like the contract (own client → its scope, which must be
 * the `scope_id` argument; shared client → `scope_id` if it allows shared login). Sessions are stored and served by
 * get_session and session_key_in_use; derive_key and revoke_session enforce the contract's session-use rules (live
 * session, counter = used + 1, the use limit for derive_key) and revoke_session leaves a tombstone, as on chain.
 * Google's JWKS serves `google`, whose kid is active on chain (`activeKids`, get_issuer); `paused` is get_config's.
 */
export function chain(clients: Record<string, string> = {}, opts: { shared?: string[]; allowShared?: string[] } = {}): Chain {
  const near: Chain = Object.assign(new NearMock(), {
    sessions: new Map<string, Record<string, unknown>>(),
    clients,
    shared: opts.shared ?? [],
    pendingShared: [] as unknown[],
    exit: null,
    pendingExit: [] as unknown[],
    allowShared: new Set(opts.allowShared ?? []),
    missingScopes: new Set<string>(),
    activeKids: new Set([google.jwk.kid]),
    paused: false,
  });
  near.jwks = { keys: [google.jwk] };
  near.views.get_issuer = (a) => (a.provider === 'google' ? { provider: 'google', iss_values: [GOOGLE_ISS, 'accounts.google.com'], kids: [...near.activeKids] } : null);
  near.views.scope_for_client = (a) => (a.provider === 'google' ? (near.clients[a.aud as string] ?? null) : null);
  near.views.get_session = (a) => {
    const s = near.sessions.get(JSON.stringify(a.session_public_key));
    return s && !s.revoked ? s : null;
  };
  near.views.session_key_in_use = (a) => {
    const s = near.sessions.get(JSON.stringify(a.session_public_key));
    return s !== undefined && (s.expires_at_ms as number) > Date.now();
  };
  near.views.get_config = () => ({
    owner: 'admin.test.near',
    console_audiences: [],
    shared_clients: near.shared.map((aud) => ['google', aud]),
    pending_shared_clients: near.pendingShared,
    ...(near.exit ? { exit_clients: near.exit.map((e) => (typeof e === 'string' ? ['google', e] : e)), pending_exit_clients: near.pendingExit } : {}),
    change_delay_ms: 0,
    public_registration: false,
    paused: near.paused,
  });
  near.views.get_scope = (a) => {
    const id = a.scope_id as string;
    if (near.missingScopes.has(id)) return null;
    const own = Object.entries(near.clients).filter(([, s]) => s === id).map(([aud]) => ['google', aud]);
    return { id, owners: [{ Near: { account_id: 'owner.test.near' } }], clients: own, pending: [], action_nonce: 0, created_at_ms: 1, allow_shared: near.allowShared.has(id) };
  };
  near.contract.create_session = (a) => {
    const aud = JSON.parse(atob((a.jwt as string).split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))).aud as string;
    const scopeId = a.scope_id as string;
    const own = near.clients[aud];
    if (own !== undefined) {
      if (own !== scopeId) throw new Error('Token is for another app');
    } else if (near.shared.includes(aud)) {
      if (!near.allowShared.has(scopeId)) throw new Error('Scope does not allow shared login');
    } else throw new Error('Token is for an unregistered app');
    const session = { path: `${scopeId}#google#1234567890#${a.key_index}`, scope_id: scopeId, expires_at_ms: a.expires_at_ms, max_uses: a.max_uses, used: 0 };
    near.sessions.set(JSON.stringify(a.session_public_key), session);
    return session;
  };
  /** The contract's live_session: the stored session unless missing or revoked. */
  const live = (a: Record<string, unknown>): Record<string, unknown> => {
    const s = near.sessions.get(JSON.stringify(a.session_public_key));
    if (!s || s.revoked) throw new Error('No such session');
    return s;
  };
  // use_session's checks in the contract's order (the signature was checked by the API); a use bumps `used`.
  near.contract.derive_key = (a) => {
    const s = live(a);
    if (Date.now() >= (s.expires_at_ms as number)) throw new Error('Session expired');
    if ((s.used as number) >= (s.max_uses as number)) throw new Error('Session use limit reached');
    if (a.counter !== (s.used as number) + 1) throw new Error('Wrong counter (replayed or out of order)');
    near.sessions.set(JSON.stringify(a.session_public_key), { ...s, used: a.counter });
    return { big_y: 'bls12381g1:Y', big_c: 'bls12381g1:C' };
  };
  near.contract.revoke_session = (a) => {
    // Like the contract: no expiry or use limit check, `used` unchanged, and a revoked session stays as a tombstone
    // until it expires (get_session hides it).
    const s = live(a);
    if (a.counter !== (s.used as number) + 1) throw new Error('Wrong counter (replayed or out of order)');
    near.sessions.set(JSON.stringify(a.session_public_key), { ...s, revoked: true });
    return null;
  };
  near.install();
  return near;
}

/**
 * The instant a test pinned by `startOfMinuteClock` starts at, for a real time `t`: a second into a minute, and never
 * into the last minute of an hour (that one is skipped for the next hour's first), so a fixed minute window has 59 s
 * left and a fixed hour or UTC-day window at least that (every UTC day starts on an hour). Exported for its own test.
 */
export function minuteStartFor(t: number): number {
  const target = t - (t % 60_000) + 1000;
  return 3_600_000 - (target % 3_600_000) < 60_000 ? target + 60_000 : target;
}

/**
 * For tests of fixed windows on RateLimiter objects (minute, hour, UTC day): shifts this isolate's clock (the Worker and
 * its objects share it with the test) to `minuteStartFor(now)`, with time still running, so a run never straddles a
 * window boundary. Call it first in the test, before anything is counted. Undone by vi.restoreAllMocks().
 */
export async function startOfMinuteClock(): Promise<void> {
  const { vi } = await import('vitest');
  // On top of a clock already moved (a second call, or a test's own mock): spying again reuses the same spy, so the
  // clock it moves is the spy's current implementation, never the spy itself (that would recurse).
  const now = Date.now;
  const real = vi.isMockFunction(now) ? (now.getMockImplementation() ?? (() => new Date().getTime())) : now.bind(Date);
  const t = real();
  const offset = t - minuteStartFor(t);
  vi.spyOn(Date, 'now').mockImplementation(() => real() - offset);
}

/**
 * For tests of Cloudflare Rate Limiting bindings (their own clock, outside this isolate): waits, if needed, until at
 * least `headroomMs` remain in the current minute, so the counted requests fall into one window.
 */
export async function minuteHeadroom(headroomMs = 8000): Promise<void> {
  const left = 60_000 - (Date.now() % 60_000);
  if (left < headroomMs) await new Promise((r) => setTimeout(r, left + 250));
}
