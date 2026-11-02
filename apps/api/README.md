# @hana-id/api

Cloudflare Worker that relays `hana-signer` calls for registered apps: it pays the gas, checks the app (publishable
key, origin, plan limits, scope) before anything reaches the chain, and keeps relayer nonces in order with one
Durable Object per relayer key. Spec: `docs/batch-a-spec.md` (API section) as amended by
`docs/batch-a2-shared-client.md` and `docs/batch-b-spec.md` (API changes); contract: `docs/contract-interface.md`.

## Commands

```sh
pnpm --filter @hana-id/api gen sandbox-dev [--d1-id <uuid>] [--usage-hyperdrive-id <id>|off] [--dev-vars]  # wrangler.jsonc, wrangler.{vault,auth}.jsonc (+ .dev.vars) from envs/<env>.json
pnpm --filter @hana-id/api test        # vitest in workerd (@cloudflare/vitest-plugin), NEAR RPC mocked; then scripts/ tests in Node
pnpm --filter @hana-id/api typecheck
pnpm --filter @hana-id/api dev         # wrangler dev (local D1: `wrangler d1 migrations apply DB --local` first)
```

`wrangler.jsonc` (and the page Workers' `wrangler.vault.jsonc`, `wrangler.auth.jsonc`, see [Page Workers](#page-workers))
are generated per env and gitignored (they can hold a real D1 id): run `gen <env>` before `dev`, `deploy` or the
`admin app:*` commands, change `envs/<env>.json` or `scripts/gen-wrangler.ts`, never the files, and never commit them.
The tests don't read them: `vitest.config.ts` writes `wrangler.vitest.jsonc` (gitignored) with the same generator from a
fixed test manifest (`TEST_MANIFEST`), so CI needs no `gen` step and no env's values reach the tests. Without `--d1-id`
the id already in the file is kept only if that file was generated for the same D1 database (`database_name`), else a
local-only placeholder is written. `--usage-hyperdrive-id` binds the usage ledger's writer (`USAGE_DB`, batch C4;
kept on later runs for the same Worker and database, `off` drops it); without it usage capture is off. `--dev-vars` writes `RELAYER_KEYS` (from `.secrets/<env>/relayer-keys.json`) and
`OWNER_RELAYER_KEYS` (from `.secrets/<env>/owner-relayer-keys.json`) single-quoted (wrangler's dotenv parser takes them
literally), plus `KEYS_UPDATER_KEY`; files that don't exist are skipped.

Deploy (testnet only): `wrangler d1 create <cloudflare.d1Name>` → `gen <env> --d1-id <id>` →
`wrangler d1 migrations apply DB --remote` → `wrangler secret put RELAYER_KEYS` (JSON array of `ed25519:` secret
keys, e.g. the content of `.secrets/<env>/relayer-keys.json`) → `wrangler secret put OWNER_RELAYER_KEYS` (same format,
`.secrets/<env>/owner-relayer-keys.json`) → `wrangler secret put KEYS_UPDATER_KEY` → `wrangler deploy` →
`pnpm --filter @hana-id/scripts run vault-kek <env> init --yes` (VAULT_KEK, below) → the page Workers (below).
`docs/operations.md` has the full runbook.

## Config

