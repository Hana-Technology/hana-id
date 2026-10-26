# Batch A.2 — shared Google client + follow-up fixes

Amends `docs/batch-a-spec.md`. Where they disagree, this file wins. Decided with the user on 2026-10-26.

## Why

Partners should be able to use Hana ID without creating their own Google OAuth client (like Privy's default
credentials), while keeping per-app key isolation. With a shared client the token's `aud` is Hana's, so the scope can't
come from `aud`. Instead the Google nonce commits to the scope, and Hana's login page (batch B, on a Hana origin) only
computes a nonce for scope X after checking the opener's origin against app X's allowed origins. Anyone forging a nonce
can only obtain *their own* key for a scope, which they are entitled to anyway.

Google's `sub` is the same across client IDs, so an app can start on the shared client and later register its own
client ID to the same scope without users' addresses changing (to be confirmed on testnet with two clients).

## Contract changes

### Shared clients

- Config `shared_clients: Vec<(String provider, String aud)>`, max 5. View in `get_config()`.
- `set_shared_clients(clients)` — owner. Removals apply immediately. Additions apply only after `change_delay_ms`
  (store as pending, like the delayed timelock decrease; `get_config()` shows pending additions and their unlock time;
  applying is lazy on read or via `apply_pending_config()` callable by anyone).
- A `(provider, aud)` can never be both a shared client and a registered scope client: registering/adding a client that
  is shared (or pending shared) panics, and adding a shared client that is registered panics.

### Scopes

- `Scope.allow_shared: bool`.
- A scope must always have at least one client **or** `allow_shared == true`.
- `admin_register_scope(owners, clients, scope_id, allow_shared)` — `clients` may be empty if `allow_shared`.
- `register_scope(owners, client_proofs, allow_shared)` — public mode; `client_proofs` may be empty if `allow_shared`
  (a shared-only scope needs no proof: scope ids are contract-assigned, so nothing can be squatted).
- Enabling shared login on an existing scope: `Change::SetAllowShared { allow: true }` via `propose_change` (timelocked).
- Disabling: `disable_shared_login(scope_id, auth)` — immediate, owner only; panics if the scope has no clients.
- `remove_client` may remove the last client only when `allow_shared` is true.

### Sessions

`create_session(jwt, scope_id, session_public_key, expires_at_ms, salt, key_index, max_uses) -> Session`

Scope resolution for the verified token's `(provider, aud)`:
1. In `client_index` → must equal `scope_id`, else panic `"Token is for another app"`.
2. Else in effective `shared_clients` → scope `scope_id` must exist and have `allow_shared`, else panic
   `"Scope does not allow shared login"` / `"No such scope"`.
3. Else panic `"Token is for an unregistered app"`.

Path is unchanged: `{scope_id}#{provider}#{sub}#{key_index}`.

### Byte layouts (all nonces are `b64url_nopad(sha256(preimage))`; `borsh(string)` = u32 LE length ‖ UTF-8 bytes)

| Name | Preimage |
|---|---|
| Session nonce | `"hana-id/session/v1"` ‖ borsh(signer account id) ‖ borsh(scope_id) ‖ session_public_key (32 bytes) ‖ expires_at_ms u64 LE ‖ key_index u32 LE ‖ max_uses u32 LE ‖ salt |
| Register proof | `"hana-id/register/v1"` ‖ borsh(signer account id) ‖ borsh(owners: Vec<Owner>) ‖ borsh(clients: Vec<(String,String)>, in the order of `client_proofs`) ‖ allow_shared u8 |
| Client proof | `"hana-id/client-proof/v1"` ‖ borsh(signer account id) ‖ borsh(scope_id) ‖ action_nonce u64 LE |
| Owner action | `"hana-id/owner-action/v1"` ‖ borsh(signer account id) ‖ borsh(scope_id) ‖ borsh(method name) ‖ borsh(args without auth) ‖ action_nonce u64 LE |
| Session message | `"hana-id-session-v1:"` ‖ counter u64 LE ‖ sha256(payload) (renamed from `hana-embed-session-v1:`) |
| CKD payload | `"hana-id-ckd-v1:{pk1}:{pk2}"` (unchanged) |

