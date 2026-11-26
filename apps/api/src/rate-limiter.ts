// Fixed-window rate limiter. One instance per subject (`app:<id>` or `ip:<address>`); each call checks several
// windows at once and only counts the hit when every window still has room, so a rejected request costs nothing.
// The storage calls are synchronous (SQLite-backed KV), so a hit is atomic inside the object.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

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
 * One ConsoleRpc call's admission (changes/guard.ts). A member call takes `cost` from its org's bucket and from the
 * global one; a call that isn't a kill switch must leave each bucket's `reserve` untouched, so a flood of reads or
 * settings writes can never take the last tokens the kill switches need. A destructive call also takes a breaker slot.
 * An emailed-link cancel (`link`) takes one token from the link bucket only, never the members' budget.
 */
export interface ConsoleAdmission {
  cost: number;
  /** The caller's org (members); absent for a link cancel. */
  org?: string;
  /** A kill switch (removeOrigins, turnOff, revokeKey, setSuspended(true)): may use the reserves. */
  killSwitch?: boolean;
  /** Counted by the breaker (setSuspended(true), revokeKey, rotateKey, removeOrigins, a web-client change). */
  breaker?: boolean;
  /** An emailed-link cancel: one token of the link-read budget instead of the members' buckets. */
  link?: boolean;
  limits: {
    perOrg: Bucket & { reserve: number };
    /** `reserveShare`: at most `max` tokens of the global reserve per org in any `windowMs`. */
    global: Bucket & { reserve: number; reserveShare: { windowMs: number; max: number } };
    /** The link cancel's token reads (D1 protection), taken before the read. */
    linkRead: Bucket;
    breaker: { windowMs: number; perOrg: number; global: number };
  };
}

export type ConsoleLimit = 'budget_org' | 'budget' | 'budget_reserve' | 'link' | 'breaker_org' | 'breaker_global';

/**
 * D927 (after PR 156's review, F3; the second review, N2): one platform request's admission, on the same `console-rpc`
 * object as the console's. The platform's own keys for its org buckets, its own global bucket and its own breaker
 * (M3). An ordinary platform call also charges the console's global bucket (`console:bucket`) and never takes it below
 * `sharedFloor`, so the console always keeps the top of its bucket. A platform kill switch neither reads nor charges
 * `console:bucket` (the second review, N2, and its review): a console flood can't refuse it, and it can't spend the
 * console's own kill-switch reserve; it is bounded by the org's bucket, the platform's own bucket and reserve with each
 * org's share of it (`reserveShare`), and the breaker.
 */
export interface PlatformAdmission {
  org: string;
  cost: number;
  killSwitch?: boolean;
  breaker?: boolean;
  limits: {
    perOrg: Bucket & { reserve: number };
    platform: Bucket & { reserve: number; reserveShare: { windowMs: number; max: number } };
    /** The console's global bucket, as CONSOLE_LIMITS.global (its rate and burst), and the floor ordinary platform calls leave. */
    shared: Bucket & { sharedFloor: number };
    /**
     * D935: `floor`, the org's first calls of its rolling hour that the global count never refuses (so other orgs can't
     * use up an org's kill switches); every admitted call still counts on both lists.
     */
    breaker: { windowMs: number; perOrg: number; global: number; floor: number };
    /**
     * D935 after PR 161's reviews: each org's own slice of the hot database for its kill switches
     * (`platform:kill:org:<org>`), outside the platform's shared bucket, so no other org can use it: a kill switch is
     * paid from it while it has the call's cost, and only past it from the shared bucket and its reserve.
     */
    killSlice: Bucket;
    /**
     * Kill switches that changed nothing, per org (`platform:kill-noops:org:<org>`): while under `max` in the window, a
     * no-op gets back the tokens it didn't run; past it, nothing (it pays its whole cost), so no-ops can't be spammed for
     * free. Never the stops' or the revocations' quotas (a no-op never reaches them).
     */
    killNoops: { windowMs: number; max: number };
  };
}
export type PlatformLimit = 'budget_org' | 'budget_platform' | 'budget_shared' | 'budget_reserve' | 'breaker_org' | 'breaker_global';
/** `sliceUsed`: tokens of the org's kill-switch slice the call took (it then took nothing of the shared bucket). */
export type PlatformAdmitResult = { ok: true; reserveUsed: number; sliceUsed?: number } | { ok: false; limit: PlatformLimit; retryAfterS: number; notify: boolean };

