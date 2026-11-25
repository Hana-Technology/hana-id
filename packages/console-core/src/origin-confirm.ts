// D931 (piece P10 of docs/partner-platform-spec.md, A15; D914, D917): the confirmation of web addresses that wait for a
// second person. A web address the network's backend asked for (a platform proposal) comes into force at once when a
// console `owner` who is also an on-chain owner of the app's scope confirms it with a fresh Google sign-in; one staff
// added to a platform-created app or a shared wallet (a staff proposal under four eyes) when such an owner, or a second
// staff member (another Access identity and email), confirms it. Otherwise each waits at least 24 h after its email.
// This module holds what the API, the console and the admin Worker share: the RPC inputs, the views, the limits and
// the words. The step-up's layout is `originConfirmDigest` (layouts.ts) and the removal link's `originRemove`.
import { z } from '@hana-id/env/zod';
import { ORIGIN_CONFIRM_MAX } from './layouts.ts';
import { appIdInput, guardedChangeIdInput, orgIdInput } from './rpc.ts';
import { ctx, environment, ms, requestId } from './types.ts';

const DAY = 86_400_000;
/** The confirmation notice's removal link works this long after the notice (A15, confirmed by the Tech Lead: D917). */
export const ORIGIN_REMOVAL_LINK_MS = 7 * DAY;
/** The staff queue lists a confirmed web address this long after its confirmation (A11). */
export const CONFIRMED_QUEUE_MS = 7 * DAY;
/** A second staff member's reason, at least this long (as an expedite's and a key approval's). */
export const STAFF_CONFIRM_REASON_MIN = 20;
/** How many other apps of a shared wallet the confirmation page names (and then "and N more"). */
export const CONFIRM_OTHER_APPS_SHOWN = 5;
/**
 * Confirmations per member and per org, in a clock hour (each attempt that reaches the API counts, refused ones too:
 * a confirmation is one set of up to 20 web addresses, and the backend may propose at most 20 an hour, 30 a day).
 */
export const ORIGIN_CONFIRM_LIMITS = { memberPerHour: 20, orgPerHour: 40 } as const;

const changeIds = z
  .array(guardedChangeIdInput)
  .min(1)
  .max(ORIGIN_CONFIRM_MAX)
  .refine((l) => new Set(l).size === l.length, 'A change is listed twice');
const jwt = z.string().max(7168).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
const b64url32 = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);

/** ConsoleRpc.confirmOrigins: an owner's step-up of kind `origin.confirm` over exactly these changes of one app. */
export const confirmOriginsInput = ctx
  .extend({ orgId: orgIdInput, appId: appIdInput, changeIds, stepUpJwt: jwt, stepUpId: z.string().regex(/^act_[1-9A-HJ-NP-Za-km-z]{12,17}$/u).optional() })
  .strict();
/** AdminRpc.confirmStaffOrigins: a second staff member (never the proposer), with a reason. */
export const confirmStaffOriginsInput = ctx
  .extend({ orgId: orgIdInput, appId: appIdInput, changeIds, reason: z.string().trim().min(STAFF_CONFIRM_REASON_MIN).max(1000) })
  .strict();
/** ConsoleRpc.getConfirmation: the page the email's Confirm link opens (reads only). */
export const getConfirmationInput = ctx.extend({ orgId: orgIdInput, changeId: guardedChangeIdInput }).strict();
/** ConsoleRpc.removeOriginByLink and removalPreview: the confirmation notice's link (no session: the `link` actor). */
export const removeOriginByLinkInput = ctx.extend({ changeId: guardedChangeIdInput, token: b64url32 }).strict();
/** AdminRpc.confirmationNotices: the confirmations whose notice hasn't gone out. */
export const confirmationNoticesInput = ctx.extend({ limit: z.number().int().min(1).max(50) }).strict();
/** AdminRpc.ackConfirmationNotice (`system` only): the notice went out; each removal link's sha256. */
export const ackConfirmationNoticeInput = ctx
  .extend({ requestId, removals: z.array(z.object({ changeId: guardedChangeIdInput, removalTokenHash: b64url32 }).strict()).min(1).max(ORIGIN_CONFIRM_MAX) })
  .strict();

export type ConfirmOriginsInput = z.infer<typeof confirmOriginsInput>;
export type ConfirmStaffOriginsInput = z.infer<typeof confirmStaffOriginsInput>;
export type GetConfirmationInput = z.infer<typeof getConfirmationInput>;
export type RemoveOriginByLinkInput = z.infer<typeof removeOriginByLinkInput>;
export type ConfirmationNoticesInput = z.infer<typeof confirmationNoticesInput>;
export type AckConfirmationNoticeInput = z.infer<typeof ackConfirmationNoticeInput>;

