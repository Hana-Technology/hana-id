# Architecture: how Hana ID works today

Current-state map of the whole system: components, flows, key derivation, data stores, environments and the relayer.
Last verified against code: 2026-10-28 (commit 14e6fc3, `feat/batch-b`).

Byte layouts and contract methods are in `docs/contract-interface.md`; this file links to it rather than repeating
them. The security model is `docs/security.md`, the decision log `docs/decisions.md`. Where a spec and the code
disagree, this file describes the code.

## Status of each part

| Part | Where | State |
|---|---|---|
| `contracts/hana-signer` (batch A, A.2) | `develop` | Deployed on sandbox-dev (`envs/sandbox-dev.json` `signer`) |
| `create_session_and_derive`, `key_index < 2^31` (batch B) | `feat/batch-b` (`b/contract`) | Code done; deploying it is a user step; ship gate not measured yet |
| `apps/api` batch A/A.2 endpoints, relayer, limits, cron | `develop` | Deployed on sandbox-dev (`apiUrl`) |
| `apps/api` `/v1/login`, login relay, origin rules (batch B) | `feat/batch-b` (`b/api-login`) | Code done |
| `apps/api` vault page, vault endpoints, migration 0003, vault cron (batch B) | `feat/batch-b` (`b/api-vault`) | Code done |
| `@hana-id/core` (layouts, CKD, derivation v1, signers, decoders, policies) | `feat/batch-b` (`b/core-crypto`, `b/core-decode`) | Code done |
| `packages/env` `vaultOrigin`/`authOrigin`, package scaffolds | `feat/batch-b` (`b/scaffold`) | Code done |
| Vault app (`packages/web`) | `b/web-vault` | **In progress, not merged** |
| Auth pages `/login`, `/login/callback`, `/approve`, `/export` | `b/web-auth` | **In progress, not merged** |
| Partner client `createHana`, EIP-1193, SWK module | `b/web-client` | **In progress, not merged** |
| Thin Workers serving `vaultOrigin`/`authOrigin` on workers.dev | `b/pages-hosting` | **In progress, not merged** |
| `admin app:settings`, API-side policy validation | `b/settings-cli` | **In progress, not merged** |
| `@hana-id/react`, `@hana-id/sodax` | scaffold only (`VERSION` export) | Per spec, not started |
| `apps/smoke` | `develop`, moved to core imports on `feat/batch-b` | Still logs in with Google Identity Services and the two-transaction path from the page itself |
| Developer dashboard, admin console, billing-grade usage (batch C) | `docs/batch-c-spec.md` | Spec draft only |

Everything below marked **(per spec, not yet merged)** describes `docs/batch-b-spec.md` for code that is not on
`feat/batch-b`.

## Components

| Component | Code | Runs on | Role |
|---|---|---|---|
| Partner page | partner's own | partner origin | Embeds the SDK; never sees keys or tokens |
| `@hana-id/web` client | `packages/web` (per spec, not yet merged) | partner origin | Mounts the vault iframe, opens the login popup, exposes EIP-1193, Stellar signer, raw signer, SWK module |
| `@hana-id/react`, `@hana-id/sodax` | `packages/react`, `packages/sodax` (per spec, not started) | partner origin | `HanaProvider`/`useHana`/`useWallet`; Sodax `IStellarWalletProvider`/`IEvmWalletProvider` adapters |
| Vault | `packages/web` vault app (per spec, not yet merged); page HTML `apps/api/src/vault/page.ts` | hidden iframe on `vaultOrigin` | Holds the session key and PRK, computes nonces and paths, signs |
| Auth pages | `packages/web` auth apps (per spec, not yet merged) | popups / top-level windows on `authOrigin` | Google login, approval, consent, key export |
| `@hana-id/core` | `packages/core` | everywhere (no DOM) | Layouts, CKD, derivation v1, signers, approval decoders, policy validator/matcher, ID-token check, message schemas |
| API Worker | `apps/api/src/index.ts` | Cloudflare Workers (`apiUrl`) | Gate (key, origin, limits), verify-before-relay, relayer, vault shares, login relay, vault page HTML, crons |
| `RelayerKey` DO | `apps/api/src/relayer-key.ts` | one object per relayer access key | Serialises that key's nonces, signs and broadcasts |
| `RateLimiter` DO | `apps/api/src/rate-limiter.ts` | one object per subject (`ip:…`, `app:…`, `share:…`, `owner-actions:…`) | Fixed-window counters; owner-token single-use markers |
| `LoginRelay` DO | `apps/api/src/login-relay.ts` | one object per `relayId` | Write-once, read-once slot for the encrypted Google token, 120 s |
| D1 `DB` | `apps/api/migrations/` | Cloudflare D1 | Apps, origins, plans, settings, usage, vault shares |
| `hana-signer` | `contracts/hana-signer` | NEAR testnet, manifest `signer` | Issuers (Google RSA keys), scope registry, sessions, calls the MPC |
| NEAR MPC | external, manifest `mpc` | NEAR testnet MPC network | CKD (`request_app_private_key`, domain `ckdDomainId` = 2) |
| Google OIDC | external | `accounts.google.com`, `www.googleapis.com` | Issues ID tokens whose `nonce` commits to the session |
| Scripts | `scripts/`, `apps/api/scripts/gen-wrangler.ts` | operator's machine | Deploy contract and keys, JWKS one-off sync, CKD key fetch, admin CLI |

