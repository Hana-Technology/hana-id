// ConsoleRpc's admission (docs/batch-c-spec.md §RPC "Destructive-call breaker", "Hot-DB budget"; D228, D935, D937):
// - two budget classes that never charge each other (D937, as the platform's in D935). Ordinary member calls: per-org
//   token buckets under a global one (the spec's 30 statements/s, burst 60), with no reserve. Kill switches (suspend,
//   removeOrigins, frameOnlyOrigins, turnOff, revokeKey, removeLabels, cancelPlatformKey, an owner action's safety
//   methods): each org's own kill bucket and the console's global kill bucket, never the ordinary ones, so no org's
//   reads, writes or kill switches can take what another org's kill switches need. The global kill bucket bounds every
//   org together (console organisations are not capped); each org's first 5 kill switches of a rolling minute pass
//   whatever it holds. No token is ever given back;
// - the destructive-call breaker (removeOrigins, frameOnlyOrigins, rotateKey, a web-client change): 5 per org and 20
//   across orgs per rolling hour, counted per call (D93 Q21); with the global 20 full, each org's first 3 of its hour
//   still pass while a global overflow of 60 a rolling hour has room (D937: at most 80 across orgs an hour, however
//   many orgs); a call that changed nothing gets its slot back. Not a suspension or a publishable key's revocation (D935, D937: a
//   stop is never blockable by the shared breaker): each is held instead to its org's own 20 a clock hour, counted only
//   when it changes something (`console-stops:<orgId>`);
// - emailed-link cancels (no session, no org), outside the members' budget: a per-IP limiter (IPv6 by /64), then one
//   token of a global link-read budget sized for D1 (50 reads/s, burst 100), both before the token is read. Nothing
//   limits a cancel after that: one whose token verifies on a pending change always runs (D229).
// The member, kill and link buckets and the breaker live on one RateLimiter object (`console-rpc`), so a member call is
// admitted or refused in one step. The platform API's admission is on the same object but on buckets of its own: the
// two surfaces never share a bucket (D938). The first breaker refusal of a limit in a clock hour writes a `breaker`
// security event (the object remembers it, so later refusals cost no write). AdminRpc is neither counted nor charged.
import { base58, sha256, utf8 } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { ipSubject } from '../ip.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { ConsoleAdmission, Limit } from '../rate-limiter.ts';
import { RpcRefusal, type Writer } from './cas.ts';

export const HOUR_MS = 60 * 60 * 1000;
export const CONSOLE_LIMITS = {
  /** Each org's ordinary calls: 10 statements/s, burst 40. */
  perOrg: { ratePerS: 10, burst: 40 },
  /** Every org's ordinary calls together (the spec's budget): 30 statements/s, burst 60; no platform call touches it (D938). */
  global: { ratePerS: 30, burst: 60 },
  /** Emailed-link cancels' token reads together (one D1 read each): 50 a second, burst 100. */
  linkRead: { ratePerS: 50, burst: 100 },
  /**
   * 5 an org and 20 across orgs a rolling hour; with the global 20 full, each org's first 3 of its hour still pass while
   * the global overflow's 60 a rolling hour (20 orgs' floors) has room (D937): at most 80 across orgs a rolling hour.
   */
  breaker: { windowMs: HOUR_MS, perOrg: 5, global: 20, floor: 3, overflow: 60 },
  /**
   * D937, the kill switches' only budget. Each org: 1 statement/s, burst 60 (10 of the largest kill switch, 6, at once;
   * 10 a minute after). Every org together: 10 statements/s, burst 300 (50 at once, 100 a minute), so it bites only when
   * more than ten orgs use kill switches at their full rate at once. Each org's first 5 kill switches of a rolling minute
   * pass whatever the global bucket holds (one app's every stop: suspend, remove, revoke, turn off, cancel a platform key).
   */
  kill: { perOrg: { ratePerS: 1, burst: 60 }, global: { ratePerS: 10, burst: 300 }, floor: { windowMs: 60_000, calls: 5 } },
} as const satisfies ConsoleAdmission['limits'];
/** Emailed-link cancels per client IP (IPv6 by /64). */
export const LINK_PER_IP: Limit[] = [
  { name: 'minute', windowMs: 60_000, max: 5 },
  { name: 'day', windowMs: 24 * HOUR_MS, max: 50 },
];
/** The one object every member call and the link-read budget are admitted by. */
export const CONSOLE_LIMITER = 'console-rpc';

/**
 * D935: a member's publishable key revocations per org a clock hour, outside the breaker (only this org's own members
 * count towards it; the platform's stops have their own window). More than an incident needs, low enough to bound key
 * churn (revoked keys are kept).
 */
export const CONSOLE_KEY_REVOKES: Limit[] = [{ name: 'key-revokes:hour', windowMs: HOUR_MS, max: 20 }];

