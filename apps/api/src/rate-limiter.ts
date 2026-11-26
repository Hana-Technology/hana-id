// Fixed-window rate limiter. One instance per subject (`app:<id>` or `ip:<address>`); each call checks several
// windows at once and only counts the hit when every window still has room, so a rejected request costs nothing.
// The storage calls are synchronous (SQLite-backed KV), so a hit is atomic inside the object.
//
// D935 after PR 161's second full review, H1: every window, bucket, breaker list and stored `at` is reckoned on the
// object's monotone clock (`clock`: the greatest of its own `Date.now()`, every time it has used before and the
// caller's time). A caller's time can only move it forward, never back: a `now` taken before a slow body (or any stale
// time) can't move a bucket's `at` back and be credited the same refill twice, nor pick an older window. Methods that
// undo an earlier call take that call's `at` (as the call returned it, or the caller's own time taken before it) and
// undo only within the window still current.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import { log } from './log.ts';

/** D935 (after PR 161's third review): how far ahead of an object's own `Date.now()` a caller's time may move its clock. */
export const CALLER_CLOCK_LEAD_MS = 5000;

export interface Limit {
  /** Window name, unique per subject (e.g. `minute`, `day`, `<appId>:minute`). */
  name: string;
  windowMs: number;
  max: number;
  /** A soft limit never refuses; past it, its name is reported in `soft` (an alert, not a breaker): by `hitSliding` on every hit past it, by `hit` on every hit past it until `markAlerted` notes its alert was written (D925). */
  soft?: boolean;
}

/** A token bucket: `ratePerS` tokens a second up to `burst`. */
export interface Bucket {
  ratePerS: number;
  burst: number;
}

/**
 * One ConsoleRpc call's admission (changes/guard.ts), D937: two budget classes that never charge each other, as the
 * platform's (D935).
 * - An ordinary member call takes `cost` from its org's bucket (`console:bucket:org:<org>`) and the console's global one
 *   (`console:bucket`), with no reserve.
 * - A kill switch takes `cost` from its org's kill bucket (`console:kill:org:<org>`) and the console's global kill bucket
 *   (`console:kill`), never from the ordinary buckets. The global kill bucket is the bound on every org together (console
 *   organisations are not capped); each org's first `kill.floor.calls` kill switches of a rolling `kill.floor.windowMs`
 *   pass whatever it holds (every admitted kill switch counted on the org's floor list), still taking what it holds.
 * - A breaker call also takes a slot in its org's and in the global rolling hour; with the global count full, each org's
 *   first `breaker.floor` of its hour still pass while the global overflow (`breaker.overflow` a rolling hour) has room,
 *   counted there too (every admitted call is on its org's and the global list). So at most `global + overflow` breaker
 *   calls pass in any rolling hour, however many orgs there are (console organisations are not capped).
 * No token is ever given back; only a breaker call that changed nothing gets its slot back (`consoleSettle`). An
 * emailed-link cancel (`link`) takes one token from the link bucket only, never the members' budget.
 */
export interface ConsoleAdmission {
  cost: number;
  /** The caller's org (members); absent for a link cancel. */
  org?: string;
  /** A kill switch (setSuspended(true), removeOrigins, frameOnlyOrigins, turnOff, revokeKey, …): the kill buckets only. */
  killSwitch?: boolean;
  /** Counted by the breaker (removeOrigins, frameOnlyOrigins, rotateKey, a web-client change). */
  breaker?: boolean;
  /** An emailed-link cancel: one token of the link-read budget instead of the members' buckets. */
  link?: boolean;
  limits: {
    perOrg: Bucket;
    global: Bucket;
    /** The link cancel's token reads (D1 protection), taken before the read. */
    linkRead: Bucket;
    /**
     * `floor`: each org's first `floor` breaker calls of its rolling hour pass a full global count while the global
     * `overflow` (floor admissions past the global count, a rolling hour) has room.
     */
    breaker: { windowMs: number; perOrg: number; global: number; floor: number; overflow: number };
    /** The kill switches' only budget: each org's own bucket, the global one, and each org's floor through the global. */
    kill: { perOrg: Bucket; global: Bucket; floor: { windowMs: number; calls: number } };
  };
}

export type ConsoleLimit = 'budget_org' | 'budget' | 'budget_kill' | 'budget_kill_global' | 'link' | 'breaker_org' | 'breaker_global';

/**
 * D927, D935 (after PR 161's second full review), D938: one platform request's admission, on the same `console-rpc`
 * object as the console's but on buckets of its own: no platform call reads or charges any of the console's buckets,
 * and no console call any of the platform's. Two budget classes that never charge each other:
 * - an ordinary call takes `cost` from its org's bucket (`platform:bucket:org:<org>`) and the platform's global bucket
 *   (`platform:bucket`), with no reserve; the global bucket alone bounds every org's ordinary calls together;
 * - a kill switch takes `cost` from its org's kill bucket (`platform:kill:org:<org>`) and nothing else, so no other org's
 *   calls, ordinary or kill, can slow it, and it never slows anyone else's ordinary calls. At most `maxOrgs` distinct
 *   orgs' kill buckets are used in any minute (the backstop to the cap on orgs switched on): a further org's kill switch
 *   is refused (`kill_orgs`), failing closed for that org only.
 * A removal also takes a breaker slot (each org's first `floor` of its rolling hour past the global count). No tokens
 * are ever given back; only a removal that changed nothing gets its breaker slot back (`platformSettle`).
 */
