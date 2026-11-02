// Exact limits, one object per subject: a mailbox (`mbx:` + HMAC under K_rl of the normalized address without its
// `+tag`), an IP subject, an app, the env's global budget, a staff member. Keys never hold an address or a raw IP
// (requesters inside a mailbox object are sha256 prefixes of their IP subject).
//
// Every decision is one call, and every call's checks and writes run synchronously (SQLite-backed KV), before any await,
// so concurrent requests can't all pass a check before any is counted (D198):
// - `hit` / `peek` / `unhit`: plain fixed windows (IP, app, global, staff);
// - `admit`: a new challenge for this mailbox (refused when locked, or when it already has MAX_LIVE live challenges),
//   with, when a code is to go out, the send reserved (`reserveSend`'s rules) in the same step;
// - `reserveSend`: one code mail, per (mailbox, requester) first, then mailbox-wide, then a small reserve for a requester
//   that hasn't asked for this mailbox today, so an attacker who knows the address can't use up its owner's codes;
// - `reserveGuess`: one code check, counted before the code is compared and refunded (`refundGuess`) when it was right;
//   refused at the mailbox's hard ceiling (25 failed checks per UTC day, whoever asks), past its backstop (20) except
//   for the separately counted owner slot (5), and while the requester is locked out of the mailbox (D198).
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import {
  MAILBOX_CODE_LIMITS,
  MAILBOX_IP_CODE_LIMITS,
  MAILBOX_IP_LOCK_MS,
  MAILBOX_IP_WRONG_DAY,
  MAILBOX_IP_WRONG_LIMIT,
  MAILBOX_CHALLENGES_PER_DAY,
  MAILBOX_OWNER_SLOT,
  MAILBOX_RESERVE_LIMIT,
  MAILBOX_WRONG_BACKSTOP,
  MAILBOX_WRONG_CEILING,
  MAX_LIVE_CHALLENGES,
} from './limits.ts';

export interface Limit {
  /** Window name, unique per subject (e.g. `codes:15m`). */
  name: string;
  windowMs: number;
  max: number;
}

export type HitResult = { ok: true } | { ok: false; limit: string; retryAfterMs: number };

/** The window keys a reservation counted, so exactly those are taken back. */
export type Reservation = { keys: string[] };
export type Admitted = { ok: true; send: Reservation | null } | { ok: false; reason: 'locked' | 'live' | 'codes' | 'challenges'; retryAfterMs: number };
export type Reserved = { ok: true; reservation: Reservation } | { ok: false; reason: 'locked' | 'codes'; retryAfterMs: number };
export type Guess = { ok: true; reservation: Reservation; tripped?: 'backstop' | 'ceiling' } | { ok: false; reason: 'locked'; retryAfterMs: number };

const DAY = 86_400_000;
const LIVE_KEY = 'live';
const ipLock = (ip: string) => `lock:${ip}`;

interface Slot {
  l: Limit;
  key: string;
  start: number;
  count: number;
}

export class RateLimiter extends DurableObject<Env> {
  private kv() {
    return this.ctx.storage.kv;
  }

  private slot(l: Limit, now: number, prefix = ''): Slot {
    const start = Math.floor(now / l.windowMs) * l.windowMs;
    const key = `${prefix}${l.name}@${start}`;
    return { l, key, start, count: this.kv().get<number>(key) ?? 0 };
  }

  private firstFull(slots: Slot[], now: number): { limit: string; retryAfterMs: number } | null {
    for (const s of slots) if (s.count >= s.l.max) return { limit: s.l.name, retryAfterMs: s.start + s.l.windowMs - now };
    return null;
  }

  private count(slots: Slot[]): string[] {
    for (const s of slots) this.kv().put(s.key, s.count + 1);
    return slots.map((s) => s.key);
  }

  // ---- plain windows ----

  /** Counts one hit in every window, or none when any is full. */
  async hit(limits: Limit[], now: number = Date.now()): Promise<HitResult> {
    const slots = limits.map((l) => this.slot(l, now));
    const full = this.firstFull(slots, now);
    if (full) return { ok: false, ...full };
    this.count(slots);
    await this.sweepAt(Math.max(...slots.map((s) => s.start + s.l.windowMs)));
    return { ok: true };
  }

  /** Whether a hit would pass, without counting it. */
  peek(limits: Limit[], now: number = Date.now()): HitResult {
    const full = this.firstFull(
      limits.map((l) => this.slot(l, now)),
      now,
    );
    return full ? { ok: false, ...full } : { ok: true };
  }

