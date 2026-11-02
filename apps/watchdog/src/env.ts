// The watchdog Worker's bindings. Vars come from envs/<env>.json through scripts/gen-wrangler.ts; secrets are set
// with `wrangler secret put` (or `secret bulk`) from .secrets/<env>/watchdog-secrets.json and never logged.

import { PAGER_PROVIDERS, type PagerProvider, SECRET_NAMES } from './names.ts';

export { isDevEnvName, PAGER_PROVIDERS, type PagerProvider, SECRET_NAMES } from './names.ts';

export interface Env {
  DB: D1Database;
  ENV_NAME: string;
  /** Expected `chain_id` of the RPC (`testnet`): the watchdog sends nothing to any other chain. */
  NEAR_NETWORK: string;
  NEAR_RPC: string;
  /** Optional second RPC, used when NEAR_RPC errors or times out. */
  NEAR_RPC_FALLBACK?: string;
  /** The hana-signer account watched. */
  SIGNER_ACCOUNT: string;
  /** This watchdog's own account (one of the contract's watchdogs). */
  WATCHDOG_ACCOUNT: string;
  /**
   * The relayer account whose balance and pool-key allowances are monitored (the manifest's `relayer`). Optional: a
   * Worker configured before relayer monitoring skips the `relayer_funds` check until `gen` and a redeploy.
   */
  RELAYER_ACCOUNT?: string;
  /** JSON of the manifest's `watchdog.relayerFunds` (thresholds in NEAR); absent: the defaults (relayer.ts). */
  RELAYER_FUNDS?: string;
  PAGER_PROVIDER: string;
  /** Comma-separated alert email recipients (both founders, D85). */
  ALERT_EMAILS: string;
  ALERT_FROM: string;
  /** Hour (UTC) after which the daily digest is sent. */
  DIGEST_HOUR_UTC?: string;
  /**
   * JSON `{required, signers: {<id>: [thumbprint, …]}}` of the manifest's `watchdog.pinnedIssuerKeys.email`. Absent:
   * nothing pinned (every email key is unpinned; an email issuer on chain is a critical difference).
   */
  EMAIL_PINS?: string;
  /** Hana's published email JWKS (set with the pins; default `{apiUrl}/v1/email/jwks.json`). */
  EMAIL_JWKS_URL?: string;
  /** The transactions indexer of the link-volume check (manifest `watchdog.linkVolume.indexerUrl`); absent: skipped. */
  LINK_INDEXER_URL?: string;
  /** JSON `{perHour?, perScopePerHour?}` link-volume thresholds; absent: the defaults (links.ts). */
  LINK_VOLUME?: string;

  // ---- secrets ----
  /** `ed25519:<base58>` function-call key on WATCHDOG_ACCOUNT (receiver SIGNER_ACCOUNT, the four watchdog methods). */
  WATCHDOG_KEY?: string;
  /** Bearer token of the status/ack endpoints; the admin Worker holds the other copy. */
  WATCHDOG_STATUS_TOKEN?: string;
  /** The watchdog's own Resend key (D87), not the admin Worker's. */
  RESEND_API_KEY?: string;
  SLACK_WEBHOOK_URL?: string;
  /** ntfy: full topic URL (e.g. https://ntfy.sh/<unguessable-topic>) and an optional access token. */
  NTFY_TOPIC_URL?: string;
  NTFY_TOKEN?: string;
  /** Pushover: application token and the user or group key (a group holding both founders). */
  PUSHOVER_TOKEN?: string;
  PUSHOVER_USER?: string;
  /** PagerDuty Events API v2 routing (integration) key. */
  PAGERDUTY_ROUTING_KEY?: string;
  /** Dead-man's switch ping URL on a third provider (e.g. healthchecks.io); alerts by itself when pings stop. */
  HEARTBEAT_URL?: string;
}

// Every secret name is a binding of Env (compile-time check).
const _secretsAreBindings: readonly (keyof Env)[] = SECRET_NAMES;
void _secretsAreBindings;

export function pagerProvider(env: Env): PagerProvider | null {
  return (PAGER_PROVIDERS as readonly string[]).includes(env.PAGER_PROVIDER) ? (env.PAGER_PROVIDER as PagerProvider) : null;
}

export function alertEmails(env: Env): string[] {
  return env.ALERT_EMAILS.split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function digestHourUtc(env: Env): number {
  const h = Number(env.DIGEST_HOUR_UTC ?? '0');
  return Number.isInteger(h) && h >= 0 && h <= 23 ? h : 0;
}
