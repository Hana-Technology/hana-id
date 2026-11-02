// Exact limits, one object per subject: a mailbox (`mbx:` + HMAC under K_rl of the normalized address without its
// `+tag`), an IP subject or aggregate prefix, a recipient domain, an app, the env's global budget, a staff member.
// Keys never hold an address or a raw IP (requesters inside a mailbox object are sha256 prefixes of their IP subject).
//
// Every decision is one call, and every call's checks and writes run synchronously (SQLite-backed KV), before any await,
// so concurrent requests can't all pass a check before any is counted (D198):
// - `hit` / `peek` / `unhit` / `refund`: plain fixed windows;
// - `reserveBudget`: the global daily send budget, shared out per app with a reserve no single app can drain;
// - `admit`: a new challenge for this mailbox (locks, live challenges, the day's challenge cap, its first code);
// - `reserveSend`: one code mail, per (mailbox, requester), then mailbox-wide, then a small reserve for requesters new
//   to the mailbox that day. These bound mail; they don't keep the owner in: an attacker with many IPs can use them all
//   up. What keeps the owner in is the device ticket's own allowance and, after a staff unlock, a one-time grant that
//   only a start presenting the unlock's token can use (it then counts as ticketed);
// - `reserveGuess`: one code check, counted before the code is compared and refunded when it was right; inside a hard
//   ceiling of 25 failed checks per UTC day: a backstop of 18 open to anyone, then an owner slot of 4 (requesters that
//   started before the trip, no failures) and a ticket slot of 3 (challenges started with a device ticket);
// - `staffAction`: the per-mailbox cap on staff unlocks and unsuppressions (1 a day, 3 in 30 days);
// - `reserveDomain` (a `dom:` object): one code mail to a recipient domain, within its day and the requester prefixes'
//   shares of it.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import {
  BUDGET_APP_SHARE,
  BUDGET_LOG_AT,
  BUDGET_RESERVE,
  DOMAIN_PREFIX_SENDS_PER_DAY,
  DOMAIN_SENDS_PER_DAY,
  MAILBOX_CHALLENGES_PER_DAY,
  MAILBOX_CODE_LIMITS,
  MAILBOX_IP_CODE_LIMITS,
  MAILBOX_IP_LOCK_MS,
  MAILBOX_IP_WRONG_DAY,
  MAILBOX_IP_WRONG_LIMIT,
  MAILBOX_OWNER_SLOT,
  MAILBOX_RESERVE_LIMIT,
  MAILBOX_TICKET_SENDS,
  MAILBOX_TICKET_SLOT,
  MAILBOX_WRONG_BACKSTOP,
  MAILBOX_WRONG_CEILING,
  MAX_LIVE_CHALLENGES,
  STAFF_ACTIONS_PER_MAILBOX_30D,
  STAFF_ACTIONS_PER_MAILBOX_DAY,
  THIRTY_DAYS_MS,
  UNLOCK_GRANT_TTL_MS,
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
export type Admitted =
  /** `grant`: the unlock grant this start used (it then counts as ticketed); `unadmit` gives it back. */
  | { ok: true; send: Reservation | null; created: Reservation; grant: string | null }
  | { ok: false; reason: 'locked' | 'live' | 'codes' | 'challenges'; retryAfterMs: number };
export type Reserved = { ok: true; reservation: Reservation } | { ok: false; reason: 'locked' | 'codes'; retryAfterMs: number };
export type Guess = { ok: true; reservation: Reservation; tripped?: 'backstop' | 'ceiling' } | { ok: false; reason: 'locked'; retryAfterMs: number };
export type DomainReserved = { ok: true; reservation: Reservation; filled: boolean } | { ok: false; limit: 'domain' | 'prefix' };
export type Budget = { ok: true; reservation: Reservation; crossed: string[] } | { ok: false; limit: 'global' | 'app' | 'reserve' };

