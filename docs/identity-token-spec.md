# Partner identity token spec (pre-mainnet)

**Status: APPROVED (2026-10-30); build steps 1–4 (no email claim) built on `feat/identity-token-1` (D170–D175);
steps 5–8 not built.** The current state is in the reference docs (`api.md` "Identity token", `integration.md`
section 15, `architecture.md`, `security.md`, `operations.md` "Identity token keys"). Specifies `docs/decisions.md` D120 (a short-lived JWT a partner's
backend can verify, with an opt-in verified email per app). The user answered all 16
[open questions](#open-questions-for-the-user) on 2026-10-30, each with the recommended option A; recorded as D127.

This file becomes the source of truth for the batch once approved. If code and this spec disagree, fix the code or
raise the problem. Reference docs (`architecture.md`, `security.md`, `api.md`, `integration.md`, `operations.md`,
`contract-interface.md`) are updated in the same branches as the code, not now.

## Contents

- [Summary](#summary)
- [Goals and non-goals](#goals-and-non-goals)
- [Current state (why there is no token today)](#current-state-why-there-is-no-token-today)
- [How Wend uses Privy today (reference use)](#how-wend-uses-privy-today-reference-use)
- [What Privy offers (to match where sensible)](#what-privy-offers-to-match-where-sensible)
- [Design overview](#design-overview)
- [The token](#the-token)
- [Minting: the session proof](#minting-the-session-proof)
- [Wallet addresses: proof of possession](#wallet-addresses-proof-of-possession)
- [Lifetime, refresh and caching](#lifetime-refresh-and-caching)
- [SDK surface](#sdk-surface)
- [Signing key, JWKS and rotation](#signing-key-jwks-and-rotation)
- [Verified email: opt-in per app](#verified-email-opt-in-per-app)
- [Logout, revocation and expiry](#logout-revocation-and-expiry)
- [Relation to email login and account linking](#relation-to-email-login-and-account-linking)
- [Privacy](#privacy)
- [Threat model](#threat-model)
- [Partner verification guide (Node, `jose`)](#partner-verification-guide-node-jose)
- [Migrating from Privy](#migrating-from-privy)
- [API endpoints](#api-endpoints)
- [D1 schema, manifest and secrets](#d1-schema-manifest-and-secrets)
- [Invariants](#invariants)
- [Tests](#tests)
- [Build order](#build-order)
- [Docs to update when built](#docs-to-update-when-built)
- [Sources](#sources)
- [Open questions for the user](#open-questions-for-the-user)

## Summary

A partner page calls `await hana.getIdentityToken()` and sends the string to its own backend. The backend verifies it
locally against Hana's published keys (a JWKS URL, as any OIDC library does) and learns, for that app:

- `sub`: a stable pseudonymous user id, the same for every login method of the user's account in that app's scope,
  different in every other partner's scope, never the Google `sub`;
- `wallets`: the user's Stellar and EVM addresses in that scope, each proven by a signature from its key;
- `sid`: a session id, stable across the tabs and reloads of one Hana session, new at every interactive login;
- `email` and `email_verified`, only if the app enabled it **and** the user agreed to share it with that app.

The token is an ES256 JWT, valid for at most 1 hour and never past the Hana session. The vault obtains it without a
popup by signing a request with the session key; the API Worker checks that the session is live and signs the token
with a dedicated key (a Worker secret on testnet, AWS KMS before mainnet, D121's staged approach). Hana stores no
email: the address travels as a blob sealed under a Hana key and held by the user's vault. The token can't unlock a
wallet or sign anything, and no Hana API accepts it.

## Goals and non-goals

Goals:

1. A partner backend can trust **who** the user is (a stable per-app id), **which wallets** they hold, **which
   session** a request belongs to, and (with consent) **their verified email**, without calling Hana.
2. Verification with standard tools: compact JWS, `kid`, a public JWKS, standard `iss`/`aud`/`exp`/`iat` checks
   (`jose`, `jsonwebtoken` + `jwks-rsa`, any OIDC library).
3. A partner moving from Privy (Wend first) changes one verifier function and a claim mapping, not its session model.
4. No new way to reach a key: the token is useless against Hana's APIs and the contract.
5. No cross-app linkage and minimal claims (D25's spirit off chain too); no stored user email (D96).
6. Production standards: a non-exportable signing key on mainnet, rotation and a compromise playbook, tests for every
   behaviour.

Non-goals (v1):

- "Sign in with Hana" as a general OpenID provider (authorization endpoint, code flow, client secrets). The token
  exists only for partners that already embed the SDK.
- Refresh tokens or any credential the partner backend holds on its own. Freshness comes from the user's live vault.
- A server-side user lookup API (Privy's `users().get`), webhooks, custom metadata, name or picture claims.
- Cookies: no Hana origin sets one (D70), and the SDK doesn't set one on the partner's domain either
  ([Q11](#open-questions-for-the-user)).
- Replacing Hana's own session model: JWT login sessions stay rejected (D120); the session key and server-held share
  remain the only way to a key.
- Authenticating requests to Hana. Partners have no secret key (`sk_…` doesn't exist) and get none here.

## Current state (why there is no token today)

Verified against `develop` at d1837ec:

- A Hana session is an Ed25519 **session key** made non-extractable in the vault (`packages/web/src/vault/login.ts`),
  committed to in the Google token's nonce and registered on chain by `create_session_and_derive` with `path =
  scope#provider#sub#key_index` (`docs/architecture.md` "Login, one transaction"). In `'session'` persistence the API
  holds a **share** (`vault_shares`: `share_id`, `session_pk` UNIQUE, `path_hash`, `idle_until`, `abs_expires_at`,
  `revoked_at`) that lets the vault unlock the encrypted PRK after a reload; every share action is signed by the
  session key with a counter (`"hana-id-vault-v1:"` vault message, `docs/api.md` "Vault endpoints").
- There is no bearer token anywhere by design: the API never issues one, the partner page never sees the Google token
  (it crosses an end-to-end encrypted relay to the vault), and partners have no secret key. A stolen bearer credential
  would otherwise be a way to the user's key; here every key-reaching step needs the session private key, which never
  leaves the vault.
- So a partner backend today has only what the page tells it: the addresses from `hana.login()`, unauthenticated. To
  trust them it must make the user sign a challenge (`personal_sign` or a Stellar message: a Hana approval popup every
  time, D48/`NEVER_AUTO_APPROVED_KINDS`). It can't learn an email or a stable user id at all.
- Sessions last 12 h absolute and 2 h idle by default (D43, app settings `session_ttl_ms`, `idle_ttl_ms`). Requests
  that only read (status, addresses) don't count as activity (D55, D112).
- Pseudonymous ids already planned: batch C's `uid = HMAC(USER_ID_KEY, "hana-id/uid/v1" ‖ scope ‖ provider ‖
  sub)[0..16]` (usage ledger, `key_index` dropped) and the Support ID derived from it (D96, `docs/hana-home-spec.md`).
  Neither is shown to partners.
- Email login (`docs/email-login-spec.md`, approved, not built) adds a Hana email issuer Worker (`apps/email-issuer`)
  whose RSA key is a Worker secret on testnet and AWS KMS before mainnet (D121), a Google `email` scope plus access
  token read transiently at `google-match` (D25 amended), and accounts whose members open the root identity's path
  (D119, D122).

## How Wend uses Privy today (reference use)

Read from `/Users/tingtzechuen/Documents/wend-api` (read only; no secrets or env values copied):

| Where | Token | What Wend checks | What it uses |
|---|---|---|---|
| `src/auth/privy.ts` `verifyPrivyAccessToken` | Privy **access token** (ES256) | `jose.jwtVerify` with a pinned SPKI key (`PRIVY_VERIFICATION_KEY`, imported as ES256), `issuer: 'privy.io'`, `audience: PRIVY_APP_ID`, `exp`; `sid` must be a non-empty string | `sid` (required), `sub` (Privy DID, kept for later binding) |
| `src/auth/session.ts` `verifyLoginChallengeAndCreateSession` | the access token, optional field `privyAccessToken` on the wallet-signature login | a presented token must verify (fail closed); `AUTH_REQUIRE_PRIVY_TOKEN_WEB` can make it mandatory for web | **one session per browser**: a mint with a verified `sid` supersedes the wallet's older sessions with that `sid`; **a kicked browser stays kicked**: a revoked session's `sid` refuses silent re-mints (`403 SESSION_KICKED`) until a fresh interactive Privy login gives a new `sid`; **lapse rule**: a re-mint whose `sid`'s newest session expired more than a grace window ago is refused |
| `src/auth/privy.ts` `verifyPrivyIdentityToken`, `parsePrivyLinkedAccounts` | Privy **identity token** (ES256, same key) | same `iss`/`aud`/`exp`; `JWTExpired` reported separately (`EXPIRED_PRIVY_ID_TOKEN`, treated as soft: the web SDK may hand over a stale cached token) | `linked_accounts` (a JSON **string**; also accepts an array, snake or camel case): the first `type: 'email'` `address`, lowercased; every `type: 'wallet'` with `chain_type` stellar; `sub` |
| `src/user/privy-identity.ts` `recordPrivyIdentity` (from `POST /api/user/auth`, field `privyIdToken`) | the identity token | **wallet binding**: the wallet that signed this request must be among the token's Stellar wallets, else `WALLET_MISMATCH` (so a valid token for A can't stamp A's email onto B) | stores `User.privyEmail`, `privyEmailVerifiedAt`, `privyUserId`; then credit programs (`tryIssueProgramCreditsForWallet`) and funnel leads (`linkFunnelLeadToWallet`) keyed on the verified email |
| `src/referral/credit-programs*.ts`, `src/user/wallet-lookup.ts`, `src/audd/diagnose.ts` | — | — | `privyEmail` is the canonical, unforgeable email: credit grants by email, admin search, diagnostics; the self-reported `email` field is never trusted for these |
| `src/logger.ts` | — | — | `privyEmail` is redacted from logs |
| `src/auth/privy-admin.ts` | Privy REST API (Basic app id + secret) | staging only, refused in production | deleting test users; not something Hana needs to offer |

So Wend relies on: `iss`, `aud`, `exp`, `sub`, `sid` (session per browser, new on interactive login, never repeats),
a verified email, the user's Stellar wallets, local verification with no call to the provider, and a distinguishable
"expired" failure. Wend runs its own sessions (wallet-signature challenge, bearer keys with TTLs); the provider's token
is an input to them, not the session itself. Hana's design keeps that shape.

## What Privy offers (to match where sensible)

From Privy's public docs (read 2026-10-30; [Sources](#sources)):

- **Access token**: ES256 JWT, 1 hour by default (configurable), claims `sid` (session id), `sub` (Privy DID), `iss`
  = `privy.io`, `aud` = the Privy app id, `iat`, `exp`. Refreshed automatically by `getAccessToken()` using an opaque
  **refresh token** (30 days by default, rotated on use, invalidated at logout). A session is created at login, and
  persists across access-token renewals, reloads and browser restarts while the refresh token is valid; `sid` is in
  both the access and the identity token.
- **Identity token**: ES256 JWT, enabled per app in the dashboard. Claims `sub`, `iss`, `aud`, `iat`, `exp`,
  `linked_accounts` (a **stringified** array of lightweight linked accounts: email `address`, `google_oauth`
  `subject`/`email`/`name`, wallets with `address` and `chain_type`, …) and `custom_metadata`. Lifetime: the
  identity-token page says about 1 hour, the tokens page says 10 hours by default (configurable): Privy's docs
  disagree. A new one is issued at login, link or unlink, page reload, or when an expired access token is refreshed.
- **Delivery**: web SDK sends a `privy-id-token` cookie (HttpOnly with a configured base domain) or the partner reads
  `useIdentityToken()` / `getIdentityToken()` and sends a header.
- **Verification**: the verification key is copied from the dashboard (a PEM public key), or Privy's server SDK
  fetches it from Privy's API; the pages read don't document a public JWKS URL. Checks: signature, `exp`, `iss`,
  `aud`. Identity tokens need the dedicated verification method, not `verifyAuthToken`.

Where Hana differs on purpose: one token instead of two (Hana has no access token to Hana's API for partners to
hold); a public JWKS URL instead of a dashboard-pasted key (rotation without partner config changes); a real JSON
array for wallets instead of a stringified one; an email only with per-app consent; no Google `subject`, name or
picture; no refresh token (the vault's live session is the refresh credential); `sub` per scope instead of a global
DID.

## Design overview

```
 partner page                       vaultOrigin (vault iframe)                 apiUrl (API Worker)
 ┌───────────────────────┐ port   ┌───────────────────────────────┐  HTTPS   ┌──────────────────────────────────┐
 │ hana.getIdentityToken()│──────▶│ cached token ≥ 5 min left?    │          │ POST /v1/identity/token          │
 │                        │◀──────│  yes → return it              │          │  vault gate (key, origins, limits)│
 └──────────┬─────────────┘ token │  no  → session proof (Ed25519 │─────────▶│  proof: signature, clock, once   │
            │ Authorization:      │        by the session key)    │          │  session live (share / chain)    │
            ▼ Bearer <token>      │        + wallet proofs (record)│          │  wallets: verify both proofs     │
 ┌────────────────────────┐       │        + sealed email (record) │          │  email: app on + consent + unseal│
 │ partner backend        │       └───────────────────────────────┘          │  sign ES256 (Worker key / KMS)   │
 │ jwtVerify(token, JWKS, │◀───── GET {iss}/jwks.json (cached 10 min) ────────│ GET /v1/identity/jwks.json       │
 │  {iss, aud: app_…})    │                                                   └──────────────────────────────────┘
 └────────────────────────┘
```

| Step | Who | What |
|---|---|---|
| Issuer | API Worker (`apps/api`), `{apiUrl}/v1/identity/*` | Mints tokens, serves the JWKS and a discovery document. Called only from `VAULT_ORIGIN` ([Q3](#open-questions-for-the-user)) |
| Mint trigger | the vault, on a partner's `hana_identityToken` port call | Lazily: the first call after login mints; later calls return the cache until < 5 min remain |
| Proof | the vault | A fresh signature by the session key; the wallet proofs and the sealed email it stored with the session |
| Session check | the API | The share (in `'session'` mode) and the on-chain session are live, the app's scope, the contract not paused |
| Signing | `IdentitySigner` adapter | ES256 with a Worker-secret P-256 key (testnet) or AWS KMS `ECC_NIST_P256` (mainnet) |
| Verification | the partner backend | Signature by a key in Hana's JWKS, `typ`, `iss`, `aud` = its app id, `exp`, `iat` |

## The token

Compact JWS (RFC 7515), one signature. Partner libraries verify compact JWTs out of the box; the multi-signature JSON
form of email tokens (D121) exists for the contract's signer policy and isn't needed here.

Header:

```json
{ "alg": "ES256", "kid": "<RFC 7638 JWK thumbprint, b64url>", "typ": "hana-identity+jwt" }
```

`typ` is the explicit type RFC 8725 §3.11 recommends, so no other Hana JWT can be mistaken for it and vice versa.

Payload (example, sandbox-dev):

```json
{
  "iss": "https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/identity",
  "aud": "app_4Kq9…",
  "sub": "u1_8pQm3yR0tZ1vW5xA7cB2dE",
  "sid": "s1_Jf2kL9mN0pQ3rS6tU8vW1x",
  "iat": 1800000000,
  "exp": 1800003600,
  "jti": "Zx3…",
  "wallets": [
    { "chain": "stellar", "address": "GBX…" },
    { "chain": "evm", "address": "0xAb12…" }
  ],
  "login_methods": ["google"],
  "email": "ada@example.com",
  "email_verified": true
}
```

| Claim | Always | Value | Notes |
|---|---|---|---|
| `iss` | yes | the manifest's `identityToken.iss`; `{apiUrl}/v1/identity` on sandbox-dev | Differs from the email issuer's `{apiUrl}/v1/email` and from Google's. A production hostname to fix before partners go live ([Q14](#open-questions-for-the-user)) |
| `aud` | yes | the D1 `apps.id` (`app_…`) | Not the publishable key (that is a credential-shaped string partners might log or rotate). A test app and a live app have different ids and scopes (D51) |
| `sub` | yes | `"u1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/idt-sub/v1" ‖ 0x00 ‖ borsh(scope_id) ‖ borsh(root_provider) ‖ borsh(root_sub))[0..16])`, 25 characters | Per **scope**, from the account's root identity, `key_index` dropped ([below](#sub-the-per-app-pseudonymous-id); [Q1](#open-questions-for-the-user)) |
| `sid` | yes | `"s1_" ‖ b64url(HMAC-SHA256(IDENTITY_SUB_KEY, "hana-id/idt-sid/v1" ‖ 0x00 ‖ borsh(app_id) ‖ session_pk)[0..16])` | One value per session key: shared by every tab and reload of that session, new at every interactive login, never repeated ([Q15](#open-questions-for-the-user)) |
| `iat`, `exp` | yes | seconds; `exp ≤ iat + 3600`, capped at the session's end ([Lifetime](#lifetime-refresh-and-caching)) | No `nbf` (equal to `iat`) |
| `jti` | yes | 16 random bytes, b64url | For a partner's own replay or audit logic; Hana keeps no per-token log |
| `wallets` | yes | `[{chain, address}]`, `chain` ∈ `stellar`, `evm`; Stellar `G…` strkey, EVM EIP-55 | A real JSON array (Privy's `linked_accounts` is a string). Account 0 only (D61). Each address proven by its key ([Wallet addresses](#wallet-addresses-proof-of-possession)) |
| `login_methods` | yes | the account's active login providers, e.g. `["google"]`, `["email", "google"]`, sorted | No identifiers, no addresses of mailboxes; pending links are not listed ([Q12](#open-questions-for-the-user)) |
| `email` | only with consent | the verified address ([Verified email](#verified-email-opt-in-per-app)) | Compare case-insensitively. Never present without `email_verified: true` |
| `email_verified` | only with `email` | `true` | Kept for OIDC-shaped code that expects it next to `email` |

No other claim. A token never carries the Google `sub`, the path, the scope id, the session public key, a name,
picture, `hd`, locale, device or IP. Size: about 700 characters with an email.

### `sub`: the per-app pseudonymous id

- **Input = the account's root identity**, read from the on-chain session: `get_session(session_pk).path` is
  `scope#provider#sub#key_index`, and for a linked identity it is already the account root's path (email spec
  "Sessions"). Strip the known `scope_id#` prefix, require exactly three `#`-separated parts, drop `key_index` (batch C
  does the same for `uid`). So every login method of one account gives the same `sub`, and a `key_index` move after a
  leak (D8) keeps the user's `sub` while their `wallets` change: partners keep the person, not the key.
- **Per scope, not per app**: two apps in one scope (a partner's web and mobile apps, D10) get the same `sub`. They
  already see the same wallets, so a narrower pseudonym would hide nothing (batch C reached the same conclusion for
  `uid`). Different partners are different scopes, so different `sub`s and different wallets.
- **Keyed**: paths are public on chain (every `create_session*` and MPC request carries them), so an unkeyed hash
  would let a partner test every on-chain path and recover the user's Google `sub`, which is the same in every Google
  project (D42) and so links the user to any other service with Google login. `IDENTITY_SUB_KEY` is 32 random bytes per
  env, on the API only, backed up in `.secrets/<env>/identity-sub-key` (0600) and offline with the council backup
  (D81), never logged and **never rotated**: a new key would change every user's `sub` at every partner. If it ever
  must change (a leak), a `u2_` scheme ships with a migration window in which tokens carry `sub` (new) and
  `legacy_sub` (old) for 90 days.
- **Separate from `USER_ID_KEY`** (batch C's billing `uid`): different purpose, different exposure (partners hold
  `sub`s; `uid`s are internal and stripped after 24 months, D90), so a leak of one doesn't re-link the other
  ([Q16](#open-questions-for-the-user)).
- Stable across own and shared Google clients and the Standard → Enterprise move (the path has no client id, D12,
  D42), across devices, and across email login and Apple (D124) through linking.

### `sid`

- Keyed for the same reason as `sub`: session public keys are on chain next to their path.
- Per app (the label includes `app_id`), so two apps sharing a scope still see different `sid`s. A session belongs to
  one app anyway (the vault is per app).
- `'session'` persistence: tabs and reloads share the IndexedDB record and so the session key and `sid`; a new login
  (interactive, through the popup) makes a new session key and `sid`; so Wend's "one session per browser" and "a
  kicked browser stays kicked until a fresh interactive login" work unchanged. `'none'`: every page load is a new
  login and a new `sid`.
- If a near-zero-click returning login is ever added (batch B Q2 open), it makes a new session key, hence a new `sid`
  without a visible login. Partners that block a revoked `sid` would then see a quiet re-login; that feature's spec has
  to address it.

## Minting: the session proof

The vault proves its live session with the session key, as it does for share actions, but with its own message and no
share counter (a mint must not race unlock and touch, and must work in `'none'` mode, which has no share):

```
identity_message = "hana-id-identity-v1:" ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(app_id) ‖ session_pk(32)
                   ‖ u64le(issued_at_ms) ‖ nonce(16) ‖ sha256(payload)
payload          = "identity-token" ‖ borsh(parent_origin) ‖ wallet_proofs_hash(32) ‖ sha256(sealed_email or "")
```

The prefix differs from `"hana-id-session-v1:"` (contract) and `"hana-id-vault-v1:"` (share actions), so a signature
can't serve another purpose; the contract never accepts it. `issued_at_ms` is the vault's server-corrected clock; the
API accepts ±60 s and records `sha256(signature)` in a `RateLimiter` single-use marker until `issued_at_ms + 120 s`
(the same mechanism as owner-token markers): a replayed proof is refused.

The API then requires, in order (full list under [API endpoints](#api-endpoints)):

1. the contract is not paused (`get_config`, 10 s cache while paused): a forged-key incident stops identity tokens
   with logins;
2. `'session'` persistence: the share for `(session_pk, app_id)` exists, isn't revoked, `now < idle_until` and `now <
   min(abs_expires_at, created_at + current session_ttl_ms)`, its partner origin is still allowed and persistence is
   still `'session'`, exactly as unlock judges it, **without** moving the counter or sliding `idle_until`;
3. the on-chain session: `get_session(session_pk)` (cached 60 s per isolate; a refusal is re-read fresh) is non-null
   (so revoked sessions and those before `sessions_valid_from_ms` fail), its `scope_id` is the app's, and it hasn't
   expired;
4. the wallet proofs verify ([next section](#wallet-addresses-proof-of-possession)).

A mint doesn't count as activity: it neither slides `idle_until` nor restarts the vault's in-memory idle timer (D55,
D112), so a background tab refreshing tokens can't keep a session alive. It needs the session key but not PRK, so it
works while the vault is dormant.

## Wallet addresses: proof of possession

The API can't compute a user's addresses: they come from the CKD output, which only the user's browser decrypts. So
each address in the token is proven by a signature from its own key, made once per session while PRK is in memory:

```
wallet_proof_message(chain, address) = "hana-id/identity-wallet/v1" ‖ 0x00 ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(app_id)
                                       ‖ session_pk(32) ‖ borsh(chain) ‖ borsh(address)
stellar: Ed25519 signature by the Stellar key over the message (the G… address is the public key)
evm:     secp256k1 recoverable signature over sha256(message); the API recovers the address
```

- The vault makes both proofs right after login (and in the export window never) inside `withChainKey` (the chain key
  is derived per use and zeroed, `derivation.ts`), and stores them in the IndexedDB record next to the addresses. They
  are not secret. After a reload or while dormant the stored proofs are sent; no PRK is needed for a refresh.
- They are bound to `session_pk` and `app_id`: useless for another session or app, and useless without a fresh session
  proof. Neither message can be a chain transaction or a SEP-53/EIP-191 message: Stellar transaction signatures cover a
  32-byte hash, EVM transactions a keccak of RLP; these are domain-separated and of a different shape.
- The API verifies both on every mint (about 1–2 ms) and writes the canonical forms into `wallets`.
- **What it proves**: the holder of this Hana session controls these keys, and Hana's vault code reports them as the
  session's derived wallets. A user who tampers with their own vault (devtools on the vault origin) could attach a key
  they control that isn't their Hana wallet; they can never attach someone else's address. That is the same assurance
  Privy gives for linked external wallets. Partners that need "this exact wallet signed my request" keep doing what Wend
  does: check that the wallet that authenticated is in `wallets`.
- Alternative considered ([Q8](#open-questions-for-the-user)): an address registry in D1 pinned at first proof. It
  would detect a later change but store a durable `pseudonym → addresses` record, which a D1 dump plus
  `IDENTITY_SUB_KEY` turns into `Google sub → on-chain activity`. Not proposed.

## Lifetime, refresh and caching

- `exp = min(iat + 3600, idle_until, abs cap of the share, on-chain expires_at_ms)` in `'session'` mode;
  `min(iat + 3600, on-chain expires_at_ms)` in `'none'` mode (the vault's in-memory idle ends that session and with it
  the refreshes). Less than 30 s left → `410 session_ending` and no token. So a token never outlives the session it
  was minted for, except by a logout or revoke that happens after the mint ([Logout](#logout-revocation-and-expiry)).
  1 hour is D120's ceiling and Privy's access-token default ([Q5](#open-questions-for-the-user)).
- Because `exp` follows `idle_until`, a user who only browses (no signature, no unlock) for close to the idle limit
  gets shorter tokens, then none: that is the Hana session ending, which partners should treat as a logout.
- **Vault cache**: one current token per app per session, in memory and announced on the per-app BroadcastChannel
  (`hana-vault:<appId>`, outcomes only, never key material), so all tabs of the session share it. A mint runs under a
  Web Lock `hana-identity:<appId>` so tabs don't mint in parallel. `getIdentityToken()` returns the cached token
  while more than 5 minutes remain, else mints. The cache is dropped at logout, a newer login, `sessionExpired`, a
  consent change and a `login_methods` change seen on chain.
- **Lazy**: no token is minted until the partner asks, so partners that never use it cost nothing (a KMS signature
  is $0.15 per 10,000 for ECC keys).
- `maxAgeMs` forces a fresh mint when the cached token is older: a partner backend can require `iat` within N seconds
  for a sensitive action (`jose`'s `maxTokenAge`), which proves the Hana session was live just now (a stateless
  substitute for introspection, [Q10](#open-questions-for-the-user)). The minimum is 30 s.

## SDK surface

`@hana-id/web` (`HanaClient`), new members:

```ts
/** The current identity token, or null while logged out. Silent: no popup, works in any handler, no user activation.
 *  Cached; a new one is minted when < 5 min remain or the cached one is older than `maxAgeMs`. */
getIdentityToken(opts?: { maxAgeMs?: number }): Promise<string | null>;

/** The user's email-sharing state for this app. 'off': the app doesn't use the email claim. */
emailSharing(): Promise<'off' | 'not_asked' | 'granted' | 'declined'>;

/** Opens the Hana popup asking the user to share their email with this app (in a click, like login()).
 *  Resolves with the new state. For a user who declined at login, or a partner that wants to ask again later. */
requestEmailSharing(): Promise<'granted' | 'declined'>;
```

Events (`HanaEvents`): `identityTokenChanged: [string | null]` after every mint (also from another tab) and with
`null` at logout or expiry; `emailSharingChanged: ['granted' | 'declined' | 'not_asked']`.

Errors (`HanaError`): `identity_unavailable` (API or signer down; retryable), `session_ended` (also fires
`sessionExpired`), `rate_limited`. `getIdentityToken()` never rejects for "logged out": it resolves `null`.

Port method `hana_identityToken {maxAgeMs?}` in the vault, tier **silent** (beside `hana_status`): it uses the
session key but never PRK, needs no approval, and isn't activity. Its answer goes only to the partner origin the vault
was opened for.

`@hana-id/react`:

```ts
/** Re-renders on identityTokenChanged. Mints lazily on first use; while mounted, keeps the token fresh (a refresh
 *  timer at exp − 5 min, only while the page is visible). */
function useIdentityToken(): { identityToken: string | null; refresh(opts?: { maxAgeMs?: number }): Promise<string | null>;
                               error: HanaError | null };
```

Partner code sends the token as `Authorization: Bearer <token>` (or a header of its choice) on calls to its own
backend. Example:

```ts
const token = await hana.getIdentityToken();
await fetch('/api/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
```

`createHana()` takes no new option. Whether the email claim is used is an app setting, never a page option (a page
can't widen what users share).

## Signing key, JWKS and rotation

### Algorithm

**ES256** (ECDSA P-256, SHA-256) ([Q2](#open-questions-for-the-user)): what Privy uses (Wend's `jose` code ports with
one line changed), small signatures (64 bytes), supported by every JOSE library, by WebCrypto in Workers, and by AWS
KMS (`ECC_NIST_P256`, `ECDSA_SHA_256`). RS256 would reuse the email issuer's KMS plumbing and is 5× cheaper per KMS
request; the cost difference is small at our volumes (below).

### Where the key lives (staged, as D121)

| Stage | Signer | Envs |
|---|---|---|
| Testnet now | `IDENTITY_SIGNING_KEY`: a P-256 private JWK as an API Worker secret, plus `IDENTITY_SIGNING_KEY_STANDBY`; backups in `.secrets/<env>/identity-signing-key*.json` (0600); generated by `scripts/identity-key.ts init`, never printed | `local*`, sandbox-dev |
| Mainnet | AWS KMS `ECC_NIST_P256` `SIGN_VERIFY` keys (primary, and a standby in a second region), non-exportable | staging (rehearsal), mainnet |

Mainnet KMS setup reuses D121's dedicated AWS account and its controls, with its own principals:

- A dedicated IAM user `hana-identity-signer` (Workers can't assume roles without another long-lived secret) whose only
  permission is `kms:Sign` on the identity key ARNs, with `kms:SigningAlgorithm = ECDSA_SHA_256` and `kms:MessageType =
  DIGEST`. Not the email issuer's principal: a leaked identity credential must not sign email tokens, and vice versa.
  The access key rotates every 90 days and on suspicion (`scripts/identity-key.ts rotate-aws-key`).
- Key policy: administration only by the break-glass role with MFA; deny `ScheduleKeyDeletion`, `PutKeyPolicy`,
  `CreateGrant` to everyone else; `kms:Sign` only for `hana-identity-signer`.
- CloudTrail (management events include `Sign`) to the log-archive account; EventBridge alerts on IAM or key-policy
  changes and on `Sign` by any other principal; an hourly reconciliation of `Sign` counts per key against the API's own
  `identity_issuance_hourly` counts (a gap is a critical alert: a signature Hana's API didn't count); volume and
  budget alarms.
- Signing: `digest = sha256(header ‖ "." ‖ payload)`, KMS `Sign` with `MessageType = DIGEST`, `SigningAlgorithm =
  ECDSA_SHA_256`, SigV4 via `aws4fetch` (as D121). KMS returns a DER `ECDSA-Sig-Value`; the adapter converts it to the
  64-byte JOSE `r ‖ s` form (left-padded, low-S not required by JOSE) and **verifies the result with the public key
  before answering**, so a wiring fault never reaches a partner.
- Mainnet never takes a Worker-secret key (`gen` refuses), as for the email issuer.

Why a non-exportable key even though the token reaches no funds: a forged token lets an attacker be any user at every
partner that uses it as login evidence (credit programs, referrals, a partner's own account system), for as long as the
key is trusted. With KMS a stolen Worker credential is revocable and every signature is counted; an exported key would
forge silently forever ([Q4](#open-questions-for-the-user)).

Figures (AWS, checked 2026-10-30): ECC requests $0.15 per 10,000 (RSA 2048 $0.03 per the email spec's 2026-10-29
check), asymmetric requests excluded from the free tier, $1 per key per month; ECC cryptographic operations 1,000 per
second per account and region by default, adjustable. At one token per active device-hour, 10,000 daily users with 4
device-hours each are 1.2 million tokens a month, about $18 (RS256: about $4); 100,000 such users about $180.
Latency: one KMS round trip (budget ≤ 100 ms p95 in `ap-east-1`, to measure on staging), off the login's critical path.

### JWKS and discovery

| Endpoint | Content | Headers |
|---|---|---|
| `GET {apiUrl}/v1/identity/jwks.json` | `{"keys":[…]}`: every key a token may currently be signed with (active, standby) plus, during a rotation, the next and the previous one; each `{kty:"EC", crv:"P-256", x, y, kid, use:"sig", alg:"ES256"}`, `kid` = RFC 7638 thumbprint | `cache-control: public, max-age=600`; CORS `*`; no cookies |
| `GET {apiUrl}/v1/identity/.well-known/openid-configuration` | `{issuer, jwks_uri, id_token_signing_alg_values_supported: ["ES256"], subject_types_supported: ["pairwise"], claims_supported: [...]}` | same |

Both are generated from the manifest's key list (public keys only), so the JWKS a Worker serves never depends on D1.
`max-age=600` matches `jose`'s `createRemoteJWKSet` default cache (10 minutes), which also refetches on an unknown
`kid` at most every 30 s: a newly published key is picked up at once, a removed key stops verifying within 10 minutes.

**Pinning (optional for partners).** The JWKS is served by Hana's Cloudflare account, so whoever controls that
account could publish a key of their own. Two defences: the **watchdog** (its own account, D125) fetches the JWKS
every run and raises a critical alert for any key whose thumbprint isn't in its pinned list (`watchdog.pinnedIdentityKeys`,
a redeploy by the operator to change); and partners may pin the published thumbprints instead of trusting the URL
(Hana announces rotations to their security contacts 14 days ahead, D96) ([Q13](#open-questions-for-the-user)). The
watchdog also alerts if an identity key's thumbprint ever appears among the contract's issuer keys (the contract must
never trust it).

### Rotation playbook

Scheduled (every 12 months, and when the KMS key policy or region changes):

1. Create the new key (KMS, or `scripts/identity-key.ts <env> next` on testnet, D177); add it to the manifest as `next`;
   add its thumbprint to the watchdog pins (operator redeploy); deploy: the JWKS now lists it, nothing signs with it.
2. Notify partners that pin thumbprints; wait ≥ 14 days (≥ 24 h on testnet).
3. Switch the signer to the new key (manifest `active`), deploy. Tokens signed by the old key stay valid until their
   `exp` (≤ 1 h).
4. After ≥ 2 h, remove the old key from the JWKS and the pins; on KMS, disable it and schedule deletion (30 days).

Suspected compromise (a stolen Worker secret or AWS credential, an unexplained reconciliation gap, a forged token
reported by a partner):

1. **Stop new signatures by the suspect credential**: revoke the IAM access key (mainnet) or delete the Worker secret
   (testnet). If the API Worker itself is suspect, follow the Cloudflare-account incident runbook first.
2. **Switch to a key the incident didn't touch** (amended 2026-10-30, D177): the standby (already in every partner's
   JWKS cache) only if it provably wasn't exposed. On testnet it is never on the Worker, so a Worker or Cloudflare
   leak doesn't reach it (`identity-key switch --to standby`); a leak of the operator's `.secrets/` does, and then both
   keys are removed and a fresh key replaces them (`retire --key standby`, `next`, `switch --to next`). Unless the
   incident provably touches only one key, treat both as exposed. Deploy: logins and refreshes continue.
3. **Remove the suspect key from the JWKS** and the pins. Partners using the JWKS URL reject its tokens within 10
   minutes; forged tokens with up to 1 h left die then too. The SDK's next refresh replaces every user's token
   (partners answer 401 to an old one; the page refreshes).
4. Tell partners (security contacts): the `kid`, the window in which forged tokens may have been accepted (from the
   reconciliation or CloudTrail), and what to re-check (emails recorded, credits granted, sessions opened in that
   window). Pinning partners must update their pins.
5. Create a new standby (the scheduled steps 1–2, shortened), rotate the access key, write the post-mortem (D83:
   every incident gets a portal guide).

The emergency is cheap for users (nothing changes for them) and bounded for partners by `exp` plus their JWKS cache.

## Verified email: opt-in per app

### What the partner and the user control

- **The partner** turns the claim on per app: D1 `apps.identity_email` `'off'` (default) or `'on'`, set by Hana with
  `admin app:settings --identity-email on|off` during the pilot and by the partner in the console later (batch C).
  Turning it off is immediate (the mint reads the setting; the vault endpoints' app cache bounds it to 30 s). Turning
  it on needs no delay: no user's email is shared until that user agrees.
- **The user** agrees or declines per app (not per device), once; the answer is stored off chain and can be changed
  at any time from Hana Home or through `requestEmailSharing()`.

### Where the address comes from

| Login | Source | When Hana reads it |
|---|---|---|
| Google | Google's userinfo endpoint (`email`, `email_verified`), with the access token the popup obtains when the app has `identity_email = 'on'` (or email login, which requests it anyway, D25 amended): `response_type=id_token token`, `scope=openid email` | Once per login, in the email issuer's `google-match` call (email spec), which already reads it transiently and revokes the access token. Only `email_verified: true` counts |
| Email (one-time code) | the address the user typed and proved with the code | Once per login, in the issuer's `/v1/email/verify` |

So the only Hana component that ever reads an end user's address from its source is `apps/email-issuer`, as the email
spec already allows (D25 and D96 as amended). The address put in the token is the address as verified (Google's value,
or the typed address trimmed with its domain lowercased and in IDNA ASCII form), **not** the Gmail canonical form the
issuer uses for its `sub` (partners would see `ab@gmail.com` for a user who typed `a.b@gmail.com`).

The on-chain Google token stays openid-only (D25): the claim allow-list keeps refusing an ID token with `email`.

### The sealed email (Hana stores nothing)

At login, when the app has the claim on, the issuer returns a **sealed email** with its normal answer:

```
sealed_email = "se1." ‖ b64url( key_id(4) ‖ u64le(not_after_ms) ‖ iv(12) ‖ ct )
ct           = AES-256-GCM(IDENTITY_SEAL_KEY[key_id], plaintext, aad)
plaintext    = json{ "email": "...", "src": "google" | "email" }
aad          = "hana-id/sealed-email/v1" ‖ 0x00 ‖ borsh(app_id) ‖ session_pk(32) ‖ u64le(not_after_ms)
not_after_ms = the session's on-chain expiry
```

- The issuer knows `session_pk` because both calls carry the session nonce's commitment, which it checks against the
  token it verifies (the Google ID token's nonce, or the email challenge's commitment). So the address is bound to the
  session the same person opens.
- The vault stores the blob in its IndexedDB record (and memory) and sends it with each mint. It can't read it; neither
  can the partner page (it never leaves the vault).
- The API opens it at mint time only if the app's setting is `'on'` **and** the user's consent for `(app, sub)` is
  `granted`; then puts `email` and `email_verified: true` in the token; the plaintext lives only in that request's
  memory and is never logged. A blob for another app, session or after `not_after_ms` fails to open.
- `IDENTITY_SEAL_KEY` (32 bytes, with a 4-byte id) is a secret of both the issuer and the API Worker. Rotation is cheap:
  a new id seals from then on, the previous key opens for 24 h, then old blobs simply give no email until the user's
  next login.
- A Google user's address changes at Google → the next login seals the new one. Partners should key users on `sub`, not
  on email.

### Consent flow ([Q6](#open-questions-for-the-user), [Q7](#open-questions-for-the-user))

Proposed: **asked once per app, at the first login where it is unknown, in the Hana popup; optional; remembered.**

1. The app has `identity_email = 'on'`. The login popup (`/login`) requests the `email` scope from Google (Google's own
   screen shows the email permission the first time for that Google client; with Hana's shared client that screen names
   Hana, not the partner, which is why Hana asks separately).
2. On return, `/login/callback` (already allowed to call the API) sends `POST /v1/identity/email-consent/lookup
   {pk, idToken}` (for email login, `/login/email` sends the issuer's email token after `verify`). The API verifies the
   token (signature, `aud` is a client of the app's scope or a shared client with `allow_shared`, `exp`), resolves the
   account root (`get_identity` once linking exists), computes `sub`, and answers `granted`, `declined` or
   `not_asked`. Nothing else is revealed: the caller already holds a valid token for that account.
3. `not_asked` → the popup shows one screen before relaying: "**{App name}** (named by the app, D44/D118 display rules)
   would like your email address **ada@example.com**. [Share email] [Not now]", with a line: "{App} can then email you
   and use it to recognise you. You can stop sharing in Hana Home." Both buttons continue the login; the guarded-click
   rules of the approval popup apply to "Share email" (D36). The address shown is the one the popup already has
   (typed, or from the access token's userinfo call the callback makes for display only, then discarded).
4. The decision travels in the encrypted relay payload to the vault, which records it after login with
   `POST /v1/identity/email-consent {sessionProof, decision}` (the session now exists, so the API binds the decision to
   the account through the session, not through the popup's word).
5. `granted` / `declined` → no screen at later logins on any device. A user who declined can be asked again only by
   the partner's `requestEmailSharing()` (a click, a Hana popup with the same screen; a second "Not now" is final until
   the user changes it in Hana Home).

### Storage and revocation

- D1 `identity_email_consents (app_id, sub_bytes, state, decided_at)`, one row per app and account, no email, no
  device. Deleted with the app (+30 days, as batch C's `app_users`) and by `admin identity:consent:erase`.
- **Revoke**: Hana Home lists "Email shared with {app}" for each app with `granted` and offers "Stop sharing"; the
  popup screen of `requestEmailSharing()` offers it too. Revoking sets `declined`; from the next mint (the vault drops
  its cache on `emailSharingChanged`; other devices' cached tokens end within ≤ 1 h) tokens carry no email.
- **What revocation can't do**: the partner already received the address in earlier tokens and may have stored it
  (Wend does). Hana says so on the revoke screen ("{App} may keep the address it already received; ask {App} to delete
  it"). Partners' privacy duties for the stored address are theirs (their own privacy policy); Hana's partner terms
  should require deleting it on request.
- Usage counts (`usage.identity_emails`) per app and day, for the partner console; never per user.

## Logout, revocation and expiry

| Event | New tokens | Tokens already issued | What the partner should do |
|---|---|---|---|
| `hana.logout()` | refused (share revoked; `'none'`: the vault forgets the key) | valid until `exp` (≤ 1 h) | End its own session when its page reports the logout (`statusChanged`, `identityTokenChanged(null)`). Don't rely on token expiry for logout |
| A new login on the device | the new session gets a new `sid` | the old `sid`'s tokens valid until `exp` | Treat a new `sid` for the same `sub` as a new device session (Wend: supersede by `sid`) |
| `revokeOtherDevices()` | refused for the other shares | valid until `exp` | If it matters, require a fresh token (`maxAgeMs`, check `iat`) before sensitive actions |
| Session idle or absolute expiry | refused (`410`) | `exp` was capped at the session end | Treat as logged out |
| Consent revoked | no `email` | earlier tokens keep their `email` until `exp` | Stop using the stored address if the partner's terms say so |
| App suspended, origin removed | refused | valid until `exp` | — |
| Emergency: contract paused, `set_sessions_valid_from_ms` raised | refused for affected sessions | valid until `exp`; a key rotation kills them if needed | Follow Hana's incident notice |

On a token the backend can't use:

- `exp` passed (`jose` `JWTExpired`): answer 401 with a distinct code (Wend's `EXPIRED_…` pattern); the page calls
  `getIdentityToken()` again (the SDK refreshes) and retries once. `null` → the user is logged out.
- signature, `iss`, `aud` or `typ` wrong: 401, fail closed, never degrade to "no token".
- `iat` older than the action's freshness requirement: 401 with a "fresh token required" code; the page calls
  `getIdentityToken({ maxAgeMs })`.

There is no revocation list and no introspection endpoint in v1 ([Q10](#open-questions-for-the-user)): the bound is 1
hour plus the partner's own session handling, and `maxAgeMs` gives a stateless liveness check when a partner needs it.

## Relation to email login and account linking

- **One account, several methods, one `sub`.** `sub` comes from the account root (the identity whose path is the
  wallet). A linked identity opens the root's path, so Google and email logins of one account give the same `sub` and
  `wallets` (D119, D122).
- **Linking never changes a `sub`**: case A (Google joins an email account) — the Google identity had no wallet, so no
  `sub`, before; case B (email joins a Google account) — the root stays Google. Explicit `linkAccount()` joins the
  linker's account to the existing root likewise. `login_methods` gains the new method at the next mint after the link
  is **active** (pending links aren't listed).
- **Unlinking** returns an identity to its own path: a different wallet, so a different `sub` at the partner. That is
  correct (a different wallet is a different user to the partner) and is said in the partner guide.
- Apple (D124) adds provider `apple`; nothing here changes.
- The email claim's source depends on how this session logged in (`src`), not on which methods the account has.
- Hana Home is not a partner and gets no identity tokens.
- Build dependency: the email claim needs the email issuer's `google-match` (for Google users) and `verify` (for email
  users); the rest of this batch does not. See [Build order](#build-order).

## Privacy

- **No cross-app linkage by Hana's ids**: `sub` is a keyed HMAC per scope, `sid` per app; addresses are per scope by
  derivation. Two partners comparing their tokens learn nothing linkable from Hana's claims. They can still link users
  through what users give both (the same email shared with both, the same external address), and through timing.
- **Not reversible by partners**: a partner can't get the Google `sub`, the path, the session key or the scope from a
  token; without `IDENTITY_SUB_KEY` a `sub` can't be tested against on-chain paths.
- **Minimal claims**: nothing a partner can't already see (its own users' addresses from the page) except `sub`,
  `sid`, `login_methods` and, by consent, the email.
- **What Hana stores**: consent rows `(app_id, sub, state, time)`; hourly mint counts per key; per-app daily usage. No
  per-token log, no email, no addresses, no `sub` in logs. Request logs carry the app id, outcome, `kid` and timings.
- **What Hana can do**: Hana holds `IDENTITY_SUB_KEY` and can always map a partner's `sub` back to a path (as it can
  map `uid`s, batch C). A leak of the key lets the holder do the same: privacy, not funds.
- **Email**: read only by the issuer at login, opened only by the API at mint time, only with consent, never stored or
  logged by Hana; the consent screen names the app and the address; revocable; the partner's copy is the partner's
  responsibility.
- Retention: consent rows while the app exists (+30 days); mint counts 24 months (D90 raw usage).

## Threat model

| Threat | Effect | Mitigation | Residual |
|---|---|---|---|
| Token stolen in transit or from a partner's logs | Act as the user **at that partner's backend** for ≤ 1 h | TLS; short `exp`; `aud`-bound; the guide says never log tokens; partners bind sensitive actions to a wallet signature or fresh `iat` | Within 1 h the thief is the user at that partner, as with Privy's tokens |
| XSS or a malicious dependency on the partner page | Mint tokens silently while the session is live, send them away | Same origin rules as today; the token gives nothing at Hana; it lives only while the session does | Equivalent to the page's existing power (it already drives the vault) |
| Replay at another partner | Partner B accepts A's token | `aud` check (the guide's first rule); `sub` and `wallets` differ per scope anyway | A partner that skips `aud` is vulnerable; the guide and the example make `audience` mandatory |
| Replay against Hana | Use the token to open a session, derive, or call an API | No Hana API accepts it: different `iss`, `typ`, and a key the contract never holds (watchdog alert if it ever appears); the API's JWT verifiers accept only Google and email issuers | none known |
| Replayed session proof | A second token for the same session | ±60 s clock window, single-use marker per proof signature | A thief of a proof (TLS break) gets one token, ≤ 1 h |
| Malicious user, tampered vault | Claim an address they don't hold, or an email they don't own | Wallet proofs need the address's key; the email is sealed by the issuer under a key the vault never sees | They can attach another key **they control**, never a victim's |
| Compromised partner backend | Its own users' tokens: `sub`, addresses, consented emails | That data is the partner's already; can't use tokens elsewhere (aud) or at Hana; can't correlate across partners | Its users' data at that partner |
| Signing key misuse (stolen Worker secret on testnet; KMS credential or API compromise on mainnet) | Forge tokens for any user of any app | KMS non-exportable, IAM limited to `kms:Sign`, CloudTrail reconciliation, budget alarms; [rotation playbook](#rotation-playbook) | While the attacker holds the credential (and ≤ 10 min of partner caches after removal), forged tokens pass at partners |
| Hana Cloudflare account compromise | Publish an attacker key in the JWKS; mint anything | Watchdog pins the JWKS on its own account (critical alert); partners may pin thumbprints; the API's other powers (vault page, bundles) are the larger risk and unchanged | Partners that trust the URL accept the attacker's key until the alert is acted on |
| `IDENTITY_SEAL_KEY` leak | Seal a fake "verified" email for the attacker's **own** session; read sealed blobs captured from devices | Needs a valid session proof too; held only by two Workers; rotatable | A fake verified email at partners trusting it until rotation (e.g. credit-program fraud): treat a seal-key leak like a signing-key incident |
| `IDENTITY_SUB_KEY` leak | Map partners' `sub`s to on-chain paths (Google `sub`) | Worker secret on the API only, offline backups, never logged | Not rotatable without a `u2_` migration; privacy only |
| Email issuer compromise | Seal false emails for Google users' sessions too | Same trust as the issuer's existing power (it can mint email logins); the seal grants no wallet | A new, narrower power: false email claims |
| Mint flood (cost, KMS quota) | KMS spend, throttling | Per-session, per-IP and per-app limits, a global hourly ceiling with a breaker and a critical alert, KMS budget alarms | A breaker trip refuses mints (partners fall back to no token) until it resets |
| Cross-JWT confusion (alg `none`, HS256 with the public key) | Accept a forged token | The guide pins `algorithms: ['ES256']`; `jose` refuses `none`; `typ` checked | Partners with hand-rolled verifiers |
| Consent forgery | Share a user's email without their consent | The consent is recorded only with a session proof from that user's vault; the popup screen is Hana's; the partner page can't answer it | A user's own tampered vault can only consent for themselves |

## Partner verification guide (Node, `jose`)

The partner guide (`docs/integration.md`, new section when built) gives this, plus the same checks in prose for other
languages.

```ts
import { createRemoteJWKSet, errors, jwtVerify, type JWTPayload } from 'jose';

// From Hana's partner console / your Hana app page. Not secrets.
const HANA_ISSUER = process.env.HANA_IDENTITY_ISSUER!; // e.g. https://<hana api>/v1/identity
const HANA_APP_ID = process.env.HANA_APP_ID!;          // app_…

// Caches the keys for 10 minutes and refetches on an unknown kid (at most every 30 s).
const hanaKeys = createRemoteJWKSet(new URL(`${HANA_ISSUER}/jwks.json`));

export interface HanaIdentity {
  userId: string;                                   // sub: stable per user in your app
  sessionId: string;                                // sid: one per Hana session (device)
  wallets: { chain: 'stellar' | 'evm'; address: string }[];
  email: string | null;                             // only if the user agreed to share it with you
  loginMethods: string[];
  issuedAt: number;                                 // seconds
}

export class HanaTokenError extends Error {
  constructor(readonly code: 'expired' | 'invalid' | 'stale') { super(code); }
}

export async function verifyHanaIdentityToken(token: string, opts: { maxAgeSec?: number } = {}): Promise<HanaIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, hanaKeys, {
      issuer: HANA_ISSUER,
      audience: HANA_APP_ID,            // mandatory: a token for another app must fail
      algorithms: ['ES256'],
      typ: 'hana-identity+jwt',
      requiredClaims: ['sub', 'sid', 'iat', 'exp', 'wallets'],
      clockTolerance: 30,
      ...(opts.maxAgeSec ? { maxTokenAge: opts.maxAgeSec } : {}),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new HanaTokenError(opts.maxAgeSec && e.claim === 'iat' ? 'stale' : 'expired');
    throw new HanaTokenError('invalid');  // fail closed
  }
  const wallets = Array.isArray(payload.wallets) ? (payload.wallets as HanaIdentity['wallets']) : [];
  return {
    userId: payload.sub!,
    sessionId: payload.sid as string,
    wallets,
    email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : null,
    loginMethods: Array.isArray(payload.login_methods) ? (payload.login_methods as string[]) : [],
    issuedAt: payload.iat!,
  };
}

// Bind the token to the request's wallet when the wallet also authenticated (e.g. a signed challenge):
export function assertWallet(identity: HanaIdentity, chain: 'stellar' | 'evm', address: string): void {
  const ok = identity.wallets.some((w) => w.chain === chain &&
    (chain === 'evm' ? w.address.toLowerCase() === address.toLowerCase() : w.address === address));
  if (!ok) throw new HanaTokenError('invalid');
}
```

Rules the guide states:

1. Always check `aud` (your app id), `iss`, `typ`, `alg`; use the JWKS URL (or pinned thumbprints) — never a key from
   the token header.
2. Key users by `sub`, not by email or address. Store `sid` to run one session per device and to block a signed-out
   `sid`; a new interactive login always brings a new `sid`.
3. The token is evidence of identity at `iat`, not your session: run your own session, and end it when your page
   reports a Hana logout. For sensitive actions require a fresh token (`maxAgeSec`, the page passes `maxAgeMs`).
4. Never log tokens or emails; treat `email` as personal data you received by the user's consent.
5. Expect `email` to be absent (not enabled, not shared, or shared later) and to change.
6. Expected verify time: < 1 ms after the JWKS is cached.

## Migrating from Privy

| Privy | Hana | Notes |
|---|---|---|
| Access token `sid` | `sid` | Same semantics: stable for one session across tabs/reloads, new at interactive login, never repeats. Hana's session lasts ≤ 12 h (default) / 2 h idle, Privy's up to the refresh token's 30 days |
| Access token `sub` / identity token `sub` (`did:privy:…`) | `sub` (`u1_…`) | Per scope. Existing Privy users get **new** wallets with Hana (different keys); map old users to new `sub`s by verified email at their first Hana login (the partner's job; Hana has no Privy data) |
| `iss: "privy.io"` | `iss: "<Hana api>/v1/identity"` | From the partner's app page |
| `aud: <Privy app id>` | `aud: app_…` | |
| Two tokens (access + identity), one key | One identity token | Wend's `verifyPrivyAccessToken` and `verifyPrivyIdentityToken` become one `verifyHanaIdentityToken` |
| `linked_accounts` (stringified JSON) | `wallets` (JSON array), `email`, `login_methods` | No string parsing |
| `linked_accounts[type=email].address` | `email` (with consent; also for Google logins) | Wend's `privyEmail` → a `hanaEmail` column; lowercase as today |
| `linked_accounts[type=google_oauth].{subject,email,name}` | `email` only | No Google `subject`, no name: by design |
| `linked_accounts[type=wallet, chain_type=stellar].address` | `wallets[chain=stellar].address` | Wend's wallet-binding check maps directly |
| `linked_accounts[type=wallet, chain_type=ethereum].address` | `wallets[chain=evm].address` | EIP-55 |
| `custom_metadata` | — | Not offered |
| Verification key pasted from the dashboard (SPKI PEM, ES256) | JWKS URL (`createRemoteJWKSet`) or pinned thumbprints | Rotation needs no config change with the URL |
| `privy-id-token` cookie / header | Header (`Authorization: Bearer`) | No cookie in v1 (Q11) |
| `getAccessToken()`, `getIdentityToken()`, `useIdentityToken()` | `hana.getIdentityToken()`, `useIdentityToken()` | |
| Refresh token (opaque, 30 days) | — | The live Hana session refreshes |
| Identity token lifetime 1 h / 10 h (docs disagree) | ≤ 1 h, capped at the session end | |
| `JWTExpired` soft handling (stale cached token) | Same; the SDK refreshes before handing out a token with < 5 min | |

For Wend specifically: `privySid` → `hanaSid` (same supersede, kick and lapse rules); `AUTH_REQUIRE_PRIVY_TOKEN_WEB`
→ an equivalent flag; `/api/user/auth`'s `privyIdToken` → `hanaIdToken`, statuses unchanged (`VERIFIED`, `NO_TOKEN`,
`EXPIRED_TOKEN`, `WALLET_MISMATCH`, `NO_EMAIL`); credit programs and funnel leads keep keying on the verified email.
Users who don't share their email produce `NO_EMAIL`; Wend can call `requestEmailSharing()` at onboarding.

## API endpoints

All under `apiUrl`, JSON, `cache-control: no-store` unless stated, `x-request-id` as today, no cookies.

### `POST /v1/identity/token` (vault only)

Headers `x-hana-key`, `x-hana-parent-origin`; `Origin` must be `VAULT_ORIGIN` (CORS and preflight as `/v1/vault/*`).

Body (exactly; ≤ 4 KiB):

```json
{ "sessionPublicKey": [32], "issuedAtMs": 0, "nonce": [16], "signature": [64],
  "walletProofs": { "stellar": { "address": "G…", "signature": [64] },
                    "evm": { "address": "0x…", "signature": [65] } },
  "sealedEmail": "se1.…" }
```

Order: the vault gate (key, active, Origin, parent allowed, `scope_conflict`, vault per-IP and per-app limits) → body
shape (`400 bad_request`) → clock (`400 stale_proof {serverTimeMs}`) → session signature (`401 invalid_signature`) →
per-session limit (`IDENTITY_SESSION_LIMIT` binding, 10 per minute per `session_pk`, per location) → single-use
marker (`409 proof_replayed`) → `get_config` not paused (`503 paused`) → share checks in `'session'` mode
(`410 session_ended` with `reason`: `unknown_share`, `share_revoked`, `share_expired`, `persistence_off`) → chain
session (`410 session_ended` `reason: no_session`; `403 scope_mismatch`; `502 near_unavailable`) → `exp` ≥ now + 30 s
(`410 session_ending`) → wallet proofs (`400 bad_wallet_proof {chain}`) → email (never an error: `emailStatus`) →
global hourly ceiling (`503 identity_busy`, critical alert) → sign and self-verify (`503 identity_signer_unavailable`)
→ `200 {identityToken, expiresAtMs, emailStatus}`; usage and the hourly count after the response (`waitUntil`).

`emailStatus`: `off` (app setting), `not_asked`, `declined`, `missing` (no blob: e.g. a login before the setting was
turned on), `invalid` (blob for another session, expired or unreadable), `included`. The vault surfaces it in
`hana_status` diagnostics; it never contains the address.

### `POST /v1/identity/email-consent` (vault only)

Body: the same session proof fields (payload `"email-consent" ‖ borsh(decision)`) plus `decision` ∈ `granted`,
`declined`. Upserts `identity_email_consents` for `(app_id, sub)`; `409 identity_email_off` when the app setting is
off. `200 {state}`. Rate: 10 per hour per session.

### `GET /v1/identity/email-consent` (vault only)

Session proof in headers (`x-hana-identity-proof`, the same fields b64url); `200 {state}` for `emailSharing()`.

### `POST /v1/identity/email-consent/lookup` (auth pages only)

`Origin: AUTH_ORIGIN`; body `{pk, idToken}` (a Google ID token or a Hana email token just obtained by the popup).
Verifies it (signature, `iss`, `aud` a client of the app's scope or a shared client the scope allows, `exp`; no nonce
check needed), resolves the account root, answers `200 {state}`. Per-IP 30 per 10 min (binding). The token is never
logged or stored.

### Public

`GET /v1/identity/jwks.json`, `GET /v1/identity/.well-known/openid-configuration` ([JWKS](#jwks-and-discovery)).

### Email issuer additions (`apps/email-issuer`, email spec)

`/v1/email/google-match` and `/v1/email/verify` gain `identityEmail: true` in the request (the vault or popup sets it
when the app setting is on; the issuer re-reads the app row) and return `sealedEmail` (bound to the commitment's
session key and the app). Before email login ships, the issuer may run with `google-match`'s userinfo-and-seal part
only ([Build order](#build-order)).

### Refusals elsewhere

Every JWT-accepting path (`/v1/login`, `/v1/sessions`, `/v1/owner-actions`, the email issuer) refuses a token whose
`typ` is `hana-identity+jwt` or whose `iss` is the identity issuer before anything else (`400 bad_token`), with tests.

## D1 schema, manifest and secrets

Migration `00NN_identity_token.sql` (number at build time):

| Change | Columns |
|---|---|
| `apps` | `identity_email TEXT NOT NULL DEFAULT 'off' CHECK (identity_email IN ('off','on'))` |
| new `identity_email_consents` | `app_id TEXT NOT NULL`, `sub BLOB NOT NULL CHECK (length(sub) = 16)`, `state TEXT NOT NULL CHECK (state IN ('granted','declined'))`, `decided_at INTEGER NOT NULL`; PK `(app_id, sub)` |
| new `identity_issuance_hourly` | `hour INTEGER NOT NULL` (ms at the hour), `kid TEXT NOT NULL`, `count INTEGER NOT NULL`; PK `(hour, kid)`; 24 months |
| `usage` | `identity_tokens INTEGER NOT NULL DEFAULT 0`, `identity_emails INTEGER NOT NULL DEFAULT 0` |

The vault record (`hana-vault/records`, IndexedDB) gains `walletProofs` and `sealedEmail` (record format v2, read
compatibly; a v1 record gets its proofs at the next unlock, which has PRK).

Manifest (`packages/env`): `identityToken: { iss, signer: { kind: "worker-secret" } | { kind: "aws-kms", awsRegion,
keys: { active, standby, next?, previous? } }, publicKeys: [JWK…] }`; `gen` refuses `worker-secret` for a mainnet env
and a key list whose public keys don't match the signer config. `watchdog.pinnedIdentityKeys: [thumbprint…]`.

Secrets (all generated by `scripts/identity-key.ts`, into `.secrets/<env>/` with 0600 and the Worker, never printed):

| Secret | Held by | Rotation |
|---|---|---|
| `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY` (testnet) / `IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY` (mainnet) | API Worker | [Playbook](#rotation-playbook); AWS key every 90 days |
| `IDENTITY_SUB_KEY` (32 bytes) | API Worker; offline backup | never (a `u2_` migration if leaked) |
| `IDENTITY_SEAL_KEY` (`<id>:<32 bytes>`, `IDENTITY_SEAL_KEY_PREVIOUS` during rotation) | API Worker and email issuer | on suspicion; 24 h overlap |

## Invariants

1. A token is minted only for a session that is live on chain and (in `'session'` mode) whose share is live, for the
   app's own scope, while the contract is not paused, with a fresh, single-use session-key signature.
2. A token never outlives its session at mint time and never lasts more than 1 hour.
3. Every address in `wallets` was proven by its own key for this session and app.
4. `email` appears only if the app's setting is on, the user's consent for that app is `granted`, and a sealed blob
   bound to this session and app opens; only Google-verified or code-verified addresses are sealed.
5. `sub` depends only on `(scope, account root identity)`, never on the login method, client, device or `key_index`;
   it never equals or reveals the Google `sub`.
6. No Hana API and no contract method accepts an identity token; the identity key never signs anything else and never
   appears on chain.
7. Hana stores no email address, token, or per-token record; logs never carry a token, email, `sub`, `sid` or address.
8. A mint never slides `idle_until`, moves a share counter or restarts the vault's in-memory idle timer.

## Tests

Core (`packages/core`, vitest):

- `sub`, `sid`, sealed-email AAD and the identity and wallet-proof message layouts against frozen vectors
  (`vectors/identity-v1.json`), cross-checked by an independent Node implementation; `key_index` ignored; linked path
  (email root) and Google root; refusal of malformed paths (not exactly three parts after the scope).
- Claim builder: exactly the listed claims; `email` never without `email_verified`; sorted `login_methods`; `exp`
  capping rules; refusal below 30 s.

API (`apps/api`, vitest with miniflare):

- Every step of `/v1/identity/token` in order with its error code; a proof older or newer than 60 s; replayed proof;
  wrong `app_id`/signer in the message; signature by another key.
- Share states: revoked, idle-expired, absolute cap lowered by settings, persistence switched to `'none'`, origin
  removed; `'none'` mode with chain-only checks; chain session null after `set_sessions_valid_from_ms`; paused contract.
- Mint doesn't change `counter` or `idle_until` (row compared before and after).
- Wallet proofs: valid, swapped addresses, a proof for another session, EVM recovery to a different address, non-EIP-55
  input normalized.
- Email: off, not asked, declined, granted with a valid blob, blob for another app or session, expired blob, previous
  seal key within and after 24 h, the address never in logs (log capture asserts absence of email, token, `sub`, `sid`).
- Consent endpoints: lookup with Google and email tokens, wrong `aud`, expired token; upsert; per-app isolation.
- JWKS and discovery: exact JSON, `kid` thumbprints, cache headers, CORS `*`, public keys only (no `d` ever).
- Signer adapters: WebCrypto ES256 round trip; KMS adapter against a fake KMS (DER → JOSE conversion, high-S and
  short-`r` cases, refusal when the self-verify fails); `gen` refusing worker-secret on mainnet.
- Cross-use refusals: an identity token at `/v1/login`, `/v1/sessions`, owner actions and the email issuer.
- Limits: per-session binding, global ceiling breaker; no cookies (`no-cookies.test.ts` covers the new routes).

Web and React:

- Vault: proofs made at login inside `withChainKey` and stored; refresh while dormant uses stored proofs (no PRK
  access); cache shared over BroadcastChannel; Web Lock serializes mints; `maxAgeMs`; cache dropped on logout, newer
  login, expiry, consent change; `identityTokenChanged(null)` at logout; mint isn't activity (idle timer unchanged).
- Client: `getIdentityToken()` resolves null when logged out; error mapping; `requestEmailSharing()` opens the popup
  in the click and falls back to the launcher.
- Popup: consent screen shown only for `not_asked`, guarded "Share email", name display rules (D118), decision in the
  relay payload; `/login` still makes no API call (D77).
- React `useIdentityToken`: re-render on events, refresh timer only while visible.

Playwright (Chromium, WebKit, Firefox) against local builds: login → token → a verifier using `jose` and the local JWKS
accepts it; reload keeps `sid`; new login changes `sid`; logout stops refreshes; email consent granted → `email`
present; revoke → absent at next mint; a stub email issuer for the email-login path.

Example verifier (`examples/identity-verify/`, Node): the guide's code with tests, so the published guide always runs.

Testnet (sandbox-dev): KMS-free path end to end; staging: KMS latency and reconciliation drill; a rotation drill and a
compromise drill (standby switch, JWKS removal, watchdog alert on an unpinned key).

## Build order

Sizes are rough (lines of code including tests; days of focused work).

| # | Step | Depends on | Size |
|---|---|---|---|
| 1 | Core: layouts, `sub`/`sid` derivation, vectors, claim builder, sealed-email format | — | 0.6k, 2 d |
| 2 | API: `IdentitySigner` (WebCrypto ES256), JWKS and discovery, `/v1/identity/token` without email, limits, migration, usage and hourly counts, cross-use refusals; `scripts/identity-key.ts` | 1 | 1.4k, 4 d |
| 3 | Vault and SDK: wallet proofs at login, record v2, cache, BroadcastChannel and lock, `getIdentityToken`, events; React hook | 1, 2 | 0.9k, 3 d |
| 4 | Partner guide, example verifier, Playwright, reference docs (`api.md`, `architecture.md`, `security.md`, `integration.md`, `operations.md`); deploy to sandbox-dev; Wend trial on testnet | 2, 3 | 0.6k, 2 d |
| 5 | Email claim, consent: `identity_email` setting, consent endpoints and table, popup consent screen, `emailSharing` / `requestEmailSharing`, Hana Home "Stop sharing" (with Home) | 2, 3 | 1.0k, 3 d |
| 6 | Email claim, sealing: the issuer's seal in `google-match` and `verify`, the API's unseal; the Google `email` scope spike is the email spec's step 0 (shared) | email spec steps 0–2 (or a minimal issuer with only `google-match`), 5 | 0.5k, 2 d |
| 7 | Mainnet hardening: KMS keys and IAM in D121's AWS account, the KMS adapter, CloudTrail reconciliation and alarms, rotation and compromise drills on staging | 2, D121 infra | 0.5k, 2 d |
| 8 | Watchdog: JWKS pin check and "identity key on chain" check, portal rendering (D83) | 2 | 0.3k, 1 d |

Total about 5.8k lines and 19 days. Steps 1–4 deliver tokens without email (enough for Wend's `sid`, `sub` and
wallets); 5–6 add the email; 7 is required before mainnet; 8 before partners rely on it in production.

## Docs to update when built

`api.md` (endpoints, schema, bindings, limits), `architecture.md` (component table, flow, data stores), `security.md`
(parties, compromise table, key inventory: the three new secrets, invariants), `integration.md` (a section on the
identity token and the verification guide; Google consent wording), `operations.md` (keys, rotation and compromise
playbooks, `admin app:settings --identity-email`), `contract-interface.md` (nothing changes on chain; note that the
contract never accepts the token), `decisions.md` (the answers), `docs/README.md` (status of this spec).

## Sources

Hana: `docs/decisions.md` D8, D10, D12, D25, D38, D42, D43, D51, D55, D61, D70, D77, D81, D83, D90, D96, D112, D119–D125;
`docs/architecture.md`, `docs/api.md`, `docs/security.md`, `docs/integration.md`, `docs/email-login-spec.md` ("Signing
key (staged)", "How the popup gets Google's verified email", "Sessions"), `docs/batch-c-spec.md` (uid), `docs/hana-home-spec.md`
(Support ID); code `packages/web/src/client/client.ts`, `packages/react/src/hooks.ts`, `packages/web/src/vault/`.

Wend (read only): `wend-api` `src/auth/privy.ts`, `src/user/privy-identity.ts`, `src/auth/session.ts`,
`src/user/routes.ts`, `src/auth/privy-admin.ts`, `docs/reference/AUTHENTICATION.md`, `docs/reference/ACTIVE_SESSIONS.md`.

External (read 2026-10-30):

- Privy, identity tokens: <https://docs.privy.io/user-management/users/identity-tokens>
- Privy, access, refresh and identity tokens: <https://docs.privy.io/authentication/user-authentication/tokens>
- Privy, verifying access tokens: <https://docs.privy.io/guide/server/authorization/verification>
- Privy, the user object and linked accounts: <https://docs.privy.io/user-management/users/the-user-object>
- Privy, legacy identity-token guide: <https://docs-legacy.privy.io/guide/react/users/identity-token>
- AWS KMS pricing: <https://aws.amazon.com/kms/pricing/>
- AWS KMS request quotas: <https://docs.aws.amazon.com/kms/latest/developerguide/requests-per-second.html>
- `jose` `createRemoteJWKSet` options: <https://github.com/panva/jose/blob/main/docs/jwks/remote/interfaces/RemoteJWKSetOptions.md>
- OpenID Connect Core 1.0 §8.1 (pairwise identifiers): <https://openid.net/specs/openid-connect-core-1_0.html#PairwiseAlg>
- RFC 8725 §3.11 (explicit typing): <https://www.rfc-editor.org/rfc/rfc8725#section-3.11>
- RFC 7638 (JWK thumbprint): <https://www.rfc-editor.org/rfc/rfc7638>

## Open questions for the user

All answered 2026-10-30 (D127): A for every question. While answering Q7 the user asked whether optional sharing could
split a person into two wallets: it can't. Wallet matching and linking (D119, D122) run inside Hana at every Google
login from Google's verified address, read transiently and kept only as an HMAC, whether or not the user shares the
email with any partner; sharing only adds the `email` claim to that app's tokens.

Each question stands alone: the options, what each costs, and the recommendation. Answer by number ("Q3: B").

1. **How wide is a `sub`?** The pseudonymous user id must stay stable for a user and must not let two partners match
   their users.
   - A. **Per scope** (recommended): apps of one scope (a partner's web and mobile apps) see the same `sub`. They
     already see the same wallet addresses, so a narrower id would hide nothing. Matches batch C's `uid`.
   - B. Per app: every app id gets its own `sub`, even within a scope. Protects nothing extra (the addresses link them)
     and breaks a partner's web/mobile user matching.
   - C. Per partner organization (batch C orgs): one `sub` across all the org's scopes. Lets a partner link a user's
     wallets across its own scopes, which have different wallets precisely to keep them apart; and an org's scopes can
     change owners.
   **Answered 2026-10-30: A (D127).** Recommendation was A.

2. **Signing algorithm.**
   - A. **ES256** (recommended): Privy parity (Wend's code changes one line), 64-byte signatures, every library, KMS
     `ECC_NIST_P256`. KMS cost $0.15 per 10,000 tokens (about $18/month at 10,000 daily users).
   - B. RS256: reuses the email issuer's RSA KMS code path, $0.03 per 10,000 (about $4/month at the same volume), but
     342-character signatures and no parity with Privy.
   - C. EdDSA (Ed25519): compact and fast, but KMS supports Ed25519 keys only recently and some partner stacks
     (older `jsonwebtoken`) don't verify it.
   **Answered 2026-10-30: A (D127).** Recommendation was A; the cost difference is small at our scale.

3. **Which Worker mints the token?**
   - A. **The API Worker** (recommended): it already has the app rows, shares, chain views and vault gate; the key is
     protected by KMS on mainnet, so an API compromise can mint while it lasts (logged and reconciled) but can't steal
     the key. No new deploy unit.
   - B. A separate `apps/identity` Worker behind a service binding: keeps the signing credential out of the API's
     secrets, but the API (or whatever calls it) still decides what gets signed, so it adds a Worker for little real
     separation.
   - C. Inside the email issuer: the issuer is the most sensitive Worker (it can reach email wallets); putting a
     high-volume, partner-facing path there enlarges its surface.
   **Answered 2026-10-30: A (D127).** Recommendation was A.

4. **Key storage on mainnet.**
   - A. **AWS KMS, non-exportable, in D121's AWS account with its own IAM user** (recommended): a stolen credential is
     revocable and every signature counted; about $1 per key per month plus requests.
   - B. A Worker secret in production too: free and < 5 ms, but anyone who can read the Worker's secrets once can forge
     every user's identity at every partner forever, undetected.
   **Answered 2026-10-30: A (D127).** Recommendation was A (and B only on `local*`/testnet, as for the email issuer).

5. **Token lifetime.**
   - A. **1 hour, capped at the session's end** (recommended): D120's ceiling, Privy's access-token default; one KMS
     signature per active device-hour.
   - B. 15 minutes: a stolen token is shorter-lived and logouts reach partners faster, but 4× the mints and cost, and
     more refresh traffic from background tabs.
   - C. Longer (Privy's identity-token default is 10 hours): fewer mints, but exceeds D120 and lets a token outlive
     logouts by hours.
   **Answered 2026-10-30: A (D127).** Recommendation was A, with `maxAgeMs` for partners that need fresher proof.

6. **When is the user asked to share their email?**
   - A. **At the first login for that app, in the Hana popup, optional, remembered per app** (recommended): one extra
     screen once per user and app; partners like Wend get the email for most users from the start. Costs one API
     lookup from the callback page (≈ 0.1–0.3 s) and the screen.
   - B. Only when the partner calls `requestEmailSharing()` in a click: simplest login, but an extra popup at
     onboarding, and partners that ask after an `await` hit the launcher fallback.
   - C. No Hana screen; Google's consent screen is enough: with Hana's shared Google client that screen names Hana, not
     the partner, and appears only once per Google client, so users wouldn't know which apps get their address.
   **Answered 2026-10-30: A (D127).** Recommendation was A, plus `requestEmailSharing()` to ask again after a decline.

7. **Can a partner make email sharing mandatory?**
   - A. **No, always optional in v1** (recommended): "Not now" always continues the login; the wallet stays usable;
     partners that need an email ask for it in their own UI or call `requestEmailSharing()`.
   - B. A `required` app setting where declining ends the login: some partners (credit programs, KYC flows) want it,
     but it makes wallet access conditional on handing over an email, and users who decline are locked out of funds
     they may already hold in that app.
   **Answered 2026-10-30: A (D127).** Recommendation was A; revisit B with a concrete partner need (and then with an "export your key" path on the decline
   screen).

8. **How are wallet addresses proven?**
   - A. **A signature by each address's key, made once per session and stored in the vault** (recommended): no new
     server data; a user can only ever attach keys they control.
   - B. An address registry in D1, pinned at first proof: detects a later change, but creates a durable "pseudonym →
     addresses" table that, with `IDENTITY_SUB_KEY`, links Google accounts to on-chain activity.
   - C. Trust the vault's word (no proof): a user with devtools could claim any address, including a victim's.
   **Answered 2026-10-30: A (D127).** Recommendation was A.

9. **Identity tokens for every app by default?**
   - A. **On for every app** (recommended): without email the token holds no personal data a partner's page doesn't
     already see, and it costs nothing until called.
   - B. Opt-in per app: one more setting and support question for little gain.
   **Answered 2026-10-30: A (D127).** Recommendation was A; the email claim stays opt-in (D120).

10. **Do partners get a revocation or introspection endpoint?**
    - A. **No; `maxAgeMs` fresh mints instead** (recommended): a partner that needs "is this session live now" asks
       the page for a token minted in the last N seconds; no Hana endpoint for partner backends, no secret keys.
    - B. A public `POST /v1/identity/introspect` answering whether a token's session is still live: immediate logout
       visibility, but every partner request may hit Hana (latency, availability coupling, a per-request cost), and it
       needs abuse limits without a partner credential.
    **Answered 2026-10-30: A (D127).** Recommendation was A for v1; B only if a partner shows a need the 1-hour bound and `maxAgeMs` don't meet.

11. **Should the SDK set a cookie on the partner's domain (like Privy's `privy-id-token`)?**
    - A. **No** (recommended): partners send a header; no cookie semantics (SameSite, CSRF, domain scope) for Hana to
       get right on someone else's domain.
    - B. An opt-in `createHana({ identityCookie: 'hana-id-token' })` that writes a first-party cookie on the partner's
       origin: easier server-rendered apps, but a JS-written cookie can't be HttpOnly and adds CSRF exposure.
    **Answered 2026-10-30: A (D127).** Recommendation was A.

12. **How much login detail goes in the token?**
    - A. **`login_methods` only** (the account's methods, no identifiers) (recommended).
    - B. Also `amr` (the method used for this session) and `auth_time` (the interactive login time): useful for
       step-up rules, but `auth_time` is only known in `'session'` mode (the share's creation) and `amr` needs the API to
       remember the login's provider.
    - C. Nothing about methods.
    **Answered 2026-10-30: A (D127).** Recommendation was A; add B's claims later if a partner needs step-up.

13. **JWKS trust for partners.**
    - A. **JWKS URL by default, optional pinned thumbprints, and a watchdog pin check** (recommended): rotation needs no
       partner change; the watchdog (separate account) alerts if the published set ever contains an unpinned key;
       security-sensitive partners pin and get 14 days' notice of rotations.
    - B. Pinned keys only (as Wend does with Privy's PEM): strongest against a Hana account takeover, but every rotation
       and every emergency switch is a config change at every partner.
    **Answered 2026-10-30: A (D127).** Recommendation was A.

14. **The `iss` URL.** Partners configure it once; changing it later breaks their verification.
    - A. **`{apiUrl}/v1/identity` on sandbox-dev now; in production a stable Hana hostname chosen with the production
       domains (batch B Q15), e.g. `https://id.<hana domain>`**, fixed before any partner goes live (recommended).
    - B. Always under `apiUrl`: simplest, but ties partners to the API's hostname, which may move (D18, D97).
    **Answered 2026-10-30: A (D127).** Recommendation was A.

15. **Should `sid` survive a new interactive login on the same device?**
    - A. **No: one `sid` per session key**, new at every interactive login (recommended): matches Privy and what Wend's
       "kicked browser stays kicked" rule relies on.
    - B. One per device (a device id kept across logins): would let a partner recognise a returning device, which is a
       tracking id Hana would then own.
    **Answered 2026-10-30: A (D127).** Recommendation was A.

16. **A new secret for `sub`, or reuse batch C's `USER_ID_KEY`?**
    - A. **A separate `IDENTITY_SUB_KEY`** (recommended): partner-held ids and internal billing ids have different
       exposure and lifetimes; a leak of one doesn't re-link the other. One more secret to back up.
    - B. Reuse `USER_ID_KEY` with a different label: one secret fewer, but one leak exposes both, and batch C allows
       rotating `USER_ID_KEY` between contract terms, which `sub` must never do.
    **Answered 2026-10-30: A (D127).** Recommendation was A.
