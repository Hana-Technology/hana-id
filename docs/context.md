# Context — how Hana ID works and what's been decided

Carried over from the design conversation in wend-widget-demo (Oct 2026). Plan doc:
https://claude.ai/artifact/GyQq6HZbaJBtznXyRa2Vbi · Login journey diagrams: https://claude.ai/artifact/73xpB7AZknWd9s38xw4Fjo ·
SDK security page: https://claude.ai/artifact/AwzpW8xZ7pAuMoTYgBfcvo

## How a login works (from the wend-widget-demo PoC, see `legacy/`)

1. The browser makes a non-extractable WebCrypto Ed25519 **session key**.
2. Google Sign-In is started with `nonce = b64url(sha256(sessionPubKey ‖ expiry u64 LE ‖ salt))`
   (batch A adds `key_index u32 LE` before the salt), so Google's signed ID token commits to that session key.
3. The relayer submits `hana-signer.create_session(jwt, …)`. The contract verifies the RS256 token against Google's
   keys stored on-chain, checks `aud`, recomputes the nonce, and records a session whose `path` names the user's key.
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
  identity. `public_registration` is off for the PoC (Hana registers apps).
- App config off-chain in Cloudflare D1; API on Cloudflare Workers + Durable Objects (nonce serialisation per relayer
  key). Chosen for built-in DDoS/rate limiting, free tier, no DB credentials.
- Throwaway accounts first; every account name in `envs/<env>.json`.
- Email login later: whoever signs email tokens can derive any email user's key — needs its own trust decision.
  Batch A makes the verifier provider-generic so email can be another issuer.
- Partners: Sodax first (Stellar via `IStellarWalletProvider`), on testnet-MPC keys that are disposable.

## Known issues fixed by batch A (were in the PoC)

Global client-ID list (any listed app could derive every user's key) · sessions never pruned (storage grows forever) ·
relayer nonce collisions under concurrency · relayer had no app auth / rate limits · owner = contract account
hard-coded · NEAR Auth/FastAuth and per-tx signing code no longer needed.

## Known issues for batch B (SDK)

Keys in plaintext `sessionStorage` (`legacy/client/local-keys.ts`) → in-memory vault on a Hana origin ·
CKD network key read over RPC → pin it · full Google token (with email) is public on-chain → `openid`-only OAuth flow ·
HKDF salt `hana-embed-ckd-v1` → decide final name before freeze.
