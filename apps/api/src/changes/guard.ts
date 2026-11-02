// ConsoleRpc's admission (docs/batch-c-spec.md §RPC "Destructive-call breaker", "Hot-DB budget"; D228):
// - the hot-DB budget: per-org token buckets under a global one (the spec's 30 statements/s, burst 60), each with a
//   reserve that only the kill switches (removeOrigins, turnOff, revokeKey, setSuspended(true)) may spend, so neither
//   one org nor a flood of reads or settings writes can starve another org's kill switches;
// - the destructive-call breaker (setSuspended(true), revokeKey, rotateKey, removeOrigins, a web-client change): 5 per
//   org and 20 across orgs per rolling hour, counted per call (D93 Q21); a call that changed nothing gets its slot back;
// - emailed-link cancels (no session, no org): their own per-IP limiter (IPv6 by /64) and a modest global bucket,
//   outside the members' budget, taken before the token is read.
// The member and link buckets and the breaker live on one RateLimiter object (`console-rpc`), so a member call is
// admitted or refused in one step. The first breaker refusal of a limit in a clock hour writes a `breaker` security
// event (the object remembers it, so later refusals cost no write). AdminRpc is neither counted nor charged.
import { base58, sha256, utf8 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { ipSubject } from '../ip.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { ConsoleAdmission, Limit } from '../rate-limiter.ts';
import { RpcRefusal } from './cas.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const CONSOLE_LIMITS = {
  /** Each org's share: 10 statements/s, burst 40, the last 10 for its kill switches. */
  perOrg: { ratePerS: 10, burst: 40, reserve: 10 },
  /** Every org together (the spec's budget): 30 statements/s, burst 60, the last 20 for kill switches. */
  global: { ratePerS: 30, burst: 60, reserve: 20 },
  /** Emailed-link cancels together: 1 a second, burst 20. */
  link: { ratePerS: 1, burst: 20 },
  breaker: { windowMs: HOUR_MS, perOrg: 5, global: 20 },
} as const satisfies ConsoleAdmission['limits'];
/** Emailed-link cancels per client IP (IPv6 by /64). */
export const LINK_PER_IP: Limit[] = [
  { name: 'minute', windowMs: 60_000, max: 5 },
  { name: 'day', windowMs: 24 * HOUR_MS, max: 50 },
];
/** The one object every member call and the global link bucket are admitted by. */
export const CONSOLE_LIMITER = 'console-rpc';

/** A deterministic security event id (`se_` + base58 of 12 bytes of a hash), so a repeated finding is written once. */
export async function eventId(...parts: string[]): Promise<string> {
  return `se_${base58((await sha256(utf8(parts.join('\u0000')))).slice(0, 12))}`;
}

export interface MemberAdmission {
  org: string;
  cost: number;
  killSwitch?: boolean;
  breaker?: boolean;
}

const limiter = (env: Env) => placedStub(env, env.RATE_LIMITER, CONSOLE_LIMITER);

/** Admits one member call; throws `rate_limited` when a bucket or the breaker refuses. */
export async function admitMemberCall(env: Env, a: MemberAdmission, now = Date.now()): Promise<void> {
  const r = await limiter(env).consoleAdmit({ ...a, limits: CONSOLE_LIMITS }, now);
  if (r.ok) return;
  if (r.notify) await breakerEvent(env.DB, r.limit === 'breaker_org' ? a.org : null, now);
  const breaker = r.limit === 'breaker_org' || r.limit === 'breaker_global';
  throw new RpcRefusal('rate_limited', breaker ? 'Too many destructive changes this hour: ask Hana security' : 'Too many console calls: try again shortly');
}

/** Gives back the breaker slot of a member call admitted at `at` that changed nothing. */
export async function refundBreaker(env: Env, org: string, at: number): Promise<void> {
  try {
    await limiter(env).consoleBreakerRefund(org, at);
  } catch {
    log({ event: 'console_rpc', outcome: 'error', code: 'breaker_refund_failed' }, 'error');
  }
}

/** Admits one emailed-link cancel: the caller's IP first, then the global link bucket. Never the members' budget. */
export async function admitLinkCall(env: Env, clientIp: string, now = Date.now()): Promise<void> {
  const ip = env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(`cancel-link:${ipSubject(clientIp)}`));
  const perIp = await ip.hit(LINK_PER_IP, now);
  if (!perIp.ok) throw new RpcRefusal('rate_limited', 'Too many cancel attempts from this address: try again later');
  const r = await limiter(env).consoleAdmit({ cost: 1, link: true, limits: CONSOLE_LIMITS }, now);
  if (!r.ok) throw new RpcRefusal('rate_limited', 'Too many cancel attempts: try again shortly');
}

/** The `breaker` event (the first refusal of the hour, as the limiter object decides). A failure is logged, never thrown. */
export async function breakerEvent(db: D1Database, orgId: string | null, now: number): Promise<void> {
  const hour = Math.floor(now / HOUR_MS) * HOUR_MS;
  const scope = orgId === null ? 'global' : 'org';
  try {
    await db
      .prepare('INSERT OR IGNORE INTO security_events (id, detected_at, kind, org_id, detail_json) VALUES (?1, ?2, ?3, ?4, ?5)')
      .bind(
        await eventId('breaker', scope, orgId ?? '', String(hour)),
        now,
        'breaker',
        orgId,
        JSON.stringify({ limit: scope, windowStart: hour, perOrg: CONSOLE_LIMITS.breaker.perOrg, global: CONSOLE_LIMITS.breaker.global }),
      )
      .run();
  } catch {
    log({ event: 'console_rpc', outcome: 'error', code: 'breaker_event_failed' }, 'error');
  }
}
