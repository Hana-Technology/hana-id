# @hana-id/api

Cloudflare Worker that relays `hana-signer` calls for registered apps: it pays the gas, checks the app (publishable
key, origin, plan limits, scope) before anything reaches the chain, and keeps relayer nonces in order with one
Durable Object per relayer key. Spec: `docs/batch-a-spec.md` (API section) as amended by
`docs/batch-a2-shared-client.md` and `docs/batch-b-spec.md` (API changes); contract: `docs/contract-interface.md`.

## Commands

```sh
pnpm --filter @hana-id/api gen sandbox-dev [--d1-id <uuid>] [--dev-vars]  # wrangler.jsonc (+ .dev.vars) from envs/<env>.json
pnpm --filter @hana-id/api test        # vitest in workerd (@cloudflare/vitest-plugin), NEAR RPC mocked; then scripts/ tests in Node
pnpm --filter @hana-id/api typecheck
pnpm --filter @hana-id/api dev         # wrangler dev (local D1: `wrangler d1 migrations apply DB --local` first)
```

`wrangler.jsonc` is generated: change `envs/<env>.json` or `scripts/gen-wrangler.ts`, not the file. Without `--d1-id`
the id already in the file is kept only if that file was generated for the same D1 database (`database_name`), else a
local-only placeholder is written. `--dev-vars` writes `RELAYER_KEYS` (from `.secrets/<env>/relayer-keys.json`) and
`OWNER_RELAYER_KEYS` (from `.secrets/<env>/owner-relayer-keys.json`) single-quoted (wrangler's dotenv parser takes them
literally), plus `KEYS_UPDATER_KEY`; files that don't exist are skipped.

Deploy (testnet only): `wrangler d1 create <cloudflare.d1Name>` → `gen <env> --d1-id <id>` →
`wrangler d1 migrations apply DB --remote` → `wrangler secret put RELAYER_KEYS` (JSON array of `ed25519:` secret
keys, e.g. the content of `.secrets/<env>/relayer-keys.json`) → `wrangler secret put OWNER_RELAYER_KEYS` (same format,
`.secrets/<env>/owner-relayer-keys.json`) → `wrangler secret put KEYS_UPDATER_KEY` → `wrangler deploy`.

## Config

| Name | Kind | |
|---|---|---|
| `NEAR_RPC`, `SIGNER_ACCOUNT`, `RELAYER_ACCOUNT`, `ENV_NAME`, `MPC_ACCOUNT` | vars (manifest) | `rpc`, `signer`, `relayer`, `name`, `mpc`. `ENV_NAME` `local*`/`sandbox*` is a dev env (see Origins) |
| `VAULT_ORIGIN`, `AUTH_ORIGIN` | vars (manifest) | `vaultOrigin`, `authOrigin`; `gen` refuses an env without them |
| `BLS_PRECHECK`, `REJECT_PII_ON_SESSIONS` | vars | `"0"` everywhere until their step in `docs/batch-b-spec.md` ("Order of work") |
| `RELAYER_KEYS` | secret | Session pool: JSON array of function-call keys on `RELAYER_ACCOUNT` (receiver `SIGNER_ACCOUNT`; `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session`, `prune_sessions`) |
| `OWNER_RELAYER_KEYS` | secret | Owner pool (small allowance), same format: `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config`. Without it `/v1/owner-actions` answers 503 and logins are unaffected |
| `GAS_<METHOD>_TGAS` | optional vars | Per-method gas override in Tgas (integer 1..300), e.g. `GAS_DERIVE_KEY_TGAS=80`; invalid values are ignored (logged) |
| `KEYS_UPDATER_KEY` | secret | function-call key on `SIGNER_ACCOUNT` (`set_issuer_key`, `remove_issuer_key`); cron skips without it |
| `DB` | D1 | `migrations/` |
| `RELAYER_KEY`, `RATE_LIMITER`, `LOGIN_RELAY` | Durable Objects | SQLite-backed classes `RelayerKey`, `RateLimiter` (migration `v1`), `LoginRelay` (`v2`) |
| cron `0 * * * *` | trigger | Google JWKS → `set_issuer_key` / `remove_issuer_key` (a kid is removed only after it has been missing from the JWKS for ≥ 55 min, i.e. two hourly runs in a row; tracked in D1 `issuer_key_missing`) |

## Endpoints

All JSON. Success: `{"result": …, "nearTx": "<base58 tx hash>", "requestId": "…"}`. Error:
`{"error": "<message>", "code": "<code>", "nearTx"?: "…", "requestId": "…"}`. Every response has `x-request-id`.

### App endpoints: `x-hana-key: pk_…` + an allowed caller (see Origins)

| Endpoint | Body (camelCase, byte arrays as JSON number arrays) | Contract call → `result` |
|---|---|---|
| `GET /v1/app` | — | none → `{name, scopeId, signer, google: {clientId, mode: "own" \| "shared"}, serverTimeMs, requestId}` (top level, no `result`) |
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
app's relay quota. `google` is `own` with the scope's first Google client, else `shared` with the first shared client
in force when the scope has `allow_shared`, else `409 no_google_client` (`409 scope_not_registered` when the scope is
not on chain, `502 near_unavailable` when the registry can't be read).

Relay errors: `422 contract_rejected` (contract panic text in `error`), `502 near_rejected` (the node refused the tx
as invalid: it never executed) / `near_error` / `near_unavailable`, `503 relayer_busy` / `relayer_unavailable`,
`504 timeout`. Any other broadcast failure (dropped connection, non-JSON 5xx from a proxy) may still execute, so the
tx hash is polled; transient errors while polling don't end the wait. Usage (`usage.sessions` /
`usage.derives`, per app per UTC day) counts successful calls only.

