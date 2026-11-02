// ConsoleRpc's admission (docs/batch-c-spec.md §RPC): the destructive-call breaker (setSuspended(true), revokeKey,
// rotateKey and removeOrigins: 5 per org and 20 across orgs per rolling hour, counted per call, D93 Q21) and the hot-DB
// budget (a token bucket of 30 statements/s, burst 60), both on one RateLimiter object so a call is admitted or
// refused in one step. A breaker refusal also writes a `breaker` security event (one per org, or for the global limit,
// per clock hour), which the admin feed emails. AdminRpc is neither counted nor charged.
import { base58, sha256, utf8 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { ConsoleAdmission } from '../rate-limiter.ts';
import { RpcRefusal } from './cas.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const BREAKER = { windowMs: HOUR_MS, perOrg: 5, global: 20 } as const;
export const HOT_DB_BUDGET = { ratePerS: 30, burst: 60 } as const;
/** The one object every ConsoleRpc call is admitted by. */
export const CONSOLE_LIMITER = 'console-rpc';

/** A deterministic security event id (`se_` + base58 of 12 bytes of a hash), so a repeated finding is written once. */
export async function eventId(...parts: string[]): Promise<string> {
  return `se_${base58((await sha256(utf8(parts.join('\u0000')))).slice(0, 12))}`;
}

/** Admits one ConsoleRpc call costing `cost` statements; a destructive call (`breakerOrg`) also takes a breaker slot. */
export async function admitConsoleCall(env: Env, cost: number, breakerOrg?: string, now = Date.now()): Promise<void> {
  const stub = placedStub(env, env.RATE_LIMITER, CONSOLE_LIMITER);
  const admission: ConsoleAdmission = { cost, budget: HOT_DB_BUDGET, breaker: BREAKER, ...(breakerOrg === undefined ? {} : { breakerOrg }) };
  const r = await stub.consoleAdmit(admission, now);
  if (r.ok) return;
  if (r.limit !== 'budget') await breakerEvent(env.DB, r.limit === 'breaker_org' ? breakerOrg! : null, now);
  throw new RpcRefusal('rate_limited', r.limit === 'budget' ? 'Too many console calls: try again shortly' : 'Too many destructive changes this hour: ask Hana security');
}

/** The `breaker` event, once per org (or for the global limit) per clock hour. A failure is logged, never thrown. */
export async function breakerEvent(db: D1Database, orgId: string | null, now: number): Promise<void> {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const scope = orgId === null ? 'global' : 'org';
  try {
    await db
      .prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(await eventId('breaker', scope, orgId ?? '', String(hour)), now, 'breaker', orgId, JSON.stringify({ limit: scope, windowStart: hour, perOrg: BREAKER.perOrg, global: BREAKER.global }))
      .run();
  } catch {
    log({ event: 'console_rpc', outcome: 'error', code: 'breaker_event_failed' }, 'error');
  }
}
