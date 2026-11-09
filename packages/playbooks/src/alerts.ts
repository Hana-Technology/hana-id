// Playbooks for the watchdog's alert kinds (`apps/watchdog/src/checks.ts` `ALERT_KINDS`). Every kind is in exactly
// one playbook's `alertKinds`: `apps/watchdog/test/registry.test.ts` fails otherwise (D83, D126). The meaning of each
// kind is in docs/operations.md "Watchdog alerts (runbook)"; what to do is here.
import * as c from './commands.ts';
import type { Playbook } from './types.ts';

const forgedKeyChange: Playbook = {
  id: 'forged-key-change',
  title: 'Forged pending issuer key cancelled',
  kind: 'alert',
  alertKinds: ['forged_key_change'],
  severity: 'critical',
  status: 'live',
  summary:
    "A pending issuer key Google doesn't publish (or with other key material), an email key that isn't pinned for its signer, or a non-Google key the updater proposed: the watchdog cancelled it and, when the updater proposed it, deleted every updater key. A key Google published with the same material in the last 24 h is a retired-key-change instead (D153); an updater Add of a kid the watchdog never saw listed waits until its deadline first, as an unseen-key-change (D432): `details.new_kid_deadline_ms` says it was judged then.",
  signals: [
    'Critical `forged_key_change` page (paging app, Slack, email), re-sent every 15 min until acknowledged. The title and `details.outcome` say what happened: `cancelled`, `gone` (someone else cancelled it first), `executed` (it took effect before the cancel), `unknown`, `failed` or `not_sent`.',
    "`details.by` is the proposer: the signer account means `KEYS_UPDATER_KEY`; the owner means the council. `reason: updater_other_provider`: the updater proposed a key for a provider other than Google (it only serves Google).",
    "`provider: email` (only the owner can post email keys, so the council proposed it): `reason` is `not_pinned` (its thumbprint isn't in `watchdog.pinnedIssuerKeys.email`; `details.pinned: false` means nothing is pinned at all), `pins_unreadable` (the pins themselves are broken: a `pins_invalid` page names it, see watchdog-cannot-act), `bad_material` (on-chain `n`/`e` that can't be hashed), `other_signer` (pinned for another signer), `kid_not_thumbprint` or `no_signer` (the email issuer isn't self-issued). `details.thumbprint` is the key's RFC 7638 thumbprint.",
    'The API cron logs `jwks_sync_note` `unpublished_change` / `pending_mismatch` (error) while it is pending, then `issuer_key_change_cancelled`, and `jwks_tx` `send_failed` once its updater key is gone.',
  ],
  impact: [
    "Whoever proposed it holds a key that can propose issuer keys. Had the forged key gone live, its holder could mint Google tokens for any `sub` and derive any user's key in any scope.",
    "With the updater keys deleted the API cron can't propose or execute Google's rotations: Google's next kid waits until a fresh updater key is in (logins signed with it get `503 issuer_key_pending`).",
  ],
  steps: [
    {
      title: 'Read what happened',
      who: 'a founder',
      detail:
        "Acknowledge the page (it stops only the re-sends). Read `details.outcome` and `details.by` in the watchdog's alert history. `executed`: the key is active and the same run paused the contract: go to forged-active-key now. `failed`, `not_sent` or `unknown`: the change may still be pending: step 2 at once.",
      commands: [c.watchdogAlerts, c.watchdogActions],
    },
    {
      title: 'Cancel the change if it is still pending',
      who: 'council (2 of 3)',
      detail:
        "If `keyChanges` still lists it, the owner cancels it before its `executableAtMs` (the watchdog normally has; the owner may cancel any pending key change).",
      commands: [c.apiGovernance, c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: "Delete the updater keys if the watchdog didn't",
      who: 'council (2 of 3)',
      detail:
        'When the signer account proposed it, every key in `updater_keys` must go (the watchdog deletes them itself; `protective_action_failed` says when it could not). `governance:status` lists the signer keys.',
      commands: [c.governanceStatus, c.ownerCall('delete_updater_key', '{"public_key":"<ed25519:…>"}')],
    },
    {
      title: 'Find the leak',
      who: 'a founder',
      detail:
        "Signer account as proposer: `KEYS_UPDATER_KEY` is stolen. It lives in the API Worker's secrets and `.secrets/<env>/keys-updater.json`: follow updater-key-stolen (and api-or-cloudflare-compromised if the Worker or the Cloudflare account is how it leaked). Owner as proposer: the proposal needed two council votes: follow unexpected-owner-action.",
    },
    {
      title: 'An email key that should have been pinned',
      who: 'a founder',
      detail:
        "If the council meant to post a new email key (a rotation, or the first keys of batch 6), the pins were not updated first: the watchdog's pins come from its own manifest, never from chain or Hana's JWKS. Check the thumbprint against the key the issuer was given (`details.thumbprint`), add it under its signer in `watchdog.pinnedIssuerKeys.email`, regenerate and redeploy the watchdog, then the council posts the key again (it waits `governance_delay_ms`). Never pin a thumbprint you can't trace to Hana's own key.",
      commands: [c.watchdogGen, c.watchdogDeploy],
    },
    {
      title: 'Install a fresh updater key',
      who: 'council (2 of 3)',
      detail:
        "A founder moves the old key file aside (never re-add a key that may be compromised) and runs `deploy-contract`, which generates a new key into `.secrets/<env>/keys-updater.json` and plans the owner's `add_updater_key` (a council proposal; dev envs add `--approve-with <member>`). Then a founder uploads it as `KEYS_UPDATER_KEY` from the repo root (needs `apps/api/wrangler.jsonc` for the env: `gen <env>`; the documented pipe can print a key fragment on a malformed file, security sweep OPER-5: check the file first).",
      commands: [c.moveUpdaterKeyAside, c.deployContractPlan, c.deployContract, c.uploadUpdaterKey],
    },
    {
      title: "Re-sync Google's keys",
      who: 'the API cron',
      detail:
        'The 15-min cron proposes Google kids that are neither active nor pending again (a proposal of ours that was cancelled is held 1 h). To sync at once a founder runs `post-google-keys` (it signs with the updater key only).',
      commands: [c.postGoogleKeysDry, c.postGoogleKeys],
    },
  ],
  verify: [
    "`admin <env> governance:status` shows no findings: no pending Google Add that Google's JWKS doesn't publish, exactly the tracked updater key(s) with the updater methods.",
    "`GET /v1/governance` `.updater` shows a clean last cron run, and Google's next rotation is confirmed by the watchdog (`key_change_confirmed`).",
    "The watchdog's `/status` has no open `forged_key_change` for this change.",
  ],
  followUps: [
    'Write down how the key leaked and what closed the hole; a decision in `docs/decisions.md` if a rule changed.',
    'Keep the old key file (`keys-updater.revoked-<date>.json`) only until its deletion on chain is confirmed, then delete it.',
  ],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#keys-updater-key', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D82', 'D126'],
  related: ['forged-active-key', 'updater-key-stolen', 'unexpected-owner-action'],
};

const forgedActiveKey: Playbook = {
  id: 'forged-active-key',
  title: "Forged issuer key active: contract paused",
  kind: 'alert',
  alertKinds: ['forged_active_key'],
  severity: 'critical',
  status: 'live',
  summary:
    "A key Google doesn't publish, or an email key that isn't pinned, is active on chain: the watchdog paused the contract and deleted every updater key (D126). Recover in a fixed order: remove the key, raise the session floor, a fresh updater key, unpause.",
  signals: [
    'Critical `forged_active_key` page: "Active issuer key <kid>: …; paused, N updater key(s) deleted" (an email key: "Active email issuer key <kid>: its key is not pinned; …", `details.provider: email`, `details.reason` as in forged-key-change).',
    'Every login and derive answers `503 paused`; a `governance_change` alert for `paused` follows.',
    "The watchdog's actions log has `pause` and `delete_updater_key` rows with transaction hashes.",
  ],
  impact: [
    "While the key was active, anyone holding its private key could open sessions for any user's path (and derive their keys), and post OIDC-owner tokens and client proofs for any scope.",
    'Paused: logins and derivation stop for every app until the unpause. Revocation, cancels, governance and views still work.',
    "Sessions the forged key opened derive again after an unpause, for up to 24 h (`MAX_SESSION_MS`) with any `max_uses`, unless the session floor is raised first. Keys already derived through them can't be taken back: those users' keys are exposed and must be moved (see user-key-leaked).",
  ],
  steps: [
    {
      title: 'Stay paused and acknowledge',
      who: 'a founder',
      detail:
        "Acknowledge the page. The watchdog paused and deleted every updater key, and pauses again (and deletes any updater key added) at every run while the key stays active. Don't unpause until the key is removed, the session floor raised and a fresh updater key installed, in that order.",
      commands: [c.watchdogActions],
    },
    {
      title: 'Remove the forged key',
      who: 'council (2 of 3)',
      detail: 'The owner removes the kid at once (`remove_issuer_key`, immediate; it also drops a pending change for that kid). For an email key use `"provider":"email"`: email logins continue on the other pinned key, if one is active.',
      commands: [c.ownerCall('remove_issuer_key', '{"provider":"<google | email>","kid":"<kid>"}')],
    },
    {
      title: 'Raise the session floor past the pause',
      who: 'council (2 of 3)',
      detail:
        "`set_sessions_valid_from_ms` to the block time (ms) of the `paused` event + 1: the `pause` row in the watchdog's `GET /actions` has its transaction hash. Every session opened before the pause is then gone (`No such session`): users log in again. It can only be raised and never past the current block time.",
      commands: [c.watchdogActions, c.ownerCall('set_sessions_valid_from_ms', '{"sessions_valid_from_ms":<pause block time ms + 1>}')],
    },
    {
      title: 'Install a fresh updater key',
      who: 'council (2 of 3)',
      detail:
        "Only after the key is removed (an updater key added while the forged key is still active is deleted again by the watchdog). A founder moves the key file aside and runs `deploy-contract` (generates a new key, plans the owner's `add_updater_key` as a council proposal), then uploads it as `KEYS_UPDATER_KEY` (needs `apps/api/wrangler.jsonc` for the env).",
      commands: [c.moveUpdaterKeyAside, c.deployContractPlan, c.deployContract, c.uploadUpdaterKey],
    },
    {
      title: 'Unpause',
      who: 'council (2 of 3)',
      detail:
        "At once, no delay (D82). The unpause gives every pending scope change a full `change_delay_ms` again (`changes_unlock_floor_ms`), so OIDC owners can cancel changes the forged key's tokens proposed.",
      commands: [c.ownerCall('unpause')],
    },
    {
      title: 'Review scope changes made with forged tokens',
      who: 'scope owners',
      detail:
        "Hana lists every `change_proposed` event since the forged key's `issuer_key_set` and tells each scope's owners; they cancel the ones they didn't make (`cancel_change`, through `POST /v1/owner-actions` or directly on chain). Hana can't cancel scope changes. Changes that already executed, and immediate actions by forged owner tokens (`remove_client`, `disable_shared_login`), are reverted by the scope's owners.",
    },
    {
      title: 'Find how the key got there',
      who: 'a founder',
      detail:
        "A delay that ran out while the watchdog was down (watchdog-down), an owner post (unexpected-owner-action), or an upgrade. An email key: the council posted it and the pins didn't list it, or an upgrade's migrate installed it; if it is Hana's own key that was never pinned, fix the pins (`watchdog.pinnedIssuerKeys.email`, then redeploy the watchdog) before the unpause, or the next run pauses again. Fix that path before closing.",
    },
  ],
  verify: [
    '`admin <env> governance:status`: no findings (no active Google key Google doesn\'t publish, not paused, the updater key tracked); the watchdog\'s `/status` `email` shows every active email kid pinned.',
    '`GET /v1/governance` shows `paused: false`; logins resume within 10 s (the API caches the pause state 10 s while paused).',
    "The watchdog's `forged_active_key` alert resolves at its next run and it doesn't pause again.",
    '`get_config().sessions_valid_from_ms` is past the pause.',
  ],
  followUps: [
    "Tell partners (their security contacts) what happened and which window their users' sessions were exposed in.",
    'Users who derived during the window: treat their keys as exposed (user-key-leaked).',
    'Post-mortem: how the forged key reached the active set; record any rule change in `docs/decisions.md`.',
  ],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#pause', 'docs/contract-interface.md#pause', 'docs/email-login-spec.md#watchdog-appswatchdog', 'D82', 'D126', 'D190'],
  related: ['contract-paused', 'updater-key-stolen', 'watchdog-down', 'unexpected-owner-action', 'user-key-leaked', 'email-issuer-key-compromised'],
};

const publishedKeyRemoval: Playbook = {
  id: 'published-key-removal',
  title: 'Pending removal of a key Google still publishes',
  kind: 'alert',
  alertKinds: ['published_key_removal'],
  severity: 'critical',
  status: 'live',
  summary: 'Someone proposed removing an issuer kid Google still publishes. The watchdog only alerts (D82): the owner decides and cancels.',
  signals: ['Critical `published_key_removal` page: "Pending removal of <kid>, which Google still publishes".', 'The API cron logs `jwks_sync_note` `removal_of_published_kid`.'],
  impact: [
    'If it executes, logins with tokens signed by that kid fail until the updater re-proposes it and it waits out the issuer-key delay. It can never remove the last key.',
    "A removal the updater (the signer account) proposed means `KEYS_UPDATER_KEY` is stolen (the API cron only proposes removals of kids missing from every fetch of Google's JWKS for ≥ 24 h that signed no token in the last 24 h, D422).",
  ],
  steps: [
    {
      title: 'Check who proposed it and whether it is intended',
      who: 'a founder',
      detail: "Read `details.by` and the change id. Check Google's JWKS still lists the kid (`keyChanges` shows the verdict). An intended removal is rare: ask the council.",
      commands: [c.apiGovernance, c.ownerProposals],
    },
    {
      title: 'Cancel it',
      who: 'council (2 of 3)',
      detail: 'Unless intended, the owner cancels it before its `executableAtMs`.',
      commands: [c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: 'Treat the proposer as compromised',
      who: 'a founder',
      detail: "Signer account as proposer: follow updater-key-stolen (the watchdog doesn't delete updater keys for a removal). Owner as proposer: unexpected-owner-action.",
    },
  ],
  verify: ['The change is gone from `keyChanges`; the watchdog resolves the alert at its next run.', '`admin <env> governance:status`: no findings.'],
  followUps: ['If it executed anyway: re-propose the kid (`post-google-keys <env>`) and expect `issuer_key_pending` for that kid until it is active again.'],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#google-signing-keys-jwks', 'D82'],
  related: ['updater-key-stolen', 'unexpected-owner-action'],
};

const unverifiableKeyChange: Playbook = {
  id: 'unverifiable-key-change',
  title: 'Pending key change for an issuer the watchdog cannot check',
  kind: 'alert',
  alertKinds: ['unverifiable_key_change'],
  severity: 'critical',
  status: 'live',
  summary: 'The owner proposed a key change for an issuer other than Google and email: the watchdog has neither a JWKS nor pins for it and only alerts.',
  signals: ['Critical `unverifiable_key_change` page: "Pending <op> of <provider> key <kid>: no JWKS known for <provider> (alert only)".'],
  impact: [
    "A key for another issuer, once active, lets its holder mint that issuer's tokens: every scope with a client of that issuer is exposed. Only the owner can propose one (an updater proposal for another provider is a `forged_key_change`), so it needed two council votes.",
  ],
  steps: [
    {
      title: 'Check it with the whole council',
      who: 'a founder',
      detail: "Ask every council member whether they proposed it; compare the key with the issuer's published keys by hand.",
      commands: [c.ownerProposals, c.apiGovernance],
    },
    {
      title: 'Cancel anything unexpected',
      who: 'council (2 of 3)',
      detail: 'Before its executable time.',
      commands: [c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    { title: 'If nobody proposed it', who: 'a founder', detail: 'Two council keys were used: follow unexpected-owner-action.' },
  ],
  verify: ['The change is gone from `keyChanges` (or verified and intended); the alert resolves at the next run.'],
  followUps: ['Email keys are judged against the pins instead (forged-key-change, self-issued-key-change). Another new issuer added on purpose needs its own watchdog rules first.'],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'D82'],
  related: ['unexpected-owner-action', 'email-issuer-key-compromised'],
};

const unknownActiveKeyFirstRun: Playbook = {
  id: 'unknown-active-key-first-run',
  title: "First run: an active key not in Google's JWKS",
  kind: 'alert',
  alertKinds: ['unknown_active_key_first_run'],
  severity: 'critical',
  status: 'live',
  summary: "At its first run (empty D1) the watchdog found an active kid that Google doesn't publish today, or with other key material. It records it and doesn't pause.",
  signals: ['Critical `unknown_active_key_first_run` page, right after a watchdog deploy (or after its D1 was emptied).', '`details.reason`: `not_in_jwks` (often an old kid Google dropped) or `other_key_material`.'],
  impact: [
    "`not_in_jwks`: usually harmless history, but the watchdog can't tell a dropped Google kid from a forged one. `other_key_material`: a present forgery: the next run pauses unless the owner removes it.",
  ],
  steps: [
    {
      title: "Check the kid against Google's history",
      who: 'a founder',
      detail: "Compare the kid and its `n`/`e` with what the API recorded (`admin <env> issuer-keys:lead-times --remote` lists every kid it has seen) and with Google's JWKS.",
      commands: ['corepack pnpm --filter @hana-id/scripts run admin <env> issuer-keys:lead-times --remote', c.apiGovernance],
    },
    {
      title: "Remove it if it isn't Google's",
      who: 'council (2 of 3)',
      detail: "Immediate. Check `issuers` first: the owner may remove an issuer's last key (that stops every login, DoS only).",
      commands: [c.ownerCall('remove_issuer_key', '{"provider":"google","kid":"<kid>"}')],
    },
    {
      title: 'A forgery: treat it as an active forged key',
      who: 'a founder',
      detail: 'With other key material, or if it was never Google\'s: follow forged-active-key from its step 2 (the session floor) as well, since sessions it opened may still derive.',
    },
    {
      title: 'An unexpected first run',
      who: 'a founder',
      detail: 'A first run on a watchdog that ran before means its D1 was emptied or replaced: follow watchdog-compromised.',
    },
  ],
  verify: ['`admin <env> governance:status`: no active Google key that Google\'s JWKS doesn\'t publish.', 'The next watchdog runs raise no `forged_active_key`.'],
  followUps: [],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#setting-it-up-once-per-env', 'apps/watchdog/README.md#what-a-run-does-every-5-min'],
  related: ['forged-active-key', 'watchdog-first-run', 'watchdog-compromised'],
};

const governanceChange: Playbook = {
  id: 'governance-change',
  title: 'Governance change',
  kind: 'alert',
  alertKinds: ['governance_change'],
  severity: 'critical',
  status: 'live',
  summary:
    "An upgrade, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, a pause or unpause, a raised session floor, the owner DAO's code or policy, or the owner's immediate issuer actions. Alert only: confirm the council meant it.",
  signals: [
    'Critical `governance_change` page with one line per change (`field: before -> after`, lists as removed / added).',
    'Fields: `pending_upgrade`, `owner`, `pending_owner`, `pending_withdrawal`, `watchdogs`, `updater_keys`, the delays, `console_audiences`, `paused`, `unpaused_at_ms`, `sessions_valid_from_ms`, `owner_code_hash`, `owner_policy`, `issuer`, `issuer_keys`, `email_issuer`, `email_issuer_keys`, `email_signer_policy`, `unrecorded_wallets`, `mpc`, `ckd_domain_id`, `state_version`.',
  ],
  impact: [
    'Every owner action on `hana-signer` needs two council votes, so an unexpected one means two council keys acted. Upgrades, owner transfers and withdrawals wait `governance_delay_ms` (72 h on mainnet): that is the window to cancel and to warn partners.',
    'A changed `mpc` or `ckd_domain_id` (only possible through an upgrade) changes every user\'s address.',
  ],
  steps: [
    {
      title: 'Match each line with a council action',
      who: 'a founder',
      detail:
        "Find the council proposal that made it (`owner:proposals`, its votes) and ask the members who voted. Expected changes (a drill, a member change, a planned upgrade): acknowledge. A `paused` change: follow contract-paused. An `owner_policy` change during a planned member change: council-member-key.",
      commands: [c.ownerProposals, c.governanceStatus],
    },
    {
      title: 'Undo what nobody meant',
      who: 'council (2 of 3)',
      detail:
        "`cancel_upgrade`, `cancel_owner_proposal`, `cancel_withdrawal`, a delay change back (increases apply at once), `remove_watchdog` / `add_watchdog`, `delete_updater_key`. Nobody but the owner can cancel an upgrade (D84). Then follow unexpected-owner-action: treat the council as compromised.",
      commands: [c.ownerCall('cancel_upgrade'), c.ownerCall('cancel_owner_proposal'), c.ownerCall('cancel_withdrawal')],
    },
    {
      title: 'A removed Google kid Google still publishes',
      who: 'a founder',
      detail: '`issuer_keys` lost a kid without a queued removal (`remove_issuer_key`): logins signed with it break until the updater re-proposes it and it waits the issuer-key delay.',
      commands: [c.postGoogleKeysDry, c.postGoogleKeys],
    },
    {
      title: 'A DAO policy that is no longer 2 of 3',
      who: 'a founder',
      detail:
        "`owner_policy` or `owner_code_hash` changed: `deploy-contract` now blocks on every run and `governance:status` reports it. Unless it was a planned member change, the council itself was reshaped: follow unexpected-owner-action.",
      commands: [c.deployContractPlan, c.governanceStatus],
    },
  ],
  verify: ['`admin <env> governance:status`: no findings, nothing pending that nobody proposed.', 'Every line of the alert is matched to a council proposal or reverted.'],
  followUps: ['Upgrades on mainnet: the reproducible build hash, commit and command are published before the proposal (D86): check the pending hash against it.'],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#owner-actions-through-the-council', 'docs/contract-interface.md#monitoring-hand-off-batch-c-admin-portal', 'D84', 'D85', 'D86'],
  related: ['unexpected-owner-action', 'contract-paused', 'council-member-key'],
};

const watchdogActedAgain: Playbook = {
  id: 'watchdog-acted-again',
  title: 'The watchdog acted again for an open incident',
  kind: 'alert',
  alertKinds: ['automatic_action'],
  severity: 'critical',
  status: 'live',
  summary: 'The watchdog repeated a protective action for an incident it already alerted: the incident is not over.',
  signals: [
    'Critical `automatic_action` page: "Paused again: active key <kid>", "Automatic action for active key <kid>: delete_updater_key", or "Automatic action for forged change <id>: …".',
  ],
  impact: [
    'A forged key is still active (the contract was unpaused, or a new updater key was added, before the key was removed), or the same forged change is still being acted on.',
  ],
  steps: [
    {
      title: 'Find the incident',
      who: 'a founder',
      detail: "The title names the kid or change. Open the original `forged_active_key` or `forged_key_change` alert and its actions.",
      commands: [c.watchdogAlerts, c.watchdogActions],
    },
    {
      title: 'Recover in order',
      who: 'council (2 of 3)',
      detail: 'Active key: follow forged-active-key in its order (remove the key, raise the session floor, a fresh updater key, unpause). Unpausing or adding an updater key first only makes the watchdog undo it.',
    },
  ],
  verify: ['No new `automatic_action` at the next runs; the original alert resolves.'],
  followUps: [],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'D126'],
  related: ['forged-active-key', 'forged-key-change'],
};

const protectiveActionFailed: Playbook = {
  id: 'protective-action-failed',
  title: "A cancel, pause or updater-key deletion the watchdog sent failed",
  kind: 'alert',
  alertKinds: ['protective_action_failed'],
  severity: 'critical',
  status: 'live',
  summary: 'The watchdog tried to protect the contract and the transaction failed, or a forged change it tried to cancel had already executed.',
  signals: [
    'Critical `protective_action_failed` page: "Deleting updater key <pk> failed", "Pausing for active key <kid> failed", or a cancel outcome (`executed`, `unknown`, `failed`).',
    "The watchdog's actions log has the failed row with its error.",
  ],
  impact: ['The forged key change may still execute, the forged active key may still be live, or a stolen updater key may still be installed: the protection the watchdog exists for is missing.'],
  steps: [
    {
      title: 'Do it through the owner at once',
      who: 'council (2 of 3)',
      detail: 'Whichever failed: cancel the change, pause, delete the updater key. `executed`: the key is active: follow forged-active-key (the same run should have paused; pause by hand if not).',
      commands: [
        c.ownerCall('cancel_issuer_key_change', '{"id":<id>}'),
        c.ownerCall('pause'),
        c.ownerCall('delete_updater_key', '{"public_key":"<ed25519:…>"}'),
      ],
    },
    {
      title: "Fix the watchdog's ability to act",
      who: 'a founder',
      detail: "Read the error in `GET /actions`. Usual causes: `WATCHDOG_KEY`'s 1 NEAR allowance is spent, the RPC failed, the account is no longer a watchdog. Follow watchdog-cannot-act.",
      commands: [c.watchdogActions, c.watchdogStatus],
    },
  ],
  verify: ['`admin <env> governance:status`: the change gone, the contract paused if a forged key is active, no untracked signer keys.', 'The alert resolves at the next run.'],
  followUps: [],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'apps/watchdog/README.md#what-a-run-does-every-5-min'],
  related: ['forged-active-key', 'forged-key-change', 'watchdog-cannot-act'],
};

const watchdogCannotAct: Playbook = {
  id: 'watchdog-cannot-act',
  title: "The watchdog can't act",
  kind: 'alert',
  alertKinds: ['not_a_watchdog', 'watchdog_key_missing', 'wrong_network', 'pins_invalid'],
  severity: 'critical',
  status: 'live',
  summary:
    "Its account isn't a contract watchdog, its key is missing or malformed, or its RPC is on another chain: it can alert at most, never cancel or pause. Or its email pins are unreadable: it then cancels or pauses on every email key (fail closed).",
  signals: [
    'Critical `not_a_watchdog`, `watchdog_key_missing`, `wrong_network` or `pins_invalid` (condition alerts: open until a run no longer sees them).',
    '`/status` `last_run.checks`: `watchdog_role` or `config` not ok. With `pins_invalid`, email key alerts carry `reason: pins_unreadable`.',
  ],
  impact: ["Until fixed nothing cancels a forged pending key or pauses on a forged active one; with `wrong_network` nothing is sent at all. Google's rotations also wait their full delay (no confirmations)."],
  steps: [
    {
      title: 'Watch the queue by hand meanwhile',
      who: 'a founder',
      detail: "Check pending key changes at least hourly; any pending Add Google doesn't publish (`jwks: absent` / `mismatch`): the council cancels it.",
      commands: [c.apiGovernance, c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: '`not_a_watchdog`: add it again',
      who: 'council (2 of 3)',
      detail:
        "`deploy-contract` plans `add_watchdog` for every manifest `watchdogs` account that exists (a council proposal). Cancel and pause powers start at once, confirm power after `governance_delay_ms`. A removal nobody planned also raised a `governance_change`: follow unexpected-owner-action.",
      commands: [c.deployContractPlan, c.deployContract],
    },
    {
      title: '`watchdog_key_missing`: restore the key',
      who: 'a founder',
      detail:
        "`secrets <env> check` names what is missing. If `WATCHDOG_KEY` is in the file, upload the file again; if it was lost, `init` creates a new one and prints the near CLI command that adds it to `watchdog.account` (run it), then upload. Delete a lost key on chain once the new one works.",
      commands: [c.watchdogSecretsCheck, c.watchdogSecretsInit, c.watchdogSecretBulk],
    },
    {
      title: '`wrong_network`: fix the RPC',
      who: 'a founder',
      detail: 'The manifest `rpc` (or `rpcFallback`) answers another `chain_id`. Fix `envs/<env>.json` (code-owner review), regenerate the watchdog config and redeploy it, logged in to the watchdog\'s Cloudflare account.',
      commands: [c.watchdogGen, c.watchdogDeploy],
    },
    {
      title: '`pins_invalid`: regenerate the pins',
      who: 'a founder',
      detail:
        "`EMAIL_PINS` doesn't parse, so no email key counts as pinned: pending email keys are cancelled and an active one pauses (D190). `gen` writes it from `watchdog.pinnedIssuerKeys.email`, which the schema validates: a broken value was set by hand or by a broken deploy. Regenerate and redeploy; if the watchdog paused on Hana's own keys meanwhile, the council unpauses once the next run is clean, and re-posts any email key it cancelled.",
      commands: [c.watchdogGen, c.watchdogDeploy, c.watchdogStatus],
    },
  ],
  verify: ['`/status` `last_run.outcome: "ok"` with every check ok; the condition alert resolves.'],
  followUps: [],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#setting-it-up-once-per-env', 'docs/contract-interface.md#watchdogs'],
  related: ['watchdog-down', 'watchdog-compromised', 'protective-action-failed'],
};

const watchdogDegraded: Playbook = {
  id: 'watchdog-degraded',
  title: 'The watchdog is partly blind or mute',
  kind: 'alert',
  alertKinds: ['rpc_failing', 'jwks_failing', 'heartbeat_failing', 'channel_not_configured'],
  severity: 'warning',
  status: 'live',
  summary: "Chain reads or Google's JWKS fetch failed 3 runs in a row, the dead-man's switch ping fails, or an alert channel has no credentials.",
  signals: ['Warning `rpc_failing`, `jwks_failing`, `heartbeat_failing` or `channel_not_configured` (Slack and email).', 'sandbox-dev reports `channel_not_configured` on every run until its channels and the heartbeat are set (`docs/operations.md` "Watchdog service").'],
  impact: [
    "`rpc_failing`: no checks or actions while it lasts. `jwks_failing`: no confirmations (rotations wait their full delay) and no forgery verdicts (a missing kid needs two successful fetches). `heartbeat_failing`: the dead-man's switch will page as if the watchdog were dead. `channel_not_configured`: one alert path fewer (D85 relies on three).",
  ],
  steps: [
    {
      title: 'RPC',
      who: 'a founder',
      detail: 'Both `rpc` and `rpcFallback` failed. A provider outage: follow near-rpc-outage (the watchdog reads its RPC from the manifest: `gen` and redeploy after a change).',
      commands: [c.watchdogStatus],
    },
    {
      title: "Google's JWKS",
      who: 'a founder',
      detail: 'A Google-side outage or a network block on the watchdog: follow google-jwks-outage.',
    },
    {
      title: 'Heartbeat or a channel',
      who: 'a founder',
      detail: "`secrets <env> check` names the missing credentials; paste them into `.secrets/<env>/watchdog-secrets.json` (never print them) and upload the file. A heartbeat provider outage needs nothing here.",
      commands: [c.watchdogSecretsCheck, c.watchdogSecretBulk],
    },
  ],
  verify: ['The condition alert resolves at the next run; `/status` shows every channel `configured` and `heartbeat.ok`.'],
  followUps: ['A dead watchdog is caught by the dead-man\'s switch, not by these alerts: see watchdog-down.'],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'apps/watchdog/README.md#alerts-d85'],
  related: ['near-rpc-outage', 'google-jwks-outage', 'watchdog-down'],
};

const retiredKeyChange: Playbook = {
  id: 'retired-key-change',
  title: 'Retired Google key proposed and cancelled',
  kind: 'alert',
  alertKinds: ['retired_key_change'],
  severity: 'warning',
  status: 'live',
  summary:
    "The updater proposed a key Google stopped publishing but did publish, with the same key material, within the last 24 h, and it is provably retired: known for over 7 days, unlisted for over 6 h, missed by 3+ fetches in a row over 30+ min (D153, D422). The API cron's fetch raced Google's retirement of the kid. The watchdog cancelled it and kept the updater keys. A kid that doesn't meet all three (a new key mid-rollout) is left pending, not cancelled.",
  signals: [
    'Warning `retired_key_change` (Slack, email): "Retired Google key <kid> proposed (change <id>): Google stopped publishing it after <time>; cancelled, updater key kept".',
    "`details.last_seen_jwks_at` is the watchdog's last fetch that listed the kid; `details.outcome` is `cancelled`, `gone`, `failed` (retried next run) or `not_sent`.",
  ],
  impact: ["None for logins: the key was Google's own, and the kid is retired. The API cron holds a re-proposal of a cancelled kid for 1 h and proposes only kids Google lists."],
  steps: [
    {
      title: 'Check it was a retirement',
      who: 'a founder',
      detail:
        "Google's JWKS no longer lists the kid, and `details.n` matches what the watchdog recorded for it (`/status` `seen_kids`). Repeats for the same kid more than an hour apart, or any `forged_key_change`, are not a race: see forged-key-change. Before D422 a new key mid-rollout could land here repeatedly (sandbox-dev, 2026-11-04/05): that no longer happens.",
      commands: [c.watchdogAlerts, c.apiGovernance],
    },
  ],
  verify: ['`keyChanges` no longer lists the change; `issuers` matches Google\'s JWKS.'],
  followUps: [],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'D153'],
  related: ['forged-key-change', 'key-sync-stalled', 'unseen-key-change'],
};

