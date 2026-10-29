# API reference — every endpoint the `apps/api` Worker serves today

Last verified against code: 2026-10-28 (commit 58edee9).

Current state, not a spec. Where the specs (`docs/batch-*.md`) and this file differ, this file follows the code.
Contract methods and byte layouts: `docs/contract-interface.md`. How to run it: `docs/operations.md`.

**B** marks what batch B added or changed (the vault, the auth pages, `POST /v1/login`, the login relay, the vault
endpoints and the page Workers).

The API Worker renders `GET /vault` for requests whose URL origin is `VAULT_ORIGIN`: the vault origin's own thin
Worker forwards them unchanged through a service binding. `/vault.js` and the auth pages (`/login`,
`/login/callback`, `/approve`, `/export`) are served by the page Workers ("Page Workers" below), never by
this Worker.

## Routing

`src/index.ts`, in this order. Any other path: `404 not_found`. A method not listed: `405 method_not_allowed` with
`allow`. An uncaught error: `500 internal` (logged with the path, a login relay path without its relayId). The Hana
page origins never reach the API routes: a request whose URL origin is `VAULT_ORIGIN` or `AUTH_ORIGIN` gets
`/vault` (vault origin only) or a 404.

| Path | Methods | Handler | Auth | B |
|---|---|---|---|---|
| `{VAULT_ORIGIN}/vault` | GET, HEAD | `vault/page.ts` | publishable key in `?pk=` | B |
| any other path on `VAULT_ORIGIN` or `AUTH_ORIGIN` | any | `index.ts` | — (`404`, text, `frame-ancestors 'none'`, `nosniff`, no CORS) | B |
| `/v1/health` | GET, HEAD, OPTIONS | `handlers.ts` | none | |
| `/v1/app` | GET, OPTIONS | `handlers.ts` | publishable key + caller rule | changed in B |
| `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` | POST, OPTIONS | `handlers.ts` | publishable key + caller rule (+ session signature for derive/revoke) | caller rule changed in B |
| `/v1/login` | POST, OPTIONS | `login.ts` | publishable key + caller rule + session signature | B |
| `/v1/login-relay/<relayId>` | GET, POST, OPTIONS | `login-relay.ts` | Hana origin only; read key for GET | B |
| `/v1/vault/shares`, `/unlock`, `/touch`, `/revoke`, `/revoke-all` | POST, OPTIONS | `vault/endpoints.ts` | publishable key + vault origin + session signature (vault message) | B |
| `/v1/owner-actions` | POST, OPTIONS | `handlers.ts` | OIDC owner token inside the args | |
| cron `0 * * * *` | — | `issuer-keys.ts`, `vault/cron.ts` | — | vault part B |

There is no secret-key (`sk_…`) auth anywhere: publishable keys are public and origins gate them.

## Conventions

- JSON bodies, camelCase on app endpoints, contract-shaped snake_case on owner actions. Byte arrays are JSON arrays of
  integers 0..255.
- Success: `{…fields, "requestId"}` — relayed calls `{"result": …, "nearTx": "<base58 tx hash>", "requestId"}`.
  Error: `{"error": "<message>", "code": "<code>", "requestId", "nearTx"?, …extra}`.
- `x-request-id` on every non-preflight response; `requestId` is the `cf-ray` header when it matches
  `[A-Za-z0-9-]{1,64}`, else a random UUID.
- `content-type: application/json; charset=utf-8`, `cache-control: no-store`.
- Body caps (streamed, `413` with code `bad_request` past them): app endpoints and owner actions 16 KiB, vault
  endpoints 4 KiB, login relay 8 KiB. Non-JSON: `400 bad_request`. JWT ≤ 7168 characters.
- Usage counters (D1 `usage`, per app per UTC day) count successes only and are written after the response
  (`waitUntil`).

## Callers, origins and CORS (`src/origins.ts`)

"Dev env" = `ENV_NAME` starting with `local` or `sandbox`. "Loopback" = `localhost`, `*.localhost`, `127.0.0.0/8`,
`[::1]`; the app origin entry `http://localhost:*` matches any `http://localhost:<port>`.

`originAllowed(app, origin)`: exact match against `app_origins`; loopback origins (and the wildcard) count only for
`pk_test_` keys in dev envs.

| Caller (`Origin`) | `/v1/app` | `/v1/login` | `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` | Vault endpoints | Login relay |
|---|---|---|---|---|---|
| `VAULT_ORIGIN` | yes | yes | yes | yes | read |
| `AUTH_ORIGIN` | yes | yes | no | no | write, read |
| a partner origin of the app | yes, any key, any env | no | only `pk_test_` in dev envs (`apps/smoke`) | no | no |

- From a Hana origin the request acts for `x-hana-parent-origin`, which must pass `originAllowed` for the app. CORS
  echoes the Hana origin even when the parent is refused, so the page can read the error.
- From a partner origin, CORS echoes the origin only when the call is allowed; a refused partner gets no CORS headers.

| Preflight | Allowed when | `allow-headers` | `allow-methods` |
|---|---|---|---|
| `/v1/app`, `/v1/sessions*`, `/v1/derive`, `/v1/login` | `Origin` is a Hana origin, or any active app lists it (loopback: only a `pk_test_` app in a dev env) | `content-type, x-hana-key, x-hana-parent-origin, x-hana-relay-key` | `GET, POST, OPTIONS` |
| `/v1/vault/*` | `Origin === VAULT_ORIGIN` | `content-type, x-hana-key, x-hana-parent-origin` | `POST, OPTIONS` |
| `/v1/login-relay/*` | a Hana origin | `content-type, x-hana-relay-key` | `GET, POST, OPTIONS` |
| `/v1/health`, `/v1/owner-actions` | always (`*`) | `content-type` | `POST, OPTIONS` |

