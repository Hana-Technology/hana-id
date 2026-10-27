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
  scope comes from the session nonce, which commits to `scope_id`; the scope must have `allow_shared`. Hana's login
  page (batch B) computes a nonce for scope X only for an opener origin allowed for app X. Forging a nonce only gets
  the forger their own key. The path has no client ID, so own and shared logins give the same address if Google's
  `sub` matches across clients (to confirm on testnet). A client is shared or a scope's own, never both; adding a
  shared client and enabling `allow_shared` are timelocked, removing / `disable_shared_login` are immediate.
  Shared-only scopes trust every shared client Hana adds (see the security notes in `docs/contract-interface.md`).
- **Two relayer key pools.** Session pool (`RELAYER_KEYS`: create_session, derive_key, revoke_session,
  prune_sessions) and owner pool (`OWNER_RELAYER_KEYS`, small allowance: owner actions, register_scope,
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

## Batch C decisions (2026-10-27; spec to write)

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

## Known issues for batch B (SDK)

Keys in plaintext `sessionStorage` (`legacy/client/local-keys.ts`) → in-memory vault on a Hana origin ·
CKD network key read over RPC → pin it · full Google token (with email) is public on-chain → `openid`-only OAuth flow ·
HKDF salt `hana-embed-ckd-v1` → decide final name before freeze.

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
6. **Then batch B (SDK):** Hana-hosted login page (shared client), vault, `@hana-id/core|web|react`, standard
   interfaces (EIP-1193, Stellar Wallets Kit), optional `@hana-id/sodax` adapter. Write a batch B spec first, as for
   batch A (`docs/batch-a-spec.md`), and fix the HKDF salt name before the address freeze.
7. **Batch C (dashboard):** write the spec (see Batch C decisions); can run alongside batch B.

Working rules: feature branch → PR into `develop` (an org ruleset requires one approving review from a teammate;
the user merges). Never bypass the gitleaks hook. Production standards: tests for every behaviour.
