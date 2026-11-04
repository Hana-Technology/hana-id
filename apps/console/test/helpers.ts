// Shared helpers of the console Worker tests: StaffRpc as the admin Worker gets it, its callers (staff, the admin
// Worker's cron), CONSOLE_DB seeds, requests to the console's fetch with or without the CSRF headers, and hot-DB seeds
// for the real API behind the `API` binding.
import { b64url, newId, newPublishableKey, randomBytes, sha256 } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { vi } from 'vitest';
import { StaffRpc } from '../src/staff-rpc.ts';

export const ORIGIN = 'https://console.test';
export const DELAY = 60_000; // TEST_MANIFEST.ownerGrantDelayMs
export const HOUR = 60 * 60_000;
export const DAY = 24 * HOUR;
export const db = env.CONSOLE_DB;

let seq = 0;
export const uid = (): string => `${Date.now().toString(36)}${(++seq).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
export const rid = (): string => `req_${uid()}`;

export const staffRpc = (): StaffRpc => new StaffRpc(createExecutionContext(), env);
export const hana = (id = 'access-sub-staff-1') => ({ actor: { kind: 'hana' as const, id, email: 'staff@hana.example' }, requestId: rid(), clientIp: '198.51.100.2' });
export const system = () => ({ actor: { kind: 'system' as const, id: 'admin-cron' }, requestId: rid(), clientIp: '198.51.100.3' });
export const member = (id = newId('user')) => ({ actor: { kind: 'member' as const, id, sub: 'sub-1', email: 'owner@partner.example', sessionHash: 'A'.repeat(43) }, requestId: rid(), clientIp: '203.0.113.7' });

/** Seeds an org (partner by default) and returns its id. */
export async function seedOrg(o: { kind?: 'partner' | 'internal'; status?: 'active' | 'frozen'; requiredHd?: string | null } = {}): Promise<string> {
  const id = newId('org');
  await db.prepare('INSERT INTO orgs (id, name, kind, status, required_hd, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, `Org ${id}`, o.kind ?? 'internal', o.status ?? 'active', o.requiredHd ?? null, Date.now()).run();
  return id;
}

export interface SeededUser {
  id: string;
  sub: string;
  email: string;
}

export async function seedUser(o: { disabled?: boolean; email?: string } = {}): Promise<SeededUser> {
  const id = newId('user');
  const sub = `sub-${uid()}`;
  const email = o.email ?? `${uid()}@partner.example`;
  await db.prepare('INSERT INTO console_users (id, provider, sub, email, created_at, disabled_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, 'google', sub, email, Date.now(), o.disabled ? Date.now() : null).run();
  return { id, sub, email };
}

export async function seedMember(orgId: string, role: 'owner' | 'viewer', user?: SeededUser): Promise<SeededUser> {
  const u = user ?? (await seedUser());
  await db.prepare('INSERT INTO members (org_id, user_id, role, role_since, added_by, added_at) VALUES (?, ?, ?, ?, ?, ?)').bind(orgId, u.id, role, Date.now(), 'test', Date.now()).run();
  return u;
}

/** A live session row for a user; returns its id hash. */
export async function seedSession(userId: string): Promise<Uint8Array> {
  const idHash = await sha256(randomBytes(32));
  const now = Date.now();
  await db.prepare('INSERT INTO console_sessions (id_hash, user_id, auth_at, last_seen_at, absolute_expires_at) VALUES (?, ?, ?, ?, ?)').bind(idHash, userId, now, now, now + 12 * HOUR).run();
  return idHash;
}

export async function liveSessions(userId: string): Promise<number> {
  return (await db.prepare('SELECT COUNT(*) AS n FROM console_sessions WHERE user_id = ? AND revoked_at IS NULL').bind(userId).first<number>('n'))!;
}

/** A link token and its b64url sha256, as the admin Worker computes them (the console never sees the key). */
export async function linkPair(): Promise<{ token: Uint8Array; tokenB64: string; hash: Uint8Array; hashB64: string }> {
  const token = randomBytes(32);
  const hash = await sha256(token);
  return { token, tokenB64: b64url(token), hash, hashB64: b64url(hash) };
}

/** The effective role of a member now, as the staff view computes it. */
export async function roleOf(orgId: string, userId: string): Promise<string | undefined> {
  const r = await staffRpc().listMembers({ ...hana(), orgId });
  if (!r.ok) throw new Error(r.code);
  return r.members.find((m) => m.userId === userId)?.role;
}

export async function auditRows(where: string, ...binds: unknown[]): Promise<{ action: string; actor_kind: string; actor_id: string; target: string | null; org_id: string | null; details_json: string; outcome: string }[]> {
  return (await db.prepare(`SELECT action, actor_kind, actor_id, target, org_id, details_json, outcome FROM audit_log WHERE ${where} ORDER BY seq`).bind(...binds).all<{ action: string; actor_kind: string; actor_id: string; target: string | null; org_id: string | null; details_json: string; outcome: string }>()).results;
}

/** The console's CSRF headers, as the SPA sends them. */
export const CSRF = { 'sec-fetch-site': 'same-origin', origin: ORIGIN, 'x-hana-console': '1', 'content-type': 'application/json' };

/** A request to the console Worker's fetch (the real default export, over its loopback binding). */
export function request(path: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; host?: string; ip?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers ?? {});
  if (!headers.has('cf-connecting-ip')) headers.set('cf-connecting-ip', init.ip ?? `10.${seq % 250}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`);
  const body = init.body === undefined ? undefined : typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  return (exports as unknown as { default: Fetcher }).default.fetch(new Request(`${init.host ?? ORIGIN}${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body }));
}