const unseenKeyChange: Playbook = {
  id: 'unseen-key-change',
  title: 'New Google key the watchdog has not seen yet',
  kind: 'alert',
  alertKinds: ['unseen_key_change'],
  severity: 'warning',
  status: 'live',
  summary:
    "The updater proposed a Google kid that no fetch of the watchdog has ever listed (D432). Usually Google's new key mid-rollout: the API cron's fetch reached an edge that already serves it. The watchdog leaves it pending until its deadline (6 h after the proposal at most, and at least 18 min before it is executable): confirmed as soon as one of its fetches lists it with the same material, otherwise cancelled as forged and the updater keys deleted.",
  signals: [
    'Warning `unseen_key_change` (Slack, email): "New Google key <kid> proposed by the updater (change <id>) isn\'t in Google\'s JWKS as the watchdog fetches it: cancelled as forged, and the updater keys deleted, at <time> unless a fetch lists it".',
    "`details.new_kid_deadline_ms` is the deadline; `details.n`/`details.e` the proposed key material; `details.absent_since` and `details.absent_fetches` the watchdog's misses so far.",
    'It ends one of two ways: info `key_change_confirmed` (a fetch listed the kid with the same material), or critical `forged_key_change` with `details.new_kid_deadline_ms` (the deadline passed, or the same run found the updater forging another change: `grace_ended: updater_forged`).',
  ],
  impact: [
    "None while it waits: the key isn't active, and the contract only accepts it after its delay. If it is Google's, logins signed with it get `503 issuer_key_pending` until it is confirmed or executed (as for any new Google key).",
    'If it is a forgery, the updater key is stolen and keeps working until the deadline (it can propose more keys, which wait the same way, and removals, which page `published-key-removal`).',
  ],
  steps: [
    {
      title: "Check whether Google publishes it",
      who: 'a founder',
      detail:
        "Fetch Google's JWKS (https://www.googleapis.com/oauth2/v3/certs) a few times, from more than one network if you can: during a rotation its edges serve different key sets. If one of them lists the kid with `n` and `e` equal to `details.n`/`details.e`, it is Google's key: nothing to do, the watchdog confirms it once its own fetch lists it (or the API cron executes it after the delay).",
      commands: [c.watchdogStatus, c.apiGovernance],
    },
    {
      title: 'Not listed anywhere, or listed with other material',
      who: 'a founder',
      detail:
        "Treat it as forged now rather than waiting for the deadline: go to forged-key-change and updater-key-stolen. Other key material for the same kid is forged for certain (the watchdog cancels it at its next fetch that lists the kid). Not listed anywhere 1 h after the proposal is very unlikely for a real rotation.",
    },
    {
      title: 'Cancel early if it is forged',
      who: 'council (2 of 3)',
      detail:
        'The owner cancels the change and deletes every updater key before the deadline when a founder judged it forged (the watchdog does both at the deadline, and at once if it sees the updater forge anything else). Never cancel it on a hunch alone: the updater keys of a real rotation are then gone too.',
      commands: [c.ownerCall('cancel_issuer_key_change', '{"id":<id>}'), c.ownerCall('delete_updater_key', '{"public_key":"<ed25519:…>"}')],
    },
  ],
  verify: ["`keyChanges` no longer lists the change: it was confirmed (`issuers` lists the kid and Google's JWKS has it) or cancelled (`forged_key_change`)."],
  followUps: ["Repeated warnings that end in a confirmation mean the watchdog's fetches lag the API cron's edges: note the lag (proposal to confirmation) for the issuer-key delay's review (D432)."],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'D432'],
  related: ['forged-key-change', 'updater-key-stolen', 'retired-key-change'],
};

