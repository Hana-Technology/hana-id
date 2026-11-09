# Hana Home build plan (batches)

**Status (2026-11-09): H0 (this plan, the spec's rewrite, D460–D466, the readiness rows) on branch `docs/hana-home-h0`; H1 built on branch `feat/hana-home-h1`, its security review's fixes on `feat/hana-home-h1-2` (not merged, not deployed; see its result line below); H2 built on branch `feat/hana-home-h2` and H4 built on branch `feat/hana-home-h4`, merged on `feat/hana-home-h2-h4` with their security reviews' fixes (not merged, not deployed; see their result lines); H3, H5, H7–H12 not started; H6 built on branch `feat/hana-home-h6` (not merged, not deployed; see its result line); H6's design and D480–D489 on branch `docs/hana-home-h6-design` (not merged).** Splits `docs/hana-home-spec.md` (D40, D45, D98, D461–D466, D468, D480–D489) into reviewable
batches. The spec stays the source of truth for *what* to build; this file says *in which order*, *what each batch
ships* and *what users see after it*. Like a spec it is history once the work merges: the current state lives in the
reference docs (`docs/README.md`).

Checked against `origin/develop` @ 6304d21, by reading only: no tests were run, and sandbox-dev's deployed state wasn't
checked. Sizes as in the spec: S ≤ 1 day, M 2–3 days, L 4–5 days.

## Rules for every batch

- Each batch merges into `develop` on its own after `pnpm verify`, and updates the reference docs it touches (with
  their "Last verified" lines) in the same branch.
- **Nothing ships half-wired to users.** `/home` is linked from nowhere until H12. H5 changes partner tabs, so it ships
  only after H4 is live.
- **Address safety.** No batch changes a path, a key rule or derivation. Home derives through the chain-resolved root
  (H8's golden test enforces it). A dedicated Home scope or a nonzero `key_index` would change addresses; neither is
  proposed. H6 is the only contract change and has no address impact.
- Testnet only, sandbox-dev only. Deploy order: D1, then the API, then the pages.
- D1 migration numbers are assigned at merge; 0016 is the next free one (0015 is `link_usage`). The next Neon migration
  is 0008.
- **No new cron trigger** (D417: 5 of 5, asserted in `apps/admin/scripts/test/gen-wrangler.test.ts`). Hourly work goes in
  `vaultMaintenance` under `isHourlyRun`.
- **One `hk` per sign-in.** Each sign-in makes a new `hk`, and `homeMessage` doesn't carry `expiresAtMs`. A batch that
  reuses `hk` across sign-ins must add `expiresAtMs` to `homeMessage` first (H1's review).

## What changed from the spec (the review of develop)

The spec's body was rewritten in H0 to agree with these ten points. They're kept here because the batches rest on them.

**Wrong in the old body**

1. **Google-only.** `scope#google#sub#0` misses linked accounts: a member opens its root's path
   (`apps/api/src/session-standing.ts`). Email-only users got no Home. Now D463 and H10.
2. **Coverage row 1.** "Can't disable without its own client" is false once email is on, because `email:{scope}` counts
   in `scope.clients`. Such a scope could cut shared Google at once, stranding unlinked Google users. Now the exit client (D468, D480) and H6.
3. **Export (D430).** The old body lacked the 60 s auto-hide, the guard, the warnings and `key_exported`. Home's one login
   opens both chains, so it records at the derive with `chain` null. `user_events.app_id` is NOT NULL, so H3 must pick
   the scope's app or relax it (open item 4).
4. **Email sharing.** Absent. D411 point 6 and the D442 amendment need Home to list and stop shares. The revoke route
   takes a session proof (`apps/api/src/identity/email.ts`), so Home needs its own route. Then delete the partner
   requirement in `docs/integration.md` ("Required if you use auto-approve").
5. **D434.** The issuer gate needs an active app with email on (`emailApp` in `apps/email-issuer/src/handlers.ts`), so a
   suspended app's email users get no token. Home's route gates on chain registration, with no new `IssuerRpc` read.
6. **Body vs D98.** It had `max_age=0` to view (item 7), remote sign-out out of scope (9), no device label (10) or
   quieter listing (8), "no contract change" (4) and no statement line (12).
7. **Crons (D417).** No new trigger. sandbox-dev's Free plan is 10 ms CPU and 50 subrequests, so `/devices` can't loop
   every scope.
8. **Retention.** Shares stay 24 h as tombstones (D178, `apps/api/src/vault/cron.ts`).
9. **Brand and expiry.** `/home` joins `AUTH_PAGE_PATHS`, `AUTH_LOGO_PATHS` and the auth page build, using
   `packages/brand` (D426). D424 covers the consoles only; Home's 15-minute identity follows its rules: detect, warn,
   lose nothing, no auto-retry, memory only.
10. **Support ID.** "Copy diagnostics" isn't in `packages/web/src`.

**Easier than the old body assumed**

- `end_user_identities` by `sub` gives a user's scopes and root; `end_user_wallets` gives addresses. Viewing needs no
  chain transaction or re-auth. `purgeDirectory` deletes both 30 days after a scope dies, so it can't be the only
  source (D462).
- Support ID: read `end_users.support_code`, and omit it when there's no row (D395's reason).
- Reuse `mode=export`, `approve-guard.ts`, `RateLimiter` `mark:` and C11's logos. Relayer objects are keyed by pool
  name, so a Home pool needs no new namespace.

## Batches

| # | Batch | Needs | Size | Person |
|---|---|---|---|---|
| H0 | Spec rewrite, this plan, D460–D466, readiness | — | S | — |
| H1 | Core layouts; Home identity verifier, `/v1/home/config` | — | M | — |
| H2 | `GET /v1/home/apps` | H1 | M | — |
| H3 | `POST /v1/home/login`, Home pool, `key_exported` | H1 | M | create and fund the Home key (2 NEAR) |
| H4 | `vault_consents`, device label, consent endpoints, status read | H1 | M | — |
| H5 | Vault: register first, fail closed, status read, revoke paths | H4 live | M | — |
| H6 | Contract: the exit client (D468, D480–D488), `migrate` to state version 4, the upgrade (built: `feat/hana-home-h6`, not merged, not deployed) | — | L | create the exit Google client (same Cloud project as the shared client); the council runs the upgrade and `set_exit_clients` |
| H7 | `/home` page: sign-in, Your apps, addresses, expiry | H1, H2 | L | — |
| H8 | Export in Home | H3, H7 | M | — |
| H9 | Devices, consent, share and email-share revoke | H5, H7 | M | — |
| H10 | Email users | H3, H7 | M | — |
| H11 | Billing: the statement line | H3 | S | apply Neon 0008 |
| H12 | Playwright, testnet run, reference docs, link `/home` | all | M | run and sign off |

**Parallel:** H0 beside H1. After H1: H2, H3, and H4 then H5. H6 any time; its upgrade and `set_exit_clients` go before H10's route can mint tokens. After H7: H8, H9, H10. H11 after H3. Route
additions conflict in `apps/api/src/index.ts`, so expect small merges. About 30 agent-days, roughly 4 weeks in parallel.

**First batch after H0: H1.** It needs no open decision, and everything else rests on it.

### H0: documents

- **Scope.** The spec's body rewritten to D98, the ten points above and D460–D466; this plan; the decisions; readiness
  rows 1.14–1.16, 7.4, 7.5 and the follow-ups 9.9–9.11.
- **Tests.** `pnpm verify --quick` (the docs checks).
- **User-visible.** Nothing.

### H1: core layouts and the Home identity

- **Scope.** `homeNonce`, `homeMessage` and the consent payloads; the identity verifier (the `x-hana-home` header);
  `GET /v1/home/config`; CORS for `authOrigin`; log redaction of `x-hana-home`, `sub` and path hashes.
- **Files.** `packages/core/src`; `apps/api/src/home/` (new).
- **Tests.** Vectors against an independent Node implementation; every identity refusal in the spec's list.
- **Migration / deploy.** API.
- **User-visible.** Nothing.
- **Result (2026-11-09, `feat/hana-home-h1`, not merged, not deployed).** `packages/core/src/home.ts` (subpath `@hana-id/core/home`) and `test/vectors/home-v1.json`; `apps/api/src/home/` (`homeGate`, `homeAudienceRoute`, `GET /v1/home/config`, CORS); `log()`'s redacted names; D473, D474. No route uses the verifier yet (H2 onwards); no contract or derivation change. `apps/api/src/login-token.ts` gained its app-less case.
- **Security review (2026-11-09, `feat/hana-home-h1-2`).** No critical, high or medium issue. The low cost issue is fixed (D475: a limiter call's row reads no longer grow with the markers held); the signed vector now goes through `homeGate` and is asserted in core. The review's conditions are on the batches they bind (H7, H10, H6, "Deploy checklist", the "One `hk` per sign-in" rule) and in `docs/security.md`.

### H2: the app list

- **Scope.** `GET /v1/home/apps`: the list from `scopes.first_session_at`, the "your apps" overlay from the wallet
  directory (D462, D466), coverage, addresses, Support ID, the quieter
  listing, `hana_held_clients`, `admin home:client:add`.
- **Tests.** Each coverage row; suspended, deleted and purged scopes; a member resolving to its root.
- **Migration / deploy.** D1 (`hana_held_clients`, the listing flag); API.
- **User-visible.** Nothing (no page yet).
- **Security review (2026-11-09, on `feat/hana-home-h2-h4`).** `?scopeId=` no longer finds a quiet scope; the overlay reads `active` rows only (D500); the unreleased-app exposure is closed by `apps.first_login_at` (D462: strangers see only apps with a recorded login, a scope's own users see all of its apps).
- **Result (2026-11-09, `feat/hana-home-h2`, not merged, not deployed).** `apps/api/src/home/apps.ts` (`GET /v1/home/apps`), `coverage.ts`, migration 0016 (`hana_held_clients`, `scopes.home_quiet`), `scripts/lib/admin-home.ts` (`admin home:client:add`, `admin home:listing`), a 60 s per-isolate `get_scope` cache for Home's list in `views.ts`; `docs/api.md`, `security.md`, `architecture.md`, `operations.md`. D500–D503, confirmed by the user 2026-11-09. No key is derived; no contract or derivation change. Deviations from the spec: no `sharedLoginEndsAtMs` (D480) or `liveDevices` (H9), `exit` and `unknown` coverage values (D501).

### H3: Home derives

- **Scope.** `POST /v1/home/login`: no app gate; `verifyLoginToken` without `appId`; `sessionStanding` for the root path;
  the limits; the `home` pool; `key_exported` at the derive with `chain` null.
- **Files.** `apps/api/src/login.ts`, `login-token.ts`, `relayer-config.ts`, `mainnet-demo.ts`; `scripts/deploy-contract.ts`;
  the watchdog's pool list.
- **Tests.** Every limit before the relay; a member's path; a suspended app; nothing relayed on any failed check.
- **Carried from H2's review (D500).** A matured link counts in Home's list only once the directory has `active`, so `POST /v1/home/login` must write the member's row as `/v1/login` does (`syncAfterLogin`); without it, a member of a shut-down app never turns `mine`.
- **Migration / deploy.** D1 `home_usage`, and `user_events` if open item 4 relaxes it; key, API.
- **User-visible.** Nothing.

### H4: consents on the server

- **Scope.** `vault_consents`; the share's device label; `/v1/vault/consents*`; `consent` on `GET /v1/app`, which also
  reports a revoked share (D465); the prune in `vaultMaintenance`.
- **Tests.** The spec's consent list; both persistence modes; a revoked share reads `'revoked'`.
- **Migration / deploy.** D1; API.
- **User-visible.** Nothing.
- **Security review (2026-11-09, on `feat/hana-home-h2-h4`).** The 10/min window spends only signed requests (D510); a `'none'`-mode register makes one chain read and answers `503 session_not_visible` when the chain doesn't show the session yet; 20 rows per session key (D513).
- **Result (2026-11-09, `feat/hana-home-h4`, not merged, not deployed).** Migration **0017** (`vault_consents`, `vault_shares.device_label`, the `path_hash` indexes); `POST /v1/vault/consents` and `/revoke` (`apps/api/src/vault/consents.ts`, `consent-store.ts`) in both modes, reusing `checkShare` and `checkChainSession`; `deviceLabel` on `POST /v1/vault/shares`; `consent` on `GET /v1/app` for the vault's `x-hana-consent`; the prune in `vaultMaintenance`. D510–D513 (confirmed by the user 2026-11-09). No vault or SDK change: no live partner tab changes, and H5's vault still needs H4 live first. Deploy: D1, then the API. Before the D1 migration an API at this commit fails to create shares, so the order matters.

### H5: the vault

- **Scope.** Register before use, fail closed, the status with the existing 10 s read (no new polling, D465), revoke
  paths. Changes live partner tabs.
- **Files.** `packages/web/src/vault/vault.ts`, `auto-approve.ts`.
- **Tests.** No grant if registering fails; `'revoked'` clears the local consent; a revoked share stops auto-signing
  within about 10 s.
- **Migration / deploy.** The vault, after H4 is live.
- **User-visible.** Auto-approve can't be turned on while the API can't record it (D98 item 13). Nothing else.
- **Carried from H4's review (D510, D513).** Never give a `consent_id` to the partner page. Tell `409 bad_counter` from `409 consent_exists` (a stale counter retries with the expected value; a repeated id does not). `hana_revokeAutoApprove` sends no server revoke when there is no local consent. Render the partner-set policy `label` as text only. Retry `503 session_not_visible` a few times with its `retry-after`, then fail closed like any failed register; `429 too_many_consents` fails closed with no retry.

### H6: the contract

The design is `docs/hana-home-h6-design.md`; its decisions are D480–D489.

- **Scope.** D468's exit client. Appended state `exit_clients`, `pending_exit_clients`, `exit_window`; `set_exit_clients`
  (owner only, at most 4 entries; a new client waits `governance_delay_ms`, D482; a removal is immediate and retired
  forever, D483); `get_config` gains both lists and the hourly total. `exit_scope()`, called only from `open_session` before
  `session_scope`, which stays unchanged. Client sets kept disjoint (`assert_client_available`, `set_exit_clients`,
  `set_shared_clients`, `set_console_audiences`). A self-issued provider's client must be exactly `email:{scope_id}`, which
  also refuses `("email", "hana-home")` as a scope client. Exit sessions at most 30 minutes and 3 uses, `link_jwt` refused
  (D486). One `exit_session_opened` event per session, no `sub`, and the hourly alert-only counter (D487). The watchdog's
  critical diff gains both lists and a pinned expected value. `homeAudienceRoute`, `/v1/home/config` and `/v1/home/login` admit
  the exit client; `checkClientScope` stays closed to it for partner logins.
- **Not in this batch (D480).** The delayed turn-off, the caller changes (`validate.ts`, `SAFETY_METHODS`, the console) and the
  partner notice are gone: `disable_shared_login` keeps working unchanged.
- **Files.** `contracts/hana-signer/src/lib.rs`, `sessions.rs`, `registry.rs`, `migrate.rs`, `tests.rs` and
  `integration-tests/`; `apps/watchdog/src/diff.ts`; `apps/api/src/home/identity.ts`, `handlers.ts`; `docs/contract-interface.md`,
  `api.md`, `security.md`.
- **Tests.** The design's section 6: exit on a scope with `allow_shared` false, for Google and email; the refusals; disjointness;
  the golden paths through own client, shared client and exit, with a member reaching the root's path; v3 to v4 keeping every
  field, and the DAO upgrade in near-workspaces; the real Google account through the shared and exit clients, comparing the
  address (D484).
- **Size.** L (4–5 days), as this plan had it: the delayed turn-off and its caller changes are gone, and the state, `migrate`,
  the disjointness checks and the upgrade test take their place.
- **Migration / deploy.** **`migrate` is needed: state version 4** (D468 adds state). Copy the exact v3 struct, append the new
  fields empty; after this a rollback to v3 is impossible. Order on sandbox-dev: (1) confirm `state_version == 3` and
  `scope_for_client("email", "hana-home")` is null; (2) deploy the watchdog with the new diff; (3) DAO `propose_upgrade`, wait,
  `execute_upgrade`, by `deploy-contract --upgrade`, then check `state_version == 4`; (4) the council runs `set_exit_clients`
  (2-of-3); (5) the API, the issuer's H10 route, the pages. Step 4 goes before anything can mint `hana-home` tokens. Confirm
  the same Google `sub` live before the exit client is used (D484). Land before the audit (readiness 6.1).
- **Condition (H1's review).** If this lands before H10, take H10's condition here: the contract refuses a client proof
  for `("email", "hana-home")`, as the audience-shape rule above does.
- **User-visible.** Nothing until H12. Partners keep their instant turn-off.
- **Result (2026-11-09, `feat/hana-home-h6`, not merged, not deployed, awaiting its security review).** `contracts/hana-signer` (`exit.rs`, `set_exit_clients`, `exit_scope`, the audience-shape rule, `migrate` to v4, event version 1.3.0, the `v3_state_fixture.json`, `src/tests/email/exit.rs`); integration test `v3_to_v4_upgrade_through_the_dao_keeps_every_view_and_path` and `login_gas_of_v4_against_v3_and_of_an_exit_login` in `integration-tests/tests/governance.rs`; `apps/api` (`homeAudienceRoute` route `exit`, `/v1/home/config`'s `exitGoogleClientId`, `checkClientScope` unchanged and tested); `apps/watchdog` (`exitClients`, pins, the hourly alarm, the critical diff), `packages/env`, `packages/playbooks`; `set_exit_clients` in `scripts`; `docs/contract-interface.md`, `api.md`, `security.md`, `architecture.md`, `operations.md` ("Hana Home exit client"). D493, D494. Gas and storage measured (`docs/contract-interface.md` "Gas and storage of the exit client"): +0.02–0.03 Tgas on every login, +0.2 Tgas on an exit login (the design's estimate: under 0.1), root state +24 B empty, +82 B with one Google client. No path or derivation change: the golden tests through own client, shared client and exit give identical strings; existing vectors unchanged. Not done (for the deploy): the live Google `sub` check and the owner's Google client. H6's security review comes next.

### H7: the page

- **Scope.** `/home`, `/login?mode=home`, CSP, brand, sign-in, Your apps, addresses, the identity's expiry rules.
- **Files.** `packages/web/src/auth/home-page.ts` (new), `entries/home.ts`; `apps/api/src/pages/host.ts`.
- **Tests.** The state machine; the opener checks; text-only rendering of partner strings; expiry (detect, warn, lose
  nothing, no auto-retry).
- **Migration / deploy.** Pages. Not linked yet. Run the "Deploy checklist" below first.
- **User-visible.** Only by typing the URL.
- **Condition (H1's review).** `/login?mode=home`: only a same-origin opener at `/home` may supply the nonce.

### H8: export

- **Scope.** Extract the reveal from `export-page.ts` and reuse it with D430's guard, warnings and auto-hide; PRK ≤ 5 min;
  the root path via `get_identity` on both RPC providers (D263).
- **Tests.** Home's address equals the vault's, for an own path and a member's; PRK zeroed at 5 min and on leave.
- **Migration / deploy.** Pages.
- **User-visible.** Only by typing the URL.

### H9: devices and revocation

- **Scope.** `/v1/home/devices`, consent revoke, share revoke, email-share list and revoke, the UI, the "Manage in Hana
  Home" links; remove D442's partner requirement from `docs/integration.md`.
- **Tests.** Only this user's rows; a 404 for anyone else's id.
- **Migration / deploy.** Needs 0014 and the email keys on the env; API, pages.
- **User-visible.** Only by typing the URL.
- **Carried from H4's review.** Render the partner-set policy `label` as text only, here as in H5.

### H10: email users

- **Scope.** An issuer Home route with the audience `hana-home`, on no scope and on the exit list (D485; `homeAudienceRoute`
  refuses it unless `("email", "hana-home")` is in force there, D494, so the entry must have waited its delay first); the `/login/email`
  mode; gating on the chain's registration, not an active app (D434, D463); `mint()` hardcodes `email:${scopeId}`
  (`apps/email-issuer/src/handlers.ts`), so the exit's token needs its own case.
- **Files.** `apps/email-issuer/src/handlers.ts`, `apps/api/src/email-token.ts`, `packages/web/src/auth/email-page.ts`.
- **Tests.** A Home identity token can't open a session, an exit token opens one for its own user (D485); the route takes no
  free-form nonce; the same `sub` as a normal login; a suspended scope works; the mailbox limits still apply.
- **Migration / deploy.** Issuer, API, pages (the API before the issuer).
- **User-visible.** Only by typing the URL.
- **Condition (H1's review; H6 or H10, whichever lands first).** If the route signs a caller-supplied nonce, an owner can
  get a `hana-home` token carrying `client_proof_nonce` for their own mailbox and register `("email", "hana-home")` on
  their scope (`registry.rs`, `AddClient`). Refuse that client: in the contract's `propose_change`, or in the issuer by
  computing the `homeNonce` from the key, expiry and salt instead of signing what it's given. Test it. Until then D474's
  "on no scope" isn't a guarantee. H6's design does both (`docs/hana-home-h6-design.md` section 2): the exit list and the
  contract's audience-shape rule, and the issuer computing the nonce from typed inputs.

### H11: billing

- **Scope.** A ledger endpoint for Home derives, attribution by `scopes.org_id`, the "Hana Home logins" statement line;
  after the app is gone, Hana's internal org (D461).
- **Files.** `apps/api/src/usage/event.ts`; Neon 0008 widens the `app_id` check; the statement renderer.
- **Tests.** Report and statement totals; an active app's line; Hana's org after exit.
- **Migration / deploy.** Neon 0008 as 0005 was; API.
- **User-visible.** The statement line, once usage capture is on.

### H12: closing

- **Scope.** Playwright in three browsers; one testnet derive per coverage kind; reference docs (`architecture`,
  `security`, `api`, `integration`, `operations`, `contract-interface`); readiness 7.4; link `/home` from the consent
  screen and the approval popup.
- **Migration / deploy.** sandbox-dev.
- **User-visible.** Hana Home.

## Deploy checklist

Run by hand on an env before H7's first deploy to it and before each later Home deploy (H12 moves it into
`docs/operations.md`):

- The shared client's **only** authorized redirect URI is `{authOrigin}/login/callback` (`docs/batch-b-spec.md`
  "Chain of trust for a shared-client login", the redirect URI row in `docs/operations.md`), and it has no JavaScript
  origins. Home's Google route relies on it: another redirect URI on that client could receive a user's token with a nonce
  for its own Home key, which is a Home identity. No code can see a Google client's settings, so this stays manual.
- The exit client (D484) is in the same Google Cloud project as the shared client, and its only redirect is Home's page. Check
  it before `set_exit_clients` puts it on the list.

## Decided on 2026-11-09

| Decision | Choice | Batch |
|---|---|---|
| D460 (row 1.14) | Reversed the same day by D480: turning off shared login stays immediate | — |
| D461 (row 1.15) | Statement line while the app is active, Hana pays after it's gone | H11 |
| D462 (row 1.16) | The list from `scopes.first_session_at` and `apps.first_login_at`, the wallet directory as a "your apps" overlay | H2 |
| D463 | Email-only users get Home at launch | H10 |
| D464 | Dropped the same day by D481: no owner rights over partner scopes | — |
| D465 | A revoked share stops auto-signing within about 10 s, in the vault's existing read | H4, H5 |
| D466 | Home may use the wallet directory, disclosed in the privacy notice | H2 |
| D468 | A permanent exit client, whatever a partner does | H6 |
| D480 | D460 dropped: turning off shared login stays immediate, needs no remaining Google client; `disable_shared_login` unchanged | H6 |
| D481 | D464's owner seat dropped | onboarding |
| D482 | A new exit client waits the upgrade delay (`governance_delay_ms`) | H6 |
| D483 | The council can remove an exit client at once; it is then retired forever | H6 |
| D484 | A new, dedicated Google client for the exit, in the shared client's Cloud project; `sub` confirmed live before use | H6 |
| D485 | The email exit reaches scopes that dropped their email client; a second signer is a priority | H6, H10 |
| D486 | Exit sessions at most 30 minutes and 3 uses; `link_jwt` refused | H6 |
| D487 | An hourly exit counter that alerts and never refuses; one event per session | H6 |
| D488 | No waiting period before an exit releases a key | H6 |
| D489 | Enterprise partners told they can't exclude Hana Home (9.12); legal reviews 9.6 | legal |

## Still open

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | The production domain for `/home` (readiness 4.1, 4.2) | founder | production only |
| 2 | **Closed 2026-11-09.** Neither is needed: D460's Google-client requirement is dropped (D480) and D464's owner seat is dropped (D481), because the exit client (D468) covers users | — | — |
| 3 | **Closed 2026-11-09 (D480).** `disable_shared_login` stays and keeps working unchanged: there is no delay to bypass | — | — |
| 4 | `user_events.app_id` is NOT NULL and a Home derive is per scope: record the scope's app, or relax the column | Claude build | H3 |
| 5 | Billing of a suspended app: Hana pays for now (D461's note); to discuss with colleagues before finalising | founder, colleagues | H11 |
| 6 | **Closed 2026-11-09 (D481).** Hana holds no owner seat, so there is no `SetOwners` to watch for | — | — |
| 7 | Partner terms (readiness 9.9), the privacy notice line (9.10), telling Enterprise partners they can't exclude Home (9.12), legal's review of 9.6 (D489) | legal/founder | mainnet |

## Contract and derivation

Only H6 touches the contract. It adds the exit list, its limits and `migrate` (state version 4), and changes no path or key:
**no address impact** (`aud` never enters the path), and no batch changes derivation. The exit is permanent only within limits:
a pause stops it, the council can remove it at once (D483), and it depends on Google keeping the client alive. Partners keep their
instant turn-off of shared login (D480).

## Independent security review

- H1: identity (done 2026-11-09: no critical, high or medium; see H1's review line).
- H3: a derive without an app gate.
- H4–H5: auto-sign.
- H6: the contract (the list for the auditor is in `docs/hana-home-h6-design.md` section 6).
- H7: partner strings on the callback origin.
- H8: keys in memory.
- H9: cross-user revoke.
- H10: the issuer route.

## Critical files

- `apps/api/src/login.ts`
- `packages/web/src/auth/export-page.ts`
- `packages/web/src/vault/vault.ts`
- `contracts/hana-signer/src/registry.rs`
- `apps/api/src/directory/read.ts`
