# Architecture: how Hana ID works today

Current-state map of the whole system: components, flows, key derivation, data stores, environments and the relayer.
Last verified against code: 2026-10-30 (branch `feat/identity-token-1`: the partner identity token in Status,
Components, the "Partner identity token" flow, Data stores and the Glossary; `feat/email-login-1-r2`: contract v3
email login status and path identity; `feat/playbook-gaps`: the watchdog's relayer funds reads and D1 meta;
`feat/recovery-playbooks`: the playbooks package in Components; before it `perf/login-latency-impl`, 2026-10-29:
the login flow, key persistence and the vault gate; the rest as of 2026-10-28, commit 58edee9).

Byte layouts and contract methods are in `docs/contract-interface.md`; this file links to it rather than repeating
them. The security model is `docs/security.md`, the decision log `docs/decisions.md`. Where a spec and the code
disagree, this file describes the code.

## Status of each part

Batch B is merged on the integration branch `feat/batch-b` (not yet on `develop`) and **not deployed**.

| Part | Where | State |
|---|---|---|
| `contracts/hana-signer` (batch A, A.2) | `develop` | Deployed on sandbox-dev (`envs/sandbox-dev.json` `signer`) |
| `create_session_and_derive`, `key_index < 2^31` (batch B) | `feat/batch-b` | Code done; the upgrade is a user step; ship gate not measured yet |
| `apps/api` batch A/A.2 endpoints, relayer, limits, cron | `develop` | Deployed on sandbox-dev (`apiUrl`) |
| `apps/api` `/v1/login` (incl. the export limit), login relay, origin rules, vault page, vault endpoints, migration 0003, vault cron, API-side policy validation (batch B) | `feat/batch-b` | Code done |
| Page Workers serving `vaultOrigin`/`authOrigin` (`apps/api/src/pages/`, `scripts/pages-wrangler.ts`) | `feat/batch-b` | Code done; deploying them is a user step |
| `@hana-id/core` (layouts, CKD, derivation v1, signers, decoders, policies, verified contracts) | `feat/batch-b` | Code done |
| `packages/env` `vaultOrigin`/`authOrigin`, `rpcFallback` | `feat/batch-b` | Code done |
| `@hana-id/web`: vault, auth pages `/login`, `/login/callback`, `/approve`, `/export`, partner client `createHana` (EIP-1193, Stellar, SWK module) | `feat/batch-b`; packaging `feat/sdk-packaging` | Code done; built as installable tarballs (`pnpm run pack:check`, D71), not published (registry and licence open, D72) |
| `@hana-id/react` (`HanaProvider`, `useHana`, `useWallet`), `@hana-id/sodax` (Stellar and EVM wallet-provider adapters) | `feat/batch-b`; packaging `feat/sdk-packaging` | Code done; tarballs as `@hana-id/web`, not published |
| `admin app:settings` | `feat/batch-b` | Code done |
| `apps/smoke` | `feat/batch-b` | `/` logs in through `@hana-id/web` (the vault); `/direct.html` keeps Google Identity Services and the split path for the ship gate |
| `apps/e2e` (Playwright: Chromium, WebKit, Firefox; local builds against the real API Worker; CI job) | `feat/batch-b` | Code done |
| Developer dashboard, admin console, billing-grade usage (batch C) | `docs/batch-c-spec.md` | Spec draft; MVP cut in `docs/decisions.md` D34 |
| Governance contract (delayed issuer keys, watchdogs, pause, timelocked upgrades, DAO owner) | `gov/contract`, integrated on `feat/governance` | Code done; not deployed (`docs/governance-spec.md` "Migration plan") |
| `apps/watchdog` (independent watchdog Worker, alerts, status endpoint for the admin portal) | `gov/watchdog`, integrated on `feat/governance` | Code done; not deployed (`docs/operations.md` "Watchdog service") |
| Governance API (delayed JWKS sync, `issuer_key_pending` / `paused` gate, `GET /v1/governance`) | `gov/api`, integrated on `feat/governance` | Code done; not deployed (`docs/operations.md` "Deploying the governance API") |
| Governance scripts (owner council, DAO-routed owner calls, timelocked upgrades, migration, `admin governance:status`) | `gov/scripts`, integrated on `feat/governance` | Code done (`docs/operations.md` "Governance") |
| Partner identity token, build steps 1–4 (`docs/identity-token-spec.md`, D127): core layouts and ids, `POST /v1/identity/token`, JWKS and discovery, Worker-secret ES256 signer, migration 0008, `hana.getIdentityToken()`, `useIdentityToken()`, `scripts/identity-key.ts`, `examples/identity-verify` | `feat/identity-token-1` | Code done; not deployed (`docs/operations.md` "Identity token keys"). No `email` claim yet (steps 5–6), no KMS signer (step 7) or watchdog pin check (step 8) |
| Email login, contract v3 (self-issued email issuer with a signer policy, JWS JSON tokens, accounts and links, `migrate` v2 → v3) | `feat/email-login-1` | Code done, unit-tested; not deployed. Every off-chain part (issuer, API, web, watchdog) is a later batch of `docs/email-login-build-plan.md`; until then nothing calls the new methods |

## Components