  /** Takes back one accepted `hit(limits, now)` (same `now`). */
  unhit(limits: Limit[], now: number): void {
    this.refund({ keys: limits.map((l) => this.slot(l, now).key) });
  }

  /** Takes back exactly the windows a reservation counted (windows that ended since are gone anyway). */
  refund(r: Reservation): void {
    const kv = this.kv();
    for (const key of r.keys) {
      const c = kv.get<number>(key) ?? 0;
      if (c > 1) kv.put(key, c - 1);
      else if (c === 1) kv.delete(key);
    }
  }

  // ---- a mailbox ----

  /** The UTC day's window start. */
  private day(now: number): number {
    return Math.floor(now / DAY) * DAY;
  }

  /** The next number of this object's per-day event sequence: orders starts and the trip whatever the clock says. */
  private nextSeq(now: number): number {
    const k = `seq@${this.day(now)}`;
    const n = (this.kv().get<number>(k) ?? 0) + 1;
    this.kv().put(k, n);
    return n;
  }

  /**
   * Whether this requester may use the owner slot now: it started a challenge on this mailbox (today) before the
   * backstop tripped, and has no failed check on it today.
   */
  private ownerExempt(ip: string, now: number): boolean {
    const d = this.day(now);
    const trippedAt = this.kv().get<number>(`trip@${d}`);
    const startedAt = this.kv().get<number>(`start:${ip}@${d}`);
    return trippedAt !== undefined && startedAt !== undefined && startedAt < trippedAt && this.slot(MAILBOX_IP_WRONG_DAY, now, `ip:${ip}:`).count === 0;
  }

  /**
   * ms until this requester may act on this mailbox again (0: now), D198: the requester's own lock; the hard ceiling
   * (nobody, until the UTC day ends); past the backstop, only an owner-slot requester while the slot lasts.
   */
  private lockedFor(ip: string, now: number): number {
    const until = this.kv().get<number>(ipLock(ip)) ?? 0;
    if (until > now) return until - now;
    const endOfDay = this.day(now) + DAY - now;
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    if (ceiling.count >= ceiling.l.max) return endOfDay;
    const backstop = this.slot(MAILBOX_WRONG_BACKSTOP, now);
    if (backstop.count < backstop.l.max) return 0;
    const owner = this.slot(MAILBOX_OWNER_SLOT, now);
    return this.ownerExempt(ip, now) && owner.count < owner.l.max ? 0 : endOfDay;
  }

  private trySend(ip: string, now: number): Reserved {
    const own = MAILBOX_IP_CODE_LIMITS.map((l) => this.slot(l, now, `ip:${ip}:`));
    const ownFull = this.firstFull(own, now);
    if (ownFull) return { ok: false, reason: 'codes', retryAfterMs: ownFull.retryAfterMs };
    const shared = MAILBOX_CODE_LIMITS.map((l) => this.slot(l, now));
    const sharedFull = this.firstFull(shared, now);
    if (!sharedFull) return { ok: true, reservation: { keys: [...this.count(own), ...this.count(shared)] } };
    // The mailbox-wide allowance is used up: a requester new to this mailbox today may still get a code from a small
    // reserve, so whoever filled the allowance can't keep the owner out (it bounds mail per mailbox all the same).
    const isNew = own.find((s) => s.l.windowMs === DAY)!.count === 0;
    const reserve = this.slot(MAILBOX_RESERVE_LIMIT, now);
    if (isNew && reserve.count < reserve.l.max) return { ok: true, reservation: { keys: [...this.count(own), ...this.count([reserve])] } };
    return { ok: false, reason: 'codes', retryAfterMs: sharedFull.retryAfterMs };
  }

