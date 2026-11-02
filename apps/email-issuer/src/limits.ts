// Every limit of the issuer (spec "Codes, attempts, expiry, replay" and "Rate limits and abuse"; D123 Q22: provisional,
// tuned on sandbox-dev; D198 for how they are keyed and the review defaults "to confirm"). All exact, on RateLimiter
// objects: the Rate Limiting binding's 10 s / 60 s periods can't express these windows.
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
/** One `retry-after` for every mailbox-level refusal, so the header says nothing about which limit refused (L1). */
export const MAILBOX_RETRY_AFTER_S = 900;

/**
 * Code mails per mailbox (the normalized address without its `+tag`, D159) and requester (IP subject): the spec's 3 per
 * 15 min and 10 per day, per requester.
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
/**
 * Past the mailbox-wide allowance, a reserve of 5 a day for requesters new to the mailbox that day. An attacker with
 * many IPs can use it up too: it bounds mail, it doesn't protect the owner (the device ticket does).
 */
export const MAILBOX_RESERVE_LIMIT: Limit = { name: 'reserve:1d', windowMs: DAY, max: 5 };
/**
 * The owner device ticket's own allowance (D198): 3 code mails per mailbox per UTC day for a `start` that presents a
 * valid ticket, outside every other mailbox limit, so a code drain can't keep the owner out.
 */
export const MAILBOX_TICKET_SENDS: Limit = { name: 'ticket-sends:1d', windowMs: DAY, max: 3 };
/** Live challenges per mailbox at once (ticketed starts don't need a free place). */
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
 * It is the sum of the three slots below.
 */
export const MAILBOX_WRONG_CEILING: Limit = { name: 'wrong:all:1d', windowMs: DAY, max: 25 };
/** The checks open to any requester (the backstop). When they are used up the backstop has tripped. */
export const MAILBOX_WRONG_BACKSTOP: Limit = { name: 'wrong:any:1d', windowMs: DAY, max: 18 };
/** Past the backstop: requesters that started a challenge before the trip and have no failure that day. */
export const MAILBOX_OWNER_SLOT: Limit = { name: 'wrong:owner:1d', windowMs: DAY, max: 4 };
/** Past the backstop: checks of challenges started with a valid owner device ticket (an attacker can't hold one). */
export const MAILBOX_TICKET_SLOT: Limit = { name: 'wrong:ticket:1d', windowMs: DAY, max: 3 };

/** Staff unlocks and unsuppressions per mailbox: 1 a day, 3 in any 30 days (M2). */
export const STAFF_ACTIONS_PER_MAILBOX_DAY = 1;
export const STAFF_ACTIONS_PER_MAILBOX_30D = 3;
export const THIRTY_DAYS_MS = 30 * DAY;

/** `start` (and google-match's prepared challenges) per IP subject (IPv4 address, IPv6 /64): 10 per 10 min, 50 a day. */
export const IP_START_LIMITS: Limit[] = [
  { name: 'ip:start:10m', windowMs: 10 * MIN, max: 10 },
  { name: 'ip:start:1d', windowMs: DAY, max: 50 },
];
/** `start` per aggregate prefix (IPv4 /24, IPv6 /56 and /48): 200 a day each (H1), so cheap /64s don't multiply. */
export const IP_AGGREGATE_START_LIMITS: Limit[] = [{ name: 'agg:start:1d', windowMs: DAY, max: 200 }];
/** `verify` per IP: 30 per 10 min. */
export const IP_VERIFY_LIMITS: Limit[] = [{ name: 'ip:verify:10m', windowMs: 10 * MIN, max: 30 }];
/** `resend` per IP (not in the spec's table; the same bound as start, D198). */
export const IP_RESEND_LIMITS: Limit[] = [{ name: 'ip:resend:10m', windowMs: 10 * MIN, max: 10 }];
/** `google-match` per IP (not in the spec's table: it calls Google three times and the chain up to five, D198). */
export const IP_MATCH_LIMITS: Limit[] = [{ name: 'ip:match:10m', windowMs: 10 * MIN, max: 30 }];
/** The SendGrid webhook per IP (it posts batches; L5). */
export const IP_WEBHOOK_LIMITS: Limit[] = [{ name: 'ip:webhook:10m', windowMs: 10 * MIN, max: 120 }];
/** Staff actions (client proofs, unlocks, unsuppressions together) per staff member. */
export const STAFF_LIMITS: Limit[] = [{ name: 'staff:actions:1h', windowMs: HOUR, max: 20 }];

/** Code mails per recipient registrable domain per UTC day (H1, M4), except the large consumer providers below. */
export const DOMAIN_SENDS_PER_DAY: Limit = { name: 'domain:sends:1d', windowMs: DAY, max: 100 };
/**
 * Inside one domain's day, each requester prefix (IPv4 /24, IPv6 /56 and /48) may use at most 20% of it, so a few
 * requesters can't fill a company domain's day and lock everyone there out (scan finding 2). Ticketed and unlock-grant
 * starts skip the domain cap altogether.
 */
export const DOMAIN_PREFIX_SENDS_PER_DAY: Limit = { name: 'domain:prefix:1d', windowMs: DAY, max: Math.floor(DOMAIN_SENDS_PER_DAY.max * 0.2) };
/** A staff unlock's one-time grant (`admin/unlock` → `unlockToken`): one start, within 24 h of the unlock. */
export const UNLOCK_GRANT_TTL_MS = DAY;
/**
 * A hint for a non-Google-hosted address counts only while its Google identity logged in with that address within the
 * last 180 days (D199): a stale Google account still holding an old address can't steer the address's new owner for
 * ever. Older ones are pruned. Hosted hints don't lapse (Google, or the domain's admin, controls the mailbox, D158).
 */
export const NON_HOSTED_HINT_TTL_MS = 180 * DAY;
/** Rows of stale non-hosted hints pruned per hint write (the issuer has no cron). */
export const HINT_PRUNE_BATCH = 50;

/**
 * Per app: `start` the plan's `per_minute` per minute and its `per_day` per day (H1: the spec's "20 ×" dropped until
 * email-specific plan fields exist).
 */
export function appStartLimits(plan: { perMinute: number; perDay: number }): Limit[] {
  return [
    { name: 'app:start:1m', windowMs: MIN, max: Math.max(1, plan.perMinute) },
    { name: 'app:start:1d', windowMs: DAY, max: Math.max(1, plan.perDay) },
  ];
}

/**
 * The global daily send budget (every user mail), shared out (H1): an app may use at most `APP_SHARE` of it a day, and
 * the last `RESERVE` of it only an app that has used less than half its share that day, so no single app (or an
 * attacker posing as its users) can stop email login everywhere.
 */
export const BUDGET_APP_SHARE = 0.1;
export const BUDGET_RESERVE = 0.2;
/** `email_budget` log lines when a count reaches these fractions of the global budget or of an app's share. */
export const BUDGET_LOG_AT = [0.5, 0.8] as const;