| Component | Code | Runs on | Role |
|---|---|---|---|
| Partner page | partner's own | partner origin | Embeds the SDK; never sees keys or tokens |
| `@hana-id/web` client | `packages/web/src/client` | partner origin | Mounts the vault iframe, opens the login popup and (in the click, D99) the approval popup, exposes EIP-1193, Stellar signer, raw signer, SWK module |
| `@hana-id/react`, `@hana-id/sodax` | `packages/react`, `packages/sodax` | partner origin | `HanaProvider`/`useHana`/`useWallet`/`useIdentityToken`; Sodax `IStellarWalletProvider`/`IEvmWalletProvider` adapters |
| Partner backend | partner's own (guide: `examples/identity-verify`) | partner servers | Verifies identity tokens against the API's JWKS with any JOSE library; never calls Hana |
| Vault | `packages/web/src/vault`; page HTML `apps/api/src/vault/page.ts` | hidden iframe on `vaultOrigin` | Holds the session key and PRK, computes nonces and paths, signs |
| Auth pages | `packages/web/src/auth` | popups / top-level windows on `authOrigin` | Google login, approval, consent, key export |
| `@hana-id/core` | `packages/core` | everywhere (no DOM) | Layouts, CKD, derivation v1, signers, approval decoders, policy validator/matcher, ID-token check, message schemas |
| API Worker | `apps/api/src/index.ts` | Cloudflare Workers (`apiUrl`) | Gate (key, origin, limits), verify-before-relay, relayer, vault shares, login relay, vault page HTML, crons; the identity token issuer (`src/identity/`: mint, JWKS, discovery; the signer behind `IdentitySigner`) |
| Page Workers | `apps/api/src/pages/` (`vault-worker.ts`, `auth-worker.ts`, `host.ts`) | one Cloudflare Worker per Hana origin (D66) | `vaultOrigin`: forwards `GET /vault` to the API Worker (service binding `API`), serves the vault bundle; `authOrigin`: the four auth pages with their CSP, and their assets. Nothing else; never a cookie (D70) |
| `RelayerKey` DO | `apps/api/src/relayer-key.ts` | one object per relayer access key | Serialises that key's nonces, signs and broadcasts |
| `RateLimiter` DO | `apps/api/src/rate-limiter.ts` | one object per subject (`ip:…`, `app:…`, `export:…`, `owner-actions:…`, `identity:global`, `identity-proof:<sessionPk>`) | Fixed-window counters, global and exact; owner-token and identity-proof single-use markers |
| Rate Limiting bindings | `apps/api/src/vault/limits.ts` (`VAULT_IP_LIMIT`, `VAULT_SHARE_LIMIT`), `apps/api/src/identity/limits.ts` (`IDENTITY_SESSION_LIMIT`) | each Cloudflare location, no network hop | The vault's per-IP and per-share and the identity token's per-session flood limits, approximate (D95) |
| `LoginRelay` DO | `apps/api/src/login-relay.ts` | one object per `relayId` | Write-once, read-once slot for the encrypted Google token, 120 s |
| D1 `DB` | `apps/api/migrations/` | Cloudflare D1 | Apps, origins, plans, settings, usage, vault shares, identity token counts |
| `hana-signer` | `contracts/hana-signer` | NEAR testnet, manifest `signer` | Issuers (Google RSA keys), scope registry, sessions, calls the MPC |
| NEAR MPC | external, manifest `mpc` | NEAR testnet MPC network | CKD (`request_app_private_key`, domain `ckdDomainId` = 2) |
| Google OIDC | external | `accounts.google.com`, `www.googleapis.com` | Issues ID tokens whose `nonce` commits to the session |
| Watchdog Worker | `apps/watchdog/src/index.ts` | Cloudflare Workers on **its own account** (manifest `watchdog.cloudflare`, D86) | Every 5 min: Google's JWKS against the contract's pending and active issuer keys; cancels forged pending keys, deletes the updater keys that proposed one, pauses on a forged active key, confirms matches (D82); alerts on governance changes and on the relayer's balance and pool-key allowances (read-only, D150); pages, Slack, email (D85); dead-man's switch; read-only `GET /status`, `/alerts`, `/actions` and `POST /alerts/:id/ack` for the admin portal (D83) |
| Watchdog D1 | `apps/watchdog/migrations/` | Cloudflare D1 on the watchdog's account | Seen kids, absences, runs and their checks, actions log, alerts, deliveries, acks |
| `packages/jwks` | `packages/jwks/src/index.ts` | API and watchdog | JWKS parsing (`usableJwks`), RSA key comparison |
| `packages/playbooks` | `packages/playbooks/src/` | watchdog (playbook ids), admin portal (batch C), `docs/playbooks.md` | Recovery playbooks for every watchdog alert kind and incident (D126); the watchdog serves each alert kind's playbook id in `GET /status` and names it in every alert text |
| Scripts | `scripts/`, `apps/api/scripts/gen-wrangler.ts`, `apps/watchdog/scripts/` | operator's machine | Deploy contract and keys, JWKS one-off sync, CKD key fetch, `VAULT_KEK` init/rotate, admin CLI, watchdog config and secrets |

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
 │  /v1/sessions/revoke /v1/owner-actions /v1/health        cron: 15 min       │
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
| Partner client → vault | `postMessage` hello, then a `MessageChannel` port (`packages/web/src/client/vault-connection.ts`) | Port methods (`hana_login`, `eth_signTransaction`, …) and events. Never key material |
| Vault ↔ auth popups | `postMessage`, checked by `event.origin` and `event.source` (a popup the partner page opened reaches the vault as `opener.frames[v]`) | `hana:auth-params` (incl. `relayKey`), approval requests/results and `hana:approve-close`, export context |
| Partner client → approval popup | `window.open` only (it holds the WindowProxy; the popup takes no message from it) | — |
| Auth popup → Google | top-level navigation | Implicit flow, `response_type=id_token`, `scope=openid`, `prompt=select_account` |
| `/login/callback` → API | `POST /v1/login-relay/:relayId` (`Origin: authOrigin`) | AES-GCM ciphertext of the token |
| Vault → API | `fetch`, `Origin: vaultOrigin`, `x-hana-key`, `x-hana-parent-origin` | `/v1/app`, relay read, `/v1/login`, `/v1/vault/*` |
| Vault → NEAR RPC | JSON-RPC (manifest `rpc`; `rpcFallback` only when `rpc` errors or times out, one endpoint per answer: `packages/web/src/near-call.ts`) | `get_session` re-sync, the login's registry check (`scope_for_client`, or `get_scope` and `get_config`), `EXPERIMENTAL_tx_status` polling; the export window the same |
| Vault, export window → Google | `https://www.googleapis.com/oauth2/v3/certs` | JWKS for the defence-in-depth RS256 check |
| Partner page → API | `fetch` from the partner origin | `GET /v1/app` (any key); `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only for `pk_test_` in dev envs (`apps/smoke`) |
| API → NEAR | NEAR RPC | Views (`get_config`, `get_scope`, `scope_for_client`, `get_session`, `session_key_in_use`, `get_issuer`; for the cron and `GET /v1/governance` also `get_key_changes`, `get_governance`, `view_access_key_list`), `send_tx`, `tx` |
| `hana-signer` → MPC | cross-contract call, 20 Tgas, 1 yocto | `request_app_private_key {derivation_path, app_public_key, domain_id}` |
| API cron → Google, `hana-signer` | HTTPS, then `set_issuer_key` / `propose_issuer_key_removal` / `execute_issuer_key_change` signed with `KEYS_UPDATER_KEY` (delayed key changes, governance batch) | JWKS sync (`apps/api/src/issuer-keys.ts` `syncIssuerKeys`) |
| Watchdog → Google | `https://www.googleapis.com/oauth2/v3/certs`, `cache: no-store`, every 5 min (and once more 60 s later when a pending kid is missing) | Its own JWKS copy, never the API's |
| Watchdog → NEAR | its own RPC (manifest `rpc`, then `rpcFallback`): `status`, views `get_key_changes`, `get_issuer`, `get_issuer_keys`, `get_config`, `get_governance`, the owner's `view_account` and (a DAO) `get_policy`, the relayer's `view_account` and `view_access_key_list` (final; alert only, D150); `send_tx` from `WATCHDOG_KEY` on `watchdog.account` | `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key` only |
| Watchdog → paging app, Slack, Resend, heartbeat | HTTPS with its own credentials (`apps/watchdog/src/channels.ts`) | Critical: page + Slack + email, re-sent every 15 min until acknowledged; warning: Slack + email; daily digest; dead-man's switch ping |
| Admin portal (batch C) → watchdog | `GET /status`, `/alerts`, `/actions`, `POST /alerts/:id/ack`, bearer `WATCHDOG_STATUS_TOKEN` | The "Security & monitoring" view; acks stop re-sends only |
| Operator → `hana-signer`, D1, Worker | `scripts/`, `wrangler` | Deploy, register scopes, apps, origins, secrets |

