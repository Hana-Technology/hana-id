// Every limit of the issuer (spec "Codes, attempts, expiry, replay" and "Rate limits and abuse"; D123 Q22: provisional,
// tuned on sandbox-dev; D198 for how they are keyed and the review defaults "to confirm"). All exact, on RateLimiter
// objects: the Rate Limiting binding's 10 s / 60 s periods can't express these windows.
//
// The named constants below are the production values. Dev envs (`local*`, `sandbox*`: `isDevEnv`) raise the per-mailbox
// and per-IP code limits (D340): `limitsFor(envName)` picks the set, and every caller takes its limits from it.
import { isDevEnv } from '@hana-id/env/origins';
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
 * The owner device ticket's own allowance (D198): 3 code mails per ticket per UTC day for the challenges a valid
 * ticket started (resends included), outside every other mailbox limit, so a code drain can't keep the owner out.
 * Counted per ticket (its nonce), never in a pool an attacker can fill.
 */
export const MAILBOX_TICKET_SENDS: Limit = { name: 'ticket-sends:1d', windowMs: DAY, max: 3 };
/**
 * The ticket path's bounds (scan of the re-check, final check M1): the 3 code mails a day above are counted per exact
 * address (all its tickets together), at most 5 live tickets per address (a 6th revokes the oldest), and at most 10
 * ticket challenges per exact address per UTC day, so verifying again and again can't multiply the allowance.
 */
export const MAX_LIVE_TICKETS = 5;
export const ADDRESS_OWNER_CHALLENGES: Limit = { name: 'owner-challenges:1d', windowMs: DAY, max: 10 };
/**
 * And per mailbox (the address without its `+tag`), so the `+tag`s of one inbox share a bounded allowance: 30 owner
 * challenges (tickets and unlock grants) and 9 ticket mails a day. A `+tag` holder (on a domain without sub-addressing,
 * someone else's address) can't use up the victim's per-address allowance and takes at most a third of the mailbox's.
 */
// The mailbox's own untagged address and unlock grants count toward these but are never blocked by them.
export const MAILBOX_OWNER_CHALLENGES: Limit = { name: 'owner-challenges-box:1d', windowMs: DAY, max: 30 };
export const MAILBOX_TICKET_SENDS_TOTAL: Limit = { name: 'ticket-sends-box:1d', windowMs: DAY, max: 9 };
/** A ticket younger than this is fresh: per-app capped in the owner pool, and only below its half (final check M1). */
export const OWNER_AGED_TICKET_MS = 7 * DAY;
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
/** Past the backstop: checks of challenges started with a valid owner device ticket or unlock grant (an attacker holds neither). */
export const MAILBOX_TICKET_SLOT: Limit = { name: 'wrong:ticket:1d', windowMs: DAY, max: 3 };
/**
 * A staff unlock's own checks, outside the ceiling (M3): 2 per unlock, for the one challenge its mailed grant starts
 * once the ticket slot is used up. At most 3 unlocks in 30 days, so ≤ 37 a year: the yearly bound is
 * 365 × 25 + 37 × 2 ≈ 9,199 failed checks (≈ 9,273 in the worst case), ≈ 0.92% a year against a 6-digit code.
 */
export const MAILBOX_GRANT_SLOT: Limit = { name: 'wrong:grant:1d', windowMs: DAY, max: 2 };

/** Staff unlocks, unsuppressions and ticket revocations per mailbox: each 1 a day, 3 in any 30 days (M2). */
export const STAFF_ACTIONS_PER_MAILBOX_DAY = 1;
export const STAFF_ACTIONS_PER_MAILBOX_30D = 3;
export const THIRTY_DAYS_MS = 30 * DAY;

/** `start` per IP subject (IPv4 address, IPv6 /64): 10 per 10 min, 50 a day. google-match's prepared challenges are
 * counted on `ip:match` instead, and their first code on `ip:resend`. */
export const IP_START_LIMITS: Limit[] = [
  { name: 'ip:start:10m', windowMs: 10 * MIN, max: 10 },
  { name: 'ip:start:1d', windowMs: DAY, max: 50 },
];
/**
 * `start` per aggregate prefix (IPv4 /24, IPv6 /56 and /48): 1000 a day each (H1, raised by abuse review M2 from 200
 * so a carrier NAT or a campus /24 isn't shut by one abuser), so cheap /64s don't multiply. A start with a valid
 * device ticket or unlock grant skips them (checked first).
 */
