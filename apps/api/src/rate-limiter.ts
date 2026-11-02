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

export interface ConsoleAdmission {
  cost: number;
  /** The org of a destructive call (counted by the breaker); absent for every other call. */
  breakerOrg?: string;
  budget: { ratePerS: number; burst: number };
  breaker: { windowMs: number; perOrg: number; global: number };
}

export type ConsoleAdmitResult = { ok: true } | { ok: false; limit: 'budget' | 'breaker_org' | 'breaker_global'; retryAfterS: number };

export type HitResult ={ ok: true; soft?: string[] } | { ok: false; limit: string; retryAfterS: number };

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
   * the same key can't all pass. Expired markers are dropped on the next `reserve`.
   */
  reserve(key: string, untilMs: number, now: number = Date.now()): boolean {
    const kv = this.ctx.storage.kv;
    const until = kv.get<number>(`mark:${key}`);
    if (until !== undefined && until > now) return false;
    for (const [k, u] of kv.list<number>({ prefix: 'mark:' })) if (u <= now) kv.delete(k);
    kv.put(`mark:${key}`, untilMs);
    // An object that holds markers but sees no further request (one per session key, for the identity token's proofs)
    // must not keep them forever: an alarm at the latest marker's end deletes the expired ones.
    void this.scheduleMarkerSweep(untilMs);
    return true;
  }

  private async scheduleMarkerSweep(untilMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < untilMs) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes expired markers (and, when nothing else is stored, everything: the object then holds no state). */
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
   * on the one `console-rpc` object: `cost` statements from a token bucket (`rate` per second, `burst`), and for a
   * destructive call one slot in its org's and in the global rolling hour (exact: the call times are kept). Either all
   * of it is taken or nothing is; a refusal says which limit, the breaker before the budget.
   */
  consoleAdmit(r: ConsoleAdmission, now: number = Date.now()): ConsoleAdmitResult {
    const kv = this.ctx.storage.kv;
    const bucket = kv.get<{ tokens: number; at: number }>('console:bucket') ?? { tokens: r.budget.burst, at: now };
    const tokens = Math.min(r.budget.burst, bucket.tokens + (Math.max(0, now - bucket.at) / 1000) * r.budget.ratePerS);
    const recent = (key: string) => (kv.get<number[]>(key) ?? []).filter((t) => t > now - r.breaker.windowMs);
    const orgKey = r.breakerOrg === undefined ? null : `console:breaker:org:${r.breakerOrg}`;
    const org = orgKey ? recent(orgKey) : [];
    const global = orgKey ? recent('console:breaker:global') : [];
    const retry = (oldest: number | undefined) => Math.max(1, Math.ceil(((oldest ?? now) + r.breaker.windowMs - now) / 1000));
    if (orgKey && org.length >= r.breaker.perOrg) return { ok: false, limit: 'breaker_org', retryAfterS: retry(org[0]) };
    if (orgKey && global.length >= r.breaker.global) return { ok: false, limit: 'breaker_global', retryAfterS: retry(global[0]) };
    if (tokens < r.cost) return { ok: false, limit: 'budget', retryAfterS: Math.max(1, Math.ceil((r.cost - tokens) / r.budget.ratePerS)) };
    kv.put('console:bucket', { tokens: tokens - r.cost, at: now });
    if (orgKey) {
      kv.put(orgKey, [...org, now]);
      kv.put('console:breaker:global', [...global, now]);
    }
    return { ok: true };
  }

  /** Drops a marker (a reservation whose relay definitely did not execute). */
  release(key: string): void {
    this.ctx.storage.kv.delete(`mark:${key}`);
  }

  /** Drops counters of windows that have ended (keys are `<name>@<windowStart>`). */
  private prune(limits: Limit[], now: number): void {
    const kv = this.ctx.storage.kv;
    const byName = new Map(limits.map((l) => [l.name, l.windowMs]));
    for (const [key] of kv.list<number>()) {
      if (key.startsWith('mark:')) continue;
      const at = key.lastIndexOf('@');
      const windowMs = byName.get(key.slice(0, at));
      const start = Number(key.slice(at + 1));
      if (windowMs !== undefined && start + windowMs <= now) kv.delete(key);
    }
  }
}