export interface PlatformAdmission {
  org: string;
  cost: number;
  killSwitch?: boolean;
  breaker?: boolean;
  limits: {
    perOrg: Bucket;
    platform: Bucket;
    breaker: { windowMs: number; perOrg: number; global: number; floor: number };
    /** Each org's kill bucket: its kill switches' only budget. */
    kill: Bucket;
    /** The most distinct orgs whose kill buckets are used in any minute (MAX_PLATFORM_ORGS). */
    maxOrgs: number;
  };
}
export type PlatformLimit = 'budget_org' | 'budget_platform' | 'budget_kill' | 'kill_orgs' | 'breaker_org' | 'breaker_global';
/** `at`: the admission's time on the object's clock (what `platformSettle` needs). */
export type PlatformAdmitResult = { ok: true; at: number } | { ok: false; limit: PlatformLimit; retryAfterS: number; notify: boolean };

/**
 * `notify`: the first breaker refusal of this limit (the org's, or the global one) in this clock hour, the only one the
 * caller writes a security event for.
 */
/**
 * `at`: the admission's time on the object's clock, `overflow`: the call was admitted on its org's floor past a full
 * global count (both what `consoleSettle` needs).
 */
export type ConsoleAdmitResult = { ok: true; at: number; overflow?: true } | { ok: false; limit: ConsoleLimit; retryAfterS: number; notify: boolean };

/** What a member call that changed nothing gives back (consoleSettle): its breaker slot, nothing else (D937). */
export interface ConsoleSettlement {
  org: string;
  /** The admission time (the `at` consoleAdmit answered). */
  at: number;
  /** Its breaker slot. */
  breaker: boolean;
  /** Its slot was also on the global overflow (the admission answered `overflow`). */
  overflow?: boolean;
}

export type HitResult = { ok: true; soft?: string[] } | { ok: false; limit: string; retryAfterS: number };

/**
 * How long until a sliding window at `elapsed` ms into its bucket, with `current` and `previous` counts, admits one
 * more request: within this bucket once the previous one has slid out far enough, else in the next bucket, where the
 * current count becomes the weighted previous one.
 */
export function slidingWait(l: Pick<Limit, 'windowMs' | 'max'>, elapsed: number, current: number, previous: number): number {
  const W = l.windowMs;
  const room = l.max - 1 - current;
  if (room >= 0) return previous > 0 ? Math.max(0, W - elapsed - (W * room) / previous) : 0;
  return W - elapsed + Math.max(0, W * (1 - (l.max - 1) / current));
}

export class RateLimiter extends DurableObject<Env> {
  /**
   * D935 (H1): the object's monotone clock: never below a time it used before (stored as `clock`) nor below its own
   * `Date.now()`. A caller's time can only move it forward (every caller passes its own `Date.now()`, which in a Worker
   * never runs ahead of real time; tests pass simulated times): a stale one is ignored, so it can't move a bucket's `at`
   * back (and be credited the same refill twice) or pick an older window.
   */
  private clock(caller?: number): number {
    const kv = this.ctx.storage.kv;
    const before = kv.get<number>('clock') ?? 0;
    const own = Date.now();
    let from = Number.isFinite(caller) ? (caller as number) : 0;
    // After PR 161's third review, M1: a caller's time at most 5 s ahead of the object's own (else one far-future time
    // would poison the object until real time caught up: markers born expired, buckets frozen), logged when cut. Lifted
    // only in the tests' env, which run objects at simulated times.
    if (from > own + CALLER_CLOCK_LEAD_MS && !(this.env.LIMITER_TRUST_CALLER_CLOCK === '1' && this.env.ENV_NAME === 'sandbox-test')) {
      // Logged at most once a minute per object (the object's kind and how far ahead, nothing else).
      const minute = Math.floor(own / 60_000);
      if (kv.get<number>('clock:logged') !== minute) {
        kv.put('clock:logged', minute);
        const name = (this.ctx.id as { name?: string }).name ?? '';
        log({ event: 'rate_limiter', outcome: 'error', code: 'caller_clock_ahead', what: name.split(/[:@]/u)[0] || 'unnamed', aheadMs: Math.round(from - own) }, 'error');
      }
      from = own + CALLER_CLOCK_LEAD_MS;
    }
    const t = Math.max(before, own, from);
    if (t > before) kv.put('clock', t);
    return t;
  }

  /** Whether `at` lies in the window of `l` that is current on the object's clock (an undo touches no other). */
  private current(l: Pick<Limit, 'windowMs'>, at: number, now: number): boolean {
    return Math.floor(at / l.windowMs) === Math.floor(now / l.windowMs);
  }

