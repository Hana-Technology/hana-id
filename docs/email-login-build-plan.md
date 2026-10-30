# Email login build plan (batches)

**Status: batch 1 in progress (branch `feat/email-login-1`).** Splits `docs/email-login-spec.md` "Build order"
(approved 2026-10-30; D4, D119, D121–D123, D25 and D96 amended) into reviewable batches. The spec stays the source of
truth for *what* to build; this file says *in which order*, *what each batch ships* and *what users see after it*.
Like a spec it is history once the work merges: the current state lives in the reference docs (`docs/README.md`).

## Rules for every batch

- Each batch merges into `develop` on its own with `cargo test`, `pnpm -r test` and `pnpm -r typecheck` green, and
  updates the reference docs it touches (with their "Last verified" lines) in the same branch.
- **Nothing ships half-wired to users.** Email stays invisible until the batch that finishes the popup flow: the API
  only offers a method that the app's D1 `login_methods` enables (default `'google'`), and no app enables email before
  batch 8. A chain change that the watchdog would read as an attack (an email issuer key) is never made before the
  watchdog batch that pins it is deployed.
- **Address safety.** No batch changes the path of an unlinked identity (`{scope}#{provider}#{sub}#{key_index}`) or
  derivation v1. Every batch that touches path resolution (1, 7) carries golden tests of today's Google paths. The
  email normalization and `sub` derivation (batch 3) are frozen at the address freeze; a change before it moves every
  sandbox-dev email address and must be called out.
- Testnet only; no batch deploys to mainnet. Deploy steps below are for `sandbox-dev` unless said otherwise.

## Batches

| # | Batch | Spec step | Size (est.) | Depends on |
|---|---|---|---|---|
| 0 | Google `email` scope spike | 0 | 0.2k, 1 d | — (any time before 8) |
| 1 | Contract v3: self-issued issuers, signer policy, JWS JSON, accounts and links (unit tests) | 1 | 2.5k, 5 d | — |
| 2 | Contract sandbox tests and the v2 → v3 upgrade path | 1 | 0.6k, 1.5 d | 1 |
| 3 | `packages/email`: normalization, `sub`, vectors, disposable-domain list | 2 | 0.5k, 1 d | — |
| 4 | `apps/email-issuer` (Worker-secret signer), manifest `emailIssuer`, `scripts/email-issuer.ts init` | 3, part of 4 | 2.8k, 6 d | 1, 3 |
| 5 | Watchdog: email pins, self-issued rules, signer-policy diff, link volume | 7 | 0.6k, 1.5 d | 1 |
| 6 | API: email tokens, `GET /v1/app` methods, `linkJwt`, link relays, D1; sandbox-dev chain setup | 5 | 0.9k, 2 d | 1, 2, 4, 5 |
| 7 | Web, Google only: vault and export resolve the path through `get_identity`; link banners; `hana.account()` | 6 (part) | 0.9k, 2 d | 1, 6 |
| 8 | Web: email login, automatic linking, `linkAccount`; Playwright; email turned on for test apps | 6 (rest), 9 | 2.6k, 6 d | 0, 4, 6, 7 |
| 9 | Admin and partner console views | 8 | 0.6k, 1.5 d | 8, batch C Workers |
| 10 | AWS KMS signer, secrets tooling, staging rehearsal (before mainnet) | 4 (rest) | 0.5k, 2 d | 4 |

Steps 0, 3 and 5 can run beside 1–2. About 12k lines in all, as the spec estimates.

### Batch 0: Google `email` scope spike

- **Scope.** `apps/smoke/spike.html` (testnet client only): `response_type=id_token token`, `scope=openid email` for a
  personal and a Workspace account. Records whether Google puts `email` into the ID token, the consent text, and the
  `tokeninfo` / `userinfo` answers (`hd` present and absent).
- **Decides** whether the popup can use one Google request or needs the spec's fallback (a second silent
  `response_type=token` request so the on-chain token stays openid-only).
- **Files.** `apps/smoke/spike.html`, results in `docs/context.md` (testnet measurements).
- **Tests.** None beyond the manual run; the API's `token_has_pii` refusal already guards the chain either way.
- **User-visible.** Nothing.

### Batch 1: contract v3 (this branch)

- **Scope.** Everything the spec puts on chain ("Contract changes"): `mark_self_issued`, the signer policy
  (`signers`, `key_signer`, `required`, `overlap`), `set_issuer_key(..., signer)`, owner-only and
  `governance_delay_ms`-delayed self-issued keys with no early confirm, JWS General JSON Serialization verification for
  self-issued tokens (Google stays compact RS256), identity keys, accounts (root + ≤ 3 members, one per provider),
  `opened`, session path resolution, `create_session_and_derive(..., link_jwt, link_immediate)` with the four cases,
  `link_identity` / `cancel_link` / `unlink_identity`, the views (`get_self_issued`, `get_identity`, `get_account`,
  `identity_key`), events 1.2.0, the new byte layouts with JS worked examples, `migrate` v2 → v3.
