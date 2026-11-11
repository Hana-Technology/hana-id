# API reference — every endpoint the `apps/api` Worker serves today (and the email issuer's, the console's and the admin's)

Last verified against code: 2026-11-11 (branch `feat/near-directory`, after its security review: `409 near_account_mismatch`, `nearCode`, the unique index, `nearAccountUser` never picks, D762, D763); 2026-11-11 (branch `feat/near-directory`, not merged, not deployed: `GET /v1/app`'s `walletChains`, `POST /v1/login`'s `exportChain` `"near"` and its event's fallback, `POST /v1/wallets/record`'s NEAR record (the v2 proofs hash, the `near` answer), migration 0019 in "D1 schema", the `near` log phase, `ConsoleRpc`/`AdminRpc` search by a NEAR account, D755–D759); 2026-11-11 (branch `fix/console-email-login-flow`, not merged, not deployed: `POST /api/orgs/:org/actions` `returnTo` and `GET /api/actions/:id` `returnTo`, D711; the Email login and scope reads answer `now`, D713; after review: a bad `returnTo` app of another org is `404`); 2026-11-11 (branch `fix/console-getting-started`, not merged, not deployed: `getApp`'s change status in force and `listApps`' `pendingChanges`, D701; the console's `GET /api/me` `envName`, D703; `USERS_SCREEN` from the manifest, D702; after review: the console app read's `now`, the latest `policy_set`); 2026-11-11 (branch `feat/admin-pending-invites`, not merged, not deployed: `StaffRpc.newOrgInvites`, the admin's `GET /api/invites/new-orgs`, the invite view's `newOrgKind`, D696; `issueInvite`'s `passkeys_required` off testnet only, D698); 2026-11-10 (branch `feat/signout-reach`, not merged, not deployed: `POST /v1/vault/share-status`, its two Rate Limiting bindings and rows, `GET /v1/app`'s `share` as a policy app's check and the fallback, the D1 cost, D680–D684, D690–D693; after the re-review: the per-IP key across apps asked first, no parent check, the timeout, the sticky fallback); 2026-11-10 (branch `feat/hana-home-h9`, not merged, not deployed: "Routing", "Rate limits", "Hana Home": `GET /v1/home/devices` and the three stops, whose rows, the member check and `canStop`, the counts (D606–D610, D661, D663–D665); `GET /v1/app`'s `share` and `x-hana-share` (D662); the vault's `deviceLabel` (D611)); 2026-11-10 (branch `feat/hana-home-h10`, not merged, not deployed: the email issuer's `POST /v1/email/home/start` and Home's `verify` answer, `GET /v1/home/config`'s `emailSignIn`, the `/home/callback` page row and policy, `/home`'s policy with the email issuer, the page's email sign-in and exit-client sign-in, D616–D627; after its security review, D628, D629, D666–D669); 2026-11-10 (branch `feat/partner-onboarding`, not merged, not deployed: the admin's `GET /api/me` `scopeRegistration` and its `SCOPE_REGISTRATION` var, D651); 2026-11-10 (branch `fix/testing-1110`, not merged, not deployed: the admin's alert view: `deliveriesLatest`, D570); 2026-11-10 (branch `feat/hana-home-h11`, not merged, not deployed: "Usage capture": the `home_login` event and who pays for it; `usage.org_report`'s `kind` and `home_logins`; `relayerKeys` with the Home pool; settlement's pool check; the statement's Home line; D585–D594; after the independent review: `relayerKeys`' `capture` and `unreadablePools`; `usage.org_ledger` for partners and `org_ledger_full` for staff; `GET /v1/health`'s `usageCapture`; the statement CSV's two columns appended last; D595–D599; D585–D599 confirmed by the user 2026-11-10, D605); 2026-11-10 (branch `feat/hana-home-h3`, not merged, not deployed: `POST /v1/home/login`: `404 home_no_wallet`, `503 home_directory_unavailable`, D544); 2026-11-10 (branch `feat/hana-home-h8`, not merged, not deployed: `/home`'s policy with the NEAR RPC origins, the page's one `POST /v1/home/login` per per-app sign-in, D575, D581, D583); 2026-11-10 (branch `feat/hana-home-h7`, not merged, not deployed: the `/home` page row and its policy, which Home routes the page calls, `/home`'s COOP header, D550, D551, D558); 2026-11-10 (branch `docs/tidy-deployed-1110`: the deploy notes of Hana Home, the RPC entrypoints, the admin Worker and the email issuer brought in line with sandbox-dev at `develop` 9b0ae580; the separate "Last verified" lines left by merges folded into this one, exact duplicates dropped; the "not merged, not deployed" notes in the older clauses are history); 2026-11-09 (branch `feat/hana-home-h5`, not merged, not deployed: the vault's use of `GET /v1/app`'s `consent`, `bad_expiry`'s `maxExpiresAtMs`, D530–D538); 2026-11-09 (branch `feat/hana-home-h3`, not merged, not deployed: `POST /v1/home/login`, migration 0018 (`home_usage`, `user_events.app_id` nullable)); 2026-11-09 (branch `feat/hana-home-h2-h4`, not merged, not deployed: `GET /v1/home/apps` and "D1 schema": `apps.first_login_at`, D462 amended); 2026-11-09 (branch `feat/hana-home-h2-h4`, not merged, not deployed: `GET /v1/home/apps`'s `status = 'active'` overlay, `?scopeId=` with quiet scopes, the coverage cache's stated bound; `/v1/vault/consents*`: signature before the window, one chain read and `session_not_visible`, `too_many_consents`: security reviews of H2 and H4, D462, D500, D502, D510, D513); 2026-11-09 (branch `feat/hana-home-h2`, not merged, not deployed: "Routing", "Rate limits", "Hana Home" `GET /v1/home/apps`, "Chain views", "D1 schema" migration 0016: H2 built, D500–D503); 2026-11-09 (branch `feat/hana-home-h4`, not merged, not deployed: `GET /v1/app`'s `consent` and `x-hana-consent`, `POST /v1/vault/consents` and `/revoke`, `deviceLabel` on `POST /v1/vault/shares`, migration 0017, the consent prune in vault maintenance, D510–D513); 2026-11-09 (branch `feat/hana-home-h6-2`, not merged, not deployed: "Hana Home" step 5: the email Home audience only while on the exit list, D494); 2026-11-09 (branch `feat/hana-home-h6`, not merged, not deployed: "Hana Home": the exit client (`homeAudienceRoute`, `/v1/home/config`'s `exitGoogleClientId`), D468, D484, D490); 2026-11-09 (branch `feat/hana-home-h1-2`, not merged: the `RateLimiter` row: markers deleted by the alarm, D475); 2026-11-09 (branch `feat/hana-home-h1`, not merged: "Hana Home": `GET /v1/home/config`, `homeGate`, its refusals, the rate-limit rows, `log()`'s redacted field names; D473, D474); 2026-11-09 (branch `fix/batch-9-review`, not merged: the webhook's one D1 batch and dedupe, the feed's login-methods notice; D444 and D446 amended); 2026-11-09 (branch `feat/email-login-9`, not merged: "Email login page", "Email login views", `AdminRpc.linkStats`, `ConsoleIssuerRpc`, `DirectoryRpc.issuerStats`, `link_usage`, the email AddClient proof; D444–D448); 2026-11-09 (branch `fix/before-mainnet-sweep-2`: "Relayer pools and gas": a session-signed relay's HMAC routing and its failover to the next key, D455's note; the `relay_failover` event); 2026-11-09 (branch `fix/before-mainnet-sweep`: "Relayer pools and gas": the narrowed allowlists and gas table, one relay per signed request, D455, D456); 2026-11-09 (branch `chore/status-access-followups`: the admin's `GET /api/status` NEAR reads on every endpoint the API can use, a tile's `lines`, D435's note); 2026-11-06 (branch `feat/user-events-retention`: `AdminRpc.purgeUserEvents`, the admin's monthly job's `user_events` step, `user_events`' 24-month retention and erasure, readiness 7.17, D433); 2026-11-06 (branch `feat/issuer-readonly-rpc`: the API's `IssuerRpc` entrypoint, the issuer's `API` binding instead of `APP_DB`, `503 api_unavailable`, D434); 2026-11-06 (branch `feat/api-near-rpc-fallback`: `NEAR_RPC_FALLBACKS`, "RPC view timeout and failover", the `near_rpc_failover` log line, D435); 2026-11-06 (branch `feat/mainnet-demo-key-export`: `GET /v1/app`'s `mainnetDemo`, `POST /v1/mainnet-demo/events`, `POST /v1/login`'s `exportChain` and the `key_exported` event, migration 0013 (`apps.mainnet_demo`, `user_events`), `AdminRpc.setMainnetDemo`, the staff app view's `settings.mainnetDemo`, `StaffUser.events`, the admin's `POST /api/apps/:app/mainnet-demo`, the auth Worker's `MAINNET_DEMO_BALANCE` and `/approve`'s dev-env `connect-src`; D428–D430); 2026-11-06 (branch `feat/admin-system-status`: the admin's `GET /api/status`, `AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`, the console's `cron_runs` (migration 0003), the admin's `ledger_cron.last_run` and its new vars, D425); 2026-11-06 (branch `fix/admin-renew-team-login`: the admin's `GET /api/me` `renewUrl`, D424 amended); 2026-11-06 (branch `fix/session-expiry-ux`: the admin's `GET /api/me` `accessExp`, the console's `GET /api/me` `sessionExpiresAt`, D424; no route or request changed); 2026-11-06 (branch `fix/google-key-hysteresis`: "Cron" step 3: three JWKS fetches a run, removal after 24 h missing from every fetch, never a kid with a token in the last 24 h, migration 0012, D422); 2026-11-06 (branch `feat/console-ux-redesign`: the console SPA's pages and error display, D421; no route or request changed); 2026-11-06 (branch `feat/env-alert-label`: the admin Worker's `ENV_LABEL` var, D419); 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: the admin Worker's "Email" through SendGrid, accepted on `202`, no idempotency key, the per-isolate memo; D401); 2026-11-05 (branch `fix/security-review-1105`: the admin's `POST /api/users/search` ticket for a sub or full address, `POST /api/users/find` `{query, ticket}` audited first as `users.find`, `support.lookup`'s `requestIdList`, `recordStaffAction`'s two org-less actions, D410); 2026-11-05 (branch `feat/deploy-check-all-workers`: the build id on every Worker, D406: `GET /.well-known/hana-build` on the console, console-auth and files Workers, the console SPA's `<meta name="hana-build">`, none on the admin (read through wrangler); the shared deploy wrapper); 2026-11-05 (branch `feat/sdk-error-request-id`: "Conventions": an error's `requestId` passed on to the SDK as `data.requestId`, D405); 2026-11-05 (branch `feat/batch-c-15-screen`: the Support ID lookup's screen: the email join in `POST /api/support/lookup` (`emails`, `emailsNote`, `unverifiedWarning`), its ticket in the issuer's rule, `DirectoryRpc.get`'s `purpose` (`support_lookup`), D399); 2026-11-09 (branch `feat/email-sharing-2`: brought up to date with `develop` @ a3de75e, not merged; migration 0014 instead of 0012, D438–D443 renumbered); 2026-11-06 (branch `feat/email-sharing`, not merged: email sharing with partners, D411, D438–D443: migration 0014 (`apps.identity_email`, `email_consents`), `GET /v1/app`'s `identityEmail`, "Email sharing" (the four consent endpoints), the mint's `email` claim and `emailStatus`, `/share-email`'s page policy, `ConsoleRpc`'s `email`/`emails` and email search, `updateSettings`' `identityEmail`, `purgeDirectory`'s `emailConsents`, the issuer's `sealedEmail` answers and `IDENTITY_SEAL_KEY`, the API's `IDENTITY_SEAL_KEY`, `IDENTITY_SEAL_KEY_PREVIOUS` and `EMAIL_CONSENT_KEY`); 2026-11-09 (branch `feat/mainnet-demo-live-prices`: `GET /v1/app`'s `mainnetDemoPrices`, D436); 2026-11-05 (branch `feat/batch-c-15`: `supportId` in the `/v1/sessions` and `/v1/login`
answers, D395; `AdminRpc.supportLookup` / `userShares`; the admin Worker's `POST /api/support/lookup`; the
`support.lookup` staff action; D394–D396); 2026-11-05 (branch `feat/deploy-build-check`: the build id, D384: `GET /v1/health`'s
`build`, the page Workers' `GET /.well-known/hana-build`, the issuer's `GET /v1/email/health`, the `HANA_BUILD` var
only the `deploy` scripts set); 2026-11-04 (branch `fix/admin-cron-budget`: the admin Worker's two crons count every
outbound call (the connection, every RPC, every email and NEAR read) in their 40, at most 30 RPCs, each job's share
logged; D380); 2026-11-04 (branch `feat/batch-c-13`: "Usage ledger retention functions" (0007),
`AdminRpc.purgeAudit` / `deletedApps` / `purgeDirectory`, `StaffRpc.purgeAudit`, the admin Worker's `GET /api/retention`
and the monthly retention job in its 15-minute cron with `retention_failed`; D360–D369); 2026-11-04 (branch `feat/console-reports-upgrades`: the partner SPA's usage, statement and pending-upgrades screens over the report and pending-upgrades routes; a statement's `issuedBy` answered as `hana`; D370–D374); 2026-11-04 (branch `feat/batch-c-10`: `at_hash` in the claim allow-list everywhere, D342; `freezeOrg` pauses pending invites and owner grants, D343; the console's fresh sign-in and write routes, D350–D358); 2026-11-04 (branch `feat/user-id-identity-sub`: `POST /v1/wallets/record`'s `sessionSignature` and key checks (Routing, its section), `ConsoleRpc` / `AdminRpc` user reads with the User ID `u1_…`, the Support ID from it and the staff-only internal id, `end_users.token_sub` in "D1 schema", `directory_unavailable`'s codes; D346, D311/D313 amended); 2026-11-04 (branch `feat/batch-c-12`: `ConsoleRpc.usage` / `statements` / `ledger`,
`StaffRpc.recordStaffAction`, the console's report backend (not routed until C10), the admin Worker's report,
statement, rate and export routes, its 15-minute cron with the daily ledger work at 00:30 UTC, its
`STATEMENTS`/`EXPORTS`/`RELAYER_ACCOUNT` bindings, and the "Usage ledger functions" section; D320–D329); 2026-11-04 (branch `feat/batch-c-14`: `AdminRpc.governance`, `AdminRpc.pendingUpgrades`
and `ConsoleRpc.pendingUpgrades`; the admin Worker's Security & monitoring, alert history, actions, ack, pending
upgrades and playbook routes, its watchdog client's bearer, caps, timeout and failure codes, the new vars and secret;
the console's pending-upgrades backend (not routed until C10); D330–D338; the feed's silent first run, D344); 2026-11-04 (branch `feat/wallet-directory`: `POST /v1/wallets/record` (Routing, Rate limits,
its section), the wallet directory's syncs after `/v1/login` and the link relays, `AdminRpc.listUsers` / `getUser` /
`findUsers` and `ConsoleRpc.listUsers` / `getUser`, migration 0011 in "D1 schema", the new log events; D310–D317); 2026-11-04 (branch `feat/batch-c-9`, merged with `develop` @ bd0c9ea: "Console Worker and
console-auth": partner sign-in (`/api/auth/start`, the auth origin's `/start` and `/callback` through `AuthHandler`,
`/api/auth/complete`, logout), the signed-in reads, console-auth, the new bindings and secret, D290–D297); 2026-11-04
(branch `fix/dev-email-limits`: "Email issuer" "Limits", dev envs' higher code, wrong-code and per-IP limits, D340);
2026-11-04 (branch `feat/batch-c-11`: `GET /v1/app`'s `logoUrl`, the logo pages' `img-src`
with `FILES_ORIGIN` on the auth Worker, the console's logo upload backend (not routed until C10) and its `IMAGES`
binding, the purge order, and the new "Files Worker" section; D300–D308); 2026-11-04 (branch `feat/batch-c-8`: "Admin Worker" (its routes, the Access check, the cron's notices, feed and watcher, its bindings), `AdminRpc.listApps`/`getApp` taking `system`, `StaffRpc.getOrg`'s `grants`; D278–D285); 2026-11-04 (branch `feat/batch-c-6-merge`: batch C6 on current `develop`:
`ConsoleRpc.changeOrigins` / `proposeChange` with the API's own step-up verification (the claim allow-list on the
step-up token), `ConsoleRpc.ownerAction` with `token_has_pii` on both of its tokens (D274 on every path), the
owner-action precheck's nonce recompute on an uncached scope (`owner_nonce_mismatch`, the client-proof nonce), the
safety budget, the 20-a-day per-scope cap and per-owner caps of a fifth of it, `owner_cap` and `owner_allowance_low`
events, `OWNER_POOL_ALLOWANCE_YOCTO`, fresh `get_config` reads; D235–D239, D277); 2026-11-04 (branch `feat/batch-c-7-merge`, C7 merged onto `develop`; written on `feat/batch-c-7` 2026-11-02: "Console Worker": its two link routes, the
CSRF and header rules, `StaffRpc`, bindings and logs, no route yet, D240–D244; on the merge branch: `setMember` never promotes a disabled user, the audit reads' safe-integer bounds); 2026-11-04 (branch `feat/token-first-on`: `google-record` in force under `'token_first'`,
D270); 2026-11-04 (branch `fix/user-emails-review`: the user directory's order-safe upserts in
"Email issuer" D1); 2026-11-04 (branch `feat/google-token-first`: the issuer's `POST /v1/email/google-record`
and its per-IP limit, google-match's user-directory write (D269, D270), the auth page Worker's callback CSP with Google's
tokeninfo in an env with an email issuer); 2026-11-04 (branch `fix/sessions-allow-list`: `/v1/sessions`'s claim allow-list always on, `/v1/owner-actions`'s `token_has_pii` for owner tokens and client proofs, the `REJECT_PII_ON_SESSIONS` binding gone; D271, D274); 2026-11-04 (branch `feat/user-emails`: the issuer's `verify` writes the user directory, its D1's migration 0002 and the `directory_write_failed` log; D269); 2026-11-03 (branch `fix/8b-rereview`, onto `feat/email-login-8b`: the issuer's CORS exposes `retry-after`); 2026-11-03 (branch `feat/email-login-8b` review fixes: the login relay's 40 writes a minute per IP and 12 KiB body, google-match's `google_account_mismatch`, no revocation and 120 per 10 min per IP, D264, D265, D267); 2026-11-03 (branch `feat/email-login-8b`: the login relay's writes from `VAULT_ORIGIN` and the follow-up slots, the vault page's `connect-src` with `EMAIL_ISSUER_URL`, the issuer's case-B `verify` answering `sub` with its `linkTicket`, the web as the caller of google-match, `/v1/sessions/revoke` and `/v1/link*`; D254–D259); 2026-11-03 (branch `fix/demo-polish`: `GET /v1/app` reads its D1 rows and the registry
and the registry side by side, `get_config` only when a shared client is needed, its `settings` and `chain` phases and
its `timings` for `pk_test_` apps, the 8 s timeout on every contract view, the self-healing shared `get_config` read;
D261); 2026-11-02 (branch `feat/email-login-8a`: the auth page Worker's `/login/email` and its
`EMAIL_ISSUER_URL`, the web as the caller of `start` / `resend` / `verify` and of `GET /v1/app`'s `loginMethods`;
D245–D249); 2026-11-02 (branch `feat/email-login-6`: email tokens on `/v1/sessions` and `/v1/login`, the
create_session proof of possession, `/v1/login`'s `linkJwt` precheck, the link relays `/v1/link*`, the email-login
panics as errors, `GET /v1/app`'s `loginMethods`, the gas values, migration 0010, the issuer's URL and app lookup,
D230–D234); 2026-11-02 (branch `feat/batch-c-4`: "Usage capture" (one ledger event per post-gate
request, written after the response through `USAGE_DB`), the D1 `usage` counters no longer written, migration 0009
`session_markers` and the waiver on it, the relay result's key, nonce and gas, the identity-count copy in the cron,
`USAGE_DB` / `USER_ID_KEY`, the usage log events; D220–D224); 2026-11-02 (branch `fix/c5-budgets`: "RPC entrypoints" breaker and budget: the
per-org share of the global reserve, kill switches that changed nothing settled onto their org, the link cancel's
read budget, a malformed link token `forbidden`, D228, D229); 2026-11-02 (branch `feat/batch-c-5`: "RPC entrypoints" (`ConsoleRpc`, `AdminRpc`: CAS
writes, the breaker, the hot-DB budget, keys, notices, cancel, expedite, staff proposals), drift detection in the
cron, the `console-rpc` limiter object, the legacy `apps.publishable_key` kept on a valid key, the new log events,
and the review fixes: per-org budget with a kill-switch reserve, the link cancel's own limits, breaker refunds,
replays of another write `conflict`, D225–D229; branch `feat/email-login-4`: "Email issuer", the separate `apps/email-issuer` Worker: its endpoints,
limits, Durable Objects, D1, bindings and logs, D195–D199, with the review fixes and the abuse re-check (the owner
pool, mailed unlock and unsuppress, confirm, revoke-tickets, the growing domain cap, per-address tickets); branch `feat/identity-token-7`: the identity token's AWS KMS signer, its vars,
secrets and log codes, D215–D219); 2026-11-02 (branch `feat/batch-c-3`: migration 0006, the gate on `app_keys` and `scopes`,
origins in force by `active_from`, suspension bits, `first_session_at`, the guarded-change cron job, the batch C vars
read, D205–D209); 2026-11-02 (branch `feat/batch-c-2`: the token check and the governance read's JWKS
cache now in `@hana-id/oidc`; wrongly typed optional claims ignored, a non-finite `exp` refused, the owner-action
token's claims, D201); 2026-10-30 (branch `feat/identity-token-2`: the identity token's order of checks, limits, marker, cross-app share check, share tombstones in the cron, the new binding and log event, D176–D178);
2026-10-30 (branch `feat/identity-token-1`: "Identity token", its routes, limits,
Durable Objects, D1 tables, cron job, bindings, log fields and the `bad_token` refusals); 2026-10-30 (branch
`feat/batch-c-1`: the batch C vars in "Configuration"); 2026-10-29
(branch `gov/api`: the governance batch's cron, `issuer_key_pending` /
`paused`, `GET /v1/governance`; branch `perf/login-latency-impl`: the vault endpoints' gate, the auth pages' CSP and
the timings; the rest as of 2026-10-28, commit 58edee9).

Current state, not a spec. Where the specs (`docs/batch-*.md`) and this file differ, this file follows the code.
Contract methods and byte layouts: `docs/contract-interface.md`. How to run it: `docs/operations.md`.

**B** marks what batch B added or changed (the vault, the auth pages, `POST /v1/login`, the login relay, the vault
endpoints and the page Workers). **G** marks the governance batch (`docs/governance-spec.md`): the JWKS cron now
proposes and executes delayed key changes, logins refuse a kid not yet active on chain and a paused contract, and
`GET /v1/governance` reports the governance state. **L** marks email login's API part (build plan batch 6,
`docs/email-login-spec.md` "API changes", D230–D234): email tokens, the `create_session` proof of possession (D137), the
link precheck and the link relays.

The API Worker renders `GET /vault` for requests whose URL origin is `VAULT_ORIGIN`: the vault origin's own thin
Worker forwards them unchanged through a service binding. `/vault.js` and the auth pages (`/login`,
`/login/callback`, `/approve`, `/export`) are served by the page Workers ("Page Workers" below), never by
this Worker.

## Routing

`src/index.ts`, in this order. Any other path: `404 not_found`. A method not listed: `405 method_not_allowed` with
`allow`. An uncaught error: `500 internal` (logged with the path, a login relay path without its relayId). The Hana
page origins never reach the API routes: a request whose URL origin is `VAULT_ORIGIN` or `AUTH_ORIGIN` gets
`/vault` (vault origin only) or a 404.

| Path | Methods | Handler | Auth | B |
|---|---|---|---|---|
| `{VAULT_ORIGIN}/vault` | GET, HEAD | `vault/page.ts` | publishable key in `?pk=` | B |
| any other path on `VAULT_ORIGIN` or `AUTH_ORIGIN` | any | `index.ts` | — (`404`, text, `frame-ancestors 'none'`, `nosniff`, no CORS) | B |
| `/v1/health` | GET, HEAD, OPTIONS | `handlers.ts` | none | |
| `/v1/governance` | GET, HEAD, OPTIONS | `governance-status.ts` | none (public data, read-only) | G |
| `/v1/app` | GET, OPTIONS | `handlers.ts` | publishable key + caller rule | changed in B |
| `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` | POST, OPTIONS | `handlers.ts` | publishable key + caller rule (+ session signature for derive/revoke) | caller rule changed in B |
| `/v1/login` | POST, OPTIONS | `login.ts` | publishable key + caller rule + session signature | B; link L |
| `/v1/link`, `/v1/link/cancel`, `/v1/link/unlink` | POST, OPTIONS | `links.ts` | publishable key + Hana page caller + the identities' tokens | L |
| `/v1/login-relay/<relayId>` | GET, POST, OPTIONS | `login-relay.ts` | Hana origin only; read key for GET | B |
| `/v1/vault/shares`, `/unlock`, `/touch`, `/revoke`, `/revoke-all` | POST, OPTIONS | `vault/endpoints.ts` | publishable key + vault origin + session signature (vault message) | B |
| `/v1/vault/share-status` | POST, OPTIONS | `vault/share-status.ts` | publishable key + vault origin + allowed parent; the share id names the share (no signature, D690) | B |
| `/v1/identity/token` | POST, OPTIONS | `identity/token.ts` | publishable key + vault origin + session signature (identity message) | I |
| `/v1/wallets/record` | POST, OPTIONS | `directory/record.ts` | publishable key + vault origin + each address's own signature (wallet record) + the session key's signature over the request + a live session on that path | W |
| `/v1/home/config` | GET, OPTIONS | `home/config.ts` | `AUTH_ORIGIN` only (no identity yet) | H1 |
| `/v1/home/apps` | GET, OPTIONS | `home/apps.ts` | `AUTH_ORIGIN` + Home identity (`homeGate`) | H2 |
| `/v1/home/devices` | GET, OPTIONS | `home/devices.ts` | `AUTH_ORIGIN` + Home identity (`homeGate`); the identity's own rows only | H9 |
| `/v1/home/consents/revoke`, `/v1/home/shares/revoke`, `/v1/home/email-sharing/revoke` | POST, OPTIONS | `home/revoke.ts` | `AUTH_ORIGIN` + Home identity (`homeGate`); the identity's own rows only, 404 otherwise | H9 |
| `/v1/identity/jwks.json`, `/v1/identity/.well-known/openid-configuration` | GET, HEAD, OPTIONS | `identity/public.ts` | none (public keys only) | I |
| `/v1/owner-actions` | POST, OPTIONS | `handlers.ts` | OIDC owner token inside the args | |
| cron `*/15 * * * *` | — | `issuer-keys.ts`, `vault/cron.ts`, `key-observations.ts`, `identity/maintenance.ts`, `guarded/cron.ts`, `changes/drift.ts` | — | vault part B; JWKS sync every 15 min since G; identity counts' retention I; guarded changes and drift C |
| `ConsoleRpc`, `AdminRpc` (named exports) | RPC only | `rpc/console.ts`, `rpc/admin.ts` | no route: reachable only through a service binding (console, admin Worker); `fetch` answers 404 for every other path | C |

There is no secret-key (`sk_…`) auth anywhere: publishable keys are public and origins gate them. "I" marks the
partner identity token (`docs/identity-token-spec.md`, build steps 1–4); "W" the wallet directory (D310, branch
`feat/wallet-directory`). Nothing under `/v1/email/` is the API's: the
email issuer is its own Worker, reached at its own URL (`emailIssuer.url`) or by a zone route that never runs this
Worker (D230); here such a path is `404 not_found`.

## Conventions

- JSON bodies, camelCase on app endpoints, contract-shaped snake_case on owner actions. Byte arrays are JSON arrays of
  integers 0..255.
- Success: `{…fields, "requestId"}` — relayed calls `{"result": …, "nearTx": "<base58 tx hash>", "requestId"}`.
  Error: `{"error": "<message>", "code": "<code>", "requestId", "nearTx"?, …extra}`.
- `x-request-id` on every non-preflight response; `requestId` is the `cf-ray` header when it matches
  `[A-Za-z0-9-]{1,64}`, else a random UUID. The vault passes an error answer's `requestId` on to the partner's SDK
  (0.2.0 or later) as `data.requestId`, only when it is 8–64 of `[A-Za-z0-9-]` (D405): nothing else of an error body
  reaches the partner beyond what `docs/integration.md` section 13 lists.
- `content-type: application/json; charset=utf-8`, `cache-control: no-store`.
- Body caps (streamed, `413` with code `bad_request` past them): app endpoints and owner actions 16 KiB, vault
  endpoints and `/v1/identity/token` 4 KiB, login relay 12 KiB. Non-JSON: `400 bad_request`. JWT ≤ 7168 characters.
- Usage: one ledger event per request past the gate (below, "Usage capture"), sent after the response (`waitUntil`);
  no endpoint's answer or latency depends on it. The D1 `usage` counters are no longer written (batch C4).

## Callers, origins and CORS (`src/origins.ts`)

"Dev env" = `ENV_NAME` starting with `local` or `sandbox`. "Loopback" = `localhost`, `*.localhost`, `127.0.0.0/8`,
`[::1]`; the app origin entry `http://localhost:*` matches any `http://localhost:<port>`.

`originAllowed(app, origin)`: exact match against the app's origins **in force** (`app_origins.active_from <= now`; a
row whose `active_from` is NULL, a guarded change not yet announced, never matches, and an announced one matches from
its `active_from` on, with nothing run at that moment); loopback origins (and the wildcard) count only for apps on a
`test` scope (`scopes.environment`, the scope of every `pk_test_` key) in dev envs.

| Caller (`Origin`) | `/v1/app` | `/v1/login` | `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` | `/v1/link*` (L) | Vault endpoints | Login relay |
|---|---|---|---|---|---|---|
| `VAULT_ORIGIN` | yes | yes | yes | yes | yes | read, write (follow-up notices, batch 8b) |
| `AUTH_ORIGIN` | yes | yes | no | yes | no | write, read |
| a partner origin of the app | yes, any key, any env | no | only test-scope apps in dev envs (`apps/smoke`) | no, never | no | no |

- From a Hana origin the request acts for `x-hana-parent-origin`, which must pass `originAllowed` for the app. CORS
  echoes the Hana origin even when the parent is refused, so the page can read the error.
- From a partner origin, CORS echoes the origin only when the call is allowed; a refused partner gets no CORS headers.

| Preflight | Allowed when | `allow-headers` | `allow-methods` |
|---|---|---|---|
| `/v1/app`, `/v1/sessions*`, `/v1/derive`, `/v1/login`, `/v1/link*` | `Origin` is a Hana origin, or it is in force (`active_from <= now`) for an app that is active (`status = 'active'`, `suspended_by = 0`) and not deleted (loopback: only a test-scope app in a dev env) | `content-type, x-hana-key, x-hana-parent-origin, x-hana-relay-key` | `GET, POST, OPTIONS` |
| `/v1/vault/*` | `Origin === VAULT_ORIGIN` | `content-type, x-hana-key, x-hana-parent-origin` | `POST, OPTIONS` |
| `/v1/login-relay/*` | a Hana origin | `content-type, x-hana-relay-key` | `GET, POST, OPTIONS` |
| `/v1/health`, `/v1/owner-actions` | always (`*`) | `content-type` | `POST, OPTIONS` |

Allowed preflight: `204`, `access-control-max-age: 600`, `access-control-expose-headers: x-request-id, retry-after`,
`vary: Origin` (except `*`). Refused: `403` with no CORS headers.

## The app gate (`appGate`, `handlers.ts`)

Every app endpoint (`/v1/app`, `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke`, `/v1/login`, `/v1/link*`) runs, in order:

1. `x-hana-key` present (`401 missing_key`) and shaped `pk_(test|live)_<base58 16..64>`, an unrevoked key of an
   undeleted app (`401 unknown_app`; D1 failure `503 config_unavailable`). Two D1 queries, as before 0006: the app
   through `app_keys` (`revoked_at` NULL or still in the future, the rotation grace) joined to `apps`
   (`deleted_at IS NULL`), `scopes` and `plans`; then its origins in force. A revoked key answers exactly as an
   unknown one. `apps.publishable_key` is never read (it stays as the legacy column every app fills with its first key).
2. App active: no suspension bit (`suspended_by`: Hana 1, org 2, partner 4) and the legacy `status` `active`, which a
   trigger keeps equal to `suspended_by != 0` (`403 app_suspended`). The key's prefix names its scope's environment
   (`403 scope_conflict` otherwise; the 0006 triggers refuse such a row, so only a direct edit of `app_keys` reaches
   this check). Test and live apps never share a scope: `scopes` holds one environment per scope (D51).
3. Caller rule above (`403 origin_not_allowed`).
4. The per-IP limit (`429 rate_limited` + `retry-after` seconds; limiter failure `503 rate_limiter_unavailable`).

The app's relay quota (plan `per_minute` / `per_day`) is not part of the gate: each relay endpoint asks it last, after
the body, token, nonce, session-signature, scope and session checks and right before the relay (`appQuota`, D100). The
publishable key and the `Origin` / `x-hana-parent-origin` headers are public, so a request that fails a check never
spends the quota every user of the app shares (security sweep APIW-1); the per-IP window, asked first, bounds what a
flood can make the checks cost.

A test app's other limits are the vault's, never the API's: no raw signing and no mainnet chains for `pk_test_` (D39).

When a session-pool relay (`/v1/sessions`, `/v1/login`, `/v1/derive`, `/v1/sessions/revoke`) is about to be sent on a
scope whose `scopes.first_session_at` is NULL, the API sets it, beside the relay (no added latency; with an execution
context it finishes after the response). At the attempt, not the success, so a relay whose answer fails or is lost still
marks the scope. Once that relay settled (whatever its outcome) it also writes the app's `session_markers` row
(migration 0009): a second, independent sign, so one lost write never leaves the waiver open. A failure of either is
logged as `first_session_write_failed` (`what` `scope` / `marker`); the scope's is retried by the next attempt. They
are the signs that end the `no_session` waiver of guarded changes, which is decided inside the announcement's own SQL:
no `first_session_at`, no other origin of the scope ever in force, no vault share, session marker or identity row for
the scope's apps (`scripts/lib/admin-sql.ts` `noSessionWaiver`; the legacy `usage` rows until batch C4, D220).

## Rate limits

Two kinds of counter (D95):

- **Global, exact**: fixed windows in `RateLimiter` Durable Objects; a hit counts only if every window checked has
  room. The day window is the UTC day. Every limit below is this kind unless marked *per location*.
- **Per location, approximate** (*per location* below): Cloudflare's Rate Limiting bindings (`ratelimits` in the
  generated wrangler config, `src/vault/limits.ts`). Each Cloudflare location counts on its own from a locally
  cached count, with no network hop; counts sync in the background, so a burst can briefly pass the limit, and a
  client served from two locations gets the limit in each. Used only for the vault endpoints' and the identity
  token's flood limits. A
  refusal's `retry-after` is the binding's period (60 s): the binding doesn't say when its window ends.

The per-IP subject is the IPv4 address or the IPv6 /64 (`src/ip.ts`).

| Endpoint | Per IP | Per app | Other |
|---|---|---|---|
| relay kind: `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke`, `/v1/login` (one shared window) | plan `per_ip_minute` (window `<appId>:minute`), before any check | plan `per_minute` and `per_day`, counted only for a request that passed every off-chain check, right before the relay (D100) | a refused or failed request never spends the app's quota |
| link relays (L): `/v1/link` (adds) and `/v1/link/cancel`, `/v1/link/unlink` (removals), each kind its own windows (D232; provisional) | adds 5/min (window `<appId>:link:minute`), removals 10/min (`<appId>:link-change:minute`), before any check | adds 30/min, 1000/day (`app:<appId>:link-adds`), removals 60/min, 2000/day (`app:<appId>:link-changes`), counted only for a request that passed every check | a flood of adds never uses up a cancel's windows; never the relay quota |
| key exports: `/v1/login` from `AUTH_ORIGIN` | — | — | 3 per hour per user path per app (subject `export:<appId>:<hex sha256(path)>`, window `export:hour`), counted once the token and nonce are verified, before anything is relayed (D59) |
| `GET /v1/app` | plan `per_ip_minute` (own window `<appId>:config:minute`) | — | never touches the relay quota |
| `POST /v1/vault/share-status` | 600/min across apps, *per location*, before the app lookup (binding `VAULT_STATUS_IP_LIMIT`, key `<env>:vault-status-ip:<ipSubject>`) | — | 30/min per share, *per location* (binding `VAULT_STATUS_SHARE_LIMIT`, key `<env>:vault-status-share:<appId>:<hex>`), after the body check; not counted in the vault windows below (D690) |
| vault endpoints | 60/min, *per location* (binding `VAULT_IP_LIMIT`, key `<env>:vault-ip:<appId>:<ipSubject>`) | 10 × plan `per_minute` (`vault:minute`), global | share actions: 10/min per share, *per location* (binding `VAULT_SHARE_LIMIT`, key `<env>:vault-share:<appId>:<hex>`); asked in turn: IP, then app only once the IP accepted, then (after the body check) the share (D95). `/v1/vault/consents*` count in the same window (their share's, or in `'none'` mode the session key's) |
| `/v1/identity/token` (I, D176) | the vault endpoints' 60/min binding, before the body | its own windows on `app:<id>`, never `vault:minute`: `identity:minute` 10 × plan `per_minute`, `identity:hour` plan `per_day` (at most 100 000), sliding, counted after every other check | per session key 10/min, *per location* (`IDENTITY_SESSION_LIMIT`, key `<env>:identity-session:<appId>:<hex sessionPk>`), after the signature; per account root 30/min, *per location* (`IDENTITY_ROOT_LIMIT`, key `<env>:identity-root:<scopeId>:<hex sub bytes>`); per scope `identity:hour` 2 × the app's (`identity:scope:<scopeId>`, sliding); then global on `identity:global`, sliding: a hard breaker of 1 000 000/h (`503 identity_busy`; `IDENTITY_GLOBAL_HOURLY_MAX` overrides; ≥ 10 × any app's ceiling) and a soft line at 100 000/h that only logs `identity_volume_alert`. A refusal by a later window takes the hit back from the earlier ones |
| `/v1/wallets/record` (W) | the vault endpoints' 60/min binding, before the body | the vault endpoints' `vault:minute` (10 × plan `per_minute`) | one per login by design (the vault never retries); a replay changes no row |
| login relay | writes 40/min, reads 120/min (about 5 writes per linking login, D267) | — | not per app |
| `/v1/owner-actions`, `ConsoleRpc.ownerAction` (one limiter: the RPC's `clientIp`) | 10/min | per scope 10/min, 20 a UTC day (`owner-actions:scope:<scopeId>`), `propose_change` only | `propose_change`: per owner identity 2/min, 4/day (`owner-actions:owner:<hex sha256(provider#sub)>`: the scope's windows divided by the contract's `MAX_OWNERS`, so no owner can use up its co-owners' proposals, D236), then per scope, then global 20/min, 200/day (`owner-actions:global`). `execute_change` (no auth): its own 10/min, 50/day per scope (`owner-actions:execute:<scopeId>`), then global. The safety budget, `cancel_change`, `remove_client` and `disable_shared_login`: none of those; 5/min, 20/day per owner identity (windows `safety:minute`, `safety:day`), then 25/min, 100/day per target scope (`owner-actions:safety:<scopeId>`: the contract's `MAX_OWNERS` = 5 owners at their own cap), then a spend-bound ceiling of 100/min, 1000/day (`owner-actions:safety-global`). Counted only after every off-chain check passes, the owner proof against the target scope's on-chain owners included; a request a later window refuses is taken back from the earlier ones (D100, D236). A refusal writes an `owner_cap` security event, once per window |
| `/v1/health`, `GET /vault` | — | — | — |
| `GET /v1/home/config` (H1) | 60/min (`home:config:ip`), after the origin check | — | — |
| `GET /v1/home/apps` (H2) | 30/min (`home:apps:ip`) | — | 60/min per Home key (`home:apps:key`); a search (`?q=`) also 10/min per Home key (`home:apps:search:key`, D500) |
| `GET /v1/home/devices` (H9) | 30/min (`home:devices:ip`) | — | 60/min per Home key (`home:devices:key`) |
| The three `POST /v1/home/*/revoke` (H9) | 30/min (`home:revoke:ip`, shared by the three) | — | 30/min per Home key (`home:revoke:key`, shared) |
| Later `/v1/home/*` (via `homeGate`; each passes its own window names) | the endpoint's per-IP limit, before the header is read | — | the endpoint's per-Home-key limit, after the signature |

Seeded plan `free`: `per_minute` 60, `per_day` 5000, `per_ip_minute` 20.

## Endpoints

### `GET /v1/health`

No auth, no limits, `access-control-allow-origin: *`. → `200 {"ok": true, "env": ENV_NAME, "signer": SIGNER_ACCOUNT, "hotDb": 9, "capabilities": {"createProof": true}, "usageCapture": true | false, "build": "0485faa1c2d3" | null, "requestId"}`.
`hotDb` is the hot-DB migration the build needs (`apps.ts` `HOT_DB_SCHEMA`; 6 from batch C3, 9 from batch C4 (the
session markers it writes), absent before): the admin CLI refuses guarded proposals on `--remote` until the deployed
API reports ≥ 6, and announcements until it reports ≥ 9.

`usageCapture` (H11, D596): whether this API has its `USAGE_DB` binding and writes usage events; `deploy-check` fails a
production env when it is false. `capabilities` (L, D250): what this build does that deploy tooling checks; `createProof: true` (`/v1/sessions` requires
and relays create_session's proof of possession, D137). `deploy-contract --upgrade` refuses without it.

`build` (D384, added 2026-11-05; older readers ignore it): the build id the Worker was deployed with, the commit's
first 12 hex characters plus `-dirty` when the tree had uncommitted changes (`@hana-id/env/build-id`); `null` when
the Worker was deployed without `pnpm --filter @hana-id/api run deploy` (the var `HANA_BUILD` is set only by that
script, the shared wrapper `packages/env/src/stamped-deploy.ts`, D406, never by `gen`) or the var isn't an id. `deploy-check <env>` compares it with
the page Workers', their bundles' and the issuer's (`docs/operations.md` "Checking a deploy").
### `GET /v1/governance` · G

No auth, no limits, `access-control-allow-origin: *`, `cache-control: public, max-age=10`. Read-only: it reads
hana-signer's views (`get_config`, `get_governance`, `get_key_changes`, `get_issuer("google")`), the signer's
`view_access_key_list`, Google's JWKS (the token-check cache, `@hana-id/oidc` `publishedKeys`) and the JWKS
cron's D1 tables, and sends no transaction. One snapshot per isolate serves every request for 10 s (concurrent misses share one read); `readAtMs`
says when it was taken, so countdowns are the reader's (`executableAtMs − now`).

This is the machine-readable source batch C's admin portal ("Security & monitoring", the pending-upgrades page;
D83, D86) and operators read for the contract side of governance (the portal reads the same snapshot over the service
binding: `AdminRpc.governance`, `AdminRpc.pendingUpgrades`, `ConsoleRpc.pendingUpgrades`, C14); the watchdog's heartbeat, verdicts, actions log and
alerts come from the watchdog service's `GET /status` / `GET /alerts`, never from here. The API runs on Hana's main
Cloudflare account, so a reader that must not trust it reads the same views through its own RPC
(`docs/contract-interface.md` "Monitoring hand-off" lists them).

→ `200`:

```jsonc
{
  "signer": "hana-signer-dev1.testnet", "env": "sandbox-dev", "readAtMs": 1800000000000,
  "stateVersion": 2,
  "paused": false,
  "unpausedAtMs": 0,                                // the last unpause (0: never)
  "changesUnlockFloorMs": 0,                        // no execute_change before this (each unpause re-arms the scope timelock)
  "sessionsValidFromMs": 0,                         // sessions opened before this can't derive (owner's session floor)
  "delays": {
    "issuerKeyDelayMs": 120000, "governanceDelayMs": 60000, "changeDelayMs": 60000,
    "pendingIssuerKeyDelay": null,                  // a decrease: {"valueMs", "effectiveAtMs"}
    "pendingGovernanceDelay": null, "pendingChangeDelay": null
  },
  "issuers": [{ "provider": "google", "activeKids": ["a1b2"], "jwksKids": ["a1b2", "c3d4"] }],  // jwksKids null: JWKS unavailable
  "keyChanges": [{
    "id": 7, "provider": "google", "kid": "c3d4", "op": "Add",  // or "Remove"
    "by": "hana-signer-dev1.testnet", "proposedAtMs": 0, "executableAtMs": 0,
    "due": false,                                   // executableAtMs has passed: anyone may execute (unless paused)
    "jwks": "match"                                 // Add: match | mismatch | absent; Remove: absent | present; unknown without a JWKS
  }],
  "watchdogs": [{ "accountId": "hana-id-watchdog-dev1.testnet", "confirmFromMs": 0, "canConfirm": true }],
  "keysSlowUntilMs": 0,
  "updaterKeys": ["ed25519:…"],
  "updaterMethods": ["set_issuer_key", "propose_issuer_key_removal", "execute_issuer_key_change"],
  "signerAccessKeys": [{                            // null when the RPC didn't answer
    "publicKey": "ed25519:…", "kind": "function_call",   // or "full_access"
    "receiverId": "hana-signer-dev1.testnet", "methodNames": ["…"], "allowanceYocto": "1000000000000000000000000",
    "updaterKey": true,                             // listed in get_governance().updater_keys
    "updaterPermission": true                       // exactly the updater methods, receiver the signer, allowance ≤ 1 NEAR
  }],
  "pendingUpgrade": { "codeHash": "8Tf3…", "proposedAtMs": 0, "executableAtMs": 0, "due": false },  // or null
  "pendingOwner": { "owner": "…", "acceptableAtMs": 0, "due": false },                              // or null
  "pendingWithdrawal": { "receiver": "…", "amountYocto": "…", "executableAtMs": 0, "due": false },   // or null
  "pendingConsoleAudiences": [{ "provider": "google", "aud": "…", "effectiveAtMs": 0 }],
  "pendingSharedClients": [],
  "updater": {                                      // the JWKS cron (null when D1 failed)
    "lastRuns": [{ "provider": "google", "atMs": 0, "outcome": "ok", "code": null, "summary": { "proposed": [], "…": [] } }],
    "proposals": [{ "provider": "google", "kid": "c3d4", "op": "Add", "changeId": 7, "proposedAtMs": 0, "cancelledSeenAtMs": null }]
  },
  "requestId": "…"
}
```

What the portal derives from it (the API raises no alert): a `keyChanges` entry with `jwks` `mismatch` or `absent`
(Add) or `present` (Remove); `due` changes not executed; `paused`; any `pendingUpgrade`, `pendingOwner`,
`pendingWithdrawal`, delay decrease or console-audience addition; a `full_access` key, or a function-call key without
`updaterKey` and `updaterPermission`, on the signer outside sandbox-dev; `updater.lastRuns[].outcome` other than
`ok`, and `updater.proposals[].cancelledSeenAtMs` (a proposal of ours was cancelled). `summary` is the run's
`SyncResult` (`issuer-keys.ts`).

| Status | Code | When |
|---|---|---|
| 502 | `near_unavailable` | a contract view failed (also a contract still on v1, which has no `get_governance`) |
| 502 | `bad_contract_result` | a view answered in a shape this code doesn't know (nothing partial is reported) |

### `GET /v1/app`

Headers: `x-hana-key`; from a Hana page also `x-hana-parent-origin`. Gate kind `config`. No transaction.

→ `200`:

```json
{ "name": "string", "scopeId": "string", "signer": "string",
  "google": { "clientId": "string", "mode": "own" | "shared" } | null,
  "loginMethods": ["google", "email"], "email": { "aud": "email:<scopeId>" },
  "serverTimeMs": 0, "autoApprovePolicy": {} | null, "rawSign": "off" | "approval", "mainnetDemo": false,
  "logoUrl": "https://<files.origin>/logos/<app id>/<sha256 hex>.png" | null,
  "identityEmail": "off" | "on_request" | "at_login",
  "walletChains": ["stellar", "evm", "near"],
  "consent": "active" | "revoked" | "unknown",
  "timings": { "totalMs": 0, "phases": {} }, "requestId": "string" }
```

`consent` (H4, D465, D511), only for `Origin: VAULT_ORIGIN` with `x-hana-consent: b64url(consentId)` (allowed in the
preflight): the consent's status for this app, one uncached D1 statement, no extra limit. `active`: not revoked, before
its `expires_at`, its share (if any) live as unlock judges it (not revoked, before `idle_until` and `min(abs_expires_at,
created_at + session_ttl_ms)`, the app still keeping logins, the origin still allowed). `revoked`: otherwise, including a
share row already pruned. `unknown`: no such consent in this app, or a malformed id (no D1 read). Left out without the
header, from any other origin, and when D1 can't be read (not `unknown`: log `consent_status_unavailable`, so a blip
can't make a vault drop a consent). Older vaults never send the header and see no difference.

`share` (H9, D662), only for `Origin: VAULT_ORIGIN` with `x-hana-share: b64url(shareId)` (allowed in the preflight): `revoked`
when the share is gone, revoked (the device, Hana Home's "Sign out this device"), the app no longer keeps logins, or its
origin is no longer allowed; else `live`. Time-based ends (idle, absolute) are not reported: they stay the vault's own and the
next unlock's or touch's (D55). One uncached D1 statement. Left out without the header, for a malformed id, from any other
origin, and when D1 can't be read (`share_status_unavailable`). The vault sends it on every `GET /v1/app` it makes and ends
the session on `revoked`, as a touch's 410 does; nothing else changes anything (D539: the read slides nothing). Since D680
an app with a policy relies on this read for its share check, about once a minute in an active tab (every 5 minutes once
idle, D684); every other share check uses `POST /v1/vault/share-status` (D690), with this read as its fallback. One read
costs at most 8 D1 statements and about 14 rows read for an app with one origin (D684). The vault (H5, D530–D535)
sends it whenever it holds a consent, on its existing 10-second read, and treats `unknown`, `revoked` or a value of another
shape as stated in `docs/security.md`: `revoked`/`unknown` clear the consent, a missing field is no answer.

`identityEmail` (D411): the app's `identity_email` setting (migration 0014; `off` before it): the vault asks the user to
share their address at the first login (`at_login`), only from `requestEmailSharing()` (`on_request`), or never.
`walletChains` (D755, D759): the chains this API takes in the export window's `exportChain` and in `POST
/v1/wallets/record`'s `wallets`; always `["stellar", "evm", "near"]` since `feat/near-directory`. Older APIs omit it,
and a page treats anything but an array naming `near` as Stellar and EVM only (core `apiTakesNear`): the export window
then sends no `exportChain` for a NEAR export, and the vault no NEAR record, so a page deployed ahead of the API never
sends a value the API refuses.
`mainnetDemo` (D428): `true` only when the Worker's env is a dev env on testnet (`isDevEnv(ENV_NAME)`, `NETWORK =
`mainnetDemo` (D428; a pk_test_ app's response also carries a phase `prices` when the demo is on, D436): `true` only when the Worker's env is a dev env on testnet (`isDevEnv(ENV_NAME)`, `NETWORK =
testnet`), the app's scope is `test` and Hana staff set `apps.mainnet_demo = 1` (migration 0013); otherwise `false`,
also when the column is missing (0013 not applied) or its read fails (`src/mainnet-demo-setting.ts`). It is read beside
the settings row. The vault re-reads it, on the same 10 s bound as `rawSign`, before every mainnet request of a test
app, and honours it only in a dev testnet build of its own; the cap and what can be valued are the vault's
(`docs/mainnet-demo-and-key-export-spec.md`).

`mainnetDemoPrices` (D436, only when `mainnetDemo` is `true`; absent otherwise): the book the vault values requests
with:

```json
{ "atMs": 1794268800000, "assets": {
    "ETH": { "usdMicros": "2251798500", "source": "live" },
    "XLM": { "usdMicros": "155400", "source": "live" },
    "USDC": { "usdMicros": "1048950", "source": "live" },
    "EURC": { "usdMicros": "1165500", "source": "live" } } }
```

`usdMicros` is USD × 10⁶ in decimal. `source` is `live` (`src/mainnet-demo-prices.ts`: CoinGecko's price × 1.05, rounded
up, clamped per asset to its floor and ceiling) or `fixed` (`@hana-id/core`'s table, per asset, when no live price is
usable); `atMs` is the oldest live price's own time, or `null` when every asset is fixed. Prices are fetched at most
once per isolate per 5 minutes (Cache API too, so per colo where it is available) and a price older than 15 minutes
isn't used; a request with nothing cached waits at most 1.2 s for a refresh, then answers the table with the refresh
continuing in the background. CoinGecko isn't called for any other request, or outside a dev env on testnet. The
vault re-checks a book with `parseMainnetDemoPrices` (band and age) and treats anything it refuses as the fixed table.

`logoUrl` (C11, D305): `<FILES_ORIGIN>/<apps.logo_key>`, or `null` when the app has no logo or the env has no files
origin (no dashboard blocks). Read from the gate's row (no extra query). The vault passes it to the auth pages
(`packages/web`), which show it beside the app's name only from the files origin their build pins; older clients
ignore it.

After the gate, the settings and `login_methods` rows (D1) and the registry read run side by side (D261), and both are
awaited before any answer, on every path. The registry read is `get_scope`, then `get_config` only when the scope
needs a shared client (the app has no `google_web_client_id`, the scope has no Google client and allows shared
login; cached 60 s, one read in flight per isolate). A failed `get_config` counts only where the shared client is
used. Like every contract view the API makes, each gives up after 8 s ([Timings](#timings) below), so a stalled node
answers `502 near_unavailable` instead of holding the request; the vault asks once more (`packages/web`
vault/login.ts).
`timings`: `pk_test_` apps only ([Timings](#timings)).

`loginMethods` (L, D231) is what the app's D1 `login_methods` enables (migration 0010; `'google'` by default, read
here, never in the gate; a database before 0010 reads as Google-only) and the scope can serve on chain, in the order
google, email: Google as below; email only with the scope's client `("email", "email:<scopeId>")`, then `email:
{aud}` is present. A Google-only app (every app until build plan batch 8) answers exactly as before with
`loginMethods: ["google"]` added, and keeps its `409 no_google_client`. An app with email on gets `google: null` when
only email is available and `409 no_login_method` when neither is. The vault (batch 8a) offers email in the popup
only for `["google","email"]` with `email.aud = "email:<scopeId>"` in an env whose bundle pins an email issuer; it
refuses an answer with `google: null` for now (D247).

`name`, `serverTimeMs`, `autoApprovePolicy` and `rawSign` are new in B. `autoApprovePolicy` is the policy in force now
(read from D1 on every request, validated and normalized as the vault page inlines it), or null; an open vault
re-reads it before auto-signing, so a removal takes effect within 10 s without a reload (D62, `docs/security.md`
"Auto-approve policies"). `rawSign` is the app's raw-signing setting in force now (`'approval'` only once a pending
enable has reached `raw_sign_effective_at`; `'off'` when the settings row is missing); an open vault re-reads it, on
the same 10 s bound, before every raw request and refuses once it says `'off'` (D68). The test-app refusals (raw
signing and mainnet chains for `pk_test_`, D39) are the vault's, not the API's. `google`: `own` with the app's `google_web_client_id` if set (it must still be
a client of the scope), else the scope's first Google client; else `shared` with the first shared client in force
when the scope has `allow_shared`.

| Status | Code | When |
|---|---|---|
| 409 | `scope_not_registered` | `get_scope` is null |
| 409 | `no_google_client` | a Google-only app: `google_web_client_id` no longer in the scope, or no own client and no usable shared client |
| 409 | `no_login_method` (L) | an app with email on: neither Google nor the scope's email client is available |
| 502 | `near_unavailable` | registry read failed |
| 503 | `config_unavailable` | the app's settings row or `login_methods` could not be read |

### `POST /v1/sessions` — relays `create_session` (session pool)

Body: exactly the fields below (anything else, `scopeId` and `linkJwt` included, is `400 bad_request`, D250):

| Field | Type | Rule |
|---|---|---|
| `jwt` | string | a Google ID token (three base64url segments) or an email token (JWS JSON, `{…}`, printable ASCII; L), ≤ 7168 chars |
| `sessionPublicKey` | number[32] | Ed25519 public key |
| `expiresAtMs` | integer | in `(now, now + 24 h + 5 min]` |
| `salt` | number[16..64] | |
| `keyIndex` | integer | `0 ..= 2^31 − 1` |
| `maxUses` | integer | `1 ..= 500` |
| `signature` | number[64] | **required** (L, D137): the session key's proof of possession, Ed25519 over `"hana-id-session-v1:" ‖ u64le(0) ‖ sha256("hana-id-create-v1:" ‖ sha256(session nonce preimage))`; relayed as `create_session`'s `signature` (contract v3 requires it, v2 ignores it) |

The scope is always the app's (D1). Checks after the gate and shape (`400 bad_request`):

1. An email token (L): "Email tokens" below (`401 invalid_token`, `400 unsupported_issuer`, `400 token_expired`,
   `503 issuer_key_pending` + `retry-after: 30`, `401 token_stale`, `502 near_unavailable`, `403 login_method_disabled` for an app whose
   `login_methods` doesn't list `email`, `503 config_unavailable`). A Google token: RS256 against Google's JWKS, `iss` → provider, `exp` + 60 s skew: `401 invalid_token`, `400 unsupported_issuer`,
   `400 token_expired`, `503 issuer_keys_unavailable` (`verifyIdToken`, `packages/oidc`); an `exp` that isn't a
   finite number is `401 invalid_token`. `email`, `email_verified`, `iat`, `hd`, `azp`, `amr` and `auth_time` are
   not read, and one of the wrong JSON type is ignored, not refused (D201). A valid signature's `kid` is recorded once per isolate after the
   response (`issuer_key_observations.first_token_ms`, here and on `/v1/login`; the kid only, never the token).
2. Claim allow-list, always (D271; a Google token only, an email token is held to its own claims):
   `iss azp aud sub iat exp nonce nbf jti auth_time at_hash` (`at_hash` since D342: the hash of an access token issued
   with the ID token, nothing personal), else `400 token_has_pii` with `data: {claim}`, before any chain read; nothing
   is relayed.
3. `nonce` equals the session nonce recomputed with `SIGNER_ACCOUNT` and the app's scope (`400 nonce_mismatch`).
3b. (L) `signature` verifies as the proof of possession for exactly these parameters (`401 invalid_signature`): only
   the session key's holder can open a session, and a proof seen once can't open the key with other parameters.
3c. (L, D250) The same request already refused by the chain for `link_pending` or `identity_linked` in this isolate in
   the last 60 s is answered the same way, without a relay. Beside step 4's reads, once links can exist
   (`get_config().links_open`): the session identity's `get_identity`; a pending member is `409 link_pending` (fails
   open when it can't be read).
4. Side by side: client → scope (`403 scope_mismatch` / `unregistered_client` / `unknown_scope` /
   `shared_login_disabled`), `session_key_in_use` (`409 session_exists`), and the governance gate (G, below); read
   failure `502 near_unavailable`. Reported in that order.
5. The app's relay quota (`429 rate_limited` + `retry-after`), counted only here.

→ `200 {"result": {"path", "scope_id", "expires_at_ms", "max_uses", "used"}, "nearTx", "requestId", "supportId"?}`.
`supportId` (C15, D395): the user's Support ID `HANA-XXXX-XXXX`, from the account root of the new session's `path`,
computed exactly as the wallet directory stores it (`directory/store.ts` `sessionSupportId`); absent when
`USER_ID_KEY` or `IDENTITY_SUB_KEY` is missing or malformed. Never the User ID, a sub or the internal id. Usage event:
`session` (uid from the new session's `path`).
With an email token also `email_usage.email_sessions` (L, copied hourly to the ledger, D233). A failed relay's
email-login panics are answered as in "Relay errors" (`409 link_pending` for a pending member).

**Governance gate (G, `handlers.ts` `chainGate`; also on `/v1/login`, and the pause part on `/v1/derive`).** The
contract would refuse these, so nothing is relayed:

| Status | Code | Body extra | `retry-after` | When |
|---|---|---|---|---|
| 503 | `paused` | `retryAfterS: 60` | 60 | `get_config().paused` (only the owner multisig unpauses) |
| 503 | `issuer_key_pending` | `retryAfterS: 30` | 30 | the token's `kid` is in Google's JWKS (it verified) but not an active key on chain: still in its issuer-key delay, waiting for a watchdog's confirmation or for the cron to execute it (`docs/governance-spec.md` "Rotation and logins" step 3). Also when the contract has no such issuer |

Reads: `get_config` (cached 60 s, 10 s while paused, shared with the scope check) and `get_issuer(provider)`
(cached 60 s; a kid not in the cached set re-reads it at most once per 10 s per isolate, concurrent misses share one
read). Fail open: when either read fails the request goes on and the contract decides (these checks only save the
relayer a doomed transaction). The vault retries an `issuer_key_pending` login once after `retryAfterS` (at most
30 s, with `loginProgress: key_pending` meanwhile), else ends it with `api_unavailable` ("try signing in again"). `revoke_session` works while
paused and is never gated.

### `POST /v1/derive` — relays `derive_key` (session pool)

Body `{sessionPublicKey: number[32], counter: integer ≥ 1, signature: number[64], pk1: "bls12381g1:…", pk2:
"bls12381g2:…"}` (each point < 300 chars), else `400 bad_request`.

1. Ed25519 by `sessionPublicKey` over `"hana-id-session-v1:" ‖ u64le(counter) ‖ sha256("hana-id-ckd-v1:{pk1}:{pk2}")`
   (`401 invalid_signature`). Then pk1/pk2 each one compressed, non-identity point of 48 / 96 bytes, always, as on
   `/v1/login` (`400 invalid_app_key`; D100, security sweep APIW-4).
2. A second request for the same session counter in the same isolate waits for the first.
3. Session pre-check (`src/session-use.ts`, mirrors the contract), on `get_session` (cached 10 s; a cached refusal is
   re-judged on a fresh read):

| Status | Code | When |
|---|---|---|
| 404 | `unknown_session` | no session, or expired |
| 403 | `scope_mismatch` | session in another scope |
| 409 | `session_exhausted` | `used = max_uses` |
| 409 | `counter_used` | `counter ≤ used` (replay); body has `nextCounter = used + 1` |
| 409 | `counter_out_of_range` | `counter > max_uses`; body has `nextCounter` |
| 502 | `near_unavailable` | session read failed |

   A counter ahead of `used + 1` is relayed (earlier ones may be in flight).
4. `503 paused` (G) while the contract is paused (`derive_key` panics `Paused`); see the governance gate above.
5. Only with `BLS_PRECHECK = "1"`: pairing check `e(pk1, −g2) · e(g1, pk2) = 1` (`400 invalid_app_key`).
6. The app's relay quota (`429 rate_limited` + `retry-after`), counted only here.

→ `200 {"result": {"big_y": "string", "big_c": "string"}, "nearTx", "requestId"}`. Usage event: `derive` (uid from the
session's `path`); a revoke's is `revoke` (no uid).

### `POST /v1/sessions/revoke` — relays `revoke_session` (session pool)

Body `{sessionPublicKey: number[32], counter: integer ≥ 1, signature: number[64]}`; payload `"revoke"`. Same checks as
derive, except no `session_exhausted`, and the last usable counter is `max_uses + 1`. → `200 {"result": null, "nearTx",
"requestId"}`.

### `POST /v1/login` — relays `create_session_and_derive` (session pool) · B

One transaction per login. Called by the vault and the export window (`AUTH_ORIGIN`), never by partner pages.

Body: exactly the `/v1/sessions` fields (without the proof of possession) plus `signature: number[64]` (session
signature over counter 1 of the CKD payload), `pk1`, `pk2`, and for email login's automatic link (L, D133)
`linkJwt` (an email token) and `linkImmediate` (a boolean, only with `linkJwt`), and from the export window only
`exportChain` (`"stellar"`, `"evm"` or `"near"`, D430, D759: a label for the `key_exported` event, never relayed, not in
the nonce or the CKD payload; from any other page `400 bad_request`; an API before D759 refuses `"near"`, which is why
the export window sends it only when `GET /v1/app` lists it in `walletChains`). Any other field: `400 bad_request`.
Without `linkJwt` the relayed arguments are batch B's exactly; with it, `link_jwt` and `link_immediate` are added, the
signature must be over the **linked CKD payload** `"hana-id-ckd-link-v1:" ‖ sha256(linkJwt) ‖ u8(linkImmediate) ‖
pk1 ‖ ":" ‖ pk2`, and the gas is 250 Tgas. `jwt` is a Google or an email token ("Email tokens" below).

Checks, in order: gate (relay kind) → shape → token (as `/v1/sessions`) → claim allow-list, **always on**
(`400 token_has_pii` + `data: {claim}`) → nonce → in-isolate hold on (key, counter 1) → scope and
`session_key_in_use` side by side → signature over counter 1 (`401 invalid_signature`) → pk1/pk2 each one compressed,
non-identity point of 48 / 96 bytes (`400 invalid_app_key`) → pairing only with `BLS_PRECHECK = "1"` → the app's relay
quota (`429 rate_limited`, counted only for a request that got this far). The governance
gate (G: `503 paused`, `503 issuer_key_pending`, with `retry-after`; see `/v1/sessions`) runs beside the scope and
`session_key_in_use` reads and answers after them. With `linkJwt` (L, D232), after the signature: the link token
verified (an email token of the app's scope, `403 login_method_disabled` / scope codes as for `jwt`), then the link
precheck from fresh chain reads (`get_config`, `get_identity` and `get_account` of both identities), in the contract's
order (`links.rs` `auto_link`): `409 links_unavailable` (the contract is before v3, or the owner hasn't accepted the
pre-v3 wallets, D135), `409 link_pending` (either identity is a pending member), `422 link_refused` with `reason`
`same_identity`, `already_linked`, `both_wallets`, `link_mismatch` (the token's `auto_link` nonce doesn't commit to
this login, its join, the target account's epoch or the mode), `unlinked`, `account_full` or `provider_taken`;
`502 near_unavailable` when a read fails. An export (`AUTH_ORIGIN`) never carries a link (`400 bad_request`). From
`AUTH_ORIGIN` (a key export) the export limit comes right after the nonce check: `429 rate_limited` with
`retry-after` once 3 exports of that user path in that app were counted this hour, `503 rate_limiter_unavailable` if
the limiter can't be reached; nothing is relayed in either case.

→ `200`:

```json
{ "result": { "big_y": "string", "big_c": "string" },
  "session": { "scope_id": "string", "expires_at_ms": 0, "max_uses": 0, "used": 1 },
  "nearTx": "string", "timings": { "totalMs": 0, "phases": { "app": 0, "…": 0 } }, "requestId": "string",
  "supportId": "HANA-XXXX-XXXX" }
```

`session` is informational; `timings` is there for `pk_test_` apps only (see "Timings" below). `supportId` (C15,
D395; optional, additive) is the user's Support ID from the account root whose path the session opens: a member's
root, or with an automatic link the root the link precheck judged (case A: the link identity's account root; B and C:
the session identity's); the same code `end_users.support_code` holds. Absent when either key is missing or malformed,
or when the login's `get_identity` standing read failed (the fail-open guess). The vault keeps it with the session
(`hana_status.supportId`, `docs/integration.md`). Failures, by the
failing receipt's executor:

| Status | Code | Meaning |
|---|---|---|
| 422 | `contract_rejected` (+ `reason: "session_key_in_use"` for that panic) | signer receipt failed; nothing was created |
| 409 / 422 | the email-login panics (L): `links_unavailable`, `identity_linked`, `link_pending`, or `contract_rejected` + a link `reason` ("Relay errors") | signer receipt failed; nothing was created |
| 422 | `ckd_failed` + `session: {used: 1}` | MPC receipt failed; the session **is** committed with its one use spent |
| 502 | `near_error` | another receipt, or none identified |

Usage event: `login` (uid from the login's path on success; `ckd_failed` is a rejected, relayed event: its gas was
burnt). An export's success (`AUTH_ORIGIN`, D430) also writes a `key_exported` row in `user_events` after the answer:
the account's internal id (`hu_…`, from the root whose path the session opened), the app, `exportChain` (or null) and
the time; no key, token or path. A failure is only logged (`key_export_unrecorded`, with the app and a code). Before
migration 0019 the table's CHECK refuses `chain = 'near'`: the row is then written with no chain, as an older export
window's, and `key_export_chain_dropped` (`near_chain_unsupported`) is logged (D759).
With an email token also `email_usage.email_sessions`, with a link `email_usage.links` (L, on success; copied
hourly to the ledger's `usage.email_counts`, D233).

### Email tokens · L

The email issuer's tokens (`apps/email-issuer`, JWS General JSON Serialization), on `/v1/sessions`, `/v1/login` (`jwt`
and `linkJwt`) and the link relays, checked as the contract will check them (`src/email-token.ts`, D231), before
anything is relayed:

1. `EMAIL_ISS` set (`400 unsupported_issuer` otherwise: no email issuer in this env) and the token exactly in the
   issuer's form, `{"payload":…,"signatures":[{"protected":…,"signature":…}]}` as `JSON.stringify` writes it (no
   whitespace, no unknown or duplicate member, no flattened form, no unprotected header), ≤ 7168 bytes, 1–3 signatures
   with distinct kids, each protected header `{alg: RS256, kid}` without `crit` (`401 invalid_token`).
2. Claims: `iss` equal to `EMAIL_ISS` (`400 unsupported_issuer`), exactly the issuer's set `iss aud sub iat exp nonce
   jti` (no address claim), `sub` 1–255 bytes without `#`, `aud` 1–256 bytes, `exp` + 60 s skew (`400 token_expired`).
3. Each signature RS256-valid with its kid's key in `EMAIL_PUBLIC_KEYS` (the manifest's `emailIssuer.publicKeys`, the
   keys the issuer's JWKS serves; never fetched) (`401 invalid_token`).
4. The signer policy on chain, `get_self_issued("email")` (cached 60 s; an unlisted kid re-reads it at most every
   10 s per isolate): every kid listed under one of its signers, else `503 issuer_key_pending` (`retryAfterS: 30`)
   when a pending change adds it (`get_key_changes`, cached 10 s: the key is still in its delay) and `401 token_stale`
   otherwise (removed, a dropped signer's, or a token only an overlap's previous policy accepts, D250); at least
   `required` distinct signers (`401 invalid_token`, "Not enough signatures"); no policy (`null`) is `400
   unsupported_issuer`, a contract without the view (v2) `502 near_unavailable`.
5. The app's `login_methods` lists `email` (`403 login_method_disabled`; D1 failure `503 config_unavailable`), except on
   `/v1/link/cancel` and `/unlink`, which take an email token whatever it says (D250).

Then the caller checks `aud` against the scope (`scope_for_client("email", aud)`: the scope's client
`email:<scope_id>`; an email client is never shared) and the nonce, as for a Google token. The governance gate's kid
check is the policy check above; its pause check runs as for Google.

### Link relays (`/v1/link`, `/v1/link/cancel`, `/v1/link/unlink`) · L

Explicit linking and its undo (`docs/email-login-spec.md` "Explicit linking", "Unlink and cancel"; `src/links.ts`,
D232). From the vault or the auth origin's pages only (`x-hana-parent-origin` an origin of the app), never a partner
page; gate kinds `link` and `link-change` (their own per-IP windows, "Rate limits"); session pool. Bodies, exactly
these fields (`400 bad_request` otherwise):

| Endpoint | Body | Relays | Gas |
|---|---|---|---|
| `POST /v1/link` | `{accountJwt, newJwt, epoch: u64, salt: number[16..64]}` | `link_identity(scope_id, account_jwt, new_jwt, epoch, salt)` | 250 |
| `POST /v1/link/cancel` | `{jwt, memberKey: 64 lowercase hex, epoch, salt}` | `cancel_link(scope_id, jwt, member_key, epoch, salt)` | 150 |
| `POST /v1/link/unlink` | `{jwt, memberKey, epoch, salt}` | `unlink_identity(scope_id, jwt, member_key, epoch, salt)` | 150 |

Checks, in order: every token verified (Google or email, as for `/v1/login`; a nonce required) and a client of the
app's scope; the governance gate (paused, a Google kid active); then the contract's rules from fresh chain reads
(`get_identity` and `get_account` of the token identities), each refusal answered and nothing relayed:

- `/v1/link`: `409 links_unavailable` (pre-v3, or `unrecorded_wallets`); the `link_new` nonce of `newJwt` and the
  `link_account` nonce of `accountJwt` over the account's root, the new identity, `epoch` and `salt`
  (`422 link_refused` `link_mismatch`); then `same_identity`, `409 link_pending` (the account token's identity is a
  pending member), `has_wallet` (the new identity derived its own path once), `already_linked`, `account_full`,
  `provider_taken`, `stale_epoch`.
- `/v1/link/cancel`: the member must be a pending member of the acting identity's account (`no_such_member`), the
  `link_change` "cancel" nonce (`link_mismatch`); by the member itself or an active identity of the account (`409
  link_pending` for a pending one); `stale_epoch`. Not gated on `unrecorded_wallets` (nor is the contract).
- `/v1/link/unlink`: an active member of the acting identity's account (`no_such_member`, `cannot_unlink_root` for the
  root), the `link_change` "unlink" nonce, by the root or the member itself (`not_allowed`), `stale_epoch`.

Then the claim and the limits (D250, D252): one relay per set of tokens (sha256 of them reserved in the `link-tokens`
object for 10 minutes, released when the relay certainly didn't execute; a duplicate is `409 link_in_flight`); per
account root (`link-root:<scope>:<root ik>`) 3 adds a minute and 20 a day, 10 removals a minute and 100 a day; per app
30 adds a minute and 1000 a day; across apps 5000 adds a day (`link-global`); all `429 rate_limited` above. The app's
removal windows (60 a minute, 2000 a day) only log `link_changes_high`, never refuse. Then the relay (gas per "Relayer
pools and gas"), and on success the account's vault shares are revoked in every app of the scope (a convenience that
signs other devices out, not a security boundary: security.md) (those of the account root's path at `key_index` 0..63, D233; logged `link_shares_revoked` with a
count, a failure `link_shares_revoke_failed`, never failing the answer). → `200 {"result": {"effectiveAtMs"}, "nearTx",
"requestId"}` for `/v1/link` (when the link becomes active), `{"result": null, …}` for the other two. Usage: a link
(`email_usage.links`) for `/v1/link` only; every request past the gate is one usage event (endpoints `link`,
`link_cancel`, `link_unlink`, with its relay facts; migrations-usage 0005). Failed relays as in "Relay errors".

### `/v1/login-relay/<relayId>` — Durable Object `LoginRelay` · B

Hands the end-to-end encrypted Google token from `/login/callback` to the vault. No `x-hana-key`. `relayId` is 43
base64url characters (`400 bad_relay_id`), `= b64url(sha256(readKey))`. Wrong origin: `403 origin_not_allowed`; other
methods: `405`. Per-IP limits as above (`429 rate_limited`, `503 rate_limiter_unavailable`).

| Request | Origin | Body / headers | Responses |
|---|---|---|---|
| `POST` | `AUTH_ORIGIN`, `VAULT_ORIGIN` (batch 8b) | `{iv, ct}` only, base64url; iv 12 bytes, ct ≥ 16 bytes, body ≤ 12 KiB (the clients encrypt at most 9000 bytes) | `204`; `409 relay_used` if ever written; `503 relay_unavailable` |
| `GET ?wait=<1..25>` (absent = answer at once) | `VAULT_ORIGIN`, `AUTH_ORIGIN` | `x-hana-relay-key: <b64url of 32 bytes>` | `200 {iv, ct, serverTimeMs, heldMs}` (consumed; `heldMs`: how long the value sat in the slot before this read, on the object's clock: a duration, never the write's time); `204` still empty after `wait` s; `410 relay_gone` read or expired; `403 relay_forbidden` missing/wrong key (slot untouched); `400 bad_request` bad `wait`; `503 relay_unavailable` |

The value lives 120 s after the write, then a tombstone answers 410 for 120 s more, then the object is empty. Only
ciphertext is stored; bodies, keys and relay ids are never logged. For a `pk_test_` app the encrypted payload also
carries the login popup's stage durations (`timings` beside `idToken` or `error`, at most 8 numbers, `@hana-id/core`
`relay.ts`); the API can't read them any more than the token.

A login of an app with email (batch 8b, D256) also uses **follow-up slots**: ordinary slots whose ids derive from a
`followKey` only the vault and its popup hold (`@hana-id/core` `links.ts` `followSlot`), the vault writing its notices
(google-match's screens, link banners, its last word) and the popup its answers (Google's access token, a link token, a
proof), each slot written once and read once by the other side, each value AES-GCM under the login's `relayKey`. The
API sees only ciphertext and slot ids; a writer can't forge a value without `relayKey`.

### `GET {VAULT_ORIGIN}/vault?pk=<publishable key>` · B

Served only when the request URL's origin is `VAULT_ORIGIN` (elsewhere the path falls through to `404`). D1 only, no
RPC. HEAD gives the same status and headers without a body.

`200` HTML with `<script type="application/json" id="hana-config">` holding

```json
{ "v": 1, "appId": "string", "appName": "string", "scopeId": "string", "origins": ["string"],
  "settings": { "persistence": "session" | "none", "sessionTtlMs": 0, "idleTtlMs": 0,
                "rawSign": "off" | "approval", "autoApprovePolicy": {} | null, "mainnetDemo": true },
  "publishableKey": "string", "serverTimeMs": 0 }
```

(`<`, `>`, `&`, U+2028, U+2029 escaped; no `signer`), then `<script type="module" src="/vault.js">`.
`settings.mainnetDemo` (D428) is present, `true`, only when `GET /v1/app` would serve `mainnetDemo: true` (a dev
testnet env, a test scope, the switch on); otherwise the key is absent, so a vault bundle older than the field never
sees it. The vault tells the SDK early (its `mainnetDemo` port event) and re-reads `GET /v1/app` before signing. Pending
`raw_sign` / auto-approve values apply from their `*_effective_at`. `origins`: the app's origins that are bare
lowercase http(s) origins, loopback ones only for `pk_test_` in dev envs, sorted.

Headers: `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors <origins | 'none'>; connect-src <API_URL origin>
<NEAR_RPC origin> [<NEAR_RPC_FALLBACK origin>] https://www.googleapis.com [<EMAIL_ISSUER_URL origin>]` (the issuer only when it isn't the API's own origin: the vault calls google-match, batch 8b; a malformed `EMAIL_ISSUER_URL` is a `503 misconfigured` page), `cross-origin-resource-policy: cross-origin`, `cache-control: no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`.

Errors are an empty HTML page with `frame-ancestors 'none'` and no config: `403` (`unknown_app`, `app_suspended`,
`scope_conflict`, `too_many_origins` > 20), `503` (`config_unavailable`, `misconfigured` when `API_URL` or `NEAR_RPC`
is missing or not a URL, or `NEAR_RPC_FALLBACK` is set but not a URL). The code is in the log line, not the body.

### Page Workers (`src/pages/`) · B

One thin Worker per Hana origin in every env (D66; `workers.dev` in dev envs, a Custom Domain elsewhere;
`apps/api/scripts/pages-wrangler.ts`), each with only its origin's built pages as static assets
(`packages/web/dist/pages/<env>/vault`, `…/auth`). Only `GET`/`HEAD` (`405` otherwise), only on their own origin
(`404` on any other host).

| Origin | Path | Response |
|---|---|---|
| vault | `/vault` | forwarded to the API Worker (service binding `API`), unchanged but for a `Set-Cookie` header, which is dropped; `503` page with no config if it is unreachable |
| auth | `/login/callback` | `login/callback.html` with `frame-ancestors 'none'; connect-src <API_URL> [https://oauth2.googleapis.com]` (Google's tokeninfo only when `EMAIL_ISSUER_URL` is set and valid: under `'token_first'` the callback reads the access token's `sub` there, D270; the built page's `<meta>` policy lists the same, `packages/web/src/auth/pages.ts`) |
| auth | `/login`, `/approve` | `<path>.html` with `frame-ancestors 'none'` (neither fetches anything; the login popup makes no API call, D77) |
| auth | `/share-email` | `share-email.html` with `frame-ancestors 'none'; connect-src <API_URL>` (D411, D442: the email sharing sheet reads the sealed address from `/v1/identity/email-consent/preview`, nothing else) |
| auth | `/home` | `home.html` with `Cross-Origin-Opener-Policy: same-origin-allow-popups` (D558; no other auth page sends COOP) and `frame-ancestors 'none'; connect-src <API_URL> <NEAR_RPC> [<NEAR_RPC_FALLBACK>] https://www.googleapis.com [<EMAIL_ISSUER_URL>]` (Hana Home, H7, H8 and H10, D551, D583, D622: `/v1/home/*`, the login relay's read, Google's JWKS for its own token check, the NEAR RPC origins, read only when the user opens a wallet, and in an env with an email issuer the issuer's Home route, `resend` and `verify` for its email sign-in: `/export`'s list plus the issuer; a malformed `EMAIL_ISSUER_URL` is left out, so only the email sign-in fails, D669) |
| auth | `/home/callback` | `home/callback.html` with `frame-ancestors 'none'; connect-src <API_URL>` (H10, D491, D619: Hana Home's exit Google client's only redirect URI; it relays an ID token of that client with the nonce its sign-in child stored, to the login relay, and closes; no COOP, no logo) |
| auth | logo pages: `/login`, `/login/email`, `/approve`, `/export`, `/share-email`, `/home` | with `FILES_ORIGIN` set (the manifest's `files.origin`, C11, D306), the base policy's `img-src 'self' data:` becomes `img-src 'self' data: <FILES_ORIGIN origin>` (in place, one `img-src`); the build's `<meta>` policy does the same from `HanaEnv.filesOrigin`. `/login/callback` never. A `FILES_ORIGIN` that isn't an origin is left out and logged (`files_origin_misconfigured`), the page still served |
| auth | `/login/email` | `login/email.html` with `frame-ancestors 'none'; connect-src [<EMAIL_ISSUER_URL origin>] <API_URL>` (the email step, batch 8a: the issuer's `start`, `resend`, `verify` and the relay write; the auth Worker's `EMAIL_ISSUER_URL` is set by `gen` from `emailIssuer`, and a malformed one is a `503` page) |
| auth | `/export` | `export.html` with `frame-ancestors 'none'; connect-src <API_URL> <NEAR_RPC> [<NEAR_RPC_FALLBACK>] https://www.googleapis.com` |
| both | `/.well-known/hana-build` | `{"build": "<id>" \| null}` (D384): the build id this Worker was deployed with (`HANA_BUILD`, set only by `deploy:pages`; `null` when unset or not an id), `application/json`, `no-store`, the 404's headers (`frame-ancestors 'none'`, `nosniff`); never reaches the assets or the API |
| both | any other path | a static asset, never HTML (`*.html` and `text/html` → `404`) |

Pages carry the base policy plus their directives, `no-store`, `no-referrer`, `nosniff`, no COOP; a missing page file
is a `503` page. The bundles carry the build id of the web build that made them (D384): `/vault.js` starts with
`/* hana-build <id> */`, each auth page has `<meta name="hana-build" content="<id>">` (the auth scripts' content
hashes don't depend on it). Every asset carries `content-security-policy: default-src 'none'; frame-ancestors 'none'; sandbox`
(an SVG or XML file opened as a document runs, loads and frames nothing; not applied by browsers to the scripts and
styles the pages load), `nosniff`, `no-referrer` and `cross-origin-resource-policy: same-origin`.

**No cookies (D70).** No response of the API Worker or of either page Worker sets a cookie; the page Workers drop a
`Set-Cookie` header from what their bindings answer (`withoutCookies`, `src/pages/host.ts`). Tests:
`apps/api/test/no-cookies.test.ts` (every endpoint and page), `packages/web/test/no-cookies.test.ts` (no source sets
one) and the Playwright suite (every Hana response of every flow).

### Vault endpoints · B

All `POST`, `Origin: VAULT_ORIGIN`, `x-hana-key`, `x-hana-parent-origin`. No transaction. Signatures are Ed25519 by
the session key over `"hana-id-vault-v1:" ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(appId) ‖ shareId(16) ‖ u64le(counter) ‖
sha256(payload)`, `appId` = the D1 `apps.id` (`docs/contract-interface.md`, "Vault message").

Gate, in order: `401 missing_key` / `unknown_app` / `503 config_unavailable` → `403 app_suspended` → Origin is
`VAULT_ORIGIN` (`403 origin_not_allowed`) → parent allowed (`403 origin_not_allowed`) → `403 scope_conflict` → vault
limits (per IP, then per app) → body (`400 bad_request`) → share actions: the per-share limit. Storage errors:
`503 config_unavailable`. Missing `VAULT_KEK`: `503 vault_key_unavailable`.

The app row comes from a per-isolate cache (`src/app-cache.ts`, D78): an entry serves for 30 s after its D1 read, so
a suspension, a revoked key, a removed origin or a scope conflict reaches these endpoints within 30 s per isolate. It
caches the origins in force at the read, so a pending origin is never served early; one that comes into force is
served from the next read, within 30 s (D208) (unknown keys and failed reads are never cached; at most 256 apps). Nothing else uses it: the app gate above
(relay endpoints, `GET /v1/app`) and the vault page read D1 every time. The per-IP and per-share limits are Rate
Limiting bindings, checked in the Worker's location with no network hop; the per-app quota is the one limiter object
call (`app:<id>`), made only once the IP limit accepted (D95).

| Endpoint | Body | Payload | 2xx |
|---|---|---|---|
| `/v1/vault/shares` | `{sessionPublicKey: number[32], signature: number[64], deviceLabel?: string}` (exactly) | `"share" ‖ borsh(parentOrigin)`, shareId 0×16, counter 0 (`deviceLabel` is unsigned) | `201 {shareId: number[16], ks: number[32], absExpiresAtMs, idleUntilMs}` (+ `timings`, `pk_test_` only) |
| `/v1/vault/unlock` | `{shareId: number[16], counter: integer ≥ 1, signature: number[64]}` (exactly) | `"unlock"` | `200 {ks: number[32], counter, idleUntilMs, absExpiresAtMs}` (+ `timings`, `pk_test_` only) |
| `/v1/vault/touch` | same | `"touch"` | `200 {counter, idleUntilMs}` |
| `/v1/vault/revoke` | same | `"revoke"` | `200 {revoked: true}` |
| `/v1/vault/revoke-all` | same | `"revoke-all"` | `200 {revoked: <number of the same user's other live shares in this app>}` |
| `/v1/vault/consents` (H4) | `{shareId?: number[16], sessionPublicKey: number[32], counter, signature: number[64], consentId: number[16], policyId: number[32], expiresAtMs}` (exactly) | `"consent" ‖ consentId ‖ policyId ‖ u64le(expiresAtMs) ‖ borsh(parentOrigin)` | `201 {counter, grantedAtMs, expiresAtMs}` |
| `/v1/vault/consents/revoke` (H4) | `{shareId?, sessionPublicKey, counter, signature, consentId}` (exactly) | `"consent-revoke" ‖ consentId` | `200 {revoked: bool, counter}` |

`deviceLabel` (D512): at most 40 characters of letters, digits and ` .()/_-`, starting with a letter or digit; anything else
is stored as null and never refuses the login. Hana Home shows it as text, on the row deleted with the share. The vault sends
"{browser} on {system}" from the User-Agent's families only (`packages/web/src/vault/device-label.ts`, H9, D611), or none.

Consents (`src/vault/consents.ts`, `consent-store.ts`; `docs/hana-home-spec.md`; narrow-only: a row can stop auto-signing, never
start it). `shareId` present is `'session'` mode (`counter` ≥ 1, signed under that share id); absent is `'none'` mode
(`counter` exactly 0, signed under shareId 0×16). Register, after the gate and the per-IP and app limits: `401 invalid_signature`
→ the per-share window (10/min, `429 rate_limited`, in `'none'` mode under the session key; only a signed request spends it, D510)
→ the identity token's share check (`checkShare`: `410 session_ended` with `reason` `unknown_share`, `share_revoked`,
`persistence_off` or `share_expired`; a session key with a share in another app is refused whatever this app's
persistence, D178) → `shareId` must be this session's share, or absent exactly when there is none (`404 unknown_share`) →
`'none'` mode: `checkChainSession` with one read at most (`503 session_not_visible` with `retry-after: 1` when the chain
doesn't show the session yet: the vault tries again and nothing ends, D513; `410 session_ended`, `403 scope_mismatch`,
`502 near_unavailable`) → `409
policy_not_in_force` → `400 bad_expiry` (after now, at most the share's capped end, or the chain session's expiry in
`'none'` mode; an end past that cap also gets `maxExpiresAtMs`, the cap, D535) → `409 consent_exists` on a repeated id → `429 too_many_consents` when the session key already holds 20 rows (D513)
→ one D1 batch: revoke the session key's previous consent (`revoked_by
= 'device'`), insert, and in `'session'` mode move the counter, every statement conditional on the share being live at
`counter - 1` (`409 bad_counter` with `expected`, `410 share_expired`, `410 share_revoked`, `404 unknown_share`). The
label is the policy in force's own, from the server. Revoke, after the gate and the IP and app limits: `401 invalid_signature`
→ the same window → `404 unknown_consent` (not in this app, or not this session key's and share's: the same answer) → `'session'` mode: one batch
that moves the counter and revokes on the same condition (a dead share's own refusal: D513), `'none'` mode: an update, a
repeat changing nothing. Works without a `get_session`, so an expired session can still revoke. No chain read in `'session'`
mode; one `get_session` view in `'none'` mode. In `'none'` mode the primary key is the replay check, so a revoked row stays
until it expires (D510).

`shares`, after the gate: `409 persistence_off` → `401 invalid_signature` → `get_session` straight from the node,
re-read every 300 ms for up to 2 s while missing or not used up (`404 unknown_session`, `403 scope_mismatch`,
`409 session_not_spent`, `502 near_unavailable`) → insert (`409 share_exists`: one share per session key).
`absExpiresAt = min(session expiry, now + session_ttl_ms)`, `idleUntil = min(now + idle_ttl_ms, absExpiresAt)`.

Share actions, after the gate (per-share limit included) → `404 unknown_share` (missing or another app's) → share's origin no
longer allowed: revoked, `410 share_revoked` → unlock and touch only, the app's settings as they are now: persistence
`none` revokes the share (`410 share_revoked`), and the share ends at `min(abs_expires_at, created_at +
session_ttl_ms)` (a lowered TTL also lowers the stored `abs_expires_at`; `410 share_expired` once past it) →
`401 invalid_signature` (counter not consumed) → `revoke-all` only: `403 share_not_fresh` (share ≥ 5 min old) → one
atomic update that needs `counter = stored + 1` and a live share (for unlock and touch it re-checks persistence and
the TTL cap in the same statement): `409 bad_counter` with `expected`, `410 share_expired`, `410 share_revoked`.
Unlock unwraps K_s before the counter moves, re-wraps it under the current KEK if the row is under
`VAULT_KEK_PREVIOUS`, slides `idle_until` to `min(now + idle_ttl_ms, the capped expiry)`, returns the capped
`absExpiresAtMs` (usage event `unlock`, never relayed, no uid); an unreadable row is `500 internal`. Touch slides `idle_until` the same way.
Revoke and revoke-all ignore the settings. Revoke-all keeps its own share live and runs as one D1 batch (one
transaction): the other shares are revoked only on the condition the counter move then meets, so a failed write
changes nothing and a replay revokes nothing.

`POST /v1/vault/share-status` (D680, D690) `{shareId: 16 bytes}` → `200 {share: 'live' | 'revoked', serverTimeMs}`,
`cache-control: no-store`: whether Hana Home (or anything else) took the share away, so a tab already open ends; the same
rule as `GET /v1/app`'s `share` (`shareStatus`: `revoked` for no such share of this app, revoked, the app no longer keeping
logins, or the share's own recorded origin no longer allowed; time-based ends not reported). In order, apart from the share
actions' windows and the vault's per-IP window: 600 a minute per IP subject across all apps (binding
`VAULT_STATUS_IP_LIMIT`, key without the app, asked before any D1 read; a ceiling for a NAT: a neighbour behind the same IP,
counted in the same Cloudflare location, can use it up, as with the unlock's per-IP window); the vault gate above (app from
the isolate cache, `Origin: VAULT_ORIGIN`) but **not** the caller's `x-hana-parent-origin`, since the answer depends only on
the share's own origin: a tab on an origin the partner removed reads `revoked` and ends, and the header can't make it answer
about another origin; the body (`400 bad_request` unless exactly `{shareId}`); 30 a minute per share (binding
`VAULT_STATUS_SHARE_LIMIT`). Refusals: `429 rate_limited` with `retry-after: 60`, `503 rate_limiter_unavailable`, the gate's
401/403/503, `503 share_status_unavailable` (D1). The share id is the secret (128 random bits), no session proof; the Origin
check only binds browsers (D690). No chain call, no app quota, no usage event; one D1 statement and 2 rows read once the app is
cached, so one IP can cause at most about 600 statements a minute per location (up to 1 800 with made-up keys, whose app
lookup is never cached); it writes and slides nothing (D539). The vault reads it about once a minute in an active shown tab with a share and no policy (every 5 minutes
when idle), before an approval signature or a cached identity token when its last `live` is over 60 s old (D682, D692), and
as the fallback of a policy app's `GET /v1/app`; any refusal or a read over 15 s is no answer to it, never `revoked`. An API
without the route answers `404 not_found` without CORS headers, so a browser sees a failed preflight: the vault then uses
`GET /v1/app` for 30 minutes before trying the route again (D693).

### `POST /v1/mainnet-demo/events` — a mainnet demo signature (D428)

From the vault page only (`Origin: VAULT_ORIGIN`, `x-hana-key`, `x-hana-parent-origin`, as `/v1/vault/*`; the vault
limits apply), and proven by the session that signed (as `/v1/identity/token`, after the security review of 2026-11-06). Body, exactly:
`{chain: "evm" | "stellar", network: "8453" | "pubnet", kind: "evm_tx" | "stellar_tx", usdMicros, sessionPublicKey:
number[32], issuedAtMs, nonce: number[16], signature: number[64], walletProof: {address, signature}}` (`usdMicros` a
decimal string, at most the cap 9990000). Checks, in order: the shape; `issuedAtMs` within ±60 s (`400 stale_proof`);
the session key's Ed25519 signature over `identityMessage` with `mainnetDemoEventPayload` (the event and the wallet
proof; `401 invalid_signature`); the demo on (`409 mainnet_demo_off`); the wallet proof by the address's own key for
this session key and app (`400 bad_wallet_proof`: another user's address can't be named); the session live on chain in
the app's scope (`410 session_ended`, `403 scope_mismatch`); the proof unused (`409 proof_replayed`, a single-use
marker per session key); the app's hourly cap. Stores a `mainnet_signature` row with the session's user (its account
root's internal id), the address, chain, network and value; no key or signed bytes. That the signature was made is
still the vault's word (the API never sees it); staff see the rows as "reported by the vault".

| Status | Code | When |
|---|---|---|
| 200 | — | `{recorded: true}` |
| 400 | `bad_request` | any other body |
| 400 | `stale_proof` | `issuedAtMs` more than 60 s from the API's clock (with `serverTimeMs`) |
| 400 | `bad_wallet_proof` | the wallet proof isn't the address's own for this session key and app |
| 401 | `invalid_signature` | the session key didn't sign this event |
| 403 | `origin_not_allowed`, `scope_mismatch` | not the vault page, a parent origin the app doesn't allow, or a session of another scope |
| 409 | `mainnet_demo_off` | the app doesn't have the demo on (or the env can't have it) |
| 409 | `proof_replayed` | this session proof was already used |
| 410 | `session_ended` | no live session for the key on chain |
| 429 | `rate_limited` | more than 120 reports for the app this hour (`mainnet_demo:hour`) |
| 502 | `near_unavailable` | the session couldn't be read |
| 503 | `event_unavailable`, `rate_limiter_unavailable` | the write, the directory keys or the limiter failed |

### `POST /v1/wallets/record` — the wallet directory · W

`directory/record.ts` (D310, D313, D755–D757). The vault sends it once after each login, in the background (D317), and,
for an SDK of 0.4.0 or later, once at an unlock until this session's NEAR account is recorded (D756). Body (≤ 4 KiB,
exactly these fields): `{sessionPublicKey: number[32], issuedAtMs, path, wallets: {stellar: {address, signature:
number[64]}, evm: {address, signature: number[65]}, near?: {address, signature: number[64]}}, sessionSignature:
number[64]}`; `wallets` is exactly `{stellar, evm}` or `{stellar, evm, near}`. Each wallet signature is by that
address's own key over the record statement (`@hana-id/core/wallet-record`, D311):

```
"hana-id/wallet-record/v1" ‖ 0x00 ‖ borsh(ENV_NAME) ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(apps.id) ‖ borsh(scope_id)
‖ borsh(path) ‖ borsh(chain) ‖ borsh(address) ‖ session_pk(32) ‖ u64le(issuedAtMs)
```

Stellar: Ed25519 over the statement (strict RFC 8032). EVM: secp256k1 over `sha256(statement)`, `r ‖ s ‖ v`, v ∈ {27,
28}; the address in any case, stored in EIP-55. NEAR (D755): Ed25519 over the statement (strict RFC 8032) by the
implicit account's key, `chain` `"near"`, `address` the implicit account id exactly as 64 lowercase hex characters
(the public key; any other form is `bad_wallet_record`).

`sessionSignature` is the session key's Ed25519 signature (strict RFC 8032) over the whole request (D311 as amended
after a security review: the wallet signatures alone let anyone name a victim's public session key with their own
address):

```
"hana-id/wallet-record-session/v1" ‖ 0x00 ‖ borsh(ENV_NAME) ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(apps.id) ‖ borsh(scope_id)
‖ borsh(path) ‖ session_pk(32) ‖ u64le(issuedAtMs) ‖ sha256("hana-id/wallet-record-proofs/v1" ‖ 0x00
‖ for stellar then evm: borsh(chain) ‖ borsh(canonical address) ‖ borsh(Vec<u8> signature))
```

With a NEAR record the hash is `sha256("hana-id/wallet-record-proofs/v2" ‖ 0x00 ‖ for stellar, evm then near: the same
triple)` (D755): a session signature over two chains never verifies for three, nor three for two.

Checks in order: the vault gate (as "Vault endpoints") → vault limits → body (`400 bad_request`; `413` over 4 KiB) →
`|now − issuedAtMs| ≤ 5 min` (`400 stale_record` with `serverTimeMs`) → `path` is `{app's scope}#provider#sub#key_index`
(`400 bad_request`) → every record verifies (`400 bad_wallet_record` with `chain`) → the session signature verifies
against `sessionPublicKey` (`401 invalid_signature`) → `USER_ID_KEY` and `IDENTITY_SUB_KEY` usable (`503
directory_unavailable`, D346) → `get_session` (cached, re-read fresh before refusing, re-read every 300 ms for up to 2 s while
missing): live and unexpired (`410 session_ended`, `reason: no_session`), the app's scope (`403 scope_mismatch`;
`502 near_unavailable`), its `path` exactly the body's (`403 session_mismatch`) → with a NEAR record, NEAR's rules
(D762): this user already lists another NEAR account at this key index: `409 near_account_mismatch`, nothing written,
logged `directory_near_conflict` at error level; another user of the scope lists this account: the NEAR row is skipped
(below), also logged `directory_near_conflict` → one D1 batch (`503 directory_write_failed` when it fails, e.g. before
migration 0011) → with a NEAR record, the NEAR wallet's upsert on its own (D756: before migration 0019 its CHECK refuses
`near`; that never undoes the batch; logged `directory_near_unrecorded` with `no_migration_0019` or `internal`; a
concurrent second account meets 0019's unique index). `200 {recorded: true}`, plus, when the body had a NEAR record,
`near: true` or `near: false` with `nearCode` ∈ `no_migration_0019`, `near_account_taken`, `near_account_mismatch` (a
race lost to the unique index), `internal`.

What it writes (migration 0011): the user of the path's account root with its three ids (D346: `user_id` the internal
id `hu_…`, D312; `token_sub` the User ID, the identity token's `sub`; `support_code`) with `created_at` the MIN and
`last_seen_at` the MAX of `issuedAtMs`; both wallets (and NEAR's, migration 0019) with `first_seen_at` MIN and
`last_used_at` MAX and the path's `key_index`; the root's identity row (role `root`, `active`). Nothing about the
request is logged but the app, outcome and code; no signature is stored.

**The relayer's lookup (D757).** `directory/near.ts` `nearAccountUser(db, scopeId, accountId): Promise<string | null>`:
the internal id (`end_users.user_id`) of the one user of `scopeId` whose `end_user_wallets` lists `accountId` with
`chain = 'near'`; null when none does, when `accountId` isn't a 64-lowercase-hex implicit id, and when two or more users
of the scope list it (ambiguous, logged `near_account_ambiguous`; never chosen by a time, which a client sets); a
failed read throws. One indexed SELECT of at most two rows (`end_user_wallets_address`, then `end_users`' key).
"Listed" means a live session of that user's account root sent a record whose NEAR entry that account's key signed: the
session's holder held the key, not that Hana derived it (D757, D762). The row exists only once the background
record landed (normally within a second of the login's answer; up to the vault's 15 s abort; missing in an outage or
before migration 0019), so a caller treats null as retryable for a while after a login.

**The identities around it (`directory/sync.ts`, D314)**, written after the answer (`waitUntil`) and never failing or
slowing the request: after a successful `/v1/login` (with a `linkJwt`: `get_identity` of the session identity and
`get_account` of its root, fresh; without one: the login's own standing read, nothing more) and after a successful
link relay (`get_account` of the account root, fresh). Failures log `directory_sync_failed` (`near_unavailable`),
`directory_write_failed` (`no_table` / `internal`) or, at most every 10 min per isolate, `directory_unavailable`
(`no_user_id_key`, `no_sub_key` or `bad_sub_key`).

### Identity token · I

The partner identity token (`docs/identity-token-spec.md`, D120, D127; the `email` claim since D411, D438–D443,
`docs/email-sharing-spec.md`): an ES256 JWT the vault mints for its app and the partner's backend verifies against the JWKS below, without calling Hana.
`src/identity/`. No Hana API accepts the token (below, "Refusals elsewhere").

#### `POST /v1/identity/token` (vault only)

`Origin: VAULT_ORIGIN`, `x-hana-key`, `x-hana-parent-origin`; preflight as the vault endpoints'. Body ≤ 4 KiB,
exactly:

```json
{ "sessionPublicKey": [32], "issuedAtMs": 0, "nonce": [16], "signature": [64],
  "walletProofs": { "stellar": { "address": "G…", "signature": [64] },
                    "evm": { "address": "0x…", "signature": [65] } },
  "sealedEmail": "optional, ≤ 1024 characters: the issuer's sealed address for this session (D438), covered by the signature" }
```

`signature`: Ed25519 by the session key over `"hana-id-identity-v1:" ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(appId) ‖
sessionPk(32) ‖ u64le(issuedAtMs) ‖ nonce(16) ‖ sha256(payload)`, `payload = "identity-token" ‖ borsh(parentOrigin)
‖ walletProofsHash(32) ‖ sha256(sealedEmail or "")`. Wallet proofs: Stellar Ed25519 by the address's key, EVM
secp256k1 `r ‖ s ‖ v` over `sha256` of `"hana-id/identity-wallet/v1" ‖ 0x00 ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(appId) ‖
sessionPk(32) ‖ borsh(chain) ‖ borsh(address)` (EVM address in EIP-55 form in the message; any accepted case in the
body). `walletProofsHash = sha256("hana-id/identity-wallet-proofs/v1" ‖ 0x00 ‖ for stellar then evm: borsh(chain) ‖
borsh(address) ‖ borsh(Vec<u8> signature))`. Layouts: `docs/contract-interface.md` "Identity token messages"; vectors
`packages/core/test/vectors/identity-v1.json`.

In order (D176): the vault gate (key, active, Origin, parent, `scope_conflict`, the vault per-IP binding; not the
vault endpoints' app quota) →
`503 identity_unavailable` without the configuration (below) → body (`400 bad_request`, `413`) → clock, ±60 s
(`400 stale_proof {serverTimeMs}`) → session signature (`401 invalid_signature`) → per session key 10/min, *per
location* (`429 rate_limited`, binding `IDENTITY_SESSION_LIMIT`) → `get_config` not paused (`503 paused` with `retry-after`; an unreadable config is `502 near_unavailable`: fail closed)
→ the share, looked up by session key in any app: a share of another app refuses whatever this app's persistence
(`410 session_ended`, `reason: unknown_share`, D178); in an app whose persistence is `session`, the session key's
share must exist and be live, judged as unlock judges it but read-only (`410 session_ended` with `reason`
`unknown_share` (none, or made for another parent),
`share_revoked` (revoked, or its origin removed), `persistence_off` (the app no longer keeps logins), `share_expired`
(`now ≥ idle_until` or `≥ min(abs_expires_at, created_at + session_ttl_ms)`)); in a `none` app a session key without a
share goes to the chain check alone → `get_session`: cached ≤ 10 s, a cached answer that would refuse re-read fresh, a
missing one re-read every 300 ms for up to 2 s (a lagging node) (`410 session_ended` `reason: no_session` for missing,
revoked, before `sessions_valid_from_ms` or expired; `403 scope_mismatch`; `502 near_unavailable`) → the path's root
identity (`scope#provider#sub#key_index`, exactly three parts; else `502 bad_contract_result`) → lifetime (`410
session_ending` with < 30 s left) → both wallet proofs (`400 bad_wallet_proof {chain}`) → single use:
`sha256(sessionPk ‖ u64le(issuedAtMs) ‖ nonce)` reserved on the RateLimiter object `identity-proof:<hex sessionPk>`
until `issuedAtMs + 120 s` (`409 proof_replayed`; reserved only once the session is known live, and the object's alarm
deletes expired markers) → per account root (`429 rate_limited`) → the quota windows, per app, per scope, global
(`429 rate_limited` naming the window, or `503 identity_busy` with `retry-after` for the global breaker, logged
`identity_ceiling` at error level; above the global soft line a critical `identity_volume_alert`, at most every 10 min
per isolate) → sign and self-verify (`503
identity_signer_unavailable`) → `200 {identityToken, expiresAtMs, emailStatus}`.

The email (D441, `src/identity/email.ts` `mintEmail`, never an error), after the quota windows: the app's
`identity_email` `off` → `emailStatus: "off"`; else a `sealedEmail` that opens (`IDENTITY_SEAL_KEY`, or
`IDENTITY_SEAL_KEY_PREVIOUS`, for this app, session key and before its expiry) → the consent row of its address's MAC
decides: `included` (the token gets `email`, the sealed address, and `email_verified: true`), `declined`, `not_asked`;
no `sealedEmail`, or one that doesn't open → the account's most recently `granted` address for the app (`included`),
else `missing` / `invalid`. Missing keys, a D1 error: `missing`, logged as a code.

The signer is the one `IDENTITY_SIGNER` names (`src/identity/signers.ts`): `worker-secret` (testnet: a P-256 private
JWK as a Worker secret) or `aws-kms` (staging and mainnet, D215; no env uses it yet). The KMS signer hashes the JWS
signing input in the Worker and sends one `TrentService.Sign` (`MessageType: DIGEST`, `SigningAlgorithm:
ECDSA_SHA_256`, SigV4) to `kms.<region>.amazonaws.com` for `IDENTITY_KMS_KEY_ARN`, with no retry, a 3 s deadline over
the request and its body, and a 4 KiB answer cap (D216, D218). It checks the answer's `KeyId` and algorithm, converts
the DER signature strictly to JOSE `r ‖ s` (D217), and verifies it with the published key for the active kid. Any
failure (KMS refusing, throttling, timing out, unreachable or answering garbage, missing configuration, a signature the
published key doesn't verify) is `503 identity_signer_unavailable`: no token is ever answered unverified.

Nothing here writes the share: no counter moves, `idle_until` doesn't slide (a mint is never activity, D55, D112).
After the response (`waitUntil`): `identity_issuance_hourly` (+1 for the hour and kid) and `identity_usage` (+1 for the
app and UTC day); a failed write is logged (`identity_count_failed`), never a failed mint.

The token: header `{"alg":"ES256","kid":"<RFC 7638 thumbprint>","typ":"hana-identity+jwt"}`; claims, exactly and in
this order: `iss` (`IDENTITY_ISS`), `aud` (the D1 `apps.id`), `sub` (`"u1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY,
"hana-id/idt-sub/v1" ‖ 0x00 ‖ borsh(scope_id) ‖ borsh(root_provider) ‖ borsh(root_sub))[0..16])`, per scope and
account root, `key_index` dropped), `sid` (`"s1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/idt-sid/v1" ‖ 0x00 ‖
borsh(app_id) ‖ session_pk)[0..16])`), `iat`, `exp` (`min(iat + 3600, on-chain expiry, and in session mode idle_until
and the absolute cap)`, rounded down), `jti` (16 random bytes, b64url), `wallets` (`[{chain: "stellar", address},
{chain: "evm", address}]`, as proven), `login_methods` (the root's provider, `["google"]` today: account linking comes
with email login), then `email` and `email_verified: true` only when `emailStatus` is `included` (above).

### Email sharing (`src/identity/email.ts`; D411, D438–D443) · I

The user's consent to share their address with the app, per app × account (the identity token's `sub`) × address
(`docs/email-sharing-spec.md`). Each body is the mint's session proof (`sessionPublicKey`, `issuedAtMs`, `nonce`,
`signature`) plus the fields below, ≤ 4 KiB; `signature` is over the mint's message with `payload = "email-consent" ‖
borsh(action) ‖ borsh(parentOrigin) ‖ sha256(sealedEmail or "")`, action `state`, `granted`, `declined`, `revoke` or
`preview` (core `emailConsentPayload`; vectors in `identity-v1.json`). Checks, in order: the gate (the vault gate, or for
the preview the same with `Origin: AUTH_ORIGIN`) and the vault per-IP binding → `503 email_sharing_unavailable` without
`IDENTITY_SUB_KEY`, `EMAIL_CONSENT_KEY` or `IDENTITY_SEAL_KEY` → body (`400 bad_request`) → ±60 s (`400 stale_proof`)
→ signature (`401 invalid_signature`) → 10/min per session key (binding `IDENTITY_SESSION_LIMIT`, its own key) → not
paused (`503 paused`; not for a revoke) → the share and the on-chain session as the mint judges them (`410
session_ended`, `403 scope_mismatch`, `502`) → single use (the mint's marker, `409 proof_replayed`) → the action. A
consent read or write that fails is `503 config_unavailable`. Nothing logs an address, a blob, a MAC or a `sub`.

| Endpoint | Caller | Body adds | Answer |
|---|---|---|---|
| `POST /v1/identity/email-consent/state` | vault | `sealedEmail?` | `200 {setting: off/on_request/at_login, state}`: `granted`, `declined` or `not_asked` for the sealed address; without a readable one `granted` when the account shared any address with the app, else `unavailable` |
| `POST /v1/identity/email-consent` | vault | `sealedEmail`, `decision` `granted`/`declined` | `200 {state}`; `409 identity_email_off`; `400 email_unavailable {reason: malformed/unknown_key/expired/bad_seal}` |
| `POST /v1/identity/email-consent/revoke` | vault | — | `200 {state: "declined", revoked}`: every address of the app × account declined, copies cleared; works with the setting off and while paused |
| `POST /v1/identity/email-consent/preview` | auth popup (`/share-email`) | `sealedEmail` | `200 {email}` (the sealed address, for the sheet); `409 identity_email_off`; `400 email_unavailable`. `Origin: VAULT_ORIGIN` is refused: the vault never reads an address |

OPTIONS: the vault preflight for the first three, an `AUTH_ORIGIN`-only one for the preview.

#### `GET /v1/identity/jwks.json`, `GET /v1/identity/.well-known/openid-configuration`

Public, GET and HEAD (OPTIONS: open preflight), `cache-control: public, max-age=600` (jose's `createRemoteJWKSet`
default), CORS `*`, no cookies. Both come from `IDENTITY_PUBLIC_KEYS` alone (the manifest's key list), never from D1 or
a secret. The JWKS: `{"keys": [{kty: "EC", crv: "P-256", x, y, kid, use: "sig", alg: "ES256"}, …]}` (active and
standby; a private member in the configuration refuses the whole set). Discovery: `{issuer, jwks_uri:
"<issuer>/jwks.json", id_token_signing_alg_values_supported: ["ES256"], subject_types_supported: ["pairwise"],
claims_supported: [iss, aud, sub, sid, iat, exp, jti, wallets, login_methods, email, email_verified]}`. Without the
configuration: `503 identity_unavailable`.

#### Refusals elsewhere

Every JWT-accepting path (`/v1/login`, `/v1/sessions`, `/v1/owner-actions` owner tokens and client proofs) runs
`verifyIdToken`, which refuses a token whose header `typ` is `hana-identity+jwt` or whose `iss` is `IDENTITY_ISS`
before anything else: `400 bad_token`. (It would fail anyway: those paths take RS256 Google tokens only.)

### Hana Home (`src/home/`; H1, H2, H3, D473, D474, D500–D503, D520–D529, D540–D543; live on sandbox-dev, not linked: no Home page until H7)

CORS: `homePreflight` and every response echo `AUTH_ORIGIN` only, and allow `x-hana-home`. `docs/hana-home-spec.md` is the
design; what exists today: `GET /v1/home/config`, the identity verifier `homeGate` (`src/home/identity.ts`) and
`GET /v1/home/apps`, the first route that calls it, and `POST /v1/home/login` (H3), the derive. The page `{authOrigin}/home`
(H7, `packages/web/src/auth/home-page.ts`, D550) calls `GET /v1/home/config`, `GET /v1/home/apps` (the first page, `cursor`, `q`,
`scopeId` for a user's own listing, `appId` for another's or the partner's link) and the login relay's read. It calls
`POST /v1/home/login` only when the user opens a wallet from an app's page (H8, `home-export.ts`, D575): once per per-app
sign-in, with `keyIndex` 0, `maxUses` 1 and a 15-minute session. It never repeats a request by itself, the derive included (D581).

**`POST /v1/home/login`** (Home identity; `src/home/login.ts`; per IP 10/hour, per Home key 10/min). `/v1/login`'s body
plus `scopeId` (`a-z0-9`, 1–64), and nothing else: `keyIndex` must be 0, `maxUses` 1, `expiresAtMs` within 20 minutes; a
`linkJwt`, `linkImmediate` or `exportChain` is refused (400 `bad_request`). No app gate: a suspended, deleted or purged
app, or one with no origin left, doesn't stop it. Checks, in order: the gate (`Origin`, the per-IP hour, the Home token, the
key's signature over this body, single use); shape; the body's token (`verifyLoginToken` with no app; the allow-list; nonce =
`sessionNonce` for this scope and session); its identity equals the Home identity (403 `home_account_mismatch`); the counter
hold; beside each other: the client is admitted for the scope (an exit client in force reaches any registered scope, else
`checkClientScope`'s own-client or shared-client rule: `scope_mismatch`, `shared_login_disabled`, `unregistered_client`,
`unknown_scope`), the session key is free (409 `session_exists`), governance (503 `paused`, `issuer_key_pending`), the
standing (409 `link_pending`; a standing the chain didn't confirm is 502 `near_unavailable`, D522; **404 `home_no_wallet`** when
the chain shows the identity has never opened a wallet in this scope and links are open: "no wallet for this sign-in in that
app", D544, nothing counted or relayed, because a derive marks it `opened` for good and it could then never be linked); the session key's
signature (401 `invalid_signature`); the app key's shape (400 `invalid_app_key`); the directory read that sorts known users
(503 `home_directory_unavailable` with `Retry-After`, nothing counted); then every limit (429 `rate_limited`:
3/hour per wallet (`scope`, `sha256(path)`), 10/hour and 20/UTC day per `(provider, sub)`; 429 `home_busy` with
`Retry-After` at the env's daily ceiling (where links aren't open, an identity not otherwise known is held to 20% of it, D540), manifest `homeDerivesPerDay` (var `HOME_DERIVES_PER_DAY`), default 500, 0 turns Home derives off; a limiter or D1 failure refuses, 503
`rate_limiter_unavailable`). A request refused by any of these relays nothing and spends no limit. Then
`create_session_and_derive` through the `home` relayer pool. Answers as `/v1/login`: `200 {result: {big_y, big_c}, session:
{scope_id, expires_at_ms, max_uses, used: 1}, nearTx, supportId?}`; a failure as `loginFailure` (`session_exists`,
`ckd_failed`, `contract_rejected`, …); `relayer_unconfigured` (503) without a Home key. A relay that certainly never ran gives
back the limits it took; `ckd_failed` gives back the wallet's hour only (D528).

It isn't a login of any app: it marks no app as launched (`first_login_at`, `first_session_at`, session markers untouched),
spends no app's quota. A derive that reaches the relay is one usage event, `home_login`, with no app and no uid, written
for the org that pays for it ("Usage capture" below; D585, D586); a request refused before the relay writes none. After the answer: `key_exported` for the account's user
(`chain` null, `app_id` NULL, D520) and, only for a confirmed linked member or an identity the directory already holds as
`active`, the directory row (D500, D527), both best effort; a derive also records `opened` on chain for good. `supportId` comes back only in that case. A derive by anyone
else writes no row: it doesn't make them `mine` in `GET /v1/home/apps`.

Nothing here derives a key outside that route.

**`GET /v1/home/config`** (`Origin` must be `AUTH_ORIGIN`, 403 `origin_not_allowed` otherwise; per IP 60/min, window
`home:config:ip`): `200 {serverTimeMs, signer, sharedGoogleClientId, exitGoogleClientId, emailSignIn, requestId}`. `sharedGoogleClientId` is the
first shared Google client in force (`effectiveSharedClients`, cached ≤ 60 s), or `null` when there is none; an email user
can still sign in. `exitGoogleClientId` is the first exit Google client in force (`effectiveExitClients`; contract v4,
D468), or `null` against an older contract or an empty list (fail closed: Home has no exit route then). The page signs in
with the shared client while there is one and with the exit client otherwise (D490, D618, through `/home/callback`), and
opens an app's wallet with the exit client only where the app's coverage is `exit`. `emailSignIn` (H10) is `true` only
when the env has an email issuer (`EMAIL_ISS`) and `("email", "hana-home")` is an exit client in force (the same rule
`homeGate` applies, D494), and only while the env's `EMAIL_ISSUER_URL`, when set, is an http(s) URL (D669); an API from before H10 sends no field and the page reads it as `false`. Failures: `429
rate_limited`, `502 near_unavailable`, `503 rate_limiter_unavailable`.

**The identity (`homeGate`).** Every later `/v1/home/*` call sends `x-hana-home`: `b64url(json {jwt, key, expiresAtMs, salt,
counter, sig})` (`@hana-id/core/home`: at most 12 288 characters, exactly these six fields, canonical base64url, `key` and
`salt` 32 bytes, `sig` 64). `sig` is the Home key's Ed25519 over `homeMessage(counter, method, path, body)`, where `path`
is the URL's path **and query** (`homeRequestPath`, D473). `homeGate` checks, in this order, and answers the request's
`{provider, sub}` or a refusal (`code`, the usual `{error, code, requestId}` body, never `data` and never the token):

| # | Check | Refusal |
|---|---|---|
| 1 | `Origin === AUTH_ORIGIN` | `403 origin_not_allowed` (no CORS headers) |
| 2 | the per-IP limit (the endpoint's) | `429 rate_limited`, `503 rate_limiter_unavailable` |
| 3 | the header's shape | `401 missing_home_identity`, `401 invalid_home_identity` |
| 4 | the token: signature, `iss`, `exp` with 60 s skew, the claim allow-list (`verifyLoginToken` with no app) | `401` with its code (`invalid_token`, `token_expired`, `token_stale`, `token_has_pii`, `unsupported_issuer`, `bad_token`); outages stay `503 issuer_keys_unavailable`, `503 issuer_key_pending` (`retry-after`), `502 near_unavailable` |
| 5 | `aud`: a shared or exit Google client in force (`route` `shared` or `exit`; a retired or pending shared or exit client refused; an older contract has no exit clients) or the email issuer's Home audience `hana-home` while `("email", "hana-home")` is in force on the exit list (`route` `email`; refused on an older contract, an empty list or a pending entry, and a removal lingers up to 60 s in the cached `get_config`, as for Google) (`homeAudienceRoute`), never a scope client. A partner login never reaches this route: `checkClientScope` stays closed to exit clients (`403 unregistered_client`) | `401 not_a_home_client`, `502 near_unavailable` |
| 6 | nonce = `homeNonce(signer, key, expiresAtMs, salt)` | `401 nonce_mismatch` |
| 7 | `now < expiresAtMs ≤ now + 20 min` | `401 home_identity_expired`, `401 invalid_home_identity` |
| 8 | the Home key's signature over this request's method, path and query, and body (a POST's raw body, at most `MAX_BODY`, is returned with the identity) | `401 invalid_signature`, `413 bad_request` |
| 9 | the per-Home-key limit, on object `home-key:<sha256(key)>`; signed requests only | `429 rate_limited`, `503 rate_limiter_unavailable` |
| 10 | `(key, counter)` unused, then marked single use until `expiresAtMs` (`RateLimiter` `reserve`, marker `counter:<n>`) | `409 counter_reused`, `503 rate_limiter_unavailable` |

The 401s all mean "sign in again" to the page (spec "Expiry"); a 409 or a 429 do not.

**`GET /v1/home/apps`** (`homeGate`, window `apps`: 30/min per IP, 60/min per Home key). No chain transaction, no key
derived. At most one query parameter, or `400 bad_request`: none (the first page), `cursor` (the next page, the last
page's `nextCursor`), `q` (a search, 2 to 64 characters after trimming; 10/min per Home key, `429 rate_limited`),
`scopeId`, or `appId` (the partner's link, which is how a quiet scope is opened: a stranger's `scopeId` lookup of a quiet
scope answers nothing, D502). Answer: `200 {scopes: [...], nextCursor, requestId}`, `nextCursor` a scope id
or null (only the list pages have one). `Cache-Control: no-store`.

```
{scopeId, mine, coverage, googleClientId, supportId?, addresses?, apps: [{appId, name, status, environment, origins, logoUrl}]}
```

- **The list (D462)**: every scope with `scopes.first_session_at` set and at least one app with `apps.first_login_at` set
  (written once at the app's first successful login), in `scope_id` order, 15 a page, test scopes only in
  dev envs, a scope's `home_quiet` listing left out (D502). A stranger sees only apps with the marker, in the list, a search,
  `scopeId` and `appId` (a link to an app with no login answers nothing); a user's own scopes (`mine`) show all their apps.
  Its apps from D1 (live first), suspended and deleted included
  (`status` `active`/`suspended`/`deleted`), at most 10 a scope; `origins` the ones in force, at most 5 an app;
  `logoUrl` on the files origin or null. It survives `purgeDirectory`, so a shut-down app stays findable.
- **The overlay (D466)**: `end_user_identities` by the verified `(provider, sub)`, status `active` only (a matured link
  counts once the member's next login writes it, not on its `effective_at` alone, D500), joined to `end_users`. Those scopes come first (at most 30, newest last-seen first) with
  `mine: true`, `supportId` (`HANA-XXXX-XXXX`, from `end_users.support_code`) and `addresses`
  (`[{chain, address}]`, `key_index` 0 only, may be empty, Stellar first). A member's row names its account, so it gets
  the root's wallet. Everything else is `mine: false` with neither field. No overlay (a purged scope, a user the directory
  doesn't know) means no Support ID (D395) and no addresses: the page sends the user to a derive. The user's own scopes
  come only on the first page, with any `home_quiet` value; a later page or a search marks one `mine` if it finds it.
- **Coverage (`home/coverage.ts`, D501)**, for the identity's own provider: `shared` (shared login on, a shared Google client
  in force), `hana_client` (a scope client the chain lists and `hana_held_clients` records), `exit` (an exit client in force,
  D468, only where the routes above are gone, D490), `partner_client` (only a partner's own client and no exit client, best
  effort), `none` (nothing can open a session, or the chain has no such scope); email identities: `email`, then `exit`, then
  `none`. `googleClientId` is the client Home signs in with for that route, null for email or none. `unknown` (no chain read
  for this row: over the budget below, or a failed read): ask for it by `?scopeId=`, or `?appId=` for a quiet scope (D502).
- **Search**: a listed scope by any part of an app's name (ASCII case-insensitive, wildcards as data), a quiet scope only by an
  app's whole name (D502), at most 15 results, no paging.
- **Budget (D500, free plan: 10 ms CPU, 50 subrequests, D417)**: at most 16 `get_scope` reads per request (a read cached
  by this isolate costs none; five at a time, stopping at the first failure), so the worst case with every RPC endpoint failing
  stays under 50 subrequests; own rows are read first; the rest answer `unknown`, and the isolate's cache (at most about
  70 s, D500; 10 s for "no such scope", below) fills them on the next call.

Refusals: `homeGate`'s; `400 bad_request`; `429 rate_limited` (a search); `502 near_unavailable` (`get_config`); `503
home_directory_unavailable` (D1), `503 rate_limiter_unavailable` (a search). Partner-controlled strings are returned as
data, never interpreted. No `sub`, token or address is logged. Coverage is display only: `POST /v1/home/login` (H3) and the
contract check for themselves. Deviation from the spec's shape: no `sharedLoginEndsAtMs` (D480 made turn-offs immediate, so
nothing is pending) and no `liveDevices` (H9's `/devices` reads shares by `path_hash`), D501.

**Whose rows (H9, `src/home/root.ts`, D606).** In a scope, the devices list and the stops act on the account root that the
wallet directory records for the verified `(provider, sub)` with status `active` (a member's row → its account's `root` row,
the rule of the app list's overlay), else on the identity's own: the path `{scope}#{provider}#{sub}#0` (key index 0, the only
one a vault opens), hashed as `vault_shares.path_hash` / `vault_consents.path_hash` hold it, and the account's User ID
(`end_users.token_sub`, or computed with IDENTITY_SUB_KEY for a user with no row) for `email_consents`. Shares and consents
at another key index are invisible to Home (none exist: the vault opens only index 0, D665). A root that is another identity's
(a member's account) is confirmed on chain before Home shows its addresses or stops anything (D661): one uncached
`get_identity` view; where the chain contradicts the directory (a stale `active` row after an unlink whose sync failed), the
identity's own rows are used instead.

**`GET /v1/home/devices`** (`homeGate`, window `devices`: 30/min per IP, 60/min per Home key; H9, D607, D608). At most one
query parameter, or `400 bad_request`: none or `cursor` (the directory's scopes for this identity, 10 a page in scope order,
`nextCursor` the last one's id or null), or `scopeId` (one scope, the identity's own path when the directory has no row; a
scope with nothing of this user's answers its empty entry). One D1 read for the roots; at most 10 `get_identity` views for
member scopes, 5 at a time, stopped after the first batch with a failure (D661); one D1 batch of three or four statements a
scope, which D1 counts as one query (a second batch only before migration 0014). Worst case 3 D1 queries, 3 Durable Object
calls, 4 fetches for an uncached `get_config` and 25 for the member checks (D665). `200 {scopes: [...], nextCursor, requestId}`, `Cache-Control: no-store`:

```
{scopeId, apps: [{appId, name, status}], more, canStop,
 devices: [{shareId, appId, partnerOrigin, label, signedInAtMs, lastUsedAtMs, idleUntilMs, expiresAtMs,
            consent: {consentId, label, grantedAtMs, expiresAtMs} | null}],
 consents: [{consentId, appId, partnerOrigin, label, grantedAtMs, expiresAtMs}],
 email: [{appId, addresses: [string]}] | null}
```

- `devices`: the live shares under the root's path, newest first, at most 25 (`more: true` past that), judged as unlock
  judges them (`shareLive`: not revoked, before `idle_until`, before min(`abs_expires_at`, `created_at` + the app's session TTL),
  persistence `'session'`, the origin still allowed). `shareId` and `consentId` are the 16-byte ids, base64url. `label` is the
  vault's `deviceLabel` or null. `expiresAtMs` is the share's capped end. `lastUsedAtMs` is the last unlock or approved
  signature there (`idle_until` − the app's idle limit, never later than now; auto-signatures don't count), or null when the
  slide was cut short by the end (D610, D663). A device whose app the apps read didn't return is still listed (D664).
- `consent`: the device's active consent, read with the device (joined by its share, so no other list's bound hides it, D664),
  judged as `GET /v1/app`'s status read judges it (`consentActive`), so a
  'session'-mode logout (the share revoked, the consent's `revoked_at` still NULL) reads as none (D534). `label` is the policy's
  at grant, the partner's words, returned as data.
- `consents`: active consents with no share (an app with persistence `'none'`), at most 25.
- `email`: the addresses the account shares (`state = 'granted'`) per app of the scope, at most 25; `null` when this env
  can't tell (no IDENTITY_SUB_KEY for a user with no directory row, no migration 0014, or a member's account not confirmed).
- `canStop`: false only for a member's account the chain couldn't confirm (D661): its devices are listed, with no stop and no
  addresses.
- `apps`: the apps named above, with name and status.

Refusals: `homeGate`'s; `400 bad_request`; `503 home_directory_unavailable` (D1). Nothing logs a `sub`, an id, a path hash, a
label or an address.

**The stops** (`homeGate`, window `revoke`: 30/min per IP and 30/min per Home key, shared by the three; H9, D609). Body exactly
its one field. Each finds the row by its id, resolves the root for the row's scope (above) and acts only when the row is that
root's; the write repeats the match. Another user's id and an id that doesn't exist get the same 404. A member's account is
confirmed on chain first (one `get_identity`; a contradiction acts for the identity's own rows; no answer is `503
near_unavailable` with `retry-after: 2`, nothing written, D661). No transaction, so they work through a pause.

| Endpoint | Body | Does | `200` |
|---|---|---|---|
| `POST /v1/home/consents/revoke` | `{consentId}` (base64url, 16 bytes) | `revoked_at` now, `revoked_by = 'home'` | `{revoked: bool}` (false: already ended) |
| `POST /v1/home/shares/revoke` | `{shareId}` | "Sign out this device": the share's `revoked_at` and, in the same batch, its consents' (`revoked_by = 'share'`) | `{revoked: bool}` |
| `POST /v1/home/email-sharing/revoke` | `{appId}` | every address of the account for that app → `declined`, the copies cleared: the session-proof route's write (`/v1/identity/email-consent/revoke`) | `{state: 'declined', revoked: n}` |

Refusals: `homeGate`'s; `400 bad_request`; `404 unknown_consent` / `unknown_share` / `unknown_email_share` (no such row, not
this user's, or for email nothing this account ever decided with the app); `503 email_sharing_unavailable` (no IDENTITY_SUB_KEY
for a user the directory doesn't hold); `503 near_unavailable` (a member's account not confirmed); `503
home_directory_unavailable` (D1). Effect: the vault's next status read (`GET /v1/app` with `x-hana-consent`, at most 10 s old
before any auto-signature, D465) reads `'revoked'`, so auto-signing stops within about 10 s; a signed-out device's open tab
ends at its next `GET /v1/app` (`share: 'revoked'`, D662, D680: within about a minute in every app), touch, unlock or
reload; new identity tokens and the partner's
console lose a stopped address at once, tokens already issued keep it for at most an hour.

### `POST /v1/owner-actions` — owner pool

No app key. `{"method", "args"}` only, `args` exactly as the contract takes them; unknown keys anywhere are refused.

| `method` | `args` |
|---|---|
| `propose_change` | `{scope_id, auth, change, client_proof?}`; `change` is `{"AddClient":{provider, aud}}` (needs `client_proof`), `{"SetOwners":{owners: 1..5}}` or `{"SetAllowShared":{"allow":true}}`; relayed with `client_proof: null` when absent |
| `cancel_change` | `{scope_id, auth, change_id}` |
| `remove_client` | `{scope_id, auth, provider, aud}` |
| `disable_shared_login` | `{scope_id, auth}` |
| `execute_change` | `{scope_id, change_id}` (no `auth`) |

`auth` must be `{"Oidc":{"jwt":"…"}}`. Checks after the per-IP limit and shape (`400 bad_request`):

| Status | Code | When |
|---|---|---|
| 401 / 400 | `invalid_token`, `token_expired` / `unsupported_issuer` | `auth` token (no skew) |
| 403 | `not_console_token` | `(provider, aud)` not in `get_config().console_audiences` |
| 404 | `unknown_scope` | |
| 403 | `not_owner` | token's `(provider, sub)` not an `Oidc` owner |
| 409 | `owner_nonce_mismatch` | the token's nonce isn't `owner_action_nonce(signer, scope_id, method, borsh(args without auth), action_nonce)` for this body at the scope's current `action_nonce` (another action, other args, or the nonce moved): rebuild and sign again |
| 502 | `near_unavailable` | the scope view has no readable `action_nonce` (fail closed) |
| 404 / 409 | `unknown_change` / `change_locked` | cancel, execute |
| 404 / 409 | `unknown_client` / `last_client` | `remove_client` |
| 409 | `shared_login_disabled` / `last_client` | `disable_shared_login` |
| 400 / 409 | `invalid_client_proof` / `client_registered`, `shared_client` | `AddClient`: the proof's signature, its `(provider, aud)`, and its nonce = `client_proof_nonce(signer, scope_id, action_nonce)` |
| 409 | `shared_login_enabled` | `SetAllowShared` already on |
| 400 | `token_has_pii` | the `auth` token or the `client_proof` has a claim outside the allow-list (`data: {claim}`, D274) |
| 409 | `token_used` | this exact token was reserved before |
| 503 / 502 | `issuer_keys_unavailable` / `near_unavailable` | JWKS / chain read failed |

The scope is read with an **uncached** `get_scope` (D236): both nonces commit to its `action_nonce` as it is now, so an
action built before another one landed is refused here, for free, instead of burning gas on chain. The nonce check
comes after the owner check and before the method's own checks; nothing is reserved or counted before every check
passed. The arguments are encoded by `@hana-id/console-core` `ownerActionArgsBorsh` (tested against the contract's
`test_fixture.json`). The `auth` token and the `client_proof` are checked like a login token (RS256, issuer, `exp`
without skew, a finite `exp`), the proof for its `(provider, aud)`. Both are relayed to the chain, where they are
public, so both are held to the login tokens' claim allow-list (D274), on this endpoint and on
`ConsoleRpc.ownerAction` alike (D277): a claim outside it (`email`, `email_verified`, `hd`, …) is `400 token_has_pii`
with `data: {claim}`, right after that token's signature check (the owner token's before any chain read), so before
the reservation and the relay. An
allow-listed claim of the wrong JSON type is ignored here (D201; `ConsoleRpc.ownerAction` checks them strictly). No
claim is logged, returned or stored; only the token's sha256 is kept. The token itself is relayed to the contract
unchanged.

The token's sha256 is reserved atomically (`RateLimiter` object `owner-actions:tokens`, until the token's `exp`)
before relaying. Then the caps (table above) are asked from the most specific in, at one instant; when one refuses,
the hits the earlier ones accepted are taken back (`RateLimiter.unhit`), so a refused request uses up no window, and an
`owner_cap` security event is written (`{method, window, limit, max, windowStart}`, the scope and its org; once per
window, by a deterministic id; never the owner's identity). `execute_change`, which anyone may send, never counts
against the window the scope's owners use, and the safety budget (`cancel_change`, `remove_client`,
`disable_shared_login`) counts only against safety windows: the owner's, the target scope's and a high safety-only
ceiling. Only a verified owner of the target scope on chain (`get_scope().owners`, checked before any window) reaches
the scope's safety window, and it is sized for all of them at their own cap at once.

Remaining starvation limits for the safety budget (APIW-3): within a scope, only all 5 of its owners together (the
contract's `MAX_OWNERS`), each at its own cap, can fill the scope's safety window; any 4 leave the fifth room. The
global safety ceiling needs 20 owner identities at their cap per minute (≥ 4 scopes an attacker fully owns) or 50 per
day (≥ 10 such scopes) plus 1000 actions the scopes' state allows (a cancel needs a pending change, `MAX_PENDING` = 10
per scope; a removal one of the scope's clients; a disable shared login on), so ≥ 100 scopes' worth at once, or more
proposals than the shared 200/day ceiling allows in five days. Registration is invite-only, and an owner can
always cancel directly on chain (`docs/operations.md` "Cancelling a change when the API refuses"). The owner pool's
allowance is the hard spend bound for all of these. A `cancel_change` (or any authenticated action) without an
owner identity is refused, `403 not_owner` (fail closed; the shape check already requires `auth`). `429
rate_limited` names the window in `error`: `owner actions per owner per minute`, `… per scope …`, `executes per scope
…`, `owner actions per day`, `safety actions per owner per minute`, `safety actions per scope per day`, `safety actions
per minute`. The token is released only if a
cap refuses the request or the relay certainly never executed
(`method_not_allowed`, `relayer_unconfigured`, `near_unavailable`, `near_rejected`, `relayer_busy`). Without
`OWNER_RELAYER_KEYS`: `503 relayer_unconfigured`. → `200 {"result": <contract return or null>, "nearTx", "requestId"}`.

## Relay errors (any relayed call)

| Status | Code | Executed? |
|---|---|---|
| 422 | `contract_rejected` (panic text in `error`) | yes, failed |
| 502 | `near_rejected` | no (node refused the tx as invalid) |
| 502 | `near_unavailable` | no (RPC read before sending failed) |
| 502 | `near_error` | unknown; check `nearTx` |
| 502 | `bad_contract_result` | yes; result not the expected shape |
| 503 | `relayer_busy` | no (nonce still invalid after one retry, or tx dropped twice) |
| 503 | `relayer_unconfigured` | no (pool secret missing or empty) |
| 503 | `relayer_unavailable` | unknown (Durable Object call failed) |
| 504 | `timeout` | unknown; outcome not settled within 60 s |

Any other broadcast failure (dropped connection, non-JSON 5xx) is treated as "may have executed" and the hash is
polled.

**Email-login panics (L, `src/panics.ts`, D232).** A `contract_rejected` failure in the signer's own receipt whose
panic is one of email login's is answered as its own error (on `/v1/sessions`, `/v1/login`, `/v1/derive` and the link
relays); the panic text stays in `error`, as for every refusal, and is never logged:

| Panic | Status | Code |
|---|---|---|
| `Links wait until the owner accepts the wallets opened before v3` | 409 | `links_unavailable` |
| `Sign-in method is linked to an account` (the session's own path identity joined an account, D136) | 409 | `identity_linked` |
| `Sign-in method link is pending` | 409 | `link_pending` |
| a link refusal (`Link token nonce doesn't match`, `Link nonce doesn't match`, `This link must be immediate`, `Both sign-in methods already have a wallet`, `This sign-in method was unlinked`, `Account is full`, `Account already has a sign-in method of this kind`, `Sign-in method is already linked`, `Sign-in method already has a wallet`, `Identities must differ`, `Wrong epoch`, `No such member`, `Sign-in method is not in this account`, `Only the root or the member itself can unlink`, `Cannot unlink the root`) | 422 | `contract_rejected` + `reason` (`link_mismatch`, `both_wallets`, `unlinked`, `account_full`, `provider_taken`, `already_linked`, `has_wallet`, `same_identity`, `stale_epoch`, `no_such_member`, `not_in_account`, `not_allowed`, `cannot_unlink_root`) |

## Idempotency and replay

No idempotency keys. Each endpoint is safe to retry because the second copy is refused:

| Endpoint | A replay or retry gets |
|---|---|
| `/v1/sessions` | `409 session_exists` (`session_key_in_use`, also true for revoked unexpired sessions) |
| `/v1/login` | the same, or `422 contract_rejected` `reason: session_key_in_use` if both reached the chain |
| `/v1/derive`, `/v1/sessions/revoke` | `409 counter_used` with `nextCounter`; no gas spent. Copies racing in different isolates can still reach the chain (all but one fail there, ~2.2 Tgas each) |
| `/v1/owner-actions` | `409 token_used` |
| `/v1/vault/shares` | `409 share_exists` |
| vault share actions | `409 bad_counter` with `expected` |
| login relay | write `409 relay_used`; read `410 relay_gone` |

After `504 timeout` or `502 near_error`, look the tx up by `nearTx` before retrying: a retry of a request that landed
is refused as above.

## Usage capture (`src/usage/`, batch C4)

One UsageEvent v1 (`@hana-id/console-core` `usageEventV1`; the ledger's `usage.record_event` checks the same shape) for
every request that passed the gate of `/v1/login`, `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` and
`/v1/vault/unlock` (the vault gate: app, origins and the vault limits), and for `/v1/owner-actions` once the owner
check passed. A Hana Home derive (`POST /v1/home/login`, H11) is one event too, opened later: only once every check and
limit passed, right before the relay (D585), so a refused Home request produces none. Gate rejections, `GET /v1/app`,
share creation, touch, revoke and revoke-all, the identity token and the login relay produce none (logs only). The handler opens the event at its gate (`beginUsage`), the relay notes what
it sent (`lapRelay` → `noteRelay`) and the response closes it (`done` → `finishUsage`); a handler that throws past its
gate records `500 internal`, as the router answers.

| Field | Value |
|---|---|
| `request_id`, `at_ms` | the request id (the idempotency key) and the request's start |
| `org_id`, `app_id`, `scope_id` | from the gate row (owner actions: no app; the scope's org read from `scopes` after the response, `org_legacy` for a scope the hot DB doesn't hold or when D1 can't be read, `usage_org_unavailable`). A Home derive: no app, the request's scope, and the org that pays for it (below) |
| `endpoint` | `login`, `session`, `derive`, `revoke`, `unlock`, `owner_action`, `link`, `link_cancel`, `link_unlink`, `home_login` |
| `outcome`, `status`, `code`, `latency_ms` | as the request log (`code` null for ok) |
| `relayed` | a transaction that can execute was sent: an ok relay, or `contract_rejected`, `timeout`, `near_error` with a `nearTx`; never `relayer_busy` or `near_rejected` (they name a transaction that can't execute), nor anything that never reached NEAR, nor an unlock |
| `near_tx`, `relayer_pk`, `relayer_nonce` | whenever the relay names a transaction: the pool key that signed it (`ed25519:…`) and its nonce (the `RelayerKey` result, for the admin's daily nonce cross-check) |
| `relay_gas_burnt`, `relay_tokens_burnt_yocto` | BigInt sums of `gas_burnt` / `tokens_burnt` over `transaction_outcome` and every `receipts_outcome` of the settled outcome (`near/tx.ts` `burntGas`); provisional (`EXECUTED_OPTIMISTIC`), never billed; absent when the RPC didn't report them, or when either is past the event's bounds (gas ≤ 2^63 − 1, tokens < 10^39) |
| `uid` | ok `login`, `session` and `derive` only: `HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope) ‖ borsh(provider) ‖ borsh(sub))[0..16]`, b64url, from the request's derivation path (login: the token's; session: the new session's; derive: the session's), which must be `<scope>#provider#sub#key_index` (key index dropped); computed after the response |

Never in an event: a sub, JWT, email, IP, session key, share id or path.

**Who pays for a Home derive** (`src/home/billing.ts`; D461, D586, confirmed by the user 2026-11-10; the `suspended` line is still to be agreed). The
event's `org_id` is the payer, chosen after the response by one hot-DB read, only when capture is on. The whole rule is
the table `HOME_PAYER`:

| The scope's apps | Payer |
|---|---|
| `active`: at least one app that isn't deleted is running | the scope's org (`scopes.org_id`): its "Hana Home logins" statement line |
| `suspended`: it has apps that aren't deleted, all of them suspended (by Hana, the org or the partner) | Hana (for now: D461's note, to be discussed) |
| `gone`: every app deleted, or no row for the scope | Hana |

Hana's own org is the var `HANA_ORG_ID` (manifest `hanaOrgId`, an internal org; D589), else `org_legacy`; `deploy-check --d1` checks the org exists and is internal, and a statement refuses a Home line for a scope that isn't its org's unless the org is internal (D597). When the read
fails Hana pays (`usage_org_unavailable`). A Home event has no uid, so it counts no active or new user. Its relayer key
is a Home pool key, which settlement requires (D590).

**Write** (`usage/record.ts`): `ctx.waitUntil` first yields (`scheduler.wait(0)`: nothing runs before the response
leaves), then runs the check against UsageEvent v1 (a refusal is
`usage_write_rejected`, never sent), then `SELECT usage.record_event($1::jsonb)` over a new `pg` connection to
`USAGE_DB` (Hyperdrive pools; 5 s to connect, 5 s for the statement). Only a `pg.DatabaseError` (the server's
answer) carries a SQLSTATE: any other error, an errno code included, is a connection error. A connection error or
timeout, or a SQLSTATE of class 08, 40, 53, 57 or 58, is retried once after 250 ms with the same event (a duplicate is ignored by
the function); `22023` (the function refused the shape) is `usage_write_rejected`; any other SQLSTATE (e.g. `23514`,
no partition) is not retried. The loss is logged once as `usage_write_failed {requestId, appId, endpoint, code,
attempt}`, never with the connection string or the driver's message. Without `USAGE_DB` nothing is built or sent.
Tests: `apps/api/test/usage.test.ts` (a refusing server: every endpoint answers the same status, body and headers;
a ledger that never answers delays no response).

### Usage ledger functions (`migrations-usage/0006_reports.sql`, batch C12)

The owner's `SECURITY DEFINER` functions the reports, statements and settlement use (D320, D321). `EXECUTE` is revoked
from `PUBLIC` and granted by name.

| Function | What | Roles |
|---|---|---|
| `usage.classified(org, from_ts, to_ts, as_of)` | Internal: the org's events with `received_at ≤ as_of` and what billing makes of each (`gas_status` `none` / `pending` / `final` / `unsettled`): `final` only when settled final for that very `(request_id, at)` and no other relayed event received by `as_of` carries its `near_tx` | none (called by the functions below) |
| `usage.org_report(org, from_day, to_day, by, app_ids, as_of)` (replaced by `0008_home_logins.sql`: `kind` and `home_logins` added) | The report rows per UTC day or month: per app (`kind` `app`), per scope for owner actions (`scope`) and per scope for Hana Home logins (`home`, a row of its own carrying only those logins' gas, with `home_logins` the ok ones): counts, MAU (distinct uids), new users (`app_users.first_seen`), identity tokens, failures by code, settled gas and NEAR split into rejected and error, USD per day (round half up of yocto × usd_micros / 10^24, a month the sum of its days; NULL when a day with gas has no rate), exact nearest-rank p50/p95 of ok logins and derives, unsettled, `after_statement`. ≤ 400 days, 1–100 apps (an app filter leaves owner actions and Home rows out) | writer, admin |
| `usage.org_statements(org)` | The org's statements, newest first (≤ 120), with their totals | writer, admin |
| `usage.org_ledger(org, month, as_of, after, lim)` (replaced by 0008) | The partner's ledger rows, keyset `(request_id, at)` over the rows as returned, gas only on final rows. A `home_login` row has no `near_tx`, the UTC day for its time and `home_` + 32 hex characters for its id (D595): its transaction's public arguments carry the user's ID token | writer, admin |
| `usage.org_ledger_full(org, month, as_of, after, lim)` (0008) | Every row in full, a Home derive's transaction, request id and time included: staff's ledger CSV and export, to reconcile against the chain | admin |
| `usage.rejection_rates(day)` | Per org: relayed attempts and relayed-then-rejected ones (D91) | admin |
| `usage.statement_blockers(org, month)` | Relayed events with no settlement row, and the days without a rate | admin |
| `usage.override_rate(day, usd_micros, entered_by, reason)` | The audited override: the rate (`source = 'manual'`) and its `usage.rate_overrides` row together; a future day, a rate ≤ 0 or > 1 000 000 USD, a reason under 10 characters refused (`22023`); a month with a statement refused (`42501`) | admin |

0006 also adds `gas_settlements.reason` (`not_final`, `duplicate_tx`, `signer_mismatch`; only on unsettled rows), an
index on relayed events' `near_tx`, `usage.rate_overrides` (append-only), `ops.settlement_alerts`,
`ops.settlement_tries` and `ops.statement_notices`, and takes the admin role's direct `UPDATE` on `near_usd_rates`
away (a fetched rate is an `INSERT … ON CONFLICT DO NOTHING`; a replacement goes through `override_rate`).

### Usage ledger retention functions (`migrations-usage/0007_retention.sql`, batch C13)

D90's periods (D360–D369), as the owner's `SECURITY DEFINER` functions, `EXECUTE` granted to `usage_admin` only (the
admin Worker's monthly job; `scripts/uid-erase.ts` for `erase_uid`). The admin role still can't update an event,
delete an `app_users` row, a settlement or a partition itself.

| Function | What |
|---|---|
| `usage.strip_uids(max_rows = 10000)` → `(events, app_users, more)` | NULLs `uid` on events of every UTC month that ended more than 24 months ago (`at < usage.uid_cutoff()`, the start of the month 24 months before the current one) and deletes `app_users` rows last seen more than 24 months ago, at most `max_rows` of each (1–100 000); `more`: call again |
| `usage.drop_expired_partitions()` → `(partitions, settlements, identity_tokens, email_counts, settlement_alerts, settlement_tries)` | Detaches and drops each `usage.events_YYYY_MM` whose month ended at or before `usage.records_cutoff()` (the month start 7 years back), then deletes `gas_settlements`, `identity_tokens`, `email_counts`, `ops.settlement_alerts` and `ops.settlement_tries` rows before it; `lock_timeout` 5 s (a detach fails rather than queue the writer). Never a statement, a rate or an override |
| `usage.purge_app_users(app)` → count | An app's `app_users` rows (the job passes apps deleted 30 days ago, `AdminRpc.deletedApps`) |
| `usage.erase_uid(uid bytea)` → `(app_users, events)` | An erasure: the uid's `app_users` rows deleted and the uid NULLed on every event carrying it, in any app (a uid names one identity of one scope, D362); a uid that isn't 16 bytes is `22023` |
| `usage.retention_due()` → `(statements, rates, rate_overrides, oldest_statement)` | What is past 7 years and waits for a person (statements, rates and their files are deleted by hand after review) |
| `ops.purge_expired()` → `(nonce_checks, rejection_alerts, scope_watch, retention_runs, erasures)` | `ops.nonce_checks` and `ops.rejection_alerts` after 400 days, notified `ops.scope_watch` rows after 400 days, finished runs and erasure records after 60 months |

0007 also gives `ops.retention_runs` its `month`, `status` (`running`, `ok`, `partial`, `failed`; one `running` row at
most, a unique partial index) and `alerted_at`, adds `ops.erasures` (`at`, `ticket`, `operator`, `scope_id`, `rows`:
counts only; `usage_admin` may insert and read; a trigger refuses any change and any delete before 60 months, for the
owner too) and the indexes `events (uid, at) WHERE uid IS NOT NULL`, `app_users (uid)` and `app_users (last_seen)`.
Tests: `apps/api/test-usage/retention.test.ts`.

## RPC entrypoints (`src/rpc/`, `src/changes/`, batches C5 and C6) · C

`ConsoleRpc` and `AdminRpc` are `WorkerEntrypoint` classes exported by the API Worker (`docs/batch-c-spec.md` "RPC
interfaces"). No route reaches them; the console Worker (batch C7) binds `ConsoleRpc` and the admin Worker (C8)
binds `AdminRpc` (`apps/admin`); both Workers run on sandbox-dev since M4. Every method takes one object: `Ctx`
(`actor`, `requestId`, `clientIp`) plus its fields. The object is validated with its `@hana-id/console-core` zod
schema (`src/rpc.ts`: strict, so an unknown field is `bad_request`). The answer is `{ok: true, …}` or
`{ok: false, code, error?}` (`RpcCode`; the BFFs map it to HTTP with `RPC_HTTP_STATUS`). Nothing throws out of a
method: an unexpected error is logged (`event: "rpc"`, method, request id, `code: internal`) and answered `internal`.

**Actors.** `ConsoleRpc` takes `member` actors only (`cancelChangeByLink`: `link` only) and never `org_legacy`
(`forbidden`). `AdminRpc` takes `hana`; the methods its crons call also take `system` (`listApps` and `getApp`, the watcher's reads, C8; `pendingNotices`,
`getSecurityContacts`, `listScopes`, `changesSince`, `securityEvents`, `markSecurityEventNotified`, `relayerKeys`), and
`ackNotice` and the retention methods (`purgeAudit`, `deletedApps`, `purgeDirectory`, C13; `purgeUserEvents`, D433)
take `system` only (the crons). Any other actor is `forbidden`. The console's member is trusted
(spec "Trust in the actor"); every org method still filters `WHERE org_id = ?`, so another org's app or change is
`not_found`, the same as one that doesn't exist.

| `ConsoleRpc` method | What it does |
|---|---|
| `listApps`, `getApp`, `listChanges` | The org's apps (summaries; `pendingChanges` counts only changes not yet in force, D701), one app in detail (origins with their ASCII and decoded forms and `idn`, settings in force, open changes with the status in force now: a `pending` change whose `active_from` has passed is answered `active` before the hourly job records it, and of two `policy_set` changes in force only the latest by `active_from` reads `active`, the older `ended`, D701; every key), the org's `app_changes` newest first (`beforeSeq`, `limit` ≤ 200) |
| `removeOrigins` | Immediate: the rows go; an `origin_add` in force ends, one not yet in force is cancelled; `origins_version` + 1 |
| `turnOff` (`policy` / `raw_sign`) | Immediate: the columns cleared, pending values dropped, the guarded changes ended or cancelled; `settings_version` + 1; nothing on → no write |
| `updateSettings` | `persistence`, `sessionTtlMs` (1 h..23 h 50 min), `idleTtlMs` (15 min..session TTL), `googleWebClientId` (one of the scope's Google clients, `get_scope` read uncached; `null` unpins), `name` (`normaliseAppName`: NFC, ≤ 64, display-safe), `identityEmail` (`off`/`on_request`/`at_login`, D411: immediate, recorded as the other settings); a lowered TTL under a stored or proposed policy's `maxConsentMs` is `policy_invalid`; CAS on `settings_version` |
| `setLogo` | The `logo_key` pointer (`logos/<this app id>/<sha256 hex>.png` or null), CAS on `settings_version` |
| `cancelChange` | A pending change not yet in force: its origin row deleted, or its pending settings value cleared (only while still the change's and in the future); the version bumps; `change.cancelled` |
| `cancelChangeByLink` | The same, by the emailed link: `sha256(token)` must equal the change's `cancel_token_hash` (else `forbidden`, also before the ack), valid until `active_from`, single use; actor `link` |
| `setSuspended` | The partner bit (4) only, set or cleared; a member never touches bits 1 and 2 |
| `createKey`, `rotateKey`, `revokeKey` | A new `pk_<environment>_` key (at most 5 with `revoked_at` NULL, `key_limit`); rotate: a new key and the old one `revoked_at = now + 24 h`; revoke: `revoked_at = now` (also in the grace), the last valid key included (`warning: 'last_key'`) |
| `changeOrigins` (C6) | A member's origin adds with any removes sent with them, and `stepUpJwt`, which the API verifies itself (below). The adds are pending `origin_add`s like a staff proposal's, recorded `proposed_by_kind = 'member'` with the verified `proposer_sub`; the removes apply at once in the same batch (their origin_adds end or are cancelled, their rows go); one `origins_version` bump; one `origin.proposed` row (`changes`, and `removed` with `wasInForce`) with `actor_sub`. `bad_request` for an origin both added and removed or a remove that isn't the app's; the add rules are `addOrigins`'s (duplicates, 20 origins counting the removes, `origin_refused`), except the scope-assignment wait, which is staff-only. Not counted by the breaker |
| `proposeChange` (C6) | A member's `policy_set` or `raw_sign_on` with `stepUpJwt` (verified as for `changeOrigins`, the settings-change layout): the staff proposal's rules without the assignment wait; `proposer_sub` and `actor_sub` set |
| `pendingUpgrades` (C14) | `{orgId}` → `{pendingUpgrades}`: the pending-upgrades page's view (D86, D333; `@hana-id/console-core` `pendingUpgradesView`) of the `GET /v1/governance` snapshot (the same isolate cache): `{signer, env, readAtMs, paused, governanceDelayMs, upgrade: {codeHash, proposedAtMs, executableAtMs, due, release: {version, commit, buildCommand, previousCommit, diffCommand} \| null} \| null, ownerTransfer, withdrawal, delayDecreases: [{delay, currentMs, valueMs, effectiveAtMs}], consoleAudienceAdditions, anyPending}`. `release` from the registry `CONTRACT_RELEASES` (null: not a published release). Contract-wide and public on chain, nothing filtered by org and nothing staff-only (no access keys, watchdogs, key changes or cron state); charged to the org's budget (cost 2: the snapshot's D1 batch); `near_unavailable` when a view fails or has an unknown shape |
| `ownerAction` (C6) | `{orgId, body}`: an on-chain owner action relayed through the owner pool exactly as `POST /v1/owner-actions` relays it (the same per-IP limiter fed `clientIp`, precheck, token reservation, caps, usage event, endpoint `ConsoleRpc.ownerAction` in the request log). Console rules on top (D237): the scope must be in `scopes` with the org (`not_found`, before any chain read); the owner token's optional claims are checked strictly (`forbidden`). The claim allow-list holds here as on the endpoint, for the owner token and an `AddClient` proof alike (D274, D277: `token_has_pii`, an RpcCode `forbidden` whose message names the claim; both are public once relayed). A refusal before the relay is an RpcCode (the precheck's code first in `error`: `unknown_change: …`): `owner_nonce_mismatch`, `invalid_client_proof`, `token_used`, `not_owner`, `rate_limited`, `not_found` (scope, change, client), `conflict` (locked, last client, shared login state, a registered or shared client), `forbidden` (token), `near_unavailable` (NEAR or Google's keys), `bad_request`. Once relayed: `{ok: true, status, result?, nearTx?, code?, error?}`, the relay's own answer, a contract panic included (`status: 422`, `code: contract_rejected`). The safety methods may spend the kill-switch reserve |

| `listUsers`, `getUser` (W) | The wallet directory for the org's own scopes only (`scopes.org_id`, D315, D346): `{users: PartnerUser[], nextCursor}` newest first by last seen (`scopeId`, `search` = a wallet address, a User ID `u1_…` (exact case), a Support ID or a full email address (D411, D439: matched exactly, trimmed and lowercased, by `EMAIL_CONSENT_KEY`'s MAC among the `granted` consents of the org's live apps only; a prefix or partial address is `bad_request`), `cursor` = `lastSeenAt:u1_…` from the last page, `limit` ≤ 100), `getUser({orgId, userId: 'u1_…'})` → `{user}`. A `PartnerUser` is `{userId, supportId, scopeId, createdAt, lastSeenAt, accounts: [{kind, status: 'active' \| 'pending'}], wallets: [{chain, address, firstSeenAt, lastUsedAt}], email}` (`email`: the address most recently shared with one of the org's live apps in the user's scope, or `null`; `getUser` adds `emails: [{appId, appName, email, sharedAt}]`, D411): `userId` is the identity token's `sub` (the value the partner's backend stores), `supportId` its short form `HANA-XXXX-XXXX`; never the internal id `hu_…`, a sub, an identity key, or an address the user didn't share. A sub or an internal id as `search` is `bad_request` (and `getUser` with one); another org's user is `not_found`. Cost 1 each |
| `usage` (C12) | `{orgId, from, to, by: 'day' \| 'month', appIds?}` → `{rows: UsageRow[]}`: `usage.org_report` over the writer's `USAGE_DB` (Neon only: no hot-DB statement, no hot-DB cost). Refused before Neon: more than 400 days, `from` after `to`, more than 100 apps (`bad_request`); per member 60 a minute and 1 200 an hour on the `RateLimiter` (`console-report:<user id>`, `rate_limited`); no `USAGE_DB` or a Neon failure is `internal`. C12's optional fields: `linkActions`, `identityTokens`, `relayedRejectedBurntYocto`, `relayedRejectedUsdMicros`, `afterStatement` (D324) |
| `statements` (C12) | `{orgId}` → `{statements}`: `usage.org_statements` (newest first, ≤ 120): `StatementMeta` plus the stored `totals` (checked against console-core `statementTotals`; a mismatch is `internal`) and the files' `csvKey` / `pdfKey` (server-side reads only) |
| `ledger` (C12) | `{orgId, month, asOf?, after?}` → `{rows: LedgerRow[], next?, asOf}`: one page of 1 000 of `usage.org_ledger`, events with `received_at ≤ asOf` (default: now, answered so the caller pins every page to it), keyset `next` = `<request_id>,<at ms>` |

**The API's step-up verification (`changes/step-up.ts`, spec "API verification", D235).** In order, failing closed, before
anything is written or reserved: (1) RS256 signature, issuer and expiry (`@hana-id/oidc`, optional claims strict); (2)
`(provider, aud)` in the on-chain `console_audiences` in force, `get_config` read fresh; (3) `iat` at most 300 s old
and at most 60 s ahead; the token's `sub` equal to the member actor's; only claims of the login tokens' allow-list (no `email`, `email_verified`, `hd`, name, …; D277); (4) after
the plan read (a replayed `requestId` is `already_applied` here, a moved version `version_conflict`, then every input
and state check), the nonce equal to `b64url` of the origin-change layout (signer, app id, sorted normalised adds and
removes, the stored `origins_version`) or the settings-change layout (signer, app id, kind, the 32 `policyId` bytes or
zeros, the stored `settings_version`); (5) `sub` an `Owner::Oidc` of the app's scope, `get_scope` uncached; (6)
`sha256(jwt)` reserved in `owner-actions:tokens` until `exp` (shared with `/v1/owner-actions`). Steps 1–4 are
`forbidden`, 5 `not_owner` (`near_unavailable` when NEAR or Google's keys can't be read), 6 `token_used`. A batch that
then fails or finds the version moved gives the token back (nothing was written). The token, its email and hd are never
logged, returned or stored.

`AdminRpc` has the org methods above for any org (`listApps`, `getApp`, `listChanges`, `removeOrigins`, `turnOff`,
`updateSettings`, `setLogo`, `cancelChange`, `createKey`, `rotateKey`, `revokeKey`), with a Hana actor, no breaker and
no budget, plus:

| `AdminRpc` method | What it does |
|---|---|
| `setMainnetDemo` (D428) | `{orgId, appId, on, expectedVersion}`: the mainnet demo switch, immediate (`settings_version` + 1, an `app_changes` row `mainnet_demo.on`/`.off`; already so → no write). `env_mismatch` unless the Worker's env is a dev env on testnet and the app is a test app. `ConsoleRpc` has no such method. `getApp`'s staff view carries `settings.mainnetDemo` only where it can be set (a partner's view never) |
| `createApp` | Refuses `no_security_contact`; reads `get_scope` uncached (`near_unavailable`): the scope must be registered and every `Owner::Oidc` must be in `orgOwnerSubs`, else `scope_conflict`; an existing scope of another org is `scope_conflict`, of the other environment `env_mismatch`, assigned less than `appChangeDelayMs` ago (with origins) `conflict`. Writes the scope row (if new), the app (`apps.publishable_key` = its first key), the key, and the origins as staff proposals, with the `no_session` candidate only on a scope row it created |
| `assignScopeOrg` | Only a scope in `org_legacy` (else `scope_conflict`), the same owner check; moves every app of the scope (trigger) and sets `assigned_at` |
| `deleteApp` | Soft delete: `deleted_at`, bit 1, every key revoked, pending changes cancelled, pending origin rows deleted; every later write on it is `not_found` |
| `setSuspended` (`bit` 1, 2 or 4), `suspendOrg` | Any bit set or cleared; bit 2 on every non-deleted app of the org (one `app_changes` row for the org) |
| `addOrigins`, `proposeChange` | Staff proposals (`origin_add`, counted with every open `origin_add` for duplicates and the cap, a parked one included; `policy_set` validated by `validateAutoApprovePolicy` against the app's session TTL, `policy_invalid`; `raw_sign_on`, `env_mismatch` on a test app): pending, nothing in force, no waiver; `conflict` within `appChangeDelayMs` of the scope's assignment, for a duplicate origin, past 20 active-or-pending origins, while another change of the kind is pending, or for a value already in force; `origin_refused` by the console-core rules; version + 1 |
| `pendingNotices` | Pending changes not yet announced (oldest first), each with its org's security contacts, the app (`id`, `name`, `orgId`, `scopeId`, `environment`) and a policy's JSON (D226) |
| `ackNotice` | After every send was accepted: `notified_at`, `active_from = now + appChangeDelayMs` (or `now` under a waiver), `cancel_token_hash`, and the origin row's `active_from` or the app's pending policy / raw signing with its `*_effective_at` (a matured pending value is kept as the stored one first). No version bump. Already announced or not pending: `not_pending`. `internal` when the delay var is missing or out of range |
| `expediteChange` | Only an announced, pending, member-proposed change not yet in force (staff proposal `forbidden`, else `not_pending`); `reason` ≥ 20 characters; `active_from = now` and the matching `*_effective_at`; `change.expedited` |
| `setSecurityContacts`, `getSecurityContacts` | 1–10 lowercased emails replacing the set (CAS on the set as read); `org.security_contacts` lists `old` and `new` |
| `listScopes`, `changesSince`, `securityEvents`, `markSecurityEventNotified` | The feeds: scopes by `scope_id` cursor, `app_changes` after a `seq`, security events (all or unnotified), marked once |
| `relayerKeys` | `{keys: [{pool: 'session' \| 'owner' \| 'home', publicKey}], capture, unreadablePools}`: the public keys of every pool, the Home pool's included (H11, readiness 7.4a); never a secret. `capture`: whether this API writes usage events (D596). Each pool is read on its own: one whose secret doesn't parse, or that shares a key with another pool, lists nothing and is named in `unreadablePools` (D598) |
| `governance` (C14) | `{}` → `{governance}`: the whole `GET /v1/governance` snapshot (above; the same isolate cache, so one read serves the endpoint and the RPCs for 10 s), for the "Security & monitoring" view. `hana` only. `near_unavailable` when a view fails or has an unknown shape (nothing partial) |
| `pendingUpgrades` (C14) | `{}` → `{pendingUpgrades}`: the same view as `ConsoleRpc.pendingUpgrades`, for the admin's page. `hana` only |
| `systemStatus` (D425) | `{}` → `{build, hotDb: {ok, latencyMs}, jwksSync: [{job, atMs, outcome, detail}] \| null, notices: {pending, oldestAt, truncated} \| null, relayerKeys: [{pool, publicKey}] \| null, governance: {ok: true, snapshot} \| {ok: false, code}}`: the admin's System status page in one call. `build` the deployed `HANA_BUILD` (null unstamped); `hotDb` a timed `SELECT 1`; `jwksSync` the Google-key sync's last run per provider (`issuer_key_sync_runs`, written by every 15-minute cron run); `notices` the guarded changes pending and unannounced (at most 100 counted); `relayerKeys` public keys only; `governance` the `GET /v1/governance` snapshot (its 10 s isolate cache) or why not. Each part fails on its own (a D1 failure is `ok: false` / null, never a thrown call). `hana` only, read-only, no user data (`apps/api/src/system-status.ts`) |
| `listUsers`, `getUser`, `findUsers` (W) | The wallet directory for staff (D315): `listUsers({orgId?, scopeId?, cursor?, limit ≤ 200})`, `getUser({userId})` or `getUser({internalId})`, exactly one (`not_found`), `findUsers({query, provider?})` (a Stellar or EVM address: every user listing it; a User ID `u1_…`; an internal id `hu_…`, any case; a Support ID, any case, with or without `HANA-` and dashes: every user it is the short form of; else a sub, which `provider` narrows and forces), at most 50. A `StaffUser` is `{userId, supportId, internalId, scopeId, orgId, createdAt, lastSeenAt, identities: [{provider, sub, identityKey, role, status, effectiveAt, firstSeenAt, observedAt, directoryKey}], wallets: [{chain, address, keyIndex, firstSeenAt, lastUsedAt, sharedWith}]}`. `status` is read at answer time (a pending member past `effectiveAt` is `active`). `getUser` and `findUsers` (and so `supportLookup`) add `events` (D428, D430): the user's own rows of `user_events` by internal id, `{kind: 'key_exported' \| 'mainnet_signature', appId, chain, network, address, usdMicros, at}`, newest first, up to 20 **of each kind** (one `ROW_NUMBER()` per user and kind, so reported signatures never push an export out; empty before migration 0013); `listUsers` doesn't. The email isn't here: `directoryKey` `{provider, sub}` is the key for D275's `DirectoryRpc` (C8b) |
| `appNames` (C8b) | `{appIds: string[1..50]}` → `{apps: [{id, name, orgId, scopeId, environment, deletedAt}]}`: the Users screen's app labels (the issuer's directory names apps by id, and `getApp` needs the org); one SELECT, unknown ids left out, deleted apps included. `hana` only (D391) |
| `supportLookup({query, days?})` (C15) | `hana` only, read only (D394). `query`: a Support ID (any case, `HANA-` and dashes optional), a User ID (`u1_…`) or an internal id (`hu_…`), else `bad_request` (a wallet or a sub goes through `findUsers` first); `days` 1–731, 30 by default → `{query: {kind, …}, since, truncated, matches: [{user: StaffUser, apps: [{appId, name, orgId, environment, persistence, deletedAt}], shares: [{appId, keyIndex, createdAt, idleUntil, absExpiresAt, revokedAt, live}], changes: AppChange[]}]}`: every directory user the query names (at most 10 in full, newest first by last seen; `truncated` when more share the code), the scope's apps (deleted ones too), the user's `vault_shares` not past `abs_expires_at` (the account root's path at key index 0 and each key index its wallets show; never a share id, key or counter) and the scope's apps' `app_changes` since `since` (at most 50, newest first). No ledger rows: the admin Worker and the CLI read those as `usage_admin` |
| `userShares({appId, path})` (C15) | `hana` only. The `vault_shares` of `sha256(path)` in the app not past `abs_expires_at`, newest first, at most 100 → `{shares: [{createdAt, idleUntil, absExpiresAt, revokedAt}]}`; the path is hashed, never stored or logged |

| `purgeAudit({before, limit ≤ 1000})` (C13) | `system` only. Deletes up to `limit` `app_changes` rows and up to `limit` `guarded_changes` rows older than `min(before, 60 months ago)` (SQLite's `unixepoch('now', '-60 months')`, the trigger's clock) → `{appChanges, guardedChanges}`. Kept whatever their age (D364): a live app's `migration.baseline` and the rows that end its values (`DRIFT_LEDGER_KINDS`, or a `parts` entry of one), while the app has a baseline, so drift detection never reports a value the baseline explains; open (`pending`, `active`) guarded changes of a live app, and closed ones an origin row still names. Every change of an app deleted 60 months ago goes |
| `deletedApps({before, after?, limit ≤ 1000})` (C13) | `system` only. Apps with `deleted_at ≤ min(before, now − 30 days)`, oldest deletion first, after the cursor `<deleted_at>:<app id>` → `{appIds, next?, more}` (`next`: the cursor after the page's last app; `more`: another page exists). For the ledger's `usage.purge_app_users` |
| `purgeDirectory({before, limit ≤ 1000})` (C13) | `system` only. The wallet directory (0011) of each scope with at least one app deleted at or before `min(before, now − 30 days)` and no app live or deleted since (D363): up to `limit` users with their wallets and identities, and up to `limit` email consents (0014) of apps deleted at or before the cutoff, in one batch → `{scopes, users, wallets, identities, emailConsents}`. A scope with no app row at all is never purged |
| `purgeUserEvents({before, deletedBefore, limit ≤ 1000})` (D433) | `system` only. `user_events` (0013): up to `limit` rows older than `min(before, 24 months ago)` (SQLite's `unixepoch('now', '-24 months')`), and up to `limit` rows of the scopes `purgeDirectory` empties (an app deleted at or before `min(deletedBefore, now − 30 days)`, none live or deleted since), whatever their age, oldest first, in one batch → `{expired, deadScopes}`. Without 0013 (no table) `{expired: 0, deadScopes: 0}`, not an error |

**Waivers at `ackNotice`.** `loopback`: a member's loopback origin (or `http://localhost:*`) on a test scope in a dev
env on a non-production network. `no_session`: a candidate is a member proposal with an API-verified step-up
(`proposer_sub` set, only by `changeOrigins` / `proposeChange` after the verification above) or one of `createApp`'s
initial origins on a scope row it created. It is granted inside the acking statements while the scope shows no user:
`first_session_at` NULL, no origin of the scope's apps in force except those of the same request, none that a ledger
row records as removed while in force (`origin.removed`, or the `removed` of an `origin.proposed`, D235), and no vault
share, session marker (migration 0009; the legacy `usage` rows until batch C4, D220) or identity count for an app of
the scope.
Anything else gets the full delay. Hana proposals never get `loopback`.

**Compare-and-swap writes (`changes/cas.ts`).** Every write is one D1 batch. Its first statement inserts the write's
`app_changes` row, but only while the predicate holds (the expected version, the key or change as read). A row with
the same `requestId` that already exists also makes it insert, which fails on `request_id UNIQUE` and aborts the
batch: a replay writes nothing. It is `already_applied` when the stored row is the same write (its kind, app and
actor), `conflict` when the request id was used for another write. Every later statement runs only if that row
exists. If the commit inserted nothing, the state moved since the plan read (`version_conflict`, nothing written). The
plan read also answers a replay found before the batch.

**The legacy `apps.publishable_key` (D225).** The API never reads it. The key writes keep it on the app's oldest key
with `revoked_at` NULL, or on a tombstone (`pk_<env>_0revoked…`, never a valid key) when there is none. `deleteApp`
sets the tombstone. A deleted app keeps bit 1, and the CLI refuses `app:resume` on it, so `status` stays
`suspended`. Readers that still use the column and `status` (`apps/email-issuer` until it moves, D206) then never
accept a revoked, rotating or deleted app's key.

**Breaker and budget (`changes/guard.ts`, object `console-rpc`).**
- **Budget.** Every member call first takes its cost (`CONSOLE_COSTS`: its plan read, batch and one diagnostic read,
  1–8 statements; `ownerAction` 2: its scope-in-org read and a cap's event). It comes from its org's bucket (10/s, burst 40) and from the global one (the spec's 30/s, burst
  60). The kill switches (`removeOrigins`, `turnOff`, `revokeKey`, `setSuspended(true)`) may spend the last 10 of
  the org's bucket and the last 20 of the global one; every other call must leave them. One org takes at most 12
  tokens of the global reserve in any minute. A kill switch that changed nothing (the outcomes below, or a no-op)
  gives back what it took of the global reserve, which is charged to its org's own bucket instead (that bucket may go
  below zero, and the org's ordinary calls then wait). So neither one org nor a flood of reads, settings writes or
  empty kill switches can starve another org's kill switches.
- **Breaker.** `setSuspended(true)`, `revokeKey`, `rotateKey`, `removeOrigins` and a `googleWebClientId` change (not
  `changeOrigins`' removes, which need an on-chain owner's token) also take a slot in their org's rolling hour (5) and the global one (20). A call that changed nothing gets its slot
  back: `not_found`, `conflict`, `version_conflict`, `already_applied`, `bad_request`, or a no-op.
- **Refusals.** Over any limit, the call is `rate_limited` and writes nothing. The first breaker refusal of a limit
  in a clock hour writes a `breaker` security event; the object remembers it, so later refusals write nothing.
- **Emailed-link cancels** never touch the members' budget. Each takes a slot from a per-client-IP limiter (object
  `cancel-link:<v4 address | v6 /64>`, 5 a minute and 50 a day), then one token of the link-read budget (one D1 read
  each: 50/s, burst 100). Both are taken before the token is read, and nothing limits the cancel after that: one
  whose token verifies on a pending change always runs. A token that isn't canonical b64url is `forbidden`, like a
  wrong one.
- **Statement cap.** A call is held to two reads and one batch of at most eight statements (`changes/db.ts`; going
  over is a bug, answered `internal`).

### `AdminRpc.linkStats` (build plan batch 9, D445)

Staff or a `system` actor (the 15-minute cron) only. `{actor, requestId, clientIp, days?: 1..31 (14), appId?}` → `{rows: LinkStatsRow[]}`,
newest first, at most 2000: `{appId, day, appName, orgId, environment, proposed, linked, activated, cancelled, unlinked, auto, explicit}`
from `link_usage` (migration 0015), per app and UTC day. Counts only. Written by `countLinkUsage` after the response of every relayed
session-pool call, from the NEP-297 lines of receipts the signer executed.

### `IssuerRpc` (entrypoint, no route; the email issuer only; D434)

`IssuerRpc` (`src/rpc/issuer.ts`, readers in `src/issuer-apps.ts`) is a third `WorkerEntrypoint` of the API Worker,
bound only by the email issuer (service binding `API`, `apps/email-issuer/scripts/gen-wrangler.ts`). It replaced the
issuer's read-write `APP_DB` binding of this D1 (D251, readiness row 7.1d): the issuer binds no API D1. It has no
actor, budget or breaker (the issuer's own per-IP and per-app limits run first, as they did over `APP_DB`), and only
three methods, each one strict object in (`@hana-id/console-core` `issuer-apps.ts`) and one or two SELECTs:

| Method | Input | Answer |
|---|---|---|
| `appByKey` | `{pk}` (`pk_test_` / `pk_live_` + base58) | `{ok: true, app: IssuerApp \| null}`: by the gate's model (an `app_keys` row not revoked or in its rotation grace on the API's clock, an undeleted app); `null` for an unknown, revoked or deleted app's key |
| `appById` | `{appId}` (`[A-Za-z0-9_-]{1,96}`) | `{ok: true, app: IssuerApp \| null}`: an undeleted app |
| `scopeHasEmailApp` | `{scopeId}` (`[a-z0-9]{1,64}`) | `{ok: true, hasEmailApp}`: an active, undeleted app of the scope with email on (at most 50 apps read) |

`IssuerApp` is `{id, name, scopeId, active, emailOn, perMinute, perDay, googleWebClientId}`: `active` needs no
suspension bit, the legacy `status` active and (by key) the key's prefix naming the scope's environment; `emailOn`
needs `login_methods` to list `email` (false for every app before migration 0010). A bad input is
`{ok: false, code: "bad_request"}`, a D1 error `{ok: false, code: "internal"}`; only those are logged (`event: "rpc"`,
`method: "issuer.<name>"`, never the key, app or scope). The issuer fails the request closed on any non-`ok` answer
(`503 api_unavailable`, below).

AddClient of the provider `email` takes the issuer's JWS JSON client proof (`aud` `email:<scope>`, `sub` `hana-client-proof`, the client-proof nonce), checked against `EMAIL_PUBLIC_KEYS` and the on-chain signer policy (D447); `remove_client` of the email client works like a Google client's.

## Relayer pools and gas (`src/relayer-config.ts`, `src/gas.ts`)

| Pool | Secret | Durable Object names | Methods | Used by |
|---|---|---|---|---|
| session | `RELAYER_KEYS` | `relayer-key-<i>` | `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `link_identity`, `cancel_link`, `unlink_identity` (L) | `/v1/sessions`, `/v1/login`, `/v1/derive`, `/v1/sessions/revoke`, `/v1/link*` |
| owner | `OWNER_RELAYER_KEYS` | `owner-relayer-key-<i>` | `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change` | `/v1/owner-actions` |

Keys are function-call keys on `RELAYER_ACCOUNT`, receiver `SIGNER_ACCOUNT`, no deposit. A key of the pool is picked
round-robin (random start per isolate), except for a session-signed request (`/v1/derive`, `/v1/sessions/revoke`,
`/v1/login`, `/v1/sessions`): that goes through the key selected by an HMAC of its session key under the pool's secret
(`claimKeyIndex`), so a client can't choose it, and every copy of a request reaches one object, which relays one of them
(D455; a copy gets the endpoint's own `409 counter_used` or `409 session_exists`, with no transaction). If a claimed
relay did not execute on that key (`near_rejected`, `near_unavailable`, `relayer_busy`, or `relayer_unavailable` with
no `nearTx`), `relay()` tries it once more on the next key with the same claim (log `relay_failover`), so a bad key no
longer strands the sessions pinned to it; a one-key pool has no next key. A session's own requests stay on its key, at
most the contract's `MAX_USES` per session. The lists hold only what an endpoint relays (D456). The allowlist is enforced in `relay()` and again in the object (`400
method_not_allowed` otherwise). The session list is allowlist state 1 of `docs/batch-b-spec.md` ("Relayer
allowlists") plus the three link methods (email login batch 6; on chain the keys are deleted and re-added,
`docs/operations.md` "Email login on sandbox-dev").

Gas attached (Tgas; `GAS_<METHOD>_TGAS` var overrides with an integer 1..300, invalid values logged and ignored):
`create_session` 100, `create_session_and_derive` 150 (250 with a `link_jwt`, override
`GAS_CREATE_SESSION_AND_DERIVE_LINKED_TGAS`), `derive_key` 60, `revoke_session` 20,
`link_identity` 250, `cancel_link` and `unlink_identity` 150 (the session and link values cover 4096-bit issuer keys,
D155), plus 70 per token signature beyond what the default covers (a 2-of-2 email token: one per token at the
default; D250), owner methods 50; every value capped at 300. The cron's calls use 30 Tgas with `KEYS_UPDATER_KEY` (on
`SIGNER_ACCOUNT`, not a pool).

**Updater key (G).** `KEYS_UPDATER_KEY` signs only `UPDATER_METHODS` = `set_issuer_key`,
`propose_issuer_key_removal`, `execute_issuer_key_change` (`relayer-config.ts`, the contract's list; the key itself is
a function-call key the contract installed with exactly these, `add_updater_key`). Never `remove_issuer_key`
(owner-only since G). `GOVERNANCE_METHODS` lists every owner, watchdog and governance method; the tests prove that
neither pool nor `/v1/owner-actions` relays any of them or any updater method.

Transactions are answered at `EXECUTED_OPTIMISTIC` (not finality); `tx` is polled every 400 ms for up to 60 s.

## Durable Objects

All SQLite-backed (wrangler migrations `v1`: `RelayerKey`, `RateLimiter`; `v2`: `LoginRelay`).

**Names and placement (`src/placement.ts`).** With manifest `cloudflare.durableObjectLocation` set (var
`DO_LOCATION_HINT`, one of `wnam enam sam weur eeur apac oc afr me`), shared objects get the suffix `@<hint>` and are
created there: `relayer-key-0@apac`, `owner-relayer-key-0@apac`, `app:<appId>@apac`, `owner-actions:global@apac`,
`owner-actions:scope:<scopeId>@apac`, `owner-actions:execute:<scopeId>@apac`, `owner-actions:owner:<hash>@apac`,
`owner-actions:cancel:<scopeId>@apac`, `owner-actions:cancel-global@apac`, `owner-actions:tokens@apac`,
`identity:global@apac`, `identity:scope:<scopeId>@apac`, `console-rpc@apac` (C5: every ConsoleRpc call's breaker and budget, and the global link bucket), `identity-proof:<hex sessionPk>@apac` (one per session key:
its proofs' single-use markers, deleted by the object's alarm once expired). Unset or unknown hint: no suffix, Cloudflare places them. Changing
the hint creates new objects (fresh limiter counters; new relayer objects read their nonce from chain once). Never
suffixed: per-IP limiters `ip:v4:<addr>` / `ip:v6:<prefix>::/64` and `cancel-link:v4:…` / `cancel-link:v6:…` (C5) (created near the client) and `LoginRelay` objects
(named by `relayId`).

| Class | State (KV keys) | Notes |
|---|---|---|
| `RelayerKey` | `publicKey`, `nonce` (reservation R), `block` `{hash, at}` | One per pool key; refuses a second pool or index |
| `RateLimiter` | `<window>@<windowStart>` → count; `mark:<sha256>` → until ms; on `console-rpc` (C5) `console:bucket`, `console:bucket:org:<orgId>`, `console:link-read` → `{tokens, at}`, `console:reserve:org:<orgId>` → `{at, n}` reserve takes of the last minute, `console:breaker:org:<orgId>` and `console:breaker:global` → call times of the last hour, `console:noticed:*` → the hour of the last breaker event | Windows pruned by the next `hit` of the same limit, which lists only that limit's keys; markers deleted by the object's alarm once they end (D475), refused only while live |
| `LoginRelay` | `slot`: `full` / `consumed` / `expired` | Alarm at write + 120 s, then + 120 s |

**Nonce reservation (`relayer-key.ts`).** A promise-chain mutex covers only *nonce → sign → reserve → start
`send_tx`*; outcomes are awaited outside it, so many txs per key are in flight. Storage holds R ("no tx of this key
was ever sent with a nonce above R"). A nonce n > R first writes R' = n + 99 and waits for `storage.sync()`, so one
relay in 100 waits for a confirmed write. Cold start (instances are evicted after ~10 s idle): with an R stored for
this key's public key, start at R with no chain read (skips up to 99 nonces) and reuse the stored block hash if under
5 min old; without one (new or replaced key), read the access-key nonce and a final block. `InvalidNonce` → re-read
`max(local, chain, ak_nonce)` and retry once; `Expired` → refresh the block and retry once; a tx superseded twice
2 s apart while unknown → `dropped`, resent once with a fresh nonce.

## Chain views and caches (per isolate, `src/views.ts`)

| View | Cache |
|---|---|
| `get_session` | 10 s; misses not cached; a refusal from cache is re-read fresh |
| `session_key_in_use` | "in use" from a cached unexpired session; "not in use" always fresh |
| `scope_for_client` | 60 s, a miss 10 s; dropped for the scope after an owner action relayed here |
| `get_scope` | 10 s; dropped after an owner action. Read uncached by the owner-action precheck (its `action_nonce`) and by the RPC's owner and client checks |
| `get_scope` for `GET /v1/home/apps` (H2) | At most about 70 s (60 s here on top of the 10 s `get_scope` view, D500), "no such scope" 10 s; dropped after an owner action. Display only |
| `get_config` | 60 s; 10 s while it says `paused` (G); concurrent misses share one read. Read fresh (and the cache refreshed) by the guarded-change step-up check (its `console_audiences`) |
| `get_issuer` (G) | 60 s per provider; a kid not in the set re-reads it at most every 10 s; concurrent misses share one read |
| `get_self_issued` (L, `src/link-views.ts`) | 60 s per provider; a token kid it doesn't list re-reads it at most every 10 s; concurrent misses share one read |
| `get_identity`, `get_account` (L) | never cached (each link precheck reads them fresh) |
| `GET /v1/governance` snapshot (G) | 10 s, `governance-status.ts` |
| Google JWKS | `max-age` clamped to 5 min..6 h; unknown kid refetches at most once a minute; 10 s back-off after a failure; a stale set serves its kids up to 6 h past expiry. Each successful fetch is recorded in `issuer_key_observations` after the response |

## D1 schema (`apps/api/migrations`)

| Table | Key columns | Migration |
|---|---|---|
| `scopes` (added, H2) | `home_quiet` 0/1 (default 0; CHECK): the quieter listing (D98 item 8, D502), set by `admin home:listing`; partial index `scopes_home_listed (environment, scope_id) WHERE first_session_at IS NOT NULL AND home_quiet = 0` | 0016 |
| `hana_held_clients` (H2) | (`provider`, `aud`) PK, `scope_id` (indexed), `added_at`: the Google clients Hana holds for an Enterprise scope (D42, D503), written by `admin home:client:add`; `home/coverage.ts` reads it for `hana_client`, only for a client the chain still lists in the scope. Public values, no user data | 0016 |
| `link_usage` | `(app_id, day)` PK, `proposed`, `linked`, `activated`, `cancelled`, `unlinked`, `auto`, `explicit` (batch 9, D445; counts only, `ON DELETE CASCADE` with the app) | 0015 |
| `plans` | `id` PK, `per_minute`, `per_day`, `per_ip_minute` (default 20); seeds `free` 60 / 5000 / 20 | 0001 |
| `apps` | `id` PK, `name`, `scope_id` (indexed), `publishable_key` UNIQUE, `status` `active`/`suspended`, `plan` → plans, `created_at` ms | 0001 |
| `apps` (added) | `persistence` `session`/`none` (default `session`), `session_ttl_ms` 1 h..23 h 50 min (12 h), `idle_ttl_ms` 15 min..session TTL (2 h), `raw_sign` `off`/`approval` + `raw_sign_pending`, `raw_sign_effective_at`, `auto_approve_policy` / `auto_approve_pending` (JSON) + `auto_approve_effective_at`, `google_web_client_id` | 0003 |
| `app_origins` | (`app_id`, `origin`) PK, `origin` indexed; `http://localhost:*` wildcard allowed (0006 adds `active_from`, `change_id`, below) | 0001 |
| `usage` (legacy) | (`app_id`, `day` `YYYY-MM-DD` UTC) PK, `sessions`, `derives`. **Not written since batch C4** (usage goes to the Neon ledger, "Usage capture"); kept until C4b exports it and 0007 drops it | 0001 |
| `usage` (added) | `unlocks` | 0003 |
| `issuer_key_missing` | (`provider`, `kid`) PK, `first_missing_at` ms | 0002 |
| `issuer_key_observations` | (`provider`, `kid`) PK, `first_seen_jwks_ms`, `last_seen_jwks_ms`, `removed_jwks_ms` (first fetch without the kid after `last_seen`; cleared if it reappears), `first_token_ms` (first verified token by the kid), `max_age_s_last` (the JWKS Cache-Control max-age when last listed); all nullable, ms / s. Public data only (no token, `sub` or user data). D33's key lead time (`admin issuer-keys:lead-times`) | 0004 |
| `issuer_key_proposals` (G) | (`provider`, `kid`, `op` `Add`/`Remove`) PK, `change_id`, `proposed_at` ms, `cancelled_seen_at` ms: changes the JWKS cron proposed and hasn't seen resolved | 0005 |
| `issuer_key_sync_runs` (G) | `provider` PK, `at_ms`, `outcome` `ok`/`error`/`skipped`, `code`, `summary` (JSON `SyncResult`): the cron's last run, for `GET /v1/governance` | 0005 |
| `identity_issuance_hourly` (I) | (`hour` ms at the UTC hour, `kid`) PK, `count`: tokens signed per key and hour (the KMS reconciliation, build step 7); 24 months | 0008 |
| `identity_usage` (I) | (`app_id` → apps, `day` `YYYY-MM-DD` UTC) PK, `tokens`: the spec's `usage.identity_tokens`, kept out of the legacy `usage` table batch C's 0007 drops; 24 months | 0008 |
| `scopes` (C) | `scope_id` PK, `org_id`, `environment` `test`/`live` (fixed: a trigger refuses a change), `first_session_at` ms (NULL until the first session-pool relay attempt), `created_at`, `assigned_at` ms (the last org change) | 0006 |
| `apps` (added, C) | `org_id` (default `org_legacy`; a trigger keeps it equal to its scope's), `suspended_by` 0..7 (bitmask; a trigger sets `status` from it), `origins_version`, `settings_version` (compare-and-swap counters), `logo_key`, `deleted_at` (soft delete); index `apps_org_id`. Inserting an app needs its `scopes` row in its org with the environment its key's prefix names (trigger); changing one app's `org_id` or `scope_id` alone is refused, moving a scope's org moves all its apps | 0006 |
| `app_keys` (C) | `id` PK (`key_…`; `key_legacy_<app id>` for the key each app had before 0006), `app_id`, `key` UNIQUE, `created_by`, `created_at`, `revoked_at` (may be in the future), `revoked_by`; the insert trigger needs the app and the prefix of its scope's environment | 0006 |
| `app_origins` (added, C) | `active_from` ms (NULL: not announced, never matches; 0: migrated), `change_id` → `guarded_changes.id` | 0006 |
| `guarded_changes` (C) | `id` PK (`gc_…`), `app_id`, `kind` `origin_add`/`policy_set`/`raw_sign_on` with its `origin` or `policy_json` + `policy_id`, `status` `pending`/`active`/`cancelled`/`ended`, the proposer (`member`/`hana`/`system`, id, step-up `sub`, time, country), `waiver` `loopback`/`no_session`, `notified_at`, `active_from`, `cancel_token_hash`, `activated_recorded_at`, expedite and end/cancel fields, `request_id`; indexes by app and status, unnotified, due | 0006 |
| `app_changes` (C) | `seq` PK, `at`, `org_id`, `app_id`, `scope_id`, `kind`, `detail_json` (valid JSON, allowlisted fields), `actor_kind` `member`/`hana`/`system`/`link`, `actor_id`, `actor_sub`, `request_id` UNIQUE. Append-only: UPDATE refused, DELETE refused until a row is 60 months old (triggers). 0006 wrote one `migration.baseline` row per app (its origins, stored policies as stored, raw-signing values, suspension) | 0006 |
| `security_events` (C) | `id` PK, `detected_at`, `kind` `drift`/`breaker`/`owner_cap`/`owner_allowance_low`/`home_budget_high` (0018, D541: `{day, derives, ceiling, thresholdPct}`, counts only), org/app/scope, `detail_json`, `notified_at` | 0006, 0018 |
| `org_security_contacts` (C) | (`org_id`, `email` lowercased) PK, `added_by`, `added_at` | 0006 |
| `session_markers` (C) | `app_id` PK → apps, `first_at` ms: written once, when the relay of a session-pool request on a scope with no `first_session_at` settled; the `no_session` waiver's sign besides `first_session_at` (D220). No user data | 0009 |
| `apps` (added, H2, 0016) | `first_login_at` ms or NULL: the app's first successful login (Google or email), written once by `markFirstLogin` while the gate read it as NULL; no write after that. NULL hides the app from anyone but its scope's own users in `GET /v1/home/apps` (D462). Backfilled from session markers, vault shares, user events, identity tokens and email sessions |
| `apps` (added, L) | `login_methods` `'google'` (default) / `'email'` / `'google,email'` (CHECK): the sign-in methods the app offers (read only by `GET /v1/app` and for email tokens, never in the gate; the email issuer reads it too) | 0010 |
| `email_usage` (L) | (`app_id` → apps, `day` `YYYY-MM-DD` UTC) PK, `email_sessions`, `links`: email logins and new links per app and day, as `identity_usage`; copied hourly to the ledger's `usage.email_counts` (D233) | 0010 |
| `end_users` (W) | `user_id` PK (the internal id: `hu_` + 26 Crockford base32 characters of the uid of the account root, D312; staff only), `token_sub` (the User ID partners see: the identity token's `sub`, `u1_…`, 25 characters; unique, D346), `support_code` (the Support ID's 8 characters: Crockford base32 of the first 5 bytes of `token_sub`'s 16; indexed), `scope_id`, `created_at` (MIN), `last_seen_at` (MAX); indexes by scope and by recency, ties by `token_sub`. Personal data (pseudonyms per scope) | 0011 |
| `end_user_wallets` (W) | (`user_id` → end_users, `chain` `stellar`/`evm`/`near` (0019, D756), `address`: 42 to 64 characters, a NEAR implicit account id 64 lowercase hex) PK, `key_index`, `first_seen_at` (MIN), `last_used_at` (MAX: the last login that recorded it; both are the client's `issuedAtMs`, ±5 min, so never a basis for a choice); index on `address` (a Stellar or EVM address may be under several users: a reused key); unique `end_user_wallets_one_near` on (`user_id`, `key_index`) where `chain = 'near'` (D762) | 0011, 0019 |
| `end_user_identities` (W) | (`scope_id`, `identity_key` hex) PK, `user_id` → end_users (indexed), `provider`, `sub` (NULL for a member seen only on chain; indexed), `role` `root`/`member`, `status` `active`/`pending`/`unlinked`/`cancelled`, `effective_at` (a member's link; pending reads as active once passed), `first_seen_at`, `observed_at` (a write lands only when no older than the row's). Holds Google and email `sub`s: staff only; `ConsoleRpc` never selects `sub` or `identity_key` | 0011 |
| `apps.mainnet_demo` (D428) | 0/1, default 0: Hana staff's switch for the mainnet demo exception to D39 (`AdminRpc.setMainnetDemo`, `admin app:settings --mainnet-demo`); triggers `apps_mainnet_demo_test_only_insert`/`_update` refuse 1 for an app whose scope isn't `test` | 0013 |
| `user_events` (D428, D430) | `id` PK, `kind` `key_exported`/`mainnet_signature`, `app_id` (NULL only for a `key_exported` row, a Hana Home derive: D520, 0018), `scope_id`, `user_id` (`hu_…`; required for both kinds), `chain` (`stellar`/`evm`, and `near` for a `key_exported` row only since 0019, D759), `network` (EVM chain ID or `pubnet`), `address` (a signature's wallet), `usd_micros`, `request_id`, `at`; indexed by user, by address and by app. No key, token, signature, bytes or path. Personal data (an internal id or an address with times): kept 24 months, and no longer than its scope's wallet directory (the monthly job's `AdminRpc.purgeUserEvents`); an erasure request (`uid-erase`) deletes the user's rows by internal id and by each of their wallet addresses (D433) | 0013 |
| `home_usage` (D523, D540, 0018) | `day` PK (`YYYY-MM-DD`, UTC), `unrecorded` (those held to the 20% share, D540), `derives` (Home derives of that day): incremented atomically by `POST /v1/home/login` right before it relays, refused at `HOME_DERIVES_PER_DAY`. A count only, one row a day: nothing personal |
| `apps` (added, I) | `identity_email` `'off'` (default) / `'on_request'` / `'at_login'` (CHECK): when Hana asks a user to share their address with the app (D411). Read beside the gate (`GET /v1/app`, the mint, the consent endpoints; an API before 0014 reads `'off'`), written by `updateSettings` and `app:settings --identity-email` | 0014 |
| `email_consents` (I) | (`app_id`, `user_sub` `u1_…`, `email_mac` BLOB(32)) PK, `state` `granted`/`declined`, `email` (the shared copy: set exactly while `granted`), `scope_id`, `decided_at`; indexes on `user_sub` and (`email_mac`, `state`). `email_mac` = HMAC-SHA256(`EMAIL_CONSENT_KEY`, `"hana-id/email-consent/v1" ‖ 0x00 ‖ lowercase address`). Personal data: read by the mint and `ConsoleRpc` (granted rows of the org's live apps), deleted by `uid-erase` and 30 days after the app's deletion (`purgeDirectory`) | 0014 |
| `vault_shares` | `share_id` BLOB(16) PK, `app_id`, `session_pk` BLOB(32) UNIQUE, `path_hash` = sha256(path), `partner_origin`, `share_enc` = iv ‖ AES-GCM(KEK, K_s, aad = share_id ‖ app_id ‖ session_pk), `kek_id`, `counter`, `created_at`, `idle_until`, `abs_expires_at`, `revoked_at`, `device_label` (0017: a coarse "Chrome on macOS", or null, D512); indexes (`app_id`, `path_hash`), `abs_expires_at`, `kek_id`, `path_hash` (0017) | 0003, 0017 |
| `vault_consents` (H4) | `consent_id` BLOB(16) PK, `app_id` (cascade), `share_id` BLOB(16) or NULL in `'none'` mode (no foreign key: a consent whose share row is pruned reads `revoked`), `session_pk` BLOB(32), `path_hash` = sha256(path), `partner_origin`, `policy_id` BLOB(32), `label` (the policy's, ≤ 80 chars, text only), `granted_at`, `expires_at`, `revoked_at`, `revoked_by` `device`/`home`/`share`; partial UNIQUE (`session_pk`) where not revoked (one active consent per session key); indexes `path_hash`, `expires_at`, partial `revoked_at`. No `sub`, address, key or token | 0017 |

## Cron (`*/15 * * * *`)

One trigger every 15 min (the free plan allows 5 cron triggers per account; this keeps the API at one). Independent
jobs (one failing doesn't skip the others):

- **Google JWKS → contract, every run** (`issuer-keys.ts`, G; the governance spec's P = 15 min). Issuer keys change
  on chain only through a public, cancellable delay (`docs/contract-interface.md` "Issuers"). Each run fetches the
  JWKS (recorded in `issuer_key_observations`, with or without the key), reads `get_issuer`, `get_key_changes` and
  `get_config`, then, signed with `KEYS_UPDATER_KEY`:
  1. **executes** (`execute_issuer_key_change`) each matured change of the provider (`executable_at_ms ≤ now`) that
     agrees with this fetch: an Add whose `n`, `e` equal Google's key for that kid (after stripping leading zeros),
     a Remove of a kid Google no longer lists, never one that would leave no active key; none while paused (or when
     `get_config` can't be read). Changes it disagrees with are left to the watchdog and the owner (the cron can't
     cancel). A change someone else applied or cancelled meanwhile is a race (`execute_raced`), not a failure;
  2. **proposes** an Add (`set_issuer_key`) for each JWKS kid that is neither active nor pending, within the
     contract's caps (≤ 6 pending changes over all issuers, active + pending adds ≤ 10);
  3. **proposes** a Remove (`propose_issuer_key_removal`) for each active kid missing from every fetch for ≥ 24 h
     (`issuer_key_missing`), unless it signed a verified token in the last 24 h (`issuer_key_observations.last_token_ms`,
     migration 0012; note `recent_token_kept`), already has a pending change, would leave the issuer without an active
     key (active − pending removals ≥ 1 always), or an Add proposal of this run failed.
  Each run fetches the JWKS 3 times (`JWKS_FETCHES_PER_RUN`): a kid any fetch lists is published, a kid is missing only
  when all 3 succeeded and none listed it. A run with a failed or empty fetch neither starts, resets nor completes a
  removal, and executes no matured Remove (note `removal_evidence_incomplete`); a matured Remove of a kid that signed a
  token in the last 24 h isn't executed either (rollout hysteresis, D422: Google's edges serve different key sets
  during a rotation).
  It never calls `remove_issuer_key`. Proposals and executions are judged against the state read at the start of the
  run (a kid with any pending change gets no new proposal; the caps count every pending change), so what an
  execution frees is used by the next run. Each proposal is remembered in `issuer_key_proposals` with its change id
(a pending change by the signer account it has no row for, e.g. a send whose outcome it never saw, is adopted);
  one that later is neither pending nor applied was **cancelled** (owner or watchdog): logged once at error level
  (`issuer_key_change_cancelled`), and that kid and op is not proposed again for 1 h (`REPROPOSE_AFTER_CANCEL_MS`,
  note `held_after_cancel`). The run's result is written to `issuer_key_sync_runs` for `GET /v1/governance`.
  Skips (nothing sent): `jwks_fetch_failed`, `jwks_empty`, `no_keys_updater_key` (warn), `get_issuer_failed`,
  `issuer_not_configured`, `key_changes_unavailable` (the view failed or is malformed; also a contract still on v1),
  `bad_keys_updater_key`.
- **Vault maintenance, the run in the first quarter of each UTC hour** (`index.ts` `isHourlyRun`; `vault/cron.ts`,
  B): deletes shares past `abs_expires_at` or revoked once they are older than 24 h (the contract's `MAX_SESSION_MS`:
  until then a dead share is the identity token's tombstone, D178); deletes consents past `expires_at` and share consents
  revoked more than an hour ago (a `'none'`-mode consent stays until it expires: it's its own replay check, D510); re-wraps up to 2000 rows from `VAULT_KEK_PREVIOUS` to
  `VAULT_KEK`; counts rows under a KEK id neither key has (logged as an error).
- **Identity counts' retention, the same hourly run** (`identity/maintenance.ts`, I): deletes `identity_issuance_hourly`
  and `identity_usage` rows older than 24 months (D90).
- **Usage partitions, the same hourly run** (`usage/partitions.ts`, C4): with `USAGE_DB`, `usage.ensure_partitions(12)`
  as the writer (migrations-usage 0003), so the ledger always has its next 12 months; a failure is logged
  (`usage_partitions_failed`) and never fails the run. Runs before the identity copy.
- **Identity counts to the usage ledger, the same hourly run** (`usage/identity-sync.ts`, C4): with `USAGE_DB`, copies
  the last 7 UTC days of `identity_usage` (with each app's org and scope) to `usage.identity_tokens` through
  `usage.record_identity_tokens` (500 rows a call), which keeps the larger count per app and day; a failure is logged
  (`identity_usage_sync_failed`) and repaired by the next run. It never fails the cron run (D223).
- **Email counts to the usage ledger, the same hourly run** (`usage/email-sync.ts`, L): the same for `email_usage`
  (email sessions and new links per app and day) into `usage.email_counts` through `usage.record_email_counts`
  (migrations-usage 0004; the larger count of each column kept); `email_usage_sync` / `email_usage_sync_failed` (D233).
- **Guarded changes, the same hourly run** (`guarded/cron.ts`, C): nothing waits for it (an origin is in force by
  `active_from <= now`, a policy or raw signing by batch B's `*_effective_at`), so it changes no answer the gate gives.
  For each announced pending change whose `active_from` has passed (≤ 100 a run; the reads already answer it `active`, D701): records it once (`status = 'active'`,
  `activated_recorded_at`, `app_changes <kind>.activated`, actor `system`/`cron`); a `policy_set` moves the matured
  `auto_approve_pending` into `auto_approve_policy` (pending columns cleared) and ends the `policy_set` it replaced
  (`policy.ended`); a `raw_sign_on` sets `raw_sign = 'approval'` (pending cleared). A due change whose value is no
  longer in force or pending in `apps` (cleared by a direct write) is cancelled (`change.cancelled`, reason
  `not_in_force`). A change not announced within 7 days of its proposal is cancelled by `system` (reason
  `not_announced`): its `app_origins` row is deleted and the app's version bumped. Each change is one D1 batch whose
  writes after the first depend on the first, and each ledger row has a request id derived from the change, so
  overlapping runs record a change once.
- **Owner-pool allowance, the same hourly run** (`owner-pool.ts`, C6). One `view_access_key_list` of `RELAYER_ACCOUNT`:
  each `OWNER_RELAYER_KEYS` key below 25% of its initial allowance (`OWNER_POOL_ALLOWANCE_YOCTO`, default 0.5 NEAR,
  deploy-contract's `--owner-relayer-allowance` default), or missing from the account, writes an `owner_allowance_low`
  security event (`{publicKey, allowanceYocto, missing, initialYocto, thresholdPct, day}`), once per key and UTC day.
  A full-access key or an unlimited allowance is skipped. NEAR down is logged (`owner_allowance_check`) and never
  fails the run.
- **Drift detection, the same hourly run** (`changes/drift.ts`, C5). It checks that every origin in force is explained
  by an announced `origin_add` whose clock had passed when the row came into force, or by the 0006 baseline
  (`active_from = 0`, listed in `migration.baseline`). It checks that every stored or pending policy and every
  raw-signing enable is explained by an announced change (a stored value by one in force by then; a pending value by
  one whose `active_from` is no later than its `*_effective_at`), or by the baseline. A baseline value counts only
  while no later `app_changes` row ended it (`origin.removed` or the `removed` of a member's `origin.proposed`,
  `policy.removed` / `.activated` / `.pending_dropped`, `raw_sign.off`). Keys, suspension bits and deletion aren't checked. Anything else is a direct D1
  write: it gets a `drift` security event, once per finding (the id is derived from the finding), at most 100 per
  kind per run. An `app.created` row alone explains nothing (D228).

## Configuration (Worker bindings)

Vars are generated from `envs/<env>.json` by `apps/api/scripts/gen-wrangler.ts` into `apps/api/wrangler.jsonc`
(gitignored, per env; the tests generate their own `wrangler.vitest.jsonc`); secrets are set with
`wrangler secret put` (`VAULT_KEK` through `scripts/vault-kek.ts`). Schema: `packages/env/src/schema.ts`; types: `apps/api/src/env.ts`.

| Binding | Kind | Source | Notes |
|---|---|---|---|
| `NEAR_RPC` | var | `rpc` | |
| `NEAR_RPC_FALLBACK` | var, optional | `rpcFallback` | only written when set; the vault page's and the export page's `connect-src` (the API's own fallbacks are `NEAR_RPC_FALLBACKS`) |
| `NEAR_RPC_FALLBACKS` | var, optional | `apiRpcFallbacks`, else `[rpcFallback]` | a JSON array of URLs, written only when non-empty: the endpoints the API asks after `NEAR_RPC`, in order ("RPC view timeout and failover", D435); entries that aren't http(s) URLs or repeat one are dropped, at most 3 kept |
| `SIGNER_ACCOUNT` | var | `signer` | only receiver ever called |
| `RELAYER_ACCOUNT` | var | `relayer` | pays gas |
| `ENV_NAME` | var | `name` | `local*` / `sandbox*` = dev env |
| `MPC_ACCOUNT` | var | `mpc` | `/v1/login` failure mapping |
| `VAULT_ORIGIN`, `AUTH_ORIGIN` | var | `vaultOrigin`, `authOrigin` | `gen` refuses an env without both |
| `API_URL` | var | `apiUrl` | vault page `connect-src` |
| `EMAIL_ISSUER_URL` | var, optional | `emailIssuer.url`, else `apiUrl` (only with an `emailIssuer` block) | the vault page's `connect-src` (google-match, batch 8b) |
| `DO_LOCATION_HINT` | var | `cloudflare.durableObjectLocation` | only written when set |
| `BLS_PRECHECK` | var | `gen` writes `"0"` | `"1"` turns it on (`REJECT_PII_ON_SESSIONS` is retired: the claim allow-list is always on, and a leftover var is ignored, D271) |
| `APP_CHANGE_DELAY_MS` | var | `appChangeDelayMs` | the guarded-change delay (`guarded/config.ts`): missing, not an integer, outside 60 s..7 d, or under 24 h on `mainnet` makes every guarded change refuse with `internal` (`AdminRpc.addOrigins`, `proposeChange`, `createApp`, `ackNotice`) |
| `NETWORK` | var | `network` | the production origin rules on `mainnet` (`guarded/config.ts`) |
| `REFUSED_ORIGINS` | var | every Hana origin (`@hana-id/env` `hanaOwnOrigins`), JSON array | refused as app origins (`guarded/config.ts`; the CLI applies the same list from the manifest) |
| `FILES_ORIGIN` | var, optional | `files.origin` | only with the dashboard blocks; `logoUrl` (batch C11) |
| `GAS_<METHOD>_TGAS` | var, optional | not generated | per-method gas; `GAS_CREATE_SESSION_AND_DERIVE_LINKED_TGAS` for a linked login |
| `EMAIL_ISS` (L) | var, optional | `emailIssuer.iss` (`{emailIssuer.url}/v1/email`) | absent → every email token `400 unsupported_issuer` |
| `EMAIL_PUBLIC_KEYS` (L) | var, optional | `emailIssuer.publicKeys`, JSON | the issuer's public keys (its JWKS); public members only |
| `RELAYER_KEYS` | secret | `.secrets/<env>/relayer-keys.json` | JSON array of `ed25519:` secret keys |
| `OWNER_RELAYER_KEYS` | secret | `.secrets/<env>/owner-relayer-keys.json` | same format; absent → owner actions 503 |
| `OWNER_POOL_ALLOWANCE_YOCTO` (C6) | var, optional | not generated | the allowance (decimal yocto) the owner-pool keys were added with, when deploy-contract ran with another `--owner-relayer-allowance` than 0.5 NEAR: the base of the hourly `owner_allowance_low` check |
| `COINGECKO_API_KEY` | secret, optional (D436) | set by the user; `.secrets/<env>/coingecko-api-key` if a copy is kept | a CoinGecko key (Pro, else Demo) for the sandbox mainnet demo's prices; without it the public API, then the fixed table |
| `KEYS_UPDATER_KEY` | secret | `.secrets/<env>/keys-updater.json` `private_key` | function-call key on the signer with exactly the updater methods (installed by `add_updater_key`, G); absent → cron skips JWKS sync |
| `VAULT_KEK` | secret | `.secrets/<env>/vault-kek`, from `scripts/vault-kek.ts init` | `<id>:<base64 of 32 bytes>`; absent → vault 503 |
| `VAULT_KEK_PREVIOUS` | secret, rotation only | `.secrets/<env>/vault-kek.previous`, from `vault-kek rotate` | |
| `IDENTITY_ISS` (I) | var, optional | `identityToken.iss` (`{apiUrl}/v1/identity`) | absent → `/v1/identity/*` 503 `identity_unavailable` |
| `IDENTITY_PUBLIC_KEYS` (I) | var, optional | `identityToken.publicKeys`, JSON | the JWKS; public members only |
| `IDENTITY_SIGNER` (I) | var, optional | `identityToken.signer.kind` | `worker-secret` or `aws-kms` (D215); absent (a config generated before build step 7) means `worker-secret`, unless `IDENTITY_KMS_KEY_ARN` is set (then every mint is refused); any other value → `503 identity_signer_unavailable` |
| `IDENTITY_ACTIVE_KID` (I) | var, optional | `identityToken.signer.activeKid`, or `.keys.active.kid` for `aws-kms` | the key that signs: whichever of the two signing-key secrets has this thumbprint, or the KMS key; it must be in `IDENTITY_PUBLIC_KEYS` |
| `IDENTITY_KMS_KEY_ARN` (I) | var, `aws-kms` only | `identityToken.signer.keys.active.arn` | the active key's ARN (single-region key); its region is the KMS endpoint's. The standby, next and previous ARNs stay in the manifest |
| `IDENTITY_GLOBAL_HOURLY_MAX` (I) | var, optional | not generated | the global mint breaker per hour (default 1 000 000; the soft alert line is 100 000) |
| `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY` (I) | secret, testnet and `local*` only | `.secrets/<env>/identity-signing-key.json`, `identity-signing-key-standby.json`, from `scripts/identity-key.ts init` | P-256 private JWKs; no key with the active kid → `503 identity_signer_unavailable` |
| `IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY` (I) | secret, `aws-kms` only | `.secrets/<env>/identity-aws-access-key.json` (`aws iam create-access-key` for `identityToken.signer.credentials.iamUser`), from `identity-key kms-put-aws-key` (one `wrangler secret bulk`) | a long-term `AKIA…` key of the IAM user whose only permission is `kms:Sign` on the active key (D219); never logged; missing → `503 identity_signer_unavailable` |
| `IDENTITY_SUB_KEY` (I) | secret | `.secrets/<env>/identity-sub-key`, from `identity-key init` | base64 of 32 bytes; the `sub`/`sid` HMAC key; never rotated |
| `IDENTITY_SEAL_KEY`, `IDENTITY_SEAL_KEY_PREVIOUS` (I) | secret | `.secrets/<env>/identity-seal-key`, from `identity-key <env> email-keys` (the issuer has the same value) | `<id>:<base64 of 32 bytes>`: opens the issuer's sealed addresses (D438); the previous one only during a rotation. Without it no consent endpoint works and tokens carry no email |
| `EMAIL_CONSENT_KEY` (I) | secret | `.secrets/<env>/email-consent-key`, from `identity-key <env> email-keys` | base64 of 32 bytes: the consent rows' address MAC (D439), API only; never rotated (a new one asks every user again) |
| `USER_ID_KEY` (C4) | secret, optional | `.secrets/<env>/user-id-key`, from `usage-setup <env> user-id-key` | base64 of 32 bytes; the uid key. Absent or malformed → events without uid (`usage_uid_unavailable`); never logged |
| `DB` | D1 | `cloudflare.d1Name`, id from `--d1-id` | `migrations_dir: migrations` |
| `USAGE_DB` (C4) | Hyperdrive, optional | `gen --usage-hyperdrive-id <id>` (kept on regeneration for the same Worker and D1 database; `off` drops it; `localConnectionString` an unroutable placeholder for `wrangler dev`) | the ledger writer's config (role `usage_writer`, caching disabled). Absent → capture off, every endpoint as before |
| `RELAYER_KEY`, `RATE_LIMITER`, `LOGIN_RELAY` | Durable Objects | classes `RelayerKey`, `RateLimiter`, `LoginRelay` | |
| `VAULT_IP_LIMIT`, `VAULT_SHARE_LIMIT` | Rate Limiting (`ratelimits`) | `gen` writes them (`src/vault/limits.ts`): namespaces `95001`, `95002`; 60 and 10 per 60 s | vault per-IP and per-share limits, per location (D95); a namespace id is account-wide, keys carry the env name |
| `VAULT_STATUS_IP_LIMIT`, `VAULT_STATUS_SHARE_LIMIT` | Rate Limiting (`ratelimits`) | `gen` writes them (`src/vault/limits.ts`): namespaces `95005`, `95006`; 600 and 30 per 60 s | `POST /v1/vault/share-status` per IP and per share, per location (D690) |
| `IDENTITY_SESSION_LIMIT` (I) | Rate Limiting (`ratelimits`) | `gen` writes it (`src/identity/limits.ts`): namespace `95003`; 10 per 60 s | `/v1/identity/token` per session key, per location |
| `IDENTITY_ROOT_LIMIT` (I) | Rate Limiting (`ratelimits`) | `gen` writes it: namespace `95004`; 30 per 60 s | `/v1/identity/token` per account root (keyed by the HMAC `sub` bytes, never the Google `sub`), per location (D176) |

`gen` also writes the page Workers' `wrangler.vault.jsonc` (var `VAULT_ORIGIN`, assets, service binding `API` to this
Worker) and `wrangler.auth.jsonc` (vars `AUTH_ORIGIN`, `API_URL`, `NEAR_RPC`, `NEAR_RPC_FALLBACK` when set,
`MAINNET_DEMO_BALANCE: "1"` in a dev env on testnet only (D429: `/approve`'s `connect-src` then lists Hana's two
balance endpoints, `https://mainnet.base.org` and `https://horizon.stellar.org`, as the build's meta policy does); assets),
both gitignored (`apps/api/scripts/pages-wrangler.ts`).

`HANA_BUILD` (all three Workers, and the email issuer's): the build id (D384), never written by `gen`; `deploy` and
`deploy:pages` pass it as `wrangler deploy --var HANA_BUILD:<id>`, read from the checkout's HEAD and working tree
(`@hana-id/env/local-build`). A raw `wrangler deploy` leaves it unset.

Also generated: `name` = `cloudflare.workerName`, `compatibility_date` 2026-10-01, `nodejs_compat`, alias
`secp256k1` → `src/shims/secp256k1.ts`, `observability.enabled` with `logs.invocation_logs: false` (Workers Logs
keeps the Worker's own log lines, not the platform's per-request records, which carry the URL and so the login
relay's `relayId`; security sweep APIV-3, D100), the cron.

## Timings

A `pk_test_` app's successful `GET /v1/app`, `POST /v1/login`, `POST /v1/vault/shares` and `POST /v1/vault/unlock`
answer with the request's own timings, so a test page can set the API's time against its own round trip (apps/smoke, README
"Timings"). The vault reports the login's and the unlock's; share creation's arrive after the login reply (D79), so
the vault drops them (the request log keeps them). Unlock's phases are `app` (the cached app row), `limits` (the IP
and share limits, local bindings, and the app quota object; D95), `share` (the KEK, the share and settings rows) and
`advance` (the counter update); there is no `shareLimit` phase any more (D78). `GET /v1/app`'s are `app`, `limits`
(the gate), `settings` and `chain` (from the gate's end to each read's answer; they overlap, D261), which the vault
reports inside the login's `app` stage (`appServer*`):

```json
"timings": { "totalMs": 0, "phases": { "app": 0, "limits": 0, "…": 0 } }
```

**RPC view timeout and failover.** Every NEAR RPC call the API makes goes through `src/near/rpc.ts` (`nearRpc(env)`,
D435) over `NEAR_RPC`, then `NEAR_RPC_FALLBACKS` in order. Each read (`Rpc.view`, `call_function`: the scope, config,
session, issuer and link views on every endpoint, `/v1/login`'s and `/v1/sessions`' checks included; the access-key
views and `block`) gives an endpoint 8 s (`VIEW_TIMEOUT_MS`, D261); `send_tx` and `tx` give it 20 s (`TX_TIMEOUT_MS`,
above the node's own ~10 s wait, whose `TIMEOUT_ERROR` is an answer). A call moves to the next endpoint only when one
gives no JSON-RPC answer: a network error, its timeout, HTTP 5xx or 429, a body that isn't JSON-RPC (not JSON, or
neither `result` nor `error`), or `NO_SYNCED_BLOCKS` / `NOT_SYNCED_YET`. Any other answer is final, a JSON-RPC error
included (an unknown account, a contract panic, `InvalidNonce`, `TIMEOUT_ERROR`, `UNKNOWN_TRANSACTION`): no answer is
put to another provider. Within one request, relay or cron run the calls stay on the endpoint that answered last; an
endpoint that failed is asked after the others by the isolate for 30 s (`RPC_DOWN_MS`). A `send_tx` that fails over
sends the same signed bytes to the next endpoint (one hash, one nonce: included at most once), and any error after
that is an unknown outcome (no node text), which the relayer and the keys-updater poll by hash; they never re-sign on a
failed-over broadcast's `InvalidNonce` or `Expired`. When every endpoint fails, the call fails as an unreachable node
does (`502 near_unavailable` on the endpoints). Each failover logs `near_rpc_failover` ("Logs").
A shared `get_config` read in flight that hasn't settled within 10 s is no longer shared, so a read cancelled with its
request can't hold up the isolate's later requests.

`totalMs` runs from the request reaching the Worker to the answer; `phases` are the request log's (below). Durations
only, under phase names: no request field, key, token or transaction. Like the log, they move only on I/O (the Workers
clock), so CPU-only work shows as 0. `pk_live_` apps never get them, nor does any error answer or any other endpoint
(`apps/api/test/timings.test.ts`).

## Logs

One JSON line per event (`src/log.ts`): `{"level", "ts", "event", …}`. Only typed fields can be logged: never JWTs,
signatures, bodies, keys, CKD responses, relay bodies or panic text. At runtime `log()` also drops any field named
`x-hana-home`, `sub`, `pathHash`, `path_hash`, `jwt`, `token`, `idToken` or `id_token`, wherever it is nested (D473).

`event: "request"`, one per API request:

| Field | |
|---|---|
| `requestId`, `appId`, `endpoint`, `method` (login relay only) | `endpoint` is the path; a login relay is always `/v1/login-relay`, never with its relayId |
| `outcome` | `ok` (< 400), `rejected` (4xx), `error` (5xx; logged at level `error`) |
| `status`, `code`, `nearTx`, `latencyMs` | |
| `colo` | Cloudflare data center that ran the request (`SIN`, …) |
| `phases` | ms per stage, below |
| `relayInstance` | `{cold, coldChainRead, blockRefresh, served, ageMs}` of the relayer key object |
| `kid` | `/v1/identity/token`: the signing key's thumbprint (I); never the token, `sub`, `sid`, an address or the body |

| Phase | Covers |
|---|---|
| `app` | D1 app lookup (vault endpoints: ~0 when the per-isolate cache has the app, D78) |
| `limits` | rate-limiter round trips (vault endpoints: the IP and share limits are local bindings with no round trip, then the app quota object; the body read is in it too, D95) |
| `checks` | body, token, nonce, chain reads, signature, pre-checks (everything before the relay) |
| `settings` | share creation: the app's settings row (D1); `GET /v1/app`: the settings and `login_methods` rows, from the gate's end (overlaps `chain`) |
| `chain` | `GET /v1/app`: `get_scope` (and `get_config` when read), from the gate's end (overlaps `settings`) |
| `session` | share creation: signature check, then the session read and its retries (every 300 ms for up to 2 s while the node lags) |
| `insert` | share creation: wrapping K_s and the D1 insert |
| `share` | share actions: the KEK, the share row and (unlock, touch) the settings row (D1) |
| `advance` | unlock: re-wrap if needed and the counter update (D1) |
| `proof`, `limits`, `share`, `session`, `wallets`, `sign` | `/v1/identity/token` (I): the session signature, the per-session limit and marker, the share and settings rows, the chain session, the wallet proofs, signing |
| `records`, `session`, `insert`, `near` | `/v1/wallets/record` (W): the records' checks, the chain session, the D1 batch, the NEAR wallet's own write (D756) |
| `relay` | round trip to the relayer key object |
| `relayDispatch` | inside it, until broadcast: = `relayQueue` + `relayChainRead` + `relaySign` + `relayPersist` (summed over retries) |
| `relayQueue` | waiting for earlier critical sections of the same key |
| `relayChainRead` | access-key / block reads (cold start without reservation, block > 5 min old, recovery) |
| `relaySign` | signing (~0: the Workers clock moves only on I/O) |
| `relayPersist` | confirming a new nonce reservation (0 inside one) |
| `relayOutcome` | broadcast to executed outcome |

`relayInstance`: `cold` this relay started the instance; `coldChainRead` that start read the chain; `blockRefresh`
the block hash was re-read; `served` relays this instance handled before; `ageMs` since it started.

Other events: `relay_dispatched` (`pool`, `keyIndex`, `method`, `nearTx`, `nonce`, `attempt`), `relay_retry`
(`code` `invalid_nonce` / `expired` / `dropped`), `relay_dispatch_failed`, `relay_failover` (`pool`, `keyIndex` the failed
one, `method`, `code`: a claimed relay moving to the next key, D455), `jwks_sync` (`added` = Adds proposed,
`removed` = Removes proposed, `executed`, `kids`), `jwks_sync_failed` / `jwks_sync_skipped` (`code`),
`jwks_sync_note` (`code`, `kids`, `changeId`; warn or error, G: `paused`, `unpublished_change` (error),
`removal_of_published_kid`, `pending_mismatch` (error), `held_after_cancel`, `queue_full`, `issuer_full`,
`last_key_kept`, `execute_raced`), `issuer_key_change_cancelled` (error, G: `method`, `kids`, `changeId`), `jwks_tx`
(`method`, `nearTx`, `code` `raced` / `send_failed` / `method_not_allowed`), `chain_gate_unavailable` (warn, G:
`code` `get_config_failed` / `get_issuer_failed`), `near_rpc_failover` (warn, D435: `method` the JSON-RPC method, `code` `network` / `timeout` / `http_5xx` / `http_429` / `not_jsonrpc` / `not_synced`, `rpcEndpoint` and `nextRpcEndpoint` indexes, 0 being `NEAR_RPC`; never a URL), `jwks_stale`, `key_observation_failed` (`code` `jwks` / `token`), `vault_page` (`latencyMs`: its D1 reads), `vault_maintenance`
(`pruned`, `prunedConsents`, `rewrapped`, `unknownKek`), `consent_status_unavailable` (warn, D511), `vault_rewrap_unreadable` (`unreadable`), `vault_kek_unavailable`, `vault_share_unreadable`,
`first_session_write_failed` (`what` `scope` / `marker`), the usage writer's (C4) `usage_write_failed` (`code`
`connection` or `pg_<SQLSTATE>`, `attempt`), `usage_write_rejected` (`code` `invalid_event` with `problems`, or
`pg_22023`), `usage_uid_unavailable` (`code` `missing_key` / `bad_key` / `bad_path`), `usage_org_unavailable`,
`identity_usage_sync` (`synced`) / `identity_usage_sync_failed`, `usage_partitions_failed` (`code`), `owner_token_release_failed`, `gas_override_ignored`, `auto_approve_policy_invalid`
(`problems`), the identity token's (I) `identity_unavailable` (`code`: `no_identity_config`, `bad_public_keys`,
`active_kid_not_published`, `no_sub_key`, `bad_sub_key`), `identity_signer_unavailable` / `identity_sign_failed`
(`code`: `no_signing_key_for_active_kid`, `signing_key_unusable`, `self_verify_failed`, `unknown_signer_kind`, `signer_kind_missing` (a KMS key ARN without `IDENTITY_SIGNER`), and for
the KMS signer `no_kms_key_arn`, `no_aws_credentials`, `kms_bad_key_arn`, `kms_bad_credentials_format`, `kms_timeout`,
`kms_unreachable`, `kms_access_denied`, `kms_bad_credentials`, `kms_key_disabled`, `kms_key_not_found`,
`kms_key_usage`, `kms_throttled`, `kms_internal`, `kms_error`, `kms_bad_answer`, `kms_bad_signature`; never a
credential, a request or a signature), `identity_ceiling` (error), `identity_volume_alert` (error: past the global soft line),
`identity_bad_session_path` (error), `identity_count_failed`, `identity_maintenance` (`pruned`), batch C's `rpc`
(`method`, `requestId`, `orgId`, `actorKind`, `outcome`, `code`: one per RPC call, never its input or the actor's id
or email), `drift_detection` (`added`; error `code: internal`), `console_rpc` (`code: breaker_event_failed`,
`settle_failed`), C6's `owner_cap_event_failed` and `owner_allowance_check` (`code` `owner_allowance_low` (warn),
`near_unavailable` / `event_write_failed` (error)), and `owner_token_release_failed` with `endpoint: step_up`; the
wallet directory's (W) `directory_write_failed` (error, `code` `no_table` / `internal`), `directory_sync_failed` (warn,
`near_unavailable`) and `directory_unavailable` (warn, `no_user_id_key`, `no_sub_key` or `bad_sub_key`, at most every 10 min per isolate), each with
`requestId`, `endpoint` and `appId` only, never a sub, an address or a user id; a console
owner action's request line has `endpoint: ConsoleRpc.ownerAction`; and from the page
Workers `vault_host` and `auth_page` (`code`).

## Console Worker (`apps/console`, its own Worker) and console-auth · C7, C9, C10

The partner console's Worker (`hana-id-console-<env>`), on `console.origin`, and the thin console-auth Worker
(`hana-id-console-auth-<env>`) on `console.authOrigin`. Batch C7 built the backend; C9 (branch `feat/batch-c-9`, not
merged) adds partner sign-in, the read-only routes, the SPA and the route config: `workers_dev: true` on its own
`workers.dev` name in a dev env, else a Custom Domain on the origin's host; never preview URLs (D294). C10 (from
`feat/batch-c-10`, merged) adds fresh sign-in and the write routes ("Fresh sign-in", "Signed-in writes" below).
D240–D244, D290–D297, D342, D343, D350–D358.

**Every request.** The Worker runs first (assets with `run_worker_first`). A host other than `CONSOLE_ORIGIN`: `404`
`Not found`. A non-GET/HEAD request without all four CSRF checks (`Sec-Fetch-Site: same-origin`, `Origin` =
`CONSOLE_ORIGIN`, `x-hana-console: 1`, `content-type: application/json`, or exactly `application/octet-stream` on
`/api/orgs/:org/apps/:app/logo`, D300): `403 {"error":{"code":"csrf",…}}`. `/api/*` goes
to the routes below (any other path `404 not_found`, a wrong method `405` with `allow`); anything else is the SPA
(`GET`/`HEAD` only: the Vite build of `apps/console/web`, with the single-page fallback for unknown paths). Every
response carries the console CSP, `Referrer-Policy: no-referrer`, `Cross-Origin-Opener-Policy: same-origin`,
`X-Content-Type-Options: nosniff` and `Strict-Transport-Security: max-age=63072000; includeSubDomains`; `/api/*` also
`Cache-Control: no-store`. Errors are `{error: {code, message}}` with the RpcCode → HTTP map of console-core
(`RPC_HTTP_STATUS`, `CONSOLE_ERROR_STATUS`); the message is the console's own, never the API's text.

**The build id (D406).** Both Workers answer `GET`/`HEAD /.well-known/hana-build` on their own origin with
`{"build": "<id>" | null}\n` (`application/json; charset=utf-8`): the build id the Worker was deployed with (the
`HANA_BUILD` var, set only by its `run deploy`, the shared wrapper `packages/env/src/stamped-deploy.ts`; `null` when
unset or not an id). The console's carries its usual headers and `no-store`, needs no CSRF check, and answers any other
method `405` (`allow: GET, HEAD`); console-auth's carries the auth origin's headers (the allow-nothing CSP, `no-store`)
without reaching the console, and any other method is its usual `404`. The SPA's `index.html` (`GET /`) carries
`<meta name="hana-build" content="<id>">`, written by its `vite build` (`apps/console/scripts/build-stamp.ts`).
`deploy-check <env>` reads all three (`docs/operations.md` "Checking a deploy").

### Sign-in (the Google code flow with PKCE; D75, D290–D293)

| Route | Request → answer | Notes |
|---|---|---|
| `POST /api/auth/start` | `{purpose: "login", invite?: <b64url of 32 bytes>}` → `{startUrl: "<authOrigin>/start?f=<43 chars>"}` and `Set-Cookie: __Host-hana_pre=…; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600` | CSRF rules. Stores an `auth_flows` row: `sha256(f)`, `sha256(state)` (state = `b64url(sha256("hana-console/auth-state/v1\0" ‖ f))`), a PKCE verifier, the login nonce (console-core `consoleLoginNonce`), `scope = 'openid email'`, the pre-flow cookie's sha256, 5 min. An `invite` whose sha256 names no open, notified invite: `403 invite_invalid`, no flow (D293); a valid one binds the flow to it and its address becomes Google's `login_hint`. `400` for another purpose or field |
| `GET <authOrigin>/start?f=` | → `303` to `https://accounts.google.com/o/oauth2/v2/auth` with `client_id`, `redirect_uri=<authOrigin>/callback`, `response_type=code`, `scope`, `prompt=select_account`, `state`, `nonce`, `code_challenge` (S256), `login_hint` when set; `Set-Cookie: __Host-hana_af=…` (same attributes) | The flow is found and marked started in one statement: unknown, expired, already started, a malformed or extra query: the static 400 page. No client id configured: the static page with `503` |
| `GET <authOrigin>/callback?code&state` | → `303` to `<console.origin>/api/auth/complete?h=<43 chars>#` (an empty fragment: the implicit-flow guard), `__Host-hana_af` cleared | Only with `code` and `state` (each once), `sha256(state)` a started, unused, unexpired flow and `sha256(__Host-hana_af)` its cookie: found and marked used in one statement (a wrong or missing cookie consumes nothing). Then the code exchange (`https://oauth2.googleapis.com/token`, the client secret, the verifier; 8 s, 32 KiB) and the token check (`auth-token.ts`: RS256 on Google's JWKS, `iss`, `aud` and `azp` the console client, the flow's nonce, `exp`, `iat` ≤ 120 s old and ≤ 60 s ahead, the claims by scope: D290). A login writes a 60 s `handoff_codes` row with `{provider, sub, email, hd}` only. A step-up flow (C10) runs its pending action instead and answers `303 <console.origin>/actions/:id#` ("Fresh sign-in" below). Anything else (`error=`, no query, a token in place of a code, a refused token, a Google 4xx): the static 400 page, no `Location`; Google 5xx, timeout, JWKS down or no secret: the same page with `503` |
| `GET /api/auth/complete?h=` | → `303 /` with `Set-Cookie: __Host-hana_cs=…; Path=/; Secure; HttpOnly; SameSite=Strict` and `__Host-hana_pre` cleared, or `303 /signin#error=<code>` | The handoff must be unused, inside its 60 s and its flow's `pre_cookie_hash` this request's `__Host-hana_pre` (found and used in one statement, then scrubbed). The membership rules then run (spec "Membership rules at sign-in": a disabled user `user_disabled`; an invite bound to the flow is accepted in one D1 batch, `invite_invalid` or `already_member`; no invite: an existing user with a membership in an active org whose `required_hd` is null or the token's `hd`, else `not_invited`); success writes the session (2 h idle, 12 h absolute, `/24` or `/48` and country kept for staff), the user's `last_sign_in_at` and current verified address, and `session.signed_in`, in one batch. Codes: `not_invited`, `invite_invalid`, `already_member`, `user_disabled`, `expired`, `rate_limited`, `internal` (D292) |
| `POST /api/auth/logout` | `{}` → `{}`, the session cookie cleared | Session and CSRF rules; revokes this session (`session.signed_out`); `401` without a session |

The static page (auth origin): `text/html`, no script, one link to `<console.origin>/signin#`, the same text for every
refusal. Every auth-origin answer carries `Content-Security-Policy: default-src 'none'; frame-ancestors 'none';
form-action 'none'; base-uri 'none'`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`, `Cross-Origin-Opener-Policy: same-origin` and HSTS. `/api/auth/*` and the two
auth-origin routes share a per-IP limit: 10 a minute per IP (IPv6 by /64), key `<env>:console-auth:<ip subject>` on
`CONSOLE_IP_LIMIT`; past it `429` (`retry-after: 60`; the static page on the auth origin, `/signin#error=rate_limited`
from complete). Audit rows: `session.signed_in` (`invite: true|false`), `session.signed_out`, `signin.refused`
(`not_invited` with the address's sha256 only, `user_disabled` with the user id; system actor `console-sign-in`).
Logs: `auth_start`, `auth_callback`, `auth_complete`, `invite_accept`, with codes and, for a refused claim, its name
only; never a token, code, cookie, address or `sub`.

**`AuthHandler`** (named export, a `WorkerEntrypoint` with `fetch`; no route: bound only by console-auth as
`CONSOLE`): answers only `GET /start` and `GET /callback` on `CONSOLE_AUTH_ORIGIN` (anything else `404`, with the
auth-origin headers). **console-auth** (`apps/console-auth/src/index.ts`): forwards exactly those two requests
unchanged (URL, cookies, `cf-connecting-ip`) to `CONSOLE` and sets the auth-origin headers again on the answer;
any other path, method or host is `404 text/plain` without calling the console; a failing binding is `503`. It has no
secret, D1, Hyperdrive or R2; vars `AUTH_ORIGIN`; invocation logs off.

### Signed-in reads (read-only; D296)

Each needs a live session (`401 unauthenticated` otherwise) and, under `/api/orgs/:org`, a membership of that org
whose `required_hd` (if set) is the session's `hd`; anything else, a malformed id included, is `404 not_found`. The
role is read from `members` on every request.

| Route | Answer |
|---|---|
| `GET /api/me` | `{user: {id, email}, memberships: [{orgId, orgName, status, role}], features: {users}, sessionExpiresAt, envName}`: every hd-matching membership, frozen orgs included (read-only); `features.users` is whether the Users screen is on (`USERS_SCREEN`, from the manifest's `console.usersScreen`, D357, D702); `envName` is the env's name (`ENV_NAME`, only in a manifest name's shape), for the client snippet's `environment` (D703); `sessionExpiresAt` (ms) is this session's 12 h absolute end, for the SPA's warning before it (D424; the 2 h idle end isn't answered: each request moves it) |
| `GET /api/orgs/:org` | `{org: {id, name, status, requiredHd?}, role}` |
| `GET /api/orgs/:org/apps` | `{apps: AppSummary[]}` (`ConsoleRpc.listApps`) |
| `GET /api/orgs/:org/apps/:app` | `{app: AppDetail, now}` (`now`: the answer's time on the server's clock, by which the SPA judges what is still waiting, D701; `ConsoleRpc.getApp`: origins with their display form and IDN flag, pending and active guarded changes, keys, settings); another org's app `404` |
| `GET /api/orgs/:org/members` | `{members, invites, grants}`: members (address, role in force, `pendingOwnerFrom`, `addedBy` a user id or `hana`; no `sub`), open invites (`notified` says whether the link works yet), live owner grants |
| `GET /api/orgs/:org/audit?cursor=` | `{entries, next?}`: the org's `audit_log` rows (`source: "console"`) merged newest first with `ConsoleRpc.listChanges` (`source: "api"`), 50 a page, cursor `<audit seq>.<change seq>`; staff shown as `hana` with no address, no `sub`, no IP prefix; a malformed cursor `400` |

The ConsoleRpc calls carry the member actor (`id`, `sub`, `email`, `sessionHash` = b64url of the session's id hash),
the request's id and `cf-connecting-ip`.

### Fresh sign-in (step-up; C10, D354)

| Route | Request → answer | Notes |
|---|---|---|
| `POST /api/orgs/:org/actions` | `{kind, params, returnTo?}` → `{id: "act_…", kind, decoded, expiresAt, returnTo}` | An owner of an active org. Builds the canonical action and its Google nonce: the origin-change layout (`origin.add` `{appId, add, remove?}`: normalised, checked against the API's origin rules with `NETWORK` and `REFUSED_ORIGINS`, ≤ 20 origins), the settings-change layout (`policy.set` `{appId, policy}`, validated by `@hana-id/core/policy` at the app's session TTL; `raw_sign.on` `{appId}`, live apps only), the contract's owner-action layout at the scope's `action_nonce` read with an uncached `get_scope` (`owner_action` `{scopeId, method, change?, changeId?, aud?}`: `propose_change` with `{kind: "AddClient", aud, clientProof, piiWarningAccepted: true}`, `{kind: "SetAllowShared"}` or `{kind: "SetOwners"}` (built from the org's owners, D353), `cancel_change`, `remove_client`, `disable_shared_login`; the member must be an on-chain owner, else `403 not_owner`), else the generic step-up layout bound to this session (`app.resume` `{appId}`, `app.settings` `{appId, persistence?, sessionTtlMs?, idleTtlMs?, googleWebClientId?}`, `member.invite` `{email, role}`, `member.role` `{userId, role}`, `member.remove` `{userId}`, `org.policy` `{requiredHd}`, D355). `returnTo` `{page, appId?}` names the page that started the action, where the action page's back link goes (D711): `page` from the kind's allowlist (`origin.add` origins; `policy.set`, `raw_sign.on` signing; `app.resume` suspend; `app.settings` sessions or email; `owner_action` scope or email; `member.*`, `org.policy` members; the first is the default without `returnTo`), and an app's page names the action's own app (`appId`, if given, must match) or, for `owner_action` from the Email login tab, an app of this org on the action's scope (`getApp`). A bad `returnTo` is refused before anything is stored: `400 bad_request` (not `{page, appId?}`, a page the kind has no use for, an app that isn't the action's or isn't on its scope), or `404 not_found` for an app that isn't this org's (missing, deleted or another org's: the same answer). The answer's `returnTo` is the path the console built from those ids (`/orgs/:org/apps/:app/<page>`, `/orgs/:org/scopes/:scope`, `/orgs/:org/members`), never a value from the request; it is stored with the action. Stores `pending_actions` for 5 min. `decoded` is what the page shows: origins with their display form and IDN flag, the validated policy with its `policyId` and label (the consent preview), on-chain owners as members, never a `sub`. Refused before any sign-in: `400 bad_request`, `origin_refused`, `policy_invalid`, `invalid_client_proof` (a pasted proof checked for its signature, `aud`, the client-proof nonce and the claim allow-list, D350), `403 not_owner`, `404`, `409 conflict` (a pending change of the same kind, 10 open invites, …), `503 near_unavailable`; a 48 KiB body cap |
| `POST /api/actions/:id/google` | `{}` → `{startUrl}` | The action's own session only (else `404`), unused and unexpired (else `409 step_up_expired`). Creates the `auth_flows` row: `purpose = 'step_up'`, `scope = 'openid'`, the action's nonce, the session's `sub` as `login_hint`, expiring with the action. Shares the per-IP limit of `/api/auth/*` |
| the callback (above) | → `303 <console.origin>/actions/:id#` | After the token checks (`scope=openid`: exactly the claim allow-list, `at_hash` matching the exchange's access token): the token's `sub` must be the session user's (`sub_mismatch`), the action unused and unexpired (`step_up_expired`), its session live (`session_ended`), the member still an owner of the active org (`forbidden`). Then it runs: `origin.add` → `ConsoleRpc.changeOrigins`, `policy.set` / `raw_sign.on` → `proposeChange` (the token as `stepUpJwt`; the API verifies it itself), `app.resume` → `setSuspended(false)`, `app.settings` → `updateSettings`, `owner_action` → `get_scope` again (a moved `action_nonce` is `nonce_moved` and nothing is sent), then `ConsoleRpc.ownerAction` with `auth: {Oidc: {jwt}}` on the stored arguments; `member.*` and `org.policy` consume the action, apply the change and write its audit row in one D1 batch. The action is used once whatever the outcome; the token is never stored |
| `GET /api/actions/:id` | → `{id, kind, status: "pending" \| "ok" \| "failed" \| "expired", decoded, expiresAt, returnTo, outcome?}` | The action's user only (`404` otherwise). `returnTo`: the stored path (an action stored before it existed: the kind's default page from its ids, D711); the SPA uses it only when it is one of its own action pages. `outcome`: `{status, code?, message?, version?, changeId?, inviteId?, grantId?, nearTx?, relayStatus?, noChange?}`. A refusal after the token verified is also an audit row, `step_up.failed` |

### Email login page (build plan batch 9, D444, D447)

`GET /api/orgs/:org/apps/:app/email` (any member, a frozen org too): `{emailOn, scopeId, scope: {clientOnChain, pending: {changeId, unlockAt, executable} | null, youAreOnChainOwner} | {unavailable}, otherAppsEmailOn, available, deliverability: {days: [{day, sent, bounced, complained, refused}]} | {unavailable}, now}`. `executable` is judged by the Worker's clock, `now` (D713): the page measures its own clock against it, re-reads once at `unlockAt` and shows Execute when the answer says `executable`. 404 for another org's app (`getApp` first; the issuer is asked only after it).
Writes: `POST …/actions` `{kind: 'app.settings', params: {appId, loginMethods: 'google,email'}}` (fresh sign-in; refused without an email issuer bound) and `{kind: 'owner_action', params: {scopeId, method: 'propose_change', change: {kind: 'AddEmailClient'}}}` (fresh sign-in, the on-chain owner's; the console asks `ISSUER.clientProof`: `email_not_enabled` is 409 "Turn email login on…", `rate_limited`, a pending or present client 409) or `{method: 'remove_client', aud: 'email:<scope>'}`; `POST …/apps/:app/off` `{what: 'email', expectedVersion}` (owner, immediate, a frozen org too). `execute_change` is the existing `POST …/scopes/:scope/execute`.

### Signed-in writes (C10, D356)

The session, the membership (as for the reads) and the CSRF rules, then the role: a viewer (a pending owner included)
gets `403 forbidden` on every owner route. In a frozen org only the cancels and the kill switches stay open (✓ below);
any other write is `403 org_frozen`. Each ConsoleRpc write writes an outcome `audit_log` row after the RPC returns
(app_changes stays authoritative), with the RpcCode of a refusal.

| Route | Body → answer | ConsoleRpc / effect | Frozen |
|---|---|---|---|
| `POST /api/orgs/:org/apps/:app/origins/remove` | `{remove, expectedVersion}` → `{version}` | `removeOrigins` (immediate; counted by the breaker); `origins.removed` | ✓ |
| `POST /api/orgs/:org/apps/:app/off` | `{what: "policy" \| "raw_sign", expectedVersion}` → `{version}` | `turnOff`; `app.turned_off` | ✓ |
| `POST /api/orgs/:org/changes/:id/cancel` | `{}` → `GuardedChange` | `cancelChange`; `change.cancelled` | ✓ |
| `POST /api/orgs/:org/apps/:app/suspend` | `{}` → `{suspendedBy}` | `setSuspended(true)`, bit 4; `app.suspended` (resuming is the `app.resume` action) | ✓ |
| `POST /api/orgs/:org/apps/:app/profile` | `{name, expectedVersion}` → `{version}` | `updateSettings({name})`; `app.renamed` | — |
| `POST /api/orgs/:org/apps/:app/logo?expectedVersion=` | the raw image → `{logoUrl, version}` | `logoUploadRoute` (below) | — |
| `POST /api/orgs/:org/apps/:app/logo/remove` | `{expectedVersion}` → `{version}` | `logoRemoveRoute` (`setLogo(null)`) | — |
| `POST /api/orgs/:org/apps/:app/policy/check` | `{policy}` → `{policyId, label, policy}`, or `400 {error: {code: "policy_invalid", …}, problems}` | `getApp` (the session TTL), then the validator; writes nothing (the editor's preview, D352) | — |
| `POST /api/orgs/:org/apps/:app/keys` | `{}` → `KeyView` | `createKey`; `key.created` (`409 key_limit` past 5) | — |
| `POST /api/orgs/:org/apps/:app/keys/:key/rotate` | `{}` → `KeyView` and `oldKeyRevokedAt` | `rotateKey` (the old key works 24 h more); `key.rotated` | — |
| `POST /api/orgs/:org/apps/:app/keys/:key/revoke` | `{}` → `{}` | `revokeKey` (immediate); `key.revoked` | ✓ |
| `POST /api/orgs/:org/invites/:id/revoke` | `{}` → `{}` | CONSOLE_DB: the org's open invite and its grant (`409 not_pending` once ended) | ✓ |
| `POST /api/orgs/:org/owner-grants/:id/cancel` | `{}` → `{}` | CONSOLE_DB: until `owner_from`; the person stays a viewer | ✓ |
| `POST /api/orgs/:org/scopes/:scope/execute` | `{changeId}` → `{status, nearTx?}` (`422` with the relay's `code` when the contract refuses) | `ownerAction(execute_change)` (no token: anyone may execute a matured change); `owner_action.executed` | — |
| `GET /api/orgs/:org/scopes/:scope` (viewer) | → `{scope: {id, actionNonce, allowShared, clients, owners, pending}, drift: {hasDrift, missingOnChain, notOrgOwners, unknownOnChain}, youAreOnChainOwner, now}` (`now`: the Worker's clock that judged each pending change's `executable`, D713) | `get_scope`, uncached; owners as `{kind: "member", userId, email, orgOwner}`, `{kind: "near", accountId}` or `{kind: "other_google"}`, never a `sub` | ✓ |
| `GET /api/orgs/:org/scopes/:scope/client-proof-helper?clientId=` | → the helper page, `Content-Disposition: attachment` | The scope's client-proof nonce at its current `action_nonce`; Google's implicit flow with `scope=openid` (D351) | ✓ |
| `GET /api/orgs/:org/users?scope&search&cursor`, `GET /api/orgs/:org/users/:userId` (viewer) | → `{users, next?}`, `{user}` | `404` while `USERS_SCREEN` is off (D357). `ConsoleRpc.listUsers` / `getUser` (the wallet directory's), re-shaped field by field: `{userId (u1_…, D346), supportId, scopeId, createdAt, lastSeenAt, accounts: [{kind, status}], wallets: [{chain, address, firstSeenAt, lastUsedAt}], email}` and, for one user, `emails: [{appId, appName, email, sharedAt}]` (D411: only addresses the user shared with the org's apps; a malformed address drops the row, an app name that isn't one display-safe line shows as "Unnamed app"); never a `sub`, an identity key or an unshared address. `search` also takes a full email address (exact, among shared ones) | ✓ |

C12's report routes and C14's pending-upgrades page are routed here too, for any member (frozen orgs included), each
its own backend's checks and answers: `GET /api/orgs/:org/usage?from&to&by&apps`, `/statements`, `/statements/:month`,
`/statements/:month.csv` and `.pdf`, `/ledger/:month.csv` (reports.ts, "Report backend" below) and
`/governance/pending-upgrades` (governance.ts, "Pending upgrades" below). The SPA's screens over them (D370–D374):
`/orgs/:org/usage` (the report form and table), `/orgs/:org/statements` (the list, the ledger CSV of any month) and
`/orgs/:org/statements/:month` (the on-screen statement), and `/orgs/:org/upgrades` (the pending-upgrades view); the
files are plain `<a href download>` links to these routes (the browser builds no file; the ledger of an issued month at
its statement's `?asOf=`).

**The SPA's pages (D421).** A sidebar frame (the org, a switcher when the member has several, the sections, sign
out). `/orgs/:org` lists the apps (an empty org shows what to send Hana); `/orgs/:org/apps/:app` is the app's overview
(the copyable App ID and publishable key, changes waiting, the getting-started checklist, a settings summary) and its
sections are nested routes: `/origins`, `/keys`, `/sessions` (login and session settings), `/signing` (the
auto-approve policy and raw signing), `/branding` (name and logo), `/suspend`. The other pages: `/orgs/:org/members`,
`/scopes/:scope`, `/users`, `/usage`, `/statements`, `/statements/:month`, `/upgrades`, `/audit`; `/actions/:id`,
`/signin`, `/invite`, `/cancel/:changeId`, `/cancel-owner/:grantId` as above. They call exactly the routes in this
section with the same bodies. Every error answer is shown as plain text for its `code` (`web/src/messages.ts`), the
answer's `message` under it when it adds something (a refused origin's reason, `policy_invalid`'s `problems`, one per
line), and the code and HTTP status small, for support. Local preview with fake answers: `apps/console/README.md`.

### Emailed links (no session; C7)

| Route | Body → answer | Notes |
|---|---|---|
| `POST /api/cancel` | `{changeId: "gc_…", token: <b64url of 32 bytes>}` → the cancelled `GuardedChange` | The guarded change's emailed link (`/cancel/:changeId#t=…` posts it). Calls `ConsoleRpc.cancelChangeByLink` (`link` actor, the request's `cf-ray` as request id, `cf-connecting-ip`); its answer's code maps to the status (`403 forbidden` for a wrong token, `409 not_pending` once cancelled or in force). Audited (`change.link_cancel`) for a cancel or a refusal of a real link only |
| `POST /api/owner-grants/cancel` | `{grantId: "og_…", token: <b64url of 32 bytes>}` → `{}` | An owner grant's emailed link (`/cancel-owner/:grantId#t=…`). sha256(token) must equal the grant's `cancel_token_hash`; single use; `409 not_pending` once cancelled, applied or past `owner_from`; `403 forbidden` for a wrong token or an unknown or unannounced grant |

Both: `400 bad_request` for any other body shape (strict), `413` over 4 KiB (1 KiB without a `Content-Length`; the body is read as a stream and cut off at the cap), `429 rate_limited` (`retry-after: 60`) past
10 requests a minute per IP (IPv6 by /64; the `CONSOLE_IP_LIMIT` rate-limiting binding, namespace `95101`, key
`<env>:console-link:<ip subject>`), checked before the body is read.

**Pending upgrades (C14's backend behind C10's session route, D335).** `pendingUpgradesRoute` in
`src/governance.ts` serves `GET /api/orgs/:org/governance/pending-upgrades` for a signed-in member (any role), routed by C10
(`writes.ts`) after the session check. It checks again that the member belongs to the org (a `members` row, the user not
disabled): another org, an unknown or malformed org id, or a disabled user is `404 not_found`, with no RPC call. Then
`ConsoleRpc.pendingUpgrades` with the member actor and the org → `200 {pendingUpgrades}` (the view above). RPC
refusals keep their status with the console's own message (`429 rate_limited`, `403 forbidden` for `org_legacy`,
`503 near_unavailable`); a binding that throws is `503 near_unavailable`. Logged as `console_rpc` `pendingUpgrades`.

**Logo upload (C11's backend behind C10's session route, D300, D301).** `logoUploadRoute` in
`src/logo.ts` serves `POST /api/orgs/:org/apps/:app/logo?expectedVersion=<settingsVersion>` for a caller the session
route has checked (session, org member, owner role, an active org): the image as the raw body (`application/octet-stream`,
`Content-Length` required) → `200 {logoUrl, version}`. In order:

1. ≤ 512 KiB (`413 logo_too_large`); PNG, JPEG or WebP by magic bytes, one well-formed static image with nothing after
   it (`400 logo_type`: SVG, GIF, AVIF, polyglots, APNG and animated WebP, bad CRCs; D302).
2. `IMAGES.info`: the same type and size as the header, 128–2048 px per side, aspect ratio ≤ 1.25 (`400 logo_type`).
3. `ConsoleRpc.getApp`: the org's app (`404 not_found`) at `expectedVersion` (`409 version_conflict`).
4. The re-encode: `{width: 256, height: 256, fit: 'pad', background: 'rgba(0,0,0,0)'}` → PNG; the answer is checked
   (a static 256 × 256 PNG), stripped to IHDR/PLTE/tRNS/IDAT/IEND, ≤ 128 KiB (`413 logo_too_large`) and decoded
   again (D303).
5. `logo_objects` (upsert, unmarked), then `LOGOS.put("logos/<app>/<sha256 of the stored bytes>.png", image/png)`.
6. `ConsoleRpc.setLogo` (CAS); then the replaced key is marked `replaced_at` (the hourly cron deletes it 30 days on),
   and `audit_log` gets `app.logo_set` (`ok`, or `failed` with the code).

The current image again changes nothing. Uploads are limited to 10 a minute per org (`CONSOLE_IP_LIMIT`, key
`<env>:console-logo:<org>`; `429 rate_limited`). Without the `IMAGES` binding (or `LOGOS`) it answers `500 internal`.
`logoRemoveRoute` (`{expectedVersion}` → `{version}`; `setLogo(null)`, `app.logo_removed`) serves
`POST /api/orgs/:org/apps/:app/logo/remove` (C10; the spec lists no route for it, D358).

**`StaffRpc`** (named export, a `WorkerEntrypoint`; no route: bound only by the admin Worker as `CONSOLE`, batch C8).
Inputs are console-core's strict zod schemas (`packages/console-core/src/staff.ts`); answers `{ok: true, …}` or
`{ok: false, code, error?}`. Staff writes take a `hana` actor; the reads the admin Worker's crons use also take
`system`; `ackMemberNotice` takes `system` only.

| Method | What it does |
|---|---|
| `listOrgs({cursor?, limit ≤ 200})`, `getOrg({orgId})`, `listMembers({orgId})` | Orgs by id (`org_legacy` included); an org with its members (email, `sub`, the role in force, `pendingOwnerFrom` for a pending owner), invites (newest first) and, in `getOrg`, its live owner grants (`grants`: not cancelled, not applied, newest first, no hash column; C8, D283) |
| `issueInvite({email, role, orgId? \| newOrgName?, kind?})` | An invite (`token_hash` NULL until the notice is acked), 7 days from creation; an owner invite to an existing org also creates its owner grant. Refused: `org_legacy` (`forbidden`), unknown org (`not_found`), frozen org, 11th open invite, a second open invite of the address to the org (`conflict`), a second partner org while passkeys haven't shipped, on every network but testnet (`passkeys_required`; the console's `NETWORK` exactly `testnet` lifts it, D698). Returns the invite view, never a token |
| `revokeInvite({inviteId})` | Revokes an open invite and cancels its grant (`not_pending` once ended) |
| `newOrgInvites({limit ≤ 100})` (D696) | Hana only, a read (no audit row, as `getOrg`): invites to organisations not created yet (`org_id` NULL): every open one and those that ended (accepted, else revoked, else expired: that time) less than 30 days ago (`NEW_ORG_INVITES_WINDOW_MS`), open first, then newest first; → `{invites, truncated}` (`truncated`: more matched than `limit`). Invite views as `getOrg`'s (every invite view now also carries `newOrgKind`, `partner` or `internal`, on a new-org invite: additive); never a token or hash |
| `pendingMemberNotices({limit ≤ 100})` | The blocking notices to send, oldest first: open invites and live grants not yet acked, each with the org's current owners (a promotion also with the promoted member); none of a frozen org's (D343) |
| `ackMemberNotice({inviteId \| grantId, tokenHash})` | After every send was accepted: stores the link token's sha256 (an invite's link works from now; a promotion's wait starts, and an accepted owner invite's whose notice a freeze undid: `owner_from = now + OWNER_GRANT_DELAY_MS`). Same hash again: no-op; another: `conflict`; a frozen org's: `not_pending` (D343) |
| `cancelOwnerGrant({grantId})` | Until `owner_from` (`not_pending` after) |
| `setMember({orgId, userId, role \| null})` | Add, remove, demote or promote (through a grant when the org has another owner); the last usable owner stays (`conflict`); a disabled user is never added or promoted (`conflict`) |
| `disableUser({userId, disabled})`, `freezeOrg({orgId, frozen})` | Revoke sessions as the spec's "Sessions" says. A freeze also pauses the org's pending memberships in the same batch (D343): open invites lose their notice (`token_hash`, `notified_at` cleared: the link stops working and must be announced again after the unfreeze), live grants still waiting lose their notice and clock (`notified_at`, `cancel_token_hash`, `owner_from` cleared: re-announced after the unfreeze, then the full delay); the hourly cron records no grant of a frozen org |
| `auditSince({seq, limit ≤ 500})`, `queryAudit({filters, cursor?, limit ≤ 500})` | The feed (oldest first) and the staff screen's query (newest first; filters `orgId`, `appId`, `actorKind`, `actorId`, `action`, `from`, `to`); `seq`, the cursor and the times are safe integers (`bad_request` past 2^53 − 1) |

| `recordStaffAction({orgId?, action, target?, details})` (C12, D327) | Hana only: the `audit_log` row of an admin act with no RPC write of its own: `statement.issued` (`month`, `csvSha256`, `pdfSha256`, `asOf`, `lines`), `ledger.exported` (`month`, `asOf`, `rows`, `sha256`), `rate.overridden` (`day`, `usdMicros`, `overrideId`), `support.lookup` (C15, D396: `by`, `ticket`, `requestIds`, `requestIdList` (the request IDs, ≤ 20 in the request-ID form: the only list a detail may be, D410), `days`) and `users.find` (D410: `by`, `ticket`), both org-less (an `orgId` is `bad_request`, so no partner audit view or feed shows them, and the feed never emails them); another detail key, or a list on another key, is `bad_request`; a repeat of (request id, action) is `already_applied` and writes nothing |

| `health({})` (D425) | Hana only, read-only: `{build, db: {ok, latencyMs}, cron: {job, atMs, outcome, detail} \| null \| 'missing', notices: {pending, oldestAt, truncated} \| null, logos: 'ok' \| 'error' \| null}` for the admin's System status page: the deployed `HANA_BUILD`, a timed `SELECT 1` on `CONSOLE_DB`, the hourly cron's last run (`cron_runs`; `missing` without migration 0003), the invite and owner-grant notices `pendingMemberNotices` would send (at most 100 counted), a `head` of a LOGOS key nothing writes (null without the binding). No email, sub or name |
| `purgeAudit({before, limit ≤ 1000})` (C13, D364) | `system` only (the admin Worker's monthly job). Deletes up to `limit` `audit_log` rows older than `min(before, 60 months ago)` (the table's trigger refuses a younger one anyway) and up to `limit` owner grants applied or cancelled that long ago (an open grant stays) → `{auditLog, ownerGrants}` |

A replayed request id is `already_applied` (same actor and
target) or `conflict`; a write whose state moved meanwhile is `conflict`.

**Report backend** (`src/reports.ts`, batch C12; routed by C10's session routes, `writes.ts`, for a
member of the org, as the logo routes): `usageRoute` (`GET /api/orgs/:org/usage?from&to&by&apps` → `ConsoleRpc.usage`),
`statementsRoute` (`/statements`: metadata and hashes, no file keys; `issuedBy` is always `hana`, never the staff
address, D371), `statementViewRoute` (`/statements/:month`: `{statement, view}`, the stored totals and console-core
`statementView`, the same view the PDF prints), `statementFileRoute`
(`/statements/:month.csv` / `.pdf`: `STATEMENTS.get` of a key under `statements/<org>/<month>/`, served only when its
sha256 equals the statement's, with `x-hana-sha256`), `ledgerCsvRoute` (`/ledger/:month.csv?asOf`: `ConsoleRpc.ledger`
streamed page by page at one as_of, `x-hana-as-of`; a page failing after the first ends the file with an `# incomplete`
line; at most 200 pages).

**Bindings** (`apps/console/scripts/gen-wrangler.ts`): `CONSOLE_DB` (D1, `migrations/` 0001–0003; 0003 the hourly cron's `cron_runs`, D425: one row per job, `at_ms`, `outcome` `ok`/`error`, `failed_steps`, written after each run, a failed write logged as `console_cron` `record`), `API` → the API
Worker's `ConsoleRpc` (every method but `usage`, `statements` and `ledger`, which C12 adds; `listUsers` and `getUser`
once the wallet directory lands), `LOGOS` and `STATEMENTS` (R2; `STATEMENTS` read only by code), `IMAGES` (the Images binding,
C11), `ASSETS` (`./dist`, the SPA build), `CONSOLE_IP_LIMIT`; vars `ENV_NAME`, `CONSOLE_ORIGIN`, `CONSOLE_AUTH_ORIGIN`,
`CONSOLE_GOOGLE_CLIENT_ID` (the manifest's one `google` console audience, D294), `FILES_ORIGIN`, `NEAR_RPC`,
`SIGNER_ACCOUNT`, `OWNER_GRANT_DELAY_MS`, `NETWORK` and `REFUSED_ORIGINS` (the API's origin rules, C10), `USERS_SCREEN`
(`"1"` turns the Users screen on; written by `gen` from the manifest's `console.usersScreen`, `"0"` when absent, D357, D702); secret `CONSOLE_GOOGLE_CLIENT_SECRET` (the code exchange only). **Cron**
`0 * * * *` (`docs/operations.md` "Partner console Worker"). **Logs**: `staff_rpc`, `link_cancel`, `csrf_refused`,
`auth_*`, `invite_accept`, `console_rpc`, `console_cron`, `audit_write_failed`, `console_error`, `step_up_create`,
`step_up_start`, `step_up_run`, `console_write`, `users_shape`, `logo` (`code` is
`logo_type:<reason>` for a refused file, never its bytes), with method, request id, actor kind, org id, outcome, code
and a refused claim's name only.

**Hourly purge of replaced logos** (D301): the due `logo_objects` rows are deleted first (only while still marked and
replaced more than 30 days ago, `RETURNING`), then those objects from `LOGOS`; if the object delete fails, the rows
are put back for the next hour.

## Files Worker (`apps/files`, its own Worker) · C11

`hana-id-files-<env>` (`files.workerName`) on `files.origin`: partner logos from the `LOGOS` bucket, and nothing else
(D74, D304). No secret, D1, Hyperdrive, service binding, cookie or cron. Bindings (`apps/files/scripts/gen-wrangler.ts`):
`LOGOS` (R2, read only by code: `get` is its only call, a source test) and the var `FILES_ORIGIN`. Placement follows the
origin (D307): `<files.workerName>.<subdomain>.workers.dev` in a `local*`/`sandbox*` env, else a Custom Domain;
preview URLs off.

| Request | Answer |
|---|---|
| `GET`/`HEAD` `/logos/<app_…>/<64 hex>.png` on `FILES_ORIGIN` | `200` with the object, when it exists, is ≤ 128 KiB, has `contentType: image/png`, starts with the PNG signature and its sha256 is the hash in its key. Headers exactly: `Content-Type: image/png`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`, `Cross-Origin-Resource-Policy: cross-origin`, `Content-Disposition: inline; filename="logo.png"`, `Cache-Control: public, max-age=31536000, immutable`, `Referrer-Policy: no-referrer` (plus `Content-Length`). A query string is ignored |
| the same path, any object failing a check | `404` (logged `logo` `rejected` with a code, never the key) |
| `GET`/`HEAD` `/.well-known/hana-build` on `FILES_ORIGIN` (D406) | `200 {"build": "<id>" \| null}`: the build id the Worker was deployed with (`HANA_BUILD`, set only by `run deploy`; `null` when unset or not an id), `application/json; charset=utf-8` with the non-`200` answers' headers below (`no-store`, the sandbox CSP); the bucket never read |
| any other path or host | `404`, the bucket never read |
| any other method | `405`, `allow: GET, HEAD` |
| R2 fails | `503` |

Every non-`200` answer is `text/plain` with `nosniff`, `default-src 'none'; sandbox`, `no-referrer` and
`Cache-Control: no-store`.

## Admin Worker (`apps/admin`, its own Worker; on sandbox-dev since M4) · C8

The Hana staff console's Worker (`hana-id-admin-<env>`) on `admin.origin`, behind Cloudflare Access. It binds the
API's `AdminRpc` (`API`) and the console's `StaffRpc` (`CONSOLE`) and is the only caller of both; nothing binds it.
Built in C8 (merged; on sandbox-dev since milestone M4, `docs/operations.md` "Admin Worker"; D278–D285); the reports,
statements, rates, exports, settlement and the daily ledger checks in C12 (`feat/batch-c-12`, D320–D329; milestone M6,
`docs/operations.md` "Reports and statements"); the monthly retention job and its screen in C13 (`feat/batch-c-13`,
D360–D369; milestone M6, `docs/operations.md` "Retention").

**The build id (D406): no route.** The Worker is deployed with the `HANA_BUILD` var (its `run deploy`, the shared
wrapper), but no path serves it: the origin is behind Access, with no exception. `deploy-check` reads it from the
deployed version's metadata with wrangler (`docs/operations.md` "Checking a deploy"). The same holds for the watchdog,
whose every route needs its status token.

**Every request.** The Worker runs first (assets with `run_worker_first`). A host other than `ADMIN_ORIGIN`: `404 Not
found`. **`/api/*`**: first the Access check, then (non-GET) the CSRF checks, then the route:
- **Access** (D88): the `Cf-Access-Jwt-Assertion` header only (no cookie, no `ctx.access`), verified with
  `@hana-id/oidc` `AccessJwtVerifier`: RS256 with a `kid` in `https://<ACCESS_TEAM_DOMAIN>/cdn-cgi/access/certs` (cached
  ≤ 10 min, never stale), `iss = https://<ACCESS_TEAM_DOMAIN>`, `aud` contains `ACCESS_AUD`, `exp`/`nbf` (60 s skew),
  `type = 'app'`, a non-empty `sub` (no service token) and `email`; then the lowercased email must be in
  `STAFF_EMAILS`. No or a bad token: `401 unauthenticated`; not on the list: `403 not_staff`; `ACCESS_AUD` `UNSET`, an
  unusable staff list or unreachable certs: `503 access_unavailable`.
- **CSRF** (every non-GET request, any path): `Sec-Fetch-Site: same-origin`, `Origin` = `ADMIN_ORIGIN`,
  `x-hana-admin: 1`, `content-type: application/json`, else `403 csrf`.
- The staff actor `{kind: 'hana', id: <Access sub>, email}` is the actor of every RPC call (into `app_changes` and
  `audit_log`); the request id is the `cf-ray` (else a random one), the client IP `cf-connecting-ip`. A route builds
  its RPC input from named fields only.

Everything else is the SPA (`public/`: plain HTML, CSS and JavaScript; `GET`/`HEAD` only, its fallback for unknown
paths; Access guards it at the edge). Every response carries the console's CSP and headers (`docs/batch-c-spec.md`
"Response headers"); `/api/*` also `Cache-Control: no-store`; no response sets a cookie. Errors are
`{error: {code, message}}`; RpcCodes keep console-core's status; `503 upstream_unavailable` when the API or console
binding throws; `405` with `allow`; `413` over 64 KiB (16 KiB without a `Content-Length`).

| Route | Body or query → answer | Calls |
|---|---|---|
| `GET /api/me` | → `{email, sub, env, consoleOrigin, accessExp, renewUrl?, scopeRegistration}`: `scopeRegistration` is the `SCOPE_REGISTRATION` var checked (`src/scope-registration.ts`; `{ownerKind, owner, councilMembers, devCouncilKeys, sharedClientIds}`, public manifest values, `null` when absent or malformed), from which the organisation page's "Register a scope" panel writes the `scope:register` command (D651; nothing is sent); `accessExp` is the verified Access token's `exp` (seconds), when this sign-in ends, for the SPA's warning before it (D424); `renewUrl` is the Access team's login for this application (`https://<team>/cdn-cgi/access/login/<admin host>?kid=<aud>&redirect_url=%2Fsigned-in`, public values; omitted when the team domain or AUD is malformed), which mints a fresh token while the team session lasts, for the SPA's Renew (D424 amended); the token itself is never answered | — |
| `GET /api/status` (D425) | → the System status answer (below) | watchdog `GET /status`, `AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`, the public build reads, NEAR `block` on `NEAR_RPC`, each of `NEAR_RPC_FALLBACKS` and a separate `NEAR_RPC_FALLBACK`, one ledger connection, a `get` on `STATEMENTS` and `EXPORTS`; kept 30 s in the isolate |
| `GET /api/orgs?cursor` | → `{orgs, next?}` (100 a page) | `StaffRpc.listOrgs` |
| `GET /api/orgs/:org` | → `{org, members, invites, grants, securityContacts, apps, flags: {noSecurityContacts, ownersNotContacts}}` | `getOrg`, `getSecurityContacts`, `AdminRpc.listApps` |
| `POST /api/orgs/:org/freeze`, `/suspend` | `{frozen}`, `{suspended}` | `StaffRpc.freezeOrg`, `AdminRpc.suspendOrg` |
| `PUT /api/orgs/:org/security-contacts` | `{emails}` (trimmed and lowercased here) → `{emails}` | `setSecurityContacts` |
| `GET /api/orgs/:org/members` | → `{members, invites, grants}` | `getOrg` |
| `POST /api/orgs/:org/members/:user` | `{role: 'owner' \| 'viewer' \| null}` | `setMember` |
| `GET /api/orgs/:org/changes?beforeSeq` | → `{changes}` (100) | `AdminRpc.listChanges` |
| `POST /api/invites`, `/api/invites/:id/revoke` | `{email, role, orgId? \| newOrgName?, kind?}` → `{invite}` (never a token; the cron emails it) | `issueInvite`, `revokeInvite` |
| `GET /api/invites/new-orgs` (D696) | → `{invites, truncated}`: the Organisations page's "Pending invites" (invites to organisations not created yet: open, and ended in the last 30 days; at most 100) | `StaffRpc.newOrgInvites` |
| `POST /api/users/:user/disable`, `/api/owner-grants/:id/cancel` | `{disabled}`, `{}` | `disableUser`, `cancelOwnerGrant` |
| `POST /api/apps` | `{orgId, scopeId, environment, name, origins}` → `{app, publishableKey, createdScope}` | `listMembers` (the org's usable owners' subs), `createApp` |
| `POST /api/scopes/:scope/assign` | `{orgId}` → `{apps}` | `listMembers`, `assignScopeOrg` |
| `GET /api/apps/:app?org=` | → `{app}` | `getApp` |
| `POST /api/apps/:app/suspend`, `/resume`, `/delete` | `{bit}` (suspend: 1 by default) → `{suspendedBy}`; `{}` | `setSuspended`, `deleteApp` |
| `POST /api/apps/:app/origins`, `/origins/remove`, `/changes`, `/off` | `{orgId, add, expectedVersion}`, `{orgId, remove, expectedVersion}`, `{orgId, kind, policy?, expectedVersion}`, `{orgId, what, expectedVersion}` | `addOrigins`, `removeOrigins`, `proposeChange`, `turnOff` |
| `POST /api/apps/:app/mainnet-demo` (D428) | `{orgId, on, expectedVersion}` | `setMainnetDemo` (a dev testnet env, a test app) |
| `POST /api/apps/:app/keys/:key/revoke` | `{orgId}` | `revokeKey` |
| `POST /api/changes/:id/cancel`, `/expedite` | `{orgId}`, `{reason}` (≥ 20 characters) | `cancelChange`, `expediteChange` |
| `GET /api/audit?orgId&appId&actorKind&actorId&action&from&to&cursor&changesBefore&dirStaff&dirAction&dirBefore` | → `{rows, next?, changes, directory}` (`changes`: the org's `app_changes` when `orgId` is set, else null; `directory` (C8b): the email issuer's `email_admin_audit` rows, newest first, 100 a page, `{rows, next?}` (`next`: the `dirBefore` of the next page), `{error}` when the issuer fails (the page stays up), null without an `ISSUER` binding) | `queryAudit`, `listChanges`, `DirectoryRpc.auditSince` |
| `GET /api/audit.csv?…` (same filters) | CSV (`source, seq, at, org_id, app_id, scope_id, action, actor_kind, actor_id, actor_email, target, outcome, request_id, near_tx, country, detail`), newest first, ≤ 5 000 rows per source (`x-hana-truncated: 1` past it); text cells starting `=`, `+`, `-`, `@`, tab or CR get a `'` | as above |
| `GET /api/security` | → the notice backlog, unnotified security events, each feed cursor with its lag, the watcher's cursor, the last cron run; C12's `ledger`: each relayer key's latest nonce check, rejection-rate alerts, settlement alerts, the settlement backlog (`pending`, `oldestAt`), `partitionsAhead` and `partitionsLow` (< 2) | `pendingNotices`, `pendingMemberNotices`, `securityEvents`, `changesSince`, `auditSince`, `ops.state`, the ledger |
| `GET /api/monitoring` (C14) | → `{now, env, watchdog, governance, events, findings}` (below) | watchdog `GET /status`, `AdminRpc.governance`, `securityEvents({unnotifiedOnly: false, limit: 100})`, in parallel, each failing on its own |
| `GET /api/monitoring/alerts?cursor&severity` (C14) | → `{alerts: [alert view], nextCursor}` (25 a page, newest first); `cursor` a positive integer, `severity` `critical`/`warning`/`info`, else `400` | watchdog `GET /alerts` |
| `GET /api/monitoring/actions?cursor` (C14) | → `{actions: [{id, runId, at, method, args, reason, ok, txHash, txUrl, error}], nextCursor}` (50 a page); `txUrl` a nearblocks link for a valid hash on testnet or mainnet | watchdog `GET /actions` |
| `POST /api/monitoring/alerts/:id/ack` (C14) | `{}` (any body field is ignored) → `{alert}`; `409 already_acknowledged` with the alert (the first ack is kept); `404` for an unknown alert or an id that isn't a positive integer (no call) | watchdog `POST /alerts/:id/ack {by}`, `by` = `<email> (access:<sub>)` (or `access:<sub>` when the email has characters the watchdog refuses) |
| `GET /api/governance/pending-upgrades` (C14) | → `{pendingUpgrades}` (the view of `ConsoleRpc.pendingUpgrades` above) | `AdminRpc.pendingUpgrades` |
| `GET /api/playbooks?q&kind&severity` (C14) | → `{notes, actors, lastVerified, playbooks: [{id, title, kind, severity, status, summary, alertKinds}]}`: every playbook of `@hana-id/playbooks` (bundled), filtered by kind and severity, and by `q`: every word in the title, summary, signals or impact (case-insensitive); `400` for another kind or severity or a `q` over 200 characters | — |
| `GET /api/playbooks/:id` (C14) | → `{notes, playbook: {id, title, kind, severity, status, summary, alertKinds, signals, impact, steps: [{n, title, who, detail, commands}], verify, followUps, refs: [{ref, href}], related: [{id, title}]}}` (commands verbatim, placeholders unfilled; `href` the repo's file on GitHub); `404` | — |
| `GET /api/reports?org&from&to&by&apps` (C12) | → `{rows: UsageRow[]}` for any org (no as_of bound; `afterStatement` counts late events) | `usage.org_report` |
| `GET /api/statements?org` (C12) | → `{statements}` (metadata, hashes, totals, keys) | `usage.org_statements` |
| `GET /api/statements/:org/:month` (C12) | issued: `{statement, view}` (console-core `statementView` of the stored totals, D92); not issued: `{statement: null, issuableFrom, blockers: {pending, missingRateDays}}` | `org_statements`, `statement_blockers` |
| `GET /api/statements/:org/:month.csv`, `.pdf` (C12) | the file from `STATEMENTS`, only when its sha256 equals the one frozen in Neon (else `500` and an error line), `x-hana-sha256` | `STATEMENTS.get` |
| `POST /api/statements/:org/:month/issue` (C12) | `{}` → `{statement, view, auditRecorded}`; `409 conflict` before the 3rd of the next month 00:00 UTC, with a relayed event not settled, with a day without a rate, or when issued already | `statements.ts` (D326), `StaffRpc.getOrg`, `AdminRpc.listApps`, `recordStaffAction` |
| `POST /api/exports/:org/:month` (C12) | `{asOf?}` (ms; a statement's, to reconcile) → `{key, file, sha256, rows, asOf, finalGas, finalTokens}`; more than 200 000 rows is `409` | `usage.org_ledger`, `EXPORTS.put`, `recordStaffAction` |
| `GET /api/exports/:org/:month/:file` (C12) | the export CSV (kept 30 days by the lifecycle rule) | `EXPORTS.get` |
| `GET /api/rates?month` (C12) | → `{month, rates, overrides, missing}` | `near_usd_rates`, `rate_overrides` |
| `PUT /api/rates/:day` (C12) | `{usd: '2.345678', reason}` (≤ 6 decimals as a string; reason 10–500 characters) → `{day, usdMicros, source: 'manual', overrideId}`; a month with a statement is `409`, a future day `400` | `usage.override_rate`, `recordStaffAction` |

| `GET /api/retention` (C13) | → `{month, dueAt, done, state, nextRunAt, maxCallsPerRun, warning, runs, due, erasures}`: the month's state (`due`, `continuing`, `done`, `not_yet`, `running`, `retry_later`), a `warning` while the last run failed or the month has no complete run an hour after its due time, the last 24 runs (`id`, `month`, `startedAt`, `finishedAt`, `status`, `rows` per table, `error`), the latest `retention_due` counts and the last 20 erasures (ticket, operator, scope, counts) | `ops.retention_runs`, `ops.erasures`, the job's `dueState` |
| `POST /api/support/lookup` (C15) | `{query, ticket, requestIds?, days?}` → `SupportLookupView` plus `emails` (below); the audit row first | `recordStaffAction`, `AdminRpc.supportLookup`, `usage.events`, `DirectoryRpc.get` (`purpose: 'support_lookup'`) |

The C12 and C13 routes open one ledger connection per request (`USAGE_DB`, `usage_admin`); without it they answer `503
ledger_unavailable`.

**The Users screen (C8b; D275 as confirmed 2026-11-05, D388–D392).** POST only, so no address, sub or code is in a
URL; each forwards the request's `Cf-Access-Jwt-Assertion` as it came, for the issuer's own check.

| Route | Body → answer | Calls |
|---|---|---|
| `POST /api/users/search` | `{q?, provider?, appId?, sub?, unverifiedOnly?, cursor?, limit? (≤ 100, default 50), ticket?}` → `{users: [{provider, sub, email, emailVerified, hosted, unverifiedClaim, firstSeenMs, lastSeenMs, appCount}], next?, unverifiedWarning}`; `q` a full address (exact) or ≥ 3 characters of one (substring); `ticket` required with `sub` or a full address (`400` before any call, D410), optional otherwise | `DirectoryRpc.search` |
| `POST /api/users/find` | `{query, ticket}` (a wallet address, User ID `u1_…`, internal id `hu_…` or Support ID; a sub is `400`; the ticket required) → `{users: StaffUser[]}` (no address; the SPA sends a Support ID to the lookup screen, `POST /api/support/lookup` below, and calls `find` for the rest and for the lookup screen's "Wallet directory only"). The `audit_log` row first (`recordStaffAction`, `users.find`, org-less, `target` the normalized id or address, `details {by, ticket}`), `503` / `500` with nothing read when it can't be written (D410) | `recordStaffAction`, `AdminRpc.findUsers` |
| `POST /api/users/get` | `{provider, sub, ticket}` (the ticket required: `400` before any call) → `{provider, sub, user \| null, warning?, apps: [{appId, scopeId, firstSeenMs, lastSeenMs, name, orgId, environment, deletedAt}], appsTruncated?, appNamesError?, walletUsers: StaffUser[] \| null, walletError?, chain: [{scopeId, ok: true, blockHeight, status, opened, identityKey, path, root, effectiveAtMs, account, accountUnread?} \| {scopeId, ok: false, reason: 'chain_unavailable' \| 'not_read'}]}`; `user` null when the directory has no row (the miss is audited) | `DirectoryRpc.get`, `AdminRpc.findUsers({query: sub, provider})`, `AdminRpc.appNames`, `get_identity` / `get_account` per scope (at most 8) |

Errors: `503 directory_unavailable` (no `ISSUER`, the issuer didn't answer, or its own Access check can't run), `502
directory_refused` (the issuer refused a staff identity this Worker accepted: the two Access configs differ), `429
rate_limited` with `Retry-After` past the staff member's row budget (the security alias gets `directory_budget`, one
per staff member and window), `400` / `404` / `500` as the issuer answers. A detail's outbound calls come out of one
budget of 40 (at most 30 RPCs, D380): what doesn't fit is `not_read`. The SPA's Support ID lookup screen (`/support`)
calls `POST /api/support/lookup` below.

**The Support ID lookup (C15; D394–D396, D399; `src/support.ts`).** `POST /api/support/lookup` `{query, ticket,
requestIds?, days?}` (console-core `supportLookupBody`, strict: `query` as `AdminRpc.supportLookup` takes it; `ticket`
in console-core `SUPPORT_TICKET_RE`, 1–64 letters, digits or `._#:-`, the issuer's rule too (D399); up to 20
`requestIds` as the API's `x-request-id`; `days` 1–731, 30 by default; else `400 bad_request`) → console-core
`SupportLookupView` and the email join (below): `AdminRpc.supportLookup`'s answer plus
`days`, `ledger` (`{available: true}` or `{available: false, reason}`, the reason starting `ledger unavailable`),
`activity` (per match, its ok `login`, `session` and `derive` events by uid over the window, newest first, at most 400:
`{requestId, at, appId, endpoint, status, latencyMs, relayed, nearTx}`; null without the ledger), `requests` (the
request IDs' events whatever the outcome, at most 100: `{requestId, at, orgId, appId, scopeId, endpoint, outcome, code,
status, latencyMs, relayed, nearTx, byMatch}`, `byMatch` when it carries a match's uid; null without the ledger) and
`requestsNotFound`. Order: the `audit_log` row first (`StaffRpc.recordStaffAction`, action `support.lookup`, no org,
`target` the query as given, `details {by, ticket, requestIds, requestIdList?, days}`, `requestIdList` the distinct request IDs, D410), and `503 upstream_unavailable` / `500
internal` with nothing read when it can't be written; then `AdminRpc.supportLookup` (its refusal as is); then the
ledger over `USAGE_DB` (`usage_admin`, `SUPPORT_ACTIVITY_SQL` on `events_uid_at`, `SUPPORT_REQUESTS_SQL` on the
primary key). Without the binding, a connection or a read: still `200`, with `ledger: {available: false}`. Together
with the ledger, **the email join** (D399): for each distinct `directoryKey` of the matches' identities, at most
`SUPPORT_EMAILS_MAX` (20) in parallel, `DirectoryRpc.get({…, ticket, provider, sub, purpose: 'support_lookup'})` with
the request's Access JWT, so the issuer audits each read as `support_lookup` (the same ticket, `detail.lookup` = this
request's id, the console row's `request_id`) and takes it from the staff member's row budget. The answer adds `emails:
[{provider, sub, found: true, email, emailVerified, hosted, unverifiedClaim, firstSeenMs, lastSeenMs} | {provider, sub,
found: false, reason: 'not_found' | 'not_read' | 'no_directory' | 'directory_unavailable' | 'directory_refused' |
'rate_limited' | 'failed'}]`, `emailsNote?` (no issuer bound; the row budget reached, with its window, after the
security alias is emailed `directory_budget` as the Users routes do; identities past 20) and `unverifiedWarning?`
(console-core `UNVERIFIED_CLAIM_WARNING`, when an address is a Google account's unverified claim). An issuer failure
never fails the lookup: each identity says why. POST only (`405` otherwise), CSRF rules as every write. Logs carry
counts only (`calls: {directoryRead, directoryMissing}`), never the query, a sub or an address.

**System status (D425; `src/status.ts`, `src/status-probes.ts`; apps/admin/README.md "System status" has every
check and threshold).** `GET /api/status` → `{checkedAt, env, verdict: {state: 'ok' | 'warning' | 'critical', title,
critical, warning}, issues: [{id, severity: 'critical' | 'warning', component, componentName, title, affects, action,
since, sinceSource: 'source' | 'first_seen', link: {path, label} | null, playbook: {id, title} | null}] (critical
first), groups: [{id, title, tiles: [{id, group, name, state: 'ok' | 'warning' | 'critical' | 'unknown' |
'not_measured', detail, affects, latencyMs, build, link, lines?: [{label, state, detail}]}]}], builds: {majority, mixed, pieces: [{component, build}]},
notMeasured: [{what, why}], calls: {total, byKind}, cacheMs, cached, ageMs}`. `verdict.title` is "All systems
operational" only with no issue; a tile that couldn't be checked is `unknown`, and every unknown tile is behind an
issue (its own, or the one failure that hid it). A cold read makes at most 22 outbound calls (20 on sandbox-dev: one
NEAR read per endpoint, `calls`; the Access certs fetch before the route adds one on a cold isolate), every source in parallel with its own deadline (the public
build and NEAR reads 5 s with the body, at most 16 KiB read, 256 B of `vault.js`, no redirect followed, no
credential); the answer is kept in the isolate for 30 s (`cached: true`, `ageMs`) and concurrent misses share one
read. No secret is in it: the admin's own keys are named present or missing, never shown. `500 internal` only if the
mapping itself throws (not cached).

**Security & monitoring (C14; D83, D126, D330–D338).** The watchdog is called **server-side only**
(`src/watchdog.ts`): `Authorization: Bearer <WATCHDOG_STATUS_TOKEN>` to `WATCHDOG_URL` (an https origin exactly; else
nothing is called), `redirect: 'manual'` (a 3xx is refused, never followed), an 8 s deadline that covers the body, and
a cap per route (`/status` 1 MiB, `/alerts` 2 MiB, `/actions` 512 KiB, an ack 64 KiB) by `Content-Length` and while
streaming. Its failures are admin codes, never its text: `503 watchdog_unconfigured` (no URL or usable token here, or
the watchdog's own 503), `502 watchdog_unauthorized` (its 401: the token copies differ), `504 watchdog_timeout`, `502
watchdog_too_large`, `502 watchdog_bad_answer` (a redirect, not a JSON object), `502 watchdog_unavailable` (network, 5xx).
The token is in no response, log line or error. Everything the watchdog answered is reduced to bounded plain data
(`src/plain.ts`: C0/C1 controls and bidi overrides become U+FFFD, strings cut at 2 000 characters, arrays at 500 items,
objects at 200 keys, depth 8) and picked field by field; the SPA writes it as text. An **alert view** is `{id, kind,
severity, title, details, createdAt, resolvedAt, ackedAt, ackedBy, ackedVia, lastSentAt, sendCount, channels,
resendsUntilAck, open, canAck, deliveries (the last 20), deliveriesTotal, deliveriesLatest (the newest row of each
channel, out of all the watchdog served), playbook: {id, title} | null}`: `open` is
the condition (an ack never changes it), `canAck` an unacknowledged alert that is re-sent until acknowledged
(critical), `playbook` the id the watchdog serves for the kind if it names a package playbook, else
`playbookForAlertKind`, else null (the SPA shows "no playbook"). `GET /api/monitoring`'s `watchdog` is `{ok: false,
code}` or `{ok: true, env, network, signer, watchdogAccount, now, runIntervalMs, resendMs, initializedAt, lastRun,
silent (no finished run within two intervals, by the watchdog's or this Worker's clock), sinceLastRunMs, checks: [{id,
title, shownIn, description, outcome, detail, known}] (every check of `src/monitoring-registry.ts` and every one the
watchdog serves; `known: false` for one the portal has no rendering for), heartbeat, channels, seenKids, relayerFunds,
email, linkStats, identity, actions, openAlerts, alertKinds: [{kind, severity, check, description, playbook}]}`;
`governance` is `{ok: false, code}` or the snapshot plus `keyChanges[].watchdogSeen` (the watchdog's sighting of the
kid), `pause: {paused, unpausedAtMs, lastWatchdogPause}`, `updaterKeyCheck: [{publicKey, onAccount, permissionOk}]` and
`otherSignerKeys`; `findings` is `[{severity, source: watchdog | governance | portal, text, playbook?}]`, critical
first (D337).

**Cron** `*/5 * * * *` (`src/cron.ts`; D280, D380), as the `system` actor, with at most 40 outbound calls a run, every
kind counted: the ops connection, every `AdminRpc` and `StaffRpc` call (at most 30 of the 40: a request's 32 Worker
invocations), every email and every `get_scope`. A notice is started only when its lookups, every email and its ack
fit what is left, a digest or a scope only when its reads and emails do, a page only with room for one of them after
it; what doesn't fit waits whole for the next run (the cursors stay). Each job's share is in `cron.last_run` (`calls`)
and the run's `cron` `budget` log line:
1. **Blocking notices** (`src/notices.ts`; D279): `AdminRpc.pendingNotices` → one message to the security alias and to
   each security contact, with `<CONSOLE_ORIGIN>/cancel/<id>#t=<T>` (T = HMAC(`CANCEL_LINK_KEY`, cancel-link layout))
   → `AdminRpc.ackNotice({changeId, cancelTokenHash: b64url(sha256(T))})`. `StaffRpc.pendingMemberNotices`: an invite's
   notice to every owner, the contacts and the alias, then the invitee's `<CONSOLE_ORIGIN>/invite#t=<T>` (key
   `INVITE_LINK_KEY`) → `ackMemberNotice({inviteId, tokenHash})`; an owner grant's notice with
   `<CONSOLE_ORIGIN>/cancel-owner/<id>#t=<T>` (key `CANCEL_LINK_KEY`) → `ackMemberNotice({grantId, tokenHash})`. **An
   ack only after every send was accepted** (SendGrid `202`, D401); a missing key or sender acks nothing.
2. **The feed** (`src/feed.ts`; D281): `securityEvents({unnotifiedOnly})` → the alias and the org's contacts →
   `markSecurityEventNotified`; `changesSince(feed.app_changes.seq)` and `StaffRpc.auditSince(feed.audit_log.seq)` →
   one digest per org to its contacts (the alias when it has none), the cursor in `ops.state` moved only past
   accepted rows. A `settings.changed` row with `loginMethods` also gets its own mail to the alias and the org's contacts
   (`login_methods_changed:<seq>`, `getApp` for the app's name, D444 as amended); a row that changes nothing else then
   leaves the digest. A cursor with no row yet is first set to the source's latest seq without sending anything (D344;
   pages of 500, at most 10 a run, the place kept in `<key>.init` until the end is reached). Skipped: proposals and announcements (the blocking notice covers them), the notices' own audit rows,
   the console's link-cancel row.
3. **The watcher** (`src/watcher.ts`; D282): 15 scopes a run from `listScopes` (round-robin, `watch.scope_cursor`),
   `get_scope` uncached on `NEAR_RPC`; each pending change emailed once (`ops.scope_watch`), each owners/clients/
   `allow_shared` diff against `ops.scope_snapshot` emailed once; a first sight is stored silently as the baseline.

Steps 2 and 3 need `USAGE_DB`; without it (or with Neon down) they are skipped and step 1 still runs.

**Cron** `*/15 * * * *` (C12, `src/ledger-cron.ts`; D322, D380), one ledger connection and its own 40 outbound calls,
every kind counted: the connection, `AdminRpc.relayerKeys`, the retention RPCs, each statement notice's
`getSecurityContacts` and `StaffRpc.getOrg`, every email, `tx`, `view_access_key` and rate fetch. Each job's share is in
the run's `ledger_cron` `budget` log line (`calls`), and from D425 the run is recorded in `ops.state` `ledger_cron.last_run`
(`{at, budgetLeft, calls, failed}`, the failed steps' names) on the run's open connection, a query, not a call:
1. **Alerts** (`src/alerts.ts`): one digest each to the security alias of the unexplained nonce checks
   (`nonce_unexplained`), the rejection-rate alerts (`rejection_rate`) and the settlement alerts not yet sent,
   `alerted_at` set only after the send was accepted.
2. **Statement notices**: each statement without an `ops.statement_notices` row is emailed (org name, month, as_of,
   both sha256s) to the org's security contacts, its `billing_email` and the alias; the row is written once every send
   was accepted. At most 5 a run, each two RPCs and one call per recipient; one that doesn't fit what is left waits,
   with the rest, for the next run.
3. **Settlement** (`src/settlement.ts`; D321, D322, D590): `AdminRpc.relayerKeys` (every pool, each key with its pool), then relayed events without
   a settlement row, oldest first, at most the budget left (≤ 500), each read at most once an hour
   (`ops.settlement_tries`). A `near_tx` another relayed event carries → `unsettled` `duplicate_tx`; a `relayer_pk`
   not in the pools, or in the wrong one (a `home_login` event must carry a Home pool key, and no other event may:
   `wrongPool` in the alert) → `unsettled` `signer_mismatch` (a refusal is final: the event is never read again, D599); otherwise `tx` at `wait_until: FINAL` (`sender_account_id` =
   `RELAYER_ACCOUNT`): signed by `RELAYER_ACCOUNT` with that key at that nonce, to `SIGNER_ACCOUNT`, with that hash →
   `final` with the BigInt sums over the transaction and every receipt; any mismatch → `unsettled`
   `signer_mismatch` with the chain's values. Each refusal also writes `ops.settlement_alerts` (emailed by step 1).
   Not final after 24 h → `unsettled` `not_final`. Needs `RELAYER_ACCOUNT` (else skipped, logged).

**Daily, in the 00:30 UTC run of the `*/15` cron** (C12, D329; before that run's alerts, notices and settlement, sharing its 40 calls): the **nonce cross-check** (`src/nonce-check.ts`; D323: from H11 it runs in every `*/15` run from 00:30 UTC on, reading at most three keys a run until each of the day's keys was tried once (D598); while the API reports usage capture off it records baselines with reason `capture_off` and alerts nobody, and the first check after capture is back is a fresh baseline (D596); each pool key's
`view_access_key` nonce at final against the ledger's relayed `(relayer_pk, relayer_nonce)`; one `ops.nonce_checks`
row per key), the **rejection-rate check** for the previous UTC day (`src/rejections.ts`: ≥ 100 relayed and > 5 %
rejected → one `ops.rejection_alerts` row per org and day), `usage.ensure_partitions(12)` (the second keeper beside
the API's hourly one), the alerts (as above), then the **NEAR/USD rate** (`src/rates.ts`; D325: CoinGecko's daily
history for each day of the last 10 without a rate, never replacing one; `COINGECKO_API_KEY` optional).

**Monthly, in the `*/15` cron from the 1st 01:00 UTC** (C13, `src/retention.ts`; D360; after the daily work and
before the alerts, at most 12 of the run's 40 calls): the **retention job** while the month has no `ok` run. One
`ops.retention_runs` row per run (a second can't start while one runs; one `running` for more than 30 min is closed as
`failed`, `abandoned`); each step on its own, its error recorded as the step and a code: `strip_uids` (≤ 20 calls of
10 000), `drop_expired_partitions`, `ops.purge_expired`, `retention_due` (Neon, no outbound call), then
`AdminRpc.deletedApps` → `usage.purge_app_users` per app (the cursor in `ops.state` `retention.deleted_apps_after`,
moved after each page), `AdminRpc.purgeDirectory`, `AdminRpc.purgeUserEvents` (24 months and dead scopes, D433),
`AdminRpc.purgeAudit` and `StaffRpc.purgeAudit` in batches of 500
(each call one of the budget). A run out of calls ends `partial` and the next 15-minute run continues; a `failed` one
is retried an hour after. **`retention_failed`** to the alias: the failed runs not yet emailed, at most one digest a day
(a failure whose month has since completed is marked without an email); once a month, a month with no complete run a
day after its due time (overdue); and from the due tick only, a run that couldn't start for want of the ledger
(skipped). The issuer's directory isn't reached from here: `admin <env> retention:issuer` (D365).

**Email** (`src/email/`): `EmailSender` (one message in, accepted or an error), the SendGrid adapter
(`sendgridSender` over `@hana-id/sendgrid`: `POST https://api.sendgrid.com/v3/mail/send` with `EMAIL_API_KEY`, accepted
only on `202`, 10 s timeout, click, open and subscription tracking off, category `hana-id-admin`; errors name the HTTP
status only; D401). SendGrid has no idempotency key: `sendToAll` (`mail.ts`) keys each message by sha256(purpose ‖
recipient) and, per isolate for 24 h, doesn't send again one SendGrid accepted, so a retry goes only to the recipients
that failed; across isolates a message can arrive twice, never zero times. One message per recipient, plain text plus simple HTML, no remote image, links only to
`CONSOLE_ORIGIN`, never an approve link; partner text escaped and stripped of control characters, subjects on one line.

**Bindings** (`apps/admin/scripts/gen-wrangler.ts`; D284): `API` → `AdminRpc`, `CONSOLE` → `StaffRpc`, `USAGE_DB`
(Hyperdrive, the admin config, `--admin-hyperdrive-id`), `ASSETS`; vars `ENV_NAME`, `ENV_LABEL` (a non-production env's subject label, `[SANDBOX]` etc., D419; absent on production), `ADMIN_ORIGIN`, `CONSOLE_ORIGIN`,
`FILES_ORIGIN`, `NEAR_RPC`, `SIGNER_ACCOUNT`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `STAFF_EMAILS` (JSON),
`EMAIL_FROM`, `SECURITY_ALIAS`, `APP_CHANGE_DELAY_MS`, `OWNER_GRANT_DELAY_MS`, from D425 `API_URL`, `VAULT_ORIGIN`, `AUTH_ORIGIN`, `EMAIL_ISSUER_URL`, `CONSOLE_AUTH_ORIGIN`,
`NEAR_RPC_FALLBACK` (each only when the manifest has it) and `ACCOUNT_CRONS` (JSON `[{worker, crons}]`: the manifest's cron
Workers on the API's account), and from C14 `NEAR_NETWORK` and
`WATCHDOG_URL` (manifest `watchdog.url`; absent in a dev env without it, required on a production manifest), and
`SCOPE_REGISTRATION` (JSON: the manifest's owner kind, owner, council members, whether the council's keys are on disk
here, shared client ids; D651); secrets
`EMAIL_API_KEY`, `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` and from C14 `WATCHDOG_STATUS_TOKEN` (never in the config).
`preview_urls: false`; `workers_dev: true` only for a workers.dev `admin.origin` in a dev env, else a Custom Domain
route. No D1. From C12 the R2 buckets `STATEMENTS` (`put` of new keys and `get` only: a source check) and
`EXPORTS`, the var `RELAYER_ACCOUNT`, the optional secret `COINGECKO_API_KEY` and the `*/15 * * * *` cron; a
statement's network is `NEAR_NETWORK`. **Logs**: `access_refused`, `csrf_refused`, `bff`, `notice`, `feed`, `watcher`, `cron`,
`admin_error`, from C12 `ledger_cron` (C13 adds its steps `retention`, `retention_alerts`), `statement`, `export`, and from C14 `watchdog_call` (route, outcome, status, code) and `watchdog_ack` (`target: alert:<id>`),
with route patterns, request ids, org, scope and target ids, outcomes, codes and counts only: never an email, a `sub`,
a JWT, a link token or its hash, nor the watchdog's token.

### Email login views (build plan batch 9, D446, D448)

`GET /api/email/issuer?days=` (default 14, up to 31): `{days, appNames, stats: {days, truncated, issuance: [{day, appId|null, purpose, count}], metrics: [{day, appId|null, metric, count}]} | {unavailable}, policy: {required, signers, keys: [{kid, signer, onChain, pinned}], iss, matchesPins, pinsConfigured} | {unavailable}, kms: {signerKind, note}}`. Counts from `DirectoryRpc.issuerStats`; the policy from `get_self_issued`, `get_issuer_keys`, `get_issuer` against `EMAIL_PINNED_KEYS`; a part that can't be read is `{unavailable}` beside the rest (200).
`GET /api/email/links?days=`: `{days, today, rows, jumps: [{appId, appName, today, median, jumped}]}` (`AdminRpc.linkStats`; 503 when the API doesn't answer). Staff only, like every admin route. No audit row (no person's data).

## Email issuer (`apps/email-issuer`, its own Worker) · E

**E** marks the email login's issuer (`docs/email-login-spec.md` "Email issuer (Hana-run)", build plan batch 4,
D195–D199). It is a separate Worker from the API (Q1): it alone holds the email signing key, K_sub, K_code, K_rl and
the SendGrid key; the API holds none of them. It serves `{url}/v1/email/*`, `url` being `emailIssuer.url` (on a
`workers.dev` env the issuer's own `workers.dev` URL) or, absent, the API's URL with a zone route that sends those paths
to this Worker; its iss is `{url}/v1/email`. Requests never pass through the API Worker (D230). Below, `/v1/email/…`
is under that `url`. Its browser caller is the login popup's `/login/email` (`packages/web/src/auth/email-api.ts`,
batch 8a: `start` with purpose `session`, the session commitment and this device's ticket for the address, then
`resend` and `verify`; it never calls `google-match` yet). On sandbox-dev since 2026-11-03, where the demo's app has email in its `login_methods`. It reads the chain (views only) and
the API's apps through `IssuerRpc` (above; no API D1 binding, D434); it writes nothing on chain.

### Conventions

- Browser routes are `POST` JSON (`Content-Type: application/json`, else 415) from exactly one origin each (D199):
  `start`, `resend`, `verify` from `AUTH_ORIGIN`, `google-match` and `google-record` from `VAULT_ORIGIN`; any other or missing `Origin` is
  `403 origin_not_allowed` with no CORS headers; an allowed origin's responses (preflight `204` too) carry
  `access-control-expose-headers: retry-after`, so the vault and the auth page can read it. No cookies, no credentials (D70). Bodies ≤ 8 KB, exactly the listed
  fields (else `400 bad_request`); only `start` carries an address. Every response `Cache-Control: no-store`.
- Errors are `{error, code, data?}`. Thrown failures: `503 signer_unavailable` (no, a malformed or a non-active
  ISSUER_SIGNING_KEY, a self-check failure), `503 issuer_unavailable` (a missing HMAC key), `503 api_unavailable` (an app lookup the API's `IssuerRpc`
  didn't answer: no binding, the API not serving it yet, a refusal or a malformed answer; D434), `502 near_unavailable`,
  `502 google_unavailable`, `500 internal`. `429` carries `retry-after`.
- **The app gate** (`start`, `google-match`): `pk` → the API's app through `IssuerRpc.appByKey`, by the gate's model (D233): an `app_keys` row
  not revoked or still in its rotation grace, of an app not deleted (`401 invalid_key`); active only with
  `suspended_by = 0` and `status = 'active'` (`403 app_suspended`); `login_methods` lists `email`
  (`403 email_not_enabled`; the API's migration 0010, absent = email off); `apps.publishable_key` is never read; and the scope holds the client `("email", "email:" + scope_id)` on chain (cached 60
  s; `409 no_email_client`). The commitment's `scopeId` must be the app's (`400 scope_mismatch`).
- **Tokens** are JWS General JSON (`{"payload", "signatures": [{"protected", "signature"}]}`, protected header exactly
  `{"alg":"RS256","kid":<thumbprint>}`), claims exactly `iss aud sub iat exp nonce jti` (`aud` = `email:<scope_id>`,
  `exp` = `iat` + 600, `jti` 16 random bytes). The issuer computes every nonce itself (`docs/contract-interface.md`
  byte layouts, checked against `email_fixture.json`). Each signature is verified against the published key before the
  answer; each token is a row in `email_issuance` before it is signed.

### `POST /v1/email/start` · E

`{pk, email, purpose, commitment, deviceTicket?, unlockToken?}` → `202 {challengeId, expiresAtMs, resendAfterMs}`
(absolute ms).

`purpose`: `session` (commitment = the session nonce fields `{scopeId, sessionPublicKey: [32 bytes], expiresAtMs (next
24 h), keyIndex (0..2^31−1), maxUses (1..500), salt: [16..64 bytes]}`), `link_new` `{scopeId, rootIk, epoch, salt}`,
`link_account` `{scopeId, rootIk, newIk, epoch, salt}`, `link_change` `{scopeId, action: "cancel"|"unlink", rootIk,
memberIk, epoch, salt}` (iks 64 lowercase hex). `auto_link` is refused here (google-match prepares it, D195). The
address is normalized by `@hana-id/email` (`400 invalid_email`); a disposable domain or its subdomain is `400
email_domain_not_allowed`.

The requester pays first (D198): the IP subject's limits, then the owner proof (`deviceTicket`, `unlockToken`) is
checked, then (unless it was valid) the prefixes' limits (IPv4 /24, IPv6 /56 and /48, 1000 a day each), then the app
gate and the body, then in one atomic call the mailbox's (the address without its `+tag`):
the requester's lock, at most 5 live challenges, 35 challenges a day (dev envs: 20 and 250, D340), and the code limits per (mailbox, requester) and
per mailbox; then the recipient domain's day, then the app's quota, then the global budget and the app's share of it.
A later refusal refunds the mailbox, domain and app counts (never the IP ones) and stores nothing. Every mailbox-level
refusal (the mailbox's limits and locks, the domain cap) is the same `429 rate_limited` body with `retry-after: 900`.

**A valid device ticket or unlock grant never waits on the IP prefix limits, an app's quota, a recipient domain's cap or the general budget pool**; its mail comes from the owner pool (30% of the budget, beside it), which fresh tickets fill only to half and 20% per app, and falls back to the app's general share (D198). `deviceTicket` (from an
earlier `verify` of this exact address, 30 days, not revoked): the start uses that ticket's own allowance, 3 code mails
a day, outside the code limits, the live cap and the challenge cap, and its checks may use the ticket slot.
`unlockToken` (mailed to the address by a staff `admin/unlock`): the mailbox's one-time grant, used by this start only;
its challenge's mails are free and its checks use the ticket slot then the grant slot; given back if the start is
refused later or its mail fails. Either skips the prefix limits, the app's quota, the recipient domain's cap and the
general budget pool (it draws on the owner pool). An invalid one is ignored, never an error.

A suppressed address (its exact address, `+tag` included: a complaint, or a bounce of the last 30 days) takes the same
path, counted and never refunded, and gets the same answer; only the mail is skipped, and its challenge holds no address
and no code. The code mail goes to the normalized address (its `+tag` kept), after the response, with the purpose's own
subject and wording (`src/mail.ts`, D199).

### `POST /v1/email/home/start` · E (H10, D463, D616–D621)

Hana Home's code, from `AUTH_ORIGIN` only: `{email, kind, commitment, identity?}` and no other field (no `pk`, no
nonce) → `202 {challengeId, expiresAtMs, resendAfterMs}`, then the shared `resend` and `verify`. `identity` is required for
`derive` and refused for `identity` (`400 bad_request`): the caller's Hana Home identity token, minted by this issuer for
this address (signature, `iss`, audience `hana-home`, unexpired with 60 s of skew, issuance purpose `home`, `sub` the
address's own), else `401 home_identity_invalid` and nothing mailed (D629).

- `kind: 'identity'`: the Home sign-in. `commitment = {homePublicKey: [32 bytes], expiresAtMs, salt: [32 bytes]}`, the
  end after now and at most 20 minutes away; the token's nonce is `homeNonce` (`@hana-id/core/home`) of these, computed
  here.
- `kind: 'derive'`: opening one app's wallet. `commitment = {scopeId, sessionPublicKey: [32 bytes], expiresAtMs, keyIndex:
  0, maxUses: 1, salt: [16..64 bytes]}`, the end at most 20 minutes away (the API's Home session rule); the nonce is the
  session nonce of these.

The nonce is never taken from the request (H1's review condition): a `hana-home` token's nonce is always a Home or a
session nonce, never a client proof's, so no owner can register `("email", "hana-home")` with one (the contract refuses
that client by its shape too). The gate is the chain alone, no app and no `IssuerRpc` read (D434): `identity` needs
`("email", "hana-home")` in force on the exit list (`409 home_email_unavailable` otherwise); `derive` needs the scope
registered (`409 not_covered` otherwise) and gets the audience `email:{scope}` while the scope holds its email client,
else `hana-home` while the email exit is in force (D485, D490), else `409 not_covered`; any registered scope, one that
never had email included (D544's `home_no_wallet` at the derive is what stops an empty one, D667). A suspended, deleted
or purged app's scope works. The audience is read again at `resend` (nothing mailed once it fails) and at `verify`
**before** the code is compared, so a refusal or a chain outage never spends the code (D668). Limits, in `start`'s
order: the IP's start windows and Home's own (3 per 10 min, 10 a day; dev 10 and 60), the aggregate prefixes and Home's
own (50 a day each), the mailbox (the same windows as every login: a Home code counts in them), the recipient domain,
then the general pool within Hana Home's share: 6% of the budget for anyone, then 4% only for a returning mailbox (a code
verified within 30 days; the mailbox object keeps that time only), D628; half of either raises `email_budget` `app_50`.
No owner path (no device ticket is taken or issued) and no partner quota. Enumeration-safe as `start`. The mail names Hana Home and the
action, never an app ("Your sign-in code for Hana Home", "Your code to open a wallet in Hana Home", D620). `verify` of a
Home challenge answers `200 {idToken}` only: no device ticket, no `sealedEmail`, no case B, and no user-directory row
(D621); the token's `sub` is the address's own (`HMAC(K_sub, address)`, as at any login). The issuance row's `app_id` and
the daily counts' app are `hana-home`.

### `POST /v1/email/resend` · E

`{challengeId}` → `202 {challengeId, expiresAtMs, resendAfterMs}`: a new code, the old one dead. `410
challenge_expired` (expired, used, out of attempts or unknown), `429 rate_limited {resendAfterMs}` (< 30 s after the
last code), `429 resend_limit` (2 resends done), `429 rate_limited` (`retry-after: 900`: the mailbox's code limits for
this requester, its lock, or for a ticketed challenge the ticket allowance; the send is reserved before the code
changes). For a challenge google-match prepared (case A, D195), the first call sends its first code (not counted as a
resend). The challenge still ends 10 min after it was created (D197).

The challenge id is 32 bytes (base64url): a public half that names the challenge's object and a secret half that
decrypts its address (D197); only the client holds both.

### `POST /v1/email/verify` · E

`{challengeId, code}` (6 digits) → `200 {idToken, googleWallet: false, deviceTicket, sealedEmail?}`, or in case B `200 {googleWallet:
true, linkTicket?, sub?, deviceTicket}` with no token (`sub`, this address's `e1.` pseudonym, only with `linkTicket`: the vault signs a case-B link only for a link token of that `sub`, D139, D256). Each check is reserved in the mailbox's limiter before the code is
compared (one atomic call, refunded when the code is right), and the challenge counts its attempts atomically, so
parallel guesses can't outrun either (D198). Errors: `400 code_invalid {attemptsLeft}` (5 wrong codes kill the
challenge; 10 wrong from one requester lock it out of that mailbox for an hour; past 18 failed checks a day per mailbox
only the owner slot (4) and the ticket slot (3) are open, and past 25 nothing until the UTC day ends), `410
challenge_expired`, `429 rate_limited` (IP, or a lock), `403 email_not_enabled` (the app was suspended or turned email
off meanwhile: nothing is minted). A correct code is single use: the challenge is deleted before the token is minted.
Every `200` (each purpose, case B included: the code proved the address) also records the email identity in the user
directory (`user_emails`, `user_email_apps`: its `e1.` sub, the normalized address, the app and scope; D269), after the
answer and never changing it; errors and `409`s record nothing.

- `deviceTicket`: `dt2.` + 75 characters, an owner device ticket for this exact address (30 days, its own nonce;
  registered in the mailbox object, at most 5 live per address, a newer one revoking the oldest); batch 8's popup keeps it on `authOrigin` and sends it with the next `start`. A verified challenge also
  gives its recipient-domain places back and raises that domain's cap (D198).
- `session`: case B is when a Google identity that reported this address as verified (`email_hints`; for a
  non-Google-hosted address only if it did so within 180 days, D199) has the wallet in this scope and the email identity has none. The email login then gets no `idToken`, so
  it can't open a second wallet; the popup continues with Google. `linkTicket` (32 random bytes, single use, 10 min,
  bound to the app, this address's `sub` and the hinted Google identities) only when the contract would accept the join.
- `sealedEmail` (D438): only on a `session` purpose's `idToken` answer, with `IDENTITY_SEAL_KEY` set: the normalized
  login address sealed for the app and the session key and expiry of the challenge's commitment (`start` keeps them in
  the challenge record as `seal`; a challenge made before the deploy has none and gets no blob). The popup relays it
  beside the email token; only the API opens it. Never on case B, the link purposes or `auto_link`.
- `link_new`, `link_account`, `link_change`: `googleWallet: false`. `409 links_unavailable` while
  `get_config().unrecorded_wallets` (D135).
- `auto_link` (a challenge google-match prepared): the join is read from the chain now; `200 {idToken, googleWallet:
  false, decision: "case_a", linkImmediate: true, deviceTicket}`, or `409 link_refused {decision}` when the case moved
  on. A link notice goes to the address.

### `POST /v1/email/google-match` · E

`{pk, accessToken, googleIdToken, commitment, link, linkTicket?}` (commitment = the session nonce fields) → `200
{decision, googleHosted, linkable, emailToken?, linkImmediate?, challenge?, sealedEmail?}`. `sealedEmail` (D438): with
`IDENTITY_SEAL_KEY` set and a Google-verified address that normalizes, whatever the decision: userinfo's address,
lowercased, sealed (`@hana-id/email` sealed.ts, src `google`) for the app and the commitment's session key and expiry; a
sealing failure is logged `seal_failed` and only drops the field.

1. The app gate; the Google ID token is RS256 against Google's JWKS, `iss` Google's, `aud` one of the app's Google
   clients (its scope's own, only its web client when it set one; shared clients in an `allow_shared` scope), unexpired
   (`400 google_token_invalid`), and its nonce is the commitment's session nonce (`400 nonce_mismatch`).
2. `tokeninfo` (POST): the access token's `aud` (and `azp`) is the ID token's, its `sub` the ID token's; `userinfo`:
   `email`, `email_verified`, `hd` (`400 google_token_invalid`). An access token of another Google account (tokeninfo's
   or userinfo's `sub` isn't the ID token's: the user picked another account on Google's permission screen) is `400
   google_account_mismatch` (D264). The access token is never revoked (D265: revocation ends the user's whole grant to
   the client) or stored; it expires within the hour. Tokens never appear in a URL or a log. Per IP: 120 per 10 min
   (`429 rate_limited` with `retry-after`; the vault retries a 429 or 503 within the login, D267).
3. `email_verified` not true (or an address that doesn't normalize): `{decision: "none", googleHosted: false,
   linkable: false}`, no hint. Otherwise the address's `sub` (the Gmail `+tag` kept, dots dropped, D159) and the
   Google-hosted rule (`@hana-id/email` `isGoogleHosted`, D158); the hint `(scope, sub, Google sub)` is upserted for every
   verified address (D119; a non-Google-hosted case B then links only after 24 h, D199's residual risk).
4. The case, from `get_identity` and `get_account` of both identities, as the contract judges it (D199): `none` (case
   C), `linked`, `pending`, `both_wallets`, `unlinked`, `case_a`, `case_b`; `linkable` false when the contract would
   refuse the join or `unrecorded_wallets` is set.
5. `emailToken` (an `auto_link` token for the email identity, nonce over this session, the Google identity and the
   join) only when `link` is true and: Google-hosted `case_a` (`linkImmediate: true`), or `case_b` with a `linkTicket`
   bound to this address's `sub` and to this Google identity (`linkImmediate` = Google-hosted). Any presented ticket
   is spent. A link notice goes to the address. `case_a` not Google-hosted (linkable): `challenge: {challengeId,
   expiresAtMs, to: "a…@domain"}`, a prepared `auto_link` challenge whose first code `resend` sends (D195); none for a
   suppressed mailbox or one the mailbox limits refuse.

6. Once steps 1–2 pass, whatever the decision, the Google identity goes to the user directory (D269, `src/directory.ts`
   `recordUserEmailLater`, after the answer, best effort): `user_emails` (`google`, the Google `sub`, userinfo's
   address lowercased, `email_verified`, `hosted`: Google-hosted by D158, false when unverified) and `user_email_apps`
   (this app and scope). A failed write logs `directory_write_failed` (app and scope only) and never changes the answer.

### `POST /v1/email/google-record` · E

`{pk, accessToken, googleIdToken, commitment}` → `200 {accepted: true, sealedEmail?}` (D270; `sealedEmail` as
google-match's, D438). Under `GOOGLE_EMAIL_FLOW =
'token_first'` (`packages/web/src/auth/google.ts`; in force since 2026-11-04) a Google login of an app without email login
asks Google for the email too, and the vault sends the access token here, in the background, only for the user
directory (D269).

- Its own app gate: `pk` → an app as above (`401 invalid_key`, `403 app_suspended`), **email login need not be on** and
  the scope needs no email client.
- google-match's steps 1 and 2 exactly (the same code, `checkGoogleSignIn`): the ID token, its nonce over the
  commitment, the commitment's scope, `tokeninfo`, `userinfo`, `google_account_mismatch`, the access token never
  revoked or stored. Per IP: 120 per 10 min in a window of its own (`ip:record:10m`; a login calls google-match or
  google-record, never both), `429` with `retry-after`.
- The answer carries no match data (no decision, no hosted flag, no hint, no token, no challenge); nothing is matched,
  minted, mailed or hinted. After it, google-match's step 6 (the directory row), best effort.
- The vault calls it once per login, gives up after 30 s and never retries; any failure is dropped and never reaches
  the login (`packages/web/src/vault/login.ts` `recordGoogle`).

### `DirectoryRpc` (entrypoint, no route; batch C8b) · E

A named `WorkerEntrypoint` export (`src/directory-rpc.ts`, D275 as confirmed 2026-11-05, D388–D392), bound only by the
admin Worker as `ISSUER`; the public `fetch` doesn't reach it. Every call carries `{requestId, accessJwt}` (the staff
request's `Cf-Access-Jwt-Assertion`), which the issuer verifies itself with `@hana-id/oidc` against the admin
application (`ADMIN_ACCESS_TEAM_DOMAIN`, `ADMIN_ACCESS_AUD`, type `app`, a `sub`, an email) and `ADMIN_STAFF_EMAILS`;
that email is the actor. Answers `{ok: true, …}` or `{ok: false, code, error?, budget?}`: `bad_request`, `not_found`,
`rate_limited` (`budget: {window: '1h'|'1d', limit, retryAfterMs}`), `internal`, `unauthenticated`, `not_staff`,
`access_unavailable` (missing or unusable config, unreachable certs). Nothing is read or audited before the check.

| Method | Input → answer |
|---|---|
| `search` | `{q?, provider?, appId?, sub?, unverifiedOnly?, cursor?, limit? ≤ 100 (50), ticket?}` → `{users: [{provider, sub, email, emailVerified, hosted, unverifiedClaim, firstSeenMs, lastSeenMs, appCount}], next?}`. `q`: a full address matches exactly (as typed lowercased and normalized), else a substring of ≥ 3 characters; newest first by last seen, an address search with Google's unverified claims after the verified rows; `next` with a full page (`<claim>:<lastSeenMs>:<provider>:<sub>`) |
| `get` | `{provider, sub, ticket, purpose?}` (the ticket required; `purpose` `user_view`, the default, or `support_lookup`, D399) → `{user, apps: [{appId, scopeId, firstSeenMs, lastSeenMs}] (≤ 200, newest first), appsTruncated?}`; `not_found` without a row (audited, costs no row) |
| `auditSince` | `{id}` (after it, oldest first) or `{before}` (newest first), `staff?`, `action?`, `limit ≤ 200` → `{rows: [{id, atMs, staff, action, ticket, scopeId, actionNonce, jti, subject, detail}]}`; no row budget, no audit row |
| `health` (D425) | `{}` (beyond `requestId`, `accessJwt`) → `{build, db: {ok, latencyMs}}`: the deployed `HANA_BUILD` (null unstamped) and a timed `SELECT 1`, for the admin's System status page; the staff check first, then no directory read, no row budget, no audit row |

`search` and `get` take their rows first from the staff member's budget (`staff-dir:<email>`: 500 identities an hour,
2 000 a UTC day, provisional; a page past what is left is cut to it, rows not returned are given back) and write one
`email_admin_audit` row **in the same D1 batch** as the read (a failed insert returns no rows): `user_search` with the
ticket if given and `detail` `{filters, q: {match, hash}, page, rows, budgetCut?}` (`hash`: 12 characters of HMAC(K_rl),
the mailbox subject form for a full address), or `user_view` with the ticket and `{provider, sub, found}`, or for the
Support ID lookup's email join `support_lookup` with the ticket and `{provider, sub, lookup, found}` (`lookup` the admin
request's id: the console's `support.lookup` row of the same request, D399). Never an
address in a row or a log line (`directory_read`, `directory_refused`, `directory_budget`, `directory_read_failed`
carry codes and counts).

### Staff routes (`/v1/email/admin/*`) · E

Common to all of them (D199): a valid Cloudflare Access JWT (`Cf-Access-Jwt-Assertion`: RS256 against the team's certs,
`iss`, `aud` the application's AUD tag, unexpired, non-empty `sub`; a failed certs fetch or an unknown kid is cached for
30 s) whose email is on `emailIssuer.access.staffEmails` (`403 forbidden`); `404` when the env configures no Access.
`Content-Type: application/json` (else 415) and **no `Origin` header** (`403 origin_not_allowed`: a browser can't
reach them). Every body carries `ticket`, the support reference (1–64 of `A–Z a–z 0–9 . _ # : -`), kept in the audit
row. One shared bucket of 20 staff actions an hour per staff member, all routes together. The audit row in
`email_admin_audit` is written **before** the action; an action that then fails leaves its row. No CORS.

- **`POST /v1/email/admin/client-proof`** `{scopeId, actionNonce, ticket}` → `200 {token, client: ["email",
  "email:<scopeId>"]}`: a token with `sub` `hana-client-proof` and nonce `client_proof_nonce(signer, scopeId,
  actionNonce)`, for `propose_change(AddClient)`. The scope is read from `get_scope` now (no cache): `404
  unknown_scope`, `409 stale_action_nonce {actionNonce}` when `actionNonce` isn't its current `action_nonce`, `403
  email_not_enabled` when no active app of the scope has email on. Audit: staff, ticket, scope, nonce, jti.
- **`POST /v1/email/admin/unlock`** `{email, ticket}` → `200 {mailed}` (or `{mailed: false, reason: "suppressed"}`):
  stores a one-time grant for the mailbox and **mails its token to the address** (`{authOrigin}/email/unlock#ug1.…`,
  24 h; only its sha256 is kept), never to staff. The one `start` presenting it counts as an owner's (D198). Clears
  nothing: the shared guess counters, the trip and every lock stay. Never logged. `429 staff_cap` past 1 a day
  or 3 in 30 days per mailbox. Audit: `action: "unlock"`, staff, ticket, `subject` = 12 characters of the mailbox key
  (never the address); log `mailbox_unlocked` (warn).
- **`POST /v1/email/admin/unsuppress`** `{email, ticket}` → `200 {mailed}` (or `{mailed: false, reason:
  "not_suppressed"}`): mails the address a one-time confirmation (`{authOrigin}/email/confirm#uc1.…`, 24 h); the
  suppression row goes only when its holder confirms (`POST /v1/email/confirm`). Capped like unlock (its own count),
  audited (`action: "unsuppress"`). SendGrid's own suppression list is cleaned by hand first (`docs/operations.md`).
- **`POST /v1/email/admin/revoke-tickets`** `{email, ticket}` → `200 {revoked: true}`: every device ticket of that
  exact address issued until now stops counting. Capped like unlock, audited (`action: "revoke_tickets"`); log
  `device_tickets_revoked` (warn).

### `POST /v1/email/confirm` · E

`{token}` (`uc1.` + 43 characters, from a mailed confirmation; `authOrigin` only, IP-limited like `resend`) → `200
{confirmed: "unsuppress"}`: the confirmation's action is done (the exact address's suppression removed; log
`suppression_removed`). `410 confirm_expired` when unknown, used or older than 24 h.

### `GET /v1/email/jwks.json`, `GET /v1/email/.well-known/openid-configuration` · E

The JWKS: every key of `emailIssuer.publicKeys` (`kty, n, e, kid, use: "sig", alg: "RS256"`; kid = RFC 7638
thumbprint, the watchdog's pin, D190). Discovery: `issuer`, `jwks_uri`, `id_token_signing_alg_values_supported:
["RS256"]`, `response_types_supported`, `subject_types_supported`, `claims_supported`. CORS `*`. Informational: the
contract never fetches them and the watchdog pins instead of trusting them.

### `GET /v1/email/health` · E

D384. No auth, no limits, CORS `*`, `GET` only (`405` otherwise). → `200 {"ok": true, "env": ENV_NAME, "build":
"<id>" | null}`: the build id the issuer was deployed with (the var `HANA_BUILD`, set only by `pnpm --filter
@hana-id/email-issuer run deploy`, the shared wrapper `packages/env/src/stamped-deploy.ts`, D406), as in the API's `GET /v1/health`.

### `POST /v1/email/webhooks/sendgrid` · E

SendGrid's signed Event Webhook (D199): 120 per 10 min per IP; the headers are checked before the body is read
(`x-twilio-email-event-webhook-timestamp` within 10 min, `x-twilio-email-event-webhook-signature` base64 DER ECDSA
P-256 of a plausible size; `401 bad_signature`), then the signature over timestamp ‖ body, verified with
`SENDGRID_WEBHOOK_PUBLIC_KEY` (imported once per isolate). Body ≤ 1 MB, ≤ 1000 events. Only events whose `category`
is one of the issuer's (`hana-id-code`, `hana-id-link_notice`) count: `bounce` (not `blocked`) and `spamreport` become
`email_suppressions` rows keyed by the exact normalized address (a bounce on `x+tag@` suppresses only that address); a
bounce lapses after 30 days, a complaint stays until `admin/unsuppress`. The suppressions, the `email_daily` counts per
(app, metric) and the events' dedupe keys (`email_webhook_events`, migration 0005: the SHA-256 of `sg_event_id`, or of the
event's fields without one) are one D1 batch, so a delivery applies whole or not at all and a redelivered event adds
nothing (D446 as amended). A D1 failure answers `500` with nothing written and SendGrid retries for up to 24 h. `200 {stored}`. More than 5 complaints in 24 h
logs `email_complaint_rate` (error). `404` when no key is configured.

### Limits (D198; provisional, D123 Q22; the review defaults to confirm)

The numbers are production's. **Dev envs** (`local*`, `sandbox*`: `isDevEnv` on `ENV_NAME`, D340) raise the rows
marked "dev:"; every other row is the same in every env. The issuer picks the set once per request (`limitsFor`) and
sends the mailbox object its set with each call; counters are keyed by window name and start, never by max, so a
mailbox over production's numbers but under the dev ones passes at once on a dev env. A wrong-code lock is keyed by the
max that set it, so production's lock doesn't hold under the dev set. A ticketed start's own code allowance (a device that
signed in before: production 3 a day per address, 9 per mailbox) is 100 and 300 on a dev env; once it is used up the
start counts as a plain one and meets the code limits like any requester (D345).

All exact, on the issuer's `RateLimiter` objects (named `<env>:<subject>`). A mailbox is the normalized address
without its `+tag` (`normalizeEmail().mailbox`), keyed by HMAC under K_rl; a requester inside it is a hash of the IP
subject. Every mailbox decision is one atomic call (D198). Every mailbox-level refusal answers `retry-after: 900`.

| Subject | Limit | Refusal |
|---|---|---|
| Mailbox × requester: code mails | 3 per 15 min, 10 per day (resends included); dev: 20 per 15 min, 100 per day | 429 |
| Mailbox: code mails | 10 per 15 min, 30 per day (dev: 30 per 15 min, 200 per day); then 5 a day for requesters new to it that day | 429 |
| Device ticket | 3 code mails a UTC day **per exact address** (all its tickets together) for the challenges they started, outside the two rows above, the live cap and the challenge cap; ≤ 5 live tickets per address (a 6th revokes the oldest); ≤ 10 ticket challenges per exact address a day; per mailbox (all its `+tag`s) ≤ 9 ticket mails and ≤ 30 owner challenges (grants included) a day, which never block the untagged address or a grant (they count toward them); past these the proof counts as nothing | 429 |
| Unlock grant | one start within 24 h of the unlock; its challenge's mails free (≤ 2 resends); its checks in the ticket slot then a grant slot of 2 outside the ceiling | – |
| Mailbox: live challenges | 5 at once; dev: 20 | 429 |
| Mailbox × requester: wrong codes | 10 per hour → that requester locked out of the mailbox for 1 h; dev: 30 per hour | 429 (start, resend, verify) |
| Mailbox: failed code checks | hard ceiling 25 per UTC day, from everyone: any requester for the first 18 (the backstop), then an owner slot of 4 (requesters that started a challenge before the trip and have no failure, one each) and a ticket slot of 3 (ticketed challenges); dev: ceiling 100 = backstop 80 + owner slot 17 + ticket slot 3 | 429 until the UTC day ends; `mailbox_guess_limit` logged |
| Mailbox: challenges created | 35 per UTC day, every kind; dev: 250 | 429 |
| Mailbox: staff unlocks, unsuppressions, ticket revocations | 1 a day and 3 in 30 days each | `429 staff_cap` |
| Challenge | 10 min from creation; 5 wrong codes; ≤ 2 resends ≥ 30 s apart | 410 / 429 |
| IP (IPv4 address, IPv6 /64): `start` | 10 per 10 min, 50 per day; dev: 30 per 10 min, 300 per day | 429 |
| IP prefix (IPv4 /24, IPv6 /56, IPv6 /48): `start` | 1000 per day each; skipped with a valid ticket or grant | 429 |
| IP: `verify` / `resend` (and `confirm`) / `google-match` (its prepared challenges too) / `google-record` / webhook | 30 / 10 / 120 / 120 / 120 per 10 min; dev: `verify` 90, `resend` 30 (`confirm` stays 10) | 429 |
| No usable `cf-connecting-ip` (IP-limited routes) | refused | `400 missing_client_ip`, logged |
| Recipient domain (registrable, Public Suffix List): code mails | 100 + 2 × its distinct verified mailboxes a day over the trailing 7 days (only challenges that took a domain place), at most 2,000, per day; a verified challenge's places given back; except the listed consumer providers (`src/domain.ts`); each requester prefix (IPv4 /24, IPv6 /56, /48) ≤ 20% of the day's cap; ticketed and unlock-grant challenges not counted | 429; `email_domain_cap` logged when a day fills |
| App: `start` | plan `per_minute` per minute; plan `per_day` per day; owner starts not counted | 429 |
| Env: user mail | `emailIssuer.dailySendBudget` per day (required outside `local*`; 1000 in `local*`): a staff pool (1%, at least 5: unlock and unsuppress mails) and the general pool (the rest), in which an app's share is 2% of its plan's `per_day` (at least 10, at most the pool; 10% of the budget without a plan value) and the last 20% only for apps under half their share; beside them the owner pool, 30% of the budget (all mail ≤ 1.3 × the budget), for a ticket's or grant's mail: a fresh ticket (< 7 days) only below half of it and within 20% of it per app; aged tickets and grants without a per-app cap; owner mail it refuses falls back to the app's general share | `start`, `resend` 429; logs `email_budget` (50%, 80% of the general pool and of each app's share), `email_owner_pool` (50%, 80% of the owner pool), `send_budget_exhausted` (error; `code` `global`, `app`, `reserve`, `owner`, `staff` or `unconfigured`) |
| Staff | 20 actions per hour per staff member, all staff routes together | 429 |

The guess bound: ≤ 25 failed checks a day per mailbox plus ≤ 2 per unlock (≤ 3 unlocks in 30 days): 365 × 25 + 37 × 2 =
≈ 9,199 a year (≈ 9,273 in the worst case), ≈ 0.92% a year against a 6-digit code (D198). On a dev env (ceiling 100,
D340): 365 × 100 + 37 × 2 ≈ 36,574 a year, ≈ 3.7% (testnet: no real funds).

### `ConsoleIssuerRpc` (entrypoint, no route; the console Worker only; batch 9, D447)

`clientProof({requestId, actorId, orgId, scopeId, actionNonce})` → `{ok, token, client}` or `{ok: false, code: 'email_not_enabled' | 'stale_action_nonce' | 'unknown_scope' | 'rate_limited' | 'unavailable' | 'bad_request'}`: the staff route's checks, audited as `partner-console` (20 per scope and UTC day). `deliverability({requestId, appId, days})` → `{ok, days: [{day, sent, bounced, complained, refused}]}` for that one app.
`DirectoryRpc.issuerStats({requestId, accessJwt, days})`: the staff check, then issuance per day, app and purpose and the `email_daily` counters (counts only: no audit row, no row budget).

### Durable Objects, D1 and bindings

| Object | Holds |
|---|---|
| `Challenge` (binding `EMAIL_CHALLENGE`), one per `c:` + b64url(sha256(public half of the challengeId)) | `{appId, appName, scopeId, purpose, nonce \| autoLink: {googleSub, sessionHash}, silent, emailEnc (AES-256-GCM under a key from the id's secret half; '' when silent), mailboxKey, domainKey, owner (the ticket's id or the grant used, or null), budgetShare, domainRes (the domain places its mails took), codeMac = HMAC(K_code, challengeId ‖ code), attempts, createdAtMs, expiresAtMs, lastSentAtMs, resends}`; deleted at the correct code or by an alarm at expiry. Link tickets: one object per `t:` + b64url(sha256(ticket)), `{appId, scopeId, sub, googleSubs, expiresAtMs}`, deleted at first use. Unsuppress confirmations: one per `u:` + b64url(sha256(token)), `{action, emailKey, expiresAtMs}`, deleted at first use |
| `RateLimiter`, one per subject (`mbx:<mailbox key>`, `dom:<domain key>`, `ip:<subject or prefix>`, `app:<id>`, `global`, `staff:<sha256 hex>`, `staff-dir:<staff email>`: DirectoryRpc's row budget, C8b) | fixed-window counts; in a mailbox's object also the live challenges' expiry times, the requesters' locks, the unlock grant (sha256 of its token, 24 h), per-ticket send counts, ticket revocations (per address key, 30 days) and 30 days of staff actions; in a domain's, the per-prefix shares (hashed prefixes) and 8 days of verified-login counts; in `global`, the owner pool and per-app use; in `global` the per-app budget use; an alarm drops what ended |
| `Outbox` (binding `OUTBOX`, `local*` envs only) | the outbox stub's last 200 messages, read by tests through the binding; no route |

Issuer D1 (`apps/email-issuer/migrations/0001_init.sql`, `0002_user_emails.sql`, `0003_directory_audit.sql`): `email_issuance(jti, app_id, purpose, kid, iat)` (24 months,
D90; the pruning job is a batch C13 follow-up), `email_hints(scope_id, email_sub, google_sub, hosted, updated_at_ms)`
(a hosted one kept while the scope exists, D122; a non-hosted one honoured and kept 180 days after its last login,
D199), `email_suppressions(email_key = HMAC(K_sup, exact normalized address), reason
bounce|complaint, at_ms)` (K_sup derived from K_sub), `email_admin_audit(id, at_ms, staff, action
client_proof|unlock|unsuppress|revoke_tickets|user_search|user_view|support_lookup, ticket (1–64; null only on a
user_search), scope_id?, action_nonce?, jti?, subject?, detail? JSON)` (rebuilt by 0003 with every row kept; indexes
`(staff, id)`, `at_ms`); the user directory
(0002, D269): `user_emails(provider email|google, sub, email, email_verified, hosted?, first_seen_ms, last_seen_ms)`,
key (provider, sub), indexes on `email` and `last_seen_ms`, and `user_email_apps(provider, sub, app_id, scope_id,
first_seen_ms, last_seen_ms)`, key (provider, sub, app_id), index (app_id, last_seen_ms); written by `src/directory.ts`
after the answer (`waitUntil`): email rows by `verify`, Google rows by google-match and google-record (D270); upserts
in which the write with the newest `last_seen_ms` sets `email`, `email_verified`, `hosted` (and an app row's
`scope_id`), `first_seen_ms` is the MIN and `last_seen_ms` the MAX, so a late write never restores older values; read
by Hana staff with `admin user:list` / `user:find` and, through `DirectoryRpc` below, the admin console's Users screen
(no route serves it). The
verified address is stored readably there and only there: no log line, other table or Durable Object holds it
(a live challenge's copy is encrypted, D197). SendGrid also keeps addresses: its suppression lists keep an address until it
is removed there, whatever the activity retention below. The issuer has no binding to the API's D1 (D434): its one
service binding, `API`, is the API Worker's `IssuerRpc` entrypoint.

Vars (from `emailIssuer`, `scripts/gen-wrangler.ts`): `ENV_NAME`, `NEAR_RPC`, `NEAR_RPC_FALLBACK`, `SIGNER_ACCOUNT`,
`EMAIL_ISS`, `EMAIL_PUBLIC_KEYS`, `EMAIL_ACTIVE_KID`, `EMAIL_SIGNER_KIND`, `EMAIL_SENDER`, `MAIL_FROM`, `AUTH_ORIGIN`,
`VAULT_ORIGIN`, `DAILY_SEND_BUDGET`, `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ACCESS_STAFF_EMAILS`,
`SENDGRID_WEBHOOK_PUBLIC_KEY`; with a dashboard (`admin` block, C8b) `ADMIN_ACCESS_TEAM_DOMAIN`, `ADMIN_ACCESS_AUD`,
`ADMIN_STAFF_EMAILS` (the admin console's Access application, for DirectoryRpc's own check). Secrets: `ISSUER_SIGNING_KEY`, `EMAIL_SUB_KEY`, `EMAIL_CODE_KEY`, `EMAIL_RL_KEY`,
`SENDGRID_API_KEY`, and `IDENTITY_SEAL_KEY` (optional, D438: the API's value; without it no answer carries `sealedEmail`)
(`docs/security.md` "Key and secret inventory"). Placement `aws:ap-east-1`; no invocation logs.

SendGrid keeps each message's recipient and events in its Email Activity (3 days on the plans without the paid Email
Activity History add-on, per SendGrid's docs when written; check at setup); Hana can't shorten that, and doesn't buy
the add-on.

### Logs

`{"level", "ts", "service": "email-issuer", "event", …}` with typed fields only (`src/log.ts`): `requestId`,
`endpoint`, `outcome` (`ok`, `rejected`, `error`, `suppressed`), `status`, `code`, `appId`, `scopeId`, `purpose`,
`jti`, `kid`, `decision`, `limit` (its name, never its key), `subject` (12 characters of a mailbox key, an HMAC),
`providerStatus`, `latencyMs`, `count`. Events: `request`, `token_minted` (jti, purpose, app, scope, kid), `code_mail`
(`ok`; `suppressed`; `error` with the provider's reason and status), `link_notice`, `limit` (`mailbox:locked` /
`mailbox:live` / `mailbox:codes` / `domain`, or the window's name), `email_budget` (warn: `code` `global_50`,
`global_80`, `app_50`, `app_80`), `send_budget_exhausted` (error: `code` `global`, `app` or `reserve`),
`email_owner_pool` (warn: `code` `owner_50` / `owner_80`), `email_complaint_rate` (error: `count` complaints in 24 h), `email_domain_cap` (warn: `subject` = 12 characters of
the domain key, the mail that filled the domain's day), `staff_mail` (`code` `unlock` / `confirm`, or the provider's
reason), `device_tickets_revoked` (warn, staff), `missing_client_ip` (warn), `mailbox_unlocked` (warn,
staff), `suppression_removed` (warn, staff), `mailbox_guess_limit` (error: `code` `backstop` or `ceiling`, `subject` =
12 characters of the mailbox key; staff see targeted mailboxes), `google_revoke` (warn), `directory_write_failed`
(warn: `appId`, `scopeId`; a user directory write failed, the login went on, D269). Never an address, a code, a
`sub`, a token, a device or link ticket, an unlock or confirmation token, an access token, a key or a body: `test/privacy.test.ts` greps every line of
every flow for them.
