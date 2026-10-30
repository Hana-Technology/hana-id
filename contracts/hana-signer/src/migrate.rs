//! State migrations, run by the contract account only (`#[private]`).
//!
//! - `migrate`: what `execute_upgrade` calls on the new code, in the deploy receipt. This version's: v2 → v3 (email
//!   login, `docs/email-login-spec.md`) in place: it reads the exact v2 root struct below, keeps every field and
//!   appends the v3 ones empty (no self-issued issuer, no account, nothing `opened`), so every scope, client, session,
//!   issuer key, pending change and governance setting survives and no address changes. On a v3 state (a later v3 → v3
//!   fix) it keeps the state as it is.
//! - `migrate_v1`: the in-place v1 → current upgrade of a pre-governance deployment, sent by
//!   `deploy-contract --upgrade` as `DeployContract` + `migrate_v1(...)` in one transaction while the signer still has
//!   its full-access key. No deployment is on v1 any more (sandbox-dev is v2); it stays until the sandbox suite moves
//!   to the v2 → v3 upgrade (`docs/email-login-build-plan.md` batch 2), which deletes it with `HanaSignerV1`.
//!
//! Both panic `Unexpected state version` on a state they don't migrate from, so a stray re-run can't corrupt state.
//! Rollback: a panicking `migrate` reverts the deploy with it (one receipt), so the old code and its state stay. Once
//! v3 is in, v2 code can't come back by upgrade: its `migrate` reads the v2 layout, which a v3 state doesn't parse as
//! (trailing fields), so it panics and the deploy is reverted. A v3 fix is the way forward.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, PublicKey};

use crate::governance::{assert_governance_delay, assert_issuer_key_delay, PendingOwner, PendingUpgrade, PendingWithdrawal, Watchdog, STATE_VERSION};
use crate::issuers::PendingKeyChange;
use crate::{events, registry, sessions, DelayChange, HanaSigner, HanaSignerExt, Issuer, PendingSharedClient, Scope, StorageKey};

const STATE_KEY: &[u8] = b"STATE";

/// The v1 root struct (`develop` 3fd4964, batch B), field for field. Only `migrate_v1` and its tests read it.
#[near(serializers = [borsh])]
pub(crate) struct HanaSignerV1 {
    pub owner: AccountId,
    pub mpc: AccountId,
    pub ckd_domain_id: u64,
    pub console_audiences: Vec<(String, String)>,
    pub sponsors: Vec<AccountId>,
    pub shared_clients: Vec<(String, String)>,
    pub pending_shared_clients: Vec<PendingSharedClient>,
    pub change_delay_ms: u64,
    pub pending_change_delay: Option<DelayChange>,
    pub public_registration: bool,
    pub issuers: LookupMap<String, Issuer>,
    pub iss_index: LookupMap<String, String>,
    pub scopes: LookupMap<String, Scope>,
    pub client_index: LookupMap<(String, String), String>,
    pub removed_clients: LookupMap<(String, String), registry::RemovedClient>,
    pub pending_adds: LookupMap<(String, String), u32>,
    pub next_scope: u64,
    pub sessions: LookupMap<Vec<u8>, sessions::StoredSession>,
    pub session_queue: LookupMap<u64, sessions::QueueEntry>,
    pub queue_head: u64,
    pub queue_tail: u64,
}

/// The v2 root struct (`develop` d1837ec, governance batch), field for field. Only `migrate` and its tests read it.
#[near(serializers = [borsh])]
pub(crate) struct HanaSignerV2 {
    pub owner: AccountId,
    pub mpc: AccountId,
    pub ckd_domain_id: u64,
    pub console_audiences: Vec<(String, String)>,
    pub sponsors: Vec<AccountId>,
    pub shared_clients: Vec<(String, String)>,
    pub pending_shared_clients: Vec<PendingSharedClient>,
    pub change_delay_ms: u64,
    pub pending_change_delay: Option<DelayChange>,
    pub public_registration: bool,
    pub issuers: LookupMap<String, Issuer>,
    pub iss_index: LookupMap<String, String>,
    pub scopes: LookupMap<String, Scope>,
    pub client_index: LookupMap<(String, String), String>,
    pub removed_clients: LookupMap<(String, String), registry::RemovedClient>,
    pub pending_adds: LookupMap<(String, String), u32>,
    pub next_scope: u64,
    pub sessions: LookupMap<Vec<u8>, sessions::StoredSession>,
    pub session_queue: LookupMap<u64, sessions::QueueEntry>,
    pub queue_head: u64,
    pub queue_tail: u64,
    pub state_version: u32,
    pub issuer_key_delay_ms: u64,
    pub pending_issuer_key_delay: Option<DelayChange>,
    pub governance_delay_ms: u64,
    pub pending_governance_delay: Option<DelayChange>,
    pub watchdogs: Vec<Watchdog>,
    pub keys_slow_until_ms: u64,
    pub key_changes: Vec<PendingKeyChange>,
    pub next_key_change: u64,
    pub updater_keys: Vec<PublicKey>,
    pub paused: bool,
    pub pending_upgrade: Option<PendingUpgrade>,
    pub pending_owner: Option<PendingOwner>,
    pub pending_withdrawal: Option<PendingWithdrawal>,
    pub pending_console_audiences: Vec<PendingSharedClient>,
    pub unpaused_at_ms: u64,
    pub changes_unlock_floor_ms: u64,
    pub sessions_valid_from_ms: u64,
    pub pending_updater_keys: Vec<PublicKey>,
}

fn read_raw_state() -> Vec<u8> {
    env::storage_read(STATE_KEY).unwrap_or_else(|| env::panic_str("Unexpected state version"))
}

