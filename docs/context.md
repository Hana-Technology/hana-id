# Context — how Hana ID works and what's been decided

Carried over from the design conversation in wend-widget-demo (Oct 2026). Plan doc:
https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi · Login journey diagrams: https://claude.ai/artifact/73xpB7AZknWd9s38xw4Fjo ·
SDK security page: https://claude.ai/artifact/AwzpW8xZ7pAuMoTYgBfcvo

## How a login works (from the wend-widget-demo PoC, see `legacy/`)

1. The browser makes a non-extractable WebCrypto Ed25519 **session key**.
2. Google Sign-In is started with a nonce that commits to that session key (PoC:
   `b64url(sha256(sessionPubKey ‖ expiry u64 LE ‖ salt))`; batch A.2 layout in `docs/batch-a2-shared-client.md`), so
   Google's signed ID token commits to that session key.
3. The relayer submits `hana-signer.create_session(jwt, scope_id, …)`. The contract verifies the RS256 token against
   Google's keys stored on-chain, resolves the scope from `aud` (or, for a shared client, from `scope_id`), recomputes
   the nonce, and records a session whose `path` names the user's key.
4. The browser makes a BLS12-381 keypair and asks (session-key-signed, counter = previous + 1) for
   `derive_key(pk1, pk2)`. The contract calls the NEAR MPC's `request_app_private_key` (CKD, domain 2) with that path.
5. The MPC (17 nodes, threshold 11, TEEs) returns `big_y = y·G1`, `big_c = msk·H + y·a·G1`. Only the browser knows
   `a`: it computes `S = C − a·Y`, checks `e(H, PK) = e(S, G2)` against the pinned MPC key, then HKDFs chain keys.
   `app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ signer account ‖ "," ‖ path)`.
6. Signing is then local (~0.25 ms). Login median ~6.2 s. One `derive_key` ≈ 18.85 Tgas, 0.0018 NEAR.

The key is a function of: MPC network, signer account, path (`scope#provider#sub#key_index`), local derivation
(HKDF salt, chain derivation). Change any → different addresses ("address freeze" happens when final accounts deploy).

## How a login works since batch B (`docs/batch-b-spec.md`)

The same chain steps, moved off the partner page. A hidden iframe on Hana's `vaultOrigin` makes the session key, the
A.2 nonce (over the pinned signer and the app's scope) and the BLS key; the partner page only opens a popup on
Hana's `authOrigin` in its click handler. The popup checks the vault's values against `GET /v1/app`, runs Google's
openid-only implicit flow (redirect to `{authOrigin}/login/callback`) and hands the token back to the vault through
an end-to-end encrypted, read-once relay slot on the API. The vault checks the token, fixes the path
`scope#google#sub#0` itself and sends one transaction, `create_session_and_derive` (`POST /v1/login`). It decrypts
the CKD, keeps only PRK (derivation v1, below) and signs after an Approve click in a Hana popup, or under an
auto-approve policy the user accepted. In `'session'` mode a reload unlocks a PRK record in the vault's IndexedDB
with a key share the API holds (`POST /v1/vault/unlock`): no chain call. Partners use `createHana` from
`@hana-id/web` (guide: `docs/integration.md`).

## Decisions

- Name: repo `hana-id`, product **Hana ID**. npm `@hana` is taken; `@hana-id` looked free (claim it).
- CKD only (no per-transaction MPC signing). Key index in the path for rotation after a leak.
- Per-partner **scope** chosen by the token's `(provider, aud)` via an on-chain registry inside `hana-signer`, so one
  app can't derive another app's users' keys. One scope can hold several client IDs (web/iOS/Android).
- Self-serve later: client-ID ownership proven by an ID token for that client; adding clients is owner-only and
  timelocked; Hana can't move clients or block derivation for a scope with its own client (suspension is API-side
  only; a shared-only scope stops when Hana removes the shared clients, D12). Owners: NEAR account or Google
  identity. `public_registration` is off until client-ownership proofs are solved (Hana registers apps).
- App config off-chain in Cloudflare D1; API on Cloudflare Workers + Durable Objects (nonce serialisation per relayer
  key). Chosen for built-in DDoS/rate limiting, free tier, no DB credentials.
- Throwaway accounts first; every account name in `envs/<env>.json`.
- Email login later: whoever signs email tokens can derive any email user's key — needs its own trust decision.
  Batch A makes the verifier provider-generic so email can be another issuer.
- **Target: a production MVP** — real users and real funds on mainnet, built to production standards throughout.
  Path: testnet pilot (batches A, A.2, B + testnet smoke test) → production MVP (final accounts + address freeze,
  external audit, upgrade governance, mainnet MPC, key export/rotation, monitoring, legal + Google brand verification).