## Flows

### Login, one transaction (`POST /v1/login`)

Browser steps: `packages/web/src/vault/login.ts`, `packages/web/src/auth/login-page.ts`, `callback-page.ts`.

1. Partner calls `hana.login()` in its click handler; the SDK opens `{authOrigin}/login?v=<vault frame name>` before
   any `await`, then sends `hana_login` on the port. Popup blocked → the vault shows a "Sign in with Hana" launcher.
2. The vault makes a non-extractable Ed25519 session key, 32-byte salt, `expiresAtMs = now() + min(session_ttl_ms,
   24 h − 10 min)` on the server-corrected clock, `keyIndex = 0`, `maxUses` (1 in `'session'` mode, 2 in `'none'`),
   `nonce = sessionNonce(SIGNER, scopeId, …)` (`packages/core/src/layouts.ts:71`), `relayKey`, `relayReadKey` and
   `relayId = b64url(sha256(relayReadKey))` (`relayIdFor`, `layouts.ts:166`). `SIGNER` is a build constant; `scopeId`
   comes from the vault page's inlined D1 config. It needs `GET /v1/app` first (`apps/api/src/handlers.ts:212`) for
   the Google client and refuses a `signer` or `scopeId` that differs. As soon as `GET /v1/app` answers it also starts
   the registry check (D56, `packages/web/src/vault/login.ts` `checkScope`), which runs while the user is at Google:
   own client `scope_for_client('google', clientId)` must be `scopeId`; shared client `get_scope(scopeId)` must exist
   with `allow_shared`, and `get_config().shared_clients` must list the client (both views in parallel, D117). Its
   answer is awaited after the token check, before step 6: a mismatch is `config_mismatch` (`scope_mismatch`), no
   answer `api_unavailable` (`scope_unchecked`).
3. The popup finds the vault (`opener.frames[v]`), gets `hana:auth-params` (accepted only from that window on
   `vaultOrigin`), checks `signer` against its own pinned constant, recomputes the nonce, stores `{relayKey}` under
   `hana.login.<relayId>` in its `sessionStorage`, and redirects to Google with `nonce` and `state = relayId`. It makes
   no API call (D77): the app's name, parent origin, scope and Google client are the vault's, and `POST /v1/login`
   checks them against the current app row before anything is relayed (`docs/security.md` "The login popup trusts the
   vault's app facts").
4. `/login/callback` reads `#id_token&state`, clears the fragment, requires and deletes `hana.login.<state>`,
   encrypts `{idToken}` under `relayKey` (AAD `"hana-id/relay/v1" ‖ relayId`) and posts it to
   `POST /v1/login-relay/<state>`. API: Hana-origin check, per-IP limit, one write per slot
   (`apps/api/src/login-relay.ts:170`, `LoginRelay.write` `:73`).
5. The vault long-polls `GET /v1/login-relay/<relayId>?wait=25` with `x-hana-relay-key`; the object checks
   `b64url(sha256(key)) === relayId` before consuming (`readKeyMatches` `login-relay.ts:52`, `LoginRelay.read` `:86`).
   The vault decrypts, verifies RS256 against Google's JWKS (`packages/core/src/id-token.ts:151`), `iss`, `aud`,
   `nonce`, `exp`/`iat` (60 s skew), the claim allow-list and `sub`, then fixes `expectedPath = scopeId#google#sub#0`.
6. The vault makes the BLS app key (`newAppKey`, `packages/core/src/ckd.ts:84`), signs `sessionMessage(1,
   ckdPayload(pk1, pk2))` and sends `POST /v1/login` (`handleLogin`, `apps/api/src/login.ts:85`). The API, in order:
   `appGate` kind `relay` (`handlers.ts:157`; key, active, `scope_conflict`, caller rule, limits); body shape incl.
   `keyIndex ≤ 2^31 − 1` (`toLogin`, `login.ts:49`); RS256 + claims (`apps/api/src/jwks.ts:129`); claim allow-list
   (`apps/api/src/claims.ts`); nonce recomputed with `SIGNER_ACCOUNT` and the app's D1 `scope_id`; from `authOrigin`
   (an export) the export limit, 3 per hour per `(app, sha256(path))` (D59); per-isolate hold on counter 1
   (`apps/api/src/session-use.ts:76`); in parallel `checkClientScope` (`handlers.ts:384`) and `session_key_in_use`
   (409 `session_exists`); the session signature; BLS key shape (`apps/api/src/bls.ts:28`); pairing precheck only when
   `BLS_PRECHECK = "1"`.
7. The API relays `create_session_and_derive` (100 Tgas) through the session pool. The contract runs `create_session`
   then `derive_key(…, counter 1, …)` in one receipt (`contracts/hana-signer/src/sessions.rs:208`), stores the session
   with `path = scope#provider#sub#key_index` (`sessions.rs:175`) and calls the MPC.
8. Failure mapping by the failing receipt's executor (`loginFailure`, `login.ts:72`): signer → 422 `contract_rejected`
   (with `reason: 'session_key_in_use'` for that panic); MPC → 422 `ckd_failed` (session committed, `used = 1`); else
   502 `near_error`. Timeouts → 504 with `nearTx`. Usage counts a session, plus a derive on success (`countLogin`,
   `login.ts:177`).
9. The vault decrypts: `S = decryptCkd(result, a, ckdAppId(SIGNER, expectedPath), pinnedKey)` with the pairing check
   (`ckd.ts:97`), `PRK = extractPrk(S)` (`packages/core/src/derivation.ts:46`, zeroes S), addresses from PRK. It never
   uses a path, session or counter from the API; recovery re-syncs `get_session` from NEAR RPC directly.
10. Result `{addresses, expiresAtMs, persistence}` to the partner, and `accountsChanged`. In `'session'` mode the share
    and record (below) are made afterwards, in the background (D79, `vault.ts` `persistLogin`): `POST /v1/vault/shares`
    is tried once more after 1 s if it fails. Giving up leaves the session working in memory with `persistence:
    'none'` (port event `persistenceChanged`, and `hana_status`), revokes the share if made and clears the older session's record (the next reload
    is a full login); a session that ends first (logout, a newer login, expiry) cancels it and no record or share
    survives it. Revoke-other-devices, touch and consent reads and writes wait for it.

