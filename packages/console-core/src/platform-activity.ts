// What the screens read of the platform's activity (D930; docs/partner-platform-spec.md A11, piece P5): an org's
// platform calls (`platform_calls`, migration 0032: every call that passed the signature check, kept 13 months) for the
// partner console's "Platform activity" and the admin portal's org page, and the admin portal's platform queue (every
// web address a platform key proposed that isn't in force yet, and every platform key still waiting, across orgs).
// Reads only: nothing here changes anything, and no new reach is given (the console's members already see every app
// of their org, staff every org).
import { z } from '@hana-id/env/zod';
import type { PlatformKeyView } from './platform-keys.ts';
import { appIdInput, orgIdInput } from './rpc.ts';
import { ctx } from './types.ts';

/** Calls on one page of the activity. */
export const PLATFORM_CALLS_PAGE = 50;
/**
 * How many of the org's calls one page looks through when it is narrowed to one app: a page reads at most this many
 * rows (no index has the app first, so the scan is bounded instead), and "Older" looks through the next ones.
 */
export const PLATFORM_CALLS_SCAN = 1000;
/** Rows of each kind in the staff queue. */
export const PLATFORM_QUEUE_LIMIT = 100;

/** ConsoleRpc.platformCalls (any member) and AdminRpc.platformCalls (staff): one page, newest first. `before` is the previous page's `next`. */
export const platformCallsInput = ctx
  .extend({ orgId: orgIdInput, appId: appIdInput.optional(), before: z.number().int().positive().optional(), limit: z.number().int().min(1).max(PLATFORM_CALLS_PAGE) })
  .strict();
export type PlatformCallsInput = z.infer<typeof platformCallsInput>;

/** AdminRpc.platformQueue (staff). */
export const platformQueueInput = ctx.extend({ limit: z.number().int().min(1).max(PLATFORM_QUEUE_LIMIT) }).strict();

/** One platform call as the screens show it. The caller's network (`ipPrefix`) only in the staff view. */
export interface PlatformCallView {
  seq: number;
  at: number;
  keyId: string;
  method: 'GET' | 'POST';
  /** The route's template, e.g. `/v1/platform/apps/:appId`. */
  route: string;
  appId?: string;
  status: number;
  /** The error code of a refusal; absent for a success. */
  code?: string;
  requestId: string;
  ipPrefix?: string;
}

export type PlatformCallsPage = {
  calls: PlatformCallView[];
  /** The `before` of the next (older) page; absent when there is none. */
  next?: number;
};

/** A web address a platform key proposed that isn't in force yet (the staff queue). */
export interface PlatformQueueOrigin {
  changeId: string;
  appId: string;
  appName: string;
  orgId: string;
  scopeId: string;
  origin: string;
  display: string;
  idn: boolean;
  keyId: string;
  /** The proposing key's label; null if its row can't be read. */
  keyLabel: string | null;
  proposedAt: number;
  /** When its email went out; absent: not yet (it waits for the announcement first). */
  notifiedAt?: number;
  /** When it comes into force if nobody cancels it (set at the announcement). */
  activeFrom?: number;
}

export type PlatformQueue = {
  origins: PlatformQueueOrigin[];
  /** Keys awaiting acceptance or waiting, across orgs, oldest first (the staff view). */
  keys: PlatformKeyView[];
};

export { platformRouteWords } from './platform-words.ts';
