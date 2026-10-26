//! Hana ID signer: turns an OIDC (Google) ID token into a session that can ask the NEAR MPC for the user's key
//! through Confidential Key Derivation (CKD), encrypted to a key only the user's browser holds.
//!
//! - `create_session` verifies the ID token on-chain (RS256 against issuer keys stored in this contract). The token's
//!   `(provider, aud)` picks a **scope** from the registry, so each partner app gets its own keys; its `nonce` commits
//!   to a browser-held Ed25519 session key. Path = `{scope_id}#{provider}#{sub}#{key_index}`.
//! - `derive_key` (signed by the session key) calls the MPC's `request_app_private_key` with that path.
//! - The registry (`registry.rs`) maps client ids to scopes. Scope owners (NEAR accounts or OIDC identities) manage
//!   their scope; adding clients and changing owners is timelocked. Hana (the `owner`) registers scopes while
//!   `public_registration` is off, and can never change a registered scope's clients or owners.
//!
//! The exact JSON interface and byte layouts are in `docs/contract-interface.md`.

mod events;
mod issuers;
mod oidc;
mod registry;
mod sessions;
#[cfg(test)]
mod tests;

pub use issuers::{Issuer, IssuerView, RsaKey};
pub use registry::{Change, Owner, OwnerAuth, PendingChange, RemovedClient, Scope};
pub use sessions::{CkdAppPublicKey, CkdRequestArgs, Session};

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise};

pub const MAX_CHANGE_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_SPONSORS: usize = 10;
const MAX_CONSOLE_AUDIENCES: usize = 10;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    Issuers,
    IssIndex,
    Scopes,
    ClientIndex,
    Sessions,
    SessionQueue,
    RemovedClients,
}

/// A scheduled decrease of `change_delay_ms` (increases apply at once).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DelayChange {
    pub change_delay_ms: u64,
    pub effective_at_ms: u64,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub mpc: AccountId,
    pub ckd_domain_id: u64,
    pub console_audiences: Vec<(String, String)>,
    pub sponsors: Vec<AccountId>,
    /// The delay in force now.
    pub change_delay_ms: u64,
    pub pending_change_delay: Option<DelayChange>,
    pub public_registration: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HanaSigner {
    /// Hana admin.
    pub(crate) owner: AccountId,
    /// NEAR MPC signer (e.g. v1.signer-prod.testnet).
    pub(crate) mpc: AccountId,
    /// The MPC's CKD (BLS12-381) domain.
    pub(crate) ckd_domain_id: u64,
    /// (provider, aud) of Hana's console: tokens for these may authorise OIDC owner actions.
    pub(crate) console_audiences: Vec<(String, String)>,
    /// Callers whose registrations and proposals the contract pays storage for (the relayer).
    pub(crate) sponsors: Vec<AccountId>,
    pub(crate) change_delay_ms: u64,
    pub(crate) pending_change_delay: Option<DelayChange>,
    /// One way: false → true.
    pub(crate) public_registration: bool,
    /// provider → issuer.
    pub(crate) issuers: LookupMap<String, Issuer>,
    /// iss claim value → provider.
    pub(crate) iss_index: LookupMap<String, String>,
    pub(crate) scopes: LookupMap<String, Scope>,
    /// (provider, aud) → scope id.
    pub(crate) client_index: LookupMap<(String, String), String>,
    /// (provider, aud) → the scope it was removed from and when another scope may take it (see `remove_client`).
    pub(crate) removed_clients: LookupMap<(String, String), registry::RemovedClient>,
    /// The next contract-assigned scope number (scope id = "s" + base36).
    pub(crate) next_scope: u64,
    /// Session public key (32 bytes) → session.
    pub(crate) sessions: LookupMap<Vec<u8>, sessions::StoredSession>,
    /// FIFO of (expiry, key) in insertion order, for pruning: entries [queue_head, queue_tail).
    pub(crate) session_queue: LookupMap<u64, sessions::QueueEntry>,
    pub(crate) queue_head: u64,
    pub(crate) queue_tail: u64,
}

#[near]
impl HanaSigner {
    #[init]
    pub fn new(owner: AccountId, mpc: AccountId, ckd_domain_id: u64, change_delay_ms: u64) -> Self {
        assert!(change_delay_ms <= MAX_CHANGE_DELAY_MS, "change_delay_ms must be at most 7 days");
        Self {
            owner,
            mpc,
            ckd_domain_id,
            console_audiences: vec![],
            sponsors: vec![],
            change_delay_ms,
            pending_change_delay: None,
            public_registration: false,
            issuers: LookupMap::new(StorageKey::Issuers),
            iss_index: LookupMap::new(StorageKey::IssIndex),
            scopes: LookupMap::new(StorageKey::Scopes),
            client_index: LookupMap::new(StorageKey::ClientIndex),
            removed_clients: LookupMap::new(StorageKey::RemovedClients),
            next_scope: 1,
            sessions: LookupMap::new(StorageKey::Sessions),
            session_queue: LookupMap::new(StorageKey::SessionQueue),
            queue_head: 0,
            queue_tail: 0,
        }
    }