Allowed preflight: `204`, `access-control-max-age: 600`, `access-control-expose-headers: x-request-id, retry-after`,
`vary: Origin` (except `*`). Refused: `403` with no CORS headers.

## The app gate (`appGate`, `handlers.ts`)

Every app endpoint (`/v1/app`, `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke`, `/v1/login`) runs, in order:

1. `x-hana-key` present (`401 missing_key`) and shaped `pk_(test|live)_<base58 16..64>`, found in D1
   (`401 unknown_app`; D1 failure `503 config_unavailable`).
2. App `active` (`403 app_suspended`); not a `pk_test_` app on a scope a `pk_live_` app also uses
   (`403 scope_conflict`).
3. Caller rule above (`403 origin_not_allowed`).
4. Rate limits (`429 rate_limited` + `retry-after` seconds; limiter failure `503 rate_limiter_unavailable`).

A test app's other limits are the vault's, never the API's: no raw signing and no mainnet chains for `pk_test_` (D39).

## Rate limits

Fixed windows in `RateLimiter` Durable Objects; a hit counts only if every window checked has room. The per-IP subject
is the IPv4 address or the IPv6 /64 (`src/ip.ts`). The day window is the UTC day.

| Endpoint | Per IP | Per app | Other |
|---|---|---|---|
| relay kind: `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke`, `/v1/login` (one shared window) | plan `per_ip_minute` (window `<appId>:minute`) | plan `per_minute` and `per_day` | IP checked first, so its rejects don't spend the app's quota |
| key exports: `/v1/login` from `AUTH_ORIGIN` | — | — | 3 per hour per user path per app (subject `export:<appId>:<hex sha256(path)>`, window `export:hour`), counted once the token and nonce are verified, before anything is relayed (D59) |
| `GET /v1/app` | plan `per_ip_minute` (own window `<appId>:config:minute`) | — | never touches the relay quota |
| vault endpoints | 60/min (`<appId>:vault:minute`) | 10 × plan `per_minute` (`vault:minute`) | share actions: 10/min per share (`share:<hex>`) |
| login relay | writes 10/min, reads 120/min | — | not per app |
| `/v1/owner-actions` | 10/min | — | global 20/min and 200/day, counted only after every off-chain check passes |
| `/v1/health`, `GET /vault` | — | — | — |

Seeded plan `free`: `per_minute` 60, `per_day` 5000, `per_ip_minute` 20.

## Endpoints

### `GET /v1/health`

No auth, no limits, `access-control-allow-origin: *`. → `200 {"ok": true, "env": ENV_NAME, "signer": SIGNER_ACCOUNT, "requestId"}`.

### `GET /v1/app`

Headers: `x-hana-key`; from a Hana page also `x-hana-parent-origin`. Gate kind `config`. No transaction.

→ `200`:

```json
{ "name": "string", "scopeId": "string", "signer": "string",
  "google": { "clientId": "string", "mode": "own" | "shared" },
  "serverTimeMs": 0, "autoApprovePolicy": {} | null, "rawSign": "off" | "approval", "requestId": "string" }
```

`name`, `serverTimeMs`, `autoApprovePolicy` and `rawSign` are new in B. `autoApprovePolicy` is the policy in force now
(read from D1 on every request, validated and normalized as the vault page inlines it), or null; an open vault
re-reads it before auto-signing, so a removal takes effect within 10 s without a reload (D62, `docs/security.md`
"Auto-approve policies"). `rawSign` is the app's raw-signing setting in force now (`'approval'` only once a pending
enable has reached `raw_sign_effective_at`; `'off'` when the settings row is missing); an open vault re-reads it, on
the same 10 s bound, before every raw request and refuses once it says `'off'` (D68). The test-app refusals (raw
signing and mainnet chains for `pk_test_`, D39) are the vault's, not the API's. `google`: `own` with the app's `google_web_client_id` if set (it must still be
a client of the scope), else the scope's first Google client; else `shared` with the first shared client in force
when the scope has `allow_shared`.

| Status | Code | When |
|---|---|---|
| 409 | `scope_not_registered` | `get_scope` is null |
| 409 | `no_google_client` | `google_web_client_id` no longer in the scope, or no own client and no usable shared client |
| 502 | `near_unavailable` | registry read failed |
| 503 | `config_unavailable` | the app's settings row could not be read |

### `POST /v1/sessions` — relays `create_session` (session pool)

Body (extra keys ignored, except `scopeId` / `scope_id`, which are refused):

| Field | Type | Rule |
|---|---|---|
| `jwt` | string | Google ID token, three base64url segments, ≤ 7168 chars |
| `sessionPublicKey` | number[32] | Ed25519 public key |
| `expiresAtMs` | integer | in `(now, now + 24 h + 5 min]` |
| `salt` | number[16..64] | |
| `keyIndex` | integer | `0 ..= 2^31 − 1` |
| `maxUses` | integer | `1 ..= 500` |

The scope is always the app's (D1). Checks after the gate and shape (`400 bad_request`):