fn read_state<T: BorshDeserialize>() -> T {
    T::try_from_slice(&read_raw_state()).unwrap_or_else(|_| env::panic_str("Unexpected state version"))
}

fn emit_migrated(from_version: u32) {
    events::emit("state_migrated", json!({ "from_version": from_version, "to_version": STATE_VERSION }));
}

#[near]
impl HanaSigner {
    /// v1 → v3, in place. Starts with no watchdogs, no updater keys, nothing pending, `paused = false`, the two given
    /// delays, and the v3 fields empty. With no watchdog every key change waits `governance_delay_ms` until one is
    /// added.
    #[private]
    #[init(ignore_state)]
    pub fn migrate_v1(issuer_key_delay_ms: u64, governance_delay_ms: u64) -> Self {
        assert_issuer_key_delay(issuer_key_delay_ms);
        assert_governance_delay(governance_delay_ms);
        let v1: HanaSignerV1 = read_state();
        let this = Self::from_v1(v1, issuer_key_delay_ms, governance_delay_ms);
        emit_migrated(1);
        this
    }

    /// Called by `execute_upgrade` on the new code. v2 → v3 (appends the v3 fields), or v3 → v3 (keeps the state).
    /// Anything else panics `Unexpected state version`, which reverts the deploy.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let raw = read_raw_state();
        if let Ok(this) = Self::try_from_slice(&raw) {
            assert!(this.state_version == STATE_VERSION, "Unexpected state version");
            emit_migrated(this.state_version);
            return this;
        }
        let v2 = HanaSignerV2::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("Unexpected state version"));
        assert!(v2.state_version == 2, "Unexpected state version");
        let this = Self::from_v2(v2);
        emit_migrated(2);
        this
    }
}

impl HanaSigner {
    pub(crate) fn from_v1(v1: HanaSignerV1, issuer_key_delay_ms: u64, governance_delay_ms: u64) -> Self {
        Self::from_v2(HanaSignerV2 {
            owner: v1.owner,
            mpc: v1.mpc,
            ckd_domain_id: v1.ckd_domain_id,
            console_audiences: v1.console_audiences,
            sponsors: v1.sponsors,
            shared_clients: v1.shared_clients,
            pending_shared_clients: v1.pending_shared_clients,
            change_delay_ms: v1.change_delay_ms,
            pending_change_delay: v1.pending_change_delay,
            public_registration: v1.public_registration,
            issuers: v1.issuers,
            iss_index: v1.iss_index,
            scopes: v1.scopes,
            client_index: v1.client_index,
            removed_clients: v1.removed_clients,
            pending_adds: v1.pending_adds,
            next_scope: v1.next_scope,
            sessions: v1.sessions,
            session_queue: v1.session_queue,
            queue_head: v1.queue_head,
            queue_tail: v1.queue_tail,
            state_version: 2,
            issuer_key_delay_ms,
            pending_issuer_key_delay: None,
            governance_delay_ms,
            pending_governance_delay: None,
            watchdogs: vec![],
            keys_slow_until_ms: 0,
            key_changes: vec![],
            next_key_change: 0,
            updater_keys: vec![],
            paused: false,
            pending_upgrade: None,
            pending_owner: None,
            pending_withdrawal: None,
            pending_console_audiences: vec![],
            unpaused_at_ms: 0,
            changes_unlock_floor_ms: 0,
            sessions_valid_from_ms: 0,
            pending_updater_keys: vec![],
        })
    }

    /// Every v2 field as it is, then the v3 fields empty.
    pub(crate) fn from_v2(v2: HanaSignerV2) -> Self {
        Self {
            owner: v2.owner,
            mpc: v2.mpc,
            ckd_domain_id: v2.ckd_domain_id,
            console_audiences: v2.console_audiences,
            sponsors: v2.sponsors,
            shared_clients: v2.shared_clients,
            pending_shared_clients: v2.pending_shared_clients,
            change_delay_ms: v2.change_delay_ms,
            pending_change_delay: v2.pending_change_delay,
            public_registration: v2.public_registration,
            issuers: v2.issuers,
            iss_index: v2.iss_index,
            scopes: v2.scopes,
            client_index: v2.client_index,
            removed_clients: v2.removed_clients,
            pending_adds: v2.pending_adds,
            next_scope: v2.next_scope,
            sessions: v2.sessions,
            session_queue: v2.session_queue,
            queue_head: v2.queue_head,
            queue_tail: v2.queue_tail,
            state_version: STATE_VERSION,
            issuer_key_delay_ms: v2.issuer_key_delay_ms,
            pending_issuer_key_delay: v2.pending_issuer_key_delay,
            governance_delay_ms: v2.governance_delay_ms,
            pending_governance_delay: v2.pending_governance_delay,
            watchdogs: v2.watchdogs,
            keys_slow_until_ms: v2.keys_slow_until_ms,
            key_changes: v2.key_changes,
            next_key_change: v2.next_key_change,
            updater_keys: v2.updater_keys,
            paused: v2.paused,
            pending_upgrade: v2.pending_upgrade,
            pending_owner: v2.pending_owner,
            pending_withdrawal: v2.pending_withdrawal,
            pending_console_audiences: v2.pending_console_audiences,
            unpaused_at_ms: v2.unpaused_at_ms,
            changes_unlock_floor_ms: v2.changes_unlock_floor_ms,
            sessions_valid_from_ms: v2.sessions_valid_from_ms,
            pending_updater_keys: v2.pending_updater_keys,
            self_issued: vec![],
            links: LookupMap::new(StorageKey::Links),
            accounts: LookupMap::new(StorageKey::Accounts),
            opened: LookupSet::new(StorageKey::Opened),
        }
    }
}