  /**
   * A new challenge for this mailbox, live until `expiresAtMs`: refused while the requester is locked out (its lock, the
   * ceiling, or the tripped backstop without the owner slot), at MAX_LIVE live challenges or at the day's challenge
   * cap; with `send`, its first code is reserved in the same step (refused when over). A refused admit stores nothing.
   * An admitted one records when this requester first started a challenge today (the owner slot's condition).
   */
  async admit(ip: string, expiresAtMs: number, send: boolean, now: number = Date.now()): Promise<Admitted> {
    const locked = this.lockedFor(ip, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const live = (this.kv().get<number[]>(LIVE_KEY) ?? []).filter((t) => t > now);
    if (live.length >= MAX_LIVE_CHALLENGES) return { ok: false, reason: 'live', retryAfterMs: Math.min(...live) - now };
    const created = this.slot(MAILBOX_CHALLENGES_PER_DAY, now);
    if (created.count >= created.l.max) return { ok: false, reason: 'challenges', retryAfterMs: created.start + DAY - now };
    let reservation: Reservation | null = null;
    if (send) {
      const r = this.trySend(ip, now);
      if (!r.ok) return r;
      reservation = r.reservation;
    }
    this.count([created]);
    this.kv().put(LIVE_KEY, [...live, expiresAtMs]);
    const startKey = `start:${ip}@${this.day(now)}`;
    if (this.kv().get(startKey) === undefined) this.kv().put(startKey, this.nextSeq(now));
    await this.sweepAt(now + DAY);
    return { ok: true, send: reservation };
  }

  /** A challenge ended early (its code was used, or its attempts ran out): its live slot is free again. */
  releaseLive(expiresAtMs: number, now: number = Date.now()): void {
    const live = (this.kv().get<number[]>(LIVE_KEY) ?? []).filter((t) => t > now);
    const i = live.indexOf(expiresAtMs);
    if (i >= 0) live.splice(i, 1);
    if (live.length) this.kv().put(LIVE_KEY, live);
    else this.kv().delete(LIVE_KEY);
  }

  /** One more code mail for a live challenge (resend; a prepared case-A challenge's first code). */
  async reserveSend(ip: string, now: number = Date.now()): Promise<Reserved> {
    const locked = this.lockedFor(ip, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const r = this.trySend(ip, now);
    if (r.ok) await this.sweepAt(now + DAY);
    return r;
  }

  /**
   * One code check, counted as wrong before the code is compared (and refunded when it was right). Every check counts
   * against the hard ceiling; it takes a backstop place while there is one, else an owner-slot place (only for an
   * owner-slot requester). The requester's 10th failure in an hour locks it out of this mailbox for an hour. Says when
   * this check tripped the backstop or reached the ceiling, so the worker can log the targeted mailbox.
   */
  async reserveGuess(ip: string, now: number = Date.now()): Promise<Guess> {
    const locked = this.lockedFor(ip, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const own = this.slot(MAILBOX_IP_WRONG_LIMIT, now, `ip:${ip}:`);
    const ownDay = this.slot(MAILBOX_IP_WRONG_DAY, now, `ip:${ip}:`);
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    const backstop = this.slot(MAILBOX_WRONG_BACKSTOP, now);
    // lockedFor let us through: a backstop place is free, or this is an owner-slot requester with the slot open.
    const place = backstop.count < backstop.l.max ? backstop : this.slot(MAILBOX_OWNER_SLOT, now);
    const keys = this.count([own, ownDay, ceiling, place]);
    if (own.count + 1 >= own.l.max) this.kv().put(ipLock(ip), now + MAILBOX_IP_LOCK_MS);
    let tripped: 'backstop' | 'ceiling' | undefined;
    if (place === backstop && backstop.count + 1 >= backstop.l.max) {
      const k = `trip@${this.day(now)}`;
      if (this.kv().get(k) === undefined) this.kv().put(k, this.nextSeq(now));
      tripped = 'backstop';
    }
    if (ceiling.count + 1 >= ceiling.l.max) tripped = 'ceiling';
    await this.sweepAt(now + DAY);
    return { ok: true, reservation: { keys }, ...(tripped ? { tripped } : {}) };
  }

  /** A right code (or no check made): its reservation is taken back, and the lock it may have set. */
  refundGuess(ip: string, r: Reservation, now: number = Date.now()): void {
    this.refund(r);
    const own = this.slot(MAILBOX_IP_WRONG_LIMIT, now, `ip:${ip}:`);
    if (own.count < own.l.max) this.kv().delete(ipLock(ip));
  }

  // ---- cleanup ----

  private async sweepAt(untilMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < untilMs) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes ended windows, locks and challenges; an object left with nothing holds no state at all. */
  override async alarm(): Promise<void> {
    const kv = this.kv();
    const now = Date.now();
    let next = 0;
    for (const [key, value] of kv.list<unknown>()) {
      if (key === LIVE_KEY) {
        const live = (value as number[]).filter((t) => t > now);
        if (live.length) {
          kv.put(key, live);
          next = Math.max(next, ...live);
        } else kv.delete(key);
      } else if (key.startsWith('lock:')) {
        if ((value as number) <= now) kv.delete(key);
        else next = Math.max(next, value as number);
      } else {
        // Every window used here is at most a day long.
        const start = Number(key.slice(key.lastIndexOf('@') + 1));
        if (!Number.isFinite(start) || start + DAY <= now) kv.delete(key);
        else next = Math.max(next, start + DAY);
      }
    }
    if (next > 0) await this.ctx.storage.setAlarm(next + 1);
    else await this.ctx.storage.deleteAll();
  }
}
