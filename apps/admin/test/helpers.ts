// Shared helpers of the admin Worker tests: a throwaway Access signing key and its certs endpoint, staff requests to the
// Worker's fetch, a fake EmailSender, an in-memory ops store, a fake NEAR RPC, and seeds for the real API's hot DB and
// the real console's CONSOLE_DB (shared with the auxiliary Workers).
import { newId, newPublishableKey } from '@hana-id/console-core';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { resetAccessVerifier } from '../src/access.ts';
import type { ScopeState } from '../src/email/messages.ts';
import { type EmailMessage, type EmailSender, type SendResult, outbound } from '../src/email/sender.ts';
import type { OpsStore, WatchRow } from '../src/ops.ts';
import { opsSource } from '../src/ops.ts';

export const ADMIN = 'https://admin.test';
export const CONSOLE = 'https://console.test';
export const TEAM = 'hana-test.cloudflareaccess.com';
export const CERTS_URL = `https://${TEAM}/cdn-cgi/access/certs`;
export const AUD = 'ab'.repeat(32);
export const STAFF_EMAIL = 'staff@hana.example';
export const STAFF_SUB = '7335d417-61da-459d-899c-0a01c76a2b94';
export const ALIAS = 'security@hana.example';
export const RPC = 'https://rpc.test.invalid';
export const DELAY = 60_000;

let seq = 0;
export const uid = (): string => `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// ---- Access ----

const b64url = (data: string | Uint8Array): string => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
};

export interface Signer {
  jwk: Record<string, string>;
  sign(claims: Record<string, unknown>): Promise<string>;
}

export async function rsaSigner(kid: string): Promise<Signer> {
  const pair = (await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  return {
    jwk: { kid, n: pub.n!, e: pub.e!, kty: 'RSA', alg: 'RS256', use: 'sig' },
    async sign(claims) {
      const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)));
      return `${input}.${b64url(sig)}`;
    },
  };
}

/** A signer over an RSA private JWK (the suite's Access key, made once per run in vitest.config.ts). */
export async function jwkSigner(privateJwk: JsonWebKey & { kid?: string }, kid: string): Promise<Signer> {
  const key = await crypto.subtle.importKey('jwk', { ...privateJwk, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  return {
    jwk: { kid, n: privateJwk.n!, e: privateJwk.e!, kty: 'RSA', alg: 'RS256', use: 'sig' },
    async sign(claims) {
      const input = `${b64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}`;
      const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input)));
      return `${input}.${b64url(sig)}`;
    },
  };
}

let signer: Signer | null = null;
/**
 * The suite's Access signer: the same key in every test file, because the email issuer (an auxiliary Worker, C8b)
 * verifies staff JWTs against the certs its fake Access team serves for that key.
 */
export const accessSigner = async (): Promise<Signer> => (signer ??= await jwkSigner(JSON.parse(env.TEST_ACCESS_JWK) as JsonWebKey, 'access-test-kid'));

/** Claims shaped like a real Access application token for the staff member. */
export function staffClaims(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return { aud: [AUD], email: STAFF_EMAIL, exp: now + 3600, iat: now, nbf: now, iss: `https://${TEAM}`, type: 'app', identity_nonce: 'n', sub: STAFF_SUB, country: 'MY', ...over };
}

export const staffJwt = async (over: Record<string, unknown> = {}, s?: Signer): Promise<string> => (s ?? (await accessSigner())).sign(staffClaims(over));

// ---- the fake network: Access certs and NEAR's get_scope ----

export const chain = new Map<string, unknown>();
/**
 * `get_identity` and `get_account` answers (C8b), keyed `<method>:<scope>:<provider>:<sub>`; a missing key answers as
 * NEAR does for an unknown identity (`get_account`: null) or fails (`get_identity`: a 502, "chain unavailable").
 */
export const identityViews = new Map<string, unknown>();
export const viewKey = (method: 'get_identity' | 'get_account', scope: string, provider: string, sub: string): string => `${method}:${scope}:${provider}:${sub}`;
export const nearCalls: string[] = [];
export let nearDown = false;
export const setNearDown = (v: boolean): void => {
  nearDown = v;
};