| Name | Kind | |
|---|---|---|
| `NEAR_RPC`, `SIGNER_ACCOUNT`, `RELAYER_ACCOUNT`, `ENV_NAME`, `MPC_ACCOUNT` | vars (manifest) | `rpc`, `signer`, `relayer`, `name`, `mpc`. `ENV_NAME` `local*`/`sandbox*` is a dev env (see Origins) |
| `NEAR_RPC_FALLBACK` | optional var (manifest) | `rpcFallback`, written only when set: the vault and export pages' `connect-src` (D65); the API itself reads only `NEAR_RPC` |
| `DO_LOCATION_HINT` | optional var (manifest) | `cloudflare.durableObjectLocation`: region of the shared Durable Objects (`src/placement.ts`) |
| `VAULT_ORIGIN`, `AUTH_ORIGIN` | vars (manifest) | `vaultOrigin`, `authOrigin`; `gen` refuses an env without them |
| `BLS_PRECHECK`, `REJECT_PII_ON_SESSIONS` | vars | `"0"` everywhere until their step in `docs/batch-b-spec.md` ("Order of work") |
| `RELAYER_KEYS` | secret | Session pool: JSON array of function-call keys on `RELAYER_ACCOUNT` (receiver `SIGNER_ACCOUNT`; `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions`) |
| `OWNER_RELAYER_KEYS` | secret | Owner pool (small allowance), same format: `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config`. Without it `/v1/owner-actions` answers 503 and logins are unaffected |
| `GAS_<METHOD>_TGAS` | optional vars | Per-method gas override in Tgas (integer 1..300), e.g. `GAS_DERIVE_KEY_TGAS=80`; invalid values are ignored (logged) |
| `KEYS_UPDATER_KEY` | secret | function-call key on `SIGNER_ACCOUNT` (governance contract: exactly `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`, installed by `add_updater_key`); cron skips without it |
| `API_URL` | vars (manifest) | `apiUrl`: the API's own URL, in the vault page's CSP `connect-src` |
| `VAULT_KEK` | secret | Vault share wrapping key, `<id>:<base64 of 32 bytes>` (`id` a positive integer). Create it with `pnpm --filter @hana-id/scripts run vault-kek <env> init --yes`: it generates key id 1, keeps it in `.secrets/<env>/vault-kek` (0600, never overwritten; the only copy, since Cloudflare can't give a secret back) and sets the secret through wrangler's stdin, printing no key. `vault-kek <env> put --yes` sets it again from the file. Without it the vault endpoints answer `503 vault_key_unavailable` |
| `VAULT_KEK_PREVIOUS` | secret, rotation only | The previous `VAULT_KEK`. Rotate with `vault-kek <env> rotate --yes`: the current key goes to `VAULT_KEK_PREVIOUS` (and `.secrets/<env>/vault-kek.previous`), a new key with the next id to `VAULT_KEK` (and `vault-kek`); a run that stops part way resumes when re-run. Unlocks and the cron re-wrap old rows; once `SELECT COUNT(*) FROM vault_shares WHERE kek_id = <old id>` is 0, delete the secret and the `.previous` file (`docs/operations.md`, "Key rotation") |
| `IDENTITY_ISS`, `IDENTITY_PUBLIC_KEYS`, `IDENTITY_ACTIVE_KID` | optional vars (manifest `identityToken`) | The partner identity token's issuer, JWKS (public keys only) and signing kid. Without them `/v1/identity/*` answers `503 identity_unavailable` (`docs/api.md` "Identity token") |
| `IDENTITY_SIGNING_KEY`, `IDENTITY_SIGNING_KEY_STANDBY`, `IDENTITY_SUB_KEY` | secrets, testnet only | Two slots for P-256 private JWKs (whichever has the thumbprint `IDENTITY_ACTIVE_KID` signs; normally only the active key is uploaded, both only during a switch) and the `sub`/`sid` HMAC key. `pnpm --filter @hana-id/scripts run identity-key <env> init --yes` generates the active key, an offline standby (published, never uploaded) and the sub key into `.secrets/<env>/identity-*` (0600), writes the public keys to the manifest and sets the active key and the sub key through wrangler's stdin; `next`, `switch`, `retire` rotate (`docs/operations.md` "Identity token keys", D177) |
| `IDENTITY_SIGNER`, `IDENTITY_KMS_KEY_ARN`; `IDENTITY_AWS_ACCESS_KEY_ID`, `IDENTITY_AWS_SECRET_ACCESS_KEY` | vars; secrets (`aws-kms` only) | The signer kind (`worker-secret`, the default, or `aws-kms`) and, for AWS KMS, the active key's ARN and the signer IAM user's access key (`identity-key <env> kms-put-aws-key`). No env uses KMS yet (`docs/operations.md` "Identity token keys on AWS KMS", D215) |
| `IDENTITY_SESSION_LIMIT`, `IDENTITY_ROOT_LIMIT` | Rate Limiting (`ratelimits`) | `/v1/identity/token` per session key (10 per 60 s) and per account root (30 per 60 s), per location (`src/identity/limits.ts`); namespaces `95003`, `95004` |
| `DB` | D1 | `migrations/` |
| `RELAYER_KEY`, `RATE_LIMITER`, `LOGIN_RELAY` | Durable Objects | SQLite-backed classes `RelayerKey`, `RateLimiter` (migration `v1`), `LoginRelay` (`v2`) |
| `VAULT_IP_LIMIT`, `VAULT_SHARE_LIMIT` | Rate Limiting (`ratelimits`) | The vault's per-IP (60) and per-share (10) limits per 60 s, counted per Cloudflare location (`src/vault/limits.ts`, D95); namespaces `95001`, `95002` are account-wide |
| cron `*/15 * * * *` | trigger | One trigger. Every run syncs Google's JWKS with hana-signer (`src/issuer-keys.ts`): proposes new kids (`set_issuer_key`, which queues them for `issuer_key_delay_ms`), proposes the removal of kids missing from the JWKS for ≥ 55 min (`propose_issuer_key_removal`, tracked in D1 `issuer_key_missing`, never the issuer's last key), executes matured changes that agree with the JWKS (`execute_issuer_key_change`), never calls `remove_issuer_key`; remembers its proposals in `issuer_key_proposals` (a cancelled one is held 1 h) and its last run in `issuer_key_sync_runs`. Every run records Google's JWKS kids in D1 `issuer_key_observations` (D33 key lead time: `admin <env> issuer-keys:lead-times`, `docs/operations.md`) |
| cron, run at :00 | trigger | Also vault maintenance (`src/vault/cron.ts`, `isHourlyRun`): deletes `vault_shares` rows past `abs_expires_at` or revoked once older than 24 h (tombstones for the identity token, D178), re-wraps up to 2000 rows per run from `VAULT_KEK_PREVIOUS` to `VAULT_KEK`, logs rows under an unknown KEK id; and deletes identity token counts older than 24 months (`src/identity/maintenance.ts`) |

