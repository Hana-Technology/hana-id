// The watchdog Worker's bindings. Vars come from envs/<env>.json through scripts/gen-wrangler.ts; secrets are set
// with `wrangler secret put` (or `secret bulk`) from .secrets/<env>/watchdog-secrets.json and never logged.

import { PAGER_PROVIDERS, type PagerProvider, SECRET_NAMES } from './names.ts';

export { PAGER_PROVIDERS, type PagerProvider, SECRET_NAMES } from './names.ts';

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
  PAGER_PROVIDER: string;
  /** Comma-separated alert email recipients (both founders, D85). */
  ALERT_EMAILS: string;
  ALERT_FROM: string;
  /** Hour (UTC) after which the daily digest is sent. */
  DIGEST_HOUR_UTC?: string;

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