// ---- the fake watchdog (C14): its status endpoint, as apps/watchdog/src/status.ts answers ----

export const WATCHDOG = 'https://hana-id-watchdog-test.watchdog-test.workers.dev';
/** The suite's bearer (vitest.config.ts TEST_KEYS); the fake watchdog answers 401 to anything else. */
export const WATCHDOG_TOKEN = 'test-suite-only-watchdog-status-token-placeholder';

export interface WatchdogCall {
  method: string;
  path: string;
  authorization: string | null;
  redirect: string | undefined;
  body: unknown;
}

/** Every call the fake watchdog got, and how it answers (replace `answer` per test). */
export const watchdog: { calls: WatchdogCall[]; answer: (c: WatchdogCall, init?: RequestInit) => Response | Promise<Response> } = {
  calls: [],
  answer: () => Response.json({ error: 'Not found', code: 'not_found' }, { status: 404 }),
};

/** Stubs the isolate's fetch: the Access certs, NEAR RPC and the watchdog are answered here; anything else fails the test. */
export async function stubNetwork(opts: { certsDown?: boolean } = {}): Promise<void> {
  const s = await accessSigner();
  resetAccessVerifier();
  watchdog.calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith(`${WATCHDOG}/`)) {
      const u = new URL(url);
      const headers = new Headers(init?.headers);
      const raw = init?.body === undefined ? undefined : String(init.body);
      const call: WatchdogCall = { method: init?.method ?? 'GET', path: `${u.pathname}${u.search}`, authorization: headers.get('authorization'), redirect: init?.redirect, body: raw === undefined ? undefined : (JSON.parse(raw) as unknown) };
      watchdog.calls.push(call);
      if (call.authorization !== `Bearer ${WATCHDOG_TOKEN}`) return Response.json({ error: 'Missing or wrong bearer token', code: 'unauthorized' }, { status: 401 });
      return watchdog.answer(call, init);
    }
    if (url === CERTS_URL) {
      if (opts.certsDown) throw new TypeError('Network connection lost.');
      return Response.json({ keys: [s.jwk] }, { headers: { 'cache-control': 'max-age=300' } });
    }
    if (url === RPC) {
      const body = JSON.parse(String(init?.body ?? (input instanceof Request ? await input.text() : '{}'))) as { params: { method_name: string; args_base64: string } };
      const args = JSON.parse(atob(body.params.args_base64)) as { scope_id: string; provider?: string; sub?: string };
      nearCalls.push(`${body.params.method_name}:${args.scope_id}`);
      if (nearDown) return new Response('bad gateway', { status: 502 });
      if (body.params.method_name === 'get_identity' || body.params.method_name === 'get_account') {
        const key = viewKey(body.params.method_name, args.scope_id, args.provider!, args.sub!);
        if (!identityViews.has(key) && body.params.method_name === 'get_identity') return new Response('bad gateway', { status: 502 });
        const value = identityViews.get(key) ?? null;
        return Response.json({ jsonrpc: '2.0', id: 'admin', result: { result: [...new TextEncoder().encode(JSON.stringify(value))], block_height: 4242 } });
      }
      const value = chain.has(args.scope_id) ? chain.get(args.scope_id) : null;
      return Response.json({ jsonrpc: '2.0', id: 'admin', result: { result: [...new TextEncoder().encode(JSON.stringify(value))] } });
    }
    throw new Error(`Unexpected fetch to ${url}`);
  });
}

/** A scope as get_scope answers it. */
export function chainScope(id: string, s: { owners?: unknown[]; clients?: [string, string][]; allowShared?: boolean; pending?: { id: number; change: unknown; unlock_at_ms: number }[] } = {}) {
  chain.set(id, { id, owners: s.owners ?? [{ Oidc: { provider: 'google', sub: 'owner-sub-1' } }], clients: s.clients ?? [['google', 'client-1.apps.googleusercontent.com']], allow_shared: s.allowShared ?? false, pending: s.pending ?? [], action_nonce: 1, created_at_ms: 1 });
}

// ---- requests ----

export const CSRF = { 'sec-fetch-site': 'same-origin', origin: ADMIN, 'x-hana-admin': '1', 'content-type': 'application/json' };