/** Who is waited for: a platform proposal waits for an owner; a staff one under four eyes for an owner or a second staffer. */
export type ConfirmProposer = 'platform' | 'hana';

/** One web address of a confirmation set, as the page shows it. */
export interface ConfirmationChange {
  changeId: string;
  origin: string;
  display: string;
  idn: boolean;
  /** `waiting_announcement`: its email hasn't gone out, so it can't be confirmed yet. */
  state: 'waiting_announcement' | 'waiting' | 'in_force' | 'cancelled' | 'ended';
  /** When it comes into force if nobody confirms it (null before its email). */
  activeFrom: number | null;
  confirmedAt?: number;
  /** It may be confirmed now (announced, waiting, not confirmed). */
  confirmable: boolean;
}

/** The confirmation page's view: the app, who asked, and the web addresses of that one request on that app. */
export interface ConfirmationView {
  app: { id: string; name: string; scopeId: string; environment: z.infer<typeof environment>; sharedScope: boolean; otherApps: string[]; otherAppsTotal: number };
  requestId: string;
  proposedByKind: ConfirmProposer;
  /** A platform proposal: the key that asked, by id and label (null if the label can't be read). */
  keyId?: string;
  keyLabel?: string | null;
  proposedAt: number;
  changes: ConfirmationChange[];
}

/** AdminRpc.confirmationNotices: one confirmation call, to be emailed with one removal link per web address. */
export interface ConfirmationNotice {
  /** The confirmation's request id (its ledger row): one email per confirmation. */
  requestId: string;
  app: { id: string; name: string; orgId: string; scopeId: string; environment: z.infer<typeof environment> };
  contacts: string[];
  confirmedByKind: 'member' | 'hana';
  /** The console user id (a member: the admin names them from the org's members) or the staff member's Access subject. */
  confirmedBy: string;
  confirmedAt: number;
  proposedByKind: ConfirmProposer;
  /** The proposing key (a platform proposal) and its label. */
  keyId?: string;
  keyLabel?: string | null;
  /** The proposing staff member's Access subject (a staff proposal): the notice names both people. */
  proposedBy?: string;
  changes: { changeId: string; origin: string; display: string; idn: boolean }[];
}

/** A confirmed web address in the staff queue (A11): for 7 days after its confirmation. */
export interface ConfirmedQueueRow {
  changeId: string;
  appId: string;
  appName: string;
  orgId: string;
  origin: string;
  display: string;
  idn: boolean;
  proposedByKind: ConfirmProposer;
  proposedBy: string;
  confirmedByKind: 'member' | 'hana';
  confirmedBy: string;
  confirmedAt: number;
  /** Removed since (by the removal link, an owner, staff or the platform): no longer working. */
  removed: boolean;
}

/** A staff proposal under four eyes that waits for a second person, as the staff queue lists it. */
export interface SecondPersonQueueRow {
  changeId: string;
  appId: string;
  appName: string;
  orgId: string;
  origin: string;
  display: string;
  idn: boolean;
  requestId: string;
  proposedBy: string;
  proposedAt: number;
  notifiedAt: number | null;
  activeFrom: number | null;
}

export const confirmationChangeView = z
  .object({ changeId: z.string(), origin: z.string(), display: z.string(), idn: z.boolean(), state: z.string(), activeFrom: ms.nullable(), confirmedAt: ms.optional(), confirmable: z.boolean() })
  .strict();

/**
 * The words the screens and the emails share (plain: "web address", no jargon; D930's words for the rest). The console's
 * page and the admin's emails read them from here, so they say the same thing.
 */
export const CONFIRM_WORDS = {
  pageTitle: 'Confirm web addresses',
  intro: (app: string) => `Only confirm web addresses you know belong to ${app}. Once you confirm, ${app} can use this wallet there straight away.`,
  notYours: 'Not yours? Cancel it.',
  waitLine: (date: string) => `Starts working on ${date} if nobody confirms it.`,
  waitingLine: (date: string) => `Waiting for an owner to confirm, or starts working on ${date}`,
  secondPersonLine: (date: string) => `Waiting for a second person to confirm, or starts working on ${date}`,
  notAnnounced: 'Its email hasn’t gone out yet, so it can’t be confirmed yet. Try again in a few minutes.',
  onlyOwner: 'Only an owner of this wallet’s settings can confirm.',
  confirmButton: 'Confirm',
  noneTicked: 'Tick each web address you know belongs to this app first.',
  removeButton: 'Remove this web address',
  removed: 'Removed. It stopped working straight away.',
  emailOrSooner: 'or sooner if an owner of your organisation confirms it',
} as const;