const keySyncStalled: Playbook = {
  id: 'key-sync-stalled',
  title: 'Google key sync stalled',
  kind: 'alert',
  alertKinds: ['unexecuted_key_change', 'stale_active_key'],
  severity: 'warning',
  status: 'live',
  summary: 'A matured key change nobody executed for over 1 h, or an active kid Google dropped more than 27 h ago that nobody proposed to remove (the cron removes after 24 h missing, D422).',
  signals: ['Warning `unexecuted_key_change` or `stale_active_key`.', 'API cron logs: `jwks_sync_skipped`, `jwks_tx` `send_failed`, `jwks_sync_note` `last_key_kept` / `queue_full`.'],
  impact: ["Google's new key isn't active (its tokens get `503 issuer_key_pending`), or a key Google retired stays active longer than needed."],
  steps: [
    {
      title: 'Check the API cron',
      who: 'a founder',
      detail: 'It executes due changes and proposes removals every 15 min. A missing or deleted `KEYS_UPDATER_KEY` stops it (`jwks_sync_skipped`, `send_failed`): see the Keys-updater key runbook.',
      commands: [c.apiGovernanceUpdater, c.apiTailErrors],
    },
    {
      title: 'Execute the due change now',
      who: 'anyone',
      detail: 'Any funded account may execute a matured change (the contract checks the delay); `post-google-keys --execute` does it with the updater key, additions first, and never executes a change Google disagrees with.',
      commands: [c.executeIssuerKeyChange, c.postGoogleKeysExecute],
    },
    {
      title: 'Propose the stale removal',
      who: 'the API cron',
      detail: 'The cron proposes removing a kid missing from every fetch for ≥ 24 h (never one that signed a token in the last 24 h, never the last key; D422); a founder can run the same sync at once.',
      commands: [c.postGoogleKeys],
    },
  ],
  verify: ['`keyChanges` empty or not yet due; `issuers` matches Google\'s JWKS; the warning resolves.'],
  followUps: [],
  refs: ['docs/operations.md#google-signing-keys-jwks', 'docs/operations.md#common-failures'],
  related: ['google-jwks-outage', 'updater-key-stolen'],
};

