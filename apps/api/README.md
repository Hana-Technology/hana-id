# @hana-id/api

Cloudflare Worker that relays `hana-signer` calls for registered apps: it pays the gas, checks the app (publishable
key, origin, plan limits, scope) before anything reaches the chain, and keeps relayer nonces in order with one
Durable Object per relayer key. Spec: `docs/batch-a-spec.md` (API section); contract: `docs/contract-interface.md`.

## Commands

```sh
pnpm --filter @hana-id/api gen sandbox-dev [--d1-id <uuid>] [--dev-vars]  # wrangler.jsonc (+ .dev.vars) from envs/<env>.json
pnpm --filter @hana-id/api test        # vitest in workerd (@cloudflare/vitest-plugin), NEAR RPC mocked; then scripts/ tests in Node
pnpm --filter @hana-id/api typecheck
pnpm --filter @hana-id/api dev         # wrangler dev (local D1: `wrangler d1 migrations apply DB --local` first)
```

`wrangler.jsonc` is generated: change `envs/<env>.json` or `scripts/gen-wrangler.ts`, not the file. Without `--d1-id`
the id already in the file is kept only if that file was generated for the same D1 database (`database_name`), else a
local-only placeholder is written. `--dev-vars` writes `RELAYER_KEYS` single-quoted (wrangler's dotenv parser takes it
literally).

Deploy (testnet only): `wrangler d1 create <cloudflare.d1Name>` → `gen <env> --d1-id <id>` →
`wrangler d1 migrations apply DB --remote` → `wrangler secret put RELAYER_KEYS` (JSON array of `ed25519:` secret
keys, e.g. the content of `.secrets/<env>/relayer-keys.json`) → `wrangler secret put KEYS_UPDATER_KEY` → `wrangler deploy`.

## Config

| Name | Kind | |
|---|---|---|
| `NEAR_RPC`, `SIGNER_ACCOUNT`, `RELAYER_ACCOUNT`, `ENV_NAME` | vars (manifest) | `rpc`, `signer`, `relayer`, `name` |
| `RELAYER_KEYS` | secret | JSON array of function-call keys on `RELAYER_ACCOUNT` (receiver `SIGNER_ACCOUNT`) |
| `KEYS_UPDATER_KEY` | secret | function-call key on `SIGNER_ACCOUNT` (`set_issuer_key`, `remove_issuer_key`); cron skips without it |
| `DB` | D1 | `migrations/` |
| `RELAYER_KEY`, `RATE_LIMITER` | Durable Objects | SQLite-backed classes `RelayerKey`, `RateLimiter` |
| cron `0 * * * *` | trigger | Google JWKS → `set_issuer_key` / `remove_issuer_key` (a kid is removed only after it has been missing from the JWKS for ≥ 55 min, i.e. two hourly runs in a row; tracked in D1 `issuer_key_missing`) |

## Endpoints

All JSON. Success: `{"result": …, "nearTx": "<base58 tx hash>", "requestId": "…"}`. Error:
`{"error": "<message>", "code": "<code>", "nearTx"?: "…", "requestId": "…"}`. Every response has `x-request-id`.

### App endpoints: `x-hana-key: pk_test_…` + an allowed `Origin`

| Endpoint | Body (camelCase, byte arrays as JSON number arrays) | Contract call → `result` |
|---|---|---|
| `POST /v1/sessions` | `{jwt, sessionPublicKey[32], expiresAtMs, salt[16..64], keyIndex (u32), maxUses (1..500)}` | `create_session` → Session `{path, scope_id, expires_at_ms, max_uses, used}` |
| `POST /v1/derive` | `{sessionPublicKey[32], counter, signature[64], pk1 "bls12381g1:…", pk2 "bls12381g2:…"}` | `derive_key` → `{big_y, big_c}` |
| `POST /v1/sessions/revoke` | `{sessionPublicKey[32], counter, signature[64]}` | `revoke_session` → `null` |

Checks, in order (rejected before anything is relayed):

1. Key present and known (`401 missing_key` / `unknown_app`), app `active` (`403 app_suspended`).
2. `Origin` exactly equals one of the app's `app_origins` (`403 origin_not_allowed`). The entry
   `http://localhost:*` allows any `http://localhost:<port>`, and loopback origins are honoured only for `pk_test_`
   keys.
3. Rate limits from the app's plan: per client IP (per app) per minute first, then per app per minute and per UTC day
   (`429 rate_limited` + `retry-after`). The IP check runs first so requests it rejects never use up the app's shared
   quota. "Client IP" is the IPv4 address, or the IPv6 /64 prefix (a host can rotate addresses inside its /64).
