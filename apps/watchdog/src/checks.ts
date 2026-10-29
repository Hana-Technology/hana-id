// The registry of everything the watchdog checks and every alert it can raise. It is the hand-off to batch C's admin
// portal (D83): the portal renders each check id and alert kind listed here, and its registry test imports this file
// and fails when an id has no rendering. Adding a check or an alert kind here without its portal view isn't done.

export type Severity = 'critical' | 'warning' | 'info';

/** Checks of one run, in run order. `GET /status` reports each one's outcome for the last run. */
export const CHECKS = {
  config: 'Secrets and settings present: the watchdog key, the alert channels, the RPC on the expected network',
  jwks_fetch: "Fetch Google's JWKS directly (no cache) and record each kid's first-seen time and key material",
  chain_read: 'Read get_key_changes, get_issuer, get_issuer_keys, get_config and get_governance through its own RPC',
  watchdog_role: 'This account is one of the contract watchdogs, and whether it may confirm yet',
  pending_key_changes: "Each pending key change against Google's JWKS: confirm matches, cancel keys Google doesn't publish",
  active_keys: "Each active key against every key Google has published: pause on a key Google doesn't publish",
  governance_diff: 'Config and governance against the last run: upgrades, owner, withdrawals, watchdogs, updater keys, delays, audiences, pause',
  unexecuted_changes: 'Key changes past their executable time that nobody executed',
  alert_delivery: 'First deliveries, 15-minute re-sends of unacknowledged critical alerts, paging-app acknowledgements',
  digest: 'Daily info digest email',
  heartbeat: "Ping the dead-man's switch",
} as const;
export type CheckId = keyof typeof CHECKS;
export const CHECK_IDS = Object.keys(CHECKS) as CheckId[];

export interface AlertKindInfo {
  severity: Severity;
  check: CheckId;
  description: string;
}

/**
 * Every alert kind with its severity (D85: critical → paging app + Slack + email, re-sent every 15 min until
 * acknowledged; warning → Slack + email; info → status and the daily digest).
 */
export const ALERT_KINDS = {
  forged_key_change: {
    severity: 'critical',
    check: 'pending_key_changes',
    description: "A pending key Google doesn't publish (absent from two fetches ≥ 60 s apart) or with other key material: cancelled, and the updater keys deleted when the updater proposed it",
  },
  published_key_removal: { severity: 'critical', check: 'pending_key_changes', description: 'A pending removal of a kid Google still publishes (alert only: the owner decides and cancels)' },
  unverifiable_key_change: { severity: 'critical', check: 'pending_key_changes', description: 'A pending key change for a provider whose JWKS the watchdog does not know (alert only)' },
  forged_active_key: { severity: 'critical', check: 'active_keys', description: "An active key Google never published, or with other key material: the contract is paused" },
  unknown_active_key_first_run: { severity: 'critical', check: 'active_keys', description: 'At the first run, an active key not in the JWKS (alert only: history the watchdog cannot judge)' },
  governance_change: {
    severity: 'critical',
    check: 'governance_diff',
    description: 'An upgrade proposal or execution, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, pause or unpause (alert only)',
  },
  automatic_action: { severity: 'critical', check: 'active_keys', description: 'The watchdog acted again for an incident already alerted (e.g. paused again after an unpause)' },
  protective_action_failed: { severity: 'critical', check: 'pending_key_changes', description: 'A cancel, pause or updater-key deletion the watchdog sent failed' },
  not_a_watchdog: { severity: 'critical', check: 'watchdog_role', description: "This account isn't a contract watchdog: it can't cancel or pause" },
  watchdog_key_missing: { severity: 'critical', check: 'config', description: 'WATCHDOG_KEY is missing or malformed: the watchdog can alert but not act' },
  wrong_network: { severity: 'critical', check: 'config', description: "The RPC's chain_id isn't the expected network: nothing is sent" },
  rpc_failing: { severity: 'warning', check: 'chain_read', description: 'Chain reads failed for 3 runs in a row' },
  jwks_failing: { severity: 'warning', check: 'jwks_fetch', description: "Google's JWKS fetch failed for 3 runs in a row" },
  unexecuted_key_change: { severity: 'warning', check: 'unexecuted_changes', description: 'A key change executable for more than 1 h that nobody executed' },
  stale_active_key: { severity: 'warning', check: 'active_keys', description: 'An active kid Google stopped publishing more than 3 h ago (the updater should have proposed its removal)' },
  active_key_material_unavailable: { severity: 'warning', check: 'active_keys', description: 'The contract has no get_issuer_keys: active keys are checked by kid only' },
  config_change: { severity: 'warning', check: 'governance_diff', description: 'Shared clients, sponsors or public registration changed' },
  confirm_failed: { severity: 'warning', check: 'pending_key_changes', description: 'A confirmation the watchdog sent failed' },
  channel_not_configured: { severity: 'warning', check: 'config', description: 'An alert channel (paging app, Slack, email) or the heartbeat has no credentials' },
  heartbeat_failing: { severity: 'warning', check: 'heartbeat', description: "The dead-man's switch ping failed for 3 runs in a row" },
  key_change_confirmed: { severity: 'info', check: 'pending_key_changes', description: "The watchdog confirmed a key change that matches Google's JWKS" },
  key_change_executed: { severity: 'info', check: 'pending_key_changes', description: 'A key change left the queue and took effect (executed after its delay, or confirmed by another watchdog)' },
  key_change_cancelled: { severity: 'info', check: 'pending_key_changes', description: 'A key change left the queue without taking effect (cancelled by the owner or another watchdog)' },
  config_matured: { severity: 'info', check: 'governance_diff', description: 'A scheduled delay decrease or console-audience addition came into force' },
  first_run: { severity: 'info', check: 'active_keys', description: "First run: the current JWKS recorded as known" },
} as const satisfies Record<string, AlertKindInfo>;
export type AlertKind = keyof typeof ALERT_KINDS;

export type Channel = 'pager' | 'slack' | 'email';

/** Channels per severity (D85). Info goes to the status endpoint and the daily digest only. */
export const CHANNELS: Record<Severity, Channel[]> = {
  critical: ['pager', 'slack', 'email'],
  warning: ['slack', 'email'],
  info: [],
};

/** Critical alerts are re-sent this often until acknowledged (D85). */
export const RESEND_MS = 15 * 60_000;
/** The cron interval (W). The portal warns after two silent intervals. */
export const RUN_INTERVAL_MS = 5 * 60_000;
