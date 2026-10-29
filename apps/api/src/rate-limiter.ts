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
}

export type HitResult = { ok: true } | { ok: false; limit: string; retryAfterS: number };

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
    return true;
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