1. RS256 against Google's JWKS, `iss` → provider, `exp` + 60 s skew: `401 invalid_token`, `400 unsupported_issuer`,
   `400 token_expired`, `503 issuer_keys_unavailable`.
2. Only with `REJECT_PII_ON_SESSIONS = "1"`: claim allow-list (`iss azp aud sub iat exp nonce nbf jti auth_time`),
   else `400 token_has_pii` with `data: {claim}`.
3. `nonce` equals the session nonce recomputed with `SIGNER_ACCOUNT` and the app's scope (`400 nonce_mismatch`).
4. Side by side: client → scope (`403 scope_mismatch` / `unregistered_client` / `unknown_scope` /
   `shared_login_disabled`) and `session_key_in_use` (`409 session_exists`); read failure `502 near_unavailable`.

→ `200 {"result": {"path", "scope_id", "expires_at_ms", "max_uses", "used"}, "nearTx", "requestId"}`. Usage:
`sessions`.

### `POST /v1/derive` — relays `derive_key` (session pool)

Body `{sessionPublicKey: number[32], counter: integer ≥ 1, signature: number[64], pk1: "bls12381g1:…", pk2:
"bls12381g2:…"}` (each point < 300 chars), else `400 bad_request`.

1. Ed25519 by `sessionPublicKey` over `"hana-id-session-v1:" ‖ u64le(counter) ‖ sha256("hana-id-ckd-v1:{pk1}:{pk2}")`
   (`401 invalid_signature`).
2. A second request for the same session counter in the same isolate waits for the first.
3. Session pre-check (`src/session-use.ts`, mirrors the contract), on `get_session` (cached 10 s; a cached refusal is
   re-judged on a fresh read):

| Status | Code | When |
|---|---|---|
| 404 | `unknown_session` | no session, or expired |
| 403 | `scope_mismatch` | session in another scope |
| 409 | `session_exhausted` | `used = max_uses` |
| 409 | `counter_used` | `counter ≤ used` (replay); body has `nextCounter = used + 1` |
| 409 | `counter_out_of_range` | `counter > max_uses`; body has `nextCounter` |
| 502 | `near_unavailable` | session read failed |

   A counter ahead of `used + 1` is relayed (earlier ones may be in flight).
4. Only with `BLS_PRECHECK = "1"`: pairing check `e(pk1, −g2) · e(g1, pk2) = 1` (`400 invalid_app_key`).

→ `200 {"result": {"big_y": "string", "big_c": "string"}, "nearTx", "requestId"}`. Usage: `derives`.

### `POST /v1/sessions/revoke` — relays `revoke_session` (session pool)

Body `{sessionPublicKey: number[32], counter: integer ≥ 1, signature: number[64]}`; payload `"revoke"`. Same checks as
derive, except no `session_exhausted`, and the last usable counter is `max_uses + 1`. → `200 {"result": null, "nearTx",
"requestId"}`.

### `POST /v1/login` — relays `create_session_and_derive` (session pool) · B

One transaction per login. Called by the vault and the export window (`AUTH_ORIGIN`), never by partner pages.

Body: exactly the `/v1/sessions` fields plus `signature: number[64]` (session signature over counter 1 of the CKD
payload), `pk1`, `pk2`. Any other field: `400 bad_request`.

Checks, in order: gate (relay kind) → shape → token (as `/v1/sessions`) → claim allow-list, **always on**
(`400 token_has_pii` + `data: {claim}`) → nonce → in-isolate hold on (key, counter 1) → scope and
`session_key_in_use` side by side → signature over counter 1 (`401 invalid_signature`) → pk1/pk2 each one compressed,
non-identity point of 48 / 96 bytes (`400 invalid_app_key`) → pairing only with `BLS_PRECHECK = "1"`. From
`AUTH_ORIGIN` (a key export) the export limit comes right after the nonce check: `429 rate_limited` with
`retry-after` once 3 exports of that user path in that app were counted this hour, `503 rate_limiter_unavailable` if
the limiter can't be reached; nothing is relayed in either case.

→ `200`:

```json
{ "result": { "big_y": "string", "big_c": "string" },
  "session": { "scope_id": "string", "expires_at_ms": 0, "max_uses": 0, "used": 1 },
  "nearTx": "string", "timings": { "totalMs": 0, "phases": { "app": 0, "…": 0 } }, "requestId": "string" }
```

`session` is informational; `timings` is there for `pk_test_` apps only (see "Timings" below). Failures, by the
failing receipt's executor:

| Status | Code | Meaning |
|---|---|---|
| 422 | `contract_rejected` (+ `reason: "session_key_in_use"` for that panic) | signer receipt failed; nothing was created |
| 422 | `ckd_failed` + `session: {used: 1}` | MPC receipt failed; the session **is** committed with its one use spent |
| 502 | `near_error` | another receipt, or none identified |

Usage: `sessions` + `derives` on success, `sessions` only on `ckd_failed`.

### `/v1/login-relay/<relayId>` — Durable Object `LoginRelay` · B

Hands the end-to-end encrypted Google token from `/login/callback` to the vault. No `x-hana-key`. `relayId` is 43
base64url characters (`400 bad_relay_id`), `= b64url(sha256(readKey))`. Wrong origin: `403 origin_not_allowed`; other
methods: `405`. Per-IP limits as above (`429 rate_limited`, `503 rate_limiter_unavailable`).