  /**
   * `n` (D929): the hit counts `n` at once (a request proposing several web addresses), all or none. Refused, it names
   * the hard window that opens last and its wait (D935, L3: a retry then, with nothing else changed, is admitted).
   * `caller`: the caller's time, used only to move the object's clock forward (H1).
   */
  hit(limits: Limit[], caller?: number, n = 1): HitResult {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const slots = limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `${l.name}@${start}`;
      return { l, key, start, count: kv.get<number>(key) ?? 0 };
    });
    // A soft window never refuses and still counts. Past its max it is reported in `soft` on every hit until the caller
    // says its alert was written (`markAlerted`, a marker per window), so a failed write is retried by the next hit and
    // a written one is never repeated in the window (D925, after the review of PR 153's fixes: detection fails closed).
    const soft: string[] = [];
    let refused: { limit: string; waitMs: number } | null = null;
    for (const s of slots) {
      if (s.count + n <= s.l.max) continue;
      if (s.l.soft) {
        if (kv.get<number>(`alerted:${s.key}`) === undefined) soft.push(s.l.name);
      } else {
        const waitMs = s.start + s.l.windowMs - now;
        if (!refused || waitMs > refused.waitMs) refused = { limit: s.l.name, waitMs };
      }
    }
    if (refused) return { ok: false, limit: refused.limit, retryAfterS: Math.max(1, Math.ceil(refused.waitMs / 1000)) };
    for (const s of slots) kv.put(s.key, s.count + n);
    this.prune(limits, now);
    return soft.length > 0 ? { ok: true, soft } : { ok: true };
  }

  /**
   * Notes that the alert of each named soft window of `limits` at `now` was written: `hit` stops naming it in that window
   * (D925). Old markers of these limits are deleted here (a marker lives two windows), so they don't pile up.
   */
  markAlerted(limits: Limit[], names: string[], caller?: number): void {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    for (const l of limits) {
      if (!l.soft || !names.includes(l.name)) continue;
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      kv.put(`alerted:${l.name}@${start}`, now);
      for (const [key] of kv.list<number>({ prefix: `alerted:${l.name}@` })) if (Number(key.slice(key.lastIndexOf('@') + 1)) + 2 * l.windowMs <= now) kv.delete(key);
    }
  }

  /**
   * Takes back one accepted `hit(limits, …, n)` (same limits and `n`; `at` its time, or the caller's own time taken
   * before it): a request that several objects must all accept, refused by a later one, then costs the earlier ones
   * nothing. Never goes below zero; only the window still current is touched (D935, H1: the hit, counted between `at`
   * and now, was counted in it; any other has ended or isn't the hit's).
   */
  unhit(limits: Limit[], at: number, n = 1): void {
    const kv = this.ctx.storage.kv;
    const now = this.clock();
    for (const l of limits) {
      if (!this.current(l, at, now)) continue;
      const key = `${l.name}@${Math.floor(now / l.windowMs) * l.windowMs}`;
      const count = kv.get<number>(key) ?? 0;
      if (count > n) kv.put(key, count - n);
      else if (count > 0) kv.delete(key);
    }
  }

  /**
   * One-time markers (e.g. an owner token reserved for, or already used by, one relay). `reserve` is an atomic
   * test-and-set: true (and marked until `untilMs`) only if no unexpired marker exists, so concurrent requests with
   * the same key can't all pass. A call reads one row however many markers the object holds (D475): an expired marker
   * no longer counts, and the alarm deletes it.
   */
  reserve(key: string, untilMs: number, caller?: number): boolean {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const until = kv.get<number>(`mark:${key}`);
    if (until !== undefined && until > now) return false;
    kv.put(`mark:${key}`, untilMs);
    void this.scheduleMarkerSweep(untilMs);
    return true;
  }

  /**
   * D935 (after PR 161's third review, L1): `reserve` for a marker guarding something the caller checked fresh until
   * `notAfter` on its own clock: `'stale'` when this object's clock is already past it (a stall between the check and
   * here), `'used'` when an unexpired marker exists, else `'ok'` and marked until `untilMs`. Atomic in the object.
   */
  reserveFresh(key: string, untilMs: number, notAfter: number, caller?: number): 'ok' | 'used' | 'stale' {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    if (now > notAfter) return 'stale';
    const until = kv.get<number>(`mark:${key}`);
    if (until !== undefined && until > now) return 'used';
    kv.put(`mark:${key}`, untilMs);
    void this.scheduleMarkerSweep(untilMs);
    return 'ok';
  }

  /**
   * Whether an unexpired marker `key` exists, writing nothing (after PR 161's focused review: a "peek" by a `reserve`
   * that ends at the caller's time would, with the caller's clock ahead of this one's, leave a live marker that blocks
   * the same request's real one).
   */
  marked(key: string, caller?: number): boolean {
    const now = this.clock(caller);
    const until = this.ctx.storage.kv.get<number>(`mark:${key}`);
    return until !== undefined && until > now;
  }

  /**
   * Arms the sweep only when none is armed. Moving an armed alarm out to each new marker's end would starve it on a
   * shared object with steady traffic (`owner-actions:tokens`, `link-tokens`): the next marker would always arrive
   * first, and expired ones would pile up with nothing to delete them. Left alone, a marker waits at most one further
   * marker lifetime past its own end, and `alarm` re-arms itself for any that outlive it.
   */
  private async scheduleMarkerSweep(untilMs: number): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes expired markers, and re-arms for the latest live one. The only place markers are listed. */
  override async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    let left = 0;
    for (const [k, u] of kv.list<number>({ prefix: 'mark:' })) {
      if (u <= now) kv.delete(k);
      else left = Math.max(left, u);
    }
    if (left > 0) await this.ctx.storage.setAlarm(left + 1);
  }

  /**
   * Sliding windows (the Cloudflare approximation): a window's count is the current fixed bucket plus the previous one
   * weighted by how much of it still overlaps the last `windowMs`, so a refusal clears gradually instead of lasting until
   * a fixed boundary. As `hit`, a request counts only when every window has room. Keys are `slide:<name>@<start>`.
   */
  hitSliding(limits: Limit[], caller?: number): HitResult {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const slots = limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `slide:${l.name}@${start}`;
      const current = kv.get<number>(key) ?? 0;
      const previous = kv.get<number>(`slide:${l.name}@${start - l.windowMs}`) ?? 0;
      const estimate = current + previous * ((l.windowMs - (now - start)) / l.windowMs);
      return { l, key, start, current, previous, estimate };
    });
    const soft: string[] = [];
    let refused: { limit: string; waitMs: number } | null = null;
    for (const s of slots) {
      if (s.estimate < s.l.max) continue;
      if (s.l.soft) soft.push(s.l.name);
      else {
        const waitMs = slidingWait(s.l, now - s.start, s.current, s.previous);
        if (!refused || waitMs > refused.waitMs) refused = { limit: s.l.name, waitMs };
      }
    }
    if (refused) return { ok: false, limit: refused.limit, retryAfterS: Math.max(1, Math.ceil(refused.waitMs / 1000)) };
    for (const s of slots) kv.put(s.key, s.current + 1);
    for (const [key] of kv.list<number>({ prefix: 'slide:' })) {
      const at = key.lastIndexOf('@');
      const l = limits.find((x) => `slide:${x.name}` === key.slice(0, at));
      if (l && Number(key.slice(at + 1)) + 2 * l.windowMs <= now) kv.delete(key);
    }
    return soft.length > 0 ? { ok: true, soft } : { ok: true };
  }

  /** Takes back one accepted `hitSliding(limits)` (`at` its time or the caller's taken before it), in the current window only. */
  unhitSliding(limits: Limit[], at: number): void {
    const kv = this.ctx.storage.kv;
    const now = this.clock();
    for (const l of limits) {
      if (!this.current(l, at, now)) continue;
      const key = `slide:${l.name}@${Math.floor(now / l.windowMs) * l.windowMs}`;
      const count = kv.get<number>(key) ?? 0;
      if (count > 1) kv.put(key, count - 1);
      else if (count === 1) kv.delete(key);
    }
  }

  /**
   * ConsoleRpc's admission (docs/batch-c-spec.md §RPC "Destructive-call breaker", "Hot-DB budget"; changes/guard.ts;
   * D937), on the one `console-rpc` object and its clock: ConsoleAdmission's two budget classes, the breaker with its
   * floor, the link bucket. Either all of it is taken or nothing is. Refused, the wait is the longest of every
   * constraint the call is short of (a retry then, nothing else changed, is admitted), named by the breaker when the
   * breaker refuses, else by the constraint that opens last.
   */
  consoleAdmit(r: ConsoleAdmission, caller?: number): ConsoleAdmitResult {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const hour = Math.floor(now / 3_600_000);
    const L = r.limits;
    const refuse = (limit: ConsoleLimit, waitS: number): ConsoleAdmitResult => {
      let notify = false;
      if (limit === 'breaker_org' || limit === 'breaker_global') {
        const key = limit === 'breaker_org' ? `console:noticed:org:${r.org}` : 'console:noticed:global';
        notify = kv.get<number>(key) !== hour;
        if (notify) kv.put(key, hour);
      }
      return { ok: false, limit, retryAfterS: Math.max(1, Math.ceil(waitS)), notify };
    };
    const fill = (key: string, b: Bucket) => {
      const st = kv.get<{ tokens: number; at: number }>(key) ?? { tokens: b.burst, at: now };
      return Math.min(b.burst, st.tokens + (Math.max(0, now - st.at) / 1000) * b.ratePerS);
    };
    // Each constraint the call is short of, with how long until it isn't (seconds). A cost a bucket can never hold is
    // refused for an hour, never "soon"; a millionth of a token's slack so a retry at the stated second isn't refused by
    // floating-point dust.
    const short: { limit: ConsoleLimit; waitS: number }[] = [];
    const waitFor = (tokens: number, needed: number, b: Bucket) => (needed > b.burst ? 3600 : Math.max(0, needed - tokens) / b.ratePerS);
    const need = (limit: ConsoleLimit, tokens: number, needed: number, b: Bucket) => {
      if (tokens < needed - 1e-6) short.push({ limit, waitS: waitFor(tokens, needed, b) });
    };
    if (r.link) {
      const tokens = fill('console:link-read', L.linkRead);
      need('link', tokens, r.cost, L.linkRead);
      if (short.length > 0) return refuse('link', short[0]!.waitS);
      kv.put('console:link-read', { tokens: Math.max(0, tokens - r.cost), at: now });
      return { ok: true, at: now };
    }
    const org = r.org ?? '';
    const recent = (key: string, windowMs: number) => (kv.get<number[]>(key) ?? []).filter((t) => t > now - windowMs);
    const until = (t: number | undefined, windowMs: number) => ((t ?? now) + windowMs - now) / 1000;
    // The entry that must slide out of `list` for fewer than `keep` to remain.
    const slideOut = (list: number[], keep: number) => [...list].sort((a, b) => a - b)[list.length - keep];
    // The breaker: a call passes once the org is under its limit AND (the global count under its limit OR (the org
    // under its floor AND the global overflow under its limit)); with no other call, the later of the first and the
    // sooner of the second's: the global count's slide, or (the later of the org's floor slide and the overflow's).
    const W = L.breaker.windowMs;
    const bOrgKey = `console:breaker:org:${org}`;
    const bOrg = r.breaker ? recent(bOrgKey, W) : [];
    const bGlobal = r.breaker ? recent('console:breaker:global', W) : [];
    const bOver = r.breaker ? recent('console:breaker:overflow', W) : [];
    const overflow = r.breaker && bGlobal.length >= L.breaker.global;
    let breakerShort: { limit: ConsoleLimit; waitS: number } | null = null;
    if (r.breaker) {
      const orgWait = bOrg.length >= L.breaker.perOrg ? until(slideOut(bOrg, L.breaker.perOrg), W) : 0;
      let globalWait = 0;
      if (overflow && (bOrg.length >= L.breaker.floor || bOver.length >= L.breaker.overflow)) {
        const floorWait = Math.max(bOrg.length >= L.breaker.floor ? until(slideOut(bOrg, L.breaker.floor), W) : 0, bOver.length >= L.breaker.overflow ? until(slideOut(bOver, L.breaker.overflow), W) : 0);
        globalWait = Math.min(until(slideOut(bGlobal, L.breaker.global), W), floorWait);
      }
      if (orgWait > 0 || globalWait > 0) breakerShort = { limit: orgWait > 0 ? 'breaker_org' : 'breaker_global', waitS: Math.max(orgWait, globalWait) };
    }
    const orgKey = `console:bucket:org:${org}`;
    const killKey = `console:kill:org:${org}`;
    const floorKey = `console:kill:floor:org:${org}`;
    const FW = L.kill.floor.windowMs;
    let orgTokens = 0;
    let globalTokens = 0;
    let kill = 0;
    let killGlobal = 0;
    let floor: number[] = [];
    if (r.killSwitch) {
      kill = fill(killKey, L.kill.perOrg);
      need('budget_kill', kill, r.cost, L.kill.perOrg);
      // The global kill bucket, unless the org is still within its floor: then the sooner of the two.
      killGlobal = fill('console:kill', L.kill.global);
      floor = recent(floorKey, FW);
      if (killGlobal < r.cost - 1e-6 && floor.length >= L.kill.floor.calls) {
        short.push({ limit: 'budget_kill_global', waitS: Math.min(waitFor(killGlobal, r.cost, L.kill.global), until(slideOut(floor, L.kill.floor.calls), FW)) });
      }
    } else {
      orgTokens = fill(orgKey, L.perOrg);
      globalTokens = fill('console:bucket', L.global);
      need('budget_org', orgTokens, r.cost, L.perOrg);
      need('budget', globalTokens, r.cost, L.global);
    }
    if (breakerShort || short.length > 0) {
      const all = breakerShort ? [breakerShort, ...short] : short;
      const waitS = Math.max(...all.map((x) => x.waitS));
      const named = breakerShort ?? short.reduce((a, b) => (b.waitS > a.waitS ? b : a));
      return refuse(named.limit, waitS);
    }
    if (r.killSwitch) {
      kv.put(killKey, { tokens: Math.max(0, kill - r.cost), at: now });
      // A call within the floor still takes what the global bucket holds (never below zero).
      kv.put('console:kill', { tokens: Math.max(0, killGlobal - r.cost), at: now });
      kv.put(floorKey, [...floor, now]);
    } else {
      kv.put(orgKey, { tokens: Math.max(0, orgTokens - r.cost), at: now });
      kv.put('console:bucket', { tokens: Math.max(0, globalTokens - r.cost), at: now });
    }
    if (r.breaker) {
      kv.put(bOrgKey, [...bOrg, now]);
      kv.put('console:breaker:global', [...bGlobal, now]);
      if (overflow) kv.put('console:breaker:overflow', [...bOver, now]);
    }
    return overflow ? { ok: true, at: now, overflow: true } : { ok: true, at: now };
  }

  /**
   * D937: a breaker call admitted at `at` (as consoleAdmit answered) that changed nothing (`not_found`, `conflict`,
   * `version_conflict`, a replay, a bad input, or a no-op; rpc/common.ts) gets its breaker slot back, once (one entry of
   * its time is removed from its org's list, the global list and, when it was admitted there, the overflow: entries of
   * one time are interchangeable on a list). No tokens are ever given back: a kill switch that changed nothing has paid
   * its org's kill bucket.
   */
  consoleSettle(s: ConsoleSettlement): void {
    if (!s.breaker) return;
    const kv = this.ctx.storage.kv;
    this.clock();
    for (const key of [`console:breaker:org:${s.org}`, 'console:breaker:global', ...(s.overflow ? ['console:breaker:overflow'] : [])]) {
      const list = kv.get<number[]>(key) ?? [];
      const i = list.indexOf(s.at);
      if (i >= 0) kv.put(key, [...list.slice(0, i), ...list.slice(i + 1)]);
    }
  }

  /**
   * D927, D935: the platform's admission (PlatformAdmission), on the object's clock. All of it is taken or nothing is.
   * `notify`: the first refusal of this limit for this org in this clock hour (the caller's `platform_quota` event).
   * Refused, the wait is the longest of every constraint the call is short of (L3: a retry then, nothing else changed,
   * is admitted), named by the breaker when the breaker refuses, else by the constraint that opens last.
   */
  platformAdmit(r: PlatformAdmission, caller?: number): PlatformAdmitResult {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const hour = Math.floor(now / 3_600_000);
    const refuse = (limit: PlatformLimit, waitS: number): PlatformAdmitResult => {
      const key = `platform:noticed:${limit}:${r.org}`;
      const notify = kv.get<number>(key) !== hour;
      if (notify) kv.put(key, hour);
      return { ok: false, limit, retryAfterS: Math.max(1, Math.ceil(waitS)), notify };
    };
    const fill = (key: string, b: Bucket) => {
      const st = kv.get<{ tokens: number; at: number }>(key) ?? { tokens: b.burst, at: now };
      return Math.min(b.burst, st.tokens + (Math.max(0, now - st.at) / 1000) * b.ratePerS);
    };
    const L = r.limits;
    // Each constraint the call is short of, with how long until it isn't (seconds).
    const short: { limit: PlatformLimit; waitS: number }[] = [];
    // A cost a bucket can never hold (none of the routes' costs comes near) is refused for an hour, never "soon".
    const need = (limit: PlatformLimit, tokens: number, needed: number, rate: number, burst: number) => {
      // (A millionth of a token's slack: a retry at the stated second isn't refused by floating-point dust.)
      if (tokens < needed - 1e-6) short.push({ limit, waitS: needed > burst ? 3600 : (needed - tokens) / rate });
    };
    // The breaker (removals): each org's first `floor` of its rolling hour past the global count (D935). Its wait: the
    // org's count below its limit, or the sooner of the global count below its limit and the org's below its floor (L1).
    const recent = (key: string) => (kv.get<number[]>(key) ?? []).filter((t) => t > now - L.breaker.windowMs);
    const bOrgKey = `platform:breaker:org:${r.org}`;
    const bOrg = r.breaker ? recent(bOrgKey) : [];
    const bGlobal = r.breaker ? recent('platform:breaker:global') : [];
    const until = (t: number | undefined) => ((t ?? now) + L.breaker.windowMs - now) / 1000;
    const slideOut = (list: number[], keep: number) => [...list].sort((a, b) => a - b)[list.length - keep];
    // A removal passes once the org is under its limit AND (under its floor OR the global count under its limit): with
    // no other call, the later of the two (L3: a retry then is admitted).
    let breakerShort: { limit: PlatformLimit; waitS: number } | null = null;
    if (r.breaker) {
      const orgWait = bOrg.length >= L.breaker.perOrg ? until(slideOut(bOrg, L.breaker.perOrg)) : 0;
      const globalWait = bOrg.length >= L.breaker.floor && bGlobal.length >= L.breaker.global ? Math.min(until(slideOut(bGlobal, L.breaker.global)), until(slideOut(bOrg, L.breaker.floor))) : 0;
      if (orgWait > 0 || globalWait > 0) breakerShort = { limit: orgWait > 0 ? 'breaker_org' : 'breaker_global', waitS: Math.max(orgWait, globalWait) };
    }
    const orgKey = `platform:bucket:org:${r.org}`;
    const killKey = `platform:kill:org:${r.org}`;
    let kill = 0;
    let orgs: Record<string, number> = {};
    let org = 0;
    let platform = 0;
    if (r.killSwitch) {
      // The cap on orgs switched on, backstopped here: at most `maxOrgs` distinct orgs' kill buckets in any minute.
      orgs = Object.fromEntries(Object.entries(kv.get<Record<string, number>>('platform:kill:orgs') ?? {}).filter(([, t]) => t > now - 60_000));
      if (!(r.org in orgs) && Object.keys(orgs).length >= L.maxOrgs) {
        const oldest = Math.min(...Object.values(orgs));
        short.push({ limit: 'kill_orgs', waitS: (oldest + 60_000 - now) / 1000 });
      }
      kill = fill(killKey, L.kill);
      need('budget_kill', kill, r.cost, L.kill.ratePerS, L.kill.burst);
    } else {
      org = fill(orgKey, L.perOrg);
      // D938: the platform's own buckets only (before, also the console's `console:bucket`, at cost + 30).
      platform = fill('platform:bucket', L.platform);
      need('budget_org', org, r.cost, L.perOrg.ratePerS, L.perOrg.burst);
      need('budget_platform', platform, r.cost, L.platform.ratePerS, L.platform.burst);
    }
    if (breakerShort || short.length > 0) {
      const all = breakerShort ? [breakerShort, ...short] : short;
      const waitS = Math.max(...all.map((x) => x.waitS));
      const named = breakerShort ?? short.reduce((a, b) => (b.waitS > a.waitS ? b : a));
      return refuse(named.limit, waitS);
    }
    if (r.killSwitch) {
      kv.put(killKey, { tokens: Math.max(0, kill - r.cost), at: now });
      kv.put('platform:kill:orgs', { ...orgs, [r.org]: now });
    } else {
      kv.put(orgKey, { tokens: Math.max(0, org - r.cost), at: now });
      kv.put('platform:bucket', { tokens: Math.max(0, platform - r.cost), at: now });
    }
    if (r.breaker) {
      kv.put(bOrgKey, [...bOrg, now]);
      kv.put('platform:breaker:global', [...bGlobal, now]);
    }
    return { ok: true, at: now };
  }

  /**
   * D935 (after PR 161's third review, L2): an org switched off leaves the kill buckets' count of orgs at once, so the
   * org switched on in its place isn't refused `kill_orgs` for the rest of that minute.
   */
  platformForgetOrg(org: string): void {
    const kv = this.ctx.storage.kv;
    this.clock();
    const orgs = kv.get<Record<string, number>>('platform:kill:orgs');
    if (!orgs || !(org in orgs)) return;
    const { [org]: _gone, ...rest } = orgs;
    kv.put('platform:kill:orgs', rest);
  }

  /**
   * D927, D935: a removal admitted at `at` (as platformAdmit answered) that changed nothing gets its breaker slot back,
   * once (the entry is removed). No tokens are ever given back.
   */
  platformSettle(s: { org: string; at: number; breaker: boolean }): void {
    if (!s.breaker) return;
    const kv = this.ctx.storage.kv;
    this.clock();
    for (const key of [`platform:breaker:org:${s.org}`, 'platform:breaker:global']) {
      const list = kv.get<number[]>(key) ?? [];
      const i = list.indexOf(s.at);
      if (i >= 0) kv.put(key, [...list.slice(0, i), ...list.slice(i + 1)]);
    }
  }

  /**
   * An amount budget over fixed windows (the NEAR relay's daily spend, D736): adds `amount` to the window's total when
   * the total stays at most `max`, else refuses and adds nothing. Amounts are non-negative integers as decimal strings
   * (yoctoNEAR exceeds 2^53). `spent` is the window's total after the call. Keys are `budget:<name>@<start>`.
   */
  spend(name: string, windowMs: number, max: string, amount: string, caller?: number): { ok: true; spent: string } | { ok: false; spent: string; retryAfterS: number } {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const start = Math.floor(now / windowMs) * windowMs;
    const key = `budget:${name}@${start}`;
    const spent = BigInt(kv.get<string>(key) ?? '0');
    const next = spent + BigInt(amount);
    if (BigInt(amount) < 0n || next > BigInt(max)) return { ok: false, spent: spent.toString(), retryAfterS: Math.max(1, Math.ceil((start + windowMs - now) / 1000)) };
    kv.put(key, next.toString());
    for (const [k] of kv.list<string>({ prefix: `budget:${name}@` })) {
      if (Number(k.slice(`budget:${name}@`.length)) + windowMs <= now) kv.delete(k);
    }
    return { ok: true, spent: next.toString() };
  }

  /** The total `spend` has counted in the window of `now` ('0' when none). Read only (the admin's NEAR relay tile, D785). */
  spent(name: string, windowMs: number, caller?: number): string {
    const now = this.clock(caller);
    return this.ctx.storage.kv.get<string>(`budget:${name}@${Math.floor(now / windowMs) * windowMs}`) ?? '0';
  }

  /**
   * Adds `amount` to the window of `at` whatever its total (what a relay burnt beyond its reservation): the next
   * `spend` sees it. An ended window is left alone.
   */
  charge(name: string, windowMs: number, amount: string, at: number, caller?: number): void {
    const now = this.clock(caller);
    const start = Math.floor(at / windowMs) * windowMs;
    if (start + windowMs <= now || BigInt(amount) <= 0n) return;
    const kv = this.ctx.storage.kv;
    const key = `budget:${name}@${start}`;
    kv.put(key, (BigInt(kv.get<string>(key) ?? '0') + BigInt(amount)).toString());
  }

  /** Gives back part of a `spend(name, windowMs, …, at)` (what a relay didn't burn); never below zero, an ended window is left alone. */
  giveBack(name: string, windowMs: number, amount: string, at: number): void {
    const kv = this.ctx.storage.kv;
    const key = `budget:${name}@${Math.floor(at / windowMs) * windowMs}`;
    const spent = kv.get<string>(key);
    if (spent === undefined || BigInt(amount) <= 0n) return;
    const next = BigInt(spent) - BigInt(amount);
    kv.put(key, (next > 0n ? next : 0n).toString());
  }

  /**
   * A value that only grows (the highest delegate nonce the NEAR relay sent for one sender, D736): stored durably, never
   * expires. Decimal strings (u64). `floor` reads it ('0' when none), `raiseFloor` keeps the larger.
   */
  floor(name: string): string {
    return this.ctx.storage.kv.get<string>(`floor:${name}`) ?? '0';
  }

  raiseFloor(name: string, value: string): void {
    const kv = this.ctx.storage.kv;
    if (BigInt(value) > BigInt(kv.get<string>(`floor:${name}`) ?? '0')) kv.put(`floor:${name}`, value);
  }

  /**
   * A small durable queue (the NEAR relay's billing records that D1 couldn't take, D863): `queuePush` keeps `item` unless
   * `max` are already held (false then); `queuePeek` lists the oldest `n` with their keys; `queueAck` drops those keys.
   */
  queuePush(name: string, item: unknown, max: number, caller?: number): boolean {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    const countKey = `qn:${name}`;
    const held = kv.get<number>(countKey) ?? 0;
    if (held >= max) return false;
    const seq = (kv.get<number>(`qs:${name}`) ?? 0) + 1;
    kv.put(`qs:${name}`, seq);
    kv.put(`q:${name}:${String(now).padStart(16, '0')}:${String(seq).padStart(10, '0')}`, item);
    kv.put(countKey, held + 1);
    return true;
  }

  queuePeek(name: string, n: number): [string, unknown][] {
    return Array.from(this.ctx.storage.kv.list<unknown>({ prefix: `q:${name}:`, limit: n }));
  }

  queueLength(name: string): number {
    return this.ctx.storage.kv.get<number>(`qn:${name}`) ?? 0;
  }

  queueAck(name: string, keys: string[]): void {
    const kv = this.ctx.storage.kv;
    let held = kv.get<number>(`qn:${name}`) ?? 0;
    for (const k of keys) if (k.startsWith(`q:${name}:`) && kv.delete(k)) held--;
    kv.put(`qn:${name}`, Math.max(0, held));
  }

  /**
   * D927: one platform request's nonce (A3 check 7), on the key's own `platform-nonce:<keyId>` object. `replayed` while
   * an unexpired marker for it exists; else, if `cap` still has room (the object's size bound: fresh nonces a window) or
   * `cap` is empty (a valid self-revoke, which can succeed once per key: F1), the marker is held until `untilMs` and the
   * answer is `ok`; else `full`, and nothing is written. Atomic in the object.
   */
  reserveNonce(nonce: string, untilMs: number, cap: Limit[], caller?: number, notAfter?: number): 'ok' | 'replayed' | 'full' | 'stale' {
    const kv = this.ctx.storage.kv;
    const now = this.clock(caller);
    // D935 (L1): the request's timestamp window ends at `notAfter`; on this clock past it, the nonce isn't reserved (a
    // request checked fresh but held up past its marker's hold would otherwise be taken as new).
    if (notAfter !== undefined && now > notAfter) return 'stale';
    const until = kv.get<number>(`mark:n:${nonce}`);
    if (until !== undefined && until > now) return 'replayed';
    if (cap.length > 0 && !this.hit(cap, caller).ok) return 'full';
    kv.put(`mark:n:${nonce}`, untilMs);
    void this.scheduleMarkerSweep(untilMs);
    return 'ok';
  }

  /**
   * D927: `hit(limits)` and, only when it counted, a test-and-set of the marker `mark` until `untilMs` (`reserve`): one
   * call for a platform key's request windows and its once-an-hour `last_used_at` write. `marked` is true when this call
   * set the marker. D935: with `reserve` (a kill switch's own windows), a request the ordinary windows refuse is counted
   * there instead when they have room (`reserve: true`: give back those windows, not the ordinary ones).
   */
  hitMark(limits: Limit[], mark: string, untilMs: number, caller?: number, reserve: Limit[] = []): HitResult & { marked?: boolean; reserve?: true } {
    let r = this.hit(limits, caller);
    let fromReserve = false;
    // D935: a kill switch past the ordinary windows takes from its own reserve windows instead (counted apart, in the
    // same call, so parallel requests can't both take the last slot). Refused by both, it may go as soon as either set
    // has room: the sooner of the two waits (each the longest of its own full windows), named by that set's window.
    if (!r.ok && reserve.length > 0) {
      const first = r;
      const again = this.hit(reserve);
      if (!again.ok) return again.retryAfterS <= first.retryAfterS ? again : first;
      r = again;
      fromReserve = true;
    }
    if (!r.ok) return r;
    return { ...r, marked: this.reserve(mark, untilMs), ...(fromReserve ? { reserve: true as const } : {}) };
  }

  /** Drops a marker (a reservation whose relay definitely did not execute). */
  release(key: string): void {
    this.ctx.storage.kv.delete(`mark:${key}`);
  }

  /**
   * Drops counters of windows that have ended (keys are `<name>@<windowStart>`). Lists only these limits' own keys, so
   * a `hit` never reads the object's markers or other limits' counters (D475).
   */
  private prune(limits: Limit[], now: number): void {
    const kv = this.ctx.storage.kv;
    for (const l of limits) {
      const prefix = `${l.name}@`;
      for (const [key] of kv.list<number>({ prefix })) {
        // A longer name that happens to start with this one (`a@b@<start>` under `a@`) parses as NaN and stays.
        if (Number(key.slice(prefix.length)) + l.windowMs <= now) kv.delete(key);
      }
    }
  }
}
