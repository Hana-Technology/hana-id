//! State migrations, run by the contract account only (`#[private]`).
//!
//! - `migrate`: what `execute_upgrade` calls on the new code, in the deploy receipt. This version's: v3 → v4 (the exit
//!   client, `docs/hana-home-h6-design.md`) in place: it reads the exact v3 root struct below, keeps every field and
//!   appends the v4 ones empty (no exit client, an empty exit window), so every scope, client, session, issuer key,
//!   account, pending change and governance setting survives and no address changes. On a v4 state (a later v4 → v4
//!   fix) it keeps the state as it is.
//!
//! There is no v2 or earlier migration any more: every deployment is on v3 (sandbox-dev since 2026-11-03), so `migrate_v2`
//! and the v2 layout copy went with this batch, as v1's did. A v2 state doesn't parse as the v3 or v4 layout (it is
//! shorter), so `migrate` refuses it.
//!
//! `migrate` panics `Unexpected state version` on a state it doesn't migrate from, so a stray run can't corrupt state.
//! Rollback: a panicking `migrate` reverts the deploy with it (one receipt), so the old code and its state stay. Once
//! v4 is in, v3 code can't come back by upgrade: its `migrate` reads the v3 layout, which a v4 state doesn't parse as
//! (trailing fields), so it panics and the deploy is reverted. A v4 fix is the way forward.

use near_sdk::borsh::BorshDeserialize;
use near_sdk::serde_json::json;
use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{env, near, AccountId, PublicKey};

use crate::governance::{PendingOwner, PendingUpgrade, PendingWithdrawal, Watchdog, STATE_VERSION};
use crate::issuers::PendingKeyChange;
use crate::{events, exit, link_counter, links, registry, self_issued, sessions, DelayChange, HanaSigner, HanaSignerExt, Issuer, PendingSharedClient, Scope};

const STATE_KEY: &[u8] = b"STATE";

/// The v3 root struct (`develop` 81ebfa06, email login and the link counter), field for field. Only `migrate` and its
/// tests read it.
#[near(serializers = [borsh])]
pub(crate) struct HanaSignerV3 {
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
    pub self_issued: Vec<self_issued::SelfIssued>,
    pub links: LookupMap<links::IdentityKey, links::MemberRecord>,
    pub accounts: LookupMap<links::IdentityKey, links::Account>,
    pub opened: LookupSet<links::IdentityKey>,
    pub unrecorded_wallets: bool,
    pub link_counter: link_counter::LinkCounter,
}

fn read_raw_state() -> Vec<u8> {
    env::storage_read(STATE_KEY).unwrap_or_else(|| env::panic_str("Unexpected state version"))
}

fn emit_migrated(from_version: u32) {
    events::emit("state_migrated", json!({ "from_version": from_version, "to_version": STATE_VERSION }));
}

#[near]
impl HanaSigner {
    /// Called by `execute_upgrade` on the new code. v3 → v4 (appends the v4 fields), or v4 → v4 (keeps the state).
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
        let v3 = HanaSignerV3::try_from_slice(&raw).unwrap_or_else(|_| env::panic_str("Unexpected state version"));
        assert!(v3.state_version == 3, "Unexpected state version");
        let this = Self::from_v3(v3);
        emit_migrated(3);
        this
    }
}

impl HanaSigner {
    /// Every v3 field as it is, then the v4 fields empty.
    pub(crate) fn from_v3(v3: HanaSignerV3) -> Self {
        Self {
            owner: v3.owner,
            mpc: v3.mpc,
            ckd_domain_id: v3.ckd_domain_id,
            console_audiences: v3.console_audiences,
            sponsors: v3.sponsors,
            shared_clients: v3.shared_clients,
            pending_shared_clients: v3.pending_shared_clients,
            change_delay_ms: v3.change_delay_ms,
            pending_change_delay: v3.pending_change_delay,
            public_registration: v3.public_registration,
            issuers: v3.issuers,
            iss_index: v3.iss_index,
            scopes: v3.scopes,
            client_index: v3.client_index,
            removed_clients: v3.removed_clients,
            pending_adds: v3.pending_adds,
            next_scope: v3.next_scope,
            sessions: v3.sessions,
            session_queue: v3.session_queue,
            queue_head: v3.queue_head,
            queue_tail: v3.queue_tail,
            state_version: STATE_VERSION,
            issuer_key_delay_ms: v3.issuer_key_delay_ms,
            pending_issuer_key_delay: v3.pending_issuer_key_delay,
            governance_delay_ms: v3.governance_delay_ms,
            pending_governance_delay: v3.pending_governance_delay,
            watchdogs: v3.watchdogs,
            keys_slow_until_ms: v3.keys_slow_until_ms,
            key_changes: v3.key_changes,
            next_key_change: v3.next_key_change,
            updater_keys: v3.updater_keys,
            paused: v3.paused,
            pending_upgrade: v3.pending_upgrade,
            pending_owner: v3.pending_owner,
            pending_withdrawal: v3.pending_withdrawal,
            pending_console_audiences: v3.pending_console_audiences,
            unpaused_at_ms: v3.unpaused_at_ms,
            changes_unlock_floor_ms: v3.changes_unlock_floor_ms,
            sessions_valid_from_ms: v3.sessions_valid_from_ms,
            pending_updater_keys: v3.pending_updater_keys,
            self_issued: v3.self_issued,
            links: v3.links,
            accounts: v3.accounts,
            opened: v3.opened,
            unrecorded_wallets: v3.unrecorded_wallets,
            link_counter: v3.link_counter,
            exit_clients: vec![],
            pending_exit_clients: vec![],
            exit_window: exit::ExitWindow::default(),
        }
    }
}
