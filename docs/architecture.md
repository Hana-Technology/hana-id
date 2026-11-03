# Architecture: how Hana ID works today

Current-state map of the whole system: components, flows, key derivation, data stores, environments and the relayer.
Last verified against code: 2026-11-03 (branch `feat/email-login-8b`: automatic linking and the path through
`get_identity` in Status, the login flows ("Email login in the popup", "Automatic linking"), key export and key
derivation, D254–D259); 2026-11-03 (branch `fix/demo-polish`: the vault's `connected` event and the SDK's one
frame retry in Components, D262; `GET /v1/app` asked once more by the login, read side by side by the API, D261; the
email login's own timing stages, D260); 2026-11-02 (branch `feat/email-login-8a`: email login in the popup and the vault in
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
deployed env; how each part was deployed is in `docs/operations.md`. In short: batch B and governance (contract v2,
owned by the council DAO since 2026-10-30) run there, the watchdog runs there with batch 5, and the identity token
runs there. Contract v3 and batch C (C1–C3) are merged but **not deployed**; the email issuer isn't merged.

| Part | Where | State |
|---|---|---|
| `contracts/hana-signer` (batch A, A.2) | `develop` | Deployed on sandbox-dev (`envs/sandbox-dev.json` `signer`); runs as contract v2 since the governance migration (below) |
| `create_session_and_derive`, `key_index < 2^31` (batch B) | `develop` (merged 2026-10-29) | Deployed on sandbox-dev (contract upgraded 2026-10-29); ship gate passed (D76); gas measured in the sandbox with the mock MPC (`docs/contract-interface.md` "Gas of the email login calls"), not yet on testnet |
| `apps/api` batch A/A.2 endpoints, relayer, limits, cron | `develop` | Deployed on sandbox-dev (`apiUrl`) |
| `apps/api` `/v1/login` (incl. the export limit), login relay, origin rules, vault page, vault endpoints, migration 0003, vault cron, API-side policy validation (batch B) | `develop` | Deployed on sandbox-dev 2026-10-29 (migrations 0003 and 0004 applied, `VAULT_KEK` set) |
| Page Workers serving `vaultOrigin`/`authOrigin` (`apps/api/src/pages/`, `scripts/pages-wrangler.ts`) | `develop` | Deployed on sandbox-dev 2026-10-29 (both origins in `envs/sandbox-dev.json`) |
| `@hana-id/core` (layouts, CKD, derivation v1, signers, decoders, policies, verified contracts) | `develop` | In the deployed API and page Workers |
| `packages/env` `vaultOrigin`/`authOrigin`, `rpcFallback` | `develop` | In use (sandbox-dev's manifest sets all three) |
| `@hana-id/web`: vault, auth pages `/login`, `/login/callback`, `/approve`, `/export`, partner client `createHana` (EIP-1193, Stellar, SWK module) | `develop` (packaging from `feat/sdk-packaging`) | Deployed in sandbox-dev's page Workers; built as installable tarballs (`pnpm run pack:check`, D71), not published (registry and licence open, D72) |
| `@hana-id/react` (`HanaProvider`, `useHana`, `useWallet`), `@hana-id/sodax` (Stellar and EVM wallet-provider adapters) | `develop` (packaging from `feat/sdk-packaging`) | Code done; tarballs as `@hana-id/web`, not published |
| `admin app:settings` | `develop` | Code done |
| `apps/smoke` | `develop` | `/` logs in through `@hana-id/web` (the vault); `/direct.html` keeps Google Identity Services and the split path for the ship gate |
| `apps/e2e` (Playwright: Chromium, WebKit, Firefox; local builds against the real API Worker; CI job) | `develop` | Code done |
| Developer dashboard, admin console, billing-grade usage (batch C; `docs/batch-c-spec.md`, `docs/batch-c-build-plan.md`) | `develop`: C1–C3 | C1 (manifest fields, the Neon ledger schema, `console-core`), C2 (`packages/oidc`) and C3 (migration 0006, the gate on `app_keys` and `scopes`, the CLI on it) merged; **not deployed**: 0006 isn't applied on sandbox-dev and its API predates C3 (milestone M1, `docs/operations.md` "Hot DB migration 0006 and the new gate"). C4–C17 (consoles, capture, statements) not built |
| Batch C5: the API's `ConsoleRpc` and `AdminRpc` entrypoints (CAS writes on `app_changes`, keys, settings, staff proposals, notice ack, cancel, expedite, the breaker and hot-DB budget) and drift detection | `feat/batch-c-5` | Code done; inert until the console (C7) and admin (C8) Workers bind them. Member proposals and owner actions (C6) and the Neon reports (C12) not built |
| Governance contract (delayed issuer keys, watchdogs, pause, timelocked upgrades, DAO owner) | `develop` (from `feat/governance`) | Deployed on sandbox-dev 2026-10-30: migrated in place to v2 (same signer, same addresses), owned by the council DAO since 2026-10-30, one upgrade through the DAO (contract 0.1.1) (`docs/operations.md` "Governance migration (sandbox-dev)") |
| `apps/watchdog` (independent watchdog Worker, alerts, status endpoint for the admin portal) | `develop` (from `feat/governance`) | Deployed on sandbox-dev 2026-10-30 (forged-key and pause drills), redeployed 2026-11-02 with batch 5 (below); its pager (ntfy.sh) and heartbeat are set, Slack and email aren't (`docs/operations.md` "Watchdog service") |
| Governance API (delayed JWKS sync, `issuer_key_pending` / `paused` gate, `GET /v1/governance`) | `develop` (from `feat/governance`) | Deployed on sandbox-dev with the migration, 2026-10-30 (D1 migration 0005; `docs/operations.md` "Deploying the governance API") |
| Governance scripts (owner council, DAO-routed owner calls, timelocked upgrades, migration, `admin governance:status`) | `develop` (from `feat/governance`) | In use on sandbox-dev (`docs/operations.md` "Governance") |
| Partner identity token, build steps 1–4 (`docs/identity-token-spec.md`, D127): core layouts and ids, `POST /v1/identity/token`, JWKS and discovery, Worker-secret ES256 signer, migration 0008, `hana.getIdentityToken()`, `useIdentityToken()`, `scripts/identity-key.ts`, `examples/identity-verify` | `develop` (from `feat/identity-token-1`, `feat/identity-token-2`) | Deployed on sandbox-dev 2026-11-02 (active kid `17xAVaTf…`, standby offline; migration 0008; `docs/operations.md` "Identity token keys"). No `email` claim yet (steps 5–6); the watchdog pin check (step 8) is on `feat/identity-token-8` |
| Identity token step 7, code only: the AWS KMS signer (`apps/api/src/identity/kms.ts`, selected by `IDENTITY_SIGNER`), the manifest's `aws-kms` signer, `identity-key kms-*` (D215–D219) | `feat/identity-token-7` | Tested against a fake KMS; no env uses it. The AWS account, keys, IAM, CloudTrail reconciliation and alarms are still to set up (`docs/operations.md` "Identity token keys on AWS KMS") |
| Partner identity token, build step 8: the watchdog's identity JWKS and discovery check against `watchdog.pinnedIdentityKeys` and `identityToken.iss` (critical, no pause), an outside probe from GitHub Actions with the same rules (`@hana-id/jwks/identity`), an identity key's thumbprint as an issuer kid on chain (critical), `identity-key` writing the pins, thumbprint pinning in the example verifier (D210–D214) | `feat/identity-token-8` only | Not merged, not deployed (sandbox-dev's manifest pins its two keys; the watchdog needs `gen` and a redeploy; the probe runs once the workflow is on the default branch). Detection against an attacker who serves everyone the same JWKS, not prevention |
| Email login, contract v3 (self-issued email issuer with a signer policy, JWS JSON tokens, accounts and links, the hourly link counter (D200), `migrate` v2 → v3; `migrate_v1` removed) | `develop` (from `feat/email-login-1`, `feat/email-login-2`, `feat/link-cap`) | Code done, unit- and sandbox-tested (email login, links, the v2 → v3 upgrade through the DAO from sandbox-dev's v2 code, gas in `docs/contract-interface.md`); **not deployed** (sandbox-dev runs v2). Every off-chain part that calls it (issuer, API, web) is a later batch of `docs/email-login-build-plan.md`; until then nothing calls the new methods |
| `@hana-id/email` (email normalization v1, the `e1.` `sub`, the Google-hosted rule, the pinned disposable-domain list; build-plan batch 3) | `develop` (from `feat/email-login-3`) | Code done, frozen vectors; imported by the email issuer |
| `apps/email-issuer` (build-plan batch 4: `start`/`resend`/`verify`/`google-match`, JWKS and discovery, staff client proofs, unlock and unsuppress, owner device tickets, the `Challenge` and `RateLimiter` objects, its D1, SendGrid and outbox senders, the Worker-secret signer and an unwired KMS adapter), manifest `emailIssuer`, `scripts/email-issuer.ts` | `feat/email-login-4` | Code done and tested (miniflare, fake KMS, fake Google and chain); not deployed; no app enables email. Batch 6 (`feat/email-login-6`): reached at its own URL (`emailIssuer.url`, D230), finds apps by `app_keys` (D233) |
| Email login, watchdog (batch 5): email pins and signer policy, the link alarms from `get_link_stats()` (D200), `unrecorded_wallets` (D190–D193) | `develop` (from `feat/email-login-5`) | Deployed on sandbox-dev 2026-11-02 (version b156e1b5, no new migration). On the v2 contract it reads "no email issuer" and skips the link check; the manifest has no email pins yet (they must be set before batch 6 posts email keys) |
| Email login, the email issuer (batch 4: `apps/email-issuer`, login codes by mail through SendGrid, D194) | `develop` (from `feat/email-login-4`) | Merged, not deployed |
| Email login in the web, plain (batch 8a): the popup's method chooser and `/login/email` (address, code, resend, a different email, case B continues with Google, the device ticket on `authOrigin`), the vault's email-token check against the chain (`get_issuer_keys` / `get_self_issued("email")`, `scope_for_client("email", …)`), the `{scope}#email#{sub}#0` path and record check, `hana.login({method, emailHint})`, `loginProgress: email_code`, the new error codes; no linking | `develop` (from `feat/email-login-8a`) | Merged; live on sandbox-dev for the demo app (scope `s2`) |
| Email login in the web, linking (batches 7 and 8b): the path through `get_identity` (vault, export window), google-match before any chain call with Google's access token (the second, silent `email` request, D254), the four cases' screens in the popup (the follow-up channel, D256), the vault's D133 checks before the linked CKD payload and D137's revoke-and-restart, case B only after the popup's email step (D139), link banners with Cancel and Remove, `hana.account()`, `linkChanged`, `hana.linkAccount()`, key export for email wallets (D246 lifted, D258); the issuer's case-B `verify` answers the address's `sub`; the API accepts the vault's relay writes and puts the issuer in the vault page's CSP | `feat/email-login-8b` | Built and tested (unit; Playwright in three browsers with the `outbox` stub), not merged, nothing deployed (sandbox-dev steps: `docs/operations.md` "Turning linking on (batch 8b)") |
| Email login, API (batch 6): email tokens on `/v1/sessions` and `/v1/login` (`apps/api/src/email-token.ts`), the `create_session` proof of possession (D137) in the API, the vault's split path and the smoke page, `/v1/login`'s `linkJwt` precheck (D133), the link relays `/v1/link*` with share revocation, the email-login panics as errors, `GET /v1/app` `loginMethods`, D155's gas, migration 0010 (`apps.login_methods`, `email_usage`), the issuer on its own URL (D230) and its `app_keys` lookup (D233) | `feat/email-login-6` | Built and tested, not merged; nothing deployed (the user's steps: `docs/operations.md` "Email login on sandbox-dev"). Every app stays Google-only (`login_methods` `'google'`), no scope has an email client |

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
| API Worker | `apps/api/src/index.ts` | Cloudflare Workers (`apiUrl`) | Gate (key, origin, limits), verify-before-relay, relayer, vault shares, login relay, vault page HTML, crons; the identity token issuer (`src/identity/`: mint, JWKS, discovery; the signer behind `IdentitySigner`: a Worker-secret P-256 key on testnet, AWS KMS `Sign` on staging and mainnet, picked by `IDENTITY_SIGNER`); the `ConsoleRpc` and `AdminRpc` entrypoints (`src/rpc/`, `src/changes/`: the only writers of app config besides the CLI, no route) |
| Page Workers | `apps/api/src/pages/` (`vault-worker.ts`, `auth-worker.ts`, `host.ts`) | one Cloudflare Worker per Hana origin (D66) | `vaultOrigin`: forwards `GET /vault` to the API Worker (service binding `API`), serves the vault bundle; `authOrigin`: the four auth pages with their CSP, and their assets. Nothing else; never a cookie (D70) |
| `RelayerKey` DO | `apps/api/src/relayer-key.ts` | one object per relayer access key | Serialises that key's nonces, signs and broadcasts |
| `RateLimiter` DO | `apps/api/src/rate-limiter.ts` | one object per subject (`ip:…`, `app:…`, `export:…`, `owner-actions:…`, `identity:global`, `identity-proof:<sessionPk>`) | Fixed-window counters, global and exact; owner-token and identity-proof single-use markers |
| Rate Limiting bindings | `apps/api/src/vault/limits.ts` (`VAULT_IP_LIMIT`, `VAULT_SHARE_LIMIT`), `apps/api/src/identity/limits.ts` (`IDENTITY_SESSION_LIMIT`) | each Cloudflare location, no network hop | The vault's per-IP and per-share and the identity token's per-session flood limits, approximate (D95) |
| Email issuer Worker | `apps/email-issuer/src/index.ts` (`handlers.ts`) | Cloudflare Workers, its own Worker on Hana's main account, at `{emailIssuer.url}/v1/email/*`: its own `workers.dev` URL on sandbox-dev, the API's URL by a zone route in production, never through the API Worker (D230; not deployed) | Email codes (`start`, `resend`, `verify`), email tokens (JWS General JSON, RS256, nonces computed per purpose), `google-match` (automatic linking's four cases), JWKS and discovery, staff routes behind Access (client proofs, unlock and unsuppress, which mail the address, ticket revocation) and the mailed confirmation (`confirm`). Alone holds ISSUER_SIGNING_KEY, K_sub, K_code, K_rl and the SendGrid key; reads the chain and the API's D1, writes neither |
| `Challenge` DO (`EMAIL_CHALLENGE`) | `apps/email-issuer/src/challenge.ts` | one object per challenge or link ticket | The code's HMAC, attempts, purpose and nonce, the address encrypted under the challengeId's client-held half (≤ 10 min, for resends); named by a hash of the id's public half; single use |
| Issuer `RateLimiter` DO | `apps/email-issuer/src/rate-limiter.ts` | one object per mailbox, recipient domain, IP subject or prefix, app, `global`, staff member | Exact limits; per mailbox: code mails per requester and overall, the device ticket's allowance, live challenges, wrong-code locks and the 18 + 4 + 3 ceiling, unlock grants and staff caps, each decision one atomic call; in `global` the budget's per-app shares (D198) |
| `LoginRelay` DO | `apps/api/src/login-relay.ts` | one object per `relayId` | Write-once, read-once slot for the encrypted Google token, 120 s |
| D1 `DB` | `apps/api/migrations/` | Cloudflare D1 | Scopes (one org and environment each), apps, publishable keys, origins (in force from `active_from`), plans, settings, guarded changes and the `app_changes` ledger, session markers, vault shares, identity token counts; the legacy `usage` counters (no longer written, batch C4) |
| Usage ledger | `apps/api/migrations-usage/`, `apps/api/src/usage/` | Neon Postgres (`aws-ap-southeast-2`, D73) through the optional Hyperdrive binding `USAGE_DB` (role `usage_writer`, which may only call `usage.record_event`, `usage.record_identity_tokens`, `usage.record_email_counts` and `usage.ensure_partitions`) | One UsageEvent v1 per request past the gate, written after the response with one retry, fail open (a lost event is logged, never blocks or slows a request); the hourly copy of identity token counts per app and day (D220–D224) and of email login counts (`email_usage`, D233) |
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
| Partner client → vault | `postMessage` hello, then a `MessageChannel` port (`packages/web/src/client/vault-connection.ts`) | Port methods (`hana_login`, `eth_signTransaction`, …) and events. Never key material. The vault says `connected` on the port once it has taken the hello (before storage and the unlock call), then `ready`; the SDK gives each frame 5 s to answer (5 s more while it is still loading; a loaded frame that doesn't answer is replaced once), then gives `ready` 20 s after `connected`, and on a failure removes the frame and reports `vault_unavailable` with `data.reason` (D262) |
| Vault ↔ auth popups | `postMessage`, checked by `event.origin` and `event.source` (a popup the partner page opened reaches the vault as `opener.frames[v]`) | `hana:auth-params` (incl. `relayKey`, and `followKey` in a login that offers email), approval requests/results and `hana:approve-close`, export context |
| Partner client → approval popup | `window.open` only (it holds the WindowProxy; the popup takes no message from it) | — |
| Auth popup → Google | top-level navigation | Implicit flow, `response_type=id_token`, `scope=openid`, `prompt=select_account`; in a login that offers email, then a second silent request `response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>` (D254) |
| `/login/callback`, `/login/email` → API | `POST /v1/login-relay/:relayId` (`Origin: authOrigin`) | AES-GCM ciphertext of the token; in a login that offers email also the access token and the answers to the vault's follow-up notices (follow-up slots) |
| Vault → API | `fetch`, `Origin: vaultOrigin`, `x-hana-key`, `x-hana-parent-origin` | `/v1/app`, relay read and (follow-up notices, batch 8b) relay write, `/v1/login`, `/v1/sessions/revoke`, `/v1/link*`, `/v1/vault/*` |
| Vault → email issuer | `fetch`, `Origin: vaultOrigin`, no cookies | `POST /v1/email/google-match` (Google's ID and access tokens, the session commitment; batch 8b) |
| Vault → NEAR RPC | JSON-RPC (manifest `rpc`; `rpcFallback` only when `rpc` errors or times out, one endpoint per answer: `packages/web/src/near-call.ts`) | `get_session` re-sync, the login's registry check (`scope_for_client`, or `get_scope` and `get_config`), `get_identity` (the path, batch 7), `get_account` and `get_config().unrecorded_wallets` (links), the email keys and policy, `EXPERIMENTAL_tx_status` polling; the export window the same |
| Vault, export window → Google | `https://www.googleapis.com/oauth2/v3/certs` | JWKS for the defence-in-depth RS256 check |
| Partner page → API | `fetch` from the partner origin | `GET /v1/app` (any key); `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only for test-scope apps in dev envs (`apps/smoke`) |
| API → NEAR | NEAR RPC | Views (`get_config`, `get_scope`, `scope_for_client`, `get_session`, `session_key_in_use`, `get_issuer`; for the cron and `GET /v1/governance` also `get_key_changes`, `get_governance`, `view_access_key_list`), `send_tx`, `tx` |
| `hana-signer` → MPC | cross-contract call, 20 Tgas, 1 yocto | `request_app_private_key {derivation_path, app_public_key, domain_id}` |
| API cron → Google, `hana-signer` | HTTPS, then `set_issuer_key` / `propose_issuer_key_removal` / `execute_issuer_key_change` signed with `KEYS_UPDATER_KEY` (delayed key changes, governance batch) | JWKS sync (`apps/api/src/issuer-keys.ts` `syncIssuerKeys`) |
| Watchdog → Google | `https://www.googleapis.com/oauth2/v3/certs`, `cache: no-store`, every 5 min (and once more 60 s later when a pending kid is missing) | Its own JWKS copy, never the API's |
| Watchdog → NEAR | its own RPC (manifest `rpc`, then `rpcFallback`): `status`, views `get_key_changes`, `get_issuer` and `get_issuer_keys` (`google`, `email`), `get_self_issued("email")` and `get_link_stats()` (absent on v2: read as no email issuer), `get_config`, `get_governance`, the owner's `view_account` and (a DAO) `get_policy`, the relayer's `view_account` and `view_access_key_list` (final; alert only, D150); `send_tx` from `WATCHDOG_KEY` on `watchdog.account` | `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key` only |
| Watchdog → Hana's email JWKS | `watchdog.pinnedIssuerKeys.email.jwksUrl` (default `{emailIssuer.url}/v1/email/jwks.json`, else under `apiUrl`), only with pins | Compared with the pins and the active email keys; warning only, never trusted |
| Watchdog → Hana's identity JWKS and discovery document | `{identityToken.iss}/jwks.json` and `/.well-known/openid-configuration`, `cache: no-store`, `redirect: manual`, 64 KB cap, every 5 min, only with `identityToken` in the manifest | Each key's RFC 7638 thumbprint against `watchdog.pinnedIdentityKeys`, public members only, private members, duplicate members, the shape, `issuer` and `jwks_uri`; critical alerts, never an action (D210, D213, D214) |
| Outside probe (GitHub Actions) → Hana's identity JWKS and discovery document | `.github/workflows/identity-probe.yml` every 15 min, `scripts/identity-probe.ts`: jose's User-Agent, no redirect followed, 64 KB cap, every non-`local*` env with `identityToken` | The watchdog's rules (`@hana-id/jwks/identity`) from outside Cloudflare; a finding fails the run (GitHub's email). No secrets (D210) |
| Watchdog → paging app, Slack, Resend, heartbeat | HTTPS with its own credentials (`apps/watchdog/src/channels.ts`) | Critical: page + Slack + email, re-sent every 15 min until acknowledged; warning: Slack + email; daily digest; dead-man's switch ping |
| Admin portal (batch C) → watchdog | `GET /status`, `/alerts`, `/actions`, `POST /alerts/:id/ack`, bearer `WATCHDOG_STATUS_TOKEN` | The "Security & monitoring" view; acks stop re-sends only |
| Operator → `hana-signer`, D1, Worker | `scripts/`, `wrangler` | Deploy, register scopes, apps, origins, secrets |

## Flows

### Login, one transaction (`POST /v1/login`)

Browser steps: `packages/web/src/vault/login.ts`, `packages/web/src/auth/login-page.ts`, `callback-page.ts`.

1. Partner calls `hana.login()` in its click handler; the SDK opens `{authOrigin}/login?v=<vault frame name>` before
   any `await`, then sends `hana_login` on the port. Popup blocked → the vault shows a "Sign in with Hana" launcher.
2. The vault makes a non-extractable Ed25519 session key, 32-byte salt, `expiresAtMs = now() + min(session_ttl_ms,
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
    survives it. Revoke-other-devices, touch and consent reads and writes wait for it.

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
   `POST /v1/email/verify` → the email token, encrypted under `relayKey` into the same relay slot as Google's answer;
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
`auth/google.ts`, `packages/core/src/links.ts`, `relay.ts`. Only in a login that offers email; a Google-only app's
login is batch B's, message for message (no follow-up key, no google-match, no email scope).

1. **The follow-up channel** (D256). The vault adds `followKey` (32 random bytes) to `hana:auth-params`. Slot `n`
   (1..12) of the login's channel is a relay slot whose read key is `HMAC-SHA256(followKey, "hana-id/relay-follow/v1"
   ‖ u8 n)` and whose id is `b64url(sha256(read key))`; every value is AES-GCM under the login's `relayKey` with that
   slot's AAD. The vault writes its notices in slots 2, 4, 6, … (`POST /v1/login-relay/<id>` from `vaultOrigin`, which
   the API now accepts) and reads the popup's answer to notice `n` in slot `n + 1`; slot 1 is the second Google
   request's access token. After its token is relayed the popup doesn't close: `/login/callback` hands over to
   `/login/email`'s follow-up mode (or the email step goes on in place), which long-polls the vault's next notice and
   shows it (`FollowNotice`: `link_code`, `use_email`, `prove`, `done`, `stop`).
2. **Google's verified email** (D254). `GOOGLE_EMAIL_FLOW = 'second_request'`: the login's Google request stays
   `response_type=id_token`, `scope=openid`; the callback relays the token with `access: 'follow'`, then makes a
   second, silent request (`response_type=token`, `scope=email`, `prompt=none`, `login_hint=<sub>`) whose access token
   it relays to slot 1. When Google needs the user (`consent_required`, `interaction_required`, `login_required`,
   `account_selection_required`), it asks once more without `prompt=none`. The switch's other value,
   `'one_request'` (`id_token token`, `openid email`), waits for the batch 0 spike (`apps/smoke/spike-email.html`).
   The address never reaches the vault or the partner page; the on-chain token stays openid-only (D25, the vault's and
   the API's `token_has_pii`).
3. **google-match before any chain call.** The vault sends `POST {issuer}/v1/email/google-match {pk, accessToken,
   googleIdToken, commitment, link: true, linkTicket?}` (CORS for `vaultOrigin`, D199; the vault page's CSP
   `connect-src` names the issuer, `EMAIL_ISSUER_URL`). No answer, or no access token: a Google identity with no wallet
   and no account is refused (`api_unavailable`, `email_match_unavailable`: it might be case A, and a plain login would
   open a second wallet, D255); one with a wallet or an account logs in as usual.
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
   `effectiveAtMs`, also told to the popup). With a link (D133): fresh `get_config` (links open only when
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

### Login, two transactions (split path)

`POST /v1/sessions` then `POST /v1/derive` with counter 1. Used today by `apps/smoke` (Google Identity Services,
partner origin, `pk_test_`, dev env only: `apps/api/src/origins.ts:68`). The vault keeps it as a `loginFlow: 'split'`
constructor option (`packages/web/src/vault/login.ts` `split()`), not wired to any build or env flag, until the ship
gate decides.

`/v1/sessions` (`handleAppEndpoint`, `handlers.ts:251`): gate → shape (`scopeId` from the client is refused; the app's
D1 scope is used) → RS256 + claims → claim allow-list only when `REJECT_PII_ON_SESSIONS = "1"` (off everywhere:
smoke's GIS tokens carry `email`) → nonce recompute → the session key's proof of possession (D137: `signature` over
`sessionMessage(0, "hana-id-create-v1:" ‖ sha256(session nonce preimage))`, signed by the vault's `split()` and the
smoke page, relayed as `create_session`'s `signature`; contract v3 requires it, v2 ignores it) → `checkClientScope`
and `session_key_in_use` in parallel → relay `create_session` (100 Tgas) → cache the session view 10 s.

### Explicit links (`POST /v1/link`, `/v1/link/cancel`, `/v1/link/unlink`)

`apps/api/src/links.ts` (batch 6; the web calls them from batch 8): from the vault or the auth origin only, gate kinds
`link` / `link-change` (adds and removals in separate windows) → the tokens verified and in the app's scope → the
contract's nonce and state rules from fresh chain reads (`link_new` / `link_account` / `link_change` over the account
root, the epoch, has-wallet, room, who may cancel or unlink) → relay `link_identity` (250 Tgas), `cancel_link` or
`unlink_identity` (150) through the session pool → revoke the account's vault shares in every app of the scope (the
root path at `key_index` 0..63, D233), so its other devices sign in again.

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
| Popup every time | `stellar_signMessage`, `personal_sign` (`NEVER_AUTO_APPROVED_KINDS`, `packages/core/src/approval.ts:41`) |
| Per app `raw_sign` | `hana_signRaw`: `'off'` → 4100; `'approval'` → popup with the raw warning, never auto-approved. The vault re-reads `rawSign` from `GET /v1/app` before each raw request when its last check is 10 s old (as for the policy); `'off'` there stops raw requests in that tab until a reload, and a failed re-read refuses (`api_unavailable`, `raw_sign_unconfirmed`) |

Test apps (D39, `packages/core/src/networks.ts`): for a `pk_test_` key the vault refuses, before any popup or
policy, a Stellar transaction or auth entry for the public network's passphrase, an EVM transaction on a chain outside
`TEST_EVM_CHAINS`, and typed data whose domain `chainId` is outside it (4100 `mainnet_not_allowed`). Messages, typed
data without a `chainId` name no network and pass. Raw requests are refused outright for test apps (4100
`raw_not_allowed_for_test_apps`, whatever `raw_sign` says): a raw digest can be a mainnet transaction's hash. The
EIP-1193 provider refuses switching to or
adding such a chain, and `eth_sendTransaction`/`eth_signTransaction` on one, before anything is filled. Every
approval and consent screen of a test app says Hana signs only for test networks (`testApp` in the popup messages).

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
`derivation.ts:98`). At most 100 requests wait; one the popup couldn't show is refused at once. The SDK fills fees
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

### Revoke and logout

| Action | Path | Chain tx |
|---|---|---|
| Logout (default) | App-wide on the device: under the per-app lock, `POST /v1/vault/revoke` for this tab's share and for the stored record's share if it is another session's; the vault deletes the record, zeroes PRK and broadcasts `logout` on `hana-vault:<appId>`, which ends every tab of the app | none |
| New login | Revokes this tab's previous share and the overwritten record's share, broadcasting `revoked {shareId}`; only tabs holding that share end | none |
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
   walletProofsHash ‖ sha256(""))`, with its server-corrected clock) and calls `POST /v1/identity/token`. In an app
   that keeps logins it first waits for the login's background persist (D79): the API needs the share.
4. **The API** checks the proof (±60 s, signature), that the contract isn't paused, the share (never another app's;
   in a `session` app: live, read-only, nothing moves), the on-chain session (live, in the app's scope), both wallet
   proofs, then single use and its limits (per session, per account, per app and per scope before a global breaker,
   D176); computes `sub` (HMAC of the path's root identity with `IDENTITY_SUB_KEY`, per scope, `key_index`
   dropped) and `sid` (HMAC of app and session key); sets `exp = min(iat + 1 h, session end)`; signs ES256 with the
   active key and checks the signature with the published key before answering.
5. The vault caches the token, announces it on `hana-vault:<appId>` (`{t: 'identity', sessionPk, token, iatMs,
   expiresAtMs}`: the session's other tabs cache it too) and emits `identityTokenChanged` to its partner page. A `410
   session_ended` ends the session in the vault as a revoked share does (`sessionExpired`).
6. **The partner backend** verifies the token against `{iss}/jwks.json` (cached 10 min): `alg` ES256, `typ`
   `hana-identity+jwt`, `iss`, `aud` = its app id, `exp`. The token is never accepted by any Hana API or the contract.

The cache is dropped (and `identityTokenChanged(null)` sent) at logout, expiry, revocation, a newer login, and when a
dormant session ends; it survives a session going dormant. The React hook `useIdentityToken` refreshes at `exp` − 5
min while the page is visible.

### Owner and registry changes

| Change | Who / how | Code |
|---|---|---|
| Register a scope (pilot) | Hana: `admin scope:register` → `admin_register_scope` with the owner account's full-access key | `scripts/admin.ts`, `scripts/lib/admin-scope.ts` |
| Register an app, origins, suspend/resume | Hana: `admin app:create --org` (writes the `scopes` row with the scope's environment, `pk_test_`/`pk_live_` by it, the first `app_keys` row), `app:origins:add` (a staff proposal: `guarded_changes` + an `app_origins` row with `active_from` NULL), `app:origins:remove` and `app:suspend/resume` (immediate; Hana's suspension bit 1), each with its `app_changes` row (D1 via `wrangler d1 execute`, compare-and-swap on the app's version) | `scripts/admin.ts`, `scripts/lib/admin-apps.ts`, `scripts/lib/admin-sql.ts`, migration 0006 |
| RPC writes (batch C5, unbound until C7/C8) | The console's members through `ConsoleRpc` (removals, turn-offs, settings, logo pointer, keys, the partner suspension bit, cancels, the emailed-link cancel) and Hana staff through `AdminRpc` (the same for any org, plus `createApp`, `assignScopeOrg`, `deleteApp`, every suspension bit, security contacts, staff proposals, `ackNotice` after the admin Worker's notice, expedite, the feeds). One D1 batch per write with its `app_changes` row first (compare-and-swap); kill switches through `ConsoleRpc` capped by the breaker (5 per org, 20 overall per hour) and every call by a hot-DB budget | `apps/api/src/rpc/`, `apps/api/src/changes/` |
| Guarded changes (origin adds, auto-approve policies, raw signing on) | Proposed by Hana staff (the CLI, or `AdminRpc.addOrigins` / `proposeChange`; the console's owners from batch C6/C10); in force only once announced and `appChangeDelayMs` later (24 h in production; 60 s on sandbox-dev). The admin Worker announces after its notice is accepted (batch C8); until then, in an env without an admin Worker, `admin app:changes:announce <id>` does it with no email. `AdminRpc.ackNotice` starts the clock the same way (and stores the cancel link's token hash). A change not announced within 7 days is cancelled by the API's hourly cron, which also records activations, promotes policies and raw signing, and flags origins, policies and raw signing no announced change or the 0006 baseline explains (drift, `apps/api/src/changes/drift.ts`). The initial origins of an app whose scope `app:create` created skip the delay while the scope shows no sign of a user (`no_session` waiver: no `first_session_at`, which every session-pool relay attempt writes, no other origin ever in force, no share, session marker (written once the first session-pool relay settled; batch C4) or identity row; decided in the announcement's SQL) | `scripts/lib/admin-apps.ts`, `apps/api/src/guarded/cron.ts`, migrations 0006 and 0009 |
| Vault settings (`persistence`, TTLs, `raw_sign`, policy, web client) | Hana: `admin app:settings` (D1; `--raw-sign approval`, live apps only, and a new or changed policy are guarded changes, above; turning either off and the other settings are immediate; every write bumps `settings_version`, applies only over the row it read and records an `app_changes` row) | `scripts/lib/admin-settings.ts`, migrations 0003 and 0006 |
| Propose / cancel / remove client / disable shared login (OIDC owner) | `POST /v1/owner-actions` with a console-client token; off-chain precheck, single-use token marker, owner pool | `handleOwnerAction` `handlers.ts:396`, `apps/api/src/owner-actions.ts:31` |
| Execute a matured change | anyone; `POST /v1/owner-actions` relays `execute_change` | same |
| NEAR-account owners | call the contract directly (the API relays OIDC auth only, `apps/api/src/validate.ts`) | `contracts/hana-signer/src/registry.rs` |
| Shared clients, sponsors, console audiences, issuers | owner account via `deploy-contract` | `scripts/deploy-contract.ts`, `scripts/lib/deploy-plan.ts` |
| Google RSA keys | the 15-min cron with `KEYS_UPDATER_KEY` proposes adds and (after ≥ 55 min missing, never the last key) removals, and executes matured changes that match Google's JWKS; a key is active only after `issuer_key_delay_ms` or a watchdog's confirmation | `apps/api/src/issuer-keys.ts`, migrations 0002, 0005 |

Timelocks, quarantine and shared-client rules: `docs/contract-interface.md` "Registry" and "Shared clients".

### Key export

`packages/web/src/auth/export-page.ts`: `hana_export {chain}` → launcher → top-level `{authOrigin}/export` window,
which runs its own fresh login (`/login?mode=export`, `max_age=0`, `max_uses = 1`) through `/v1/login`: Google, or in
an app with email (batch 8b, D246 lifted, D258) the child popup's chooser and `/login/email`'s code step over the export
window's own session (purpose `session`; the token checked against the chain's email keys as the vault does). It
resolves the path through `get_identity` on its own RPC (a linked identity exports its account root's key; a pending
one is refused, `link_pending`), decrypts against that path, aborts if the address differs from the vault's, and shows the key (SEP-23 `S…` or `0x` hex)
while a button is held after a typed confirmation. The key is erased 5 min after it is derived, or earlier when the
vault session ends: the context carries `sessionExpiresAtMs`, and the vault's `cancelExport` posts
`hana:export-end` on logout, revoke, expiry, a newer login or its 15 min job limit; the window also ends if its vault
frame goes away (D111). The vault's PRK is never used for export. The `auth_time` freshness
check is off (Google returns no `auth_time`, D27; `maxAuthAgeMs`, `packages/core/src/id-token.ts`). Encodings:
`packages/core/src/export.ts`. The export window takes its context only from the vault frame that opened it (its
`opener`, origin `vaultOrigin`), and the vault opens it only from its own launcher's click, so a partner page can't
start an export on its own. Its `/v1/login` is relayer-paid and limited to 3 per hour per user path per app
(`apps/api/src/login.ts`, D59).

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

`account = 0` and `key_index = 0` in the MVP. `key_index ≥ 2^31` is refused by the contract (`sessions.rs:27`), the
API (`apps/api/src/validate.ts:12`) and core (`layouts.ts:18`). Golden vectors: `packages/core/test/vectors/
derivation-v1.json`, guarded by a SHA-256 constant test that fails with "address-changing edit"
(`packages/core/test/derivation.test.ts:62`).

What decides an address, and when it freezes:

| Input | Changes addresses? | Status |
|---|---|---|
| MPC network (its master key) | yes, all | fixed at the address freeze (mainnet MPC) |
| Signer account id (in `app_id`) | yes, all | fixed when final accounts deploy |
| Path format `scope#provider#sub#key_index` | yes, all | fixed now (contract) |
| Scope id, Google `sub`, `key_index` | yes, per user / app | per login; `sub` is the same across clients, also in different Cloud projects (D42) |
| HKDF labels, tuples, key rules (derivation v1) | yes, all | names confirmed 2026-10-28; frozen at the address freeze |
| New chain tuples, new `account` values | no (additive) | open |
| `vaultOrigin`, `authOrigin`, `create_session_and_derive`, persistence, own vs shared client | no | `authOrigin` still breaks own-client redirect registrations if changed |

Contract v3 (email login, merged on `develop`, not deployed) adds no input to this table for existing identities:
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

## Data stores

| Store | Holds | Never holds |
|---|---|---|
| `hana-signer` state (public) | Config (owner, mpc, domain, sponsors, console audiences, shared clients, change delay), issuers and Google RSA public keys, scopes (owners, clients, pending changes, `action_nonce`), client index, quarantine / retired-client records, sessions (`path`, `scope_id`, `expires_at_ms`, `max_uses`, `used`), revoke tombstones, expiry FIFO | Keys, S, PRK |
| NEAR transaction args (public forever) | Google ID tokens used in `create_session*`, register proofs, owner tokens; session signatures; BLS `pk1`/`pk2`; MPC responses (encrypted to `a`) | Anything usable without the session key or `a` |
| D1 `DB` | `plans`, `scopes` (org, environment, `first_session_at`), `apps` (+ 0003 settings: `persistence`, `session_ttl_ms`, `idle_ttl_ms`, `raw_sign*`, `auto_approve_*`, `google_web_client_id`; + 0006: `org_id`, `suspended_by`, the two versions, `logo_key`, `deleted_at`), `app_keys` (publishable keys, public), `app_origins` (+ `active_from`, `change_id`), `guarded_changes`, `app_changes` (append-only ledger of every app write, actors as staff ids or `cli:<login>`), `security_events`, `org_security_contacts` (staff-set emails; none yet), `session_markers` (the first session-pool relay per app, the waiver's sign), the legacy `usage` (`sessions`, `derives`, `unlocks` per app per UTC day; not written since batch C4), `issuer_key_missing`, `vault_shares` (`share_enc` under `VAULT_KEK`, `session_pk`, `path_hash`, `partner_origin`, counter, times), `identity_issuance_hourly` (tokens per signing key and hour), `identity_usage` (tokens per app and day) | Plaintext `K_s`, tokens, user ids (only `sha256(path)`), identity tokens, `sub`, `sid`, addresses |
| Usage ledger (Neon, `usage` and `ops` schemas) | Per request past the gate: request id, time, org, app, scope, endpoint, outcome, code, status, latency, relayed, transaction, relayer key and nonce, provisional gas, and on ok login/session/derive the uid (`HMAC(USER_ID_KEY, scope ‖ provider ‖ sub)[0..16]`, a pseudonym, D96); `app_users` (first and last day per uid); identity tokens per app and day | A sub, JWT, email, IP, session key, share id or path |
| `RelayerKey` DO storage | Per key: `publicKey`, nonce reservation, last block hash and time | Secret keys (they are Worker secrets) |
| `RateLimiter` DO storage | `<window>@<start>` counters; `mark:<sha256(owner token)>` single-use markers until the token's `exp`; `mark:<sha256(identity proof signature)>` until the proof's `issuedAtMs` + 120 s | Tokens |
| `LoginRelay` DO storage | One slot: `{iv, ct}` for ≤ 120 s, then a tombstone for 120 s | Plaintext tokens (the API has no `relayKey`) |
| Per-isolate memory (API) | JWKS (≤ max-age, stale ≤ 6 h on fetch failure), config / scope / client views (≤ 60 s; "no scope" ≤ 10 s), sessions (≤ 10 s), parsed KEKs, counter holds | — |
| Browser, `vaultOrigin` | IndexedDB `hana-vault` records (partitioned by top-level site; format 2 adds the identity wallet proofs); memory: session key, PRK, consent and counters, the current identity token | S, `a` (memory only, dropped), plaintext PRK on disk, an identity token on disk |
| Browser, `authOrigin` | `sessionStorage` `hana.login.<relayId>` = `{v, createdAt, relayKey}` (≤ 10 min, single use) | Tokens |
| `.secrets/<env>/` (operator machine, gitignored, 0700/0600) | `relayer-keys.json`, `owner-relayer-keys.json`, `keys-updater.json` (`scripts/lib/secrets.ts:66`), `vault-kek` (+ `vault-kek.previous` during a rotation; `scripts/lib/vault-kek.ts`), `identity-signing-key.json` (active), `identity-signing-key-standby.json` (published, never uploaded; keep it offline), `-next.json` / `-previous.json` during a rotation, `identity-slots.json`, `identity-sub-key` (`scripts/lib/identity-key.ts`, D177), `neon.json` (the ledger owner's URLs), `neon-usage-writer.url`, `neon-usage-admin.url`, `user-id-key` (`scripts/lib/usage-setup.ts`, D224) | — |
| `~/.near-credentials/testnet/` (operator machine) | Full-access keys of the owner, signer and relayer accounts (`scripts/lib/keys.ts`) | — |
| Worker secrets | `RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`, `VAULT_KEK`, `VAULT_KEK_PREVIOUS`, `IDENTITY_SIGNING_KEY` / `IDENTITY_SIGNING_KEY_STANDBY` (two slots: the active identity key, and during a switch the incoming one), `IDENTITY_SUB_KEY` | — |
| Watchdog D1 (its own Cloudflare account) | `meta` (last chain snapshot with the email issuer and policy, failure counters, heartbeat, digest, run lock, the last relayer funds reading, the email policy verdict, the last link stats), `seen_kids` (kid, `n`, `e`, first/last seen; `baseline` kids from the first run), `absences`, `runs` (30 days), `actions` (method, args, tx hash), `alerts` (severity, details, acks), `deliveries` | Secrets, tokens |
| Watchdog Worker secrets | `WATCHDOG_KEY`, `WATCHDOG_STATUS_TOKEN`, `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`, the paging app's credentials, `HEARTBEAT_URL` (from `.secrets/<env>/watchdog-secrets.json`) | — |
| `apps/api/.dev.vars` (local, gitignored, 0600) | Relayer and updater keys and the identity token's secrets for `wrangler dev` (`gen-wrangler --dev-vars`) | — |
| Partner backends | Identity tokens they received (≤ 1 h each), and whatever they keep from them (`sub`, `sid`, addresses) | Anything that reaches a key |

## Environments and manifests

- One manifest per env, `envs/<env>.json`, validated by `packages/env/src/schema.ts` (zod) and loaded with `loadEnv`.
  Only `sandbox-dev` exists. `network` accepts only `testnet`. Every account name the code uses comes from here
  (`signer`, `relayer`, `owner`, `mpc`); code reads it via generated config, never by hard-coding names.
- Other fields: `ckdDomainId`, `ckdNetworkKey` (pinned with `scripts/fetch-ckd-key.ts`), `rpc`, optional
  `rpcFallback` (https, not `rpc`; the vault's and the export window's second NEAR RPC, in their CSP, and the
  Workers' `NEAR_RPC_FALLBACK`), `apiUrl`,
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
- `packages/web/scripts/gen-envs.ts` writes the gitignored `packages/web/src/envs.generated.ts` with the pinned
  per-env constants (`signer`, `relayer`, `rpc`, `rpcFallback` when set, `ckdNetworkKey`, origins, `devEnv`) for every
  manifest with both origins; it fails on an unusable CKD key.
- Runtime flags, `"0"` everywhere for now (`FLAG_DEFAULTS`, `gen-wrangler.ts`): `BLS_PRECHECK` (Workers Paid plan
  only, D64), `REJECT_PII_ON_SESSIONS` (the user turns it on after the spec's step 7; `apps/smoke/direct.html` still
  sends Google Identity Services tokens, which carry `email`).
- sandbox-dev runs on `*.tingtc.workers.dev` (personal Cloudflare account, free plan). Production env and a Hana
  domain are deferred (`docs/decisions.md` D18; two registrable domains, D38).

## Relayer design

- **Two pools** of function-call keys on the relayer account, receiver = signer, in `apps/api/src/relayer-config.ts:15`
  and `scripts/lib/contract.ts`: session pool (`RELAYER_KEYS`, default 3 keys × 2 NEAR allowance:
  `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions`) and owner pool
  (`OWNER_RELAYER_KEYS`, default 1 key × 0.5 NEAR: `propose_change`, `cancel_change`, `remove_client`,
  `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config`). Abuse of `/v1/owner-actions`
  can only drain the owner pool. The session list is batch B allowlist state 1; state 2 or 3 follows the ship gate
  (each change deletes and re-adds every session-pool key). `deploy-contract` treats a full-access key, another
  receiver, other or empty methods, or an unlimited or too-large allowance as a blocker.
- **Dispatch**: `relay()` picks a key round-robin per pool from a random start per isolate
  (`apps/api/src/relayer-pool.ts:33`); the method is checked against the pool in the Worker and again in the object.
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
