// Helpers for the batch C5 RPC tests (rpc-*.test.ts): apps in a real org with security contacts, the three caller
// kinds, the entrypoints constructed as the console and the admin Worker would get them, and a clock that moves each
// test into its own breaker window and a full hot-DB budget (the `console-rpc` object is shared by the whole file).
import { newId } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { ORIGIN, type SeededApp, newKey, seedApp, uid } from './helpers.ts';

export const HOUR = 60 * 60 * 1000;
/** The test manifest's appChangeDelayMs (scripts/gen-wrangler.ts TEST_MANIFEST). */
export const DELAY = 60_000;

export const consoleRpc = (): ConsoleRpc => new ConsoleRpc(createExecutionContext(), env);
export const adminRpc = (): AdminRpc => new AdminRpc(createExecutionContext(), env);

export const rid = (): string => `req_${uid()}`;
export const newOrg = (): string => newId('org');

export interface OrgApp extends SeededApp {
  org: string;
}

/**
 * An app of a fresh org (or `org`): seeded in org_legacy (helpers.ts seedApp), then its scope moved to the org (the
 * trigger moves the app), assigned long enough ago that staff proposals aren't held back, with one security contact.
 */
export async function orgApp(
  o: { org?: string; live?: boolean; origins?: string[]; firstSession?: number | null; assignedAt?: number; scope?: string; contacts?: string[] } = {},
): Promise<OrgApp> {
  const org = o.org ?? newOrg();
  const app = await seedApp({ key: newKey(o.live ? 'pk_live_' : 'pk_test_'), origins: o.origins ?? [ORIGIN], firstSession: o.firstSession, ...(o.scope ? { scope: o.scope } : {}) });
  await env.DB.prepare('UPDATE scopes SET org_id = ?2, assigned_at = ?3 WHERE scope_id = ?1').bind(app.scope, org, o.assignedAt ?? Date.now() - 10 * DELAY).run();
  for (const email of o.contacts ?? ['security@partner.example']) {
    await env.DB.prepare('INSERT OR IGNORE INTO org_security_contacts (org_id, email, added_by, added_at) VALUES (?1, ?2, ?3, ?4)').bind(org, email, 'test', Date.now()).run();
  }
  return { ...app, org };
}

export const member = (sub = 'owner-sub-1') => ({
  actor: { kind: 'member' as const, id: newId('user'), sub, email: 'owner@partner.example', sessionHash: 'A'.repeat(43) },
  requestId: rid(),
  clientIp: '203.0.113.7',
});
export const hana = () => ({ actor: { kind: 'hana' as const, id: 'access-sub-staff-1', email: 'staff@hana.example' }, requestId: rid(), clientIp: '198.51.100.2' });
export const system = () => ({ actor: { kind: 'system' as const, id: 'admin-cron' }, requestId: rid(), clientIp: '198.51.100.3' });
export const link = (changeId: string) => ({ actor: { kind: 'link' as const, id: changeId }, requestId: rid(), clientIp: '203.0.113.9' });

let slot = 0;
/** The real clock, taken before any test mocks it. */
const realNow = Date.now.bind(Date);
/**
 * Moves this isolate's clock (the Worker, its objects and D1's callers share it) to its own far-future window, with time
 * still running, so each test gets a fresh breaker hour and a full budget. `freeze` stops it (budget tests).
 */
export function ownClock(opts: { freeze?: boolean } = {}): { now: () => number; advance: (ms: number) => void } {
  const real = realNow;
  const start = real();
  let offset = (++slot) * 3 * HOUR;
  vi.spyOn(Date, 'now').mockImplementation(() => (opts.freeze ? start : real()) + offset);
  return { now: () => Date.now(), advance: (ms) => void (offset += ms) };
}

export async function rows<T = Record<string, unknown>>(sql: string, ...args: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...args).all<T>()).results;
}

export async function ledgerCount(): Promise<number> {
  return (await env.DB.prepare('SELECT COUNT(*) AS n FROM app_changes').first<{ n: number }>())!.n;
}

export async function appRow(id: string): Promise<Record<string, unknown>> {
  return (await env.DB.prepare('SELECT * FROM apps WHERE id = ?1').bind(id).first())!;
}

/** A cancel link token and its hash (b64url), as the admin Worker computes them. */
export function linkToken(): { token: string; hash: Promise<string> } {
  const t = crypto.getRandomValues(new Uint8Array(32));
  const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
  return { token: b64(t), hash: crypto.subtle.digest('SHA-256', t).then((d) => b64(new Uint8Array(d))) };
}

/** A member-proposed guarded change as batch C6 will write it (API-verified step-up: `proposer_sub` set). */
export async function memberProposal(app: SeededApp, c: { kind: 'origin_add' | 'policy_set' | 'raw_sign_on'; origin?: string; policyJson?: string; policyId?: string; requestId?: string }): Promise<string> {
  const id = newId('guardedChange');
  await env.DB.prepare(
    `INSERT INTO guarded_changes (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_id)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', 'member', 'usr_member', 'owner-sub-1', ?7, ?8)`,
  )
    .bind(id, app.id, c.kind, c.origin ?? null, c.policyJson ?? null, c.policyId ?? null, Date.now(), c.requestId ?? `r_${id}`)
    .run();
  if (c.kind === 'origin_add') await env.DB.prepare('INSERT INTO app_origins (app_id, origin, active_from, change_id) VALUES (?1, ?2, NULL, ?3)').bind(app.id, c.origin, id).run();
  return id;
}
