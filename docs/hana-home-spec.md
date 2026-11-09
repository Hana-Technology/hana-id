# Hana Home spec: cross-app wallets, key export and consent revocation (pre-mainnet)

**Status: approved design, not built (body rewritten 2026-11-09 in batch H0 to agree with D98, D460–D466 and `develop`
@ 6304d21; amended 2026-11-09 for the exit client, D468 and D480–D489, `docs/hana-home-h6-design.md`).** Implements `docs/decisions.md` D40 (Hana Home before mainnet, amended by D463) and D45 (list and revoke
auto-approve consents per device from any device), under D41 (export stays available, not featured) and D42 (Google
client tiers). `docs/hana-home-build-plan.md` splits it into batches H0–H12 and holds the open items.

This file is the source of truth for the build. If code and this spec disagree, fix the code or raise the problem.
Reference docs (`architecture.md`, `security.md`, `api.md`, `integration.md`, `operations.md`, `contract-interface.md`)
are updated in the same branch as the code, not now.

## Confirmed by the user (2026-10-29, D98; amended 2026-11-09)

1. Discovery: the directory, listing every app with at least one login. **Amended (D462, D466):** the list comes from
   `scopes.first_session_at`, and the wallet directory is a "your apps" overlay. D98's "no new user index" predates D310.
2. Partner-held own clients: listed as "best effort"; D40's wording is corrected as this spec says.
3. **Enterprise (user):** Hana keeps a Hana-held branded Google project and client alive for **at least 2 years** after
   the partner leaves, and Hana can enable shared login on the partner's scope at exit, so Home stays reachable through
   Hana's own client even if the branded one is suspended. **Amended (D481):** Hana holds no owner rights over partner
   scopes: D464's seat is dropped, because the exit client (D468) gives the same exit without it. Legal reviews the 2-year
   wording (D489).