export interface ReqInit {
  method?: string;
  body?: unknown;
  /** The Access JWT; `null` sends none; default a valid staff token. */
  jwt?: string | null;
  headers?: Record<string, string>;
  host?: string;
  csrf?: boolean;
}

export async function adminRequest(path: string, init: ReqInit = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  const jwt = init.jwt === undefined ? await staffJwt() : init.jwt;
  if (jwt) headers.set('cf-access-jwt-assertion', jwt);
  const method = init.method ?? (init.body !== undefined ? 'POST' : 'GET');
  if (method !== 'GET' && method !== 'HEAD' && init.csrf !== false) for (const [k, v] of Object.entries(CSRF)) if (!headers.has(k)) headers.set(k, v);
  headers.set('cf-connecting-ip', '198.51.100.9');
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${init.host ?? ADMIN}${path}`, { method, headers, body }));
}

export async function json<T = Record<string, unknown>>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ---- email ----

export class FakeEmail implements EmailSender {
  configured = true;
  readonly sent: EmailMessage[] = [];
  readonly attempts: EmailMessage[] = [];
  /** Recipients whose sends fail (the provider refuses). */
  failFor = new Set<string>();

  async send(m: EmailMessage): Promise<SendResult> {
    this.attempts.push(m);
    if (this.failFor.has(m.to)) return { ok: false, error: 'HTTP 500' };
    this.sent.push(m);
    return { ok: true, id: `msg_${this.sent.length}` };
  }

  to(addr: string): EmailMessage[] {
    return this.sent.filter((m) => m.to === addr);
  }

  about(text: string): EmailMessage[] {
    return this.sent.filter((m) => m.text.includes(text));
  }
}

/** Installs a fake sender for code that calls `outbound.email` (the cron). */
export function useFakeEmail(fake = new FakeEmail()): FakeEmail {
  vi.spyOn(outbound, 'email').mockReturnValue(fake);
  return fake;
}

// ---- ops ----

export interface MemoryOpsData {
  state: Map<string, { value: string; updatedAt: number }>;
  snapshots: Map<string, ScopeState & { seenAt: number }>;
  watch: Map<string, WatchRow & { firstSeenAt: number }>;
  writes: string[];
}

export const newOpsData = (): MemoryOpsData => ({ state: new Map(), snapshots: new Map(), watch: new Map(), writes: [] });

/** An in-memory OpsStore over `data` (a "restart" is a new store over the same data). */
export function memoryOps(data: MemoryOpsData): OpsStore {
  return {
    async getState(keys) {
      return new Map(keys.filter((k) => data.state.has(k)).map((k) => [k, data.state.get(k)!]));
    },
    async setState(key, value) {
      data.writes.push(`state:${key}=${value}`);
      data.state.set(key, { value, updatedAt: Date.now() });
    },
    async getSnapshot(scopeId) {
      return data.snapshots.get(scopeId) ?? null;
    },
    async putSnapshot(scopeId, s, seenAt) {
      data.writes.push(`snapshot:${scopeId}`);
      data.snapshots.set(scopeId, { ...structuredClone(s), seenAt });
    },
    async watchRows(scopeId) {
      return [...data.watch.entries()].filter(([k]) => k.startsWith(`${scopeId}#`)).map(([, v]) => ({ changeId: v.changeId, notifiedAt: v.notifiedAt }));
    },
    async markWatch(scopeId, changeId, seenAt, notifiedAt) {
      const k = `${scopeId}#${changeId}`;
      const prev = data.watch.get(k);
      data.watch.set(k, { changeId, firstSeenAt: prev?.firstSeenAt ?? seenAt, notifiedAt: prev?.notifiedAt ?? notifiedAt });
    },
    async close() {},
  };
}

export function useMemoryOps(data = newOpsData()): MemoryOpsData {
  vi.spyOn(opsSource, 'open').mockImplementation(async () => memoryOps(data));
  return data;
}

// ---- seeds ----

export interface HotApp {
  id: string;
  scope: string;
  org: string;
  contact: string;
}

