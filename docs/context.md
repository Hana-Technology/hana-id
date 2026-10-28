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
5. The MPC (17 nodes, threshold 11, TEEs) returns `big_y = y·G1`, `big_c = msk·H + y·a·G1`. Only the browser knows `a`:
   it computes `S = C − a·Y`, checks `e(H, PK) = e(S, G2)` against the pinned MPC key, then HKDFs chain keys.
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
  timelocked; Hana can't move clients or block derivation (suspension is API-side only). Owners: NEAR account or Google
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
  relays it after checking it against `GET /v1/app` (batch B amended this: A.2 had the login page compute it).
  Forging a nonce only gets the forger their own key. The path has no client ID, so own and shared logins give the same address if Google's
  `sub` matches across clients (to confirm on testnet). A client is shared or a scope's own, never both; adding a
  shared client and enabling `allow_shared` are timelocked, removing / `disable_shared_login` are immediate.
  Shared-only scopes trust every shared client Hana adds (see the security notes in `docs/contract-interface.md`).
- **Two relayer key pools.** Session pool (`RELAYER_KEYS`: create_session, derive_key, revoke_session,
  prune_sessions; batch B adds create_session_and_derive and later drops one of the two create methods, see
  "Relayer allowlists" in `docs/batch-b-spec.md`) and owner pool (`OWNER_RELAYER_KEYS`, small allowance: owner actions, register_scope,
  apply_pending_config), separate keys and Durable Objects, so abuse of `/v1/owner-actions` can't stop logins.
  deploy-contract treats a key with the wrong receiver, methods, an empty method list or an unlimited/too-large
  allowance as a blocker. Gas is per method (`apps/api/src/gas.ts`, to measure on testnet; register_scope scales
  with its proof count, 10 proofs burnt 175 Tgas in the sandbox).
- **Layouts.** Every nonce commits to the signer account id (`env::current_account_id()`), so tokens can't be
  replayed across deployments; the session nonce also commits to `scope_id` and `max_uses`; the register proof to
  the client list and `allow_shared`; strings are borsh length-prefixed. Session messages are
  `"hana-id-session-v1:" ‖ counter ‖ sha256(payload)`. Layouts are checked against an independent JS implementation
  (`gen-fixtures.mjs`) and in the sandbox (`tests/layouts.rs`).
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
  Sodax swaps, bridges and hub actions always get the popup (Q42). Raw signing, `personal_sign`, SEP-53 messages and
  contract creation are never auto-approved. The silent `app_signed` raw mode is out of the MVP (Q31).
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

**Proposed in the spec, awaiting the user's review** (the spec's Decisions, R1–R13 and open questions): two Hana
origins (`vaultOrigin` for the key iframe, `authOrigin` for the login, approval and export popups); the token returns
only through the encrypted relay; the vault computes the nonce and the path itself and pins `signer`, `relayer` and
the CKD key per env build; a claim allow-list (`iss azp aud sub iat exp nonce nbf jti auth_time`, else
`token_has_pii`) on API-relayed tokens (the contract ignores extra claims); dev-only privileges (loopback partner
origins, partner-origin `/v1/sessions`/`/v1/derive`/`/v1/sessions/revoke`) tied to `local*`/`sandbox*` env names;
`pk_test_` and `pk_live_` apps never share a scope; `key_index ≥ 2^31` reserved, MVP fixed at 0.

**Decided while building (2026-10-28), to confirm with the user:**

- sandbox-dev's Hana origins (step 0) are two thin `workers.dev` Workers on the API's subdomain:
  `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` and `https://hana-id-auth-sandbox-dev.tingtc.workers.dev`
  (`apps/api` "Page Workers"). They are one site (`tingtc.workers.dev` is the registrable domain), so the manifest
  schema refuses same-site Hana origins only outside `local*`/`sandbox*` envs. The spec's "two `workers.dev`
  hostnames are separate sites" holds only across account subdomains. Production needs a Hana-owned domain (Q15).
- The Approve guard also arms on a `pointerdown` or `keydown` after both 1 s marks, not only on a `pointermove`
  (a stationary tap or the keyboard fire none), and the arming gesture itself never approves.
- Auto-approve policies gain a required per-chain `maxFeeWei` (gas × fee cap), because the SDK fills EVM fees on the
  partner page. Under `'self-or-listed'`, `string` and `bytes20`–`bytes32` arguments count as opaque like `bytes`.
  Function names that move value are matched by prefix and substring (`transferAndCall`, `permit…`, `set_admin`).
