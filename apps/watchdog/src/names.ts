// Names shared by the Worker and its Node scripts (no Worker types here, so scripts/ can import it).

/** Paging apps (D85: chosen at setup); the same list as the manifest schema's (tested). */
export const PAGER_PROVIDERS = ['ntfy', 'pushover', 'pagerduty'] as const;
export type PagerProvider = (typeof PAGER_PROVIDERS)[number];

/** Every secret binding: log lines and alert texts must never contain any of their values (tested). */
export const SECRET_NAMES = [
  'WATCHDOG_KEY',
  'WATCHDOG_STATUS_TOKEN',
  'RESEND_API_KEY',
  'SLACK_WEBHOOK_URL',
  'NTFY_TOPIC_URL',
  'NTFY_TOKEN',
  'PUSHOVER_TOKEN',
  'PUSHOVER_USER',
  'PAGERDUTY_ROUTING_KEY',
  'HEARTBEAT_URL',
] as const;
