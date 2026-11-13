# Batch A spec — isolation (contract + API + environments)

Source of truth for batch A. If code and this spec disagree, fix the code or raise it; don't silently diverge.
Plan doc: an internal planning document (not in this repository).

## Goal

A Google user's wallet key is derived only for the partner app (scope) whose Google client ID the token was issued
to, and only through a relayer that serves registered, active apps from allowed origins. Testnet only, throwaway
accounts, every account name configurable.

Done when:
- Two apps with different client IDs get different paths (so different keys) for the same Google user.
- A token whose `(issuer, aud)` is not registered is rejected by the contract, and earlier by the API.
- Concurrent requests never collide on relayer nonces.
- All tests pass: `cargo test` (contract), `pnpm -r test` (TS), wasm build succeeds.

## Decisions (made with the user, do not revisit)

- **CKD only.** Remove per-transaction MPC signing: `sign_with_session`, `sign`, `on_verified`, `sign_target`,
  envelopes, the NEAR Auth/FastAuth `router`, EVM/Stellar signing code and their constants/tests.
- **Key index in the path.** Path = `{scope_id}#{provider}#{sub}#{key_index}` (key_index u32, decimal). Users use 0;
  a higher index is a fresh wallet under the same login (rotation after a leak).
- **Registry lives inside `hana-signer`** as its own module (`src/registry.rs`), not a separate contract.
- **Owners can be a NEAR account or an OIDC (Google) identity.** Both supported in batch A.
- **Self-serve-ready, but closed for the PoC.** `public_registration` flag, default false, one-way (once true it can
  never be set false). While false, only the contract owner (Hana admin) may register scopes, and may do so without
  client proofs. Once true, everyone (admin included) must prove client ownership.
- **Hana cannot touch a scope's client IDs or owners** after registration, and cannot block key derivation for a
  scope. App suspension (abuse, billing) happens only in the API.
- **Off-chain app config** (publishable keys, origins, plans, quotas, suspension, usage) lives in Cloudflare D1.
- **API = Cloudflare Workers + Durable Objects.** One Durable Object per relayer access key serialises nonces.
- **Every account name comes from an environment manifest** (`envs/<env>.json`). Nothing hard-codes `*.testnet`
  names outside manifests and tests.
- Local git only, branch `develop`. Do not create remotes or push.

## Repo layout

```
contracts/hana-signer/   Rust contract (near-sdk 5.x), crate name hana-signer
apps/api/                Cloudflare Worker (TypeScript), wrangler, D1 migrations, vitest
packages/env/            Manifest schema (zod) + loader, shared by scripts and the API build
envs/                    sandbox-dev.json (+ README on adding envs)
scripts/                 deploy, keys, admin CLI (TypeScript via tsx), wrangler config generation
legacy/                  READ-ONLY reference: old browser client + Vercel relayer from wend-widget-demo
docs/                    this spec, context, contract interface
```

pnpm workspace at the root (`apps/*`, `packages/*`, `scripts`). Node 22, TypeScript strict, ESM.

## Contract

### Config (state, set at init, changeable only where stated)

| Field | Set by | Notes |
|---|---|---|
| `owner: AccountId` | `new` arg; `set_owner` (owner) | Hana admin. Not `current_account_id` by default. |
| `mpc: AccountId` | `new` arg | e.g. `v1.signer-prod.testnet` |
| `ckd_domain_id: u64` | `new` arg | 2 on current MPC |
| `console_audiences: Vec<(String provider, String aud)>` | owner | Client IDs of Hana's console, used for OIDC owner actions |
| `sponsors: Vec<AccountId>` | owner | Accounts whose registrations the contract pays storage for (the relayer) |
| `change_delay_ms: u64` | owner, bounded 0..=7 days | Timelock for adding client IDs and changing owners. Default 48 h. Dev envs may set it low. |
| `public_registration: bool` | owner, one-way false→true | |

Keep `MAX_SESSION_MS = 24h`. Rename the session cap to `max_uses` (≤ 500).

### Issuers (generalises the Google-only key registry)