| Request | Origin | Body / headers | Responses |
|---|---|---|---|
| `POST` | `AUTH_ORIGIN` | `{iv, ct}` only, base64url; iv 12 bytes, ct ≥ 16 bytes, body ≤ 8 KiB | `204`; `409 relay_used` if ever written; `503 relay_unavailable` |
| `GET ?wait=<1..25>` (absent = answer at once) | `VAULT_ORIGIN`, `AUTH_ORIGIN` | `x-hana-relay-key: <b64url of 32 bytes>` | `200 {iv, ct, serverTimeMs, heldMs}` (consumed; `heldMs`: how long the value sat in the slot before this read, on the object's clock: a duration, never the write's time); `204` still empty after `wait` s; `410 relay_gone` read or expired; `403 relay_forbidden` missing/wrong key (slot untouched); `400 bad_request` bad `wait`; `503 relay_unavailable` |

The value lives 120 s after the write, then a tombstone answers 410 for 120 s more, then the object is empty. Only
ciphertext is stored; bodies, keys and relay ids are never logged. For a `pk_test_` app the encrypted payload also
carries the login popup's stage durations (`timings` beside `idToken` or `error`, at most 8 numbers, `@hana-id/core`
`relay.ts`); the API can't read them any more than the token.

### `GET {VAULT_ORIGIN}/vault?pk=<publishable key>` · B

Served only when the request URL's origin is `VAULT_ORIGIN` (elsewhere the path falls through to `404`). D1 only, no
RPC. HEAD gives the same status and headers without a body.

`200` HTML with `<script type="application/json" id="hana-config">` holding

```json
{ "v": 1, "appId": "string", "appName": "string", "scopeId": "string", "origins": ["string"],
  "settings": { "persistence": "session" | "none", "sessionTtlMs": 0, "idleTtlMs": 0,
                "rawSign": "off" | "approval", "autoApprovePolicy": {} | null },
  "publishableKey": "string", "serverTimeMs": 0 }
```

(`<`, `>`, `&`, U+2028, U+2029 escaped; no `signer`), then `<script type="module" src="/vault.js">`. Pending
`raw_sign` / auto-approve values apply from their `*_effective_at`. `origins`: the app's origins that are bare
lowercase http(s) origins, loopback ones only for `pk_test_` in dev envs, sorted.

Headers: `content-security-policy: default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors <origins | 'none'>; connect-src <API_URL origin>
<NEAR_RPC origin> [<NEAR_RPC_FALLBACK origin>] https://www.googleapis.com`, `cross-origin-resource-policy: cross-origin`, `cache-control: no-store`,
`referrer-policy: no-referrer`, `x-content-type-options: nosniff`.

Errors are an empty HTML page with `frame-ancestors 'none'` and no config: `403` (`unknown_app`, `app_suspended`,
`scope_conflict`, `too_many_origins` > 20), `503` (`config_unavailable`, `misconfigured` when `API_URL` or `NEAR_RPC`
is missing or not a URL, or `NEAR_RPC_FALLBACK` is set but not a URL). The code is in the log line, not the body.

### Page Workers (`src/pages/`) · B

One thin Worker per Hana origin in every env (D66; `workers.dev` in dev envs, a Custom Domain elsewhere;
`apps/api/scripts/pages-wrangler.ts`), each with only its origin's built pages as static assets
(`packages/web/dist/pages/<env>/vault`, `…/auth`). Only `GET`/`HEAD` (`405` otherwise), only on their own origin
(`404` on any other host).

| Origin | Path | Response |
|---|---|---|
| vault | `/vault` | forwarded to the API Worker (service binding `API`), unchanged but for a `Set-Cookie` header, which is dropped; `503` page with no config if it is unreachable |
| auth | `/login`, `/login/callback` | `<path>.html` with `frame-ancestors 'none'; connect-src <API_URL>` |
| auth | `/approve` | `approve.html` with `frame-ancestors 'none'` |
| auth | `/export` | `export.html` with `frame-ancestors 'none'; connect-src <API_URL> <NEAR_RPC> [<NEAR_RPC_FALLBACK>] https://www.googleapis.com` |
| both | any other path | a static asset, never HTML (`*.html` and `text/html` → `404`) |

Pages carry the base policy plus their directives, `no-store`, `no-referrer`, `nosniff`, no COOP; a missing page file
is a `503` page. Every asset carries `content-security-policy: default-src 'none'; frame-ancestors 'none'; sandbox`
(an SVG or XML file opened as a document runs, loads and frames nothing; not applied by browsers to the scripts and
styles the pages load), `nosniff`, `no-referrer` and `cross-origin-resource-policy: same-origin`.

**No cookies (D70).** No response of the API Worker or of either page Worker sets a cookie; the page Workers drop a
`Set-Cookie` header from what their bindings answer (`withoutCookies`, `src/pages/host.ts`). Tests:
`apps/api/test/no-cookies.test.ts` (every endpoint and page), `packages/web/test/no-cookies.test.ts` (no source sets
one) and the Playwright suite (every Hana response of every flow).

### Vault endpoints · B

All `POST`, `Origin: VAULT_ORIGIN`, `x-hana-key`, `x-hana-parent-origin`. No transaction. Signatures are Ed25519 by
the session key over `"hana-id-vault-v1:" ‖ borsh(SIGNER_ACCOUNT) ‖ borsh(appId) ‖ shareId(16) ‖ u64le(counter) ‖
sha256(payload)`, `appId` = the D1 `apps.id` (`docs/contract-interface.md`, "Vault message").

