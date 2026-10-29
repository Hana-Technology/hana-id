# Hana Home spec: cross-app wallets, key export and consent revocation (pre-mainnet)

**Status: DRAFT (2026-10-29), not reviewed by the user.** Implements `docs/decisions.md` D40 (Hana Home before
mainnet) and D45 (list and revoke auto-approve consents per device from any device), under D41 (export stays
available, not featured) and D42 (Google client tiers). Every proposal and the [open questions](#open-questions) need
confirmation before implementation. Nothing here is built.

This file is the source of truth for the batch once approved. If code and this spec disagree, fix the code or raise
the problem. Reference docs (`architecture.md`, `security.md`, `api.md`, `integration.md`, `operations.md`) are
updated in the same branch as the code, not now.

## Goal

A user opens `{authOrigin}/home`, signs in with Google, and from one Hana page:

- sees the partner apps whose wallets Hana can still open for them, and for each one their addresses (Stellar `G…`,
  EVM `0x…`, account 0, `key_index` 0);
- exports a chain's private key with the same safeguards as today's export window (fresh Google sign-in, typed
  confirmation, hold to reveal), so a partner app shutting down doesn't strand them;
- sees every device (browser session) signed in to each app and its active auto-approve consent, and stops a consent
  from any device.

Done when every behaviour under [Tests](#tests) has a passing test, the sandbox-dev run in
[Build order](#build-order) step 8 is recorded in `docs/context.md`, and no contract change was needed.

## Address impact (read first)

None. Home derives with the existing path `scope#google#sub#key_index` through the existing
`create_session_and_derive`, the pinned signer and CKD key, and derivation v1. Nothing here changes a path, a label, a
tuple or a key rule.

## Current state (verified against the code, `develop` at eb18ab5)

| Fact | Where |
|---|---|
| Export runs only in a top-level `{authOrigin}/export` window the vault's launcher opens; it takes its context (app, scope, chain, address) from the vault, runs its own login (`/login?mode=export`, Google `max_age=0`, `max_uses = 1`, 15 min session), aborts if the address differs from the vault's, shows the key after typing `EXPORT` while a button is held | `packages/web/src/auth/export-page.ts` (`EXPORT_SESSION_TTL_MS`, `EXPORT_CONFIRMATION`), `google.ts` `forceReauth` |
| `/v1/login` needs an **active** app (`x-hana-key`), and from `authOrigin` an `x-hana-parent-origin` the app allows; exports are limited to 3 per hour per `(app, sha256(path))` | `apps/api/src/handlers.ts` `appGate`, `origins.ts` `checkCaller`, `login.ts` `EXPORTS_PER_PATH_HOUR` |
| So a suspended or deleted app, or one with no allowed origin left, can't export today | same |
| `GET /v1/app` picks the scope's own Google client first and the shared client only when the scope has none | `handlers.ts` `handleAppConfig` |
| The contract accepts a shared-client token for any scope with `allow_shared`, a scope client's token only for its scope; the path has no client id | `docs/contract-interface.md` `create_session` |
| Auto-approve consents live **only** on the device: sealed (AES-GCM under a key HKDF'd from PRK, info `hana-id/vault/consent/v1`) inside the vault's IndexedDB record in `'session'` mode, in memory in `'none'` mode. The server holds nothing about consents | `packages/web/src/vault/record.ts`, `vault.ts` `withConsent`, `revokeAutoApprove` |
| The server holds per-device shares: `vault_shares (app_id, path_hash = sha256(path), partner_origin, created_at, idle_until, abs_expires_at, revoked_at)`, indexed on `(app_id, path_hash)`, deleted by the hourly cron after expiry or revoke | `apps/api/migrations/0003_vault.sql`, `vault/cron.ts` |
| An open vault auto-signs only under a policy `GET /v1/app` confirmed < 10 s ago (D62); it re-reads every 60 s while a policy is in force | `vault.ts` `POLICY_FRESH_MS`, `freshPolicy` |
| A revoked share ends an open tab only at its next unlock, touch (≤ 10 min after an approved signature) or in-memory idle (D55); until then it can still auto-sign | `vault.ts` `maybeTouch`, `goIdle` |
| The `shareId` never leaves `vaultOrigin` and the API (port messages carry none; only the vault's own BroadcastChannel does) | `packages/core/src/protocol.ts` `VaultBroadcast` |

## Coverage: which apps Home can open

Home can open a scope's wallets only if it can get a Google ID token that `hana-signer` accepts for that scope, with a
nonce Home chose. Google issues a token for a client only to that client's registered redirect URIs (and JS
origins). In batch B every client used with Hana, shared or own, redirects to `{authOrigin}/login/callback`, so the
limit is not "only the partner's origins" but **who controls whether the client and its redirect URI keep existing**.

| Scope on chain | Tier (D42) | Home | Why |
|---|---|---|---|
| `allow_shared`, no own client | Standard (default; Sodax pilot) | **Covered** | Hana's shared client, scope from the nonce. The owner can't `disable_shared_login` without a client of its own (`Cannot disable shared login: the scope has no clients`), and adding one is timelocked (`change_delay_ms`) |
| `allow_shared` and own clients | Standard moving to Enterprise, or a partner keeping both | **Covered while `allow_shared`** | Home uses the shared client even though `GET /v1/app` picks the own one: the path has no client id, so the addresses are the same (D12, D42). The owner can `disable_shared_login` at once; coverage then falls to the next rows |
| Own client held by Hana, no `allow_shared` | Enterprise (D42) | **Covered while Hana keeps the Google project and the client stays in the scope** | Hana controls the project and its redirect URIs. `remove_client` can't remove a scope's last client without `allow_shared`; replacing it needs a timelocked `AddClient` first (events `change_proposed`, `client_removed`). The Google screen shows the partner's brand |
| Own client held by the partner, no `allow_shared` | Partner-held (D42, discouraged) | **Best effort** | Works only while the partner's client exists and lists `{authOrigin}/login/callback`. At shutdown the partner (or Google) can delete the client or project; nobody can then mint a token with that `aud`, the contract accepts no other client for the scope, and its wallets are unreachable for good. Hana can't prevent it |
| No usable client (shared login off and no own client in force, or no shared client in force) | — | Not covered | Nothing can open a session |

Correction to D40's wording ("only their origins can get tokens for that client"): Hana's callback can get them while
the client exists. The real limit is control of the client. Home therefore lists partner-held-client apps as "best
effort" (Q2) and covers Enterprise (Q3).

Things that stop coverage of a covered scope:

| Event | Who | Effect | Mitigation |
|---|---|---|---|
| `disable_shared_login` on a scope with an own client | any scope owner, immediate | shared route gone; falls to the own-client row | none on chain (Q4); Home shows "Hana can no longer open this app's wallets" from `get_scope` |
| `set_shared_clients` removing the last shared Google client | Hana's owner, immediate | every shared-only scope uncovered, and unusable | operational rule: rotate by adding first (Q5) |
| Hana stops paying for or deletes an Enterprise project | Hana | that scope unreachable | contract term (Q3) |
| Governance pause (D86) | owner multisig / watchdog | every derive, Home's included | by design |

App status in D1 (suspended, soft-deleted in batch C) does **not** stop Home: Home is keyed by scope, not by app.

## Identity without a user database

Home needs to know who the user is (for the device list, revocation and per-user limits) without a chain transaction
and without storing an account. It uses a **Home identity**: a Google ID token from Hana's shared client whose nonce
commits to a key held only in the Home page.

1. On "Sign in", Home makes a non-extractable Ed25519 key `hk`, a 32-byte `salt`, and `expiresAtMs = now + 15 min`
   (server-corrected clock from `GET /v1/home/config`).
2. `homeNonce = b64url(sha256(utf8("hana-id/home/v1") ‖ borsh(signer) ‖ hk_pub(32) ‖ u64le(expiresAtMs) ‖ salt))`.
   The prefix differs from `hana-id/session/v1`, so a Home token can never open a session on chain, and a session
   token (public forever in the transaction args) can never be a Home identity.
3. Home opens a child `/login?mode=home` exactly like the export window opens `/login?mode=export` (the child accepts
   `hana:auth-params` only from its same-origin opener at `/home`); Google with the first shared Google client in
   force, `scope=openid`, `prompt=select_account`, no `max_age`. The token comes back through the encrypted relay; Home
   verifies it as the vault does (RS256 against Google's JWKS, `iss`, `aud`, `exp`/`iat`, claim allow-list, nonce).
4. Every Home API call carries header `x-hana-home: b64url(json {jwt, key: hk_pub, expiresAtMs, salt, counter, sig})`
   with `sig = Ed25519(hk, utf8("hana-id-home-v1:") ‖ borsh(signer) ‖ u64le(counter) ‖ sha256(borsh(method) ‖
   borsh(path) ‖ body))`. The API checks, in order: `Origin === AUTH_ORIGIN`; the token (RS256, `iss`, `exp` with
   60 s skew, claim allow-list); `aud` is a shared Google client **in force** (never a scope client: a partner-held
   client with partner JS origins could mint a Home token for its users and then read or revoke their consents in
   every app, since `sub` is global); nonce = `homeNonce`; `now < expiresAtMs ≤ now + 20 min`; the signature;
   `(sha256(hk_pub), counter)` unused, then marked single-use until `expiresAtMs` (the `RateLimiter` DO's existing
   `mark:` store). The result is `sub`.
5. No cookie (D70), no storage: a reload or 15 min means signing in again (one Google click; no chain cost).

A per-app derive (below) also checks that its token's `sub` equals the identity's (`home_account_mismatch`); Home
sends `login_hint=<sub>` so Google preselects the same account.

## Discovery: finding a user's apps

What exists today, and what it already reveals:

- **The chain is already a public `sub → scopes` index.** Every login puts the Google token (with `sub` and `aud`) in
  `create_session_and_derive`'s arguments, public forever, and the session stores `path = scope#google#sub#0`. Anyone
  with an archival node can list every scope a `sub` ever logged in to, with times. What is **not** public: `sub` ↔
  email (openid-only tokens, D25) and `sub` ↔ wallet address (addresses come from the secret CKD output).
- `vault_shares.path_hash = sha256(path)` is not a pseudonym against anyone who knows `sub`; it lives ≤ 23 h 50 min.
- Batch C plans `usage.app_users (app_id, uid)` with `uid = HMAC(USER_ID_KEY, "hana-id/uid/v1" ‖ scope ‖ provider ‖
  sub)[0..16]` for new-user counts (24-month retention, purged 30 days after an app's deletion).

| Option | How Home finds apps | New data held by Hana | Privacy cost | Works after shutdown |
|---|---|---|---|---|
| **A. Directory (proposed)** | Home lists every coverable app with at least one login ever (D1 `usage.sessions > 0`), grouped by scope, searchable. Apps with a **live** share for this user are marked "signed in on N devices": the API computes `sha256(scope#google#sub#0)` for each scope at request time and looks them up in `vault_shares` (new index on `path_hash`); nothing is stored | none | none beyond today: the API already sees `sub` at every login and made those shares | yes (the directory is keyed by scope; the app row stays, batch C never hard-deletes) |
| B. Server index | `/v1/login` upserts `home_seen(HMAC(HOME_INDEX_KEY, sub), scope_id, first_seen_day, last_seen_day)`; Home shows "your apps" | a durable per-user cross-app record | same information as the chain, but cheap to query and in one database; a D1 dump plus the key re-links every user across apps; a new erasure and retention duty | yes, if retention outlives the app |
| B'. Reuse batch C `app_users` | Home computes each scope's `uid` and queries the ledger | none new | turns a billing record into a user-facing feature (purpose change); crosses the ledger's role separation | **no**: purged 30 days after the app is deleted |
| C. Chain scan | an archival indexer over `create_session*` args finds the user's scopes | an indexer (or a provider such as NearBlocks) | equivalent to B in power; adds a third party that learns which `sub` Home asks about | yes |
| D. Encrypted "my apps" list | Home keeps a list encrypted under a key from a CKD on a dedicated `home` scope; the server stores only ciphertext | ciphertext | none (size only) | yes, but only for apps the user once opened **in Home**; costs one CKD per Home visit |

Proposed: **A** for launch. It holds no new user data and covers the shutdown case; its cost is that a user must
recognise the app in the directory (a short list at launch) and pays nothing extra. Revisit B only if pilot users
can't find their apps (Q1).

Per-scope derivation in every option: one session per scope, `nonce = sessionNonce(SIGNER, scopeId, hk2, …)` with a
fresh session key, so one Google token opens one scope only. A multi-scope session would need a new nonce layout
(contract change, audit) and would let one token open many scopes; not proposed.

## Wallets and export (per app)

From an app's page in Home:

1. **Show my wallets.** Home checks the scope on chain from its own RPC (D56 style): `get_scope(scopeId)` exists; for
   the shared route `allow_shared` and the client in `get_config().shared_clients`; for an own client
   `scope_for_client('google', clientId) === scopeId`. Then, as the export window does today: its own session key
   (`max_uses = 1`), salt, `expiresAtMs = now + 15 min`, nonce, relay keys; child `/login?mode=home`; Google with
   `max_age=0` and `login_hint`; relay read; token check; `POST /v1/home/login`; `S = decryptCkd(…,
   ckdAppId(SIGNER, path), pinned key)` with the pairing check; `PRK = extractPrk(S)`; both addresses shown.
2. **Export** (collapsed "Move this wallet to another wallet app" section, D41): pick a chain → the warning text of
   today's export window → type `EXPORT` → the key (SEP-23 `S…` or `0x` hex) is shown while the button is held, next to
   its address. Nothing is copied automatically.
3. Home keeps PRK in memory for at most 5 min after step 1 (or until the user leaves the app page or closes Home),
   deriving a chain key only on its export and zeroing it after; then PRK is zeroed and the next export needs step 1
   again. **Deviation:** today's export window derives one chain key per login and zeroes PRK at once (Q6).
4. No message in any direction carries key material; Home has no `opener` it listens to (it sets `window.opener =
   null` at load and acts only on clicks in its own page).

The vault-address check of today's export window has no counterpart: there is no vault. A lying API can only make
Home label scope B with app A's name; the user then exports B's key to themselves, which harms no one but confuses.

## Consents and devices (D45)

### Server-side state (new)

D1 table `vault_consents` (next free migration after batch C's):

```
consent_id     BLOB PRIMARY KEY   -- 16 random bytes, made by the vault at Allow
app_id         TEXT NOT NULL REFERENCES apps (id)
share_id       BLOB               -- the share it lives under ('session' mode); NULL in 'none' mode
session_pk     BLOB NOT NULL      -- 32 bytes
path_hash      BLOB NOT NULL      -- copied from the share, or sha256(get_session().path) in 'none' mode
partner_origin TEXT NOT NULL
policy_id      BLOB NOT NULL      -- 32 bytes
label          TEXT NOT NULL      -- the policy's label at grant (≤ 80 chars, POLICY_LABEL_MAX), rendered as text only
granted_at, expires_at INTEGER NOT NULL   -- unix ms; expires_at = the consent's own end (≤ session end)
revoked_at     INTEGER
revoked_by     TEXT CHECK (revoked_by IN ('device', 'home', 'share'))
-- index (path_hash), index (session_pk), index (expires_at); vault_shares gains index (path_hash)
```

A consent is **active** when `revoked_at IS NULL`, `now < expires_at`, and its share (if any) is live (not revoked,
`now < idle_until`, `now < abs_expires_at`). At most one active consent per `session_pk`: registering a new one
revokes the previous (`revoked_by = 'device'`). The hourly cron deletes rows past `expires_at` or revoked more than
1 h ago.

### Vault messages (new payloads, existing layout)

`vaultMessage(shareId, counter, payload)` as in batch B; in `'none'` mode `shareId` = 16 zero bytes and `counter = 0`
(as share creation).

| Action | Endpoint | `payload` |
|---|---|---|
| register | `POST /v1/vault/consents` `{shareId?, sessionPublicKey, counter, signature, consentId, policyId, expiresAtMs}` | `utf8("consent") ‖ consentId(16) ‖ policyId(32) ‖ u64le(expiresAtMs) ‖ borsh(parentOrigin)` |
| revoke (device) | `POST /v1/vault/consents/revoke` `{shareId?, sessionPublicKey, counter, signature, consentId}` | `utf8("consent-revoke") ‖ consentId(16)` |

Register checks: the vault gate; the signature; `'session'` mode: the share exists for this app and session key and is
live (the counter advances like touch); `'none'` mode: `get_session` live in the app's scope (one view, as share
creation); `policyId` equals the app's policy in force; `expiresAtMs ≤` the session's expiry. 409 `consent_exists` on
a repeated `consentId`.

### Vault behaviour (changed)

1. **Register before use, fail closed.** After Allow, the vault registers the consent before storing it locally. If
   that fails, nothing is stored and the consent screen's caller gets `{granted: false}` with `api_unavailable`, so
   Home never misses a consent (Q13).
2. **Status with the policy check.** The 10 s freshness read (`GET /v1/app`, D62) sends `x-hana-consent: b64url(
   consentId)` (accepted only from `Origin === VAULT_ORIGIN`) and gets `consent: 'active' | 'revoked' | 'unknown'`
   (one D1 point read, uncached). The vault auto-signs only when both the sealed local consent and a `'active'` read
   younger than 10 s agree; `'revoked'` or `'unknown'` clears the local consent and sends the request to the popup.
3. `hana_revokeAutoApprove`, "Stop auto-approving", logout and a new login clear locally first, then send the revoke
   (best effort; logout's share revoke already ends it server-side).

Revocation from Home therefore stops auto-signing in an open tab within 10 s (the next auto-sign re-reads), and in a
dormant or closed tab at its next use. Counters (per-day count and value) stay on the device only.

### Home: list and revoke

- `GET /v1/home/devices` (Home identity): for every scope that has a D1 app, the API computes
  `sha256(scope#google#sub#0)`, reads live shares and active consents by `path_hash` (chunks of 100), and returns per
  app: devices `{shareId, partnerOrigin, signedInAt, idleUntilMs, expiresAtMs, consent | null}` and consents without a
  share (`'none'` mode). This covers **every** app, own-client ones included: revocation needs no Google client for the
  scope, only the user's `sub`.
- `POST /v1/home/consents/revoke {consentId}` (Home identity): loads the row, recomputes `sha256(scopeOf(app_id)
  #google#sub#0)`, requires it equals `path_hash` (else 404 `unknown_consent`, revealing nothing), sets `revoked_at`,
  `revoked_by = 'home'`.
- A "device" is a share: one browser profile on one top-level site for one app session (storage is partitioned). The
  server knows no device name; Home shows the partner origin and sign-in time (Q10).

### Security properties

- **Narrow-only.** A server row can stop auto-signing, never start it: the vault still needs the sealed consent the
  user's guarded Allow created, bound to `policyId`, parent origin and end time (`consentDigest`).
- **Who can revoke:** the device (its session key) or whoever holds a Home identity for the `sub` (a Google sign-in as
  the user through Hana's shared client). Partners can't: they never receive shared-client tokens, and own-client
  tokens are refused as Home identities.
- **Compromised API or D1:** can hide consents from Home, report `'active'` for a revoked one (as it can serve a removed
  policy today, D62), or report `'revoked'` (denial of service). It can't create a consent or sign.
- **Privacy:** rows live ≤ a session (≤ 23 h 50 min) plus 1 h; they hold what `vault_shares` holds plus the policy id
  and label. The status read is keyed by a 128-bit `consentId` known only to the vault and the API.

## Lock-in stance (D41)

- The front page is "Your apps" and "Devices and auto-approve". Export is inside each app's page, collapsed, labelled
  "Move this wallet to another wallet app"; never on the front page, never removed, never behind support, never
  switchable off by partners, with no friction beyond the security checks.
- Home is the cross-app destination: one place for every Hana wallet and every consent. Links to it from Hana's own
  surfaces (the consent screen and the approval popup's "Stop auto-approving" area: "Manage in Hana Home"), never
  from partner-controlled UI only.
- Partners can't hide their app from Home or turn Home off for their users (Q8).

## UX flows

| # | Flow | Steps | Chain | Time |
|---|---|---|---|---|
| F1 | Sign in | `/home` → "Sign in with Google" → popup, account chooser → front page | none | Google + ~1 s |
| F2 | Your apps | directory grouped by wallet (scope): name, logo (batch C), origins, status ("active", "no longer active"), coverage badge, "signed in on N devices"; search | none | D1 + cached views |
| F3 | Open a wallet | app page → "Show my wallets" → Google re-auth (`max_age=0`, account preselected) → addresses with copy and explorer links | 1 tx | ~8–12 s + Google |
| F4 | Export | F3 → expand "Move this wallet…" → chain → warning → type `EXPORT` → hold to reveal | none within 5 min of F3 | — |
| F5 | Devices and auto-approve | list per app; each device: origin, signed in, ends; its consent: label, granted, ends → "Stop auto-approving" | none | one API call |
| F6 | Not covered | the app page explains why (shared login off, partner-held client gone), with "use the app itself" where it still runs | none | — |
| F7 | Wrong account | a per-app sign-in with another Google account → "Sign in as the same account you used in Home" | none | — |

Errors map to the existing auth-page error views (`errors.ts`), plus `home_account_mismatch`, `not_covered`,
`home_busy` (budget), `rate_limited`.

## API changes (`apps/api`)

| Endpoint | Auth | Does |
|---|---|---|
| `GET /v1/home/config` | `Origin === AUTH_ORIGIN` | `{serverTimeMs, signer, sharedGoogleClientId}` (first shared Google client in force) |
| `GET /v1/home/apps` | Home identity | the directory: `[{scopeId, coverage: 'shared' \| 'hana_client' \| 'partner_client' \| 'none', googleClientId, apps: [{appId, name, status: 'active' \| 'suspended' \| 'deleted', environment, origins}], liveDevices}]`; coverage from cached `get_scope`/`get_config` views (≤ 60 s) and D1 `hana_held_clients` |
| `POST /v1/home/login` | Home identity | `/v1/login`'s body plus `scopeId`. In order: IP limit; shape (`toLogin` with the body's `scopeId`, `^[a-z0-9]+$`); token (RS256, claims, nonce = `sessionNonce(SIGNER, scopeId, …)`); `sub` = identity `sub`; the Home limits; counter hold; `checkClientScope(provider, aud, scopeId)` and `session_key_in_use`; session signature; BLS shape; relay `create_session_and_derive` through the **Home pool**; failures as `loginFailure`. No app gate: no publishable key, app status, origin or plan limit applies |
| `GET /v1/home/devices` | Home identity | see [Home: list and revoke](#home-list-and-revoke) |
| `POST /v1/home/consents/revoke` | Home identity | same |
| `POST /v1/vault/consents`, `/v1/vault/consents/revoke` | vault gate + vault message | see [Vault messages](#vault-messages-new-payloads-existing-layout) |
| `GET /v1/app` | unchanged | gains `consent` when `x-hana-consent` is sent from `VAULT_ORIGIN` |

Also: `HANA_CALLERS`/CORS for the new paths (`authOrigin` only; `x-hana-home` and `x-hana-consent` allowed); D1
`hana_held_clients (provider, aud, scope_id, added_at)` written by a new `admin home:client:add` at Enterprise
onboarding; `home_usage (day, derives)` counter; request logs never carry `x-hana-home`, `sub` or path hashes.

**Home relayer pool** (D19 pattern): `HOME_RELAYER_KEYS`, default 1 key, method `create_session_and_derive` only,
receiver = signer, its own allowance; `deploy-contract` checks it like the session pool. A Home flood can't drain
partner logins.

## Contract changes

None. Optional ones are open questions (Q4). Home relies on: shared clients and `allow_shared` (A.2),
`create_session_and_derive` (B), the registry views, and the governance pause (D86) stopping its derives like any
other.

## Pages and packages

- `authOrigin` page Worker: new page `GET /home` with the base policy plus `frame-ancestors 'none'; connect-src
  {apiUrl} {rpc} {rpcFallback} https://www.googleapis.com` (and `img-src` the batch C files origin if logos ship).
  No new Google redirect URI: Home uses `/login/callback`.
- `/login?mode=home`: accepted only with `event.origin === authOrigin`, `event.source === window.opener` and
  `opener.location.pathname === '/home'`; Google with `max_age=0` for per-app derives, without it for the identity.
- `@hana-id/core`: `homeNonce`, `homeMessage` and the two consent payloads, with vectors.
- `@hana-id/web`: `auth/home-page.ts` (reusing `chain-login.ts`, the export window's decrypt and encodings), entry
  `entries/home.ts`; vault changes in `vault.ts` (register, status, revoke).

## Security model

| Attacker | Can | Cannot |
|---|---|---|
| Anyone who signs in to Google as the user | everything Home offers (from Hana's view they are the user) | — (inherent; the same holds for today's export from a partner app) |
| A partner page, or XSS on it | open `/home` in a window | drive Home (no messages accepted, actions need clicks in Home, `frame-ancestors 'none'`), get a Home or shared-client token |
| A partner holding its own client | mint tokens for its own scope (today) | a Home identity (shared clients only), so no listing or revoking in other apps |
| Compromised API logic or D1 (not the pages) | mislabel or hide apps, hide consents, ignore revocations, deny service, learn that a `sub` visited Home | derive for itself or substitute a key (Home fixes the path from its own token, the relay is end-to-end encrypted, the pairing check uses the pinned key), grant a consent, sign |
| Compromised `authOrigin` Worker or bundles, or Cloudflare account | everything, as today (single trust root) | |
| Someone who sees a Home token (API logs, a proxy) | nothing alone: each call needs `hk`'s signature and a fresh counter; the nonce is never valid on chain | |
| A flood of Home derives | spend up to the Home budget | touch the session or owner pools |

Invariants (each has a test):

- A Home-identity token is never accepted by a session method, and no session token (or any token whose nonce isn't
  `homeNonce` for the request's key) is accepted as a Home identity.
- Only a shared Google client in force yields a Home identity.
- Home never signs a transaction or message; it shows addresses and exports keys to the user only.
- Home uses only the pinned `SIGNER`, `RELAYER` and CKD key, and a path computed from its own verified token.
- A server consent row can stop auto-signing, never start it; the vault auto-signs only with an `'active'` read
  younger than 10 s.
- Every Home derive passes the per-path, per-user and global limits before anything is relayed.
- No message, log line or storage on `authOrigin` holds key material, a token or `sub`.

## Rate limits

| Endpoint | Per IP | Per user / key | Global |
|---|---|---|---|
| `GET /v1/home/config` | 60/min | — | — |
| `GET /v1/home/apps`, `/devices` | 30/min | 60/min per Home key | — |
| `POST /v1/home/consents/revoke` | 30/min | 30/min per Home key | — |
| `POST /v1/home/login` | 10/hour | 3/hour per `(scope, sha256(path))` (D59's bound), 10/hour and 20/day per user (`home-user:<hex sha256(sub)>`), counted after the token check | `HOME_DERIVES_PER_DAY` (default 500) → 429 `home_busy`; warning alert at 80% (D85) |
| `/v1/vault/consents*` | the vault endpoints' limits | 10/min per share | — |
| login relay | unchanged | — | — |

## Cost and latency (who pays)

| Event | Chain | Gas | Cost | Paid by | Latency |
|---|---|---|---|---|---|
| Home sign-in (identity) | none | 0 | Google + D1 reads | Hana | Google + ~1 s |
| Directory, devices, revoke | none (cached registry views) | 0 | D1 reads and writes | Hana | one API call |
| Open a wallet (F3) | 1 `create_session_and_derive` | ~38–40 Tgas, 100 Tgas prepaid | ~0.004 NEAR ≈ $0.02 | Hana (Home pool), not billed to the partner | chain ~7.4–7.9 s median (context.md), ~9.5–12 s without Google |
| Export within 5 min of F3 | none | 0 | 0 | — | — |
| Consent register | none (`'none'` mode: one `get_session` view) | 0 | one D1 write | Hana | one API call, at Allow |
| Consent status | none | 0 | one D1 read per 10 s freshness check (already a `GET /v1/app`) | Hana | added to the existing read |

Budget: worst case `HOME_DERIVES_PER_DAY × $0.02` = $10/day at the default. A function-call key's allowance is charged
the prepaid gas (100 Tgas ≈ 0.01 NEAR per call; refunds go to the account, not the allowance; to verify on testnet),
so 2 NEAR covers ≈ 200 Home derives before a top-up. Batch C's ledger counts Home derives as Hana's own (no app, not
on any statement), like D91's unbilled gas (Q12).

## Tests

**Core:** `homeNonce` and `homeMessage` vectors against an independent Node implementation; prefixes differ from every
other layout (`hana-id/session/v1`, `hana-id-session-v1:`, `hana-id-vault-v1:`); consent payload vectors.

**API (vitest, miniflare):**
- Home identity: accepts a valid shared-client token with the Home nonce, key, signature and fresh counter; refuses a
  scope client's token (own or Hana-held), a retired or pending shared client, a session-nonce token, a wrong key,
  bad signature, reused counter, expired `expiresAtMs`, `expiresAtMs` > now + 20 min, a PII claim, a wrong `Origin`.
- `/v1/home/apps`: coverage for each row of the coverage table (shared-only, shared + own, Hana-held, partner-held,
  none); suspended and deleted apps listed with their status; apps without logins and test apps (outside dev envs)
  left out; `liveDevices` from shares only for this `sub`.
- `/v1/home/login`: works for a suspended app's scope and with no publishable key; refuses `sub` ≠ identity `sub`,
  `scope_mismatch`, `shared_login_disabled`, `unregistered_client`, a wrong nonce; per-path, per-user, per-IP and
  global limits, each before the relay; relays only through the Home pool; nothing relayed when any check fails.
- Consents: register in both modes (share live, `get_session` live, policy in force, end ≤ session end); 409 on a
  repeated id; a second registration revokes the first; device revoke; `GET /v1/app` `consent` is `'revoked'` after a
  Home revoke, after its share's revoke or expiry, `'unknown'` for an unknown id and absent without the header or from
  a non-vault origin; the cron prunes.
- `/v1/home/devices` and revoke return and touch only rows whose `path_hash` matches the identity's `sub`; another
  user's `consentId` gives 404 with no change.
- Logs never contain `x-hana-home`, tokens, `sub` or path hashes.

**Web unit:** Home page state machine (sign in, directory, open wallet, export with typed confirmation and hold, PRK
zeroed at 5 min and on leave); `/login?mode=home` opener checks; the vault registers before storing a consent and
grants nothing when registration fails; auto-sign needs a fresh `'active'`; `'revoked'`/`'unknown'` clears the local
consent; revoke paths call the endpoint after clearing locally.

**Playwright (Chromium, WebKit, Firefox):** a user grants a consent on partner A in one context, opens Home in
another, sees it, revokes it, and A's next matching request shows the popup within 10 s; Home opens and exports a
wallet whose addresses equal the vault's for the same account, for a shared-only scope and for a suspended app; an
own-client-only test scope shows "best effort" or "not covered" as configured.

**Testnet (sandbox-dev):** one Home derive per coverage kind; addresses equal the vault's; gas and latency recorded in
`docs/context.md`.

## Build order

Sizes: S ≤ 1 day, M 2–3 days, L 4–5 days.

| # | Step | Size |
|---|---|---|
| 0 | User: answer the open questions; create the Home relayer key (user deploy step) | — |
| 1 | Core layouts and vectors | S |
| 2 | API: Home identity, `/v1/home/config`, `/v1/home/apps` (coverage, `hana_held_clients`, admin command) | M |
| 3 | API: `/v1/home/login`, limits, Home pool, `home_usage`, `deploy-contract` checks | M |
| 4 | Migration, `/v1/vault/consents*`, `GET /v1/app` consent status, cron | M |
| 5 | Vault: register before use, fail-closed status, revoke paths (ships before the Home UI: it changes partner tabs) | M |
| 6 | Home page, `/login?mode=home`, export reuse, page Worker route and CSP | L |
| 7 | `/v1/home/devices`, consent revoke, devices UI | M |
| 8 | Playwright, testnet run, reference docs (`architecture`, `security`, `api`, `integration`, `operations`) | M |

Total about 3–4 weeks. Steps 2–3 and 4–5 can run in parallel.

## Out of scope

Balances or transaction history in Home (would send every address to an RPC or indexer); signing from Home; a seed
phrase (D40); `key_index` rotation and `account > 0` (D60, D61: Home shows account 0 at `key_index` 0); email login
(D4); native apps; a standalone recovery tool without Hana's servers (D40, deferred); remote sign-out of devices
(Q9).

## Open questions

1. **Discovery:** launch with the directory only (A, proposed: no new user data), or add a server index of
   `HMAC(sub) → scopes` (B) so Home can show "your apps"? B holds what the chain already shows publicly, but in one
   queryable place at Hana.
2. **Partner-held own clients:** list them as "best effort" (proposed) or leave them out? And confirm the correction of
   D40's wording (Hana's callback can get tokens for any client used with Hana; the limit is who controls the client).
3. **Enterprise clients:** commit in the Enterprise contract that Hana keeps the Hana-held Google project and client
   alive after the partner leaves (for how long: 2 years proposed), and accept the risk that Google suspends a branded
   consent screen whose partner domain lapses?
4. **`disable_shared_login` is immediate:** on a scope with its own client, an owner can turn off Home's route and
   later shut down. Accept (proposed: the immediacy protects the partner from a compromised Hana login path), or a
   contract change delaying it by `change_delay_ms`?
5. **Hana's shared clients:** adopt the operational rule "never remove the last shared Google client before its
   replacement is in force" (proposed)?
6. **One login per app** opening both chains with PRK held ≤ 5 min (proposed), or strictly one export per login as
   in today's export window?
7. **Re-auth to view:** require Google `max_age=0` for showing addresses (proposed: Home then holds PRK), or only for
   export (one more login per export)?
8. **Directory contents:** every app with at least one login, suspended and deleted ones included, no partner opt-out
   (proposed)? Test apps only in dev envs (proposed)?
9. **Remote sign-out:** add "Sign out this device" (share revoke) to Home? To reach open tabs quickly the vault would
   also have to check its share with the 10 s and 60 s reads; otherwise it ends at the next unlock, touch or idle.
10. **Device labels:** store a coarse "Chrome on macOS" label from the vault on the share (new data, deleted with it),
    or show only origin and time (proposed)?
11. **Budget and limits:** `HOME_DERIVES_PER_DAY` 500, per user 10/hour and 20/day, per path 3/hour, one Home
    relayer key with 2 NEAR: confirm.
12. **Billing:** Home derives are Hana's cost and on no partner statement (proposed), or attributed to the app's org
    while it is active?
13. **Fail closed:** auto-approve can't be turned on while the API can't record the consent (proposed), accepting
    lost auto-approve during an API outage?
14. **Identity client:** use the first shared Google client (proposed) or a dedicated "Hana Home" client (one more
    client to protect and verify, and unregistered clients can be squatted by a scope owner)?
15. **Placement:** `/home` on `authOrigin` (as D40 says, proposed), which then shows partner strings (names, labels,
    origins) on the same origin as the login callback, text only as on the approval popup; or a third Hana origin?
16. **Privacy notice:** Home's notice (what Hana stores: nothing new under option A; shares and consents ≤ 24 h) needs
    legal review before mainnet, with D41's non-custodial claim.
