// Constants and the one runtime setting of the console's data path (docs/batch-c-spec.md "Invites and owner grants",
// "Sessions", "Retention", "Deferred").
import { RpcRefusal } from './errors.ts';

/**
 * Mandatory partner passkeys (§Deferred) haven't shipped: while this is false, `StaffRpc.issueInvite` refuses a second
 * `partner` org with `passkeys_required` (`org_legacy` and `internal` orgs don't count). Flipped only by the release
 * that ships passkeys, never by config.
 */
export const PASSKEYS_SHIPPED = false;

/**
 * Whether D242's one-partner gate applies (amended by D698: lifted on testnet only). It applies until passkeys ship,
 * on every network but testnet. The network is the env manifest's (`envs/<env>.json` `network`, which the manifest
 * schema allows only as `testnet` today), written into the console's config by `gen` as `NETWORK`, the same var the
 * API's mainnet-demo rule reads (`mainnetDemoEnv`). Missing, empty or anything but exactly `testnet`: the gate applies
 * (fails closed).
 */
export const onePartnerGate = (network: string | undefined): boolean => !PASSKEYS_SHIPPED && network !== 'testnet';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

/** `ownerGrantDelayMs` bounds, as @hana-id/env's `delayMs` (scripts/test/gen-wrangler.test.ts compares them). */
export const MIN_OWNER_GRANT_DELAY_MS = 60_000;
export const MAX_OWNER_GRANT_DELAY_MS = 7 * DAY_MS;

/** Sessions (§Sessions): 2 h idle, 12 h absolute, `last_seen_at` written at most every 5 min. */
export const SESSION_IDLE_MS = 2 * HOUR_MS;
export const SESSION_ABSOLUTE_MS = 12 * HOUR_MS;
export const SESSION_TOUCH_MS = 5 * MINUTE_MS;

/** Sign-in (§Code flow): a flow lives 5 min from its creation, a handoff code 60 s; the flow cookies' Max-Age. */
export const AUTH_FLOW_TTL_MS = 5 * MINUTE_MS;
export const HANDOFF_TTL_MS = 60_000;
export const FLOW_COOKIE_MAX_AGE_S = 600;

/** Housekeeping (§Retention): what the hourly cron removes, and when. */
export const INVITE_KEEP_MS = 90 * DAY_MS;
export const SESSION_KEEP_MS = 30 * DAY_MS;
export const SESSION_NETWORK_KEEP_MS = 90 * DAY_MS;
export const SHORT_LIVED_KEEP_MS = DAY_MS;
export const LOGO_KEEP_MS = 30 * DAY_MS;
/** Rows one cron step handles per run (D1's per-invocation limits; the next hour picks up the rest). */
export const CRON_BATCH = 200;

/**
 * `OWNER_GRANT_DELAY_MS` (manifest `ownerGrantDelayMs`, D145), within the manifest's bounds. A missing or out-of-range
 * value refuses every grant write with `internal` (fail closed: no grant ever matures early).
 */
export function ownerGrantDelayMs(env: { OWNER_GRANT_DELAY_MS?: string | undefined }): number {
  const v = Number(env.OWNER_GRANT_DELAY_MS);
  if (!env.OWNER_GRANT_DELAY_MS || !/^[1-9]\d*$/u.test(env.OWNER_GRANT_DELAY_MS) || !Number.isSafeInteger(v) || v < MIN_OWNER_GRANT_DELAY_MS || v > MAX_OWNER_GRANT_DELAY_MS) {
    throw new RpcRefusal('internal', 'OWNER_GRANT_DELAY_MS is missing or out of range');
  }
  return v;
}
