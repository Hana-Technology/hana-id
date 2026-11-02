// Playbooks for incidents the watchdog doesn't raise (from docs/security.md "What a compromise gives",
// docs/governance-spec.md "What each party can do after this batch" and docs/operations.md). Where the honest answer
// is "this can't be undone" or "users must log in again", the playbook says so.
import * as c from './commands.ts';
import type { Playbook } from './types.ts';

const updaterKeyStolen: Playbook = {
  id: 'updater-key-stolen',
  title: '`KEYS_UPDATER_KEY` stolen (API secrets leaked)',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "The keys-updater key (an API Worker secret, a function-call key on the signer) leaked: it can propose issuer keys and removals, delayed and cancellable, and execute matured ones.",
  signals: [
    'A `forged_key_change` or `published_key_removal` alert with `by` = the signer account.',
    'The API Worker secrets, `.secrets/<env>/keys-updater.json` or a machine holding it was exposed.',
    "Proposals the API cron didn't make (`GET /v1/governance` `.updater` tracks the cron's own).",
  ],
  impact: [
    "Bounded by governance: every key it proposes waits `issuer_key_delay_ms` and the watchdog cancels keys Google doesn't publish (and deletes the updater keys). Forging needs every watchdog down for the whole delay, and the next watchdog run then pauses.",
    "It can fill the 6-slot pending queue (blocking Google's real rotations), propose removing Google's live keys (alert-only: the owner cancels), and burn up to its 1 NEAR allowance from the signer's balance.",
    "Until a fresh key is in, the API cron can't propose Google's rotations.",
  ],
  steps: [
    {
      title: 'Delete the key on chain',
      who: 'council (2 of 3)',
      detail: 'If the watchdog hasn\'t already (`updater_keys` in `governance:status`), the owner deletes every key that may have leaked.',
      commands: [c.governanceStatus, c.ownerCall('delete_updater_key', '{"public_key":"<ed25519:…>"}')],
    },
    {
      title: 'Cancel what it queued',
      who: 'council (2 of 3)',
      detail: "The watchdog cancels forged additions; removals of kids Google still publishes are alert-only, so the owner cancels them. Leave Google's genuine additions in place.",
      commands: [c.apiGovernance, c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: 'Find and close the leak',
      who: 'a founder',
      detail: "Where was it read: the Worker's secrets (then the Cloudflare account or the Worker code: api-or-cloudflare-compromised), `.secrets/` on a machine, a log or a paste. Close that first, or the fresh key leaks the same way.",
    },
    {
      title: 'Rotate',
      who: 'council (2 of 3)',
      detail: "A founder moves the key file aside and runs `deploy-contract` (a new key generated into the file; the owner's `add_updater_key` as a council proposal; ≤ 2 tracked keys), then uploads it as `KEYS_UPDATER_KEY`.",
      commands: [c.moveUpdaterKeyAside, c.deployContractPlan, c.deployContract, c.uploadUpdaterKey],
    },
  ],
  verify: [
    '`admin <env> governance:status`: no findings; only the new key tracked, with exactly the updater methods.',
    "`curl -s <apiUrl>/v1/governance | jq '.signerAccessKeys[] | select(.updaterPermission | not)'` is empty outside sandbox-dev.",
    'The next cron run proposes and executes without `send_failed`.',
  ],
  followUps: ['Record the cause; delete the old key file once the on-chain deletion is confirmed.'],
  refs: ['docs/operations.md#keys-updater-key', 'docs/governance-spec.md#what-a-stolen-updater-key-can-still-do-bounded', 'docs/security.md#key-and-secret-inventory', 'D82'],
  related: ['forged-key-change', 'api-or-cloudflare-compromised'],
};

const relayerKeyStolen: Playbook = {
  id: 'relayer-key-stolen',
  title: 'A relayer key stolen (session pool or owner pool)',
  kind: 'incident',
  severity: 'warning',
  status: 'live',
  summary: "A function-call key of the relayer account (`RELAYER_KEYS` or `OWNER_RELAYER_KEYS`) leaked: it can burn its allowance, nothing more.",
  signals: [
    'A watchdog `relayer_allowance_*` or `relayer_balance_*` alert without matching logins (allowance or balance dropping faster than the request logs explain); `relay_retry` `invalid_nonce` warnings (another sender used a pool key).',
    'The API Worker secrets or `.secrets/<env>/relayer-keys.json` / `owner-relayer-keys.json` were exposed.',
  ],
  impact: [
    "Session pool: burn ≤ its allowance (2 NEAR default) and relay session methods, which still need a token or a session signature. DoS only: it can't derive anyone's key.",
    'Owner pool: burn ≤ 0.5 NEAR; every owner method still needs an owner proof on chain; logins are unaffected.',
  ],
  steps: [
    {
      title: 'Delete the key on chain',
      who: 'a founder',
      detail: "With the relayer account's full-access key (keychain). Several keys or a whole leaked file: delete every key in it.",
      commands: [c.deleteRelayerKey],
    },
    {
      title: 'Remove it from the secrets file',
      who: 'a founder',
      detail: "Edit `.secrets/<env>/relayer-keys.json` (or `owner-relayer-keys.json`), or move the file aside for a whole new pool (then delete every old key on chain too: left there they keep their allowance).",
    },
    {
      title: 'Add replacements',
      who: 'a founder',
      detail: '`deploy-contract` generates and adds the missing keys (saved to the file before they go on chain). Pass the same allowance flags as before if you raised them.',
      commands: [c.deployContractPlan, c.deployContract],
    },
    {
      title: 'Upload the pool again',
      who: 'a founder',
      detail: "A replaced key at an index makes its Durable Object ignore the old reservation and read the nonce from chain once (one `relay_retry` `invalid_nonce` per re-added key is expected).",
      commands: [c.uploadRelayerKeys, c.uploadOwnerRelayerKeys],
    },
  ],
  verify: ['`deploy-contract <env>` dry run: no blockers, no missing keys.', 'A smoke login relays without errors.'],
  followUps: ['If the leak came from the Worker or the Cloudflare account: api-or-cloudflare-compromised.'],
  refs: ['docs/operations.md#relayer-keys-either-pool', 'docs/security.md#what-a-compromise-gives', 'docs/architecture.md#relayer-design'],
  related: ['relayer-out-of-funds', 'api-or-cloudflare-compromised'],
};

const vaultKekLeaked: Playbook = {
  id: 'vault-kek-leaked',
  title: '`VAULT_KEK` leaked (and routine rotation)',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: 'The key that wraps every vault share `K_s` in D1 leaked. Revoke every share first, then rotate; every user with a persisted login signs in again.',
  signals: ['The API Worker secrets, `.secrets/<env>/vault-kek` or a D1 copy together with the KEK were exposed.'],
  impact: [
    "With the KEK and a D1 copy, every live share's `K_s` unwraps; with a device's IndexedDB record as well, that user's PRK. Rotation alone doesn't help: it re-wraps the same `K_s`.",
    "Revoking every share means every user with a persisted login signs in with Google again on their next visit. D1 backups and Time Travel keep the old rows under the old KEK for their retention: treat them as exposed for that long (can't be undone).",
  ],
  steps: [
    {
      title: 'Revoke every share (skip for a routine rotation)',
      who: 'a founder',
      detail: 'Every live share is revoked at once.',
      commands: [c.revokeAllShares],
    },
    {
      title: 'Rotate the KEK',
      who: 'a founder',
      detail: "Copies the current key to `vault-kek.previous`, writes a new key with the next id, sets `VAULT_KEK_PREVIOUS` and `VAULT_KEK`. If it stops part way, run it again (it resumes with the same new key). It refuses while a previous rotation's `vault-kek.previous` is still there.",
      commands: [c.vaultKekRotate],
    },
    {
      title: 'Retire the old key',
      who: 'a founder',
      detail: 'Unlocks and the hourly cron re-wrap old rows (≤ 2000 per run). Once no row is left under the old id, delete `VAULT_KEK_PREVIOUS` and `.secrets/<env>/vault-kek.previous`.',
      commands: [c.countOldKekRows, c.deletePreviousKek, 'rm .secrets/<env>/vault-kek.previous'],
    },
  ],
  verify: ['The old-id count is 0 before deleting the previous key; no `unknownKek` errors in the logs.', 'A fresh login persists and unlocks after a reload.'],
  followUps: ['If the KEK leaked with the Worker or the account: api-or-cloudflare-compromised.'],
  refs: ['docs/operations.md#vault_kek', 'docs/security.md#key-and-secret-inventory', 'D54'],
  related: ['api-or-cloudflare-compromised', 'd1-data-loss'],
};

const apiCompromised: Playbook = {
  id: 'api-or-cloudflare-compromised',
  title: "API Worker code or Hana's Cloudflare account compromised",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "Someone changed what the API or page Workers run, or controls Hana's main Cloudflare account: the page-serving trust root, the updater key, the relayer pools, D1 and `VAULT_KEK`.",
  signals: [
    "Deploys nobody made (Cloudflare's deployment history), unknown API tokens or logins, changed Worker secrets or D1 rows (origins, settings).",
    'A `forged_key_change` from the signer account (the updater key is a Worker secret).',
    "The watchdog keeps alerting: it runs on its own Cloudflare account and can't be silenced from this one (except on sandbox-dev, D125).",
  ],
  impact: [
    'Every key of every user who loads the vault while it is compromised (the API renders the vault page; the same account deploys the vault and auth bundles). Pausing the contract stops new derivations, not a malicious vault page reading a persisted share: those users\' keys are exposed and must be moved (can\'t be undone).',
    'Bounded by governance: the updater key can only propose delayed, cancellable issuer keys; the watchdog cancels forged ones.',
    "The admin portal's view and its acks (batch C) are on this account: a portal ack stops only re-sends of alerts already paged.",
  ],
  steps: [
    {
      title: 'Take the account back',
      who: 'a founder',
      detail: 'In the Cloudflare dashboard: password, MFA, revoke API tokens and sessions, review members and the audit log (no repo tooling).',
    },
    {
      title: 'Pause if keys may be stolen right now',
      who: 'council (2 of 3)',
      detail: 'A malicious vault or auth bundle is live: pausing stops new logins and derivation everywhere (a DoS, but it ends new key extraction through logins). Unpause after the clean redeploy (contract-paused).',
      commands: [c.ownerCall('pause')],
    },
    {
      title: 'Redeploy known-good code',
      who: 'a founder',
      detail: 'From a reviewed commit: the API, then a fresh page build and both page Workers.',
      commands: [c.apiGen, c.apiDeploy, c.webBuild, c.pagesDeploy],
    },
    {
      title: 'Rotate every API secret',
      who: 'a founder',
      detail: 'The updater key (updater-key-stolen), both relayer pools (relayer-key-stolen), and `VAULT_KEK` with every share revoked (vault-kek-leaked). The admin Worker\'s copy of `WATCHDOG_STATUS_TOKEN` too, once batch C exists.',
    },
    {
      title: 'Check D1 for tampering',
      who: 'a founder',
      detail: "Origins decide `frame-ancestors` and parent-origin checks; settings include `raw_sign` and policies (a bare D1 write skips their pending delay). Remove origins nobody added; suspend apps you can't verify.",
      commands: [c.appList, c.appSettings, c.appOriginsRemove, c.appSuspend],
    },
    {
      title: 'Tell partners',
      who: 'a founder',
      detail: "Their security contacts: the window, and that users who opened their app in it should move funds to a new key. Not built yet: batch C's partner notice email (D86's notice channel).",
    },
  ],
  verify: ['Deployed versions match the reviewed commit; `GET /v1/health` answers for the env.', '`admin <env> governance:status`: no findings; the watchdog quiet.', 'Every app\'s origins and settings checked.'],
  followUps: ['Post-mortem; any rule change goes in `docs/decisions.md`. Bounding the page-serving trust root is an open issue (`docs/security.md`).'],
  refs: ['docs/security.md#what-a-compromise-gives', 'docs/governance-spec.md#what-each-party-can-do-after-this-batch', 'D83'],
  related: ['updater-key-stolen', 'relayer-key-stolen', 'vault-kek-leaked', 'hana-origin-compromised', 'contract-paused', 'user-key-leaked'],
};

const originCompromised: Playbook = {
  id: 'hana-origin-compromised',
  title: 'Vault or auth origin compromised (domain or DNS)',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: '`vaultOrigin` or `authOrigin` serves someone else\'s code (a hijacked domain, DNS record or route).',
  signals: ['The pages serve unexpected content or certificates; registrar or DNS changes nobody made.', 'sandbox-dev uses workers.dev origins: there it is the Cloudflare account (api-or-cloudflare-compromised).'],
  impact: [
    "`vaultOrigin`: every key of every user who loads it (PRK in memory; a page on that origin can read its IndexedDB records and unlock live shares). `authOrigin`: tokens of the logins it handles, approvals it shows, key exports.",
    "Users who loaded a hijacked page: their keys are exposed and must be moved (can't be undone).",
  ],
  steps: [
    { title: 'Take the domain back', who: 'a founder', detail: 'Registrar and DNS provider: credentials, MFA, records, registrar lock (no repo tooling). Production uses two registrable domains (D38), so check both.' },
    {
      title: 'Stop key extraction',
      who: 'council (2 of 3)',
      detail: 'Pause (stops new logins and derivation), and a founder revokes every vault share so persisted logins can\'t be unlocked by the hijacked page (users log in again).',
      commands: [c.ownerCall('pause'), c.revokeAllShares],
    },
    { title: 'Redeploy the page Workers', who: 'a founder', detail: 'Once the origins are back.', commands: [c.webBuild, c.pagesDeploy] },
    { title: 'Unpause', who: 'council (2 of 3)', detail: 'After the pages are verified (contract-paused).', commands: [c.ownerCall('unpause')] },
    { title: 'Tell partners', who: 'a founder', detail: 'The window; affected users move funds (user-key-leaked).' },
  ],
  verify: ['Both origins serve the current build with their CSP; a smoke login works.'],
  followUps: ['Changing an origin breaks every own-client partner\'s Google redirect registration (not addresses).'],
  refs: ['docs/security.md#what-a-compromise-gives', 'D38', 'D66'],
  related: ['api-or-cloudflare-compromised', 'user-key-leaked', 'contract-paused'],
};

const watchdogDown: Playbook = {
  id: 'watchdog-down',
  title: "Watchdog down (silent, heartbeat missing)",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "The watchdog stopped running: no cancels of forged keys, no pause, no confirmations, no alerts. The dead-man's switch is what tells you.",
  signals: [
    "The heartbeat provider's own alert (pings stopped: 5-min period, ~10-min grace) to both founders.",
    "The portal's silence banner (`/status` `silent: true`, no finished run within two intervals); `last_run` old or `outcome: error` (a failing run skips the heartbeat on purpose).",
  ],
  impact: [
    "A forged pending key goes live if nobody cancels it within `issuer_key_delay_ms`. Google's rotations wait their full delay (no confirmations): `503 issuer_key_pending` for the new kid meanwhile.",
    'A Cloudflare-wide outage takes the API and the watchdog down together; the heartbeat on a third provider still reports it.',
  ],
  steps: [
    {
      title: 'Watch the queue by hand',
      who: 'a founder',
      detail: "Until it runs again: check pending key changes well within `issuer_key_delay_ms`; any pending Add Google doesn't publish (`jwks: absent` / `mismatch`) is cancelled by the council at once.",
      commands: [c.apiGovernance, c.ownerCall('cancel_issuer_key_change', '{"id":<id>}')],
    },
    {
      title: 'Find why',
      who: 'a founder',
      detail: "Logged in to the watchdog's Cloudflare account: the cron trigger (trigger changes take minutes to apply), the Worker's errors, D1. `/status` `last_run` shows the last outcome and each check.",
      commands: [c.watchdogStatus],
    },
    {
      title: 'Redeploy',
      who: 'a founder',
      detail: "From `apps/watchdog`, logged in to the watchdog's account (never from CI); secrets again from the file if they were lost.",
      commands: [c.watchdogGen, c.watchdogSecretBulk, c.watchdogDeploy],
    },
    {
      title: 'If its D1 was lost or damaged: restore it',
      who: 'a founder',
      detail: "Logged in to the watchdog's account: Time Travel back to a minute before the loss (30 days). A point after its first run keeps `initialized_at`, so the pause still works; first compare the active kids with Google's JWKS (an active kid Google published and dropped entirely inside the gap would look never published and be paused). The next runs re-alert every governance change since the point (check, then acknowledge) and re-raise conditions still true.",
      commands: [c.governanceStatus, c.watchdogD1Bookmark, c.watchdogD1BookmarkAt, c.watchdogD1Restore],
    },
    {
      title: 'If it can\'t be restored: the first-run caveat',
      who: 'a founder',
      detail: "Past 30 days, a point before its first run, or a new database: the next run is a first run. It records Google's current JWKS as known and alerts, without pausing, on any active kid not in it. Check every first-run alert by hand (unknown-active-key-first-run) and the pending queue; a forged key active at that moment is not paused.",
      commands: [c.apiGovernancePending],
    },
  ],
  verify: ['`/status`: `last_run.outcome: "ok"`, `silent: false`, `heartbeat.ok`; the heartbeat provider shows the check up.'],
  followUps: ['A second watchdog on another provider (D125 later option) removes this single point.'],
  refs: ['docs/operations.md#watchdog-service-appswatchdog', 'docs/operations.md#the-watchdogs-d1', 'apps/watchdog/README.md#alerts-d85', 'D83', 'D125', 'D152'],
  related: ['watchdog-degraded', 'watchdog-compromised', 'forged-active-key', 'unknown-active-key-first-run'],
};

const watchdogCompromised: Playbook = {
  id: 'watchdog-compromised',
  title: "Watchdog compromised (its Cloudflare account, `WATCHDOG_KEY` or status token)",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "Someone holds the watchdog's key, its status token or its Cloudflare account. Its key has DoS power only; the account also holds its alert credentials.",
  signals: [
    'Cancels of genuine Google keys, pauses or updater-key deletions without a matching forgery; the watchdog account sending what this watchdog didn\'t log.',
    'An unexpected `first_run` (its D1 emptied or replaced), acks nobody made, or logins to its Cloudflare account nobody made.',
  ],
  impact: [
    "`WATCHDOG_KEY`: cancel every key change (Google's next key never activates: logins with it fail), pause, delete updater keys, confirm early only a change someone already proposed. It can't post a key; forging needs the updater key or the owner as well.",
    '`WATCHDOG_STATUS_TOKEN`: read the status and ack alerts, which stops only re-sends of alerts already paged (never a first alert or a check).',
    'The account: the key, the token, its Resend, Slack and paging credentials, and its D1 (its history: an emptied D1 means a first run that never pauses).',
  ],
  steps: [
    {
      title: 'Cut the key off',
      who: 'a founder',
      detail:
        "Delete `WATCHDOG_KEY`'s public key from `watchdog.account` with that account's full-access key (keychain): immediate, and the account stays a watchdog. `secrets <env> init` prints the public key of the key in the file. If the watchdog account itself is lost, the council removes it instead (`remove_watchdog`: immediate, but every key change then waits `governance_delay_ms` until another watchdog may confirm).",
      commands: [c.watchdogSecretsInit, c.deleteWatchdogKey, c.ownerCall('remove_watchdog', '{"account_id":"<watchdog.account>"}')],
    },
    {
      title: 'Undo what it did',
      who: 'council (2 of 3)',
      detail: "Unpause if it paused without a forged active key (contract-paused); re-add the updater key (updater-key-stolen's Rotate step); Google's cancelled kids are re-proposed by the API cron after its 1 h hold.",
      commands: [c.ownerCall('unpause'), c.postGoogleKeys],
    },
    {
      title: 'Take the account back',
      who: 'a founder',
      detail: "The watchdog's Cloudflare account: password, MFA, API tokens, members (no repo tooling).",
    },
    {
      title: 'Rotate WATCHDOG_KEY',
      who: 'a founder',
      detail:
        "Remove `WATCHDOG_KEY` from `.secrets/<env>/watchdog-secrets.json` in an editor (never print it), run `secrets <env> init` (a new key; it prints the near CLI command that adds it as a function-call key: run it), upload the file, then delete the old key on chain if step 1 hasn't.",
      commands: [c.watchdogSecretsInit, c.watchdogSecretBulk],
    },
    {
      title: 'Rotate the status token and the alert credentials',
      who: 'a founder',
      detail:
        "The token the same way (remove it from the file, `init` makes a new one), then on both Workers (the admin Worker's copy too, once batch C exists). Resend, Slack, the paging app and the heartbeat URL: replace each in its provider and in the file, then upload.",
      commands: [c.watchdogSecretsInit, c.watchdogSecretsCheck, c.watchdogSecretBulk],
    },
    {
      title: 'A lost D1: restore it, or check the first run',
      who: 'a founder',
      detail: "Restore its D1 with Time Travel to a minute before the intrusion (operations \"The watchdog's D1\"; a point after its first run keeps the pause working). Past 30 days or with nothing to restore: redeploy against a fresh D1 (setup step 5) and check every first-run alert by hand (unknown-active-key-first-run).",
      commands: [c.watchdogD1BookmarkAt, c.watchdogD1Restore, c.watchdogGen, c.watchdogDeploy],
    },
  ],
  verify: ['`/status`: every check ok, channels configured; only the new key on `watchdog.account` besides its full-access key.', '`admin <env> governance:status`: no findings, the watchdog listed (or re-added).'],
  followUps: ['Re-adding a removed watchdog restarts its confirm delay (`governance_delay_ms`).'],
  refs: ['docs/operations.md#watchdog-service-appswatchdog', 'docs/security.md#key-and-secret-inventory', 'docs/contract-interface.md#watchdogs', 'D86'],
  related: ['watchdog-down', 'contract-paused', 'unknown-active-key-first-run'],
};

const councilMemberKey: Playbook = {
  id: 'council-member-key',
  title: "A council member's key lost or compromised",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: 'One of the three council keys (a founder\'s Ledger or the offline backup) is lost or in someone else\'s hands. The council still acts with the other two; replace the member.',
  signals: ['A lost or stolen Ledger, a backup holder who can\'t be reached, or a vote or proposal the member didn\'t make (`owner:proposals`).'],
  impact: [
    'One key alone can propose and vote once: nothing executes without a second key, for every proposal kind (D81). One more compromise would give an attacker the council.',
    'Two keys compromised: the attacker is the owner (unexpected-owner-action).',
  ],
  steps: [
    {
      title: "Reject the member's stray proposals",
      who: 'council (2 of 3)',
      detail: "List open proposals; never approve one nobody explained. Two remaining members each cast a `VoteReject` (`owner:vote --reject`): two rejections close it as `Rejected`, so it can never execute even if the lost key turns up again. Off dev envs each member signs the same `act_proposal` command as an approval, with `\"action\":\"VoteReject\"`.",
      commands: [c.ownerProposals, c.ownerVoteReject],
    },
    {
      title: 'Replace the member',
      who: 'council (2 of 3)',
      detail:
        "The new member creates their account first (a Ledger key on mainnet). `council:replace-member` proposes `RemoveMemberFromRole` for the old member, then `AddMemberToRole` for the new one, signed by a remaining member (the old one never signs): read the plan without `--yes`. The removal goes first and cuts the key off; until the addition executes the council is 2 of 2, so both remaining members approve it straight away. Dev envs: add `--approve-with <second member>` to approve both in the same command; elsewhere it prints each remaining member's `act_proposal` for each proposal. Each executed change raises a critical `governance_change` (`owner_policy`): expected, acknowledge it.",
      commands: [c.councilReplaceMemberPlan, c.councilReplaceMember, c.ownerProposals],
    },
    {
      title: 'Update the manifest',
      who: 'a founder',
      detail: "Once both proposals executed, run `council:replace-member` again with `--yes` (on dev envs with `--approve-with` the first run already did): it checks the DAO's group is the new council at 2 of 3 and writes `council.members` in `envs/<env>.json`, the new member in the old one's place. Commit it (code-owner review); `deploy-contract` blocks until the DAO's policy is exactly the manifest's council at 2 of 3.",
      commands: [c.councilReplaceMember, c.governanceStatus, 'corepack pnpm --filter @hana-id/scripts run council-setup <env>', c.deployContractPlan],
    },
  ],
  verify: ['`admin <env> governance:status`: no findings (the policy is the manifest\'s council, 2 of 3 for every kind).', '`deploy-contract <env>` dry run without blockers (`council-setup <env>` dry run on dev envs).'],
  followUps: ['Mainnet: where the backup key is held is decided before mainnet (D81); record the replacement.'],
  refs: ['docs/operations.md#replacing-a-council-member', 'docs/operations.md#owner', 'docs/operations.md#owner-council-sputnik-dao-v2-d81', 'D81', 'D151'],
  related: ['unexpected-owner-action', 'governance-change'],
};

const unexpectedOwnerAction: Playbook = {
  id: 'unexpected-owner-action',
  title: 'Unexpected owner action: upgrade, owner transfer, withdrawal or another council call',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "A council call nobody on the council made: two council keys were used. Cancel what is pending, and use the governance delay to warn partners.",
  signals: ['A `governance_change` (or `config_change`, `unverifiable_key_change`, `forged_key_change` with `by` = the owner) that matches no proposal anyone explains.', 'A DAO proposal with approvals from members who didn\'t vote.'],
  impact: [
    "Two of three council keys act as the owner: after `governance_delay_ms` any upgrade (anything, including forging tokens), owner transfer or surplus withdrawal; at once config, pause/unpause, removing issuer keys and watchdogs, updater keys.",
    "Can't install a key or code faster than the governance delay; a pending upgrade, owner transfer or withdrawal is public and cancellable until then. Pause doesn't stop `execute_upgrade`.",
    "If the attacker really holds two keys they can re-propose after each cancel and reshape the DAO: from inside the council that can't be undone; the delay is the defence.",
  ],
  steps: [
    {
      title: 'Establish who voted',
      who: 'a founder',
      detail: 'The proposal\'s votes name the members; talk to each of them on a channel you trust.',
      commands: [c.ownerProposals, c.governanceStatus, c.apiGovernancePending],
    },
    {
      title: 'Reject open proposals nobody explained',
      who: 'council (2 of 3)',
      detail: "Before a second key approves them: each honest member casts a `VoteReject`; two rejections close a proposal for good.",
      commands: [c.ownerProposals, c.ownerVoteReject],
    },
    {
      title: 'Cancel what is pending',
      who: 'council (2 of 3)',
      detail: 'With the two honest keys, if there are two.',
      commands: [c.ownerCall('cancel_upgrade'), c.ownerCall('cancel_owner_proposal'), c.ownerCall('cancel_withdrawal')],
    },
    {
      title: 'Replace the compromised member',
      who: 'council (2 of 3)',
      detail: 'One key compromised: council-member-key. Two: there is no honest majority; go to the next step.',
    },
    {
      title: 'Warn partners and users within the delay',
      who: 'a founder',
      detail:
        "Before the pending action's executable time: partners' security contacts, and users told to export keys and move funds (D41). Not built yet: batch C's notice email to every org's security contacts and the pending-upgrades page (D86).",
    },
  ],
  verify: ['`get_governance()` has no pending upgrade, owner or withdrawal nobody made; `admin <env> governance:status`: no findings.'],
  followUps: ['Record the incident in `docs/decisions.md`; review how the keys were reached.'],
  refs: ['docs/governance-spec.md#what-each-party-can-do-after-this-batch', 'docs/operations.md#owner-actions-through-the-council', 'docs/contract-interface.md#upgrades', 'D81', 'D84', 'D86'],
  related: ['governance-change', 'council-member-key'],
};

const contractPaused: Playbook = {
  id: 'contract-paused',
  title: 'Contract paused (by the watchdog or by mistake): unpausing safely',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: 'Logins and derivation answer `503 paused`. Find who paused and why; unpause only once the cause is gone.',
  signals: ['`503 paused` (`retry-after: 60`) on `/v1/sessions`, `/v1/login`, `/v1/derive`; a `governance_change` alert for `paused`.', '`get_config().paused`, the `paused {by}` event.'],
  impact: [
    'Every login and derivation stops; revocation, vault share endpoints, cancels, governance, `execute_upgrade` and views still work. OIDC owner actions and `execute_change` fail on chain.',
    "Each unpause gives every pending scope change a full `change_delay_ms` again (`changes_unlock_floor_ms`): partners' legitimate changes wait longer.",
  ],
  steps: [
    {
      title: 'Find who paused',
      who: 'a founder',
      detail: "The `paused` event's `by`, or the watchdog's actions log. The watchdog pauses only on an active key Google doesn't publish: then follow forged-active-key (unpausing first only makes it pause again).",
      commands: [c.watchdogActions, c.governanceStatus],
    },
    {
      title: 'Check nothing forged is active',
      who: 'a founder',
      detail: "`governance:status` reports any active Google key Google's JWKS doesn't publish. A pause by mistake with no forged key needs no session floor.",
      commands: [c.governanceStatus],
    },
    {
      title: 'A watchdog pausing wrongly',
      who: 'council (2 of 3)',
      detail: 'A buggy or rogue watchdog that keeps pausing: cut its key off or remove it (watchdog-compromised).',
    },
    {
      title: 'Unpause',
      who: 'council (2 of 3)',
      detail: 'At once, no delay (D82). The API sees it within 10 s.',
      commands: [c.ownerCall('unpause')],
    },
  ],
  verify: ['`GET /v1/governance` `paused: false`; a smoke login works; no new pause at the next watchdog run.'],
  followUps: ['Tell partners when logins stopped and resumed, and that pending scope changes got a new timelock.'],
  refs: ['docs/operations.md#pause', 'docs/contract-interface.md#pause', 'D82', 'D86'],
  related: ['forged-active-key', 'watchdog-compromised'],
};

const googleJwksOutage: Playbook = {
  id: 'google-jwks-outage',
  title: "Google's JWKS unreachable, or a Google rotation stuck",
  kind: 'incident',
  severity: 'warning',
  status: 'live',
  summary: "Google's signing keys can't be fetched, or Google's new kid isn't active on chain yet: logins signed with that kid get `503 issuer_key_pending`.",
  signals: [
    '`503 issuer_key_pending` on logins (the vault retries once, then tells users to try again in a few minutes).',
    '`jwks_failing` from the watchdog; API `issuer_keys_unavailable`; a pending Add in `keyChanges` with `jwks: match` that isn\'t confirmed.',
  ],
  impact: [
    'Existing logins with active kids keep working (the API serves its JWKS cache up to 6 h stale on a fetch failure; the contract checks on-chain keys).',
    "A new Google kid can't be used until it is active: confirmed by a confirm-capable watchdog, or after `issuer_key_delay_ms` (or `governance_delay_ms` while no watchdog may confirm, or after a watchdog removal). Nothing can make it faster.",
  ],
  steps: [
    {
      title: 'See where the kid is',
      who: 'a founder',
      detail: "No pending change for it: the cron hasn't proposed (no `KEYS_UPDATER_KEY`, `send_failed`, `queue_full`). Pending with `jwks: match`: waiting for a confirmation or its executable time.",
      commands: [c.apiGovernance, c.apiGovernanceUpdater],
    },
    {
      title: 'Propose or execute it',
      who: 'anyone',
      detail: 'A founder syncs by hand (signs with the updater key); once due anyone may execute. The owner may post a key too, but it waits the same delay (D86).',
      commands: [c.postGoogleKeysDry, c.postGoogleKeys, c.postGoogleKeysExecute, c.executeIssuerKeyChange],
    },
    {
      title: 'Restore what blocks it',
      who: 'a founder',
      detail: 'A deleted updater key: install a fresh one (updater-key-stolen\'s Rotate step). A watchdog that can\'t confirm: confirm-failed / watchdog-cannot-act. A JWKS outage on Google\'s side: wait; nothing on Hana\'s side fixes it.',
    },
  ],
  verify: ['The kid is in `issuers`; logins with it succeed.'],
  followUps: ["Keep the issuer-key delay well under Google's measured lead time (`admin <env> issuer-keys:lead-times --remote`, D80)."],
  refs: ['docs/operations.md#google-signing-keys-jwks', 'docs/operations.md#issuer-key-lead-times-d33', 'D80', 'D86'],
  related: ['key-sync-stalled', 'confirm-failed', 'watchdog-degraded'],
};

const nearRpcOutage: Playbook = {
  id: 'near-rpc-outage',
  title: 'NEAR RPC outage',
  kind: 'incident',
  severity: 'warning',
  status: 'live',
  summary: "The manifest's `rpc` provider is down or wrong. The API reads only `rpc`; the vault, the export window and the watchdog fall back to `rpcFallback`.",
  signals: ['`502 near_unavailable` on API endpoints; `rpc_failing` from the watchdog (both its RPCs failed 3 runs).'],
  impact: [
    "Logins, derives and owner actions through the API fail while `rpc` is down. Users with an unlocked or persisted vault keep signing (no chain call needed for the key). A lying RPC can fail derives or refuse logins but can't forge a CKD result (pinned key, pairing check).",
  ],
  steps: [
    { title: 'Confirm it is the provider', who: 'a founder', detail: 'Check the provider\'s status and another provider.', commands: [c.apiHealth, c.apiTailErrors] },
    {
      title: 'Switch the API to another provider',
      who: 'a founder',
      detail:
        "Change `rpc` (and keep `rpcFallback` a different provider) in `envs/<env>.json` (code-owner review; https; testnet only: every script and the watchdog refuse another `chain_id`). The value is built into the vault and auth bundles and their CSP: regenerate, rebuild and redeploy the API and both page Workers, and the watchdog.",
      commands: [c.apiGen, c.apiDeploy, c.webBuild, c.pagesDeploy, c.watchdogGen, c.watchdogDeploy],
    },
  ],
  verify: ['`GET /v1/health` and a smoke login work; the watchdog\'s `rpc_failing` resolves.'],
  followUps: ['Not built yet: an API-side RPC fallback (the API reads only `NEAR_RPC`).'],
  refs: ['docs/operations.md#accounts-and-services-per-environment', 'docs/security.md#parties', 'D65'],
  related: ['watchdog-degraded'],
};

const mpcOutage: Playbook = {
  id: 'mpc-ckd-outage',
  title: 'NEAR MPC / CKD outage',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "The NEAR MPC network doesn't answer `request_app_private_key`: new logins can't derive keys. The MPC is NEAR's, not Hana's.",
  signals: ['`422 ckd_failed` on `/v1/login` and `/v1/derive` (the session is committed with its one use spent).', 'Derive latency far above the ~4.5 s MPC share.'],
  impact: [
    "New logins and derivations fail; users with an unlocked or persisted vault keep signing (their PRK is already on the device).",
    "Never change `mpc`, `ckdDomainId` or `ckdNetworkKey` to work around it: they are part of every user's address. A new MPC network key changes every address (can't be undone): that is a decision, not a fix.",
  ],
  steps: [
    { title: 'Confirm it is the MPC', who: 'a founder', detail: 'Request logs: `ckd_failed` and `relayOutcome` timings; NEAR\'s MPC status channels.', commands: [c.apiTailErrors] },
    { title: 'Tell partners', who: 'a founder', detail: 'Logins fail until the MPC recovers; persisted sessions keep working. Nothing on Hana\'s side restarts it.' },
    {
      title: 'If the MPC public key changed',
      who: 'a founder',
      detail: "Derives fail the pairing check against the pinned key. Read the key from ≥ 3 providers without writing (`--dry-run`); never re-pin without a recorded decision: it changes every address.",
      commands: [c.fetchCkdKeyDry],
    },
  ],
  verify: ['A smoke login derives; `ckd_failed` stops in the logs.'],
  followUps: [],
  refs: ['docs/security.md#trust-roots-in-one-paragraph', 'docs/api.md#relay-errors-any-relayed-call', 'docs/operations.md#accounts-and-services-per-environment', 'D100'],
};

const d1Loss: Playbook = {
  id: 'd1-data-loss',
  title: "The API's D1 lost or corrupted",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "The API's D1 (apps, origins, settings, usage, vault shares, issuer-key sync state) is gone or wrong. The contract and every address are unaffected.",
  signals: ['`/v1/app` and vault pages fail for known publishable keys; `unknownKek` or missing-table errors; `admin app:list --remote` empty or wrong.'],
  impact: [
    "Every partner's logins stop (no app, no origins). Persisted logins can't be unlocked without their `vault_shares` rows: those users sign in again.",
    "Addresses, scopes and sessions live on chain and are unchanged.",
    "Recreating an app with `app:create` gives it a new app id and publishable key: partners must update their pages.",
  ],
  steps: [
    {
      title: 'Restore from Time Travel',
      who: 'a founder',
      detail: "D1 Time Travel restores any minute of the last 30 days (7 on the Free plan), in place. Note the current bookmark first (it undoes the restore), get the bookmark of a time before the loss, export the damaged state to `.secrets/` (it holds wrapped vault shares: 0600), then restore. Everything written after that point is lost, including suspensions and share revocations made since.",
      commands: [c.apiD1Bookmark, c.apiD1BookmarkAt, c.apiD1Export, c.apiD1Restore],
    },
    {
      title: 'Re-run what the restore undid',
      who: 'a founder',
      detail: "In order: apply the migrations (a point before a later migration has the older schema); re-apply security writes made since the point (`app:suspend`, `app:origins:remove`, and the revoke-all if every share was revoked since: before anything else); then the other app changes. A KEK rotated since: restored rows need the old key (`vault-kek <env> put --yes` sets both secrets from the files), else those users sign in again. The issuer-key cron rebuilds its own state from chain on its next run.",
      commands: [c.d1Migrate, c.appSuspend, c.appOriginsRemove, c.revokeAllShares, c.vaultKekPut],
    },
    {
      title: 'Without a restore: rebuild',
      who: 'a founder',
      detail: 'Past 30 days, or nothing to restore: re-apply the migrations, then re-create each app, its origins and settings from what partners and the audit trail say. Not built yet: a scheduled export of the apps tables kept outside Cloudflare.',
      commands: [c.d1Migrate, 'corepack pnpm --filter @hana-id/scripts run admin <env> app:create --name <name> --scope <scope_id> --origin <origin> --remote', c.appSettings],
    },
  ],
  verify: ['`admin <env> app:list --remote` matches the known apps; suspended apps are still suspended; a smoke login and a reload unlock work.'],
  followUps: ['Batch C moves the ledger to Neon with point-in-time restore (D73); the API\'s D1 still needs a backup kept beyond Time Travel\'s 30 days.', 'Rehearse a Time Travel restore on sandbox-dev (D152).'],
  refs: ['docs/operations.md#restoring-a-d1-database-time-travel', 'docs/architecture.md#data-stores', 'docs/operations.md#admin-cli-scriptsadmints', 'docs/operations.md#vault_kek', 'D152'],
  related: ['vault-kek-leaked', 'api-or-cloudflare-compromised'],
};

const partnerClientCompromised: Playbook = {
  id: 'partner-google-client-compromised',
  title: "A partner's own Google client compromised",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "Someone controls a partner's own Google OAuth client (e.g. added a redirect URI): they can get tokens with chosen nonces for that scope's users who sign in through them.",
  signals: ["The partner reports changes in their Google Cloud project, or logins in their scope Hana's vault didn't start."],
  impact: [
    "That scope's users who sign in through the attacker's flow: their keys in that scope are exposed (can't be undone: they move funds). Other scopes are unaffected.",
    "Hana can't remove a scope's client: only the scope's owners can.",
  ],
  steps: [
    {
      title: 'Remove the client from the scope',
      who: 'scope owners',
      detail:
        "`remove_client` is immediate (the client stops resolving to the scope at once; quarantined for `change_delay_ms`). Through `POST /v1/owner-actions` with a console token (no CLI yet), or on chain from any funded account as for `cancel_change` (`docs/operations.md` \"Cancelling a change when the API refuses\"). The last client can go only if the scope has `allow_shared`.",
    },
    { title: "Fix the Google Cloud project", who: 'scope owners', detail: 'Credentials, redirect URIs, JavaScript origins, project members.' },
    {
      title: 'Stop the app meanwhile if needed',
      who: 'a founder',
      detail: "Suspending the app (D1 only) stops logins through Hana's API and vault for it; it doesn't stop direct contract calls with the client's tokens. A system-wide pause is the last resort (every app).",
      commands: [c.appSuspend, c.appResume],
    },
  ],
  verify: ['`get_scope(<scope>)` no longer lists the client.'],
  followUps: ['A replacement client is added with a timelocked `propose_change(AddClient)`; addresses stay the same (same `sub`).'],
  refs: ['docs/security.md#what-a-compromise-gives', 'docs/operations.md#admin-cli-scriptsadmints', 'D11'],
  related: ['user-key-leaked', 'shared-google-client-compromised'],
};

const sharedClientCompromised: Playbook = {
  id: 'shared-google-client-compromised',
  title: "Hana's shared Google client or its Cloud project compromised",
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary: "Someone controls Hana's shared login client: isolation of every `allow_shared` scope is broken.",
  signals: ['Changes in Hana\'s Google Cloud project nobody made (redirect URIs, credentials, members).'],
  impact: [
    "Tokens with chosen nonces for every shared-login scope's users who sign in through the attacker's flow: their keys exposed (can't be undone). Own-client-only scopes are unaffected.",
    "Removing the shared client stops every shared-only scope's logins until a new shared client is in force (`change_delay_ms` later).",
  ],
  steps: [
    {
      title: 'Remove the shared client',
      who: 'council (2 of 3)',
      detail: '`set_shared_clients` without it: removals apply at once. Remove it from `sharedGoogleClientIds` in the manifest and `deploy-contract` plans exactly that.',
      commands: [c.deployContractPlan, c.deployContract],
    },
    { title: 'Secure the Cloud project', who: 'a founder', detail: 'Credentials, members, redirect URIs (only `{authOrigin}/login/callback`).' },
    {
      title: 'Add a new shared client',
      who: 'council (2 of 3)',
      detail: 'A new client id in `sharedGoogleClientIds`; `deploy-contract` sets it pending for `change_delay_ms`; register its redirect URI. Addresses don\'t change (the path has no client id).',
      commands: [c.deployContract],
    },
    { title: 'Tell partners', who: 'a founder', detail: 'Shared-only apps are down until the new client is in force; affected users move funds.' },
  ],
  verify: ['`get_config().shared_clients` lists only the new client once in force; a shared login works.'],
  followUps: [],
  refs: ['docs/security.md#what-a-compromise-gives', 'docs/contract-interface.md#shared-clients'],
  related: ['partner-google-client-compromised', 'user-key-leaked'],
};

const userKeyLeaked: Playbook = {
  id: 'user-key-leaked',
  title: "A user's key leaked or exposed",
  kind: 'incident',
  severity: 'warning',
  status: 'live',
  summary: "A user's derived key (PRK or a chain key) was exposed: it can't be revoked; the user moves funds to a key at another `key_index`.",
  signals: ['A user reports it, or they were in the window of an incident that exposed keys (forged active key, compromised pages, a compromised client).'],
  impact: [
    "Every chain and account under that `key_index` is exposed for good: the old key stays derivable by whoever can sign in as that user. Can't be undone.",
    'Rotation is not built: the vault fixes `keyIndex = 0` and nothing on chain marks an index retired.',
  ],
  steps: [
    { title: 'Move funds', who: 'the user', detail: "The user moves funds using a session at the old index to an address under another `keyIndex` (today only `apps/smoke`'s direct page sets one; values ≥ 2^31 are reserved). Not built yet: key rotation in the vault and SDK." },
  ],
  verify: ['Funds are at the new address.'],
  followUps: ['Key rotation hooks (`docs/batch-b-spec.md`) before mainnet.'],
  refs: ['docs/operations.md#a-users-leaked-key-key_index', 'docs/security.md#what-a-compromise-gives'],
};

const emailIssuerKey: Playbook = {
  id: 'email-issuer-key-compromised',
  title: 'Email-login issuer key compromised (planned)',
  kind: 'incident',
  severity: 'critical',
  status: 'planned',
  summary: "Email login isn't built (`docs/email-login-spec.md`). When it is: whoever can make Hana's email issuer key sign can mint email tokens for any `sub` and derive the wallet of any email user (and of accounts linked to one).",
  signals: [
    "Planned: the hourly CloudTrail reconciliation finds a `Sign` the issuer didn't log (critical); link-volume alerts; an IAM or KMS policy change alert. On testnet (Worker-secret key) there is no signing log: you notice only a leak of the Worker's secrets.",
  ],
  impact: [
    'At 1-of-1 the use of the real key isn\'t bounded on chain: it is detected and stopped. A key swap is bounded by governance (owner-posted only, `governance_delay_ms`, the watchdog\'s pinned thumbprints).',
  ],
  steps: [
    { title: 'Revoke the credential', who: 'a founder', detail: 'Mainnet plan: the issuer\'s AWS access key. Not built yet: `scripts/email-issuer.ts rotate-aws-key`.' },
    {
      title: 'Remove the key on chain',
      who: 'council (2 of 3)',
      detail: "Immediate: `remove_issuer_key` for the email provider and the primary kid; email logins continue on the standby key while a replacement waits its delay. Not built yet: the email issuer, so the provider id isn't final.",
    },
    {
      title: 'Retire sessions it opened',
      who: 'council (2 of 3)',
      detail: "`set_sessions_valid_from_ms` past the detection: it retires every session opened before it, Google ones too (every user logs in again).",
    },
  ],
  verify: ['Planned: the reconciliation shows no unlogged `Sign` after the cut-off.'],
  followUps: ['Turn this playbook live with the email issuer\'s own commands when it ships.'],
  refs: ['docs/email-login-spec.md#signing-key-staged', 'docs/email-login-spec.md#trust-statement', 'D121'],
  related: ['forged-active-key'],
};

const identitySigningKey: Playbook = {
  id: 'identity-signing-key-compromised',
  title: 'Identity token signing key compromised (testnet Worker-secret key)',
  kind: 'incident',
  severity: 'critical',
  status: 'live',
  summary:
    "Whoever holds an identity signing key can forge any user's identity token for any app, until the key is out of the JWKS. Switch to a key the incident didn't touch, unpublish the exposed ones, tell partners.",
  signals: [
    "The API Worker's secrets, `.secrets/<env>/identity-signing-key*.json` or the operator's machine were exposed; a partner reports a token they didn't expect (a valid signature for a session that never existed).",
    "Not built yet (build steps 7–8): the KMS `Sign` reconciliation against `identity_issuance_hourly` and the watchdog's JWKS pin check.",
  ],
  impact: [
    'Forged tokens pass at every partner that trusts the JWKS URL, as any user of any app (identity at partners: credits, referrals, their own accounts), until the key is removed and their JWKS caches refresh (≤ 10 min). No wallet, key or Hana API is reachable with a token.',
    "Tokens already accepted can't be recalled: partners must re-check what they granted in the window.",
  ],
  steps: [
    {
      title: 'Decide which keys are exposed',
      who: 'a founder',
      detail:
        "The standby is published but never uploaded (D177): a leak of the Worker's secrets or the Cloudflare account exposes only the active key (and a `next` key already switched in). A leak of `.secrets/<env>/` or the operator's machine exposes every key whose file was there, the standby included unless it was moved offline. Unless the incident provably touches only the active key, treat BOTH as exposed.",
      commands: [c.identityKeyShow],
    },
    {
      title: 'Only the active key exposed: switch to the standby',
      who: 'a founder',
      detail: "Uploads the standby into the free Worker slot and makes it the manifest's active kid. Put the manifest change in the repo, `gen`, deploy: new tokens are signed by the standby, which partners already trust.",
      commands: [c.identityKeySwitchStandby, c.apiGen, c.apiDeploy],
    },
    {
      title: 'Both keys exposed: retire the standby and rotate to a fresh key',
      who: 'a founder',
      detail: 'Unpublish the standby, generate and publish a fresh key, switch to it, deploy. Partners using the JWKS URL pick up the new kid at once (jose refetches on an unknown kid); partners that pin thumbprints need the new one from you.',
      commands: [c.identityKeyRetireStandby, c.identityKeyNext, c.identityKeySwitchNext, c.apiGen, c.apiDeploy],
    },
    {
      title: 'Unpublish the exposed active key',
      who: 'a founder',
      detail: "Removes it from the JWKS and deletes its Worker secret, after the deploy of the switch; its file is set aside for the post-mortem (never put it in the repo). Deploy: partners reject its tokens within 10 minutes. Don't wait the 2 h of a scheduled rotation.",
      commands: [c.identityKeyRetirePrevious, c.apiGen, c.apiDeploy],
    },
    {
      title: 'Tell partners',
      who: 'a founder',
      detail: 'Their security contacts: the `kid`, the window in which forged tokens may have been accepted, and what to re-check (emails recorded, credits granted, sessions opened). Pinning partners update their pins.',
    },
    {
      title: 'A new standby',
      who: 'a founder',
      detail: 'After a switch to the standby there is none: `next` publishes a new key (not uploaded); move its file offline and keep it as the next standby.',
      commands: [c.identityKeyNext],
    },
  ],
  verify: [
    "The API's JWKS lists no exposed kid, and a fresh mint's header `kid` is the new active key.",
    '`identity-key <env> show`: the active kid is in a Worker slot, no exposed kid is published.',
  ],
  followUps: ['If the Worker or the Cloudflare account was the way in: api-or-cloudflare-compromised. Before mainnet the key moves to AWS KMS (build step 7).'],
  refs: ['docs/operations.md#identity-token-keys', 'docs/security.md#what-a-compromise-gives', 'D177'],
  related: ['api-or-cloudflare-compromised'],
};

export const INCIDENT_PLAYBOOKS: readonly Playbook[] = [
  updaterKeyStolen,
  relayerKeyStolen,
  vaultKekLeaked,
  apiCompromised,
  originCompromised,
  watchdogDown,
  watchdogCompromised,
  councilMemberKey,
  unexpectedOwnerAction,
  contractPaused,
  googleJwksOutage,
  nearRpcOutage,
  mpcOutage,
  d1Loss,
  partnerClientCompromised,
  sharedClientCompromised,
  userKeyLeaked,
  emailIssuerKey,
  identitySigningKey,
];