- `Issuer { provider: String, iss_values: Vec<String>, keys: kid → RsaKey{n,e} }`, keyed by `provider` (e.g. `google`).
  Google: provider `google`, iss values `https://accounts.google.com` and `accounts.google.com`.
- `set_issuer(provider, iss_values)` — owner.
- `set_issuer_key(provider, kid, n, e)` / `remove_issuer_key(provider, kid)` — owner, **or** predecessor ==
  current account (so a function-call access key on the contract account limited to these two methods can rotate
  Google keys without the owner key).
- Verification stays RS256 (`google.rs` → rename/generalise to `oidc.rs`); structure the code so ES256/EdDSA can be
  added later (an `alg` match that rejects anything but RS256 today).
- Provider strings and `sub` must not contain `#`.

A verified token yields `(provider, aud, sub, nonce, exp)`. Reject expired tokens (`exp*1000 <= now`), unknown kid,
unknown iss, bad signature.

### Registry

```
Scope {
  id: String,                       // contract-assigned: "s" + base36(counter), counter starts at 1; "global" reserved
  owners: Vec<Owner>,               // 1..=5
  clients: Vec<(String, String)>,   // (provider, aud), each globally unique across scopes
  pending: Vec<PendingChange>,      // timelocked changes
  action_nonce: u64,                // replay protection for OIDC owner actions and client proofs
  created_at_ms: u64,
}
enum Owner { Near { account_id: AccountId }, Oidc { provider: String, sub: String } }
PendingChange { id: u64, change: Change, unlock_at_ms: u64 }
enum Change { AddClient { provider, aud }, SetOwners { owners: Vec<Owner> } }
client_index: (provider, aud) -> scope_id
```

Methods (JSON args; byte arrays stay `Vec<u8>` = JSON number arrays, as today):