Gate, in order: `401 missing_key` / `unknown_app` / `503 config_unavailable` → `403 app_suspended` → Origin is
`VAULT_ORIGIN` (`403 origin_not_allowed`) → parent allowed (`403 origin_not_allowed`) → `403 scope_conflict` → vault
limits. Storage errors: `503 config_unavailable`. Missing `VAULT_KEK`: `503 vault_key_unavailable`.

| Endpoint | Body | Payload | 2xx |
|---|---|---|---|
| `/v1/vault/shares` | `{sessionPublicKey: number[32], signature: number[64]}` (exactly) | `"share" ‖ borsh(parentOrigin)`, shareId 0×16, counter 0 | `201 {shareId: number[16], ks: number[32], absExpiresAtMs, idleUntilMs}` (+ `timings`, `pk_test_` only) |
| `/v1/vault/unlock` | `{shareId: number[16], counter: integer ≥ 1, signature: number[64]}` (exactly) | `"unlock"` | `200 {ks: number[32], counter, idleUntilMs, absExpiresAtMs}` (+ `timings`, `pk_test_` only) |
| `/v1/vault/touch` | same | `"touch"` | `200 {counter, idleUntilMs}` |
| `/v1/vault/revoke` | same | `"revoke"` | `200 {revoked: true}` |
| `/v1/vault/revoke-all` | same | `"revoke-all"` | `200 {revoked: <number of the same user's other live shares in this app>}` |

`shares`, after the gate: `409 persistence_off` → `401 invalid_signature` → `get_session` straight from the node,
re-read every 300 ms for up to 2 s while missing or not used up (`404 unknown_session`, `403 scope_mismatch`,
`409 session_not_spent`, `502 near_unavailable`) → insert (`409 share_exists`: one share per session key).
`absExpiresAt = min(session expiry, now + session_ttl_ms)`, `idleUntil = min(now + idle_ttl_ms, absExpiresAt)`.

Share actions, after the gate: per-share limit → `404 unknown_share` (missing or another app's) → share's origin no
longer allowed: revoked, `410 share_revoked` → unlock and touch only, the app's settings as they are now: persistence
`none` revokes the share (`410 share_revoked`), and the share ends at `min(abs_expires_at, created_at +
session_ttl_ms)` (a lowered TTL also lowers the stored `abs_expires_at`; `410 share_expired` once past it) →
`401 invalid_signature` (counter not consumed) → `revoke-all` only: `403 share_not_fresh` (share ≥ 5 min old) → one
atomic update that needs `counter = stored + 1` and a live share (for unlock and touch it re-checks persistence and
the TTL cap in the same statement): `409 bad_counter` with `expected`, `410 share_expired`, `410 share_revoked`.
Unlock unwraps K_s before the counter moves, re-wraps it under the current KEK if the row is under
`VAULT_KEK_PREVIOUS`, slides `idle_until` to `min(now + idle_ttl_ms, the capped expiry)`, returns the capped
`absExpiresAtMs`, counts `usage.unlocks`; an unreadable row is `500 internal`. Touch slides `idle_until` the same way.
Revoke and revoke-all ignore the settings. Revoke-all keeps its own share live and runs as one D1 batch (one
transaction): the other shares are revoked only on the condition the counter move then meets, so a failed write
changes nothing and a replay revokes nothing.

### `POST /v1/owner-actions` — owner pool

No app key. `{"method", "args"}` only, `args` exactly as the contract takes them; unknown keys anywhere are refused.

| `method` | `args` |
|---|---|
| `propose_change` | `{scope_id, auth, change, client_proof?}`; `change` is `{"AddClient":{provider, aud}}` (needs `client_proof`), `{"SetOwners":{owners: 1..5}}` or `{"SetAllowShared":{"allow":true}}`; relayed with `client_proof: null` when absent |
| `cancel_change` | `{scope_id, auth, change_id}` |
| `remove_client` | `{scope_id, auth, provider, aud}` |
| `disable_shared_login` | `{scope_id, auth}` |
| `execute_change` | `{scope_id, change_id}` (no `auth`) |

`auth` must be `{"Oidc":{"jwt":"…"}}`. Checks after the per-IP limit and shape (`400 bad_request`):

| Status | Code | When |
|---|---|---|
| 401 / 400 | `invalid_token`, `token_expired` / `unsupported_issuer` | `auth` token (no skew) |
| 403 | `not_console_token` | `(provider, aud)` not in `get_config().console_audiences` |
| 404 | `unknown_scope` | |
| 403 | `not_owner` | token's `(provider, sub)` not an `Oidc` owner |
| 404 / 409 | `unknown_change` / `change_locked` | cancel, execute |
| 404 / 409 | `unknown_client` / `last_client` | `remove_client` |
| 409 | `shared_login_disabled` / `last_client` | `disable_shared_login` |
| 400 / 409 | `invalid_client_proof` / `client_registered`, `shared_client` | `AddClient` |
| 409 | `shared_login_enabled` | `SetAllowShared` already on |
| 409 | `token_used` | this exact token was reserved before |
| 503 / 502 | `issuer_keys_unavailable` / `near_unavailable` | JWKS / chain read failed |

The token's sha256 is reserved atomically (`RateLimiter` object `owner-actions:tokens`, until the token's `exp`)
before relaying; it is released only if the global cap refuses the request or the relay certainly never executed
(`method_not_allowed`, `relayer_unconfigured`, `near_unavailable`, `near_rejected`, `relayer_busy`). Without
`OWNER_RELAYER_KEYS`: `503 relayer_unconfigured`. → `200 {"result": <contract return or null>, "nearTx", "requestId"}`.

