//! Governance (`docs/governance-spec.md`): the delays, watchdogs, pause, the updater keys the contract installs on
//! its own account, timelocked upgrades, owner transfer and surplus withdrawal.
//!
//! Who may do what:
//! - **owner** (a Sputnik DAO council outside local envs): every method here except `confirm_issuer_key_change`,
//!   `accept_owner` and the executors. Owner actions that could take control (upgrade, owner transfer, withdrawal)
//!   wait `governance_delay_ms` with a public event; a new watchdog's confirm power waits it too.
//! - **watchdog**: cancel and confirm key changes (`issuers.rs`), pause, delete updater keys. DoS only: it can't post
//!   a key, change code or move anything.
//! - **anyone**: the executors once due (`execute_upgrade`, `execute_withdrawal`, `execute_issuer_key_change`), views.

use near_sdk::json_types::Base58CryptoHash;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId, Allowance, CryptoHash, Gas, NearToken, Promise, PromiseError, PublicKey};

use crate::{events, DelayChange, HanaSigner, HanaSignerExt};

/// Layout version of the state this code reads and writes (`HanaSigner::state_version`).
pub const STATE_VERSION: u32 = 2;
pub const MAX_ISSUER_KEY_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_GOVERNANCE_DELAY_MS: u64 = 30 * 24 * 60 * 60 * 1000;
pub const MAX_WATCHDOGS: usize = 3;
pub const MAX_UPDATER_KEYS: usize = 2;
/// Gas allowance of every updater key. The key spends the signer account's balance on gas, never more than this.
pub const MAX_UPDATER_ALLOWANCE: NearToken = NearToken::from_near(1);
/// The only methods an updater key may call (receiver: this account). A constant, so the contract can never add a
/// full-access key or a key for any other method.
pub const UPDATER_METHODS: &str = "set_issuer_key,propose_issuer_key_removal,execute_issuer_key_change";
/// NEAR a surplus withdrawal must leave on the signer above its storage cost (provisional, D86).
pub const SIGNER_RESERVE: NearToken = NearToken::from_near(5);
/// Gas the deploy receipt of `execute_upgrade` gives the new code's `migrate`.
pub const MIGRATE_GAS: Gas = Gas::from_tgas(50);
const CALLBACK_GAS: Gas = Gas::from_tgas(5);

