# hana-signer contract interface (batch A)

The exact on-chain interface of `contracts/hana-signer`. The API, scripts, console and SDK must match this file.
If the code and this file disagree, the code is wrong: raise it.

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
- Recommended gas: 300 Tgas for every change method (the relayer's default). `derive_key` forwards a fixed 20 Tgas
  to the MPC; it needs ≥ 50 Tgas attached. View methods cost nothing.

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

// Session (create_session / get_session)
{"path":"s1#google#110248495921238986420#0","scope_id":"s1","expires_at_ms":1800003600000,"max_uses":3,"used":0}

// Scope (get_scope)
{
  "id": "s1",
  "owners": [{"Near":{"account_id":"alice.testnet"}}],
  "clients": [["google","123-abc.apps.googleusercontent.com"]],   // [provider, aud] pairs
  "pending": [{"id":0,"change":{"AddClient":{"provider":"google","aud":"456-def.apps.googleusercontent.com"}},"unlock_at_ms":1800172800000}],
  "action_nonce": 1,
  "created_at_ms": 1800000000000
}

// Config (get_config)
{
  "owner": "hana-id-admin-dev1.testnet",
  "mpc": "v1.signer-prod.testnet",
  "ckd_domain_id": 2,
  "console_audiences": [["google","console.apps.googleusercontent.com"]],
  "sponsors": ["hana-id-relayer-dev1.testnet"],
  "change_delay_ms": 172800000,                 // the delay in force now
  "pending_change_delay": null,                 // or {"change_delay_ms":60000,"effective_at_ms":1800172800000}
  "public_registration": false
}

// Issuer (get_issuer) — key material is not returned, only key ids
{"provider":"google","iss_values":["https://accounts.google.com","accounts.google.com"],"kids":["a1b2...","c3d4..."]}
```

Identifiers:

- **scope_id**: assigned by the contract: `"s"` + lowercase base36 of a counter starting at 1 (`s1` … `s9`, `sa` … `sz`,
  `s10`, …). The only other id is the reserved `"global"` (Hana's own app, `admin_register_scope` only). Scope ids
  therefore match `^[a-z0-9]+$`.
- **provider**: `^[a-z0-9_-]{1,32}$` (e.g. `google`). Never contains `#`.
- **aud** (client id): 1..=256 bytes. **sub**: 1..=255 bytes, must not contain `#`.
- **path** (MPC derivation path): `{scope_id}#{provider}#{sub}#{key_index}`, key_index in decimal without leading
  zeros. Example `s1#google#110248495921238986420#0`. Changing anything in this format changes every address.

Limits: 1..=5 owners per scope, 1..=10 clients per scope, ≤ 10 pending changes per scope, ≤ 10 RSA keys per issuer,
≤ 4 iss values per issuer, ≤ 10 console audiences, ≤ 10 sponsors, JWT ≤ 7168 bytes, kid ≤ 128 bytes,
session ≤ 24 h, `max_uses` 1..=500, `change_delay_ms` ≤ 7 days.

## Token verification (all methods that take a JWT)

A JWT is accepted when, in this order:

1. It has three dot-separated base64url parts and is ≤ 7168 bytes (`JWT too large`, `JWT must have three parts`,
   `Malformed base64url`, `Malformed JWT header`, `Malformed JWT claims`). Header needs `alg` and `kid`; claims need
   `iss`, `aud` (a single string), `sub`, `exp`; `nonce` is optional at parse time.
2. `iss` is one of a configured issuer's `iss_values` → that issuer's `provider` (`Unknown token issuer`).
3. `kid` is one of that issuer's keys (`Unknown signing key`).
4. `alg` is supported: only `RS256` today (`Unsupported JWT algorithm`).
5. The signature verifies (RSASSA-PKCS1-v1_5 / SHA-256 over `header.payload`) (`Invalid token signature`).
6. `exp * 1000 > block_timestamp_ms` (`Token expired`).
7. `sub` is 1..=255 bytes without `#` (`Invalid sub`); `aud` is 1..=256 bytes (`Invalid aud`).

The verified token yields `(provider, aud, sub, nonce)`. Each method then checks `nonce` against the
commitment below (`... nonce ...` panics). Tokens are public once used on-chain; every use is bound by its nonce to
one purpose, so a published token can't be reused for anything else.

## Byte layouts (nonces, commitments, signed messages)

The four nonces (session nonce, register proof, client proof, owner-action nonce) are reproduced by
`contracts/hana-signer/scripts/gen-fixtures.mjs` (an independent JS implementation used to generate the unit-test
tokens). The Rust tests check their own nonces against the ones that script writes, so those four agree byte for byte.
The session message and its CKD payload (`derive_key`, `revoke_session`) have no independent implementation yet. Only
Rust unit tests check them, and they test the Rust code against itself. An SDK that builds these bytes must follow
the layout below exactly, and can compare its output with the `session_message(counter, payload)` view. A mismatch
shows up on chain only as `Invalid session signature`.

### Session nonce (`create_session`)

```
nonce = b64url(sha256( session_public_key (32 bytes)
                     ‖ expires_at_ms  u64 LE
                     ‖ key_index      u32 LE
                     ‖ salt           (16..=64 bytes) ))
```

`max_uses` is not committed (see Security notes).

### Register proof (`register_scope`)

```
nonce = b64url(sha256( "hana-id/register/v1" ‖ borsh(owners: Vec<Owner>) ))
```

One token per client being registered; each token's `(provider, aud)` is a client, all with this same nonce.

### Client proof (`propose_change` with `AddClient`)

```
nonce = b64url(sha256( "hana-id/client-proof/v1" ‖ scope_id (UTF-8, no length prefix) ‖ action_nonce u64 LE ))
```

`action_nonce` is the scope's current value (before the call increments it). The token's `(provider, aud)` must
equal the `AddClient` change. (Unambiguous without a length prefix: scope ids are `[a-z0-9]+` and the tail is a
fixed 8 bytes.)

### Owner-action nonce (`OwnerAuth::Oidc`)

```
nonce = b64url(sha256( "hana-id/owner-action/v1"
                     ‖ scope_id     (UTF-8, no length prefix)
                     ‖ method_name  (UTF-8, no length prefix: "propose_change" | "cancel_change" | "remove_client")
                     ‖ borsh(args without auth)
                     ‖ action_nonce u64 LE ))
```

`borsh(args without auth)` is every argument of the call except `auth`, in declaration order, each Borsh-encoded and
concatenated:

| method | args without auth |
|---|---|
| `propose_change` | `borsh(scope_id: String) ‖ borsh(change: Change) ‖ borsh(client_proof: Option<String>)` |
| `cancel_change` | `borsh(scope_id: String) ‖ borsh(change_id: u64)` |
| `remove_client` | `borsh(scope_id: String) ‖ borsh(provider: String) ‖ borsh(aud: String)` |

For `propose_change(AddClient)` the owner token therefore commits to the exact client-proof JWT: obtain the client
proof first, then the owner token. `action_nonce` is the scope's current value; any successful `propose_change`,
`cancel_change` or `remove_client` on the scope (with either auth kind) increments it, so a used owner token can
never be replayed, and a token prepared before another owner's action must be re-obtained.

### Session message (`derive_key`, `revoke_session`)

The session key (Ed25519) signs:

```
session_message(counter, payload) = "hana-embed-session-v1:" ‖ counter u64 LE ‖ sha256(payload)
```

- `derive_key`: `payload = "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2` (UTF-8 of the two strings exactly as passed).
  **Renamed** from `hana-embed-ckd-v1:` in batch A (SDK follows in batch B).
- `revoke_session`: `payload = "revoke"`.
- `counter` must equal `used + 1`. The view `session_message(counter, payload)` returns these bytes.

### Borsh encodings used above

| Type | Encoding |
|---|---|
| `String` | `u32 LE` byte length ‖ UTF-8 bytes |
| `u64` | 8 bytes LE |
| `Option<String>` | `0x00` (None) or `0x01` ‖ borsh(String) |
| `Vec<T>` | `u32 LE` count ‖ each element |
| `Owner::Near { account_id }` | `0x00` ‖ borsh(account_id as String) |
| `Owner::Oidc { provider, sub }` | `0x01` ‖ borsh(provider) ‖ borsh(sub) |
| `Change::AddClient { provider, aud }` | `0x00` ‖ borsh(provider) ‖ borsh(aud) |
| `Change::SetOwners { owners }` | `0x01` ‖ borsh(Vec<Owner>) |

## Methods

Caller roles: **owner** = `config.owner` (Hana admin), **self** = the contract account itself (a function-call key on
it), **scope owner** = authenticated via `OwnerAuth`, **anyone**.

### Init

#### `new(owner, mpc, ckd_domain_id, change_delay_ms)` — init, once

```json
{"owner":"hana-id-admin-dev1.testnet","mpc":"v1.signer-prod.testnet","ckd_domain_id":2,"change_delay_ms":60000}
```

Panics: `change_delay_ms must be at most 7 days`. Starts with no issuers, no scopes, `public_registration = false`,
no sponsors, no console audiences.

### Config (owner only, `Only the owner can do this`)

| Method | Args example | Notes |
|---|---|---|
| `set_owner(owner)` | `{"owner":"new-admin.testnet"}` | Immediate. |
| `set_sponsors(sponsors)` | `{"sponsors":["relayer.testnet"]}` | Replaces the list. ≤ 10 (`Too many sponsors`). Function-call access keys can't attach deposits, so a relayer calling `register_scope` / `propose_change` with such a key must be a sponsor. |
| `set_console_audiences(audiences)` | `{"audiences":[["google","console.apps.googleusercontent.com"]]}` | Replaces the list. ≤ 10 (`Too many console audiences`), `Invalid provider`, `Invalid aud`. |
| `set_change_delay_ms(change_delay_ms)` | `{"change_delay_ms":172800000}` | ≤ 7 days. An increase applies now. A **decrease** applies only after the current delay has passed (`pending_change_delay`), so the admin can't shorten a timelock to act on scopes faster than owners were promised. Already queued changes keep their `unlock_at_ms`. |
| `enable_public_registration()` | `{}` | One way: false → true, never back. No-op if already true. Event `public_registration_enabled`. |

Views: `get_config()` → Config.

### Issuers

| Method | Who | Args example |
|---|---|---|
| `set_issuer(provider, iss_values)` | owner | `{"provider":"google","iss_values":["https://accounts.google.com","accounts.google.com"]}` |
| `set_issuer_key(provider, kid, n, e)` | owner **or self** | `{"provider":"google","kid":"a1b2","n":"<JWK n, base64url>","e":"AQAB"}` |
| `remove_issuer_key(provider, kid)` | owner **or self** | `{"provider":"google","kid":"a1b2"}` → returns `true` if a key was removed |
| `get_issuer(provider)` | view | → Issuer or `null` |

- `set_issuer` creates or updates; keys are kept on update. Each iss value 1..=256 bytes, 1..=4 values, and no iss
  value may belong to another provider (`iss value already used by another provider`).
- `set_issuer_key`: issuer must exist (`Unknown issuer`); `n`, `e` are JWK base64url (plain base64 also accepted);
  RSA modulus 2048..=4096 bits (`RSA modulus must be 2048-4096 bits`), exponent 1..=8 bytes, odd, > 1. Overwrites
  an existing kid. ≤ 10 keys (`Too many keys for this issuer`). Event `issuer_key_set`.
- `remove_issuer_key`: no-op (returns `false`) if absent. Event `issuer_key_removed` only when removed.
- Other panics: `Only the owner or the contract account can do this`, `Invalid provider`,
  `An issuer needs 1 to 4 iss values`, `Invalid iss value` (empty or > 256 bytes), `Duplicate iss value`,
  `Invalid kid` (empty or > 128 bytes), `Invalid RSA exponent`, `Malformed key component`.

### Registry

#### `admin_register_scope(owners, clients, scope_id)` — owner, only while `public_registration == false`

```json
{"owners":[{"Near":{"account_id":"hana-id-admin-dev1.testnet"}}],
 "clients":[["google","123-abc.apps.googleusercontent.com"]],
 "scope_id":"global"}
```

`scope_id`: `null` (contract assigns `sN`) or `"global"` (only allowed value). Returns the scope id (`"s1"`).
No proofs. Contract pays storage. Panics: `Admin registration is closed: public registration is enabled`,
`Only "global" can be chosen as a scope id`, `Scope already exists`, owner/client validation (below).
Event `scope_registered`.

#### `register_scope(owners, client_proofs)` — anyone, only while `public_registration == true`, payable

```json
{"owners":[{"Oidc":{"provider":"google","sub":"1102..."}}],"client_proofs":["eyJ...","eyJ..."]}
```

Each proof is a verified token whose nonce is the Register proof above; the clients are the proofs'
`(provider, aud)`. Returns the scope id. Storage: the caller attaches ≥ the storage the call adds
(`bytes × storage_byte_cost`: 262 bytes ≈ 0.0026 NEAR for one client and two owners; attach 0.01 NEAR); the excess is refunded to the caller. Callers in
`sponsors` are exempt and any deposit they attach is refunded in full. Panics: `Public registration is not enabled`,
`Proof nonce doesn't commit to these owners`, `Attached deposit doesn't cover storage: need N yoctoNEAR`, plus
client/owner validation. Event `scope_registered`.

Owner validation: 1..=5 owners (`A scope needs 1 to 5 owners`), no duplicates (`Duplicate owner`), valid provider and
sub for `Oidc` owners. Client validation: 1..=10 (`A scope needs 1 to 10 clients`), provider must be a configured
issuer (`Unknown issuer`), no duplicates (`Duplicate client`), not registered anywhere
(`Client is already registered`), not quarantined after a `remove_client`
(`Client was recently removed from another scope`; applies to `admin_register_scope` too).

#### `propose_change(scope_id, auth, change, client_proof)` — scope owner, payable

```json
{"scope_id":"s1","auth":"Near",
 "change":{"AddClient":{"provider":"google","aud":"456-def.apps.googleusercontent.com"}},
 "client_proof":"eyJ..."}
```

Returns the change id (`u64`, = the scope's `action_nonce` before the call; unique within the scope). Queues the
change with `unlock_at_ms = now + change_delay_ms`. Increments `action_nonce`.

- `AddClient` needs `client_proof` (`AddClient needs a client_proof`; Client proof above, token `(provider, aud)` must equal the change:
  `Client proof is for another client`, `Client proof nonce doesn't match`); the client must not be registered
  anywhere (`Client is already registered`), not quarantined by a removal from **another** scope
  (`Client was recently removed from another scope`; the scope it was removed from may re-add it at once), not already
  pending in this scope (`Client is already pending`), and the scope must have room (`A scope needs 1 to 10 clients`).
- `SetOwners`: owners validated as above; `client_proof` must be `null` (`client_proof is only for AddClient`).
- ≤ 10 pending (`Too many pending changes`). Storage paid like `register_scope` (sponsors exempt). For `AddClient`
  the charge also covers the client index record that `execute_change` will add (40 + 1 + borsh((provider, aud)) +
  borsh(scope_id) bytes), since `execute_change` is free to call: ≈ 156 bytes ≈ 0.0016 NEAR for a Google client in
  `s1`; attach 0.01 NEAR. Nothing is refunded if the change is cancelled.
- Event `change_proposed`.

#### `execute_change(scope_id, change_id)` — anyone

```json
{"scope_id":"s1","change_id":0}
```

Applies a pending change once `now >= unlock_at_ms` (`Change is still timelocked`). Re-checks: `AddClient` client
still unregistered (`Client is already registered`), not quarantined for another scope
(`Client was recently removed from another scope`) and room in the scope (`A scope needs 1 to 10 clients`);
`SetOwners` re-validated. On a failed
re-check the change stays pending until an owner cancels it. Panics: `No such scope`, `No such change`.
Event `change_executed`.

#### `cancel_change(scope_id, auth, change_id)` — scope owner

```json
{"scope_id":"s1","auth":{"Oidc":{"jwt":"eyJ..."}},"change_id":0}
```

Removes a pending change (any owner may cancel any pending change, including one proposed by a removed owner).
Increments `action_nonce`. Event `change_cancelled`.

#### `remove_client(scope_id, auth, provider, aud)` — scope owner

```json
{"scope_id":"s1","auth":"Near","provider":"google","aud":"456-def.apps.googleusercontent.com"}
```

Immediate: the client stops resolving to the scope at once. The client id is then **quarantined** until
`free_at_ms = now + change_delay_ms` (the delay in force at removal): until then only this scope may take it back
(`propose_change(AddClient)` here is allowed at once, with the usual timelock), and every other path
(`register_scope`, `admin_register_scope`, `propose_change` / `execute_change` in another scope) fails with
`Client was recently removed from another scope`. So a single owner can't move a client out of a shared scope into
another scope faster than the timelock other owners rely on. Panics: `Client is not in this scope`,
`Cannot remove the last client`. Increments `action_nonce`. Event `client_removed` (with `free_at_ms`).

#### Owner auth panics

`No such scope`, `Caller is not a NEAR owner of this scope` (Near), `Token is not for the Hana console`
(Oidc: token `(provider, aud)` ∉ `console_audiences`), `Token is not from an owner of this scope`,
`Owner token nonce doesn't match this action` (wrong args, wrong method, or replay: `action_nonce` moved on).

#### Registry views

| Method | Args | Returns |
|---|---|---|
| `get_scope(scope_id)` | `{"scope_id":"s1"}` | Scope or `null` |
| `scope_for_client(provider, aud)` | `{"provider":"google","aud":"123-abc..."}` | `"s1"` or `null` |

### Sessions and CKD

#### `create_session(jwt, session_public_key, expires_at_ms, salt, key_index, max_uses)` — anyone

```json
{"jwt":"eyJ...","session_public_key":[234,74,...32 bytes],"expires_at_ms":1800003600000,
 "salt":[9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9],"key_index":0,"max_uses":3}
```

Returns Session. Checks, in order: `Session key must be a 32-byte Ed25519 public key`, `Salt must be 16-64 bytes`,
`Session expiry must be within 24 hours` (now < expires_at_ms ≤ now + 24 h), `max_uses must be 1-500`,
`Session key already in use` (an unexpired session, including a revoked one, exists for this key), token
verification, `Token is for an unregistered app` (no scope for the token's `(provider, aud)`),
`Token nonce doesn't commit to this session`. Path = `{scope}#{provider}#{sub}#{key_index}`. Then prunes up to 3
expired sessions. Not payable; the contract pays session storage (≈ 250 bytes, freed by pruning).

#### `derive_key(session_public_key, counter, signature, pk1, pk2)` — anyone

```json
{"session_public_key":[...32],"counter":1,"signature":[...64],"pk1":"bls12381g1:...","pk2":"bls12381g2:..."}
```

`signature` = Ed25519 over `session_message(counter, "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2)`. Panics:
`No such session` (missing or revoked), `Session expired`, `Session use limit reached`,
`Wrong counter (replayed or out of order)`, `Bad session key`, `Signature must be 64 bytes`, `Invalid session signature`,
`BLS key too long` (pk1/pk2 > 512 bytes). Increments `used`, then calls the MPC:

```json
// mpc.request_app_private_key, 1 yoctoNEAR (paid by the contract), 20 Tgas
{"request":{"derivation_path":"s1#google#1102...#0","app_public_key":{"AppPublicKeyPV":{"pk1":"...","pk2":"..."}},"domain_id":2}}
```

Returns the MPC's result unchanged: `{"big_y":"bls12381g1:...","big_c":"bls12381g1:..."}`.

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
| `get_session(session_public_key)` | `{"session_public_key":[...32]}` | Session or `null` (also `null` once revoked) |
| `session_message(counter, payload)` | `{"counter":1,"payload":[...]}` | bytes to sign (`Vec<u8>`) |

## Events (NEP-297)

Logged as `EVENT_JSON:{"standard":"hana-id","version":"1.0.0","event":"<name>","data":[{...}]}` (`data` is a
one-element array, as in NEP-171).

| event | data |
|---|---|
| `scope_registered` | `{"scope_id","owners":[Owner],"clients":[[provider,aud]],"by":"account","admin":bool}` |
| `change_proposed` | `{"scope_id","change_id","change":Change,"unlock_at_ms","by":Owner}` |
| `change_executed` | `{"scope_id","change_id","change":Change}` |
| `change_cancelled` | `{"scope_id","change_id","by":Owner}` |
| `client_removed` | `{"scope_id","provider","aud","free_at_ms","by":Owner}` |
| `public_registration_enabled` | `{}` |
| `issuer_key_set` | `{"provider","kid"}` |
| `issuer_key_removed` | `{"provider","kid"}` |

`by: Owner` is the authenticated owner (`{"Near":{...}}` or `{"Oidc":{...}}`).

## Removed in batch A

`sign`, `on_verified`, `sign_with_session`, `sign_target`, envelopes, `config()`, `migrate`, `set_google_key`,
`remove_google_key`, `has_google_key`, `set_google_client_ids`, `google_client_ids`, the `scope` and
`max_signatures` arguments of `create_session` (now `key_index`, `max_uses`), the `SCOPES` list.

## Security notes (for reviewers)

- **Hana's trust surface.** The owner (and the contract account) controls issuer keys: whoever can post a Google key
  can mint any token, so this is total control in the PoC, as is contract upgrade (no lock in batch A). Beyond
  that, Hana cannot change a scope's clients or owners, and cannot block derivation for a scope.
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
  scope whose timelock the original owners can't cancel) before co-owners react. Co-owners can re-add it at once
  (timelocked as usual). A malicious co-owner can still deny service on their own scope (remove clients, cancel every
  re-add); the multi-owner model trusts each owner that far.
- **Proofs are not bound to a deployment.** Owner-action, client-proof and register nonces commit to scope ids and
  `action_nonce`, not to the contract account. Scope ids are sequential and `action_nonce` starts at 0, so two
  deployments (e.g. `sandbox-dev` and a later env) can share a nonce, and a token used on one (public on-chain) can
  be replayed on the other within its ~1 h lifetime. Until the layouts include the contract account, give each
  deployment its own console audience (`consoleAudiences`) and don't reuse owner identities and client ids across
  deployments you care about. Fixing this changes no derived keys.
- **OIDC owners trust the console code.** An `Oidc` owner's token is obtained on Hana's console; console code that
  asks for a nonce of a different action could act as that owner. The timelock (adds, owner changes) plus events
  give other owners time to cancel; NEAR-account owners avoid this.
- **Front-running.** Tokens and proofs are visible in the mempool. Replaying the same args has the same effect
  (harmless). `create_session`'s `max_uses` is not in the nonce, so a front-runner could open the session with a
  lower cap (griefing only: the user retries). A register proof commits to the owners but not to the client set,
  so a front-runner could register a subset of the clients with the same owners.
- **Storage.** Scopes and pending changes are paid by the caller (sponsors exempt); counts per scope are capped.
  A sponsor (the relayer) gives free storage to whoever it relays for, so the API must not relay `register_scope`
  without its own authentication and rate limit. Keep the contract account funded: it pays for sponsored
  registrations, sessions and the 1 yoctoNEAR per CKD request. `execute_change(AddClient)` is free to call; its
  client index record is charged to the proposer at `propose_change`. `remove_client` is free and leaves a
  quarantine record about the size of the index record it frees (deleted when the client is claimed again).
  Sessions are paid by the contract, bounded by token issuance and pruned after ≤ 24 h (+ ≤ 24 h FIFO lag).
