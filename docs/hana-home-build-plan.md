# Hana Home build plan (batches)

**Status (2026-11-09): H0 (this plan, the spec's rewrite, D460–D466, the readiness rows) on branch `docs/hana-home-h0`; H1 built on branch `feat/hana-home-h1`, its security review's fixes on `feat/hana-home-h1-2` (not merged, not deployed; see its result line below); H2–H12 not started.** Splits `docs/hana-home-spec.md` (D40, D45, D98, D460–D466) into reviewable
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
   in `scope.clients`. Such a scope could cut shared Google at once, stranding unlinked Google users. Now D460 and H6.
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
| H6 | Contract: delayed turn-off, the permanent exit client (D468), callers | — | L | owners run the timelocked upgrade |
| H7 | `/home` page: sign-in, Your apps, addresses, expiry | H1, H2 | L | — |
| H8 | Export in Home | H3, H7 | M | — |
| H9 | Devices, consent, share and email-share revoke | H5, H7 | M | — |
| H10 | Email users | H3, H7 | M | — |
| H11 | Billing: the statement line | H3 | S | apply Neon 0008 |
| H12 | Playwright, testnet run, reference docs, link `/home` | all | M | run and sign off |

**Parallel:** H0 beside H1. After H1: H2, H3, and H4 then H5. H6 any time. After H7: H8, H9, H10. H11 after H3. Route
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
  directory (D462, D466), coverage, a pending turn-off from `get_scope` (D460), addresses, Support ID, the quieter
  listing, `hana_held_clients`, `admin home:client:add`.
- **Tests.** Each coverage row; suspended, deleted and purged scopes; a member resolving to its root; a pending turn-off.
- **Migration / deploy.** D1 (`hana_held_clients`, the listing flag); API.
- **User-visible.** Nothing (no page yet).

### H3: Home derives

- **Scope.** `POST /v1/home/login`: no app gate; `verifyLoginToken` without `appId`; `sessionStanding` for the root path;
  the limits; the `home` pool; `key_exported` at the derive with `chain` null.
- **Files.** `apps/api/src/login.ts`, `login-token.ts`, `relayer-config.ts`, `mainnet-demo.ts`; `scripts/deploy-contract.ts`;
  the watchdog's pool list.
- **Tests.** Every limit before the relay; a member's path; a suspended app; nothing relayed on any failed check.
- **Migration / deploy.** D1 `home_usage`, and `user_events` if open item 4 relaxes it; key, API.
- **User-visible.** Nothing.

### H4: consents on the server

- **Scope.** `vault_consents`; the share's device label; `/v1/vault/consents*`; `consent` on `GET /v1/app`, which also
  reports a revoked share (D465); the prune in `vaultMaintenance`.
- **Tests.** The spec's consent list; both persistence modes; a revoked share reads `'revoked'`.
- **Migration / deploy.** D1; API.
- **User-visible.** Nothing.

### H5: the vault

- **Scope.** Register before use, fail closed, the status with the existing 10 s read (no new polling, D465), revoke
  paths. Changes live partner tabs.
- **Files.** `packages/web/src/vault/vault.ts`, `auto-approve.ts`.
- **Tests.** No grant if registering fails; `'revoked'` clears the local consent; a revoked share stops auto-signing
  within about 10 s.
- **Migration / deploy.** The vault, after H4 is live.
- **User-visible.** Auto-approve can't be turned on while the API can't record it (D98 item 13). Nothing else.

### H6: the contract

- **Scope.** `SetAllowShared {allow:false}` accepted by `propose_change`, needing shared login on and a remaining Google
  client, re-checked at `execute_change`; `disable_shared_login` no longer turns it off at once (open item 3). Callers:
  `apps/api/src/owner-actions.ts`, `validate.ts`, `gas.ts`, `relayer-config.ts`, `SAFETY_METHODS` in `handlers.ts`; the
  console's `actions.ts`, `Action.tsx`, `Scope.tsx`; console-core; `scripts/lib/contract.ts`; the admin's mail text.
- **Files.** `contracts/hana-signer/src/registry.rs`, `tests.rs`; `docs/contract-interface.md`, `api.md`, `security.md`.
- **Tests.** cargo, fixtures, golden paths; the old test that refuses `allow:false` flips; a turn-off with only an email
  client is refused; the Google client removed while the change waits fails the execute.
- **Migration / deploy.** No `migrate` and no state change. The timelocked upgrade, then the API, then the console. Land
  before the audit (readiness 6.1).
- **Condition (H1's review).** If this lands before H10, take H10's condition here: the contract refuses a client proof
  for `("email", "hana-home")`.
- **User-visible.** A partner's turn-off of shared login now waits the scope's delay. Partners need telling before it
  ships on any env they use.

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

### H10: email users

- **Scope.** An issuer Home route with an `aud` not on chain; the `/login/email` mode; gating on the chain's registration,
  not an active app (D434, D463).
- **Files.** `apps/email-issuer/src/handlers.ts`, `apps/api/src/email-token.ts`, `packages/web/src/auth/email-page.ts`.
- **Tests.** A Home token can't open a session; a suspended scope works; the mailbox limits still apply.
- **Migration / deploy.** Issuer, API, pages (the API before the issuer).
- **User-visible.** Only by typing the URL.
- **Condition (H1's review; H6 or H10, whichever lands first).** If the route signs a caller-supplied nonce, an owner can
  get a `hana-home` token carrying `client_proof_nonce` for their own mailbox and register `("email", "hana-home")` on
  their scope (`registry.rs`, `AddClient`). Refuse that client: in the contract's `propose_change`, or in the issuer by
  computing the `homeNonce` from the key, expiry and salt instead of signing what it's given. Test it. Until then D474's
  "on no scope" isn't a guarantee.

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

## Decided on 2026-11-09

| Decision | Choice | Batch |
|---|---|---|
| D460 (row 1.14) | Turning off shared login waits the scope's delay via `SetAllowShared {allow:false}` and needs a remaining Google client; Home shows a pending turn-off | H6, H2 |
| D461 (row 1.15) | Statement line while the app is active, Hana pays after it's gone | H11 |
| D462 (row 1.16) | The list from `scopes.first_session_at`, the wallet directory as a "your apps" overlay | H2 |
| D463 | Email-only users get Home at launch | H10 |
| D464 | Enterprise: Hana a scope owner from onboarding, with contract wording | onboarding |
| D465 | A revoked share stops auto-signing within about 10 s, in the vault's existing read | H4, H5 |
| D466 | Home may use the wallet directory, disclosed in the privacy notice | H2 |

## Still open

| # | Item | Owner | Blocks |
|---|---|---|---|
| 1 | The production domain for `/home` (readiness 4.1, 4.2) | founder | production only |
| 2 | Settled by D468 (the permanent exit client). H6 decides whether D460's Google-client requirement and D464's owner seat are still needed | founder, with H6's design | H6 |
| 3 | `disable_shared_login`: remove the method, or keep it as a stub that panics (it can't keep working: it would bypass the delay) | Claude build | H6 |
| 4 | `user_events.app_id` is NOT NULL and a Home derive is per scope: record the scope's app, or relax the column | Claude build | H3 |
| 5 | Billing of a suspended app: Hana pays for now (D461's note); to discuss with colleagues before finalising | founder, colleagues | H11 |
| 6 | Hana's Enterprise owner role is held by the Hana council (D464's note). How Hana watches for a `SetOwners` that removes it, if the seat stays after D468 | founder | first Enterprise partner |
| 7 | Partner terms (readiness 9.9), the privacy notice line (9.10), the Enterprise onboarding wording (9.11) | legal/founder | mainnet |

## Contract and derivation

Only H6 touches the contract. It changes the registry, not paths or keys: **no address impact**, and no batch changes
derivation. Limits of D460: the delay is at most 7 days and Hana never contacts users (D96), so Home must show the
pending turn-off. A partner also loses its instant cut if Hana's login is compromised; Hana's pause remains.

## Independent security review

- H1: identity (done 2026-11-09: no critical, high or medium; see H1's review line).
- H3: a derive without an app gate.
- H4–H5: auto-sign.
- H6: the contract.
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
