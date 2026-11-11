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
  /** hitSliding only: a soft limit never refuses; past it, its name is reported in `soft` (an alert, not a breaker). */
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
  hit(limits: Limit[], now: number = Date.now()): HitResult {
    const kv = this.ctx.storage.kv;
    const slots = limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `${l.name}@${start}`;
      return { l, key, start, count: kv.get<number>(key) ?? 0 };
    });
    for (const s of slots) {
      if (s.count >= s.l.max) return { ok: false, limit: s.l.name, retryAfterS: Math.max(1, Math.ceil((s.start + s.l.windowMs - now) / 1000)) };
    }
    for (const s of slots) kv.put(s.key, s.count + 1);
    this.prune(limits, now);
    return { ok: true };
  }

  /**
   * Takes back one accepted `hit(limits, now)` (same limits, same `now`, so the same windows): a request that several
   * objects must all accept, refused by a later one, then costs the earlier ones nothing. Never goes below zero; a
   * window that has ended since is left alone.
   */
  unhit(limits: Limit[], now: number): void {
    const kv = this.ctx.storage.kv;
    for (const l of limits) {
      const key = `${l.name}@${Math.floor(now / l.windowMs) * l.windowMs}`;
      const count = kv.get<number>(key) ?? 0;
      if (count > 1) kv.put(key, count - 1);
      else if (count === 1) kv.delete(key);
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
      return refuse('budget_reserve', (taken[0]!.at + share.windowMs - now) / 1000);
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
