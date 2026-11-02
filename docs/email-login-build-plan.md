# Email login build plan (batches)

**Status: batches 1 and 3 done (batch 1 merged into `develop`; batch 3 on `feat/email-login-3`, in review); neither deployed; batches 2 and 4–10 not done.** Splits `docs/email-login-spec.md` "Build order"
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
