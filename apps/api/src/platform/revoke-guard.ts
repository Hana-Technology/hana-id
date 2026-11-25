// D918 (after PR 149's review, then its automated findings): an owner's stop of a platform key is a kill switch, never
// refused by the console's shared budget or the destructive-call breaker (another org's traffic can't fill those for
// it), but still bounded, by limits of its own that nothing else draws on:
// - per member and per org, before any database work: sized so a real incident (stopping each of the org's keys, at
//   most 2 by the quota, several times over, by every owner) never reaches them; each is its own limiter object,
//   keyed by that member or org, so no other org's calls touch them;
// - a repeat that changes nothing (the key was not found, or is already stopped, within the last 15 minutes) is refused
//   before any database work with the same answer, from that key's own marker, and counted;
// - a global ceiling on calls that changed nothing: past it a no-op answers `rate_limited` and is logged at error
//   level (once a window). It never refuses a stop that changes something: it is counted only after the plan read
//   found nothing to stop, and that read is itself bounded by the two limits above;
// - stops that succeeded are counted in a short window per org and across orgs: a burst is logged (a burst of stops is
//   itself a signal, never a refusal).
import type { RpcCode } from '@hana-id/console-core';
import type { Env } from '../env.ts';
import { log } from '../log.ts';
import { placedStub } from '../placement.ts';
import type { Limit } from '../rate-limiter.ts';
import { RpcRefusal } from '../changes/cas.ts';

const MIN = 60_000;
export const REVOKE_LIMITS = {
  /** One owner: 20 a minute, 100 an hour. */
  perMember: [
    { name: 'pk-revoke:member:minute', windowMs: MIN, max: 20 },
    { name: 'pk-revoke:member:hour', windowMs: 60 * MIN, max: 100 },
  ],
  /** One org, all its owners: 40 a minute, 200 an hour. */
  perOrg: [
    { name: 'pk-revoke:org:minute', windowMs: MIN, max: 40 },
    { name: 'pk-revoke:org:hour', windowMs: 60 * MIN, max: 200 },
  ],
  /** Every org together, only calls that changed nothing: 300 a minute. */
  noopGlobal: [{ name: 'pk-revoke:noop:global', windowMs: MIN, max: 300 }],
  /** Stops that succeeded, counted for the alert (never refused): 3 in an org, or 10 across orgs, within 10 minutes. */
  burstOrg: [{ name: 'pk-revoke:done:org', windowMs: 10 * MIN, max: 3, soft: true }],
  burstGlobal: [{ name: 'pk-revoke:done:global', windowMs: 10 * MIN, max: 10, soft: true }],
} as const satisfies Record<string, Limit[]>;

/** A key's own marker: a stop that found nothing to stop answers again from it, without the database, for 15 minutes. */
export const REVOKE_WINDOW_MS = 15 * MIN;

const stub = (env: Env, name: string) => placedStub(env, env.RATE_LIMITER, name);
const memberObj = (env: Env, userId: string) => stub(env, `pk-revoke:member:${userId}`);
const orgObj = (env: Env, orgId: string) => stub(env, `pk-revoke:org:${orgId}`);
const keyObj = (env: Env, orgId: string, keyId: string) => stub(env, `pk-revoke:key:${orgId}:${keyId}`);
const globalObj = (env: Env) => stub(env, 'pk-revoke:global');

/** The answer a no-op repeat gets back: what the first one answered. */
const NOOP_ANSWER: Record<'not_found' | 'conflict', string> = {
  not_found: 'No such platform key in this organisation',
  conflict: 'This key is already stopped',
};

/**
 * Admits an owner's stop before any database work: the member's and the org's own limits, then the key's no-op marker.
 * Throws `rate_limited` past a limit, or the earlier answer for a repeat that changes nothing.
 */
export async function admitRevoke(env: Env, a: { orgId: string; userId: string; keyId: string; method: string; requestId: string }, now: number): Promise<void> {
  const m = await memberObj(env, a.userId).hit([...REVOKE_LIMITS.perMember], now);
  if (!m.ok) {
    log({ event: 'rpc_admit', method: a.method, requestId: a.requestId, orgId: a.orgId, outcome: 'rejected', code: 'revoke_member_limit' }, 'warn');
    throw new RpcRefusal('rate_limited', 'Too many stops from you just now: try again in a minute, or ask another owner');
  }
  const o = await orgObj(env, a.orgId).hit([...REVOKE_LIMITS.perOrg], now);
  if (!o.ok) {
    await memberObj(env, a.userId).unhit([...REVOKE_LIMITS.perMember], now);
    log({ event: 'rpc_admit', method: a.method, requestId: a.requestId, orgId: a.orgId, outcome: 'rejected', code: 'revoke_org_limit' }, 'error');
    throw new RpcRefusal('rate_limited', 'Too many stops in this organisation just now: try again in a minute');
  }
  // A marker probe (`reserve` is a test-and-set: false while an earlier no-op's marker lasts; true leaves one that ends now).
  const key = keyObj(env, a.orgId, a.keyId);
  const seen = !(await key.reserve('noop:conflict', now, now)) ? 'conflict' : !(await key.reserve('noop:not_found', now, now)) ? 'not_found' : null;
  if (seen) {
    log({ event: 'rpc_admit', method: a.method, requestId: a.requestId, orgId: a.orgId, outcome: 'rejected', code: 'revoke_noop_repeat' });
    throw new RpcRefusal(seen, NOOP_ANSWER[seen]);
  }
}

/** After the call: a no-op is marked on its key and counted globally; a stop that changed something is counted for the alert. */
export async function settleRevoke(env: Env, a: { orgId: string; keyId: string; method: string; requestId: string }, code: RpcCode | null, now: number): Promise<RpcCode | null> {
  try {
    if (code === 'not_found' || code === 'conflict') {
      await keyObj(env, a.orgId, a.keyId).reserve(`noop:${code}`, now + REVOKE_WINDOW_MS, now);
      const g = await globalObj(env).hit([...REVOKE_LIMITS.noopGlobal], now);
      if (!g.ok) {
        log({ event: 'rpc_admit', method: a.method, requestId: a.requestId, orgId: a.orgId, outcome: 'rejected', code: 'revoke_noop_flood' }, 'error');
        return 'rate_limited';
      }
    } else if (code === null) {
      const org = await orgObj(env, a.orgId).hitSliding([...REVOKE_LIMITS.burstOrg], now);
      const all = await globalObj(env).hitSliding([...REVOKE_LIMITS.burstGlobal], now);
      if (org.ok && org.soft?.length) log({ event: 'platform_key_revoke_burst', orgId: a.orgId, code: 'org', requestId: a.requestId }, 'warn');
      if (all.ok && all.soft?.length) log({ event: 'platform_key_revoke_burst', code: 'global', requestId: a.requestId }, 'error');
    }
  } catch {
    log({ event: 'rpc', method: a.method, requestId: a.requestId, outcome: 'error', code: 'revoke_settle_failed' }, 'error');
  }
  return code;
}