const activeKeyMaterialUnavailable: Playbook = {
  id: 'active-key-material-unavailable',
  title: 'Active keys checked by kid only',
  kind: 'alert',
  alertKinds: ['active_key_material_unavailable'],
  severity: 'warning',
  status: 'live',
  summary: "The contract has no `get_issuer_keys` (code older than the watchdog): a forged key under a kid Google really publishes isn't caught once active.",
  signals: ['Warning `active_key_material_unavailable` every run.'],
  impact: ["The active-key check compares kids only; a key that went live with Google's kid but other material (while the watchdog was down, or through an upgrade) isn't paused on."],
  steps: [
    {
      title: 'Upgrade the contract to current code',
      who: 'council (2 of 3)',
      detail: '`deploy-contract --upgrade` builds and proposes the hash through the council; after `governance_delay_ms` the same command with `--skip-build` executes it (anyone may execute). No address change.',
      commands: [c.upgradePropose, c.upgradeExecute],
    },
  ],
  verify: ['The warning stops; `/status` `active_keys` check ok.'],
  followUps: [],
  refs: ['docs/operations.md#upgrading-the-governance-contract', 'docs/contract-interface.md#issuers'],
};

const configChange: Playbook = {
  id: 'config-change',
  title: 'Shared clients, sponsors or public registration changed',
  kind: 'alert',
  alertKinds: ['config_change'],
  severity: 'warning',
  status: 'live',
  summary: 'An owner config change the watchdog reports as a warning: the shared-client list, the sponsors, or public registration.',
  signals: ['Warning `config_change` with one line per field (`shared_clients`, `sponsors`, `public_registration`).'],
  impact: [
    "A shared client added by someone else would let that client's tokens open sessions in every `allow_shared` scope once in force; a removed one stops shared logins. Sponsors decide who may pay registrations with function-call keys.",
  ],
  steps: [
    {
      title: 'Match it with a council action',
      who: 'a founder',
      detail: 'Every one of these needed two council votes.',
      commands: [c.ownerProposals],
    },
    {
      title: 'Revert what nobody meant',
      who: 'council (2 of 3)',
      detail:
        "`deploy-contract` plans `set_shared_clients` and `set_sponsors` back to the manifest (shared-client removals apply at once, additions wait `change_delay_ms`). `enable_public_registration` can't be undone (one way; only an upgrade could). Then follow unexpected-owner-action.",
      commands: [c.deployContractPlan, c.deployContract],
    },
  ],
  verify: ['`get_config()` (`governance:status --json` `config`) matches the manifest.'],
  followUps: [],
  refs: ['docs/contract-interface.md#shared-clients', 'D86'],
  related: ['unexpected-owner-action', 'shared-google-client-compromised'],
};

