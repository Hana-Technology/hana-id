// Helpers for the batch C5 RPC tests (rpc-*.test.ts): apps in a real org with security contacts, the three caller
// kinds, the entrypoints constructed as the console and the admin Worker would get them, and a clock that moves each
// test into its own breaker window and a full hot-DB budget (the `console-rpc` object is shared by the whole file).
import { newId } from '@hana-id/console-core';
import { createExecutionContext } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { vi } from 'vitest';
import { AdminRpc } from '../src/rpc/admin.ts';
import { ConsoleRpc } from '../src/rpc/console.ts';
import { type Chain, GOOGLE_ISS, ORIGIN, type SeededApp, chain, google, newKey, seedApp, uid } from './helpers.ts';

export const HOUR = 60 * 60 * 1000;
/** The test manifest's appChangeDelayMs (scripts/gen-wrangler.ts TEST_MANIFEST). */
export const DELAY = 60_000;

/**
 * ConsoleRpc as the console gets it. With `clock`, each call first moves the clock 2 s on, as a person clicking would,
 * so a test's sequence of calls stays within its org's hot-DB budget (the budget tests call it without).
 */
export const consoleRpc = (clock?: { advance: (ms: number) => void }): ConsoleRpc => {
  const rpc = new ConsoleRpc(createExecutionContext(), env);
  if (!clock) return rpc;
  return new Proxy(rpc, {
    get(t, p) {
      const v: unknown = Reflect.get(t, p);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        clock.advance(2000);
        return (v as (...a: unknown[]) => unknown).apply(t, args);
      };
    },
  });
};
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
 * still running, so each test gets a fresh breaker hour and a full budget. `freeze` stops it (budget tests). The window
 * starts a second into a clock hour, so a test never straddles the fixed hours (the breaker event's once an hour).
 */
export function ownClock(opts: { freeze?: boolean } = {}): { now: () => number; advance: (ms: number) => void } {
  const real = realNow;
  const start = real();
  let offset = (++slot) * 3 * HOUR - (start % HOUR) + 1000;
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

export interface DbCount {
  reads: number;
  batches: number;
  statements: number;
}

/**
 * The hot DB seen through a counter (reads: a statement's first/all/run outside a batch; batches and their statements),
 * optionally failing the batch statement at `faultAt` (fault injection). Statements given to `batch` are unwrapped, as
 * D1 takes only its own. Keeps the counting and the fault injection out of the Worker's code.
 */
export function countingDb(base: D1Database, count: DbCount, opts: { faultAt?: number } = {}): D1Database {
  const real = new WeakMap<object, D1PreparedStatement>();
  const wrap = (st: D1PreparedStatement): D1PreparedStatement => {
    const proxy: D1PreparedStatement = new Proxy(st, {
      get(t, p) {
        if (p === 'bind') return (...args: unknown[]) => wrap(t.bind(...args));
        if (p === 'first' || p === 'all' || p === 'run' || p === 'raw') {
          return (...args: unknown[]) => {
            count.reads++;
            count.statements++;
            return (t[p] as (...a: unknown[]) => unknown).apply(t, args);
          };
        }
        const v: unknown = Reflect.get(t, p);
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    real.set(proxy, st);
    return proxy;
  };
  return new Proxy(base, {
    get(t, p) {
      if (p === 'prepare') return (sql: string) => wrap(t.prepare(sql));
      if (p === 'batch') {
        return (stmts: D1PreparedStatement[]) => {
          count.batches++;
          count.statements += stmts.length;
          return t.batch(stmts.map((s, i) => (i === opts.faultAt ? t.prepare('INSERT INTO fault_injected_no_such_table VALUES (1)') : (real.get(s) ?? s))));
        };
      }
      const v: unknown = Reflect.get(t, p);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/** An entrypoint over a counted hot DB (each call's own count). */
export const counted = <T>(make: (ctx: ExecutionContext, e: typeof env) => T, count: DbCount): T => make(createExecutionContext(), { ...env, DB: countingDb(env.DB, count) });

// ---- batch C6: step-up tokens and an owner-aware chain ----

/** The console audience the C6 tests' chain has in force, and the member's Google sub (member()'s default). */
export const CONSOLE_AUD = 'console-test.apps.googleusercontent.com';
export const STEP_UP_SUB = 'owner-sub-1';

/**
 * NEAR (helpers.ts chain) with the console audience in force and every scope owned by `owners` (Oidc google subs,
 * default the member's) at `actionNonce` (default 4), two clients, one pending change (id 2) and no shared login.
 */
export function ownerChain(o: { owners?: string[]; actionNonce?: number; audiences?: [string, string][] } = {}): Chain & { actionNonce: number } {
  const n = Object.assign(chain(), { actionNonce: o.actionNonce ?? 4 });
  const base = n.views.get_config!;
  n.views.get_config = () => ({ ...(base({}) as object), console_audiences: o.audiences ?? [['google', CONSOLE_AUD]] });
  n.views.get_scope = (a) => ({
    id: a.scope_id,
    owners: [{ Near: { account_id: 'owner.test.near' } }, ...(o.owners ?? [STEP_UP_SUB]).map((sub) => ({ Oidc: { provider: 'google', sub } }))],
    clients: [
      ['google', 'own.apps.googleusercontent.com'],
      ['google', 'old.apps.googleusercontent.com'],
    ],
    pending: [{ id: 2, change: { SetAllowShared: { allow: true } }, unlock_at_ms: Date.now() + 3_600_000 }],
    action_nonce: n.actionNonce,
    created_at_ms: 1,
    allow_shared: false,
  });
  n.contract.propose_change = () => 9;
  return n;
}

let jti = 0;
/** A console step-up token (`openid` only: no email, hd or email_verified) for `nonce`, issued now. */
export const stepUp = (nonce: string, claims: Record<string, unknown> = {}): Promise<string> =>
  google.sign({ iss: GOOGLE_ISS, aud: CONSOLE_AUD, azp: CONSOLE_AUD, sub: STEP_UP_SUB, nonce, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, jti: `j${jti++}`, ...claims });

/** The pending upgrade the governance views below report (a base58 sha256). */
export const UPGRADE_HASH = '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp';
export const UPDATER_PK = 'ed25519:6E8sCci9badyRkXb3JoRpBj5p8C6Tw41ELDZoiihKEtp';

/**
 * Adds the views `GET /v1/governance` reads (get_config's governance fields, get_governance, get_key_changes) to a
 * mock chain, with a pending upgrade, a pending owner transfer, a governance-delay decrease, a console-audience addition
 * and an updater key (batch C14's RPCs).
 */
export function governanceViews<T extends Chain>(n: T, now = Date.now()): T {
  const base = n.views.get_config!;
  n.views.get_config = (a) => ({
    ...(base(a) as object),
    change_delay_ms: 172_800_000,
    pending_change_delay: null,
    issuer_key_delay_ms: 7_200_000,
    pending_issuer_key_delay: null,
    governance_delay_ms: 259_200_000,
    pending_governance_delay: { change_delay_ms: 3_600_000, effective_at_ms: now + 259_200_000 },
    pending_console_audiences: [{ provider: 'google', aud: 'console2.apps.googleusercontent.com', effective_at_ms: now + 60_000 }],
    unpaused_at_ms: 0,
    changes_unlock_floor_ms: 0,
    sessions_valid_from_ms: 0,
  });
  n.views.get_governance = () => ({
    state_version: 3,
    watchdogs: [{ account_id: 'watchdog.test.near', confirm_from_ms: 0 }],
    keys_slow_until_ms: 0,
    updater_keys: [UPDATER_PK],
    updater_methods: ['set_issuer_key', 'propose_issuer_key_removal', 'execute_issuer_key_change'],
    pending_upgrade: { code_hash: UPGRADE_HASH, proposed_at_ms: now - 1000, executable_at_ms: now + 259_199_000 },
    pending_owner: { owner: 'new-dao.sputnik.test.near', acceptable_at_ms: now + 1000 },
    pending_withdrawal: null,
  });
  n.views.get_key_changes = () => [];
  n.accessKeyList = [{ public_key: UPDATER_PK, access_key: { nonce: 1, permission: 'FullAccess' } }];
  return n;
}