/** An app of an org (fresh by default) with one security contact, in the hot DB behind the real API. */
export async function seedHotApp(org = newId('org'), o: { origins?: string[]; contacts?: string[] } = {}): Promise<HotApp> {
  const hot = env.HOT_DB;
  const id = `app_${uid()}`;
  const scope = `s${uid().toLowerCase()}`;
  const now = Date.now();
  const key = newPublishableKey('test');
  await hot.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, 'org_legacy', 'test', ?2, ?2, ?2)").bind(scope, now).run();
  await hot.prepare("INSERT INTO apps (id, name, scope_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, 'active', 'free')").bind(id, `Test ${id}`, scope, key).run();
  await hot.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, id, key, now).run();
  for (const origin of o.origins ?? ['https://app.partner.example']) await hot.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(id, origin).run();
  await hot.prepare('UPDATE scopes SET org_id = ?2, assigned_at = ?3 WHERE scope_id = ?1').bind(scope, org, now - 10 * DELAY).run();
  const contacts = o.contacts ?? [`sec-${uid()}@partner.example`];
  for (const c of contacts) await hot.prepare('INSERT OR IGNORE INTO org_security_contacts (org_id, email, added_by, added_at) VALUES (?1, ?2, ?3, ?4)').bind(org, c, 'test', now).run();
  return { id, scope, org, contact: contacts[0] ?? '' };
}

export async function hotVersion(appId: string): Promise<{ origins: number; settings: number }> {
  const r = await env.HOT_DB.prepare('SELECT origins_version AS o, settings_version AS s FROM apps WHERE id = ?1').bind(appId).first<{ o: number; s: number }>();
  return { origins: r!.o, settings: r!.s };
}

/** An org in CONSOLE_DB (the id given, so it can match a hot-DB org). */
export async function seedConsoleOrg(id = newId('org'), name = `Org ${id}`): Promise<string> {
  await env.CONSOLE_TEST_DB.prepare("INSERT INTO orgs (id, name, kind, status, created_at) VALUES (?, ?, 'internal', 'active', ?)").bind(id, name, Date.now()).run();
  return id;
}

export interface SeededMember {
  id: string;
  sub: string;
  email: string;
}

export async function seedConsoleMember(orgId: string, role: 'owner' | 'viewer', o: { disabled?: boolean } = {}): Promise<SeededMember> {
  const id = newId('user');
  const sub = `sub-${uid()}`;
  const email = `${uid()}@partner.example`;
  await env.CONSOLE_TEST_DB.prepare("INSERT INTO console_users (id, provider, sub, email, created_at, disabled_at) VALUES (?, 'google', ?, ?, ?, ?)").bind(id, sub, email, Date.now(), o.disabled ? Date.now() : null).run();
  await env.CONSOLE_TEST_DB.prepare('INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(orgId, id, role, Date.now(), 'test', Date.now()).run();
  return { id, sub, email };
}

/** The env with some bindings replaced (to call the Worker or a step with, say, the console down). */
export const envWith = (over: Partial<typeof env>): typeof env => ({ ...env, ...over }) as typeof env;

/** A service binding with some methods replaced (the rest are called on the real binding). */
export function overrideBinding<T extends object>(binding: T, over: Record<string, (...a: unknown[]) => unknown>): T {
  return new Proxy(binding, {
    get: (t, p) => (typeof p === 'string' && p in over ? over[p] : (...args: unknown[]) => (t as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[p]!(...args)),
  });
}

/** A service binding that is down: every call throws, as an unreachable Worker does. */
export function downBinding<T>(): T {
  return new Proxy({}, { get: () => () => Promise.reject(new Error('Service unavailable')) }) as T;
}

export const sha256Hex = async (bytes: Uint8Array): Promise<string> => [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');

/** The token in a link's `#t=` fragment, as bytes. */
export function tokenOf(url: string): Uint8Array {
  const t = /#t=([A-Za-z0-9_-]{43})/u.exec(url)?.[1];
  if (!t) throw new Error('no token in the link');
  const s = atob(t.replace(/-/gu, '+').replace(/_/gu, '/') + '=');
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

export const linkIn = (text: string, path: string): string => {
  const m = new RegExp(`${CONSOLE.replace(/\./gu, '\\.')}${path}[^\\s]*`, 'u').exec(text);
  if (!m) throw new Error(`no ${path} link`);
  return m[0];
};
