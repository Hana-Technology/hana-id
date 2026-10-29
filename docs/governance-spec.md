# Governance spec: delayed issuer keys, watchdog, multisig owner, timelocked upgrades (pre-mainnet)

**Status: DRAFT (2026-10-29), for the user's review.** Implements `docs/decisions.md` D33 (confirmed 2026-10-28) and
closes `docs/security.md` open issue (e). Every value marked *provisional* and every numbered open question needs the
user's answer before implementation. Nothing here is built.

This file is the source of truth for the batch once approved. If code and this spec disagree, fix the code or raise
the problem. Reference docs (`contract-interface.md`, `security.md`, `operations.md`, `architecture.md`, `api.md`)
are updated in the same branch as the code, not now.

## Amends

| Document | Amendment |
|---|---|
| `contract-interface.md` "Issuers" | `set_issuer_key` queues a pending key instead of installing it; `remove_issuer_key` is owner-only; new pending-change, watchdog, pause, upgrade and owner-transfer methods (below). |
| `contract-interface.md` "Config" | `set_owner` is replaced by `propose_owner` / `accept_owner` (delayed). New delays `issuer_key_delay_ms`, `governance_delay_ms`. |
| `contract-interface.md` "Events" | New events; `issuer_key_set` now means "a key entered the active set" (emitted at execution, not at posting). Events version `1.0.0` → `1.1.0`. |
| `security.md` "What a compromise gives", "Parties", key inventory, open issue (e) | Replaced by [What each party can do after this batch](#what-each-party-can-do-after-this-batch). |
| `decisions.md` D33 | Delay formula and provisional values, the watchdog's exact powers, the multisig choice. D33's status moves to "in force" when merged. |
| `operations.md` key rotation, deploy, upgrade | Upgrades through the owner multisig; no signer full-access key; watchdog service. |
| `apps/api` JWKS cron | Proposes keys and removals, executes matured ones; runs every 15 min. |

## Goal

After this batch no single hot key and no single service can install a Google signing key or replace the contract
faster than a public, cancellable delay:

- A newly posted issuer key becomes usable only after `issuer_key_delay_ms`, during which an independent watchdog
  (own NEAR account and key, own service, not on the API's Cloudflare account) cancels it if Google doesn't publish
  it. The watchdog may activate a key early when it matches Google's JWKS.
- Every pending key for a kid Google doesn't publish raises an alert from the watchdog itself.
- The contract owner is a 2-of-3 multisig (recommended: a Sputnik DAO v2 council).
- The signer account has no full-access key. Code changes only through `propose_upgrade` (owner) → public notice →
  `execute_upgrade` after `governance_delay_ms`.
- An emergency pause stops derivation and every token check; it can't post keys or change code. Only the owner
  unpauses.

Done when every behaviour under [Tests](#tests) has a passing test, sandbox-dev runs the new contract migrated in
place (same signer account, same addresses), its owner is a testnet DAO, its signer account has no full-access key,
and one upgrade has gone through the full propose → wait → execute path.

## Address impact (read first)

**None.** Addresses depend on the MPC network, the signer account id (in the CKD `app_id`), the path
`scope#provider#sub#key_index` and derivation v1 (`docs/architecture.md` "What decides an address"). This batch keeps
all four:

- The contract is upgraded **in place** on the same signer account with a `migrate` that keeps every scope, client,
  session and issuer key (`Issuer` layout unchanged). A fresh deploy to a new signer account would change every
  address and is **not** allowed by this spec.
- Removing the signer's full-access key, the multisig owner, the watchdog and pause change who may call what, not
  the account id, the path or the CKD request (`sessions.rs` `derive_key` is unchanged).
- On mainnet the final signer account is created with governance in place from the first transaction, so the
  address freeze isn't touched later.

## Current state (verified against the code, `develop` at 0de90fd)

- `set_issuer_key(provider, kid, n, e)` installs a key at once, callable by the owner **or the contract account
  itself** (`assert_owner_or_self`, `issuers.rs:84`, `:114`); it overwrites an existing kid; ≤ 10 keys per issuer;
  event `issuer_key_set {provider, kid}`. `remove_issuer_key` likewise, immediate, returns whether a key was removed
  (`issuers.rs:98`). `set_issuer` is owner-only (`issuers.rs:55`).
- "Self" is the keys-updater function-call key on the signer account, methods `set_issuer_key`,
  `remove_issuer_key`, receiver the signer, allowance 1 NEAR (`scripts/lib/contract.ts:24`,
  `scripts/lib/deploy-plan.ts` "keys-updater"). The API Worker holds it as `KEYS_UPDATER_KEY` and syncs Google's JWKS
  every hour (`apps/api/src/issuer-keys.ts`, cron `0 * * * *` in `apps/api/scripts/gen-wrangler.ts:71`): adds new
  kids at once, removes a kid only after it has been missing for ≥ 55 min (`REMOVE_AFTER_MISSING_MS`).
- `verify_token` looks the kid up in `issuer.keys` only (`issuers.rs:124`, panic `Unknown signing key`).
- `set_owner` is immediate, owner-only (`lib.rs:168`). Owner-only config: `set_sponsors`, `set_console_audiences`
  (both immediate), `set_change_delay_ms` (increase now, decrease after the current delay), `set_shared_clients`
  (additions after `change_delay_ms`), `enable_public_registration`, `set_issuer`, `admin_register_scope`.
- There is **no** upgrade or `migrate` method (`migrate` was removed in batch A, `contract-interface.md` "Removed in
  batch A"). Upgrades are a `DeployContract` action signed by the signer's full-access key
  (`scripts/lib/deploy-run.ts` `deploy`, `deploy-contract --upgrade`).
- `deploy-contract` signs owner steps with the owner's full-access key from `~/.near-credentials`
  (`deploy-plan.ts` `stepSigner`); `post-google-keys --as-owner` and `admin scope:register` do too.
- Events: NEP-297, standard `hana-id`, version `1.0.0` (`events.rs`).

## Roles after this batch

| Role | Account | Key held by | Calls |
|---|---|---|---|
| **owner** | multisig contract account (DAO), `envs/<env>.json` `owner` | 3 council members (hardware wallets) | config, `set_issuer_key` (delayed like the updater's), `remove_issuer_key`, watchdog set, updater keys, unpause, upgrades, owner transfer |
| **watchdog** | 1..=3 accounts, manifest `watchdogs` | watchdog service: a function-call key on its own account (receiver signer) | cancel and confirm pending key changes, pause, delete an updater key |
| **updater** ("self") | the signer account | API Worker `KEYS_UPDATER_KEY`, a function-call key the contract installs | `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change` |
| **anyone** | — | — | `execute_issuer_key_change` and `execute_upgrade` once due; views |

The signer account has no full-access key. Its only access keys are updater keys the contract added itself.

## Contract changes (`contracts/hana-signer`)

### New state (root struct; `Issuer` unchanged)

```rust
pub struct HanaSigner {
    // ... every existing field, unchanged ...
    pub(crate) state_version: u32,                       // 2 after this batch
    pub(crate) issuer_key_delay_ms: u64,
    pub(crate) pending_issuer_key_delay: Option<DelayChange>,  // a decrease, due after governance_delay_ms
    pub(crate) governance_delay_ms: u64,
    pub(crate) pending_governance_delay: Option<DelayChange>,  // a decrease, due after the current governance delay
    pub(crate) watchdogs: Vec<Watchdog>,                 // ≤ MAX_WATCHDOGS = 3
    /// Time-based activation of key changes waits at least until here (set when a watchdog is removed).
    pub(crate) keys_slow_until_ms: u64,
    pub(crate) key_changes: Vec<PendingKeyChange>,       // ≤ MAX_PENDING_KEY_CHANGES = 6, all issuers
    pub(crate) next_key_change: u64,
    pub(crate) updater_keys: Vec<PublicKey>,             // ≤ MAX_UPDATER_KEYS = 2, keys the contract installed on itself
    pub(crate) paused: bool,
    pub(crate) pending_upgrade: Option<PendingUpgrade>,
    pub(crate) pending_owner: Option<PendingOwner>,
}

pub struct Watchdog { pub account_id: AccountId, pub confirm_from_ms: u64 }  // may confirm from then on
pub enum KeyOp { Add { n: Vec<u8>, e: Vec<u8> }, Remove }
pub struct PendingKeyChange {
    pub id: u64, pub provider: String, pub kid: String, pub op: KeyOp,
    pub by: AccountId, pub proposed_at_ms: u64, pub executable_at_ms: u64,
}
pub struct PendingUpgrade { pub code_hash: Base58CryptoHash, pub executable_at_ms: u64, pub proposed_at_ms: u64 }
pub struct PendingOwner { pub owner: AccountId, pub acceptable_at_ms: u64 }
```

Constants: `MAX_ISSUER_KEY_DELAY_MS = 7 days`, `MAX_GOVERNANCE_DELAY_MS = 30 days`, `MAX_UPDATER_ALLOWANCE = 1 NEAR`,
`UPDATER_METHODS = "set_issuer_key,propose_issuer_key_removal,execute_issuer_key_change"`. Storage: a pending `Add`
is ≤ ~800 bytes (n ≤ 512, kid ≤ 128, provider ≤ 32, fixed fields), so the six-entry cap bounds contract-paid
storage at ~5 KB (~0.05 NEAR).

### Issuer key changes

`set_issuer_key(provider, kid, n, e) -> u64` — **owner or self**. Validation exactly as today (kid 1..=128 bytes,
JWK base64url or base64, modulus 2048..=4096 bits, exponent rules, `Unknown issuer`). New checks: `Kid is already
active` (an active kid is never overwritten; remove it first), `Kid already has a pending change`, `Too many pending
key changes` (6), `Too many keys for this issuer` (active + pending adds ≤ 10). Queues `Add` with

```
executable_at_ms = max(now + issuer_key_delay_ms, keys_slow_until_ms, no_watchdog ? now + governance_delay_ms : 0)
```

where `no_watchdog` = `watchdogs` is empty. Event `issuer_key_proposed {id, provider, kid, n, e, executable_at_ms,
by}` (`n`, `e` base64url, so monitors can compare with the JWKS without a view). Returns the id. Gas: ~3 Tgas burnt;
the API attaches 30 Tgas as today.

`propose_issuer_key_removal(provider, kid) -> u64` — **owner or self**. Panics `Unknown issuer`, `No such key` (kid
not active), `Kid already has a pending change`, `Too many pending key changes`, `Cannot remove the last key of an
issuer` (active keys minus pending removals must stay ≥ 1). Same `executable_at_ms` rule. Event
`issuer_key_removal_proposed {id, provider, kid, executable_at_ms, by}`.

`execute_issuer_key_change(id)` — **anyone**, once `now ≥ executable_at_ms` (`Key change is still delayed`), and not
while paused (`Paused`). Re-checks: `Add` → issuer exists, kid not active, ≤ 10 keys; `Remove` → kid active and not
the last key. Applies, drops the entry, emits `issuer_key_set {provider, kid, id, how: "delay"}` or
`issuer_key_removed {provider, kid, id, how: "delay"}`. Panics `No such key change`.

`confirm_issuer_key_change(id)` — **a watchdog whose `confirm_from_ms ≤ now`** (`Only a watchdog can do this`,
`This watchdog can't confirm yet`). Executes the change now, with the same re-checks; `how: "confirmed"`, plus
`by`. The watchdog confirms only what it checked against Google's JWKS (see [Watchdog service](#watchdog-service)).
This is the early activation; k-of-n confirmation is later (open question 5).

`cancel_issuer_key_change(id)` — **owner or any watchdog** (including one that can't confirm yet). Drops the entry.
Event `issuer_key_change_cancelled {id, provider, kid, by}`.

`remove_issuer_key(provider, kid) -> bool` — **owner only** now (no longer self). Immediate, may remove the last key
(a deliberate owner action, DoS only). Also drops any pending change for that kid. Event `issuer_key_removed {provider,
kid, how: "owner"}`.

Views: `get_issuer(provider)` unchanged (active kids only). `get_key_changes() -> Vec<KeyChangeView>` (id, provider,
kid, op `"Add"`/`"Remove"`, `n`/`e` base64url for adds, `by`, `proposed_at_ms`, `executable_at_ms`).

`verify_token` is unchanged except for the pause check, so logins cost the same gas: only executed changes are in
`issuer.keys`, and a token with a pending kid fails with today's `Unknown signing key`.

### Delays

- `set_issuer_key_delay_ms(ms)` — owner. ≤ 7 days. Increase now; decrease due after `governance_delay_ms`
  (`pending_issuer_key_delay`, same pattern as `set_change_delay_ms`, `lib.rs:191`). Queued changes keep their
  `executable_at_ms`.
- `set_governance_delay_ms(ms)` — owner. ≤ 30 days. Increase now; decrease due after the current governance delay.
  Queued upgrades and owner transfers keep their times.
- `change_delay_ms` is unchanged.

### Watchdogs

- `add_watchdog(account_id)` — owner. ≤ 3 (`Too many watchdogs`), `Already a watchdog`. Cancel and pause powers
  apply at once (DoS-only); confirm power from `now + governance_delay_ms`, so a compromised owner can't add a
  yes-man that confirms a forged key faster than an upgrade. Event `watchdog_added {account_id, confirm_from_ms}`.
- `remove_watchdog(account_id)` — owner. Immediate (`Not a watchdog`). It also sets `keys_slow_until_ms = now +
  governance_delay_ms` and raises every pending key change's `executable_at_ms` to at least that. So silencing the
  watchdogs doesn't let a compromised owner install a key faster than an upgrade, while a rogue watchdog can be
  removed at once (the remaining watchdog's confirmations still activate Google's keys early). Event
  `watchdog_removed {account_id, keys_slow_until_ms}`.
- Init (`new`) watchdogs get `confirm_from_ms = 0`. `migrate` starts with none (added afterwards, delayed confirm).

### Updater keys (the signer manages its own access keys)

With no full-access key, nobody but the contract can add or delete keys on the signer account.

- `add_updater_key(public_key)` — owner. ≤ 2 (`Too many updater keys`). `Promise::new(current).add_access_key_allowance
  (public_key, Allowance::limited(MAX_UPDATER_ALLOWANCE), current, UPDATER_METHODS)`. The method list, receiver and
  allowance are constants: the contract can never add a full-access key or a key for any other method. Event
  `updater_key_added {public_key}`.
- `delete_updater_key(public_key)` — owner or any watchdog. `Promise::delete_key`. The watchdog uses it the moment it
  sees a forged proposal from "self". Event `updater_key_deleted {public_key, by}`.
- `updater_keys` tracks what the contract asked for; a failed promise (key already present) leaves it out of sync,
  so `deploy-contract` compares it with `view_access_key_list` and blocks on any other key.

### Pause

- `pause()` — owner or any watchdog. Sets `paused`; event `paused {by}`; no-op if already paused.
- `unpause()` — owner only. Event `unpaused {}`.
- While paused, `verify_token` panics `Paused` (so `create_session`, `create_session_and_derive`, `register_scope`,
  `propose_change` with a client proof and every `OwnerAuth::Oidc` action stop), `derive_key` panics `Paused`, and
  `execute_change` and `execute_issuer_key_change` panic `Paused` (nothing that may rest on a forged token matures
  into force while frozen). Still allowed: `confirm_issuer_key_change` (a watchdog-checked Google key may go live
  while paused), `revoke_session`, `prune_sessions`, NEAR-account owner actions, cancels,
  every governance method, views. Pause can't post keys, change code or move anything: the worst it does is stop
  logins.

### Upgrades

- `propose_upgrade(code_hash: Base58CryptoHash)` — owner. Replaces any pending upgrade (event
  `upgrade_cancelled` for the old one). `executable_at_ms = now + governance_delay_ms`. Event `upgrade_proposed
  {code_hash, executable_at_ms}`. The hash is NEAR's account `code_hash` format (base58 sha256 of the wasm), so
  anyone can compare it with a reproducible build and, after execution, with `view_account`.
- `cancel_upgrade()` — owner. Event `upgrade_cancelled {code_hash}`.
- `execute_upgrade()` — **anyone**, input = the raw wasm bytes (not JSON: the method reads `env::input()`).
  Panics `No pending upgrade`, `Upgrade is still delayed`, `Code doesn't match the proposed hash` (`env::sha256`),
  `Paused` is **not** checked (a fix must be deployable while paused). Clears `pending_upgrade`, emits
  `upgrade_executed {code_hash}`, returns `Promise::new(current).deploy_contract(code).function_call("migrate", {},
  0, MIGRATE_GAS = 50 Tgas)`. Deploy and migrate are one receipt's actions: if `migrate` panics, the deploy is
  rolled back with it and the old code stays. Gas (estimate, to measure in sandbox): ~30 Tgas for a 417 KB wasm
  (deploy cost per byte) + ~3 Tgas hashing + input bytes + migrate; attach 300 Tgas. The wasm must fit the 1.5 MiB
  transaction limit (today 417 KB). The signer's balance must cover the new code's storage.
- `migrate()` — `#[private] #[init(ignore_state)]`: callable only by the contract account (its own promise from
  `execute_upgrade`; no access key on the signer lists `migrate`). Reads the previous layout, writes the new one,
  bumps `state_version`, panics `Unexpected state version` if the stored version isn't the one this code migrates
  from (so a stray re-run can't corrupt state). Each future version ships its own `migrate`; a version with no layout
  change ships a no-op that checks and keeps `state_version`.
- The **first** migration (v1 → v2, this batch) runs while the signer still has its full-access key:
  `deploy-contract --upgrade` sends `DeployContract` + `migrate_v1(issuer_key_delay_ms, governance_delay_ms)` in one
  transaction. v1 state has no `state_version` field: `migrate_v1` reads the exact v1 root struct (a copy kept in
  `src/migrate.rs` with a borsh round-trip test against a v1 state fixture) and starts with no watchdogs, no pending
  anything, `paused = false`, `updater_keys = []` (the existing updater key is replaced, see migration plan).
  `migrate_v1` is `#[private]` too and is deleted in the next version; on v2 state it can only fail (the v1 layout
  doesn't deserialize).

### Owner transfer

- `set_owner` is removed (`Method set_owner not found` for old callers).
- `propose_owner(owner)` — owner. `acceptable_at_ms = now + governance_delay_ms`; replaces a pending one. Event
  `owner_proposed {owner, acceptable_at_ms}`.
- `cancel_owner_proposal()` — owner.
- `accept_owner()` — the proposed account, after the delay (`Not the proposed owner`, `Owner change is still
  delayed`). Proves the new account (a DAO) can actually call the contract before it gets control. Event
  `owner_changed {old, new}`.

### `new` (fresh deployments, i.e. mainnet)

`new(owner, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs)`. Same panics
as today plus the delay bounds and `Too many watchdogs`.

### Views

`get_config()` gains `issuer_key_delay_ms`, `pending_issuer_key_delay`, `governance_delay_ms`,
`pending_governance_delay`, `paused`. New `get_governance() -> {watchdogs, keys_slow_until_ms, updater_keys,
pending_upgrade, pending_owner, state_version}`.

### Events

Version `1.1.0` (additive; `issuer_key_set` / `issuer_key_removed` gain fields and move to execution time).

| event | data |
|---|---|
| `issuer_key_proposed` | `{id, provider, kid, n, e, executable_at_ms, by}` |
| `issuer_key_removal_proposed` | `{id, provider, kid, executable_at_ms, by}` |
| `issuer_key_set` | `{provider, kid, id, how: "delay"\|"confirmed", by?}` |
| `issuer_key_removed` | `{provider, kid, id?, how: "delay"\|"confirmed"\|"owner", by?}` |
| `issuer_key_change_cancelled` | `{id, provider, kid, by}` |
| `watchdog_added` / `watchdog_removed` | `{account_id, confirm_from_ms}` / `{account_id, keys_slow_until_ms}` |
| `updater_key_added` / `updater_key_deleted` | `{public_key}` / `{public_key, by}` |
| `paused` / `unpaused` | `{by}` / `{}` |
| `upgrade_proposed` / `upgrade_cancelled` / `upgrade_executed` | `{code_hash, executable_at_ms}` / `{code_hash}` / `{code_hash}` |
| `owner_proposed` / `owner_changed` | `{owner, acceptable_at_ms}` / `{old, new}` |
| `delay_changed` | `{which: "issuer_key"\|"governance", value_ms, effective_at_ms}` |

### Panics (new)

`Only a watchdog can do this`, `This watchdog can't confirm yet`, `Only the owner or a watchdog can do this`,
`Kid is already active`, `Kid already has a pending change`, `Too many pending key changes`, `No such key`, `Cannot
remove the last key of an issuer`, `No such key change`, `Key change is still delayed`, `Paused`, `Too many
watchdogs`, `Already a watchdog`, `Not a watchdog`, `Too many updater keys`, `No pending upgrade`, `Upgrade is still
delayed`, `Code doesn't match the proposed hash`, `Not the proposed owner`, `Owner change is still delayed`,
`issuer_key_delay_ms must be at most 7 days`, `governance_delay_ms must be at most 30 days`, `Unexpected state
version`. Governance methods use `Only the owner can do this` as today.

## Delay length (`issuer_key_delay_ms`)

Two constraints. Let **L** = Google's lead time for a kid (first seen in the JWKS → first token signed with it),
**L_min** its smallest observed value; **P** = the updater's poll interval; **T** = time to land a transaction (≤ 1
min); **W** = the watchdog's poll interval; **M** = margin.

- **Availability without the watchdog** (watchdog down during a rotation): the key must be active before Google
  signs with it: `P + T + D + M ≤ L_min`, so **`D ≤ L_min − P − T − M`**, with `M = max(1 h, L_min / 4)`.
- **Security**: the watchdog must get several chances to cancel: **`D ≥ 3·(W + T)`** (two missed runs still cancel).

With the watchdog up, new keys are confirmed within ~`P + W` of publication whatever D is; D only bounds the
watchdog-down case.

The lead-time measurement now being built (`feat/jwks-lead-time`) must record per kid: first time seen in the JWKS,
first time a token with that kid reached `/v1/login` or `/v1/sessions` (the API already parses every token), last
time seen in the JWKS, and the JWKS `Cache-Control: max-age`. Expected (assumption, to confirm): Google publishes a
key at least one `max-age` before signing with it, or verifiers caching the JWKS by `max-age` would reject its
tokens; the API caps that cache at 6 h (`apps/api/src/jwks.ts` `MAX_TTL_MS`).

**Provisional values**, to replace once L_min is measured over at least two Google rotations:

| | `issuer_key_delay_ms` | `governance_delay_ms` | P (updater) | W (watchdog) |
|---|---|---|---|---|
| sandbox-dev | 120 000 (2 min) | 60 000 (1 min) | 15 min | 5 min |
| mainnet | **7 200 000 (2 h)**, valid if L_min ≥ ~4 h; if L_min turns out shorter, D = max(3·(W+T), L_min − P − T − M) and accept that a watchdog outage during a rotation delays new-kid logins | **259 200 000 (72 h)** | 15 min | 5 min |

The 2 h default satisfies the security bound (3·(5 + 1) min = 18 min) with a wide margin and the availability bound
for any L_min ≥ 2 h 16 min + 1 h. The API's cron moves from hourly to every 15 min for the JWKS part (the vault
re-wrap stays hourly, gated on the minute).

## Rotation and logins

1. Google publishes kid K2 while signing with K1. Within P the API cron calls `set_issuer_key(K2)`.
2. Within W the watchdog sees the pending K2, checks it against its own JWKS fetch and calls
   `confirm_issuer_key_change`: K2 is active, typically < 20 min after publication. If the watchdog is down, the API
   cron executes K2 once due (`execute_issuer_key_change`; anyone may).
3. A token signed with K2 before K2 is active fails on chain with `Unknown signing key`. The API prechecks: it reads
   `get_issuer` (cached 60 s, refetched on an unknown kid) and refuses a token whose kid isn't active on chain with
   `503 issuer_key_pending` + `Retry-After` instead of relaying a transaction that would fail. The vault retries the
   login once after `Retry-After` (≤ 60 s), else shows the existing "try again" error.
4. Google stops publishing K1. After 55 min missing (unchanged `REMOVE_AFTER_MISSING_MS`) the cron calls
   `propose_issuer_key_removal(K1)`; the watchdog confirms it once K1 is absent from its own fetch, or it executes
   after D. Tokens signed with K1 expire ≤ 1 h after issue, so a delayed removal costs nothing.
5. The last key of an issuer can't be removed by the updater, so a stuck sync never empties the registry.

## Watchdog service

New package `apps/watchdog`: a Cloudflare Worker on a **separate Cloudflare account** (different login and MFA from
the API's account; open question 3), cron every 5 min, its own D1 or KV for state. Secrets: `WATCHDOG_KEY`, a
function-call key on the watchdog account, receiver the signer, methods `cancel_issuer_key_change`,
`confirm_issuer_key_change`, `pause`, `delete_updater_key`, allowance 1 NEAR. The watchdog account's full-access key
stays with the operator (`~/.near-credentials`, like the other accounts). It reads the chain through its own RPC
setting (manifest `rpc` and `rpcFallback`), never through the API. Each run:

1. Fetch `https://www.googleapis.com/oauth2/v3/certs` directly (`cache: no-store`), keep RS256 keys
   (`usableJwks`, shared from `packages/` rather than imported from `apps/api`). Record each kid's first-seen time.
2. Read `get_key_changes`, `get_issuer` for each provider it watches (Google only), `get_config`, `get_governance`.
3. Pending `Add`:
   - kid in the JWKS with equal `n`, `e` (after stripping leading zeros) → `confirm_issuer_key_change`.
   - kid in the JWKS with different `n`/`e`, or kid absent from two fetches ≥ 60 s apart → `cancel_issuer_key_change`,
     then `delete_updater_key` for every updater key if `by` is the signer account, then a P1 alert.
4. Pending `Remove`: kid absent from the JWKS → confirm; present → cancel + P1 alert.
5. Active kid that the watchdog has never seen in Google's JWKS (activated by delay while the watchdog was down, or
   by an upgrade) → `pause` + P1 alert. Active kid missing from the JWKS for > 3 h → P2 alert (the updater should have
   proposed its removal).
6. Diff `get_config` / `get_governance` against the last run: any `pending_upgrade`, `pending_owner`, watchdog or
   updater-key change, delay change, `paused` → P1 alert with the values.
7. Ping an external dead-man's switch (a heartbeat URL on a third provider); a missing heartbeat alerts by itself.

Providers other than Google: the watchdog only alerts on them (no cancel or confirm) until it knows their JWKS URL.

## Alerts

- **Who sends**: the watchdog service, so a compromised API Worker or API Cloudflare account can't suppress them.
  The heartbeat service covers a dead watchdog.
- **Who receives**: Hana operators (the user and the council members). Two channels so one outage doesn't hide an
  alert: email (provider TBD, the same choice as D34's notice channel) and a second push channel (open question 15).
- **P1** (act now): a pending key Google doesn't publish or with other key material; a forged-proposal response
  taken (cancel, updater key deleted); an active kid never seen in the JWKS (pause taken); any upgrade, owner,
  watchdog, updater-key or delay change; pause.
- **P2**: watchdog RPC or JWKS fetch failing for 3 runs; a matured key change nobody executed for > 1 h; a stale active
  kid.
- **Public notice** of an upgrade or owner change: the on-chain event is authoritative. Additionally an email to
  every scope owner with a NEAR or console identity (batch C notice channel, D34), and a public page listing pending
  upgrades with the code hash, source commit, reproducible-build command and diff to the last release (open question
  11). Partners and users then have `governance_delay_ms` to react, e.g. export keys (D41).

## Owner = multisig

### Options on NEAR

| Option | What it is | For | Against |
|---|---|---|---|
| **Sputnik DAO v2** (factory `sputnikv2.testnet` / `sputnik-dao.near`; to verify before use) | DAO contract per account: roles, per-kind vote policies, proposals with `FunctionCall` actions, voting period | The NEAR ecosystem's standard multisig and treasury contract, in use for years; treasury UIs on top of it (Trezu/NEAR Treasury); members are accounts, so each can use a Ledger through any wallet; every proposal and vote is a public on-chain record (notice for free); per-kind thresholds (e.g. 3-of-3 for policy changes) | Larger surface than a bare multisig (bonds, roles, self-upgrade through its own proposals); proposals carry a bond (~0.1–1 NEAR, refunded) and expire after the voting period; account name is `<name>.sputnikv2.testnet` / `<name>.sputnik-dao.near` |
| **near/core-contracts `multisig2`** | K-of-N contract deployed on the owner account itself; members are keys or accounts; requests with Transfer, FunctionCall, AddKey, DeployContract, member and threshold actions | Small and simple; can be deployed on the **existing** owner account (no `owner` change); 15-min request cooldown and 12 active requests per member limit griefing | README disclaims any guarantee and names no audit; no maintained UI, members confirm with raw CLI calls; the core-contracts repo sees little maintenance; requests don't expire |
| Plain account with several full-access keys | — | — | Not a multisig: each key acts alone |
| A custom multisig in this repo | — | Exactly our needs | More audited code to own; no tooling |

### Recommendation: Sputnik DAO v2, council 2-of-3

- **Security**: the most-used and longest-running multisig code on NEAR; threshold and per-kind policy on chain;
  members on hardware wallets. Set the policy so only the council may propose (removes the anyone-proposes bond
  spam), `FunctionCall` proposals need 2 of 3, and `ChangePolicy`, `UpgradeSelf`, `UpgradeRemote`, `AddMember`,
  `RemoveMember` need 3 of 3. The DAO's own code is never upgraded except by a 3-of-3 proposal.
- **Tooling**: proposals and votes through a web UI with Ledger, plus scripts (`add_proposal`, `act_proposal`) for
  `deploy-contract`/`admin`.
- **Cost**: DAO creation ~5–6 NEAR of storage (verify on testnet), refundable proposal bonds, gas per vote. Negligible
  next to the risk.
- Exact threshold encoding (`Ratio [1, 2]` on 3 members should mean 2 votes) is tested in sandbox before use.

### How owner actions work through it

Each owner call (`set_sponsors`, `set_console_audiences`, `set_shared_clients`, `set_change_delay_ms`, the two new
delays, `set_issuer`, `admin_register_scope`, `remove_issuer_key`, watchdog and updater-key methods, `unpause`,
`propose_upgrade`, `cancel_upgrade`, `propose_owner`) becomes a DAO `FunctionCall` proposal to the signer (method,
JSON args, 0 deposit, gas). It executes when the second vote lands. Contract-side checks are unchanged
(`predecessor == owner`, the DAO account).

Scripts: `scripts/lib/owner-tx.ts` with two backends chosen by manifest `ownerKind: "account" | "sputnik"`.
`account` signs directly (local envs, tests). `sputnik` creates the proposal signed by one council member's key
(`--member <account>`), prints the proposal id and its description (method, args, the plan line), and `admin
owner:vote <id>` / `admin owner:proposals` list and vote. `deploy-contract` prints owner steps as proposals to create
and, on a re-run, sees what executed. `post-google-keys --as-owner` is removed (the owner can't post faster than the
updater anyway); `post-google-keys` keeps the updater path and gains `--execute` for matured changes.

## The API's keys

- **Relayer pools** (`RELAYER_KEYS`, `OWNER_RELAYER_KEYS`) are function-call keys on the **relayer** account, not the
  signer. Nothing changes for them: the relayer's full-access key stays with the operator, and the session and owner
  method lists are unchanged. The sandbox allowlist test (`ALL_CHANGE_METHODS` in
  `contracts/integration-tests/tests/common/mod.rs`) gains every new method, so a pool key is proven unable to call
  them.
- **`KEYS_UPDATER_KEY`** keeps a function-call key on the signer, now installed by `add_updater_key` with methods
  `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`. Access-key permissions can't be
  edited, so the old key (with `remove_issuer_key`) is deleted and a new one added (migration plan). The API sync
  becomes: propose adds and due removals, execute matured changes, never call `remove_issuer_key`.

### What a stolen updater key can still do (bounded)

| Action | Bound |
|---|---|
| Propose a forged key | Delayed D (2 h); the watchdog cancels it within W and deletes the updater key; P1 alert. Forges only if every watchdog is down for D and the active-kid check (step 5) then pauses at the next watchdog run |
| Spam proposals | ≤ 6 pending changes in total; each call costs gas from the key's 1 NEAR allowance (from the signer's balance); the first forged proposal gets the key deleted |
| Fill the queue so Google's next key can't be proposed | Same: the key is deleted at the first forged entry, the owner cancels the rest (or the watchdog does) |
| Propose removing Google's live keys | Delayed; the watchdog cancels removals of kids still published; can't remove the last key |
| Execute matured changes early | Not possible: execution checks `executable_at_ms`; executing on time is open to anyone anyway |
| Cancel, confirm, pause, upgrade, config, add keys | Not in its method list, and the contract refuses "self" for them |
| Burn signer balance | ≤ its allowance (1 NEAR) |

## Signer account full-access key

- **sandbox-dev**: deleted as the last migration step, after an upgrade has gone through the DAO path (open question
  9 asks whether to keep it on sandbox-dev for speed; this spec says delete it, for parity).
- **mainnet**: never left in place. The signer account's first transaction (signed by its creation key) is one batch:
  `DeployContract`, `new(owner = DAO, …, watchdogs)`, `AddKey(updater, function-call)`, `DeleteKey(creation key)`.
  It's atomic, so there is never a moment with code and a full-access key. (The `add_updater_key` path is for later
  rotations; at creation the batch adds the first key with the exact permission the contract would use.)
- `deploy-plan.ts` gets a blocker: on an env with `ownerKind: "sputnik"`, any full-access key on the signer, or any key
  that isn't in `get_governance().updater_keys` with exactly `UPDATER_METHODS`, stops the plan.
- With no full-access key, `deploy-contract --upgrade` no longer works on that env; `scripts/upgrade-contract.ts
  <env> propose|execute` replaces it (propose = a DAO proposal of `propose_upgrade(hash of the built wasm)`; execute =
  any funded account sends the wasm to `execute_upgrade`).
- Surplus NEAR on the signer can't be withdrawn without a method for it (open question 10).

## What each party can do after this batch

Replaces the matching rows of `security.md` "What a compromise gives" (D = `issuer_key_delay_ms`, G =
`governance_delay_ms`).

| Compromised | Effect | Limits |
|---|---|---|
| Owner multisig (2 of 3 council keys) | After G: any upgrade (anything, including forging tokens), owner transfer. At once: config (sponsors, console audiences, shared clients after `change_delay_ms`, delays: increases), pause/unpause, remove issuer keys (DoS), remove watchdogs, add or delete updater keys | Can't install a key or code faster than G: key posts wait D and honest watchdogs cancel; removing the watchdogs pushes every key change to ≥ G; upgrades and owner transfers wait G with a public event, watched and alerted by the watchdog. Users and partners get G to react (export keys, D41) |
| One council key | Propose and vote once | Nothing executes without a second key; policy changes need all three |
| Signer account | No full-access key exists. Its only keys are updater keys (row below) | Code changes only through `execute_upgrade` with the owner-proposed hash after G |
| `KEYS_UPDATER_KEY` | Propose keys and removals (delayed D), execute matured ones | See [the table above](#what-a-stolen-updater-key-can-still-do-bounded). Forging needs every watchdog down for D, and the next watchdog run pauses |
| One watchdog key | DoS: cancel every key change (Google's next key never activates → logins with it fail), pause, delete updater keys. Confirm early only a change that someone (updater or owner) proposed | Can't post a key. The owner removes it at once and unpauses; another watchdog keeps confirming Google's keys. Forging needs the updater key **and** a confirm-capable watchdog |
| API Worker code, its secrets, or the API's Cloudflare account | The updater key (above); D1 and `VAULT_KEK` rows unchanged; **and still the vault and auth bundles**, so every key of every user who loads the vault while it is compromised | This batch removes the *contract-level* path (forging tokens for any `sub` without the user). The page-serving trust root is unchanged (`security.md` "API Worker code or all Worker secrets"); bounding it is a separate issue |
| Watchdog service's Cloudflare account | One watchdog key (above) and its alert sending | Its silence is caught by the dead-man's switch |
| Owner + one watchdog with confirm power | Install a key at once (owner proposes, watchdog confirms) | Two independent compromises; k-of-n confirmation later raises it |

## Migration plan

### sandbox-dev (testnet, in place, no address change)

1. Merge the contract, API, watchdog and script changes; `cargo test`, sandbox e2e and `pnpm -r test` pass.
2. Create the watchdog account (`hana-id-watchdog-dev1.testnet`, manifest `watchdogs`) and a testnet DAO with a
   3-member council (testnet accounts the user holds; manifest `owner` stays the old account until step 6).
3. `deploy-contract sandbox-dev --upgrade` (signer full-access key still present): `DeployContract` +
   `migrate_v1(issuer_key_delay_ms = 120000, governance_delay_ms = 60000)` in one transaction. Check every scope,
   session and issuer key survived (`get_scope("global")`, `get_issuer("google")`, a live session) and that an
   existing smoke wallet derives the same addresses.
4. Owner (old account): `add_updater_key(new key)`; the API's `KEYS_UPDATER_KEY` is switched to it; the old updater
   key (with `remove_issuer_key`) is deleted with the signer's full-access key. `add_watchdog(watchdog)`; deploy
   `apps/watchdog` to the separate Cloudflare account with `WATCHDOG_KEY`.
5. Run a forced rotation drill: post a test kid with the updater (watchdog must cancel within W and delete the
   updater key; re-add the updater key), then let a real Google kid flow through propose → confirm.
6. `propose_owner(DAO)`; after G, a DAO proposal `accept_owner`. Manifest `owner` = the DAO, `ownerKind:
   "sputnik"`.
7. A DAO `propose_upgrade(hash)` of the same code rebuilt with a no-op version bump; after G, `upgrade-contract
   execute`. Check `view_account.code_hash`.
8. Delete the signer's full-access key. `deploy-contract sandbox-dev` must show no blockers.

### Mainnet (at the address freeze; documented now, run by the user only, never by agents)

1. Create the DAO (council on Ledgers, policy as above) and the watchdog account(s) first; deploy the watchdog
   service and alerting; verify the heartbeat.
2. Build reproducibly (`cargo near build reproducible-wasm`), record the hash.
3. Create the signer account and send the one-batch transaction (Deploy, `new(owner = DAO, change_delay_ms,
   issuer_key_delay_ms = provisional 2 h, governance_delay_ms = provisional 72 h, watchdogs)`, AddKey updater,
   DeleteKey creation key).
4. Owner proposals for config (issuer, sponsors, console audiences, shared clients, global scope). The first Google
   keys go through the normal path (watchdog confirms).
5. `deploy-plan` on the mainnet manifest must show no blockers before any partner goes live.

## Tests

### Contract unit (`contracts/hana-signer/src/tests.rs`)

- `set_issuer_key` by owner and by self queues; the kid isn't in `get_issuer` and a token with it fails `Unknown
  signing key` until executed; `execute_issuer_key_change` before `executable_at_ms` panics, at it succeeds;
  `issuer_key_proposed` and `issuer_key_set` event JSON exact.
- Others can't propose (`Only the owner or the contract account`); self can't call any governance method.
- `Kid is already active`, `Kid already has a pending change`, `Too many pending key changes` (7th), `Too many keys`
  counting pending adds; all existing validation panics still fire on propose.
- Removal: proposal, `Cannot remove the last key of an issuer` (at propose and at execute after another removal),
  `No such key`; owner `remove_issuer_key` immediate, may remove the last key, drops a pending change for that kid;
  self calling `remove_issuer_key` panics.
- Confirm: watchdog with `confirm_from_ms ≤ now` executes at once; a newly added watchdog panics `This watchdog can't
  confirm yet` until `now + G` but can cancel and pause at once; owner can't confirm.
- Cancel by owner and by watchdog; by others panics.
- Watchdog removal sets `keys_slow_until_ms`, raises pending `executable_at_ms` to ≥ `now + G`, and new proposals
  wait until then; with no watchdogs new proposals wait G.
- Delays: increases at once, decreases after G (issuer key) / current G (governance); bounds.
- Pause: every token path, `derive_key`, `execute_change`, `execute_issuer_key_change` panic `Paused`;
  `revoke_session`, `prune_sessions`, NEAR-auth owner actions, cancels and governance methods work; only the owner
  unpauses; watchdog and owner pause.
- Upgrade: `propose_upgrade` owner-only; `execute_upgrade` before G panics; wrong code panics `Code doesn't match`;
  replacing a proposal emits `upgrade_cancelled`; works while paused.
- Owner transfer: `propose_owner` → `accept_owner` before G panics, by another account panics, after G switches
  owner; `set_owner` no longer exists.
- Updater keys: `add_updater_key` cap; `delete_updater_key` by owner and watchdog; the promise's permission is exactly
  `UPDATER_METHODS`, receiver self, allowance 1 NEAR (assert on the created promise actions in the mocked env).

### Sandbox e2e (`contracts/integration-tests`)

- `migrate_v1` on a deployment with real v1 state (scopes, shared clients, sessions, issuer keys) built by the v1
  wasm (pinned from `develop` at merge time); every view equal before and after; a session opened before the
  upgrade still derives with the same path.
- `execute_upgrade` with raw wasm input: deploys, runs `migrate`, `code_hash` matches; a `migrate` that panics
  leaves the old code in place; wrong hash refused; gas measured and recorded.
- Mainnet-style creation batch (Deploy + new + AddKey + DeleteKey signed by the deleted key) leaves exactly one
  function-call key.
- `add_updater_key` adds a key that can call exactly the three methods (the access-key matrix over
  `ALL_CHANGE_METHODS`, extended with every new method) and nothing else; relayer pool keys can call none of the new
  methods.
- Full DAO flow with the Sputnik v2 wasm (imported from testnet with `near-workspaces` `import_contract`, or vendored
  with a pinned hash): create DAO, `propose_owner` → DAO `accept_owner`, DAO `propose_upgrade` → `execute_upgrade`,
  a 1-of-3 vote doesn't execute, 2-of-3 does.
- Login gas unchanged: `create_session` and `create_session_and_derive` burn within 2% of the batch B values.
- Rotation end to end: updater proposes, watchdog key confirms, a token with the new kid opens a session; a forged
  proposal is cancelled and the updater key deleted.

### API (`apps/api`, vitest)

- Sync proposes new kids, proposes removals after 55 min missing, executes matured changes, never calls
  `remove_issuer_key`, skips kids already pending; failure codes as today.
- `/v1/login` and `/v1/sessions` return `503 issuer_key_pending` with `Retry-After` for a token whose kid is in
  Google's JWKS but not active on chain; no relay happens.
- Cron schedule: JWKS every 15 min, vault re-wrap still hourly.

### Watchdog (`apps/watchdog`, vitest with a stub RPC and JWKS)

- Each rule in [Watchdog service](#watchdog-service) steps 3–7: confirm on match, cancel + delete updater + P1 on
  mismatch or absence (two fetches), removals, pause on a never-seen active kid, governance diffs alert, heartbeat
  sent, no action on providers it doesn't know, no secret in any log line.

### Scripts

- `deploy-plan`: blocker on a full-access key on the signer for `ownerKind: "sputnik"`; blocker on an untracked
  signer key; owner steps rendered as proposals; mainnet-style plan refuses (testnet-only guard stays).
- `owner-tx` both backends; `upgrade-contract` propose/execute against the stub RPC.

## Build order

1. Contract: state, migrate_v1 with the v1 fixture, key changes, watchdogs, pause, upgrades, owner transfer, unit
   tests. Sandbox: migrate and upgrade tests first (they decide whether the in-place path works at all).
2. Sputnik DAO in sandbox: threshold and policy encoding test; then `owner-tx` and `upgrade-contract` scripts,
   `deploy-plan` changes.
3. API sync and the `issuer_key_pending` precheck.
4. `apps/watchdog` and alerting (blocked on the email provider for email; the push channel and heartbeat first).
5. Lead-time numbers in → set the mainnet D (and confirm G) in `decisions.md`.
6. sandbox-dev migration (plan above), rotation drill, upgrade drill, full-access key deletion.
7. Reference docs updated in the same branches; `security.md` open issue (e) marked fixed.

## Open questions for the user

1. **Delays.** Mainnet `issuer_key_delay_ms` provisional 2 h (to be set by the formula once L_min is measured) and
   `governance_delay_ms` 72 h (upgrades, owner transfer, watchdog confirm power). Is 72 h right, given that a paused
   contract waits up to G for a fix?
2. **Multisig.** Sputnik DAO v2 with a 2-of-3 council (3-of-3 for policy and member changes), or `multisig2` on the
   existing owner account? Who are the three council members, and do all use Ledgers?
3. **Watchdog hosting.** A second Cloudflare account (proposed), or an external host (VPS, another cloud)? One
   watchdog at launch or two on different providers (two makes a rogue or dead watchdog a non-event)?
4. **Watchdog automatic actions.** May it delete the updater key and pause on its own (proposed yes), or only alert
   and wait for a human?
5. **Early activation by one watchdog** (1-of-n) now, k-of-n independent confirmers later (D33's "later,
   optionally")?
6. **Watchdog removal slows key changes to G** (so the owner can't silence the watchdogs and post a key in D):
   accept that after removing a rogue watchdog, Google's next key waits up to G unless another watchdog confirms it?
7. **Pause scope.** Also stop `execute_change` and every token-authenticated owner action (proposed), or only
   derivation?
8. **Upgrade veto.** Should an independent guardian (a watchdog, or an outside party such as the auditor) be able to
   cancel a pending upgrade? Not in this draft.
9. **sandbox-dev's signer full-access key.** Delete it (proposed, parity with mainnet; every dev upgrade then takes
   a DAO vote and G = 60 s) or keep it there?
10. **Signer surplus.** Add an owner method to withdraw NEAR above storage plus a reserve, or leave surplus locked?
11. **Public notice.** Partner email plus a public "pending upgrades" page with code hash and source commit:
    enough? Where does the page live?
12. **Owner-posted keys** use the same D as the updater (proposed), or G?
13. **Console audiences.** `set_console_audiences` is immediate today, and a console audience's tokens authorize
    OIDC owner actions. Timelock additions by `change_delay_ms` in this batch?
14. **Reproducible builds** required for every mainnet `propose_upgrade` (proposed), with the hash published before
    the proposal?
15. **Alert channels and recipients.** Second channel besides email (Telegram, Slack, PagerDuty-style)? Who is on
    call?
16. **Events version.** `1.1.0` with `issuer_key_set` moved to execution time (proposed), or a new name and `2.0.0`?