export const IP_AGGREGATE_START_LIMITS: Limit[] = [{ name: 'agg:start:1d', windowMs: DAY, max: 1000 }];
/** `verify` per IP: 30 per 10 min. */
export const IP_VERIFY_LIMITS: Limit[] = [{ name: 'ip:verify:10m', windowMs: 10 * MIN, max: 30 }];
/** `resend` per IP (not in the spec's table; the same bound as start, D198). */
export const IP_RESEND_LIMITS: Limit[] = [{ name: 'ip:resend:10m', windowMs: 10 * MIN, max: 10 }];
/**
 * `google-match` per IP (not in the spec's table: it calls Google twice and the chain up to five, D198). 120 per 10 min
 * (G-M3, D267; was 30): every Google login of an app with email calls it once, the vault retries a 429 or 503 within
 * the login, and a NAT or a campus puts many users on one IP. Each call needs a genuine Google ID token whose nonce
 * commits to a session, and a live access token of that account, so junk costs the caller a Google sign-in each.
 */
export const IP_MATCH_LIMITS: Limit[] = [{ name: 'ip:match:10m', windowMs: 10 * MIN, max: 120 }];
/**
 * `google-record` per IP (D270): google-match's bound and reasoning (D267), in a window of its own. A token_first login
 * calls one of the two, never both: an app with email login google-match, one without google-record.
 */
export const IP_RECORD_LIMITS: Limit[] = [{ name: 'ip:record:10m', windowMs: 10 * MIN, max: 120 }];
/** The SendGrid webhook per IP (it posts batches; L5). */
export const IP_WEBHOOK_LIMITS: Limit[] = [{ name: 'ip:webhook:10m', windowMs: 10 * MIN, max: 120 }];
/** Staff actions (client proofs, unlocks, unsuppressions, revocations together) per staff member. */
export const STAFF_LIMITS: Limit[] = [{ name: 'staff:actions:1h', windowMs: HOUR, max: 20 }];

/**
 * Code mails per recipient registrable domain per UTC day (H1, M4), except the large consumer providers in
 * `domain.ts`: a base of 100 plus 2 per verified login at that domain over the trailing 7 days (abuse review M1), so a
 * company that really uses email login isn't capped by its own size. A verified challenge gives its mails back.
 */
export const DOMAIN_SENDS_BASE = 100;
export const DOMAIN_SENDS_PER_VERIFIED = 2;
export const DOMAIN_VERIFIED_DAYS = 7;
/** The domain cap never grows past this (scan of the re-check); past it only exempt providers and owner starts pass. */
export const DOMAIN_SENDS_MAX = 2000;
export const DOMAIN_SENDS_WINDOW: Omit<Limit, 'max'> = { name: 'domain:sends:1d', windowMs: DAY };
/**
 * Inside one domain's day, each requester prefix (IPv4 /24, IPv6 /56 and /48) may use at most 20% of the day's cap, so
 * a few requesters can't fill a company domain's day (scan finding 2). Ticketed and unlock-grant starts skip the domain
 * cap altogether.
 */
export const DOMAIN_PREFIX_SHARE = 0.2;
export const DOMAIN_PREFIX_WINDOW: Omit<Limit, 'max'> = { name: 'domain:prefix:1d', windowMs: DAY };
/** A staff unlock's one-time grant (`admin/unlock` mails its token to the address): one start, within 24 h. */
export const UNLOCK_GRANT_TTL_MS = DAY;
/** A staff unsuppress's mailed confirmation: valid 24 h, single use. */
export const CONFIRM_TTL_MS = DAY;
/**
 * A hint for a non-Google-hosted address counts only while its Google identity logged in with that address within the
 * last 180 days (D199): a stale Google account still holding an old address can't steer the address's new owner for
 * ever. Older ones are pruned. Hosted hints don't lapse (Google, or the domain's admin, controls the mailbox, D158).
 */
export const NON_HOSTED_HINT_TTL_MS = 180 * DAY;
/** Rows of stale non-hosted hints pruned per hint write (the issuer has no cron). */
export const HINT_PRUNE_BATCH = 50;

