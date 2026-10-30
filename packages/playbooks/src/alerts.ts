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
    "A pending issuer key Google doesn't publish (or with other key material), or a non-Google key the updater proposed: the watchdog cancelled it and, when the updater proposed it, deleted every updater key.",
  signals: [
    'Critical `forged_key_change` page (paging app, Slack, email), re-sent every 15 min until acknowledged. The title and `details.outcome` say what happened: `cancelled`, `gone` (someone else cancelled it first), `executed` (it took effect before the cancel), `unknown`, `failed` or `not_sent`.',
    "`details.by` is the proposer: the signer account means `KEYS_UPDATER_KEY`; the owner means the council. `reason: updater_other_provider`: the updater proposed a key for a provider other than Google (it only serves Google).",
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
    "A key Google doesn't publish is active on chain: the watchdog paused the contract and deleted every updater key (D126). Recover in a fixed order: remove the key, raise the session floor, a fresh updater key, unpause.",
  signals: [
    'Critical `forged_active_key` page: "Active issuer key <kid>: …; paused, N updater key(s) deleted".',
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
      detail: 'The owner removes the kid at once (`remove_issuer_key`, immediate; it also drops a pending change for that kid).',
      commands: [c.ownerCall('remove_issuer_key', '{"provider":"google","kid":"<kid>"}')],
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
        'A delay that ran out while the watchdog was down (watchdog-down), an owner post (unexpected-owner-action), or an upgrade. Fix that path before closing.',
    },
  ],
  verify: [
    '`admin <env> governance:status`: no findings (no active Google key Google doesn\'t publish, not paused, the updater key tracked).',
    '`GET /v1/governance` shows `paused: false`; logins resume within 10 s (the API caches the pause state 10 s while paused).',
    "The watchdog's `forged_active_key` alert resolves at its next run and it doesn't pause again.",
    '`get_config().sessions_valid_from_ms` is past the pause.',
  ],
  followUps: [
    "Tell partners (their security contacts) what happened and which window their users' sessions were exposed in.",
    'Users who derived during the window: treat their keys as exposed (user-key-leaked).',
    'Post-mortem: how the forged key reached the active set; record any rule change in `docs/decisions.md`.',
  ],
  refs: ['docs/operations.md#watchdog-alerts-runbook', 'docs/operations.md#pause', 'docs/contract-interface.md#pause', 'D82', 'D126'],
  related: ['contract-paused', 'updater-key-stolen', 'watchdog-down', 'unexpected-owner-action', 'user-key-leaked'],
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
    "A removal the updater (the signer account) proposed means `KEYS_UPDATER_KEY` is stolen (the API cron only proposes removals of kids missing from Google's JWKS for ≥ 55 min).",
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
  summary: 'The owner proposed a key change for an issuer other than Google: the watchdog has no JWKS for it and only alerts.',
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
  followUps: ['When a new issuer is added on purpose (email login is planned, `docs/email-login-spec.md`), the watchdog needs its pinned keys first.'],
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
    'Fields: `pending_upgrade`, `owner`, `pending_owner`, `pending_withdrawal`, `watchdogs`, `updater_keys`, the delays, `console_audiences`, `paused`, `unpaused_at_ms`, `sessions_valid_from_ms`, `owner_code_hash`, `owner_policy`, `issuer`, `issuer_keys`, `mpc`, `ckd_domain_id`, `state_version`.',
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
  alertKinds: ['not_a_watchdog', 'watchdog_key_missing', 'wrong_network'],
  severity: 'critical',
  status: 'live',
  summary: "Its account isn't a contract watchdog, its key is missing or malformed, or its RPC is on another chain: it can alert at most, never cancel or pause.",
  signals: ['Critical `not_a_watchdog`, `watchdog_key_missing` or `wrong_network` (condition alerts: open until a run no longer sees them).', '`/status` `last_run.checks`: `watchdog_role` or `config` not ok.'],
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

const keySyncStalled: Playbook = {
  id: 'key-sync-stalled',
  title: 'Google key sync stalled',
  kind: 'alert',
  alertKinds: ['unexecuted_key_change', 'stale_active_key'],
  severity: 'warning',
  status: 'live',
  summary: 'A matured key change nobody executed for over 1 h, or an active kid Google dropped more than 3 h ago that nobody proposed to remove.',
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
      detail: 'The cron proposes removing a kid missing for ≥ 55 min (never the last key); a founder can run the same sync at once.',
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
  activeKeyMaterialUnavailable,
  configChange,
  confirmFailed,
  keyChangeLifecycle,
  configMatured,
  watchdogFirstRun,
  relayerOutOfFunds,
];