/**
 * D937: a member's app suspensions per org a clock hour, outside the breaker (a pure, reversible stop: only this org's
 * own suspensions count towards it; the platform's have their own 60). Every app of an org of up to 20 apps suspended in
 * one hour (one app per partner is recommended, D926; a platform org creates at most 10 by default), with room for a
 * suspension made again after a resume; low enough to bound suspend-and-resume churn on the hot database.
 */
export const CONSOLE_SUSPENSIONS: Limit[] = [{ name: 'suspensions:hour', windowMs: HOUR_MS, max: 20 }];

/**
 * D935, D937: runs a member's stop (a publishable key revocation, an app suspension) with its org's own window
 * (`console-stops:<orgId>`, pinned), taken just before the batch (after the plan read and every check, so a stop that
 * changes nothing, a key already revoked, an app already suspended, not found, never counts), and given back if the write
 * then fails with no ledger row of its request id (one read straight from D1 on the failure path only; if that read
 * fails, nothing is given back). A limiter error refuses the call (fails closed, as the breaker did).
 */
export async function withStopQuota<T>(env: Env, w: Writer, orgId: string, stop: { limits: Limit[]; code: string; message: string }, write: () => Promise<T>): Promise<T> {
  const obj = placedStub(env, env.RATE_LIMITER, `console-stops:${orgId}`);
  let taken: number | null = null;
  w.beforeBatch = async () => {
    const r = await obj.hit(stop.limits, w.now);
    if (!r.ok) {
      log({ event: 'console_rpc', outcome: 'rejected', code: stop.code, orgId }, 'warn');
      throw new RpcRefusal('rate_limited', stop.message);
    }
    taken = w.now;
  };
  try {
    return await write();
  } catch (err) {
    if (taken !== null) {
      const committed = await env.DB.prepare('SELECT 1 AS x FROM app_changes WHERE request_id = ?1').bind(w.requestId).first().then(
        (r) => r !== null,
        () => true,
      );
      if (!committed) await obj.unhit(stop.limits, taken).catch(() => undefined);
    }
    throw err;
  }
}

/** D935: a member's publishable key revocation with its org's 20 a clock hour. */
export const withKeyRevokeQuota = <T>(env: Env, w: Writer, orgId: string, write: () => Promise<T>): Promise<T> =>
  withStopQuota(env, w, orgId, { limits: CONSOLE_KEY_REVOKES, code: 'key_revokes_full', message: 'Your organisation has revoked many publishable keys this hour: try again later, or ask Journear security' }, write);

/** D937: a member's app suspension with its org's 20 a clock hour. */
export const withSuspensionQuota = <T>(env: Env, w: Writer, orgId: string, write: () => Promise<T>): Promise<T> =>
  withStopQuota(env, w, orgId, { limits: CONSOLE_SUSPENSIONS, code: 'suspensions_full', message: 'Your organisation has suspended many apps this hour: try again later, or ask Journear security' }, write);

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

/**
 * Admits one member call; throws `rate_limited` when a bucket or the breaker refuses. Answers the admission's time on
 * the limiter's clock (what settleMemberCall names when the call changed nothing).
 */
export async function admitMemberCall(env: Env, a: MemberAdmission, now = Date.now()): Promise<{ at: number; overflow?: true }> {
  const r = await limiter(env).consoleAdmit({ ...a, limits: CONSOLE_LIMITS }, now);
  if (r.ok) return r.overflow ? { at: r.at, overflow: true } : { at: r.at };
  if (r.notify) await breakerEvent(env.DB, r.limit === 'breaker_org' ? a.org : null, now);
  const breaker = r.limit === 'breaker_org' || r.limit === 'breaker_global';
  throw new RpcRefusal('rate_limited', breaker ? 'Too many destructive changes this hour: ask Journear security' : 'Too many console calls: try again shortly');
}

/** Settles a breaker call admitted at `at` that changed nothing: its breaker slot back (D937: no tokens). */
export async function settleMemberCall(env: Env, s: { org: string; at: number; breaker: boolean; overflow?: boolean }): Promise<void> {
  try {
    await limiter(env).consoleSettle(s);
  } catch {
    log({ event: 'console_rpc', outcome: 'error', code: 'settle_failed' }, 'error');
  }
}

/**
 * Admits one emailed-link cancel to its token read: the caller's IP first, then one token of the link-read budget.
 * Never the members' budget; nothing is checked after the read (a valid token on a pending change always cancels).
 */
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
        JSON.stringify({ limit: scope, windowStart: hour, perOrg: CONSOLE_LIMITS.breaker.perOrg, global: CONSOLE_LIMITS.breaker.global, floor: CONSOLE_LIMITS.breaker.floor, overflow: CONSOLE_LIMITS.breaker.overflow }),
      )
      .run();
  } catch {
    log({ event: 'console_rpc', outcome: 'error', code: 'breaker_event_failed' }, 'error');
  }
}
