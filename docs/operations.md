# Operations runbook — running a Hana ID environment (testnet only)

Last verified against code: 2026-11-06 (branch `fix/watchdog-new-key-grace`: "Watchdog alerts (runbook)"'s `unseen_key_change` and `forged_key_change`, D432); 2026-11-06 (branch `feat/user-events-retention`: "Retention"'s `user_events` (24 months, the monthly job's `user_events` step, `uid-erase`'s events by internal id and address) and the mainnet demo section's erasure note, D433); 2026-11-06 (branch `feat/mainnet-demo-key-export`: "Mainnet demo and key export events (hot-DB migration 0013, D428–D430)": applying 0013, turning the demo on and off (`app:settings --mainnet-demo`, the admin console), the cap and the price table's expiry, seeing key exports and demo signatures, `user_events` outside the erasure path for now); 2026-11-06 (branch `fix/verify-e2e-after-sandbox`: "CI and git": Playwright runs after the sandbox e2e, D423 amended); 2026-11-06 (branch `feat/partner-friction-fixes`: "Common failures"' `vault_unavailable` row, `no_answer`'s time and `data.origin`, D427); 2026-11-06 (branch `feat/admin-system-status`: "Admin Worker" → "System status (D425)": what the landing page checks, the deploy order (console migration 0003, the API, console, issuer and watchdog before the admin, `gen` for the new vars), reading it, its call budget; "The crons' call budget": the 15-minute run's record costs no call); 2026-11-06 (branch `chore/verify-parallel`: "CI and git": verify's lanes and four phases, the sandbox e2e 8 tests at a time and its isolation, the summary's start column and totals, the timings; D423); 2026-11-06 (branch `fix/google-key-hysteresis`: "Google signing keys (JWKS)": three fetches a run, removal after 24 h missing and never with a token in the last 24 h; the watchdog alerts table (`retired_key_change` only for a provably retired kid, `stale_active_key` after 27 h); "Watchdog service" migration 0002 and API migration 0012 apply steps; the restore notes' 24-h timer; D422); 2026-11-06 (branch `feat/admin-ux-redesign`: "Reports and statements" wording of the admin console's Rates and Statements screens, D420); 2026-11-06 (branch `feat/env-alert-label`: "Watchdog service" and "Admin Worker": the env label first in every alert title and email subject on a non-production env, `ENV_LABEL` from `gen`, D419); 2026-11-06 (branch `fix/admin-fetch-strictly-public`: "Watchdog status for the admin portal": the admin reaches the watchdog over the public internet, error 1042 / `watchdog_bad_answer` on a shared account); 2026-11-06 (branch `fix/hyperdrive-account-id-hint`: "What sandbox-dev runs at M4" (new: every M4 piece, its names and account), the console, Users screen and reports deployed on sandbox-dev, `watchdog.url` set); 2026-11-06 (branch `fix/hyperdrive-account-id-hint`: "Usage capture" step 3 passes `--account-id`, a Hyperdrive-only token lists no account); 2026-11-06 (branch `docs/personal-account-free-tier`: "Admin Worker" → never past a free tier on the personal account: what could bill, what needs the user first, R2 kept small, the monthly check, D417); 2026-11-06 (branch `feat/console-remove-audience`: "Console sink scope": retiring a console client (the new one beside the old, delete the old in Google Cloud, drop it from the manifest, `admin console:remove-audience`, `deploy-contract`), sandbox-dev's `…j6l32…` → `…rs47…`; the admin command list and the owner-actions table; D416); 2026-11-06 (branch `docs/sandbox-sendgrid-one-account`: "Admin Worker" step 2, sandbox-dev's three SendGrid keys in one account without subusers, their shared suppression lists, D414 as amended); 2026-11-05 (branch `feat/m4-personal-account`: sandbox-dev's M4 on the personal account until the move, in "Admin Worker" (its intro and step 1's sandbox-dev team `bitter-hill-fe6f`, the placeholders `access-setup --write-manifest` replaces), "Users screen (C8b)" and "Moving an env to another Cloudflare account"; `env-secrets` uploads the SendGrid keys (`admin-sendgrid-key`, the watchdog's `SENDGRID_API_KEY`); D414); 2026-11-05 (branch `fix/sendgrid-suppression`: "Admin Worker" step 2 and "Watchdog service" step 3: 202 is not delivery, alerts and blocking notices bypass SendGrid's suppression lists, check the first in Activity; D401 as amended); 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: SendGrid for every Hana email, D401: "Admin Worker" steps 1–3 (sandbox-dev's Access policy, the admin's SendGrid key, its secret), its "What to watch" rows, "Watchdog service" step 3 and its key's rotation (`SENDGRID_API_KEY`), the secrets table; "Files Worker and logos" step 2's lock per env, D402; "Plan limits on sandbox-dev" under "Admin Worker"); 2026-11-05 (branch `feat/local-verify`: "CI and git": the local gate `pnpm verify` (`--quick`, default, `--full`; the affected packages, the order, the timings), what runs before a merge into `develop` and before a deploy, the optional pre-push hook `pnpm verify:install-hook`, D413); 2026-11-05 (branch `fix/security-review-1105`: "Users screen (C8b)": the ticket for a search by sub or full address and for a wallet-directory find (audited first, `users.find`), the detail at `/users/open` from memory, the check updated; "Support ID lookup": the audit's request IDs, "Wallet directory only" with the ticket; "Usage capture" step 2's NOLOGIN after a failed reset and step 3's Hyperdrive configs through Cloudflare's API with `.secrets/<env>/cloudflare-hyperdrive-token`; the secrets table's row; D410, D412); 2026-11-05 (branch `feat/account-migration`: "Moving an env to another Cloudflare account" (new: the order, the commands, `env-secrets`, `d1-move`, `admin issuer:iss`, what users see, Neon and Google Cloud notes, the testnet move pending), the manifest's `cloudflare.accountId` and custom-domain placements in "Accounts and services per environment", "Email issuer" step 7's Custom Domain, the hosted demo's `HANA_DEMO_ORIGIN`, the admin command list, the secrets table's D1 exports and API tokens; D404); 2026-11-05 (branch `feat/deploy-check-all-workers`: "Checking a deploy" (every Worker through its `run deploy`, the shared wrapper; the console, console-auth, files Workers and the console SPA read over HTTP, the admin and watchdog through wrangler, `--only`/`--skip`, the console and watchdog D1 in `--d1`), the console, admin, files and watchdog deploy lines now `run deploy`, with `deploy-check` after each, D406); 2026-11-05 (branch `fix/usage-setup-throwaway-password`: "Usage capture" step 3's throwaway password before Neon's reset, D403 amended); 2026-11-05 (branch `feat/access-setup`: "Admin Worker" step 1: the admin console's Cloudflare Access by `access-setup <env>` (the team and login methods in the dashboard, the least-privilege token, created and revoked, plan / `--yes` / `--write-manifest` / `--check`), sandbox* Google exact emails only and the free-tier guard it enforces (D408), the workers.dev hostname application against the dashboard toggle, the dashboard path; the secrets table's Cloudflare API token row; the issuer's "Open for batch 8" note; D409); 2026-11-05 (branch `feat/sdk-error-request-id`: "Support ID lookup": partners' request IDs come from the SDK's errors and the demo's diagnostics, D405); 2026-11-05 (branch `docs/zero-trust-free-guard`: "Admin Worker" step 1's Zero Trust free-tier guard, D408); 2026-11-05 (branch `fix/usage-setup-neon-api-passwords`: "Usage capture" steps 2, 3 and 8: `usage-setup <env> roles` gives LOGIN by SQL and has Neon's API reset each role's password with the new `.secrets/<env>/neon-api-key` (how to create, save and revoke it), every run replaces the role files, Hyperdrive configs from older files re-created, the step-8 gate without the SCRAM question; the secrets table's Neon API key row; D403); 2026-11-05 (branch `feat/batch-c-15-screen`: "Support ID lookup" → "In the admin console" (the screen, the email join, the ticket rule, what to watch) and "Users screen (C8b)" (a Support ID goes to the lookup; the check), D399); 2026-11-05 (branch `feat/batch-c-8b`: "Admin Worker" → "Users screen (C8b)": issuer migration 0003, the deploy order issuer → API → admin, the checks and failures, D388–D392; "Retention" and "User directory (D269)" notes); 2026-11-05 (branch `chore/ci-cost`: "CI and git": CI and the identity probe turned off, the local checks, D387); 2026-11-05 (branch `feat/batch-c-15`: "Support ID lookup", `admin <env> support:lookup`, the admin route's audit, D394–D397); 2026-11-05 (branch `feat/coop-canary`: "Before each release: the COOP canary" (`coop-canary`, what a failure means, D386), step 0 of "A release."); 2026-11-05 (branch `fix/webcrypto-linux-webkit`: "Common failures"' `derive_failed` `webcrypto_unsupported` / `webcrypto_failed`, D385); 2026-11-05 (branch `feat/deploy-build-check`: "Checking a deploy (`deploy-check`)", D384:
the build id in every Worker and page bundle, `deploy-check <env> [--d1]` after each deploy step, migrations applied
from a checkout at the deployed commit, the API's raw `wrangler deploy` lines now `run deploy`); 2026-11-05 (branch `fix/deploy-pages-builds`: `deploy:pages` runs the web build first; the 0011 apply note; the rebuilt page versions); 2026-11-05 (branch `chore/ci-cost`: "CI and git": which jobs run when, the nightly WebKit and Firefox run; the identity probe every 3 hours, D383); 2026-11-05 (branch `docs/sandbox-dev-state-1105`: sandbox-dev redeployed at `develop` 8aab09d with the wallet directory: `USER_ID_KEY`, the bookmark, 0011, API 6141ba3d, vault abe7cc61, auth 6b9a4bee, issuer 1542a60c); 2026-11-05 (branch `chore/identity-probe-hourly`: the outside identity-JWKS probe runs hourly, D382); 2026-11-04 (branch `fix/admin-cron-budget`: "Admin Worker" → "The crons' call budget":
what counts, each job's share in both crons, the `budget` log lines; settlement's reads a run; D380); 2026-11-04 (branch `feat/batch-c-13`: "Retention (batch C13, milestone M6)": the Neon
migration 0007, the deploy order, the monthly job in the 15-minute cron, `retention_failed`, `admin retention:issuer`,
`uid-erase` for an erasure request, statements and rates by hand, what to watch; "Usage ledger" lists 0007; D360–D369);
2026-11-04 (branch `feat/batch-c-10`: `at_hash` in the claim allow-list everywhere, D342; the console's C10 vars `NETWORK`, `REFUSED_ORIGINS` and the `USERS_SCREEN` switch, no new secret or setup step); 2026-11-04 (branch `feat/user-id-identity-sub`: "Wallet directory (hot-DB migration 0011)": both keys, the deploy pairing for the session signature, the three ids in `user:*`, the log codes; "Admin CLI"'s `--user`; D346); 2026-11-04 (branch `fix/google-cancel-back-to-chooser`: the "Declined" row of "Turning linking on (batch 8b)", D341); 2026-11-04 (branch `feat/batch-c-12`: "Reports and statements (batch C12, milestone M6)": the
Neon migration 0006, the admin config's buckets and vars, the optional CoinGecko key, the 15-minute cron with the 00:30
UTC daily work, issuing a statement, the rate override, exports, what to watch; "Usage ledger" lists 0006; the admin's
cron triggers; D320–D329); 2026-11-04 (branch `feat/batch-c-14`: "Admin Worker" → "Security & monitoring (batch C14)"
(its setup: `watchdog.url`, the `WATCHDOG_STATUS_TOKEN` admin secret, the deploy order, the check, acknowledging
sandbox-dev's alert #11, the failure codes, rotating the token) and "Pending upgrades page" (the release registry);
the watchdog's step 7 and token rotation; the governance hand-off sections; D330–D338; the feed's first run starting at the current position, D344); 2026-11-04 (branch `feat/wallet-directory`: "Wallet directory (hot-DB migration 0011)":
its prerequisites, the migration and deploy order, reading it with the CLI, its log events; the `user:*` lines in "Admin
CLI" and "User directory (D269)"; D310–D317); 2026-11-04 (branch `feat/batch-c-9`, merged with `develop` @ bd0c9ea: "Partner console
Worker … and console-auth": setup step 11 (the console's Google client, its JSON in `.secrets/<env>/`, the secret
through a pipe), the route on by config, the SPA build in `deploy`, console-auth's `gen` and deploy order, the checks,
taking sign-in down; "Console code-flow spike (open question 1)"; D290–D297); 2026-11-04 (branch `fix/dev-email-limits`:
the email issuer's dev-env limits, D340); 2026-11-04 (branch `feat/batch-c-11`: "Files Worker and logos (batch C11, milestone M5)": setup
step 7's R2 buckets with the `STATEMENTS` lock and the `EXPORTS` lifecycle, the Images binding, the files Worker's
`gen` and deploy, the pages' `FILES_ORIGIN`, the order, the checks; the console section's bucket step and purge order;
D300–D308); 2026-11-04 (branch `feat/batch-c-8`: "Admin Worker (`apps/admin`, batch C8)": its M4 setup (Access, Resend, the link and email secrets, the admin Hyperdrive id), its logs, the end of `app:changes:announce` once it runs; D278–D285); 2026-11-04 (branch `feat/batch-c-6-merge`, batch C6 on current `develop`; built on `feat/batch-c-6`: "Console sink scope (batch C6, milestone M3)" with
the scan fixes (known owner accounts only, `--known-owner`, no removal a run can't follow with the registration), the
console audiences no longer in `global` in the manifest and Google tables, the owner-pool allowance event and
`OWNER_POOL_ALLOWANCE_YOCTO`; D235–D239); 2026-11-04 (branch `feat/batch-c-7-merge`, C7 merged onto `develop`; written on `feat/batch-c-7` 2026-11-02: "Partner console Worker": its setup steps for
milestone M4 (D1, `gen`, migrations, the R2 buckets, deploy order), the hourly cron, StaffRpc, no public route, the
`CONSOLE_DB` restore notes, D240–D244; on the merge branch: the cron-trigger count with the watchdog's, what a missing `OWNER_GRANT_DELAY_MS` refuses); 2026-11-04 (branch `docs/sandbox-dev-state-1104`: sandbox-dev redeployed at f53d63e, API 9fe0343a, issuer b0cb9058 after migration 0002); 2026-11-04 (branch `feat/token-first-on`: "Turning linking on (batch 8b)": the spike
passed, `'token_first'` in force, deploying the switch (the issuer if needed, both page Workers), the check and the
undo; the user directory's google-record rows in force; D270); 2026-11-04 (branch `fix/user-emails-review`: "User directory (D269)": the CLI's
statement off the argv (a 0600 `.secrets/tmp/` file locally, D1's REST API remotely; why not wrangler's
`--remote --file`), unverified Google rows, order-safe writes, google-record after `/v1/login`, what a row proves;
the `admin user:*` failures); 2026-11-04 (branch `feat/google-token-first`: "Turning linking on (batch 8b)"'s spike
paragraph, switching to `'token_first'`, the user directory's Google rows, D270, D273); 2026-11-04 (branch `fix/sessions-allow-list`: the smoke direct page's openid-only sign-in and its redirect URI, `REJECT_PII_ON_SESSIONS` retired, D271); 2026-11-04 (branch `feat/user-emails`: `admin user:list` / `user:find` in "Admin CLI",
"User directory (D269)" under "Email issuer" with applying migration 0002 on sandbox-dev, the runbook's
`directory_write_failed`); 2026-11-04 (branch `feat/spike-leg-e`: "Google's verified email: the spike", leg E and the D270 gate); 2026-11-03 (branch `docs/sandbox-dev-state`: what sandbox-dev runs, per the operator on 2026-11-03: a state note under the hot DB gate, the watchdog's email pins and the email issuer sections); 2026-11-03 (branch `fix/8b-rereview`: "Turning linking on (batch 8b)"'s slow second
provider and watching `path_unconfirmed`, D263); 2026-11-03 (branch `feat/email-login-8b` review fixes: "Turning linking on (batch 8b)"'s
second RPC, the consent screens, the API's and the issuer's redeploys for the new limits, the spike's legs C and D as
a gate, D263–D267; "Logs and latency"'s `google_account_mismatch`); 2026-11-03 (branch `feat/email-login-8b`: "Turning linking on (batch 8b)": what users see
in each case, the sandbox-dev checklist, lifting D248, the email-scope spike; D254–D259); 2026-11-03 (branch `fix/demo-polish`: "Hosted demo"'s vault errors and timings, "Logs
and latency"'s `GET /v1/app` phases, "Common failures"' `vault_unavailable` reasons and the slow `app` stage;
Last verified against code: 2026-11-03 (branch `feat/scope-email-client-tool`: `admin scope:add-email-client` in
"Email login demo on sandbox-dev (batch 8a)" steps 1 and 3, the admin command list and "Email issuer" step 6; D253);
2026-11-02 (branch `feat/email-login-8a`: "Email login demo on sandbox-dev (batch 8a)",
the auth page Worker's `EMAIL_ISSUER_URL`, the local demo on the e2e stack's outbox; D245–D249); 2026-11-02 (branch `feat/email-login-6`, after both batch 6 reviews: "Email login on
sandbox-dev" against the merged develop (0006/0009/0010, `hotDb` 9, C3's step-6 checks, C4's optional capture and its
required marker copy, the pages before the API, the zero-downtime pool switch, the upgrade's `createProof` gate, the
pinned-key check, the 120 s key wait, the expected alerts), the leak runbook's published-key step, the SCRAM gate's
failure step; earlier: "Email login on sandbox-dev (build plan batch 6)", the user's deploy order with the corrections of D234, the issuer on its own URL (D230), migration 0010 beside 0006,
the session pool's link methods, the email clients left for batch 8; branch `feat/batch-c-4`: "Usage capture (batch C4, milestone M2)" (the
setup steps for the user: `usage-setup`, Hyperdrive, `USER_ID_KEY`, migration 0009, `gen --usage-hyperdrive-id`), the
ledger and uid secrets, the waiver's session marker; D220–D224); 2026-11-02 (branch `feat/batch-c-5`: `app:suspend` / `app:resume` refuse a deleted
app; the API's RPC entrypoints need no setup step of their own, D225; branch `feat/identity-token-8`: "Identity token
keys" gains the watchdog pin steps and their deploy order (the `kms-*` commands too); "Identity token: pins and the
JWKS check" with the outside probe; the identity alerts in "Watchdog alerts (runbook)"; D210–D214; branch `feat/email-login-4`: "Email issuer" setup and runbook, the issuer's secrets rows, after the
reviews (Access SameSite=Strict, staff calls, unsuppress, the exact key-leak steps with `put --standby`, the budget
and complaint logs) and the abuse re-check (`init --budget`, mailed unlock and unsuppress, revoke-tickets, the owner
pool, the 503 window of a standby switch, SendGrid's suppression lists); branch `feat/identity-token-7`: "Identity token keys on AWS KMS", the KMS
signer's setup steps, IAM and key policies, alarms, rotations and the planned reconciliation, the `identity-key kms-*`
commands, the AWS access key row in "Secrets: where they live", D215–D219); 2026-11-02 (branch `docs/consistency-pass`: "Watchdog service" channels, "Owner
council" verified on testnet, the `create_session_and_derive` gas pointer); 2026-11-02 (branch `feat/batch-c-3`: "Hot DB migration 0006 and the new gate" (milestone
M1, for the user to run), the admin CLI's `app:*` commands on the 0006 schema with `app:changes:announce`, the demo's
origin add, the D1 restore steps; D205–D209); 2026-11-02 (branch `feat/link-cap`: "Link volume thresholds", D200, and `set_link_thresholds`
through `owner:call`; branch `feat/email-login-5`: the watchdog's email rules, the link alarms and
`unrecorded_wallets` alerts in "Watchdog alerts (runbook)" and "Watchdog service", D190–D193, D200; branch
`feat/email-login-2`: `deploy-contract` refuses a v1 contract, D154; the v2 → v3 upgrade path sandbox-tested,
"Upgrading the governance contract"); 2026-10-30 (branch `fix/watchdog-retired-key-race`: the `retired_key_change` alert, D153;
branch `feat/identity-token-2`: "Identity token keys" rewritten for the
offline standby and `identity-key next / switch / retire` (D177), the identity secrets rows, `gen --dev-vars`;
`feat/identity-token-1`: the identity token secrets, migration 0008; `feat/playbook-gaps`: relayer funds monitoring in the watchdog,
`owner:vote --reject`, `council:replace-member`, the D1 Time Travel restore runbook; `feat/batch-c-1`: "Usage ledger
(Neon, batch C)", the batch C manifest fields; `feat/recovery-playbooks`: the watchdog alerts runbook now points at
`docs/playbooks.md`, `owner:call` takes `set_sessions_valid_from_ms`; `docs/watchdog-hosting`: watchdog hosting, D125;
`gov/sandbox-handover`: sandbox-dev's owner is now its council DAO, council-setup's DAO check, the upgrade drill).

Commands and flags are from `scripts/`, `apps/api/scripts/gen-wrangler.ts`, `apps/api/scripts/pages-wrangler.ts`,
`apps/console/scripts/gen-wrangler.ts`,
`apps/demo/scripts/gen-wrangler.ts`, the `package.json` scripts and their tests. Endpoints:
`docs/api.md`. Contract methods: `docs/contract-interface.md`. Design and measurements: `docs/context.md`.

**Testnet only.** The manifest schema accepts only `network: "testnet"` and every script refuses an RPC whose
`chain_id` isn't `testnet`. Never point anything at mainnet accounts.

## Secrets: where they live

Never print, log, paste or commit any of these. The scripts never print them either.

| Secret | Where | Written by |
|---|---|---|
| Full-access keys of `signer`, `relayer`, `owner` | `~/.near-credentials/testnet/<account>.json` (or `<account>/*.json`) | near CLI `save-to-legacy-keychain`; scripts only read them |
| Session-pool relayer keys (`RELAYER_KEYS`) | `.secrets/<env>/relayer-keys.json` | `deploy-contract` |
| Owner-pool relayer keys (`OWNER_RELAYER_KEYS`) | `.secrets/<env>/owner-relayer-keys.json` | `deploy-contract` |
| Keys-updater key (`KEYS_UPDATER_KEY`) | `.secrets/<env>/keys-updater.json` (`private_key`) | `deploy-contract` (generated, then installed on `signer` by the contract's `add_updater_key`) |
| Council member keys (dev envs only, D81) | `.secrets/<env>/council/<member>.json` (`{account_id, public_key, private_key}`), full-access keys of throwaway testnet accounts | `council-setup`; other envs' members hold their own keys (mainnet: Ledgers, never on disk) |
| `VAULT_KEK` (and, during a rotation, `VAULT_KEK_PREVIOUS`) | `.secrets/<env>/vault-kek` (and `vault-kek.previous`); the only copy, since Cloudflare can't give a secret back | `vault-kek` (below) |
| Identity token signing keys (Worker slots `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`; testnet and `local*` only) | `.secrets/<env>/identity-signing-key.json` (active), `identity-signing-key-standby.json` (published, **never uploaded**: keep it offline), and during a rotation `identity-signing-key-next.json` / `-previous.json` (P-256 private JWKs); `identity-slots.json` says which slot holds which kid; the only copies | `identity-key <env> init`, `next`, `switch`, `retire` ("Identity token keys" below); `put --yes` uploads the active key again |
| Identity token KMS signer's AWS access key (`IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY`; `aws-kms` envs only, none yet) | `.secrets/<env>/identity-aws-access-key.json` (`aws iam create-access-key`'s JSON for the signer's IAM user), only until it is uploaded and checked: then delete it (a lost key is replaced, never recovered) | the operator, with the AWS CLI as the break-glass role; `identity-key <env> kms-put-aws-key --yes` uploads it ("Identity token keys on AWS KMS" below) |
| Identity token sub key (`IDENTITY_SUB_KEY`) | `.secrets/<env>/identity-sub-key` (base64 of 32 bytes); never rotated, also backed up offline with the council backup (D81) | `identity-key <env> init`; upload again with `identity-key <env> put --yes` |
| Email issuer signing key (`ISSUER_SIGNING_KEY`; testnet and `local*` only) | `.secrets/<env>/email-issuer-signing-key.json` (active), `email-issuer-signing-key-standby.json` (published and on chain, **never uploaded**: keep it offline); RSA-2048 private JWKs, the only copies | `email-issuer <env> init`; upload with `email-issuer <env> put --yes` ("Email issuer" below) |
| Email issuer HMAC keys (`EMAIL_SUB_KEY` = K_sub, `EMAIL_CODE_KEY`, `EMAIL_RL_KEY`) | `.secrets/<env>/email-sub-key`, `email-code-key`, `email-rl-key` (base64 of 32 bytes); K_sub is never rotated and is backed up offline twice (D81) | `email-issuer <env> init`; `put --yes` |
| SendGrid key for user mail (`SENDGRID_API_KEY`, Mail Send only, D194) | `.secrets/<env>/email-issuer-sendgrid-key` | pasted by hand; `email-issuer <env> put --yes` |
| The admin Worker's SendGrid key (`EMAIL_API_KEY`, Mail Send only, its own, D401) | `.secrets/<env>/admin-sendgrid-key` | pasted by hand; `wrangler secret put` from the file ("Admin Worker" steps 2–3) |
| Neon Postgres connection strings (batch C ledger, D73): pooled `DATABASE_URL` and `DATABASE_URL_DIRECT` of the env's Neon branch | `.secrets/<env>/neon.json` (`{project_id, org_id, branch, branch_id, region, DATABASE_URL, DATABASE_URL_DIRECT}`); role `neondb_owner`, used only by `usage-migrate` and `usage-setup` (which also reads `project_id` and `branch_id` for Neon's API, D403) | `neon connection-string <branch> --project-id <id> [--pooled]` (Neon CLI, `neon login`) |
| Ledger role URLs (`usage_writer`, `usage_admin`, batch C4): each role's password; their copies live in the two Hyperdrive configs | `.secrets/<env>/neon-usage-writer.url`, `neon-usage-admin.url` | `usage-setup <env> roles` ("Usage capture" below) |
| Neon API key for `usage-setup <env> roles` (D403): a project-scoped key of the env's Neon project; it can change and delete anything in that project | `.secrets/<env>/neon-api-key` (one line, 0600), only while setting up or rotating the roles: then revoke the key in Neon and delete the file | created by hand in Neon's console and saved with `umask 077; pbpaste > .secrets/<env>/neon-api-key` ("Usage capture" step 2) |
| Cloudflare API token for `access-setup <env>` (D409): "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups Read" on the API's account; it can change or delete any Access application and policy of that account | `.secrets/<env>/cloudflare-access-token` (one line, 0600), only while setting up or changing the admin's Access application: then delete the token in Cloudflare and the file | created by hand (My Profile → API Tokens, TTL today) and saved with `umask 077; pbpaste > .secrets/<env>/cloudflare-access-token` ("Admin Worker" step 1) |
| Cloudflare API token for `usage-setup <env> hyperdrive` (D412): "Account › Hyperdrive › Edit" on the env's account; it can create, change or delete that account's Hyperdrive configs | `.secrets/<env>/cloudflare-hyperdrive-token` (one line, 0600), only while creating the ledger's Hyperdrive configs: then delete the token in Cloudflare and the file | created by hand (My Profile → API Tokens, TTL today) and saved with `umask 077; pbpaste > .secrets/<env>/cloudflare-hyperdrive-token` ("Usage capture" step 3) |
| `USER_ID_KEY` (the uid key, base64 of 32 bytes; API only); never rotated within a contract term, backed up offline | `.secrets/<env>/user-id-key` | `usage-setup <env> user-id-key` (generates it once, sets the Worker secret) |
| The console's Google client secret (`CONSOLE_GOOGLE_CLIENT_SECRET`, console Worker only; batch C9) | `.secrets/<env>/console-google-client.json` (Google's downloaded client JSON, `web.client_secret`) | saved by hand from Google Cloud (setup step 11, "Partner console Worker"); `wrangler secret put` through a pipe; read by `console-code-flow-spike` |
| Watchdog secrets (`WATCHDOG_KEY`, `WATCHDOG_STATUS_TOKEN`, its own SendGrid key `SENDGRID_API_KEY` (Mail Send only, D401), Slack webhook, paging-app credentials, `HEARTBEAT_URL`); the admin Worker's copy of `WATCHDOG_STATUS_TOKEN` (batch C14) comes from the same file | `.secrets/<env>/watchdog-secrets.json` (flat `{NAME: value}`) | `watchdog secrets <env> init` (the key and token); the rest by hand ("Watchdog service" below) |
| Worker copies of the above | Cloudflare Worker secrets (the watchdog's on its own Cloudflare account) | `wrangler secret put` (watchdog: `wrangler secret bulk`) |
| Local dev copies | `apps/api/.dev.vars`, `apps/watchdog/.dev.vars`, `apps/email-issuer/.dev.vars` (0600) | `gen --dev-vars` |
| D1 exports of an account move (every row of a database: the API's holds the wallet directory and the wrapped vault shares, the issuer's users' email addresses) | `.secrets/<env>/d1-export-<db>-<yyyymmdd>.sql` (0600); delete once the move is checked | `d1-move <env> --db <db>` ("Moving an env to another Cloudflare account") |
| Cloudflare API tokens for an account move, one per account (optional: one login that is a member of both also works) | the shell only (`HANA_FROM_CLOUDFLARE_API_TOKEN`, `HANA_TO_CLOUDFLARE_API_TOKEN`), never a file in the repo; revoke both after the move | created by hand in each account's dashboard |

`.secrets/` is gitignored, directories 0700, files 0600 (`scripts/lib/secrets.ts` refuses to read a file that group
or others can read). Google ID tokens, CKD outputs and derived keys are never stored anywhere.

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node | ≥ 22 | `engines` in `package.json` |
| pnpm | 11.3.0 via corepack | `corepack pnpm …` (the `packageManager` field pins it) |
| Rust | 1.85.1 + `wasm32-unknown-unknown` | from `contracts/hana-signer/rust-toolchain.toml` |
| cargo-near | 0.22.0 (CI) | `cargo install cargo-near`; `deploy-contract` falls back to `cargo build --target wasm32-unknown-unknown --release` without it |
| near CLI | near-cli-rs ≥ 0.30 | account creation and key changes |
| wrangler | 4.151.1 | a devDependency of `@hana-id/api`: run it as `corepack pnpm --dir apps/api exec wrangler …` |
| gitleaks | 8.30.1 (CI) | `brew install gitleaks`; commits are blocked without it |

```sh
corepack pnpm install          # also sets core.hooksPath=.githooks (gitleaks pre-commit)
corepack pnpm -r typecheck
corepack pnpm -r test
corepack pnpm verify --quick   # or the whole local gate ("CI and git": pnpm verify, D413)
(cd contracts/hana-signer && cargo test)
corepack pnpm --dir apps/api exec wrangler login
```

`pnpm install` refuses packages published less than 7 days ago (`minimumReleaseAge`).

## Accounts and services per environment

Every name comes from `envs/<env>.json` (schema: `packages/env/src/schema.ts`; notes: `envs/README.md`).

| Manifest field | What | Funding / notes |
|---|---|---|
| `signer` | holds `hana-signer`; part of every user's address | ≥ 6 NEAR (contract storage, scope registrations) |
| `relayer` | function-call keys that pay the API's gas (both pools) | ≈ 7 NEAR |
| `owner` | contract admin (`new(owner, …)`): a plain account, or the council DAO once it accepted ownership | ≈ 1 NEAR (an account owner) |
| `ownerKind` | `account` (the owner's keychain key signs) or `sputnik` (`owner` is `council.dao`; owner calls are DAO proposals) | default `account`; `deploy-contract --transfer-owner` switches it after the DAO accepts |
| `council` (optional) | `{factory, dao, members}`: the owner council, a Sputnik DAO v2 `<name>.<factory>` with exactly three members, 2 of 3 for every proposal kind (D81) | sandbox-dev: `sputnikv2.testnet`, members funded by `council-setup` (2 NEAR each), DAO 6 NEAR |
| `watchdogs` | watchdog accounts (≤ 3) the contract lets cancel, confirm and pause | default none; `add_watchdog` is skipped until the account exists |
| `issuerKeyDelayMs`, `governanceDelayMs` | `new` delays (D80; also the delays the done v1 → v2 migration started with) | sandbox-dev: 120 000 and 60 000; mainnet 2 h (provisional) and 72 h. Outside dev envs `deploy-contract` (and `--creation-plan`) refuses an issuer-key delay below the security bound 3·(W + T) = 18 min and a governance delay below 24 h (mainnet: 72 h); `@hana-id/env` `governanceDelayProblems`. sandbox-dev's 2 min deliberately violates the bound for fast drills (D80): its plans carry a warning, never copy its delays to another env |
| `allowSignerFullAccessKey` | the signer may keep a full-access key (D86) | only `local*` / `sandbox*` testnet envs; sandbox-dev only among committed manifests |
| `mpc` | the NEAR MPC contract (exists already; not ours) | — |
| `ckdDomainId`, `ckdNetworkKey` | CKD domain and the pinned MPC public key | pin with `fetch-ckd-key` |
| `ckdNetworkKeySource` | where the pin was read: `{blockHeight, blockHash, rpcs}`, the final block and the hosts of the ≥ 3 independent providers that agreed (D100) | written by `fetch-ckd-key`; hosts only, never a URL |
| `rpc`, `apiUrl` | NEAR RPC; the deployed Worker URL | https (the schema allows http only for a loopback host in `local*` envs); `apiUrl` is known only after the first deploy |
| `rpcFallback` (optional) | a second NEAR RPC from another provider, https; the vault and the export window read from it only when `rpc` fails or times out | not `rpc` itself; built into the vault and auth bundles and in the API's and auth Worker's CSP (`NEAR_RPC_FALLBACK`), so a change needs `gen`, a page build and a redeploy of the API and both page Workers (D65) |
| `vaultOrigin`, `authOrigin` | Hana page origins (batch B) | both or neither; `gen` refuses an env without them |
| `googleClientIds` | Hana's own app clients → reserved `global` scope | |
| `sharedGoogleClientIds` | Hana's shared login clients (≤ 5) | never also in `googleClientIds` / `consoleAudiences` |
| `consoleAudiences` | `[provider, aud]` accepted for OIDC owner actions and guarded-change step-ups | set before the first deploy; registered only in the console sink scope, never in `global` (below) |
| `changeDelayMs` | contract timelock (0..7 days) | sandbox-dev: 60 s |
| `appChangeDelayMs` | batch C guarded-change delay (60 s..7 days; ≥ 24 h and ≤ `changeDelayMs` on a production network) | sandbox-dev: 60 s; read by the API and CLI from batch C3 |
| `console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs` | batch C dashboard: console, files and admin Workers and origins, R2 buckets, Access, Hyperdrive names, sender (`envs/README.md`) | all or none; sandbox-dev has none yet (`docs/batch-c-build-plan.md` "Setup steps") |
| `cloudflare.workerName`, `cloudflare.d1Name` | Worker and D1 names | |
| `cloudflare.accountId` (optional) | the Cloudflare account of every Worker but the watchdog's (D404): each `gen` writes it as `account_id` and refuses a shell `CLOUDFLARE_ACCOUNT_ID` naming another account | not a secret; never the watchdog's account (D86); sandbox-dev has none yet (wrangler's login picks the account) |
| `cloudflare.durableObjectLocation` | optional DO region hint (`apac`, `weur`, …) | changing it creates new objects |

Also needed: a Cloudflare account with a `workers.dev` subdomain, or a zone on that account for Custom Domains
(production needs a Hana-owned account), and a Google Cloud project. Where each Worker is served follows from its
origin in the manifest (D404): a `workers.dev` origin is the Worker's own `workers.dev` URL (dev envs only, and named
after the Worker); any other https origin is a Custom Domain (`routes: [{pattern: <host>, custom_domain: true}]`,
`workers_dev: false`, no preview URLs) on a zone **of the same account**: `apiUrl` (a bare origin then), the two page
origins, `emailIssuer.url`, the dashboard origins, `watchdog.url` (on the watchdog's account) and the demo
(`HANA_DEMO_ORIGIN`). A dev env (`local*`, `sandbox*`) may put them all under one registrable domain (e.g.
`api.`, `vault.`, `auth.`, `email.id-dev.hanawallet.io`); production keeps the vault on its own site, apart from the
auth pages, the API and the dashboard (D38; the schema refuses it), so it needs two registrable domains.

Values containing `UNSET` are placeholders: `deploy-contract` skips the step that needs them (with a warning),
`scope:register --allow-shared` warns, and `@hana-id/core`'s `ckdKeyProblem` makes smoke and the web build refuse an
`UNSET` `ckdNetworkKey`.

**Address impact.** `signer`, `mpc`, `ckdDomainId` / the MPC key, the path format and the local derivation are part of
every user's address. Changing any of them before the address freeze is allowed but must be called out; after it,
never.

## Google Cloud OAuth

Console → APIs & Services → Credentials → Create OAuth client ID, type "Web application". Consent screen in Testing
mode with test users.

| Client | Manifest field | Notes |
|---|---|---|
| Hana's own app | `googleClientIds` | becomes a client of `global` |
| Shared login client | `sharedGoogleClientIds` | a different client ID from the above |
| Hana console | `consoleAudiences` (`["google", "<id>"]`, exactly one `google` entry: the console's `CONSOLE_GOOGLE_CLIENT_ID`, D294) | partner sign-in (code flow with PKCE, batch C9); becomes the only client of the console sink scope (never of `global`) |
| Partner test client(s) | `scope:register --client` | for own-client tests; for the own-vs-shared address test use a separate Google Cloud project (the cross-project `sub` match was confirmed 2026-10-28, D42) |

Register on each client:

| Entry | Value | On which clients | Why |
|---|---|---|---|
| Authorized redirect URIs | `{authOrigin}/login/callback`, exact (scheme, host, no trailing slash) | the shared client, and every partner's own client used through Hana's login page | the login popup (`response_type=id_token`, `redirect_uri={authOrigin}/login/callback`) |
| Authorized redirect URIs | `http://localhost:5173/direct-callback.html`, exact | every client `apps/smoke`'s direct page signs in with | the direct page's openid-only popup (D271); no JavaScript origin is needed any more (Google Identity Services is gone) |
| Authorized redirect URIs | `{console.authOrigin}/callback`, exact, and **nothing else**; **no JavaScript origins** | the Hana console client only | the console's code flow (batch C9; "Partner console Worker", setup step 11); its client secret is `CONSOLE_GOOGLE_CLIENT_SECRET` |

Changes in Google Cloud can take a few minutes to apply. Changing `authOrigin` later breaks every own-client
partner's redirect registration (not addresses).

### What sandbox-dev runs at M4 (2026-11-06)

Everything below is on the personal Cloudflare account `f0b1e2c42c3e5bd63992958a19d4abca` (workers.dev subdomain
`tingtc`) until the company account move (D414; never past a free tier, D417), deployed from `develop` 816dd47
(`deploy-check sandbox-dev --d1` and `--only watchdog --d1`: OK).

| Piece | Name | Notes |
|---|---|---|
| API, vault and auth pages, email issuer, demo | as before | the API with usage capture on (`USAGE_DB` → Hyperdrive writer) and `FILES_ORIGIN`; the issuer with the admin's Access vars (`DirectoryRpc` live) |
| Partner console + console-auth | `hana-id-console-sandbox-dev`, `hana-id-console-auth-sandbox-dev` | console D1 `hana-id-console-sandbox-dev` (APAC, migrations 0001–0002); Google client `…rs47…` (console sink scope `s3`, D416) |
| Files | `hana-id-files-sandbox-dev` | R2 `hana-id-logos-sandbox-dev`, `hana-id-statements-sandbox-dev` (lock `statements-1d`, D402), `hana-id-exports-sandbox-dev` (lifecycle `exports-30d` on `exports/`) |
| Admin | `hana-id-admin-sandbox-dev` | Access application `Hana ID admin (sandbox-dev)` on team `bitter-hill-fe6f`, policy `Hana staff (sandbox-dev)` (2 exact emails, Google only; the only login method on the account); Hyperdrive admin config; SendGrid key in the one SendGrid account (no subusers, D414 amended) |
| Watchdog | `hana-id-watchdog-sandbox-dev` | on the **same** account as the API today (D125's own account comes with the move); alerts to `hello@ting.rocks` from `team@hanawallet.io`; `watchdog.url` set for the admin's status view |
| Hyperdrive | `hana-id-usage-writer-sandbox-dev`, `hana-id-usage-admin-sandbox-dev` | created through Cloudflare's API by `usage-setup hyperdrive` (D412), caching off |

Cron triggers: exactly the Free plan's 5 per account (API, console, admin ×2, watchdog): nothing else with a cron may
be added to this account.

## Create an environment from scratch

Copy `envs/sandbox-dev.json` to `envs/<env>.json`; `name` must equal the file name. Use fresh throwaway account names:
the signer is part of every address. Dev-only privileges (loopback origins, partner calls to the session endpoints with
`pk_test_` keys, same-site Hana origins) follow from the name: `local*` / `sandbox*`.

1. **Accounts** (each ~10 NEAR from the faucet, key saved to the legacy keychain):

   ```sh
   near account create-account sponsor-by-faucet-service <signer>  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <relayer> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <owner>   autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```

2. **Manifest**: accounts, Google client IDs, `consoleAudiences`, `changeDelayMs`, Cloudflare names, `vaultOrigin` /
   `authOrigin`. Fill the client lists before the first deploy (a shared client added later waits out the timelock;
   a console audience added later gets its own sink scope on the next deploy-contract run).
3. **Pin the MPC key** (writes `ckdNetworkKey` and `ckdNetworkKeySource`; `--dry-run` only prints):

   ```sh
   corepack pnpm --filter @hana-id/scripts run fetch-ckd-key <env> [--rpc https://<another provider>]
   ```

   It reads the key at one final block from at least three independent providers (distinct registrable domains: the
   manifest's `rpc` and `rpcFallback`, each `--rpc`, then the built-in public endpoints `rpc.testnet.near.org`,
   `test.rpc.fastnear.com`, `near-testnet.drpc.org`) and refuses to write unless every one reports the env's chain,
   the same block hash and the same key (D100, security sweep OPER-1). A provider that is down or disagrees stops it:
   find out why before pinning, never drop the disagreeing source. Different domains are only a proxy for different
   operators; before a mainnet pin also compare the key with the MPC key material NEAR publishes and record that in
   the PR. The manifest change goes through a code-owner review (`/envs/` in `.github/CODEOWNERS`).

4. **Deploy the contract.** Prints the plan and changes nothing without `--yes`; re-running plans only what's
   missing. What each step does and why it blocks: root `README.md`, "deploy-contract".

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env>        # read the plan
   corepack pnpm --filter @hana-id/scripts run deploy-contract <env> --yes
   ```

   Flags: `--relayer-keys N` (1..20, default 3), `--relayer-allowance <NEAR>` (2), `--owner-relayer-keys N` (1..5,
   default 1), `--owner-relayer-allowance <NEAR>` (0.5), `--upgrade` (see [Governance](#governance-owner-council-upgrades-migration)),
   `--wasm <file>`, `--skip-build`, `--transfer-owner`, `--member <m>`, `--approve-with <m>`, `--creation-plan`. Pass
   the same allowance flags on every re-run if you raised them (a key with a larger allowance than the flag is a
   blocker). Shared clients take effect `changeDelayMs` after this. A plain deploy calls `new(owner, mpc,
   ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs, updater_keys: [])` and needs
   the signer's full-access key, so only envs with `allowSignerFullAccessKey` deploy this way; any other env is
   created with the one-batch creation transaction (`--creation-plan`, below). The updater key is then installed by
   the owner's `add_updater_key`.

5. **Post Google's keys** once (the API cron keeps them in sync afterwards). On the governance contract this proposes
   them; they go live when the watchdog confirms them or after `issuer_key_delay_ms` (re-run with `--execute`):

   ```sh
   corepack pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run] [--execute]
   ```

6. **D1 and Worker config**:

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>      # prints the database id
   corepack pnpm --filter @hana-id/api run gen <env> --d1-id <uuid>             # writes apps/api/wrangler.jsonc (+ the page Workers' configs)
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote
   ```

   Run `migrations apply` (here and everywhere in this runbook) from a checkout at the commit you are deploying, with
   a clean tree: wrangler applies the files on disk, by name ("Checking a deploy" below).

   Without `--d1-id`, `gen` keeps the id already in `wrangler.jsonc` only if that file names the same
   `database_name`, else it writes the local placeholder `00000000-0000-4000-8000-000000000000`. The generated files
   are gitignored (`wrangler.jsonc` holds the env's D1 id): re-run `gen <env>` whenever you switch envs, and never commit them.

   `gen` also writes the two Rate Limiting bindings of the vault's per-IP and per-share limits (`ratelimits`:
   `VAULT_IP_LIMIT` namespace `95001`, `VAULT_SHARE_LIMIT` namespace `95002`; D95). They need no setup in the
   dashboard and aren't shown there. A namespace id is shared across the whole Cloudflare account: don't give
   another Worker on the account a binding with these ids (it would share counters for equal keys; this API's keys
   start with the env name, so two Hana ID envs on one account stay apart). The first deploy of an account
   confirms the plan accepts the binding: a refusal fails that deploy as a whole.

7. **Worker secrets** (from the repo root; values go through a pipe, never the terminal):

   ```sh
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | corepack pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> init           # read the plan
   corepack pnpm --filter @hana-id/scripts run vault-kek <env> init --yes
   ```

   `vault-kek init` generates `VAULT_KEK` (key id 1), writes it to `.secrets/<env>/vault-kek` (0600) before anything
   else, and sets the secret on `cloudflare.workerName` through wrangler's stdin; it prints no key and refuses to
   overwrite an existing file. If the secret step fails, `vault-kek <env> put --yes` sets it again from the file. Keep
   the file: a rotation needs the current value.

   The identity token's keys (optional; without them `/v1/identity/*` answers 503 `identity_unavailable`):
   `identity-key <env> init --yes`, commit the manifest's new `identityToken` block, re-run `gen` ("Identity token
   keys" under "Key rotation").

8. **Deploy the API**, then put the Worker URL in `apiUrl` and re-run `gen` + deploy if it changed (the vault page's
   CSP and the page bundles use it):

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   curl -s https://<worker-url>/v1/health          # {"ok":true,"env":"<env>","signer":"<signer>",…,"build":"<commit>"}
   ```

   Always through `run deploy` (never a raw `wrangler deploy`): it stamps the Worker with the build id (D384).

9. **Deploy the two page Workers** (`vaultOrigin`, `authOrigin`; one thin Worker each, D66), after the API: the vault
   Worker reaches it through a service binding. `gen` (step 6) already wrote their configs; the web build writes the
   per-env bundles they serve (`apps/api/README.md`, "Page Workers"). `deploy:pages` runs that build itself
   (`packages/web/dist/pages/<env>/{vault,auth}`, every env with both origins), so a deploy never ships a stale bundle:
   on 2026-11-05 a deploy of an old build sent wallet records without the session signature (`400 bad_request`).

   ```sh
   corepack pnpm --filter @hana-id/api run deploy:pages   # the web build first, then the stamped deploys of -c wrangler.vault.jsonc and -c wrangler.auth.jsonc
   corepack pnpm --filter @hana-id/scripts run deploy-check <env> --d1   # every piece on this commit, no migration pending
   ```

   Rebuild and redeploy them whenever the manifest's `signer`, `relayer`, `rpc`, `rpcFallback`, `apiUrl`,
   `ckdNetworkKey` or origins change: the bundles inline them.
10. **Google redirect URI**: add `{authOrigin}/login/callback` on the shared client and on every partner's own client
    that logs in through Hana's pages (table above).
11. **Register apps** (next section), then **smoke test**.

### Checking a deploy (`deploy-check`, D384, D406)

Every deployed piece of an env carries the build id of the checkout it came from: the commit's first 12 hex
characters, `-dirty` when the tree had uncommitted changes (tracked or untracked). On 2026-11-05 sandbox-dev's page
Workers served a vault bundle older than the API (every wallet record `400 bad_request`), and earlier that day a D1
migration was applied from an older checkout; nothing showed either. **After every deploy step in this runbook** (the
API, the page Workers, the email issuer, the console and console-auth, the files and admin Workers, the watchdog), once
the last Worker of the step is out, run from the checkout you deployed:

```sh
corepack pnpm --filter @hana-id/scripts run deploy-check <env>          # every piece on this checkout's commit
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --d1     # and no D1 migration of this checkout pending
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only watchdog [--d1]   # logged in to the watchdog's account
```

**Every Worker deploys through its `run deploy`** (`corepack pnpm --filter @hana-id/<app> run deploy`; the API's page
Workers through `run deploy:pages`), never a raw `wrangler deploy`: each is the one shared wrapper,
`packages/env/src/stamped-deploy.ts`, which runs `wrangler deploy <args> --var HANA_BUILD:<build id>` in the app's
directory (D406). The console's `run deploy` builds its SPA first.

| Group | Piece | Read from | Stamped by |
|---|---|---|---|
| `api` | API Worker | `GET {apiUrl}/v1/health` → `build` | `pnpm --filter @hana-id/api run deploy` (`HANA_BUILD` var) |
| `pages` | vault Worker | `GET {vaultOrigin}/.well-known/hana-build` → `build` | `run deploy:pages` |
| | vault bundle | `{vaultOrigin}/vault.js`, first line `/* hana-build <id> */` | the web build (`deploy:pages` runs it first) |
| | auth Worker | `GET {authOrigin}/.well-known/hana-build` → `build` | `run deploy:pages` |
| | auth pages | `{authOrigin}/login`, `<meta name="hana-build">` | the web build |
| `issuer` | email issuer | `GET {emailIssuer.url}/v1/email/health` → `build` | `pnpm --filter @hana-id/email-issuer run deploy` |
| `console` | console Worker | `GET {console.origin}/.well-known/hana-build` → `build` | `pnpm --filter @hana-id/console run deploy` |
| | console SPA | `{console.origin}/` (index.html), `<meta name="hana-build">` | its `vite build` (`run deploy` runs it first) |
| `console-auth` | console-auth Worker | `GET {console.authOrigin}/.well-known/hana-build` → `build` | `pnpm --filter @hana-id/console-auth run deploy` |
| `files` | files Worker | `GET {files.origin}/.well-known/hana-build` → `build` | `pnpm --filter @hana-id/files run deploy` |
| `admin` | admin Worker | the deployed version's `HANA_BUILD` var: `wrangler deployments status` + `versions view --json` (see below) | `pnpm --filter @hana-id/admin run deploy` |
| `watchdog` | watchdog Worker | the same, on `watchdog.cloudflare.accountId`; **only with `--only watchdog`** | `pnpm --filter @hana-id/watchdog run deploy` |
| `--d1` | each D1 of the groups read | `wrangler d1 migrations list <db> --remote` from `apps/api` (`cloudflare.d1Name`), `apps/email-issuer` (`emailIssuer.cloudflare.d1Name`), `apps/console` (`console.d1Name`), `apps/watchdog` (`watchdog.cloudflare.d1Name`) | needs each `wrangler.jsonc` generated for `<env>` (`gen`) |

A group is read only when the manifest has it (the dashboard blocks, `emailIssuer`, `watchdog`). `--only <g,…>` reads
just those groups, `--skip <g,…>` all but those (comma-separated or repeated; not both). Each run prints what it didn't
read.

- **The admin Worker** has no build route: its whole origin is behind Cloudflare Access, which `deploy-check` can't
  pass and which gets no exception for it. So `deploy-check` asks wrangler (read-only), logged in to the API's
  Cloudflare account as for the deploy, for the deployment serving the Worker (`wrangler deployments status --name
  <admin.workerName> --json`) and that version's metadata (`wrangler versions view <id> --json`), and reads only the
  `HANA_BUILD` var from it (nothing else wrangler prints is shown). It runs wrangler from an empty directory, so a
  `wrangler.jsonc` generated for another env doesn't apply; with several accounts on one login, set
  `CLOUDFLARE_ACCOUNT_ID`. A gradual deployment (two versions, or one under 100%) fails: finish or roll it back
  first. The admin's `public/` files have no build step and ship in the same version, so the var covers them.
- **The watchdog** serves nothing without its status token, and gets no public route (D86). It is read the same way,
  with `CLOUDFLARE_ACCOUNT_ID` set to `watchdog.cloudflare.accountId`, but only by `--only watchdog`: its account has
  its own login, so a default run (the API's login) says it isn't read. After a watchdog deploy, run `deploy-check
  <env> --only watchdog --d1` logged in to the watchdog's account (sandbox-dev's watchdog is on the API's account,
  D125, so the API's login reads it too).

Exit 1 (each reason on a `FAIL:` line) when a piece can't be read (a status, a redirect, unreachable, a failed wrangler
run), isn't stamped (`null`, or no `HANA_BUILD` var: deployed with a raw `wrangler deploy`; no `build` field or no stamp
in a bundle: deployed before D384, or before D406 for the console, console-auth, files, admin and watchdog Workers and
the console SPA), runs another commit than this checkout's HEAD, or (`--d1`) a database lacks a migration file of this
checkout. Warnings, not failures: a piece deployed from a dirty tree (`--strict` makes it a failure; use `--strict`
outside dev envs) and a dirty checkout here. `--skip-head` compares the pieces with each other only, to check an env
from another commit. An env runs one commit: when a step deploys only some pieces (only the API, say), deploy the
others from the same checkout too (`run deploy:pages`, each other app's `run deploy`) before the check, which otherwise
fails and names each piece that lags (as it does between the steps of a multi-Worker deploy; `--only` checks just the
groups a step deployed). It holds no secret, prints only the manifest's URLs and Worker names, statuses, well-formed
build ids and the last lines of a failed wrangler run's own error, and changes nothing (`deployments status`, `versions
view` and `migrations list` only read; `migrations list` creates the remote `d1_migrations` table only if it is
missing, which it never is on a migrated database).

**Migrations: apply from the deployed commit.** `wrangler d1 migrations apply` applies the `.sql` files on disk that
the remote database hasn't recorded, by name. Apply from a checkout at the commit you then deploy, `git status` clean
(`deploy-check` prints this checkout's id: it must not end in `-dirty`). `--d1` then confirms nothing of that commit is
pending. It can't see a file applied under the same name with other content (`d1_migrations` keeps names, not
hashes): 2026-11-05's draft of `0011_wallet_directory.sql` was such a case, so the checkout rule is what prevents it.

After a `wrangler rollback`, the rolled-back Worker reports the id of the version it returned to (an older commit, or
none before D384/D406): check from a checkout at that commit, or with `--skip-head` once every piece is rolled back.

Not stamped: the hosted demo (`apps/demo`, not an env Worker).

### Upgrading an env deployed from `develop` to batch B

The contract change is a code upgrade (`deploy-contract <env> --upgrade`, plan first). The session-pool allowlist
gains `create_session_and_derive`, and access-key permissions can't be edited: the plan blocks on every session key
with the old method list and prints `near account delete-keys …` per key; delete them, re-run (it re-adds them from
`.secrets/<env>/relayer-keys.json`); the secret is unchanged (same keys). A re-added key starts at a new on-chain
nonce, so expect one `relay_retry` `invalid_nonce` per key on its first relay. This is allowlist state 1 (the session
pool's methods in `apps/api/src/relayer-config.ts`). Then: set `vaultOrigin` / `authOrigin`, re-run `gen`, apply
migration `0003_vault.sql` (`migrations apply … --remote`), `vault-kek <env> init` (step 7), deploy the API (step 8),
build and deploy the page Workers (step 9), and register `{authOrigin}/login/callback` (step 10).

## Governance (owner council, upgrades, migration)

The governance contract (`docs/governance-spec.md`, D33, D80–D86; methods in `docs/contract-interface.md`) puts
issuer keys and code changes behind public delays and makes the owner a 2-of-3 Sputnik DAO v2 council. The scripts:

| What | Command |
|---|---|
| Create the dev council (accounts + DAO) | `council-setup <env> [--yes] [--funder <account>] [--member-balance 2]` |
| Any owner call through the owner | `admin <env> owner:call <method> --args '<json>' [--member <m>] [--approve-with <m>] [--yes]` |
| Retire a console client from its sink (D416) | `admin <env> console:remove-audience <aud> [--approve-with <m>] [--yes]` ("Console sink scope") |
| Vote / list council proposals | `admin <env> owner:vote <id> --member <m> [--reject] [--yes]` · `admin <env> owner:proposals [--json]` |
| Replace a council member | `admin <env> council:replace-member --remove <old> --add <new> [--member <m>] [--approve-with <m>] [--yes]` |
| Governance state and findings | `admin <env> governance:status [--json]` |
| Upgrade (propose, then execute once due), hand the contract to the DAO | `deploy-contract <env> --upgrade` · `--transfer-owner [--approve-with <m>]` |
| Print the mainnet-style signer creation batch | `deploy-contract <env> --creation-plan [--wasm <reproducible build>]` |

All are `corepack pnpm --filter @hana-id/scripts run …`. Each prints its plan and sends nothing without `--yes`
(`--creation-plan` never sends).

### Owner council (Sputnik DAO v2, D81)

The DAO code and policy are pinned in `contracts/sputnik/` (`pin.json`: v3.31, `code_hash`
`AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, 539 647 bytes; `policy.json`: one `council` role with exactly the
manifest's three members, `RoleWeight` threshold `[1, 2]` for every proposal kind = 2 of 3, no `Everyone` role, no
`RemoveProposal`, bond 0.1 NEAR, 7-day proposals). The sandbox test `sputnik_dao_owner_2_of_3` checks that wasm with
that policy; the scripts read the same files. `deploy-contract` checks the DAO's `get_policy` against it (not only
its code hash) before `--transfer-owner` and on every run of a council-owned env, and blocks on any role, member,
permission or vote-policy difference (`sputnik.ts` `policyProblems`): a staging or mainnet DAO is created by hand, so
this is the check that it really is 2 of 3 for every kind. The watchdog alerts critical on any later change of the
owner DAO's policy or code (`owner_policy`, `owner_code_hash`).

**What was verified (2026-10-29), and how.** From the pinned commit of near-daos/sputnik-dao-contract: the factory's
`create(name, args)` takes base64 JSON `{config, policy}`, needs a deposit of at least (code bytes + 32) × 10¹⁹ yocto
(`ERR_NOT_ENOUGH_DEPOSIT`; 5.397 NEAR for the pinned wasm, council-setup sends 6) and refunds it if `new` fails;
`add_proposal({proposal: {description, kind}})` needs the bond and isn't a vote; `act_proposal(id, action, memo)`
executes on the vote that reaches the threshold; `to_weight` is min(⌊a·n/b⌋ + 1, n). By read-only RPC views of
testnet: `sputnikv2.testnet` exists, `get_default_code_hash` = the pinned `code_hash`, `get_default_version` = [3, 31].
From near-cli-rs's `create-account fund-myself` source: a top-level `<name>.testnet` account is created by the
`testnet` registrar's `create_account({new_account_id, new_public_key})` with the initial balance attached, 30 Tgas.
**Verified on testnet 2026-10-30** (sandbox-dev): `council-setup sandbox-dev --yes` created the
DAO `hana-id-council-dev1.sputnikv2.testnet` with the pinned policy, and proposal round trips behaved as in the
sandbox: the owner handover (`accept_owner`, proposal #0), the upgrade drill (contract 0.1.1), and the drills'
updater-key install, `remove_issuer_key` and unpause (#2–#4) ([Governance migration (sandbox-dev)](#governance-migration-sandbox-dev),
[Watchdog service](#watchdog-service-appswatchdog)); `governance:status` shows no findings. Not recorded: the gas
`create` really burns (council-setup attaches 300 Tgas).

**sandbox-dev** (dev envs only: `local*` / `sandbox*` on testnet):

```sh
corepack pnpm --filter @hana-id/scripts run council-setup sandbox-dev          # plan
corepack pnpm --filter @hana-id/scripts run council-setup sandbox-dev --yes    # 3 × create_account + factory create
```

It generates each member key into `.secrets/sandbox-dev/council/<member>.json` (0600) **before** the account exists,
creates the accounts from the funder (default the manifest `owner`, from the keychain; ~12.4 NEAR in all; once the
owner is the DAO, pass `--funder`), then the DAO, and checks it exists and its stored policy. The factory's `create`
doesn't return its promise, so its transaction value is always empty: the script checks the DAO account instead. Re-running checks what exists: a factory whose default code isn't the pin (re-pin
and re-run the sandbox test first), a member that exists without its key file, or a DAO with other code or another
council, threshold, roles or permissions stops the plan.

**Other envs**: council-setup refuses them. Each member creates their own account and keeps their own key (mainnet:
the founders' Ledgers and the offline backup key, D81); the DAO is created once by hand with the same factory call
(`scripts/lib/sputnik.ts` `factoryCreateArgs`, the same `policy.json`). The scripts never read a council key from
disk for mainnet.

### Owner actions through the council

`owner:call` sends one owner-only method (the list is `OWNER_METHODS` in `scripts/lib/contract.ts`, kept a superset of
the contract's owner-only methods by `scripts/test/contract-constants.test.ts`, so every recovery playbook's owner call
goes through it, `set_sessions_valid_from_ms` included) through the manifest's owner:

- `ownerKind: "account"`: the owner's keychain key signs it.
- `ownerKind: "sputnik"`: a `FunctionCall` proposal (receiver `signer`, the JSON args, no deposit, 100 Tgas or
  `--gas`) by `--member` (dev envs: default the first member). On dev envs `--approve-with <second member>` also casts
  the proposer's and that member's approvals, so the call executes in the same command. Elsewhere the command only
  proposes and prints, per member, the `near contract call-function as-transaction <dao> act_proposal … sign-with-ledger`
  command to sign. `--approve-with` is refused outside dev envs.
- `accept_owner` always goes through the council (the account accepting is the proposed owner, the DAO).
- An open proposal for exactly the same call is reused, so a re-run never duplicates one: same receiver, method,
  args, deposit (none) and gas, and a description starting `hana-id <env>: ` (the scripts' own). An open proposal for
  the same method and args that differs in gas, deposit or description is never reused: the command prints `WARNING:
  open proposal #N … a different gas / deposit / description; not reusing it`, then proposes anew. Reject the stray one
  (or let it expire) if nobody wants it. A call the contract refuses leaves the proposal `Failed` and the command fails.

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:call unpause --approve-with hana-id-council-b-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:proposals
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:vote 4 --member hana-id-council-c-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev owner:vote 5 --member hana-id-council-c-dev1.testnet --reject --yes
```

`owner:vote` casts one vote per member (the DAO refuses a second: it says what the member already voted):
`VoteApprove`, or `VoteReject` with `--reject`. Two rejections (2 of 3) close the proposal as `Rejected`: it never
executes, and the proposer's bond is refunded. `owner:proposals` shows approvals and rejections. Off dev envs a member
rejects with the same `act_proposal` command as an approval, `"action":"VoteReject"`. Reject every proposal nobody
explained, rather than letting it sit open for its 7 days.

`deploy-contract` and `admin scope:register` route their owner steps the same way (both take `--member` /
`--approve-with`). With a council owner and no `--approve-with`, `deploy-contract` stops after the first step that
was only proposed; re-run it once that proposal is approved.

### Replacing a council member

`admin <env> council:replace-member --remove <old> --add <new>` (D151) replaces one member and keeps the policy the
scripts verify (one `council` Group of three, 2 of 3 for every kind: `policyProblems`). Sputnik has no swap, so it
makes two proposals on the council DAO, in this order: `RemoveMemberFromRole(<old>, council)`, then
`AddMemberToRole(<new>, council)`. Between the two the council is 2 of 2 (the threshold follows the group's size), so
both remaining members approve the addition; removing first cuts a lost or stolen key off at once. The old member
never proposes or approves (`--member` and `--approve-with` refuse it). Before sending anything it checks that the new
member's account exists, that `envs/<env>.json` still validates with the new `council.members` (the new member in the
old one's place), and that the DAO's group is the manifest's council (or a half-done replacement: removed only, or
added only, which it carries on from) with otherwise exactly the council policy. Open identical proposals are reused.

- Without `--yes`: the plan, including the exact manifest edit (`"council": "members": [...] -> [...]`).
- Dev envs on testnet, `--approve-with <second remaining member>`: both proposals are approved in the same command,
  so they execute; then it writes `council.members` in the manifest.
- Elsewhere: it only proposes, and prints the `act_proposal` `VoteApprove` command for each remaining member and
  each proposal (approve the removal first). After both executed, run it again with `--yes`: it finds the new council
  on chain and writes `council.members`.

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev council:replace-member --remove hana-id-council-c-dev1.testnet --add hana-id-council-d-dev1.testnet --approve-with hana-id-council-b-dev1.testnet          # plan
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev council:replace-member --remove hana-id-council-c-dev1.testnet --add hana-id-council-d-dev1.testnet --approve-with hana-id-council-b-dev1.testnet --yes
corepack pnpm --filter @hana-id/scripts run admin <env> council:replace-member --remove <old member> --add <new member> --member <member> --yes
```

Each executed change raises the watchdog's critical `governance_change` (`owner_policy`): expected, acknowledge it.
On a dev env the new member's key belongs in `.secrets/<env>/council/<new member>.json` for the scripts to sign as it
(the command notes when it is missing). Commit the manifest edit (code-owner review), then check `governance:status`
(no findings) and a `deploy-contract <env>` dry run (no council blocker).

### Governance migration (sandbox-dev)

`docs/governance-spec.md` "Migration plan → sandbox-dev", as commands. Same signer account, migrated in place: no
address changes (the signer id, the path and the CKD request are untouched). **Done on sandbox-dev 2026-10-30; kept as
the record.** It can't be repeated with current code: contract v3 has no `migrate_v1`, and `deploy-contract` refuses
a v1 contract (D154; a v1 contract would first need the v2 code, develop 26fb70a).

1. Merge the contract, API (sync with the new updater methods) and script changes; tests pass.
2. `council-setup sandbox-dev --yes` (above). Create the watchdog account (`watchdogs[0]`) with near CLI when the
   watchdog service is ready; until it exists `deploy-contract` skips `add_watchdog` with a warning.
3. `deploy-contract sandbox-dev --upgrade` (read the plan), then `--yes`. One run:
   1. `DeployContract` + `migrate_v1(issuer_key_delay_ms, governance_delay_ms)` from the manifest, **one
      transaction** signed by the signer's full-access key (a panicking `migrate_v1` rolls the deploy back);
   2. `add_updater_key(<new key>)` by the owner; the new key is generated into `.secrets/sandbox-dev/keys-updater.json`
      first (replacing the v1 key's file: that key is deleted next);
   3. `DeleteKey(<v1 updater key>)` with the signer's full-access key (left in place it could still propose keys);
   4. `add_watchdog(<watchdog>)` by the owner (its confirm power starts after `governance_delay_ms`).

   Then upload the new `KEYS_UPDATER_KEY` (create step 7) and deploy the API: until then the API's JWKS sync fails
   (safe: keys only change by proposal). Check `get_scope("global")`, `get_issuer("google")`, a live session and a
   smoke wallet's addresses.
4. Watchdog service, alerts and the rotation and pause drills: the watchdog batch (`apps/watchdog`).
5. `deploy-contract sandbox-dev --transfer-owner --yes`: `propose_owner(<council DAO>)` by the old owner. After
   `governance_delay_ms` (60 s): `deploy-contract sandbox-dev --transfer-owner --approve-with <member> --yes`: the DAO's
   `accept_owner` proposal, approved by two members. On success the script sets `"owner": "<dao>"` and
   `"ownerKind": "sputnik"` in `envs/sandbox-dev.json`; commit that change.
6. Upgrade drill: rebuild with a no-op change (a patch bump of `contracts/hana-signer/Cargo.toml` `version` changes
   the hash: cargo-near embeds it in the wasm), `deploy-contract sandbox-dev --upgrade --approve-with <member> --yes`
   (the DAO's `propose_upgrade(hash)`), wait `governance_delay_ms`, then `deploy-contract sandbox-dev --upgrade
   --skip-build --yes` (`execute_upgrade`). Check `view_account.code_hash`.
7. The signer keeps its full-access key (D86, `allowSignerFullAccessKey: true`); `deploy-contract sandbox-dev` must
   show no blockers, and `admin sandbox-dev governance:status` no findings.

### Upgrading the governance contract

`deploy-contract <env> --upgrade` never sends a raw `DeployContract` to a v2 contract:

- No pending upgrade, or a different one: build (or `--wasm` / `--skip-build`), then `propose_upgrade(<code_hash>)`
  through the owner (`code_hash` = base58 sha256 of the wasm, NEAR's `view_account.code_hash` format). A different
  pending hash is replaced, with a warning.
- The same hash pending and not yet due: nothing to do; the plan prints when it is executable.
- Due: `execute_upgrade` with the raw wasm as the input (not JSON), 300 Tgas, signed by the relayer's full-access key
  (anyone may execute). The deploy and the new code's `migrate` are one receipt: if `migrate` fails the old code stays,
  the pending upgrade is consumed, and the script fails with "its migrate failed"; propose a fixed build.

Re-run with `--skip-build` (or the same `--wasm`) to execute, so the hash is the proposed one. For a mainnet manifest
the build must be reproducible (`cargo near build reproducible-wasm`) and its hash, commit and command published
before the proposal (D86); the scripts refuse every non-testnet manifest today.

**v2 → v3 (email login, sandbox-dev in build-plan batch 6).** Before proposing it, both must be live:

1. The API, `packages/web` (the vault's split path) and `apps/smoke/src/direct.ts` sending the `create_session`
   proof of possession (`signature` over session_message(0, "hana-id-create-v1:" ‖ sha256(session nonce
   preimage)), D137), deployed. v2 ignores the extra field; v3 requires it, so without it every split-path session
   (`/v1/sessions`) fails from the moment the upgrade executes (the one-transaction `/v1/login` is unaffected).
2. The watchdog with the email pins (build-plan batch 5) deployed, so the email keys posted after the upgrade aren't
   read as an attack (`forged_key_change`, D190). Item 1 is proven safe on v2 by the sandbox test
   `v2_ignores_the_create_session_proof_that_v3_requires` (`contracts/integration-tests/tests/governance.rs`).

`deploy-contract --upgrade` refuses to propose or execute while the env's API doesn't report
`capabilities.createProof` on `GET /v1/health` (batch 6 review M2). **After v3 executes, never roll the API or the
page Workers back below batch 6**: an older build sends no proof and every split-path session fails.

The full order, as the user's commands, is "Email login on sandbox-dev (build plan batch 6)" below (issuer keys →
watchdog pins → D1 → API and vault with the proof → session-pool keys → upgrade → `accept_unrecorded_wallets` →
issuer Worker → email issuer on chain; the email clients wait for batch 8, D234). The upgrade itself
is the same path as any other; the sandbox suite runs it end to end
from the v2 code sandbox-dev runs (`contracts/integration-tests/tests/governance.rs`
`v2_to_v3_upgrade_through_the_dao_keeps_every_view_and_path`): the DAO's `propose_upgrade`, `execute_upgrade` once
due (`state_migrated {2, 3}`, ≈ 100 Tgas of the 300 attached), every view and path unchanged, then the DAO's
`accept_unrecorded_wallets` before any link works (D135). Check `get_governance().state_version == 3` and
`get_config().unrecorded_wallets` (`true` until that call). The v2 code can't come back by upgrade (its `migrate`
refuses v3 state; the deploy reverts). sandbox-dev's v2 code (`3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz`) is
`contracts/hana-signer` at develop 26fb70a built with `cargo near build non-reproducible-wasm --no-abi` (what
`deploy-contract` runs) on the machine that deployed it; another machine embeds other cargo registry paths and
gets another hash.

### Creating a signer with governance in place (mainnet-style)

`deploy-contract <env> --creation-plan [--wasm <reproducible build>] [--updater-public-key <pk>]
[--creation-public-key <pk>]` prints, and never sends, the signer account's first transaction: `DeployContract` +
`new(owner = council.dao, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs,
updater_keys: [<updater key>])` + `DeleteKey(<creation key>)`, signed by the creation key. It has **no `AddKey`**:
`new` installs the updater key itself with exactly `UPDATER_METHODS` and tracks it (an `AddKey` of the same key in
the batch would make that promise fail and leave the key untracked, which `deploy-contract` blocks on;
`docs/contract-interface.md` "new"). The mainnet run is the user's alone (`docs/governance-spec.md` "Migration plan →
Mainnet"); afterwards `deploy-contract <env>` must show no blockers.

### Blockers on the signer's keys

On a governance contract `deploy-contract` compares `view_access_key_list(<signer>)` with
`get_governance().updater_keys`:

- a full-access key on the signer stops every env without `allowSignerFullAccessKey` (only `local*` / `sandbox*`
  testnet manifests may set it; a test keeps it to sandbox-dev among committed ones). The fix is a `DeleteKey` signed
  by that key; afterwards code changes only through `propose_upgrade` / `execute_upgrade`;
- every function-call key that isn't a tracked updater key stops the plan (the fix: `DeleteKey` with the full-access
  key where one is allowed, else the owner's `delete_updater_key`, which may delete any key). The exception is the v1
  updater key, which the plan deletes itself;
- a tracked key with other methods, another receiver or more than 1 NEAR of allowance stops it; a tracked key missing
  from the account is a warning.

### Governance status for the admin portal (batch C hand-off)

The admin portal's "Security & monitoring" view (D83) and pending-upgrades page (D86) are built (batch C14, not
deployed; "Admin Worker" → [Security & monitoring](#security--monitoring-batch-c14)). They read the **API** and
**Watchdog** sources below. Not read by the portal yet (D334): the contract through the portal's own RPC, and the
council DAO (its policy and open proposals). So the `governance:status` findings about the owner account, the DAO's
policy and the delay floors still come from `admin <env> governance:status`. The sources, all read-only:

- **Contract** (through the portal's own RPC): the views and NEP-297 events in `docs/contract-interface.md`
  "Monitoring hand-off".
- **Council DAO**: `get_policy`, `get_last_proposal_id` and `get_proposals({from_index, limit})` on `council.dao` (=
  `owner` once `ownerKind` is `sputnik`): pending owner actions with their approvals (`votes`); expiry =
  `submission_time` + `proposal_period` (ns). A `FunctionCall` proposal's calls are `kind.FunctionCall.actions[i]`
  with base64 JSON `args`; `admin <env> owner:proposals --json` prints them decoded.
- **One snapshot**: `admin <env> governance:status --json` prints `{env, signer, owner: {account, kind},
  observedAtMs, contract: {codeHash, stateVersion}, config, governance, keyChanges, activeKids, signerKeys:
  [{publicKey, permission, tracked}], council: {dao, policy, openProposals}, findings: [string]}`. `findings` are the
  checks the portal must show as problems: untracked signer keys, a full-access key where none is allowed, a tracked
  key with the wrong permission or missing, paused, a pending upgrade / owner transfer / withdrawal, no watchdog, a
  due key change nobody executed, a contract owner other than the manifest's, a missing DAO, a council DAO whose
  `get_policy` isn't exactly the manifest's council at 2 of 3 for every kind (or can't be read), on-chain
  delays below the non-dev floors, and any active google key or pending google Add that Google's JWKS doesn't
  publish (or a JWKS it couldn't read; fetched only when there is a google key to check). The portal's Worker
  makes the same reads itself (`scripts/lib/admin-owner.ts` `governanceStatus` is the reference implementation).
- **API**: `GET /v1/governance` serves the contract part already normalised, with JWKS verdicts and the cron's last
  run ([below](#governance-status-get-v1governance)); not independent of Hana's main Cloudflare account.
- **Watchdog**: its own status (heartbeat, verdicts, actions, alerts, acks) from its `GET /status`, `/alerts`,
  `/actions` and `POST /alerts/:id/ack` (`apps/watchdog/README.md` "Status endpoint").

## Usage ledger (Neon, batch C)

The ledger's schema is `apps/api/migrations-usage/` (Postgres; D73), applied by `scripts/usage-migrate.ts`. The API
writes to it from batch C4 once its `USAGE_DB` binding is set up ("Usage capture" below). Neon Auth and Neon's other
services aren't used, only Postgres.

```sh
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev         # lists the pending files, changes nothing
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev --yes   # applies them
```

- It connects as the owner role with `DATABASE_URL_DIRECT` from `.secrets/<env>/neon.json` (0600), and refuses a URL
  that isn't a direct (non-`-pooler`) endpoint in `aws-ap-southeast-2` with `sslmode=require` (or `verify-full`). It
  never prints the URL or its password.
- Each file runs in its own transaction with its sha256 recorded in `hana_migrations.applied`, under an advisory lock.
  A file changed after it was applied, or an applied file the repo doesn't have, stops the run: add a new file instead.
- The schema creates the roles `usage_writer` (the API) and `usage_admin` (the admin Worker) `NOLOGIN`, with no
  password; `usage-setup <env> roles` gives them `LOGIN` and has Neon generate their passwords ("Usage capture" below).
- Files (also `0005_link_events.sql`: the link relays' events, `link` / `link_cancel` / `link_unlink`, email login
  batch 6): `0001_ledger.sql` (events, users, settlements, rates, statements, `ops`, `record_event`, roles and grants),
  `0002_identity_tokens.sql` (identity tokens per app and day, `record_identity_tokens`, batch C4),
  `0003_writer_partitions.sql` (the writer may run `ensure_partitions`; 12 months ahead created, batch C4),
  `0004_email_counts.sql` (email logins and new links per app and day, `record_email_counts`, email login batch 6, D233),
  `0006_reports.sql` (the report, ledger and statement functions, the settlement checks' columns and tables, the
  audited rate override; batch C12, D320), `0007_retention.sql` (the retention functions, the runs' status, the
  erasure log, the uid indexes; batch C13, D360–D369; "Retention" below).
- Monthly partitions of `usage.events`: 0001 creates the current month and the next 3, 0003 the next 12, and the
  API's hourly cron keeps 12 months ahead (`usage.ensure_partitions(12)` as the writer, `usage_partitions_failed` on
  a failure). An event outside every partition is lost (`usage_write_failed` `pg_23514`).
- Tests run on PGlite in process (`apps/api/test-usage`, D140); set `USAGE_TEST_DATABASE_URL` to a superuser URL of a
  local Postgres 18 (a container, never Neon) to run the same suite there.

## Usage capture (batch C4, milestone M2)

From batch C4 the API sends one usage event per request past the gate of `/v1/login`, `/v1/sessions`,
`/v1/derive`, `/v1/sessions/revoke` and `/v1/vault/unlock`, and per `/v1/owner-actions` request past the owner check,
to the Neon ledger through the Hyperdrive binding `USAGE_DB` (role `usage_writer`), after the response (`docs/api.md`
"Usage capture"). It no longer writes the D1 `usage` counters. **Logins never depend on it**: without the binding
capture is off; with Neon or Hyperdrive down every endpoint answers exactly as before and the lost event is logged.
The hourly cron also copies the last 7 days of identity token counts (`identity_usage`) to `usage.identity_tokens`,
and of email login counts (`email_usage`, from migration 0010) to `usage.email_counts` (D233).

### Setting it up on sandbox-dev (for the user; run from the main checkout)

Nothing here is run by an agent. Every command prints its plan and changes nothing without `--yes`; none prints a
password, a URL or a key. Prerequisites: `.secrets/sandbox-dev/neon.json` with `DATABASE_URL_DIRECT` (the owner,
direct endpoint), `project_id` and `branch_id`, a Neon API key in `.secrets/sandbox-dev/neon-api-key` (step 2), wrangler logged in to the Hana Cloudflare account, and Hyperdrive available on its plan (build plan
open question 3).

1. **Ledger schema** (applies `0002_identity_tokens.sql`, `0003_writer_partitions.sql`, and from email login batch 6
   `0004_email_counts.sql` and `0005_link_events.sql`; `0001` if it isn't yet):
   `corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev`, then the same with `--yes`.
2. **Role passwords** (D403). Neon takes only plain-text passwords, so Neon generates them through its API.
   1. **Create a Neon API key** (once; revoke it at the end of this step). In Neon's console, switch to the
      organization that owns the `hana-id` project, open **Settings → API keys**, click **Create new**, choose
      **Project-scoped**, pick the project `hana-id` and name the key `usage-setup sandbox-dev`. Project-scoped keys need
      an organization admin; on a personal account (no organization) use **Account settings → API keys → Create new**
      (a personal key: it reaches all your projects, so revoke it straight after). Neon shows the key **once**: copy it
      and, without pasting it anywhere else, save it from the clipboard:

      ```sh
      (umask 077; pbpaste > .secrets/sandbox-dev/neon-api-key) && pbcopy < /dev/null && ls -l .secrets/sandbox-dev/neon-api-key
      ```

      (`-rw-------`; the last command also empties the clipboard). `neon.json` must hold `project_id` and `branch_id`
      (the sandbox-dev branch's `br-…` id).
   2. **Plan**: `corepack pnpm --filter @hana-id/scripts usage-setup sandbox-dev roles`. It checks the key file (0600)
      and `neon.json` and prints the project, branch, endpoint and which role files it will write or **REPLACE**;
      nothing is sent to Neon.
   3. **Do it**: the same with `--yes`. It checks that the owner URL's endpoint is the branch's
      (`GET …/branches/<branch_id>/endpoints`); as the owner, that both roles exist and `ALTER ROLE usage_writer|usage_admin
      WITH LOGIN` with a random throwaway password (never stored or printed; Neon's reset refuses a role without one,
      `ROLE_PASSWORD_NOT_AVAILABLE`, seen on sandbox-dev 2026-11-05); then, per role, `POST …/branches/<branch_id>/roles/<role>/reset_password`: Neon generates
      the password, which goes straight into `.secrets/sandbox-dev/neon-usage-writer.url` / `neon-usage-admin.url`
      (0600: the owner's direct endpoint and database, the role, `sslmode=require`), never printed; it waits for Neon's
      operations to finish (a busy project, HTTP 423, is retried) and last logs in as each role with its file. A reset
      drops the endpoint's open connections. On a failure it prints the HTTP status and Neon's error code and message
      only; running it again resets both again. A reset that fails after the LOGIN step sets each role not yet reset
      `NOLOGIN` again (its throwaway password is dead-ended; D412), and says so; if even that fails, the message names
      the role and the `ALTER ROLE … NOLOGIN` to run as the owner.
   4. **Revoke the key** when it says both roles log in: Neon's console, the same **API keys** page → **Revoke** next to
      `usage-setup sandbox-dev`; then `rm .secrets/sandbox-dev/neon-api-key`. Create a new one for the next rotation.

   **Every run resets both passwords and replaces both files**: the old passwords stop working at once. Run `roles`
   before `hyperdrive`. If the Hyperdrive configs already exist (a later rotation), they still hold the old passwords:
   capture fails open (`usage_write_failed` `pg_28P01`) until they are re-created in step 3.
3. **Hyperdrive configs** (D412): first a short-lived Cloudflare API token. Dashboard → **My Profile** → **API Tokens** →
   **Create Token** → **Custom token**: name `usage-setup sandbox-dev`, permission **Account › Hyperdrive › Edit**
   only, on this env's account only, TTL today; then
   `umask 077; pbpaste > .secrets/sandbox-dev/cloudflare-hyperdrive-token` (one line, 0600). Then
   `usage-setup sandbox-dev hyperdrive --account-id <id>` (plan), then the same with `--yes`. Pass `--account-id`
   whenever the manifest's `cloudflare.accountId` is unset (sandbox-dev: `f0b1e2c42c3e5bd63992958a19d4abca`): a token
   with only Hyperdrive Edit can't list its accounts, so without it `--yes` stops with "The token lists no account"
   (nothing created; seen 2026-11-06): it creates `hana-id-usage-writer-sandbox-dev` and
   `hana-id-usage-admin-sandbox-dev` (the manifest's `usage` block names once it has one), caching disabled, through
   Cloudflare's API (`POST /accounts/<id>/hyperdrive/configs`) from the role files: each password goes only in the
   HTTPS body (Cloudflare keeps it write-only), never a process argument as `wrangler hyperdrive create
   --connection-string` would put it. It prints each config's id (not secret). The admin config is for the admin
   Worker (batch C8); create both now. **Delete the token** afterwards (the same page) and
   `rm .secrets/sandbox-dev/cloudflare-hyperdrive-token`.
   **After a `roles` re-run** (configs already there): `hyperdrive --yes` stops with "already exists" (Cloudflare's
   code 2017). Delete the old
   configs (`corepack pnpm --dir apps/api exec wrangler hyperdrive list`, then `… wrangler hyperdrive delete <id>` for
   each of the two), run `hyperdrive --yes` again, pass the new writer id to `gen … --usage-hyperdrive-id <id>` and
   deploy the API (step 6), and the new admin id to the admin Worker's `gen … --admin-hyperdrive-id <id>` and deploy it
   ("Admin Worker"). Capture is lost in between (fail open; logins are unaffected).
4. **`USER_ID_KEY`**: `usage-setup sandbox-dev user-id-key` (plan), then `--yes`: generates 32 random bytes (base64)
   into `.secrets/sandbox-dev/user-id-key` (0600, never replaced) and sets the API Worker's `USER_ID_KEY` through
   wrangler's stdin. **Make an offline backup of the file** (with the council backup, as `identity-sub-key`): the key
   is never rotated within a contract term, and losing it makes every user a new user in MAU and new-user counts
   (D96). Running it again sets the existing key again.
5. **Hot DB migration 0009** (`session_markers`, the `no_session` waiver's sign; D220):
   `corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote` (it lists
   `0009_session_markers.sql`; confirm).
6. **Bind and deploy**: `corepack pnpm --filter @hana-id/api gen sandbox-dev --usage-hyperdrive-id <writer id>` (it
   prints `usage capture: on`; later runs of `gen` keep the id for the same Worker and database), then
   `corepack pnpm --filter @hana-id/api run deploy`; `curl -s <apiUrl>/v1/health` shows `"hotDb":9`. The admin CLI's
   `app:changes:announce --remote` is refused until then (it needs `hotDb` ≥ 9: from C4 its waiver reads
   `session_markers`, which only the C4 API writes).
7. **Carry the legacy counters into markers, after the deploy** (the API before it still wrote `usage` rows and no
   markers, so a run before the deploy could miss the last ones). Once, idempotent, and again before C4b's 0007:

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "INSERT INTO session_markers (app_id, first_at) SELECT app_id, unixepoch('now') * 1000 FROM usage GROUP BY app_id ON CONFLICT (app_id) DO NOTHING"
   ```

8. **Gate: the writer logs in and the event lands.** Do not go on (no admin Worker, no partner relying on usage
   numbers, no C4b) until this passes. Log in on sandbox-dev (the demo or `apps/smoke`), then as the owner
   `SELECT endpoint, outcome, code, relayed, uid IS NOT NULL AS has_uid FROM usage.events ORDER BY received_at DESC
   LIMIT 5;` must show the login (`ok`, relayed, a uid), and the Worker logs no `usage_write_failed`. `roles` already
   proved each file's password logs in (D403), so `usage_write_failed` `pg_28P01` means the Hyperdrive config holds an
   older password (made before the last `roles` run: re-create it, step 3). Any other failure: stop, turn capture off
   ("Turning capture off" below; logins are unaffected) and report the code before going further; never set a
   password by hand instead. Optional, for the gas test's fixture: compare the event's `relay_gas_burnt` with the transaction's own sum
   (`tx` at FINAL: `transaction_outcome` plus every receipt) and keep that `tx` JSON (`apps/api/test/usage.test.ts` uses
   a hand-shaped one).

**Turning capture off** (e.g. a Neon incident that floods the logs): `gen sandbox-dev --usage-hyperdrive-id off` and
deploy. Logins are unaffected either way; events in between are not recorded.

### What to watch (Worker logs)

| Event | Meaning | Action |
|---|---|---|
| `usage_write_failed` (`code` `connection`, `attempt` 2) | Neon/Hyperdrive unreachable or slow for both tries: the event is lost (under-bills Hana, never a partner) | Check Neon and Hyperdrive status; the daily nonce cross-check (C12) shows lost relayed rows |
| `usage_write_failed` (`code` `pg_23514`) | No partition for the event's month | Look for `usage_partitions_failed`; as the owner, `SELECT usage.ensure_partitions(12);` |
| `usage_partitions_failed` (`code`) | The hourly `ensure_partitions(12)` failed (12 months are ahead, so there's time) | Check the writer's grant (`usage-migrate`: 0003) and Neon; the next hour retries |
| `usage_write_failed` (other `pg_*`) | The server refused it (e.g. `pg_42501`: the role lost its grant; `pg_28P01`: wrong password in the Hyperdrive config) | Re-run `usage-migrate`; for `pg_28P01`, re-create the Hyperdrive config from the current role file ("Usage capture" step 3; a `usage-setup … roles` run resets the passwords, so re-create the configs after it) |
| `usage_write_rejected` | The event failed UsageEvent v1 (`invalid_event`, never sent) or the function refused it (`pg_22023`) | A bug: the event's `problems` name the fields |
| `usage_uid_unavailable` | `missing_key` / `bad_key`: `USER_ID_KEY` unset or malformed (events recorded without uid); `bad_path`: a session path that doesn't parse for its scope | Set the key (step 4); `bad_path` should never happen |
| `identity_usage_sync_failed` | The hourly identity-count copy failed | Nothing: the next hour copies the last 7 days again |
| `first_session_write_failed` (`what` `scope` or `marker`) | One of the waiver's two hot-DB signs wasn't written | The other one stands; the next session attempt retries the scope's |

## Wallet directory (hot-DB migration 0011)

D310–D317 and D346 merged into `develop`. **On sandbox-dev since 2026-11-05**: `USER_ID_KEY` set, Time Travel bookmark
`00000308-00000000-0000511a-8c2d20dbe35ad898ca18c4aeeb9cbac9` taken before 0011, 0011 applied, then the API
(6141ba3d) and the pages (vault 95cd3408, auth 9f89b47b, rebuilt) deployed at `develop` 8aab09d; checked: a login
lists the user, both wallets and both identities in `user:find`; no other env yet. After each login the vault reports the wallet's Stellar and EVM
addresses, each signed by its own key, with the whole request signed by the session key, to `POST /v1/wallets/record`;
the API checks them against the live session on chain and keeps, in its own D1, each user with three ids (the User
ID partners see, `u1_…`, which is the identity token's `sub`; its Support ID `HANA-XXXX-XXXX`; the staff-only internal
id `hu_…`, the ledger's uid; D346), the wallets and the account's identities (`docs/architecture.md` "Wallet directory", `docs/api.md`). It never fails or
slows a login. There is no backfill: a user appears with wallets at their next login after the deploy.

**Prerequisites.** `USER_ID_KEY` on the API Worker (the uid key: "Usage capture" step 4, `usage-setup <env>
user-id-key`; it needs no Neon) and `IDENTITY_SUB_KEY` (the identity token's `sub` key, "Identity token keys"; already
set on every env that mints tokens, sandbox-dev included). Without either every record answers `503
directory_unavailable` and the API logs `directory_unavailable` (`no_user_id_key`, `no_sub_key` or `bad_sub_key`) at
most every 10 minutes per isolate; logins are unaffected. Never rotate either within a contract term: every user would
get a new internal id (`USER_ID_KEY`) or a new User ID and Support ID (`IDENTITY_SUB_KEY`, which also changes every
partner's token `sub`).

**Applying it on sandbox-dev** (the user runs this, from the main checkout once it is at the `develop` being deployed:
wrangler applies the migration file on disk, and on 2026-11-05 an older draft of 0011 without `token_sub` was applied
from a stale checkout, then dropped (the tables were empty) and the current file applied; additive, three new tables, no rollback
step: an older Worker ignores them). Take a Time Travel bookmark first ("Restoring a D1 database (Time Travel)"), then:

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations list hana-id-sandbox-dev --remote     # 0011_wallet_directory.sql pending
corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote
corepack pnpm --filter @hana-id/api run deploy                                                 # the API with /v1/wallets/record
# then the page Workers, so the vault sends the record ("Create an environment from scratch" step 9)
corepack pnpm --filter @hana-id/api run deploy:pages
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --d1                      # API, pages and bundles on this commit; 0011 applied
```

Order: the migration, then the API, then the vault bundle. In another order nothing breaks: an API without 0011
answers `503 directory_write_failed` and logs `directory_write_failed` (`no_table`), and a vault without the record
sends nothing. The API and the vault must both be at least `feat/user-id-identity-sub`'s: a vault without the
session signature gets `400 bad_request` from a newer API (and a newer vault's from an older API), so nothing is
recorded until both are deployed; logins are unaffected either way. `GET /v1/health` keeps `hotDb: 9` (D313). Other envs: the same with `hana-id-<env>`.

**Checking it.** Log in on the demo, then `admin sandbox-dev user:find --remote --address <the G… or 0x… address the
demo shows>`: one user, both wallets, the Google (or email) identity as the account root.

**Reading it** (Hana staff; `$A` as in "User directory (D269)"):

```sh
$A user:list --remote                            # each identity also shows its user (u1_… (HANA-…; internal hu_…)), role and wallets per scope
$A user:find --remote --address G…               # every user listing that wallet (warned when more than one)
$A user:find --remote --address 0x…              # any case
$A user:find --remote --user HANA-XXXX-XXXX      # any case, with or without HANA- and dashes
$A user:find --remote --user u1_…                # the User ID a partner sends (its token's sub; exact case)
$A user:find --remote --user hu_…                # the internal id (the ledger's uid; any case)
$A user:find --remote                            # an address, sub, wallet, User ID, internal id or Support ID on stdin
```

These read the API's D1 the way the issuer's is read (D316): locally the statement in a 0600 file under
`.secrets/tmp/` passed as `--file`, remotely D1's REST query endpoint on `cloudflare.d1Name`, wrangler's log file off,
errors never quoting the statement. `--address` and `--user` also work in an env without an email issuer (no
addresses then). A wallet listed under more than one user is a reused or exported key, or a record made from an
approved raw signature (D311): never treat a listed address as proof of who owns the wallet. Subs and addresses are
for this terminal only, as in "User directory (D269)".

**What to watch** (Worker logs): `directory_write_failed` (error: `no_table` before 0011, `internal` otherwise),
`directory_sync_failed` (warn, `near_unavailable`: an identity sync after a login or a link change couldn't read the
chain; the next one rewrites the account), `directory_unavailable` (warn, `no_user_id_key`, `no_sub_key` or
`bad_sub_key`: set the named key). The request log's `/v1/wallets/record` lines: `bad_wallet_record`,
`invalid_signature` (a record without its session's own signature: someone naming another user's session) or
`session_mismatch` in volume are someone probing, `stale_record` a vault with a wrong clock, `bad_request` in volume
right after a deploy a vault and API from before and after the session signature.

## Support ID lookup (batch C15)

Built in C15 (D276 as amended 2026-11-05, D394–D397) and its admin screen (D399), merged into `develop`, not
deployed. A user reads their
Support ID `HANA-XXXX-XXXX` on the Hana approval popup's account line; a partner page has it as `hana.supportId` (SDK
0.2.0 or later, D393; so in its diagnostics) and on the partner console's Users page beside the User ID. Partners
escalate with the code (or the User ID, `u1_…`), the error `code`, the time and the app, and the failed calls'
request IDs (`x-request-id`, `requestId` in every API error body; from SDK 0.2.0 the SDK's errors carry it as
`error.requestId` / `data.requestId`, and the demo's *Copy diagnostics* lists the latest five as `requestIds`, D405).

**Nothing to set up of its own.** The API's part (the code in the session answers, `AdminRpc.supportLookup`) goes live
with the next API deploy, after the wallet directory (above): no migration. The ledger part needs the usage ledger:
`USAGE_DB` on the admin Worker, `.secrets/<env>/neon-usage-admin.url` for the CLI (`usage-setup <env> roles`). On
sandbox-dev today usage capture is off, so both say "ledger unavailable" and show the rest.

**Looking a code up** (Hana staff; `$A` as in "User directory (D269)"):

```sh
$A support:lookup HANA-XXXX-XXXX --remote                                  # any case, with or without HANA- and dashes
$A support:lookup u1_… --remote                                            # the User ID the partner sends
$A support:lookup hu_… --remote                                            # the internal id
$A support:lookup HANA-XXXX-XXXX --remote --request-id <id> --request-id <id>   # the escalation's request IDs (≤ 20)
$A support:lookup HANA-XXXX-XXXX --remote --days 90                        # a wider window (1–731, 30 by default)
$A support:lookup - --remote                                               # the code on stdin
$A support:lookup HANA-XXXX-XXXX --remote --json                           # the whole report as JSON
```

The report lists every user with that code (two users can share one: pick the one in the scope of the app the partner
named), each with its User ID, internal id, accounts (provider, sub, role, address), wallets, the scope's apps, the
vault shares not yet expired (live or not), the apps' setting and policy changes in the window, and its ok login,
session and derive events (time, endpoint, app, latency, request ID, NEAR transaction). The request IDs' events come
whatever their outcome, with the code (`nonce_mismatch`, `near_error`, …) and `[this user]` when the event carries the
user's uid; a request ID with no event is an unknown one, a gate rejection (not recorded) or one from before capture.
Errors can't be listed per user: the ledger keeps a uid on successes only. No code? The user hasn't logged in since
the directory's deploy: ask the partner for the User ID or a wallet address (`user:find --address`). A wallet or a
sub: `user:find` first, then `support:lookup` with the User ID it prints.

It reads like `user:find` (the API's D1 privately, the issuer's D1 for the addresses) plus Neon as `usage_admin`; the
URL and password never reach an error. Read only: nothing changes on a lookup, and a code isn't a credential. Print
to the terminal only: never redirect the output to a file outside `.secrets/`.

**In the admin console** (the **Support ID lookup** screen, `/support`; with the admin Worker at M4): type the code,
User ID or internal id, the support reference (required: 1–64 letters, digits or `._#:-`, e.g. `ZD-1234`; no space
and no address, it is stored), and optionally the escalation's request IDs (≤ 20) and the window (1–731 days, 30 by
default), then **Look up**. The Users search sends a Support ID here (with a support reference typed there it runs at
once), and every wallet-directory user's block (a Users `find` answer, a user's detail) has a "Support ID lookup"
button that fills in the User ID and the ticket already given; "Wallet directory only" on the screen is the
`find` answer (no activity; the ticket is still required and recorded as `users.find`, D410). A match's sub opens
the Users detail at `/users/open` from memory (no sub in the URL). The screen calls `POST /api/support/lookup {query, ticket, requestIds?, days?}`
(`docs/api.md` "The Support ID lookup") and shows the CLI's report plus each identity's address: every match (a
collision lists each and says so; past 10 it says "Truncated"), their ids, identities with the issuer directory's
address (an unverified Google claim marked with the CLI's warning), wallets, apps, the vault shares not yet expired
(live, or revoked), the apps' changes, the ok ledger events, and the request IDs' events with their outcome and code; without the
ledger it says "Ledger unavailable: …" at the top and in each part, and shows the rest.

The lookup is recorded with the staff member's identity in the console's audit log before anything is read
(`support.lookup`, shown in the admin audit view; never in a partner's, never emailed; its details name the query's
kind, the ticket, the window and the request IDs themselves, `requestIdList`, D410). Each address is then read
from the issuer's directory with the same ticket, as `DirectoryRpc.get` with `purpose: 'support_lookup'`: the issuer
writes its own `support_lookup` row per identity (Audit → "Issuer directory reads", `detail.lookup` = the console
row's request id) and takes one row of that staff member's directory budget each (at most 20 identities per lookup).
Past the budget the addresses say "not read" with the window, and the security alias gets the same
`directory_budget` email as for the Users screen; without an issuer (an env with no `emailIssuer`) they say "directory
unavailable". Nothing here exports or downloads: the query and the answer stay in the page's memory (no URL, no
storage).

**An erasure request** still goes through `uid-erase` ("Retention"); afterwards the code finds nothing.

**What to watch** (admin Worker logs): `audit_failed` (route `POST /api/support/lookup`: the console didn't record the
lookup, so nothing was read: check the console Worker), `bff` lines with `code: ledger_unavailable` (no `USAGE_DB` or
Neon down) and `calls: {directoryRead, directoryMissing}` (the email join's counts), `directory_refused` (the issuer
refused a staff identity this Worker accepted: the "Users screen (C8b)" table's `502` row), `directory_budget`. The
API's `rpc` lines name `admin.supportLookup` and the issuer's `directory_read` lines `support_lookup`; none carries
the query, a sub or an address.

## Mainnet demo and key export events (hot-DB migration 0013, D428–D430)

Built on branch `feat/mainnet-demo-key-export` (not merged, not deployed). Spec: `docs/mainnet-demo-and-key-export-spec.md`.

**What it is.** The mainnet demo is an exception to D39 for the Sodax demo: a `pk_test_` app that Hana staff switch on
may sign on **Base (8453)** and **Stellar's public network**, nothing else, **at most $9.99 per transaction** (its
maximum fee included), each request through the approval popup with a red "Real funds, test custody" banner, the
value, and the wallet's balance (a warning above $10, never a block). Anything Hana can't value is refused (4100
`mainnet_demo_unknown_call` / `mainnet_demo_unpriced`; over the cap `mainnet_demo_over_cap`). It exists only in a
dev env (`local*`, `sandbox*`) on testnet: the CLI, the admin console, the API and the vault's own build all refuse it
anywhere else. The price table (`packages/core/src/mainnet-demo.ts` `MAINNET_DEMO`) expires on **2026-12-21**: after
that every demo request is refused (`mainnet_demo_prices_stale`) until someone reviews the prices and redeploys the
pages.

**Applying it on sandbox-dev** (the user runs this, from the main checkout at the `develop` being deployed; additive:
one column with two triggers and one table, no rollback step). Take a Time Travel bookmark first ("Restoring a D1
database (Time Travel)"), then:

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations list hana-id-sandbox-dev --remote     # 0013_mainnet_demo_events.sql pending
corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote
corepack pnpm --filter @hana-id/api gen sandbox-dev                                            # the auth Worker's MAINNET_DEMO_BALANCE var
corepack pnpm --filter @hana-id/api run deploy                                                 # GET /v1/app mainnetDemo, the events endpoint, key_exported
corepack pnpm --filter @hana-id/api run deploy:pages                                           # the vault, the banner, the export window
corepack pnpm --filter @hana-id/admin run deploy                                               # the switch and the events table
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --d1
```

Order: the migration first. In another order nothing breaks: an API without 0013 serves `mainnetDemo: false` and
records no event (each read and write falls back), and the CLI says "migration 0013 not applied".

**Turning it on for an app** (staff only; partners can't set it, and their console doesn't show it):

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:settings <app id | pk_test_…> --remote               # shows "mainnet demo: off"
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:settings <app id | pk_test_…> --mainnet-demo on --remote
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:settings <app id | pk_test_…> --mainnet-demo off --remote
```

or the admin console: the app's page, **Signing settings** → "Turn the mainnet demo on" (shown only in an env where
it can be set, and only for a test app). Each is immediate, an `app_changes` row (`mainnet_demo.on` / `.off`) and a
`settings_version` bump; open vaults follow within 10 s. `--mainnet-demo` goes alone (no other setting flag in the
same call).

**Seeing the usage.** Each demo signature and each key export is a row in `user_events` (no key, token, signature or
path): the admin console's **Users** detail and **Support ID lookup** list them under "Key exports and mainnet demo
signatures" (both by the user's internal id: exports recorded by the API, signatures reported by the user's own vault
session with its wallet proof, marked "reported by the vault"; at most 20 of each kind, so reports never hide an
export). By hand:

```sh
corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command \
  "SELECT kind, app_id, chain, network, address, usd_micros, datetime(at/1000,'unixepoch') FROM user_events ORDER BY at DESC LIMIT 50"
```

A `key_exported` row means the export window's fresh sign-in succeeded and the key could reach that window (shown or
copied or not). `key_export_unrecorded` in the API's logs (with `no_user_id_key`, `write_failed`…) means one wasn't
recorded. The rows are kept 24 months (the monthly retention job), and `uid-erase` deletes a user's rows with the rest
of an erasure request ("Retention" below, D433).

**Reviewing the prices.** Edit `MAINNET_DEMO` (prices, `reviewedAt`, `validUntilMs` at most 45 days on), keep each
price above the market, run `corepack pnpm --filter @hana-id/core test`, record it in `docs/decisions.md` (D429), and
redeploy the pages.

## Hot DB migration 0006 and the new gate (batch C3, milestone M1)

State on sandbox-dev (2026-11-03): done. Migrations 0006, 0009 and 0010 are applied to the API's D1, after a rehearsal on a scratch
D1; a Time Travel bookmark from before 0006 and an export backup are in `.secrets`. The API (`develop` c3c33ec, version
b215b589; redeployed 2026-11-04 at `develop` f53d63e, version 9fe0343a; again 2026-11-05 at `develop` 8aab09d, version 6141ba3d, with the wallet directory; the vault 95cd3408 and auth 9f89b47b pages with it, rebuilt) has the hot DB on and `createProof` true; usage capture is off (no `USAGE_DB` binding). The steps below are
the procedure for another env.

Migration `0006_dashboard_expand.sql` adds batch C's hot-DB tables and columns (`docs/api.md` "D1 schema") without
rebuilding a table, and backfills them: one `scopes` row per scope (in `org_legacy`, with the environment its keys
name), one `app_keys` row per app (its key), every origin in force from 0, Hana's suspension bit for suspended apps and
one `migration.baseline` row per app. The API built on it reads keys from `app_keys`, origins only once in force,
the suspension bits, and `scopes.environment` for the loopback rules. Existing apps answer exactly as before (tested on
a sandbox-dev-shaped database: `apps/api/test/migration-0006.test.ts`). On sandbox-dev it is the only unapplied file
(0008 is applied); wrangler applies unapplied files in name order. Run from the main checkout, logged in to the API's
Cloudflare account, with `corepack pnpm --filter @hana-id/api run gen sandbox-dev` done. Nothing here touches the chain.

1. **Check the data first** (reads only). Every scope must have one key prefix and every key one of the two, and no
   column the baseline copies into JSON may hold a BLOB (`json_object` refuses one); the migration aborts otherwise
   (as a whole on Miniflare; the rehearsal in step 3 shows what remote D1 does):

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT name FROM d1_migrations ORDER BY id"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT scope_id, COUNT(*) AS apps, COUNT(DISTINCT substr(publishable_key, 1, 8)) AS prefixes FROM apps GROUP BY scope_id"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT id FROM apps WHERE substr(publishable_key, 1, 8) NOT IN ('pk_test_', 'pk_live_')"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT id FROM apps WHERE 'blob' IN (typeof(auto_approve_policy), typeof(auto_approve_pending), typeof(auto_approve_effective_at), typeof(raw_sign), typeof(raw_sign_pending), typeof(raw_sign_effective_at), typeof(publishable_key)) UNION ALL SELECT app_id FROM app_origins WHERE typeof(origin) = 'blob'"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT (SELECT COUNT(*) FROM apps) AS apps, (SELECT COUNT(*) FROM app_origins) AS origins, (SELECT COUNT(*) FROM usage) AS usage, (SELECT COUNT(*) FROM vault_shares) AS shares, (SELECT COUNT(*) FROM identity_usage) AS identity"
   ```

   Expected: the migrations end with `0008_identity_token.sql` and have no `0006`; `prefixes` is 1 on every row; the
   third and fourth queries return nothing. Note the counts.

2. **Back up** (the export holds `vault_shares`, so it goes under `.secrets/`, 0600):

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-sandbox-dev        # note the bookmark: it undoes the migration
   corepack pnpm --dir apps/api exec wrangler d1 export hana-id-sandbox-dev --remote --output=../../.secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   chmod 600 .secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   ```

3. **Rehearse on a scratch remote D1** restored from that export, through the same path as the real apply (`wrangler
   d1 migrations apply` on the generated config's D1 binding) and the CLI. Note sandbox-dev's own `database_id` first
   (in `apps/api/wrangler.jsonc`, or `wrangler d1 info hana-id-sandbox-dev`): step d puts it back.

   ```sh
   # a. a scratch database holding the export (it prints the scratch id)
   corepack pnpm --dir apps/api exec wrangler d1 create hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --file=../../.secrets/sandbox-dev/d1-before-0006-<yyyymmdd>.sql
   # b. the config's D1 binding on the scratch database, then the real command (it lists 0006, then 0010 from email login batch 6)
   corepack pnpm --filter @hana-id/api run gen sandbox-dev --d1-name hana-id-sandbox-dev-rehearsal-0006 --d1-id <scratch id>
   corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev-rehearsal-0006 --remote
   # c. D1's implicit transaction per query (D207): the second statement fails, so the first must not be there (expect 0)
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --command "INSERT INTO plans (id, per_minute, per_day) VALUES ('rehearsal', 1, 1); INSERT INTO plans (id, per_minute, per_day) VALUES ('rehearsal', 1, 1)"
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev-rehearsal-0006 --remote --command "SELECT COUNT(*) AS n FROM plans WHERE id = 'rehearsal'"
   #    and one CLI compare-and-swap write each way, read back by the CLI (any app id from app:list)
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:list --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:suspend --app <app id> --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:resume --app <app id> --remote --d1-name hana-id-sandbox-dev-rehearsal-0006
   # d. the config back on sandbox-dev's own database (before anything else, above all a deploy), then drop the scratch one
   corepack pnpm --filter @hana-id/api run gen sandbox-dev --d1-id <sandbox-dev database id>
   corepack pnpm --dir apps/api exec wrangler d1 delete hana-id-sandbox-dev-rehearsal-0006
   ```

   Between b and d, run step 1's counts and step 5's checks against `hana-id-sandbox-dev-rehearsal-0006`: the counts
   equal, the step 5 numbers as expected, the count in c is 0, and each CLI write prints its new state (a stale or
   lost write would say "nothing was written"). If the migration fails, stop: nothing touched sandbox-dev; read the
   error (step 1's checks name the usual causes) and note whether the scratch database kept any new table. If the count
   in c is 1, D1 didn't run that query as one transaction: stop and report it (D207). Delete the scratch database either
   way (it holds the export's vault shares), after step d.

4. **Apply 0006** (from a checkout at the commit step 6 deploys, clean tree; "Checking a deploy"): `corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote`
   (it lists `0006_dashboard_expand.sql`, then any later file not applied yet: batch C4's `0009_session_markers.sql`
   and email login batch 6's `0010_login_methods.sql`, which only add a table and a defaulted column; confirm).

5. **Verify**: the counts of step 1 are unchanged, and

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT (SELECT COUNT(*) FROM scopes) AS scopes, (SELECT COUNT(*) FROM app_keys) AS keys, (SELECT COUNT(*) FROM app_changes WHERE kind = 'migration.baseline') AS baselines, (SELECT COUNT(*) FROM app_origins WHERE active_from IS NOT 0) AS not_in_force"
   ```

   gives one scope per distinct `scope_id`, `keys` = `baselines` = the apps count, and `not_in_force` 0.

6. **Deploy the API** (`corepack pnpm --filter @hana-id/api run deploy`), then check that it reports the new reads
   (`curl -s https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/health` shows `"hotDb":6`), a login on sandbox-dev
   (the demo, or `apps/smoke`) and `admin sandbox-dev app:list --remote` (every app `active` or `suspended(hana)` as
   before, its key, its origins).

7. **From now on use only this CLI** (below). It refuses proposals and announcements with `--remote` until
   `/v1/health` reports `hotDb` ≥ 6, so a proposal can't be made between steps 4 and 6. A checkout from before batch C3
   must not run `app:*` against sandbox-dev: its `app:origins:add` writes rows with `active_from` NULL, which never
   match, and its `app:create` is refused by the new triggers.

### Rolling the API back below batch C3 (rollback floor)

**The rollback floor is batch C3**: on a database with 0006 applied, run an API from before batch C3 only after
parking the pending origins. Such an API reads every `app_origins` row, so an origin that is only proposed (not yet
announced, or announced and still in its delay) would be in force for it. Its other reads work unchanged on the 0006
schema (new apps carry their key in `apps.publishable_key` too). Mandatory, in this order:

```sh
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:park --remote          # lists the rows not in force
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:park --remote --yes    # deletes them (origin.parked rows in app_changes)
corepack pnpm --dir apps/api exec wrangler rollback                                               # or deploy the older build
```

Park again right before the rollback if anyone proposed since. While the older API runs, make no proposals (the CLI
refuses them: `/v1/health` reports no `hotDb`). When batch C3 or later is deployed again,
`admin sandbox-dev app:origins:unpark --remote --yes` restores exactly the rows the park listed (`origin.parked` in
`app_changes`), each with its change's `active_from`, and only while that change is still open: an origin removed
while parked (`app:origins:remove` closes its change even with no row) or cancelled stays gone, and a row deleted any
other way is never brought back. Proposals not announced within 7 days are cancelled by the cron as usual, parked or not.

**Undo of the migration**: it only adds; a restore to the bookmark of step 2 (`time-travel restore`, "Restoring a D1
database" below) returns the database to before it, and the API from before batch C3 then works as it did. Writes
made after step 4 are lost with it.

## Console sink scope (batch C6, milestone M3)

`deploy-contract` keeps the manifest's `consoleAudiences` as the only clients of a dedicated Hana scope (`sN`, owner
`Owner::Near` = the manifest's `owner`, no shared login, no app, no origins; D93 Q7, D238), never of `global`. Before
batch C6 they were clients of `global`, where a console-client token whose nonce followed the session layout could
open a `global` session and derive that user's key. No user address changes (the path has no client id; spec "Address
impact"); console tokens lose that unused ability.

- **Fresh env:** one run registers the sink (`admin_register_scope`, contract-assigned id) before `global`, which gets
  only `googleClientIds`.
- **Existing env with the audiences in `global` (sandbox-dev):** one run sends `remove_client(global, "Near",
  provider, aud)` for each (immediate), then waits out the removed clients' quarantine (`change_delay_ms`: 60 s on
  sandbox-dev; the contract refuses to register a quarantined client in another scope) and registers the sink. The
  plan refuses (a blocker, before any removal) when this run couldn't register the sink right after: a quarantine
  that, with the run's 5 s margin, makes a wait over 10 min, or on a council env without `--approve-with` (the votes would come in between). Then move them by
  hand, removal and registration back to back. During the wait the audiences are clients of no scope: the contract
  still refuses an `AddClient` of them until the quarantine ends. `remove_client` takes `OwnerAuth::Near`, so it is sent by an `Owner::Near` of
  `global`: the manifest's owner (on a council env, a DAO proposal), or the account that owned the contract when
  `global` was registered, when its key is in `~/.near-credentials/testnet/` (the plan says which; when neither can
  send it, that is a blocker).
- **Re-runs:** an audience in a sink is reported as done. A sink is a scope whose every owner is a known Hana owner
  account: the manifest's `owner`, its council DAO, or one named with `--known-owner <a,b>` (e.g. the owner before
  the council transfer, if the sink was registered then). An audience registered in any other scope (another owner,
  an OIDC owner, other clients or shared login) is a blocker: someone claimed it, and only that scope's owners can
  remove it.

Setup on sandbox-dev (for the user, after the API with batch C6 is deployed; run from the main checkout):

```sh
corepack pnpm --filter @hana-id/scripts run deploy-contract sandbox-dev                    # dry run: the remove and register steps
corepack pnpm --filter @hana-id/scripts run deploy-contract sandbox-dev --approve-with <second council member> --yes
corepack pnpm --filter @hana-id/scripts run deploy-contract sandbox-dev                    # "Console sink scope "sN" holds …"
```

Check: `scope_for_client("google", <console aud>)` is the new `sN`, `get_scope("global").clients` has only
`googleClientIds`. The API itself needs no change: it checks console tokens against `get_config().console_audiences`,
not against `global`.

**Retiring a console client** (a new console OAuth client replaces the old one, D416). Both go through the sink: the
new one is registered beside the old, then the old one leaves.

1. Create the new client (setup step 11 below) and add it to `consoleAudiences` **beside** the old one; run
   `deploy-contract <env>` (dry run, then `--yes`; dev envs `--approve-with <second member>`): `set_console_audiences`
   with both, the new one registered in a sink (and an old one still in `global` moved out of it in the same run).
2. Switch the console to the new client (its secret, setup step 11.7), then **delete the old client in Google Cloud**
   (APIs & Services → Credentials): Google issues no token for it from then on.
3. Drop the old client from `consoleAudiences`. deploy-contract now refuses the sink that still holds it (`Console sink
   scope "sN" still holds …, no longer in consoleAudiences`), so remove it there first, through the owner:

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin <env> console:remove-audience <old aud> [--approve-with <second member>]        # plan
   corepack pnpm --filter @hana-id/scripts run admin <env> console:remove-audience <old aud> [--approve-with <second member>] --yes
   ```

   One `remove_client(sN, Near, google, <old aud>)` by the manifest's owner (on a council env, a DAO proposal; dev
   envs approve it with `--approve-with` in the same command), then a re-read of `get_scope` that confirms it is gone.
   It refuses an audience still in `consoleAudiences`, one in `global` or in no scope (nothing to do), a scope that
   isn't a Hana console sink (deploy-contract's own test, with the retired client allowed) or that the manifest's
   owner isn't an `Owner::Near` of, and the sink's last client.
4. `deploy-contract <env>` again: `set_console_audiences` with the new client only; the sink is reported as done.

sandbox-dev, 2026-11-06: the console client `…j6l32…` (created 2026-10-27, still a client of `global`) was replaced by
`…rs47…`: step 1 moved both into sink `s3`, the old client was deleted in Google Cloud, and `consoleAudiences` holds only
`…rs47…`; steps 3–4 are the user's (`console:remove-audience`, then `deploy-contract`).

The API's hourly cron also watches the owner pool that pays for owner actions: each `OWNER_RELAYER_KEYS` key below 25%
of its initial allowance (0.5 NEAR, deploy-contract's default; set the Worker var `OWNER_POOL_ALLOWANCE_YOCTO` when the
keys were added with another `--owner-relayer-allowance`) writes an `owner_allowance_low` security event, once a day.
Top it up by re-adding the key with a fresh allowance ("Relayer keys (either pool)").

## Partner console Worker (`apps/console`, batches C7, C9 and C10) and console-auth (`apps/console-auth`, C9)

The console Worker (`hana-id-console-<env>`, manifest `console.workerName`) holds `CONSOLE_DB` (orgs, members, invites,
owner grants, console sessions, the console's audit log), binds the API's `ConsoleRpc` (`API`) and serves the partner
SPA and its `/api/*` on `console.origin`. From C9 (branch `feat/batch-c-9`, not merged) its route is on in the config:
on a `workers.dev` origin (dev envs only, and only the Worker's own name: `https://<console.workerName>.<subdomain>.workers.dev`)
`workers_dev: true`, on any other host a Custom Domain route; preview URLs off (D294). The thin console-auth Worker
(`console.authWorkerName`) serves `console.authOrigin`, the Google client's only redirect URI host, and forwards
`GET /start` and `GET /callback` to the console's `AuthHandler`. `docs/api.md` "Console Worker and console-auth" lists
what both serve; D240–D244 and D290–D297 the readings.

Both need the dashboard blocks in the manifest (`console`, `files`, `admin`, `usage`, `email`, `ownerGrantDelayMs`;
`docs/batch-c-build-plan.md` setup step 12) and exactly one `["google", <client id>]` entry in `consoleAudiences`
(setup step 11, below): `gen` refuses an env without them, so sandbox-dev can't run them yet (Q3: the origins come
first). Partners can sign in once both are deployed with the secret set (milestone M4); invites need the admin
Worker's notices (C8), so without C8 no new partner can be invited (staff's `issueInvite` link only works after the
admin Worker's ack).

**C10 (partner management, branch `feat/batch-c-10`).** No new secret, binding or setup step: `gen` now also writes
`NETWORK` and `REFUSED_ORIGINS` (the API's origin rules, from the manifest), so redeploy the console after `gen`. The
step-ups use the same Google client and redirect URI as sign-in (`scope=openid`; `at_hash` is in the claim allow-list,
D342). Owner actions are relayed by the API's owner pool (its keys and allowance, "Owner actions"); `execute_change`
from the console needs nothing else. The partner **Users screen** is off until the wallet directory's
`ConsoleRpc.listUsers` / `getUser` are deployed in the API (D357): then set the console var `USERS_SCREEN = "1"` (in
`wrangler.jsonc` `vars` after `gen`, or a `--var` on deploy; `gen` doesn't write it) and redeploy the console; unset it
to hide the screen again. The client-proof helper (AddClient) asks the partner to register the helper page's address as
a redirect URI of their own client while they use it (D351); Hana's console client is unchanged.

### Setup step 11: the console's Google OAuth client (for the user, once per env)

In Google Cloud (the project of Hana's other clients), **APIs & Services → Credentials → Create OAuth client ID**:

1. Type **Web application**, name `Hana ID console <env>`.
2. **Authorized JavaScript origins: none.** No origin means Google Identity Services, One Tap and FedCM can't mint
   tokens for this client; only the code flow works (spec "Google client setup").
3. **Authorized redirect URIs: exactly one**, `<console.authOrigin>/callback` (for sandbox-dev
   `https://<console.authWorkerName>.<subdomain>.workers.dev/callback`). No loopback URI, not even for testing: the
   open-question spike below uses this one.
4. Scopes: nothing to add on the consent screen beyond `openid` and `email` (the console never asks for `profile`).
5. **Download JSON** and save it, without opening it in an editor that syncs, as
   `.secrets/<env>/console-google-client.json`, then `chmod 600` it (the directory is 0700). It holds the client
   secret; never paste it into a terminal, a chat or a ticket.
6. Put the client id (public) in `envs/<env>.json` `consoleAudiences` as `["google", "<id>.apps.googleusercontent.com"]`
   and, since console audiences live in the console sink scope, run the `deploy-contract` plan for it (C6, "Console sink
   scope"): dry run, then `--yes`.
7. The secret, through a pipe (from the repo root), after `gen` for the console:

   ```sh
   node -e 'process.stdout.write(require("./.secrets/<env>/console-google-client.json").web.client_secret)' \
     | corepack pnpm --dir apps/console exec wrangler secret put CONSOLE_GOOGLE_CLIENT_SECRET
   ```

   Rotation: create a second secret on the same client in Google Cloud, update the JSON file, run the pipe again,
   then delete the old secret in Google Cloud. Without the secret every callback answers the static page with `503`
   (`auth_callback` `not_configured` in `wrangler tail`); nothing else in the console needs it.

### Setting it up (once per env, milestone M4, for the user to run)

From the repo root of the main checkout, logged in to the API's Cloudflare account (`wrangler login`):

```sh
# 1. The console's D1 (setup step 5), next to the API's (APAC); note the id it prints (not a secret).
corepack pnpm --dir apps/console exec wrangler d1 create <console.d1Name> --location apac
# 2. The configs: the console with that id (apps/console/wrangler.jsonc), console-auth (apps/console-auth/wrangler.jsonc);
#    both gitignored.
corepack pnpm --filter @hana-id/console gen <env> --d1-id <uuid>
corepack pnpm --filter @hana-id/console-auth gen <env>
# 3. The schema: apps/console/migrations (0001, 0002) on the remote database.
corepack pnpm --dir apps/console exec wrangler d1 migrations apply <console.d1Name> --remote
# 4. The R2 buckets the config binds must exist before the first deploy: setup step 7, all three buckets with their
#    rules, as "Files Worker and logos" below says (the console binds LOGOS and STATEMENTS, the admin Worker EXPORTS).
#    The config also binds the Images binding (`images: {binding: "IMAGES"}`): see that section too.
# 5. The API first (its ConsoleRpc entrypoint, batch C5), then the console (`deploy` builds the SPA into dist/ first),
#    then its secret (setup step 11.7), then console-auth (its binding needs the console's AuthHandler).
corepack pnpm --filter @hana-id/api run deploy
corepack pnpm --filter @hana-id/console run deploy
corepack pnpm --filter @hana-id/console-auth run deploy
# 6. Every piece on this commit, the console's D1 migrations applied ("Checking a deploy").
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only api,console,console-auth --d1
```

- Check: `curl -sI <console.origin>/` is `200` with the console CSP; `curl -s <console.origin>/api/me` is `401
  unauthenticated`; `curl -sI <console.authOrigin>/` is `404` with `content-security-policy: default-src 'none'; …`;
  `curl -sI '<console.authOrigin>/start?f=x'` is the static `400` page. Then sign in from a browser as an invited member
  (`/invite#t=…` from the invite email, or `/signin` once a member). `wrangler tail <console.workerName>` shows
  `auth_start`, `auth_callback`, `auth_complete` with `outcome` and `code`, never an address, `sub`, token or cookie.
- The cron is one more trigger on the account (`0 * * * *`); the free plan allows 5 per account (the API and the
  watchdog have one each, per env). console-auth has none.
- `INVITE_LINK_KEY` and `CANCEL_LINK_KEY` are the **admin** Worker's (C8, setup step 10), never the console's: the
  console stores only the sha256 of each emailed link token, which the admin Worker sends with its ack (D240).
- `OWNER_GRANT_DELAY_MS` comes from the manifest's `ownerGrantDelayMs` (D145). If it is missing or out of range, the
  ack of a promotion's notice and every invite acceptance (sign-in's) refuse with `internal` (fail closed; the person
  sees `/signin#error=internal`); regenerate and redeploy.
- Neither Worker records invocation logs (`observability.logs.invocation_logs: false`): the URLs carry sign-in's handoff
  code and Google's `code` and `state`. Don't turn them on.
- Rollback: `wrangler rollback` in `apps/console` (or `apps/console-auth`). To take sign-in down at once without a
  rollback, delete console-auth's route (or the Worker): no new sign-in can complete, existing sessions keep working
  read-only until they expire; to end those too, revoke them (`UPDATE console_sessions SET revoked_at = …` reviewed by a
  second person, until the admin console's freeze and disable exist, C8). A schema problem is a new migration, never
  an edit of an applied one.

### Console code-flow spike (open question 1; D295)

Before C10 (step-ups and owner actions) is built against it, run this once on an env with setup step 11 done; the
console doesn't need to be deployed. It answers the spec's open question 1: does Google's code flow give the console
client an ID token with no `email` (and nothing else outside the API's claim allow-list) for `scope=openid`?

```sh
corepack pnpm --filter @hana-id/scripts console-code-flow-spike <env>             # both legs
corepack pnpm --filter @hana-id/scripts console-code-flow-spike <env> --leg openid  # the step-up leg only
```

For each leg the script prints a Google URL: open it in a browser, choose an account (repeat with a personal Gmail and
a Workspace account), sign in. Google sends the browser to `<console.authOrigin>/callback`; the page may not load, or
show "Sign-in didn't work" if console-auth is deployed (it exchanges nothing for a state it doesn't know): copy the whole
address from the address bar and paste it at the prompt (not echoed; the code in it works once, for a few minutes). The
script exchanges the code with the client secret (`.secrets/<env>/console-google-client.json`) and its own PKCE
verifier, checks the ID token (RS256 on Google's JWKS, `iss`, `aud`, `azp`, nonce, `exp`, `iat`) and prints JSON with
each leg's claim **names**, `outsideApiAllowList`, `hasEmailClaims`, `hasHd`, `hasAtHash`, `atHashMatches`, `passes`
and a verdict; never a token, an address, a `sub` or a code. Exit code 1 if a leg doesn't pass.

- `openid` leg `PASS`: open question 1 answered "yes"; nothing to change. `at_hash` (Google documents it on every
  server-flow ID token) is in the allow-list since D342, so a leg with it passes (`PASS … (at_hash included, D342)`)
  when it matches the access token; a mismatch is `FAIL: at_hash does not match`.
- `FAIL: Google added email or hd`: step-ups and owner actions stop until decided (the spec's fallback: accept the
  address after an explicit partner disclosure).
- `openid email` leg `PASS`: the console's sign-in accepts the token (D290); a `FAIL` there means sign-in would refuse
  every account: don't deploy the console until it is understood.

Record the result (the JSON, which holds no personal data, and the account kinds tried) in `docs/context.md` and the
answer in `docs/batch-c-spec.md` open question 1, as the email spike's was.

### What runs and what it keeps

- **Hourly cron** (`src/cron.ts`): invites that expired unaccepted get one `invite.expired` audit row and their owner
  grant cancelled; matured owner grants are recorded (`members.role = 'owner'`, `member.owner_granted`); invites are
  deleted 90 days after acceptance, revocation or expiry, sessions 30 days after they ended (network data at 90 days),
  auth flows, handoff codes and pending actions 24 h after expiry, and logos replaced more than 30 days ago (their rows
  first, then the R2 objects; the rows are put back if the delete fails, D301). At most 200 rows per step and run (100
  logos); a failing step is logged (`level: error`, the step and the error's class
  name) and the others still run. The audit log and owner grants are retention data (5 years, the admin Worker's monthly
  job, C13), never touched here.
- **`StaffRpc`** (the admin Worker's binding, C8): orgs, members (`setMember`), users (`disableUser`), freeze, invites
  (issue, revoke, the notice list and ack), owner grants (cancel), the audit feed and queries. Until C8 deploys nothing
  calls it; there is no CLI for it.
- **Pending actions** (C10): one row per fresh sign-in started, 5 minutes, used once; purged 24 h after expiry. They
  hold the canonical action and its decoded view, never a token. A step-up that ran writes its audit row
  (`step_up_id` = the action), a refused one `step_up.failed`.
- **Logs** carry ids and codes only: never an email (invitee, member or staff), a Google `sub`, a token or a hash.

### Restoring `CONSOLE_DB`

As "Restoring a D1 database (Time Travel)" below, from `apps/console` with its `wrangler.jsonc`, on `<console.d1Name>`.
The export holds members' emails and invitees' addresses: keep it under `.secrets/<env>/` (0600). What a restore loses:
invites, grants, member and role changes and sign-ins after the point (the audit rows of those writes too); **a member
removal, a demotion, a disable or a freeze made after the point is undone**: redo each through the admin console (or,
until C8, a direct D1 statement reviewed by a second person) before the console route is on again. Owner grants that
matured after the point mature again on the next cron run.

## Admin Worker (`apps/admin`, batch C8)

The Hana staff console (`hana-id-admin-<env>`, manifest `admin.workerName`) on `admin.origin`, behind Cloudflare
Access. It holds no D1: it calls the API's `AdminRpc` (`API`) and the console's `StaffRpc` (`CONSOLE`), keeps its
feed cursors and watcher state in the ledger's `ops` schema (`USAGE_DB`, Hyperdrive, role `usage_admin`), and sends
every email (SendGrid, its own key, D87, D401). Its 5-minute cron sends the **blocking notices** (a guarded change's clock, an invite link
and an owner grant's wait start only once every send was accepted), the **security feed** (app changes, console audit
rows, security events, after the fact) and the **on-chain watcher**'s emails (`docs/api.md` "Admin Worker"; D278–D285).
Deployed on sandbox-dev since 2026-11-06 (M4, on the personal Cloudflare account until the account move, D414; "What
sandbox-dev runs at M4"); nowhere else yet.

**Env label (D419).** On a non-production env every email subject starts with the env's label, and every body opens
with "Not production: this email is from Hana ID <env> (testnet), for testing.": `[SANDBOX]` (`sandbox*`),
`[STAGING]` (`staging*`), `[LOCAL]` (`local*`), `[TESTNET]` (any other testnet env); staff mail (the security alias,
the feed, alerts, `directory_budget`) and partner mail (invitations, guarded-change and owner-grant notices,
statements) alike, e.g. `[SANDBOX] [Hana ID sandbox-dev] You're invited to Acme on Hana ID`. `gen` writes it as the
`ENV_LABEL` var from the manifest (`@hana-id/env` `envAlertLabel`); the Worker uses it only when `NEAR_NETWORK` is
`testnet`, so production mail never carries one. A Worker deployed before D419 sends unlabelled mail until `gen` and a
redeploy.

**Once it runs in an env, stop using `admin <env> app:changes:announce`**: that announces a change without any email.
The admin Worker announces every staff proposal by email within 5 minutes. The CLI refuses it as soon as the
manifest has an `admin` block, deployed or not: sandbox-dev's has one since 2026-11-05, so its staff proposals wait for
the admin Worker (M4).

### Setting it up (once per env, milestone M4, for the user to run)

Prerequisites: the manifest's dashboard blocks (`docs/batch-c-build-plan.md` setup step 12; `gen` refuses an env
without them), the console set up ("Partner console Worker" above), and the ledger's roles and Hyperdrive configs
("Usage capture", steps 1–3: `usage-setup <env> hyperdrive` printed the **admin** config's id beside the writer's). From
the repo root of the main checkout, logged in to the API's Cloudflare account. Nothing below prints a secret.

1. **Cloudflare Access** (build plan setup step 8, D75, D88, D409). What it must be, whichever path makes it: one
   **self-hosted Access application** on `admin.origin`'s host (sandbox-dev, no Hana zone:
   `<admin.workerName>.<subdomain>.workers.dev`; production: the Custom Domain the config's `routes` creates, `gen`
   refusing workers.dev outside `local*`/`sandbox*`), **session 1 h**, the cookie HttpOnly and SameSite=Lax (the
   Worker's CSRF check assumes Lax), not in the App Launcher, **no service token** (the Worker refuses tokens without a
   `sub`), and Allow policies by env:
   - **`sandbox*`** (the user, 2026-11-05): Google only, **exact emails only**: one policy `Hana staff (<env>)`
     including each `admin.staffEmails` address and requiring the Google login method; the application allows only
     Google and redirects straight to it.
   - **Every other env** (D88): `Hana staff GitHub (<env>)` including the GitHub team `hana-admins` of
     `Hana-Technology` (the org requires 2FA), then `Hana staff (<env>)` as above (the exact-email Google fallback;
     never a domain rule); the application allows GitHub and Google (so no auto-redirect).

   `admin.staffEmails` (lowercased) is both the policy's list and the Worker's own second check. Until
   `admin.accessAud` is set (`UNSET`), every `/api/*` answers `503 access_unavailable`.

   **sandbox-dev** (the user, 2026-11-05; on the personal Cloudflare account until the account move, D414): team
   `bitter-hill-fe6f.cloudflareaccess.com` on the **Free plan**, the **Google** login method only, the staff
   `hello@ting.rocks` and `mark@hanawallet.io` (both Google Workspace accounts). The manifest's
   `admin.accessTeamDomain` (`hana-id-team-unset.cloudflareaccess.com`) and `admin.accessAud` (`UNSET`) are
   placeholders until `access-setup sandbox-dev --yes --write-manifest` replaces them: with them the admin Worker
   answers every `/api/*` `503 access_unavailable` and the email issuer's `DirectoryRpc` refuses every staff call
   (`access_unavailable`), both tested. After replacing them, `gen` and redeploy the issuer and the admin Worker (the
   issuer carries the same values as `ADMIN_ACCESS_*`).

   **Zero Trust stays on the free tier** (D408; the account's card is authorised for usage past the free limits, so
   sandbox must never get there). Free is 50 seats: a seat is a person who signs in through Access, and sandbox has 2
   (`admin.staffEmails`). Keep the policy to exact emails (never a domain, `everyone` or group rule), Google as the
   only login method (remove One-time PIN), and enable nothing else in Zero Trust (no Gateway, WARP enrolment, Browser
   Isolation, DLP or CASB: each is billed or metered per seat). `access-setup` enforces the parts it owns on `sandbox*`
   (D409): it only ever writes exact-email includes and Google as the only IdP, refuses more than 50 staff emails and
   warns above 10, `--check` reports any non-email include or other IdP on the application as drift, it notes other
   login methods on the account, and it touches nothing but this application and its policies. After setup and
   monthly: Zero Trust → Settings → Account → seat usage shows only the staff emails (remove any other seat), and
   Billing shows $0.00. Before adding staff or a Zero Trust feature, check it against the free limits first.

   **Script path** (`scripts/access-setup.ts`, from the repo root of the main checkout; nothing it prints is secret):
   1. **The Zero Trust team** (dashboard, once per Cloudflare account, on the API's account): Zero Trust → pick the
      team name (`<team>.cloudflareaccess.com`) → the **Free** plan.
   2. **The Google login method** (dashboard): Zero Trust → Settings → Authentication → Login methods → Add new →
      Google, with a Google OAuth client made for it (authorised redirect URI
      `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`), then **Test**. Other envs also need **GitHub**
      (Add new → GitHub, an OAuth app of the `Hana-Technology` org). The script reads login methods; it never makes one.
   3. **A short-lived, least-privilege API token** (dashboard → My Profile → API Tokens → Create Token → Create Custom
      Token), named `access-setup <env>`:
      - Permissions: **Account · Access: Apps and Policies · Edit** and **Account · Access: Organizations, Identity
        Providers, and Groups · Read** (Cloudflare's API reference calls the first "Write"), nothing else;
      - Account Resources: **Include · the API's account** only; Client IP Address Filtering: your current IP
        (optional); TTL: ends today.

      Cloudflare shows it **once**: copy it and save it from the clipboard without pasting it anywhere else:

      ```sh
      (umask 077; pbpaste > .secrets/<env>/cloudflare-access-token) && pbcopy < /dev/null && ls -l .secrets/<env>/cloudflare-access-token
      ```

      (`-rw-------`; the script refuses the file otherwise).
   4. **Plan, apply, check** (the account id is the API's Cloudflare account; without `--account-id` or
      `CLOUDFLARE_ACCOUNT_ID` the script uses the token's only account):

      ```sh
      corepack pnpm --filter @hana-id/scripts access-setup <env> --account-id <account id>        # the plan, changes nothing
      corepack pnpm --filter @hana-id/scripts access-setup <env> --account-id <account id> --yes --write-manifest
      corepack pnpm --filter @hana-id/scripts access-setup <env> --account-id <account id> --check  # exit 0: no drift
      ```

      The plan reads the team domain, the login methods (refusing without Google, or GitHub outside `sandbox*`, and
      saying where to add it), the policies by name and the application by host or name, and says per object
      `create`, `update (what differs)` or `matches`. `--yes` creates or updates the policies, then the application
      (PUT of the whole object: re-running is harmless; it never deletes anything), and prints the application id, the
      team domain and the AUD tag. `--write-manifest` puts the last two into `envs/<env>.json`'s `admin` block in place
      (or copy them by hand); commit that, then `gen` and deploy the admin Worker (step 4) and the email issuer (its
      `ADMIN_ACCESS_AUD` comes from the same block). `--check` compares Cloudflare with the manifest (emails, session,
      IdPs, policies attached and their order, cookie settings, team domain, AUD) and exits 1 on any difference.
      Errors carry the HTTP status, Cloudflare's error code and message, and for 401/403 the permission the call needs.
      The script refuses an application on every Worker (`all_workers`, which would front the admin Worker with
      another AUD), two applications matching the host or name, and duplicate policy names.
   5. **Revoke the token** once it's done: My Profile → API Tokens → `access-setup <env>` → Delete; then
      `rm .secrets/<env>/cloudflare-access-token`. Make a new one for the next change or check.

   Re-run steps 3–5 whenever `admin.staffEmails` changes (the policy follows the manifest; `--check` shows the
   difference first), and after any dashboard edit to the application, to put it back.

   **workers.dev** (sandbox-dev): the dashboard's toggle (the admin Worker → Settings → Domains & Routes →
   `workers.dev` → Enable Cloudflare Access) makes a Worker-level application (a `worker` destination, by the Worker's
   id), which the API can make too but only with the Worker's id, so the token would also need Workers Scripts Read.
   The script makes a **hostname** application instead, which Cloudflare documents for a `workers.dev` hostname
   ([Workers → Cloudflare Access](https://developers.cloudflare.com/workers/configuration/cloudflare-access/)). For
   the admin Worker the two are equivalent: its config has `preview_urls: false` and no routes, so the workers.dev
   hostname is all it serves (the Worker-level kind would also cover preview URLs and routes); both put a JWT with
   the application's AUD in `Cf-Access-Jwt-Assertion`. Don't use both: if the toggle was turned on, turn it off (or
   delete its application) first; the script points a Worker-level application out.

   **Dashboard path** (no token): Zero Trust → Access → Applications → Add an application → Self-hosted, with the
   settings above (name `Hana ID admin (<env>)`, the host, session 1 h, the login methods, Instant Auth for one IdP,
   cookie settings HttpOnly and SameSite Lax, App Launcher off) and reusable policies as above; copy the team domain
   (Settings → Custom Pages, or the application's Overview) and the AUD tag (Overview → Application Audience (AUD)
   Tag) into `admin.accessTeamDomain` and `admin.accessAud`. `access-setup <env> --check` then confirms it matches;
   `--check` only reads, so its token can have **Access: Apps and Policies · Read** instead of Edit.
2. **SendGrid** (step 9, D87, D401): `email.from`'s domain authenticated in SendGrid (SPF, DKIM, DMARC on the Hana
   zone; production: the dedicated notice subdomain), in the SendGrid account or subuser this Worker sends from, which
   is **never the email issuer's subuser** (its suppression list must stay the issuer's, D194). Production: a subuser
   for the admin Worker's mail (Pro plan and up). Then create a **restricted API key, Mail Send only** (Settings → API
   Keys → Create API Key → Restricted Access → Mail Send: Full Access, every other category No Access), for this Worker
   only (the issuer and the watchdog have their own). SendGrid shows it once. Save it to
   `.secrets/<env>/admin-sendgrid-key` (0600), never in a shell history or a chat:
   `umask 077; pbpaste > .secrets/<env>/admin-sendgrid-key` after copying it from SendGrid. A SendGrid key can't be
   limited to one sending domain (`docs/security.md` "Email keys"): keep it in this file and the Worker only.
   - sandbox-dev (2026-11-05): `email.from` is `Hana ID <team@hanawallet.io>`, the address the issuer already sends
     from. Create the admin key outside the issuer's subuser, in an account or subuser where `team@hanawallet.io` is
     verified (its authenticated domain, or a Single Sender verification of the address). Testnet only; a bounce
     there suppresses the address for that account's mail, not the issuer's. **As set up (2026-11-06, D414):** the
     SendGrid plan has no subusers, so the issuer, the admin Worker and the watchdog each have their own Mail-Send-only
     key in **one** account and share its suppression lists: a bounce or spam report on an admin notice also suppresses
     login codes to that address, and the other way round (alerts and blocking notices bypass the lists; codes don't).
     Accepted for testnet; to clear an address: SendGrid → Suppressions → remove it. Production keeps D194's own
     subuser for the issuer (row 4.9 of docs/mainnet-readiness.md).
   - SendGrid's 202 means accepted, not delivered. The admin Worker's alerts and blocking notices bypass the
     account's bounce, spam-report and unsubscribe lists (`docs/security.md` "Email keys"; invitee links, statement
     notices and the audit digest don't). After setup, send one notice to the alias and check it in SendGrid's
     **Activity** (Delivered, not Bounced or Blocked); an address on **Suppressions** that should get routine mail is
     removed there by hand.
3. **The link keys and the email key as secrets** (step 10). Each link key is 32 random bytes, base64, generated into
   `.secrets/<env>/` and sent through wrangler's stdin (never an argument, never printed). The admin Worker must exist
   first (step 4's first deploy, or `wrangler secret put` creates it):

   ```sh
   umask 077
   openssl rand -base64 32 > .secrets/<env>/cancel-link-key
   openssl rand -base64 32 > .secrets/<env>/invite-link-key
   corepack pnpm --dir apps/admin exec wrangler secret put CANCEL_LINK_KEY < .secrets/<env>/cancel-link-key
   corepack pnpm --dir apps/admin exec wrangler secret put INVITE_LINK_KEY < .secrets/<env>/invite-link-key
   corepack pnpm --dir apps/admin exec wrangler secret put EMAIL_API_KEY < .secrets/<env>/admin-sendgrid-key
   ```

   Rotating the email key: create the new restricted key, overwrite `.secrets/<env>/admin-sendgrid-key`, `wrangler
   secret put EMAIL_API_KEY` from it as above, check one notice goes out (`notice` lines with `sent`), then delete the
   old key in SendGrid (it is refused from then on). On a suspected leak, delete the old key first: notices wait (fail
   closed) until the new one is set.

   Keep `cancel-link-key` and `invite-link-key`: the tokens are deterministic per change, invite and grant, so a
   replaced key breaks every link already emailed and not yet used (cancel links until the change is in force, invite
   links for 7 days). Rotate only when no notice is pending, or accept that those links stop working (an owner or
   staff can still cancel in the consoles).
4. **Config and deploy** (with the admin Hyperdrive id, build plan setup step 4):

   ```sh
   corepack pnpm --filter @hana-id/admin gen <env> --admin-hyperdrive-id <admin Hyperdrive id>
   # The API and the console first (AdminRpc's watcher reads and StaffRpc's grants are C8 additions); with an email
   # issuer, it and its migration 0003 before both ("Users screen (C8b)" below: the ISSUER binding needs DirectoryRpc).
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/console run deploy
   corepack pnpm --filter @hana-id/admin run deploy
   corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only api,console,admin   # the admin's id through wrangler ("Checking a deploy")
   ```

   `gen` keeps the Hyperdrive id on later runs; `--admin-hyperdrive-id off` (dev envs only) leaves the feed and the
   watcher off. A production manifest needs the id.
5. **Check it**: open `admin.origin` (Access signs you in; the header shows your email and the env), list the orgs,
   then `corepack pnpm --dir apps/admin exec wrangler tail <admin.workerName>` across a 5-minute mark: one `cron`
   `done` line per run, `notice`, `feed` and `watcher` lines with ids, codes and counts only. "Feed and notices" in the
   SPA shows the backlog, each feed cursor's lag and the watcher's cursor.

- **The first run sends no history** (D344): a feed cursor with no row in `ops.state` starts at the source's current
  position, read silently (a `feed` line with `code: cursor_initialised`; a long history continues next run with
  `cursor_initialising`); only rows after it are emailed. Unnotified security events are still emailed. The watcher
  stores each scope's state as its baseline without an email.
- **Cron triggers**: two per env (`*/5 * * * *`, and C12's `*/15 * * * *`, whose 00:30 UTC run also does the daily
  ledger work, D329); the free plan allows 5 per account (the API, the watchdog and the console have one each per env),
  so two envs on one free account don't fit: the plan question (build plan open question 3). Each run makes at most 40
  outbound calls, every kind counted ("The crons' call budget" below); a backlog drains over the next runs.
- **Plan limits on sandbox-dev** (Workers Free plan, the user 2026-11-05; checked 2026-11-05 against Cloudflare's
  docs): sandbox-dev's API, console, admin and watchdog all run on the one account `f0b1e2c42c3e5bd63992958a19d4abca`
  (`watchdog.cloudflare.accountId`, the only account the operator's `wrangler whoami` lists; D125), so M4 puts it at
  exactly **5 cron triggers** (API `*/15`, console `0 * * * *`, admin `*/5` and `*/15`, watchdog `*/5`), the Free
  plan's limit ([Workers limits](https://developers.cloudflare.com/workers/platform/limits/): 5 per account): any other
  cron Worker on that account (another project's included) must go first. Also on Free: 10 ms CPU per request and per
  cron run, 50 subrequests (the crons' budget of 40 is under it); Hyperdrive, with 100 000 queries a day
  ([Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)); R2 after its checkout (an
  "R2 subscription", with a free monthly tier, [R2 get started](https://developers.cloudflare.com/r2/get-started/));
  bucket locks (no plan restriction in [their docs](https://developers.cloudflare.com/r2/buckets/bucket-locks/)); the
  Images binding, 5 000 unique transformations a month, after which new ones fail with error 9422 and nothing is
  billed ([Images pricing](https://developers.cloudflare.com/images/pricing/)); Zero Trust Free, up to 50 users
  ([plans](https://www.cloudflare.com/plans/sase-zero-trust.md)). The 10 ms CPU limit is the one to watch: a
  statement's PDF or a large export may exceed it (`docs/mainnet-readiness.md` 7.15).
- **Never past a free tier on the personal account** (D417, the user 2026-11-06; extends D408 from Zero Trust to every
  service sandbox-dev uses until the company account move, D414). The account has a card on file, so the rule is in
  the setup, not the billing:
  - **What could bill:** R2 (past 10 GB-month stored, 1 million Class A or 10 million Class B operations a month,
    [R2 pricing](https://developers.cloudflare.com/r2/pricing/)) and Zero Trust past 50 seats (D408). On the Workers
    Free plan the rest fails instead of billing: Workers (100 000 requests a day), D1, Durable Objects, Hyperdrive
    (100 000 queries a day), the Images binding (5 000 transformations a month, then error 9422). SendGrid's free plan
    (100 emails a day) refuses past its limit.
  - **Never, without asking the user first:** upgrade a plan (Workers Paid, Images paid, Neon or SendGrid paid),
    enable a paid or metered product or add-on (Logpush, Argo, Load Balancing, R2 Infrequent Access, Zero Trust's
    Gateway, WARP, Browser Isolation, DLP, CASB), make a bucket public or turn on `r2.dev`, or add a bucket beyond the
    manifest's three.
  - **R2 kept small:** test files only (a few MB of logos, statements and exports), exports expire after 30 days and
    statements' lock is 1 day (D402); no load tests or bulk uploads against sandbox-dev.
  - **Check after setup and monthly:** Cloudflare → Billing shows $0.00 and no new subscriptions; R2 → Overview's
    storage and operations; Zero Trust seat usage (D408). Above half of any free limit: stop and tell the user.
- **Rollback**: `wrangler rollback` in `apps/admin`. While the Worker is down or can't email, guarded changes, invites
  and owner grants stay unannounced (fail closed): nothing goes live without its notice, and the API cancels a change
  left unannounced for 7 days. `app:changes:announce` is the no-email fallback and needs Hana security's sign-off.

### Users screen (C8b)

The admin console's **Users** screen (D275, confirmed by the user 2026-11-05; D388–D392) reads the email issuer's user
directory through the issuer's `DirectoryRpc` entrypoint (bound as `ISSUER`; no route, no D1 binding), and joins the
wallet directory (`AdminRpc.findUsers`, `appNames`) and the chain (`get_identity`, `get_account`). The issuer checks
every call's Access JWT itself against the **admin** application (the manifest's `admin` block: no new Access
application, no new secret: the audit's keyed hash uses the issuer's `EMAIL_RL_KEY`), audits every read in
`email_admin_audit` (issuer migration 0003) and keeps the per-staff row budget (500 identities an hour, 2 000 a day,
provisional). A support reference is required to open a user, to search by sub or by a full address, and to find a
user in the wallet directory (a User ID, internal id or wallet: `POST /api/users/find`, recorded first in the
console's audit log as `users.find`, org-less, never emailed); browsing (a part of an address, the account kind, an
app, unverified claims) needs none (D410). An opened user's page is `/users/open`, opened from the tab's memory: no
sub in any URL, back and forward move between the users opened, and a reload or a copied link shows "No user open".
Deployed on sandbox-dev since 2026-11-06 with the admin Worker (personal account, D414); nowhere else yet.

**Deploy order** (for the user, from a clean checkout at the commit being deployed, logged in to the account; nothing
prints a secret; `<env>` throughout):

1. The manifest's `admin` block is set (with the real `accessAud`, not `UNSET`; `admin.staffEmails` is the list both
   Workers check), and the issuer's D1 has migration 0002 (`docs/operations.md` "User directory (D269)" if not).
2. **Issuer migration 0003** (rebuilds `email_admin_audit`, every row kept; the running issuer keeps working on it, so
   apply it first):

   ```sh
   corepack pnpm --filter @hana-id/email-issuer gen <env>        # keeps the D1 ids; now also writes ADMIN_ACCESS_* / ADMIN_STAFF_EMAILS
   corepack pnpm --dir apps/email-issuer exec wrangler d1 migrations list hana-id-email-issuer-<env> --remote   # 0003_directory_audit.sql pending
   corepack pnpm --dir apps/email-issuer exec wrangler d1 migrations apply hana-id-email-issuer-<env> --remote
   ```

3. **The issuer** (with `DirectoryRpc`): `corepack pnpm --filter @hana-id/email-issuer run deploy`.
4. **The API** (`AdminRpc.appNames`): its usual deploy (`docs/operations.md` "Deploying").
5. **The admin Worker**: `corepack pnpm --filter @hana-id/admin gen <env>` (adds the `ISSUER` service binding when the
   manifest has `emailIssuer`), then `corepack pnpm --filter @hana-id/admin run deploy`. In the other order the
   binding names a Worker or entrypoint that doesn't exist yet: wrangler refuses the deploy, or the screen answers
   `503 directory_unavailable`.
6. `corepack pnpm --filter @hana-id/scripts run deploy-check <env> --d1` (the issuer's D1 shows nothing pending).

**Check it**: in the admin console, Users → search a known address (your own test login) without a ticket → "A
support reference is required…", nothing read; again with `TEST-1` in the ticket field → one row; open it (the URL
stays `/users/open`) with the ticket (`TEST-1`, carried over) → the directory row, the apps by name, the wallet directory's User ID, Support ID, internal id
and wallets, and each scope's path with its block height. Its "Support ID lookup" button opens the lookup with the
User ID and `TEST-1` filled in; **Look up** → the same user with your address beside the identity (and "Ledger
unavailable" while `USAGE_DB` isn't bound). Searching Users for the Support ID with a ticket lands on the same
lookup; a User ID or wallet (with a ticket) still lists the wallet directory, and Audit → the console's rows show it
as `users.find` with its ticket. Audit → "Issuer directory reads" lists both reads under your
email (the search and the view, each with `TEST-1`), no address in either (after the lookup, its `support_lookup` row with the same ticket too). `wrangler tail
hana-id-email-issuer-<env>` shows `directory_read` lines with codes and counts only.

| Symptom | Meaning | Action |
|---|---|---|
| `503 directory_unavailable` on every Users call | no `ISSUER` binding (the env has no `emailIssuer`, or `gen` ran before it), the issuer isn't deployed with `DirectoryRpc`, or its `ADMIN_*` vars are missing (issuer log `directory_refused`, `access_config_missing`) or the Access certs are unreachable | regenerate and redeploy in the order above |
| `502 directory_refused` | the issuer refused a staff identity the admin Worker accepted: its `ADMIN_ACCESS_AUD` or `ADMIN_STAFF_EMAILS` differ from the admin Worker's (an issuer generated from an older manifest) | `gen <env>` and redeploy the issuer |
| `500 internal` from search or open, issuer log `directory_read_failed` | the read or its audit insert failed: migration 0003 isn't applied (no `detail` column), or D1 is down; nothing was returned and no row counted | apply 0003; else D1 status |
| `400 bad_request` "A support reference (ticket) is required…" on a search or a find | a search by sub or a full address, or a wallet-directory find, without a ticket (D410) | type the support reference in the ticket field |
| `503` / `500` from `POST /api/users/find`, admin log `audit_failed` | the console didn't record the find (`users.find`), so nothing was read | check the console Worker |
| `429 rate_limited`, an email `User directory budget reached by <staff>` to the alias | that staff member read 500 identities this hour (or 2 000 today); reads open again at the time shown | expected support work: wait; unexpected: treat the session as compromised (remove the person from the Access policy and `admin.staffEmails`, then review their rows in the audit view) |

- **Rollback**: the admin Worker's `wrangler rollback` hides the screen; the issuer's leaves the binding without an
  entrypoint (`503`). Migration 0003 stays (the older issuer code writes the same columns; `detail` stays null).
- **Retention** is unchanged: `admin <env> retention:issuer` still purges `email_admin_audit` past 60 months (now
  indexed on `at_ms`); `DirectoryRpc` writes nothing but its audit rows.

### The crons' call budget (D280, D380)

Each cron run is one invocation, and the Workers free plan allows it 50 subrequests; a call past that fails and the
run stops wherever it was. So each run has a budget of **40 outbound calls**, and every outbound call of every job
takes one: the run's Hyperdrive connection (charged once, its queries free: Cloudflare's docs don't count Hyperdrive,
so this is the cautious reading), every `AdminRpc` / `StaffRpc` call over the `API` and `CONSOLE` service bindings
(at most **30** of the 40: a request may make 32 Worker invocations, its own included), every email (one per
recipient), every NEAR read and every rate fetch. A job checks before each unit of work (a notice with every email
and its ack, a digest, a scope, a statement, a page with room for one unit after it) and stops cleanly before one
that doesn't fit; the next run carries on from its cursor, its queue or its `partial` row. The jobs, in order, and
what each can take:

| Cron | Job | Calls | Worst case in one run |
|---|---|---|---|
| `*/5` | `ops` | the ops connection, set aside first | 1 |
| `*/5` | `notices` | each page 1; a change notice: one per recipient + the ack; an invite: its org's name and contacts (once a run) + one per recipient + the invitee's link + the ack | all that is left (they block changes, invites and grants) |
| `*/5` | `feed` | each page 1; a digest: its org's contacts (once a run) + one per recipient (+ the mark for security events) | what the notices leave |
| `*/5` | `watcher` | `listScopes` 1; each scope `get_scope` + its org's contacts (once a run) + one per recipient; a SetAllowShared also `listApps` + a `getApp` per app | what is left, at most 15 scopes |
| `*/15` | `ledger` | the ledger connection | 1 |
| `*/15` | `relayer_keys` | `AdminRpc.relayerKeys` (only with `RELAYER_ACCOUNT`) | 1 |
| `*/15` | `nonce_check` (00:30 UTC) | one `view_access_key` per pool key | one per key |
| `*/15` | `retention` (from the 1st 01:00 UTC until a run ends `ok`) | each RPC 1 | 12 |
| `*/15` | `alerts`, `retention_alerts` | one email to the alias per digest | 3, 2 |
| `*/15` | `statement_notices` | per statement 2 RPCs + one per recipient (contacts, billing email, alias); at most 5 statements | what is left |
| `*/15` | `rates` (00:30 UTC) | one fetch per missing day of the last 10 | what is left, at most 10 |
| `*/15` | `settlement` | one `tx` per event read | what is left: **38** in a run with nothing else (≈ 3 600 a day) |

Measured worst cases (`apps/admin/test-ops/budget.test.ts`): a `*/15` 00:30 tick with every job due (a due retention
run, both alerts, six statements with three recipients each, ten missing rates, 60 events to settle) takes
`ledger 1, relayer_keys 1, nonce_check 2, retention 12, alerts 2, statement_notices 20, rates 2` = 40; settlement gets
nothing that run and its 60 events are settled in the next two, the other rates the next day. A `*/5` tick with 60
change notices (three recipients each) takes `ops 1, notices 37` (nine notices); the notices drain first, then the
feed and the watcher get their shares. Each run's shares are in its `budget` log line (`cron` or `ledger_cron`,
`count` and `calls`), and in `ops.state`: the 5-minute run's `cron.last_run`, the 15-minute run's `ledger_cron.last_run`
(D425: `{at, budgetLeft, calls, failed}`, written on the run's open connection, a query, not a call; the System status
page reads both).

### What to watch (Worker logs)

| Line | Meaning | Action |
|---|---|---|
| `cron` `email_api_key_missing`, `notice` `cancel_link_key_missing` / `invite_link_key_missing` (error) | A secret is missing or not 32 bytes of base64: nothing is acked | Set it (step 3) |
| `notice` `send_failed` (warn), with `target` | A recipient's send wasn't accepted (SendGrid refused it, answered other than `202`, or timed out); retried every run | Check SendGrid's status, the key (a 401/403 is a wrong, revoked or non-Mail-Send key) and the domain's DNS |
| A recipient got the same notice or digest twice | SendGrid has no idempotency key: a send whose answer was lost was sent again, or a retry ran in a fresh isolate (D401). Never a missing notice | None; expected rarely |
| `notice` `contacts_unavailable` | The org's security contacts couldn't be read (the API) | Check the API |
| `cron` `usage_db_missing` / `ops_unavailable` (error) | No `USAGE_DB` binding, or Neon/Hyperdrive down: the feed and the watcher don't run; notices still go out | `gen --admin-hyperdrive-id <id>`; Neon status |
| `feed` with `failed` > 0 | A digest wasn't accepted; its cursor waits | As `send_failed` |
| `notice` `out_of_budget` (warn); `cron` `budget` with `count` 38–40 run after run | The run's 40 calls were spent before a step's page: a backlog (D380); it drains over the next runs, blocking notices first | Expected after a burst; if it lasts hours, see "The crons' call budget" and the plan question (`docs/mainnet-readiness.md` 7.15) |
| `watcher` `near_unavailable` / `not_on_chain` | `get_scope` failed, or a hot-DB scope isn't on chain | NEAR RPC status; a scope row without a registered scope is a setup error |
| `access_refused` (warn) with `code` | An `/api/*` request without a valid staff token (`not_staff`: a valid Access identity not on `admin.staffEmails`) | Expected for strangers; for staff, check the manifest list and the Access policy |
| `access_refused` `access_config_missing` / `certs_unavailable` (error) | `accessAud` still `UNSET`, an unusable staff list, or the team's certs unreachable: every `/api/*` is 503 | Step 1; Cloudflare status |
| `watchdog_call` with a `code` (C14, below) | The "Security & monitoring" view couldn't read the watchdog | The table in "Security & monitoring" |

### Security & monitoring (batch C14)

The SPA's **Security & monitoring** (`/security/monitoring`), **Pending upgrades** (`/security/upgrades`) and
**Playbooks** (`/security/playbooks`) screens (D83, D86, D126; `docs/api.md` "Admin Worker", D330–D338). The admin
Worker reads the watchdog's `GET /status`, `/alerts` and `/actions` **server-side** with the bearer
`WATCHDOG_STATUS_TOKEN` (the browser never gets it), the API's governance snapshot through `AdminRpc.governance` (the
same as `GET /v1/governance`) and the recent security events, and lists the findings it derives (a silent watchdog, a
pause, a pending upgrade, owner transfer or withdrawal, a forged or unexecuted key change, an untracked signer key, an
unacknowledged critical alert, …), each with its playbook. The portal never alerts and never acts on chain: the
watchdog still sends every alert itself. Its one write is the **acknowledge** button on an unacknowledged critical
alert, which forwards `POST /alerts/:id/ack` with your Access identity (`<email> (access:<sub>)`): it **stops only that
alert's 15-minute re-sends**. It doesn't clear the condition, stop a first alert or change a check; a condition that
still holds stays in "Open alerts" and in the findings.

Setup (once per env, with or after the admin Worker's own setup above; for the user to run, from the repo root of the
main checkout; nothing below prints the token):

1. **The watchdog's URL in the manifest.** Add `watchdog.url` to `envs/<env>.json`: the watchdog Worker's https origin
   on **its own** Cloudflare account, `https://<watchdog.cloudflare.workerName>.<that account's subdomain>.workers.dev`
   (the URL its `wrangler deploy` printed, without a path; a custom domain is allowed). The schema refuses anything
   but an https origin, and a workers.dev host must name `watchdog.cloudflare.workerName`. Not a secret. A production
   manifest's admin `gen` refuses to run without it.
2. **The bearer as an admin secret.** The admin Worker's copy of `WATCHDOG_STATUS_TOKEN` is the one in
   `.secrets/<env>/watchdog-secrets.json` (written by `watchdog secrets <env> init`), sent through wrangler's stdin.
   `jq -e` fails instead of uploading `null` when the file has no token:

   ```sh
   jq -er .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json | corepack pnpm --dir apps/admin exec wrangler secret put WATCHDOG_STATUS_TOKEN
   ```

   The admin Worker reaches the watchdog over the public internet (`global_fetch_strictly_public`, set by `gen`): a
   Worker fetching a `workers.dev` URL on its own Cloudflare account otherwise gets Cloudflare's error 1042 page, which
   the Security & monitoring screen shows as `watchdog_bad_answer` (sandbox-dev, where the watchdog shares the API's
   account until the move, 2026-11-06).

3. **Config and deploy.** The API first (it gains `AdminRpc.governance` and both `pendingUpgrades`), then the admin
   (`gen` writes the `WATCHDOG_URL` and `NEAR_NETWORK` vars; the token is never in the config):

   ```sh
   corepack pnpm --filter @hana-id/api run gen <env>
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/admin gen <env>
   corepack pnpm --filter @hana-id/admin run deploy
   ```

4. **Check it.** Open `<admin.origin>/security/monitoring`: the Watchdog table shows the last run and the heartbeat,
   "Contract governance" the pause state, the pending key changes and the updater keys against the signer's keys.
   A `watchdog_unauthorized` means the two copies of the token differ (redo step 2 from the same file);
   `watchdog_unconfigured` means `WATCHDOG_URL` or the secret is missing here, or the watchdog has no token.
5. **sandbox-dev: acknowledge alert #11.** The watchdog's critical alert #11 on sandbox-dev is the expected
   `governance_change` of the updater-key change (the planned rotation, not an attack). It re-pages every 15 minutes
   until acknowledged. Once the view is up: Security & monitoring → Open alerts → #11 → **Acknowledge** (read the
   confirmation: it stops the re-sends only). The row then shows `acknowledged … via portal` with your identity, the
   "not acknowledged" finding goes, and the pages stop at the next 15-minute mark. Check the updater key it reported
   against "Updater keys against the signer's access keys" first: it must be the key `deploy-contract` installed
   (`.secrets/sandbox-dev/keys-updater.json`'s public key, `governance:status` lists it as tracked). This is
   `docs/mainnet-readiness.md` item 5.9, the first real test of the ack flow.

What the view's sources answer when they fail (each fails on its own: a watchdog that doesn't answer leaves the
governance part standing, and the other way round; Worker log line `watchdog_call` with the code):

| Code | Meaning | Action |
|---|---|---|
| `watchdog_unconfigured` | No `WATCHDOG_URL` var or no usable `WATCHDOG_STATUS_TOKEN` here (≥ 32 printable characters), or the watchdog answered 503 (no token of its own) | Steps 1–3; the watchdog's `secrets <env> check` |
| `watchdog_unauthorized` | The watchdog refused the bearer: the copies differ | Step 2 from the same file |
| `watchdog_timeout` | No full answer within 8 s (body included) | The watchdog's own account and logs; [watchdog-down](playbooks.md#watchdog-down) if `/status` is down too |
| `watchdog_too_large` | An answer over its cap (`/status` 1 MiB, `/alerts` 2 MiB, `/actions` 512 KiB, an ack 64 KiB; D331) | A runaway alert's deliveries: check `/alerts` with the curl in the playbooks |
| `watchdog_bad_answer` | Not a JSON object, or a redirect (never followed: it would carry the bearer elsewhere) | `watchdog.url` must be the Worker's own origin |
| `watchdog_unavailable` | Network error or a 5xx | Cloudflare status of the watchdog's account |
| `near_unavailable` (governance) | The API couldn't read the contract's views | NEAR RPC status; [near-rpc-outage](playbooks.md#near-rpc-outage) |

- **Rotating the token**: change it in `.secrets/<env>/watchdog-secrets.json`, upload it to the watchdog (its own
  account: `wrangler secret put WATCHDOG_STATUS_TOKEN` in `apps/watchdog`) and to the admin (step 2). In between the
  view answers `watchdog_unauthorized`; the watchdog's alerts are unaffected.
- **Playbooks** are the `@hana-id/playbooks` package bundled into the admin Worker: an edit there ships with the next
  admin deploy (and `gen-docs` for `docs/playbooks.md`). Their commands are shown verbatim, placeholders unfilled.

### System status (D425)

The admin console's landing page (`/`, nav **Status**): every part of the env at a glance, one verdict ("All systems
operational" only when every check answered and passed), the issues critical first with what each affects, since
when, what to do and where, and one tile per component (`apps/admin/README.md` "System status" lists every check and
its amber and red thresholds; `docs/api.md` "Admin Worker" the answer). Read-only. Read it first when something seems
off, and after every deploy beside `deploy-check`: the **Same build everywhere** tile is `deploy-check`'s comparison
from the public build reads (the admin's own var and the watchdog's `/status` `build` included), live.

**Deploy order** (once, for the user; each step's `run deploy` from the same clean checkout, then `deploy-check <env>`):

1. **Console D1 migration 0003** (`cron_runs`; the running console keeps working without it):
   `corepack pnpm --dir apps/console exec wrangler d1 migrations apply <console.d1Name> --remote`.
2. **The API** (`AdminRpc.systemStatus`), **the console** (`StaffRpc.health`, the cron's record), **the email issuer**
   (`DirectoryRpc.health`) and **the watchdog** (`/status` `build`; on its own account: `--only watchdog`).
3. **The admin Worker**: `corepack pnpm --filter @hana-id/admin gen <env>` (writes `API_URL`, `VAULT_ORIGIN`,
   `AUTH_ORIGIN`, `EMAIL_ISSUER_URL`, `CONSOLE_AUTH_ORIGIN`, `NEAR_RPC_FALLBACK`, `ACCOUNT_CRONS`; keeps the Hyperdrive
   id), then `corepack pnpm --filter @hana-id/admin run deploy`. In another order the page still loads: a Worker
   without its health method shows its D1 tile **Unknown** with "deployed before this release: deploy it", the console
   without 0003 "can't record its runs", a watchdog before D425 "doesn't report its build", an admin config before
   `gen` "cron triggers not counted".
4. **Check it**: `/` shows the verdict. A fresh deploy shows **Unknown** for the admin's 15-minute cron and the console's
   hourly one until each has recorded a run (15 min, 1 h).

**Budget**: a cold read makes 19 outbound calls (20 with the Access certs fetch of a cold isolate), within the Workers
Free plan's 50; the answer is kept 30 s in the isolate, so refreshes cost nothing. It adds nothing to the crons'
budget (D380): the 15-minute run writes `ledger_cron.last_run` on its open connection (a query). The two NEAR reads go to
the manifest's public RPC endpoints (`rpc`, `rpcFallback`): one `block` each per cold read.

**Not measured** (listed on the page with how to check meanwhile): Workers requests, D1, Durable Objects, Hyperdrive
and R2 usage against the free limits (Cloudflare's GraphQL Analytics needs an API token the admin Worker doesn't hold;
the monthly check under "Never past a free tier" stays the check, D417), SendGrid's daily sends (its key is Mail Send
only), the email issuer's own sends, the API's hourly jobs' outcomes (its logs), NEAR's MPC network
(`docs/mainnet-readiness.md` 5.12).

| Tile or issue | Meaning | Action |
|---|---|---|
| A Worker **Critical** "is down" | its public build endpoint didn't answer 2xx within 5 s (or redirected) | the Worker's logs; finish or roll back the deploy; `deploy-check <env>` |
| **Same build everywhere** Warning, "Mixed builds" | some pieces run another commit than the rest | deploy the lagging pieces from the same checkout ("Checking a deploy") |
| A D1 tile **Unknown**, "didn't answer this page's status call" | the Worker lacks its health method (deployed before D425) or its RPC failed | deploy it (step 2); else its logs |
| **Console hourly** Warning, "migration 0003 isn't applied" | the console can't record its runs | step 1 |
| A cron tile Warning or Critical, "late" / "hasn't run" | no recorded run within 2 intervals + 5 min / 6 intervals | the Worker's Settings → Triggers and logs; the account's cron count ("Plan limits on sandbox-dev") |
| **Watchdog** Critical | the admin can't read the watchdog | the table under "Security & monitoring" above maps each code |

### Pending upgrades page

`/security/upgrades` in the admin, and (from C10) the partner console's page on `GET
/api/orgs/:org/governance/pending-upgrades`, show what the contract owner has queued: an upgrade (code hash, its
source commit, reproducible-build command and the diff to the release before it), an owner transfer, a withdrawal,
delay decreases and console-audience additions, each with its countdown (D86, D333). Both read the same view, built in
the API from the governance snapshot.

The commit, build command and diff come from the release registry `CONTRACT_RELEASES` in
`packages/console-core/src/governance.ts`; a code hash that isn't listed there shows as **not a published release**.
Testnet upgrades are `non-reproducible-wasm` builds, so on sandbox-dev every pending upgrade shows that way, which is
accurate. Before the owner proposes an upgrade on an env whose builds are reproducible (mainnet, D86 Q14):

1. Build it (`cd contracts/hana-signer && cargo near build reproducible-wasm`) and note the code hash
   `deploy-contract <env> --upgrade` prints in its plan.
2. Add the release to `CONTRACT_RELEASES` (oldest first: `codeHash`, `version` from `Cargo.toml`, the full source
   `commit`, the reproducible `buildCommand`, `previousCommit` = the release before it); its test checks the shape and
   the chain of commits.
3. Merge and deploy the API (it serves the view), then propose. Partners then see the release beside the hash for the
   whole `governance_delay_ms`.

## Files Worker and logos (`apps/files`, batch C11, milestone M5)

Logos are written by the console (`POST /api/orgs/:org/apps/:app/logo`, routed for owners in C10; until then nothing
uploads one) and served by the files Worker (`hana-id-files-<env>`, `files.workerName`) on `files.origin`. The auth
pages show an app's logo beside its name, from `GET /v1/app`'s `logoUrl`. `docs/api.md` "Files Worker" and "Console
Worker" have the routes and checks; D300–D308 the readings. C10 (`feat/batch-c-10`) routes the upload behind the
session and the owner role; until an owner uploads one, an app without a logo gets exactly batch B's pages, messages and
policies.

It needs the dashboard blocks in the manifest (setup step 12), like the console.

### Setting it up (once per env, for the user to run)

From the repo root of the main checkout, logged in to the API's Cloudflare account (`wrangler login`). Bucket names
are the manifest's `files` block.

```sh
# 1. Setup step 7: the three R2 buckets (one set per env).
corepack pnpm --dir apps/files exec wrangler r2 bucket create <files.logosBucket>
corepack pnpm --dir apps/files exec wrangler r2 bucket create <files.statementsBucket>
corepack pnpm --dir apps/files exec wrangler r2 bucket create <files.exportsBucket>
# 2. STATEMENTS: one bucket-lock rule on every object. Objects can't be overwritten or deleted until it ends, by
#    anyone, the admin Worker included. Check it: `lock list`. The retention is per env (D402):
#    production: 7 years (2557 days with the leap days; D90, D308)
corepack pnpm --dir apps/files exec wrangler r2 bucket lock add <files.statementsBucket> statements-7y "" --retention-days 2557
#    sandbox-dev (and other sandbox* envs): 1 day, so testnet drill statements don't stay locked for 7 years (agreed
#    by the user 2026-11-05)
corepack pnpm --dir apps/files exec wrangler r2 bucket lock add hana-id-statements-sandbox-dev statements-1d "" --retention-days 1
corepack pnpm --dir apps/files exec wrangler r2 bucket lock list <files.statementsBucket>
# 3. EXPORTS: on-demand exports expire after 30 days. R2's lifecycle rules take a prefix to include, not one to exclude,
#    so the rule is on `exports/` (where C12 writes them) and the legacy export at `legacy/usage-<env>.csv` (C4b) is
#    outside it and kept (D308). Check it: `lifecycle list`.
corepack pnpm --dir apps/files exec wrangler r2 bucket lifecycle add <files.exportsBucket> exports-30d exports/ --expire-days 30
corepack pnpm --dir apps/files exec wrangler r2 bucket lifecycle list <files.exportsBucket>
#    LOGOS gets no rule: the console's hourly cron deletes replaced logos 30 days on (D301).
# 4. The files Worker's config (apps/files/wrangler.jsonc, gitignored; no id or secret in it) and its deploy. A
#    workers.dev files origin (sandbox-dev) must be `<files.workerName>.<subdomain>.workers.dev` (D307); any other
#    hostname becomes a Custom Domain on the Hana zone.
corepack pnpm --filter @hana-id/files gen <env>
corepack pnpm --filter @hana-id/files run deploy
# 5. The pages with the files origin: the API's gen writes FILES_ORIGIN into the auth page Worker's config, and the
#    page build puts it into the logo pages' meta policy; deploy both page Workers (vault first, then auth).
corepack pnpm --filter @hana-id/api run gen <env>
corepack pnpm --filter @hana-id/web build
corepack pnpm --filter @hana-id/api run deploy:pages
# 6. The API (GET /v1/app's logoUrl needs FILES_ORIGIN, which the same gen wrote) and the console (the IMAGES binding,
#    the logo backend). Deploy order doesn't matter for users: no app has a logo until an owner uploads one (C10's route).
corepack pnpm --filter @hana-id/api run deploy
corepack pnpm --filter @hana-id/console gen <env> --d1-id <uuid>
corepack pnpm --filter @hana-id/console run deploy
# 7. Every piece on this commit ("Checking a deploy"): the files Worker answers /.well-known/hana-build.
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only api,pages,console,files
```

- **The Images binding.** It needs no secret, only Cloudflare Images enabled on the account: dashboard → Images. The
  console's config binds it (`images: {binding: "IMAGES"}`); without it an upload answers `internal` and stores
  nothing. Before M5, check the plan's monthly transformation allowance and its price: each upload is one `info` of the input,
  one transform and one `info` of the output. Uploads are capped at 10 a minute per org (D301). At M5, confirm on
  the real binding that `fit: "pad"` with `background: "rgba(0,0,0,0)"` pads with transparency (D303, tested only
  against a fake).
- **Checks after the deploy.**
  - `curl -sI <files.origin>/logos/app_x/<64 zeros>.png` answers `404`, `content-type: text/plain`, `cache-control:
    no-store`, `content-security-policy: default-src 'none'; sandbox`.
  - `curl -sI <files.origin>/` answers `404`, and so does any other path.
  - `curl -s -D - -o /dev/null <authOrigin>/approve | grep -i content-security-policy` shows `img-src 'self' data:
    <files.origin>`, and `/login/callback` doesn't.
  - Once an owner uploads a logo (C10), its URL answers `200` with the seven headers of `docs/api.md` "Files
    Worker". The page shows it beside the app's name in the sign-in, approval and export windows.
- **What to watch** (`wrangler tail`):
  - The files Worker: `logo` `rejected` with a code (`not_png_type`, `not_png`, `hash_mismatch`, `too_large`)
    means an object in `LOGOS` that the console didn't write as it writes logos. Find out who wrote it (R2 has no
    per-object writer: check the console's `audit_log` `app.logo_set` rows and the account's audit log). `logo`
    `error` `r2_unavailable` is R2 down.
  - The console: `logo` `rejected` lines carry `logo_type:<reason>` (a refused file), `error` `internal` an Images or
    R2 failure, `files_origin_mismatch` an API and a console whose `FILES_ORIGIN` differ (regenerate both from the
    same manifest).
  - The auth page Worker: `auth_page` `files_origin_misconfigured` means a `FILES_ORIGIN` that isn't an origin. The
    pages still work, without the logo.
- **Rollback.**
  - The files Worker: `wrangler rollback` in `apps/files`. Logos then 404 and the pages show names only.
  - A bad logo on an app: an owner removes it (C10). Staff have `AdminRpc.setLogo` (`logoKey: null`), but the admin
    Worker (C8) has no screen or route for it yet. Until one exists, use a reviewed `UPDATE apps SET logo_key = NULL,
    settings_version = settings_version + 1` on the hot DB, checked by a second person. The pages stop showing the
    logo at once. The console marks an object for its cron only after its own removals, so after a staff removal the
    object stays in the bucket until deleted by hand (`wrangler r2 object delete`).
  - Never empty or delete `STATEMENTS` (it is locked); the lock rule can't be shortened for objects already under it.

## Local API (`wrangler dev`)

With a `USAGE_DB` binding (`gen --usage-hyperdrive-id`), `gen` also writes the binding's `localConnectionString`, an
unroutable placeholder (`usage-ledger.local.invalid`): `wrangler dev` starts, local requests answer as always, and
each local usage write fails at connect and is logged (`usage_write_failed` `connection`). Nothing local ever reaches
the env's ledger. To test capture locally, run a Postgres 18 container with `apps/api/migrations-usage` applied and set
`CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_USAGE_DB` to its URL for that shell (never a Neon URL).

```sh
corepack pnpm --filter @hana-id/api run gen <env> --dev-vars     # wrangler.jsonc + apps/api/.dev.vars (0600)
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local
corepack pnpm --filter @hana-id/api dev                          # http://localhost:8787
```

`gen` writes the gitignored `apps/api/wrangler.jsonc` for that env (needed by `dev` and `admin app:*`). `--dev-vars`
writes `RELAYER_KEYS`, `OWNER_RELAYER_KEYS` (single-quoted), `KEYS_UPDATER_KEY` and the identity token's
`IDENTITY_SIGNING_KEY` (the active key only; the standby stays offline) and `IDENTITY_SUB_KEY` (refused when the signing key isn't the
manifest's active key) from `.secrets/<env>/`, skipping missing files, and prints only a count. It rewrites the whole file and has no `VAULT_KEK`; for local vault endpoints
append a throwaway one (never a deployed env's) after each `gen --dev-vars`:

```sh
printf 'VAULT_KEK=1:%s\n' "$(openssl rand -base64 32)" >> apps/api/.dev.vars
```

`admin app:*` without `--remote` act on this local D1 (`apps/api/.wrangler/state`).

The page Workers run locally only for a `local*` env (loopback `vaultOrigin`/`authOrigin`; none is in `envs/` today,
`apps/e2e` starts its own stack), each in its own process: `wrangler dev` (the API), then `wrangler dev -c
wrangler.vault.jsonc` and `wrangler dev -c wrangler.auth.jsonc` in other terminals (they find each other through
wrangler's dev registry). A single `wrangler dev -c a -c b` serves only its first config over HTTP, so the vault page
couldn't reach the API; with a sandbox env's configs every page answers 404 (the local URL isn't the configured
origin).

## Reports and statements (batch C12, milestone M6)

The admin Worker settles the gas of every relayed event at FINAL, checks the relayer nonces and the rejection rate
daily, fetches the NEAR/USD rate, and issues the frozen monthly statements (CSV, PDF and on-screen, D92) with ledger CSV
exports; partners read their reports and statements through the console's routes (C10 routes them, `feat/batch-c-10`; the SPA screens are still to build) (`docs/api.md` "Admin
Worker", "Usage ledger functions"; D320–D329). Deployed on sandbox-dev since 2026-11-06 with the admin Worker (its crons run it there); production at milestone M6.

### Setting it up (once per env, for the user to run)

Prerequisites: the admin Worker set up ("Admin Worker" above, with its Hyperdrive id), the R2 buckets of "Files Worker
and logos" step 1 (`STATEMENTS` with its lock, `EXPORTS` with its lifecycle rule), and capture running ("Usage
capture"). From the repo root of the main checkout.

1. **The ledger migration**: `corepack pnpm --filter @hana-id/scripts usage-migrate <env>` (dry run: it lists
   `0006_reports.sql`), then the same with `--yes`. It adds functions, columns and tables, rewrites no row, and takes
   the admin role's direct `UPDATE` on `usage.near_usd_rates` away (overrides go through `usage.override_rate`).
2. **Optional: a CoinGecko demo key** (the free public API works without one, with lower limits). Save it to
   `.secrets/<env>/coingecko-api-key` (0600) and set it through stdin:
   `corepack pnpm --dir apps/admin exec wrangler secret put COINGECKO_API_KEY < .secrets/<env>/coingecko-api-key`.
3. **Config and deploy**: `corepack pnpm --filter @hana-id/admin gen <env>` (keeps the Hyperdrive id) now binds
   `STATEMENTS` and `EXPORTS`, sets `RELAYER_ACCOUNT` (the manifest's `relayer`; a statement names `NEAR_NETWORK`, C14's var), and adds the
   `*/15 * * * *` trigger. Deploy the API first (`ConsoleRpc.usage` / `statements` / `ledger`), then the console
   (`StaffRpc.recordStaffAction`), then the admin Worker:

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/console run deploy
   corepack pnpm --filter @hana-id/admin run deploy
   ```

4. **Check it**: `corepack pnpm --dir apps/admin exec wrangler tail <admin.workerName>` across a quarter hour:
   `ledger_cron` lines `alerts`, `statement_notices`, `settlement` with `outcome: ok`; at 00:30 UTC also `nonce_check`,
   `rejection_rate`, `partitions`, `rates`; last a `budget` line with the run's calls per job (at most 40, D380). The admin console's Rates screen shows the fetched days; the Feed and
   notices screen's ledger part shows each relayer key's nonce check, the settlement backlog and the partitions ahead.
5. **Rates for the past**: the daily run fills only the last 10 days. Before issuing a statement for an earlier month,
   set the missing days by hand (Rates → "Set a rate by hand", a reason naming the source), or the issue is refused.

### Issuing a monthly statement

From the 3rd of the next month (00:00 UTC), in the admin console: Statements → the org and month. It shows what still
blocks the issue: relayed events not settled yet (settlement reads them every 15 minutes; one not final after 24 h is
recorded unsettled and counted, never billed) and days without a rate; "Issue statement" stays disabled until all are
done, and is confirmed in the page. It freezes the statement: the CSV and PDF go
to `STATEMENTS` under new keys, the hashes and totals to `usage.statements`, a `statement.issued` audit row to the
console; within 15 minutes (a run or two later when many statements are issued at once: each takes 2 RPCs and an
email per recipient of the run's 40 calls, D380) the org's security contacts, its billing email and the security alias
get the statement hash.
A second issue for the month is refused; nothing is ever recomputed.

- **Late events** (received after the statement's `as_of`) stay in the ledger and show in the report as "after
  statement"; Hana handles them under the service contract.
- **Reconciling**: "Export ledger CSV" on an issued statement exports at its `as_of`; the sum of the `final` rows' gas
  and tokens equals the statement's `tgas` and `near` (owner actions included), and every `near_tx` can be checked at
  FINAL. Exports live 30 days under `exports/` (D308).
- **Tax invoices** come from the accounting software and quote the org, the month and the statement hash.

### Overriding a rate (audited)

Rates → override: the day, the USD price as a decimal (at most 6 places) and a reason of at least 10 characters. It
replaces the day's rate (`source: manual`, your email as `entered_by`) and appends a row to `usage.rate_overrides` with
the previous rate, in one transaction, plus a `rate.overridden` audit row. Refused for a future day and for any day of a
month that has a statement (the rates of a statement are frozen).

### What to watch (Worker logs and emails)

| Signal | Meaning | Action |
|---|---|---|
| Email "Relayer nonce unexplained" (`nonce_unexplained`) | A relayer key's last landed nonce has no ledger row: a usage write was lost (`usage_write_failed` in the API's logs), or something other than the API signed with the key | Treat it as a possible key leak until explained: check the API's logs for that hour; if no lost write explains it, follow `docs/playbooks.md` "A relayer key stolen" |
| Email "Settlement refused … events" (`settlement_mismatch`) | Relayed events not billed: a duplicate `near_tx`, a key outside the pools, or a transaction at FINAL signed by another key or nonce (D321) | Check the transaction on chain at FINAL and the API's logs for the request ids; if the API didn't write the event, rotate the usage writer's password (`usage-setup <env> roles`, then the writer's Hyperdrive config) |
| Email "Rejection rate over 5%" (`rejection_rate`) | An org had ≥ 100 relayed attempts in a day and more than 5 % were rejected after the relay (gas paid, not billed by default, D91) | Tell the partner; look for a client bug or third-party replays |
| `ledger_cron` `usage_db_missing` / `ledger_unavailable` (error) | No `USAGE_DB`, or Neon/Hyperdrive down: nothing settles, no checks, no notices | `gen --admin-hyperdrive-id <id>`; Neon status |
| `ledger_cron` `relayer_account_missing` / `relayer_keys_unavailable` (error) | No `RELAYER_ACCOUNT` var, or `AdminRpc.relayerKeys` failed: settlement and the nonce check don't run | Re-run `gen`; check the API |
| Security screen: settlement backlog growing | More relayed events than a run can read (at most 38 a run, fewer when notices or the monthly job take calls; D322, D380), or the RPC can't find them | NEAR RPC status; the `ledger_cron` `budget` line's `calls`; the plan's subrequest limit |
| Security screen: partitions ahead < 2 | Neither the API's hourly keeper nor the admin's daily one has run | Check both crons; `usage-migrate` re-runs nothing |
| `bff` `statement_hash_mismatch` (error) | A statement file no longer matches the hash frozen in Neon | Tell Hana security: the bucket lock should make this impossible |
| `bff`/`statement`/`export` `audit_failed` (error) | The act happened but its `audit_log` row wasn't written (the console was down) | Note it in the incident log; the statement row or the override row is the act's own record |

## Retention (batch C13, milestone M6)

D90's periods (to be confirmed by the company's accountant before launch, `docs/mainnet-readiness.md` 9.3): raw usage
24 months, then the uid is removed and the de-identified rows kept; settlement records 7 years, as whole months; audit
logs 5 years; the admin's own state 400 days. Key exports and mainnet demo signatures (the hot DB's `user_events`,
migration 0013) 24 months, as raw usage keeps its uid (D433). The admin Worker applies them in a monthly job; staff
see each run on the admin console's Retention screen (`docs/api.md` "Usage ledger retention functions", "Admin
Worker"; D360–D369). Not deployed anywhere yet: it goes live at milestone M6, after "Reports and statements".

What isn't automatic, by design:

- **Statements, NEAR/USD rates, rate overrides and the statement files** (7 years): the job only counts what is due
  (the screen's "Waiting for a person"); a person deletes them after review (below).
- **The email issuer's directory** (D269, D365): the admin Worker has no binding to the issuer's D1 (its `ISSUER`
  binding, C8b, is `DirectoryRpc`: reads only), so its part of the purge (the `user_email_apps` rows of apps deleted 30 days ago, `email_admin_audit` past 60 months) is
  `admin <env> retention:issuer`, run after each month's job. Its `user_emails` rows have no expiry (D269); an erasure
  request removes them with `uid-erase`.
- **An end user's erasure request**: `uid-erase` (below), per scope.
- **D1 Time Travel and Neon point-in-time restore** keep deleted rows for their own windows (30 days and the plan's).

### Setting it up (once per env, for the user to run)

Prerequisites: "Reports and statements" set up (the admin Worker with its Hyperdrive id and the 15-minute trigger) and
its migration 0006 applied. From the repo root of the main checkout; nothing here was run by the batch.

1. **The ledger migration**: `corepack pnpm --filter @hana-id/scripts usage-migrate <env>` (dry run: it lists
   `0007_retention.sql`), then the same with `--yes`. It adds functions, an erasure table, three indexes on
   `usage.events` and `usage.app_users` (on a large ledger the `events (uid, at)` index takes a while: run it off-peak),
   and the runs' new columns; it deletes nothing.
2. **Deploy** the API (`AdminRpc.purgeAudit` / `deletedApps` / `purgeDirectory` / `purgeUserEvents`) and the console
   (`StaffRpc.purgeAudit`) before the admin Worker; until both run C13, the job's RPC steps fail (`retention_failed`)
   and its Neon steps still run (an API without `purgeUserEvents`, D433, fails the `user_events` step only). An API
   whose D1 lacks migration 0013 answers it with zeros. No new binding, var, secret or trigger: `gen` is unchanged.

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/console run deploy
   corepack pnpm --filter @hana-id/admin run deploy
   ```

3. **Check it**: the Retention screen shows the month's state and next run. On the 1st, from 01:00 UTC,
   `wrangler tail <admin.workerName>` shows `ledger_cron` `retention` and `retention_alerts` with `outcome: ok`, and
   the screen a run `ok` (or `partial`, continued every 15 minutes). Before the 1st the state is "not due yet".

### The monthly job

From the 1st at 01:00 UTC, in each 15-minute run until a run of the month completes (`ok`), after the daily work and
before the alerts, taking at most 12 of the run's 40 outbound calls (D280): `strip_uids`, `drop_expired_partitions`,
`ops.purge_expired` and `retention_due` on Neon, then the deleted apps' `app_users` (`AdminRpc.deletedApps`), the
wallet directory of scopes left without apps (`AdminRpc.purgeDirectory`, D363), the `user_events` older than 24 months
and those of scopes left without apps (`AdminRpc.purgeUserEvents`, D433) and the audit purges of the hot DB and the
console (`purgeAudit`, D364). A run that runs out of calls ends `partial` and the next run continues; a `failed` run
is retried an hour later; a run still `running` after 30 minutes was killed and is closed as `failed` (`abandoned`).
Every step is idempotent, so a repeat never deletes twice or more than D90 allows (each RPC also clamps its cutoff).

### `admin <env> retention:issuer` (monthly, after the job)

```sh
corepack pnpm --filter @hana-id/scripts admin <env> retention:issuer --remote          # counts, changes nothing
corepack pnpm --filter @hana-id/scripts admin <env> retention:issuer --remote --yes    # deletes
```

Reads the apps deleted 30 days ago or more from the API's D1 (ids only) and deletes their `user_email_apps` rows in
the issuer's D1, and the issuer's `email_admin_audit` rows older than 60 months. The issuer's statements go through
D1's REST API as the operator, as `user:*` (never in a process argument). Re-running it finds nothing.

### An erasure request (`uid-erase`)

For one scope; the support reference is required, and the ticket must not hold the requester's address (it is
stored). Find the identity first with `admin <env> user:find` (its provider and sub, the scopes it is in).

```sh
corepack pnpm --filter @hana-id/scripts uid-erase <env> --scope <scope> --provider <google|email> --sub - --ticket <ref> --remote          # the plan
corepack pnpm --filter @hana-id/scripts uid-erase <env> --scope <scope> --provider <google|email> --sub - --ticket <ref> --remote --yes    # erases
```

- It reads the account from the chain (`get_identity`, `get_account`: the root and its members; a failed read stops
  it), computes the uids with `.secrets/<env>/user-id-key` and connects to the ledger as `usage_admin` with
  `.secrets/<env>/neon-usage-admin.url` (both 0600, never printed; `--no-ledger` for an env without a ledger). `--sub -`
  reads the sub from stdin, out of the shell history.
- The plan counts, per store: the ledger's events losing their uid and `app_users` rows; the wallet directory's users,
  wallets and identities, and the `user_events` rows (key exports, mainnet demo signatures; D433) of those users and of
  every wallet address of theirs (the directory's wallets and their own events' addresses, in any scope: another row
  with one of them came from the same key; never printed, only counted; "none" when the D1 has no migration 0013); the
  issuer's app rows of the scope and the address rows that would have no app row left.
  It lists the other scopes the account's identities are seen in: run it again for each.
- `--yes` erases in that order, counts again (all zero, or it stops with an error: run it again, every step is
  idempotent), and records the erasure in `ops.erasures` (ticket, operator, scope, counts; never whom). The Retention
  screen lists the last 20.
- An erasure made before `uid-erase` covered `user_events` (D433) left them: run it again. The user's own rows go by
  internal id; rows of other users that carry only an address from the (since deleted) wallet rows can't be found any
  more and age out after 24 months.
- **Nothing on chain changes** (D366): the identities, the account and the paths stay, so the user's wallets are the
  same. If they log in through Hana again, new rows are written; a new request covers those.
- Billing and counts don't change: the events stay, without their uid.

### Deleting statements and rates past 7 years (by hand)

When the screen's "Waiting for a person" lists statements or rates past 7 years, a founder reviews them (no open
dispute for those months) and then, as the owner over `DATABASE_URL_DIRECT`, in one transaction: export the rows to
the incident log, `ALTER TABLE … DISABLE TRIGGER` the `statements_frozen` / `rates_frozen` / `rate_overrides_frozen`
trigger, delete the months' rows, `ENABLE TRIGGER`. The files leave `STATEMENTS` once the bucket lock's 7 years have
passed (the lock refuses earlier). Not scripted: it happens once a year at most and needs a person's review.

### What to watch

| Signal | Meaning | Action |
|---|---|---|
| Email "Retention job failed" (`retention_failed`) | A run failed: the error names the step and a code (`directory: internal`, `strip_uids: pg_57014`, `console_audit: TypeError`) | The other steps did their part. Fix the cause (the API or console not on C13, Neon down, a timeout); the job retries an hour after each failure. At most one digest a day; every failure shows on the screen at once |
| Email "Retention job overdue for …" | No complete run a day after the 1st 01:00 UTC: runs keep ending `partial` (more rows than a month's calls reach), or none start | The screen's runs show which; a first run on a large ledger drains over the following 15-minute runs |
| Email "Retention job skipped for …" | At the due tick the ledger was unreachable (`USAGE_DB` missing, or Neon down): nothing could be recorded | `gen --admin-hyperdrive-id <id>`; Neon status. The job starts once the ledger is back |
| `ledger_cron` `retention` `outcome: error` | The run's bookkeeping on Neon failed before or after its steps | Neon status; the next 15-minute run tries again |
| Screen: a run `failed` with `abandoned` | The Worker was stopped mid-run (a deploy, a limit) | Nothing: it is retried an hour later |

## Admin CLI (`scripts/admin.ts`)

```text
admin <env> app:create --org org_legacy --name <name> --scope <scope_id> [--environment test|live] --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:origins:remove --app <app id | publishable key> --origin <origin> [--origin …] [--remote]
admin <env> app:suspend        --app <app id | publishable key> [--remote]
admin <env> app:resume         --app <app id | publishable key> [--remote]
admin <env> app:list [--remote]
admin <env> app:changes:announce <change id> [--remote]
admin <env> app:origins:park [--yes] [--remote]      # before running an API from before batch C3 (rollback floor)
admin <env> app:origins:unpark [--yes] [--remote]    # after redeploying batch C3 or later
admin <env> <app:* command> … --d1-name <name containing "rehearsal">   # on a rehearsal database (M1 step 3)
admin <env> app:settings <app id | publishable key> [--persistence session|none] [--session-ttl 12h] [--idle-ttl 2h]
             [--raw-sign off|approval] [--google-web-client <client id>|default] [--auto-approve <policy.json>|off] [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
             [--member <council member>] [--approve-with <council member>] [--yes]
admin <env> scope:add-email-client --scope <scope id> [--yes]      # dev envs only (local*, sandbox*), D253
admin <env> issuer-keys:lead-times [--remote]
admin <env> owner:call <method> [--args '<json>'] [--gas <Tgas>] [--member <m>] [--approve-with <m>] [--yes]
admin <env> issuer:iss <provider> --add <iss> | --remove <iss> [--member <m>] [--approve-with <m>] [--yes]   # D404
admin <env> console:remove-audience <aud> [--provider google] [--member <m>] [--approve-with <m>] [--yes]   # retire a console client from its sink, D416
admin <env> owner:vote <proposal id> --member <m> [--reject] [--yes]
admin <env> owner:proposals [--limit 20] [--json]
admin <env> governance:status [--json]
admin <env> council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
admin <env> user:list [--app <app id>] [--provider email|google] [--search <part of the address> | -] [--limit 50] [--json] [--remote]
admin <env> user:find [--email <address> | --sub <sub> | --address <G…|0x…> | --user <u1_…|hu_…|HANA-XXXX-XXXX>] [--provider email|google] [--json] [--remote]   # none: read from stdin
admin <env> retention:issuer [--yes] [--remote]      # the issuer's part of the monthly retention (C13, D365)
admin <env> support:lookup <HANA-XXXX-XXXX | u1_… | hu_… | -> [--request-id <id>]… [--days 30] [--json] [--remote]   # C15, D397
```

The `user:*` commands read the user directory in the email issuer's own D1, read only: "User directory (D269)" under
"Email issuer". `retention:issuer` and the erasure script `uid-erase`: "Retention" above. `support:lookup`: "Support ID lookup" above.

The `owner:*`, `council:*` and `governance:status` commands: [Governance](#governance-owner-council-upgrades-migration)
("Owner actions through the council", "Replacing a council member").

Run as `corepack pnpm --filter @hana-id/scripts run admin <env> <command> …`. Unknown flags are errors.

- `scope:register`: `admin_register_scope` through the owner (`owner`'s keychain key, or a council proposal with
  `--member` / `--approve-with`); prints the call and stops without `--yes`. 1..5 owners, ≤ 10 clients; `--client` required unless `--allow-shared`; a shared client ID is refused as
  `--client`. Prints the contract-assigned id (`s1`, `s2`, …).
- `scope:add-email-client --scope <id>` (dev envs only, D253): adds the scope's email client `("email",
  "email:<id>")` with a locally minted client proof, signed by the scope's NEAR owner; prints the plan without
  `--yes`. Steps and checks: "Email login demo on sandbox-dev (batch 8a)" step 3.

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --client <id>.apps.googleusercontent.com --allow-shared --owner-near <account> --yes
  corepack pnpm --filter @hana-id/scripts run admin <env> scope:register --allow-shared --owner-near <account> --yes   # shared only
  ```

The `app:*` commands work on the hot DB after migration 0006 (`docs/api.md` "D1 schema"; batch C3). Every write is a
Hana staff action recorded in `app_changes` (actor `cli:<your login>`) and a compare-and-swap on the version the
command read: if someone changed the app in between, nothing is written and the command says so; run it again.
**Origin adds, auto-approve policies and raw signing on are staff proposals**: each gets a `gc_…` id and goes live only
once announced plus the manifest's `appChangeDelayMs` (sandbox-dev: 60 s). In an env with an admin Worker (batch C8)
its notice announces them; in an env without one (sandbox-dev today) `app:changes:announce <gc id>` does, and nobody
is emailed. A proposal not announced within 7 days is cancelled by the API's hourly cron. Removals, turn-offs and
suspensions are immediate. With `--remote`, proposals and announcements are refused until the deployed API reports the
batch C3 reads (`GET /v1/health` `hotDb` ≥ 6), and announcements also until it reports the batch C4 hot DB (≥ 9: the
waiver reads the session markers only that API writes); `app:origins:park` / `unpark`: "Rolling the API back below batch C3"
above.

- `app:create`: `--org` is required and must be `org_legacy` until the console database exists (batch C7). The scope
  must exist on chain and the plan in D1. A scope with no app yet needs `--environment test|live`, fixed for the scope
  from then on (its `scopes` row); an existing scope keeps its own (another environment or org is refused, D51).
  Generates `app_<base58>`, `key_<base58>` and a `pk_test_` or `pk_live_` key by the environment and prints the key
  (public). The origins are staff proposals; when this call created the scope row they skip the delay at their
  announcement if the scope then still shows no sign of a user (the `no_session` waiver, decided inside the
  announcement's SQL: no `first_session_at`, no other origin of the scope ever in force, no vault share, session marker
  or identity row; batch C4 replaced the legacy usage row with the session marker, D220). On an existing scope it is refused
  within `appChangeDelayMs` of the scope's org assignment. Origins are normalised by `@hana-id/console-core`
  `normaliseOrigin` (the form the API and the console share: lowercase ASCII/punycode host, default port and trailing
  dot dropped) and checked by its `originProblem` (`app:create` and `app:origins:add`; never `app:origins:remove`, so
  a bad entry can always be removed; D100, security sweep OPER-6): Hana's own origins (`REFUSED_ORIGINS`: the vault,
  auth and API origins and the dashboard's), wildcards, plain `http` other than loopback, IP addresses, public
  suffixes and single labels, a mixed-script label on a live scope; loopback origins (`http://localhost:<port>`,
  `127.0.0.1`, `[::1]`) and the literal `http://localhost:*` only on a test scope in a dev env (`local*`, `sandbox*`,
  D142). At most 20 active-or-pending origins per app. App names are NFC-normalised and may not contain control, bidi,
  zero-width, separator or unassigned characters; `app:list` prints stored values with such characters escaped
  (OPER-11).

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin <env> app:create --org org_legacy --name smoke-a --scope s1 --origin http://localhost:5173 --remote
  ```

- `app:origins:add`: a staff proposal per new origin (one already listed or pending is reported and skipped); prints
  each `gc_…` id. `app:origins:remove`: immediate; an origin in force ends its change, a pending one is cancelled.
- `app:changes:announce <gc id>`: only in an env with no `admin` block, never on a production network. Sets the
  change's `notified_at` and `active_from` (now + `appChangeDelayMs`, or now under the `no_session` waiver), on its
  origin row too, or writes the policy or raw-signing value as pending until `active_from`; records
  `{channel: "cli", emailed: "none"}`. Once per change.

  ```sh
  corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add --app <app> --origin https://new.example.com --remote   # prints gc_…
  corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:changes:announce <gc id> --remote                                # in force 60 s later
  ```

- `app:suspend` / `app:resume` set and clear Hana's suspension bit (1) only; the org (2) and partner (4) bits belong to
  the admin and partner consoles (batch C), and an app stays suspended while any bit is set. Both refuse a deleted app
  (`AdminRpc.deleteApp`): it keeps bit 1 for good (D225). Suspension is D1-only (the
  contract has no suspension; D11). Removing an origin also kills that origin's vault shares on their next use.
  Logins, relays, `GET /v1/app` and new vault page loads see a suspension or an origin removal at once; the vault
  endpoints (unlock, touch, revoke, share creation) cache the app per Worker isolate, so there it takes up to 30 s
  (D78).
- `app:list`: each app's org, environment, suspension bits, keys (revoked ones marked), origins in force and pending
  changes.
- `app:*` need `apps/api/wrangler.jsonc` for the env (`gen <env>` first) and run `wrangler d1 execute` from `apps/api`.
- `app:settings` (app positionally or with `--app`, not both; no setting flags: show them, with any proposals): ranges
  as the migration's CHECKs; `--raw-sign approval` (refused for a test app: test apps never sign raw, D39 as amended 2026-10-28) and a new
  `--auto-approve` policy are staff proposals (above; at most one pending policy per app); `off` and the other
  settings are immediate. A relative `--auto-approve` path is resolved against the directory you ran `pnpm` from
  (`INIT_CWD`), and the change log names the resolved file. The write only applies if `settings_version` and every
  settings column are still as the command read them: if someone else changed the app in between, nothing is written
  and the command fails with "The app's settings changed since they were read"; run it again. `--persistence none` revokes existing vault
  shares on their next unlock or touch; a lower `--session-ttl` also shortens live shares (to their creation + the new
  TTL). Plans other than `free` need a manual D1 insert.

Owner actions on a registered scope (add a client, change owners, enable shared login) go through
`POST /v1/owner-actions` with a console-client token (`docs/api.md`); there is no CLI for them yet. The endpoint caps
each owner identity, each scope and all owners together (D100); `cancel_change` has its own small allowance per owner
(5/min, 20/day) and a cancel-only ceiling outside those caps, so another owner or a flood can't use up a timelock's
cancel window.

**Cancelling a change when the API refuses (runbook).** OIDC owner auth doesn't depend on who sends the transaction:
if `/v1/owner-actions` is down or answers 429 while a change you didn't make is in its timelock, call the contract
directly from any funded testnet account with the same args (`{scope_id, auth: {"Oidc": {"jwt": "<fresh console
token>"}}, change_id}`), e.g. `near contract call-function as-transaction <signer> cancel_change json-args '…'
prepaid-gas '50 Tgas' attached-deposit '0 NEAR' sign-as <your account> network-config testnet sign-with-keychain
send`. The token is the same one the API would take: a console-audience Google token whose nonce commits to this call and
the scope's current `action_nonce` (`docs/contract-interface.md` "Owner-action nonce"). Never paste it anywhere it is
logged.

## Key rotation

### Relayer keys (either pool)

A leaked relayer key can burn its allowance but can't derive anyone's key.

1. Delete it on chain (the plan prints this command for blocked keys):

   ```sh
   near account delete-keys <relayer> public-keys <ed25519:…> network-config testnet sign-with-legacy-keychain send
   ```

2. Remove it from `.secrets/<env>/relayer-keys.json` (or `owner-relayer-keys.json`), or move the file aside to get a
   whole new pool (then delete every old key on chain too: left there they keep their allowance).
3. `deploy-contract <env>`, then `--yes`: generates and adds the missing keys (saved before they go on chain).
4. Re-upload `RELAYER_KEYS` / `OWNER_RELAYER_KEYS` (step 7 above). A replaced key at an index makes its Durable Object
   ignore the old stored reservation and read the nonce from chain once.

A used-up allowance is replaced the same way. Allowances drop by gas burnt (refunds restore them; `docs/context.md`):
3 × 2 NEAR covered ~1,500 logins on testnet. Don't use pool keys outside the API: the objects assume they are the
only sender (another sender costs an `InvalidNonce` retry).

**Monitoring (D150).** The watchdog reads the relayer account every 5 min (check `relayer_funds`, read-only) and
alerts on its available balance (warning `relayer_balance_low` below 5 NEAR, critical `relayer_balance_critical`
below 1 NEAR) and on each pool key's remaining allowance (`relayer_allowance_low` / `relayer_allowance_critical`:
session pool below 0.5 / 0.1 NEAR, owner pool below 0.1 / 0.02 NEAR), and pages when a pool has no key
(`relayer_pool_empty`). The thresholds are the manifest's `watchdog.relayerFunds` (`apps/watchdog/README.md`
"Configuration"; raise the allowance pairs together with `--relayer-allowance` / `--owner-relayer-allowance`).
`/status` `relayer_funds` shows the last reading. The watchdog never tops anything up; a low balance is funded by
hand from a funded testnet account (never a mainnet one):

```sh
near tokens <funded testnet account> send-near <relayer> '<amount> NEAR' network-config testnet sign-with-legacy-keychain send
```

Recovery for each alert: [`relayer-out-of-funds`](playbooks.md#relayer-out-of-funds).

### Keys-updater key

On the governance contract (layout v2) the key's methods are exactly `set_issuer_key`, `propose_issuer_key_removal`,
`execute_issuer_key_change` (receiver `signer`, allowance ≤ 1 NEAR), and only the contract adds it
(`add_updater_key`, owner; on a DAO owner, a 2-of-3 `FunctionCall` proposal; ≤ 2 tracked at a time, so rotation has an
overlap). Access-key permissions can't be edited, so the v1 key (with `remove_issuer_key`) is deleted, not changed.
The API refuses to sign any other method with it (`apps/api/src/relayer-config.ts` `UPDATER_METHODS`);
`GET /v1/governance` shows `signerAccessKeys` with `updaterKey` / `updaterPermission` for the check.

To rotate: move `.secrets/<env>/keys-updater.json` aside, run `deploy-contract <env>` (plans `add_updater_key` of a
new key generated into the file), upload the new `KEYS_UPDATER_KEY`, then delete the old key with the owner's
`admin <env> owner:call delete_updater_key --args '{"public_key":"<old>"}'`.

If a watchdog deleted the key (it does when it sees a proposal from the signer that Google doesn't publish), the
cron's sends fail (`jwks_tx` `send_failed`) until the owner adds a new one: find out why first (the watchdog's alert
has the change). A deleted key is re-added from the file only if you leave the file in place: the plan warns, and a
key that may be compromised gets the move-aside rotation instead. The plan blocks on every function-call key on
`signer` the contract didn't install ([Blockers on the signer's keys](#blockers-on-the-signers-keys)).

v1 contract: the key was added by hand with `set_issuer_key` / `remove_issuer_key` (rotate: same steps as the relayer
keys with `.secrets/<env>/keys-updater.json`, then re-upload `KEYS_UPDATER_KEY`); the migration replaces it.

### Owner

- **Its key**: add a new full-access key, then delete the old one; make sure the keychain file the scripts read
  (`~/.near-credentials/testnet/<owner>.json`, else the first `<owner>/*.json`) is the new key. The `deploy-contract`
  dry run prints each role's local key and whether it is full access on chain.

  ```sh
  near account add-key <owner> grant-full-access autogenerate-new-keypair save-to-legacy-keychain network-config testnet sign-with-legacy-keychain send
  near account delete-keys <owner> public-keys <old ed25519:…> network-config testnet sign-with-legacy-keychain send
  ```

- **The account**: `set_owner(owner)` (immediate, owner only), then change `owner` in the manifest and check with a
  `deploy-contract` dry run:

  ```sh
  near contract call-function as-transaction <signer> set_owner json-args '{"owner":"<new owner>"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <owner> network-config testnet sign-with-legacy-keychain send
  ```

  This is the v1 contract. On the governance contract `set_owner` no longer exists: the owner calls
  `propose_owner(owner)` and, after `governance_delay_ms`, the new owner calls `accept_owner()`
  (`docs/contract-interface.md` "Owner transfer"). For the council DAO that is `deploy-contract <env>
  --transfer-owner` (twice: propose, then accept through a 2-of-3 proposal; [Governance
  migration](#governance-migration-sandbox-dev) step 5), which also rewrites `owner` / `ownerKind` in the manifest.
- **A council member**: `admin <env> council:replace-member --remove <old> --add <new>` ([Replacing a council
  member](#replacing-a-council-member)): a `RemoveMemberFromRole` and an `AddMemberToRole` proposal (2 of 3, then
  2 of 2), and the `council.members` edit in the manifest once both executed; then check with `admin <env>
  governance:status` and a `council-setup <env>` dry run (dev envs), which compares the DAO's policy with the manifest.

Scope owners (`--owner-near` / `--owner-google`) are separate: they change by a timelocked `SetOwners` owner action.

### Google signing keys (JWKS)

**Governance contract (layout v2).** Issuer keys change only through a public, cancellable delay
(`docs/governance-spec.md` "Rotation and logins"). The API cron (every 15 min, `apps/api/src/issuer-keys.ts`,
`docs/api.md` "Cron") fetches Google's JWKS 3 times a run, proposes each new Google kid any fetch lists
(`set_issuer_key` queues it), proposes the removal of a kid missing from every fetch for ≥ 24 h (never one that
signed a verified token in the last 24 h, never the last key), and executes matured changes that agree with Google's
JWKS (a Remove only on a run whose 3 fetches all succeeded). Why so slow to remove (D422): around a rotation Google's
edges answer from different caches for a day or two, some listing the new kid and some not; on sandbox-dev
(2026-11-04/05) a 55-min rule and a two-fetch watchdog added and removed the new kid four times. A key left a day
longer is harmless; one removed early breaks logins signed with it.

**Deploying the rollout hysteresis (D422), once per env**, from a clean checkout at the commit being deployed, before
the two Workers (the code reads the new columns; the migrations only add):

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote               # 0012_issuer_key_last_token.sql
corepack pnpm --dir apps/watchdog exec wrangler d1 migrations apply <watchdog.cloudflare.d1Name> --remote  # 0002_absence_fetches.sql (the watchdog's account)
corepack pnpm --filter @hana-id/api run deploy
corepack pnpm --filter @hana-id/watchdog run deploy
corepack pnpm --filter @hana-id/scripts run deploy-check <env> --d1 && corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only watchdog --d1
```

A Worker deployed before its migration fails its writes (`key_observation_failed`, the watchdog's run errors) until it
is applied; logins are unaffected.
A watchdog normally confirms a new key within minutes; without one it goes live `issuer_key_delay_ms` after the
proposal, at the next cron run (or whoever executes it). Until then a token signed with it gets `503
issuer_key_pending` with `retry-after: 30` on `/v1/login` and `/v1/sessions`, and nothing is relayed. The cron never
cancels: a pending change it disagrees with (`jwks_sync_note` `unpublished_change` / `pending_mismatch` /
`removal_of_published_kid`) is the watchdog's and the owner's (`cancel_issuer_key_change`). A proposal of ours that
is cancelled logs `issuer_key_change_cancelled` once and is held for 1 h before the cron proposes it again.
The vault retries an `issuer_key_pending` login (`/v1/login`, or `/v1/sessions` in the split flow) once, after the
API's `retryAfterS` capped at 30 s, telling the partner page `loginProgress: key_pending` meanwhile; a second refusal
ends the login with `api_unavailable` ("try signing in again in a few minutes", `data.api: "503 issuer_key_pending"`).

To see the state: `curl -s <apiUrl>/v1/governance | jq '{paused, keyChanges, issuers, updater}'` (below). To execute
a matured change now (anyone may, the contract checks the delay):

```sh
near contract call-function as-transaction <signer> execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded account> network-config testnet sign-with-legacy-keychain send
```

**Syncing by hand.** To sync now (after a deploy, on a v1 contract, whose cron proposes nothing
(`key_changes_unavailable`), or when the cron has no `KEYS_UPDATER_KEY`):

```sh
corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --dry-run
corepack pnpm --filter @hana-id/scripts run post-google-keys <env>              # propose
corepack pnpm --filter @hana-id/scripts run post-google-keys <env> --execute    # also execute due changes
```

It signs with the keys-updater key only (`--as-owner` is gone: an owner post waits the same delay, D86). On the
governance contract it proposes kids Google publishes that are neither active nor pending (`set_issuer_key`), proposes
removing active kids Google no longer publishes (`propose_issuer_key_removal`, never the last active key), and with
`--execute` runs `execute_issuer_key_change` for due changes, additions first. It never executes a pending add Google
doesn't publish (or with other key material), nor a removal of a kid Google still publishes: it prints those for the
watchdog or the owner to cancel. It never calls `remove_issuer_key` (owner-only now). On a v1 contract it still sets
and removes directly. It refuses to sync if Google returns no usable RS256 key.

### Governance status (`GET /v1/governance`)

A read-only JSON snapshot of the contract's governance state (`docs/api.md` "GET /v1/governance"): pause state,
delays and pending decreases, pending issuer-key changes with `executableAtMs`, `due` and Google's JWKS verdict
(`match` / `mismatch` / `absent` / `present`), watchdogs and their confirm power, updater keys against the signer's
access-key list, pending upgrade / owner transfer / withdrawal / console-audience and shared-client additions, and the
JWKS cron's last run and tracked proposals. Public, no key, cached 10 s.

```sh
curl -s <apiUrl>/v1/governance | jq '{paused, delays, keyChanges, pendingUpgrade, pendingOwner, pendingWithdrawal}'
curl -s <apiUrl>/v1/governance | jq '.signerAccessKeys[] | select(.updaterPermission | not)'   # outside sandbox-dev: must be empty
curl -s <apiUrl>/v1/governance | jq '.updater'                                                # the cron's last run
```

**Read by batch C14.** The admin portal's "Security & monitoring" view and the admin and partner consoles'
pending-upgrades page (D83, D86) read this snapshot over the service binding (`AdminRpc.governance`,
`AdminRpc.pendingUpgrades`, `ConsoleRpc.pendingUpgrades`: one read serves the endpoint and the RPCs for 10 s), not
over HTTP, and show `readAtMs` beside every countdown. The API isn't independent (it runs on Hana's main Cloudflare
account): the watchdog is the independent party, and its own status sits beside the snapshot in the same view. The
council's open proposals and the full list of sources are in [Governance status for the admin portal](#governance-status-for-the-admin-portal-batch-c-hand-off).
The watchdog's heartbeat, verdicts, actions log, alerts and acks come only from the watchdog service's `GET /status`,
`/alerts`, `/actions` and `POST /alerts/:id/ack` ([Watchdog service](#watchdog-service-appswatchdog)). Nothing here
alerts: alerts are the watchdog's (D85).

### Deploying the governance API

Order for an env moving to the governance contract (`docs/governance-spec.md` "Migration plan"):

1. Apply D1 migration `0005_issuer_key_sync.sql` (`wrangler d1 migrations apply <cloudflare.d1Name> --remote`), then
   deploy the API. It is safe on a v1 contract: logins work as before (v1 has no `paused`, and its `get_issuer` lists
   the same keys `verify_token` uses), the cron fetches and records the JWKS but proposes nothing
   (`key_changes_unavailable`, sync by hand meanwhile), and `/v1/governance` answers `502 near_unavailable`.
   Deployed before the migration, the cron logs `proposals_unavailable` / `proposal_record_failed` /
   `run_record_failed` (it still proposes, without the cancel hold) and `/v1/governance` has `updater: null`.
2. Upgrade the contract (`migrate_v1`, done on sandbox-dev; current code has no v1 migration, D154). From then on the
   v1 updater key can still call `set_issuer_key` (it now queues) but not the new methods: executions fail (`jwks_tx`
   `send_failed`) until step 3.
3. `add_updater_key(<new key>)`, upload it as `KEYS_UPDATER_KEY`, delete the v1 key ("Keys-updater key" above).
4. Check: `curl -s <apiUrl>/v1/governance | jq '{stateVersion, updaterKeys, signerAccessKeys, updater}'`.

### Pause

While `get_config().paused`, `/v1/sessions`, `/v1/login` and `/v1/derive` answer `503 paused` with `retry-after: 60`
and relay nothing (the contract would panic `Paused`); `/v1/sessions/revoke` and the vault's share endpoints are
unaffected, and the cron keeps proposing (executions wait). `/v1/owner-actions` isn't gated: its console-token
actions and `execute_change` fail on chain while paused (`422 contract_rejected`, paid from the small owner pool). The API reads the
pause state with `get_config`, cached 60 s (10 s while paused), so logins resume within 10 s of `unpause()`. Who
pauses and unpauses, and what each watchdog alert means, is the watchdog runbook (`docs/governance-spec.md`
"Alerts"); the API raises no alert.

### Link volume thresholds (D200)

The contract counts new links (a combined login with a `link_jwt`, or `link_identity`) per UTC hour, per scope and in
total, and records when a count reaches its alarm threshold (defaults 50 per scope and 500 in total). It never refuses
a link: the thresholds only decide when the watchdog alerts. A burst of links usually means a stolen email key
(`docs/security.md`); a large partner launch can look the same.

- **Check:** `near contract call-function as-read-only <signer> get_link_stats json-args '{}' network-config testnet
  now`: `thresholds`, `pending_thresholds`, and for the current and previous hour `total`, `total_threshold_reached`,
  `flagged_scopes`. On an alert, compare the flagged scope with the partner's plans and the email issuer's issuance for
  that app; if it isn't a launch, pause (the watchdog runbook).
- **Change:** `admin <env> owner:call set_link_thresholds --args '{"per_scope_per_hour":<n>,"total_per_hour":<m>}'
  [--approve-with <member>] --yes` (a council proposal; each value 1–100000). A lower value applies at once; a raise
  waits `governance_delay_ms` (`pending_thresholds` shows it) and the watchdog alerts on it.

### Issuer key lead times (D33)

D33's issuer-key delay must stay shorter than the time between Google publishing a signing key and Google signing
the tokens our users bring with it, or logins with a new key fail until the delay ends. The API measures it in D1
`issuer_key_observations` (migration `0004_issuer_key_observations.sql`; kids and timestamps only):

- **First / last seen in the JWKS, removed**: every cron run (every 15 min) fetches Google's JWKS for the sync and
  records each kid from that fetch. The API's verification fetches (on cache expiry, or on an
  unknown kid at most once a minute per isolate) add sightings. "Removed" is the first fetch without the kid after
  its last sighting; it is cleared if a later fetch lists the kid again (a stale Google frontend).
- **First token**: the first token with a valid signature by that kid on `/v1/sessions` or `/v1/login`, written after
  the response, at most once per kid per Worker isolate (the earliest write wins).
- **max-age**: the JWKS response's Cache-Control max-age the last time the kid was listed.

To turn it on in an env: apply the migration first (`wrangler d1 migrations apply <cloudflare.d1Name> --remote`), then
`gen <env>` (the cron trigger becomes `*/15 * * * *`) and deploy the API. Deployed the other way round, writes fail
with `key_observation_failed` warnings until the migration lands; logins are unaffected.

```sh
corepack pnpm --filter @hana-id/api run gen <env>        # wrangler.jsonc for the env, if not already
corepack pnpm --filter @hana-id/scripts run admin <env> issuer-keys:lead-times --remote
```

It prints, per kid, first seen in the JWKS, first token, the lead time (first token − first seen), the lifetime in
the JWKS (removed − first seen, or `…+ (listed)` while still published) and the last max-age, then the shortest lead
time. Reading it:

- A first sighting is up to 15 min after Google published the kid, so a lead time can read up to 15 min short.
- The first token is the first one *we* saw, not Google's first use; logins are sparse on sandbox envs, so a lead
  time there can read long. A rotation with no login in its window gives no lead time.
- A negative lead time (token before any sighting) or a row with no first sighting means a token arrived before any
  fetch listed the kid: Google used it within 15 min of publishing, and any delay longer than that breaks logins.
- The kid present when measurement started has its first sighting at that point, not at Google's publication: ignore
  its lead time. Collect several rotations (Google doesn't publish its schedule) before choosing the delay; set it
  well under the shortest lead time seen.

### `VAULT_KEK`

```sh
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate          # read the plan
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate --yes
```

`rotate` copies `.secrets/<env>/vault-kek` to `vault-kek.previous` and writes a new key with the next id to
`vault-kek.next` (both 0600) before touching the Worker, then sets `VAULT_KEK_PREVIOUS` (the current key) and
`VAULT_KEK` (the new one) through wrangler's stdin, then makes the new key `vault-kek`. If it stops part way, run it
again: it resumes with the same new key. It refuses while a previous rotation's `vault-kek.previous` is still there,
and needs `vault-kek` to hold the key the Worker has now (Cloudflare can't be asked).

Unlocks and the hourly cron re-wrap old rows (≤ 2000 per run). When no row is left under the old id:

```sh
corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "SELECT COUNT(*) AS n FROM vault_shares WHERE kek_id = <old id>"
corepack pnpm --dir apps/api exec wrangler secret delete VAULT_KEK_PREVIOUS --name <cloudflare.workerName>   # once n is 0
rm .secrets/<env>/vault-kek.previous
```

Rows under an id neither secret has show as `unknownKek` (error level): they can't be unlocked until that key is back
(`vault-kek <env> put --yes` sets both secrets again from the files).

**KEK compromised (runbook, security sweep APIV-5).** Rotation alone doesn't help: it re-wraps the same `K_s` under
the new key, so whoever holds the old KEK and a D1 copy still has every live share's `K_s`. Revoke every share first,
then rotate:

```sh
corepack pnpm --dir apps/api exec wrangler d1 execute <cloudflare.d1Name> --remote --command "UPDATE vault_shares SET revoked_at = CAST(strftime('%s','now') AS INTEGER) * 1000 WHERE revoked_at IS NULL"
corepack pnpm --filter @hana-id/scripts run vault-kek <env> rotate --yes
```

Every user with a persisted login signs in with Google again on their next visit (their device records can no longer
be unlocked). D1 backups and Time Travel still hold the old rows under the old KEK for their retention: treat them as
exposed for that long.

### Identity token keys

The partner identity token (`docs/identity-token-spec.md`, D127; `docs/api.md` "Identity token") needs a manifest block
and API Worker secrets, all made by `scripts/identity-key.ts` (D177). Files in `.secrets/<env>/` are 0600 and never
overwritten (Cloudflare can't give a secret back); values go to the Worker through wrangler's stdin; no command prints
a private value. Testnet and `local*` only: staging and mainnet sign with AWS KMS ("Identity token keys on AWS KMS"
below; `gen` and the schema refuse a Worker-secret key off testnet).

| File | Role | On the Worker |
|---|---|---|
| `identity-signing-key.json` | P-256 private JWK that signs now (`identityToken.signer.activeKid`) | yes, in the slot `identity-slots.json` names (`IDENTITY_SIGNING_KEY` or `IDENTITY_SIGNING_KEY_STANDBY`) |
| `identity-signing-key-standby.json` | published in the JWKS, the emergency switch | **no**: never uploaded until `switch --to standby`, so a leak of the Worker's secrets or the Cloudflare account doesn't reach it. Move the file offline (with the council backup, D81) and bring it back only to switch |
| `identity-signing-key-next.json` | a rotation's incoming key (`next`), published | no, until `switch --to next` |
| `identity-signing-key-previous.json` | the key a switch replaced, still published so its tokens keep verifying | yes, until `retire --key previous` deletes its slot |
| `identity-slots.json` | which Worker slot holds which kid (public data) | — |
| `identity-sub-key` | `IDENTITY_SUB_KEY`, base64 of 32 bytes. **Never rotated** (a new key changes every user's `sub` at every partner, and so every User ID and Support ID, D346); back it up offline with the council backup (D81) | yes |

Every command below prints its plan without `--yes`. After `init`, `next`, `switch` and `retire`, put the changed
`envs/<env>.json` in the repo, run `gen` and deploy the API: the JWKS and the active kid come from the manifest.

**Watchdog pins first** (D210, D211). The watchdog pages critical (`identity_key_unpinned`) for any key in the JWKS
whose thumbprint isn't in `watchdog.pinnedIdentityKeys`, and the schema refuses a manifest that publishes an unpinned
key. On an env with a `watchdog` block, `identity-key` writes the pins with the keys: `init` and `next` pin the new
keys, `retire` unpins the key it unpublishes, `switch` changes no pin. The deploy order follows:

- after `init` or `next` (a key added): **deploy the watchdog first**, then the API. Between the two the watchdog
  warns `identity_key_missing` (pinned, not yet published): expected.
- after `retire` (a key removed): **deploy the API first**, then the watchdog. The other order pages
  `identity_key_unpinned` until the API deploy.

The watchdog deploy runs on the watchdog's own Cloudflare account ("Watchdog service" below; logged in
there, not to the API's account; sandbox-dev's watchdog shares the API's account, D125):

```sh
corepack pnpm --filter @hana-id/watchdog gen <env>              # IDENTITY_PINS, IDENTITY_ISS (and the rest)
corepack pnpm --filter @hana-id/watchdog run deploy
```

Check `/status` `identity.pinned` after the watchdog deploy and `identity.jwks` (`unpinned: 0`, `missing: []`) after
the next run.

```sh
S="corepack pnpm --filter @hana-id/scripts run identity-key <env>"
$S show                                   # the published kids, their roles and Worker slots (public values only)
```

**First setup (once per env):**

```sh
$S init --yes        # active + standby + sub key files; identityToken in envs/<env>.json (both keys pinned for the watchdog); uploads the active key and IDENTITY_SUB_KEY
# the watchdog first (its own account): watchdog gen <env>, wrangler deploy (above)
corepack pnpm --filter @hana-id/api run gen <env> --d1-id <id>   # IDENTITY_ISS, IDENTITY_PUBLIC_KEYS, IDENTITY_ACTIVE_KID, the bindings
corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote   # 0008_identity_token.sql
corepack pnpm --filter @hana-id/api run deploy
curl -s <apiUrl>/v1/identity/jwks.json             # {"keys":[{…active…},{…standby…}]}, no "d"
curl -s <apiUrl>/v1/identity/.well-known/openid-configuration   # issuer = identityToken.iss, jwks_uri = {iss}/jwks.json
```

Then move `identity-signing-key-standby.json` offline. `init` refuses when any identity file exists or the manifest
already has `identityToken`. `init --local --yes` uploads nothing (a `local*` env, or to upload later with `put --yes`,
which sets the active key in its slot and the sub key again). `gen --dev-vars` writes the active key and the sub key
into `apps/api/.dev.vars`, never the standby, and refuses a key that isn't the manifest's active one.

**Scheduled rotation** (every 12 months; 14 days' notice to partners that pin thumbprints, 24 h on testnet):

```sh
$S next --yes                 # a new key, published and pinned (manifest), uploaded nowhere → watchdog gen + deploy, THEN API gen + deploy
# … wait the notice period …
$S switch --to next --yes     # uploads it into the free slot, makes it the active kid; the old key becomes "previous" → API gen, deploy (no pin change)
# … ≥ 2 h later (tokens signed by the old key expire within 1 h) …
$S retire --key previous --yes   # unpublishes and unpins the old key, deletes its Worker secret, sets its file aside → API gen + deploy, THEN watchdog gen + deploy
```

`switch` leaves both keys on the Worker until `retire`, so whichever manifest is deployed, a key with its active kid
is there. Run `retire` only after the switch's deploy. Retired key files are kept as
`identity-signing-key-retired-<kid prefix>.json` for a post-mortem; never commit them.

**Suspected compromise** (playbook `identity-signing-key-compromised` in `docs/playbooks.md`):

1. Decide what is exposed. A leak of the API Worker's secrets or the Cloudflare account exposes the active key only
   (the standby was never uploaded). A leak of `.secrets/<env>/` or the operator's machine exposes every key whose
   file was there, the standby too unless it was offline. **Unless the incident provably touches only the active key,
   treat both as exposed.**
2. Only the active key exposed: `$S switch --to standby --yes`, API gen, deploy, then at once `$S retire --key previous
   --yes`, API gen, deploy, then watchdog gen, deploy (no 2 h wait). Make a new standby with `$S next --yes`
   (watchdog gen and deploy first, then the API) and move its file offline.
3. Both exposed: `$S retire --key standby --yes` and `$S next --yes` (one unpins, one pins): deploy the watchdog, then
   the API, and acknowledge the `identity_key_unpinned` page for the standby while the old API is still live (or
   deploy the API between the two commands to avoid it); then `$S switch --to next --yes`, API gen, deploy; then
   `$S retire --key previous --yes`, API gen, deploy, watchdog gen, deploy. Partners using the JWKS URL pick up the
   new kid at once and reject the removed ones within 10 minutes; tokens with up to 1 h left die then too.
4. Tell partners (security contacts): the `kid`, the window in which forged tokens may have been accepted, what to
   re-check. Pinning partners update their pins.

A key in the JWKS nobody on the team published is the watchdog's critical `identity_key_unpinned` (or
`identity_private_key_published`, `identity_discovery_mismatch`): playbook `identity-jwks-forged`, which treats the API
Worker or the Cloudflare account as compromised and rotates as above.

**Sub key leak.** Privacy, not funds: the holder can map partners' `sub`s to on-chain paths. Not rotatable without a
`u2_` scheme and a 90-day `legacy_sub` window (spec "`sub`").

### Identity token keys on AWS KMS

**Status: code only (build step 7, branch `feat/identity-token-7`), no env uses it.** The API's KMS signer
(`apps/api/src/identity/kms.ts`), the manifest's `aws-kms` signer, `gen`'s vars and the `identity-key kms-*` commands
are built and tested against a fake KMS. The AWS side below is the operator's setup, in D121's dedicated AWS account,
before staging's rehearsal and mainnet. sandbox-dev stays on the Worker-secret key. Moving an existing Worker-secret
env to KMS isn't scripted (it must keep `IDENTITY_SUB_KEY` and needs a rotation window), so KMS envs start with
`kms-init`.

How it signs (`docs/api.md` "Identity token"): the Worker hashes the token's signing input and sends one
`TrentService.Sign` (`MessageType: DIGEST`, `ECDSA_SHA_256`, SigV4) for the active key's ARN to
`kms.<that key's region>.amazonaws.com`, with no retry, a 3 s deadline and a 4 KiB answer cap. The DER answer is
converted to JOSE and verified with the published key before any token is answered (D216–D218). Every failure is
`503 identity_signer_unavailable`, logged `identity_sign_failed` with a `kms_*` code.

| What | Where | Notes |
|---|---|---|
| Identity keys: `active` and `standby`, during a rotation `next` and `previous` | AWS KMS, D121's account | `ECC_NIST_P256`, `SIGN_VERIFY`, origin `AWS_KMS` (generated in KMS, non-exportable), single-region (no `mrk-` keys: a replica shares its key material). The standby in another region than the active key (D219, the schema checks it). The same key policy on every key (below) |
| IAM user `hana-identity-signer` (one per env: the manifest's `credentials.iamUser`) | IAM, same account | No console password. Its only permission: `kms:Sign` on the **active** key's ARN, `ECDSA_SHA_256` and `DIGEST` only (D219). One access key in use (two during a rotation) |
| `IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY` | API Worker secrets | Set together by `kms-put-aws-key` (one `wrangler secret bulk`); rotated every 90 days and on suspicion |
| `identityToken.signer` | `envs/<env>.json` | `{kind: "aws-kms", credentials: {kind: "worker-secret", iamUser}, keys: {active: {kid, arn}, standby?: {kid, arn}, next?, previous?}}`; every published key has a role, all keys in one account (D215). `gen` writes `IDENTITY_SIGNER=aws-kms`, `IDENTITY_ACTIVE_KID` and `IDENTITY_KMS_KEY_ARN` (the active key's ARN only) |
| `IDENTITY_SUB_KEY` | Worker secret, `.secrets/<env>/identity-sub-key` | As on testnet: never rotated, backed up offline (D81). `kms-init` makes it |

Every `kms-*` command prints its plan without `--yes`, never calls AWS and never prints a credential.
`<key.json>` is the public data `aws kms get-public-key --key-id <arn> --output json` prints. After each manifest
change: commit `envs/<env>.json`, `gen`, deploy.

```sh
S="corepack pnpm --filter @hana-id/scripts run identity-key <env>"
$S show            # roles, kids and ARNs (public values only); warns when there is no standby
```

**Key policy** (every identity key; `<signer>` is `arn:aws:iam::<account>:user/<iamUser>`, `<admin>` the break-glass
role's ARN). It delegates `kms:Sign` to the signer user's IAM policy only, so the key the Worker can sign with is set
in one place, the IAM policy (D219). It denies signing to every other principal, grants to everyone, and key changes
to everyone but the break-glass role:

```json
{
  "Version": "2012-10-17",
  "Id": "hana-id-identity-key",
  "Statement": [
    {
      "Sid": "BreakGlassAdministers",
      "Effect": "Allow",
      "Principal": { "AWS": "<admin>" },
      "Action": ["kms:DescribeKey", "kms:GetKeyPolicy", "kms:GetPublicKey", "kms:ListResourceTags", "kms:PutKeyPolicy",
                 "kms:EnableKey", "kms:DisableKey", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion",
                 "kms:TagResource", "kms:UntagResource", "kms:UpdateKeyDescription"],
      "Resource": "*",
      "Condition": { "Bool": { "aws:MultiFactorAuthPresent": "true" } }
    },
    {
      "Sid": "SignerSignsThroughItsIamPolicy",
      "Effect": "Allow",
      "Principal": { "AWS": "arn:aws:iam::<account>:root" },
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": {
        "ArnEquals": { "aws:PrincipalArn": "<signer>" },
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" },
        "Null": { "aws:TokenIssueTime": "true" }
      }
    },
    {
      "Sid": "NoOtherSigner",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<signer>" } }
    },
    {
      "Sid": "NoSessionCredentials",
      "Effect": "Deny",
      "Principal": "*",
      "Action": "kms:Sign",
      "Resource": "*",
      "Condition": { "Null": { "aws:TokenIssueTime": "false" } }
    },
    { "Sid": "NoGrants", "Effect": "Deny", "Principal": "*", "Action": "kms:CreateGrant", "Resource": "*" },
    {
      "Sid": "OnlyBreakGlassChangesTheKey",
      "Effect": "Deny",
      "Principal": "*",
      "Action": ["kms:PutKeyPolicy", "kms:ScheduleKeyDeletion", "kms:CancelKeyDeletion", "kms:DisableKey",
                 "kms:EnableKey", "kms:UpdateKeyDescription", "kms:TagResource", "kms:UntagResource"],
      "Resource": "*",
      "Condition": { "ArnNotEquals": { "aws:PrincipalArn": "<admin>" } }
    }
  ]
}
```

Never drop the `BreakGlassAdministers` statement: a key policy nobody can change can only be repaired by AWS Support.

**Only the long-term access key signs (D219).** Anyone holding the signer's access key can call
`sts:GetSessionToken`, which needs no permission and can't be denied by any policy, and get session credentials that
carry the user's permissions as they are at each call, including after a switch has put the standby in the IAM policy.
Deactivating or deleting the access key isn't proven to end such sessions (up to 36 h). So `Sign` is allowed only to
requests without `aws:TokenIssueTime` (long-term `AKIA…` credentials, which is what the Worker uses), and
`NoSessionCredentials` denies `Sign` to every request made with temporary credentials, the signer's sessions included.
**Confirm on staging** (a drill): a `GetSessionToken` session of the signer user is refused `Sign` (`AccessDenied`), and
the Worker's own `AKIA…` key still signs.

**The break-glass role.** `<admin>` is an IAM role in this account that operators reach with `sts:AssumeRole` and MFA
(its trust policy requires `aws:MultiFactorAuthPresent`; `aws configure` a profile with `role_arn` and `mfa_serial`).
Not an IAM Identity Center (SSO) permission set: those sessions don't carry `aws:MultiFactorAuthPresent`, so the
`Bool` condition fails and nobody can administer the key. Never delete or rename the role: a key policy names the role
by its unique id, so a recreated role of the same name isn't the same principal, and the keys lose their administrator
(repair: AWS Support). To bound a stale MFA session as well, add `"NumericLessThan": { "aws:MultiFactorAuthAge":
"3600" }` next to the `Bool` condition.

**The signer user's IAM policy** (inline, the user's only policy). The `Resource` lists the active key alone, and
during a switch the active and the incoming key; `NoOtherKey` lists the same ARNs, so even a policy attached to the user
by mistake can't let it sign with another key:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SignWithTheActiveIdentityKey",
      "Effect": "Allow",
      "Action": "kms:Sign",
      "Resource": ["arn:aws:kms:<region>:<account>:key/<active key id>"],
      "Condition": {
        "StringEquals": { "kms:SigningAlgorithm": "ECDSA_SHA_256", "kms:MessageType": "DIGEST" },
        "Bool": { "aws:SecureTransport": "true" },
        "Null": { "aws:TokenIssueTime": "true" }
      }
    },
    { "Sid": "NoOtherKey", "Effect": "Deny", "Action": "kms:Sign", "NotResource": ["arn:aws:kms:<region>:<account>:key/<active key id>"] },
    { "Sid": "NothingElse", "Effect": "Deny", "NotAction": "kms:Sign", "Resource": "*" }
  ]
}
```

There is no source-IP condition: Workers have no fixed egress addresses. The user can't manage its own access keys
(`NothingElse`); the break-glass role does.

**One-time setup (the operator, per env, as the break-glass role with MFA):**

1. **CloudTrail.** A multi-region trail in the account (or the organization trail) delivering to the log-archive
   account (D121), with management events **Read and Write** (`Sign` is a read event) and KMS events **not**
   excluded. Check that a `Sign` shows up (step 7).
2. **Keys.** One in the active region (for example `ap-east-1`) and one in a second region (for example
   `ap-southeast-1`), with the key policy above in `key-policy.json`:
   `aws kms create-key --region <region> --key-spec ECC_NIST_P256 --key-usage SIGN_VERIFY --origin AWS_KMS --policy file://key-policy.json --description "hana-id identity <env> <role>" --tags TagKey=env,TagValue=<env>`.
   Then for each: `aws kms get-public-key --region <region> --key-id <arn> --output json > <role>.json` (public data).
3. **IAM user.** `aws iam create-user --user-name <iamUser>`, then `aws iam put-user-policy --user-name <iamUser>
   --policy-name identity-sign --policy-document file://signer-policy.json` (the active key's ARN).
4. **Manifest and sub key.** `$S kms-init --active active.json --standby standby.json --iam-user <iamUser> --yes`
   writes `identityToken` (refused unless the two keys are in two regions of one account), creates
   `.secrets/<env>/identity-sub-key` and sets `IDENTITY_SUB_KEY`; with a `watchdog` block it also pins both keys in
   `watchdog.pinnedIdentityKeys` (D211). Commit the manifest; deploy the watchdog (gen, deploy) before the API.
5. **Access key.** `(umask 077; aws iam create-access-key --user-name <iamUser> > .secrets/<env>/identity-aws-access-key.json)`,
   then `$S kms-put-aws-key --yes`. It checks that the file is 0600, that the key belongs to the manifest's user, and
   that it is an active `AKIA…` key.
6. **Deploy.** `gen <env> --d1-id <id>` (writes `IDENTITY_SIGNER=aws-kms`, `IDENTITY_ACTIVE_KID`,
   `IDENTITY_KMS_KEY_ARN`), apply the migrations, deploy. The Worker must have no `IDENTITY_SIGNING_KEY*` secrets
   (`wrangler secret list`; delete leftovers).
7. **Check.** Mint a token from a test app: it verifies against the JWKS with the active kid, and the request's `sign`
   timing phase fits the 100 ms p95 budget (measure on staging). CloudTrail shows one `Sign` by the signer user on the
   active key. Then delete `.secrets/<env>/identity-aws-access-key.json`.
8. **Alarms** (EventBridge rules on CloudTrail events, to the paging app). Where and how:
   - Rule state **`ENABLED_WITH_ALL_CLOUDTRAIL_MANAGEMENT_EVENTS`**: a rule in the default `ENABLED` state doesn't
     receive read-only management events, and `Sign` and `GetSessionToken` are read-only.
   - The same KMS and STS rules in **both key regions** (KMS events are regional; a `GetSessionToken` on a regional
     STS endpoint is logged in that region), and the IAM and STS rules in **`us-east-1`** (IAM and the global STS
     endpoint log there).
   - The events: `PutKeyPolicy`, `DisableKey`, `ScheduleKeyDeletion` or `CreateGrant` on an identity key; any IAM
     change that could widen or reuse the signer user: `PutUserPolicy`, `DeleteUserPolicy`, `AttachUserPolicy`,
     `DetachUserPolicy`, `AddUserToGroup`, `PutUserPermissionsBoundary`, `DeleteUserPermissionsBoundary`,
     `CreateAccessKey`, `UpdateAccessKey`, `DeleteAccessKey`, `CreateLoginProfile`, and `PutGroupPolicy` /
     `AttachGroupPolicy` on any group the signer user is in (it should be in none); **`GetSessionToken` by the signer
     user** (`userIdentity.arn` = `<signer>`; the Worker never calls it, so any is a leaked key in use); any `Sign` on
     an identity key by another principal or with session credentials (the key policy refuses it, but the attempt
     matters).
   - **`Sign` volume per key:** KMS publishes no per-key request metric, so send the trail to a CloudWatch Logs log
     group (in each key region) and add a metric filter per key, e.g.
     `{ ($.eventSource = "kms.amazonaws.com") && ($.eventName = "Sign") && ($.resources[0].ARN = "<key arn>") }`, with an
     alarm on its hourly sum (a few times the API's `identity_issuance_hourly` peak). Plus an AWS Budgets alarm on
     KMS spend.
   Every planned change below fires one of them: acknowledge it.

`wrangler dev` doesn't run a KMS env: no AWS credentials go into `.dev.vars` (`gen --dev-vars` writes the sub key only
and refuses a leftover private signing key file). Local development uses a `local*` env with a Worker-secret key.

**Scheduled key rotation** (every 12 months; 14 days' notice to partners that pin thumbprints):

1. Create the new key in the **active key's region** (the standby keeps the other one), with the same key policy;
   `get-public-key` → `next.json`; `$S kms-add --role next --key next.json --yes` (it also pins the key in
   `watchdog.pinnedIdentityKeys`, D211) → **watchdog gen and deploy first**, then API gen and deploy (the JWKS lists it,
   nothing signs with it).
2. Wait the notice period.
3. IAM: list both ARNs (active and next) in the signer user's policy, in `SignWithTheActiveIdentityKey` and
   `NoOtherKey`.
4. **Pre-switch check** (below) on the next key.
5. `$S kms-switch --to next --yes` → gen, deploy. The old key is now `previous`, still published.
6. After ≥ 2 h: `$S kms-retire --key previous --yes` (it also unpins the key) → API gen and deploy, **then** watchdog gen
   and deploy. IAM: the new active ARN alone. KMS: `aws kms disable-key` and `aws kms schedule-key-deletion
   --pending-window-in-days 30` on the old key.

**Pre-switch check** (before any `kms-switch`, once the IAM policy lists the target key): prove that the signer user
can sign with the target and that its signature verifies against the public key the manifest publishes for it. Only
the signer user may sign (`NoOtherSigner`), so this needs its access key: run it while
`.secrets/<env>/identity-aws-access-key.json` exists (right after creating an access key; a scheduled switch is a good
time to rotate it too). The credentials go into the AWS CLI's environment for one command and are never printed:

```sh
F=.secrets/<env>/identity-aws-access-key.json
printf 'hana-id pre-switch check %s' "$(date -u +%FT%TZ)" | openssl dgst -sha256 -binary > /tmp/check.digest
AWS_ACCESS_KEY_ID="$(jq -r .AccessKey.AccessKeyId "$F")" AWS_SECRET_ACCESS_KEY="$(jq -r .AccessKey.SecretAccessKey "$F")" \
  aws kms sign --region <target region> --key-id <target arn> --message fileb:///tmp/check.digest --message-type DIGEST \
  --signing-algorithm ECDSA_SHA_256 --output text --query Signature | base64 -d > /tmp/check.sig
jq -r .PublicKey <target>.json | base64 -d | openssl pkey -pubin -inform DER -out /tmp/target.pem
openssl pkeyutl -verify -pubin -inkey /tmp/target.pem -in /tmp/check.digest -sigfile /tmp/check.sig   # "Signature Verified Successfully"
```

`<target>.json` is the `get-public-key` file `kms-add` published (its kid is in the manifest). This `Sign` is in
CloudTrail with no token behind it: note its time for the reconciliation.

**Access key rotation** (every 90 days, and at once on suspicion):

1. `(umask 077; aws iam create-access-key --user-name <iamUser> > .secrets/<env>/identity-aws-access-key.json)`. IAM
   allows two keys per user: delete an old inactive one first if there are two.
2. `$S kms-put-aws-key --yes`: one request sets both secrets, so the Worker never pairs the new id with the old secret.
3. Mint a token; CloudTrail shows a `Sign` with the new access key id.
4. `aws iam update-access-key --user-name <iamUser> --access-key-id <old id> --status Inactive`; after a day with no
   use (`aws iam get-access-key-last-used`), `aws iam delete-access-key`. Delete the `.secrets` file.

**Suspected compromise** (a leaked access key or Worker secrets, an API Worker or Cloudflare account incident, an
unexplained `Sign` in CloudTrail, a forged token reported by a partner; planned playbook
`identity-kms-signer-compromised`):

1. **Stop the signatures:** `aws iam update-access-key … --status Inactive` for every access key of the signer user.
   Mints answer 503 from then on, and partners fall back to no token. Deactivating a key alone isn't proven to end
   session credentials made from it with `GetSessionToken`: what stops those signing is the key policy's
   `NoSessionCredentials` deny (confirm it is in every identity key's policy, `aws kms get-key-policy`), not the
   deactivation.
2. **Measure:** the CloudTrail events whose `userIdentity.arn` is the signer user (every credential it has, sessions
   included; not by access key id, which misses session keys): `GetSessionToken` calls, refused `Sign` attempts, and
   successful `Sign`s by key, window and count. With D219 the standby can't have been used (the IAM policy never
   listed it, sessions can't sign); confirm it has no successful `Sign` events.
3. **Switch:** the IAM policy → the standby's ARN (both statements); a new access key → the pre-switch check →
   `$S kms-put-aws-key --yes`; `$S kms-switch --to standby --yes` → gen, deploy.
4. **Unpublish:** `$S kms-retire --key previous --yes` (unpublishes and unpins) → API gen and deploy, then watchdog gen
   and deploy (no 2 h wait); disable the old key and schedule its deletion.
5. **New standby:** a new key in another region than the new active key; `$S kms-add --role standby --key <file>
   --yes` (publishes and pins) → watchdog gen and deploy first, then API gen and deploy.
6. **Tell partners:** the `kid`, the window and count from CloudTrail, what to re-check. Post-mortem (D83).

A KMS outage in the active region (`kms_unreachable`, `kms_internal` or `kms_timeout` in the logs, mints at 503) isn't
a compromise. Either wait it out (partners fall back to no token), or switch to the standby as in step 3 without
revoking anything. To make the old key the standby again later: `kms-retire --key previous`, then `kms-add --role
standby` with its `get-public-key` file.

**Reconciliation (planned, not built; before mainnet).** An hourly job counts the CloudTrail `Sign` events per identity
key and UTC hour (`userIdentity.arn` = the signer user, no `errorCode`) and compares them with `identity_issuance_hourly` (the tokens the
API answered, per kid and hour). Each answered token is one `Sign`, so CloudTrail's count is at least the API's. The
difference must be explained by `Sign` calls that succeeded at KMS but produced no token (a timeout after KMS signed,
a garbled or unverifiable answer), which today are only in the logs (`identity_sign_failed` with `kms_timeout`,
`kms_bad_answer`, `kms_bad_signature` or `self_verify_failed`). A gap beyond that, any `Sign` by another principal or with session credentials, or any
`GetSessionToken` by the signer user, is a critical alert: a signature Hana's API didn't make. To make the check exact, the job's build adds a per-hour,
per-kid count of the `Sign` requests the API sent (D218). Where it runs (the watchdog's account, D125, with a
read-only principal on the log-archive bucket or `cloudtrail:LookupEvents`) is decided with it.

### A user's leaked key (`key_index`)

The path is `{scope_id}#{provider}#{sub}#{key_index}`, so a new `key_index` is a new key and new addresses. Rotation
is not built (`docs/batch-b-spec.md`, "Key rotation hooks"): the vault fixes `keyIndex = 0`, nothing on chain marks an
index retired, and the old key stays derivable by whoever can sign in as that user. Today: the user moves funds
using a session at the old index and logs in with another `keyIndex` (`apps/smoke` has a `key_index` field). Values
≥ 2^31 are reserved and refused.

## Smoke test (`apps/smoke`)

Needs a deployed env (contract, Google keys, API with secrets and `VAULT_KEK`, the vault and auth page Workers,
`apiUrl`, `vaultOrigin`, `authOrigin` and `ckdNetworkKey` set), an app whose origins include `http://localhost:5173`
with a `pk_test_` key in a `sandbox*` / `local*` env, `{authOrigin}/login/callback` on the clients' redirect URIs and,
for the direct page, `http://localhost:5173/direct-callback.html` on their redirect URIs.

```sh
corepack pnpm --filter @hana-id/smoke dev                                   # envs/sandbox-dev.json
VITE_HANA_ENV=<env> corepack pnpm --filter @hana-id/smoke dev
VITE_HANA_API_URL=http://localhost:8787 corepack pnpm --filter @hana-id/smoke dev   # local wrangler dev (the pages' own calls only)
```

Restart it after editing the manifest. Two pages: `/` logs in through the vault (`@hana-id/web`, `POST /v1/login`), as a
partner would; `/direct.html` is the in-page `/v1/sessions` + `/v1/derive` flow, kept as the ship gate's split-flow
baseline and for what the vault can't do (`key_index` ≠ 0, replays). The direct page signs in with Google's implicit
flow, `scope=openid` only, so its tokens pass the API's claim allow-list, which is always on (no runtime flag since
D271; the only one left is `BLS_PRECHECK`). The checklist (login, isolation,
own vs shared client, persistence and unlock, Safari/WebKit retention, logout, revoke, export, approval and
auto-approve, the ship gate, the BLS precheck CPU time, replays, gas) is in `apps/smoke/README.md`.

- The ship gate compares vault logins with direct-page sessions **against the same API**: the vault always calls the
  manifest's `apiUrl`, so direct-page runs made with a `VITE_HANA_API_URL` override are left out (the panel says how
  many). Measure the split side without the override.
- The demo auto-approve policy path is relative to `scripts/` (pnpm runs the admin script there):
  `admin <env> app:settings <app> --auto-approve ../apps/smoke/policies/demo-auto-approve.json --remote`.
- A replayed derive is refused by the API (`409 counter_used`) before anything is relayed: no transaction, no gas.

## Browser tests (`apps/e2e`, Playwright)

The real vault, login, approval and export bundles and the partner client in Chromium, WebKit and Firefox, against a
local stack: apps/api's Worker run in Node (only `/v1/login` and `/v1/derive` mocked), a mocked NEAR RPC, MPC and EVM
RPC, and an OIDC stub for Google. No testnet, no secrets. Details: `apps/e2e/README.md`.

```sh
corepack pnpm --filter @hana-id/e2e e2e:install          # once: the browsers
corepack pnpm --filter @hana-id/e2e e2e                  # build, start the stack, run all three browsers
HANA_E2E_PORT_BASE=4510 corepack pnpm --filter @hana-id/e2e e2e   # a second worktree at the same time
```

- Ports are `HANA_E2E_PORT_BASE` (default 4410) to base + 50. Outside CI Playwright reuses a stack already listening
  there; the global setup fails the run unless it is this checkout's current stack (fingerprint on
  `/__e2e/health`). On "not this checkout's current e2e stack": stop the other stack or use another base.
- A base that puts a port on one of the Fetch standard's blocked ports (5060/5061 SIP, 6000, 6665–6669, 10080, …) is
  refused at once: browsers never connect there. 5010 is one (its EVM RPC would be 5060); use 5110, for example.
- CI (`.github/workflows/ci.yml`, job "Playwright") retries a failed test once to keep its trace, but a test that
  passes only on the retry fails the job (`failOnFlakyTests`). The report and traces are uploaded on failure.

## Hosted demo (`apps/demo`)

A partner-style page on `@hana-id/web` so colleagues can try Hana ID on testnet from a URL: login, addresses with
explorer links, `personal_sign` / Stellar message / a Base Sepolia test transaction (signed, never broadcast), export,
logout, "log out other devices", login timings and a *Copy diagnostics* report (no tokens, keys, signatures or relay
ids). Details: `apps/demo/README.md`.

| | sandbox-dev |
|---|---|
| URL | `https://hana-id-demo-sandbox-dev.tingtc.workers.dev` (Worker `hana-id-demo-<env>` on the subdomain of the manifest's `apiUrl`) |
| App | Smoke B, `pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie` (shared Google client); `HANA_DEMO_PUBLISHABLE_KEY` overrides it |
| Env | `HANA_DEMO_ENV` (default `sandbox-dev`); only testnet `sandbox*`/`local*` envs; on the API's workers.dev subdomain, or with `HANA_DEMO_ORIGIN=https://<host>` a Custom Domain on the env's account (required when the API is on a custom domain, D404) |

```sh
# once per app: the vault loads only on the app's origins (needs apps/api/wrangler.jsonc: `gen sandbox-dev`); a staff
# proposal: announce the gc_… id it prints, and the origin is in force 60 s later (appChangeDelayMs)
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add \
  --app pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie --origin https://hana-id-demo-sandbox-dev.tingtc.workers.dev --remote
corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:changes:announce <gc id> --remote

corepack pnpm --filter @hana-id/demo run deploy      # gen:envs, vite build, gen (apps/demo/wrangler.jsonc), wrangler deploy
corepack pnpm --filter @hana-id/demo run build && corepack pnpm --filter @hana-id/demo run gen \
  && corepack pnpm --filter @hana-id/demo exec wrangler deploy --dry-run   # check without deploying
```

- The Worker sets the page's CSP (`frame-src` exactly `vaultOrigin`, `connect-src` exactly the EVM RPC, no inline
  code, `frame-ancestors 'none'`, Trusted Types) and `nosniff`, `no-referrer`, `X-Frame-Options: DENY`, COOP
  `same-origin-allow-popups` on every response; preview URLs are off and it answers only on its own origin.
- Redeploy after changing `envs/<env>.json` (the vault origin is in the CSP and the bundle) or `@hana-id/web`.
- "Could not load the Hana vault" on the demo: *Copy diagnostics* shows the error's `reason` (the SDK tries a second
  frame once before it gives up, D262). `no_answer`: the vault page refused the frame, so the origin isn't in force on
  the app (`app:origins:add` and `app:changes:announce` above, then 60 s), the key is unknown or suspended, or the build
  is for another env; `admin <env> app:list --remote` shows the app's origins in force and its pending changes.
  `frame_timeout` (the frame never loaded) and `ready_timeout` (the vault answered but its unlock call didn't come
  back in 20 s): the network or cold Workers, typically for a minute or two after a deploy; reload.
- *Login timings*: one row per login with its method; "sign-in" is `google` for Google, and for email the sum of
  `emailEntry`, `emailStart`, `emailCode` and `emailVerify` (listed under the row), D260. A large `app` with a large
  `appServerChain` (in *Copy diagnostics*) is the API's registry read; a large `appRtt` with a small `appServer` is the
  network or the Worker's routing.
- Removing the origin (`app:origins:remove`) signs out everyone who used the demo, on their next use.

## Watchdog service (`apps/watchdog`)

**Env label (D419):** on a non-production env every alert title starts with the env's label (`[SANDBOX]`,
`[STAGING]`, `[LOCAL]`, `[TESTNET]`): the email subject and the body's first line ("Not production: Hana ID <env>
(testnet)."), the paging app's title (ntfy, Pushover, PagerDuty), Slack's text and the daily digest's subject, e.g.
`[SANDBOX] CRITICAL: Governance change: console_audiences [Hana ID sandbox-dev]`. `gen` writes it as the `ENV_LABEL`
var from the manifest (`@hana-id/env` `envAlertLabel`); the Worker ignores it on any network but testnet (none on
production, whatever a config says) and derives it from `ENV_NAME` when an older config has none.

The independent watchdog of the governance batch (`docs/governance-spec.md` "Watchdog service", D82–D86): every
5 min it compares the contract's pending and active issuer keys with Google's JWKS, cancels a pending key Google
doesn't publish (and deletes the updater keys if the updater proposed it), pauses only when such a key is **active**,
confirms keys that match, alerts on every governance change, and serves a read-only status for the admin portal.
What it checks and its status API: `apps/watchdog/README.md`. **Deployed on sandbox-dev (2026-10-30; redeployed 2026-11-02
with batch 5's email rules and link alarms, version b156e1b5, then with identity token step 8's identity JWKS
checks, version 67fe97cb (first run: 2 keys published, all pinned, discovery ok), no new migration: on the v2 contract it reads "no email
issuer" and skips the link check)**:
`https://hana-id-watchdog-sandbox-dev.tingtc.workers.dev`, cron `*/5 * * * *`, on the API's Cloudflare account
(D125), D1 `hana-id-watchdog-sandbox-dev`. First deployed with no channel and no heartbeat; first run
2026-10-30 04:50 UTC, every check ok; the cron trigger started ~10 min after the first deploy (two slots skipped).
Since the drills the same day, the pager is a random ntfy.sh topic and the heartbeat a healthchecks.io check (both
secrets only). Slack and email are still not set up (no Slack webhook; the manifest's alert addresses are
`example.com` placeholders), so every run reports those channels as `channel_not_configured` (`/status` `channels`
shows which are configured). **ntfy.sh's public server rate-limits
publishers per IP, and Workers send from shared IPs**: in the forged-key drill (2026-10-30) the critical page got
HTTP 429 at 05:06 and 05:40 and went through at 05:10 and 05:25, so it is not a production pager (the choice is
open: `docs/context.md` "Next steps" 8). Forged-key drill: change #0 posted 05:01:17, cancelled and the updater
key deleted at 05:06 (one run); a new updater key was installed through the council (proposal #2) and uploaded as
`KEYS_UPDATER_KEY`; the old key file is kept as `.secrets/sandbox-dev/keys-updater.revoked-20261030-drill.json`.
Pause drill (same day): the cron trigger removed, a forged key posted 05:51:58 and executed 05:54:25 (active);
the trigger removal hadn't propagated, so a run at 05:55:05 found it and paused within 40 s; the council removed it
(`owner:call remove_issuer_key`, proposal #3) and unpaused (#4). Heartbeat: last ping 05:55:15, healthchecks.io
reported the check down at 06:10:15 (period 5 min + grace 10 min) by email. **Cron trigger changes take minutes to
apply** (start ~10 min after the first deploy; one run after removal): stop a watchdog by deleting the Worker's
trigger and checking `/status` `last_run`, not by assuming. Other envs: not
deployed; each is created with `new` on current code.

### Setting it up (once per env)

It runs on **its own Cloudflare account** (separate login and MFA from the API's account, D86, D125); `gen` writes
that account's id into the config, so `wrangler deploy` lands it only on that account. **sandbox-dev is the
exception** (D125): its watchdog uses the same Cloudflare account as its API, for the drills only. Deploy it by hand
from a founder's machine, never from CI. The alternative host kept on file is AWS Lambda in a dedicated AWS account
(D125, with what the port changes). Run every `wrangler` command
below logged in to the watchdog's account (`wrangler login` there, or `CLOUDFLARE_API_TOKEN` for it).

1. Create the watchdog's NEAR account (`watchdog.account`, e.g. `hana-id-watchdog-dev1.testnet`, ≈ 2 NEAR; its
   full-access key stays in `~/.near-credentials`, like the other accounts) and add the `watchdog` block to
   `envs/<env>.json` (`envs/README.md`), with `watchdog.account` also in `watchdogs` (the schema requires it).
2. The owner adds it: `deploy-contract <env>` plans `add_watchdog(<watchdog.account>)` for every `watchdogs` entry
   that exists on chain (on a DAO owner, as a proposal; cancel and pause powers at once, confirm power after
   `governance_delay_ms`).
3. Secrets: `corepack pnpm --filter @hana-id/watchdog secrets <env> init` writes `WATCHDOG_KEY` and
   `WATCHDOG_STATUS_TOKEN` to `.secrets/<env>/watchdog-secrets.json` (0600) and prints the public key with the near
   CLI command that installs it (function-call key on `watchdog.account`, receiver `signer`, methods
   `cancel_issuer_key_change, confirm_issuer_key_change, pause, delete_updater_key`, 1 NEAR allowance). Run that
   command. Then paste into the same file the watchdog's own `SENDGRID_API_KEY` (a restricted key, Mail Send only, its
   own, never the admin Worker's or the issuer's; D87, D401: below), `SLACK_WEBHOOK_URL`, the paging
   app's credentials (`NTFY_TOPIC_URL` [+ `NTFY_TOKEN`], or `PUSHOVER_TOKEN` + `PUSHOVER_USER` for a group of both
   founders, or `PAGERDUTY_ROUTING_KEY`) and `HEARTBEAT_URL`; `secrets <env> check` lists what is missing (names
   only) and names a leftover `RESEND_API_KEY` as retired (delete it from the file).
   - The SendGrid key: `watchdog.alertFrom` must be a sender SendGrid has verified in the account or subuser the key
     belongs to (production: its own subuser, apart from the admin Worker's and the issuer's; every alert bypasses its
     bounce, spam-report and unsubscribe lists, so check the first one as Delivered in SendGrid's Activity), and
     `watchdog.alertEmails` the founders. sandbox-dev's are still placeholders (`watchdog@example.com`,
     `alerts@example.com`), so its email channel can't deliver until both are real (e.g. `team@hanawallet.io`, the
     verified sandbox sender) and the watchdog is regenerated and redeployed. Create the restricted key in SendGrid
     (Settings → API Keys → Restricted Access → Mail Send only), copy it, and merge it into the file without a shell
     history (`jq` reads the clipboard on stdin; the new file is 0600 under `umask 077`):

     ```sh
     umask 077
     f=.secrets/<env>/watchdog-secrets.json
     pbpaste | jq -Rs --slurpfile cur "$f" '$cur[0] + {SENDGRID_API_KEY: rtrimstr("\n")}' > "$f.new" && mv "$f.new" "$f"
     corepack pnpm --filter @hana-id/watchdog secrets <env> check
     # A watchdog already deployed: set just this secret (else step 5's `secret bulk` uploads it with the rest).
     jq -r .SENDGRID_API_KEY "$f" | corepack pnpm --dir apps/watchdog exec wrangler secret put SENDGRID_API_KEY
     ```
4. Dead-man's switch: a check on a third provider (healthchecks.io, Better Stack, Cronitor) with a 5-min period and
   ~10-min grace, alerting both founders on its own; its ping URL is `HEARTBEAT_URL`.
5. D1 and deploy (from `apps/watchdog`, logged in to the watchdog's account):

   ```sh
   corepack pnpm --dir apps/watchdog exec wrangler d1 create <watchdog.cloudflare.d1Name>    # prints the id
   corepack pnpm --filter @hana-id/watchdog gen <env> --d1-id <uuid>                          # apps/watchdog/wrangler.jsonc
   corepack pnpm --dir apps/watchdog exec wrangler d1 migrations apply <d1Name> --remote
   corepack pnpm --dir apps/watchdog exec wrangler secret bulk ../../.secrets/<env>/watchdog-secrets.json
   corepack pnpm --filter @hana-id/watchdog run deploy                                       # stamped with the build id (D406)
   corepack pnpm --filter @hana-id/scripts run deploy-check <env> --only watchdog --d1        # read through wrangler on this account
   ```

6. Check: `curl -H "authorization: Bearer $(jq -r .WATCHDOG_STATUS_TOKEN .secrets/<env>/watchdog-secrets.json)"
   https://<workerName>.<subdomain>.workers.dev/status` shows `last_run.outcome: "ok"`, `first_run: true` on the
   first run, `heartbeat.ok`, every channel `configured`. The first run alerts critical on any active kid not in
   Google's JWKS (no pause) and on anything already pending: acknowledge after checking. Then send a test critical
   page to both founders (the forced-rotation drill of the migration plan does this for real).
7. The admin Worker gets the same `WATCHDOG_STATUS_TOKEN` (an admin secret) and the watchdog's URL (`watchdog.url`
   in the manifest): "Admin Worker" → [Security & monitoring](#security--monitoring-batch-c14), steps 1–3.

**Cloudflare Access** (before any staff call): one Access application for `{url}/v1/email/admin/*` (`{url}` the issuer's, D230), policy = the
staff on `emailIssuer.access.staffEmails`, its AUD tag in `emailIssuer.access.aud`. In the application's settings set
the session cookie's **SameSite attribute to Strict** (and HttpOnly on), so no other site's request carries a staff
session; the issuer also refuses any request with an `Origin` header and any body that isn't JSON (D199).

Local: `gen <env> --dev-vars` writes `apps/watchdog/.dev.vars` (0600) from the secrets file; `corepack pnpm --filter
@hana-id/watchdog dev` runs `wrangler dev --test-scheduled` (`curl localhost:8787/__scheduled` runs one cron). Use a
test Slack channel and ntfy topic: local runs send real alerts and, with a real `WATCHDOG_KEY`, real testnet
transactions.

Rotating its secrets: `WATCHDOG_KEY`: add a new function-call key (as in step 3), put it in the file, `wrangler secret
put WATCHDOG_KEY`, then delete the old key on chain. `WATCHDOG_STATUS_TOKEN`: change it on both Workers (the admin's:
"Security & monitoring" step 2; until both match the portal shows `watchdog_unauthorized`). `SENDGRID_API_KEY`: a new
restricted key merged into the file as in step 3, `wrangler secret put` from it, then delete the old key in SendGrid.
The others: replace in the file and `wrangler secret put`.

### Email login: pins, link alarms, unrecorded wallets

The watchdog also checks Hana's email issuer (`docs/email-login-spec.md` "Watchdog", D190–D193), against the
manifest's `watchdog.pinnedIssuerKeys.email` (`envs/README.md`). The pins are public thumbprints, not secrets; they
come only from the watchdog's own manifest, never from the chain or Hana's JWKS.

- **Pins before keys.** With no pins, every email key is unpinned: the watchdog cancels a pending one and pauses on an
  active one. So the order on an env is: write the thumbprints of the issuer's keys (primary, standby: batch 4's
  `scripts/email-issuer.ts init` prints them; `corepack pnpm --filter @hana-id/watchdog pin <public key file>` prints
  the pin of any public JWK, JWKS or PEM with the Worker's own function, and says whether a JWKS kid matches) under `pinnedIssuerKeys.email.signers.hana` with `required: 1`, then
  `corepack pnpm --filter @hana-id/watchdog gen <env>` and `corepack pnpm --filter @hana-id/watchdog run deploy`
  (no new D1 migration), and check `/status` `email.pinned`; only then does the council run `set_issuer("email", …)`,
  `mark_self_issued("email")` and `set_issuer_key(…, signer: "hana")` (build plan batch 6). Between `set_issuer` and
  `mark_self_issued` a `signer_policy_transition` warning and the `governance_change` alerts are expected.
  A v2 contract reads as "no email issuer": nothing is alerted, pins or not. sandbox-dev's contract is v3 since 2026-11-03 and its manifest has the pins (the issuer's active and standby kids); the watchdog was redeployed with them on 2026-11-03 (version fd6d8b27).
- **Rotating an email key**: pin the new thumbprint first (redeploy), then the council posts it; it waits
  `governance_delay_ms` and is never confirmed early (info `self_issued_key_change`); anyone executes it after.
- **A signer-policy upgrade** (Level 1 co-signer, or replacing a signer): pin the new signer's keys before the upgrade
  executes with the current `required`; raise the pinned `required` (or drop the old signer) after it executed (D191).
  The reverse order reads as a weaker policy and pauses. The upgrade's 10-minute overlap shows as a
  `signer_policy_transition` warning; a longer one pauses (D191).
- **Link alarms** (D200): the contract counts new links per scope and in all per UTC hour and flags a scope (or the
  total) whose links reach its alarm threshold (default 50 per scope, 500 in all; `set_link_thresholds` by the council:
  lowering applies at once, raising waits `governance_delay_ms`). Nothing is refused. The watchdog reads
  `get_link_stats()` each run: a threshold reached pages `link_threshold_reached`, half the total threshold warns
  `link_volume_high`, a raise is a critical `governance_change`. A partner launch needs no action; change a threshold
  only if the alarm level is wrong for real traffic. `/status`
  `link_stats` shows both windows. A contract without the view warns `link_stats_unavailable` once an email issuer is on
  chain, so the D200 contract must be deployed before email goes live.
- **`unrecorded_wallets`** (D135, D139): sandbox-dev accepts after its v3 upgrade (`admin <env> owner:call
  accept_unrecorded_wallets`); on any env that isn't `local*` or `sandbox*` the watchdog pages while it is true.

### Identity token: pins and the JWKS check

The watchdog checks the partner identity token's published keys (`docs/identity-token-spec.md` "JWKS and discovery",
D210–D214) against `watchdog.pinnedIdentityKeys` (`envs/README.md`): public thumbprints (the kids), set only in the
watchdog's own manifest block and deployed on its own account, never taken from Hana's JWKS. `watchdog gen` passes
them as `IDENTITY_PINS` and `identityToken.iss` as `IDENTITY_ISS`; an env without `identityToken` skips the check.

- Every run, after the protective work (D86), it reads `{iss}/jwks.json` and `{iss}/.well-known/openid-configuration`
  (no cache, no redirect followed, 64 KB cap). An unpinned key (or one with members beyond the public ones), private
  key material, a wrong `issuer` / `jwks_uri`, or an answer that can't be judged (a redirect, padding, not JSON,
  duplicate members, the wrong shape) pages critical at once; 3 failed fetches in a row page critical too; a pinned key
  not published (or under another kid) warns. **It never pauses for these**: partners verify identity tokens, the
  contract never does.
- **What that catches, and what it doesn't** (D210): an attacker who publishes the same JWKS to everyone. Someone who
  controls Hana's Cloudflare account can recognise the watchdog's fetches (they come from Cloudflare's network) and
  serve them a clean JWKS while partners get another, or publish a key for less than a run. The **outside probe**
  narrows the first: the GitHub Actions workflow `identity-probe` (`.github/workflows/identity-probe.yml`, every 3
  hours at :17 since D383, no secrets; **disabled in GitHub since 2026-11-05**, D387: no probing while only testnet
  runs, and before mainnet it moves to AWS Lambda + EventBridge in its own AWS account, or one of D387's
  alternatives: Google Cloud Functions + Cloud Scheduler, a small VPS with cron) fetches each non-`local*` env's JWKS and discovery document from GitHub's network with a `jose`
  User-Agent and the same rules (`@hana-id/jwks/identity`), against `watchdog.pinnedIdentityKeys` in the repo's
  manifests, and fails on any finding (every value from Hana's answers is printed JSON-quoted, escaped to printable
  ASCII with `%` too, and cut, and no line can start with `::`, so a hostile JWKS can't inject a workflow command);
  GitHub emails the failure to whoever last changed the workflow's schedule, so
  that must be a founder (and scheduled workflows run only on the default branch). Run it by hand:
  `corepack pnpm --filter @hana-id/scripts run identity-probe <env>`. Neither closes the gap: an attacker can still
  single out partners' traffic. Partners that pin thumbprints (`docs/integration.md` section 15, the recommended
  default for anything of value) are the only ones safe from it.
- It also alerts critical (`identity_key_on_chain`) if an issuer key on chain has an identity key's thumbprint as its
  kid (D212); the Google and email rules act on such a key as on any other forged one.
- Pin changes follow "Identity token keys" above: `identity-key` writes them; the watchdog deploys first after a pin,
  last after an unpin. sandbox-dev pins its active and standby keys; its watchdog needs a `watchdog gen` and
  redeploy to start the check (not done on this branch).

### Watchdog alerts (runbook)

Critical alerts page both founders (paging app + Slack + email) and are re-sent every 15 min until someone
acknowledges them in the admin portal ("Security & monitoring" → Open alerts → Acknowledge, batch C14) or in
Pushover. Acknowledging stops only the re-sends. Every alert's text
names its id, its kind and its playbook (`Playbook: <id>`); the full details are in `GET /alerts`, and `GET /status`
`alert_kinds` gives each kind's `playbook`.

**What to do is in the playbooks**: [`docs/playbooks.md`](playbooks.md), generated from `packages/playbooks` (D126),
the same source the admin portal's "Security & monitoring" view renders. Each one has the signals, the impact, the
ordered steps with who acts (the council, a founder, anyone, the watchdog, the API cron, scope owners, the user) and the real commands, how
to verify, and the follow-ups. A test fails when an alert kind has no playbook (`apps/watchdog/test/registry.test.ts`).
This table only says what each kind means:

| Kind | What it means | Playbook |
|---|---|---|
| `forged_key_change` | A pending issuer key Google doesn't publish (or with other material; not one Google published with the same material in the last 24 h, which is a `retired_key_change`; an updater Add of a kid the watchdog never saw listed only at its deadline, `details.new_kid_deadline_ms`, after an `unseen_key_change`, D432), a pending email key whose RFC 7638 thumbprint isn't pinned for its signer in `watchdog.pinnedIssuerKeys.email` (`reason`: `not_pinned`, `other_signer`, `kid_not_thumbprint`, `no_signer`; with no pins at all every email key is unpinned, D190), or any change the updater (the signer account) proposed for a provider other than Google (`reason: updater_other_provider`: the updater only serves Google). The watchdog cancelled it and, if the updater proposed it, deleted every updater key. The title and `details.outcome` say what happened: `cancelled`; `gone` (someone else cancelled it first); `executed` (it took effect before the cancel: also a `protective_action_failed`, and the run pauses on the now-active key); `unknown` (gone, and the re-read failed); `failed`; `not_sent` (the watchdog couldn't act) | [`forged-key-change`](playbooks.md#forged-key-change) |
| `retired_key_change` | Warning, not a page (D153): the updater proposed a kid Google no longer publishes but published with the same `n`/`e` within 24 h (`details.last_seen_jwks_at`), and it is provably retired (D422): known for over 7 days, unlisted for over 6 h, missed by 3+ fetches in a row over 30+ min. The API cron's fetch raced Google's retirement of the kid. Cancelled, the updater keys kept. A kid listed within 24 h that doesn't meet all three (a new key mid-rollout) is left pending with no alert: confirmed once a fetch lists it, executed by the API if its own fetches do | [`retired-key-change`](playbooks.md#retired-key-change) |
| `unseen_key_change` | Warning, not a page (D432): the updater proposed a Google kid no fetch of the watchdog has ever listed, usually Google's new key seen first by the API cron's edge. Left pending until `details.new_kid_deadline_ms` = min(proposed + 6 h, executable − 18 min): confirmed as soon as a fetch lists it with the same material; otherwise a `forged_key_change` at the deadline (cancel, every updater key deleted), or at once if the same run finds the updater forging. No grace (straight to `forged_key_change`) for owner proposals, when the watchdog can't act, or with a delay ≤ 18 min (sandbox-dev) | [`unseen-key-change`](playbooks.md#unseen-key-change) |
| `forged_active_key` | A key Google doesn't publish, or an email key that isn't pinned (`details.provider: email`; also at the first run: pins are configuration, D190), is **active**: the contract is paused (logins and derivation stop) and every updater key deleted (D126). While it was active, anyone holding its private key could open sessions for any user's path and post OIDC-owner tokens and client proofs. Recovery runs in a fixed order: remove the key, raise the session floor past the pause (`set_sessions_valid_from_ms`), a fresh updater key, unpause; the watchdog pauses again (and deletes any new updater key) while the key stays active | [`forged-active-key`](playbooks.md#forged-active-key) |
| `published_key_removal` | A pending removal of a kid Google still publishes (logins with it would break). Alert only: the owner decides and cancels. The watchdog confirms a removal early only after 3+ fetches in a row over 10+ min missed the kid and none of its fetches listed it for 24 h (D422); otherwise the change waits out the contract's delay | [`published-key-removal`](playbooks.md#published-key-removal) |
| `unknown_active_key_first_run` | First run only: an active kid not in Google's JWKS today (often an old kid Google dropped), or with other material (then the next run pauses) | [`unknown-active-key-first-run`](playbooks.md#unknown-active-key-first-run) |
| `unverifiable_key_change` | A pending change the owner proposed for an issuer other than Google and email (the watchdog has neither a JWKS nor pins for it; one the updater proposed is a `forged_key_change`) | [`unverifiable-key-change`](playbooks.md#unverifiable-key-change) |
| `signer_policy_mismatch`; warning `signer_policy_transition` | The email issuer on chain (`get_issuer("email")`, `get_self_issued("email")`) differs from the pins. Critical and **paused** when the chain's policy is weaker (a lower `required`, a signer the pins don't list, active email keys with no signer policy, an overlap with the previous policy longer than the contract's 10 min + 5 min, D191); critical, no pause, for an email issuer nobody pinned or a pre-v3 one. Warning, no pause, for what a planned change passes through: a pinned signer not in the policy yet, the `set_issuer("email")` → `mark_self_issued("email")` gap, a higher `required` on chain, a normal overlap | [`signer-policy-mismatch`](playbooks.md#signer-policy-mismatch) |
| `unrecorded_wallets` | `get_config().unrecorded_wallets` is true on an env that isn't a dev env (D139): links are refused until the owner calls `accept_unrecorded_wallets`; it must never show on mainnet. Alert only | [`unrecorded-wallets`](playbooks.md#unrecorded-wallets) |
| `governance_change` | An upgrade proposal or execution, owner transfer, withdrawal, watchdog, updater-key, delay or console-audience change, pause or unpause (`unpaused_at_ms` shows one that fell between two runs), a raised session floor (`sessions_valid_from_ms`), a change of the owner DAO's code or policy (`owner_code_hash`, `owner_policy`: a `ChangePolicy`, `AddMember` or `RemoveMember`), `mpc`, `ckd_domain_id` or `state_version`, `unrecorded_wallets`, or the owner's immediate issuer actions, which leave no pending state: `issuer` (`set_issuer` changed Google's iss values) and `issuer_keys` (an active kid disappeared without a pending removal leaving the queue: `remove_issuer_key`; also a removal proposed and confirmed by another watchdog between two runs), and the same for the email issuer (`email_issuer`, `email_issuer_keys`) and its signer policy (`email_signer_policy`: `mark_self_issued`, or an upgrade's `migrate`). Alert only. Nobody but the owner can cancel an upgrade (D84) | [`governance-change`](playbooks.md#governance-change) |
| `automatic_action` | The watchdog acted again for an incident it already alerted (e.g. paused again after an unpause, or deleted an updater key added while a forged key is still active) | [`watchdog-acted-again`](playbooks.md#watchdog-acted-again) |
| `protective_action_failed` | A cancel, pause or updater-key deletion the watchdog sent failed, or a forged change it tried to cancel was executed first (or it couldn't tell) | [`protective-action-failed`](playbooks.md#protective-action-failed) |
| `not_a_watchdog`, `watchdog_key_missing`, `wrong_network`, `pins_invalid` | The watchdog can't act: its account isn't a contract watchdog, its key is missing or bad, or its RPC is on another chain; until fixed nothing cancels forged keys. `pins_invalid`: `EMAIL_PINS` is unreadable, so every email key counts as unpinned (cancelled, paused on; their alerts say `pins_unreadable`); `pins_invalid:identity`: `IDENTITY_PINS` is unreadable, so every published identity key pages as unpinned; `pins_invalid:identity_no_iss`: `IDENTITY_PINS` without `IDENTITY_ISS`, so the identity check can't run (it then resolves nothing) | [`watchdog-cannot-act`](playbooks.md#watchdog-cannot-act) |
| warning `rpc_failing`, `jwks_failing`, `heartbeat_failing`, `channel_not_configured` | The watchdog is partly blind or mute (a dead watchdog is caught by the dead-man's switch: [`watchdog-down`](playbooks.md#watchdog-down)) | [`watchdog-degraded`](playbooks.md#watchdog-degraded) |
| warning `unexecuted_key_change`, `stale_active_key` | A matured key change nobody executed (> 1 h), or an active kid Google dropped > 27 h ago (the cron removes after 24 h, D422) | [`key-sync-stalled`](playbooks.md#key-sync-stalled) |
| warning `active_key_material_unavailable` | The contract has no `get_issuer_keys` (older code): active keys are checked by kid only | [`active-key-material-unavailable`](playbooks.md#active-key-material-unavailable) |
| warning `config_change` | Shared clients, sponsors or public registration changed | [`config-change`](playbooks.md#config-change) |
| `relayer_balance_critical`, `relayer_allowance_critical`, `relayer_pool_empty`; warning `relayer_balance_low`, `relayer_allowance_low` | The relayer account's available balance, or a pool key's remaining allowance, is below its threshold (defaults: balance 5 / 1 NEAR; session key 0.5 / 0.1; owner key 0.1 / 0.02; manifest `watchdog.relayerFunds`), or a pool has no key: relays from it fail once it runs out. Read-only: the watchdog never tops up | [`relayer-out-of-funds`](playbooks.md#relayer-out-of-funds) |
| warning `confirm_failed` | A confirmation of a key that matches Google's JWKS failed: it goes live only after the full delay | [`confirm-failed`](playbooks.md#confirm-failed) |
| warning `email_jwks_mismatch` | Hana's published email JWKS lists a key that isn't pinned (or whose kid isn't its thumbprint), lacks an active email key, or failed 3 fetches while email keys are active. Informational: the contract never reads it | [`email-jwks-mismatch`](playbooks.md#email-jwks-mismatch) |
| `identity_key_unpinned`, `identity_private_key_published`, `identity_discovery_mismatch`, `identity_jwks_unreadable` | Hana's partner identity JWKS (`{iss}/jwks.json`) publishes a key whose RFC 7638 thumbprint isn't in `watchdog.pinnedIdentityKeys` (or that isn't P-256, or has members beyond `kty crv x y kid use alg`; with nothing pinned every key is unpinned), or private key material, or its discovery document names another `issuer` or `jwks_uri` (D210, D213); or an answer can't be judged: a redirect, a 200 over 64 KB, not JSON, duplicate members, the wrong shape (at once), or 3 failed fetches in a row (`:sustained`). Partners trusting the JWKS URL would accept tokens for any user. Alert only, **no pause** (the chain isn't involved). A rotation deployed in the wrong order (API before the watchdog after `next`, the watchdog before the API after `retire`) also raises it | [`identity-jwks-forged`](playbooks.md#identity-jwks-forged) |
| warning `identity_key_missing` | A pinned identity key isn't in the JWKS under its thumbprint as kid with public members only (a rotation half deployed, a kid changed, or extra members: then also `identity_key_unpinned`) | [`identity-jwks-degraded`](playbooks.md#identity-jwks-degraded) |
| `identity_key_on_chain` | An active Google or email issuer key, or a pending key addition, has an identity token key's thumbprint as its kid (D212). Alert only: the same run's issuer-key rules cancel or pause on it | [`identity-key-on-chain`](playbooks.md#identity-key-on-chain) |
| `link_threshold_reached`; warning `link_volume_high`, `link_stats_unavailable` | `get_link_stats()` (D200): links reached an alarm threshold in the current or previous UTC hour, in one scope or in all; they went through (the contract refuses nothing): a partner launch, or a stolen email key taking over Google wallets by linking (alert only; the council decides whether to pause); the current hour at half the total threshold; or the view is missing with an email issuer on chain, malformed or failing (`link_stats_unavailable:missing` / `:malformed` / `:read_failed`; only the link check is affected, every protective step still runs) | [`link-volume`](playbooks.md#link-volume) |
| info `key_change_confirmed`, `key_change_executed`, `key_change_cancelled` | Routine key-change events | [`key-change-lifecycle`](playbooks.md#key-change-lifecycle) |
| info `self_issued_key_change` | A pending email key pinned for its signer, or a pending email key removal: never confirmed (self-issued keys wait `governance_delay_ms`) | [`self-issued-key-change`](playbooks.md#self-issued-key-change) |
| info `config_matured` | A scheduled delay decrease or console-audience addition came into force | [`config-matured`](playbooks.md#config-matured) |
| info `first_run` | The first run recorded Google's current JWKS as known | [`watchdog-first-run`](playbooks.md#watchdog-first-run) |

Incidents the watchdog doesn't raise (a stolen updater or relayer key, `VAULT_KEK`, a compromised API, origin,
watchdog or council member, a pause, Google, RPC, MPC or D1 outages, compromised Google clients, a leaked user key,
and the planned email issuer) have their playbooks in the same file.

A paused contract: only the owner unpauses (`unpause`, no delay, D82). An unpause re-arms the scope-change timelock:
no `execute_change` before `unpause time + change_delay_ms` (`changes_unlock_floor_ms`, also in `get_scope` as each
pending change's `unlock_at_ms`), since OIDC owners couldn't cancel while paused. A fix that needs new code waits
`governance_delay_ms` (the upgrade path works while paused). Removing a rogue watchdog (`remove_watchdog`) is
immediate but slows every key change to `governance_delay_ms` unless another watchdog confirms (D86). Likewise a key
change proposed while no watchdog may confirm yet (none, or only ones added less than `governance_delay_ms` ago)
waits `governance_delay_ms`: after adding the first watchdog, rotations go slow until its `confirm_from_ms`.

## Email issuer (`apps/email-issuer`)

The email login's issuer (`docs/api.md` "Email issuer", `apps/email-issuer/README.md`, D195–D199): its own Worker,
separate from the API, holding the email signing key, K_sub, K_code, K_rl and the SendGrid key. **Deployed on sandbox-dev
(2026-11-03, with batch 8b, 5 secrets, SendGrid from team@hanawallet.io; redeployed 2026-11-04 at `develop` f53d63e,
version b0cb9058, after migration 0002 was applied; then fa18b944 with the dev-env limits, D340; 2026-11-05 at `develop` 8aab09d, version 1542a60c, with D345's ticket fallback); no other env yet.** Order matters: on sandbox-dev follow "Email login on sandbox-dev (build plan batch 6)" below (the watchdog's
email pins are live before the owner posts any email key, and no app enables email, `apps.login_methods`, before
batch 8). It is reached at `{emailIssuer.url}/v1/email/*` (D230): on a `workers.dev` env its own `workers.dev` URL,
written by `init`; on a zone, the API's URL with a route `<api host>/v1/email/*` to this Worker. Below, `{url}` is that
origin. The API never forwards these requests.

### Setting it up (once per env; testnet and `local*` only)

1. **Keys and manifest block** (uploads nothing, prints no secret):

   ```sh
   corepack pnpm --filter @hana-id/scripts email-issuer <env> init --from "Hana <login@<user-mail subdomain>>" --budget 1000   # plan
   corepack pnpm --filter @hana-id/scripts email-issuer <env> init --from "Hana <login@<user-mail subdomain>>" --budget 1000 --yes
   ```

   Writes `.secrets/<env>/email-issuer-signing-key.json` (RSA-2048 primary, the Worker secret),
   `email-issuer-signing-key-standby.json` (published and posted on chain, **never uploaded**: move it offline),
   `email-sub-key`, `email-code-key`, `email-rl-key` (base64 of 32 bytes each), all 0600 and never overwritten, and the
   `emailIssuer` block in `envs/<env>.json` (`url` the issuer's own `workers.dev` URL when the API is on `workers.dev`,
   iss `{url}/v1/email`, Worker and D1 `hana-id-email-issuer-<env>`, both
   public keys with kid = RFC 7638 thumbprint, the primary active, sender `sendgrid`; `--outbox` for the test stub in
   `local*` envs only). It prints the watchdog pin block. **Back up `email-sub-key` offline twice** (with the council
   backup, D81) before the first email login: losing K_sub locks every email user out, and a new one moves every email
   address. Commit the manifest.
2. **Watchdog pins** (batch 5, D190): add the printed block as `watchdog.pinnedIssuerKeys.email` and redeploy the
   watchdog (its own account) **before** step 6. `email-issuer <env> show` prints it again, with the `set_issuer_key`
   arguments.
3. **SendGrid** (D194): domain authentication (SPF, DKIM, DMARC `p=quarantine`) for the dedicated user-mail sending
   subdomain; **a subuser for the issuer's mail alone** (required, D194: the webhook trusts only the issuer's categories
   and the suppression list must be the issuer's); an API key of that subuser with **Mail Send only**, used by this
   Worker alone, pasted into `.secrets/<env>/email-issuer-sendgrid-key` (0600; never in chat or a shell history). Don't
   buy the Email Activity History add-on: SendGrid keeps each message's recipient and events in its Email Activity for
   its plan's period (3 days without the add-on when written; check at setup) and Hana can't shorten it. Its
   suppression lists (bounces, blocks, spam reports) keep an address **until it is removed** there. The signed
   Event Webhook (bounce, spam report) of that subuser to `{url}/v1/email/webhooks/sendgrid`, its verification key
   in `emailIssuer.sendgridWebhookPublicKey` (public); events of other categories are ignored.
4. **D1 and config**: `wrangler d1 create hana-id-email-issuer-<env>`, then
   `corepack pnpm --filter @hana-id/email-issuer gen <env> --d1-id <issuer uuid> --app-d1-id <the API's D1 uuid>` and
   `wrangler d1 migrations apply hana-id-email-issuer-<env> --remote` from `apps/email-issuer` (from a checkout at the
   commit you deploy, "Checking a deploy"). `gen` refuses a
   Worker-secret signer off testnet, the `aws-kms` signer (until batch 10) and the outbox outside `local*`.
5. **Secrets** (the user runs this): `corepack pnpm --filter @hana-id/scripts email-issuer <env> put` (plan), then
   `--yes`: sets `ISSUER_SIGNING_KEY`, `EMAIL_SUB_KEY`, `EMAIL_CODE_KEY`, `EMAIL_RL_KEY` and, when its file exists,
   `SENDGRID_API_KEY` on the issuer Worker through wrangler's stdin. The standby is never uploaded.
6. **Chain** (owner DAO; on sandbox-dev step 9 of "Email login on sandbox-dev"): `set_issuer("email", [iss])`,
   `mark_self_issued("email")`, one `set_issuer_key("email", key, signer: "hana")` per published key (each waits
   `governance_delay_ms`, then anyone executes it). The scopes' email clients come later (batch 8, D234): `AddClient
   ("email", "email:" + scope)` with a staff client proof (`POST {url}/v1/email/admin/client-proof {scopeId,
   actionNonce, ticket}` with the scope's current `action_nonce`, "Staff calls" below; configure `emailIssuer.access`),
   which the issuer mints only once an active app of the scope lists `email` in `login_methods`. In dev envs
   (`local*`, `sandbox*`) `admin <env> scope:add-email-client --scope <id>` mints it locally instead and sends the
   owner's calls (D253; "Email login demo on sandbox-dev (batch 8a)" step 3).
7. **Deploy**: `corepack pnpm --filter @hana-id/email-issuer run deploy` (before step 6's keys go on chain, so the
   watchdog's JWKS check finds it), then `deploy-check <env> --d1` ("Checking a deploy"). On a zone env, add the route `<api host>/v1/email/*` → `hana-id-email-issuer-<env>`
   (Workers Routes on the API's zone; the more specific route wins over the API's); on `workers.dev` nothing more.
   `gen` turns `workers_dev` on only when `emailIssuer.url` is a `workers.dev` URL; a zone-routed issuer has no
   `workers.dev` URL (a second way in, around the zone's rules and Access). An `emailIssuer.url` on any other host (a
   dev env on custom domains, `https://email.<dev domain>`) is a Custom Domain the deploy creates (D404). **Open for batch 8**: the staff routes'
   Cloudflare Access application on a `workers.dev` hostname (sandbox-dev). Cloudflare documents self-hosted
   applications on a `workers.dev` hostname or path, which the admin console's uses (D409); `access-setup` doesn't
   make the issuer's (`{url}/v1/email/admin/*`) yet.

Local: `gen <env> --dev-vars` writes `apps/email-issuer/.dev.vars` (0600) from the files (the active key only), then
`corepack pnpm --filter @hana-id/email-issuer dev`.

### Runbook

| Symptom | Meaning | Action |
|---|---|---|
| `503 signer_unavailable` | ISSUER_SIGNING_KEY missing, malformed, not the manifest's `activeKid`, or a signature failed its self-check | `email-issuer <env> show`; `put --yes` again; never edit the kid by hand |
| `503 issuer_unavailable` | an HMAC key is missing or two are equal | `put --yes`; never generate a new K_sub for an env that has email users |
| `email_budget` (warn log, `code` `global_50` / `global_80` / `owner_50` / `owner_80` / `app_50` / `app_80`, `appId`) | the day's user mail passed half or 80% of the general pool (what the staff pool leaves of `dailySendBudget`) or of one app's share (2% of its plan's `per_day`) (D198) |
| `email_owner_pool` (warn log, `code` `owner_50` / `owner_80`) | ticket and unlock mail passed half or 80% of the owner pool (30% of `dailySendBudget`, beside it); past half only tickets ≥ 7 days old and grants draw on it, fresh tickets ≤ 20% of it per app; refused owner mail falls back to the app's general share (D198) | ticket mail is normally small: a high owner pool means many tickets in use at once, possibly an attacker's stock of sock-puppet tickets at one catch-all domain; `admin/revoke-tickets` for addresses found, and look at `limit` lines by app | an `app_*` line names the app: check its traffic (a partner bug or a scripted abuse of its key); a `global_*` line with no app near its share means broad traffic |
| `send_budget_exhausted` (error log, `code` `global`, `app`, `reserve`, `owner` or `unconfigured`) | `global`: the general pool is spent, `start` and `resend` answer 429 for everyone without a device ticket or unlock grant; `app`: that app used its share; `reserve`: the last 20% is held for apps under half their share; `owner`: the owner pool is spent for the day (aged ticket holders and grants wait too: look at once, see `email_owner_pool`); `staff`: the staff pool (1%, ≥ 5) for unlock and unsuppress mails is spent; `unconfigured`: the Worker has no `DAILY_SEND_BUDGET` outside `local*`, so it sends nothing | look for abuse (per-app `limit` logs, `appId`); raise `dailySendBudget` in the manifest only if the traffic is real, then `gen` and deploy. An app's share follows its plan's `per_day`. `unconfigured`: set `emailIssuer.dailySendBudget`, `gen`, deploy |
| `email_complaint_rate` (error log, `count`) | more than 5 spam complaints in 24 h on the issuer's mail | check which app's flows run (`code_mail` by `appId`) and SendGrid's stats for the subuser; a sustained rate risks the sending domain's reputation: lower `dailySendBudget` or suspend the app |
| `email_domain_cap` (warn log, `subject` = domain key prefix) | a non-exempt recipient domain used its 100 code mails today (each requester prefix at most 20); its users without a device ticket get 429 until midnight UTC (D198) | a real company rollout, or someone mailing many addresses at one domain: check `limit` logs and apps; repeats of the same `subject` on several days are worth a look |
| `missing_client_ip` (warn log) | a request reached the Worker without a usable `cf-connecting-ip` (not through Cloudflare's edge): refused with 400 | check the route: the issuer is reached directly at `{url}` (D230), never through another Worker |
| `code_mail` errors with `misconfigured` / provider 401/403 | the SendGrid key is wrong, revoked or lacks Mail Send | new key into the file, `put --yes` |
| `code_mail` errors with `unavailable` | SendGrid 429 or 5xx (the counts were taken back) | SendGrid status; users can resend after 30 s |
| `google_account_mismatch` answers from google-match | A user picked another Google account on Google's email permission screen; the popup asks them to try again (D264) | none, unless a burst |
| `mailbox_guess_limit` (error log, `code` `backstop` or `ceiling`, `subject` = mailbox key prefix) | someone is guessing codes for one mailbox: past the backstop (18; dev envs 80) only owner-slot requesters and ticketed challenges can check, past the ceiling (25; dev envs 100) nobody until midnight UTC (D198, D340) | watch for repeats of the same `subject`. A user with a device ticket (an earlier sign-in on that browser) still gets 3 codes a day and the ticket slot. When a user without one contacts support: `admin/unlock` ("Staff calls" below). It mails a one-time link to the address itself (only the mailbox's holder can use it, so it is safe whoever asked), clears nothing, and adds at most 2 checks to the day; at most once a day and 3 times in 30 days per mailbox |
| A user says the codes never arrive | the address may be suppressed (a bounce in the last 30 days, or a spam complaint), or the mailbox limits refuse | once the cause is fixed (mailbox full, a complaint by mistake): **first** remove the address from the issuer subuser's suppression lists in SendGrid (Suppressions: Bounces, Spam Reports, Blocks; search the address, delete it), or SendGrid drops the confirmation too; **then** `admin/unsuppress` ("Staff calls"): it mails the address a confirmation link, and the suppression goes when the user opens it (24 h) |
| A user lost a device, or a device ticket may have leaked | anyone holding the ticket gets that address's owner allowances (3 codes a day, the ticket slot), never a token | `admin/revoke-tickets` ("Staff calls"): every ticket of that exact address issued until now stops counting; the next sign-in issues a fresh one |
| `limit` lines `ip:webhook:10m` (sandbox-dev first) | SendGrid's event posts from one IP passed 120 in 10 min (a guess, D199 L4); refused posts are retried by SendGrid | if it is SendGrid's real traffic, raise `IP_WEBHOOK_LIMITS` in `apps/email-issuer/src/limits.ts` |
| A suspected key leak | anyone with the Worker's secrets can mint email tokens (1-of-1, D121): sessions for any email user's path | "Suspected issuer key leak" below |
| `directory_write_failed` (warn log, `appId`, `scopeId`) | a user directory write failed (D269); the login itself went on | one now and then: D1 had a blip, the next login writes the row. Every login: migration 0002 isn't applied on this env's issuer D1 ("User directory (D269)" below) or D1 is down |

### Staff calls

Every staff route needs an Access session, `Content-Type: application/json`, no `Origin` header (so not from a
browser page), and a support reference `ticket` (the support case id, kept in the audit row; 1–64 of `A–Z a–z 0–9 .
_ # : -`). Use `cloudflared access curl`, with the body on stdin so the address stays out of the shell history:

```sh
cloudflared access login {url}/v1/email/admin/unlock
cloudflared access curl {url}/v1/email/admin/unlock -X POST -H 'Content-Type: application/json' --data-binary @-
{"email": "<their address>", "ticket": "<support case id>"}
# then Ctrl-D
```

`admin/unlock` answers `{mailed}`: the one-time link went to the address itself; staff never see a token, so there is
nothing to pass on (`{mailed: false, reason: "suppressed"}`: unsuppress first). `admin/unsuppress` and
`admin/revoke-tickets` take the same body (unsuppress answers `{mailed}` too: the user confirms from the mail);
`admin/client-proof` takes `{"scopeId", "actionNonce", "ticket"}`. The audit row (`email_admin_audit`: staff, action,
ticket, mailbox or address key prefix, or scope) is written before the action. 20 staff actions an hour per staff
member, all routes together; unlock, unsuppress and revoke-tickets at most once a day and 3 times in 30 days per
mailbox each (`429 staff_cap`). Access's certs: a failed fetch or an unknown kid is cached for 30 s (L3), so a key
rotation at Cloudflare reaches the issuer at most 30 s late.

### User directory (D269)

The issuer keeps each identity's verified address for Hana staff (D269): `user_emails` (provider, `sub` as on chain,
the address, `email_verified`, `hosted`, first and last seen) and `user_email_apps` (which apps and scopes), in its own
D1 (migration `0002_user_emails.sql`; `docs/api.md` "Durable Objects, D1 and bindings"). An email login writes its row
at every successful `verify`, after the answer; a Google login writes its row at google-match once its checks pass
(apps with email login), and under `'token_first'` (D270, in force since 2026-11-04) at google-record (apps without email
login), only once `/v1/login` has succeeded: userinfo's address, `email_verified` and `hosted`. A failed write logs
`directory_write_failed` and never fails a login. Writes can land out of order; a row keeps the newest write's address,
`email_verified`, `hosted` and scope, and the widest seen window. Nothing partner-facing reads it. There is no
backfill: a user appears at their first login after the migration.

Two limits on what a row means (D269): a Google row with `email_verified = 0` is only that account's **claim** to
the address (anyone can put any address on a Google account), never proof that it owns it; and anyone can make
google-record or google-match write rows for their own Google account and any active app, even one it never logged
in to, so an app listed for a Google identity is a strong hint, not proof. Matching and linking never read the
directory (they read `email_hints`). Besides the CLI below, staff read it in the admin console's Users screen, through
the issuer's `DirectoryRpc` ("Users screen (C8b)" under "Admin Worker": issuer migration 0003, the deploy order).

**Applying migration 0002 on sandbox-dev** (the user runs this, from the main checkout; additive, two new tables, so
no rollback step: an older Worker ignores them). Apply it before deploying an issuer that writes the directory (in the
other order every login logs `directory_write_failed` until it is applied, and still works):

```sh
corepack pnpm --filter @hana-id/email-issuer gen sandbox-dev            # keeps the D1 ids already in wrangler.jsonc
corepack pnpm --dir apps/email-issuer exec wrangler d1 migrations list hana-id-email-issuer-sandbox-dev --remote    # 0002_user_emails.sql pending
corepack pnpm --dir apps/email-issuer exec wrangler d1 migrations apply hana-id-email-issuer-sandbox-dev --remote
corepack pnpm --filter @hana-id/email-issuer run deploy
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --d1
```

Check: `deploy-check` passes (`migrations list` shows nothing pending); after an email login on the demo, `admin sandbox-dev user:list --remote
--limit 1` shows it. Other envs: the same with `hana-id-email-issuer-<env>`.

**Reading it** (Hana staff with Cloudflare access to the issuer's D1; `$A` = `corepack pnpm --filter @hana-id/scripts
admin <env>`, `--remote` for the deployed D1 (wrangler logged in, or `CLOUDFLARE_API_TOKEN`), without it the local
one in `apps/email-issuer/.wrangler/state`, which needs `apps/email-issuer/wrangler.jsonc` from `gen`):

```sh
$A user:list --remote                                   # newest first by last seen, 50 by default
$A user:list --remote --app app_… --provider email --limit 200
$A user:list --remote --search -                        # type part of the address on stdin
$A user:find --remote                                   # type the exact address (or a sub) on stdin
$A user:find --remote --sub e1.…
$A user:find --remote --json
```

Each user: the address, provider, `sub`, verified, first and last seen, and per app its scope and the identity's own
on-chain path `{scope}#{provider}#{sub}#0` (a linked member's wallet is its account root's: `get_identity`); with the
wallet directory (migration 0011, "Wallet directory (hot-DB migration 0011)"), per scope its User ID (`u1_…`), Support ID, internal id (`hu_…`), role
in the account and the account's wallets, read from the API's D1 the same private way. An
exact address matches as typed (lowercased: Google rows) and normalized (`@hana-id/email`: email rows, so
`Alice.Smith@gmail.com` finds `alicesmith@gmail.com`). **Unverified Google rows** (`email_verified = 0`):
`user:find` lists the verified users first and these apart, after "UNVERIFIED: this Google account claims the address
but Google hasn't verified it; don't treat it as the owner" ("No verified user with that address" when there are only
these); `user:list` tags each one's address line `[UNVERIFIED: claimed, not verified by Google]` and counts them under
the header; `--json` carries `unverifiedClaim: true` on each (the verified first in `user:find`). Never treat such a
row as the address's owner in support. The commands only SELECT. **The addresses are for this terminal only**: type
them on stdin (`-`, or `user:find` with no flag) so they stay out of the shell history, never redirect the output to
a file outside `.secrets/`, never paste them into a ticket or chat.

The statement never goes in a process argument (`ps` and endpoint monitoring would see the searched address;
`scripts/lib/d1.ts` `issuerD1Execute`):

- **Local** (no `--remote`): the CLI writes it to a random `d1-<hex>.sql` file, mode 0600, in `.secrets/tmp/` (created
  0700; `.secrets/` is gitignored), runs `wrangler d1 execute <issuer D1> --local --json --file <it>`, and deletes it
  in a `finally`. A run killed mid-way (Ctrl-C while wrangler runs) can leave its file: the next run removes this
  helper's files older than 15 minutes, or delete `.secrets/tmp/d1-*.sql` by hand.
- **`--remote`**: not wrangler's `--remote --file`, which in wrangler 4.151.1 is D1's import (the file uploaded to
  Cloudflare's import bucket, the database unavailable to queries while it runs) and answers with counts, never rows.
  The CLI reads the operator's credentials with `wrangler auth token --json` (over a pipe, never printed: an OAuth
  token from `wrangler login`, refreshed if expired, or `CLOUDFLARE_API_TOKEN`, or `CLOUDFLARE_API_KEY` +
  `CLOUDFLARE_EMAIL`), finds the account (`CLOUDFLARE_ACCOUNT_ID`, or the credentials' only account) and the database
  by `emailIssuer.cloudflare.d1Name`, and POSTs the statement to D1's REST query endpoint (HTTPS body, 30 s timeout).
  `CLOUDFLARE_API_BASE_URL` overrides the public API (needed for FedRAMP or Cloudflare's staging API). Errors name
  Cloudflare's codes and messages with every quoted span replaced by `'…'`, so they never quote the statement.

wrangler runs with `WRANGLER_WRITE_LOGS=false` (it otherwise copies its output, the rows or the token included, to
`~/.wrangler/logs`), and no metrics or error reports.

If `K_sub` were ever lost, the `sub` stored per address keeps the existing email users' wallets reachable (their
paths are `{scope}#email#{sub}#0`; an issuer change would look the `sub` up here instead of computing it); users not in
the directory would still be locked out, so the offline K_sub backups stay required.

### Suspected issuer key leak

`$I` = `corepack pnpm --filter @hana-id/scripts email-issuer <env>`, `$A` = `corepack pnpm --filter @hana-id/scripts
admin <env>` (owner calls take the council's approvals as usual, `--approve-with`).

1. **Decide what is exposed.** The Worker's secrets or the Cloudflare account: the active signing key, K_sub, K_code,
   K_rl and the SendGrid key (the standby was never uploaded). `.secrets/<env>/` or the operator's machine: every file
   there, the standby too unless it was offline. **Unless the incident provably touches only the Worker, treat the
   standby as exposed.**
2. **Pause**: `$A owner:call pause --yes`. Logins and derivation stop; no session opens while paused.
3. **Remove the leaked key** (immediate): `$A owner:call remove_issuer_key --args '{"provider":"email","kid":"<active
   kid>"}' --yes` (`$I show` prints the kids). Both exposed: the standby's kid too.
4. **Only the active key exposed: switch to the standby.** `$I put --standby` (plan), then `$I put --standby --yes`:
   switches `emailIssuer.signer.activeKid` in `envs/<env>.json` to the standby's kid and uploads the standby as
   `ISSUER_SIGNING_KEY` (with the three HMAC keys). Then `corepack pnpm --filter @hana-id/email-issuer gen <env> --d1-id
   … --app-d1-id …` and `corepack pnpm --filter @hana-id/email-issuer run deploy`; commit the manifest. Check `$I show`
   names the standby active and `GET {url}/v1/email/jwks.json` still lists it. **Expect `503 signer_unavailable`
   between `put --standby --yes` and the deploy:** the running Worker's `EMAIL_ACTIVE_KID` still names the removed key
   while its secret is already the standby, and its self-check refuses the mismatch (logins wait; nothing wrong is
   signed). Run `gen` and `deploy` at once. The env has no standby until a new
   one is made (no command yet: batch 10 replaces the Worker key with KMS; to confirm). **Both exposed:** email logins
   stay off until a new key passes `set_issuer_key` (72 h, `governance_delay_ms`) and the watchdog pins.
5. **Watchdog pins**: delete the removed kid(s) from `watchdog.pinnedIssuerKeys.email` and redeploy the watchdog, so a
   re-post of the leaked key is `forged_active_key`.
5b. **The published keys**: delete the removed kid(s) from `emailIssuer.publicKeys` in `envs/<env>.json` (after step 4
   the active kid is the standby's, which stays), commit, then `corepack pnpm --filter @hana-id/api run gen <env>` and
   `run deploy` (the API checks email tokens against `EMAIL_PUBLIC_KEYS`, so it stops accepting the leaked key's
   tokens even before the chain refuses them) and the issuer's `gen` and `run deploy` (its JWKS stops listing it).
6. **Session floor**: `$A owner:call set_sessions_valid_from_ms --args '{"sessions_valid_from_ms": <a time after the
   pause began>}' --yes`, before unpausing, so sessions the leaked key opened can't derive.
7. **The other Worker secrets**, when the Worker's secrets were exposed. Of the HMAC keys, **K_sub can't be rotated**
   (privacy only: it would move every email address); **K_code and K_rl can be**. Revoke the SendGrid key in SendGrid and paste a
   new one into its file; replace K_code and K_rl (`(umask 077; openssl rand -base64 32 > .secrets/<env>/email-code-key)`,
   the same for `email-rl-key`; it prints nothing): live challenges, device tickets and today's counters reset, nothing
   else. Then `$I put --yes`. **Never K_sub** (it would move every email address); a K_sub leak is privacy only (the
   holder can map addresses to `sub`s and paths), and suppressions stay keyed by it.
8. **Unpause**: `$A owner:call unpause --yes`.
9. Tell partners (security contacts): the kid, the window in which forged tokens may have been accepted.

Limits are in `docs/api.md` "Email issuer" (D198): per (mailbox, requester), per mailbox with a reserve for new
requesters and the device ticket's allowance, live challenges, the wrong-code locks, the ceiling (18 + 4 + 3), the IP
prefixes, the recipient domain and the budget's shares. **Dev envs** (`local*`, `sandbox*`, so sandbox-dev) run higher
code, wrong-code and per-IP limits (D340: 20 codes per 15 min and 100 a day per mailbox and requester, 30 and 200 per
mailbox, 20 live and 250 challenges a day, 30 wrong codes an hour, ceiling 80 + 17 + 3, `start` 30 per 10 min and 300 a
day per IP, `resend` 30, `verify` 90); the recipient-domain cap, tickets, grants and the budget are as in production.
They take effect at the issuer's next deploy and apply to today's counters at once: a tester refused under the old
numbers needs no reset. The env name decides; no manifest field can turn them on elsewhere.

## Email login on sandbox-dev (build plan batch 6)

The steps that take sandbox-dev from contract v2 to v3 with Hana's email issuer set up on chain, **for the user to run,
in this order**, against `develop` with batches C3, C4 and C5 merged (D234 corrects the plan's order and command names).
Nothing here turns email on for any app: every app's `login_methods` stays `'google'` and no scope gets an email client
(batch 8, D234), so users see nothing. Testnet only. Each step says how to check it before the next.

Before you start:

- An up-to-date `develop` checkout with batch 6 merged, `corepack pnpm install` done, logged in to Cloudflare (the API's
  account; the watchdog shares it on sandbox-dev, D125).
- The council members' signing keys: on sandbox-dev (a dev env) the scripts read them from
  `.secrets/sandbox-dev/council/<member>.json` (0600, made by `council-setup`), not from the near CLI keychain. The
  council is 2 of 3: `--approve-with <second member>` passes a proposal in the same command.
- The relayer, signer and owner full-access keys in `~/.near-credentials/testnet/` as `deploy-contract` reads them.
- On a fresh checkout `apps/api/wrangler.jsonc` doesn't exist yet: the first `gen` needs `--d1-id <the API's D1
  uuid>` (`corepack pnpm --dir apps/api exec wrangler d1 info hana-id-sandbox-dev` prints it). Without it `gen` writes
  the placeholder id `00000000-0000-4000-8000-000000000000`, and a deploy with it binds no real database. Later runs
  keep the id. The same holds for the issuer's `gen` (`--d1-id`, `--app-d1-id`).

```sh
ENV=sandbox-dev
MEMBER=hana-id-council-b-dev1.testnet            # the second approval for the council's proposals
SIGNER=hana-id-signer-dev1.testnet
API=https://hana-id-api-sandbox-dev.tingtc.workers.dev
ISSUER=https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev
AUTH=https://hana-id-auth-sandbox-dev.tingtc.workers.dev
```

**Alerts to expect and acknowledge** (the watchdog pages them; each is the step's own change, not an attack): at step 6
`governance_change` for the upgrade proposal, then for its execution (`pending_upgrade`, `state_version` 2 → 3,
`unrecorded_wallets` appearing); at step 7 `governance_change` for `unrecorded_wallets` clearing; at step 9
`governance_change` for `email_issuer` (`set_issuer`) and `email_signer_policy` (`mark_self_issued`), a
`signer_policy_transition` warning between the two, and the info `self_issued_key_change` while each key waits. Any
`forged_key_change`, `forged_active_key` or `signer_policy_mismatch` is **not** expected: stop and follow its playbook.
(`unrecorded_wallets` itself never pages on a `sandbox*` env, D193.)

1. **The issuer's keys and manifest block** ("Email issuer" step 1 above; uploads nothing, prints no secret):

   ```sh
   corepack pnpm --filter @hana-id/scripts email-issuer $ENV init --from "Hana <login@<user-mail subdomain>>" --budget 1000
   corepack pnpm --filter @hana-id/scripts email-issuer $ENV init --from "Hana <login@<user-mail subdomain>>" --budget 1000 --yes
   ```

   Writes the five 0600 files in `.secrets/sandbox-dev/` and the `emailIssuer` block, with `url` `$ISSUER` and `iss`
   `$ISSUER/v1/email` (the API is on `workers.dev`, so the issuer has its own URL, D230). It prints the watchdog pin
   block. Back up `.secrets/sandbox-dev/email-sub-key` offline twice and move the standby key file offline. Commit
   `envs/sandbox-dev.json` (a PR into `develop`). Check: `email-issuer $ENV show` lists both kids, the first active.

2. **Watchdog pins** (D190): paste the printed block as `watchdog.pinnedIssuerKeys.email` in `envs/sandbox-dev.json`
   (commit it), then

   ```sh
   corepack pnpm --filter @hana-id/watchdog gen $ENV
   corepack pnpm --filter @hana-id/watchdog run deploy
   ```

   Check: the watchdog's `/status` shows `email.pinned` with both kids under `hana` and `required` 1, `email.jwks_url`
   `$ISSUER/v1/email/jwks.json`, and no new alert (v2 reads as "no email issuer").

3. **The API's D1** (migrations only add; the API deployed there now keeps working on them). List what is applied:

   ```sh
   corepack pnpm --filter @hana-id/api run gen $ENV          # add --d1-id <uuid> on a fresh checkout (above)
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT name FROM d1_migrations ORDER BY id"
   ```

   - **Without `0006_dashboard_expand.sql`**: run "Hot DB migration 0006 and the new gate" steps 1–5 (the data checks,
     the backup, the rehearsal, the apply, the checks). Its apply lists `0006_dashboard_expand.sql`,
     `0009_session_markers.sql` and `0010_login_methods.sql`, in that order; confirm.
   - **With 0006**: `corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote`
     lists whichever of `0009_session_markers.sql` and `0010_login_methods.sql` isn't applied yet; confirm.

   Check: `d1_migrations` ends with `0006…`, `0008…`, `0009…`, `0010…` (0008 sits before 0006 by date: wrangler
   applied it first); `SELECT login_methods, COUNT(*) FROM apps GROUP BY login_methods` gives `google` for every app;
   `SELECT COUNT(*) FROM email_usage` is 0.

   **Usage capture (batch C4): optional for the demo.** The API records usage in the Neon ledger only with the
   `USAGE_DB` binding; without it capture is off and every endpoint answers as before (fail open, D222). To capture,
   run "Usage capture" steps 1–4 and 6 now (`usage-migrate` applies `0002`–`0005` here: identity tokens, writer
   partitions, email counts, the link relays' events; the role passwords from Neon's API, D403; the two Hyperdrive configs;
   `USER_ID_KEY`; `gen $ENV --usage-hyperdrive-id <writer id>`), and its step 8 gate after step 4 below. Skip all of it
   for the demo if you like: nothing below depends on it. **Not optional**: "Usage capture" step 7 (the legacy counters
   into `session_markers`), right after step 4's deploy.

4. **The pages, then the API, with the create_session proof (D137)**, before the upgrade. The pages first: the vault's
   split path sends the proof, which the API deployed now ignores (it drops unknown fields); the new API then requires
   it. v2 ignores the argument and v3 requires it (`contracts/integration-tests/tests/governance.rs`
   `v2_ignores_the_create_session_proof_that_v3_requires`).

   ```sh
   corepack pnpm --filter @hana-id/api run gen $ENV
   corepack pnpm --filter @hana-id/web build
   corepack pnpm --filter @hana-id/api run deploy:pages
   corepack pnpm --filter @hana-id/api run deploy
   curl -s $API/v1/health
   ```

   Check, as batch C3's step 6: `/v1/health` shows `"hotDb":9` and `"capabilities":{"createProof":true}`; a login on the
   demo (`/v1/login`) and one on `apps/smoke`'s direct page (`/v1/sessions` with the proof, then `/v1/derive`) work;
   `corepack pnpm --filter @hana-id/scripts run admin $ENV app:list --remote` shows every app `active` or
   `suspended(hana)` as before, with its key and origins; `curl -s -H "x-hana-key: <a test app's pk>" -H "Origin: <its
   origin>" $API/v1/app` has `"loginMethods":["google"]` and no `email`. Then "Usage capture" step 7 (the marker copy).
   **From now on use only this checkout's admin CLI** (batch C3's rule: an older one writes origins that never match),
   and **never roll the API or the pages back below batch 6 once step 6 has executed**: an older API or vault sends no
   proof, and every split-path session then fails on v3 (a rollback before step 6 is safe).

5. **The session pool's new allowlist, without downtime** (the three link methods; an access key's methods can't be
   edited). New keys first, the switch, then the old keys go:

   ```sh
   mv .secrets/sandbox-dev/relayer-keys.json .secrets/sandbox-dev/relayer-keys.before-batch6.json      # keeps 0600
   corepack pnpm --filter @hana-id/scripts run deploy-contract $ENV          # plan: generate 3 session keys with the new list
   corepack pnpm --filter @hana-id/scripts run deploy-contract $ENV --yes    # writes the new file, adds the keys
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/sandbox-dev/relayer-keys.json")))' \
     | corepack pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   ```

   The plan warns about the old keys ("in neither pool file (left untouched)"), each with its `near account
   delete-keys hana-id-relayer-dev1.testnet public-keys <key> …` command: they keep working until the secret switches,
   so logins never stop. After the secret is set, check a demo login works (expect one `relay_retry` `invalid_nonce`
   per key on its first relay: each new key starts at its own on-chain nonce), then run the printed delete commands,
   and `rm .secrets/sandbox-dev/relayer-keys.before-batch6.json`. Check: `deploy-contract $ENV` shows no blocker and no
   warning about relayer keys.

6. **Contract v3 through the council** ("Upgrading the governance contract"; the plan's `upgrade-contract propose |
   execute` is this command). `deploy-contract --upgrade` refuses while `$API/v1/health` doesn't report
   `capabilities.createProof` (step 4).

   ```sh
   corepack pnpm --filter @hana-id/scripts run deploy-contract $ENV --upgrade                                  # plan: build, propose_upgrade(<hash>)
   corepack pnpm --filter @hana-id/scripts run deploy-contract $ENV --upgrade --approve-with $MEMBER --yes     # the DAO's propose_upgrade, approved
   # … wait governance_delay_ms (60 s on sandbox-dev) …
   corepack pnpm --filter @hana-id/scripts run deploy-contract $ENV --upgrade --skip-build --yes              # execute_upgrade: deploy + migrate, one receipt
   ```

   Check: `state_version` 3, `unrecorded_wallets` `true`, `view_account.code_hash` the proposed hash; a demo login and a
   direct-page (`/v1/sessions`) login work; the watchdog shows only the expected alerts above.

   ```sh
   near contract call-function as-read-only $SIGNER get_governance json-args '{}' network-config testnet now
   near contract call-function as-read-only $SIGNER get_config json-args '{}' network-config testnet now
   ```

7. **Accept the pre-v3 wallets** (D135; sandbox-dev's are test data, discarded at the address freeze; never on
   mainnet):

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin $ENV owner:call accept_unrecorded_wallets --approve-with $MEMBER --yes
   ```

   Check: `get_config().unrecorded_wallets` is `false`.

8. **The issuer Worker** ("Email issuer" steps 3–5, 7 above), before its keys go on chain, so the watchdog can read its
   JWKS from the first active key: SendGrid subuser, Mail-Send key in `.secrets/sandbox-dev/email-issuer-sendgrid-key`
   (0600), the webhook to `$ISSUER/v1/email/webhooks/sendgrid`, then

   ```sh
   corepack pnpm --dir apps/email-issuer exec wrangler d1 create hana-id-email-issuer-sandbox-dev          # prints its uuid
   corepack pnpm --filter @hana-id/email-issuer gen $ENV --d1-id <issuer uuid> --app-d1-id <the API's D1 uuid>
   corepack pnpm --dir apps/email-issuer exec wrangler d1 migrations apply hana-id-email-issuer-sandbox-dev --remote
   corepack pnpm --filter @hana-id/scripts email-issuer $ENV put                                            # plan
   corepack pnpm --filter @hana-id/scripts email-issuer $ENV put --yes
   corepack pnpm --filter @hana-id/email-issuer run deploy
   curl -s $ISSUER/v1/email/jwks.json
   curl -s -X POST $ISSUER/v1/email/start -H "Origin: $AUTH" -H 'Content-Type: application/json' \
     --data '{"pk":"<a test app pk_test_…>","email":"demo@example.com","purpose":"session","commitment":{}}'
   ```

   Check: the JWKS lists exactly the manifest's two keys (`jq '[.keys[].kid]'`); the `start` call answers `403
   email_not_enabled` (the app gate runs before the commitment is read; no mail is sent, no app has email on). The
   watchdog's `email_jwks_mismatch` stays clear.

9. **The email issuer on chain, through the council.** Pre-check first: the watchdog's `/status` `email.pinned` lists
   both kids under `hana` (step 2); `owner:call set_issuer_key` for `email` refuses a kid that isn't pinned for its
   signer in `watchdog.pinnedIssuerKeys.email`, isn't its thumbprint, or isn't in `emailIssuer.publicKeys` with those
   `n` and `e` (it checks the manifest; the deployed pins are `/status`'s). Values from `email-issuer $ENV show`:

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin $ENV owner:call set_issuer --args "{\"provider\":\"email\",\"iss_values\":[\"$ISSUER/v1/email\"]}" --approve-with $MEMBER --yes
   corepack pnpm --filter @hana-id/scripts run admin $ENV owner:call mark_self_issued --args '{"provider":"email"}' --approve-with $MEMBER --yes
   # once per published key (primary, then standby), with its kid, n and e from `show`:
   corepack pnpm --filter @hana-id/scripts run admin $ENV owner:call set_issuer_key --args '{"provider":"email","kid":"<kid>","n":"<n>","e":"AQAB","signer":"hana"}' --approve-with $MEMBER --yes
   ```

   Each key change waits **120 s** here: a self-issued key waits the larger of `issuer_key_delay_ms` (120 000 on
   sandbox-dev) and `governance_delay_ms` (60 000), and is never confirmed early. Then execute both (anyone may):

   ```sh
   near contract call-function as-read-only $SIGNER get_key_changes json-args '{}' network-config testnet now      # the two ids
   near contract call-function as-transaction $SIGNER execute_issuer_key_change json-args '{"id":<id>}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <any funded testnet account> network-config testnet sign-with-legacy-keychain send
   ```

   A key posted by mistake and still pending: `admin $ENV owner:call cancel_issuer_key_change --args '{"id":<id>}'
   --approve-with $MEMBER --yes` (no wait); an active one: `remove_issuer_key` (immediate, DoS only).
   Check, the issuer and its policy exactly as the manifest says:

   ```sh
   near contract call-function as-read-only $SIGNER get_issuer json-args '{"provider":"email"}' network-config testnet now   # iss_values
   jq -r '.emailIssuer.iss' envs/sandbox-dev.json                                                                          # must be the one value above
   near contract call-function as-read-only $SIGNER get_self_issued json-args '{"provider":"email"}' network-config testnet now
   ```

   `get_issuer("email").iss_values` is exactly `[<the manifest's emailIssuer.iss>]`; `get_self_issued` lists signer
   `hana` with both kids and `required` 1; the watchdog has no `forged_*`, `signer_policy_mismatch` or
   `email_jwks_mismatch` alert and `/status` shows both keys pinned and active.

10. **Not in batch 6**: the email clients `AddClient ("email", "email:<scope>")` and any `login_methods` change wait for
    batch 8 (D234): the issuer mints a staff client proof only for a scope with an active app that has email on. Check
    that nothing changed for users: `GET /v1/app` still answers `loginMethods: ["google"]` for every test app, and
    `SELECT DISTINCT login_methods FROM apps` is `google` alone.

**If a step fails.** Steps 1–3 and 8 touch nothing on chain. Step 4 is an ordinary deploy (`wrangler rollback`, pages
and API; below batch C3 see "Rolling the API back below batch C3"); after step 6, never below batch 6 (above). Step 5:
until the old keys are deleted, putting the old file back and re-uploading `RELAYER_KEYS` undoes it. Step 6's `migrate`
failure leaves v2 in place (re-propose a fixed build); a v3 that misbehaves can't go back to v2 (its `migrate` refuses
v3 state): fix forward. Steps 7 and 9 are owner calls; a pending email key is cancelled with
`cancel_issuer_key_change`, an active one removed at once (`remove_issuer_key`), and the watchdog cancels or pauses on
any unpinned one.

## Email login demo on sandbox-dev (batch 8a)

**Only demo and test scopes get email in 8a (D248).** Every email identity opened in 8a is a wallet of its own, and it can never join a Google account later (the contract refuses a link to an identity that already has a wallet: "Sign-in method already has a wallet"). Nothing writes `email_hints` before google-match (batch 8b), so case B never happens in 8a: a Google user who picks email with their Gmail address gets that second wallet. So turn it on only for the demo's scope
(Hana's own testers), never for a scope with real Google users, until google-match's hint writes or a merge path ship
(`docs/mainnet-readiness.md` row 7.1g).

What turns plain email login on for **the demo app only**, on top of "Email login on sandbox-dev (build plan batch 6)"
above (steps 1–9 done: v3, the issuer Worker and its keys on chain). Testnet only; for the user to run. Every other
app stays Google-only. Nothing here is automated yet (the partner console toggle is batch 9).

**SendGrid is required for real mail.** The issuer sends code mails only through SendGrid (`emailIssuer.sender:
"sendgrid"`, D194); the `outbox` stub is `local*`-only by design (the manifest schema and `gen` refuse it on
sandbox-dev, so codes never land in a store an operator can read on a shared env) and stays that way. Without
`SENDGRID_API_KEY` on the issuer, `start` still answers `202` (enumeration-safe) but no mail goes out, so nobody can
sign in with email there (the issuer logs `code_mail` `misconfigured`). Set SendGrid up first (batch 6 step 8: subuser, Mail-Send key in
`.secrets/sandbox-dev/email-issuer-sendgrid-key`, `email-issuer sandbox-dev put --yes`, the signed webhook).

Checklist, in order (each check before the next):

1. **The issuer's staff route for client proofs: not needed on sandbox-dev** (step 3 mints the proof locally, D253).
   Outside dev envs, and for the other staff calls: `emailIssuer.access` in the manifest (the Cloudflare Access
   application in front of `{url}/v1/email/admin/*` and the staff allowlist, D88), `email-issuer gen`, issuer deploy.
   Check: `POST {url}/v1/email/admin/client-proof` without Access is refused.
2. **`login_methods` for the demo app** (D1; no CLI command yet). Find its id with `admin sandbox-dev app:list
   --remote`, then

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "UPDATE apps SET login_methods = 'google,email' WHERE id = '<demo app id>'"
   ```

   Nothing changes for users yet: `GET /v1/app` lists email only once the scope holds its email client (step 3).
   Check: `SELECT id, login_methods FROM apps WHERE login_methods <> 'google'` is the demo app alone.
3. **The scope's email client** `AddClient ("email", "email:<demo scope>")` (D234), in one command (dev envs only,
   D253). The demo's scope is `s2`, owned by `hana-id-admin-dev1.testnet` (its full-access key in
   `~/.near-credentials/testnet/`); the issuer's active signing key must be in
   `.secrets/sandbox-dev/email-issuer-signing-key.json` (0600, from `email-issuer sandbox-dev init`):

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev scope:add-email-client --scope s2         # the plan
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev scope:add-email-client --scope s2 --yes   # send
   ```

   It reads the scope fresh (`get_scope`: `action_nonce`, owners, clients, pending changes), refuses when the client
   is already there, when the contract is paused, when the email issuer, its self-issued policy or the manifest's
   active key isn't on chain (`get_issuer`, `get_self_issued`, `get_issuer_keys("email")`, n and e compared), or
   when no `Owner::Near` of the scope has a full-access key in the keychain and on chain. It mints the client proof
   with the issuer's own code (`apps/email-issuer/src/client-proof.ts`: the claims of the staff route, `sub`
   `hana-client-proof`, `aud` `email:<scope>`, 10 min `exp`, a random `jti`) and checks it against the contract's
   rules with the manifest's public key and with the chain's key before printing the plan (the proof is printed; the
   key never is). With `--yes` the owner sends `propose_change(scope, "Near", {"AddClient":{"provider":"email",
   "aud":"email:<scope>"}}, client_proof)` with 0.01 NEAR and 150 Tgas (one RS256 check, like `cancel_link`, D155),
   waits out the change's `unlock_at_ms` when it is ≤ 10 min away (sandbox-dev's `change_delay_ms` is 60 s), sends
   `execute_change` (50 Tgas, signed by the owner) and checks `get_scope`. A change that unlocks later stays pending:
   re-run with `--yes` once it is due (a pending AddClient is executed, never proposed twice). Unlike the staff
   route, the local mint doesn't check that an active app of the scope has email on: do step 2 first.
   **In production the proof comes from the issuer's staff route behind Cloudflare Access** (`POST
   {url}/v1/email/admin/client-proof {scopeId, actionNonce, ticket}`, "Staff calls" in "Email issuer"), audited, and
   the scope's owner (the partner, or the council) sends `propose_change` itself; the command refuses every env but
   `local*` and `sandbox*`. Check: `get_scope` lists `["email","email:<scope>"]`; `GET /v1/app` for the demo's key has
   `"loginMethods":["google","email"]` and `"email":{"aud":"email:<scope>"}`.
4. **The pages, then the API, with batch 8a** (the same order as batch 6's step 4): `corepack pnpm --filter
   @hana-id/api run gen sandbox-dev` (the auth page Worker gets `EMAIL_ISSUER_URL`, `/login/email`'s connect-src),
   `corepack pnpm --filter @hana-id/web build` (the bundles pin `emailIssuer.url` and `iss` from the manifest), `run
   deploy:pages`, `run deploy`, then the demo (`apps/demo`, its own deploy). Check: `curl -sI {authOrigin}/login/email` shows `connect-src
   https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev https://hana-id-api-sandbox-dev.tingtc.workers.dev`;
   on the demo, "Log in with email" → address → the mailed code → the wallet; "Log in with Google" is unchanged.
5. **Undo**: `UPDATE apps SET login_methods = 'google' …` turns email off at once (`GET /v1/app`, the issuer's
   `start` and the API all read it; an email token is then `403 login_method_disabled`). The scope's email client
   can stay (it serves nothing without `login_methods`) or go through `remove_client`.

**Before SendGrid: an internal demo on the local stack.** The Playwright stack (`apps/e2e`) runs the real popup,
vault, SDK, API Worker and email issuer Worker on loopback, with the `outbox` stub, a mocked NEAR chain and a test MPC
(not testnet: the keys are throwaway, and Google login there only works under Playwright's stub). For showing the email
UX:

```sh
HANA_E2E_PORT_BASE=4410 corepack pnpm --filter @hana-id/e2e serve
curl -s -X POST http://127.0.0.1:4440/__e2e/apps -H 'content-type: application/json' \
  -d '{"name":"Hana ID demo","origins":["http://localhost:4412"],"publishableKey":"pk_test_DemoE2eDemoE2eDemoE2e","loginMethods":"google,email"}'
# open http://localhost:4412 → "Log in with email"; the code is in:
curl -s 'http://127.0.0.1:4442/__e2e/outbox?to=<address, lowercased>'
```

Create the app before anything else on a fresh stack (a second create with the same key returns the first app
unchanged). This is a demo of the screens and the flow, not of sandbox-dev; say so when showing it.

## Turning linking on (batch 8b)

Batch 8b ships automatic linking (one person, one wallet: Google and email with the same verified address open the
same wallet), `hana.account()`, `hana.linkAccount()` and email-wallet key export. It has **no switch of its own**: it
is on for every app whose `login_methods` lists email, once its code is deployed. Testnet only; for the user to run.
Nothing below changes the contract, an address or a key.

What users see, by case (`docs/integration.md` "Sign-in methods and links" has the partner's view):

| Case | The user | The popup shows | Result |
|---|---|---|---|
| A, Google-hosted | had an email wallet (`…@gmail.com`, or a Workspace address whose `hd` is its domain), signs in with Google | Google's account chooser; the first time for this client, Google's one sign-in screen also lists "Email address" (`'token_first'`, D270: no Hana screen, no second Google screen); then "Signed in", or "Your Google sign-in now opens this wallet too" | the email wallet; Google joins it at once |
| A, not hosted | had an email wallet on another domain, signs in with Google | "This email already has a wallet": **Link and continue** (a code to `a…@domain`, typed in the popup) or **Sign in with email** | the email wallet either way; linked only after the code |
| B, Google-hosted | had a Google wallet, chooses "Continue with email" with its Gmail address and types the code | "This email belongs to a wallet you created by signing in with Google": **Link and continue** or **Sign in with Google**, then Google | the Google wallet; the email joins at once (a notice mail goes to the address) |
| B, not hosted | the same with an address Google doesn't host | the same, then "An email will be able to open this wallet from {date}" with **Cancel this link** | the Google wallet; the email joins after `change_delay_ms` (sandbox-dev: the contract's value; 24 h on mainnet); an email login meanwhile is `link_pending` with the date |
| C | has neither wallet | the usual sign-in | a new wallet for that method; a Google login records the hint for later |
| Declined | a Google user cancels Google's one sign-in screen | Hana's chooser again: "Google sign-in was cancelled.", **Continue with Google** or **Continue with email** (case B's own choices when its Google step was cancelled; D341) | Google again or email signs in; closing the popup there ends the login with `login_cancelled`, never `google_error` |
| Another account | google-match finds the access token's account isn't the ID token's (`google_account_mismatch`; a user without a wallet) | "Another Google account was chosen": **Sign in with email instead**, **Try Google again** (Google's email permission for the signed-in account), Cancel (D264, kept under D270) | an email login, or Google again; Cancel ends `login_cancelled` (`google_account_mismatch`; a refusal on the retried screen `email_consent_declined`). A user with a wallet sees nothing of it |

Checklist, in order (each check before the next):

1. **Prerequisites**: batch 6's chain setup and batch 8a's demo steps above (v3, `accept_unrecorded_wallets` done:
   `get_config().unrecorded_wallets` is `false`, else every link is refused `links_unavailable`; the issuer Worker and
   its keys on chain; SendGrid). Check: `GET /v1/app` for the demo's key lists `email`.
   **Two NEAR providers**: the manifest's `rpc` and `rpcFallback` on different providers (sandbox-dev: fastnear and
   `rpc.testnet.near.org`; `packages/env` refuses an env with `emailIssuer` and no `rpcFallback`, or both on one
   registrable domain). Every login of a linked identity reads its path on both separately and is refused while either
   is down (D263). Check: `curl -s -X POST <each rpc> -H 'content-type: application/json' -d
   '{"jsonrpc":"2.0","id":1,"method":"status","params":[]}'` answers on both. sandbox-dev's second provider,
   `rpc.testnet.near.org`, is slow and rate-limited (accepted for the testnet demo; mainnet-readiness 4.19). **Watch
   `path_unconfirmed` rates**: the vault decides it in the browser and no Worker logs it, so watch the demo's
   *Copy diagnostics* and users' reports for `api_unavailable` with `data.reason: 'path_unconfirmed'`; a rise means
   the second provider is failing (run the check above).
2. **Google clients**: nothing to register. Every request uses the same client and the same
   `{authOrigin}/login/callback` redirect URI. The OAuth consent screen of each Google client used in an env with an
   email issuer must allow the `email` scope (a non-sensitive scope: no verification needed). Check (once, by hand): a
   Google login of the demo shows the email address on Google's sign-in screen the first time, and only the account
   chooser after.
3. **The API with batch 8b**: `corepack pnpm --filter @hana-id/api run gen sandbox-dev` (the API gets
   `EMAIL_ISSUER_URL` for the vault page's `connect-src`, and `NEAR_RPC_FALLBACK`), `corepack pnpm --filter
   @hana-id/web build`, `run deploy:pages`, `run deploy`. The login relay now takes writes from `vaultOrigin` (the
   vault's follow-up notices), 40 a minute per IP (was 10), and bodies up to 12 KiB (was 8; D267). Check: `curl -sI
   '{vaultOrigin}/vault?pk=<demo key>'` shows the issuer's origin and both RPCs in `connect-src`.
4. **The issuer with batch 8b** (its case-B `verify` answers the address's `sub` beside the `linkTicket`; google-match
   no longer revokes Google's access token, answers `google_account_mismatch`, and takes 120 a minute per 10 min per
   IP; D264, D265, D267): `email-issuer gen`, deploy. Check: an email login of an address with a Google wallet shows
   "Link and continue"; a second Google login of the demo shows no Google consent screen.
5. **Try each case on the demo** (two browsers or two profiles help): C, then A hosted (email login first with a Gmail
   address, then Google with that account: same addresses), B hosted (a fresh Google login, then "Continue with
   email" with its Gmail address: "Link and continue": same addresses; an email login afterwards opens them too),
   and B not hosted with the pending banner and its **Cancel this link**.
6. **Watch**: the watchdog's link alarms (`link_threshold_reached`, `link_volume_high`, D200) count these links; a
   demo's handful is far under the thresholds. The issuer's request log for `google-match` carries the decision only (never an
   address).
7. **Undo**: `UPDATE apps SET login_methods = 'google' …` stops email and every new link for the app at once. Links
   already made stay (they are chain state); a pending one can be cancelled from the popup's banner at its owner's
   next sign-in. A wrong link is removed by the root's **Remove** banner (unlink), or by `POST /v1/link/unlink`.

**Lifting D248 ("demo scopes only").** Since every Google login of an app with email now calls google-match, which
writes the `email_hints` row for that Google account's verified address, a later email login with that address reaches
case B instead of a second wallet. The remaining gap: a Google wallet opened **before** its app turned email on has no
hint until its owner signs in with Google there again. So for a scope that already has Google users, either turn email
on and accept that window (an email login by such a user in it opens a separate email wallet, which can never merge,
D122), or wait until those users have signed in with Google once since. Hana's own testers on the demo scope are fine
either way. The readiness item is `docs/mainnet-readiness.md` row 7.1g.

**Google's verified email: the spike** (`apps/smoke/spike-email.html`, build plan batch 0). **Passed on 2026-11-04**
(the user, with sandbox-dev's shared login client): every leg, for a personal Gmail, a Workspace account on its own
domain and a Google account on a non-Google (iCloud) address; the results are in `docs/context.md` ("Google email
scope spike"). Leg **E** runs D270's `'token_first'` exactly: a `response_type=token`, `scope=openid email` request,
the account's `sub` from `tokeninfo` (POST, from the page: tokeninfo answered the browser's CORS call, 200), then a
silent `response_type=id_token`, `scope=openid`, `prompt=none`, `login_hint=<sub>` request (issued, openid-only, the
nonce matching, the same account); **E2** repeats only the silent request (clean). The popup's `'token_first'` is the
same sequence, plus one interactive openid-only retry of the silent request (D273). The one-request value
(`id_token token`, `openid email`) is gone from the popup (D273: Google puts `email` in that ID token, D270); the
spike's leg A still records it. Re-run the spike (`apps/smoke/README.md`) after any change to the Google requests
and for a new Google project (`docs/mainnet-readiness.md` row 7.1h).

**The flow in force: `GOOGLE_EMAIL_FLOW = 'token_first'`** (`packages/web/src/auth/google.ts`, switched on
2026-11-04 once the spike passed, branch `feat/token-first-on`; a code constant, changed only by a reviewed one-line
change). Every Google login of an env with an email issuer asks Google for the email on its one sign-in screen, also in
apps without email login (their address goes to the issuer's user directory only, D269); an env without an email
issuer keeps batch B's openid-only login. **Deploying the switch** to an env:

1. **The email issuer first, if needed.** Its `POST /v1/email/google-record` (an app without email login records its
   users' Google address) and google-match's directory write come from `feat/google-token-first`; the user directory
   needs migration 0002 (above, "Applying migration 0002"). If the deployed issuer predates them, apply 0002, then
   `corepack pnpm --filter @hana-id/email-issuer gen <env>` and `run deploy`. In the other order nothing breaks: a
   record-only login's google-record call fails in the background (best effort) and the login goes on, recording
   nothing.
2. **Both page Workers** (the vault and the auth pages: the bundles carry the constant):
   `corepack pnpm --filter @hana-id/web build`, then `corepack pnpm --filter @hana-id/api run deploy:pages`. The
   callback's CSP has listed `https://oauth2.googleapis.com` in both policies in an env with an email issuer since
   `feat/google-token-first`; no `gen` change. The API Worker itself needs no redeploy for the switch (its claim
   allow-list is on every route since D271: deploy it if it predates that).
3. **Google clients**: nothing to register (the same client and `{authOrigin}/login/callback`). Each client's OAuth
   consent screen must allow the `email` scope (non-sensitive), as for second_request.
4. **Check**: `curl -sI '{authOrigin}/login/callback'` shows `https://oauth2.googleapis.com` in `connect-src`; a first
   Google login of the demo with a fresh account shows Google's single "Sign in to … / … access this info about you:
   Email address" screen with Cancel / Continue and no Hana "One more step with Google" screen; a returning account
   sees only the account chooser; `admin <env> user:find` (or `user:list --limit 1`) shows the row.
5. **Undo**: the one-line change back to `'second_request'` and step 2 again. Logins already made are unaffected (the
   flow changes no path or key).

If tokeninfo ever stops answering the browser's cross-origin POST, every token_first login of an app with email login
ends `tokeninfo_unavailable` (by design: never a request without the hint), and a Google-only app's login falls back to
batch B's openid request with the chooser and records nothing: switch back to `'second_request'` (step 5).

**Gate before real users (D265):** the user runs the spike's legs **C** and **D** on real Google, for each of the three
accounts, after B: C (a plain `openid` login once the email grant exists) must show `tokenHasPiiLockout: false` (no
`email` or `email_verified` in the ID token, else every later Google login of that user would be refused
`token_has_pii`), and D (B's silent request again) must answer an access token with no `silentError` (the grant
persists, now that google-match no longer revokes it). Until both pass, batch 8b stays on Hana's own testers.

## Moving an env to another Cloudflare account

D404. **Pending for sandbox-dev:** the user decided on 2026-11-05 that testnet too moves from the personal accounts to
company accounts: Cloudflare (`*.tingtc.workers.dev` today), Neon (the usage ledger's project) and the Google Cloud
project that owns the OAuth clients. Timing is open (with the colleague); `docs/mainnet-readiness.md` row 4.21 tracks
it. Nothing below has been run on sandbox-dev yet. The tools (`env-secrets`, `d1-move`, `admin issuer:iss`) are tested
against mocks only. Until then (D414, 2026-11-05) sandbox-dev's M4 pieces (the admin console's Access application on
team `bitter-hill-fe6f`, the console D1, the R2 buckets, Images, the usage Hyperdrive configs, the SendGrid keys, the
console's Google client, the admin, console, console-auth and files Workers) are set up on the personal account; the
move re-creates them on the company account like everything else.

Cloudflare doesn't move Workers, D1 databases, Durable Objects, Hyperdrive configs or R2 buckets from one account to
another (we found no such feature documented), so the env is re-created on the new account and its data copied. Put it
on **custom domains** of a zone in the new account at the same time: a `workers.dev` origin names the account's
subdomain, so every origin would change again on the next move. A dev env may put every origin under one registrable
domain (`api.id-dev.hanawallet.io`, `vault.id-dev.…`, `auth.id-dev.…`, `email.id-dev.…`); production may not (the
vault on its own site, D38). The **watchdog stays on its own account** (D86; the schema refuses `cloudflare.accountId`
equal to `watchdog.cloudflare.accountId`).

**Wallets don't change.** A wallet's path is `scope#provider#sub#key_index` (`contracts/hana-signer/src/sessions.rs`,
the session's `path: format!("{}#{}#{}#{}", scope_id, path_provider, path_sub, key_index)`, with the provider and `sub`
of the token's identity or its account root), where `provider` is the contract's provider name for the token's `iss`
(`iss_index`, `issuers.rs` `verify_token`; `set_issuer` maps 1 to 4 `iss` values to one provider and keeps its keys),
never the `iss` or a URL; the email `sub` is HMAC(K_sub, the normalized
address) (`packages/email/src/sub.ts`), K_sub coming from `.secrets/<env>/email-sub-key`; Google's `sub` is Google's.
`signer`, `mpc`, `ckdDomainId` and the MPC key don't move. So a new issuer URL keeps every address as long as its new
`iss` is added to the **same** provider (`email`) before the issuer signs with it. Keep the files in `.secrets/<env>/`:
K_sub, `user-id-key` and `identity-sub-key` are never replaced (a new K_sub moves every email address, a new
`USER_ID_KEY` makes every user a new user, a new `IDENTITY_SUB_KEY` changes every partner's `sub`).

### What users and partners see

- **Everyone is logged out once.** Sessions, the vault's device state and the auth pages' device tickets live in the
  browser storage of the old `vaultOrigin` / `authOrigin`; the new origins start empty. Users sign in again (Google or
  email); their addresses and balances are unchanged. The `vault_shares` rows copied with the API's D1 can't be used
  without their browser half and expire as usual.
- Lost with the Durable Objects (not copied): logins and email codes in flight at the switch (retry), the per-IP,
  per-app and per-mailbox limiters' counts (they start from zero), the relayer keys' stored reservations (each key
  re-reads its nonce from chain on first use, `coldChainRead`).
- **Partners** must: allow the new `vaultOrigin` in their CSP `frame-src` (and the new `apiUrl` where their CSP lists
  it), install the SDK release that carries the new origins (the package inlines every env's origins: "Releasing the
  SDK packages"), add `{new authOrigin}/login/callback` to their own Google clients' redirect URIs (own-client apps
  only), and switch identity-token verification to the new `iss` and JWKS (`{apiUrl}/v1/identity`, D127). Their
  publishable keys, app settings and origins move with the API's D1 and don't change. Tell them before the switch.

### Prerequisites

- The new account (a company account: members with MFA, the plan chosen; the free plan allows 5 cron triggers per
  account: the API 1, the console 1, the admin 2; D1 Time Travel keeps 30 days on Workers Paid, 7 on Free) and either
  its `workers.dev` subdomain or, better, a **zone on that account** for the Custom Domains (a Worker's Custom Domain
  must be on a zone of the Worker's own account: if `hanawallet.io` lives in another Cloudflare account, the Workers go
  there, or `id-dev.hanawallet.io` becomes its own zone, which needs a plan with subdomain zones: check before
  choosing). The hostnames must have no DNS record yet (`wrangler deploy` creates the record and the certificate).
- Access to both accounts from the same machine. Either one wrangler login that is a member of both (wrangler then
  asks or takes `CLOUDFLARE_ACCOUNT_ID`), or wrangler's named profiles (`wrangler auth create personal`, `wrangler auth
  create company`, experimental in 4.151.1; `d1-move --from-profile/--to-profile`), or one API token per account
  (Workers Scripts, D1, Workers Routes/Zone DNS for the Custom Domains, Hyperdrive, R2 and Access as needed), kept in
  the shell only as `HANA_FROM_CLOUDFLARE_API_TOKEN` / `HANA_TO_CLOUDFLARE_API_TOKEN` for `d1-move` and as
  `CLOUDFLARE_API_TOKEN` for the other commands. Revoke both tokens after the move. Every `gen` refuses a shell
  `CLOUDFLARE_ACCOUNT_ID` that isn't the manifest's account for that Worker, so set it per step:

  ```sh
  export OLD=<old account id> NEW=<new account id> ENV=sandbox-dev
  ```

- Record two test users' addresses before you start (a Google one and an email one, on the demo app): the check at
  the end compares them.

### Steps

1. **Freeze and bookmark.** Announce the window (partners, colleagues): no app, origin or settings changes from here on
   (writes to the old D1 after the export are not copied). Note each database's current Time Travel bookmark on the old
   account (it undoes anything that goes wrong there; "Restoring a D1 database"):

   ```sh
   CLOUDFLARE_ACCOUNT_ID=$OLD corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-sandbox-dev
   CLOUDFLARE_ACCOUNT_ID=$OLD corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-email-issuer-sandbox-dev
   ```

2. **The manifest, in one commit** (on a branch, reviewed; `pnpm -r test` validates it): `cloudflare.accountId` = the
   new account; `apiUrl`, `vaultOrigin`, `authOrigin` (bare https origins on the new zone); `emailIssuer.url` and
   `emailIssuer.iss` (`{url}/v1/email`, the schema checks it); `identityToken.iss` (`{apiUrl}/v1/identity`); the
   dashboard origins and the Access fields (`admin.accessTeamDomain` / `accessAud`, `emailIssuer.access`: the new
   account's Zero Trust team and applications) when the env has them; `watchdog.pinnedIssuerKeys.email.jwksUrl` if it
   is set. Keys, kids, client ids and account names stay. Update the docs that quote the old URLs in the same branch
   (`docs/integration.md`'s sandbox-dev values, this file's examples, `docs/architecture.md`'s status rows). Merge it
   before the deploys: every `gen` below reads it.
3. **New resources on the new account** (each prints its id; ids aren't secrets):

   ```sh
   export CLOUDFLARE_ACCOUNT_ID=$NEW
   corepack pnpm --dir apps/api exec wrangler d1 create hana-id-sandbox-dev --location apac
   corepack pnpm --dir apps/api exec wrangler d1 create hana-id-email-issuer-sandbox-dev --location apac
   # dashboard envs: the console's D1 and the R2 buckets with their rules ("Files Worker and logos" steps 1-3);
   # Hyperdrive comes in step 7
   ```

   Access (dashboard envs): the new account's Zero Trust team and its login methods by hand ("Admin Worker" step 1),
   then the admin console's application with `access-setup $ENV --account-id $NEW --yes --write-manifest` (D409),
   whose API token in `.secrets/<env>/cloudflare-access-token` must be a token of the **new** account; the issuer's
   staff routes' application (`emailIssuer.access`) is still made by hand.

   Don't `migrations apply` the new databases: the export carries the schema and `d1_migrations`.
4. **The email `iss` on chain, beside the old one** (the council; immediate, no governance delay; on a dev env one
   command proposes and approves). The contract keeps 1 to 4 `iss` values per provider and refuses one another
   provider uses; `set_issuer` keeps the provider's keys:

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin $ENV issuer:iss email --add https://email.id-dev.hanawallet.io/v1/email --approve-with hana-id-council-b-dev1.testnet       # plan
   corepack pnpm --filter @hana-id/scripts run admin $ENV issuer:iss email --add https://email.id-dev.hanawallet.io/v1/email --approve-with hana-id-council-b-dev1.testnet --yes
   ```

   It reads `get_issuer("email")` and sends the whole list (old, new). The watchdog raises `governance_change`
   (`email_issuer`) on its next run: expected, acknowledge it. Off dev envs it only proposes, and two members sign.
   Google's `iss` values never change. The identity token's `iss` is not on chain: the manifest alone (step 2).
5. **Copy the databases** (before any Worker runs on the new account: the API's cron writes to its D1 every 15 min, and
   an import goes only into an empty database). Per database: export from the old account into
   `.secrets/<env>/d1-export-<db>-<yyyymmdd>.sql` (0600), import into the new one, then every table's row count in the
   export, the new database and the old one now (`d1_migrations` included):

   ```sh
   corepack pnpm --filter @hana-id/scripts run d1-move $ENV --db api --from-account $OLD --to-account $NEW            # plan
   corepack pnpm --filter @hana-id/scripts run d1-move $ENV --db api --from-account $OLD --to-account $NEW --yes
   corepack pnpm --filter @hana-id/scripts run d1-move $ENV --db issuer --from-account $OLD --to-account $NEW --yes
   # dashboard envs: --db console
   ```

   `--step export|import|compare` runs one step (`--file` names an older export). It fails if the new database differs
   from the export, and lists the tables the old one changed in since: the old crons' own tables
   (`issuer_key_*`) are expected; anything else (apps, origins, the wallet or user directory) means a write was lost:
   stop it, `wrangler d1 delete` the new database, create it again and repeat. Wrangler runs in an empty scratch
   directory with each side's account, so no generated `wrangler.jsonc` points a name at the other account's id.
6. **Configs** (`CLOUDFLARE_ACCOUNT_ID=$NEW` or unset; each config now carries `account_id`):

   ```sh
   corepack pnpm --filter @hana-id/api gen $ENV --d1-id <new API D1 id> --usage-hyperdrive-id off
   corepack pnpm --filter @hana-id/email-issuer gen $ENV --d1-id <new issuer D1 id> --app-d1-id <new API D1 id>
   # dashboard envs: console, console-auth, files, admin (each its gen, the console's with its new D1 id)
   ```

   Always pass the new ids: a `gen` keeps the ids of an existing config generated for the same names, which are the
   old account's (the same goes for the Hyperdrive ids: `off` until step 7 makes new ones).

7. **Deploy, then the secrets**, in this order (the vault Worker's service binding and the issuer's `APP_DB` need the
   API; the admin's needs the issuer's `DirectoryRpc`):

   ```sh
   corepack pnpm --filter @hana-id/api run deploy
   corepack pnpm --filter @hana-id/api run deploy:pages
   corepack pnpm --filter @hana-id/email-issuer run deploy
   corepack pnpm --filter @hana-id/scripts run env-secrets $ENV                  # every secret, its file, ok / MISSING / INVALID
   corepack pnpm --filter @hana-id/scripts run env-secrets $ENV --worker api --yes
   corepack pnpm --filter @hana-id/scripts run env-secrets $ENV --worker issuer --yes
   ```

   `env-secrets` lists what each Worker needs (the API: `RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`,
   `VAULT_KEK` and, during a rotation, `VAULT_KEK_PREVIOUS`, the identity key in the slot `identity-slots.json` names,
   `IDENTITY_SUB_KEY`, `USER_ID_KEY`; the issuer: `ISSUER_SIGNING_KEY` with the active kid, `EMAIL_SUB_KEY`,
   `EMAIL_CODE_KEY`, `EMAIL_RL_KEY`, `SENDGRID_API_KEY`; the console: `CONSOLE_GOOGLE_CLIENT_SECRET`; the admin:
   `EMAIL_API_KEY`, `CANCEL_LINK_KEY`, `INVITE_LINK_KEY`, `WATCHDOG_STATUS_TOKEN`, `COINGECKO_API_KEY`; the watchdog's
   six or more) from `.secrets/<env>/`, checks each file is there, 0600 and well-formed, and with `--yes` sets them
   through wrangler's stdin on the account the generated config names. It refuses while a required one is missing:
   a file that is gone is never re-invented (Cloudflare can't give a secret back). The relayer, updater and
   `VAULT_KEK` can be made anew with their own commands ("Key rotation"); K_sub, `USER_ID_KEY` and `IDENTITY_SUB_KEY`
   only from their offline backups. The offline standbys are never uploaded. Usage capture (when the env has it):
   `usage-setup $ENV hyperdrive --yes` creates both Hyperdrive configs on the new account from the role files, then
   `gen $ENV --usage-hyperdrive-id <writer id>` and the admin's `gen --admin-hyperdrive-id <admin id>`, and redeploy.
   Dashboard envs: `corepack pnpm --filter @hana-id/<console, then console-auth, files, admin> run deploy`, `env-secrets $ENV --worker console --yes` and
   `--worker admin --yes`, the R2 objects copied (an S3-compatible copy such as rclone between the two accounts' R2
   endpoints; `STATEMENTS`' locked objects can't be deleted from the old bucket before their 7 years).
8. **Check the deploy:** `corepack pnpm --filter @hana-id/scripts run deploy-check $ENV --d1` (every Worker on one
   commit, no migration pending: `d1_migrations` came with the export), `curl -s $API/v1/health`,
   `curl -s $ISSUER/v1/email/jwks.json` (the manifest's two kids), `curl -s $API/v1/identity/jwks.json`.
9. **Google Cloud OAuth** (a few minutes to apply): on the shared login client add `{new authOrigin}/login/callback`;
   the same on Hana's own client (`googleClientIds`) where it logs in through Hana's pages; on the console client
   (dashboard envs) replace its one redirect URI with `{new console.authOrigin}/callback`; on the client Cloudflare
   Access signs in with, the new team's `https://<team>.cloudflareaccess.com/cdn-cgi/access/callback`. Keep the old
   URIs until step 13. Client ids don't change, so nothing on chain does.
10. **The watchdog** (its own account, unchanged): `gen $ENV` and deploy it, so its `IDENTITY_ISS` and
    `EMAIL_JWKS_URL` follow the manifest (before that it checks the old URLs, which still answer). If the watchdog's
    account moves too: `d1-move $ENV --db watchdog` and `env-secrets $ENV --worker watchdog --yes` with the watchdog's
    accounts, and `watchdog.url` plus the admin's `WATCHDOG_URL` follow. Acknowledge step 4's alert. On sandbox-dev
    the watchdog's account today is the personal one the other Workers leave (mainnet-readiness 4.5): it may stay
    there, apart from the new main account, until it gets an account of its own.
11. **The demo:** add its new origin to its app (a staff proposal, in force `appChangeDelayMs` after the announcement),
    then deploy it (`HANA_DEMO_ORIGIN=https://demo.id-dev.hanawallet.io` on custom domains):

    ```sh
    corepack pnpm --filter @hana-id/scripts run admin $ENV app:origins:add --app pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie --origin <new demo origin> --remote
    corepack pnpm --filter @hana-id/scripts run admin $ENV app:changes:announce <gc id> --remote
    HANA_DEMO_ORIGIN=<new demo origin> corepack pnpm --filter @hana-id/demo run deploy
    ```

12. **Smoke test:** `apps/smoke` and the demo against the new origins: a Google login and an email login (a code by
    mail), a reload unlock, a signature, an export, `admin $ENV app:list --remote`. The two test users' addresses must
    equal the ones recorded before the move; if one differs, stop: the provider or a key file is wrong (never "fix"
    it by changing a path input).
13. **Retire the old account's Workers** once the new env works: `wrangler delete <name>` for each old Worker
    (`CLOUDFLARE_ACCOUNT_ID=$OLD`), which also takes the old origins down; then remove the old `iss`
    (`admin $ENV issuer:iss email --remove <old iss> --approve-with <member> --yes`; it refuses the manifest's own
    `iss`), the old redirect URIs and the demo's old origin (`app:origins:remove`). Keep the old D1 databases (and the
    bookmarks of step 1) for 30 days, then delete them; delete the `d1-export-*.sql` files once you no longer need
    them, and revoke the API tokens.

### Neon (the usage ledger)

The ledger is a Neon project (`.secrets/<env>/neon.json`: `project_id`, `org_id`). Two ways to put it under the company:

- **Transfer the project** to the company's Neon organization (Neon console, or `POST
  /organizations/{source_org_id}/projects/transfer` with a personal API key that has access to both organizations).
  Neon: "Transferring a project does not change its credentials or connection string", so `neon.json`, the role files
  and the Hyperdrive configs keep working (update `org_id` in `neon.json`). Its rules: Admin in the source
  organization, a project-creating role in the destination; the destination's plan the same tier or higher; integrations
  (GitHub, Vercel) disconnected first; Vercel-managed organizations can't send or receive; billing follows the
  destination. Members and collaborators aren't carried over (re-add them). The page doesn't say what happens to
  project-scoped API keys: create a new one for the next `usage-setup <env> roles` (D403). Source:
  <https://neon.com/docs/manage/orgs-project-transfer> (checked 2026-11-05).
- **A new project** in the company organization: `usage-migrate` and `usage-setup <env> roles`, new role files and
  Hyperdrive configs, and the old rows exported with `pg_dump` / restored if they matter (testnet usage rows usually
  don't).

Prefer the transfer for testnet: nothing in Hana changes.

### Google Cloud (the project that owns the OAuth clients)

OAuth clients belong to a Google Cloud project. A standalone project (created without an organization) can be
migrated into the company's organization; Google says the project ID and number, its API keys and its resources stay
the same (<https://docs.cloud.google.com/resource-manager/docs/project-migration>, checked 2026-11-05; that page
doesn't mention OAuth clients: check the client ids and the consent screen right after the move). Without an
organization, add the company's admins as project Owners in IAM and remove the personal account later. Either way the
client ids, and so the manifest and the chain (`googleClientIds`, `sharedGoogleClientIds`, `consoleAudiences`, the
scopes' clients), don't change. A new project would mean new client ids: new chain registrations, and for partners
who use Hana's shared client a client change that the cross-project `sub` match makes address-neutral (D42); avoid it.

## Restoring a D1 database (Time Travel)

Both D1 databases, the API's `DB` (`cloudflare.d1Name`) and the watchdog's (`watchdog.cloudflare.d1Name`, on the
watchdog's Cloudflare account), are restored with **D1 Time Travel**
(<https://developers.cloudflare.com/d1/reference/time-travel/>; commands:
<https://developers.cloudflare.com/workers/wrangler/commands/d1/#d1-time-travel-info>, checked 2026-10-30). What
Cloudflare guarantees: a restore to any minute of the last 30 days on the Workers Paid plan (7 days on Free); a
timestamp is Unix seconds or RFC 3339 with an offset (UTC); `time-travel` commands always act on the remote
database (no `--remote`); a restore is **destructive and in place** (queries in flight are cancelled and fail) and
prints a bookmark that undoes it; there is no restore into a new database (no fork). Bookmarks older than 30 days are
invalid: past that only an export kept elsewhere helps. Wrangler ≥ 3.4 (the repo pins 4.x). Not rehearsed on
sandbox-dev yet (D152): do that once before relying on it.

### The API's `DB`

From the repo root, with `apps/api/wrangler.jsonc` generated for the env (`gen <env>`) and logged in to the API's
Cloudflare account:

```sh
corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name>                                        # the current bookmark: note it (it undoes everything below)
corepack pnpm --dir apps/api exec wrangler d1 time-travel info <cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>   # the bookmark to restore
corepack pnpm --dir apps/api exec wrangler d1 export <cloudflare.d1Name> --remote --output=../../.secrets/<env>/d1-before-restore-<yyyymmdd>.sql
chmod 600 .secrets/<env>/d1-before-restore-<yyyymmdd>.sql
corepack pnpm --dir apps/api exec wrangler d1 time-travel restore <cloudflare.d1Name> --bookmark=<bookmark>
```

The export keeps the damaged state for the investigation and for re-applying later writes; it holds `vault_shares`
(wrapped under `VAULT_KEK`), so it lives under `.secrets/` (0600) and is deleted with the KEK's retention rules in
mind (`VAULT_KEK` above). Skip it only when the database is gone altogether.

**What is lost**: every write after the restore point. Apps created then (their publishable keys stop working), origin
and settings changes (a pending `raw_sign` / `auto_approve` change scheduled then is gone: the partner asks again),
**suspensions and revocations made then are undone**, session markers, `vault_shares` created then (those users sign
in with Google again; their addresses are on chain and unchanged), and the issuer-key cron's state
(`issuer_key_observations`, `issuer_key_missing`, `issuer_key_proposals`, `issuer_key_sync_runs`). The cron rebuilds
the last from chain: a pending change by the signer account it has no row for is adopted, a missing kid's 24-h
timer starts again (its removal proposal comes up to 24 h later, D422), and D33's lead-time data loses the gap.

**Re-run afterwards**, in this order:

1. `corepack pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --remote`: a point before a
   later migration has the older schema (its `d1_migrations` table comes back with it, so only the missing ones run).
2. Security writes made after the point: `admin <env> app:suspend` for every app suspended since, `app:origins:remove`
   for every origin removed since (and for every origin, policy or raw-signing value still pending in the restored
   rows that was cancelled since: `app:list` shows the pending changes), and, if every share was revoked since (a KEK compromise), the revoke-all command in
   "`VAULT_KEK`" above **before** anything else touches the database. Never leave a restored database un-revoking
   what a security response revoked.
3. A KEK rotated after the point: the restored rows are under the old key id. While `VAULT_KEK_PREVIOUS` still holds
   it they unlock and get re-wrapped; if the rotation already finished (`VAULT_KEK_PREVIOUS` deleted), those rows are
   `unknownKek` (the users sign in again) unless the old key file is still there: `vault-kek <env> put --yes` sets
   both secrets from the files.
4. Other app changes since the point (new apps with `app:create`, which issues new publishable keys the partners
   must use; origins and settings, which are proposals again and wait for their announcement and delay), from what
   partners and the audit trail say (the `app_changes` rows in the export of step 1 list every app write).
5. Check: `admin <env> app:list --remote` against the known apps, `GET /v1/governance` `.updater` (the cron's next
   run), a smoke login and a reload unlock.

### The watchdog's D1

From `apps/watchdog`, logged in to the **watchdog's** Cloudflare account (`gen <env>` first, for its
`wrangler.jsonc`). Until it runs again, watch the issuer-key queue by hand (playbook `watchdog-down`).

```sh
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name>
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel info <watchdog.cloudflare.d1Name> --timestamp=<RFC 3339 time before the loss>
corepack pnpm --dir apps/watchdog exec wrangler d1 time-travel restore <watchdog.cloudflare.d1Name> --bookmark=<bookmark>
```

**What is lost**: runs, alerts (and their acks), deliveries and the actions log after the point; kids first seen
since, and the `last_seen_at` updates (`seen_kids`); absences; the stored chain snapshot, failure counters, heartbeat
and digest state go back to the point. A run lock held at the point is taken over after 10 min (one or two runs skip).
**What the next runs do**: diff the chain against the older snapshot, so every governance change since the point is
alerted again (critical `governance_change`, its own pauses and updater-key deletions included: check them against
`owner:proposals` and the actions you know, then acknowledge); alerts that were open at the point and are no longer
true resolve; conditions still true are raised again (critical ones page until acknowledged); a second digest may go
out.

**The first-run baseline caveat.** A restore to a point **after** the first run keeps `initialized_at`: no first run,
and the pause on a forged active key still works. Before restoring, compare the active kids
(`admin <env> governance:status`) with Google's JWKS today: an active kid that Google published and stopped publishing
entirely **inside the gap** is missing from the restored `seen_kids`, and the next run takes it for never published
and pauses (Google keeps a kid published for weeks, so only a long gap can hit this; the API cron proposes removing a
dropped kid after 24 h, D422). A restore to a point **before** the first run, or no restore at all (past 30 days, a new
database): the next run is a first run. It records Google's current JWKS as known and only **alerts**, never pauses,
on an active kid not in it, so a forged key active at that moment is not paused: check every
`unknown_active_key_first_run` alert by hand (playbook `unknown-active-key-first-run`) and the pending queue
(`GET /v1/governance` `.keyChanges`) before acknowledging.

After either restore: `/status` shows `last_run.outcome: "ok"`, the expected `first_run` and `initialized_at`, and
`heartbeat.ok` within two runs.

## Logs and latency

**Routing from Malaysia (2026-10-29).** `curl <apiUrl>/cdn-cgi/trace` shows which Cloudflare location served a
request: from Malaysia, workers.dev requests land in Marseille (MRS) about 60% of the time, otherwise HKG or SIN,
while D1 (`running_in_region: APAC`) and the Durable Objects are in APAC. The API Worker therefore runs in a fixed region next to D1
(`placement: { region: "aws:ap-east-1" }`, written by `gen`, D97; it replaced Smart Placement, D94, which only moved
requests from locations it had learned and reset after each deploy). Every response's `cf-placement` header shows
where it ran (`remote-HKG`). The trip from the user to the entry location (often FRA or CDG from Malaysia on
workers.dev) is not affected: only different routing (a custom domain, plan) changes that.

```sh
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format pretty
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --format json --search '"endpoint":"/v1/login"'
corepack pnpm --dir apps/api exec wrangler tail <cloudflare.workerName> --status error
```

`observability` is on, so the same lines are in the Cloudflare dashboard. Invocation logs are off on the API Worker
(`observability.logs.invocation_logs: false`, D100): the platform's per-request records carry the URL, and the login
relay's path holds a live `relayId`. The `request` lines below replace them; for status and CPU per request use the
Worker's metrics. Check once after a deploy that no relay URL appears in the Workers Logs view. Each request logs one
`{"event":"request", …}` line with `status`, `code`, `latencyMs`, `colo`, `phases` and, for relays, `relayInstance`
(fields and phases: `docs/api.md`, "Logs"). Reading a slow request:

| Look at | Means |
|---|---|
| `colo` not near the user (e.g. US/EU for Malaysia) | Cloudflare routing (free-plan `workers.dev`); not fixable in code |
| `app`, `limits` large | D1 or limiter objects far away (`durableObjectLocation`); on a vault endpoint `app` is only paid when this isolate hasn't read the app in the last 30 s (D78), and `limits` holds one object call (the app quota; the IP and share limits are local bindings, D95) |
| `checks` large | chain reads (scope, `session_key_in_use`, `get_session`) or a JWKS fetch |
| `relayQueue` | waiting behind other txs of the same key |
| `relayChainRead` with `relayInstance.coldChainRead` | object started without a stored reservation (new or replaced key) |
| `relayChainRead` with `blockRefresh` only | stored block hash older than 5 min |
| `relayPersist` | a new 100-nonce reservation (~3–30 ms) |
| `relayOutcome` | the chain: execution, and on derive the MPC (~4.5 s) |
| `session` large on `/v1/vault/shares` | the RPC node behind `/v1/login`'s optimistic answer: `get_session` re-read every 300 ms (up to 2 s) |
| `settings`, `insert`, `share`, `advance` large | D1 round trips (each is one or two queries) |
| `vault_page` `latencyMs` | the vault page's D1 reads (app, origins, settings) that every page load waits for |
| `GET /v1/app` `settings`, `chain` large | the D1 rows, or `get_scope` (then `get_config` for a shared client); the D1 rows and the registry run side by side since D261 |
| `502 near_unavailable` after about 8 s, on any endpoint (logins included) | a contract view hit the 8 s RPC timeout (every view the API makes, D261): the node stalled. `GET /v1/app` is asked once more by the vault; a login fails and the user retries |

**Stage timings (`pk_test_` apps).** The smoke page's *Timings* table (`apps/smoke/README.md` "Timings") splits a
login and a reload unlock into consecutive stages that add up to the page's total (with `other`), measured where they
happen: the partner page, the vault, the login popup and callback (navigation timing), the relay object
(`relayHeld`) and the API (`timings` on `/v1/login`, `/v1/vault/shares`, `/v1/vault/unlock`, `docs/api.md`
"Timings"). For a request, `<name>Rtt − <name>Server` is what the API never sees: the network, a CORS preflight and
Cloudflare's routing to the Worker; set the `colo` of the same request's log line next to it. *Copy results as JSON*
exports them (results version 3). `pk_live_` apps never get timings; production latency comes from the log lines
above.

Measured on sandbox-dev (2026-10-27, real MPC, `docs/context.md` "Testnet measurements"):

| Call | Gas | Cost | Latency (median) |
|---|---|---|---|
| `create_session` | 19.98–20.15 Tgas | 0.0020 NEAR | 2.5 s after the latency work (was 4.3 s) |
| `derive_key` | 19.61–19.88 Tgas | 0.0019 NEAR | 6.4 s (6.0–6.7) after (was 7.1 s) |
| login (create + derive) | ~40 Tgas | ~$0.021 | ~8.9 s |
| `revoke_session` | 2.68 Tgas | 0.00025 NEAR | |
| rejected derive on chain | 2.21 Tgas | 0.0002 NEAR | |

Warm stage split: create = checks 0.2 s + relay 2.2 s (chain ~0.6 s); derive = relay ~6.0 s (MPC ~4.5 s).
`create_session_and_derive` (`/v1/login`): its latency on testnet is D76 (the ship gate); its gas is measured in the
sandbox with the mock MPC, not yet on testnet: ≈ 20.5 Tgas in the signer's receipt and 22–23 Tgas in all with a
Google token (`docs/contract-interface.md` "Gas of the email login calls" and "Upgrades"; 100 Tgas attached).

## Common failures

| Symptom | Cause | Fix |
|---|---|---|
| Google `Error 400: redirect_uri_mismatch` in the login popup | `{authOrigin}/login/callback` isn't an Authorized redirect URI of the client in use (shared, or the partner's own) | add it exactly in Google Cloud; wait a few minutes |
| Smoke's Google button: origin not allowed for the client | `http://localhost:5173` missing from Authorized JavaScript origins | add it on every client smoke uses |
| `409 counter_used` (with `nextCounter`) | a replayed or reused session counter; refused before the chain, no gas | send `nextCounter`; for a replay it is the expected answer |
| `400 bad_request` "signature must be the session key's 64-byte proof of possession" on `/v1/sessions` | a caller from before email login batch 6 (an old vault bundle, an old smoke page) sends no proof (D137) | rebuild and redeploy the page Workers (`web build`, `deploy:pages`); restart `apps/smoke` |
| `403 login_method_disabled` | an email token for an app whose `login_methods` doesn't list `email` (every app until batch 8) | expected; batch 8 turns email on per app |
| `409 links_unavailable` | a link on a contract before v3, or before the owner's `accept_unrecorded_wallets` (D135) | on sandbox-dev, "Email login on sandbox-dev" step 7; never on mainnet |
| `409 session_exhausted` / `counter_out_of_range` | `max_uses` reached / counter past it | open a new session |
| `409 session_exists` | session key already holds a session (replay, or a retry that landed) | new session key |
| First relay after a quiet spell is slower; `relayInstance.cold: true` | the key's object was evicted (~10 s idle) | expected; costs no chain read while a reservation is stored. A repeated `coldChainRead: true` means the key has no stored reservation (new key, or a `RELAYER_KEYS` reorder) |
| `relay_retry` `invalid_nonce` warnings | a pool key was used outside its object, or was deleted and re-added on chain (new nonce) | one per re-added key is expected; otherwise don't use pool keys elsewhere |
| `503 relayer_unconfigured` | `RELAYER_KEYS` (or `OWNER_RELAYER_KEYS` for owner actions) not set | `wrangler secret put` |
| `422 contract_rejected` on every login after a deploy | contract has no Google keys, or keys out of date | `post-google-keys <env>`; check `KEYS_UPDATER_KEY` |
| `503 issuer_key_pending` on logins (with `retry-after: 30`) | the token's kid is in Google's JWKS but still in its issuer-key delay on chain (a rotation), or the contract has no Google issuer | expected for minutes after a rotation; check `/v1/governance` `keyChanges` (a pending Add with `jwks: match`): the watchdog confirms it, or it goes live at `executableAtMs` and the next cron run. No pending change for the kid: check the cron (`updater.lastRuns`) and `KEYS_UPDATER_KEY` |
| `503 paused` on logins and derives | the contract is paused (owner or a watchdog) | see "Pause"; only the owner multisig unpauses |
| cron logs `jwks_sync_skipped` | no `KEYS_UPDATER_KEY` | upload it |
| cron logs `jwks_sync_failed` `key_changes_unavailable` | `get_key_changes` failed or is malformed, or the contract is still v1 | v1: sync by hand (`post-google-keys`); v2: check the RPC |
| cron logs `issuer_key_change_cancelled` (error) | a change the cron proposed was cancelled on chain (the watchdog's alert says why) | if the watchdog cancelled, it also deleted the updater key: see "Keys-updater key". The cron holds that kid for 1 h |
| cron logs `jwks_sync_note` `unpublished_change` / `pending_mismatch` (error) | a pending Add for a kid Google doesn't publish, or with other key material | the cron won't execute it; the watchdog cancels it (critical alert). If no watchdog: the owner cancels it now (`cancel_issuer_key_change`) |
| cron logs `jwks_sync_note` `removal_of_published_kid` | a pending Remove of a kid Google still publishes | the owner decides and cancels (the watchdog alerts, D82) |
| cron logs `jwks_sync_note` `last_key_kept` / `queue_full` / `issuer_full` | removing the issuer's last key, or the contract's caps (6 pending, 10 per issuer) | `last_key_kept` clears once the new key is active; caps clear as changes execute or are cancelled |
| cron logs `jwks_tx` `send_failed` for `execute_issuer_key_change` / `propose_issuer_key_removal` | the updater key lacks the v2 methods (still the v1 key), was deleted, or its allowance is spent | "Keys-updater key" |
| `key_observation_failed` warnings (`code` `jwks` / `token`) | a lead-time write to D1 failed (logins unaffected), often `issuer_key_observations` missing | apply migration 0004 (`migrations apply … --remote`) |
| `503 vault_key_unavailable` | no `VAULT_KEK` (or the row's old key missing in `VAULT_KEK_PREVIOUS`) | set it |
| `GET /vault` 503, log code `misconfigured` | `API_URL` missing: a `wrangler.jsonc` generated before `apiUrl` reached `gen` | `gen <env>` and redeploy |
| `admin app:settings`: "The app's settings changed since they were read" | another `app:settings` or a D1 edit changed the app between the command's read and its write; nothing was written | run it again (it shows and plans from the current row) |
| `vault-kek init`: "already exists: refusing to overwrite a key" | `.secrets/<env>/vault-kek` exists | `vault-kek <env> put --yes` to set it again, or `rotate` to replace it |
| `410 share_revoked` / `share_expired` on every reload after a settings change | `persistence` set to `none` (shares revoked), or `session_ttl_ms` lowered below the shares' age | expected: users log in again |
| `403 origin_not_allowed` from a loopback origin | `pk_live_` key or a non-dev env name; or no `x-hana-parent-origin` from a Hana page | use `pk_test_` in `sandbox*`/`local*`; list the origin |
| `403 scope_conflict` | a `pk_test_` app shares its scope with a `pk_live_` app | separate scopes |
| 4100 `raw_not_allowed_for_test_apps` / `mainnet_not_allowed` from the vault | a `pk_test_` app asked for a raw signature (whatever `raw_sign` says), or for a mainnet Stellar passphrase or an EVM chain outside the testnet allowlist (D39) | expected for test apps; use a test network |
| `429 rate_limited` "(per IP per minute)" or "(share per minute)" on `/v1/vault/*` with `retry-after: 60` | the vault's per-location flood limits (60/min per IP per app, 10/min per share; D95), counted per Cloudflare location and approximate | wait; not visible in the dashboard, so count the 429s in the request logs |
| `429 rate_limited` "Too many key exports" on `/v1/login` from the export window | more than 3 exports in an hour for one user path in one app (D59) | wait for `retry-after` |
| `derive_failed` with `data.reason` `webcrypto_unsupported` / `webcrypto_failed` at the start of a login, a link or an export sign-in (the popup closes at once) | the browser couldn't make the Ed25519 session key: no Ed25519 in WebCrypto (Chrome and Edge before 137, Firefox before 129, Safari before 17), or it refused (`data.error`; WebKit Linux's `OperationError` four times in a row is about 4 in 10^9, D381). No `/v1/login` was sent (D385) | `webcrypto_unsupported`: the user updates the browser or uses another; `webcrypto_failed`: try again, report it with the browser and `data.error` if it repeats |
| `vault_unavailable` on a partner page (`data.reason`) | `csp_frame_src`: the page's CSP; `no_answer` (after one retry, about 3 s; `data.origin` is the page's origin: compare it with the app's origins in force, D427): the vault page refused the frame (origin not in force, key unknown or suspended, wrong env build) or its script didn't run; `frame_timeout` / `ready_timeout`: network or cold Workers, often right after a deploy (D262) | fix the origin or CSP; for timeouts, reload, and check the `vault_page` and `/v1/vault/unlock` latencies in the request log |
| A login's `app` stage takes seconds (`pk_test_` timings) | the `GET /v1/app` the vault asked after `ready` was still out: `appServer*` say whether the API (D1, the registry views) or the network took the time (D261) | look at the `/v1/app` request log line's `phases` and `colo`; a stalled RPC view now fails after 8 s (every view, logins included) and `/v1/app` is asked once more |
| `409 no_google_client` on `/v1/app` | scope has no Google client and no usable shared client (or shared client still in its timelock) | add a client, or `--allow-shared` + wait `changeDelayMs` |
| `admin`: "No wrangler config in apps/api" | `wrangler.jsonc` missing | `corepack pnpm --filter @hana-id/api run gen <env>` |
| `admin user:*`: "No wrangler config in apps/email-issuer" | the issuer's `wrangler.jsonc` missing (local D1 only) | `corepack pnpm --filter @hana-id/email-issuer gen <env> --d1-id <issuer uuid> --app-d1-id <the API's D1 uuid>` |
| `admin user:* --remote`: "No Cloudflare credentials" | not logged in to wrangler, and no `CLOUDFLARE_API_TOKEN` | `corepack pnpm --dir apps/email-issuer exec wrangler login` |
| `admin user:* --remote`: "These Cloudflare credentials reach N accounts" | the login reaches several Cloudflare accounts | `CLOUDFLARE_ACCOUNT_ID=<the issuer's account id>` before the command |
| `admin user:* --remote`: "Cloudflare … failed (HTTP 401/403)" | the token lacks D1 access on that account | `wrangler whoami`; a token with D1 read on the issuer's account |
| `admin user:* --remote`: "No D1 database named …" | another account, or the issuer's D1 not created | check `CLOUDFLARE_ACCOUNT_ID` and `wrangler d1 list` |
| `admin user:*`: "D1 error: no such table: user_emails" | migration 0002 not applied | "Applying migration 0002" in "User directory (D269)" |
| `deploy-contract` "Cannot deploy until these are fixed" | a key with the wrong receiver, methods, empty method list or too-large/unlimited allowance | run the printed `near account delete-keys …`, re-run |
| A test fails after someone filled in `envs/sandbox-dev.json` | the test read the real manifest and expected `UNSET` placeholders | tests pin their own fixture manifest (see `scripts/test/deploy-plan.test.ts`, commit fdde123); never depend on live manifest values |
| smoke refuses to derive: "UNSET placeholder" | `ckdNetworkKey` not pinned | `fetch-ckd-key <env>`, restart the dev server |
| `build:lib` / `pack:check`: "Can't build the @hana-id/web package" | an env with both origins is a `local*` env, or none has both origins | keep loopback envs out of `envs/` (apps/e2e builds its own); set the origins |
| `build:lib` / `pack:check` / page build: "… is still an UNSET placeholder" | an included env (both origins set) has an `UNSET` value | fill it in, or leave the env's origins out until it is deployed |
| `pack:check`: "npm install … failed" | the registry is unreachable, or a pinned peer is younger than 7 days (`--before`) | retry; check the network or the pin |

## Before each release: the COOP canary

The vault notices a closed login popup by reading its handle on the popup's window (`.closed`) every 250 ms (D347).
That holds only while no page of the popup's trip *enforces* Cross-Origin-Opener-Policy: an enforcing page moves the
popup to another browsing context group, and the handle then reads `closed: true` while the window is still open.
Google sends COOP report-only on its authorization endpoint, identifier page and account chooser, and enforces
`same-origin` only on its OAuth error page (2026-11-05). Google can change that without notice, so before each
release (a pages deploy, an SDK release, `develop` into `main`) run the canary against the env being released (D386;
it replaced D347's `curl -sI`). It is a manual check on purpose: no workflow runs it (Actions minutes, D383).

```sh
corepack pnpm --filter @hana-id/scripts run coop-canary <env>                  # about 1.5 min, exit 0 = pass
corepack pnpm --filter @hana-id/scripts run coop-canary <env> --headers-only   # no browsers, about 10 s
# the browsers, once per machine (apps/e2e's Playwright):
corepack pnpm --filter @hana-id/e2e exec playwright install chromium firefox webkit
```

What it checks, signed out, on exactly the requests the product sends (the builders in
`packages/web/src/auth/google.ts`, with the env's first `sharedGoogleClientIds` entry and `authOrigin` +
`/login/callback`): token_first's first request, D273's interactive retry (with a `login_hint`) and the silent
ID-token request (`prompt=none`, which ends on Hana's callback).

- **Header check.** Each request followed by hand (manual redirects, cookies carried between hops but never
  printed) under six browser User-Agents. It prints each hop's status, host and path (never the query) and its
  `COOP`, `COOP-RO` and `CORP` (and `COEP` when present). A finding: any hop other than Google's
  `/signin/oauth/error` with an enforcing `Cross-Origin-Opener-Policy` other than `unsafe-none`, or an enforcing
  `Cross-Origin-Embedder-Policy`; a chain that ends on Google's error page, on a non-200, or not where it should
  (Google's sign-in page; Hana's callback for the silent request). Report-only headers are fine.
- **Browser check** (Chromium, Firefox, WebKit; headless). A localhost opener page `window.open`s the first request
  and reads `.closed` every 250 ms for 10 s. A finding: `true` while the popup is open. Then it closes the popup and
  expects `true`.
- **Positive controls.** The first request with a redirect URI no client registers (`https://coop-canary.invalid`)
  lands on Google's error page, which enforces COOP: the header check must read it there, and `.closed` must flip
  (about 0.5 s after it loads) in each browser.

Exit codes: **0** pass; **1** a finding; **2** inconclusive (no network, a browser missing, or a control that didn't
flip). Only 0 is a pass. What a failure means and what to do:

| Output | Meaning | Do |
|---|---|---|
| `FINDING: <google host/path> enforces Cross-Origin-Opener-Policy: …` (or the browser check's `popup.closed read true … while the popup was open`) | Google now enforces COOP on a sign-in page. D347's guard (a close within 8 s of leaving for Google is taken for a COOP switch, and the watch stops) covers it on Google's first page; on a later page (password, second factor, consent) logins are cancelled with `login_cancelled` `popup_closed` while the user is still at Google | Don't release. Follow the `google-enforces-coop` playbook ([docs/playbooks.md](playbooks.md#google-enforces-coop)): confirm, hold the release, change the watch with a decision entry |
| `FINDING: <authOrigin host>/… enforces …` | A Hana page sends COOP or COEP: a regression (the auth pages send none, `docs/api.md`) | Revert it before the release |
| `FINDING: Google answered with its OAuth error page …` | Google refuses the request itself (client id, redirect URI): Google sign-in is broken whatever COOP says | Check the shared client in "Google Cloud OAuth" against `envs/<env>.json` |
| `CANARY BROKEN: the control did not flip …` or `… no longer enforces COOP` | The canary can't show it would see an enforcing page (Google changed its error page) | Not a pass. Fix the canary's positive control (a new page that enforces COOP) before trusting it |
| `COULD NOT CHECK: …` / `INCONCLUSIVE` | Network, a browser missing, Playwright not installed | Fix it (the install line above) and run again |

The canary holds no secret (a client id is public) and prints no cookie, query value or fragment. It never signs in
(no script may hold a Google account's cookies), so it doesn't see the pages a signed-in user meets (the account
chooser with accounts, the password, consent); Google has sent the same report-only policy across its sign-in pages
so far.

## Releasing the SDK packages

`@hana-id/core`, `@hana-id/web`, `@hana-id/react` and `@hana-id/sodax` are built for installation outside this
repository (D71) but **not published**: they are still `"private": true`, and the registry and licence are open
decisions (below). Until then a partner gets tarballs.

**How the build works.** Each package's `build:lib` runs `tsc -p tsconfig.build.json` through `scripts/sdk-build.ts`:
ESM, `.d.ts` and source maps with inlined sources, into `dist/` (`@hana-id/web`: `dist/lib/`, since `dist/pages/` is
the Hana pages build and is never packed). Inside the workspace, `exports` still point at `src/` (tests, the API, the
pages and the apps import sources); `pnpm pack` replaces them with `publishConfig.exports` (dist), rewrites
`workspace:^` to `^<version>`, and runs `prepack` (= `build:lib`) first, so a tarball is always freshly built. Only
`dist`, `package.json` and `README.md` are packed (`files`). `@hana-id/web`'s `build:lib` first runs
`gen-envs.ts --package`: the client knows every `envs/*.json` that sets both `vaultOrigin` and `authOrigin`, and the
build fails if one of them has an `UNSET` value, if one is a `local*` env, or if there is none. Build a package's
dependencies first (`corepack pnpm --filter @hana-id/react... run build:lib`): its build reads their `.d.ts`.

**The check.** `corepack pnpm run pack:check` (also the CI job `packages`) packs the four into a temp dir, checks
each tarball (only dist JS / `.d.ts` / maps plus `package.json` and `README.md`; no tests, fixtures, sources,
`.secrets`, env files, raw `envs/*.json` or page bundles; relative, inlined map sources; no local absolute path in any
file; packed `exports`, version and `@hana-id/*` ranges), installs them with plain npm into a fresh project in the
system temp dir with the peer versions this repo tests, type-checks `scripts/pack-smoke/` there (NodeNext and Bundler
resolution, `skipLibCheck` off) and runs `scripts/pack-smoke/run.mjs` in Node. `--keep` leaves the temp dir.

**Tarballs for a partner (today).**

```sh
corepack pnpm run pack:check                         # must pass
mkdir -p /tmp/hana-sdk && for p in core web react sodax; do
  (cd packages/$p && corepack pnpm pack --pack-destination /tmp/hana-sdk)
done                                                  # hana-id-{core,web,react,sodax}-<version>.tgz
```

Send the four files with their SHA-256 (`shasum -a 256 /tmp/hana-sdk/*.tgz`) and the release commit.

**A release.**

0. Run the COOP canary ([Before each release](#before-each-release-the-coop-canary)) against each env whose pages
   the release ships: it must exit 0.
1. On a branch from `develop`: `corepack pnpm --filter @hana-id/scripts sdk-version <x.y.z>` (one version for all
   four: each `package.json` and `VERSION` constant; D72). Say what changed for partners in the PR. Merge to
   `develop`, then `develop` into `main`.
2. Tag the release commit on `main` as `sdk-v<x.y.z>` and push the tag.
3. Tarballs: as above, from the tag. Publishing (once enabled): Actions → "Publish SDK packages" → run on `main`
   with the version, a dist-tag (`next` until a release should be the default install) and **dry run** first; check
   the listing, then run again without dry run.

**Publishing: what is left to enable it** (`.github/workflows/publish-sdk.yml`, manual dispatch only; its `gate` job
skips everything while the `NPM_TOKEN` secret is missing, and npm refuses `"private": true` packages):

- **Registry** (decision): public npm under an `@hana-id` org (anyone can install), or private (a paid npm org with
  restricted access, or GitHub Packages). Then add to each package's `publishConfig` (which today holds only the
  dist `exports`, `main` and `types`): `"access": "public"` (or `"restricted"`), and `"registry": "<url>"` if not
  npmjs.org; set `NPM_ACCESS` and `registry-url` in the workflow to match.
- **Licence** (decision): `license` is `UNLICENSED` (no rights granted) in all four. Set the SPDX id (and add a
  `LICENSE` file to each package's `files`) before a public release.
- **Provenance**: the workflow publishes with `--provenance` (`id-token: write`). npm accepts provenance only from a
  public source repository; while `Hana-Technology/hana-id` is private, publish from a public mirror, or drop
  `--provenance` for a private registry. npm trusted publishing (OIDC, no token) is the alternative to a token once
  the repository is public.
- **Token**: a granular npm token that can only publish the `@hana-id` packages, as the repository secret
  `NPM_TOKEN`, ideally in a protected GitHub environment with required reviewers.
- Remove `"private": true` from the four `package.json` files (`@hana-id/env`, `@hana-id/scripts` and the apps stay
  private).

## CI and git

- Branches: feature branch → PR into `develop` (an org ruleset needs one approving review; the user merges);
  `main` = releases. Remote `Hana-Technology/hana-id` (private).
- CI (`.github/workflows/ci.yml`, on PRs and pushes to `develop` / `main`): gitleaks over the full history;
  `cargo test --locked` + `cargo near build non-reproducible-wasm`; `pnpm install --frozen-lockfile`, `pnpm -r
  typecheck`, `pnpm -r test` (this includes `@hana-id/react`'s suite on React 18, `packages/react/react18`); the
  Playwright suite (`apps/e2e`, three browsers); sandbox e2e (`contracts/integration-tests`); the SDK pack check
  (`pnpm run pack:check`, [Releasing the SDK packages](#releasing-the-sdk-packages)).
- **CI is turned off** (D387, 2026-11-05): the CI and `identity-probe` workflows are disabled in GitHub (Actions
  minutes; testnet only). `pnpm verify` runs CI's checks locally instead (next bullets). Turn back on with
  `gh workflow enable CI -R Hana-Technology/hana-id` (and `identity-probe.yml`); both must be on, or replaced, before
  mainnet (`docs/mainnet-readiness.md` 4.20, 5.10). The bullets after the pre-push hook are how CI behaves when
  enabled.
- **The local gate: `pnpm verify`** (D413, `scripts/verify.mjs`), from the root of the checkout being checked:

  | Command | Runs | When |
  |---|---|---|
  | `pnpm verify --quick` | `pnpm install --frozen-lockfile` (a lockfile out of step fails, as in CI); gitleaks over the history, and over the uncommitted changes when there are any, plus the rule self-test; typecheck and unit tests of the affected packages; the docs checks (`@hana-id/playbooks`: `docs/playbooks.md` generated and the commands and decisions the playbooks cite; `examples/identity-verify` and `@hana-id/core`'s `integration-doc` test: `docs/integration.md`) | while working; the pre-push hook |
  | `pnpm verify` | `--quick`, plus what a `develop` push ran in CI, by CI's rules (`scripts/ci-changes.mjs`, the table below): the contract (`cargo test --locked`, `cargo near build non-reproducible-wasm`) and the sandbox e2e when Rust changed; `pnpm run pack:check` and Playwright on Chromium when web code changed | **before every merge into `develop`** |
  | `pnpm verify --full` | every package and every job whatever changed; Playwright on Chromium, Firefox and WebKit | **before every deploy**, and before a release |

  - The change: from `merge-base(origin/develop, HEAD)` to the working tree, untracked files included (`--base
    <ref>` for another base, `--all` to ignore the diff). Run `git fetch` first; a stale `origin/develop` only widens
    the diff. A change to `ci.yml`, `scripts/ci-changes.mjs` or the verify files runs everything.
  - Affected packages: a package's change runs it, the packages that depend on it or whose code names a path in it,
    transitively, and the packages whose tests or test configs name a path in those (the admin's vitest config
    bundles the API, console and issuer Workers); a doc outside the packages (`docs/`, root Markdown) runs only the
    suites that name it; any other file outside the packages (`contracts/`, `envs/`, the lockfile, root config) runs
    every package, since the tests read such files. The workspace is densely linked (nearly every package depends on
    `@hana-id/env` or `@hana-id/core`, and `scripts` reads most apps), so most code changes still run every package;
    docs-only changes and leaf packages (`examples/*`) run a few. `pnpm verify --plan` prints the selection and the
    commands without running them.
  - Order (D423, amended 2026-11-06): five phases, cheapest first; a phase's lanes run side by side, a lane's steps
    one after another: (0) the lockfile; (1) gitleaks, the typecheck and the contract; (2) the unit tests and the docs
    checks; (3) the sandbox e2e beside the SDK pack check; (4) Playwright alone (beside 8 sandbox nodes, Firefox's
    timing-sensitive linking spec timed out at 13 s that passes in 4–5 s alone; the pack check runs before it, as both
    build `@hana-id/web`). The run stops at the first failure: running steps are stopped,
    nothing else starts, the failing log's last 60 lines are printed; every step's log is in the system temp dir. The
    summary table gives each step's start (from the run's start) and duration, the wall-clock total and the steps'
    durations added up. `--plan` prints the phases and lanes. The unit tests run 4 packages at a time (pnpm's default,
    as in CI) with `CI=true` (vitest then fails a stray `.only`), and never beside another heavy step: the PGlite
    suites start a WASM Postgres per test file (D140) and, like the workerd suites, time out on a loaded machine (the
    contract, which builds from cold on every core, runs beside the typecheck instead). A test that times out while
    the machine is busy is the machine: rerun when it's idle and say so. Playwright runs with `--forbid-only`; set
    `HANA_E2E_PORT_BASE` when another worktree's stack is up. The sandbox nodes take ephemeral ports from the OS
    (near-sandbox reserves each with a lock file in the temp dir), never the stack's `HANA_E2E_PORT_BASE` … +50.
  - The sandbox e2e runs 8 tests at a time (`cargo test --locked -- --test-threads=8`, `SANDBOX_TEST_THREADS` in
    `scripts/verify.mjs`; CI's job the same), each test on its own sandbox node (about 400 MB each), the three test
    binaries one after another. Each test owns its node, accounts and temp home dir; the wasm builds are shared per
    binary (`OnceLock`), the near-sandbox binary is installed by its build script, and
    `contracts/integration-tests/.cargo/config.toml` sets `NEAR_ENABLE_SANDBOX_LOG` so no sandbox start calls
    `set_var` while other tests run (`sandbox_starts_set_no_env_vars` checks it). A sandbox test that takes minutes
    holds the whole run up: split it (the `access_keys_*` tests were one 9-minute test).
  - Needs, for the tiers that use them: gitleaks (every tier), cargo-near 0.22.0 and Rust 1.85.1 with
    `wasm32-unknown-unknown` (the contract and sandbox e2e), Playwright's browsers (`pnpm --filter @hana-id/e2e
    e2e:install`), the npm registry (the pack check). macOS WebKit is not Linux WebKit: D381's bug would pass here.
  - Timings on the dev Mac (16 cores, idle, warm caches), every package and job selected (as for a change to the
    verify files): `--quick` about 1 min (55–70 s: typecheck 12 s, unit tests 43–50 s, gitleaks and the docs checks a
    few seconds); `--full` about 6 min (5m53s and 6m18s on 2026-11-06, D423; 21–22 min before it): phases 0–2 about
    1 min, then the sandbox e2e 5 min (4m59s–5m05s; 18–19 min one test at a time) beside the pack check (10 s) then
    Playwright on all three browsers (1m43s). The default tier with a Rust change is bound by the sandbox e2e the
    same way (about 6 min); without one it is about 2 min (Playwright on Chromium 32 s). The contract takes a few
    seconds once built (about 2.5 min for `cargo test` and 1.5 min for the wasm from cold, beside the typecheck). On
    a machine under heavy load `--quick` took 4 min, and workerd tests timed out.
- **Before a merge into `develop`, and before a deploy** (D413; merges are done locally by the assistant while CI is
  off): run `pnpm verify` on the merged result before pushing `develop` (in the `develop` checkout after the local
  merge, or on the feature branch after merging current `origin/develop` into it), and `pnpm verify --full` on the
  commit to be deployed before any deploy. Nothing merges or deploys on a failure: fix it on the branch and run again.
  Report the summary table with the merge or deploy.
- **Pre-push hook (optional, D413).** `pnpm verify:install-hook` turns on `.githooks/pre-push` for the clone and all
  its worktrees (`git config hana.verifyPrePush true`; `--status`, `--uninstall`). A push to `develop` or `main`
  then runs `pnpm verify --quick` first (develop: measured from the remote tip it replaces; `main`, or a tip this
  clone doesn't have: every package) and a failure stops the push. Feature branches and tags push as before. It
  checks the working tree, so it stops a push whose commit isn't the checked-out HEAD, or whose tree has uncommitted
  or untracked changes. It is installed like the pre-commit hook (`pnpm install` sets `core.hooksPath=.githooks`)
  and has no skip switch of its own. It runs the `--quick` tier only: the default tier before a merge stays the rule.
- What runs when (D383). GitHub bills each job by the minute, rounded up, from minutes shared by every org repo, so
  CI runs only the jobs a change can affect. The `changes` job (`scripts/ci-changes.mjs`) diffs the change and sets
  the outputs the other jobs read:

  | Job | Runs when |
  |---|---|
  | gitleaks, TypeScript (typecheck + tests) | every PR and push (the tests read `docs/` and `contracts/`) |
  | Contract (cargo test + wasm), sandbox e2e | something changed under `contracts/`, or in a file the Rust tests read outside it (`scripts/lib/contract.ts`, `apps/api/src/gas.ts`, `apps/api/src/relayer-config.ts`) |
  | Playwright, SDK pack check | something changed outside `docs/`, `contracts/` and Markdown (a package README counts: it ships in the tarball) |
  | everything | a change to `ci.yml` or `scripts/ci-changes.mjs`; a push to `main`; a manual run (Actions → CI → Run workflow) |

  A push is measured from the head of the last successful push run on its branch, so the changes of a run that was
  cancelled (a newer push cancels it) or failed count again on the next push. A PR is measured from where it branched.
  No usable base (none yet, or a force push) runs everything. The Playwright suite runs Chromium on PRs and `develop`
  pushes; WebKit and Firefox run nightly (03:41 UTC) on `develop` when web code changed since the last good nightly
  run, and all three on `main` and manual runs. A WebKit- or Firefox-only regression is therefore caught within a day
  rather than on its push (D381's WebKit failure is the kind it would delay). Before a release, run CI manually on
  `develop` for the full suite. A new file the Rust tests read outside `contracts/` must be added to
  `RUST_EXTERNAL_INPUTS` in `scripts/ci-changes.mjs`; `scripts/test/ci-changes.test.ts` fails if a repo-root path read
  by the Rust tests is missing.
- The pre-commit hook runs `gitleaks git --staged` with `.gitleaks.toml`. Never bypass it (`--no-verify`). Scan
  locally with `corepack pnpm secrets:scan` (`pnpm verify` runs the same scan and the rule self-test).
- `.gitleaks.toml` adds rules for this repo's own secrets, which gitleaks' defaults miss (security sweep OPER-2):
  NEAR ed25519 secret keys (`ed25519:` + 87-88 base58 characters; public keys are too short to match),
  `VAULT_KEK` values (`<id>:<base64 of 32 bytes>`), Worker-secret lines as in `.dev.vars` (`RELAYER_KEYS=…`,
  `KEYS_UPDATER_KEY=…`, `VAULT_KEK=…`, the watchdog's), and the secret files by name wherever they are (anything
  under `.secrets/`, the council key files included, `.dev.vars`, `relayer-keys.json`, `owner-relayer-keys.json`,
  `keys-updater.json`, `watchdog-secrets.json`, `vault-kek*`). `scripts/secret-scan-selftest.mjs` generates a fake of
  each at run time (never committed) and checks the rules catch it and pass the public look-alikes (public keys,
  placeholders, `pk_test_`, BLS keys); `scripts/test/secret-scan.test.ts` runs it in `pnpm -r test` when gitleaks is
  installed, and the CI `secrets` job runs it with the pinned binary after the history scan. Adding a secret shape
  means a rule here and a case in the self-test.
- Never commit `.secrets/`, `.env*`, `.dev.vars` or the generated `apps/api/wrangler.jsonc`, `wrangler.vault.jsonc`,
  `wrangler.auth.jsonc`, `wrangler.vitest.jsonc` and `apps/demo/wrangler.jsonc` (all gitignored and untracked;
  `wrangler.jsonc` holds an env's D1 id, the page and demo configs their origins and Worker names). Edit the
  manifest or `gen-wrangler.ts`, never the files. CI needs none of them: the API tests generate
  `wrangler.vitest.jsonc` from a fixed test manifest (`TEST_MANIFEST` in `gen-wrangler.ts`) on every run.
- `legacy/` is read-only reference code.