const confirmFailed: Playbook = {
  id: 'confirm-failed',
  title: "The watchdog's confirmation of a Google key failed",
  kind: 'alert',
  alertKinds: ['confirm_failed'],
  severity: 'warning',
  status: 'live',
  summary: "A confirmation of a key change that matches Google's JWKS failed: the key still goes live, but only after the full issuer-key delay.",
  signals: ['Warning `confirm_failed` with the change and the error.', 'Logins with the new kid get `503 issuer_key_pending` meanwhile.'],
  impact: ["Users whose token is signed with Google's new kid can't log in until the change executes (the vault tells them to try again in a few minutes)."],
  steps: [
    {
      title: 'Read the error',
      who: 'a founder',
      detail: "Usual causes: the watchdog's confirm power hasn't started (`confirm_from_ms`, `governance_delay_ms` after `add_watchdog`), `WATCHDOG_KEY`'s allowance is spent, an RPC failure, or the change already left the queue.",
      commands: [c.watchdogActions, c.apiGovernance],
    },
    {
      title: "Restore the watchdog key's allowance",
      who: 'a founder',
      detail: 'An allowance spent: rotate `WATCHDOG_KEY` (watchdog-compromised step "Rotate WATCHDOG_KEY") with a fresh 1 NEAR key.',
    },
    {
      title: 'Let it mature',
      who: 'the API cron',
      detail: 'The cron executes it at `executableAtMs`; anyone may execute it then.',
      commands: [c.executeIssuerKeyChange],
    },
  ],
  verify: ['The kid is in `issuers`; the next confirmation succeeds (`key_change_confirmed`).'],
  followUps: [],
  refs: ['docs/operations.md#google-signing-keys-jwks', 'docs/contract-interface.md#watchdogs'],
  related: ['google-jwks-outage', 'watchdog-cannot-act'],
};

const keyChangeLifecycle: Playbook = {
  id: 'key-change-lifecycle',
  title: 'Key change confirmed, executed or cancelled (info)',
  kind: 'alert',
  alertKinds: ['key_change_confirmed', 'key_change_executed', 'key_change_cancelled'],
  severity: 'info',
  status: 'live',
  summary: 'Routine: Google rotations confirmed by the watchdog, changes that took effect, and changes that left the queue without effect.',
  signals: ['Info alerts in `/status`, the portal and the daily digest.'],
  impact: ['None for confirmations and executions that match Google.'],
  steps: [
    {
      title: 'Check unexpected cancellations',
      who: 'a founder',
      detail:
        "A `key_change_cancelled` that the watchdog didn't make (no `forged_key_change`) was the owner or another watchdog. A cancelled genuine Google key stalls that rotation (the API cron re-proposes it after a 1 h hold); one nobody on the council made: unexpected-owner-action, or watchdog-compromised for another watchdog.",
      commands: [c.ownerProposals, c.apiGovernance],
    },
  ],
  verify: ['`issuers` matches Google\'s JWKS after a rotation.'],
  followUps: [],
  refs: ['docs/operations.md#google-signing-keys-jwks'],
  related: ['unexpected-owner-action', 'watchdog-compromised'],
};

const configMatured: Playbook = {
  id: 'config-matured',
  title: 'A scheduled config change came into force (info)',
  kind: 'alert',
  alertKinds: ['config_matured'],
  severity: 'info',
  status: 'live',
  summary: 'A delay decrease or a console-audience addition reached its effective time.',
  signals: ['Info `config_matured` (it was alerted critical as a `governance_change` when it was made).'],
  impact: ['Shorter delays shorten everyone\'s reaction window; a new console audience may sign OIDC owner actions.'],
  steps: [
    {
      title: 'Check it is still wanted',
      who: 'a founder',
      detail: 'Match it with the council proposal that scheduled it.',
      commands: [c.ownerProposals],
    },
    {
      title: 'Revert at once if not',
      who: 'council (2 of 3)',
      detail: 'A delay increase applies now; a console audience dropped from `set_console_audiences` stops counting now. Then unexpected-owner-action.',
    },
  ],
  verify: ['`get_config()` matches the manifest.'],
  followUps: [],
  refs: ['docs/contract-interface.md#delays', 'D86'],
  related: ['unexpected-owner-action'],
};

const watchdogFirstRun: Playbook = {
  id: 'watchdog-first-run',
  title: "The watchdog's first run (info)",
  kind: 'alert',
  alertKinds: ['first_run'],
  severity: 'info',
  status: 'live',
  summary: "The first run with an empty D1 recorded Google's current JWKS as known.",
  signals: ['Info `first_run`; `/status` `last_run.first_run: true`.'],
  impact: ["Expected right after a deploy. Anywhere else it means the watchdog lost its history: a forged active key present at that moment is only alerted, never paused (it is recorded as baseline)."],
  steps: [
    {
      title: 'After a deploy: finish the setup checks',
      who: 'a founder',
      detail: "`last_run.outcome: \"ok\"`, `heartbeat.ok`, every channel `configured`. Acknowledge the first-run critical alerts after checking them (unknown-active-key-first-run). A test critical page to both founders: not built yet as a command; the forced-rotation drill does it for real.",
      commands: [c.watchdogStatus],
    },
    {
      title: 'Not after a deploy: investigate',
      who: 'a founder',
      detail: "Its D1 was emptied or replaced: follow watchdog-compromised. A restore of its D1 to a minute before (Time Travel, 30 days; operations \"The watchdog's D1\") brings its history back; until then this first run's baseline stands.",
      commands: [c.watchdogD1BookmarkAt, c.watchdogD1Restore],
    },
  ],
  verify: ['The next runs report `first_run: false` and every check ok.'],
  followUps: [],
  refs: ['docs/operations.md#setting-it-up-once-per-env', 'docs/operations.md#the-watchdogs-d1'],
  related: ['unknown-active-key-first-run', 'watchdog-compromised'],
};