4. Body shape (`400 bad_request`, `413` over 16 KiB).
5. Scope: `/v1/sessions` decodes (does not verify; the contract does) the token, maps `iss` → provider
   (`400 unsupported_issuer`, `400 token_expired`) and requires `scope_for_client(provider, aud)` (cached 60 s) to equal
   the app's `scope_id` (`403 unregistered_client` / `scope_mismatch`). Derive/revoke require `get_session` (cached
   10 s, misses not cached) to exist, be unexpired (`404 unknown_session`) and belong to the app's scope
   (`403 scope_mismatch`).

Relay errors: `422 contract_rejected` (contract panic text in `error`), `502 near_rejected` (the node refused the tx
as invalid: it never executed) / `near_error` / `near_unavailable`, `503 relayer_busy` / `relayer_unavailable`,
`504 timeout`. Any other broadcast failure (dropped connection, non-JSON 5xx from a proxy) may still execute, so the
tx hash is polled; transient errors while polling don't end the wait. Usage (`usage.sessions` /
`usage.derives`, per app per UTC day) counts successful calls only.

CORS: responses echo `Origin` (with `Vary: Origin`) only when it is allowed for the request's app. Preflight carries no
key, so `OPTIONS` succeeds when any active app allows the origin; the real request is then checked against its own app.

### `POST /v1/owner-actions` (no app auth; 10 per IP per minute, 20 per minute and 200 per day globally)

`{"method": …, "args": {…}}` with `args` exactly as the contract takes them. Only:

- `propose_change {scope_id, auth, change, client_proof?}` (`client_proof` required for `AddClient`, must be absent/null
  for `SetOwners`; sent as `null` when absent)
- `cancel_change {scope_id, auth, change_id}`
- `remove_client {scope_id, auth, provider, aud}`
- `execute_change {scope_id, change_id}`

`auth` must be `{"Oidc":{"jwt":"…"}}` (`"Near"` would make the relayer the predecessor). Unknown keys anywhere are
rejected. CORS is `*`: the endpoint has no credentials, the proof is in the args (the console's origin is not known
yet).

Every relayed tx is paid from the relayer allowance (shared with logins) even when the contract rejects it, so the
API relays only requests that would plausibly succeed. Checked off-chain first (the contract re-checks everything,
including the nonces):

- `auth` token: RS256 signature against the issuer's JWKS (Google's, cached per its `max-age`), issuer, expiry
  (`401 invalid_token` / `token_expired`, `400 unsupported_issuer`, `503 issuer_keys_unavailable` when the JWKS can't
  be fetched); `(provider, aud)` ∈ `get_config().console_audiences` (cached 60 s; `403 not_console_token`); the token
  has not been relayed before (a token is bound to one action by its nonce; `409 token_used`).
- `get_scope(scope_id)` (cached 10 s, dropped after each relayed action): exists (`404 unknown_scope`); the token's
  `(provider, sub)` is an `Oidc` owner (`403 not_owner`).
- `cancel_change` / `execute_change`: the change is pending (`404 unknown_change`); `execute_change`: unlocked
  (`409 change_locked`). `remove_client`: the client is in the scope (`404 unknown_client`) and not the last one
  (`409 last_client`). `propose_change(AddClient)`: `client_proof` is a genuine token for that `(provider, aud)`
  (`400 invalid_client_proof`), not already in the scope (`409 client_registered`).
- Then the global cap (only requests that passed the checks count).

### `GET /v1/health`

`{"ok": true, "env", "signer"}`.

## Relayer keys and nonces

`relayer-pool.ts` picks a key round-robin and calls the `RelayerKey` Durable Object named `relayer-key-<index>`.
Inside the object a promise-chain mutex covers only *next nonce → sign → dispatch `send_tx`*; the outcome
(`send_tx` / `tx` with `wait_until: EXECUTED`, polled up to 60 s like the legacy relayer) is awaited outside it, so many
transactions per key are in flight. The nonce is kept in memory and in DO storage; on cold start it is
`max(stored, chain)` (transactions still in the pool aren't in the chain's nonce yet). On `InvalidNonce` the object
re-reads the access key (`max(local, chain, ak_nonce from the error)`) and retries once; an expired block hash is
refreshed and retried once. The object only relays the methods above, always to `SIGNER_ACCOUNT`, 300 Tgas, no deposit.

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
