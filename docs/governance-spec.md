# Governance spec: delayed issuer keys, watchdog, multisig owner, timelocked upgrades (pre-mainnet)

**Status: built and merged into `develop`; on sandbox-dev since 2026-10-30 (contract v2 migrated in place and owned
by the council DAO, the watchdog deployed and drilled; watchdog redeployed 2026-11-02 with email-login batch 5); not on
mainnet. The user's decisions of 2026-10-29 (D80–D86) are applied below.** Implements `docs/decisions.md` D33
(confirmed 2026-10-28) and closes `docs/security.md` open issue (e) on sandbox-dev. Still open: the mainnet
issuer-key delay (provisional until the lead-time measurement is in), where the backup council key is held, the
paging app, and open question 17. The current state is in the reference docs (`docs/README.md`).

This file is the source of truth for the batch once approved. If code and this spec disagree, fix the code or raise
the problem. Reference docs (`contract-interface.md`, `security.md`, `operations.md`, `architecture.md`, `api.md`)
are updated in the same branch as the code, not now.

## Confirmed by the user (2026-10-29)

- **Delays (D80).** Mainnet `issuer_key_delay_ms` 2 h, provisional: set from the lead-time measurement now running
  (`admin issuer-keys:lead-times`). Mainnet `governance_delay_ms` 72 h. sandbox-dev 2 min and 60 s. Fast emergency
  response comes from pause, not short delays.
- **Owner multisig (D81).** Sputnik DAO v2, 2-of-3 for **every** proposal kind (no 3-of-3: a lost Ledger would freeze
  the council; the 72 h delay already guards owner actions). Mainnet council: the two founders (Ledgers) and one
  offline backup key neither founder can reach alone (a third party such as the company's lawyer or accountant under
  written instructions, or a dual-control safe deposit box; where is decided before mainnet); an independent member
  replaces the backup later. sandbox-dev: Sputnik 2-of-3 with three throwaway testnet accounts, keys in
  `.secrets/sandbox-dev/`, driven by scripts (propose and approve in one command), plus `near-workspaces` sandbox tests
  of the full flow.
- **Watchdog autonomy (D82).** Auto-cancel any pending key Google doesn't publish; auto-delete the updater key when it
  proposes one; auto-pause **only** when a key Google doesn't publish is active on chain; everything else alert-only.
  The owner multisig unpauses at once (no governance delay).
