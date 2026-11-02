# Email login build plan (batches)

**Status: batches 1–3 and 5 done and merged into `develop`; batch 4 (`apps/email-issuer`) done on `feat/email-login-4`, in review, not merged; none deployed; batches 6–10 not done.** Splits `docs/email-login-spec.md` "Build order"
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
- **Contract obligations (D133).** Every `auto_link` token's nonce carries the join the issuer decided: `join` (1 =
  the Google identity joins E's account, case A; 2 = E joins the Google identity's account, cases B/C), `joiner_ik`,
  `target_root_ik` and that account's epoch, all read from `get_identity` / `get_account` at minting (layout in
  `docs/contract-interface.md`). Unlinked pairs come from `get_account().unlinked`; a cancelled link still matches
  (D132).
- **Tests.** The spec's "Issuer" list (vitest with miniflare), including the log-capture test; the `auto_link` nonce
  against `contracts/hana-signer/src/email_fixture.json`'s worked examples.
- **Deploy.** The Worker may be deployed to sandbox-dev at `{apiUrl}/v1/email/*` once batch 6 sets the chain up; with
  no app's `login_methods` including email, no popup reaches it.
- **User-visible.** Nothing.

### Batch 5: watchdog

- **Scope.** The spec's "Watchdog": `watchdog.pinnedIssuerKeys.email` (signers and `required`), pinned and unpinned
  email key changes (cancel, `forged_key_change`), no confirm for self-issued keys, `updater_other_provider` unchanged
  for "self", active unpinned email key → pause and `forged_active_key`, `get_issuer("email")` and
  `get_self_issued("email")` diffed against the pins (pause on a weaker policy), Hana's JWKS compared with the pins
  (warning), the link-volume check from `identity_link_*` events, check ids and portal rendering (D83). Also
  (D139): a **critical** alert whenever `get_config().unrecorded_wallets` is `true` on an env that isn't a dev env
  (it may only be true on sandbox-dev between the v3 upgrade and `accept_unrecorded_wallets`; mainnet is created with
  `new` and must never show it), not only the runbook check.
- **Order.** Must be deployed to sandbox-dev **before** batch 6 posts the email keys, or the current watchdog's
  `unverifiable_key_change` alert fires for a legitimate change.
- **User-visible.** Nothing.

### Batch 6: API and sandbox-dev chain setup

- **Scope.** The spec's "API changes": the email `iss` in `ISSUER_PROVIDERS`; email tokens (JWS JSON) verified against
  `get_self_issued("email")` and the issuer's JWKS; `/v1/login` accepts and prechecks `linkJwt` and `linkImmediate`
  (recomputes the `auto_link` nonce with the join from its own chain reads, and verifies the session signature
  against the linked CKD payload, D133, so a malformed or swapped link is refused before gas is spent); the relay's
  `Links wait until the owner accepts…` and `Sign-in method is linked to an account` panics mapped to errors; the
  split path's `create_session` relay (`/v1/sessions`) passes the session key's proof of possession (`signature` over
  session_message(0, "hana-id-create-v1:" ‖ sha256(session nonce preimage)), D137; required by v3, so the API, `packages/web`'s split path and
  `apps/smoke/src/direct.ts` send it **before** the v3 upgrade lands; v2 ignores the extra field), and the API
  verifies it before relaying;
  `GET /v1/app` returns `loginMethods` and `email.aud`, `409 no_login_method`;
  relays `/v1/link`, `/v1/link/cancel`, `/v1/link/unlink` with share revocation; the session-pool allowlist gains the
  three link methods (keys deleted and re-added); attached gas from batch 2's measurement; D1 migration
  (`apps.login_methods` default `'google'`); usage counts.
- **Deploy (sandbox-dev), in order.** Watchdog pins live (batch 5) → contract v3 through the DAO
  (`upgrade-contract propose|execute`) → `accept_unrecorded_wallets()` by the owner (sandbox-dev's pre-v3 wallets are
  test data, D135; until then every link is refused) → `set_issuer("email", [iss])`, `mark_self_issued("email")`, two
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
- **Contract obligations (D133).** With a link, the vault verifies the link token's signatures against the on-chain
  email keys, recomputes its expected `auto_link` nonce (join, joiner, target root, epoch from its own RPC; mode as
  the issuer said and the popup showed), refuses on any mismatch, and only then signs the **linked CKD payload**
  (`"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode ‖ pk1 ‖ ":" ‖ pk2`) for counter 1; without a link it signs the
  plain payload. A session opened on an identity's own path is dropped once that identity is linked (derivation is
  refused, D136); the vault opens a new session instead.
- **Recovery rule (D137).** A session the vault meant to carry a link is never derived on with the plain payload. If
  the linked combined login fails `Session key already in use` (or any failure after the transaction was published),
  the vault revokes that session (`revoke_session`, counter 1, `"revoke"`) and restarts with a fresh session key, a
  fresh Google token and a fresh link token. Without a link, the existing "derive with counter `used + 1`" recovery
  stays.