- **Files.** `contracts/hana-signer/src/{lib,issuers,oidc,sessions,migrate,events}.rs`, new `self_issued.rs` and
  `links.rs`, `tests.rs` (and a test-only RSA signer), `scripts/gen-fixtures.mjs`, `test_fixture.json`,
  `v2_state_fixture.json`; `scripts/lib/contract.ts` (`mark_self_issued` in `OWNER_METHODS`); docs
  `contract-interface.md`, `security.md`, `architecture.md`, `decisions.md`.
- **Tests.** Unit tests for every behaviour in the spec's "Contract unit" list, hostile inputs (malformed JWS,
  duplicate kids and keys, wrong mode, pending-link logins, caps), the golden Google paths, and `migrate` from a v2
  state fixture built by the v2 code. `cargo near build non-reproducible-wasm` must succeed (size recorded below).
- **Migration / deploy.** None in this batch (not deployed). The v3 `migrate` reads a copy of the v2 struct and
  appends the new fields; it refuses any other state.
- **Deliberately left for later.** Sandbox tests and the deletion of `migrate_v1` (batch 2); every off-chain part.
- **User-visible.** Nothing.

### Batch 2: contract sandbox tests and the v2 → v3 upgrade path

- **Scope.** `contracts/integration-tests`: email issuer end to end with a local RSA key (set issuer, mark
  self-issued, owner-posted key after the governance delay, email login gives the expected CKD path); a link then a
  login through the member derives the same `big_y` as the root; the v2 → v3 upgrade through the DAO
  (`propose_upgrade`, `execute_upgrade` + `migrate`) from a v2 wasm built at a pinned commit, keeping every view and
  path; gas of every new call recorded (attached gas for `create_session_and_derive` with `link_jwt` confirmed or
  corrected from the spec's 150 Tgas). Removes `migrate_v1`, `HanaSignerV1` and the v1 fixture (sandbox-dev is v2;
  the v1 → v2 sandbox test goes with them).
- **Files.** `contracts/integration-tests/tests/{governance,email}.rs`, `common/mod.rs` (`V2_COMMIT`),
  `contracts/hana-signer/src/migrate.rs`, `docs/contract-interface.md` (gas table).
- **Tests.** As listed; CI's sandbox job.
- **User-visible.** Nothing.

### Batch 3: `packages/email`

- **Scope.** The spec's "Email normalization" (trim, IDNA UTS #46 non-transitional, ASCII local parts, Gmail canonical
  form), `sub` = `"e1." ‖ b64url(HMAC-SHA256(K_sub, "hana-id/email-sub/v1" ‖ 0x00 ‖ utf8(normalized)))`, the
  Google-hosted rule as a pure function, the pinned disposable-domain list (with a guard test that no Google-hosted
  domain is on it).
- **Files.** `packages/email/{src,vectors/email-v1.json,test}`.
- **Tests.** Frozen vectors and a guard test (like derivation v1), Google's help pages cited in the guard comment
  (Q7).
- **Address impact.** Defines every email address. Frozen at the address freeze.
- **User-visible.** Nothing.

### Batch 4: `apps/email-issuer`

- **Scope.** The spec's "Email issuer (Hana-run)": endpoints `start`, `resend`, `verify`, `google-match`, JWKS and
  OpenID configuration, `admin/client-proof` (behind Cloudflare Access and the staff allowlist); the `EmailChallenge`
  and `RateLimiter` Durable Objects; every limit; the sender adapter with Resend and an `outbox` stub (`local*` only);
  JWS JSON minting with the Worker-secret signer and a self-check; purpose-bound nonces computed by the issuer; the
  issuer's D1 (`email_issuance`, `email_hints`, `email_suppressions`); the manifest's `emailIssuer` block in
  `packages/env` (`gen` refuses `worker-secret` outside `local*`/testnet); `scripts/email-issuer.ts init` (keys and
  `K_sub`/`K_code`/`K_rl` into `.secrets/<env>/`, 0600, never printed). The KMS adapter is written and tested here
  against a fake KMS but not wired to any env.
- **Tests.** The spec's "Issuer" list (vitest with miniflare), including the log-capture test.
- **Deploy.** The Worker may be deployed to sandbox-dev at `{apiUrl}/v1/email/*` once batch 6 sets the chain up; with
  no app's `login_methods` including email, no popup reaches it.