/**
 * `notify`: the first breaker refusal of this limit (the org's, or the global one) in this clock hour, the only one the
 * caller writes a security event for.
 */
/** `reserveUsed`: tokens of the global reserve this call took (settled back by `consoleSettle` if it changed nothing). */
export type ConsoleAdmitResult = { ok: true; reserveUsed: number } | { ok: false; limit: ConsoleLimit; retryAfterS: number; notify: boolean };

/** What a member call that changed nothing gives back (consoleSettle). */
export interface ConsoleSettlement {
  org: string;
  /** The admission time (`now` of consoleAdmit). */
  at: number;
  /** Its breaker slot. */
  breaker: boolean;
  /** Global reserve tokens it took: given back to the reserve and charged to the org's own bucket instead. */
  reserveUsed: number;
  limits: ConsoleAdmission['limits'];
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
  /** `n` (D929): the hit counts `n` at once (a request proposing several web addresses), all or none. */
  hit(limits: Limit[], now: number = Date.now(), n = 1): HitResult {
    const kv = this.ctx.storage.kv;
    const slots = limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `${l.name}@${start}`;
      return { l, key, start, count: kv.get<number>(key) ?? 0 };
    });
    // A soft window never refuses and still counts. Past its max it is reported in `soft` on every hit until the caller
    // says its alert was written (`markAlerted`, a marker per window), so a failed write is retried by the next hit and
    // a written one is never repeated in the window (D925, after the review of PR 153's fixes: detection fails closed).
    const soft: string[] = [];
    for (const s of slots) {
      if (s.count + n <= s.l.max) continue;
      if (s.l.soft) {
        if (kv.get<number>(`alerted:${s.key}`) === undefined) soft.push(s.l.name);
      } else return { ok: false, limit: s.l.name, retryAfterS: Math.max(1, Math.ceil((s.start + s.l.windowMs - now) / 1000)) };
    }
    for (const s of slots) kv.put(s.key, s.count + n);
    this.prune(limits, now);
    return soft.length > 0 ? { ok: true, soft } : { ok: true };
  }

  /**
   * Notes that the alert of each named soft window of `limits` at `now` was written: `hit` stops naming it in that window
   * (D925). Old markers of these limits are deleted here (a marker lives two windows), so they don't pile up.
   */
  markAlerted(limits: Limit[], names: string[], now: number = Date.now()): void {
    const kv = this.ctx.storage.kv;
    for (const l of limits) {
      if (!l.soft || !names.includes(l.name)) continue;
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      kv.put(`alerted:${l.name}@${start}`, now);
      for (const [key] of kv.list<number>({ prefix: `alerted:${l.name}@` })) if (Number(key.slice(key.lastIndexOf('@') + 1)) + 2 * l.windowMs <= now) kv.delete(key);
    }
  }

  /**
   * Takes back one accepted `hit(limits, now, n)` (same limits, same `now` and `n`, so the same windows): a request that several
   * objects must all accept, refused by a later one, then costs the earlier ones nothing. Never goes below zero; a
   * window that has ended since is left alone.
   */
  unhit(limits: Limit[], now: number, n = 1): void {
    const kv = this.ctx.storage.kv;
    for (const l of limits) {
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
  reserve(key: string, untilMs: number, now: number = Date.now()): boolean {
    const kv = this.ctx.storage.kv;
    const until = kv.get<number>(`mark:${key}`);
    if (until !== undefined && until > now) return false;
    kv.put(`mark:${key}`, untilMs);
    void this.scheduleMarkerSweep(untilMs);
    return true;
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
  hitSliding(limits: Limit[], now: number = Date.now()): HitResult {
    const kv = this.ctx.storage.kv;
    const slots = limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `slide:${l.name}@${start}`;
      const current = kv.get<number>(key) ?? 0;
      const previous = kv.get<number>(`slide:${l.name}@${start - l.windowMs}`) ?? 0;
      const estimate = current + previous * ((l.windowMs - (now - start)) / l.windowMs);
      return { l, key, start, current, previous, estimate };
    });
    const soft: string[] = [];
    for (const s of slots) {
      if (s.estimate < s.l.max) continue;
      if (s.l.soft) soft.push(s.l.name);
      else return { ok: false, limit: s.l.name, retryAfterS: Math.max(1, Math.ceil(slidingWait(s.l, now - s.start, s.current, s.previous) / 1000)) };
    }
    for (const s of slots) kv.put(s.key, s.current + 1);
    for (const [key] of kv.list<number>({ prefix: 'slide:' })) {
      const at = key.lastIndexOf('@');
      const l = limits.find((x) => `slide:${x.name}` === key.slice(0, at));
      if (l && Number(key.slice(at + 1)) + 2 * l.windowMs <= now) kv.delete(key);
    }
    return soft.length > 0 ? { ok: true, soft } : { ok: true };
  }

  /** Takes back one accepted `hitSliding(limits, now)` (same `now`): a later window refused the request. */
  unhitSliding(limits: Limit[], now: number): void {
    const kv = this.ctx.storage.kv;
    for (const l of limits) {
      const key = `slide:${l.name}@${Math.floor(now / l.windowMs) * l.windowMs}`;
      const count = kv.get<number>(key) ?? 0;
      if (count > 1) kv.put(key, count - 1);
      else if (count === 1) kv.delete(key);
    }
  }

  /**
   * ConsoleRpc's admission (docs/batch-c-spec.md §RPC "Destructive-call breaker", "Hot-DB budget"; changes/guard.ts),
   * on the one `console-rpc` object: token buckets (per org and global for members, one for emailed-link cancels) and,
   * for a destructive call, one slot in its org's and in the global rolling hour (exact: the call times are kept).
   * Either all of it is taken or nothing is.
   */
  consoleAdmit(r: ConsoleAdmission, now: number = Date.now()): ConsoleAdmitResult {
    const kv = this.ctx.storage.kv;
    const hour = Math.floor(now / 3_600_000);
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
    if (r.link) {
      const tokens = fill('console:link-read', r.limits.linkRead);
      if (tokens < r.cost) return refuse('link', (r.cost - tokens) / r.limits.linkRead.ratePerS);
      kv.put('console:link-read', { tokens: tokens - r.cost, at: now });
      return { ok: true, reserveUsed: 0 };
    }
    const orgKey = `console:bucket:org:${r.org ?? ''}`;
    const orgTokens = fill(orgKey, r.limits.perOrg);
    const globalTokens = fill('console:bucket', r.limits.global);
    const recent = (key: string) => (kv.get<number[]>(key) ?? []).filter((t) => t > now - r.limits.breaker.windowMs);
    const bOrgKey = `console:breaker:org:${r.org ?? ''}`;
    const bOrg = r.breaker ? recent(bOrgKey) : [];
    const bGlobal = r.breaker ? recent('console:breaker:global') : [];
    const until = (oldest: number | undefined) => ((oldest ?? now) + r.limits.breaker.windowMs - now) / 1000;
    if (r.breaker && bOrg.length >= r.limits.breaker.perOrg) return refuse('breaker_org', until(bOrg[0]));
    if (r.breaker && bGlobal.length >= r.limits.breaker.global) return refuse('breaker_global', until(bGlobal[0]));
    const orgFloor = r.killSwitch ? 0 : r.limits.perOrg.reserve;
    const globalFloor = r.killSwitch ? 0 : r.limits.global.reserve;
    if (orgTokens - r.cost < orgFloor) return refuse('budget_org', (r.cost + orgFloor - orgTokens) / r.limits.perOrg.ratePerS);
    if (globalTokens - r.cost < globalFloor) return refuse('budget', (r.cost + globalFloor - globalTokens) / r.limits.global.ratePerS);
    // A kill switch dipping into the global reserve takes at most its org's share of it per window, so one org's
    // kill switches (no-ops included) can't drain what every other org's kill switches rely on.
    const reserveUsed = r.killSwitch ? Math.max(0, r.cost - Math.max(0, globalTokens - r.limits.global.reserve)) : 0;
    const shareKey = `console:reserve:org:${r.org ?? ''}`;
    const share = r.limits.global.reserveShare;
    const taken = (kv.get<{ at: number; n: number }[]>(shareKey) ?? []).filter((e) => e.at > now - share.windowMs);
    if (reserveUsed > 0 && taken.reduce((n, e) => n + e.n, 0) + reserveUsed > share.max) {
      return refuse('budget_reserve', ((taken[0]?.at ?? now) + share.windowMs - now) / 1000);
    }
    kv.put(orgKey, { tokens: orgTokens - r.cost, at: now });
    kv.put('console:bucket', { tokens: globalTokens - r.cost, at: now });
    if (reserveUsed > 0) kv.put(shareKey, [...taken, { at: now, n: reserveUsed }]);
    if (r.breaker) {
      kv.put(bOrgKey, [...bOrg, now]);
      kv.put('console:breaker:global', [...bGlobal, now]);
    }
    return { ok: true, reserveUsed };
  }

  /**
   * Settles a member call admitted at `at` that changed nothing (`not_found`, `conflict`, `version_conflict`, a replay,
   * a bad input, or a no-op; changes/guard.ts): its breaker slot comes back, and the global reserve tokens it took go
   * back to the reserve and are charged to the org's own bucket instead (which may go below zero: the org's next
   * ordinary calls wait for it). So refused or empty kill switches cost their org, never the shared reserve.
   */
  consoleSettle(s: ConsoleSettlement, now: number = Date.now()): void {
    const kv = this.ctx.storage.kv;
    if (s.breaker) {
      for (const key of [`console:breaker:org:${s.org}`, 'console:breaker:global']) {
        const list = kv.get<number[]>(key) ?? [];
        const i = list.indexOf(s.at);
        if (i >= 0) kv.put(key, [...list.slice(0, i), ...list.slice(i + 1)]);
      }
    }
    if (s.reserveUsed > 0) {
      const fill = (key: string, b: Bucket) => {
        const st = kv.get<{ tokens: number; at: number }>(key) ?? { tokens: b.burst, at: now };
        return Math.min(b.burst, st.tokens + (Math.max(0, now - st.at) / 1000) * b.ratePerS);
      };
      kv.put('console:bucket', { tokens: Math.min(s.limits.global.burst, fill('console:bucket', s.limits.global) + s.reserveUsed), at: now });
      const orgKey = `console:bucket:org:${s.org}`;
      kv.put(orgKey, { tokens: fill(orgKey, s.limits.perOrg) - s.reserveUsed, at: now });
      const shareKey = `console:reserve:org:${s.org}`;
      const list = kv.get<{ at: number; n: number }[]>(shareKey) ?? [];
      const i = list.findIndex((e) => e.at === s.at);
      if (i >= 0) kv.put(shareKey, [...list.slice(0, i), ...list.slice(i + 1)]);
    }
  }

  /**
   * D927: the platform's admission (PlatformAdmission). All of it is taken or nothing is. `notify`: the first refusal of
   * this limit for this org in this clock hour (the caller's `platform_quota` event).
   */
  platformAdmit(r: PlatformAdmission, now: number = Date.now()): PlatformAdmitResult {
    const kv = this.ctx.storage.kv;
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
    const orgKey = `platform:bucket:org:${r.org}`;
    const orgTokens = fill(orgKey, L.perOrg);
    const platformTokens = fill('platform:bucket', L.platform);
    const sharedTokens = fill('console:bucket', L.shared);
    const recent = (key: string) => (kv.get<number[]>(key) ?? []).filter((t) => t > now - L.breaker.windowMs);
    const bOrgKey = `platform:breaker:org:${r.org}`;
    const bOrg = r.breaker ? recent(bOrgKey) : [];
    const bGlobal = r.breaker ? recent('platform:breaker:global') : [];
    const until = (oldest: number | undefined) => ((oldest ?? now) + L.breaker.windowMs - now) / 1000;
    // The time the `k`-th newest entry of a list slides out (the list sorted, as settles may have removed entries).
    const slideOut = (list: number[], keep: number) => [...list].sort((a, b) => a - b)[list.length - keep];
    if (r.breaker && bOrg.length >= L.breaker.perOrg) return refuse('breaker_org', until(slideOut(bOrg, L.breaker.perOrg)));
    // D935: below its floor an org's call passes whatever the global count (other orgs can't use up its kill switches);
    // above it the global count holds, every call (floor ones too) counted on it. The wait (after PR 161's review, L1):
    // the sooner of the global count falling below its limit (floor calls can take the list past it) and the org's own
    // count falling below its floor.
    if (r.breaker && bOrg.length >= L.breaker.floor && bGlobal.length >= L.breaker.global) {
      return refuse('breaker_global', Math.min(until(slideOut(bGlobal, L.breaker.global)), until(slideOut(bOrg, L.breaker.floor))));
    }
    const orgFloor = r.killSwitch ? 0 : L.perOrg.reserve;
    const platformFloor = r.killSwitch ? 0 : L.platform.reserve;
    if (orgTokens - r.cost < orgFloor) return refuse('budget_org', (r.cost + orgFloor - orgTokens) / L.perOrg.ratePerS);
    const commitBreaker = () => {
      if (!r.breaker) return;
      kv.put(bOrgKey, [...bOrg, now]);
      kv.put('platform:breaker:global', [...bGlobal, now]);
    };
    // D935 after PR 161's reviews: a kill switch is paid first from its org's own slice, which no other org can use, so
    // an org's kill switches never depend on what other orgs do; only past the slice does it draw on the shared bucket.
    if (r.killSwitch) {
      const sliceKey = `platform:kill:org:${r.org}`;
      const slice = fill(sliceKey, L.killSlice);
      if (slice >= r.cost) {
        const takenKey = `${sliceKey}:taken`;
        const takenSlice = (kv.get<{ at: number; n: number; settled?: true }[]>(takenKey) ?? []).filter((e) => e.at > now - 60_000);
        kv.put(orgKey, { tokens: orgTokens - r.cost, at: now });
        kv.put(sliceKey, { tokens: slice - r.cost, at: now });
        kv.put(takenKey, [...takenSlice, { at: now, n: r.cost }]);
        commitBreaker();
        return { ok: true, reserveUsed: 0, sliceUsed: r.cost };
      }
    }
    if (platformTokens - r.cost < platformFloor) return refuse('budget_platform', (r.cost + platformFloor - platformTokens) / L.platform.ratePerS);
    if (!r.killSwitch && sharedTokens - r.cost < L.shared.sharedFloor) return refuse('budget_shared', (r.cost + L.shared.sharedFloor - sharedTokens) / L.shared.ratePerS);
    const reserveUsed = r.killSwitch ? Math.max(0, r.cost - Math.max(0, platformTokens - L.platform.reserve)) : 0;
    const shareKey = `platform:reserve:org:${r.org}`;
    const share = L.platform.reserveShare;
    const taken = (kv.get<{ at: number; n: number }[]>(shareKey) ?? []).filter((e) => e.at > now - share.windowMs);
    // (D935: `taken` may be empty when one call alone would need more than the share; it is refused for the window, not thrown.)
    if (reserveUsed > 0 && taken.reduce((n, e) => n + e.n, 0) + reserveUsed > share.max) return refuse('budget_reserve', ((taken[0]?.at ?? now) + share.windowMs - now) / 1000);
    kv.put(orgKey, { tokens: orgTokens - r.cost, at: now });
    kv.put('platform:bucket', { tokens: platformTokens - r.cost, at: now });
    if (!r.killSwitch) kv.put('console:bucket', { tokens: sharedTokens - r.cost, at: now });
    if (reserveUsed > 0) kv.put(shareKey, [...taken, { at: now, n: reserveUsed }]);
    commitBreaker();
    return { ok: true, reserveUsed };
  }

  /**
   * D927: a platform call admitted at `at` that changed nothing: its breaker slot back, and the kill-switch tokens it
   * took back less the statements it did run (`ran`: after PR 161's review, L2, every statement stays paid): to its
   * org's own slice, or to the platform's reserve, charged to its org's own bucket instead (as consoleSettle does). Only while
   * the org's no-ops of the last minute are under `killNoops.max`; past it nothing comes back, so a no-op flood pays in
   * full from its own org's slice and share. The refund happens once per admission: its entry is found unsettled and
   * marked settled (with what stays spent still counted against the org's share), so a second settle refunds nothing
   * (the second review, N6).
   */
  platformSettle(
    s: { org: string; at: number; breaker: boolean; reserveUsed: number; sliceUsed?: number; ran?: number; limits: PlatformAdmission['limits'] },
    now: number = Date.now(),
  ): void {
    const kv = this.ctx.storage.kv;
    if (s.breaker) {
      for (const key of [`platform:breaker:org:${s.org}`, 'platform:breaker:global']) {
        const list = kv.get<number[]>(key) ?? [];
        const i = list.indexOf(s.at);
        if (i >= 0) kv.put(key, [...list.slice(0, i), ...list.slice(i + 1)]);
      }
    }
    const sliceUsed = s.sliceUsed ?? 0;
    if (s.reserveUsed <= 0 && sliceUsed <= 0) return;
    const fill = (key: string, b: Bucket) => {
      const st = kv.get<{ tokens: number; at: number }>(key) ?? { tokens: b.burst, at: now };
      return Math.min(b.burst, st.tokens + (Math.max(0, now - st.at) / 1000) * b.ratePerS);
    };
    // Finds this admission's unsettled entry and marks it settled with what stays spent; null when there is none.
    const settleEntry = (key: string, n: number, back: (n: number) => number): number | null => {
      const list = kv.get<{ at: number; n: number; settled?: true }[]>(key) ?? [];
      const i = list.findIndex((e) => e.at === s.at && e.n === n && !e.settled);
      if (i < 0) return null;
      const b = back(n);
      kv.put(key, [...list.slice(0, i), ...(b === n ? [] : [{ at: s.at, n: n - b, settled: true as const }]), ...list.slice(i + 1)]);
      return b;
    };
    const noopKey = `platform:kill-noops:org:${s.org}`;
    const noops = (kv.get<number[]>(noopKey) ?? []).filter((t) => t > now - s.limits.killNoops.windowMs);
    const free = noops.length < s.limits.killNoops.max;
    const ran = Math.max(0, s.ran ?? 0);
    const back = (n: number) => (free ? n - Math.min(n, ran) : 0);
    const orgKey = `platform:bucket:org:${s.org}`;
    let given = 0;
    if (sliceUsed > 0) {
      const sliceKey = `platform:kill:org:${s.org}`;
      const b = settleEntry(`${sliceKey}:taken`, sliceUsed, back);
      if (b === null) return;
      // The slice is the org's own: nothing to move onto its bucket (which paid the call's whole cost at admission).
      kv.put(sliceKey, { tokens: Math.min(s.limits.killSlice.burst, fill(sliceKey, s.limits.killSlice) + b), at: now });
    } else {
      const b = settleEntry(`platform:reserve:org:${s.org}`, s.reserveUsed, back);
      if (b === null) return;
      kv.put('platform:bucket', { tokens: Math.min(s.limits.platform.burst, fill('platform:bucket', s.limits.platform) + b), at: now });
      given = b;
    }
    kv.put(noopKey, [...noops, now]);
    if (given > 0) kv.put(orgKey, { tokens: fill(orgKey, s.limits.perOrg) - given, at: now });
  }

  /**
   * An amount budget over fixed windows (the NEAR relay's daily spend, D736): adds `amount` to the window's total when
   * the total stays at most `max`, else refuses and adds nothing. Amounts are non-negative integers as decimal strings
   * (yoctoNEAR exceeds 2^53). `spent` is the window's total after the call. Keys are `budget:<name>@<start>`.
   */
  spend(name: string, windowMs: number, max: string, amount: string, now: number = Date.now()): { ok: true; spent: string } | { ok: false; spent: string; retryAfterS: number } {
    const kv = this.ctx.storage.kv;
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
  spent(name: string, windowMs: number, now: number = Date.now()): string {
    return this.ctx.storage.kv.get<string>(`budget:${name}@${Math.floor(now / windowMs) * windowMs}`) ?? '0';
  }

  /**
   * Adds `amount` to the window of `at` whatever its total (what a relay burnt beyond its reservation): the next
   * `spend` sees it. An ended window is left alone.
   */
  charge(name: string, windowMs: number, amount: string, at: number, now: number = Date.now()): void {
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
  queuePush(name: string, item: unknown, max: number, now: number = Date.now()): boolean {
    const kv = this.ctx.storage.kv;
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
  reserveNonce(nonce: string, untilMs: number, cap: Limit[], now: number = Date.now()): 'ok' | 'replayed' | 'full' {
    const kv = this.ctx.storage.kv;
    const until = kv.get<number>(`mark:n:${nonce}`);
    if (until !== undefined && until > now) return 'replayed';
    if (cap.length > 0 && !this.hit(cap, now).ok) return 'full';
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
  hitMark(limits: Limit[], mark: string, untilMs: number, now: number = Date.now(), reserve: Limit[] = []): HitResult & { marked?: boolean; reserve?: true } {
    let r = this.hit(limits, now);
    let fromReserve = false;
    // D935: a kill switch past the ordinary windows takes from its own reserve windows instead (counted apart, in the
    // same call, so parallel requests can't both take the last slot). Refused by both: the reserve's window is named,
    // with the sooner of the two waits.
    if (!r.ok && reserve.length > 0) {
      const first = r;
      const again = this.hit(reserve, now);
      if (!again.ok) return { ...again, retryAfterS: Math.min(first.retryAfterS, again.retryAfterS) };
      r = again;
      fromReserve = true;
    }
    if (!r.ok) return r;
    return { ...r, marked: this.reserve(mark, untilMs, now), ...(fromReserve ? { reserve: true as const } : {}) };
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