- **Case B only after this popup's email step (D139).** The vault signs a linked payload with `join = 2` (the email
  identity joins the Google identity's account) only when this same popup ran the user's email-code step
  (`verify` → `linkTicket`) for this login and the link token's `sub` equals the `sub` of the address verified there
  (the issuer's `verify` answer). A case-B token offered during a plain Google login (no email step in this popup) is
  refused, so a compromised issuer service can't attach an email identity to a Google wallet by serving one. Case A
  (`join = 1`) is signed only for the Google-hosted silent rule or after the popup's own code step for that address.
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
  rotate-aws-key` and key thumbprints, `operations.md` steps; a staging rehearsal and the KMS p95 measurement. The
  mainnet runbook creates the signer with `new` on v3 and checks `get_config().unrecorded_wallets == false` (never
  `accept_unrecorded_wallets`, D135).
- **User-visible.** Nothing (testnet keeps the Worker-secret key).

## Batch 1 result

Branch `feat/email-login-1`, not deployed.

- **Code.** `contracts/hana-signer/src/self_issued.rs` (marking, signer policy, JWS signature checks, the
  `migrate`-only `set_signer_policy`), `links.rs` (identity keys, accounts, the four cases, `link_identity`,
  `cancel_link`, `unlink_identity`, views, nonces), `oidc.rs` (JWS General JSON parsing), `issuers.rs` (`signer`,
  self-issued rules, format dispatch), `sessions.rs` (path identity, `link_jwt` / `link_immediate`, `opened` at
  derivation), `migrate.rs` (v2 → v3, v3 → v3; `migrate_v1` now v1 → v3), events 1.2.0, `STATE_VERSION` 3.
  `scripts/lib/contract.ts`: `mark_self_issued` in `OWNER_METHODS`.
- **Security review (2026-10-30).** An independent review of ba45b91 reproduced one high, one medium and four low
  findings; all fixed on this branch with a regression test each that fails with its fix reverted (checked by
  mutation): the link bound by the session signature and the join in the `auto_link` nonce (HIGH-1, MEDIUM-1, D133),
  checked signer-policy keys (LOW-1) and no derivation for a linked identity's own path (LOW-2) (D136), email-only
  self-issuing (LOW-3, D134), links wait for the owner after a pre-v3 migration (LOW-4, D135), and the overlap choice
  for a signer-replacing upgrade (info, D136).
- **Second review (2026-10-30)** of e225d2e: HIGH-1, MEDIUM-1 and LOW-1..4 confirmed closed; new findings fixed on
  `feat/email-login-1-r2` as commits on top: a bare `create_session` needs the session key's proof of possession,
  bound to its session parameters after an automated review flagged a constant proof as replayable (N1, D137); a
  replacing signer policy needs new signer ids and cancels dropped signers' pending keys (N3, D138); vault and
  watchdog obligations (N1 recovery rule, N2 case-B signing, N4 alert; D137, D139).
- **Tests.** 293 unit tests (`cargo test`), 65 of them new in `src/tests/email.rs`, the 228 existing ones unchanged
  in substance (new optional arguments, event version, state version, `unrecorded_wallets` in `get_config`). Tokens: `scripts/gen-email-fixtures.mjs`
  (independent JS implementation of the identity key and the four link nonces, and JWS JSON tokens signed by Node's
  crypto) and `src/test_rsa.rs` (deterministic RSA test keys generated at test time, so no private key is committed).
  `src/v2_state_fixture.json` is storage written by the v2 code (develop d1837ec) for the migration tests.
- **Wasm.** `cargo near build non-reproducible-wasm`: 628.5 KB (v2 on develop: 520.5 KB).
- **Address safety.** Golden tests: the fixture's Google user opens `s1#google#1098765432#0`, `s2#…#0`, `s1#…#1` and
  `s3#…#0` (shared client), and the MPC request carries exactly that path; sessions written by v2 code keep their
  paths through `migrate` and derive with them; a fresh login after the migration gives the v2 path; every
  pre-existing test (which asserts paths and MPC requests) passes unchanged. The CKD request, nonce layouts, derivation
  v1 and the signer account are untouched.
- **Docs.** `contract-interface.md`, `security.md`, `architecture.md`, `email-login-spec.md` (review amendments), `decisions.md` (D130–D139); `contracts/integration-tests` sends the proof of possession.
- **Left for later batches.** Sandbox tests, gas measurements and deleting `migrate_v1` (batch 2); `packages/email`
  (3); the issuer (4); the watchdog (5); the API, relayer allowlist and sandbox-dev deployment (6); web (7, 8);
  consoles (9); KMS (10).

## Open points for the user

Each is a place where the spec was silent, ambiguous or (in one case) unsafe as written; batch 1 took the reading
shown. Recorded as D130 and D131 ("to confirm"; point 3 decided, D132). The security review's fixes (D133–D136) are
listed under "Batch 1 result"; the one choice in them that is yours to revisit is point 13. None changes an address.

1. **`opened` at derivation, not at `create_session` (D130).** The spec says every `create_session*` records it. A
   bare `create_session` with a copied Google token (public in the mempool, or in a failed login) would then mark the
   Google identity as having a wallet without anyone being able to derive it, and turn the user's case-A retry into
   "both have a wallet": a second wallet, which D122 forbids. Marking at derivation can't be forged. Same result for
   every real login.
2. **Delayed case A refused.** The spec says case A is "active now" and that the issuer sets `link_immediate` for it,
   but not what the contract does with `link_immediate = false` there. A pending case A would have to open the
   Google identity's own path (a second wallet), so the contract refuses it (`This link must be immediate`).
3. **Decided (user, 2026-10-30, D132): `cancel_link` does not mark the pair `unlinked`.** After a user cancels a
   pending case-B link, the next email login still sees the match and offers only "Link and continue" / "Sign in with
   Google" (never a second wallet). Test: `a_cancelled_automatic_link_still_matches`.
4. **`get_account` also returns `unlinked`** (hex keys): the issuer needs it to apply "an unlinked pair is not a
   match" before minting; the spec's view shape doesn't list it.
5. **Strict JWS JSON.** Unprotected headers, the flattened form, `crit` and duplicate members are refused; every
   signature in a token must verify and come from a counting signer, so an extra signature from a signer the policy
   doesn't list fails the token (rather than being ignored). The issuer must therefore add a co-signature only once the
   chain lists the co-signer (as the spec already says).
6. **One modulus per self-issued issuer.** The same RSA key can't be registered under two kids or two signers
   (`Key is already registered`), including by a future `migrate`, so one stolen key never counts as two signers. Not
   in the spec; no product effect.
7. **The updater key can't propose removals of email keys either** (the spec names `set_issuer_key`); and
   `mark_self_issued` refuses an issuer that already has keys or pending changes, and a second call; since the review, it accepts only `email` (D134).
8. **Self-issued key delay = `max(usual rule, now + governance_delay_ms)`**: when `issuer_key_delay_ms` is longer than
   the governance delay, the longer one wins.
9. **Panic text.** An unlisted kid keeps today's `Unknown signing key` (the spec writes `Unknown key`); new texts:
   `link_immediate needs a link_jwt`, `Only the root or the member itself can unlink`, `Link token must come from a
   self-issued issuer`, `Issuer already has keys`, `Issuer is already self-issued`, `Key is already registered`,
   `Duplicate signature kid`, `Too many signatures`, `Unsupported JWS header`, `Wrong token format for this issuer`,
   `Only the email issuer can be self-issued`, `Sign-in method is linked to an account`, `Links wait until the owner
   accepts the wallets opened before v3`.
10. **Lazy activation doesn't bump the epoch**, and account records are never deleted (so an epoch never restarts and
    old link proofs can't be replayed).
11. **Registering a new scope's email client in `admin_register_scope`** needs its aud `email:<scope_id>` before the
    contract assigns the id; Hana can predict it (`next_scope` is sequential) or add the client after registration
    through `propose_change(AddClient)` with an issuer client proof (spec "Issuer configuration"). The contract
    doesn't check that an email client's aud names its own scope (a mismatch only breaks that app's email login).
12. **Spec wording nit.** "Account already has a sign-in method of this kind" is applied to the root's provider too
    (an email identity can't join an email root), which the spec implies ("one per provider") but doesn't state.
13. **Review fixes that shape later batches.** The linked CKD payload has its own domain
    (`"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode ‖ pk1 ‖ ":" ‖ pk2`) rather than the reviewer's suffix on the
    plain payload, which a crafted `pk2` could collide with (D133); the vault (batch 8) and the API precheck (batch 6)
    sign and check exactly this. The pre-v3 wallet guard (D135) means sandbox-dev's v3 upgrade needs one more owner
    (council) call, `accept_unrecorded_wallets`, before any link works there.

## Batch 2 result

Branch `feat/email-login-2`, not deployed (sandbox only; no testnet transaction).

- **Sandbox tests.** `contracts/integration-tests/tests/email.rs` (new): the email issuer end to end with a local RSA
  key (`set_issuer`, `mark_self_issued`, an owner-posted key that the updater key can't post, a watchdog can't
  confirm and that waits `governance_delay_ms`; an email login whose CKD request carries `{scope}#email#{sub}#0`;
  refused token forms); automatic links (case A, case B at once and delayed, both-have-a-wallet, a link added to a
  plain signature refused) and explicit `link_identity` / `cancel_link` / `unlink_identity`: every login through a
  member derives the root's `big_y`, an unlinked member its own. `tests/governance.rs`: the **v2 → v3 upgrade through
  a 2-of-3 Sputnik DAO** from real v2 state built by the v2 wasm (`V2_COMMIT`), keeping every view (they only gain
  `get_config().unrecorded_wallets`), session, pending change and path, and the state no view shows (a removed
  client's quarantine, `pending_adds`, `next_scope`, the session queue; also in the unit migration test); it
  upgrades to the `--no-abi` artifact `deploy-contract` deploys; links wait for the DAO's
  `accept_unrecorded_wallets`; batch 6's email setup through the DAO and an email client by the scope owner; no way back
  to v2 code; login gas of v3 against v2. `tests/layouts.rs`: the email layouts of the test helpers against the JS
  worked examples (`email_fixture.json`), the session nonce hash computed from the session example. The access-key test now covers the v3 change methods (the session pool
  can't call the link methods yet; batch 6 adds them).
- **`V2_COMMIT` = develop 26fb70a** (the last develop commit before the v3 merge; its contract tree is the 0.1.1
  upgrade drill's, 90c39bd). Built as `deploy-contract` builds (`cargo near build non-reproducible-wasm --no-abi`) it
  **reproduces sandbox-dev's code hash** `3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz` on the machine that deployed
  it (the test prints the comparison; another machine embeds other cargo registry paths, so CI only reports it).
- **Removed.** `migrate_v1`, `HanaSignerV1`, `src/v1_state_fixture.json`, the v1 → v2 sandbox test and the v1-only
  unit tests (the v1 session-record test stays, built without the fixture). `deploy-contract` refuses a v1 contract
  instead of planning a migration that can no longer succeed (D154). Wasm: 621.8 KB (628.5 KB with `migrate_v1`).
- **Gas** (`docs/contract-interface.md` "Gas of the email login calls"), signer receipt, 2048- / 4096-bit keys: one
  RS256 verification ≈ 17–18 / ≈ 67 Tgas; a linked login 38.5 / 136.0 (≈ 59 / ≈ 156 needed with the MPC's 20, so the
  spec's 150 holds only at 2048 bits), `link_identity` 37.2 / 134.6, `cancel_link` / `unlink_identity` 19.8 / 68.5.
  Attach **250, 250 and 150** (D155, covering 4096 bits); at 4096 bits the plain logins also outgrow the API's 50 /
  100 (batch 6, or cap email keys at 2048 bits in a later contract: the alternative D155 offers). Owner setup calls ≈
  2–3 Tgas (`accept_unrecorded_wallets` through the DAO 1.9); `execute_upgrade` v2 → v3 100 Tgas (attach 300). No-link
  logins on v3 burn +0.3 to +0.6 Tgas over v2 (spec: +1–2).
- **Tests.** 290 unit tests (`cargo test`; 293 before, minus the three v1 migration tests), clippy clean; 33 sandbox
  tests (e2e 12, email 5 new, governance 10, layouts 7); `pnpm -r test` and `pnpm -r typecheck` green.
- **Address safety.** No path, nonce, layout or derivation changed; the sandbox checks Google paths unchanged across
  the upgrade and an unlinked email identity on `{scope}#email#{sub}#{key_index}`.
- **Docs.** `contract-interface.md` (gas table, upgrades, `migrate_v1` gone), `operations.md` (the v2 → v3 path with
  its prerequisites: the D137 proof of possession deployed and the batch 5 pins live; the v1 runbooks marked done), `architecture.md` (status), `README.md`, `envs/README.md`, `decisions.md` (D154, D155, to
  confirm).
- **Left for later batches.** The API's attached gas and the session pool's link methods (batch 6), testnet gas
  (batch 8); the API's never-relay list still names `migrate_v1` (harmless, D154). Batch 6's plan and the spec call
  the upgrade command `upgrade-contract propose|execute`; the script is `deploy-contract <env> --upgrade` (left as
  written: they are history).

## Batch 3 result

Branch `feat/email-login-3`, not merged, nothing deployed; nothing imports the package yet (the issuer, batch 4, will).

- **Code.** `packages/email` (`@hana-id/email`): `normalizeEmail` / `normalizeDomain` / `isNormalizedEmail`,
  `emailSub` / `importSubKey` / `subMessage` / `isEmailSub` (`K_sub` always an input), `isGoogleHosted` (needs
  `emailVerified: true`), `isDisposableDomain` / `disposableDomains`, the frozen `EMAIL_V1` constants. Web Crypto
  only, no lookbehind or Unicode property regexes. The issuer must send codes to the normalized address, byte for
  byte (package README).
- **IDNA.** `tr46` 7.0.0 (UTS #46 revision 36, Unicode 18.0.0), pinned exactly, every check on, non-transitional;
  the platform `URL` parser was rejected for its unpinned Unicode version and looser flags. Code points assigned
  after Unicode 15.0 are refused from a vendored, hash-pinned table built from `DerivedAge-18.0.0.txt`, so the
  runtime's NFC data never decides an address (review M1; D156).
- **Disposable list.** `disposable-email-domains/disposable-email-domains` at `e4f0910adf5a` (2026-10-23), 9927
  domains, vendored byte for byte with its sha256 checked; parents match (D157); `gmail.com`, `googlemail.com`,
  `google.com` guarded off it through one module shared by the test and the update script, which also refuses
  upstream commits younger than 7 days.
- **Vectors.** `vectors/email-v1.json` from `scripts/gen-vectors.mjs`, an independent implementation (Node's
  `domainToASCII`, its own syntax rules, `node:crypto`; it shares only the Unicode age data): 43 normalization, 53
  rejection and 26 `sub` vectors with a public test key. The guard test pins the file's sha256, the `EMAIL_V1` hash,
  the Unicode table's hash and the installed `tr46` / `punycode` versions. The vectors were regenerated once during
  review (`--force`, before any deploy: no sandbox-dev email user exists). 207 tests in Node (including a bare V8
  run of the browser bundle) and 99 in workerd (`@cloudflare/vitest-plugin`). Google's help pages for the Gmail
  canonical form are cited in the guard (Q7).
- **Address impact.** This batch defines every email user's `sub` (frozen at the address freeze). The stricter
  readings taken where the spec was open are D156 (normalization, the Unicode 15.0 cutoff) and D159 (Gmail rule as
  cited); D157 and D158 (disposable matching, the Google-hosted rule) change no address. All four wait for the
  user's confirmation.
- **Open for the user.** No current Google help page states that `googlemail.com` is the same mailbox; Gmail address
  changes leave the old address as a receiving alternate (two email identities for one person; D159).
- **Lockfile.** `pnpm install` (pnpm 11.3.0) also added three `deprecated:` lines for unrelated, already-locked
  packages to `pnpm-lock.yaml`; metadata only, no version changed.
- **Docs.** `architecture.md` (Status, Components), `README.md` (index), `decisions.md` (D156–D159),
  `packages/email/README.md`.

## Batch 4 result

Branch `feat/email-login-4`, not merged, nothing deployed, no secret uploaded, no testnet transaction.

- **Worker.** `apps/email-issuer`: `POST /v1/email/start`, `resend`, `verify`, `google-match`, `admin/client-proof`
  and `admin/unlock` (Cloudflare Access + the issuer's own staff allowlist, audited), `webhooks/sendgrid` (signed events → suppressions);
  `GET /v1/email/jwks.json` and `/.well-known/openid-configuration`. Durable Objects `Challenge` (`EMAIL_CHALLENGE`),
  `RateLimiter`, and `Outbox` (`local*` only). Its own D1 (`email_issuance`, `email_hints`, `email_suppressions`,
  `email_admin_audit`); the API's D1 read only for `apps` and `plans` (`login_methods` is batch 6's column: until then
  email is off for every app). Tokens: JWS General JSON, claims exactly `iss aud sub iat exp nonce jti`, every nonce
  computed by the issuer (matching the contract's worked examples, `email_fixture.json` and `test_fixture.json`), each
  signature self-checked against the published key, an `email_issuance` row before signing. `sub` only through
  `@hana-id/email` (`+tag` kept, D159 as amended); mail to the normalized address.
- **Limits (D198)**, all exact and each decision one atomic Durable Object call: code mails 3 per 15 min and 10 per day
  per (mailbox, requester), 10 per 15 min and 30 per day per mailbox plus a reserve of 5 a day for requesters new to it;
  5 live and 35 created challenges per mailbox per day; 5 attempts per challenge; 10 wrong per hour per (mailbox,
  requester) → 1 h lock; a hard ceiling of 25 failed checks per mailbox per UTC day (backstop 18 + owner slot 4 +
  ticket slot 3; ≈ 0.91% a year); per IP `start` 10 per 10 min and 50 per day, and 200 a day per IPv4 /24, IPv6 /56
  and /48; `verify` 30, `resend` 10, `google-match` 30, webhook 120 per 10 min; per recipient domain 100 code mails a
  day (consumer providers exempt); per app plan `per_minute` per minute and plan `per_day` per day; staff 20 actions
  an hour (shared); a global daily send budget (`dailySendBudget`, default 1000), at most 10% per app and the last 20%
  only for apps under half their share. Mailbox = the address without its `+tag`; suppressions per exact address.
  Every mailbox-level refusal is the same 429 with `retry-after: 900`; suppressed addresses take the same path
  silently. Accepted trade-off (D198, to confirm): a mailbox under a sustained guessing attack is locked until
  midnight UTC for anyone without a device ticket; the trip is logged (`mailbox_guess_limit`) and staff can lift it
  with `admin/unlock`.
- **Sender.** SendGrid v3 Mail Send (D194): a send counts only on `202`; tracking off; response bodies read ≤ 4 KB and
  never logged; `SENDGRID_API_KEY` Mail Send only, the issuer's alone. The `outbox` stub (a test-only Durable Object)
  only in `local*` envs (schema and `gen` refuse it elsewhere). The interface (`src/sender.ts`) is one method.
- **Signers.** Worker-secret RSA (testnet); the KMS adapter (`src/kms.ts`, aws4fetch 1.0.20, `DIGEST`,
  `RSASSA_PKCS1_V1_5_SHA_256`, no retries, error mapping) tested against a fake KMS (SigV4 checked against an
  independent implementation, byte-for-byte parity with the Worker-secret signer) and wired to no env (`gen` refuses
  `aws-kms`). Two-signature tokens tested.
- **Manifest and tooling.** `emailIssuer` in `packages/env` (D196; `worker-secret` testnet only, `outbox` `local*`
  only, kid = RFC 7638 thumbprint); `apps/email-issuer/scripts/gen-wrangler.ts` (and `--dev-vars`);
  `scripts/email-issuer.ts init | put | show` (init writes `.secrets/<env>/email-*` 0600 and the manifest block and
  uploads nothing; `put` is the user's upload; the standby never leaves `.secrets`). `packages/jwks` gains
  `rsaThumbprint`, byte for byte batch 5's hunk, so the two branches merge cleanly. `.gitleaks.toml` covers the new
  secret names, files and RSA private JWKs (self-test cases added).
- **Security review.** The first build had a check-then-count race in `verify` (a lock checked in one object, counted
  after the comparison), per-address limits that let anyone lock an address's owner out, suppressions keyed too
  widely, an owner exemption that gave one more guess per fresh IP, a stale trip marker after a refunded check, and a
  challenge cap never refunded on failed paths. All fixed before this result, with tests (parallel guesses, many
  requesters, the ceiling, the owner slot, suppressed-address parity, the refunds, the unlock); D197–D199.
- **Review fixes** (two independent reviews, after the security review; defaults to confirm in D194, D158 and
  D197–D199): the budget's per-app shares and reserve, the IP prefix and recipient-domain caps, `email_budget` and
  `email_complaint_rate` logs, the per-app limit at plan `per_minute`, the requester-pays order in `start`; owner
  device tickets (30 days, 3 code mails a day, the ticket slot) and unlock grants bound to a one-time `unlockToken`;
per-prefix shares (20%) of a domain's day, ticketed starts exempt, `email_domain_cap`; staff routes JSON-only, `Origin`
  refused, a support `ticket` in every audit row written before acting, unlock and the new `admin/unsuppress` capped
  per mailbox; the webhook's category filter, 30-day bounce expiry, header checks before the body, cached key, per-IP
  limit; suppressions keyed by K_sup (from K_sub); the challenge's address encrypted under the client-held half of the
  challengeId; `missing_client_ip` refused; uniform `retry-after`; Access negative cache; per-purpose mail texts; case
  B's `idToken` withheld (hints still for every verified address, D119; a non-hosted one only within 180 days), link tickets bound to the hinted Google identities;
  client proofs at the scope's current `action_nonce` with an email app; `email-issuer <env> put --standby` and the
  exact key-leak runbook; issuer-minted tokens checked in the real contract (`contracts/hana-signer` tests only, 4
  tests, `issuer_tokens_fixture.json`); gitleaks `hana-private-jwk` also matches an unquoted `d: '…'`.
- **Abuse re-check fixes** (D198, D199, to confirm): an owner budget pool (finally 1 × the budget beside it, no per-app cap, past 50% only tickets ≥ 7 days old and grants) and plan-sized app shares,
  `dailySendBudget` required outside `local*` (`init --budget`); a domain cap that grows with verified logins and gives
  a verified challenge's places back, more exempt providers; ticket and grant checked before the prefix limits (raised
  to 1000 a day) and skipping every shared pool; `admin/unlock` and `admin/unsuppress` mail the address instead of
  answering staff, unlock clears nothing and adds a grant slot of 2 (0.92% a year with unlocks), `POST
  /v1/email/confirm`; device tickets per exact address with a nonce, per-ticket allowances and staff revocation; a
  deterministic contract fixture with a regeneration test. Then the scan of the re-check: owner allowances per exact
  address, ≤ 5 live tickets per address and ≤ 10 ticket challenges per address a day, a staff mail pool, the effective owner kind on resend, a domain cap from distinct verified mailboxes with
  a 2,000 ceiling.
- **Tests.** apps/email-issuer: 115 Worker tests (miniflare: layouts against the contract fixtures, codes,
  limits and the ceiling, google-match's four cases, signers and KMS, adapters, the log-capture test) and 7 node tests (`gen`, the fixture);
  packages/env +11 (`emailIssuer`), packages/jwks +3 (`rsaThumbprint`), scripts +10 (`email-issuer`) and 6 secret-scan
  self-test cases; hana-signer +4 (`tests/email/issuer_tokens.rs`, 303 in all); `pnpm -r test` and `pnpm -r typecheck` green. Existing tests broken on `develop` by the identity-token deploy
  (`envs/sandbox-dev.json` gained `identityToken`, whose `iss` pins `apiUrl` and whose signer says `worker-secret`)
  are fixed test-only: `packages/env` `endpoints`, `origins`, `dashboard`; `apps/api` `scripts/test/gen-wrangler` and
  `pages-wrangler`; `packages/web` `gen-envs` (drop that block where they rewrite `apiUrl`); `scripts` `ckd` (the
  needle `key=secret` instead of the bare word).
- **Decisions.** D195 (case A's code challenge prepared by google-match), D196 (manifest, standby off the Worker),
  D197 (10-minute challenges), D198 (the limits and the guess ceiling, with the worst-case formula), D199 (HTTP, data
  and chain readings), all to confirm.
- **Follow-ups from the final review** (for the batches named):
  - batch 8: the `{authOrigin}/email/unlock#…` and `/email/confirm#…` pages ask for a click before they POST the token
    (a mail scanner that opens links must not spend it);
  - batch 9: alerts on `email_domain_cap`, `email_owner_pool`, `email_budget`, `send_budget_exhausted` and
    `mailbox_guess_limit`;
  - batch 6: the issuer reads apps by `apps.publishable_key`; after batch C3's migration 0006 it should read the gate's
    `app_keys` (rotated keys) and skip soft-deleted apps;
  - the remaining items of that review's follow-up list (1, 2, 3, 5) as the coordinator records them; this branch
    did item 4 (ticket challenges per address, not per mailbox).
- **Not done here.** The CloudTrail reconciliation job (batch 10, with KMS); routing `{apiUrl}/v1/email/*` to the
  Worker (batch 6: on `workers.dev` a service binding from the API, which would put addresses and codes through the
  API Worker's memory, D199); the alert and admin view for `send_budget_exhausted` and `mailbox_guess_limit` (batch 9);
  a `switch`/`retire` command for email keys (batch 10).
- **Lockfile.** Adding `aws4fetch` also changed peer-resolution strings of already-locked `@walletconnect` packages
  (`apps/e2e`), where it is an optional peer; no version changed.
- **User-visible.** Nothing.

## Batch 5 result

Branch `feat/email-login-5`, not deployed (no transactions sent).

- **Code.** `apps/watchdog`: `src/pins.ts` (pin parsing, the per-key verdict by RFC 7638 thumbprint, kid and signer,
  the signer-policy findings), `src/links.ts` (the link-event source: FastNear's transactions API, `EVENT_JSON` logs
  of receipts the signer executed that succeeded), `run.ts` (pending and active email keys, the policy check and its
  pause, Hana's JWKS, links and `unrecorded_wallets`; a shared `forgedActive` for Google and email; partial
  evaluation so an email-only judgement never resolves a Google alert), `near.ts` (reads `get_issuer` /
  `get_issuer_keys` for `email` and `get_self_issued("email")`; a missing view is "no email issuer"), `diff.ts`
  (`email_issuer`, `email_issuer_keys`, `email_signer_policy`, `unrecorded_wallets`), `status.ts` (`email`,
  `link_volume`), migration `0002_link_events.sql`, `gen-wrangler` (`EMAIL_PINS`, `EMAIL_JWKS_URL`,
  `LINK_INDEXER_URL`, `LINK_VOLUME`). `packages/jwks`: `rsaThumbprint`. `packages/env`: `watchdog.pinnedIssuerKeys.email`
  and `watchdog.linkVolume`. `envs/sandbox-dev.json`: `linkVolume.indexerUrl` only; no pins (batch 4 creates the key).
- **Registry.** Checks `signer_policy`, `email_jwks`, `links`. Alert kinds: critical `signer_policy_mismatch` (pause
  when weaker), critical `unrecorded_wallets` (alert only), warning `email_jwks_mismatch`, `link_volume_high`,
  `link_events_unavailable`, info `self_issued_key_change`; `forged_key_change` and `forged_active_key` now also cover
  email keys. Each new kind has a playbook (`signer-policy-mismatch`, `unrecorded-wallets`, `email-jwks-mismatch`,
  `link-volume`, `self-issued-key-change`); `docs/playbooks.md` regenerated.
- **v2 contract (sandbox-dev today).** Reads as "no email issuer" (no `get_self_issued`, `get_issuer("email")` null,
  no `unrecorded_wallets`): no alert with or without pins, no link scan; tested in `near.test.ts` and `email.test.ts`.
  The upgrade to v3 shows as one `governance_change` (`state_version`, `unrecorded_wallets`).
- **Tests.** Watchdog 222 Worker tests (166 before; `email.test.ts`, `links.test.ts`, and v2/v3 reads in
  `near.test.ts`) and 25 script tests (21 before); `packages/env` 91 (86), `packages/jwks` 8 (5). D153 and every
  earlier rule unchanged (the existing tests pass as they were, plus a D153 run beside a live email issuer).
- **Decisions (to confirm).** D190 (absent pins = nothing pinned; a pin is thumbprint + kid + signer; pins apply at
  the first run; JWKS warning only), D191 (what "weaker" means and the pin order around a policy upgrade, which
  differs from the spec's "adds `required: 2` before its upgrade executes"), D192 (link volume through an indexer,
  detection only, provisional 20 per scope / 100 in all per hour), D193 (the `unrecorded_wallets` alert and the
  email issuer in the governance diff).
- **Deploy order (batch 6).** Pins in `envs/sandbox-dev.json` (the issuer's thumbprints from batch 4) → watchdog
  `gen`, D1 migration 0002, deploy → `/status` `email.pinned` → only then the contract v3 upgrade and the email issuer
  setup. Between `set_issuer` and `mark_self_issued` a `signer_policy_mismatch` (alert only) is expected.
- **Docs.** `apps/watchdog/README.md`, `docs/operations.md` (alerts runbook table, "Email login: pins, link volume,
  unrecorded wallets"), `docs/security.md`, `docs/architecture.md`, `envs/README.md`, `docs/decisions.md`.
- **Review fixes (2026-11-02, after `origin/develop` was merged in).** H1: Hana's email JWKS is read after every
  protective step, the first delivery and the heartbeat, guarded; every third-party body (both JWKS, RPC, indexer) is
  size-capped (`src/http.ts`). M1: the link check runs last, guarded (a throw gives `degraded`, never `error`), skipped
  in runs with protective actions; ids, events and bodies bounded. M2: a full page inside one block holds the cursor
  before it and warns `link_events_unavailable:truncated`. M3: an overlap longer than the contract's 10 min + 5 min is
  weaker (pause), any overlap is reported, and `email_signer_policy` includes it. L1 `bad_material`; L2 the indexer's
  head clamped to the RPC's final block, future events dropped; L4 critical `pins_invalid` and reason
  `pins_unreadable`; L5 warning `signer_policy_transition` for planned transitions; L6 `Map` counts; L7
  `pnpm --filter @hana-id/watchdog pin`; L8 an indexer of another network refused by the schema, and
  `pending_key_changes` stays ok when email was judged without Google's JWKS. D190–D192 amended; D191 states that it
  overrides spec line 867.
- **Re-review fixes.** The run is recorded and its lock released before the advisory checks (Hana's JWKS, the link
  scan), which then resolve only their own kinds and update the run's record (a CPU kill there can't skip the next
  run); the indexer's answers share a 1 MB budget per run; pages of 200; a block no scan can read whole is skipped
  with a critical `link_block_unscanned` open for a week instead of stalling the scan; `unrecorded_wallets` now
  belongs to `governance_diff`; `pin` accepts a PEM with leading text (openssl "Bag Attributes").
- **D200 (link counter in the contract) replaces the link scan.** Everything above about the FastNear indexer,
  `links.ts`, migration `0002_link_events.sql` (never applied, deleted), `watchdog.linkVolume`, `link_events_unavailable`,
  `link_block_unscanned` and the advisory link phase is removed. The watchdog reads `get_link_stats()` (built on
  `feat/link-cap`) with the chain snapshot, in the protective phase: critical `link_threshold_reached` per flagged scope
  and for the total, keyed by window, for the current and the previous hour (no pause); warning
  `link_volume_high` at half `total_per_hour`; warning `link_stats_unavailable` when an email issuer exists and the
  view doesn't. A threshold raise (`link_thresholds` up, a `pending_thresholds` raise) is a critical governance change, lowering
  a warning. Playbook `link-volume` (rewritten for the D200 alarm). The advisory phase now holds only Hana's email JWKS read. D190,
  D191 and D193 are confirmed by the user; D192 is superseded by D200.
- **Alarm, not cap (the user's choice, 2026-11-02).** The contract counts links and the watchdog alarms; nothing is
  refused. The view is `{window_ms, thresholds, pending_thresholds, links_total, current, previous}` with windows
  `{window_start_ms, total, total_threshold_reached, flagged_scopes, flagged_scopes_truncated?}`; the setter is
  `set_link_thresholds`. The watchdog's kind is `link_threshold_reached` (critical; its text says the links went
  through), `link_volume_high` stays at half the total threshold, unreadable stats still leave open alerts open, the
  diff reports `link_thresholds` / `pending_thresholds` (raised critical, lowered warning), and the playbook is
  `link-volume` (launch check; on a suspected compromise pause and rotate the email key; a threshold change only if
  the alarm level is wrong for real traffic). With a stolen email key alone a thief can also log into email-rooted wallets, and into Google wallets that already have an email member, without making any link: the counter can't see that; the defence is the key's custody (D121).
- **Left open.** The thresholds are provisional until sandbox-dev and staging traffic (D200), and the watchdog's
  `get_link_stats` shape must match `feat/link-cap` when it merges (a mismatch marks only the link check). The
  `set_link_thresholds` owner call isn't in `scripts/lib/contract.ts` `OWNER_METHODS` yet (the link-cap branch adds it).
  The admin portal's rendering of the new checks and kinds is batch C/9 (the registry and `/status` carry them).
