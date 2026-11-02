// The registry of everything the watchdog checks and every alert it can raise. It is the hand-off to batch C's admin
// portal (D83): the portal renders each check id and alert kind listed here, and its registry test imports this file
// and fails when an id has no rendering. Adding a check or an alert kind here without its portal view isn't done.
// Every alert kind also has a recovery playbook in `@hana-id/playbooks` (D126): test/registry.test.ts fails otherwise.
import { playbookForAlertKind } from '@hana-id/playbooks';

export type Severity = 'critical' | 'warning' | 'info';

/** Checks of one run, in run order. `GET /status` reports each one's outcome for the last run. */
export const CHECKS = {
  config: 'Secrets and settings present: the watchdog key, the alert channels, the RPC on the expected network, the email and identity pins',
  jwks_fetch: "Fetch Google's JWKS directly (no cache) and record each kid's first-seen time and key material",
  chain_read: "Read get_key_changes, get_issuer and get_issuer_keys (google, email), get_self_issued(\"email\"), get_config, get_governance and the owner account (code hash, the council DAO's get_policy) through its own RPC; a pre-v3 contract reads as no email issuer",
  watchdog_role: 'This account is one of the contract watchdogs, and whether it may confirm yet',
  pending_key_changes: "Each pending key change: Google's against Google's JWKS (confirm matches, cancel keys Google doesn't publish); the email issuer's against the pinned thumbprints of its signer (cancel unpinned ones, never confirm: self-issued keys wait their delay)",
  active_keys: "Each active key: Google's against every key Google has published, the email issuer's against the pins; pause on a key that is neither",
  signer_policy: 'get_issuer("email") and get_self_issued("email") against the pinned signer policy (signers, required, overlap): pause on a weaker policy, warning while pins and chain move through a planned change',
  links: 'get_link_stats() (D200): a link alarm threshold reached in the current or previous hour, per scope or in all (the links went through: the contract only counts), and the current hour past half the total threshold',
  identity_on_chain:
    "No issuer key on chain (Google's and the email issuer's active keys, any pending addition) has an identity token key's thumbprint as its kid (the pins, and the keys Hana published at the last identity_jwks read): the contract must never trust an identity key (alert only)",
  governance_diff: "get_config().unrecorded_wallets outside a dev env (D139); config and governance against the last run: upgrades, owner, withdrawals, watchdogs, updater keys, delays, audiences, pause and unpause, the session floor, unrecorded_wallets, the owner DAO's code and policy, the owner's immediate issuer actions (Google and email), the link alarm thresholds and a pending raise (D200)",
  unexecuted_changes: 'Key changes past their executable time that nobody executed',
  relayer_funds: "The relayer account's available balance and each pool key's remaining allowance (session and owner pools) against their thresholds; read-only, never tops up",
  alert_delivery: 'First deliveries, 15-minute re-sends of unacknowledged critical alerts, paging-app acknowledgements',
  digest: 'Daily info digest email',
  heartbeat: "Ping the dead-man's switch",
  // Advisory: after the run is recorded and its lock released, guarded (its third-party read can't hold back anything protective).
  email_jwks: "Hana's published email JWKS against the pins and the active email keys (warning only: Hana controls it, the contract never reads it)",
  identity_jwks:
    "Hana's partner identity JWKS ({iss}/jwks.json) and discovery document against watchdog.pinnedIdentityKeys and identityToken.iss (D210): an unpinned or private key, a wrong issuer or jwks_uri, or an answer that can't be judged (redirect, oversized, not JSON, duplicate members, wrong shape, or 3 failed fetches) is critical; no pause (the chain isn't involved: partners verify these tokens, the contract never does)",
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
    description:
      "A pending key Google doesn't publish (absent from two fetches ≥ 60 s apart; not one it published with the same material within 24 h, see retired_key_change) or with other key material, an email key whose thumbprint isn't pinned for its signer (or whose kid isn't its thumbprint), or any change the updater proposed for a provider other than Google: cancelled, and the updater keys deleted when the updater proposed it",
  },
  published_key_removal: { severity: 'critical', check: 'pending_key_changes', description: 'A pending removal of a kid Google still publishes (alert only: the owner decides and cancels)' },
  unverifiable_key_change: { severity: 'critical', check: 'pending_key_changes', description: 'A pending key change the owner proposed for a provider other than Google and email: no JWKS or pins known for it (alert only)' },
  signer_policy_mismatch: {
    severity: 'critical',
    check: 'signer_policy',
    description:
      "The email issuer on chain differs from the pins in a way that isn't a planned transition: an email issuer with nothing pinned, a pre-v3 email issuer, or a weaker policy (lower required, an unpinned signer, active email keys without a policy, an overlap longer than the contract's 10 minutes), which is paused on",
  },
  pins_invalid: {
    severity: 'critical',
    check: 'config',
    description:
      "EMAIL_PINS (the manifest's watchdog.pinnedIssuerKeys.email) is unreadable: every email key is treated as unpinned (fail closed), so legitimate keys are cancelled or paused on; or IDENTITY_PINS (watchdog.pinnedIdentityKeys) is unreadable: every published identity key is treated as unpinned (`pins_invalid:identity`); or IDENTITY_PINS is set without IDENTITY_ISS, so the identity JWKS check can't run (`pins_invalid:identity_no_iss`)",
  },
  link_threshold_reached: {
    severity: 'critical',
    check: 'links',
    description:
      "Links reached an alarm threshold in the current or previous UTC hour, in one scope or in all (get_link_stats, D200). They went through: the contract counts, it refuses nothing. A partner launch, or a stolen email key taking over Google wallets by linking (alert only: the council decides whether to pause)",
  },
  unrecorded_wallets: { severity: 'critical', check: 'governance_diff', description: 'get_config().unrecorded_wallets is true on an env that is not a dev env (D139): links are refused, and it must never be true on mainnet (alert only)' },
  forged_active_key: {
    severity: 'critical',
    check: 'active_keys',
    description: "An active Google key Google never published or with other key material, or an active email key that isn't pinned (for its signer, with its thumbprint as kid): the contract is paused and every updater key deleted",
  },
  unknown_active_key_first_run: { severity: 'critical', check: 'active_keys', description: 'At the first run, an active key not in the JWKS (alert only: history the watchdog cannot judge)' },
  governance_change: {
    severity: 'critical',
    check: 'governance_diff',
    description:
      "An upgrade proposal or execution, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, pause or unpause, session floor, or a change of the owner DAO's code or policy (members, roles, vote thresholds) (alert only)",
  },
  automatic_action: { severity: 'critical', check: 'active_keys', description: 'The watchdog acted again for an incident already alerted (e.g. paused again after an unpause)' },
  protective_action_failed: { severity: 'critical', check: 'pending_key_changes', description: 'A cancel, pause or updater-key deletion the watchdog sent failed' },
  not_a_watchdog: { severity: 'critical', check: 'watchdog_role', description: "This account isn't a contract watchdog: it can't cancel or pause" },
  watchdog_key_missing: { severity: 'critical', check: 'config', description: 'WATCHDOG_KEY is missing or malformed: the watchdog can alert but not act' },
  wrong_network: { severity: 'critical', check: 'config', description: "The RPC's chain_id isn't the expected network: nothing is sent" },
  identity_key_unpinned: {
    severity: 'critical',
    check: 'identity_jwks',
    description:
      "Hana's identity JWKS publishes a key whose RFC 7638 thumbprint isn't in watchdog.pinnedIdentityKeys, that isn't a P-256 key, or that has members beyond kty, crv, x, y, kid, use, alg: partners that trust the JWKS URL accept tokens it signs, for any user of any app. Alert only, no pause: the chain isn't involved",
  },
  identity_private_key_published: {
    severity: 'critical',
    check: 'identity_jwks',
    description: "Hana's identity JWKS publishes private key material (`d` or another private member): anyone who read it can sign identity tokens with that key. Alert only, no pause",
  },
  identity_discovery_mismatch: {
    severity: 'critical',
    check: 'identity_jwks',
    description:
      "Hana's identity discovery document names another issuer than identityToken.iss, or a jwks_uri other than {iss}/jwks.json (a partner following discovery would fetch keys the watchdog doesn't check). Alert only, no pause",
  },
  identity_jwks_unreadable: {
    severity: 'critical',
    check: 'identity_jwks',
    description:
      "Hana's identity JWKS or discovery document can't be judged as published: a redirect (never followed), a body over 64 KB, not JSON, duplicate members, or the wrong shape (`:<document>:answer:<reason>`, at once), or 3 failed fetches in a row (`:<document>:sustained`). Each can hide a key from the watchdog that partners still see. Alert only, no pause",
  },
  identity_key_on_chain: {
    severity: 'critical',
    check: 'identity_on_chain',
    description:
      "An issuer key on chain (active, or a pending addition) has an identity token key's thumbprint as its kid: the contract must never trust an identity key. Alert only: the Google and email rules of the same run cancel or pause on such a key",
  },
  relayer_balance_critical: { severity: 'critical', check: 'relayer_funds', description: "The relayer account's available balance is below the critical threshold (default 1 NEAR): every relay fails when it runs out" },
  relayer_allowance_critical: { severity: 'critical', check: 'relayer_funds', description: "A relayer pool key's remaining allowance is below its critical threshold (session 0.1 NEAR, owner 0.02 NEAR by default): relays from it are about to fail" },
  relayer_pool_empty: { severity: 'critical', check: 'relayer_funds', description: 'The relayer account has no function-call key of a pool (session or owner) for the signer: every relay of that pool fails' },
  rpc_failing: { severity: 'warning', check: 'chain_read', description: 'Chain reads failed for 3 runs in a row' },
  jwks_failing: { severity: 'warning', check: 'jwks_fetch', description: "Google's JWKS fetch failed for 3 runs in a row" },
  unexecuted_key_change: { severity: 'warning', check: 'unexecuted_changes', description: 'A key change executable for more than 1 h that nobody executed' },
  stale_active_key: { severity: 'warning', check: 'active_keys', description: 'An active kid Google stopped publishing more than 3 h ago (the updater should have proposed its removal)' },
  active_key_material_unavailable: { severity: 'warning', check: 'active_keys', description: 'The contract has no get_issuer_keys: active keys are checked by kid only' },
  config_change: { severity: 'warning', check: 'governance_diff', description: 'Shared clients, sponsors or public registration changed' },
  retired_key_change: {
    severity: 'warning',
    check: 'pending_key_changes',
    description: "A pending Add by the updater of a key Google no longer publishes but published with the same material within 24 h (a race with Google's key retirement): cancelled, the updater keys kept",
  },
  confirm_failed: { severity: 'warning', check: 'pending_key_changes', description: 'A confirmation the watchdog sent failed' },
  email_jwks_mismatch: {
    severity: 'warning',
    check: 'email_jwks',
    description: "Hana's published email JWKS lists a key that isn't pinned (or whose kid isn't its thumbprint) or lacks an active email key, or it failed 3 fetches in a row while email keys are active (informational)",
  },
  identity_key_missing: {
    severity: 'warning',
    check: 'identity_jwks',
    description: "A key in watchdog.pinnedIdentityKeys isn't in Hana's identity JWKS under its thumbprint as kid: a rotation half done (pinned before it was published, or unpublished before it was unpinned), or a kid changed",
  },
  signer_policy_transition: {
    severity: 'warning',
    check: 'signer_policy',
    description: 'The email issuer and the pins are mid-way through a planned change, none of it weaker: a pinned signer not in the policy yet, the set_issuer to mark_self_issued gap, a higher required on chain, an overlap of normal length (no pause)',
  },
  link_volume_high: { severity: 'warning', check: 'links', description: "This hour's new links in all scopes reached half the total alarm threshold (get_link_stats, D200)" },
  link_stats_unavailable: {
    severity: 'warning',
    check: 'links',
    description: "get_link_stats can't be judged: `missing` (an email issuer on chain, a contract without the view: links are neither counted nor alarmed on), `malformed` (an answer of another shape) or `read_failed`. Only the link check is affected",
  },
  channel_not_configured: { severity: 'warning', check: 'config', description: 'An alert channel (paging app, Slack, email) or the heartbeat has no credentials' },
  heartbeat_failing: { severity: 'warning', check: 'heartbeat', description: "The dead-man's switch ping failed for 3 runs in a row" },
  relayer_balance_low: { severity: 'warning', check: 'relayer_funds', description: "The relayer account's available balance is below the warning threshold (default 5 NEAR)" },
  relayer_allowance_low: { severity: 'warning', check: 'relayer_funds', description: "A relayer pool key's remaining allowance is below its warning threshold (session 0.5 NEAR, owner 0.1 NEAR by default)" },
  key_change_confirmed: { severity: 'info', check: 'pending_key_changes', description: "The watchdog confirmed a key change that matches Google's JWKS" },
  key_change_executed: { severity: 'info', check: 'pending_key_changes', description: 'A key change left the queue and took effect (executed after its delay, or confirmed by another watchdog)' },
  key_change_cancelled: { severity: 'info', check: 'pending_key_changes', description: 'A key change left the queue without taking effect (cancelled by the owner or another watchdog)' },
  self_issued_key_change: { severity: 'info', check: 'pending_key_changes', description: 'A pending email key pinned for its signer, or a pending email key removal: never confirmed (self-issued keys wait governance_delay_ms), nothing called' },
  config_matured: { severity: 'info', check: 'governance_diff', description: 'A scheduled delay decrease or console-audience addition came into force' },
  first_run: { severity: 'info', check: 'active_keys', description: "First run: the current JWKS recorded as known" },
} as const satisfies Record<string, AlertKindInfo>;
export type AlertKind = keyof typeof ALERT_KINDS;
export const ALERT_KIND_IDS = Object.keys(ALERT_KINDS) as AlertKind[];

/** The id of the playbook that answers an alert kind (`@hana-id/playbooks`; null only if one is missing, which a test forbids). */
export function alertPlaybook(kind: AlertKind): string | null {
  return playbookForAlertKind(kind)?.id ?? null;
}

/** `ALERT_KINDS` with each kind's playbook id: what `GET /status` serves as `alert_kinds`. */
export const ALERT_KINDS_WITH_PLAYBOOKS = Object.fromEntries(ALERT_KIND_IDS.map((k) => [k, { ...ALERT_KINDS[k], playbook: alertPlaybook(k) }])) as {
  [K in AlertKind]: (typeof ALERT_KINDS)[K] & { playbook: string | null };
};

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