```
  partner origin                                   Google OIDC (accounts.google.com)
 ┌──────────────────────────────────┐                ▲ authorize      │ id_token in #fragment
 │ partner page + @hana-id/web      │                │ (scope=openid) ▼
 │   │ MessageChannel port          │   window.open ┌────────────────────────────────┐
 │   ▼                              │ ─────────────▶│ authOrigin: /login             │
 │ ┌──────────────────────────────┐ │  postMessage  │  /login/callback /approve      │
 │ │ vault iframe (vaultOrigin)   │◀┼──────────────▶│  /export                       │
 │ │ session key, PRK, signing    │ │ (origin+source└───────────────┬────────────────┘
 │ └──────┬──────────────┬────────┘ │  checked)                     │ POST /v1/login-relay (ciphertext)
 └────────┼──────────────┼──────────┘                               │ GET /v1/app
          │ HTTPS        │ get_session, tx status (NEAR RPC)        │
          │              │ Google JWKS (googleapis.com)             │
          ▼              ▼                                          ▼
 ┌─────────────────────────────────────────────────────────────────────────────┐
 │ API Worker (apiUrl; also renders GET {vaultOrigin}/vault)                   │
 │  /v1/app /v1/login /v1/login-relay/:id /v1/vault/* /v1/sessions /v1/derive  │
 │  /v1/sessions/revoke /v1/owner-actions /v1/health        cron: hourly       │
 │  DOs: RelayerKey (per key) · RateLimiter (per subject) · LoginRelay (per id)│
 │  D1: apps, app_origins, plans, usage, vault_shares, issuer_key_missing      │
 └──────────────┬──────────────────────────────────────────────────────────────┘
                │ signed function calls (relayer account keys) + views (NEAR RPC)
                ▼
 ┌──────────────────────────────┐  request_app_private_key   ┌───────────────────┐
 │ hana-signer (signer account) │ ─────────────────────────▶ │ NEAR MPC, CKD     │
 │ issuers · registry · sessions│ ◀─── {big_y, big_c} ────── │ domain 2          │
 └──────────────────────────────┘                            └───────────────────┘
```

Who talks to whom:

| From → to | Channel | What |
|---|---|---|
| Partner client → vault | `postMessage` hello, then a `MessageChannel` port (per spec) | Port methods (`hana_login`, `eth_signTransaction`, …) and events. Never key material |
| Vault ↔ auth popups | `postMessage`, checked by `event.origin` and `event.source` (per spec) | `hana:auth-params` (incl. `relayKey`), approval requests/results, export context |
| Auth popup → Google | top-level navigation | Implicit flow, `response_type=id_token`, `scope=openid`, `prompt=select_account` |
| `/login/callback` → API | `POST /v1/login-relay/:relayId` (`Origin: authOrigin`) | AES-GCM ciphertext of the token |
| Vault → API | `fetch`, `Origin: vaultOrigin`, `x-hana-key`, `x-hana-parent-origin` | `/v1/app`, relay read, `/v1/login`, `/v1/vault/*` |
| Vault → NEAR RPC | JSON-RPC (manifest `rpc`, per spec) | `get_session` re-sync, `EXPERIMENTAL_tx_status` polling |
| Vault, export window → Google | `https://www.googleapis.com/oauth2/v3/certs` | JWKS for the defence-in-depth RS256 check |
| Partner page → API | `fetch` from the partner origin | `GET /v1/app` (any key); `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only for `pk_test_` in dev envs (`apps/smoke`) |
| API → NEAR | NEAR RPC | Views (`get_config`, `get_scope`, `scope_for_client`, `get_session`, `session_key_in_use`), `send_tx`, `tx` |
| `hana-signer` → MPC | cross-contract call, 20 Tgas, 1 yocto | `request_app_private_key {derivation_path, app_public_key, domain_id}` |
| API cron → Google, `hana-signer` | HTTPS, then `set_issuer_key`/`remove_issuer_key` signed with `KEYS_UPDATER_KEY` | JWKS sync (`apps/api/src/issuer-keys.ts:103`) |
| Operator → `hana-signer`, D1, Worker | `scripts/`, `wrangler` | Deploy, register scopes, apps, origins, secrets |

## Flows

### Login, one transaction (`POST /v1/login`)

Browser steps are per spec, not yet merged (`docs/batch-b-spec.md` "Login"); API and contract steps are code.

1. Partner calls `hana.login()` in its click handler; the SDK opens `{authOrigin}/login?v=<vault frame name>` before
   any `await`, then sends `hana_login` on the port. Popup blocked → the vault shows a "Sign in with Hana" launcher.
2. The vault makes a non-extractable Ed25519 session key, 32-byte salt, `expiresAtMs = now() + min(session_ttl_ms,
   24 h − 10 min)` on the server-corrected clock, `keyIndex = 0`, `maxUses` (1 in `'session'` mode, 2 in `'none'`),
   `nonce = sessionNonce(SIGNER, scopeId, …)` (`packages/core/src/layouts.ts:68`), `relayKey`, `relayReadKey` and
   `relayId = b64url(sha256(relayReadKey))` (`layouts.ts:156`). `SIGNER` is a build constant; `scopeId` comes from
   the vault page's inlined D1 config. It needs `GET /v1/app` first (`apps/api/src/handlers.ts:208`) for the Google
   client and refuses a `signer` or `scopeId` that differs.
3. The popup finds the vault (`opener.frames[v]`), gets `hana:auth-params`, checks `signer` against its own pinned
   constant, calls `GET /v1/app` itself, recomputes the nonce, stores `{relayKey}` under `hana.login.<relayId>` in its
   `sessionStorage`, and redirects to Google with `nonce` and `state = relayId`.
4. `/login/callback` reads `#id_token&state`, clears the fragment, requires and deletes `hana.login.<state>`,
   encrypts `{idToken}` under `relayKey` (AAD `"hana-id/relay/v1" ‖ relayId`) and posts it to
   `POST /v1/login-relay/<state>`. API: Hana-origin check, per-IP limit, one write per slot
   (`apps/api/src/login-relay.ts:66`, `:163`).
