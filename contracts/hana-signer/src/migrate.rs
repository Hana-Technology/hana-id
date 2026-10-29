//! State migrations, run by the contract account only (`#[private]`).
//!
//! - `migrate_v1` (this batch only, deleted in the next version): the in-place v1 → v2 upgrade of an existing
//!   deployment (sandbox-dev), sent by `deploy-contract --upgrade` as `DeployContract` + `migrate_v1(...)` in one
//!   transaction while the signer still has its full-access key. It reads the exact v1 root struct below and keeps
//!   every field, so every scope, client, session and issuer key survives and no address changes.
//! - `migrate`: what `execute_upgrade` calls on the new code, in the deploy receipt. Each version ships its own: this
//!   one (no layout change since v2) checks `state_version` and keeps the state. The next layout change replaces it
//!   with one that reads a copy of today's `HanaSigner` and refuses any other version.
//!
//! Both panic `Unexpected state version` on a state they don't migrate from (for `migrate_v1`, a v2 state: the v1
//! layout doesn't deserialize from it), so a stray re-run can't corrupt state.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId};

use crate::governance::{assert_governance_delay, assert_issuer_key_delay, STATE_VERSION};
use crate::{events, registry, sessions, DelayChange, HanaSigner, HanaSignerExt, Issuer, PendingSharedClient, Scope};

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

fn read_state<T: BorshDeserialize>() -> T {
    let raw = env::storage_read(STATE_KEY).unwrap_or_else(|| env::panic_str("Unexpected state version"));
    T::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("Unexpected state version"))
}

fn emit_migrated(from_version: u32) {
    events::emit("state_migrated", json!({ "from_version": from_version, "to_version": STATE_VERSION }));
}

#[near]
impl HanaSigner {
    /// v1 → v2, in place. Starts with no watchdogs, no updater keys, nothing pending, `paused = false`, and the two
    /// given delays. With no watchdog every key change waits `governance_delay_ms` until one is added.
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

    /// Called by `execute_upgrade` on the new code. v2 → v2: checks the layout version and keeps the state.
    #[private]
    #[init(ignore_state)]
    pub fn migrate() -> Self {
        let this: Self = read_state();
        assert!(this.state_version == STATE_VERSION, "Unexpected state version");
        emit_migrated(this.state_version);
        this
    }
}

impl HanaSigner {
    pub(crate) fn from_v1(v1: HanaSignerV1, issuer_key_delay_ms: u64, governance_delay_ms: u64) -> Self {
        Self {
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
            state_version: STATE_VERSION,
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
        }
    }
}