`register_scope` and `apply_pending_config` are in the owner pool's allowlist but no endpoint relays them today.

## Relay errors (any relayed call)

| Status | Code | Executed? |
|---|---|---|
| 422 | `contract_rejected` (panic text in `error`) | yes, failed |
| 502 | `near_rejected` | no (node refused the tx as invalid) |
| 502 | `near_unavailable` | no (RPC read before sending failed) |
| 502 | `near_error` | unknown; check `nearTx` |
| 502 | `bad_contract_result` | yes; result not the expected shape |
| 503 | `relayer_busy` | no (nonce still invalid after one retry, or tx dropped twice) |
| 503 | `relayer_unconfigured` | no (pool secret missing or empty) |
| 503 | `relayer_unavailable` | unknown (Durable Object call failed) |
| 504 | `timeout` | unknown; outcome not settled within 60 s |

Any other broadcast failure (dropped connection, non-JSON 5xx) is treated as "may have executed" and the hash is
polled.

## Idempotency and replay

No idempotency keys. Each endpoint is safe to retry because the second copy is refused:

| Endpoint | A replay or retry gets |
|---|---|
| `/v1/sessions` | `409 session_exists` (`session_key_in_use`, also true for revoked unexpired sessions) |
| `/v1/login` | the same, or `422 contract_rejected` `reason: session_key_in_use` if both reached the chain |
| `/v1/derive`, `/v1/sessions/revoke` | `409 counter_used` with `nextCounter`; no gas spent. Copies racing in different isolates can still reach the chain (all but one fail there, ~2.2 Tgas each) |
| `/v1/owner-actions` | `409 token_used` |
| `/v1/vault/shares` | `409 share_exists` |
| vault share actions | `409 bad_counter` with `expected` |
| login relay | write `409 relay_used`; read `410 relay_gone` |

After `504 timeout` or `502 near_error`, look the tx up by `nearTx` before retrying: a retry of a request that landed
is refused as above.

## Relayer pools and gas (`src/relayer-config.ts`, `src/gas.ts`)

| Pool | Secret | Durable Object names | Methods | Used by |
|---|---|---|---|---|
| session | `RELAYER_KEYS` | `relayer-key-<i>` | `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions` | `/v1/sessions`, `/v1/login`, `/v1/derive`, `/v1/sessions/revoke` |
| owner | `OWNER_RELAYER_KEYS` | `owner-relayer-key-<i>` | `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config` | `/v1/owner-actions` |