/**
 * The limits that differ between dev and production envs: the mailbox object's (sent with every call to it, so a
 * changed set applies to the counters already there: they are keyed by window name, never by max) and the per-IP
 * `start`, `resend` and `verify` limits, and a ticketed start's own allowance. Everything else (aggregate prefix,
 * recipient domain, grant allowances, google-match and google-record, webhook, staff, the budget) is the same in every env.
 */
export interface MailboxLimits {
  ipCodes: readonly Limit[];
  codes: readonly Limit[];
  maxLive: number;
  challengesPerDay: Limit;
  ipWrong: Limit;
  wrongCeiling: Limit;
  wrongBackstop: Limit;
  ownerSlot: Limit;
  ticketSlot: Limit;
  /** A ticketed start's own code allowance: per exact address, and per mailbox (all its `+tag`s). */
  ticketSends: Limit;
  ticketSendsTotal: Limit;
}
export interface Limits {
  dev: boolean;
  mailbox: MailboxLimits;
  ipStart: readonly Limit[];
  ipResend: readonly Limit[];
  ipVerify: readonly Limit[];
}

const freeze = (l: Limits): Limits => {
  for (const v of Object.values(l.mailbox)) Object.freeze(v);
  Object.freeze(l.mailbox);
  for (const v of [l.ipStart, l.ipResend, l.ipVerify]) for (const x of v) Object.freeze(x);
  return Object.freeze(l);
};

export const PRODUCTION_LIMITS: Limits = freeze({
  dev: false,
  mailbox: {
    ipCodes: MAILBOX_IP_CODE_LIMITS.map((l) => ({ ...l })),
    codes: MAILBOX_CODE_LIMITS.map((l) => ({ ...l })),
    maxLive: MAX_LIVE_CHALLENGES,
    challengesPerDay: { ...MAILBOX_CHALLENGES_PER_DAY },
    ipWrong: { ...MAILBOX_IP_WRONG_LIMIT },
    wrongCeiling: { ...MAILBOX_WRONG_CEILING },
    wrongBackstop: { ...MAILBOX_WRONG_BACKSTOP },
    ownerSlot: { ...MAILBOX_OWNER_SLOT },
    ticketSlot: { ...MAILBOX_TICKET_SLOT },
    ticketSends: { ...MAILBOX_TICKET_SENDS },
    ticketSendsTotal: { ...MAILBOX_TICKET_SENDS_TOTAL },
  },
  ipStart: IP_START_LIMITS.map((l) => ({ ...l })),
  ipResend: IP_RESEND_LIMITS.map((l) => ({ ...l })),
  ipVerify: IP_VERIFY_LIMITS.map((l) => ({ ...l })),
});

/**
 * Dev envs (D340: testnet, tested a lot, no real funds): the same windows and names, higher maxes. The ceiling is
 * still the sum of its three slots (80 backstop + 17 owner + 3 ticket = 100), so the owner slot still works past the
 * backstop; the per-requester wrong-code lock (30 an hour) still trips before the backstop. 20 live challenges at once
 * (production 5), so one tester's abandoned starts never hit the live cap before the per-requester 15-min code limit.
 */
export const DEV_LIMITS: Limits = freeze({
  dev: true,
  mailbox: {
    ipCodes: [
      { name: 'codes:15m', windowMs: 15 * MIN, max: 20 },
      { name: 'codes:1d', windowMs: DAY, max: 100 },
    ],
    codes: [
      { name: 'codes:15m', windowMs: 15 * MIN, max: 30 },
      { name: 'codes:1d', windowMs: DAY, max: 200 },
    ],
    maxLive: 20,
    challengesPerDay: { ...MAILBOX_CHALLENGES_PER_DAY, max: 250 },
    ipWrong: { ...MAILBOX_IP_WRONG_LIMIT, max: 30 },
    wrongCeiling: { ...MAILBOX_WRONG_CEILING, max: 100 },
    wrongBackstop: { ...MAILBOX_WRONG_BACKSTOP, max: 80 },
    ownerSlot: { ...MAILBOX_OWNER_SLOT, max: 17 },
    ticketSlot: { ...MAILBOX_TICKET_SLOT },
    // A ticketed start (a device that signed in before) never falls back to the code limits above, so its own
    // allowance (production 3 a day per address, 9 per mailbox) is what a tester with a device ticket meets first.
    ticketSends: { ...MAILBOX_TICKET_SENDS, max: 100 },
    ticketSendsTotal: { ...MAILBOX_TICKET_SENDS_TOTAL, max: 300 },
  },
  ipStart: [
    { name: 'ip:start:10m', windowMs: 10 * MIN, max: 30 },
    { name: 'ip:start:1d', windowMs: DAY, max: 300 },
  ],
  ipResend: [{ name: 'ip:resend:10m', windowMs: 10 * MIN, max: 30 }],
  ipVerify: [{ name: 'ip:verify:10m', windowMs: 10 * MIN, max: 90 }],
});