/** A POST with the CSRF headers. */
export const post = (path: string, body: unknown, o: { headers?: Record<string, string>; ip?: string } = {}) => request(path, { method: 'POST', body, headers: { ...CSRF, ...(o.headers ?? {}) }, ...(o.ip ? { ip: o.ip } : {}) });

/**
 * Moves the isolate's clock by `ms` (time keeps running): the Worker, D1's callers and the tests share it. Returns a
 * function that moves it further.
 */
export function shiftClock(ms: number): (more: number) => void {
  const real = Date.now.bind(Date);
  let offset = ms;
  vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
  return (more) => void (offset += more);
}

// ---- the hot DB behind the real API (shared with the auxiliary API Worker as HOT_DB) ----

export interface HotApp {
  id: string;
  scope: string;
  org: string;
}

/** An app of a fresh org with one security contact (apps/api/test/rpc-helpers.ts orgApp, by SQL). */
export async function seedHotApp(org = newId('org'), origins = ['https://app.partner.example']): Promise<HotApp> {
  const hot = env.HOT_DB;
  const id = `app_${uid()}`;
  const scope = `s${uid().toLowerCase()}`;
  const now = Date.now();
  const key = newPublishableKey('test');
  await hot.prepare("INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at) VALUES (?1, 'org_legacy', 'test', ?2, ?2, ?2)").bind(scope, now).run();
  await hot.prepare("INSERT INTO apps (id, name, scope_id, publishable_key, status, plan) VALUES (?1, ?2, ?3, ?4, 'active', 'free')").bind(id, `Test ${id}`, scope, key).run();
  await hot.prepare("INSERT INTO app_keys (id, app_id, key, created_by, created_at) VALUES (?1, ?2, ?3, 'test', ?4)").bind(`key_${uid()}`, id, key, now).run();
  for (const o of origins) await hot.prepare('INSERT INTO app_origins (app_id, origin, active_from) VALUES (?1, ?2, 0)').bind(id, o).run();
  await hot.prepare('UPDATE scopes SET org_id = ?2, assigned_at = ?3 WHERE scope_id = ?1').bind(scope, org, now - 10 * DELAY).run();
  await hot.prepare('INSERT OR IGNORE INTO org_security_contacts (org_id, email, added_by, added_at) VALUES (?1, ?2, ?3, ?4)').bind(org, 'security@partner.example', 'test', now).run();
  return { id, scope, org };
}
