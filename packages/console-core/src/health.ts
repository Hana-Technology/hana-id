// The health methods behind the admin console's System status page (D425; apps/admin/README.md "System status"): what
// the API's `AdminRpc.systemStatus`, the console's `StaffRpc.health` and the email issuer's `DirectoryRpc.health`
// answer the admin Worker. Each is authenticated as its entrypoint's other methods are (a `hana` actor for AdminRpc and
// StaffRpc; the staff request's Access JWT, verified by the issuer, for DirectoryRpc) and answers no user data: build
// ids, timings, counts and timestamps only. Nothing here is a secret.
import { z } from 'zod';
import { staffCall } from './directory.ts';
import { ctx } from './types.ts';

/** `AdminRpc.systemStatus` and `StaffRpc.health`: no fields beyond the call's context. */
export const systemStatusInput = ctx.strict();
export const staffHealthInput = ctx.strict();
/** `DirectoryRpc.health`: the request id and the staff request's Access JWT, like every DirectoryRpc call. */
export const directoryHealthInput = staffCall.strict();

/** One timed `SELECT 1` on a Worker's own D1. `latencyMs` is the Worker's clock around the query (I/O time). */
export type DbProbe = { ok: true; latencyMs: number } | { ok: false; latencyMs: number };

/** The last run a cron recorded: when, and how it ended (`detail`: a code or the failed steps' names, never data). */
export interface CronRunView {
  job: string;
  atMs: number;
  outcome: 'ok' | 'error' | 'skipped';
  detail: string | null;
}

/** The blocking notices not yet sent (each holds a change, an invite or a grant back): how many and the oldest. */
export interface NoticeBacklog {
  pending: number;
  oldestAt: number | null;
  /** More than the method counts (it reads at most NOTICE_BACKLOG_LIMIT). */
  truncated: boolean;
}

/** How many pending notices a health method reads at most. */
export const NOTICE_BACKLOG_LIMIT = 100;

/** `AdminRpc.systemStatus`: the API's own view of itself (one call for the admin's System status page). */
export interface ApiSystemStatus {
  /** The API's HANA_BUILD (null: unstamped). */
  build: string | null;
  hotDb: DbProbe;
  /** The Google-key sync's last run per provider (`issuer_key_sync_runs`; every 15-minute cron run writes it); null: D1 failed. */
  jwksSync: CronRunView[] | null;
  /** The guarded-change notices the admin cron hasn't sent; null: D1 failed. */
  notices: NoticeBacklog | null;
  /** Both pools' public keys (never a secret); null: the pool config is unreadable. */
  relayerKeys: { pool: 'session' | 'owner'; publicKey: string }[] | null;
  /** The `GET /v1/governance` snapshot (the API's 10 s cache), or why it couldn't be read. */
  governance: { ok: true; snapshot: Record<string, unknown> } | { ok: false; code: string };
}

/** `StaffRpc.health`: the console's view of itself. */
export interface ConsoleHealth {
  build: string | null;
  db: DbProbe;
  /** The hourly cron's last run (console migration 0003 `cron_runs`); null before one, `missing` without the table. */
  cron: CronRunView | null | 'missing';
  /** The invite and owner-grant notices the admin cron hasn't sent; null: D1 failed. */
  notices: NoticeBacklog | null;
  /** A `head` on LOGOS of a key that never exists: reachable or not; null without the binding. */
  logos: 'ok' | 'error' | null;
}

/** `DirectoryRpc.health`: the email issuer's view of itself. */
export interface DirectoryHealth {
  build: string | null;
  db: DbProbe;
}

export type SystemStatusInput = z.infer<typeof systemStatusInput>;
export type StaffHealthInput = z.infer<typeof staffHealthInput>;
export type DirectoryHealthInput = z.infer<typeof directoryHealthInput>;