/** The env's limit set: `DEV_LIMITS` for a dev env name (`local*`, `sandbox*`), `PRODUCTION_LIMITS` for every other. */
export function limitsFor(envName: string): Limits {
  return isDevEnv(envName) ? DEV_LIMITS : PRODUCTION_LIMITS;
}

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
 * The daily send budget (`dailySendBudget`) and the pools beside it (H1; abuse review H1; final check M1):
 * - the staff pool, 1% of the budget (at least 5): the unlock and unsuppress mails;
 * - the general pool, the rest of the budget: every user's mail. An app may use its share of it a day, sized from its
 *   plan (`BUDGET_SHARE_PER_PLAN_DAY` × the plan's `per_day`: the free plan's 5000 gives 100), capped at the general
 *   pool, with a flat `BUDGET_APP_SHARE` of the budget only when the plan has no usable `per_day`; and the last
 *   `BUDGET_RESERVE` of the general pool only an app that has used less than half its share that day;
 * - the owner pool, 30% of the budget **beside it** (it never eats the general pool; all mail together ≤ 1.3 × the
 *   budget): the mail of challenges a valid device ticket or unlock grant started. A fresh ticket (< 7 days) draws on
 *   it only below half of it and within 20% of it per app; an aged ticket or a grant has no per-app cap, bounded by the
 *   per-address and per-mailbox limits above and the pool. Owner mail the owner pool refuses falls back to the app's
 *   general share, if any is left.
 */
export const BUDGET_OWNER_POOL = 0.3;
export const BUDGET_OWNER_AGED_FROM = 0.5;
export const BUDGET_OWNER_FRESH_APP_SHARE = 0.2;
/** Staff-triggered mail (unlock, unsuppress confirmation) has its own small pool: 1% of the budget, at least 5. */
export const BUDGET_STAFF_POOL = 0.01;
export const BUDGET_STAFF_MIN = 5;
export const BUDGET_SHARE_PER_PLAN_DAY = 0.02;
export const BUDGET_APP_SHARE = 0.1;
export const BUDGET_RESERVE = 0.2;
/** No app's share is below this many mails a day (a tiny plan can still sign people in), within the general pool. */
export const BUDGET_MIN_SHARE = 10;

/** The staff pool's size for a budget. */
export const staffPool = (budget: number): number => Math.min(budget, Math.max(BUDGET_STAFF_MIN, Math.floor(budget * BUDGET_STAFF_POOL)));
/** The general pool: what the staff pool leaves of the budget. */
export const generalPool = (budget: number): number => Math.max(0, budget - staffPool(budget));
/** The owner pool, beside the budget. */
export const ownerPool = (budget: number): number => Math.floor(budget * BUDGET_OWNER_POOL);

/** An app's daily share of the general pool, from its plan's `per_day`. */
export function appBudgetShare(perDay: number, budget: number): number {
  const general = generalPool(budget);
  const fromPlan = Number.isFinite(perDay) && perDay > 0 ? Math.max(BUDGET_MIN_SHARE, Math.floor(perDay * BUDGET_SHARE_PER_PLAN_DAY)) : Math.floor(budget * BUDGET_APP_SHARE);
  return Math.max(1, Math.min(general, fromPlan));
}
/** `email_budget` log lines when a count reaches these fractions of the global budget or of an app's share. */
export const BUDGET_LOG_AT = [0.5, 0.8] as const;
