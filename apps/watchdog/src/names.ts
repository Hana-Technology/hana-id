// Names shared by the Worker and its Node scripts (no Worker types here, so scripts/ can import it).

/** Paging apps (D85: chosen at setup); the same list as the manifest schema's (tested). */
export const PAGER_PROVIDERS = ['ntfy', 'pushover', 'pagerduty'] as const;
export type PagerProvider = (typeof PAGER_PROVIDERS)[number];

/** Every secret binding: log lines and alert texts must never contain any of their values (tested). */
export const SECRET_NAMES = [
  'WATCHDOG_KEY',
  'WATCHDOG_STATUS_TOKEN',
  'SENDGRID_API_KEY',
  'SLACK_WEBHOOK_URL',
  'NTFY_TOPIC_URL',
  'NTFY_TOKEN',
  'PUSHOVER_TOKEN',
  'PUSHOVER_USER',
  'PAGERDUTY_ROUTING_KEY',
  'HEARTBEAT_URL',
] as const;

/**
 * A dev env (`local*`, `sandbox*`), where `unrecorded_wallets` may be true between the v3 upgrade and
 * `accept_unrecorded_wallets` (D139). The same rule as `@hana-id/env` `isDevEnv` (a scripts test keeps them equal; the
 * Worker doesn't bundle the manifest package).
 */
export function isDevEnvName(name: string): boolean {
  return /^(local|sandbox)/u.test(name);
}

/** The alert-title labels (D419); the same list as `@hana-id/env` `ENV_ALERT_LABELS` (a scripts test keeps them equal). */
export const ALERT_LABELS = ['[SANDBOX]', '[STAGING]', '[LOCAL]', '[TESTNET]'] as const;

/**
 * The label an env's alert titles start with (D419): `@hana-id/env` `envAlertLabel` (a scripts test keeps them equal).
 * Empty on any network but testnet.
 */
export function alertLabelFor(name: string, network: string): string {
  if (network !== 'testnet') return '';
  if (/^sandbox/u.test(name)) return '[SANDBOX]';
  if (/^staging/u.test(name)) return '[STAGING]';
  if (/^local/u.test(name)) return '[LOCAL]';
  return '[TESTNET]';
}