- **Any app can integrate**; nothing is customer-specific. Sodax is the first customer (Stellar via
  `IStellarWalletProvider`): its adapter is a thin optional package, the core SDK exposes standard interfaces
  (EIP-1193, Stellar Wallets Kit, raw sign). Pilot wallets on testnet-MPC keys are disposable.

## Batch A.2 decisions (2026-10-26; details in `docs/batch-a2-shared-client.md`)

- **Shared client mode.** Besides its own Google client (scope from the token's `aud`), an app can log in through
  Hana's shared Google client(s) (`sharedGoogleClientIds`, `set_shared_clients`, max 5). Then `aud` is Hana's, so the
  scope comes from the session nonce, which commits to `scope_id`; the scope must have `allow_shared`. Hana's vault
  (batch B) computes the nonce for scope X only for a parent page whose origin app X allows, and the login page only
  relays it after checking it against `GET /v1/app` (batch B amended this: A.2 had the login page compute it). Forging
  a nonce only gets the forger their own key. The path has no client ID, so own and shared logins give the same
  address: Google's `sub` matched across clients of one project (2026-10-27) and of two projects (2026-10-28, D42). A
  client is shared or a scope's own, never both; adding a shared client and enabling `allow_shared` are timelocked,
  removing / `disable_shared_login` are immediate. Shared-only scopes trust every shared client Hana adds (see the
  security notes in `docs/contract-interface.md`).
- **Two relayer key pools.** Session pool (`RELAYER_KEYS`: create_session, derive_key, revoke_session, prune_sessions;
  batch B adds create_session_and_derive and later drops one of the two create methods, see "Relayer allowlists" in
  `docs/batch-b-spec.md`) and owner pool (`OWNER_RELAYER_KEYS`, small allowance: owner actions, register_scope,
  apply_pending_config), separate keys and Durable Objects, so abuse of `/v1/owner-actions` can't stop logins.
  deploy-contract treats a key with the wrong receiver, methods, an empty method list or an unlimited/too-large
  allowance as a blocker. Gas is per method (`apps/api/src/gas.ts`, to measure on testnet; register_scope scales with
  its proof count, 10 proofs burnt 175 Tgas in the sandbox).
- **Layouts.** Every nonce commits to the signer account id (`env::current_account_id()`), so tokens can't be
  replayed across deployments; the session nonce also commits to `scope_id` and `max_uses`; the register proof to
  the client list and `allow_shared`; strings are borsh length-prefixed. Session messages are
  `"hana-id-session-v1:" ‖ counter ‖ sha256(payload)`. Layouts are checked against an independent JS implementation
  (`gen-fixtures.mjs`) and in the sandbox (`contracts/integration-tests/tests/layouts.rs`).
- **API verifies before relaying**: RS256 + claims + nonce for `/v1/sessions` (JWKS cached, stale up to 6 h if
  Google is down), Ed25519 session signatures for derive/revoke, the scope check, and `session_key_in_use` (also
  covers revoked, unexpired sessions) so replays aren't paid for. `GET /v1/app` tells the SDK own vs shared mode.
- **Retired shared clients.** A client dropped from the shared list can never join a scope (it may return to the
  shared list).
- **Fresh deploy only.** The contract state layout changed (config, `Scope.allow_shared`, quarantine reservations,
  pending-add counts): deploy a new signer, don't upgrade a batch A one. `execute_change` bumps `action_nonce`.

## Batch B decisions (2026-10-27/28; spec `docs/batch-b-spec.md`)

**Confirmed by the user:**

- **The wallet survives reloads through a server-held share** (Privy-like). Per-app `persistence`, `'session'`
  (default) or `'none'`. In `'session'` mode the on-chain session has `max_uses = 1` and is used up by the login, so
  the session key kept in the vault's IndexedDB can never derive again. A reload needs the API's share `K_s` (idle
  2 h, absolute 12 h by default, revocable) to decrypt PRK: no chain call, no gas.
- **Approval in a Hana popup by default; auto-approve only under a policy the user accepted.** The app owner sets a
  policy (allowed contracts and functions, address rule, limits). It applies after a delay, and each user accepts that
  exact policy (`policyId`) once in a Hana popup. Batch B covers typed calls only. It ships no protocol decoder, so
  Sodax swaps, bridges and hub actions always get the popup (D24). Raw signing, `personal_sign`, SEP-53 messages and
  contract creation are never auto-approved. The silent `app_signed` raw mode is out of the MVP (D48).
- **Google Workspace accounts are allowed**: the spike found no `hd` claim with `scope=openid` (below).
- **One transaction per login**, `create_session_and_derive`, with a ship gate: if the 10-run testnet median saves
  less than 1.5 s, the method is removed before the audit and the split flow (`/v1/sessions` + `/v1/derive`) stays.
- **Derivation v1** (`@hana-id/core/derivation`): HKDF-Extract with salt `hana-id/chain-keys/v1/extract` to PRK, then
  HKDF-Expand per borsh tuple `("hana-id/chain-keys/v1/expand", namespace, curve, account)`: `("stellar", "ed25519",
  0)` as the Ed25519 seed, and `("eip155", "secp256k1", 0)` as 48 bytes reduced with `mapHashToField`. Frozen vectors
  and a SHA-256 guard live in `packages/core/test/vectors/derivation-v1.json`. There is no global recovery phrase.
  Export is one raw key per chain (SEP-23 `S…`, `0x` hex), from a fresh login in a top-level Hana window.
  **Address-changing:** v1 replaced the PROVISIONAL HKDF (salt `hana-embed-ckd-v1`), so every earlier sandbox-dev
  address changed. That is allowed before the address freeze, and testnet wallets are disposable. Nothing else in
  batch B changes an address.

**Confirmed 2026-10-28 with the defaults the user approved** (the spec's Decisions and R1–R13, D47; D51): two Hana
origins (`vaultOrigin` for the key iframe, `authOrigin` for the login, approval and export popups); the token returns
only through the encrypted relay; the vault computes the nonce and the path itself and pins `signer`, `relayer` and
the CKD key per env build; a claim allow-list (`iss azp aud sub iat exp nonce nbf jti auth_time`, else
`token_has_pii`) on API-relayed tokens (the contract ignores extra claims); dev-only privileges (loopback partner
origins, partner-origin `/v1/sessions`/`/v1/derive`/`/v1/sessions/revoke`) tied to `local*`/`sandbox*` env names;
`pk_test_` and `pk_live_` apps never share a scope; `key_index ≥ 2^31` reserved, MVP fixed at 0.

**Decided while building (2026-10-28)** (with a D-number where `docs/decisions.md` records it):

- sandbox-dev's Hana origins (step 0) are two thin `workers.dev` Workers on the API's subdomain:
  `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` and `https://hana-id-auth-sandbox-dev.tingtc.workers.dev`
  (`apps/api` "Page Workers"). They are one site (`tingtc.workers.dev` is the registrable domain), so the manifest
  schema refuses same-site Hana origins only outside `local*`/`sandbox*` envs. The spec's "two `workers.dev`
  hostnames are separate sites" holds only across account subdomains. One thin Worker per origin (D66); production
  needs two Hana-owned registrable domains (D38; names open, Q15).
- The Approve guard arms per input (user decision 2026-10-28, `docs/decisions.md` D36): a mouse `pointermove`, a
  touch or pen `pointerdown`, or Tab/arrow keys (never Enter or Space), and the arming gesture itself never approves.
- A signing call from a user's click opens the approval popup in that click, like login (user decision 2026-10-29,
  D99: `/approve?from=partner&v=<vault frame>`, found and authenticated like the login popup); the vault's "Review in
  Hana" launcher is only the fallback (no user activation, or Safari blocking `window.open` after an await). An
  auto-approved or refused request closes that popup before it shows anything. `hana.prepareApproval()` opens it
  early for a handler that awaits first.
- Auto-approve policies gain a required per-chain `maxFeeWei` (gas × fee cap), because the SDK fills EVM fees on the
  partner page; the fee also counts with the value against `maxValueWei` and `maxValueWeiPerDay` (D37; a rule needs
  `maxValueWei ≥ maxFeeWei`, D69). `string`, `bytes20`–`bytes32` and 160-bit integer arguments count as opaque like
  `bytes`, and opaque arguments need a protocol decoder under either `addressArgs` rule. Function names that move
  value are matched by prefix and substring (`transferAndCall`, `permit…`, `set_admin`), and execute/multicall-style
  names can't have `'any'` (D37, D63).
- The approval digest binds a network context only where the request has one (D35): the passphrase for Stellar
  transactions and auth entries, the chain ID for EVM transactions, and an empty context for messages,
  `personal_sign`, EIP-712 (its domain carries `chainId`) and raw. The vault never learns the dapp's selected EVM
  chain.
- The consent digest (`hana-id/auto-approve-consent/v1`) binds the request id, `policyId`, the parent origin and the
  end time the user agrees to. An open vault re-reads the policy in force (`GET /v1/app` now returns
  `autoApprovePolicy`) every 60 s while logged in, and before an auto-sign if the last check is 10 s old or more. A
  removed or changed policy stops auto-approval within 10 s, without a reload (D62); raw signing's `'off'` likewise
  (`rawSign`, D68).
- Logout is app-wide on the device. Tabs end only on a `revoked` broadcast for their own share, so a stale tab can't
  end a newer session. At most 100 approvals wait at once (`4100 too_many_pending`).
- Export accepts a token without `auth_time` (Google sends none, even with `max_age=0`; D27). One that has it must be
  under 5 min old.
- The partner client adds `cancelLogin()`, `requestAutoApprove()`, `autoApproveStatus()`, `revokeAutoApprove()`,
  `prepareApproval()` (D99), `destroy()` and the `loginProgress`, `autoApproved` and `launcher` events to the spec's list. It logs a console
  warning when Google Identity Services is on the page or the browser is an in-app webview. A report-only CSP
  violation doesn't fail the handshake; only an enforced one does.

### Google openid-only spike (2026-10-28, `apps/smoke/spike.html`, Chrome)

- With `scope=openid` (implicit flow, `response_type=id_token`), a personal and a Workspace account both got exactly
  `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no email, name or picture, and no `hd`. The allow-list was fixed
  from this.
- `max_age=0` returned no `auth_time` (Q33, D27). Export relies on a fresh login plus a typed confirmation.
- The popup kept `window.opener` through Google's pages in Chrome (Safari untested). The token still comes back only
  through the relay (R2).
- Cross-project `sub` (2026-10-28, a Workspace and a personal account): each account signed in through the shared
  client (project `875896…`) and a client in a second Cloud project (`596419…`) got the same `sub` (fingerprint
  match). The path has no client ID, so moving a scope from the shared client to a Hana-held branded client keeps its
  users' addresses (D42).

### Batch B status (2026-10-28)

Merged on the integration branch `feat/batch-b` (not yet on `develop`), all tests passing, and **not deployed**:

- Contract: `create_session_and_derive`, the `key_index < 2^31` bound, the mock MPC failure switch; unit and sandbox
  tests (`docs/contract-interface.md` "Changed in batch B").
- `@hana-id/core`: layouts, CKD, derivation v1 with vectors, export, signers, decoders, `normalizeTypedData`, the
  approval and consent digests, auto-approve validation and matching, the testnet allowlist (D39), Hana's verified
  contract list (D44), the ID-token check and allow-list, the protocol schemas.
- API: `POST /v1/login` with the export limit (D59), the `LoginRelay` Durable Object, the five vault endpoints,
  migration `0003_vault.sql`, the vault page and vault cron, API-side policy validation, the origin and dev-env rules,
  the page Workers for both Hana origins (D66), no cookies (D70), and the `gen` changes.
- `@hana-id/web`: the vault (registry check at login D56, in-memory idle limit D55, `rawSign` re-read D68, test-app
  refusals D39), the auth pages (`/login`, `/login/callback`, `/approve`, `/export`), per-env builds to
  `packages/web/dist/pages/<env>/{vault,auth}`, `createHana` with the EIP-1193 provider (EIP-6963), the Stellar
  signer and the Stellar Wallets Kit module.
- `@hana-id/react`: `HanaProvider`, `useHana`, `useWallet`. `@hana-id/sodax`: the Stellar and EVM wallet-provider
  adapters (Stellar signs as `rawTx.from`, D67), with `hana.ethereum.chainIds` in `@hana-id/web` for them.
- `apps/smoke` on the vault (the spec's step 7): `/` logs in through `@hana-id/web`, `/direct.html` keeps the split
  flow for the ship gate (`apps/smoke/README.md`).
- `apps/e2e`: the Playwright suite (Chromium, WebKit, Firefox) against local builds and the real `apps/api` Worker,
  with its CI job. Its live mode (a second e2e env on routed https origins) runs `pk_live_` apps, so the raw approval
  popup is browser-tested too.
- Scripts: `admin app:settings` for the per-app settings, `vault-kek` (`init`/`put`/`rotate`, D54), session-pool
  allowlist state 1 in `deploy-contract`. `.github/CODEOWNERS` (D58).
- Docs: the reference docs (`docs/README.md`), including `docs/integration.md` (partner guide).

SDK packaging (`feat/sdk-packaging`, D71, D72): the four packages build to ESM + `.d.ts` and install from `pnpm pack`
tarballs outside the repo (`pnpm run pack:check`, CI job `packages`); `@hana-id/web` carries the `sandbox-dev` env.
Not published: the registry (public npm `@hana-id` org or private) and the licence are the user's to decide
(`docs/operations.md` "Releasing the SDK packages"). **To measure on
testnet** after the deploy, and record here: the ship gate (10 runs of `create_session_and_derive`: gas over all
receipts and the latency median, D26), unlock latency from SIN with the page render, the login's registry-check wait
(`timings.scopeCheck`/`scopeWait`, D56), the BLS precheck's Worker CPU time (D64, before `BLS_PRECHECK` is on
anywhere), one forced MPC-side failure (Q11), and Safari/WebKit retention of partitioned IndexedDB (Q4). The
cross-project `sub` test passed (spike above, D42). After the smoke run on the vault (the spec's step 7):
`REJECT_PII_ON_SESSIONS = "1"` and session-key rotation to allowlist state 2 (gate passes) or 3 (gate fails).

## Batch C decisions (2026-10-27; spec `docs/batch-c-spec.md`, draft)

- **Developer dashboard, like Privy's.** Partners manage orgs, members, apps, origins, keys and on-chain owner actions
  (`/v1/owner-actions` with a console-client token). Replaces `admin app:*` after the pilot.
- **Invite-only.** No public sign-up: a Hana admin issues email-bound, single-use, expiring invites (stored hashed);
  sign-in with Google through the console client; no accepted invite → refused. `public_registration` stays off. Amended
  2026-10-29 (D89): owners also invite teammates; a new owner waits 24 h as a viewer.
- **Hana admin console**, separate, behind Cloudflare Access. Contract-billing reports per org/app by day and month
  (logins, derives, monthly active users, new users, gas burnt + USD, failures, latency), CSV statement. Billing-grade
  totals in D1 (Analytics Engine keeps 3 months: operational metrics only).
- **Billing on hold** (no Stripe/plans yet). Sodax is billed by service contract from the monthly statement.
- **Allowed origins are security-critical** in shared-login mode: changes need a fresh sign-in, are logged and email
  the other owners, and take effect after 24 h with a cancel (D32, D34).
- **Infra stays Cloudflare** (review in the plan doc, 2026-10-27): cheapest at every volume, DDoS included, no OS,
  Durable Objects fit the nonce design. Infra is <1% of running cost; NEAR gas (~38 Tgas ≈ $0.02 per login) is the
  bill, so cut on-chain calls per login (batch B: keep the key across reloads). AWS KMS later only for HSM-grade keys
  (email issuer). Revisit at D1 ~5 GB, an HSM/region requirement, or ~500 req/s per app.

## Batch B on sandbox-dev: first logins (2026-10-29, Smoke B, shared client, Chrome, Malaysia)

Batch B deployed 2026-10-29 (contract upgrade, migration 0003, `VAULT_KEK` key id 1, API and both page Workers).
Every run, one-transaction and two-transaction, gave the same Stellar and EVM addresses.

| Median, excluding Google | One transaction (vault, 6 runs) | Two transactions (direct page, 5 runs) |
|---|---|---|
| Chain | 7.95 s (6.9–10.4) | 9.12 s (8.6–9.4; one outlier 19.3 s) |
| Login without Google | 9.67 s | 9.15 s |

- Ship gate (Q10): the combined call saves ≈ 1.2 s on chain, under the 1.5 s bar. Not decided on 11 runs; repeat
  with ~10 interleaved runs each.
- The vault login spends ≈ 1.7 s outside Google and the chain (popup ≈ 0.25 s; the rest not yet attributed); the
  direct page ≈ 0.03 s. The registry scope check (D49) took ≈ 0.5 s, fully overlapped (wait 0 ms).
- Reload unlock: 3.0 s (target < 1 s); no stage breakdown yet.
- **Instrumented (branch `perf/vault-timings-impl`, not yet measured):** `pk_test_` logins and unlocks now report
  consecutive stages that add up to the smoke page's total with `other` (`apps/smoke/README.md` "Timings"), plus the
  API's own time for `/v1/login`, `/v1/vault/shares` and `/v1/vault/unlock` (`docs/api.md` "Timings"). Suspects from
  the code, to confirm with those numbers: the login's unattributed time is mostly `persist`, a serial
  `POST /v1/vault/shares` after the chain (vault gate: 2 D1 queries + 2 limiter objects; settings; a fresh
  `get_session` read that retries every 300 ms while the RPC lags `/v1/login`'s optimistic answer; the D1 insert);
  the callback's relay POST goes to a new URL every login, so its CORS preflight is never cached (one more round trip
  inside `google`); a reload is the vault page (`no-store`, 3 serial D1 reads behind the page Worker), `/vault.js`
  revalidated each load (Workers assets default `max-age=0`, not content-hashed), then `POST /v1/vault/unlock` with
  ~5 serial D1 queries and 3 limiter objects (2 placed in `apac`), each round trip longer when `workers.dev` routes
  Malaysia to a US/EU colo.

## After the latency fixes D77–D79 (2026-10-29 afternoon, 5 + 5 interleaved, same account, Chrome, Malaysia)

| Median (range) | One transaction (vault) | Two transactions (direct) |
|---|---|---|
| Chain | 7.86 s (6.87–8.75) | 10.56 s (9.97–11.46) |
| Login without Google | 11.18 s | 10.65 s |
| … also without Google's redirect back | **9.50 s** | (inside its Google time) |

- `authCheck` 1.05 s → 0 s (D77) and the share save is off the login path (D79); every login kept `persistence:
  session`. The vault login is now faster than the split flow once Google's own redirect is excluded.
- Network legs were slower this session across the board (direct chain +0.7 s, popup 0.66 s vs 0.32 s, callback
  boot 0.47 s vs 0.17 s, API gate 0.79 s vs 0.28 s), so absolute numbers aren't comparable with the morning's.
- Reload unlock **regressed to 2.0–3.0 s** (morning 0.86–0.87 s warm): vault page 0.43 s and script 0.21 s, unlock
  call 1.49 s with server 1.04 s (gate 0.43, share 0.35, counter 0.18). Every D1-bound phase was 2–3× the morning's,
  which points at slower routing or D1 access this session rather than the code (the D78 app cache doesn't help the
  first request in an isolate). To check: the request logs' `colo` for these unlocks, a repeat at another time, D1
  read replicas, and the custom domain.

## Login timings with stage breakdown (2026-10-29, 10 + 10 interleaved, one account, Smoke B, Chrome, Malaysia)

| Median (range) | One transaction (vault) | Two transactions (direct) |
|---|---|---|
| Chain | **7.42 s** (6.71–7.94) | **9.86 s** (7.82–10.87) |
| Login without Google | 12.28 s | 9.93 s |

- **Ship gate (Q10): passed.** The combined call saves 2.44 s on chain at the median, over the 1.5 s bar. Keep
  `create_session_and_derive` (D76).
- The vault login's extra time outside the chain (≈ 4.9 s): `callbackRedirect` 2.47 s (Google's own redirects back
  to the callback; the direct page counts this inside its Google time, so both flows are at parity once it's moved),
  `authCheck` 1.05 s (the login page's serial `GET /v1/app` before going to Google), `persist` 0.48 s
  (`POST /v1/vault/shares` after login), `popup` 0.32 s, callback fetch and boot 0.23 s. `scopeCheck` 0.55 s stays
  fully overlapped. `/v1/login` server time 7.23 s, of which 5.82 s is waiting for the chain.
- **Reload unlock: 0.87 s warm** (856, 870 ms), **2.06 s** for the first after a while. Unlock call 0.66 s: server
  0.44 s (gate 0.24 s = key lookup and rate limiters, share 0.15 s, counter 0.05 s); vault page 0.13 s and script
  0.07 s.
- **Fixes (branch `perf/login-latency-impl`, 2026-10-29; not yet measured on sandbox-dev):** `/login` no longer calls
  `GET /v1/app` (D77; `authCheck` should drop from 1.05 s to a few ms), the vault replies before it makes the share
  and record (D79; the `persist` stage is gone, about 0.48 s), and the vault endpoints cache the app row for 30 s per
  isolate and ask the share limiter alongside the IP one (D78; a warm unlock skips the two D1 queries and one limiter
  round trip). Re-measure with Smoke B after the next deploy.

## Testnet measurements (sandbox-dev, 2026-10-27, real MPC)

| Call | Gas (all receipts) | Cost | Latency (median, API round trip) |
|---|---|---|---|
| `create_session` (5 runs) | 19.98–20.15 Tgas | 0.0020 NEAR | 4.3 s (3.6–8.6) |
| `derive_key` (9 runs) | 19.61–19.88 Tgas | 0.0019 NEAR | 7.1 s (6.0–8.4) |
| `revoke_session` | 2.68 Tgas | 0.00025 NEAR | |
| rejected `derive_key` (limit / replay) | 2.21 Tgas | 0.0002 NEAR | |

- A login is ~40 Tgas (~$0.021 at $5.29/NEAR). The PoC's 6.2 s was `derive_key` alone, not create + derive.
- **Latency work (branch `perf/api-latency`, 2026-10-27)**: before, create ~4.3 s and derive ~7.1 s (median); requests
  from Malaysia often ran in US/EU colos (free-plan `workers.dev` routing, also seen on a free custom zone), and the
  API made sequential chain reads and waited for finality. After (all via SIN, warm): create **2.5 s**, derive
  **6.0–6.7 s** (median 6.4 s), login ~8.9 s. Per-stage logs (warm): create = checks 0.2 s + relay 2.2 s (chain
  ~0.6 s); derive = relay ~6.0 s (MPC ~4.5 s on chain). Remaining levers: one transaction for create_session +
  derive_key (~2 s, contract change: batch B spec), ~0.2 s per relay inside the relayer key object (see next
  bullet), the 10 s session cache (a derive after it pays ~0.2 s), and Cloudflare routing (paid zone test pending a
  Hana domain).
- **Relayer key dispatch (branch `perf/relay-dispatch`, 2026-10-27)**: `relayDispatch` (~0.2 s) can't be the output
  gate: dispatch doesn't await the broadcast and the Workers clock only advances on I/O, so it is RPC reads (an object
  cold after its 70–140 s idle eviction, a block hash over 5 min old) or queueing. The output gate on the per-tx nonce
  write held the send_tx fetch itself, inside `relayOutcome`. Now: nonces are reserved 100 at a time (one confirmed
  write per 100 relays, safety argued in `relayer-key.ts`; a restart skips ≤ 99 nonces, which NEAR allows), and the
  request log splits the dispatch into `relayQueue` / `relayChainRead` / `relaySign` / `relayPersist`.
- **Relayer cold starts (branch `perf/relayer-cold-start`, 2026-10-27)**: measured with `relayInstance` in the
  request log, every relay of a quiet pool started a new object instance (idle Durable Objects are evicted after
  ~10 s; 3 keys round-robin), and the cold start read the nonce and block from chain (`relayChainRead` 0.22–0.58 s).
  Now a cold start trusts the stored nonce reservation (only that object sends with its key; a key used elsewhere is
  caught by InvalidNonce and one re-read) and the stored block hash while under 5 min old: no chain read. Each cold
  start still skips up to 99 nonces and writes one reservation (~3–30 ms).
- Function-call key allowances drop by gas **burnt**, not attached (refunds restore them): 3 × 2 NEAR covers ~1,500
  logins. Mainnet needs allowance monitoring and key rotation.
- Google `sub` is the same across the partner and shared clients (same Google Cloud project; across two projects too,
  2026-10-28, D42).
- Rejected derives (counter replayed, `max_uses` reached) cost ~2.2 Tgas each, and signed derive requests are public
  on-chain, so anyone can replay them. **Fixed (branch `fix/derive-precheck`, 2026-10-27)**: the API mirrors the
  contract's counter and `max_uses` rules (`apps/api/src/session-use.ts`) and refuses such derives and revokes
  off-chain (`409 counter_used` / `session_exhausted` / `counter_out_of_range`), confirming on a fresh `get_session`
  before refusing on a cached view; a request that might succeed (counter ahead of `used + 1`) is still relayed.
  Same-counter copies racing in different isolates can still reach the chain (all but one fail there).
- Attached gas defaults (`apps/api/src/gas.ts`: create_session 50, derive_key 60, revoke 20) have ample headroom;
  left unchanged.

## Known issues fixed by batch A (were in the PoC)

Global client-ID list (any listed app could derive every user's key) · sessions never pruned (storage grows forever) ·
relayer nonce collisions under concurrency · relayer had no app auth / rate limits · owner = contract account
hard-coded · NEAR Auth/FastAuth and per-tx signing code no longer needed.

## Known issues for batch B (SDK), and how batch B handles them

- Keys in plaintext `sessionStorage` (`legacy/client/local-keys.ts`) → the vault iframe on `vaultOrigin` holds PRK
  in memory, and on disk only under the API's share (`'session'` mode).
- CKD network key read over RPC → pinned per env build (`ckdNetworkKey`), checked by the build (`ckdKeyProblem`).
- Full Google token (with email) public on chain → the openid-only implicit flow plus the claim allow-list on
  `/v1/login`. `/v1/sessions` gets the allow-list when the user sets `REJECT_PII_ON_SESSIONS = "1"` after the spec's
  step 7 (only `apps/smoke`'s `direct.html` still uses Google Identity Services). A direct contract caller is not
  bound by it.
- HKDF salt `hana-embed-ckd-v1` → derivation v1 (`hana-id/chain-keys/v1/extract`), confirmed by the user.

## Next steps (2026-10-29)

Done: batches A and A.2 plus the smoke page are merged on `develop`, CI green. **sandbox-dev is deployed on testnet and
passed the full smoke checklist (2026-10-27)**: signer `hana-id-signer-dev1.testnet`, API
`https://hana-id-api-sandbox-dev.tingtc.workers.dev` (personal Cloudflare account: production needs a Hana-owned one),
apps `s1` (partner client + shared) and `s2` (shared only). Batch B is code-complete on `feat/batch-b`
([Batch B status](#batch-b-status-2026-10-28)). Setup and deploy commands: `docs/operations.md`. The plan doc's
Status section is the summary for humans: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi

**The user's to-dos** (agents never ask for or handle private keys; updated 2026-10-29):

Done 2026-10-29: callback registered, testnet contract upgraded, migrations 0003/0004 applied, `VAULT_KEK` set,
API and both page Workers deployed, ship gate measured (D76), latency fixes measured (D77–D79, D94–D97).

Done 2026-10-30: **governance on sandbox-dev** (`docs/operations.md` "Governance migration (sandbox-dev)" steps
1–3, 5–7): the contract migrated in place to v2 (same signer, same addresses), a new updater key (v1 key deleted),
watchdog account `hana-id-watchdog-dev1.testnet` added, council DAO `hana-id-council-dev1.sputnikv2.testnet`
(2 of 3, throwaway members) **owns the signer**, and one upgrade went propose → 60 s → execute through the DAO
(code `3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz`, contract 0.1.1). `governance:status`: no findings. Left: step 4,
the watchdog service (needs a separate Cloudflare account, alert channels and a heartbeat URL from the user).

1. **Deferred: one-month Pro plan test on `ting.rocks`** to see whether a paid zone keeps Malaysian traffic in SIN
   (free plan and workers.dev enter in FRA/CDG/LHR; Enterprise sites enter in SIN). The user is discussing it with
   their colleague. **Remind the user if it hasn't been decided.**
2. Turn on "Require review from Code Owners" on `develop` and `main` (D58).
3. Send the hosted demo (`https://hana-id-demo-sandbox-dev.tingtc.workers.dev`) to the colleague for testing.
4. Add `{authOrigin}/login/callback` to Smoke A's own Google client (own-client login tests).
5. Backup Google addresses for admin-portal access (D88); where the offline backup council key is held (D81, before
   mainnet).
6. Create the Neon project (Sydney, `aws-ap-southeast-2`) to unblock batch C (D73).
7. **Confirm the email provider with the colleague** before creating any account: Resend is recorded (D87) but
   another provider may be used instead. The email code sits behind one small interface, so a switch is cheap.

**Roadmap after governance (decided 2026-10-29):** email login with a Hana-run issuer and automatic, Privy-style account
linking (`docs/email-login-spec.md`, approved 2026-10-30: D4, D119, D121–D123; signing key a Worker secret on
testnet, AWS KMS before mainnet), and the partner identity token with opt-in verified email per app (D120). Then Sign in with Apple (D124).

**Before mainnet:**

- Bound issuer-key and upgrade power (D33): `docs/governance-spec.md`, decisions confirmed 2026-10-29 (D80–D86:
  2 h / 72 h delays, Sputnik 2-of-3 owner, watchdog autonomy and admin-portal monitoring, alert severities). Open:
  the measured mainnet issuer-key delay, where the backup council key is held, the paging app, governance open
  question 17.
- Hana Home: key export for every shared-login app and cross-device consent revocation (D40, D45).
- A Hana Cloudflare account and the two registrable domains for `vaultOrigin`/`authOrigin` (D38, D18). Email
  provider: Resend (D87), set up on a sending subdomain once the domain exists.
- External audit.
- Address freeze: final accounts deployed (D2, D5); after it, nothing may change a path or key derivation.
- Mainnet launch date: not set (D39).

**Known follow-ups:**

- `docs/batch-c-spec.md` (D34 cut, D73–D75 and the 2026-10-29 decisions D87–D93 folded in) needs implementation
  review. Still open there: Q1 (console code flow `openid`-only check, to test), Q3 (Hana Cloudflare account, zone,
  domains), Q4's Access fallback emails, Q5 (Neon setup). Retention periods (D90) need the company's accountant.
- Open questions still to answer: `docs/decisions.md` "Proposed, not yet confirmed".

Working rules: feature branch → PR into `develop` (an org ruleset requires one approving review from a teammate;
the user merges). Never bypass the gitleaks hook. Production standards: tests for every behaviour.