5. The vault long-polls `GET /v1/login-relay/<relayId>?wait=25` with `x-hana-relay-key`; the object checks
   `b64url(sha256(key)) === relayId` before consuming (`login-relay.ts:45`, `:79`). The vault decrypts, verifies RS256
   against Google's JWKS (`packages/core/src/id-token.ts:151`), `iss`, `aud`, `nonce`, `exp`/`iat` (60 s skew), the
   claim allow-list and `sub`, then fixes `expectedPath = scopeId#google#sub#0`.
6. The vault makes the BLS app key (`newAppKey`, `packages/core/src/ckd.ts:84`), signs
   `sessionMessage(1, ckdPayload(pk1, pk2))` and sends `POST /v1/login` (`apps/api/src/login.ts:72`). The API, in
   order: `appGate` kind `relay` (`handlers.ts:156`; key, active, `scope_conflict`, caller rule, limits); body shape
   incl. `keyIndex ≤ 2^31 − 1` (`login.ts:36`); RS256 + claims (`apps/api/src/jwks.ts:129`); claim allow-list
   (`apps/api/src/claims.ts`); nonce recomputed with `SIGNER_ACCOUNT` and the app's D1 `scope_id`; per-isolate hold on
   counter 1 (`apps/api/src/session-use.ts:76`); in parallel `checkClientScope` (`handlers.ts:370`) and
   `session_key_in_use` (409 `session_exists`); the session signature; BLS key shape (`apps/api/src/bls.ts:28`);
   pairing precheck only when `BLS_PRECHECK = "1"`.
7. The API relays `create_session_and_derive` (100 Tgas) through the session pool. The contract runs `create_session`
   then `derive_key(…, counter 1, …)` in one receipt (`contracts/hana-signer/src/sessions.rs:208`), stores the session
   with `path = scope#provider#sub#key_index` (`sessions.rs:175`) and calls the MPC.
8. Failure mapping by the failing receipt's executor (`login.ts:59`): signer → 422 `contract_rejected` (with
   `reason: 'session_key_in_use'` for that panic); MPC → 422 `ckd_failed` (session committed, `used = 1`); else 502
   `near_error`. Timeouts → 504 with `nearTx`. Usage counts a session, plus a derive on success (`login.ts:153`).
9. The vault decrypts: `S = decryptCkd(result, a, ckdAppId(SIGNER, expectedPath), pinnedKey)` with the pairing check
   (`ckd.ts:97`), `PRK = extractPrk(S)` (`packages/core/src/derivation.ts:46`, zeroes S), addresses from PRK. It never
   uses a path, session or counter from the API; recovery re-syncs `get_session` from NEAR RPC directly.
10. `'session'` mode: share creation (below). Result `{addresses, expiresAtMs, persistence}` to the partner.

### Login, two transactions (split path)

`POST /v1/sessions` then `POST /v1/derive` with counter 1. Used today by `apps/smoke` (Google Identity Services,
partner origin, `pk_test_`, dev env only: `apps/api/src/origins.ts:68`); kept in the vault behind an env flag until
the ship gate decides (per spec).

