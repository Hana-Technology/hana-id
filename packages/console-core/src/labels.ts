// Partner labels' storage and guarded change (D894, piece 2 of D892): the RPC inputs of ConsoleRpc and AdminRpc and
// the views they answer, shared by the API, the console and the admin Worker. The document itself is the partner's
// `journear-labels/1` JSON text; only the API (and, for its own check, the vault) parses it, with @hana-id/core's
// parser. Staff call these "partner labels"; partners read "request labels".
import { z } from '@hana-id/env/zod';
import { appIdInput, orgIdInput, scopeIdInput } from './rpc.ts';
import { b64url32, ctx } from './types.ts';

export const labelIdInput = z.string().regex(/^pl_[A-Za-z0-9]{1,64}$/u);
export const labelChangeIdInput = z.string().regex(/^lc_[A-Za-z0-9]{1,64}$/u);

/**
 * The limits a proposal is held to (D894, to confirm). A document is at most 16 KiB (core's LABEL_LIMITS.documentBytes);
 * these bound what one org stores and what one app's `GET /v1/app` carries.
 */
export const LABEL_STORE_LIMITS = Object.freeze({
  /** Apps one document is attached to. */
  appsPerDocument: 8,
  /** Entries an org holds at once (not removed), over all its scopes. */
  entriesPerOrg: 16,
  /** The bytes of every document an org has in force or waiting, together. */
  orgBytes: 64 * 1024,
  /** The bytes of the documents attached to one app (what its `GET /v1/app` can carry), in force or waiting. */
  appBytes: 32 * 1024,
  /** Proposals one org makes in a rolling 24 hours (each is a notice to its security contacts and a staff feed item). */
  proposalsPerDay: 10,
});

/** A staff note on a block, an allow or a switch: one line, kept in the audit log and shown to the partner for a block. */
export const LABEL_NOTE_MIN = 10;
export const LABEL_NOTE_MAX = 300;
export const labelNote = z
  .string()
  .trim()
  .min(LABEL_NOTE_MIN, `A note of at least ${LABEL_NOTE_MIN} characters`)
  .max(LABEL_NOTE_MAX, `A note of at most ${LABEL_NOTE_MAX} characters`)
  .refine((s) => !/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff\ufff9-\ufffb]/u.test(s), 'One line of plain text: no control, direction or invisible characters');

const version = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const jwt = z.string().max(7168).regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/u);
/** The document as the partner wrote it: at most 16 KiB of UTF-8 (the parser checks the bytes; this bounds the input). */
const documentText = z.string().min(1).max(16 * 1024);
const appIds = z.array(appIdInput).min(1).max(LABEL_STORE_LIMITS.appsPerDocument);
const scope = { orgId: orgIdInput, scopeId: scopeIdInput };

// ---- ConsoleRpc ----

/** A scope's entries: each with its version in force and its waiting one, and the scope's `labelsVersion`. */
export const listLabelsInput = ctx.extend(scope).strict();
/** Every check a proposal gets, without the step-up and without writing: the console's preview and its problems. */
export const previewLabelsInput = ctx.extend({ ...scope, labelId: labelIdInput.optional(), document: documentText, appIds }).strict();
/** A member's proposal (a new entry, or a new version of `labelId`), bound to its step-up token. */
export const proposeLabelsInput = ctx.extend({ ...scope, labelId: labelIdInput.optional(), document: documentText, appIds, expectedVersion: version, stepUpJwt: jwt }).strict();
/** A member's removal of an entry: immediate, bound to its step-up token. */
export const removeLabelsInput = ctx.extend({ ...scope, labelId: labelIdInput, expectedVersion: version, stepUpJwt: jwt }).strict();

// ---- AdminRpc ----

export const labelNoticesInput = ctx.extend({ limit: z.number().int().min(1).max(100) }).strict();
export const ackLabelNoticeInput = ctx.extend({ changeId: labelChangeIdInput, cancelTokenHash: b64url32 }).strict();
/** The staff feed of label changes: every one waiting, and those decided in the last `days` (default 14). */
export const labelQueueInput = ctx.extend({ days: z.number().int().min(1).max(90).optional() }).strict();
export const labelDetailInput = ctx.extend({ changeId: labelChangeIdInput }).strict();

export const LABEL_STAFF_TOOLS = ['block', 'allow'] as const;
export type LabelStaffTool = (typeof LABEL_STAFF_TOOLS)[number];
/** Block (any change not already ended; immediate) or Allow (a change held for review), only while the scope's labels are as the page saw them. */
export const labelStaffActInput = ctx
  .extend({ changeId: labelChangeIdInput, tool: z.enum(LABEL_STAFF_TOOLS), note: labelNote, seen: z.object({ labelsVersion: version, state: z.string().min(1).max(32) }).strict() })
  .strict();