4. Turning off shared login is **delayed by `change_delay_ms`** (a contract change), so a partner can't cut Home's route
   and shut down at once (D41's exit guarantee). **Reversed (D480):** D460's delay and its remaining Google
   client are dropped. Turning off shared login stays immediate; the exit client (D468) covers users.
5. Never remove the last shared Google client before its replacement is in force.
6. One login per app opens both chains' export, PRK held ≤ 5 min.
7. No forced re-auth just to view addresses; export keeps today's fresh-login rule.
8. **Directory (user):** every app with at least one login, suspended and deleted included; **no opt-out from access**.
   Enterprise partners may choose a **quieter listing** (shown after the user searches for the app or opens the
   partner's link), never removal. Test apps only in dev envs.
9. "Sign out this device" (share revoke) is added. **Extended (D465):** it stops auto-signing within about 10 s.
10. A coarse device label ("Chrome on macOS") is stored on the share and deleted with it.
11. Budget and limits: 500 Home derives a day; per user 10/hour, 20/day; per path 3/hour; one Home relayer key with
    5 NEAR (D542; 2 NEAR as first confirmed). Identities with no directory row share 20% of the day's ceiling (D540).
12. **Billing (user):** while an app is active, its Home derives appear on its org's statement as their own line ("Hana
    Home logins"); after the partner leaves, Hana pays (D461).
13. Fail closed: auto-approve can't be turned on while the API can't record the consent.
14. Identity client: the first shared Google client, not a dedicated client, because an unregistered dedicated client
    could be registered by a scope owner as its own. **Extended (D463):** an email user's identity comes from the
    email issuer. **Amended (D484):** Home signs in through a dedicated exit client, which the contract keeps off every scope.
15. `/home` on `authOrigin`.
16. Legal review of Home's privacy notice before mainnet.

## Goal

A user opens `{authOrigin}/home`, signs in with Google or an email code, and from one Hana page:

- sees the partner apps whose wallets Hana can still open for them, with their own apps first and, for each, their
  addresses (Stellar `G…`, EVM `0x…`, account 0, `key_index` 0);
- exports a chain's private key with the same safeguards as today's export window, so a partner app shutting down
  doesn't strand them;
- sees every device signed in to each app and its active auto-approve consent, stops a consent, signs a device out, and
  stops sharing their email with an app, from any device.

Done when every behaviour under [Tests](#tests) has a passing test and H12's sandbox-dev run is recorded in
`docs/context.md`.

## Address impact (read first)

None. Home derives through the existing `create_session_and_derive`, the pinned signer and CKD key, and derivation v1.
The path is the identity's **chain-resolved root**: `scope#provider#sub#0` for an unlinked identity or a root, and the
root's path for a member (`sessionStanding`, `get_identity`). H6 changes the registry only. Nothing here changes a path,
a label, a tuple or a key rule. A dedicated Home scope or a nonzero `key_index` would change addresses; neither is
proposed.

## Current state (verified against the code, `develop` at 6304d21)

| Fact | Where |
|---|---|
| Export runs only in a top-level `{authOrigin}/export` window the vault's launcher opens; it signs in again (`/login?mode=export`, Google `max_age=0` or an email code, `max_uses = 1`, 15 min session), aborts if the address differs from the vault's, and shows the key behind a typed `EXPORT`, on Show key / Hide key and Copy key (D268), hidden 60 s after Show, behind the approval guard, with D430's warnings | `packages/web/src/auth/export-page.ts`, `auth/approve-guard.ts` |
| A successful export login records `key_exported` (D430) | `apps/api/src/login.ts`, `mainnet-demo.ts`; `user_events.app_id` is NOT NULL (0013) |
| `/v1/login` needs an **active** app; from `authOrigin` an allowed `x-hana-parent-origin`; exports are limited to 3 per hour per `(app, sha256(path))` | `apps/api/src/handlers.ts` `appGate`, `origins.ts`, `login.ts` |
| So a suspended or deleted app, or one with no allowed origin left, can't export today | same |
| The email issuer needs an active app with email on | `apps/email-issuer/src/handlers.ts` `emailApp` |
| A linked member's session opens its root's path | `apps/api/src/session-standing.ts` |
| `disable_shared_login` is immediate and refuses only a scope with no clients; `email:{scope}` counts as a client. `execute_change` already handles `SetAllowShared {allow:false}`; `propose_change` refuses it | `contracts/hana-signer/src/registry.rs` |
| `remove_client` refuses only the last client of a scope without shared login | same |
| `get_scope` returns pending changes with `unlock_at_ms` | same |
| Auto-approve consents live **only** on the device | `packages/web/src/vault/record.ts`, `vault.ts` |
| `vault_shares (app_id, path_hash, partner_origin, created_at, idle_until, abs_expires_at, revoked_at)`; the hourly job deletes a row 24 h after creation once it's expired or revoked: tombstones (D178) | `apps/api/migrations/0003_vault.sql`, `vault/cron.ts` |
| An open vault auto-signs only under a policy `GET /v1/app` confirmed < 10 s ago (D62) | `vault.ts` `POLICY_FRESH_MS` |
| A revoked share ends an open tab only at its next unlock, touch or idle (D55): until H5 it can still auto-sign | `vault.ts` |
| The wallet directory: `end_users` (`support_code`, `token_sub`), `end_user_identities` (indexed on `sub`; `role`, `status`), `end_user_wallets`; purged 30 days after a scope's apps are all deleted | migration 0011; `changes/retention.ts` `purgeDirectory` |
| `scopes.first_session_at` is set at the scope's first relay; `session_markers` is written only while that is null, so later apps in a scope never get a marker | `apps/api/src/apps.ts` |
| Email sharing: `email_consents` per app × `u1_…` × address MAC; revoke needs the session's proof | migration 0014; `apps/api/src/identity/email.ts` |
| Crons: 5 of 5 used | `apps/admin/scripts/test/gen-wrangler.test.ts` |

## Coverage: which apps Home can open

Home can open a scope's wallets only if it can get a token `hana-signer` accepts for that scope, with a nonce Home
chose. The limit is **who controls whether the client and its redirect URI keep existing**. Google and email are
separate routes; a scope can have both.

| Scope on chain | Tier (D42) | Home | Why |
|---|---|---|---|
| Any registered scope, once H6 ships | any | **Covered through the exit client** | Home's exit client (D468) is accepted for every scope whatever its `clients` and `allow_shared`; `aud` never enters the path, so addresses are the same. The email exit reaches scopes that dropped their email client (D485) |
| `allow_shared`, no own client | Standard (default; Sodax pilot) | **Covered** | Hana's shared client, scope from the nonce. The owner can turn shared login off at once (D480); the exit client then covers it |
| `allow_shared` and only the email client | Standard with email | **Covered** | As above. Until H6 ships, the owner can turn shared login off at once and leave no route for unlinked Google users |
| `allow_shared` and own Google client | Standard moving to Enterprise, or a partner keeping both | **Covered while `allow_shared`** | Home uses the shared client: the path has no client id, so addresses are the same (D12, D42). A turn-off is immediate (D480); the exit client then covers it, or, before H6 ships, the next rows apply |
| Own client held by Hana, no `allow_shared` | Enterprise (D42) | **Covered while Hana keeps the project and the client stays in the scope; the exit client covers it either way** | Hana controls the project. Hana holds no owner seat (D481); the exit client (D468) reaches the scope if the client is removed |
| Own client held by the partner, no `allow_shared` | Partner-held (D42, discouraged) | **Best effort** | Works only while the partner's client exists and lists `{authOrigin}/login/callback`. Nobody can mint a token with that `aud` once it's deleted, and its wallets are unreachable for good, unless the exit client covers them (D468). Hana can't prevent the deletion |
| The email client `("email", "email:{scope}")` | any tier with email | **Covered for email identities** | Hana runs the issuer. Gated on the client's registration on chain, not on an active app (D434, D463) |
| No usable client | — | Not covered, before H6 ships | Nothing can open a session |

Correction to D40's wording ("only their origins can get tokens for that client"): Hana's callback can get them while
the client exists. The real limit is control of the client.

Things that stop coverage of a covered scope:

| Event | Who | Effect | Mitigation |
|---|---|---|---|
| `disable_shared_login` | any scope owner, immediate | shared route gone; falls to the own-client row | the exit client (D468, D480) |
| `remove_client` on the last Google client, once shared login is off | any scope owner, immediate (today's rule, D480) | that route gone for unlinked Google users | the exit client (D468) |
| `set_shared_clients` removing the last shared Google client | Hana's owner, immediate | every shared-only scope uncovered | operational rule: rotate by adding first (D98 item 5) |
| Hana stops paying for or deletes an Enterprise project | Hana | that scope unreachable | contract term (D98 item 3) |
| The council removes an exit client | council, immediate; retired forever (D483) | exit route gone until a replacement has waited the upgrade delay (D482) | by design: it's the stop for a compromised Home |
| Governance pause (D86) | owner multisig / watchdog | every derive, Home's included | by design |

App status in D1 (suspended, soft-deleted) does **not** stop Home: Home is keyed by scope, not by app.

## Identity without a user database

Home needs to know who the user is (for the device list, revocation and per-user limits) without a chain transaction
and without storing an account. It uses a **Home identity**: a token whose nonce commits to a key held only in the Home
page.

1. On "Sign in", Home makes a non-extractable Ed25519 key `hk`, a 32-byte `salt`, and `expiresAtMs = now + 15 min`
   (server-corrected clock from `GET /v1/home/config`).
2. `homeNonce = b64url(sha256(utf8("hana-id/home/v1") ‖ borsh(signer) ‖ hk_pub(32) ‖ u64le(expiresAtMs) ‖ salt))`.
   The prefix differs from `hana-id/session/v1`, so a Home token can never open a session on chain, and a session token
   (public forever in the transaction args) can never be a Home identity.
3. **Google:** Home opens a child `/login?mode=home` as the export window opens `/login?mode=export` (the child accepts
   `hana:auth-params` only from its same-origin opener at `/home`); the first shared Google client in force,
   `scope=openid`, `prompt=select_account`, no `max_age`.
   **Email (D463, H10):** `/login/email` in Home mode; the issuer's Home route signs a token with an `aud` that is on no
   scope and the `homeNonce`. Mailbox limits apply as at any login. H1's review (2026-11-09, D474): the contract checks only
   a client proof's provider, `aud` and nonce, so a route that signs a caller-supplied nonce would let an owner register
   this `aud` with `client_proof_nonce` for their own mailbox; the issuer or the contract must refuse it (H6 or H10).
4. Every Home API call carries header `x-hana-home: b64url(json {jwt, key: hk_pub, expiresAtMs, salt, counter, sig})`
   with `sig = Ed25519(hk, utf8("hana-id-home-v1:") ‖ borsh(signer) ‖ u64le(counter) ‖ sha256(borsh(method) ‖ borsh(path)
   ‖ body))`. The API checks, in order: `Origin === AUTH_ORIGIN`; the token (signature, `iss`, `exp` with 60 s skew,
   claim allow-list); `aud` is a shared Google client **in force** or the issuer's Home audience, never a scope client (a
   partner-held client could mint a Home token for its users and read or revoke their consents in every app, since `sub`
   is global); nonce = `homeNonce`; `now < expiresAtMs ≤ now + 20 min`; the signature; `(sha256(hk_pub), counter)` unused,
   then marked single-use until `expiresAtMs` (the `RateLimiter` DO's `mark:` store). The result is `{provider, sub}`.
5. No cookie (D70), no storage: a reload or 15 min means signing in again.

**Expiry** (D424's rules for Home): detect the end from `expiresAtMs` and from a 401; warn before it; lose nothing on
screen; never retry a request on its own; keep the identity in memory only.

A per-app derive also checks that its token's identity equals the Home identity (`home_account_mismatch`); Home sends
`login_hint` so Google preselects the same account.

## Support ID (D96, D395)

Home shows the user's **Support ID** for the app in view, read from `end_users.support_code` through the overlay, and a
button that copies it. There's no row for a user the directory doesn't know, or after a purge: Home then shows none,
because a code staff can't find is worse than none (D395). It reveals no email or Google account. Hana never contacts
end users; partners escalate with the Support ID and request IDs.

## Discovery: finding a user's apps

Home makes two reads, both without a chain call:

1. **The list (D462).** Every scope with `scopes.first_session_at` set, grouped by scope with its apps in D1, suspended
   and deleted included, searchable. Test apps only in dev envs. A scope with a quieter listing (D98 item 8) appears
   only after a search for its app or through the partner's link. This survives a purge. Strangers see only apps with
   `apps.first_login_at` set (D462); a scope's own users see all of its apps. It can over-list a scope whose first login
   failed, which is harmless.
2. **The overlay (D466).** `end_user_identities` by `(provider, sub)` gives the user's scopes, `user_id` and root. These
   scopes come first as "Your apps", with addresses from `end_user_wallets` and the Support ID. A member's root comes
   from the same rows.

`purgeDirectory` empties the overlay 30 days after a scope's apps are all deleted, which is exactly the shutdown case,
so the list can't depend on it: the user then finds the app by search, and a derive shows the addresses.

Rejected sources: `usage.sessions` (batch C dropped it); `session_markers` (only a scope's first app ever gets one); the
wallet directory alone (purged); a new server index, the batch C ledger, a chain scan and an encrypted per-user list
(D98's analysis; more new data or cost, no gain over the above).

What it reveals: the chain already holds a public `sub → scopes` index, since every login puts the token in
`create_session_and_derive`'s arguments. `sub` ↔ email and `sub` ↔ address are not public; the directory holds them
already (D310), and Home shows a user only their own rows. The privacy notice says so (readiness 9.2, 9.10).

Per-scope derivation: one session per scope, a fresh session key, so one token opens one scope only.

## Wallets and export (per app)

**Viewing needs no chain transaction and no re-auth** (D98 item 7): the addresses come from the overlay.

When the overlay has no address (a purged scope; a login whose background record failed, D317), Home can't show one
without a derive, so the user goes through the export sign-in below to see it. D98 item 7 can't hold in that case.

**Export.** From an app's page:

1. Home checks the scope on chain from its own RPC: `get_scope(scopeId)` exists; for the shared route `allow_shared` and
   the client in `get_config().shared_clients`; for an own client `scope_for_client(provider, clientId) === scopeId`. It
   resolves the root with `get_identity` on `rpc` and `rpcFallback` separately (D263).
2. As the export window does: its own session key (`max_uses = 1`), salt, `expiresAtMs = now + 15 min`, nonce, relay keys;
   the child `/login?mode=home` with Google `max_age=0` and `login_hint`, or a fresh email code (D258); relay read;
   token check; `POST /v1/home/login`; `S = decryptCkd(…, ckdAppId(SIGNER, path), pinned key)` with the pairing check;
   `PRK = extractPrk(S)`.
3. The collapsed "Move this wallet to another wallet app" section (D41): pick a chain, read the warnings (D430), type
   `EXPORT`, then Show key or Copy key (D268). The guard, the 60 s auto-hide and the blur, hidden-tab and pagehide rules
   are the export window's, from code shared with it.
4. PRK stays in memory for at most 5 min after step 2, or until the user leaves the app page or closes Home, and a chain
   key is derived only on its export and zeroed after. **Deviation from the export window:** one login opens both chains
   (D98 item 6). So `key_exported` is recorded at the derive with `chain` null.
5. No message in any direction carries key material. Home sets `window.opener = null` at load and acts only on clicks
   in its own page.

The vault-address check of today's export window has no counterpart: there is no vault. Where the overlay has an address,
Home compares it with the derived one and warns on a difference.

## Consents and devices (D45)

### Server-side state (new)

D1 table `vault_consents`:

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

`vault_shares` gains `device_label TEXT` (D98 item 10): a coarse "Chrome on macOS" sent by the vault, deleted with the
share.

A consent is **active** when `revoked_at IS NULL`, `now < expires_at`, and its share (if any) is live. At most one active
consent per `session_pk`: registering a new one revokes the previous (`revoked_by = 'device'`). `vaultMaintenance`, under
`isHourlyRun`, deletes consents past `expires_at` or revoked more than 1 h ago; no new cron (D417). Shares keep their 24 h
tombstones (D178).

### Vault messages (new payloads, existing layout)

`vaultMessage(shareId, counter, payload)` as in batch B; in `'none'` mode `shareId` = 16 zero bytes and `counter = 0`.

| Action | Endpoint | `payload` |
|---|---|---|
| register | `POST /v1/vault/consents` `{shareId?, sessionPublicKey, counter, signature, consentId, policyId, expiresAtMs}` | `utf8("consent") ‖ consentId(16) ‖ policyId(32) ‖ u64le(expiresAtMs) ‖ borsh(parentOrigin)` |
| revoke (device) | `POST /v1/vault/consents/revoke` `{shareId?, sessionPublicKey, counter, signature, consentId}` | `utf8("consent-revoke") ‖ consentId(16)` |

Register checks: the vault gate; the signature; `'session'` mode: the share exists for this app and session key and is
live; `'none'` mode: `get_session` live in the app's scope; `policyId` equals the app's policy in force; `expiresAtMs ≤` the
session's expiry. 409 `consent_exists` on a repeated `consentId`.

### Vault behaviour (changed)

1. **Register before use, fail closed.** After Allow, the vault registers the consent before storing it locally. If that
   fails, nothing is stored and the caller gets `{granted: false}` with `api_unavailable`.
2. **Status with the policy check (D465).** The existing 10 s freshness read (`GET /v1/app`, D62) sends `x-hana-consent:
   b64url(consentId)` (accepted only from `Origin === VAULT_ORIGIN`) and gets `consent: 'active' | 'revoked' | 'unknown'`
   (one D1 point read, uncached). A revoked or dead share reads `'revoked'`, since a consent is active only while its share
   is live. The vault auto-signs only when both the sealed local consent and an `'active'` read younger than 10 s agree;
   `'revoked'` or `'unknown'` clears the local consent and sends the request to the popup. **No new polling.**
3. `hana_revokeAutoApprove`, "Stop auto-approving", logout and a new login clear locally first, then send the revoke
   (best effort).

Revocation or "Sign out this device" therefore stops auto-signing in an open tab within about 10 s, and in a dormant or
closed tab at its next use. Sign-out doesn't end the rest of the tab at once: a request that needs the user's approval
still reaches the popup until the tab's next unlock, touch or idle (D55). Counters stay on the device only.

### Home: list and revoke

- `GET /v1/home/devices` (Home identity): for the scopes in the overlay, at most 50 a request with a cursor, and for one
  explicit `scopeId` (an app opened outside the overlay), the API takes each scope's root path, computes `sha256(path)`
  and reads live shares and active consents by `path_hash`. It returns per app: devices `{shareId, partnerOrigin, label,
  signedInAt, idleUntilMs, expiresAtMs, consent | null}`, consents without a share (`'none'` mode), and email sharing. It
  never loops over every scope: sandbox-dev's Free plan allows 10 ms CPU and 50 subrequests (D417). Coverage isn't needed:
  revoking needs only the user's identity.
- `POST /v1/home/consents/revoke {consentId}`: loads the row, recomputes the user's root-path hash for that scope, requires
  it equals `path_hash` (else 404 `unknown_consent`, revealing nothing), sets `revoked_at`, `revoked_by = 'home'`.
- `POST /v1/home/shares/revoke {shareId}` ("Sign out this device", D98 item 9): the same check, sets the share's
  `revoked_at`, and its consent ends with it.
- `POST /v1/home/email-sharing/revoke {appId}` (D411 point 6): Home has no session to prove, so the route takes the Home
  identity; it resolves `token_sub` through the overlay and does what the session-proof route does. New identity tokens and
  the partner's console lose the address at once; tokens already issued keep it ≤ 1 h. It replaces the partner requirement
  added to D442, which H9 deletes from `docs/integration.md`.
- A "device" is a share: one browser profile on one top-level site for one app session.

A user with no directory row in a scope (a member Hana never saw, or a purged one) has no root to hash from the overlay.
Home falls back to the identity's own path, which finds an unlinked user's shares and no one else's.

### Security properties

- **Narrow-only.** A server row can stop auto-signing, never start it: the vault still needs the sealed consent the user's
  guarded Allow created (`consentDigest`).
- **Who can revoke:** the device (its session key), or whoever holds a Home identity for the user. Partners can't: they
  never receive shared-client tokens, own-client tokens are refused as Home identities, and an email Home token needs the
  mailbox.
- **Compromised API or D1:** can hide consents, report `'active'` for a revoked one (as it can serve a removed policy, D62)
  or `'revoked'` (denial of service). It can't create a consent or sign.
- **Privacy:** consent rows live at most a session plus 1 h; shares, including the device label, are deleted by the first
  hourly run once they've ended and are 24 h old (D178). The status read is keyed by a 128-bit `consentId` known only to the
  vault and the API.

## Lock-in stance (D41)

- The front page is "Your apps" and "Devices and auto-approve". Export is inside each app's page, collapsed, labelled "Move
  this wallet to another wallet app"; never on the front page, never removed, never behind support, never switchable off by
  partners (D431), with no friction beyond the security checks.
- Links to Home come from Hana's own surfaces (the consent screen, the approval popup's "Stop auto-approving" area: "Manage
  in Hana Home"), never from partner-controlled UI only.
- Partners can't hide their app from Home or turn Home off for their users. An Enterprise partner's quieter listing changes
  how it's found, not whether.

## UX flows

| # | Flow | Steps | Chain | Time |
|---|---|---|---|---|
| F1 | Sign in | `/home` → Google or an email code → front page | none | Google or mail + ~1 s |
| F2 | Your apps | your apps first, then the searchable list: name, logo, origins, status, coverage badge, "signed in on N devices" | none | D1 + cached views |
| F3 | See addresses | an app's page shows them from the overlay, with copy and explorer links, and the Support ID | none | one API call |
| F4 | Export | expand "Move this wallet…" → fresh Google login or email code → chain → warnings → type `EXPORT` → Show key or Copy key | 1 tx, then none within 5 min | ~8–12 s + Google or mail |
| F5 | Devices and auto-approve | per app: origin, label, signed in, ends; its consent → "Stop auto-approving"; "Sign out this device"; "Stop sharing email" | none | one API call |
| F6 | Not covered | the page says why (shared login off, partner-held client gone), with "use the app itself" where it still runs | none | — |
| F7 | Wrong account | a per-app sign-in with another account → "Sign in as the same account you used in Home" | none | — |
| F8 | Identity ending | a warning before the 15 min end; a request after it → "Sign in again", nothing on screen lost, nothing retried | none | — |

Errors map to the existing auth-page error views (`errors.ts`), plus `home_account_mismatch`, `not_covered`, `home_busy`,
`rate_limited`.

## API changes (`apps/api`)

| Endpoint | Auth | Does |
|---|---|---|
| `GET /v1/home/config` | `Origin === AUTH_ORIGIN` | `{serverTimeMs, signer, sharedGoogleClientId}` |
| `GET /v1/home/apps` | Home identity | the list and overlay: `[{scopeId, mine, coverage: 'shared' \| 'hana_client' \| 'partner_client' \| 'email' \| 'none', googleClientId, sharedLoginEndsAtMs, supportId?, addresses?, apps: [{appId, name, status: 'active' \| 'suspended' \| 'deleted', environment, origins}], liveDevices}]`; coverage and `sharedLoginEndsAtMs` from cached `get_scope` / `get_config` views (≤ 60 s) and D1 `hana_held_clients`. **As built (H2, D500–D503, `docs/api.md`):** coverage adds `exit` and `unknown`; no `sharedLoginEndsAtMs` (D480) or `liveDevices` (H9); paged and bounded |
| `POST /v1/home/login` | Home identity | `/v1/login`'s body plus `scopeId`. In order: IP limit; shape; token (`verifyLoginToken` without `appId`; nonce = `sessionNonce(SIGNER, scopeId, …)`); the identity matches; `sessionStanding` for the root path; the Home limits; counter hold; `checkClientScope` and `session_key_in_use`; session signature; BLS shape; relay `create_session_and_derive` through the **Home pool**; `key_exported`; failures as `loginFailure`. No app gate. **As built (H3, D521–D529, D540, `docs/api.md`):** identities with no directory row share 20% of the daily ceiling (D540); a derive writes a directory row only for a confirmed member or an identity already `active` there (D527); the per-wallet, per-user and daily limits come last, after every check; a standing the chain didn't confirm is refused; `keyIndex` 0, `maxUses` 1, at most 20 minutes, no link fields |
| `GET /v1/home/devices` | Home identity | see [Home: list and revoke](#home-list-and-revoke) |
| `POST /v1/home/consents/revoke`, `/v1/home/shares/revoke`, `/v1/home/email-sharing/revoke` | Home identity | same |
| `POST /v1/vault/consents`, `/v1/vault/consents/revoke` | vault gate + vault message | see [Vault messages](#vault-messages-new-payloads-existing-layout) |
| `GET /v1/app` | unchanged | gains `consent` when `x-hana-consent` is sent from `VAULT_ORIGIN` |

Also: `HANA_CALLERS`/CORS for the new paths (`authOrigin` only; `x-hana-home` and `x-hana-consent` allowed); D1
`hana_held_clients (provider, aud, scope_id, added_at)` written by a new `admin home:client:add` at Enterprise onboarding; a
per-scope listing flag set by staff; `home_usage (day, derives)`; request logs never carry `x-hana-home`, `sub` or path
hashes.

**Home relayer pool** (D19 pattern): `HOME_RELAYER_KEYS`, default 1 key, method `create_session_and_derive` only, receiver =
signer, its own allowance; `deploy-contract` checks it like the session pool. A Home flood can't drain partner logins.

**Email issuer (H10):** a Home route that needs no publishable key and no `IssuerRpc` read: it gates on the chain's
`("email", "email:{scope}")` client, and mints either the Home identity or a per-scope token. Once H6 ships, the exit
token (audience `hana-home`, on the exit list) reaches a registered scope that dropped its email client (D485). The route
computes the nonce from typed inputs and never accepts one.

## Contract changes (H6, D468, D480–D488)

- `set_exit_clients` keeps a council-set list of exit clients (Home's Google client and `("email", "hana-home")`). A new one
  waits `governance_delay_ms` (D482); a removal is immediate and retired forever (D483). A partner has no method that touches it.
- `exit_scope()`, called only from `open_session`, accepts them for every registered scope whatever its `clients` and
  `allow_shared`; `session_scope` is unchanged, so link and owner methods never accept an exit client.
- Client sets stay disjoint; a self-issued provider's client must be exactly `email:{scope_id}`.
- Exit sessions: at most 30 minutes and 3 uses, `link_jwt` refused (D486). One event per session and an hourly alert-only
  counter in `get_config` (D487). No waiting period before the key is released (D488).
- `disable_shared_login` and `remove_client` keep today's behaviour (D480). Hana holds no owner seat (D481).
- **`migrate` is needed (state version 4). No address impact.** Upgrade through the timelocked path, then the council sets the
  list. The design and the order are in `docs/hana-home-h6-design.md`.

Home relies otherwise on shared clients and `allow_shared` (A.2), `create_session_and_derive` (B), the registry views, and
the governance pause (D86).

## Pages and packages

- `/home` joins `AUTH_PAGE_PATHS` and `AUTH_LOGO_PATHS` (`apps/api/src/pages/host.ts`) and the auth page build, in Hana's
  brand (`packages/brand`, D426). Its policy adds `frame-ancestors 'none'; connect-src {apiUrl} {rpc} {rpcFallback}
  https://www.googleapis.com` and, with H10, the issuer. The shared client adds no Google redirect URI: Home uses `/login/callback`. The exit client's only redirect is Home's page (D484).
- `/login?mode=home`: accepted only with `event.origin === authOrigin`, `event.source === window.opener` and
  `opener.location.pathname === '/home'`; Google with `max_age=0` for per-app derives, without it for the identity.
- `@hana-id/core`: `homeNonce`, `homeMessage` and the two consent payloads, with vectors.
- `@hana-id/web`: `auth/home-page.ts` (reusing `chain-login.ts` and the reveal extracted from `export-page.ts`), entry
  `entries/home.ts`; vault changes in `vault.ts` (register, status, revoke).

## Security model

| Attacker | Can | Cannot |
|---|---|---|
| Anyone who signs in as the user (Google or their mailbox) | everything Home offers | — (inherent; the same holds for today's export) |
| A partner page, or XSS on it | open `/home` in a window | drive Home (no messages accepted, actions need clicks, `frame-ancestors 'none'`), get a Home or shared-client token |
| A partner holding its own client | mint tokens for its own scope (today) | a Home identity, so no listing or revoking elsewhere |
| A scope owner | turn shared login off at once; remove a client (D480) | cut Home's exit route, once H6 ships: it can't touch the exit list (D468) |
| Compromised API logic or D1 (not the pages) | mislabel or hide apps; **show a wrong address in the view-only list**; hide consents, ignore revocations, deny service, learn that a user visited Home | derive for itself or substitute a key (Home fixes the path from its own token and the chain, the relay is end-to-end encrypted, the pairing check uses the pinned key), grant a consent, sign |
| Compromised `authOrigin` Worker or bundles, or Cloudflare account | everything, as today (single trust root) | |
| Someone who sees a Home token (API logs, a proxy) | nothing alone: each call needs `hk`'s signature and a fresh counter; the nonce is never valid on chain | |
| A flood of Home derives | spend up to the Home budget | touch the session or owner pools |

Invariants (each has a test):

- A Home-identity token is never accepted by a session method, and no token whose nonce isn't `homeNonce` for the request's
  key is accepted as a Home identity.
- Only a shared Google client in force, or the issuer's Home audience, yields a Home identity.
- Home never signs a transaction or message; it shows addresses and exports keys to the user only.
- Home uses only the pinned `SIGNER`, `RELAYER` and CKD key, and a path from its own verified token and the chain's root.
- A server consent row can stop auto-signing, never start it; the vault auto-signs only with an `'active'` read younger than
  10 s.
- Every Home derive passes the per-path, per-user and global limits before anything is relayed.
- No message, log line or storage on `authOrigin` holds key material, a token or `sub`.

## Rate limits

| Endpoint | Per IP | Per user / key | Global |
|---|---|---|---|
| `GET /v1/home/config` | 60/min | — | — |
| `GET /v1/home/apps`, `/devices` | 30/min | 60/min per Home key | — |
| The three `POST /v1/home/*/revoke` | 30/min | 30/min per Home key | — |
| `POST /v1/home/login` | 10/hour | 3/hour per `(scope, sha256(path))` (D59's bound), 10/hour and 20/day per user, counted after the token check | `HOME_DERIVES_PER_DAY` (default 500) → 429 `home_busy`; warning alert at 80% (D85) |
| `/v1/vault/consents*` | the vault endpoints' limits | 10/min per share | — |
| The issuer's Home route | the issuer's limits | the mailbox limits and send budget (D198) | — |

## Cost and latency (who pays)

| Event | Chain | Gas | Cost | Paid by | Latency |
|---|---|---|---|---|---|
| Home sign-in | none | 0 | Google, or one email; D1 reads | Hana | Google or mail + ~1 s |
| List, addresses, devices, revoke | none (cached views) | 0 | D1 reads and writes | Hana | one API call |
| Export sign-in (F4) | 1 `create_session_and_derive` | ~38–40 Tgas, 100 Tgas prepaid | ~0.004 NEAR ≈ $0.02 | **The partner's statement line while the app is active; Hana after it's gone (D461)** | chain ~7.4–7.9 s median, ~9.5–12 s without Google |
| Export within 5 min | none | 0 | 0 | — | — |
| Consent register | none (`'none'` mode: one `get_session` view) | 0 | one D1 write | Hana | one API call, at Allow |
| Consent status | none | 0 | added to the existing `GET /v1/app` | Hana | — |

Budget: worst case `HOME_DERIVES_PER_DAY × $0.02` = $10/day at the default. A function-call key's allowance is charged the
prepaid gas (100 Tgas ≈ 0.01 NEAR per call; to verify on testnet), so the 5 NEAR allowance (D542) covers about 500 Home derives before a top-up.
The ledger needs the `app_id` check widened and `org_id` from `scopes.org_id`; after exit, the event goes to Hana's internal
org. Charging partners for users leaving them needs wording in the partner terms (readiness 9.9).

## Tests

**Core:** `homeNonce` and `homeMessage` vectors against an independent Node implementation; prefixes differ from every other
layout; consent payload vectors.

**Contract:** exit on a scope with `allow_shared` false, for Google and email; refused for an unknown scope, a pending or removed
client, a paused contract, a wrong nonce and over the caps; exit tokens refused by the link methods and owner auth; `link_jwt`
refused; disjoint client sets; `("email", "hana-home")` refused as a scope client; paths unchanged through own client, shared
client and exit; v3 to v4 keeps every field. The design's section 6 has the full list.

**API (vitest, miniflare):**
- Home identity: accepts a valid token of each kind with the Home nonce, key, signature and fresh counter; refuses a scope
  client's token, a retired or pending shared client, a session-nonce token, a wrong key, bad signature, reused counter,
  expired `expiresAtMs`, `expiresAtMs` > now + 20 min, a PII claim, a wrong `Origin`.
- `/v1/home/apps`: coverage per row of the coverage table; suspended, deleted and purged scopes; a scope with no
  `first_session_at` left out; test apps; a quieter listing; a member's root; no Support ID when
  there's no row.
- `/v1/home/login`: works for a suspended app's scope and with no publishable key; refuses a different identity,
  `scope_mismatch`, `shared_login_disabled`, `unregistered_client`, a wrong nonce; per-path, per-user, per-IP and global
  limits, each before the relay; relays only through the Home pool; nothing relayed when any check fails; `key_exported` with
  `chain` null.
- Consents: register in both modes; 409 on a repeated id; a second registration revokes the first; device revoke; `GET
  /v1/app` `consent` is `'revoked'` after a Home revoke, after its share's revoke or expiry, `'unknown'` for an unknown id and
  absent without the header or from a non-vault origin; the hourly job prunes.
- `/v1/home/devices` and the three revokes touch only this user's rows; another user's id gives 404 with no change; a member
  finds the rows under its root.
- Billing: an active app's line; Hana's org after exit; report and statement totals.
- Logs never contain `x-hana-home`, tokens, `sub` or path hashes.

**Email issuer:** a Home identity token can't open a session, an exit token opens one for its own user (D485); a suspended app's scope gets a token; a scope without the client doesn't;
mailbox limits apply.

**Web unit:** the Home state machine (sign in, list, addresses, export, Show key and Copy key, PRK zeroed at 5 min and on
leave); the expiry rules; `/login?mode=home` opener checks; text-only rendering; the vault registers before storing a consent
and grants nothing when registration fails; auto-sign needs a fresh `'active'`; `'revoked'`/`'unknown'` clears the local
consent; revoke paths call the endpoint after clearing locally.

**Playwright (Chromium, WebKit, Firefox):** a user grants a consent on partner A in one context, opens Home in another, sees
it, revokes it or signs the device out, and A's next matching request shows the popup within about 10 s; Home opens and exports
a wallet whose addresses equal the vault's, for a shared-only scope, a member and a suspended app; an email-only user does the
same; an own-client-only test scope shows "best effort" or "not covered" as configured.

**Testnet (sandbox-dev):** one Home derive per coverage kind; addresses equal the vault's; gas and latency recorded in
`docs/context.md`.

## Build order

`docs/hana-home-build-plan.md`, batches H0–H12.

## Out of scope

Balances or transaction history in Home (would send every address to an RPC or indexer); signing from Home; a seed phrase
(D40); `key_index` rotation and `account > 0` (D60, D61); native apps; a standalone recovery tool without Hana's servers (D40,
deferred).

## Open items

The 2026-10-29 questions were answered in D98, the readings left over in D460–D466 (D460 and D464 since dropped: D480, D481),
and H6's design in D480–D489. What's still open is in
`docs/hana-home-build-plan.md` "Still open", each with an owner.