- The approval digest binds a network context only where the request has one: the passphrase for Stellar
  transactions and auth entries, the chain ID for EVM transactions, and an empty context for messages,
  `personal_sign`, EIP-712 (its domain carries `chainId`) and raw. The vault never learns the dapp's selected EVM
  chain.
- The consent digest (`hana-id/auto-approve-consent/v1`) binds the request id, `policyId`, the parent origin and the
  end time the user agrees to. An open vault re-reads the policy in force (`GET /v1/app` now returns
  `autoApprovePolicy`) every 60 s while logged in, and before an auto-sign if the last check is over 90 s old. A
  removed or changed policy stops auto-approval without a reload.
- Logout is app-wide on the device. Tabs end only on a `revoked` broadcast for their own share, so a stale tab can't
  end a newer session. At most 100 approvals wait at once (`4100 too_many_pending`).
- Export accepts a token without `auth_time` (Google sends none, even with `max_age=0`; Q33). One that has it must be
  under 5 min old.
- The partner client adds `cancelLogin()`, `requestAutoApprove()`, `autoApproveStatus()`, `revokeAutoApprove()`,
  `destroy()` and the `loginProgress`, `autoApproved` and `launcher` events to the spec's list. It logs a console
  warning when Google Identity Services is on the page or the browser is an in-app webview. A report-only CSP
  violation doesn't fail the handshake; only an enforced one does.

### Google openid-only spike (2026-10-28, `apps/smoke/spike.html`, Chrome)

- With `scope=openid` (implicit flow, `response_type=id_token`), a personal and a Workspace account both got exactly
  `{aud, azp, exp, iat, iss, jti, nbf, nonce, sub}`: no email, name or picture, and no `hd`. The allow-list was fixed
  from this.
- `max_age=0` returned no `auth_time` (Q33). Export relies on a fresh login plus a typed confirmation.
- The popup kept `window.opener` through Google's pages in Chrome (Safari untested). The token still comes back only
  through the relay (R2).

### Batch B status (2026-10-28)

On the integration branch `feat/batch-b` (not yet on `develop`), with its tests passing, and **not deployed**:

- Contract: `create_session_and_derive`, the `key_index < 2^31` bound, the mock MPC failure switch; unit and sandbox
  tests (`docs/contract-interface.md` "Changed in batch B").
- `@hana-id/core`: layouts, CKD, derivation v1 with vectors, export, signers, decoders, `normalizeTypedData`, the
  approval and consent digests, auto-approve validation and matching, the ID-token check and allow-list, the protocol
  schemas.
- API: `POST /v1/login`, the `LoginRelay` Durable Object, the five vault endpoints, migration `0003_vault.sql`, the
  vault page, the origin and dev-env rules, the page Workers for both Hana origins, and the `gen` changes.
- `@hana-id/web`: the vault, the auth pages (`/login`, `/login/callback`, `/approve`, `/export`), per-env builds to
  `packages/web/dist/pages/<env>/{vault,auth}`, `createHana` with the EIP-1193 provider (EIP-6963), the Stellar
  signer and the Stellar Wallets Kit module.
- Scripts: `admin app:settings` for the per-app settings; session-pool allowlist state 1 in `deploy-contract`.
- Docs: `docs/integration.md` (partner guide), this file, `docs/contract-interface.md`.

Still to do in batch B: `@hana-id/react` and `@hana-id/sodax` (scaffolds only), `apps/smoke` on the vault (step 7),
the Playwright suite, the npm build of the client packages, and the user's deploy steps. Those are: the contract
upgrade with the session keys rotated to allowlist state 1, `VAULT_KEK`, migration 0003, the page Workers, and the
`{authOrigin}/login/callback` redirect URI on the shared and partner clients. **To measure on testnet** after the
deploy, and record here: the ship gate (10 runs of `create_session_and_derive`: gas over all receipts and the
latency median), unlock latency from SIN with the page render, the BLS precheck's Worker CPU time (Q8, before
`BLS_PRECHECK` is on anywhere), one forced MPC-side failure, Safari/WebKit retention of partitioned IndexedDB (Q4),
and own vs shared client with the own client in a **separate Google Cloud project**. The `sub` match recorded below
used two clients of one project, which doesn't prove the A.2 promise. After step 7: `REJECT_PII_ON_SESSIONS = "1"`
and session-key rotation to allowlist state 2 (gate passes) or 3 (gate fails).

## Batch C decisions (2026-10-27; spec `docs/batch-c-spec.md`, draft)

- **Developer dashboard, like Privy's.** Partners manage orgs, members, apps, origins, keys and on-chain owner actions
  (`/v1/owner-actions` with a console-client token). Replaces `admin app:*` after the pilot.
