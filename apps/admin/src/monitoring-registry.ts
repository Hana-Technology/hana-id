// The portal's rendering of every watchdog check (D83's standing rule: a check that doesn't surface in the admin portal
// isn't done). Each check id of apps/watchdog/src/checks.ts `CHECKS` has a title here and the part of the "Security &
// monitoring" view that shows its state; test/monitoring.test.ts fails when the watchdog gains a check without one. Every
// alert kind is rendered from the watchdog's own registry (`GET /status` `alert_kinds`: severity, check, description)
// with its playbook from `@hana-id/playbooks` (monitoring.ts `playbookFor`); the same test walks `ALERT_KINDS`.

export interface CheckView {
  title: string;
  /** Where in the view its state shows (the last run's outcome is always in the checks table). */
  shownIn: string;
}

export const CHECK_VIEWS: Readonly<Record<string, CheckView>> = {
  config: { title: 'Secrets, settings and pins present', shownIn: 'Checks; channels; open alerts' },
  jwks_fetch: { title: "Google's JWKS fetched", shownIn: 'Checks; seen kids' },
  chain_read: { title: 'Chain views read through its own RPC', shownIn: 'Checks' },
  watchdog_role: { title: 'This account is a contract watchdog', shownIn: 'Checks; governance watchdogs' },
  pending_key_changes: { title: 'Pending issuer-key changes judged (confirm or cancel)', shownIn: 'Pending key changes; actions log' },
  active_keys: { title: 'Active issuer keys judged (pause on a forged one)', shownIn: 'Checks; pause state; actions log' },
  signer_policy: { title: "Email issuer's signer policy against the pins", shownIn: 'Checks; email pins' },
  links: { title: 'Link volume against the alarm thresholds', shownIn: 'Checks; link stats' },
  exit_clients: { title: 'Exit clients against the pins, and the hourly exit counter', shownIn: 'Checks; open alerts' },
  identity_on_chain: { title: 'No identity key trusted on chain', shownIn: 'Checks' },
  governance_diff: { title: 'Governance and config changes since the last run', shownIn: 'Pending upgrades and owner actions; open alerts' },
  unexecuted_changes: { title: 'Due key changes nobody executed', shownIn: 'Pending key changes' },
  relayer_funds: { title: "Relayer balance and pool keys' allowances", shownIn: 'Relayer funds' },
  alert_delivery: { title: 'Alert deliveries and 15-minute re-sends', shownIn: 'Alert history (deliveries)' },
  digest: { title: 'Daily info digest', shownIn: 'Checks' },
  heartbeat: { title: "Dead-man's switch ping", shownIn: 'Heartbeat' },
  email_jwks: { title: "Journear's email JWKS against the pins", shownIn: 'Checks; email pins' },
  identity_jwks: { title: "Journear's identity JWKS and discovery document against the pins", shownIn: 'Checks; identity keys' },
};