"signer account id" = `env::current_account_id()`. This binds every token to one deployment (no cross-env replay)
and the session nonce now also commits to `scope_id` and `max_uses`.

## API changes

- **Two relayer key pools.**
  - `RELAYER_KEYS` (session pool) → only `create_session`, `derive_key`, `revoke_session`, `prune_sessions`.
  - `OWNER_RELAYER_KEYS` (owner pool, small allowance) → only `propose_change`, `cancel_change`, `remove_client`,
    `disable_shared_login`, `execute_change`, `register_scope`, `apply_pending_config`. `/v1/owner-actions` uses it.
  - Separate Durable Object names per pool. Abuse of the owner endpoint can never stop logins.
- **Per-method gas** (constants in one module, overridable by env var): `create_session` 50 Tgas, `derive_key` 60 Tgas,
  `revoke_session` 20, `prune_sessions` 50, owner-pool methods 50. Mark as "to measure on testnet".
- **Verify before relaying.**
  - `/v1/sessions`: verify the Google ID token RS256 signature with WebCrypto against Google's JWKS
    (`https://www.googleapis.com/oauth2/v3/certs`, cached per Cache-Control, refetch once on unknown `kid`), `iss`,
    `exp` (60 s skew), `aud`, and presence of `nonce`. Recompute the session nonce from the request and the app's
    `scope_id` and reject a mismatch.
  - `/v1/derive` and `/v1/sessions/revoke`: verify the Ed25519 session signature over the session message with WebCrypto
    before relaying (counter freshness stays the contract's job).
- **Scope check on `/v1/sessions`.** The API passes the app's `scope_id` (from D1) as `scope_id`. If the token's
  `(provider, aud)` is a registered client it must map to that scope; if it is a shared client the scope must have
  `allow_shared` (view `get_scope`, cached ≤ 60 s); otherwise reject.
- **`GET /v1/app`** (publishable key + allowed Origin) → `{ scopeId, signer, google: { clientId, mode: "own" | "shared" } }`.
  Own if the scope has a Google client (first one), else the first effective shared client if `allow_shared`, else 409.
  The batch B SDK reads this to start the right Google flow and to compute the nonce.
- Request body for `/v1/sessions` stays camelCase; `scopeId` is not accepted from the client (the API uses the app's).

## Environments and scripts

- Manifest: add `sharedGoogleClientIds: string[]` (Hana's shared login client(s)); `googleClientIds` stays the client
  list of the reserved `global` scope.
- `deploy-contract`:
  - Two key pools (session keys and owner keys) with their own method lists, counts and allowances, written to
    `.secrets/<env>/relayer-keys.json` and `.secrets/<env>/owner-relayer-keys.json`.
  - `set_shared_clients` from the manifest, and `admin_register_scope` with the new `allow_shared` argument.
  - Compare existing access keys' `method_names` and `receiver_id` with the intended lists; treat mismatch or an empty
    list (= any method) as a blocker, not a silent pass.
- `admin scope:register`: add `--allow-shared`; allow zero `--client` when `--allow-shared`.
- `gen-wrangler --dev-vars`: also write `OWNER_RELAYER_KEYS`; make sure values are in a form `.dev.vars` parses.

## Tests to add

- **Contract:**
  - Shared-mode `create_session` succeeds for an `allow_shared` scope and fails for one without it.
  - Own-client token with the wrong `scope_id` fails.
  - Shared client addition is delayed; overlap rules hold both ways.
  - Disable/enable shared login.
  - Last-client rules.
  - Every new nonce layout is checked against an independent JS implementation in `gen-fixtures.mjs`, including the
    session message and CKD payload.
  - Cross-deployment replay fails (same token, different `current_account_id`).
- **Sandbox (integration-tests):**
  - Same `sub` via the shared client into scopes A and B gives different paths.
  - Same `sub` via the shared client and via app A's own client into scope A gives the same path.
  - Relayer key pools are limited to their method lists.
- **API:**
  - JWT verification paths: bad signature, unknown kid refetch, expired, wrong aud, nonce mismatch.
  - Ed25519 pre-check.
  - Shared vs own scope checks.
  - `/v1/app`.
  - Pool routing.
  - Per-method gas.
