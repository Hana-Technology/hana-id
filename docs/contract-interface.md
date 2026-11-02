# hana-signer contract interface (batch A, A.2, B, governance and email login)

Last verified against code: 2026-11-02 (branch `feat/link-cap`: the hourly link cap, D200: `set_link_limits`,
`get_link_stats`, `Link rate limit reached`, `link_cap_reached`, gas); 2026-11-02 (branch `feat/email-login-2`: contract v3 with `migrate_v1` removed, the email
login calls and the v2 → v3 upgrade measured in the sandbox, [Gas of the email login calls](#gas-of-the-email-login-calls-sandbox)).

The exact on-chain interface of `contracts/hana-signer`. The API, scripts, console and SDK must match this file.
If the code and this file disagree, the code is wrong: raise it. Batch A.2 (`docs/batch-a2-shared-client.md`) added
shared clients, `allow_shared`, `disable_shared_login`, `apply_pending_config`, the `scope_id` argument of
`create_session`, and binds every nonce to the contract account. **Every byte layout changed in A.2.** Batch B
(`docs/batch-b-spec.md`) added `create_session_and_derive` and reserved `key_index ≥ 2^31`; no layout, path or
state changed (see [Changed in batch B](#changed-in-batch-b)). The governance batch (`docs/governance-spec.md`,
D33, D80–D86) delays issuer-key changes behind a watchdog, adds pause, timelocked upgrades, owner transfer and
surplus withdrawal, and migrates state to layout v2 in place; no byte layout, path or derivation changed, so **no
address changes** (see [Changed in the governance batch](#changed-in-the-governance-batch)). The email login batch
(`docs/email-login-spec.md`, D4, D119, D121–D123; built in `docs/email-login-build-plan.md` batch 1) adds
self-issued issuers with a signer policy and JWS JSON tokens, accounts of linked sign-in methods, and migrates state
to layout v3 in place; no existing byte layout, path or derivation changed, and an identity in no account opens
exactly the path it opened before, so **no address changes** (see [Changed in the email login
batch](#changed-in-the-email-login-batch-v3)). Not deployed yet.

Conventions:

- All methods take and return JSON. `Vec<u8>` byte arrays are JSON arrays of numbers (`[1,2,3]`), never base64.
- `u64` / `u32` values are JSON numbers (all values used here fit in 2^53).
- Enums use serde's default externally-tagged form (a unit variant is a bare string).
- `‖` means byte concatenation. `u64 LE` / `u32 LE` are little-endian fixed-width integers. Strings are UTF-8.
- `b64url` is base64url **without padding** (RFC 4648 §5), as used by JWT and Google's `nonce` claim.
- `sha256` is SHA-256 over the raw bytes.
- `borsh(x)` is the [Borsh](https://borsh.io) encoding (see "Borsh encodings" below for every type used).
- Panic messages are listed so callers can map them; a panic aborts the whole call (no state change).
- Methods not marked payable reject any attached deposit (`Method ... doesn't accept deposit`).
- Gas: `derive_key` forwards a fixed 20 Tgas to the MPC and needs ≥ 50 Tgas attached. The API's per-method defaults
  (`apps/api/src/gas.ts`, overridable per env with `GAS_<METHOD>_TGAS`): `create_session` 50 Tgas,
  `create_session_and_derive` 100, `derive_key` 60, `revoke_session` 20, `prune_sessions` 50, owner-pool methods 50
  except `register_scope` (30 + 25 per client proof, ≤ 280). Measured on testnet (`docs/context.md`): `create_session`
  and `derive_key` each burn ~20 Tgas over all receipts; `create_session_and_derive` is **not yet measured**. 300 Tgas
  always works. View methods cost nothing. Governance calls (sandbox, `contracts/integration-tests/tests/governance.rs`):
  the updater key sends 30 Tgas to `set_issuer_key`, `propose_issuer_key_removal` and `execute_issuer_key_change`
  (its allowance is 1 NEAR); `execute_upgrade` needs 300 Tgas (see [Upgrades](#upgrades)); owner calls through the
  DAO attach 100 Tgas per `FunctionCall` action. Email login and links (v3): measured per call in
  [Gas of the email login calls](#gas-of-the-email-login-calls-sandbox); a combined login with `link_jwt` needs ≈ 59
  Tgas with 2048-bit keys and ≈ 156 with 4096-bit ones (the largest the contract accepts): attach 250 (D155; the
  API sets it in build-plan batch 6).

## Types (JSON)

```jsonc
// Owner
{"Near":{"account_id":"alice.testnet"}}
{"Oidc":{"provider":"google","sub":"110248495921238986420"}}

// OwnerAuth (how the caller proves it is a scope owner)
"Near"                                   // predecessor must be an Owner::Near of the scope
{"Oidc":{"jwt":"eyJhbGciOiJSUzI1NiIs..."}} // ID token of an Owner::Oidc, see "Owner-action nonce"

// Change
{"AddClient":{"provider":"google","aud":"123-abc.apps.googleusercontent.com"}}
{"SetOwners":{"owners":[{"Near":{"account_id":"alice.testnet"}}]}}
{"SetAllowShared":{"allow":true}}          // only allow = true is accepted (disable with disable_shared_login)

// Session (create_session / get_session)
{"path":"s1#google#110248495921238986420#0","scope_id":"s1","expires_at_ms":1800003600000,"max_uses":3,"used":0}

// Scope (get_scope)
{
  "id": "s1",
  "owners": [{"Near":{"account_id":"alice.testnet"}}],
  "clients": [["google","123-abc.apps.googleusercontent.com"]],   // [provider, aud] pairs; may be [] if allow_shared
  "allow_shared": false,                                          // tokens of a shared client may log in to this scope
  "pending": [{"id":0,"change":{"AddClient":{"provider":"google","aud":"456-def.apps.googleusercontent.com"}},"unlock_at_ms":1800172800000}],
  "action_nonce": 1,
  "created_at_ms": 1800000000000
}

// Config (get_config)
{
  "owner": "hana-id-admin-dev1.testnet",
  "mpc": "v1.signer-prod.testnet",
  "ckd_domain_id": 2,
  "console_audiences": [["google","console.apps.googleusercontent.com"]],  // in force now (matured pending ones included)
  "pending_console_audiences": [{"provider":"google","aud":"console2.apps.googleusercontent.com","effective_at_ms":1800172800000}],
  "sponsors": ["hana-id-relayer-dev1.testnet"],
  "shared_clients": [["google","hana-shared.apps.googleusercontent.com"]],  // in force now (matured pending ones included), in the order they took effect
  "pending_shared_clients": [{"provider":"google","aud":"hana-shared2.apps.googleusercontent.com","effective_at_ms":1800172800000}],
  "change_delay_ms": 172800000,                 // the delay in force now
  "pending_change_delay": null,                 // or {"change_delay_ms":60000,"effective_at_ms":1800172800000}
  "public_registration": false,
  "issuer_key_delay_ms": 7200000,               // in force now
  "pending_issuer_key_delay": null,             // a decrease: {"change_delay_ms":3600000,"effective_at_ms":...} (field name kept from batch A: it is the new value)
  "governance_delay_ms": 259200000,             // in force now
  "pending_governance_delay": null,             // same shape
  "paused": false,
  "unpaused_at_ms": 0,                          // the last unpause (0: never)
  "changes_unlock_floor_ms": 0,                 // no execute_change before this: the last unpause + change_delay_ms then
  "sessions_valid_from_ms": 0,                  // sessions opened before this can't derive (set_sessions_valid_from_ms)
  "unrecorded_wallets": false                   // true after a migration from pre-v3 state until accept_unrecorded_wallets: links refused
}

// Issuer (get_issuer) — key material is not returned, only active key ids
{"provider":"google","iss_values":["https://accounts.google.com","accounts.google.com"],"kids":["a1b2...","c3d4..."]}

// Active keys with material (get_issuer_keys), kid order; null for an unknown issuer
[{"kid":"a1b2...","n":"<JWK n, base64url, leading zeros stripped>","e":"AQAB"}]

// Pending key changes (get_key_changes), in proposal order, all issuers
[
  {"id":7,"provider":"google","kid":"e5f6","op":"Add","n":"<JWK n, base64url, leading zeros stripped>","e":"AQAB",
   "by":"hana-signer-dev1.testnet","proposed_at_ms":1800000000000,"executable_at_ms":1800007200000},
  {"id":8,"provider":"google","kid":"a1b2","op":"Remove","n":null,"e":null,
   "by":"hana-signer-dev1.testnet","proposed_at_ms":1800000000000,"executable_at_ms":1800007200000},
  // a self-issued issuer's key addition also names its signer (the field is absent on every other change)
  {"id":9,"provider":"email","kid":"<RFC 7638 thumbprint>","op":"Add","n":"...","e":"AQAB","signer":"hana",
   "by":"hana-council.sputnikv2.testnet","proposed_at_ms":1800000000000,"executable_at_ms":1800259200000}
]

// Signer policy of a self-issued issuer (get_self_issued); null for any other provider
{"provider":"email","signers":[{"id":"hana","kids":["<primary>","<standby>"]}],"required":1,
 "overlap_until_ms":null}                       // set for 10 min after a governed upgrade changed the policy

// Identity (get_identity): where (scope, provider, sub) stands
{"key":"8982b5c1…07",                            // identity key, hex
 "status":"own",                                 // "own" (opens its own path) | "member" (opens root's path) | "pending"
 "opened":true,                                  // its own path was derived ("has a wallet")
 "root":null,                                    // {"provider","sub"} of the account root, for member and pending
 "effective_at_ms":null,                         // pending: when logins start working (unpause floor counted); member: when it became effective
 "account_epoch":0}                              // epoch of its account (0: none); link nonces commit to it

// Account (get_account): the account an identity is in (as root or member), or null
{"root":{"provider":"google","sub":"110248495921238986420"},
 "members":[{"key":"<hex>","provider":"email","effective_at_ms":1800086400000,"active":false,"auto":true}],
 "epoch":1,
 "unlinked":["<hex>"]}                           // identities automatic linking must not re-add

// Governance (get_governance)
{
  "state_version": 3,
  "watchdogs": [{"account_id":"hana-id-watchdog-dev1.testnet","confirm_from_ms":1800259200000}],  // may confirm from then on
  "keys_slow_until_ms": 0,                      // time-based key activation waits at least until here (raised by remove_watchdog)
  "updater_keys": ["ed25519:6E8s..."],          // keys the contract added on its own account (their AddKey succeeded)
  "pending_updater_keys": [],                   // requested keys whose AddKey hasn't resolved yet (normally empty)
  "updater_methods": ["set_issuer_key","propose_issuer_key_removal","execute_issuer_key_change"],  // every updater key's exact method list
  "pending_upgrade": {"code_hash":"8Tf3...","proposed_at_ms":1800000000000,"executable_at_ms":1800259200000},  // or null
  "pending_owner": {"owner":"hana-council.sputnikv2.testnet","acceptable_at_ms":1800259200000},             // or null
  "pending_withdrawal": {"receiver":"hana-id-ops.testnet","amount":"10000000000000000000000000","executable_at_ms":1800259200000}  // or null; amount in yoctoNEAR
}
```

Identifiers:

- **scope_id**: assigned by the contract: `"s"` + lowercase base36 of a counter starting at 1 (`s1` … `s9`, `sa` … `sz`,
  `s10`, …). The only other id is the reserved `"global"` (Hana's own app, `admin_register_scope` only). Scope ids
  therefore match `^[a-z0-9]+$`.
- **provider**: `^[a-z0-9_-]{1,32}$` (e.g. `google`). Never contains `#`.
- **aud** (client id): 1..=256 bytes. **sub**: 1..=255 bytes, must not contain `#`.
- **path** (MPC derivation path): `{scope_id}#{provider}#{sub}#{key_index}`, key_index in decimal without leading
  zeros. Example `s1#google#110248495921238986420#0`. Changing anything in this format changes every address. The
  `(provider, sub)` is the session's **path identity**: the token's own identity, or, for a member of an account, the
  account root's ([Accounts and links](#accounts-and-links)). An identity in no account opens exactly this path.
  Email identities: `s1#email#e1.<43 base64url characters>#0`.
- **identity key** (`ik`): `sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))`, 32
  bytes, hex in JSON (64 lowercase characters). Account state and link events are keyed by it.
- **key_index**: `u32`, `0 ..= 2^31 − 1` (`0x7fff_ffff`). Values `≥ 2^31` are reserved (for a later rotation or
  versioning scheme): `create_session` and `create_session_and_derive` refuse them, and so do the API and the SDK.
  The MVP uses 0 only.
- **signer account id**: `env::current_account_id()`, the account the contract is deployed on (e.g.
  `hana-signer-dev1.testnet`). Every nonce commits to it, so a token used on one deployment can't be replayed on
  another.

Limits: 1..=5 owners per scope, 0..=10 clients per scope (at least one client **or** `allow_shared`), ≤ 5 shared
clients (effective + pending), ≤ 10 pending changes per scope (≤ 2 queued by a sponsor on a scope without clients),
≤ 10 RSA keys per issuer,
≤ 4 iss values per issuer, ≤ 10 console audiences, ≤ 10 sponsors, JWT ≤ 7168 bytes, kid ≤ 128 bytes,
session ≤ 24 h, `max_uses` 1..=500, `key_index` < 2^31, `change_delay_ms` ≤ 7 days. Governance: ≤ 6 pending key
changes over all issuers (active + pending additions ≤ 10 per issuer), ≤ 3 watchdogs, ≤ 2 updater keys,
`issuer_key_delay_ms` ≤ 7 days, `governance_delay_ms` ≤ 30 days. Email login: one self-issued issuer (`email`), ≤ 3 signers
per policy, ≤ 8 keys per self-issued issuer (active + pending additions), ≤ 3 signatures per JWS JSON token, ≤ 3
members per account (one sign-in method per provider, the root's included), ≤ 8 remembered unlinked identities per
account, link `salt` 16..=64 bytes.

## Token verification (all methods that take a JWT)

A JWT is accepted when, in this order:

0. The contract is not paused (`Paused`, see [Pause](#pause)).
1. It has three dot-separated base64url parts and is ≤ 7168 bytes (`JWT too large`, `JWT must have three parts`,
   `Malformed base64url`, `Malformed JWT header`, `Malformed JWT claims`). Header needs `alg` and `kid`; claims need
   `iss`, `aud` (a single string), `sub`, `exp`; `nonce` is optional at parse time.
2. `iss` is one of a configured issuer's `iss_values` → that issuer's `provider` (`Unknown token issuer`).
3. `kid` is one of that issuer's **active** keys (`Unknown signing key`). A kid with a pending change is not
   active until the change executes or a watchdog confirms it.
4. `alg` is supported: only `RS256` today (`Unsupported JWT algorithm`).
5. The signature verifies (RSASSA-PKCS1-v1_5 / SHA-256 over `header.payload`) (`Invalid token signature`).
6. `exp * 1000 > block_timestamp_ms` (`Token expired`).
7. `sub` is 1..=255 bytes without `#` (`Invalid sub`); `aud` is 1..=256 bytes (`Invalid aud`).

**Self-issued issuers (email) take the JWS General JSON Serialization instead** (RFC 7515 §7.2.1), and every other
issuer the compact form only (`Wrong token format for this issuer` either way). A token starting with `{` is parsed
as `{"payload":"<b64url(claims)>","signatures":[{"protected":"<b64url({\"alg\":\"RS256\",\"kid\":\"…\"})>","signature":"<b64url>"}, …]}`:

1. ≤ 7168 bytes (`JWT too large`); exactly the members `payload` and `signatures` at the top level and `protected` and
   `signature` in each entry: no flattened form, no unprotected `header`, no duplicate members (`Malformed JWS`);
   1..=3 entries (`Malformed JWS`, `Too many signatures`); claims as above (`Malformed base64url`, `Malformed JWT
   claims`); each protected header has `alg` and `kid` (`Malformed JWS header`) and no `crit` (`Unsupported JWS
   header`; e.g. RFC 7797 `b64`, which would change what is signed).
2. `iss` → provider as above, and the provider must be self-issued.
3. For each entry in order: its `kid` differs from every other entry's (`Duplicate signature kid`); it is an
   **active** key of the issuer whose signer counts now (listed in the policy, or in the previous policy while the
   overlap lasts) (`Unknown signing key`); `alg` is `RS256` (`Unsupported JWT algorithm`); the signature over
   `protected ‖ "." ‖ payload` (ASCII) verifies (`Invalid token signature`). **One bad entry fails the token.**
4. The distinct signers of the entries number at least the policy's `required`, or, while `now < overlap_until_ms`,
   at least the previous policy's count among its signers (`Not enough signatures`). Two keys of one signer count
   once.
5. Then steps 6–7 above (`Token expired`, `Invalid sub`, `Invalid aud`).

The verified token yields `(provider, aud, sub, nonce)`; `(provider, aud)` is the token's **client**. Each method
then checks `nonce` against the commitment below (`... nonce ...` panics). Tokens are public once used on-chain; every use is bound by its nonce to
one purpose, so a published token can't be reused for anything else.

**No claim allow-list on chain.** Claims other than the ones above are ignored, whatever they are: the contract
accepts a token carrying `email`, `name`, `hd` or any other claim, on any method. This is deliberate: console
owner-action tokens (batch C) may legitimately carry `email`. Keeping personal data off the chain is an API and vault
rule (batch B's claim allow-list, `token_has_pii`), and it binds only tokens the API relays (`/v1/login`, and
`/v1/sessions` once `REJECT_PII_ON_SESSIONS` is on); a direct caller can still put any valid token on chain.

## Byte layouts (nonces, commitments, signed messages)

Every layout below is implemented twice: in Rust (`registry.rs`, `sessions.rs`) and independently in JS
(`contracts/hana-signer/scripts/gen-fixtures.mjs`, which also signs the unit-test tokens). The JS writes the worked
examples below (preimage hex and nonce) to `src/test_fixture.json`, and the Rust tests check their own preimages,
nonces and signed messages against them byte for byte. An SDK can also compare its session messages with the
`session_message(counter, payload)` view. A mismatch shows up on chain only as a nonce panic or
`Invalid session signature`.

All nonces are `b64url(sha256(preimage))` (43 characters). `signer` below is borsh(signer account id) =
borsh(`env::current_account_id()` as a String).

### Session nonce (`create_session`, `create_session_and_derive`)

```
preimage = "hana-id/session/v1"
         ‖ borsh(signer account id)
         ‖ borsh(scope_id)
         ‖ session_public_key (32 bytes, raw)
         ‖ expires_at_ms  u64 LE
         ‖ key_index      u32 LE
         ‖ max_uses       u32 LE
         ‖ salt           (16..=64 bytes, raw)
```

`scope_id` is the `scope_id` argument of `create_session` (the app's scope); `max_uses` is committed, so a
front-runner can't open the session with another cap. Since batch B the Hana vault computes this nonce from its
pinned signer account and the app's scope (`@hana-id/core` `sessionNonce`), and the login page recomputes it before
sending it to Google.

### Register proof (`register_scope`)

```
preimage = "hana-id/register/v1"
         ‖ borsh(signer account id)
         ‖ borsh(owners: Vec<Owner>)
         ‖ borsh(clients: Vec<(String provider, String aud)>)   // the proofs' clients, in client_proofs order
         ‖ allow_shared u8 (0x00 | 0x01)
```

One token per client being registered; each token's `(provider, aud)` is a client, all with this same nonce. A
shared-only registration (`client_proofs: []`, `allow_shared: true`) needs no token and so no nonce.

### Client proof (`propose_change` with `AddClient`)

```
preimage = "hana-id/client-proof/v1" ‖ borsh(signer account id) ‖ borsh(scope_id) ‖ action_nonce u64 LE
```

`action_nonce` is the scope's current value (before the call increments it). The token's `(provider, aud)` must
equal the `AddClient` change.

### Owner-action nonce (`OwnerAuth::Oidc`)

```
preimage = "hana-id/owner-action/v1"
         ‖ borsh(signer account id)
         ‖ borsh(scope_id)
         ‖ borsh(method_name)        // "propose_change" | "cancel_change" | "remove_client" | "disable_shared_login"
         ‖ borsh(args without auth)
         ‖ action_nonce u64 LE
```

`borsh(args without auth)` is every argument of the call except `auth`, in declaration order, each Borsh-encoded and
concatenated (no extra length prefix around the whole):

| method | args without auth |
|---|---|
| `propose_change` | `borsh(scope_id: String) ‖ borsh(change: Change) ‖ borsh(client_proof: Option<String>)` |
| `cancel_change` | `borsh(scope_id: String) ‖ borsh(change_id: u64)` |
| `remove_client` | `borsh(scope_id: String) ‖ borsh(provider: String) ‖ borsh(aud: String)` |
| `disable_shared_login` | `borsh(scope_id: String)` |

(`scope_id` therefore appears twice in the preimage: once after the signer, once as the first argument.)

For `propose_change(AddClient)` the owner token therefore commits to the exact client-proof JWT: obtain the client
proof first, then the owner token. `action_nonce` is the scope's current value; any successful `propose_change`,
`cancel_change`, `remove_client` or `disable_shared_login` on the scope (with either auth kind) increments it, and so
does every `execute_change` (anyone may call it). So a used owner token can never be replayed, a token published by a
call that failed only because of the scope's state can't be replayed once that state changes, and a token (or client
proof) prepared before another action or an execute must be re-obtained.

### Session message (`derive_key`, `create_session_and_derive`, `revoke_session`)

The session key (Ed25519) signs:

```
session_message(counter, payload) = "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload)
```

**Renamed** in A.2 from `hana-embed-session-v1:`.

- `derive_key`: `payload` = the CKD payload `"hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2` (UTF-8 of the two strings exactly as
  passed; unchanged in A.2).
- `create_session_and_derive`: the same message as `derive_key`, always with `counter = 1`; with `link_jwt`, the
  linked CKD payload instead (D133).
- `revoke_session`: `payload = "revoke"`.
- `create_session` (v3, D137): the proof of possession, `counter = 0`, `payload = "hana-id-create-v1:" ‖
  sha256(session nonce preimage)` (the preimage of "Session nonce" above, for this call's parameters). Counter 0
  is never accepted by `derive_key` or `revoke_session`, so the proof can't spend a session.
- `counter` must equal `used + 1` (derive, revoke). The view `session_message(counter, payload)` returns these bytes.

### Vault message (off-chain only; the contract never accepts it)

The session key also signs requests to the API's vault endpoints (batch B, `docs/batch-b-spec.md` "Vault message
layout"). The contract has no method that takes one; it is listed here so that its domain is never reused:

```
vault_message(share_id, counter, payload) = "hana-id-vault-v1:" ‖ borsh(signer account id) ‖ borsh(app_id)
                                          ‖ share_id (16 bytes) ‖ counter u64 LE ‖ sha256(payload)
```

`app_id` is the API's app id (D1 `apps.id`), not the CKD `app_id`. The prefix differs from `"hana-id-session-v1:"`,
so a vault signature never verifies as a `derive_key`, `create_session_and_derive` or `revoke_session` signature
(`Invalid session signature`; unit and sandbox tests check this with the worked example below).

### Identity token messages (off-chain only; the contract never accepts them)

The partner identity token (`docs/identity-token-spec.md`, D120, D127; `docs/api.md` "Identity token") adds two
off-chain messages, listed here so their domains are never reused. Nothing on chain changes, and the contract never
accepts the token itself (it is ES256 under a key the contract never holds; `verify_token` takes RS256 issuer keys):

```
identity_message = "hana-id-identity-v1:" ‖ borsh(signer account id) ‖ borsh(app_id) ‖ session_public_key (32)
                   ‖ issued_at_ms u64 LE ‖ nonce (16) ‖ sha256(payload)     signed by the session key (Ed25519)
wallet_proof     = "hana-id/identity-wallet/v1" ‖ 0x00 ‖ borsh(signer account id) ‖ borsh(app_id)
                   ‖ session_public_key (32) ‖ borsh(chain) ‖ borsh(address)  signed by the chain key
```

The identity prefix differs from `"hana-id-session-v1:"` and `"hana-id-vault-v1:"`, so a mint signature never
verifies as a session message. A wallet proof is a 0x00-separated text domain: no Stellar transaction hash or SEP-53
message, and no EVM transaction (keccak of RLP) or EIP-191 message, has that shape. Worked examples:
`packages/core/test/vectors/identity-v1.json`.

### Identity key, link nonces and the linked CKD payload (email login; `link_identity`, `cancel_link`, `unlink_identity`, `link_jwt`)

Implemented in Rust (`links.rs`, `sessions.rs`) and independently in JS (`scripts/gen-email-fixtures.mjs`, which
writes the worked examples below to `src/email_fixture.json`; the Rust tests compare byte for byte). `root_ik`,
`new_ik`, `member_ik`, `session_ik`, `joiner_ik` and `target_root_ik` are raw 32-byte identity keys; `signer` is the
signer contract's account id, as everywhere (not an email signer id).

```
identity key = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))
link_new     = "hana-id/link-new/v1"     ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖ salt
link_account = "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt
link_change  = "hana-id/link-change/v1"  ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh("cancel" | "unlink") ‖ root_ik ‖ member_ik ‖ epoch u64 LE ‖ salt
auto_link    = "hana-id/auto-link/v1"    ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik
               ‖ join u8 ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8
linked CKD payload = "hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode u8 ‖ pk1 ‖ ":" ‖ pk2
```

- `link_new` is the nonce of the **new** identity's token (its `sub` isn't known when the popup asks for it, so it
  commits to the provider); `link_account` that of the token of an active identity of the account. `root_ik` is the
  root of that identity's account (the identity itself if it is in none). `epoch` is the account's (0: no account
  yet); `salt` 16..=64 bytes, the method's `salt` argument.
- `link_change` is the nonce of the token that proves who cancels or unlinks.
- `auto_link` is the nonce of the self-issued `link_jwt` of `create_session_and_derive`: the hash of **this call's**
  session nonce preimage, `session_ik` = the identity key of the session token (not of the path identity), then the
  **join** the issuer decided (D133): `join` 1 = the session identity joins the link identity's account (case A), 2 =
  the link identity joins the session identity's account (cases B, C); `joiner_ik` the joining identity;
  `target_root_ik` the root of the account it joins; the epoch of that account (0 for none yet); `mode` 1 for
  `link_immediate`, else 0. The contract recomputes the join from chain state and checks the nonce, so a token can
  only make the exact join it was minted for. The email issuer computes it; nothing else should ever mint a token with
  this nonce.
- The **linked CKD payload** replaces the plain CKD payload in the counter-1 session message of a
  `create_session_and_derive` that carries `link_jwt` (D133): `sha256(link_jwt)` is over the exact `link_jwt` string
  sent, `mode` is `link_immediate`. Its own domain and its fixed-length fields before the strings keep it from ever
  equalling a plain payload.

**Worked examples** (`node contracts/hana-signer/scripts/gen-email-fixtures.mjs --doc`; same conventions as the
worked examples below, salt `[9; 16]`, the session preimage is the session nonce example's):

**Identity key: scope s1, provider "google", sub "1098765432" (the key is sha256 of the preimage)**

```
domain "hana-id/identity/v1"  68616e612d69642f6964656e746974792f7631
borsh(scope_id) "s1"          020000007331
borsh(provider) "google"      06000000676f6f676c65
borsh(sub) "1098765432"       0a00000031303938373635343332
ik = sha256                   8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
```

**Identity key: scope s1, provider "email", sub "e1.7IruQ0pNsF3Ut6d1cNQiqYXVZTwdGYkaUIN8viJdvZE"**

```
domain "hana-id/identity/v1"                                 68616e612d69642f6964656e746974792f7631
borsh(scope_id) "s1"                                         020000007331
borsh(provider) "email"                                      05000000656d61696c
borsh(sub) "e1.7IruQ0pNsF3Ut6d1cNQiqYXVZTwdGYkaUIN8viJdvZE"  2e00000065312e374972755130704e7346335574366431634e5169715958565a54776447596b6155494e3876694a64765a45
ik = sha256                                                  e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
```

**link_new: scope s1, root = the google identity key above, new provider "email", epoch 7, salt [9; 16]**

```
domain "hana-id/link-new/v1"         68616e612d69642f6c696e6b2d6e65772f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
root_ik (32 bytes)                   8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
borsh(new provider) "email"          05000000656d61696c
epoch u64 LE (7)                     0700000000000000
salt (16 bytes)                      09090909090909090909090909090909
nonce                                ecyEONGVaq_QVDWlpzrcygYnGM6uIGajCR1zLgGJvpg
```

**link_account: scope s1, root = the google identity key, new = the email identity key, epoch 7, salt [9; 16]**

```
domain "hana-id/link-account/v1"     68616e612d69642f6c696e6b2d6163636f756e742f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
root_ik (32 bytes)                   8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
new_ik (32 bytes)                    e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
epoch u64 LE (7)                     0700000000000000
salt (16 bytes)                      09090909090909090909090909090909
nonce                                _wne28aQrbIMOj3SndQQnzeYpD7uboRaDSg_o3unFvA
```

**link_change "cancel": scope s1, root = the google identity key, member = the email identity key, epoch 8, salt [9; 16]**

```
domain "hana-id/link-change/v1"      68616e612d69642f6c696e6b2d6368616e67652f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
borsh(action) "cancel"               0600000063616e63656c
root_ik (32 bytes)                   8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
member_ik (32 bytes)                 e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
epoch u64 LE (8)                     0800000000000000
salt (16 bytes)                      09090909090909090909090909090909
nonce                                ALgWcNGrd3TkHC_4TMMFWp36nTwRF4gkdR3MNERRPoM
```

**link_change "unlink": as above with action "unlink"**

```
domain "hana-id/link-change/v1"      68616e612d69642f6c696e6b2d6368616e67652f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
borsh(action) "unlink"               06000000756e6c696e6b
root_ik (32 bytes)                   8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
member_ik (32 bytes)                 e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
epoch u64 LE (8)                     0800000000000000
salt (16 bytes)                      09090909090909090909090909090909
nonce                                vNwwBtTfNKUROgGODgguR4yUQPMj0vm_Hh6y1VOfL8U
```

**auto_link, case A: scope s1, the session nonce preimage of the session nonce example (key 7), session identity = the google identity key, join 1 (the session identity joins), joiner = the google key, target root = the email key, target epoch 3, mode 1 (link_immediate)**

```
domain "hana-id/auto-link/v1"              68616e612d69642f6175746f2d6c696e6b2f7631
borsh(signer) "hana-signer.testnet"        1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                       020000007331
sha256(session nonce preimage) (32 bytes)  6626c420e609ef05ddb3153fee121d0ffb297805bccfb7264a0a0887c5dec6c1
session_ik (32 bytes)                      8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
join u8 (1)                                01
joiner_ik (32 bytes)                       8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
target_root_ik (32 bytes)                  e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
target epoch u64 LE (3)                    0300000000000000
mode u8 (1)                                01
nonce                                      1vZXk5ghaSRT_J4fuAfXQeeLiwdqg0GV7C2yhqiO3h0
```

**auto_link, case B: as above with join 2 (the link identity joins), joiner = the email key, target root = the google key, mode 0 (after change_delay_ms)**

```
domain "hana-id/auto-link/v1"              68616e612d69642f6175746f2d6c696e6b2f7631
borsh(signer) "hana-signer.testnet"        1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                       020000007331
sha256(session nonce preimage) (32 bytes)  6626c420e609ef05ddb3153fee121d0ffb297805bccfb7264a0a0887c5dec6c1
session_ik (32 bytes)                      8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
join u8 (2)                                02
joiner_ik (32 bytes)                       e2604fc38c4cf47fc03824687ec4a69653243aa5511b98c8b659084b0a2c7ece
target_root_ik (32 bytes)                  8982b5c1e573b4e0d83402db6be98f0153f32c9568423342c6734d7e787ae607
target epoch u64 LE (3)                    0300000000000000
mode u8 (0)                                00
nonce                                      3yN6rNWXt9zQQKQAXZyRlq8HCs9JOQlN21gWCZ6pulo
```

**Session message for a bare create_session (proof of possession): counter 0, payload "hana-id-create-v1:" ‖ sha256(the session nonce preimage of the session nonce example, key 7)**

```
domain "hana-id-session-v1:"  68616e612d69642d73657373696f6e2d76313a
counter u64 LE (0)            0000000000000000
sha256(payload)               9a4cb9b247a068248d1acff378ea700a497efdbcd4e2f1d6e6edfa81277e66fb
```

**Linked CKD payload: link_jwt {"payload":"e30","signatures":[]}, mode 1, pk1 "bls12381g1:A", pk2 "bls12381g2:B"**

```
domain "hana-id-ckd-link-v1:"  68616e612d69642d636b642d6c696e6b2d76313a
sha256(link_jwt) (32 bytes)    c7d93281214ca8fcb93b51a290eed68bddebfe7e64e4d018d5e75a2cc01519e3
mode u8 (1)                    01
pk1 "bls12381g1:A"             626c73313233383167313a41
":"                            3a
pk2 "bls12381g2:B"             626c73313233383167323a42
```

### Borsh encodings used above

| Type | Encoding |
|---|---|
| `String` (incl. account ids) | `u32 LE` byte length ‖ UTF-8 bytes |
| `u8` / `bool` | 1 byte (`0x00` / `0x01`) |
| `u32` / `u64` | 4 / 8 bytes LE |
| `Option<String>` | `0x00` (None) or `0x01` ‖ borsh(String) |
| `Vec<T>` | `u32 LE` count ‖ each element |
| `(String, String)` | borsh(first) ‖ borsh(second) |
| `Owner::Near { account_id }` | `0x00` ‖ borsh(account_id as String) |
| `Owner::Oidc { provider, sub }` | `0x01` ‖ borsh(provider) ‖ borsh(sub) |
| `Change::AddClient { provider, aud }` | `0x00` ‖ borsh(provider) ‖ borsh(aud) |
| `Change::SetOwners { owners }` | `0x01` ‖ borsh(Vec<Owner>) |
| `Change::SetAllowShared { allow }` | `0x02` ‖ allow (`0x00` / `0x01`) |

### Worked examples

Generated by `node contracts/hana-signer/scripts/gen-fixtures.mjs --doc` (also stored under `layouts` in
`src/test_fixture.json`, which the Rust tests check). Each line is one field in hex; the preimage is the lines
concatenated in order, and `nonce = b64url(sha256(preimage))`. Signer account id `hana-signer.testnet`; client ids
are `app-c.apps.googleusercontent.com` etc.; the session key is the Ed25519 public key of the 32-byte seed `07…07`.

**Session nonce: scope s1, session key = Ed25519 public key of seed [7; 32], expires 1800003600000, key_index 0, max_uses 3, salt [9; 16]**

```
domain "hana-id/session/v1"           68616e612d69642f73657373696f6e2f7631
borsh(signer) "hana-signer.testnet"   1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                  020000007331
session_public_key (32 bytes)         ea4a6c63e29c520abef5507b132ec5f9954776aebebe7b92421eea691446d22c
expires_at_ms u64 LE (1800003600000)  803e9318a3010000
key_index u32 LE (0)                  00000000
max_uses u32 LE (3)                   03000000
salt (16 bytes)                       09090909090909090909090909090909
nonce                                 ZibEIOYJ7wXdsxU_7hIdD_speAW8z7cmSgoIh8XexsE
```

**Register proof: owners [Oidc google/owner-111, Near carol.testnet], clients [google app-c], allow_shared false**

```
domain "hana-id/register/v1"         68616e612d69642f72656769737465722f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(owners) (2)                    020000000106000000676f6f676c65090000006f776e65722d313131000d0000006361726f6c2e746573746e6574
borsh(clients) (1)                   0100000006000000676f6f676c65200000006170702d632e617070732e676f6f676c6575736572636f6e74656e742e636f6d
allow_shared u8 (false)              00
nonce                                WcMdJbl3q0qXzEVxgYB-yX8eFV2ejKVwZpNss9giSIw
```

**Client proof: scope s1, action_nonce 0**

```
domain "hana-id/client-proof/v1"     68616e612d69642f636c69656e742d70726f6f662f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
action_nonce u64 LE (0)              0000000000000000
nonce                                5nh7P_dNPCQFltyJ0cTH6EiLvBkSYapJXxZs_c8N3hk
```

**Owner action: remove_client(s1, google, app-a2), action_nonce 0**

```
domain "hana-id/owner-action/v1"     68616e612d69642f6f776e65722d616374696f6e2f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
borsh(method) "remove_client"        0d00000072656d6f76655f636c69656e74
borsh(args without auth)             02000000733106000000676f6f676c65210000006170702d61322e617070732e676f6f676c6575736572636f6e74656e742e636f6d
action_nonce u64 LE (0)              0000000000000000
nonce                                Wmis02hrYwgcGDlFuifhD_Sj-mxZYzcxsCnOfKwtf9M
```

**Owner action: propose_change(s1, {"SetAllowShared":{"allow":true}}, null), action_nonce 0**

```
domain "hana-id/owner-action/v1"     68616e612d69642f6f776e65722d616374696f6e2f7631
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                 020000007331
borsh(method) "propose_change"       0e00000070726f706f73655f6368616e6765
borsh(args without auth)             020000007331020100
action_nonce u64 LE (0)              0000000000000000
nonce                                dtFhwpx29WjdMb_v1mjn62mMAnCK5l9vzYgr3ncOloI
```

**Owner action: disable_shared_login(s1), action_nonce 1**

```
domain "hana-id/owner-action/v1"      68616e612d69642f6f776e65722d616374696f6e2f7631
borsh(signer) "hana-signer.testnet"   1300000068616e612d7369676e65722e746573746e6574
borsh(scope_id) "s1"                  020000007331
borsh(method) "disable_shared_login"  1400000064697361626c655f7368617265645f6c6f67696e
borsh(args without auth)              020000007331
action_nonce u64 LE (1)               0100000000000000
nonce                                 PSxo7hRPOnC6VHSCKt4xP05Z11_0pHcXnFx6KdhDkMI
```

**CKD payload: pk1 "bls12381g1:A", pk2 "bls12381g2:B"**

```
"hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2  68616e612d69642d636b642d76313a626c73313233383167313a413a626c73313233383167323a42
```

**Session message for derive_key: counter 1, payload = the CKD payload above**

```
domain "hana-id-session-v1:"  68616e612d69642d73657373696f6e2d76313a
counter u64 LE (1)            0100000000000000
sha256(payload)               0960891c21e35062fd240c1bed987623f83ee726cad22b05e2f450e7a3100f14
```

**Session message for revoke_session: counter 2, payload "revoke"**

```
domain "hana-id-session-v1:"  68616e612d69642d73657373696f6e2d76313a
counter u64 LE (2)            0200000000000000
sha256(payload)               777ac4ea0a6e6f4d1301fd1cf8aa9183f44f435be43c75a6615ba307c266e5a7
```

**Vault message (off-chain only, never a session message): app "app_test", shareId 01…10, counter 1, payload "unlock"**

```
domain "hana-id-vault-v1:"           68616e612d69642d7661756c742d76313a
borsh(signer) "hana-signer.testnet"  1300000068616e612d7369676e65722e746573746e6574
borsh(appId) "app_test"              080000006170705f74657374
shareId (16 bytes)                   0102030405060708090a0b0c0d0e0f10
counter u64 LE (1)                   0100000000000000
sha256(payload)                      787600ebe6d6c75b6bc0b2db0bfd6aeec78897b67d3192e2208bc8b714237841
```

## Methods

Caller roles: **owner** = `config.owner` (Hana admin; a Sputnik DAO council outside local envs, see
[Owner = Sputnik DAO](#owner--sputnik-dao)), **self** = the contract account itself (its updater key, a
function-call key the contract installed), **watchdog** = an account in `get_governance().watchdogs`, **scope
owner** = authenticated via `OwnerAuth`, **anyone**.

### Init

#### `new(owner, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs, updater_keys)` — init, once

```json
{"owner":"hana-council.sputnik-dao.near","mpc":"v1.signer-prod.testnet","ckd_domain_id":2,"change_delay_ms":172800000,
 "issuer_key_delay_ms":7200000,"governance_delay_ms":259200000,
 "watchdogs":["hana-id-watchdog.near"],"updater_keys":["ed25519:6E8s..."]}
```

Panics: `change_delay_ms must be at most 7 days`, `issuer_key_delay_ms must be at most 7 days`,
`governance_delay_ms must be at most 30 days`, `Too many watchdogs` (> 3), `Already a watchdog` (duplicate),
`Too many updater keys` (> 2), `Already an updater key` (duplicate). Starts with no issuers, no scopes,
`public_registration = false`, no sponsors, no console audiences, no shared clients, `paused = false`,
`state_version = 3`, no self-issued issuer, no accounts. Watchdogs given here may confirm at once (`confirm_from_ms = 0`). Each updater key is added to
the contract account by the contract itself, exactly as `add_updater_key` does (a promise; the key is pending until
the callback confirms its `AddKey` succeeded, and dropped if it failed), so the mainnet creation batch is `DeployContract` + `new(...)` + `DeleteKey(creation
key)`, signed by the creation key, with no `AddKey` action of its own (see [Changed in the governance
batch](#changed-in-the-governance-batch) for why this differs from the spec draft).

### Config (owner only, `Only the owner can do this`)

| Method | Args example | Notes |
|---|---|---|
| `set_sponsors(sponsors)` | `{"sponsors":["relayer.testnet"]}` | Replaces the list. ≤ 10 (`Too many sponsors`). Function-call access keys can't attach deposits, so a relayer calling `register_scope` / `propose_change` with such a key must be a sponsor. |
| `set_console_audiences(audiences)` | `{"audiences":[["google","console.apps.googleusercontent.com"]]}` | Replaces the target list (≤ 10, `Too many console audiences`; `Invalid provider`, `Invalid aud`, `Duplicate console audience`). Audiences dropped from the list stop counting **at once**; new ones are **pending** until `now + change_delay_ms` (D86), the same window a new shared client gets, since a console audience's tokens authorise OIDC owner actions. Pending ones already in the list keep their `effective_at_ms`. The owner-token check counts only audiences in force. Event `console_audiences_set` (lists after the call). |
| `set_change_delay_ms(change_delay_ms)` | `{"change_delay_ms":172800000}` | ≤ 7 days. An increase applies now. A **decrease** applies only after the current delay has passed (`pending_change_delay`), so the admin can't shorten a timelock to act on scopes faster than owners were promised. Already queued changes keep their `unlock_at_ms`. |
| `enable_public_registration()` | `{}` | One way: false → true, never back. No-op if already true. Event `public_registration_enabled`. |
| `set_shared_clients(clients)` | `{"clients":[["google","hana-shared.apps.googleusercontent.com"]]}` | Replaces the shared-client list (see below). |

`set_owner` is **gone** (`MethodNotFound`): the owner changes only through `propose_owner` / `accept_owner`
([Owner transfer](#owner-transfer)). The delays `issuer_key_delay_ms` and `governance_delay_ms` are set under
[Delays](#delays).

Not owner-only: `apply_pending_config()` (`{}`, **anyone**) folds matured pending config into state: pending shared
clients and console audiences whose `effective_at_ms` has passed, and pending decreases of `change_delay_ms`,
`issuer_key_delay_ms` and `governance_delay_ms` whose time has come. Nothing depends on calling it: every read and
check already treats matured entries as in force ("lazy").

Views: `get_config()` → Config.

#### Shared clients

A **shared client** is a `(provider, aud)` Hana runs for partners without their own OAuth client (since batch B its
only redirect URI is Hana's `{authOrigin}/login/callback`). Its tokens are not tied to one scope: `create_session`
(and `create_session_and_derive`) takes the scope from its `scope_id` argument, which the session nonce commits to,
and accepts it only for scopes with `allow_shared`. Hana's vault computes that nonce only for a parent page the app
allows (see Security notes).

`set_shared_clients(clients)`, owner only, sets the target list (≤ 5, `Too many shared clients`):

- Clients in force now but not in the list are **removed at once**; pending ones not in the list are dropped.
- Clients not in force and not pending become **pending** with `effective_at_ms = now + change_delay_ms` (the delay
  in force now). Pending clients already in the list keep their `effective_at_ms`. `get_config()` shows them in
  `pending_shared_clients` until then, and in `shared_clients` from then on. In-force order is the order they took
  effect (`effective_at_ms`, ties in the order they were added); it is the same whether or not anyone has called
  `apply_pending_config`, so "the first shared client" is well defined.
- Each client: `Invalid provider`, `Invalid aud`, `Unknown issuer` (provider must be a configured issuer),
  `Duplicate shared client`, `Client is already registered` (it is a client of some scope),
  `Client was recently removed from another scope` (quarantined by a `remove_client`: until its `free_at_ms`, or
  longer while the old scope's re-add is pending, see `remove_client`), `Client is pending in a scope` (some scope has
  a pending `AddClient` for it; the listing works again once every such change is executed or cancelled).
- Disjointness also holds the other way: a client that is shared **or pending shared** can never become a scope
  client (`Client is a shared client` from `admin_register_scope`, `register_scope`, `propose_change(AddClient)` and
  `execute_change(AddClient)`).
- Event `shared_clients_set` with the resulting lists.

### Issuers

| Method | Who | Args example |
|---|---|---|
| `set_issuer(provider, iss_values)` | owner | `{"provider":"google","iss_values":["https://accounts.google.com","accounts.google.com"]}` |
| `set_issuer_key(provider, kid, n, e, signer)` | owner **or self** (owner only for a self-issued issuer) | `{"provider":"google","kid":"a1b2","n":"<JWK n, base64url>","e":"AQAB"}` → returns the key change id (`u64`). `signer` (optional, absent = `null`) is required for a self-issued issuer and refused for any other: `{"provider":"email","kid":"<thumbprint>","n":"…","e":"AQAB","signer":"hana"}` |
| `mark_self_issued(provider)` | owner | `{"provider":"email"}` (one way) |
| `get_self_issued(provider)` | view | → signer policy (Types above) or `null` |
| `propose_issuer_key_removal(provider, kid)` | owner **or self** | `{"provider":"google","kid":"a1b2"}` → returns the key change id |
| `execute_issuer_key_change(id)` | **anyone**, once due, not while paused | `{"id":7}` |
| `confirm_issuer_key_change(id)` | a watchdog whose `confirm_from_ms ≤ now` | `{"id":7}` |
| `cancel_issuer_key_change(id)` | owner or any watchdog | `{"id":7}` |
| `remove_issuer_key(provider, kid)` | **owner only** | `{"provider":"google","kid":"a1b2"}` → returns `true` if an active key was removed |
| `get_issuer(provider)` | view | → Issuer (active kids) or `null` |
| `get_issuer_keys(provider)` | view | → `[{"kid","n","e"}]` (active keys with their material, JWK base64url, leading zeros stripped, kid order) or `null` for an unknown issuer. For the watchdog's active-key check (`docs/governance-spec.md` step 5); `verify_token` doesn't use it |
| `get_key_changes()` | view | → pending key changes (Types above) |

Issuer keys enter or leave the active set only through a public, cancellable delay (D33): a posted change waits
`issuer_key_delay_ms` (anyone may then execute it) unless a watchdog that checked it against the issuer's published
JWKS confirms it earlier; the owner or any watchdog cancels. Only the owner removes a key at once. `verify_token`
reads active keys only, so logins cost the same gas as before.

- `set_issuer` creates or updates; keys are kept on update. Each iss value 1..=256 bytes, 1..=4 values, and no iss
  value may belong to another provider (`iss value already used by another provider`).
- `set_issuer_key` **queues** an `Add`. Validation as before: `Invalid kid` (empty or > 128 bytes), `n`, `e` JWK
  base64url (plain base64 also accepted; `Malformed key component`), RSA modulus 2048..=4096 bits after stripping
  leading zeros (`RSA modulus must be 2048-4096 bits`), exponent 1..=8 bytes, odd, > 1 (`Invalid RSA exponent`),
  issuer must exist (`Unknown issuer`). Then: `Kid is already active` (an active kid is never overwritten: remove
  it first), `Kid already has a pending change` (one pending change per provider and kid), `Too many pending key
  changes` (6 over all issuers), `Too many keys for this issuer` (active + pending additions ≤ 10). The owner's posts
  wait like the updater's (D86). Event `issuer_key_proposed` (with `n`, `e` base64url, so a monitor can compare with
  the JWKS without a view).
- Every proposal gets `executable_at_ms = max(now + issuer_key_delay_ms, keys_slow_until_ms, no watchdog ? now +
  governance_delay_ms : 0)`, where "no watchdog" means no watchdog may confirm yet (none, or only ones whose
  `confirm_from_ms` is still ahead): with no watchdog that has been public for the governance delay, nothing activates
  faster than an upgrade could. So adding a first watchdog (possibly a compromised owner's yes-man) doesn't shorten new
  key changes until its confirm power starts; changes queued meanwhile keep their longer time.
- `propose_issuer_key_removal` queues a `Remove`: `Unknown issuer`, `No such key` (kid not active), `Kid already has
  a pending change`, `Too many pending key changes`, `Cannot remove the last key of an issuer` (active keys minus
  pending removals must stay ≥ 1, so a stuck sync never empties the registry). Event `issuer_key_removal_proposed`.
- `execute_issuer_key_change`: `Paused`, `No such key change`, `Key change is still delayed`, then re-checks against
  the current keys (`Add`: `Unknown issuer`, `Kid is already active`, `Too many keys for this issuer`; `Remove`: `No
  such key`, `Cannot remove the last key of an issuer`). On a failed re-check nothing changes and the change stays
  pending until cancelled. Applies and drops the change; event `issuer_key_set` / `issuer_key_removed` with `how:
  "delay"`. The updater key may call it (the API executes matured changes).
- `confirm_issuer_key_change`: `Only a watchdog can do this`, `This watchdog can't confirm yet` (a watchdog added by
  `add_watchdog` may confirm only from `now + governance_delay_ms`), `No such key change`, then the same re-checks.
  Applies at once, **also while paused** (a checked Google key may go live while frozen). Event with `how:
  "confirmed"` and `by`.
- `cancel_issuer_key_change`: `Only the owner or a watchdog can do this` (a watchdog that can't confirm yet may still
  cancel), `No such key change`. Event `issuer_key_change_cancelled`.
- `remove_issuer_key`: owner only (`Only the owner can do this`; no longer self), `Unknown issuer`. Immediate; may
  remove an issuer's **last** key (a deliberate owner action: DoS only). Also drops a pending change for that kid
  (event `issuer_key_change_cancelled` with `by` = the owner). Returns `false` if the kid wasn't active. Event
  `issuer_key_removed {provider, kid, how: "owner"}` only when an active key was removed.
- Other panics: `Only the owner or the contract account can do this` (propose methods), `Invalid provider`,
  `An issuer needs 1 to 4 iss values`, `Invalid iss value` (empty or > 256 bytes), `Duplicate iss value`.

#### Self-issued issuers (email login, D121)

An issuer whose keys Hana itself holds (the email issuer) is marked **self-issued**, one way. Hana could mint any
user's token with such a key, so the contract bounds who installs its keys and how tokens are signed:

- `mark_self_issued(provider)`: owner (`Only the owner can do this`), `Invalid provider`, `Only the email issuer can
  be self-issued` (`SELF_ISSUABLE = ["email"]`, D134: marking Google, for instance after removing its keys, would stop
  every Google login until a governed upgrade), `Unknown issuer`, `Issuer is already self-issued` (a second call can't
  reset a policy), `Issuer already has keys` (active or pending: every key of a self-issued issuer is posted under the
  rules below, with its signer). Sets the policy `{signers: ["hana"], required: 1}`. Event `issuer_self_issued
  {provider}`.
- `set_issuer_key` for it: `Only the owner posts keys for this issuer` (the updater key, "self", is refused; so is its
  `propose_issuer_key_removal`), `Unknown signer` (`signer` missing or not in the policy), `Too many keys for this
  issuer` (8, active + pending additions), `Key is already registered` (the modulus of an active or pending key of the
  issuer, whatever the exponent or signer: one RSA key never counts as two signers). For any other issuer `signer`
  must be absent (`Only a self-issued issuer takes a signer`). Event `issuer_key_proposed` gains `signer`.
- Its key changes wait at least `governance_delay_ms` on top of the usual rule (`executable_at_ms = max(the rule
  above, now + governance_delay_ms)`), and `confirm_issuer_key_change` refuses them (`Keys of a self-issued issuer
  can't be confirmed early`): no outside JWKS vouches for Hana's keys, so the watchdog can only cancel (it pins every
  signer's thumbprints). The owner and watchdogs cancel as usual; `remove_issuer_key` stays immediate (DoS only).
  Executing an addition re-checks `Key is already registered` and `Unknown signer`.
- **Signer policy.** `signers` (≤ 3 ids, each with its active keys) and `required` (distinct signers a token needs).
  Its tokens are JWS JSON ([Token verification](#token-verification-all-methods-that-take-a-jwt)). **No method changes
  the signer list or `required`**: only a governed upgrade's `migrate` does (internal `set_signer_policy(provider,
  signers, required, new_keys, overlap)`: 1..=3 distinct signer ids, `required` 1..=signers, new keys installed with
  their signers and checked exactly as `set_issuer_key` checks keys (leading zeros stripped, 2048–4096 bits, odd
  exponent other than 1, a modulus new to the issuer: a zero-padded copy of a key can't pose as a second signer); event
  `signer_policy_set {provider, signers, required, overlap_until_ms}`). With `overlap = true` (adding a signer, Level
  1) it opens a 10-minute overlap (`overlap_until_ms = now + 600 000`, the email token lifetime) during which tokens
  satisfying the previous policy still pass; signers dropped from the policy keep their keys (still listed by
  `get_issuer_keys`, never counted once the overlap ends) until the owner removes them. With `overlap = false`
  (replacing a compromised signer) there is no overlap, every dropped signer's keys are removed at once (D136), and
  new keys may only go to signer ids the previous policy didn't list (`A replacing policy adds keys only for new signer
  ids`: keeping the id `cosign` with a new key would leave the compromised old `cosign` key counting). Either way,
  pending key additions (`AddForSigner`) of signers that leave the policy are cancelled (`issuer_key_change_cancelled`
  with `by` = the contract), so they can't revive if a later upgrade lists the id again (D138).
  1-of-1 at launch; Level 1 (a co-signer, 2-of-2) is one such upgrade, public for `governance_delay_ms`.
- `get_self_issued(provider)` → `{provider, signers: [{id, kids}], required, overlap_until_ms}` (`overlap_until_ms`
  only while the overlap lasts), `null` for a provider that isn't self-issued. The watchdog pins it.

### Governance

#### Delays

| Method | Who | Args example | Notes |
|---|---|---|---|
| `set_issuer_key_delay_ms(issuer_key_delay_ms)` | owner | `{"issuer_key_delay_ms":7200000}` | ≤ 7 days (`issuer_key_delay_ms must be at most 7 days`). An increase applies now; a **decrease** applies after `governance_delay_ms` (`pending_issuer_key_delay`). Queued key changes keep their `executable_at_ms`. |
| `set_governance_delay_ms(governance_delay_ms)` | owner | `{"governance_delay_ms":259200000}` | ≤ 30 days (`governance_delay_ms must be at most 30 days`). An increase applies now; a decrease after the **current** governance delay. Queued upgrades, owner transfers and withdrawals keep their times. |

Both emit `delay_changed {which: "issuer_key" | "governance", value_ms, effective_at_ms}` (`effective_at_ms` = now
for an increase). An increase also cancels a pending decrease. `change_delay_ms` is unchanged. Values: sandbox-dev
120 000 / 60 000; mainnet 7 200 000 (provisional, D80) / 259 200 000.

#### Watchdogs

| Method | Who | Args example | Notes |
|---|---|---|---|
| `add_watchdog(account_id)` | owner | `{"account_id":"hana-id-watchdog-dev1.testnet"}` | ≤ 3 (`Too many watchdogs`), `Already a watchdog`. Cancel, pause and updater-key deletion apply at once (DoS only); confirm power from `confirm_from_ms = now + governance_delay_ms`, so a compromised owner can't add a yes-man that confirms a forged key faster than an upgrade. Event `watchdog_added {account_id, confirm_from_ms}`. |
| `remove_watchdog(account_id)` | owner | `{"account_id":"hana-id-watchdog-dev1.testnet"}` | Immediate (`Not a watchdog`). Sets `keys_slow_until_ms = max(keys_slow_until_ms, now + governance_delay_ms)` and raises every pending key change's `executable_at_ms` to at least that: silencing the watchdogs never installs a key faster than an upgrade. A remaining watchdog's confirmations still activate keys early. Event `watchdog_removed {account_id, keys_slow_until_ms}`. |

#### Pause

| Method | Who | Notes |
|---|---|---|
| `pause()` | owner or any watchdog | Sets `paused`. No-op if already paused. Event `paused {by}`. The watchdog pauses on its own only when a key Google doesn't publish is active on chain (D82). |
| `unpause()` | owner only | At once, no governance delay (D82). No-op if not paused. Sets `unpaused_at_ms = now` and `changes_unlock_floor_ms = max(itself, now + change_delay_ms)`: no `execute_change` before then, so every scope change pending across the pause gets a full timelock after it (OIDC owners can't cancel while paused). Event `unpaused {changes_unlock_floor_ms}`. |
| `set_sessions_valid_from_ms(sessions_valid_from_ms)` | owner only | `{"sessions_valid_from_ms":1800000060001}`. Sessions opened before it can't derive (`No such session`), can't be revoked, and `get_session` returns `null` for them; their keys stay in use until they expire. Raised only (`sessions_valid_from_ms can only be raised`), never past the block time (`sessions_valid_from_ms can't be in the future`). Allowed while paused. For a forged issuer key that was active: set it just after the pause (no session opens while paused) before unpausing, or the sessions the key opened keep deriving for up to `MAX_SESSION_MS` (docs/operations.md, `forged_active_key`). A session opened by v1 code (no stored creation time) counts as opened at `expires_at_ms − MAX_SESSION_MS`, the earliest it can have been. Event `sessions_valid_from_set {sessions_valid_from_ms}`. |

While paused these panic `Paused` (checked first): every token path (`verify_token`, so `create_session`,
`create_session_and_derive`, `register_scope` (also without proofs), `propose_change` with a client proof and every
`OwnerAuth::Oidc` action), `derive_key`, and the executors `execute_change`, `execute_issuer_key_change`,
`execute_withdrawal` (nothing that may rest on a forged token matures into force while frozen). Still allowed:
`confirm_issuer_key_change`, `cancel_issuer_key_change`, key proposals, `revoke_session`, `prune_sessions`,
`OwnerAuth::Near` actions without a token, every owner and governance method (including `execute_upgrade` and
`accept_owner`), views. Pause can't post keys, change code or move anything: the worst it does is stop logins until
the owner unpauses.

Pausing alone doesn't undo what a forged key already did: sessions it opened derive again after the unpause unless the
owner raises `sessions_valid_from_ms` past the pause first, and scope changes proposed with its tokens wait a full
`change_delay_ms` after the unpause (`changes_unlock_floor_ms`) for their OIDC owners to cancel.

#### Updater keys

The signer account manages its own access keys: outside sandbox-dev it has no full-access key, so only the contract
can add or delete keys on it.

| Method | Who | Args example | Notes |
|---|---|---|---|
| `add_updater_key(public_key)` | owner | `{"public_key":"ed25519:6E8s..."}` | ≤ 2 keys, pending and confirmed together (`Too many updater keys`), `Already an updater key` (either list). Adds the key to the contract account as a function-call key with exactly `UPDATER_METHODS` = `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`, receiver the contract account, allowance 1 NEAR. Method list, receiver and allowance are constants: the contract can never add a full-access key or a key for any other method. The key is in `pending_updater_keys` until the `AddKey` receipt resolves. Returns (via its callback `on_updater_key_added`, `#[private]`) `true` if the `AddKey` succeeded, and the callback moves the key to `updater_keys`; on failure (e.g. the key is already on the account, with any permission, possibly as a full-access key) the callback drops it, emits `updater_key_add_failed {public_key}` and returns `false`. Event `updater_key_added {public_key}` when requested. |
| `delete_updater_key(public_key)` | owner or any watchdog | `{"public_key":"ed25519:6E8s..."}` | `DeleteKey` on the contract account. A watchdog may delete only confirmed keys in `updater_keys` (`Not an updater key`), never a pending one: until its `AddKey` succeeds the key may be one already on the account with another permission. The owner may delete any key on the account (cleanup of an untracked key without a full-access key); deleting a pending key also drops it, so its callback never tracks it. Event `updater_key_deleted {public_key, by}`. The watchdog deletes every updater key the moment it sees a forged proposal from the contract account (one call per key, or one transaction with two actions). |

`updater_keys` lists the keys whose `AddKey` succeeded; deploy tooling compares it (and `updater_methods`) with
`view_access_key_list` and treats any other key as a blocker.

#### Upgrades

| Method | Who | Args | Notes |
|---|---|---|---|
| `propose_upgrade(code_hash)` | owner | `{"code_hash":"8Tf3..."}` (base58 sha256 of the wasm, NEAR's account `code_hash` format) | `executable_at_ms = now + governance_delay_ms`. Replaces a pending upgrade (event `upgrade_cancelled` for the old one). Event `upgrade_proposed {code_hash, executable_at_ms}`. Nobody but the owner can cancel (no guardian at launch, D84). Mainnet: a reproducible build whose hash, commit and build command are published first (D86). |
| `cancel_upgrade()` | owner | `{}` | `No pending upgrade`. Event `upgrade_cancelled {code_hash}`. |
| `execute_upgrade()` | **anyone**, once due | **raw wasm bytes** as the input (not JSON) | `No pending upgrade`, `Upgrade is still delayed`, `Code doesn't match the proposed hash` (`sha256(input)`). Not blocked by pause (a fix must be deployable). Clears `pending_upgrade`, emits `upgrade_executed {code_hash}`, and returns one promise to the contract account with two actions: `DeployContract(code)` then `FunctionCall migrate({}, 0 deposit, 50 Tgas)`. They are one receipt: if the new code's `migrate` panics (or doesn't exist), the deploy is rolled back with it and the old code stays. The pending upgrade is consumed either way (re-propose a fixed build); `upgrade_executed` is logged by the committed execute receipt, so success is the deploy receipt's outcome, `state_migrated` in its logs, and `view_account.code_hash`. Attach 300 Tgas; the transaction must fit NEAR's 1.5 MiB limit; the account balance must cover the new code's storage. |
| `migrate()` | the contract account only (`#[private]`, `#[init(ignore_state)]`) | — | Called by `execute_upgrade`'s deploy receipt on the **new** code. This version (layout v3): on a v2 state (the exact v2 root struct, `src/migrate.rs` `HanaSignerV2`, checked against a v2 state fixture built by the v2 code) with `state_version == 2`, keeps every field and appends the v3 ones empty (no self-issued issuer, no account, nothing in `opened`) with `unrecorded_wallets = true` (links wait for `accept_unrecorded_wallets`, D135), event `state_migrated {from_version: 2, to_version: 3}`; on a v3 state with `state_version == 3` (a later v3 fix), keeps it, event `{3, 3}`; anything else panics `Unexpected state version`, reverting the deploy. A v3 state doesn't parse as v2, so a later upgrade back to v2 code fails in v2's `migrate` and is reverted (the way back is a fixed v3). Each future version ships its own `migrate` reading a copy of the previous layout. |

There is no v1 migration any more: `migrate_v1` and the v1 layout copy were removed with v3 (build-plan batch 2), since
no deployment is on v1 (sandbox-dev is v2); `deploy-contract` refuses a v1 contract (D154).

**v2 → v3** (sandbox, `contracts/integration-tests/tests/governance.rs`
`v2_to_v3_upgrade_through_the_dao_keeps_every_view_and_path`, 2026-11-02): from a v2 deployment built by the v2 code
(`V2_COMMIT` = develop 26fb70a; `cargo near build non-reproducible-wasm --no-abi` of it, as `deploy-contract` builds,
gives sandbox-dev's code hash `3TSDwkMqPUhZtzFCvvaJ39nQWXUQK4LExPhsaS9tScoz` on the machine that deployed it) owned
by a 2-of-3 Sputnik DAO: `propose_upgrade` through the DAO, `execute_upgrade` by anyone once due, `state_migrated
{2, 3}`. Every v2 view is unchanged (`get_config` only gains `unrecorded_wallets: true`, `get_governance` only
changes `state_version`), sessions, pending changes and pending key proposals survive, every path stays (old
sessions and new logins derive the v2 paths), and so does the state no view shows: a removed client's quarantine,
a pending AddClient's reservation (`pending_adds`: it can't be made shared), the scope counter (the next
registration gets the next id) and the session queue (`prune_sessions` removes the v2 sessions once expired). Links fail `Links wait until the owner accepts the wallets opened before
v3` until the DAO calls `accept_unrecorded_wallets`; the email issuer and an email client are then set up through
the DAO and the scope owner; the v2 code can't be upgraded back (its `migrate` panics `Unexpected state version`).

Gas (sandbox): `execute_upgrade` of the 611.0 KB v3 wasm built as `deploy-contract` builds it (`--no-abi`, the
artifact the upgrade test runs) burns 100 Tgas over all receipts, 29 of them in the execute receipt (attach 300);
v3 → v3 with the 621.8 KB build with its ABI burns 102. Logins on v3
against v2 (Google, no link, mock MPC, `login_gas_of_v3_against_v2`; the test fails above +3 Tgas):
`create_session_and_derive` 22.1 → 22.6 Tgas at an identity's first login (the `opened` insert) and 22.2 → 22.5
later; `create_session` 19.8 → 20.4 Tgas (with the proof of possession, D137). The spec's +1–2 Tgas estimate holds
(+0.3 to +0.6 Tgas).

#### Owner transfer

| Method | Who | Notes |
|---|---|---|
| `propose_owner(owner)` | owner | `{"owner":"hana-council.sputnikv2.testnet"}`. `acceptable_at_ms = now + governance_delay_ms`; replaces a pending proposal (`owner_proposal_cancelled {owner}` for the old one first, as `propose_upgrade` and `propose_withdrawal` do). Event `owner_proposed {owner, acceptable_at_ms}`. |
| `cancel_owner_proposal()` | owner | `No pending owner change`. Event `owner_proposal_cancelled {owner}`. |
| `accept_owner()` | the proposed account | `Not the proposed owner` (also when nothing is pending), `Owner change is still delayed`. Proves the new owner (a DAO) can call the contract before it gets control. Event `owner_changed {old, new}`. |

#### Surplus withdrawal (D86)

| Method | Who | Notes |
|---|---|---|
| `propose_withdrawal(receiver, amount)` | owner | `{"receiver":"hana-id-ops.testnet","amount":"10000000000000000000000000"}` (yoctoNEAR string). `Withdrawal amount must be positive`. `executable_at_ms = now + governance_delay_ms`; replaces a pending one (`withdrawal_cancelled` for the old one). Event `withdrawal_proposed {receiver, amount, executable_at_ms}`. |
| `cancel_withdrawal()` | owner | `No pending withdrawal`. Event `withdrawal_cancelled {receiver, amount}`. |
| `execute_withdrawal()` | **anyone**, once due | `No pending withdrawal`, `Withdrawal is still delayed`, `Paused`, `Withdrawal would leave too little` unless `account_balance − amount ≥ storage_usage × storage_byte_cost + SIGNER_RESERVE` (5 NEAR, provisional), checked at execution. Transfers `amount` to `receiver`. Event `withdrawal_executed {receiver, amount}`. |

#### Governance views

| Method | Returns |
|---|---|
| `get_governance()` | Governance (Types above) |
| `get_key_changes()` | pending key changes (Types above) |
| `get_config()` | Config, including the delays in force, pending decreases, `paused`, `unpaused_at_ms`, `changes_unlock_floor_ms`, `sessions_valid_from_ms` and pending console audiences |

#### Owner = Sputnik DAO

The owner is a Sputnik DAO v2 account (D81): the wasm and the policy are pinned in `contracts/sputnik/`
(`pin.json`: commit, sha256 and `code_hash` of the code the testnet factory deploys; `policy.json`: one `council`
role, 2 of 3 votes for every proposal kind, no `Everyone` role, no `RemoveProposal`). Each owner call is a DAO
`FunctionCall` proposal to the signer (method, base64 JSON args, 0 deposit, 100 Tgas), executed when the second
vote lands; the contract checks only `predecessor == owner`. A proposal whose call panics in the contract ends
`Failed` in the DAO.

### Registry

#### `admin_register_scope(owners, clients, scope_id, allow_shared)` — owner, only while `public_registration == false`

```json
{"owners":[{"Near":{"account_id":"hana-id-admin-dev1.testnet"}}],
 "clients":[["google","123-abc.apps.googleusercontent.com"]],
 "scope_id":"global","allow_shared":false}
```

`scope_id`: `null` (contract assigns `sN`) or `"global"` (only allowed value). `allow_shared` (required bool):
whether shared-client tokens may log in to this scope; `clients` may be `[]` when it is `true`. Returns the scope id
(`"s1"`).
No proofs. Contract pays storage. Panics: `Admin registration is closed: public registration is enabled`,
`Only "global" can be chosen as a scope id`, `Scope already exists`, owner/client validation (below).
Event `scope_registered`.

#### `register_scope(owners, client_proofs, allow_shared)` — anyone, only while `public_registration == true`, payable

```json
{"owners":[{"Oidc":{"provider":"google","sub":"1102..."}}],"client_proofs":["eyJ...","eyJ..."],"allow_shared":false}
{"owners":[{"Near":{"account_id":"partner.testnet"}}],"client_proofs":[],"allow_shared":true}
```

Each proof is a verified token whose nonce is the Register proof above (committing to the owners, the full client
list in `client_proofs` order, and `allow_shared`); the clients are the proofs' `(provider, aud)`. `client_proofs`
may be empty only when `allow_shared` is true (a shared-only scope needs no proof: scope ids are contract-assigned,
so there is nothing to squat). Returns the scope id. Client validation (below) runs before the nonce check. Storage: the caller attaches ≥ the storage the call adds
(`bytes × storage_byte_cost`: 263 bytes ≈ 0.0026 NEAR for one client and two owners; attach 0.01 NEAR); the excess is refunded to the caller. Callers in
`sponsors` are exempt and any deposit they attach is refunded in full. A **shared-only** registration (`client_proofs:
[]`) by a non-sponsor also prepays `2 × 1501 = 3002` bytes, the most that sponsors may later queue for free on a scope
without clients (see `propose_change`): ≈ 3104 bytes ≈ 0.031 NEAR in all for one NEAR owner; attach 0.05 NEAR.
Panics: `Paused` (first, with or without proofs), `Public registration is not enabled`,
`Proof nonce doesn't commit to this registration`, `Attached deposit doesn't cover storage: need N yoctoNEAR`, plus
client/owner validation. Event `scope_registered`.

Owner validation: 1..=5 owners (`A scope needs 1 to 5 owners`), no duplicates (`Duplicate owner`), valid provider and
sub for `Oidc` owners. Client validation: ≤ 10 (`A scope has at most 10 clients`), at least one unless
`allow_shared` (`A scope needs a client or shared login`), valid provider and aud (`Invalid provider`, `Invalid aud`),
provider must be a configured issuer (`Unknown issuer`), no duplicates (`Duplicate client`), not registered anywhere
(`Client is already registered`), not a shared or pending shared client (`Client is a shared client`), not
quarantined after a `remove_client` (`Client was recently removed from another scope`). All of it applies to
`admin_register_scope` too.

#### `propose_change(scope_id, auth, change, client_proof)` — scope owner, payable

```json
{"scope_id":"s1","auth":"Near",
 "change":{"AddClient":{"provider":"google","aud":"456-def.apps.googleusercontent.com"}},
 "client_proof":"eyJ..."}
{"scope_id":"s1","auth":"Near","change":{"SetAllowShared":{"allow":true}},"client_proof":null}
```

Returns the change id (`u64`, = the scope's `action_nonce` before the call; unique within the scope). Queues the
change with `unlock_at_ms = now + change_delay_ms`. Increments `action_nonce`.

- `AddClient` needs `client_proof` (`AddClient needs a client_proof`; Client proof above, token `(provider, aud)` must equal the change:
  `Client proof is for another client`, `Client proof nonce doesn't match`); the client must not be registered
  anywhere (`Client is already registered`), not a shared or pending shared client (`Client is a shared client`), not
  quarantined by a removal from **another** scope (`Client was recently removed from another scope`; the scope it was
  removed from may re-add it at once, and a re-add proposed before `free_at_ms` keeps the client reserved for this
  scope until it is executed or cancelled), not already pending in this scope (`Client is already pending`), and the
  scope must have room (`A scope has at most 10 clients`). While pending, the client can't be made a shared client.
- `SetOwners`: owners validated as above; `client_proof` must be `null` (`client_proof is only for AddClient`).
- `SetAllowShared`: the only way to **enable** shared login on an existing scope (timelocked, so co-owners can cancel).
  `allow` must be `true` (`SetAllowShared can only enable shared login; use disable_shared_login`); panics
  `Shared login is already enabled`, `Change is already pending`; `client_proof` must be `null`.
- ≤ 10 pending (`Too many pending changes`). On a scope without clients a **sponsor** may queue a change only while
  fewer than 2 are pending (`Too many sponsored pending changes for a scope without clients`); a non-sponsor, who
  pays, may queue up to 10. Storage paid like `register_scope` (sponsors exempt). For `AddClient`
  the charge also covers the client index record that `execute_change` will add (40 + 1 + borsh((provider, aud)) +
  borsh(scope_id) bytes), since `execute_change` is free to call: ≈ 156 bytes ≈ 0.0016 NEAR for a Google client in
  `s1`; attach 0.01 NEAR (an `AddClient` also adds a small pending-add counter record, freed at execute or cancel).
  Nothing is refunded if the change is cancelled.
- Event `change_proposed`.

#### `execute_change(scope_id, change_id)` — anyone

```json
{"scope_id":"s1","change_id":0}
```

Not while paused (`Paused`, checked first). Applies a pending change once `now >= unlock_at_ms` and `now >= changes_unlock_floor_ms` (`Change is still timelocked`; `get_scope` already shows each pending change's `unlock_at_ms` raised to that floor). Re-checks: `AddClient` client
still unregistered (`Client is already registered`), not quarantined for another scope
(`Client was recently removed from another scope`), not shared (`Client is a shared client`) and room in the scope
(`A scope has at most 10 clients`); `SetOwners` re-validated; `SetAllowShared` sets `allow_shared = true` (no-op if
already on). On a failed
re-check the change stays pending until an owner cancels it. **Increments `action_nonce`** (since A.2), so owner
tokens and client proofs made before the execute go stale. Panics: `No such scope`, `No such change`.
Event `change_executed`.

#### `cancel_change(scope_id, auth, change_id)` — scope owner

```json
{"scope_id":"s1","auth":{"Oidc":{"jwt":"eyJ..."}},"change_id":0}
```

Removes a pending change (any owner may cancel any pending change, including one proposed by a removed owner).
Cancelling a re-add that reserved a quarantined client releases the reservation. Increments `action_nonce`. Event
`change_cancelled`.

#### `remove_client(scope_id, auth, provider, aud)` — scope owner

```json
{"scope_id":"s1","auth":"Near","provider":"google","aud":"456-def.apps.googleusercontent.com"}
```

Immediate: the client stops resolving to the scope at once. The client id is then **quarantined** until
`free_at_ms = now + change_delay_ms` (the delay in force at removal): until then only this scope may take it back
(`propose_change(AddClient)` here is allowed at once, with the usual timelock), and every other path
(`register_scope`, `admin_register_scope`, `propose_change` / `execute_change` in another scope) fails with
`Client was recently removed from another scope`; so does `set_shared_clients`. If this scope proposes the re-add
before `free_at_ms`, the client stays reserved for it after `free_at_ms` too, until that change is executed or
cancelled: the re-add's timelock always ends after the quarantine, and nobody may take the client in between. So a
single owner can't move a client out of a shared scope into another scope (or have it made shared) faster than the
timelock other owners rely on. The last client may be removed only when the scope has
`allow_shared` (it then becomes shared-only). Panics: `Client is not in this scope`,
`Cannot remove the last client of a scope without shared login`. Increments `action_nonce`. Event `client_removed`
(with `free_at_ms`).

#### `disable_shared_login(scope_id, auth)` — scope owner

```json
{"scope_id":"s1","auth":"Near"}
```

Immediate: sets `allow_shared = false`, so shared-client tokens stop opening sessions in this scope at once (sessions
already open stay valid until they expire or are revoked). Panics: `Shared login is not enabled`,
`Cannot disable shared login: the scope has no clients`. A pending `SetAllowShared` is left pending (cancel it with
`cancel_change`). Increments `action_nonce`. Event `shared_login_disabled`.

#### Owner auth panics

Apply to `propose_change`, `cancel_change`, `remove_client` and `disable_shared_login` (an `Oidc` auth or a client proof also panics `Paused` while paused):
`No such scope`, `Caller is not a NEAR owner of this scope` (Near), `Token is not for the Hana console`
(Oidc: token `(provider, aud)` not among the console audiences **in force**: a pending addition doesn't count), `Token is not from an owner of this scope`,
`Owner token nonce doesn't match this action` (wrong args, wrong method, or replay: `action_nonce` moved on).

#### Registry views

| Method | Args | Returns |
|---|---|---|
| `get_scope(scope_id)` | `{"scope_id":"s1"}` | Scope or `null`. Each pending change's `unlock_at_ms` is when `execute_change` accepts it: its own timelock or `changes_unlock_floor_ms`, whichever is later |
| `scope_for_client(provider, aud)` | `{"provider":"google","aud":"123-abc..."}` | `"s1"` or `null` |

### Sessions and CKD

#### `create_session(jwt, scope_id, session_public_key, expires_at_ms, salt, key_index, max_uses, signature)` — anyone

```json
{"jwt":"eyJ...","scope_id":"s1","session_public_key":[234,74,...32 bytes],"expires_at_ms":1800003600000,
 "salt":[9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9],"key_index":0,"max_uses":3,"signature":[...64]}
```

Returns Session. Checks, in order: `Paused`, `Session key must be a 32-byte Ed25519 public key`, `Salt must be 16-64 bytes`,
`Session expiry must be within 24 hours` (now < expires_at_ms ≤ now + 24 h), `max_uses must be 1-500`,
`key_index must be below 2^31` (batch B),
`Session key already in use` (an unexpired session, including a revoked one, exists for this key), token
verification, scope resolution for the token's client `(provider, aud)`:

1. A registered scope client → its scope must equal `scope_id`, else `Token is for another app`.
2. Else a shared client in force now (pending ones don't count) → scope `scope_id` must exist (`No such scope`) and
   have `allow_shared` (`Scope does not allow shared login`).
3. Else `Token is for an unregistered app`.

Then `Token nonce doesn't commit to this session` (Session nonce above, with this `scope_id`). Then the path
identity (email login, v3): the token's identity key X in this scope; if X is a **pending** member of an account,
`Sign-in method link is pending`; if X is an active member (or a pending one past its `effective_at_ms` and
`changes_unlock_floor_ms`, which this call marks active, event `identity_link_activated`), the account root's
`(provider, sub)`; otherwise X's own. Path = `{scope_id}#{path provider}#{path sub}#{key_index}`, the same whether
the token came from the scope's own client or a shared one (Google's `sub` is the same across client ids); for an
identity in no account exactly the v2 path. Then prunes up to 3 expired sessions. Not payable; the contract pays
session storage (≈ 250 bytes, freed by pruning). `create_session` alone does **not** record a wallet (`opened`):
`derive_key` does (D130).

Last, the **proof of possession** (v3, D137): `signature` = Ed25519 by the session key over `session_message(0,
"hana-id-create-v1:" ‖ sha256(session nonce preimage))` (`Bad session key`, `Signature must be 64 bytes`, `Invalid
session signature`). The proof is bound to this call's parameters (signer, scope, session key, expiry, key_index,
max_uses, salt), so one seen in a transaction can't open the key with any other ones; its domain differs from every
other signed payload. Only the key
holder can open a session on its key, so a token copied from a published login (a case-A login with a link, say) can't
be used to occupy its session key with a plain session. A v2 caller without `signature` fails to deserialize; the API's
split-path relay sends it (build-plan batch 6).

The stored record (borsh) is `path ‖ scope_id ‖ expires_at_ms u64 ‖ max_uses u32 ‖ used u32 ‖ revoked u8 ‖
created_at_ms u64` (`sessions.rs` `StoredSession`). Sessions opened by v1 code end after `revoked` (no creation
time); v2 code reads both forms and writes a v1 record back in the v1 form, so no session needed migrating. The next
layout change of sessions keeps that codec.

#### `derive_key(session_public_key, counter, signature, pk1, pk2)` — anyone

```json
{"session_public_key":[...32],"counter":1,"signature":[...64],"pk1":"bls12381g1:...","pk2":"bls12381g2:..."}
```

`signature` = Ed25519 over `session_message(counter, "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2)`. Panics:
`Paused` (first),
`No such session` (missing, revoked, or opened before `sessions_valid_from_ms`), `Session expired`, `Session use limit reached`,
`Wrong counter (replayed or out of order)`, `Bad session key`, `Signature must be 64 bytes`, `Invalid session signature`,
`BLS key too long` (pk1/pk2 > 512 bytes), `Sign-in method is linked to an account` (the path's own identity is now a
member, pending or active, of an account: a session it opened on its own path before joining can't make a second
wallet, D136). Increments `used`, records the path identity's key in `opened` if it isn't there yet (it "has a
wallet"; ≈ 113 bytes once per identity, contract-paid), then calls the MPC:

```json
// mpc.request_app_private_key, 1 yoctoNEAR (paid by the contract), 20 Tgas
{"request":{"derivation_path":"s1#google#1102...#0","app_public_key":{"AppPublicKeyPV":{"pk1":"...","pk2":"..."}},"domain_id":2}}
```

Returns the MPC's result unchanged: `{"big_y":"bls12381g1:...","big_c":"bls12381g1:..."}`.

#### `create_session_and_derive(jwt, scope_id, session_public_key, expires_at_ms, salt, key_index, max_uses, signature, pk1, pk2, link_jwt, link_immediate)` — anyone

```json
{"jwt":"eyJ...","scope_id":"s1","session_public_key":[...32],"expires_at_ms":1800003600000,
 "salt":[9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9],"key_index":0,"max_uses":1,
 "signature":[...64],"pk1":"bls12381g1:...","pk2":"bls12381g2:..."}
```

Batch B's one-transaction login (`POST /v1/login`): exactly `create_session` with the first seven arguments, then
`derive_key(session_public_key, 1, signature, pk1, pk2)`, in one receipt:

```rust
self.create_session(jwt, scope_id, session_public_key.clone(), expires_at_ms, salt, key_index, max_uses);
self.derive_key(session_public_key, 1, signature, pk1, pk2)
```

`link_jwt` (string) and `link_immediate` (bool), both optional (missing = `null`; callers that send neither are
unaffected), make email login's **automatic link** inside the login, after the session nonce check and before the
path is chosen ([Accounts and links](#accounts-and-links), "Automatic links"). `link_immediate` without `link_jwt`
panics `link_immediate needs a link_jwt`. **With a link, `signature` is over `session_message(1, linked CKD
payload)`** (`"hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode u8 ‖ pk1 ‖ ":" ‖ pk2`, see "Identity key, link nonces and the linked CKD payload" above),
not the plain CKD payload (D133): only the session key holder decides whether a link is attached, which token and in
which mode. A replayed or front-run login therefore can't gain a link (a stolen email key can't attach its own
identity to a published Google login), and a case-A login can't be stripped of its link (which would derive the Google
identity's own path and split the person into two wallets): either fails `Invalid session signature`. The vault
checks the link token and recomputes its `auto_link` nonce before it signs. With a link the call needs more gas: one
more RS256 verification and the account writes burn ≈ +18 Tgas in the signer's receipt (38.5 against 20.5 Tgas;
the spec estimated +8–12); ≈ 59 Tgas is the floor with the 20 Tgas forwarded to the MPC. With 4096-bit keys (the
largest `set_issuer_key` accepts) each verification costs ≈ 67 Tgas and the floor is ≈ 156, above the spec's 150:
attach **250 Tgas** (D155); [Gas of the email login calls](#gas-of-the-email-login-calls-sandbox).

- No counter argument (always 1) and no callback. `signature` is over `session_message(1, CKD payload)`.
- Panics: every `create_session` panic, in its order, then every `derive_key` panic. Any of them aborts the whole
  call: no session, no queue entry, no MPC request. So a bad signature, a 63-byte signature, a signature over
  another counter or other BLS keys, or `BLS key too long` leaves the token reusable for a corrected call.
- The transaction result is the MPC's `{big_y, big_c}`, as for `derive_key`. On success the session has `used = 1`.
- If the MPC receipt fails (a later receipt, executor = the MPC account), the session stays committed with
  `used = 1`. Only a session with `max_uses ≥ 2` can then retry, with `derive_key` and counter 2.
- Replaying the same arguments fails with `Session key already in use`. A bare `create_session` with the same token
  can no longer be front-run by anyone but the session key holder (D137). A front-run replay of the whole combined call
  opens the session and spends counter 1 exactly as signed (its MPC answer is encrypted to the caller's `pk1`/`pk2`,
  useless to anyone else); with `max_uses = 1` that use is gone.
- **Recovery rule for callers (D137).** When a combined login fails `Session key already in use`, a caller that meant
  the session to carry a link must **never** derive on it with the plain payload (that would derive the token's own
  path without the link): it revokes it (`revoke_session`, counter 1, `"revoke"`) and starts over with a fresh session
  key, a fresh token and a fresh link token. Without a link, deriving with counter `used + 1` stays fine.
- Not payable. Prunes up to 3 expired sessions, as `create_session` does.
- `create_session` (now with its proof of possession) and `derive_key` stay callable on their own (the split flow).

#### `revoke_session(session_public_key, counter, signature)` — anyone

`signature` over `session_message(counter, "revoke")`, `counter == used + 1`. The session becomes unusable at once
and `get_session` returns `null`; a tombstone is kept until `expires_at_ms` so its (public) token can't be replayed
to reopen it, then pruned. Panics: `No such session`, `Wrong counter (replayed or out of order)`,
`Invalid session signature`.

#### `prune_sessions(limit)` — anyone

`{"limit":100}` → number of sessions deleted (`u32`). `limit` is capped at 100. Pops up to `limit` entries from the
expiry FIFO (insertion order) while the head has expired; entries whose session is already gone or was replaced are
skipped (and count towards `limit`). Because the FIFO is in insertion order, an expired session can wait behind a
longer-lived one for at most 24 h.

#### Session views

| Method | Args | Returns |
|---|---|---|
| `get_session(session_public_key)` | `{"session_public_key":[...32]}` | Session or `null` (also `null` once revoked, or when opened before `sessions_valid_from_ms`) |
| `session_key_in_use(session_public_key)` | `{"session_public_key":[...32]}` | `bool`: `true` while a session for this key (revoked or not) has not expired, i.e. when `create_session` would panic `Session key already in use` |
| `session_message(counter, payload)` | `{"counter":1,"payload":[...]}` | bytes to sign (`Vec<u8>`) |

### Accounts and links

Email login's account linking (`docs/email-login-spec.md` "Automatic linking"; D119, D122). Per scope, identities
form **accounts**: a root (the identity whose own path is the wallet) and ≤ 3 members, one sign-in method per provider
(the root's included). A member opens the root's path; an identity is in at most one account per scope; links never
cross scopes. An identity **has a wallet** when its own path was derived (`opened`, recorded by `derive_key`, D130).
Every link change (join, cancel, unlink) bumps the account's `epoch`, which every link nonce commits to; an account
record is never deleted, so the epoch never restarts. Activation of a pending member is not a link change (no bump).

State (v3): `links` (member ik → `{root, effective_at_ms}`), `accounts` (root ik → `{root_provider, root_sub, members:
[{key, provider, effective_at_ms, active, auto}], unlinked: [ik] ≤ 8, epoch}`), `opened` (set of ik), `self_issued`,
`unrecorded_wallets`.

**Pre-v3 wallets (D135).** A deployment migrated from v1 or v2 state has wallets that were derived before `opened`
existed, so "has a wallet" can't be trusted there: `migrate` sets `unrecorded_wallets = true` (`get_config`), and
every link (automatic and `link_identity`) panics `Links wait until the owner accepts the wallets opened before v3`
until the owner calls `accept_unrecorded_wallets()` (owner, one way, event `unrecorded_wallets_accepted`; a no-op
once accepted). sandbox-dev accepts after its v3 upgrade (its pre-v3 wallets are test data); a deployment created
with `new` (mainnet) starts with `false` and never needs it. Logins without a link are unaffected.

**Automatic links** (`create_session_and_derive` with `link_jwt`, signed as above). X = the session token's identity
(already checked: not pending), E = the link token's. Checks, in order: `Links wait until the owner accepts the wallets
opened before v3`; token verification of `link_jwt` (a self-issued issuer's JWS
JSON; `Link token must come from a self-issued issuer`), its client opens sessions in this scope (`Token is for
another app`, `Token is for an unregistered app`, `Scope does not allow shared login`), `Identities must differ`, E
pending (`Sign-in method link is pending`), X and E already in one account (`Sign-in method is already linked`),
both reach a wallet (`Both sign-in methods already have a wallet`; an active member reaches its root's), then the
case:

| E reaches a wallet | X | Result |
|---|---|---|
| yes (case A) | no wallet and in no account (`Sign-in method is already linked` otherwise) | X joins E's account **at once**, `auto: true`; `link_immediate` must be `true` (`This link must be immediate`); the session opens E's root's path |
| no (cases B, C) | any (it has or gets a wallet in this call) | E (in no account, `Sign-in method is already linked` otherwise) joins X's account (X's root's), at once with `link_immediate`, else pending until `max(now + change_delay_ms, changes_unlock_floor_ms)`; the session opens X's root's path |

then the nonce (`auto_link` over this session's nonce preimage, X, the join just decided (`join`, joiner, target
root), the target account's epoch and the mode; `Link token nonce doesn't match`: a token minted for case A can't
execute as case B after the chain state changed, D133), the mode (case A), an unlinked pair (`This sign-in method was unlinked`: either identity
is in the other's account's `unlinked`), room (`Account is full`, `Account already has a sign-in method of this
kind`), the hourly cap (`Link rate limit reached`, D200). Events `identity_linked` (at once) or
`identity_link_proposed` (pending). Any panic reverts the whole login,
including a bad session signature later in the same call (no link is ever left behind). Contract-paid storage.

| Method | Who | Args | Effect |
|---|---|---|---|
| `link_identity(scope_id, account_jwt, new_jwt, epoch, salt)` | anyone with both tokens; **payable** (as `register_scope`: the caller pays the added storage, sponsors pay nothing, excess refunded) | `{"scope_id":"s1","account_jwt":"…","new_jwt":"…","epoch":0,"salt":[…16..64]}` | the new identity N joins the account of A (`account_jwt`), pending until `max(now + change_delay_ms, changes_unlock_floor_ms)`; returns that time (`u64`); event `identity_link_proposed` (`auto: false`) |
| `cancel_link(scope_id, jwt, member_key, epoch, salt)` | the pending identity itself or an active identity of the account; payable | `member_key` = hex ik | removes a pending member; event `identity_link_cancelled` |
| `unlink_identity(scope_id, jwt, member_key, epoch, salt)` | the root or the member itself; payable | same | removes an active member and adds it to the account's `unlinked` (≤ 8, oldest dropped); event `identity_unlinked` |
| `get_identity(scope_id, provider, sub)` | view | | Identity (Types above) |
| `get_account(scope_id, provider, sub)` | view | | Account (Types above) or `null` |
| `identity_key(scope_id, provider, sub)` | view | | hex ik |
| `accept_unrecorded_wallets()` | owner | `{}` | one way: lets links be made after a migration from pre-v3 state (D135) |
| `set_link_limits(per_scope_per_hour, total_per_hour)` | owner | `{"per_scope_per_hour":50,"total_per_hour":500}` | the hourly link caps ([below](#link-volume-the-hourly-cap-d200)) |
| `get_link_stats()` | view | | the link counter ([below](#link-volume-the-hourly-cap-d200)) |

Panics (each method checks in this order where they apply):

- `link_identity`: `Paused`; `Links wait until the owner accepts the wallets opened before v3`; `Salt must be 16-64 bytes`; token panics (`account_jwt` first); `Token is for another
  app` (either token's client must open sessions in `scope_id`); `Link nonce doesn't match` (`new_jwt` = `link_new`,
  `account_jwt` = `link_account`, root = A's root, this `epoch` and `salt`); `Identities must differ`; `Sign-in method
  link is pending` (A); `Sign-in method already has a wallet` (N in `opened`); `Sign-in method is already linked` (N a
  member, or a root with members); `Account is full`; `Account already has a sign-in method of this kind`; `Wrong
  epoch` (`epoch` ≠ the account's); `Link rate limit reached` (D200); `Attached deposit doesn't cover storage: need …
  yoctoNEAR`.
- `cancel_link`: `Paused`; salt; token panics; `Token is for another app`; `Invalid identity key` (not 64 lowercase
  hex characters); `No such member` (no link record); `Link nonce doesn't match` (`link_change` "cancel", root = the
  member's root); `Sign-in method is not in this account` / `Sign-in method link is pending` (the caller, unless it is
  the member itself); `Wrong epoch`; `No such member` (the member is active, or past its time: unlink it instead).
  Cancelling does **not** mark the pair `unlinked` (user decision 2026-10-30, D132): the match stays, so automatic
  linking may propose it again and a matched person still never gets a second wallet.
- `unlink_identity`: `Paused`; salt; token panics; `Token is for another app`; `Invalid identity key`; `No such member`
  (neither a member nor a root); `Link nonce doesn't match` ("unlink"); `Sign-in method is not in this account` (the
  caller is in no account with it) / `Only the root or the member itself can unlink` (another member); `Wrong epoch`;
  `Cannot unlink the root`; `No such member` (pending: cancel it instead).
- Views: `Invalid provider`, `Invalid sub`.

Unlinking (or cancelling) stops **future** sessions of the member on the root's path; sessions it already opened keep
deriving until they end (the API revokes the vault shares of the account, build-plan batch 6). After an unlink the
member opens its own path again (a new wallet unless it had one).

#### Link volume: the hourly cap (D200)

Every **new link** is counted: the combined login with a `link_jwt` (immediate or pending) and `link_identity`. Not
`cancel_link`, `unlink_identity` or a pending member's lazy activation. Counts are kept in fixed UTC hours
(`window_start_ms = floor(block_ms / 3_600_000) * 3_600_000`), one per scope and one in total; the current hour and the
previous one are kept.

- **The cap.** As the last check before a new link is written (after every check listed below for the two methods),
  if the scope's count this hour is already `per_scope_per_hour`, or the total is `total_per_hour`, the call panics
  `Link rate limit reached` and reverts as a whole: a capped login is refused (no session, no derivation), never
  completed without its link (D122). The link that makes a count equal its cap is made, and records the cap: the scope
  goes into the window's `capped_scopes` (≤ 64, in the order reached; then `capped_scopes_truncated: true`), or
  `total_cap_reached` becomes `true`; event `link_cap_reached`. Defaults 50 per scope and 500 in total per hour
  (provisional until real traffic is measured).
- **`set_link_limits(per_scope_per_hour, total_per_hour)`** — owner (`Only the owner can do this`), each 1..=100000
  (`Link limits must be 1 to 100000`). A lower value applies at once; a higher one is a weakening and applies only
  after `governance_delay_ms`, as the delay setters' decreases do: the lowered parts of the pair apply now, the whole
  pair from `effective_at_ms`, and a later call replaces the scheduled raise (setting the values in force cancels it).
  Event `link_limits_set`. Never relayed by either pool (scripts `OWNER_METHODS`; the sandbox access-key test).
- **`get_link_stats()`** — view:

  ```json
  {"window_ms":3600000,
   "limits":{"per_scope_per_hour":50,"total_per_hour":500},
   "pending_limits":null,
   "links_total":12,
   "current":{"window_start_ms":1800000000000,"total":3,"total_cap_reached":false,"capped_scopes":["s4"]},
   "previous":null}
  ```

  `limits` are the ones in force (a matured raise included); `pending_limits` is a raise not yet in force
  (`{"per_scope_per_hour","total_per_hour","effective_at_ms"}`) or `null`; `links_total` counts new links since v3.
  `current` is always the hour of the block (zeros when it has no links yet; a rollover shows without a write);
  `previous` is the hour before, or `null` when it had no links. `capped_scopes_truncated` appears (as `true`) only
  in a window whose list is full.
- **Storage.** Per scope, only scopes with links in the current or previous hour keep a count: each scope's first
  link in an hour queues it, and every counted link deletes up to 4 queued counts older than the previous hour.
  Contract-paid (or the `link_identity` caller's, with the rest of its storage).
- **Watchdog.** It reads `get_link_stats` each run: a cap reached is critical, a count past half a cap a warning, a
  raise (`pending_limits`, `link_limits_set`) a critical governance change (D200).

### Gas of the email login calls (sandbox)

Measured 2026-11-02 in the near-workspaces sandbox with the mock MPC (`contracts/integration-tests`: `cargo test
--test email -- --nocapture | grep '^GAS'`, and `--test governance`) on a v3 deployment created with `new`, with
2048-bit RSA keys (Google's size, and the spec's email key) and again with 4096-bit keys for every token
(`gas_with_4096_bit_keys`; `set_issuer_key` accepts 2048 to 4096 bits, `issuers.rs` `checked_rsa_key`). Figures are
Tgas burnt in hana-signer's own receipt; the transaction adds ≈ 0.3–0.4 and a login's MPC receipt ≈ 2. A login also
forwards 20 Tgas to the MPC, so it needs its signer receipt + 20 attached. Testnet figures come with build-plan batch
8.

| Call | 2048-bit | 4096-bit | Attach (D155) |
|---|---|---|---|
| `set_issuer("email", [iss])` (owner) | 2.2 | — | DAO default 100 |
| `mark_self_issued("email")` (owner) | 2.0 | — | DAO default 100 |
| `set_issuer_key("email", …, signer: "hana")` (owner) | 2.4–2.5 | — | 30 |
| `execute_issuer_key_change` (email key, anyone) | 2.2 | — | 30 |
| `accept_unrecorded_wallets()` (owner, through the DAO, flipping the flag) | 1.9 (the DAO vote: 8.5 in all) | — | DAO default 100 |
| `create_session` (email token) | 20.1 | 68.8 | the API's 50: **too little at 4096 bits** |
| `create_session_and_derive` (email or Google token, no link) | 20.5–20.6 | 69.2–69.3 | the API's 100: 89 needed at 4096 bits |
| `create_session_and_derive` (a member's login that activates a pending link) | 20.9 | — | 100 |
| `create_session_and_derive` + `link_jwt` (case A, case B at once or delayed) | 38.8–38.9 | 136.4 | **250** (≈ 59 / ≈ 157 needed) |
| … the link that reaches a cap (event `link_cap_reached`) | 39.0 | — | 250 |
| `link_identity` (two tokens, relayed by a sponsor) | 37.6 | 134.9 | **250** |
| `set_link_limits` (owner; a lowering or a scheduled raise) | 2.1 | — | DAO default 100 |
| `cancel_link` | 19.8 | 68.5 | **150** |
| `unlink_identity` | 19.8 | 68.5 | **150** |

The hourly link cap (D200) adds ≈ 0.3 Tgas to each call that makes a link (38.5 → 38.8 for a linked login, 37.2 →
37.6 for `link_identity`; a scope's first link in an hour also queues it for cleanup), ≈ 0.05 to the other logins.
One RS256 verification costs ≈ 17–18 Tgas at 2048 bits and ≈ 67 at 4096 (the modular exponentiation in wasm), which
is most of every token-taking call. The spec's estimates were low (`link_identity` ≈ 25–35, `cancel_link` /
`unlink_identity` ≈ 15, the link in a login +8–12 Tgas) and its 150 Tgas for a linked login is enough only with
2048-bit keys. The values in the last column cover the 4096-bit worst case with ≥ 1.6 times the need (unused gas is
refunded; the prepaid gas only counts against the relayer key's allowance while the call runs). The plain logins'
API values (50 and 100) don't cover 4096-bit keys: batch 6 raises them or the issuer keys stay at 2048 bits (D155).
An email token at 2-of-2 (Level 1) adds one more verification to every call that takes it: raise the attached gas
with that upgrade.

## Events (NEP-297)

Logged as `EVENT_JSON:{"standard":"hana-id","version":"1.2.0","event":"<name>","data":[{...}]}` (`data` is a
one-element array, as in NEP-171). Version `1.1.0` (governance batch, D86) is additive over `1.0.0`: new events,
and `issuer_key_set` / `issuer_key_removed` gain fields and are now emitted when a key enters or leaves the active
set (execution or confirmation, or an owner removal), no longer when a key is posted. Version `1.2.0` (email login)
is additive over `1.1.0`: the self-issued and link events below, and `issuer_key_proposed` gains `signer` for a
self-issued issuer's key. Link events carry identity keys in hex, never `sub`s.

| event | data |
|---|---|
| `scope_registered` | `{"scope_id","owners":[Owner],"clients":[[provider,aud]],"allow_shared":bool,"by":"account","admin":bool}` |
| `change_proposed` | `{"scope_id","change_id","change":Change,"unlock_at_ms","by":Owner}` |
| `change_executed` | `{"scope_id","change_id","change":Change}` |
| `change_cancelled` | `{"scope_id","change_id","by":Owner}` |
| `client_removed` | `{"scope_id","provider","aud","free_at_ms","by":Owner}` |
| `shared_login_disabled` | `{"scope_id","by":Owner}` |
| `shared_clients_set` | `{"shared_clients":[[provider,aud]],"pending_shared_clients":[{"provider","aud","effective_at_ms"}]}` (state after the call) |
| `console_audiences_set` | `{"console_audiences":[[provider,aud]],"pending_console_audiences":[{"provider","aud","effective_at_ms"}]}` (state after the call) |
| `public_registration_enabled` | `{}` |
| `issuer_key_proposed` | `{"id","provider","kid","n","e","executable_at_ms","by":"account","signer"?}` (`n`, `e` JWK base64url, leading zeros stripped; `signer` for a self-issued issuer only) |
| `issuer_self_issued` | `{"provider"}` |
| `signer_policy_set` | `{"provider","signers":[id],"required","overlap_until_ms"}` (only from a governed upgrade's `migrate`) |
| `identity_linked` / `identity_link_proposed` | `{"scope_id","root","member","provider","effective_at_ms","auto":bool}` (keys hex; `identity_linked` = active at once) |
| `identity_link_activated` | `{"scope_id","root","member","provider"}` (a pending member's first login after its time) |
| `identity_link_cancelled` / `identity_unlinked` | `{"scope_id","root","member","provider","by":"<hex ik of the caller's identity>"}` |
| `unrecorded_wallets_accepted` | `{}` (the owner let links be made after a migration from pre-v3 state) |
| `link_cap_reached` | `{"scope_id":"s4"\|null,"window_start_ms","count"}` (the link that made a scope's count, or the total (`scope_id: null`), equal its hourly cap, D200) |
| `link_limits_set` | `{"per_scope_per_hour","total_per_hour","effective_at_ms","in_force":{"per_scope_per_hour","total_per_hour"}}` (the requested pair, when it is all in force, and what is in force now: a raise waits `governance_delay_ms`) |
| `issuer_key_removal_proposed` | `{"id","provider","kid","executable_at_ms","by":"account"}` |
| `issuer_key_set` | `{"provider","kid","id","how":"delay"\|"confirmed","by"?}` (`by` = the watchdog, for `"confirmed"` only) |
| `issuer_key_removed` | `{"provider","kid","id","how":"delay"\|"confirmed","by"?}` or `{"provider","kid","how":"owner"}` |
| `issuer_key_change_cancelled` | `{"id","provider","kid","by":"account"}` (also when `remove_issuer_key` drops a pending change) |
| `delay_changed` | `{"which":"issuer_key"\|"governance","value_ms","effective_at_ms"}` |
| `watchdog_added` / `watchdog_removed` | `{"account_id","confirm_from_ms"}` / `{"account_id","keys_slow_until_ms"}` |
| `updater_key_added` / `updater_key_deleted` / `updater_key_add_failed` | `{"public_key"}` / `{"public_key","by"}` / `{"public_key"}` |
| `paused` / `unpaused` | `{"by"}` / `{"changes_unlock_floor_ms"}` |
| `sessions_valid_from_set` | `{"sessions_valid_from_ms"}` |
| `upgrade_proposed` / `upgrade_cancelled` / `upgrade_executed` | `{"code_hash","executable_at_ms"}` / `{"code_hash"}` / `{"code_hash"}` |
| `state_migrated` | `{"from_version","to_version"}` (logged by `migrate` in the deploy receipt: the upgrade really happened) |
| `owner_proposed` / `owner_proposal_cancelled` / `owner_changed` | `{"owner","acceptable_at_ms"}` / `{"owner"}` / `{"old","new"}` |
| `withdrawal_proposed` / `withdrawal_cancelled` / `withdrawal_executed` | `{"receiver","amount","executable_at_ms"}` / `{"receiver","amount"}` / `{"receiver","amount"}` (amount in yoctoNEAR, a string) |

`by: Owner` is the authenticated owner (`{"Near":{...}}` or `{"Oidc":{...}}`); in the governance events `by` is an
account id. Enabling shared login shows up as `change_proposed` / `change_executed` with a `SetAllowShared` change.
Not every state change has an event (e.g. `set_sponsors`, `set_change_delay_ms`, `set_issuer`): monitors diff
`get_config` / `get_governance` as well.

## Monitoring hand-off (batch C admin portal)

The governance spec puts a "Security & monitoring" view and a pending-upgrades page in the admin portal (D83, D86),
built on batch C's admin Worker, which does not exist yet. The contract side of that view is exactly these
read-only sources, which the portal (and the watchdog service) read through their own RPC; nothing here needs a
signer key:

| Portal item | Source on chain |
|---|---|
| Pending issuer-key changes, proposer, countdown | `get_key_changes()` (`executable_at_ms`); match against Google's JWKS by comparing `n`, `e` with the JWKS entry of the same `kid` |
| Active keys | `get_issuer("google").kids`; with key material `get_issuer_keys("google")` (compare with the JWKS like a pending change) |
| Pause state, who paused and when | `get_config().paused`, `.unpaused_at_ms` (also shows a pause and unpause between two reads), `.changes_unlock_floor_ms`, `.sessions_valid_from_ms`; the `paused {by}` / `unpaused` / `sessions_valid_from_set` events (block time = when) |
| The owner council's members and vote rules | `view_account(<owner>).code_hash` and the DAO's `get_policy()`: must be exactly the manifest's council, 2 of 3 for every kind (D81); the watchdog alerts critical on any change |
| Watchdogs and their confirm power | `get_governance().watchdogs` (`confirm_from_ms`), `keys_slow_until_ms`; events `watchdog_added` / `watchdog_removed` |
| Updater keys against the account's key list | `get_governance().updater_keys` and `updater_methods` against RPC `view_access_key_list(<signer>)`: any other key, or a function-call key with other methods, receiver or a larger allowance, is a finding |
| Pending upgrade (code hash, countdown) | `get_governance().pending_upgrade`; events `upgrade_proposed` / `upgrade_cancelled` / `upgrade_executed` / `state_migrated`; after execution `view_account(<signer>).code_hash` |
| Pending owner transfer, withdrawal, delay decreases, console-audience additions | `get_governance().pending_owner`, `.pending_withdrawal`; `get_config().pending_issuer_key_delay`, `.pending_governance_delay`, `.pending_change_delay`, `.pending_console_audiences` |
| Watchdog actions log (cancels, confirms, pauses, updater-key deletions) with transaction links | the NEP-297 events above with `by` = a watchdog account: `issuer_key_change_cancelled`, `issuer_key_set` / `issuer_key_removed` with `how: "confirmed"`, `paused`, `updater_key_deleted`; transaction hash from the RPC receipt |

The portal's other items (heartbeat, the watchdog's verdicts, alert history and acks) come from the watchdog
service's `GET /status`, `GET /alerts`, `GET /actions` and `POST /alerts/:id/ack` (`apps/watchdog/README.md` "Status
endpoint"), not from the contract. Owner actions waiting for council votes come from the DAO (`get_policy`,
`get_last_proposal_id`, `get_proposals`).

The API serves all of the table above in one read-only answer, `GET /v1/governance` (`docs/api.md`), normalised,
with each pending key change's JWKS verdict, the access keys checked against `updater_keys` / `updater_methods`, and
the JWKS cron's own last run; the portal may read it instead of the views (it runs on Hana's main Cloudflare account,
like the admin Worker, so it is no more independent than the portal itself). `scripts/admin.ts <env>
governance:status --json` is an operator-side reference snapshot of the same chain state plus the council's open
proposals, with the findings to show (`docs/operations.md` "Governance status for the admin portal").

## Changed in the email login batch (v3)

Layout v3, migrated **in place** by `migrate` (`execute_upgrade`), not deployed yet. **No existing byte layout,
nonce, signed message, CKD request or path changed**: an identity in no account opens exactly the v2 path
`{scope_id}#{provider}#{sub}#{key_index}` (golden tests in `src/tests/email.rs`: the fixture's Google user opens
`s1#google#1098765432#0`, `s2#…#0`, `s1#…#1`, `s3#…#0` through a shared client, and the MPC receives exactly that path;
sessions opened by v2 code keep their stored paths after `migrate`). In detail:

- **State**: `self_issued`, `links`, `accounts`, `opened` appended to the root struct (storage prefixes 8, 9, 10,
  after the v1/v2 ones). Pending key changes stored by v2 code (`KeyOp::Add`, variant 0) read as before; v3 adds the
  variant `AddForSigner {n, e, signer}` (2).
- **Issuers**: `mark_self_issued`, `get_self_issued`; `set_issuer_key` takes an optional `signer` (required for, and
  only for, a self-issued issuer); self-issued keys are owner-only (also their removal proposals), wait at least
  `governance_delay_ms`, are never confirmed early, are unique by modulus, ≤ 8; `get_key_changes` shows `signer` on
  such additions only (absent otherwise, so Google's view is byte-identical).
- **Tokens**: self-issued issuers take the JWS General JSON Serialization (≤ 3 signatures, signer policy); every other
  issuer only the compact form, as before (`Wrong token format for this issuer`).
- **Sessions**: the path identity (account root for a member); `Sign-in method link is pending`;
  `create_session_and_derive` gains `link_jwt` and `link_immediate` (optional; with a link the counter-1 signature is
  over the linked CKD payload); `derive_key` records `opened` and refuses a linked identity's own path.
- **Accounts and links**: `link_identity`, `cancel_link`, `unlink_identity` (payable), `get_identity`,
  `get_account`, `identity_key`, `accept_unrecorded_wallets`; the identity key, the four link nonces and the linked
  CKD payload. `get_config` gains `unrecorded_wallets`.
- **Security review fixes (2026-10-30, D133–D136)** before anything shipped: the link bound by the session signature
  and the join in the `auto_link` nonce, email-only self-issuing, the pre-v3 wallet guard, no derivation for a linked
  identity's own path, checked policy keys and the overlap choice. Second review (D137, D138): `create_session`
  gains a required proof of possession (`signature`; the one change to an existing method's interface: v2 callers of
  the split path must add it), and a replacing signer policy needs new signer ids and cancels dropped signers' pending
  keys.
- **Events** 1.2.0 (additive).
- `migrate` v2 → v3 (and v3 → v3), sandbox-tested through the DAO from the v2 code (build-plan batch 2);
  `migrate_v1`, the v1 layout copy and its fixture are removed (no deployment is on v1).
- **Wasm**: 621.8 KB since batch 2 (628.5 KB with `migrate_v1`; v2: 520.5 KB), `cargo near build non-reproducible-wasm`, toolchain 1.85.1.

## Changed in the governance batch

Layout v2, migrated **in place** (`migrate_v1`); no path format, nonce, signed message or CKD request changed, so no
address changes. The one stored-record change is additive: sessions opened by v2 code carry `created_at_ms` after
the v1 fields (v1 records are still read as they are). In detail:

- `set_issuer_key` queues a pending `Add` (returns its id) instead of installing the key; new
  `propose_issuer_key_removal`, `execute_issuer_key_change`, `confirm_issuer_key_change`,
  `cancel_issuer_key_change`, `get_key_changes`. `set_issuer_key` no longer overwrites an active kid (`Kid is already
  active`). `remove_issuer_key` is owner-only (the contract account may no longer call it).
- `set_owner` is removed; `propose_owner` / `cancel_owner_proposal` / `accept_owner` replace it.
- New: `set_issuer_key_delay_ms`, `set_governance_delay_ms`, watchdogs, `pause` / `unpause`, updater keys
  (`add_updater_key`, `delete_updater_key`, callback `on_updater_key_added`), `propose_upgrade` / `cancel_upgrade` /
  `execute_upgrade` / `migrate`, `migrate_v1`, the surplus withdrawal, `get_governance`, and the view
  `get_issuer_keys` (added with `apps/watchdog`: active keys with their material, so the watchdog can compare keys
  that went live while it was down or arrived by an upgrade; read-only, no state change).
- `new` takes `issuer_key_delay_ms`, `governance_delay_ms`, `watchdogs` and `updater_keys`.
- `set_console_audiences` additions wait `change_delay_ms` (`pending_console_audiences`); duplicates are refused.
- `get_config` gains `pending_console_audiences`, `issuer_key_delay_ms`, `pending_issuer_key_delay`,
  `governance_delay_ms`, `pending_governance_delay`, `paused`, `unpaused_at_ms`, `changes_unlock_floor_ms`,
  `sessions_valid_from_ms`; `console_audiences` lists those in force.
- An unpause re-arms the scope-change timelock (`changes_unlock_floor_ms`, enforced by `execute_change` and shown by
  `get_scope`); `set_sessions_valid_from_ms` retires every session opened before a floor (both for the
  `forged_active_key` incident, `docs/operations.md`).
- Pause checks in `verify_token`, `create_session`, `derive_key`, `register_scope`, `execute_change`,
  `execute_issuer_key_change`, `execute_withdrawal`.
- Events version `1.1.0` (above).
- The updater key's methods change (`set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`):
  access-key permissions can't be edited, so the old key (with `remove_issuer_key`) is deleted and a new one added
  with `add_updater_key`.
- Deviations from `docs/governance-spec.md` (DRAFT), raised for review: `new` also takes `updater_keys` and adds them
  itself (the spec's creation batch with its own `AddKey` would leave the key untracked in `updater_keys`, which
  `deploy-plan` treats as a blocker); `add_updater_key` keeps a requested key in `pending_updater_keys` until its
  callback confirms the `AddKey` succeeded (only then is it in `updater_keys`; the spec accepted untracked drift);
  `delete_updater_key` by a watchdog is limited to confirmed keys; "no watchdog" in the key-change delay counts only
  watchdogs that may confirm (review follow-up); `propose_owner` emits `owner_proposal_cancelled` for a replaced
  transfer; extra events
  `owner_proposal_cancelled`, `updater_key_add_failed`, `state_migrated`; extra panics `Already an updater key`,
  `Not an updater key`, `No pending owner change`, `Withdrawal amount must be positive`, `Duplicate console
  audience`; `register_scope` is refused while paused even without proofs (D86 "scope registration");
  `get_governance` also returns `updater_methods` and `pending_updater_keys`. The state layout gains
  `pending_updater_keys` at the end (layout v2, before any v2 deployment: `migrate_v1` starts it empty).

## Changed in batch B

New method `create_session_and_derive` (a literal composition of `create_session` and `derive_key` with counter 1).
`create_session` (and so the combined call) refuses `key_index ≥ 2^31` (`key_index must be below 2^31`); nobody uses
those indices, so no address changes. The off-chain vault message prefix `hana-id-vault-v1:` is recorded above. No
byte layout, path format or state field changed, so this is a code upgrade (`deploy-contract --upgrade`). The relayer's
session-pool keys gain `create_session_and_derive` (allowlist state 1 in `docs/batch-b-spec.md` "Relayer allowlists"):
access-key permissions can't be edited, so every session-pool key is deleted and re-added. If the ship gate fails,
the method is removed again before the audit.

## Changed in batch A.2

`create_session` gained `scope_id` (2nd argument); `admin_register_scope` and `register_scope` gained `allow_shared`;
every nonce layout gained `borsh(signer account id)`; the session nonce commits to `scope_id` and `max_uses`; the
register proof commits to the clients and `allow_shared`; client-proof and owner-action nonces length-prefix
`scope_id` and the method name; session messages use `hana-id-session-v1:`. `execute_change` now increments
`action_nonce`; `set_shared_clients` rejects clients with a pending `AddClient`; a quarantine re-add reserves the
client; sponsored proposals on scopes without clients are capped at 2 and a non-sponsor shared-only registration
prepays them. New view `session_key_in_use` (also covers revoked, unexpired sessions). The contract state layout changed too
(new config fields, `Scope.allow_shared`): deploy fresh, don't upgrade a batch A deployment in place.

## Removed in batch A

`sign`, `on_verified`, `sign_with_session`, `sign_target`, envelopes, `config()`, `migrate`, `set_google_key`,
`remove_google_key`, `has_google_key`, `set_google_client_ids`, `google_client_ids`, the `scope` and
`max_signatures` arguments of `create_session` (now `key_index`, `max_uses`), the `SCOPES` list.

## Security notes (for reviewers)

- **Hana's trust surface.** Whoever can install a Google key can mint any token, and whoever can replace the code
  can do anything; both are total control. Since the governance batch neither is faster than a public, cancellable
  delay: a posted key waits `issuer_key_delay_ms` while the watchdogs check it against Google's JWKS (cancel, or
  confirm early), removing the watchdogs slows every key change to `governance_delay_ms`, and upgrades, owner
  transfers and withdrawals wait `governance_delay_ms` with public events (`docs/governance-spec.md` "What each
  party can do after this batch"). Pause stops every token path at once and only the owner (a 2-of-3 DAO) lifts it.
  Beyond that, Hana cannot change a scope's clients or owners, and cannot block derivation for a scope that has its
  own client (it can for a shared-only scope: see Shared login).
- **Self-issued (email) keys are a trust root equal to Google's** (`docs/email-login-spec.md` "Trust statement").
  While the policy is 1-of-1, whoever can make the `hana` key sign can mint an email token for any `sub`, and so
  reach every email wallet and every account an email identity is linked to. The contract bounds key **swaps** only:
  owner-posted, `governance_delay_ms`, no early confirm, one modulus never counted as two signers, the policy changed
  only by a governed upgrade. Use of the real key is detected off chain (watchdog, issuer logs, KMS reconciliation).
- **Linking extends reach, by design.** A member's tokens open the root's wallet. Case B (an email identity joining a
  Google wallet) is the direction that lets the email issuer reach a Google wallet, so the contract makes it pending
  for `change_delay_ms` unless the issuer's `auto_link` nonce says `link_immediate` (the issuer's Google-hosted rule,
  which the contract can't check: it trusts the issuer's mode, D119). Case A (Google joining an email wallet) must be
  immediate and adds no power the email issuer didn't have. Binding both ways (D133): an `auto_link` token is bound
  to one login and one join (session nonce preimage hash, session identity, join, joiner, target root, target epoch,
  mode), and the session key's counter-1 signature covers the link token and its mode. So whoever submits a published
  login (a front-runner, or a stolen email key replaying a failed Google login) can neither add a link, swap it,
  change its mode nor strip it; a token minted for one case can't execute as the other. A front-run of the combined
  call without the session key reverts the link with it.
- **`opened` is recorded at derivation, not at `create_session`** (D130): a published Google token copied into a bare
  `create_session` opens a session nobody can use and gives the identity no wallet, so it can't turn a later
  automatic link into "both have a wallet" (a second wallet for one person, which D122 forbids). Once an identity is a
  member, no session on its own path derives any more (D136). Wallets opened before v3 aren't in `opened`: after a
  migration every link waits for the owner's `accept_unrecorded_wallets` (D135; sandbox-dev's are test data; mainnet is
  created with `new` on v3).
- **Only `email` can be self-issued** (D134), and a governed upgrade's signer policy takes keys only as checked by
  `set_issuer_key` (no zero-padded duplicate counts as a second signer); a "replace the signer" upgrade can choose no
  overlap, removing the old signer's keys at once (D136).
- **Unlink stops future sessions only.** A member's sessions already open on the root's path derive until they end;
  the API revokes the account's vault shares after relaying an unlink (build-plan batch 6). Links are public (both
  tokens with both `sub`s are in the transaction); events and state carry identity keys, not `sub`s.
- **Shared login.** A scope with `allow_shared` accepts tokens of Hana's shared clients, with the scope taken from
  the session nonce. Whoever can get a shared-client token with a nonce of their choosing for a user can open a
  session for that user in any `allow_shared` scope: Hana's vault and login page (since batch B the vault computes
  the nonce, for a parent page the app's allowed origins permit, and the login page only relays it after checking
  it), and the user themself (who only gets their own key, which they are entitled to). So enabling shared login on a
  scope trusts Hana's vault and login pages (and whoever can change the bundles they serve) with that scope's keys; that is why enabling it on an existing scope is timelocked (`SetAllowShared`, co-owners can cancel) while
  disabling is immediate. Hana can also stop logins to a shared-only scope by removing its shared clients
  (removal is immediate). A client can't be shared and a scope client at once, and Hana can't list a client that a
  scope has registered, has a pending `AddClient` for, or has quarantined after a removal, so Hana can't turn a
  partner's **registered or proposed** client into a shared one, and a scope's own client always resolves to that
  scope only (`Token is for another app`). A partner client that no scope has registered or proposed yet is not
  protected: Hana could list it first (it is then never registrable while listed).
- **Shared-only scopes trust every shared client Hana adds.** Adding a shared client is delayed by `change_delay_ms`,
  which lets owners of a scope **with its own client** call `disable_shared_login` before it takes effect. A
  shared-only scope can't: disabling needs a client of its own, and the `AddClient` for one is timelocked by the same
  delay and proposed only after the addition was announced, so it lands after the new shared client is in force.
  Such a scope accepts every shared client (and the login page behind it) Hana adds.
- **Removed shared clients are retired.** A client dropped from `set_shared_clients` (in force or still pending) gets a
  permanent `removed_clients` record with scope id `#shared`, so no scope can ever claim it
  (`Client was a shared client and is retired`): anyone able to load Hana's login page could otherwise mint tokens
  for it with a nonce of their choosing. Hana may put it back on the shared list (timelocked like any addition).
- **Client proofs prove less than they seem.** Any user who can sign in to a client app can usually obtain a token
  for that `aud` with a nonce of their choosing (e.g. from the browser console on the app's origin), so a client
  proof shows "can sign in to this app", not "controls this OAuth client". Uniqueness, the timelock and owner
  cancellation limit the damage for registered clients. **Unregistered clients can be squatted as soon as any scope
  exists**, not only once `public_registration` is on: `propose_change(AddClient)` is open to every scope owner
  whatever the registration state, so while registration is closed any owner of an admin-registered scope can claim
  a client nobody has registered yet (another partner's client before Hana onboards it, or a Hana console audience
  not in `global`), and Hana can't undo it after `execute_change`. Mitigation: register Hana's console audiences and
  known partner clients early; watch `change_proposed` events (the timelock leaves time to register the client
  first with `admin_register_scope`, which wins: the pending add then fails at execute). Revisit before enabling
  public registration.
- **Removing a client.** `remove_client` is immediate, but the client id is quarantined for `change_delay_ms` so
  one owner can't remove it and claim it in a scope they control (via `register_scope`, or an `AddClient` in another
  scope whose timelock the original owners can't cancel), or have Hana list it as shared, before co-owners react.
  Co-owners can re-add it at once (timelocked as usual); a re-add proposed during the quarantine keeps the client
  reserved until it executes, so the quarantine can't run out before it does. A malicious co-owner can still deny
  service on their own scope (remove clients, cancel every re-add, which also releases the reservation); the
  multi-owner model trusts each owner that far.
- **Proofs are bound to a deployment.** Since A.2 every nonce starts with borsh(contract account id), so a token
  used on one deployment (public on-chain) can't be replayed on another, even though scope ids and `action_nonce`
  values repeat across deployments.
- **OIDC owners trust the console code.** An `Oidc` owner's token is obtained on Hana's console; console code that
  asks for a nonce of a different action could act as that owner. The timelock (adds, owner changes) plus events
  give other owners time to cancel; NEAR-account owners avoid this.
- **Front-running.** Tokens and proofs are visible in the mempool. Replaying the same args has the same effect
  (harmless). Since A.2 the session nonce commits to `scope_id` and `max_uses`, and a register proof to the owners,
  the full client list and `allow_shared`, so a front-runner can't change any of them. A replay of
  `create_session_and_derive` is not quite harmless: it spends counter 1 for the session key holder (the MPC answer
  is still encrypted to their BLS key), so a `max_uses = 1` session needs a new login. The attacker pays the gas and
  learns nothing. Since v3 a bare `create_session` needs the session key's proof of possession (D137), so a published
  token can't be used to occupy a session key with another session (which, for a linked login, a careless recovery
  could have turned into an unlinked derivation; callers follow the recovery rule under `create_session_and_derive`).
- **No PII check on chain.** The contract ignores claims it doesn't use (see Token verification), so it never
  refuses a token for carrying `email`, `name` or `hd`. The API and the vault refuse such tokens on the paths they
  control; a direct caller isn't bound by that.
- **Storage.** Scopes and pending changes are paid by the caller (sponsors exempt); counts per scope are capped.
  A sponsor (the relayer) gives free storage to whoever it relays for, so the API must not relay `register_scope`
  without its own authentication and rate limit. Since a shared-only scope needs no proof, scopes are no longer
  bounded by OAuth clients; to keep sponsored proposals from multiplying contract-paid storage, a sponsor may queue
  at most 2 changes on a scope without clients, and a non-sponsor registering such a scope prepays that storage
  (3002 bytes). Residual: a scope that queued sponsored changes while it had a client keeps them after removing its
  last client (allowed with `allow_shared`), and the client can join another scope after its quarantine; each cycle
  costs a client proof and `change_delay_ms`, and the API's owner-action rate limit still bounds the total. Keep the contract account funded: it pays for sponsored
  registrations, sessions and the 1 yoctoNEAR per CKD request. `execute_change(AddClient)` is free to call; its
  client index record is charged to the proposer at `propose_change`. `remove_client` is free and leaves a
  quarantine record about the size of the index record it frees (deleted when the client is claimed again).
  Sessions are paid by the contract, bounded by token issuance and pruned after ≤ 24 h (+ ≤ 24 h FIFO lag).