| Method | Who | Effect |
|---|---|---|
| `admin_register_scope(owners, clients, scope_id: Option<String>)` | owner, only while `public_registration == false` | No proofs. `scope_id` override allowed only for `"global"` (bootstrap of Hana's own app). Contract pays storage. |
| `register_scope(owners, client_proofs: Vec<String /*jwt*/>)` | anyone, only while `public_registration == true` | Each proof is a token for the client being registered whose nonce = `b64url(sha256("hana-id/register/v1" ‖ borsh(owners)))`. Payable: caller attaches ≥ storage cost (refund excess) unless caller ∈ `sponsors`. |
| `propose_change(scope_id, auth: OwnerAuth, change: Change, client_proof: Option<String>)` | a scope owner | Queues a change, `unlock_at = now + change_delay_ms`. `AddClient` requires `client_proof`: token with aud = that client, nonce = `b64url(sha256("hana-id/client-proof/v1" ‖ scope_id ‖ action_nonce u64 LE))`. Uniqueness checked at propose and again at execute. |
| `execute_change(scope_id, change_id)` | anyone | Applies a change after `unlock_at`. |
| `cancel_change(scope_id, auth, change_id)` | a scope owner | |
| `remove_client(scope_id, auth, provider, aud)` | a scope owner | Immediate (can only hurt the owner's own app). Cannot remove the last client. |
| Views: `get_scope(scope_id)`, `scope_for_client(provider, aud) -> Option<String>`, `get_config()`, `get_issuer(provider)` (kids only) | anyone | |

`OwnerAuth`:
- `Near` — predecessor must equal an `Owner::Near` of the scope.
- `Oidc { jwt }` — a verified token whose `(provider, aud)` ∈ `console_audiences`, `(provider, sub)` matches an
  `Owner::Oidc` of the scope, and nonce = `b64url(sha256("hana-id/owner-action/v1" ‖ scope_id ‖ method name ‖
  borsh(args without auth) ‖ action_nonce u64 LE))`. Increment `action_nonce` on every successful authorised call.
  Document the exact byte layout in `docs/contract-interface.md` — the API and the future console must reproduce it.

Emit NEP-297 events (`standard: "hana-id"`, `version: "1.0.0"`): `scope_registered`, `change_proposed`,
`change_executed`, `change_cancelled`, `client_removed`, `public_registration_enabled`, `issuer_key_set`,
`issuer_key_removed`.

### Sessions and CKD

- `create_session(jwt, session_public_key: Vec<u8>, expires_at_ms: u64, salt: Vec<u8>, key_index: u32, max_uses: u32) -> Session`
  - Verify token; `scope_id = client_index[(provider, aud)]` else panic `"Token is for an unregistered app"`.
  - Nonce = `b64url(sha256(session_public_key ‖ expires_at_ms u64 LE ‖ key_index u32 LE ‖ salt))`.
  - `Session { path, scope_id, expires_at_ms, max_uses, used }`, path as above. Keep the existing checks (32-byte
    key, salt 16..=64, expiry window, key-in-use).
  - Prune up to 3 expired sessions per call (see below).
- `derive_key(session_public_key, counter, signature, pk1, pk2)` — unchanged logic; rename the signed domain string
  `hana-embed-ckd-v1` → `hana-id-ckd-v1` and record it in `docs/contract-interface.md` (the SDK follows in batch B).
- `revoke_session` — unchanged.
- `prune_sessions(limit: u32) -> u32` — anyone; deletes up to `limit` (≤ 100) expired sessions. Keep an index that
  makes pruning O(limit) (e.g. a FIFO of (expires_at_ms, key) plus skip-if-already-gone).
- `get_session(session_public_key)` view.

### Init / migrate

- `new(owner, mpc, ckd_domain_id, change_delay_ms)` — fresh deploy (throwaway accounts make migration of the old
  state unnecessary; delete the old `migrate`/`HanaSignerV1`).
- Contract stays upgradeable during the PoC (no lock in batch A).

### Tests

Unit tests (near-sdk `unit-testing`) for: token verification paths, unregistered aud rejection, two clients in two
scopes → two different paths for the same sub, key_index in path and nonce, admin path closed after
`public_registration`, register_scope proof checks + uniqueness + replay, propose/execute/cancel with timelock,
OIDC owner auth (correct nonce, replay rejected, wrong console aud rejected), remove_client, pruning,
set_issuer_key by owner and by the contract account but not others. Reuse/extend `test_fixture.json` and the
existing RSA test-key approach; generate new fixtures with a script under `contracts/hana-signer/scripts/` if needed.
Build wasm with `cargo near build non-reproducible-wasm` (install `cargo-near` if missing) or plain
`cargo build --target wasm32-unknown-unknown --release`.

## API (Cloudflare Worker, `apps/api`)

### Bindings and config

- Vars from the manifest (generated `wrangler.jsonc` / `.dev.vars` via `scripts/gen-wrangler.ts`): `NEAR_RPC`,
  `SIGNER_ACCOUNT`, `RELAYER_ACCOUNT`, `ENV_NAME`.
- Secrets: `RELAYER_KEYS` (JSON array of `ed25519:...` secret keys, one per access key on `RELAYER_ACCOUNT`),
  `KEYS_UPDATER_KEY` (function-call key on `SIGNER_ACCOUNT` limited to `set_issuer_key`/`remove_issuer_key`).
- D1 `DB`; Durable Objects `RELAYER_KEY` (class `RelayerKey`), `RATE_LIMITER` (class `RateLimiter`).

### Endpoints (JSON, CORS: echo the request Origin only when allowed for the app)

| Endpoint | Auth | Contract call |
|---|---|---|
| `POST /v1/sessions` | `x-hana-key: pk_test_…` + allowed Origin | `create_session` |
| `POST /v1/derive` | same | `derive_key` → returns `{big_y, big_c}` |
| `POST /v1/sessions/revoke` | same | `revoke_session` |
| `POST /v1/owner-actions` | none (OIDC proof is in the args); per-IP rate limit | `propose_change`, `cancel_change`, `remove_client` with `OwnerAuth::Oidc` only; `execute_change` |
| `GET /v1/health` | none | — |
| cron (hourly) | — | Sync Google JWKS → `set_issuer_key` / `remove_issuer_key` via `KEYS_UPDATER_KEY` |

Request checks for app endpoints, in order: app exists and `status = 'active'`; Origin exactly matches an allowed
origin (`http://localhost:*` allowed only for `pk_test_` keys); rate limits (per app per minute, per app per day, per
IP per minute; numbers from the app's plan row); for `/v1/sessions`, decode (not verify) the JWT payload, map `iss` →
provider, and check `scope_for_client(provider, aud)` (view call, cached ≤ 60 s) equals the app's `scope_id`; for
`/v1/derive` and revoke, check the session's `scope_id` (view `get_session`, cached ≤ 10 s) equals the app's.
Reject before relaying. Validate argument shapes like the legacy relayer does.

The relayer only ever calls the methods above on `SIGNER_ACCOUNT`. Never relay arbitrary methods or receivers.

### RelayerKey Durable Object

One instance per relayer key (id = key index). Holds the nonce in memory, persisted to DO storage; on cold start or
an `InvalidNonce` error, re-reads the access key nonce from RPC. Hands out nonces strictly in order, signs and
broadcasts, then waits for the outcome outside the critical section (many in-flight txs per key are fine). Pick the
key per request round-robin or least-busy. Port result handling (`SuccessValue` decode, failure text, timeouts) from
`legacy/relayer/embed-relayer.ts`. Gas 300 Tgas as today unless the contract agent documents less.

### D1 schema (migrations in `apps/api/migrations`)

`apps(id, name, scope_id, publishable_key UNIQUE, status 'active'|'suspended', plan, created_at)`,
`app_origins(app_id, origin)`, `plans(id, per_minute, per_day)`, `usage(app_id, day, sessions, derives)`.
Seed a `free` plan. Increment usage per successful call.

### Logging

Structured JSON logs: request id, app id, endpoint, outcome, latency, NEAR tx hash. Never log JWTs, signatures,
request bodies, keys, or CKD responses.

### Tests

vitest with `@cloudflare/vitest-pool-workers`; mock NEAR RPC with `fetchMock`. Cover each rejection path, nonce
serialisation under concurrency (N parallel requests → N distinct nonces), InvalidNonce recovery, CORS, usage
counting, cron JWKS sync diffing.

## Environments and scripts

- `packages/env`: zod schema for the manifest (fields below), `loadEnv(name)` reading `envs/<name>.json`.
- `envs/sandbox-dev.json` with placeholder throwaway names:
  `network`, `signer`, `relayer`, `owner`, `mpc`, `ckdDomainId`, `ckdNetworkKey` (placeholder string until fetched),
  `rpc`, `apiUrl`, `changeDelayMs`, `googleClientIds` (Hana's own app, for the `global` scope),
  `consoleAudiences`.
- `scripts/` (TypeScript, run with `tsx`, args via a small CLI):
  - `gen-wrangler.ts <env>` — writes `apps/api/wrangler.jsonc` vars from the manifest.
  - `deploy-contract.ts <env>` — build wasm, deploy to `signer`, call `new`, add the relayer's function-call keys
    (methods: create_session, derive_key, revoke_session, prune_sessions, register_scope, propose_change,
    cancel_change, remove_client, execute_change; small allowance), add the keys-updater function-call key on the
    signer account (set_issuer_key, remove_issuer_key), `set_issuer` for Google, `set_sponsors`, bootstrap
    `admin_register_scope` for `global` with Hana's client IDs. Uses `near` CLI (installed: near-cli-rs 3.x) or
    `@near-js/*`. Must print what it will do and require `--yes` to act. Never print secret keys; write generated
    keys to a gitignored `.secrets/<env>/` directory with 0600 permissions.
  - `post-google-keys.ts <env>` — one-off JWKS sync (same logic as the cron).
  - `fetch-ckd-key.ts <env>` — reads the MPC's CKD public key and writes it into the manifest.
  - `admin.ts <env> app:create|app:origins:add|app:origins:remove|app:suspend|app:resume|app:list|scope:register`
    — D1 changes via `wrangler d1 execute` (local or `--remote`), contract calls via the owner key. Generates
    `pk_test_` keys with 24 random bytes base58.
- Root `README.md`, `CLAUDE.md`, `.gitignore` (`.secrets/`, `.dev.vars`, `node_modules`, `target`, `.wrangler`).

## Out of scope for batch A

Browser SDK/vault (batch B), dashboard and Stripe, email login, mainnet, contract lock/governance, ES256 verification.
