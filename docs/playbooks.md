# Recovery playbooks

Generated from `packages/playbooks` (D126) by `corepack pnpm --filter @hana-id/playbooks gen-docs`: edit the package,
not this file (a test fails when it is stale). Last verified against code: 2026-11-02 (branch `feat/email-login-5`).

One step-by-step guide for every watchdog alert kind and for every incident the watchdog does not raise. The admin
portal's "Security & monitoring" view renders the same playbooks (`docs/batch-c-spec.md`), and every watchdog
alert names its playbook (`Playbook: <id>` in the alert text, `playbook` in `GET /status` `alert_kinds`). What each
alert kind means: `docs/operations.md` "Watchdog alerts (runbook)".

## Before you start

- Testnet only. Placeholders in angle brackets (`<env>`, `<signer>`, `<apiUrl>`, `<member>`, …) come from `envs/<env>.json`; never type a mainnet account.
- Every `scripts` command prints its plan and sends nothing without `--yes`: run it once without `--yes` and read the plan before sending.
- Owner calls (`admin <env> owner:call …`) go through the manifest's owner: a 2-of-3 council proposal when `ownerKind` is `sputnik` (dev envs: add `--approve-with <second member>` to approve it in the same command; elsewhere each member signs the printed `act_proposal` command with their Ledger), or the owner account's keychain key.
- Never print, paste or log a key, token or secret file while following a playbook (CLAUDE.md); values go through pipes and files under `.secrets/` only.
- Acknowledging a watchdog alert stops only its 15-minute re-sends, never the first alert or a check.

## Index