export const labelControlTarget = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('all') }).strict(),
  z.object({ kind: z.literal('org'), orgId: orgIdInput }).strict(),
  z.object({ kind: z.literal('entry'), labelId: labelIdInput }).strict(),
]);
export type LabelControlTarget = z.infer<typeof labelControlTarget>;
export const LABEL_CONTROL_ACTIONS = ['off', 'on', 'review_on', 'review_off'] as const;
export type LabelControlAction = (typeof LABEL_CONTROL_ACTIONS)[number];
/** A kill switch (off / back on) or the required-review switch (an org's or every org's; never an entry's). */
export const labelControlInput = ctx
  .extend({ target: labelControlTarget, what: z.enum(LABEL_CONTROL_ACTIONS), note: labelNote, seenVersion: version })
  .strict()
  .refine((v) => v.target.kind !== 'entry' || v.what === 'off' || v.what === 'on', { message: 'Review is set for an organisation or for every organisation, not for one entry', path: ['what'] });

export type ListLabelsInput = z.infer<typeof listLabelsInput>;
export type PreviewLabelsInput = z.infer<typeof previewLabelsInput>;
export type ProposeLabelsInput = z.infer<typeof proposeLabelsInput>;
export type RemoveLabelsInput = z.infer<typeof removeLabelsInput>;
export type LabelStaffActInput = z.infer<typeof labelStaffActInput>;
export type LabelControlInput = z.infer<typeof labelControlInput>;

// ---- views ----

/**
 * A version's state as people read it (computed by the API from its row, the clock and the controls):
 * proposed (no notice yet), announced (notice sent, waiting for its time), waiting_review (its time passed, held for a
 * staff "Allow"), in_force, and the ends: cancelled (by an owner or the emailed link), lapsed (not announced within 7
 * days, or not reviewed within 7 days of its time), blocked (by staff), replaced (a newer version took over; with
 * `endReason: 'blocked_successor'` when it ended because that newer, live version was blocked: then neither shows),
 * removed.
 */
export const LABEL_STATES = ['proposed', 'announced', 'waiting_review', 'in_force', 'cancelled', 'lapsed', 'blocked', 'replaced', 'removed'] as const;
export type LabelState = (typeof LABEL_STATES)[number];

/** One format of a document as users would see it, with example values (core's plain-text form). */
export interface LabelPreviewFormat {
  /** The method, the Soroban function, or `payment`. */
  key: string;
  /** "{App} says: collect the stamp “Fare paid”" */
  line: string;
  /** The sentence alone: "collect the stamp “Fare paid”". */
  sentence: string;
  /** The parts in order, each marked whose words they are: Journear's verb and joining words, the partner's phrase, a value. */
  parts: { kind: 'verb' | 'word' | 'object' | 'value'; text: string }[];
  /** The rows under the sentence: the partner's label and an example value. */
  fields: { label: string; value: string }[];
}

export interface LabelPreview {
  /** The app named in the lines (the first attached app's name). */
  appName: string;
  /** What the document describes: "NEAR test network, stamps.testnet" and the like. */
  context: string;
  /** Always shown with the preview: the values are made-up examples. */
  examples: true;
  formats: LabelPreviewFormat[];
  /** Every account of the address book, its name and account whole ("Account “Coffee Club till” (G…)"), in order. */
  accounts: string[];
}

/** One line of a version against the version it would replace. */
export interface LabelDiffLine {
  change: 'added' | 'removed' | 'changed' | 'same';
  /** The format's key. */
  key: string;
  before: string | null;
  after: string | null;
}

export interface LabelChangeView {
  id: string;
  labelId: string;
  orgId: string;
  scopeId: string;
  environment: 'test' | 'live';
  apps: { id: string; name: string | null }[];
  schema: string;
  sha256: string;
  bytes: number;
  state: LabelState;
  proposedAt: number;
  notifiedAt: number | null;
  activeFrom: number | null;
  /** When it lapses if nothing more happens: 7 days after the proposal (no notice yet) or after its time (held for review). */
  lapsesAt: number | null;
  /** Whether a staff "Allow" is needed before it takes effect (review switched on for its org or for everyone). */
  reviewRequired: boolean;
  allowedAt: number | null;
  blockedAt: number | null;
  /**
   * Journear's note on a block: every version in staff's views (AdminRpc); in the partner's (ConsoleRpc) only on a
   * blocked version, the same note the blocked mail sends the org's security contacts (D899).
   */
  blockNote?: string | null;
  endedAt: number | null;
  endReason: string | null;
  previousId: string | null;
  /** Which staff switch keeps the entry off, if any: one entry's, its org's, or every partner label's. */
  off: 'entry' | 'org' | 'all' | null;
  /** Whether `GET /v1/app` serves this version now (in force, the entry's newest, not removed, no switch off). */
  served: boolean;
  /**
   * The document exactly as proposed: ConsoleRpc.listLabels only, on an entry's version in force and its waiting one
   * (the console's "what users see now" and its editor start from it; D899).
   */
  text?: string;
  /**
   * ConsoleRpc.listLabels only, on a waiting version: what it changes against the version in force (every line `added`
   * when none is), D894's `diffOf` (D899).
   */
  diff?: LabelDiffLine[];
}