`/v1/sessions` (`handlers.ts:248`): gate → shape (`scopeId` from the client is refused; the app's D1 scope is used) →
RS256 + claims → claim allow-list only when `REJECT_PII_ON_SESSIONS = "1"` (off everywhere: smoke's GIS tokens carry
`email`) → nonce recompute → `checkClientScope` and `session_key_in_use` in parallel → relay `create_session` (50 Tgas)
→ cache the session view 10 s.

### Derive (`POST /v1/derive`)

`handlers.ts:297`: gate → shape → Ed25519 signature over `sessionMessage(counter, ckdPayload)`
(`apps/api/src/session-crypto.ts:57`) → hold `(session key, counter)` in this isolate → `precheckSessionUse`
(`session-use.ts:57`): session exists, is the app's scope, unexpired, `used < max_uses`, `counter ≥ used + 1` and
`≤ max_uses` (409 `counter_used`, `session_exhausted`, `counter_out_of_range` with `nextCounter`); a cached view that
would refuse is re-read fresh before refusing → optional BLS precheck → relay `derive_key` (60 Tgas) → count the use
in the cached view. A counter ahead of `used + 1` is still relayed (it may succeed once earlier ones land).

### Key persistence across reloads

`'session'` mode only (app setting `persistence`, default `'session'`, `apps/api/migrations/0003_vault.sql`). The
session has `max_uses = 1`, so once the login's derive is spent, the share is the only way back to the key.

Share creation, `POST /v1/vault/shares` (`apps/api/src/vault/endpoints.ts:179`):

1. `vaultGate` (`endpoints.ts:67`): app known and active, `Origin === VAULT_ORIGIN`, `x-hana-parent-origin` allowed for
   the app, no `scope_conflict`, vault limits (60/min per IP per app, 10 × plan `per_minute` per app).
2. `VAULT_KEK` loaded, else 503 `vault_key_unavailable`. App `persistence` must be `'session'` (409 `persistence_off`).
3. Signature by the session key over the vault message (shareId zero, counter 0, payload
   `"share" ‖ borsh(parentOrigin)`; `apps/api/src/vault/message.ts`).
4. `get_session` straight from RPC (no cache), retried every 300 ms for up to 2 s: live, the app's scope,
   `used === max_uses` (`endpoints.ts:151`).
5. Insert with `UNIQUE(session_pk)`: one share per session key. `K_s` (32 random bytes) is stored only as
   `share_enc = iv ‖ AES-GCM(VAULT_KEK, K_s, aad = share_id ‖ app_id ‖ session_pk)` (`apps/api/src/vault/kek.ts:77`).
   `abs_expires_at = min(session expiry, now + session_ttl_ms)`, `idle_until = min(now + idle_ttl_ms,
   abs_expires_at)`. `K_s` goes back to the vault once.

The vault (per spec, not yet merged) writes an IndexedDB record `hana-vault/records` keyed
`<signer>|<appId>|<scopeId>|<keyIndex>` holding the non-extractable session `CryptoKeyPair`, `shareId`, counter,
addresses, and `ct = AES-GCM(K_s, PRK, aad)` with the AAD of `recordAad` (`layouts.ts:133`), then zeroes `K_s`.

Unlock on reload or new tab, `POST /v1/vault/unlock` (`endpoints.ts:256`, `:308`): per-share limit 10/min → share
looked up by `share_id AND app_id` (another app's share is 404) → if the share's partner origin is no longer allowed,
mark revoked, 410 → vault signature with `counter = n + 1` → unwrap `K_s` (before the counter moves) → one atomic
`UPDATE … WHERE counter = n AND now < idle_until AND now < abs_expires_at AND revoked_at IS NULL` that also slides
`idle_until` by the app's current `idle_ttl_ms` and re-wraps under the current KEK if needed
(`apps/api/src/vault/shares.ts:100`) → `{ks, counter, idleUntilMs, absExpiresAtMs}`. No chain RPC. Errors: 404
`unknown_share`, 409 `bad_counter {expected}`, 410 `share_expired` / `share_revoked`. A 410 means a full login, never
a derive. See `docs/security.md` open issue (a): unlock does not re-check the app's current settings.

`/v1/vault/touch` slides `idle_until` without returning `K_s` (the vault sends it at most every 10 min after an
approved signature, per spec). The hourly cron deletes shares past `abs_expires_at` or revoked and re-wraps up to
2000 rows from `VAULT_KEK_PREVIOUS` (`apps/api/src/vault/cron.ts:63`).

### Signing: approval popup vs auto-approve

Per spec, not yet merged, except the `@hana-id/core` pieces named here.

| Tier | Methods |
|---|---|
| Silent | `hana_status`, `stellar_getAddress`, `eth_accounts`, `eth_chainId`, `getNetwork`, `hana_logout` |
| Popup unless an accepted auto-approve policy matches | `stellar_signTransaction`, `stellar_signAuthEntry`, `eth_signTransaction` (and `eth_sendTransaction` via it), `eth_signTypedData_v4` |
| Popup every time | `stellar_signMessage`, `personal_sign` (`NEVER_AUTO_APPROVED_KINDS`, `packages/core/src/approval.ts:41`) |
| Per app `raw_sign` | `hana_signRaw`: `'off'` → 4100; `'approval'` → popup with the raw warning, never auto-approved |

Approval: the vault queues the request and shows a launcher; a click opens `{authOrigin}/approve`. The popup decodes
the bytes itself (`decodeApprovalRequest`, `packages/core/src/decode/request.ts:55`; EIP-712 through
`normalizeTypedData`, `packages/core/src/typed-data.ts:266`), guards Approve (1 s after render, 1 s after focus, a
pointer move), and returns `approvalDigest` (`approval.ts:179`). The vault recomputes the digest from the queued
request and signs only on a match, deriving the chain key from PRK per signature and zeroing it (`withChainKey`,
`derivation.ts:98`). The SDK fills fees and nonces and broadcasts through the partner's RPC.

Auto-approve: the app owner sets an `AutoApprovePolicyV1` (D1 `auto_approve_policy`, pending + effective time on
set/change, immediate on removal; `apps/api/src/vault/settings.ts:66`). The vault page inlines the policy in force.
The user accepts that exact `policyId` (`packages/core/src/policy/id.ts`) once in a consent screen; then the vault
signs a request without a popup only if `matchAutoApprovePolicy` (`packages/core/src/policy/match.ts:91`) passes and
the per-day counters (`packages/core/src/policy/usage.ts`) allow it. Rules in `docs/security.md`.

### Revoke and logout

| Action | Path | Chain tx |
|---|---|---|
| Logout (default) | `POST /v1/vault/revoke` (share revoked), vault deletes the record, zeroes PRK, broadcasts `logout` on `hana-vault:<appId>` (per spec) | none |
| Lost device | `POST /v1/vault/revoke-all`, only with a share created < 5 min ago (`endpoints.ts:289`); revokes the user's other live shares for `(app_id, path_hash)` | none |
| On-chain revoke | `POST /v1/sessions/revoke` → `revoke_session` (20 Tgas), signed `sessionMessage(counter, "revoke")`; the precheck allows counter up to `max_uses + 1` so a spent session can still be revoked | yes; not used by default |
| Origin removed | the next unlock of each share made for that origin marks it revoked (410) | none |

### Owner and registry changes

| Change | Who / how | Code |
|---|---|---|
| Register a scope (pilot) | Hana: `admin scope:register` → `admin_register_scope` with the owner account's full-access key | `scripts/admin.ts`, `scripts/lib/admin-scope.ts` |
| Register an app, origins, suspend/resume | Hana: `admin app:create`, `app:origins:add/remove`, `app:suspend/resume` (D1 via `wrangler d1 execute`); refuses a `pk_test_`/`pk_live_` scope conflict | `scripts/admin.ts`, `scripts/lib/admin-sql.ts` |
| Vault settings (`persistence`, TTLs, `raw_sign`, policy, web client) | `admin app:settings` (in progress, `b/settings-cli`); today only a direct D1 update | migration 0003 |
| Propose / cancel / remove client / disable shared login (OIDC owner) | `POST /v1/owner-actions` with a console-client token; off-chain precheck, single-use token marker, owner pool | `handlers.ts:382`, `apps/api/src/owner-actions.ts:31` |
| Execute a matured change | anyone; `POST /v1/owner-actions` relays `execute_change` | same |
| NEAR-account owners | call the contract directly (the API relays OIDC auth only, `apps/api/src/validate.ts:99`) | `contracts/hana-signer/src/registry.rs` |
| Shared clients, sponsors, console audiences, issuers | owner account via `deploy-contract` | `scripts/deploy-contract.ts`, `scripts/lib/deploy-plan.ts` |
| Google RSA keys | hourly cron with `KEYS_UPDATER_KEY`; a kid is removed only after ≥ 55 min missing | `apps/api/src/issuer-keys.ts:103`, migration 0002 |

Timelocks, quarantine and shared-client rules: `docs/contract-interface.md` "Registry" and "Shared clients".

### Key export

Per spec, not yet merged: `hana_export {chain}` → launcher → top-level `{authOrigin}/export` window, which runs its
own fresh login (`/login?mode=export`, `max_age=0`, `max_uses = 1`) through `/v1/login`, decrypts against its own
path, aborts if the address differs from the vault's, and shows the key (SEP-23 `S…` or `0x` hex) while a button is
held after a typed confirmation. The vault's PRK is never used for export. The `auth_time` freshness check is off
(Google returns no `auth_time`; `packages/core/src/id-token.ts:113`). Encodings: `packages/core/src/export.ts`.

## Key derivation

```
path   = {scope_id}#{provider}#{sub}#{key_index}          sessions.rs:175, e.g. s1#google#1102…#0
app_id = SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ signer account ‖ "," ‖ path)    ckd.ts:90
CKD    : MPC returns big_y = y·G1, big_c = msk·H(pk ‖ app_id) + y·a·G1; S = big_c − a·big_y (48 bytes),
         checked by e(H, pk) = e(S, G2) against the pinned ckdNetworkKey                ckd.ts:97
PRK    = HKDF-Extract(SHA-256, salt = "hana-id/chain-keys/v1/extract", IKM = S)       derivation.ts:46
info   = borsh("hana-id/chain-keys/v1/expand") ‖ borsh(ns) ‖ borsh(curve) ‖ u32le(account)   derivation.ts:56
```

| Tuple `(namespace, curve)` | Output | Key rule | Address |
|---|---|---|---|
| `("stellar", "ed25519")` | 32 bytes | RFC 8032 seed (`Keypair.fromRawEd25519Seed`) | StrKey `G…` |
| `("eip155", "secp256k1")` | 48 bytes | `d = (int_be(okm) mod (n − 1)) + 1` (`mapHashToField`, FIPS 186-5 A.2.1) | EIP-55, one key for all EVM chains |

`account = 0` and `key_index = 0` in the MVP. `key_index ≥ 2^31` is refused by the contract (`sessions.rs:27`), the
API (`apps/api/src/validate.ts:12`) and core (`layouts.ts:18`). Golden vectors: `packages/core/test/vectors/
derivation-v1.json`, guarded by a SHA-256 constant test that fails with "address-changing edit"
(`packages/core/test/derivation.test.ts:62`).

What decides an address, and when it freezes:

| Input | Changes addresses? | Status |
|---|---|---|
| MPC network (its master key) | yes, all | fixed at the address freeze (mainnet MPC) |
| Signer account id (in `app_id`) | yes, all | fixed when final accounts deploy |
| Path format `scope#provider#sub#key_index` | yes, all | fixed now (contract) |
| Scope id, Google `sub`, `key_index` | yes, per user / app | per login; `sub` is the same across a project's clients |
| HKDF labels, tuples, key rules (derivation v1) | yes, all | names confirmed 2026-10-28; frozen at the address freeze |
| New chain tuples, new `account` values | no (additive) | open |
| `vaultOrigin`, `authOrigin`, `create_session_and_derive`, persistence, own vs shared client | no | `authOrigin` still breaks own-client redirect registrations if changed |

Before the freeze, anything that changes an address must be called out (CLAUDE.md); after it, never. A scheme change
would be `hana-id/chain-keys/v2/extract`, opt-in, with v1 still derivable.

## Data stores

| Store | Holds | Never holds |
|---|---|---|
| `hana-signer` state (public) | Config (owner, mpc, domain, sponsors, console audiences, shared clients, change delay), issuers and Google RSA public keys, scopes (owners, clients, pending changes, `action_nonce`), client index, quarantine / retired-client records, sessions (`path`, `scope_id`, `expires_at_ms`, `max_uses`, `used`), revoke tombstones, expiry FIFO | Keys, S, PRK |
| NEAR transaction args (public forever) | Google ID tokens used in `create_session*`, register proofs, owner tokens; session signatures; BLS `pk1`/`pk2`; MPC responses (encrypted to `a`) | Anything usable without the session key or `a` |
| D1 `DB` | `plans`, `apps` (+ 0003 settings: `persistence`, `session_ttl_ms`, `idle_ttl_ms`, `raw_sign*`, `auto_approve_*`, `google_web_client_id`), `app_origins`, `usage` (`sessions`, `derives`, `unlocks` per app per UTC day), `issuer_key_missing`, `vault_shares` (`share_enc` under `VAULT_KEK`, `session_pk`, `path_hash`, `partner_origin`, counter, times) | Plaintext `K_s`, tokens, user ids (only `sha256(path)`) |
| `RelayerKey` DO storage | Per key: `publicKey`, nonce reservation, last block hash and time | Secret keys (they are Worker secrets) |
| `RateLimiter` DO storage | `<window>@<start>` counters; `mark:<sha256(owner token)>` single-use markers until the token's `exp` | Tokens |
| `LoginRelay` DO storage | One slot: `{iv, ct}` for ≤ 120 s, then a tombstone for 120 s | Plaintext tokens (the API has no `relayKey`) |
| Per-isolate memory (API) | JWKS (≤ max-age, stale ≤ 6 h on fetch failure), config / scope / client views (≤ 60 s; "no scope" ≤ 10 s), sessions (≤ 10 s), parsed KEKs, counter holds | — |
| Browser, `vaultOrigin` (per spec) | IndexedDB `hana-vault` records (partitioned by top-level site); memory: session key, PRK, consent and counters | S, `a` (memory only, dropped), plaintext PRK on disk |
| Browser, `authOrigin` (per spec) | `sessionStorage` `hana.login.<relayId>` = `{v, createdAt, relayKey}` (≤ 10 min, single use) | Tokens |
| `.secrets/<env>/` (operator machine, gitignored, 0700/0600) | `relayer-keys.json`, `owner-relayer-keys.json`, `keys-updater.json` (`scripts/lib/secrets.ts:66`) | — |
| `~/.near-credentials/testnet/` (operator machine) | Full-access keys of the owner, signer and relayer accounts (`scripts/lib/keys.ts`) | — |
| Worker secrets | `RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`, `VAULT_KEK`, `VAULT_KEK_PREVIOUS` | — |
| `apps/api/.dev.vars` (local, gitignored, 0600) | Relayer and updater keys for `wrangler dev` (`gen-wrangler --dev-vars`) | — |

## Environments and manifests

- One manifest per env, `envs/<env>.json`, validated by `packages/env/src/schema.ts` (zod) and loaded with `loadEnv`.
  Only `sandbox-dev` exists. `network` accepts only `testnet`. Every account name the code uses comes from here
  (`signer`, `relayer`, `owner`, `mpc`); code reads it via generated config, never by hard-coding names.
- Other fields: `ckdDomainId`, `ckdNetworkKey` (pinned with `scripts/fetch-ckd-key.ts`), `rpc`, `apiUrl`,
  `vaultOrigin`/`authOrigin` (both or neither; bare origins; `https`; loopback only in `local*` envs; different
  origins; different sites outside `local*`/`sandbox*`, `packages/env/src/schema.ts:80`), `changeDelayMs`,
  `googleClientIds` (the `global` scope), `sharedGoogleClientIds` (≤ 5, disjoint from scope clients),
  `consoleAudiences`, `cloudflare.{workerName, d1Name, durableObjectLocation}`.
- Dev envs are `local*`/`sandbox*` by name (`packages/env/src/origins.ts:9`, mirrored in `apps/api/src/origins.ts:26`
  and as `devEnv` in the web build). They allow loopback partner origins and partner-origin session endpoints for
  `pk_test_` keys, and same-site Hana origins. No flag can turn these on elsewhere.
- `apps/api/scripts/gen-wrangler.ts` writes `apps/api/wrangler.jsonc` (vars from the manifest, D1 binding, DO bindings
  and migrations `v1` RelayerKey/RateLimiter, `v2` LoginRelay, hourly cron) and, with `--dev-vars`, `.dev.vars` from
  `.secrets/<env>/`. It refuses an env without both Hana origins. A generated copy for sandbox-dev with the local
  placeholder D1 id is tracked in git (currently stale: it predates the `API_URL` var); the deployed id is passed with
  `--d1-id` and not committed.
- `packages/web/scripts/gen-envs.ts` writes the gitignored `packages/web/src/envs.generated.ts` with the pinned
  per-env constants (`signer`, `relayer`, `rpc`, `ckdNetworkKey`, origins, `devEnv`) for every manifest with both
  origins; it fails on an unusable CKD key.
- Runtime flags, `"0"` everywhere for now: `BLS_PRECHECK` (Workers Paid plan only), `REJECT_PII_ON_SESSIONS` (until
  smoke moves to the vault).
- sandbox-dev runs on `*.tingtc.workers.dev` (personal Cloudflare account, free plan). Production env and a Hana
  domain are deferred (`docs/decisions.md`).

## Relayer design

- **Two pools** of function-call keys on the relayer account, receiver = signer, in `apps/api/src/relayer-config.ts:15`
  and `scripts/lib/contract.ts`: session pool (`RELAYER_KEYS`, default 3 keys × 2 NEAR allowance:
  `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions`) and owner pool
  (`OWNER_RELAYER_KEYS`, default 1 key × 0.5 NEAR: `propose_change`, `cancel_change`, `remove_client`,
  `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config`). Abuse of `/v1/owner-actions`
  can only drain the owner pool. The session list is batch B allowlist state 1; state 2 or 3 follows the ship gate
  (each change deletes and re-adds every session-pool key). `deploy-contract` treats a full-access key, another
  receiver, other or empty methods, or an unlimited or too-large allowance as a blocker.
- **Dispatch**: `relay()` picks a key round-robin per pool from a random start per isolate
  (`apps/api/src/relayer-pool.ts:33`); the method is checked against the pool in the Worker and again in the object.
  Gas comes only from `apps/api/src/gas.ts` (per method, `GAS_<METHOD>_TGAS` overrides), never from the caller.
- **One `RelayerKey` DO per key** (`relayer-key-<i>`, `owner-relayer-key-<i>`). A critical section takes the next nonce,
  signs and starts `send_tx` without waiting for it (`relayer-key.ts:233`); outcomes are awaited outside it, so many
  transactions per key are in flight.
- **Nonce reservation in blocks of 100** (`NONCE_RESERVATION`, `relayer-key.ts:45`): storage holds R, "no tx of this
  key was sent with a nonce above R". A nonce above R is sent only after R' = n + 99 is written and
  `storage.sync()` resolved (`relayer-key.ts:335`). One confirmed write per 100 relays; a restart skips ≤ 99 nonces,
  which NEAR allows.
- **Cold start** (`relayer-key.ts:279`): with a stored reservation for this public key, start from it and reuse the
  stored block hash while under 5 min old, with no chain read. Only without one (new or replaced key) read the access
  key nonce and a final block. A key used elsewhere shows up as `InvalidNonce`: re-read and retry once.
- **Outcome**: `send_tx` with `wait_until: EXECUTED_OPTIMISTIC` (`apps/api/src/near/rpc.ts:75`), then polling `tx`.
  Dropped (a later nonce landed first) → resend once with a fresh nonce. Errors that certainly did not execute
  (`method_not_allowed`, `relayer_unconfigured`, `near_unavailable`, `near_rejected`, `relayer_busy`) are safe to
  resend; anything else carries `nearTx` for the caller to poll.
- **Location**: `DO_LOCATION_HINT` (manifest `cloudflare.durableObjectLocation`, sandbox-dev `apac`) pins relayer key
  objects, per-app limiters and owner-action limiters, with the region in the object name
  (`apps/api/src/placement.ts:20`). Per-IP limiters and `LoginRelay` objects are created near their caller.
- **Request log** (`handlers.ts:97`): per-stage timings (`app`, `limits`, `checks`, `relay`, `relayQueue`,
  `relayChainRead`, `relaySign`, `relayPersist`, `relayOutcome`), `colo`, `relayInstance` (cold, chain read, block
  refresh). Never tokens, signatures, bodies, keys or CKD responses.

## Glossary

| Term | Meaning |
|---|---|
| scope | A partner's on-chain namespace (`s1`, `s2`, …; `global` is Hana's). Part of every path, so two scopes never share a key |
| client | A `(provider, aud)` pair, e.g. `("google", "<id>.apps.googleusercontent.com")`. A scope's own clients resolve to it only |
| shared client | One of Hana's Google clients (`sharedGoogleClientIds`, ≤ 5), not tied to a scope; the scope comes from the session nonce and must have `allow_shared` |
| session key | Ed25519 key made in the browser (non-extractable WebCrypto). The ID token's nonce commits to it; it signs derives, revokes and vault messages |
| counter | Per-session request counter; each signed derive or revoke must carry `used + 1`. Vault shares have their own counter |
| `key_index` | Last path component, `u32 < 2^31`; 0 in the MVP; a new index is a new wallet (rotation hook) |
| CKD | NEAR MPC Confidential Key Derivation: the MPC returns a per-`app_id` BLS secret encrypted to the caller's ephemeral key `a` |
| `app_id` (CKD) | `SHA3-256("near-mpc v0.1.0 app_id derivation:" ‖ signer ‖ "," ‖ path)`. Not the D1 `apps.id` (which the vault message uses) |
| S | The 48-byte CKD secret after decryption and the pairing check; IKM of derivation v1; zeroed at once |
| PRK | `HKDF-Extract(salt "hana-id/chain-keys/v1/extract", S)`, 32 bytes; every v1 chain key comes from it |
| K_s | 32-byte AES-GCM key per vault share; server-held (wrapped by `VAULT_KEK`), returned on unlock; encrypts PRK in the browser record |
| `VAULT_KEK` | Worker secret that wraps every `K_s` in D1 |
| `relayKey` / `relayReadKey` | Per-login AES key for the token relay (vault and login popup) / read capability (vault only); `relayId = b64url(sha256(relayReadKey))` |
| `policyId` | `sha256("hana-id/auto-approve/v1" ‖ canonical JSON of the normalized policy)`; a user's consent is bound to it |
| ProtocolDecoder | Interface in `packages/core/src/policy/decoders.ts` that turns a call with opaque bytes into effects (recipients, targets, tokens); registry empty in batch B |
| `vaultOrigin` / `authOrigin` | Hana's two page origins: the key-holding iframe, and the login/approval/export pages Google redirects to |
| publishable key | `pk_test_…` / `pk_live_…`, public, identifies an app in D1; a test key never shares a scope with a live key |
| sponsor | Account the contract pays storage for (the relayer) |
| ship gate | If `create_session_and_derive` saves < 1.5 s median over 10 testnet runs, it is removed before the audit |