Keys are function-call keys on `RELAYER_ACCOUNT`, receiver `SIGNER_ACCOUNT`, no deposit. A key of the pool is picked
round-robin (random start per isolate). The allowlist is enforced in `relay()` and again in the object (`400
method_not_allowed` otherwise). The session list is allowlist state 1 of `docs/batch-b-spec.md` ("Relayer
allowlists").

Gas attached (Tgas; `GAS_<METHOD>_TGAS` var overrides with an integer 1..300, invalid values logged and ignored):
`create_session` 50, `create_session_and_derive` 100, `derive_key` 60, `revoke_session` 20, `prune_sessions` 50, owner
methods 50, `register_scope` 30 + 25 per proof (max 300). The cron's `set_issuer_key` / `remove_issuer_key` use 30 Tgas
with `KEYS_UPDATER_KEY` (on `SIGNER_ACCOUNT`, not a pool).

Transactions are answered at `EXECUTED_OPTIMISTIC` (not finality); `tx` is polled every 400 ms for up to 60 s.

## Durable Objects

All SQLite-backed (wrangler migrations `v1`: `RelayerKey`, `RateLimiter`; `v2`: `LoginRelay`).

**Names and placement (`src/placement.ts`).** With manifest `cloudflare.durableObjectLocation` set (var
`DO_LOCATION_HINT`, one of `wnam enam sam weur eeur apac oc afr me`), shared objects get the suffix `@<hint>` and are
created there: `relayer-key-0@apac`, `owner-relayer-key-0@apac`, `app:<appId>@apac`, `owner-actions:global@apac`,
`owner-actions:tokens@apac`, `share:<hex>@apac`. Unset or unknown hint: no suffix, Cloudflare places them. Changing
the hint creates new objects (fresh limiter counters; new relayer objects read their nonce from chain once). Never
suffixed: per-IP limiters `ip:v4:<addr>` / `ip:v6:<prefix>::/64` (created near the client) and `LoginRelay` objects
(named by `relayId`).

| Class | State (KV keys) | Notes |
|---|---|---|
| `RelayerKey` | `publicKey`, `nonce` (reservation R), `block` `{hash, at}` | One per pool key; refuses a second pool or index |
| `RateLimiter` | `<window>@<windowStart>` → count; `mark:<sha256>` → until ms | Windows pruned when they end |
| `LoginRelay` | `slot`: `full` / `consumed` / `expired` | Alarm at write + 120 s, then + 120 s |

**Nonce reservation (`relayer-key.ts`).** A promise-chain mutex covers only *nonce → sign → reserve → start
`send_tx`*; outcomes are awaited outside it, so many txs per key are in flight. Storage holds R ("no tx of this key
was ever sent with a nonce above R"). A nonce n > R first writes R' = n + 99 and waits for `storage.sync()`, so one
relay in 100 waits for a confirmed write. Cold start (instances are evicted after ~10 s idle): with an R stored for
this key's public key, start at R with no chain read (skips up to 99 nonces) and reuse the stored block hash if under
5 min old; without one (new or replaced key), read the access-key nonce and a final block. `InvalidNonce` → re-read
`max(local, chain, ak_nonce)` and retry once; `Expired` → refresh the block and retry once; a tx superseded twice
2 s apart while unknown → `dropped`, resent once with a fresh nonce.

## Chain views and caches (per isolate, `src/views.ts`)

| View | Cache |
|---|---|
| `get_session` | 10 s; misses not cached; a refusal from cache is re-read fresh |
| `session_key_in_use` | "in use" from a cached unexpired session; "not in use" always fresh |
| `scope_for_client` | 60 s, a miss 10 s; dropped for the scope after an owner action relayed here |
| `get_scope` | 10 s; dropped after an owner action |
| `get_config` | 60 s |
| Google JWKS | `max-age` clamped to 5 min..6 h; unknown kid refetches at most once a minute; 10 s back-off after a failure; a stale set serves its kids up to 6 h past expiry |

## D1 schema (`apps/api/migrations`)

| Table | Key columns | Migration |
|---|---|---|
| `plans` | `id` PK, `per_minute`, `per_day`, `per_ip_minute` (default 20); seeds `free` 60 / 5000 / 20 | 0001 |
| `apps` | `id` PK, `name`, `scope_id` (indexed), `publishable_key` UNIQUE, `status` `active`/`suspended`, `plan` → plans, `created_at` ms | 0001 |
| `apps` (added) | `persistence` `session`/`none` (default `session`), `session_ttl_ms` 1 h..23 h 50 min (12 h), `idle_ttl_ms` 15 min..session TTL (2 h), `raw_sign` `off`/`approval` + `raw_sign_pending`, `raw_sign_effective_at`, `auto_approve_policy` / `auto_approve_pending` (JSON) + `auto_approve_effective_at`, `google_web_client_id` | 0003 |
| `app_origins` | (`app_id`, `origin`) PK, `origin` indexed; `http://localhost:*` wildcard allowed | 0001 |
| `usage` | (`app_id`, `day` `YYYY-MM-DD` UTC) PK, `sessions`, `derives` | 0001 |
| `usage` (added) | `unlocks` | 0003 |
| `issuer_key_missing` | (`provider`, `kid`) PK, `first_missing_at` ms | 0002 |
| `vault_shares` | `share_id` BLOB(16) PK, `app_id`, `session_pk` BLOB(32) UNIQUE, `path_hash` = sha256(path), `partner_origin`, `share_enc` = iv ‖ AES-GCM(KEK, K_s, aad = share_id ‖ app_id ‖ session_pk), `kek_id`, `counter`, `created_at`, `idle_until`, `abs_expires_at`, `revoked_at`; indexes (`app_id`, `path_hash`), `abs_expires_at`, `kek_id` | 0003 |

## Cron (`0 * * * *`)

Two independent jobs (one failing doesn't skip the other):

- **Google JWKS → contract** (`issuer-keys.ts`): `set_issuer_key` for new kids, `remove_issuer_key` for kids missing
  from the JWKS for ≥ 55 min (tracked in `issuer_key_missing`), signed with `KEYS_UPDATER_KEY`. Without it:
  `jwks_sync_skipped`.
- **Vault maintenance** (`vault/cron.ts`, B): deletes shares past `abs_expires_at` or revoked; re-wraps up to 2000
  rows from `VAULT_KEK_PREVIOUS` to `VAULT_KEK`; counts rows under a KEK id neither key has (logged as an error).

## Configuration (Worker bindings)

Vars are generated from `envs/<env>.json` by `apps/api/scripts/gen-wrangler.ts` into `apps/api/wrangler.jsonc`
(gitignored, per env; the tests generate their own `wrangler.vitest.jsonc`); secrets are set with
`wrangler secret put` (`VAULT_KEK` through `scripts/vault-kek.ts`). Schema: `packages/env/src/schema.ts`; types: `apps/api/src/env.ts`.

| Binding | Kind | Source | Notes |
|---|---|---|---|
| `NEAR_RPC` | var | `rpc` | |
| `NEAR_RPC_FALLBACK` | var, optional | `rpcFallback` | only written when set; the vault page's and the export page's `connect-src` (the API itself reads only `NEAR_RPC`) |
| `SIGNER_ACCOUNT` | var | `signer` | only receiver ever called |
| `RELAYER_ACCOUNT` | var | `relayer` | pays gas |
| `ENV_NAME` | var | `name` | `local*` / `sandbox*` = dev env |
| `MPC_ACCOUNT` | var | `mpc` | `/v1/login` failure mapping |
| `VAULT_ORIGIN`, `AUTH_ORIGIN` | var | `vaultOrigin`, `authOrigin` | `gen` refuses an env without both |
| `API_URL` | var | `apiUrl` | vault page `connect-src` |
| `DO_LOCATION_HINT` | var | `cloudflare.durableObjectLocation` | only written when set |
| `BLS_PRECHECK`, `REJECT_PII_ON_SESSIONS` | var | `gen` writes `"0"` | `"1"` turns each on |
| `GAS_<METHOD>_TGAS` | var, optional | not generated | per-method gas |
| `RELAYER_KEYS` | secret | `.secrets/<env>/relayer-keys.json` | JSON array of `ed25519:` secret keys |
| `OWNER_RELAYER_KEYS` | secret | `.secrets/<env>/owner-relayer-keys.json` | same format; absent → owner actions 503 |
| `KEYS_UPDATER_KEY` | secret | `.secrets/<env>/keys-updater.json` `private_key` | absent → cron skips JWKS sync |
| `VAULT_KEK` | secret | `.secrets/<env>/vault-kek`, from `scripts/vault-kek.ts init` | `<id>:<base64 of 32 bytes>`; absent → vault 503 |
| `VAULT_KEK_PREVIOUS` | secret, rotation only | `.secrets/<env>/vault-kek.previous`, from `vault-kek rotate` | |
| `DB` | D1 | `cloudflare.d1Name`, id from `--d1-id` | `migrations_dir: migrations` |
| `RELAYER_KEY`, `RATE_LIMITER`, `LOGIN_RELAY` | Durable Objects | classes `RelayerKey`, `RateLimiter`, `LoginRelay` | |

`gen` also writes the page Workers' `wrangler.vault.jsonc` (var `VAULT_ORIGIN`, assets, service binding `API` to this
Worker) and `wrangler.auth.jsonc` (vars `AUTH_ORIGIN`, `API_URL`, `NEAR_RPC`, `NEAR_RPC_FALLBACK` when set; assets),
both gitignored (`apps/api/scripts/pages-wrangler.ts`).

Also generated: `name` = `cloudflare.workerName`, `compatibility_date` 2026-10-01, `nodejs_compat`, alias
`secp256k1` → `src/shims/secp256k1.ts`, `observability.enabled`, the cron.

## Timings

A `pk_test_` app's successful `POST /v1/login`, `POST /v1/vault/shares` and `POST /v1/vault/unlock` answer with the
request's own timings, so a test page can set the API's time against its own round trip (apps/smoke, README
"Timings"):

```json
"timings": { "totalMs": 0, "phases": { "app": 0, "limits": 0, "…": 0 } }
```

`totalMs` runs from the request reaching the Worker to the answer; `phases` are the request log's (below). Durations
only, under phase names: no request field, key, token or transaction. Like the log, they move only on I/O (the Workers
clock), so CPU-only work shows as 0. `pk_live_` apps never get them, nor does any error answer or any other endpoint
(`apps/api/test/timings.test.ts`).

## Logs

One JSON line per event (`src/log.ts`): `{"level", "ts", "event", …}`. Only typed fields can be logged: never JWTs,
signatures, bodies, keys, CKD responses, relay bodies or panic text.

`event: "request"`, one per API request:

| Field | |
|---|---|
| `requestId`, `appId`, `endpoint`, `method` (login relay only) | `endpoint` is the path; a login relay is always `/v1/login-relay`, never with its relayId |
| `outcome` | `ok` (< 400), `rejected` (4xx), `error` (5xx; logged at level `error`) |
| `status`, `code`, `nearTx`, `latencyMs` | |
| `colo` | Cloudflare data center that ran the request (`SIN`, …) |
| `phases` | ms per stage, below |
| `relayInstance` | `{cold, coldChainRead, blockRefresh, served, ageMs}` of the relayer key object |

| Phase | Covers |
|---|---|
| `app` | D1 app lookup |
| `limits` | rate-limiter round trips |
| `checks` | body, token, nonce, chain reads, signature, pre-checks (everything before the relay) |
| `settings` | share creation: the app's settings row (D1) |
| `session` | share creation: signature check, then the session read and its retries (every 300 ms for up to 2 s while the node lags) |
| `insert` | share creation: wrapping K_s and the D1 insert |
| `shareLimit` | share actions: the per-share limiter |
| `share` | share actions: the KEK, the share row and (unlock, touch) the settings row (D1) |
| `advance` | unlock: re-wrap if needed and the counter update (D1) |
| `relay` | round trip to the relayer key object |
| `relayDispatch` | inside it, until broadcast: = `relayQueue` + `relayChainRead` + `relaySign` + `relayPersist` (summed over retries) |
| `relayQueue` | waiting for earlier critical sections of the same key |
| `relayChainRead` | access-key / block reads (cold start without reservation, block > 5 min old, recovery) |
| `relaySign` | signing (~0: the Workers clock moves only on I/O) |
| `relayPersist` | confirming a new nonce reservation (0 inside one) |
| `relayOutcome` | broadcast to executed outcome |

`relayInstance`: `cold` this relay started the instance; `coldChainRead` that start read the chain; `blockRefresh`
the block hash was re-read; `served` relays this instance handled before; `ageMs` since it started.

Other events: `relay_dispatched` (`pool`, `keyIndex`, `method`, `nearTx`, `nonce`, `attempt`), `relay_retry`
(`code` `invalid_nonce` / `expired` / `dropped`), `relay_dispatch_failed`, `jwks_sync` (`added`, `removed`, `kids`),
`jwks_sync_failed` / `jwks_sync_skipped` (`code`), `jwks_tx`, `jwks_stale`, `vault_page` (`latencyMs`: its D1 reads), `vault_maintenance`
(`pruned`, `rewrapped`, `unknownKek`), `vault_rewrap_unreadable` (`unreadable`), `vault_kek_unavailable`, `vault_share_unreadable`,
`usage_increment_failed`, `owner_token_release_failed`, `gas_override_ignored`, `auto_approve_policy_invalid`
(`problems`), and from the page Workers `vault_host` and `auth_page` (`code`).
