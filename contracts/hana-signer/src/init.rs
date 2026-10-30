//! `new`: a fresh deployment. Its own module so the flat JSON interface (8 arguments) doesn't need a crate-wide
//! clippy allow.
#![allow(clippy::too_many_arguments)]

use near_sdk::store::{LookupMap, LookupSet};
use near_sdk::{near, AccountId, PublicKey};

use crate::governance::{self, Watchdog, MAX_UPDATER_KEYS, MAX_WATCHDOGS, STATE_VERSION};
use crate::{HanaSigner, HanaSignerExt, StorageKey, MAX_CHANGE_DELAY_MS};

#[near]
impl HanaSigner {
    /// A fresh deployment (mainnet: the signer account's first transaction, with `owner` = the DAO). Watchdogs listed
    /// here may confirm at once. Each of `updater_keys` is added to this account by the contract itself, as
    /// `add_updater_key` does (exactly `UPDATER_METHODS`, receiver this account, a `MAX_UPDATER_ALLOWANCE`
    /// allowance), so the creation batch needs no `AddKey` action of its own.
    #[init]
    pub fn new(
        owner: AccountId,
        mpc: AccountId,
        ckd_domain_id: u64,
        change_delay_ms: u64,
        issuer_key_delay_ms: u64,
        governance_delay_ms: u64,
        watchdogs: Vec<AccountId>,
        updater_keys: Vec<PublicKey>,
    ) -> Self {
        assert!(change_delay_ms <= MAX_CHANGE_DELAY_MS, "change_delay_ms must be at most 7 days");
        governance::assert_issuer_key_delay(issuer_key_delay_ms);
        governance::assert_governance_delay(governance_delay_ms);
        assert!(watchdogs.len() <= MAX_WATCHDOGS, "Too many watchdogs");
        for (i, w) in watchdogs.iter().enumerate() {
            assert!(!watchdogs[..i].contains(w), "Already a watchdog");
        }
        assert!(updater_keys.len() <= MAX_UPDATER_KEYS, "Too many updater keys");
        for (i, k) in updater_keys.iter().enumerate() {
            assert!(!updater_keys[..i].contains(k), "Already an updater key");
        }
        let mut this = Self {
            owner,
            mpc,
            ckd_domain_id,
            console_audiences: vec![],
            sponsors: vec![],
            shared_clients: vec![],
            pending_shared_clients: vec![],
            change_delay_ms,
            pending_change_delay: None,
            public_registration: false,
            issuers: LookupMap::new(StorageKey::Issuers),
            iss_index: LookupMap::new(StorageKey::IssIndex),
            scopes: LookupMap::new(StorageKey::Scopes),
            client_index: LookupMap::new(StorageKey::ClientIndex),
            removed_clients: LookupMap::new(StorageKey::RemovedClients),
            pending_adds: LookupMap::new(StorageKey::PendingAdds),
            next_scope: 1,
            sessions: LookupMap::new(StorageKey::Sessions),
            session_queue: LookupMap::new(StorageKey::SessionQueue),
            queue_head: 0,
            queue_tail: 0,
            state_version: STATE_VERSION,
            issuer_key_delay_ms,
            pending_issuer_key_delay: None,
            governance_delay_ms,
            pending_governance_delay: None,
            watchdogs: watchdogs.into_iter().map(|account_id| Watchdog { account_id, confirm_from_ms: 0 }).collect(),
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
            self_issued: vec![],
            links: LookupMap::new(StorageKey::Links),
            accounts: LookupMap::new(StorageKey::Accounts),
            opened: LookupSet::new(StorageKey::Opened),
        };
        for public_key in updater_keys {
            this.install_updater_key(public_key).detach();
        }
        this
    }
}