## Endpoints

All JSON. Success: `{"result": …, "nearTx": "<base58 tx hash>", "requestId": "…"}`. Error:
`{"error": "<message>", "code": "<code>", "nearTx"?: "…", "requestId": "…"}`. Every response except a CORS preflight
(`OPTIONS`) has `x-request-id`, the router's own `404`/`405`/`500` included.

### App endpoints: `x-hana-key: pk_…` + an allowed caller (see Origins)

| Endpoint | Body (camelCase, byte arrays as JSON number arrays) | Contract call → `result` |
|---|---|---|
| `GET /v1/app` | — | none → `{name, scopeId, signer, google: {clientId, mode: "own" \| "shared"}, serverTimeMs, autoApprovePolicy, rawSign, requestId}` (top level, no `result`; `autoApprovePolicy` is the policy in force, validated and normalized, or `null`; `rawSign` is `"off"` or `"approval"` in force now; an open vault re-reads both within 10 s, D62, D68) |
| `POST /v1/login` | a `/v1/sessions` body plus `{signature[64], pk1, pk2}` (the session key's signature over counter 1 of the CKD payload); nothing else | `create_session_and_derive` (100 Tgas) → `{big_y, big_c}`, plus `session: {scope_id, expires_at_ms, max_uses, used: 1}` (informational) |
| `POST /v1/sessions` | `{jwt, sessionPublicKey[32], expiresAtMs, salt[16..64], keyIndex (0..2^31 − 1; higher is reserved), maxUses (1..500)}`; `scopeId` is rejected | `create_session` with the app's `scope_id` (D1) → Session `{path, scope_id, expires_at_ms, max_uses, used}` |
| `POST /v1/derive` | `{sessionPublicKey[32], counter, signature[64], pk1 "bls12381g1:…", pk2 "bls12381g2:…"}` | `derive_key` → `{big_y, big_c}` |
| `POST /v1/sessions/revoke` | `{sessionPublicKey[32], counter, signature[64]}` | `revoke_session` → `null` |

Checks, in order (rejected before anything is relayed):

1. Key present and known (`401 missing_key` / `unknown_app`), app `active` (`403 app_suspended`), and not a
   `pk_test_` app on a scope a `pk_live_` app also uses (`403 scope_conflict`).
2. The caller may call this endpoint for this app (`403 origin_not_allowed`; see Origins).
3. Rate limits from the app's plan: per client IP (per app) per minute first, then per app per minute and per UTC day
   (`429 rate_limited` + `retry-after`). The IP check runs first so requests it rejects never use up the app's shared
   quota. "Client IP" is the IPv4 address, or the IPv6 /64 prefix (a host can rotate addresses inside its /64).
4. Body shape (`400 bad_request`, `413` over 16 KiB).
5. `/v1/sessions`:
   - The ID token is verified with WebCrypto: RS256 signature against Google's JWKS
     (`https://www.googleapis.com/oauth2/v3/certs`, cached per its `Cache-Control` max-age within 5 min..6 h; an
     unknown `kid` refetches once, at most once a minute counting failed attempts; after a failed fetch no new attempt
     for 10 s, and an expired set keeps serving the kids it holds for up to 6 h past its max-age while refetches
     fail), `iss` → provider, `exp` with 60 s of clock skew (`401 invalid_token`, `400 unsupported_issuer`,
     `400 token_expired`, `503 issuer_keys_unavailable`). Segments must be canonical base64url (no unused bits set),
     as the contract's decoder requires.
   - The token must carry a `nonce` equal to the session nonce recomputed from the body, `SIGNER_ACCOUNT` and the app's
     `scope_id` (`400 nonce_mismatch`; layout in `src/session-crypto.ts` and `docs/batch-a2-shared-client.md`).
   - Scope: if `scope_for_client(provider, aud)` (cached 60 s, a miss 10 s; dropped in this isolate after an owner
     action relayed for that scope) names a scope it must be the app's
     (`403 scope_mismatch`); else the client must be a shared client in force (`get_config().shared_clients` plus
     pending additions whose unlock time has passed, cached 60 s) and the app's scope must exist with `allow_shared`
     (`get_scope`, cached 10 s; `403 unknown_scope` / `shared_login_disabled`); else `403 unregistered_client`.
   - The session key is not in use: `session_key_in_use` is false (`409 session_exists`; a replayed body would only
     fail on chain). Unlike `get_session`, it also counts revoked sessions that have not expired. A cached unexpired
     session answers without a view call; "not in use" is always read from chain.
   - Governance (also on `/v1/login`): the contract isn't paused (`get_config().paused`, `503 paused`, `retry-after:
     60`) and the token's `kid` is an active key on chain (`get_issuer`, cached 60 s, re-read on an unknown kid at most
     every 10 s; `503 issuer_key_pending`, `retry-after: 30`: a new Google key still in its issuer-key delay). Fails
     open when the views can't be read (the contract decides). `/v1/derive` checks the pause only.
6. `/v1/derive`, `/v1/sessions/revoke`: the Ed25519 signature (WebCrypto) of `sessionPublicKey` over
   `"hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload)` must verify, payload `"hana-id-ckd-v1:{pk1}:{pk2}"` or
   `"revoke"` (`401 invalid_signature`). Then `get_session` (cached 10 s, misses not cached) must exist, belong to the
   app's scope (`403 scope_mismatch`) and be unexpired (`404 unknown_session`), and the request must be one the
   contract could still accept (`src/session-use.ts` mirrors its rules), so replays of the public signed requests
   cost no gas: `409 session_exhausted` (derive with `used = max_uses`), `409 counter_used` (counter ≤ `used`, a
   replay) and `409 counter_out_of_range` (counter past `max_uses`, or `max_uses + 1` for a revoke, which ignores the
   limit); the counter errors carry `nextCounter` (`used + 1`). A counter ahead of `used + 1` is relayed (the requests
   before it may be in flight). The cache counts this isolate's successful derives in the session each was judged
   against (keeping the entry's expiry; if the key has opened a new session meanwhile, the entry is dropped instead)
   and is dropped after any other outcome; a request the cache would refuse is judged again on a fresh read, so a
   counter advanced or a session replaced in another isolate never gets a valid request refused. A fresh read keeps
   a higher cached `used` for the same session (a lagging node can't reopen a replay window) until the entry's
   expiry, at most 10 s. A second request for the same session counter waits in this isolate until the first is done,
   then is judged on its outcome.

`GET /v1/app` runs checks 1–2 and a per-IP limit of its own (the plan's `per_ip_minute`, separate window), never the
app's relay quota. `google` is `own` with the scope's first Google client (or the app's `google_web_client_id`, set
with `admin app:settings --google-web-client`; `409 no_google_client` if it is no longer one of the scope's
clients), else `shared` with the first shared client
in force when the scope has `allow_shared`, else `409 no_google_client` (`409 scope_not_registered` when the scope is
not on chain, `502 near_unavailable` when the registry can't be read).

Relay errors: `422 contract_rejected` (contract panic text in `error`), `502 near_rejected` (the node refused the tx
as invalid: it never executed) / `near_error` / `near_unavailable` / `bad_contract_result` (it executed, but the
result isn't the shape the endpoint returns), `503 relayer_busy` / `relayer_unavailable` / `relayer_unconfigured` (the
pool's secret is missing or empty: nothing sent), `504 timeout`. Any other broadcast failure (dropped connection, non-JSON 5xx from a proxy) may still execute, so the
tx hash is polled; transient errors while polling don't end the wait. Usage: one event per request past the gate to
the Neon ledger, after the response (`src/usage/`, `docs/api.md` "Usage capture"); the D1 `usage` counters are no
longer written.

CORS: responses echo `Origin` (with `Vary: Origin`) only when it is allowed for the request's app. Preflight carries no
key, so `OPTIONS` succeeds when any active app allows the origin; the real request is then checked against its own app.

### Origins (`src/origins.ts`)

- **Hana pages.** `Origin` = `VAULT_ORIGIN` or `AUTH_ORIGIN`, each only where it calls: `GET /v1/app` and
  `/v1/login` both; `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` the vault only. The request acts for
  `x-hana-parent-origin`, which must be one of the app's origins. CORS echoes the Hana origin (also when the parent is
  refused, so the page can read why).
- **Partner pages.** `Origin` exactly equals one of the app's origins in force (`app_origins.active_from <= now`; a
  pending origin, `active_from` NULL or in the future, never matches): `GET /v1/app` for both key types in every env;
  `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only for apps on a test scope in dev envs (`apps/smoke`);
  nothing else.
- **Loopback** origins (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), and `http://localhost:<port>` through the
  entry `http://localhost:*`, count only for apps on a test scope (`scopes.environment`, the scope of every `pk_test_`
  key) in dev envs (`ENV_NAME` starting with `local` or `sandbox`), for partner origins and parent origins alike.
- Preflight carries no key: it allows the two Hana origins, and any origin in force for an active, undeleted app
  (loopback only through a test-scope app in a dev env). Allowed headers: `content-type`, `x-hana-key`,
  `x-hana-parent-origin`, `x-hana-relay-key`.
- The key comes from `app_keys` (revoked: `401 unknown_app`), the suspension from `suspended_by` and `status`, and test
  and live apps never share a scope (migration 0006's `scopes` and triggers; `docs/api.md` "The app gate").

### `POST /v1/login` (`src/login.ts`)

One transaction per login. Checks, in order: the gate (checks 1–3, `relay` quota); the body (`400 bad_request`); the
token as for `/v1/sessions`, plus the claim allow-list (`src/claims.ts`: only `iss azp aud sub iat exp nonce nbf jti
auth_time`; anything else is `400 token_has_pii` with `data: {claim}`) and the nonce; scope and `session_key_in_use`
side by side (`403 …`, `409 session_exists`); the signature over counter 1 (`401 invalid_signature`); pk1/pk2 each one
compressed, non-identity point (`400 invalid_app_key`); with `BLS_PRECHECK = "1"` (off everywhere, D64) the pairing
`e(pk1, −g2) · e(g1, pk2) = 1` (`400 invalid_app_key`; the same var gates it on `/v1/derive`). Failures map by the
failing receipt's executor: the signer → `422 contract_rejected` (with `reason: "session_key_in_use"` for that panic;
the session was not created), `MPC_ACCOUNT` → `422 ckd_failed` with `session: {used: 1}` (the session is committed),
else `502 near_error`; `504 timeout` and relayer errors keep their codes and `nearTx`. Usage: one `login` event
(relayed when the transaction can have executed; a uid on success). `/v1/sessions` applies the claim allow-list too once
`REJECT_PII_ON_SESSIONS = "1"`. From `AUTH_ORIGIN` (the export window, a key export) the call is also limited to 3 per
hour per `(app, sha256(path))`, counted right after the nonce check and before anything is relayed (`429 rate_limited`
+ `retry-after`, `503 rate_limiter_unavailable`; D59).

### `/v1/login-relay/<relayId>` (`src/login-relay.ts`, Durable Object `LoginRelay`)

How the login callback page hands the (end-to-end encrypted) Google token to the vault. No `x-hana-key`; per IP, 10
writes and 120 reads per minute. `relayId` is 43 base64url characters (`400 bad_relay_id`).

- `POST` (`AUTH_ORIGIN` only) `{iv, ct}` base64url (12-byte iv, ≤ 8 KiB body, else `413`): `204`, or
  `409 relay_used` if the slot was ever written.
- `GET ?wait=1..25` (`VAULT_ORIGIN`, `AUTH_ORIGIN`) with `x-hana-relay-key` (b64url of the 32-byte read key; the
  object checks `b64url(sha256(key)) === relayId` first, else `403 relay_forbidden` without consuming): `200 {iv, ct,
  serverTimeMs}` and the slot becomes a tombstone; `204` while still empty after `wait` seconds (the long poll returns
  on the write); `410 relay_gone` once read or expired.
- 120 s after the write the value is deleted and a tombstone kept for 120 s more, then nothing. Only ciphertext the API
  can't decrypt is stored; bodies, keys and relay ids are never logged.

### Vault page: `GET {VAULT_ORIGIN}/vault?pk=<publishable key>`

Served only on the vault origin (the request URL's origin must equal `VAULT_ORIGIN`; 404 elsewhere). The two Hana
origins get nothing else from this Worker: any other path (or method) whose URL origin is `VAULT_ORIGIN` or
`AUTH_ORIGIN`, `/v1/*` included, is a `404` with `frame-ancestors 'none'`, `nosniff` and no CORS, so the vault origin is
never the API. Rendered per
request from D1 only (no chain RPC): a non-executable `<script type="application/json" id="hana-config">` with
`{v:1, appId, appName, scopeId, origins, settings:{persistence, sessionTtlMs, idleTtlMs, rawSign, autoApprovePolicy},
publishableKey, serverTimeMs}` (JSON with `<`, `>`, `&`, U+2028, U+2029 escaped; no `signer`), then
`<script type="module" src="/vault.js">` (the `@hana-id/web` bundle, a static asset). `rawSign` and
`autoApprovePolicy` use their pending values only from `raw_sign_effective_at` / `auto_approve_effective_at`.
Headers: `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none';
form-action 'none'; frame-ancestors <app origins>; connect-src <API_URL> <NEAR_RPC> [<NEAR_RPC_FALLBACK>] https://www.googleapis.com`,
`Cross-Origin-Resource-Policy: cross-origin`, `Cache-Control: no-store`, `Referrer-Policy: no-referrer`,
`X-Content-Type-Options: nosniff`. Origins: loopback ones (and `http://localhost:*`) only for `pk_test_` keys in
`local*`/`sandbox*` envs; anything that isn't a bare lowercase http(s) origin is dropped; more than 20 → 403. 403 (no
config script, `frame-ancestors 'none'`) for an unknown, suspended or scope-conflicting app; 503 when D1 fails or
`API_URL`, `NEAR_RPC` or a set `NEAR_RPC_FALLBACK` is not a URL.

### Page Workers (`src/pages/`, `wrangler.vault.jsonc`, `wrangler.auth.jsonc`)

In every env each Hana origin is a thin Worker of its own, with only that origin's built pages as its static assets
(on `workers.dev` in dev envs, a Custom Domain elsewhere; D66). This differs from `docs/batch-b-spec.md`, which has the
API Worker serve both origins through its own routes and an assets binding outside sandbox-dev: one Worker per origin
means neither origin can serve the other's files, and the API Worker never holds page assets. `gen` writes both
configs from the manifest (`scripts/pages-wrangler.ts`):

| | Vault Worker | Auth Worker |
|---|---|---|
| Serves | `GET`/`HEAD /vault` → this Worker through the `API` service binding, request unchanged (so it is rendered above, with the vault origin in its URL); any other path: a static asset (`/vault.js`) | `/login`, `/login/callback`, `/approve`, `/export` from `<path>.html`, with each page's CSP (`connect-src <API_URL>` on login and callback, none on approve, `<API_URL> <NEAR_RPC> [<NEAR_RPC_FALLBACK>] https://www.googleapis.com` on export), `frame-ancestors 'none'`, `no-store`, `no-referrer`, `nosniff` and no COOP; any other path: a static asset |
| Assets | `packages/web/dist/pages/<env>/vault` | `packages/web/dist/pages/<env>/auth` |
| Vars | `VAULT_ORIGIN` | `AUTH_ORIGIN`, `API_URL`, `NEAR_RPC`, `NEAR_RPC_FALLBACK` (only when the manifest sets `rpcFallback`) |

Both answer only on their own origin (404 on any other host), only `GET`/`HEAD` (405), never serve an HTML file under
its own name (404; pages exist only on their routes, with their headers), and add
`content-security-policy: default-src 'none'; frame-ancestors 'none'; sandbox` (an SVG or XML asset opened as a
document runs, loads and frames nothing; browsers don't apply it to the scripts and styles the pages load), `nosniff`,
`no-referrer` and a same-origin CORP to every asset. No other path reaches the API, so `{vaultOrigin}/v1/*` is not the API. A missing page file
or an unreachable API gives 503 with no config script. Neither sets a cookie: a `Set-Cookie` from a binding is
dropped (`withoutCookies`, D70). Placement follows the origin: `<worker>.<subdomain>.workers.dev`
→ a `workers.dev` Worker named `<worker>` (dev envs only; same subdomain as a `workers.dev` `apiUrl`, since the service
binding needs one account), any other hostname → a Custom Domain on `<API worker>-vault`/`-auth`, loopback (`local*`
envs) → `wrangler dev` on that host and port. Preview URLs are off.

Deploy (testnet only), after this Worker, since the vault Worker binds to it:

```sh
pnpm --filter @hana-id/web build                 # writes packages/web/dist/pages/<env>/{vault,auth}
pnpm --filter @hana-id/api gen <env> --d1-id <id> # also writes wrangler.vault.jsonc and wrangler.auth.jsonc
pnpm --filter @hana-id/api run deploy:pages       # wrangler deploy -c wrangler.vault.jsonc, then -c wrangler.auth.jsonc
```

Locally, only for a `local*` env (loopback `vaultOrigin`/`authOrigin`; none is in `envs/` today, `apps/e2e` runs its
own stack): run each Worker in its own process, `pnpm --dir apps/api exec wrangler dev` (the API, on `apiUrl`'s
port), then `… wrangler dev -c wrangler.vault.jsonc` and `… wrangler dev -c wrangler.auth.jsonc` in other terminals;
they find each other through wrangler's dev registry. One `wrangler dev -c a -c b` doesn't work: only its first config
is reachable over HTTP, so the vault page couldn't call `{apiUrl}/v1/*`. With a sandbox env's configs the request URL
is the local host, not the configured origin, so every page answers 404.

### Vault endpoints: `Origin: VAULT_ORIGIN` + `x-hana-key` + `x-hana-parent-origin`

Spec: `docs/batch-b-spec.md` ("Share creation", "Unlock", "Logout and lost device", "Vault endpoints"). Signatures are
Ed25519 by the session key over `utf8("hana-id-vault-v1:") ‖ borsh(signer) ‖ borsh(appId) ‖ shareId(16) ‖
u64le(counter) ‖ sha256(payload)` with the gate app's D1 id (`src/vault/message.ts`).

| Endpoint | Body | 2xx |
|---|---|---|
| `POST /v1/vault/shares` | `{sessionPublicKey[32], signature[64]}` (share id 0×16, counter 0, payload `"share" ‖ borsh(parentOrigin)`) | 201 `{shareId[16], ks[32], absExpiresAtMs, idleUntilMs}` |
| `POST /v1/vault/unlock` | `{shareId[16], counter, signature[64]}` (payload `"unlock"`) | `{ks[32], counter, idleUntilMs, absExpiresAtMs}` |
| `POST /v1/vault/touch` | same (payload `"touch"`) | `{counter, idleUntilMs}` |
| `POST /v1/vault/revoke` | same (payload `"revoke"`) | `{revoked: true}` |
| `POST /v1/vault/revoke-all` | same (payload `"revoke-all"`); the share must be < 5 min old (`403 share_not_fresh`) | `{revoked: <other live shares of the same (app, path) revoked>}` |

Gate: key and app (`401 missing_key`/`unknown_app`, `403 app_suspended`), `Origin` is `VAULT_ORIGIN` and the parent is
allowed for the app (`403 origin_not_allowed`; loopback only for `pk_test_` in `local*`/`sandbox*` envs), no live app on
a test app's scope (`403 scope_conflict`), then the vault's own limits, never the relay counters: 60 per IP per app
per minute, 10 × the plan's `per_minute` per app, and 10 per share per minute (per IP and per share: Rate Limiting
bindings, counted per location and approximate; per app: the exact `RateLimiter` object; D95). Shares: `409 persistence_off`, `401
invalid_signature`, then `get_session` straight from the node (re-read every 300 ms for up to 2 s while missing or not
used up): `404 unknown_session`, `403 scope_mismatch`, `409 session_not_spent`, `502 near_unavailable`; then
`409 share_exists`. Share actions: `404 unknown_share` (missing, or another app's), `410 share_revoked` (also when the
share's origin was removed from the app, which revokes it). Unlock and touch then follow the app's settings as they
are now: `persistence = 'none'` revokes the share (`410 share_revoked`), and a share never outlives `created_at` + the
current `session_ttl_ms` (a lowered TTL shortens live shares and lowers their stored expiry, `410 share_expired`; a
raised one never lengthens them). Then `401 invalid_signature`, then one atomic counter update that re-checks those
settings in the same statement: `409 bad_counter {expected}`, `410 share_expired`. `revoke-all` revokes the other
shares and moves its counter in one D1 batch (one transaction), the revoke conditional on the counter move, so a
failure changes neither and a replay revokes nothing. `503 vault_key_unavailable` when `VAULT_KEK` (or, for an older row,
`VAULT_KEK_PREVIOUS`) is missing; unlock unwraps K_s before the counter moves. Each unlock past the vault gate is one `unlock` usage event. D1 holds
only `share_enc = iv ‖ AES-GCM(VAULT_KEK, iv, K_s, aad = share_id ‖ app_id ‖ session_pk)` (`src/vault/kek.ts`).

### `POST /v1/owner-actions` (no app auth; 10 per IP per minute, 20 per minute and 200 per day globally)

`{"method": …, "args": {…}}` with `args` exactly as the contract takes them. Only:

- `propose_change {scope_id, auth, change, client_proof?}` (`client_proof` required for `AddClient`, must be absent/null
  for `SetOwners`; sent as `null` when absent)
- `cancel_change {scope_id, auth, change_id}`
- `remove_client {scope_id, auth, provider, aud}`
- `disable_shared_login {scope_id, auth}`
- `execute_change {scope_id, change_id}`

`change` is `AddClient`, `SetOwners` or `{"SetAllowShared":{"allow":true}}` (enabling shared login is timelocked;
disabling is `disable_shared_login`). Relayed with the owner pool (`OWNER_RELAYER_KEYS`) only.

`auth` must be `{"Oidc":{"jwt":"…"}}` (`"Near"` would make the relayer the predecessor). Unknown keys anywhere are
rejected. CORS is `*`: the endpoint has no credentials, the proof is in the args (the console's origin is not known
yet).

Every relayed tx is paid from the owner pool's allowance (separate from logins) even when the contract rejects it, so
the API relays only requests that would plausibly succeed. Checked off-chain first (the contract re-checks everything,
including the nonces):

- `auth` token: RS256 signature against the issuer's JWKS (Google's, cached per its `max-age`), issuer, expiry
  (`401 invalid_token` / `token_expired`, `400 unsupported_issuer`, `503 issuer_keys_unavailable` when the JWKS can't
  be fetched); `(provider, aud)` ∈ `get_config().console_audiences` (cached 60 s; `403 not_console_token`); the token
  has not been relayed before (a token is bound to one action by its nonce; `409 token_used`). The token is reserved
  atomically in a Durable Object before relaying, so concurrent copies can't all pass; the reservation is released
  only when the request is turned away by the global cap or the transaction certainly never executed
  (`method_not_allowed`, `relayer_unconfigured`, `near_unavailable`, `near_rejected`, `relayer_busy`), and kept on
  an unknown outcome (`relayer_unavailable`, `near_error`, `timeout`, a contract rejection).
- `get_scope(scope_id)` (cached 10 s, dropped after each relayed action): exists (`404 unknown_scope`); the token's
  `(provider, sub)` is an `Oidc` owner (`403 not_owner`).
- `cancel_change` / `execute_change`: the change is pending (`404 unknown_change`); `execute_change`: unlocked
  (`409 change_locked`). `remove_client`: the client is in the scope (`404 unknown_client`) and not the last one unless the scope
  has `allow_shared` (`409 last_client`). `disable_shared_login`: shared login is on (`409 shared_login_disabled`) and
  the scope has a client of its own (`409 last_client`). `propose_change(AddClient)`: `client_proof` is a genuine token
  for that `(provider, aud)` (`400 invalid_client_proof`), not already in the scope (`409 client_registered`), not a
  shared or pending shared client (`409 shared_client`). `propose_change(SetAllowShared)`: not already on
  (`409 shared_login_enabled`).
- Then the global cap (only requests that passed the checks count).

### `GET /v1/health`

`{"ok": true, "env", "signer"}`.

### `GET /v1/governance`

Read-only governance snapshot (`src/governance-status.ts`, `docs/api.md`): pause state, delays, pending issuer-key
changes with `executableAtMs` and Google's JWKS verdict, watchdogs, updater keys against the signer's access keys,
pending upgrade / owner / withdrawal / console audiences, the JWKS cron's last run. Public, cached 10 s per isolate;
the source batch C's admin portal reads for the contract side of "Security & monitoring".

## Relayer keys and nonces

Two pools (`src/relayer-config.ts`), each with a strict method allowlist enforced by `relay()` and again inside the
Durable Object: the session pool (`RELAYER_KEYS`, objects `relayer-key-<index>`) and the owner pool
(`OWNER_RELAYER_KEYS`, objects `owner-relayer-key-<index>`). Abuse of `/v1/owner-actions` can only drain the owner
pool, never stop logins. `relayer-pool.ts` picks a key of the pool round-robin and calls its `RelayerKey` Durable
Object; an object serves one pool and key only.
Inside the object a promise-chain mutex covers only *next nonce → sign → reserve → dispatch `send_tx`*; the outcome
(`send_tx` / `tx` with `wait_until: EXECUTED_OPTIMISTIC`, `tx` polled every 400 ms for up to 60 s) is awaited outside
it, so many transactions per key are in flight. Nonces are reserved in blocks of 100 (`NONCE_RESERVATION`): storage
holds a reservation R ("no tx of this key was ever sent above R"), and a nonce above R first writes R + 100 − 1 and
waits for the write to be confirmed, so one relay in 100 waits for storage. A cold start (objects are evicted after
~10 s idle) trusts the stored reservation for this key's public key with no chain read (skipping up to 99 nonces) and
reuses the stored block hash while it is under 5 min old; only a key with no stored reservation (new, or a replaced
secret at that index) reads the access-key nonce and a final block from chain. On `InvalidNonce` the object re-reads
the access key (`max(local, chain, ak_nonce from the error)`) and retries once; an expired block hash is refreshed and
retried once; a tx superseded twice 2 s apart while unknown is treated as dropped and resent once with a fresh nonce. The object only relays its pool's methods, always to `SIGNER_ACCOUNT`, no deposit, with
per-method gas from `src/gas.ts` (never the caller's): `create_session` 50 Tgas, `create_session_and_derive` 100,
`derive_key` 60, `revoke_session` 20, `prune_sessions` 50, owner-pool methods 50 except `register_scope`, which
verifies one RS256 client proof per client: 30 + 25 per proof, capped at 300 (280 for the contract's 10). **To
measure on testnet**; override with `GAS_<METHOD>_TGAS`.

## Logging

One JSON line per request (`requestId`, `appId`, `endpoint`, `outcome`, `status`, `code`, `latencyMs`, `nearTx`, plus
`phases` (ms per stage: `app`, `limits`, `checks`, `session`, `relay` and its `relayDispatch` / `relayQueue` /
`relayChainRead` / `relaySign` / `relayPersist` / `relayOutcome` split), `colo` (the data center) and, for relays,
`relayInstance` (`{cold, coldChainRead, blockRefresh, served, ageMs}` of the relayer key object)) plus relay, vault and
cron events; field meanings in `docs/api.md` "Logs". The logger only accepts those typed fields: never JWTs,
signatures, bodies, keys, CKD responses or contract panic text. A login relay request is always logged as
`/v1/login-relay`, without its relayId (it is also the OAuth `state`), the top-level error line included.

## Notes

- `src/shims/secp256k1.ts`: `@near-js/crypto` imports the CommonJS/native `secp256k1` package at load time, which
  doesn't run in workerd; relayer keys are ed25519, so it is aliased to a stub (wrangler `alias`, vitest
  `resolve.alias`).
- `plans.per_ip_minute` (default 20) extends the spec's `plans(id, per_minute, per_day)` so the per-IP limit also comes
  from the plan row. Seeded `free` plan: 60/min, 5000/day, 20/min per IP.