/// A watchdog: may cancel key changes, pause and delete updater keys at once, and confirm (activate early) key
/// changes from `confirm_from_ms` on.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Watchdog {
    pub account_id: AccountId,
    pub confirm_from_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgrade {
    /// sha256 of the wasm (NEAR's account `code_hash`).
    pub code_hash: CryptoHash,
    pub proposed_at_ms: u64,
    pub executable_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingUpgradeView {
    /// base58, as `view_account` shows `code_hash`.
    pub code_hash: Base58CryptoHash,
    pub proposed_at_ms: u64,
    pub executable_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingOwner {
    pub owner: AccountId,
    pub acceptable_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingWithdrawal {
    pub receiver: AccountId,
    pub amount: NearToken,
    pub executable_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct GovernanceView {
    pub state_version: u32,
    pub watchdogs: Vec<Watchdog>,
    pub keys_slow_until_ms: u64,
    /// Updater keys on the account (their `AddKey` succeeded).
    pub updater_keys: Vec<PublicKey>,
    /// Updater keys requested whose `AddKey` hasn't resolved yet (normally empty: the callback runs a block later).
    pub pending_updater_keys: Vec<PublicKey>,
    /// `UPDATER_METHODS`: the exact method list of every updater key, for comparing with the account's key list.
    pub updater_methods: Vec<String>,
    pub pending_upgrade: Option<PendingUpgradeView>,
    pub pending_owner: Option<PendingOwner>,
    pub pending_withdrawal: Option<PendingWithdrawal>,
}

pub(crate) fn assert_issuer_key_delay(ms: u64) {
    assert!(ms <= MAX_ISSUER_KEY_DELAY_MS, "issuer_key_delay_ms must be at most 7 days");
}

pub(crate) fn assert_governance_delay(ms: u64) {
    assert!(ms <= MAX_GOVERNANCE_DELAY_MS, "governance_delay_ms must be at most 30 days");
}

fn upgrade_view(p: &PendingUpgrade) -> PendingUpgradeView {
    PendingUpgradeView { code_hash: p.code_hash.into(), proposed_at_ms: p.proposed_at_ms, executable_at_ms: p.executable_at_ms }
}

fn b58(hash: &CryptoHash) -> Base58CryptoHash {
    (*hash).into()
}

#[near]
impl HanaSigner {
    // ---- Delays (owner) ----

    /// ≤ 7 days. An increase applies now; a decrease only after `governance_delay_ms`, so a compromised owner can't
    /// shorten the window in which watchdogs cancel a forged key faster than it could upgrade the contract. Queued key
    /// changes keep their `executable_at_ms`.
    pub fn set_issuer_key_delay_ms(&mut self, issuer_key_delay_ms: u64) {
        self.assert_owner();
        assert_issuer_key_delay(issuer_key_delay_ms);
        let now = env::block_timestamp_ms();
        let wait = self.governance_delay_at(now);
        self.issuer_key_delay_ms = self.issuer_key_delay_at(now);
        let effective_at_ms = schedule(&mut self.issuer_key_delay_ms, &mut self.pending_issuer_key_delay, issuer_key_delay_ms, now, wait);
        events::emit("delay_changed", json!({ "which": "issuer_key", "value_ms": issuer_key_delay_ms, "effective_at_ms": effective_at_ms }));
    }

    /// ≤ 30 days. An increase applies now; a decrease only after the current governance delay. Queued upgrades,
    /// owner transfers and withdrawals keep their times.
    pub fn set_governance_delay_ms(&mut self, governance_delay_ms: u64) {
        self.assert_owner();
        assert_governance_delay(governance_delay_ms);
        let now = env::block_timestamp_ms();
        let current = self.governance_delay_at(now);
        self.governance_delay_ms = current;
        let effective_at_ms = schedule(&mut self.governance_delay_ms, &mut self.pending_governance_delay, governance_delay_ms, now, current);
        events::emit("delay_changed", json!({ "which": "governance", "value_ms": governance_delay_ms, "effective_at_ms": effective_at_ms }));
    }

    // ---- Watchdogs (owner) ----

    /// Cancel, pause and updater-key deletion apply at once (DoS only); confirm power from `now +
    /// governance_delay_ms`, so a compromised owner can't add a yes-man that confirms a forged key faster than an
    /// upgrade.
    pub fn add_watchdog(&mut self, account_id: AccountId) {
        self.assert_owner();
        assert!(!self.is_watchdog(&account_id), "Already a watchdog");
        assert!(self.watchdogs.len() < MAX_WATCHDOGS, "Too many watchdogs");
        let now = env::block_timestamp_ms();
        let confirm_from_ms = now.saturating_add(self.governance_delay_at(now));
        events::emit("watchdog_added", json!({ "account_id": account_id, "confirm_from_ms": confirm_from_ms }));
        self.watchdogs.push(Watchdog { account_id, confirm_from_ms });
    }

    /// Immediate, so a rogue watchdog goes at once. It also slows every time-based key activation, pending or
    /// future, to `now + governance_delay_ms`: silencing the watchdogs never lets a compromised owner install a key
    /// faster than an upgrade. A remaining watchdog's confirmations still activate keys early.
    pub fn remove_watchdog(&mut self, account_id: AccountId) {
        self.assert_owner();
        let index = self.watchdogs.iter().position(|w| w.account_id == account_id).unwrap_or_else(|| env::panic_str("Not a watchdog"));
        self.watchdogs.remove(index);
        let now = env::block_timestamp_ms();
        self.keys_slow_until_ms = self.keys_slow_until_ms.max(now.saturating_add(self.governance_delay_at(now)));
        for change in &mut self.key_changes {
            change.executable_at_ms = change.executable_at_ms.max(self.keys_slow_until_ms);
        }
        events::emit("watchdog_removed", json!({ "account_id": account_id, "keys_slow_until_ms": self.keys_slow_until_ms }));
    }

    // ---- Pause ----

    /// Owner or any watchdog. Stops every token path (sessions, scope registration, token-authenticated owner
    /// actions), `derive_key` and the executors (`execute_change`, `execute_issuer_key_change`,
    /// `execute_withdrawal`). Governance, revocation, cancels, watchdog confirmations and views keep working. No-op
    /// if already paused.
    pub fn pause(&mut self) {
        let by = self.assert_owner_or_watchdog();
        if !self.paused {
            self.paused = true;
            events::emit("paused", json!({ "by": by }));
        }
    }

    /// Owner only, at once (no governance delay, D82). No-op if not paused. Re-arms the scope-change timelock: no
    /// change executes before `now + change_delay_ms` (`changes_unlock_floor_ms`). While paused OIDC owners can't
    /// cancel (every token path stops), so a change that was pending across the pause, for instance one proposed with
    /// a forged key's tokens before the watchdog paused, still gets a full public window after the unpause.
    pub fn unpause(&mut self) {
        self.assert_owner();
        if self.paused {
            self.paused = false;
            let now = env::block_timestamp_ms();
            self.unpaused_at_ms = now;
            self.changes_unlock_floor_ms = self.changes_unlock_floor_ms.max(now.saturating_add(self.change_delay_at(now)));
            events::emit("unpaused", json!({ "changes_unlock_floor_ms": self.changes_unlock_floor_ms }));
        }
    }

    /// Owner. Sessions opened before `sessions_valid_from_ms` can no longer derive (`derive_key` panics `No such
    /// session`) and `get_session` returns `null` for them. For a forged issuer key that was active: the sessions it
    /// opened stay usable after the key is removed until this floor is raised past them (any time after the pause, since
    /// no session opens while paused). Only raised, never lowered, and never past the current block time (a future
    /// floor would refuse sessions opened between now and then). Allowed while paused.
    pub fn set_sessions_valid_from_ms(&mut self, sessions_valid_from_ms: u64) {
        self.assert_owner();
        assert!(sessions_valid_from_ms <= env::block_timestamp_ms(), "sessions_valid_from_ms can't be in the future");
        assert!(sessions_valid_from_ms >= self.sessions_valid_from_ms, "sessions_valid_from_ms can only be raised");
        self.sessions_valid_from_ms = sessions_valid_from_ms;
        events::emit("sessions_valid_from_set", json!({ "sessions_valid_from_ms": sessions_valid_from_ms }));
    }

    // ---- Updater keys (the signer manages its own access keys) ----

    /// Owner. Adds `public_key` to this account as a function-call key with exactly `UPDATER_METHODS`, receiver this
    /// account, allowance `MAX_UPDATER_ALLOWANCE`. ≤ 2 keys, pending and confirmed together. The key is pending
    /// (`pending_updater_keys`) until the `AddKey` resolves: on success the callback moves it to `updater_keys`; on
    /// failure (e.g. the key is already on the account, with whatever permission) it drops it and the call returns
    /// `false`.
    pub fn add_updater_key(&mut self, public_key: PublicKey) -> Promise {
        self.assert_owner();
        self.install_updater_key(public_key)
    }

    /// Owner or any watchdog (the watchdog deletes every updater key the moment it sees a forged proposal from the
    /// contract account). A watchdog may delete only confirmed keys in `updater_keys` (`Not an updater key`): never a
    /// pending one, whose `AddKey` may yet fail because the key is already on the account with another permission
    /// (e.g. a full-access key). The owner may delete any key on this account, so an untracked key can be cleaned up
    /// without a full-access key; deleting a pending key also stops its callback from tracking it.
    pub fn delete_updater_key(&mut self, public_key: PublicKey) -> Promise {
        let by = self.assert_owner_or_watchdog();
        let index = self.updater_keys.iter().position(|k| *k == public_key);
        match index {
            Some(i) => {
                self.updater_keys.remove(i);
            }
            None => {
                assert!(by == self.owner, "Not an updater key");
                self.pending_updater_keys.retain(|k| *k != public_key);
            }
        }
        events::emit("updater_key_deleted", json!({ "public_key": public_key, "by": by }));
        Promise::new(env::current_account_id()).delete_key(public_key)
    }

    /// Callback of the `AddKey` receipt of `add_updater_key` / `new`. Keeps `updater_keys` equal to what is on chain:
    /// a pending key becomes an updater key only if its `AddKey` succeeded. A key the owner deleted while pending is
    /// not tracked either way.
    #[private]
    pub fn on_updater_key_added(&mut self, public_key: PublicKey) -> bool {
        // An AddKey receipt returns no value; only success or failure matters (a non-empty value can't occur and
        // still means the receipt succeeded).
        let added = !matches!(env::promise_result_checked(0, 0), Err(PromiseError::Failed));
        let was_pending = self.pending_updater_keys.contains(&public_key);
        self.pending_updater_keys.retain(|k| *k != public_key);
        if !added {
            events::emit("updater_key_add_failed", json!({ "public_key": public_key }));
        } else if was_pending && !self.updater_keys.contains(&public_key) {
            self.updater_keys.push(public_key);
        }
        added
    }

    // ---- Upgrades ----

    /// Owner. `code_hash` is the base58 sha256 of the wasm (the account `code_hash` format). Replaces a pending
    /// upgrade (`upgrade_cancelled` for the old one). Executable after `governance_delay_ms`; nobody but the owner can
    /// cancel it (no guardian, D84).
    pub fn propose_upgrade(&mut self, code_hash: Base58CryptoHash) {
        self.assert_owner();
        if let Some(old) = self.pending_upgrade.take() {
            events::emit("upgrade_cancelled", json!({ "code_hash": b58(&old.code_hash) }));
        }
        let now = env::block_timestamp_ms();
        let executable_at_ms = now.saturating_add(self.governance_delay_at(now));
        events::emit("upgrade_proposed", json!({ "code_hash": code_hash, "executable_at_ms": executable_at_ms }));
        self.pending_upgrade = Some(PendingUpgrade { code_hash: code_hash.into(), proposed_at_ms: now, executable_at_ms });
    }

    /// Owner.
    pub fn cancel_upgrade(&mut self) {
        self.assert_owner();
        let old = self.pending_upgrade.take().unwrap_or_else(|| env::panic_str("No pending upgrade"));
        events::emit("upgrade_cancelled", json!({ "code_hash": b58(&old.code_hash) }));
    }

    /// Anyone, once due. The input is the raw wasm (not JSON). Deploys it and calls its `migrate` in one receipt to
    /// this account, so a panicking `migrate` rolls the deploy back and the old code stays. Allowed while paused (a
    /// fix must be deployable). The pending upgrade is cleared either way: after a failed `migrate`, propose again.
    pub fn execute_upgrade(&mut self) -> Promise {
        let pending = self.pending_upgrade.clone().unwrap_or_else(|| env::panic_str("No pending upgrade"));
        assert!(env::block_timestamp_ms() >= pending.executable_at_ms, "Upgrade is still delayed");
        let code = env::input().unwrap_or_default();
        assert!(env::sha256_array(&code) == pending.code_hash, "Code doesn't match the proposed hash");
        self.pending_upgrade = None;
        events::emit("upgrade_executed", json!({ "code_hash": b58(&pending.code_hash) }));
        Promise::new(env::current_account_id()).deploy_contract(code).function_call("migrate", Vec::new(), NearToken::from_yoctonear(0), MIGRATE_GAS)
    }

    // ---- Owner transfer ----

    /// Owner. The new owner may accept after `governance_delay_ms`. Replaces a pending proposal
    /// (`owner_proposal_cancelled` for the old one).
    pub fn propose_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        if let Some(old) = self.pending_owner.take() {
            events::emit("owner_proposal_cancelled", json!({ "owner": old.owner }));
        }
        let now = env::block_timestamp_ms();
        let acceptable_at_ms = now.saturating_add(self.governance_delay_at(now));
        events::emit("owner_proposed", json!({ "owner": owner, "acceptable_at_ms": acceptable_at_ms }));
        self.pending_owner = Some(PendingOwner { owner, acceptable_at_ms });
    }

    /// Owner.
    pub fn cancel_owner_proposal(&mut self) {
        self.assert_owner();
        let old = self.pending_owner.take().unwrap_or_else(|| env::panic_str("No pending owner change"));
        events::emit("owner_proposal_cancelled", json!({ "owner": old.owner }));
    }

    /// The proposed account, after the delay: proves the new owner (a DAO) can actually call the contract before it
    /// takes control.
    pub fn accept_owner(&mut self) {
        let caller = env::predecessor_account_id();
        let pending = self.pending_owner.clone().filter(|p| p.owner == caller).unwrap_or_else(|| env::panic_str("Not the proposed owner"));
        assert!(env::block_timestamp_ms() >= pending.acceptable_at_ms, "Owner change is still delayed");
        let old = std::mem::replace(&mut self.owner, pending.owner);
        self.pending_owner = None;
        events::emit("owner_changed", json!({ "old": old, "new": self.owner }));
    }

    // ---- Surplus withdrawal (D86) ----

    /// Owner. Replaces a pending withdrawal (`withdrawal_cancelled` for the old one). Executable after
    /// `governance_delay_ms`.
    pub fn propose_withdrawal(&mut self, receiver: AccountId, amount: NearToken) {
        self.assert_owner();
        assert!(!amount.is_zero(), "Withdrawal amount must be positive");
        if let Some(old) = self.pending_withdrawal.take() {
            events::emit("withdrawal_cancelled", json!({ "receiver": old.receiver, "amount": old.amount }));
        }
        let now = env::block_timestamp_ms();
        let executable_at_ms = now.saturating_add(self.governance_delay_at(now));
        events::emit("withdrawal_proposed", json!({ "receiver": receiver, "amount": amount, "executable_at_ms": executable_at_ms }));
        self.pending_withdrawal = Some(PendingWithdrawal { receiver, amount, executable_at_ms });
    }

    /// Owner.
    pub fn cancel_withdrawal(&mut self) {
        self.assert_owner();
        let old = self.pending_withdrawal.take().unwrap_or_else(|| env::panic_str("No pending withdrawal"));
        events::emit("withdrawal_cancelled", json!({ "receiver": old.receiver, "amount": old.amount }));
    }

    /// Anyone, once due and not while paused. Refuses unless the balance after the transfer still covers this
    /// account's storage plus `SIGNER_RESERVE`, checked now (the balance may have changed since the proposal).
    pub fn execute_withdrawal(&mut self) -> Promise {
        let pending = self.pending_withdrawal.clone().unwrap_or_else(|| env::panic_str("No pending withdrawal"));
        assert!(env::block_timestamp_ms() >= pending.executable_at_ms, "Withdrawal is still delayed");
        self.assert_not_paused();
        let storage = env::storage_byte_cost().saturating_mul(u128::from(env::storage_usage()));
        let keep = storage.saturating_add(SIGNER_RESERVE);
        let left = env::account_balance().checked_sub(pending.amount);
        assert!(left.is_some_and(|left| left >= keep), "Withdrawal would leave too little");
        self.pending_withdrawal = None;
        events::emit("withdrawal_executed", json!({ "receiver": pending.receiver, "amount": pending.amount }));
        Promise::new(pending.receiver).transfer(pending.amount)
    }

    // ---- Views ----

    pub fn get_governance(&self) -> GovernanceView {
        GovernanceView {
            state_version: self.state_version,
            watchdogs: self.watchdogs.clone(),
            keys_slow_until_ms: self.keys_slow_until_ms,
            updater_keys: self.updater_keys.clone(),
            pending_updater_keys: self.pending_updater_keys.clone(),
            updater_methods: UPDATER_METHODS.split(',').map(String::from).collect(),
            pending_upgrade: self.pending_upgrade.as_ref().map(upgrade_view),
            pending_owner: self.pending_owner.clone(),
            pending_withdrawal: self.pending_withdrawal.clone(),
        }
    }
}

/// Applies `value` to a delay now if it is an increase (or equal), else schedules it as a decrease after `wait`.
/// `current` must already hold the value in force. Returns when the new value is in force.
fn schedule(current: &mut u64, pending: &mut Option<DelayChange>, value: u64, now: u64, wait: u64) -> u64 {
    if value >= *current {
        *current = value;
        *pending = None;
        now
    } else {
        let effective_at_ms = now.saturating_add(wait);
        *pending = Some(DelayChange { change_delay_ms: value, effective_at_ms });
        effective_at_ms
    }
}

impl HanaSigner {
    pub(crate) fn is_watchdog(&self, account_id: &AccountId) -> bool {
        self.watchdogs.iter().any(|w| w.account_id == *account_id)
    }

    /// Panics unless the caller is the owner or a watchdog; returns the caller.
    pub(crate) fn assert_owner_or_watchdog(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        assert!(caller == self.owner || self.is_watchdog(&caller), "Only the owner or a watchdog can do this");
        caller
    }

    pub(crate) fn assert_not_paused(&self) {
        assert!(!self.paused, "Paused");
    }

    /// Tracks `public_key` as pending and adds it to this account with the fixed updater permission; the callback
    /// confirms it (moves it to `updater_keys`) if the `AddKey` succeeded, else drops it.
    pub(crate) fn install_updater_key(&mut self, public_key: PublicKey) -> Promise {
        assert!(!self.updater_keys.contains(&public_key) && !self.pending_updater_keys.contains(&public_key), "Already an updater key");
        assert!(self.updater_keys.len() + self.pending_updater_keys.len() < MAX_UPDATER_KEYS, "Too many updater keys");
        self.pending_updater_keys.push(public_key.clone());
        events::emit("updater_key_added", json!({ "public_key": public_key }));
        let me = env::current_account_id();
        let allowance = Allowance::limited(MAX_UPDATER_ALLOWANCE).expect("non-zero allowance");
        Promise::new(me.clone())
            .add_access_key_allowance(public_key.clone(), allowance, me.clone(), UPDATER_METHODS)
            .then(Self::ext(me).with_static_gas(CALLBACK_GAS).on_updater_key_added(public_key))
    }
}