const DAY = 86_400_000;
const LIVE_KEY = 'live';
const ipLock = (ip: string) => `lock:${ip}`;
/** Staff action logs (timestamps of the last 30 days) per kind. */
const staffLog = (kind: string) => `staff-log:${kind}`;

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
    await this.sweepAt(now + DAY);
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

  // ---- the global send budget (the `global` object) ----

  /**
   * One user mail for `appId` against the day's budget (H1): refused at the budget, past the app's share
   * (`BUDGET_APP_SHARE` of it), and in the last `BUDGET_RESERVE` for an app that has used half its share or more.
   * Returns the thresholds this mail reached (`global_50`, `global_80`, `app_50`, `app_80`) for the `email_budget` log.
   */
  async reserveBudget(appId: string, budget: number, now: number = Date.now()): Promise<Budget> {
    const day = Math.floor(now / DAY) * DAY;
    const gKey = `budget@${day}`;
    const aKey = `budget:${appId}@${day}`;
    const g = this.kv().get<number>(gKey) ?? 0;
    const a = this.kv().get<number>(aKey) ?? 0;
    const share = Math.max(1, Math.floor(budget * BUDGET_APP_SHARE));
    const general = Math.floor(budget * (1 - BUDGET_RESERVE));
    if (g >= budget) return { ok: false, limit: 'global' };
    if (a >= share) return { ok: false, limit: 'app' };
    if (g >= general && a >= Math.max(1, Math.floor(share / 2))) return { ok: false, limit: 'reserve' };
    this.kv().put(gKey, g + 1);
    this.kv().put(aKey, a + 1);
    const crossed: string[] = [];
    for (const f of BUDGET_LOG_AT) {
      const pct = Math.round(f * 100);
      if (g + 1 === Math.ceil(budget * f)) crossed.push(`global_${pct}`);
      if (a + 1 === Math.ceil(share * f)) crossed.push(`app_${pct}`);
    }
    await this.sweepAt(now + DAY);
    return { ok: true, reservation: { keys: [gKey, aKey] }, crossed };
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

  /** Whether this requester may use the owner slot: it started here before the trip and has no failure today. */
  private ownerExempt(ip: string, now: number): boolean {
    const d = this.day(now);
    const trippedAt = this.kv().get<number>(`trip@${d}`);
    const startedAt = this.kv().get<number>(`start:${ip}@${d}`);
    return trippedAt !== undefined && startedAt !== undefined && startedAt < trippedAt && this.slot(MAILBOX_IP_WRONG_DAY, now, `ip:${ip}:`).count === 0;
  }

  /**
   * The slot a check by this requester would take now (null: none, it is refused): the backstop while it lasts; then
   * the ticket slot for a ticketed challenge, or the owner slot for an owner-slot requester. Never past the ceiling or
   * during the requester's own lock.
   */
  private guessSlot(ip: string, ticketed: boolean, now: number): Slot | null {
    if ((this.kv().get<number>(ipLock(ip)) ?? 0) > now) return null;
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    if (ceiling.count >= ceiling.l.max) return null;
    const backstop = this.slot(MAILBOX_WRONG_BACKSTOP, now);
    if (backstop.count < backstop.l.max) return backstop;
    if (ticketed) {
      const t = this.slot(MAILBOX_TICKET_SLOT, now);
      if (t.count < t.l.max) return t;
    }
    if (this.ownerExempt(ip, now)) {
      const o = this.slot(MAILBOX_OWNER_SLOT, now);
      if (o.count < o.l.max) return o;
    }
    return null;
  }

  /** ms until this requester may act on this mailbox again (0: now): its own lock, or the end of the UTC day. */
  private lockedFor(ip: string, ticketed: boolean, now: number): number {
    if (this.guessSlot(ip, ticketed, now)) return 0;
    const until = this.kv().get<number>(ipLock(ip)) ?? 0;
    return until > now ? until - now : this.day(now) + DAY - now;
  }

  /** One code mail: the ticket allowance for a ticketed challenge (an unlock-grant start's included); else the code limits. */
  private trySend(ip: string, ticketed: boolean, now: number): Reserved {
    if (ticketed) {
      const t = this.slot(MAILBOX_TICKET_SENDS, now);
      if (t.count >= t.l.max) return { ok: false, reason: 'codes', retryAfterMs: t.start + DAY - now };
      return { ok: true, reservation: { keys: this.count([t]) } };
    }
    const own = MAILBOX_IP_CODE_LIMITS.map((l) => this.slot(l, now, `ip:${ip}:`));
    const shared = MAILBOX_CODE_LIMITS.map((l) => this.slot(l, now));
    const ownFull = this.firstFull(own, now);
    const sharedFull = this.firstFull(shared, now);
    if (!ownFull && !sharedFull) return { ok: true, reservation: { keys: [...this.count(own), ...this.count(shared)] } };
    if (!ownFull) {
      // A requester new to this mailbox today may still get a code from a small reserve.
      const isNew = own.find((s) => s.l.windowMs === DAY)!.count === 0;
      const reserve = this.slot(MAILBOX_RESERVE_LIMIT, now);
      if (isNew && reserve.count < reserve.l.max) return { ok: true, reservation: { keys: [...this.count(own), ...this.count([reserve])] } };
    }
    return { ok: false, reason: 'codes', retryAfterMs: (ownFull ?? sharedFull)!.retryAfterMs };
  }

  /**
   * A new challenge for this mailbox, live until `expiresAtMs`: refused while the requester can't check (its lock, the
   * ceiling, or the tripped backstop without a slot of its own), at MAX_LIVE live challenges or at the day's challenge
   * cap (a ticketed start passes those two); with `send`, its first code is reserved in the same step. `grantHash`
   * (sha256 of a staff unlock's token, from the start's `unlockToken`): when it names this mailbox's unused grant, the
   * start counts as ticketed and uses the grant up. A refused admit stores nothing. An admitted one records when this
   * requester first started here today.
   */
  async admit(ip: string, expiresAtMs: number, send: boolean, now: number = Date.now(), ticketed = false, grantHash: string | null = null): Promise<Admitted> {
    const grant = !ticketed && grantHash ? this.unusedGrant(grantHash, now) : null;
    const asTicketed = ticketed || grant !== null;
    const locked = this.lockedFor(ip, asTicketed, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const live = (this.kv().get<number[]>(LIVE_KEY) ?? []).filter((t) => t > now);
    const created = this.slot(MAILBOX_CHALLENGES_PER_DAY, now);
    const capped = live.length >= MAX_LIVE_CHALLENGES ? 'live' : created.count >= created.l.max ? 'challenges' : null;
    if (capped && !asTicketed) return { ok: false, reason: capped, retryAfterMs: capped === 'live' ? Math.min(...live) - now : created.start + DAY - now };
    let reservation: Reservation | null = null;
    if (send) {
      const r = this.trySend(ip, asTicketed, now);
      if (!r.ok) return r;
      reservation = r.reservation;
    }
    if (grant) this.kv().put(grant, 0);
    const createdKeys = this.count([created]);
    this.kv().put(LIVE_KEY, [...live, expiresAtMs]);
    const startKey = `start:${ip}@${this.day(now)}`;
    if (this.kv().get(startKey) === undefined) this.kv().put(startKey, this.nextSeq(now));
    await this.sweepAt(now + DAY);
    return { ok: true, send: reservation, created: { keys: createdKeys }, grant };
  }

  /** The key of this mailbox's unused unlock grant whose token hashes to `hash`, issued within the last 24 h, or null. */
  private unusedGrant(hash: string, now: number): string | null {
    for (const [key, left] of this.kv().list<number>({ prefix: `ugrant:${hash}@` })) {
      const issued = Number(key.slice(key.lastIndexOf('@') + 1));
      if (left > 0 && issued + UNLOCK_GRANT_TTL_MS > now) return key;
    }
    return null;
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
  async reserveSend(ip: string, now: number = Date.now(), ticketed = false): Promise<Reserved> {
    const locked = this.lockedFor(ip, ticketed, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const r = this.trySend(ip, ticketed, now);
    if (r.ok) await this.sweepAt(now + DAY);
    return r;
  }

  /**
   * One code check, counted as failed before the code is compared (and refunded when it was right), in the slot
   * `guessSlot` picks, and against the ceiling. The requester's 10th failure in an hour locks it out of this mailbox for
   * an hour. Says when this check tripped the backstop or reached the ceiling, so the worker can log the mailbox.
   */
  async reserveGuess(ip: string, now: number = Date.now(), ticketed = false): Promise<Guess> {
    const place = this.guessSlot(ip, ticketed, now);
    if (!place) return { ok: false, reason: 'locked', retryAfterMs: this.lockedFor(ip, ticketed, now) };
    const own = this.slot(MAILBOX_IP_WRONG_LIMIT, now, `ip:${ip}:`);
    const ownDay = this.slot(MAILBOX_IP_WRONG_DAY, now, `ip:${ip}:`);
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    const keys = this.count([own, ownDay, ceiling, place]);
    if (own.count + 1 >= own.l.max) this.kv().put(ipLock(ip), now + MAILBOX_IP_LOCK_MS);
    let tripped: 'backstop' | 'ceiling' | undefined;
    if (place.l.name === MAILBOX_WRONG_BACKSTOP.name && place.count + 1 >= place.l.max) {
      const k = `trip@${this.day(now)}`;
      if (this.kv().get(k) === undefined) this.kv().put(k, this.nextSeq(now));
      tripped = 'backstop';
    }
    if (ceiling.count + 1 >= ceiling.l.max) tripped = 'ceiling';
    await this.sweepAt(now + DAY);
    return { ok: true, reservation: { keys }, ...(tripped ? { tripped } : {}) };
  }

  /**
   * A right code (or no check made): its reservation is taken back, with the lock it may have set and, when the
   * backstop is below its max again, the trip marker (a check that turned out right never trips the backstop).
   */
  refundGuess(ip: string, r: Reservation, now: number = Date.now()): void {
    this.refund(r);
    const own = this.slot(MAILBOX_IP_WRONG_LIMIT, now, `ip:${ip}:`);
    if (own.count < own.l.max) this.kv().delete(ipLock(ip));
    const backstop = this.slot(MAILBOX_WRONG_BACKSTOP, now);
    if (backstop.count < backstop.l.max) this.kv().delete(`trip@${this.day(now)}`);
  }

  /**
   * A challenge that admit counted but that was never created, or whose first code was never delivered: its place in
   * the day's challenge cap (and, when it doesn't exist, its live slot) is taken back.
   */
  unadmit(created: Reservation, expiresAtMs: number | null, now: number = Date.now(), grant: string | null = null): void {
    this.refund(created);
    if (expiresAtMs !== null) this.releaseLive(expiresAtMs, now);
    // The unlock grant it used is the owner's again (only while the grant itself lasts: the alarm drops it after 24 h).
    if (grant && this.kv().get<number>(grant) === 0) this.kv().put(grant, 1);
  }

  // ---- a recipient domain (the `dom:` object) ----

  /**
   * One code mail to this domain: refused at the domain's day (`domain`) or when one of the requester's prefixes has
   * used its 20% share of it (`prefix`). `prefixes` are hashes, never raw addresses. `filled`: this mail reached the
   * domain's cap (the worker logs `email_domain_cap`).
   */
  async reserveDomain(prefixes: string[], now: number = Date.now()): Promise<DomainReserved> {
    const total = this.slot(DOMAIN_SENDS_PER_DAY, now);
    if (total.count >= total.l.max) return { ok: false, limit: 'domain' };
    const own = prefixes.map((p) => this.slot(DOMAIN_PREFIX_SENDS_PER_DAY, now, `p:${p}:`));
    if (this.firstFull(own, now)) return { ok: false, limit: 'prefix' };
    const keys = this.count([total, ...own]);
    await this.sweepAt(now + DAY);
    return { ok: true, reservation: { keys }, filled: total.count + 1 >= total.l.max };
  }

  // ---- staff ----

  /** The per-mailbox staff cap (M2): at most 1 action of `kind` per UTC day and 3 in any 30 days; counted when allowed. */
  async staffAction(kind: 'unlock' | 'unsuppress', now: number = Date.now()): Promise<boolean> {
    const log = (this.kv().get<number[]>(staffLog(kind)) ?? []).filter((t) => t > now - THIRTY_DAYS_MS);
    const today = log.filter((t) => t >= this.day(now)).length;
    if (today >= STAFF_ACTIONS_PER_MAILBOX_DAY || log.length >= STAFF_ACTIONS_PER_MAILBOX_30D) return false;
    this.kv().put(staffLog(kind), [...log, now]);
    await this.sweepAt(now + DAY);
    return true;
  }

  /**
   * Staff unlock (`admin/unlock`, D198): clears this UTC day's guess counters, the trip marker, the ceiling and every
   * requester's lock, and stores a one-time grant under `grantHash` (sha256 of the token staff pass to the owner): one
   * start presenting the token, within 24 h, counts as ticketed (past the live and challenge caps, the ticket's code
   * allowance and guess slot), so an owner whose mailbox was drained can sign in again and an attacker can't use it.
   * Returns how many entries were cleared.
   */
  async staffUnlock(now: number = Date.now(), grantHash: string): Promise<number> {
    const kv = this.kv();
    const d = this.day(now);
    let cleared = 0;
    for (const [key] of kv.list<unknown>()) {
      const guessWindow = /^(?:ip:[0-9a-f]+:)?wrong:/u.test(key);
      if (key.startsWith('lock:') || key === `trip@${d}` || guessWindow) {
        kv.delete(key);
        cleared++;
      }
    }
    kv.put(`ugrant:${grantHash}@${now}`, 1);
    await this.sweepAt(now + DAY);
    return cleared;
  }

  // ---- cleanup ----

  private async sweepAt(untilMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < untilMs) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes ended windows, locks, challenges and staff logs; an object left with nothing holds no state at all. */
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
      } else if (key.startsWith('staff-log:')) {
        const log = (value as number[]).filter((t) => t > now - THIRTY_DAYS_MS);
        if (log.length) {
          kv.put(key, log);
          next = Math.max(next, Math.min(...log) + THIRTY_DAYS_MS);
        } else kv.delete(key);
      } else if (key.startsWith('lock:')) {
        if ((value as number) <= now) kv.delete(key);
        else next = Math.max(next, value as number);
      } else {
        // Every other entry is keyed `…@<window start>` with a window of at most a day.
        const start = Number(key.slice(key.lastIndexOf('@') + 1));
        if (!Number.isFinite(start) || start + DAY <= now) kv.delete(key);
        else next = Math.max(next, start + DAY);
      }
    }
    if (next > 0) await this.ctx.storage.setAlarm(next + 1);
    else await this.ctx.storage.deleteAll();
  }
}