/** A scope's entry as its org's console lists it: the version in force and the waiting one. */
export interface LabelEntryView {
  id: string;
  current: LabelChangeView | null;
  waiting: LabelChangeView | null;
  off: 'entry' | 'org' | 'all' | null;
  /** When an owner removed the entry (removed entries are listed for LABEL_RECENT_MS after their removal), or null. */
  removedAt: number | null;
  /**
   * The entry's versions that ended in the last LABEL_RECENT_MS (blocked, cancelled, lapsed, replaced, removed),
   * newest first, at most LABEL_RECENT_PER_ENTRY; without their text (D899).
   */
  recent: LabelChangeView[];
}

/** How long the console lists a version that ended, and an entry that was removed (D899, to confirm). */
export const LABEL_RECENT_MS = 14 * 24 * 60 * 60 * 1000;
/** The ended versions listed per entry. */
export const LABEL_RECENT_PER_ENTRY = 5;

/** ConsoleRpc.listLabels's answer: a scope's entries and what the console needs to say whether it can propose. */
export interface LabelListAnswer {
  labelsVersion: number;
  entries: LabelEntryView[];
  /** Request labels are switched on in this environment (the manifest's `partnerLabels.enabled`); off, nothing can be proposed or previewed by the API. */
  enabled: boolean;
  /** Journear's switch over this org's labels ('org') or every partner's ('all'), or null: while off, proposals are refused. */
  orgOff: 'org' | 'all' | null;
  /** Journear reviews this org's changes before they go live (its own switch or everyone's). */
  reviewRequired: boolean;
  /** The environment's guarded-change delay (`appChangeDelayMs`): how long after the email a change goes live; null when not configured. */
  delayMs: number | null;
}

/** ConsoleRpc.previewLabels's answer. */
export interface LabelPreviewAnswer {
  preview: LabelPreview;
  sha256: string;
  bytes: number;
  labelsVersion: number;
  /** The same document on the same apps is already in force. */
  noChange: boolean;
  /** Against the entry's version in force (every line `added` for a new entry); the apps aren't part of it (D899). */
  diff: LabelDiffLine[];
  /** Journear reviews this org's changes before they go live: the console says so before the step-up (D899). */
  reviewRequired: boolean;
  /** The environment's guarded-change delay, as in `LabelListAnswer`. */
  delayMs: number | null;
}

/** One label change in the staff feed (AdminRpc.labelQueue / labelDetail): its view, what users would see, and the diff. */
export interface LabelFeedItem {
  change: LabelChangeView;
  /** The scope's labels version now: a staff tool applies only while it is still this (`seen.labelsVersion`). */
  labelsVersion: number;
  /** The entry's own switch version now: the `seenVersion` an entry switch (off / back on) needs. */
  entryVersion: number;
  /** Null only for a stored text that no longer parses (drift's concern, never a proposal's). */
  preview: LabelPreview | null;
  /** Against the version it would replace; every line `added` for a first version. */
  diff: LabelDiffLine[];
}

/** A label version waiting for its notice (AdminRpc.labelNotices): the feed item's parts and the org's security contacts. */
export interface LabelNotice {
  change: LabelChangeView;
  contacts: string[];
  preview: LabelPreview | null;
  diff: LabelDiffLine[];
}

/** The staff switches as they are now (AdminRpc.labelControls, and in labelQueue). */
export interface LabelControls {
  /** Every partner label off, and review required for every org; `version` is the `seenVersion` a change of it needs. */
  all: { labelsOff: boolean; reviewRequired: boolean; version: number; updatedAt: number | null; updatedBy: string | null; note: string | null };
  /** Every org that has (or had) a switch row, including one with both switches off now: its `version` is what the next change needs (no row: 0). */
  orgs: { orgId: string; labelsOff: boolean; reviewRequired: boolean; version: number; updatedAt: number; updatedBy: string; note: string | null }[];
  /** The entries staff switched off (not removed); `version` is the entry's switch version. */
  entries: { labelId: string; orgId: string; scopeId: string; offAt: number; offBy: string | null; note: string | null; version: number }[];
}