- **User-visible.** Nothing.

### Batch 5: watchdog

- **Scope.** The spec's "Watchdog": `watchdog.pinnedIssuerKeys.email` (signers and `required`), pinned and unpinned
  email key changes (cancel, `forged_key_change`), no confirm for self-issued keys, `updater_other_provider` unchanged
  for "self", active unpinned email key → pause and `forged_active_key`, `get_issuer("email")` and
  `get_self_issued("email")` diffed against the pins (pause on a weaker policy), Hana's JWKS compared with the pins
  (warning), the link-volume check from `identity_link_*` events, check ids and portal rendering (D83).
- **Order.** Must be deployed to sandbox-dev **before** batch 6 posts the email keys, or the current watchdog's
  `unverifiable_key_change` alert fires for a legitimate change.
- **User-visible.** Nothing.

### Batch 6: API and sandbox-dev chain setup

- **Scope.** The spec's "API changes": the email `iss` in `ISSUER_PROVIDERS`; email tokens (JWS JSON) verified against
  `get_self_issued("email")` and the issuer's JWKS; `/v1/login` accepts and prechecks `linkJwt` and `linkImmediate`
  (recomputes the `auto_link` nonce); `GET /v1/app` returns `loginMethods` and `email.aud`, `409 no_login_method`;
  relays `/v1/link`, `/v1/link/cancel`, `/v1/link/unlink` with share revocation; the session-pool allowlist gains the
  three link methods (keys deleted and re-added); attached gas from batch 2's measurement; D1 migration
  (`apps.login_methods` default `'google'`); usage counts.
- **Deploy (sandbox-dev), in order.** Watchdog pins live (batch 5) → contract v3 through the DAO
  (`upgrade-contract propose|execute`) → `set_issuer("email", [iss])`, `mark_self_issued("email")`, two
  `set_issuer_key(..., signer: "hana")` (they wait `governance_delay_ms`, 60 s there) → issuer Worker secrets and
  deploy (batch 4) → `AddClient ("email", "email:s1")`, `("email", "email:s2")` → D1 migration → API deploy.
- **User-visible.** Nothing: every app's `login_methods` is still `'google'`.

### Batch 7: web, Google only (path resolution)

- **Scope.** The vault, the export window and the vault record check stop assuming `#google#`: they compute the path
  from `get_identity` on the vault's own RPC; link banners from `get_account`; `hana.account()` and `linkChanged`.
  Every Google user is unlinked, so every path stays today's.
- **Tests.** Golden-path tests (unlinked Google identity → today's path, byte for byte) in web unit tests; existing
  Playwright suite unchanged.
- **User-visible.** Nothing changes for existing users (no links exist yet).

### Batch 8: web, email login and linking

- **Scope.** The popup method chooser, `/login/email` (its own CSP with `connect-src` to the issuer), the Google
  `email` scope and access-token relay (or the spike's fallback), `google-match` before any chain call, the four cases'
  screens (silent Google-hosted case A, "Link and continue" / "Sign in with {the other method}", the pending banner and
  Cancel), `hana.login({ method, emailHint })`, `hana.linkAccount({ method })`, the new errors and progress events;
  Playwright in three browsers with the `outbox` stub (the spec's flows).
- **Deploy.** Turn email on (D1 `login_methods`) for sandbox-dev's test apps only; measure email-login latency and gas
  of each new call on testnet (spec "Testnet").
- **User-visible.** Email login and automatic linking on sandbox-dev apps that turn it on.

### Batch 9: admin and partner console views

- **Scope.** The spec's "Admin portal hooks (batch C)": the email issuer view, the links view, the partner email toggle
  (D1 setting plus the on-chain `AddClient`, removal through `remove_client`). Needs batch C's Workers; until then
  Hana staff enable email per app by hand (`operations.md`).
- **User-visible.** Partners can turn email on themselves.

### Batch 10: AWS KMS and mainnet readiness

- **Scope.** The dedicated AWS account, KMS `RSA_2048` primary and standby keys, IAM user and policies, CloudTrail
  to the log-archive account, EventBridge alerts, the hourly reconciliation job, `scripts/email-issuer.ts
  rotate-aws-key` and key thumbprints, `operations.md` steps; a staging rehearsal and the KMS p95 measurement.
- **User-visible.** Nothing (testnet keeps the Worker-secret key).

## Batch 1 result

(Filled in when batch 1 is done.)

## Open points for the user

(Filled in as batch 1 meets them: each is an ambiguity in the spec, the reading chosen and why.)