- **Invite-only.** No public sign-up: a Hana admin issues email-bound, single-use, expiring invites (stored hashed);
  sign-in with Google through the console client; no accepted invite → refused. `public_registration` stays off.
- **Hana admin console**, separate, behind Cloudflare Access. Contract-billing reports per org/app by day and month
  (logins, derives, monthly active users, new users, gas burnt + USD, failures, latency), CSV statement. Billing-grade
  totals in D1 (Analytics Engine keeps 3 months: operational metrics only).
- **Billing on hold** (no Stripe/plans yet). Sodax is billed by service contract from the monthly statement.
- **Allowed origins are security-critical** in shared-login mode: changes need a fresh sign-in, are logged and email
  the other owners (delay before effect: open).
- **Infra stays Cloudflare** (review in the plan doc, 2026-10-27): cheapest at every volume, DDoS included, no OS,
  Durable Objects fit the nonce design. Infra is <1% of running cost; NEAR gas (~38 Tgas ≈ $0.02 per login) is the
  bill, so cut on-chain calls per login (batch B: keep the key across reloads). AWS KMS later only for HSM-grade keys
  (email issuer). Revisit at D1 ~5 GB, an HSM/region requirement, or ~500 req/s per app.

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
- Google `sub` is the same across the partner and shared clients (same Google Cloud project; expected per account).
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
  `/v1/login`. `/v1/sessions` gets the allow-list once `apps/smoke` leaves Google Identity Services
  (`REJECT_PII_ON_SESSIONS`, step 7). A direct contract caller is not bound by it.
- HKDF salt `hana-embed-ckd-v1` → derivation v1 (`hana-id/chain-keys/v1/extract`), confirmed by the user.

## Next steps (handoff, 2026-10-26)

Status: batches A and A.2 plus the smoke page are merged on `develop`, CI green. **sandbox-dev is deployed on
testnet and passed the full smoke checklist (2026-10-27)**: signer `hana-id-signer-dev1.testnet`, API
`https://hana-id-api-sandbox-dev.tingtc.workers.dev` (personal Cloudflare account: production needs a Hana-owned one),
apps `s1` (partner client + shared) and `s2` (shared only). Steps 1–4 below are done. The plan
doc's Status section is the summary for humans: https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi

1. **Human setup** (the user does these; never ask for or handle private keys):
   - Three testnet accounts via near CLI into the legacy keychain (`~/.near-credentials/testnet/`), names as in
     `envs/sandbox-dev.json` (signer ≥ 6 NEAR, relayer ≈ 7 NEAR, owner ≈ 1 NEAR):
     `near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create`
   - Google Cloud OAuth (consent screen in Testing mode with test users): Hana app client → `googleClientIds`;
     a separate shared login client → `sharedGoogleClientIds`; a "partner" client for own-client tests; all with
     `http://localhost:5173` as an authorized JavaScript origin for the smoke page. A "Hana console" client →
     `consoleAudiences` (set before the first deploy; batch C signs in with it).
   - Cloudflare account with a workers.dev subdomain; `pnpm --dir apps/api exec wrangler login`.
2. **Deploy sandbox-dev** (README "deploy a sandbox env" has exact commands): fill the manifest → `fetch-ckd-key` →
   `deploy-contract` (show the plan, deploy only after the user says yes) → `post-google-keys` → D1 create + `gen`
   + migrations → Worker secrets (`RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`) → `deploy` → put the real
   workers.dev URL in `apiUrl`.
3. **Register two test apps** (`admin scope:register`, `admin app:create --origin http://localhost:5173`): one with the
   partner's own client and `--allow-shared`, one shared-only.
4. **Smoke test** with `apps/smoke` (checklist in `apps/smoke/README.md`): real MPC CKD + pairing check, app A vs B
   give different addresses, key index 0 vs 1, own vs shared client give the same path (confirms Google `sub` is
   stable across clients), revoke, replays rejected, max_uses. Record per-method gas and latency.
5. **Tune from measurements:** per-method gas in `apps/api/src/gas.ts` and relayer allowances in deploy-contract;
   update the plan doc's Status section and this file.
6. **Then batch B (SDK):** specified in `docs/batch-b-spec.md`. Status and what remains:
   [Batch B status](#batch-b-status-2026-10-28).
7. **Batch C (dashboard):** draft spec in `docs/batch-c-spec.md` (see Batch C decisions); can run alongside batch B.

Working rules: feature branch → PR into `develop` (an org ruleset requires one approving review from a teammate;
the user merges). Never bypass the gitleaks hook. Production standards: tests for every behaviour.