### Login, two transactions (split path)

`POST /v1/sessions` then `POST /v1/derive` with counter 1. Used today by `apps/smoke` (Google Identity Services,
partner origin, `pk_test_`, dev env only: `apps/api/src/origins.ts:68`). The vault keeps it as a `loginFlow: 'split'`
constructor option (`packages/web/src/vault/login.ts` `split()`), not wired to any build or env flag, until the ship
gate decides.

`/v1/sessions` (`handleAppEndpoint`, `handlers.ts:251`): gate → shape (`scopeId` from the client is refused; the app's
D1 scope is used) → RS256 + claims → claim allow-list only when `REJECT_PII_ON_SESSIONS = "1"` (off everywhere:
smoke's GIS tokens carry `email`) → nonce recompute → `checkClientScope` and `session_key_in_use` in parallel → relay
`create_session` (50 Tgas) → cache the session view 10 s.

### Derive (`POST /v1/derive`)

`handleAppEndpoint` (`handlers.ts:251`): gate → shape → Ed25519 signature over `sessionMessage(counter, ckdPayload)`
(`apps/api/src/session-crypto.ts:57`) → hold `(session key, counter)` in this isolate → `precheckSessionUse`
(`session-use.ts:57`): session exists, is the app's scope, unexpired, `used < max_uses`, `counter ≥ used + 1` and `≤
max_uses` (409 `counter_used`, `session_exhausted`, `counter_out_of_range` with `nextCounter`); a cached view that
would refuse is re-read fresh before refusing → optional BLS precheck → relay `derive_key` (60 Tgas) → count the use
in the cached view. A counter ahead of `used + 1` is still relayed (it may succeed once earlier ones land).

### Key persistence across reloads

`'session'` mode only (app setting `persistence`, default `'session'`, `apps/api/migrations/0003_vault.sql`). The
session has `max_uses = 1`, so once the login's derive is spent, the share is the only way back to the key.

Share creation, `POST /v1/vault/shares` (`apps/api/src/vault/endpoints.ts` `createShare`), sent by the vault right
after it reported the login (D79):

1. The vault gate (`endpoints.ts` `vaultApp`, `vaultLimits`): app known and active (the app row cached per isolate
   for 30 s, `apps/api/src/app-cache.ts`, D78), `Origin === VAULT_ORIGIN`, `x-hana-parent-origin` allowed for the app,
   no `scope_conflict`, vault limits (60/min per IP per app, a per-location binding; then 10 × plan `per_minute` per
   app on the `app:<id>` object; the share actions' 10/min per share, a per-location binding, comes after the body
   check; D95).
2. `VAULT_KEK` loaded, else 503 `vault_key_unavailable`. App `persistence` must be `'session'` (409 `persistence_off`).
3. Signature by the session key over the vault message (shareId zero, counter 0, payload
   `"share" ‖ borsh(parentOrigin)`; `apps/api/src/vault/message.ts`).
4. `get_session` straight from RPC (no cache), retried every 300 ms for up to 2 s: live, the app's scope,
   `used === max_uses` (`endpoints.ts:151`).
5. Insert with `UNIQUE(session_pk)`: one share per session key. `K_s` (32 random bytes) is stored only as `share_enc =
   iv ‖ AES-GCM(VAULT_KEK, K_s, aad = share_id ‖ app_id ‖ session_pk)` (`apps/api/src/vault/kek.ts:77`).
   `abs_expires_at = min(session expiry, now + session_ttl_ms)`, `idle_until = min(now + idle_ttl_ms,
   abs_expires_at)`. `K_s` goes back to the vault once.

The vault writes an IndexedDB record `hana-vault/records` keyed `<signer>|<appId>|<scopeId>|<keyIndex>` holding the
non-extractable session `CryptoKeyPair`, `shareId`, counter, addresses, and `ct = AES-GCM(K_s, PRK, aad)` with the AAD
of `recordAad` (`layouts.ts:143`; `packages/web/src/vault/record.ts`), then zeroes `K_s`.

Unlock on reload or new tab, `POST /v1/vault/unlock` (`apps/api/src/vault/endpoints.ts`, `settingsRefusal`): the
vault gate as above, then the per-share limit 10/min → share looked up by `share_id AND app_id` (another app's share is 404) → if the share's partner origin
is no longer allowed, mark revoked, 410 → the app's settings as they are now: `persistence = 'none'` revokes the share
(410 `share_revoked`), and the share ends at `min(abs_expires_at, created_at + current session_ttl_ms)` (410
`share_expired`; the stored expiry is lowered) → vault signature with `counter = n + 1` → unwrap `K_s` (before the
counter moves) → one atomic `UPDATE … WHERE counter = n AND now < idle_until AND now < abs_expires_at AND revoked_at
IS NULL` that re-checks persistence and the TTL cap in the same statement, caps `abs_expires_at`, slides `idle_until`
to `min(now + current idle_ttl_ms, the cap)` and re-wraps under the current KEK if needed
(`apps/api/src/vault/shares.ts`, `advanceShare`) → `{ks, counter, idleUntilMs, absExpiresAtMs}`. No chain RPC. Errors:
404 `unknown_share`, 409 `bad_counter {expected}`, 410 `share_expired` / `share_revoked`. A 410 means a full login,
never a derive.

`/v1/vault/touch` follows the same settings rules and slides `idle_until` without returning `K_s` (the vault sends it
at most every 10 min after an approved signature, `TOUCH_EVERY_MS`). The hourly cron deletes shares past
`abs_expires_at` or revoked and re-wraps up to 2000 rows from `VAULT_KEK_PREVIOUS` (`apps/api/src/vault/cron.ts:63`).

In-memory idle limit (D55, `packages/web/src/vault/vault.ts` `goIdle`/`wake`): every request that uses the key
(signing, export, revoke-other-devices, an auto-approve consent request) restarts a timer of the app's `idle_ttl_ms`;
reads (status, `eth_accounts`, `stellar_getAddress`, `hana_autoApproveStatus`) don't, so polling can't keep PRK, and
every use re-checks it on the server-corrected clock (a throttled timer can't keep PRK). When it passes, PRK is
zeroed. In `'session'` mode the session goes dormant: the vault keeps only the addresses, expiry and share id and this
tab's last known consent, still answers status, addresses and auto-approve status (from that consent: its counters may
lag other tabs' auto-signs) without unlocking, and before the next request that needs the key unlocks the record again
(one `/v1/vault/unlock`, same share only). If that fails (the server share's own idle or absolute limit passed, or it
was revoked) the session ends with `sessionExpired`. A dormant session also ends at `expiresAtMs`, on logout and on a
`revoked` broadcast for its share. In `'none'` mode the idle limit ends the session.

### Signing: approval popup vs auto-approve

Code: `packages/web/src/vault/` (queue, signing, policies), `packages/web/src/auth/approve-page.ts` (popup),
`packages/web/src/client/ethereum.ts` (EIP-1193), and the `@hana-id/core` pieces named here.

| Tier | Methods |
|---|---|
| Silent | `hana_status`, `stellar_getAddress`, `eth_accounts`, `eth_chainId`, `getNetwork`, `hana_logout` |
| Popup unless an accepted auto-approve policy matches | `stellar_signTransaction`, `stellar_signAuthEntry`, `eth_signTransaction` (and `eth_sendTransaction` via it), `eth_signTypedData_v4` |
| Popup every time | `stellar_signMessage`, `personal_sign` (`NEVER_AUTO_APPROVED_KINDS`, `packages/core/src/approval.ts:41`) |
| Per app `raw_sign` | `hana_signRaw`: `'off'` → 4100; `'approval'` → popup with the raw warning, never auto-approved. The vault re-reads `rawSign` from `GET /v1/app` before each raw request when its last check is 10 s old (as for the policy); `'off'` there stops raw requests in that tab until a reload, and a failed re-read refuses (`api_unavailable`, `raw_sign_unconfirmed`) |

Test apps (D39, `packages/core/src/networks.ts`): for a `pk_test_` key the vault refuses, before any popup or
policy, a Stellar transaction or auth entry for the public network's passphrase, an EVM transaction on a chain outside
`TEST_EVM_CHAINS`, and typed data whose domain `chainId` is outside it (4100 `mainnet_not_allowed`). Messages, typed
data without a `chainId` name no network and pass. Raw requests are refused outright for test apps (4100
`raw_not_allowed_for_test_apps`, whatever `raw_sign` says): a raw digest can be a mainnet transaction's hash. The
EIP-1193 provider refuses switching to or
adding such a chain, and `eth_sendTransaction`/`eth_signTransaction` on one, before anything is filled. Every
approval and consent screen of a test app says Hana signs only for test networks (`testApp` in the popup messages).

Approval (D99): a signing call made in a click opens `{authOrigin}/approve?from=partner&v=<vault frame>` in that click
(`packages/web/src/client/approval-window.ts`, synchronously, with user activation, unless an approval popup is
already open) and sends the request flagged `popupOpened`. The popup finds the vault as the login popup does
(`opener.frames[v]`, origin and window checked both ways); the vault adopts it for the head of its queue, holds its
launcher up to 3 s for that hello, and tells a popup that showed nothing to close (`hana:approve-close`) when the
request was auto-approved or refused. Without activation or with `window.open` null (Safari after an await), the
vault queues the request and shows its launcher, whose click opens `{authOrigin}/approve` from the vault. Either way
the popup decodes the bytes itself (`decodeApprovalRequest`, `packages/core/src/decode/request.ts:55`; EIP-712 through
`normalizeTypedData`, `packages/core/src/typed-data.ts:266`), guards Approve (`approve-guard.ts`: 1 s after render,
1 s after focus, then a mouse move, a touch or pen press, or Tab/an arrow key; the arming gesture never approves;
decisions D36), and returns `approvalDigest` (`approval.ts:179`; empty network context for messages, typed data and
raw, which the popup says aren't tied to one network, D35). The vault recomputes the digest from the queued request
and signs only on a match, deriving the chain key from PRK per signature and zeroing it (`withChainKey`,
`derivation.ts:98`). At most 100 requests wait; one the popup couldn't show is refused at once. The SDK fills fees
and nonces and broadcasts through the partner's RPC: `eth_sendTransaction` runs one at a time per chain, broadcasts on
the chain it was filled on, and never fills a nonce below one past its last broadcast.

Auto-approve: the app owner sets an `AutoApprovePolicyV1` (D1 `auto_approve_policy`, pending + effective time on
set/change, immediate on removal; served only if it validates: `effectiveSettings`, `apps/api/src/vault/settings.ts`).
The vault page inlines the policy in force, and an open vault re-reads it from `GET /v1/app` before an auto-sign when
its last check is 10 s old or more (and every 60 s), so a removal stops auto-signing in open tabs within 10 s. A
policy rule whose `maxValueWei` is below its `maxFeeWei` is refused by the validator (value plus fees counts against
it, D37, D69). The user accepts that exact `policyId` (`packages/core/src/policy/id.ts`) once in a consent screen;
then the vault signs a request without a popup only if `matchAutoApprovePolicy`
(`packages/core/src/policy/match.ts:95`) passes and the per-day counters (`packages/core/src/policy/usage.ts`) allow
it. Rules in `docs/security.md`. The consent screen (`packages/web/src/auth/render-consent.ts`, D44) shows each policy
contract as "✓ {verified name}" when `(chain, address)` is on Hana's verified list, otherwise as "{partner name} ·
named by {app}" (flagged "— not the verified …" when the name imitates a verified one), always with the short address
and a "View on {explorer}" link when the chain's explorer is known. The list and the explorer URLs are pinned data in
`packages/core/src/verified-contracts.ts`, built into the popup bundle; nothing reads them from D1 or the API.

### Revoke and logout

| Action | Path | Chain tx |
|---|---|---|
| Logout (default) | App-wide on the device: under the per-app lock, `POST /v1/vault/revoke` for this tab's share and for the stored record's share if it is another session's; the vault deletes the record, zeroes PRK and broadcasts `logout` on `hana-vault:<appId>`, which ends every tab of the app | none |
| New login | Revokes this tab's previous share and the overwritten record's share, broadcasting `revoked {shareId}`; only tabs holding that share end | none |
| Lost device | `POST /v1/vault/revoke-all`, only with a share created < 5 min ago; revokes the user's other live shares for `(app_id, path_hash)` and moves its own counter in one D1 transaction (`shares.ts`, `revokeAllFrom`): both or neither | none |
| On-chain revoke | `POST /v1/sessions/revoke` → `revoke_session` (20 Tgas), signed `sessionMessage(counter, "revoke")`; the precheck allows counter up to `max_uses + 1` so a spent session can still be revoked | yes; not used by default |
| Origin removed | the next unlock of each share made for that origin marks it revoked (410) | none |
| App switched to `persistence = 'none'` | the next unlock or touch of each of its shares marks it revoked (410) | none |

### Partner identity token

`docs/identity-token-spec.md` (D120, D127); endpoints and order of checks: `docs/api.md` "Identity token".

1. **At login** (and at the unlock of a record written before this, which has no proofs), while PRK is in memory, the
   vault makes one **wallet proof** per address: the Stellar and the EVM key (each derived for one signature inside
   `withChainKey` and zeroed) sign `"hana-id/identity-wallet/v1" ‖ 0x00 ‖ signer ‖ appId ‖ sessionPk ‖ chain ‖
   address`. They are kept in the session and in the IndexedDB record (format 2, `vault/record.ts`), and copied to a
   dormant session, so no later step needs PRK.
2. **The partner page calls `hana.getIdentityToken({maxAgeMs?})`** → port `hana_identityToken`, a silent method like
   `hana_status`: no popup, no PRK, never activity (it doesn't wake a dormant session or restart the idle timer).
   Logged out: `{identityToken: null}`.
3. The vault returns its cached token while more than 5 min remain (or half the token's life when the session's end
   made it short) and it is within `maxAgeMs`. Otherwise, under the Web Lock `hana-identity:<appId>` (so the app's
   tabs mint one at a time; a tab that waited finds the other's token), it signs the **session proof**
   (`"hana-id-identity-v1:" ‖ signer ‖ appId ‖ sessionPk ‖ issuedAtMs ‖ nonce ‖ sha256("identity-token" ‖ parentOrigin ‖
   walletProofsHash ‖ sha256(""))`, with its server-corrected clock) and calls `POST /v1/identity/token`. In an app
   that keeps logins it first waits for the login's background persist (D79): the API needs the share.
4. **The API** checks the proof (±60 s, signature, single use), that the contract isn't paused, the share (in a
   `session` app: live, read-only, nothing moves), the on-chain session (live, in the app's scope), both wallet proofs,
   its limits; computes `sub` (HMAC of the path's root identity with `IDENTITY_SUB_KEY`, per scope, `key_index`
   dropped) and `sid` (HMAC of app and session key); sets `exp = min(iat + 1 h, session end)`; signs ES256 with the
   active key and checks the signature with the published key before answering.
5. The vault caches the token, announces it on `hana-vault:<appId>` (`{t: 'identity', sessionPk, token, iatMs,
   expiresAtMs}`: the session's other tabs cache it too) and emits `identityTokenChanged` to its partner page. A `410
   session_ended` ends the session in the vault as a revoked share does (`sessionExpired`).
6. **The partner backend** verifies the token against `{iss}/jwks.json` (cached 10 min): `alg` ES256, `typ`
   `hana-identity+jwt`, `iss`, `aud` = its app id, `exp`. The token is never accepted by any Hana API or the contract.

The cache is dropped (and `identityTokenChanged(null)` sent) at logout, expiry, revocation, a newer login, and when a
dormant session ends; it survives a session going dormant. The React hook `useIdentityToken` refreshes at `exp` − 5
min while the page is visible.

### Owner and registry changes

| Change | Who / how | Code |
|---|---|---|
| Register a scope (pilot) | Hana: `admin scope:register` → `admin_register_scope` with the owner account's full-access key | `scripts/admin.ts`, `scripts/lib/admin-scope.ts` |
| Register an app, origins, suspend/resume | Hana: `admin app:create`, `app:origins:add/remove`, `app:suspend/resume` (D1 via `wrangler d1 execute`); refuses a `pk_test_`/`pk_live_` scope conflict | `scripts/admin.ts`, `scripts/lib/admin-sql.ts` |
| Vault settings (`persistence`, TTLs, `raw_sign`, policy, web client) | Hana: `admin app:settings` (D1; `--raw-sign approval` and a new or changed policy are pending for 24 h, `changeDelayMs` in dev envs, D52; turning either off is immediate; the UPDATE applies only over the row it read) | `scripts/lib/admin-settings.ts`, migration 0003 |
| Propose / cancel / remove client / disable shared login (OIDC owner) | `POST /v1/owner-actions` with a console-client token; off-chain precheck, single-use token marker, owner pool | `handleOwnerAction` `handlers.ts:396`, `apps/api/src/owner-actions.ts:31` |
| Execute a matured change | anyone; `POST /v1/owner-actions` relays `execute_change` | same |
| NEAR-account owners | call the contract directly (the API relays OIDC auth only, `apps/api/src/validate.ts`) | `contracts/hana-signer/src/registry.rs` |
| Shared clients, sponsors, console audiences, issuers | owner account via `deploy-contract` | `scripts/deploy-contract.ts`, `scripts/lib/deploy-plan.ts` |
| Google RSA keys | the 15-min cron with `KEYS_UPDATER_KEY` proposes adds and (after ≥ 55 min missing, never the last key) removals, and executes matured changes that match Google's JWKS; a key is active only after `issuer_key_delay_ms` or a watchdog's confirmation | `apps/api/src/issuer-keys.ts`, migrations 0002, 0005 |

Timelocks, quarantine and shared-client rules: `docs/contract-interface.md` "Registry" and "Shared clients".

### Key export

`packages/web/src/auth/export-page.ts`: `hana_export {chain}` → launcher → top-level `{authOrigin}/export` window,
which runs its own fresh login (`/login?mode=export`, `max_age=0`, `max_uses = 1`) through `/v1/login`, decrypts
against its own path, aborts if the address differs from the vault's, and shows the key (SEP-23 `S…` or `0x` hex)
while a button is held after a typed confirmation. The key is erased 5 min after it is derived, or earlier when the
vault session ends: the context carries `sessionExpiresAtMs`, and the vault's `cancelExport` posts
`hana:export-end` on logout, revoke, expiry, a newer login or its 15 min job limit; the window also ends if its vault
frame goes away (D111). The vault's PRK is never used for export. The `auth_time` freshness
check is off (Google returns no `auth_time`, D27; `maxAuthAgeMs`, `packages/core/src/id-token.ts`). Encodings:
`packages/core/src/export.ts`. The export window takes its context only from the vault frame that opened it (its
`opener`, origin `vaultOrigin`), and the vault opens it only from its own launcher's click, so a partner page can't
start an export on its own. Its `/v1/login` is relayer-paid and limited to 3 per hour per user path per app
(`apps/api/src/login.ts`, D59).

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
| Scope id, Google `sub`, `key_index` | yes, per user / app | per login; `sub` is the same across clients, also in different Cloud projects (D42) |
| HKDF labels, tuples, key rules (derivation v1) | yes, all | names confirmed 2026-10-28; frozen at the address freeze |
| New chain tuples, new `account` values | no (additive) | open |
| `vaultOrigin`, `authOrigin`, `create_session_and_derive`, persistence, own vs shared client | no | `authOrigin` still breaks own-client redirect registrations if changed |

Contract v3 (email login, `feat/email-login-1`, not deployed) adds no input to this table for existing identities:
the path's `(provider, sub)` is the session's path identity, which is the token's own unless the identity is a member
of an account, when it is the account root's (an existing path, so linking never creates or moves an address). Email
identities use provider `email` and a `sub` derived off chain (`docs/email-login-spec.md` "Address impact"; frozen
at the address freeze).

Before the freeze, anything that changes an address must be called out (CLAUDE.md); after it, never. A scheme change
would be `hana-id/chain-keys/v2/extract`, opt-in, with v1 still derivable.

## Data stores

| Store | Holds | Never holds |
|---|---|---|
| `hana-signer` state (public) | Config (owner, mpc, domain, sponsors, console audiences, shared clients, change delay), issuers and Google RSA public keys, scopes (owners, clients, pending changes, `action_nonce`), client index, quarantine / retired-client records, sessions (`path`, `scope_id`, `expires_at_ms`, `max_uses`, `used`), revoke tombstones, expiry FIFO | Keys, S, PRK |
| NEAR transaction args (public forever) | Google ID tokens used in `create_session*`, register proofs, owner tokens; session signatures; BLS `pk1`/`pk2`; MPC responses (encrypted to `a`) | Anything usable without the session key or `a` |
| D1 `DB` | `plans`, `apps` (+ 0003 settings: `persistence`, `session_ttl_ms`, `idle_ttl_ms`, `raw_sign*`, `auto_approve_*`, `google_web_client_id`), `app_origins`, `usage` (`sessions`, `derives`, `unlocks` per app per UTC day), `issuer_key_missing`, `vault_shares` (`share_enc` under `VAULT_KEK`, `session_pk`, `path_hash`, `partner_origin`, counter, times), `identity_issuance_hourly` (tokens per signing key and hour), `identity_usage` (tokens per app and day) | Plaintext `K_s`, tokens, user ids (only `sha256(path)`), identity tokens, `sub`, `sid`, addresses |
| `RelayerKey` DO storage | Per key: `publicKey`, nonce reservation, last block hash and time | Secret keys (they are Worker secrets) |
| `RateLimiter` DO storage | `<window>@<start>` counters; `mark:<sha256(owner token)>` single-use markers until the token's `exp`; `mark:<sha256(identity proof signature)>` until the proof's `issuedAtMs` + 120 s | Tokens |
| `LoginRelay` DO storage | One slot: `{iv, ct}` for ≤ 120 s, then a tombstone for 120 s | Plaintext tokens (the API has no `relayKey`) |
| Per-isolate memory (API) | JWKS (≤ max-age, stale ≤ 6 h on fetch failure), config / scope / client views (≤ 60 s; "no scope" ≤ 10 s), sessions (≤ 10 s), parsed KEKs, counter holds | — |
| Browser, `vaultOrigin` | IndexedDB `hana-vault` records (partitioned by top-level site; format 2 adds the identity wallet proofs); memory: session key, PRK, consent and counters, the current identity token | S, `a` (memory only, dropped), plaintext PRK on disk, an identity token on disk |
| Browser, `authOrigin` | `sessionStorage` `hana.login.<relayId>` = `{v, createdAt, relayKey}` (≤ 10 min, single use) | Tokens |
| `.secrets/<env>/` (operator machine, gitignored, 0700/0600) | `relayer-keys.json`, `owner-relayer-keys.json`, `keys-updater.json` (`scripts/lib/secrets.ts:66`), `vault-kek` (+ `vault-kek.previous` during a rotation; `scripts/lib/vault-kek.ts`), `identity-signing-key.json`, `identity-signing-key-standby.json`, `identity-sub-key` (`scripts/lib/identity-key.ts`) | — |
| `~/.near-credentials/testnet/` (operator machine) | Full-access keys of the owner, signer and relayer accounts (`scripts/lib/keys.ts`) | — |
| Worker secrets | `RELAYER_KEYS`, `OWNER_RELAYER_KEYS`, `KEYS_UPDATER_KEY`, `VAULT_KEK`, `VAULT_KEK_PREVIOUS`, `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`, `IDENTITY_SUB_KEY` | — |
| Watchdog D1 (its own Cloudflare account) | `meta` (last chain snapshot, failure counters, heartbeat, digest, run lock, the last relayer funds reading), `seen_kids` (kid, `n`, `e`, first/last seen; `baseline` kids from the first run), `absences`, `runs` (30 days), `actions` (method, args, tx hash), `alerts` (severity, details, acks), `deliveries` | Secrets, tokens |
| Watchdog Worker secrets | `WATCHDOG_KEY`, `WATCHDOG_STATUS_TOKEN`, `RESEND_API_KEY`, `SLACK_WEBHOOK_URL`, the paging app's credentials, `HEARTBEAT_URL` (from `.secrets/<env>/watchdog-secrets.json`) | — |
| `apps/api/.dev.vars` (local, gitignored, 0600) | Relayer and updater keys and the identity token's secrets for `wrangler dev` (`gen-wrangler --dev-vars`) | — |
| Partner backends | Identity tokens they received (≤ 1 h each), and whatever they keep from them (`sub`, `sid`, addresses) | Anything that reaches a key |

## Environments and manifests

- One manifest per env, `envs/<env>.json`, validated by `packages/env/src/schema.ts` (zod) and loaded with `loadEnv`.
  Only `sandbox-dev` exists. `network` accepts only `testnet`. Every account name the code uses comes from here
  (`signer`, `relayer`, `owner`, `mpc`); code reads it via generated config, never by hard-coding names.
- Other fields: `ckdDomainId`, `ckdNetworkKey` (pinned with `scripts/fetch-ckd-key.ts`), `rpc`, optional
  `rpcFallback` (https, not `rpc`; the vault's and the export window's second NEAR RPC, in their CSP, and the
  Workers' `NEAR_RPC_FALLBACK`), `apiUrl`,
  `vaultOrigin`/`authOrigin` (both or neither; bare origins; `https`; loopback only in `local*` envs; otherwise a real
  DNS name, never an IP, a bare public suffix, a single label or a trailing dot; different origins, neither
  `apiUrl`'s origin; different sites from each other and from `apiUrl` outside `local*`/`sandbox*`,
  `packages/env/src/schema.ts`, `origins.ts`), `changeDelayMs`,
  `googleClientIds` (the `global` scope), `sharedGoogleClientIds` (≤ 5, disjoint from scope clients),
  `consoleAudiences`, `cloudflare.{workerName, d1Name, durableObjectLocation}`, and the optional `watchdog` block
  (`account`, `cloudflare.{accountId, workerName, d1Name}`, `alertEmails`, `alertFrom`, `pager`, `digestHourUtc`;
  `apps/watchdog/scripts/gen-wrangler.ts` writes the gitignored `apps/watchdog/wrangler.jsonc` with that account id).
- Dev envs are `local*`/`sandbox*` by name (`packages/env/src/origins.ts:9`, mirrored in `apps/api/src/origins.ts:26`
  and as `devEnv` in the web build). They allow loopback partner origins and partner-origin session endpoints for
  `pk_test_` keys, and same-site Hana origins. No flag can turn these on elsewhere.
- `apps/api/scripts/gen-wrangler.ts` writes `apps/api/wrangler.jsonc` (vars from the manifest, D1 binding, DO bindings
  and migrations `v1` RelayerKey/RateLimiter, `v2` LoginRelay, the vault's two `ratelimits` bindings, the 15-min cron whose :00 run is the hourly one) and, with `--dev-vars`, `.dev.vars` from
  `.secrets/<env>/`, plus the page Workers' `wrangler.vault.jsonc` / `wrangler.auth.jsonc`. It refuses an env without
  both Hana origins. All three are per env and gitignored (the deployed D1 id is passed with `--d1-id` and never
  committed); the API tests generate their own `wrangler.vitest.jsonc` from a fixed test manifest.
- `packages/web/scripts/gen-envs.ts` writes the gitignored `packages/web/src/envs.generated.ts` with the pinned
  per-env constants (`signer`, `relayer`, `rpc`, `rpcFallback` when set, `ckdNetworkKey`, origins, `devEnv`) for every
  manifest with both origins; it fails on an unusable CKD key.
- Runtime flags, `"0"` everywhere for now (`FLAG_DEFAULTS`, `gen-wrangler.ts`): `BLS_PRECHECK` (Workers Paid plan
  only, D64), `REJECT_PII_ON_SESSIONS` (the user turns it on after the spec's step 7; `apps/smoke/direct.html` still
  sends Google Identity Services tokens, which carry `email`).
- sandbox-dev runs on `*.tingtc.workers.dev` (personal Cloudflare account, free plan). Production env and a Hana
  domain are deferred (`docs/decisions.md` D18; two registrable domains, D38).

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
  (`apps/api/src/placement.ts:20`). Per-IP limiters and `LoginRelay` objects are created near their caller. The
  vault's per-IP and per-share limits are Rate Limiting bindings, counted where the Worker runs (D95).
- **Request log** (`done`, `handlers.ts`): per-stage timings (`app`, `limits`, `checks`, `relay`, `relayQueue`,
  `relayChainRead`, `relaySign`, `relayPersist`, `relayOutcome`; the vault endpoints add `settings`, `session`,
  `insert`, `share`, `advance`), `colo`, `relayInstance` (cold, chain read, block refresh). Never
  tokens, signatures, bodies, keys or CKD responses. A `pk_test_` app's `/v1/login`, `/v1/vault/shares` and
  `/v1/vault/unlock` also return the total and phases as `timings` (`docs/api.md` "Timings"), which the vault adds to
  the per-stage timings it reports to the partner client (`packages/core/src/timings.ts`).

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
| identity token | An ES256 JWT (≤ 1 h, `typ: hana-identity+jwt`) for a partner's backend: `sub`, `sid`, proven `wallets`, `login_methods`; minted by the API for the vault's live session |
| `sub` (identity token) | `u1_` + HMAC-SHA256(`IDENTITY_SUB_KEY`, scope ‖ root provider ‖ root sub)[0..16]: per scope and account, never the Google `sub` |
| `sid` | `s1_` + HMAC-SHA256(`IDENTITY_SUB_KEY`, app id ‖ session key)[0..16]: one per session, new at each interactive login |
| wallet proof | A signature by an address's own key over the identity wallet message, bound to the session key and app |
