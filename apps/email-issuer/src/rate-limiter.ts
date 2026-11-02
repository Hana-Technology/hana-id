// Exact fixed-window limits and locks, one object per subject (an address's `email_key`, an IP subject, an app, the
// env's global budget). A hit counts only when every window still has room, so a refused request costs nothing; the
// storage calls are synchronous (SQLite-backed KV), so a hit is atomic inside the object. Keys never hold an address:
// subjects are HMACs under K_rl (spec "Rate limits and abuse"), IP subjects, app ids or `global`.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';

export interface Limit {
  /** Window name, unique per subject (e.g. `codes:15m`). */
  name: string;
  windowMs: number;
  max: number;
}

export type HitResult = { ok: true } | { ok: false; limit: string; retryAfterMs: number };

const LOCK_KEY = 'lock';

export class RateLimiter extends DurableObject<Env> {
  private slots(limits: Limit[], now: number) {
    const kv = this.ctx.storage.kv;
    return limits.map((l) => {
      const start = Math.floor(now / l.windowMs) * l.windowMs;
      const key = `${l.name}@${start}`;
      return { l, key, start, count: kv.get<number>(key) ?? 0 };
    });
  }

  /** Counts one hit in every window, or none when any is full. */
  async hit(limits: Limit[], now: number = Date.now()): Promise<HitResult> {
    const slots = this.slots(limits, now);
    for (const s of slots) if (s.count >= s.l.max) return { ok: false, limit: s.l.name, retryAfterMs: s.start + s.l.windowMs - now };
    for (const s of slots) this.ctx.storage.kv.put(s.key, s.count + 1);
    this.prune(now);
    await this.sweepAt(Math.max(...slots.map((s) => s.start + s.l.windowMs)));
    return { ok: true };
  }

  /** Whether a hit would pass, without counting it. */
  peek(limits: Limit[], now: number = Date.now()): HitResult {
    for (const s of this.slots(limits, now)) if (s.count >= s.l.max) return { ok: false, limit: s.l.name, retryAfterMs: s.start + s.l.windowMs - now };
    return { ok: true };
  }

  /** Takes back one accepted `hit(limits, now)` (same `now`): the send it reserved didn't happen. */
  unhit(limits: Limit[], now: number): void {
    const kv = this.ctx.storage.kv;
    for (const s of this.slots(limits, now)) {
      if (s.count > 1) kv.put(s.key, s.count - 1);
      else if (s.count === 1) kv.delete(s.key);
    }
  }

  /**
   * One wrong code for this address: counts it in `window`, and once the window holds `max`, locks the subject until
   * `now + lockMs`. Returns whether the subject is locked now.
   */
  async wrongCode(window: Limit, lockMs: number, now: number = Date.now()): Promise<boolean> {
    const [s] = this.slots([window], now);
    const count = s!.count + 1;
    this.ctx.storage.kv.put(s!.key, count);
    if (count >= window.max) this.ctx.storage.kv.put(LOCK_KEY, now + lockMs);
    await this.sweepAt(Math.max(s!.start + window.windowMs, now + lockMs));
    return this.locked(now);
  }

  locked(now: number = Date.now()): boolean {
    const until = this.ctx.storage.kv.get<number>(LOCK_KEY);
    return until !== undefined && until > now;
  }

  private prune(now: number): void {
    const kv = this.ctx.storage.kv;
    for (const [key] of kv.list<number>()) {
      if (key === LOCK_KEY) continue;
      const at = key.lastIndexOf('@');
      const start = Number(key.slice(at + 1));
      // Windows are at most a day; anything that ended more than a day ago is gone.
      if (Number.isFinite(start) && start + 2 * 86_400_000 <= now) kv.delete(key);
    }
  }

  private async sweepAt(untilMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < untilMs) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes ended windows and an ended lock; an object left with nothing holds no state at all. */
  override async alarm(): Promise<void> {
    const kv = this.ctx.storage.kv;
    const now = Date.now();
    let next = 0;
    for (const [key, value] of kv.list<number>()) {
      if (key === LOCK_KEY) {
        if (value <= now) kv.delete(key);
        else next = Math.max(next, value);
        continue;
      }
      const start = Number(key.slice(key.lastIndexOf('@') + 1));
      // The window length isn't stored with the key; a day bounds every window used here.
      if (start + 86_400_000 <= now) kv.delete(key);
      else next = Math.max(next, start + 86_400_000);
    }
    if (next > 0) await this.ctx.storage.setAlarm(next + 1);
    else await this.ctx.storage.deleteAll();
  }
}
