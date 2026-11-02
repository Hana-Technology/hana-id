// Exact limits, one object per subject: a mailbox (`mbx:` + HMAC under K_rl of the normalized address without its
// `+tag`), an IP subject or aggregate prefix, a recipient domain, an app, the env's global budget, a staff member.
// Keys never hold an address or a raw IP (requesters inside a mailbox object are sha256 prefixes of their IP subject).
//
// Every decision is one call, and every call's checks and writes run synchronously (SQLite-backed KV), before any await,
// so concurrent requests can't all pass a check before any is counted (D198):
// - `hit` / `peek` / `unhit` / `refund`: plain fixed windows;
// - `reserveBudget`: the global daily send budget: an owner pool for ticketed and unlock-grant mail, and a general pool
//   shared out per app (from its plan) with a reserve no single app can drain;
// - `admit`: a new challenge for this mailbox (locks, live challenges, the day's challenge cap, its first code);
// - `reserveSend`: one code mail, per (mailbox, requester), then mailbox-wide, then a small reserve for requesters new
//   to the mailbox that day. These bound mail; they don't keep the owner in: an attacker with many IPs can use them all
//   up. What keeps the owner in: a valid device ticket or unlock grant never waits on an app's, a domain's or the
//   general pool (its own per-address allowance, the owner pool, which fresh tickets fill only to half), and an
//   unlock grant only the mailed token can use;
// - `reserveGuess`: one code check, counted before the code is compared and refunded when it was right; inside a hard
//   ceiling of 25 failed checks per UTC day: a backstop of 18 open to anyone, then an owner slot of 4 (requesters that
//   started before the trip, no failures) and a ticket slot of 3 (challenges a ticket or a grant started); past the
//   ceiling, a grant's own 2 checks;
// - `staffAction`: the per-mailbox cap on staff actions (1 a day, 3 in 30 days per kind); `issueGrant`, `revokeTickets`;
// - `reserveDomain` / `domainVerified` (a `dom:` object): one code mail to a recipient domain, within its day (which
//   grows with its verified logins) and the requester prefixes' shares of it; a verified challenge's mails come back.
import { DurableObject } from 'cloudflare:workers';
import type { Env } from './env.ts';
import {
  BUDGET_LOG_AT,
  BUDGET_OWNER_AGED_FROM,
  BUDGET_RESERVE,
  DOMAIN_PREFIX_SHARE,
  DOMAIN_PREFIX_WINDOW,
  DOMAIN_SENDS_BASE,
  DOMAIN_SENDS_MAX,
  DOMAIN_SENDS_PER_VERIFIED,
  DOMAIN_SENDS_WINDOW,
  DOMAIN_VERIFIED_DAYS,
  ADDRESS_OWNER_CHALLENGES,
  MAILBOX_CHALLENGES_PER_DAY,
  MAILBOX_CODE_LIMITS,
  MAILBOX_GRANT_SLOT,
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
  MAX_LIVE_TICKETS,
  STAFF_ACTIONS_PER_MAILBOX_30D,
  STAFF_ACTIONS_PER_MAILBOX_DAY,
  THIRTY_DAYS_MS,
  UNLOCK_GRANT_TTL_MS,
  generalPool,
  ownerPool,
  staffPool,
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

/**
 * The owner's proof a start presented: a device ticket the worker checked (its MAC, for this exact address) or the hash
 * of a mailed unlock token. Checked here too: a ticket against the address's revocation, a grant against the stored one.
 */
export type OwnerClaim = { kind: 'ticket'; id: string; addrKey: string; issuedAtMs: number } | { kind: 'grant'; hash: string };
/** What a challenge keeps of it: the ticket (allowances are per ticket) or the grant it used up. */
export type OwnerRef = { kind: 'ticket'; id: string; addrKey: string; issuedAtMs: number } | { kind: 'grant'; key: string };

export type Admitted =
  /** `owner`: the valid ticket or the grant this start used (a grant is given back by `unadmit`). */
  | { ok: true; send: Reservation | null; created: Reservation; owner: OwnerRef | null }
  | { ok: false; reason: 'locked' | 'live' | 'codes' | 'challenges'; retryAfterMs: number };
/** `owner`: what the challenge's owner proof counts as now (a ticket revoked since: null), for the domain and budget steps. */
export type Reserved = { ok: true; reservation: Reservation; owner: 'ticket' | 'grant' | null } | { ok: false; reason: 'locked' | 'codes'; retryAfterMs: number };
export type Guess = { ok: true; reservation: Reservation; tripped?: 'backstop' | 'ceiling' } | { ok: false; reason: 'locked'; retryAfterMs: number };
export type DomainReserved = { ok: true; reservation: Reservation; filled: boolean; cap: number } | { ok: false; limit: 'domain' | 'prefix' };
export type Budget = { ok: true; reservation: Reservation; crossed: string[] } | { ok: false; limit: 'global' | 'app' | 'reserve' | 'owner' | 'staff' };
/**
 * Which pool a mail may draw on: a user's (the general pool); an owner's (the owner pool, a fresh ticket's only below
 * half of it, then the general pool like a user's; `owner_aged`: a ticket ≥ 7 days old or an unlock grant); staff's.
 */
export type BudgetKind = 'user' | 'owner' | 'owner_aged' | 'staff';
/** A live ticket of an exact address, as the mailbox object registers it at issue. */
interface TicketEntry {
  id: string;
  issuedAtMs: number;
}

const DAY = 86_400_000;
const LIVE_KEY = 'live';
const ipLock = (ip: string) => `lock:${ip}`;
/** Staff action logs (timestamps of the last 30 days) per kind. */
const staffLog = (kind: string) => `staff-log:${kind}`;
/** The live tickets of an exact address (≤ MAX_LIVE_TICKETS, oldest first); a ticket not listed is revoked. */
const ticketsKey = (addrKey: string) => `tickets:${addrKey}`;
/** A recipient domain's verified logins per UTC day (kept for the trailing window). */
const verifiedKey = (day: number) => `verified@${day}`;

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
   * One mail against the day's pools (H1, abuse review H1, final check M1): staff mail from the staff pool; an owner's
   * from the owner pool (beside the budget, no per-app cap), a fresh ticket's only while the pool is below half, after
   * which it is a user's; a user's from the general pool, refused past it, past the app's `share`, and in its last
   * `BUDGET_RESERVE` for an app that has used half its share or more. Returns the thresholds this mail reached
   * (`global_50`, `global_80`, `app_50`, `app_80`, `owner_50`, `owner_80`) for the `email_budget` and
   * `email_owner_pool` logs.
   */
  async reserveBudget(appId: string | null, budget: number, share: number, kind: BudgetKind, now: number = Date.now()): Promise<Budget> {
    if (!(budget > 0)) return { ok: false, limit: 'global' };
    const day = Math.floor(now / DAY) * DAY;
    const crossed: string[] = [];
    const reached = (count: number, of: number, name: string) => {
      for (const f of BUDGET_LOG_AT) if (count === Math.ceil(of * f)) crossed.push(`${name}_${Math.round(f * 100)}`);
    };
    const take = async (keys: string[]): Promise<Budget> => {
      for (const k of keys) this.kv().put(k, (this.kv().get<number>(k) ?? 0) + 1);
      await this.sweepAt(now + DAY);
      return { ok: true, reservation: { keys }, crossed };
    };
    if (kind === 'staff') {
      const sKey = `budget-staff@${day}`;
      const n = this.kv().get<number>(sKey) ?? 0;
      if (n >= staffPool(budget)) return { ok: false, limit: 'staff' };
      return take([sKey]);
    }
    if (kind === 'owner' || kind === 'owner_aged') {
      const pool = ownerPool(budget);
      const oKey = `budget-owner@${day}`;
      const o = this.kv().get<number>(oKey) ?? 0;
      const open = o < pool && (kind === 'owner_aged' || o < Math.floor(pool * BUDGET_OWNER_AGED_FROM));
      if (open) {
        reached(o + 1, pool, 'owner');
        return take([oKey]);
      }
      if (kind === 'owner_aged') return { ok: false, limit: 'owner' };
      // A fresh ticket past half the owner pool: an ordinary user's mail from here.
    }
    const general = generalPool(budget);
    const gKey = `budget@${day}`;
    const aKey = `budget:${appId ?? '-'}@${day}`;
    const g = this.kv().get<number>(gKey) ?? 0;
    const a = this.kv().get<number>(aKey) ?? 0;
    const reserveFrom = Math.floor(general * (1 - BUDGET_RESERVE));
    if (g >= general) return { ok: false, limit: 'global' };
    if (a >= share) return { ok: false, limit: 'app' };
    if (g >= reserveFrom && a >= Math.max(1, Math.floor(share / 2))) return { ok: false, limit: 'reserve' };
    reached(g + 1, general, 'global');
    reached(a + 1, share, 'app');
    return take([gKey, aKey]);
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

  /** A ticket is valid while its address's registry lists it (not revoked, not pushed out by newer ones). */
  private ticketLive(addrKey: string, id: string): boolean {
    return (this.kv().get<TicketEntry[]>(ticketsKey(addrKey)) ?? []).some((t) => t.id === id);
  }

  /**
   * Registers a ticket `verify` just issued for this exact address: at most MAX_LIVE_TICKETS stay live, a newer one
   * revoking the oldest (scan of the re-check: re-verifying can't pile up tickets).
   */
  async registerTicket(addrKey: string, id: string, issuedAtMs: number, now: number = Date.now()): Promise<void> {
    const live = (this.kv().get<TicketEntry[]>(ticketsKey(addrKey)) ?? []).filter((t) => t.issuedAtMs + THIRTY_DAYS_MS > now);
    live.push({ id, issuedAtMs });
    this.kv().put(ticketsKey(addrKey), live.slice(-MAX_LIVE_TICKETS));
    await this.sweepAt(now + DAY);
  }

  /** The key of this mailbox's unused unlock grant whose token hashes to `hash`, issued within the last 24 h, or null. */
  private unusedGrant(hash: string, now: number): string | null {
    for (const [key, left] of this.kv().list<number>({ prefix: `ugrant:${hash}@` })) {
      const issued = Number(key.slice(key.lastIndexOf('@') + 1));
      if (left > 0 && issued + UNLOCK_GRANT_TTL_MS > now) return key;
    }
    return null;
  }

  /** The claim, checked: the ticket (not revoked) or the unused grant; null when it doesn't hold. */
  private ownerOf(claim: OwnerClaim | null, now: number): OwnerRef | null {
    if (!claim) return null;
    if (claim.kind === 'ticket') return this.ticketLive(claim.addrKey, claim.id) ? claim : null;
    const key = this.unusedGrant(claim.hash, now);
    return key ? { kind: 'grant', key } : null;
  }

  /** What a live challenge's owner proof still counts as: a ticket revoked since counts as nothing. */
  private ownerKind(ref: OwnerRef | null): 'ticket' | 'grant' | null {
    if (!ref) return null;
    if (ref.kind === 'ticket') return this.ticketLive(ref.addrKey, ref.id) ? 'ticket' : null;
    return 'grant';
  }

  /** Whether a start's claim holds (abuse review M2: a valid one skips the aggregate prefix limits). Counts nothing. */
  checkOwner(claim: OwnerClaim, now: number = Date.now()): boolean {
    return this.ownerOf(claim, now) !== null;
  }

  /**
   * The slot a check by this requester would take now (null: none, it is refused): the backstop while it lasts; then
   * the ticket slot for a ticket's or a grant's challenge, or the owner slot for an owner-slot requester; never past
   * the ceiling, except a grant's own 2 checks. Never during the requester's own lock.
   */
  private guessSlot(ip: string, kind: 'ticket' | 'grant' | null, now: number): Slot | null {
    if ((this.kv().get<number>(ipLock(ip)) ?? 0) > now) return null;
    const grantSlot = () => {
      if (kind !== 'grant') return null;
      const g = this.slot(MAILBOX_GRANT_SLOT, now);
      return g.count < g.l.max ? g : null;
    };
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    if (ceiling.count >= ceiling.l.max) return grantSlot();
    const backstop = this.slot(MAILBOX_WRONG_BACKSTOP, now);
    if (backstop.count < backstop.l.max) return backstop;
    if (kind) {
      const t = this.slot(MAILBOX_TICKET_SLOT, now);
      if (t.count < t.l.max) return t;
    }
    const g = grantSlot();
    if (g) return g;
    if (this.ownerExempt(ip, now)) {
      const o = this.slot(MAILBOX_OWNER_SLOT, now);
      if (o.count < o.l.max) return o;
    }
    return null;
  }

  /** ms until this requester may act on this mailbox again (0: now): its own lock, or the end of the UTC day. */
  private lockedFor(ip: string, kind: 'ticket' | 'grant' | null, now: number): number {
    if (this.guessSlot(ip, kind, now)) return 0;
    const until = this.kv().get<number>(ipLock(ip)) ?? 0;
    return until > now ? until - now : this.day(now) + DAY - now;
  }

  /**
   * One code mail: a ticket's challenge from that ticket's own allowance; a grant's challenge free (its challenge is
   * one, with at most 2 resends); any other within the code limits, then the reserve for requesters new today.
   */
  private trySend(ip: string, ref: OwnerRef | null, now: number): Reserved {
    const kind = this.ownerKind(ref);
    if (kind === 'grant') return { ok: true, reservation: { keys: [] }, owner: 'grant' };
    if (kind === 'ticket' && ref?.kind === 'ticket') {
      // Per exact address, all its tickets together (scan of the re-check).
      const t = this.slot(MAILBOX_TICKET_SENDS, now, `a:${ref.addrKey}:`);
      if (t.count >= t.l.max) return { ok: false, reason: 'codes', retryAfterMs: t.start + DAY - now };
      return { ok: true, reservation: { keys: this.count([t]) }, owner: 'ticket' };
    }
    const own = MAILBOX_IP_CODE_LIMITS.map((l) => this.slot(l, now, `ip:${ip}:`));
    const shared = MAILBOX_CODE_LIMITS.map((l) => this.slot(l, now));
    const ownFull = this.firstFull(own, now);
    const sharedFull = this.firstFull(shared, now);
    if (!ownFull && !sharedFull) return { ok: true, reservation: { keys: [...this.count(own), ...this.count(shared)] }, owner: null };
    if (!ownFull) {
      // A requester new to this mailbox today may still get a code from a small reserve.
      const isNew = own.find((s) => s.l.windowMs === DAY)!.count === 0;
      const reserve = this.slot(MAILBOX_RESERVE_LIMIT, now);
      if (isNew && reserve.count < reserve.l.max) return { ok: true, reservation: { keys: [...this.count(own), ...this.count([reserve])] }, owner: null };
    }
    return { ok: false, reason: 'codes', retryAfterMs: (ownFull ?? sharedFull)!.retryAfterMs };
  }

  /**
   * A new challenge for this mailbox, live until `expiresAtMs`: refused while the requester can't check (its lock, the
   * ceiling, or the tripped backstop without a slot of its own), at MAX_LIVE live challenges or at the day's challenge
   * cap (a valid ticket or grant passes those two); with `send`, its first code is reserved in the same step. `claim`:
   * a ticket (checked against revocation) or a grant (used up here; `unadmit` gives it back). A refused admit stores
   * nothing. An admitted one records when this requester first started here today.
   */
  async admit(ip: string, expiresAtMs: number, send: boolean, now: number = Date.now(), claim: OwnerClaim | null = null): Promise<Admitted> {
    let owner = this.ownerOf(claim, now);
    // At most ADDRESS_OWNER_CHALLENGES ticket starts per exact address a day; past it a ticket counts as nothing (a
    // grant, one per unlock, always passes).
    const ownerDay = owner?.kind === 'ticket' ? this.slot(ADDRESS_OWNER_CHALLENGES, now, `a:${owner.addrKey}:`) : null;
    if (ownerDay && ownerDay.count >= ownerDay.l.max) owner = null;
    const locked = this.lockedFor(ip, owner?.kind ?? null, now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const live = (this.kv().get<number[]>(LIVE_KEY) ?? []).filter((t) => t > now);
    const created = this.slot(MAILBOX_CHALLENGES_PER_DAY, now);
    const capped = live.length >= MAX_LIVE_CHALLENGES ? 'live' : created.count >= created.l.max ? 'challenges' : null;
    if (capped && !owner) return { ok: false, reason: capped, retryAfterMs: capped === 'live' ? Math.min(...live) - now : created.start + DAY - now };
    let reservation: Reservation | null = null;
    if (send) {
      const r = this.trySend(ip, owner, now);
      if (!r.ok) return r;
      reservation = r.reservation;
    }
    if (owner?.kind === 'grant') this.kv().put(owner.key, 0);
    const createdKeys = this.count(owner && ownerDay ? [created, ownerDay] : [created]);
    this.kv().put(LIVE_KEY, [...live, expiresAtMs]);
    const startKey = `start:${ip}@${this.day(now)}`;
    if (this.kv().get(startKey) === undefined) this.kv().put(startKey, this.nextSeq(now));
    await this.sweepAt(now + DAY);
    return { ok: true, send: reservation, created: { keys: createdKeys }, owner };
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
  async reserveSend(ip: string, now: number = Date.now(), owner: OwnerRef | null = null): Promise<Reserved> {
    const locked = this.lockedFor(ip, this.ownerKind(owner), now);
    if (locked > 0) return { ok: false, reason: 'locked', retryAfterMs: locked };
    const r = this.trySend(ip, owner, now);
    if (r.ok) await this.sweepAt(now + DAY);
    return r;
  }

  /**
   * One code check, counted as failed before the code is compared (and refunded when it was right), in the slot
   * `guessSlot` picks, and against the ceiling (a grant's own slot lies outside it). The requester's 10th failure in
   * an hour locks it out of this mailbox for an hour. Says when this check tripped the backstop or reached the ceiling,
   * so the worker can log the mailbox.
   */
  async reserveGuess(ip: string, now: number = Date.now(), owner: OwnerRef | null = null): Promise<Guess> {
    const kind = this.ownerKind(owner);
    const place = this.guessSlot(ip, kind, now);
    if (!place) return { ok: false, reason: 'locked', retryAfterMs: this.lockedFor(ip, kind, now) };
    const own = this.slot(MAILBOX_IP_WRONG_LIMIT, now, `ip:${ip}:`);
    const ownDay = this.slot(MAILBOX_IP_WRONG_DAY, now, `ip:${ip}:`);
    const ceiling = this.slot(MAILBOX_WRONG_CEILING, now);
    const inCeiling = place.l.name !== MAILBOX_GRANT_SLOT.name;
    const keys = this.count(inCeiling ? [own, ownDay, ceiling, place] : [own, ownDay, place]);
    if (own.count + 1 >= own.l.max) this.kv().put(ipLock(ip), now + MAILBOX_IP_LOCK_MS);
    let tripped: 'backstop' | 'ceiling' | undefined;
    if (place.l.name === MAILBOX_WRONG_BACKSTOP.name && place.count + 1 >= place.l.max) {
      const k = `trip@${this.day(now)}`;
      if (this.kv().get(k) === undefined) this.kv().put(k, this.nextSeq(now));
      tripped = 'backstop';
    }
    if (inCeiling && ceiling.count + 1 >= ceiling.l.max) tripped = 'ceiling';
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
   * the day's challenge cap (and, when it doesn't exist, its live slot) is taken back, and the grant it used is the
   * owner's again (while the grant itself lasts: the alarm drops it after 24 h).
   */
  unadmit(created: Reservation, expiresAtMs: number | null, now: number = Date.now(), owner: OwnerRef | null = null): void {
    this.refund(created);
    if (expiresAtMs !== null) this.releaseLive(expiresAtMs, now);
    if (owner?.kind === 'grant' && this.kv().get<number>(owner.key) === 0) this.kv().put(owner.key, 1);
  }

  // ---- staff ----

  /** The per-mailbox staff cap (M2): at most 1 action of `kind` per UTC day and 3 in any 30 days; counted when allowed. */
  async staffAction(kind: 'unlock' | 'unsuppress' | 'revoke', now: number = Date.now()): Promise<boolean> {
    const log = (this.kv().get<number[]>(staffLog(kind)) ?? []).filter((t) => t > now - THIRTY_DAYS_MS);
    const today = log.filter((t) => t >= this.day(now)).length;
    if (today >= STAFF_ACTIONS_PER_MAILBOX_DAY || log.length >= STAFF_ACTIONS_PER_MAILBOX_30D) return false;
    this.kv().put(staffLog(kind), [...log, now]);
    await this.sweepAt(now + DAY);
    return true;
  }

  /**
   * Staff unlock (`admin/unlock`, D198, abuse review M3): stores a one-time grant under `grantHash` (sha256 of the token
   * the worker mails to the address). One start presenting the token, within 24 h, counts as an owner's: past the live
   * and challenge caps, its mail free and in the owner pool, its checks in the ticket slot and then the grant's own 2.
   * Clears nothing: the shared guess counters stay, so an unlock gives an attacker nothing.
   */
  async issueGrant(grantHash: string, now: number = Date.now()): Promise<void> {
    this.kv().put(`ugrant:${grantHash}@${now}`, 1);
    await this.sweepAt(now + UNLOCK_GRANT_TTL_MS);
  }

  /** Staff revocation (`admin/revoke-tickets`): every live device ticket of this exact address. */
  async revokeTickets(addrKey: string, now: number = Date.now()): Promise<void> {
    this.kv().delete(ticketsKey(addrKey));
    await this.sweepAt(now + DAY);
  }

  // ---- a recipient domain (the `dom:` object) ----

  /** The domain's cap today: the base plus 2 per verified login over the trailing 7 UTC days (today included). */
  private domainCap(now: number): number {
    const d = this.day(now);
    let verified = 0;
    for (let i = 0; i < DOMAIN_VERIFIED_DAYS; i++) verified += this.kv().get<number>(verifiedKey(d - i * DAY)) ?? 0;
    return Math.min(DOMAIN_SENDS_MAX, DOMAIN_SENDS_BASE + DOMAIN_SENDS_PER_VERIFIED * verified);
  }

  /**
   * One code mail to this domain: refused at the domain's cap for today (`domain`) or when one of the requester's
   * prefixes has used its 20% share of it (`prefix`). `prefixes` are hashes, never raw addresses. `filled`: this mail
   * reached the cap (the worker logs `email_domain_cap`).
   */
  async reserveDomain(prefixes: string[], now: number = Date.now()): Promise<DomainReserved> {
    const cap = this.domainCap(now);
    const total = this.slot({ ...DOMAIN_SENDS_WINDOW, max: cap }, now);
    if (total.count >= total.l.max) return { ok: false, limit: 'domain' };
    const share = { ...DOMAIN_PREFIX_WINDOW, max: Math.max(1, Math.floor(cap * DOMAIN_PREFIX_SHARE)) };
    const own = prefixes.map((p) => this.slot(share, now, `p:${p}:`));
    if (this.firstFull(own, now)) return { ok: false, limit: 'prefix' };
    const keys = this.count([total, ...own]);
    await this.sweepAt(now + DAY);
    return { ok: true, reservation: { keys }, filled: total.count + 1 >= total.l.max, cap };
  }

  /**
   * A challenge to this domain verified: its mails' places come back and, when it reserved one (an owner's challenge
   * never does) and its mailbox hasn't verified here today, the login raises the cap for 7 days: distinct mailboxes a
   * day, never past DOMAIN_SENDS_MAX (scan of the re-check).
   */
  async domainVerified(reservations: Reservation[], mailboxKey: string, now: number = Date.now()): Promise<void> {
    if (reservations.length === 0) return;
    for (const r of reservations) this.refund(r);
    const d = this.day(now);
    const seen = `vm:${mailboxKey}@${d}`;
    if (this.kv().get(seen) === undefined) {
      this.kv().put(seen, 1);
      const k = verifiedKey(d);
      this.kv().put(k, (this.kv().get<number>(k) ?? 0) + 1);
    }
    await this.sweepAt(now + DAY);
  }

  // ---- cleanup ----

  private async sweepAt(untilMs: number): Promise<void> {
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current < untilMs) await this.ctx.storage.setAlarm(untilMs + 1);
  }

  /** Deletes ended windows, locks, challenges, staff logs, revocations and old verified counts; an empty object holds nothing. */
  override async alarm(): Promise<void> {
    const kv = this.kv();
    const now = Date.now();
    let next = 0;
    const keepUntil = (key: string, until: number) => {
      if (until <= now) kv.delete(key);
      else next = Math.max(next, until);
    };
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
      } else if (key.startsWith('lock:')) keepUntil(key, value as number);
      else if (key.startsWith('tickets:')) {
        const live = (value as TicketEntry[]).filter((t) => t.issuedAtMs + THIRTY_DAYS_MS > now);
        if (live.length) {
          kv.put(key, live);
          next = Math.max(next, Math.min(...live.map((t) => t.issuedAtMs)) + THIRTY_DAYS_MS);
        } else kv.delete(key);
      }
      else if (key.startsWith('verified@')) keepUntil(key, Number(key.slice(9)) + (DOMAIN_VERIFIED_DAYS + 1) * DAY);
      else {
        // Every other entry is keyed `…@<window start>` with a window of at most a day.
        const start = Number(key.slice(key.lastIndexOf('@') + 1));
        if (!Number.isFinite(start)) kv.delete(key);
        else keepUntil(key, start + DAY);
      }
    }
    if (next > 0) await this.ctx.storage.setAlarm(next + 1);
    else await this.ctx.storage.deleteAll();
  }
}