CORS: responses echo `Origin` (with `Vary: Origin`) only when it is allowed for the request's app. Preflight carries no
key, so `OPTIONS` succeeds when any active app allows the origin; the real request is then checked against its own app.

### Origins (`src/origins.ts`)

- **Hana pages.** `Origin` = `VAULT_ORIGIN` or `AUTH_ORIGIN`, each only where it calls: `GET /v1/app` and
  `/v1/login` both; `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` the vault only. The request acts for
  `x-hana-parent-origin`, which must be one of the app's origins. CORS echoes the Hana origin (also when the parent is
  refused, so the page can read why).
- **Partner pages.** `Origin` exactly equals one of the app's `app_origins`: `GET /v1/app` for both key types in every
  env; `/v1/sessions`, `/v1/derive`, `/v1/sessions/revoke` only with `pk_test_` keys in dev envs (`apps/smoke`);
  nothing else.
- **Loopback** origins (`localhost`, `*.localhost`, `127.0.0.0/8`, `[::1]`), and `http://localhost:<port>` through the
  entry `http://localhost:*`, count only for `pk_test_` keys in dev envs (`ENV_NAME` starting with `local` or
  `sandbox`), for partner origins and parent origins alike.
- Preflight carries no key: it allows the two Hana origins, and any origin an active app allows (loopback only through
  a `pk_test_` app in a dev env). Allowed headers: `content-type`, `x-hana-key`, `x-hana-parent-origin`,
  `x-hana-relay-key`.
- `admin app:create` refuses a scope already used by an app with the other key type.

### `POST /v1/login` (`src/login.ts`)

One transaction per login. Checks, in order: the gate (checks 1–3, `relay` quota); the body (`400 bad_request`); the
token as for `/v1/sessions`, plus the claim allow-list (`src/claims.ts`: only `iss azp aud sub iat exp nonce nbf jti
auth_time`; anything else is `400 token_has_pii` with `data: {claim}`) and the nonce; scope and `session_key_in_use`
side by side (`403 …`, `409 session_exists`); the signature over counter 1 (`401 invalid_signature`); pk1/pk2 each one
compressed, non-identity point (`400 invalid_app_key`); with `BLS_PRECHECK = "1"` the pairing
`e(pk1, −g2) · e(g1, pk2) = 1` (`400 invalid_app_key`; the same var gates it on `/v1/derive`). Failures map by the
failing receipt's executor: the signer → `422 contract_rejected` (with `reason: "session_key_in_use"` for that panic;
the session was not created), `MPC_ACCOUNT` → `422 ckd_failed` with `session: {used: 1}` (the session is committed),
else `502 near_error`; `504 timeout` and relayer errors keep their codes and `nearTx`. Usage: `sessions` and `derives`
on success, `sessions` only on `ckd_failed`. `/v1/sessions` applies the claim allow-list too once
`REJECT_PII_ON_SESSIONS = "1"`.

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
  (`near_rejected`, `relayer_busy`, a dispatch failure), and kept on an unknown outcome.
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

## Relayer keys and nonces

Two pools (`src/relayer-config.ts`), each with a strict method allowlist enforced by `relay()` and again inside the
Durable Object: the session pool (`RELAYER_KEYS`, objects `relayer-key-<index>`) and the owner pool
(`OWNER_RELAYER_KEYS`, objects `owner-relayer-key-<index>`). Abuse of `/v1/owner-actions` can only drain the owner
pool, never stop logins. `relayer-pool.ts` picks a key of the pool round-robin and calls its `RelayerKey` Durable
Object; an object serves one pool and key only.
Inside the object a promise-chain mutex covers only *next nonce → sign → dispatch `send_tx`*; the outcome
(`send_tx` / `tx` with `wait_until: EXECUTED`, polled up to 60 s like the legacy relayer) is awaited outside it, so many
transactions per key are in flight. The nonce is kept in memory and in DO storage; on cold start it is
`max(stored, chain)` (transactions still in the pool aren't in the chain's nonce yet). On `InvalidNonce` the object
re-reads the access key (`max(local, chain, ak_nonce from the error)`) and retries once; an expired block hash is
refreshed and retried once. The object only relays its pool's methods, always to `SIGNER_ACCOUNT`, no deposit, with
per-method gas from `src/gas.ts` (never the caller's): `create_session` 50 Tgas, `create_session_and_derive` 100,
`derive_key` 60, `revoke_session` 20, `prune_sessions` 50, owner-pool methods 50 except `register_scope`, which
verifies one RS256 client proof per client: 30 + 25 per proof, capped at 300 (280 for the contract's 10). **To
measure on testnet**; override with `GAS_<METHOD>_TGAS`.

## Logging

One JSON line per request (`requestId`, `appId`, `endpoint`, `outcome`, `status`, `code`, `latencyMs`, `nearTx`) plus
relay/cron events. The logger only accepts those typed fields: never JWTs, signatures, bodies, keys, CKD responses or
contract panic text.

## Notes

- `src/shims/secp256k1.ts`: `@near-js/crypto` imports the CommonJS/native `secp256k1` package at load time, which
  doesn't run in workerd; relayer keys are ed25519, so it is aliased to a stub (wrangler `alias`, vitest
  `resolve.alias`).
- `plans.per_ip_minute` (default 20) extends the spec's `plans(id, per_minute, per_day)` so the per-IP limit also comes
  from the plan row. Seeded `free` plan: 60/min, 5000/day, 20/min per IP.