| Playbook | Severity | Alert kinds |
|---|---|---|
| [Forged issuer key active: contract paused](#forged-active-key) | critical | `forged_active_key` |
| [Forged pending issuer key cancelled](#forged-key-change) | critical | `forged_key_change` |
| [Pending removal of a key Google still publishes](#published-key-removal) | critical | `published_key_removal` |
| [Pending key change for an issuer the watchdog cannot check](#unverifiable-key-change) | critical | `unverifiable_key_change` |
| [First run: an active key not in Google's JWKS](#unknown-active-key-first-run) | critical | `unknown_active_key_first_run` |
| [Governance change](#governance-change) | critical | `governance_change` |
| [The watchdog acted again for an open incident](#watchdog-acted-again) | critical | `automatic_action` |
| [A cancel, pause or updater-key deletion the watchdog sent failed](#protective-action-failed) | critical | `protective_action_failed` |
| [The watchdog can't act](#watchdog-cannot-act) | critical | `not_a_watchdog`, `watchdog_key_missing`, `wrong_network`, `pins_invalid` |
| [The watchdog is partly blind or mute](#watchdog-degraded) | warning | `rpc_failing`, `jwks_failing`, `heartbeat_failing`, `channel_not_configured` |
| [Google key sync stalled](#key-sync-stalled) | warning | `unexecuted_key_change`, `stale_active_key` |
| [Retired Google key proposed and cancelled](#retired-key-change) | warning | `retired_key_change` |
| [Active keys checked by kid only](#active-key-material-unavailable) | warning | `active_key_material_unavailable` |
| [Shared clients, sponsors or public registration changed](#config-change) | warning | `config_change` |
| [The watchdog's confirmation of a Google key failed](#confirm-failed) | warning | `confirm_failed` |
| [Key change confirmed, executed or cancelled (info)](#key-change-lifecycle) | info | `key_change_confirmed`, `key_change_executed`, `key_change_cancelled` |
| [A scheduled config change came into force (info)](#config-matured) | info | `config_matured` |
| [The watchdog's first run (info)](#watchdog-first-run) | info | `first_run` |
| [Relayer running out of funds (balance or a pool key's allowance)](#relayer-out-of-funds) | critical | `relayer_balance_critical`, `relayer_allowance_critical`, `relayer_pool_empty`, `relayer_balance_low`, `relayer_allowance_low` |
| [Email signer policy differs from the pins](#signer-policy-mismatch) | critical | `signer_policy_mismatch`, `signer_policy_transition` |
| [unrecorded_wallets is set outside a dev env](#unrecorded-wallets) | critical | `unrecorded_wallets` |
| [Hana's email JWKS differs from the pins](#email-jwks-mismatch) | warning | `email_jwks_mismatch` |
| [Link volume past its alarm threshold](#link-volume) | critical | `link_threshold_reached`, `link_volume_high`, `link_stats_unavailable` |
| [Pending email key change (info)](#self-issued-key-change) | info | `self_issued_key_change` |
| [`KEYS_UPDATER_KEY` stolen (API secrets leaked)](#updater-key-stolen) | critical | — |
| [A relayer key stolen (session pool or owner pool)](#relayer-key-stolen) | warning | — |
| [`VAULT_KEK` leaked (and routine rotation)](#vault-kek-leaked) | critical | — |
| [API Worker code or Hana's Cloudflare account compromised](#api-or-cloudflare-compromised) | critical | — |
| [Vault or auth origin compromised (domain or DNS)](#hana-origin-compromised) | critical | — |
| [Watchdog down (silent, heartbeat missing)](#watchdog-down) | critical | — |
| [Watchdog compromised (its Cloudflare account, `WATCHDOG_KEY` or status token)](#watchdog-compromised) | critical | — |
| [A council member's key lost or compromised](#council-member-key) | critical | — |
| [Unexpected owner action: upgrade, owner transfer, withdrawal or another council call](#unexpected-owner-action) | critical | — |
| [Contract paused (by the watchdog or by mistake): unpausing safely](#contract-paused) | critical | — |
| [Google's JWKS unreachable, or a Google rotation stuck](#google-jwks-outage) | warning | — |
| [NEAR RPC outage](#near-rpc-outage) | warning | — |
| [NEAR MPC / CKD outage](#mpc-ckd-outage) | critical | — |
| [The API's D1 lost or corrupted](#d1-data-loss) | critical | — |
| [A partner's own Google client compromised](#partner-google-client-compromised) | critical | — |
| [Hana's shared Google client or its Cloud project compromised](#shared-google-client-compromised) | critical | — |
| [A user's key leaked or exposed](#user-key-leaked) | warning | — |
| [Email-login issuer key compromised (planned)](#email-issuer-key-compromised) | critical (planned) | — |
| [Identity token signing key compromised (testnet Worker-secret key)](#identity-signing-key-compromised) | critical | — |
| [Identity token KMS signer misused (planned: staging and mainnet)](#identity-kms-signer-compromised) | critical (planned) | — |

## Alert playbooks

<a id="forged-active-key"></a>

### Forged issuer key active: contract paused

`forged-active-key` · critical · alert kinds: `forged_active_key`

A key Google doesn't publish, or an email key that isn't pinned, is active on chain: the watchdog paused the contract and deleted every updater key (D126). Recover in a fixed order: remove the key, raise the session floor, a fresh updater key, unpause.

**Signals**

- Critical `forged_active_key` page: "Active issuer key <kid>: …; paused, N updater key(s) deleted" (an email key: "Active email issuer key <kid>: its key is not pinned; …", `details.provider: email`, `details.reason` as in [forged-key-change](#forged-key-change)).
- Every login and derive answers `503 paused`; a `governance_change` alert for `paused` follows.
- The watchdog's actions log has `pause` and `delete_updater_key` rows with transaction hashes.

**Impact**

- While the key was active, anyone holding its private key could open sessions for any user's path (and derive their keys), and post OIDC-owner tokens and client proofs for any scope.
- Paused: logins and derivation stop for every app until the unpause. Revocation, cancels, governance and views still work.
- Sessions the forged key opened derive again after an unpause, for up to 24 h (`MAX_SESSION_MS`) with any `max_uses`, unless the session floor is raised first. Keys already derived through them can't be taken back: those users' keys are exposed and must be moved (see [user-key-leaked](#user-key-leaked)).

**Steps**

1. **Stay paused and acknowledge** (who: a founder). Acknowledge the page. The watchdog paused and deleted every updater key, and pauses again (and deletes any updater key added) at every run while the key stays active. Don't unpause until the key is removed, the session floor raised and a fresh updater key installed, in that order.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   ```

2. **Remove the forged key** (who: council (2 of 3)). The owner removes the kid at once (`remove_issuer_key`, immediate; it also drops a pending change for that kid). For an email key use `"provider":"email"`: email logins continue on the other pinned key, if one is active.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call remove_issuer_key --args '{"provider":"<google | email>","kid":"<kid>"}' --yes
   ```

3. **Raise the session floor past the pause** (who: council (2 of 3)). `set_sessions_valid_from_ms` to the block time (ms) of the `paused` event + 1: the `pause` row in the watchdog's `GET /actions` has its transaction hash. Every session opened before the pause is then gone (`No such session`): users log in again. It can only be raised and never past the current block time.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call set_sessions_valid_from_ms --args '{"sessions_valid_from_ms":<pause block time ms + 1>}' --yes
   ```

4. **Install a fresh updater key** (who: council (2 of 3)). Only after the key is removed (an updater key added while the forged key is still active is deleted again by the watchdog). A founder moves the key file aside and runs `deploy-contract` (generates a new key, plans the owner's `add_updater_key` as a council proposal), then uploads it as `KEYS_UPDATER_KEY` (needs `apps/api/wrangler.jsonc` for the env).

   ```sh
   mv .secrets/<env>/keys-updater.json .secrets/<env>/keys-updater.revoked-<yyyymmdd>.json
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   ```

5. **Unpause** (who: council (2 of 3)). At once, no delay (D82). The unpause gives every pending scope change a full `change_delay_ms` again (`changes_unlock_floor_ms`), so OIDC owners can cancel changes the forged key's tokens proposed.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call unpause --yes
   ```

6. **Review scope changes made with forged tokens** (who: scope owners). Hana lists every `change_proposed` event since the forged key's `issuer_key_set` and tells each scope's owners; they cancel the ones they didn't make (`cancel_change`, through `POST /v1/owner-actions` or directly on chain). Hana can't cancel scope changes. Changes that already executed, and immediate actions by forged owner tokens (`remove_client`, `disable_shared_login`), are reverted by the scope's owners.

7. **Find how the key got there** (who: a founder). A delay that ran out while the watchdog was down ([watchdog-down](#watchdog-down)), an owner post ([unexpected-owner-action](#unexpected-owner-action)), or an upgrade. An email key: the council posted it and the pins didn't list it, or an upgrade's migrate installed it; if it is Hana's own key that was never pinned, fix the pins (`watchdog.pinnedIssuerKeys.email`, then redeploy the watchdog) before the unpause, or the next run pauses again. Fix that path before closing.

**Verify**

- `admin <env> governance:status`: no findings (no active Google key Google doesn't publish, not paused, the updater key tracked); the watchdog's `/status` `email` shows every active email kid pinned.
- `GET /v1/governance` shows `paused: false`; logins resume within 10 s (the API caches the pause state 10 s while paused).
- The watchdog's `forged_active_key` alert resolves at its next run and it doesn't pause again.
- `get_config().sessions_valid_from_ms` is past the pause.

**Follow-ups**

- Tell partners (their security contacts) what happened and which window their users' sessions were exposed in.
- Users who derived during the window: treat their keys as exposed ([user-key-leaked](#user-key-leaked)).
- Post-mortem: how the forged key reached the active set; record any rule change in `docs/decisions.md`.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#pause`](operations.md#pause), [`docs/contract-interface.md#pause`](contract-interface.md#pause), [`docs/email-login-spec.md#watchdog-appswatchdog`](email-login-spec.md#watchdog-appswatchdog), D82 (`docs/decisions.md`), D126 (`docs/decisions.md`), D190 (`docs/decisions.md`) · **See also:** [contract-paused](#contract-paused), [updater-key-stolen](#updater-key-stolen), [watchdog-down](#watchdog-down), [unexpected-owner-action](#unexpected-owner-action), [user-key-leaked](#user-key-leaked), [email-issuer-key-compromised](#email-issuer-key-compromised)

<a id="forged-key-change"></a>

### Forged pending issuer key cancelled

`forged-key-change` · critical · alert kinds: `forged_key_change`

A pending issuer key Google doesn't publish (or with other key material), an email key that isn't pinned for its signer, or a non-Google key the updater proposed: the watchdog cancelled it and, when the updater proposed it, deleted every updater key. A key Google published with the same material in the last 24 h is a [retired-key-change](#retired-key-change) instead (D153).

**Signals**

- Critical `forged_key_change` page (paging app, Slack, email), re-sent every 15 min until acknowledged. The title and `details.outcome` say what happened: `cancelled`, `gone` (someone else cancelled it first), `executed` (it took effect before the cancel), `unknown`, `failed` or `not_sent`.
- `details.by` is the proposer: the signer account means `KEYS_UPDATER_KEY`; the owner means the council. `reason: updater_other_provider`: the updater proposed a key for a provider other than Google (it only serves Google).
- `provider: email` (only the owner can post email keys, so the council proposed it): `reason` is `not_pinned` (its thumbprint isn't in `watchdog.pinnedIssuerKeys.email`; `details.pinned: false` means nothing is pinned at all), `pins_unreadable` (the pins themselves are broken: a `pins_invalid` page names it, see [watchdog-cannot-act](#watchdog-cannot-act)), `bad_material` (on-chain `n`/`e` that can't be hashed), `other_signer` (pinned for another signer), `kid_not_thumbprint` or `no_signer` (the email issuer isn't self-issued). `details.thumbprint` is the key's RFC 7638 thumbprint.
- The API cron logs `jwks_sync_note` `unpublished_change` / `pending_mismatch` (error) while it is pending, then `issuer_key_change_cancelled`, and `jwks_tx` `send_failed` once its updater key is gone.

**Impact**

- Whoever proposed it holds a key that can propose issuer keys. Had the forged key gone live, its holder could mint Google tokens for any `sub` and derive any user's key in any scope.
- With the updater keys deleted the API cron can't propose or execute Google's rotations: Google's next kid waits until a fresh updater key is in (logins signed with it get `503 issuer_key_pending`).

**Steps**

1. **Read what happened** (who: a founder). Acknowledge the page (it stops only the re-sends). Read `details.outcome` and `details.by` in the watchdog's alert history. `executed`: the key is active and the same run paused the contract: go to [forged-active-key](#forged-active-key) now. `failed`, `not_sent` or `unknown`: the change may still be pending: step 2 at once.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" 'https://<workerName>.<subdomain>.workers.dev/alerts?severity=critical'
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   ```

2. **Cancel the change if it is still pending** (who: council (2 of 3)). If `keyChanges` still lists it, the owner cancels it before its `executableAtMs` (the watchdog normally has; the owner may cancel any pending key change).

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

3. **Delete the updater keys if the watchdog didn't** (who: council (2 of 3)). When the signer account proposed it, every key in `updater_keys` must go (the watchdog deletes them itself; `protective_action_failed` says when it could not). `governance:status` lists the signer keys.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call delete_updater_key --args '{"public_key":"<ed25519:…>"}' --yes
   ```

4. **Find the leak** (who: a founder). Signer account as proposer: `KEYS_UPDATER_KEY` is stolen. It lives in the API Worker's secrets and `.secrets/<env>/keys-updater.json`: follow [updater-key-stolen](#updater-key-stolen) (and [api-or-cloudflare-compromised](#api-or-cloudflare-compromised) if the Worker or the Cloudflare account is how it leaked). Owner as proposer: the proposal needed two council votes: follow [unexpected-owner-action](#unexpected-owner-action).

5. **An email key that should have been pinned** (who: a founder). If the council meant to post a new email key (a rotation, or the first keys of batch 6), the pins were not updated first: the watchdog's pins come from its own manifest, never from chain or Hana's JWKS. Check the thumbprint against the key the issuer was given (`details.thumbprint`), add it under its signer in `watchdog.pinnedIssuerKeys.email`, regenerate and redeploy the watchdog, then the council posts the key again (it waits `governance_delay_ms`). Never pin a thumbprint you can't trace to Hana's own key.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

6. **Install a fresh updater key** (who: council (2 of 3)). A founder moves the old key file aside (never re-add a key that may be compromised) and runs `deploy-contract`, which generates a new key into `.secrets/<env>/keys-updater.json` and plans the owner's `add_updater_key` (a council proposal; dev envs add `--approve-with <member>`). Then a founder uploads it as `KEYS_UPDATER_KEY` from the repo root (needs `apps/api/wrangler.jsonc` for the env: `gen <env>`; the documented pipe can print a key fragment on a malformed file, security sweep OPER-5: check the file first).

   ```sh
   mv .secrets/<env>/keys-updater.json .secrets/<env>/keys-updater.revoked-<yyyymmdd>.json
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   ```

7. **Re-sync Google's keys** (who: the API cron). The 15-min cron proposes Google kids that are neither active nor pending again (a proposal of ours that was cancelled is held 1 h). To sync at once a founder runs `post-google-keys` (it signs with the updater key only).

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env>
   ```

**Verify**

- `admin <env> governance:status` shows no findings: no pending Google Add that Google's JWKS doesn't publish, exactly the tracked updater key(s) with the updater methods.
- `GET /v1/governance` `.updater` shows a clean last cron run, and Google's next rotation is confirmed by the watchdog (`key_change_confirmed`).
- The watchdog's `/status` has no open `forged_key_change` for this change.

**Follow-ups**

- Write down how the key leaked and what closed the hole; a decision in `docs/decisions.md` if a rule changed.
- Keep the old key file (`keys-updater.revoked-<date>.json`) only until its deletion on chain is confirmed, then delete it.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#keys-updater-key`](operations.md#keys-updater-key), [`apps/watchdog/README.md#what-a-run-does-every-5-min`](../apps/watchdog/README.md#what-a-run-does-every-5-min), D82 (`docs/decisions.md`), D126 (`docs/decisions.md`) · **See also:** [forged-active-key](#forged-active-key), [updater-key-stolen](#updater-key-stolen), [unexpected-owner-action](#unexpected-owner-action)

<a id="published-key-removal"></a>

### Pending removal of a key Google still publishes

`published-key-removal` · critical · alert kinds: `published_key_removal`

Someone proposed removing an issuer kid Google still publishes. The watchdog only alerts (D82): the owner decides and cancels.

**Signals**

- Critical `published_key_removal` page: "Pending removal of <kid>, which Google still publishes".
- The API cron logs `jwks_sync_note` `removal_of_published_kid`.

**Impact**

- If it executes, logins with tokens signed by that kid fail until the updater re-proposes it and it waits out the issuer-key delay. It can never remove the last key.
- A removal the updater (the signer account) proposed means `KEYS_UPDATER_KEY` is stolen (the API cron only proposes removals of kids missing from Google's JWKS for ≥ 55 min).

**Steps**

1. **Check who proposed it and whether it is intended** (who: a founder). Read `details.by` and the change id. Check Google's JWKS still lists the kid (`keyChanges` shows the verdict). An intended removal is rare: ask the council.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   ```

2. **Cancel it** (who: council (2 of 3)). Unless intended, the owner cancels it before its `executableAtMs`.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

3. **Treat the proposer as compromised** (who: a founder). Signer account as proposer: follow [updater-key-stolen](#updater-key-stolen) (the watchdog doesn't delete updater keys for a removal). Owner as proposer: [unexpected-owner-action](#unexpected-owner-action).

**Verify**

- The change is gone from `keyChanges`; the watchdog resolves the alert at its next run.
- `admin <env> governance:status`: no findings.

**Follow-ups**

- If it executed anyway: re-propose the kid (`post-google-keys <env>`) and expect `issuer_key_pending` for that kid until it is active again.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#google-signing-keys-jwks`](operations.md#google-signing-keys-jwks), D82 (`docs/decisions.md`) · **See also:** [updater-key-stolen](#updater-key-stolen), [unexpected-owner-action](#unexpected-owner-action)

<a id="unverifiable-key-change"></a>

### Pending key change for an issuer the watchdog cannot check

`unverifiable-key-change` · critical · alert kinds: `unverifiable_key_change`

The owner proposed a key change for an issuer other than Google and email: the watchdog has neither a JWKS nor pins for it and only alerts.

**Signals**

- Critical `unverifiable_key_change` page: "Pending <op> of <provider> key <kid>: no JWKS known for <provider> (alert only)".

**Impact**

- A key for another issuer, once active, lets its holder mint that issuer's tokens: every scope with a client of that issuer is exposed. Only the owner can propose one (an updater proposal for another provider is a `forged_key_change`), so it needed two council votes.

**Steps**

1. **Check it with the whole council** (who: a founder). Ask every council member whether they proposed it; compare the key with the issuer's published keys by hand.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   ```

2. **Cancel anything unexpected** (who: council (2 of 3)). Before its executable time.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

3. **If nobody proposed it** (who: a founder). Two council keys were used: follow [unexpected-owner-action](#unexpected-owner-action).

**Verify**

- The change is gone from `keyChanges` (or verified and intended); the alert resolves at the next run.

**Follow-ups**

- Email keys are judged against the pins instead ([forged-key-change](#forged-key-change), [self-issued-key-change](#self-issued-key-change)). Another new issuer added on purpose needs its own watchdog rules first.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), D82 (`docs/decisions.md`) · **See also:** [unexpected-owner-action](#unexpected-owner-action), [email-issuer-key-compromised](#email-issuer-key-compromised)

<a id="unknown-active-key-first-run"></a>

### First run: an active key not in Google's JWKS

`unknown-active-key-first-run` · critical · alert kinds: `unknown_active_key_first_run`

At its first run (empty D1) the watchdog found an active kid that Google doesn't publish today, or with other key material. It records it and doesn't pause.

**Signals**

- Critical `unknown_active_key_first_run` page, right after a watchdog deploy (or after its D1 was emptied).
- `details.reason`: `not_in_jwks` (often an old kid Google dropped) or `other_key_material`.

**Impact**

- `not_in_jwks`: usually harmless history, but the watchdog can't tell a dropped Google kid from a forged one. `other_key_material`: a present forgery: the next run pauses unless the owner removes it.

**Steps**

1. **Check the kid against Google's history** (who: a founder). Compare the kid and its `n`/`e` with what the API recorded (`admin <env> issuer-keys:lead-times --remote` lists every kid it has seen) and with Google's JWKS.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> issuer-keys:lead-times --remote
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   ```

2. **Remove it if it isn't Google's** (who: council (2 of 3)). Immediate. Check `issuers` first: the owner may remove an issuer's last key (that stops every login, DoS only).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call remove_issuer_key --args '{"provider":"google","kid":"<kid>"}' --yes
   ```

3. **A forgery: treat it as an active forged key** (who: a founder). With other key material, or if it was never Google's: follow [forged-active-key](#forged-active-key) from its step 2 (the session floor) as well, since sessions it opened may still derive.

4. **An unexpected first run** (who: a founder). A first run on a watchdog that ran before means its D1 was emptied or replaced: follow [watchdog-compromised](#watchdog-compromised).

**Verify**

- `admin <env> governance:status`: no active Google key that Google's JWKS doesn't publish.
- The next watchdog runs raise no `forged_active_key`.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#setting-it-up-once-per-env`](operations.md#setting-it-up-once-per-env), [`apps/watchdog/README.md#what-a-run-does-every-5-min`](../apps/watchdog/README.md#what-a-run-does-every-5-min) · **See also:** [forged-active-key](#forged-active-key), [watchdog-first-run](#watchdog-first-run), [watchdog-compromised](#watchdog-compromised)

<a id="governance-change"></a>

### Governance change

`governance-change` · critical · alert kinds: `governance_change`

An upgrade, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, a pause or unpause, a raised session floor, the owner DAO's code or policy, or the owner's immediate issuer actions. Alert only: confirm the council meant it.

**Signals**

- Critical `governance_change` page with one line per change (`field: before -> after`, lists as removed / added).
- Fields: `pending_upgrade`, `owner`, `pending_owner`, `pending_withdrawal`, `watchdogs`, `updater_keys`, the delays, `console_audiences`, `paused`, `unpaused_at_ms`, `sessions_valid_from_ms`, `owner_code_hash`, `owner_policy`, `issuer`, `issuer_keys`, `email_issuer`, `email_issuer_keys`, `email_signer_policy`, `unrecorded_wallets`, `mpc`, `ckd_domain_id`, `state_version`.

**Impact**

- Every owner action on `hana-signer` needs two council votes, so an unexpected one means two council keys acted. Upgrades, owner transfers and withdrawals wait `governance_delay_ms` (72 h on mainnet): that is the window to cancel and to warn partners.
- A changed `mpc` or `ckd_domain_id` (only possible through an upgrade) changes every user's address.

**Steps**

1. **Match each line with a council action** (who: a founder). Find the council proposal that made it (`owner:proposals`, its votes) and ask the members who voted. Expected changes (a drill, a member change, a planned upgrade): acknowledge. A `paused` change: follow [contract-paused](#contract-paused). An `owner_policy` change during a planned member change: [council-member-key](#council-member-key).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   ```

2. **Undo what nobody meant** (who: council (2 of 3)). `cancel_upgrade`, `cancel_owner_proposal`, `cancel_withdrawal`, a delay change back (increases apply at once), `remove_watchdog` / `add_watchdog`, `delete_updater_key`. Nobody but the owner can cancel an upgrade (D84). Then follow [unexpected-owner-action](#unexpected-owner-action): treat the council as compromised.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_upgrade --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_owner_proposal --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_withdrawal --yes
   ```

3. **A removed Google kid Google still publishes** (who: a founder). `issuer_keys` lost a kid without a queued removal (`remove_issuer_key`): logins signed with it break until the updater re-proposes it and it waits the issuer-key delay.

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env>
   ```

4. **A DAO policy that is no longer 2 of 3** (who: a founder). `owner_policy` or `owner_code_hash` changed: `deploy-contract` now blocks on every run and `governance:status` reports it. Unless it was a planned member change, the council itself was reshaped: follow [unexpected-owner-action](#unexpected-owner-action).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   ```

**Verify**

- `admin <env> governance:status`: no findings, nothing pending that nobody proposed.
- Every line of the alert is matched to a council proposal or reverted.

**Follow-ups**

- Upgrades on mainnet: the reproducible build hash, commit and command are published before the proposal (D86): check the pending hash against it.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#owner-actions-through-the-council`](operations.md#owner-actions-through-the-council), [`docs/contract-interface.md#monitoring-hand-off-batch-c-admin-portal`](contract-interface.md#monitoring-hand-off-batch-c-admin-portal), D84 (`docs/decisions.md`), D85 (`docs/decisions.md`), D86 (`docs/decisions.md`) · **See also:** [unexpected-owner-action](#unexpected-owner-action), [contract-paused](#contract-paused), [council-member-key](#council-member-key)

<a id="watchdog-acted-again"></a>

### The watchdog acted again for an open incident

`watchdog-acted-again` · critical · alert kinds: `automatic_action`

The watchdog repeated a protective action for an incident it already alerted: the incident is not over.

**Signals**

- Critical `automatic_action` page: "Paused again: active key <kid>", "Automatic action for active key <kid>: delete_updater_key", or "Automatic action for forged change <id>: …".

**Impact**

- A forged key is still active (the contract was unpaused, or a new updater key was added, before the key was removed), or the same forged change is still being acted on.

**Steps**

1. **Find the incident** (who: a founder). The title names the kid or change. Open the original `forged_active_key` or `forged_key_change` alert and its actions.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" 'https://<workerName>.<subdomain>.workers.dev/alerts?severity=critical'
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   ```

2. **Recover in order** (who: council (2 of 3)). Active key: follow [forged-active-key](#forged-active-key) in its order (remove the key, raise the session floor, a fresh updater key, unpause). Unpausing or adding an updater key first only makes the watchdog undo it.

**Verify**

- No new `automatic_action` at the next runs; the original alert resolves.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), D126 (`docs/decisions.md`) · **See also:** [forged-active-key](#forged-active-key), [forged-key-change](#forged-key-change)

<a id="protective-action-failed"></a>

### A cancel, pause or updater-key deletion the watchdog sent failed

`protective-action-failed` · critical · alert kinds: `protective_action_failed`

The watchdog tried to protect the contract and the transaction failed, or a forged change it tried to cancel had already executed.

**Signals**

- Critical `protective_action_failed` page: "Deleting updater key <pk> failed", "Pausing for active key <kid> failed", or a cancel outcome (`executed`, `unknown`, `failed`).
- The watchdog's actions log has the failed row with its error.

**Impact**

- The forged key change may still execute, the forged active key may still be live, or a stolen updater key may still be installed: the protection the watchdog exists for is missing.

**Steps**

1. **Do it through the owner at once** (who: council (2 of 3)). Whichever failed: cancel the change, pause, delete the updater key. `executed`: the key is active: follow [forged-active-key](#forged-active-key) (the same run should have paused; pause by hand if not).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call pause --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call delete_updater_key --args '{"public_key":"<ed25519:…>"}' --yes
   ```

2. **Fix the watchdog's ability to act** (who: a founder). Read the error in `GET /actions`. Usual causes: `WATCHDOG_KEY`'s 1 NEAR allowance is spent, the RPC failed, the account is no longer a watchdog. Follow [watchdog-cannot-act](#watchdog-cannot-act).

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

**Verify**

- `admin <env> governance:status`: the change gone, the contract paused if a forged key is active, no untracked signer keys.
- The alert resolves at the next run.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`apps/watchdog/README.md#what-a-run-does-every-5-min`](../apps/watchdog/README.md#what-a-run-does-every-5-min) · **See also:** [forged-active-key](#forged-active-key), [forged-key-change](#forged-key-change), [watchdog-cannot-act](#watchdog-cannot-act)

<a id="watchdog-cannot-act"></a>

### The watchdog can't act

`watchdog-cannot-act` · critical · alert kinds: `not_a_watchdog`, `watchdog_key_missing`, `wrong_network`, `pins_invalid`

Its account isn't a contract watchdog, its key is missing or malformed, or its RPC is on another chain: it can alert at most, never cancel or pause. Or its email pins are unreadable: it then cancels or pauses on every email key (fail closed).

**Signals**

- Critical `not_a_watchdog`, `watchdog_key_missing`, `wrong_network` or `pins_invalid` (condition alerts: open until a run no longer sees them).
- `/status` `last_run.checks`: `watchdog_role` or `config` not ok. With `pins_invalid`, email key alerts carry `reason: pins_unreadable`.

**Impact**

- Until fixed nothing cancels a forged pending key or pauses on a forged active one; with `wrong_network` nothing is sent at all. Google's rotations also wait their full delay (no confirmations).

**Steps**

1. **Watch the queue by hand meanwhile** (who: a founder). Check pending key changes at least hourly; any pending Add Google doesn't publish (`jwks: absent` / `mismatch`): the council cancels it.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

2. **`not_a_watchdog`: add it again** (who: council (2 of 3)). `deploy-contract` plans `add_watchdog` for every manifest `watchdogs` account that exists (a council proposal). Cancel and pause powers start at once, confirm power after `governance_delay_ms`. A removal nobody planned also raised a `governance_change`: follow [unexpected-owner-action](#unexpected-owner-action).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

3. **`watchdog_key_missing`: restore the key** (who: a founder). `secrets <env> check` names what is missing. If `WATCHDOG_KEY` is in the file, upload the file again; if it was lost, `init` creates a new one and prints the near CLI command that adds it to `watchdog.account` (run it), then upload. Delete a lost key on chain once the new one works.

   ```sh
   corepack pnpm --filter @hana-id/watchdog secrets <env> check
   corepack pnpm --filter @hana-id/watchdog secrets <env> init
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   ```

4. **`wrong_network`: fix the RPC** (who: a founder). The manifest `rpc` (or `rpcFallback`) answers another `chain_id`. Fix `envs/<env>.json` (code-owner review), regenerate the watchdog config and redeploy it, logged in to the watchdog's Cloudflare account.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

5. **`pins_invalid`: regenerate the pins** (who: a founder). `EMAIL_PINS` doesn't parse, so no email key counts as pinned: pending email keys are cancelled and an active one pauses (D190). `gen` writes it from `watchdog.pinnedIssuerKeys.email`, which the schema validates: a broken value was set by hand or by a broken deploy. Regenerate and redeploy; if the watchdog paused on Hana's own keys meanwhile, the council unpauses once the next run is clean, and re-posts any email key it cancelled.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

**Verify**

- `/status` `last_run.outcome: "ok"` with every check ok; the condition alert resolves.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`docs/operations.md#setting-it-up-once-per-env`](operations.md#setting-it-up-once-per-env), [`docs/contract-interface.md#watchdogs`](contract-interface.md#watchdogs) · **See also:** [watchdog-down](#watchdog-down), [watchdog-compromised](#watchdog-compromised), [protective-action-failed](#protective-action-failed)

<a id="watchdog-degraded"></a>

### The watchdog is partly blind or mute

`watchdog-degraded` · warning · alert kinds: `rpc_failing`, `jwks_failing`, `heartbeat_failing`, `channel_not_configured`

Chain reads or Google's JWKS fetch failed 3 runs in a row, the dead-man's switch ping fails, or an alert channel has no credentials.

**Signals**

- Warning `rpc_failing`, `jwks_failing`, `heartbeat_failing` or `channel_not_configured` (Slack and email).
- sandbox-dev reports `channel_not_configured` on every run until its channels and the heartbeat are set (`docs/operations.md` "Watchdog service").

**Impact**

- `rpc_failing`: no checks or actions while it lasts. `jwks_failing`: no confirmations (rotations wait their full delay) and no forgery verdicts (a missing kid needs two successful fetches). `heartbeat_failing`: the dead-man's switch will page as if the watchdog were dead. `channel_not_configured`: one alert path fewer (D85 relies on three).

**Steps**

1. **RPC** (who: a founder). Both `rpc` and `rpcFallback` failed. A provider outage: follow [near-rpc-outage](#near-rpc-outage) (the watchdog reads its RPC from the manifest: `gen` and redeploy after a change).

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

2. **Google's JWKS** (who: a founder). A Google-side outage or a network block on the watchdog: follow [google-jwks-outage](#google-jwks-outage).

3. **Heartbeat or a channel** (who: a founder). `secrets <env> check` names the missing credentials; paste them into `.secrets/<env>/watchdog-secrets.json` (never print them) and upload the file. A heartbeat provider outage needs nothing here.

   ```sh
   corepack pnpm --filter @hana-id/watchdog secrets <env> check
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   ```

**Verify**

- The condition alert resolves at the next run; `/status` shows every channel `configured` and `heartbeat.ok`.

**Follow-ups**

- A dead watchdog is caught by the dead-man's switch, not by these alerts: see [watchdog-down](#watchdog-down).

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), [`apps/watchdog/README.md#alerts-d85`](../apps/watchdog/README.md#alerts-d85) · **See also:** [near-rpc-outage](#near-rpc-outage), [google-jwks-outage](#google-jwks-outage), [watchdog-down](#watchdog-down)

<a id="key-sync-stalled"></a>

### Google key sync stalled

`key-sync-stalled` · warning · alert kinds: `unexecuted_key_change`, `stale_active_key`

A matured key change nobody executed for over 1 h, or an active kid Google dropped more than 3 h ago that nobody proposed to remove.

**Signals**

- Warning `unexecuted_key_change` or `stale_active_key`.
- API cron logs: `jwks_sync_skipped`, `jwks_tx` `send_failed`, `jwks_sync_note` `last_key_kept` / `queue_full`.

**Impact**

- Google's new key isn't active (its tokens get `503 issuer_key_pending`), or a key Google retired stays active longer than needed.

**Steps**

1. **Check the API cron** (who: a founder). It executes due changes and proposes removals every 15 min. A missing or deleted `KEYS_UPDATER_KEY` stops it (`jwks_sync_skipped`, `send_failed`): see the Keys-updater key runbook.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '.updater'
   corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
   ```

2. **Execute the due change now** (who: anyone). Any funded account may execute a matured change (the contract checks the delay); `post-google-keys --execute` does it with the updater key, additions first, and never executes a change Google disagrees with.

   ```sh
   near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --execute
   ```

3. **Propose the stale removal** (who: the API cron). The cron proposes removing a kid missing for ≥ 55 min (never the last key); a founder can run the same sync at once.

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env>
   ```

**Verify**

- `keyChanges` empty or not yet due; `issuers` matches Google's JWKS; the warning resolves.

**Refs:** [`docs/operations.md#google-signing-keys-jwks`](operations.md#google-signing-keys-jwks), [`docs/operations.md#common-failures`](operations.md#common-failures) · **See also:** [google-jwks-outage](#google-jwks-outage), [updater-key-stolen](#updater-key-stolen)

<a id="retired-key-change"></a>

### Retired Google key proposed and cancelled

`retired-key-change` · warning · alert kinds: `retired_key_change`

The updater proposed a key Google stopped publishing but did publish, with the same key material, within the last 24 h: the API cron's fetch raced Google's retirement of the kid (D153). The watchdog cancelled it and kept the updater keys.

**Signals**

- Warning `retired_key_change` (Slack, email): "Retired Google key <kid> proposed (change <id>): Google stopped publishing it after <time>; cancelled, updater key kept".
- `details.last_seen_jwks_at` is the watchdog's last fetch that listed the kid; `details.outcome` is `cancelled`, `gone`, `failed` (retried next run) or `not_sent`.

**Impact**

- None for logins: the key was Google's own, and the kid is retired. The API cron holds a re-proposal of a cancelled kid for 1 h and proposes only kids Google lists.

**Steps**

1. **Check it was a retirement** (who: a founder). Google's JWKS no longer lists the kid, and `details.n` matches what the watchdog recorded for it (`/status` `seen_kids`). Repeats for the same kid more than an hour apart, or any `forged_key_change`, are not a race: see [forged-key-change](#forged-key-change).

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" 'https://<workerName>.<subdomain>.workers.dev/alerts?severity=critical'
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   ```

**Verify**

- `keyChanges` no longer lists the change; `issuers` matches Google's JWKS.

**Refs:** [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), D153 (`docs/decisions.md`) · **See also:** [forged-key-change](#forged-key-change), [key-sync-stalled](#key-sync-stalled)

<a id="active-key-material-unavailable"></a>

### Active keys checked by kid only

`active-key-material-unavailable` · warning · alert kinds: `active_key_material_unavailable`

The contract has no `get_issuer_keys` (code older than the watchdog): a forged key under a kid Google really publishes isn't caught once active.

**Signals**

- Warning `active_key_material_unavailable` every run.

**Impact**

- The active-key check compares kids only; a key that went live with Google's kid but other material (while the watchdog was down, or through an upgrade) isn't paused on.

**Steps**

1. **Upgrade the contract to current code** (who: council (2 of 3)). `deploy-contract --upgrade` builds and proposes the hash through the council; after `governance_delay_ms` the same command with `--skip-build` executes it (anyone may execute). No address change.

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --upgrade --yes
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --upgrade --skip-build --yes
   ```

**Verify**

- The warning stops; `/status` `active_keys` check ok.

**Refs:** [`docs/operations.md#upgrading-the-governance-contract`](operations.md#upgrading-the-governance-contract), [`docs/contract-interface.md#issuers`](contract-interface.md#issuers)

<a id="config-change"></a>

### Shared clients, sponsors or public registration changed

`config-change` · warning · alert kinds: `config_change`

An owner config change the watchdog reports as a warning: the shared-client list, the sponsors, or public registration.

**Signals**

- Warning `config_change` with one line per field (`shared_clients`, `sponsors`, `public_registration`).

**Impact**

- A shared client added by someone else would let that client's tokens open sessions in every `allow_shared` scope once in force; a removed one stops shared logins. Sponsors decide who may pay registrations with function-call keys.

**Steps**

1. **Match it with a council action** (who: a founder). Every one of these needed two council votes.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   ```

2. **Revert what nobody meant** (who: council (2 of 3)). `deploy-contract` plans `set_shared_clients` and `set_sponsors` back to the manifest (shared-client removals apply at once, additions wait `change_delay_ms`). `enable_public_registration` can't be undone (one way; only an upgrade could). Then follow [unexpected-owner-action](#unexpected-owner-action).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

**Verify**

- `get_config()` (`governance:status --json` `config`) matches the manifest.

**Refs:** [`docs/contract-interface.md#shared-clients`](contract-interface.md#shared-clients), D86 (`docs/decisions.md`) · **See also:** [unexpected-owner-action](#unexpected-owner-action), [shared-google-client-compromised](#shared-google-client-compromised)

<a id="confirm-failed"></a>

### The watchdog's confirmation of a Google key failed

`confirm-failed` · warning · alert kinds: `confirm_failed`

A confirmation of a key change that matches Google's JWKS failed: the key still goes live, but only after the full issuer-key delay.

**Signals**

- Warning `confirm_failed` with the change and the error.
- Logins with the new kid get `503 issuer_key_pending` meanwhile.

**Impact**

- Users whose token is signed with Google's new kid can't log in until the change executes (the vault tells them to try again in a few minutes).

**Steps**

1. **Read the error** (who: a founder). Usual causes: the watchdog's confirm power hasn't started (`confirm_from_ms`, `governance_delay_ms` after `add_watchdog`), `WATCHDOG_KEY`'s allowance is spent, an RPC failure, or the change already left the queue.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   ```

2. **Restore the watchdog key's allowance** (who: a founder). An allowance spent: rotate `WATCHDOG_KEY` ([watchdog-compromised](#watchdog-compromised) step "Rotate WATCHDOG_KEY") with a fresh 1 NEAR key.

3. **Let it mature** (who: the API cron). The cron executes it at `executableAtMs`; anyone may execute it then.

   ```sh
   near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
   ```

**Verify**

- The kid is in `issuers`; the next confirmation succeeds (`key_change_confirmed`).

**Refs:** [`docs/operations.md#google-signing-keys-jwks`](operations.md#google-signing-keys-jwks), [`docs/contract-interface.md#watchdogs`](contract-interface.md#watchdogs) · **See also:** [google-jwks-outage](#google-jwks-outage), [watchdog-cannot-act](#watchdog-cannot-act)

<a id="key-change-lifecycle"></a>

### Key change confirmed, executed or cancelled (info)

`key-change-lifecycle` · info · alert kinds: `key_change_confirmed`, `key_change_executed`, `key_change_cancelled`

Routine: Google rotations confirmed by the watchdog, changes that took effect, and changes that left the queue without effect.

**Signals**

- Info alerts in `/status`, the portal and the daily digest.

**Impact**

- None for confirmations and executions that match Google.

**Steps**

1. **Check unexpected cancellations** (who: a founder). A `key_change_cancelled` that the watchdog didn't make (no `forged_key_change`) was the owner or another watchdog. A cancelled genuine Google key stalls that rotation (the API cron re-proposes it after a 1 h hold); one nobody on the council made: [unexpected-owner-action](#unexpected-owner-action), or [watchdog-compromised](#watchdog-compromised) for another watchdog.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   ```

**Verify**

- `issuers` matches Google's JWKS after a rotation.

**Refs:** [`docs/operations.md#google-signing-keys-jwks`](operations.md#google-signing-keys-jwks) · **See also:** [unexpected-owner-action](#unexpected-owner-action), [watchdog-compromised](#watchdog-compromised)

<a id="config-matured"></a>

### A scheduled config change came into force (info)

`config-matured` · info · alert kinds: `config_matured`

A delay decrease or a console-audience addition reached its effective time.

**Signals**

- Info `config_matured` (it was alerted critical as a `governance_change` when it was made).

**Impact**

- Shorter delays shorten everyone's reaction window; a new console audience may sign OIDC owner actions.

**Steps**

1. **Check it is still wanted** (who: a founder). Match it with the council proposal that scheduled it.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   ```

2. **Revert at once if not** (who: council (2 of 3)). A delay increase applies now; a console audience dropped from `set_console_audiences` stops counting now. Then [unexpected-owner-action](#unexpected-owner-action).

**Verify**

- `get_config()` matches the manifest.

**Refs:** [`docs/contract-interface.md#delays`](contract-interface.md#delays), D86 (`docs/decisions.md`) · **See also:** [unexpected-owner-action](#unexpected-owner-action)

<a id="watchdog-first-run"></a>

### The watchdog's first run (info)

`watchdog-first-run` · info · alert kinds: `first_run`

The first run with an empty D1 recorded Google's current JWKS as known.

**Signals**

- Info `first_run`; `/status` `last_run.first_run: true`.

**Impact**

- Expected right after a deploy. Anywhere else it means the watchdog lost its history: a forged active key present at that moment is only alerted, never paused (it is recorded as baseline).

**Steps**

1. **After a deploy: finish the setup checks** (who: a founder). `last_run.outcome: "ok"`, `heartbeat.ok`, every channel `configured`. Acknowledge the first-run critical alerts after checking them ([unknown-active-key-first-run](#unknown-active-key-first-run)). A test critical page to both founders: not built yet as a command; the forced-rotation drill does it for real.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

2. **Not after a deploy: investigate** (who: a founder). Its D1 was emptied or replaced: follow [watchdog-compromised](#watchdog-compromised). A restore of its D1 to a minute before (Time Travel, 30 days; operations "The watchdog's D1") brings its history back; until then this first run's baseline stands.

   ```sh
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>
   ```

**Verify**

- The next runs report `first_run: false` and every check ok.

**Refs:** [`docs/operations.md#setting-it-up-once-per-env`](operations.md#setting-it-up-once-per-env), [`docs/operations.md#the-watchdogs-d1`](operations.md#the-watchdogs-d1) · **See also:** [unknown-active-key-first-run](#unknown-active-key-first-run), [watchdog-compromised](#watchdog-compromised)

<a id="relayer-out-of-funds"></a>

### Relayer running out of funds (balance or a pool key's allowance)

`relayer-out-of-funds` · critical · alert kinds: `relayer_balance_critical`, `relayer_allowance_critical`, `relayer_pool_empty`, `relayer_balance_low`, `relayer_allowance_low`

The relayer account's available balance, or a pool key's remaining allowance, is below its threshold, or a pool has no key: relays from it fail when it runs out.

**Signals**

- Watchdog alerts (read-only check `relayer_funds`, every 5 min): `relayer_balance_low` (warning, < 5 NEAR available by default) and `relayer_balance_critical` (< 1 NEAR, or the account doesn't exist); `relayer_allowance_low` / `relayer_allowance_critical` per pool key (session pool < 0.5 / 0.1 NEAR of its 2 NEAR, owner pool < 0.1 / 0.02 NEAR of its 0.5 NEAR); `relayer_pool_empty` (no key of a pool for the signer). Thresholds: the manifest's `watchdog.relayerFunds`.
- `/status` `relayer_funds`: the last reading (available balance, each pool key with its allowance, the thresholds).
- Once it has run out: relays failing with `502 near_rejected` for one key or all; logins and derives fail for the apps routed to those keys.

**Impact**

- Session pool: logins and derives fail for the apps on a used-up key (all apps when the balance is gone). Owner pool: OIDC owner actions fail. No security impact.
- The watchdog only alerts: it holds no key on the relayer account and never tops anything up. The alerts resolve by themselves at the first run after the refill.

**Steps**

1. **Read what is low** (who: a founder). The alert's details name the account, the pool and the key (`public_key`), what is left and the thresholds; `/status` `relayer_funds` lists every pool key. A drop that the request logs (`relayInstance` per relay) don't explain: follow [relayer-key-stolen](#relayer-key-stolen). 3 keys × 2 NEAR covered ~1,500 logins on testnet; allowances drop by gas burnt.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
   ```

2. **Low balance: fund the relayer account** (who: a founder). Send NEAR to `<relayer>` from a funded testnet account (testnet only, never a mainnet account). `relayer_balance_critical` saying the account does not exist: create it again first (operations "Create an environment" step 1), then re-run `deploy-contract` for its keys.

   ```sh
   near tokens <funded testnet account> send-near <relayer> '<amount> NEAR' network-config testnet sign-with-legacy-keychain send
   ```

3. **Low allowance: replace the key** (who: a founder). Same as a leaked key: delete it on chain, remove it from its `.secrets` file, re-run `deploy-contract` (pass larger `--relayer-allowance` / `--owner-relayer-allowance` if needed, and the same flags on every later re-run), upload the pool. Delete the used-up key: left there it keeps its last allowance and its alert stays open.

   ```sh
   near account delete-keys <relayer> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   ```

4. **No key in a pool: add the pool again** (who: a founder). `deploy-contract` adds every key of `.secrets/<env>/relayer-keys.json` / `owner-relayer-keys.json` that isn't on chain. Only the relayer account's full-access key can delete keys: if nobody here did, treat that key as compromised (follow [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   ```

5. **Thresholds that no longer fit** (who: a founder). After raising the allowances (or for a busier env), set `watchdog.relayerFunds` in `envs/<env>.json` (NEAR; `balance`, `sessionAllowance`, `ownerAllowance`, each `{warn, critical}` with critical below warn), then regenerate the watchdog's config and redeploy it.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

**Verify**

- The next watchdog run resolves the alert (`/status` `open_alerts` without it; `relayer_funds` above the thresholds).
- Relays succeed; the request logs show no `near_rejected`.

**Follow-ups**

- A used-up key replaced: delete its line from the secrets file only after the on-chain deletion is confirmed.

**Refs:** [`docs/operations.md#relayer-keys-either-pool`](operations.md#relayer-keys-either-pool), [`docs/api.md#relay-errors-any-relayed-call`](api.md#relay-errors-any-relayed-call), [`apps/watchdog/README.md#what-a-run-does-every-5-min`](../apps/watchdog/README.md#what-a-run-does-every-5-min), D150 (`docs/decisions.md`) · **See also:** [relayer-key-stolen](#relayer-key-stolen), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)

<a id="signer-policy-mismatch"></a>

### Email signer policy differs from the pins

`signer-policy-mismatch` · critical · alert kinds: `signer_policy_mismatch`, `signer_policy_transition`

The email issuer on chain (`get_issuer("email")`, `get_self_issued("email")`) doesn't match the watchdog's pins. Weaker (paused) or unexplained (an email issuer with nothing pinned, a pre-v3 one): critical `signer_policy_mismatch`. Mid-way through a planned change and none of it weaker: warning `signer_policy_transition`.

**Signals**

- Critical `signer_policy_mismatch` page: "Email signer policy differs from the pins: <differences>; <weaker, paused | alert only>". `details.pinned` and `details.chain` show both sides.
- Weaker (D191): `required` below the pinned one, a signer the pins don't list, active email keys without a signer policy, or an overlap with the previous policy longer than the contract's 10 minutes (a `migrate` keeping a weaker policy valid). Then every login answers `503 paused`.
- Warning `signer_policy_transition` (no page, no pause): a pinned signer not in the policy yet, the gap between `set_issuer("email")` and `mark_self_issued("email")` (batch 6's setup), a higher `required` on chain than pinned, or an overlap of normal length after a policy upgrade. It resolves once pins and chain match.

**Impact**

- A weaker policy lets fewer signers (or a signer nobody pinned) mint email tokens, and so derive every email wallet and every wallet linked to one. The signer list and `required` change only through a governed upgrade (`migrate`, public for `governance_delay_ms`), so a weaker one means an upgrade nobody reviewed for this, or a compromised council.
- Not weaker (a pinned signer not in the policy yet, a higher `required`): nothing is at risk; the pins are ahead of or behind a planned upgrade.

**Steps**

1. **Read both sides** (who: a founder). Acknowledge. Compare `details.pinned` (from the watchdog's manifest) with `details.chain`. Find the council action or upgrade that changed the chain side (`owner:proposals`; a `governance_change` alert for `email_signer_policy`, `email_issuer` or `pending_upgrade` should precede it).

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   ```

2. **Planned change: bring the pins in line** (who: a founder). Level 1 (adding a co-signer): pin the new signer's keys first, with the current `required`; after the upgrade executes, raise the pinned `required` (D191). Replacing a signer: pin the new id's keys before the upgrade, drop the old id after. Edit `watchdog.pinnedIssuerKeys.email` in `envs/<env>.json`, regenerate the watchdog's config and redeploy it (the watchdog's own Cloudflare account). If it paused for a planned change, the council unpauses only after the pins match.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

3. **Nobody planned it: stay paused** (who: council (2 of 3)). A weaker policy can only come from an executed upgrade: follow [unexpected-owner-action](#unexpected-owner-action). Remove every email key that isn't Hana's own pinned key at once (`remove_issuer_key`, immediate), then raise the session floor past the pause before any unpause, as for a forged active key (follow [forged-active-key](#forged-active-key)).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call remove_issuer_key --args '{"provider":"email","kid":"<kid>"}' --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call set_sessions_valid_from_ms --args '{"sessions_valid_from_ms":<pause block time ms + 1>}' --yes
   ```

**Verify**

- The next run resolves the alert (`/status` `email.differences` empty) and doesn't pause again.
- `admin <env> governance:status`: no findings.

**Follow-ups**

- Record a planned policy change and its pin order in `docs/decisions.md`.

**Refs:** [`docs/email-login-spec.md#watchdog-appswatchdog`](email-login-spec.md#watchdog-appswatchdog), [`docs/email-login-spec.md#signing-key-staged`](email-login-spec.md#signing-key-staged), [`docs/operations.md#watchdog-alerts-runbook`](operations.md#watchdog-alerts-runbook), D121 (`docs/decisions.md`), D191 (`docs/decisions.md`) · **See also:** [forged-active-key](#forged-active-key), [unexpected-owner-action](#unexpected-owner-action), [email-issuer-key-compromised](#email-issuer-key-compromised)

<a id="unrecorded-wallets"></a>

### unrecorded_wallets is set outside a dev env

`unrecorded-wallets` · critical · alert kinds: `unrecorded_wallets`

`get_config().unrecorded_wallets` is true on an env that isn't a dev env (D139): the contract was migrated from pre-v3 state, so wallets derived before v3 aren't in `opened`. Links are refused until the owner accepts, and mainnet must never show it.

**Signals**

- Critical `unrecorded_wallets` page, every run while the flag is set (alert only; the watchdog calls nothing).
- Every link (automatic or explicit) panics `Links wait until the owner accepts the wallets opened before v3`.

**Impact**

- While set: no link can be made, so email login can't join a Google wallet (and vice versa); nothing else stops.
- If accepted blindly: a funded pre-v3 Google wallet counts as having no wallet, so a case-A link could join it silently to an email account (D135). On mainnet the signer is created with `new` on v3, so the flag is false from the start; seeing it there means the runbook was not followed.

**Steps**

1. **Find how the env got here** (who: a founder). Only a migration from pre-v3 state (`migrate`, `migrate_v1`) sets it. Check the env's upgrade history (`owner:proposals`, the `governance_change` alert for `state_version`). On a staging or production env this is a deviation from the mainnet runbook (`docs/email-login-spec.md` "Migration").

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   ```

2. **Decide whether pre-v3 wallets matter** (who: a founder). Accepting is only safe when every wallet derived before v3 is test data that will be discarded (as on sandbox-dev). Otherwise leave it set (links stay off) and plan a fresh signer created with `new` on v3.

3. **Accept, only if they are test data** (who: council (2 of 3)). One way: `accept_unrecorded_wallets` clears the flag (event `unrecorded_wallets_accepted`); the next watchdog run resolves the alert.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call accept_unrecorded_wallets --yes
   ```

**Verify**

- `get_config().unrecorded_wallets` is false; the watchdog resolves the alert at its next run.

**Follow-ups**

- Write down why the env was migrated rather than created with `new` (`docs/decisions.md`).

**Refs:** [`docs/email-login-spec.md#migration`](email-login-spec.md#migration), [`docs/contract-interface.md#accounts-and-links`](contract-interface.md#accounts-and-links), D135 (`docs/decisions.md`), D139 (`docs/decisions.md`) · **See also:** [governance-change](#governance-change), [unexpected-owner-action](#unexpected-owner-action)

<a id="email-jwks-mismatch"></a>

### Hana's email JWKS differs from the pins

`email-jwks-mismatch` · warning · alert kinds: `email_jwks_mismatch`

Hana's published email JWKS (`{apiUrl}/v1/email/jwks.json`) lists a key that isn't pinned, or lacks an active email key, or can't be fetched while email keys are active. Informational: the contract never reads it and the watchdog doesn't trust it.

**Signals**

- Warning `email_jwks_mismatch` (Slack, email): `details.problems` lists each key; `email_jwks_mismatch:fetch` after 3 failed fetches.

**Impact**

- No direct risk: logins check the keys on chain. A published key that isn't pinned means the issuer Worker holds (or advertises) a key the watchdog would cancel or pause on if the council posted it; a missing active key means the issuer and the chain disagree about which keys sign.

**Steps**

1. **Compare the three lists** (who: a founder). Pins (`watchdog.pinnedIssuerKeys.email`), the chain's active email kids (`/status` `email.chain.active_kids`) and the published JWKS. A rotation in progress (new key published before the council posts it) is expected: pin it before the post.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

2. **An unknown published key** (who: a founder). Nobody on the team added it: the issuer Worker or Hana's Cloudflare account may be compromised. Follow [email-issuer-key-compromised](#email-issuer-key-compromised) and [api-or-cloudflare-compromised](#api-or-cloudflare-compromised).

3. **Fetch failing** (who: a founder). The issuer Worker is down or its route moved (email logins then fail too). Check the issuer's deployment; if the URL changed on purpose, set `jwksUrl` in the pins and redeploy the watchdog.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

**Verify**

- The next run resolves the warning.

**Refs:** [`docs/email-login-spec.md#issuer-configuration`](email-login-spec.md#issuer-configuration), [`docs/email-login-spec.md#watchdog-appswatchdog`](email-login-spec.md#watchdog-appswatchdog), D190 (`docs/decisions.md`) · **See also:** [email-issuer-key-compromised](#email-issuer-key-compromised), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)

<a id="link-volume"></a>

### Link volume past its alarm threshold

`link-volume` · critical · alert kinds: `link_threshold_reached`, `link_volume_high`, `link_stats_unavailable`

The contract counts every new link per scope and in total per UTC hour and flags a scope (or the total) whose links reach its alarm threshold (D200; default 50 per scope, 500 in all). Nothing is refused: the links went through. A threshold reached is critical: a partner launch, or a stolen email key taking over Google wallets by linking. Half the total threshold is a warning.

**Signals**

- Critical `link_threshold_reached` (`:total:<hour>`, `:scope:<scope>:<hour>`, `:more_scopes:<hour>`), from `get_link_stats()` each run for the current and the previous hour, so a threshold reached between two runs is seen. It resolves once that hour is neither window (and stays open while the view can't be read).
- Warning `link_volume_high:<hour>`: the hour's links in all scopes reached half of `total_per_hour`. Warning `link_stats_unavailable`: `:missing` (an email issuer is on chain but the contract has no `get_link_stats`: deploy the D200 contract), `:malformed` (an answer of another shape: the watchdog and the contract disagree on the view, fix the watchdog's reader) or `:read_failed`. Only the link check is affected; cancels and pauses still run.
- `/status` `link_stats` has the thresholds, a pending raise and both windows.

**Impact**

- A stolen email signing key (1-of-1 at launch) can link an email identity it mints to a victim's Google identity at once (D119) and so derive the victim's wallet; each such takeover is one link, so a burst shows here. The links went through: the alarm is detection, the pause is the council's call.
- What the counter can't see: with the email key alone a thief can also log into email-rooted wallets, and into Google wallets that already have an email member, without making any link. The defence there is the key's custody (KMS, a second signer, D121), not this alarm.

**Steps**

1. **Check for a partner launch** (who: a founder). Ask the scope's partner whether they launched or migrated users this hour, and compare with the API's logins for the window. Many automatic links (case B) for Google-hosted addresses the partner can't explain, links in scopes with no traffic, or every scope at once point to a stolen email key.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" 'https://<workerName>.<subdomain>.workers.dev/alerts?severity=critical'
   ```

2. **Suspected key compromise: pause and rotate the email key** (who: council (2 of 3)). Pause at once (stops every login and derive), remove the email issuer key on chain (immediate), then follow [email-issuer-key-compromised](#email-issuer-key-compromised) for the credential, the session floor and the affected users, and [forged-active-key](#forged-active-key) for the recovery order before the unpause. A new key is pinned first and waits `governance_delay_ms` ([forged-key-change](#forged-key-change)).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call pause --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call remove_issuer_key --args '{"provider":"email","kid":"<kid>"}' --yes
   ```

3. **Only if the alarm level is wrong for real traffic: change the threshold** (who: council (2 of 3)). A launch needs nothing (its links went through). If ordinary traffic keeps crossing the alarm, the council changes the threshold with `set_link_thresholds` (an owner action; `admin <env> owner:call` once the scripts list it): lowering applies at once, raising waits `governance_delay_ms` (72 h on mainnet) and pages as a `governance_change` (`pending_thresholds`) when proposed.

**Verify**

- The next hours show `link_stats.current.total` under the thresholds and the alerts resolve after the window passes.
- A compromise: the email key is gone from `get_issuer("email")` and the contract stays paused until the recovery order is done.

**Follow-ups**

- Tune the provisional thresholds (D200) from sandbox-dev and staging traffic before mainnet.

**Refs:** [`docs/email-login-spec.md#watchdog-appswatchdog`](email-login-spec.md#watchdog-appswatchdog), [`docs/email-login-spec.md#trust-statement`](email-login-spec.md#trust-statement), [`apps/watchdog/README.md#what-a-run-does-every-5-min`](../apps/watchdog/README.md#what-a-run-does-every-5-min), D200 (`docs/decisions.md`), D119 (`docs/decisions.md`), D121 (`docs/decisions.md`) · **See also:** [email-issuer-key-compromised](#email-issuer-key-compromised), [forged-active-key](#forged-active-key), [forged-key-change](#forged-key-change), [governance-change](#governance-change)

<a id="self-issued-key-change"></a>

### Pending email key change (info)

`self-issued-key-change` · info · alert kinds: `self_issued_key_change`

A pending email key pinned for its signer, or a pending email key removal. Self-issued keys can't be confirmed early (D121): it waits its `governance_delay_ms` (72 h on mainnet), then anyone executes it.

**Signals**

- Info `self_issued_key_change` in `/status`, the portal and the daily digest: the change id, kid (its thumbprint), signer and `executable_at_ms`.

**Impact**

- None when the council meant it: the key is Hana's own (pinned). A removal stops email logins signed with that key once it executes (DoS only).

**Steps**

1. **Match it with a council proposal** (who: a founder). A rotation or the first keys: expected. Unexpected: the council posted it without the team (follow [unexpected-owner-action](#unexpected-owner-action)), and cancel it before it executes.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

2. **Execute it once due** (who: anyone). After `executable_at_ms`, anyone executes it (the API cron executes only Google changes). The watchdog warns `unexecuted_key_change` an hour after it is due.

   ```sh
   near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
   ```

**Verify**

- The key appears in `get_issuer("email")` and under its signer in `get_self_issued("email")`; the watchdog reports `key_change_executed`.

**Refs:** [`docs/email-login-spec.md#self-issued-issuers`](email-login-spec.md#self-issued-issuers), [`docs/contract-interface.md#self-issued-issuers-email-login-d121`](contract-interface.md#self-issued-issuers-email-login-d121), D121 (`docs/decisions.md`) · **See also:** [key-change-lifecycle](#key-change-lifecycle), [unexpected-owner-action](#unexpected-owner-action)

## Incident playbooks

<a id="updater-key-stolen"></a>

### `KEYS_UPDATER_KEY` stolen (API secrets leaked)

`updater-key-stolen` · critical

The keys-updater key (an API Worker secret, a function-call key on the signer) leaked: it can propose issuer keys and removals, delayed and cancellable, and execute matured ones.

**Signals**

- A `forged_key_change` or `published_key_removal` alert with `by` = the signer account.
- The API Worker secrets, `.secrets/<env>/keys-updater.json` or a machine holding it was exposed.
- Proposals the API cron didn't make (`GET /v1/governance` `.updater` tracks the cron's own).

**Impact**

- Bounded by governance: every key it proposes waits `issuer_key_delay_ms` and the watchdog cancels keys Google doesn't publish (and deletes the updater keys). Forging needs every watchdog down for the whole delay, and the next watchdog run then pauses.
- It can fill the 6-slot pending queue (blocking Google's real rotations), propose removing Google's live keys (alert-only: the owner cancels), and burn up to its 1 NEAR allowance from the signer's balance.
- Until a fresh key is in, the API cron can't propose Google's rotations.

**Steps**

1. **Delete the key on chain** (who: council (2 of 3)). If the watchdog hasn't already (`updater_keys` in `governance:status`), the owner deletes every key that may have leaked.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call delete_updater_key --args '{"public_key":"<ed25519:…>"}' --yes
   ```

2. **Cancel what it queued** (who: council (2 of 3)). The watchdog cancels forged additions; removals of kids Google still publishes are alert-only, so the owner cancels them. Leave Google's genuine additions in place.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

3. **Find and close the leak** (who: a founder). Where was it read: the Worker's secrets (then the Cloudflare account or the Worker code: [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)), `.secrets/` on a machine, a log or a paste. Close that first, or the fresh key leaks the same way.

4. **Rotate** (who: council (2 of 3)). A founder moves the key file aside and runs `deploy-contract` (a new key generated into the file; the owner's `add_updater_key` as a council proposal; ≤ 2 tracked keys), then uploads it as `KEYS_UPDATER_KEY`.

   ```sh
   mv .secrets/<env>/keys-updater.json .secrets/<env>/keys-updater.revoked-<yyyymmdd>.json
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   ```

**Verify**

- `admin <env> governance:status`: no findings; only the new key tracked, with exactly the updater methods.
- `curl -s <apiUrl>/v1/governance | jq '.signerAccessKeys[] | select(.updaterPermission | not)'` is empty outside sandbox-dev.
- The next cron run proposes and executes without `send_failed`.

**Follow-ups**

- Record the cause; delete the old key file once the on-chain deletion is confirmed.

**Refs:** [`docs/operations.md#keys-updater-key`](operations.md#keys-updater-key), [`docs/governance-spec.md#what-a-stolen-updater-key-can-still-do-bounded`](governance-spec.md#what-a-stolen-updater-key-can-still-do-bounded), [`docs/security.md#key-and-secret-inventory`](security.md#key-and-secret-inventory), D82 (`docs/decisions.md`) · **See also:** [forged-key-change](#forged-key-change), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)

<a id="relayer-key-stolen"></a>

### A relayer key stolen (session pool or owner pool)

`relayer-key-stolen` · warning

A function-call key of the relayer account (`RELAYER_KEYS` or `OWNER_RELAYER_KEYS`) leaked: it can burn its allowance, nothing more.

**Signals**

- A watchdog `relayer_allowance_*` or `relayer_balance_*` alert without matching logins (allowance or balance dropping faster than the request logs explain); `relay_retry` `invalid_nonce` warnings (another sender used a pool key).
- The API Worker secrets or `.secrets/<env>/relayer-keys.json` / `owner-relayer-keys.json` were exposed.

**Impact**

- Session pool: burn ≤ its allowance (2 NEAR default) and relay session methods, which still need a token or a session signature. DoS only: it can't derive anyone's key.
- Owner pool: burn ≤ 0.5 NEAR; every owner method still needs an owner proof on chain; logins are unaffected.

**Steps**

1. **Delete the key on chain** (who: a founder). With the relayer account's full-access key (keychain). Several keys or a whole leaked file: delete every key in it.

   ```sh
   near account delete-keys <relayer> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send
   ```

2. **Remove it from the secrets file** (who: a founder). Edit `.secrets/<env>/relayer-keys.json` (or `owner-relayer-keys.json`), or move the file aside for a whole new pool (then delete every old key on chain too: left there they keep their allowance).

3. **Add replacements** (who: a founder). `deploy-contract` generates and adds the missing keys (saved to the file before they go on chain). Pass the same allowance flags as before if you raised them.

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

4. **Upload the pool again** (who: a founder). A replaced key at an index makes its Durable Object ignore the old reservation and read the nonce from chain once (one `relay_retry` `invalid_nonce` per re-added key is expected).

   ```sh
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   ```

**Verify**

- `deploy-contract <env>` dry run: no blockers, no missing keys.
- A smoke login relays without errors.

**Follow-ups**

- If the leak came from the Worker or the Cloudflare account: [api-or-cloudflare-compromised](#api-or-cloudflare-compromised).

**Refs:** [`docs/operations.md#relayer-keys-either-pool`](operations.md#relayer-keys-either-pool), [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), [`docs/architecture.md#relayer-design`](architecture.md#relayer-design) · **See also:** [relayer-out-of-funds](#relayer-out-of-funds), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)

<a id="vault-kek-leaked"></a>

### `VAULT_KEK` leaked (and routine rotation)

`vault-kek-leaked` · critical

The key that wraps every vault share `K_s` in D1 leaked. Revoke every share first, then rotate; every user with a persisted login signs in again.

**Signals**

- The API Worker secrets, `.secrets/<env>/vault-kek` or a D1 copy together with the KEK were exposed.

**Impact**

- With the KEK and a D1 copy, every live share's `K_s` unwraps; with a device's IndexedDB record as well, that user's PRK. Rotation alone doesn't help: it re-wraps the same `K_s`.
- Revoking every share means every user with a persisted login signs in with Google again on their next visit. D1 backups and Time Travel keep the old rows under the old KEK for their retention: treat them as exposed for that long (can't be undone).

**Steps**

1. **Revoke every share (skip for a routine rotation)** (who: a founder). Every live share is revoked at once.

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL"
   ```

2. **Rotate the KEK** (who: a founder). Copies the current key to `vault-kek.previous`, writes a new key with the next id, sets `VAULT_KEK_PREVIOUS` and `VAULT_KEK`. If it stops part way, run it again (it resumes with the same new key). It refuses while a previous rotation's `vault-kek.previous` is still there.

   ```sh
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate --yes
   ```

3. **Retire the old key** (who: a founder). Unlocks and the hourly cron re-wrap old rows (≤ 2000 per run). Once no row is left under the old id, delete `VAULT_KEK_PREVIOUS` and `.secrets/<env>/vault-kek.previous`.

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = <old id>"
   corepack pnpm --dir apps/api exec wrangler secret delete VAULT_KEK_PREVIOUS --name <cloudflare.workerName>
   rm .secrets/<env>/vault-kek.previous
   ```

**Verify**

- The old-id count is 0 before deleting the previous key; no `unknownKek` errors in the logs.
- A fresh login persists and unlocks after a reload.

**Follow-ups**

- If the KEK leaked with the Worker or the account: [api-or-cloudflare-compromised](#api-or-cloudflare-compromised).

**Refs:** [`docs/operations.md#vault_kek`](operations.md#vault_kek), [`docs/security.md#key-and-secret-inventory`](security.md#key-and-secret-inventory), D54 (`docs/decisions.md`) · **See also:** [api-or-cloudflare-compromised](#api-or-cloudflare-compromised), [d1-data-loss](#d1-data-loss)

<a id="api-or-cloudflare-compromised"></a>

### API Worker code or Hana's Cloudflare account compromised

`api-or-cloudflare-compromised` · critical

Someone changed what the API or page Workers run, or controls Hana's main Cloudflare account: the page-serving trust root, the updater key, the relayer pools, D1 and `VAULT_KEK`.

**Signals**

- Deploys nobody made (Cloudflare's deployment history), unknown API tokens or logins, changed Worker secrets or D1 rows (origins, settings).
- A `forged_key_change` from the signer account (the updater key is a Worker secret).
- The watchdog keeps alerting: it runs on its own Cloudflare account and can't be silenced from this one (except on sandbox-dev, D125).

**Impact**

- Every key of every user who loads the vault while it is compromised (the API renders the vault page; the same account deploys the vault and auth bundles). Pausing the contract stops new derivations, not a malicious vault page reading a persisted share: those users' keys are exposed and must be moved (can't be undone).
- Bounded by governance: the updater key can only propose delayed, cancellable issuer keys; the watchdog cancels forged ones.
- The admin portal's view and its acks (batch C) are on this account: a portal ack stops only re-sends of alerts already paged.

**Steps**

1. **Take the account back** (who: a founder). In the Cloudflare dashboard: password, MFA, revoke API tokens and sessions, review members and the audit log (no repo tooling).

2. **Pause if keys may be stolen right now** (who: council (2 of 3)). A malicious vault or auth bundle is live: pausing stops new logins and derivation everywhere (a DoS, but it ends new key extraction through logins). Unpause after the clean redeploy ([contract-paused](#contract-paused)).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call pause --yes
   ```

3. **Redeploy known-good code** (who: a founder). From a reviewed commit: the API, then a fresh page build and both page Workers.

   ```sh
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/web build
   corepack pnpm --filter @hana-id/api run deploy:pages
   ```

4. **Rotate every API secret** (who: a founder). The updater key ([updater-key-stolen](#updater-key-stolen)), both relayer pools ([relayer-key-stolen](#relayer-key-stolen)), and `VAULT_KEK` with every share revoked ([vault-kek-leaked](#vault-kek-leaked)). The admin Worker's copy of `WATCHDOG_STATUS_TOKEN` too, once batch C exists.

5. **Check D1 for tampering** (who: a founder). Origins decide `frame-ancestors` and parent-origin checks; settings include `raw_sign` and policies (a bare D1 write skips their pending delay). Remove origins nobody added; suspend apps you can't verify.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> app:list --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:settings <app id | publishable key> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:suspend --app <app id | publishable key> --remote
   ```

6. **Tell partners** (who: a founder). Their security contacts: the window, and that users who opened their app in it should move funds to a new key. Not built yet: batch C's partner notice email (D86's notice channel).

**Verify**

- Deployed versions match the reviewed commit; `GET /v1/health` answers for the env.
- `admin <env> governance:status`: no findings; the watchdog quiet.
- Every app's origins and settings checked.

**Follow-ups**

- Post-mortem; any rule change goes in `docs/decisions.md`. Bounding the page-serving trust root is an open issue (`docs/security.md`).

**Refs:** [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), [`docs/governance-spec.md#what-each-party-can-do-after-this-batch`](governance-spec.md#what-each-party-can-do-after-this-batch), D83 (`docs/decisions.md`) · **See also:** [updater-key-stolen](#updater-key-stolen), [relayer-key-stolen](#relayer-key-stolen), [vault-kek-leaked](#vault-kek-leaked), [hana-origin-compromised](#hana-origin-compromised), [contract-paused](#contract-paused), [user-key-leaked](#user-key-leaked)

<a id="hana-origin-compromised"></a>

### Vault or auth origin compromised (domain or DNS)

`hana-origin-compromised` · critical

`vaultOrigin` or `authOrigin` serves someone else's code (a hijacked domain, DNS record or route).

**Signals**

- The pages serve unexpected content or certificates; registrar or DNS changes nobody made.
- sandbox-dev uses workers.dev origins: there it is the Cloudflare account ([api-or-cloudflare-compromised](#api-or-cloudflare-compromised)).

**Impact**

- `vaultOrigin`: every key of every user who loads it (PRK in memory; a page on that origin can read its IndexedDB records and unlock live shares). `authOrigin`: tokens of the logins it handles, approvals it shows, key exports.
- Users who loaded a hijacked page: their keys are exposed and must be moved (can't be undone).

**Steps**

1. **Take the domain back** (who: a founder). Registrar and DNS provider: credentials, MFA, records, registrar lock (no repo tooling). Production uses two registrable domains (D38), so check both.

2. **Stop key extraction** (who: council (2 of 3)). Pause (stops new logins and derivation), and a founder revokes every vault share so persisted logins can't be unlocked by the hijacked page (users log in again).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call pause --yes
   corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL"
   ```

3. **Redeploy the page Workers** (who: a founder). Once the origins are back.

   ```sh
   corepack pnpm --filter @hana-id/web build
   corepack pnpm --filter @hana-id/api run deploy:pages
   ```

4. **Unpause** (who: council (2 of 3)). After the pages are verified ([contract-paused](#contract-paused)).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call unpause --yes
   ```

5. **Tell partners** (who: a founder). The window; affected users move funds ([user-key-leaked](#user-key-leaked)).

**Verify**

- Both origins serve the current build with their CSP; a smoke login works.

**Follow-ups**

- Changing an origin breaks every own-client partner's Google redirect registration (not addresses).

**Refs:** [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), D38 (`docs/decisions.md`), D66 (`docs/decisions.md`) · **See also:** [api-or-cloudflare-compromised](#api-or-cloudflare-compromised), [user-key-leaked](#user-key-leaked), [contract-paused](#contract-paused)

<a id="watchdog-down"></a>

### Watchdog down (silent, heartbeat missing)

`watchdog-down` · critical

The watchdog stopped running: no cancels of forged keys, no pause, no confirmations, no alerts. The dead-man's switch is what tells you.

**Signals**

- The heartbeat provider's own alert (pings stopped: 5-min period, ~10-min grace) to both founders.
- The portal's silence banner (`/status` `silent: true`, no finished run within two intervals); `last_run` old or `outcome: error` (a failing run skips the heartbeat on purpose).

**Impact**

- A forged pending key goes live if nobody cancels it within `issuer_key_delay_ms`. Google's rotations wait their full delay (no confirmations): `503 issuer_key_pending` for the new kid meanwhile.
- A Cloudflare-wide outage takes the API and the watchdog down together; the heartbeat on a third provider still reports it.

**Steps**

1. **Watch the queue by hand** (who: a founder). Until it runs again: check pending key changes well within `issuer_key_delay_ms`; any pending Add Google doesn't publish (`jwks: absent` / `mismatch`) is cancelled by the council at once.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_issuer_key_change --args '{"id":<id>}' --yes
   ```

2. **Find why** (who: a founder). Logged in to the watchdog's Cloudflare account: the cron trigger (trigger changes take minutes to apply), the Worker's errors, D1. `/status` `last_run` shows the last outcome and each check.

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/status
   ```

3. **Redeploy** (who: a founder). From `apps/watchdog`, logged in to the watchdog's account (never from CI); secrets again from the file if they were lost.

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

4. **If its D1 was lost or damaged: restore it** (who: a founder). Logged in to the watchdog's account: Time Travel back to a minute before the loss (30 days). A point after its first run keeps `initialized_at`, so the pause still works; first compare the active kids with Google's JWKS (an active kid Google published and dropped entirely inside the gap would look never published and be paused). The next runs re-alert every governance change since the point (check, then acknowledge) and re-raise conditions still true.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name>
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>
   ```

5. **If it can't be restored: the first-run caveat** (who: a founder). Past 30 days, a point before its first run, or a new database: the next run is a first run. It records Google's current JWKS as known and alerts, without pausing, on any active kid not in it. Check every first-run alert by hand ([unknown-active-key-first-run](#unknown-active-key-first-run)) and the pending queue; a forged key active at that moment is not paused.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, delays, keyChanges, pendingUpgrade, pendingOwner, pendingWithdrawal}'
   ```

**Verify**

- `/status`: `last_run.outcome: "ok"`, `silent: false`, `heartbeat.ok`; the heartbeat provider shows the check up.

**Follow-ups**

- A second watchdog on another provider (D125 later option) removes this single point.

**Refs:** [`docs/operations.md#watchdog-service-appswatchdog`](operations.md#watchdog-service-appswatchdog), [`docs/operations.md#the-watchdogs-d1`](operations.md#the-watchdogs-d1), [`apps/watchdog/README.md#alerts-d85`](../apps/watchdog/README.md#alerts-d85), D83 (`docs/decisions.md`), D125 (`docs/decisions.md`), D152 (`docs/decisions.md`) · **See also:** [watchdog-degraded](#watchdog-degraded), [watchdog-compromised](#watchdog-compromised), [forged-active-key](#forged-active-key), [unknown-active-key-first-run](#unknown-active-key-first-run)

<a id="watchdog-compromised"></a>

### Watchdog compromised (its Cloudflare account, `WATCHDOG_KEY` or status token)

`watchdog-compromised` · critical

Someone holds the watchdog's key, its status token or its Cloudflare account. Its key has DoS power only; the account also holds its alert credentials.

**Signals**

- Cancels of genuine Google keys, pauses or updater-key deletions without a matching forgery; the watchdog account sending what this watchdog didn't log.
- An unexpected `first_run` (its D1 emptied or replaced), acks nobody made, or logins to its Cloudflare account nobody made.

**Impact**

- `WATCHDOG_KEY`: cancel every key change (Google's next key never activates: logins with it fail), pause, delete updater keys, confirm early only a change someone already proposed. It can't post a key; forging needs the updater key or the owner as well.
- `WATCHDOG_STATUS_TOKEN`: read the status and ack alerts, which stops only re-sends of alerts already paged (never a first alert or a check).
- The account: the key, the token, its Resend, Slack and paging credentials, and its D1 (its history: an emptied D1 means a first run that never pauses).

**Steps**

1. **Cut the key off** (who: a founder). Delete `WATCHDOG_KEY`'s public key from `watchdog.account` with that account's full-access key (keychain): immediate, and the account stays a watchdog. `secrets <env> init` prints the public key of the key in the file. If the watchdog account itself is lost, the council removes it instead (`remove_watchdog`: immediate, but every key change then waits `governance_delay_ms` until another watchdog may confirm).

   ```sh
   corepack pnpm --filter @hana-id/watchdog secrets <env> init
   near account delete-keys <watchdog.account> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call remove_watchdog --args '{"account_id":"<watchdog.account>"}' --yes
   ```

2. **Undo what it did** (who: council (2 of 3)). Unpause if it paused without a forged active key ([contract-paused](#contract-paused)); re-add the updater key ([updater-key-stolen](#updater-key-stolen)'s Rotate step); Google's cancelled kids are re-proposed by the API cron after its 1 h hold.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call unpause --yes
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env>
   ```

3. **Take the account back** (who: a founder). The watchdog's Cloudflare account: password, MFA, API tokens, members (no repo tooling).

4. **Rotate WATCHDOG_KEY** (who: a founder). Remove `WATCHDOG_KEY` from `.secrets/<env>/watchdog-secrets.json` in an editor (never print it), run `secrets <env> init` (a new key; it prints the near CLI command that adds it as a function-call key: run it), upload the file, then delete the old key on chain if step 1 hasn't.

   ```sh
   corepack pnpm --filter @hana-id/watchdog secrets <env> init
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   ```

5. **Rotate the status token and the alert credentials** (who: a founder). The token the same way (remove it from the file, `init` makes a new one), then on both Workers (the admin Worker's copy too, once batch C exists). Resend, Slack, the paging app and the heartbeat URL: replace each in its provider and in the file, then upload.

   ```sh
   corepack pnpm --filter @hana-id/watchdog secrets <env> init
   corepack pnpm --filter @hana-id/watchdog secrets <env> check
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   ```

6. **A lost D1: restore it, or check the first run** (who: a founder). Restore its D1 with Time Travel to a minute before the intrusion (operations "The watchdog's D1"; a point after its first run keeps the pause working). Past 30 days or with nothing to restore: redeploy against a fresh D1 (setup step 5) and check every first-run alert by hand ([unknown-active-key-first-run](#unknown-active-key-first-run)).

   ```sh
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
   corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

**Verify**

- `/status`: every check ok, channels configured; only the new key on `watchdog.account` besides its full-access key.
- `admin <env> governance:status`: no findings, the watchdog listed (or re-added).

**Follow-ups**

- Re-adding a removed watchdog restarts its confirm delay (`governance_delay_ms`).

**Refs:** [`docs/operations.md#watchdog-service-appswatchdog`](operations.md#watchdog-service-appswatchdog), [`docs/security.md#key-and-secret-inventory`](security.md#key-and-secret-inventory), [`docs/contract-interface.md#watchdogs`](contract-interface.md#watchdogs), D86 (`docs/decisions.md`) · **See also:** [watchdog-down](#watchdog-down), [contract-paused](#contract-paused), [unknown-active-key-first-run](#unknown-active-key-first-run)

<a id="council-member-key"></a>

### A council member's key lost or compromised

`council-member-key` · critical

One of the three council keys (a founder's Ledger or the offline backup) is lost or in someone else's hands. The council still acts with the other two; replace the member.

**Signals**

- A lost or stolen Ledger, a backup holder who can't be reached, or a vote or proposal the member didn't make (`owner:proposals`).

**Impact**

- One key alone can propose and vote once: nothing executes without a second key, for every proposal kind (D81). One more compromise would give an attacker the council.
- Two keys compromised: the attacker is the owner ([unexpected-owner-action](#unexpected-owner-action)).

**Steps**

1. **Reject the member's stray proposals** (who: council (2 of 3)). List open proposals; never approve one nobody explained. Two remaining members each cast a `VoteReject` (`owner:vote --reject`): two rejections close it as `Rejected`, so it can never execute even if the lost key turns up again. Off dev envs each member signs the same `act_proposal` command as an approval, with `"action":"VoteReject"`.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:vote <proposal id> --member <member> --reject --yes
   ```

2. **Replace the member** (who: council (2 of 3)). The new member creates their account first (a Ledger key on mainnet). `council:replace-member` proposes `RemoveMemberFromRole` for the old member, then `AddMemberToRole` for the new one, signed by a remaining member (the old one never signs): read the plan without `--yes`. The removal goes first and cuts the key off; until the addition executes the council is 2 of 2, so both remaining members approve it straight away. Dev envs: add `--approve-with <second member>` to approve both in the same command; elsewhere it prints each remaining member's `act_proposal` for each proposal. Each executed change raises a critical `governance_change` (`owner_policy`): expected, acknowledge it.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> council:replace-member --remove <old member> --add <new member> --member <member>
   corepack pnpm --filter @hana-id/scripts run admin <env> council:replace-member --remove <old member> --add <new member> --member <member> --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   ```

3. **Update the manifest** (who: a founder). Once both proposals executed, run `council:replace-member` again with `--yes` (on dev envs with `--approve-with` the first run already did): it checks the DAO's group is the new council at 2 of 3 and writes `council.members` in `envs/<env>.json`, the new member in the old one's place. Commit it (code-owner review); `deploy-contract` blocks until the DAO's policy is exactly the manifest's council at 2 of 3.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> council:replace-member --remove <old member> --add <new member> --member <member> --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   corepack pnpm --filter @hana-id/scripts run council-setup <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   ```

**Verify**

- `admin <env> governance:status`: no findings (the policy is the manifest's council, 2 of 3 for every kind).
- `deploy-contract <env>` dry run without blockers (`council-setup <env>` dry run on dev envs).

**Follow-ups**

- Mainnet: where the backup key is held is decided before mainnet (D81); record the replacement.

**Refs:** [`docs/operations.md#replacing-a-council-member`](operations.md#replacing-a-council-member), [`docs/operations.md#owner`](operations.md#owner), [`docs/operations.md#owner-council-sputnik-dao-v2-d81`](operations.md#owner-council-sputnik-dao-v2-d81), D81 (`docs/decisions.md`), D151 (`docs/decisions.md`) · **See also:** [unexpected-owner-action](#unexpected-owner-action), [governance-change](#governance-change)

<a id="unexpected-owner-action"></a>

### Unexpected owner action: upgrade, owner transfer, withdrawal or another council call

`unexpected-owner-action` · critical

A council call nobody on the council made: two council keys were used. Cancel what is pending, and use the governance delay to warn partners.

**Signals**

- A `governance_change` (or `config_change`, `unverifiable_key_change`, `forged_key_change` with `by` = the owner) that matches no proposal anyone explains.
- A DAO proposal with approvals from members who didn't vote.

**Impact**

- Two of three council keys act as the owner: after `governance_delay_ms` any upgrade (anything, including forging tokens), owner transfer or surplus withdrawal; at once config, pause/unpause, removing issuer keys and watchdogs, updater keys.
- Can't install a key or code faster than the governance delay; a pending upgrade, owner transfer or withdrawal is public and cancellable until then. Pause doesn't stop `execute_upgrade`.
- If the attacker really holds two keys they can re-propose after each cancel and reshape the DAO: from inside the council that can't be undone; the delay is the defence.

**Steps**

1. **Establish who voted** (who: a founder). The proposal's votes name the members; talk to each of them on a channel you trust.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   curl -s <apiUrl>/v1/governance | jq '{paused, delays, keyChanges, pendingUpgrade, pendingOwner, pendingWithdrawal}'
   ```

2. **Reject open proposals nobody explained** (who: council (2 of 3)). Before a second key approves them: each honest member casts a `VoteReject`; two rejections close a proposal for good.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:proposals
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:vote <proposal id> --member <member> --reject --yes
   ```

3. **Cancel what is pending** (who: council (2 of 3)). With the two honest keys, if there are two.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_upgrade --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_owner_proposal --yes
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call cancel_withdrawal --yes
   ```

4. **Replace the compromised member** (who: council (2 of 3)). One key compromised: [council-member-key](#council-member-key). Two: there is no honest majority; go to the next step.

5. **Warn partners and users within the delay** (who: a founder). Before the pending action's executable time: partners' security contacts, and users told to export keys and move funds (D41). Not built yet: batch C's notice email to every org's security contacts and the pending-upgrades page (D86).

**Verify**

- `get_governance()` has no pending upgrade, owner or withdrawal nobody made; `admin <env> governance:status`: no findings.

**Follow-ups**

- Record the incident in `docs/decisions.md`; review how the keys were reached.

**Refs:** [`docs/governance-spec.md#what-each-party-can-do-after-this-batch`](governance-spec.md#what-each-party-can-do-after-this-batch), [`docs/operations.md#owner-actions-through-the-council`](operations.md#owner-actions-through-the-council), [`docs/contract-interface.md#upgrades`](contract-interface.md#upgrades), D81 (`docs/decisions.md`), D84 (`docs/decisions.md`), D86 (`docs/decisions.md`) · **See also:** [governance-change](#governance-change), [council-member-key](#council-member-key)

<a id="contract-paused"></a>

### Contract paused (by the watchdog or by mistake): unpausing safely

`contract-paused` · critical

Logins and derivation answer `503 paused`. Find who paused and why; unpause only once the cause is gone.

**Signals**

- `503 paused` (`retry-after: 60`) on `/v1/sessions`, `/v1/login`, `/v1/derive`; a `governance_change` alert for `paused`.
- `get_config().paused`, the `paused {by}` event.

**Impact**

- Every login and derivation stops; revocation, vault share endpoints, cancels, governance, `execute_upgrade` and views still work. OIDC owner actions and `execute_change` fail on chain.
- Each unpause gives every pending scope change a full `change_delay_ms` again (`changes_unlock_floor_ms`): partners' legitimate changes wait longer.

**Steps**

1. **Find who paused** (who: a founder). The `paused` event's `by`, or the watchdog's actions log. The watchdog pauses only on an active key Google doesn't publish: then follow [forged-active-key](#forged-active-key) (unpausing first only makes it pause again).

   ```sh
   curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)" https://<workerName>.<subdomain>.workers.dev/actions
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   ```

2. **Check nothing forged is active** (who: a founder). `governance:status` reports any active Google key Google's JWKS doesn't publish. A pause by mistake with no forged key needs no session floor.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> governance:status
   ```

3. **A watchdog pausing wrongly** (who: council (2 of 3)). A buggy or rogue watchdog that keeps pausing: cut its key off or remove it ([watchdog-compromised](#watchdog-compromised)).

4. **Unpause** (who: council (2 of 3)). At once, no delay (D82). The API sees it within 10 s.

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> owner:call unpause --yes
   ```

**Verify**

- `GET /v1/governance` `paused: false`; a smoke login works; no new pause at the next watchdog run.

**Follow-ups**

- Tell partners when logins stopped and resumed, and that pending scope changes got a new timelock.

**Refs:** [`docs/operations.md#pause`](operations.md#pause), [`docs/contract-interface.md#pause`](contract-interface.md#pause), D82 (`docs/decisions.md`), D86 (`docs/decisions.md`) · **See also:** [forged-active-key](#forged-active-key), [watchdog-compromised](#watchdog-compromised)

<a id="google-jwks-outage"></a>

### Google's JWKS unreachable, or a Google rotation stuck

`google-jwks-outage` · warning

Google's signing keys can't be fetched, or Google's new kid isn't active on chain yet: logins signed with that kid get `503 issuer_key_pending`.

**Signals**

- `503 issuer_key_pending` on logins (the vault retries once, then tells users to try again in a few minutes).
- `jwks_failing` from the watchdog; API `issuer_keys_unavailable`; a pending Add in `keyChanges` with `jwks: match` that isn't confirmed.

**Impact**

- Existing logins with active kids keep working (the API serves its JWKS cache up to 6 h stale on a fetch failure; the contract checks on-chain keys).
- A new Google kid can't be used until it is active: confirmed by a confirm-capable watchdog, or after `issuer_key_delay_ms` (or `governance_delay_ms` while no watchdog may confirm, or after a watchdog removal). Nothing can make it faster.

**Steps**

1. **See where the kid is** (who: a founder). No pending change for it: the cron hasn't proposed (no `KEYS_UPDATER_KEY`, `send_failed`, `queue_full`). Pending with `jwks: match`: waiting for a confirmation or its executable time.

   ```sh
   curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'
   curl -s <apiUrl>/v1/governance | jq '.updater'
   ```

2. **Propose or execute it** (who: anyone). A founder syncs by hand (signs with the updater key); once due anyone may execute. The owner may post a key too, but it waits the same delay (D86).

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env>
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --execute
   near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
   ```

3. **Restore what blocks it** (who: a founder). A deleted updater key: install a fresh one ([updater-key-stolen](#updater-key-stolen)'s Rotate step). A watchdog that can't confirm: [confirm-failed](#confirm-failed) / [watchdog-cannot-act](#watchdog-cannot-act). A JWKS outage on Google's side: wait; nothing on Hana's side fixes it.

**Verify**

- The kid is in `issuers`; logins with it succeed.

**Follow-ups**

- Keep the issuer-key delay well under Google's measured lead time (`admin <env> issuer-keys:lead-times --remote`, D80).

**Refs:** [`docs/operations.md#google-signing-keys-jwks`](operations.md#google-signing-keys-jwks), [`docs/operations.md#issuer-key-lead-times-d33`](operations.md#issuer-key-lead-times-d33), D80 (`docs/decisions.md`), D86 (`docs/decisions.md`) · **See also:** [key-sync-stalled](#key-sync-stalled), [confirm-failed](#confirm-failed), [watchdog-degraded](#watchdog-degraded)

<a id="near-rpc-outage"></a>

### NEAR RPC outage

`near-rpc-outage` · warning

The manifest's `rpc` provider is down or wrong. The API reads only `rpc`; the vault, the export window and the watchdog fall back to `rpcFallback`.

**Signals**

- `502 near_unavailable` on API endpoints; `rpc_failing` from the watchdog (both its RPCs failed 3 runs).

**Impact**

- Logins, derives and owner actions through the API fail while `rpc` is down. Users with an unlocked or persisted vault keep signing (no chain call needed for the key). A lying RPC can fail derives or refuse logins but can't forge a CKD result (pinned key, pairing check).

**Steps**

1. **Confirm it is the provider** (who: a founder). Check the provider's status and another provider.

   ```sh
   curl -s https://<worker-url>/v1/health
   corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
   ```

2. **Switch the API to another provider** (who: a founder). Change `rpc` (and keep `rpcFallback` a different provider) in `envs/<env>.json` (code-owner review; https; testnet only: every script and the watchdog refuse another `chain_id`). The value is built into the vault and auth bundles and their CSP: regenerate, rebuild and redeploy the API and both page Workers, and the watchdog.

   ```sh
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/web build
   corepack pnpm --filter @hana-id/api run deploy:pages
   corepack pnpm --filter @hana-id/watchdog gen <env>
   corepack pnpm --dir apps/watchdog exec wrangler deploy
   ```

**Verify**

- `GET /v1/health` and a smoke login work; the watchdog's `rpc_failing` resolves.

**Follow-ups**

- Not built yet: an API-side RPC fallback (the API reads only `NEAR_RPC`).

**Refs:** [`docs/operations.md#accounts-and-services-per-environment`](operations.md#accounts-and-services-per-environment), [`docs/security.md#parties`](security.md#parties), D65 (`docs/decisions.md`) · **See also:** [watchdog-degraded](#watchdog-degraded)

<a id="mpc-ckd-outage"></a>

### NEAR MPC / CKD outage

`mpc-ckd-outage` · critical

The NEAR MPC network doesn't answer `request_app_private_key`: new logins can't derive keys. The MPC is NEAR's, not Hana's.

**Signals**

- `422 ckd_failed` on `/v1/login` and `/v1/derive` (the session is committed with its one use spent).
- Derive latency far above the ~4.5 s MPC share.

**Impact**

- New logins and derivations fail; users with an unlocked or persisted vault keep signing (their PRK is already on the device).
- Never change `mpc`, `ckdDomainId` or `ckdNetworkKey` to work around it: they are part of every user's address. A new MPC network key changes every address (can't be undone): that is a decision, not a fix.

**Steps**

1. **Confirm it is the MPC** (who: a founder). Request logs: `ckd_failed` and `relayOutcome` timings; NEAR's MPC status channels.

   ```sh
   corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
   ```

2. **Tell partners** (who: a founder). Logins fail until the MPC recovers; persisted sessions keep working. Nothing on Hana's side restarts it.

3. **If the MPC public key changed** (who: a founder). Derives fail the pairing check against the pinned key. Read the key from ≥ 3 providers without writing (`--dry-run`); never re-pin without a recorded decision: it changes every address.

   ```sh
   corepack pnpm --filter @hana-id/scripts run fetch-ckd-key <env> --dry-run
   ```

**Verify**

- A smoke login derives; `ckd_failed` stops in the logs.

**Refs:** [`docs/security.md#trust-roots-in-one-paragraph`](security.md#trust-roots-in-one-paragraph), [`docs/api.md#relay-errors-any-relayed-call`](api.md#relay-errors-any-relayed-call), [`docs/operations.md#accounts-and-services-per-environment`](operations.md#accounts-and-services-per-environment), D100 (`docs/decisions.md`)

<a id="d1-data-loss"></a>

### The API's D1 lost or corrupted

`d1-data-loss` · critical

The API's D1 (apps, origins, settings, usage, vault shares, issuer-key sync state) is gone or wrong. The contract and every address are unaffected.

**Signals**

- `/v1/app` and vault pages fail for known publishable keys; `unknownKek` or missing-table errors; `admin app:list --remote` empty or wrong.

**Impact**

- Every partner's logins stop (no app, no origins). Persisted logins can't be unlocked without their `vault_shares` rows: those users sign in again.
- Addresses, scopes and sessions live on chain and are unchanged.
- Recreating an app with `app:create` gives it a new app id and publishable key: partners must update their pages.

**Steps**

1. **Restore from Time Travel** (who: a founder). D1 Time Travel restores any minute of the last 30 days (7 on the Free plan), in place. Note the current bookmark first (it undoes the restore), get the bookmark of a time before the loss, export the damaged state to `.secrets/` (it holds wrapped vault shares: 0600), then restore. Everything written after that point is lost, including suspensions and share revocations made since.

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name>
   corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
   corepack pnpm --dir apps/api exec wrangler d1 export <cloudflare.d1Name> --remote --output=../../.secrets/<env>/d1-before-restore-<yyyymmdd>.sql
   corepack pnpm --dir apps/api exec wrangler d1 time-travel restore <cloudflare.d1Name> --bookmark=<bookmark>
   ```

2. **Re-run what the restore undid** (who: a founder). In order: apply the migrations (a point before a later migration has the older schema); re-apply security writes made since the point (`app:suspend`, `app:origins:remove`, and the revoke-all if every share was revoked since: before anything else); then the other app changes. A KEK rotated since: restored rows need the old key (`vault-kek <env> put --yes` sets both secrets from the files), else those users sign in again. The issuer-key cron rebuilds its own state from chain on its next run.

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:suspend --app <app id | publishable key> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> --remote
   corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL"
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> put --yes
   ```

3. **Without a restore: rebuild** (who: a founder). Past 30 days, or nothing to restore: re-apply the migrations, then re-create each app, its origins and settings from what partners and the audit trail say. Not built yet: a scheduled export of the apps tables kept outside Cloudflare.

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:create --name <name> --scope <scope_id> --origin <origin> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:settings <app id | publishable key> --remote
   ```

**Verify**

- `admin <env> app:list --remote` matches the known apps; suspended apps are still suspended; a smoke login and a reload unlock work.

**Follow-ups**

- Batch C moves the ledger to Neon with point-in-time restore (D73); the API's D1 still needs a backup kept beyond Time Travel's 30 days.
- Rehearse a Time Travel restore on sandbox-dev (D152).

**Refs:** [`docs/operations.md#restoring-a-d1-database-time-travel`](operations.md#restoring-a-d1-database-time-travel), [`docs/architecture.md#data-stores`](architecture.md#data-stores), [`docs/operations.md#admin-cli-scriptsadmints`](operations.md#admin-cli-scriptsadmints), [`docs/operations.md#vault_kek`](operations.md#vault_kek), D152 (`docs/decisions.md`) · **See also:** [vault-kek-leaked](#vault-kek-leaked), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)

<a id="partner-google-client-compromised"></a>

### A partner's own Google client compromised

`partner-google-client-compromised` · critical

Someone controls a partner's own Google OAuth client (e.g. added a redirect URI): they can get tokens with chosen nonces for that scope's users who sign in through them.

**Signals**

- The partner reports changes in their Google Cloud project, or logins in their scope Hana's vault didn't start.

**Impact**

- That scope's users who sign in through the attacker's flow: their keys in that scope are exposed (can't be undone: they move funds). Other scopes are unaffected.
- Hana can't remove a scope's client: only the scope's owners can.

**Steps**

1. **Remove the client from the scope** (who: scope owners). `remove_client` is immediate (the client stops resolving to the scope at once; quarantined for `change_delay_ms`). Through `POST /v1/owner-actions` with a console token (no CLI yet), or on chain from any funded account as for `cancel_change` (`docs/operations.md` "Cancelling a change when the API refuses"). The last client can go only if the scope has `allow_shared`.

2. **Fix the Google Cloud project** (who: scope owners). Credentials, redirect URIs, JavaScript origins, project members.

3. **Stop the app meanwhile if needed** (who: a founder). Suspending the app (D1 only) stops logins through Hana's API and vault for it; it doesn't stop direct contract calls with the client's tokens. A system-wide pause is the last resort (every app).

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> app:suspend --app <app id | publishable key> --remote
   corepack pnpm --filter @hana-id/scripts run admin <env> app:resume --app <app id | publishable key> --remote
   ```

**Verify**

- `get_scope(<scope>)` no longer lists the client.

**Follow-ups**

- A replacement client is added with a timelocked `propose_change(AddClient)`; addresses stay the same (same `sub`).

**Refs:** [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), [`docs/operations.md#admin-cli-scriptsadmints`](operations.md#admin-cli-scriptsadmints), D11 (`docs/decisions.md`) · **See also:** [user-key-leaked](#user-key-leaked), [shared-google-client-compromised](#shared-google-client-compromised)

<a id="shared-google-client-compromised"></a>

### Hana's shared Google client or its Cloud project compromised

`shared-google-client-compromised` · critical

Someone controls Hana's shared login client: isolation of every `allow_shared` scope is broken.

**Signals**

- Changes in Hana's Google Cloud project nobody made (redirect URIs, credentials, members).

**Impact**

- Tokens with chosen nonces for every shared-login scope's users who sign in through the attacker's flow: their keys exposed (can't be undone). Own-client-only scopes are unaffected.
- Removing the shared client stops every shared-only scope's logins until a new shared client is in force (`change_delay_ms` later).

**Steps**

1. **Remove the shared client** (who: council (2 of 3)). `set_shared_clients` without it: removals apply at once. Remove it from `sharedGoogleClientIds` in the manifest and `deploy-contract` plans exactly that.

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

2. **Secure the Cloud project** (who: a founder). Credentials, members, redirect URIs (only `{authOrigin}/login/callback`).

3. **Add a new shared client** (who: council (2 of 3)). A new client id in `sharedGoogleClientIds`; `deploy-contract` sets it pending for `change_delay_ms`; register its redirect URI. Addresses don't change (the path has no client id).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

4. **Tell partners** (who: a founder). Shared-only apps are down until the new client is in force; affected users move funds.

**Verify**

- `get_config().shared_clients` lists only the new client once in force; a shared login works.

**Refs:** [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), [`docs/contract-interface.md#shared-clients`](contract-interface.md#shared-clients) · **See also:** [partner-google-client-compromised](#partner-google-client-compromised), [user-key-leaked](#user-key-leaked)

<a id="user-key-leaked"></a>

### A user's key leaked or exposed

`user-key-leaked` · warning

A user's derived key (PRK or a chain key) was exposed: it can't be revoked; the user moves funds to a key at another `key_index`.

**Signals**

- A user reports it, or they were in the window of an incident that exposed keys (forged active key, compromised pages, a compromised client).

**Impact**

- Every chain and account under that `key_index` is exposed for good: the old key stays derivable by whoever can sign in as that user. Can't be undone.
- Rotation is not built: the vault fixes `keyIndex = 0` and nothing on chain marks an index retired.

**Steps**

1. **Move funds** (who: the user). The user moves funds using a session at the old index to an address under another `keyIndex` (today only `apps/smoke`'s direct page sets one; values ≥ 2^31 are reserved). Not built yet: key rotation in the vault and SDK.

**Verify**

- Funds are at the new address.

**Follow-ups**

- Key rotation hooks (`docs/batch-b-spec.md`) before mainnet.

**Refs:** [`docs/operations.md#a-users-leaked-key-key_index`](operations.md#a-users-leaked-key-key_index), [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives)

<a id="email-issuer-key-compromised"></a>

### Email-login issuer key compromised (planned)

`email-issuer-key-compromised` · critical · **planned: not built yet**

Email login isn't built (`docs/email-login-spec.md`). When it is: whoever can make Hana's email issuer key sign can mint email tokens for any `sub` and derive the wallet of any email user (and of accounts linked to one).

**Signals**

- The contract's hourly link counter and the watchdog's `link_threshold_reached` page ([link-volume](#link-volume), D200; links that take over Google wallets; email-rooted wallets and Google wallets that already have an email member are entered without a link, so only custody protects them, D121) and its pins (a swapped key is cancelled, [forged-key-change](#forged-key-change); an active one pauses, [forged-active-key](#forged-active-key)). Planned: the hourly CloudTrail reconciliation finds a `Sign` the issuer didn't log (critical); an IAM or KMS policy change alert. On testnet (Worker-secret key) there is no signing log: you notice only a leak of the Worker's secrets or a link burst.

**Impact**

- At 1-of-1 the use of the real key isn't bounded on chain: it is detected and stopped. A key swap is bounded by governance (owner-posted only, `governance_delay_ms`, the watchdog's pinned thumbprints).

**Steps**

1. **Revoke the credential** (who: a founder). Mainnet plan: the issuer's AWS access key. Not built yet: `scripts/email-issuer.ts rotate-aws-key`.

2. **Remove the key on chain** (who: council (2 of 3)). Immediate: `remove_issuer_key` for the email provider and the primary kid; email logins continue on the standby key while a replacement waits its delay. Not built yet: the email issuer, so the provider id isn't final.

3. **Retire sessions it opened** (who: council (2 of 3)). `set_sessions_valid_from_ms` past the detection: it retires every session opened before it, Google ones too (every user logs in again).

**Verify**

- Planned: the reconciliation shows no unlogged `Sign` after the cut-off.

**Follow-ups**

- Turn this playbook live with the email issuer's own commands when it ships.

**Refs:** [`docs/email-login-spec.md#signing-key-staged`](email-login-spec.md#signing-key-staged), [`docs/email-login-spec.md#trust-statement`](email-login-spec.md#trust-statement), D121 (`docs/decisions.md`) · **See also:** [forged-active-key](#forged-active-key), [link-volume](#link-volume), [signer-policy-mismatch](#signer-policy-mismatch)

<a id="identity-signing-key-compromised"></a>

### Identity token signing key compromised (testnet Worker-secret key)

`identity-signing-key-compromised` · critical

Whoever holds an identity signing key can forge any user's identity token for any app, until the key is out of the JWKS. Switch to a key the incident didn't touch, unpublish the exposed ones, tell partners.

**Signals**

- The API Worker's secrets, `.secrets/<env>/identity-signing-key*.json` or the operator's machine were exposed; a partner reports a token they didn't expect (a valid signature for a session that never existed).
- Not built yet (build steps 7–8): the KMS `Sign` reconciliation against `identity_issuance_hourly` and the watchdog's JWKS pin check.

**Impact**

- Forged tokens pass at every partner that trusts the JWKS URL, as any user of any app (identity at partners: credits, referrals, their own accounts), until the key is removed and their JWKS caches refresh (≤ 10 min). No wallet, key or Hana API is reachable with a token.
- Tokens already accepted can't be recalled: partners must re-check what they granted in the window.

**Steps**

1. **Decide which keys are exposed** (who: a founder). The standby is published but never uploaded (D177): a leak of the Worker's secrets or the Cloudflare account exposes only the active key (and a `next` key already switched in). A leak of `.secrets/<env>/` or the operator's machine exposes every key whose file was there, the standby included unless it was moved offline. Unless the incident provably touches only the active key, treat BOTH as exposed.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> show
   ```

2. **Only the active key exposed: switch to the standby** (who: a founder). Uploads the standby into the free Worker slot and makes it the manifest's active kid. Put the manifest change in the repo, `gen`, deploy: new tokens are signed by the standby, which partners already trust.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> switch --to standby --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

3. **Both keys exposed: retire the standby and rotate to a fresh key** (who: a founder). Unpublish the standby, generate and publish a fresh key, switch to it, deploy. Partners using the JWKS URL pick up the new kid at once (jose refetches on an unknown kid); partners that pin thumbprints need the new one from you.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> retire --key standby --yes
   corepack pnpm --filter @hana-id/scripts run identity-key <env> next --yes
   corepack pnpm --filter @hana-id/scripts run identity-key <env> switch --to next --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

4. **Unpublish the exposed active key** (who: a founder). Removes it from the JWKS and deletes its Worker secret, after the deploy of the switch; its file is set aside for the post-mortem (never put it in the repo). Deploy: partners reject its tokens within 10 minutes. Don't wait the 2 h of a scheduled rotation.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> retire --key previous --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

5. **Tell partners** (who: a founder). Their security contacts: the `kid`, the window in which forged tokens may have been accepted, and what to re-check (emails recorded, credits granted, sessions opened). Pinning partners update their pins.

6. **A new standby** (who: a founder). After a switch to the standby there is none: `next` publishes a new key (not uploaded); move its file offline and keep it as the next standby.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> next --yes
   ```

**Verify**

- The API's JWKS lists no exposed kid, and a fresh mint's header `kid` is the new active key.
- `identity-key <env> show`: the active kid is in a Worker slot, no exposed kid is published.

**Follow-ups**

- If the Worker or the Cloudflare account was the way in: [api-or-cloudflare-compromised](#api-or-cloudflare-compromised). Before mainnet the key moves to AWS KMS (build step 7; [identity-kms-signer-compromised](#identity-kms-signer-compromised)).

**Refs:** [`docs/operations.md#identity-token-keys`](operations.md#identity-token-keys), [`docs/security.md#what-a-compromise-gives`](security.md#what-a-compromise-gives), D177 (`docs/decisions.md`) · **See also:** [api-or-cloudflare-compromised](#api-or-cloudflare-compromised), [identity-kms-signer-compromised](#identity-kms-signer-compromised)

<a id="identity-kms-signer-compromised"></a>

### Identity token KMS signer misused (planned: staging and mainnet)

`identity-kms-signer-compromised` · critical · **planned: not built yet**

No env signs with AWS KMS yet (the adapter is built, the AWS account isn't: docs/operations.md "Identity token keys on AWS KMS"). When one does: the KMS key can't be stolen, but whoever holds the signer's AWS access key (or controls the API Worker) can have KMS sign forged identity tokens until the access key is revoked. Revoke it, switch to the standby, unpublish the suspect key, tell partners.

**Signals**

- Planned: the hourly reconciliation of CloudTrail `Sign` events per key against `identity_issuance_hourly` finds more signatures than the API counted (critical); an EventBridge alert on `Sign` by another principal or on an IAM or key-policy change. A leak of the API Worker's secrets or the Cloudflare account; a partner reports a token they didn't expect.

**Impact**

- Forged tokens pass at every partner that trusts the JWKS URL, as any user of any app, until the access key is revoked and the key is out of partners' JWKS caches (≤ 10 min after the deploy). Every forged signature is in CloudTrail, so the window and the count are known. No wallet, key or Hana API is reachable with a token.

**Steps**

1. **Revoke the access key** (who: a founder). In the AWS account (break-glass role with MFA): deactivate every access key of the IAM user `hana-identity-signer`. KMS refuses every `Sign` from then on; mints answer 503 `identity_signer_unavailable` and partners fall back to no token.

2. **Switch to the standby** (who: a founder). The IAM policy allows `kms:Sign` on the active key only (D219), so the standby signed nothing during the leak: check it in CloudTrail. Grant the new access key `kms:Sign` on the standby's ARN, create the key, write `.secrets/<env>/identity-aws-access-key.json`, set it on the Worker, switch, `gen`, deploy.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> kms-put-aws-key --yes
   corepack pnpm --filter @hana-id/scripts run identity-key <env> kms-switch --to standby --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

3. **Unpublish the suspect key** (who: a founder). After the switch's deploy: remove it from the JWKS (partners reject its tokens within 10 minutes), remove its ARN from the IAM policy, disable it in KMS and schedule its deletion. Don't wait the 2 h of a scheduled rotation.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> kms-retire --key previous --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

4. **Tell partners** (who: a founder). Their security contacts: the `kid`, the window and the count of forged signatures from CloudTrail, and what to re-check. Pinning partners update their pins.

5. **A new standby** (who: a founder). Create a new ECC_NIST_P256 key in another region than the new active key (with the same key policy), publish it, deploy.

   ```sh
   corepack pnpm --filter @hana-id/scripts run identity-key <env> kms-add --role standby --key <get-public-key.json> --yes
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   ```

**Verify**

- CloudTrail shows no `Sign` by the revoked access key after the cut-off, and the API's JWKS lists no suspect kid.
- `identity-key <env> show`: the standby is active and a new standby is published.

**Follow-ups**

- Build the CloudTrail reconciliation and alarms before mainnet (docs/operations.md "Identity token keys on AWS KMS").

**Refs:** [`docs/operations.md#identity-token-keys-on-aws-kms`](operations.md#identity-token-keys-on-aws-kms), D215 (`docs/decisions.md`), D219 (`docs/decisions.md`) · **See also:** [identity-signing-key-compromised](#identity-signing-key-compromised), [api-or-cloudflare-compromised](#api-or-cloudflare-compromised)
