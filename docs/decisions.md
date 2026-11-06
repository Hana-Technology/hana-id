# Decision log

One entry per decision: what was decided, when, why, what was rejected, its status, and where it is written down.
Last verified against code: 2026-10-28 (commit 58edee9); D432 (branch `feat/issuer-readonly-rpc`, readiness row 7.1d: the issuer's read-only `IssuerRpc`, decided while building, to confirm) on 2026-11-06, superseding D251, with a row of "Superseded or amended"; D425 (branch `feat/admin-system-status`, asked for by the user, the checks and thresholds to confirm with the screenshots, extending D420) on 2026-11-06; D424 (branch `fix/session-expiry-ux`, asked for by the user, design choices to confirm, extending D420 and D421) on 2026-11-06; D423 (branch `chore/verify-parallel`, asked for by the user, amending D413, with a row of "Superseded or amended") on 2026-11-06; D422 (branch `fix/google-key-hysteresis`, proposed by the assistant and approved by the user, amending D153 and the JWKS cron's removal grace, with a row of "Superseded or amended") on 2026-11-06; D421 (branch `feat/console-ux-redesign`, asked for by the user, design choices to confirm) on 2026-11-06; D420 (branch `feat/admin-ux-redesign`, asked for by the user, design choices to confirm) on 2026-11-06; D419 (branch `feat/env-alert-label`, asked for by the user, implementation choices to confirm) on 2026-11-06; D418 (branch `fix/hyperdrive-account-id-hint`, decided by the user, C16 after the pilot) on 2026-11-06; D417 (branch `docs/personal-account-free-tier`, decided by the user) on 2026-11-06; D416 (branch `feat/console-remove-audience`, decided while building, to confirm) on 2026-11-06, extending D238; D415 (branch `docs/auto-deploy-intent`, decided by the user, intent only, not built) on 2026-11-06; D414 (branch `feat/m4-personal-account`, decided by the user) on 2026-11-05, amending D404, with a row of "Superseded or amended"; D401 amended (branch `fix/sendgrid-suppression`: alerts and blocking notices bypass SendGrid's suppression lists, a security review fix) on 2026-11-05; D401 (branch `feat/sandbox-dev-dashboard-blocks`, asked for by the user: SendGrid for every Hana email; the isolate memo to confirm) and D402 (same branch, agreed by the user: sandbox-dev's 1-day statement lock) on 2026-11-05, amending D87, D279, D308 and settling D194's open point, with rows of "Superseded or amended"; D413 (branch `feat/local-verify`, asked for by the user, confirmed by the user) on 2026-11-05, amending D387, with a row of "Superseded or amended"; D410 and D412 (branch `fix/security-review-1105`: a security review's fixes, to confirm) on 2026-11-05, amending D224, D391, D392, D396, D399 and D403, with two rows of "Superseded or amended"; D411 (branch `docs/email-sharing-decisions`, decided by the user, not built) on 2026-11-05, amending D127's email questions, with a row of "Superseded or amended"; D404 (branch `feat/account-migration`: testnet's move to company accounts decided by the user, the custom-domain placements, `cloudflare.accountId`, `env-secrets`, `d1-move`, `issuer:iss` and the runbook to confirm) on 2026-11-05, amending D230, with a row of "Superseded or amended"; D406 (branch `feat/deploy-check-all-workers`, asked for by the user, implementation choices to confirm) on 2026-11-05, amending D384, with a row of "Superseded or amended"; D409 (branch `feat/access-setup`, decided by the user, implementation choices to confirm) on 2026-11-05, amending D88 for `sandbox*` and D284, with a row of "Superseded or amended"; D405 (branch `feat/sdk-error-request-id`, C15's follow-up, the API request ID in the SDK's errors: decided while building, to confirm) on 2026-11-05, extending D393; D408 (branch `docs/zero-trust-free-guard`, decided by the user) on 2026-11-05; D403 (branch `fix/usage-setup-neon-api-passwords`, decided by the user, implementation choices to confirm) on 2026-11-05, amending D224, with a row of "Superseded or amended"; D400 (branch `fix/popup-signal-before-navigate`, decided while fixing what D398 found, to confirm) on 2026-11-05, amending D347 and resolving D398's "Found while testing", with a row of "Superseded or amended"; D399 (branch `feat/batch-c-15-screen`, the Support ID lookup's screen: decided while building, to confirm) on 2026-11-05, amending D396 and D392, with rows of "Superseded or amended"; D398 (branch `fix/popup-early-close-deadline`, asked for by the user) on 2026-11-05, amending D347, with a row of "Superseded or amended"; D387 (branch `chore/ci-cost`, decided by the user) on 2026-11-05, amending D382 and D383, with a row of "Superseded or amended"; D394–D397, D393 (branch `feat/batch-c-15`, the Support ID lookup and the SDK gate: decided while building, to confirm; D386 (branch `feat/coop-canary`, agreed by the user) on 2026-11-05, amending D347, with a row of "Superseded or amended"; D385 (branch `fix/webcrypto-linux-webkit`, decided while following up D381, to confirm) on 2026-11-05, with D381's addendum and a row of "Superseded or amended"; D384 (branch `feat/deploy-build-check`, asked for by the
user, implementation choices to confirm) on 2026-11-05; D383 (branch `chore/ci-cost`, asked for by the user) on 2026-11-05, amending D382, with a row of "Superseded or amended"; D382 (branch `chore/identity-probe-hourly`, confirmed by the user) on 2026-11-05, amending D210, with a row of "Superseded or amended"; D381 (branch `fix/e2e-flakes`, decided while fixing CI's Playwright
flakes, to confirm) on 2026-11-05; D380 (branch `fix/admin-cron-budget`, decided while
building, to confirm) on 2026-11-04, amending D280, D322 and D360, with a row of "Superseded or amended"; D347 and D348 (branch `fix/google-cancel-back-to-chooser`,
confirmed by the user) on 2026-11-04, amending D341; D341 (branch `fix/google-cancel-back-to-chooser`, confirmed
by the user) on 2026-11-04, with notes on D264, D270 and D273 and a row of "Superseded or amended"; D340 (branch `fix/dev-email-limits`) on 2026-11-04; D140–D141 and D150–D152 on 2026-10-30 (branches
`feat/batch-c-1`, `feat/playbook-gaps`); D130–D139 on 2026-10-30 (branches `feat/email-login-1`, `feat/email-login-1-r2`);
D154–D155 (branch `feat/email-login-2`) and D156–D159 (branch `feat/email-login-3`) on 2026-11-02; D159's `+tag`
change (branch `fix/email-plus-tags`) on 2026-11-02; D190–D193 (branch `feat/email-login-5`) and D200 (branches
`feat/link-cap`, `feat/email-login-5`) on 2026-11-02; D201–D203 (branch `feat/batch-c-2`) on 2026-11-02; D205–D209
(branch `feat/batch-c-3`, to confirm) on 2026-11-02. D235–D239 (branch `feat/batch-c-6`, to confirm) on 2026-11-02, with D237 and D239 amended by D277 (branch `feat/batch-c-6-merge`, C6 on current `develop`) on 2026-11-04. D215–D219 (branch `feat/identity-token-7`, to confirm) on
2026-11-02. D210–D214 (branch `feat/identity-token-8`, to confirm, amended after its review the same
day) on 2026-11-02. D230–D234, D250–D252 (branch `feat/email-login-6`, to confirm) on 2026-11-02, with batch 6 notes on D137,
D154, D155, D199 and D206. D263–D267 (the batch 8b review, branch `feat/email-login-8b`, to confirm) on 2026-11-03, with
notes on D42, D254 and D255; D263's operations and pin-read notes and D264's screen count (`EMAIL_CONSENT_ROUNDS`)
on 2026-11-03 (branch `fix/8b-rereview`). D240–D244 (branch `feat/batch-c-7`, to confirm) on 2026-11-02, re-checked
on 2026-11-04 after merging `develop` (branch `feat/batch-c-7-merge`). D278–D285 (branch `feat/batch-c-8`, decided while building, to confirm) on 2026-11-04. Status lines of D4, D33, D80–D82, D85–D87, D100, D120, D190, D191, D193 and D200, D123 Q3's
provider note, two "Superseded or amended" rows, the user-mail line under "Proposed", and the headings from D125 on, checked against `develop` @ 1c6a124 and what sandbox-dev runs (`docs/operations.md`) on
2026-11-02 (branch `docs/consistency-pass`); no decision changed. D220–D224 (branch `feat/batch-c-4`, to confirm) on
2026-11-02. D245–D249 (branch `feat/email-login-8a`, to confirm) on 2026-11-02. D253 (branch
`feat/scope-email-client-tool`, to confirm) on 2026-11-03. D254–D259 (branch `feat/email-login-8b`, to
confirm) on 2026-11-03, with batch 8b notes on D246 (lifted), D248 ("demo scopes only" lifted) and D249 (superseded).
D268 (branch `feat/export-copy`, confirmed by the user) on 2026-11-04, with the D111 row of "Superseded or amended".
D269's "Built" line on 2026-11-04 (branch `feat/user-emails`: the email-login write, `admin user:list` / `user:find`,
the screen text), with D269 notes on D96, D119, D230 and D264 and two rows of "Superseded or amended".
D270's status (the spike passed, switched on) on 2026-11-04 (branch `feat/token-first-on`), with notes on D254, D265
(its gate passed) and D273 (token_first in Playwright), the D254 row of "Superseded or amended" and D265's "to
confirm" line. D275–D276 (branch `docs/batch-c-users-support-id`: proposed, to confirm by the user, spec text only)
on 2026-11-04. D300–D308 (branch `feat/batch-c-11`: the files Worker and logos, decided while building, to confirm) on
2026-11-04, with D301 amending the order of C7's replaced-logo purge. D290–D297 (branch `feat/batch-c-9`, partner
sign-in: decided while building, to confirm) on 2026-11-04. D320–D329 (branch `feat/batch-c-12`: reports,
statements, settlement and the ledger's checks, decided while building, to confirm) on 2026-11-04. D346 (branch `feat/user-id-identity-sub`, confirmed by the
user) on 2026-11-04, with its amendments to D276, D312, D313, D315 and D316, and the security review's amendments to
D311, D313 and D317 (the wallet record's session signature). D370–D374 (branch `feat/console-reports-upgrades`: the
partner console's usage, statement and pending-upgrades screens, decided while building, to confirm) on 2026-11-04. D360–D369 (branch
`feat/batch-c-13`: retention and the erasure path, decided while building, to confirm) on 2026-11-04, with two rows of
"Superseded or amended".

Consolidated from `docs/context.md` ("Decisions", "Batch A.2 decisions", "Batch C decisions", "Testnet
measurements"), `docs/batch-a-spec.md` ("Decisions"), `docs/batch-a2-shared-client.md`, `docs/batch-b-spec.md`
("Decisions", "Confirmed by the user", answered questions) and decisions made in conversation with the user that were
not yet written down (source "conversation"). Dates marked "≤ 2026-10-26" come from the design conversation in
wend-widget-demo, before the repo existed. Status: **in force** (in the code), **confirmed** (decided, code in
progress or not started), **deferred**, **superseded**, **proposed** (in a draft spec, not confirmed).

## Product and scope

### D1. Name: Hana ID, repo `hana-id`, npm scope `@hana-id`
- Date ≤ 2026-10-26 · Status: in force (scope still to claim on npm) · Source: `docs/context.md` "Decisions"
- Why: `@hana` is taken on npm; `@hana-id` looked free.
- Rejected: `@hana`.

### D2. Target a production MVP: real users and real funds on mainnet
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; CLAUDE.md
- Decision: production standards and tests for every behaviour from the start. Path: testnet pilot (batches A, A.2,
  B and a testnet smoke test), then production MVP (final accounts and address freeze, external audit, upgrade
  governance, mainnet MPC, key export and rotation, monitoring, legal and Google brand verification).
- Rejected: a throwaway prototype.

### D3. Any app can integrate; Sodax is the first customer, not a special case
- Date ≤ 2026-10-26 · Status: in force (`@hana-id/sodax`: Stellar and EVM wallet-provider adapters) · Source:
  `docs/context.md` "Decisions"
- Decision: nothing customer-specific. The core SDK exposes standard interfaces (EIP-1193, Stellar Wallets Kit, raw
  sign); Sodax gets a thin optional adapter (`@hana-id/sodax`, `IStellarWalletProvider`). Pilot wallets on
  testnet-MPC keys are disposable.

### D4. Email login later, as its own trust decision
- Date ≤ 2026-10-26; confirmed 2026-10-30 · Status: confirmed by the user; partly built (contract v3, `packages/email` and
  the watchdog part merged, contract v3 not deployed; the email issuer not merged), before mainnet · Source:
  `docs/context.md` "Decisions"; `docs/batch-a-spec.md`; `docs/email-login-spec.md` "Confirmed by the user"
- Why: whoever signs email tokens can derive any email user's key. Batch A made the verifier provider-generic
  (`issuers.rs`) so email can be another issuer.
- Decision (2026-10-30): email login through a Hana-run issuer, no vendor (`apps/email-issuer`, its own Worker);
  6-digit codes, not magic links; `sub` = `"e1." ‖ b64url(HMAC-SHA256(K_sub, normalized address))`, frozen at the
  address freeze; per-scope `aud` `email:<scope_id>`; a self-issued provider: owner-posted keys only, governance
  delay, no early confirm, watchdog pins. Signing key and signer policy: D121. Linking: D119, D122. Other details:
  D123.
- Rejected: Auth0, Stytch, Firebase (each a trust root able to mint for any user, none fits the on-chain nonce and
  `sub` rules without a Hana server anyway; `docs/email-login-spec.md` "Vendors considered and rejected").

### D5. Throwaway accounts first; every account name in `envs/<env>.json`
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: no `*.testnet` name hard-coded outside manifests and tests (`packages/env`).
- Why: accounts are replaced before the address freeze; one manifest per env keeps code env-free.

### D6. NEAR account keys use ed25519, not ml-dsa-65
- Date 2026-10-26 · Status: in force · Source: conversation
- Decision: owner, signer and relayer full-access keys and every function-call key are ed25519.
- Why: post-quantum support in NEAR tooling is too new for now.
- Rejected: ml-dsa-65.

## Keys and derivation

### D7. CKD only; no per-transaction MPC signing
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/batch-a-spec.md` "Decisions"; `docs/context.md`
- Decision: the MPC derives a key per user once per login (CKD, domain 2); signing is local in the browser.
- Why: one MPC call per login instead of per signature; local signing takes ~0.25 ms.
- Rejected (removed in batch A): `sign_with_session`, `sign`, `on_verified`, `sign_target`, envelopes, the NEAR
  Auth/FastAuth router and per-chain MPC signing code.

### D8. `key_index` in the path, for rotation after a leak
- Date ≤ 2026-10-26; bound added 2026-10-27 · Status: in force · Source: `docs/batch-a-spec.md`; `docs/batch-b-spec.md`
  "Key rotation hooks"
- Decision: path = `{scope_id}#{provider}#{sub}#{key_index}`. The MVP uses 0 and partners can't set it.
  `key_index ≥ 2^31` is reserved and refused by the contract, API and SDK.
- Not built: the rotation flow itself.

### D9. Derivation v1: `hana-id/chain-keys/v1/extract` and `/expand`, no global recovery phrase
- Date 2026-10-28 (names and structure confirmed by the user; Q36) · Status: in force (`packages/core/src/derivation.ts`)
  · Source: `docs/batch-b-spec.md` "Confirmed by the user", "Derivation v1"
- Decision: one HKDF-Extract of S to PRK, then HKDF-Expand per `(namespace, curve, account)`; tuples
  `("stellar","ed25519")` and `("eip155","secp256k1")`; EVM key by FIPS 186-5 A.2.1 reduction of 48 bytes; export is
  a raw key per chain. Golden vectors and a guard test. This changed every provisional address (allowed before the
  freeze).
- Why: additive for new chains and accounts; the two suffixes make a salt/info swap impossible to miss.
- Rejected: the provisional one-shot HKDF with salt `hana-embed-ckd-v1`; a BIP-39 phrase; keeping S in the vault
  (R7: PRK only).

## Registry and isolation

### D10. Per-partner scope from the token's `(provider, aud)`, via a registry inside `hana-signer`
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: each partner app is a scope; the scope is part of the path, so one app can't derive another app's
  users' keys. A scope may hold several client IDs (web, iOS, Android). The registry is a module of `hana-signer`
  (`registry.rs`).
- Why: the PoC's global client-ID list let any listed app derive every user's key.
- Rejected: a global client list; a separate registry contract.

### D11. Self-serve-ready registry, closed for the pilot
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: `public_registration` is off and one-way; while off, Hana registers scopes (`admin_register_scope`).
  Client ownership is proven by a token for that client; adding clients and changing owners is owner-only and
  timelocked. Owners are NEAR accounts or Google identities. Hana can't move clients; suspension is API-side only.
- Why: self-serve needs client-ownership proofs that hold up; they prove less than they seem (see the contract's
  security notes).
- Amended by D12: Hana can stop logins to a shared-only scope by removing shared clients.

### D12. Shared Google client mode
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"; `docs/batch-a2-shared-client.md`
- Decision: besides its own client, an app can log in through Hana's shared clients (`sharedGoogleClientIds`,
  `set_shared_clients`, ≤ 5). The scope then comes from the session nonce, which commits to `scope_id`; the scope must
  have `allow_shared`. A client is shared or a scope's own, never both. Adding a shared client and enabling
  `allow_shared` are timelocked; removing and `disable_shared_login` are immediate.
- Why: partners can start without their own OAuth client (like Privy's default credentials) and keep per-app
  isolation. Forging a nonce only gets the forger their own key. The path has no client ID, so own and shared logins
  give the same address (Google `sub` confirmed stable across one project's clients, 2026-10-27, and across Cloud
  projects, 2026-10-28: D42).

### D13. Retired shared clients can never join a scope
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"
- Why: anyone able to load Hana's login page could mint tokens for a retired client with a nonce of their choosing.

### D14. Every nonce commits to the signer account; layouts checked twice
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"; `docs/contract-interface.md`
- Decision: all nonces start with borsh(signer account id); the session nonce also commits to `scope_id` and
  `max_uses`; session messages are `"hana-id-session-v1:" ‖ counter ‖ sha256(payload)`. Layouts are checked against an
  independent JS implementation (`gen-fixtures.mjs`) and in the sandbox.
- Why: no token replay across deployments; a front-runner can't change the scope or use cap.

### D15. Fresh deploy for A.2; batch B is a code upgrade
- Date 2026-10-26 (A.2), 2026-10-27 (B) · Status: in force · Source: `docs/context.md` "Batch A.2 decisions";
  `docs/contract-interface.md` "Changed in batch B"
- Why: A.2 changed the state layout; B changed no layout, path or state.

## Infrastructure and API

### D16. App config off-chain in D1; API on Cloudflare Workers and Durable Objects
- Date ≤ 2026-10-26 · Status: in force · Source: `docs/context.md` "Decisions"; `docs/batch-a-spec.md`
- Decision: publishable keys, origins, plans, suspension, usage in D1; one Durable Object per relayer key serialises
  nonces.
- Why: built-in DDoS and rate limiting, a free tier, no database credentials.

### D17. Stay on Cloudflare (Workers + DO + D1)
- Date 2026-10-27 · Status: in force · Source: `docs/context.md` "Batch C decisions" (plan doc review); conversation
- Decision: kept after comparing alternatives on security and cost for a cost-sensitive startup.
- Why: cheapest at every volume, DDoS included, no OS to patch, Durable Objects fit the nonce design. Infra is under
  1% of running cost; NEAR gas (~38–40 Tgas, ~$0.02 per login) is the bill, so the lever is fewer on-chain calls per
  login.
- Later: AWS KMS only for HSM-grade keys (email issuer). Revisit at D1 ~5 GB, an HSM or region requirement, or
  ~500 req/s per app.

### D18. No production env or Hana custom domain while in development; sandbox-dev on workers.dev
- Date 2026-10-27 · Status: deferred · Source: conversation; `docs/context.md` (latency notes)
- Decision: sandbox-dev runs on `*.tingtc.workers.dev` (personal account, free plan). The production env, a
  Hana-owned domain and Cloudflare account come later.
- Why: free-plan routing from Malaysia scatters requests to US/EU colos (also seen on a free custom zone); whether a
  paid zone fixes it can only be tested once a Hana domain exists, so that test is deferred too.

### D19. Two relayer key pools
- Date 2026-10-26 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions"
- Decision: session pool (`RELAYER_KEYS`) and owner pool (`OWNER_RELAYER_KEYS`, small allowance), separate keys and
  Durable Objects, per-method gas. `deploy-contract` treats a wrong receiver, wrong or empty methods, or an unlimited
  or too-large allowance as a blocker.
- Why: abuse of `/v1/owner-actions` can't stop logins.

### D20. The API verifies before relaying
- Date 2026-10-26; derive precheck 2026-10-27 · Status: in force · Source: `docs/context.md` "Batch A.2 decisions",
  "Testnet measurements" (`fix/derive-precheck`)
- Decision: RS256, claims and nonce for sessions; Ed25519 session signatures; the scope check;
  `session_key_in_use`; and the contract's counter and `max_uses` rules mirrored off-chain (409 `counter_used`,
  `session_exhausted`, `counter_out_of_range`).
- Why: every relayed transaction is paid even when it fails (~2.2 Tgas for a rejected derive), and signed requests
  are public on chain, so anyone could replay them at Hana's cost.

### D21. Relayer latency design
- Date 2026-10-27 · Status: in force · Source: `docs/context.md` "Testnet measurements" (`perf/api-latency`,
  `perf/relay-dispatch`, `perf/relayer-cold-start`)
- Decision: answer at `EXECUTED_OPTIMISTIC`, not finality; run independent chain reads in parallel; reserve nonces 100
  at a time (one confirmed write per 100 relays, a restart skips ≤ 99); cold starts trust the stored reservation and
  block hash (< 5 min) with no chain read; pin shared Durable Objects with a location hint (sandbox-dev `apac`).
- Why: measured on testnet: the per-tx nonce write held every broadcast behind its storage confirmation, and idle
  objects (evicted after ~10 s) read the chain on every cold start.

## Batch B (SDK), confirmed by the user

### D22. Keep the wallet across reloads with a server-held share
- Date 2026-10-27 · Status: in force (`apps/api/src/vault/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Key persistence"
- Decision: per-app `persistence: 'session' | 'none'` (default `'session'`). In `'session'` mode the session has
  `max_uses = 1`; the browser stores PRK encrypted under `K_s`; the API returns `K_s` only for a signed, in-order,
  unexpired, unrevoked share request. Idle and absolute limits, revoke and revoke-all.
- Why: a Privy-like experience; and a reload costs nothing on chain instead of ~$0.02 and 6–9 s.
- Rejected: local AES-GCM of S with a session key that still has uses (R5: `derive_key` is permissionless, so the
  server limits would be bypassable on chain).

### D23. Approval popup by default; opt-in auto-approve policies
- Date 2026-10-27 · Status: in force (`packages/core/src/policy/`, `packages/web/src/vault/`) ·
  Source: `docs/batch-b-spec.md` "Confirmed by the user", "Auto-approve policies"
- Decision: every signature needs a guarded Approve in a Hana popup unless it matches a policy the app owner set
  (delayed) and the user accepted (bound to `policyId`). Off by default; two opt-ins. Batch B covers typed calls only
  (direct calls with typed address arguments, token approvals to listed contracts, listed Stellar `changeTrust`).
  Raw signing, `personal_sign`, `stellar_signMessage` and contract creation are never covered.
- Why: Privy offers a confirmation toggle and delegated-action policies; this is the equivalent without a
  server-side signer (the key exists only in the vault).
- Rejected: "partners can't turn approval off"; server-side delegated signing.

### D24. No protocol decoder in batch B; Sodax uses the popup
- Date 2026-10-27 (Q42) · Status: in force (empty decoder registry, `packages/core/src/policy/decoders.ts`) · Source:
  `docs/batch-b-spec.md` "Sodax needs a protocol decoder", Q42
- Decision: Sodax spoke calls carry intents in opaque bytes on EVM and Stellar, so no policy can check them. Batch B
  ships the `ProtocolDecoder` interface with an empty registry; a `sodax-intent-v1` decoder comes later on demand.
  `AssetManager.transfer`, `Connection.sendMessage` and `send_message` may never have `addressArgs: 'any'`.
- Why: an arbitrary `data` on a tiny deposit could empty the user's hub wallet; value limits don't bound that.

### D25. Google Workspace accounts are allowed; openid-only tokens
- Date 2026-10-28 · Status: confirmed, in force (`apps/api/src/claims.ts`, `packages/core/src/id-token.ts`) · Source:
  conversation; `docs/batch-b-spec.md` "Confirmed by the user", Q1, Q32
- Decision: Workspace users log in normally. The claim allow-list stays as a guard against Google adding claims.
- Why: the spike (`apps/smoke/spike.html`, Chrome) showed `scope=openid` tokens for both a personal and a Workspace
  account carry exactly `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no `hd`, email, name or picture. So
  blocking Workspace accounts is neither possible nor needed, and no domain or PII reaches the chain.
- Rejected: refusing tokens with `hd` (the spec's earlier position, which would have blocked Workspace users).
- Amended 2026-10-30 (email login, D119; not built): the on-chain Google token stays openid-only (allow-list
  unchanged, `token_has_pii` still refuses an ID token with `email`). The Hana login popup also requests Google's
  `email` scope and an access token; the email issuer reads the verified address and `hd` from Google's userinfo
  endpoint **transiently, off chain, at link time**, only to match a Google identity with the same person's email
  identity, keeps only HMACs of it (`sub` under `K_sub`, hints and limits under their own keys), revokes the access
  token, and never logs, stores or puts the address on chain. The consent screen shows the email permission. D120 is
  a separate, per-app opt-in.

### D26. One transaction per login, with a ship gate
- Date 2026-10-28 · Status: confirmed; contract, API and vault in force, not yet measured on testnet · Source:
  `docs/batch-b-spec.md` "Confirmed by the user"; `docs/contract-interface.md`
- Decision: `create_session_and_derive`, a literal composition of `create_session` and `derive_key` with counter 1,
  through `POST /v1/login`. If the 10-run testnet median saves less than 1.5 s, the method is removed before the
  audit and the split flow stays.
- Why: measured ~2 s of the ~8.9 s login is the second transaction.

### D27. Export proves freshness by a new login, not `auth_time`
- Date 2026-10-28 (Q33, spike) · Status: in force (`packages/web/src/auth/export-page.ts`) · Source:
  `docs/batch-b-spec.md` Q33
- Decision: export runs its own fresh login plus a typed confirmation; the `auth_time` check is off
  (`maxAuthAgeMs` unset, `packages/core/src/id-token.ts`).
- Why: with `max_age=0` Google returned no `auth_time`.

### D35. Message, typed-data and raw approvals bind no network; the popup says so
- Date 2026-10-28 · Status: in force (`packages/core/src/approval.ts`, `packages/web/src/auth/render-approval.ts`) ·
  Source: conversation (decided by the user); `docs/security.md` (k)
- Decision: the approval digest's `contextString` is the passphrase for Stellar transactions and auth entries, the
  chain ID for EVM transactions, and empty for `stellar_signMessage`, `personal_sign`, `eth_signTypedData_v4` and
  `hana_signRaw`. The approve popup shows "This signature isn't tied to one network." on message and raw requests;
  typed data shows its domain's chain (or warns that it names none).
- Why: these requests name no network of their own, and the vault never learns the dapp's selected EVM chain (the
  SDK answers `eth_chainId`), so there is nothing true to bind; showing a chain the signature isn't limited to would
  mislead.
- Rejected: binding the SDK's current chain (the vault can't verify it, and the signature is valid on every chain
  anyway).

### D36. The Approve guard arms per input type
- Date 2026-10-28 · Status: in force (`packages/web/src/auth/approve-guard.ts`) · Source: conversation (decided by
  the user); amends `docs/batch-b-spec.md` "Approval flow" step 5
- Decision: Approve and Allow stay disabled until 1 s after the request rendered, 1 s after the window last gained
  focus or became visible, and an arming gesture after both. Mouse: only a `pointermove` that moved arms (a press
  never does, and zero-movement synthetic moves are ignored). Touch and pen: a `pointerdown` arms. Keyboard: only
  Tab, Shift+Tab and the arrow keys arm; Enter, Space and auto-repeated keys never do. The arming gesture never
  approves: Approve acts only on a click whose own pointerdown (or non-repeated keydown) came after it. The page never
  focuses Approve.
- Amended 2026-10-28: a mouse move "moved" when its `movementX`/`movementY` is non-zero or, when
  both are 0, when **both** its client position and its screen position differ from the last pointer event's (move or
  press) recorded in the current request and focus period; every reset of the guard (a new request, a focus, a blur,
  nothing to approve) forgets that position, and missing or non-finite coordinates never arm. WebKit reports 0
  movement on every `pointermove` (found by the Playwright suite: Approve never armed in WebKit, so Safari mouse users
  could not approve). A real cursor move changes both positions; a layout change under a still cursor changes
  neither; a window move changes only the screen position; so neither of the last two arms, nor does the first
  zero-movement move (nothing to compare with). Hardened after a security review of the first version, which compared
  client coordinates only and kept the position across requests.
- Amended 2026-10-29: the screen position is no longer compared, only the client position (still reset on every
  guard reset). WebKit on Linux (CI) reports fixed screen coordinates, so Approve never armed there. The client
  position is what separates the threat: a layout change or scroll under a still cursor leaves it unchanged; it changes
  only when the cursor moves or the user moves the window under it (no other page can move the popup). The earlier
  note that a window move changes only the screen position was backwards.
- Why: the spec's `pointermove`-only rule never arms on a stationary tap or from the keyboard, so phone and
  keyboard-only users could not approve. Keeping mouse on `pointermove` means clicking in place never approves, and
  keeping Enter and Space out means a held key never approves.
- Residual risk (accepted): on a phone, someone tapping repeatedly for more than 1 s after the popup tab opens can
  still approve in two taps, if the second lands on Approve.
- Rejected: `pointermove` only (unusable on touch and keyboard); any `pointerdown` or `keydown` arming (the deviation
  first coded in `fbdb0ce`: mouse click-spam or a held Enter could approve in two events).

### D37. Auto-approve: fees count as spend; opaque arguments always need a decoder
- Date 2026-10-28 · Status: in force (`packages/core/src/policy/`) · Source: conversation
  (security findings (b)–(d), `docs/security.md` "Known open issues")
- Decision: on EVM, `value + maximum fee` counts against `maxValueWei` and `maxValueWeiPerDay` and is recorded as the
  day's spend (`maxFeeWei` still caps the fee alone). Arguments the address rule can't see into (`bytes`, `string`,
  `bytes20`+, exactly-160-bit integers; Soroban `Bytes`/`BytesN`/`String`) are never auto-approved under either
  `addressArgs` rule: such functions need a protocol decoder. `'any'` is also refused on execute/multicall-style
  names. Wider integers stay allowed as amounts.
- Why: the SDK fills gas and fees on the partner page, so an injected script could burn the native balance in fees on
  top of the value limit; under `'any'` a multicall or an `execute(…, bytes)` could carry a transfer to any address;
  a `uint160` is an address in integer form.
- Rejected: treating `uint256` as opaque (it is every amount); a validator check on Stellar argument types (a Stellar
  policy names functions only; the matcher checks each request instead).
- Consequences: a policy with `maxValueWei: "0"` no longer auto-approves EVM transactions; Permit2 typed data and
  Uniswap v3 calls (`uint160` fields) always get the popup until a decoder covers them.

## Batch C (dashboard), decided 2026-10-27

The batch C spec (`docs/batch-c-spec.md`) is a draft; only the entries below were decided with the user.

### D28. A developer dashboard like Privy's
- Date 2026-10-27 · Status: confirmed, not built · Source: `docs/context.md` "Batch C decisions"
- Decision: partners manage orgs, members, apps, origins, keys and on-chain owner actions (`/v1/owner-actions` with a
  console-client token). Replaces `admin app:*` after the pilot.

### D29. Invite-only sign-up
- Date 2026-10-27, reconfirmed 2026-10-28 · Status: confirmed, not built; amended by D89 (owners invite teammates
  too) · Source: `docs/context.md` "Batch C decisions"; conversation
- Decision: no public sign-up. A Hana admin issues email-bound, single-use, expiring invites (stored hashed); sign-in
  with Google through the console client; no accepted invite means refused. `public_registration` stays off.

### D30. Separate Hana admin console behind Cloudflare Access; billing-grade usage in D1
- Date 2026-10-27 · Status: confirmed, not built · Source: `docs/context.md` "Batch C decisions"
- Decision: contract-billing reports per org and app by day and month (logins, derives, MAU, new users, gas and USD,
  failures, latency), CSV statements. Billing-grade totals in D1; Analytics Engine (3 months) for operational metrics
  only.

### D31. Billing on hold; Sodax billed by service contract
- Date 2026-10-27, reconfirmed 2026-10-28 · Status: deferred · Source: `docs/context.md` "Batch C decisions";
  conversation
- Decision: no Stripe, plans or invoicing yet. Sodax is billed under its service contract from the monthly statement.

### D32. Allowed origins are security-critical in shared-login mode
- Date 2026-10-27; delay set 2026-10-28 (D34) · Status: confirmed, not built · Source: `docs/context.md` "Batch C
  decisions"
- Decision: origin changes need a fresh sign-in, are logged and email the other owners; they take effect after 24 h
  and can be cancelled meanwhile (D34).
- Why: in shared mode, origins decide which pages may embed the vault and get nonces for the scope.

## Pre-mainnet and batch C scope, decided 2026-10-28

### D33. Bound issuer-key and upgrade power before mainnet
- Date 2026-10-28 · Status: confirmed by the user; specced (`docs/governance-spec.md`), built, and on sandbox-dev since
  2026-10-30 (D80–D86); mainnet setup still to do · Source: `docs/security.md` open issue (e)
- Decision: a newly posted issuer key becomes usable only after a delay, during which an independent watchdog (own
  key, own service, checks Google's published JWKS) can cancel it; alert on any `issuer_key_set` for a kid Google
  doesn't publish; the owner account becomes a multisig; the signer account's full-access key is removed and
  upgrades go only through the owner multisig with a timelock and public notice. Later, optionally, k-of-n
  independent key posters.
- Why: today `KEYS_UPDATER_KEY` (a Worker secret), the owner account or the signer's full-access key can each forge
  Google tokens or swap the contract and so derive any user's key.
- Open: the delay length. Measure Google's key lead time first (record when each kid first appears in the JWKS);
  the watchdog may approve early when the key matches Google's list. No address change. Measurement is running
  (migration 0004 `issuer_key_observations`, 15-min cron; read with `admin <env> issuer-keys:lead-times --remote`,
  `docs/operations.md` "Issuer key lead times").
- 2026-10-29: specified in `docs/governance-spec.md`; delays D80 (mainnet issuer-key delay provisional until the
  lead-time measurement is in), multisig D81, watchdog D82–D83, no upgrade guardian D84, alerts D85, the rest D86.

### D34. Batch C MVP cut
- Date 2026-10-28 · Status: confirmed by the user · Source: batch C MVP trim proposal (to be folded into
  `docs/batch-c-spec.md`)
- Decision: keep three Workers and three D1s, the script-free auth origin, the server-side Google code flow,
  invite-only sign-up, origin safety (change-bound token, 24 h delay, notice, cancel), the on-chain watcher,
  settlement at FINAL, uid HMAC for MAU and the admin billing reports. Add the auto-approve policy editor (same path
  as origin changes; removal immediate). Simplify: two roles (owner, viewer), one fail-closed notice channel from the
  admin Worker, direct usage inserts with a daily nonce cross-check, on-demand reports with frozen monthly
  statements, compare-and-swap writes instead of the reconciler, publishable keys with a fixed 24 h grace. Defer:
  mandatory passkeys (required before a second partner joins), second-owner approval, Hana restore of revoked keys
  and removed origins, the partner app-request queue, secret keys, R2/AE copies, Stripe.
- Why: about 40% of the draft's size with every security property kept or its loss stated.
- Blocked on: a Hana Cloudflare account and zone, an email provider, Cloudflare Access with MFA.

### D38. Vault and auth popups on two registrable domains
- Date 2026-10-28 · Status: confirmed by the user; domain names not chosen · Source: `docs/batch-b-spec.md` "Origins
  and pages", `docs/security.md` (j)
- Decision: production `vaultOrigin` and `authOrigin` sit on different registrable domains. The auth domain is the only
  one users see (popup address bar), so it is an official, recognisable Hana domain; whether that is `hanawallet.io` or
  another domain is undecided. The vault domain is never shown and hosts nothing else.
- Why: desktop Chrome/Edge/Firefox guarantee separate processes per site, so content shown in the popups can't share a
  process with the vault's PRK. Costs one extra domain (~$12/yr); no code change, the schema already refuses a
  same-site pair outside `local*`/`sandbox*` envs.
- Rejected: one dedicated domain with `vault.`/`auth.` subdomains (matches Privy/Turnkey practice, origin isolation
  only); a separate user-visible auth domain that looks unofficial.
- Limits: no process guarantee on Chrome Android or WebKit. If the auth domain also hosts other Hana sites: no
  domain-wide cookies, restricted DNS zone access.

### D39. Test apps can't sign for mainnet chains
- Date 2026-10-28 · Status: in force (`packages/core/src/networks.ts`, `packages/web/src/vault/signing.ts`,
  `packages/web/src/client/ethereum.ts`) · Source: `docs/batch-b-spec.md` Q27; decided by the user; how "mainnet" is
  defined: default approved by the user (2026-10-28)
- Decision: the vault refuses mainnet Stellar passphrases and mainnet EVM chain IDs for `pk_test_` apps (keys from the
  testnet MPC). Sodax integrates and tests on chain testnets; real Sodax swaps through Hana wait for the mainnet launch.
- How: Stellar mainnet is the passphrase `Public Global Stellar Network ; September 2015` (the only one a mainnet
  accepts). EVM uses an **allowlist** of testnet chain IDs (`TEST_EVM_CHAINS`: Sepolia 11155111, Holesky 17000, Base
  Sepolia 84532, Arbitrum Sepolia 421614, OP Sepolia 11155420, Sonic Blaze 57054, BSC testnet 97, Polygon Amoy 80002,
  Avalanche Fuji 43113, local 31337 and 1337; Hoodi 560048 and Sonic testnet 14601 added 2026-10-28, see the
  amendment below); anything else counts as a mainnet. Refused before any popup or policy
  (4100 `mainnet_not_allowed`): transactions and auth entries for those networks, and typed data whose domain
  `chainId` is one. Messages, typed data without a `chainId` and raw requests name no network (D35) and are allowed.
  The EIP-1193 provider refuses `wallet_switchEthereumChain`/`wallet_addEthereumChain` to such a chain and
  `eth_sendTransaction`/`eth_signTransaction` on one. The approval and consent screens of a test app say Hana signs
  only for test networks.
- Rejected: a denylist of known mainnets (a new or unlisted chain would be allowed).
- Amended 2026-10-28 (default decided for the user): test apps can't use raw signing at all.
  `hana_signRaw` from a `pk_test_` app is 4100 `raw_not_allowed_for_test_apps` whatever `raw_sign` says, before any
  API read or popup (`packages/web/src/vault/signing.ts`), because a raw digest can be a mainnet transaction's hash.
  Messages stay allowed. The allowlist gains Ethereum Hoodi 560048 and Sonic testnet 14601 (IDs checked against
  ethereum-lists/chains and each chain's official RPC, `eth_chainId` 0x88bb0 and 0x3909).
- Why: testnet MPC keys can be stolen (weaker operator and node standards) or lost (a network reset changes every
  address), and testnet-derived addresses differ from production ones.
- Rejected: allowing mainnet with warnings and small amounts.
- Open: the mainnet launch date (not set).
- Amended 2026-11-06 by D428 (decided by the user): the mainnet demo exception for the Sodax demo.

### D40. Leaving Hana: per-chain key export and Hana Home, no seed phrase
- Date 2026-10-28 · Status: confirmed by the user; Hana Home to build before mainnet · Source: `docs/batch-b-spec.md`
  Q19
- Decision: users leave by exporting each chain's private key (fresh Google sign-in plus typed confirmation). No seed
  phrase, global or per chain, for EVM or Stellar. Before mainnet, Hana runs "Hana Home" on the auth domain: a user
  signs in with Google and can export their keys for any app that uses Hana's shared Google login, so a partner app
  shutting down doesn't strand them. Apps on their own Google client can't be covered (only their origins can get
  tokens for that client).
- Why: private keys import into every major EVM and Stellar wallet (Privy exports keys the same way); a phrase would
  change EVM derivation and add little for these users.
- Rejected: EVM seed phrase export. Deferred (future): a standalone open-source recovery tool that works without
  Hana's servers.

### D41. Key export stays available and mandatory
- Date 2026-10-28 · Status: confirmed by the user · Source: conversation on lock-in
- Decision: export lives in account settings behind its security checks (fresh Google sign-in, typed confirmation);
  it is never removed, hidden behind support, or switchable off by partners. Retention comes from Hana Home as a
  cross-app destination, features (auto-approve, gas sponsorship, no seed phrase) and partner switching cost
  (addresses come from Hana's contract).
- Why: a working exit underpins the non-custodial claim (get legal advice before mainnet) and partner due diligence.
- Rejected: letting partners disable export (Privy allows it); extra delays or friction beyond the security checks.

### D42. Google client tiers: shared by default, Hana-held branded client for Enterprise
- Date 2026-10-28 · Status: confirmed by the user; cross-project `sub` test passed (Workspace and personal accounts) · Source:
  `docs/batch-b-spec.md` Q3, Q37
- Decision:
  - Standard (default): Hana's shared Google client; Google's screen names Hana. Sodax pilots on this.
  - Enterprise: Hana creates and holds a Google Cloud project and client per partner, branded with the partner's name
    and logo, allowing only Hana's popup pages; registered as the scope's own client. Manual onboarding.
  - Partner-held own client: only if a partner insists, with the client locked down (only Hana's popup pages as
    origins and redirect, no native clients) and a written warning that whoever controls that Google project can
    derive its users' keys, and (with email login on, D264) see which users granted it the `email` scope and read
    their addresses.
  - Staging uses its own scope (and test keys), so staging wallet addresses differ from production.
- Why: branding never weakens custody. In Hana the Google token unlocks derivation, so a partner holding the client
  could derive its users' keys silently (unlike Privy, where the token only logs in to Privy). A partner moves from
  Standard to Enterprise with the same addresses, since the path has no client ID.
- Condition, met 2026-10-28: the same Google account through clients in two different Cloud projects got the same
  `sub` (`apps/smoke/spike.html` `subFingerprint`; `docs/context.md` spike notes).

### D43. Session lengths: 12 h absolute, 2 h idle by default
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q5
- Decision: defaults stay 12 h absolute and 2 h idle; partners tune both within the allowed range (≤ 23 h 50 min
  absolute) through app settings. Review after a month of pilot data (logout frequency, re-login cost ≈ 9 s and
  $0.021 each).

### D44. Consent screen: partner names labelled, Hana-verified names marked
- Date 2026-10-28 · Status: confirmed by the user; in force · Source:
  `docs/batch-b-spec.md` Q41
- Decision: the auto-approve consent screen shows a policy's contract names as "named by {app}" with the short address
  and an explorer link. Contracts on Hana's verified list (per chain address → name, starting with Sodax's contracts)
  show a ✓ and the verified name instead. The list is built into the vault and popup bundles (a code release changes
  it, never D1 or the API), and an entry is added only after Hana confirms the address from the protocol's official
  sources.
- Why: partner-chosen names can mislead ("USDC", "Uniswap Router"); addresses alone mean nothing to most users.
- Rejected: partner names as-is; addresses only.
- Built: `packages/core/src/verified-contracts.ts` (frozen list keyed by EVM `chainId` + lowercase address or Stellar
  passphrase + exact contract ID; each entry has its name, sources and date added; explorer URL per chain, test
  networks included) and `packages/web/src/auth/render-consent.ts`. A partner name that reads as a verified name or
  mentions a verified protocol on another contract is flagged ("— not the verified …"); check marks are stripped
  from partner names. Initial entries: Sodax mainnet contracts confirmed by both `@sodax/types@2.1.0` and
  docs.sodax.com/developers/deployments/mainnet (Sonic hub contracts; asset manager and bnUSD on 13 EVM spokes and
  Stellar; Connection on Hedera, Kaia and Robinhood Chain). Addresses only one source lists, or where they disagree,
  are left out.

### D45. Granting auto-approve needs no fresh Google sign-in
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q40
- Decision: consent stays a guarded click in the Hana popup, per device, ending with the session. Hana Home (D40) will
  list active consents per device and let the user revoke them from any device. A consent that outlives a session,
  if ever added, needs a fresh sign-in.
- Why: whoever can click Allow can already click Approve on any single request, which is more powerful than a capped
  consent; a fresh sign-in would add ~9 s and $0.021 for little protection.

### D46. No token amount caps in auto-approve for the pilot
- Date 2026-10-28 · Status: confirmed by the user · Source: `docs/batch-b-spec.md` Q39
- Decision: policies limit counts, native value plus fees, recipients (address rule) and contracts/functions; token
  amounts aren't capped. Revisit with the Sodax decoder, which can cap per token per day once it decodes token and
  amount.
- Why: in batch B Sodax swaps and bridges always use the popup; `approve` to an unlisted spender is refused; auto-approve
  is off by default, delayed 24 h and needs user consent.
- Rejected for now: per-token caps from generic `transfer`/`approve`/swap decoding.

## Defaults approved by the user, 2026-10-28

Each entry below is a default the user approved on 2026-10-28 (source: conversation, "default approved by the user").
The matching question in `docs/batch-b-spec.md` "Open questions" points here.

### D47. Batch B reconciliations R1–R13 and the remaining batch B decisions confirmed (Q30)
- Date 2026-10-28 · Status: in force · Source: `docs/batch-b-spec.md` "Reconciled conflicts",
  "Decisions (2026-10-27/28)"
- Decision: R1–R13 stand as the spec takes them (two origins; relay-only, end-to-end encrypted token return; vault page
  inlines D1 config and reads `GET /v1/app` lazily; BLS key `a` made after the token arrives; server share plus one
  AES-GCM layer; `max_uses` 1 / 2 / 1; PRK only; export by a fresh login; logout without a transaction; the
  `{v:1,t}` envelope; the encrypted relay plus a defence-in-depth RS256 check; `revoke-all` only within 5 min of a
  fresh login; each tab unlocks itself). Also confirmed as built: the vault iframe plus Hana popups on two origins,
  the token returned only through the encrypted relay, the Google implicit flow, the pinned `signer`/`relayer`/CKD
  key, the vault computing the path, storage partitioning accepted as per-partner isolation, and dev-only privileges
  tied to the env name.

### D48. No silent `app_signed` raw signing in the MVP (Q31)
- Date 2026-10-28 · Status: in force (`raw_sign` is `'off'` or `'approval'` only) · Source: `docs/batch-b-spec.md` Q31
- Decision: raw signing is off or needs an Approve every time. If it comes back, only as requests signed by a
  per-app partner backend key, registered through batch C's fresh-sign-in, logged, notified and delayed process.
- Why: as first specified it was silent signing of chain-valid hashes, controlled by a D1 column.

### D49. A new login supersedes a pending one (Q34)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/vault.ts` `newPending`) · Source: `docs/batch-b-spec.md` Q34
- Decision: `hana_login` while a login is pending ends the old one with `login_cancelled` instead of answering `busy`.

### D50. No local `K_l` wrapping layer (Q35)
- Date 2026-10-28 · Status: in force (the record holds PRK under `K_s` only) · Source: `docs/batch-b-spec.md` Q35
- Why: it stops no named attacker: whoever can read the record and call the API already gets `K_s`.

### D51. Test and live apps never share a scope (Q37)
- Date 2026-10-28 · Status: in force (`scope_conflict`, `apps/api/src/apps.ts`) · Source: `docs/batch-b-spec.md` Q37,
  the "Proposed, not yet confirmed" list
- Decision: loopback origins and partner-origin session endpoints only in `local*`/`sandbox*` envs, and a `pk_test_`
  app on a scope a `pk_live_` app uses is refused. A partner's staging uses its own scope, so different addresses.

### D52. Enabling raw signing uses the origin-change delay (Q38)
- Date 2026-10-28 · Status: in force for raw signing (24 h, `changeDelayMs` in dev envs); batch C reuses it ·
  Source: `docs/batch-b-spec.md` Q38
- Decision: `raw_sign = 'approval'` waits the same 24 h as an origin change (D34); batch C's dashboard puts both
  through the same delayed, logged and notified path. Turning it off is immediate (D68).

### D53. `max_uses = 1` in `'session'` mode (Q14)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/login.ts`) · Source: `docs/batch-b-spec.md` Q14, R6
- Decision: `ckd_failed` or a replayed combined call means a new login. No spare use burnt with `revoke_session`.
- Why: the share precondition ("the session is used up") stays simple; measure the MPC failure rate in the pilot.

### D54. `VAULT_KEK` stays a Worker secret with its copy in `.secrets`; KMS later (Q16)
- Date 2026-10-28 · Status: in force (`scripts/vault-kek.ts` `init`/`rotate`, `VAULT_KEK_PREVIOUS`, the cron re-wrap)
  · Source: `docs/batch-b-spec.md` Q16
- Decision: rotation through `vault-kek rotate`; an HSM/KMS move is revisited with the email issuer (D17).

### D55. The vault zeroes PRK after an in-memory idle period (Q28)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/vault.ts` `goIdle`, `wake`) ·
  Source: `docs/batch-b-spec.md` Q28
- Decision: after the app's `idle_ttl_ms` with no request from the partner page (signing, status, addresses, export,
  auto-approve), PRK is zeroed, not only at the absolute end. In `'session'` mode the next request that needs the key
  unlocks the record again (one API call, same share only), which works while the server share is alive; otherwise,
  and in `'none'` mode, the session ends (`sessionExpired`).
- Why: shortens how long PRK sits in a tab nobody uses, where a renderer bug could reach it (security.md (j)).
- Amended 2026-10-28 (default decided for the user): only requests that use the key count as
  activity (the sign methods, `hana_export`, `hana_revokeOtherDevices`, `hana_requestAutoApprove`). `hana_status`,
  `eth_accounts`, `stellar_getAddress` and `hana_autoApproveStatus` don't, and they keep answering while the session
  is dormant without unlocking it, so a page that polls them can't keep PRK in memory. `hana_autoApproveStatus` would
  need PRK to open the consent in the record (it is sealed under a PRK-derived key), so a dormant session answers it
  from this tab's last known consent (not secret: policy id, end time, counters); its counters can lag auto-signs made
  in other tabs until the next request that uses the key.

### D56. The vault checks its scope against the on-chain registry at login (Q7)
- Date 2026-10-28 · Status: in force (`packages/web/src/vault/login.ts` `checkScope`) · Source:
  `docs/batch-b-spec.md` Q7
- Decision: one view through the manifest RPC, started as soon as `GET /v1/app` answers and awaited before anything
  is relayed: own client `scope_for_client('google', aud)` must be the inlined `scopeId`; shared client
  `get_scope(scopeId)` must exist and allow shared login. Mismatch: `config_mismatch` (`scope_mismatch`); no answer:
  `api_unavailable` (`scope_unchecked`).
- Cost: it runs while the user is at Google, so it adds no time to a normal login (estimated 0 ms waited; the view
  itself is one optimistic `query`, ~0.1–0.3 s on testnet RPC). pk_test_ logins report `timings.scopeCheck` (the
  view) and `timings.scopeWait` (time the login actually waited on it), to measure on testnet.
- Limit: the app→scope binding lives only in D1, so an API that names another scope together with that scope's own
  client passes.

### D57. Keep `create_session` (Q12)
- Date 2026-10-28 · Status: in force (contract method kept; relayed only for the split fallback and `apps/smoke`) ·
  Source: `docs/batch-b-spec.md` Q12
- Decision: `create_session` stays a public method, not removed before the audit.

### D58. CODEOWNERS on derivation, vectors, the contract and the env schema (Q23)
- Date 2026-10-28 · Status: in force, paths widened by D100 (`.github/CODEOWNERS`; needs "Require review from Code
  Owners" on `develop` and `main`) · Source: `docs/batch-b-spec.md` Q23
- Decision: `@tzechuen` owns `packages/core/src/derivation*`, `packages/core/test/vectors/`, `contracts/hana-signer/`
  and `packages/env/src/`.

### D59. Key export: only from a Hana window, relayer-paid, rate-limited per user (Q18)
- Date 2026-10-28 · Status: in force (`apps/api/src/login.ts`) · Source: `docs/batch-b-spec.md` Q18
- Decision: a partner page can only ask (`hana_export` shows the vault's launcher); the export window opens only from
  that click and takes its context only from the vault that opened it. Its `/v1/login` is relayed at Hana's cost and
  limited to 3 per hour per `(app, sha256(path))`, counted after the token check and before the relay.

### D60. Two Google sign-ins are acceptable for a `key_index` move (Q20)
- Date 2026-10-28 · Status: confirmed (rotation not built) · Source: `docs/batch-b-spec.md` Q20
- Decision: a k → k+1 sweep needs one sign-in per `key_index`; no contract change to derive two indices per session.

### D61. Account 0 only in the MVP UI (Q21)
- Date 2026-10-28 · Status: in force (the vault signs and derives addresses with account 0 only, `signing.ts`
  `ACCOUNT`; the export window exports account 0; no port method takes an account) · Source: `docs/batch-b-spec.md` Q21
- Decision: `account > 0` stays unused until there is a discovery story.

### D62. A removed policy stops auto-signing within 10 s
- Date 2026-10-28 · Status: in force (`POLICY_FRESH_MS`, `packages/web/src/vault/vault.ts`) · Source: `docs/security.md`
  "Auto-approve policies"
- Decision: an open vault auto-signs only under a policy `GET /v1/app` confirmed less than 10 s ago.

### D63. Permit2 and Uniswap v3 calls need a protocol decoder
- Date 2026-10-28 · Status: in force (the `uint160` rule of D37) · Source: D37, `docs/security.md` (d)
- Decision: their `uint160` fields keep them out of auto-approve until a decoder covers them; the popup handles them.

### D64. The BLS precheck stays off unless measured cheap (Q8)
- Date 2026-10-28 · Status: in force (`BLS_PRECHECK = "0"` in every env) · Source: `docs/batch-b-spec.md` Q8
- Decision: turned on only if a measurement shows its Worker CPU cost is acceptable (Workers Paid plan); the MPC
  refuses a bad key anyway.

### D65. Optional `rpcFallback` for the vault's NEAR reads (Q9)
- Date 2026-10-28 · Status: in force (`packages/env/src/schema.ts`, `packages/web/src/near-call.ts`) ·
  Source: `docs/batch-b-spec.md` Q9
- Decision: the manifest may name a second https NEAR RPC. The vault and the export window read from it only when the
  primary errors or times out (8 s), for `get_session` re-syncs, registry views and tx polling; each read's answer
  comes from one endpoint, never a mix. It joins `rpc` in the pages' CSP.
- Amended 2026-10-28 (decided for the user): sandbox-dev's `rpcFallback` is
  `https://rpc.testnet.near.org` (probed: 200, ~3.5 s); the primary stays `test.rpc.fastnear.com`. Takes effect on the
  next `gen`, page build and deploy.

### D66. One thin Worker per Hana origin (R19)
- Date 2026-10-28 · Status: in force (`apps/api/scripts/pages-wrangler.ts`, `apps/api/src/pages/`) · Source: review
  finding R19 (moved from "Proposed")
- Decision: every env serves `vaultOrigin` and `authOrigin` from one thin Worker each (`workers.dev` in dev envs,
  Custom Domains in production), not from routes on the API Worker, so neither origin can serve the other's files.
  Production runs three Workers.

### D67. The Sodax Stellar adapter signs as `rawTx.from` only (R51)
- Date 2026-10-28 · Status: in force (`packages/sodax/src/stellar.ts`) · Source: review finding R51; the
  "Superseded or amended" row below
- Decision: `signAndSendTransaction(p)` signs with `{address: p.from}`, so a raw transaction built for another account
  (a muxed `M…` address included) is 4100 before any popup.

### D68. Raw signing `'off'` takes effect in open tabs
- Date 2026-10-28 · Status: in force (`GET /v1/app` `rawSign`; `packages/web/src/vault/vault.ts`
  `freshRawSign`) · Source: `docs/security.md` "Auto-approve policies"
- Decision: the vault re-reads `rawSign` before every raw request on the same 10 s bound as the policy; `'off'`
  refuses until a reload, and a failed re-read refuses (fails closed).

### D69. An EVM policy rule needs `maxValueWei ≥ maxFeeWei`
- Date 2026-10-28 · Status: in force (`packages/core/src/policy/validate.ts`) · Source:
  `docs/security.md` (b)
- Decision: the validator refuses a rule whose `maxValueWei` is below its `maxFeeWei` (value plus fees counts
  against it since D37, so it could never auto-approve at its fee cap). The consent screen labels the limits
  "Maximum value plus network fees, per transaction / per day".

### D70. No cookies on Hana origins
- Date 2026-10-28 · Status: in force (`apps/api/src/pages/host.ts` `withoutCookies`; tests in apps/api, packages/web
  and the Playwright suite) · Source: D38 ("no domain-wide cookies")
- Decision: no response from the vault origin, the auth origin or the API sets a cookie; the page Workers drop one a
  binding returns.

### D71. SDK packages ship as built ESM with their envs built in
- Date 2026-10-29 · Status: in force (`packages/*/tsconfig.build.json`, `scripts/lib/sdk-build.ts`,
  `scripts/pack-check.ts`; CI job `packages`) · Source: Sodax needs to install the SDK outside this monorepo
- Decision: `@hana-id/core`, `web`, `react` and `sodax` build with `tsc` (no bundler, no new dependency) to ESM,
  `.d.ts` and source maps with inlined sources (web into `dist/lib`, since `dist/pages` is the page build). The
  workspace keeps `exports` at `src/`; `pnpm pack` swaps in `publishConfig.exports` and rewrites `workspace:^` to
  `^<version>`. `@hana-id/web` carries exactly the `envs/*.json` that set both Hana origins (today `sandbox-dev`);
  its package build fails on an UNSET value, on a local (loopback) env, or on no env. Partners pick one with
  `createHana({ environment })`. Every change is checked by packing, installing with npm into a project outside the
  workspace, type-checking and importing in Node.
- Rejected: tsup or another bundler (not in the lockfile, and per-file output keeps `sideEffects: false` tree-shaking
  and readable stack traces); a runtime env config (would let a page point the client at another vault).

### D72. One lockstep SDK version, set by script; no Changesets
- Date 2026-10-29 · Status: in force (`scripts/sdk-version.ts`, `.github/workflows/publish-sdk.yml`) · Source: SDK
  packaging (D71)
- Decision: the four packages share one version (`0.1.0` first), set with `pnpm --filter @hana-id/scripts
  sdk-version <v>`, which also updates the `VERSION` constants (web's goes to the vault as `sdk`). Publishing is a
  manual-dispatch workflow from `main` with npm provenance, inert until an `NPM_TOKEN` secret exists and the packages
  drop `"private": true`. Not decided: the registry (public npm under an `@hana-id` org, or private) and the licence
  (`UNLICENSED` until then).
- Rejected for now: Changesets. With four packages always released together and one consumer, per-package bump
  files add a dependency tree and a review step without information, and it wouldn't update the `VERSION` constants.
  Revisit if the packages start versioning independently.

### D73. Usage and billing ledger on Neon Postgres in Sydney
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: the usage and billing ledger (batch C's `USAGE_DB`) is a Neon Postgres project in `aws-ap-southeast-2`
  (Sydney), reached from Workers through Cloudflare Hyperdrive. Hot app config and console data stay in D1.
- Why: the ledger only grows and must be kept for years (D1 caps a database at 10 GB); reports need percentiles,
  time buckets and materialised views; staff and finance can use standard SQL tools; point-in-time restore is
  included. Sydney because the company is incorporated there (Privacy Act cross-border rules) and a team member is
  there. Neon over Supabase: plain Postgres with no auto-exposed data API to lock down, usage-based pricing, branching
  and restore included.
- Rejected: D1 for the ledger (fine for the pilot, but rollups and archiving would be needed); Supabase (its login,
  storage and data API go unused and add attack surface).

### D74. Files on Cloudflare R2
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: partner logos, monthly statements and ledger exports live in R2 in the Hana Cloudflare account. Logos are
  served from a Hana origin with strict headers; Hana never shows a partner-hosted image in its popups.
- Rejected: Supabase Storage (a second place to secure for no gain).

### D75. Three sign-in audiences; no third-party auth service
- Date 2026-10-29 · Status: confirmed by the user, for batch C · Source: `docs/batch-c-spec.md` "Confirmed by the user"
- Decision: wallet users sign in with Google in Hana's popup, verified on chain. Partners use the console's own Google
  OIDC code flow (PKCE), invite-only, owner/viewer roles, server sessions stored as hashes, and a fresh sign-in bound
  to each security-critical change. Hana staff reach the admin console through Cloudflare Access (members of a
  `Hana-Technology` GitHub team with org 2FA required; exact-email Google rules as fallback), and the admin Worker
  verifies the Access JWT on every request.
- Why: the Google ID token is the on-chain owner proof, so an auth service in between adds a party that could
  impersonate partner owners while we still handle Google's token; Access keeps the admin console off the internet and
  hands MFA and offboarding to GitHub/Google.
- Rejected: Supabase Auth (used for Wend's admin portal), Clerk, Auth0, WorkOS; Access for partners (no self-service
  invites, branding or on-chain proofs; per-seat cost past 50 users).

### D76. Keep the one-transaction login (ship gate passed)
- Date 2026-10-29 · Status: confirmed by measurement under the rule set in D26 · Source: `docs/context.md` "Login
  timings with stage breakdown"
- Decision: `create_session_and_derive` stays. Over 10 interleaved runs each, it saved 2.44 s of chain time at the
  median against `create_session` + `derive_key`, above the 1.5 s bar.

### D77. The login popup makes no API call; it trusts the vault's app facts
- Date 2026-10-29 · Status: in force (`packages/web/src/auth/login-page.ts`; `/login` CSP without `connect-src`,
  `packages/web/src/auth/pages.ts`, `apps/api/src/pages/host.ts`) · Source: `docs/context.md` "Login timings with
  stage breakdown" (`authCheck` 1.05 s); reasoning in `docs/security.md` "The login popup trusts the vault's app facts"
- Decision: `/login` no longer calls `GET /v1/app` before going to Google. It uses the app name, parent origin, scope
  and Google client from `hana:auth-params`, which it accepts only from the authenticated preparer (the vault on
  `vaultOrigin` by `event.origin` and `event.source`, or `/export` on `authOrigin`), and still checks the pinned
  `SIGNER` and recomputes the nonce. Its CSP drops `connect-src` (it fetches nothing).
- Why: its own read added nothing a malicious party could not already get around. A compromised `vaultOrigin` or API
  Worker already has every key (`docs/security.md` "What a compromise gives"), and the popup's read went to the same
  API. The only things it caught were a vault config gone stale since the page loaded (app suspended, origin removed,
  Google client changed), and `POST /v1/login` refuses all of those anyway before anything is relayed (app gate on the
  current D1 row, `x-hana-parent-origin`, `checkClientScope`, the contract's scope check, the vault's registry check
  D56). So such a login now fails after Google rather than before it. Measured cost removed: about 1.05 s per login.
- Rejected: keeping the read but running it in parallel (the popup navigates to Google at once, which cancels it, and
  moving it to the callback would put it back on the critical path for no added check).

### D78. The vault endpoints cache the app per isolate for 30 s; the share limit runs alongside the gate's
- Date 2026-10-29 · Status: the app cache in force (`apps/api/src/app-cache.ts`, `apps/api/src/vault/endpoints.ts`
  `vaultApp`); the share limit alongside the gate's, with its refund, superseded by D95 · Source: `docs/context.md`
  "Login timings with stage breakdown" (unlock gate 0.24 s)
- Decision: `/v1/vault/*` reads the app (`getAppByKey`, two D1 queries) from an in-isolate cache whose entries live
  30 s from the D1 read (at most 256 apps; unknown keys and failed reads never cached). Nothing in the Worker writes
  `apps`, so the bound is the TTL: a suspension, a removed or changed publishable key, a removed origin, a scope
  conflict or a plan change reaches the vault endpoints within 30 s per isolate. The relay endpoints, `GET /v1/app`
  and the vault page still read D1 every time, so a suspension stops logins (gas) and new vault loads at once. Rate
  limits keep their order and counts: the IP window, then the app window only once the IP window accepted (so a
  request the IP refuses never holds any of the app's shared quota); the share window (`share:<id>`, 10/min) is asked
  alongside them and refunded when the IP or app window refuses, so it counts exactly as before.
- Why: a reload's unlock paid the D1 reads and three limiter round trips one after another; a warm unlock now pays two
  limiter round trips. Suspension and key removal are operator actions where 30 s is acceptable; nothing on the vault
  endpoints spends gas.
- Rejected: asking the IP and app windows in parallel with a refund (a client the IP window refuses would hold app
  quota while its requests are in flight, so one client with many requests open could lock out every user); caching
  for the relay endpoints (a suspension must stop spending at once); an invalidation signal (no Worker code changes
  apps today; revisit with batch C's console).

### D79. Login success is reported before the share is made
- Date 2026-10-29 · Status: in force (`packages/web/src/vault/vault.ts` `finishLogin`, `persistLogin`) · Source:
  `docs/context.md` "Login timings with stage breakdown" (`persist` 0.48 s); amends `docs/batch-b-spec.md` "Login"
  steps 11–12
- Decision: in `'session'` mode the vault replies to `hana_login` (and emits `accountsChanged`) as soon as PRK and the
  addresses exist, with `persistence: 'session'`, then makes the share (`POST /v1/vault/shares`, tried once more after
  1 s) and the IndexedDB record in the background. If that gives up, the session keeps working in memory,
  `hana_status` reports `persistence: 'none'` and the vault emits `persistenceChanged {persistence: 'none'}` (the
  client's `hana.persistence` and `useHana()` follow), the share (if made) is revoked, the older session's record this login
  replaces is deleted and its share revoked (the next reload is a full login), and the vault logs a reason code
  (`console.warn`, no ids or keys). A session that ends first (logout, a newer login, expiry, idle, a revocation)
  cancels it: no record is left and a share made for it is revoked; logout doesn't wait. Revoke-other-devices, touch
  and every consent read or write wait for it to settle.
- Why: about 0.48 s off every login, and the share only matters at the next page load.
- Given up: a reload within that window (about one API round trip after the login reply) is a full login; the login
  result's `persistence` is the mode intended, and `persistenceChanged` / `hana_status` say if it didn't happen. Share timings are no
  longer in the login's timings (`persist`, `shareRtt`, `shareServer*` removed); the API's request log still has them.

## Governance and batch C, confirmed by the user 2026-10-29

Each entry below was decided by the user on 2026-10-29 (source: conversation, "confirmed by the user"). D80–D86
answer `docs/governance-spec.md` "Open questions" and D87–D93 answer `docs/batch-c-spec.md` "Open questions"; each
answered question there points here.

### D80. Governance delays: issuer keys 2 h (provisional), governance 72 h on mainnet
- Date 2026-10-29 · Status: confirmed by the user (mainnet issuer-key delay provisional); built (governance contract v2),
  running on sandbox-dev since 2026-10-30 with its dev delays; mainnet values not set yet · Source:
  `docs/governance-spec.md` "Delay length", open question 1
- Decision: mainnet `issuer_key_delay_ms` = 2 h, provisional: it is set by the spec's formula from the lead-time
  measurement now running (`admin issuer-keys:lead-times`) once two Google rotations are recorded.
  `governance_delay_ms` = 72 h on mainnet (upgrades, owner transfer, a new watchdog's confirm power, delay decreases,
  surplus withdrawals). sandbox-dev: 2 min and 60 s.
- Why: 72 h gives partners and users time to see an upgrade and export keys (D41). A paused contract waiting up to
  72 h for a fix is accepted: fast emergency response comes from pause (owner or watchdog, at once; the owner unpauses
  at once), not from short delays.
- Rejected: a governance delay short enough to ship fixes fast (it shortens everyone's reaction window; pause covers
  emergencies); fixing the issuer-key delay before Google's lead time is measured.

### D81. Owner multisig: Sputnik DAO v2, 2-of-3 for every proposal kind
- Date 2026-10-29 · Status: confirmed by the user; built; sandbox-dev's signer is owned by its 2-of-3 council DAO
  (throwaway members) since 2026-10-30; the mainnet council and its backup key not set up · Source: `docs/governance-spec.md` "Owner = multisig",
  open question 2
- Decision: the contract owner is a Sputnik DAO v2 council: 2 of 3 votes for **every** proposal kind (function calls,
  policy, member changes, the DAO's own upgrades); only council members propose. Mainnet council: the two founders
  (each on a Ledger) and one offline backup key that neither founder can reach alone, held by a third party (e.g. the
  company's lawyer or accountant, under written instructions) or in a dual-control safe deposit box; where it is held
  is decided before mainnet. The backup is replaced by an independent member later. sandbox-dev: Sputnik 2-of-3 with
  three throwaway testnet member accounts whose keys live in `.secrets/sandbox-dev/` (0600) and that scripts drive
  (propose and approve in one command); `near-workspaces` sandbox tests cover the full flow.
- Why: 3-of-3 for policy would freeze the council if one Ledger is lost; the contract's 72 h governance delay (D80)
  and the watchdog's alerts (D85) already guard every owner action.
- Rejected: 3-of-3 for policy and member changes (the draft); `multisig2` on the owner account (no named audit, no UI,
  little maintenance); a backup key either founder can reach alone (that founder would hold 2 of 3).

### D82. The watchdog acts alone only on clear forgeries; the owner unpauses at once
- Date 2026-10-29 · Status: confirmed by the user; built (`apps/watchdog`), deployed on sandbox-dev 2026-10-30 (forged-key
  and pause drills) · Source: `docs/governance-spec.md` "Watchdog service",
  open question 4
- Decision: on its own the watchdog cancels any pending issuer key Google doesn't publish (kid absent from two
  fetches ≥ 60 s apart, or other key material), deletes every updater key when the updater proposed such a key, and
  pauses **only** when a key Google doesn't publish is active on chain. It also confirms keys that match Google's JWKS
  (D86). Everything else is alert-only (D85), including a pending removal of a kid Google still publishes. The owner
  multisig can unpause at once, with no governance delay.
- Why: these responses are unambiguous and DoS-only; anything that needs judgment waits for a human, so a buggy or
  rogue watchdog can at most delay a rotation or stop logins until the owner unpauses.
- Rejected: an alert-only watchdog (a forged key goes live if nobody answers within the delay); pausing on any anomaly
  (too much DoS power for one service).

### D83. Every watchdog check and alert surfaces in the admin portal (standing rule)
- Date 2026-10-29 · Status: confirmed by the user (requirement and standing rule), not built · Source: conversation;
  `docs/governance-spec.md` "Monitoring in the admin portal"
- Decision: the admin console gets a "Security & monitoring" view: watchdog heartbeat and last check, with a warning
  when it has been silent past its interval; pending issuer-key changes with a countdown and whether each matches
  Google's JWKS; the watchdog's actions log; pause state and the updater keys; pending upgrades and owner actions with
  countdowns; alert history with acknowledge. **Standing rule:** every future watchdog check or alert must surface in
  the admin portal; a check without its portal view isn't done. The watchdog still sends its own alerts (D85), so a
  compromised Hana Cloudflare account can't silence it; the portal reads the watchdog's status and on-chain state and
  events.
- Why: one place for staff to see governance state; the portal is a view, never the alert path.
- Rejected: alerts only through the portal (it runs in the account an attacker would want); a watchdog with no status
  surface.

### D84. No independent upgrade guardian at launch
- Date 2026-10-29 · Status: confirmed by the user · Source: `docs/governance-spec.md` open question 8
- Decision: only the owner can cancel a pending upgrade. The watchdog sends a critical alert on every upgrade
  proposal. Revisit when an independent party exists (the auditor, a partner).
- Why: a guardian helps only if it is independent of the founders; none exists yet. The 72 h delay, the public event,
  the alerts and key export (D41) remain.
- Rejected: the watchdog as guardian (run by Hana, so not independent; a compromised watchdog could block every fix).

### D85. Alert severities: critical, warning, info
- Date 2026-10-29 · Status: confirmed by the user; built (`apps/watchdog`), on sandbox-dev since 2026-10-30 with only the
  pager (ntfy.sh, a stand-in) and the heartbeat set; Slack, email and the paging app still to set up · Source: `docs/governance-spec.md` "Alerts", open
  question 15
- Decision: **critical** goes to a phone paging app (PagerDuty, Pushover or ntfy, chosen at setup), Slack and email,
  to both founders, and is re-sent every 15 min until acknowledged; acknowledgements are recorded in the admin portal.
  **Warning** goes to Slack and email. **Info** goes to the admin portal and a daily digest. The watchdog sends them
  itself.
- Why: a forged key or an upgrade needs a human within the delay, at any hour; two people and three channels mean one
  outage or one person asleep doesn't hide it.
- Rejected: email only; one severity for everything.

### D86. Governance spec: the remaining open questions take the spec's proposals
- Date 2026-10-29 · Status: defaults approved by the user; the contract, watchdog and script parts built and on
  sandbox-dev since 2026-10-30; Q11's partner email and pending-upgrades pages wait for batch C · Source: `docs/governance-spec.md` open
  questions 3, 5, 6, 7, 9, 10, 11, 12, 13, 14, 16
- Decision, by question:
  - Q3: the watchdog runs on its own Cloudflare account (separate login and MFA); one watchdog at launch.
  - Q5: one watchdog may confirm (activate early) a key that matches Google's JWKS; k-of-n confirmers later.
  - Q6: removing a watchdog slows key changes to `governance_delay_ms` unless another watchdog confirms; accepted.
  - Q7: pause blocks derivation and new sessions: every token path (sessions, scope registration, token-authenticated
    owner actions), `derive_key`, and the executors (`execute_change`, `execute_issuer_key_change`); never
    governance, revocation, cancels or views.
  - Q9: sandbox-dev keeps the signer's full-access key (speed); any staging env and mainnet never have one.
  - Q10: an owner-only withdrawal of surplus NEAR from the signer (above storage plus a reserve), timelocked by
    `governance_delay_ms`.
  - Q11: public notice of an upgrade or owner change = the on-chain event, an email to every partner (the orgs'
    security contacts), and a pending-upgrades page in the admin and partner consoles.
  - Q12: owner-posted issuer keys wait the same `issuer_key_delay_ms` as the updater's.
  - Q13: `set_console_audiences` additions wait `change_delay_ms`; removals stay immediate.
  - Q14: every mainnet `propose_upgrade` needs a reproducible build, its hash published before the proposal.
  - Q16: events version `1.1.0`, additive.
- Rejected: the alternatives each question listed.

### D87. Email: Resend, from a dedicated sending subdomain
- Date 2026-10-29 · Status: confirmed by the user, provisional: to re-confirm with the colleague (2026-10-29); user mail
  superseded by D194; **the provider superseded by D401 (2026-11-05): SendGrid for the admin Worker's notices and the
  watchdog's alerts too, the Resend adapters removed**; the subdomain, the sender interface and "accepted only" stand · Source: `docs/batch-c-spec.md` "Email", open question 2
- Decision (user mail superseded by D194: SendGrid): Resend, sending from a dedicated subdomain of the Hana domain with SPF, DKIM and DMARC, behind a small
  sender interface (send one message → accepted or an error) so switching (e.g. to Postmark) is one adapter. The
  admin Worker's fail-closed notices count a send as done only when Resend accepts it. The watchdog sends its alert
  emails with its own Resend API key, not the admin Worker's.
- Why: sends to any address from a Worker over HTTPS; the subdomain keeps notice reputation apart from the main
  domain's mail.
- Rejected for now: Cloudflare Email Sending, Postmark (the fallback behind the interface), SES.

### D88. Admin access: GitHub team `hana-admins`, exact-email fallback, staff allowlist kept
- Date 2026-10-29 · Status: confirmed by the user (fallback addresses to come), not built · Source:
  `docs/batch-c-spec.md` "Hana admin console", open question 4
- Decision: the Cloudflare Access policy includes the GitHub team `hana-admins` in `Hana-Technology`, with 2FA
  required org-wide, and a fallback rule of exact Google email addresses (the user provides them later; never a domain
  rule). The admin Worker keeps its own `admin.staffEmails` allowlist as a second check on every request.
- Why: GitHub carries MFA and offboarding; with the allowlist, one mistaken Access edit alone lets nobody in. The cost
  is offboarding in two places.
- Rejected: dropping the Worker allowlist; a domain rule; the draft's assumed team name `hana-id-staff`.

### D89. Owners invite teammates; a new owner is a viewer for 24 h (amends D29)
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` "Invites", open
  question 6
- Decision: still invite-only, no sign-up. Hana creates orgs and invites the first owner. Owners can then invite
  viewers and owners to their own org. Every invite needs a fresh Google sign-in and notifies every owner and security
  contact of the org. A new owner is a viewer for 24 h, then becomes an owner unless cancelled (by an owner, Hana
  staff, or the cancel link in the notice). Hana staff can add and remove members in the admin portal.
- Why: partner self-service for teammates without a Hana ticket; the wait and the notice give the other owners and
  contacts the same window as guarded changes, so a hijacked owner account can't quietly add a co-owner.
- Rejected: Hana-issued invites only (D29 as first written); owner invites without the 24 h wait.

### D90. Retention: statements 7 years, raw usage 24 months, audit 5 years
- Date 2026-10-29 · Status: confirmed by the user; periods to be confirmed by the company's accountant before launch;
  built on `feat/batch-c-13` (the monthly job, the Neon functions, the audit purges and the erasure path; D360–D369),
  not deployed · Source: `docs/batch-c-spec.md` "Retention", open question 10
- Decision: monthly statements and settlement records (statement files, `usage.statements`, `near_usd_rates`,
  `gas_settlements`) 7 years. Raw usage events 24 months; then the uid hash is removed and the de-identified rows are
  kept. Audit logs (`audit_log`, `app_changes`, `guarded_changes`) 5 years. An automatic monthly purge job applies it,
  and the admin portal shows its runs.
- Why: Hana is an Australian company: the ATO requires business records for 5 years, and APP 11 (Privacy Act) requires
  personal information to be destroyed or de-identified once no longer needed. 7 years leaves room for disputes over
  billed periods.
- Rejected: the draft's 400-day ledger and 36-month audit (shorter than the ATO's 5 years); keeping uids for good.

### D91. Gas of relayed-then-rejected calls isn't billed by default
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` open question 11
- Decision: not billed by default; shown as its own statement line. The admin portal alerts when a partner's
  rejection rate exceeds a threshold (provisional: 5% of relayed attempts). Contract terms may bill partner-caused
  rejections above it.
- Why: third parties can trigger rejections (~2.2 Tgas each, e.g. replays of public signed derives), so billing them
  by default charges partners for others' traffic; the alert catches a partner bug that causes them.
- Rejected: billing every rejected call; hiding the cost inside the gas total.

### D92. Statements: CSV, on-screen and PDF with the same totals and hash
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/batch-c-spec.md` "Monthly statements",
  open questions 14 and 16
- Decision: each frozen monthly statement is a CSV, an on-screen statement (admin and partner consoles) and a PDF
  generated with `pdf-lib`; all three carry the same totals and the statement hash (the CSV's sha256). Tax invoices
  come from the accounting software and quote the statement.
- Why: finance teams want a PDF; one hash ties the three together; Hana ID doesn't invoice (D31).
- Rejected: CSV only; invoices issued by Hana ID.

### D93. Batch C spec: the remaining open questions take the spec's recommendations
- Date 2026-10-29 · Status: defaults approved by the user, not built · Source: `docs/batch-c-spec.md` open
  questions 7, 8, 12, 13, 14, 15, 17–25 and part of 3
- Decision, by question:
  - Q3 (part): sandbox-dev runs on `workers.dev` with the thin-Worker origins until the Hana account exists.
  - Q7: the console sink scope, rolled out on sandbox-dev before the address freeze.
  - Q8: seven Workers (console-auth and files as thin Workers, D66).
  - Q12: production `change_delay_ms` 24 h (= `appChangeDelayMs`); partners don't set their own delays in batch C.
  - Q13: the daily nonce cross-check as read (each relayer key's latest landed nonce must have a ledger row); daily,
    no indexer.
  - Q14: `pg` and `pdf-lib` as runtime dependencies, exact-pinned.
  - Q15: logos PNG, JPEG or WebP only, re-encoded (Cloudflare Images binding), never SVG.
  - Q17: a daily NEAR/USD rate from a single source (e.g. CoinGecko) named in the service contract, with an audited
    manual override; testnet pilot statements valued at the mainnet price and labelled.
  - Q18: no hash chain in the MVP; the accounts are the trust root.
  - Q19: coarse network data on console sessions for 90 days.
  - Q20: Cloudflare's Workers rate-limiting binding in the console Worker; the API's `RateLimiter` only if the binding
    isn't available on the account's plan.
  - Q21: breaker 5 per org and 20 across orgs per hour, counted per call.
  - Q22: settlement reads `tx` once per relayed transaction; revisit at scale.
  - Q23: owner-action caps as designed (20 per scope per day; safety budget 10 per scope per day, 100 global).
  - Q24: no two-staff rule for staff proposals in the MVP.
  - Q25: partners test locally against a Hana-run testnet env with its own console; production keeps refusing
    loopback.
- Still open: Q1 (the console code flow's `openid`-only token, to test), Q3 (Hana Cloudflare account, zone, domains,
  who holds access), Q4's fallback email addresses, Q5 (Neon project setup), Q9 (moved to `docs/governance-spec.md`
  open question 17).
- Rejected: the alternatives each question listed.

### D94. Smart Placement for the API Worker
- Date 2026-10-29 · Status: superseded by D97 (fixed region) · Source: `docs/operations.md` "Logs and
  latency"
- Decision: the API Worker's generated config sets `placement: { mode: "smart" }`, so Cloudflare runs it near D1
  and the Durable Objects (APAC) rather than at the request's location.
- Why: from Malaysia, about 60% of workers.dev requests were served from Marseille; with D1 in APAC every serial
  query crossed continents, taking reload unlock from about 0.9 s to 2–3 s.
- Next if not enough: D1 read replicas (Sessions API); a custom domain once the Hana domain exists.

### D95. The vault's per-IP and per-share flood limits use Cloudflare's Rate Limiting binding
- Date 2026-10-29 · Status: in force on branch `perf/native-ratelimit`, not yet deployed (`apps/api/src/vault/limits.ts`,
  `apps/api/src/vault/endpoints.ts` `vaultLimits`, `shareLimit`; `ratelimits` written by
  `apps/api/scripts/gen-wrangler.ts`) · Source: sandbox-dev re-measure after D94 (`unlockServerGate` 0.12–0.13 s in
  some runs, 0.60–0.73 s in most: the limiter object round trips)
- Decision: on `/v1/vault/*` the per-IP limit (60/min per IP per app) and the per-share limit (10/min per share) move
  from `RateLimiter` objects to two Workers Rate Limiting bindings, `VAULT_IP_LIMIT` (namespace `95001`, 60 per 60 s)
  and `VAULT_SHARE_LIMIT` (namespace `95002`, 10 per 60 s). Keys are `<env>:vault-ip:<appId>:<ipSubject>` and
  `<env>:vault-share:<appId>:<shareIdHex>`. The order is the one before D78, with no refund: IP limit, then the
  app's vault quota (still the `app:<id>` object, 10 × `per_minute`), then the body, then the share limit, so a
  request the IP limit refuses never touches the app quota and the share limit counts only requests that passed
  both. `RateLimiter.refund` is removed. A refusal is still `429 rate_limited` with the same messages; its
  `retry-after` is the binding's period (60), since the binding doesn't say when its window ends. A binding that
  throws refuses (`503 rate_limiter_unavailable`). An unlock now makes one limiter object call (the app's), not two.
- Effective change: nominal limits and periods are the same (both were per minute; the binding allows 10 or 60 s).
  The bindings count per Cloudflare location and are approximate (eventually consistent, can admit more than the
  limit while counts sync), where the objects counted globally and exactly. That is acceptable for flood limits:
  a share action still needs the session key's signature over a fresh counter, and the app quota, which bounds what
  one client can take from every other user of the app, stays exact. With Smart Placement (D94) most requests run in
  the placed location, so per-location counting is close to global in practice.
- Stays on the `RateLimiter` object (exact, global): the vault's per-app quota; the relay endpoints' and
  `GET /v1/app`'s limits (per IP, per app minute and day); key exports (3/hour per user path, D59); the login
  relay's per-IP limits; owner actions (per IP and global) and the owner-token single-use markers. These are either
  quotas other users share, limits small enough that drift matters, or test-and-set state the binding can't hold.
- Plan and tests: Cloudflare's docs (bindings page, Workers pricing and limits) list no plan restriction for the
  binding and no charge beyond Worker requests; GA since 2025-09-19, wrangler ≥ 4.36. It can't be confirmed on the
  free sandbox-dev account without a deploy: a deploy the plan refused would fail as a whole, never run without the
  limits. Miniflare simulates it locally (`wrangler dev`, `@cloudflare/vitest-plugin`), counting exactly, so the
  tests exercise the real limits.
- Rejected: asking the IP and share objects in parallel and the app after (D78's shape, still one extra hop and
  the refund); moving the app quota to the binding (it is shared by every user of the app and must be exact);
  a 10 s period (60 per minute as 10 per 10 s would refuse bursts the minute limit allows, such as several users
  behind one address reloading at once).

### D96. Support ID for end users; Hana contacts only partners
- Date 2026-10-29 · Status: confirmed by the user, for batch C and Hana Home · Source: conversation on support
- Decision: Hana keeps contact details only for partners and their staff (members, security contacts, billing
  contact). End users are never contacted by Hana and no user email is stored. For support, users get a **Support
  ID**: a short code (e.g. `HANA-7F3K-92QD`) derived from the app's hashed user id (HMAC with a Hana secret), shown in
  the Hana popup and Hana Home and included in "Copy diagnostics". Staff paste it into the admin portal to see that
  user's sessions, logins, errors and consents; it reveals no email or Google account and only works with Hana's
  secret. Partners escalate with the Support ID plus request IDs.
- Rejected: an opt-in user contact email (partners own user communication).
- Amended 2026-10-30 (email login, D119; not built): Hana still stores no end-user email address (the Google email
  is handled transiently off chain at link time, only its HMAC kept, D25). It still never contacts users except for
  two kinds of message the user's own action triggered: sign-in codes and link notices, sent to the address while
  the issuer holds it in that call. No encrypted address is kept for security notices; those are in-product only.
- Amended 2026-11-04 by D269: the email issuer now stores each user's verified address (its user directory, for
  Hana staff only; partners never see it). Hana still contacts users only with the two kinds of message above.

### D97. The API Worker runs in a fixed region next to D1 (replaces D94's Smart Placement)
- Date 2026-10-29 · Status: deployed to sandbox-dev · Source: `docs/operations.md` "Logs and latency"
- Decision: `placement: { region: "aws:ap-east-1" }` (Hong Kong, where Smart Placement had put it beside D1 APAC).
- Why: Smart Placement only forwards from locations it has learned (up to 15 min of steady traffic after each
  deploy); requests entering in CDG or MRS ran there and paid a Europe–Asia trip per D1 query. With the pin every
  response showed `cf-placement: remote-HKG`.
- Remaining: from Malaysia most workers.dev requests enter in FRA/CDG, so each request still crosses to Asia once
  (about 1–1.7 s for `GET /v1/app`, 0.36 s when it enters in SIN). Fix by routing: a custom domain on a Hana zone,
  tested on the free and a paid plan.

### D98. Hana Home: the spec's open questions answered
- Date 2026-10-29 · Status: confirmed by the user, not built · Source: `docs/hana-home-spec.md` "Confirmed by the
  user"
- User decisions: Enterprise branded clients kept alive ≥ 2 years after a partner leaves, with a contract right to
  enable shared login at exit (Q3); no opt-out from Home access, Enterprise may choose a quieter listing (Q8); Home
  derives billed to an active partner as their own statement line, Hana pays after exit (Q12).
- Defaults approved: directory only; partner-held clients best effort; `disable_shared_login` delayed (contract
  change); keep a shared client in force; one login opens both chains' export for ≤ 5 min; no re-auth to view;
  "Sign out this device"; coarse device labels; the proposed limits; consent recording fails closed; Home signs in
  with the first shared client; `/home` on `authOrigin`; legal review before mainnet.

### D99. The approval popup opens in the partner's click; the launcher is the fallback
- Date 2026-10-29 · Status: in force (`packages/web/src/client/approval-window.ts`, `src/auth/approve-page.ts`,
  `src/vault/approvals.ts`; `hana:approve-close`, `popupOpened` and `approvalWindow` in
  `packages/core/src/protocol.ts`) · Source: conversation (decided by the user); amends `docs/batch-b-spec.md`
  "Approval flow" steps 1–3
- Decision: when a partner calls a signing method (the EIP-1193 signing methods, `hana.stellar` and the Stellar
  Wallets Kit module, `signRaw`, `requestAutoApprove`, the Sodax adapters) from a user's click, the SDK opens
  `{authOrigin}/approve?from=partner&v=<vault frame name>` (`hana-approve-<32 hex>`, `popup,width=420,height=680`)
  synchronously in that click, as login does, and flags the request `popupOpened`. It does so only with transient
  user activation (`navigator.userActivation.isActive`; when the API is missing it tries anyway), and opens nothing
  while an approval popup is already open (its own, or the vault's, reported by `approvalWindow`), which is reused.
  The popup finds the vault through `window.opener.frames[v]` and accepts messages only from it, authenticated as the
  login popup does (origin `vaultOrigin`, that exact frame, whose parent is the opener); the vault accepts the
  popup's hello only from `authOrigin` and a window whose opener is its parent. From then on the protocol, the digest,
  the guard and the 15 s reuse are unchanged. The vault adopts the popup for the head of its queue (requests already
  queued keep their order), holds its launcher up to 3 s for the hello of a flagged request, tells a second window
  to close while one is in use, and tells a popup that has shown nothing to close (`hana:approve-close`) when its
  request ends without an approval screen (auto-approved or refused), on arrival if its hello comes later (within
  8 s). The popup stays blank for 0.6 s and closes itself after 8 s if no request reaches it.
  `hana.prepareApproval()` opens the window early for a signing call made after an await (a quote fetch). Without
  activation, or when `window.open` returns null (Safari after an await, a popup blocker), the vault's "Review in
  Hana" launcher works as before.
- Why: one click less on every signature, the same as login, and no small button to find; Safari keeps working
  through the fallback.
- Security: the partner page holds a WindowProxy to the popup and can navigate or close it; that is no more than a
  malicious page opening its own fake popup, since users trust the popup's address bar (`authOrigin`), and the popup
  never shows or answers anything but the authenticated vault. The guard (D36) is unchanged. `docs/security.md`
  "Approval popup opened by the partner page".
- Rejected: opening the popup only from the vault's launcher (an extra click per signature); having the partner page
  relay requests to the popup (the popup would have to trust the partner page).

### D100. Security sweep fixes (API, operator tooling, CI): quotas after verification, owner-action caps per owner and scope, CKD key from three providers
- Date 2026-10-29 · Status: in force (branch `fix/sweep-api`); the owner-action caps amended by D236 (batch C6: the
  per-scope day cap 20, `remove_client` and `disable_shared_login` on the cancel windows, the nonce recomputed off
  chain); the second code owner `@mj-hana` is in `.github/CODEOWNERS` on every owned path since 2026-10-30 · Source: security sweep 2026-10-29 (OPER-1, APIW-1,
  APIW-3, OPER-2, OPER-3, APIW-4, APIV-3, APIV-7, OPER-5, OPER-6, OPER-11; `docs/security.md` "Security sweep
  2026-10-29"); owner answers of the same day; amends D58
- Decision:
  - **CKD network key pin (OPER-1).** `fetch-ckd-key` reads the MPC key at one final block from at least three
    independent RPC providers (distinct registrable domains: the manifest's `rpc`, `rpcFallback`, each `--rpc`, then
    built-in public endpoints) and writes nothing unless every one reports the env's chain, the same block hash and
    the same key; the block height, hash and provider hosts are recorded as `ckdNetworkKeySource`. The manifest
    schema requires https for `rpc`, `rpcFallback` and `apiUrl` outside `local*` envs (there, http only for a loopback
    host). Before a mainnet pin the key is also compared with NEAR's published MPC key material.
  - **Relay quota (APIW-1).** The app's `per_minute` / `per_day` quota is counted only for a request that passed
    every off-chain check, right before the relay; only the per-IP window is asked before verification.
  - **Owner actions (APIW-3).** Caps per owner identity (5/min, 30/day), per scope (10/min, 50/day) and global
    (20/min, 200/day) for authenticated actions; `execute_change` (no auth) has its own per-scope window (10/min,
    50/day) and the global one; `cancel_change` counts against none of these, only 5/min, 20/day per owner identity,
    25/min, 100/day per target scope (the contract's `MAX_OWNERS` at their cap) and a spend-bound ceiling of 100/min,
    1000/day. Windows are asked from the most specific in and a refusal takes back the earlier hits. A cancel or any
    authenticated action without an owner identity is refused.
  - **Secret scan (OPER-2).** `.gitleaks.toml` has rules for NEAR secret keys, `VAULT_KEK` values, Worker-secret
    lines and Hana's secret files by name; `scripts/secret-scan-selftest.mjs` proves them on generated fakes in the
    tests and in CI.
  - **CODEOWNERS (OPER-1, OPER-3; amends D58).** Also `/envs/`, the API, web, core and watchdog sources, `scripts/`,
    the lockfiles, `.gitleaks.toml`, `.githooks/` and `.github/`. A second owner is decided; their handle is a TODO
    until known.
  - **Smaller fixes.** `/v1/derive` checks the app key's shape always (APIW-4). The API Worker's Workers Logs keep its
    own lines but not invocation records, which carry relay ids in the URL (APIV-3). Relay errors never return RPC or
    runtime error text. The admin CLI refuses origins the API drops, Hana's own origins and loopback origins for
    `pk_live_` apps or outside dev envs, and app names with control, bidi or zero-width characters (OPER-6, OPER-11);
    the API never treats the literal `http://localhost:*` as an origin (APIV-7). `gen-wrangler --dev-vars` refuses
    readable secret files and writes `.dev.vars` fresh (OPER-5).
- Why: each closed a way to break a trust anchor (a lying RPC at pin time), deny service with public inputs (junk
  against a shared quota, one owner starving another scope's cancel window), or leak a secret past the controls
  meant to stop it (gitleaks missing every Hana secret shape, relay ids in platform logs).
- No address or key derivation changes: sandbox-dev's pinned key was re-read from three providers and is unchanged.
- Rejected: a per-app pre-verification flood window (junk could still lock the app out); one global cancel ceiling
  (any scope's owners could starve another's cancels); recomputing `owner_action_nonce` off chain now (needs a borsh
  port of `Change`; the caps already confine a wrong-nonce flood to its owner's own windows; still worth doing).

## Security sweep fixes: core, web and SDK (2026-10-29)

From the security sweep of `develop` @ 91609c4 (findings CORE-*, AUTH-*, VAUL-*, PART-*). Numbered from D110 so they
can't collide with the entries the parallel API, contract and watchdog fixes add from D100.

### D110. Stellar classic operations are decoded; account-control operations get a red warning and are never auto-approved
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/decode/stellar.ts`
  `stellarAccountControl`, `src/policy/match.ts`, `src/policy/validate.ts`; `packages/web/src/auth/render-approval.ts`)
  · Source: user decision on sweep finding CORE-1; amends `docs/batch-b-spec.md` "Approval flow" step 4
- Decision: the decoder reads every operation type the XDR defines, field by field: `setOptions` (signer key,
  type and weight, added or removed; master weight; low, medium and high thresholds; set and clear flags by name;
  home domain, shown as hex when it isn't display-safe; inflation destination), `accountMerge` (destination), path
  payments strict send and receive (send asset and exact or maximum amount, destination, destination asset and
  exact or minimum amount, path), offers, `allowTrust`, `manageData`, `bumpSequence`, claimable balances,
  sponsorship, `clawback`, `setTrustLineFlags` and liquidity pools. An operation type the library doesn't know is a
  decode error (the popup refuses the request) instead of a raw-XDR line.
- Account control: a `setOptions` that touches a signer (any weight, 0 included), a threshold or the master weight,
  and every `accountMerge`, is an account-control operation. The popup puts a red, bordered banner at the top of the
  transaction ("Danger: this transaction changes who controls a Stellar account…") and one warning per operation
  that names the new signer and its weight, the thresholds, the master weight (weight 0: "you lose control of it")
  or the merge destination ("It can't be undone"). The matcher refuses them first, whatever the policy lists
  (`account_control`); the validator refuses a Stellar section with a key naming classic operations
  (`operations`, `setOptions`, `accountMerge`, `signers`, `payment`, path payments, …) on top of the unknown-key
  refusal. Everything is still rendered with `textContent`.
- Not done: an extra confirmation step on top of the warning (the Approve guard, D36, still applies).
- Rejected: keeping "shown by type with raw XDR" for classic operations (a compromised partner page plus one click
  could add a signer or merge the account away).

### D111. The export window keeps the key 5 minutes at most, and never past the session
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/auth/export-page.ts`
  `EXPORT_KEY_LIFETIME_MS`, `end`; `packages/web/src/vault/vault.ts` `cancelExport`, `onExportHello`;
  `hana:export-end` and `export-context.sessionExpiresAtMs` in `packages/core/src/protocol.ts`) · Source: user
  decision on sweep finding AUTH-1 (merged with VAUL-5); amends `docs/batch-b-spec.md` "Key export" step 5
- Decision: the export window erases the derived key from memory and from the screen at the first of: 5 min after
  it is derived; the vault session's end, from the context's `sessionExpiresAtMs` (server-corrected) or a
  `{v:1, t:"hana:export-end"}` the vault posts from `cancelExport` (logout, revoke, expiry, a newer login, and the
  vault's 15 min job limit, now also for a window that already has its context); its vault frame going away
  (`opener.closed`); and the window closing. The deadline is a timer (which a device clock change can't move) plus a
  server-clock check before every confirm and reveal and when the tab becomes visible again. The window then shows
  "Export ended" with the reason and no button: exporting again needs a new export from the app, so a new window and
  a new Google sign-in. `hana:export-end` is accepted only from the opener with origin `vaultOrigin`.
- Also (sweep AUTH-6, AUTH-4): the revealed key is no longer in an `aria-live` region, so a screen reader reads it
  only when the user moves to it; the key element and every auth page are `translate="no"` (plus
  `<meta name="google" content="notranslate">`), so a page translator neither rewords a request nor sends a key out.
- Not changed: idle (D55) dims the vault's PRK but doesn't end the session, so it doesn't end an export; the
  5 min limit bounds that case.
- Rejected: closing the window from the vault (no explanation for the user; the message does the same and the page
  says why); keeping the key for as long as the tab is open (an unattended tab would hand the key to anyone at the
  device).

### D112. Refused key requests don't count as activity for the in-memory idle limit
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/vault/vault.ts` `dispatch`,
  `refuseEarly`, `dormantConsentInForce`) · Source: sweep finding VAUL-1 (Low); refines D55
- Decision: before a key request counts as activity or unlocks a dormant session, the vault runs the checks that
  need no key: a sign request goes through `approvalSubject` with raw signing allowed (another address, a malformed
  request, a mainnet for a test app, a raw request from a test app), a second `hana_export` is `busy`, and
  `hana_revokeOtherDevices` on a share that isn't fresh (a reload-unlocked share never is) is `share_not_fresh`. A
  refused request changes nothing. `hana_requestAutoApprove` counts only when it shows the consent screen; with a
  consent in force it answers without counting, and a dormant session answers it from its last known consent
  without an unlock.
- Threat model for D55, written down: the idle limit bounds an abandoned tab and stops a page from keeping PRK
  in memory with requests that fail. It doesn't bound a hostile page that gets requests signed under an accepted
  policy, or that reloads the vault frame (a reload unlocks a `'session'` record, as designed); the absolute expiry
  bounds both.

### D113. A keyboard Approve needs Approve to hold focus for 500 ms first
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/auth/approve-guard.ts`
  `KEYBOARD_DWELL_MS`, `primaryFocused`, `mayActivate`; `approve-page.ts`) · Source: sweep finding AUTH-3 (Low);
  extends D36
- Decision: on top of D36 (1 s after render and focus, an arming gesture, a click whose own keydown came after it), a
  keyboard click on Approve or Allow acts only if its keydown came at least 500 ms after the button gained focus. A
  blur of the button, and every new request or consent screen, restarts the wait. Pointer and touch clicks are
  unchanged.
- Why: on a plain screen the focus order is Reject, then Approve, so a partner page could coach a user into a
  "Tab, Tab, Enter" rhythm and then trigger a request; typed in one go, Enter now lands too soon and does nothing.
- Residual (accepted, as D36's tap-spam case): a user coached to Tab to Approve, pause and press Enter still
  approves, as a user coached to click Approve does.
- Not done: the guard's marks still use the page clock (`Date.now`), not `performance.now()`; a device clock change
  during the 1 s or 500 ms waits can only shorten them by that change, and needs local access.

### D114. Public entries trimmed: one EIP-712 hasher, no public HanaClient constructor
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/index.ts`,
  `src/signers/evm.ts` `signTypedData`; `packages/web/src/index.ts`) · Source: sweep findings CORE-5, PART-5 (Info)
- Decision: `@hana-id/core` signs typed data only with `typed-data.ts`'s `hashTypedData` over
  `normalizeTypedData`'s output (`signTypedData(d, NormalizedTypedData)`), the same parser the popup renders from.
  The second, looser hasher (`signers/eip712.ts`) and its root exports (`encodeType`, `typeHash`, `hashStruct`,
  `domainSeparator`, `TypedDataForHashing`) are gone from the package; it lives on as a test-only reference
  (`packages/core/test/eip712-reference.ts`) that the tests check against `typed-data.ts` and viem. `@hana-id/web`
  exports `HanaClient` as a type only: its constructor takes Hana origins, so `createHana`, which resolves them from
  the build's pinned envs, is the only way to build a client.
- Effect on partners: none in the documented API (`createHana` returns the same `HanaClient`).

### D115. A live app's RPC, Horizon and Soroban URLs must be https (loopback excepted)
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/client/urls.ts` `serviceUrl`, used by
  `validateEvmConfig`, `validateStellarConfig` and `packages/sodax/src/http.ts` `httpUrl`; `HanaClient.testApp`) ·
  Source: sweep finding PART-3 (Low)
- Decision: for a `pk_live_` key, createHana and the Sodax adapters refuse an `http://` RPC, Horizon or Soroban RPC URL
  unless its host is loopback (`localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`). `pk_test_` keys keep accepting
  `http://` anywhere (local and LAN test stacks). Every key refuses other schemes and URLs with credentials (which
  `fetch` refuses anyway). The adapters read the new `hana.testApp` getter; a client object without it gets the
  strict rule.
- Why: over plaintext http an on-path attacker fills fees and nonces, answers every read (balances, quotes) and sees
  every broadcast; for real funds that is never acceptable, while test stacks often run a node on another machine.

### D116. Auto-approved signatures outlive the consent: said on the consent screen; the ledger cap waits for a trusted ledger source
- Date 2026-10-29 · Status: partly in force on branch `fix/sweep-web` (`packages/web/src/auth/render-consent.ts`
  `lingeringSignaturesNote`); the cap is proposed, not built · Source: sweep finding CORE-3 (Low)
- In force: every consent screen says that stopping auto-approving doesn't cancel signatures the app already has (a
  transaction until it expires, a Stellar authorization until the ledger it names, typed data until its own
  deadline).
- Proposed default for the cap: refuse to auto-approve a Soroban authorization (`stellar_signAuthEntry`, and address
  credentials the user signs) whose `signatureExpirationLedger` is more than 720 ledgers (about 1 h at 5 s) past the
  current ledger, and send it to the popup instead. Not built, because the vault has no trusted current ledger: it
  reaches no Stellar node (its CSP allows the API, NEAR RPC and Google only), the partner page's Soroban RPC is the
  party this guards against, and an estimate from the clock drifts (close times vary) and breaks on testnet resets.
  It needs the API (or a pinned Soroban RPC in the vault's CSP, with a manifest field) to give the vault the latest
  ledger per network: a change in `apps/api` and `packages/env`, for the API side of the sweep fixes. EIP-712
  deadlines have no standard field; a policy-declared deadline field with a maximum horizon is the follow-up there.

### D117. The vault's shared-mode login check also confirms the client is a shared client
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/web/src/vault/login.ts` `checkScope`,
  `src/vault/near.ts` `sharedClients`) · Source: sweep finding VAUL-4 (Info); extends D56
- Decision: in shared mode the vault checks, in parallel with `get_scope` (`allow_shared`), that the Google client
  the API named is one of `get_config().shared_clients` in force; otherwise the login is refused
  (`config_mismatch`, `scope_mismatch`) before Google's answer is relayed. A compromised API can no longer run a
  shared-mode sign-in through a client of its choosing (the chain would refuse that session anyway; this stops it
  before the user signs in and before gas).
- Cost: one more optimistic view per shared-mode login, in parallel, while the user is at Google.

### D118. One property-based display-safety rule, app names included
- Date 2026-10-29 · Status: in force on branch `fix/sweep-web` (`packages/core/src/display-safe.ts`
  `isDisplaySafeText`, `isDisplaySafeLine`; used by `decode/message.ts`, `policy/validate.ts`, `protocol.ts`
  `isAppName`, `api-types.ts`, `packages/web/src/vault/config.ts`) · Source: sweep findings AUTH-5 (merged with
  CORE-4) and AUTH-2 (Low)
- Decision: the hand-written range lists are replaced by one rule: refuse `\p{Cc}` (multi-line text keeps tab, LF,
  CR), `\p{Cf}`, `\p{Co}`, `\p{Zl}`, `\p{Zp}` and the other default-ignorable code points (U+034F, the Hangul
  fillers, U+17B4/U+17B5, U+180B–U+180F, every variation selector). Messages and decoded strings that fail are shown
  as hex; policy labels and names fail validation; an app name that fails makes the vault config, `GET /v1/app`'s
  answer and every popup message carrying it invalid, so a bad name stops the app's Hana pages rather than spoofing
  them (the admin CLI should refuse such names at write time: OPER-11, for the scripts side). `CHECK_MARKS` also
  strips U+10102 and U+1FBB1. App names, origins and decoded values are bidi-isolated in the auth pages' CSS.
- Trade-off: an emoji written with U+FE0F (❤️) makes a message show as hex and a label invalid. Unassigned code
  points stay allowed, so the validator gives the same answer on every engine.

### D120. Partner identity token, with opt-in verified email per app
- Date 2026-10-29 · Status: confirmed by the user; build steps 1–4 (no email claim) deployed on sandbox-dev 2026-11-02
  (D127, D170–D179); the email claim, KMS signer and watchdog pin check not built · Source:
  conversation; `wend-api` (`src/auth/privy.ts`, `src/user/privy-identity.ts`) as the reference use
- Decision: Hana issues a short-lived (≤ 1 h) JWT a partner's backend can verify against Hana's published keys,
  obtained by the SDK without a popup (`hana.getIdentityToken()`; the vault proves its session with the session key).
  Claims: `aud` = the app, a stable per-app pseudonymous user id, the wallet addresses, `iat`/`exp`, and a session id
  hash (`sid`) so partners can keep one session per device. **Opt-in per app: a verified email claim**: when a partner
  enables it, Hana asks Google for the email for that app only (Google's screen shows the extra consent), puts it in
  the identity token off chain, never on chain, and doesn't store it; for email-login users the address comes from
  the login. The token can't unlock wallets or sign, and Hana's own APIs never accept it.
- Why: partners' backends need a trusted user identity tied to the wallet (Wend verifies Privy's identity token for
  verified email + wallets: whitelist, credit programs, referrals, retargeting; and Privy's `sid` for one session per
  browser). Hana's session model has no bearer token to reuse, by design.
- Rejected: JWT-based login sessions (bearer tokens; the session key + server share model stays).
- Amends: D25 and D96 for apps that opt in (Hana handles the Google email transiently and passes it to that partner).

## Email login and account linking, confirmed by the user 2026-10-29/30

From `docs/email-login-spec.md` (its 22 open questions, all answered). D119 is the number the spec reserved; D120 was
taken in the meantime, so the rest start at D121. D4, D25 and D96 are amended above.

### D119. Automatic account linking, Privy-style, decided by whether Google hosts the mailbox
- Date 2026-10-29/30 · Status: confirmed by the user, not built · Source: conversation (the user's `demo.privy.io`
  test); `docs/email-login-spec.md` "The four cases", Q14–Q16, Q19, Q21
- Decision: per scope, identities form accounts (a root whose path is the wallet, ≤ 3 members, one per provider);
  the on-chain records hold pseudonymous ids only. A Google identity and an email identity with the same verified
  address match. **Google-hosted** = an `@gmail.com` / `@googlemail.com` address, or a Workspace account whose `hd`
  equals the email's domain; `hd` absent or different = not Google-hosted.
  - Case A (an email-login wallet exists, a Google login with the same email joins): Google-hosted → linked at once,
    silently (no screen or click, as Privy; decided 2026-10-30); otherwise a one-time code to the address first, then
    linked at once. Always a notice.
  - Case B (a Google wallet exists, an email login joins): the user continues with Google and reaches the wallet at
    once; the email → wallet link is created from that Google sign-in (never silently at a Google login).
    Google-hosted → linked at once; otherwise it takes effect after `change_delay_ms` (24 h in production) with a
    notice in the wallet and in the partner app (not only by mail: the mailbox may be the attacker's), cancellable
    within the window.
  - Explicit `hana.linkAccount()` for different emails: proofs of both identities, `change_delay_ms`, a notice.
  - Links are per scope; an `unlinked` pair is never re-matched automatically. The link mode (at once or delayed) is
    in the issuer-computed `auto_link` nonce.
- Why: Google-hosted means whoever passes Google's sign-in can already read the mailbox, so the link adds no power.
  Otherwise Google's `email_verified` only says the address was verified once (recycled or administrator-made
  accounts), so a fresh code (case A) or a cancellable delay (case B, the direction that lets the email issuer reach
  a Google wallet) is needed.
- Accepted: a Google-hosted case B link lets a compromised email issuer reach that Google wallet at once.
- Rejected: Gmail-only linking (Workspace with a matching `hd` is as safe); silent pre-linking at every Google login
  (would hand the email issuer every Google wallet); a delay instead of a code in case A; global links; a separate
  `link_delay_ms`.
- Amended 2026-11-04 by D269: on chain still pseudonymous ids only, but the issuer now keeps each identity's verified
  address off chain in its user directory (`user_emails`), for Hana staff.

### D121. Email issuer signing key: Worker secret on testnet, AWS KMS before mainnet, two-signer-ready
- Date 2026-10-30 · Status: confirmed by the user, not built · Source: conversation; `docs/email-login-spec.md`
  "Signing key (staged)", Q2, Q11–Q13
- Decision: testnet now: the RSA-2048 signing key is a Cloudflare Worker secret of the issuer (`ISSUER_SIGNING_KEY`,
  backed up in `.secrets/<env>/`). Before mainnet: AWS KMS `RSA_2048` in a dedicated AWS account; root access held by
  both founders with hardware security keys, recovery details offline; the issuer Worker's IAM access key limited to
  `kms:Sign` on the issuer's keys with the algorithm (and `DIGEST`) pinned, rotated every 90 days and on suspicion;
  CloudTrail; an hourly reconciliation of the KMS `Sign` count against the issuer's own login log; volume and budget
  alarms; alerts on any IAM or KMS policy change. A standby key in a second region. Mainnet never takes a
  Worker-secret key.
- **Two-signer-ready from day one:** the contract's email issuer config is a signer policy (signers with their keys,
  plus a required count of distinct signers; 1-of-1 at launch); email tokens use the JWS General JSON Serialization,
  which carries one or more signatures; the watchdog pins every signer's key fingerprints and the policy. Signer keys
  rotate through owner-posted `set_issuer_key` (72 h, pinned); the signer list and count change only through a
  governed contract upgrade. Adding a signer (going to 2-of-2) is one such upgrade, with a ~10-minute overlap
  (the token lifetime) accepting 1-signature tokens, and changes no address (`sub` doesn't depend on any signing
  key).
- Staged plan: **Level 1**, an independent audit-and-throttle co-signer on another cloud (e.g. Google Cloud KMS in a
  separate project and account), enforcing per-email (per-`sub`) hourly and global daily caps with its own log, once
  email users hold meaningful funds. **Level 2**, the code split between two senders, only if "no single Hana
  compromise" becomes a product promise. **Level 3**, a TEE issuer, later.
- Why: an exportable key is acceptable without real funds; on mainnet a stolen credential must be revocable and every
  signature logged. A multi-signer format from the start makes Level 1 an upgrade, not a token-format or address
  change.
- Rejected: KMS on testnet now (setup cost before it protects anything); Cloudflare Secrets Store (still
  exportable); CloudHSM (cost); Google Cloud KMS for the primary key (keeps the email key off the cloud that signs
  Google tokens; it fits the co-signer); a single-signature compact JWT for email tokens.

### D122. A matched person never gets a second wallet; no switcher
- Date 2026-10-30 · Status: confirmed by the user, not built · Source: conversation; `docs/email-login-spec.md`
  "The four cases", Q18
- Decision: when a match is detected, Google-hosted case A links silently (D119); every other match offers only
  "Link and continue" (D119's rules) or "Sign in with {the other method}"; the identity without a wallet never opens a session on its own path. No switcher: the contract has
  no `wallets` list or `wallet` argument, and its build step is removed. Case D (both already have a wallet) can't
  arise: sandbox-dev wallets opened before v3 are test data discarded at the address freeze, mainnet starts with v3,
  and different emails or different apps are separate wallets by design. Email hints don't expire while the scope
  exists (an expired hint would let a second wallet appear). If two wallets ever exist anyway (a Google account's
  address changed between logins), nothing merges them; each method opens its own.
- Rejected: merging two funded wallets; the switcher (one account, two wallets, chosen at login); a "create a new
  wallet" option on a match.

### D123. Email login spec: the remaining open questions take the spec's recommendations
- Date 2026-10-30 · Status: defaults approved by the user, not built · Source: `docs/email-login-spec.md` open
  questions 1, 3–14, 17, 19–22
- Decision, by question:
  - Q1: the issuer is its own Worker, `apps/email-issuer`, separate from the API Worker.
  - Q3: user mail via Resend (D87, still provisional until the colleague confirms), behind one sender adapter, on its
    own sending subdomain; the provider's message-log retention at the minimum. The provider is superseded by D194
    (SendGrid, final once the colleague agrees).
  - Q4: per-scope `aud` (`email:<scope_id>`, a scope client): a partner turns email off on chain with
    `remove_client`.
  - Q5: the issuer under `{apiUrl}/v1/email`.
  - Q6: `sub` = HMAC with `K_sub`; `K_sub` a Worker secret with two offline backups, never rotated.
  - Q7: the Gmail canonical form (dots and `+tag` ignored); Google's help pages cited in the guard test before the
    freeze. Amended 2026-11-02 (D159): a `+tag` is kept, each tag its own identity.
  - Q8: the code never in the mail subject.
  - Q9: no Turnstile on `authOrigin`; rate limits instead.
  - Q10: disposable-address domains blocked (a pinned list, `email_domain_not_allowed`).
  - Q11: the standby KMS key in a second region.
  - Q12: trust spread: Google signs Google tokens, AWS holds the email key (D121).
  - Q13: email issuer keys wait `governance_delay_ms` (72 h on mainnet).
  - Q14: links per scope.
  - Q17: no stored user email addresses, encrypted or not (D96): in-product notices only.
  - Q19: explicit and delayed case-B links wait `change_delay_ms` (24 h in production, D93).
  - Q20: partners enable email per app (partner console toggle plus the on-chain client).
  - Q21: one method per provider per account, 3 members.
  - Q22: the proposed rate limits (codes per address 3 per 15 min and 10 per day, wrong codes 10 per hour → 1 h lock,
    per-IP, per-app and a global daily send budget with a breaker), provisional until sandbox-dev measurements.
- Rejected: the alternatives each question listed.

### D124. Sign in with Apple on the roadmap, after email login
- Date 2026-10-30 · Status: confirmed by the user (roadmap); specced (`docs/apple-login-spec.md`), paused 2026-11-02 (D160) · Source: conversation
- Decision: Apple is the next login method after email login and the partner identity token. It plugs into the
  provider-neutral core: the wallet path `scope#provider#sub#key_index` (provider `apple`, so no existing address
  changes), `set_issuer("apple", ["https://appleid.apple.com"])` with its keys through the same delayed, cancellable
  key changes (D33), RS256 (already the contract's one algorithm), and accounts with one member per provider (D119).
  New per provider: the popup flow, client lookup in the API, manifest and partner-console client fields, the
  watchdog's JWKS check, and a Hana Home export path.
- Constraints for the spec:
  - Apple's `sub` is stable per Apple developer **team**, not globally (Google's is the same in every project). Every
    Apple client must sit in Hana's team: a partner's own team would give its users other subs and other wallets.
    Branded Apple clients only as Hana-held Services IDs (the D42 Enterprise tier).
  - Hide My Email (`…@privaterelay.appleid.com`) never matches by email; such users link by hand (`linkAccount`).
  - Requesting `email` makes Apple answer with `response_mode=form_post`, so the callback needs a POST route (today's
    `/login/callback` is a static page reading the fragment).
  - Automatic linking gets an "Apple-hosted" twin of D119's Google-hosted rule (`icloud.com`, `me.com`, `mac.com`),
    to be checked against Apple's documentation when specced.
- Why: the App Store generally expects iOS apps that offer a third-party login such as Google to also offer Sign in
  with Apple, so partners with native apps will ask for it.

## Governance and watchdog follow-ups, 2026-10-30

Decided while governance went live on sandbox-dev (the watchdog's hosting and drills) and while its recovery
playbooks were written (branches `feat/recovery-playbooks`, `feat/playbook-gaps`, `fix/watchdog-retired-key-race`).

### D125. Watchdog hosting: its own Cloudflare account in production; sandbox-dev shares the API's account
- Date 2026-10-30 · Status: confirmed by the user · Source: conversation (hosting options researched and ranked)
- Decision: production watchdogs run on their own Cloudflare account, separate login and MFA from the API's (D86 Q3
  stands). sandbox-dev's watchdog runs on the same Cloudflare account as its API and page Workers (the personal
  account, `tingtc.workers.dev`), for the drills only: on that env a compromise of the API's account can also silence
  the watchdog. The watchdog is deployed by hand from a founder's machine, never from CI (a GitHub compromise must not
  be able to ship watchdog code).
- Options considered (ranked 2026-10-30):
  1. **AWS Lambda + EventBridge Scheduler in a dedicated AWS account**: the strongest single option. Another
     provider than the API, security-key root login, CloudTrail and IAM, a reliable scheduler, free (EventBridge
     Scheduler 14M invocations/month and Lambda's 1M requests/month free tiers). Its own account, not the email
     issuer's KMS account (D121). Port: the Worker's platform code is ~425 of ~2,420 lines (`src/index.ts`,
     `src/store.ts`, `src/env.ts`); `store.ts` moves from D1's SQL to DynamoDB, the cron handler becomes a Lambda
     handler on a 5-min EventBridge schedule, `/status` and `/alerts` a Lambda function URL, the secrets Secrets
     Manager or encrypted environment variables, plus a deploy script. Everything else (checks, chain, channels,
     alerts) is `fetch`-based and moves unchanged.
  2. **A separate Cloudflare account** (chosen): no port, free, reliable; the residual risk is a Cloudflare-wide
     outage taking down the API and the watchdog together, which the heartbeat (dead-man's switch) on a third
     provider reports.
  3. Deno Deploy: the smallest port off Cloudflare (Workers-like runtime, Deno KV), free; `Deno.cron` is still marked
     unstable, at-least-once with up to 1 min drift, a younger platform with fewer account controls.
  4. Google Cloud Run jobs + Cloud Scheduler: workable, a container build, a fourth cloud for no gain over AWS.
  5. Fly.io (one always-on machine, SQLite on a volume, ~$2/month) and 6. a VPS: our own uptime and patching.
  - Rejected: GitHub Actions schedules (best-effort, often 15–30+ min late or dropped, and GitHub also hosts the
    code), Vercel cron (Hobby runs once a day; per-minute needs Pro at $20/month), Netlify scheduled functions
    (unclear cadence, short runtimes).
- Later option: a second watchdog on another provider (the contract takes up to 3, D86 launches with one), e.g. the
  Cloudflare one plus AWS Lambda, so one provider's outage or breach silences neither. The code is shared, so it is
  the port above plus a second NEAR watchdog account.
- Why: the separate Cloudflare account gives the independence that matters (separate credentials) with no new
  platform to learn or port to; AWS Lambda is kept documented in case provider diversity is wanted before mainnet.

### D126. The watchdog's pause for an active forged key also deletes every updater key
- Date 2026-10-30 · Status: confirmed by the user, built · Source: conversation (sandbox-dev pause drill)
- Decision: when the watchdog pauses because a key Google doesn't publish is active, it then deletes every updater key
  in `updater_keys`, whoever proposed the key (the executed change record is gone, and only the updater or the owner
  can post keys). An updater key added while such a key is still active is deleted at the next run, so recovery runs
  in order: remove the key, raise the session floor, install a fresh updater key, unpause (`docs/operations.md`
  "Watchdog alerts"). The pending path is unchanged (cancel, and delete the updater keys when the updater proposed).
- Why: in the drill the pause left the proposing updater key installed. A stolen updater key could then fill the
  6-slot pending-change queue (blocking Google's real rotations) and post again after an unpause if the council forgot
  to rotate it. A needless deletion costs one council vote in a recovery that needs council votes anyway.
- Also decided: every incident scenario gets a step-by-step recovery guide in the admin portal's "Security &
  monitoring" view (D83), from one source that a test keeps complete for every watchdog alert kind. Built (branch
  `feat/recovery-playbooks`): the source is `packages/playbooks` (`@hana-id/playbooks`), rendered as
  `docs/playbooks.md` by `gen-docs` (a test fails when it is stale); `apps/watchdog/test/registry.test.ts` fails when
  an alert kind has no playbook; `GET /status` serves each kind's `playbook` id and every alert text names it; the
  portal's Playbooks page is specified in `docs/batch-c-spec.md` (batch C, not built). `admin owner:call` now also
  sends `set_sessions_valid_from_ms` (the `forged_active_key` recovery needs it; it was missing from
  `OWNER_METHODS`).

### D150. The watchdog monitors the relayer's funds (read-only), with default thresholds and manifest overrides
- Date 2026-10-30 · Status: built (branch `feat/playbook-gaps`), defaults for review · Source: conversation (closing
  the recovery playbooks' "not built yet" steps)
- Decision: every run reads the relayer account (`view_account`, `view_access_key_list`, final) and raises condition
  alerts: available balance (`amount` minus storage) below 5 NEAR → warning `relayer_balance_low`, below 1 NEAR or no
  account → critical `relayer_balance_critical`; each pool key's remaining allowance below its pool's thresholds
  (session 0.5 / 0.1 NEAR of 2 NEAR, owner 0.1 / 0.02 NEAR of 0.5 NEAR) → `relayer_allowance_low` /
  `relayer_allowance_critical`; a pool with no key → critical `relayer_pool_empty`. Keys are assigned to a pool by a
  marker method (`derive_key` session, `propose_change` owner), so the session pool's planned allowlist states keep
  working. Thresholds can be overridden per pair in the manifest's `watchdog.relayerFunds` (NEAR). The watchdog never
  tops anything up: it holds no key on the relayer account, and funding stays a founder's manual step. Playbook:
  `relayer-out-of-funds` (now an alert playbook).
- Why: `docs/security.md` listed allowance monitoring as a mainnet requirement, and the relayer playbook could only
  say "you notice from failed logins". The watchdog already reads the chain every 5 min through its own RPC and pages
  both founders; a second monitor would duplicate that. Critical for the balance and per key, because a used-up key
  stops the logins of every app routed to it.
- Rejected: a total-allowance-per-pool threshold (one key running out still fails its apps); auto top-up from a
  funded account (it would put a spending key on the watchdog's account, against D82's minimal powers); thresholds as
  code constants only (a busier env or raised allowances need their own).

### D151. Council member replacement: remove first, then add, through the admin CLI; reject votes in the scripts
- Date 2026-10-30 · Status: built (branch `feat/playbook-gaps`), for review · Source: conversation (closing the
  recovery playbooks' "not built yet" steps)
- Decision: `admin <env> council:replace-member --remove <old> --add <new>` makes two Sputnik proposals on the
  council DAO, `RemoveMemberFromRole(<old>, council)` then `AddMemberToRole(<new>, council)`, signed and approved only
  by remaining members. It refuses unless the DAO's group is the manifest's council (or a half-done replacement it
  carries on from) with otherwise exactly the 2-of-3 council policy, the new account exists, and the manifest still
  validates with the new member in the old one's place. Dev envs may `--approve-with` (both execute in one command);
  elsewhere it proposes and prints each remaining member's `act_proposal`. Once the DAO has the new council, `--yes`
  writes `council.members` in `envs/<env>.json` (only that list; without `--yes` it prints the edit). `owner:vote
  --reject` casts a `VoteReject`.
- Why: removing first cuts a lost or stolen key off at once. Sputnik recomputes the threshold from the group's size
  (2 members: 2 of 2), so the window needs both remaining members, which the replacement needs anyway; adding first
  instead makes the removal 3 of 4, which needs the new member's vote too. Writing the manifest only after the chain
  shows the new council keeps `deploy-contract`'s policy check (`policyProblems`) meaningful.
- Rejected: one `ChangePolicy` proposal with the whole new policy (it can change anything else in the policy at the
  same time, which is harder to review than a member change); add first (needs three votes for the removal).

### D152. D1 recovery is D1 Time Travel, with a runbook for both databases
- Date 2026-10-30 · Status: documented (branch `feat/playbook-gaps`), not rehearsed · Source: conversation (closing
  the recovery playbooks' "not built yet" steps)
- Decision: a lost or damaged D1 (the API's `DB` or the watchdog's) is restored in place with `wrangler d1
  time-travel restore --bookmark` (30 days on the paid plan), after noting the current bookmark (the undo) and, for
  the API, exporting the damaged state to `.secrets/` (it holds wrapped vault shares). The runbook
  (`docs/operations.md` "Restoring a D1 database (Time Travel)") lists what a restore loses and what to re-run, in
  order: migrations, then security writes made since the point (suspensions, origin removals, a revoke-all) before
  anything else, then a KEK rotated since, then other app changes. For the watchdog it spells out the first-run
  baseline caveat (a point after the first run keeps the pause; before it, or no restore, means a first run that
  only alerts) and the gap caveat (a kid published and dropped inside the gap looks never published and pauses).
  The `d1-data-loss`, `watchdog-down`, `watchdog-compromised` and `watchdog-first-run` playbooks use it.
- Why: Time Travel is on by default for production-backend D1 databases and needs no code; the dangerous part of a
  restore is silently undoing a security response, so the runbook orders that first.
- Still open: a rehearsal on sandbox-dev (no wrangler or chain actions were run for this), and a backup kept beyond
  30 days and outside Cloudflare (an export of the apps tables, or batch C's Neon ledger, D73).

### D153. A key Google just retired isn't a forgery: cancel, keep the updater key, warn
- Date 2026-10-30 · Status: built (branch `fix/watchdog-retired-key-race`) · Source: a false
  positive on sandbox-dev (watchdog alert #10)
- What happened: at 16:30:07 (UTC+8) the API cron's JWKS fetch still listed Google kid `f10f8740…`, which wasn't on
  chain, so it proposed adding it (change 2). Google dropped the kid at about that time: the watchdog's next two
  fetches didn't list it, so it cancelled the change as forged and deleted the updater key. The proposed `n`/`e` were
  byte-for-byte what the watchdog itself had fetched from Google at 16:10. No attack: the two services saw Google's
  JWKS a few minutes apart, across a key retirement.
- Decision: an Add **by the updater** of a kid Google doesn't publish now, whose `n`/`e` equal what this watchdog
  fetched from Google (`seen_kids`, source `jwks`, not a first-run baseline) within the last 24 h
  (`RETIRED_KEY_GRACE_MS`), is a `retired_key_change`: the watchdog cancels it (a retired key has no use), keeps the
  updater keys, and raises a **warning** (Slack, email; no page). Everything else that was forged stays forged: a kid
  Google never published, other key material, a kid last seen more than 24 h ago, an owner proposal (the owner path
  never deletes updater keys), and any non-Google change from the updater. If the watchdog can't read `seen_kids` the
  change is treated as forged (fail safe).
- Why: a stolen updater key gains nothing from it. It can only re-propose Google's own key material, which is useless
  without Google's private key, and it would be cancelled anyway. Deleting the updater key on every retirement race
  stops Google key sync until a council member reprovisions it, and pages someone for nothing.
- Playbook: `retired-key-change`. The incident's alert #10 was acknowledged; the deleted updater key is reprovisioned
  through the council (`forged-key-change` step 5).

## Batch C build, step C1 (ledger, manifest fields), 2026-10-30

Made while building `docs/batch-c-build-plan.md` C1 (branch `feat/batch-c-1`), and its open questions 1, 2, 4 and 5.

### D140. The ledger's Postgres tests run on PGlite
- Date 2026-10-30 · Status: in force on `feat/batch-c-1` (`apps/api/test-usage`, `scripts/test/usage-migrate.test.ts`)
  · Source: batch C1 (`docs/batch-c-build-plan.md`); the spec's "Tests" said a real Postgres 17 (a Neon branch in CI
  or a local container)
- Decision: the usage ledger's DDL, roles, grants, functions and the migration runner are tested on PGlite
  (`@electric-sql/pglite` 0.5.11, exact-pinned: Postgres 18.6 compiled to WASM, in process), so `pnpm -r test` needs no
  network, container or Neon branch, locally and in CI. The same suite runs against a real Postgres 18 through `pg`
  when `USAGE_TEST_DATABASE_URL` names a superuser connection to a local server (a container); never Neon. Tests switch
  roles with `SET ROLE`, as the Hyperdrive connections of each role would run.
- Why: PGlite is the same server code as Neon's Postgres 18, so privileges, partitioning, PL/pgSQL and triggers behave
  the same; a Neon branch per CI run would put a Neon credential in CI and a network dependency in every test run.
- Not covered by PGlite: Neon's own role rules (the owner is `neon_superuser`, not a superuser) and Hyperdrive. The
  first `usage-migrate` on sandbox-dev and C4's capture smoke check those.
- Rejected: a Neon branch per CI run; a Postgres container as the default (needs Docker locally and in CI).

### D141. Ledger roles: created without login, no credential in the DDL, nothing for PUBLIC
- Date 2026-10-30 · Status: in force on `feat/batch-c-1` (`apps/api/migrations-usage/0001_ledger.sql`) · Source:
  batch C1; amends `docs/batch-c-spec.md` "Usage ledger" roles
- Decision: the migration creates `usage_writer` and `usage_admin` `NOLOGIN` if they don't exist; `usage-setup` (C4)
  gives each `LOGIN` and a generated password. Every migration ends with `REVOKE EXECUTE ON ALL FUNCTIONS … FROM
  PUBLIC` (Postgres grants EXECUTE on new functions to PUBLIC, which would have let the admin role call `record_event`
  and any role call the retention functions); a test checks each role's exact function list and that a role with no
  grants has none. The admin role gets `SELECT, INSERT, UPDATE, DELETE` on the `ops` tables instead of `CREATE` on the
  schema (it never creates objects, and owner-created tables weren't writable by it).
- Why: no secret in a committed file; the DDL runs unchanged on Neon, a container and PGlite; least privilege as the
  spec intended.

### D142. Loopback origins only in `sandbox-*` environments
- Date 2026-10-30 · Status: confirmed by the user · Source: batch C1 open question 1 (`docs/batch-c-build-plan.md`)
- Decision: `localhost` / loopback origins are accepted only in dev environments (`sandbox-*`, `local*`), both when an
  origin is registered and at the login gate; partners develop locally against Hana's sandbox environment. This
  replaces the spec's "any test scope in any non-production network" rule for origin input.
- Why: one rule enforced the same way in both places; otherwise a partner could register an origin that silently
  fails at login.

### D143. Production's usage ledger gets its own Neon project before mainnet
- Date 2026-10-30 · Status: confirmed by the user · Source: batch C1 open question 2
- Decision: the current Neon project (`hana-id`, branches `production` and `sandbox-dev`) serves dev and test; before
  mainnet a separate Neon project (AWS Sydney) holds the production ledger, with its own credentials, restore window
  and access list. The `production` branch of the current project is not used for mainnet.
- Why: a sandbox credential leak or a project-level mistake can never reach production billing data.

### D144. Support ID lookup is built from data Hana already keeps
- Date 2026-10-30 · Status: confirmed by the user; built in C15 on `feat/batch-c-15` (not merged; D394–D397, the uid
  through the wallet directory's internal id since D346) · Source: batch C1 open question 4 (D96)
- Decision: staff resolve a user's Support ID in the admin console from the usage ledger's pseudonymous user id plus
  each app's change history (`app_changes`): which apps it used, recent logins, errors and app setting changes. No
  dedicated support table and no email or name stored. A short spec section, reviewed by the user, comes before
  batch C15.
- Why: no new store of user data to protect or keep under retention rules.
- Rejected: a dedicated support table with more detail per user.

### D145. The owner-invite waiting period has its own setting
- Date 2026-10-30 · Status: confirmed by the user, built in batch C1 · Source: batch C1 open question 5 (D89)
- Decision: manifest `ownerGrantDelayMs` (a new owner is a viewer until it passes; owners can cancel) is separate
  from `appChangeDelayMs`, with the same bounds (at least 24 h on mainnet).
- Why: the two waits can be tuned independently; changing one never silently changes the other.

## Partner identity token spec, confirmed by the user 2026-10-30

The answers to `docs/identity-token-spec.md`'s open questions (the roadmap decision is D120).

### D127. Partner identity token: the spec's recommendations, all 16 questions
- Date 2026-10-30 · Status: confirmed by the user; build steps 1–4 (no email claim) built on `feat/identity-token-1`
  (D170–D175) · Source: `docs/identity-token-spec.md` open questions
- Decision: `sub` per scope (`"u1_"` + HMAC with a separate, never-rotated `IDENTITY_SUB_KEY`); ES256; minted by the
  API Worker; mainnet key in AWS KMS (non-exportable, own IAM user, D121's account; a Worker secret on testnet and
  `local*` only); lifetime 1 h capped at the session's end, `maxAgeMs` for fresher proof; email asked once per app at
  the first login in the Hana popup, always optional (no mandatory setting in v1), `requestEmailSharing()` to ask
  again; wallet addresses proven by a signature from each address's key once per session (no server registry);
  tokens on for every app (the email claim opt-in); no introspection endpoint; no cookie on the partner's domain;
  `login_methods` only (no `amr`/`auth_time` yet); trust by JWKS URL with optional pinned thumbprints and a watchdog
  pin check; `iss` = `{apiUrl}/v1/identity` on sandbox-dev and a stable Hana hostname in production, fixed before
  any partner goes live; a new `sid` at every interactive login.
- Why: each question's trade-offs are in the spec. Optional email sharing never affects which wallet a person gets
  (linking is D119/D122, from Google's verified address read transiently inside Hana).

## Batch C5: `AdminRpc` and `ConsoleRpc` core (2026-11-02)

Readings made while building `docs/batch-c-build-plan.md` C5 on `feat/batch-c-5`, where `docs/batch-c-spec.md` left a
detail open. Each follows the spec's intent; all five are **to confirm** by the user.

### D225. The legacy `apps.publishable_key` stays on a valid key; deleted apps stay suspended (C3's email-issuer obligation)
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/keys.ts` `syncLegacyKey`, `changes/suspension.ts`
  `deleteApp`, `scripts/lib/admin-apps.ts` `appSuspension`) · Source: D206's obligation for `apps/email-issuer`
  (branch `feat/email-login-4`: finds apps by `apps.publishable_key` and checks only `status`)
- Decision: rather than block key rotation and deletion for email-enabled apps (the API's DB has no `login_methods`
  column yet, so "email-enabled" can't be told apart), every key write keeps the legacy column pointing at the app's
  oldest key with `revoked_at` NULL (by creation, then insertion), or at a tombstone when it has none:
  `pk_<env>_0revoked` + random base58. The `0` is not in base58, so it is never a generated key and never matches the
  issuer's `PK_RE`. The scope's prefix keeps the 0006 org-move trigger satisfied. The column is written, never read
  (the source check in `apps/api/scripts/test/hot-db-reads.test.ts` allows exactly these two assignments). A deleted
  app keeps Hana's bit 1 for good: every RPC write on it is `not_found`, and the CLI's `app:suspend` / `app:resume`
  refuse it, so `status` stays `suspended` for the issuer's `appById`. The issuer therefore never accepts a revoked,
  rotating or deleted app's key. One cost: during a rotation's 24 h grace the old key keeps working for Google
  logins (the API reads `app_keys`), but the issuer refuses it at once.
- Still owed (D206): the issuer moves to `app_keys` (`revoked_at` NULL or in the future), `deleted_at IS NULL` and
  `suspended_by = 0`, which also gives email logins the grace. Its `apps/email-issuer` allowlist entry in the source
  check stays until then. Done in email login batch 6 (D233): the issuer reads only `app_keys`, so the tombstone in the
  legacy column matches nothing there either, and the allowlist entry is gone.
- Rejected: blocking rotation and deletion per app (not detectable on develop); pointing the column at the newest key
  (a second key created for a migration would break the first one's email logins).

### D226. `pendingNotices` also returns the app and the policy
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/lifecycle.ts`) · Source: spec §RPC
  (`pendingNotices` → `{change, contacts}`) and §Notice and cancel (the notice describes the app, the origin or the
  policy's contracts, functions and limits)
- Decision: each notice also carries `app: {id, name, orgId, scopeId, environment}` and, for a `policy_set`, `policy`
  (the canonical JSON, parsed). The change view alone has only the `policyId`. The fields are additive, so the admin
  Worker builds the notice without a second call per change. Changes of a deleted app are never listed.

### D227. Keys and no-op writes
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/keys.ts`, `settings.ts`, `suspension.ts`,
  `admin.ts`) · Source: spec "Keys" ("at most 5 unrevoked keys", rotate, revoke) and §RPC result types
- Decision: "unrevoked" for the 5-key limit means `revoked_at` NULL, so a key in its rotation grace doesn't count, and
  rotation never hits the limit. "The last valid key" and what revoke accepts count keys still valid now (a rotating
  key still logs users in): two counts on purpose. Only an unrevoked key can be rotated (a rotating or revoked one is `conflict`). A
  key in its grace can be revoked at once. Revoking the app's last valid key answers `{ok: true, warning:
  'last_key'}` (the spec's "warns"). A write that would change nothing writes nothing and answers the current state
  (a bit already set, nothing to turn off, the same settings, logo or contacts), with no ledger row. The breaker still
  counts the call (D93 Q21: per call).

### D228. Drift and breaker events: one per finding; what explains a value
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/drift.ts`, `changes/guard.ts`) · Source: spec
  "Drift detection" ("flags … once"), §RPC "Destructive-call breaker"
- Decision:
  - An origin in force is explained by an announced, open `origin_add` for that row whose `active_from` is no later
    than the row's, or by the 0006 baseline (`active_from = 0`, listed in `migration.baseline`).
  - An `app.created` row explains nothing on its own: since 0006 its origins are guarded changes, and counting it
    would let a forged in-force row for an unannounced initial origin pass.
  - A stored policy or `raw_sign = 'approval'` is explained by an announced change in force by then; a pending one by
    an announced change whose `active_from` is no later than its `*_effective_at` (catches a hand-advanced effective
    time); or by the baseline, whose policies are compared as stored text (D205), but only while no later
    `app_changes` row ended the baseline value (review M1: a value put back by hand after a kill switch is drift).
  - Each finding is written once: the event id is derived from it (app, what, the value or the origin and its
    `active_from`). A breaker refusal writes one event per org (or for the global limit) per clock hour.
  - The breaker and the hot-DB budget live on one `RateLimiter` object (`console-rpc`). A call is admitted or refused
    in one step, nothing taken on a refusal. The breaker keeps exact call times for the rolling hour. Each method is
    charged its declared ceiling (`CONSOLE_COSTS`: plan read + batch + one diagnostic read) before it runs.
  - The budget, after the C5 review (H2): per-org buckets (10/s, burst 40) under the spec's global one (30/s, burst
    60). The kill switches (`removeOrigins`, `turnOff`, `revokeKey`, `setSuspended(true)`) alone may spend the last
    10 of an org's bucket and the last 20 of the global one.
  - The global reserve after the follow-up scan (`fix/c5-budgets`):
    - one org takes at most 12 tokens of it in any minute (two kill switches);
    - a kill switch that changed nothing (`not_found`, `conflict`, `version_conflict`, `already_applied`,
      `bad_request`, a no-op) gives back what it took of the reserve, charged to its org's own bucket instead (which
      may go below zero), so empty kill switches can't drain what every org's kill switches rely on.
  - Emailed-link cancels (review H1) never touch the members' budget: they take a per-client-IP limiter (5 a minute,
    50 a day; IPv6 by /64) before the token is read. The read budget is D229.
  - The breaker (review M2, M3, L6):
    - it also counts a `googleWebClientId` change, which can stop an app's logins;
    - it gives the slot back when a call changed nothing (`not_found`, `conflict`, `version_conflict`,
      `already_applied`, `bad_request`, a no-op);
    - the event is written for the first refusal of a limit in a clock hour only (the object remembers it).
  - Question to confirm (review M2): the spec counts `removeOrigins` and `setSuspended(true)` in the global 20 per hour
    too (D93 Q21). Kept as built. One compromised console can then use the global limit to stop other orgs' removals
    and suspensions for an hour, though not their `turnOff` or `cancelChange`.

### D229. RPC actors, refusal codes and staff proposal details
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/rpc/`, `src/changes/`) · Source: spec §RPC, "Guarded
  changes", "Apps, scopes"
- Decision:
  - **Actors.** `ConsoleRpc` takes only `member` actors (`cancelChangeByLink` only `link`), and never `org_legacy`.
    `AdminRpc` takes `hana`; the methods the admin Worker's crons call also take `system`, and `ackNotice` takes
    `system` only (a staffer can't start a clock by hand). Any other actor is `forbidden`.
  - **Replays.** A request id used before answers `already_applied` only when the stored row is the same write (one of
    the method's ledger kinds, the same app, the same actor); otherwise `conflict`.
  - **The link cancel's read budget** (follow-up scan, `fix/c5-budgets`): after its per-IP limit, a link cancel takes
    one token of a global link-read budget sized to protect D1 (one plan read each: 50/s, burst 100), then reads the
    token. Nothing limits it after that: a cancel whose token verifies on a pending change always runs. This replaces
    the 1/s, burst 20 link bucket, which many addresses each within their limit could drain, refusing the token
    holder. Residual: denial needs a sustained 50 bogus reads a second from ≥ 600 IPv4 addresses or IPv6 /64s. A token
    that isn't canonical b64url of 32 bytes is `forbidden`, like a wrong one (it was `internal`). `actor_sub` is left
    NULL in C5: it holds only an API-verified step-up's sub (C6).
  - **Codes the spec doesn't name.** `conflict` for a staff proposal inside `appChangeDelayMs` of the scope's
    assignment (also `createApp` with origins on an existing scope, D206), a duplicate origin, the 20-origin cap,
    another pending change of the kind, or a value already in force. `env_mismatch` for `raw_sign_on` on a test app.
    `forbidden` for a cancel link that doesn't match (or a change not announced yet) and for expediting a staff
    proposal. `bad_request` for removing an origin the app doesn't have.
  - **Waivers at the ack.** A member proposal is a `no_session` candidate only with `proposer_sub` set (C6 sets it
    after verifying the step-up). Members get the same fail-closed signals as the CLI's waiver: `first_session_at`; an
    origin of the scope in force other than the same request's; a vault share, legacy usage row or identity count.
    C3 review M1 holds for every path built here. `createApp` marks the candidate only on a scope row it created.
    `addOrigins` and `proposeChange` never mark it. Hana proposals never get `loopback`. C4's replacement of the
    legacy `usage` check must change `changes/lifecycle.ts` `noSessionWaiver` as well as the CLI's.
  - **`deleteApp`** also cancels the app's pending changes and deletes its pending origin rows, so no notice goes out
    for a deleted app.
  - **`addOrigins`** counts every open `origin_add` (a parked one with no row included) for duplicates and the
    20-origin cap.
  - **App names** follow console-core `normaliseAppName`: NFC, trimmed, 1–64 code points, and
    `@hana-id/core` `isDisplaySafeLine`'s rule. It is copied, because the Worker can't typecheck core's root entry; a
    test compares the two on every code point.

## Batch C6: owner-verified changes, owner actions, the console sink scope (2026-11-02)

Readings made while building `docs/batch-c-build-plan.md` C6 on `feat/batch-c-6`, where `docs/batch-c-spec.md` left a
detail open or a safer reading was needed. Each follows the spec's intent; all five are **to confirm** by the user.

### D235. The API's step-up check for member proposals: order, codes, and what it adds to the spec's six steps
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/step-up.ts`, `changes/origins.ts`
  `changeOrigins`, `changes/settings.ts` `proposeSettingByMember`, `changes/lifecycle.ts` `noSessionWaiver`,
  `changes/drift.ts`, `scripts/lib/admin-sql.ts`) · Source: spec "API verification", "Waivers", "Lifecycle"
- Decision:
  - **Order.** Steps 1–3 (signature, console audience, `iat`) run before the plan read; then the plan read (a replayed
    `requestId` is `already_applied` before the token is touched; a moved version `version_conflict`) and every input
    and state check (origin rules, duplicates, the 20-origin cap, the policy, raw signing on a test app); then step 4
    (the nonce over the stored version), step 5 (owner, `get_scope` uncached) and step 6 (the reservation), last, so a
    refusal never uses the token up. A batch that then writes nothing (a race, a D1 error) gives the token back.
  - **Codes.** Steps 1–4 `forbidden`, 5 `not_owner`, 6 `token_used`; NEAR RPC or Google's JWKS unreachable
    `near_unavailable` (RpcCode has no other "upstream down, retry" code; the BFF answers 503).
  - **Added checks.** The token's `sub` must equal the member actor's (the console's callback already requires it;
    a mismatch is a console bug or compromise). `iat` must be present and at most 60 s ahead. A token carrying
    `email`, `email_verified` or `hd` is refused (the step-up asks for `scope=openid`), with the optional claims
    checked strictly (D201). The console audiences are read with a fresh `get_config`, not the 60 s cache, so an
    audience the owner just dropped stops counting at once. The reservation shares `owner-actions:tokens` with
    `/v1/owner-actions`: one token, one use, anywhere.
  - **`changeOrigins` writes one ledger row**, `origin.proposed`, with the adds (`changes`) and the removes
    (`removed`, each with `wasInForce`): `app_changes.request_id` is unique, so one request can't have two rows. Drift
    detection reads a baseline origin as ended by such a row as by `origin.removed`.
  - **The `no_session` waiver stays fail-closed for member proposals that remove origins.** A remove sent with an
    add deletes the row of an origin that was in force; with only the row checks, a baseline origin (or any row
    without a `guarded_changes` row) would vanish from the waiver's view in the same request. The waiver (API and
    CLI, still one rule) now also refuses when any ledger row of the scope's apps records an origin removed while in
    force (`origin.removed`, or the `removed` of an `origin.proposed`). `proposer_sub` is written only after this
    verification, never by another path.
  - Member proposals are not held back by the scope-assignment wait (staff-only per the spec); `changeOrigins` isn't
    counted by the breaker (nothing applies without an on-chain owner's token for exactly that change); the removes
    count in the 20-origin check. `request_country` stays NULL (the RPC context carries no country).
- Rejected: verifying the whole token after the plan read (a replay would then need a valid token to get
  `already_applied`); a distinct RpcCode for a wrong nonce (the spec's list has none; `forbidden` with the reason).

### D236. Owner actions: the precheck's nonce, and the caps reconciled with D100
- Date 2026-11-02 · Status: the per-owner proposal windows (2 a minute, 4 a day) **confirmed by the user (2026-11-04:
  "yes" to keeping them shared)**: counted per owner identity across all of its scopes (`ownerLimiterKey` has no scope
  in it), as built; the rest to confirm; built (`apps/api/src/owner-actions.ts`, `handlers.ts` `ownerActionWindows`,
  `ownerCapEvent`, `owner-pool.ts`, `@hana-id/console-core` `owner-actions.ts`) · Source: spec "On-chain owner
  actions" (Limits, Allowance alert), D93 Q23, D100
- Decision:
  - **Nonce.** The precheck reads the scope with an uncached `get_scope`, then, after the owner check and before the
    method's checks, recomputes `owner_action_nonce` from the body at the scope's `action_nonce` (`409
    owner_nonce_mismatch`) and, for AddClient, the client-proof nonce (`400 invalid_client_proof`). A view without a
    readable `action_nonce` fails closed (`502 near_unavailable`). This closes D100's "rejected for now" item: a wrong
    nonce no longer costs gas or the owner's windows. Applies to `/v1/owner-actions` too.
  - **Caps.** The spec's numbers (D93 Q23: 20 per scope per UTC day; a safety budget of 10/min and 100/day globally,
    10 per scope per day) and D100's (decided later the same day, after the security sweep) are combined so that
    neither is weakened where it protects something:
    - `propose_change`: per scope 10/min (D100) and **20 a UTC day** (the spec, replacing D100's 50), global 20/min,
      200/day (both), and per owner **2/min, 4/day** (one window per owner identity, shared by every scope that owner
      holds; confirmed 2026-11-04): the scope's windows divided by the contract's `MAX_OWNERS` (5),
      so the per-scope windows are at least `MAX_OWNERS` × the per-owner ones, as for the safety budget. With D100's
      5/min, 30/day per owner under a 20/day scope cap, one owner (a compromised or careless one) could use up the
      scope's day and block its co-owners' proposals. The alternative, the scope at 5 × 30 = 150/day, was rejected: it
      gives up the spec's 20/day and lets one scope take most of the shared 200/day ceiling. Four proposals a day per
      owner is ample for timelocked changes (at most `MAX_PENDING` = 10 pending per scope); more goes through Hana's
      staff relay (`owner:relay`). Within a scope only all five owners together can fill its proposals;
    - the **safety budget** is the spec's set of methods, `cancel_change`, `remove_client` and `disable_shared_login`
      (D100 had only `cancel_change` there), on D100's cancel windows: 5/min, 20/day per owner, 25/min, 100/day per
      scope, 100/min, 1000/day globally. Not the spec's 10 per scope per day: one compromised owner of a scope could
      then propose and cancel its own changes to use the scope's whole safety budget and block the honest owners'
      cancels for the day, the starvation D100 closed. Not the spec's 100/day global: an attacker fully owning about
      ten scopes could fill it and block every other scope's cancels. Each safety action is also bounded by the
      scope's state (a pending change, a client, shared login on);
    - `execute_change` keeps its own windows (D100), outside the per-scope owner cap.
  - **`owner_cap` events**: one per (window, limit, window start), a deterministic id, deduplicated per isolate too;
    detail `{method, window, limit, max, windowStart}`, the scope and its org (from `scopes`), never the owner's
    identity.
  - **Allowance alert**: one `view_access_key_list` of the relayer account per hourly run (the spec says
    `view_access_key` per key: same data, one read); a key under 25% of 0.5 NEAR (deploy-contract's default
    `--owner-relayer-allowance`, `OWNER_POOL_ALLOWANCE_YOCTO`; a test keeps them equal; the Worker var of the same
    name overrides) or missing from the account writes `owner_allowance_low`, once per key and UTC day.
- To confirm: whether the user wants the spec's lower safety numbers anyway (a smaller spend bound, at the cost
  above).

### D237. `ConsoleRpc.ownerAction`: one path with `/v1/owner-actions`, plus three console rules
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/rpc/console.ts`, `handlers.ts` `runOwnerAction`) ·
  Source: spec "On-chain owner actions" (steps 4–5, API changes), §RPC `ownerAction`
- Decision:
  - The RPC runs the HTTP endpoint's code (`runOwnerAction`): the per-IP limiter fed `clientIp` (the same object as
    the endpoint's, so a console user and a direct caller from one address share it), the precheck, the reservation,
    the caps, the usage event (endpoint `owner_action`, with the org), the request log line (`endpoint:
    ConsoleRpc.ownerAction`).
  - Console rules: the scope must be a row of `scopes` with the caller's org (`not_found`, before any chain read), so a
    scope with no app in the hot DB can't be acted on through the console; the owner token's optional claims are
    checked strictly and it must carry no `email`, `email_verified` or `hd` (`forbidden`), because it is public once
    relayed (the client proof may carry them: it is the partner's own token, pasted after the console's warning).
  - A refusal before the relay is `{ok: false, code}` with an RpcCode (`owner_nonce_mismatch`, `invalid_client_proof`,
    `token_used`, `not_owner`, `rate_limited`, `not_found`, `conflict`, `forbidden`, `near_unavailable`,
    `bad_request`), the precheck's own code first in `error`. Once relayed, `{ok: true, status, result?, nearTx?,
    code?, error?}`: the spec's shape plus `error` (a contract panic's text, like the endpoint's).
  - The safety methods may spend the budget's kill-switch reserve; no breaker (the on-chain caps bound them); cost 2
    hot-DB statements (the org read and a cap's event).
- Rejected: a separate RPC implementation of the relay (two paths would drift); refusing email-carrying tokens on
  `/v1/owner-actions` too (a behaviour change for its other callers, and nothing there stores them).
- **Amended 2026-11-04 (D277):** the console's own token rule is replaced by the claim allow-list both paths share
  (D274): any claim outside it on the owner token or an `AddClient` client proof is refused, on
  `/v1/owner-actions` too (D274 made the refusal this entry rejected). The strict optional claims stay console-only.

### D238. The console sink scope in deploy-contract: the quarantine, who removes, what counts as a sink
- Date 2026-11-02 · Status: to confirm; built (`scripts/lib/deploy-plan.ts` `consoleSinkPlan`, `scripts/lib/
  deploy-run.ts`, `scripts/lib/contract.ts` `SCOPE_OWNER_CALLS`) · Source: spec "Address impact", D93 Q7
- Decision:
  - **The quarantine.** The spec's existing-env plan (`remove_client` from `global`, then `admin_register_scope` "in
    the seconds between") can't run back to back: `remove_client` quarantines the client for `change_delay_ms`, and
    `admin_register_scope` refuses a client removed from another scope until then (`Client was recently removed from
    another scope`). The run waits it out when it is at most 10 min (sandbox-dev: 60 s) and otherwise stops after the
    removals; a re-run inside the quarantine fails on chain and changes nothing. (Amended the same day: a longer
    quarantine is now refused before any removal, below.) During the gap the audiences open no
    session anywhere and the contract still refuses an `AddClient` of them; after it, a claim is timelocked and seen
    by the watcher.
  - **Who removes.** `remove_client` takes `OwnerAuth::Near`, so the sender must be an `Owner::Near` of `global`: the
    manifest's owner (a council proposal on a council env), or else the account that owned the contract when `global`
    was registered, if its key is in `~/.near-credentials`; otherwise a blocker. owner-tx sends `remove_client` like
    an owner call (`SCOPE_OWNER_CALLS`); `admin owner:call` still takes owner-only methods.
  - **What counts as the sink.** Found through `scope_for_client`. A scope whose every owner is an `Owner::Near` of a
    known Hana owner account (the manifest's `owner`, its council DAO, or one named with `--known-owner`, such as the
    owner before a council transfer), console audiences only and no shared login. An audience in any other scope,
    a sink with any other owner included, is a blocker (automated scan, after the first review).
  - **No unattended gap.** The plan refuses to remove anything from `global` (a blocker, before `remove_client` runs)
    unless the same run can register the sink right after: the wait it would make (the quarantine plus a 5 s clock margin, `sinkWaitMs`, the same helper the runner waits
    by) is at most 10 min and no council vote stands
    between the removal and the registration (on a council env, `--approve-with`). Elsewhere (staging, mainnet) the
    move is done by hand, back to back. An audience added to the manifest later gets a sink of its
    own (`admin_register_scope` can't add a client to an existing scope).
  - A console audience that is also one of `googleClientIds` is a blocker; `register-global` counts only
    `googleClientIds` toward its 10 clients.
- No user address changes (the path has no client id).

### D239. What the API keeps of an owner or step-up token (PII, D25, D96)
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/changes/step-up.ts`, `owner-actions.ts`, `changes/cas.ts`)
  · Source: spec "Fresh sign-in" (a step-up token carries no `email`), D25, D96
- Decision: of a step-up or owner token the API keeps only its sha256 (the single-use marker until `exp`) and, for a
  verified member proposal, its `sub` (`guarded_changes.proposer_sub`, `app_changes.actor_sub`; the on-chain
  `Owner::Oidc` holds the same `sub`). The token, its `email` and its `hd` are never logged, returned or stored; on
  the console paths (`changeOrigins`, `proposeChange`, `ownerAction`) a token carrying them is refused, so a console
  bug can't put a member's address on chain or in the hot DB. `/v1/owner-actions` keeps ignoring them, as before.
  Tests: the PII sweeps of `apps/api/test/owner-actions.test.ts` and `rpc-owner.test.ts` (logs, answers, every D1
  table).
- **Amended 2026-11-04 (D277):** "a token carrying them is refused" is now the claim allow-list (D271, D274), on every
  path that verifies a Google token: `/v1/owner-actions` no longer ignores them, a client proof is held to it too, and
  the step-up token is refused for any claim outside the list, not only `email`, `email_verified` and `hd`.

## Batch C7: the console Worker backend (2026-11-02)

Readings made while building `docs/batch-c-build-plan.md` C7 on `feat/batch-c-7` (`apps/console`: dispatch, headers,
CSRF, `StaffRpc`, invites and owner grants, the hourly cron; no public route), where `docs/batch-c-spec.md` left a
detail open or two of its lines pull apart. Each follows the spec's intent; all five are **to confirm** by the user.

### D240. The console never holds or returns an invite token ("`issueInvite` returns the token once")
- Date 2026-11-02 · Status: to confirm; built (`apps/console/src/invites.ts`, `staff-rpc.ts`) · Source: spec "Tests:
  Invites and roles" ("`issueInvite` returns the token once; it is never stored, logged or returned again") against
  §Nonce layouts (T = HMAC(`INVITE_LINK_KEY`, …), a key only the admin Worker holds), §RPC `issueInvite` ("the admin
  Worker computes and emails the token") and §Invites "Notice first"
- Decision: `issueInvite` returns the invite view and no token. The token exists only in the admin Worker: its notice
  cron computes T from `INVITE_LINK_KEY` and the invite id, emails the link, and after every send is accepted calls
  `ackMemberNotice` with sha256(T), the only form the console ever sees. So the test row reads: no StaffRpc answer
  (`issueInvite`, `getOrg`, `listMembers`, `pendingMemberNotices`, `auditSince`) carries a token or a token hash, the
  views' column lists never select `token_hash` or `cancel_token_hash`, and the console's code names neither link key
  (a source check). The same holds for the owner-grant cancel token (`CANCEL_LINK_KEY`, admin Worker only).
- Why: a token returned at issue would be a working link before the notice went out (the spec's fail-closed rule), and
  the console would need the key; "once" is the admin Worker's single computation per notice.
- Rejected: the console generating a random token and returning it to the admin Worker (the console would hold live
  links; a re-sent notice after a failed ack could not carry the same link without storing it).

### D241. An owner invite to an existing org always gets a grant; its notice comes before acceptance
- Date 2026-11-02 · Status: to confirm; built (`invites.ts` `issueInvite`, `acceptInvite`; `cron.ts`) · Source: spec
  "Invites and owner grants" ("an owner invite to an org that already has an owner also creates an `owner_grants`
  row"; "every grant notice carries a cancel link"; the first-owner exception), §Membership rules
- Decision:
  - Every owner invite to an existing org creates its `owner_grants` row at issue, whether or not the org has an owner
    then. Whether the new member waits is decided **at acceptance**, inside the acceptance batch: an org with a usable
    owner (role or matured grant, user not disabled) gives a viewer with `owner_from = accepted_at +
    ownerGrantDelayMs`; an org with none gives an owner at once and the grant `applied_at = owner_from = accepted_at`
    (the first-owner exception). A grant cancelled before acceptance leaves a viewer. A new-org invite has no grant
    (its acceptor is the first owner).
  - Such an invite has two blocking notices, listed separately by `pendingMemberNotices`: the invite's (the link to
    the invitee) and the grant's (with its cancel link, carrying the invite). Acceptance needs both acked, so the
    owners and contacts hold the cancel link before the 24 h can start.
  - Acceptance writes its `invite.accepted` audit row first and gates every other statement on it (D243), so two
    concurrent acceptances, even by one person in the same millisecond, give one member and one audit row. A probe statement before it aborts the batch when the request id already committed an acceptance (a reused id never runs the gated statements for another token), and the invite update re-checks the open-invite conditions.
- Why: deciding at issue would be wrong whenever the org's owners change between issue and acceptance (up to 7
  days); acceptance runs in one serialised batch, so the decision there is exact. Accepting before the grant's notice
  would start a wait nobody can cancel by link.
- Rejected: a grant only when the org has an owner at issue; one combined notice (`ackMemberNotice` takes one hash, and
  the two links go to different people).
- Amended by D343 (2026-11-04): a freeze undoes both notices of an open owner invite and the notice and clock of an
  accepted one's grant; after the unfreeze each is announced again, and an accepted invite's grant then waits the full
  delay from its new notice.

### D242. `invites.new_org_kind` (CONSOLE_DB migration 0002) and the passkey gate's count
- Date 2026-11-02 · Status: to confirm; built (`apps/console/migrations/0002_invites_kind_audit_request.sql`,
  `invites.ts`) · Source: spec §RPC `issueInvite({…, kind?})`, §Deferred (the passkey gate), §`CONSOLE_DB` (the invite
  row has no kind; the acceptance SQL inserts the org with the default kind)
- Decision: migration 0002 adds `invites.new_org_kind` (`partner` | `internal`, set exactly with `new_org_name`, by
  triggers; the default `partner`), and acceptance creates the org with it. The gate refuses `issueInvite` with
  `newOrgName` and `kind = 'partner'` with `passkeys_required` while `PASSKEYS_SHIPPED` (a build constant, false) is
  false and either a `partner` org other than `org_legacy` exists or an **open** new-partner-org invite does; the check
  is inside the insert's guard, so two concurrent issues can't both pass. Internal orgs, and invites into existing
  orgs, never count.
- Why: without the column `kind` would be lost at acceptance; without counting open invites, two first-partner invites
  issued before either is accepted would make two partner orgs.

### D243. StaffRpc readings: actors, the audit commit row, the last-owner rule, what the audit keeps
- Date 2026-11-02 · Status: to confirm; built (`apps/console/src/{staff-rpc,members,grants,invites,audit,sql}.ts`) ·
  Source: spec §RPC `StaffRpc` ("every method takes a Hana actor"), §Roles, §Invites, §Audit, §Sessions; D229 (the
  API's actor rule for `ackNotice`)
- Decision:
  - **Actors.** Staff writes take `hana` only; the reads the admin Worker's crons need (`listOrgs`, `getOrg`,
    `listMembers`, `pendingMemberNotices`, `auditSince`) also take `system`; `ackMemberNotice` takes `system` only, so
    a staffer can't make an invite link work or start a grant's wait by hand. `member` and `link` actors are
    `forbidden` everywhere (C10's owner actions reuse the same data functions with a member actor).
  - **One write, one batch, the audit row first.** Every console write inserts its `audit_log` row first, only while
    its guard holds, and gates every other statement on it, like `app_changes` in the API. Migration 0002 adds a
    unique index on `audit_log (request_id, action)`: a replayed request id aborts the batch, answered
    `already_applied` (same actor and target) or `conflict`. A write whose state moved between its read and its batch
    is `conflict` (retry). Cron rows use `cron-<run>-<target>` request ids.
  - **Codes the spec doesn't name.** `forbidden`: `org_legacy` (no members, no invites, can't be frozen). `not_found`:
    unknown org, user, invite or grant, or removing a non-member. `conflict`: a frozen org (no invites), the 11th open
    invite, a second open invite of the same address to an org, the last owner removed or demoted, a second promotion
    while one is pending, adding or promoting a disabled user (promoting added on 2026-11-04, branch
    `feat/batch-c-7-merge`: a disabled owner doesn't count, so it would leave an ownerless org looking owned).
    `bad_request` also covers an audit cursor, time or `seq` past 2^53 − 1 (the console writes them as SQL literals). `not_pending`: revoking or acking an ended invite, cancelling a
    grant that is cancelled, applied or past `owner_from`. A repeated ack with the same hash is a no-op; with another,
    `conflict`. A change to the role already in force writes nothing.
  - **Roles.** The last-owner rule and the first-owner exception count only usable owners (not disabled); a pending
    owner is a viewer. `setMember(viewer)` on a pending owner cancels the grant; on an owner, demotes (last-owner rule).
    `setMember(owner)`: through a grant when the org has another owner, at once when it has none. Removal cancels the
    member's live grants.
  - **Sessions** are revoked (`revoked_at`, purged 30 days later) on a removal, a demotion, an immediate promotion, a
    disable, and a freeze for members with no other active org; not when the cron records a matured grant (the role in
    force doesn't change then).
  - **What the audit keeps.** Details are allowlisted per action (`AUDIT_DETAIL_KEYS`, snapshot-tested): ids, roles,
    kinds, codes, times. The invitee's address is never in the audit trail (the invite row has it and is purged 90
    days after it ends; the audit is kept 5 years); `actor_email` is the acting staffer's or member's own; `ip_prefix`
    is the caller's /24 or /48. Logs carry ids and codes only, never an email, a sub, a token or a hash.
  - **Notices.** Each `pendingMemberNotices` entry lists the org's current usable owners; a promotion's grant also
    carries the promoted `member` (user id and email), additive like D226, so the admin Worker needs no second call.
- Why: the admin Worker is more trusted than the console (spec §Security model), but the notice must fail closed even
  against a staff mistake, as in D229; the rest makes the spec's rules exact under concurrency and replays.
- Amended by D343 (2026-11-04): `freezeOrg` also pauses the org's pending invites and owner grants in its batch, and
  `pendingMemberNotices` / `ackMemberNotice` skip and refuse (`not_pending`) a frozen org's notices.

### D244. The console's C7 surface: two link routes, CSRF everywhere, the cron's details
- Date 2026-11-02 · Status: to confirm; built (`apps/console/src/{index,links,csrf,headers,cron}.ts`,
  `apps/console/scripts/gen-wrangler.ts`) · Source: spec §Static assets, §Response headers, §Sessions (CSRF, rate
  limits), §Console BFF routes, §Audit, §Retention; build plan C7 ("no public route")
- Decision:
  - **Routes.** The Worker serves its own origin only (404 for any other host), sends `/api/*` to its backend and the
    rest to the SPA's assets (a placeholder page until C9). The only backend routes in C7 are the two session-less link
    confirms, `POST /api/cancel` (through `ConsoleRpc.cancelChangeByLink`) and `POST /api/owner-grants/cancel`; any other
    `/api/*` path is 404. The config has `workers_dev: false`, no `routes`, `preview_urls: false`.
  - **CSRF on every non-GET request**, assets included (four checks, `403 csrf`); a write to a non-API path is 405.
    `/api/*` answers carry `cache-control: no-store` besides the spec's headers; no response sets a cookie in C7.
  - **The link routes' per-IP limit**: the rate-limiting binding (`CONSOLE_IP_LIMIT`, namespace `95101`, 10 a minute,
    IPv6 by /64; C9's `/api/auth/*` will share the binding with its own key), before the body is read; the API keeps
    its own exact link limits (D228, D229).
  - **The link cancel's audit row** (the outcome of a console-initiated RPC) is written for a cancel and for a refusal
    of a real link (`not_pending`, `already_applied`, `conflict`, `internal`, `near_unavailable`); a wrong token,
    malformed input or a rate limit is only logged, since anyone can send them and audit rows are kept 5 years. The
    owner-grant link cancel writes its own row only when it cancels.
  - **The cron** (hourly, `0 * * * *`): expired invites get one `invite.expired` row each and their grant cancelled
    (`system:invite_expired`); matured grants are recorded once (a grant whose member row is gone is cancelled,
    `system:not_member`); invites are purged 90 days after acceptance, revocation or logged expiry, sessions 30 days
    after they ended (revoked, idle or absolute, whichever first), sessions' network data at 90 days, auth flows,
    handoff codes and pending actions 24 h after expiry, replaced logos (R2 object, then row; **amended by D301**:
    row first, then object, the rows put back if the delete fails) 30 days after replacement; at most 200 rows per
    step and run; each step on its own (one failing doesn't stop the others).
  - **Config.** The `LOGOS` and `STATEMENTS` R2 bindings are in the config from C7, so the two buckets must exist
    before the console's first deploy (setup in `docs/operations.md`); invocation logs off (C9's handoff code is in a
    URL); placement next to the API.
  - **Flagged for C11:** the logo upload (`POST …/logo`, an image body) can't meet the CSRF rule's
    `content-type: application/json`; C11 needs either a JSON body (base64) or an explicit exception for that one route
    with the other three checks. **Resolved by D300**: the exception, `application/octet-stream` on that route only.
- Why: nothing a partner can reach is half-wired until C9 (the build plan's rule), but the link confirms need no
  sign-in and exercise the console → API binding end to end.

## Partner identity token, build steps 1–4 (2026-10-30)

Choices made while building `docs/identity-token-spec.md` steps 1–4 on `feat/identity-token-1`, where the spec left a
detail open or a safer reading was needed. Each follows the spec's intent; the user can revisit any of them.

### D170. Identity token layout details the spec left open
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`packages/core/src/identity.ts`, frozen in
  `packages/core/test/vectors/identity-v1.json`) · Source: build step 1
- Decision: the session proof's prefix is the spec's `"hana-id-identity-v1:"` (the build brief said
  `hana-identity-v1:`; the spec wins). `wallet_proofs_hash`, which the spec names but doesn't define, is
  `sha256("hana-id/identity-wallet-proofs/v1" ‖ 0x00 ‖ for stellar then evm: borsh(chain) ‖ borsh(address) ‖
  borsh(Vec<u8> signature))`. The EVM address in a wallet-proof message is EIP-55; the API accepts any valid case in
  the body and canonicalizes before checking. `sub`'s root identity is the session path after the app's `scope#`:
  exactly `provider#sub#key_index` with a lowercase provider, a non-empty sub and a decimal `key_index`, else no token
  (`502 bad_contract_result`). `login_methods` is `[root provider]` until account linking exists (email login, D119).
  The claims are built in the spec's order and the builder throws on anything off-spec.
- Why: a frozen, unambiguous layout before any vault signs one; the proofs hash commits to the chain names, addresses
  and signatures so a session proof can't be paired with other proofs.

### D171. A mint in an app that keeps logins needs the session's live share
- Date 2026-10-30 · Status: in force; amended by D178 (other apps' shares, tombstones) · Source: build step 2; the
  spec's "Minting" step 2 (`apps/api/src/identity/token.ts` `checkShare`, `packages/web/src/vault/vault.ts`
  `mintIdentity`)
- Decision: when the app's persistence is `session`, `/v1/identity/token` requires a share for the session key, made
  for the requesting parent, judged as unlock judges it without writing anything (`410 session_ended` with `reason`
  `unknown_share`, `share_revoked`, `persistence_off`, `share_expired`); a session key with no share passes on the
  chain check alone only while the app's persistence is `none`. The vault answers `identity_unavailable` with
  `reason: no_share` (no API call) for a session in a `session` app that has no share (storage blocked, or the
  background persist gave up, D79), and waits for a login's persist before minting. A `410 session_ended` from the
  mint ends the vault session as a revoked share does (`sessionExpired`). A missing on-chain session is re-read every
  300 ms for up to 2 s before the refusal (a node a block behind the login would otherwise log the user out).
- Why: the share is what a logout, `revokeOtherDevices()` or a removed origin kills; the hourly cron deletes revoked
  shares, so "no share" can't be told from "revoked" and must refuse in a `session` app. Accepted: a browser that
  can't store the session gets no identity token in such an app (`docs/security.md` open issue (l)).

### D172. Identity counts in their own tables, migration 0008
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`apps/api/migrations/0008_identity_token.sql`) ·
  Source: build step 2; `docs/batch-c-build-plan.md` reserves 0006 and 0007
- Decision: migration 0008 creates `identity_issuance_hourly (hour, kid, count)` and `identity_usage (app_id, day,
  tokens)` (the spec's `usage.identity_tokens`), both kept 24 months by the hourly cron. It doesn't touch the legacy
  `usage` table (batch C's 0007 drops it) and holds no user data. The email claim's `apps.identity_email`,
  `identity_email_consents` and `identity_emails` count come with build step 5's migration.
- Why: 0008 applies the same before or after batch C's 0006/0007; an `ALTER TABLE usage` would fail on a fresh
  database once 0007 drops `usage`.

### D173. Identity signing configuration: `activeKid` in the manifest, `iss` under the API
- Date 2026-10-30 · Status: in force; the global ceiling amended by D176, the standby slot by D177 · Was on `feat/identity-token-1` (`packages/env/src/identity.ts`,
  `apps/api/scripts/gen-wrangler.ts`, `scripts/lib/identity-key.ts`) · Source: build step 2; the spec's "Manifest"
- Decision: the Worker-secret signer is `{kind: "worker-secret", activeKid}`: the API signs with whichever of
  `IDENTITY_SIGNING_KEY` / `IDENTITY_SIGNING_KEY_STANDBY` has that RFC 7638 thumbprint, so the rotation playbook's
  "switch to the standby" is a manifest change and a deploy. The schema requires every `publicKeys` kid to be its
  key's thumbprint, refuses any private member, requires the signer's kids in the list and refuses a Worker-secret
  signer off testnet; `identityToken.iss` must be `{apiUrl}/v1/identity` until the production hostname exists (D127
  Q14). `gen` refuses the `aws-kms` shape until build step 7 and, with `--dev-vars`, signing keys the manifest
  doesn't publish. The API verifies each signature with the published key before answering, and serves the JWKS from
  the manifest's list alone. The global hourly ceiling is 100 000 mints (var `IDENTITY_GLOBAL_HOURLY_MAX` overrides).
- Why: the standby switch must not need a secret upload in an incident, and a secret that doesn't match the published
  key must never produce a token.

### D174. Identity token cache rule and SDK surface details
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`packages/web/src/vault/identity.ts`,
  `packages/web/src/client/client.ts`, `packages/react/src/identity.ts`) · Source: build step 3
- Decision: the vault hands out its cached token while more than `min(5 min, half the token's life)` remains (a token
  the session's end made short doesn't cause a mint per call) and, with `maxAgeMs`, it is at most that old. The SDK
  clamps `maxAgeMs` to 30 s–1 h (the port refuses anything else) and rejects a non-positive one with `-32602`. The
  port result and `identityTokenChanged` carry `{identityToken, expiresAtMs}`; the client exposes
  `hana.identityToken` and `hana.identityTokenExpiresAtMs`. `410 session_ending` (< 30 s left) is `session_ended` with
  `data.reason: 'session_ending'`, without ending the session (its own timers do). `useIdentityToken` retries a failed
  refresh after 60 s. The record format 2 stores the proofs; the session key stays with a dormant session so it can
  mint without PRK.
- Why: the spec's 5-minute margin alone would mint on every call near a session's end; the rest fills in shapes the
  spec named but didn't fix.

### D175. A tested partner example, quoted exactly by the guide
- Date 2026-10-30 · Status: in force on `feat/identity-token-1` (`examples/identity-verify`, a workspace member) ·
  Source: build step 4; the spec's "Example verifier"
- Decision: `examples/identity-verify/src/verify.ts` is the guide's verifier (`jose` 6.2.13, ES256 pinned); its tests
  run it against a local issuer (expired, stale, wrong `aud`/`iss`/`typ`/key, `alg: none`, HS256) and fail when
  `docs/integration.md` section 15 doesn't quote the file exactly. The Playwright suite verifies real tokens from the
  local stack with `jose` against its JWKS.
- Why: the published guide always runs.

## Partner identity token, review fixes (2026-10-30)

From the identity token's security review, built on `feat/identity-token-2`.

### D176. Identity mint limits: narrow to wide, sliding, none shared with the vault; the replay marker last
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`apps/api/src/identity/limits.ts`, `token.ts`
  `identityQuota`, `rate-limiter.ts` `hitSliding`) · Source: the identity token's security review (M1, L2, L3, L5)
- Decision: `/v1/identity/token` asks, in turn: the vault gate's per-IP binding (only: the app's `vault:minute` quota
  is no longer used, so mints can't starve unlocks) → … → the session proof's signature → per session key 10/min
  (binding) → not paused → share → chain session → wallet proofs → the single-use marker → per account root 30/min
  (binding `IDENTITY_ROOT_LIMIT`, keyed by the HMAC `sub` bytes) → per app `identity:minute` (10 × plan `per_minute`)
  and `identity:hour` (plan `per_day`, at most 100 000) → per scope `identity:hour` (2 × the app's) → global: a hard
  breaker of 1 000 000/h (≥ 10 × any app's ceiling, so no one tenant can trip it) and a soft line at 100 000/h that
  logs `identity_volume_alert` (critical) without refusing. The app, scope and global windows are sliding (the
  previous bucket weighted by its overlap) and counted only for a request that passed every other check; a refusal by
  a later window takes the hit back from the earlier ones. The marker is reserved only once the proof is known to be a
  live session's (random keys create none), keyed `sha256(sessionPk ‖ u64le(issuedAtMs) ‖ nonce)` (independent of the
  signature's encoding), and an alarm on the marker object deletes expired markers.
- Why: the global hourly breaker was reachable by one tenant (three free apps at 600/min) and then refused every app
  for up to an hour. Amends D173's global ceiling (100 000/h, refusing).
- Rejected: one exact per-root object (a Durable Object per user per hour; the binding is a flood limit anyway).

### D177. Testnet identity keys: the standby stays off the Worker; rotation and retirement commands
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`scripts/lib/identity-key.ts`,
  `packages/playbooks` `identity-signing-key-compromised`) · Source: the identity token's security review (M2)
- Decision: `identity-key init` uploads only the active key and the sub key; the standby is published in the JWKS
  but never uploaded (operators move its file offline), so a leak of the Worker's secrets or the Cloudflare account
  doesn't reach it. New commands: `next` (generate and publish a rotation key, upload nothing), `switch --to
  next|standby` (upload it into the Worker slot the active key isn't in, make it the manifest's `activeKid`; the old
  active key becomes `previous`, still published), `retire --key previous|standby` (unpublish, delete its Worker
  secret if it has one, set its file aside). `.secrets/<env>/identity-slots.json` records which slot holds which kid.
  `gen --dev-vars` writes only the active key. The compromise playbook (operations.md, `docs/playbooks.md`): treat
  both keys as exposed unless the incident provably touches only the active one; then retire the standby too and
  rotate to a fresh key.
- Why: two keys side by side on one Worker and uploaded together made "switch to the standby" keep a compromised
  key. Amends D173 (the standby slot is now a rotation slot) and the spec's rotation playbook.

### D178. A dead or other app's share stops mints in every app of the scope; shares kept as tombstones for 24 h
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`apps/api/src/identity/token.ts` `checkShare`,
  `vault/cron.ts` `pruneShares`) · Source: the identity token's security review (L1)
- Decision: the mint looks a session key's share up in any app: a share that belongs to another app refuses the mint
  (`410 session_ended`, `reason: unknown_share`) whatever this app's persistence, so a session revoked (or simply
  persisted) in a `session` app of a scope never mints in a `none` app of the same scope. The hourly cron deletes a
  revoked or absolutely expired share only once it is older than 24 h (the contract's `MAX_SESSION_MS`), so the row
  outlives any on-chain session it could stand for.
- Why: `getShareBySessionPk` was per app and the cron deleted revoked rows within the hour, so a revoked session kept
  minting in a `none` app until its on-chain expiry, against D171 and `docs/security.md`. Amends D171.

### D179. Raw signing never covers Hana's signing domains; `wallets` proves control, not derivation
- Date 2026-10-30 · Status: in force on `feat/identity-token-2` (`packages/web/src/vault/signing.ts`
  `refuseReservedRaw`, `docs/integration.md` section 15) · Source: the identity token's security review (L4, L6)
- Decision: in apps with raw signing on, the vault refuses (4100, `reason: raw_reserved_domain`, before any popup) a
  Stellar raw request whose bytes start with `hana-id`, and an EVM raw digest equal to the session's own identity
  wallet-proof digest, so an approved raw signature can't serve as a wallet proof. The guide says what `wallets`
  proves: the session's holder controls each address's key, not that it is the Hana-derived wallet of that `sub`; one
  address can appear under several `sub`s (an exported or reused key, an old `key_index`), so partners must not treat
  wallet → `sub` as unique (per-wallet credits).
- Why: defence in depth for the wallet proof; the guide overstated the claim.
- Accepted residual (automated review, 2026-10-30): the EVM check covers only this session's own proof digest. A raw
  EVM digest is opaque, so a user who approves a raw signature over another session's wallet-proof digest lets that
  session list their address. Not fixable at the source: raw signing signs any digest, whatever structure (EIP-191,
  EIP-712) the proof used, and the API can't check that an address is the account's Hana-derived wallet (CKD output
  is never on chain). The approval already authorizes arbitrary signatures (transactions included, with the popup's
  warning), and partners must not treat wallet → `sub` as unique, so the impact is within what the guide states.
  Revisit if addresses are ever recorded on chain.

## Email login build, batch 1 (contract v3), 2026-10-30

Made while building `docs/email-login-build-plan.md` batch 1 (branch `feat/email-login-1`), where the spec was silent,
ambiguous or unsafe as written. Each takes the safest reading and is listed for the user under the plan's "Open
points for the user"; none changes an address.

### D130. A wallet is recorded when its path is derived, not when a session opens
- Date 2026-10-30 · Status: confirmed by the user (2026-11-02); in contract v3 on develop, not deployed · Source: build of
  `docs/email-login-spec.md` "Sessions" step 3 and "Model" ("the contract records that in `opened` at every
  `create_session*`")
- Decision: `opened` (an identity "has a wallet") is set by `derive_key` and `create_session_and_derive` for the
  session's path identity, not by a bare `create_session`.
- Why: tokens are public in the mempool and in failed transactions. Copying a Google token that was sent for a case-A
  link into a bare `create_session` would open a session nobody can use but mark the Google identity as having a
  wallet, so the user's retry hits "both have a wallet" and the person ends up with two wallets, which D122 forbids.
  Nobody can derive without the session key, so marking at derivation can't be forged. For every real login (the
  combined call) the result is the same as the spec's.
- Rejected: the spec's wording (marking in `create_session`).

### D131. Contract readings of the email login spec (batch 1)
- Date 2026-10-30 · Status: confirmed by the user (2026-11-02), every reading; in contract v3 on develop, not deployed · Source: build of
  `docs/email-login-spec.md` "Contract changes", "Sessions", "Link methods"
- Decision:
  - `mark_self_issued` refuses an issuer that already has keys, active or pending (`Issuer already has keys`), and a
    second call (`Issuer is already self-issued`), so it can never reset an upgraded policy.
  - The updater key ("self") can't propose **any** key change of a self-issued issuer, removals included.
  - One RSA modulus is registered once per self-issued issuer, whatever its kid, exponent or signer (`Key is already
    registered`), including keys a future `migrate` installs: one stolen key never counts as two signers.
  - A self-issued key change waits `max(the usual rule, now + governance_delay_ms)`.
  - JWS JSON is parsed strictly: no flattened form, no unprotected `header`, no `crit`, no duplicate members; every
    signature must verify and every kid must be a counting signer's active key (an unknown extra signature fails the
    token rather than being ignored).
  - Case A (Google joining an email wallet) must carry `link_immediate = true` (`This link must be immediate`): a
    delayed case A would have to open the Google identity's own path, a second wallet.
  - `cancel_link` doesn't mark the pair `unlinked` (the spec names unlink only; confirmed by the user, D132); lazy activation of a pending member
    doesn't bump the epoch; an account record is never deleted (its epoch must not restart).
  - `get_account` also returns `unlinked` (hex keys), so the issuer can apply "an unlinked pair is not a match".
  - The panic for an unlisted kid stays today's `Unknown signing key` (the spec writes `Unknown key`); a
    `link_immediate` without `link_jwt` panics `link_immediate needs a link_jwt`; unlinking by another member panics
    `Only the root or the member itself can unlink`.
  - `migrate_v1` stays (now v1 → v3) until the sandbox suite moves to v2 → v3 (build-plan batch 2).
- Why: each is the stricter of the readings the spec allows, or fills a gap without a product choice.
- Rejected: the looser readings (accepting a delayed case A, ignoring unknown extra signatures, letting the updater
  propose email key removals).

### D132. A cancelled link keeps the match (open point 3 → A)
- Date 2026-10-30 · Status: confirmed by the user, built (`feat/email-login-1`) · Source: conversation
  (`docs/email-login-build-plan.md` open point 3)
- Decision: `cancel_link` does **not** mark the pair `unlinked`. After a user cancels a pending link, the next login
  with the other method still sees the match and offers only "Link and continue" or "Sign in with {the other
  method}": no second wallet. Only `unlink_identity` marks a pair.
- Rejected: marking cancelled pairs (an email login would then make its own wallet after a cancel).

### D133. The user's session signature binds the link, and the auto_link nonce binds the join
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the independent security review (HIGH-1, MEDIUM-1) ·
  Source: review of contract v3 at ba45b91
- Decision:
  - In `create_session_and_derive` with `link_jwt`, the session key's counter-1 signature is over the **linked CKD
    payload** `"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode u8 ‖ pk1 ‖ ":" ‖ pk2` instead of the plain one. The
    plain payload is unchanged for logins without a link. The vault verifies the link token and recomputes its
    `auto_link` nonce before signing.
  - The `auto_link` nonce also commits to the join the issuer decided: `join` (1 = the session identity joins the link
    identity's account, case A; 2 = the link identity joins the session identity's, cases B/C), `joiner_ik` and
    `target_root_ik`, before the epoch and mode. The contract recomputes the join from chain state and checks it.
- Why: before, nothing the user signed bound the link. Whoever submitted a published login chose whether and which
  link was attached: a stolen email-issuer key could replay a failed Google login with its own case-B token and join
  its email identity to the Google wallet (against D119 and the spec's trust statement), and anyone could strip the
  link from a case-A login so the Google identity derived its own path (two wallets, against D122). A token minted for
  case A could also execute as case B after the chain state changed at the same epoch. Its own domain keeps the linked
  payload from ever reading as a plain CKD payload (a suffix on the plain payload could collide with a crafted `pk2`).
- No path, CKD request, derivation or existing layout changes; the `auto_link` layout was never deployed.
- Rejected: the reviewer's suffix form (`plain payload ‖ ":link:" ‖ …`), for the collision above.

### D134. Only the email provider can be self-issued
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-3)
- Decision: `mark_self_issued` accepts only `SELF_ISSUABLE = ["email"]` (`Only the email issuer can be self-issued`).
  Another provider needs a governed upgrade.
- Why: marking is one way. An owner could remove Google's keys and mark `google` self-issued, which would stop every
  Google login until a governed upgrade. The email provider name is frozen anyway (it is in every email path).
- Rejected: a governance delay on marking (more machinery for a provider list that is one name).

### D135. Links wait for the owner after a migration from pre-v3 state
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-4)
- Decision: `migrate` (v2 → v3) and `migrate_v1` set `unrecorded_wallets = true`; while it is set every link, automatic
  or explicit, panics `Links wait until the owner accepts the wallets opened before v3`. The owner's
  `accept_unrecorded_wallets()` (one way, event) clears it. `new` starts with `false`. sandbox-dev accepts after its
  v3 upgrade (its pre-v3 wallets are test data, D122); the mainnet runbook creates the signer with `new` on v3 and
  checks `get_config().unrecorded_wallets == false`.
- Why: wallets derived before v3 aren't in `opened`, so "has a wallet" would be wrong for them and a funded pre-v3
  Google wallet could be silently joined to an email account in case A. A migration argument isn't possible: v2's
  `execute_upgrade` calls `migrate` with empty input.
- Rejected: documenting it only (the review's point); a migrate argument (above).

### D136. A linked identity's own path never derives; signer-policy keys are checked like any key
- Date 2026-10-30 · Status: built (`feat/email-login-1`), from the review (LOW-1, LOW-2, info)
- Decision:
  - `derive_key` (and the derive half of `create_session_and_derive`) refuses a session whose path identity is a
    member of an account, pending or active (`Sign-in method is linked to an account`): a session an identity opened
    on its own path before it joined can't make a second wallet.
  - `set_signer_policy` (a governed upgrade's `migrate` only) checks every new key with `set_issuer_key`'s rules
    (leading zeros stripped, 2048–4096 bits, odd exponent other than 1), so a zero-padded copy of hana's modulus can't
    pass as a co-signer's key.
  - `set_signer_policy` takes `overlap`: `true` (adding a signer) keeps the 10-minute overlap and leaves dropped
    signers' keys until the owner removes them (they can't count once it ends; `get_issuer_keys` still lists them);
    `false` (replacing a compromised signer) opens no overlap and removes the dropped signers' keys at once.
- Why: each closes a path the review reproduced; none changes an address.

### D137. A bare create_session needs the session key's proof of possession; linked logins never recover unlinked
- Date 2026-10-30 · Status: built (`feat/email-login-1-r2`), from the second review (N1) and the automated review of
  its first form · Source: review of e225d2e
- Decision:
  - `create_session` takes `signature`: Ed25519 by the session key over `session_message(0, "hana-id-create-v1:" ‖
    sha256(session nonce preimage))`. Only the key holder can open a session, and the proof is bound to that call's
    parameters (signer, scope, key, expiry, key_index, max_uses, salt), so a proof seen in one transaction can't open
    the key with any other parameters. Counter 0 is never accepted by `derive_key` or `revoke_session`, and the domain
    differs from every other signed payload. `create_session_and_derive` is unchanged (its counter-1 signature already
    proves possession).
  - Recovery rule for the vault (batch 8): a session it meant to carry a link is never derived on with the plain
    payload; on `Session key already in use` (or any failure after publishing) it revokes that session and restarts
    with a fresh session key, Google token and link token.
- Why: a front-runner could copy the Google token of a published case-A linked login into a bare `create_session`
  with the same session key and no link. The user's call then failed `Session key already in use`, and the documented
  recovery (derive with counter `used + 1`, plain payload) derived the Google identity's own path, splitting the person
  into two wallets (D122). A constant proof (the first form of this fix) would still have been replayable for that key
  with other parameters.
- Interface: the one change to an existing method. The API's split-path relay, `packages/web`'s split path and the
  smoke page's direct flow must send `signature` before the v3 upgrade lands (v2 ignores the extra field); batch 6.
  No path, CKD request or derivation changes.
- Built in batch 6 (`feat/email-login-6`): the API requires and verifies `signature` on `/v1/sessions` and relays it;
  the vault's split path and the smoke page sign it (`@hana-id/core` `signCreate`); the sandbox test
  `v2_ignores_the_create_session_proof_that_v3_requires` proves v2 ignores it (D234).
- Rejected: relying on the vault rule alone (the contract can make the bad recovery impossible to set up).

### D138. A replacing signer policy needs new signer ids and cancels dropped signers' pending keys
- Date 2026-10-30 · Status: built (`feat/email-login-1-r2`), from the second review (N3)
- Decision: in `set_signer_policy` with `overlap = false`, new keys may only go to signer ids the previous policy
  didn't list (`A replacing policy adds keys only for new signer ids`); in either mode, pending `AddForSigner`
  changes of signers that leave the policy are cancelled (event `issuer_key_change_cancelled`, `by` = the contract).
- Why: a replacing upgrade that kept the id `cosign` with a new key left the compromised old `cosign` key counting
  (keys were dropped by signer id only); and a dropped signer's owner-posted pending key would revive, executable by
  anyone, if a later upgrade listed the id again.
- Rejected: an explicit list of kids to remove (the owner can already remove any key at once with
  `remove_issuer_key`; a new id makes the replacement visible in the policy itself).

### D139. Off-chain guards from the second review: case-B signing only after the popup's own email step; a watchdog alert
- Date 2026-10-30 · Status: obligations for later batches (`docs/email-login-build-plan.md` batches 5 and 8), from
  the second review (N2, N4)
- Decision:
  - The vault signs a linked payload with `join = 2` (an email identity joining the Google identity's account) only
    when this same popup ran the user's email-code step for this login (`verify` → `linkTicket`) and the link token's
    `sub` equals the `sub` of the address verified there. A case-B token offered during a plain Google login is
    refused.
  - The watchdog raises a critical alert whenever `get_config().unrecorded_wallets` is `true` on an env that isn't a
    dev env.
- Why: since D133 a case-B join happens only when the vault signs the linked payload, so the vault is the last check
  that the user really proved the email address in this flow; without it a compromised issuer service could serve a
  case-B token during a plain Google login. The flag must never be true on mainnet (D135); a runbook check alone can be
  skipped.

## Email login build, batch 2 (contract v3 upgrade path and gas), 2026-11-02

Made while building `docs/email-login-build-plan.md` batch 2 (branch `feat/email-login-2`).

### D154. No v1 migration in contract v3: `migrate_v1` removed, `deploy-contract` refuses a v1 contract
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); merged · Source: email-login build plan batch 2
- Decision: contract v3 drops `migrate_v1`, the v1 layout copy (`HanaSignerV1`) and the v1 state fixture, as the build
  plan says. The plan doesn't say what the deploy tooling does with a v1 contract once the code can't migrate it; the
  stricter reading is built: `deploy-contract` refuses a v1 contract with or without `--upgrade`, with a blocker that
  names the ways out (upgrade it with the v2 code, develop 26fb70a, first; or a fresh signer account, which changes
  every address), instead of planning `DeployContract` + `migrate_v1`, which would now fail on chain (`MethodNotFound`,
  the receipt reverts). The plan's `migrate-v1` step and the simulated chain's `migrate_v1` are gone; the v1 plan
  and run tests became refusal tests.
- Why: no deployment is on v1 (sandbox-dev migrated on 2026-10-30; every other env is created with `new`), and the
  tooling shouldn't offer a plan that can't succeed. v3 still reads v1-era session records (`created_at_ms` absent):
  a deployment migrated from v1 may hold some, so that unit test stays, built without the v1 fixture.
- Not changed: the API's never-relay list (`apps/api/src/relayer-config.ts` `GOVERNANCE_METHODS`) still names
  `migrate_v1`: refusing a method that no longer exists is harmless, and batch 6 edits that file. (Batch 6 removed it.)

### D155. Attached gas for the email-login calls covers 4096-bit keys
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); measured in batch 2, the API sets the values in build-plan
  batch 6 · Source: email-login build plan batch 2, the spec's "Gas and storage"; batch 2 review (L3)
- Decision: attach 250 Tgas to `create_session_and_derive` with a `link_jwt` (the spec said 150), 250 to
  `link_identity` (spec: 100), and 150 to `cancel_link` and `unlink_identity` (the spec gives no value). Measured in the
  sandbox (`docs/contract-interface.md` "Gas of the email login calls"): one RS256 verification costs ≈ 17–18 Tgas at
  2048 bits and ≈ 67 at 4096, the largest modulus `set_issuer_key` accepts. A linked login needs ≈ 59 Tgas at 2048
  bits and ≈ 156 at 4096 (two verifications plus the MPC's 20); `link_identity` burns 37.2 / 134.6; `cancel_link` and
  `unlink_identity` 19.8 / 68.5. The values cover the 4096-bit worst case with ≥ 1.6 times the need.
- Also: at 4096 bits the plain logins outgrow the API's current values (`create_session` 68.8 burnt against 50
  attached; `create_session_and_derive` ≈ 89 needed of 100). Batch 6 raises them (100 and 150) unless the issuer keys
  are kept at 2048 bits (below).
- Why: unused gas is refunded and the prepaid amount only counts against the relayer key's allowance while the call
  runs, so a high value costs nothing; a low one fails logins the moment an issuer (Google, or Hana's email key)
  rotates to a larger key, which the contract allows.
- Alternative for the user: cap self-issued (email) keys at 2048 bits in a later contract version (Hana chooses that
  key size: the spec's KMS keys are `RSA_2048`), and keep the gas values for Google's 2048-bit keys with a check in
  the watchdog. Not done here: no contract change in this batch.
- Rejected: the spec's 150 for the linked login (fails with 4096-bit keys); 100 for `link_identity` (likewise).
- Built in batch 6 (`feat/email-login-6`, `apps/api/src/gas.ts`): `create_session` 100, `create_session_and_derive`
  150, a linked login 250, `link_identity` 250, `cancel_link` and `unlink_identity` 150 (D232).

## Email login build, batch 3 (`packages/email`), 2026-11-02

Made while building `docs/email-login-build-plan.md` batch 3 (branch `feat/email-login-3`), where the spec was silent
or allowed two readings. Each takes the stricter reading. D156 and D159 define every email user's address (frozen at
the address freeze; until then a change moves every sandbox-dev email address and must be called out); D157 and D158
change no address.

### D156. Email normalization v1: the stricter readings, and a pinned UTS #46 library
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); merged · Source: build of
  `docs/email-login-spec.md` "Email normalization"
- Decision (`packages/email/src/normalize.ts`, frozen by `vectors/email-v1.json`):
  - "ASCII whitespace" is the WHATWG set (TAB, LF, FF, CR, SPACE), trimmed at the ends only; anything else (VT, NBSP,
    ideographic space) stays and fails the syntax checks. An input with an unpaired UTF-16 surrogate is refused.
  - The 254-byte limit applies to the trimmed input (UTF-8 bytes) **and** to the normalized address, since punycode
    can lengthen the domain; the local part must be 1 to 64 bytes.
  - "ASCII only" local parts must also be an RFC 5322 dot-atom: no quoted strings, comments, backslashes, spaces,
    leading, trailing or doubled dots (also for Gmail, before its dots are dropped). Lowercasing is ASCII-only.
  - UTS #46 runs non-transitional with every check on: CheckHyphens (so `ab--cd.com` is refused unless it is a valid
    `xn--` label), CheckBidi, CheckJoiners, UseSTD3ASCIIRules; then the domain must be an LDH host name of at least
    two labels, each 1 to 63 bytes, at most 253 bytes, whose top-level label has a letter (no IPv4 or IP literals).
  - The Gmail canonical form is applied to the normalized domain (`GMAIL.COM.` and fullwidth forms count); a local
    part left empty by it (`+tag@gmail.com`) is refused.
  - IDNA comes from `tr46` 7.0.0 (UTS #46 revision 36, Unicode 18.0.0), pinned exactly; a guard test checks the
    installed `tr46` and `punycode` versions. Emoji labels that UTS #46 allows (`💩.la`) are accepted.
  - **Unicode 15.0 cutoff** (review M1, 2026-11-02): any code point assigned after Unicode 15.0 is refused
    (`domain_unicode_version`), in the raw input, in its mapped form with `xn--` labels decoded, and in the result.
    The ages come from a vendored table generated from Unicode's `DerivedAge-18.0.0.txt`
    (`packages/email/src/unicode-age.ts`, hash-pinned), never from the engine's `\p{…}` data. Why: `tr46` calls the
    runtime's `String.prototype.normalize('NFC')`; a runtime whose Unicode predates a character doesn't reorder it,
    so `alice@x\u1AD0\u0316.com` (U+1AD0, Unicode 17) gave a different `sub` on Node 22.12 and Node 24. Why 15.0:
    it is the newest version every target runtime knows: Safari 16.4 and later (16.4 shipped the Unicode 15.0
    emoji), Chrome, Edge and Firefox of the last two years (ICU 74+, Unicode 15.1), Node 22 (ICU 74+) and workerd
    (newer). Unicode's normalization stability policy keeps NFC identical across them for 15.0 characters. Cost:
    domains using characters added since September 2022 (CJK extension I, new scripts, new emoji) can't sign in;
    raising the cutoff later would only accept addresses that are refused today, so it moves no existing address.
- Why: every refusal here only turns away addresses that are invalid or that no large provider issues; every
  acceptance is frozen forever, so the narrow set is the safe one. The runtime's own `URL` parser is also
  non-transitional UTS #46 but with looser flags and an unpinned Unicode version (workerd's or each browser's ICU), so
  a runtime upgrade could move an address.
- Residual: `tr46` still calls the platform's NFC, now only on characters of Unicode 15.0 or older, which every target
  runtime has. The frozen vectors run in Node, in a bare V8 context (the browser bundle) and in workerd. CI's Node is
  `22` (floating), so no claim rests on a pinned Node version. Browsers older than Safari 16.4 may predate Unicode
  15.0, so only the email issuer (workerd) computes a normalized address for a `sub`; the popup uses the package for
  display and pre-checks only (batches 4 and 8; review of batch 3).
- Rejected: platform `URL`/`domainToASCII`; quoted local parts; measuring length on the input only; Unicode `trim()`.

### D157. Disposable-domain list: one pinned upstream commit, parents match, updated by PR
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); merged · Source: build of
  `docs/email-login-spec.md` "Rate limits and abuse" (Q10, D123)
- Decision: `packages/email/src/disposable-domains.ts` vendors `disposable_email_blocklist.conf` of
  `github.com/disposable-email-domains/disposable-email-domains` (CC0 1.0) byte for byte at commit
  `e4f0910adf5ab418dc998a1d8e6c15906ca04864` (2026-10-23, 9927 domains), its sha256 checked by a test. A domain is
  blocked when it **or any parent** is listed (upstream lists registrable domains and asks implementers to match
  subdomains). The guard keeps `gmail.com`, `googlemail.com` and `google.com` (and their parents) off the list, in the
  test and in `scripts/update-disposable-domains.mjs`, which is the only way to update it (a reviewed PR, an upstream
  commit at least 7 days old, as the workspace's `minimumReleaseAge`).
- Why: exact-match only would let `anything.<disposable>` through; a fresh upstream commit is unreviewed third-party
  data that decides who may log in.
- Rejected: exact match only; fetching the list at runtime.

### D158. The Google-hosted rule compares `hd` exactly
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); merged · Source: build of
  `docs/email-login-spec.md` "The four cases" ("`hd` is present and equal to the address's normalized domain")
- Decision: `isGoogleHosted({ email, emailVerified, hd })` takes a normalized address (it throws otherwise) and
  needs `emailVerified === true` (anything else is false). Then: `hd` absent (`undefined` or `null`) → true only for
  the domain `gmail.com`; `hd` present → true only when it is a non-empty string **exactly equal** to the normalized
  domain (so a `gmail.com` address with another `hd` is false; review L1). `hd` is not lowercased, IDNA-mapped or
  trimmed first. A subdomain or parent of `hd` doesn't count.
- Accepted: Cloud Identity accounts, and Workspace accounts without Gmail, have `hd` equal to the domain while the
  mailbox is hosted elsewhere. The rule still treats them as Google-hosted because the same domain administrator
  controls both the Google account and the domain's mail.
- Why: a false "not Google-hosted" only costs the user a code (case A) or the 24 h delay (case B); a false "hosted"
  links silently. Google returns `hd` as the Workspace's lowercase ASCII domain, so the exact form is the expected one.
- Rejected: normalizing `hd` with `normalizeDomain`; matching `hd` against parent domains.
- **Reasoning corrected (2026-11-02, tokens review L3; the rule is unchanged):** for a Workspace account without Gmail
  or a Cloud Identity account, Google does **not** host the mailbox, so "whoever passes Google's sign-in can read the
  mailbox" isn't a fact about Google there. The rule treats such an `hd` account as Google-hosted on the domain
  administrator's word: the same administrator issues the Google account and the mailbox, and can already reach both.
  A silent link then trusts that administrator, as every address on that domain already does.

### D159. Gmail canonical form: dots ignored, each `+tag` its own identity
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02), amending Q7 (D123) · Source: spec Q7 (D123), checked
  against Google's help pages on 2026-11-02 (cited in `packages/email/test/vectors.test.ts`); the user's choice of
  `+tag` behaviour
- Decision: `gmail.com` and `googlemail.com` → `gmail.com`; every dot in the username (before the first `+`) is
  dropped; a non-empty `+tag` is kept as typed (lowercased, its dots and further `+` kept), so `name+1@gmail.com`
  and `name+2@gmail.com` are separate identities with separate wallets; an empty tag (`name+@gmail.com`) is the plain
  username; an empty username (`+tag@gmail.com`) is refused. Other domains keep dots and `+` as typed.
- Why dots: Gmail delivers every dot spelling to one inbox and nobody can register another spelling
  (support.google.com/mail/answer/7436150), so ignoring dots keeps one person from getting a second, empty wallet
  by typing their address differently, and keeps D119 matching against Google's reported address working.
- Why `+tags` kept (the user's choice): a tag is typed on purpose, so it can't split a wallet by accident, and it
  gives one inbox many wallets for testing and for users who want them, as Privy does. Security is unchanged: only
  the inbox owner receives a tag's codes. Costs: one person can hold many email wallets (partners running rewards
  should know); a Google login links automatically only with the untagged email identity; the identity token's email
  for a tagged login carries the tag.
- Cited and open: a deleted Gmail address can't be used by anyone in the future (support.google.com/mail/answer/61177,
  /56256); no current Google page says `googlemail.com` is the same mailbox as `gmail.com` (it is, historically); a
  Gmail user can now change their address, the old one becoming an alternate that still receives mail
  (support.google.com/accounts/answer/19870), so the same person can then have two email identities (the spec's
  "address changes between logins" case; nothing merges them).
- Rate limits: since tags are distinct identities, `normalizeEmail` also returns `mailbox` (the address without its
  `+tag`, on every domain), and the issuer's limits on codes sent key on it, so cycling tags can't mail one inbox
  without bound (automated security review of this change). It is never an identity or a recipient.
- Rejected: dropping `+tags` (the spec's rule: one wallet per inbox); keeping dots significant (an accidental second
  wallet); Gmail rules for Workspace domains (`+tags` elsewhere may be distinct mailboxes).

## Sign in with Apple, 2026-11-02

Decided in conversation on the Apple spec's questions (`docs/apple-login-spec.md`; the roadmap decision is D124).

### D160. Sign in with Apple paused; the initial build is Google and email
- Date 2026-11-02 · Status: confirmed by the user · Source: conversation (Apple spec questions)
- Decision: Sign in with Apple is not built for the initial launch; it is built when partners ask for it. The spec
  (`docs/apple-login-spec.md`) stays as the starting point. Answers given so far:
  - Q1 = B: Apple users' emails through a second, email-only Apple client whose tokens never go on chain (like Privy:
    partners get the email), at the cost of a second Apple prompt at an identity's first login in an app.
  - Q2, provisional: the Apple developer team of the company that publishes Hana Wallet and Wend, for testnet. To be
    confirmed or changed at the production-readiness check, before the address freeze.
  - Q3 = A: every Apple client in Hana's team; partner-held Apple accounts only if customers ask, for partners that
    start on them.
  - Q4 = A: the shared client in a Hana app group, each Enterprise client in its own group.
  - Q5 = A: partners' native iOS apps use the web flow (`ASWebAuthenticationSession`). A native-sheet
    "partner-managed Apple" tier only if customers ask: with the native sheet the partner's app receives the Apple
    token and can open sessions for its own users' wallets (partner custody within its scope), and those wallets
    differ from the same users' wallets in Hana's team.
  - Q6–Q18: open, asked again when the work resumes.
- Why: focus the initial build on Google and email; Apple adds an issuer, a second client, a POST route, watchdog
  and playbook work for a method no partner has asked for yet. Nothing built so far depends on Apple: the path format
  and the issuer model already take a new provider without moving any address (D124).

## Email login build, batch 5 (watchdog), 2026-11-02

Made while building `docs/email-login-build-plan.md` batch 5 (branch `feat/email-login-5`), where the spec's
"Watchdog (`apps/watchdog`)" section was silent or ambiguous. Each takes the stricter reading; none changes an
address. D190, D191 and D193 are confirmed by the user (2026-11-02); D192 is superseded by D200.

### D190. Email pins: absent means nothing pinned; a pin is the key's thumbprint, its kid and its signer
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); built (`feat/email-login-5`,
  `apps/watchdog/src/pins.ts`, `run.ts`), deployed on sandbox-dev 2026-11-02 (no pins yet) · Source: build of `docs/email-login-spec.md` "Watchdog"
- Decision:
  - The manifest's `watchdog.pinnedIssuerKeys.email` absent (sandbox-dev today, until batch 4 creates the key) means
    **nothing is pinned**, not "unchecked": a pending email Add is cancelled (`forged_key_change`, reason
    `not_pinned`), an active email key pauses (`forged_active_key`), and an email issuer or signer policy on chain is a
    critical `signer_policy_mismatch` (alert only while no key is active). A malformed `EMAIL_PINS` var is read the
    same way (and named in the `config` check). So the pins must be deployed before the owner posts the first email
    key, as batch 6 orders it.
  - A key is pinned when the RFC 7638 thumbprint of its on-chain `n`/`e` is listed for **its** signer (the pending
    change's `signer`; for an active key, the signer `get_self_issued` lists it under; an active key no signer lists,
    e.g. a dropped signer's, may be pinned under any signer) **and** its kid equals that thumbprint (Hana's issuer
    names keys so). Otherwise reasons `not_pinned`, `other_signer`, `kid_not_thumbprint`, `no_signer` (a pending Add
    without a signer: the email issuer isn't self-issued).
  - A pending pinned Add, and any pending email removal (owner only, DoS only), raise the info
    `self_issued_key_change` and nothing is called: the watchdog never confirms an email key (the contract refuses).
  - The pins are configuration, not history: unlike Google's first-run baseline, an unpinned active email key pauses
    at the first run too. As for Google (D82, D126), the pause also deletes every updater key.
  - Hana's published email JWKS (`jwksUrl`, default `{apiUrl}/v1/email/jwks.json`) is compared with the pins and the
    active email keys, warning `email_jwks_mismatch` only; a failed fetch warns after 3 runs and only while an email
    key is active (the issuer may not be deployed before that).
  - A v2 contract (no `get_self_issued`, `get_issuer("email")` null) reads as "no email issuer": no alert, pins or not.
  - Fail closed (review L1, L4): on-chain material that can't be hashed is `bad_material` (never judged by its kid); a
    malformed `EMAIL_PINS` raises the critical `pins_invalid` (check `config`) and the email key alerts it causes carry
    reason `pins_unreadable`, so the page names the config rather than a forgery.
  - Order (review H1, re-review): Hana's email JWKS is read after every protective step, the first alert delivery,
    the heartbeat, the run record and the lock release, guarded, with its body capped (64 KB); every body is capped:
    Google's JWKS and every RPC answer (4 MB). (The link scan that also ran there is gone with D200: link caps are a
    chain view, judged in the protective phase.)
    Hana's API is a party the watchdog must survive (D86): a huge or hostile body is a failed fetch.
  - `scripts/pin.ts` (`pnpm --filter @hana-id/watchdog pin <public key>`) prints a public key's pin with the same
    function the Worker uses, so batch 4's kid and the manifest's pin can't disagree.
- Why: the pins are the only truth for self-issued keys (no outside JWKS vouches for them); treating "no pins" as
  "skip the check" would let an owner post an email key unchecked on any env that forgot the block. A kid other than
  the thumbprint, or a key pinned for one signer posted for another, isn't what Hana's issuer produces.
- Rejected: absent pins = alert only (the old `unverifiable_key_change`); matching pins by kid alone (the kid is
  chosen by whoever posts the key).

### D191. A weaker signer policy, and the order to change the pins around a policy upgrade
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); built (`feat/email-login-5`, `pins.ts`
  `policyFindings`), deployed on sandbox-dev 2026-11-02 · Source: build of
  `docs/email-login-spec.md` "Watchdog" ("critical on any difference, pause on a weaker policy") and "Signing key
  (staged)" ("Level 1 adds `cosign: […]` and `required: 2` before its upgrade executes")
- **This overrides `docs/email-login-spec.md` line 867** ("Level 1 adds `cosign: […]` and `required: 2` before its
  upgrade executes"): the pinned `required` is raised only **after** the upgrade executed. The spec is history and is
  not edited.
- Decision: the pins are compared with `get_issuer("email")` / `get_self_issued("email")` (signers, `required` and
  `overlap_until_ms`; kids are judged per key). The chain's policy is **weaker**, and the watchdog pauses with a
  critical `signer_policy_mismatch`, when its `required` is below the pinned one, when it lists a signer the pins
  don't, when email keys are active with no signer policy at all, or when an overlap with the previous policy lasts
  longer than the contract's `POLICY_OVERLAP_MS` (10 min) plus one run interval (5 min): a `migrate` could otherwise
  keep a weaker previous policy (say 1-of-1) valid indefinitely, and `get_self_issued` shows only the end time, not
  the previous policy. An email issuer on chain with nothing pinned, or a pre-v3 email issuer, is also a critical
  `signer_policy_mismatch` (no pause). What a planned change passes through, none of it weaker, is a **warning**
  `signer_policy_transition` (no page, no pause, review L5): a pinned signer the chain doesn't list yet, the
  `set_issuer` → `mark_self_issued` gap with no key, a higher `required` on chain, an overlap of normal length. So the
  operator changes the pins around a policy upgrade in this order: pin the new signer's keys (with the current
  `required`) before the upgrade executes, raise the pinned `required` after it executed; replacing a signer: pin the
  new id first, drop the old id after. The governance diff's `email_signer_policy` includes `overlap_until_ms`.
- Why: the spec's literal order (pins at `required: 2` while the chain is still 1-of-1 for the upgrade's 72 h) would
  read as a weaker chain policy and pause every login for the whole wait. Pinning the new keys first is what matters
  (migrate installs them active at once, and an unpinned active key pauses).
- Rejected: no pause on policy at all (the spec asks for it); pausing on any difference (the planned transitions
  above would pause); a critical page for the transitions (it would repeat for the upgrade's 72 h).
- Contract note (not changed): `get_self_issued` exposes `overlap_until_ms` but not the previous policy's signers and
  `required`; a view that also returned them would let the watchdog judge the overlap's policy itself instead of only
  its length.

### D192. Link volume through a transactions indexer, detection only, with provisional thresholds
- Date 2026-11-02 · Status: **superseded by D200** (2026-11-02): the indexer scan, `apps/watchdog/src/links.ts`, the
  never-applied migration `0002_link_events.sql`, `watchdog.linkVolume`, `link_events_unavailable` and
  `link_block_unscanned` are removed; the contract counts and caps links and the watchdog reads `get_link_stats()`.
  Kept below as history · Source: build of `docs/email-login-spec.md` "Watchdog" ("Link-volume check from
  `identity_link_*` events (warning above the threshold)"; the spec names no threshold or event source)
- Decision:
  - Events are receipt logs, which no JSON-RPC view lists, and a block scan is far beyond a Worker run's budget. The
    watchdog reads the signer's transactions from a NEAR transactions indexer (manifest `watchdog.linkVolume.indexerUrl`,
    FastNear's transactions API: `/status`, `/v0/account`, `/v0/transactions`) and keeps only `EVENT_JSON` logs of
    standard `hana-id` the signer emitted in receipts that didn't fail. At most 100 transactions per run, 60 blocks
    behind the indexer's head; events are stored 8 days in D1 with scope and provider only (no identity key).
  - New links = `identity_linked` + `identity_link_proposed`; warning `link_volume_high` above 20 per scope or 100 in
    all in the last hour (provisional, `watchdog.linkVolume.perScopePerHour` / `perHour`). The other link events are
    counted in `/status` only.
  - Nothing is scanned while no email issuer is on chain (no link is possible); the first scan after it appears starts
    at the chain's head. Warning `link_events_unavailable` when no indexer is configured while email is on chain, after
    3 failed reads, or when the scan is more than 1 h behind.
  - Detection only: the indexer can hide events (a missed warning) or invent some (a false warning), never make the
    watchdog act.
  - Hardening (review M1, M2, L2, L8 and the re-review): the check runs after the run is recorded and the lock
    released (a CPU kill there can't hold the lock and skip the next run's protections), guarded (a throw marks
    `links` `error`, resolves nothing, and leaves the run `degraded`); it is skipped in a run that took protective
    actions (subrequests). The indexer answers of one scan share a 1 MB budget (a testnet login with its MPC
    receipts is ~75 KB, so ~13 per run: a busy signer falls behind, which warns); each answer is also capped, receipt
    ids must be NEAR ids, at most 2 000 events per scan. The indexer's head is clamped to the RPC's final block, and
    events dated more than 5 min in the future are ignored and pruned. Pages hold 200 transactions; a block the scan
    can't read whole even with a fresh budget (≥ 200 of the signer's transactions, or over 1 MB) is counted as far as
    the budget goes and skipped, so the scan moves on, with a critical `link_block_unscanned:<height>` open for a week
    (holding the cursor instead would stop detection for good). The schema refuses an indexer host naming another
    network.
- Why: the spec wants link bursts (the visible trace of a compromised issuer using the real key at 1-of-1) to alert;
  an indexer is the only source of events within the free plan's limits, and nothing on chain depends on it.
- Rejected: a contract view counting links (a contract change, outside this batch); scanning blocks through the
  watchdog's RPC (hundreds of requests per run); the console spec's relative rule ("5× its 7-day median", batch 9) for
  now: absolute thresholds work from the first day.

### D193. D139's unrecorded_wallets alert, and the email issuer in the governance diff
- Date 2026-11-02 · Status: confirmed by the user (2026-11-02); built (`feat/email-login-5`), deployed on sandbox-dev
  2026-11-02 · Source: D139; build of
  `docs/email-login-spec.md` "Watchdog"
- Decision: every run with `get_config().unrecorded_wallets == true` on an env that isn't a dev env (`local*`,
  `sandbox*`, the same rule as `@hana-id/env` `isDevEnv`) raises the critical condition `unrecorded_wallets` (alert
  only), resolved once the owner accepts. The governance diff also treats as critical: `unrecorded_wallets` changing
  (an upgrade setting it, `accept_unrecorded_wallets` clearing it), `email_issuer` (`set_issuer("email")` creating it or
  changing its iss values), `email_issuer_keys` (an active email kid gone without a queued removal), and
  `email_signer_policy` (`mark_self_issued`, or signers or `required` changed by an upgrade). With D200 the diff also
  carries the link alarm thresholds from `get_link_stats()`: `link_thresholds` rising (or appearing with the view) and
  a `pending_thresholds` raise appearing or changing are critical; lowering, or a pending raise cancelled, is a warning; a
  pending raise coming into force as scheduled is info.
- Why: D139 asks for the alert on every non-dev env; the owner's immediate email issuer actions leave no pending
  state, like Google's (`issuer`, `issuer_keys`), so the diff is the only place they show.

## Email login: user mail and link volume, 2026-11-02

Decided in conversation before email login batch 4 (D194), and after the batch 5 and link-cap reviews (D200).

### D194. User mail (email login codes) via SendGrid, not Resend
- Date 2026-11-02 · Status: confirmed by the user as likely, final once the colleague agrees · Source: conversation
  (before email login batch 4)
- Decision: the email issuer sends login-code mail through SendGrid (v3 Mail Send API), which Hana already uses for
  Hana Wallet and Wend. It replaces Resend for user mail (D87's provider). It sits behind the issuer's one sender adapter, so
  a later switch is a new adapter, not a redesign. Same rules as D87: a dedicated sending subdomain with SPF, DKIM and
  DMARC (SendGrid domain authentication), a send counts only when SendGrid accepts it (`202`), and its own API key
  restricted to Mail Send, used only by the email issuer (not shared with Hana Wallet or Wend; a separate SendGrid
  subuser if the account allows it, so reputation and suppression lists stay apart).
- Not changed yet: the watchdog's alert email and the admin Worker's notices still name Resend (D87); whether they
  move to SendGrid too is decided separately. **Settled by D401 (2026-11-05): they do, each with its own key, never
  through the issuer's subuser.**
- Why: one provider the team already operates and pays for; the adapter keeps the choice reversible.
- **Amended (2026-11-02, independent review M3; to confirm):** a SendGrid **subuser for the issuer is required**, not
  "if the account allows it": the issuer's suppression handling trusts only events of its own categories, and a shared
  account mixes other mail's bounces and suppression list with the issuer's.

### D200. Link volume: a contract counter with hourly alarm thresholds, replacing the indexer scan
- Date 2026-11-02 · Status: confirmed by the user: count and alarm, no refusal (option A, after review H1/H2);
  contract and watchdog built; the watchdog deployed on sandbox-dev 2026-11-02 (it skips the check on the v2
  contract), the contract not deployed (it comes with v3) · Source: batch 5 review (the FastNear scan reads about 13
  logins per run at about 75 KB each, so it falls behind and pages on ordinary traffic); the link-cap review (H1, H2)
- Threat, stated as it is (review H1): with a stolen email signing key alone (1-of-1 at launch) a thief can log
  into every email-rooted wallet, log into every Google-rooted wallet that already has an email member, and link their own Google account into victims' email
  wallets (case A, one Google account per victim and scope). Since D133 a link also needs the session key's signature,
  so the key alone can't join an email identity to someone else's Google wallet. Only the last of the three makes new
  links. The defence against a stolen key is its custody (KMS, a second signer, D121); the counter only detects bursts.
- Decision: the contract counts every new link, immediate or pending (the combined login with a `link_jwt`, cases A
  and B, and `link_identity`; not cancels, unlinks or lazy activations), in fixed UTC-hour windows, per scope and in
  total, and **never refuses a link**. When a count is at or above its threshold after a link, the window records it
  (`flagged_scopes`, `total_threshold_reached`) and the first crossing per window emits `link_threshold_reached`.
  Defaults 50 per scope and 500 in total per hour, changed by the owner (council) with `set_link_thresholds`: a
  lowering applies at once, a raise only after `governance_delay_ms` (a raised threshold could hide an attack). A view
  (`get_link_stats`) reports the current and previous hours; the watchdog reads it each run and alerts when a
  threshold is reached, and on a scheduled raise. The FastNear indexer scan (D192) is removed.
- Window boundary (review L1): the windows are fixed hours, so a burst that straddles a boundary is split between two
  windows and each half may stay under a threshold; the view keeps the previous hour so the watchdog can add them.
- Why: exact, on chain, no third party or data budget, cheap (≈ 0.3 Tgas per link) while v3 isn't deployed.
- Rejected: a refusing cap (option A+, built first). It bounded little (H1: the takeovers it was meant to brake need
  more than the key), and anyone could burn it (H2: one Google account and one email looping `link_identity` and
  `cancel_link`) and lock real users out of linking logins for the hour.
- Built (contract, branch `feat/link-cap`): `get_link_stats`, `set_link_thresholds`, events `link_threshold_reached`
  and `link_thresholds_set` (`docs/contract-interface.md` "Link volume: the hourly counter"). The view's `previous` is
  `null` when the previous hour had no links; its `total_threshold_reached` also reads the thresholds in force, so a
  lowered threshold shows at once. Per-scope counts are deleted lazily (each counted link deletes up to 4 older than
  the previous hour). `set_link_thresholds` and the other v3 owner methods are on the API's never-relay list.
- Built (watchdog, branch `feat/email-login-5`): the view is read with the chain snapshot, before the run is recorded
  and its lock released; `link_threshold_reached` (critical, per flagged scope and for the total, keyed by window,
  current and previous hour; alert only, the links went through), `link_volume_high` (warning, current total ≥ half
  `total_per_hour`), `link_stats_unavailable` (warning: `missing` with an email issuer on chain, `malformed`, or
  `read_failed`; open threshold alerts stay open while the view can't be read); a threshold raise (`link_thresholds`,
  `pending_thresholds`) is a critical governance change, lowering a warning; playbook `link-volume`. The read is
  isolated: a malformed or failing view marks only the link check, never the snapshot, so a shape mismatch after an
  upgrade can't blind the Google and email cancels and pauses.
- Not built: nothing on the contract or watchdog side. The watchdog is deployed (batch 5, 2026-11-02); the contract
  goes out with v3.

## Email login build, batch 4 (`apps/email-issuer`), 2026-11-02

Made while building `docs/email-login-build-plan.md` batch 4 (branch `feat/email-login-4`), where the spec was silent,
contradicted itself or allowed two readings. Each takes the stricter or safer reading. None changes an address: `sub`
is computed by `@hana-id/email` alone, from the normalized address including any Gmail `+tag` (D159).

### D195. Case A, not Google-hosted: google-match prepares the code challenge, the popup sends it with `resend`
- Date 2026-11-02 · Status: to confirm (built on `feat/email-login-4`, not merged) · Source: build of
  `docs/email-login-spec.md` "Endpoints" (`link` "from the user's Link and continue"), "How the popup gets Google's
  verified email" (the access token is revoked after the call) and "The four cases" ("a code to a…@domain first
  (purpose `auto_link`)")
- Decision: when google-match finds case A and the address isn't Google-hosted, it creates an `auto_link` challenge
  itself, holding Google's verified address, the Google `sub` and sha256 of this login's session nonce preimage, and
  sends nothing; it answers `challenge: {challengeId, expiresAtMs, to: "a…@domain"}` (no `challenge` for a suppressed
  mailbox or one the limits refuse, D198: the popup then offers only "Sign in with email"). After the user's "Link and
  continue" the popup calls `POST /v1/email/resend {challengeId}`, which sends that challenge's first code (it counts
  as a code, not as one of the two resends). `verify` then re-reads the chain (D133) and mints the `auto_link` token
  only if the case is still A and linkable (`409 link_refused {decision}` otherwise). `start` refuses purpose
  `auto_link`. `link` gates only the minting of `emailToken` (Google-hosted case A; case B with a `linkTicket`), so
  the vault sends `link: true` on its own at a Google login, as the spec says for Google-hosted case A.
- Why: the spec's two-step reading ("call again with `link: true` after the click") can't work, since the access
  token is revoked at the end of the first call, and a `start` with purpose `auto_link` would need the popup to hold
  or retype the address Google reported, letting the caller choose which address gets the code. Here only Google's
  verified address can receive it, and nothing is mailed before the user's click.
- Cost: the address sits in the challenge object for up to 10 minutes even when the user picks "Sign in with
  email" (the privacy table's "challenge object until it ends (≤ 10 min)").
- Rejected: not revoking the access token until the second call; letting `start` take `auto_link` with a typed
  address.

### D196. Manifest `emailIssuer` as `identityToken`; the standby key stays off the Worker; init uploads nothing
- Date 2026-11-02 · Status: to confirm (built) · Source: build of the spec's "Issuer configuration", "Signing key"
  and "Migration" ("the signing keys (primary, standby) as Worker secrets"); D173, D177
- Decision: `emailIssuer: {iss, cloudflare: {workerName, d1Name}, signer: {kind: "worker-secret", activeKid} | {kind:
  "aws-kms", awsRegion, keys: {primary: {kid, arn}, standby: {kid, arn}}}, publicKeys, from, sender: "sendgrid" |
  "outbox", dailySendBudget?, access?, sendgridWebhookPublicKey?}`. The JWKS is `publicKeys` alone (kid = RFC 7638
  thumbprint, checked by the schema; 2048–4096-bit RSA, e = 65537, one modulus once). The schema and `gen` refuse
  `worker-secret` off testnet and `outbox` outside `local*`; `gen` also refuses `aws-kms` until batch 10. The
  standby key is published and posted on chain but **kept off the Worker**
  (`.secrets/<env>/email-issuer-signing-key-standby.json`, to move offline), overriding the spec's "primary, standby
  as Worker secrets": a leak of the Worker's secrets then doesn't reach it, and switching to it is a real recovery.
  `scripts/email-issuer.ts init` writes the files and the block and uploads nothing; `put` (run by the user) uploads
  the active key and the three HMAC keys (and the SendGrid key when its file exists), values on wrangler's stdin.
- Why: one place that decides what the issuer publishes; the same model as the identity token's keys, for the same
  reason (D177).
- Left for later: a `switch` / `retire` command for email keys (a key change is also a 72 h owner proposal and a pin
  change, so it belongs with batch 10's rotation tooling).

### D197. A challenge lives 10 minutes from its creation; a refused send is taken back
- Date 2026-11-02 · Status: to confirm (built) · Source: build of the spec's "Codes, attempts, expiry, replay" and
  "Privacy and what is stored" (the address in the challenge object "until it ends (≤ 10 min)")
- Decision: a resend doesn't extend the challenge: every code of it dies 10 minutes after the challenge was created,
  so the address is never held longer. A send the provider refused is taken back from the limits and from the
  challenge's resend count. A suppressed address's challenge stores neither the address nor a code (every code is
  wrong, nothing is ever sent), so `start` still answers alike.
- Why: the stricter reading of the privacy table.
- Rejected: a fresh 10 minutes per code (up to 30 minutes of storage).
- **Amended (independent review L3):** a challenge id is 32 random bytes, a public half (the object is named by its
  sha256) and a secret half that only the client holds: the address in the record is AES-256-GCM-encrypted under a
  key derived from the secret half (the public half as AAD), so the object's storage, and any point-in-time copy of it,
  holds no readable address. The worker decrypts it only during a `resend` or `verify` that carries the full id.

### D198. The limits: per mailbox and requester, atomic, with a mailbox-wide backstop
- Date 2026-11-02 · Status: to confirm (built; values provisional per D123 Q22). Revised the same day after a security
  review of the first build (a check-then-count race in `verify`, and limits an attacker could use to lock an
  address's owner out) · Source: build of the spec's "Rate limits and abuse" and "Enumeration resistance"
- Decision:
  - **Mailbox** = `normalizeEmail(...).mailbox`, the normalized address without its `+tag` (D159), keyed as
    HMAC(K_rl, "mailbox" ‖ 0x00 ‖ mailbox): every per-mailbox limit uses it, so cycling tags can't mail one inbox without
    bound. It is a rate-limit key only: suppressions use the exact address (D199). Mail still goes to the tagged address.
  - **Atomic.** Every limit decision is one Durable Object call whose checks and writes run before any await. `verify`
    reserves the check in the mailbox's limiter (refused while locked) before the code is compared, and gets it back
    when the code was right; the challenge object counts its own attempts the same way, so concurrent guesses compare
    at most 5 codes per challenge and at most 10 per requester per mailbox (tested with parallel guesses).
  - **Code mails**: 3 per 15 min and 10 per day per (mailbox, requester = IP subject); 10 per 15 min and 30 per day per
    mailbox from everyone (the mail-bombing bound); past that, a reserve of 5 a day only for a requester new to the
    mailbox that day, so whoever used the allowance can't keep the owner out. At most 5 live challenges per mailbox. A
    start that is over any of these, or locked, stores nothing (no challenge, no code). At most 35 challenges per
    mailbox per UTC day.
  - **Wrong codes, worst case first.** Every path that compares a code goes through `verify`, which reserves the check
    in the mailbox's limiter before comparing (refunded only when the code was right). Per mailbox and UTC day, with N
    requesters (any number of IPs):
    - challenges created C ≤ 35 (a hard per-mailbox cap on every kind, google-match's prepared ones included; it also
      equals the code-mail bound, 30 mailbox-wide + 5 reserve), at most 5 live at once;
    - checks per challenge ≤ 5, so without the guess limits W ≤ 5 · C ≤ 175, whatever N;
    - the guess limits: every failed (or in-flight) check counts against a **hard ceiling of 25**; while fewer than 20
      have failed (the backstop), any requester may check; after that only the **owner slot**: 5 more checks, counted
      on their own, open only to a requester that started a challenge on this mailbox before the backstop tripped (the
      order is a per-object sequence, not the clock) and has no failed check on it that day, each such check counting
      as that requester's failure, so it gets one wrong code at most. The 10-per-hour per-requester lock applies too;
    - so W ≤ min(5 · C, 20 + min(5, E)) ≤ 25, where E is the number of exempt requesters; the ceiling is checked on
      its own and nothing passes it, whoever asks.
    - Odds: each wrong guess hits with probability 10⁻⁶ (a fresh uniformly random code per challenge), so a persistent
      attacker gets ≤ 25 × 365 = 9,125 guesses a year per mailbox: 1 − (1 − 10⁻⁶)^9125 ≈ 0.91% a year, under the 1%
      target (27 a day would be 0.98%). The spec's figure was 50 a day (1.8% a year).
    - When the backstop trips (for everyone but owner-slot requesters) or the ceiling is reached (for everyone), the
      mailbox answers the generic 429 ("try again later" in the popup) until the UTC day ends: an accepted, bounded
      lockout of at most the rest of that day. The tripping check logs `mailbox_guess_limit` at error level (`code`
      `backstop` or `ceiling`) with a 12-character prefix of the mailbox key (an HMAC under K_rl, never the address), so
      staff can see which mailboxes are being targeted and how often; the alert and the admin view are batch 9's.
    - 5 wrong codes kill a challenge; 10 per hour from one requester lock that requester out of that mailbox for an
      hour (the owner elsewhere is not affected).
  - **Refusals are a generic 429** (`rate_limited`, the same body as an IP or app limit), so the popup says "try again
    later" instead of waiting for a code that never comes. It tells the caller only that the mailbox is limited, never
    whether it has a wallet.
  - **Suppressed addresses take the same path**: `start` and `resend` reserve and count exactly as for any address
    (mailbox limits, live challenges, the global budget; never refunded) and answer alike, 202 or the same 429; only the
    provider call is skipped, and the challenge holds no address and no code. So no limiter answer tells a suppressed
    address apart.
  - Exact counts everywhere, per IP too: Cloudflare's Rate Limiting binding only has 10 s and 60 s periods (D95 is the
    vault's). Per IP: `start` 10 per 10 min and 50 per day, `verify` 30, `resend` 10 and `google-match` 30 per 10 min.
    Per app: `start` 20 × the plan's `per_minute` per minute (the spec's value, read literally) and the plan's
    `per_day` per day. Staff client proofs 20 per hour each. The global budget (`dailySendBudget`, default 1000 a
    day) counts every user mail, link notices included; at the cap `start` and `resend` answer 429 and the issuer logs
    `send_budget_exhausted` at error level (the alert itself is the admin portal's, batch 9).
- Overrides the spec: the per-address limits key on (mailbox, requester) plus a mailbox-wide cap, and the wrong-code
  lock is per requester inside a mailbox-wide ceiling of 25 a day, instead of "3 per 15 min, 10 per day per address"
  and "10 wrong per hour → 1 h lock" for the whole address; a limited address answers 429 rather than a silent 202.
- Why: the spec's per-address counters let anyone who knows an address use up its owner's codes, or lock it with ten
  wrong guesses; and a lock checked in one object and counted in another could be outrun by parallel guesses.
- **The trade-off, to confirm: brute-force resistance wins over availability.** A mailbox under a sustained guessing
  attack can be locked for the rest of the UTC day: an attacker who knows the address can fill its daily code
  allowance and reserve (35 mails) or make the 20 failed checks and use up the 5-check owner slot (a few requests from
  a handful of IPs), after which nobody, owner included, can get or check a code until midnight UTC. This is the usual
  OTP trade-off; the alternative (keeping the owner able to check) reopened the brute-force bound, since any
  exemption an attacker can also qualify for multiplies by the number of IPs. Numbers: at most 25 failed checks per
  mailbox per UTC day (≈ 0.91% a year), at most 35 challenges, a lockout of at most ~24 h per day of attack.
  Mitigations: the tripping check logs `mailbox_guess_limit` (error, mailbox key prefix) for staff, and staff can lift
  the lock with **`POST /v1/email/admin/unlock {email}`** (Cloudflare Access + the staff allowlist, audited in
  `email_admin_audit` with the mailbox key prefix, never the address; it clears that day's guess counters, the trip
  marker, the ceiling and the requesters' locks, not the code-mail counters). An unlock gives an attacker a fresh day's
  25 checks, so staff should unlock only after the user has contacted support. (Superseded after the abuse re-check:
  unlock now mails a one-time grant to the address and clears nothing; see the amendments below.) The admin portal's alert and button are
  batch 9's. It is the one staff body that carries an address (the spec's "only `start`" is about the browser routes).
- Accounting details: a check reserved and then found right is refunded, and so is the trip marker when that brings
  the backstop below its max (18 since the reviews); a challenge's place in the day's cap is refunded when the global budget refuses its start,
  when it can't be created, and when its first code isn't delivered (the challenge itself stays, for a resend).
- To check with the user: whether "20 × per_minute" was meant (1,200 starts a minute for a free-plan app; the global
  budget is then the binding cost bound).
- **Amended after the independent reviews (2026-11-02; every number below to confirm):**
  - **The global budget is shared out (H1):** an app may use at most 10% of `dailySendBudget` a day (free plan; one
    share for every plan until email-specific plan fields exist), and the last 20% only an app that has used less than
    half its share that day. `email_budget` is logged at 50% and 80% of the global budget and of each app's share;
    `send_budget_exhausted` names the limit (`global`, `app`, `reserve`). Batch 9 turns them into alerts.
  - **Aggregate requester limits (H1, L4):** besides the IPv4 address or IPv6 /64, `start` counts against the IPv4 /24
    and the IPv6 /56 and /48, each ≤ 200 a day. A request without a usable `cf-connecting-ip` is refused
    (`400 missing_client_ip`, logged) instead of sharing one bucket.
  - **Per recipient domain (H1, M4):** ≤ 100 code mails a day per registrable domain (Public Suffix List, so a catch-all's
    subdomains count together), except a listed set of large consumer providers (gmail.com, outlook.com, hotmail.com,
    live.com, yahoo.com, icloud.com, me.com, mac.com, proton.me, protonmail.com, gmx.{com,net,de,at,ch,fr,es,it,co.uk,us},
    qq.com, 163.com, yandex.{com,ru,ua,by,kz,com.tr}, mail.ru, aol.com, zoho.com; `src/domain.ts`).
  - **Per app:** `start` the plan's `per_minute` per minute (the "20 ×" dropped) and its `per_day` per day.
  - **Order: the requester pays first.** `start` counts the IP and prefix limits, then the mailbox (atomic), then the
    domain, then the partner's quota, then the budget; a later refusal refunds the earlier mailbox, domain and app counts
    (never the IP ones), so refused mailboxes can't burn a partner's quota or the budget.
  - **Owner device ticket (M1):** a successful `verify` returns `deviceTicket` = "dt1." + b64url(expiry ‖
    HMAC(K_device, domain ‖ mailbox key ‖ expiry)), K_device = HMAC(K_code, "hana-id/device-ticket-key/v1"), valid 30
    days, bound to the mailbox. A `start` that presents a valid one gets its own allowance, **3 code mails per mailbox
    per UTC day**, outside the code limits, the live cap and the challenge cap, and its challenge's checks may use a
    **ticket slot of 3** past the backstop. Only someone who read a code at that mailbox holds one. Batch 8's popup keeps
    it on `authOrigin`. The reserve for new requesters stays, but it bounds mail; it doesn't protect the owner (an
    attacker with many IPs uses it up too), which the earlier wording claimed.
  - **The ceiling is now 18 + 4 + 3:** a backstop of 18 open to anyone, the owner slot of 4 (started before the trip,
    no failure), the ticket slot of 3 (a ticketed challenge); still a hard 25 a day, 0.91% a year.
  - **Unlock grants (M1; bound to the owner after the scan, finding 1):** `admin/unlock` returns a one-time
    `unlockToken` ("ug1." + 32 random bytes; the mailbox object keeps only its sha256, 24 h) that staff pass to the
    owner. Only a `start` presenting it uses the grant: that start counts as ticketed (past the live and daily caps, the
    ticket's code allowance and guess slot, and the domain cap). A start that is then refused or whose mail fails gives
    the grant back. Any other requester, the attacker who caused the lockout included, gets nothing from the unlock but
    the cleared guess counters. (The first version granted the mailbox, so whoever started next took it.)
  - **The domain cap can't be filled by a few requesters (scan finding 2):** inside one domain's day, each requester
    prefix (IPv4 /24, IPv6 /56 and /48) may send at most 20% (20 of 100); ticketed and unlock-grant starts and their
    resends skip the domain cap altogether. `email_domain_cap` (warn, the domain key's 12-character prefix) is logged by
    the mail that fills a domain's day, for batch 9's alert. Owner-slot requesters do **not** skip it: owner-slot status
    (started before a trip, no failure) is reachable by an attacker, so it would hand the bypass back.
  - **One `retry-after` (L1):** every mailbox-level refusal (the mailbox's limits and locks, the domain cap) answers
    `retry-after: 900`, whatever the limit.
  - **Amended after the abuse re-check (2026-11-02; every number to confirm).** The principle: **a valid device ticket
    or unlock grant never depends on a pool an attacker can fill.** (Reworded after the final check, M1, to what is
    guaranteed: see the last bullet.)
    - **Budget (H1):** `dailySendBudget` is split: an **owner pool of 15%** for the mail of challenges a valid ticket or
      grant started and for the staff unlock/unsuppress mails, ignoring the app share (refined below: a staff pool, and the owner pool as a fallback); the **general pool (85%)** for
      everything else. An app's share of the general pool comes from its plan: **2% of the plan's `per_day`** (the free
      plan's 5000 gives 100), at least 10, at most the general pool; a flat 10% of the budget only when the plan has no
      usable `per_day`. The last 20% of the general pool stays for apps under half their share. `email_budget` is
      logged per app (`app_50`, `app_80`) and per pool (`global_*`, `owner_*`). `dailySendBudget` is **required** in
      the manifest outside `local*` envs (`email-issuer init --budget`); a Worker without it sends nothing and logs
      `send_budget_exhausted` `unconfigured`.
    - **Owner starts skip every shared pool:** a valid ticket or grant skips the IP prefix limits, the app's quota,
      the domain cap and the general budget pool; it still counts against its own IP subject (10 per 10 min, 50 a day).
    - **Domain cap (M1):** a registrable domain's cap is **100 + 2 × its verified logins over the trailing 7 UTC days**;
      a verified challenge gives its mails' places back; each requester prefix may use 20% of the day's cap. The
      exempt list adds the regional variants and more large providers (yahoo.co.{uk,jp,in,id,nz,th}, yahoo.com.{au,br},
      yahoo.{fr,de,es,it,ca}, hotmail.co.{uk,jp,th}, hotmail.{fr,de,es,it}, outlook.{fr,de,es,it,jp,co.uk,com.br,
      com.au}, live.{co.uk,fr,de,nl,it,ca,com.au,jp}, web.de, t-online.de, naver.com, 126.com, yeah.net, foxmail.com,
      comcast.net, orange.fr, free.fr, libero.it, pm.me, fastmail.com), each listed, never a wildcard.
    - **IP prefixes (M2):** the ticket and the unlock token are read and checked **before** the prefix limits (a grant
      against the mailbox object), and a valid one skips them. The prefix limits are raised to **1000 a day** each
      (IPv4 /24, IPv6 /56, /48) instead of counting only requesters new to the mailbox: simpler, and still bounds a
      /48's 65,536 /64s (chosen; to confirm).
    - **Unlock (M3):** `admin/unlock` **mails** the one-time token to the address (a link to `{authOrigin}/email/unlock#
      <token>`, the token in the fragment) and answers staff `{mailed}` only: whoever asks support, the attacker
      included, gets nothing. It **clears nothing**: the shared guess counters, the trip and every lock stay. The
      grant's start counts as an owner's; its challenge's mails are free (one challenge, ≤ 2 resends), its checks use
      the ticket slot and then the **grant slot of 2**, which lies outside the ceiling.
    - **The bound, with unlocks:** ≤ 25 failed checks a day (backstop 18 + owner slot 4 + ticket slot 3) plus ≤ 2 per
      unlock, with at most 3 unlocks in 30 days (≤ 37 a year): **365 × 25 + 37 × 2 ≈ 9,199 a year, ≈ 9,273 in the worst case, ≈ 0.92%
      a year** against a 6-digit code (the earlier 0.91% plus unlocks; the earlier unlock reset the counters, which gave
      an attacker a fresh 25 each time). Worst case per day W ≤ min(5·C, 25) + 2·[unlock that day], C ≤ 35 (+1 grant).
    - **Device tickets (abuse L1/L2, tokens N1):** "dt2." + b64url(expiry ‖ nonce ‖ HMAC(K_device, domain ‖ address key
      ‖ nonce ‖ expiry)): bound to the **exact normalized address** (its K_sup HMAC, so `x+tag@` and `x@` have their own
      tickets), with a 16-byte nonce; the 3 code mails a day are **per ticket**. Staff `admin/revoke-tickets {email,
      ticket}` revokes every ticket of that address issued until then (audited, 1 a day and 3 in 30 days).
    - The earlier "Unlock grants" bullet's staff-held token and the counters cleared by unlock are superseded by this.
    - **After the scan of the re-check (to confirm):** every `verify` mints a ticket, so allowances can't be per ticket:
      the 3 code mails a day are counted **per exact address** (all its tickets together); an address has at most **5
      live tickets** (the mailbox object registers each at issue; a 6th revokes the oldest; staff revocation clears the
      address's list, and an unlisted ticket counts as nothing); at most **10 owner challenges** (ticket or grant) per
      mailbox per UTC day. The budget becomes three pools: **staff** (1% of the budget, at least 5) for the unlock and
      unsuppress mails; **owner** (15%), which an owner's mail draws on only when the general pool refuses it, at most
      **20% of it per app**; **general** (the rest, 84% of 1000). A resend's domain and budget steps use the owner kind
      `reserveSend` found after the revocation check, so a revoked ticket's challenge gets no owner path. The domain cap
      counts **distinct verified mailboxes** a day, only of challenges that reserved a domain place, and never passes
      **2,000 a day**; past it only exempt providers and owner starts pass.
    - **After the final check (M1; to confirm), superseding the owner-pool details above.** Tickets aren't bound to an
      app, so a per-app owner cap could be filled by an attacker's sock-puppet tickets (addresses at a catch-all domain
      he controls) and deny that app's real owners. So: no per-app owner cap. The **owner pool is 1 × `dailySendBudget`
      beside the budget** (it never eats the general pool, which is the budget minus the staff pool). Owner mail is
      bounded by 3 code mails a day per address, **10 ticket challenges a day per exact address** (was per mailbox) and
      that global ceiling; **once the owner pool passes 50% for the day, only tickets at least 7 days old and unlock
      grants draw on it** (a fresh ticket's mail is then an ordinary user's, in the app's general share).
      `email_owner_pool` is logged at 50% and 80%.
    - **What is guaranteed (the principle, reworded):** A valid device ticket or unlock grant never waits on the IP prefix limits, an app's quota, a recipient domain's cap or the general budget pool; its mail comes from the owner pool, which a
      fresh ticket can fill only to half. **Residual, to confirm:** an attacker who has built up a large stock of
      sock-puppet tickets at least 7 days old (real verified logins, 3 mails a day each) can still use up the owner pool
      for a day, bounded by its global ceiling (1 × `dailySendBudget` of extra mail); real owners are then refused until
      the UTC day ends, as they would be without tickets. Staff revocation and the 5-live-tickets-per-address cap limit
      the stock; batch 9's `email_owner_pool` alert shows it.
    - **Final round (to confirm), superseding the owner-pool size and the per-address-only counts above:**
      - Owner challenges and ticket mails are counted **per exact address (10 challenges, 3 mails a day) and per
        mailbox (30 challenges, 9 mails a day)**, unlock-grant starts included in the mailbox's 30. The `+tag`s of one
        inbox share a bounded allowance: a `+tag` holder (on a domain without sub-addressing, a different person) can't
        use up the victim's per-address allowance and takes at most a third of the mailbox's.
      - The **owner pool is 30% of `dailySendBudget`**, beside it: all mail together ≤ 1.3 × the budget. A fresh ticket
        (< 7 days) draws on it only below half of it and within **20% of it per app**; aged tickets and grants have no
        per-app cap (bounded by the per-address and per-mailbox limits and the pool). Owner mail the owner pool refuses
        **falls back to the app's general share**, if any is left, instead of failing.
      - **The mailbox's own address is never blocked by the mailbox totals (to confirm):** the exact untagged address
        (the address equal to its mailbox) and unlock grants count toward the mailbox's 30 owner challenges and 9 ticket
        mails but are never refused by them, only by their own per-address limits (10 and 3) and the grant rules; tagged
        addresses keep both limits. So on a domain where `+` isn't sub-addressing, other people's `+tag` addresses can
        fill the mailbox totals without blocking the bare address's owner.
      - **Residuals, to confirm:** (1) a stock of ≥ 7-day-old sock-puppet tickets (real verified logins at addresses the
        attacker controls, 3 mails a day each, 9 per mailbox) can use up the owner pool for a day, at most 0.3 × the
        budget of extra mail; real owners then fall back to their app's general share. (2) Holders of 3 `+tag` addresses
        of one inbox (only where the domain gives `+tag`s to other people) can use the mailbox's 9 ticket mails and 30
        owner challenges for every other `+tag`; the bare address keeps its own 3 and 10. (3) Fresh
        tickets of one app take at most 20% of the pool, so five attacker-held apps can fill the fresh half.

### D199. HTTP, data and chain readings of the issuer
- Date 2026-11-02 · Status: to confirm (built) · Source: build of the spec's "Endpoints", "The four cases",
  "Privacy and what is stored", "Deliverability" and "Issuer configuration"
- Decision:
  - CORS per route: `start`, `resend`, `verify` for `authOrigin`; `google-match` for `vaultOrigin` (the spec says
    "authOrigin only" but also that the vault sends google-match); a browser route without that exact `Origin` is
    403, and needs `Content-Type: application/json`. JWKS and discovery are `GET` with `*`. Every response `no-store`.
  - The issuer reads the API's D1 read only (binding `APP_DB`: `apps`, `plans`); `apps.login_methods` is expected
    comma-separated (`'google'`, `'google,email'`), and until the API's batch 6 migration adds it, email is off for
    every app. `email_hints` (issuer D1) holds `(scope_id, email_sub, google_sub, updated_at_ms)`, written at every
    google-match with a Google-verified address; `verify` (purpose `session`) reads at most 4 hints and answers
    `googleWallet: true` when a hinted Google identity has the wallet in case B, with a `linkTicket` only when the
    contract would accept the join. Tickets live in the `EmailChallenge` namespace (`t:` + sha256 of the ticket),
    single use for any google-match that presents them.
  - Before minting any link token (`auto_link`, `link_new`, `link_account`, `link_change`) the issuer reads
    `get_config().unrecorded_wallets` fresh: while it is true (D135) google-match answers `linkable: false` and
    `verify` `409 links_unavailable`.
  - google-match answers `{decision, googleHosted, linkable, emailToken?, linkImmediate?, challenge?}`; `decision` is
    `none`, `linked`, `pending`, `both_wallets`, `unlinked`, `case_a` or `case_b`, judged exactly as the contract's
    `auto_link` (`linkable` false when the account is full, already has the joiner's provider, or the joiner is
    linked elsewhere: the popup then offers only "Sign in with {the other method}").
  - Client proofs: `sub` = `hana-client-proof` (never an `e1.` sub); Access and the staff allowlist come from
    `emailIssuer.access` (its own Access application on that path, D88's second check); every proof is a row in
    `email_admin_audit` and `email_issuance`.
  - Suppressions are fed by SendGrid's **signed** Event Webhook (`POST /v1/email/webhooks/sendgrid`, ECDSA P-256 over
    timestamp ‖ body, ≤ 10 min old): hard bounces and spam reports, stored as `email_key` = HMAC(K_rl, the exact
    normalized address, `+tag` included), the spec's definition. Not the mailbox key: on a domain where `+` isn't
    sub-addressing, `victim+x@domain` is someone else's mailbox, and making it bounce must not suppress `victim@domain`.
  - A chain or Google outage after a correct code (verify of `session` reading hints, or `auto_link`) answers 502 and
    the code is spent: the user starts again (never a guessed `googleWallet: false`, which could make a second wallet).
- Why: each closes a gap the spec left, on the side that keeps a matched person to one wallet and addresses off logs
  and storage.
- Open for batch 6: how `{apiUrl}/v1/email/*` reaches this Worker. On sandbox-dev (`*.workers.dev`) the API Worker
  would forward it through a service binding, so request bodies (addresses and codes) would pass through the API
  Worker's memory; a route on a Hana zone in production avoids that. Decided by D230 (batch 6): the issuer's own
  workers.dev URL on sandbox-dev (`emailIssuer.url`), a zone route in production; never through the API.
- **Amended after the independent reviews (2026-11-02; to confirm):**
  - **Staff routes (M2):** every `admin/*` route needs `Content-Type: application/json` and refuses any `Origin`
    header (no cross-site simple request can reach them), takes a support reference `ticket` (1–64 characters) kept in
    the audit row, and writes the audit row **before** acting. Unlocks and unsuppressions are capped per mailbox at 1 a
    day and 3 in any 30 days. The Access application's session cookie is to be set to SameSite=Strict (operations).
  - **Client proofs (tokens review L6):** minted only for a scope `get_scope` returns now (no cache), with
    `actionNonce` equal to its current `action_nonce` and at least one active app with email on.
  - **Suppressions (M3):** `admin/unsuppress {email, ticket}` (capped and audited like unlock; SendGrid's own list is
    cleaned by hand, runbook). The webhook counts only events of the issuer's own categories (`hana-id-code`,
    `hana-id-link_notice`). A bounce lapses after 30 days; a complaint lasts until a staff unsuppress. Suppressions are
    keyed by K_sup = HMAC(K_sub, "hana-id/suppression-key/v1"), so rotating K_rl or K_code never drops them (K_sub is
    never rotated). `email_complaint_rate` is logged when the complaints of 24 h pass 5 (M4).
  - **Webhook (L5):** the timestamp and signature shape are checked before the body is read, the verification key is
    imported once per isolate, and the route is limited per IP (120 per 10 min).
  - **Access (L6):** a failed certs fetch or an unknown kid is negatively cached for 30 s.
  - **Per-purpose mail (tokens review M1):** each purpose has its own subject and wording (`session`: sign in;
    `link_new`: add this email; `link_account`: allow another sign-in method to open the wallet this email opens in X;
    `link_change`: remove or cancel a sign-in method; `auto_link`: link your Google sign-in to the wallet this email
    opens). The spec's "Phishing" wording ("add this email to an existing wallet" for every link purpose) was wrong for
    `link_account`, `link_change` and `auto_link`; the spec is history and is not edited.
  - **Case B on the server (tokens review L1):** when `verify` finds that a hinted Google identity has the wallet
    (case B), it returns no `idToken` (`{googleWallet: true, linkTicket?, deviceTicket}`), so an email login can't open a
    second wallet even if the popup misbehaves. Hints are written for every Google-verified address (D119, as the user
    decided): a Google-hosted case B links at once, any other only after 24 h (mode 0), with a link notice to the
    address. (A first version of this fix wrote hints only for Google-hosted addresses; it was reverted because it
    overrode D119.)
  - **Residual risk, to confirm (tokens review L1, scan of the D119 revert):** for a non-Google-hosted address, Google's
    word that an account has the address says nothing about who reads the mailbox today. A stale Google account G still
    holding an old address (a former employee's, a recycled domain's) can steer the address's new owner E, at E's email
    login, to G's wallet in a scope: E gets no session of its own there (case B withholds `idToken`) and is offered the
    link. Bounds:
    - **180 days:** a non-hosted hint counts only while G logged in with that address within the last 180 days
      (`email_hints.updated_at_ms`, renewed at every such Google login); older non-hosted hints are ignored and pruned
      (the address's own at each `verify`, up to 50 others at each hint write). Hosted hints don't lapse.
    - **24 h and notices:** a non-hosted case B joins only after 24 h (mode 0), and the address gets a link notice.
    - **A cancel frees E:** while the join is pending, a cancel by G's wallet or by E itself (`cancel_link` with a
      `link_change` "cancel" code) removes it, and E's next email login gets its own wallet.
  - **The alternative, for the user to choose (proposed by the scan):** for a non-hosted address, give E its own
    session in case B and make the link an option the popup offers, at the cost of D122's "no second wallet" for those
    addresses (a person whose old Google account really has the address would then hold two wallets in that scope until
    they link). The code does the stricter D119/D122 reading with the 180-day bound.
  - **Link tickets (tokens review L2):** a `linkTicket` is bound to the app, the address's `sub` **and** the hinted Google
    identities found in case B; google-match accepts it only for one of those (binding the relayId is left for batch 8).
  - **Retention (independent review L3):** SendGrid's Email Activity keeps each message's recipient and events (3 days,
    longer only with the paid Email Activity History add-on, per SendGrid's docs at the time of writing; check at setup)
    and Hana can't shorten it: "the minimum the plan allows" means not buying the add-on. The issuer's own logs and
    storage hold no address. `email_issuance` pruning (24 months, D90) is a batch C13 follow-up. **Corrected (abuse
    re-check):** SendGrid's suppression lists (bounces, blocks, spam reports) keep the address **until it is removed**,
    whatever the Email Activity retention; the runbook's unsuppress step removes it there.
  - **Amended after the abuse re-check (2026-11-02; to confirm):**
    - **Staff mail to the address (M3):** `admin/unlock` mails the unlock link; `admin/unsuppress` mails a one-time
      confirmation (`{authOrigin}/email/confirm#uc1.…`, 24 h) and the suppression is removed only by
      `POST /v1/email/confirm {token}` from `authOrigin` (IP-limited like `resend`), so only the mailbox's holder can
      undo a suppression. Both mails are categories `hana-id-unlock` and `hana-id-confirm` (the webhook counts them),
      from the owner pool. Staff see `{mailed}` and never a token. `admin/revoke-tickets` is new (D198).
    - **The spec's "Phishing" line (spec line 319: "the link purposes use different wording ('add this email to an
      existing wallet')")** is superseded by the per-purpose texts above; the spec is history and stays as written.
    - **Access negative cache (L3):** a failed certs fetch or an unknown kid is cached for 30 s, so a burst of forged
      kids can't make the Worker refetch the certs; a real key rotation is picked up at most 30 s late.
    - **Webhook limit (L4):** 120 posts per 10 min per IP is a guess at SendGrid's batching; watch `limit` lines for
      `ip:webhook:10m` on sandbox-dev and raise it if SendGrid's real traffic reaches it (a refused post is retried by
      SendGrid).

## Batch C build, step C2 (`packages/oidc`), 2026-11-02

Made while building `docs/batch-c-build-plan.md` C2 (branch `feat/batch-c-2`), where `docs/batch-c-spec.md` was silent
or allowed two readings. None changes a derivation path or an address.

### D201. The new ID-token claims: typed on request (strict for the console), ignored by the API
- Date 2026-11-02 · Status: **to confirm** · Source: build of `docs/batch-c-spec.md` "Code flow" (`verifyIdToken`
  gains `email`, `email_verified`, `iat`, `hd`, `azp`, `amr`, `auth_time`); C2 review M1, L1
- Decision (`packages/oidc/src/id-token.ts`, `VerifyOptions.optionalClaims`): each claim is optional and is returned
  only when the token carries it with the right type: a JSON string (`email`, `hd`, `azp`), a finite number (`iat`,
  `auth_time`), an array of strings (`amr`), or for `email_verified` a boolean or the string `"true"` / `"false"`,
  returned as a boolean. Absent claims have no key in `VerifiedToken`. A wrongly typed claim:
  - `'ignore'` (the default, every API call): dropped, the token kept. The API's answers are develop's: a token with
    `email_verified: "x"` on `/v1/sessions` still gets to the claim allow-list (`token_has_pii` with the flag on).
  - `'strict'` (the console, C9, which reads them): the token is `invalid_token` ("Malformed token claims").
  The claims are checked after the expiry check, so the order of refusals (format, issuer, expiry, then these, then
  the JWKS) is develop's. `nonce` keeps its rule (a non-string is `null`, which every caller refuses). The checks stop
  at types: `email_verified === true`, the `iat` age (120 s), the step-up's "no `email`" and the `hd` membership rule
  are C9's.
- Why strict for the console: its step-up rule ("must carry no `email`") must not pass a token whose `email` is only of
  the wrong type, as dropping it would. Why ignore for the API: it reads none of these claims, and the C2 brief is "no
  change in behaviour for the API". Why accept the strings: Google's OpenID Connect documentation shows
  `"email_verified": "true"` in its example ID token payload; current tokens carry a JSON boolean, but a check that
  refused the documented form could lock out a real sign-in.
- Also (review L2): an `exp` that isn't finite (`1e400` parses as Infinity, a token that never expires) is
  `invalid_token` in both modes. On develop it passed the API's check; the contract would still refuse it.
- Rejected: strict by default (the first C2 draft), which changed the API's answers; a boolean-only `email_verified`.

### D202. The Access JWT check: aud as string or array, 60 s skew, certs ≤ 10 min old, staff list outside
- Date 2026-11-02 · Status: **to confirm** · Source: build of `docs/batch-c-spec.md` "Hana admin console" (JWT check on
  every `/api/*` request) and "Admin and email" tests; C2 review M2, L3
- Decision (`packages/oidc/src/access.ts` `AccessJwtVerifier`, for C8): RS256 only, a non-empty `kid` in the team's
  certs (`https://<accessTeamDomain>/cdn-cgi/access/certs`, through an injected fetcher), `type === 'app'`, `iss ===
  https://<accessTeamDomain>`, `aud` the AUD tag or an array containing it (Access sends a one-element array; RFC 7519
  allows either), `exp` with 60 s skew, `nbf` (when present) with the same skew, `iat` optional but numeric, a
  non-empty string `sub` and `email`; a token over 8 KiB or with invalid UTF-8 is malformed. Every claim is checked
  before the certs are read. The result carries `sub`, `email` as sent, `kid`, `exp`, `iat`; the lowercased-email
  check against `admin.staffEmails` stays in C8 (with "an email not on the list" as its test).
- The certs: each fetch has an 8 s timeout (body included) and a 64 KiB body cap; a set is fresh for its `max-age`
  with no floor (`max-age=0`, `no-cache` or `no-store` mean every request refetches) and at most 10 min
  (`ACCESS_CERTS_MAX_TTL_MS`; 10 min without a header); an unknown kid refetches at most once a minute; after a
  failure, no new attempt for 10 s. A set is never served past its freshness: a failed fetch throws
  `JwksUnavailableError` (fail closed; C8 chooses 503 or 401). **Staleness bound:** a cert Cloudflare withdraws is
  trusted by an isolate for at most min(its max-age, 10 min) after that isolate's last successful fetch.
- **Construct once per isolate** (module scope, or built on the first request and kept): the cache lives in the
  instance, so one verifier per request fetches the certs on every request.
- Why: the spec lists the checks without the encoding details; the skew covers Access minting `nbf = iat = now` on
  another machine; the admin path should never trust a set Cloudflare may have withdrawn for long, and Google's
  5-minute floor and 6-hour grace exist for login availability, which the admin console doesn't need.
- Rejected: a strict one-element `aud` array; no skew; Google's cache rules for Access; putting the staff list in the
  package (the manifest is C8's).

### D203. The package logs nothing: the API passes its stale-JWKS log in; fetch limits on Google's JWKS too
- Date 2026-11-02 · Status: **to confirm** · Source: build of `docs/batch-c-build-plan.md` C2 ("unchanged in behaviour
  for the API"); C2 review M2
- Decision: `@hana-id/oidc` keeps the module-level, per-isolate Google JWKS cache and the same exports as
  `apps/api/src/{jwt,jwks}.ts` (`verifyIdToken`, `publishedKeys`, `clearJwksCache`, `JwksUnavailableError`,
  `providerForIssuer`, `IDENTITY_TOKEN_TYP`, …); the `jwks_stale` warning becomes a `VerifyOptions.onStaleKeys` hook,
  which every API call site sets to `logStaleJwks` (`apps/api/src/log.ts`), so the log line is unchanged.
  `KeyObserver` and `cacheMaxAgeS` moved into the package (`key-observations.ts` re-exports the latter). JWKS
  parsing stays in `@hana-id/jwks`, which the package depends on; the watchdog is untouched. Google's JWKS fetch
  keeps its TTL rules (max-age clamped to 5 min..6 h, `no-cache` ignored, 6 h stale grace) and gains the same 8 s
  timeout and 64 KiB body cap as Access (a hung or oversized answer is a failed fetch: stale grace, then 503).
- Why: a shared package can't import an app's logger, and an injected hook keeps it testable without log scraping;
  an unbounded fetch could hold a login for the Worker's whole time limit.
- Rejected: the package writing the API's log format itself; an API wrapper module around the package.

## Batch C3: hot DB expand, the gate on it, the CLI on it (2026-11-02)

Readings made while building `docs/batch-c-build-plan.md` C3 on `feat/batch-c-3`, where `docs/batch-c-spec.md` left a
detail open. Each follows the spec's intent; all five are **to confirm** by the user.

### D205. Migration 0006 details: the baseline keeps policies as stored; four extra checks
- Date 2026-11-02 · Status: to confirm; built (`apps/api/migrations/0006_dashboard_expand.sql`) · Source: spec §Hot DB
  "Migration 0006"
- Decision: (1) the `migration.baseline` row lists each app's stored `auto_approve_policy` / `auto_approve_pending`
  JSON (and their effective time, the raw-signing values and `suspended_by`) instead of their `policyId`: SQL can't
  compute a `policyId` (SHA-256 of the canonical form), and the JSON is what drift detection (C5) derives it from.
  (2) The insert and org/scope update triggers on `apps` also refuse a `publishable_key` whose prefix isn't the
  scope's environment (the spec names this check only for `app_keys`; it is the "trigger" through which the legacy
  column is still read). (3) A trigger keeps `scopes.environment` fixed. (4) `detail_json` columns must be valid JSON
  and `org_security_contacts.email` lowercase (CHECKs). Also: the migration times are `unixepoch('now') * 1000`, the
  backfilled keys' `created_at` is their app's, the baseline's request id is `migration-0006:<app id>`, and the
  triggers are created after the backfill (which satisfies each).
- Why: each only refuses rows the spec says must never exist (a test/live mix, a changed environment, malformed
  ledger rows); none changes an existing row or answer.
- Rejected: computing ids in the migration through a Worker step (a migration must be plain SQL that runs in order).
- Forward obligation (C3 re-check): the `no_session` waiver (D206) reads the legacy D1 `usage` table, which C4 stops
  writing and C4b's 0007 drops. Before 0007, C4 replaces that check with one that still sees new sessions (a hot-DB
  marker the API writes beside the relay, not a Neon read); written in `docs/batch-c-build-plan.md` C4. Discharged in
  batch C4 by the `session_markers` table (migration 0009, D220), in both waivers: the CLI's
  (`scripts/lib/admin-sql.ts`) and `AdminRpc.ackNotice`'s (`apps/api/src/changes/lifecycle.ts`, batch C5, switched
  when C4 merged after it). No code reads the legacy `usage` table any more.

### D206. CLI readings: environment, actor, waivers, one ledger row per write, no cancel command
- Date 2026-11-02 · Status: to confirm; built (`scripts/lib/admin-apps.ts`, `admin-sql.ts`, `admin-settings.ts`) ·
  Source: spec §CLI, §Guarded changes
- Decision: `app:create` needs `--environment test|live` for a scope with no app yet (no default: the choice is
  permanent for the scope) and takes the scope's own otherwise. The actor is `cli:<operator login>` (`hana` kind). The
  `no_session` waiver is recorded as a candidate on the initial origins of an `app:create` that created the scope row
  and is granted or dropped inside the announcement's own SQL (review M1: no check-then-write gap), fail closed: only
  while `first_session_at` is NULL (the API writes it at every session-pool relay attempt, not only on a 200), no
  origin of the scope's apps is or was in force other than the same `app:create`'s initial ones (an announced, due
  `origin_add`, or an `app_origins` row in force), and no app of the scope has a vault share, a usage row or an
  identity count. The same `app:create`'s initial origins don't count against each other, so each of them gets it.
  CLI proposals never get the `loopback` waiver (the spec gives staff proposals none but `no_session`). The
  `assigned_at` + `appChangeDelayMs` refusal applies to `app:create` on an existing scope too. Each write records one
  `app_changes` row (a settings write that changes several things lists them under `parts`). A change whose clock has
  passed but which the cron hasn't recorded yet counts as in force: it doesn't block a new proposal ("at most one
  pending") and ends, not cancels, when removed. There is no `app:changes:cancel`: removing the origin or turning the
  setting off cancels a pending change. `app:changes:announce` keeps a matured pending policy as the stored one before
  writing the new pending one (as batch B's CLI did), and likewise a matured pending raw-signing value. Re-setting the
  policy in force over a pending proposal also keeps a matured pending policy as the stored one before clearing the
  columns (review H1: clearing them alone brought the older stored policy back with no delay). `--raw-sign approval`
  is refused for a test app: the spec's "test apps never sign raw", which is D39 as amended on 2026-10-28 (the vault
  refuses raw signing for every `pk_test_` app); refusing it at the CLI too is a C3 reading, to confirm.
- The deployed API's build gates proposals (review M2): with `--remote`, every proposal and announcement first needs
  `GET /v1/health` to report `hotDb` ≥ 6 (the batch C3 reads; `apps/api/src/apps.ts` `HOT_DB_SCHEMA`), because an older
  API would treat a proposed origin as in force. The rollback floor is batch C3: running an older API on the 0006
  database first needs `app:origins:park --yes` (deletes every origin row not in force, listing them in
  `origin.parked`; `app:origins:unpark` restores exactly those, only while their change is still open, and
  `app:origins:remove` closes a parked origin's change even with no row; `docs/operations.md` "Rolling the API back below batch C3").
- Obligation for `apps/email-issuer` (branch `feat/email-login-4`), recorded here (review L4): it finds apps by
  `apps.publishable_key` and checks only `status`. That is right on today's data (the trigger keeps `status` equal to
  the bitmask; the column holds each app's first key), but it must move to `app_keys` (an unrevoked key),
  `deleted_at IS NULL` and `suspended_by = 0` before batch C5 ships key rotation, revocation and app deletion. The
  "no code reads `apps.publishable_key`" check (`apps/api/scripts/test/hot-db-reads.test.ts`) scans every
  `apps/*/src` and allowlists `apps/email-issuer` until then. Done in email login batch 6 (D233): the issuer reads
  `app_keys`, `deleted_at` and `suspended_by`, and the allowlist entry is gone.
- Why: the spec's table lists the commands but not these edges; each choice keeps the CLI's writes the ones
  `AdminRpc` will make, and never makes a change live sooner than the spec allows.

### D207. CLI writes: the commit row first, everything else gated on it, read back
- Date 2026-11-02 · Status: to confirm (settled by the M1 rehearsal, below); built and tested on SQLite · Source:
  spec §RPC "CAS" applied to the CLI; batch B's settings guard; review L2 and its re-check
- Decision: every CLI write is one `wrangler d1 execute --command` of several statements: first the write's
  `app_changes` row, inserted only while the compare-and-swap predicate holds (the version read, or for settings also
  every settings column as read); then the version bump with the same predicate and only if that row exists; then
  every other statement only if that row exists. The CLI reads the row back and reports a stale write. No statement
  depends on another's row count (`changes()`). The CAS is safe because D1 runs each query (one `--command`, all its
  statements) as one implicit transaction: nothing else writes between the predicate and the bump, and a failing
  statement aborts the whole write. (The CLI tests run each command statement by statement, with no transaction
  around it, which shows the ordering needs nothing more within one writer.)
- To confirm: the M1 rehearsal (`docs/operations.md` step 3) checks on a scratch remote D1 that a `--command` whose
  last statement fails leaves its first one unapplied, and runs one CLI CAS write (`app:suspend`, `app:resume`)
  through the real path; that settles this decision.
- Rejected: a guard UPDATE followed by `WHERE changes() = 1` (relies on SQLite's per-connection row count across
  statements); a bare version check on each later statement (`version = read + 1`), which another writer's bump to
  the same number would satisfy.

### D208. The vault endpoints' app cache keeps its 30 s
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/app-cache.ts` unchanged, `getAppByKey` filters) · Source:
  spec §Hot DB "Login-path reads" ("any future app-config cache … TTL ≤ 10 s"); D78
- Decision: D78's cache stays at 30 s. It caches what `getAppByKey` returns, the origins in force at the read, so it
  never serves a pending origin early; one that comes into force is served from the next read (≤ 30 s late), and a
  removal, suspension or key revocation reaches the vault endpoints within 30 s, as since D78. `GET /v1/app`, the
  relay endpoints and the vault page don't use it.
- Why: the spec's 10 s is for a future cache; this one predates it and its bound only delays what is already safe (an
  activation) or what D78 accepted (a removal on the vault endpoints). Lowering it costs a D1 read per reload unlock
  per 10 s per isolate; a one-line change if wanted.

### D209. The gate keeps `scope_conflict` as a second check; `first_session_at` at the relay attempt
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/apps.ts`, `handlers.ts`, `login.ts`, `vault/*`) · Source:
  spec §Hot DB "Login-path reads"
- Decision: the batch B `scope_conflict` subquery is gone (replaced by `scopes.environment`, as the spec says), but
  the gate still answers `403 scope_conflict` when the key's prefix names the other environment than its scope (only
  a direct `app_keys` edit can produce it: the triggers refuse it otherwise). The dev-env partner calls and the
  timings in success bodies follow `environment = 'test'` like the loopback rule. `first_session_at` is written when
  a session-pool relay (`/v1/sessions`, `/v1/login`, `/v1/derive`, `/v1/sessions/revoke`) is about to be sent, beside
  it (review M1; first built as "after a 200", which a lost answer or a timeout followed by `/v1/derive` would miss).
  The hourly job also skips a `policy.ended` row already written (two `policy_set` changes due in one run, review
  L1). The hourly job
  cancels (`system`, reason `not_in_force`) a due change whose value is no longer pending or stored in `apps`, rather
  than recording it active.
- Why: a test key's dev-env privileges must never reach a live scope even after a manual write; the `no_session`
  waiver must fail closed, so any attempt to open a session ends it.
## Partner identity token, build step 8 (watchdog), 2026-11-02

Made while building `docs/identity-token-spec.md` "Build order" step 8 (branch `feat/identity-token-8`), where the
spec ("JWKS and discovery", "Pinning") was silent or allowed two readings. None changes a derivation path, an address
or the contract. All five are **to confirm** by the user.

### D210. The identity JWKS check: pins in the watchdog's config, an outside probe, alerts only; detection, not prevention
- Date 2026-11-02 (amended the same day after the step 8 review: H1, H2, M2, L1, L2) · Status: **to confirm**; built
  (`packages/jwks/src/identity.ts`, `apps/watchdog/src/identity.ts`, `run.ts` `identityJwks`,
  `scripts/lib/identity-probe.ts`, `.github/workflows/identity-probe.yml`) · Source: spec "JWKS and discovery" ("the
  watchdog fetches the JWKS every run and raises a critical alert for any key whose thumbprint isn't in its pinned
  list"), D127 Q13, D86, D190
- Decision: the manifest's `watchdog.pinnedIdentityKeys` (RFC 7638 thumbprints of the P-256 keys, which are also their
  kids; 1–8) is passed by `watchdog gen` as `IDENTITY_PINS`, with `identityToken.iss` as `IDENTITY_ISS`. Each run, after
  the run is recorded and its lock released (the advisory phase, as the email JWKS: Hana's API is a party the watchdog
  must survive), it reads `{iss}/jwks.json` and `{iss}/.well-known/openid-configuration`, no cache, `redirect:
  'manual'`, 10 s timeout, body capped at 64 KB. It runs without a chain read (it needs none). The rules are one module,
  `@hana-id/jwks/identity`, shared with the outside probe. Each object entry is judged by its key material, never by
  its kid, whatever the other entries are. Findings and severities:
  - a published key whose thumbprint isn't pinned, that isn't a P-256 key with 32-byte coordinates, or that has any
    member beyond `kty crv x y kid use alg` (D214): critical `identity_key_unpinned` (`reason` `not_pinned`,
    `not_p256`, `extra_members`, `pins_unreadable`);
  - any private member (`d`, `p`, `q`, `dp`, `dq`, `qi`, `oth`, `k`) on any entry: critical
    `identity_private_key_published` (the member names are stored, never the values);
  - the discovery document's `issuer` or `jwks_uri` wrong (D213): critical `identity_discovery_mismatch`;
  - an answer that can't be judged as published, **critical at once**: a redirect (3xx, never followed), a 200 over the
    cap, a body that isn't JSON, duplicate members (D214), or the wrong shape (not an object, no `keys` array, a
    non-object entry): `identity_jwks_unreadable:<document>:answer:<reason>`. Padding or malformed content never
    downgrades a finding to a warning, and the object entries beside a malformed one are still judged;
  - a network error or any other status, 3 runs in a row: critical `identity_jwks_unreadable:<document>:sustained`
    (one counter per document): a failure only the watchdog gets is a way to hide a key from it. A failed read resolves
    nothing it would have judged;
  - a pinned key not published under its thumbprint as kid with public members only: warning `identity_key_missing`
    (`not_published`, `kid_differs`, `not_clean`).
  **No pause, ever:** the chain isn't involved. The contract never holds or accepts an identity key; partners verify
  identity tokens, so pausing would stop every login without stopping a forged token. Absent pins mean nothing is
  pinned (as D190): every published key is unpinned; unreadable pins page `pins_invalid:identity` and read as nothing
  pinned; pins without `IDENTITY_ISS` page `pins_invalid:identity_no_iss` (L2). An env without `identityToken` skips
  the check, and a skipped check resolves nothing.
  **What it catches, and the residual (H1):** an attacker who serves the same JWKS to everyone. Whoever controls Hana's
  Cloudflare account can recognise the watchdog's fetches (they leave from Cloudflare's network, through the
  watchdog's own Worker) and serve them a clean JWKS while partners get another, or publish a key between two runs
  (5 min) and remove it again. So the watchdog is detection against a non-cloaking attacker only. The **outside
  probe** narrows the cloaking: a scheduled GitHub Actions workflow (every 15 min, hourly since D382, every 3 hours since D383, turned off on testnet since D387, standard actions pinned by commit,
  no secrets) runs `scripts/identity-probe.ts` from GitHub's network with jose's User-Agent and Accept and no
  `CF-Worker` header, applies the same rules against every non-`local*` env's `watchdog.pinnedIdentityKeys` in the
  repo, and fails on any finding (GitHub emails the failure). Values from Hana's answers reach the Actions log only
  JSON-quoted, escaped to printable ASCII (`%` included) and cut, and no line can start with `::` (no workflow
  command injection). It doesn't close it either: an attacker can single out
  partners' addresses, or time the key. **Partner-side thumbprint pinning is the recommended default for anything of
  value** (`docs/integration.md`, the example verifier's `HANA_IDENTITY_PINS`): it is the only defence that doesn't
  depend on Hana noticing.
- Why: the JWKS is served by Hana's Cloudflare account, the one party this check must not trust; pins in the
  watchdog's own config change only with a redeploy on the watchdog's account. Judging by material catches a pinned
  kid placed over an attacker's key, which is what `jose` would then select.
- Rejected: pausing on an unpinned key (no effect on partners, stops every user); trusting the kid; a warning for an
  unpinned key (the spec says critical); a warning for an unreadable answer or a sustained failure (the first draft:
  padding or a selective failure would downgrade a forged key to a warning); following redirects; reading the JWKS
  before the protective work; probe secrets or a paid monitor (the probe needs neither).

### D211. Pin before publish: the schema ties the published keys to the pins; identity-key writes both
- Date 2026-11-02 · Status: **to confirm**; built (`packages/env/src/schema.ts` `watchdogRules`,
  `scripts/lib/identity-key.ts` `withIdentityPins`) · Source: spec "Rotation playbook" step 1 ("add its thumbprint to
  the watchdog pins (operator redeploy)") and step 4 ("remove the old key from the JWKS and the pins")
- Decision: when a manifest has both `watchdog` and `identityToken`, every `identityToken.publicKeys` kid must be in
  `watchdog.pinnedIdentityKeys` (extra pins are allowed: a key pinned ahead warns `identity_key_missing` until
  published). `identity-key init` and `next` pin the new keys in the same manifest change, pins first; `retire` unpins
  the key it unpublishes, after removing it; `switch` changes no pin (the published set is the same). Deploy order:
  after `init` or `next`, the watchdog first (on its own account), then the API; after `retire`, the API first, then
  the watchdog. The wrong order is caught, not silent: a key published before its pin is deployed pages
  `identity_key_unpinned` until the watchdog deploy; a retired key unpinned before the API deploy pages the same.
  sandbox-dev pins its two published keys (active `17xAVaTf…`, standby `_MjNZC3l…`). `identity-key` rewrites only the
  `pinnedIdentityKeys` line of the manifest (review L3), and `init` and `next` validate the new manifest text before
  writing any key file (L4), so a manifest that can't take the key leaves no orphan key behind.
- Why: the operator can't forget the pin (the manifest won't validate, and `identity-key` writes it), and a retired key
  is never left pinned: a key that leaked can't be republished by whoever holds Hana's Cloudflare account without a
  page.
- Rejected: pins edited by hand (forgotten in a hurry, e.g. a compromise rotation); keeping a retired key pinned until
  someone removes it; a separate pins file outside the manifest (the email pins live in the manifest too).

### D212. "Identity key on chain" is a kid check, alert only; no contract change
- Date 2026-11-02 · Status: **to confirm**; built (`run.ts` `identityOnChain`, check `identity_on_chain`) · Source:
  spec "JWKS and discovery" ("the watchdog also alerts if an identity key's thumbprint ever appears among the
  contract's issuer keys (the contract must never trust it)"), invariant 6, threat model "Replay against Hana"
- Decision: the contract stores issuer keys as RSA `{n, e}` only (`issuers.rs` `RsaKey`) and verifies RS256 only, so an
  identity key's EC material can never be on chain; what can appear is its thumbprint as a kid. Each run, in the
  protective phase (chain data and stored config only, no third-party read), the watchdog compares the kids of
  Google's and the email issuer's active keys and of every pending key addition (any provider) with the pinned
  identity thumbprints and those Hana published at the last good JWKS read (stored in D1). A match is critical
  `identity_key_on_chain`, alert only: the same run's Google and email rules already cancel or pause on such a kid
  (Google never published it; an email kid must be its own RSA thumbprint), and an owner's pending change for another
  provider stays an `unverifiable_key_change`. No contract change is needed or made.
- Why: the contract can't trust an identity key whatever its kid, so the check exists to explain an odd issuer-key
  event, not to protect; reading the published thumbprints from D1 keeps Hana's API out of the protective phase.
- Rejected: a contract view or refusal of identity kids (no security gain: material is checked, not the kid);
  fetching the JWKS before the protective phase.

### D213. The discovery document: `issuer` exact, `jwks_uri` exact, both critical; nothing followed
- Date 2026-11-02 · Status: **to confirm**; built (`identity.ts` `judgeDiscovery`) · Source: spec "JWKS and
  discovery" (the discovery document's fields), Q14
- Decision: `issuer` must equal `identityToken.iss` exactly (no trailing-slash or case tolerance: an OpenID client
  compares it with the token's `iss` byte for byte) and `jwks_uri` must equal `{iss}/jwks.json`. Either one wrong,
  absent or not a string is critical `identity_discovery_mismatch`, one condition per field and published value. The
  watchdog never follows a `jwks_uri` it didn't configure; the other fields (`id_token_signing_alg_values_supported`,
  `claims_supported`) aren't judged.
- Why: a partner library that follows discovery would fetch keys from a substituted `jwks_uri`, past the pin check, so
  a wrong value is as dangerous as an unpinned key; a substituted `issuer` makes such clients accept another issuer's
  tokens. The other fields can't make a partner accept a forged token.
- Rejected: a warning (the user asked for critical on a wrong `iss`, and `jwks_uri` is the same risk); fetching and
  judging the advertised `jwks_uri` too (an attacker-chosen URL in the watchdog's run).

### D214. Bounded identity alerts, and the portal hand-off without the portal
- Date 2026-11-02 · Status: **to confirm**; built (`run.ts`, `checks.ts`, `status.ts`, `@hana-id/playbooks`) · Source:
  spec step 8 ("portal rendering (D83)"), D83, D126
- Decision: an unpinned or private set is one condition keyed by a hash of what was found (a new key is a new page;
  the old set resolves), listing at most 20 entries; kids and URLs from Hana's answers are cut to 256 characters and
  shown through `ident` in titles. A published entry may have only `kty crv x y kid use alg`; anything else (an
  `x5u`, `jku`, private members) makes it unpinned, and a member twice in one object anywhere in either document is
  critical (`duplicate_members`): `JSON.parse` keeps the last, other parsers the first, so two readers could see two
  keys (review L1). Three playbooks: `identity-jwks-forged` (critical: unpinned, private, discovery, unreadable),
  `identity-jwks-degraded` (warning: missing), `identity-key-on-chain`. `/status` gains `identity`
  (`{iss, jwks_url, discovery_url, pinned, jwks, discovery}`: the pins and the last good reads, each key judged, public
  members only). The checks `identity_on_chain` and `identity_jwks` and the six kinds (`identity_key_unpinned`,
  `identity_private_key_published`, `identity_discovery_mismatch`, `identity_jwks_unreadable`, `identity_key_missing`,
  `identity_key_on_chain`) are in `CHECK_IDS` /
  `ALERT_KINDS` for the portal's registry test; the portal's "Security & monitoring" view isn't built yet (batch C),
  so step 8's "portal rendering" is that hand-off, rendered when the portal is.
- Why: a JWKS of a few hundred junk keys (64 KB) must not become hundreds of pages, and a stored alert must never hold a
  private value.
- Rejected: one alert per published key (page flood); one fixed condition per kind (a second forged key while the
  first is open would raise nothing new).

## Batch C4: usage capture (2026-11-02)

Readings made while building `docs/batch-c-build-plan.md` C4 on `feat/batch-c-4`, where `docs/batch-c-spec.md` left a
detail open. Each follows the spec's intent; all five are **to confirm** by the user.

### D220. The `no_session` waiver's hot-DB sign: a session marker per app (migration 0009)
- Date 2026-11-02 · Status: to confirm; built (`apps/api/migrations/0009_session_markers.sql`, `apps/api/src/apps.ts`
  `markSession`, `handlers.ts` `firstSession`, `scripts/lib/admin-sql.ts` `noSessionWaiver`) · Source: D205's forward
  obligation; build plan C4
- Decision: a new hot-DB table `session_markers (app_id PK → apps, first_at)`. When the gate saw no
  `first_session_at` on the scope, the API writes the scope's `first_session_at` beside the relay (as since C3) and,
  once that relay settled whatever its outcome, the app's marker (`INSERT … ON CONFLICT DO NOTHING`): two independent
  writes, so one lost write never leaves the waiver open, as the `usage` row did for a lost `first_session_at`. The
  waiver reads the marker in place of the legacy `usage` rows; nothing it decides reads Neon. The migration is
  numbered **0009** (the next free number): 0007 stays C4b's drop and 0008 the identity token's, so no merged doc
  renumbers; it reads no other table, so it applies the same before or after 0007. The existing `usage` rows are
  carried into markers by a one-off idempotent statement before 0007 (`docs/operations.md` "Usage capture" step 5).
  The same rule in C5's `AdminRpc.ackNotice` (`apps/api/src/changes/lifecycle.ts` `noSessionWaiver`, merged before C4)
  now reads `session_markers` too, with a test row of its own; nothing reads `usage`.
- Review fixes (2026-11-02): `HOT_DB_SCHEMA` is 9 and `app:changes:announce --remote` needs `hotDb` ≥ 9 (proposals
  still ≥ 6), so no announcement runs against an API that writes no markers; the one-off `usage` → markers statement
  runs after the C4 deploy (and again before 0007), since the API before it still wrote `usage` rows only.
- Why: the build plan asked for a hot-DB marker beside the relay; per app (not per scope) so its test rows match the
  old ones and a scope's apps each leave their own sign.
- Rejected: dropping the `usage` check and relying on `first_session_at` alone (one write, one point of failure);
  taking 0007 and renumbering C4b's drop to 0009 (a backfill inside the drop would be cleaner, but every merged doc
  and decision names 0007 as the drop).

### D221. What one usage event covers, and when it is opened and closed
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/usage/event.ts`, `handlers.ts`, `login.ts`,
  `vault/endpoints.ts`) · Source: spec "Usage capture"
- Decision: the event opens once the request passed the gate (for `/v1/vault/unlock`: the vault gate, app, origins and
  the vault's IP and app limits; for owner actions: the owner check) and closes in `done` with the response, so every
  answer after the gate is exactly one event and the per-IP 429 of the gate is none. A handler that throws past its
  gate records `500 internal`, as the router answers. The export window's `/v1/login` is a `login` event (with a uid).
  `ckd_failed` is a rejected, relayed event (no longer "counts as a session"). An owner action's `org_id` is read from
  `scopes` after the response, `org_legacy` for a scope the hot DB doesn't hold or when D1 can't be read
  (`usage_org_unavailable`). A code that isn't the event shape's `^[a-z][a-z0-9_]{0,63}$` is recorded as `internal`.
- Why: the gate is where the spec draws the line ("requests that passed appGate"); one place to close the event
  (`done`) means no response path can forget it; a relayed owner action must reach the ledger for the nonce check
  even when its scope has no app.

### D222. The writer: checked in the Worker, one retry for transient errors only, relayed by the relay result
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/usage/record.ts`, `relayer-key.ts`, `near/tx.ts`) ·
  Source: spec "Write", "Gas", tests "Topology and config"
- Decision: the event is checked against UsageEvent v1 (`console-core`, zod) before it is sent; a refusal is
  `usage_write_rejected` and never sent. One new `pg` connection per event over `USAGE_DB` (Hyperdrive pools), 5 s to
  connect and 5 s for the statement. Retried once after 250 ms: an error without a SQLSTATE (connection, timeout) or of
  class 08, 40, 53, 57, 58; `22023` (the function's shape refusal) is `usage_write_rejected`; any other SQLSTATE (e.g.
  `23514`, no partition) is `usage_write_failed` without a retry. Logs carry the SQLSTATE (`pg_<code>`) or
  `connection`, never the driver's message or the URL. `relayed` follows the relay *result*, not the response code:
  ok, or `contract_rejected` / `timeout` / `near_error` with a `nearTx`; `near_rejected` and `relayer_busy` are not
  relayed even though they name a transaction (it can never execute), and their `near_tx`, key and nonce are still
  recorded. The `RelayerKey` result carries the signing key and nonce on every result naming a transaction (the last
  sent, after a retry) and the BigInt gas sums of a settled outcome; a malformed amount gives no gas fields, never a
  guess. Without `USER_ID_KEY` (or with a malformed one) events are recorded without a uid (`usage_uid_unavailable`,
  once per isolate); a path that doesn't parse for its scope gives no uid either.
- Review fixes (2026-11-02): a SQLSTATE is read only from a `pg.DatabaseError` (the server's answer); any other error,
  an errno code such as `ECONNRESET` included, is a connection error and retried. The provisional gas pair is dropped
  when either figure is past the event's bounds (gas ≤ 2^63 − 1, tokens < 10^39), so the rest of the event is kept.
  `recordUsage` first yields (`scheduler.wait(0)`), so the uid's HMAC, the check and the connection all run after the
  response. Settlement (C12) must bill a relayed event only for its own transaction (`near_tx` unique, the
  transaction's signer key and nonce equal to `relayer_pk` and `relayer_nonce`): an obligation in the build plan's C12.
- Why: the spec's "connection error or timeout" retry and "never on a validation error", with a test for each class;
  a shape refusal is a bug that a retry can't fix; the nonce cross-check needs every relayed row's key and nonce.

### D223. Identity token counts reach the ledger by an hourly copy, not per mint
- Date 2026-11-02 · Status: to confirm; built (`apps/api/migrations-usage/0002_identity_tokens.sql`,
  `apps/api/src/usage/identity-sync.ts`, the API's hourly cron) · Source: build plan "Conventions" (the ledger counts
  `identity_tokens` per app and day); D172
- Decision: the mint keeps counting in the hot DB (`identity_usage`, unchanged, and the identity signing code is not
  touched); the hourly cron copies the last 7 UTC days, with each app's org and scope, to `usage.identity_tokens
  (app_id, day, org_id, scope_id, tokens)` through `usage.record_identity_tokens(rows jsonb)` (writer only, all or
  nothing, ≤ 1000 rows a call, the larger count kept, org and scope of the first copy kept). A failed copy is logged
  (`identity_usage_sync_failed`) and repaired by the next hour; it never fails the cron run. The Neon file is
  `0002`, so the report and retention functions planned as 0002/0003 (C12, C13) take the next numbers (0004, 0005:
  0003 is the partitions fix below).
- Review fix (2026-11-02, M1): partitions no longer wait for the admin Worker. Neon `0003_writer_partitions.sql` lets
  `usage_writer` execute `usage.ensure_partitions` (the owner's bounded SECURITY DEFINER function: 0..24 months, only
  creates missing months) and creates 12 months ahead; the API's hourly cron calls `ensure_partitions(12)` before the
  identity copy, logging `usage_partitions_failed` and never failing the run.
- Why: per app and day is what reports need; a copy of a monotone count is idempotent and survives a Neon outage of
  up to 6 days with nothing lost, with no change to the mint path (which identity token steps 7/8 are changing).
- Rejected: an `identity_token` event per mint in `usage.events` (a new endpoint value in a CHECK of a partitioned
  table, a Neon write per mint, and a change in the identity signing files).

### D224. `usage-setup` and the binding: subcommands, SCRAM verifiers (amended by D403), re-runnable; capture optional on sandbox-dev
- Date 2026-11-02 · Status: to confirm; built (`scripts/lib/usage-setup.ts`, `apps/api/scripts/gen-wrangler.ts`) ·
  Source: build plan "Setup steps" 3, 4 and 6
- Decision: `usage-setup <env> roles | hyperdrive | user-id-key [--yes]` (testnet only, dry run by default).
  `roles` writes each role's URL first (the owner's direct endpoint and database, `sslmode=require` only: Neon's
  `channel_binding` is dropped for Hyperdrive) and then sets `LOGIN PASSWORD` to a SCRAM-SHA-256 verifier computed
  locally (checked against RFC 7677's example), in one transaction, so Neon never sees the password; a re-run reuses
  the files' passwords. `hyperdrive` creates both configs with caching disabled and prints only names and ids (the
  role URL is a wrangler argument, briefly visible in the local process list). `user-id-key` never replaces the key
  file and sets the Worker secret through stdin. `gen --usage-hyperdrive-id <id>` binds `USAGE_DB`; later runs keep it
  for the same Worker and D1 database, `off` drops it. The binding needs no manifest `usage` block (sandbox-dev has
  none yet; the Hyperdrive names default to the spec's). The gitleaks config gains a rule for Postgres URLs with a
  password and the new secret files by name.
- Review fixes (2026-11-02): `gen` writes the binding's `localConnectionString` as an unroutable placeholder
  (`usage-ledger.local.invalid`), so `wrangler dev` runs and local capture fails open, logged. The Hyperdrive id is
  read only from wrangler's "Created new Hyperdrive … config: <id>" line (no line, no guessed id). The gitleaks rule
  matches passwords of 8 characters or more with an entropy floor of 3.0 (3.5 made anything under 12 unmatchable),
  stopwords for the repo's marked fakes. Creating the configs through the REST API (the password in an HTTPS body, not
  a process argument) is a before-production item (`docs/mainnet-readiness.md` 4.18). The step-8 SCRAM login check on
  sandbox-dev is an explicit gate in `docs/operations.md`.
- Why: the spec's steps, made safe to repeat after a stop, and M2 without waiting for the dashboard blocks.
- Amended 2026-11-05 by D403: Neon refuses a password that isn't plain text (`ALTER ROLE … PASSWORD '<SCRAM
  verifier>'` got "Neon only supports being given plaintext passwords" on sandbox-dev), so `roles` gives `LOGIN` by SQL
  and has Neon's API reset each password, written straight to the role file; every run resets both and replaces the
  files (no reuse), and checks each role logs in. The SCRAM verifier code and the step-8 SCRAM question are gone.
- Amended 2026-11-05 by D412: `hyperdrive` creates the configs through Cloudflare's REST API (the password in the
  HTTPS body, a Hyperdrive-only token from `.secrets/<env>/cloudflare-hyperdrive-token`), not
  `wrangler hyperdrive create --connection-string`; mainnet-readiness 4.18 is closed.

## Identity token build, step 7 (the AWS KMS signer, code only), 2026-11-02

Made while building `docs/identity-token-spec.md` build step 7's code (branch `feat/identity-token-7`): the KMS adapter,
the manifest's signer selection, the scripts and the runbook. The AWS account, keys, IAM, CloudTrail reconciliation
and alarms are the operator's setup before mainnet (`docs/operations.md` "Identity token keys on AWS KMS"); no env
uses the KMS signer yet. None changes a derivation path or an address.

### D215. The KMS signer in the manifest: keys by role with their ARNs, credentials as Worker secrets of one IAM user
- Date 2026-11-02 · Status: **to confirm** · Source: build of the spec's "D1 schema, manifest and secrets" and "Where
  the key lives" (`packages/env/src/identity.ts`, `apps/api/scripts/gen-wrangler.ts`, `apps/api/src/identity/signers.ts`)
- Decision: `identityToken.signer` is `{kind: "aws-kms", credentials: {kind: "worker-secret", iamUser}, keys: {active:
  {kid, arn}, standby?: {kid, arn}, next?: …, previous?: …}}`. Each key carries its own single-region ARN (no
  `mrk-` key, no alias) and its region is the ARN's; there is no `awsRegion` field. The schema also requires: one key
  per role (distinct kids and ARNs), every published key in a role and every role's key published, every key in one
  AWS account, and the standby in another region than the active key (D219). `standby` is optional only for the
  window between a switch to it and the new standby's `kms-add`. `gen` writes `IDENTITY_SIGNER` (`worker-secret` or
  `aws-kms`), `IDENTITY_ACTIVE_KID` and, for KMS, `IDENTITY_KMS_KEY_ARN` = the active key's ARN only. The credentials
  are the IAM user's long-term access key as two Worker secrets (`IDENTITY_AWS_ACCESS_KEY_ID`,
  `IDENTITY_AWS_SECRET_ACCESS_KEY`), set together by `identity-key kms-put-aws-key` (one `wrangler secret bulk` from
  `aws iam create-access-key`'s JSON, checked for the manifest's user, `Active`, `AKIA…`). A Worker without
  `IDENTITY_SIGNER` (configured before step 7) keeps the Worker-secret signer unless it has `IDENTITY_KMS_KEY_ARN` (a
  half-applied config: refused, `signer_kind_missing`); an unknown kind, a missing ARN or missing
  credentials refuse every mint (`503 identity_signer_unavailable`), and a KMS Worker never falls back to a
  Worker-secret key. The kind is `aws-kms`, as the spec and the email issuer name it, not `kms`.
- Why: the spec's standby lives in a second region, which one `awsRegion` can't express; ARNs pin the exact key (an
  alias can be repointed outside the manifest, a multi-region replica isn't an independent key). Only the active ARN on
  the Worker keeps a switch a reviewed manifest change. `credentials` names how the Worker authenticates so a later
  mechanism (a role through a broker) is a new kind, not a silent change. Workers can't assume an IAM role without
  another long-lived secret (the spec).
- Amends the spec's manifest sketch (`keys: {active, standby, next?, previous?}` as kids, `awsRegion`).
- Rejected: one region for all keys; ARNs of every role on the Worker; temporary (`ASIA…`) credentials (they need a
  session token and a refresher the Worker doesn't have).

### D216. KMS `Sign` with `MessageType = DIGEST`: the Worker hashes, AWS sees 32 bytes
- Date 2026-11-02 · Status: **to confirm** · Source: build of the spec's "Signing" bullet (`apps/api/src/identity/kms.ts`)
- Decision: the adapter computes `sha256(header ‖ "." ‖ payload)` itself and calls `Sign` with `MessageType: DIGEST`,
  `SigningAlgorithm: ECDSA_SHA_256`; the IAM and key policies require both values (`kms:MessageType`,
  `kms:SigningAlgorithm`).
- Why: the token's claims (`sub`, `sid`, wallet addresses, later the email) never leave Cloudflare, whereas `RAW` sends
  the whole signing input to AWS; the request has a fixed size whatever the token's (`RAW` caps the message at 4096
  bytes); the self-check verifies the same bytes the Worker hashed. It matches the email issuer's adapter (RSA,
  `DIGEST`). `DIGEST` gives a credential holder no more than `RAW` would: either way it can sign any token it likes.
- Rejected: `RAW` (claims at AWS, a size limit, no gain in what a leaked credential can do).

### D217. Strict DER to JOSE conversion, high-S kept, every signature verified before it is answered
- Date 2026-11-02 · Status: **to confirm** · Source: build of the spec's "Signing" bullet and "Tests" ("DER → JOSE
  conversion, high-S and short-`r` cases, refusal when the self-verify fails") (`derToJose` in
  `apps/api/src/identity/kms.ts`)
- Decision: KMS's `ECDSA-Sig-Value` is accepted only as strict DER: one SEQUENCE with a short-form length equal to the
  rest of the input (≤ 72 bytes), two INTEGERs of 1–33 content bytes each, minimal (a leading `0x00` only before a byte
  with its high bit set), non-negative, in `[1, n − 1]` for P-256, nothing after `s`. Each value is left-padded to 32
  bytes (`r ‖ s`, 64 bytes, RFC 7518 §3.4). High-S signatures are kept (JOSE doesn't require low-S, WebCrypto
  verifies both). The answer must name the configured key ARN and `ECDSA_SHA_256`, its base64 must be canonical, and
  the 64-byte result is verified with the manifest's public key for the active kid before the token is returned.
  Tested against frozen node:crypto vectors (32-byte, high-bit, high-S, short `r`, short `s`), 27 malformed encodings,
  thousands of signatures from an independent encoder, and a fake KMS that signs with a real P-256 key.
- Why: a lenient parser accepts several encodings of one signature and hides wiring faults; the self-check catches what
  parsing can't (a wrong ARN, a key whose public half isn't the published one).
- Rejected: normalizing to low-S (pointless for JOSE); trusting KMS's answer without the self-check.

### D218. KMS call limits: one `Sign` per mint, no retry, a 3 s deadline, a 4 KiB answer cap, fail closed
- Date 2026-11-02 · Status: **to confirm** · Source: build of the spec's latency budget and "Mint flood" row
  (`apps/api/src/identity/kms.ts`)
- Decision: each mint sends at most one `Sign` request; aws4fetch's retries are off and the adapter never calls twice.
  One 3 s deadline covers the request and its body (a stalled body is a timeout), the answer is read up to 4 KiB, and
  every failure (refusal, throttling, timeout, network error, garbage, a failed self-check) is `503
  identity_signer_unavailable` with a fixed reason code in the log (`kms_timeout`, `kms_throttled`, `kms_bad_answer`,
  …). The vault's next refresh is a new mint (a new `jti`), so a retry happens a level up and is counted there. Known
  gap, for the reconciliation's build: a `Sign` that KMS completed but whose answer never arrived (timeout) or was
  refused by the self-check is in CloudTrail without a counted token; today only the log explains it, and the
  reconciliation job adds a per-hour, per-kid count of sent `Sign` requests so that "CloudTrail ≤ requests sent" is
  exact.
- Why: a retry inside a mint can double the signatures for one token in a way the reconciliation can't tell from
  misuse, and KMS throttling is better answered by less load than by more; 3 s is far above KMS's normal latency (the
  budget is ≤ 100 ms p95) and well under the vault's wait.
- Rejected: a retry on 5xx or throttling; a migration for the attempts count now (no consumer before the reconciliation
  job, and migration numbers are reserved by other branches).

### D219. KMS standby and rotation: another region, the IAM policy names the active key only
- Date 2026-11-02 · Status: **to confirm** · Source: build of the spec's rotation playbook and D177 for KMS
  (`docs/operations.md` "Identity token keys on AWS KMS", `scripts/lib/identity-kms.ts`, playbook
  `identity-kms-signer-compromised`)
- Decision: the standby is a separate single-region key in another region than the active key (the schema refuses the
  same region; `kms-add --role next` refuses the standby's region, so a scheduled switch keeps them apart). The key
  policy is the same on every identity key: it delegates `kms:Sign` to the signer user's IAM policy only and denies
  `Sign` to every other principal, `CreateGrant` to all, and key changes to all but the break-glass role (MFA). The
  signer user's IAM policy allows `kms:Sign` on the **active** key's ARN alone (both ARNs only during a switch) and
  denies `Sign` on any other key (`NoOtherKey`), so a leaked credential can't sign with the standby and the standby
  stays a clean recovery, as D177 keeps the testnet standby off the Worker. **Long-term credentials only** (step 7
  review, H1): `sts:GetSessionToken` needs no permission and can't be denied, and its sessions keep the user's live
  permissions (so they would gain the standby at a switch), and deactivating the access key isn't proven to end them.
  The key policy's allow and the IAM allow therefore require `Null aws:TokenIssueTime = true`, and the key policy
  denies `Sign` to any request with `aws:TokenIssueTime` (`NoSessionCredentials`); the Worker uses an `AKIA…` key.
  CloudTrail is matched by `userIdentity.arn`, never by access key id, and `GetSessionToken` by the signer user is an
  alarm. To confirm on staging in the compromise drill: a session of the signer user is refused `Sign`. The
  break-glass role is assumed with MFA (`sts:AssumeRole`), not through IAM Identity Center, and is never deleted or
  renamed (the key policies name it). A switch is: IAM policy (add the target), `kms-switch`, gen, deploy; `kms-retire` after ≥ 2 h
  (at once in an incident), then the old key is disabled and scheduled for deletion (30 days); before a switch, a
  pre-switch check signs one digest with the target key and verifies it against its published `get-public-key` file.
  `next` and `standby` are in different regions too (`next` becomes the active key). Commands: `kms-init`,
  `kms-add --role next|standby`, `kms-switch --to next|standby`, `kms-retire --key previous|standby`,
  `kms-put-aws-key`; they never call AWS.
- Why: a regional KMS outage or a region-scoped mistake leaves a key to switch to; a credential that could sign with
  both keys would make "switch to the standby" keep forged tokens valid after the switch.
- Amends the spec's "IAM user … `kms:Sign` on the identity key ARNs" (now: the active key's ARN).
- Rejected: one policy listing every identity key; key-policy edits for every switch (two places to keep in step);
  multi-region replica keys as the standby (same key material).

## Email login build, batch 6 (API and sandbox-dev chain setup), 2026-11-02

Made while building `docs/email-login-build-plan.md` batch 6 (branch `feat/email-login-6`), where the spec's "API
changes" and the plan's deploy order were silent, ambiguous or unworkable as written. Each takes the safer reading. All
five are **to confirm** by the user. None changes an address: no path, derivation or `sub` is touched.

### D230. `{…}/v1/email/*` reaches the issuer without the API: its own `workers.dev` URL on sandbox-dev, a zone route in production
- Date 2026-11-02 · Status: to confirm; built (`packages/env/src/email-issuer.ts` `url`, `workersDevIssuerUrl`,
  `emailIssuerUrl`, `emailJwksUrl`; `scripts/lib/email-issuer.ts` init; the watchdog's default `jwksUrl`) · Source:
  D199 "Open for batch 6"; D123 Q5 ("the issuer under `{apiUrl}/v1/email`")
- Decision: the manifest's `emailIssuer.url` names the origin the issuer Worker is reached at; it serves
  `{url}/v1/email/*` and its `iss` is `{url}/v1/email`. Absent, it is the API's URL and a Cloudflare route on the API's
  zone sends `/v1/email/*` to the issuer Worker (production: the more specific route wins over the API's, and the API
  Worker never runs for those requests). On a `workers.dev` API (sandbox-dev) there is no zone to route on, so `url` is
  required and must be the issuer's own `https://<issuer Worker>.<the API's subdomain>.workers.dev` (the schema checks
  it; `email-issuer init` writes it). sandbox-dev's `iss` is therefore
  `https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev/v1/email`, set on chain by `set_issuer` in batch 6's deploy.
  The API serves nothing under `/v1/email/` (404, as today). Consequences: batch 8's `/login/email` CSP gets
  `connect-src` the issuer origin (the spec already says "connect-src {issuer origin}"), the vault's `google-match` call
  goes there, the watchdog's default `jwksUrl` follows `emailIssuer.url`, and the issuer's Access application and
  SendGrid webhook are configured on that URL.
- Why: an address and a code are personal data and a login credential; D199 asks that they never pass through the API
  Worker's memory. With a route or a separate origin they reach only the Worker that needs them. `iss` is in no path,
  so moving it later costs a `set_issuer` (it keeps up to 4 values), never an address.
- Rejected: a service binding from the API with a no-logging pass-through (the bodies still cross the API isolate, and
  any later change to the API's logging or error paths could capture them; the API would also hold the issuer's
  availability); a redirect from the API (the browser still sends the body to the API first); the issuer on a custom
  domain for sandbox-dev (none is set up; the workers.dev URL gives the same property for free).
- Amended 2026-11-04 by D269: the address still reaches only the issuer Worker, which now also keeps the verified
  address in its own D1 (`user_emails`), read by Hana staff only (`admin user:list` / `user:find`).

### D231. Email tokens at the API: the manifest's keys, the issuer's exact form, the chain's policy, the app's methods
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/email-token.ts`, `login-token.ts`, `login-methods.ts`,
  `link-views.ts`, `handlers.ts` `handleAppConfig`, migration 0010) · Source: spec "API changes" ("the JWKS from the
  issuer's endpoint, cached like Google's"; "checked against `get_self_issued("email")` like the contract")
- Decision:
  - **Keys from the manifest, not fetched**: the API checks email signatures against `emailIssuer.publicKeys`
    (`EMAIL_PUBLIC_KEYS`, generated), which is exactly what the issuer's JWKS serves (D196), so it needs no fetch, has
    no SSRF or availability edge, and can't be steered by a compromised issuer Worker. A key rotation is a manifest
    change (already part of the 72 h procedure) and an API `gen` + deploy.
  - **The issuer's exact form**: a token must be byte for byte `JSON.stringify({payload, signatures: [{protected,
    signature}]})` as the issuer writes it (refuses whitespace, unknown and duplicate members, the flattened form,
    unprotected headers), protected headers `{alg: RS256, kid}` without `crit`, ≤ 3 signatures with distinct kids,
    each RS256-valid, claims exactly `iss aud sub iat exp nonce jti` (no address claim can reach the chain through the
    API). Stricter than the contract, which tolerates whitespace and extra claims: a precheck may only refuse.
  - **The chain's policy**: `get_self_issued("email")` (cached 60 s, re-read for an unlisted kid at most every 10 s):
    every kid must be listed under one of its signers and the distinct signers reach `required`. A kid the policy
    doesn't list yet is `503 issuer_key_pending` (retry 30 s), as for Google; no policy (`null`) is
    `400 unsupported_issuer`; the view missing (a v2 contract) is `502 near_unavailable`. During a policy upgrade's
    10-minute overlap a token that only the previous policy accepts is refused here (the view gives only the overlap's
    end, D191): the popup gets a fresh token, which the new policy accepts.
  - **The app's methods**: an email token (session or link) is refused `403 login_method_disabled` unless the app's
    `apps.login_methods` (migration 0010: `'google'`, `'email'`, `'google,email'`, default `'google'`) lists `email`,
    on every endpoint that takes one; Google tokens are never gated by it. The column is read beside the gate, never
    in it, and a database before 0010 reads as Google-only (deploying the API before the migration changes nothing).
  - **`GET /v1/app`**: `loginMethods` is D1 ∩ the scope's on-chain clients (Google as today; email only with the
    scope's `("email", "email:<scope>")` client), with `email: {aud}`. A Google-only app answers as before plus
    `loginMethods: ["google"]`, keeping its `409 no_google_client`; only an app with email on gets
    `409 no_login_method` (nothing available) or `google: null` (email only).
- Rejected: fetching the issuer's JWKS from the API (above); accepting any JSON serialization the contract accepts;
  gating Google tokens on `login_methods` (it would refuse every existing login on a database before 0010).

### D232. The link precheck, the link relays, and the email-login panics as errors
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/link-precheck.ts`, `links.ts`, `login.ts`, `panics.ts`,
  `gas.ts`, `relayer-config.ts`, `origins.ts`) · Source: spec "API changes", "Link methods"; D133, D135, D155, D200
- Decision:
  - **`/v1/login` with `linkJwt`** (D133): before relaying, the API verifies the link token (an email token of the
    app's scope), requires the session signature over the linked CKD payload, reads `get_config` (links open only when
    `unrecorded_wallets` is explicitly `false`: a pre-v3 contract has no field, so links stay closed there),
    `get_identity` and `get_account` of both identities fresh, and recomputes the `auto_link` nonce with the join the
    contract would make (case A: the session identity joins the link identity's account; else the link identity
    joins), refusing in the contract's order: `409 links_unavailable`, `409 link_pending`, `422 link_refused` with
    `reason` (`same_identity`, `already_linked`, `both_wallets`, `link_mismatch`, `unlinked`, `account_full`,
    `provider_taken`). The export window never carries a link (`400`). Gas: 250 Tgas for a linked login
    (`LINKED_LOGIN_TGAS`, override `GAS_CREATE_SESSION_AND_DERIVE_LINKED_TGAS`), D155's other values in the table.
  - **Panics** after a relay (`/v1/sessions`, `/v1/login`, `/v1/derive`, the link relays), signer receipt only:
    `Links wait until the owner accepts…` → `409 links_unavailable`; `Sign-in method is linked to an account` →
    `409 identity_linked` (the vault signs in again, D136); `Sign-in method link is pending` → `409 link_pending`; the
    link refusals → `422 contract_rejected` with a `reason` slug. The panic text stays in `error`, never in a log.
  - **The link relays** (`/v1/link`, `/v1/link/cancel`, `/v1/link/unlink`): callers the vault and the auth origin's
    pages only, never a partner page (not even a test app in a dev env); session pool; each token verified and in the
    scope; the contract's nonce and state rules prechecked from fresh reads (`link_new` / `link_account` /
    `link_change`, the epoch, has-wallet, already-linked, room, who may cancel or unlink). Cancel and unlink are not
    gated on `links_open` (the contract doesn't gate them: a user can always remove a link). Limits, provisional: per
    IP and app 5 adds and 10 removals a minute; per app 30 adds a minute and 1 000 a day, 60 removals a minute and
    2 000 a day; adds and removals in separate windows, so a flood of adds never blocks a cancel. Every success,
    `/v1/link` included, revokes the account's vault shares in the scope (D233): the spec says "each", and a new
    sign-in method then signs the account's devices out, so they see the link banner at the next login.
- Rejected: links open on a missing `unrecorded_wallets` field; one shared window for adds and removals; partner
  pages on the link relays.

### D233. Share revocation by the root path's key indexes; email usage in its own table; the issuer finds apps by the gate's model
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/links.ts` `revokeAccountShares`, `email-usage.ts`,
  migration 0010; `apps/email-issuer/src/apps.ts`) · Source: spec "Unlink and cancel" ("revokes every vault share of
  the account's path in that scope (`vault_shares.path_hash`)"), "API changes" ("Usage counts email logins and links
  per app"); D206, D225
- Decision:
  - **Shares**: `vault_shares.path_hash` is the hash of a full path, which names its `key_index`, so the API revokes
    every live share whose hash is that of the account root's path at `key_index` 0..63, in every app of the scope (one
    statement). The SDK uses `key_index` 0; a share at a higher index ends at its own absolute limit (≤ 12 h by
    default), as a share does after a direct contract call that skips the API. A failed revocation is logged
    (`link_shares_revoke_failed`), never fails the answer (the change is already on chain).
  - **Usage**, on batch C4's model for counts (D223, amended at the merge of C4 into this branch): every
    `/v1/login` and `/v1/sessions` request is already one usage event of its endpoint in the Neon ledger (an email
    login included); what the spec adds, how many were email logins and how many made a link, is counted in the hot DB
    (`email_usage (app_id, day, email_sessions, links)`, migration 0010, as `identity_usage`, D172) and copied by the
    hourly cron to the ledger's `usage.email_counts` through `usage.record_email_counts` (migrations-usage 0004, the
    writer's fourth function; the larger count per column kept, the last 7 days each run; `src/usage/email-sync.ts`).
    An email session is counted at a successful `/v1/login` or `/v1/sessions` with an email token; a link at a
    successful linked login or `/v1/link` (as the contract's counter counts links, D200; cancels and unlinks aren't
    links). Chosen over new ledger event fields or endpoint values: those change the CHECK of the partitioned events
    table and every event's shape, the reason D223 gave for the identity counts. Not covered yet: the link relays
    (`/v1/link*`) are not usage events (their relayed gas isn't in the ledger); adding them needs ledger endpoint values,
    left for the reporting batch (C12).
  - **The issuer's app lookup** (D206's obligation, D225's "still owed"): the key is an `app_keys` row not revoked or
    still in its rotation grace (`revoked_at` NULL or in the future), the app not deleted (`deleted_at IS NULL`), and
    active only with `suspended_by = 0` and `status = 'active'`, exactly the API gate's rule. `apps.publishable_key`
    is no longer read anywhere; the source check (`apps/api/scripts/test/hot-db-reads.test.ts`) has no allowlist left.
    A key in its grace now works for email logins too (D225's noted cost is gone).
- Rejected: a new `vault_shares` column naming the account root (a hot-DB schema change, batch C's); counting email
  logins in the legacy `usage` table (C4b drops it).

### D234. Batch 6's deploy order, corrected: issuer keys and pins, D1, pages then API, pool keys, v3, accept, issuer Worker, its keys; the email clients in batch 8
- Date 2026-11-02 · Status: to confirm; written as the user's steps (`docs/operations.md` "Email login on sandbox-dev
  (build plan batch 6)") · Source: build plan batch 6 "Deploy (sandbox-dev), in order"; D199 (client proofs)
- Decision (the full order, as `docs/operations.md` "Email login on sandbox-dev" runs it, amended after the batch 6
  reviews: 1 the issuer's keys and manifest block, 2 the watchdog pins, 3 the API's D1 (0006 if missing, 0009, 0010;
  C4's usage capture optional), 4 the pages then the API with the proof, 5 the session-pool keys switched without
  downtime, 6 contract v3, 7 `accept_unrecorded_wallets`, 8 the issuer Worker, 9 the email issuer and its two keys on
  chain; the email clients in batch 8):
  - The plan's `upgrade-contract propose|execute` doesn't exist: the upgrade is `deploy-contract sandbox-dev --upgrade`
    (with `--approve-with` the DAO's `propose_upgrade` passes in one command on sandbox-dev), then, once due, the same
    with `--skip-build` (`execute_upgrade`).
  - The API's D1 migration moves **before** the issuer's deploy: the issuer finds apps through `app_keys` (0006, which
    sandbox-dev hasn't applied yet, D233) and `login_methods` (0010). Both migrations only add, and the API deployed
    there today works on them (0006's batch B reads are tested; 0010 adds a defaulted column and a table). The
    issuer's Worker is deployed before its keys go on chain, so the watchdog's JWKS check finds it from the first
    active email key (the plan's order would leave a window of `email_jwks_unavailable` warnings).
  - `AddClient ("email", "email:<scope>")` for the test scopes moves to **batch 8**: its client proof is an email token
    the issuer mints only for a scope with an active app whose `login_methods` lists `email` (D199, tokens review L6),
    and no app enables email before batch 8. So batch 6 leaves the scopes without an email client: `GET /v1/app`
    lists email nowhere, and nothing reaches users. Batch 8's order: `login_methods` for the test apps, the client
    proof, `AddClient` through the scope's owners (timelocked by `change_delay_ms`), then the web.
  - The session-pool keys move to the new allowlist without downtime (amended after the deploy review, M1): new keys
    are generated and added beside the old ones (the old file moved aside), `RELAYER_KEYS` is switched, then the old
    keys are deleted; until the v3 upgrade the link methods exist nowhere and nothing calls them. `deploy-contract
    --upgrade` refuses while the env's API doesn't report `capabilities.createProof` (M2).
  - D137's proof of possession ships with the API and the pages before the upgrade: the sandbox test
    `v2_ignores_the_create_session_proof_that_v3_requires` (`contracts/integration-tests/tests/governance.rs`) runs the
    v2 wasm sandbox-dev runs (`V2_COMMIT`) with the proof, without it and with a wrong one (all three open the session:
    v2 ignores the field), then upgrades the same deployment to v3, where only the right proof opens one.
- Rejected: the plan's order with the issuer before the migration (every app lookup would fail until the migration);
  minting the client proofs by turning email on for the test apps in batch 6 (against "nothing ships half-wired").

### D250. Batch 6 review follow-ups: requests bound to fail, per-account link limits, gas per signature, stale email keys
- Date 2026-11-02 · Status: to confirm; built (`apps/api/src/session-standing.ts`, `panic-cache.ts`, `links.ts`,
  `gas.ts`, `email-token.ts`, `login-token.ts`, `validate.ts`; migrations-usage `0005_link_events.sql`) · Source: the
  login/links review of batch 6 (M1, M2, L1–L3, L5, L6) and the deploy review (H1)
- Decision:
  - **Pending members before relaying** (M1): `/v1/sessions` and `/v1/login` read the session identity's
    `get_identity` beside the other chain reads, only once links can exist (`get_config().links_open`, cached; no read on
    v2 or before `accept_unrecorded_wallets`), and refuse a pending member with `409 link_pending`. Fails open (the
    contract decides) when the view can't be read.
  - **Deterministic panics remembered** (M1): after `link_pending` or `identity_linked` from the chain, the exact
    request (sha256 of the method and its arguments) is answered from the isolate for 60 s.
  - **One relay per link request** (M1): `/v1/link*` reserve sha256 of their tokens in a `RateLimiter` object
    (`link-tokens`) before relaying, across isolates; a duplicate is `409 link_in_flight`. The claim is released when the
    relay certainly didn't execute, else kept for the tokens' 10 minutes.
  - **Per-account limits** (M2): per account root (`link-root:<scope>:<root ik>`), adds 3 a minute and 20 a day,
    removals 10 a minute and 100 a day, refused above; the app-wide add caps stay refusals, the app-wide removal windows
    only log `link_changes_high` (a cancel never waits on other users' traffic).
  - **Gas per signature** (L1): every token signature beyond a method's default adds 70 Tgas (≈ 67 per 4096-bit
    verification, D155), capped at 300, as `register_scope` scales by proofs; an env override stays the whole budget.
    A 2-of-2 email token, or one signed twice during a rotation, then still has the gas it needs.
  - **Stale email keys** (L2): a kid no current signer lists is `503 issuer_key_pending` only while a pending change
    adds it (`get_key_changes`, cached 10 s); otherwise (removed, a dropped signer's, a token only an overlap's previous
    policy accepts) `401 token_stale`: waiting won't help, a fresh token may.
  - **`/v1/sessions` takes exactly its fields** (L3): anything else, `linkJwt` included, is `400 bad_request`.
  - **Exports and the uid on the derived path** (L5): a member's login is limited (3 exports an hour) and counted (the
    usage uid) on its account root's path, read with the standing above.
  - **Removals take email tokens whatever `login_methods` say** (L6): `/v1/link/cancel` and `/unlink` must keep working
    after a partner turns email off; `/v1/link` still needs email on.
  - **Link relays are usage events** (H1): endpoints `link`, `link_cancel`, `link_unlink` (`@hana-id/console-core`
    `USAGE_ENDPOINTS`; migrations-usage 0005 widens the events table's CHECK and `record_event`), so their relayed gas
    reaches the ledger like a login's. No uid on them.
- Rejected: a cross-isolate negative cache (a hot-path Durable Object call for a rare case); refusing removals on the
  app-wide caps.

### D251. The issuer's APP_DB is a read-write D1 binding: kept for now, held to reads by a source test
- Date 2026-11-02 · Status: to confirm; **superseded by D432** (2026-11-06, branch `feat/issuer-readonly-rpc`: the read-only RPC built, `APP_DB` and its source test removed) · Source: the deploy review of batch 6 (M4)
- Decision: Cloudflare has no read-only D1 binding, so the issuer's `APP_DB` (the API's D1) could write the API's tables
  if its code did. For now its code is held to reads by a source test (`apps/email-issuer/scripts/test/app-db-read-only.test.ts`:
  every use goes through `src/apps.ts`, whose statements are SELECTs), the risk is in `docs/security.md`, and
  `docs/mainnet-readiness.md` has a row. Before mainnet the binding is replaced by a read-only RPC on the API (a
  service-binding entrypoint: an app lookup in, the row out), so a compromised issuer Worker can't change an app's
  origins, keys or settings.
- Why: the RPC is a new API entrypoint beside C5's `ConsoleRpc` / `AdminRpc`, too large to add safely in this batch's
  fix round; the source check closes the accidental-write path now.
- Rejected: leaving it undocumented; copying the app rows into the issuer's own D1 (two sources of truth).

### D252. The session pool carries the link methods, with a global daily cap on link adds
- Date 2026-11-02 · Status: to confirm · Source: the deploy review of batch 6 (M5)
- Decision: `link_identity`, `cancel_link` and `unlink_identity` are relayed by the session pool (its keys' allowance
  pays them), as built in batch 6. Their spend is bounded by the per-IP, per-account and per-app limits (D250) and a
  global ceiling of 5 000 link adds a UTC day across apps (`link-global`, refused above; removals can only follow adds).
  The alternative, to choose before mainnet: a third pool for links (its own keys and allowance), so a link flood can
  never use up the allowance logins share.
- Why: a third pool is another set of keys, secrets and deploy-plan states; the cap gives the bound now.
## Email login build, batch 8a (plain email login in the popup), 2026-11-02

Spec ambiguities met while building the minimal slice of batch 8 (no linking). All to confirm.

### D245. The email step handles wrong and expired codes itself; a cancel tells the partner why; `email_code` comes from the popup
- Date 2026-11-02 · Status: to confirm; built (`packages/web/src/auth/email-page.ts`, `vault/login.ts`
  `EMAIL_RELAY_ERRORS`, `acceptProgress`; core `hana:auth-progress`) · Source: spec "Vault, popup and SDK changes"
  (errors `code_invalid`, `challenge_expired`; `loginProgress` gains `email_code`)
- Decision: the popup keeps the user on wrong codes (tries left shown), expired or used challenges (back to the
  address, "Send a new code"), resend limits and every rate limit (one generic "Too many attempts. Try again later.").
  Those never end the login by themselves. "Cancel" in the email step writes `{error}` to the relay slot:
  `email_cancelled`, or `email_code_invalid` / `email_challenge_expired` / `email_rate_limited` when that was the
  last thing shown (reset to `email_cancelled` after a successful `resend` or `verify`); a step the user can't
  finish there (email unavailable for the app, no issuer in the env, case B without Google) writes `email_unavailable`
  at once (`login_method_unavailable`), and the page stops at the vault's deadline (5 min from `hana_login`, less the
  popup's 15 s connect window, from the context's creation). The vault turns them into `login_cancelled`,
  `code_invalid`, `challenge_expired`, `rate_limited`, `login_method_unavailable`,
  only in a login that offered email (Google's OAuth error codes never start with `email_`; elsewhere they stay
  `google_error`; looked up as own properties only). `loginProgress: email_code` is emitted when the popup posts
  `hana:auth-progress` after a `start` answered, and in a login that offered email `google` only when the popup says
  the user went to Google (the chooser, case B) or `method: 'google'` was asked; the vault takes them only from the
  window whose hello it answered, on `authOrigin`, each once. A Google-only app reports `google` at connect as before. A closed popup during
  the code step still ends as today (`login_timeout` after 5 min).
- Rejected: ending the login on the first wrong code (the spec's codes allow 5 tries); a popup → vault channel for
  each step (only the one progress signal is needed).

### D246. No key export for an email wallet in batch 8a
- Date 2026-11-02 · Status: to confirm; built (`vault.ts` `startExport`) · Source: spec "Export resolves the path the
  same way"
- Decision: `hana.exportKey()` on a session whose path isn't `#google#` is refused before any window opens (`4200`,
  `data.reason: 'email_export'`). The export window re-authenticates with Google only (export mode); an email
  re-authentication there (the code step in export mode, an email-token check in `export-page.ts`) comes with a later
  batch. Refusing is safe: the export window would otherwise sign in with Google and stop at its address check.
- Rejected: building export's email step now (not needed for a plain email login).
- **Lifted by batch 8b (2026-11-03, `feat/email-login-8b`; the user's request):** an email wallet exports like a
  Google one, after a fresh email code in the export window over its own session (D258); `data.reason:
  'email_export'` no longer exists.

### D247. The SDK surface: `login_method_unavailable`, `emailHint` rules, Google plus email only
- Date 2026-11-02 · Status: to confirm; built (core `protocol.ts`, `api-types.ts`; `client/login.ts`) · Source: spec
  "SDK"
- Decision: `hana.login({method?, emailHint?})`. `method` is `'google'` or `'email'`; one the app doesn't offer here
  (its `login_methods`, its scope's email client, or an env whose bundle pins no email issuer) rejects with the new
  code `login_method_unavailable`. `emailHint` (3–254 characters, an `@`, no space, control, bidi or invisible
  character) only prefills the field; it is refused with `method: 'google'`. Bad options reject with `-32602` before
  any popup opens. `GET /v1/app`'s `loginMethods` is accepted only as `["google"]` or `["google","email"]`, with
  `email.aud = "email:<scopeId>"` exactly when email is listed: an email-only app (`google: null`) is refused by
  `isAppConfig` (the vault answers `api_unavailable`) until the vault and the popup support it. `createHana({
  loginMethods })` (the spec's narrowing option) is not built yet. The API's email-login refusals (batch 6 after its
  reviews) map as: `409 link_pending` → the spec's `link_pending`; `409 identity_linked` → `login_method_unavailable`
  (`data.reason: 'identity_linked'`: sign in with the account's method); `401 token_stale` → `token_invalid`; `403
  login_method_disabled` → `login_method_unavailable`. A plain email login meets the first two only once links exist.
- Rejected: falling back to the chooser on an unavailable method (the partner asked for one method; it should know).

### D248. Turning email on for the demo app is by hand on sandbox-dev
- Date 2026-11-02 · Status: to confirm (who owns the demo's scope, and the owner's `propose_change` command) ·
  Source: D234 (batch 8's order), `docs/operations.md` "Email login demo on sandbox-dev (batch 8a)"
- **Only demo and test scopes get email in 8a.** Every email identity opened in 8a is a wallet of its own, and it can never join a Google account later (the contract refuses a link to an identity that already has a wallet: "Sign-in method already has a wallet"). Nothing writes `email_hints` before google-match (batch 8b), so case B never happens in 8a: a Google user who picks email with their Gmail address gets that second wallet. So email is turned on only for scopes whose
  users are Hana's own testers (the demo's), never for a scope with real Google users, until google-match's hint
  writes or a merge path ship (`docs/mainnet-readiness.md` row 7.1g).
- Decision: `login_methods = 'google,email'` for the demo app by a D1 statement, then the scope's email client
  through the staff client proof and the scope owner's `propose_change(AddClient)` (timelocked), then the 8a pages
  and API. There is no CLI command for either yet (the console toggle is batch 9). Real mail needs SendGrid; the
  `outbox` stub stays `local*`-only. Before SendGrid, the internal demo runs on the local e2e stack (the outbox,
  mocked chain and MPC), said as such.
- Rejected: allowing the outbox on sandbox-dev (codes in a store operators can read on a shared env); a temporary
  sender (more code that would ship to a real env).
- **"Demo scopes only" lifted by batch 8b (2026-11-03, to confirm):** every Google login of an app with email now runs
  google-match, which writes the hint, so an email login of a Google-wallet address reaches case B instead of a second
  wallet. The residual (a Google wallet opened before its app turned email on has no hint until its owner's next
  Google login there) is accepted per scope or waited out (`docs/operations.md` "Turning linking on (batch 8b)",
  `docs/mainnet-readiness.md` row 7.1g). Turning email on stays by hand until batch 9.
- 2026-11-03: the scope's email client now has a command, `admin sandbox-dev scope:add-email-client --scope s2`
  (D253); the demo's scope is `s2`, owned by `hana-id-admin-dev1.testnet`.

### D249. Batch 8a's paths come from the token, not `get_identity`; the popup's storage
- Date 2026-11-02 · Status: to confirm · Source: build plan batch 7 ("compute the path from `get_identity`"), batch 8;
  spec "Codes, attempts, expiry, replay" (`challengeId` in `sessionStorage`), D198 (device tickets)
- Decision:
  - Batch 7 isn't built. The vault fixes `{scope}#{provider}#{sub}#0` from the token it verified (`loginPath`; Google
    byte for byte as before, golden test), the record check accepts `#google#` and `#email#` paths of its scope, and
    the export window keeps `#google#`. Batch 8a creates no link (the vault never sends `linkJwt`), but links can still
    exist on chain: an explicit `/v1/link` relay, or a link made by another client of the scope. For a linked identity
    the computed path is not the session's (its root's): the vault refuses on its own checks, never derives another
    key. A re-synced session whose path isn't the computed one is `derive_failed`, a CKD answer for the root's path
    fails the pairing check (both tested in `packages/web/test/vault/email-login.test.ts`), and D136 refuses derivation
    on a linked identity's own path. So a linked user can't log in through 8a's web until `get_identity` resolution
    (batch 7/8b), which must come before any app enables linking.
  - `/login` → `/login/email` hands over the public login facts in `sessionStorage` (`hana.email.<relayId>`, 10 min:
    app, parent origin, the session commitment, the Google client for case B, the `challengeId` once started, and the
    partner's `emailHint` only until /login/email loads, which drops it from storage and keeps it in memory; never
    the relay key, a typed address, a code or a token). Device tickets go to `localStorage` on `authOrigin`, keyed by
    `sha256(trimmed lowercased address)` (not the issuer's full normalization: a key that misses only means no ticket
    is sent; the issuer checks the exact address), at most 5, 30 days.
  - Case B (`verify` says the address belongs to a Google wallet here) would continue as a plain Google login on the
    same relay slot, with no `linkTicket`. It can't happen in 8a: the issuer learns hints only from google-match, which
    8a doesn't call, so nothing writes `email_hints` (see D248: email identities opened in 8a stay separate wallets).
    The screen is built and unit-tested for 8b.
- Rejected: building `get_identity` resolution now (not needed while no links exist, and batch 6 is still in review).
- **Superseded by batch 7/8b (2026-11-03, `feat/email-login-8b`):** the vault and the export window resolve the path
  through `get_identity` (`packages/core/src/links.ts` `pathIdentity`); the "path from the token" shortcut is gone.
  The popup's storage rules stand, with the follow-up key added beside the relay key (D256).

## Email login build, batch 8b (linking in the popup and the vault, with batch 7), 2026-11-03

Spec ambiguities met while building batch 7 (path resolution) and batch 8b (google-match, the four cases, D133/D137/
D139 in the vault, banners, `linkAccount`, email export). Each takes the safer reading. All to confirm.

### D254. Google's verified email: a second, silent request by default; one interactive retry; the switch waits for the spike
- Date 2026-11-03 · Status: to confirm; amended by D264 (an explainer before the retry), D265 (the token is never
  revoked, so the retry is the first login's only), D270 (a third flow, `'token_first'`, in force since 2026-11-04,
  when the spike passed: `'second_request'` is now the tested fallback) and D273 (`'one_request'` removed; the
  callback's claim allow-list); built (`packages/web/src/auth/google.ts` `GOOGLE_EMAIL_FLOW`, `callback-page.ts`) ·
  Source: spec "How the popup gets Google's verified email" (the spike decides; the fallback), build plan batch 0
- Decision: `GOOGLE_EMAIL_FLOW = 'second_request'`, a code constant (changed only by a reviewed change). In a login of
  an app with email the login's own request stays `response_type=id_token`, `scope=openid`; the callback relays the
  token with `access: 'follow'`, then requests `response_type=token`, `scope=email`, `prompt=none`,
  `login_hint=<the token's sub>` and relays the access token in follow-up slot 1. When Google answers that silent
  request with `consent_required`, `interaction_required`, `login_required` or `account_selection_required` (the first
  time an app's client asks for `email`), the callback asks once more without `prompt=none` (Google shows its email
  consent); a second failure is relayed as the error. `'one_request'` (`id_token token`, `openid email`) is built but
  off, for after the spike (`apps/smoke/spike-email.html`). A link task's and a proof's Google requests never ask for
  `email`. Either way the vault and the API keep refusing an ID token with `email` (`token_has_pii`).
- Why: the fallback is correct whatever the spike finds; the spec's `prompt=none` alone would fail the first login
  of every user (no consent yet), and turning that into "no match" would refuse their login (D255).
- Rejected: `prompt=consent` on the retry (asks every time); one request now (unknown whether the ID token carries
  `email`).

### D255. When google-match can't answer, a Google identity without a wallet or an account is refused
- Date 2026-11-03 · Status: to confirm; amended by D264 (declined consent and another account get their own screen and
  reasons); built (`vault/login.ts` `matchGoogle`) · Source: spec "The four cases" ("The
  vault runs google-match before any chain call"), D122
- Decision: in a login of an app with email, if the issuer is unreachable, answers an error, or no access token came
  (the user declined Google's email consent), the vault reads `get_identity` / `get_account` of the Google identity:
  own, never opened and not the root of an account with members → refused (`api_unavailable`, `data.reason:
  'email_match_unavailable'`, "try again"); otherwise (it has a wallet, or is in an account) a plain login.
- Why: such an identity may be case A (an email wallet exists for its address); a plain login would derive its own
  path, a second wallet that can never merge (D122). An identity that already has a wallet can't be case A.
- Cost: while the issuer is down, nobody can open a *new* Google wallet in an app with email; existing users are
  unaffected. A user who refuses Google's email consent can't open a new Google wallet there.
- Rejected: proceeding without the match (a second wallet); refusing every Google login (existing users locked out).

### D256. The follow-up channel: the popup waits for the vault's word through relay slots; the vault may write them; `verify` answers the case-B `sub`
- Date 2026-11-03 · Status: to confirm; built (`packages/core/src/links.ts` `followSlot`, `relay.ts` `FollowNotice`,
  `vault/login.ts` `FollowChannel`, `auth/email-page.ts` follow-up mode, `apps/api/src/login-relay.ts` WRITERS,
  `apps/email-issuer/src/handlers.ts` `verify`) · Source: spec "Popup flow" (case A's "Link and continue" after the
  vault's google-match; banners in "every Hana popup"), D139 ("the `sub` of the address verified there (the issuer's
  `verify` answer)")
- Decision:
  - Google's pages sever `window.opener` (COOP), so the vault can't post to the popup after Google, yet case A's
    screen needs google-match's answer, which only the vault may ask for (D199's CORS, and the task's "from the vault
    only"). So a login of an app with email carries `followKey` (32 random bytes) in auth-params; slot `n` (1..12) has
    read key `HMAC-SHA256(followKey, "hana-id/relay-follow/v1" ‖ u8 n)` and id `b64url(sha256(read key))`; values are
    AES-GCM under `relayKey` with the slot's AAD. The vault writes notices in even slots, the popup answers notice `n`
    in `n + 1`, slot 1 is the access token. The API's login relay takes writes from `vaultOrigin` too (one write per
    slot as before). The popup stays open until the vault's last word (`done`, with banners or none; `stop`).
  - The email step needs the address's `sub` for D139, and the popup can't compute it (`K_sub`): the issuer's
    case-B `verify` answers `sub` beside `linkTicket` (a pseudonym already public once linked; only after a correct
    code; never the address).
- Why: one mechanism serves case A's screens, the banners, the proofs of `linkAccount` and the access token, with the
  relay's existing guarantees (end-to-end encryption, single use, nothing logged).
- Rejected: google-match from the popup (breaks D199's vault-only CORS and the "vault only" rule); a separate
  Durable Object kind (more surface for the same property); deriving the slot keys from `relayKey` (one key, two
  algorithms).

### D257. D137's recovery ends the login after revoking; D136's stale session asks the user to sign in again
- Date 2026-11-03 · Status: to confirm; built (`vault/login.ts` `LoginChain.onLinkedError`, `derive`) · Source: D137
  ("revokes that session and restarts with a fresh session key, a fresh Google token and a fresh link token"), D136
- Decision: a linked login resends only the API's "not executed" answers, and uses a known transaction's CKD answer
  when it has one. On `session_exists`, `session_key_in_use`, `ckd_failed`, a timeout, a NEAR error or an unknown
  outcome it reads the session and, if live, revokes it (`POST /v1/sessions/revoke`, counter `used + 1`), then ends
  the login with `derive_failed` (`data.reason: 'link_restart'`). The restart is the user's next sign-in (a fresh
  session key, Google token and link token; Google-hosted case A links silently again). A refusal the API makes
  before relaying (`link_refused`, `link_pending`, `links_unavailable`) ends it with that code. `identity_linked` from
  `/v1/derive` (a resynced session on an identity's own path that has since joined an account, D136) ends
  `session_consumed` with `data.reason: 'identity_linked'` (the vault's "Continue signing in" launcher).
- Why: a fresh Google token needs the user (a new nonce for a new session key); an automatic retry inside the popup
  would need a second Google round trip the user didn't ask for, and every failure path stays one rule.
- Rejected: an automatic restart through the follow-up channel (more states for a rare path).

### D258. Email-wallet key export (D246 lifted): the `session` purpose over the export window's own session
- Date 2026-11-03 · Status: to confirm; built (`auth/export-page.ts`, `auth/login-page.ts` in export mode,
  `auth/email-page.ts` export mode, `vault/vault.ts` `startExport`) · Source: the user (2026-11-03, "key export for
  email wallets"), D27, D41, D111, D246
- Decision: no new issuer purpose. The export window already opens its own short-lived session (`max_uses = 1`, its
  own nonce and relay); in an app with email its child popup offers both methods, and the email step's code is a
  `session` code over that session's commitment, so the token is bound to the export session exactly as Google's is.
  The export window checks the token against the chain's email keys and policy and the scope's email client, as the
  vault does, resolves the path through `get_identity` (a linked identity exports the account root's key, the shared
  wallet; a pending one is refused, `link_pending`), and shows the key only if it is the vault session's address.
  The export limit (3 an hour per path, D59) and the 5-minute erase (D111) are unchanged. Case B in export mode (the
  address belongs to a Google wallet and has none of its own) offers only "Sign in with Google".
- Why: a new purpose would be a new nonce layout in the issuer and the contract's fixture for the same binding.
- Rejected: an `export` purpose.

### D259. Banners, Cancel and Remove in the login popup; `hana.account()` and `linkChanged`; `linkAccount` proves the root
- Date 2026-11-03 · Status: to confirm; built (`vault/login.ts` `Afterword`, `PendingLink`; `vault/vault.ts`
  `account`, `noteMethods`, `linkAccount`; `client/client.ts`) · Source: spec "Notices", "Explicit linking", "SDK"
- Decision:
  - **Banners** show in the login popup after a login (its last word): every pending member (with **Cancel**), the
    member this login added (named "your … sign-in now opens this wallet too"), and active members that became active
    in the last 7 days (with **Remove** when the signed-in identity is the root). A login without them closes the
    popup at once. Cancel or Remove is a fresh sign-in of the login's own method over a `link_change` nonce the vault
    computed (fresh salt, the account's current epoch), relayed as `cancel_link` / `unlink_identity`. Other Hana
    popups (approvals, export) show no banners yet; Hana Home will.
  - **`hana.account()`**: from `get_account` of the session path's owner on the vault's own RPC: the root (`root:
    true`) and each member as `active` (or past its `effectiveAtMs`: lazy activation) or `pending`; no `sub`, no key.
  - **`linkChanged`**: after a login that linked (its result), at a session's first `hana.account()` for each pending
    member, and for every change a later `hana.account()` sees (added, activated, `removed`); after a banner's action.
  - **`hana.linkAccount({method})`**: the account proof is the root's (whose path is the session's), so it works
    after a reload whatever method the user signed in with; Google roots sign in with `login_hint` set to the root.
  - Not built: `createHana({loginMethods})`, the unlock and confirm pages (`/email/unlock`, `/email/confirm`), and
    `/link/cancel` (the notice mail's link: an email-side cancel needs the address's identity key, which only the
    issuer can compute, so cancel goes through a sign-in of an active method for now).
- Why: the popup is the one Hana surface every login passes through; the partner page gets the facts to show.

## Demo polish (branch `fix/demo-polish`), 2026-11-03

### D260. An email login's timings have their own stages; `google` is Google's only
- Date 2026-11-03 · Status: to confirm · Source: the sandbox-dev demo's diagnostics (an email login reported
  `google: 32476`), `packages/core/src/timings.ts`
- Decision: the residual of the vault's hello → token was always named `google`. For an email login it is now
  `emailRelay` (the relay's network legs), and the email step reports what it can measure on its own clock, as sums:
  `emailLoad` (its navigation), `emailEntry` (the address screen), `emailStart` (`start` and any `resend` round trips),
  `emailCode` (the code screen: the mail's delivery and the typing), `emailVerify` (`verify` and encrypting, up to the
  relay POST). The chooser's time is `choose` for either method (stored by /login into its own sessionStorage entry on
  the click, so the callback or the email step relays it). Stage names stay letters only (the record's key rule), so
  the brief's `email_entry` is `emailEntry`. A Google-only app's timings are unchanged; a Google login through the
  chooser has `google` less `choose`. The demo's table shows a method column and one "sign-in" column (`google`, or
  the email step's four user and issuer stages).
- Rejected: renaming `google` to a neutral name for both methods (breaks every saved run and the smoke page's history).

### D261. GET /v1/app: reads side by side, 8 s view timeouts, one retry from the login, its own timings
- Date 2026-11-03 · Status: to confirm · Source: a demo login with `app: 9954` (normally 0–500 ms)
- Findings (from the code; the request log of that login wasn't available here): the `app` stage is only the wait
  for `GET /v1/app`, which the vault asks right after `ready`. The vault's email-chain views (8a) and the registry
  check start after `app` and run in parallel, and the vault's RPC fallback (8 s, then `rpc.testnet.near.org` at
  ≈ 3.3 s a view, measured from Malaysia) only affects `verify`/`scopeWait`, so neither can make `app` slow. Smart
  Placement was replaced by a fixed region (D97). What remains is the request itself on a cold isolate after a deploy:
  the gate (D1 and the IP limiter object), two D1 rows, then `get_scope` and, for a shared-client app such as the
  demo's, `get_config`, one after the other, each a fetch with no timeout. Measured warm from here: `GET /v1/app` 0.4–
  1.3 s, a fastnear view 0.3 s.
- Decision: the API reads the settings rows and the registry side by side, awaiting both on every path (`get_config`
  only after `get_scope` shows a shared client is needed; its failure counts only where it is used), and gives every
  contract view an 8 s timeout (as the vault's own RPC calls; transactions keep waiting for the node). The shared
  in-flight `get_config` read is dropped once older than 10 s, so a read cancelled with its request (Workers cancel a
  request's unawaited I/O) can't hang the isolate's later `getConfig` calls (review H1). The vault's login asks `GET /v1/app` once more after a
  5xx or a network failure. `pk_test_` responses carry the API's timings, phases `app`, `limits`, `settings`, `chain`,
  and the login reports them inside `app` with the vault's round trip: `appRtt`, `appServer`, `appServerGate`,
  `appServerSettings`, `appServerChain`. The next slow `app` therefore says whether it was the API (and which part)
  or the network.
- Rejected: prefetching `GET /v1/app` before the unlock (it would compete with the unlock call on the reload path,
  D79's reason); an API-side RPC fallback (the API reads only `NEAR_RPC` today; a second endpoint is its own decision).

### D262. The SDK's vault load: an early `connected`, one frame retry, reasons for `vault_unavailable`
- Date 2026-11-03 · Status: to confirm · Source: "Could not load the Hana vault" for several minutes after a round of
  deploys, with wallet extensions installed, later fine with them on
- Findings: the SDK gave the whole load 5 s from inserting the frame to `ready`, with no retry. `ready` waits for the
  vault page (page Worker → API Worker → 3 D1 reads), `/vault.js`, IndexedDB and, with a stored session, the
  `POST /v1/vault/unlock` round trip (measured 2.0–3.0 s on a normal cold-ish session, `docs/context.md`). Right after
  deploys every hop is cold (new isolates without the app cache, restarted limiter objects), and extensions that inject
  into every frame add to the frame's load, so 5 s is easily passed; then the failure is final. The vault itself waits
  on no chain read before `ready`, only that one API call. Not conclusive without that session's logs, but the margin
  explains "minutes after a deploy, then fine" without the extensions being the cause.
- Decision: the vault posts `connected` (no data) on the port as soon as it takes the hello, before storage and the
  unlock. The SDK gives each frame 5 s to answer (`connected`, or `ready` from an older vault), draining one task at
  the deadline so a queued answer still counts. A frame still loading gets 5 s more, then `frame_timeout`; a frame
  that loaded but didn't answer is removed and inserted again once (same name and `src`, the first port closed, its
  late events ignored); after `connected`, `ready` has 20 s. Any failure removes the frame and closes its port. `vault_unavailable` carries `data.reason` (`csp_frame_src` at once without a retry,
  `no_answer`, `frame_timeout`, `ready_timeout`, `frame_replaced`) and `data.attempts`, with a message for each. A
  misconfigured page (origin, key) now fails after about 10 s instead of 5 (`docs/integration.md` section 3). `frame-ancestors`, the hello's origin and ancestor checks and
  the one-hello rule are unchanged; a refused hello and the vault's error page still get no answer, so "blocked by
  the vault page" and "the vault refused" are one reason (`no_answer`) by design. Unlock timings gain `retry`.
- Rejected: the vault answering a refused hello with a reason (tells a framing page whether a key or origin is
  valid); retrying after `ready_timeout` (the vault is alive; a reload repeats the slow unlock); a longer single
  timeout (a missing vault would still fail as late, and a slow one still fail).

## Email login build, batch 8b review fixes (branch `feat/email-login-8b`), 2026-11-03

### D263. A path through another identity is confirmed on two independent RPC providers; the vault pins each identity's root
- Date 2026-11-03 · Status: to confirm; built (`packages/web/src/path-check.ts` `confirmPath`; `vault/login.ts`
  `ownPath`, `movedPath`, `judgeLink`, `checkPin`; `auth/export-page.ts` `pathFor`; `vault/near.ts` and
  `auth/near-rpc.ts` `independent()`; `vault/record.ts` root pins; `packages/env` schema) · Source: the batch 8b
  review (W-H1); D96, D100, D119
- Finding: batch 7 took `status: 'member'` and `root` from one `get_identity` answer of the vault's RPC and checked only
  the view's `key`. The pairing check doesn't save that: it proves a CKD answer is the MPC's key for the path the vault
  asked about, not that the path is right. Whoever knows S' for a path (its owner) can forge `{big_y = y·G1, big_c =
  S' + y·A}` for the vault's public `A`, and the CKD outcome comes from the same RPC (the API's `NEAR_RPC` is the same
  provider). A lying RPC could so make a user's login open the liar's own wallet, and the user deposit into it. The
  `own` direction is safe: only the MPC can answer for the user's own path.
- Decision:
  - Whenever the path the vault (or the export window) will derive is not the signed-in identity's own (an active
    member's account root, a link judgement's target root, a path a pairing failure moved to), the view that named it
    is read again on the manifest's `rpc` and `rpcFallback` separately (`nearCallAt`, never one through the other),
    side by side. Both must agree with it on status, root and key, and the root's own `get_identity` must be `own`
    with its computed key on both. A provider that doesn't answer, or no `rpcFallback`, refuses with `api_unavailable`
    `data.reason: 'path_unconfirmed'` ("try again"); any disagreement with `'path_disputed'`. Fail closed: a member
    view that can't be confirmed never falls back to the own path. One list of independent providers stays out of the
    manifest for now: two, `rpc` and `rpcFallback`, which the schema now requires to be on different registrable
    domains outside `local*` envs, and requires at all in an env with `emailIssuer` (linking makes members).
  - **Root pins**: after each derivation that passed the pairing check the vault stores, per signed-in identity (its
    identity key), the root whose path it derived: in this frame's memory, and in the app's IndexedDB store when the
    app keeps the wallet (`pin|signer|appId|scope|ik`, no `sub` in the key; it outlives logouts). At the next login a
    root that changed other than by a link activating (pin = the identity itself, now a member: own → member, which
    the two-provider check above covers) is confirmed on both providers again before the chain step: an unlink
    (member → own) and a move to another account are refused unless both providers show it. A new device has no
    pin.
  - `pathIdentity` returns `unsupported` for a member whose root's provider has no path here (W-L2): refused
    (`login_method_unavailable`, `root_unsupported`), never a path built from it.
- Why: two providers are what the CKD key pin already relies on (D100: three at pin time). A user can't tell a
  forged wallet from their own, so the rare refusal while a provider is down is the right cost.
- Cost: a linked identity can't sign in while either provider is down (the playbook `near-rpc-outage` says so); four
  more view reads per member login.
- Operations: watch the rate of `path_unconfirmed` refusals (it rises when `rpcFallback` is down or rate-limits the
  vault). Testnet: sandbox-dev's second provider is `rpc.testnet.near.org` (slow, rate-limited), now needed by every
  linked login; accepted for the testnet demo. Before mainnet: keyed, operator-independent providers, and maybe 2 of
  3 (`docs/mainnet-readiness.md` row 4.19); 2-of-3 is not built. (Re-review, 2026-11-03.)
- A pin read that fails or doesn't answer within 1 s (`PIN_READ_TIMEOUT_MS`, re-review L3) fails closed: unless the
  path is the identity's own (the pairing check covers that), it is confirmed on both providers again, as a pin
  mismatch is, or refused. A store that answers "no pin" (a new device) still needs nothing more. The pins outlive
  logout on a shared device (an identity-key hash per scope: `docs/security.md`).
- Rejected: trusting the pairing check alone (the finding); one provider at `final` finality (still one provider);
  falling back to the own path when unconfirmed (a second wallet, and the user's funds split); refusing every root
  change outright (an unlinked user would be locked out on that device for good).

### D264. Google's email permission: explained before it is asked, its refusal and a wrong account have their own screen and reasons
- Date 2026-11-03 · Status: to confirm; built (`auth/callback-page.ts` `explainEmailPrompt`, `auth/email-page.ts`
  `showEmailConsent`, `vault/login.ts` `matchGoogle`, core `FollowNotice` `email_consent`, issuer
  `google_account_mismatch`) · Source: the batch 8b review (G-M1, G-M2); amends D255; D42 · Amended by D270: under
  `'token_first'` there is no explainer (Google's sign-in screen lists the email) and declining that screen is no
  Google login at all; the consent screen stays for a google-match `google_account_mismatch` · Amended by D341:
  declining that screen no longer ends the login (`google_error`, `access_denied`); the popup goes back to Hana's
  method chooser, and closing it there is `login_cancelled`
- Decision:
  - Before the interactive retry of the silent email request (D254), the popup shows Hana's own screen: "Google will
    now ask to share your email address with Hana. Only Hana's email service sees it, to find a wallet you may
    already have with that address, and it isn't kept." **Continue** (a click: Google's page is the user's own
    navigation) or **Not now** (relayed as Google's `access_denied`).
  - Declined (`access_denied` in slot 1) or another account picked on Google's screen (the issuer's new `400
    google_account_mismatch`, tokeninfo's or userinfo's `sub` not the ID token's), for a Google identity that D255
    would refuse (no wallet, no account): the vault sends notice `email_consent {reason: 'declined' |
    'account_mismatch', loginHint}` instead of ending the login. The popup: "Your Google email address is needed" /
    "This app checks whether your Google address already has a wallet. Hana uses it once and doesn't keep it. Without
    it you can't open a new wallet with Google here." (or "Another Google account was chosen" / "You signed in with
    one Google account, then picked a different one when Google asked to share your email address. Try Google again
    and pick the account you signed in with, or sign in with email instead."), with **Sign in with email instead** (an
    email login, `as: 'session'`), **Try Google again** (Google's permission screen for `loginHint`, its answer in
    the next slot) and Cancel. At most 3 such screens per login (`vault/login.ts` `EMAIL_CONSENT_ROUNDS`: a refusal
    on the third ends the login; until the 2026-11-03 re-review the code ended it after 2); then, or on Cancel, `login_cancelled` with
    `data.reason: 'email_consent_declined'` or `'google_account_mismatch'` (never `email_match_unavailable`, which
    stays for an issuer that can't answer). An identity with a wallet or an account logs in as before, no screen.
  - D42's partner-held client warning gains: with email login on, users grant that client the `email` scope, so
    whoever controls the Google project can also see which users granted it and read their addresses with a token
    of its own.
- Why: Google's prompt with no context reads as an app asking for the user's email for its own use, and a refusal
  ended the login with "try again", which can't help.
- Rejected: asking for the email scope up front in the login's own request (D254: the spike hasn't run); hiding the
  reason behind `email_match_unavailable`.
- Amended 2026-11-04 by D269 (the screen text only): "it isn't kept" and "Hana uses it once and doesn't keep it" were
  no longer true. The explainer now says "Google will now ask to share your email address with Hana. Hana uses it to
  find a wallet you may already have with that address and keeps it with your account. It doesn't share it with the
  app you're signing in to."; the declined screen "Hana checks whether your Google address already has a wallet. It
  keeps the address with your account and doesn't share it with the app you're signing in to. Without it you can't
  open a new wallet with Google here." ("Hana doesn't share it", not "the app can't see it": an app on its own Google
  client can read the address through Google, D42.)

### D265. Google's access token is never revoked (amends D254); google-match is retried after 429 or 503
- Date 2026-11-03 · Status: to confirm; built (`apps/email-issuer/src/handlers.ts` `handleGoogleMatch`,
  `src/google.ts`; `vault/login.ts` `googleMatch`, `vault/issuer.ts` `MatchBusy`; `apps/smoke/spike-email.html` legs C
  and D) · Source: the batch 8b review (G-H1, G-H2, G-L1, G-L5, G-L6); amends D254, D195's "the access token is
  revoked after the call"
- Decision: google-match no longer revokes the access token. Google's revocation ends the user's whole grant to the
  client: the email consent would come back at every login (D254's interactive retry was meant for the first login
  only, which revocation made every login), on Hana's shared client it would also cancel the grant other apps of that
  client rely on, and two logins at once revoke each other's token. The token is email-scope only, expires within the
  hour, reaches the issuer once per login through a single-use relay slot, and is never stored or logged. Since it
  stays valid, the vault retries a `429` or `503` from google-match (its `retry-after` when it is at most 20 s, else 1,
  2, 4 … s; at most 45 s of waits, never later than 90 s before the login's own 5-minute limit), and gives up on a
  google-match that takes over 30 s.
- Gate: before 8b reaches real users, the user runs `apps/smoke/spike-email.html` legs C (a plain `openid` login after
  the grant: its ID token must carry no `email` or `email_verified`, or every later Google login of that user would be
  `token_has_pii`) and D (the silent request again: it must succeed without a prompt) on real Google. **Passed on
  2026-11-04** for a Gmail, a Workspace and an outside-address account (`tokenHasPiiLockout: false`; D silent with no
  prompt; `docs/context.md` "Google email scope spike").
- Rejected: revoking (the reasons above); revoking only on a mismatch (the grant is the user's, not the token's).

### D266. Which email identity a Google address matches is the email issuer's word: accepted (extends D119)
- Date 2026-11-03 · Status: to confirm (accepted risk) · Source: the batch 8b review (W-M1, W-L1); D119, D133, D139,
  D200
- Decision: the vault can't check google-match's answer about *which* email identity a Google address belongs to: only
  the issuer holds `K_sub`, and the address never reaches the vault. So a compromised issuer (Worker code or secrets)
  can: (case A, Google-hosted) mint an `auto_link` token joining a new Google user silently to an email wallet the
  attacker controls, so that user's first Google login opens the attacker's wallet; and answer `none` for a user who
  has an email wallet, so their Google login opens a second wallet. The vault's D133 checks still bind the token to
  this session, the chain's state and the judged join, and D139 still stops a case-B join without this popup's email
  step; the contract's link counter (D200) records every new link per scope and hour and the watchdog alerts on a
  burst. The defence is the issuer's key custody and code (D121: KMS, a second signer), not the vault.
- Why: matching needs the address, and the design keeps it with the issuer only (D119, D230).
- Rejected: sending the address to the vault (it would reach the partner's origin's frame); a second matcher for case
  A (a second holder of `K_sub`).

### D267. Rate limits for linking logins: the login relay 40 writes a minute per IP, google-match 120 per 10 minutes
- Date 2026-11-03 · Status: to confirm; built (`apps/api/src/login-relay.ts` `RELAY_WRITES_PER_IP_MINUTE`,
  `RELAY_MAX_BODY`; `apps/email-issuer/src/limits.ts` `IP_MATCH_LIMITS`; core `RELAY_MAX_PLAINTEXT_BYTES`) · Source:
  the batch 8b review (G-M3, G-L7)
- Decision: a Google login of an app with email writes about 5 relay slots (the token, the access token, a notice, an
  answer, the last word; a consent, code or proof round adds two), so 10 writes a minute per IP refused the second
  such login behind one NAT. The relay takes 40 writes a minute per IP (about eight linking logins); reads stay 120.
  google-match takes 120 per IP per 10 minutes (was 30): each call needs a genuine Google ID token committed to a
  session and that account's live access token. The relay body cap is 12 KiB (was 8) and every relay value's
  plaintext at most 9000 bytes, so one-request mode's largest valid payload (a 4096-character ID token, a
  2048-character access token, case B's proof, the timings) always fits; a larger value is refused before it is
  encrypted.
- Rejected: per-login relay budgets (the relay doesn't know which slots belong to one login, by design).

## Operator tooling for the email demo, 2026-11-03

### D253. Dev envs mint a scope's email client proof locally; production keeps the issuer's Access route
- Date 2026-11-03 · Status: to confirm · Source: conversation (the internal email-login demo on sandbox-dev); D234,
  D248 (its open "the owner's `propose_change` command"); `docs/operations.md` "Email login demo on sandbox-dev (batch
  8a)" step 3
- Decision: `admin <env> scope:add-email-client --scope <id> [--yes]` adds `("email", "email:<id>")` to a scope in one
  command, without the issuer's `POST /v1/email/admin/client-proof` (behind Cloudflare Access, not configured on
  sandbox-dev and possibly unusable on a `workers.dev` host). It mints the client proof on the operator's machine
  with the issuer's own code (`apps/email-issuer/src/client-proof.ts`, which the staff route also uses: the same
  claims, nonce layout and JWS JSON) and the manifest's active key from `.secrets/<env>/email-issuer-signing-key.json`,
  checks it against a replica of the contract's checks with the manifest's key and with `get_issuer_keys("email")`,
  then signs `propose_change` (0.01 NEAR, 150 Tgas) and, once due (waited up to 10 min), `execute_change` with the
  scope's `Owner::Near` key from the keychain. A contract unit test (`tests/email/issuer_tokens.rs`) runs a proof
  from that code through the real `propose_change` and `execute_change`; the CLI's test checks it mints that same
  proof byte for byte.
- **`local*` and `sandbox*` only, never mainnet** (nor staging or any production network): the command refuses every
  other env name and any network or RPC that isn't testnet. In production the proof comes from the staff route
  (Access, the staff allowlist, the audit row, the "active app with email on" check), and the scope's owner sends the
  calls.
- Why it's acceptable on testnet: the operator already holds the same Worker-secret signing key (the only copy is in
  `.secrets/<env>/`, uploaded by `email-issuer put`), so the route adds no key control there; a proof binds one scope,
  one `action_nonce` and one client, lives 10 minutes, and goes through the scope's owner and the timelock like any
  other. What the local mint skips, the operator does by hand: the route's audit row (none is written) and its check
  that an active app of the scope has email on (step 2 of the checklist comes first). Mainnet's issuer key lives in
  AWS KMS with no exportable copy (D121), so the command could not mint there anyway.
- Rejected: configuring Access on sandbox-dev for one demo (Access on `workers.dev` is uncertain); an unauthenticated
  dev-only route on the issuer (a mint path that would ship to every env's code).

## Key export: copying the key, 2026-11-04

### D268. The export window shows the key on a Show key / Hide key toggle and copies it on Copy key
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'can you make so that the user can copy the private
  key as well? there are use cases where the user might want to use the same wallet in a different wallet app') ·
  In force on branch `feat/export-copy` (`packages/web/src/auth/export-page.ts` `showReveal`, `clearClipboard`,
  `EXPORT_CLIPBOARD_CLEAR_MS`; `packages/web/src/auth/auth.css` `.secret[data-shown]`) · Amends `docs/batch-b-spec.md`
  "Key export" step 5 ("shows the key while a button is held … Nothing is copied to the clipboard automatically") and
  D111's "Superseded or amended" row
- Why: hold-to-show hid the key on pointerup, pointerleave and blur, so it could never be selected or copied, and a
  user couldn't move the wallet to another wallet app (D41: export is the user's). MetaMask and Privy both show the
  key on a click and offer a copy button.
- **Toggle.** "Hold to show the key" is replaced by one button, "Show key" / "Hide key" (`aria-pressed`): a click, or
  Enter or Space on the focused button (both give a click), shows the key; a second click hides it. While shown the
  key text is selectable (`user-select: text`; hidden it is `none`, so the dots can't be copied by mistake). It still
  hides on window `blur`, on `visibilitychange` to hidden and on `pagehide`, and the erase (D111: 5 min, the
  session's end, the vault frame going away, the window closing) takes it off the screen for good. Unchanged:
  `translate="no"`, no `aria-live` around the key (AUTH-4, AUTH-6), the typed `EXPORT` confirmation, the confirm
  screen's warnings, the framing refusal, the address check and the export limit (D59).
- **Copy.** "Copy key" calls `navigator.clipboard.writeText(exportString(chain, key))` inside the click, before any
  await (so the browser counts the gesture), whether or not the key is shown: copying a hidden key never puts it in
  the page. The button says "Copied" for 2 s. If the Clipboard API is missing (an insecure context, an old browser)
  or refuses or throws, a status line says "Copy isn't available here: show the key and copy it by hand." No
  `document.execCommand('copy')` fallback: it needs the key in a hidden, focused and selected text field (one more DOM
  copy of the key that extensions, input methods and accessibility tools see, and a deprecated API), while the shown
  key can already be selected and copied by hand.
- **Both buttons act only on real gestures** (`isGesture`, `event.isTrusted`), like the rest of the page: a script's
  synthetic click neither shows nor copies the key.
- **The clipboard risk, accepted.** A copied key leaves the window's control: clipboard history (Windows' Win+V,
  macOS Universal Clipboard to the user's other devices, clipboard managers), other apps and extensions that read the
  clipboard, and a later paste into the wrong place can all see it. Accepted because moving the wallet to another
  wallet app is the export's purpose and copying by hand from a selectable key has the same exposure; the typed
  confirmation, the fresh sign-in and the 5 min window stay in front of it. The page says so: "A copied key stays in
  your clipboard until you copy something else, and other apps or your clipboard history may read it there: paste it
  only into the wallet you are moving to. We try to clear it after 60 seconds if this window is still open, but not
  every browser allows that, so the copy is yours to look after."
- **Best-effort clear.** 60 s after the last copy (each copy restarts it), at the erase and at `pagehide`, the window
  writes an empty string to the clipboard, only while `document.hasFocus()` (browsers refuse a write without focus)
  and only if it copied the key and hasn't blanked it since. It never reads the clipboard (no `readText`: that needs
  a permission prompt), so it can't tell whether the user has copied something else since; that's why it doesn't
  retry on the next focus, when the clipboard is more likely to hold something of the user's. A copy that lands after
  the erase is blanked at once. Per browser: Chromium (Chrome, Edge, Brave) allows a focused page to write without a
  gesture, so the clear works there; Firefox and Safari want a user gesture for every write, so the timed, erase and
  pagehide clears are expected to fail quietly there (Playwright's builds relax that rule, so the e2e can't show it);
  a closing page may not finish the write in any browser.
- Rejected: keeping hold-to-show (the user's problem); copying only a shown key (no safer, since the clipboard holds
  the same string, and one more step); a clipboard clear that reads first (permission prompt); clearing on every
  later focus (would wipe what the user copied since).

## User emails for Hana staff, Google's email on one screen, 2026-11-04

### D269. Hana stores each user's verified email address, for Hana staff only; partners don't see it
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'let's make the change and store the emails, as admin
  we want to be able to see the emails, no need to worry about privacy obligations … by default, partners cannot see
  the user's emails unless the user explicity approves … hide the user's emails for now') · Built: the table and its
  writer on `feat/user-emails-foundation` (`apps/email-issuer/migrations/0002_user_emails.sql`,
  `apps/email-issuer/src/directory.ts`); on `feat/user-emails`: the email write at every 200 of `verify`
  (`handlers.ts` `handleVerify`: session, case B, the link purposes and auto_link), `admin user:list` / `user:find`
  (`scripts/lib/admin-users.ts`, the issuer's D1 through wrangler with its log file off) and the screen text (D264's
  note); on `feat/google-token-first`: the Google writes, google-match's after its checks pass (whatever the
  decision) and google-record's (D270's token_first, an app without email login), both userinfo's address with
  `email_verified` and `hosted` (`handlers.ts` `checkGoogleSignIn`, `recordGoogleSignIn`, `handleGoogleRecord`).
  Migration 0002 not yet applied on sandbox-dev · Amends D119 and D230 ("the address is never kept"), D264's screen
  text ("it isn't kept"), the spec's "Privacy and what is stored"
- Decision: the email issuer, the only part that ever sees an address, keeps a user directory in its own D1:
  `user_emails` (provider, sub as on chain, the verified address, `email_verified`, `hosted`, first and last seen)
  and `user_email_apps` (which apps and scopes each identity logged in to). Email logins write at a successful verify
  (the normalized address); Google logins at google-match, and under D270 at every Google login whose app is on an
  issuer env. Writes are best effort after the answer (`waitUntil`): a failed write logs `directory_write_failed`
  (app and scope only) and never fails or slows a login. Hana staff read it with the admin CLI now, the admin
  console's Users page later (batch C). Partners don't: the API, the SDK and the partner console read nothing from
  the issuer's D1 (the batch C spec already shows partners "no email or Google account"). A user-approved share to a
  partner is later work (UX not designed). Logs still never carry an address.
- Why: staff need to find a user's wallet by address (support) and see who uses which app, as Privy's dashboard
  does; a stored `sub` per address also keeps existing email users' wallets reachable if `K_sub` were lost.
- Cost, accepted by the user: a table joining each address to a public wallet, so a reader of the issuer's D1 learns
  each user's on-chain balance and history; the privacy obligations that come with it are out of scope for now.
- Caveat (as Privy): an app on its own Google client (D42) can read its users' addresses through Google regardless.
- Accepted (security review, 2026-11-04): anyone can make google-record, or google-match, write directory rows for
  their **own** Google account and any active app, including apps that account never logged in to: the endpoints
  check the Google tokens and the session commitment, not that a session was opened, and `Origin` can be forged
  server to server. Harmless to matching and linking, which read `email_hints` and never the directory; it affects
  only the accuracy of the staff view (an app listed for a Google identity is a strong hint, not proof).
- Accepted: under D270's token_first the popup on Hana's auth origin parses Google's tokeninfo answer, which includes
  the address, in memory and keeps only `sub` (with `aud`, `azp` and `expires_in` checked). Nothing of it is relayed,
  stored or logged.
- Review fixes (branch `fix/user-emails-review`, 2026-11-04; the REST read and the `wrong_client` exception to
  confirm):
  - Writes land out of order (`waitUntil`): an upsert updates `email`, `email_verified`, `hosted` (and an app row's
    `scope_id`) only when its `last_seen_ms` ≥ the row's; `first_seen_ms` is the MIN, `last_seen_ms` the MAX
    (`directory.ts`).
  - A Google row with `email_verified = 0` is that account's claim to the address, possibly someone else's address:
    `user:find --email` lists such rows apart under "UNVERIFIED: this Google account claims the address but Google
    hasn't verified it; don't treat it as the owner", `user:list` tags them, `--json` has `unverifiedClaim`
    (`admin-users.ts`).
  - The CLI's statement (which can hold the searched address) never goes in a process argument (`d1.ts`
    `issuerD1Execute`): locally a 0600 file in `.secrets/tmp/` (0700) passed as `wrangler d1 execute --file`, deleted
    in a `finally` (a killed run's file is swept after 15 min); remotely D1's REST query endpoint with the operator's
    wrangler credentials (`wrangler auth token --json`, read over a pipe), because wrangler 4.151.1's `--remote
    --file` is D1's import: the file goes to Cloudflare's import bucket, the database is unavailable while it runs,
    and only counts come back, never rows. Rejected: keeping `--command` for the remote read (the address in `ps`
    and in endpoint-monitoring logs of the operator's machine); fetching every row and filtering locally (doesn't
    scale).
  - google-record is called only after `/v1/login` succeeds and the key passes its check, in the background, never
    awaited, so a refused or cancelled login isn't recorded as a login to the app (`vault/login.ts`). google-match
    stays before the login (matching needs it).
  - A record-only login (token_first, no email login) no longer depends on tokeninfo: when tokeninfo gives no
    answer or refuses the token, the popup drops the access token, writes nothing to slot 1 and makes batch B's
    openid request (account chooser, the login's nonce); its ID token is relayed without `access: 'follow'`, so the
    vault records nothing and the login goes on (`callback-page.ts` `recordOnlyFallback`). Another client's token
    (`wrong_client`) still ends it: that is tampering, not an outage. Apps with email login stay fail-closed (D255).
- Rejected: encrypting the column (exact-match search only; staff want Privy-like search); showing partners the
  address by default.

### D270. Google's email permission on Google's own sign-in screen: an email access token first, then a silent openid sign-in (spike passed; on)
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'can we also do the "one request" thing so there is no
  additional prompt during google sign ins?'; 'yes ask for email, assuming reverse flow works') · **Spike passed
  2026-11-04; switched on**: the user ran `apps/smoke/spike-email.html` with sandbox-dev's shared login client for a
  personal Gmail, a Workspace account on its own domain and a Google account on an iCloud address, and every leg passed
  for all three (C: `tokenHasPiiLockout: false`; E: tokeninfo reachable from the browser, status 200, its `sub` and
  `aud` right, the silent ID token issued with no email or other personal claim, the nonce matching, the same account,
  `tokenFirstUsable: true`; E2: `returningTokenClean: true`; every ID token exactly the openid claim set, Workspace's
  `hd` in userinfo only; first-time consent one Google screen listing "Email address", none for a returning grant;
  `docs/context.md` "Google email scope spike"), so `GOOGLE_EMAIL_FLOW = 'token_first'` on `feat/token-first-on`
  (not deployed; the deploy steps are `docs/operations.md` "Turning linking on (batch 8b)") · Built on
  `feat/google-token-first`: `packages/web/src/auth/google.ts` (`loginGoogleRequest`,
  `googleTokenFirstUrl`, `accessTokenSub`), `auth/callback-page.ts` (`tokenFirstAccess`, `tokenFirstId`, the claim
  allow-list before relaying), `auth/login-page.ts`, `auth/email-page.ts` (case B), `auth/pages.ts` and
  `apps/api/src/pages/host.ts` (the callback's tokeninfo `connect-src`), core `hana:auth-params` `emailRecord`,
  `vault/login.ts` (`recordGoogle`), `vault/issuer.ts` (`googleRecord`), the issuer's `google-record` and
  google-match's directory write (`apps/email-issuer/src/handlers.ts` `checkGoogleSignIn`, `handleGoogleRecord`);
  the silent failure and `'one_request'`'s removal are D273. Tested for both flows (unit and the vault harness), and
  token_first in Playwright since the switch (`apps/e2e/tests/token-first.spec.ts`, D273's note) · Depended on the
  spike: tokeninfo must answer the browser's CORS POST (else
  every token_first login of an app with email login ends `tokeninfo_unavailable`; a record-only login falls back to
  batch B's openid login and records nothing, D269's review fixes); a command-line check on 2026-11-04 (`feat/spike-leg-e`) saw
  it echo any `Origin` and allow the preflight, and leg E confirmed it in a real browser (2026-11-04) · Amends D254 (the flow), D264 (no explainer screen under
  it), D25 unchanged
- Decision: a third flow, `'token_first'`. The login's first request is `response_type=token`, `scope=openid email`
  with the account chooser: Google's single sign-in screen lists the email. The callback then makes a silent
  `response_type=id_token`, `scope=openid`, `prompt=none`, `login_hint=<the access token's sub>` request with the
  login's nonce; only that ID token goes on chain. Under it every Google login asks for the email, also in apps
  without email login (the address goes to the directory only there, no matching). A literal one request (`id_token
  token`, `openid email`) stays rejected: Google puts `email` in that ID token, which would put the address on chain.
- Guarantees that no address reaches the chain: the spike's legs C and E on real Google before the switch (passed
  2026-11-04); the
  claim allow-list (`TOKEN_CLAIM_ALLOW_LIST`) refuses any token with another claim, `token_has_pii`, in the popup, the
  vault and the API before anything is submitted (on every route since D271): a Google change would lock logins out,
  never leak; tests that the on-chain request is `openid` only and that an email-carrying token is refused with
  nothing relayed.
- Rejected: the literal one request (above); keeping the explainer and Google's second screen (the user's ask).
- Amended 2026-11-04 by D341: a cancel on the first request's screen (Google's `access_denied`) is no longer relayed
  as the login's end (`google_error`); the popup goes back to Hana's method chooser (or case B's choices) and the
  login goes on, and closing the window there is `login_cancelled`.

### D271. The API's claim allow-list is on for every route that relays a Google token (REJECT_PII_ON_SESSIONS retired)
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'how can we be sure that the reversed flow works without
  mistakenly storing emails on chain?', then 'yes go ahead and build all these') · Built on `fix/sessions-allow-list`
  (merged into `develop`; not deployed): `apps/api/src/login-token.ts` `verifyLoginToken` applies `disallowedClaim` to every
  Google token with no `claimAllowList` option left to turn off, so `/v1/sessions`, `/v1/login` (its `jwt` and
  `linkJwt`) and `/v1/link`, `/v1/link/cancel`, `/v1/link/unlink` all refuse; `/v1/owner-actions` too (D274);
  `REJECT_PII_ON_SESSIONS` removed from `env.ts`, `gen-wrangler.ts` `FLAG_DEFAULTS` and the test config (a leftover
  var in a deployed config is ignored until the next `gen` and deploy drop it); `apps/smoke/direct.html` moved from
  Google Identity Services to the implicit flow, `scope=openid` (`src/google.ts`, `direct-callback.html`; the page
  also refuses to send a token with another claim) rather than retired, since it still covers what the vault can't
  (the ship gate's split side, `key_index` ≠ 0, the client choice, revoke, replays). Tests: `session-flags.test.ts`
  (every named claim on `/v1/sessions` is `400 token_has_pii` with no RPC call and no transaction; a leftover `"0"`
  var changes nothing), `email-login.test.ts` (the link routes), `owner-actions.test.ts`,
  `scripts/test/relayed-tokens.test.ts` (only `login-token.ts` and `owner-actions.ts` call `verifyIdToken`, each
  followed by the allow-list; the API's list equals `@hana-id/core`'s), `apps/smoke` `direct-page.test.ts` and
  `direct-callback-page.test.ts`. The user's step: add `http://localhost:5173/direct-callback.html` to the redirect
  URIs of the Google clients the direct page uses (`docs/operations.md` "Google clients")
- Decision: `/v1/sessions` refuses a Google token with a claim outside the allow-list (`token_has_pii`), as `/v1/login`
  and the link routes already do; the `REJECT_PII_ON_SESSIONS` flag is removed so it can't be turned off. The smoke
  pages that sent Google Identity Services tokens (which carry `email`) move to openid-only tokens or are retired.
- Why: D270's guarantee ("no route relays an address") must hold for every route, not only the vault's.

## Google's email on Google's sign-in screen: the build (branch `feat/google-token-first`), 2026-11-04

### D273. token_first's silent ID request: one interactive openid-only retry; `'one_request'` removed; the callback refuses PII before relaying
- Date 2026-11-04 · Status: to confirm (taken while building D270) · Built on `feat/google-token-first`
  (`packages/web/src/auth/callback-page.ts` `tokenFirstId`, `relayLeg`; `auth/google.ts`) · Source: D270, D254, D264
- Decision:
  - When token_first's silent `id_token` request (`prompt=none`, `login_hint`) fails with `login_required`,
    `interaction_required`, `consent_required` or `account_selection_required`, the callback asks once more without
    `prompt=none`: still `response_type=id_token`, `scope=openid`, the same `login_hint`, nonce and slot, with no Hana
    screen first. A second failure, or any other error, is relayed (`google_error`); an ID token whose `sub` isn't the
    access token's (tokeninfo's) ends the login with `google_account_mismatch`. (Amended by D341: the user cancelling
    this retry, `access_denied`, goes back to the login's choices instead of being relayed.)
  - `'one_request'` is removed from `GoogleEmailFlow` and the popup (it can't keep `email` out of the ID token, D270),
    so under every flow the only request whose ID token is relayed asks for `scope=openid` only. The vault still reads
    an access token beside an ID token (the relay format and the vault's tests use it); no popup sends one.
  - `/login/callback` checks every ID token it would relay (a login's, an ID leg's, a proof's, the export window's)
    against the claim allow-list first; one with any other claim is never relayed: the slot says `{error:
    'token_has_pii', claim}` (core `isRelayPayload` takes `claim` beside that error only), the window shows it and
    stays open, and the vault ends the login `token_has_pii` with `data.claim`, as its own refusal does (D270's
    "refused with nothing relayed"; `apps/e2e/tests/login.spec.ts` checks it in three browsers).
- Why the retry: the user has just signed in on Google's own screen in this window, so a silent failure is a Google
  session quirk (a Workspace re-auth policy, several signed-in accounts, cookies), not a refusal; one interactive
  openid-only request for the same account keeps that login alive without asking for anything new, so Hana's
  explainer (D264) has nothing to explain. More than one retry would loop on a real refusal; failing outright would
  end logins that a single confirmation saves. An unhinted request is never made: the account must stay the one whose
  email the access token carries.
- Not run in Playwright when built: the e2e bundles are built once per env with the flow compiled in, so a
  token_first run needed a third e2e env, the Google stub's token_first requests, and a browser route for tokeninfo
  with CORS; left for after the spike. Since the switch (2026-11-04, `feat/token-first-on`) the e2e bundles carry
  `'token_first'`, so no third env: the stub takes its requests (the chooser's access token, the silent ID request,
  this retry for an account whose silent answer is an error) and the tests' contexts route tokeninfo
  (`apps/e2e/tests/token-first.spec.ts`: the retry, tokeninfo unreadable, the directory rows, openid-only on chain);
  `'second_request'` keeps its unit and vault-harness tests only.
- Rejected: no retry (a Google quirk ends the login); Hana's explainer before the retry (nothing new is asked); keeping
  `'one_request'` behind the switch (a known-bad value one line away).

## Claim allow-list on owner actions (branch `fix/sessions-allow-list`), 2026-11-04

### D274. Owner-action tokens and client proofs are held to the same claim allow-list
- Date 2026-11-04 · Status: decided while building D271 (Claude, under D271's "every route that relays a Google
  token"), to confirm · Built on `fix/sessions-allow-list` (`apps/api/src/owner-actions.ts` `piiRefusal`) · Amends the
  `/v1/owner-actions` note in `docs/api.md` ("Their other claims are not read … nothing refuses one that isn't")
- Decision: `/v1/owner-actions` refuses an `auth` owner token or an `AddClient` `client_proof` with a claim outside
  `TOKEN_CLAIM_ALLOW_LIST`: `400 token_has_pii` with `data: {claim}`, after the signature check and before the token
  is reserved or anything is relayed. The contract stays permissive (direct callers are unaffected).
- Why: both tokens are relayed to `hana-signer` as call arguments, so they are public on chain like login tokens; an
  owner's email or Workspace domain (`hd`) would otherwise be published. Nothing sends such tokens today (no console
  or CLI posts to `/v1/owner-actions` yet), and the batch C spec already plans openid-only step-up tokens for owner
  actions ("Email claims by scope": `openid` must carry no `email`), so no flow breaks.
- Rejected: leaving owner tokens unchecked (D271's guarantee would have a hole on the owner pool); a separate flag.

## Batch C6 on current `develop` (branch `feat/batch-c-6-merge`), 2026-11-04

### D277. Batch C6 meets the claim allow-list: one rule for every Google token the API verifies
- Date 2026-11-04 · Status: to confirm (decided while merging `develop` into batch C6, which had been built before
  D271 and D274) · Built on `feat/batch-c-6-merge` (`apps/api/src/owner-actions.ts` `precheckOwnerAction`,
  `changes/step-up.ts` `verifyStepUpToken`, `rpc/console.ts` `ownerAction`; `apps/api/scripts/test/relayed-tokens.test.ts`)
  · Amends D237 and D239
- Decision:
  - **Owner actions, both paths.** C6's `ConsoleRpc.ownerAction` refused an owner token with `email`,
    `email_verified` or `hd` (403, console only) and let a client proof carry them; D274 refuses any claim outside
    `TOKEN_CLAIM_ALLOW_LIST` on both tokens of `/v1/owner-actions`. Both now hold on the one shared precheck
    (`precheckOwnerAction`, which `runOwnerAction` runs for the endpoint and the RPC): D274's check right after each
    token's signature check (the owner token's before the console audience and any chain read, the proof's before its
    client and nonce checks), so always before the reservation, the caps and the relay, with no option that skips it. The console path keeps its strict optional claims (D201). Its
    refusal is the RpcCode `forbidden` with `token_has_pii: …` and the claim's name in the message (never a value).
  - **The step-up token** (`changeOrigins`, `proposeChange`) is refused for any claim outside the same allow-list
    (`forbidden`, the claim named), not only `email`, `email_verified` and `hd`. It is never relayed, but it is a
    console token asked with `scope=openid`, so a well-formed one has none, and one list is easier to keep right than
    two. The source scan that lists every `verifyIdToken` caller now names `changes/step-up.ts` and checks its
    allow-list call.
- Why: a client proof is relayed as a call argument like the owner token, so C6's "a proof may carry the email" would
  have published a partner user's address on chain through the console; and two different PII rules on one shared
  path would drift.
- Rejected: keeping C6's console-only check next to D274's (two rules, and the narrower one decides nothing D274
  doesn't); exempting the step-up token because it isn't relayed (a name or picture claim there means the console
  asked Google for more than `openid`, a console bug worth refusing).

## Batch C8: the admin Worker (branch `feat/batch-c-8`), 2026-11-04

### D278. The admin BFF: routes, the Access check's order, error codes, what the SPA is
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/{index,access,csrf,routes,
  export}.ts`, `public/` · Source: spec §Admin BFF routes, §Hana admin console, §Static assets
- Decision:
  - **Order on `/api/*`**: host (only `admin.origin`, else 404), then the Access JWT check (`Cf-Access-Jwt-Assertion`
    only; no cookie, no `ctx.access`), then the console's four CSRF checks with the header `x-hana-admin: 1` (the
    console's is `x-hana-console`), then the route. Assets need no JWT in the Worker (Access guards the whole origin at
    the edge, and they hold no data); non-GET requests to them are CSRF-checked and 405.
  - **Codes**: 401 `unauthenticated` (no token or any failed claim), 403 `not_staff` (valid identity, not on
    `admin.staffEmails`), 503 `access_unavailable` (certs unreachable, or `ACCESS_AUD` still `UNSET`, or an unusable
    staff list: fail closed), 503 `upstream_unavailable` (the API or console binding threw), 403 `csrf`; RpcCodes keep
    console-core's statuses.
  - **The app routes carry the org.** AdminRpc's org methods take `orgId` as a backstop filter, so `GET
    /api/apps/:app?org=` and every app write's body name it; the spec's paths are otherwise kept. A handler builds its
    RPC input from named fields only, so a body can't set the actor or the request id.
  - **Additions to the spec's table**: `GET /api/me`, `GET /api/orgs/:org/changes` (the org's `app_changes`, for the
    changes screen), `GET /api/apps/:app` (detail). `GET /api/audit` answers the console's `queryAudit` rows and, when
    the filter names an org, its `listChanges` rows as a second list; `GET /api/audit.csv` merges both newest first with
    a `source` column (at most 5 000 rows per source, `x-hana-truncated: 1` past that). Without an org filter the CSV
    has the console rows only: `changesSince` walks forward from a seq and can't seek by time, so a global app-changes
    export waits for a time-indexed RPC.
  - **The SPA** is plain HTML, CSS and JavaScript in `public/` (no build, no framework; the console's React SPA is C9),
    writing text only (a source check forbids HTML sinks). The nav shows Reports (C12), Retention (C13) and Security &
    monitoring (C14) disabled; the Users screen (D275) has no entry until it is confirmed.
- Why: the staff list is a second check behind the policy (D88), so both must fail closed; the org filter costs one
  parameter and keeps the API's backstop for the admin too; a no-build SPA keeps C8 small and CSP-clean.
- Rejected: `/api/orgs/:org/apps/:app/...` paths (a rename of the spec's table for the same effect); serving the
  assets only with a JWT (no gain behind Access, and it breaks the error page before sign-in).

### D279. Blocking notices: one message per recipient, who gets what, when the ack happens
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/notices.ts`, `mail.ts`,
  `email/` · Source: spec §Email, §Notice and cancel, §Invites and owner grants
- Decision:
  - Every email is **one message per recipient** (no contact sees another's address), each with a Resend
    `Idempotency-Key` of sha256(purpose ‖ recipient), so the retry of a notice after one failed send doesn't deliver
    the accepted ones twice (within Resend's 24 h). "Every send accepted" means every recipient's message got a 2xx
    with a message id. **Amended by D401 (2026-11-05):** SendGrid, accepted = `202`; no idempotency key, so the same
    sha256 keys a per-isolate memo of accepted messages (24 h) instead, and a repeat is possible, a skip never.
  - `change_pending`: the alias and every contact of the org (from `pendingNotices`), link
    `<console.origin>/cancel/<id>#t=<T>`; then `ackNotice` with b64url(sha256(T)).
  - `member_invite`: the notice to every current owner (`pendingMemberNotices.owners`), the org's contacts
    (`getSecurityContacts`) and the alias; **then**, only if all of those were accepted, the invitee's link
    `<console.origin>/invite#t=<T>`; then `ackMemberNotice`. A new-org invite has no owners or contacts: the alias and
    the invitee. Contacts that can't be read (the API down) hold the notice back (fail closed).
  - `owner_grant`: every owner, the contacts and the alias, with `<console.origin>/cancel-owner/<id>#t=<T>`.
  - Nothing is acked when `EMAIL_API_KEY`, `CANCEL_LINK_KEY` or `INVITE_LINK_KEY` is missing or not 32 bytes of
    base64. Link keys are base64 (or b64url) of 32 random bytes in `.secrets/<env>/`.
  - The invite notice names no request country: `InviteView` carries none (the console records the country in its
    audit row only). The org's name comes from `StaffRpc.getOrg`, once per org and run.
- Why: the spec's fail-closed rule is about acceptance by the provider, so a per-recipient view is what can be
  checked; sending the invitee last keeps a working-looking link from leaving while the owners weren't told.

### D280. The 5-minute cron's order and its budget of outbound calls
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/cron.ts`, `mail.ts`
  `RUN_BUDGET` · Source: spec §Crons
- Decision: one cron (`*/5 * * * *`) runs the blocking notices (changes, then members), then the feed (security
  events, app changes, console audit), then the watcher, each step on its own. They share a budget of **40 outbound
  calls** per run (each email and each `get_scope`; *amended by D380: every RPC and the ops connection count too, at
  most 30 RPCs*); a notice whose recipients don't fit in what's left waits whole
  for the next run, and the feed and the watcher stop and resume from their cursors. The notices need no Neon; without
  `USAGE_DB` (or with Neon down) the feed and the watcher are skipped and logged at error level every run.
- Why: the Workers free plan allows 50 subrequests an invocation and the plan isn't settled (build plan open question
  3); a bounded run never half-sends a notice, and the blocking work comes first.

### D281. The feed: digests per org, what is skipped, who gets them, where the cursors start
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/feed.ts`, `ops.ts` · Source:
  spec §Email (Feed), §Audit
- Decision:
  - Rows are read in pages of 50 after the cursor (`feed.app_changes.seq`, `feed.audit_log.seq` in `ops.state`) and
    sent as **one digest per org and source per run**. The cursor moves past a page only up to the first row of the
    first org whose digest wasn't accepted (at least once, never a gap).
  - **Recipients**: the org's security contacts; an org with none, or a row with no org, goes to the alias instead so
    nothing is mailed to nobody. `org.security_contacts` rows also go to the old and the new contacts. Security events
    go to the alias and the org's contacts and are marked with `markSecurityEventNotified` (the API's `notified_at` is
    their cursor).
  - **Skipped** (a blocking notice or another row covers them): `origin.proposed`, `policy.proposed`,
    `raw_sign.proposed`, `change.announced`, `invite.notified`, `owner_grant.notified`, `change.link_cancel`, and the
    sign-in rows (`auth.*`, `session.*`) left to C9's hourly bulk refusal digest. **Everything else is emailed**, so a
    new kind is never silent.
  - ~~The cursors start at 0: the first run walks the whole history (legacy rows have no contacts, so their digests go
    to the alias) and catches up within a few runs.~~ **Amended by D344** (2026-11-04, confirmed by the user): a cursor
    with no row starts at the source's current position, silently.
- Why: a digest per org keeps the mail volume and the run budget bounded; a skip-list fails loud where an allow-list
  would fail silent.
- Rejected: seeding the cursors at the current maximum on first run (loses rows written between the deploy and the
  first run). *(Taken after all by D344: emailing the whole history was the worse failure.)*

### D282. The watcher: round-robin scopes, a silent baseline, retries until sent
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/watcher.ts`, `near.ts`;
  `apps/api/src/rpc/admin.ts` (`listApps`, `getApp` take `system`) · Source: spec §On-chain owner actions (watcher)
- Decision:
  - Each run reads up to 15 scopes of `AdminRpc.listScopes` after `watch.scope_cursor` (wrapping to the start), one
    uncached `get_scope` each, and emails the alias and the org's contacts.
  - A pending change is written to `ops.scope_watch` when first seen and gets `notified_at` only once every send was
    accepted; until then each run tries again. SetOwners lists the new owners with the added ones marked and calls out
    an added `Owner::Oidc`; AddClient names the client; SetAllowShared lists the scope's active origins (read with
    `AdminRpc.listApps` and `getApp`, which now also take the cron's `system` actor: reads only).
  - The owners, clients and `allow_shared` diff against `ops.scope_snapshot` is emailed once; the snapshot is replaced
    only after that email was accepted. Order of owners or clients is not a change. **A scope seen for the first time
    is stored as the baseline without an email.**
  - A scope `get_scope` can't read (NEAR down) is skipped this round and logged; one the contract doesn't have is
    logged `not_on_chain`.
- Why: the first state is what Hana registered (`scope:register`), so a "now watching" email for each would be noise;
  round-robin keeps each run within the budget.
- Trade-off: a change made between a scope's registration and the watcher's first read of it is in the baseline
  unannounced. Registration and the first read are minutes apart and the registration itself is a staff action.

### D283. `StaffRpc.getOrg` also returns the org's live owner grants
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/views.ts` `grantsOf`,
  `staff-rpc.ts` · Source: spec §RPC (`getOrg` → org, members, invites), §Admin BFF routes ("pending invites and
  grants", cancel by id)
- Decision: an additive `grants` field (`OwnerGrantView[]`, not cancelled and not applied, newest first, at most 100;
  never `cancel_token_hash`). The admin's members screen cancels a grant by its id from it.
- Why: members carry `pendingOwnerFrom` but no grant id, and a grant not yet acked or of an unaccepted invite has no
  member at all.

### D284. The admin config: where it lives, the Hyperdrive id, what it binds in C8
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/scripts/gen-wrangler.ts` · Source:
  spec §Topology (admin routes), §Bindings, build plan C8
- Decision:
  - `admin.origin` on `https://<admin.workerName>.<subdomain>.workers.dev` gives `workers_dev: true` in a dev env
    (`local*`/`sandbox*`, not mainnet) only, with Worker-level Access to be turned on in the dashboard (D75); any other
    https host gives a Custom Domain route and `workers_dev: false`; a production manifest on workers.dev is refused.
    `preview_urls: false` always.
  - `--admin-hyperdrive-id <id>|off` binds `USAGE_DB` to the admin config (`hana-id-usage-admin-<env>`); kept from an
    existing config of the same Worker; required on a production manifest; `off` allowed in dev envs.
  - C8 binds `API` → `AdminRpc`, `CONSOLE` → `StaffRpc`, `USAGE_DB`, `ASSETS`; **no R2 yet** (`STATEMENTS` and
    `EXPORTS` are C12's) and no `RELAYER_ACCOUNT` (the nonce check, C12). Vars add `APP_CHANGE_DELAY_MS` and
    `OWNER_GRANT_DELAY_MS` (only the notices' wording) and `STAFF_EMAILS` as JSON.
- Why: nothing half-wired; the spec allows workers.dev only for a dev env without a Hana zone.

### D285. The owner/contact flag and C8's part of the security screen
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/routes.ts` (`GET
  /api/orgs/:org` flags), `security.ts` · Source: spec §Hana admin console (screens)
- Decision: the org screen flags an org with **no security contacts** and lists **owners who aren't security
  contacts** (the onboarding default makes every owner a contact). `GET /api/security` in C8 shows the notice backlog,
  the unnotified security events, each feed cursor with its lag (the age of the oldest row not yet emailed), the
  watcher cursor and the last cron run; breaker state, nonce checks and rejection-rate alerts come with C12, the
  monitoring view with C14.

## Users and their wallets for staff and partners, 2026-11-04

### D310. Hana records each user's wallet addresses and linked accounts; staff see email and wallets, partners see wallets but not email
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'we should also store wallet addreses, as admins we want
  to be able to see what are the wallet addresses linked to a user … It's ok to show wallet addresses for partners by
  default, but as usual email will be hidden from partners by default (until users explicitly approve this), but admins
  need to be able to see both email and wallet addresses … we want our end user experience similar to what Privy
  provides', then 'go' on the five points below) · Built on `feat/wallet-directory` (not merged, not deployed; hot-DB
  migration 0011 not applied anywhere): the record statement and its verifier (`packages/core/src/wallet-record.ts`,
  D311), the vault's background report (`packages/web/src/vault/wallet-record.ts`, `vault.ts` `recordWallets`, D317),
  `POST /v1/wallets/record` (`apps/api/src/directory/record.ts`, D313), migration `0011_wallet_directory.sql`
  (`end_users`, `end_user_wallets`, `end_user_identities`), the identities kept current after `/v1/login` and the link
  relays (`directory/sync.ts`, D314), `AdminRpc.listUsers` / `getUser` / `findUsers` and `ConsoleRpc.listUsers` /
  `getUser` (`directory/read.ts`, D315), the user id and Support ID (`packages/console-core/src/users.ts`, D312), and
  `admin user:list` / `user:find` with wallets, `--address` and `--user` (`scripts/lib/admin-users.ts`, D316); no UI
  (C8b and C10 build the screens) · Extends D269; informs D275 (the staff Users screen) and the partner console's
  Users screen (C10)
- Decision:
  1. **A user** is one account in one scope: the root identity and its linked identities (D133). Wallets are per scope,
     so one person in two orgs' scopes is two users; staff can group them by email.
  2. **User id**: a stable opaque id per scope (Privy's `cmvq…` equivalent), shown to partners and staff; the
     `HANA-XXXX-XXXX` Support ID (D276) is its short form.
  3. **Wallet addresses**: after each successful login the vault reports the wallet's Stellar (`G…`) and EVM (`0x…`)
     addresses in the background, each with a signature by that chain's key over a domain-separated statement (scope,
     path, chain, address, session) that can never be a valid transaction on either chain; the API verifies and stores
     them in its hot DB, never failing or slowing the login. "Last used" is the last login that opened the wallet, not
     on-chain activity.
  4. **Linked accounts** (provider kinds per user) are kept current as links are made and removed.
  5. **Who sees what**: staff (admin console, CLI) see email (D269, from the issuer's directory), connected accounts,
     wallets, user id, created and last seen. Partners (partner console, for their own org's scopes only) see the user
     id, created and last seen, connected account kinds ("Google", "Email") without any address or Google account id,
     and the wallet addresses. Partners see an email address only once a user approves (UX later).
- Gaps accepted: no backfill (a user appears with wallets at their next login); the partner Users screen needs C9/C10
  and the M4 setup, the staff one D275 and C8; a partner on its own Google client can read emails through Google (D42);
  on-chain activity is not indexed.
- Rejected: recording addresses on chain (anyone could map Google accounts to wallets publicly); unsigned reports (a
  caller could attach any address to any user); partners seeing emails by default.

### D311. The wallet record: ECDSA and Ed25519 over a `hana-id/wallet-record/v1` statement, the identity proof's scheme
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`packages/core/src/wallet-record.ts`, `test/wallet-record.test.ts`) · Source: D310 point 3, D179
- Decision: each address is proven by its own key over
  `"hana-id/wallet-record/v1" ‖ 0x00 ‖ borsh(env) ‖ borsh(signer) ‖ borsh(app_id) ‖ borsh(scope_id) ‖ borsh(path) ‖
  borsh(chain) ‖ borsh(address) ‖ session_pk(32) ‖ u64le(issued_at_ms)`: Stellar, Ed25519 over the statement itself;
  EVM, secp256k1 ECDSA (RFC 6979, low s, `r ‖ s ‖ v`) over `sha256(statement)`, the identity wallet proof's scheme
  (D127). The prefix starts with `hana-id`, so the vault's D179 raw refusal covers it with no new rule, and the 0x00
  ends it, so no other Hana message is a statement. The app id is in it too, beside what D310 lists.
- Why it is never another signature (argued in the module's header, each point tested): Stellar transactions, Soroban
  auth entries and SEP-53 sign a 32-byte hash and Ed25519 binds the exact message, which is always longer; EVM
  transactions, EIP-191 and EIP-712 sign a keccak256 digest, ours is a sha256 digest (a cross-hash second preimage);
  the approval flow's non-raw kinds sign those same hashes; a raw Stellar request starting `hana-id` is refused before
  any popup (D179).
- Accepted residual (D179's, by construction): a raw EVM request is any 32-byte digest, and every ECDSA proof is a
  signature over one. The vault refuses its own session's record digest (D317), but a user who approves a raw EVM
  signature over a digest an attacker computed for the attacker's own session can let the attacker list that EVM
  address under the attacker's own user. That user approval already authorizes any transaction from the key (the popup's
  red warning); raw signing is off by default, a guarded change, never auto-approved and refused for test apps; the row
  is only ever under the attacker's own user; an address under more than one user is shown so (`sharedWith`, the CLI's
  warning).
- Rejected: a BIP-340 Schnorr signature with the EVM key for a strict "never" (no ECDSA raw signature is a Schnorr one):
  using one secp256k1 key for ECDSA and Schnorr has no proof of joint security, and Bitcoin's designers advise keeping
  them apart with a hardened derivation step (bitcoin-dev, P. Wuille), so it would trade a bounded bookkeeping residual
  for an unproven risk to the funds key; a separate record key (a new derivation tuple: it proves nothing about the
  wallet's own key); a session-key signature alone (it proves the session, not the address).
- **Amended 2026-11-04 (security review finding, MEDIUM; branch `feat/user-id-identity-sub`): a session-key signature
  is now required too.** The chain-key proofs alone don't tie an address to the path: the API can't derive addresses,
  and a session public key is public (`get_session`), so anyone could sign a statement with their own Stellar or EVM
  key naming a victim's live session key and path, pass the session check, and have their address listed as the
  victim's wallet (a wrong payout address for a partner that trusts the list). The vault now also signs, with the
  session's non-extractable WebCrypto key, `"hana-id/wallet-record-session/v1" ‖ 0x00 ‖ borsh(env) ‖ borsh(signer) ‖
  borsh(app_id) ‖ borsh(scope_id) ‖ borsh(path) ‖ session_pk(32) ‖ u64le(issued_at_ms) ‖ sha256("hana-id/wallet-record-
  proofs/v1" ‖ 0x00 ‖ for stellar then evm: borsh(chain) ‖ borsh(address) ‖ borsh(Vec<u8> signature))` (Ed25519 over
  the message itself; core `walletRecordSessionMessage`, `signWalletRecordSession`, `verifyWalletRecordSession`, zip215
  off). It covers every field of the body and the env, signer, app and scope the API supplies. It is never another
  session-key signature, nor another one it: the session key signs only the contract's `"hana-id-session-v1:"`
  messages, the vault share actions' `"hana-id-vault-v1:"` and the identity token's `"hana-id-identity-v1:"`, fixed
  layouts the vault builds itself (it never signs caller-chosen bytes with that key); this domain differs from each in
  its first 8 bytes and none is a prefix of another, and Ed25519 binds the exact message (tested in
  `packages/core/test/wallet-record.test.ts`). The chain-key proofs stay: the session signature proves the vault, the
  chain-key ones that it holds those keys. D311's raw-EVM residual is unchanged (the attacker still needs its own
  session's key, so the row stays under its own user).

### D312. The user id is the usage ledger's uid, `hu_` + Crockford base32; the Support ID is its first 8 characters
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`packages/console-core/src/users.ts`, `apps/api/src/directory/store.ts` `directoryUser`) · Source: D310 point 2,
  D96, D144, D276
- Decision: a user's id is deterministic: the uid (`HMAC-SHA256(USER_ID_KEY, "hana-id/uid/v1" ‖ borsh(scope) ‖
  borsh(root provider) ‖ borsh(root sub))[0..16]`, console-core `uid`, the ledger's pseudonym, D96) of the account
  root of the session's path, written `hu_` + the 26 lowercase Crockford base32 characters of its 16 bytes. The
  Support ID `HANA-XXXX-XXXX` is the first 8 of those characters, uppercase: exactly the uid's first 40 bits (5 bytes),
  so it is the user id's short form and D276's code at once. The hot DB stores it as `end_users.support_code`
  (indexed), so code → user is one read. No new secret; without `USER_ID_KEY` nothing is recorded
  (`directory_unavailable`).
- Why: the same login always lands on the same row (no lookup-then-insert race between the record and the login's
  sync), staff can join a user to its ledger events by uid, and D276's Support ID needs no table of its own.
- Rejected: a random id stored per root (a read before every write, a race on the first two writes, and a Support ID
  unrelated to the ledger); the identity token's `sub` (D276 (b): a second pseudonym the ledger doesn't use. Partners
  can still join console rows to their backends' tokens by wallet address, which both carry); a new HMAC key (another
  secret to keep for the same job).
- Note: a partner sees the user id and the Support ID (D310 point 5), a per-scope pseudonym like the token's `sub`.
  `USER_ID_KEY` must never be rotated within a contract term (D224): a new key is a new id for every user.
- **Amended 2026-11-04 by D346:** `hu_…` is now the **internal id**, staff only (the row's key and the join to the
  ledger). The id partners see ("User ID") is the identity token's `sub` (`u1_…`, `end_users.token_sub`), and the
  Support ID is cut from that, no longer from `hu_…`. The rejection of the token's `sub` above is reversed: partners
  wanted one id, the one their backends already store (Privy's DID).

### D313. `POST /v1/wallets/record`: the vault gate, the records, the session on that exact path; no session-key signature
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`apps/api/src/directory/record.ts`, `test/wallet-directory.test.ts`) · Source: D310 point 3
- Decision: the endpoint takes `{sessionPublicKey, issuedAtMs, path, wallets: {stellar, evm}}` (≤ 4 KiB) from the vault
  origin only (the vault gate and `vaultLimits`, as `/v1/vault/*`), refuses a statement time outside ±5 min
  (`stale_record`), a path outside the app's scope, a record that doesn't verify (`bad_wallet_record`), an env without
  `USER_ID_KEY` (503 `directory_unavailable`), then reads the session as the identity token does (`checkChainSession`:
  live, the app's scope, re-read fresh before refusing, `410 session_ended`) and requires its path to be exactly the
  record's (`403 session_mismatch`). One D1 batch writes the user, both wallets (per user: an address may be under two
  users) and the root's identity row; times only move forward (MIN/MAX), so a replay changes nothing.
- No session-key signature and no single-use marker: each chain key's signature already binds the session key, and the
  chain binds the session to the path; a replayed request rewrites the same rows with the same times. Not paused-gated:
  it relays nothing.
- `HOT_DB_SCHEMA` stays 9: an API on a database without 0011 still serves every login; only the record answers 503
  (`directory_write_failed`, logged `no_table`) and the syncs log the same.
- **Amended 2026-11-04 (security review finding; branch `feat/user-id-identity-sub`):** "no session-key signature" was
  wrong: a chain key's signature binds a session key it names, not one its signer holds, so anyone could attach their
  own address to a victim's live session (D311's amendment). The body now carries `sessionSignature` (64 bytes, D311's
  session message) and the endpoint checks it against `sessionPublicKey` right after the chain-key records and before
  any key check, chain read or write (`401 invalid_signature`; a missing or malformed one is `400 bad_request`). Still
  no single-use marker: a replay within ±5 min rewrites the same rows, outside it is `stale_record`.
- **Amended 2026-11-04 by D346:** `directory_unavailable` also when `IDENTITY_SUB_KEY` is missing or malformed (the
  User ID and Support ID come from it); the log's `code` says which (`no_user_id_key`, `no_sub_key`, `bad_sub_key`).

### D314. Identities kept current from chain reads after the API's own relays; one row per identity per scope
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`apps/api/src/directory/sync.ts`, `links.ts`, `login.ts`, `session-standing.ts` `confirmed`) · Source: D310 point 4
- Decision:
  - After a successful link relay (`/v1/link`, `/v1/link/cancel`, `/v1/link/unlink`) the API reads the account root's
    `get_account` fresh and rewrites the account's rows from it: the root, each member (active, or pending with its
    `effective_at`), and members no longer listed marked `unlinked` or `cancelled` (the relay's own action wins for its
    member). The request only lends the subs its verified tokens carried; the chain lists members by key and provider.
  - After a successful `/v1/login`: with a link, a fresh `get_identity` of the session identity, then its account, as
    above; without one, the login's own standing read (no extra chain read): the user's last seen, the root's row, and
    a member's own row (a member that logs in is active). A standing that is only the fail-open guess (the read failed,
    `confirmed: false`) writes nothing.
  - Rows are keyed by (scope, identity key), so a member that leaves one account and joins another moves; a write only
    lands when its chain read is no older than the row's (`observed_at`). A pending member reads as active once
    `effective_at` passes (at read time). A member Hana saw only on chain (a link made by calling the contract
    directly) has a NULL sub until it logs in through Hana.
  - Everything runs after the answer (`waitUntil`) and never fails or slows the request.
- Rejected: trusting the request's view of the account (a relay that later fails, or another caller's change between
  the precheck and the relay, would be stored); a read per plain login (an RPC call on every login for a state the
  standing read already has).

### D315. The read APIs: staff get identities with subs; partners get their own org's users with kinds and wallets only
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`apps/api/src/directory/read.ts`, `rpc/admin.ts`, `rpc/console.ts`, console-core `users.ts`) · Source: D310 point 5,
  D275
- Decision:
  - `AdminRpc.listUsers({orgId?, scopeId?, cursor?, limit ≤ 200})`, `getUser({userId})`, `findUsers({query,
    provider?})` (a wallet address, a user id, a Support ID, or a sub; `provider` makes it a sub search): `StaffUser`
    with each identity's provider, sub, identity key, role, status and times, each wallet's key index and `sharedWith`.
    The email's join point is each identity's `directoryKey` `{provider, sub}`, for D275's `DirectoryRpc` in the admin
    Worker; the API never reads the issuer.
  - `ConsoleRpc.listUsers({orgId, scopeId?, search?, cursor?, limit ≤ 100})` and `getUser({orgId, userId})`: only users
    of scopes whose `scopes.org_id` is the org; `PartnerUser` is the user id, Support ID, scope, created and last seen,
    the account kinds active or pending, and the wallets. The query never selects a sub or an identity key. A search
    may be a wallet address, a user id or a Support ID; a sub is refused (`bad_request`), so a partner can't test whether
    a Google account is a user. Another org's user is `not_found`, exactly as no user. Each call is one SELECT (cost 1).
  - Pages are newest first by last seen, with a `lastSeenAt:userId` cursor.
- Rejected: one shape for both with fields blanked (one mapping bug away from a sub reaching a partner).
- **Amended 2026-11-04 by D346:** `userId` in both shapes is now the User ID (`u1_…`, the identity token's `sub`);
  `StaffUser` adds `internalId` (`hu_…`); `PartnerUser`'s keys are unchanged and its query never selects
  `end_users.user_id`. `getUser` takes `{userId}` (u1_) on both, or `{internalId}` (hu_) for staff, exactly one;
  `findUsers` also takes an internal id (any case). A partner's search by an internal id is `bad_request`, as a sub is.
  Pages tie by User ID, so the cursor is `lastSeenAt:u1_…` (no internal id in a partner's hands).

### D316. The admin CLI reads the wallet directory without the statement in a process argument
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`scripts/lib/d1.ts` `apiPrivateD1Execute`, `scripts/lib/admin-users.ts`, `scripts/admin.ts`) · Source: D269's CLI
  rule, D310 point 5
- Decision: the hot DB now holds subs and wallet addresses, so `user:*` read it as they read the issuer's D1: locally a
  0600 file in `.secrets/tmp/` passed as `--file`, remotely D1's REST query endpoint, wrangler's log file off, errors
  never quoting the statement. `user:list` / `user:find --email|--sub` add each identity's user id, Support ID, role and
  the account's wallets per scope; `user:find --address <G…|0x…>` (every user listing the wallet, a warning when there
  are several) and `--user <hu_…|HANA-XXXX-XXXX>` start from the wallet directory and join each identity's address from
  the issuer when the env has one (they also work without one); a stdin line is read as whichever it is. The other
  app commands keep `wrangler --command` (their statements hold no personal data).
- **Amended 2026-11-04 by D346:** every user line shows all three ids (`u1_… (HANA-XXXX-XXXX; internal hu_…)`), and
  `--user` takes `u1_…` (exact case), `hu_…` (any case) or a Support ID.

### D317. The vault reports the wallet once per login, in the background, with a 15 s limit and no retry
- Date 2026-11-04 · Status: to confirm (decided while building D310) · Built on `feat/wallet-directory`
  (`packages/web/src/vault/wallet-record.ts`, `vault.ts` `recordWallets`, `test/vault/wallet-record.test.ts`) · Source:
  D310 point 3
- Decision: when `finishLogin` adopts a new session (the login succeeded and its key passed the pairing check), the
  vault signs both records with PRK on a 0 ms timer right after (so the signatures never delay the login's result;
  nothing if the session already ended or went dormant), each chain key inside `withChainKey` and zeroed, for the session's
  path (a linked member's is its account root's) and its server-corrected clock, and starts `POST /v1/wallets/record`
  without awaiting it: one call, aborted after 15 s (`WALLET_RECORD_TIMEOUT_MS`), every failure dropped silently, no
  retry (the next login writes the rows; the rows are upserts). Never at an unlock or a reload: "last used" is the last
  login (D310). The session keeps the record's EVM digest and refuses a raw EVM request for it (D179's rule, D311).
- Rejected: awaiting it (a slow API would slow every login); retrying (a storm against an API that is down, for rows
  the next login writes); sending it from the export window (its login opens no wallet session).
- **Amended 2026-11-04 (security review; D311 and D313 as amended):** after the two chain keys sign (synchronously,
  PRK checked live first), the session key signs the whole request (`signWalletRecordSession`, asynchronous WebCrypto);
  the record's EVM digest is set on the session before that first await, and nothing is sent if the session changed
  meanwhile.

## Partner User ID = the identity token's `sub`; the Support ID its short form (branch `feat/user-id-identity-sub`), 2026-11-04

### D346. Partners see one user id, the identity token's `sub`; the Support ID is its first 40 bits; `hu_…` is internal
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: "ok go with your recommendation") · Built on
  `feat/user-id-identity-sub` (not merged, not deployed; hot-DB migration 0011 still applied nowhere) · Amends D276,
  D312, D313, D315, D316 · Source: the wallet directory review (D310–D317), Privy's DID
- Decision:
  1. **User ID** (what partners see, like Privy's DID) is the identity token's `sub`: `"u1_" ‖ b64url(HMAC-SHA256(
     IDENTITY_SUB_KEY, "hana-id/idt-sub/v1" ‖ 0x00 ‖ borsh(scope_id) ‖ borsh(root_provider) ‖ borsh(root_sub))[0..16])`,
     computed with core `identitySub` (the token's own code, not a copy). The value the partner's backend already
     stores from the token. Used in `ConsoleRpc.listUsers` / `getUser` (field `userId`), their search and the partner
     console. Stored as `end_users.token_sub` (unique index).
  2. **Support ID** is the User ID's short form: `"HANA-" ‖ c[0..4] ‖ "-" ‖ c[4..8]` with `c` = Crockford base32
     (alphabet `0123456789ABCDEFGHJKMNPQRSTVWXYZ`, most significant bit first) of the first 5 bytes (40 bits) of the
     same 16 HMAC bytes the User ID encodes. 8 characters exactly, no padding, D276's format kept. Anyone holding a User
     ID can compute it without a key (decode the 22 base64url characters, take 5 bytes): a partner can show it next to
     its own user records. It is not a visible prefix of the `u1_` text (base64url and base32 split the bits apart).
     Pinned against the identity token's vectors (`packages/console-core/test/users.test.ts`: `u1_EcoIFjT5lAWZsk0862e8Tg`
     → `HANA-2750-G5HM`). Stored as `end_users.support_code` (indexed); console-core `supportIdOf(userId)`.
  3. **Internal id** `hu_…` (D312's, the usage ledger's uid under `USER_ID_KEY`) stays: the hot DB's key and the
     join to the ledger's events. Staff only: `AdminRpc` (`StaffUser.internalId`, `getUser({internalId})`,
     `findUsers`) and the CLI. Never in a `ConsoleRpc` answer, cursor or accepted input (a search by it is
     `bad_request`, as a sub's is).
  4. **Staff** (`AdminRpc`, `admin user:*`) see all three and search by any of them.
  5. **Without `IDENTITY_SUB_KEY`** (missing or malformed) nothing is recorded, as without `USER_ID_KEY`: the record
     answers `503 directory_unavailable`, the login syncs write nothing, the log says which key (`no_sub_key`,
     `bad_sub_key`, `no_user_id_key`). A row without the id partners see would be a user the console can't name. Every
     env that mints identity tokens has the key already (D127).
- Why: one id across the token, the console and support, so a partner never maps between two pseudonyms; D312's
  reason for `hu_…` (joining the ledger) holds for staff, who keep it.
- Main trade-off: the Support ID now needs a directory row to resolve (the ledger keys on `hu_…`, so a code no longer
  is a prefix of a ledger uid): a user who hasn't logged in since the directory's deploy has no resolvable Support ID
  (D276's ledger-only fallback is gone). The 40 bits collide as before (every match listed).
- Rejected: keeping `hu_…` as the partner id (D312's choice: two pseudonyms for one user at the partner); a Support ID
  from `hu_…` beside a `u1_` User ID (a partner could not compute it from what it stores); a new key for the code.
- Not changed: wallet derivation, paths and every address (the ids are computed from the root identity, beside it).
  `IDENTITY_SUB_KEY` and `USER_ID_KEY` are never rotated (D127, D224): a new one would be new ids for every user.
- Not built: the vault and popup don't show a Support ID yet (D276 planned it in `hana_status` and the popup's account
  view, from the API's session answers); when built it must come from the API (`supportIdOf(sub)`), never be derived
  anywhere else.
- RPC change for C10: `PartnerUser.userId` is now `u1_…` (same key, new value); `ConsoleRpc.getUser({userId})` takes
  `u1_…`; the page cursor is `lastSeenAt:u1_…`. `StaffUser` adds `internalId`; `AdminRpc.getUser` takes `{userId}` or
  `{internalId}`.

## Batch C11: the files Worker and logos (branch `feat/batch-c-11`), 2026-11-04

Readings of `docs/batch-c-spec.md` ("Other app settings, name and logo", "R2", "Response headers", "Login-path reads")
made while building C11, where the spec is silent or loose. Each took the safer reading.

### D300. The logo upload takes a raw `application/octet-stream` body: the one exception to the console's JSON-only CSRF rule
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/csrf.ts` (`bodyTypeFor`,
  `LOGO_UPLOAD_PATH_RE`), `src/logo.ts` `logoUploadRoute`
- Decision: the spec has the upload as a raw body, but also says that every non-GET request needs `content-type:
  application/json`. So `POST /api/orgs/:org/apps/:app/logo` needs exactly `application/octet-stream`, and every
  other path keeps JSON. The other three CSRF checks apply unchanged. The image's type comes from its magic bytes,
  never from the header. The request also needs:
  - a `Content-Length` (a chunked body is refused: `bad_request`);
  - `?expectedVersion=<settingsVersion>`, the CAS of the screen the owner saw (the spec gives the raw body no place
    for it);
  - and it answers `{logoUrl, version}`: the spec's `{logoUrl}` plus the new version for the next write.
- Why: `octet-stream` isn't a CORS-safelisted type, so a cross-site page still can't send it without a preflight
  (which the console never answers). The check keeps its purpose; only the type differs.
- Rejected:
  - the image as base64 inside JSON: +33% on a 512 KiB cap, and the spec says raw;
  - `image/*` types: they are just as non-simple, but they invite trusting the header;
  - reading the version inside the request (getApp only): that turns the CAS into "last writer wins" for the owner.

### D301. Upload order: cheap checks, the decoder's `info`, then `getApp`, then the paid transform; the replaced logo is the one at the CAS version
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/logo.ts`, `src/cron.ts`
  `purgeLogos`, `src/limits.ts` (`logo`)
- Decision:
  - **Order.** First the bytes (size, magic bytes, container; D302), then `IMAGES.info` (type, size, shape), then
    `ConsoleRpc.getApp`. getApp refuses another org's app or a deleted one (`not_found`) and a stale screen
    (`version_conflict`) before any transform, and it names the logo being replaced. After that come the transform
    and the output checks (D303). Then the `logo_objects` row (upserted, `replaced_at = NULL`), then `LOGOS.put`
    (`image/png`, with R2's own sha256 check), then `ConsoleRpc.setLogo` at the same `expectedVersion`.
  - **Replaced object.** Only after `setLogo` succeeds is the key getApp named at that version marked
    `replaced_at = now`. The CAS makes it exactly the key the pointer left, so two quick uploads can never mark the
    current logo. Re-uploading the current image changes nothing (no version, no `app_changes` row).
  - **Failures after the put** (a `setLogo` refusal) leave one object with an unmarked row: storage only, never a
    broken logo. The outcome is audited (`app.logo_set` / `app.logo_removed`, `failed` with the code). A key isn't
    marked on failure, since a concurrent upload of the same image could make it current.
  - **Purge order** (amends C7's `purgeLogos`). It deletes the due rows first (`DELETE … RETURNING`, only while
    still marked and past 30 days), then those objects. If the object delete fails, it puts the rows back
    (`INSERT OR IGNORE`, so an upload in between wins), and the next hour retries. Whatever the timing, an upload
    that un-marks a key keeps both the key and its object. One narrow window remains: an identical re-upload whose
    `put` lands between the purge's row delete and its object delete. That loses the object, the files Worker
    answers 404, the page shows the name alone, and a new upload repairs it.
  - **Limit.** Uploads are capped at 10 a minute per org, on the console's existing rate-limit binding
    (`console-logo:<org>`). Each upload is a paid transform. The ConsoleRpc budget applies as well (getApp 4 +
    setLogo 4 statements).
  - **Removal** (`removeAppLogo`, `logoRemoveRoute`): getApp, then `setLogo(null)`, then the old key is marked. The
    spec lists no removal route: C10 wires the control.
- Rejected: `setLogo` returning the previous key (one RPC fewer, but a stale or foreign app is refused only after the
  transform and the put); marking every other object of the app on success (a race can mark the current logo);
  objects first in the purge (C7's order: an un-mark between the select and the delete loses the current logo).

### D302. "Polyglot" means anything that isn't exactly one static image of the type its magic bytes name
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/logo-format.ts`
- Decision: an upload is refused `logo_type` when:
  - there are bytes after the format's own end (PNG's IEND, JPEG's EOI, the WebP RIFF size);
  - a PNG chunk's CRC is wrong, the first chunk isn't IHDR, there is no IDAT, a JPEG has no scan or no EOI or has
    two frames, or a WebP's first chunk isn't VP8/VP8L/VP8X;
  - it is animated (APNG `acTL`/`fcTL`/`fdAT`, WebP's animation flag or `ANIM`/`ANMF`);
  - the decoder (`IMAGES.info`) reports another type, or another size than the header, except that a JPEG's sides
    may be swapped (EXIF orientation).
  This adds to the spec's magic-bytes rule (SVG, GIF, AVIF and anything else refused) and its size bounds. JPEGs
  with trailing data (some phone pictures append a second image) are refused too.
- Why: the stored file is re-encoded anyway, but the spec asks for polyglots to be refused. "The file ends where its
  format says" is a rule that can be checked without decoding pixels. An animated logo would otherwise be silently
  flattened to its first frame.
- Rejected: scanning for markup (`<script`, `<svg`) inside the file (easy to evade, and it refuses benign text
  chunks); passing animated files with `anim: false`.

### D303. The re-encode: Images `fit: 'pad'` on transparent, PNG, then the console strips the output to its image chunks
- Date 2026-11-04 · Status: decided while building, to confirm at milestone M5 against the real binding ·
  Built: `apps/console/src/logo.ts` (`LOGO_TRANSFORM`, `LOGO_OUTPUT`, `reencode`), `src/logo-format.ts` `stripPng`
- Decision:
  - The spec's "fit contain, transparent padding" maps to `{width: 256, height: 256, fit: 'pad', background:
    'rgba(0,0,0,0)'}`. Cloudflare's `contain` doesn't pad, so it would give a non-square image. The output is
    `{format: 'image/png', anim: false}`.
  - The answer must be `image/png`, and the console's own parser must read it as one well-formed static PNG of
    exactly 256 × 256. Then it is cut to IHDR, PLTE, tRNS, IDAT and IEND: no text, EXIF, ICC, time or size
    chunks, whatever the encoder keeps.
  - The result must be ≤ 128 KiB (else `logo_too_large`) and decode again through `IMAGES.info` as a 256 × 256 PNG.
    An output that fails any check is `logo_type`.
  - The object key is the sha256 of these stored bytes.
- To confirm at M5: that `pad` with that background really pads with transparency on the real binding (the tests use
  a fake Images binding, as the spec says).
- Rejected: trusting the encoder to drop metadata (the binding's types have no metadata option); keeping `sRGB` /
  `gAMA` (colour hints, not personal data, but nothing needs them in a 32 px logo).

### D304. The files Worker re-checks each object more than the spec asks, and answers errors uncached
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/files/src/index.ts`, `src/rules.ts`
- Decision:
  - The spec checks that the object exists, has `contentType` `image/png` and starts with the PNG signature. The
    files Worker also requires the object to be ≤ 128 KiB and its sha256 to equal the hash in its key: a key is
    content-addressed, so any other bytes are a write the console never made.
  - It reads only `LOGOS.get`, a source test enforces that, and it never writes.
  - A logo answers exactly the spec's seven headers plus `content-length`. HSTS isn't one of them, so it isn't sent.
  - Everything else answers plain text with `nosniff`, `default-src 'none'; sandbox`, `no-referrer` and
    `cache-control: no-store`, because a 404 must not be cached: the logo may appear later. That covers a 404 (any
    other host, path or object), a 405 with `allow: GET, HEAD`, a 503 when R2 fails, and a 500.
  - A query string is ignored. Refusals log a code, never a key.
- Why: "logos are re-checked by the files Worker" (threat table, compromised console). The hash check costs one
  sha256 of at most 128 KiB.
- Rejected: streaming the body unchecked; sending HSTS (the spec lists the headers exactly).

### D305. The auth pages get the logo from GET /v1/app through the vault's messages, never the inlined config
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/src/handlers.ts`
  (`handleAppConfig`), `packages/core/src/logo.ts`, `protocol.ts`, `packages/web/src/vault/{vault,login,approvals}.ts`,
  `src/auth/{logo,login-page,email-page,email-storage,approve-page,export-page}.ts`
- Decision:
  - `GET /v1/app` always carries `logoUrl`: `<FILES_ORIGIN>/<logo_key>`, or `null` when the app has no logo or the
    env has no files origin. Older clients ignore it, and `isAppConfig` doesn't check it: a logo is decoration and
    is checked where it is shown.
  - The vault takes it from its own `GET /v1/app` only when it is this app's logo on the build's `filesOrigin`
    (`logoUrlOn`). It passes it as an optional `logoUrl` in `hana:auth-params` (from the login's own read),
    `hana:approve-request` / `hana:consent-request` and `hana:export-context` (from its latest read). The field is
    present only when there is a logo.
  - The protocol takes only the logo URL shape: canonical http(s), the logo path, no query, fragment or
    credentials. The login page passes it on to the email step's stored context.
  - The pages that show the app's name show the logo beside it: `/login` (the chooser), `/login/email`, `/approve`
    (request and consent) and `/export`, which prefers its own `GET /v1/app` answer, as it does for the name.
  - A page shows the logo only from its build's `filesOrigin`, `alt=""` (the name is the text), and removes it if it
    fails to load. `/login/callback` shows no app and gets nothing.
- Why: the vault config inlined by the API is checked with exact keys, so a new key there breaks every vault bundle
  older than the API (a deploy-order hazard for every app with a logo). The optional message field has no such
  hazard. An app without a logo sends exactly batch B's messages, so pages and API can deploy in either order.
- Rejected: inlining `logoUrl` in the vault config (above); each popup fetching `GET /v1/app` itself (the login and
  approval popups fetch nothing, D77); refusing a config or a message over a bad logo value (a login would fail
  over decoration).

### D306. `FILES_ORIGIN` joins `img-src` in place, on the logo pages only, in both policies; a malformed value is left out
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `packages/web/src/auth/pages.ts`
  (`LOGO_PAGES`, `imgSources`, `authPageMetaCsp`), `apps/api/src/pages/host.ts` (`AUTH_LOGO_PATHS`, `FILES_ORIGIN`),
  `src/vault/page.ts` `pageHeaders`, `scripts/pages-wrangler.ts`, `packages/web/scripts/gen-envs.ts` (`filesOrigin`)
- Decision:
  - The base policy's `img-src 'self' data:` gets the files origin appended in place, never as a second `img-src`,
    which a browser ignores. This happens in the Worker's header policy (`FILES_ORIGIN`, from the manifest's
    `files.origin` through `pages-wrangler`) and in the build's `<meta>` policy (`HanaEnv.filesOrigin`, from the same
    field through `gen-envs`).
  - It applies to `/login`, `/login/email`, `/approve` and `/export` only. An env without the dashboard blocks keeps
    batch B's policies byte for byte.
  - A test in `apps/api` builds both policies for every page, with and without a files origin, and requires the same
    directives (frame-ancestors aside).
  - If `FILES_ORIGIN` isn't an origin, the header leaves it out and logs `files_origin_misconfigured`. The page
    still works, with the stricter policy: unlike the email issuer's URL, the logo isn't needed for the page to work.
- Rejected: adding the origin to every auth page (the callback shows no image); a 503 for a malformed value (a login
  failing over a logo).

### D307. The files Worker's placement follows `files.origin`, like the page Workers; on workers.dev it must be its own name
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/files/scripts/gen-wrangler.ts`
- Decision:
  - A `<files.workerName>.<subdomain>.workers.dev` origin is allowed in `local*`/`sandbox*` envs only (D93), with
    `workers_dev: true`. Any other https host gets a Custom Domain route. A loopback origin is `wrangler dev`'s.
  - Preview URLs are always off.
  - The config is `LOGOS` and `FILES_ORIGIN` only: no secret, D1, Hyperdrive, service, assets or cron (snapshot
    tests, and the console's cross-Worker test: only the console and the files Worker bind the logo bucket, only
    the console binds Images).
  - `gen` refuses a workers.dev hostname whose first label isn't `files.workerName`, since that label is the
    Worker's name there.
- Rejected: a route on the API Worker (D66: one thin Worker per extra Hana origin).

### D308. R2 rules: the `STATEMENTS` lock covers the whole bucket for 2557 days; the `EXPORTS` lifecycle applies to `exports/`, which C12 writes under
- Date 2026-11-04 · Status: decided while building, to confirm · Written: `docs/operations.md` "Files Worker and
  logos" (setup step 7)
- Decision:
  - `STATEMENTS` gets one bucket-lock rule with an empty prefix (every object) and `--retention-days 2557`: 7 years,
    with the leap days. Statements are deleted by hand after review once it ends (D90).
  - `EXPORTS` gets one lifecycle rule `--expire-days 30` on the prefix `exports/`. R2's lifecycle conditions are
    prefix-include only, so "everything except `legacy/`" can't be written as one rule. The on-demand ledger CSVs
    (C12) must therefore be written under `exports/`. The legacy export (C4b) stays at `legacy/usage-<env>.csv`,
    outside the rule.
  - No rule on `LOGOS`: the console's cron deletes replaced logos (D301).
- Rejected: one lifecycle rule on every prefix (it would delete the legacy export after 30 days); per-object
  expiry set by the admin Worker (R2 has none; a cron job would be one more thing to fail).
- **Amended by D402 (2026-11-05, agreed by the user):** the lock's retention is per env: 1 day on sandbox-dev, 2557
  days in production.
## Batch C9: partner sign-in (branch `feat/batch-c-9`), 2026-11-04

Readings of `docs/batch-c-spec.md` "Partner sign-in" taken while building C9, each the safest one found. All: Status
decided while building, to confirm.

### D290. The console holds every Google token it verifies to the claim allow-list by scope; sign-in may add exactly email, email_verified, hd and at_hash
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: "accept both, go ahead with C10"; the sign-in token
  stays `openid email`, every relayed or step-up token is held to the allow-list). `at_hash` moved into the allow-list
  itself (D342), so sign-in's extras are now `email`, `email_verified` and `hd` · Built on `feat/batch-c-9`
  (`apps/console/src/auth-token.ts` `verifyConsoleToken`, `allowedClaims`; `apps/api/scripts/test/relayed-tokens.test.ts`
  "Google tokens the console verifies") · Source: D271, D274, D277, spec "Code flow" ("Email claims by scope")
- Decision:
  - `scope=openid` (every step-up and owner action, batch C10, which the API verifies again and relays on chain):
    exactly the API's `TOKEN_CLAIM_ALLOW_LIST`, nothing else (`claim_not_allowed`, the claim named in the log).
  - `scope=openid email` (sign-in only): the same list plus exactly `email`, `email_verified`, `hd` and `at_hash`; a
    `name`, `picture`, `locale` or any other claim is refused; `email` and `email_verified === true` are required;
    `at_hash` must equal the hash of the access token returned with the ID token (checked, then the access token is
    dropped). The sign-in token is never relayed, stored, logged or returned: only the verified `sub`, address and `hd`
    go on, into the 60-second handoff row (D291).
  - The API's source scan now also lists the console: only `console/src/auth-token.ts` calls `verifyIdToken`, the
    allow-list follows it with no option to skip, its openid list equals the API's and core's, and every caller passes
    the flow's own scope; console-auth verifies nothing.
- Why the sign-in token isn't openid-only: the spec's membership rules need the address (an invite is bound to the
  address it was sent to, so a forwarded link is useless to anyone else; members see each other's address; owners get
  notices there) and `hd` (an org's `required_hd`), and Google puts them only in an `openid email` ID token. An
  openid-only sign-in would make the invite link a bearer token and `required_hd` unenforceable. `CONSOLE_DB`'s own
  CHECK (0001) already fixes a login flow's scope to `openid email`. The address is a partner member's (staff of the
  org), never an end user's (D269 untouched).
- **To confirm with the user:** the build brief said "the console token must be openid-only". Read here as every
  console token that is relayed or used for a step-up (C10); the sign-in token keeps the spec's `openid email`. If the
  user wants sign-in openid-only too, the price is the two properties above (or a second Google request for the address,
  D270-style), and migration 0001's CHECK needs a new migration.
- Rejected: one list for both scopes (sign-in would fail, or step-ups would accept an address); ignoring `at_hash`
  (checking it costs nothing and binds the two tokens of one answer).

### D291. The membership rules run at `/api/auth/complete`; the handoff row carries the verified identity, scrubbed when used; the state is derived from the start handle
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9`
  (`apps/console/src/auth-flow.ts` `flowState`, `callback`; `sign-in.ts` `completeSignIn`)
- Decision:
  - The callback (auth origin) verifies the token and writes the handoff row; the membership rules and invite
    acceptance run at `/api/auth/complete` (console origin) after the pre-flow cookie matched (spec step 4). So an
    invite is consumed only by a flow bound to one browser from start to finish: `__Host-hana_pre` (create → complete)
    and `__Host-hana_af` (start → callback).
  - The handoff's `result_json` is therefore `{provider, sub, email, hd}` (the spec's comment says "user id, invite
    outcome"): never a token. It is overwritten with `{}` in the request that uses it; an unused one is purged by the
    hourly cron 24 h after its 60 s. The PKCE verifier is overwritten in `auth_flows` as soon as the callback consumed
    the flow.
  - The state is `b64url(sha256("hana-console/auth-state/v1\0" ‖ f))`, f being the 32-byte start handle: `/start` can
    send it to Google while `auth_flows` stores only `sha256(state)` and `sha256(f)`, as the schema has it.
  - The flow, the handoff code and the session are each found and consumed in one `UPDATE … RETURNING` that includes
    the cookie hash, so a wrong or missing cookie consumes nothing (the right browser can still finish).
- Why: the spec places the rules at complete; running them in the callback would accept invites for flows a different
  browser never finishes.
- Rejected: storing the state in clear (a D1 read would give a live state); keeping the identity until the purge.

### D292. `/api/auth/complete` answers with redirects: `/` on success, `/signin#error=<code>` on any refusal
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9` (`sign-in.ts`,
  console-core `SIGN_IN_ERRORS`, the SPA's `/signin`)
- Decision: complete is the target of a top-level navigation (the callback's 303), so it never answers JSON: a refusal
  is `303 /signin#error=<code>` with the pre-flow cookie cleared, the code one of `not_invited`, `invite_invalid`,
  `already_member`, `user_disabled`, `expired` (unknown, used, expired or another browser's handoff), `rate_limited`,
  `internal`. The spec's statuses (403 `not_invited`, 409 `already_member`, …) stay the codes' meaning; the code goes in
  the fragment, so no server or log sees it in a URL. The SPA shows one message per code.
- Rejected: a JSON 403 to a navigation (the browser shows raw JSON); a query parameter (logged with the URL).

### D293. An invite link that names no live invite is refused at the start; invite refusals at completion are logged, not audited
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9`
  (`auth-flow.ts` `createLoginFlow`, `sign-in.ts` `membershipRules`)
- Decision:
  - `POST /api/auth/start` with an `invite` whose sha256 matches no open, notified invite answers `403
    invite_invalid` and starts no flow (the spec's "`invite_id` if the hash matches a live invite" read as fail closed:
    a sign-in that would end `not_invited` isn't started, and the person learns why at once). A valid invite's address
    is the Google `login_hint`.
  - At completion, `invite_invalid` and `already_member` are logged only; `not_invited` and `user_disabled` are audited
    (`signin.refused`, system actor `console-sign-in`; `not_invited` with the address's sha256 only, `user_disabled`
    with the user id as target), as the spec says. The spec's "a refused acceptance inserts no … audit row" is kept
    literally. Sign-ins and logouts are audited (`session.signed_in` with `invite: true|false`, `session.signed_out`),
    with no org (they aren't org events).
  - The stored address of an existing user is replaced by the one Google verified at each sign-in (display and notices
    only; identity stays `(provider, sub)`).
- Rejected: an oracle-free start that silently drops a dead invite (the person signs in for nothing, then reads
  `not_invited`); auditing invite refusals (the spec's test row says none is written).

### D294. The console's Google client is the manifest's one `google` console audience; the console route is on by config
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9`
  (`apps/console/scripts/gen-wrangler.ts` `consoleGoogleClientId`, `placement`; `apps/console-auth/scripts/gen-wrangler.ts`)
- Decision:
  - `CONSOLE_GOOGLE_CLIENT_ID` is the single `["google", …]` entry of `consoleAudiences`; `gen` refuses none or several
    (no field is added to the manifest). The callback requires `aud` (and `azp`) to equal that client, not just any
    console audience: the token comes from the console's own exchange for that client.
  - The route: `workers_dev: true` only in a dev env (`local*`/`sandbox*`) and only when the origin is the Worker's own
    `<workerName>.<subdomain>.workers.dev`; otherwise a Custom Domain route on the origin's host; `preview_urls: false`
    always. The same for console-auth (`console.authOrigin`, `authWorkerName`). Neither Worker records invocation logs
    (the URLs carry the handoff code and Google's `code` and `state`).
  - The Google endpoints are code constants, never vars, so no config can send the code and the secret elsewhere.
- Rejected: a new `console.googleClientId` manifest field (one more thing to keep equal to `consoleAudiences`).

### D295. Open question 1 is tested by a script on the console client's real redirect URI; `at_hash` is the expected finding
- Date 2026-11-04 · Status: decided while building, to confirm; **the spike is not run** (the user runs it after setup
  step 11) · Built on `feat/batch-c-9` (`scripts/console-code-flow-spike.ts`, `scripts/lib/console-code-flow.ts`)
- Decision: `corepack pnpm --filter @hana-id/scripts console-code-flow-spike <env>` runs the code flow with the console
  client for `scope=openid` and `scope=openid email`, on its only redirect URI (no extra one is registered): the
  operator pastes the callback address from the browser (hidden input; the deployed callback, if any, exchanges
  nothing for a state it doesn't know), the script exchanges the code with the secret from
  `.secrets/<env>/console-google-client.json` and its own PKCE verifier, verifies the token and prints claim names and
  verdicts only (`docs/operations.md` "Console code-flow spike (open question 1)").
- Expected finding, to decide before C10: Google's docs say an ID token issued with an access token in the server flow
  always carries `at_hash`. Then the `openid` leg reports "NO EMAIL, BUT at_hash": no personal claim, but the API's
  allow-list refuses `at_hash`, so every step-up and owner-action token from the code flow would be `token_has_pii`.
  Options then: add `at_hash` to `TOKEN_CLAIM_ALLOW_LIST` everywhere (core, the API, the console: it is a truncated hash
  of a short-lived access token, not personal data; recommended), or allow it only on the console audiences' paths.
  Not changed now: D271's list moves only with the user's word and the spike's answer. **Decided: D342** (the first
  option, confirmed 2026-11-04 before the spike runs).
- Rejected: a loopback redirect URI on the console client for the test (the client must keep exactly one redirect
  URI); a browser page like `spike-email.html` (the code exchange needs the client secret).

### D296. What partners see: staff as `hana`, no `sub`, no network data; the audit merged by time with a two-part cursor; frozen orgs read-only
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9` (`apps/console/src/bff.ts`,
  console-core `partner.ts`)
- Decision:
  - The partner views (console-core `partner.ts`) carry no staff Access subject or staff address (an actor, inviter or
    `added_by` that isn't a `usr_…` id is `hana`), no Google `sub` (members' or actors'), no IP prefix and no hash. The
    audit's console rows keep `country`; `audit_log.ip_prefix` and the session network data stay staff-only (D93).
  - `GET /api/orgs/:org/audit` merges the org's `audit_log` rows with `ConsoleRpc.listChanges`, newest first by time,
    each source in its own `seq` order, 50 a page; the cursor is `<audit seq>.<change seq>`, each an exclusive bound,
    so no row is skipped or repeated. Rows of one request share the `requestId` and sit together.
  - `GET /api/me` lists every membership whose org's `required_hd` matches the session's `hd`, frozen orgs included
    (read-only, shown as frozen); signing in needs at least one such membership in an **active** org (so C7's "freezing
    their only org ends their sessions" also keeps them out).
  - Any org the member can't use answers `404 not_found`, the same as an unknown org.
- Rejected: listing `sub` for owners (C10's on-chain owner checks are the API's); a single merged sequence number (the
  sources are two databases).

### D297. The SPA: React 18.3.1, React Router 6.30.1, Vite 7 with esbuild's JSX; Playwright under the CSP left for C17
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-9` (`apps/console/web/`,
  `vite.config.ts`, `scripts/test/spa-build.test.ts`)
- Decision: `apps/console/web` builds to `apps/console/dist` (the Worker's assets; `deploy` builds first; the Worker
  tests serve a fixed stand-in, `test/assets`). No React Vite plugin (esbuild's automatic JSX), no modulepreload
  polyfill, no inlined asset: a build test checks one module script and one stylesheet from `/assets`, nothing inline or
  external, and no server code bundled (the SPA imports only types from console-core). `react-router-dom` 6.30.1 is the
  one new dependency (React 18.3.1 and the testing libraries were already in the lockfile).
- Playwright sign-in under the CSP in three browsers (the spec's row) isn't in this batch: the e2e stack runs the API in
  Node, and hosting the console would need D1, the `ConsoleRpc` and `AuthHandler` service bindings, the rate-limit
  binding and a stub for Google's token endpoint, which the Worker can't be pointed at (D294): new infrastructure. It
  is left for C17 on sandbox-dev or staging, against real Google; the component tests (happy-dom) and the build check
  cover the SPA meanwhile.

## Batch C10: partner management (branch `feat/batch-c-10`), 2026-11-04

### D342. `at_hash` joins the claim allow-list everywhere (amends D271)
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: "accept both, go ahead with C10", on D295's recommended
  option) · Built on `feat/batch-c-10` (`packages/core/src/id-token.ts` `TOKEN_CLAIM_ALLOW_LIST`,
  `apps/api/src/claims.ts` `ALLOWED_CLAIMS`, `apps/console/src/auth-token.ts` `TOKEN_CLAIM_ALLOW_LIST`,
  `scripts/lib/console-code-flow.ts`; `apps/api/scripts/test/relayed-tokens.test.ts` keeps the three equal) · Amends
  D271 (and D290's sign-in extras)
- Decision: the allow-list is `iss azp aud sub iat exp nonce nbf jti auth_time at_hash` in core (the vault, the login
  popup's callback, the smoke pages), the API (every route that relays a Google token, the step-up check) and the
  console (both scopes). Sign-in's extras shrink to `email`, `email_verified`, `hd`. The console still checks an
  `at_hash` against the access token of its own code exchange, now in both scopes (`at_hash_mismatch`); the API, which
  never sees that access token, accepts the claim as listed.
- Why: Google adds `at_hash` to every ID token issued alongside an access token (the server-side code flow the console
  uses, D295's expected finding), so the console's step-up and owner-action tokens, which the API verifies again and
  relays, would otherwise all be `token_has_pii`. It is the left half of SHA-256 over a short-lived access token: it
  says nothing about the person and can't be reversed into the access token. One list everywhere is easier to keep
  right than a second list for the console audiences (the rejected option).
- Login paths: none depends on the old ten names being exact. The vault's and the API's checks only refuse claims
  outside the list; Hana's own login requests (implicit `response_type=id_token`, `scope=openid`) carry no `at_hash`,
  so their tokens are unchanged; the e2e Google stub's `OPENID_CLAIMS` is what the stub emits, not the list. A token
  that does carry `at_hash` (an `id_token token` answer) now passes and puts that hash on chain, which is not personal
  data. The contract ignores unknown claims either way.
- Rejected: `at_hash` only on the console audiences' paths (two lists to keep in step, and the API's step-up check
  would need the audience before the list); asking Google for an ID token without an access token (the code flow
  always returns one).

### D343. Freezing an org pauses its pending owner grants and invites; a paused grant is re-confirmed, not resumed
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04, on C7's review findings; the choice between a paused
  clock and a re-confirmation was left to the build, which took re-confirmation as the safer) · Built on
  `feat/batch-c-10` (`apps/console/src/members.ts` `freezeOrg`, `invites.ts` `pendingMemberNotices`,
  `ackMemberNotice`, `cron.ts` `applyGrants`; tests in `apps/console/test/owners.test.ts` "a freeze pauses …") ·
  Amends D241, D243
- Gaps it closes (C7 review): a pending owner grant kept maturing while its org was frozen (ownership is a predicate on
  `owner_from`, and the hourly cron recorded it); invites issued before a freeze were still announced during it and
  became usable after an unfreeze.
- Decision:
  - **Grants.** In the freeze's own batch, every live grant still inside its wait or not yet announced loses its
    notice and its clock (`notified_at`, `cancel_token_hash`, `owner_from` cleared), so it can't mature while frozen.
    After the unfreeze it is listed by `pendingMemberNotices` again (an accepted owner invite's grant too) and, once
    every send of the new notice is accepted, waits the **full** `ownerGrantDelayMs` from that ack. The emailed cancel
    link stops working meanwhile (the grant can't mature, so nothing needs cancelling by link; owners and staff still
    can) and works again after the new notice (the token is deterministic per grant). A grant whose `owner_from` had
    already passed before the freeze had matured: its member stays an owner by predicate, and the cron records it only
    once the org is active again (`applyGrants` skips frozen orgs).
  - **Invites.** In the same batch every open, announced invite of the org loses its notice (`token_hash`,
    `notified_at` cleared), so its link stops working at once; while frozen no invite of the org is listed or acked
    (`not_pending`), and acceptance already required an active org. After the unfreeze each is announced again
    (invitee, every owner, the contacts, the alias) before its link works; its 7 days keep counting from creation.
- Why re-confirmation over a paused clock: a freeze is Hana's response to a suspected compromise or dispute, so what
  was pending at the freeze may be what prompted it; a fresh notice to every owner, the contacts and the alias, and a
  full wait after it, gives them the whole window again, and needs no stored "time already waited" (a paused clock
  would need a new column and a resume rule, and would let a grant mature soon after an unfreeze nobody re-noticed).
- Rejected: a paused clock (above); cancelling or revoking everything pending at a freeze (destroys legitimate
  invites and grants for a freeze that turns out to be precautionary); leaving announced invites usable after an
  unfreeze (nobody is told again that they are live).

### D350. A client proof pasted into the console is held to the claim allow-list; the PII warning names what stays public
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10`
  (`apps/console/src/auth-token.ts` `verifyClientProof`, `actions.ts` `buildOwnerAction`, `web/src/pages/Scope.tsx`) ·
  Source: spec "On-chain owner actions" step 3; D274, D277
- Decision: before an AddClient is built the console verifies the pasted proof (Google's JWKS, `iss`, `exp`, `aud` and
  `azp` the client being added, the client-proof nonce at the scope's `action_nonce`) and refuses any claim outside the
  claim allow-list (`invalid_client_proof`, the claim named), as the API's precheck will (D274). The spec's warning
  ("it carries the staffer's email and name and becomes public on chain") can no longer be true: a proof with an email
  or a name is refused. The warning says instead that the proof becomes public on NEAR with the Google account id
  (`sub`) of whoever signed in for that client, and suggests a team account; the owner must tick it
  (`piiWarningAccepted: true` is required by the server, not only the page).
- Why: checking first stops a doomed sign-in and a doomed owner action; the warning has to describe what actually
  becomes public.
- Rejected: keeping the spec's wording (it would describe a proof Hana refuses); no warning (the `sub` is still public).

### D351. The client-proof helper uses Google's implicit flow with `scope=openid`, not Google Identity Services
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/scopes.ts`
  `helperHtml`, `helperRoute`) · Source: spec "On-chain owner actions" step 3 ("it loads GIS with that nonce")
- Decision: the downloaded helper (a self-contained page, `Content-Disposition: attachment`, the client id, scope and
  client-proof nonce at the scope's current `action_nonce` inside it) sends the browser to Google's authorization
  endpoint with `response_type=id_token`, `scope=openid`, the nonce and `prompt=select_account`, the page's own address
  as `redirect_uri`, and shows the returned token (after checking its `aud`, nonce and claim names) to copy. The partner
  registers the page's address as a redirect URI of their client while they use it.
- Why: GIS ID tokens always carry `email`, `email_verified` and a name, which D274 refuses on chain; the implicit flow
  with `scope=openid` is the only browser-only way to an openid-only token (the vault does the same). The proof is good
  only until the scope's next owner action (the nonce moves), which the page says.
- Rejected: GIS (every proof refused); the console serving the page (the spec: the proof must come from the client's
  own origin, and the console never serves it).

### D352. The policy editor's consent preview is packages/web's own renderer, fed by a console check route
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10`
  (`apps/console/web/src/pages/Consent.tsx`, `src/policy.ts` `policyCheckRoute`, `writes.ts`) · Source: spec "Policy and
  raw-signing input rules" ("the editor shows the consent screen as users will see it (`render-consent.ts`, …)")
- Decision: the SPA imports `packages/web/src/auth/render-consent.ts` and `dom.ts` by relative path (no new package
  export; the SDK's tarballs are unchanged) and mounts the DOM it builds (text nodes only) in a container. The policy it
  shows is the one the console validated: `POST /api/orgs/:org/apps/:app/policy/check {policy}` (owner, writes nothing,
  not in the spec's route table) runs `@hana-id/core/policy`'s validator at the app's session TTL and answers the
  canonical policy, its `policyId` and label, or `policy_invalid` with the problems. `policy.set` validates again
  before the sign-in and the API a third time.
- Why: a copy of the consent screen would drift from what users see; the validator stays out of the SPA's bundle.
- Rejected: a React copy of the consent screen; validating only in the browser (the vault's validator would ship in the
  console bundle and the server would still have to check).

### D353. Owner drift's SetOwners is built by the server from the org's owners and keeps the scope's NEAR owners
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/scopes.ts`
  `scopeAnswer`, `actions.ts` `buildOwnerAction`) · Source: spec "Apps, scopes and client mode" → "Owner drift"; D296
- Decision: the scope page compares the org's usable owners (role or matured grant, not disabled) with the scope's
  on-chain `Oidc` owners and lists who is missing on chain, who is on chain but not an owner in the console, and how many
  on-chain owners aren't members (no `sub` is ever answered). `SetOwners` takes no owner list from the browser: the
  server sets the scope's `Near` owners plus `Oidc{google, sub}` of each org owner (at most 5, the contract's limit).
  Every other owner action and the pending changes are decoded the same way (members by address, "a Google account
  that isn't a member" otherwise).
- Why: partners never see or type `sub`s (D296), and a list typed in the browser could add a stranger; keeping `Near`
  owners avoids a drift fix silently removing an operator account.
- Rejected: a free-form owner list; dropping `Near` owners.

### D354. A fresh sign-in's action is used once whatever the outcome; where each refusal lands
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/actions.ts`,
  `auth-flow.ts` `callback`, `web/src/pages/Action.tsx`) · Source: spec "Fresh sign-in", "On-chain owner actions" step 5
- Decision:
  - Every step-up action has a page, `/actions/:id`, that shows the decoded action (what will be applied), the "Confirm
    with Google" button while it is pending, and its outcome (`GET /api/actions/:id`, the action's user only; any of
    their sessions may read it, only the creating session may start it).
  - A token the callback refuses (signature, nonce, `iat`, a claim outside the allow-list, a wrong `at_hash`) gets the
    static 400 page, like a sign-in, and the action stays pending until it expires. After the token verified, every
    refusal consumes the action and is stored as its outcome and audited (`step_up.failed`): `sub_mismatch`,
    `step_up_expired`, `session_ended` (revoked or expired between creation and callback), `forbidden` (no longer an
    owner of an active org).
  - API kinds consume the action before the RPC (so the token goes out once) and store the RPC's answer, success or
    refusal (`version_conflict`, `not_owner`, `token_used`, …). Console-only kinds consume it in the change's own batch;
    a change already in force (a no-op) consumes it with `noChange`.
  - Owner actions: the callback re-reads `get_scope`; a moved `action_nonce` fails the action (`nonce_moved`) without
    calling the API. The spec's "staff relay runbook" (showing the owner the signed body to send Hana when a safety call
    is `rate_limited`) is not built: the token is used in the callback and never stored, so the console has no signed
    body to show afterwards; the page tells the owner to contact Hana security, who can act through a staff proposal or
    `owner:relay` with a new token (to confirm).
- Why: one use per action and per token, whatever happens, is the simplest invariant to keep right; a refused token says
  nothing about the action, so it doesn't spend it.
- Rejected: letting a failed action be retried with a new sign-in (a second token for the same digest); storing the
  token for a later relay.

### D355. An owner sets `required_hd` only to their own session's Workspace domain
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/members.ts`
  `setOrgPolicy`) · Source: spec "Roles and permissions" (Org `required_hd`: owner, fresh sign-in)
- Decision: `org.policy` refuses a domain other than the acting session's `hd` (`conflict`, before the sign-in and again
  in the batch); null (no requirement) is always allowed. The change, the action's consumption and the `org.policy`
  audit row (`requiredHd`, the org's own domain) are one batch, which also revokes the sessions of members whose
  session domain doesn't match when this was their only active org.
- Why: setting another domain would lock the owner (and possibly every owner) out at their next request, leaving the
  org to Hana staff.
- Rejected: allowing any domain with a warning.

### D356. The role matrix as built: frozen orgs keep exactly the cancels and the kill switches
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/writes.ts`
  `ROUTES`, `runOrgRoute`; `test/writes.test.ts` "the role matrix") · Source: spec "Roles and permissions", "Console BFF
  routes"
- Decision: every signed-in write route declares its role (`owner`) and whether a frozen org allows it. Open while
  frozen: removing an origin, turning the policy or raw signing off, suspending, revoking a key, cancelling a guarded
  change, revoking an invite and cancelling an owner grant; refused (`403 org_frozen`): every step-up, rotating or
  creating a key, renaming, the logo, the policy check and `execute_change` (applying a change, not stopping one). A
  viewer, a pending owner included, is `403 forbidden` on every owner route; a member of another org, or a session whose
  domain doesn't match `required_hd`, is `404`. `member.role` and `member.remove` act only on existing members (an owner
  adds people by invite; staff's `setMember` still adds). Every ConsoleRpc write writes an outcome audit row after the
  RPC returns, like the logo (C11).
- Why: a freeze stops changes but must never stop an owner turning something off; a test lists every route so a new one
  has to choose.
- Rejected: allowing `execute_change` in a frozen org (it makes a pending change take effect).

### D357. The partner Users screen ships behind `USERS_SCREEN` (off until an env's API runs D346)
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10` (`apps/console/src/users.ts`,
  `web/src/pages/Users.tsx`, `/api/me` `features.users`) · Source: D310, D346; the build brief ("if the wallet directory
  hasn't landed, build it against a typed client stub, behind a feature flag that's off")
- Decision: `GET /api/orgs/:org/users` and `/users/:userId` (viewer) call `ConsoleRpc.listUsers` / `getUser` as
  `feat/wallet-directory` defines them, with D346's fields from `feat/user-id-identity-sub` (`userId` = the identity
  token's `sub`, `u1_…`; `supportId` its short form; the internal `hu_…` id never shown). Both merged into `develop`
  while C10 was built: the screen was first built against a typed stub, then switched to console-core's types
  (`PartnerUser`, `ConsoleListUsersInput`, `USER_ID_RE`). The routes are `404` and the tab hidden unless the console var
  `USERS_SCREEN = "1"`: a console with the flag on in front of an API without D346 would get `hu_…` ids, which the
  allowlist drops, so turn it on per env only after that env's API is deployed with D346. Every row is rebuilt field by field (User ID, Support ID, scope, times, account
  kinds, wallet addresses of each chain's form), and a malformed row is dropped and logged, so no email, `sub`, identity
  or directory key can reach a partner whatever the API sends (tested by data shape).
- Setup: per env, after the API with D346 is deployed, set `USERS_SCREEN = "1"` on the console and redeploy it.
- Rejected: shipping the screen on with a mock answer; waiting for the wallet directory before building it.

### D358. Routes and checks the spec doesn't list
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/batch-c-10`
- Decision:
  - `POST /api/orgs/:org/apps/:app/logo/remove {expectedVersion}` (C11's `logoRemoveRoute`), `POST …/policy/check`
    (D352), and the SPA pages `/actions/:id`, `/orgs/:org/scopes/:scope`, `/orgs/:org/users`.
  - The console gets the API's origin rules (`NETWORK`, `REFUSED_ORIGINS`, written by `gen` from the manifest) and
    checks an origin add before the sign-in; the API checks it again.
  - `/api/me` answers `features: {users}`.
  - C12's report backend (`usage`, `statements`, the statement files, the ledger CSV) and C14's
    `/api/orgs/:org/governance/pending-upgrades`, both merged while C10 was built, are routed by `writes.ts` for any
    member (frozen orgs included: they are reads); their SPA screens are left for a follow-up. The brief's "stays for
    C14" is read as "C14 owns the backend": the route itself had to come from C10's session router.
  - Tests: the test API Worker's outbound fetches go to a fake upstream (`test/fake-upstream.js`: hana-signer's views and
    Google's JWKS from a test D1), so the API verifies step-up and owner tokens for real; the relay itself isn't
    exercised (the test API has no owner-pool key: C17's smoke covers it).
- Why: each closes a gap the spec leaves (a removal control, a preview, a page to confirm on).
## Batch C14: Security & monitoring and the pending-upgrades page (branch `feat/batch-c-14`), 2026-11-04

Readings of `docs/governance-spec.md` "Monitoring in the admin portal", `docs/batch-c-spec.md` "Hana admin console"
(the Playbooks requirements) and D83, D86, D126, made while building C14 where they are silent or loose. Each took the
safer reading.

### D330. The watchdog's bearer stays in the admin Worker; its URL is the manifest's `watchdog.url`
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/watchdog.ts`,
  `scripts/gen-wrangler.ts`; `packages/env/src/schema.ts` (`watchdog.url`, `watchdogUrlProblem`) · Source:
  governance-spec "Status endpoint" ("a bearer token that only the admin Worker holds"), build plan C14
- Decision:
  - `WATCHDOG_STATUS_TOKEN` is an admin Worker secret, the same value as the watchdog's (from
    `.secrets/<env>/watchdog-secrets.json`, uploaded through stdin with `jq -e`). Only `src/watchdog.ts` reads it, into
    the `Authorization` header of its own calls; it is in no response, log line or error (a source test checks the
    readers and the uses).
  - The watchdog's origin is a new optional manifest field, `watchdog.url`: an https origin exactly (no credentials,
    port, path, query or trailing slash), and a workers.dev host must name `watchdog.cloudflare.workerName`. `gen`
    writes it as the `WATCHDOG_URL` var (with `NEAR_NETWORK` for explorer links); a production manifest's admin `gen`
    refuses without it. The Worker re-checks the origin at use and calls nothing when either is missing or malformed
    (`watchdog_unconfigured`).
  - Redirects are refused (`redirect: 'manual'`, a 3xx is `watchdog_bad_answer`): following one would send the bearer
    to whatever origin the answer named.
- Why: the token can read every alert and ack any of them, so it must not reach a browser; the manifest is where
  every other origin lives, and a typo'd host would otherwise receive the token.
- Rejected: a `--watchdog-url` flag on `gen` (an origin outside the manifest drifts); proxying the browser's request
  with the header added (the browser would choose the path).

### D331. Bounds on the watchdog's answers: caps, one deadline, plain text
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/watchdog.ts`
  (`WATCHDOG_LIMITS`, `watchdogTiming`), `src/plain.ts`, `src/monitoring.ts` · Source: build plan C14 ("size-cap and
  time out the watchdog responses, and render them as text only")
- Decision:
  - Caps per route, by `Content-Length` and while streaming: `/status` 1 MiB, `/alerts` 2 MiB (a critical alert left
    unacknowledged gathers three deliveries every 15 minutes: alert #11 has hundreds), `/actions` 512 KiB, an ack 64
    KiB. One 8 s deadline per call covers the headers and the body. The alert history asks for 25 a page, the actions
    50.
  - What comes back is reduced to plain data before the SPA sees it: C0/C1 controls and the bidi overrides become
    U+FFFD (a kid that displays reversed is a lie even as text), strings are cut at 2 000 characters, arrays at 500
    items, objects at 200 keys, depth at 8; only JSON's own types survive. Each alert keeps its last 20 deliveries and
    their total. A row without a positive integer id is dropped, never half-shown.
  - Failures are the admin's codes (`watchdog_unconfigured`, `_unauthorized`, `_timeout`, `_too_large`,
    `_bad_answer`, `_unavailable`), never the watchdog's text.
- Why: the watchdog runs on another account and is a party this Worker must survive; the SPA writes text only, and
  these bounds keep that text honest and the page usable.

### D332. The acknowledge button: who, which alerts, what it does not do
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/monitoring.ts` (`ackRoute`,
  `ackBy`, `alertView`), `public/app.js` · Source: governance-spec "Monitoring in the admin portal" ("acknowledge
  (posted to the watchdog's ack endpoint, recorded with the Access identity)"), D85
- Decision:
  - `by` is `<Access email> (access:<Access sub>)`, or `access:<sub>` alone when the email has a character the
    watchdog's `by` rule refuses; the request body can't set it. The watchdog's record (`acked_by`, `acked_via:
    portal`) is the record: nothing is written to Hana's `audit_log` (the watchdog is the party that must keep it),
    and the admin logs `watchdog_ack` with the alert id only.
  - The button shows only on an unacknowledged alert that is re-sent until acknowledged (critical). The route forwards
    any positive integer id and lets the watchdog answer (`404`, `409 already_acknowledged` keeping the first ack).
  - The confirmation and every alert row say it plainly: an ack stops only that alert's 15-minute re-sends. It never
    clears a condition (`open` stays as the watchdog has it, and the "not acknowledged" finding goes but the
    condition's own finding stays), never stops a first alert, never acts on chain.
  - Alert #11 on sandbox-dev (the expected `governance_change` of the updater-key rotation) is acknowledged this way
    once the view is deployed (`docs/operations.md` "Security & monitoring" step 5; `docs/mainnet-readiness.md` 5.9).
- Why: the identity must be the one Access verified; an ack button on a warning or info alert would stop nothing.

### D333. One pending-upgrades view for both consoles, and a release registry for the commit and build
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `packages/console-core/src/governance.ts`
  (`pendingUpgradesView`, `CONTRACT_RELEASES`, `releaseProblems`), `apps/api/src/rpc/{admin,console}.ts`
  (`pendingUpgrades`) · Source: governance-spec "Alerts" (the page shows "code hash, source commit,
  reproducible-build command, diff to the last release, countdown"), D86 Q11, Q14
- Decision:
  - The page shows the pending upgrade, owner transfer, withdrawal, delay decreases and console-audience additions,
    each with its time and `readAtMs` (countdowns are the reader's clock), and the pause state. Partners and staff
    get the same view, built in the API from the `GET /v1/governance` snapshot. It carries nothing staff-only (no
    access keys, watchdogs, key changes or the cron's state) and nothing of any org.
  - The code hash is on chain; its source commit, build command and diff are not. They come from
    `CONTRACT_RELEASES` in console-core (oldest first; a test checks each entry: base58 hash, x.y.z version, 40-hex
    commit, exactly the reproducible build command, `previousCommit` chained). The diff is shown as the command `git
    diff <previous>..<commit> -- contracts/hana-signer` (the repo is private). A hash not in the registry is shown as
    **not a published release**, a warning. The registry is empty today: testnet upgrades are non-reproducible
    builds, so that warning is accurate on sandbox-dev.
  - Publishing a release = adding its entry and deploying the API **before** the owner proposes (operations.md
    "Pending upgrades page").
- Why: D86 Q14 needs the hash, commit and command published before the proposal; a registry in the repo is reviewed
  like code and served to partners by the API they already trust for the view.
- Rejected: reading release metadata from a URL at request time (one more party to trust and fail); leaving the
  commit and command out until mainnet (the page would ship without what the spec says it shows).

### D334. The governance read is `AdminRpc.governance`, the same snapshot as `GET /v1/governance`; the portal's own chain and DAO reads are deferred
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/src/governance-status.ts`
  (`governanceSnapshot`), `apps/api/src/rpc/admin.ts` · Source: build plan C14 ("the governance state from `GET
  /v1/governance`"), governance-spec "Monitoring in the admin portal" (the admin Worker reads the chain itself)
- Decision:
  - The admin reads the snapshot over its `API` binding (`AdminRpc.governance`, staff only), not by fetching the
    public endpoint (a Worker-to-Worker fetch on one account's workers.dev isn't reliable, and the binding is already
    there). The isolate's 10 s cache serves the endpoint and the RPCs alike. A failed or unknown-shaped view is
    `near_unavailable`, nothing partial.
  - The three sources of `GET /api/monitoring` (the watchdog, the snapshot, the security events) are read in parallel
    and fail on their own.
  - Each pending key change shows the API's JWKS verdict beside the watchdog's sighting of the kid (its `seen_kids`),
    which stands in for the spec's "the admin Worker's own fetch beside the watchdog's verdict".
  - **Deferred, to confirm:** the spec has the admin Worker read the chain through its own RPC (independent of the
    API) and the council DAO's policy and open proposals. C14 does neither: the watchdog is the independent party in
    the same view, and the `governance:status` findings about the owner account, the DAO's policy and the delay
    floors still come from `admin <env> governance:status`.
- Why: the build plan names `GET /v1/governance` as the source; one normalised snapshot is less code to get wrong
  than a second parser of the same views.

### D335. The partner console's route is `GET /api/orgs/:org/governance/pending-upgrades`, checked against the membership twice
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/governance.ts`
  (`pendingUpgradesRoute`, not routed until C10), `ConsoleRpc.pendingUpgrades` · Source: spec §Console BFF routes
  (`GET /api/governance/pending-upgrades`, role "session"), build plan C14
- Decision: the route sits under the org (any member, any role) rather than at the spec's org-less path: every
  ConsoleRpc call is charged to an org and refuses `org_legacy`, and every other console read is under `:org`. The
  handler checks the membership again (a `members` row, the user not disabled) behind C10's session check, so a
  member of another org, an unknown org or a disabled user gets 404 with no RPC call. The answer is contract-wide (the
  same for every org). Cost 2 in the org's budget (the snapshot's D1 batch when the 10 s snapshot is stale).
- Why: the safest reading of "the pending-upgrades page in the partner console" with ConsoleRpc's org rules intact.
- Rejected: the org-less path with an implicit org (the first membership: arbitrary for a member of several).

### D336. The playbooks are served by the admin Worker from the bundled package; the search runs there
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/playbooks.ts`,
  `public/app.js` · Source: spec "Security & monitoring: recovery playbooks" ("the admin SPA imports the package at
  build time"; search "client-side")
- Decision: the SPA has no build step (D278), so the Worker bundles `@hana-id/playbooks` and serves `GET
  /api/playbooks?q&kind&severity` and `GET /api/playbooks/:id` (behind Access like every route). The search (every
  word of `q` in the title, summary, signals or impact, case-insensitive; over every playbook, alerts included) runs in
  the Worker, where it is tested. Each playbook shows the spec's order (signals, impact, steps with `who` as a badge,
  detail, commands in copyable blocks, verbatim; verify, follow-ups, refs, related) under the "Before you start"
  notes. Refs link to the file on GitHub (`develop`; decision ids to `docs/decisions.md`). An alert links to the
  playbook id the watchdog serves for its kind when it names a package playbook, else `playbookForAlertKind`, else
  the visible "no playbook" error (also a finding).
- Why: nothing copied by hand, as the spec wants, without adding a build step to the SPA; a playbook edit ships with
  the next admin deploy.

### D337. The findings the portal shows, and the check registry
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/monitoring.ts`
  (`findingsOf`), `src/monitoring-registry.ts` · Source: D83 (the view's list and the standing rule), `api.md` "What
  the portal derives from it", operations.md "Governance status for the admin portal"
- Decision:
  - Findings, critical first, each with its playbook where one answers it: the watchdog unreadable or silent for more
    than two intervals (`watchdog-down`); a check of the last run with `error` (warning) or `alert` (info); every
    unacknowledged critical alert by id; an alert kind or check the portal can't render; the heartbeat or a channel
    not configured or failing; the contract paused (`contract-paused`); a pending upgrade, owner transfer or withdrawal
    (critical), a delay decrease or console-audience addition (warning; `governance-change`); a pending Add Google's
    JWKS doesn't publish or has other material (`forged-key-change`), a pending Remove Google still publishes
    (`published-key-removal`), a due change nobody executed (`key-sync-stalled`); no watchdog on chain; a signer key
    that isn't an updater key or has the wrong permission (`updater-key-stolen`), a full-access key (info in a dev
    env, D86 Q9; critical elsewhere), an updater key missing from the account; the API cron's last run not `ok`, a
    proposal of ours cancelled.
  - `CHECK_VIEWS` gives every watchdog check id a title and the part of the view that shows it; a test compares it
    with the watchdog's `CHECK_IDS`, and another walks every `ALERT_KINDS` kind to its playbook. A check or kind the
    watchdog serves and the portal doesn't know is shown (`known: false`, "no playbook") and is a finding, so a newer
    watchdog is never silently half-rendered.
- Why: D83's standing rule, enforced by a test on each side.

### D338. The C14 screens and their routes
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/public/app.js`, `app.css` ·
  Source: spec "Security & monitoring: recovery playbooks" (`/security/playbooks`, `/security/playbooks/<id>`)
- Decision: three nav entries: Security & monitoring (`/security/monitoring`), Pending upgrades (`/security/upgrades`)
  and Playbooks (`/security/playbooks`, one page per id); C8's "Feed and notices" keeps `/security`. The monitoring
  page shows the findings, the watchdog (with the silence banner), its checks, the open alerts with acknowledge, the
  governance part (pause, pending key changes, pending upgrades and owner actions, updater keys against the signer's
  keys, watchdogs, the API cron), the alert history (25 a page, a severity filter, details and deliveries folded), the
  actions log with explorer links, seen kids, relayer funds, the email and identity pins, link stats, the alert-kind
  registry and the security events. Everything is text; external links only https. No auto-refresh: the page is read
  on load (a staff member reloads), so a countdown is as of that moment.
- Why: one place for staff, as D83 asks; reloads are cheap and keep the Worker's outbound calls per staff member low.

### D344. The feed's first run starts each cursor at the current position, without emailing the history (amends D281)
- Date 2026-11-04 · Status: **confirmed by the user** ("yes" to starting the feed at the current position rather than
  emailing the whole history) · Built (branch `feat/batch-c-14`): `apps/admin/src/feed.ts` (`initialise`,
  `FEED_INIT_PAGE`, `FEED_INIT_PAGES`, `initKey`), `test/feed.test.ts` · Source: coordinator, 2026-11-04
- Decision: when a feed cursor (`feed.app_changes.seq`, `feed.audit_log.seq`) has no row in `ops.state`, the run reads
  the source to its end without sending anything (pages of 500, at most 10 a run) and stores the last seq as the
  cursor (0 for an empty source). From then on only rows after it are emailed, as D281 says. A history longer than one
  run's walk keeps its place in `<cursor key>.init` and goes on silently next run; the cursor itself is written only
  once the end is reached, so the feed never starts mid-history. The run logs `feed` with `code:
  cursor_initialised` / `cursor_initialising`.
- Reading of "each source", decided while building, to confirm: security events have no cursor in `ops.state` (their
  per-row `notified_at` is the API's), so unnotified ones are still emailed on the first run. Each is a security signal
  (drift, a cap, an allowance alert), and marking them notified unsent would hide them.
- Why: an admin deploy into an env with history would otherwise send every org's contacts (and the alias, for legacy
  rows) digests of changes made long before, which reads as new activity.
- Trade-off: a row written between the deploy and the first run (at most 5 minutes) is in the silent walk and isn't
  emailed; the audit view and CSV still have it.

### D345. A device ticket's used-up code allowance falls back to the ordinary code limits
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: 'yes, make that fix', to "once the device's 3 are used,
  fall back to the normal limits, so a returning device always gets at least what a new one gets") · Built on
  `fix/ticket-fallback` (`apps/email-issuer/src/rate-limiter.ts` `admit`, `ticketSendSlots`) · Amends the abuse
  re-check's owner allowance (D198 family) and D340's note
- Decision: a start carrying a valid device ticket whose own code allowance is used up (3 a day per address, 9 per
  mailbox in production) no longer gets `codes`; the proof counts as nothing for that start, so it meets the ordinary
  code limits (per mailbox and requester, per mailbox, the reserve), the lock, the live and daily caps and the domain cap
  like any requester without a ticket. The owner allowance itself is unchanged and still can't be multiplied.
- Why: a returning device got less than a new one (refused on its 4th to 10th start of a day while a stranger's device
  could still get codes, then the ordinary limits again from the 11th, when the per-address owner-challenge cap drops
  the proof). A fairness bug, not a security one: the flood protection the ticket gives is unchanged.

## Batch C12: reports and statements (branch `feat/batch-c-12`), 2026-11-04

Made while building C12 (`docs/batch-c-build-plan.md` C12, `docs/batch-c-spec.md` "Usage capture and reporting"). None
changes a derivation path or an address. Every one is **decided while building, to confirm**.

### D320. C12's Neon migration is `0006_reports.sql`; C13 takes `0007`; one billing rule in `usage.classified`
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/migrations-usage/0006_reports.sql`,
  `apps/api/test-usage/reports.test.ts` · Source: build plan "Conventions" (C12 = 0004, C13 = 0005), taken by the email
  work's `0004_email_counts.sql` and `0005_link_events.sql`
- Decision:
  - The report, ledger, statement and settlement-check functions are **0006**; C13's retention functions take **0007**,
    and C15's Support ID indexes the number after the last merged one. The build plan's conventions line and C13's
    scope line now say so.
  - One rule for what is billed, `usage.classified(org, from, to, as_of)` (internal, granted to no role): every report
    row, every ledger CSV row and every statement goes through it, so a statement and the ledger CSV for the same
    `as_of` can't disagree. `gas_status` is `final` only for an event settled final **for its own `(request_id, at)`**
    whose `near_tx` no other relayed event received by `as_of` carries; `pending` when no settlement row has its request
    id; otherwise `unsettled`. A second event with an existing settlement's request id (a different `at`) is
    `unsettled`, never `pending`, so it can neither be billed nor hold a statement back.
  - The admin role loses the direct `UPDATE` on `near_usd_rates` that 0001 gave it: a fetched rate is an `INSERT … ON
    CONFLICT DO NOTHING`, a replacement goes through `usage.override_rate` (D325), which writes the audit row in the same
    transaction.
- Why: the email work merged first; renumbering merged files is not allowed. A single classification is the only way the
  spec's reconciliation property ("the ledger CSV's `final` gas for the same `as_of` equals the statement's") holds by
  construction.
- Rejected: taking 0004/0005 and renumbering the email files (immutable once merged); computing the billing rule
  separately in the report and the ledger SQL (two rules drift).

### D321. Settlement bills a relayed event only for its own transaction (the C4 obligation, review L7)
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/settlement.ts`, `near.ts`
  (`txFinal`, `parseTxResult`), `0006_reports.sql` (`gas_settlements.reason`, `ops.settlement_alerts`,
  `usage.classified`), `apps/admin/test-ops/settlement.test.ts` · Source: build plan C12 "Obligation from C4", D222
- Decision: before a relayed event is billed:
  1. **Unique transaction**: no other relayed event in the ledger (any org, any month) carries its `near_tx`. A
     duplicate bills **neither**: settlement writes each `unsettled` with reason `duplicate_tx`, and `usage.classified`
     also refuses at read time any `final` event whose transaction another relayed event received by the same `as_of`
     carries, so a copy written after the first was settled un-bills the first too (under-bills Hana, never over-bills a
     partner), while a statement already issued stays reproducible from its `as_of`.
  2. **A pool key**: `relayer_pk` is one of the env's relayer keys (`AdminRpc.relayerKeys`, session and owner pools,
     read once per run); otherwise `signer_mismatch` without a chain read.
  3. **Its signature**: the transaction read with `tx` at `wait_until: FINAL` has that hash, `signer_id` =
     `RELAYER_ACCOUNT`, `public_key` = `relayer_pk`, `nonce` = `relayer_nonce` and `receiver_id` = `SIGNER_ACCOUNT`;
     any difference is `signer_mismatch`, with the chain's values in the alert.
  - A refusal is written `unsettled` with its reason (`gas_settlements.reason`; a CHECK keeps reasons on unsettled rows
    only), never billed, counted on the statement, and recorded in `ops.settlement_alerts` (first, so no refusal goes
    unheard), which the security screen lists and the alert step emails once to the security alias
    (`settlement_mismatch`).
- Why: a leaked writer credential can attach a real transaction (public on chain, with its key and nonce) to an org it
  isn't for; the key and nonce check alone can't see that, uniqueness can. A JSON nonce past 2^53 is treated as
  malformed rather than rounded.
- Trade-off: a key rotated out of the pool before its events settle makes them `signer_mismatch` (unbilled, alerted).
  Settlement runs within minutes, rotations are rare and announced.
- Rejected: billing the first of two duplicates (the order the writer chose decides who pays); checking the call's
  arguments against the scope (borsh/JSON per method, more surface for the same guarantee).

### D322. Settlement's run: the 40-call budget, any age, one read an hour, alerts and notices first
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/settlement.ts`,
  `ledger-cron.ts`, `ledger.ts` (`settlementQueue`, `ops.settlement_tries`) · Source: spec "Settlement" (≤ 500 a run,
  the last 3 days), D280
- Decision:
  - The queue is every relayed event without a settlement row for its request id, **of any age**, oldest first: an
    event the 3-day window missed (settlement down for days) would otherwise never be settled and would hold its
    month's statement back forever; past 24 h it is written `unsettled` (`not_final`) on its first read.
  - At most `min(500, budget left)` events a run; each `tx` read takes one call of the run's 40 (D280), so a run reads
    about 35 transactions (≈ 3 400 a day). (*D380: with the connection and `relayerKeys` counted, at most 38 a run,
    ≈ 3 600 a day.*) Enough for the pilot; past it, the paid plan's subrequest limit is the lever
    (`docs/mainnet-readiness.md`). Duplicate and pool-key refusals need no call.
  - An event whose transaction isn't final yet (or the RPC doesn't know it) is read again **an hour later**
    (`ops.settlement_tries`), so a backlog of unknown hashes (a forged event, an RPC that lost the tx) can't take every
    run's budget for a day.
  - The 15-minute run sends the alerts first, then the statement notices, then settles with what is left.
- Why: the spec's per-run cap assumed the paid plan; the budget is the binding constraint until the plan is settled.

### D323. The nonce cross-check: a silent baseline, relayed rows only, skipped keys never alert
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/nonce-check.ts`, `ledger.ts`,
  `alerts.ts` · Source: spec "Daily nonce cross-check", D34, D93 Q13
- Decision: the keys are `AdminRpc.relayerKeys` (both pools); `view_access_key` at `finality: final` on
  `RELAYER_ACCOUNT`. Explained: N unchanged since the key's last check; or a **relayed** ledger row with
  `(relayer_pk, relayer_nonce) = (key, N)` (the spec's index); or the key's **first** check when the ledger has no
  relayed row of that key at all (its earlier use predates the ledger: the baseline, as the watcher's, D282). Anything
  else is `nonce_unexplained`. A key the account doesn't have, an unreadable RPC or an empty budget skips the key (no
  row, no alert). The unexplained rows are emailed to the security alias as one digest, retried by every 15-minute run
  until accepted (`alerted_at`). `ledger_relayed_since_last` counts relayed rows by `received_at` since the last check.
- Why: a first check that alerted on every key's pre-ledger history would teach staff to ignore the alert.
- Trade-off: a transaction landing seconds before the check whose event write is still in flight can alert once; the
  next day's check explains it.

### D324. Reports and the statement CSV: link relays and identity tokens added; exact decimals; what is billed
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `0006_reports.sql` (`usage.org_report`),
  `packages/console-core/src/reports.ts`, `apps/admin/src/statement.ts` · Source: spec "Reports", "CSV"
- Decision:
  - Two count columns the spec's list predates: `link_actions` (ok `link`, `link_cancel`, `link_unlink` events, email
    login batch 6; their gas was already in `tgas`) and `identity_tokens` (`usage.identity_tokens`, D223), after
    `owner_actions` in the CSV and as optional `linkActions` / `identityTokens` in `UsageRow`. `UsageRow` also gains
    the optional `relayedRejectedBurntYocto`, `relayedRejectedUsdMicros` and `afterStatement` (late events, the admin's
    "after statement").
  - Decimals are exact: Tgas = gas / 10^12, NEAR = yocto / 10^24, USD = micro-dollars / 10^6, trailing zeros dropped
    (`0` for zero). USD per day is `(yocto × usd_micros × 2 + 10^24) div (2 × 10^24)` (round half up, integers only: a
    numeric division could round the quotient before `round` sees it).
  - **Billed** = all settled gas minus the relayed-then-rejected part (D91); error gas (settled timeouts and
    `near_error`) is billed. The statement shows billed, not billed and unsettled lines.
  - An app filter (`appIds`) leaves owner-action rows out (they have no app).
- Why: link relays and identity tokens are usage partners are charged for or asked about; a report that hid them would
  disagree with the ledger CSV's row count.

### D325. The NEAR/USD rate: CoinGecko's daily history, ten days back, never replaced; the audited override
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/rates.ts`,
  `report-routes.ts` (`PUT /api/rates/:day`), `0006_reports.sql` (`usage.override_rate`, `usage.rate_overrides`) ·
  Source: spec "Crons", D93 Q17
- Decision:
  - Source `coingecko`: `/api/v3/coins/near/history?date=DD-MM-YYYY`, whose price is the 00:00 UTC snapshot of the
    date, so **a day's rate is its opening price**. The daily run fetches each of the last 10 UTC days (today included)
    without a rate, oldest first, one call each; a fetched rate never replaces an existing one; a price outside
    (0, 1 000 000] USD is refused. An optional `COINGECKO_API_KEY` secret is sent as `x-cg-demo-api-key`.
  - The override (`PUT /api/rates/:day {usd, reason}`, staff): `usage.override_rate` sets the rate with `source =
    'manual'` and the staff email as `entered_by`, and appends a `usage.rate_overrides` row (previous rate and source,
    who, why) in the same transaction; the table refuses UPDATE, DELETE and TRUNCATE. A reason of 10–500 characters is
    required; a future day is refused; a month with a statement is refused (the 0001 trigger). The console's
    `audit_log` also gets a `rate.overridden` row (D327).
- Why: the spec's audited override has to survive a rate being replaced twice; a row per change in Neon, written by the
  only path that can change a rate, is that audit.
- To confirm: the source is named in the service contract (D93); the history endpoint's rate limits on the free key.

### D326. Issuing a statement: refusals, keys, the commit point, the notice, the files served only by hash
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/statements.ts`,
  `statement.ts`, `statement-pdf.ts`, `alerts.ts` (`runStatementNotices`), `report-routes.ts`,
  `apps/console/src/reports.ts` · Source: spec "Monthly statements", D92
- Decision:
  - Refused (`409 conflict`, with the reason) before the 3rd of the next month 00:00 UTC, while a relayed event of the
    month has no settlement row, while a day of the month has no rate, and when the month was issued.
  - `as_of` = now. The rows are `usage.org_report` per day (the CSV's day rows) and per month (the totals: MAU and
    percentiles exact over the month), both at that `as_of`. Keys `statements/<org>/<YYYY-MM>/<as_of ISO>.{csv,pdf}`,
    uploaded with R2's `sha256` check before the `usage.statements` insert, the commit point; a failure before it
    leaves locked orphan files that nothing points at.
  - `totals` (console-core `statementTotals`) holds the per-app and per-scope totals as formatted decimals, the org's
    sums, and the billed and not-billed lines; console-core `statementView` renders the on-screen statement from it and
    the PDF prints the same view (A4 landscape, Helvetica; text outside WinAnsi shown as `?`; no producer, dates = the
    `as_of`), so the three views carry one set of numbers and the CSV's sha256.
  - The notice ("the feed emails the security contacts and `billing_email`"): the 15-minute run emails each statement
    without an `ops.statement_notices` row to the org's security contacts, its billing email and the alias, and
    writes the row once every send was accepted (at least once).
  - Downloads (admin, and the console's backend for C10) read the file and serve it only when its sha256 equals the
    one frozen in Neon, with `x-hana-sha256`; a mismatch is a 500 and an error line (tamper evidence at read time).
- Why: Neon's row is the only commit point the spec gives; the hash check costs one digest per download.

### D327. The admin's own acts are audited through `StaffRpc.recordStaffAction`
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/staff-rpc.ts`, `audit.ts`,
  `packages/console-core/src/staff.ts` · Source: spec "Monthly statements" ("audited (`statement.issued`)"), "Audit"
- Decision: a Hana-only `StaffRpc.recordStaffAction({orgId?, action, target?, details})` appends the `audit_log` row of
  an act with no RPC write of its own: `statement.issued` (month, both hashes, `as_of`, lines), `ledger.exported`
  (month, `as_of`, rows, hash) and `rate.overridden` (day, micro-dollars, override id). Details are each action's
  allowlist (another key is `bad_request`); a repeat of (request id, action) is `already_applied`. The statement's row
  uses the request id `statement_<org>_<month>`, so a retry can't add a second one. The row follows the act's own commit
  (the statement insert, the override); a failure is logged (`audit_failed`) and answered (`auditRecorded: false`),
  never undoing the act; the act's own record (the statement row, the override row) stays.
- Why: one audit trail for staff acts, merged with `app_changes` in the audit view, without a second audit store in
  the admin Worker.

### D328. The partner side: `ConsoleRpc.usage` / `statements` / `ledger`, and the console's backend for C10
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/src/usage/reports.ts`,
  `src/rpc/console.ts`, `apps/console/src/reports.ts` · Source: spec "RPC interfaces", "Console BFF routes", "Reports"
- Decision:
  - The three methods call the owner's functions over the writer's `USAGE_DB` and issue no hot-DB statement, so they
    carry no hot-DB cost. Per member: 60 a minute and 1 200 an hour (`RateLimiter`, `console-report:<user id>`); never
    `org_legacy`; the 400-day and 100-app limits are refused by the input schema before Neon (the function refuses them
    again). No `USAGE_DB` or a Neon failure is `internal`.
  - `statements` returns `StatementMeta` plus the stored totals and the file keys (server-side reads only; the console
    lists statements without them). `ledger` pages 1 000 rows, keyset `<request_id>,<at ms>`, and answers its `asOf` (now
    when not given) so every page of one CSV has the same bound.
  - The console's handlers (usage, statement list, on-screen statement, statement files, ledger CSV) are built and
    tested but not routed: C9/C10's session routes call them for a member of the org, as C11's logo routes. A statement
    file is read with `STATEMENTS.get` only, under the org's prefix, and served only when it matches its hash. The ledger
    CSV streams pages; a page failing after the first ends the file with an `# incomplete` line (at most 200 pages).

### D329. Exports, partitions and the admin's crons
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/statements.ts`
  (`exportLedger`), `ledger-cron.ts`, `crons.ts`, `scripts/gen-wrangler.ts`, `security.ts` · Source: spec "Crons",
  "Ledger CSV", D280, D308
- Decision:
  - **Exports** (`POST /api/exports/:org/:month {asOf?}`) write the ledger CSV to `EXPORTS` at
    `exports/<org>/<YYYY-MM>/<as_of ISO>-<request id>.csv` (under `exports/`, so D308's 30-day rule deletes them), with
    the sha256 and the final gas and NEAR sums in the answer, audited (`ledger.exported`). More than 200 000 rows is
    refused, never truncated. Staff download them with `GET /api/exports/:org/:month/:file`.
  - **Two cron triggers**: the spec's daily 00:30 UTC work (nonce check, rejection check, partitions, rate) runs in the
    15-minute trigger's 00:30 UTC tick, first, before that run's alerts, notices and settlement, all sharing its 40
    calls. A third trigger would put each env at six (API, watchdog, console, admin × 2 + 1) over the free plan's five
    per account.
  - `usage.ensure_partitions(12)` daily (the API's own horizon, so the two keepers agree; the spec's 3 would be a no-op);
    the security screen warns below 2 future partitions.
  - The admin config binds `STATEMENTS` and `EXPORTS` (`files.statementsBucket`, `files.exportsBucket`) and sets
    `RELAYER_ACCOUNT` (a statement names its network from C14's `NEAR_NETWORK`, and issuing refuses without it); settlement and the nonce check skip, logged every run, without `RELAYER_ACCOUNT`.

## Batch C13: retention (branch `feat/batch-c-13`), 2026-11-04

### D360. The monthly retention job rides the 15-minute trigger until a run of the month completes; at most 12 calls
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/retention.ts`,
  `retention-store.ts`, `ledger-cron.ts`; `apps/admin/test-ops/retention.test.ts` · Source: spec "Crons" (admin,
  monthly, the 1st 01:00 UTC), "Retention" ("Monthly purge job"), D90, D280, D329
- Decision:
  - **No trigger of its own**: as C12's daily work (D329), the job runs inside the `*/15` trigger, so the admin Worker
    keeps two triggers and the account stays at five (the free plan's limit). It is **due** from the 1st, 01:00 UTC,
    **until a run of that month ends `ok`**: a run that runs out of its calls ends `partial` and the next 15-minute run
    continues it; a `failed` run is retried an hour after it finished; a run still `running` after 30 minutes was killed
    (a deploy, a limit) and is closed as `failed` (`abandoned`). So a missed tick, a Neon outage or a backlog never skips
    a month: the job is state-driven (`ops.retention_runs`), not tick-driven.
  - **One run at a time**: a unique partial index on `ops.retention_runs (true) WHERE status = 'running'`; a second
    start is refused by the database, not by a check in the Worker (Hyperdrive pools in transaction mode, so a session
    advisory lock can't be used).
  - **Order and budget**: after the daily work and before the alerts (its `retention_failed` goes out in the same run).
    The Neon steps (`strip_uids` up to 20 calls of 10 000 rows, `drop_expired_partitions`, `ops.purge_expired`,
    `retention_due`) use the run's connection and no outbound call. **Every RPC** (`deletedApps`, `purgeDirectory`, both
    `purgeAudit`) **takes one call of the run's 40** (D280), at most 12 a run, so the job never starves settlement and the
    run stays under the free plan's 50 subrequests whatever the RPCs answer. (C12's own RPC reads, `relayerKeys` and the
    statement notices' two per statement, are not charged to the budget; see the note in the final report.) *Fixed by
    D380: they are, as is the ledger connection; the job's RPCs go through the metered bindings.*
  - Each step runs on its own; a failing one is recorded as the step and a code (an RpcCode, `pg_<SQLSTATE>` or a class
    name: never a message, which could echo data) and the others still run. The run's `rows` hold counts per table and
    the calls used.
  - The retention RPCs (`AdminRpc.purgeAudit` / `deletedApps` / `purgeDirectory`, `StaffRpc.purgeAudit`) take a
    **`system` actor only**: staff never purge by hand, and the BFF can't call them (it sends a `hana` actor). Each
    clamps the caller's `before` to its own period in SQL, so even a compromised admin Worker can't purge younger rows
    than D90 allows.
- Why: the spec's job, under the trigger limit and the call budget, without a way to lose a month.
- Rejected: a third cron trigger (six per account, over the limit); running the job in the 5-minute trigger (it has no
  ledger connection of its own and its budget belongs to the blocking notices); exactly one attempt at 01:00 (a failure
  or an outage would skip a month).

### D361. The erasure path: one script, `scripts/uid-erase.ts`, per scope, across the ledger and both directories
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `scripts/uid-erase.ts`,
  `scripts/lib/uid-erase.ts`, console-core `uidOfInternalId`; `scripts/test/uid-erase.test.ts` · Source: spec "CLI"
  (`uid:erase --scope --provider --sub`, the proposed `user:erase --provider --sub`), D269, D275, D276 (its open
  "whether `user:erase` lands here or with C13"), D310
- Decision:
  - The spec's `uid:erase` and D276's `user:erase` are **one command** (`corepack pnpm --filter @hana-id/scripts
    uid-erase <env> --scope --provider --sub|- --ticket [--remote] [--no-ledger] [--yes]`), so an erasure request can't
    clear one store and forget another. It lands in C13 (answers D276's open point).
  - **The unit is the account in one scope**, read from the chain (the source of truth): `get_identity` of the named
    identity, its root's `get_identity`, the root's `get_account` (members by key). A failed or malformed read stops it;
    the root is never guessed.
  - **The uids**: the root's (the account's internal id `hu_…`, D312, D346) and each known identity's own (a member's events from before
    it was linked carry its own uid), known = the named identity, the root and the members the wallet directory has a
    sub for; plus the uid of every wallet-directory user those identity keys point to (`uidOfInternalId`). USER_ID_KEY
    from `.secrets/<env>/user-id-key`, zeroed after use, never printed.
  - **The stores**: the ledger through `usage.erase_uid` as `usage_admin` (`.secrets/<env>/neon-usage-admin.url`); the
    wallet directory (the API's D1) through **a reviewed script, not AdminRpc**, with lib/d1.ts's private executor (D1's
    REST API as the operator, the statement never in a process argument, D316); the issuer's directory through the same
    CLI pattern as `user:*`. In the wallet directory: the users with their wallets and identities, and any identity row
    of the account's keys in the scope. In the issuer: the identities' `user_email_apps` rows of the scope, then each
    identity's `user_emails` row once it has no app row left in any scope.
  - **Dry run by default** (the plan with counts per store, the internal ids with the User ID and Support ID of each
    wallet-directory row, and the other scopes the
    account's identities are seen in: an erasure is per scope, run again for each). `--yes` erases, **re-counts** (any
    row left fails the command, nothing recorded; every step is idempotent, so it is simply run again) and records the
    erasure in `ops.erasures`: ticket, operator (`cli:<login>`), scope and counts, **never a uid, a sub or an address**.
    The ticket is required and may not hold `@` (it is stored). Testnet only, as every setup script.
- Why: the directories (D269, D310) postdate the spec's erasure, which covered the ledger only; an operator CLI keeps
  the destructive path out of the staff BFF and the admin Worker (which has no issuer binding, D365) and reuses the
  reviewed private D1 path.
- Rejected: `AdminRpc.eraseUser` for the wallet directory (a destructive staff RPC and a screen for a rare, ticketed
  act; the issuer would still need the CLI); erasing every scope at once (the uid is per scope, and a person may want
  one partner's data gone); erasing by the named identity alone (its account's rows sit under the root's uid).

### D362. `usage.erase_uid(uid)` erases by uid alone; the uid indexes move from C15 into 0007
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/migrations-usage/0007_retention.sql`;
  `apps/api/test-usage/retention.test.ts` · Source: spec "Usage ledger" functions (`usage.erase_uid(app_ids text[],
  uid bytea)`), build plan C15 (`events (uid, at) WHERE uid IS NOT NULL`, `app_users (uid)`)
- Decision: `erase_uid` takes the uid only and deletes its `app_users` rows and NULLs it on every event, **in any app**.
  A uid is an HMAC over the scope and one identity (D96), so every row carrying it is that user's: the spec's `app_ids`
  filter could only miss rows (an app deleted, or moved to another scope, that the script didn't list). The rows stay
  (billing and counts unchanged). 0007 also adds `events (uid, at) WHERE uid IS NOT NULL` (strip_uids' and erase_uid's
  reads, and C15's lookup), `app_users (uid)` and `app_users (last_seen)`; C15 needs neither index any more.
- Why: exact by construction and cheaper; the indexes are needed now.
- Rejected: the spec's signature (a correctness dependency on the caller's app list for no benefit).

### D363. An app deletion reaches the new stores: the wallet directory of a scope left without apps, the issuer's app rows
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/src/changes/retention.ts`
  `purgeDirectory`, `AdminRpc.purgeDirectory`; `scripts/lib/admin-retention.ts`; `apps/api/test/rpc-retention.test.ts`,
  `scripts/test/uid-erase.test.ts` · Source: spec "Retention" (`app_users`: app deleted + 30 days), D269, D310
- Decision:
  - **Ledger**: as the spec, `usage.purge_app_users` for each app `AdminRpc.deletedApps` lists (deleted 30 days ago or
    more), with a cursor so each month starts after the last app purged.
  - **Wallet directory**: users are per scope, not per app (0011), so an app's deletion purges them only when **the
    scope has no app left**: at least one app deleted 30 days ago or more and none live or deleted since
    (`AdminRpc.purgeDirectory`, in the monthly job). A scope with no app row at all is never purged (no time to count
    from). If a new app later uses the scope, its users reappear at their next login (no backfill).
  - **Issuer directory**: the `user_email_apps` rows of the deleted apps (30 days), by `admin retention:issuer` (D365).
    The identity's `user_emails` row **stays**: it is per identity across scopes, D269 sets no expiry for it (it is the
    record of an email user's `sub` should `K_sub` ever be lost), and an erasure request removes it (D361).
- Why: the safest reading of "an app deletion must also cover them": every per-app row goes with the app, as the
  ledger's do; per-identity and per-scope rows go only when nothing still uses them.
- To confirm: whether an identity's `user_emails` row with no app left should also expire (APP 11 argues for it; D269's
  `K_sub` reason against). Not built: it would change D269.
- Rejected: purging a scope's directory as soon as one of its apps is deleted (the other apps' users would vanish from
  the staff and partner views); keeping the directory of a dead scope for good.

### D364. The audit purges keep what drift detection and the gate still read
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/api/src/changes/retention.ts`
  `purgeAudit` (with `changes/drift.ts` `DRIFT_LEDGER_KINDS`), `apps/console/src/retention.ts`;
  `apps/api/test/rpc-retention.test.ts`, `apps/console/test/retention.test.ts` · Source: spec "Retention" (`audit_log`,
  `app_changes`, `guarded_changes`, `owner_grants`: 5 years, the triggers' constant), "Drift detection"
- Decision:
  - **`app_changes`** rows older than 60 months go, in batches, **except** for a live app that has a 0006
    `migration.baseline`: its baseline and every row that ends a baseline value (`origin.removed`, `origin.proposed`,
    `policy.removed`, `policy.activated`, `policy.pending_dropped`, `raw_sign.off`, or a CLI write whose `parts` name
    one). Drift detection reads exactly those (D228's rule); deleting the baseline of an origin still in force would
    raise a false `drift` event, and deleting a row that ended a value would let the baseline explain it again. Rows of
    a deleted app all go (drift skips deleted apps).
  - **`guarded_changes`**: only closed ones (`cancelled`, `ended`) closed more than 60 months ago that no origin row
    names, and every change of an app deleted more than 60 months ago. Open changes of a live app stay (the gate and
    drift explain what is in force with them).
  - **`audit_log`**: rows older than 60 months. **`owner_grants`**: grants applied or cancelled more than 60 months ago;
    an open grant stays.
  - The cutoff is `min(before, unixepoch('now', '-60 months') * 1000)`, the triggers' own clock, so a purge never trips
    `app_changes_no_early_delete` / `audit_log_no_early_delete`.
- Why: retention must not turn into a false security alert or weaken the drift check.
- Accepted: a legacy app's baseline-related rows (which may carry a partner member's `actor_sub`) outlive 5 years while
  the app lives.

### D365. The issuer's part of the job is an operator command, `admin <env> retention:issuer`
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `scripts/lib/admin-retention.ts`, `scripts/admin.ts`;
  `scripts/test/uid-erase.test.ts` · Source: spec "Retention" (issuer `email_admin_audit`: "an issuer purge to add with
  C13"), D269, D275, D276 ("`DirectoryRpc` stays read-only")
- Decision: the admin Worker has **no binding to the issuer** (C8b isn't built, and D276 keeps `DirectoryRpc` read
  only), and the issuer can't get a cron (a sixth trigger). So the issuer's monthly part is the CLI, as the task's
  `scripts/lib/admin-users.ts` / `d1.ts` pattern: the apps deleted 30 days ago or more from the API's D1 (ids only),
  their `user_email_apps` rows deleted in the issuer's D1, and the issuer's **`email_admin_audit` rows older than 60
  months** (5 years, as the other audit logs: the spec's open point). Dry run by default; `--yes` deletes. The admin
  console's Retention screen names the command, and `docs/operations.md` "Retention" says to run it after each month's
  job.
- Why: no new key-holding-Worker code or binding in C13; the CLI path is already reviewed for the issuer's D1.
- To confirm / revisit with C8b: a narrow issuer entrypoint the admin job could call (`RetentionRpc.purge()`, computing
  its own cutoffs and reading the deleted apps from its `APP_DB` itself), so this step is automatic and shows on the
  screen.
- Rejected: an issuer D1 binding in the admin Worker (D275 (a): read-write on the whole database).

### D366. Nothing erasure or retention does touches what derivation depends on
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `scripts/lib/uid-erase.ts`,
  `0007_retention.sql`, `apps/api/src/changes/retention.ts` · Source: task brief; `docs/architecture.md` "Key
  derivation"
- Decision: the chain stays the source of truth for identities, accounts and paths, and nothing here writes to it; the
  directories and the ledger are indexes and history. `K_sub`, `USER_ID_KEY`, the CKD inputs and the vault's shares are
  untouched (an erasure doesn't revoke live sessions: the user can do that, and a share is keyed by `sha256(path)`, not
  by the uid). An erased user who logs in again through Hana gets the same wallets, and new rows are written; a new
  request covers those. Not an address-derivation change, so no address-freeze call-out applies.
- Why: an erasure of Hana's records must never cost a user their funds.

### D367. `retention_failed`: one digest a day for failures, once a month overdue, the due tick for a skipped run
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/retention.ts`
  `runRetentionAlerts`, `sendRetentionSkipped`, `email/ledger-messages.ts` `retentionFailed` · Source: spec "Email"
  (direct `retention_failed`), "Retention" ("a failed or skipped run emails `retention_failed` to the security alias and
  shows as a warning until a run succeeds")
- Decision:
  - **Failed**: the failed runs not yet emailed, as one digest to the alias, **at most one a day** (a failing step
    retried hourly would otherwise send 24); a failure whose month has since completed is marked without an email. Each
    run's `alerted_at` is set once the provider accepted the send (retried every 15 minutes otherwise).
  - **Overdue** (a skipped month): no `ok` run a day after the 1st 01:00 UTC, once a month (`ops.state`
    `retention.overdue_alerted`): runs that keep ending `partial`, or none at all.
  - **Skipped** (no ledger at the due tick): nothing can be recorded, so the email goes from the due tick only (the 1st,
    [01:00, 01:15) UTC), with the provider's idempotency key per month.
  - The screen warns while the last run failed or the month has no complete run an hour after it was due.
- Why: the spec's "failed or skipped" without an hourly email storm.

### D368. The periods the spec left open
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `0007_retention.sql` (`ops.purge_expired`,
  `drop_expired_partitions`, `retention_due`, `ops.erasures`) · Source: spec "Retention" (`ops.*`: "current;
  nonce_checks 400 days")
- Decision: `ops.rejection_alerts` 400 days (as `nonce_checks`); `ops.scope_watch` rows notified 400 days ago (a
  pending one never); `ops.retention_runs` and `ops.erasures` 60 months (audit), `ops.erasures` append-only by a trigger
  that holds for the owner too; `usage.identity_tokens`, `usage.email_counts`, `ops.settlement_alerts` and
  `ops.settlement_tries` with the 7-year months (usage records of the settled months); `ops.statement_notices` stay
  with the statements. Statements, rates and rate overrides past 7 years are **counted** (`usage.retention_due`, the
  screen's "Waiting for a person") and deleted by hand after review (`docs/operations.md` "Retention").
  `drop_expired_partitions` runs with `lock_timeout = 5s`: a detach waiting behind a long report fails and is retried
  rather than queue the writer's inserts behind it.
- Why: every table gets a period; none longer than its purpose.

### D369. The shapes the spec didn't fix: `deletedApps` pages, `strip_uids` batches, a read-only screen
- Date 2026-11-04 · Status: decided while building, to confirm · Built: console-core `retention.ts`,
  `apps/admin/src/retention-routes.ts`, `public/app.js` · Source: spec "RPC interfaces" (`deletedApps(c: Ctx & {before})
  : {appIds}`), "Usage ledger" (`strip_uids()`, "batches of 10 000"), "Admin BFF routes" (`GET /api/retention`)
- Decision:
  - `deletedApps({before, after?, limit?})` → `{appIds, next?, more}`: oldest deletion first, a `<deleted_at>:<app id>`
    cursor, ≤ 1000 a page (additive to the spec's `{appIds}`); the job keeps the cursor in `ops.state`. Each RPC's
    `limit` is 1–1000 (the job uses 500).
  - `usage.strip_uids(max_rows)` → `(events, app_users, more)`: the job calls it until `more` is false (≤ 20 calls a
    run of 10 000).
  - `GET /api/retention` is read only: the month's state and next run, the warning, the last 24 runs with rows per
    table and errors, what waits for a person, and the last 20 erasures. No "run now" button: the job is due by state,
    and a person who needs it sooner fixes the cause of a failure.
- Why: unbounded lists and single statements over a month of uids don't fit a Worker's limits.

## The partner console's report, statement and pending-upgrades screens (branch `feat/console-reports-upgrades`), 2026-11-04

The SPA screens over C12's report backend and C14's pending-upgrades route, both routed by C10 (D358) and left for a
follow-up there.

### D370. Three tabs for any member: Usage, Statements, Pending upgrades; reads only, frozen orgs included
- Date 2026-11-04 · Status: decided while building, to confirm · Built on `feat/console-reports-upgrades`
  (`apps/console/web/src/pages/{Usage,Statements,Upgrades}.tsx`, `App.tsx`, `Shell.tsx`) · Source: spec "Roles and
  permissions" ("View … usage, statements": owner and viewer), D86 Q11, D335, D356
- Decision: the org shell gets the tabs Usage (`/orgs/:org/usage`), Statements (`/orgs/:org/statements`, one statement
  at `/orgs/:org/statements/:month`) and Pending upgrades (`/orgs/:org/upgrades`), shown to every member (owner, viewer,
  a pending owner) of an active or a frozen org, as the server's routes allow (`role: 'viewer'`, `frozenOk: true`). The
  screens have no write control, so there is no owner gate and nothing for a freeze to hide; a frozen org shows them
  under the shell's frozen note. The tab doesn't fetch the pending-upgrades view to badge itself (each read costs 2 in
  the org's hot-DB budget, D335).
- Rejected: hiding statements from viewers (the spec gives viewers usage and statements); a pending-upgrades badge on
  every org page.

### D371. A statement's issuer is shown to partners as `hana`, never the staff address
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/console/src/reports.ts` (`listItem`),
  `test/reports.test.ts` · Source: D296 ("an actor … that isn't a `usr_…` id is `hana`")
- Decision: C12's console backend passed `issuedBy` (the staff member's address the admin Worker records) through to
  the statement list and the on-screen statement. Statements are only issued by staff, so the console's answers now say
  `issuedBy: "hana"`, and the SPA shows "by Hana" without reading the field. Neon's `usage.statements.issued_by` and the
  admin console keep the address.
- Why: D296's rule for every partner view; a partner had no need for it.
- Rejected: dropping the field (StatementMeta's shape is the spec's).

### D372. Downloads are plain links to the console's routes; the hashes beside them; the ledger at the statement's as_of
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `web/src/pages/Statements.tsx` · Source: spec
  "Monthly statements" ("partners download the same files read-only … with the sha256 beside them"), "Ledger CSV", D92,
  D326
- Decision:
  - The statement CSV and PDF and the ledger CSV are `<a href download>` links to `/api/orgs/:org/statements/:month.csv`,
    `.pdf` and `/ledger/:month.csv`: the browser follows them with the `SameSite=Strict` session cookie (a same-origin
    GET, no CSRF header needed) and saves what the Worker sends. The SPA never fetches a file, builds a blob or computes
    a hash, so what is saved is exactly what the Worker checked against Neon's sha256.
  - The CSV's sha256 (the statement hash) and the PDF's are printed beside the links with the `shasum -a 256` check.
    The PDF link appears only when the statement has a PDF.
  - The ledger CSV of a month with a statement is linked at that statement's `asOf` (`?asOf=`), so its final gas sums
    to the statement's Tgas and NEAR (spec "Ledger CSV"); any other month's is as of now. The page says what an
    `# incomplete` last line means.
  - A refused download (a session that ended, a missing or tampered file) shows as a failed download in the browser,
    or in some browsers saves the error's JSON under the file's name; the page can't show the error without fetching
    the file itself. Accepted: the routes refuse only on faults, and reloading the page shows the session state.
- Rejected: fetching the file and saving a blob (the browser would build the file; it also needs the whole ledger in
  memory); a check request before each download (one more read of the rate-limited RPC per click).

### D373. The usage screen shows the server's rows as they are: every statement count, exact NEAR and USD, no totals added
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `web/src/pages/Usage.tsx`, `web/src/units.ts`
  · Source: spec "Reports", D324, D297
- Decision:
  - The form: from, to (UTC days, this UTC month by day by default), by day or month, and an app filter (the org's apps
    as checkboxes; none ticked = every app and the owner-action rows; ticking any leaves the owner actions out, D324,
    and the page says so). A start after the end isn't sent; the 400-day and 100-app limits are the server's and its
    refusal is shown.
  - The table has a column for each count the statement CSV has (logins, derives, revokes, unlocks, owner actions,
    link actions, identity tokens, active users, new users, failures by code), then Tgas with its relayed-then-rejected
    and error parts, NEAR and USD with their relayed-then-rejected parts, p50 / p95 latencies and unsettled events.
    "After the statement" (late events) is a column only when a row has one.
  - NEAR and USD are formatted from `burntYocto` and `usdMicros` with the SPA's own copy of console-core's
    `formatUnits` (the SPA imports only types from console-core, D297); a test checks the two agree. A period without
    a NEAR/USD rate shows "—", not 0.
  - The page adds nothing up: active users can't be summed, and the monthly statement is the billing total.
  - Aggregates only: no row has a user field, so no end user is named.
- Rejected: a totals row computed in the browser (it could disagree with the statement).

### D374. Pending upgrades: countdowns on the reader's clock without a reload; "not a published release" as an alert
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `web/src/pages/Upgrades.tsx`, `web/src/lib.tsx`
  (`useNow`, `countdown`) · Source: D86 Q11, D333, governance-spec "Alerts"
- Decision:
  - The page shows the signer and env, when the chain was read, the governance delay, the pause state (an alert), and
    each pending item: the upgrade (code hash, proposed, takes effect), an owner transfer, a withdrawal (exact NEAR from
    yocto), shorter delays (now → becomes) and new console audiences. With a published release: its version, source
    commit, reproducible-build command and the diff command to the release before it ("the first published release"
    when there is none). Without one: **Not a published release** as an alert, telling partners to treat the upgrade as
    unexplained and ask Hana.
  - Countdowns are `atMs − now` on the reader's clock, re-rendered every 30 s; the view itself is read once (a "read
    the chain again" button, and "Try again" after an error such as `503 near_unavailable`). An item past its time, or
    one the view marks `due`, says it can be executed or accepted now.
  - Everything shown is contract-wide and public on chain; the page carries nothing of the org or its users.
- Why: a countdown that only moves on reload misleads; re-reading the chain every 30 s would spend the org's budget for
  no new information (the timelocks don't move).
- Rejected: polling the route; showing the raw yoctoNEAR amount only.

## The admin crons' call budget (branch `fix/admin-cron-budget`), 2026-11-04

### D380. Every outbound call of an admin cron run comes out of its 40, RPCs and the connection included; at most 30 RPCs
- Date 2026-11-04 · Status: decided while building, to confirm · Built: `apps/admin/src/mail.ts` (`Budget`,
  `metered`, `meteredEnv`, `RPC_BUDGET`, `OutOfBudget`), `cron.ts`, `ledger-cron.ts`, `notices.ts`, `feed.ts`,
  `watcher.ts`, `alerts.ts`, `retention.ts`; `apps/admin/test-ops/budget.test.ts` · Amends D280, D322 and D360
- The bug: D280 counted emails and `get_scope` only, with "room for the RPC calls between them". C12 added RPCs that
  weren't charged (`AdminRpc.relayerKeys` every 15-minute run, two reads per statement notice: up to 11 a run), and
  the 5-minute cron's own RPCs weren't either (the notice pages, every ack, an org's name and contacts, the feed's
  pages, lookups and marks, `listScopes`, `listApps` / `getApp`): a full page of 20 change notices is 20 acks beside
  its emails. A worst-case run could pass the free plan's 50 subrequests and fail part-way (a notice emailed and not
  acked, a cursor not stored).
- Decision:
  - **What counts** (Cloudflare's docs, read 2026-11-04, cited in `mail.ts`): every `fetch` (Resend, NEAR, CoinGecko;
    Workers limits, "Subrequests"); every service-binding call ("Each request to a Worker via a Service binding counts
    toward your subrequest limit", Service bindings, "Limits"); R2, KV and D1 (the crons use none). Hyperdrive isn't
    named as a subrequest anywhere: `pg` opens one socket per run with `connect()`, which the docs count only toward
    the six simultaneous connections. Charged anyway, one call per run's connection (the 5-minute run sets it aside
    before the notices); the queries on it take none.
  - **At most 30 RPCs** a run (`RPC_BUDGET`, inside the 40): "A single request has a maximum of 32 Worker invocations,
    and each call to a Service binding counts towards this limit"; the cron's own invocation is one.
  - **Enforced at one place**: each job meters the bindings it is given (`meteredEnv`, a no-op on a binding already
    metered by the same budget), so a call without budget left is refused (a rejected `OutOfBudget`) instead of made,
    and an RPC added later can't go uncounted. `Budget.as(job)` records each job's share: the 15-minute run's summary
    and `ledger_cron` `budget` line, the 5-minute run's `cron.last_run` and `cron` `budget` line (`calls`).
  - **Clean stops**: before each unit of work a job checks that all of it fits (`fits(calls, rpcs)`): a change notice
    with every email and its ack; an invite with its org's lookups, every email, the link and the ack; a digest with
    its org's contacts, every email and (security events) the mark; a scope with its `get_scope` and its org's
    contacts, a SetAllowShared's `listApps` and `getApp`s with its emails; a statement's two reads and at least the
    alias. A page is read only with room for one unit after it. What doesn't fit waits whole: the next run carries on
    from the cursors, the queues and a `partial` retention run, as settlement and retention already did.
  - The order and priorities stay (D280, D322, D329, D360). `RUN_BUDGET` stays 40: the 10 under 50 are now a margin
    for what the docs leave open, not room for uncounted calls. Settlement reads at most 38 a run (was "about 35"),
    fewer in a run that also sends notices or runs the monthly job. The shares and the measured worst cases are in
    `docs/operations.md` "The crons' call budget".
- Why: a run that dies at its 51st subrequest loses work in the middle of a step; a budget that counts every call can't.
- Trade-offs: a statement notice whose recipients turn out not to fit has spent its two reads (and an invite its
  lookups); they are read again next run. In a run where the blocking notices take everything, the feed and the
  watcher wait (by design: the notices hold changes back).
- To confirm (unsure from the docs): (1) whether a service-binding callee's own subrequests (the API's D1 queries inside
  an `AdminRpc` call) count toward the caller's 50; if they do, one RPC costs more than one call and the budget is too
  generous: measure on sandbox-dev before M4 (a run with a full notice page, `wrangler tail`). (2) Whether Hyperdrive's
  socket counts at all (charged here). (3) Whether the 32-invocation limit is the total or the depth of a request's
  calls (the total assumed).
- Rejected: charging RPCs by hand in the jobs that make them (D360's way: the next RPC added would be missed again);
  raising the budget to 48 (no margin for the open questions); a fixed share per job (an idle job's share would be
  wasted while a backlog waits).

## WebKit Linux's Ed25519 keys and the e2e flakes (branch `fix/e2e-flakes`), 2026-11-05

### D381. The session key's WebCrypto `generateKey` is asked again after an `OperationError`, up to 4 attempts
- Date 2026-11-05 · Status: decided while fixing CI's Playwright flakes, to confirm · Built:
  `packages/core/src/session.ts` (`newSessionKey`, `SESSION_KEYGEN_ATTEMPTS`); tests: `packages/core/test/layouts.test.ts`
  ("D381"), `apps/e2e/tests/login.spec.ts` ("D381")
- The bug: WebKit's Linux ports (WebKitGTK and WPE: GNOME Web, embedded WPE browsers, Playwright's Linux WebKit, the
  one CI runs) reject Ed25519 `generateKey` with an `OperationError` about 1 time in 100 (measured 2026-11-05 in
  Playwright 1.64.1's Linux WebKit: 29 and 28 of 3 000; the macOS build, Chromium and Firefox: 0 of 3 000). None of the
  keys it does return has a public key starting with a zero byte (0 of 5 943, where about 23 are expected), so the keys
  with a leading zero byte look like the refused ones. The vault's login (and a link, and the export window's fresh
  sign-in) makes its session key right after reading the app config, so the error ended the login at once: not a
  `VaultError`, so `api_unavailable` ("The request failed"; the demo: "Could not reach Hana's service"), and the SDK
  closed the popup it had just opened, about 100 ms after opening it. That was CI's recurring WebKit flake
  (`popup-close.spec.ts` "to Google and back, slowly" and `demo.spec.ts`'s cancelled sign-ins): the popup closed before
  its own script ran.
- Decision: `newSessionKey` asks again when `generateKey` rejects with an `OperationError`, up to
  `SESSION_KEYGEN_ATTEMPTS` (4) in all; four refusals in a row (about 1 in 10^8 there) and any other error (Ed25519 not
  supported, say) still reject as before. Each attempt is a fresh random key, so nothing about the key changes: no
  layout, nonce, path or address depends on which attempt succeeded.
- Why: a real user on a Linux WebKit browser lost about one login in 100 to an error that tells them to check their
  connection; retrying costs nothing where it doesn't fail.
- Rejected: a different error code for a WebCrypto failure (it would still fail the login); generating the key from
  our own randomness and importing it (the key must stay non-extractable WebCrypto, and an import path in WebKit Linux
  may have the same leading-zero bug); a test-only workaround (the flake is the product failing).
- Addendum 2026-11-05 (D385, branch `fix/webcrypto-linux-webkit`): the refused keys are those whose **seed or** public
  key starts with a zero byte (2 in 256, about 1 in 128): 39 of 5 000 refused, and none of the 4 961 keys returned had
  either (about 19 of each expected); four refusals in a row are about 4 in 10^9, not 10^8. The import path does have
  the bug: a PKCS#8 import of a seed starting with `0x00` fails (`DataError`, 33 of 33), a JWK import of it works. A
  key it still can't make is no longer `api_unavailable`: D385 gives it `derive_failed` with a reason, which amends the
  first "Rejected" item (the login still fails, but the error now says why).

### D382. The outside identity-JWKS probe runs hourly, not every 15 minutes
- Date 2026-11-05 · Status: **confirmed by the user** · Built: `.github/workflows/identity-probe.yml` (`17 * * * *`) ·
  Amends D210
- Context: on 2026-11-04 the Hana-Technology org's GitHub Actions stopped starting jobs ("recent account payments have
  failed or your spending limit needs to be increased"): the org's included minutes are shared by every repo, and
  GitHub bills each job at least a minute. The probe takes about 3 s but every 15 min is 96 jobs a day, about 2 900
  billed minutes a month on its own, more than a whole free allowance.
- Decision: hourly, at minute 17 (off the top of the hour, when GitHub's scheduler delays and drops the most runs):
  about 720 billed minutes a month. The watchdog's own pin check (every run, from Cloudflare) is unchanged.
- Trade-off: a key of an attacker's own that is served to the probe is now caught within the hour rather than 15 min
  (the watchdog still catches one it is served within one run). Neither check closes D210's gap (an attacker can
  single out partners' traffic), so the probe's interval narrows less than it costs.
- Revisit at the mainnet-readiness check: 15 min again (about $17 a month at GitHub's Linux rate) or a cheaper outside
  runner.
- Rejected: keeping 15 min on testnet (it alone uses up the org's minutes and blocks CI); dropping the probe (the
  watchdog's fetches can be told apart, D210).

### D383. CI runs only the jobs a change can affect; WebKit and Firefox nightly; the identity probe every 3 hours
- Date 2026-11-05 · Status: **asked for by the user** (implementation choices: to confirm) · Built:
  `.github/workflows/ci.yml` (job `changes`, the gates, the nightly schedule), `scripts/ci-changes.mjs`,
  `.github/workflows/identity-probe.yml` (`17 */3 * * *`) · Amends D382
- Context: Nov 1–5 hana-id used about 2 270 billed Actions minutes (about $13.60 at $0.006 a minute; the org's
  included minutes, shared by every repo, were already used up). About 14 pushes a day to `develop` each ran every
  job (about 33 billed minutes): sandbox e2e 698 min, Playwright 526, TypeScript 424, the probe 303 (most of it
  before D382). Only 5 of the 73 `develop` commits touched `contracts/`, and 17 changed only docs.
- Decision: a `changes` job decides per run (docs/operations.md "CI and git"). The Rust jobs run only for changes
  under `contracts/` or the three files the Rust tests read outside it; Playwright and the pack check only for changes
  outside `docs/`, `contracts/` and Markdown; gitleaks and the TypeScript job always (its tests read docs and
  contracts). A push is measured from the last successful push run on its branch, not the previous commit, so a
  cancelled or failed run's changes are tested again. Playwright runs Chromium on pushes and PRs; WebKit and Firefox
  nightly on `develop` (when web code changed since the last good nightly), all three on `main` and manual runs. The
  probe runs every 3 hours at :17 (about 240 billed minutes a month, from about 720).
- Trade-offs: a WebKit- or Firefox-only regression (D381's was one) is caught within a day, not on its push; a new
  Rust read outside `contracts/` that isn't added to the script would skip the Rust jobs (a test fails for the
  `repo root` reads the Rust tests make today, and `main` and manual runs always run everything); a key of an
  attacker's own served to the probe is caught within 3 hours rather than one (the watchdog's check is unchanged,
  and neither closes D210's gap).
- Revisit at the mainnet-readiness check: with D382's question (the probe's interval or a cheaper outside runner).
- Rejected: `dorny/paths-filter` (a third-party action with the repo's checkout; the script is short and tested);
  skipping the TypeScript job for docs-only changes (`packages/playbooks` tests read `docs/`); measuring a push from
  `github.event.before` (a cancelled run's changes would never be tested); disabling `cancel-in-progress` instead (it
  costs the minutes back).

### D384. Every Worker and page bundle carries a build id; `deploy-check` compares them after a deploy
- Date 2026-11-05 · Status: **asked for by the user** (implementation choices: to confirm) · Built:
  `packages/env/src/build-id.ts`, `local-build.ts`; `apps/api/scripts/deploy.ts`, `src/build.ts`, `src/pages/host.ts`
  (`/.well-known/hana-build`), `GET /v1/health` `build`; `apps/email-issuer/scripts/deploy.ts`, `GET /v1/email/health`;
  `packages/web/scripts/build-vault.ts`, `build-auth-pages.ts`; `scripts/lib/deploy-check.ts` · Number note: D384
  was the next free number on `origin/develop` (D383) and on the in-flight branches checked; a branch racing this
  one may take it too: renumber on merge
- Context: on 2026-11-05 sandbox-dev's page Workers were deployed with a stale `packages/web/dist` build, so the vault
  sent wallet records the new API refused (`400`), and the same day a D1 migration was applied from a checkout older
  than the code deployed. Nothing showed which commit each piece ran; `deploy:pages` now builds first, but nothing
  checked it.
- Decision: a build id = the commit's first 12 hex characters, `-dirty` when the working tree has any change (tracked
  or untracked). The Workers get it as the var `HANA_BUILD`, passed only at deploy time by each app's `deploy` script
  (`wrangler deploy --var HANA_BUILD:<id>`), never by `gen`; a raw `wrangler deploy` leaves it unset (`null`). The page
  bundles get it from the web build: `/vault.js` starts with `/* hana-build <id> */` (esbuild `banner`), each auth page
  has `<meta name="hana-build">` (in the HTML, so the content-hashed scripts don't change with each commit). Read
  back from `GET /v1/health` (`build`, additive), `GET /v1/email/health` (new), `GET /.well-known/hana-build` on each
  page Worker (new; JSON with the 404's headers) and the bundles themselves, by `deploy-check <env> [--d1]
  [--skip-head] [--strict]`: exit 1 unless every piece is stamped with this checkout's commit; `--d1` adds `wrangler d1
  migrations list --remote` for the API's and the issuer's D1. A dirty deploy warns (`--strict` fails it). The
  runbook runs it after each deploy step and applies migrations from a checkout at the deployed commit.
- Why: the stale part on 2026-11-05 was the assets, not the Worker script, so the bundles carry their own id;
  stamping at deploy time (not in the generated config) means a config generated earlier can't carry an old id, and an
  unstamped Worker is a failure rather than a pass.
- Limits: `migrations list` matches names only (`d1_migrations` keeps no hash), so a same-named file with other
  content (the 0011 draft) is invisible to it; the checkout rule covers that. The id is reported by whoever deploys: a
  hygiene check, not an attestation. The watchdog, console, console-auth, admin and files Workers aren't stamped yet.
- Rejected: the build time in the id (rebuilds of one commit would differ, and the auth bundles' hashes would change
  every build); writing `HANA_BUILD` in `gen` (a config generated before a pull would stamp the wrong commit);
  esbuild/wrangler `define` for the Workers (the Worker tests would need it too; a var reads the same); Cloudflare's
  version metadata (its version id says nothing about the commit, and reading a `--tag` needs a `version_metadata`
  binding on every Worker); a response header on every page (a route is checked once and leaves the pages' headers
  unchanged).

## The vault's WebCrypto failures and the WebKit Linux audit (branch `fix/webcrypto-linux-webkit`), 2026-11-05

### D385. A session key the browser can't make is `derive_failed` with `data.reason`, not `api_unavailable`; the other WebCrypto calls are unaffected by WebKit Linux's zero-byte bug
- Date 2026-11-05 · Status: decided while following up D381, to confirm · Amends D381 (its first "Rejected" item) ·
  Numbered D385 because D384 is taken on `chore/ci-cost` (not merged when this was written) ·
  Built: `packages/core/src/session.ts` (`sessionKeyFailure`), `packages/web/src/vault/errors.ts` (`sessionKeyError`),
  `vault/login.ts` (the login and `hana_linkAccount`), `auth/export-page.ts` and `auth/errors.ts` (`sessionKeyText`),
  `apps/demo/src/errors.ts`; tests: `packages/core/test/layouts.test.ts`, `packages/web/test/vault/login.test.ts`,
  `vault/linking.test.ts`, `auth/export-page.test.ts`, `apps/demo/test/errors.test.ts` (all "D385"),
  `apps/e2e/tests/login.spec.ts` ("D385"), `apps/e2e/tests/webcrypto.spec.ts`
- The error: when `newSessionKey` rejects (Ed25519 missing from WebCrypto, or D381's `OperationError` four times in a
  row), the login, a link and the export window's sign-in now end with `derive_failed` and `data.reason`
  `webcrypto_unsupported` (a `NotSupportedError`, or no `crypto.subtle`: Chrome and Edge before 137, Firefox before
  129, Safari before 17) or `webcrypto_failed` (anything else), with `data.error` the platform error's name when it
  is a plain identifier (never its message). Before, it was not a `VaultError`, so `api_unavailable` ("The request
  failed"; the demo: "Could not reach Hana's service"). The key is made right after `GET /v1/app`, so the login ends
  before the popup gets its parameters and before any `/v1/login`. The export window says "This browser can't create
  the key the sign-in needs. Update it, or use another browser." (or "… Try again."); the demo says the same.
- Why an existing code: `derive_failed` already means "the key couldn't be produced; log in again" in the partner
  guide, and the export window already used it for a start that failed. A new code would be a partner-visible change
  that SDKs already installed can't read: the SDK validates a reply's code against its own list, so an older SDK
  would get a malformed reply (`-32603`) instead. `data.reason` is how the vault already refines a code
  (`link_restart`), and old SDKs pass `data` through. `storage_unavailable` was the other candidate (its advice is
  "try another browser"), but it means blocked storage, and its "allow site data" advice would mislead.
- The audit (2026-11-05, Playwright 1.64.1: macOS WebKit 27.2, Chromium 156, Firefox 157, and the same in
  `mcr.microsoft.com/playwright:v1.64.1-noble` with 2 CPUs): every `crypto.subtle` call on the login, export and
  signing paths, each with 3 000 random keys (5 000 for key generation) and fixed vectors made by Node's OpenSSL and
  `@noble/curves`, with keys starting with zero bytes. WebKit Linux fails only (a) Ed25519 `generateKey`: 20, 19, 23,
  26 and 39 refusals in runs of 3 000, 3 000, 3 000, 3 000 and 5 000 (`OperationError`), and none of the keys it
  returns has a seed or public key starting with `0x00`; (b) a PKCS#8 import of an Ed25519 private key whose seed
  starts with `0x00` (`DataError`, 33 of 33 fixed seeds, 7 of 3 000 random); (c) the same two for X25519. Hana makes
  only (a), already retried (D381). Everything Hana imports passes in all six browsers: AES-256-GCM raw keys (the
  relay keys, K_s; 3 081 vectors, 81 with leading zero bytes, the all-zero key), HKDF-SHA-256 raw PRKs (3 081, same
  bytes as Node), Ed25519 raw public keys (3 100, at least 67 starting with `0x00`, 3 of them with `0x0000`), RS256
  JWKs (400), and session keys restored from IndexedDB (300). No address depends on WebCrypto at all: CKD, the chain keys and their
  signatures are `@noble` (`docs/architecture.md` "WebCrypto on the login, export and signing paths"), so nothing here
  changes a derivation or an address. Also seen: Safari on macOS signs Ed25519 with a random nonce (valid, not RFC
  8032's bytes); nothing depends on a session signature's bytes.
- Rejected: a new public code (`browser_unsupported`, say: older SDKs would see a malformed reply, above); a JWK
  import for the session key to avoid the PKCS#8 bug (Hana imports no private key; the session key is generated
  non-extractable); retrying the other calls (none fails).
## The COOP canary before each release (branch `feat/coop-canary`), 2026-11-05

### D386. A manual pre-release COOP canary checks D347's assumption, in place of `curl -sI`
- Date 2026-11-05 · Status: **agreed by the user** (2026-11-05, "the canary: agreed", as a manual pre-release check;
  the rules and the controls below: decided while building, to confirm) · Built: `scripts/coop-canary.ts`,
  `scripts/lib/coop-canary.ts` (`coop-canary` in `scripts/package.json`); tests: `scripts/test/coop-canary.test.ts`;
  the `google-enforces-coop` playbook (`packages/playbooks/src/incidents.ts`) · Amends D347 ("recheck (`curl -sI` on
  the authorization URL) before each release")
- Context: D347's popup-close watch reads the vault's handle on the popup every 250 ms; an enforcing
  Cross-Origin-Opener-Policy on a page of the popup's trip makes the handle read `closed` while the window is open.
  Google sends `cross-origin-opener-policy-report-only: same-origin` on its authorization endpoint, the identifier page
  and the account chooser, nothing on consent, and enforces `same-origin` on `/signin/oauth/error` (2026-11-05: `curl`, and
  Playwright in Chromium, Firefox and WebKit, where `.closed` flips about 0.5 s after the error page loads). A `curl
  -sI` of one URL misses the hops after the redirect, the User-Agents Google varies on, and what browsers do.
- Decision: `corepack pnpm --filter @hana-id/scripts run coop-canary <env>` before each release (docs/operations.md
  "Before each release: the COOP canary"), run by hand: no GitHub Actions workflow (the org's minutes, D383). It
  builds the requests with the product's own builders (`packages/web/src/auth/google.ts`: token_first's first
  request, D273's interactive retry, the silent ID-token request) for the env's first shared client and
  `authOrigin + /login/callback`, signed out, and:
  - Header check: follows each by hand (manual redirects, a cookie jar it never prints) under six browser
    User-Agents; any hop other than Google's OAuth error page with an enforcing COOP other than `unsafe-none`
    (unknown and doubled values included), or an enforcing COEP other than `unsafe-none`, fails; report-only headers
    and CORP never do. A chain that ends on the error page, on a non-200, or away from Google's sign-in page (Hana's
    callback for the silent request) fails too: the request itself is refused.
  - Browser check (apps/e2e's Playwright, headless): a localhost opener `window.open`s the first request and reads
    `.closed` every 250 ms for 10 s; `true` while the popup is open fails; a real close must then read `true`.
  - Positive controls: the same request with a redirect URI no client registers (`https://coop-canary.invalid`)
    must reach the error page with an enforcing COOP (header check) and flip `.closed` in each browser. If a control
    doesn't, the canary can't see an enforcing page and the run is inconclusive, never a pass.
  - Exit 0 pass, 1 a finding, 2 inconclusive (network, browsers missing, a control). `--headers-only` skips the
    browsers. It prints status, host and path per hop and the policy headers only: no cookie, query value or fragment.
- Why: it checks every hop and browser the product meets, and its controls show it can see an enforcing page.
- Rejected: a scheduled workflow (Actions minutes; a release is when it matters); following redirects with the fetch
  default (the hops' headers would be lost); the signed-in pages (account chooser, consent): they need a Google
  account and its cookies in the canary, which no script may hold (CLAUDE.md); report-only as a finding (Google has
  sent it since before batch B).
- Note: built as D385 and renumbered D386 at merge (D384 went to `deploy-check`, D385 to the WebCrypto errors).
### D394. The Support ID lookup: the hot-DB part in `AdminRpc`, the ledger part read as `usage_admin` by the admin Worker and the CLI
- Date 2026-11-05 · Status: decided while building C15 (the design confirmed by the user as D276's 2026-11-05
  amendment; these details: to confirm) · Built: console-core `support.ts`; `apps/api/src/directory/support.ts`,
  `AdminRpc.supportLookup` / `userShares`; `apps/admin/src/support.ts` (`POST /api/support/lookup`); tests
  `apps/api/test/support-lookup.test.ts`, `apps/admin/test/support.test.ts`, `apps/admin/test-ops/support.test.ts`,
  `packages/console-core/test/support.test.ts` · Source: D96, D144, D276, D346
- Decision:
  1. **Input**: a Support ID (any case, `HANA-` and dashes optional), a User ID (`u1_…`) or an internal id (`hu_…`).
     A wallet address or a sub goes through the user search first (`AdminRpc.findUsers`, `user:find`), whose answer
     carries the User ID: the lookup itself never starts from a Google account or an address.
  2. **`AdminRpc.supportLookup({query, days?})`** (staff only, read only): the directory's matches (`StaffUser`, at
     most 10 in full, newest first, `truncated` beyond), and for each the scope's apps, the vault shares that haven't
     expired (the account root's path at key index 0 and at each key index its wallets show; no share id, key or
     counter; a `live` flag) and the apps' `app_changes` over the window (30 days by default, 1–731; at most 50).
     **`AdminRpc.userShares({appId, path})`**: the planned per-path read, built as the spec gave it.
  3. **The ledger part** (`SUPPORT_ACTIVITY_SQL`, `SUPPORT_REQUESTS_SQL`, shared): each match's ok `login`,
     `session` and `derive` events by uid (the internal id's 16 bytes) over the window, newest first, at most 400; and
     for up to 20 request IDs every event whatever its outcome, each marked `byMatch` when it carries a match's uid
     (the uid itself is never selected). Read by the admin Worker over its `USAGE_DB` binding (`usage_admin`) and by
     the CLI over `.secrets/<env>/neon-usage-admin.url`. Without the binding or the file, or when Neon fails, the
     answer keeps the directory part and says `ledger: {available: false, reason: "ledger unavailable…"}`
     (sandbox-dev's usage capture is off today). No Neon migration: 0007 has `events (uid, at)` (D362) and the
     request ID leads the primary key.
- Why: the API's ledger role may only write (D73). Giving it a read of one user's activity by uid (a SECURITY DEFINER
  function for `usage_writer`) would put a per-user activity read in the Worker that faces the internet; the admin
  Worker already holds `usage_admin` behind Access, and the CLI the operator's own credentials.
- Rejected: the whole lookup in `AdminRpc` with a new writer-role function (above); a lookup by wallet or sub directly
  (one more way to probe the directory with a Google account); listing errors per user (D276 (d): uids on failures).

### D395. `supportId` in the session answers is computed exactly as the directory stores it, from the session's own account root
- Date 2026-11-05 · Status: decided while building C15 (to confirm) · Built: `apps/api/src/directory/store.ts`
  `sessionSupportId`, `login.ts`, `handlers.ts`, `link-precheck.ts` `autoLinkRoot`; the vault, the approval popup and
  the SDK (D393, `docs/integration.md`) · Source: D276 (as amended 2026-11-05), D346 ("it must come from the API")
- Decision: the `/v1/login` and `/v1/sessions` 200 answers carry `supportId` (`HANA-XXXX-XXXX`), additive and optional,
  computed with `directoryUser` (the function every directory write uses), so it is the `end_users.support_code` of
  that user by construction (tested against the stored row). The account root: for `/v1/sessions` the chain's new
  session path; for `/v1/login` the standing read (a member's root, else the identity) and, with an automatic link,
  the root the link precheck judged (case A: the link identity's account root, which the session identity joins;
  cases B and C: the session identity's). Left out when either key is missing or malformed (a code nothing could
  resolve) or when the login's standing is only the fail-open guess (a member's root unknown). The vault keeps it
  with the session and shows it; it never computes one.
- Why: a code shown to a user that staff then can't find is worse than none.
- Rejected: computing it in the vault (needs `IDENTITY_SUB_KEY`, D346); returning the User ID too (the partner's
  backend already has it from the identity token; the popup needs only the short form).

### D396. The admin console's lookup is audited before it reads anything, in the console's `audit_log`, never in a partner's view
- Date 2026-11-05 · Status: decided while building C15 (to confirm) · Built: `apps/admin/src/support.ts`;
  `StaffRpc.recordStaffAction` action `support.lookup` (console-core `staff.ts`, `apps/console/src/audit.ts`,
  `staff-rpc.ts`); `apps/admin/src/feed.ts` · Source: D327, D275 ("audit before data"), spec "Retention" (audit 5 years)
- Decision: `POST /api/support/lookup` requires a `ticket` (1–64 printable characters, no `@`: it is stored) and first
  appends the `audit_log` row through `StaffRpc.recordStaffAction`: the staff Access identity, `target` = the query as
  given (a Support ID, User ID or internal id; never an address or a sub), `details {by, ticket, requestIds, days}`
  (`requestIds` a count). The row has no org (a lookup is about an end user, not an org's act): the console refuses
  one with an `orgId`, so no partner's audit view or feed group can show it, and the feed never emails it. A failed
  or refused audit write answers 503 / 500 and nothing is read. The email join the screen adds after C8b goes through
  `DirectoryRpc`, which writes its own audit row in the issuer (`support_lookup`, D275).
- Why: a lookup reads a person's activity; it gets a durable row naming who looked and why, as directory reads do.
  `AdminRpc`'s other staff reads are logged only (`rpc` lines), which isn't enough for this one.
- Rejected: a hot-DB audit table (a new store for one action); logging only.
- Amended 2026-11-05 by D399: the ticket is console-core `SUPPORT_TICKET_RE` (1–64 letters, digits or `._#:-`), the
  issuer's rule, since the email join hands the same ticket to `DirectoryRpc.get` (recorded there as `support_lookup`).
- Amended 2026-11-05 by D410: `details` add `requestIdList`, the request IDs themselves (≤ 20, request-ID form; the one
  list a staff detail may hold), beside the count; the Users screen's `POST /api/users/find` is audited the same way
  first, as org-less `users.find` (`{by, ticket}`).

### D397. The CLI's lookup is its own command, `admin <env> support:lookup`, not more sections of `user:find --user`
- Date 2026-11-05 · Status: decided while building C15 (to confirm) · Built: `scripts/lib/admin-support.ts`,
  `scripts/admin.ts`; `scripts/test/admin-support.test.ts` · Source: D316, D361
- Decision: `corepack pnpm --filter @hana-id/scripts admin <env> support:lookup <HANA-XXXX-XXXX | u1_… | hu_… | ->
  [--request-id <id>]… [--days 30] [--json] [--remote]`: the same answer as the admin route, read like `user:find`
  (the API's D1 privately, the issuer's D1 for the addresses, the ledger as `usage_admin` from
  `.secrets/<env>/neon-usage-admin.url`, as `uid-erase` connects; "ledger unavailable" without it). Printed to the
  terminal only. Not audited: like `user:find`, it is the operator's path with wrangler and Neon credentials of their
  own, which already read everything; the admin console's path is the audited one (D396).
- Why: `user:find` answers "who is this"; the lookup answers "what happened to them", needs the ledger and request
  IDs, and its output is a different report. Adding them to `user:find --user` would give every user search a Neon
  connection.
- Rejected: extending `user:find --user`.

### D393. The vault gives `supportId` only to an SDK of 0.2.0 or later; the lockstep SDK version moves to 0.2.0
- Date 2026-11-05 · Status: decided while building C15 (to confirm; a release step under D72) · Built:
  `packages/core/src/support-id.ts` (`SUPPORT_ID_SDK_MIN`, `sdkAtLeast`), `packages/web/src/vault/vault.ts`
  (`sdkTakesSupportId`), the four packages at `0.2.0` (`scripts/sdk-version.ts`); tests
  `packages/core/test/support-id.test.ts`, `packages/web/test/vault/support-id.test.ts`,
  `packages/web/test/client/support-id.test.ts` · Source: D72, D395
- Decision: the SDK's protocol validators refuse a key they don't know, so a vault (always Hana's latest) that added
  `supportId` to `hana_status`, `hana_login` or `ready` would break every older SDK a partner vendors (a reply it can't
  parse fails the call; a `ready` it can't parse never comes, so every reload would end in `vault_unavailable`). The
  vault reads the `sdk` version of `hana:hello` and adds the field only for `SUPPORT_ID_SDK_MIN` (`0.2.0`) or later;
  older SDKs get exactly the shapes they know. The in-repo SDK moves to `0.2.0` so it receives the field. The approval
  popup (Hana's own page) shows the code for every SDK. On the SDK: `hana.supportId`, the `supportIdChanged` event,
  `useHana().supportId`; the vault keeps the code in the session's IndexedDB record (plaintext, outside the AAD: it
  is not secret), drops a malformed one and never derives one.
- Trade-offs: partners on a 0.1.0 tarball don't get the code until they update (their users still see it in the
  approval popup); a branch that releases 0.2.0 before C15 merges must raise the constant.
- Rejected: adding the field unconditionally (breaks deployed SDKs); a new port method (`hana_supportId`), which an old
  SDK can't call anyway and which splits the session state across two calls.
- Extended 2026-11-05 by D405: the same gate (`API_REQUEST_ID_SDK_MIN`, also 0.2.0) adds the API answer's
  `requestId` to a port error's `data`.

### D387. CI and the outside identity-JWKS probe are turned off while only testnet runs
- Date 2026-11-05 · Status: **decided by the user** · Built: the `CI` and `Identity JWKS probe` workflows disabled in
  GitHub (`gh workflow disable`; the files stay as D383 left them) · Amends D382 and D383
- Context: the org's included Actions minutes are shared by every repo and were used up by 2026-11-05 (D382, D383).
  Only sandbox-dev (testnet) runs: no real partners, users or funds depend on the identity token yet.
- Decision: both workflows off for now. Checks run locally before a merge (docs/operations.md "CI and git" lists the
  commands); the watchdog's own JWKS pin check (every 5 min, from Cloudflare) is unchanged. Before mainnet: CI back
  on (with D383's gating), and the outside probe moved to **AWS Lambda + EventBridge** (SNS email for findings) in an
  AWS account of its own, not the one holding the identity token's KMS key (D215): within Lambda's always-free
  allowance at any interval, so it can run every 15 min or tighter again, and its requests come from a network
  partners' own verifiers use. Tracked as `docs/mainnet-readiness.md` rows 4.20 and 5.10.
- Alternatives to weigh at that point (none chosen over Lambda yet): **Google Cloud Functions + Cloud Scheduler**
  (free at this volume: 3 scheduler jobs and the functions allowance; the same shape as Lambda, if another AWS account
  is unwelcome); **a small VPS with cron** (about $4–6 a month; a fixed IP partners don't share, and a machine to
  patch). Either still needs its own account and a findings alert by email.
- Trade-offs: nothing enforces the checks on a merge, and Linux-only failures (D381's WebKit one) can merge unseen;
  a key served only to partners and not to Cloudflare-origin fetches (D210's cloaking) goes unnoticed on testnet.
- Rejected: keeping the probe every 3 hours on GitHub (no testnet need for it; about 240 billed minutes a month); a
  separate public repo for the probe (it publishes what the probe looks like, and GitHub pauses scheduled workflows
  after 60 days without activity).
## A quick close on Google's page (branch `fix/popup-early-close-deadline`), 2026-11-05

### D398. A close inside D347's COOP window ends the login after 90 s without an answer, not after 5 minutes
- Date 2026-11-05 · Status: **asked for by the user** (2026-11-05, "yes make it give up after about 90 seconds";
  implementation choices: to confirm) · Built on `fix/popup-early-close-deadline` (`packages/web/src/vault/login.ts`
  `POPUP_WATCH.earlyCloseDeadlineMs`, `PopupTask.watchPopup`, `popupWait`, `stopWatch`) · Amends D347 ("the watch
  stops for the rest of that login, which falls back to its 5-minute limit") and the partner guide's "An unfinished
  login" (a close within seconds of reaching Google's page was `login_timeout` after 5 minutes). Built as D385 and renumbered
  D398 at merge (D384–D397 were taken on `develop` by then).
- Context: people close the popup 2–5 s after Google's account chooser appears, inside D347's 8 s window, so the
  partner showed "signing in…" for 5 minutes. Checked again on 2026-11-05: Google's sign-in pages still send COOP
  report-only; Google's OAuth error page enforces `same-origin` (the handle reads closed about 0.5 s after it
  commits); Gmail moved from report-only to enforced in January 2026. The window stays: a sign-in page that starts
  enforcing would otherwise cancel every login on arrival.
- Decision:
  - A `closed` reading within `severWindowMs` (8 s) of a `google` signal, before `back`, still stops the watch (the
    handle can't be read again either way), and now arms a deadline: `POPUP_WATCH.earlyCloseDeadlineMs`, 90 s from
    that reading, on the vault's injectable timers.
  - The popup's answer before the deadline (whatever ends the wait in progress: the first slot, a follow-up screen's
    answer, a link task's slot; only an open window can write one) shows the window was open behind a switch: the
    deadline is cleared and the login goes on. The handle stays unread for the rest of that login, whose later waits
    have the 5-minute limit only, as D347 had.
  - No answer by the deadline: the popup is taken as closed, exactly as a detected close. After the 1 s grace, a
    wait in progress ends with `login_cancelled`, `data.reason: 'popup_closed'`; the relay reads abort, the keys are
    dropped and a later slot write is never read. A vault working alone at that moment (google-match, the chain)
    finishes, and a later wait on the popup ends at once.
  - Every end of the login clears the deadline: success, `hana_cancelLogin`, a newer login, `login_timeout`, any
    error. The 5-minute limit wins when it comes first (a close in the window more than 3.5 minutes into the login).
  - It applies wherever the 8 s rule does: the first trip to Google, D273's interactive retry and token_first's
    silent second trip (the callback's own `google` signal), a follow-up screen's "Google again", and link tasks.
  - The public surface is unchanged: the same code and `popup_closed` reason as any close; only the timing differs
    (about 90 s rather than about 2 s).
- Why: the quick close is common, and 5 minutes of "signing in…" after the user has left is the bug D347 fixed for
  every other close. 90 s is longer than a normal Google sign-in (choose an account, or type a password and a second
  factor) and well inside the 5-minute limit.
- Main trade-off: if Google ever enforces COOP on its sign-in pages, every login's handle reads closed on arrival, and
  a user still on Google's pages 90 s later (a slow password reset, a second factor on another device) is cancelled
  with `popup_closed` while the window is open; finishing then writes a slot no one reads, and the user signs in
  again. Today that applies only to Google's OAuth error page, a dead end anyway. D347's recheck before each release
  (`curl -sI` on the authorization URL and the sign-in pages) is what would show it; a switch to enforcing calls for
  revisiting this number, or for a signal that survives the switch.
- Alternatives: (a) D347 as built (5 minutes): what users saw. Not chosen. (b) A distinct reason,
  `popup_closed_unconfirmed`: a partner does the same for both (the user is gone, or has to start again), and a new
  reason widens the documented surface for no partner action; the vault's timing tells the two apart if ever needed.
  Not chosen. (c) A shorter deadline (30 s): a COOP-enforcing Google would cancel more real sign-ins. Not
  recommended.
- Found while testing (2026-11-05), not fixed here: Chromium drops the popup's `hana:auth-progress` `google` when the
  page navigates in the same task as its `postMessage` (from the chooser's click it never arrived; from the
  Google-only path, now and then under load; navigating one task later delivered it). Where it is lost the vault never
  opens the COOP window, so in Chromium a quick close is a plain close (`login_cancelled` within seconds) and, on a
  Google that enforced COOP, the switch would be taken for a close. Every page that posts `google` (or `relayed`) and
  then navigates or closes is affected (`auth/login-page.ts` `toGoogle`, `auth/callback-page.ts`, `auth/email-page.ts`);
  the fix and its decision are for a separate branch. The e2e case below is `fixme` on Chromium until then.
  Resolved by D400 (2026-11-05): the message wasn't dropped but delivered with a null `event.source`; the pages now
  wait for the vault's ack before they leave, and the e2e case runs on Chromium too.
- Tests: `packages/web/test/vault/popup-close.test.ts` ("a close inside the COOP window": cancelled at 90 s, an answer
  at 60 s signs in, an answer in the grace wins, `hana_cancelLogin`, a newer login, the 5-minute limit first, a later
  trip to Google, a follow-up screen, a link task, no timer left behind); `apps/e2e/tests/popup-close.spec.ts` ("closed
  within 8 s on Google's page", the page's clock fast-forwarded; "an IdP that enforces COOP", Chromium and Firefox).

## Batch C8b: the admin console's Users screen (branch `feat/batch-c-8b`), 2026-11-05

Built over D275 as the user confirmed it on 2026-11-05 (below, under "Proposed, not yet confirmed", D275's entry).
Number note: D388 was the next free number on `origin/develop` (D387, merged from `chore/ci-cost` the same day);
C15, merged into `develop` while this was built, took D393–D397, so D388–D392 stayed free. A branch racing this one may
still take them: renumber on merge.

### D388. DirectoryRpc as built: the admin application's Access check in the issuer, three reads, no `byUid`
- Date 2026-11-05 · Status: decided while building, to confirm · Built: `apps/email-issuer/src/directory-rpc.ts`,
  `src/index.ts` (the export), `src/env.ts`, `scripts/gen-wrangler.ts`; `packages/console-core/src/directory.ts`;
  `apps/admin/scripts/gen-wrangler.ts` (`ISSUER`) · Source: D275 (confirmed with amendments), spec "Users and Support
  ID" → "Data path"
- Decision:
  - **The staff check** is `@hana-id/oidc`'s `AccessJwtVerifier` (the admin Worker's own: `type = 'app'`, `iss`, `aud`,
    expiry, `nbf`, a `sub`, an email, the certs never served stale) against three new issuer vars written by the
    issuer's `gen` from the manifest's `admin` block: `ADMIN_ACCESS_TEAM_DOMAIN` (`admin.accessTeamDomain`),
    `ADMIN_ACCESS_AUD` (`admin.accessAud`) and `ADMIN_STAFF_EMAILS` (`admin.staffEmails`, JSON). No new manifest field.
    The issuer's own `emailIssuer.access` (its staff routes' application) is a different AUD: its tokens don't open the
    directory. A missing, `UNSET` or malformed value, or unreachable certs, is `access_unavailable` (fail closed); a
    refused token `unauthenticated`; an email off the list `not_staff`. Neither writes an audit row.
  - **Methods**: `search`, `get`, `auditSince`. `byUid` is not built and not left for C15 either: D346 dropped the
    issuer's uid column and `IssuerRpc.uid` (code → user is the wallet directory's `end_users.support_code`).
  - **Answers**: `{ok: true, …}` or `{ok: false, code, error?, budget?}` with console-core's `DIRECTORY_CODES`. The
    admin BFF maps the issuer's `unauthenticated` / `not_staff` (a staff identity the admin Worker accepted: config
    drift between the two lists or AUDs) to `502 directory_refused` and `access_unavailable` (or a binding that throws,
    or no `ISSUER`) to `503 directory_unavailable`; the rest keep console-core's statuses.
  - **`auditSince`** takes `id` (rows after it, oldest first, as the spec's signature) or `before` (rows before it,
    newest first: the audit screen), exactly one, filtered by staff email and action, at most 200. It returns no end
    user's address (`detail` never holds one), so it takes no row budget and writes no audit row of its own.
  - The source test (`apps/email-issuer/scripts/test/directory-rpc-source.test.ts`) holds the module to SELECTs on
    `user_emails`, `user_email_apps` and `email_admin_audit` and one INSERT into `email_admin_audit`; to the `DB` and
    `RATE_LIMITER` bindings, its Access vars, `ENV_NAME` and `EMAIL_RL_KEY` (the keyed hash, D389); to value imports of
    `bytes.ts`, `limits.ts` and `log.ts` only (no signer, keys, KMS, challenge, mail, sender, handlers or deps module,
    directly or through another); and checks that no other module imports it (no route).
- Why: one verifier implementation for the admin Worker and the issuer, so the two checks can't drift in what they
  accept; the admin block already holds the three values, and a second copy in `emailIssuer` could disagree.
- Rejected: reusing the issuer's own `AccessVerifier` (no `type` check, a different cache); a new
  `emailIssuer.adminAccess` manifest block (a copy of `admin`'s).

### D389. The directory search: exact or substring, verified rows first on an address search, the audit's `detail`
- Date 2026-11-05 · Status: decided while building, to confirm · Built: `apps/email-issuer/src/directory-rpc.ts`
  (`search`, `get`, `termHash`), `test/directory-rpc.test.ts` · Source: spec "Users screen", D275, D269's review fixes
- Decision:
  - **Address term**: a full address (console-core `isFullAddress`) matches exactly, as typed and lowercased (Google
    rows) and normalized (`@hana-id/email`, email rows), the CLI's `user:find --email` candidates; anything else is a
    case-insensitive substring of at least 3 characters (`instr(lower(email), …)`, a scan), shorter is `bad_request`
    before any row is counted or audited. Filters: provider, app (`EXISTS` on `user_email_apps`), sub (exact),
    unverified only. No filter at all lists the newest identities.
  - **Order and pages**: newest first by `last_seen_ms`, ties by provider and sub; an address search first puts every
    Google account's unverified claim (`email_verified = 0`) after the verified rows (a claim is never first, so never
    a default target). The cursor is `<claim>:<lastSeenMs>:<provider>:<sub>` of the page's last row (no address);
    `next` comes with a full page. Default 50, at most 100.
  - **Audit `detail`**, built in the same D1 batch as the read: a search `{filters, q: {match: exact|substring, hash},
    page: first|next, rows, budgetCut?}`, where `rows` is counted in SQL from the same query and `hash` is 12
    characters of HMAC-SHA256(K_rl, label ‖ 0x00 ‖ value), b64url: label `mailbox` over the normalized address
    without its `+tag` for a full address (exactly an unlock's `subject`, so a search and an unlock of one address
    correlate in the audit), `directory-term` over the lowercased term for a substring. Without a usable `EMAIL_RL_KEY`
    an address search is refused (`internal`): it couldn't be recorded. A view `{provider, sub, found: 0|1}`: a miss is
    audited too. The ticket column is null on a search without one.
  - `get` lists the identity's apps newest first, at most 200 (`appsTruncated` past that).
- Why: the exact match is the indexed path support uses; the hash keeps "who looked for this address" answerable
  without storing it; counting in SQL keeps the audit and the read in one batch (the count can't come from the
  answer).
- Trade-offs: the claim-first order applies only to address searches (a list or filter walk keeps the `last_seen_ms`
  index order); a substring term's hash identifies the term only to someone holding K_rl.

### D390. The row budget: rows granted before the read, the rest given back; the alias emailed once per window
- Date 2026-11-05 · Status: decided while building, to confirm (the numbers are the user's, provisional) · Built:
  `apps/email-issuer/src/rate-limiter.ts` (`takeRows`, `returnRows`), `src/limits.ts` (`DIRECTORY_ROW_LIMITS`),
  console-core `DIRECTORY_ROWS_PER_HOUR` / `DIRECTORY_ROWS_PER_DAY`; `apps/admin/src/users.ts` (`budgetAlert`),
  `src/email/ledger-messages.ts` (`directoryBudget`) · Source: D275 as confirmed ("past that the call answers
  `rate_limited` and the security alias is emailed; reuse the admin Worker's alert path and its call budget rules")
- Decision:
  - One RateLimiter object per staff email (`<env>:staff-dir:<sha256 hex of the email>`: a limiter key never holds an address), two fixed windows (500 an hour, 2 000 a UTC
    day). Before a read, `takeRows` grants as many rows as the fullest window has left, up to the page asked for
    (a page past what is left is cut to it, `budgetCut` in the audit); after the read the rows not returned go back
    (`returnRows`), so an empty answer, a miss or a failed batch costs nothing. A view takes one row. A window with
    nothing left refuses: `rate_limited` with `budget: {window, limit, retryAfterMs}`, logged `directory_budget`, no
    audit row (nothing was read).
  - The admin Worker, on that answer, emails the security alias `directory_budget` (a Direct kind) through the same
    `sendToAll` and Resend sender as its other alerts, from a one-call `Budget` (D380's accounting), before answering
    `429` with `Retry-After`. The idempotency key is sha256 of `directory_budget:<env>:<staff>:<window>:<when it
    opens, in minutes>`, so the provider drops the repeats of one window (Resend: 24 h). The email names the staff
    address (Hana's own), the window and the times; never a term, sub or row. **Amended by D401 (2026-11-05):**
    SendGrid has no idempotency key; the same sha256 keys `sendToAll`'s per-isolate memo, so a hammering session gets
    one email per window per isolate (a few at worst, across isolates).
  - A detail page's own outbound calls (the issuer, the API, NEAR) come out of one `Budget` of 40, at most 30 RPCs
    (D380's numbers for one invocation): what doesn't fit is marked `not_read`.
- Why: counting what is returned (not what is asked) is what the budget bounds; a refusal-time email from the request
  is immediate, and the idempotency key keeps a hammering session to one email per window.
- Trade-off: a compromised admin Worker could skip the email (the issuer's `directory_budget` log line stays, and the
  reads stop either way).

### D391. The admin Users screen: three POST routes, the wallet directory and the chain joined by provider and sub
- Date 2026-11-05 · Status: decided while building, to confirm · Built: `apps/admin/src/users.ts`, `routes.ts`,
  `near.ts` (`getIdentity`, `getAccount` with the block height), `public/app.js`; `apps/api/src/rpc/admin.ts`
  `appNames`, `directory/read.ts` `adminAppNames`; console-core `adminAppNamesInput` · Source: spec "Users screen",
  D275, D310 ("admins see email and wallets"), D346
- Decision:
  - `POST /api/users/search` (the issuer's `search`, ticket optional), `POST /api/users/get` (ticket required: refused
    at the BFF before any call, then by the issuer), and an addition, `POST /api/users/find`: a wallet address, User ID
    (`u1_…`), internal id (`hu_…`) or Support ID goes to `AdminRpc.findUsers` (the wallet directory; no address, no
    issuer call); the SPA sends those forms of the search box there. The lookup with a user's activity is C15's
    `POST /api/support/lookup` (D394–D396, its own audit in the console's `audit_log`); its screen isn't built yet.
  - **The detail** joins, by provider and sub: the issuer's row and apps; `AdminRpc.findUsers({query: sub, provider})`
    (every wallet-directory user holding the identity, per scope: User ID, Support ID, internal id, identities,
    wallets); the apps' names, orgs and environments in one call of a new read, **`AdminRpc.appNames({appIds ≤ 50})`**
    (deleted apps included; `getApp` needs the org, which the directory doesn't know); and per scope (the directory's
    apps' and the wallet users', at most 8) `get_identity` and, when it is in an account, `get_account`, with the block
    height. The path is `{scope}#{provider}#{sub}#0` for `own` and the root's for `member` and `pending` (from
    `effective_at_ms`); a failed read is `chain_unavailable` with no path; members are listed by key with the sub where
    the wallet directory knows it. A directory miss still shows the wallet directory and the chain.
  - **The SPA** keeps the search and the last ticket in memory only (no URL, no storage), opens nothing by itself,
    shows the CLI's warning text (console-core `UNVERIFIED_CLAIM_WARNING`, now also the CLI's) on unverified rows and
    details, and has no export or select-all. Labels follow the partner Users screen ("User ID", "Support ID",
    "Google"/"Email", "Stellar"/"EVM").
  - **The audit view** adds the issuer's rows (`auditSince`, newest first, by staff and action) as a third source of
    `GET /api/audit` (`directory`, with `{error}` in its place when the issuer fails, so the page stays up). The CSV
    keeps the console's rows only.
- Why: the wallet directory is the API's (D310), so the join happens in the admin Worker, the only place that may hold
  both; one `appNames` read instead of a `getApp` per app keeps the page inside its call budget.
- Rejected: `AdminRpc.listScopes` to find each app's org (a walk of every scope); listing directory emails beside a
  `find` answer (each would be a directory read with its own audit row and budget: staff open the identity instead).
- Amended 2026-11-05 by D410: a search by `sub` or by a full address needs the ticket (browsing doesn't);
  `POST /api/users/find` needs one too and is audited first in the console (`users.find`); the SPA opens a user at the
  fixed path `/users/open` from memory (the history entry an opaque number), never `/users/<provider>/<sub>`.

### D392. Issuer migration 0003: the audit rebuilt with every row, the ticket optional on a search only, `support_lookup` now
- Date 2026-11-05 · Status: decided while building, to confirm · Built: `apps/email-issuer/migrations/
  0003_directory_audit.sql`; `scripts/test/directory-rpc-source.test.ts` · Source: spec "Data path" (0003), the user's
  ticket rule (2026-11-05)
- Decision: `email_admin_audit` is rebuilt (create, copy with ids, drop, rename; the AUTOINCREMENT sequence moves with
  it) with the actions `client_proof`, `unlock`, `unsuppress`, `revoke_tickets`, `user_search`, `user_view` and
  `support_lookup` (the spec's; C15 as built audits its lookup in the console's `audit_log` instead, D396, so it is
  unused for now and costs nothing), `ticket` 1–64 characters and required except on `user_search`,
  `detail` JSON (`json_valid`) or null, and indexes on `(staff, id)` and `at_ms`. `user_email_apps` gets **no `uid`
  column**: the build plan's C8b line predates D346, which dropped it. The remote apply is the user's (docs/
  operations.md "Users screen (C8b)").
- Why: one rebuild for every action batch C plans; the `at_ms` index serves C13's `retention:issuer` purge.
- Amended 2026-11-05 by D399: `support_lookup` is used now, for the Support ID lookup's email join (`DirectoryRpc.get`
  with `purpose: 'support_lookup'`); the lookup's own audit stays in the console's `audit_log`.
- Amended 2026-11-05 by D410: the ticket is optional only on a browsing search; one naming an identity (a `sub`, a full
  address) needs it (console-core `directorySearchInput`). The column's CHECK is unchanged.

## The Support ID lookup's admin screen (branch `feat/batch-c-15-screen`), 2026-11-05

### D399. The lookup's screen: the email join inside the lookup route, audited by the issuer as `support_lookup`; one ticket rule for both audits
- Date 2026-11-05 · Status: decided while building (the `support_lookup` action was the requester's suggestion,
  "unless there's a reason not to"; the rest: to confirm) · Built on `feat/batch-c-15-screen`:
  `apps/admin/src/support.ts` (`lookupEmails`, `SUPPORT_EMAILS_MAX`, `SupportLookupAnswer`), `apps/admin/public/app.js`
  (`/support`, `openLookup`, the Users search and the wallet-directory block), console-core `directory.ts`
  (`DIRECTORY_GET_PURPOSES`, `directoryGetInput.purpose`) and `support.ts` (`supportTicket`),
  `apps/email-issuer/src/directory-rpc.ts` `get`; tests `apps/admin/test/support.test.ts`, `apps/admin/test-spa/
  support.test.ts`, `apps/admin/scripts/test/gen-wrangler.test.ts`, `apps/email-issuer/test/directory-rpc.test.ts`,
  `packages/console-core/test/{directory,support}.test.ts` · Source: build plan C15 "Screen: after C8b merges", D275,
  D388–D392, D394–D396 · Number: the next free one on `develop` when written (D398 the highest); another branch may
  take it first, so renumber at merge if so · Amends D396 (the ticket rule) and D392 (`support_lookup` unused)
- Decision:
  1. **The email join is in `POST /api/support/lookup`**, not in the browser or a second route: after the console's
     audit row and `AdminRpc.supportLookup`, together with the ledger part, the admin Worker calls `DirectoryRpc.get`
     for each distinct `directoryKey` of the matches' identities (at most `SUPPORT_EMAILS_MAX` = 20, in parallel),
     with the request's Access JWT and the lookup's ticket. The answer adds `emails` (each identity's row, or why
     not: `not_found`, `not_read`, `no_directory`, `directory_unavailable`, `directory_refused`, `rate_limited`,
     `failed`), `emailsNote?` and `unverifiedWarning?` (the CLI's text). An issuer failure never fails the lookup;
     a budget refusal emails the security alias (`directory_budget`, the Users routes' `budgetAlert`).
  2. **The issuer records these reads as `support_lookup`**: `DirectoryRpc.get` takes `purpose` (`user_view`, the
     default, or `support_lookup`), which names the `email_admin_audit` row; a `support_lookup` row's `detail` is
     `{provider, sub, lookup, found}`, `lookup` the admin request's id, which is the console's `support.lookup` row's
     `request_id`. The lookup's own audit stays in the console's `audit_log` (D396); the issuer's row says why each
     address was read and points at it. Each read takes one row of the staff member's directory budget, as a view.
  3. **One ticket rule**: the lookup's ticket is console-core `SUPPORT_TICKET_RE` (1–64 letters, digits or `._#:-`),
     the issuer's and `POST /api/users/get`'s, instead of D396's "printable ASCII, no `@`, no edge spaces". The same
     ticket goes into both audits; with two rules a ticket like `ZD-1 refund` would give a lookup the issuer then
     refuses to join.
  4. **The screen** (`/support`, in the nav): query, ticket (required), request IDs (≤ 20) and days, kept in memory only
     (no URL, history state or storage; `go()` moves to literal paths only); nothing read until "Look up". The Users
     search sends a `HANA-`-prefixed Support ID there (run at once when a ticket was typed, else it waits for one);
     a User ID, internal id or wallet still goes to `POST /api/users/find`, and "Wallet directory only" on the screen
     keeps `find` for a code. Every wallet-directory user's block (a `find` answer, a user's detail) has a "Support ID
     lookup" button that fills in the User ID and the ticket already given, not run. It renders every part of the
     answer: a collision's matches list and the `truncated` flag, "Ledger unavailable: <reason>" at the top and in
     each ledger part, the request IDs' events with outcome badges and codes, the IDs with no event. No export.
  5. **SPA tests in a DOM**: `apps/admin/test-spa` runs `public/app.js` in a fresh happy-dom window per test
     (`happy-dom` 21.0.3, already in the lockfile for the console and the SDK, now an admin devDependency), the API
     answered at `fetch`. The source checks stay.
- Why: one request, and the issuer reads only the identities the audited lookup itself found (the browser can't name
  others through this route); the issuer's audit says why each address was read and ties it to the console's row.
- Rejected: the SPA opening each identity through `POST /api/users/get` (audited `user_view`, and each also reads the
  wallet directory, app names and up to 8 scopes on chain: far past a request's call budget, and tied to nothing); a
  second route taking `{provider, sub}` from the browser (any identity, not only the lookup's); keeping D396's looser
  ticket and skipping the join when it doesn't fit (a lookup that silently lacks addresses).
- Trade-offs: a lookup costs up to 20 rows of the staff member's directory budget even when only the activity was
  wanted; a Support ID typed in Users without its `HANA-` prefix still goes to the address search (the lookup screen
  itself takes every form); the issuer's `get` still reads the identity's apps for a `support_lookup`, which the admin
  Worker drops.
- Amended 2026-11-05 by D410: "Wallet directory only" and the Users search's id or wallet sends the ticket to
  `POST /api/users/find`, which now requires it and audits first (`users.find`); a match's sub links open the user at
  `/users/open` from memory (no sub in a URL); the lookup's audit row lists the request IDs (`requestIdList`).

## The popup's signals before it leaves (branch `fix/popup-signal-before-navigate`), 2026-11-05

### D400. A Hana page that signals the vault and then navigates or closes waits for the vault's ack (at most 150 ms)
- Date 2026-11-05 · Status: decided while fixing what D398 found, to confirm · Built on
  `fix/popup-signal-before-navigate` (`packages/web/src/auth/vault-signal.ts` `vaultSignals`, `SIGNAL_ACK_WAIT_MS`;
  `auth/login-page.ts` `toGoogle`; `auth/callback-page.ts` `vaultTargets` and every leave; `auth/email-page.ts`
  `tellVaultThen`; `vault/login.ts` `PopupTask.ackPopup`; core `hana:auth-progress-ack`) · Amends D347 ("every Hana
  page posts `hana:auth-progress` `google` before it navigates to Google … `relayed` first") and resolves D398's "Found
  while testing". Numbered D400: D399 was taken on `develop` while this was built (C15's screen).
- Context, measured on 2026-11-05 in the e2e stack (Playwright 1.64.1: Chromium 1248, Firefox 1555, WebKit 2370), with
  a listener in the vault frame recording each `hana:auth-progress`:
  - Chromium doesn't drop the message: it delivers it with `event.source === null` when the posting page starts a
    cross-document navigation in the same task (or in a microtask of it). The vault takes a signal only from the popup
    it answered (`e.source === helloSource`), so a null source is no signal. From the chooser's click: null 19 times in
    20 (the page's own code, and a bare `postMessage` then `location.assign` in a click handler alike); from a
    Google-only app's message handler: 1 in 20.
  - The same post followed by the navigation one task later (`setTimeout(0)`, or `requestAnimationFrame`): the source
    kept, 30 in 30 under 8 workers in all three browsers, and 10 in 10 with the vault frame busy for 1.5 s when the
    message came (so what matters is that the navigation starts after the post's own task, not when the vault reads the
    message). A `window.close()` in the same task kept the source (20 in 20). Firefox and WebKit kept it in every case.
  - A round trip (the vault answering the signal, the page navigating on the answer): about 14 ms in Chromium (8–16 ms,
    the vault frame's turn on its own renderer), 0–2 ms in Firefox and WebKit.
- Decision:
  - The vault acks each signal it takes: `hana:auth-progress-ack` with the same stage, posted to the popup it answered
    (`helloSource`) with `authOrigin` as the target, from `acceptProgress` and a link task's `acceptPopupSignal`, after
    the same sender check as the signal. A signal it doesn't take (another window, another origin, a null source, an
    ended login) gets no ack.
  - A page that posts a signal and then leaves (`google` before Google, `relayed` before closing itself) leaves when
    every signal it posted so far is acked, or after `SIGNAL_ACK_WAIT_MS` (150 ms), whichever comes first. The ack
    counts only from `vaultOrigin` and from a window the page signalled. The callback's `back` (posted on arrival) is
    waited for the same way by its next navigation (the follow-up page, the screen after a cancel), whose ack has long
    come by then in any normal case. A page with nothing to tell (no opener, the export window's child) leaves at once,
    as before.
  - All the sites: `/login`'s `toGoogle` (the chooser's click and the Google-only path); `/login/callback`'s
    `google` (D264's "Continue", token_first's silent and interactive ID legs, the record-only fallback,
    second_request's access leg), its follow-up navigation and its `relayed` close; `/login/email`'s `google` (case
    B, the screen after a cancel, D264's "Try Google again", a banner's proof) and its `relayed` closes.
- Why the ack rather than the one-task delay alone: the ack shows the vault took the signal, sender check included,
  instead of relying on an ordering inside Chromium that only measurement shows; and its fallback is the delay
  (150 ms later, so many tasks), so a missing ack (a vault from an older build, an ended login) costs the wait and
  nothing else. It doesn't slow logins measurably (below) and changes no origin check.
- Measured (2026-11-05, local e2e stack, a login's `google` stage and its whole vault time, median of 15 logins
  before and 30 after, run back to back): Chromium's chooser path +21 ms (two `google` signals wait for their ack:
  `/login`'s and the callback's silent ID leg; 75 → 97 ms `google`, 243 → 264 ms in all), its Google-only path and
  Firefox's and WebKit's every path within ±11 ms, the runs' noise. Against a real login (the user at Google's pages,
  the network) that is not measurable.
- Main trade-off: one more message type in the protocol, and up to 150 ms more before the navigation when no ack comes.
  `window.close()` didn't need the wait in any browser measured; it waits too, for one rule at every site.
- Alternatives: (a) `setTimeout(0)` before each navigation: enough in every case measured, with no protocol change, but
  it rests on Chromium's ordering of the post against the navigation's start. Its effect is what the ack's fallback
  gives. Not chosen alone. (b) A microtask: not enough (19 in 20 null, as the same task). (c) Taking a null-source
  signal in the vault: it can't be authenticated (any page can post one). Never. (d) Re-posting the signal on Google's
  side: no Hana code runs there.
- Tests: `packages/web/test/auth/vault-signal.test.ts` (the wait, the ack's checks, the timeout, every signal pending,
  a target that can't be posted to); `test/auth/popup-signals.test.ts` (the callback's targets, `relayed` close on the
  ack or at the wait); the pages' tests with an acking vault (`vaultAcks`); `test/vault/popup-close.test.ts` ("the
  vault acks each signal it takes"); core `protocol.test.ts`; `apps/e2e/tests/popup-close.spec.ts` (D398's quick close,
  from the chooser and from a Google-only app, now in Chromium too).
- Also found (2026-11-05): `apps/e2e/tests/abandoned-login.spec.ts`'s "the popup closed on the chooser" expected
  `login_timeout` at 5 minutes, which D347 replaced with `login_cancelled` within seconds. It passed only because
  Playwright's `clock.fastForward` moves every overdue timer to the target time and runs ties in creation order: the
  login's 5-minute timer (made at the start) ran before the close's 1 s grace (made after the close) whenever the
  vault's 250 ms watch hadn't read the close before the first fast-forward; when it had (WebKit, once), the grace fired
  on that first jump and the test failed. The code was right: the test now expects `login_cancelled` (`popup_closed`)
  in real time, and nothing frozen.

## SendGrid for every Hana email, and sandbox-dev's statement lock (branch `feat/sandbox-dev-dashboard-blocks`), 2026-11-05

Numbered D401 and D402: D400 was taken on `develop` (merged into this branch before writing) by
`fix/popup-signal-before-navigate`, and D403 by `fix/usage-setup-neon-api-passwords`, which left D401–D402 for this
branch.

### D401. The admin Worker's notices and the watchdog's alerts go through SendGrid too; Resend is gone (amends D87, settles D194's open point)
- Date 2026-11-05 · Status: asked for by the user ("can we replace Resend with Sendgrid?", 2026-11-05), recommended and
  accepted; the isolate memo below decided while building, to confirm · Built on `feat/sandbox-dev-dashboard-blocks`
  (`packages/sendgrid` `sendgridSend`; `apps/admin/src/email/sender.ts` `sendgridSender`, `mail.ts` `sendToAll`,
  `messageKey`; `apps/watchdog/src/channels.ts` `sendgridEmail`; `apps/email-issuer/src/sendgrid.ts` on the shared
  adapter) · Amends D87 (the provider of the admin Worker's notices and the watchdog's alerts) and D279 (the
  `Idempotency-Key`); settles D194's "whether they move to SendGrid too is decided separately".
- Decision:
  - One provider for every email Hana sends: SendGrid's v3 Mail Send, through one shared adapter
    (`@hana-id/sendgrid`) used by the email issuer, the admin Worker and the watchdog. Each sender keeps its interface
    (one message → accepted or an error). Accepted = SendGrid's `202`; anything else (a network error, the 10 s
    timeout, a 4xx, a 5xx, any other 2xx) is a failure. A result carries the HTTP status at most, never the key, a body
    or an address. Click, open and subscription tracking are off on every message (a notice's cancel link must stay a
    console link). Each Worker's mail has its own category (`hana-id-admin`, `hana-id-watchdog`; the issuer's are
    `hana-id-<kind>`), so the issuer's event webhook never acts on another Worker's bounces (D194 M3).
  - Each Worker has **its own restricted API key, Mail Send only**: the admin Worker's is still the secret
    `EMAIL_API_KEY` (provider-neutral, unchanged; file `.secrets/<env>/admin-sendgrid-key`); the watchdog's secret is
    renamed `RESEND_API_KEY` → `SENDGRID_API_KEY` (in `watchdog-secrets.json`; `secrets check` names the old name as
    retired); the issuer's stays `SENDGRID_API_KEY`. None of the three is ever used by another Worker. Not the
    issuer's subuser (D194 M3): SendGrid applies a subuser's suppression list to everything it sends, so an admin
    notice's bounce must not suppress a login address. Where the plan has subusers (Pro and up, up to 15), the admin
    Worker and the watchdog get their own, each with its own authenticated sending domain.
  - The Resend adapters are deleted (admin `resendSender`, watchdog `resendEmail`); nothing calls Resend.
- Idempotency, the trade-off: Resend's `Idempotency-Key` dropped a retried message for 24 h; SendGrid's Mail Send has
  none. A retry after a lost answer (a timeout after SendGrid queued the message) therefore sends it **again**: a
  duplicate at worst, never a skip, because a send counts only when its own `202` came back. The fail-closed rule is
  unchanged: a blocking notice is acked only when every recipient's message was accepted. To keep repeats rare,
  `sendToAll` remembers, per isolate and for 24 h (at most 5 000 entries), each message (sha256 of purpose and
  recipient) SendGrid accepted, and doesn't send it again: the retry of a notice that failed for one recipient goes to
  that recipient only, and the Users screen's `directory_budget` alert goes out once per window per isolate. The memo
  is lost when the isolate is evicted (a cron run may well start in a new one), so a recipient can get a notice, a
  digest or that alert twice; never zero times.
- Blast radius (`docs/security.md`): a SendGrid key can be limited to Mail Send but not to one sending domain or
  sender identity: a leaked key can send as any verified sender of its account or subuser. Resend's keys could be
  limited to one domain. Hence one key per Worker, separate subusers where the plan allows, and the rotation in
  `docs/operations.md`.
- Why: one provider the team already runs (the issuer, Hana Wallet, Wend), one adapter to maintain and test, one set
  of DNS records per sending domain; the interface keeps a later switch to one new adapter.
- Main trade-off: the lost 24 h deduplication (a rare duplicate email) and keys that can't be limited to a domain.
- Rejected: keeping Resend for the admin Worker and the watchdog (two providers, two sets of DNS records and keys for
  low volume); the same key for the admin Worker and the watchdog (one leak silences or forges both); sending SendGrid
  a `custom_args` idempotency value (SendGrid doesn't deduplicate on it); persisting accepted messages in the ledger
  (a write per email on every cron run, to save a rare duplicate).
- Tests: `packages/sendgrid/test/sendgrid.test.ts` (the request, 202 only, every status, a timeout, no key, the capped
  drain); `apps/admin/test/email.test.ts` (the adapter, the memo, a timeout retried), `notices.test.ts`,
  `feed.test.ts`, `users.test.ts`, `test-ops/budget.test.ts` (every run with an empty memo: no message twice);
  `apps/watchdog/test/channels.test.ts`, `worker.test.ts`, `scripts/test/secrets.test.ts`;
  `apps/email-issuer/test/adapters.test.ts` (its categories); `scripts/secret-scan-selftest.mjs` (the key files and
  an `EMAIL_API_KEY` line).
- Amended 2026-11-05 (security review, branch `fix/sendgrid-suppression`): 202 is accepted, not delivered (SendGrid
  then drops mail to a suppressed address silently), so every watchdog alert and the admin Worker's alerts and blocking
  notices (`apps/admin/src/mail.ts` `BYPASS_PURPOSES`; invitee links, statement notices and the org audit digest keep
  the lists) set `mail_settings.bypass_bounce_management`, `bypass_spam_management` and
  `bypass_unsubscribe_management` (the granular filters; `bypass_list_management` is "for emergencies" and can't be
  combined with them, [Mail Send](https://www.twilio.com/docs/sendgrid/api-reference/mail-send/mail-send)); the
  issuer's login mail never does (D194's suppression handling). Tests: `packages/sendgrid/test/sendgrid.test.ts`,
  `apps/admin/test/email.test.ts`, `apps/admin/scripts/test/mail-purposes.test.ts`,
  `apps/watchdog/test/channels.test.ts`, `apps/email-issuer/test/adapters.test.ts`.

### D402. sandbox-dev's `STATEMENTS` bucket lock is 1 day; production keeps 2557 days (amends D308)
- Date 2026-11-05 · Status: agreed by the user (2026-11-05) · Written: `docs/operations.md` "Files Worker and logos"
  step 2 · Amends D308 (one rule of 2557 days in every env).
- Decision: the lock rule's retention is per env: 1 day on sandbox-dev (rule `statements-1d`, `--retention-days 1`),
  2557 days (7 years with the leap days, D90) on every production env. A sandbox* env other than sandbox-dev takes 1 day
  too unless its operator chooses longer.
- Why: sandbox-dev's statements are testnet drills; a 7-year lock would keep every test statement (and the bucket,
  which can't be deleted while it holds locked objects) for 7 years. One day still exercises the lock (the admin
  Worker can't overwrite a statement it just wrote).
- Main trade-off: sandbox-dev doesn't test the real retention period; nothing reads it but R2.

## Ledger role passwords from Neon's API (branch `fix/usage-setup-neon-api-passwords`), 2026-11-05

### D403. `usage-setup <env> roles` has Neon's API reset each role's password; SQL only gives LOGIN; every run replaces the role files
- Date 2026-11-05 · Status: **decided by the user** (2026-11-05, option A: "let Neon generate the passwords via its
  API"; implementation choices: to confirm) · Built on `fix/usage-setup-neon-api-passwords`: `scripts/lib/neon-api.ts`
  (`NeonApi`, `readNeonApiKey`, `scrub`), `scripts/lib/usage-setup.ts` (`rolesCommand`, `rolePasswordProblem`,
  `roleUrl`), `.gitleaks.toml` (`neon-api-key` in `hana-secret-file`, rule `hana-neon-api-key`); tests
  `scripts/test/usage-setup.test.ts`, `scripts/secret-scan-selftest.mjs` · Amends D224 ("sets `LOGIN PASSWORD` to a
  SCRAM-SHA-256 verifier … so Neon never sees the password; a re-run reuses the files' passwords") · Number: the next
  free one when written was D401 (D400 the highest on `develop`), but `feat/sandbox-dev-dashboard-blocks` was in flight
  and may take D401–D402; renumber at merge if another branch took D403 first.
- Context: on sandbox-dev (2026-11-05) `usage-setup sandbox-dev roles --yes` wrote both role files and then failed:
  `ALTER ROLE … LOGIN PASSWORD '<SCRAM verifier>'` got `Received HTTP code 400 from control plane: {"error":"Neon only
  supports being given plaintext passwords"}`. Neon's compute hands every role password change to its control plane,
  which takes plain text only ("Hashed passwords are not supported", Neon's "Manage roles"). No password was set.
- Decision:
  1. **SQL gives LOGIN, Neon sets the password.** As the owner (`DATABASE_URL_DIRECT`): check `usage_writer` and
     `usage_admin` exist (else "run usage-migrate first") and `ALTER ROLE … WITH LOGIN` with a random throwaway password (never stored or printed; Neon's reset refuses a role without one,
      `ROLE_PASSWORD_NOT_AVAILABLE`, seen on sandbox-dev 2026-11-05), one
     transaction; the connection is closed before the resets (a reset drops the endpoint's connections). Then, per
     role in turn, `POST https://console.neon.tech/api/v2/projects/{project_id}/branches/{branch_id}/roles/{role}/reset_password`
     with `Authorization: Bearer <key>`: Neon generates the password and answers it once (`role.password`) with the
     operations it started. The script writes the role's URL (the owner's direct host and database, the role,
     `sslmode=require`; the password URL-encoded) to its file at once, atomically, 0600, then polls
     `GET /projects/{project_id}/operations/{id}` every 2 s (up to 3 minutes) until each is `finished` or `skipped`
     (`failed`, `error`, `cancelled` stop the run). Last, each role logs in with its file's URL (`SELECT current_user`)
     in process: the file Hyperdrive gets is proven to work. This replaces D224's step-8 question (does Neon accept a
     SCRAM verifier).
  2. **Inputs.** `project_id` and `branch_id` from `.secrets/<env>/neon.json`; the API key from a new file
     `.secrets/<env>/neon-api-key` (0600, one line), refused when missing, empty, not one printable token, or readable
     by group or others. Before any change, `GET …/branches/{branch_id}/endpoints` must list the owner URL's host: a
     `branch_id` of another branch would reset that branch's roles.
  3. **Every run resets both and replaces both files** (unlike D224, which reused them): a reset invalidates the old
     password at once, so a Hyperdrive config made from an older file must be re-created (delete it, `usage-setup <env>
     hyperdrive`, the new ids to `gen` and the admin config). Order: `roles`, then `hyperdrive`. The plan says which
     files it writes or REPLACES and warns about the configs; `hyperdrive`'s "already exists" failure says how to
     re-create one.
  4. **Retries.** 409, 423 (Neon's "operation in progress"), 429 and 503 mean the request wasn't applied: sent again up
     to 8 tries, 2 s × the try apart, each logged with Neon's code and message. A POST whose answer was lost (network,
     timeout) is never re-sent (it may have been applied): the error says so and a re-run resets again. A failure on
     the second role says the first is already reset and written.
  5. **No secret leaves.** The key is only in the request header of an in-process `fetch` (`redirect: 'error'`), never
     an argument or environment variable of a child process; the password is only in the HTTPS answer and the file. No
     response body is printed or put in an error: an error carries the HTTP status and, for a non-2xx answer, only
     Neon's `code` and `message` (an error answer has no new password), trimmed to one line, with the key, the owner's
     URL and password, and every password and role URL received so far removed. A success body without a usable
     password is refused without showing it.
  6. Role passwords are now Neon's format (`npg_` and random letters and digits), so the role files' check
     (`readRoleUrl`, also used by `admin` and `uid-erase`) takes 12–512 characters without whitespace or control
     characters instead of D224's 43 base64url characters.
- Amended 2026-11-05 (user, "yes"): the first real run answered `422 ROLE_PASSWORD_NOT_AVAILABLE` ("cannot update
  password for role without password"): migration 0001's roles had none. The owner now sets a random throwaway in
  the same `ALTER ROLE … WITH LOGIN PASSWORD`, never stored or printed, which the reset replaces within seconds; a
  SQL log can only ever hold a dead password. Rejected: re-creating the roles through Neon's API (dropping them and
  their grants).
- Why: the user's choice of the two ways Neon allows (plain text in SQL, or Neon generates it): no password in a SQL
  statement (statement text can end up in Postgres's and Neon's logs), none typed or pasted, and the password is
  created where it is set.
- Rejected: `ALTER ROLE … PASSWORD '<plain text>'` as the owner (option B: the password in a SQL statement);
  keeping the SCRAM path for PGlite tests only (code no env can use: replaced by a mocked Neon API); re-using the
  files' passwords on a re-run (Neon can't be given them); a personal or organization API key when a project-scoped
  one is possible (it reaches every project).
- Trade-offs: the key can change and delete anything in the project while it exists (Neon's project-scoped keys have
  that scope), so it is revoked after use (`docs/security.md`); a reset drops the endpoint's open connections (the
  API's Hyperdrive pool reconnects; nothing is on the login path); whether Neon's API knows a role created by SQL was
  not documented: if it answers 404 the run stops before any file is written, and the roles can be checked in Neon's
  console (Branches → the branch → Roles).
- Amended 2026-11-05 by D412: a reset that fails after the throwaway's COMMIT sets each role Neon didn't reset
  `NOLOGIN` again (best effort, over a new owner connection, errors scrubbed); the next successful run gives LOGIN back.

### D404. Dev envs may run on Custom Domains (one registrable domain allowed); an env moves to another Cloudflare account by a scripted procedure; testnet moves to company accounts
- Date 2026-11-05 · Status: **testnet moves to company accounts, decided by the user** (2026-11-05: Cloudflare, Neon
  and the Google Cloud project that owns the OAuth clients, from the personal accounts; timing to be agreed with the
  colleague; pending in `docs/mainnet-readiness.md` row 4.21 and `docs/operations.md` "Moving an env to another
  Cloudflare account"). Custom domains for the dev envs: recommended by the user. The tooling and the runbook as built
  on `feat/account-migration`: **to confirm** · Built: `packages/env/src/cloudflare.ts` (`accountIdFields`,
  `customDomainPlacement`), the manifest's `cloudflare.accountId` (`schema.ts`), `apiPlacement` in
  `apps/api/scripts/gen-wrangler.ts`, `issuerPlacement` in `apps/email-issuer/scripts/gen-wrangler.ts`, the watchdog's
  Custom Domain, the demo's `HANA_DEMO_ORIGIN`, `account_id` in every `gen`; `scripts/env-secrets.ts`,
  `scripts/d1-move.ts`, `admin <env> issuer:iss` (`scripts/lib/admin-owner.ts`); tests in each package
  (`packages/env/src/cloudflare.test.ts` with the fixture `custom-domain.fixture.ts`, the gen tests,
  `scripts/test/env-secrets.test.ts`, `d1-move.test.ts`, `admin-owner.test.ts`) · Number: D403 was the highest on
  `develop` when written; `feat/sandbox-dev-dashboard-blocks` may take D401–D402 and other branches started at the
  same time: renumber at merge if another branch took D404 first.
- Context: sandbox-dev runs on the user's personal Cloudflare account (`*.tingtc.workers.dev`), so every origin, the
  email `iss` and the identity token's `iss` name that account's `workers.dev` subdomain; the ledger is in a personal
  Neon organization and the OAuth clients in a personal Google Cloud project.
- Decision:
  1. **What a dev env may be served on.** Each Worker's placement follows from its origin in the manifest: a
     `workers.dev` origin is the Worker's own `workers.dev` URL (dev envs only, as before); any other https origin is a
     Cloudflare Custom Domain (`routes: [{pattern: <host>, custom_domain: true}]`, `workers_dev: false`,
     `preview_urls: false`) on a zone of the Worker's account. Already so for the page, console, console-auth, files
     and admin Workers; new for the API (`apiUrl`, then a bare origin; before, its config had no route at all and only
     a `workers.dev` API could be reached), the email issuer when `emailIssuer.url` is not on `workers.dev` (before,
     such a URL deployed with neither a route nor a `workers.dev` URL), the watchdog when `watchdog.url` is not on
     `workers.dev`, and the demo (`HANA_DEMO_ORIGIN`, required when the API isn't on `workers.dev`). A loopback or
     `workers.dev` API adds nothing, so sandbox-dev's generated configs are unchanged.
  2. **Which account.** An optional `cloudflare.accountId` (32 hex) is the account of every Worker but the watchdog;
     every `gen` writes it as `account_id`, and refuses a shell `CLOUDFLARE_ACCOUNT_ID` naming another account than the
     manifest's for that Worker (the watchdog's `watchdog.cloudflare.accountId` included), so a shell left on the other
     account during a move can't deploy a Worker or a secret there. The schema refuses `cloudflare.accountId` equal to
     the watchdog's (D86). Without it nothing changes (wrangler's login or `CLOUDFLARE_ACCOUNT_ID` decide).
  3. **Sites.** A dev env (`local*`, `sandbox*`) may put every origin under one registrable domain (`api.`, `vault.`,
     `auth.`, `email.id-dev.hanawallet.io`): the schema's dev-env exemption (D38) is unchanged and covers it, and a
     test pins it. There the vault is same-site with the pages that show content and with the API, so desktop
     browsers don't guarantee it its own process (`docs/security.md` (j)), and nothing may set a domain-wide cookie on
     that domain. Production is unchanged: `vaultOrigin` on a different site from `authOrigin`, `apiUrl` and every
     dashboard origin (the schema refuses the same layout under a non-dev name, tested), so production needs the
     vault's own registrable domain beside the user-visible one.
  4. **The move** (`docs/operations.md` "Moving an env to another Cloudflare account"): the env is re-created on the
     new account (Cloudflare moves no Worker, D1, Durable Object, Hyperdrive config or R2 bucket between accounts, as
     far as its docs show), its origins put on Custom Domains so the next move keeps them; the watchdog stays on its
     own account. Order: freeze and Time Travel bookmarks; the manifest in one commit (URLs, account id, both `iss`);
     new D1s (never `migrations apply`d); the new email `iss` beside the old one on chain; `d1-move` each database
     before any Worker runs there; `gen` with the new ids; deploys (API, pages, issuer, then the dashboard Workers);
     `env-secrets --yes`; `deploy-check --d1`; Google redirect URIs; the watchdog's redeploy; the demo's origin; a
     smoke test comparing two recorded test users' addresses; then the old Workers deleted and the old `iss` removed.
  5. **Tools.** `env-secrets <env> [--worker …] [--yes]` lists every Worker secret with its source in
     `.secrets/<env>/` (present, 0600, well-formed) and uploads them through wrangler's stdin, refusing while a
     required one is missing (never invented) or a Worker's generated config names another Worker or account.
     `d1-move <env> --db api|issuer|watchdog|console --from-account … [--to-account …]` exports (0600, never
     overwritten), imports only into a database with no table (the export carries the schema and `d1_migrations`, so
     `migrations list` stays right), and compares every table's rows in the export, the new database and the old one
     now; wrangler runs in an empty scratch directory with each side's account and token or profile, so no generated
     config can bind a name to the other account's id. `admin <env> issuer:iss <provider> --add|--remove <iss>` reads
     `get_issuer` and sends the whole list in one `set_issuer`; it refuses a 5th value, the last value, Google's values
     and the `iss` the manifest's issuer signs with.
  6. **No derivation change, no address change.** Nothing here changes how a key or a path is derived. Evidence: the
     path is `scope#provider#sub#key_index` (`contracts/hana-signer/src/sessions.rs`, `format!("{}#{}#{}#{}",
     scope_id, path_provider, path_sub, key_index)`), the provider is the one `iss_index` maps the token's `iss` to
     (`issuers.rs` `verify_token`), and `set_issuer` maps 1 to 4 `iss` values to a provider, keeps its keys and refuses
     an `iss` another provider uses (`issuers.rs` `set_issuer`, `MAX_ISS_VALUES = 4`); identities and links key on
     `(scope, provider, sub)` (`links.rs` `ik`); the email `sub` is HMAC(K_sub, label ‖ 0 ‖ normalized address)
     (`packages/email/src/sub.ts` `emailSub`), with no `iss`, origin or account in it. So moving the issuer's URL keeps
     every address as long as the new `iss` is added to provider `email` first and K_sub, `USER_ID_KEY` and
     `IDENTITY_SUB_KEY` come from their files.
  7. **What users see**: logged out once (sessions, vault state and device tickets live in the old origins' storage);
     addresses unchanged; logins and codes in flight and the Durable Objects' limiter counts lost. Partners: the new
     `vaultOrigin` in their CSP, the SDK release with the new origins, `{authOrigin}/login/callback` on their own Google
     clients, the identity token's new `iss` and JWKS.
  8. **Neon and Google Cloud.** The ledger's project is transferred to the company's Neon organization (connection
     strings unchanged, per Neon's docs) rather than re-created; the OAuth clients' Google Cloud project is migrated
     into the company's organization (project ID and number unchanged, per Google's docs; client ids to check after)
     or given company Owners, never replaced (new client ids would need new chain registrations).
- Why: origins that don't name an account survive the next move; the files in `.secrets/<env>/` are the only copies of
  every secret, so the move has to start from them and list what is missing rather than generate it; a pinned
  `account_id` and the shell check turn a wrong-account deploy into a refusal; an export imported whole keeps the
  schema, the data and `d1_migrations` consistent; the contract's multi-`iss` issuers make the URL change a two-step,
  address-neutral owner action.
- Rejected: staying on `workers.dev` on the new account (every origin, both `iss` and every partner's CSP and redirect
  URIs change again on the next move); `migrations apply` on the new database and a data-only import (two sources of
  the schema, and `d1_migrations` from the apply rather than the old database); `wrangler secret bulk` for every Worker
  (the per-secret `secret put` through stdin is what `vault-kek`, `identity-key` and `email-issuer` already use; one
  bad value fails one secret); a new Neon project or a new Google Cloud project (new credentials and roles; new client
  ids on chain); one registrable domain for production's vault (D38).
- Open: the company accounts and the dev domain (`id-dev.hanawallet.io` assumes the `hanawallet.io` zone is on the
  new Cloudflare account, or a plan with subdomain zones); the date (the user, with the colleague); a rehearsal on a
  throwaway `sandbox-*` env before sandbox-dev.

## Staff login: Cloudflare Access kept, on the free tier (branch `docs/zero-trust-free-guard`), 2026-11-05

### D408. The admin console keeps Cloudflare Access (Zero Trust Free); sandbox never goes past the free tier
- Date 2026-11-05 · Status: **decided by the user** ("let's stick with Zero Trust then … make sure we never hit
  overage for Zero Trust on sandbox") · Reconfirms D75 and D88 · Written: `docs/operations.md` "Admin Worker" step 1
- Context: Zero Trust's Free plan asks for a card authorised for usage past the free limits. Alternatives weighed the
  same day: our own Google staff sign-in (2–4 days; the admin console then public, sessions, CSRF and login abuse
  ours; the issuer would verify Google's own ID token to keep staff identity unforgeable by the admin Worker), a
  two-mode build switching to Access later (no breaking change, but throwaway work), Supabase Auth (a second account
  able to admit staff), CLI only.
- Decision: keep Access. On sandbox it stays inside the free tier: 50 seats, 2 used; the policy names exact emails
  only, Google is the only login method, and no other Zero Trust feature is enabled (Gateway, WARP enrolment,
  Browser Isolation, DLP and CASB are billed or metered per seat). Seat usage and billing are checked after setup and
  monthly; adding staff or a feature is checked against the free limits first.
- Why: Access keeps the admin console off the public internet and signs staff identity outside our code, for $0 at
  our size; the guard answers the card authorisation.
- Rejected: our own staff sign-in (more exposed, more code on the most sensitive screen), two modes (throwaway work),
  Supabase Auth.
## The API request ID in the SDK's errors (branch `feat/sdk-error-request-id`), 2026-11-05

### D405. The vault puts the API answer's request ID in a port error's `data.requestId`, for an SDK of 0.2.0 or later
- Date 2026-11-05 · Status: decided while building C15's follow-up (to confirm) · Built on
  `feat/sdk-error-request-id`: `packages/core/src/api-request-id.ts` (`API_REQUEST_ID_RE`, `isApiRequestId`,
  `apiRequestIdOf`, `API_REQUEST_ID_SDK_MIN`), `packages/web/src/vault/errors.ts` (`VaultError.requestId`,
  `fromRequest`, `toProtocol(withRequestId)`, `apiErrorToVault`), `vault/login.ts` (`LoginChain.noteAnswer`, `traced`;
  the relay read's refusal, `linkedApiError`), `vault/vault.ts` (`sdkTakesRequestId`, `replyError`,
  `revokeOtherDevices`, `identityError`), `packages/web/src/client/errors.ts` (`HanaError.requestId`, `HanaError.from`,
  `toProviderRpcError`, `toSwkError`), `apps/demo/src/{errors,diagnostics,page}.ts`; tests
  `packages/core/test/api-request-id.test.ts`, `packages/web/test/vault/request-id.test.ts`,
  `packages/web/test/vault/linking.test.ts` (the `/v1/link` refusal), `packages/web/test/client/request-id.test.ts`,
  `packages/react/test/{hooks,identity}.test.tsx`, `apps/demo/test/{errors,diagnostics,page}.test.ts`,
  `apps/e2e/tests/persistence.spec.ts` (the real API's 410 and its `x-request-id`), `apps/e2e/tests/login.spec.ts`
  (`token_has_pii` has none) · Source: build plan C15's open follow-up, D393, D394 · Number: D405 because branches in
  flight when written may take D401–D404 (D403 the highest on `develop`); renumber at merge if another branch took it.
- Context: the usage ledger keeps a user's uid on ok events only, so a failed request is found by its request ID
  (C15, D394), and the SDK's errors carried none: a partner had nothing to escalate with.
- Decision:
  1. **Which errors.** A port error that came from an API answer: the answer's own refusal (`apiErrorToVault`, and the
     vault's own mappings of one: `revokeOtherDevices`' `share_not_fresh` and gone share, `hana_identityToken`'s
     refusals, `/v1/link`'s `link_refused`, the login relay's 403/410), and any error the login's chain step ends with
     after one (a resend refused again, a recovery that gave up: `session_consumed`, `derive_failed`,
     `api_unavailable` after a timeout's poll or a re-sync). The chain keeps the latest API call's request ID when it
     failed with an answer and clears it on a success or a network error, so what it names is the answer the failure
     followed. Never: a check in the vault, a cancel or the login's own end (an aborted chain is not marked; the abort
     error is a shared object), a network failure, a NEAR read, Google's or the email issuer's answers (not in the
     ledger), the background calls (shares, touch, the wallet record), a dormant session the API won't unlock (it ends
     as `sessionExpired`; the request that woke it fails `4100` as before). Signing calls no API; key export's errors
     stay in the export window.
  2. **Only a request ID.** `API_REQUEST_ID_RE`, 8–64 of `[A-Za-z0-9-]`: what apps/api sends (a cf-ray or a UUID) and
     within what the lookup takes (`[A-Za-z0-9_-]{8,128}`). Anything else is dropped, never a reason to change the
     error; nothing else of the API's body is added (its message and details stay out, as before). The SDK checks again
     (`HanaError.from` drops a malformed `requestId` from `data`).
  3. **The gate.** The vault adds `data.requestId` only when the hello's `sdk` is `API_REQUEST_ID_SDK_MIN` (`0.2.0`) or
     later (`sdkAtLeast`, D393's mechanism; its own constant, equal to `SUPPORT_ID_SDK_MIN` because both ship in the
     unreleased 0.2.0). An older SDK's error parser doesn't check `data`, so the field wouldn't break it; the gate keeps
     D393's rule (an SDK gets exactly the shapes it was built against: a partner comparing `data` keeps working).
  4. **On the SDK.** `HanaError.requestId` (null without one); the EIP-1193 provider's `data.requestId` beside
     `data.code` for a string code (a numeric code passes `data` through, so the same key); the SWK module's `ext[1]`.
     React needs nothing of its own (`useHana().error` and `useIdentityToken().error` are HanaErrors).
  5. **Not in `hana_status`.** Status is session state; request IDs are per call, and a success is already found by
     the Support ID (its ok events carry the uid). Partners keep the IDs of the errors they get; the demo's *Copy
     diagnostics* has each error's `requestId` and `requestIds`, the latest five distinct ones.
- Why: the partner escalation the Support ID lookup expects (Support ID plus request IDs) needs the IDs in the place a
  partner already handles: the error.
- Rejected: a recent-request-IDs list in `hana_status` or the SDK (more protocol and vault state for no lookup gain);
  attaching the operation's latest API request ID to every error it ends with (a cancel or a vault check after an
  earlier answer would name a request that didn't cause it); forwarding the API's message or its whole body (free
  text: only codes and checked fields reach the partner page); no gate (D393's rule).
- Trade-offs: an SDK before 0.2.0 gets none (no partner uses one yet); a failure after a network error names no request
  even when an earlier attempt was answered.

## The admin console's Cloudflare Access by script (branch `feat/access-setup`), 2026-11-05

### D409. `access-setup <env>` makes the admin console's Access application and staff policies through Cloudflare's API; sandbox* staff sign in with Google, exact emails only
- Date 2026-11-05 · Status: **decided by the user** (2026-11-05: sandbox staff sign in with Google, exact emails only,
  no GitHub team for sandbox; session 1 h; no service tokens; the Free plan; the user makes the Zero Trust team and
  the Google login method in the dashboard); implementation choices: to confirm · Built on `feat/access-setup`:
  `scripts/access-setup.ts`, `scripts/lib/access-setup.ts`, `scripts/lib/cloudflare-api.ts`,
  `scripts/lib/manifest-edit.ts` `setAdminAccess`, `scripts/lib/secrets.ts` `readOneLineSecret`, `.gitleaks.toml`
  (`cloudflare-access-token` in `hana-secret-file`); tests `scripts/test/access-setup.test.ts` (a mocked Cloudflare
  API; the script was not run against Cloudflare), `scripts/secret-scan-selftest.mjs` · Amends D88 for `sandbox*`
  envs and D284's "Worker-level Access to be turned on in the dashboard" · Enforces D408 (the free tier)
  for `sandbox*` · Number: written as D407 (D403 the highest on `develop`, D401–D406 possibly taken by branches in
  flight), renumbered D409 because D408 merged first; renumber at merge if another branch took D409 first.
- Context: `docs/operations.md` "Admin Worker" step 1 was dashboard clicks only (the workers.dev toggle, a policy by
  hand, the AUD copied by hand), with nothing to tell later whether the live policy still matched `admin.staffEmails`.
- Decision:
  1. **What Access holds, from the manifest's `admin` block.** One self-hosted application `Hana ID admin (<env>)` on
     `admin.origin`'s host (`domain` and one `public` destination), session `1h`, `http_only_cookie_attribute: true`,
     `same_site_cookie_attribute: lax` (the Worker's CSRF check is written for Lax), `app_launcher_visible: false`, and
     reusable Allow policies, attached in order, none with a service-token rule:
     - `sandbox*`: `Hana staff (<env>)` = include each `admin.staffEmails` address (`email` rules, exact), require the
       Google login method (`login_method`); allowed IdPs = Google only, `auto_redirect_to_identity: true`.
     - every other env (D88): `Hana staff GitHub (<env>)` = include `github-organization` `Hana-Technology` / team
       `hana-admins` (precedence 1), then `Hana staff (<env>)` as above (the exact-email Google fallback); allowed IdPs
       = GitHub and Google, no auto-redirect (Cloudflare skips the picker only with one IdP). Both policies' session
       is `1h` too.
  2. **Endpoints** (`/accounts/{account_id}` + …; Cloudflare API v4): `GET /access/organizations` (`auth_domain`, the
     team domain), `GET /access/identity_providers` (the login method of type `google`, and `github` outside
     `sandbox*`; none, or several without `--google-idp`/`--github-idp`, is refused with where to add it), `GET`/`POST
     /access/policies`, `PUT /access/policies/{id}`, `GET`/`POST /access/apps`, `GET`/`PUT /access/apps/{id}`; `GET
     /accounts` only without `--account-id`/`CLOUDFLARE_ACCOUNT_ID`. Policies are found by name, the application by
     host, public destination or name; it refuses two matches, a non-self-hosted match, duplicate policy names and an
     `all_workers` application (it would front the admin Worker with another AUD), and points out a Worker-level
     (`worker`) one. It never deletes anything and never creates a login method or the team.
  3. **The token**: `.secrets/<env>/cloudflare-access-token` (0600, one line, refused otherwise), an account API token
     with exactly "Access: Apps and Policies Edit" and "Access: Organizations, Identity Providers, and Groups Read" on
     the API's account, made the same day and deleted after use (`--check` needs only "Apps and Policies Read").
     It goes only into the `Authorization` header of an in-process `fetch` (`redirect: 'error'`). No response body is
     printed or put in an error: an error carries the HTTP status, up to three of Cloudflare's `code: message` pairs
     (trimmed, the token removed) and, for 401/403, the permission the call needs.
  4. **Modes**: dry run by default (reads, prints per object `create`, `update (what differs)` or `matches`); `--yes`
     creates or updates the policies, then the application (a PUT of the whole object), and prints the application
     id, the team domain and the AUD tag (none is secret); `--write-manifest` (with `--yes`) puts `accessTeamDomain`
     and `accessAud` into `envs/<env>.json` in place, keeping the file's formatting; `--check` compares the emails,
     sessions, IdPs, auto-redirect, policies attached and their order, cookie settings, the team domain and the AUD
     with the manifest and exits 1 on any difference. Retries: 429 for any method, a 5xx or a lost answer only for GET
     and PUT; a POST is never sent twice (a re-run finds what it made).
  5. **workers.dev**: a hostname application, not the dashboard's Worker-level toggle. Cloudflare documents
     self-hosted applications on a `workers.dev` hostname (developers.cloudflare.com/workers/configuration/cloudflare-access/);
     the Worker-level kind (`destinations: [{type: "worker", worker_id}]`) is API-able but needs the Worker's id, so the
     token would also need Workers Scripts Read, and it covers preview URLs and routes, which the admin Worker doesn't
     have (`preview_urls: false`, no routes on workers.dev; D284). For the admin Worker the two protect the same
     requests and both send the JWT with the application's AUD; the same script works unchanged on a production Custom
     Domain.
  6. **The free tier on `sandbox*`** (D408, asked for by the user the same day): before any request, more than 50
     `admin.staffEmails` (the Free plan's seats) is refused and more than 10 warned about; `freeTierProblems` refuses
     to write a sandbox policy with any include but an exact email (no domain, `everyone`, group or IdP-group rule), a
     requirement but the Google login method, or an application allowing any IdP but Google; `--check` labels a live
     non-email include or another allowed IdP as a free-tier breach (`(free tier, D408: …)`) and exits 1, and `--yes`
     puts it back; other login methods on the account (e.g. One-time PIN) are pointed out for removal. The script
     calls only the Access endpoints above, so it enables no other Zero Trust feature; seat usage and billing stay a
     dashboard check (D408).
- Why: one command per env that is repeatable and checkable, so a staff change or a stray dashboard edit shows up as
  drift; the dashboard keeps only what isn't worth scripting (the team, the login methods, the token).
- Rejected: the dashboard only (no drift check; the AUD copied by hand); the Worker-level toggle or `worker`
  destination (a wider token, a different kind per env); application-only (inline) policies (the update semantics of
  inline policies on an application's PUT aren't documented; reusable policies have their own CRUD); one policy mixing
  the GitHub team and the emails without a Google requirement in production (an email rule would then match any
  allowed IdP, against D88's "exact-email Google identities"); Terraform (another tool and a state file for two
  objects); a content rule in gitleaks for Cloudflare tokens (40 characters with no prefix: too generic; the default
  `cloudflare-api-key` rule catches one next to the word "cloudflare").
- Trade-offs: while it exists the token can change or delete any Access application and policy of the account
  (`docs/security.md`), so it is short-lived and deleted after use; reusable policies are account-wide, so their names
  carry the env; a PUT resets application settings the script doesn't manage to Cloudflare's defaults; an
  application made by the dashboard toggle isn't matched (only pointed out), so it is turned off first.

## Every Worker stamped: the dashboard Workers and the watchdog in `deploy-check` (branch `feat/deploy-check-all-workers`), 2026-11-05

### D406. The console, console-auth, files, admin and watchdog Workers carry the build id; the admin's and the watchdog's are read from their deployed version with wrangler
- Date 2026-11-05 · Status: **asked for by the user** (implementation choices: to confirm) · Amends D384 (its
  "Limits": those five Workers weren't stamped; and its rejected "Cloudflare's version metadata", see "Why") · Built:
  `packages/env/src/stamped-deploy.ts` (the one wrapper), `build-id.ts` (`deployedBuild`, `buildBody`); each app's
  `deploy` script; `apps/console/src/index.ts`, `apps/console-auth/src/index.ts`, `apps/files/src/index.ts`
  (`/.well-known/hana-build`); `apps/console/scripts/build-stamp.ts`, `vite.config.ts` (the SPA's meta);
  `scripts/lib/deploy-check.ts` (groups, `--only`/`--skip`, wrangler reads, the console's and watchdog's D1 in `--d1`)
  · Number note: D406 was chosen with D401–D405 possibly taken by branches in flight (D403 and, by merge time, D408 on
  `origin/develop`; D404–D407 not there); a branch racing this one may take D406 too: renumber on merge
- Context: D384 stamped the API, both page Workers and the email issuer; the other five Workers of an env could run
  any commit unseen.
- Decision:
  - **One wrapper.** Every app that deploys a Worker of an env (api, email-issuer, console, console-auth, files, admin,
    watchdog) runs `tsx ../../packages/env/src/stamped-deploy.ts [args]` as its `deploy` (and the API's `deploy:pages`):
    `wrangler deploy <args> --var HANA_BUILD:<id>`. The per-app copies (`apps/api`, `apps/email-issuer`
    `scripts/deploy.ts`) are gone. The console's `deploy` stays `vite build &&` the wrapper. The watchdog's deploy, a
    raw `wrangler deploy` until now, goes through `run deploy` too.
  - **Public Workers: the page Workers' route.** The console, console-auth and files Workers answer `GET`/`HEAD
    /.well-known/hana-build` with `{"build": <id> | null}` on their own origin only, under their usual headers (the
    console's CSP and `no-store`; console-auth's allow-nothing CSP; the files Worker's sandbox CSP and `no-store`),
    without touching the console's AuthHandler or the logo bucket. Other methods: 405 (console, files) or 404
    (console-auth, which serves nothing else).
  - **The console SPA is stamped too**: `vite build` writes `<meta name="hana-build">` into `dist/index.html`, read from
    `{console.origin}/`. dist/ is gitignored and survives checkouts, so a dist/ built elsewhere is the vault's
    2026-11-05 risk again; the meta shows it.
  - **The admin: no route.** Its whole origin is behind Cloudflare Access, which deploy-check can't pass and which gets
    no exception. deploy-check reads the deployed version's `HANA_BUILD` with wrangler, logged in to the API's account
    (as for any deploy): `wrangler deployments status --name <worker> --json`, then `wrangler versions view <id>
    --name <worker> --json`, both read-only, run from an empty directory so no generated config applies. Only that
    var is taken from the output; nothing else (other vars, the author's email) is printed. A gradual deployment (two
    versions, or one under 100%) is a failure. The admin's `public/` assets ship in the same version from the same
    tree (no build step), so the var covers them.
  - **The watchdog: the same wrangler read, on its own account**, with `CLOUDFLARE_ACCOUNT_ID` =
    `watchdog.cloudflare.accountId`. Every watchdog route needs the status token (C14) and it has no public health
    route; none is added (D86 keeps its surface minimal). As its account has its own login, a default run doesn't read
    it (it says so): `deploy-check <env> --only watchdog`, logged in there, does.
  - **Groups and flags.** Each piece is in a group (api, pages, issuer, console, console-auth, files, admin,
    watchdog), read when the manifest has it; `--only` / `--skip` take groups. `--d1` adds the console's D1 (and the
    watchdog's, with `--only watchdog`).
- Why: the public Workers get the route the page Workers already have (one reader, one shape). For the admin, a hole
  in Access is not worth a build id; the authenticated admin API can't be reached by a script either. D384 rejected
  "Cloudflare's version metadata" for its version id and tags, which say nothing about the commit; here the metadata
  carries the `HANA_BUILD` var itself, so the read is as good as the HTTP one, needs no binding, and needs only the
  login the deploy already used.
- Limits: the admin's and the watchdog's reads need wrangler credentials for their account (a login with several
  accounts: set `CLOUDFLARE_ACCOUNT_ID` for the admin's); the hosted demo (`apps/demo`) isn't an env Worker and stays
  unstamped. As in D384, the id is reported by whoever deploys: a hygiene check, not an attestation.
- Rejected: a route on the admin excluded from Access (a hole in the staff console's perimeter); a `build` field on
  the watchdog's `/status` read with the status token (deploy-check would hold a secret); a public route on the
  watchdog; copying `scripts/deploy.ts` into each app.

## Partners and user emails: the sharing design (branch `docs/email-sharing-decisions`), 2026-11-05

### D411. Partners see a user's email only after the user shares it with that app; a three-value app setting decides when Hana asks
- Date 2026-11-05 · Status: **decided by the user** ("all as recommended", 2026-11-05), **not built**: after batch C's
  Users screen is live (M4) · Amends D127 (Q6, Q7: the identity token spec's "Verified email: opt-in per app") ·
  Source: the proposal of 2026-11-05 (Privy, Dynamic, Magic, Web3Auth and Turnkey compared: wallets the developer owns
  show emails with no consent step; Magic's cross-app Universal Wallet asked per app, as Hana Home's wallets put Hana)
- Decisions (1–9 of the proposal, each as recommended):
  1. **Model:** a partner sees a user's email only after the user shares it with that app (not Privy's shown-by-
     default). Until this ships, partners see none (as today: `emailStatus` is always `off`, `partnerUserView` drops
     it).
  2. **When Hana asks:** a per-app setting `identity_email` = `off` (default: never asked, never shared) /
     `on_request` (asked only when the partner calls `requestEmailSharing()`, e.g. from its own button) /
     `at_login` (asked once per user and app, at first login, before the wallet opens). One sheet showing the app's
     name and the exact address: "Share email" / "Not now".
  3. **Consent unit:** per app × account (the User ID `u1_…`, so a linked account has one consent), not per scope.
  4. **Dashboard source:** on a grant the API keeps a copy of the shared address in its hot D1 (deleted on revoke and
     by erasure, C13); the partner console reads that copy through `ConsoleRpc`, never the issuer (D275's boundary).
     Consents live in the hot D1 too: not on chain (public: it would show which apps a user uses, as D310 rejected
     on-chain addresses) and not in the vault's browser storage (per device; the dashboard couldn't read it).
  5. **A second address after linking** (e.g. `ada@gmail.com` shared, then `ada@work.com` linked): asked once more for
     the new address; a consent covers only the address it was given for (stored as a MAC).
  6. **Revoke before Hana Home exists:** the popup's account view, and the partner's `requestEmailSharing()` to ask
     again; Hana Home lists every consent later. A revoke drops the email from new identity tokens (tokens already
     issued keep it until they expire, ≤ 1 h) and from the dashboard at once; the screen says the partner may keep the
     copy it already received.
  7. **Never mandatory:** "Not now" always continues the login (D127 Q7).
  8. **Partner search by email:** only over addresses shared with that partner's apps, so an unshared address can't be
     probed (D315's rule).
  9. **Timing:** built after the M4 consoles; emails stay hidden until then.
- What the partner gets once shared: `email` with `email_verified: true` in identity tokens (`emailStatus:
  'included'`), and an **Email** column on the console's Users screen ("Not shared" otherwise).
- Privacy: off by default; specific, informed consent (the sheet names the app and shows the address); withdrawing as
  easy as giving; login never depends on it (GDPR Art. 4(11), 5(1)(b–c), 7(3–4)). Partner terms to require stated
  purposes and deletion on request; counsel to confirm roles (`docs/mainnet-readiness.md` legal). Caveat (D42): an app
  on its own Google client can read the email through Google regardless; the sheet must not promise otherwise.
- No wallet address, path or key derivation changes.
- Rejected: Privy's shown-by-default (the user's rule); a checkbox on the login screen (low coverage, a vague promise
  before a Google user's address is known, shown on every login); a live issuer read for the dashboard (breaks D275).

## Security review fixes of 2026-11-05's merges (branch `fix/security-review-1105`), 2026-11-05

### D410. A search that names one identity needs the ticket; `users/find` is ticketed and audited first; an opened user never reaches the URL; a lookup's audit lists its request IDs
- Date 2026-11-05 · Status: decided while fixing a security review of the day's merges (the review asked for these
  fixes; the rules chosen: to confirm) · Built on `fix/security-review-1105`: console-core `directory.ts`
  (`searchNamesIdentity`, `SEARCH_TICKET_REQUIRED`, `directorySearchInput`'s refine) and `staff.ts` (`users.find`,
  `ORGLESS_STAFF_ACTIONS`, the request-ID list detail); `apps/email-issuer/src/directory-rpc.ts` `search`;
  `apps/admin/src/users.ts` (`usersSearchRoute`, `usersFindRoute`), `src/support.ts`, `src/feed.ts`, `public/app.js`
  (`openUser`, `userLink`, `USER_OPEN_PATH`, the Users search's ticket check, `go(path, state)`);
  `apps/console/src/audit.ts`, `staff-rpc.ts`; tests `apps/admin/test/users.test.ts`, `test/support.test.ts`,
  `test-spa/support.test.ts`, `scripts/test/gen-wrangler.test.ts`, `apps/email-issuer/test/directory-rpc.test.ts`,
  `apps/console/test/{privacy,staff-actions}.test.ts`, `packages/console-core/test/directory.test.ts` · Amends D391,
  D392, D396, D399 · Number: D409 the highest on `develop` when written (D401/D402 held on
  `feat/sandbox-dev-dashboard-blocks`); its sibling was written as D411 and renumbered D412 when
  `docs/email-sharing-decisions` merged D411 first (`feat/local-verify` holds D413); renumber at merge if another
  branch takes D410 or D412 first.
- Context: the review found that (a) `POST /api/users/search` with a `sub` filter returned the identity's full row
  (address included) with no ticket: `get` without its ticket; (b) `POST /api/users/find` took User IDs, internal ids,
  Support IDs and wallets with no ticket and no audit row, though `/api/support/lookup` audits the same ids first
  (D396); (c) the SPA's detail path `/users/<provider>/<sub>` put the sub in browser history and in the edge's and
  Access's request logs, against users.ts's own header and D391; (d) the `support.lookup` row kept only the count
  of the escalation's request IDs, so the audit couldn't say which events were looked at.
- Decision:
  1. **The ticket rule of a search: required when it names one identity.** A `sub` filter (with any other filter) or
     a full address (console-core `isFullAddress`: the exact, indexed match) needs a support reference in the
     `SUPPORT_TICKET_RE` rule; console-core `directorySearchInput` refuses one without (the issuer answers
     `bad_request` with `SEARCH_TICKET_REQUIRED`, before the token, the budget or a row is read), and the admin BFF
     refuses it before calling the issuer. Browsing (a part of an address of ≥ 3 characters, the account kind, an
     app, "unverified only", no filter) stays ticketless, as D392 had it. The rule is on the input, not on the result
     ("an exact match that returns ≤ 1 identity" would need the read before the refusal, and staff couldn't know in
     advance whether to give a ticket).
  2. **`POST /api/users/find` is ticketed and audited first.** It takes a wallet address, a User ID, an internal id
     or a Support ID (console-core `parseUserSearch`; a sub is refused: the directory search's `sub` filter is its
     place) and a ticket (required), and first writes the console's `audit_log` row through
     `StaffRpc.recordStaffAction`: action `users.find`, org-less (refused with an org, as `support.lookup`; never
     emailed by the feed), `target` the id or wallet address as normalized (never a sub), `details {by, ticket}`
     (`by`: `stellar`, `evm`, `userId`, `internalId` or `supportId`). No row, no read (503 / 500). The SPA sends the
     ticket typed in the Users search, and the Support ID screen's "Wallet directory only" its own.
  3. **An opened user lives in memory at one fixed path.** The SPA's detail is `/users/open`; every link to an
     identity (a search row's "Open", a wallet-directory user's identities, the chain's root and members, a lookup
     match's subs) has that `href` and opens the identity from memory (`openUser`). The history entry holds only an
     opaque number (`{user: n}`) into this tab's `opened` map (at most 50), so back and forward move between the users
     opened in the tab, and a reload, a new tab or a copied link shows "No user open" and reads nothing. The old
     `/users/(email|google)/<sub>` path is rewritten to `/users` with `replaceState` and reads nothing. The ticket
     typed in the search is carried (in memory) to the detail and the lookup.
  4. **A lookup's audit row names its request IDs.** `support.lookup`'s details add `requestIdList`: the distinct
     request IDs (≤ 20, each in console-core's request-ID form `[A-Za-z0-9_-]{8,128}`), beside `requestIds` (the
     count, kept so older rows read the same). It is the one detail that may be a list: `recordStaffActionInput`
     refuses a list on any other key or action, and a non-list `requestIdList`.
- Why: every read that names one person now carries a reason in an audit row (the issuer's `user_search` row with its
  ticket, or the console's `users.find`), as `get` and the lookup already did; listing (the C8b screen's browsing)
  keeps working without one. A URL is logged in places the SPA doesn't control (history sync, Access and edge logs);
  memory isn't.
- Rejected: omitting `email` from ticketless search rows (the substring search exists to find an address: a list
  without addresses would make C8b's browsing useless, and the `sub` path would still confirm an identity and its
  history); routing User IDs and Support IDs only to `/api/support/lookup` (it costs up to 20 directory rows and the
  ledger read when only the wallet directory was wanted); keeping the sub in the history state (session history is
  persisted by browsers like the URL is).
- Trade-offs: support must type the ticket before searching a full address (it is already needed to open the
  result); a substring long enough to match one address still lists it without a ticket (bounded by the row budget and
  audited with the term's keyed hash, D389, D390); a reload of an opened user's page needs the search again.

### D412. `usage-setup hyperdrive` creates the configs through Cloudflare's API; a failed reset sets the roles not reset NOLOGIN
- Date 2026-11-05 · Status: decided while fixing the security review (to confirm) · Built on
  `fix/security-review-1105`: `scripts/lib/usage-setup.ts` (`hyperdriveCommand`, `hyperdriveBody`, `lockRoles`,
  `CLOUDFLARE_HYPERDRIVE_TOKEN_FILE`), `scripts/lib/cloudflare-api.ts` (`resolveAccount` moved from
  `access-setup.ts`; `readCloudflareToken`'s `how`), `scripts/usage-setup.ts`, `.gitleaks.toml`; tests
  `scripts/test/usage-setup.test.ts` (a mocked Cloudflare API; not run against Cloudflare) · Amends D224 (the wrangler
  create) and D403 (the throwaway password) · Closes `docs/mainnet-readiness.md` 4.18.
- Context: `hyperdrive` ran `wrangler hyperdrive create … --connection-string=<role URL>`, so each role's password was
  in the local process list while wrangler ran, though the file's header said no password travelled in an argument.
  wrangler has no other input for it (`--origin-password` is an argument too; its docs list no stdin, file or
  environment input). And `roles` gives both roles LOGIN with a throwaway password before Neon's resets: a reset that
  failed left the role after it with LOGIN and that password (never stored, but valid until a later run).
- Decision:
  1. **The configs through Cloudflare's REST API** (`POST /accounts/{account}/hyperdrive/configs`, CloudflareApi):
     body `{name, origin: {scheme: postgres, host, port, database, user, password}, caching: {disabled: true}}` from
     the role file, the password only in the HTTPS body (Cloudflare documents it as write-only, never returned). The
     token is read from `.secrets/<env>/cloudflare-hyperdrive-token` (one line, 0600; an account token with only
     Hyperdrive Edit, revoked after), the account from `--account-id`, the manifest's `cloudflare.accountId`,
     `CLOUDFLARE_ACCOUNT_ID`, else the token's only account. A refusal prints Cloudflare's code and message with the
     token, the URLs and the passwords removed; a taken name (code 2017) says how to delete and re-create; a POST whose
     answer is lost isn't sent again. wrangler stays for `user-id-key` (stdin).
  2. **NOLOGIN after a failed reset.** When a reset fails after the throwaway's COMMIT, `roles` opens a new owner
     connection and runs `ALTER ROLE <role> NOLOGIN` for each role Neon didn't reset, then fails with the usual
     message plus what it locked; if that fails too, the message says which role still has LOGIN and the SQL to run,
     the owner URL and every password removed. The next successful run gives LOGIN back.
- Why: the password stays where it was already allowed (a 0600 file and an HTTPS body); a dead-end throwaway login is
  closed as soon as the run knows it won't be replaced.
- Rejected: `--origin-password` (still an argument); wrangler's `--env-file` (undocumented for this command); keeping
  wrangler and only correcting the comment (4.18 open for mainnet with a known fix of this size).
- Trade-offs: one more short-lived token to create and revoke per setup; NOLOGIN is best effort (a dropped
  connection after the failed reset can stop it too, and then the message says so).

## The local gate while CI is off (branch `feat/local-verify`), 2026-11-05

### D413. `pnpm verify` runs CI's checks for the change locally; the default tier before every merge into develop, `--full` before a deploy; an optional pre-push hook
- Date 2026-11-05 · Status: **asked for by the user; confirmed by the user** (2026-11-05: the contract and sandbox e2e
  jobs in the default tier when Rust changed, and every package on a push to `main`, both kept as recommended) · Built:
  `scripts/verify.mjs`, `scripts/verify-hook.mjs`, `.githooks/pre-push`, the root `verify` and
  `verify:install-hook` scripts; `scripts/test/verify.test.ts` · Amends D387 ("checks run locally before a merge",
  by a list of commands nothing ran for you) · Number note: D413 was taken with D409 the highest on `origin/develop`,
  D401/D402 held on an unmerged branch and D410–D412 left to branches in flight (D410–D412 merged before this branch,
  as expected); a branch racing this one may take D413 too: renumber on merge
- Context: CI is off (D387) and merges into `develop` are done locally by an assistant, so the only gate is what is
  run by hand; the list in docs/operations.md was easy to run partly, or against a stale tree.
- Decision:
  - **Three tiers, one command.** `pnpm verify --quick`: `pnpm install --frozen-lockfile`, gitleaks (history, the
    uncommitted changes, the rule self-test), typecheck and unit tests of the affected packages, the docs checks
    (`@hana-id/playbooks`, `examples/identity-verify`, core's `integration-doc` test). `pnpm verify` (default): plus
    what a `develop` push ran in CI, picked by `scripts/ci-changes.mjs` `classify` (D383): contract and sandbox e2e
    when Rust changed, the pack check and Playwright on Chromium when web code changed. `--full`: everything, all
    three browsers.
  - **The rule.** The assistant runs the default tier on the merged result before every push of `develop`, and
    `--full` on the commit to be deployed before any deploy; nothing merges or deploys on a failure. Recorded in
    docs/operations.md "CI and git".
  - **Affected packages.** The change is merge-base(`origin/develop`, HEAD) to the working tree, untracked files
    included. A package's change runs it, its dependents and the packages whose code names a path in it,
    transitively, and the packages whose tests name a path in those (found by scanning tracked files for `../`
    paths, `join(repoRoot, …)` and root-relative strings, comments ignored); a doc outside the packages runs the
    suites that name it; any other file outside the packages, or a change to the CI or verify definitions, runs
    every package.
  - **Order and output.** Phases cheapest first, stopping at the first failure; gitleaks beside the typecheck, the
    docs checks beside the unit tests, nothing beside the unit tests' 4-at-a-time run (the PGlite and workerd suites'
    timeouts, D140); `CI=true` for vitest (no stray `.only`), `--forbid-only` for Playwright; each step's output in a
    temp-dir log, the failing one's tail printed, and a step / result / duration table.
  - **Pre-push hook, optional.** `pnpm verify:install-hook` sets `hana.verifyPrePush` in the clone's git config;
    `.githooks/pre-push`, beside the gitleaks pre-commit hook and installed the same way (`core.hooksPath`), then runs
    `--quick` on a push to `develop` (from the remote tip it replaces) or `main` (every package) and stops the push on
    a failure. Feature branches and tags skip. It refuses a push whose commit isn't the checked-out HEAD or whose tree
    is dirty (it would check the wrong tree), and has no skip switch.
- Why: CI's own selection rules, reused, keep local and CI runs comparable; the tiers match how often each is
  affordable (`--quick` in minutes, the e2e and Rust jobs only when they can be affected); a hook only on the two
  shared branches doesn't slow feature work.
- Trade-offs: the workspace is densely linked, so most code changes still select every package (docs-only and leaf
  changes are the ones narrowed; the full TS suite is about a minute and a half on an idle machine anyway). The path
  scan is a heuristic: a read built at run time from parts it can't see would be missed (over-reporting only runs
  more tests). Local runs are macOS, not Linux (D381's WebKit bug would pass). The hook is opt-in per clone, and
  `git push --no-verify` skips any hook: the rule above, not the hook, is the gate.
- Rejected: husky or lefthook (a dependency for what `core.hooksPath` already does); a hook always on (every push of
  a feature branch would pay for it); running unit tests at full parallelism or beside the typecheck (PGlite
  timeouts); an environment variable to skip the hook (a silent bypass); always every package (docs-only branches
  are common, D383 counted 17 of 73 commits).

## M4 on the personal account (branch `feat/m4-personal-account`), 2026-11-05

### D414. sandbox-dev's milestone M4 is set up on the personal Cloudflare account now; the company account move redoes it later
- Date 2026-11-05 · Status: **decided by the user** · Built: the held branches `feat/sandbox-dev-dashboard-blocks`
  (D401, D402) and `fix/sendgrid-suppression` merged into `develop` with this entry; `scripts/lib/env-secrets.ts` (D404)
  moved to the SendGrid keys (`admin-sendgrid-key`, the watchdog's `SENDGRID_API_KEY`) · Amends D404 ("testnet moves to
  company accounts", timing open, and the hold of the dashboard-blocks branch until the company account exists) ·
  Number note: D414 was taken with D413 the highest on `origin/develop`
- Context: the move to company accounts (D404) won't happen soon, and the admin console, the partner console, the files
  Worker, usage capture and SendGrid had nowhere to be tested: their manifest blocks were held so as not to build
  sandbox-dev's M4 on an account it will leave.
- Decision:
  - **Now, on the personal account** (`*.tingtc.workers.dev`): every M4 resource for sandbox-dev, by the manifest's
    blocks as merged: the admin console's Cloudflare Access application on Zero Trust team `bitter-hill-fe6f` (made by
    `access-setup`, D409), the console D1, the three R2 buckets, the Images binding, the usage Hyperdrive configs, the
    admin's and the watchdog's SendGrid keys, the console's Google OAuth client, and the admin, console, console-auth
    and files Workers.
  - **Later, on the company account**: the D404 runbook ("Moving an env to another Cloudflare account") re-creates all
    of it there, with the same manifest blocks under new origins; nothing here is reused across accounts except data
    the runbook copies.
  - **The free-tier guard stays** (D408): exact staff emails only, 2 seats, no Zero Trust add-ons, seats and billing
    checked after setup and monthly.
- Why: testing the M4 surfaces can't wait for the account move; redoing the setup once is cheaper than holding the work.
- Trade-offs: the setup is done twice (Access application, OAuth client, R2, D1, Hyperdrive, SendGrid keys); the console
  Google client's redirect URIs and the Access application's host are `tingtc` workers.dev hosts that change at the move. With the admin
  block in the manifest, `admin app:changes:announce` refuses sandbox-dev (staff proposals wait for the admin Worker's
  notices), and until `access-setup` writes the real team domain and AUD the admin Worker and the issuer's
  `DirectoryRpc` refuse every staff call.
- Amended 2026-11-06 (the user): the SendGrid plan has no subusers, so sandbox-dev's issuer, admin Worker and watchdog
  keys (each Mail Send only) sit in one account and share its suppression lists; accepted for testnet, D194's own
  issuer subuser stays required for production (docs/operations.md "Admin Worker" step 2).
- Rejected: waiting for the company account (no date); a separate throwaway env for M4 (another set of NEAR accounts,
  issuers and OAuth clients for no gain over redoing sandbox-dev's setup).

## Automatic deployment later (branch `docs/auto-deploy-intent`), 2026-11-06

### D415. Deploys become automatic (CI/CD) later, for every part that can be automated without weakening security
- Date 2026-11-06 · Status: **decided by the user** (intent; not designed or built) · Built: nothing yet; row 4.22 of
  docs/mainnet-readiness.md tracks it · Number note: D415 was taken with D414 the highest on `origin/develop`
- Context: every deploy is run by hand from a local checkout (`run deploy` per Worker, `deploy-check` after, D384,
  D406), with `pnpm verify --full` before it as the only gate while CI is off (D387, D413).
- Decision: once CI is back on (row 4.20) and the company accounts exist (D404), design automatic deployment for
  whatever parts can be automated **only if it is fully secure**; a part that can't meet that stays manual. To be
  settled in that design, as the starting position:
  - **Candidates:** the Workers built from the repo (API, vault and auth pages, email issuer, console, console-auth,
    files, admin, the hosted demo), D1 migrations that only add, and the SDK's npm publish (with provenance).
  - **Stay manual:** the contract (deploys, upgrades and owner calls go through the council, D80), the watchdog (its own
    account, deployed by hand from a founder's machine so a compromised Hana account or pipeline can't silence it, D86,
    D125), every secret upload, and key generation or rotation. No private key, CKD secret, relayer or owner key ever
    reaches CI.
  - **Requirements:** deploy only from `develop`/`main` (or release tags) after the full check passes on that commit;
    a GitHub Environment per env with required reviewers (production: a second person); Cloudflare API tokens per
    account, least privilege (Workers Scripts and D1 edit on that account only), stored as environment secrets, never
    readable by pull-request or fork workflows; actions pinned by commit SHA; the build id stamped as today (D384) and
    `deploy-check` run after each deploy; the watchdog and audit trail notice a deploy nobody approved.
- Why: hand deploys are slow and depend on one machine and one person; automating them is only worth it if the pipeline
  can't become the easiest way to change production.
- Rejected: automating now (CI is off, D387, and the deploy tokens would sit on the personal account, D414).

## Retiring a console client (branch `feat/console-remove-audience`), 2026-11-06

### D416. A retired console client leaves its sink by `admin console:remove-audience`, only once the manifest has dropped it
- Date 2026-11-06 · Status: **decided while building** (to confirm) · Built: `scripts/lib/admin-console-sink.ts`,
  `isConsoleSinkView` in `scripts/lib/deploy-plan.ts` (shared with deploy-contract's sink test), deploy-contract's
  blocker naming the command; `scripts/test/admin-console-sink.test.ts`, `scripts/test/deploy-plan.test.ts`; docs/operations.md
  "Console sink scope" · Extends D238 · Number note: D416 was taken with D415 the highest on `origin/develop`
- Context: sandbox-dev's console client was replaced (2026-11-06). deploy-contract moved the old one (`…j6l32…`, still in
  `global`) and the new one into sink `s3`, but with the old one dropped from `consoleAudiences` it refuses `s3` as "not a
  Hana console sink" (a client that isn't a console audience), and `owner:call` sends only the contract's owner methods,
  not the scope-owner call `remove_client`. Nothing could take the old client out.
- Decision: a dedicated command, `admin <env> console:remove-audience <aud> [--provider google]`, rather than opening
  `owner:call` to `remove_client`: `remove_client` acts on any scope, and a general entry would let the owner remove a
  partner's client from a partner scope the owner also owns. It sends one `remove_client(sN, Near, provider, aud)` through
  the manifest's owner (a council proposal; `--approve-with` on dev envs), dry run by default, and re-reads `get_scope`
  after. It refuses an audience still in `consoleAudiences` (the manifest decides what is trusted: drop it there first), a
  client of `global` (deploy-contract moves those) or of no scope (nothing to do), a scope that isn't a Hana console sink
  by deploy-contract's own test with the retired audience allowed (`isConsoleSinkView`: owners only known Hana accounts,
  clients only console audiences, no shared login), a sink the manifest's owner isn't an `Owner::Near` of (the
  predecessor `remove_client` needs), and the sink's last client (the contract refuses it). deploy-contract's blocker for a
  Hana sink holding a client no longer in `consoleAudiences` now names the command. Afterwards deploy-contract's
  `set_console_audiences` drops the old audience from the API's list.
- Why: the stale client is harmless once deleted in Google (Google mints no token for it), but a manifest listing a
  client nobody uses, or a deploy-contract that refuses every run, both hide drift; this keeps the manifest, the sink and
  `console_audiences` equal.
- Rejected: keeping the old client in `consoleAudiences` for good (a trusted audience nobody controls the use of, flagged
  by a security review); `owner:call remove_client` (too general, above); deploy-contract removing sink clients not in the
  manifest on its own (a run that only adds or sets would then also take clients away, with no separate dry run).

## Free tiers only on the personal account (branch `docs/personal-account-free-tier`), 2026-11-06

### D417. sandbox-dev never goes past a free tier while it runs on the personal account
- Date 2026-11-06 · Status: **decided by the user** · Built: docs/operations.md "Admin Worker" (the rule, what could
  bill, the monthly check) · Extends D408 (Zero Trust only) to every service · Number note: D417 was taken with D416
  the highest on `origin/develop`
- Context: M4 runs on the user's personal Cloudflare account (D414), which has a card on file (Zero Trust, R2); the
  user: "never exceed the free plan limits (this is my personal account)".
- Decision: every service sandbox-dev uses on personal accounts (Cloudflare, SendGrid, Neon) stays within its free
  tier. No plan upgrade, paid or metered product or add-on, public bucket, `r2.dev` or extra bucket without asking the
  user first; R2 holds test files only; Billing ($0.00), R2 usage and Zero Trust seats are checked after setup and
  monthly, and anything above half a free limit is stopped and reported.
- Why: the user pays personally for anything past the free tiers; only R2 and Zero Trust can bill, the rest fails.
- Rejected: a low-limit virtual card alone (it stops payment, not usage: the account would still owe the charge).

## C16 after the pilot (branch `fix/hyperdrive-account-id-hint`), 2026-11-06

### D418. Batch C's C16 (CLI completion and cleanup) waits until after the pilot
- Date 2026-11-06 · Status: **decided by the user** (in conversation, 2026-11-05; recorded 2026-11-06 when the
  readiness refresh found no entry) · Built: nothing · Number note: D418 was taken with D417 the highest on
  `origin/develop`
- Decision: C16 (`scope:register --owners-from-org`, `owner:relay`, the `app:*` retirement plan; docs/batch-c-build-plan.md)
  is built after the pilot; C17 (the sandbox-dev smoke) goes ahead without it, using the current CLI.
- Why: the pilot's partners are onboarded through the consoles (M4); the CLI keeps working as it is, and its cleanup
  is easier to scope once the pilot shows which commands staff still use.

## The env label on alerts and emails (branch `feat/env-alert-label`), 2026-11-06

### D419. Every alert title and Hana email subject from a non-production env starts with the env's label
- Date 2026-11-06 · Status: **asked for by the user, 2026-11-06** ("make sure those alerts include a [SANDBOX] or
  [STAGING] in the title so I don't get spooked thinking it's production"); the choices below decided while
  building, to confirm · Built: `@hana-id/env` `envAlertLabel` / `ENV_ALERT_LABELS`; the watchdog's channels
  (`apps/watchdog/src/channels.ts`, `alertLabel` in `env.ts`, `alertLabelFor` in `names.ts`) and the admin Worker's
  `render` (`apps/admin/src/email/render.ts`, `mailLabel` in `env.ts`); both `gen` scripts write `ENV_LABEL` · Number
  note: D419 was taken with D418 the highest on `origin/develop`; a branch in flight (D411's build) may take D419
  too: renumber on merge
- Decision:
  - **The label:** `[SANDBOX]` for `sandbox*`, `[STAGING]` for `staging*`, `[LOCAL]` for `local*`, `[TESTNET]` for any
    other env on testnet; none on any other network, whatever the env's name, so a production manifest can't carry
    one (and a mislabelled test env can't drop it while on testnet).
  - **Where:** first in every title, before the severity, so a phone's lock screen shows it: the watchdog's email
    subject and body's first line, the paging app's title (ntfy, Pushover, PagerDuty), Slack's text and the daily
    digest's subject; the admin Worker's every email subject and first body line.
  - **Partner mail too:** invitations, guarded-change and owner-grant notices and statements carry it as well, not
    only staff mail: on a sandbox or staging env they are test mail, and a partner on staging must know that.
  - **Not the email issuer:** users' login-code emails are unchanged; their sender already reads "Hana ID (testnet)"
    (`emailIssuer.from`), and the code email's wording is part of the login flow's tested text.
  - **How it flows:** `gen` writes `ENV_LABEL` from the manifest; the Workers use it only with `NEAR_NETWORK` `testnet`
    (the watchdog derives it from `ENV_NAME` when an older config has none; the admin, which has had `NEAR_NETWORK`
    since C14, sends unlabelled mail until `gen` and a redeploy).
- Why: alerts from sandbox look exactly like production's, and the user was paged by sandbox alerts on 2026-11-06.
- Rejected: a label from a free-text manifest field (a production manifest could carry one by mistake); only staff
  mail labelled (a staging partner would read test notices as real).

### D420. The admin console never offers an action that can't work; errors in plain words; confirmations in the page
- Date 2026-11-06 · Status: **asked for by the user** ("the admin console UI/UX don't look very good … straightforward /
  no nonsense / least confusing and most user friendly", after an invite into `org_legacy` answered `forbidden:
  org_legacy has no members`); the design choices decided while building, to confirm with the screenshots · Built on
  `feat/admin-ux-redesign` (`apps/admin/public/`, tests `apps/admin/test-spa/ux.test.ts`) · Number note: first
  written as D419; renumbered D420 at the merge of `origin/develop`, which took D419 (`feat/env-alert-label`)
- Decision: the staff SPA follows the rules in `apps/admin/README.md` "UI principles": (1) an action the API would
  refuse isn't offered: Legacy apps (`org_legacy`) shows no members, invites, owner grants, freeze or app form, says
  why in one line and offers "Invite a new partner" and, per scope, "Move to an organisation" (the same `POST
  /api/scopes/:scope/assign {orgId}`; it works when each Google-account (`Owner::Oidc`) owner of the scope on chain is
  an owner of the target organisation, a scope owned only by a NEAR account moving freely; else `scope_conflict`,
  said in those words); an organisation without a security contact gets no "Create an app"; a statement with
  blockers can't be issued; (2) every API error is mapped from its code to a title and what to do next,
  the server's own message under it and the code small for support; (3) a destructive or guarded action is confirmed
  in the page (a strip with what will happen, the action's own label and Cancel, Escape cancels), never a browser
  dialog; (4) the nav is grouped by task (Partners, Support, Security, Money, System), each page has one header with
  at most one primary action, and internal ids are shown small under names, never as the headline.
- Unchanged: every route, request body, CSRF header and the Access flow; what is audited; the Users detail at
  `/users/open` from memory and the Support ID lookup out of the URL and storage; nothing new in `localStorage`; the
  CSP and the text-only DOM (source checks in `scripts/test/gen-wrangler.test.ts`).
- Why: two staff run onboarding and support from this console; a raw `forbidden: …` or a browser dialog without
  context costs them a guess, and the old org page offered an invite form on an org that has no members.
- Alternatives: (a) keep the forms and improve the error text only: staff still try what can't work. Not done. (b) A
  client-side copy of the API's rules for every action: duplicated rules drift. Only the refusals the screen can know
  from data it already has (org_legacy, no security contact, statement blockers) are mirrored; everything else is
  left to the server and its error mapped.

## The partner console's redesign (branch `feat/console-ux-redesign`), 2026-11-06

### D421. The partner console SPA: a sidebar, an app's settings as sections, plain-language errors, no control that can't work
- Date 2026-11-06 · Status: asked for by the user ("the best possible UI/UX … straightforward, least confusing"),
  design choices decided while building, **to confirm** (screenshots for review) · Built on `feat/console-ux-redesign`
  (`apps/console/web/src`, `apps/console/preview`, `apps/console/README.md`) · Number note: D421 (taken as D420 on its branch; renumbered at merge, the admin redesign holding D420) was taken with D419
  the highest on `origin/develop`; the admin console's redesign runs in parallel and may take the same number, so the
  later merge renumbers
- Decision: (1) A sidebar frame (the org, a switcher with several, Apps, Members, Users, Usage, Statements, Pending
  upgrades, Audit, sign out), the information architecture of Privy's and Dynamic's dashboards in Hana's words. (2) An
  app's page is a header (name, Live/Test, status, the copyable App ID and newest publishable key) over sections as
  nested routes (`/orgs/:org/apps/:app` stays the overview; `/origins`, `/keys`, `/sessions`, `/signing`, `/branding`,
  `/suspend`); the overview has the changes waiting, a getting-started checklist (the partner guide's steps, ticking
  what the console sees) and a settings summary. (3) Every API error in plain words for its code with what to do
  (`web/src/messages.ts`), the server's detail when it adds something, the code and HTTP status small. (4) Where the
  console would refuse (a viewer, a frozen org, 5 active keys, the last owner, a disabled member, 10 open invites,
  session values out of range, a logo of the wrong type or size, a pending policy, raw signing on a test app), one line
  says why instead of the control. (5) Guarded changes show requested → announced → in effect with times and Cancel on
  the section they belong to; the fresh sign-in page says when the change takes effect, which Google account to
  choose, the 5 minutes, and goes back to the section it came from (one org). (6) In-page confirms say what the action
  does (Escape backs out). (7) Fragment tokens are read once even under React's development double effect (the
  invite and cancel pages lost the token in `vite` dev). (8) A dev-only preview (`apps/console/preview`: `vite serve`,
  127.0.0.1, fake answers per scenario, never built) for design review.
- Unchanged: every route and request body, CSRF, cookies and sessions, the step-up flows, the CSP and headers, the
  dependencies (no new package, font or CDN); nothing in browser storage (the source check stays: no UI prefs either).
- Why: the old SPA was one long page per app with raw codes as errors (`version_conflict`), controls that vanished or
  failed without a reason, and no first steps for a new org.
- Not done, recommended: the guide has no hosted URL, so the checklist names sections instead of linking; the
  statement notes carry decision numbers (console-core's `statementView`, the same text the PDF prints).

## Google key rollout hysteresis (branch `fix/google-key-hysteresis`), 2026-11-06

### D422. A Google key is added on any sighting and removed only after a day of absence: the rollout hysteresis
- Date 2026-11-06 · Status: **proposed by the assistant, approved by the user 2026-11-06** · Built: `apps/api/src/
  issuer-keys.ts` (`JWKS_FETCHES_PER_RUN`, `REMOVE_AFTER_MISSING_MS`, `KEEP_AFTER_LAST_TOKEN_MS`, `recentTokenKids`),
  `apps/api/src/key-observations.ts` (`last_token_ms`, `TOKEN_SIGHTING_EVERY_MS`), API migration
  `0012_issuer_key_last_token.sql`; `apps/watchdog/src/run.ts` (`retiredAddDue`, `removalConfirmable`, their constants,
  `STALE_ACTIVE_KID_MS` 27 h), watchdog migration `0002_absence_fetches.sql`; the playbooks `retired-key-change`,
  `key-sync-stalled`, `updater-key-stolen`; docs/mainnet-readiness.md row 7.16 · Amends D153 (when an updater Add of
  a kid Google listed within 24 h is "retired"), the JWKS cron's removal grace (55 min, `docs/governance-spec.md`
  "Rotation and logins" step 4) and the watchdog's early confirmation of a Remove (two fetches 60 s apart) · Number
  note: first written as D420, renumbered D422 at merge (the admin and partner console redesigns took D420 and
  D421 first); API migration 0012 is this branch's, so the unmerged D411 branch (`feat/email-sharing`, its own 0012)
  renumbers on merge
- Context: sandbox-dev, 2026-11-03..05: Google's JWKS listed the new kid `9e7b714e…` on some fetches and not others for
  about two days (its frontends answer from different caches, each up to ~6 h old). The API cron added a kid on first
  sighting and proposed its removal after 55 min of misses (about 4 fetches); the watchdog treated two misses 60 s
  apart as "not published": it cancelled the cron's Adds as retired (D153) and confirmed its Removes, even 6 min after
  flagging that Google still published the key (#34). The kid was added and removed 4 times and 7 more Adds were
  cancelled; ~20 alerts. No login was affected (no token had used the kid yet). On mainnet the same loop would leave
  a key Google already signs with off chain for the 60-min re-propose hold + 15 min + the issuer-key delay
  (≥ 18 min, provisionally 2 h): 1.5–3.5 h of failed Google logins signed with it.
- Decision (seeing a kid is strong evidence, one miss is weak; a key left on chain a day longer is harmless, one
  removed early breaks logins):
  - **API cron:** 3 JWKS fetches a run; a kid any of them lists is published (Adds as before, on first sighting); a
    kid is missing only on a run whose 3 fetches all succeeded and none listed it; a removal is proposed after 24 h
    missing from every such run (a run that lists it restarts the 24 h; an incomplete run neither starts, resets nor
    completes it) and never, nor executed, for a kid that signed a verified token in the last 24 h (`last_token_ms`,
    written at most every 10 min per isolate); a matured Remove is executed only by a complete run.
  - **Watchdog:** an updater Add of a kid it saw with the same material within 24 h (D153's window) is cancelled as
    retired only when the kid was first seen over 7 days ago, last listed over 6 h ago, and missed by at least 3
    fetches in a row over at least 30 min; otherwise it stays pending (a rollout: confirmed once a fetch lists it, or
    executed by the API cron if its own fetches list it). A Remove is confirmed early only after at least 3 fetches in a
    row over at least 10 min missed the kid and none of its fetches listed it for 24 h; else it waits out the delay. A
    removal of a kid the current fetch lists stays a critical `published_key_removal` (alert only). `stale_active_key`
    warns after 27 h (the cron's 24 h + 3 h), not 3 h. Everything forged stays forged (D82, D153): a kid never seen,
    other key material, a kid last seen over 24 h ago, owner proposals.
  - Thresholds are named constants, the same on every env (no override).
- Why: during a rollout absence is noise and presence is signal; the contract still checks the key material, so a
  kid kept longer costs nothing, and Google stops signing with a key before it stops publishing it.
- Trade-offs: a key Google truly retired stays on chain up to ~1 day longer (plus the delay). A brand-new kid the API
  sees before the watchdog ever does is still judged forged by the watchdog if two of its fetches 60 s apart miss it
  (cancel + updater keys deleted, D82): unchanged here, a follow-up (readiness row 7.16).
- Rejected: only lengthening the 55 min (the watchdog's two-fetch rule would still undo Adds); caching Google's JWKS
  on our side (hides rotations); letting env manifests tune the thresholds (mainnet must not go below them).

### D423. `pnpm verify` runs independent steps side by side, and the sandbox e2e 8 tests at a time
- Date 2026-11-06 · Status: **asked for by the user 2026-11-06** ("`--full` ≈ 7 min without any flakiness, the
  default tier no slower") · Built: `scripts/verify.mjs` (lanes in a phase, `schedule`, `SANDBOX_TEST_THREADS`, the
  summary's start column, wall-clock total and steps added up), `scripts/test/verify.test.ts`; the CI `e2e` job's
  `--test-threads=8`; `contracts/integration-tests/tests/e2e.rs` (`access_keys_are_limited` split into the eight
  `access_keys_*` tests, `sandbox_starts_set_no_env_vars`), `contracts/integration-tests/.cargo/config.toml`;
  docs/operations.md "CI and git" · Amends D413 (phases one step at a time except gitleaks beside the typecheck and
  the docs checks beside the unit tests) and the sandbox job's `--test-threads=1` (no record said why) · Number note:
  D423 was the next free number on `origin/develop` (D422 the highest); the unmerged `feat/email-sharing` holds
  D420–D425 locally and renumbers at its merge
- Context: `--full` took 21–22 min on the dev Mac, ~18.5 of them the sandbox e2e run one test at a time with the CPU
  mostly idle (sandbox startup and block waits). Measured on this branch's base: the suite one at a time 1096 s
  (e2e 674 s, email 126 s, governance 295 s), and one test, `access_keys_are_limited`, ~530 s of it: ~250
  transactions, most of them rejected by an access key, which near-workspaces retries 4 times each (~2.4 s per
  rejection).
- Decision:
  - **Lanes.** A phase's lanes run side by side, a lane's steps one after another; phases still run in order:
    (0) lockfile; (1) gitleaks | typecheck | contract; (2) unit tests | docs checks; (3) sandbox e2e | pack check →
    Playwright. The contract moved beside the typecheck (from cold it builds on every core for minutes: never
    beside the unit tests, D140); the unit tests' phase holds only the docs checks, in every tier (a test checks it).
    The pack check and Playwright share a lane (pack's `build:lib` rewrites `packages/web/src/envs.generated.ts` and
    the SDK's `dist/` while the stack's build bundles `@hana-id/web`). The sandbox nodes take ephemeral ports from
    the OS with near-sandbox's lock files; the Playwright stack keeps its fixed `HANA_E2E_PORT_BASE` … +50.
  - **Failure.** The first failure stops the running steps ("stopped"), nothing else starts ("not run"), its log's
    tail is printed. The table adds each step's start offset, the wall-clock total and the steps added up.
  - **Sandbox e2e at `--test-threads=8`**, in verify and CI. Every test already had its own sandbox (own ports,
    temp home dir and accounts); the wasm builds are per-binary `OnceLock`s into separate target dirs; the
    near-sandbox binary is installed by its build script (lock file and atomic rename), so nothing downloads during
    the run. One shared-state hazard was fixed: near-workspaces and near-sandbox `set_var("NEAR_SANDBOX_LOG")` at
    each sandbox start, a `setenv` while other test threads may read the environment from C (undefined behaviour
    on glibc); `contracts/integration-tests/.cargo/config.toml` sets `NEAR_ENABLE_SANDBOX_LOG` (and the same log
    filter) so they don't, and `sandbox_starts_set_no_env_vars` fails if it isn't set. The binaries still run one
    after another (one `cargo test`, as in CI).
  - **`access_keys_are_limited` split** into eight tests, one per key and check, each on its own sandbox, with
    every assertion kept (the updater key's calls now spend its 1 NEAR allowance in two tests rather than one: no
    test asserted the cumulative spend). The longest sandbox test is now ~140 s.
- Measured (dev Mac, 16 cores, idle, warm caches): the suite at 4 threads 443 s, at 8 threads 299 s, then five runs
  in a row at 8 with no failure: 310, 303, 300, 303, 306 s (e2e 131–142 s, email 32–35 s, governance 133–136 s;
  8 nodes, ~3.2 GB, 1-min load ≤ 8.6). Both long binaries are now bound by their longest test, so more threads
  barely help. `pnpm verify --full` twice on the branch: 6m18s and 5m53s (from 21–22 min), the sandbox e2e 5m05s and
  4m59s beside Playwright's 1m43s.
- Trade-offs: 8 nodes need ~3.3 GB and load a small machine; CI's 4-vCPU runner is untested at 8 (CI is off,
  D387): on its first run there, watch for sandbox start or RPC timeouts and lower the number rather than retry.
  Playwright now runs beside 8 sandbox nodes.
- Rejected: retries (they hide flakes); running the three test binaries at once (another ~2.5 min off, but three
  processes would build the same wasm into the same target dirs and race on `target/near/*.wasm`, `target/v2-src`
  and the Sputnik download: it needs a cross-process lock in the harness first); unit tests beside anything heavy
  (D140); faster sandbox blocks (changes the timing the delay tests rely on).
- Amended 2026-11-06: Playwright moved to a phase of its own after the sandbox e2e. Beside the 8 sandbox nodes,
  Firefox's `linking.spec.ts:234` (case B, link pending) timed out at 13.2 s in a `--full` run (it passes in 4–5 s alone,
  3/3); the risk was named above. `--full` gains about 1.7 min (Playwright no longer overlaps the sandbox suite).
## Session expiry in both consoles (branch `fix/session-expiry-ux`), 2026-11-06

### D424. A console session that ends is said as such: the request waits, nothing typed is lost, Try again sends it
- Date 2026-11-06 · Status: **asked for by the user 2026-11-06** ("sessions can expire quietly, this UX is
  terrible", after "Send invite" on sandbox-dev's admin answered "Can't reach the admin console … Error code network":
  the 1 h Access session (D409) had ended and the fetch's redirect to `<team>.cloudflareaccess.com` was blocked by
  CORS); the design choices decided while building, to confirm with the screenshots · Built: `apps/admin/public/`
  (`send`/`api`, `session`, `renderSession`, `/signed-in`), `apps/admin/src/access.ts` (`exp` on the staff check),
  `routes.ts` (`GET /api/me` `accessExp`), `test-spa/session.test.ts`, `test-spa/preview.ts`
  (`PREVIEW_SESSION_MIN`); `apps/console/web/src/api.ts` (`request`, `session`, `sessionStore`),
  `web/src/session.tsx` (`SessionBanner`), `pages/Action.tsx`, `apps/console/src/sessions.ts` and `bff.ts`
  (`GET /api/me` `sessionExpiresAt`), console-core `meAnswer`, `web/test/session.test.tsx`, the preview's
  `session-ending` and `session-ended` · Extends D420 and D421 (their UI principles) · Number note: D424 was the next
  free number on `origin/develop` (D423 the highest); `feat/email-sharing` holds D420–D425 locally and renumbers at
  its merge
- Decision:
  1. **Detected, not guessed.** Admin: every `/api/*` fetch is sent with `redirect: 'manual'`; an `opaqueredirect`
     (status 0), any 3xx, or the Worker's 401 `unauthenticated` is an expired sign-in, distinct from a rejected fetch
     (`network`, wording unchanged). 403 `not_staff` and `csrf` stay errors (another account, another problem).
     Partner console (its own cookie, no redirect): a 401 after this tab has had a session is a session that ended
     (2 h idle, 12 h absolute, revoked); a 401 before that (a fresh visit) still goes to `/signin`.
  2. **The request waits; nothing is lost or claimed.** It isn't failed: its page, the typed values and the busy
     button stay, and a banner at the top (`role=alert`): "Your sign-in has expired" / "Your session has ended",
     **Sign in again** (a link to a new tab: the admin's `/signed-in`, which Access signs in to reach and which says
     to go back; the console's `/signin`; the cookie is the tab's too) and **Try again** (every waiting request sent
     again with the same method, path, headers and body bytes; if still signed out, the banner says so). Back on the
     tab (focus, visibility) after signing in elsewhere, the sign-in is checked and the banner becomes "You're signed
     in again" until Try again sends what waited: nothing is sent without the click. A success re-renders as usual;
     the banner goes. Moving to another page drops what waited there (never sent later); a reload loses it, as before.
  3. **Warned before.** The admin's `GET /api/me` answers the verified Access token's `exp` (`accessExp`, seconds);
     the console's answers the session's absolute end (`sessionExpiresAt`, ms). 5 minutes before, an amber banner
     (`role=status`): "ends in N min" with Renew / Sign in again (the same new tab; back on the tab the end is read
     again). At the end the server is asked once (the reader's clock may be off), so the ended banner shows before
     the next click. The console's 2 h idle end isn't warned of: each request moves it, and a check to find it would
     itself be activity. The fresh sign-in page says when the session ends inside the confirmation's 5 minutes
     (a confirmation counts only with the session that started it: `session_ended`).
  4. **Memory only.** Waiting requests (an invite's email among them) live in the tab's JavaScript; nothing goes to
     `localStorage`, `sessionStorage`, IndexedDB or a cookie (source checks in both apps). No token is answered: only
     the end time.
- Found, not changed: Cloudflare Access mints a new application token only once the old session has ended (an
  unexpired `CF_Authorization` cookie is simply accepted), so the admin's Renew before `exp` usually changes nothing;
  the banner then says so ("Access kept your current sign-in: it still ends at …") and the expired path keeps the
  work. Untested on Cloudflare (no deploy on this branch): whether opening the team's login URL
  (`https://<team>/cdn-cgi/access/login/<host>?kid=<aud>&redirect_url=/`) in the new tab would mint a fresh token
  while the global session lasts; worth a try on sandbox-dev before changing Renew to it.
- Why: a silent expiry read as a network failure sent staff to check their connection, then reload and lose the form.
- Rejected: following the redirect in a hidden iframe or popup to re-sign in silently (Access's login page refuses
  framing, and `frame-ancestors 'none'` is ours too); retrying on its own once the sign-in is back (a write must be
  the user's click); keeping a form draft in `sessionStorage` across a reload (it holds emails: the no-storage rule);
  sending the whole window to sign-in (loses what was typed).
- Amended 2026-11-06 (tested by the user on sandbox-dev): opening the team's login URL for the application while the
  token is still valid **does** mint a fresh one (the banner's end moved). Renew now opens `GET /api/me` `renewUrl`
  (`https://<team>/cdn-cgi/access/login/<host>?kid=<aud>&redirect_url=%2Fsigned-in`, built by the Worker from the
  team domain and AUD, public values); "Sign in again" after the end keeps `/signed-in` (Access asks there). The SPA
  accepts only an `https://<x>.cloudflareaccess.com/cdn-cgi/access/login/` URL and falls back to `/signed-in`.

### D425. The admin console opens on a System status page: one verdict, the issues with what they affect, a tile per component
- Date 2026-11-06 · Status: **asked for by the user 2026-11-06** ("add some pages so there's a 'birds eye view' of the
  whole system, basically I can look at the page and feel confident that 'all systems operational' and 'no issues'.
  The page should also give warnings if issues found … an overview dashboard of our whole system and to check if all
  parts of system is up or down"); the checks, thresholds and wording decided while building, to confirm with the
  screenshots · Built: `apps/admin/src/status.ts`, `status-probes.ts`, `routes.ts` (`GET /api/status`),
  `ledger-cron.ts` (`ledger_cron.last_run`), `scripts/gen-wrangler.ts` (the new vars, `accountCrons`), `public/`
  (`statusPage`, the Overview nav), `test/status.test.ts`, `test-spa/status.test.ts`, `test-spa/preview-status.ts`;
  `apps/api/src/system-status.ts` (`AdminRpc.systemStatus`); `apps/console/src/staff-rpc.ts` (`StaffRpc.health`),
  `cron.ts`, migration 0003 (`cron_runs`); `apps/email-issuer/src/directory-rpc.ts` (`DirectoryRpc.health`);
  `apps/watchdog/src/status.ts` (`build`); console-core `health.ts` · Extends D420 (its UI principles), D380 (the call
  budget), D406 (the build ids), D417 (free tiers) · Number note: D425 was the next free number on `origin/develop`
  (D424 the highest); renumber at the merge if another branch took it
- Decision:
  1. **The landing page.** `/` (nav **Overview → Status**, first) is the System status page; Organisations moved to
     `/orgs` only. A verdict banner, "All systems operational" (green) only when every check answered and passed, else
     "N issues" (amber, or red with a critical one), when it was checked and how many checks passed; the issues,
     critical first, each with what it affects in plain words, since when (the source's own time when it has one,
     else "first seen" by the isolate), the component, what to do, and the screen or playbook; then one tile per
     component in seven groups, and what isn't measured yet with how to check it meanwhile.
  2. **Unknown is never green.** Five tile states: OK, Warning, Critical, Unknown (grey, dashed) and Not measured
     (outlined). A check that should have answered and didn't is Unknown and always behind an issue: its own, or the
     single failure that hid it (a watchdog that can't be read is one critical issue, not six), so the verdict can't
     be green while anything is unknown. Not measured (nothing can see it yet, or the piece isn't in this env) is not
     an issue.
  3. **Reuse, don't re-derive.** The contract tile is Security & monitoring's own `findingsOf` (governance part, same
     severities); the watchdog's checks, alerts, heartbeat, channels and relayer reading come from its `/status`; the
     build comparison is `deploy-check`'s, from the same public endpoints. Three new read-only methods answer each
     Worker's own state in one call: `AdminRpc.systemStatus` (build, hot-D1 probe, the Google-key sync's runs, the
     notice backlog, the pool keys, the governance snapshot), `StaffRpc.health` (build, D1 probe, hourly cron run, the
     member-notice backlog, LOGOS) and `DirectoryRpc.health` (build, D1 probe), each authenticated as its entrypoint's
     other methods and answering no user data. The watchdog's `/status` gains `build`.
  4. **What runs record their last run.** The console's hourly cron writes `cron_runs` (migration 0003) and the admin's
     15-minute cron `ops.state` `ledger_cron.last_run` (a query on its open connection: no call of D380's 40); the API's
     15-minute run was already recorded (`issuer_key_sync_runs`). A cron is amber after 2 intervals + 5 min and red
     after 6; the watchdog keeps its own silence rule (2 intervals, red).
  5. **Within the Free plan.** A cold read makes 19 outbound calls (20 with the Access certs fetch of a cold isolate)
     and 3 Worker invocations, every source in parallel with a 5 s deadline; the answer is kept 30 s in the isolate and
     concurrent misses share one read, so refreshes cost nothing. No cron does more work. Free-tier usage that needs
     Cloudflare's GraphQL or SendGrid's stats is shown as Not measured (no new token without the user, D417), listed in
     `docs/mainnet-readiness.md` 5.12; the account's cron triggers are counted from the manifest by `gen` (5 of 5 on
     sandbox-dev is green, "full").
- Thresholds chosen (to confirm): a Worker slower than 2 s amber, no answer in 5 s red; a D1 query over 1 s amber;
  NEAR's final block 2–10 min old amber, over 10 min red (the fallback only ever amber); blocking notices waiting over
  15 min amber, over 1 h red; the relayer at the watchdog's own warn and critical lines, a reading older than 30 min
  amber; settlement's oldest event over 2 h amber; a cron run using 38 or more of its 40 calls amber.
- Why: until now "is everything fine?" meant opening Security & monitoring, Feed and notices, the Cloudflare dashboard
  and `deploy-check` in turn; a stale bundle (2026-11-05) or a silent cron was found only by its symptoms.
- Rejected: probing from the admin's cron and showing the last result (its 40-call budget, D380, and staler answers);
  an API token for Cloudflare's GraphQL now (a new secret on the personal account: the user's call, D417); counting
  Not measured as an issue (the page would never be green); the watchdog doing the probes (it's on its own account to
  stay independent, D86, and alerts, where this page only shows); auto-refresh (a page that redraws while read; Check
  again reads on demand).

## Hana's brand on Hana ID's own pages (branch `feat/hana-brand`), 2026-11-06

### D426. Hana ID's pages wear Hana's brand: one token set, Hana's own OFL Montserrat self-hosted, the mark inline
- Date 2026-11-06 · Status: **asked for by the user 2026-11-06** ("style both admin and partner portal to use Hana
  fonts, styling and color schemes … look at hanawallet.io website as well as hana-app and hana-extension repos for
  inspiration"; extended the same day to the approval popups and everything user-facing); the palette, type and
  shapes chosen while building, to confirm with the before/after gallery · Built: `packages/brand` (new),
  `apps/admin/public` (`app.css`, `index.html`, `fonts/`), `apps/admin/scripts/sync-brand.ts`, `apps/console/web`
  (`styles.css`, `ui.tsx`), `apps/console/vite.config.ts`, `packages/web/src/auth` (the sign-in, approval and export
  pages), `packages/web/src/vault/launcher.ts`, `packages/web/scripts/build-auth-pages.ts` · Extends D420 and D421 (their
  information architecture, copy and tests unchanged) · Number note: D426 was the next free number on `origin/develop`
  (D425 the highest); `feat/email-sharing` holds unmerged numbers: renumber at the merge if another branch took it
- Decision:
  1. **One token set.** `packages/brand/tokens.css`: CSS variables only (`--hana-*`), light by default and dark with
     `prefers-color-scheme` (no toggle, nothing stored), taken from hana-app's and hana-extension's `designTokens.ts`
     and hanawallet.io's stylesheet: Hana ink `#16073a` on a lilac-white `#faf9fe`, Hana indigo `#3308a8` as the one
     accent (light purple `#bba8f6` in dark), the gradient `#6256e9 → #d772d3` as decoration only, never behind text.
     State colours (ok, warn, danger) are deliberately not purples. Every text and focus pair is checked for WCAG AA
     in both themes (`packages/brand/test`), and the state hues are checked to stay out of the purple range.
  2. **Fonts: Hana's own Montserrat, self-hosted.** Montserrat v8.000 (400, 500, 600, 700) and Montserrat Alternates
     v7.200 (700), the files Hana's extension ships, under the SIL Open Font License 1.1 (no Reserved Font Name),
     subset to Latin WOFF2 (16.8–17.4 KB each) with `fonts/OFL.txt` beside them; a test reads each file's own name
     table for the licence. Each page loads them from its own origin (`font-src 'self'`, unchanged everywhere): the
     admin from `public/fonts` (copied by `sync-brand`, the SPA has no build), the console and the auth pages from
     their bundles' `/assets`. The consoles use `font-display: swap`; the security popups `optional`, so a late font
     never moves a button under the pointer. Hana's apps also use Proxima Nova and PP Agrandir: commercial licences
     that don't cover web embedding by Hana ID, so they are not shipped (Montserrat is what hanawallet.io uses anyway).
  3. **The mark inline, not an image.** The Hana mark (hana-extension `hana.svg`) is drawn as inline SVG from
     `MARK_PATHS` with its colours from the page's CSS: no image request, nothing new in any `img-src`.
  4. **Who is asking stays clear.** Every auth page (sign-in chooser, email step, callback, approval and consent,
     export) gets a static Hana bar above the page: the mark and wordmark as inline SVG, with no text, no URL and
     nothing that runs. The app's logo, name and origin stay inside the page in a neutral box (`.asker`, the approval's
     `header.app`), so Hana's chrome never names the app and a partner can't look like Hana. The auth pages load only
     Montserrat 400 and 600 and Montserrat Alternates 700 (49.9 KiB, once per origin, cached across the five pages)
     from `/assets/files/` with `OFL.txt` beside them. The approve guard, every message flow, COOP and popup behaviour
     (D347, D398, D400), the meta and header CSPs and all security copy are unchanged. The vault (D38) loads no font:
     its launcher takes Hana's ink and gradient on the system font (`vault.js` +~90 B). The hosted demo's CSP gains
     `font-src 'self'` (its only CSP change) and its fonts are served immutable; the issuer's code email uses Hana ink
     and indigo inline with a Montserrat/Arial stack.
  5. **Each console keeps a cue of its own.** The staff admin's nav is Hana ink in both themes (the partner console's
     is light), with the env badge solid amber on it, so staff never mistake one console or env for another.
- Why: Hana ID is Hana's product; its pages looked like a generic tool (system fonts, petrol blue, an invented flower
  mark) rather than Hana's wallet and site.
- Rejected: Proxima Nova or PP Agrandir (licences); a font CDN (CSP and privacy: every page loads only its own origin);
  a build step for the admin SPA (D420: no build; a copy with a drift test instead); a theme toggle (it would need
  storage, which the SPAs don't use); the gradient as a page or button background (contrast, and it competes with
  state colours); fonts in the vault (one more request and file in the isolated origin for a 16 px label); `swap` on
  the auth pages (a late swap moves Approve and Reject while the user reads them).
- Test note: the callback page's fonts count toward its `load`, and it closes itself before `load` on a Google
  `#error`, so `apps/e2e/tests/login.spec.ts`'s one `goto` there waits for `commit` (no assertion changed).

## Partner integration friction fixes (branch `feat/partner-friction-fixes`), 2026-11-06

### D427. Partner-integration friction fixes: a verifier that refuses to start, a fast `no_answer` naming the origin, the portal in the guide
- Date 2026-11-06 · Status: approved by the user 2026-11-06 (friction fixes) · Source: a "new partner" dry run that
  built a sample partner app from the partner guide, the four SDK READMEs and the public sandbox-dev endpoints
  (its friction log, items 1–6, 8–12 and 14; items 7, 15 and 16 deferred by the user) · Built:
  `examples/identity-verify/src/verify.ts` (and the guide's copy), `packages/web/src/client/vault-connection.ts`,
  `packages/react/src/hooks.ts`, `packages/core/src/support-id.ts` (subpath `@hana-id/core/support-id`),
  `packages/console-core/src/users.ts`, `packages/sodax/src/evm.ts`, `packages/core/src/verified-contracts.ts` (the
  cited `@sodax/types` version), `docs/integration.md`, the four SDK READMEs, `packages/core/test/integration-doc.test.ts`
  · Amends D262 (the answer deadline of a loaded frame) · Number note: D427 was the next free number on
  `origin/develop` (D426 the highest); renumber at the merge if another branch took it
- Decision:
  1. **The guide's verifier refuses to start without its settings.** `HANA_APP_ID`, `HANA_IDENTITY_ISSUER` and
     `HANA_IDENTITY_PINS` are read once at load; an unset or blank one throws with its name, as do an app id that
     isn't `app_…` (a publishable key pasted by mistake), a non-`https` issuer (loopback excepted, for local tests)
     and pins that aren't 43-character thumbprints. Why: with `audience: undefined`, jose skips the audience check
     and a valid Hana token minted for any other app verifies (confirmed by the dry run with jose 6.2.13), while the
     comment next to it said the check was mandatory. Pinning is required the same way: `jwks-only` is the explicit
     opt-out, so a forgotten variable can't silently drop it either (the old code read unset as "no pins"). The guide
     lists sandbox-dev's issuer and its two thumbprints (the active key and the standby: the watchdog's
     `pinnedIdentityKeys`), and a test keeps them equal to the manifest; rule 1 adds "refuse to start when the app id
     or issuer is missing".
  2. **`no_answer` is fast and names the origin.** The vault answers the hello with `connected` in the same task it
     arrives in, and the frame's `load` waits for the vault's script, so a loaded frame silent for 1.5 s
     (`POST_LOAD_ANSWER_MS`) was refused (frame-ancestors, the vault's own origin check, or an error page). The SDK now
     gives a loaded frame 1.5 s after its `load`, instead of the rest of 5 s from its insertion; the one retry stays
     (a transient 503 page). A wrong origin fails in about 3 s instead of about 10 s, and `no_answer`'s message and
     `data.origin` name the page's `location.origin`, with "scheme, host and port must match" and the dev-server port
     case. A frame still loading keeps 5 s plus 5 s, and `ready` 20 s after `connected`, as D262 set them.
  3. **No distinct `origin_not_allowed` reason.** The SDK can't tell an origin refusal from an unknown or suspended
     key: the browser's frame-ancestors block happens in the vault frame's context (no event in the page), and D262
     rejected the vault saying why it refused (it would tell any framing page whether a key or an origin is valid).
     The origin the SDK names is the page's own, which the page already knows, so nothing new is disclosed. No new
     code crosses the port, so D393's `sdkAtLeast` gating doesn't apply.
  4. **The partner portal in the guide.** Section 1 becomes "Your app and the partner portal": what Hana still does
     during the pilot (creates the org and apps, sets the security contacts, turns email login on), where the
     publishable key, the app id and the identity issuer with its pins come from, signing in by invite, the app page's
     tabs, allowed origins as guarded changes (announced to the security contacts, then 60 s on sandbox-dev or 24 h;
     loopback on a test app and any origin before a first login at once once announced; cancel from the page or the
     email; removal immediate), members, reports and a frozen org. "Send Hana" and "the dashboard in batch C" are gone
     from sections 6, 7 and 9 (the Signing tab, Login & sessions, the scope page's own-client steps).
  5. **Partner-facing text points at nothing a partner can't open.** No repo paths, decision numbers, batch or
     build-plan names or admin CLI commands in `docs/integration.md` or the four SDK READMEs; a test bans them. The
     guide's "Last verified" header is one short line (its history is in git and here).
  6. **Smaller fixes.** `useHana().login(options)` passes `hana.login()`'s options and drops an event argument
     (`onClick={login}` still works). `supportIdFromSub` (the one implementation; console-core re-exports it as
     `supportIdOf` and moved its Crockford code to core) is exported from `@hana-id/core` and the leaf subpath
     `@hana-id/core/support-id`, with the exact format and a test vector in the guide. `@hana-id/sodax` is typed and
     tested against `@sodax/types` 2.2.0 (peer `^2.2.0`, what `@sodax/sdk` 2.2.0 pins), and honours 2.2.0's
     `expectedChainId` (another chain is `4902` `expected_chain_mismatch` before any popup); the verified-contracts
     list cites 2.2.0, whose addresses its test confirms unchanged. The guide states that `eth_signTransaction` fills
     a missing nonce, gas and fees as `eth_sendTransaction` does but neither queues nor broadcasts, that Sodax has no
     testnet (quotes and intent building work read-only; signing waits for live keys; Hana's own sandbox mainnet demo
     exception is Hana-internal only), and that "NEAR testnet" is Hana's chain, not the user's wallet chain.
  7. **No version bump.** `docs/operations.md` "Releasing the SDK packages" bumps the four packages' version at a
     release, not per change; the guide marks the new behaviour "SDK releases after 0.2.0".
- No change to any key or path derivation.
- Rejected: exporting a ready-made verifier package now (a fourth published surface to version; the guide's code is
  tested and the startup checks close the hole); a test-app-only `data.hint` from the vault for loopback parents
  (D262's reason holds for test apps too, and the SDK's message covers the case without the vault); dropping the
  frame retry (it covers a transient 503 vault page); a shorter answer deadline for frames still loading (a slow
  network is not a refusal).
## Mainnet demo and key export (branch `feat/mainnet-demo-key-export`), 2026-11-06

Spec: `docs/mainnet-demo-and-key-export-spec.md` (with its security self-review). Number note: D428–D431 were the next
free numbers on `origin/develop` (D427 the highest: D426 the Hana brand, D427 the partner friction fixes; first built as D426–D429 and renumbered when develop was merged in); renumber at the merge if another branch took them.

### D428. The mainnet demo: an exception to D39 for the Sodax demo, a per-transaction cap under $10, Base and Stellar only
- Date 2026-11-06 · Status: **decided by the user 2026-11-06** ("exception for the Sodax demo, also we should limit
  funds to <$10. warnings are good"; then "per-transaction cap only; balance above $10 warns, doesn't block"; then
  "the Sodax demo will swap between Base (8453, cheap gas) and Stellar pubnet only") · Built: `packages/core/src/
  mainnet-demo.ts`, `demo-config.ts`, `networks.ts`; `packages/web/src/vault/signing.ts`, `vault.ts`
  (`freshMainnetDemo`, `subjectOf`, `reportDemoSignature`), `client/ethereum.ts`, `auth/approve-page.ts`,
  `auth/demo-balance.ts`, `auth/pages.ts`; `apps/api/migrations/0013_mainnet_demo_events.sql`, `src/mainnet-demo.ts`,
  `src/mainnet-demo-setting.ts`, `src/handlers.ts` (`GET /v1/app` `mainnetDemo`), `src/changes/settings.ts`
  (`setMainnetDemo`), `src/pages/host.ts`; `scripts/lib/admin-settings.ts` (`--mainnet-demo`); `apps/admin`
  (the switch, the events table) · Amends D39
- Decision:
  1. **What it allows.** A `pk_test_` app whose `apps.mainnet_demo` Hana staff switched on may sign on Base (8453)
     and Stellar's public network, and no other mainnet (Sonic isn't needed: the user signs only on the spoke chain,
     Sodax's relayer runs the hub's call; `needsRelay` in `@sodax/sdk` 2.2.0). Everything else of D39 stays.
  2. **Only Hana staff, only in a dev testnet env.** `admin <env> app:settings <app> --mainnet-demo on|off` and the
     admin console's app page (`AdminRpc.setMainnetDemo`), both refused unless the manifest is a dev env (`isDevEnv`)
     on testnet and the app is a test app; a D1 trigger refuses it for a live scope. The API serves `mainnetDemo: true`
     only in such an env for a test scope; the vault honours it only when its own build is a dev testnet build. No
     partner method or control; partners don't see it (ConsoleRpc's view leaves it out), only its `app_changes` row.
  3. **A per-transaction cap, fail closed.** At most $9.99 per transaction, its maximum fee included, valued by a
     reviewed price table (D429); a request whose movements Hana can't value (an unknown call, token, operation or
     Soroban call; typed data; auth entries) is refused. No daily cap (the user: repeated swap tests are needed).
  4. **Warnings.** Every demo approval shows the red banner "Real funds, test custody: these funds may be lost", the
     value and the cap, and the wallet's balance; above $10: "This wallet holds about $N: keep test funds under $10 —
     move the rest out" (a warning, never a block); unreadable: "Balance unknown". A refusal is said to the page (4100
     with the reason) and in Hana's launcher.
  5. **Never auto-approved**, whatever policy the app has. Each signature is reported to the API (no key, signature
     or bytes) as a `mainnet_signature` event staff see.
- Why: Sodax has no testnet, and the partner demo needs real swaps; testnet MPC keys can be lost or stolen (D39's
  reason), so the exposure is bounded per transaction, said loudly, and confined to dev envs and staff.
- Rejected: a per-user daily cap kept in the vault (the user, 2026-11-06: repeated tests); allowing every mainnet;
  letting partners set it; trusting the partner's RPC for the balance.

### D429. The mainnet demo's mechanics: the price table, what can be valued, the freshness and the reads
- Date 2026-11-06 · Status: **to confirm** (implementation choices while building D428) · Built: as D428
- Decision:
  1. **Prices** (`MAINNET_DEMO`, reviewed 2026-11-06): ETH $8,000, USDC $1.05 and EURC $1.35 on Base and on Stellar, XLM $1.00, all
     deliberately above the market (a live price couldn't be confirmed; a higher price makes the cap stricter and the
     balance warning earlier). The table is valid 45 days (until 2026-12-21): after that every demo request is refused
     (`mainnet_demo_prices_stale`) until someone reviews it and rebuilds. Values are rounded up.
  2. **Identifiers**: USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base) and
     `USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN` (Stellar), EURC
     `0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42` (Base) and `EURC:GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2`
     (Stellar), from Circle's USDC and EURC contract addresses pages (the tokens the sample's Sodax swap lists); the
     Stellar asset contracts checked against `Asset.contractId(pubnet)` in a test; Sodax's asset managers,
     intents contract and hub assets from `@sodax/sdk` 2.2.0's packaged config, pinned in a test.
  3. **What is valued**: the maximum fee always; EVM plain sends, USDC `transfer`/`transferFrom`/`approve` (an
     approval valued as what it lets the spender take), and Sodax's spoke `transfer(address,bytes,uint256,bytes)` with
     its `data` either empty or exactly `[approve(intents, g ≤ amount), createIntent(inputToken = the hub asset,
     inputAmount ≤ g)]`, so the relayed hub calls can spend at most the deposit; Stellar payments and account creation
     in XLM or USDC, a USDC `changeTrust`, and Sodax's Stellar `transfer(from, token, amount, to, data)` from the signing
     account with auth entries for exactly that call and the token's own transfer (USDC and EURC as well as XLM and
     ETH). Everything else is refused.
  4. **Freshness**: the vault re-reads `GET /v1/app` when its `mainnetDemo` answer is older than 10 s (as raw
     signing); a failed re-read refuses (`mainnet_demo_unconfirmed`). The early refusal check (D112) leaves a demo
     build's mainnet request to `sign()`, so a stale "off" never refuses a request the API would allow.
  5. **On and off are immediate** (an `app_changes` row and a `settings_version` bump each), not a guarded change:
     staff only, dev envs only, test apps only.
  6. **The balance** is read by the approval popup (not the vault, which holds PRK) from Hana's pinned public
     endpoints (`https://mainnet.base.org`, `https://horizon.stellar.org`), listed in `/approve`'s CSP only in a dev
     testnet build; each read has a 4 s limit.
  7. **The partner client learns it from the vault** (the sample's FRICTION 18, 19, 21): the vault page inlines
     `mainnetDemo: true` for such an app (only then, so an older vault bundle never sees the key), and the vault
     sends the SDK a `mainnetDemo` port event with the rules (`evmChains`, the Stellar passphrase, the cap in USD
     micros, the price table's review and expiry) after the hello, before `ready`, and again when `GET /v1/app`
     changes it (`null` after "on"; never from a production build). The SDK's EVM provider opens its early D39 check
     for exactly those chains (the event's validator accepts only Base), `hana.mainnetDemo` holds the rules and
     `mainnetDemoChanged` says when they change. The vault still decides every request. Older SDKs drop the unknown
     event (no D393 version gate needed). A cap refusal is its own reason, `mainnet_demo_over_cap`, with `data.usd`
     and `data.capUsd`. The Stellar passphrase is per call (the Sodax provider's wins; the approval shows the
     network); `hana.stellar.getNetwork()` still reports `createHana`'s.
  8. **Usage events** are the vault's report, bound to the session (amended after the security review of 2026-11-06, two
     MEDIUM findings): the session key signs the event over the identity message with the session's wallet proof of
     the address; the API checks both, the session on chain and a single-use marker, and stores the session's user
     (never a bare address). Rate-limited to 120 per app per hour, labelled "reported by the vault". The staff view
     caps each kind per user on its own, so reports can't push a key export out of view.
- Why: each is the narrowest rule that lets the sample's swap (Base ETH → Stellar XLM) and its reverse work while
  failing closed on anything else.
- Open: whether the prices should come from a live source with a sanity band (more moving parts in the vault).

### D430. Key export additions: auto-hide after 60 s, the guarded click, plain warnings, a `key_exported` event
- Date 2026-11-06 · Status: the feature **decided by the user 2026-11-06** ("an option to let the user export their
  private key just in case anything goes wrong i.e. testnet MPC issues etc that causes fund lost cause derivation was
  no longer possible"); the mechanics **to confirm** · Built: `packages/web/src/auth/export-page.ts`
  (`EXPORT_SHOW_MS`, `EXPORT_WARNING`, the guard), `auth/approve-guard.ts` (`guardInputOf`), `apps/api/src/login.ts`
  (`exportChain`), `src/mainnet-demo.ts` (`recordKeyExport`), `src/directory/read.ts` (`withEvents`), the admin
  console's events table · Extends D40, D41, D59, D111, D268
- Decision:
  1. Export already existed (D40, D59, D111, D258, D268): the launcher inside the vault frame opens a top-level window
     on the auth origin that signs in again (Google `max_age=0`, or an email code), derives one chain key itself and
     shows it behind a typed confirmation. No SDK method returns a key; no message carries one.
  2. **Auto-hide**: a shown key hides again 60 s after Show (besides blur, a hidden tab and pagehide); the 5-minute
     erase (D111) is unchanged.
  3. **The guarded click**: Continue, Show key and Copy key are behind the approval popup's guard (1 s after the
     screen and the window's focus, an arming move or Tab, a click that starts after it, D113's keyboard dwell).
  4. **Warnings**: "Anyone with this key controls your funds … Hana can't recover it … Never paste it into a
     website", on the first and the confirm screens.
  5. **`key_exported`**: recorded by the API when the export window's `/v1/login` succeeds (server-side, so no page can
     skip it), with the user's internal id, the app, the chain (`exportChain`, the window's label; null from an older
     window) and the time; no key, token or path. Staff see it on the Users detail and the Support ID lookup.
- Not done: an "account view" in Hana's own UI (Hana has none; the launcher is the entry, D59; a Hana account page is
  Hana Home's, D40).

### D431. Key export on non-testnet manifests: D41 stands until a decision before mainnet
- Date 2026-11-06 · Status: **to confirm** · Source: the 2026-11-06 brief asked to leave export off for non-testnet
  manifests and decide production behaviour before mainnet
- Decision: no gate was added. D41 (confirmed by the user) already says export is mandatory and partners can't
  disable it, and the manifest schema accepts only `network: testnet`, so no non-testnet manifest can exist today.
  Whether D41 stands for mainnet, or a Privy-style partner switch is wanted, is `docs/mainnet-readiness.md` 1.18.
- Why: a gate would contradict a confirmed decision and be dead code today.

### D432. The email issuer reads apps through the API's read-only IssuerRpc, not a D1 binding
- Date 2026-11-06 · Status: decided while building, to confirm · Built: branch `feat/issuer-readonly-rpc` (not merged,
  not deployed): `apps/api/src/rpc/issuer.ts`, `apps/api/src/issuer-apps.ts`, `packages/console-core/src/issuer-apps.ts`,
  `apps/email-issuer/src/apps.ts`, `apps/email-issuer/scripts/gen-wrangler.ts` · Source: the task brief for
  `docs/mainnet-readiness.md` 7.1d; replaces D251's interim source check
- Decision: the API Worker exports a third `WorkerEntrypoint`, `IssuerRpc`, with exactly the issuer's three reads:
  `appByKey({pk})`, `appById({appId})` and `scopeHasEmailApp({scopeId})`. Each validates a strict console-core schema
  (`bad_request`), runs the SELECTs the issuer used to run over `APP_DB` (moved unchanged in meaning: the gate's model,
  the pre-0010 fallback) and answers `{ok: true, app}` / `{ok: true, hasEmailApp}` or `{ok: false, code}`; nothing
  throws out. The issuer's generated config binds its own D1 only and `API` → `{cloudflare.workerName}` at entrypoint
  `IssuerRpc`; `APP_DB` and `gen --app-d1-id` are gone (the flag is refused with a pointer). The issuer checks every
  answer's shape and fails a request closed on anything but a well-formed `ok` answer: `503 api_unavailable`, nothing
  minted or mailed. Details:
  - No caller clock: a key's rotation grace is judged on the API's `Date.now()` (the issuer used to pass its own).
  - No actor, budget or breaker (unlike ConsoleRpc / AdminRpc): the issuer's own per-IP, mailbox and per-app limits
    run before its lookups, as they did over `APP_DB`; each call is one or two SELECTs. Only refusals and errors are
    logged (method, code), so the API doesn't gain a line per email request.
  - `appId` accepts any stored id (`[A-Za-z0-9_-]{1,96}`), not only `app_<base58>`: it is the API's own id that the
    challenge recorded, older and test rows carry `_`, and it is only ever bound.
  - The answer is the app's issuer view only (id, name, scope, active, email on, plan limits, its Google web client),
    so a compromised issuer also loses read access to the rest of the API's D1 (keys, origins, sessions, the wallet
    directory), not just write access.
  - Tests: the API's unit tests of the entrypoint (the gate's model, strict inputs, `internal`, before 0010, exactly
    three public methods); source checks on both sides (the API's readers SELECT only and touch only `DB`; the issuer
    names no `APP_DB`, has one D1 binding and calls only the three methods; every generated issuer config, committed
    manifests included, binds the API at `IssuerRpc` only and none of its D1); the issuer's whole suite now runs
    against the real API Worker bundled as an auxiliary Worker (as the admin suite does), seeding the API's D1 through
    a test-only `API_TEST_DB`; the e2e stack runs the real `IssuerRpc` class on its node:sqlite D1.
  - Deploy order: the API (with `IssuerRpc`) before the issuer, on every env (`docs/operations.md` "Deploy order: the
    API before the issuer"). An issuer deployed first answers `503 api_unavailable` until the API ships it; rolling the
    API back past this commit needs the issuer rolled back with it.
- Why: Cloudflare has no read-only D1 binding (D251); a service binding to a named entrypoint gives the issuer exactly
  the reads it needs and nothing else, and keeps the lookups' SQL beside the gate it mirrors. The manifest stays the
  source of names (`cloudflare.workerName`), as for the admin's `AdminRpc`.
- Alternatives: (a) keep D251's source check: it stops accidental writes, not a compromised Worker. Not recommended.
  (b) A copy of the app rows in the issuer's D1, synced by the API: two sources of truth and a sync lag on suspension
  (D251 rejected it). Not recommended. (c) Calling the API's public `GET /v1/app` over HTTPS: it answers by origin rule
  and carries more than the issuer needs, with no by-id or by-scope read. Not recommended. (d) Reusing ConsoleRpc /
  AdminRpc methods with a `system` actor: write methods on the same binding. Rejected.
- Note: the name `IssuerRpc` was once proposed for an issuer-side entrypoint (D276's `IssuerRpc.uid`), which D346 and
  D394 dropped before it was built; this one is the API's.

## Superseded or amended

| Was | Now | Source |
|---|---|---|
| The issuer's `APP_DB`, a read-write D1 binding of the API's D1, held to reads by a source test until a read-only RPC replaces it (D251) | No API D1 binding: the API's `IssuerRpc` entrypoint (service binding `API`) with the three reads; `gen --app-d1-id` gone; the API deploys before the issuer (D432) | `apps/api/src/rpc/issuer.ts`, `apps/email-issuer/scripts/gen-wrangler.ts`; docs/operations.md "Deploy order: the API before the issuer" |
| D262: each vault frame has 5 s from its insertion to answer, a loaded one included; a wrong origin fails `no_answer` after about 10 s with a generic message | A loaded frame has 1.5 s after its `load`; `no_answer` in about 3 s, its message and `data.origin` naming the page's origin (D427) | `docs/integration.md` section 3 |
| D39: a `pk_test_` app never signs for a mainnet; the partner client refuses a test app's switch to any chain outside the testnet list | A test app Hana staff switched to the mainnet demo, in a dev testnet env, signs on Base and Stellar's public network up to $9.99 per transaction through the popup (D428, D429); the client lets a test app through on Base, the vault decides | `packages/core/src/mainnet-demo.ts`, `packages/web/src/vault/signing.ts` |
| D111, D268: a shown key stays shown until Hide, blur, a hidden tab or pagehide; Continue and Show act on any real click | A shown key also hides 60 s after Show; Continue, Show key and Copy key are behind the approval popup's guard (D430) | `packages/web/src/auth/export-page.ts` |
| D413: verify's phases ran one step at a time except gitleaks beside the typecheck and the docs checks beside the unit tests; the sandbox e2e one test at a time (`--test-threads=1`, also CI's) | Lanes side by side in four phases (sandbox e2e beside the pack check then Playwright; the contract beside the typecheck; the unit tests still alone but for the docs checks); the sandbox e2e 8 tests at a time, in verify and CI | D423 |
| D153 (an updater Add of a kid Google listed with the same material within 24 h is retired: cancelled), the JWKS cron's 55-min removal grace, the watchdog's Remove confirmed on two fetches 60 s apart | Retired only when known > 7 days, unlisted > 6 h and missed by 3+ fetches over 30+ min (else left pending); removal after 24 h missing from every fetch of 3 a run, never with a token in the last 24 h; a Remove confirmed early only after 3+ fetches over 10+ min and no listing for 24 h; `stale_active_key` after 27 h (D422) | `apps/api/src/issuer-keys.ts`, `apps/watchdog/src/run.ts`, migrations API 0012 and watchdog 0002 |
| D387: the checks run locally before a merge, from a list of commands in docs/operations.md | `pnpm verify` (CI's checks for the change, D383's rules) before every merge into `develop`, `--full` before a deploy; an optional pre-push hook runs `--quick` on pushes to `develop` and `main` (D413) | `scripts/verify.mjs`, `scripts/verify-hook.mjs`, `.githooks/pre-push`; docs/operations.md "CI and git" |
| D127 Q6/Q7: email sharing asked once per app at first login, for apps with the email claim on | A three-value app setting (`off` default / `on_request` / `at_login`), per app × account, a stored copy for the dashboard, re-ask for a second linked address, search only over shared addresses (D411) | not built |
| The email issuer is reached at its own `workers.dev` URL on a `workers.dev` env, else under the API's URL by a zone route (D230); `gen` gives an `emailIssuer.url` on another host neither a route nor a `workers.dev` URL | An `emailIssuer.url` on another host is the issuer's own Custom Domain (a dev env on custom domains); the zone route stays production's way (D404) | branch `feat/account-migration` |
| sandbox-dev's admin Access: the GitHub team `hana-admins` plus exact-email Google rules (D88), the workers.dev Worker-level toggle turned on in the dashboard (D284), the policy and AUD by hand | `sandbox*`: Google, exact emails only; every env's application and policies made and checked by `access-setup <env>` from the manifest, a hostname application on workers.dev (D409) | `scripts/lib/access-setup.ts`; docs/operations.md "Admin Worker" step 1 |
| D384: the watchdog, console, console-auth, admin and files Workers unstamped; `deploy-check` reads the API, the page Workers and bundles and the issuer; each of the API and issuer has its own `scripts/deploy.ts` | Every env Worker deploys through `packages/env/src/stamped-deploy.ts`; the console, console-auth and files Workers serve `/.well-known/hana-build`, the console SPA carries the meta; the admin's and the watchdog's id is read from the deployed version with wrangler (`--only watchdog` for the watchdog); `--only`/`--skip` (D406) | `packages/env/src/stamped-deploy.ts`, `scripts/lib/deploy-check.ts`; docs/operations.md "Checking a deploy" |
| D87: the admin Worker's notices and the watchdog's alerts through Resend, each with its own Resend key; D279: a Resend `Idempotency-Key` per message, so a retry within 24 h isn't delivered twice | SendGrid for every Hana email through one shared adapter, each Worker its own Mail-Send-only key (admin `EMAIL_API_KEY`, watchdog `SENDGRID_API_KEY`); no provider idempotency: a per-isolate memo of accepted messages, a repeat possible, a skip never (D401) | `packages/sendgrid`; `docs/operations.md` "Admin Worker" step 2, "Watchdog service" |
| D308: the `STATEMENTS` lock is 2557 days in every env | 1 day on sandbox-dev, 2557 days in production (D402) | `docs/operations.md` "Files Worker and logos" step 2 |
| `usage-setup roles`: a locally generated password per role, set as a SCRAM-SHA-256 verifier by `ALTER ROLE … LOGIN PASSWORD`; a re-run reuses the role files (D224) | SQL gives `LOGIN` only; Neon's API (`reset_password`) generates each password, written straight to the role file; every run resets both and replaces the files, so Hyperdrive configs from older files are re-created; the key in `.secrets/<env>/neon-api-key` (D403) | `scripts/lib/usage-setup.ts`, `scripts/lib/neon-api.ts`; docs/operations.md "Usage capture" step 2 |
| D347: every Hana page posts `hana:auth-progress` (`google`, `relayed`) and then navigates or closes | The page navigates or closes once the vault acked (`hana:auth-progress-ack`), or after 150 ms: Chromium nulls the source of a message posted in the navigation's own task (D400) | `packages/web/src/auth/vault-signal.ts`; docs/architecture.md login step 4 |
| The lookup's ticket: 1–64 printable ASCII characters, no `@`, no leading or trailing space (D396) | console-core `SUPPORT_TICKET_RE`, 1–64 letters, digits or `._#:-`: the issuer's rule, the same ticket in both audits (D399) | `packages/console-core/src/support.ts` `supportTicket` |
| The issuer's `support_lookup` audit action unused; every `DirectoryRpc.get` audited `user_view` (D392) | `get` takes `purpose`; the Support ID lookup's email join is audited `support_lookup` with the lookup's request id (D399) | `apps/email-issuer/src/directory-rpc.ts` `get` |
| Every DirectoryRpc call carries a required ticket (spec "Data path", D275 as proposed) | Required to open one identity (`get`); optional for a search or list page; every read audited either way (D275 as confirmed 2026-11-05) | `apps/email-issuer/src/directory-rpc.ts`, migration 0003 |
| C8b's issuer migration 0003 adds `user_email_apps.uid` (build plan C8b) | No uid column (D346 dropped it); 0003 rebuilds `email_admin_audit` only (D392) | `apps/email-issuer/migrations/0003_directory_audit.sql` |
| D381: a session key WebCrypto can't make ends the login `api_unavailable` (a different code rejected) | `derive_failed` with `data.reason` `webcrypto_unsupported` / `webcrypto_failed` (D385) | `packages/web/src/vault/errors.ts` |
| D347's assumption rechecked with `curl -sI` on the authorization URL before each release | `coop-canary <env>` before each release: every hop of the product's requests under six User-Agents, and Chromium, Firefox and WebKit, with positive controls (D386) | `scripts/lib/coop-canary.ts`; docs/operations.md "Before each release: the COOP canary" |
| D276's code → user through the issuer's `user_email_apps.uid` (`IssuerRpc.uid`, `DirectoryRpc.byUid`) with a ledger-only fallback; the code from the uid; `user:erase` | Through the wallet directory's `end_users.support_code` / `token_sub` / `user_id` (no issuer uid, no `IssuerRpc.uid`, no `byUid`, no fallback); the code from the identity token's `sub` (D346); the lookup's hot-DB part in `AdminRpc`, its ledger part read as `usage_admin` (D394); erasure by `uid-erase` (D361) | `apps/api/src/directory/support.ts`, `apps/admin/src/support.ts`, `scripts/lib/admin-support.ts` |
| The outside identity-JWKS probe runs every 3 hours on GitHub Actions (D383); CI runs on every push and PR (D383) | Both workflows disabled while only testnet runs; before mainnet CI back on and the probe on AWS Lambda + EventBridge (D387) | GitHub workflow settings; `docs/mainnet-readiness.md` 4.20, 5.10 |
| A close within 8 s of the popup leaving for Google stops the watch; the login waits for its 5-minute limit (D347) | The login waits 90 s for the popup's answer, then ends with `login_cancelled` (`popup_closed`), as after any close (D398) | `packages/web/src/vault/login.ts` `POPUP_WATCH.earlyCloseDeadlineMs` |
| The outside identity-JWKS probe runs hourly (D382) | Every 3 hours, at minute 17 (D383) | `.github/workflows/identity-probe.yml` |
| The outside identity-JWKS probe runs every 15 min (D210) | Hourly, at minute 17 (D382) | `.github/workflows/identity-probe.yml` |
| The admin crons' budget counts emails and NEAR reads only, with room for the RPCs (D280); C12's `relayerKeys` and statement-notice reads uncharged (D360's note) | Every outbound call counts: the connection, every RPC (at most 30), every email, NEAR read and rate fetch; a unit of work starts only when it fits (D380) | `apps/admin/src/mail.ts`, `cron.ts`, `ledger-cron.ts` |
| `usage.erase_uid(app_ids text[], uid bytea)` (spec "Usage ledger" functions) | `usage.erase_uid(uid bytea)`: by uid alone, in any app (D362); the uid indexes C15 planned are in 0007 | `apps/api/migrations-usage/0007_retention.sql` |
| `uid:erase` (ledger only) and the proposed `user:erase` (issuer only), separately (spec "CLI", D276) | One script, `uid-erase`, per scope across the ledger, the wallet directory and the issuer directory (D361) | `scripts/lib/uid-erase.ts` |
| The client-proof helper loads Google Identity Services; the console warns the proof carries the staffer's email and name (spec "On-chain owner actions" step 3) | Google's implicit flow with `scope=openid`; a proof with an email or a name is refused, and the warning names the account id that stays public (D350, D351) | `apps/console/src/scopes.ts`, `auth-token.ts` |
| The claim allow-list is the ten names of the 2026-10-28 spike (D271) | The same plus `at_hash` (D342) | `packages/core/src/id-token.ts`, `apps/api/src/claims.ts`, `apps/console/src/auth-token.ts` |
| The wallet directory's user id shown to partners is `hu_…` (the ledger's uid) and the Support ID its first 8 characters (D312, D276) | The User ID is the identity token's `sub` (`u1_…`); the Support ID is Crockford base32 of its first 5 bytes; `hu_…` is the internal id, staff only (D346) | `packages/console-core/src/users.ts`; `apps/api/src/directory/` |
| `POST /v1/wallets/record` needs no session-key signature (D313) | It needs the session key's signature over the whole record (D311, D313 amended: a security review finding) | `packages/core/src/wallet-record.ts`; `apps/api/src/directory/record.ts` |
| The admin feed's cursors start at 0, so its first runs email the whole history (D281) | A cursor with no row starts at the source's current position, read silently; only later rows are emailed (D344) | `apps/admin/src/feed.ts` |
| The console's hourly purge deletes a replaced logo's R2 object, then its row (D244) | Its row first (only while still marked), then the object; the rows come back if the delete fails (D301) | `apps/console/src/cron.ts` `purgeLogos` |
| Local git only, branch `develop`, no remotes (batch A) | Remote `Hana-Technology/hana-id`; feature branches, PRs into `develop`, `main` for releases | `docs/batch-a-spec.md`; CLAUDE.md |
| One relayer key pool, 300 Tgas for everything (batch A) | Two pools, per-method gas (D19) | `docs/batch-a2-shared-client.md` |
| Hana can never block derivation for a scope (batch A) | True for scopes with their own client; Hana can stop a shared-only scope by removing shared clients | `docs/contract-interface.md` security notes |
| Provisional HKDF salt `hana-embed-ckd-v1` | Derivation v1 (D9) | `docs/batch-b-spec.md` "Address impact" |
| PoC keys in plaintext `sessionStorage` | Vault iframe on a Hana origin (D22, D47) | `docs/context.md` "Known issues for batch B" |
| CKD network key read over RPC | Pinned per env (`ckdNetworkKey`) | same |
| Full Google token with email on chain | `scope=openid` and the claim allow-list (D25) | same |
| Login page computes the shared-mode nonce (A.2) | The vault computes it; the login page only checks and relays it (D47) | `docs/batch-b-spec.md` "Amends" |
| Contract upgradeable with no lock (batch A, PoC) | Still so on testnet; upgrade governance before mainnet (D2, D33) | `docs/batch-a-spec.md` |
| Partners build the SDK from this repository and compile its TypeScript sources | Built tarballs (`pnpm pack`), installed with npm; no registry yet (D71, D72) | `docs/integration.md` "Install" |
| Only Hana staff issue invites (D29) | Hana invites each org's first owner; owners invite viewers and owners, a new owner waits 24 h as a viewer (D89) | `docs/batch-c-spec.md` "Invites" |
| Governance draft: owner DAO 3-of-3 for policy and member changes; sandbox-dev signer full-access key deleted | 2-of-3 for every kind (D81); sandbox-dev keeps the key, staging and mainnet never have one (D86) | `docs/governance-spec.md` |
| Vault per-IP and per-share limits on `RateLimiter` objects, the share hit sent alongside the IP one and refunded (D78) | Rate Limiting bindings `VAULT_IP_LIMIT` and `VAULT_SHARE_LIMIT`, per location and approximate, asked in turn with no refund; the app quota stays on the object (D95) | `docs/api.md` "Rate limits" |
| Batch C draft retention: ledger 400 days, uid stripped 35 days after the month, audit 36 months | Statements and settlements 7 years, raw usage 24 months then de-identified, audit 5 years (D90) | `docs/batch-c-spec.md` "Retention" |
| Sodax Stellar `signAndSendTransaction(p)` is `sendTransaction(signTransaction(p.data))` | It signs as `p.from`: `sendTransaction(signTransaction(p.data, {address: p.from}))`, so a raw transaction built for another account (a muxed `M…` address included) is 4100 before any popup. Sodax builds every raw transaction for `getWalletAddress()`'s `G…` address. Confirmed (D67) | `docs/batch-b-spec.md` "Sodax adapter"; `packages/sodax/src/stellar.ts` |
| `/login` calls `GET /v1/app` itself and cross-checks the vault's signer, scope and client before Google (batch B "Login" step 4) | It checks the pinned signer and the nonce only, makes no API call, and shows the vault's app name (D77) | `docs/security.md` "The login popup trusts the vault's app facts" |
| Every approval popup opens from the vault's "Review in Hana" launcher (batch B "Approval flow" steps 1–2) | A signing call from a click opens it in that click (`/approve?from=partner&v=…`); the launcher is the fallback without user activation or when `window.open` returns null (D99) | `docs/batch-b-spec.md` "Approval flow" |
| CODEOWNERS on derivation, vectors, the contract and the env schema (D58) | Also `/envs/`, the API, web, core and watchdog sources, `scripts/`, lockfiles, `.gitleaks.toml`, `.githooks/`, `.github/`; two owners, `@tzechuen` and `@mj-hana` (D100) | `.github/CODEOWNERS` |
| One global owner-action cap (20/min, 200/day); the relay quota counted in the gate, before verification | Caps per owner, per scope and global, `execute_change` and `cancel_change` on windows of their own; the relay quota counted right before the relay (D100) | `docs/api.md` "Rate limits" |
| D100's owner-action caps: 50/day per scope, only `cancel_change` outside the general windows, the owner nonce left to the contract | 20 a UTC day per scope; a safety budget (`cancel_change`, `remove_client`, `disable_shared_login`) on the former cancel windows; the precheck recomputes the owner and client-proof nonces on an uncached scope (D236) | `docs/api.md` "Rate limits", "`POST /v1/owner-actions`" |
| Console owner tokens refused for `email`, `email_verified` or `hd` on `ConsoleRpc.ownerAction` only, client proofs unchecked there, `/v1/owner-actions` ignoring them (D237, D239) | The claim allow-list on every Google token the API verifies: both owner-action tokens on both paths, and the step-up token (D274, D277) | `docs/api.md` "`POST /v1/owner-actions`" |
| Console audiences registered as clients of `global` (deploy-contract, batch A) | Their own console sink scope, never `global` (D93 Q7, D238) | `docs/operations.md` "Console sink scope" |
| `fetch-ckd-key` reads the CKD key from the manifest's `rpc` | From ≥ 3 independent providers at one final block, all agreeing, with the block recorded (D100) | `docs/operations.md` "Create an environment" step 3 |
| Stellar classic operations other than changeTrust, payment and createAccount shown by type with their raw XDR (batch B "Approval flow" step 4) | Every operation decoded field by field; account-control operations get a red banner and per-operation warning and are never auto-approved (D110) | `packages/core/src/decode/stellar.ts` |
| The export window shows the key while a button is held until the window closes (batch B "Key export" step 5) | The key is erased 5 min after it is derived or when the session ends, whichever is first; a new export needs a new sign-in (D111). It is shown on a Show key / Hide key toggle, not while a button is held (D268) | `packages/web/src/auth/export-page.ts` |
| The export window shows the key only while a button is held, and nothing is copied to the clipboard (batch B "Key export" step 5) | A Show key / Hide key toggle with the key selectable while shown, and a Copy key button (`navigator.clipboard.writeText` in the click); the window tries to blank the clipboard 60 s after the last copy, at the erase and at pagehide, while it has focus, and never reads it (D268) | `packages/web/src/auth/export-page.ts` |
| The vault persists (share, record) before it replies to `hana_login` (batch B "Login" steps 11–12) | It replies first; the share and record follow in the background, and a failure turns `persistence` to `'none'` (`persistenceChanged`, D79) | `packages/web/src/vault/vault.ts` `persistLogin` |
| Email login deferred (D4) | Confirmed: a Hana-run issuer (D4, D119, D121–D123); contract v3, `packages/email` and the watchdog part merged, the issuer not yet (`docs/email-login-build-plan.md`) | `docs/email-login-spec.md` |
| Hana requests only `scope=openid` from Google (D25) | The on-chain token stays openid-only; the popup also requests `email`, which the issuer handles transiently off chain at link time, keeping only an HMAC (D25 amended) | `docs/email-login-spec.md` "How the popup gets Google's verified email" |
| End users are never contacted by Hana (D96) | Still no stored address; Hana sends only sign-in codes and link notices the user's action triggered (D96 amended) | `docs/email-login-spec.md` "Notices" |
| Email spec draft: AWS KMS key from the start, single-signature tokens | Worker-secret key on testnet, AWS KMS before mainnet; a signer policy and multi-signature JWS JSON tokens from day one (D121) | `docs/email-login-spec.md` "Signing key (staged)" |
| Email spec draft: Gmail-only immediate linking, case B always 24 h, a switcher for two wallets (case D) | Google-hosted (Gmail or matching `hd`) links at once in cases A and B, others need a code (A) or 24 h (B) (D119); never a second wallet, no switcher (D122) | `docs/email-login-spec.md` "The four cases" |
| Email spec draft: disposable-address domains allowed | Blocked (D123) | `docs/email-login-spec.md` "Rate limits and abuse" |
| Email spec: `opened` recorded at every `create_session*` | Recorded at derivation (D130) | `docs/contract-interface.md` "Accounts and links" |
| Email spec: `auto_link` nonce over the session, the session identity, the target epoch and the mode; the combined login signed over the plain CKD payload | The nonce also commits to the join (who joins which account), and with a link the session key signs the linked CKD payload (D133) | `docs/email-login-spec.md` "Byte layouts (new)", "Sessions" |
| Email spec: `mark_self_issued(provider)` for any issuer | Only `email` (D134) | `docs/contract-interface.md` "Self-issued issuers" |
| Email spec Q7: Gmail `+tag` dropped (one wallet per inbox) | Each `+tag` its own identity; dots still ignored (D159) | `packages/email/README.md` |
| Identity spec: KMS signer `{kind: "aws-kms", awsRegion, keys: {active, standby, next?, previous?}}` (kids) | Each key `{kid, arn}` (region from the ARN, the standby in another region), a `credentials` block naming the IAM user; only the active ARN reaches the Worker (D215) | `packages/env/src/identity.ts` |
| Identity spec: the signer's IAM user may `kms:Sign` on the identity key ARNs | On the active key's ARN only (both during a switch), so the standby stays clean (D219) | `docs/operations.md` "Identity token keys on AWS KMS" |
| `create_session` opens a session for anyone holding the token; after a front-run `create_session` the key holder derives with counter `used + 1` | A bare `create_session` needs the session key's proof of possession bound to its parameters; a session meant to carry a link is revoked and restarted, never derived plainly (D137) | `docs/contract-interface.md` "Sessions and CKD" |
| Email spec: the testnet signing keys (primary and standby) both Worker secrets | The standby is published and posted on chain but kept off the Worker (D196) | `docs/operations.md` "Email issuer" |
| Email spec: case A's code started with `start` (purpose `auto_link`) and google-match called again with `link: true` | google-match prepares the `auto_link` challenge with Google's verified address; the popup sends its first code with `resend` (D195) | `docs/api.md` "Email issuer" |
| Batch 8a: the vault fixes the path from the token (D249); no key export for email wallets (D246); email for demo scopes only (D248) | The path from `get_identity` (batch 7); email export over the export window's own session (D258); D248's limit lifted where Google logins write hints | `docs/architecture.md` "Automatic linking", "Key export" |
| Email spec: the vault sends google-match with the popup's `{idToken, accessToken}` from one Google request | A second, silent `email` request by default (D254), relayed in a follow-up slot (D256) | `packages/web/src/auth/google.ts` |
| D254: `GOOGLE_EMAIL_FLOW` `'second_request'` or `'one_request'` (`id_token token`, `openid email`) | `'token_first'` (in force since the spike passed on 2026-11-04, D270) or `'second_request'` (the tested fallback); `'one_request'` removed (D273) | `packages/web/src/auth/google.ts` |
| google-match revokes Google's access token (D195, D254; the interactive email consent "the first time only") | Never revoked: revocation ends the whole grant, so the consent came back every login (D265) | batch 8b review |
| A path through `get_identity` on the vault's RPC alone (batch 7) | A non-own path confirmed on `rpc` and `rpcFallback` separately; root pins (D263) | batch 8b review |
| D255: no access token (declined) → `email_match_unavailable` | Declined or another account: the popup's consent screen, `email_consent_declined` / `google_account_mismatch` (D264) | batch 8b review |
| D264, D270, D273: cancelling token_first's Google screen ends the login, `google_error` (`data.error: 'access_denied'`) | The popup goes back to Hana's method chooser (or case B's choices) and the login goes on; closing it there is `login_cancelled`; `google_error` only for Google's real failures (D341) | `packages/web/src/auth/callback-page.ts`, `auth/email-page.ts` |
| The API's D1 holds no `sub`, address or user id (only `sha256(path)`, `docs/architecture.md` "Data stores") | The wallet directory (hot-DB migration 0011): each user's uid-based id, the account's identities with their subs, and the wallets its logins reported (D310, D312–D314) | `docs/architecture.md` "Data stores" |
| Hana stores no end-user email address; the Google email is handled transiently, only its HMAC kept (D25 and D96 amended, D119, D230); the screens say "it isn't kept" (D264) | The issuer keeps each identity's verified address in its own D1 (`user_emails`, `user_email_apps`), for Hana staff only (`admin user:list` / `user:find`); partners never see it; the screens say Hana keeps it with the account and doesn't share it with the app (D269) | conversation 2026-11-04 |
| D392: the directory search's ticket optional on every search; D391: `POST /api/users/find` unticketed, unaudited; the SPA's detail at `/users/<provider>/<sub>` | A search by `sub` or a full address needs the ticket; `find` ticketed and audited first (`users.find`); the detail at `/users/open` from memory (D410) | security review 2026-11-05 |
| D224: Hyperdrive configs by `wrangler hyperdrive create --connection-string` (the password a process argument) | Cloudflare's REST API, the password in the HTTPS body (D412) | security review 2026-11-05 |
| D404: testnet moves to company accounts, timing open; the dashboard blocks held until the company account exists | sandbox-dev's M4 is set up on the personal Cloudflare account now; the move redoes it with the D404 runbook (D414) | branch `feat/m4-personal-account`; docs/operations.md "Moving an env to another Cloudflare account" |

## Proposed, not yet confirmed

Still open in `docs/batch-b-spec.md` "Open questions": Q2 (near-zero-click returning login), Q4 (partitioned IndexedDB
retention, to measure), Q6 (a "remember this device" option), Q10 (the ship gate's 1.5 s threshold), Q11 (the real
MPC's timeout and failure behaviour), Q13 (dropping partner-origin CORS for `pk_test_` in sandbox envs), Q15 (the
production domain names and Cloudflare account; only "two registrable domains" is decided, D38), Q17 (approval popup
lifetime and mobile behaviour), Q24 (mobile and in-app webviews), Q25 (SWK 1.9.x and 2.x), Q26 (the EIP-6963 `rdns`,
after Q15), Q29 (runtime dependencies and bundle budget). Also open: the mainnet launch date (D39); the mainnet
issuer-key delay is provisional until the lead-time measurement is in (D80).

Still open in `docs/governance-spec.md`: where the mainnet backup council key is held (D81, before mainnet), the
paging app (D85, at setup), and open question 17 (cancel by a compromised OIDC owner, from batch C Q9). Still open in
`docs/batch-c-spec.md`: Q1, Q3, Q4's fallback addresses, Q5 (D93). Everything else in both specs follows D80–D93 or
is a proposal there.

Still open from `docs/email-login-spec.md`: the user-mail provider. D194 names SendGrid, provisional until the
colleague agrees; the watchdog's alert email and the admin Worker's notices moved to SendGrid too (D401, asked for
by the user 2026-11-05). The contract readings
D130 and D131, batch 2's D154 and D155, and the `packages/email` readings D156–D159 are confirmed (2026-11-02).
The watchdog's D190, D191 and D193 (batch 5) are confirmed (2026-11-02); D192 is superseded by D200. The email
issuer's D195–D199 (batch 4) wait for the user's confirmation.
To confirm from batch C step C2 (`packages/oidc`): D201 (the new claims typed on request, ignored by the API), D202
(the Access JWT check and its cert cache) and D203 (the package's logging hook, Google's fetch limits).

Batch C3's readings D205–D209 (hot DB 0006, the gate, the CLI) are to confirm. So are batch C5's D225–D229 (the
legacy key column and deleted apps, the notice fields, keys and no-op writes, drift and breaker events, RPC actors
and codes).
Batch C4's readings D220–D224 (the session marker and migration 0009, the event's bounds, the writer, the
identity-count copy, `usage-setup`) are to confirm.
To confirm from email login batch 6 (`feat/email-login-6`): D230 (the issuer on its own URL, never through the API),
D231 (email tokens at the API, `login_methods`, `GET /v1/app`), D232 (the link precheck, relays and panics), D233
(share revocation, `email_usage`, the issuer's app lookup), D234 (the corrected deploy order, the email clients in
batch 8), and from its reviews D250 (requests bound to fail, per-account link limits, gas per signature, stale email
keys), D251 (the issuer's read-write APP_DB, to replace by an RPC) and D252 (the session pool carries the link
methods, with a global cap).
To confirm from email login batch 8a (`feat/email-login-8a`): D245 (the email step's cancel codes and progress), D246
(no key export for email wallets yet), D247 (the SDK surface: `login_method_unavailable`, hints, no email-only apps),
D248 (turning email on for the demo by hand) and D249 (paths without `get_identity`, the popup's storage).
To confirm from email login batch 8b (`feat/email-login-8b`): D254 (Google's email by a second, silent request, one
interactive retry), D255 (a Google identity without a wallet is refused when google-match can't answer), D256 (the
follow-up channel; `verify` answers the case-B `sub`), D257 (D137's recovery ends the login after revoking), D258
(email export over the export window's own `session` code) and D259 (banners in the login popup, `hana.account()`,
`linkChanged`, `linkAccount`; what isn't built).
To confirm from the batch 8b review (`feat/email-login-8b`): D263 (non-own paths confirmed on two RPC providers, root
pins), D264 (the email permission's explainer, consent screen and reasons; D42's warning), D265 (the access token never
revoked, google-match retried; the spike gate, passed 2026-11-04), D266 (the issuer's word on the match, accepted) and D267 (the relay's and
google-match's per-IP limits, the relay body cap).
To confirm from the demo polish (`fix/demo-polish`): D260 (an email login's own timing stages), D261 (`GET /v1/app`'s
side-by-side reads, view timeouts, the login's retry and its timings) and D262 (the vault's `connected`, the SDK's one
frame retry, `vault_unavailable`'s reasons).
To confirm from batch C6 (`feat/batch-c-6`, on current `develop` as `feat/batch-c-6-merge`): D235 (the step-up check's
order, codes and added checks), D236 (the precheck's nonce, the caps reconciled with D100, the allowance alert), D237
(`ConsoleRpc.ownerAction` on the endpoint's path), D238 (the console sink scope in deploy-contract) and D239 (what the
API keeps of a token), with D277 (the claim allow-list on every token batch C6 verifies).
To confirm from `feat/google-token-first`: D273 (token_first's one interactive openid-only retry, `'one_request'`
removed, the callback's claim allow-list before relaying).
To confirm from `fix/user-emails-review`: D269's review fixes (the CLI's remote read through D1's REST API instead of
wrangler; a record-only login that still ends on another client's access token).
To confirm from `feat/scope-email-client-tool`: D253 (dev envs mint the email client proof locally; production keeps
the issuer's Access route).
Batch C7's D240–D244 (the console never holds an invite token, an owner invite's grant and its two notices,
`invites.new_org_kind` and the passkey gate, StaffRpc's actors, commit rows and codes, the console's C7 routes and
cron) are to confirm.
To confirm from the identity token's step 7 (the KMS signer's code): D215 (the manifest shape and credentials), D216
(`DIGEST`), D217 (strict DER, the self-check), D218 (one `Sign`, no retry, limits) and D219 (the standby's region, the
IAM policy on the active key only).

Identity token step 8's readings D210–D214 (the watchdog's identity JWKS and discovery check, pin before publish, the
"identity key on chain" kid check, the discovery fields, bounded alerts and the portal hand-off) are to confirm.

To confirm from `feat/wallet-directory` (D310's build, 2026-11-04): D311 (the record's format and its raw-signing
residual), D312 (the user id is the uid, the Support ID its first 8 characters), D313 (the record endpoint's checks),
D314 (identities from chain reads), D315 (what the read APIs return), D316 (the CLI's private reads of the hot DB) and
D317 (the vault's background report).

From `docs/batch-c-users-support-id` (2026-11-04): D275 (the admin console's Users screen over D269's directory)
**confirmed by the user on 2026-11-05 with amendments** and built in C8b (D388–D392, to confirm); D276 (the Support ID
made consistent with D269) confirmed by the user on 2026-11-05 as amended by D346 and built in C15 (D393–D397). Both
below.

### D275. The admin console's Users screen reads the user directory through a read-only, self-auditing RPC on the issuer
- Date 2026-11-04 · Status: **confirmed by the user** (2026-11-05, with the amendments below) · Source: D269 ("the
  admin console's Users page later (batch C)") · Written: `docs/batch-c-spec.md` "Users and Support ID" (data path,
  Users screen, what partners never see, tests, Q26); build plan C8b · Built: branch `feat/batch-c-8b` (C8b; not
  merged, not deployed; the build's own readings D388–D392)
- **Amendments by the user (2026-11-05)**, otherwise as recommended below:
  - **The support-ticket reference is required to open a single user's detail** (`get`, and any call that returns
    one identity's full record), and **optional for list and search views** (`search`, list pages). Every call is
    still audited in `email_admin_audit`, with the ticket when given and never an address in the audit row.
  - **The per-staff budget as proposed, provisional**: at most 500 identities an hour and 2 000 a day per staff email;
    past that the call answers `rate_limited` and the security alias is emailed (the admin Worker's existing alert and
    email path, under its call-budget rules, D380). The numbers are named constants (console-core
    `DIRECTORY_ROWS_PER_HOUR`, `DIRECTORY_ROWS_PER_DAY`).
  - **The admin screen also shows the user's wallets, User ID (`u1_…`), Support ID and internal `hu_…`** from the wallet
    directory through the API's AdminRpc (admins see email and wallets, D310), joined by provider and sub.
  - Confirmed as recommended: `DirectoryRpc` with no route, bound only by the admin Worker as `ISSUER`; read-only
    methods (`search`, `get`, `auditSince`; `byUid` not built: D346 dropped the uid it would read); the source test;
    the issuer's own JWT check as the actor; the audit row in the same D1 batch as the read; issuer migration 0003; the
    search filters and the detail's fields; "chain unavailable", never a guess; the unverified-claim warning and
    never a default target; no CSV export; nothing for partners, with tests that enforce it.
- Recommendation:
  - **Data path.** The issuer exports `DirectoryRpc`, a `WorkerEntrypoint` with no route that only the admin Worker
    binds (`ISSUER`). It has read methods only (`search`, `get`, `auditSince`; `byUid` with D276). A source test
    holds the module to `SELECT`s on `user_emails` and `user_email_apps` and forbids imports of the signer, key,
    challenge and mail modules.
  - **The issuer checks the staff member.** Each call carries the staff request's Access JWT, which the issuer
    verifies itself (admin application `aud`, team domain, staff list) and uses as the actor. Each call also writes
    its `email_admin_audit` row in the same D1 batch as the read, with a required ticket and no address in it.
    Issuer migration 0003 adds the actions and a `detail` column.
  - **Budget.** Each staff email gets at most 500 identities an hour and 2 000 a day (provisional). Past that, the
    call answers `rate_limited` and the security alias is emailed.
  - **Features**:
    - Search by address (exact, or a substring of at least 3 characters), provider, app, sub and "unverified only".
    - The detail shows the address, provider, sub, verified and hosted flags, first and last seen, and the apps. It
      also shows the on-chain path per scope, and for a linked member the account root, read live with
      `get_identity` and `get_account`. A failed read shows "chain unavailable", never a guessed path.
    - Unverified Google claims carry the CLI's warning and are never a match's default target.
  - **No CSV export.** Bulk reads stay with `admin user:list --json`.
  - **Partners get nothing.** No binding in the console, no `ConsoleRpc` field, no SDK or `/v1` field, nothing in
    the partner feed.
- Why: the issuer is the directory's only writer (D269), so a narrow read entrypoint keeps it so. Checking the JWT at
  the issuer means a compromised admin Worker reads only what staff requests let it read, and those reads are
  audited where the data lives. This is D251's direction (a narrow RPC instead of a broad D1 binding).
- Main trade-off: more code in the Worker that holds the signing keys and `K_sub` (mitigated: no route, the source
  test, additive methods), and the issuer must deploy before the screen.
- Alternatives:
  - (a) **An issuer D1 binding in the admin Worker.** Simplest, but D1 bindings are read-write and cover the whole
    database. A bug or compromise there could write `email_hints` (which automatic linking reads, D266),
    `email_suppressions` or the audit, and read with no audit row. Not recommended.
  - (b) **Move the directory into a D1 of its own, bound to both Workers.** This keeps the hints out of the admin
    Worker's reach. The admin Worker could still rewrite rows and mislead support, reads go unaudited, and there are
    two writers. Cheap now (0002 isn't applied on sandbox-dev), but not recommended.
  - (c) **The admin Worker calls the issuer's Access-protected HTTP routes.** This puts an address-serving route on
    the public internet. Not recommended.
  - (d) **A CSV export**, capped (e.g. 1 000 rows), audited and emailed to the alias. Useful for partner-wide
    analysis, but one click takes out a slice of the directory. Not recommended for batch C; the CLI covers one-off
    needs.
- Also: the batch C spec's Support ID line ("no email or Google account") and "Hana stores contact details only for
  partner members, security contacts and billing contacts" were rewritten. They now read as statements about
  partners and about whom Hana contacts, consistent with D269.

### D276. Support ID: the uid's first 40 bits; staff resolve it through the directory's stored uid; errors by request ID
- Date 2026-11-04 · Status: **confirmed by the user** (2026-11-05: "yes go ahead with C15"), **as amended by D346 and
  below** (the 2026-11-05 amendment; built in C15, D394–D397) · Source: build plan C15's open question (D144:
  confirmed, built from data Hana already keeps), made consistent with D269 · Written: `docs/batch-c-spec.md`
  "Support ID lookup", Q27; build plan C15
- Recommendation:
  - **The code** is `HANA-XXXX-XXXX`: the Crockford base32 of the uid's first 5 bytes. The secret is
    `USER_ID_KEY` through the uid (`hana-id/uid/v1`), so there is no new secret, domain string or table. It is per
    scope and per account (a linked member shows its root's code).
  - **Where it is shown.** The API returns `supportId` with the session (`/v1/login`, `/v1/sessions`). The vault
    exposes it in `hana_status` (so partners' diagnostics carry it) and in the popup's account view.
  - **Code → user.** The issuer fills a `uid` column in `user_email_apps` after each directory write, from a new
    API entrypoint `IssuerRpc.uid` (bound only by the issuer; the entrypoint D251 plans), off the answer's path.
    Staff reach that column only through `DirectoryRpc.byUid`, with a staff JWT. Without a directory row, the
    fallback is the ledger only (`app_users` by uid prefix). Every match is listed (40 bits: rare collisions,
    resolved by the app the partner names).
  - **Address → user** is the Users search; the detail shows the code.
  - **What a lookup shows**:
    - Logins and sessions: the ledger's ok `login`, `session` and `derive` events by uid, with live vault shares
      from `AdminRpc.userShares`.
    - Errors: by the request IDs the partner sends, since the ledger keeps uids only on ok events, by design.
    - The app's `app_changes`.
    - Not consents: they live only in the vault's browser storage.
  - **Partner side**: the code only, no address or sub, and no partner lookup in batch C.
  - **Retention**: nothing new but the `uid` column (kept with its directory row) and audit rows (5 years). A code
    resolves while the ledger holds the uid (24 months after the month, D90). Directory rows have no expiry under
    D269. An erasure request deletes them with a new CLI `user:erase`, so `DirectoryRpc` stays read-only.
  - **Migrations**: the Neon one adds `app_users (uid)` and `events (uid, at)` indexes, at the next free number
    (0004 and 0005 are taken).
- Why: D144 (no dedicated support table) holds, and the uid is already the ledger's key. Storing it beside the
  address makes code → user a single indexed read instead of recomputing every directory row's uid at the API. The
  key stays in the API only. A compromised issuer gains uids it can't join to anything (it can't read the ledger).
  A compromised admin Worker can't compute uids without a staff JWT.
- Main trade-off: the partner page sees a stable per-scope pseudonym (40 bits of the uid; no more than the identity
  token's `sub` gives). The issuer also gains a call into the API, best effort and off the hot path, so a lost call
  leaves the code unresolvable to a user until the next login.
- Alternatives:
  - (a) **A separate `SUPPORT_ID_KEY`** (HMAC of the uid). It adds a secret and still needs a stored code or a
    scan. Not recommended.
  - (b) **The code from the identity token's `sub`** (`IDENTITY_SUB_KEY`). Partners could map it themselves, but
    it is a second pseudonym that the ledger doesn't use, and it needs its own index. Not recommended.
  - (c) **No stored uid.** Recompute the uid at lookup for each directory row of the app through an
    `AdminRpc.uid`. That costs O(users of the app) per lookup and lets the admin Worker compute uids on its own.
    Not recommended.
  - (d) **uids on post-verification error events**, so errors list per user. It means a migration of the ledger's
    CHECK and more per-user data. Not recommended; request IDs cover support.
  - (e) **An org-scoped lookup in the partner console** (the org's ledger rows for a code, no address). Deferred.
- Amends in text only: D96's "it reveals no email or Google account" now holds for partners; staff reach the
  directory (D269). `docs/email-login-spec.md` ("Support ID lookups show … never a `sub` or address") and
  `docs/hana-home-spec.md` "Support ID" still say otherwise. They are to be aligned once this is confirmed.
- **Amended 2026-11-04 by D346 (confirmed by the user): the code's derivation.** The code is now the Crockford base32
  of the first 5 bytes of the identity token's `sub` HMAC (`IDENTITY_SUB_KEY`, the 16 bytes `u1_…` encodes), no
  longer of the uid: alternative (b) above, taken so the partner's one id (the `sub`) and its Support ID are the same
  user's, and a partner can compute the code from the `sub` it stores. The format `HANA-XXXX-XXXX` is unchanged.
  Code → user is `end_users.support_code` in the hot DB (D312, built), then `end_users.user_id` (the uid, `hu_…`) for
  the ledger; the issuer's `uid` column and `IssuerRpc.uid` above are no longer needed for it, and the ledger-only
  fallback (a uid prefix) is gone: a user with no directory row since the deploy has no resolvable code.
  "Where it is shown" still stands as planned and is not built: neither `/v1/login`, `/v1/sessions`, `hana_status`
  nor the popup carries a Support ID yet.
- **Amended 2026-11-05 (confirmed by the user, "yes go ahead with C15"; built on `feat/batch-c-15`, D394–D397):** the
  design C15 builds, replacing the recommendation above where they differ:
  1. **Code → user** is the wallet directory: `end_users.support_code` (indexed), or `token_sub` / `user_id` when staff
     hold the User ID or the internal id. No `uid` column in the issuer (`user_email_apps.uid`), no `IssuerRpc.uid`,
     no `DirectoryRpc.byUid`. Where an email is shown, the join is by provider and sub (`end_user_identities` → the
     issuer's `user_emails`), as `user:find --user` and the C8b screen do. Every match is listed (40-bit collisions;
     the partner's app tells them apart). The code is taken in any case, with or without `HANA-` and dashes
     (console-core `parseSupportId`, the CLI's parser).
  2. **What a lookup shows**: the user's ids, identities and wallets (the directory); the scope's apps; the ledger's
     ok `login`, `session` and `derive` events by uid (Neon; the indexes are 0007's, D362, so no migration); the vault
     shares that haven't expired (`AdminRpc.userShares`, built, and the lookup's own read); errors by the request IDs
     the partner gives (the ledger keeps uids only on ok events, by design); the apps' `app_changes`. Not consents.
  3. **Where users see it**: `supportId` beside the session in the `/v1/login` and `/v1/sessions` answers (additive),
     the same derivation as the stored code (D395); the vault's `hana_status` (`hana.supportId`, for SDK 0.2.0 or
     later, D393) and the approval popup's account line (the popup's only account view).
  4. **Partners**: the code only (their Users page shows it, D310); no partner lookup in batch C; no address or sub.
  5. **Erasure**: `uid-erase` (D361) removes everything the lookup reads for the account (its directory rows, so the
     code resolves to nothing, and its uids in the ledger; `scripts/test/uid-erase.test.ts`); no `user:erase`. Vault
     shares and app changes aren't per-user records the erasure keeps: shares expire within a day and the lookup
     reaches them only through the directory row.

## Dev env email limits, 2026-11-04

### D340. Dev envs (`local*`, `sandbox*`) get higher per-mailbox and per-IP email code limits; production keeps D198's
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: "yes raise limits for dev environments please, as we
  will be testing a lot and testnet don't really cost us money anyway") · Built on `fix/dev-email-limits` · Amends D198
  (its numbers are now production's)
- Decision: the email issuer picks its limit set from `ENV_NAME` with `isDevEnv` (`@hana-id/env`: `local*`,
  `sandbox*`), once per request (`limitsFor` in `apps/email-issuer/src/limits.ts`). Every other name gets production's,
  which are exactly D198's. Dev values (production in brackets):
  - per (mailbox, requester) code mails: 20 per 15 min (3), 100 a day (10);
  - per mailbox code mails: 30 per 15 min (10), 200 a day (30);
  - challenges per mailbox a UTC day: 250 (35); live challenges at once: 20 (5), chosen so one tester's abandoned
    starts never meet the live cap before the per-requester 15-min code limit;
  - wrong codes per (mailbox, requester): 30 an hour (10) before the 1 h lock;
  - failed checks per mailbox a UTC day: ceiling 100 (25), backstop 80 (18), owner slot 17 (4), ticket slot 3 (3). The
    ceiling stays the sum of its three slots, so the owner slot still works past the backstop, and the requester lock
    (30) still trips before the backstop (80);
  - per IP: `start` 30 per 10 min (10) and 300 a day (50); `resend` 30 per 10 min (10); `verify` 90 per 10 min (30).
- Unchanged in every env: the aggregate prefix limits, the recipient-domain cap (it protects Hana's sending
  reputation), the ticket and grant allowances (the grant slot too), the google-match and google-record limits, the
  webhook and staff limits, the budget and its pools, `confirm`'s per-IP bound (production's 10 per 10 min: a staff
  unsuppress's mailed link, not the login flow), and each challenge's own 5 attempts and 2 resends.
- How it applies to existing counters: the mailbox object gets the set with every call (none: production's). Its
  counters are keyed by window name and start, never by max, and both sets use the same names and windows, so a
  sandbox-dev mailbox over production's numbers but under the dev ones passes at once, with no reset. A requester's
  wrong-code lock is keyed by the max that set it (production's keeps its `lock:<ip>` key), so a lock set at
  production's 10 doesn't hold under the dev set.
- Why: sandbox-dev is testnet, used by Hana's own testers many times a day; D198's numbers were sized against an
  attacker on a mainnet mailbox and blocked repeat testing. The name rule (not a manifest flag) means no setting can turn
  them on in a production env, as for the other dev-only privileges.
- Main trade-off: on a dev env, a 6-digit code can be guessed with 100 failed checks a day instead of 25 (≈ 3.7% a year
  instead of ≈ 0.9%). Testnet accounts hold no real funds.
- Alternatives: (a) a manifest field for the limits: it could be set in a production env by mistake. Not recommended.
  (b) Resetting the counters on sandbox-dev (rotating K_rl): a one-off that also drops device tickets and recurs at the
  next busy day. Not recommended.
- Amended 2026-11-04 (same day, `fix/dev-ticket-limits`): a ticketed start (a device that signed in before) never
  falls back to the code limits, so its own allowance (production 3 a day per address, 9 per mailbox) blocked the
  user's testing first; dev envs raise it to 100 and 300. Production unchanged.

## A cancel on Google's sign-in screen (branch `fix/google-cancel-back-to-chooser`), 2026-11-04

### D341. Cancelling Google's sign-in screen goes back to Hana's method chooser; closing the popup there is `login_cancelled`
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04: "yes" to "the popup goes back to Hana's method chooser
  … the partner app gets `login_cancelled`, … `google_error` stays for real Google failures") · Built on
  `fix/google-cancel-back-to-chooser` (`packages/web/src/auth/callback-page.ts` `goBack`, `toSlot`;
  `auth/email-page.ts` `showChooser`, `restartGoogle`, `chooseEmail`, `onPageHide`; `auth/login-storage.ts`
  `slot`, `back`, `offer`, `cancelled`; `auth/login-page.ts` (the record-only login's email context);
  `vault/login.ts` `readRelay`; `auth/google.ts` `GOOGLE_CANCEL`, `GOOGLE_CANCELLED_RELAY_ERROR`) · Source: the user's
  report (Cancel on Google's screen showed "Sign-in stopped … Code: google_error" at `/login/email#…`) · Amends D264,
  D270 and D273 (a cancel ended the Google login with `google_error`, `access_denied`)
- Decision:
  - Under token_first, when Google answers `error=access_denied` to the login's first request (from the chooser, from
    `/login` directly, or from case B's Google step on `/login/email`) or to D273's interactive retry, the callback
    relays nothing. The vault's wait goes on under the login's own 5-minute limit (`LOGIN_PENDING_MS`). The popup goes
    back to the screen the Google step came from, on `/login/email#<relayId>`: Hana's method chooser with the line
    "Google sign-in was cancelled." and the app's methods (Continue with Google; Continue with email when the app
    offers it: a Google-only app's chooser has Google only), or case B's own choices (Link and continue when the
    issuer offered it, Sign in with Google, Cancel) with the same line.
  - Google again is a fresh attempt: a new random OAuth `state` whose login entry names the login's relay slot
    (`slot`), with the login's nonce and the same binding checks; the ID leg reuses that attempt's state. The cancelled
    attempt's state never finds an entry again. Between the two, the login's keys are parked under the slot
    (`cancelled`, never usable by a Google answer: refused as an expired sign-in) and the email page takes them into
    memory on load. Case B's Google step always uses such a fresh state under token_first. After a cancelled D273
    retry, Google again is that retry once more (the same account, `login_hint`, no chooser): slot 1 already holds
    that account's access token and a relay slot takes one write.
  - Email from the chooser is the email step in place (the login's entry back under its slot).
  - Closing the popup on that screen (`pagehide` when the page didn't navigate on itself) writes `{error:
    'google_cancelled'}`, encrypted when the screen was shown and sent with `keepalive`, to the login's slot; the vault
    ends the login with `login_cancelled` (only in a login with the follow-up key, the token_first ones). The keys are
    zeroed and the email context dropped, so a reload shows an expired sign-in. Case B's Cancel there relays
    `email_cancelled` as before (`login_cancelled`).
  - `google_error` stays for Google's real failures: any other error code, `invalid_response`, the tokeninfo stops,
    `google_account_mismatch`, a second failure of the D273 retry, the silent ID request's errors (no screen was
    shown). A cancel is still relayed as `access_denied` (`google_error`) where there is no screen to go back to: no
    email context stored, a login without the follow-up key (an env without an email issuer, batch B's request), and
    the record-only fallback's openid request when tokeninfo couldn't answer.
- Why: the user cancelling Google's screen is a choice, not a failure. Ending the login with a stop screen and a
  code made them start again from the app; Hana's own chooser lets them pick again in the same window. A partner's
  "cancelled" handling is `login_cancelled`, the code a close or `cancelLogin()` already gives.
- Main trade-off: the close relies on `pagehide` (every desktop browser fires it on close, and the e2e checks it in
  Chromium, Firefox and WebKit); where it doesn't fire (a crashed or killed browser, some mobile cases) the partner
  gets the login's `login_timeout` after 5 minutes, as before for any abandoned popup.
- Alternatives: (a) relay the cancel and let the vault end the login with `login_cancelled` at once: the user loses
  the chance to pick again in the window. Not recommended. (b) Reuse the login's slot as the OAuth `state` for every
  attempt: simpler, but a cancelled attempt's state would find an entry again. Not recommended. (c) A Cancel button
  on the chooser: not asked; the original chooser has none and closing the window is the way out. Not done.
- The login's limit still applies: the screen stops at the email step's deadline (`EMAIL_STEP_LIMIT_MS`, 15 s before
  the vault's), and Google or email picked after it starts nothing. Once the vault has ended the login (its limit, a
  newer login, `cancelLogin()`), its reads of the slot have stopped (`fix/abandoned-login-freeze`'s abort-aware
  `readSlot`), so a late `google_cancelled` lands in a slot nobody reads.
- Not changed then: closing the popup at other points (the email step, Google's own page, the follow-up screens) left
  the vault waiting until its limit (`login_timeout`, `data.stage: 'pending'`). Amended the same day by D347 (any close
  while the login waits on the popup is `login_cancelled`) and D348 (a `method: 'google'` login comes back to Google
  only).

### D347. Closing the login popup at any point ends the login within seconds with `login_cancelled`
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04, "yes") · Built on `fix/google-cancel-back-to-chooser`
  (`packages/web/src/vault/login.ts` `PopupTask.watchPopup`, `popupWait`, `POPUP_WATCH`; `vault/vault.ts`;
  `auth/callback-page.ts` `signalVault`; `auth/login-page.ts`, `auth/email-page.ts` `tellVault`; core `hana:auth-progress`
  stages `relayed` and `back`) · Amends D341 ("closing the popup at other points still leaves the vault waiting") and
  the partner guide's "An unfinished login" (a closed popup was `login_timeout` after 5 minutes)
- The signal: the vault's own handle on the popup window (the hello's `event.source`, partner and vault mode alike),
  read every 250 ms. It stays valid across the popup's navigations because Hana's auth pages send no
  Cross-Origin-Opener-Policy and Google's sign-in pages send it report-only (checked with `curl` on 2026-11-04 for the
  authorization endpoint, the identifier and account-chooser pages: `cross-origin-opener-policy-report-only:
  same-origin`; only Google's OAuth error page enforces `same-origin`). `pagehide` alone can't be the signal (it fires
  on every navigation, and no Hana code runs on Google's page); the SDK's handle isn't used after the popup connected,
  as before.
- Decision:
  - The popup tells the vault what the handle can't: every Hana page posts `hana:auth-progress` `google` before it
    navigates to Google; the callback posts `back` as it loads (it still has its opener, so that trip switched no
    browsing context group); a page that closes itself after relaying (the callback, the email step) posts `relayed`
    first. The callback doesn't know the vault frame's name, so it posts to the opener and each of its frames with
    `vaultOrigin` as the target origin; the vault takes the signal only from the popup it answered.
  - A close while the login waits on the popup (its first slot, a follow-up screen's answer, a link task's slots) ends
    it after a 1 s grace with `login_cancelled`, `data.reason: 'popup_closed'`: the login aborts (the freeze fix's
    abort-aware relay reads stop), its keys are dropped, and a later write to its slots is never read. The grace lets
    an answer the popup wrote just before it closed itself win even if `relayed` was lost.
  - A close while the vault works alone (google-match, the chain) lets the login finish; a later wait on the popup
    then ends at once.
  - A close within 8 s of a `google` signal, before `back`, is taken for an IdP's COOP switching the popup's browsing
    context group (the opener's handle then reads closed while the window is open: the spec makes the two
    indistinguishable). The watch stops for the rest of that login, which falls back to its 5-minute limit and to
    D341's own close report on the screen after a cancel.
- Why: Privy-like behaviour; a closed popup is the user's cancel, and a partner waiting 5 minutes for `login_timeout`
  can't tell the user anything meanwhile.
- Main trade-off: a user who closes the popup within 8 s of reaching Google's page gets the 5-minute
  `login_timeout`, not `login_cancelled`. The alternative is a false cancel of every login if Google starts enforcing
  COOP on its sign-in pages (it reports violations today). If Google switches to an enforcing policy on a later page
  (after the 8 s), a login would be cancelled while the user is still at Google: the watch's assumption to recheck
  before each release, with `coop-canary <env>` (D386; it replaced `curl -sI` on the authorization URL).
- Alternatives: (a) the SDK polling its own handle after connect: the same handle semantics, with one more hop. Not
  done. (b) The popup reporting its own close on every page (`pagehide` with a pre-encrypted relay write, as D341's
  screen does): it can't cover Google's page, and slot writes are single use. Kept only for D341's screen. (c) A
  heartbeat through the API: no Hana code runs on Google's page either. Not recommended.
- Amended 2026-11-05 by D398: a close within the 8 s still stops the watch, but the login then waits 90 s for the
  popup's answer and ends with `login_cancelled` (`popup_closed`) without one, rather than waiting for its 5-minute
  limit.
- Amended 2026-11-05 by D400: a page that posts `google` or `relayed` navigates or closes only once the vault acked
  it (`hana:auth-progress-ack`), or after 150 ms; Chromium delivered a signal posted in the navigation's own task with
  a null `event.source`, which the vault can't take.

### D348. After a cancel, a login the partner restricted to Google comes back to Google only
- Date 2026-11-04 · Status: confirmed by the user (2026-11-04, "yes") · Built on `fix/google-cancel-back-to-chooser`
  (`packages/web/src/auth/email-storage.ts` `EmailContext.method`, `auth/login-page.ts`, `auth/email-page.ts`
  `showChooser`) · Amends D341 (its chooser offered the app's methods whatever the partner asked)
- Decision: `/login` keeps the method the partner named (`hana.login({method})`) in the email context. When a login
  started with `method: 'google'` is cancelled on Google's screen, the screen it goes back to offers **Continue with
  Google** only, even in an app with email login; **Continue with email** appears only when the partner didn't
  restrict the method. Closing the popup there is `login_cancelled` as before.
- Why: a partner that names Google has its own sign-in choices (often a separate email button); offering email in
  Hana's popup would override that choice.
- Alternatives: (a) the app's full chooser (D341 as built): it ignores the partner's `method`. Not recommended.