const relayerOutOfFunds: Playbook = {
  id: 'relayer-out-of-funds',
  title: "Relayer running out of funds (balance or a pool key's allowance)",
  kind: 'alert',
  alertKinds: ['relayer_balance_critical', 'relayer_allowance_critical', 'relayer_pool_empty', 'relayer_balance_low', 'relayer_allowance_low'],
  severity: 'critical',
  status: 'live',
  summary: "The relayer account's available balance, or a pool key's remaining allowance, is below its threshold, or a pool has no key: relays from it fail when it runs out.",
  signals: [
    "Watchdog alerts (read-only check `relayer_funds`, every 5 min): `relayer_balance_low` (warning, < 5 NEAR available by default) and `relayer_balance_critical` (< 1 NEAR, or the account doesn't exist); `relayer_allowance_low` / `relayer_allowance_critical` per pool key (session pool < 0.5 / 0.1 NEAR of its 2 NEAR, owner pool < 0.1 / 0.02 NEAR of its 0.5 NEAR); `relayer_pool_empty` (no key of a pool for the signer). Thresholds: the manifest's `watchdog.relayerFunds`.",
    '`/status` `relayer_funds`: the last reading (available balance, each pool key with its allowance, the thresholds).',
    'Once it has run out: relays failing with `502 near_rejected` for one key or all; logins and derives fail for the apps routed to those keys.',
  ],
  impact: [
    'Session pool: logins and derives fail for the apps on a used-up key (all apps when the balance is gone). Owner pool: OIDC owner actions fail. No security impact.',
    'The watchdog only alerts: it holds no key on the relayer account and never tops anything up. The alerts resolve by themselves at the first run after the refill.',
  ],
  steps: [
    {
      title: 'Read what is low',
      who: 'a founder',
      detail: "The alert's details name the account, the pool and the key (`public_key`), what is left and the thresholds; `/status` `relayer_funds` lists every pool key. A drop that the request logs (`relayInstance` per relay) don't explain: follow relayer-key-stolen. 3 keys × 2 NEAR covered ~1,500 logins on testnet; allowances drop by gas burnt.",
      commands: [c.watchdogStatus, c.apiTailErrors],
    },
    {
      title: 'Low balance: fund the relayer account',
      who: 'a founder',
      detail: 'Send NEAR to `<relayer>` from a funded testnet account (testnet only, never a mainnet account). `relayer_balance_critical` saying the account does not exist: create it again first (operations "Create an environment" step 1), then re-run `deploy-contract` for its keys.',
      commands: [c.fundRelayer],
    },
    {
      title: 'Low allowance: replace the key',
      who: 'a founder',
      detail: "Same as a leaked key: delete it on chain, remove it from its `.secrets` file, re-run `deploy-contract` (pass larger `--relayer-allowance` / `--owner-relayer-allowance` if needed, and the same flags on every later re-run), upload the pool. Delete the used-up key: left there it keeps its last allowance and its alert stays open.",
      commands: [c.deleteRelayerKey, c.deployContractPlan, c.deployContract, c.uploadRelayerKeys, c.uploadOwnerRelayerKeys],
    },
    {
      title: 'No key in a pool: add the pool again',
      who: 'a founder',
      detail: "`deploy-contract` adds every key of `.secrets/<env>/relayer-keys.json` / `owner-relayer-keys.json` that isn't on chain. Only the relayer account's full-access key can delete keys: if nobody here did, treat that key as compromised (follow api-or-cloudflare-compromised).",
      commands: [c.deployContractPlan, c.deployContract, c.uploadRelayerKeys, c.uploadOwnerRelayerKeys],
    },
    {
      title: 'Thresholds that no longer fit',
      who: 'a founder',
      detail: "After raising the allowances (or for a busier env), set `watchdog.relayerFunds` in `envs/<env>.json` (NEAR; `balance`, `sessionAllowance`, `ownerAllowance`, each `{warn, critical}` with critical below warn), then regenerate the watchdog's config and redeploy it.",
      commands: [c.watchdogGen, c.watchdogDeploy],
    },
  ],
  verify: ['The next watchdog run resolves the alert (`/status` `open_alerts` without it; `relayer_funds` above the thresholds).', 'Relays succeed; the request logs show no `near_rejected`.'],
  followUps: ['A used-up key replaced: delete its line from the secrets file only after the on-chain deletion is confirmed.'],
  refs: ['docs/operations.md#relayer-keys-either-pool', 'docs/api.md#relay-errors-any-relayed-call', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D150'],
  related: ['relayer-key-stolen', 'api-or-cloudflare-compromised'],
};

const signerPolicyMismatch: Playbook = {
  id: 'signer-policy-mismatch',
  title: 'Email signer policy differs from the pins',
  kind: 'alert',
  alertKinds: ['signer_policy_mismatch', 'signer_policy_transition'],
  severity: 'critical',
  status: 'live',
  summary:
    "The email issuer on chain (`get_issuer(\"email\")`, `get_self_issued(\"email\")`) doesn't match the watchdog's pins. Weaker (paused) or unexplained (an email issuer with nothing pinned, a pre-v3 one): critical `signer_policy_mismatch`. Mid-way through a planned change and none of it weaker: warning `signer_policy_transition`.",
  signals: [
    'Critical `signer_policy_mismatch` page: "Email signer policy differs from the pins: <differences>; <weaker, paused | alert only>". `details.pinned` and `details.chain` show both sides.',
    "Weaker (D191): `required` below the pinned one, a signer the pins don't list, active email keys without a signer policy, or an overlap with the previous policy longer than the contract's 10 minutes (a `migrate` keeping a weaker policy valid). Then every login answers `503 paused`.",
    "Warning `signer_policy_transition` (no page, no pause): a pinned signer not in the policy yet, the gap between `set_issuer(\"email\")` and `mark_self_issued(\"email\")` (batch 6's setup), a higher `required` on chain than pinned, or an overlap of normal length after a policy upgrade. It resolves once pins and chain match.",
  ],
  impact: [
    'A weaker policy lets fewer signers (or a signer nobody pinned) mint email tokens, and so derive every email wallet and every wallet linked to one. The signer list and `required` change only through a governed upgrade (`migrate`, public for `governance_delay_ms`), so a weaker one means an upgrade nobody reviewed for this, or a compromised council.',
    'Not weaker (a pinned signer not in the policy yet, a higher `required`): nothing is at risk; the pins are ahead of or behind a planned upgrade.',
  ],
  steps: [
    {
      title: 'Read both sides',
      who: 'a founder',
      detail: "Acknowledge. Compare `details.pinned` (from the watchdog's manifest) with `details.chain`. Find the council action or upgrade that changed the chain side (`owner:proposals`; a `governance_change` alert for `email_signer_policy`, `email_issuer` or `pending_upgrade` should precede it).",
      commands: [c.watchdogStatus, c.ownerProposals],
    },
    {
      title: 'Planned change: bring the pins in line',
      who: 'a founder',
      detail:
        "Level 1 (adding a co-signer): pin the new signer's keys first, with the current `required`; after the upgrade executes, raise the pinned `required` (D191). Replacing a signer: pin the new id's keys before the upgrade, drop the old id after. Edit `watchdog.pinnedIssuerKeys.email` in `envs/<env>.json`, regenerate the watchdog's config and redeploy it (the watchdog's own Cloudflare account). If it paused for a planned change, the council unpauses only after the pins match.",
      commands: [c.watchdogGen, c.watchdogDeploy],
    },
    {
      title: 'Nobody planned it: stay paused',
      who: 'council (2 of 3)',
      detail:
        "A weaker policy can only come from an executed upgrade: follow unexpected-owner-action. Remove every email key that isn't Hana's own pinned key at once (`remove_issuer_key`, immediate), then raise the session floor past the pause before any unpause, as for a forged active key (follow forged-active-key).",
      commands: [c.ownerCall('remove_issuer_key', '{"provider":"email","kid":"<kid>"}'), c.ownerCall('set_sessions_valid_from_ms', '{"sessions_valid_from_ms":<pause block time ms + 1>}')],
    },
  ],
  verify: ["The next run resolves the alert (`/status` `email.differences` empty) and doesn't pause again.", '`admin <env> governance:status`: no findings.'],
  followUps: ['Record a planned policy change and its pin order in `docs/decisions.md`.'],
  refs: ['docs/email-login-spec.md#watchdog-appswatchdog', 'docs/email-login-spec.md#signing-key-staged', 'docs/operations.md#watchdog-alerts-runbook', 'D121', 'D191'],
  related: ['forged-active-key', 'unexpected-owner-action', 'email-issuer-key-compromised'],
};

const unrecordedWallets: Playbook = {
  id: 'unrecorded-wallets',
  title: 'unrecorded_wallets is set outside a dev env',
  kind: 'alert',
  alertKinds: ['unrecorded_wallets'],
  severity: 'critical',
  status: 'live',
  summary:
    "`get_config().unrecorded_wallets` is true on an env that isn't a dev env (D139): the contract was migrated from pre-v3 state, so wallets derived before v3 aren't in `opened`. Links are refused until the owner accepts, and mainnet must never show it.",
  signals: ['Critical `unrecorded_wallets` page, every run while the flag is set (alert only; the watchdog calls nothing).', 'Every link (automatic or explicit) panics `Links wait until the owner accepts the wallets opened before v3`.'],
  impact: [
    "While set: no link can be made, so email login can't join a Google wallet (and vice versa); nothing else stops.",
    'If accepted blindly: a funded pre-v3 Google wallet counts as having no wallet, so a case-A link could join it silently to an email account (D135). On mainnet the signer is created with `new` on v3, so the flag is false from the start; seeing it there means the runbook was not followed.',
  ],
  steps: [
    {
      title: 'Find how the env got here',
      who: 'a founder',
      detail: 'Only a migration from pre-v3 state (`migrate`, `migrate_v1`) sets it. Check the env\'s upgrade history (`owner:proposals`, the `governance_change` alert for `state_version`). On a staging or production env this is a deviation from the mainnet runbook (`docs/email-login-spec.md` "Migration").',
      commands: [c.ownerProposals, c.governanceStatus],
    },
    {
      title: 'Decide whether pre-v3 wallets matter',
      who: 'a founder',
      detail: "Accepting is only safe when every wallet derived before v3 is test data that will be discarded (as on sandbox-dev). Otherwise leave it set (links stay off) and plan a fresh signer created with `new` on v3.",
    },
    {
      title: 'Accept, only if they are test data',
      who: 'council (2 of 3)',
      detail: 'One way: `accept_unrecorded_wallets` clears the flag (event `unrecorded_wallets_accepted`); the next watchdog run resolves the alert.',
      commands: [c.ownerCall('accept_unrecorded_wallets')],
    },
  ],
  verify: ['`get_config().unrecorded_wallets` is false; the watchdog resolves the alert at its next run.'],
  followUps: ['Write down why the env was migrated rather than created with `new` (`docs/decisions.md`).'],
  refs: ['docs/email-login-spec.md#migration', 'docs/contract-interface.md#accounts-and-links', 'D135', 'D139'],
  related: ['governance-change', 'unexpected-owner-action'],
};

const emailJwksMismatch: Playbook = {
  id: 'email-jwks-mismatch',
  title: "Hana's email JWKS differs from the pins",
  kind: 'alert',
  alertKinds: ['email_jwks_mismatch'],
  severity: 'warning',
  status: 'live',
  summary:
    "Hana's published email JWKS (`{emailIssuer.url}/v1/email/jwks.json`, the watchdog's `jwksUrl`) lists a key that isn't pinned, or lacks an active email key, or can't be fetched while email keys are active. Informational: the contract never reads it and the watchdog doesn't trust it.",
  signals: ['Warning `email_jwks_mismatch` (Slack, email): `details.problems` lists each key; `email_jwks_mismatch:fetch` after 3 failed fetches.'],
  impact: [
    "No direct risk: logins check the keys on chain. A published key that isn't pinned means the issuer Worker holds (or advertises) a key the watchdog would cancel or pause on if the council posted it; a missing active key means the issuer and the chain disagree about which keys sign.",
  ],
  steps: [
    {
      title: 'Compare the three lists',
      who: 'a founder',
      detail: "Pins (`watchdog.pinnedIssuerKeys.email`), the chain's active email kids (`/status` `email.chain.active_kids`) and the published JWKS. A rotation in progress (new key published before the council posts it) is expected: pin it before the post.",
      commands: [c.watchdogStatus],
    },
    {
      title: 'An unknown published key',
      who: 'a founder',
      detail: "Nobody on the team added it: the issuer Worker or Hana's Cloudflare account may be compromised. Follow email-issuer-key-compromised and api-or-cloudflare-compromised.",
    },
    {
      title: 'Fetch failing',
      who: 'a founder',
      detail: "The issuer Worker is down or its route moved (email logins then fail too). Check the issuer's deployment; if the URL changed on purpose, set `jwksUrl` in the pins and redeploy the watchdog.",
      commands: [c.watchdogGen, c.watchdogDeploy],
    },
  ],
  verify: ['The next run resolves the warning.'],
  followUps: [],
  refs: ['docs/email-login-spec.md#issuer-configuration', 'docs/email-login-spec.md#watchdog-appswatchdog', 'D190'],
  related: ['email-issuer-key-compromised', 'api-or-cloudflare-compromised'],
};

const linkVolume: Playbook = {
  id: 'link-volume',
  title: 'Link volume past its alarm threshold',
  kind: 'alert',
  alertKinds: ['link_threshold_reached', 'link_volume_high', 'link_stats_unavailable'],
  severity: 'critical',
  status: 'live',
  summary:
    "The contract counts every new link per scope and in total per UTC hour and flags a scope (or the total) whose links reach its alarm threshold (D200; default 50 per scope, 500 in all). Nothing is refused: the links went through. A threshold reached is critical: a partner launch, or a stolen email key taking over Google wallets by linking. Half the total threshold is a warning.",
  signals: [
    'Critical `link_threshold_reached` (`:total:<hour>`, `:scope:<scope>:<hour>`, `:more_scopes:<hour>`), from `get_link_stats()` each run for the current and the previous hour, so a threshold reached between two runs is seen. It resolves once that hour is neither window (and stays open while the view can\'t be read).',
    "Warning `link_volume_high:<hour>`: the hour's links in all scopes reached half of `total_per_hour`. Warning `link_stats_unavailable`: `:missing` (an email issuer is on chain but the contract has no `get_link_stats`: deploy the D200 contract), `:malformed` (an answer of another shape: the watchdog and the contract disagree on the view, fix the watchdog's reader) or `:read_failed`. Only the link check is affected; cancels and pauses still run.",
    '`/status` `link_stats` has the thresholds, a pending raise and both windows.',
  ],
  impact: [
    "A stolen email signing key (1-of-1 at launch) can link an email identity it mints to a victim's Google identity at once (D119) and so derive the victim's wallet; each such takeover is one link, so a burst shows here. The links went through: the alarm is detection, the pause is the council's call.",
    'What the counter can\'t see: with the email key alone a thief can also log into email-rooted wallets, and into Google wallets that already have an email member, without making any link. The defence there is the key\'s custody (KMS, a second signer, D121), not this alarm.',
  ],
  steps: [
    {
      title: 'Check for a partner launch',
      who: 'a founder',
      detail:
        "Ask the scope's partner whether they launched or migrated users this hour, and compare with the API's logins for the window. Many automatic links (case B) for Google-hosted addresses the partner can't explain, links in scopes with no traffic, or every scope at once point to a stolen email key.",
      commands: [c.watchdogStatus, c.watchdogAlerts],
    },
    {
      title: 'Suspected key compromise: pause and rotate the email key',
      who: 'council (2 of 3)',
      detail:
        "Pause at once (stops every login and derive), remove the email issuer key on chain (immediate), then follow email-issuer-key-compromised for the credential, the session floor and the affected users, and forged-active-key for the recovery order before the unpause. A new key is pinned first and waits `governance_delay_ms` (forged-key-change).",
      commands: [c.ownerCall('pause'), c.ownerCall('remove_issuer_key', '{"provider":"email","kid":"<kid>"}')],
    },
    {
      title: 'Only if the alarm level is wrong for real traffic: change the threshold',
      who: 'council (2 of 3)',
      detail:
        "A launch needs nothing (its links went through). If ordinary traffic keeps crossing the alarm, the council changes the threshold with `set_link_thresholds` (an owner action, through `admin <env> owner:call set_link_thresholds`): lowering applies at once, raising waits `governance_delay_ms` (72 h on mainnet) and pages as a `governance_change` (`pending_thresholds`) when proposed.",
    },
  ],
  verify: ['The next hours show `link_stats.current.total` under the thresholds and the alerts resolve after the window passes.', 'A compromise: the email key is gone from `get_issuer("email")` and the contract stays paused until the recovery order is done.'],
  followUps: ['Tune the provisional thresholds (D200) from sandbox-dev and staging traffic before mainnet.'],
  refs: ['docs/email-login-spec.md#watchdog-appswatchdog', 'docs/email-login-spec.md#trust-statement', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D200', 'D119', 'D121'],
  related: ['email-issuer-key-compromised', 'forged-active-key', 'forged-key-change', 'governance-change'],
};

const selfIssuedKeyChange: Playbook = {
  id: 'self-issued-key-change',
  title: 'Pending email key change (info)',
  kind: 'alert',
  alertKinds: ['self_issued_key_change'],
  severity: 'info',
  status: 'live',
  summary: "A pending email key pinned for its signer, or a pending email key removal. Self-issued keys can't be confirmed early (D121): it waits its `governance_delay_ms` (72 h on mainnet), then anyone executes it.",
  signals: ['Info `self_issued_key_change` in `/status`, the portal and the daily digest: the change id, kid (its thumbprint), signer and `executable_at_ms`.'],
  impact: ['None when the council meant it: the key is Hana\'s own (pinned). A removal stops email logins signed with that key once it executes (DoS only).'],
  steps: [
    {
      title: 'Match it with a council proposal',
      who: 'a founder',
      detail: 'A rotation or the first keys: expected. Unexpected: the council posted it without the team (follow unexpected-owner-action), and cancel it before it executes.',
      commands: [c.ownerProposals, c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: 'Execute it once due',
      who: 'anyone',
      detail: 'After `executable_at_ms`, anyone executes it (the API cron executes only Google changes). The watchdog warns `unexecuted_key_change` an hour after it is due.',
      commands: [c.executeIssuerKeyChange],
    },
  ],
  verify: ["The key appears in `get_issuer(\"email\")` and under its signer in `get_self_issued(\"email\")`; the watchdog reports `key_change_executed`."],
  followUps: [],
  refs: ['docs/email-login-spec.md#self-issued-issuers', 'docs/contract-interface.md#self-issued-issuers-email-login-d121', 'D121'],
  related: ['key-change-lifecycle', 'unexpected-owner-action'],
};

const identityJwksForged: Playbook = {
  id: 'identity-jwks-forged',
  title: "Hana's identity JWKS publishes a key the watchdog didn't pin, or can't be judged",
  kind: 'alert',
  alertKinds: ['identity_key_unpinned', 'identity_private_key_published', 'identity_discovery_mismatch', 'identity_jwks_unreadable'],
  severity: 'critical',
  status: 'live',
  summary:
    "The partner identity token's JWKS (`{iss}/jwks.json`) lists a key whose RFC 7638 thumbprint isn't in `watchdog.pinnedIdentityKeys` (or with members beyond the public ones), or private key material; the discovery document names another issuer or `jwks_uri`; or an answer can't be judged (a redirect, padding over 64 KB, not JSON, duplicate members, the wrong shape, 3 failed fetches). Partners that trust the JWKS URL would accept tokens for any user. The chain isn't involved: no pause.",
  signals: [
    'Critical `identity_key_unpinned` (`details.keys`: each kid, thumbprint and `reason`: `not_pinned`, `not_p256`, `extra_members`, or `pins_unreadable` while `IDENTITY_PINS` is malformed, which also pages `pins_invalid:identity`). With nothing pinned at all, every published key is unpinned.',
    'Critical `identity_private_key_published` (`details.keys[].private`: the member names, never the values) and `identity_discovery_mismatch` (`details.field`: `issuer` or `jwks_uri`, with `expected` and `published`).',
    'Critical `identity_jwks_unreadable:<jwks|discovery>:answer:<reason>` (`redirect`, `too_large`, `not_json`, `duplicate_members`, `bad_shape`) at once, or `:sustained` after 3 failed fetches in a row: each can hide a key from the watchdog that partners still see.',
    "`/status` `identity`: the pins in force and the last good reads, each key judged. The outside probe (GitHub Actions workflow `identity-probe`, every 3 hours, from outside Cloudflare; turned off while only testnet runs, D387) failing on the same env is a second view: the watchdog's own fetch comes from Cloudflare's network and can be told apart.",
  ],
  impact: [
    "An unpinned key in the JWKS means whoever published it can sign identity tokens partners accept as any user of any app (identity at partners: credits, referrals, their accounts) until it is gone from the JWKS and the partners' caches (≤ 10 min). No wallet, key, Hana API or contract call accepts an identity token.",
    "A private member published: anyone who fetched the JWKS holds that signing key. A wrong `issuer` or `jwks_uri`: partners that use discovery check tokens against another issuer or fetch keys the watchdog doesn't see. An unreadable answer: the watchdog can't tell what partners are served.",
    'Detection, not prevention: someone who controls Hana\'s Cloudflare account can serve the watchdog a clean JWKS and partners another, or publish a key between two runs. Only partners that pin thumbprints are safe from that.',
  ],
  steps: [
    {
      title: 'Rule out a rotation deployed in the wrong order, or a page expected during an incident',
      who: 'a founder',
      detail:
        "Compare the published kids with `identity-key show` and the manifest's `watchdog.pinnedIdentityKeys`. After `next` (or `init`) the watchdog must be deployed before the API: if the API went first, deploy the watchdog now (the manifest already pins the key: `identity-key` writes both). After `retire` the API must be deployed before the watchdog: if the watchdog went first, the retired key is unpinned but still published until the API deploy, so deploy the API now. During an incident rotation that retires one key and publishes another (both keys exposed), this page is expected until both deploys are done (`docs/operations.md` \"Identity token keys\"): acknowledge it once both are deployed and the next run resolves it. Anything else is an incident.",
      commands: [c.watchdogStatus, c.identityKeyShow, c.watchdogGen, c.watchdogDeploy, c.apiGen, c.apiDeploy],
    },
    {
      title: 'Read what is published, from outside Cloudflare',
      who: 'a founder',
      detail: "Fetch the JWKS and the discovery document yourself and keep a copy for the post-mortem; run the outside probe too. Never paste a published private member anywhere: the key is burned either way. An unreadable answer whose cause you can't see from here (a redirect, padding, a failure only the watchdog gets) is treated as an unpinned key.",
      commands: ['curl -s <apiUrl>/v1/identity/jwks.json', 'curl -s <apiUrl>/v1/identity/.well-known/openid-configuration', c.identityProbe],
    },
    {
      title: 'Treat the API Worker or the Cloudflare account as compromised',
      who: 'a founder',
      detail:
        "The JWKS and the discovery document come from the manifest at deploy time, so a key nobody on the team added means a deploy nobody made, a changed Worker, or a taken account. Follow api-or-cloudflare-compromised: take the account back and redeploy known-good code from the repo; the redeploy restores the pinned JWKS.",
      commands: [c.apiGen, c.apiDeploy],
    },
    {
      title: 'Rotate the identity signing keys',
      who: 'a founder',
      detail:
        "Whoever could change what the API serves could also read its secrets, the active identity key among them: follow identity-signing-key-compromised (switch to the offline standby, or a fresh key if both may be exposed; unpublish the exposed ones; the watchdog's pins follow in the order it gives). A published private member: that key is exposed whatever else happened.",
      commands: [c.identityKeySwitchStandby, c.identityKeyRetirePrevious],
    },
    {
      title: 'Tell partners',
      who: 'a founder',
      detail: "Their security contacts: the kids that were published, the window, and what to re-check (tokens accepted with an unknown kid). Partners that pin thumbprints were not exposed; tell them the new pins after the rotation.",
    },
  ],
  verify: ["The next run resolves the alert: every published key pinned and clean, no private member, the discovery document's issuer and jwks_uri as configured, both answers readable.", '`/status` `identity.jwks.unpinned` and `identity.jwks.private` are 0, and the outside probe passes.'],
  followUps: ["Write the post-mortem: how the key got into the JWKS. Check that the watchdog's own Cloudflare account wasn't touched (watchdog-compromised)."],
  refs: ['docs/identity-token-spec.md#jwks-and-discovery', 'docs/operations.md#identity-token-keys', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D210', 'D211'],
  related: ['api-or-cloudflare-compromised', 'identity-signing-key-compromised', 'identity-jwks-degraded', 'watchdog-compromised'],
};

const identityJwksDegraded: Playbook = {
  id: 'identity-jwks-degraded',
  title: "A pinned identity key isn't in Hana's identity JWKS",
  kind: 'alert',
  alertKinds: ['identity_key_missing'],
  severity: 'warning',
  status: 'live',
  summary:
    "A key in `watchdog.pinnedIdentityKeys` isn't in the identity JWKS under its thumbprint as kid with public members only. Usually a rotation half deployed; nothing is forged by this alone.",
  signals: [
    'Warning `identity_key_missing:<thumbprint>` (`details.reason`: `not_published`; `kid_differs`: the key is there under another kid; `not_clean`: under its kid but with other members, which also pages `identity_key_unpinned`).',
  ],
  impact: [
    "A pinned key that isn't published: tokens it signs fail at partners (if it is the active key, every mint fails verification). Partners that pin thumbprints and look keys up by kid fail on a renamed key.",
  ],
  steps: [
    {
      title: 'A rotation step half done',
      who: 'a founder',
      detail:
        "`identity-key next` pins the new key and publishes it in the same manifest change: the watchdog is deployed first (it warns until the API deploy), then the API. After `retire`, the pin goes with the key: deploy the API first, then the watchdog. Finish whichever deploy is missing.",
      commands: [c.identityKeyShow, c.apiGen, c.apiDeploy, c.watchdogGen, c.watchdogDeploy],
    },
    {
      title: 'The key is missing for no planned reason',
      who: 'a founder',
      detail: "Check the API's health and the JWKS itself; a 503 `identity_unavailable` means the API Worker lost its identity configuration (regenerate and redeploy). A key under another kid or with extra members is a changed Worker: see identity-jwks-forged.",
      commands: [c.apiHealth, 'curl -s <apiUrl>/v1/identity/jwks.json', c.apiTailErrors],
    },
  ],
  verify: ['The next run resolves the warning; `/status` `identity.jwks.missing` is empty.'],
  followUps: [],
  refs: ['docs/operations.md#identity-token-keys', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D211'],
  related: ['identity-jwks-forged', 'identity-signing-key-compromised'],
};

const identityKeyOnChain: Playbook = {
  id: 'identity-key-on-chain',
  title: "An issuer key on chain has an identity key's kid",
  kind: 'alert',
  alertKinds: ['identity_key_on_chain'],
  severity: 'critical',
  status: 'live',
  summary:
    "An active Google or email issuer key, or a pending key addition of any provider, has as its kid the RFC 7638 thumbprint of a partner identity key (pinned, or published at the last JWKS read). The contract must never trust an identity key; its material (EC) can't even be stored there, so this is someone posting an identity kid.",
  signals: [
    'Critical `identity_key_on_chain:active:<provider>:<kid>` or `:pending:<change id>` (`details`: where, provider, kid, change, whether the kid is pinned).',
    "The same run's Google and email rules judge the key as usual: Google never publishes such a kid (a pending one is cancelled, an active one pauses), and an email kid must be its own RSA thumbprint (cancel, pause). Expect a `forged_key_change` or `forged_active_key` beside this alert; for a provider the watchdog doesn't know, an `unverifiable_key_change`.",
  ],
  impact: [
    'No identity token is accepted by the contract either way (it verifies RS256 issuer tokens only). The risk is what the key change itself is: an issuer key nobody vouches for, handled by the forged-key playbooks.',
  ],
  steps: [
    {
      title: 'Follow the issuer-key alert of the same run',
      who: 'a founder',
      detail: 'Follow forged-key-change or forged-active-key: they cancel, pause and recover. This alert only says the kid is an identity key.',
      commands: [c.watchdogAlerts],
    },
    {
      title: 'Find who posted it',
      who: 'a founder',
      detail:
        "The change's proposer (`details` of the issuer-key alert): the updater account means its key is stolen (updater-key-stolen); the owner means a council action nobody explained (unexpected-owner-action). Using an identity kid suggests someone with access to Hana's identity configuration: check it with identity-signing-key-compromised in mind.",
      commands: [c.apiGovernance],
    },
  ],
  verify: ['The key change is cancelled or the key removed; the next run resolves the alert.'],
  followUps: ['Record how an identity kid reached the chain in the post-mortem.'],
  refs: ['docs/identity-token-spec.md#jwks-and-discovery', 'apps/watchdog/README.md#what-a-run-does-every-5-min', 'D212'],
  related: ['forged-key-change', 'forged-active-key', 'unverifiable-key-change', 'identity-signing-key-compromised'],
};

export const ALERT_PLAYBOOKS: readonly Playbook[] = [
  forgedActiveKey,
  forgedKeyChange,
  publishedKeyRemoval,
  unverifiableKeyChange,
  unknownActiveKeyFirstRun,
  governanceChange,
  watchdogActedAgain,
  protectiveActionFailed,
  watchdogCannotAct,
  watchdogDegraded,
  keySyncStalled,
  retiredKeyChange,
  unseenKeyChange,
  activeKeyMaterialUnavailable,
  configChange,
  confirmFailed,
  keyChangeLifecycle,
  configMatured,
  watchdogFirstRun,
  relayerOutOfFunds,
  signerPolicyMismatch,
  unrecordedWallets,
  emailJwksMismatch,
  linkVolume,
  selfIssuedKeyChange,
  identityJwksForged,
  identityJwksDegraded,
  identityKeyOnChain,
];
