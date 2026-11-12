# Architecture: how Hana ID works today

Current-state map of the whole system: components, flows, key derivation, data stores, environments and the relayer.
Last verified against code: 2026-11-12 (branch `feat/near-move-wallet`, not merged, not deployed: "Moving a wallet out" offers the NEAR key, D768–D771); 2026-11-11 (branch `feat/near-demo`, not merged, not deployed: "Signing"'s `hana.near.activate` and the hosted demo's guestbook write, D750–D754); 2026-11-11 (branch `feat/near-relayer`, not merged, not deployed, on `feat/near-directory` 9cb4cc68, after three security reviews (in-flight cap, per-app caps and budgets, the per-sender nonce floor): "Relayer design"'s NEAR meta-transaction relay, D730–D739); 2026-11-11 (branch `feat/near-directory`, after its security review: what "listed" means, NEAR's two rules, the vault's wait after `near: false`, D762, D763); 2026-11-11 (branch `feat/near-directory`, not merged, not deployed: "Wallet directory": the NEAR record, its proofs domain, migration 0019, the unlock backfill, the relayer's lookup and the reads that show NEAR, D755–D759; "Partner identity token": its `wallets` stay Stellar and EVM, D760); 2026-11-11 (branch `feat/near-core`, not merged, not deployed: NEAR as a third wallet chain: "Key derivation"'s `("near", "ed25519")` row, "Signing"'s NEAR requests and their network checks, "Key export"'s NEAR key, D720–D729); 2026-11-11 (branch `fix/console-email-login-flow`, not merged, not deployed: the console's step-up step 1 stores the page an action returns to, D711); 2026-11-11 (branch `docs/partner-start-here`, not merged, docs only: "Status of each part" and the H1, H7–H11 headings: Hana Home H7–H11 live on sandbox-dev since 2026-11-10 at `{authOrigin}/home`, as the user reported, still linked from nowhere until H12); 2026-11-11 (branch `fix/console-getting-started`, not merged, not deployed: the console's app page and guarded changes in force, D701; the Users screen from the manifest, D702; the snippet's env name, D703); 2026-11-11 (branch `fix/signed-out-reason`, not merged, not deployed: "Hana Home's devices and auto-approve" and "Revoke and logout": a session ended because its share was revoked tells the page `signed_out`, the `disconnectReason` event, the `signedOut` broadcast, D695 proposed); 2026-11-10 (branch `feat/signout-reach`, not merged, not deployed: "Hana Home's devices and auto-approve": the vault's share check in every app, the idle pace, the light `POST /v1/vault/share-status`, the hidden-tab rule, the checks before a signature and a cached identity token with the 3-minute grace, the backoff; the Rate Limiting row's two status bindings; D680–D684, D690–D694); 2026-11-10 (branch `feat/html-emails`, not merged, not deployed: the files Worker serves the mail logo, D685); 2026-11-10 (branch `feat/html-emails-ui`, not merged, not deployed: Hana Home's header masks the address once the sign-in has ended, D689); 2026-11-10 (branch `feat/html-emails`, not merged, not deployed: the designed HTML mails in the email issuer's and the admin Worker's rows, D670–D675; Hana Home's header names an email account's address, the move section's collapsed shape, the code screens' spacing, D676–D678; D679 proposed); 2026-11-10 (branch `merge/h9-h10`, not merged, not deployed: "Moving a wallet out" points at H10's routes for coverage `exit` and email accounts); 2026-11-10 (branch `fix/testing-1110`, not merged, not deployed: the test-app note under the mainnet demo, `launcherKind`, D572, D573); 2026-11-10 (branch `feat/hana-home-h11`, not merged, not deployed: "Home's billing": the `home_login` ledger event, the payer rule, the report's Home row, the Home keys in `relayerKeys`; the data table's ledger row; D585–D594; after the independent review: the partner's ledger rows, the nonce check with capture off and its share of a run; D595–D599; D585–D599 confirmed by the user 2026-11-10, D605); 2026-11-10 (branch `feat/hana-home-h9`, not merged, not deployed: "Devices and auto-approve (H9)", the vault's device label, D606–D615; the member check, `GET /v1/app`'s `share`, D661–D665); 2026-11-10 (branch `feat/hana-home-h10`, not merged, not deployed: "Hana Home: email and the exit client (H10)": the issuer's Home route, the page's email sign-in and per-app code, the exit client's sign-in through `/home/callback`, D616–D627; after its security review, D628, D629, D666–D669); 2026-11-09 (branch `feat/hana-home-h5`, not merged, not deployed: the vault's side of consents, D530–D535); 2026-11-10 (branch `feat/hana-home-h8`, not merged, not deployed: "Moving a wallet out (H8)": `home-export.ts`, `key-reveal.ts`, `export-path.ts`, `hana:home-derive-params`, `/home`'s policy, D575–D584); 2026-11-10 (branch `feat/hana-home-h7`, not merged, not deployed: "The page (H7)": `/home`, `/login?mode=home`, `hana:home-params`, D550–D559); 2026-11-10 (branch `docs/tidy-deployed-1110`: "Status of each part" and the section headings brought in line with sandbox-dev at `develop` 9b0ae580; the separate "Last verified" lines left by merges folded into this one, exact duplicates dropped; the "not merged, not deployed" notes in the older clauses are history); 2026-11-09 (branch `feat/hana-home-h3`, not merged, not deployed: "Hana Home derive", the `home` relayer pool); 2026-11-09 (branch `feat/hana-home-h2-h4`, not merged, not deployed: the app list's `apps.first_login_at` and the D1 row, D462 amended); 2026-11-09 (branch `feat/hana-home-h2-h4`, not merged, not deployed: "Hana Home identity" and its app list, the overlay's `active` rule and a quiet scope's `appId` link; "Auto-approve consents on the server": one chain read, the 20-row cap; D500, D502, D513); 2026-11-09 (branch `feat/hana-home-h2`, not merged, not deployed: "Hana Home identity" and its app list, "Owner and registry changes", the D1 row: H2 built, D500–D503); 2026-11-09 (branch `feat/hana-home-h4`, not merged, not deployed: "Auto-approve consents on the server", the data stores, D510–D513); 2026-11-09 (branch `test/flake-fixes`, not merged, not deployed: the popup watch's late `relayed` signal, D495); 2026-11-09 (branch `feat/hana-home-h6-2`, not merged, not deployed: "Hana Home identity": the email Home audience on the exit list, D494); 2026-11-09 (branch `feat/hana-home-h6`, not merged, not deployed: "Hana Home identity": the exit client (D468, D484, D490); contract v4); 2026-11-09 (branch `feat/hana-home-h1`, not merged: "Hana Home identity"; D473, D474); 2026-11-09 (branch `fix/approval-waiting-screen`, not merged: the approval popup's screen after an answer, D471); 2026-11-09 (branch `feat/email-login-9`, not merged: the partner console → issuer binding, the links counts, the Email login toggle: D444–D448); 2026-11-09 (branch `fix/before-mainnet-sweep-2`: dispatch's keyed routing and failover, D455's note, the key swap in `deploy-contract`, D456's note); 2026-11-09 (branch `fix/before-mainnet-sweep`: the relayer pools and dispatch, D455, D456); 2026-11-09 (branch `feat/email-sharing-2`: brought up to date with `develop` @ a3de75e, not merged; D411, D438–D443, migration 0014, the issuer's `IssuerRpc`, the console redesign); 2026-11-06 (branch `feat/email-sharing`, not merged: "Email sharing with partners", the identity token's `email` claim and sealed address in steps 3–4, D1's 0014 in "Data stores"; D411, D438–D443); 2026-11-06 (branch `feat/user-events-retention`: "Data stores"' `user_events` and "Retention": 24 months, dead scopes, erasure by internal id and address, D433); 2026-11-06 (branch `feat/issuer-readonly-rpc`: the email issuer's row in Components and the new "Email issuer → API" connection, `IssuerRpc` instead of the read-write `APP_DB`, D434); 2026-11-06 (branch `feat/api-near-rpc-fallback`: "Status of each part"'s new row, "Who talks to whom"'s API → NEAR row, "Environments and manifests"' `apiRpcFallbacks`, D435); 2026-11-06 (branch `feat/mainnet-demo-key-export`: "Mainnet demo (D428)" under Signing, "Key export"'s auto-hide, guard and `key_exported` event, "Data stores"' `user_events`; D428–D430); 2026-11-06 (branch `feat/partner-friction-fixes`: the partner client → vault row's post-load answer deadline and `no_answer`'s origin, D427); 2026-11-06 (branch `fix/google-key-hysteresis`: "Google RSA keys": the rollout hysteresis of the JWKS cron and the watchdog, D422); 2026-11-06 (branch `feat/console-ux-redesign`: the console SPA's row, D421); 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: every Hana email through SendGrid (the shared `packages/sendgrid` adapter), the admin Worker's and the watchdog's rows, the watchdog's `SENDGRID_API_KEY`, D401; sandbox-dev's manifest has its dashboard blocks, so its API's `REFUSED_ORIGINS` lists seven origins and `FILES_ORIGIN` is set); 2026-11-05 (branch `fix/security-review-1105`: "Data stores"' issuer 0003 note, the search's ticket rule, D410); 2026-11-05 (branch `feat/account-migration`: "Configuration"'s hosting note, Custom Domains and `cloudflare.accountId`, D404); 2026-11-05 (branch `feat/deploy-check-all-workers`: the build id on every Worker through the shared deploy wrapper, the console SPA's meta, the admin's and watchdog's read through wrangler, D406); 2026-11-05 (branch `feat/sdk-error-request-id`: "Support ID lookup" step 4, the request IDs partners get from the SDK's errors, D405); 2026-11-05 (branch `fix/usage-setup-neon-api-passwords`: the `.secrets/<env>/` row: `neon-api-key`, role passwords from Neon, D403); 2026-11-05 (branch `fix/popup-signal-before-navigate`: login step 4's signals, acked by the vault before the popup leaves, D400); 2026-11-05 (branch `feat/batch-c-15-screen`: "Support ID lookup": the admin screen and the email join through `DirectoryRpc.get` as `support_lookup`, D399; the Components row of `ISSUER`); 2026-11-05 (branch `feat/batch-c-8b`: the Users screen in Status, Components' connections, "Staff reads of the user directory" and the issuer D1's 0003; D388–D392); 2026-11-05 (branch `fix/popup-early-close-deadline`: login step 4's closed popup, a close within D347's 8 s waits 90 s for an answer, then `login_cancelled`, D398); 2026-11-05 (branch `chore/ci-cost`: CI and the outside identity-JWKS probe turned off on testnet, D387); 2026-11-09 (branch `feat/test-page-command`: the operator's call to the watchdog's test page, D449); 2026-11-09 (branch `feat/mainnet-demo-live-prices`: the mainnet demo's flow, live prices from the API, the vault's re-check, D436); 2026-11-05 (branch `feat/batch-c-15`: "Wallet directory" step 5, the Support ID in the
session answers and the vault; the new "Support ID lookup", D394–D397); 2026-11-05 (branch `feat/coop-canary`: "Login, one transaction" step 4's closed popup: Google's COOP rechecked before each release by `coop-canary`, D386); 2026-11-05 (branch `fix/webcrypto-linux-webkit`: the login's step 2, the session key's failure as `derive_failed` with its reason and which keys WebKit Linux refuses, D385; "WebCrypto on the login, export and signing paths"); 2026-11-05 (branch `feat/deploy-build-check`: "Environments and manifests": the build id
in every Worker and page bundle and `deploy-check`, D384); 2026-11-05 (branch `chore/ci-cost`: the outside identity-JWKS probe runs every 3 hours, D383); 2026-11-05 (branch `chore/identity-probe-hourly`: the outside identity-JWKS probe runs hourly, D382); 2026-11-05 (branch `fix/e2e-flakes`: the login's step 2, the session key's retry on WebKit Linux's
Ed25519 `OperationError`, D381); 2026-11-04 (branch `feat/batch-c-13`: retention and the erasure path in Status, Components
(the usage ledger and admin Worker rows) and "Data stores" (what is purged when, D360–D369)); 2026-11-04 (branch `feat/console-reports-upgrades`: the partner console's usage, statement and pending-upgrades screens, D370–D374); 2026-11-04 (branch `feat/batch-c-10`: `at_hash` in the claim allow-list everywhere, D342; the partner console's fresh sign-in and write paths, D343, D350–D358); 2026-11-04 (branch `feat/user-id-identity-sub`: the wallet directory's three ids and the record's session signature, D346 and the D311/D313 amendments: Status, "Wallet directory" steps 1, 2 and 4, "Data stores"' D1 row, the Glossary); 2026-11-04 (branch `fix/google-cancel-back-to-chooser`: D347, a closed popup is
`login_cancelled`, in "Login, one transaction" after step 4; D348's Google-only screen after a cancel; a cancel on token_first's Google
screen goes back to the chooser or case B's choices, closing there is `login_cancelled`, in "Automatic linking" step 2;
D341); 2026-11-04 (branch `feat/batch-c-12`: reports, settlement and statements in Status,
Components and "Where data lives"; D320–D329); 2026-11-04 (branch `feat/batch-c-14`: Security & monitoring and the pending-upgrades
page in Status, Components and the admin → watchdog row; D330–D338, D344); 2026-11-04 (branch `fix/abandoned-login-freeze`: "Automatic linking" step 1, the follow-up
channel's reads end with the login or the banners' limit; step 5, D263's reads run side by side); 2026-11-04 (branch `feat/wallet-directory`: the wallet directory, D310–D317: Status,
Components, "Who talks to whom"'s vault row, the login's step 10, the link relays, the new "Wallet directory" flow,
"Data stores"' D1 row (the hot DB now holds subs and wallet addresses), the Glossary); 2026-11-04 (branch `feat/batch-c-9`, merged with `develop` @ a243d6b: partner sign-in in
Status, Components (the console Worker's C9 files, the SPA, console-auth), Data stores and the new flow "Partner sign-in
to the console"; D290–D297); 2026-11-04 (branch `feat/batch-c-11`: the files Worker and logos in Status, Components and
Data stores: `apps/files`, the console's logo upload backend, `logoUrl` from `GET /v1/app` to the auth pages, the R2
logo bucket; D300–D308); 2026-11-04 (branch `feat/batch-c-8`: the admin Worker in Status and Components; D278–D285); 2026-11-04 (branch `feat/batch-c-6-merge`: batch C6 on current `develop`: member proposals with the API-verified step-up and
`ConsoleRpc.ownerAction` in Status and "Owner and registry changes", the owner-action precheck's nonce check and the claim
allow-list on both of its paths (D274), the console sink scope in the deploy, the owner-pool allowance check in the cron;
D235–D239, D277); 2026-11-04 (branch `feat/batch-c-7-merge`, C7 merged onto `develop`; written on `feat/batch-c-7` 2026-11-02: the console Worker and `CONSOLE_DB` in Status,
Components and Data stores: host dispatch, headers, CSRF, `StaffRpc`, invites and owner grants, the hourly cron, no
public route; D240–D244; on the merge branch: the Status rows say C7 is merged, inert, and C6 not merged); 2026-11-04 (branch `docs/sandbox-dev-state-1104`: what sandbox-dev runs); 2026-11-04 (branch `feat/token-first-on`: `'token_first'` in force since the spike
passed: "Who talks to whom"'s Google and tokeninfo rows, "Automatic linking" steps 1 and 2 (token_first first, second_request
the fallback), the Status row; D270); 2026-11-04 (branch `fix/user-emails-review`: "Automatic linking" step 2's token_first record-only fallback without tokeninfo and google-record after `/v1/login`, tokeninfo's answer in the popup, and "Data stores"' issuer D1 row: order-safe directory writes, unverified Google rows, forged rows accepted, the CLI's reads off the argv; D269); 2026-11-04 (branch `feat/google-token-first`: "Automatic linking" step 2, Google's email under each
`GOOGLE_EMAIL_FLOW` (`'token_first'` built, off; `'one_request'` removed; the callback's claim allow-list; the
callback's tokeninfo CSP), the issuer's `google-record` and google-match's directory write, D269, D270, D273); 2026-11-04 (branch `fix/sessions-allow-list`: the claim allow-list on every route that relays a Google token, `/v1/sessions` and `/v1/owner-actions` included, `REJECT_PII_ON_SESSIONS` retired, the smoke direct page on openid-only tokens, D271, D274); 2026-11-04 (branch `feat/user-emails`: the user directory in the email issuer's D1,
written at every successful email `verify` and read by `admin user:list` / `user:find`, in "Email login in the popup"
step 3, the email permission's explainer, "Data stores" and the issuer's row in Components; D269); 2026-11-04 (branch `feat/export-copy`: "Key export", the Show key / Hide key toggle and Copy key, D268); 2026-11-03 (branch `docs/sandbox-dev-state`: what sandbox-dev runs, per the operator on 2026-11-03: contract v3, migrations 0006/0009/0010, the API at `develop` c3c33ec, the page Workers, the email issuer Worker, the demo with email; the Status table and Components); 2026-11-03 (branch `fix/8b-rereview`: the issuer's CORS exposing `retry-after`, 3 consent
screens, the pin read's 1 s timeout (fail closed), the login's signal on google-match and the confirming reads; D263–D265); 2026-11-03 (branch `feat/email-login-8b` review fixes: member paths confirmed on both
RPCs and root pins, D263; the email permission's explainer and consent screen, D264; the access token never revoked and
google-match retried, D265; relay limits, D267); 2026-11-03 (branch `feat/email-login-8b`: automatic linking and the path through
`get_identity` in Status, the login flows ("Email login in the popup", "Automatic linking"), key export and key
derivation, D254–D259); 2026-11-03 (branch `fix/demo-polish`: the vault's `connected` event and the SDK's one
frame retry in Components, D262; `GET /v1/app` asked once more by the login, read side by side by the API, D261); 2026-11-03 (branch `feat/scope-email-client-tool`: "Owner and registry changes" gains
`admin scope:add-email-client`, D253); 2026-11-02 (branch `feat/email-login-8a`: email login in the popup and the vault in
Status, Components and the login flow (the chooser, `/login/email`, the vault's on-chain email-token check, the
`#email#` path, the record check), D245–D249); 2026-11-02 (branch `feat/email-login-6`: the API's email login part in Status, the login
flows (email tokens, `linkJwt`, the create_session proof of possession, the D155 gas), the link relays, the issuer's
URL and app lookup, D230–D234); 2026-11-02 (branch `feat/batch-c-4`: usage capture to the Neon ledger (Components, Data
stores, the login flow's step 8), the D1 `usage` counters no longer written, `session_markers` in the waiver);
2026-11-02 (branch `feat/batch-c-5`: the `ConsoleRpc` / `AdminRpc` entrypoints in
Status, Components and "Owner and registry changes", drift detection in the cron; branch `feat/identity-token-8`: the
watchdog's identity JWKS and discovery check, the outside probe and the identity-kid check in Status, Components and
the watchdog's reads, D210–D214; branch `feat/email-login-4`: the email issuer in Status and Components, with the review fixes and the
abuse re-check; branch `feat/identity-token-7`: the identity token's AWS KMS signer in Status
and Components, D215–D219); 2026-11-02 (branch `docs/consistency-pass`: "Status of each part" against `develop` @ 1c6a124,
git and `docs/operations.md`: what is merged and what sandbox-dev runs); 2026-11-02 (branch `feat/batch-c-3`: the hot DB after migration 0006 in Data stores, the
gate on `app_keys` and `scopes`, staff-proposed origins and settings in "Owner and registry changes", the
guarded-change cron); 2026-11-02 (branch `feat/batch-c-2`: `packages/oidc` in Components and the login
flow's RS256 reference, duplicate watchdog and `packages/jwks` rows removed; branch `docs/identity-token-deployed`: the identity token deployed on
sandbox-dev; branch `feat/email-login-5`: the watchdog's email issuer, link-alarm and
`unrecorded_wallets` checks in Status, Components and the watchdog's reads; branch `feat/email-login-2`: the email
login contract row in Status: sandbox tests, the v2 → v3 upgrade path, `migrate_v1` removed; branch
`feat/email-login-3`: `packages/email` in Status and Components); 2026-10-30 (branch `feat/identity-token-2`: the identity mint's checks and limits, share
tombstones, the offline standby key, D176–D179; branch `feat/identity-token-1`: the partner identity token in Status,
Components, the "Partner identity token" flow, Data stores and the Glossary; `feat/email-login-1-r2`: contract v3
email login status and path identity; `feat/playbook-gaps`: the watchdog's relayer funds reads and D1 meta;
`feat/recovery-playbooks`: the playbooks package in Components; before it `perf/login-latency-impl`, 2026-10-29:
the login flow, key persistence and the vault gate; the rest as of 2026-10-28, commit 58edee9).

Byte layouts and contract methods are in `docs/contract-interface.md`; this file links to it rather than repeating
them. The security model is `docs/security.md`, the decision log `docs/decisions.md`. Where a spec and the code
disagree, this file describes the code.

## Status of each part

Every part below is on `develop` unless the Where column names only a branch. sandbox-dev (testnet) is the only
deployed env; how each part was deployed is in `docs/operations.md`. **As of 2026-11-10** every Worker and page there runs
`develop` 9b0ae580, the signer is **contract v4** (code hash `3tPsYzYPi9UqZ3QsoxGiaukSSDx8w2Krs1VS5ygAUyhh`, the Google and email
exit clients in force), and D1 migrations are applied through 0018 on the API and 0005 on the issuer; email login
batches 1–9, email sharing, the mainnet demo and Hana Home H1–H6 (server side and the vault) are live; Hana Home H7–H11
(the page at `{authOrigin}/home`, reached by its address only until H12 links it) are live from later deploys since
2026-11-10 (`docs/operations.md` "What sandbox-dev runs"); batch C as its rows below say. The versions and dates in the rest of this paragraph and in the rows below are those of each part's first
deploy. As of 2026-11-04: batch B and
governance (owned by the council DAO since 2026-10-30) run there, now as **contract v3** (state_version 3, upgraded
through the DAO with a delayed execute), with the API at `develop` f53d63e (version 9fe0343a: the claim allow-list on every route, D271, D274), the page
Workers (vault 0a9455d0, auth 9c068864: Google's `token_first` flow on, D270), the email issuer Worker (fa18b944: the user
directory, D269; dev-env limits, D340), the demo with email login and linking, and the identity token; D1 migrations 0006,
0009 and 0010 are applied to the API's D1, 0002 to the issuer's. Batch C1–C5 were merged and ran in the API then; C6–C15 followed (the batch C rows below). The watchdog runs with the email pins (redeployed 2026-11-03, version fd6d8b27).

| Part | Where | State |
|---|---|---|
| `contracts/hana-signer` (batch A, A.2) | `develop` | Deployed on sandbox-dev (`envs/sandbox-dev.json` `signer`); contract v2 since the governance migration, v3 since 2026-11-03, v4 since 2026-11-09 (the rows below) |
| `create_session_and_derive`, `key_index < 2^31` (batch B) | `develop` (merged 2026-10-29) | Deployed on sandbox-dev (contract upgraded 2026-10-29); ship gate passed (D76); gas measured in the sandbox with the mock MPC (`docs/contract-interface.md` "Gas of the email login calls"), not yet on testnet |
| `apps/api` batch A/A.2 endpoints, relayer, limits, cron | `develop` | Deployed on sandbox-dev (`apiUrl`) |
| `apps/api` `/v1/login` (incl. the export limit), login relay, origin rules, vault page, vault endpoints, migration 0003, vault cron, API-side policy validation (batch B) | `develop` | Deployed on sandbox-dev 2026-10-29 (migrations 0003 and 0004 applied, `VAULT_KEK` set) |
| Page Workers serving `vaultOrigin`/`authOrigin` (`apps/api/src/pages/`, `scripts/pages-wrangler.ts`) | `develop` | Deployed on sandbox-dev 2026-10-29 (both origins in `envs/sandbox-dev.json`) |
| `@hana-id/core` (layouts, CKD, derivation v1, signers, decoders, policies, verified contracts) | `develop` | In the deployed API and page Workers |
| `packages/env` `vaultOrigin`/`authOrigin`, `rpcFallback` | `develop` | In use (sandbox-dev's manifest sets all three) |
| `packages/env` `apiRpcFallbacks`, the API's RPC failover (`apps/api/src/near/rpc.ts`, D435) | `develop` (from `feat/api-near-rpc-fallback`) | Live on sandbox-dev (its manifest sets it: `rpc.testnet.near.org`, then `near-testnet.drpc.org`) |
| `@hana-id/web`: vault, auth pages `/login`, `/login/callback`, `/approve`, `/export`, partner client `createHana` (EIP-1193, Stellar, SWK module) | `develop` (packaging from `feat/sdk-packaging`) | Deployed in sandbox-dev's page Workers; built as installable tarballs (`pnpm run pack:check`, D71), not published (registry and licence open, D72) |
| `@hana-id/react` (`HanaProvider`, `useHana`, `useWallet`), `@hana-id/sodax` (Stellar and EVM wallet-provider adapters) | `develop` (packaging from `feat/sdk-packaging`) | Code done; tarballs as `@hana-id/web`, not published |
| `admin app:settings` | `develop` | Code done |
| `apps/smoke` | `develop` | `/` logs in through `@hana-id/web` (the vault); `/direct.html` keeps the split path for the ship gate, signing in with Google's implicit flow, `scope=openid` only (D271) |
| `apps/e2e` (Playwright: Chromium, WebKit, Firefox; local builds against the real API Worker; CI job: Chromium on each push, WebKit and Firefox nightly, D383; CI disabled since 2026-11-05, D387) | `develop` | Code done |
| Developer dashboard, admin console, billing-grade usage (batch C; `docs/batch-c-spec.md`, `docs/batch-c-build-plan.md`) | `develop`: C1–C15 | C1 (manifest fields, the Neon ledger schema, `console-core`), C2 (`packages/oidc`), C3 (migration 0006, the gate on `app_keys` and `scopes`, the CLI on it), C4 (usage capture, `session_markers`) and C5 (below) merged. **Running on sandbox-dev** (2026-11-03): migrations 0006, 0009 and 0010 applied (after a rehearsal on a scratch D1; a Time Travel bookmark from before 0006 and an export backup are kept in `.secrets`), the API has the hot DB on (milestone M1, `docs/operations.md` "Hot DB migration 0006 and the new gate"). Since then C6–C15 are merged, with C8b; the console, console-auth, files and admin Workers run on sandbox-dev since M4 (2026-11-06), usage capture on (`docs/operations.md` "What sandbox-dev runs"). C16 (CLI completion) is deferred; C17 and what is left for production: `docs/mainnet-readiness.md` row 7.3 |
| Batch C5: the API's `ConsoleRpc` and `AdminRpc` entrypoints (CAS writes on `app_changes`, keys, settings, staff proposals, notice ack, cancel, expedite, the breaker and hot-DB budget) and drift detection | `develop` (from `feat/batch-c-5`) | Merged and in the sandbox-dev API; the console (C7) and admin (C8) Workers bind them there since M4 |
| Batch C6: member proposals (`ConsoleRpc.changeOrigins` / `proposeChange`, the API's own step-up check), `ConsoleRpc.ownerAction`, the owner-action precheck's nonce recompute, the safety budget and `owner_cap` events, the owner-pool allowance alert, the console sink scope in `deploy-contract` | `develop` (from `feat/batch-c-6-merge`) | Merged; in the sandbox-dev API, and the sink plan run there 2026-11-06 (sink `s3`, D416; milestone M3) |
| The wallet directory (D310–D317): the vault's signed wallet record after each login, `POST /v1/wallets/record`, hot-DB migration 0011 (`end_users`, `end_user_wallets`, `end_user_identities`), identities kept current after `/v1/login` and the link relays, `AdminRpc` / `ConsoleRpc` user reads, `admin user:*` with wallets | `develop` (from `feat/wallet-directory`; D346's ids and the record's session signature from `feat/user-id-identity-sub`) | Merged; in the sandbox-dev API and vault, 0011 applied there. Needs `USER_ID_KEY` (usage setup step 4) and `IDENTITY_SUB_KEY` (already set where identity tokens are) on the API. No UI: the staff Users screen is C8b (D275), the partner's C10 |
| Batch C7: the console Worker backend (`apps/console`: host dispatch, the security headers and CSRF, the two emailed-link confirms over the `API` → `ConsoleRpc` binding, `StaffRpc` for the admin Worker, invites and owner grants with acceptance's data path, the session model, the hourly cron; `CONSOLE_DB` migration 0002) | `develop` (from `feat/batch-c-7`) | Merged; on sandbox-dev since M4 (`hana-id-console-sandbox-dev`; the manifest's dashboard blocks and the setup in `docs/operations.md` "Partner console Worker"). C9 (below) turns the route on in the config; the admin Worker (C8, below) binds `StaffRpc` |
| Batch C8: the admin Worker (`apps/admin`: the Access JWT check on every `/api/*` with the staff list, host dispatch and the headers, the staff BFF and a plain SPA over `AdminRpc` and `StaffRpc`, `EmailSender` with Resend (SendGrid since D401), the blocking notices acked only after every send, the feed with cursors in `ops.state`, the on-chain watcher; `gen-wrangler` with the admin Hyperdrive binding) | `develop` (from `feat/batch-c-8`) | Merged; on sandbox-dev since M4 (`hana-id-admin-sandbox-dev`; milestone M4: Access, the admin's SendGrid key (D401), the link and email secrets, the admin Hyperdrive id; `docs/operations.md` "Admin Worker"). D278–D285 |
| Batch C8b: the admin console's Users screen (D275, confirmed 2026-11-05): the email issuer's `DirectoryRpc` (`apps/email-issuer/src/directory-rpc.ts`: no route, the issuer's own check of the admin application's Access JWT, the audit row in the read's D1 batch, the per-staff row budget on its `RateLimiter`), issuer migration 0003, the admin's `ISSUER` binding and `POST /api/users/search`, `/find`, `/get` with the wallet directory and the chain joined, the issuer's rows in the audit view, `directory_budget`; `AdminRpc.appNames` | `develop` (from `feat/batch-c-8b`) | Merged; on sandbox-dev (the issuer's `DirectoryRpc` live with the admin Worker since M4; `docs/operations.md` "Users screen (C8b)"). D388–D392 |
| Batch C9: partner sign-in (the Google code flow with PKCE on console-auth, handoff codes, `__Host-` sessions, the membership rules and invite acceptance, `GET /api/me`, the read-only screens and SPA, the console route in the config) and the open-question-1 spike | `develop` (from `feat/batch-c-9`) | Merged; on sandbox-dev since M4 with console-auth (setup steps 5, 11, 12; `docs/operations.md` "Partner console Worker"); the spike: D295. Write paths: C10, merged |
| Batch C14: "Security & monitoring", the pending-upgrades page and the playbooks in the admin (`apps/admin/src/{watchdog,monitoring,monitoring-registry,playbooks,plain}.ts`, the SPA's `/security/monitoring`, `/security/upgrades`, `/security/playbooks`), `AdminRpc.governance` / `pendingUpgrades` and `ConsoleRpc.pendingUpgrades` over the `GET /v1/governance` snapshot, the release registry (`console-core` `CONTRACT_RELEASES`), the partner console's backend route (routed by C10, `feat/batch-c-10`), `watchdog.url`; the feed's silent first run (D344) | `develop` (from `feat/batch-c-14`) | Merged; on sandbox-dev with the admin Worker since M4 (`watchdog.url` set there, the `WATCHDOG_STATUS_TOKEN` admin secret; `docs/operations.md` "Admin Worker" → "Security & monitoring"). D330–D338 |
| Batch C11: the files Worker (`apps/files`: only `GET /logos/<app>/<sha256>.png` from R2, re-checked, sandboxed), the console's logo upload backend (`apps/console/src/logo.ts`: magic bytes, container and polyglot checks, the Images re-encode to a 256 × 256 PNG without metadata, `logo_objects`, `ConsoleRpc.setLogo`; routed behind the session by C10, `feat/batch-c-10`), `GET /v1/app` `logoUrl`, the logo beside the app's name on `/login`, `/login/email`, `/approve`, `/export` with `FILES_ORIGIN` in their `img-src` (D300–D308) | `develop` (from `feat/batch-c-11`) | Merged; the files Worker and its R2 buckets are on sandbox-dev since M4 (`hana-id-files-sandbox-dev`; `docs/operations.md` "Files Worker and logos"). Inert until a logo exists: an app without a logo gets exactly batch B's messages and policies |
| Governance contract (delayed issuer keys, watchdogs, pause, timelocked upgrades, DAO owner) | `develop` (from `feat/governance`) | Deployed on sandbox-dev 2026-10-30: migrated in place to v2 (same signer, same addresses), owned by the council DAO since 2026-10-30, one upgrade through the DAO (contract 0.1.1) (`docs/operations.md` "Governance migration (sandbox-dev)") |
| `apps/watchdog` (independent watchdog Worker, alerts, status endpoint for the admin portal) | `develop` (from `feat/governance`) | Deployed on sandbox-dev 2026-10-30 (forged-key and pause drills), redeployed 2026-11-02 with batch 5 (below); its pager (ntfy.sh) and heartbeat are set, Slack and email aren't (`docs/operations.md` "Watchdog service") |
| Governance API (delayed JWKS sync, `issuer_key_pending` / `paused` gate, `GET /v1/governance`) | `develop` (from `feat/governance`) | Deployed on sandbox-dev with the migration, 2026-10-30 (D1 migration 0005; `docs/operations.md` "Deploying the governance API") |
| Governance scripts (owner council, DAO-routed owner calls, timelocked upgrades, migration, `admin governance:status`) | `develop` (from `feat/governance`) | In use on sandbox-dev (`docs/operations.md` "Governance") |
| Partner identity token, build steps 1–4 (`docs/identity-token-spec.md`, D127): core layouts and ids, `POST /v1/identity/token`, JWKS and discovery, Worker-secret ES256 signer, migration 0008, `hana.getIdentityToken()`, `useIdentityToken()`, `scripts/identity-key.ts`, `examples/identity-verify` | `develop` (from `feat/identity-token-1`, `feat/identity-token-2`) | Deployed on sandbox-dev 2026-11-02 (active kid `17xAVaTf…`, standby offline; migration 0008; `docs/operations.md` "Identity token keys"). No `email` claim yet (steps 5–6); the watchdog pin check (step 8) is merged and deployed (below) |
| Identity token step 7, code only: the AWS KMS signer (`apps/api/src/identity/kms.ts`, selected by `IDENTITY_SIGNER`), the manifest's `aws-kms` signer, `identity-key kms-*` (D215–D219) | `develop` (from `feat/identity-token-7`) | Merged; tested against a fake KMS; no env uses it. The AWS account, keys, IAM, CloudTrail reconciliation and alarms are still to set up (`docs/operations.md` "Identity token keys on AWS KMS") |
| Partner identity token, build step 8: the watchdog's identity JWKS and discovery check against `watchdog.pinnedIdentityKeys` and `identityToken.iss` (critical, no pause), an outside probe from GitHub Actions with the same rules (`@hana-id/jwks/identity`), an identity key's thumbprint as an issuer kid on chain (critical), `identity-key` writing the pins, thumbprint pinning in the example verifier (D210–D214) | `develop` (from `feat/identity-token-8`) | Merged; the watchdog's identity checks deployed on sandbox-dev 2026-11-02 (version 67fe97cb; sandbox-dev's manifest pins its two keys); the probe runs once the workflow is on the default branch. Detection against an attacker who serves everyone the same JWKS, not prevention |
| Email login, contract v3 (self-issued email issuer with a signer policy, JWS JSON tokens, accounts and links, the hourly link counter (D200), `migrate` v2 → v3; `migrate_v1` removed) | `develop` (from `feat/email-login-1`, `feat/email-login-2`, `feat/link-cap`) | Code done, unit- and sandbox-tested (email login, links, the v2 → v3 upgrade through the DAO from sandbox-dev's v2 code, gas in `docs/contract-interface.md`); **deployed on sandbox-dev** (2026-11-03): `hana-id-signer-dev1.testnet` runs contract v3 (state_version 3), upgraded through the council DAO with a delayed execute; `get_config().unrecorded_wallets` is false (`accept_unrecorded_wallets`). The off-chain parts that call it (issuer, API, web) are the rows below |
| `@hana-id/email` (email normalization v1, the `e1.` `sub`, the Google-hosted rule, the pinned disposable-domain list; build-plan batch 3) | `develop` (from `feat/email-login-3`) | Code done, frozen vectors; imported by the email issuer |
| `apps/email-issuer` (build-plan batch 4: `start`/`resend`/`verify`/`google-match`, JWKS and discovery, staff client proofs, unlock and unsuppress, owner device tickets, the `Challenge` and `RateLimiter` objects, its D1, SendGrid and outbox senders, the Worker-secret signer and an unwired KMS adapter), manifest `emailIssuer`, `scripts/email-issuer.ts` | `develop` (from `feat/email-login-4`) | Code done and tested (miniflare, fake KMS, fake Google and chain); deployed on sandbox-dev 2026-11-03 (the next row). Batch 6: reached at its own URL (`emailIssuer.url`, D230), finds apps by `app_keys` (D233) |
| Email login, watchdog (batch 5): email pins and signer policy, the link alarms from `get_link_stats()` (D200), `unrecorded_wallets` (D190–D193) | `develop` (from `feat/email-login-5`) | Deployed on sandbox-dev 2026-11-02 (version b156e1b5, no new migration), while the contract was still v2. The manifest now has the email pins (`watchdog.pinnedIssuerKeys.email`: the issuer's active and standby kids): redeployed with the manifest's email pins 2026-11-03 (version fd6d8b27) |
| Email login, the email issuer (batch 4: `apps/email-issuer`, login codes by mail through SendGrid, D194) | `develop` (from `feat/email-login-4`) | Deployed on sandbox-dev 2026-11-03 with batch 8b (`hana-id-email-issuer-sandbox-dev.tingtc.workers.dev`), redeployed 2026-11-04 with the user directory and google-record (version b0cb9058, migration 0002 applied; again 2026-11-04 with the dev-env limits, D340, version fa18b944): its 5 secrets set, SendGrid sending from team@hanawallet.io for testnet. Its keys are on chain: active kid `v_H0YgrYDKczje-jsOa1eEdEWy9BECqRRCSp98pztsw`, standby `ziQVLEH8…` |
| Email login in the web, plain (batch 8a): the popup's method chooser and `/login/email` (address, code, resend, a different email, case B continues with Google, the device ticket on `authOrigin`), the vault's email-token check against the chain (`get_issuer_keys` / `get_self_issued("email")`, `scope_for_client("email", …)`), the `{scope}#email#{sub}#0` path and record check, `hana.login({method, emailHint})`, `loginProgress: email_code`, the new error codes; no linking | `develop` (from `feat/email-login-8a`) | Merged; live on sandbox-dev for the demo app (`hana-id-demo-sandbox-dev.tingtc.workers.dev`, the Smoke B app in scope `s2`, `login_methods` google,email; scope `s2`'s email client added with `admin scope:add-email-client`, D253) |
| Email login in the web, linking (batches 7 and 8b): the path through `get_identity` (vault, export window), google-match before any chain call with Google's access token (since 2026-11-04 from `'token_first'`'s first request, D270; before that the second, silent `email` request, D254), the four cases' screens in the popup (the follow-up channel, D256), the vault's D133 checks before the linked CKD payload and D137's revoke-and-restart, case B only after the popup's email step (D139), link banners with Cancel and Remove, `hana.account()`, `linkChanged`, `hana.linkAccount()`, key export for email wallets (D246 lifted, D258); the issuer's case-B `verify` answers the address's `sub`; the API accepts the vault's relay writes and puts the issuer in the vault page's CSP | `develop` (from `feat/email-login-8b`) | Merged and live on sandbox-dev since 2026-11-03 (API version b215b589; page Workers deployed, auth version 548ec940, the vault's CSP listing both RPCs, fastnear and rpc.testnet.near.org, and the issuer; the demo). Tested in unit and Playwright (three browsers, `outbox` stub); steps: `docs/operations.md` "Turning linking on (batch 8b)" |
| Email login, API (batch 6): email tokens on `/v1/sessions` and `/v1/login` (`apps/api/src/email-token.ts`), the `create_session` proof of possession (D137) in the API, the vault's split path and the smoke page, `/v1/login`'s `linkJwt` precheck (D133), the link relays `/v1/link*` with share revocation, the email-login panics as errors, `GET /v1/app` `loginMethods`, D155's gas, migration 0010 (`apps.login_methods`, `email_usage`), the issuer on its own URL (D230) and its `app_keys` lookup (D233) | `develop` (from `feat/email-login-6`) | Merged; deployed on sandbox-dev 2026-11-03 with batch 8b (API version b215b589, hot DB on, `createProof` true, relayer keys rotated; migration 0010 applied; steps: `docs/operations.md` "Email login on sandbox-dev"). Apps stay Google-only (`login_methods` `'google'`) except the demo's Smoke B app in scope `s2` (google,email) |

## Components

| Component | Code | Runs on | Role |
|---|---|---|---|
| Partner page | partner's own | partner origin | Embeds the SDK; never sees keys or tokens |
| `@hana-id/web` client | `packages/web/src/client` | partner origin | Mounts the vault iframe, opens the login popup and (in the click, D99) the approval popup, exposes EIP-1193, Stellar signer, raw signer, SWK module |
| `@hana-id/react`, `@hana-id/sodax` | `packages/react`, `packages/sodax` | partner origin | `HanaProvider`/`useHana`/`useWallet`/`useIdentityToken`; Sodax `IStellarWalletProvider`/`IEvmWalletProvider` adapters |
| Partner backend | partner's own (guide: `examples/identity-verify`) | partner servers | Verifies identity tokens against the API's JWKS with any JOSE library; never calls Hana |
| Vault | `packages/web/src/vault`; page HTML `apps/api/src/vault/page.ts` | hidden iframe on `vaultOrigin` | Holds the session key and PRK, computes nonces and paths, signs |
| Auth pages | `packages/web/src/auth` | popups / top-level windows on `authOrigin` | Login (the method chooser, Google, `/login/email`'s code step against the email issuer), approval, consent, key export |
| `@hana-id/core` | `packages/core` | everywhere (no DOM) | Layouts, CKD, derivation v1, signers, approval decoders, policy validator/matcher, ID-token check, message schemas |
| API Worker | `apps/api/src/index.ts` | Cloudflare Workers (`apiUrl`) | Gate (key, origin, limits), verify-before-relay, relayer, vault shares, login relay, vault page HTML, crons; the identity token issuer (`src/identity/`: mint, JWKS, discovery; the signer behind `IdentitySigner`: a Worker-secret P-256 key on testnet, AWS KMS `Sign` on staging and mainnet, picked by `IDENTITY_SIGNER`); the `ConsoleRpc` and `AdminRpc` entrypoints (`src/rpc/`, `src/changes/`: the only writers of app config besides the CLI, no route); the email issuer's read-only `IssuerRpc` (`src/rpc/issuer.ts`, `src/issuer-apps.ts`: three app lookups, no route, D434); the wallet directory (`src/directory/`: the vault's wallet records, identities from its own chain reads, the RPC user reads; branch `feat/wallet-directory`) |
| Console Worker | `apps/console/src/index.ts` (`staff-rpc.ts`, `invites.ts`, `members.ts`, `grants.ts`, `cron.ts`; C9: `auth-flow.ts`, `auth-token.ts`, `auth-google.ts`, `auth-handler.ts`, `sign-in.ts`, `bff.ts`) | Cloudflare Workers (`console.origin`; the route on in the config from C9; on sandbox-dev since M4) | Runs first on every request (assets with `run_worker_first`): its own origin only, the console's CSP and headers on every response, CSRF on every non-GET; partner sign-in (C9: `/api/auth/*`, and the `AuthHandler` entrypoint for the auth origin's `/start` and `/callback`), `GET /api/me` and the read-only org views over `ConsoleRpc`; the emailed-link confirms (`POST /api/cancel` through the `API` → `ConsoleRpc` binding, `POST /api/owner-grants/cancel`); the `StaffRpc` entrypoint for the admin Worker (orgs, members, invites, owner grants, the audit feed); the hourly cron (invite expiry, matured owner grants, housekeeping purges, replaced logos) |
| Partner console SPA | `apps/console/web/` (React 18.3.1, React Router 6, Vite; built to `apps/console/dist`) | The console Worker's assets | Sign-in, invite and cancel pages; a sidebar frame; the org's apps; an app's overview (IDs, key, getting-started checklist) and sections (origins, keys, login and sessions, signing, branding, suspend) with the guarded changes; the fresh sign-in page; members and invites; the scope; users, usage, statements, pending upgrades and the audit (D297, D421). A dev-only preview with fake answers is `apps/console/preview` (never built or deployed) |
| console-auth Worker | `apps/console-auth/src/index.ts` | Cloudflare Workers (`console.authOrigin`, C9) | Forwards `GET /start` and `GET /callback` unchanged to the console's `AuthHandler` (service binding `CONSOLE`); everything else 404; no secret, D1 or Hyperdrive; the auth origin's no-script CSP and `no-store` on every answer |
| D1 `CONSOLE_DB` | `apps/console/migrations/` | Cloudflare D1, bound only by the console Worker | Orgs (`org_legacy` too), console users (Google `sub`, email for display), members, invites (sha256 of the link token, set only after the admin Worker's notice), owner grants, console sessions (sha256 of the cookie), auth flows, handoff codes, pending step-up actions, logo objects, the append-only `audit_log` (one row per request and action) |
| Admin Worker | `apps/admin/src/index.ts` (`access.ts`, `routes.ts`, `notices.ts`, `feed.ts`, `watcher.ts`, `email/`; SPA in `public/`) | Cloudflare Workers (`admin.origin` behind Cloudflare Access; on sandbox-dev since M4) | Runs first on every request: its own origin only, the admin CSP and headers; every `/api/*` needs a valid Access JWT of a listed staff email, then CSRF; the staff BFF over `API` → `AdminRpc` and `CONSOLE` → `StaffRpc` with the staff member as the actor; the 5-minute cron: blocking notices (`change_pending`, `member_invite`, `owner_grant`) acked only after every send is accepted, the security feed (cursors in Neon `ops.state` through `USAGE_DB`, role `usage_admin`), the on-chain watcher (`get_scope`, `ops.scope_snapshot`, `ops.scope_watch`); email only through SendGrid (`@hana-id/sendgrid`, its own Mail-Send-only key `EMAIL_API_KEY`, accepted only on `202`; no provider idempotency, so a per-isolate memo skips a message already accepted and a repeat is possible, a skip never; D401). From C14 (`feat/batch-c-14`): "Security & monitoring" over the watchdog's status endpoint (bearer server-side) and `AdminRpc.governance`, the pending-upgrades page, the playbooks bundled from `@hana-id/playbooks`. From C13 (`feat/batch-c-13`): the monthly retention job in the 15-minute trigger (`retention.ts`: the Neon functions, `AdminRpc.deletedApps` / `purgeDirectory` / `purgeAudit`, `StaffRpc.purgeAudit`), `retention_failed`, the Retention screen. The partner invite's HTML part is the shared designed layout (`@hana-id/brand/email`, D672); its other mails keep plain HTML (D674). No D1, no NEAR key |
| Files Worker | `apps/files/src/index.ts` (batch C11) | Cloudflare Workers (`files.origin`, D66) | Serves only `GET`/`HEAD /logos/<app id>/<sha256>.png` from the `LOGOS` R2 bucket, each object re-checked (PNG type and signature, ≤ 128 KiB, the sha256 its key names) with a `sandbox` CSP, `nosniff` and cross-origin CORP; reads only (`get`), no secret, D1 or cookie. The console writes the bucket: uploads re-encoded through the Images binding, replaced logos deleted by its hourly cron 30 days on Also serves the designed mails' logo, `/brand/hana-mail-logo-<hash>.png`, from bytes built into the Worker, with no log line and its invocation logs off (D685) |
| Page Workers | `apps/api/src/pages/` (`vault-worker.ts`, `auth-worker.ts`, `host.ts`) | one Cloudflare Worker per Hana origin (D66) | `vaultOrigin`: forwards `GET /vault` to the API Worker (service binding `API`), serves the vault bundle; `authOrigin`: the four auth pages with their CSP, and their assets. Nothing else; never a cookie (D70) |
| `RelayerKey` DO | `apps/api/src/relayer-key.ts` | one object per relayer access key | Serialises that key's nonces, signs and broadcasts |
| `RateLimiter` DO | `apps/api/src/rate-limiter.ts` | one object per subject (`ip:…`, `app:…`, `export:…`, `owner-actions:…`, `identity:global`, `identity-proof:<sessionPk>`) | Fixed-window counters, global and exact; owner-token and identity-proof single-use markers |
| Rate Limiting bindings | `apps/api/src/vault/limits.ts` (`VAULT_IP_LIMIT`, `VAULT_SHARE_LIMIT`, `VAULT_STATUS_IP_LIMIT`, `VAULT_STATUS_SHARE_LIMIT`), `apps/api/src/identity/limits.ts` (`IDENTITY_SESSION_LIMIT`) | each Cloudflare location, no network hop | The vault's per-IP and per-share, the share-status read's per-IP and per-share (D690) and the identity token's per-session flood limits, approximate (D95) |
| Email issuer Worker | `apps/email-issuer/src/index.ts` (`handlers.ts`) | Cloudflare Workers, its own Worker on Hana's main account, at `{emailIssuer.url}/v1/email/*`: its own `workers.dev` URL on sandbox-dev, the API's URL by a zone route in production, never through the API Worker (D230; deployed on sandbox-dev 2026-11-03, version d3dc7965) | Email codes (`start`, `resend`, `verify`), email tokens (JWS General JSON, RS256, nonces computed per purpose), `google-match` (automatic linking's four cases), JWKS and discovery, staff routes behind Access (client proofs, unlock and unsuppress, which mail the address, ticket revocation) and the mailed confirmation (`confirm`). Alone holds ISSUER_SIGNING_KEY, K_sub, K_code, K_rl and the SendGrid key, and keeps the user directory (each identity's verified address, for Hana staff, D269) in its own D1; reads the chain and, through the API's read-only `IssuerRpc` (service binding `API`, D434; no binding to the API's D1), its apps; writes neither. Its mails are text plus a designed HTML part from `@hana-id/brand/email` (D670): no link in a code mail, and one image, the logo served by the files Worker (D685) |
| `Challenge` DO (`EMAIL_CHALLENGE`) | `apps/email-issuer/src/challenge.ts` | one object per challenge or link ticket | The code's HMAC, attempts, purpose and nonce, the address encrypted under the challengeId's client-held half (≤ 10 min, for resends); named by a hash of the id's public half; single use |
| Issuer `RateLimiter` DO | `apps/email-issuer/src/rate-limiter.ts` | one object per mailbox, recipient domain, IP subject or prefix, app, `global`, staff member | Exact limits; per mailbox: code mails per requester and overall, the device ticket's allowance, live challenges, wrong-code locks and the 18 + 4 + 3 ceiling, unlock grants and staff caps, each decision one atomic call; in `global` the budget's per-app shares (D198) |
| `LoginRelay` DO | `apps/api/src/login-relay.ts` | one object per `relayId` | Write-once, read-once slot for the encrypted Google token, 120 s |
| D1 `DB` | `apps/api/migrations/` | Cloudflare D1 | Scopes (one org and environment each), apps, publishable keys, origins (in force from `active_from`), plans, settings, guarded changes and the `app_changes` ledger, session markers, vault shares, the server's record of auto-approve consents (`vault_consents`), identity token counts; the legacy `usage` counters (no longer written, batch C4) |
| Usage ledger | `apps/api/migrations-usage/`, `apps/api/src/usage/` | Neon Postgres (`aws-ap-southeast-2`, D73) through the optional Hyperdrive binding `USAGE_DB` (role `usage_writer`, which may only call `usage.record_event`, `usage.record_identity_tokens`, `usage.record_email_counts` and `usage.ensure_partitions`) | One UsageEvent v1 per request past the gate, written after the response with one retry, fail open (a lost event is logged, never blocks or slows a request); the hourly copy of identity token counts per app and day (D220–D224) and of email login counts (`email_usage`, D233). Batch C12 (built, not merged): the owner's report, ledger and statement functions (`0006_reports.sql`), which the writer may also call for `ConsoleRpc.usage` / `statements` / `ledger`; the admin Worker (role `usage_admin`) settles each relayed event's gas at FINAL only for its own transaction (D321), checks the relayer nonces and the rejection rate daily, fetches the NEAR/USD rate and issues the frozen monthly statements (CSV, PDF, on-screen; D320–D329). Batch C13 (built, not merged): the retention functions (`0007_retention.sql`), which only the admin role may call, and the monthly job that applies D90 (D360) |
| `hana-signer` | `contracts/hana-signer` | NEAR testnet, manifest `signer` | Issuers (Google RSA keys), scope registry, sessions, calls the MPC |
| NEAR MPC | external, manifest `mpc` | NEAR testnet MPC network | CKD (`request_app_private_key`, domain `ckdDomainId` = 2) |
| Google OIDC | external | `accounts.google.com`, `www.googleapis.com` | Issues ID tokens whose `nonce` commits to the session |
| `packages/email` | `packages/email/src/` | email issuer (batch 4); Workers and browsers (Web Crypto, no Node API) | Email normalization v1 (UTS #46 via pinned `tr46`, characters newer than Unicode 15.0 refused, Gmail canonical form), `sub = "e1." ‖ b64url(HMAC-SHA256(K_sub, …))` with `K_sub` as an input, the Google-hosted rule, the pinned disposable-domain list; frozen at the address freeze by `vectors/email-v1.json`, tested in Node and workerd (D156–D159) |
| Watchdog Worker | `apps/watchdog/src/index.ts` | Cloudflare Workers on **its own account** (manifest `watchdog.cloudflare`, D86) | Every 5 min: Google's JWKS against the contract's pending and active issuer keys; cancels forged pending keys, deletes the updater keys that proposed one, pauses on a forged active key, confirms matches (D82); the email issuer's pending and active keys and signer policy against the manifest's pins (`watchdog.pinnedIssuerKeys.email`: cancels unpinned pending keys, pauses on an unpinned active key or a weaker policy, never confirms one, D190, D191), the contract's hourly link counts from `get_link_stats()` (an alarm threshold reached critical, half the total threshold a warning, a raise a critical governance change; alarms only, nothing is refused; D200); Hana's email JWKS against the pins (warning) and the partner identity token's JWKS and discovery document against `watchdog.pinnedIdentityKeys` and `identityToken.iss` (critical, never a pause, D210), read after the run is recorded and its lock released, guarded and size-capped; an identity key's thumbprint as an issuer kid on chain (critical, D212); `unrecorded_wallets` outside dev envs (critical, D193); alerts on governance changes and on the relayer's balance and pool-key allowances (read-only, D150); pages, Slack, email (D85); dead-man's switch; read-only `GET /status`, `/alerts`, `/actions` and `POST /alerts/:id/ack` for the admin portal (D83) |
| Watchdog D1 | `apps/watchdog/migrations/` | Cloudflare D1 on the watchdog's account | Seen kids, absences, runs and their checks, actions log, alerts, deliveries, acks |
| `packages/jwks` | `packages/jwks/src/index.ts` | API, watchdog, `packages/oidc` | JWKS parsing (`usableJwks`), RSA key comparison, RFC 7638 RSA thumbprints (`rsaThumbprint`, the watchdog's email pins) |
| `packages/oidc` | `packages/oidc/src/` | API (console and admin Workers in batch C); Workers (Web Crypto, no Node API) | Google ID-token checks moved out of the API: `verifyIdToken` (RS256, known `iss`, known `kid`, a finite `exp`, single-string `aud`; the identity-token refusal; the optional `email`, `email_verified`, `iat`, `hd`, `azp`, `amr`, `auth_time` returned when well typed, a wrong type dropped by default or refused with `optionalClaims: 'strict'`, the console's mode; the API ignores them), the isolate's Google JWKS cache (max-age 5 min..6 h, unknown-kid refetch ≤ 1/min, 10 s failure backoff, ≤ 6 h stale on fetch failure, 8 s timeout, 64 KiB cap) and `publishedKeys`; `AccessJwtVerifier` for the admin Worker's Cloudflare Access JWT (`type`, `iss`, `aud`, `exp`/`nbf`, non-empty `sub` and `email`; certs ≤ 10 min old, never stale; one per isolate); tested in Node and workerd (D201–D203) |
| `packages/playbooks` | `packages/playbooks/src/` | watchdog (playbook ids), admin portal (batch C), `docs/playbooks.md` | Recovery playbooks for every watchdog alert kind and incident (D126); the watchdog serves each alert kind's playbook id in `GET /status` and names it in every alert text |
| Scripts | `scripts/`, `apps/api/scripts/gen-wrangler.ts`, `apps/watchdog/scripts/` | operator's machine | Deploy contract and keys, JWKS one-off sync, CKD key fetch, `VAULT_KEK` init/rotate, admin CLI, watchdog config and secrets |

```
  partner origin                                   Google OIDC (accounts.google.com)
 ┌──────────────────────────────────┐                ▲ authorize      │ id_token in #fragment
 │ partner page + @hana-id/web      │                │ (scope=openid) ▼
 │   │ MessageChannel port          │   window.open ┌────────────────────────────────┐
 │   ▼                              │ ─────────────▶│ authOrigin: /login             │
 │ ┌──────────────────────────────┐ │  postMessage  │  /login/callback /approve      │
 │ │ vault iframe (vaultOrigin)   │◀┼──────────────▶│  /export                       │
 │ │ session key, PRK, signing    │ │ (origin+source└───────────────┬────────────────┘
 │ └──────┬──────────────┬────────┘ │  checked)                     │ POST /v1/login-relay (ciphertext)
 └────────┼──────────────┼──────────┘                               │ GET /v1/app
          │ HTTPS        │ get_session, tx status (NEAR RPC)        │
          │              │ Google JWKS (googleapis.com)             │
          ▼              ▼                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ API Worker (apiUrl; also renders GET {vaultOrigin}/vault)                   │
 │  /v1/app /v1/login /v1/login-relay/:id /v1/vault/* /v1/sessions /v1/derive  │
 │  /v1/sessions/revoke /v1/owner-actions /v1/health        cron: 15 min       │
 │  DOs: RelayerKey (per key) · RateLimiter (per subject) · LoginRelay (per id)│
 │  D1: apps, app_origins, plans, vault_shares, issuer_key_missing, …          │
 │  USAGE_DB (Hyperdrive → Neon): usage events, after the response (optional)  │
 └──────────────┬──────────────────────────────────────────────────────────────┘
                │ signed function calls (relayer account keys) + views (NEAR RPC)
                ▼
 ┌──────────────────────────────┐  request_app_private_key   ┌───────────────────┐
 │ hana-signer (signer account) │ ─────────────────────────▶ │ NEAR MPC, CKD     │
 │ issuers · registry · sessions│ ◀─── {big_y, big_c} ────── │ domain 2          │
 └──────────────────────────────┘                            └───────────────────┘
```

Who talks to whom:

| From → to | Channel | What |
|---|---|---|
| Partner client → vault | `postMessage` hello, then a `MessageChannel` port (`packages/web/src/client/vault-connection.ts`) | Port methods (`hana_login`, `eth_signTransaction`, …) and events. Never key material. The vault says `connected` on the port once it has taken the hello (before storage and the unlock call), then `ready`; the SDK gives each frame 5 s to answer (5 s more while it is still loading), and a frame that has loaded 1.5 s after its `load` (the vault answers the hello in the same task, D427); a loaded frame that doesn't answer is replaced once; then it gives `ready` 20 s after `connected`, and on a failure removes the frame and reports `vault_unavailable` with `data.reason` (D262; `no_answer` also names the page's own origin in `data.origin`, D427) |
| Vault ↔ auth popups | `postMessage`, checked by `event.origin` and `event.source` (a popup the partner page opened reaches the vault as `opener.frames[v]`) | `hana:auth-params` (incl. `relayKey`, and `followKey` in a login that offers email), approval requests/results and `hana:approve-close`, export context |
| Partner client → approval popup | `window.open` only (it holds the WindowProxy; the popup takes no message from it) | — |
| Auth popup → Google | top-level navigation | Implicit flow. In an env with an email issuer (`'token_first'`, D270, in force): `response_type=token`, `scope=openid email`, `prompt=select_account` first, then a silent `response_type=id_token`, `scope=openid`, `prompt=none`, `login_hint=<sub>` (once more without `prompt=none` on a silent failure, D273; "Automatic linking" step 2). Otherwise (no issuer, a link task, a proof, the export window): `response_type=id_token`, `scope=openid`, `prompt=select_account` (or `login_hint` for a proof). Under the fallback `'second_request'` (D254): the openid login, then a silent `response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>` in a login that offers email |
| `/login/callback` → Google tokeninfo | `fetch` `POST https://oauth2.googleapis.com/tokeninfo` (form body, no cookies; its CSP `connect-src` lists it in an env with an email issuer, in both the Worker's header and the built `<meta>` policy) | Under `'token_first'` (in force): the access token, for its client and `sub` (the login hint) |
| `/login/callback`, `/login/email` → API | `POST /v1/login-relay/:relayId` (`Origin: authOrigin`) | AES-GCM ciphertext of the token; in a login that offers email also the access token and the answers to the vault's follow-up notices (follow-up slots) |
| Vault → API | `fetch`, `Origin: vaultOrigin`, `x-hana-key`, `x-hana-parent-origin` | `/v1/app`, relay read and (follow-up notices, batch 8b) relay write, `/v1/login`, `/v1/sessions/revoke`, `/v1/link*`, `/v1/vault/*`, `/v1/wallets/record` (after each login, in the background: "Wallet directory") |
| Vault → email issuer | `fetch`, `Origin: vaultOrigin`, no cookies | `POST /v1/email/google-match` (Google's ID and access tokens, the session commitment; batch 8b); under `'token_first'` in an app without email login `POST /v1/email/google-record` (the same tokens and commitment; the user directory only, D269) |
| Vault → NEAR RPC | JSON-RPC (manifest `rpc`; `rpcFallback` only when `rpc` errors or times out, one endpoint per answer: `packages/web/src/near-call.ts`; and both read separately to confirm any path that isn't the signed-in identity's own: `packages/web/src/path-check.ts`, D263) | `get_session` re-sync, the login's registry check (`scope_for_client`, or `get_scope` and `get_config`), `get_identity` (the path, batch 7), `get_account` and `get_config().unrecorded_wallets` (links), the email keys and policy, `EXPERIMENTAL_tx_status` polling; the export window the same |
| Vault, export window → Google | `https://www.googleapis.com/oauth2/v3/certs` | JWKS for the defence-in-depth RS256 check |
| Partner page → API | `fetch` from the partner origin | `GET /v1/app` (any key); `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only for test-scope apps in dev envs (`apps/smoke`) |
| API → NEAR | NEAR RPC: `rpc`, then `apiRpcFallbacks` in order (else `rpcFallback`), moving on only when an endpoint gives no JSON-RPC answer (network, timeout, 5xx, 429, not JSON-RPC, not synced), never for an answer; one request's calls stay on the endpoint that answered last; a failed-over `send_tx` resends the same signed bytes and is then polled by hash, never re-signed (`apps/api/src/near/rpc.ts`, D435) | Views (`get_config`, `get_scope`, `scope_for_client`, `get_session`, `session_key_in_use`, `get_issuer`; for the cron and `GET /v1/governance` also `get_key_changes`, `get_governance`, `view_access_key_list`), `send_tx`, `tx` |
| `hana-signer` → MPC | cross-contract call, 20 Tgas, 1 yocto | `request_app_private_key {derivation_path, app_public_key, domain_id}` |
| API cron → Google, `hana-signer` | HTTPS, then `set_issuer_key` / `propose_issuer_key_removal` / `execute_issuer_key_change` signed with `KEYS_UPDATER_KEY` (delayed key changes, governance batch) | JWKS sync (`apps/api/src/issuer-keys.ts` `syncIssuerKeys`) |
| Watchdog → Google | `https://www.googleapis.com/oauth2/v3/certs`, `cache: no-store`, every 5 min (and once more 60 s later when a pending kid is missing) | Its own JWKS copy, never the API's |
| Watchdog → NEAR | its own RPC (manifest `rpc`, then `rpcFallback`): `status`, views `get_key_changes`, `get_issuer` and `get_issuer_keys` (`google`, `email`), `get_self_issued("email")` and `get_link_stats()` (absent on v2: read as no email issuer), `get_config`, `get_governance`, the owner's `view_account` and (a DAO) `get_policy`, the relayer's `view_account` and `view_access_key_list` (final; alert only, D150); `send_tx` from `WATCHDOG_KEY` on `watchdog.account` | `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key` only |
| Watchdog → Hana's email JWKS | `watchdog.pinnedIssuerKeys.email.jwksUrl` (default `{emailIssuer.url}/v1/email/jwks.json`, else under `apiUrl`), only with pins | Compared with the pins and the active email keys; warning only, never trusted |
| Watchdog → Hana's identity JWKS and discovery document | `{identityToken.iss}/jwks.json` and `/.well-known/openid-configuration`, `cache: no-store`, `redirect: manual`, 64 KB cap, every 5 min, only with `identityToken` in the manifest | Each key's RFC 7638 thumbprint against `watchdog.pinnedIdentityKeys`, public members only, private members, duplicate members, the shape, `issuer` and `jwks_uri`; critical alerts, never an action (D210, D213, D214) |
| Outside probe (GitHub Actions) → Hana's identity JWKS and discovery document | `.github/workflows/identity-probe.yml` every 3 hours (D383); **disabled in GitHub since 2026-11-05** (D387: testnet only; to move to AWS Lambda + EventBridge before mainnet), `scripts/identity-probe.ts`: jose's User-Agent, no redirect followed, 64 KB cap, every non-`local*` env with `identityToken` | The watchdog's rules (`@hana-id/jwks/identity`) from outside Cloudflare; a finding fails the run (GitHub's email). No secrets (D210) |
| Watchdog → paging app, Slack, SendGrid, heartbeat | HTTPS with its own credentials (`apps/watchdog/src/channels.ts`; email through `@hana-id/sendgrid` with its own key, D401) | Critical: page + Slack + email, re-sent every 15 min until acknowledged; warning: Slack + email; daily digest; dead-man's switch ping |
| Admin Worker (batch C8b) → email issuer | service binding `ISSUER` → the `DirectoryRpc` entrypoint (no route, no D1 binding): `search`, `get`, `auditSince`, each with the staff request's Access JWT, which the issuer verifies itself | The user directory's rows for the Users screen and the Support ID lookup's email join (`get` with `purpose: 'support_lookup'`, D399), and the issuer's staff audit; the issuer audits each read in the same D1 batch and keeps a per-staff row budget (D275, D388–D392) |
| Partner console Worker → email issuer (build plan batch 9) | service binding `ISSUER` → the `ConsoleIssuerRpc` entrypoint (no route): `clientProof`, `deliverability` (D447) | The AddClient proof for an owner action the console built (audited in the issuer's `email_admin_audit`, 20 per scope and day) and one app's mail counts; called only after `ConsoleRpc.getApp` confirmed the app is the org's |
| Email issuer → API | service binding `API` → the `IssuerRpc` entrypoint (no route; D434): `appByKey`, `appById`, `scopeHasEmailApp`, strict inputs, SELECTs only on the API's D1 | An app's issuer view (id, name, scope, active, email on, plan limits, its Google web client) and whether a scope has an email app; the issuer binds no API D1 (it had a read-write `APP_DB`, D251) |
| Admin Worker (batch C14) → watchdog | `GET /status`, `/alerts`, `/actions`, `POST /alerts/:id/ack` at `WATCHDOG_URL` (manifest `watchdog.url`), bearer `WATCHDOG_STATUS_TOKEN` (an admin secret, server-side only), redirects refused, 8 s deadline, size caps per route | The "Security & monitoring" view; text reduced to bounded plain data; acks (with the Access identity as `by`) stop re-sends only (D330–D332) |
| Operator → `hana-signer`, D1, Worker | `scripts/`, `wrangler` | Deploy, register scopes, apps, origins, secrets |
| Operator → watchdog | `GET`, `POST /test-page` at `watchdog.url`, bearer `WATCHDOG_STATUS_TOKEN` from `.secrets/<env>/watchdog-secrets.json`, redirects refused (`admin <env> watchdog:test-page`) | The test critical page (D449): sent by the Worker through its own channels, no alert opened |

## Flows

### Login, one transaction (`POST /v1/login`)

Browser steps: `packages/web/src/vault/login.ts`, `packages/web/src/auth/login-page.ts`, `callback-page.ts`.

1. Partner calls `hana.login()` in its click handler; the SDK opens `{authOrigin}/login?v=<vault frame name>` before
   any `await`, then sends `hana_login` on the port. Popup blocked → the vault shows a "Sign in with Hana" launcher.
2. The vault makes a non-extractable Ed25519 session key (`newSessionKey`, `packages/core/src/session.ts`: a WebCrypto
   `OperationError` is asked again, up to 4 attempts, since WebKit's Linux ports refuse about 1 in 128 Ed25519 keys,
   those whose seed or public key starts with a zero byte, D381, D385; a key it still can't make ends the login with
   `derive_failed`, `data.reason` `webcrypto_unsupported` (no Ed25519 in WebCrypto) or `webcrypto_failed`, D385; a
   link and the export window's own sign-in do the same), 32-byte salt, `expiresAtMs = now() + min(session_ttl_ms,
   24 h − 10 min)` on the server-corrected clock, `keyIndex = 0`, `maxUses` (1 in `'session'` mode, 2 in `'none'`),
   `nonce = sessionNonce(SIGNER, scopeId, …)` (`packages/core/src/layouts.ts:71`), `relayKey`, `relayReadKey` and
   `relayId = b64url(sha256(relayReadKey))` (`relayIdFor`, `layouts.ts:166`). `SIGNER` is a build constant; `scopeId`
   comes from the vault page's inlined D1 config. It needs `GET /v1/app` first (`apps/api/src/handlers.ts`
   `handleAppConfig`; normally answered already, the vault asks it right after `ready`; asked once more after a 5xx or
   a network failure, D261) for the Google client and refuses a `signer` or `scopeId` that differs. As soon as `GET /v1/app` answers it also starts
   the registry check (D56, `packages/web/src/vault/login.ts` `checkScope`), which runs while the user is at Google:
   own client `scope_for_client('google', clientId)` must be `scopeId`; shared client `get_scope(scopeId)` must exist
   with `allow_shared`, and `get_config().shared_clients` must list the client (both views in parallel, D117). Its
   answer is awaited after the token check, before step 6: a mismatch is `config_mismatch` (`scope_mismatch`), no
   answer `api_unavailable` (`scope_unchecked`).
3. The popup finds the vault (`opener.frames[v]`), gets `hana:auth-params` (accepted only from that window on
   `vaultOrigin`), checks `signer` against its own pinned constant, recomputes the nonce, stores `{relayKey}` under
   `hana.login.<relayId>` in its `sessionStorage`, and redirects to Google with `nonce` and `state = relayId`. It makes
   no API call (D77): the app's name, parent origin, scope and Google client are the vault's, and `POST /v1/login`
   checks them against the current app row before anything is relayed (`docs/security.md` "The login popup trusts the
   vault's app facts").
4. `/login/callback` reads `#id_token&state`, clears the fragment, requires and deletes `hana.login.<state>`,
   encrypts `{idToken}` under `relayKey` (AAD `"hana-id/relay/v1" ‖ relayId`) and posts it to
   `POST /v1/login-relay/<state>`. API: Hana-origin check, per-IP limit, one write per slot
   (`apps/api/src/login-relay.ts:170`, `LoginRelay.write` `:73`).
   **A closed popup** (D347): from the hello on, the vault reads the popup window's `closed` every 250 ms
   (`PopupTask.watchPopup`; its handle is the hello's `event.source`, valid across the popup's navigations: Hana's
   auth pages send no COOP, and Google's sign-in pages send COOP report-only, checked 2026-11-04 and rechecked before
   each release by `coop-canary`, D386). Every Hana page
   posts `hana:auth-progress` `google` before it navigates to Google, the callback posts `back` on arrival (it has its
   opener, so the trip switched no browsing context group) and `relayed` before it closes itself, as `/login/email`
   does; the signals go to the opener and its frames with `vaultOrigin` as the target, and the vault takes them only
   from the popup it answered. The vault acks each signal it takes (`hana:auth-progress-ack`, to that popup on
   `authOrigin`), and a page navigates or closes only once its signals are acked, or after 150 ms
   (`auth/vault-signal.ts`, D400): Chromium delivers a message posted in the navigation's own task with a null
   `event.source`, which the vault can't take. A close while the login waits on the popup (its first slot; a follow-up screen's
   answer; a link task's slots) ends it after 1 s of grace (an answer the window wrote just before closing itself
   still wins) with `login_cancelled`, `data.reason: 'popup_closed'`: the relay reads abort (abort-aware `readSlot`),
   the keys are dropped, and a later write to the slot is never read. A `relayed` signal the vault takes after its poll
   read the close (a busy vault) turns that grace off: the window said it relayed its answer (D495). A close while the vault works alone (google-match,
   the chain) lets the login finish; a later wait on the popup ends at once. A close within 8 s of a `google` signal,
   before `back`, may be an IdP's COOP switch (the opener's handle then reads closed while the window is open): the
   watch stops and arms a 90 s deadline (`POPUP_WATCH.earlyCloseDeadlineMs`, D398). The popup's answer before it
   (only an open window writes one) clears it, and the login goes on with its 5-minute limit only (and D341's own close
   report on the screen after a cancel); no answer by then is taken as the close, with the same grace,
   `login_cancelled` (`popup_closed`), aborted reads and dropped keys. Any end of the login clears the deadline. This
   covers every trip to Google: the first, token_first's silent second trip and D273's retry (the callback's own
   `google` signal), a screen's "Google again", and link tasks.
5. The vault long-polls `GET /v1/login-relay/<relayId>?wait=25` with `x-hana-relay-key`; the object checks
   `b64url(sha256(key)) === relayId` before consuming (`readKeyMatches` `login-relay.ts:52`, `LoginRelay.read` `:86`).
   The vault decrypts, verifies RS256 against Google's JWKS (`packages/core/src/id-token.ts:151`), `iss`, `aud`,
   `nonce`, `exp`/`iat` (60 s skew), the claim allow-list and `sub`, then fixes `expectedPath = scopeId#google#sub#0`.
6. The vault makes the BLS app key (`newAppKey`, `packages/core/src/ckd.ts:84`), signs `sessionMessage(1,
   ckdPayload(pk1, pk2))` and sends `POST /v1/login` (`handleLogin`, `apps/api/src/login.ts:85`). The API, in order:
   `appGate` kind `relay` (`handlers.ts:157`; key, active, `scope_conflict`, caller rule, limits); body shape incl.
   `keyIndex ≤ 2^31 − 1` (`toLogin`, `login.ts:49`); RS256 + claims (`verifyIdToken`, `packages/oidc/src/id-token.ts`); claim allow-list
   (`apps/api/src/claims.ts`); nonce recomputed with `SIGNER_ACCOUNT` and the app's D1 `scope_id`; from `authOrigin`
   (an export) the export limit, 3 per hour per `(app, sha256(path))` (D59); per-isolate hold on counter 1
   (`apps/api/src/session-use.ts:76`); in parallel `checkClientScope` (`handlers.ts:384`) and `session_key_in_use`
   (409 `session_exists`); the session signature; BLS key shape (`apps/api/src/bls.ts:28`); pairing precheck only when
   `BLS_PRECHECK = "1"`.
   An email login (build plan batch 6, not yet in the web) sends an email token as `jwt` (JWS JSON, checked against
   the manifest's email keys and the on-chain signer policy `get_self_issued("email")`, for an app whose
   `login_methods` lists `email`; `apps/api/src/email-token.ts`, D231). A login carrying an automatic link adds
   `linkJwt` and `linkImmediate`; the session key then signs the linked CKD payload, and the API recomputes the
   link's `auto_link` nonce from fresh `get_identity` / `get_account` reads before relaying (`link-precheck.ts`, D133,
   D232), so a link the user didn't sign, or one the chain state no longer matches, costs no gas.
7. The API relays `create_session_and_derive` (150 Tgas; 250 with a link, D155) through the session pool. The contract runs `create_session`
   then `derive_key(…, counter 1, …)` in one receipt (`contracts/hana-signer/src/sessions.rs:208`), stores the session
   with `path = scope#provider#sub#key_index` (`sessions.rs:175`) and calls the MPC.
8. Failure mapping by the failing receipt's executor (`loginFailure`, `login.ts:72`): signer → 422 `contract_rejected`
   (with `reason: 'session_key_in_use'` for that panic); MPC → 422 `ckd_failed` (session committed, `used = 1`); else
   502 `near_error`. Timeouts → 504 with `nearTx`. Whatever the outcome, one usage event goes to the ledger after the
   response (`login`, relayed when the transaction can have executed, with the signing key, its nonce, the
   provisional gas and, on success, the uid; `src/usage/event.ts`).
9. The vault decrypts: `S = decryptCkd(result, a, ckdAppId(SIGNER, expectedPath), pinnedKey)` with the pairing check
   (`ckd.ts:97`), `PRK = extractPrk(S)` (`packages/core/src/derivation.ts:46`, zeroes S), addresses from PRK. It never
   uses a path, session or counter from the API; recovery re-syncs `get_session` from NEAR RPC directly.
10. Result `{addresses, expiresAtMs, persistence}` to the partner, and `accountsChanged`. In `'session'` mode the share
    and record (below) are made afterwards, in the background (D79, `vault.ts` `persistLogin`): `POST /v1/vault/shares`
    is tried once more after 1 s if it fails. Giving up leaves the session working in memory with `persistence:
    'none'` (port event `persistenceChanged`, and `hana_status`), revokes the share if made and clears the older session's record (the next reload
    is a full login); a session that ends first (logout, a newer login, expiry) cancels it and no record or share
    survives it. Revoke-other-devices, touch and consent reads and writes wait for it. Also in the background, never
    awaited: the wallet record (`POST /v1/wallets/record`, "Wallet directory" below).

### Email login in the popup (build plan batches 8a and 8b)

Browser steps: `packages/web/src/auth/login-page.ts`, `email-page.ts`, `email-api.ts`, `email-storage.ts`,
`packages/web/src/vault/login.ts`, `packages/core/src/email-token.ts`. Differences from the Google login above:

1. Only when `GET /v1/app` answers `loginMethods` with `email` and `email.aud = "email:<scopeId>"`, and the env's
   bundle pins an email issuer (manifest `emailIssuer`: `emailIssuerUrl`, `emailIss`), does the vault add `methods:
   ["google", "email"]` (and `method`, `emailHint` from `hana.login(options)`) to `hana:auth-params`. A Google-only
   app's message is batch B's, key for key. `method: 'email'` for an app without email ends the login with
   `login_method_unavailable`. In the background it reads `scope_for_client("email", "email:<scopeId>")`,
   `get_issuer_keys("email")` and `get_self_issued("email")` from its own RPC.
2. `/login` (still fetch-free, D77) shows "Continue with Google" / "Continue with email" (or skips to the preselected
   method). Email: it stores the email context (public facts: app, parent origin, the session commitment, the Google
   client for case B; `hana.email.<relayId>` in `sessionStorage`, beside the relay key entry) and navigates the same
   window to `/login/email#<relayId>`.
3. `/login/email` (CSP `connect-src` = the issuer's origin and the API only): address → `POST {issuer}/v1/email/start`
   `{pk, email, purpose: "session", commitment, deviceTicket?}` (the issuer computes the nonce from the commitment) →
   it posts `hana:auth-progress` to the vault (`loginProgress: email_code`) → the 6-digit code →
   `POST /v1/email/verify` → the email token, encrypted under `relayKey` into the same relay slot as Google's answer
   (every 200 from `verify` also records the address in the issuer's user directory, after the answer: "Data stores");
   the device ticket goes to `localStorage` under a hash of the address. "Resend code", "Use a different email",
   inline wrong and expired codes, one generic "Too many attempts. Try again later." for every limit. Case B
   (`googleWallet: true`, no token: a Google identity that reported this address has the wallet) offers "Link and
   continue" when `verify` also answered a `linkTicket` and the address's `sub` (batch 8b), else "Continue with
   Google"; both go to Google on the same slot, "Link and continue" with `caseB {linkTicket, emailSub}` stored in the
   relay key entry for the callback. Cancel relays `{error: "email_…"}`, which the vault maps (D245); a step that
   can't go on relays `email_unavailable`, and the page stops at the vault's deadline. `/login` and case B post
   `hana:auth-progress` `google` when the user goes to Google.
4. The vault takes a JWS-JSON token only in a login that offered email, checks it with `verifyEmailIdToken` (exact
   form, pinned `iss`, `aud`, nonce, time, claim set, RS256 with the chain's active email keys, the signer policy; a
   kid the chain doesn't list is "try again later"), and requires the scope's email client on chain to be this scope.
   The path comes from `get_identity` (step 5 of the next section). From step 6 on it is the Google login's: the same
   `POST /v1/login` body with the email token as `jwt`, the same recovery, CKD decrypt and persistence.

### Automatic linking (build plan batch 8b)

Browser steps: `packages/web/src/vault/login.ts` (`PendingLogin.matchGoogle`, `judgeLink`, `ownPath`, `Afterword`,
`PendingLink`, `FollowChannel`), `vault/issuer.ts`, `auth/callback-page.ts`, `auth/email-page.ts` (follow-up mode),
`auth/google.ts`, `packages/core/src/links.ts`, `relay.ts`. Linking runs only in a login that offers email. Under
`'token_first'` (step 2, in force) a Google-only app's login in an env with an email issuer also carries the follow-up
key, for the user directory only (no google-match, no link); in an env without an issuer it is batch B's, message for
message.

1. **The follow-up channel** (D256). The vault adds `followKey` (32 random bytes) to `hana:auth-params`. Slot `n`
   (1..12) of the login's channel is a relay slot whose read key is `HMAC-SHA256(followKey, "hana-id/relay-follow/v1"
   ‖ u8 n)` and whose id is `b64url(sha256(read key))`; every value is AES-GCM under the login's `relayKey` with that
   slot's AAD. The vault writes its notices in slots 2, 4, 6, … (`POST /v1/login-relay/<id>` from `vaultOrigin`, which
   the API now accepts) and reads the popup's answer to notice `n` in slot `n + 1`; slot 1 is Google's access token
   (token_first's first answer; under `'second_request'` the second request's). After its token is relayed the popup doesn't close: `/login/callback` hands over to
   `/login/email`'s follow-up mode (or the email step goes on in place), which long-polls the vault's next notice and
   shows it (`FollowNotice`: `link_code`, `use_email`, `prove`, `done`, `stop`).
   Every read of the channel by the vault ends when what it waits for ends: the login (its 5-minute limit,
   `LOGIN_PENDING_MS`, `cancelLogin()`, a newer login, a logout), a `linkAccount` task, or the banners' 5 minutes
   (`AFTERWORD_MS`). The login then ends with its own error (`login_timeout`, `login_cancelled`) and writes `stop` to
   the popup, which shows it after its next answer. (Before `fix/abandoned-login-freeze` such a read went on after the
   abort: an aborted fetch rejects at once, so it spun on microtasks, the vault frame froze, and with it the partner
   page in the same renderer process, which on sandbox-dev, where the demo and the vault are one site, was the demo.)
2. **Google's verified email**, by `GOOGLE_EMAIL_FLOW` (`packages/web/src/auth/google.ts`, a code constant; the
   pages and the vault take it as a dependency, `googleEmailFlow`, so the tests run both values):
   - **`'token_first'` (in force since 2026-11-04, D270: the user's spike passed every leg for a Gmail, a Workspace
     and an outside-address account; `docs/context.md`).** Every Google login of
     an env with an email issuer carries the follow-up key; an app without email login also gets `emailRecord: true`
     in auth-params. `/login` (and case B's Google request on `/login/email`) asks first for `response_type=token`,
     `scope=openid email` with the account chooser and the relay `state`, so Google's one sign-in screen lists the
     email; no ID token, no nonce. Its entry keeps the login's nonce (`n`) and marks it (`tf`; `r` for a record-only
     login). `/login/callback` then: reads the access token's client and `sub` with `POST
     https://oauth2.googleapis.com/tokeninfo` (form body, no cookies, no referrer; `accessTokenSub`; its answer holds
     the address, parsed in the popup's memory, only `sub` kept, nothing relayed, stored or logged): another
     client's token (`aud`/`azp`), no answer (a network error, a 5xx, a CORS refusal) or a refusal ends the login
     (`tokeninfo_client_mismatch`, `tokeninfo_unavailable`, `tokeninfo_invalid` in the login's slot, `google_error`
     with that `data.error` at the partner), never a request without the hint. A record-only login instead goes on
     without tokeninfo when it gives no answer or refuses the token (D269's directory is best effort; another
     client's token still ends it): the access token is dropped, nothing goes to slot 1, and the callback makes batch
     B's request (`response_type=id_token`, `scope=openid`, `prompt=select_account`, the login's nonce) under a plain
     entry, so its ID token is relayed without `access: 'follow'`, the popup closes and the vault records nothing.
     Otherwise it relays the access token to slot 1 at
     once (it is never stored across Google's page); stores the ID leg (`leg: 'id'`, `login_hint`) under the login's
     own slot and asks `response_type=id_token`, `scope=openid`, `prompt=none`, `login_hint=<sub>` with the login's
     nonce. On a silent failure (`consent_required`, `interaction_required`, `login_required`,
     `account_selection_required`) it asks once more without `prompt=none`, still openid only and
     for that account, with no Hana screen (D273); a second failure, or any other error, is relayed. An ID token whose
     `sub` isn't tokeninfo's ends the login (`google_account_mismatch`). **A cancel on Google's screen** (D341:
     `access_denied` answered to the first request, or to that interactive retry) is not relayed, so the vault's wait
     goes on under the login's own 5-minute limit: the callback parks the login's keys under its slot (entry `x`, with
     `bk` the screen to go back to and, after the retry, `h`: slot 1 already holds that account's access token) and
     navigates to `/login/email#<relayId>`, which takes them into memory and shows that screen: Hana's method chooser
     ("Google sign-in was cancelled.", Continue with Google, and Continue with email when the app offers it and the
     partner didn't start the login with `hana.login({method: 'google'})`, D348: the email context keeps `method`), or case
     B's own choices when its Google step was the one cancelled. Google again is a fresh attempt under a new random
     OAuth `state` whose entry names the login's slot (`s`; the ID leg keeps that state), with the login's nonce, so
     the cancelled attempt's state never finds an entry again (a parked entry is never a Google answer's either);
     after a cancelled retry it is that retry again (the same account, no chooser). Case B's Google step always takes
     such a fresh state under token_first. Email is the email step in place. Closing the window on that screen
     (`pagehide`, not a navigation the page made) sends `{error: 'google_cancelled'}`, encrypted when the screen was
     shown and written with `keepalive`, and the vault ends the login with `login_cancelled`; case B's Cancel there
     relays `email_cancelled` as before. The screen stops at the email step's deadline (15 s before the vault's limit)
     and starts nothing after it. With no email context to go back to (none was stored) the cancel is relayed
     as before (`google_error`, `access_denied`); every other Google error is still relayed (`google_error`). The ID token is relayed with `access:
     'follow'`; an ID token answered to the access token request is never relayed (`invalid_response`). Then an app
     with email login goes to the follow-up mode, google-match runs as in step 3 (no explainer: Google's first screen
     asked; declining it is the cancel above, back to the chooser; D264's consent screen stays for a google-match
     `google_account_mismatch`; D255 unchanged); a record-only login closes the
     popup, and once `/v1/login` has succeeded and the key passed its check (step 10; a refused, failed or cancelled
     login is never recorded) the vault sends the access token, the verified Google token and the session commitment
     to `POST {issuer}/v1/email/google-record` in the background, never awaited by the login (best effort: read slot
     1, one call, no retry, at most 30 s, `RECORD_TIMEOUT_MS`; any failure is dropped and never reaches the login; the
     next login writes the row; slot 1 lives 120 s from its write, so a login slower than that records nothing).
   - **`'second_request'` (the fallback, D254; in force until 2026-11-04, kept built and tested).** Only in a login of an app with email. The login's Google request stays
     `response_type=id_token`, `scope=openid`; the callback relays the token with `access: 'follow'`, then makes a
     second, silent request (`response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>`) whose access
     token it relays to slot 1. When Google needs the user (`consent_required`, `interaction_required`,
     `login_required`, `account_selection_required`: the first time, since the token is never revoked, D265), it shows
     Hana's own screen (what Google will ask and why: Hana uses the address to find a wallet and keeps it with the
     account, never sharing it with the app; Continue or Not now, D264, D269), then asks once more without
     `prompt=none`.
   - `'one_request'` (`id_token token`, `openid email`) is gone (D273): Google puts `email` in that ID token (D270).
   Under every flow the only request whose ID token is relayed is `response_type=id_token`, `scope=openid`
   (`googleAuthUrl` builds nothing else), and `/login/callback` checks every ID token against the claim allow-list
   before relaying it: one with any other claim (`email`, `email_verified`, `hd`, …) is never relayed, the slot says
   `{error: 'token_has_pii', claim}` and the vault ends the login with that code and `data.claim`, as its own refusal
   does (the window stays open with the error); the vault and the API refuse such a token too (D25,
   D271). The full address never reaches the vault or the partner page (the vault relays only case A's masked hint,
   `a…@domain`, to the popup, end to end). The issuer never revokes the access token (D265).
3. **google-match before any chain call.** The vault sends `POST {issuer}/v1/email/google-match {pk, accessToken,
   googleIdToken, commitment, link: true, linkTicket?}` (CORS for `vaultOrigin`, D199; the vault page's CSP
   `connect-src` names the issuer, `EMAIL_ISSUER_URL`). A `429` or `503` is retried within the login (its
   `retry-after` up to 20 s, which the issuer's CORS exposes, else a backoff; 45 s of waits at most; 30 s per call). No answer: a Google identity with
   no wallet and no account is refused (`api_unavailable`, `email_match_unavailable`: it might be case A, and a plain
   login would open a second wallet, D255); one with a wallet or an account logs in as usual. Declined consent
   (`access_denied`) or another Google account picked on Google's screen (`google_account_mismatch`), for such an
   identity: notice `email_consent {reason, loginHint}`, the popup explains and offers "Sign in with email instead" or
   "Try Google again" (at most 3 such screens per login, `EMAIL_CONSENT_ROUNDS`), else `login_cancelled` with `email_consent_declined` /
   `google_account_mismatch` (D264). Under `'token_first'` the first such screen can only be a `google_account_mismatch`
   (declining Google's one sign-in screen is no Google login at all); a decline on a "Try Google again" screen after
   it gets the declined screen. A popup that can't store its next leg writes `storage_unavailable` to the slot
   the vault waits on (the login ends `storage_unavailable`).
4. **The four cases**, from google-match's `decision`:
   - `case_a` with `emailToken` (only when `googleHosted` and immediate; anything else is refused as the issuer's
     error): a linked login, silent.
   - `case_a` with `challenge` (not hosted): notice `link_code {challengeId, expiresAtMs, to: "a…@domain"}`; the popup
     shows "Link and continue" (`resend` sends google-match's prepared code, `verify` answers the `auto_link` token,
     relayed `as: 'link'`) or "Sign in with email" (an email login of that address, `as: 'session'`; Google's token is
     dropped unused). `case_a` that can't link: notice `use_email` (only "Sign in with email").
   - `case_b` with `emailToken`: only when the first slot carried `caseB` and the token's `sub` is `caseB.emailSub`
     (D139); mode as the issuer said (immediate when Google hosts the mailbox, else after `change_delay_ms`).
   - anything else (`none`, `linked`, `pending`, `unlinked`, `both_wallets`, `case_b` without a token): a plain login.
5. **The path** (batch 7): without a link, `get_identity` of the signed-in identity (the view's key checked against
   the computed one): own → its own path, active member → its account root's, pending → `link_pending` (with
   `effectiveAtMs`, also told to the popup). Any path that isn't the identity's own (a member's root, a link's target
   root, a path a pairing failure moved to) is confirmed on `rpc` and `rpcFallback`, each read alone: the same view
   on both, and the root `own` on both; else `api_unavailable` with `path_unconfirmed` or `path_disputed`, never the
   own path instead (D263). The two providers are read side by side (`confirmPath`, `packages/web/src/path-check.ts`:
   the view and the root on both at once, the verdict after every answer), in the vault and in the export window, so a
   slow second provider (`rpc.testnet.near.org`, about 3.3 s) costs one round, not one per read. The vault pins the root it derived per identity (memory, and IndexedDB beside the record
   when the app keeps the wallet; identity keys only); a root that changed other than own → member is confirmed on
   both again, as is any path but the identity's own when the pin read fails or doesn't answer within 1 s. The confirming reads and google-match
   also end when the login does (its abort signal). With a link (D133): fresh `get_config` (links open only when
   `unrecorded_wallets` is `false`), `get_identity` and `get_account` of both identities; `judgeAutoLink` (the
   contract's `auto_link` order) gives the join, the account root's path and the `auto_link` nonce; the join must be the
   case's, and the link token must verify against the chain's email keys with exactly that nonce. Then the session key
   signs the linked CKD payload (`signDeriveLinked`) and the body carries `linkJwt` and `linkImmediate`.
6. **Recovery** (D137, D257). A linked login is resent only for "not executed" answers, and a known transaction that
   returned the key is used; `session_exists`, `session_key_in_use`, `ckd_failed`, a timeout or an unknown outcome
   revoke the session (`POST /v1/sessions/revoke` at `used + 1`) and end with `derive_failed` (`link_restart`): the
   user signs in again with a fresh session, Google token and link token. A pairing failure in a plain login re-reads
   the session and the identity once (a link that activated meanwhile). A resynced own-path session whose identity has
   since joined an account answers `identity_linked` at `/v1/derive`: `session_consumed` (sign in again, D136).
7. **The last word** (`Afterword`): `done` with the account's banners from `get_account` (a pending method with
   Cancel, the method this login linked, active methods added in the last 7 days with Remove for the root), or `stop`
   with the error. A banner's action is a fresh sign-in of this login's method over a `link_change` nonce (Google: the
   vault's nonce and `login_hint`; email: a code over the commitment), relayed as `cancel_link` / `unlink_identity`.
8. **The partner's view**: `linkChanged` after a login that linked, at the session's first `hana_account` for each
   pending method, and on any change `hana_account` sees; `hana.account()` lists the root and members (no `sub`).
9. **`hana.linkAccount({method})`** (`PendingLink`): the vault checks the account has room (≤ 3 members, no member of
   that provider, links open), sends `task {kind: 'link', provider, prove}` in auth-params (the new method's proof
   over `link_new`: a Google nonce, or a `link_new` commitment for the email step), checks the new identity has no
   wallet and no account, asks (`prove`) for the account root's proof over `link_account`, and relays
   `POST /v1/link`. The link is pending for `change_delay_ms`.

### Wallet directory (D310–D317, D346)

Code: `packages/core/src/wallet-record.ts`, `packages/web/src/vault/wallet-record.ts`, `apps/api/src/directory/`,
`packages/console-core/src/users.ts`, `scripts/lib/admin-users.ts`, `apps/api/src/directory/near.ts`. Hot-DB migrations
0011 and 0019 (NEAR, D756).

1. **The record (vault).** When a login's session is adopted (`/v1/login` succeeded, the key passed the pairing check),
   the vault signs, with PRK, right after (a 0 ms timer, only while that session is still current), one record per
   chain: the Stellar key (Ed25519) over the statement
   `"hana-id/wallet-record/v1" ‖ 0x00 ‖ env ‖ signer ‖ app ‖ scope ‖ path ‖ chain ‖ address ‖ session_pk ‖ issued_at_ms`
   (borsh strings), the EVM key (ECDSA) over its sha256 (D311). Then the session key (its non-extractable WebCrypto
   key) signs the whole request: `"hana-id/wallet-record-session/v1" ‖ 0x00 ‖ env ‖ signer ‖ app ‖ scope ‖ path ‖
   session_pk ‖ issued_at_ms ‖ sha256(both addresses and chain signatures)` (D311 as amended after a security review:
   without it anyone could list their own address under a victim's public session key). The path is the session's,
   so a linked member reports its account root's wallet. It sends `POST /v1/wallets/record` without awaiting it: one
   call, aborted after 15 s, no retry, every failure dropped (D317). Only addresses and signatures leave the vault. A
   raw EVM request for the record's digest is refused for that session (D179).
   **NEAR (D755, D756).** For an SDK of 0.4.0 or later (the partner sees in its console what its SDK hands out, D725),
   and only when `GET /v1/app` lists `near` in `walletChains` (an older API refuses a three-chain body), the record also
   carries the NEAR implicit account, the NEAR key's Ed25519 signature over the same statement with `chain` `"near"`,
   and the session signature covers `"hana-id/wallet-record-proofs/v2"` over the three. The record can't be taken for
   a NEAR transaction, delegate action or NEP-413 message: those are Ed25519 over a 32-byte sha256, the statement is
   longer and Ed25519 binds the exact message (`packages/core/src/wallet-record.ts`'s header). A user who signed in
   before NEAR, or whose record was missed, gets it at the next unlock: the vault sends the record once at an unlock
   unless the mark beside its record (`near|<record id>`: the session public key the API last answered `near: true` for,
   IndexedDB; deleted with the record, at a logout too) names this session, or the API answered `near: false` for this
   session less than 30 minutes ago (24 hours for a conflict, D763). Old SDKs never send NEAR: such a user simply has
   no NEAR row. The SDK gate is the vault's: the API takes a three-chain body from any holder of a live session.
2. **The endpoint (API).** The vault gate and its limits, ±5 min on `issuedAtMs`, both records verified, the session
   signature verified against the body's session key, `USER_ID_KEY` and `IDENTITY_SUB_KEY` present (D346), the session
   live on chain in the app's scope and on exactly that path (`get_session`, as the identity token reads it), then one
   D1 batch: the user of the path's account root with its three ids (below), both wallets (`first_seen_at` MIN,
   `last_used_at` MAX: the last login, not on-chain activity), the root's identity row (D313); then the NEAR wallet in a
   statement of its own, so a database before migration 0019 (whose CHECK refuses `near`) keeps the other rows; the
   answer says `near: true | false` (with `nearCode`). The relayer asks `nearAccountUser(db, scopeId, accountId)`
   whether an implicit account belongs to a user of the calling app's scope (D757).
   **What "listed" means (D757, D762).** A NEAR account is listed for a user when a session of that user's account
   root, live on chain on that path when the record arrived, sent a record whose NEAR entry was signed by that
   account's key. It proves the session's holder also held the key; it does not prove Hana derived it (the API can't
   derive keys), so a client of its own can list any key it holds under its own user. Two rules bound that: at most one
   NEAR account per user and key index (a second, different one: `409 near_account_mismatch`, nothing written, and
   0019's unique index for concurrent writes), and at most one user per NEAR account in a scope (another user's record
   of a listed account writes its other rows but not the NEAR one, `near_account_taken`; the lookup answers null if two
   ever list one). An honest vault derives the same account for a path every time, so it never meets either. Stellar
   and EVM rows have the same meaning but neither rule (D762).
   **A user's ids (D346)**, all from the scope and the root's provider and sub: the **User ID** partners see, the
   identity token's `sub` (`u1_…`, `IDENTITY_SUB_KEY`, computed with core `identitySub`); its **Support ID**
   `HANA-XXXX-XXXX` (Crockford base32 of the first 5 bytes of the same HMAC); and the **internal id** `hu_…` (the uid
   under `USER_ID_KEY`, the ledger's pseudonym, D312), the row's key, for staff only. Without either key nothing is
   written (`directory_unavailable`).
3. **Identities (API, after the answer).** After a successful link relay, a fresh `get_account` of the account root
   rewrites the account's rows (members active or pending, removed ones `unlinked` / `cancelled`); after a successful
   `/v1/login`, a linked login reads the session identity's account fresh, a plain one reuses the login's standing read
   (the user's last seen, the root's row, a member's own row). Rows are per (scope, identity key) and move when a member
   joins another account; an older read never overwrites a newer row (D314).
4. **Reads.** Staff: `AdminRpc.listUsers` / `getUser` / `findUsers` (by wallet, User ID, internal id, Support ID or
   sub; a NEAR wallet by its 64-hex implicit account id, any case, D758) with all three ids, identities and subs; the email comes from the issuer's directory through D275's
   `DirectoryRpc`, joined on each identity's `directoryKey` (the admin Worker's Users screen, C8b: "Staff reads of the
   user directory" below). Partners: `ConsoleRpc.listUsers` / `getUser`
   for their org's scopes only, with the User ID (`u1_…`), Support ID, times, account kinds and wallets, never the
   internal id, a sub, an identity key or an email (D315, D346). The CLI: `admin user:list` / `user:find` with each
   identity's user (all three ids) and wallets, `user:find --address` / `--user` (D316).
5. **The Support ID shown to the user (C15, D395).** The `/v1/login` and `/v1/sessions` answers carry `supportId`,
   computed with the directory's own `directoryUser` from the session's account root (for `/v1/sessions` the chain's
   session path; for `/v1/login` the standing read or, with an automatic link, the root the link precheck judged), so
   it is the code `end_users.support_code` stores; absent without either key or without a confirmed standing. The
   vault keeps it with the session (in its IndexedDB record, across reloads) and gives it in `hana_status`,
   `hana_login` and `ready` to an SDK of 0.2.0 or later (`hana.supportId`; older SDKs' validators refuse an unknown
   key, D393) and on the approval popup's account line (`docs/integration.md`); it never computes one.

### Support ID lookup (staff; C15, D276 as amended, D394–D397, D399)

Code: `packages/console-core/src/support.ts`, `apps/api/src/directory/support.ts`, `apps/admin/src/support.ts`, the
admin SPA's `/support` screen (`apps/admin/public/app.js`), `scripts/lib/admin-support.ts`. No migration of its own.

```
staff ─Access─▶ admin Worker POST /api/support/lookup {query, ticket, requestIds?, days?}
                  1. CONSOLE StaffRpc.recordStaffAction(support.lookup)   audit_log, org-less; no row → nothing read
                  2. API AdminRpc.supportLookup                            hot DB: end_users (support_code | token_sub |
                                                                           user_id), identities, wallets, apps,
                                                                           vault_shares, app_changes
                  3. USAGE_DB (usage_admin)                                usage.events by uid (events_uid_at) and by
                                                                           request_id; "ledger unavailable" without it
                     with ISSUER DirectoryRpc.get(purpose support_lookup)  each identity's address (≤ 20), the same
                                                                           ticket and Access JWT; audited by the issuer
operator ─ admin <env> support:lookup ─▶ the same reads: the API's D1 (private executor), the issuer's D1 (addresses),
                                          Neon as usage_admin (.secrets/<env>/neon-usage-admin.url)
```

1. **Input**: a Support ID typed any way (`HANA-` and dashes optional, any case), a User ID or an internal id. A wallet
   or a sub goes through the user search first.
2. **Code → users**: `end_users.support_code` (or `token_sub`, `user_id`), every match listed (40 bits collide; at most
   10 in full, `truncated` beyond); each match's internal id is its ledger uid.
3. **Per match**: its ids, identities (with subs; the admin route joins each `directoryKey` with `DirectoryRpc.get`
   for the email, audited by the issuer as `support_lookup` with the lookup's ticket and request id (D399); the CLI
   joins the issuer's D1), wallets; the scope's apps; the shares not past
   `abs_expires_at` (the account root's path at each key index); the apps' `app_changes` in the window (30 days by
   default); the ledger's ok `login`, `session` and `derive` events by uid (at most 400).
4. **Errors** come only by the request IDs the partner's escalation gives (every outcome; `byMatch` when the event
   carries a match's uid): the ledger keeps a uid on ok events only. The partner has them from the SDK's errors: the
   vault keeps the request ID of the API answer a port error came from and sends it as `data.requestId` to an SDK of
   0.2.0 or later (`HanaError.requestId`; D405). Consents aren't shown (browser storage, D23).
5. **Partners** have no lookup: they see the code beside the User ID on their Users page (D310, D346).
6. **Erasure**: `uid-erase` (D361) deletes the account's directory rows and NULLs its uids, so the code resolves to
   nothing afterwards.
7. **The screen** (`/support`): the query, the ticket (required, the issuer's rule), the request IDs and the window
   are typed in and kept in memory only (no URL, no storage); the Users search sends a Support ID there (run at once
   when it carries a ticket) and each wallet-directory user's block links to it by User ID; "Wallet directory only"
   still asks `POST /api/users/find`. No export.

### Staff reads of the user directory (the admin Users screen, batch C8b)

`docs/batch-c-spec.md` "Users and Support ID"; D275 (confirmed 2026-11-05), D388–D392. Staff only: no partner Worker
binds the issuer, and nothing partner-facing names the directory (source and config tests).

1. **Search.** The SPA posts `{q?, provider?, appId?, sub?, unverifiedOnly?, cursor?, ticket?}` to `POST
   /api/users/search` (POST: no address in a URL). The admin Worker has checked the Access JWT and the staff list
   (`access.ts`) and forwards the same JWT with the filters to `ISSUER.search`.
2. **The issuer's own check.** `DirectoryRpc` verifies the JWT against the admin application (`ADMIN_ACCESS_*`,
   `@hana-id/oidc`) and its email against `ADMIN_STAFF_EMAILS`; that email is the actor. A refusal reads nothing.
3. **Budget, then audit and read in one batch.** The staff member's `RateLimiter` object (`staff-dir:<sha256 of the email>`) grants
   up to the page's rows (500 an hour, 2 000 a day); then one D1 batch inserts the `email_admin_audit` row (`user_search`,
   the ticket if given, `detail` with the filters, the address term as a keyed hash and the row count) and runs the
   SELECT. A failed insert returns nothing. Unreturned rows go back to the budget. Past the budget: `rate_limited`, and
   the admin Worker emails the security alias (`directory_budget`, once per staff member and window).
4. **Open one identity.** `POST /api/users/get {provider, sub, ticket}`: the ticket is required (refused before any
   call). In parallel `ISSUER.get` (audited `user_view`, one row of budget) and `AdminRpc.findUsers({query: sub,
   provider})` (the wallet directory: User ID, Support ID, internal id, identities, wallets per scope); then
   `AdminRpc.appNames` for the apps' names, and per scope (at most 8) `get_identity` and, in an account, `get_account`
   from the admin's NEAR RPC with the block height. The path is the identity's own (`own`) or its account root's
   (`member`, `pending` from `effective_at_ms`); a failed read is "chain unavailable", never a guessed path. All of
   it inside one call budget of 40 (D380's numbers).
5. **Audit view.** `GET /api/audit` adds the issuer's rows (`ISSUER.auditSince`, newest first) beside the console's
   audit and the app changes.

### Login, two transactions (split path)

`POST /v1/sessions` then `POST /v1/derive` with counter 1. Used today by `apps/smoke`'s direct page (Google's implicit
flow, `scope=openid` only, D271; partner origin, `pk_test_`, dev env only: `apps/api/src/origins.ts:68`). The vault keeps it as a `loginFlow: 'split'`
constructor option (`packages/web/src/vault/login.ts` `split()`), not wired to any build or env flag, until the ship
gate decides.

`/v1/sessions` (`handleAppEndpoint`, `handlers.ts:251`): gate → shape (`scopeId` from the client is refused; the app's
D1 scope is used) → RS256 + claims → claim allow-list, always (`400 token_has_pii`, nothing relayed; D271) → nonce
recompute → the session key's proof of possession (D137: `signature` over
`sessionMessage(0, "hana-id-create-v1:" ‖ sha256(session nonce preimage))`, signed by the vault's `split()` and the
smoke page, relayed as `create_session`'s `signature`; contract v3 requires it, v2 ignores it) → `checkClientScope`
and `session_key_in_use` in parallel → relay `create_session` (100 Tgas) → cache the session view 10 s.

### Explicit links (`POST /v1/link`, `/v1/link/cancel`, `/v1/link/unlink`)

`apps/api/src/links.ts` (batch 6; the web calls them from batch 8): from the vault or the auth origin only, gate kinds
`link` / `link-change` (adds and removals in separate windows) → the tokens verified and in the app's scope → the
contract's nonce and state rules from fresh chain reads (`link_new` / `link_account` / `link_change` over the account
root, the epoch, has-wallet, room, who may cancel or unlink) → relay `link_identity` (250 Tgas), `cancel_link` or
`unlink_identity` (150) through the session pool → revoke the account's vault shares in every app of the scope (the
root path at `key_index` 0..63, D233), so its other devices sign in again → after the answer, the wallet directory's
identities from a fresh `get_account` of the root ("Wallet directory", D314).

### Derive (`POST /v1/derive`)

`handleAppEndpoint` (`handlers.ts:251`): gate → shape → Ed25519 signature over `sessionMessage(counter, ckdPayload)`
(`apps/api/src/session-crypto.ts:57`) → hold `(session key, counter)` in this isolate → `precheckSessionUse`
(`session-use.ts:57`): session exists, is the app's scope, unexpired, `used < max_uses`, `counter ≥ used + 1` and `≤
max_uses` (409 `counter_used`, `session_exhausted`, `counter_out_of_range` with `nextCounter`); a cached view that
would refuse is re-read fresh before refusing → optional BLS precheck → relay `derive_key` (60 Tgas) → count the use
in the cached view. A counter ahead of `used + 1` is still relayed (it may succeed once earlier ones land).

### Key persistence across reloads

`'session'` mode only (app setting `persistence`, default `'session'`, `apps/api/migrations/0003_vault.sql`). The
session has `max_uses = 1`, so once the login's derive is spent, the share is the only way back to the key.

Share creation, `POST /v1/vault/shares` (`apps/api/src/vault/endpoints.ts` `createShare`), sent by the vault right
after it reported the login (D79):

1. The vault gate (`endpoints.ts` `vaultApp`, `vaultLimits`): app known and active (the app row cached per isolate
   for 30 s, `apps/api/src/app-cache.ts`, D78), `Origin === VAULT_ORIGIN`, `x-hana-parent-origin` allowed for the app,
   no `scope_conflict`, vault limits (60/min per IP per app, a per-location binding; then 10 × plan `per_minute` per
   app on the `app:<id>` object; the share actions' 10/min per share, a per-location binding, comes after the body
   check; D95).
2. `VAULT_KEK` loaded, else 503 `vault_key_unavailable`. App `persistence` must be `'session'` (409 `persistence_off`).
3. Signature by the session key over the vault message (shareId zero, counter 0, payload
   `"share" ‖ borsh(parentOrigin)`; `apps/api/src/vault/message.ts`).
4. `get_session` straight from RPC (no cache), retried every 300 ms for up to 2 s: live, the app's scope,
   `used === max_uses` (`endpoints.ts:151`).
5. Insert with `UNIQUE(session_pk)`: one share per session key. `K_s` (32 random bytes) is stored only as `share_enc =
   iv ‖ AES-GCM(VAULT_KEK, K_s, aad = share_id ‖ app_id ‖ session_pk)` (`apps/api/src/vault/kek.ts:77`).
   `abs_expires_at = min(session expiry, now + session_ttl_ms)`, `idle_until = min(now + idle_ttl_ms,
   abs_expires_at)`. `K_s` goes back to the vault once.

The vault writes an IndexedDB record `hana-vault/records` keyed `<signer>|<appId>|<scopeId>|<keyIndex>` holding the
non-extractable session `CryptoKeyPair`, `shareId`, counter, addresses, and `ct = AES-GCM(K_s, PRK, aad)` with the AAD
of `recordAad` (`layouts.ts:143`; `packages/web/src/vault/record.ts`), then zeroes `K_s`.

Unlock on reload or new tab, `POST /v1/vault/unlock` (`apps/api/src/vault/endpoints.ts`, `settingsRefusal`): the
vault gate as above, then the per-share limit 10/min → share looked up by `share_id AND app_id` (another app's share is 404) → if the share's partner origin
is no longer allowed, mark revoked, 410 → the app's settings as they are now: `persistence = 'none'` revokes the share
(410 `share_revoked`), and the share ends at `min(abs_expires_at, created_at + current session_ttl_ms)` (410
`share_expired`; the stored expiry is lowered) → vault signature with `counter = n + 1` → unwrap `K_s` (before the
counter moves) → one atomic `UPDATE … WHERE counter = n AND now < idle_until AND now < abs_expires_at AND revoked_at
IS NULL` that re-checks persistence and the TTL cap in the same statement, caps `abs_expires_at`, slides `idle_until`
to `min(now + current idle_ttl_ms, the cap)` and re-wraps under the current KEK if needed
(`apps/api/src/vault/shares.ts`, `advanceShare`) → `{ks, counter, idleUntilMs, absExpiresAtMs}`. No chain RPC. Errors:
404 `unknown_share`, 409 `bad_counter {expected}`, 410 `share_expired` / `share_revoked`. A 410 means a full login,
never a derive.

`/v1/vault/touch` follows the same settings rules and slides `idle_until` without returning `K_s` (the vault sends it
at most every 10 min after an approved signature, `TOUCH_EVERY_MS`). The hourly cron deletes shares past
`abs_expires_at` or revoked once they are older than 24 h (dead shares are the identity token's tombstones, D178) and
re-wraps up to 2000 rows from `VAULT_KEK_PREVIOUS` (`apps/api/src/vault/cron.ts:63`).

In-memory idle limit (D55, `packages/web/src/vault/vault.ts` `goIdle`/`wake`): every request that uses the key
(signing, export, revoke-other-devices, an auto-approve consent request) restarts a timer of the app's `idle_ttl_ms`;
reads (status, `eth_accounts`, `stellar_getAddress`, `hana_autoApproveStatus`) don't, so polling can't keep PRK, and
every use re-checks it on the server-corrected clock (a throttled timer can't keep PRK). When it passes, PRK is
zeroed. In `'session'` mode the session goes dormant: the vault keeps only the addresses, expiry and share id and this
tab's last known consent, still answers status, addresses and auto-approve status (from that consent: its counters may
lag other tabs' auto-signs) without unlocking, and before the next request that needs the key unlocks the record again
(one `/v1/vault/unlock`, same share only). If that fails (the server share's own idle or absolute limit passed, or it
was revoked) the session ends with `sessionExpired`. A dormant session also ends at `expiresAtMs`, on logout and on a
`revoked` broadcast for its share. In `'none'` mode the idle limit ends the session.

### Signing: approval popup vs auto-approve

Code: `packages/web/src/vault/` (queue, signing, policies), `packages/web/src/auth/approve-page.ts` (popup),
`packages/web/src/client/ethereum.ts` (EIP-1193), and the `@hana-id/core` pieces named here.

| Tier | Methods |
|---|---|
| Silent | `hana_status`, `stellar_getAddress`, `eth_accounts`, `eth_chainId`, `getNetwork`, `hana_logout` |
| Popup unless an accepted auto-approve policy matches | `stellar_signTransaction`, `stellar_signAuthEntry`, `eth_signTransaction` (and `eth_sendTransaction` via it), `eth_signTypedData_v4` |
| Popup every time | `stellar_signMessage`, `personal_sign`, and every NEAR request: `near_signTransaction`, `near_signMessage`, `near_signDelegateAction` (`NEVER_AUTO_APPROVED_KINDS`, `packages/core/src/approval.ts`; no policy format covers NEAR, D722) |
| Per app `raw_sign` | `hana_signRaw`: `'off'` → 4100; `'approval'` → popup with the raw warning, never auto-approved. The vault re-reads `rawSign` from `GET /v1/app` before each raw request when its last check is 10 s old (as for the policy); `'off'` there stops raw requests in that tab until a reload, and a failed re-read refuses (`api_unavailable`, `raw_sign_unconfirmed`) |

Test apps (D39, `packages/core/src/networks.ts`): for a `pk_test_` key the vault refuses, before any popup or
policy, a Stellar transaction or auth entry for the public network's passphrase, an EVM transaction on a chain outside
`TEST_EVM_CHAINS`, and typed data whose domain `chainId` is outside it (4100 `mainnet_not_allowed`). Messages, typed
data without a `chainId` name no network and pass. Raw requests are refused outright for test apps (4100
`raw_not_allowed_for_test_apps`, whatever `raw_sign` says): a raw digest can be a mainnet transaction's hash. NEAR
(D726): a test app's `near_signTransaction` or `near_signDelegateAction` for `mainnet` is refused the same way (the
mainnet demo never covers NEAR). The
EIP-1193 provider refuses switching to or
adding such a chain, and `eth_sendTransaction`/`eth_signTransaction` on one, before anything is filled. Every
approval and consent screen of a test app says Hana signs only for test networks (`testApp` in the popup messages);
with the mainnet demo on, as the vault last read it, the note says what the demo signs instead (`mainnetDemo` in the
same messages, shown only by a dev testnet build). The vault's launcher says whether it can be clicked in a port event
of its own, `launcherKind {clickable}`, sent just before each `ui` show (`ui` keeps exactly its two fields, which
shipped SDKs require): false for the 3-second "Signed by Hana under …" notice, which the SDK passes on as the
`launcher` event's `clickable` (D572).

Approval (D99): a signing call made in a click opens `{authOrigin}/approve?from=partner&v=<vault frame>` in that click
(`packages/web/src/client/approval-window.ts`, synchronously, with user activation, unless an approval popup is
already open) and sends the request flagged `popupOpened`. The popup finds the vault as the login popup does
(`opener.frames[v]`, origin and window checked both ways); the vault adopts it for the head of its queue, holds its
launcher up to 3 s for that hello, and tells a popup that showed nothing to close (`hana:approve-close`) when the
request was auto-approved or refused. Without activation or with `window.open` null (Safari after an await), the
vault queues the request and shows its launcher, whose click opens `{authOrigin}/approve` from the vault. Either way
the popup decodes the bytes itself (`decodeApprovalRequest`, `packages/core/src/decode/request.ts:55`; EIP-712 through
`normalizeTypedData`, `packages/core/src/typed-data.ts:266`), guards Approve (`approve-guard.ts`: 1 s after render,
1 s after focus, then a mouse move, a touch or pen press, or Tab/an arrow key; the arming gesture never approves;
decisions D36), and returns `approvalDigest` (`approval.ts:179`; empty network context for messages, typed data and
raw, which the popup says aren't tied to one network, D35). The vault recomputes the digest from the queued request
and signs only on a match, deriving the chain key from PRK per signature and zeroing it (`withChainKey`,
`derivation.ts:98`). After an answer the popup says what the answer did ("Approved", "Declined", or for a consent
"Allowed", "Not allowed") and counts down the 15 s it stays open for a follow-up, with Close now, which posts
`hana:approve-bye` as the timeout does (D471). At most 100 requests wait; one the popup couldn't show is refused at once. The SDK fills fees
and nonces and broadcasts through the partner's RPC: `eth_sendTransaction` runs one at a time per chain, broadcasts on
the chain it was filled on, and never fills a nonce below one past its last broadcast.

Auto-approve: the app owner sets an `AutoApprovePolicyV1` (D1 `auto_approve_policy`, pending + effective time on
set/change, immediate on removal; served only if it validates: `effectiveSettings`, `apps/api/src/vault/settings.ts`).
The vault page inlines the policy in force, and an open vault re-reads it from `GET /v1/app` before an auto-sign when
its last check is 10 s old or more (and every 60 s), so a removal stops auto-signing in open tabs within 10 s. A
policy rule whose `maxValueWei` is below its `maxFeeWei` is refused by the validator (value plus fees counts against
it, D37, D69). The user accepts that exact `policyId` (`packages/core/src/policy/id.ts`) once in a consent screen;
then the vault signs a request without a popup only if `matchAutoApprovePolicy`
(`packages/core/src/policy/match.ts:95`) passes and the per-day counters (`packages/core/src/policy/usage.ts`) allow
it. Rules in `docs/security.md`. The consent screen (`packages/web/src/auth/render-consent.ts`, D44) shows each policy
contract as "✓ {verified name}" when `(chain, address)` is on Hana's verified list, otherwise as "{partner name} ·
named by {app}" (flagged "— not the verified …" when the name imitates a verified one), always with the short address
and a "View on {explorer}" link when the chain's explorer is known. The list and the explorer URLs are pinned data in
`packages/core/src/verified-contracts.ts`, built into the popup bundle; nothing reads them from D1 or the API.

### NEAR requests (D720–D729)

The user's NEAR account is the implicit account of the `("near", "ed25519")` key (below). The partner client's
`hana.near` (`packages/web/src/client/near.ts`) sends three sign methods, each a popup every time:
`near_signTransaction {network, transaction}` (borsh `Transaction`, approval kind `near_tx`, context
`{nearNetwork}`), `near_signDelegateAction {network, delegateAction}` (borsh NEP-366 `DelegateAction`, `near_delegate`,
`{nearNetwork}`) and `near_signMessage {message, recipient, nonce, callbackUrl?}` (NEP-413, `near_message`, no context;
the approval bytes are `u32le(2^31 + 413) ‖ borsh(Payload)`). The codec is `packages/core/src/near/codec.ts`: strict
borsh (trailing bytes, unknown tags, invalid UTF-8 and invalid account ids refused; `TransactionV1` and actions after
`UseGlobalContract` refused as `unsupported`), tested byte for byte against `@near-js/transactions`. The signers
(`near/sign.ts`) sign sha256(borsh(Transaction)) (also the transaction's hash), sha256(u32le(2^30 + 366) ‖
borsh(DelegateAction)) (NEP-461) and sha256 of the NEP-413 bytes, with the seed from `withChainKey(prk, 'near', 0)`.
The vault (`vault/signing.ts`) refuses a request whose signer, sender or key isn't the user's (4100). NEAR's bytes
name no network, so the vault checks the claimed one on its env's RPC (`vault/near.ts`, D726) before any popup: every
app's `testnet` transaction must name a block the RPC knows (`block`, fail closed), a `mainnet` one must not; a test
app's delegate action must have the user's key on testnet (`view_access_key`), a nonce above the key's, above
(height − 10,000) × 10^6 and below height × 10^6 (`nearDelegateNonce` in `@hana-id/core/near` picks one), and
`max_block_height` within `NEAR_DELEGATE_MAX_BLOCKS` (10,000) of testnet's height; for test apps both providers are
asked (`independentEndpoints`; one provider fails closed outside local* envs, `near_rpc_single_provider`) and every
answer must pass, and the delegate may hold only FunctionCall and Transfer actions to a `*.testnet` receiver
(`nearTestAppDelegateProblem`: a copy replayed on mainnet about a year later, when its height reaches the window,
calls an account that doesn't exist there; D729). A transaction relaying a delegate action is refused
(`near_relayed_delegate`: its signer prepays the delegate's deposits). The popup
(`render-approval.ts`) says which network claims Hana checked. `hana.near.relay` posts a `SignedDelegateAction` to
`POST /v1/near/relay` on the env's `apiUrl` (where the environment runs a relayer); the vault isn't involved.
`hana.near.activate` posts the user's own account to `POST /v1/near/activate` the same way, so a new implicit account
exists on testnet before its first delegate action. The hosted demo (`apps/demo`) writes to the guestbook contract that
way.

Addresses (D725): `PortAddresses` gains an optional `near`, sent only to an SDK whose hello names `NEAR_SDK_MIN`
(0.4.0) or later (0.3.x SDKs check the object's exact keys). The vault derives the NEAR account from PRK at login and
at every unlock and never stores it: the record's `addresses`, the identity token's wallet proofs and
`POST /v1/wallets/record` stay exactly Stellar and EVM.

### Mainnet demo (D428, D429)

An exception to D39 for the Sodax demo; spec `docs/mainnet-demo-and-key-export-spec.md`. Hana staff set
`apps.mainnet_demo` for a test app (`admin app:settings --mainnet-demo on`, or the admin console: `AdminRpc
.setMainnetDemo`), in a dev env on testnet only.

0. **Prices (D436).** `GET /v1/app` answers `mainnetDemoPrices` for an app with the demo on, in a dev testnet env:
   the API Worker's CoinGecko prices × 1.05, clamped to a band per asset (`apps/api/src/mainnet-demo-prices.ts`:
   Pro key → Demo key → no key → fixed table; cached 5 minutes, used up to 15). The vault re-checks every book against
   the same band (`parseMainnetDemoPrices`, `@hana-id/core/mainnet-demo-prices`) and values requests with it, the
   fixed table standing in; it re-reads every 5 minutes while the demo is on and tells the SDK (`mainnetDemoPrices`
   port event, then `hana.mainnetDemo.prices`).
1. The vault page (`handleVaultPage`) inlines `settings.mainnetDemo: true`; the vault (a dev testnet build only,
   `demoBuild`) sends the SDK the `mainnetDemo` port event with the rules right after the hello. The SDK keeps it as
   `hana.mainnetDemo` and its EVM provider lets exactly those chains (Base) through its early D39 check.
2. A sign request names Base or Stellar's public network: `sign()` re-reads `GET /v1/app` if its `mainnetDemo` is
   older than 10 s (`freshMainnetDemo`; a failed read refuses), then `approvalSubject` runs
   `assessMainnetDemo(subject, serverNow)` (`packages/core/src/mainnet-demo.ts`): the request must decode into
   shapes Hana can value with its reviewed price table (in date), and the sum, fee included, be at most $9.99.
   Otherwise `4100` with the reason, before any popup, and the launcher flashes it.
3. The approval popup decodes the bytes itself, shows the red banner with its own valuation and the cap, and reads the
   wallet's balance from Hana's pinned endpoints (`auth/demo-balance.ts`; `/approve`'s CSP lists them in dev builds).
   Never auto-approved.
4. After signing, the vault reports `POST /v1/mainnet-demo/events` (chain, network, kind, USD value), signed by the
   session key with the session's wallet proof of the address; no key or bytes. The API checks the proofs, the
   session on chain and single use, and stores a `mainnet_signature` row naming the session's user, shown to staff
   as "reported by the vault".

### Revoke and logout

| Action | Path | Chain tx |
|---|---|---|
| Logout (default) | App-wide on the device: under the per-app lock, `POST /v1/vault/revoke` for this tab's share and for the stored record's share if it is another session's; the vault deletes the record, zeroes PRK and broadcasts `logout` on `hana-vault:<appId>`, which ends every tab of the app | none |
| New login | Revokes this tab's previous share and the overwritten record's share, broadcasting `signedOut {shareId}` then `revoked {shareId}`; only tabs holding that share end, signed out (D695) | none |
| Lost device | `POST /v1/vault/revoke-all`, only with a share created < 5 min ago; revokes the user's other live shares for `(app_id, path_hash)` and moves its own counter in one D1 transaction (`shares.ts`, `revokeAllFrom`): both or neither | none |
| On-chain revoke | `POST /v1/sessions/revoke` → `revoke_session` (20 Tgas), signed `sessionMessage(counter, "revoke")`; the precheck allows counter up to `max_uses + 1` so a spent session can still be revoked | yes; not used by default |
| Origin removed | the next unlock of each share made for that origin marks it revoked (410) | none |
| App switched to `persistence = 'none'` | the next unlock or touch of each of its shares marks it revoked (410) | none |

### Partner identity token

`docs/identity-token-spec.md` (D120, D127); endpoints and order of checks: `docs/api.md` "Identity token".

1. **At login** (and at the unlock of a record written before this, which has no proofs), while PRK is in memory, the
   vault makes one **wallet proof** per address: the Stellar and the EVM key (each derived for one signature inside
   `withChainKey` and zeroed) sign `"hana-id/identity-wallet/v1" ‖ 0x00 ‖ signer ‖ appId ‖ sessionPk ‖ chain ‖
   address`. They are kept in the session and in the IndexedDB record (format 2, `vault/record.ts`), and copied to a
   dormant session, so no later step needs PRK.
2. **The partner page calls `hana.getIdentityToken({maxAgeMs?})`** → port `hana_identityToken`, a silent method like
   `hana_status`: no popup, no PRK, never activity (it doesn't wake a dormant session or restart the idle timer).
   Logged out: `{identityToken: null}`.
3. The vault returns its cached token while more than 5 min remain (or half the token's life when the session's end
   made it short) and it is within `maxAgeMs`. Otherwise, under the Web Lock `hana-identity:<appId>` (so the app's
   tabs mint one at a time; a tab that waited finds the other's token), it signs the **session proof**
   (`"hana-id-identity-v1:" ‖ signer ‖ appId ‖ sessionPk ‖ issuedAtMs ‖ nonce ‖ sha256("identity-token" ‖ parentOrigin ‖
   walletProofsHash ‖ sha256(sealedEmail or ""))`, with its server-corrected clock; the session's sealed address rides in
   the body when it has one, "Email sharing with partners" below) and calls `POST /v1/identity/token`. In an app
   that keeps logins it first waits for the login's background persist (D79): the API needs the share.
4. **The API** checks the proof (±60 s, signature), that the contract isn't paused, the share (never another app's;
   in a `session` app: live, read-only, nothing moves), the on-chain session (live, in the app's scope), both wallet
   proofs, then single use and its limits (per session, per account, per app and per scope before a global breaker,
   D176); computes `sub` (HMAC of the path's root identity with `IDENTITY_SUB_KEY`, per scope, `key_index`
   dropped) and `sid` (HMAC of app and session key); sets `exp = min(iat + 1 h, session end)`; adds `email` and
   `email_verified: true` when the user shared the address with this app (D441, below); signs ES256 with the active
   key and checks the signature with the published key before answering.
5. The vault caches the token, announces it on `hana-vault:<appId>` (`{t: 'identity', sessionPk, token, iatMs,
   expiresAtMs}`: the session's other tabs cache it too) and emits `identityTokenChanged` to its partner page. A `410
   session_ended` ends the session in the vault as a revoked share does (`sessionExpired`).
6. **The partner backend** verifies the token against `{iss}/jwks.json` (cached 10 min): `alg` ES256, `typ`
   `hana-identity+jwt`, `iss`, `aud` = its app id, `exp`. The token is never accepted by any Hana API or the contract.

The token's `wallets` and wallet proofs stay exactly Stellar and EVM for every SDK, 0.4.0 included (D760): the spec
promises partners `chain` ∈ `stellar`, `evm` and "No other claim", so a NEAR entry could break a backend that checks
the shape. A partner reads the NEAR account from `hana.near.accountId` and proves it with `hana.near.signMessage`
(NEP-413) for now.

The cache is dropped (and `identityTokenChanged(null)` sent) at logout, expiry, revocation, a newer login, and when a
dormant session ends; it survives a session going dormant. The React hook `useIdentityToken` refreshes at `exp` − 5
min while the page is visible.

### Email sharing with partners (D411, D438–D443; live on sandbox-dev, migration 0014)

Code: `packages/email/src/sealed.ts`, the issuer's `handlers.ts`, `apps/api/src/identity/email.ts`,
`packages/web/src/vault/email-share.ts`, `vault.ts`, `auth/share-page.ts`, `auth/share-handoff.ts`; build note
`docs/email-sharing-spec.md`. Hot-DB migration 0014. A partner sees a user's address only after the user shared it
with that app; the app's `identity_email` says when Hana asks (`off`, `on_request`, `at_login`).

1. **The sealed address (D438).** Where the issuer already reads a verified address (google-match, google-record, an
   email `verify` that mints a `session` token) it also answers `sealedEmail`: the address, AES-256-GCM under
   `IDENTITY_SEAL_KEY`, bound to the app, the session key and the session's expiry. The vault keeps the blob with the
   session (memory, its IndexedDB record, a dormant session) and sends it with each mint and consent call; it can't open
   it. For a Google login of an app without email login it comes with token_first's google-record after the login.
2. **The sheet** is `/share-email` on the auth origin: the vault sends it `hana:email-share-request` (the app, the state,
   the blob and a single-use `preview` session proof); the page reads the address from `POST
   /v1/identity/email-consent/preview` (`Origin: AUTH_ORIGIN` only) and shows "Share email" (guarded, D36) / "Not now",
   or, for an address already shared, "Stop sharing" / "Done", with D42's caveat for an app on its own Google client. Its
   answer goes back to the vault, which records it (`POST /v1/identity/email-consent` or `/revoke`, signed by the
   session key) and says `hana:email-share-done`.
3. **At login (`at_login`).** Auth-params carry `emailShare`; `/login` marks the login, and the page that would close
   the popup at the end (the callback after its relay; the email step on the vault's `done`) goes to
   `/share-email?from=login` in the same window instead. The vault, once the key passed its check and before it
   answers `hana_login`, waits for google-record's blob if needed (30 s at most), then the share, reads the state, and
   shows the sheet in that window (the hello must come from the login popup's own window) when it is `not_asked`;
   otherwise it tells the window to close. A closed popup, no hello within 20 s, or any failure: the login goes on.
4. **`hana.requestEmailSharing()`** opens `/share-email?from=partner&v=<vault frame>` in the click (the vault's
   launcher when blocked); the vault accepts the hello of a window the partner page opened, reads the state (`off` and
   no address are `email_sharing_unavailable`) and shows the sheet; it resolves `granted`, `declined` or `dismissed`.
5. **Revoke.** The approval popup's account line shows "Email shared with {App} · Stop sharing" while the vault's last
   known state (a mint's `emailStatus`, a state read, a decision) is `granted`; it and the sheet's Stop sharing revoke
   every address of the app × account. After any change the vault drops its cached token (silently) and sends
   `emailSharingChanged` to an SDK of 0.3.0 or later.
6. **The API (D439–D441)** checks every consent call as a mint (proof, share, chain session), keys the row by the
   app, the User ID and `EMAIL_CONSENT_KEY`'s MAC of the address, and keeps the address only while it is granted (the
   copy `ConsoleRpc` gives the partner console's Users screen; search by a full address only). The mint includes the
   session's own address when shared, else (no readable blob) the latest shared one.

Nothing here changes a wallet address, a path or a key derivation: the rows are keyed by the identity token's `sub`,
computed from the session's on-chain path.

### Hana Home identity (H1, `docs/hana-home-spec.md`, D473, D474; live on sandbox-dev, the Home page since 2026-11-10)

The Home page (H7) signs in with a token whose nonce commits to a non-extractable Ed25519 key only it holds, and sends it
with a fresh signature in `x-hana-home` on every call. `apps/api/src/home/identity.ts` `homeGate` checks the origin, the
per-IP limit, the token (`verifyLoginToken` with no app), the audience (`homeAudienceRoute`), the nonce, the expiry, the
Home key's signature and a single-use counter, and answers `{provider, sub}` with no chain transaction, no cookie and no
stored account. `GET /v1/home/config` gives the page the server clock, the signer, the shared Google client and the exit
Google client to sign in with (H6): Home uses the exit client only where a scope's normal route is gone (D490), and its
tokens carry a session nonce to open a session in any existing scope (`exit_scope`, contract v4, D468), never a link or an
owner action. The exit's Google client has one redirect only, `{authOrigin}/home/callback` (D491). Its `sub` is Google's for the
user, the same across clients in one Cloud project (confirmed live before use, D484). The email Home audience `hana-home` is
admitted only while `("email", "hana-home")` is in force on the exit list (D494), so an emergency removal stops it too.
Nothing here derives a key: that's H3. Layouts live in `packages/core/src/home.ts` (`@hana-id/core/home`), shared by the
page and the API, with Node vectors in `packages/core/test/vectors/home-v1.json`.

**Hana Home: email and the exit client (H10, D463, D490, D491, D616–D627; live on sandbox-dev since 2026-11-10).** `/home` offers each sign-in
method `GET /v1/home/config` says is open. *Google*: the shared client while one is in force, else the exit client, whose
answer Google sends to `{authOrigin}/home/callback` (that client's only redirect URI); the child `/login?mode=home` names
the exit client with `exit: true` in its message, stores its entry marked for `/home/callback` with the client and nonce,
and `/home/callback` relays only that client's ID token for that nonce to the login relay. *Email*: no child window; the
page shows the address and code screens itself (`home-email.ts`) and calls the issuer's `POST /v1/email/home/start` with
`kind: 'identity'` and the Home key, end and salt; the issuer computes `homeNonce` and, after `verify`, signs a token with
the audience `hana-home` and the address's usual `sub`. To open an app's wallet, an email account gets a new code to the
same address (`kind: 'derive'`, the one-use session's inputs): the token is for `email:{scope}` while the scope holds its
email client, else for `hana-home` through the email exit (D485). A Google account opens an app whose coverage is `exit`
through the exit client and `/home/callback` (D490). Either way the rest is H8's: the path on both NEAR providers, one
`POST /v1/home/login`, the decrypt and the reveal. No path, key rule or derivation changes: an email user's path is
`{scope}#email#{sub}#0`, or the account root's, as in the vault. The header names the account: "Signed in as
{address}" for an email account (the address the page already holds in memory for its codes, D623, as text that wraps at
`@` and `.`; masked as "a•••@example.com" once the sign-in has ended, D689), "Signed in with Google" for a Google account, whose openid-only token carries no address (D678; showing it
is not built: the user kept it for later, D679). The code screens, here and in the login popup's email step, take their spacing from one
column layout (`.email-step`, `.email-form`, D676).

**Home's derive (H3, `POST /v1/home/login`, D520–D529, D540–D542; `docs/api.md`).** A Home identity opens a wallet in any registered
scope with no app gate, relayed from a dedicated pool (`home`, the `HOME_RELAYER_KEYS` secret, one key by default, method
`create_session_and_derive` only, objects `home-relayer-key-<i>` in the same Durable Object namespace), so a Home flood can only spend that pool. The
per-wallet, per-user and daily limits are checked last, right before the relay, so a refused request spends nothing. The path
comes from the chain-resolved root as for any login: no path, key rule or derivation changes. Home derives one use, key
index 0, within 20 minutes, and is refused when the chain shows the identity never opened a wallet in the scope (D544: a derive marks it `opened` for good). The derive writes `key_exported` (no app: `user_events.app_id` NULL, D520) and, only for a linked
member or an identity the directory already has, the directory row (D500, D527), and counts in `home_usage` (one row per UTC day). It marks no app as launched and counts in no app's usage.

**Home's billing (H11, D461, D585–D599, confirmed by the user 2026-11-10; live on sandbox-dev since 2026-11-10).** A derive that reaches
the relay is one ledger event, `home_login`: a scope, no app, no uid. Its org is the payer, chosen after the response by
`apps/api/src/home/billing.ts` (`HOME_PAYER`, the one rule): the scope's org while the scope has a running app, Hana's own
org (`HANA_ORG_ID`, else `org_legacy`) when its apps are all suspended or gone. Neon migration 0008 admits the event and
gives `usage.org_report` a row per scope for Home logins (`kind: 'home'`), which a statement shows as "Hana Home logins"
with its count, gas and cost. The partner's ledger rows don't name a Home derive's transaction, request id or exact time
(`usage.org_ledger`; staff read `usage.org_ledger_full`, D595), though the chain shows the transaction to anyone. Settlement
holds a Home event to the Home pool's keys (D590). The Home keys are in `AdminRpc.relayerKeys`, so the admin's daily nonce
check reads them (at most three keys a run, D598) and System status has a "Home pool keys" tile (D591). With usage capture
off none of this runs and the derive is unchanged: the API says so, the nonce check records baselines and alerts nobody,
and `deploy-check` fails a production env in that state (D596).

**The app list (H2, `GET /v1/home/apps`, D462, D466, D500–D503; `docs/api.md`).** Home's listing needs no chain
transaction. `scopes.first_session_at`, with `apps.first_login_at` per app (written once at an app's first successful login; strangers see only apps with it, D462), gives every scope that has had a login (it survives the wallet directory's purge, so a
shut-down app stays listed); the wallet directory, read only by the verified `(provider, sub)`, marks the user's own
scopes first with their Support ID and addresses. A linked member's directory row names its account, so it reaches its
root's wallet, the same path a session of its opens. An unlinked identity, or a link still in its delay (or past it until the member's login
writes `active`, D500), sees none of an
account's rows. Coverage comes from cached `get_scope`, `get_config` and D1's `hana_held_clients`, at most 16 chain reads a
request, and only says which route Home would use (shared, a Hana-held client, the exit client, a partner's client, an
email client, or none); login and the contract decide for themselves (H3). A scope's quieter listing (`home_quiet`) changes how
it's found, never whether it can be: a whole-name search, its link and its own users still reach it. No path, key or
derivation is touched.

**The page (H7, `{authOrigin}/home`, D550–D556; `packages/web/src/auth/home-page.ts`, `home-api.ts`; live on sandbox-dev since 2026-11-10, linked
from nowhere).** A top-level page on the auth origin, in Hana's brand, served like the other auth pages (`home.html`,
`AUTH_PAGE_PATHS`) with `frame-ancestors 'none'; connect-src {apiUrl} {rpc} {rpcFallback} https://www.googleapis.com`
(the export window's list, D583) and the files origin in `img-src`. It drops its opener at load, refuses to run framed and acts only on real clicks. Sign-in: a click opens the
child `/login?mode=home`, which takes `hana:home-params` only from its same-origin opener at `/home` (D552), recomputes
`homeNonce`, and goes to Google with the shared client (`scope=openid`, the account chooser); `/login/callback` relays
Google's answer through the login relay as for any login; the page checks the token against Google's JWKS and from then
on signs every `GET /v1/home/apps` call with the key made for that sign-in. It shows the user's apps first, then the
searchable list (15 a page), and for each app whether Hana can open the wallet, the addresses on record (copy; a
StellarExpert link for Stellar) and the Support ID where the API gives one. Listing and viewing derive no key and read no chain; only "Move this wallet
to another wallet app" does (below). The sign-in ends after 15 minutes, with a notice 2 minutes before; the
screen stays, nothing is fetched until the user signs in again, and each sign-in makes a new key (D553). The identity is
in memory only: a reload signs out. `/home?appId=app_…` is the partner's link (D555): it opens an app's page only when
the app is the user's own; otherwise the user's list comes first and the linked app sits under Hana's notice (D557). App
names are held to the display-safety rule, cut to 60 characters and never used as headings. `/home` alone sends
`Cross-Origin-Opener-Policy: same-origin-allow-popups` (D558).

**Moving a wallet out (H8, D575–D584; `home-export.ts`, `key-reveal.ts`, `export-path.ts`; live on sandbox-dev since 2026-11-10).** An app's page
ends with a collapsed section, "Move this wallet to another wallet app": collapsed, its heading, one sentence and a "Show
how to move it" button, the same shape as "Devices and auto-approve" above it (D677). Nothing in the address opens or starts it
(`?appId=` only chooses the app's page, and the app a link named isn't offered the move in that page load, D600). On "Sign in again to continue" the page opens the child `/login?mode=home` again
and sends it `hana:home-derive-params`: a session of its own for this app, one use, key index 0, 15 minutes, whose
`sessionNonce` the child recomputes; Google is asked to sign the user in again (`max_age=0`, no `login_hint`). The Google
client is the shared one (coverage `shared`) or the app's own (`hana_client`, `partner_client`), and the page first checks
on NEAR itself that it still opens this app (`get_scope` and `get_config`, or `scope_for_client`); coverage `exit` and
an email account open through H10's routes (`/home/callback` and the issuer's Home route: "Hana Home: email and the exit client" above). Back with the token, the page checks it against
Google's keys and against the account Hana Home is signed in as, resolves the path as the vault does (`exportPath`: the
identity's own, or its account root's only once `rpc` and `rpcFallback` each confirm it, D263), sends one `POST
/v1/home/login` (never re-sent, D581), and decrypts the answer with the pinned CKD key and the pairing check for that
path. It shows the wallet's three addresses, Stellar, EVM and NEAR (D768), (and says so if the record differs; on a linked path, or for an answer it looked up
on NEAR, a difference shows nothing, D601), then per chain the warning, the typed
`EXPORT`, and Show key / Copy key through the reveal it shares with the export window (the approval guard, the 60 s
hide). NEAR's two screens add three fixed notes under the shared warning: the key is the account, an account never sent
NEAR doesn't exist yet, and Hana pays fees only for its approved calls (D769). The derive's `key_exported` row has no
chain, whichever key is then shown (D770). PRK stays in memory for at most 5 minutes and is zeroed then, on "Lock now", on leaving the app's page, on
sign-out, on `pagehide` and when the tab is frozen; a chain key exists only inside one Show or Copy (D580). No path, key rule or derivation
differs from the vault's: a golden test holds Home to the frozen derivation vectors (`derivation-v1.json` and
`derivation-v1-near.json`), for an own path and a member's.

**Devices and auto-approve (H9, D606–D615; `home-devices.ts`, `apps/api/src/home/devices.ts`, `revoke.ts`, `root.ts`;
live on sandbox-dev since 2026-11-10).** The front page and each app's page have a section "Devices and auto-approve" that reads `GET
/v1/home/devices` when the user presses "Show devices" (or once after sign-in at `/home?view=devices`, the address
Hana's own "Manage in Hana Home" links will use from H12; nothing links to it yet, D613). The API answers from D1 only,
for the account root the wallet directory records for the signed-in identity (else its own path, key index 0): the live
shares (a "device": one browser profile on one site for one app session, with the vault's coarse label such as "Chrome on
macOS", D611), each one's active consent with the policy's label, consents of apps with no share, and the addresses the
account shares per app. Liveness is the vault status read's own rule (`shareLive`, `consentActive`), so a 'session'-mode
logout reads as not active (D534, D608). "Stop auto-approving", "Sign out this device" and "Stop sharing email" each ask
first, then send one `POST /v1/home/{consents,shares,email-sharing}/revoke`, which acts only on the same root's row (404
otherwise, D609). A member's account is confirmed on chain (`get_identity`) before any stop or shared address (D661). The open
partner tab learns of a stop from its existing 10-second status read, so auto-signing stops within about 10 seconds (D465);
a signed-out device's open tab ends at its next share check (D662, D680). Every app's vault checks about once a minute while a
session with a share is live in a shown, active tab, every 5 minutes once the tab has seen no activity for 5 minutes (D684,
D694): one timer (`armStatusRead`) serves the policy's re-check and the share check. An app with a policy uses its own
`GET /v1/app` (`x-hana-share`), one request a minute; any other app the light `POST /v1/vault/share-status` (D690: vault
only, by share id, its own per-share and per-IP Rate Limiting windows, one D1 statement, no chain call), each the other's
fallback; a read made in the minute for anything else counts. A hidden tab pauses the check and checks at once when shown
again (D681); failed checks back off to 8 minutes (D683); a dormant session and a `'none'`-mode session (no share) are not
checked by the timer. The check only ends a session, never extends one (D55, D539). An approval-popup signature and a cached
identity token also need a `'live'` answer younger than 60 s, checked first, with a 3-minute grace when no answer can be had
(D682, D691, D692). Home sees key index 0 only, the one index a vault opens (D665).

A session that ends because the API said its share was revoked tells the partner page so (D695): a status read's
`'revoked'` (the minute's check, or the one before a signature or a cached identity token), a `410 share_revoked` (or
`410 session_ended` with reason `share_revoked`) on a touch, `revoke-all` or a consent register, a newer login on this
device, or another tab's `signedOut` broadcast. The revocation itself may come from Hana Home, from `revoke-all` on
another device of the same user (`revokeAllFrom`), from a newer login on this device, or from the app's settings. The vault sends `disconnectReason {reason: 'signed_out'}` just before its
`disconnect` (`disconnect` keeps exactly `{code}`, so an SDK of 0.3.0 or older drops the new event and keeps the
`disconnect` it knows), the SDK adds `reason: 'signed_out'` to the page's `disconnect`, and every request the session
refuses at that moment (a signature, a consent screen, an export) gets 4900 with `data.reason: 'signed_out'`. To other
tabs it broadcasts `signedOut {shareId}` just before `revoked {shareId}`; a tab of an older build ignores `signedOut`.
An identity mint refused with `share_revoked` ends the session with `sessionExpired` as before, `session_ended` with
`data.reason: 'signed_out'`, and the `signedOut` broadcast. Every other end says nothing more: a logout (this tab's sends
no `disconnect`; another tab's `logout` broadcast is a `disconnect` without a reason), expiry and idle
(`sessionExpired`), a share the API reports expired or unknown (`410 share_expired`, `404 unknown_share`), a dormant
session's failed unlock (`sessionExpired`), a record that fails to open, and a lost vault connection (the SDK's own
4900).

### Auto-approve consents on the server (H4, H5, D45, D465, D510–D513, D530–D535; live on sandbox-dev)

`vault_consents` (D1, migration 0017) records each auto-approve consent: `POST /v1/vault/consents` (`apps/api/src/vault/consents.ts`)
registers one at Allow, `/revoke` stops it, both signed by the session key: over the share's counter in `'session'` mode, and with
`shareId` 0×16 and counter 0 in `'none'` mode (on-chain session checked instead, the row's id the replay check, D510). The
open vault's existing 10-second `GET /v1/app` read gains `x-hana-consent` and reads the status with no new polling: `active`,
`revoked` (a dead share counts) or `unknown`. A row can only stop auto-signing, never start it. A `'none'`-mode register reads the
chain once (`503 session_not_visible` if the session isn't visible yet), and a session key can hold at most 20 rows (D513). `vault_shares.device_label`
keeps a coarse "Chrome on macOS" the vault sends at share creation (D512) for Hana Home's device list (H9). The hourly
`vaultMaintenance` prunes consents; shares keep their 24 h tombstones (D178).

The vault (H5, `packages/web/src/vault/vault.ts`): after Allow it records the consent first (`POST /v1/vault/consents`, with a random
128-bit `consentId` sealed into the record with the consent) and stores it only on the 201, so a failure grants nothing (D98 item 13,
D530). Its existing 10-second `GET /v1/app` read names that consent (`x-hana-consent`), and it auto-signs only when the sealed
consent and an `'active'` answer asked within 10 s agree; a covered request goes to the popup while it can't confirm that
(outage or no answer: the consent stays; `'revoked'`/`'unknown'`: it's cleared), D532. A consent stored before H5 is dropped at
its first read (D531). `hana_revokeAutoApprove` and "Stop auto-approving" clear locally first and tell the API, only for a consent
this tab holds; a logout or new login in `'session'` mode relies on the share's revoke to end it (D534).

### Owner and registry changes

| Change | Who / how | Code |
|---|---|---|
| Register a scope (pilot) | Hana: `admin scope:register` → `admin_register_scope` with the owner account's full-access key | `scripts/admin.ts`, `scripts/lib/admin-scope.ts` |
| A scope's email client (dev envs only) | Hana: `admin scope:add-email-client` mints the client proof locally with the issuer's code and key file, checks it against the contract's rules, then the scope's NEAR owner sends `propose_change(AddClient)` and `execute_change` (D253). Elsewhere: the issuer's staff route behind Access, then the scope's owner | `scripts/lib/admin-email-client.ts`, `apps/email-issuer/src/client-proof.ts` |
| Register an app, origins, suspend/resume | Hana: `admin app:create --org` (writes the `scopes` row with the scope's environment, `pk_test_`/`pk_live_` by it, the first `app_keys` row), `app:origins:add` (a staff proposal: `guarded_changes` + an `app_origins` row with `active_from` NULL), `app:origins:remove` and `app:suspend/resume` (immediate; Hana's suspension bit 1), each with its `app_changes` row (D1 via `wrangler d1 execute`, compare-and-swap on the app's version) | `scripts/admin.ts`, `scripts/lib/admin-apps.ts`, `scripts/lib/admin-sql.ts`, migration 0006 |
| RPC writes (batches C5 and C6, unbound until C7/C8) | The console's members through `ConsoleRpc` (removals, turn-offs, settings, logo pointer, keys, the partner suspension bit, cancels, the emailed-link cancel; with a step-up token the API verifies itself, origin adds and policy / raw-signing proposals; on-chain owner actions relayed like `/v1/owner-actions`, scope checked against the org) and Hana staff through `AdminRpc` (the same for any org, plus `createApp`, `assignScopeOrg`, `deleteApp`, every suspension bit, security contacts, staff proposals, `ackNotice` after the admin Worker's notice, expedite, the feeds). One D1 batch per write with its `app_changes` row first (compare-and-swap); kill switches through `ConsoleRpc` capped by the breaker (5 per org, 20 overall per hour) and every call by a hot-DB budget | `apps/api/src/rpc/`, `apps/api/src/changes/` |
| Guarded changes (origin adds, auto-approve policies, raw signing on) | Proposed by Hana staff (the CLI, or `AdminRpc.addOrigins` / `proposeChange`) or by an on-chain `Owner::Oidc` of the scope through the console (`ConsoleRpc.changeOrigins` / `proposeChange`: a step-up token bound to the exact change and version, verified by the API: signature, console audience, `iat` ≤ 300 s, nonce, uncached owner check, single use; the console's screens are C10); in force only once announced and `appChangeDelayMs` later (24 h in production; 60 s on sandbox-dev). The admin Worker announces after its notice is accepted (batch C8); until then, in an env without an admin Worker, `admin app:changes:announce <id>` does it with no email. `AdminRpc.ackNotice` starts the clock the same way (and stores the cancel link's token hash). A change not announced within 7 days is cancelled by the API's hourly cron, which also records activations (the app reads answer a change in force as `active` before then, D701), promotes policies and raw signing, and flags origins, policies and raw signing no announced change or the 0006 baseline explains (drift, `apps/api/src/changes/drift.ts`). The initial origins of an app whose scope `app:create` created skip the delay while the scope shows no sign of a user (`no_session` waiver: no `first_session_at`, which every session-pool relay attempt writes, no other origin ever in force, no share, session marker (written once the first session-pool relay settled; batch C4) or identity row; decided in the announcement's SQL) | `scripts/lib/admin-apps.ts`, `apps/api/src/guarded/cron.ts`, migrations 0006 and 0009 |
| Hana Home's held clients and quieter listing (H2) | Hana: `admin home:client:add` (records a Google client Hana holds, after checking the chain lists it in the scope) and `admin home:listing --quiet/--normal` (`scopes.home_quiet`); D1 only, dry run without `--yes` (D502, D503) | `scripts/lib/admin-home.ts`, migration 0016 |
| Vault settings (`persistence`, TTLs, `raw_sign`, policy, web client) | Hana: `admin app:settings` (D1; `--raw-sign approval`, live apps only, and a new or changed policy are guarded changes, above; turning either off and the other settings are immediate; every write bumps `settings_version`, applies only over the row it read and records an `app_changes` row) | `scripts/lib/admin-settings.ts`, migrations 0003 and 0006 |
| Propose / cancel / remove client / disable shared login (OIDC owner) | `POST /v1/owner-actions`, or `ConsoleRpc.ownerAction` for the console (same path, the console's `clientIp` on the per-IP limiter), with a console-client token (openid only: the owner token and an `AddClient` client proof are held to the claim allow-list on both paths, `token_has_pii`, D274, D277); off-chain precheck on an uncached `get_scope` (owner, the owner-action nonce recomputed at the scope's `action_nonce`, and for AddClient the client proof's client and nonce: a stale action is refused before any gas), single-use token marker, caps (a safety budget for cancel, remove client and disable shared login that proposals can't exhaust; `owner_cap` events), owner pool (`owner_allowance_low` hourly) | `runOwnerAction` in `apps/api/src/handlers.ts`, `apps/api/src/owner-actions.ts`, `apps/api/src/owner-pool.ts` |
| Execute a matured change | anyone; `POST /v1/owner-actions` relays `execute_change` | same |
| NEAR-account owners | call the contract directly (the API relays OIDC auth only, `apps/api/src/validate.ts`) | `contracts/hana-signer/src/registry.rs` |
| Shared clients, sponsors, console audiences, issuers | owner account via `deploy-contract` | `scripts/deploy-contract.ts`, `scripts/lib/deploy-plan.ts` |
| The console sink scope (D93 Q7, D238) | `deploy-contract`: the console audiences are the only clients of a Hana `sN` scope (owner `Owner::Near`, no shared login, no app), never of `global`. Fresh env: registered before `global`. Existing env: `remove_client` of each from `global`, then, after their quarantine (`change_delay_ms`), `admin_register_scope` for the sink | `scripts/lib/deploy-plan.ts` `consoleSinkPlan`, `scripts/lib/deploy-run.ts` |
| Google RSA keys | the 15-min cron with `KEYS_UPDATER_KEY` (three JWKS fetches a run, a kid any of them lists counts as published) proposes adds and (after ≥ 24 h missing from every fetch, never a kid that signed a token in the last 24 h, never the last key; D422) removals, and executes matured changes that match Google's JWKS; a key is active only after `issuer_key_delay_ms` or a watchdog's confirmation | `apps/api/src/issuer-keys.ts`, migrations 0002, 0005 |

Timelocks, quarantine and shared-client rules: `docs/contract-interface.md` "Registry" and "Shared clients".

### Partner sign-in to the console (batch C9)

Partners sign in to the console with Google's authorization-code flow and PKCE on a separate auth origin, so no page an
XSS on the console could run on ever receives a Google redirect (D75; `docs/api.md` "Console Worker and console-auth").

1. **Create** (`console.origin`): the SPA posts `POST /api/auth/start {purpose: "login", invite?}` (the invite token
   from `/invite#t=…`, a fragment). The console stores an `auth_flows` row (hashes of the start handle and of the state
   derived from it, the PKCE verifier, a login nonce in its own domain, `scope=openid email`, the invite), sets
   `__Host-hana_pre` and answers `{startUrl}`; the SPA navigates there.
2. **Start** (`console.authOrigin`, console-auth → the console's `AuthHandler`): the flow is marked started, the auth
   origin sets `__Host-hana_af`, and 303s to Google (`response_type=code`, S256 challenge, `prompt=select_account`,
   the invitee's address as `login_hint`).
3. **Callback** (auth origin): only a valid `code` and `state` of a started flow carrying this browser's
   `__Host-hana_af` gets a redirect, ending in `#` (the implicit-flow guard). The console exchanges the code with its
   client secret and the verifier, checks the ID token (`apps/console/src/auth-token.ts`: signature, `iss`, `aud`, the
   nonce, `iat` ≤ 120 s, the claim allow-list, which holds `at_hash` (D342), plus `email`, `email_verified`, `hd` for sign-in, D290), writes
   a 60-second handoff row with the verified identity and 303s to `console.origin/api/auth/complete?h=…#`.
4. **Complete** (console origin): with the flow's `__Host-hana_pre`, the handoff is used once; the membership rules run
   (a disabled user; an invite accepted in one D1 batch; or an existing member of an active org whose `required_hd`
   matches); a session (`__Host-hana_cs`, 2 h idle, 12 h absolute) and an audit row are written, and the browser goes
   to `/`; a refusal goes to `/signin#error=<code>` (D291–D293).

Every later request reads the session and the member's role from `CONSOLE_DB`; the screens (apps, an app's origins,
guarded changes, keys and settings, members and invites, the audit merged with the API's `app_changes`) come from
`ConsoleRpc` and `CONSOLE_DB`, shown without staff identities, Google `sub`s or network data (D296). Any member also
gets the usage report, the monthly statements (on screen, with the CSV, PDF and ledger CSV as plain links to the
console's routes, which serve a statement file only when it matches its hash) and the pending-upgrades page, frozen
orgs included (D370–D374). Nothing in the
console reads the email issuer's user directory (D269). Open question 1 (does Google's code flow keep the `openid`
token free of `email`?) is tested by `scripts/console-code-flow-spike.ts` (D295); the code flow's `at_hash` is in the
allow-list (D342).

**Writes (batch C10; `apps/console/src/writes.ts`, `actions.ts`).** An owner's immediate writes (removing an origin,
turning the policy or raw signing off, cancelling a guarded change, suspending, renaming, keys, the logo, revoking an
invite, cancelling an owner grant, executing a matured on-chain change) are `ConsoleRpc` calls with the member actor,
each with an outcome audit row; a viewer gets `403`, and a frozen org keeps only the cancels and kill switches (D356).
Everything the spec marks "fresh sign-in" is a **step-up**:

1. `POST /api/orgs/:org/actions {kind, params, returnTo?}`: the console builds the canonical action and its Google nonce (the
   origin-change or settings-change layout, which the API recomputes; the contract's owner-action layout at the scope's
   `action_nonce`, read uncached from NEAR; the generic step-up layout bound to the session otherwise), stores a
   5-minute `pending_actions` row and answers the decoded view, which `/actions/:id` shows (for a policy, the consent
   screen as users see it, packages/web's `renderConsent`, D352). It also stores where the page's back link returns:
   the page that started the action (`returnTo`, a page from the kind's allowlist, the path built from ids, D711), so
   both Email login steps come back to the Email login tab after Google.
2. `POST /api/actions/:id/google`: an `auth_flows` row with `purpose = 'step_up'`, `scope = 'openid'`, the action's
   nonce and the session's `sub` as `login_hint`; the same `/start` → Google → `/callback` path as sign-in.
3. The callback verifies the token (`openid`: exactly the claim allow-list), then runs the action with it: the token's
   `sub` must be the session's, the action unused, its session live, the member still an owner. Guarded changes and
   owner actions go to the API with the JWT, which verifies it again (`changes/step-up.ts`, the owner-action precheck)
   and, for an owner action, relays it through the owner pool; member changes and `org.policy` consume the action,
   apply the change and audit it in one D1 batch. The browser lands on `/actions/:id#`, which reads the outcome. The
   token is never stored; the action is used once whatever the outcome (D354).

An AddClient needs a client proof: the console offers a downloadable helper page (Google's implicit flow, `scope=openid`,
the scope's client-proof nonce; D351) that the partner opens on one of the client's own origins; the pasted token is
checked (signature, `aud`, nonce, the claim allow-list, D350) after a warning that it becomes public on chain. The scope
page also shows owner drift (the org's owners against the scope's on-chain `Oidc` owners) and offers a SetOwners built
from the org's owners (D353). The emailed cancel links land on `/cancel/:changeId#t=` and `/cancel-owner/:grantId#t=`,
SPA pages that POST only after a click. The partner Users screen (D310, D346: the User ID is the identity token's `sub`,
the Support ID its short form; account kinds and wallet addresses, and an email address only once the user shared it with one of the org's apps
(D411); never a Google account id or an unshared address) is behind
`USERS_SCREEN`, which the console's `gen` writes from the manifest's `console.usersScreen` (D357, D702: on in
sandbox-dev, off elsewhere). An app's page never shows a change in force as waiting: `getApp` answers a pending change
whose `active_from` has passed as `active` (D701), the SPA judges "waiting" on the server's clock (the app read's `now`, so a
reader's clock that runs fast never hides a Cancel the server would accept) and re-reads the app once at the next
effective time; of two `policy_set` changes in force before the hourly job, only the latest reads `active`; the client snippet names the env (`GET /api/me` `envName`, D703).

### Key export

`packages/web/src/auth/export-page.ts` (its reveal and its path rule are the modules Hana Home shares, `key-reveal.ts`
and `export-path.ts`): `hana_export {chain}` → launcher → top-level `{authOrigin}/export` window,
which runs its own fresh login (`/login?mode=export`, `max_age=0`, `max_uses = 1`) through `/v1/login`: Google, or in
an app with email (batch 8b, D246 lifted, D258) the child popup's chooser and `/login/email`'s code step over the export
window's own session (purpose `session`; the token checked against the chain's email keys as the vault does). It
resolves the path through `get_identity` on its own RPC (a linked identity exports its account root's key; a pending
one is refused, `link_pending`), decrypts against that path, aborts if the address differs from the vault's, and after a
typed confirmation shows the key (SEP-23 `S…`, `0x` hex, or NEAR's `ed25519:` + base58(seed ‖ public key), D724) on a "Show key" / "Hide key" toggle, selectable while shown and
hidden again on window blur, a hidden tab and pagehide; "Copy key" writes it with `navigator.clipboard.writeText` in the
click, shown or not, and says how to copy by hand when the Clipboard API is missing or refuses (no `execCommand`
fallback). Both act only on real gestures. The window tries to blank the clipboard (an empty `writeText`, never a read)
60 s after the last copy, at the erase and at pagehide, only while it has focus: Chromium allows that, Firefox and Safari
likely refuse it without a gesture (D268). The key is erased 5 min after it is derived, or earlier when the
vault session ends: the context carries `sessionExpiresAtMs`, and the vault's `cancelExport` posts
`hana:export-end` on logout, revoke, expiry, a newer login or its 15 min job limit; the window also ends if its vault
frame goes away (D111). The vault's PRK is never used for export. The `auth_time` freshness
check is off (Google returns no `auth_time`, D27; `maxAuthAgeMs`, `packages/core/src/id-token.ts`). Encodings:
`packages/core/src/export.ts`. The export window takes its context only from the vault frame that opened it (its
`opener`, origin `vaultOrigin`), and the vault opens it only from its own launcher's click, so a partner page can't
start an export on its own. Its `/v1/login` is relayer-paid and limited to 3 per hour per user path per app
(`apps/api/src/login.ts`, D59). D430: Continue, Show key and Copy key are behind the approval popup's guard
(`ApproveGuard`), a shown key hides again 60 s after Show, the first and confirm screens carry the plain warning, and
the login body names the chain (`exportChain`; a NEAR export sends none, since the API takes `stellar` or `evm` there,
so its event has no chain, D724); when that login succeeds the API records a `key_exported` row in
`user_events` (the account's internal id, the app, the chain, the time), which the admin's Users detail and Support ID
lookup show; kept 24 months and erased with the user's other records (D433).

## Key derivation

```
path   = {scope_id}#{provider}#{sub}#{key_index}          sessions.rs:175, e.g. s1#google#1102…#0
app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ signer account ‖ "," ‖ path)    ckd.ts:90
CKD    : MPC returns big_y = y·G1, big_c = msk·H(pk ‖ app_id) + y·a·G1; S = big_c − a·big_y (48 bytes),
         checked by e(H, pk) = e(S, G2) against the pinned ckdNetworkKey                ckd.ts:97
PRK    = HKDF-Extract(SHA-256, salt = "hana-id/chain-keys/v1/extract", IKM = S)       derivation.ts:46
info   = borsh("hana-id/chain-keys/v1/expand") ‖ borsh(ns) ‖ borsh(curve) ‖ u32le(account)   derivation.ts:56
```

| Tuple `(namespace, curve)` | Output | Key rule | Address |
|---|---|---|---|
| `("stellar", "ed25519")` | 32 bytes | RFC 8032 seed (`Keypair.fromRawEd25519Seed`) | StrKey `G…` |
| `("eip155", "secp256k1")` | 48 bytes | `d = (int_be(okm) mod (n − 1)) + 1` (`mapHashToField`, FIPS 186-5 A.2.1) | EIP-55, one key for all EVM chains |
| `("near", "ed25519")` (D720, added 2026-11-11) | 32 bytes | RFC 8032 seed | NEAR implicit account id: lowercase hex of the public key; key `ed25519:<base58>` |

`account = 0` and `key_index = 0` in the MVP. `key_index ≥ 2^31` is refused by the contract (`sessions.rs:27`), the
API (`apps/api/src/validate.ts:12`) and core (`layouts.ts:18`). Golden vectors: `packages/core/test/vectors/
derivation-v1.json`, guarded by a SHA-256 constant test that fails with "address-changing edit"
(`packages/core/test/derivation.test.ts:62`). NEAR's tuple is additive: `DERIVATION_V1_NEAR`, outside the frozen
`DERIVATION_V1` constants (whose hash is unchanged), with its own vectors (`derivation-v1-near.json`, the same S
inputs, from an independent generator) and its own guard (`packages/core/test/derivation-near.test.ts`).

What decides an address, and when it freezes:

| Input | Changes addresses? | Status |
|---|---|---|
| MPC network (its master key) | yes, all | fixed at the address freeze (mainnet MPC) |
| Signer account id (in `app_id`) | yes, all | fixed when final accounts deploy |
| Path format `scope#provider#sub#key_index` | yes, all | fixed now (contract) |
| Scope id, Google `sub`, `key_index` | yes, per user / app | per login; `sub` is the same across clients, also in different Cloud projects (D42) |
| HKDF labels, tuples, key rules (derivation v1) | yes, all | names confirmed 2026-10-28; frozen at the address freeze |
| New chain tuples, new `account` values | no (additive) | open; `("near", "ed25519")` added 2026-11-11 (D720), final before the address freeze |
| `vaultOrigin`, `authOrigin`, `create_session_and_derive`, persistence, own vs shared client | no | `authOrigin` still breaks own-client redirect registrations if changed |

Contract v3 (email login, merged on `develop`, live on sandbox-dev since 2026-11-03) adds no input to this table for existing identities:
the path's `(provider, sub)` is the session's path identity, which is the token's own unless the identity is a member
of an account, when it is the account root's (an existing path, so linking never creates or moves an address). Email
identities use provider `email` and a `sub` derived off chain (`docs/email-login-spec.md` "Address impact"; frozen
at the address freeze). The web (batch 7) resolves the path as the contract does, from `get_identity` on its own RPC
(`packages/core/src/links.ts` `pathIdentity`): an identity that is "own" derives `scope#provider#sub#0` (Google byte
for byte as before, golden tests in `packages/web/test/vault/linking.test.ts` and `email-login.test.ts`), an active
member its account root's path, a pending member nothing. Linking moves no address: a member opens a path that
already exists. No path layout or derivation input changed in batches 7 and 8b.

Before the freeze, anything that changes an address must be called out (CLAUDE.md); after it, never. A scheme change
would be `hana-id/chain-keys/v2/extract`, opt-in, with v1 still derivable.

### WebCrypto on the login, export and signing paths

No address goes through WebCrypto: CKD (BLS12-381), the HKDF of the chain keys, the Stellar (Ed25519) and EVM
(secp256k1) keys and their signatures are `@noble/curves` and `@noble/hashes` (`ckd.ts`, `derivation.ts`,
`signers/`). WebCrypto holds the session key and the symmetric keys around it. Audited on 2026-11-05 (D385) in
Playwright 1.64.1's browsers on macOS and in its Linux image (WebKit 27.2, Chromium 156, Firefox 157), with
thousands of random keys per call and fixed keys starting with zero bytes; `apps/e2e/tests/webcrypto.spec.ts` keeps
the fixed-key checks on every browser CI runs.

| Call | Where | Key | Linux WebKit |
|---|---|---|---|
| Ed25519 `generateKey` (non-extractable), `exportKey('raw')` of its public half | `core/session.ts` `newSessionKey` | fresh random | refuses the keys whose seed or public key starts with `0x00` (`OperationError`, about 1 in 128): retried, up to 4 attempts (D381); a key it still can't make is `derive_failed`, `webcrypto_failed` / `webcrypto_unsupported` (D385) |
| Ed25519 `sign` | `core/session.ts`, `core/wallet-record.ts`, `web/vault/identity.ts` | the session key (also restored from IndexedDB) | fine |
| Ed25519 `importKey('raw')` public, `verify` | `core/session.ts` `verifyEd25519` (the e2e stack's mock API; not called in a browser) | given | fine, including public keys starting with `0x00` or `0x0000` |
| AES-256-GCM `importKey('raw')`, `encrypt`, `decrypt` | `core/relay.ts` (relay keys), `web/vault/record.ts` (K_s) | random (relay keys), the server-held share (K_s) | fine, including keys starting with zero bytes and the all-zero key |
| HKDF-SHA-256 `importKey('raw')`, `deriveKey` to AES-GCM | `web/vault/record.ts` `consentKey` | the PRK (derived) | fine, same bytes as Node |
| RSASSA-PKCS1-v1_5 `importKey('jwk')`, `verify` | `core/id-token.ts`, `core/email-token.ts` | Google's and the email issuer's keys | fine |

Linux WebKit also refuses a PKCS#8 import (`DataError`) of an Ed25519 or X25519 private key whose first byte is
`0x00`, and X25519 `generateKey` the same way as Ed25519's; Hana makes neither call (a JWK import of the same key
works). Safari on Apple platforms signs Ed25519 with a random nonce (valid signatures that differ from RFC 8032's
deterministic ones); nothing in Hana depends on a session signature's bytes.

## Data stores

| Store | Holds | Never holds |
|---|---|---|
| `hana-signer` state (public) | Config (owner, mpc, domain, sponsors, console audiences, shared clients, change delay), issuers and Google RSA public keys, scopes (owners, clients, pending changes, `action_nonce`), client index, quarantine / retired-client records, sessions (`path`, `scope_id`, `expires_at_ms`, `max_uses`, `used`), revoke tombstones, expiry FIFO | Keys, S, PRK |
| NEAR transaction args (public forever) | Google ID tokens used in `create_session*`, register proofs, owner tokens; session signatures; BLS `pk1`/`pk2`; MPC responses (encrypted to `a`) | Anything usable without the session key or `a` |
| D1 `DB` | `plans`, `hana_held_clients` (H2, the Google clients Hana holds for a scope), `scopes` (org, environment, `first_session_at`, `home_quiet`), `apps` (`first_login_at`, 0016; + 0003 settings: `persistence`, `session_ttl_ms`, `idle_ttl_ms`, `raw_sign*`, `auto_approve_*`, `google_web_client_id`; + 0006: `org_id`, `suspended_by`, the two versions, `logo_key`, `deleted_at`), `app_keys` (publishable keys, public), `app_origins` (+ `active_from`, `change_id`), `guarded_changes`, `app_changes` (append-only ledger of every app write, actors as staff ids or `cli:<login>`), `security_events`, `org_security_contacts` (staff-set emails; none yet), `session_markers` (the first session-pool relay per app, the waiver's sign), the legacy `usage` (`sessions`, `derives`, `unlocks` per app per UTC day; not written since batch C4), `issuer_key_missing`, `vault_shares` (`share_enc` under `VAULT_KEK`, `session_pk`, `path_hash`, `partner_origin`, counter, times, `device_label`), `vault_consents` (0017: auto-approve consents, narrow-only), `identity_issuance_hourly` (tokens per signing key and hour), `identity_usage` (tokens per app and day); with migration 0011 (branch `feat/wallet-directory`), the wallet directory: `end_users` (internal id `hu_…` from the uid, User ID `token_sub` = the identity token's `sub`, Support code, scope, created, last seen; D346), `end_user_wallets` (chain, address, key index, first seen, last used), `end_user_identities` (scope, identity key, user, provider, `sub`, role, status, `effective_at`, times): personal data, read by staff (`AdminRpc`, the CLI) and, without internal ids, subs or keys, by partners for their own scopes (`ConsoleRpc`); with migration 0013 (D428, D430), `apps.mainnet_demo` (staff's switch) and `user_events` (`key_exported` with the internal id, `mainnet_signature` with the wallet address, chain, network, USD value and time; staff only; kept 24 months and erased with the user, D433); with migration 0014 (D411, D439): `apps.identity_email` and `email_consents` (app, User ID, the address's MAC under `EMAIL_CONSENT_KEY`, `granted`/`declined`, and the address itself only while granted: the copy the partner console shows; deleted by `uid-erase` and 30 days after the app's deletion) | Plaintext `K_s`, tokens, signatures, identity tokens, `sid`, a sealed address, an address the user didn't share; before 0011 also no `sub`, user id or address (only `sha256(path)`) |
| D1 `CONSOLE_DB` (console Worker only; batches C7 and C9) | Orgs, console users (Google `sub` in clear: it must equal the on-chain owner; the email lowercased, display only, refreshed at each sign-in), members and roles, invites (the invitee's address, 90 days after the invite ends), owner grants, console sessions (2 h idle, 12 h absolute; /24 or /48 network data), auth flows (5 min; the PKCE verifier overwritten once used, the invitee's address as `login_hint`), handoff codes (the verified `{provider, sub, email, hd}` for ≤ 60 s, overwritten once used), pending step-up actions, logo objects, `audit_log` (append-only, 5 years) | Invite, cancel-link, session, flow-cookie or handoff tokens (only their sha256), Google ID or access tokens, the client secret, link keys, any hot-DB app config (which app belongs to which org lives only in the hot DB); no invitee address in `audit_log` (a refused sign-in of someone with no account: the address's sha256 only) |
| R2 `LOGOS` (`files.logosBucket`; batch C11, not created yet) | App logos at `logos/<app id>/<sha256 hex>.png`: 256 × 256 PNGs the console re-encoded, with no metadata chunk; replaced ones until the console's cron deletes them 30 days on | The uploaded original, EXIF, text or ICC chunks, anything not re-encoded |
| Usage ledger (Neon, `usage` and `ops` schemas) | Per request past the gate, and per Hana Home derive that reached the relay (no app, no uid; H11): request id, time, org, app, scope, endpoint, outcome, code, status, latency, relayed, transaction, relayer key and nonce, provisional gas, and on ok login/session/derive the uid (`HMAC(USER_ID_KEY, scope ‖ provider ‖ sub)[0..16]`, a pseudonym, D96); `app_users` (first and last day per uid); identity tokens per app and day; (C12) settlements (billed gas or why not), daily NEAR/USD rates and their override history, frozen statements (hashes and totals; the files in R2 `STATEMENTS`), the admin's nonce checks, rejection and settlement alerts | A sub, JWT, email, IP, session key, share id or path |
| Email issuer D1 (`emailIssuer.cloudflare.d1Name`, the issuer's own; `apps/email-issuer/migrations`) | 0001: `email_issuance` (jti, app, purpose, kid, iat), `email_hints` (scope, email `sub`, Google `sub`, hosted, time), `email_suppressions` (an HMAC of the address), `email_admin_audit` (staff, action, ticket, key prefix or scope). 0002, **the user directory** (D269, `src/directory.ts`): `user_emails` (provider, `sub` as on chain, the verified address in clear: email the normalized login address, Google userinfo's lowercased; `email_verified`, `hosted`, first and last seen; one row per identity: the address, `email_verified` and `hosted` of the write with the newest time, so a write landing late never restores an older one; first seen the earliest, last seen the latest) and `user_email_apps` (provider, `sub`, app, scope, first and last seen; the scope likewise the newest write's). Written best effort after the answer (`waitUntil`; a failure logs `directory_write_failed` with the app and scope only and never fails or slows the login) at every 200 of email `verify` (session, case B, the link purposes, auto_link); and for Google identities at google-match once its checks pass (whatever the decision) and at google-record (D270's `'token_first'`, an app without email login; built, the flow off): userinfo's address, lowercased. A Google row with `email_verified = 0` is only that account's claim to the address. Anyone can make google-record or google-match write rows for their own Google account and any active app, including one it never logged in to (`Origin` is forgeable server to server; accepted, D269: matching and linking read `email_hints`, never the directory, so only the staff view's accuracy suffers). Read only by Hana staff: `admin <env> user:list` / `user:find` (`scripts/lib/admin-users.ts`, `scripts/lib/d1.ts` `issuerD1Execute`: the local D1 through wrangler with the statement in a 0600 `--file` under `.secrets/tmp/`, the remote one through D1's REST API, never the statement in a process argument; wrangler's log file off; unverified Google rows listed apart under an UNVERIFIED warning, never as the owner). 0003 (C8b, D392): `email_admin_audit` rebuilt with every row (the directory reads `user_search`, `user_view`, C15's `support_lookup`; the ticket column optional on a search only, though DirectoryRpc requires it for a search by sub or full address, D410; a `detail` JSON, never an address). The admin console's Users screen reads the directory through the issuer's `DirectoryRpc` (each read audited in its batch, a per-staff row budget). The API, the SDK and the partner console read nothing from this D1 | Codes, tokens, keys; an address anywhere but `user_emails` |
| Retention (D90; batch C13, built on `feat/batch-c-13`, not deployed) | What goes when: ledger uids after the month + 24 months (rows kept), `app_users` 24 months after last seen or 30 days after the app's deletion, whole months of events, settlements and day counts after 7 years (statements and rates counted for a person to delete); `app_changes`, `guarded_changes`, `audit_log`, owner grants after 60 months, keeping what drift detection reads (D364); the wallet directory of a scope whose apps were all deleted 30 days ago (D363); `user_events` (key exports, mainnet demo signatures) after 24 months or with their scope's directory (D433); the issuer directory's app rows of deleted apps and its staff audit by `admin retention:issuer` (D365). An erasure request: `uid-erase`, per scope, across the ledger, the wallet directory (with the user's `user_events`, by internal id and by each wallet address, D433) and the issuer directory, the account read from the chain, recorded in `ops.erasures` without whom (D361). Neither touches the chain: identities, accounts and paths stay, so wallets are unchanged (D366) | — |
| `RelayerKey` DO storage | Per key: `publicKey`, nonce reservation, last block hash and time | Secret keys (they are Worker secrets) |
| `RateLimiter` DO storage | `<window>@<start>` counters; `mark:<sha256(owner token)>` single-use markers until the token's `exp`; `mark:<sha256(identity proof signature)>` until the proof's `issuedAtMs` + 120 s | Tokens |
| `LoginRelay` DO storage | One slot: `{iv, ct}` for ≤ 120 s, then a tombstone for 120 s | Plaintext tokens (the API has no `relayKey`) |
| Per-isolate memory (API) | JWKS (≤ max-age, stale ≤ 6 h on fetch failure), config / scope / client views (≤ 60 s; "no scope" ≤ 10 s), sessions (≤ 10 s), parsed KEKs, counter holds | — |
| Browser, `vaultOrigin` | IndexedDB `hana-vault` records (partitioned by top-level site; format 2 adds the identity wallet proofs); memory: session key, PRK, consent and counters, the current identity token | S, `a` (memory only, dropped), plaintext PRK on disk, an identity token on disk |
| Browser, `authOrigin` | `sessionStorage` `hana.login.<relayId>` = `{v, createdAt, relayKey}` (≤ 10 min, single use), in a login that carries the follow-up key also `followKey` and the next leg's facts (the Google client, the `login_hint`, under `'token_first'` the login's nonce: `auth/login-storage.ts`) | Tokens (token_first's access token goes to slot 1 before Google's next page, never into storage) |
| `.secrets/<env>/` (operator machine, gitignored, 0700/0600) | `relayer-keys.json`, `owner-relayer-keys.json`, `keys-updater.json` (`scripts/lib/secrets.ts:66`), `vault-kek` (+ `vault-kek.previous` during a rotation; `scripts/lib/vault-kek.ts`), `identity-signing-key.json` (active), `identity-signing-key-standby.json` (published, never uploaded; keep it offline), `-next.json` / `-previous.json` during a rotation, `identity-slots.json`, `identity-sub-key` (`scripts/lib/identity-key.ts`, D177), `neon.json` (the ledger owner's URLs, the Neon project and branch ids), `neon-usage-writer.url`, `neon-usage-admin.url` (passwords Neon generated, D403), `neon-api-key` (a project-scoped Neon API key, only while `usage-setup <env> roles` runs; revoked after), `user-id-key` (`scripts/lib/usage-setup.ts`, D224) | — |
| `~/.near-credentials/testnet/` (operator machine) | Full-access keys of the owner, signer and relayer accounts (`scripts/lib/keys.ts`) | — |
| Worker secrets | `RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`, `VAULT_KEK`, `VAULT_KEK_PREVIOUS`, `IDENTITY_SIGNING_KEY` / `IDENTITY_SIGNING_KEY_STANDBY` (two slots: the active identity key, and during a switch the incoming one), `IDENTITY_SUB_KEY` | — |
| Watchdog D1 (its own Cloudflare account) | `meta` (last chain snapshot with the email issuer and policy, failure counters, heartbeat, digest, run lock, the last relayer funds reading, the email policy verdict, the last link stats), `seen_kids` (kid, `n`, `e`, first/last seen; `baseline` kids from the first run), `absences`, `runs` (30 days), `actions` (method, args, tx hash), `alerts` (severity, details, acks), `deliveries` | Secrets, tokens |
| Watchdog Worker secrets | `WATCHDOG_KEY`, `WATCHDOG_STATUS_TOKEN`, `SENDGRID_API_KEY` (its own, D401), `SLACK_WEBHOOK_URL`, the paging app's credentials, `HEARTBEAT_URL` (from `.secrets/<env>/watchdog-secrets.json`) | — |
| `apps/api/.dev.vars` (local, gitignored, 0600) | Relayer and updater keys and the identity token's secrets for `wrangler dev` (`gen-wrangler --dev-vars`) | — |
| Partner backends | Identity tokens they received (≤ 1 h each), and whatever they keep from them (`sub`, `sid`, addresses) | Anything that reaches a key |

## Environments and manifests

- One manifest per env, `envs/<env>.json`, validated by `packages/env/src/schema.ts` (zod) and loaded with `loadEnv`.
  Only `sandbox-dev` exists. `network` accepts only `testnet`. Every account name the code uses comes from here
  (`signer`, `relayer`, `owner`, `mpc`); code reads it via generated config, never by hard-coding names.
- Other fields: `ckdDomainId`, `ckdNetworkKey` (pinned with `scripts/fetch-ckd-key.ts`), `rpc`, optional
  `rpcFallback` (https, not `rpc`, another registrable domain outside `local*`, required with `emailIssuer` outside
  `local*`; the vault's and the export window's second NEAR RPC, in their CSP, and the Workers'
  `NEAR_RPC_FALLBACK`; a member's path is confirmed on both, D263), optional `apiRpcFallbacks` (the API's own
  failover list after `rpc`, 1–3 https URLs, else `rpcFallback` alone; `NEAR_RPC_FALLBACKS`, D435), `apiUrl`,
  `vaultOrigin`/`authOrigin` (both or neither; bare origins; `https`; loopback only in `local*` envs; otherwise a real
  DNS name, never an IP, a bare public suffix, a single label or a trailing dot; different origins, neither
  `apiUrl`'s origin; different sites from each other and from `apiUrl` outside `local*`/`sandbox*`,
  `packages/env/src/schema.ts`, `origins.ts`), `changeDelayMs`,
  `googleClientIds` (the `global` scope), `sharedGoogleClientIds` (≤ 5, disjoint from scope clients),
  `consoleAudiences`, `cloudflare.{workerName, d1Name, durableObjectLocation}`, and the optional `watchdog` block
  (`account`, `cloudflare.{accountId, workerName, d1Name}`, `alertEmails`, `alertFrom`, `pager`, `digestHourUtc`;
  `apps/watchdog/scripts/gen-wrangler.ts` writes the gitignored `apps/watchdog/wrangler.jsonc` with that account id).
- Dev envs are `local*`/`sandbox*` by name (`packages/env/src/origins.ts:9`, mirrored in `apps/api/src/origins.ts:26`
  and as `devEnv` in the web build). They allow loopback partner origins and partner-origin session endpoints for
  `pk_test_` keys, and same-site Hana origins. No flag can turn these on elsewhere.
- `apps/api/scripts/gen-wrangler.ts` writes `apps/api/wrangler.jsonc` (vars from the manifest, D1 binding, DO bindings
  and migrations `v1` RelayerKey/RateLimiter, `v2` LoginRelay, the vault's two `ratelimits` bindings, the 15-min cron whose :00 run is the hourly one) and, with `--dev-vars`, `.dev.vars` from
  `.secrets/<env>/`, plus the page Workers' `wrangler.vault.jsonc` / `wrangler.auth.jsonc`. It refuses an env without
  both Hana origins. All three are per env and gitignored (the deployed D1 id is passed with `--d1-id` and never
  committed); the API tests generate their own `wrangler.vitest.jsonc` from a fixed test manifest.
- The build id (D384, D406, `packages/env/src/build-id.ts`): every Worker's `deploy` script (API, page Workers, email
  issuer, console, console-auth, files, admin, watchdog) runs the one wrapper `packages/env/src/stamped-deploy.ts`,
  which passes `HANA_BUILD` = the commit's first 12 hex characters (`-dirty` for a tree with uncommitted changes), never
  `gen`; the web build writes the same id into `/vault.js`'s first line and each auth page's `<meta name="hana-build">`,
  the console's `vite build` into its `index.html`. They are read back from `GET /v1/health`, `GET /v1/email/health`,
  `/.well-known/hana-build` on each page origin, the console, console-auth and files origins, and the bundles; the
  admin's (behind Access) and the watchdog's (behind its token, on its own account: `--only watchdog`) from the
  deployed version's metadata with wrangler. `scripts/deploy-check.ts` fails unless every piece (and, with `--d1`,
  every D1 migration) is this checkout's (`docs/operations.md` "Checking a deploy").
- `packages/web/scripts/gen-envs.ts` writes the gitignored `packages/web/src/envs.generated.ts` with the pinned
  per-env constants (`signer`, `relayer`, `rpc`, `rpcFallback` when set, `ckdNetworkKey`, origins, `devEnv`) for every
  manifest with both origins; it fails on an unusable CKD key.
- Runtime flags, `"0"` everywhere for now (`FLAG_DEFAULTS`, `gen-wrangler.ts`): `BLS_PRECHECK` (Workers Paid plan
  only, D64). The claim allow-list has no flag: `REJECT_PII_ON_SESSIONS` is retired and a leftover var is ignored
  (D271).
- sandbox-dev runs on `*.tingtc.workers.dev` (personal Cloudflare account, free plan); its move to a company account
  on Custom Domains is decided, not done (D404, `docs/operations.md` "Moving an env to another Cloudflare account"). A
  Worker is on its own `workers.dev` URL when its origin is one (dev envs only), else on a Custom Domain of its
  account's zone; `cloudflare.accountId` pins the account in every generated config. Production env and a Hana
  domain are deferred (`docs/decisions.md` D18; two registrable domains, D38). Its manifest has the dashboard blocks
  (`console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs`, for milestone M4; `hana-id-<x>-sandbox-dev`
  Workers, set up on the personal account until the move, D414), with the Access application still a placeholder
  (`admin.accessAud` `UNSET`: the admin Worker and the issuer's `DirectoryRpc` refuse every staff call). Regenerated
  with them, the API's `REFUSED_ORIGINS` lists all seven Hana origins, and the API and the auth page Worker get
  `FILES_ORIGIN` (logo pages' `img-src`); until a console stores a logo (`apps.logo_key`), `logoUrl` stays null and no
  page loads anything from it. Since the admin block exists, `admin.ts app:changes:announce` refuses sandbox-dev: staff
  proposals wait for the admin Worker's notices (M4).

## Relayer design

- **Two pools** of function-call keys on the relayer account, receiver = signer, in `apps/api/src/relayer-config.ts:15`
  and `scripts/lib/contract.ts`: session pool (`RELAYER_KEYS`, default 3 keys × 2 NEAR allowance:
  `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session` and the link methods) and owner pool
  (`OWNER_RELAYER_KEYS`, default 1 key × 0.5 NEAR: `propose_change`, `cancel_change`, `remove_client`,
  `disable_shared_login`, `execute_change`); each holds only what an endpoint relays (D456). Abuse of `/v1/owner-actions`
  can only drain the owner pool. The session list is batch B allowlist state 1; state 2 or 3 follows the ship gate
  (each change swaps every session-pool key in one transaction, D456's note). `deploy-contract` replaces a key with
  another receiver, other or empty methods or an unlimited or too-large allowance, and treats a full-access key as a
  blocker.
- **Dispatch**: `relay()` picks a key round-robin per pool from a random start per isolate, except for a
  session-signed request: an HMAC of its session key under the pool's secret selects the key (`claimKeyIndex`, D455's
  note), so every copy of a request reaches one object from any isolate, and that object relays one of them (`RelayerKey`
  `claims`, D455). If the relay did not execute on that key it tries the next key once, with the same claim (D455's
  note: `relay()` `NOT_EXECUTED_ON_KEY`). The method is checked against the pool in the Worker and again in the object.
  Gas comes only from `apps/api/src/gas.ts` (per method, `GAS_<METHOD>_TGAS` overrides), never from the caller.
- **One `RelayerKey` DO per key** (`relayer-key-<i>`, `owner-relayer-key-<i>`). A critical section takes the next nonce,
  signs and starts `send_tx` without waiting for it (`relayer-key.ts:233`); outcomes are awaited outside it, so many
  transactions per key are in flight.
- **Nonce reservation in blocks of 100** (`NONCE_RESERVATION`, `relayer-key.ts:45`): storage holds R, "no tx of this
  key was sent with a nonce above R". A nonce above R is sent only after R' = n + 99 is written and
  `storage.sync()` resolved (`relayer-key.ts:335`). One confirmed write per 100 relays; a restart skips ≤ 99 nonces,
  which NEAR allows.
- **Cold start** (`relayer-key.ts:279`): with a stored reservation for this public key, start from it and reuse the
  stored block hash while under 5 min old, with no chain read. Only without one (new or replaced key) read the access
  key nonce and a final block. A key used elsewhere shows up as `InvalidNonce`: re-read and retry once.
- **Outcome**: `send_tx` with `wait_until: EXECUTED_OPTIMISTIC` (`apps/api/src/near/rpc.ts:75`), then polling `tx`.
  Dropped (a later nonce landed first) → resend once with a fresh nonce. Errors that certainly did not execute
  (`method_not_allowed`, `relayer_unconfigured`, `near_unavailable`, `near_rejected`, `relayer_busy`) are safe to
  resend; anything else carries `nearTx` for the caller to poll.
- **NEAR meta-transaction relay** (D730–D739, testnet only, not deployed; `docs/api.md` "NEAR relay"): a Hana user's
  NEAR implicit account (zero NEAR) acts through NEP-366. The SDK sends `POST /v1/near/activate` (a 0-yocto Transfer
  creates the account) and `POST /v1/near/relay` (the user's `SignedDelegateAction`) from the partner's page through
  the app gate (no session required, D735); the API
  decodes and checks the delegate (`apps/api/src/near/delegate.ts`: zero-deposit FunctionCalls to
  `near.relay.receivers` only, since the relayer pays every inner deposit and all the gas), reads the chain, counts the
  limits and the daily NEAR budget, and relays through `near-relay-key-<i>`: the same `RelayerKey` class and nonce
  machinery, with full-access keys (`NEAR_RELAY_KEYS`) of a separate account, `near.relay.account`, because a
  function-call key can't sign a `Delegate` action. The pools and their account are untouched by it.
- **Location**: `DO_LOCATION_HINT` (manifest `cloudflare.durableObjectLocation`, sandbox-dev `apac`) pins relayer key
  objects, per-app limiters and owner-action limiters, with the region in the object name
  (`apps/api/src/placement.ts:20`). Per-IP limiters and `LoginRelay` objects are created near their caller. The
  vault's per-IP and per-share limits are Rate Limiting bindings, counted where the Worker runs (D95).
- **Request log** (`done`, `handlers.ts`): per-stage timings (`app`, `limits`, `checks`, `relay`, `relayQueue`,
  `relayChainRead`, `relaySign`, `relayPersist`, `relayOutcome`; the vault endpoints add `settings`, `session`,
  `insert`, `share`, `advance`), `colo`, `relayInstance` (cold, chain read, block refresh). Never
  tokens, signatures, bodies, keys or CKD responses. A `pk_test_` app's `/v1/login`, `/v1/vault/shares` and
  `/v1/vault/unlock` also return the total and phases as `timings` (`docs/api.md` "Timings"), which the vault adds to
  the per-stage timings it reports to the partner client (`packages/core/src/timings.ts`).

## Glossary

| Term | Meaning |
|---|---|
| scope | A partner's on-chain namespace (`s1`, `s2`, …; `global` is Hana's). Part of every path, so two scopes never share a key |
| client | A `(provider, aud)` pair, e.g. `("google", "<id>.apps.googleusercontent.com")`. A scope's own clients resolve to it only |
| shared client | One of Hana's Google clients (`sharedGoogleClientIds`, ≤ 5), not tied to a scope; the scope comes from the session nonce and must have `allow_shared` |
| session key | Ed25519 key made in the browser (non-extractable WebCrypto). The ID token's nonce commits to it; it signs derives, revokes and vault messages |
| counter | Per-session request counter; each signed derive or revoke must carry `used + 1`. Vault shares have their own counter |
| `key_index` | Last path component, `u32 < 2^31`; 0 in the MVP; a new index is a new wallet (rotation hook) |
| CKD | NEAR MPC Confidential Key Derivation: the MPC returns a per-`app_id` BLS secret encrypted to the caller's ephemeral key `a` |
| `app_id` (CKD) | `SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ signer ‖ "," ‖ path)`. Not the D1 `apps.id` (which the vault message uses) |
| S | The 48-byte CKD secret after decryption and the pairing check; IKM of derivation v1; zeroed at once |
| PRK | `HKDF-Extract(salt "hana-id/chain-keys/v1/extract", S)`, 32 bytes; every v1 chain key comes from it |
| K_s | 32-byte AES-GCM key per vault share; server-held (wrapped by `VAULT_KEK`), returned on unlock; encrypts PRK in the browser record |
| `VAULT_KEK` | Worker secret that wraps every `K_s` in D1 |
| `relayKey` / `relayReadKey` | Per-login AES key for the token relay (vault and login popup) / read capability (vault only); `relayId = b64url(sha256(relayReadKey))` |
| `policyId` | `sha256("hana-id/auto-approve/v1" ‖ canonical JSON of the normalized policy)`; a user's consent is bound to it |
| ProtocolDecoder | Interface in `packages/core/src/policy/decoders.ts` that turns a call with opaque bytes into effects (recipients, targets, tokens); registry empty in batch B |
| `vaultOrigin` / `authOrigin` | Hana's two page origins: the key-holding iframe, and the login/approval/export pages Google redirects to |
| publishable key | `pk_test_…` / `pk_live_…`, public, identifies an app in D1; a test key never shares a scope with a live key |
| sponsor | Account the contract pays storage for (the relayer) |
| ship gate | If `create_session_and_derive` saves < 1.5 s median over 10 testnet runs, it is removed before the audit |
| identity token | An ES256 JWT (≤ 1 h, `typ: hana-identity+jwt`) for a partner's backend: `sub`, `sid`, proven `wallets`, `login_methods`; minted by the API for the vault's live session |
| `sub` (identity token) | `u1_` + HMAC-SHA256(`IDENTITY_SUB_KEY`, scope ‖ root provider ‖ root sub)[0..16]: per scope and account, never the Google `sub` |
| `sid` | `s1_` + HMAC-SHA256(`IDENTITY_SUB_KEY`, app id ‖ session key)[0..16]: one per session, new at each interactive login |
| wallet proof | A signature by an address's own key over the identity wallet message, bound to the session key and app |
| wallet record | A signature by an address's own key over the `hana-id/wallet-record/v1` statement (env, signer, app, scope, path, chain, address, session key, time), plus the session key's signature over the whole request (`hana-id/wallet-record-session/v1`): what the API stores an address for a user on (D311) |
| User ID | The identity token's `sub` (`u1_…`): the one id partners see for a user, in the token and the partner console (D346) |
| internal id | `hu_` + Crockford base32 of the uid (`HMAC(USER_ID_KEY, scope ‖ root provider ‖ root sub)[0..16]`): the wallet directory's key and the ledger's pseudonym, staff only (D312, D346) |
| Support ID | `HANA-XXXX-XXXX`: Crockford base32 of the first 5 bytes (40 bits) of the User ID's 16 HMAC bytes, its short form (D276 as amended by D346) |
