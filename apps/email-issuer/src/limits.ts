// Every limit of the issuer (spec "Codes, attempts, expiry, replay" and "Rate limits and abuse"; D123 Q22: provisional,
// tuned on sandbox-dev; D198 for how they are keyed). All exact, on RateLimiter objects: the Rate Limiting binding's
// 10 s / 60 s periods can't express these windows.
import type { Limit } from './rate-limiter.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A challenge (and every code of it) lives 10 min from its creation (D197: a resend doesn't extend it). */
export const CHALLENGE_TTL_MS = 10 * MIN;
/** Wrong codes that kill one challenge. */
export const MAX_ATTEMPTS = 5;
/** Resends per challenge, and their spacing. */
export const MAX_RESENDS = 2;
export const RESEND_SPACING_MS = 30_000;
/** A `linkTicket` (verify → google-match, case B): single use, 10 min. */
export const LINK_TICKET_TTL_MS = 10 * MIN;

/**
 * Code mails per mailbox (the normalized address without its `+tag`, D159) and requester (IP subject): the spec's 3 per
 * 15 min and 10 per day, per requester, so someone who knows an address can't use up its owner's codes (D198).
 */
export const MAILBOX_IP_CODE_LIMITS: Limit[] = [
  { name: 'codes:15m', windowMs: 15 * MIN, max: 3 },
  { name: 'codes:1d', windowMs: DAY, max: 10 },
];
/** Code mails per mailbox from every requester together: the mail-bombing bound. */
export const MAILBOX_CODE_LIMITS: Limit[] = [
  { name: 'codes:15m', windowMs: 15 * MIN, max: 10 },
  { name: 'codes:1d', windowMs: DAY, max: 30 },
];
/** Past the mailbox-wide allowance: a small reserve, only for a requester that hasn't asked for this mailbox today. */
export const MAILBOX_RESERVE_LIMIT: Limit = { name: 'reserve:1d', windowMs: DAY, max: 5 };
/** Live challenges per mailbox at once. */
export const MAX_LIVE_CHALLENGES = 5;
/** Challenges created per mailbox per UTC day, every kind (google-match's prepared ones included): a hard cap. */
export const MAILBOX_CHALLENGES_PER_DAY: Limit = { name: 'challenges:1d', windowMs: DAY, max: 35 };
/** Wrong codes per mailbox and requester: the 10th in an hour locks that requester out of that mailbox for an hour. */
export const MAILBOX_IP_WRONG_LIMIT: Limit = { name: 'wrong:1h', windowMs: HOUR, max: 10 };
export const MAILBOX_IP_LOCK_MS = HOUR;
/** Failed checks per mailbox and requester in the UTC day (no cap of its own: it decides who may use the owner slot). */
export const MAILBOX_IP_WRONG_DAY: Limit = { name: 'wrong:1d', windowMs: DAY, max: Number.MAX_SAFE_INTEGER };
/**
 * The hard ceiling (D198): failed (or in-flight) code checks per mailbox per UTC day, from every requester and every
 * path together. Nothing passes it. 25 a day × 365 days × 10⁻⁶ per guess ≈ 0.91% a year against a 6-digit code.
 */
export const MAILBOX_WRONG_CEILING: Limit = { name: 'wrong:all:1d', windowMs: DAY, max: 25 };
/** Within the ceiling: the checks open to any requester. When they are used up the backstop has tripped. */
export const MAILBOX_WRONG_BACKSTOP: Limit = { name: 'wrong:any:1d', windowMs: DAY, max: 20 };
/**
 * Within the ceiling, counted on its own: the owner slot, open only to a requester that started a challenge on this
 * mailbox before the backstop tripped and has no failed check on it that day (ceiling = backstop + owner slot).
 */
export const MAILBOX_OWNER_SLOT: Limit = { name: 'wrong:owner:1d', windowMs: DAY, max: 5 };

/** `start` (and google-match's prepared challenges) per IP: 10 per 10 min, 50 per day. */
export const IP_START_LIMITS: Limit[] = [
  { name: 'ip:start:10m', windowMs: 10 * MIN, max: 10 },
  { name: 'ip:start:1d', windowMs: DAY, max: 50 },
];
/** `verify` per IP: 30 per 10 min. */
export const IP_VERIFY_LIMITS: Limit[] = [{ name: 'ip:verify:10m', windowMs: 10 * MIN, max: 30 }];
/** `resend` per IP (not in the spec's table; the same bound as start, D198). */
export const IP_RESEND_LIMITS: Limit[] = [{ name: 'ip:resend:10m', windowMs: 10 * MIN, max: 10 }];
/** `google-match` per IP (not in the spec's table: it calls Google three times and the chain four, D198). */
export const IP_MATCH_LIMITS: Limit[] = [{ name: 'ip:match:10m', windowMs: 10 * MIN, max: 30 }];
/** Staff client proofs per staff member. */
export const STAFF_PROOF_LIMITS: Limit[] = [{ name: 'staff:proof:1h', windowMs: HOUR, max: 20 }];

/**
 * Per app: `start` 20 × the plan's `per_minute` per minute (the spec's value, read literally), and a daily cap of the
 * plan's `per_day` (D198: the spec names a daily cap without a value).
 */
export function appStartLimits(plan: { perMinute: number; perDay: number }): Limit[] {
  return [
    { name: 'app:start:1m', windowMs: MIN, max: Math.max(1, 20 * plan.perMinute) },
    { name: 'app:start:1d', windowMs: DAY, max: Math.max(1, plan.perDay) },
  ];
}

/** The env's daily send budget (every user mail): `start` refused at the cap, and a critical log line. */
export const globalSendLimits = (budget: number): Limit[] => [{ name: 'global:sends:1d', windowMs: DAY, max: budget }];
