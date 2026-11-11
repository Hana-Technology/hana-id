// Retention (D90; docs/batch-c-spec.md "Retention"; batch C13, D360–D369): the periods the admin Worker's monthly job
// applies, the cutoffs it computes from them, and the inputs of its RPCs on the API (`AdminRpc.purgeAudit`,
// `deletedApps`, `purgeDirectory`, `purgeUserEvents`) and the console (`StaffRpc.purgeAudit`). Every method takes a
// `system` actor only (the cron), and each clamps `before` to its own period, so a caller can never purge younger rows
// than D90 allows.
import { z } from '@hana-id/env/zod';
import { ctx } from './types.ts';

/** Audit rows (`audit_log`, `app_changes`, `guarded_changes`, `owner_grants`): 60 months, the triggers' constant. */
export const AUDIT_KEEP_MONTHS = 60;
/**
 * `user_events` (API migration 0013: key exports by internal id, mainnet demo signatures with the wallet address; D430):
 * 24 months from the event, as the ledger keeps a uid on raw usage (D90). Per-user records for support, not billing or
 * audit; deleted outright (a row without its user or address has no use). See the decision in docs/decisions.md.
 */
export const USER_EVENTS_KEEP_MONTHS = 24;
/** An app's per-user rows (ledger `app_users`, the wallet directory of a scope left without apps) after its deletion. */
export const DELETED_APP_GRACE_MS = 30 * 24 * 60 * 60_000;
/** Rows one purge call may delete per table (one D1 batch). */
export const RETENTION_BATCH_MAX = 1000;
/** The monthly job's batch: well under D1's per-query limits, a few calls a month at pilot volumes. */
export const RETENTION_BATCH = 500;

/** `t` moved back `months` calendar months in UTC (SQLite's `'-N months'`: an overflowing day rolls forward). */
export function monthsBefore(t: number, months: number): number {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - months, d.getUTCDate(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds());
}

/** The audit cutoff at `now`: rows older than this may be deleted (D90). */
export const auditCutoff = (now: number): number => monthsBefore(now, AUDIT_KEEP_MONTHS);
/** The user events cutoff at `now`: events older than this may be deleted. */
export const userEventsCutoff = (now: number): number => monthsBefore(now, USER_EVENTS_KEEP_MONTHS);
/** Apps deleted at or before this are past their 30 days. */
export const deletedAppCutoff = (now: number): number => now - DELETED_APP_GRACE_MS;

const ms = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const batch = z.number().int().min(1).max(RETENTION_BATCH_MAX);
/** `deletedApps` paging: the last app's `<deleted_at ms>:<app id>`. */
export const DELETED_APPS_CURSOR_RE = /^(0|[1-9]\d{0,15}):app_[A-Za-z0-9]{1,64}$/u;

/** AdminRpc.purgeAudit and StaffRpc.purgeAudit: up to `limit` rows of each audit table older than `before`. */
export const purgeAuditInput = ctx.extend({ before: ms, limit: batch }).strict();
/** AdminRpc.deletedApps: apps deleted at or before `before`, oldest deletion first, after the cursor. */
export const deletedAppsInput = ctx.extend({ before: ms, after: z.string().regex(DELETED_APPS_CURSOR_RE).optional(), limit: batch.optional() }).strict();
/** AdminRpc.purgeDirectory: the wallet directory of scopes whose every app was deleted at or before `before`. */
export const purgeDirectoryInput = ctx.extend({ before: ms, limit: batch }).strict();
/**
 * AdminRpc.purgeUserEvents: up to `limit` user events older than `before` (clamped to 24 months ago), and up to `limit`
 * of the scopes whose every app was deleted at or before `deletedBefore` (clamped to 30 days ago, as purgeDirectory).
 */
export const purgeUserEventsInput = ctx.extend({ before: ms, deletedBefore: ms, limit: batch }).strict();

export type PurgeAuditInput = z.infer<typeof purgeAuditInput>;
export type DeletedAppsInput = z.infer<typeof deletedAppsInput>;
export type PurgeDirectoryInput = z.infer<typeof purgeDirectoryInput>;
export type PurgeUserEventsInput = z.infer<typeof purgeUserEventsInput>;

/** What each answers (the job adds them up into its run's `rows`). */
export interface ApiPurgeAuditResult {
  appChanges: number;
  guardedChanges: number;
}
export interface ConsolePurgeAuditResult {
  auditLog: number;
  ownerGrants: number;
}
export interface DeletedAppsResult {
  appIds: string[];
  /** The cursor after the page's last app (absent on an empty page). */
  next?: string;
  /** Another page exists now. */
  more: boolean;
}
export interface PurgeDirectoryResult {
  scopes: number;
  users: number;
  wallets: number;
  identities: number;
  /** D411: email consents of apps deleted 30 days ago or more (an API before 0014's build omits it). */
  emailConsents?: number;
  /** D714: name shares of apps deleted 30 days ago or more (an API before migration 0019's build omits it). */
  nameShares?: number;
}
export interface PurgeUserEventsResult {
  /** Events past 24 months. */
  expired: number;
  /** Events of scopes left without apps (the wallet directory's rule, D363). */
  deadScopes: number;
}

/** A retention run's status (ops.retention_runs, migrations-usage 0007). */
export const RETENTION_STATUSES = ['running', 'ok', 'partial', 'failed'] as const;
export type RetentionStatus = (typeof RETENTION_STATUSES)[number];
