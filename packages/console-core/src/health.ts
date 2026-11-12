// The health methods behind the admin console's System status page (D425; apps/admin/README.md "System status"): what
// the API's `AdminRpc.systemStatus`, the console's `StaffRpc.health` and the email issuer's `DirectoryRpc.health`
// answer the admin Worker. Each is authenticated as its entrypoint's other methods are (a `hana` actor for AdminRpc and
// StaffRpc; the staff request's Access JWT, verified by the issuer, for DirectoryRpc) and answers no user data: build
// ids, timings, counts and timestamps only. Nothing here is a secret.
import { z } from '@hana-id/env/zod';
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
  /** Every pool's public keys (never a secret); null: the pool config is unreadable. */
  relayerKeys: { pool: 'session' | 'owner' | 'home'; publicKey: string }[] | null;
  /** Whether the API writes usage events (its `USAGE_DB` is bound). Absent from an API older than this field. */
  usageCapture?: boolean;
  /** The `GET /v1/governance` snapshot (the API's 10 s cache), or why it couldn't be read. */
  governance: { ok: true; snapshot: Record<string, unknown> } | { ok: false; code: string };
  /** The NEAR meta-transaction relay (D784). Absent from an API older than this field. */
  nearRelay?: NearRelayStatus;
}

/**
 * The NEAR meta-transaction relay as the API sees it (D784–D786), for the admin's "NEAR relay" tile: whether it is on,
 * the relay account's balance and keys, and the day's spend. Amounts are yoctoNEAR (decimal strings), the account a
 * public name from the manifest, keys public keys only (the API derives them from its secret and compares them itself).
 */
export interface NearRelayStatus {
  /**
   * `off`: no relay here (no `near.relay`, empty `receivers`, or not testnet); `bad_config`: NEAR_RELAY is set but the
   * API refuses it; `no_keys`: NEAR_RELAY_KEYS isn't set (the relay's off switch); `bad_keys`: it is unreadable,
   * repeats a key or shares one with a relayer pool; `on`: the relay serves. Every state but `on` answers
   * `503 relayer_unconfigured` on the relay's routes.
   */
  state: 'off' | 'bad_config' | 'no_keys' | 'bad_keys' | 'on';
  /** Why it is off (state `off` only). */
  offReason: 'none' | 'no_receivers' | 'not_testnet' | null;
  /** When the API read it (ms). */
  readAt: number;
  /** `near.relay.account`; null without a readable config. */
  account: string | null;
  /** `lowBalanceNear`, `dailyBudgetNear` (yocto) and the budget alert's share (%); null without a readable config. */
  lowBalanceYocto: string | null;
  dailyBudgetYocto: string | null;
  budgetAlertPct: number | null;
  /** The account on chain (`view_account`, `view_access_key_list`); null when not read (off, bad_config). */
  chain: { ok: true; exists: boolean; availableYocto: string; fullAccessKeys: number } | { ok: false; code: string } | null;
  /** The API's relay keys against the account's full-access keys (state `on` only): how many, and the public keys missing. */
  keys: { configured: number; missing: string[] } | null;
  /** The UTC day's spend (the budget's RateLimiter, read only); null when not read. */
  spend: { ok: true; day: string; spentYocto: string } | { ok: false; code: string } | null;
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