- **Monitoring in the admin portal (D83).** A "Security & monitoring" view ([below](#monitoring-in-the-admin-portal)),
  and a standing rule: every future watchdog check or alert must surface in the admin portal. The watchdog still sends
  its alerts itself, so a compromised Hana Cloudflare account can't silence it; the portal reads the watchdog's status
  and on-chain events.
- **No upgrade guardian at launch (D84).** Revisit when an independent party (auditor, partner) exists; the watchdog
  alerts on every upgrade proposal.
- **Alerts (D85).** Critical: phone paging app (PagerDuty, Pushover or ntfy, chosen at setup) + Slack + email, to both
  founders, re-sent every 15 min until acknowledged, acks recorded in the portal. Warning: Slack + email. Info: portal
  + daily digest.
- **Defaults (D86)**, the spec's proposals: a separate Cloudflare account and one watchdog at launch; single-watchdog
  early activation now, k-of-n later; the watchdog-removal slowdown accepted; pause blocks derivation and new sessions
  (every token path and the executors), never governance; sandbox-dev keeps the signer's full-access key, staging and
  mainnet never have one; an owner-only timelocked withdrawal of surplus NEAR; public notice = partner email + a
  pending-upgrades page in the admin and partner consoles; owner-posted keys use the updater's delay;
  `set_console_audiences` additions timelocked; reproducible builds for mainnet upgrades; events `1.1.0`, additive.

## Amends

| Document | Amendment |
|---|---|
| `contract-interface.md` "Issuers" | `set_issuer_key` queues a pending key instead of installing it; `remove_issuer_key` is owner-only; new pending-change, watchdog, pause, upgrade and owner-transfer methods (below). |
| `contract-interface.md` "Config" | `set_owner` is replaced by `propose_owner` / `accept_owner` (delayed). New delays `issuer_key_delay_ms`, `governance_delay_ms`. `set_console_audiences` additions wait `change_delay_ms`. New surplus withdrawal. |
| `contract-interface.md` "Events" | New events; `issuer_key_set` now means "a key entered the active set" (emitted at execution, not at posting). Events version `1.0.0` → `1.1.0`. |
| `security.md` "What a compromise gives", "Parties", key inventory, open issue (e) | Replaced by [What each party can do after this batch](#what-each-party-can-do-after-this-batch). |
| `decisions.md` D33 | Delay formula and provisional values, the watchdog's exact powers, the multisig choice. D33's status moves to "in force" when merged. |
| `operations.md` key rotation, deploy, upgrade | Upgrades through the owner multisig; no signer full-access key (except sandbox-dev, D86); watchdog service; alert runbook. |
| `batch-c-spec.md` "Hana admin console", console screens | The "Security & monitoring" view and the pending-upgrades page (D83, D86), built in this batch on batch C's admin and console Workers. |
| `apps/api` JWKS cron | Proposes keys and removals, executes matured ones; runs every 15 min. |

## Goal

After this batch no single hot key and no single service can install a Google signing key or replace the contract
faster than a public, cancellable delay:

- A newly posted issuer key becomes usable only after `issuer_key_delay_ms`, during which an independent watchdog
  (own NEAR account and key, own service, not on the API's Cloudflare account) cancels it if Google doesn't publish
  it. The watchdog may activate a key early when it matches Google's JWKS.
- Every pending key for a kid Google doesn't publish raises an alert from the watchdog itself.
- The contract owner is a Sputnik DAO v2 council, 2 of 3 for every proposal kind (D81).
- Outside sandbox-dev the signer account has no full-access key (D86). Code changes only through `propose_upgrade`
  (owner) → public notice → `execute_upgrade` after `governance_delay_ms`.
- An emergency pause stops derivation and every token check; it can't post keys or change code. Only the owner
  unpauses, at once (D82).
- Every watchdog check, action and alert shows in the admin portal (D83).

Done when every behaviour under [Tests](#tests) has a passing test, sandbox-dev runs the new contract migrated in
place (same signer account, same addresses), its owner is a testnet DAO driven by the scripts, one upgrade has gone
through the full propose → wait → execute path, the admin portal's "Security & monitoring" view shows the drills
below, and `deploy-plan` refuses a signer full-access key on every manifest except sandbox-dev's.

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
| **owner** | Sputnik DAO v2 account, `envs/<env>.json` `owner` | mainnet: the two founders' Ledgers and the offline backup key; sandbox-dev: three throwaway accounts, keys in `.secrets/sandbox-dev/` (D81) | config, `set_issuer_key` (delayed like the updater's), `remove_issuer_key`, watchdog set, updater keys, unpause, upgrades, owner transfer, surplus withdrawal |
| **watchdog** | 1..=3 accounts, manifest `watchdogs` | watchdog service: a function-call key on its own account (receiver signer) | cancel and confirm pending key changes, pause, delete an updater key |
| **updater** ("self") | the signer account | API Worker `KEYS_UPDATER_KEY`, a function-call key the contract installs | `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change` |
| **anyone** | — | — | `execute_issuer_key_change`, `execute_upgrade` and `execute_withdrawal` once due; views |

Outside sandbox-dev the signer account has no full-access key; its only access keys are updater keys the contract
added itself. sandbox-dev keeps its full-access key for fast dev upgrades (D86).

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
    pub(crate) pending_withdrawal: Option<PendingWithdrawal>,   // D86
    pub(crate) pending_console_audiences: Vec<PendingSharedClient>,  // additions, due after change_delay_ms (D86)
}

pub struct Watchdog { pub account_id: AccountId, pub confirm_from_ms: u64 }  // may confirm from then on
pub enum KeyOp { Add { n: Vec<u8>, e: Vec<u8> }, Remove }
pub struct PendingKeyChange {
    pub id: u64, pub provider: String, pub kid: String, pub op: KeyOp,
    pub by: AccountId, pub proposed_at_ms: u64, pub executable_at_ms: u64,
}
pub struct PendingUpgrade { pub code_hash: Base58CryptoHash, pub executable_at_ms: u64, pub proposed_at_ms: u64 }
pub struct PendingOwner { pub owner: AccountId, pub acceptable_at_ms: u64 }
pub struct PendingWithdrawal { pub receiver: AccountId, pub amount: NearToken, pub executable_at_ms: u64 }
```

Constants: `MAX_ISSUER_KEY_DELAY_MS = 7 days`, `MAX_GOVERNANCE_DELAY_MS = 30 days`, `MAX_UPDATER_ALLOWANCE = 1 NEAR`,
`UPDATER_METHODS = "set_issuer_key,propose_issuer_key_removal,execute_issuer_key_change"`, `SIGNER_RESERVE = 5 NEAR`
(provisional). Storage: a pending `Add`
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

where `no_watchdog` = no watchdog may confirm yet (`watchdogs` has none with `confirm_from_ms ≤ now`). *Amended in
review (2026-10-29):* the draft had "`watchdogs` is empty", under which a compromised owner adding its own fresh
watchdog to an empty list shortened new key changes to `issuer_key_delay_ms` at once, although that watchdog can't
confirm (or be trusted) for `governance_delay_ms`. Counting only watchdogs that may confirm keeps the rule stateless
(the alternative, raising `keys_slow_until_ms` in `add_watchdog` on an empty list, needs one more special case and
misses a list whose only watchdogs are all new). The owner's posts use the same rule as the updater's (D86). Event
`issuer_key_proposed {id, provider, kid, n, e, executable_at_ms, by}` (`n`, `e` base64url, so monitors can compare with
the JWKS without a view). Returns the id. Gas: ~3 Tgas burnt; the API attaches 30 Tgas as today.

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
This is the early activation, by one watchdog; k-of-n confirmation is later (D86).

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
  so `deploy-contract` compares it with `view_access_key_list` and blocks on any other key. *Built (review
  follow-up):* a requested key waits in `pending_updater_keys` until the `AddKey` callback confirms success, and only
  then joins `updater_keys`; a failed `AddKey` drops it. A watchdog deletes only confirmed keys, so in the window before
  the callback it can never delete a key that was already on the account with another permission (e.g. a full-access
  key). The cap of 2 counts pending and confirmed keys.

### Pause

- `pause()` — owner or any watchdog. Sets `paused`; event `paused {by}`; no-op if already paused. The watchdog calls
  it only for an active key Google doesn't publish (D82).
- `unpause()` — owner only, immediate: no governance delay (D82). Event `unpaused {}`.
- While paused, `verify_token` panics `Paused` (so `create_session`, `create_session_and_derive`, `register_scope`,
  `propose_change` with a client proof and every `OwnerAuth::Oidc` action stop), `derive_key` panics `Paused`, and
  `execute_change` and `execute_issuer_key_change` panic `Paused` (nothing that may rest on a forged token matures
  into force while frozen). Still allowed: `confirm_issuer_key_change` (a watchdog-checked Google key may go live
  while paused), `revoke_session`, `prune_sessions`, NEAR-account owner actions, cancels,
  every governance method, views. Pause can't post keys, change code or move anything: the worst it does is stop
  logins. This is the scope D86 confirms: derivation and new sessions (every token path) and the two executors stop;
  governance, revocation and cancels don't.
- *Added in review (2026-10-29).* Pausing alone doesn't undo what a forged key did while it was active, so two more
  pieces keep D82's "pause stops derivation" true after the unpause:
  - **Scope changes.** While paused OIDC owners can't cancel (`verify_token` panics), yet pending scope changes keep
    maturing. `unpause()` sets `unpaused_at_ms = now` and `changes_unlock_floor_ms = max(itself, now +
    change_delay_ms)`; `execute_change` needs `now ≥ max(unlock_at_ms, changes_unlock_floor_ms)` (`Change is still
    timelocked`), so a change proposed with forged owner tokens or client proofs before the pause gets a full window
    after it for the honest owners to cancel. `get_scope` shows each pending `unlock_at_ms` raised to the floor. No
    `PendingChange` layout change.
  - **Sessions.** Sessions the forged key opened (for any user's path, up to `MAX_SESSION_MS`, any `max_uses`) would
    derive again after the unpause. `set_sessions_valid_from_ms(ms)` (owner; raise only; ≤ block time; allowed while
    paused) retires every session opened before `ms`: `derive_key` and `revoke_session` panic `No such session`,
    `get_session` returns `null`. New sessions store `created_at_ms` after the v1 fields of `StoredSession` (v1
    records read as before and count as opened at `expires_at_ms − MAX_SESSION_MS`, the earliest possible), so the
    floor retires exactly the older sessions instead of refusing short-lived new ones for up to a day. The runbook
    (`docs/operations.md`, `forged_active_key`): remove the key, raise the floor just past the pause, then unpause.
  - Events: `unpaused {changes_unlock_floor_ms}`, `sessions_valid_from_set {sessions_valid_from_ms}`; `get_config`
    gains `unpaused_at_ms`, `changes_unlock_floor_ms`, `sessions_valid_from_ms`.

### Upgrades

- `propose_upgrade(code_hash: Base58CryptoHash)` — owner. Replaces any pending upgrade (event
  `upgrade_cancelled` for the old one). `executable_at_ms = now + governance_delay_ms`. Event `upgrade_proposed
  {code_hash, executable_at_ms}`. The hash is NEAR's account `code_hash` format (base58 sha256 of the wasm), so
  anyone can compare it with a reproducible build and, after execution, with `view_account`. On mainnet every
  proposal is a reproducible build (`cargo near build reproducible-wasm`) whose hash, source commit and build command
  are published before the proposal (D86); `upgrade-contract` refuses a non-reproducible build on a mainnet manifest.
  No other party can cancel a pending upgrade (no guardian at launch, D84).
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
  anything (no pending withdrawal or console audiences), `paused = false`, `updater_keys = []` (the existing updater
  key is replaced, see migration plan).
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

### Surplus withdrawal (D86)

- `propose_withdrawal(receiver, amount: NearToken)` — owner. Replaces a pending one. `executable_at_ms = now +
  governance_delay_ms`. Event `withdrawal_proposed {receiver, amount, executable_at_ms}`.
- `cancel_withdrawal()` — owner. Event `withdrawal_cancelled {receiver, amount}`.
- `execute_withdrawal()` — anyone, once due (`Withdrawal is still delayed`, `No pending withdrawal`), not while
  paused. Refuses `Withdrawal would leave too little` unless `account_balance − amount ≥ storage_usage ×
  storage_byte_cost + SIGNER_RESERVE`, checked at execution. `Promise::new(receiver).transfer(amount)`; event
  `withdrawal_executed {receiver, amount}`.
- The watchdog alerts (critical) on every proposal. A compromised owner gains only what it already has after G (an
  upgrade could move everything).

### Console audiences (D86)

`set_console_audiences(audiences)` keeps its signature. Removals apply at once; each addition is queued in
`pending_console_audiences` and counts only after `change_delay_ms`, the same mechanism as `set_shared_clients`
(`lib.rs` `pending_shared_clients`, folded in by `apply_matured_config`); the token check (`registry.rs`, `Token is
not for the Hana console`) counts matured ones only. `get_config` shows pending ones. Event `console_audiences_set`.
A console audience's tokens authorise OIDC owner actions, so a new one gets the same public window as a new shared
client.

### `new` (fresh deployments, i.e. mainnet)

`new(owner, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms, governance_delay_ms, watchdogs)`. Same panics
as today plus the delay bounds and `Too many watchdogs`.

### Views

`get_config()` gains `issuer_key_delay_ms`, `pending_issuer_key_delay`, `governance_delay_ms`,
`pending_governance_delay`, `paused`, `pending_console_audiences`. New `get_governance() -> {watchdogs,
keys_slow_until_ms, updater_keys, pending_upgrade, pending_owner, pending_withdrawal, state_version}`. New
`get_issuer_keys(provider) -> [{kid, n, e}] | null` (active keys with their material, for the watchdog's step 5).

### Events

Version `1.1.0` (additive, D86; `issuer_key_set` / `issuer_key_removed` gain fields and move to execution time).

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
| `withdrawal_proposed` / `withdrawal_cancelled` / `withdrawal_executed` | `{receiver, amount, executable_at_ms}` / `{receiver, amount}` / `{receiver, amount}` |
| `console_audiences_set` (new; like `shared_clients_set`) | `{console_audiences, pending_console_audiences}` |

### Panics (new)

`Only a watchdog can do this`, `This watchdog can't confirm yet`, `Only the owner or a watchdog can do this`, `Kid is
already active`, `Kid already has a pending change`, `Too many pending key changes`, `No such key`, `Cannot remove the
last key of an issuer`, `No such key change`, `Key change is still delayed`, `Paused`, `Too many watchdogs`, `Already a
watchdog`, `Not a watchdog`, `Too many updater keys`, `No pending upgrade`, `Upgrade is still delayed`, `Code doesn't
match the proposed hash`, `Not the proposed owner`, `Owner change is still delayed`, `issuer_key_delay_ms must be at
most 7 days`, `governance_delay_ms must be at most 30 days`, `Unexpected state version`, `No pending withdrawal`,
`Withdrawal is still delayed`, `Withdrawal would leave too little`. Governance methods use `Only the owner can do this`
as today.

## Delay length (`issuer_key_delay_ms`)

Two constraints. Let **L** = Google's lead time for a kid (first seen in the JWKS → first token signed with it),
**L_min** its smallest observed value; **P** = the updater's poll interval; **T** = time to land a transaction (≤ 1
min); **W** = the watchdog's poll interval; **M** = margin.

- **Availability without the watchdog** (watchdog down during a rotation): the key must be active before Google
  signs with it: `P + T + D + M ≤ L_min`, so **`D ≤ L_min − P − T − M`**, with `M = max(1 h, L_min / 4)`.
- **Security**: the watchdog must get several chances to cancel: **`D ≥ 3·(W + T)`** (two missed runs still cancel).

With the watchdog up, new keys are confirmed within ~`P + W` of publication whatever D is; D only bounds the
watchdog-down case.

The lead-time measurement now running (`feat/jwks-lead-time`; report: `admin issuer-keys:lead-times`) records per kid:
first time seen in the JWKS, first time a token with that kid reached `/v1/login` or `/v1/sessions` (the API already
parses every token), last time seen in the JWKS, and the JWKS `Cache-Control: max-age`. Expected (assumption, to
confirm): Google publishes a key at least one `max-age` before signing with it, or verifiers caching the JWKS by
`max-age` would reject its tokens; the API caps that cache at 6 h (`apps/api/src/jwks.ts` `MAX_TTL_MS`).

**Values confirmed by the user (D80).** The mainnet issuer-key delay stays provisional and is replaced by the
formula's value once L_min is measured over at least two Google rotations; the rest of the table is set. Fast emergency
response comes from pause, not from short delays, so a paused contract waiting up to 72 h for a fix is accepted.

| | `issuer_key_delay_ms` | `governance_delay_ms` | P (updater) | W (watchdog) |
|---|---|---|---|---|
| sandbox-dev | 120 000 (2 min) | 60 000 (1 min) | 15 min | 5 min |
| mainnet | **7 200 000 (2 h)**, provisional; valid if L_min ≥ ~4 h; if L_min turns out shorter, D = max(3·(W+T), L_min − P − T − M) and accept that a watchdog outage during a rotation delays new-kid logins | **259 200 000 (72 h)** | 15 min | 5 min |

The security bound is enforced outside dev envs by `deploy-contract` (see [Signer account full-access
key](#signer-account-full-access-key)); sandbox-dev's 2 min breaks it on purpose, for drills, and its plans warn.

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
   login once after `Retry-After` (built: capped at 30 s, the API's value; `loginProgress: key_pending` while it
   waits), else shows the existing "try again" error (`api_unavailable`).
4. Google stops publishing K1. After 55 min missing (unchanged `REMOVE_AFTER_MISSING_MS`) the cron calls
   `propose_issuer_key_removal(K1)`; the watchdog confirms it once K1 is absent from its own fetch, or it executes
   after D. Tokens signed with K1 expire ≤ 1 h after issue, so a delayed removal costs nothing.
5. The last key of an issuer can't be removed by the updater, so a stuck sync never empties the registry.

## Watchdog service

New package `apps/watchdog`: a Cloudflare Worker on its **own Cloudflare account** (different login and MFA from
Hana's main account; D86), one watchdog at launch, cron every 5 min, its own D1 for state (seen kids, last snapshot,
actions log, alerts and acks). Secrets: `WATCHDOG_KEY`, a function-call key on the watchdog account, receiver the
signer, methods `cancel_issuer_key_change`, `confirm_issuer_key_change`, `pause`, `delete_updater_key`, allowance 1
NEAR; its own Resend API key (D87), Slack webhook and paging-app token (D85). The watchdog account's full-access key
stays with the operator (`~/.near-credentials`, like the other accounts). It reads the chain through its own RPC
setting (manifest `rpc` and `rpcFallback`), never through the API. Each run:

1. Fetch `https://www.googleapis.com/oauth2/v3/certs` directly (`cache: no-store`), keep RS256 keys
   (`usableJwks`, shared from `packages/` rather than imported from `apps/api`). Record each kid's first-seen time
   and key material.
2. Read `get_key_changes`, `get_issuer` and `get_issuer_keys` for each provider it watches (Google only),
   `get_config`, `get_governance`, and the owner account: `view_account(owner).code_hash` and, for a DAO, its
   `get_policy` (added in review: the council can be reshaped by its own `ChangePolicy` / `AddMember` /
   `RemoveMember` without touching hana-signer). (`get_issuer_keys` was added with the watchdog: without the active keys' material
   the "seen with other key material" case of step 5 can't be checked for a key that went live while the watchdog was
   down or arrived by an upgrade.)
3. Pending `Add`:
   - kid in the JWKS with equal `n`, `e` (after stripping leading zeros) → `confirm_issuer_key_change`.
   - kid in the JWKS with different `n`/`e`, or kid absent from two fetches ≥ 60 s apart (a key Google doesn't
     publish) → `cancel_issuer_key_change`, then `delete_updater_key` for every updater key if `by` is the signer
     account, then a critical alert (D82).
4. Pending `Remove`: kid absent from the JWKS → confirm; present → critical alert only, no cancel (D82: the owner
   decides and cancels).
5. Active kid Google doesn't publish: never seen in Google's JWKS by this watchdog, or seen with other key material
   (activated by delay while the watchdog was down, by an owner post, or by an upgrade) → `pause` + critical alert.
   This is the only automatic pause (D82). A kid Google published and has since dropped is the normal rotation tail,
   not a forgery: missing for > 3 h → warning (the updater should have proposed its removal). On its first run (empty
   D1) the watchdog seeds "seen" from the current JWKS and alerts critical, without pausing, on any active kid not in
   it, so a fresh deploy never pauses on history it can't know.
6. Diff `get_config` / `get_governance` / the owner account against the last run: any change of the owner DAO's
   code or policy, `unpaused_at_ms` (a pause and unpause between two runs), `sessions_valid_from_ms`, any `pending_upgrade` (D84), `pending_owner`,
   `pending_withdrawal`, watchdog or updater-key change, delay change, console-audience change, `paused` or
   unpause → critical alert with the values. Alert only; no action.
7. Ping an external dead-man's switch (a heartbeat URL on a third provider); a missing heartbeat alerts critical by
   itself.
8. Write the run (time, result, each check's outcome, actions taken) to its D1 for the status endpoint.

Providers other than Google: the watchdog only alerts on them (no cancel or confirm) until it knows their JWKS URL.
*Amended in review:* except a change the updater (`by` = the signer account) proposed for one: the updater only
serves Google, so that is cancelled and the updater keys deleted as in step 3. Also added in review: a cancel that
finds the change gone re-reads the chain and raises `protective_action_failed` if it was executed instead; step 6 also
diffs `get_issuer("google")` (iss values, and active kids that vanished without a queued removal), since the owner's
`set_issuer` and `remove_issuer_key` act at once and leave no pending state; on-chain strings in alerts are
allow-listed or escaped (`apps/watchdog/README.md`).

**Status endpoint (for the admin portal, D83).** `GET /status`, `GET /alerts?cursor` and `GET /actions?cursor`
(built: field list in `apps/watchdog/README.md`): last run and its checks,
heartbeat state, seen kids with first-seen times, the actions log, alert history with acks. `POST /alerts/:id/ack
{by}`: records an acknowledgement. Both need a bearer token that only the admin Worker holds (`WATCHDOG_STATUS_TOKEN`
on both sides, from `.secrets/<env>/`). The endpoint can read and ack, nothing else: it can't change a check, stop a
first alert or call the chain. A portal ack stops only the 15-min re-sends of that alert; the watchdog records who
acked and from where (portal or paging app).

## Alerts

- **Who sends**: the watchdog service, so a compromised API Worker or Hana Cloudflare account can't suppress them.
  The heartbeat service covers a dead watchdog.
- **Who receives**: both founders (D85).
- **Severities (D85):**

  | Severity | Channels | Re-send | Raised for |
  |---|---|---|---|
  | critical | phone paging app (PagerDuty, Pushover or ntfy, chosen at setup) + Slack + email | every 15 min until acknowledged (paging app or portal) | a pending key Google doesn't publish or with other key material; every automatic action (cancel, updater keys deleted, pause); a pending removal of a kid Google still publishes; an active kid Google doesn't publish, or not in the JWKS at the first run (step 5); any upgrade proposal (D84), owner, withdrawal, watchdog, updater-key, delay or console-audience change; pause and unpause; a missing heartbeat |
  | warning | Slack + email | — | RPC or JWKS fetch failing for 3 runs; a matured key change nobody executed for > 1 h; a stale active kid (> 3 h missing) |
  | info | admin portal + daily digest email | — | confirmations, executions, routine runs, delay-matured config |

- **Public notice** of an upgrade, owner change or withdrawal (D86): the on-chain event is authoritative.
  Additionally batch C's admin Worker emails every org's security contacts (its one notice channel, D34, through
  Resend, D87), and the admin console and the partner console show a pending-upgrades page: code hash, source commit,
  reproducible-build command, diff to the last release, countdown. Partners and users then have
  `governance_delay_ms` to react, e.g. export keys (D41).
- **Runbook** (`docs/operations.md`, written with the code): what each critical alert means, who unpauses, how to
  cancel through the DAO.

## Monitoring in the admin portal

Built on batch C's admin Worker (D83). The admin Worker reads the watchdog's status endpoint and the chain
(`get_key_changes`, `get_issuer`, `get_config`, `get_governance`, the signer's access-key list, NEP-297 events from
its read-only RPC); it never alerts and never acts on chain. The "Security & monitoring" view shows:

- watchdog heartbeat and last check time, with a warning banner when it has been silent for more than two intervals
  (10 min);
- pending issuer-key changes: provider, kid, add or remove, proposer, countdown to `executable_at_ms`, and whether the
  key matches Google's JWKS (the admin Worker's own fetch beside the watchdog's verdict);
- the watchdog's actions log (cancels, confirms, pauses, updater-key deletions) with transaction links;
- pause state (who paused, when) and the current updater keys against the signer's access-key list;
- pending upgrades, owner transfers, withdrawals, delay decreases and console-audience additions, with countdowns;
- alert history by severity, with acknowledge (posted to the watchdog's ack endpoint, recorded with the Access
  identity).

**Standing rule (D83):** every future watchdog check or alert ships with its view here; a check that doesn't surface
in the admin portal isn't done. The portal is a view: the watchdog's own alerts never depend on it.

## Owner = multisig

### Options on NEAR

| Option | What it is | For | Against |
|---|---|---|---|
| **Sputnik DAO v2** (factory `sputnikv2.testnet` / `sputnik-dao.near`; to verify before use) | DAO contract per account: roles, per-kind vote policies, proposals with `FunctionCall` actions, voting period | The NEAR ecosystem's standard multisig and treasury contract, in use for years; treasury UIs on top of it (Trezu/NEAR Treasury); members are accounts, so each can use a Ledger through any wallet; every proposal and vote is a public on-chain record (notice for free); per-kind thresholds (e.g. 3-of-3 for policy changes) | Larger surface than a bare multisig (bonds, roles, self-upgrade through its own proposals); proposals carry a bond (~0.1–1 NEAR, refunded) and expire after the voting period; account name is `<name>.sputnikv2.testnet` / `<name>.sputnik-dao.near` |
| **near/core-contracts `multisig2`** | K-of-N contract deployed on the owner account itself; members are keys or accounts; requests with Transfer, FunctionCall, AddKey, DeployContract, member and threshold actions | Small and simple; can be deployed on the **existing** owner account (no `owner` change); 15-min request cooldown and 12 active requests per member limit griefing | README disclaims any guarantee and names no audit; no maintained UI, members confirm with raw CLI calls; the core-contracts repo sees little maintenance; requests don't expire |
| Plain account with several full-access keys | — | — | Not a multisig: each key acts alone |
| A custom multisig in this repo | — | Exactly our needs | More audited code to own; no tooling |

### Decision: Sputnik DAO v2, council 2-of-3 for every kind (D81)

- **Security**: the most-used and longest-running multisig code on NEAR; threshold and policy on chain. Policy: only
  the council may propose (removes the anyone-proposes bond spam); **every** proposal kind (`FunctionCall`,
  `ChangePolicy`, `UpgradeSelf`, `UpgradeRemote`, `AddMember`, `RemoveMember`, transfers) needs 2 of 3. No 3-of-3: a
  lost Ledger would freeze the council, and the contract's 72 h governance delay plus the watchdog's critical alerts
  already guard every owner action that matters.
- **Mainnet council**: the two founders, each on a Ledger, and one offline backup key that neither founder can reach
  alone: held by a third party (e.g. the company's lawyer or accountant, under written instructions on when to sign)
  or in a dual-control safe deposit box. Where it is held is decided before mainnet. A founder plus the backup holder
  can act; the 72 h delay and the alerts to the other founder cover that. An independent member replaces the backup
  later (`AddMember` + `RemoveMember`, 2 of 3).
- **sandbox-dev council**: three throwaway testnet accounts (`hana-id-council-{a,b,c}-dev1.testnet` or as the
  manifest names them), keys in `.secrets/sandbox-dev/council-*.json` (0600). Scripts drive them; no Ledger.
- **Tooling**: proposals and votes through a web UI with Ledger, plus scripts (`add_proposal`, `act_proposal`) for
  `deploy-contract`/`admin`.
- **Cost**: DAO creation ~5–6 NEAR of storage (verify on testnet), refundable proposal bonds, gas per vote. Negligible
  next to the risk.
- Exact threshold encoding (`Ratio [1, 2]` on 3 members should mean 2 votes) is tested in sandbox before use.

### How owner actions work through it

Each owner call (`set_sponsors`, `set_console_audiences`, `set_shared_clients`, `set_change_delay_ms`, the two new
delays, `set_issuer`, `admin_register_scope`, `remove_issuer_key`, watchdog and updater-key methods, `unpause`,
`propose_upgrade`, `cancel_upgrade`, `propose_owner`, `propose_withdrawal`, `cancel_withdrawal`) becomes a DAO
`FunctionCall` proposal to the signer (method, JSON args, 0 deposit, gas). It executes when the second vote lands.
Contract-side checks are unchanged (`predecessor == owner`, the DAO account).

Scripts: `scripts/lib/owner-tx.ts` with two backends chosen by manifest `ownerKind: "account" | "sputnik"`. `account`
signs directly (local envs, tests). `sputnik` creates the proposal signed by one council member's key (`--member
<account>`), prints the proposal id and its description (method, args, the plan line), and `admin owner:vote <id>` /
`admin owner:proposals` list and vote. On sandbox-dev, `--approve-with <member>` proposes with one `.secrets` council
key and approves with a second in the same command (D81); the flag is refused on a manifest whose `network` isn't
testnet, and council keys are never read from disk for mainnet (Ledgers only). `deploy-contract` prints owner steps as
proposals to create and, on a re-run, sees what executed. `post-google-keys --as-owner` is removed (the owner can't post
faster than the updater anyway); `post-google-keys` keeps the updater path and gains `--execute` for matured changes.

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
| Propose a forged key | Delayed D (2 h); the watchdog cancels it within W and deletes the updater key; critical alert. Forges only if every watchdog is down for D and the active-kid check (step 5) then pauses at the next watchdog run |
| Spam proposals | ≤ 6 pending changes in total; each call costs gas from the key's 1 NEAR allowance (from the signer's balance); the first forged proposal gets the key deleted |
| Fill the queue so Google's next key can't be proposed | Same: the key is deleted at the first forged entry, the owner cancels the rest (or the watchdog does) |
| Propose removing Google's live keys | Delayed D; the watchdog raises a critical alert (alert-only, D82) and the owner cancels; can't remove the last key. Its first forged *add* gets the key deleted |
| Execute matured changes early | Not possible: execution checks `executable_at_ms`; executing on time is open to anyone anyway |
| Cancel, confirm, pause, upgrade, config, add keys | Not in its method list, and the contract refuses "self" for them |
| Burn signer balance | ≤ its allowance (1 NEAR) |

## Signer account full-access key

- **sandbox-dev**: kept, for speed (D86). Dev upgrades may use `deploy-contract --upgrade` directly; the DAO path is
  still exercised once in the migration plan. Its manifest sets `allowSignerFullAccessKey: true`.
- **Any staging env and mainnet**: never one. The manifest schema refuses `allowSignerFullAccessKey` on a mainnet
  network, and a test asserts that no committed manifest other than sandbox-dev's sets it.
- **mainnet**: never left in place. The signer account's first transaction (signed by its creation key) is one batch:
  `DeployContract`, `new(owner = DAO, …, watchdogs)`, `AddKey(updater, function-call)`, `DeleteKey(creation key)`.
  It's atomic, so there is never a moment with code and a full-access key. (The `add_updater_key` path is for later
  rotations; at creation the batch adds the first key with the exact permission the contract would use.)
- `deploy-plan.ts` blocks (added in review) an owner transfer to, and every run of an env owned by, a DAO whose
  `get_policy` isn't exactly the manifest's council at 2 of 3 for every kind (`sputnik.ts` `policyProblems`: roles,
  members, permissions, vote policies), not only one with other code: staging and mainnet DAOs are created by hand.
  It also blocks, outside dev envs, an `issuerKeyDelayMs` below the security bound 3·(W + T) = 18 min and a
  `governanceDelayMs` below 24 h (mainnet: 72 h, D80), in `buildDeployPlan` and `--creation-plan`
  (`@hana-id/env` `governanceDelayProblems`); dev envs only warn (sandbox-dev's 2 min deliberately violates it, D80).
- `deploy-plan.ts` gets a blocker: on an env with `ownerKind: "sputnik"`, any full-access key on the signer (unless
  `allowSignerFullAccessKey`), or any function-call key that isn't in `get_governance().updater_keys` with exactly
  `UPDATER_METHODS`, stops the plan.
- With no full-access key, `deploy-contract --upgrade` no longer works on that env; `scripts/upgrade-contract.ts
  <env> propose|execute` replaces it (propose = a DAO proposal of `propose_upgrade(hash of the built wasm)`; execute =
  any funded account sends the wasm to `execute_upgrade`).
- Surplus NEAR on the signer leaves only through the timelocked withdrawal ([Surplus
  withdrawal](#surplus-withdrawal-d86)).

## What each party can do after this batch

Replaces the matching rows of `security.md` "What a compromise gives" (D = `issuer_key_delay_ms`, G =
`governance_delay_ms`).

| Compromised | Effect | Limits |
|---|---|---|
| Owner multisig (2 of 3 council keys; on mainnet two founders, or one founder and the backup holder) | After G: any upgrade (anything, including forging tokens), owner transfer, surplus withdrawal. At once: config (sponsors; console audiences and shared clients: removals now, additions after `change_delay_ms`; delays: increases), pause/unpause, remove issuer keys (DoS), remove watchdogs, add or delete updater keys | Can't install a key or code faster than G: key posts wait D and honest watchdogs cancel; removing the watchdogs pushes every key change to ≥ G; upgrades, owner transfers and withdrawals wait G with a public event and a critical alert to both founders. Users and partners get G to react (export keys, D41) |
| One council key (or the backup key's holder alone) | Propose and vote once | Nothing executes without a second key, for every proposal kind (D81) |
| Signer account | Outside sandbox-dev no full-access key exists; its only keys are updater keys (row below). sandbox-dev's full-access key is total control of that testnet env (D86) | Code changes only through `execute_upgrade` with the owner-proposed hash after G |
| `KEYS_UPDATER_KEY` | Propose keys and removals (delayed D), execute matured ones | See [the table above](#what-a-stolen-updater-key-can-still-do-bounded). Forging needs every watchdog down for D, and the next watchdog run pauses |
| One watchdog key | DoS: cancel every key change (Google's next key never activates → logins with it fail), pause, delete updater keys. Confirm early only a change that someone (updater or owner) proposed | Can't post a key. The owner removes it at once and unpauses; another watchdog keeps confirming Google's keys. Forging needs the updater key **and** a confirm-capable watchdog |
| API Worker code, its secrets, or the API's Cloudflare account | The updater key (above); D1 and `VAULT_KEK` rows unchanged; **and still the vault and auth bundles**, so every key of every user who loads the vault while it is compromised | This batch removes the *contract-level* path (forging tokens for any `sub` without the user). The page-serving trust root is unchanged (`security.md` "API Worker code or all Worker secrets"); bounding it is a separate issue |
| Watchdog service's Cloudflare account | One watchdog key (above) and its alert sending | Its silence is caught by the dead-man's switch and the portal's silence warning |
| Hana's main Cloudflare account (admin Worker included) | The API row above; the portal's view of governance and its acks | Can't stop the watchdog's alerts: a portal ack stops only re-sends of an alert already paged, and the watchdog records it (D83) |
| Owner + one watchdog with confirm power | Install a key at once (owner proposes, watchdog confirms) | Two independent compromises; k-of-n confirmation later raises it |

## Migration plan

### sandbox-dev (testnet, in place, no address change)

1. Merge the contract, API, watchdog and script changes; `cargo test`, sandbox e2e and `pnpm -r test` pass.
2. Create the watchdog account (`hana-id-watchdog-dev1.testnet`, manifest `watchdogs`) and a testnet Sputnik DAO
   with three throwaway council accounts, 2-of-3 for every kind (keys in `.secrets/sandbox-dev/`, D81; manifest
   `owner` stays the old account until step 6).
3. `deploy-contract sandbox-dev --upgrade` (signer full-access key still present): `DeployContract` +
   `migrate_v1(issuer_key_delay_ms = 120000, governance_delay_ms = 60000)` in one transaction. Check every scope,
   session and issuer key survived (`get_scope("global")`, `get_issuer("google")`, a live session) and that an
   existing smoke wallet derives the same addresses.
4. Owner (old account): `add_updater_key(new key)`; the API's `KEYS_UPDATER_KEY` is switched to it; the old updater
   key (with `remove_issuer_key`) is deleted with the signer's full-access key. `add_watchdog(watchdog)`; deploy
   `apps/watchdog` to its own Cloudflare account with `WATCHDOG_KEY`; alerts wired (paging app, Slack, email) and
   the admin portal's "Security & monitoring" view reading it.
5. Run a forced rotation drill: post a test kid with the updater (watchdog must cancel within W, delete the updater
   key and page critical; the portal shows the action and the alert; re-add the updater key), then let a real Google
   kid flow through propose → confirm. A pause drill: activate a test kid by delay with the watchdog stopped; on
   restart it pauses; the DAO unpauses at once.
6. `propose_owner(DAO)`; after G, a DAO proposal `accept_owner` (`owner-tx --approve-with`). Manifest `owner` = the
   DAO, `ownerKind: "sputnik"`.
7. A DAO `propose_upgrade(hash)` of the same code rebuilt with a no-op version bump; after G, `upgrade-contract
   execute`. Check `view_account.code_hash`.
8. Keep the signer's full-access key (D86; `allowSignerFullAccessKey: true`). `deploy-contract sandbox-dev` must show
   no blockers.

### Mainnet (at the address freeze; documented now, run by the user only, never by agents)

1. Decide where the backup council key is held (D81). Create the DAO (the founders' Ledgers and the backup key,
   2-of-3 for every kind) and the watchdog account first; deploy the watchdog service and alerting; verify the
   heartbeat, a test critical page to both founders, and the portal view.
2. Build reproducibly (`cargo near build reproducible-wasm`), record and publish the hash (D86).
3. Create the signer account and send the one-batch transaction (Deploy, `new(owner = DAO, change_delay_ms,
   issuer_key_delay_ms = 2 h or the measured value, governance_delay_ms = 72 h, watchdogs)`, AddKey updater,
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
- Withdrawal: owner-only propose and cancel; execute before G panics, while paused panics, leaving less than storage
  plus `SIGNER_RESERVE` panics (checked at execution, after the balance changed); the transfer promise goes to the
  proposed receiver for the proposed amount.
- Console audiences: a removal applies at once; an addition isn't accepted by the console-token check until
  `change_delay_ms` has passed, then is; `get_config` lists it as pending meanwhile; event JSON exact.
- Unpause by the owner takes effect in the same call (no delay).
- A scope change proposed with forged OIDC-owner tokens and a client proof, matured during a pause: `execute_change`
  panics until `change_delay_ms` after the unpause, and an OIDC owner cancels in between; changes proposed after the
  unpause keep their own timelock.
- A session opened under a forged key can't derive after `remove_issuer_key` + `set_sessions_valid_from_ms` +
  `unpause` (and can without the floor); the floor is owner-only, raise-only, never in the future; a v1 session
  counts as opened at `expires_at_ms − MAX_SESSION_MS`; the session record reads both the v1 and the v2 form.

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
  a 1-of-3 vote doesn't execute, 2-of-3 does, for a `FunctionCall`, a `ChangePolicy` and an `AddMember`/`RemoveMember`
  (D81); a non-member can't propose; the policy JSON the scripts create is the one tested.
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

- Each rule in [Watchdog service](#watchdog-service) steps 3–8: confirm on match; cancel + delete updater + critical
  on mismatch or absence (two fetches); a pending removal of a published kid alerts critical and calls nothing; pause
  only on an active kid never seen or with other key material, never on a dropped kid (warning) or at the first run
  (critical, no pause); governance diffs alert and call nothing, including a change of the owner DAO's policy or code
  and an unpause between two runs; heartbeat sent; no action on providers it doesn't
  know; no secret in any log line.
- Severities route to the right channels (stub paging app, Slack, email); a critical alert re-sends every 15 min
  until acked and stops after an ack from the paging app or `POST /alerts/:id/ack`; an ack is recorded with who and
  where; a failing channel doesn't block the others.
- Status endpoint: refuses a missing or wrong bearer token; returns the last run, actions and alerts; can't change
  state except acks.

### Admin portal (`apps/admin`, with batch C's admin tests)

- The "Security & monitoring" view renders each item in [Monitoring in the admin
  portal](#monitoring-in-the-admin-portal) from a stub watchdog and stub RPC: silence warning after two missed
  intervals, countdowns, JWKS match, actions log, pause state, updater keys against the access-key list, pending
  upgrades and owner actions, alert history and ack.
- Every watchdog check id has a portal rendering (a registry test fails when a check is added without one, D83).
- The pending-upgrades page (admin and partner console) shows hash, commit, build command and countdown.

### Scripts

- `deploy-plan`: blocker on a council DAO policy other than the manifest's 2-of-3 council (1 of 3, an `Everyone`
  role, other members, a per-kind policy) for `--transfer-owner` and for `ownerKind: "sputnik"`; blocker on delays
  below the floors outside dev envs (a staging manifest copied from sandbox-dev), a warning in dev envs.
- `deploy-plan`: blocker on a full-access key on the signer for `ownerKind: "sputnik"` unless
  `allowSignerFullAccessKey`; the schema refuses that flag on mainnet and only sandbox-dev's committed manifest sets
  it; blocker on an untracked signer key; owner steps rendered as proposals; mainnet-style plan refuses (testnet-only
  guard stays).
- `owner-tx` both backends; `--approve-with` proposes and approves in one command on testnet and is refused
  elsewhere; `upgrade-contract` propose/execute against the stub RPC, refusing a non-reproducible build for a mainnet
  manifest.

## Build order

1. Contract: state, migrate_v1 with the v1 fixture, key changes, watchdogs, pause, upgrades, owner transfer,
   withdrawal, console-audience timelock, unit tests. Sandbox: migrate and upgrade tests first (they decide whether
   the in-place path works at all).
2. Sputnik DAO in sandbox: threshold and policy encoding test (2-of-3 for every kind); then `owner-tx` (with
   `--approve-with`) and `upgrade-contract` scripts, `deploy-plan` changes.
3. API sync and the `issuer_key_pending` precheck.
4. `apps/watchdog` and alerting: paging app, Slack and the heartbeat first, email through Resend (D87); status
   endpoint.
5. Admin portal "Security & monitoring" view and the pending-upgrades page (needs batch C's admin Worker and console).
6. Lead-time numbers in → replace the provisional mainnet D in `decisions.md` (D80).
7. sandbox-dev migration (plan above), rotation and pause drills, upgrade drill.
8. Reference docs updated in the same branches; `security.md` open issue (e) marked fixed.

## Open questions for the user

All sixteen were answered on 2026-10-29 (`docs/decisions.md` D80–D86); the answers are applied above.

1. **Delays.** Answered (D80): mainnet issuer-key delay 2 h, provisional until the lead-time measurement; governance
   delay 72 h; sandbox-dev 2 min / 60 s. Emergencies are handled by pause.
2. **Multisig.** Answered (D81): Sputnik DAO v2, 2-of-3 for every kind; the founders' Ledgers plus an offline backup
   key; sandbox-dev three throwaway accounts driven by scripts.
3. **Watchdog hosting.** Answered (D86): its own Cloudflare account; one watchdog at launch.
4. **Watchdog automatic actions.** Answered (D82): cancel a pending key Google doesn't publish, delete the updater key
   that proposed it, pause only for such a key active on chain; everything else alert-only; the owner unpauses at
   once. Plus the admin-portal monitoring requirement (D83).
5. **Early activation by one watchdog.** Answered (D86): yes now; k-of-n later.
6. **Watchdog removal slows key changes to G.** Answered (D86): accepted.
7. **Pause scope.** Answered (D86): derivation and new sessions (every token path) and the executors; never
   governance, revocation or cancels.
8. **Upgrade veto.** Answered (D84): no guardian at launch; revisit with an independent party; critical alert on
   every upgrade proposal.
9. **sandbox-dev's signer full-access key.** Answered (D86): kept on sandbox-dev; never on staging or mainnet.
10. **Signer surplus.** Answered (D86): owner-only withdrawal, timelocked by G.
11. **Public notice.** Answered (D86): the event, partner email, and a pending-upgrades page in the admin and partner
    consoles.
12. **Owner-posted keys.** Answered (D86): same D as the updater.
13. **Console audiences.** Answered (D86): additions wait `change_delay_ms`.
14. **Reproducible builds.** Answered (D86): required for every mainnet upgrade, hash published first.
15. **Alert channels and recipients.** Answered (D85): critical / warning / info; both founders.
16. **Events version.** Answered (D86): `1.1.0`, additive.

### Still open

17. **Cancel by a compromised OIDC owner** (from `docs/batch-c-spec.md` open question 9): a hijacked owner can cancel
    any pending change of its scope, including a `SetOwners` that would remove it. Limit cancel to the proposer, need
    a second owner, or add a NEAR-owner veto? Decide before the address freeze (no address impact).
18. Where the mainnet backup council key is held (D81), before mainnet.
19. Which paging app (PagerDuty, Pushover or ntfy), at setup (D85).
20. The measured mainnet issuer-key delay (D80), from `admin issuer-keys:lead-times` after two Google rotations.