    // ---- Config (owner only) ----

    pub fn set_owner(&mut self, owner: AccountId) {
        self.assert_owner();
        self.owner = owner;
    }

    pub fn set_sponsors(&mut self, sponsors: Vec<AccountId>) {
        self.assert_owner();
        assert!(sponsors.len() <= MAX_SPONSORS, "Too many sponsors");
        self.sponsors = sponsors;
    }

    pub fn set_console_audiences(&mut self, audiences: Vec<(String, String)>) {
        self.assert_owner();
        assert!(audiences.len() <= MAX_CONSOLE_AUDIENCES, "Too many console audiences");
        for (provider, aud) in &audiences {
            assert_provider(provider);
            assert_aud(aud);
        }
        self.console_audiences = audiences;
    }

    /// Increases apply now. A decrease applies only once the current delay has passed, so the admin can't shorten
    /// the timelock owners rely on and act faster than it promised.
    pub fn set_change_delay_ms(&mut self, change_delay_ms: u64) {
        self.assert_owner();
        assert!(change_delay_ms <= MAX_CHANGE_DELAY_MS, "change_delay_ms must be at most 7 days");
        let now = env::block_timestamp_ms();
        let current = self.change_delay_at(now);
        self.change_delay_ms = current;
        if change_delay_ms >= current {
            self.change_delay_ms = change_delay_ms;
            self.pending_change_delay = None;
        } else {
            self.pending_change_delay = Some(DelayChange { change_delay_ms, effective_at_ms: now.saturating_add(current) });
        }
    }

    /// One way: once enabled, anyone may register scopes (with client proofs) and the admin path closes for good.
    pub fn enable_public_registration(&mut self) {
        self.assert_owner();
        if !self.public_registration {
            self.public_registration = true;
            events::emit("public_registration_enabled", near_sdk::serde_json::json!({}));
        }
    }

    pub fn get_config(&self) -> ConfigView {
        let now = env::block_timestamp_ms();
        let pending = self.pending_change_delay.clone().filter(|p| now < p.effective_at_ms);
        ConfigView {
            owner: self.owner.clone(),
            mpc: self.mpc.clone(),
            ckd_domain_id: self.ckd_domain_id,
            console_audiences: self.console_audiences.clone(),
            sponsors: self.sponsors.clone(),
            change_delay_ms: self.change_delay_at(now),
            pending_change_delay: pending,
            public_registration: self.public_registration,
        }
    }
}

impl HanaSigner {
    pub(crate) fn assert_owner(&self) {
        assert!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    /// The timelock in force at `now` (a scheduled decrease counts once its time has come).
    pub(crate) fn change_delay_at(&self, now: u64) -> u64 {
        match &self.pending_change_delay {
            Some(p) if now >= p.effective_at_ms => p.change_delay_ms,
            _ => self.change_delay_ms,
        }
    }

    /// Charges the caller for storage added since `storage_before` (call after flushing the touched maps), plus
    /// `reserved_bytes` that a later free call (e.g. `execute_change`) will add on the caller's behalf.
    /// Sponsors pay nothing and get any deposit back; everyone else must attach at least the cost, excess refunded.
    pub(crate) fn charge_storage(&self, storage_before: u64, reserved_bytes: u64) {
        let added = env::storage_usage().saturating_sub(storage_before).saturating_add(reserved_bytes);
        let cost = env::storage_byte_cost().saturating_mul(u128::from(added));
        let attached = env::attached_deposit();
        let caller = env::predecessor_account_id();
        let refund = if self.sponsors.contains(&caller) {
            attached
        } else {
            assert!(attached >= cost, "Attached deposit doesn't cover storage: need {} yoctoNEAR", cost.as_yoctonear());
            attached.saturating_sub(cost)
        };
        if refund > NearToken::from_yoctonear(0) {
            Promise::new(caller).transfer(refund).detach();
        }
    }
}

// ---- Shared validation ----

pub(crate) fn valid_provider(provider: &str) -> bool {
    !provider.is_empty() && provider.len() <= 32 && provider.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub(crate) fn assert_provider(provider: &str) {
    assert!(valid_provider(provider), "Invalid provider");
}

pub(crate) fn valid_sub(sub: &str) -> bool {
    !sub.is_empty() && sub.len() <= 255 && !sub.contains('#')
}

pub(crate) fn assert_aud(aud: &str) {
    assert!(!aud.is_empty() && aud.len() <= 256, "Invalid aud");
}
