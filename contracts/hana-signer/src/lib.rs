//! Hana ID signer: turns an OIDC (Google) ID token into a session that can ask the NEAR MPC for the user's key
//! through Confidential Key Derivation (CKD), encrypted to a key only the user's browser holds.
//!
//! - `create_session` verifies the ID token on-chain (RS256 against issuer keys stored in this contract). The token's
//!   `(provider, aud)` picks a **scope** from the registry, so each partner app gets its own keys; its `nonce` commits
//!   to a browser-held Ed25519 session key. Path = `{scope_id}#{provider}#{sub}#{key_index}`.
//! - `derive_key` (signed by the session key) calls the MPC's `request_app_private_key` with that path.
//! - The registry (`registry.rs`) maps client ids to scopes. Scope owners (NEAR accounts or OIDC identities) manage
//!   their scope; adding clients, changing owners and enabling shared login are timelocked. Hana (the `owner`)
//!   registers scopes while `public_registration` is off, and can never change a registered scope's clients or owners.
//! - Shared clients (`shared_clients`) are Hana's own login clients for partners without one: their tokens open
//!   sessions in any scope with `allow_shared`, the scope being the one the session nonce commits to. A client is
//!   never both shared and a scope client. Adding a shared client is delayed by `change_delay_ms`.
//! - Every nonce commits to `env::current_account_id()`, so tokens can't be replayed across deployments.
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
pub const MAX_SHARED_CLIENTS: usize = 5;

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
    PendingAdds,
}

/// A scheduled decrease of `change_delay_ms` (increases apply at once).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DelayChange {
    pub change_delay_ms: u64,
    pub effective_at_ms: u64,
}

/// A shared client added by `set_shared_clients`, in force from `effective_at_ms`.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingSharedClient {
    pub provider: String,
    pub aud: String,
    pub effective_at_ms: u64,
}

impl PendingSharedClient {
    fn client(&self) -> (String, String) {
        (self.provider.clone(), self.aud.clone())
    }
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct ConfigView {
    pub owner: AccountId,
    pub mpc: AccountId,
    pub ckd_domain_id: u64,
    pub console_audiences: Vec<(String, String)>,
    pub sponsors: Vec<AccountId>,
    /// Shared clients in force now (matured pending additions included).
    pub shared_clients: Vec<(String, String)>,
    /// Shared clients not yet in force.
    pub pending_shared_clients: Vec<PendingSharedClient>,
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
    /// (provider, aud) of Hana's shared login clients in force. Read through `shared_clients_at`, which also counts
    /// matured `pending_shared_clients` (folded in by `set_shared_clients` / `apply_pending_config`).
    pub(crate) shared_clients: Vec<(String, String)>,
    /// Shared-client additions waiting for `change_delay_ms`.
    pub(crate) pending_shared_clients: Vec<PendingSharedClient>,
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
    /// (provider, aud) → how many scopes have a pending `AddClient` for it. Such a client can't be made shared.
    pub(crate) pending_adds: LookupMap<(String, String), u32>,
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

    /// Replaces Hana's shared login clients (≤ 5). Clients dropped from the list stop working at once; new ones
    /// take effect after `change_delay_ms`, so owners of a scope that has its own client can see them coming and
    /// disable shared login first. A shared-only scope (no clients) can't opt out in time: turning shared login off
    /// needs a client of its own, whose `AddClient` is timelocked by the same delay, so such a scope trusts every
    /// shared client Hana adds. A client can never be both shared and registered to a scope, and a client that a
    /// scope has a pending `AddClient` for (or that is quarantined after a `remove_client`) can't be made shared.
    /// A client dropped from the shared list is retired: it may return to the shared list but never join a scope.
    pub fn set_shared_clients(&mut self, clients: Vec<(String, String)>) {
        self.assert_owner();
        assert!(clients.len() <= MAX_SHARED_CLIENTS, "Too many shared clients");
        let now = env::block_timestamp_ms();
        self.apply_matured_config(now);
        for (i, client) in clients.iter().enumerate() {
            assert_provider(&client.0);
            assert_aud(&client.1);
            assert!(self.has_issuer(&client.0), "Unknown issuer");
            assert!(!clients[..i].contains(client), "Duplicate shared client");
            assert!(!self.client_index.contains_key(client), "Client is already registered");
            // A retired shared client may come back to the shared list (it was Hana's); anything else quarantined may not.
            if self.removed_clients.get(client).is_none_or(|r| r.scope_id != registry::RETIRED_SHARED) {
                self.assert_not_quarantined(client, None);
            }
            assert!(!self.pending_adds.contains_key(client), "Client is pending in a scope");
        }
        let effective_at_ms = now.saturating_add(self.change_delay_at(now));
        // Dropped shared clients (in force or pending) are retired for good: no scope may ever claim them, since
        // anyone able to load Hana's login page could mint tokens for them with a nonce of their choosing.
        let dropped: Vec<(String, String)> = self
            .shared_clients
            .iter()
            .cloned()
            .chain(self.pending_shared_clients.iter().map(|p| p.client()))
            .filter(|c| !clients.contains(c))
            .collect();
        for client in dropped {
            self.removed_clients.insert(
                client,
                registry::RemovedClient { scope_id: registry::RETIRED_SHARED.to_string(), free_at_ms: u64::MAX, reserved_by: None },
            );
        }
        for client in &clients {
            if self.removed_clients.get(client).is_some_and(|r| r.scope_id == registry::RETIRED_SHARED) {
                self.removed_clients.remove(client);
            }
        }
        self.shared_clients.retain(|c| clients.contains(c));
        self.pending_shared_clients.retain(|p| clients.contains(&p.client()));
        for client in clients {
            if !self.shared_clients.contains(&client) && !self.pending_shared_clients.iter().any(|p| p.client() == client) {
                self.pending_shared_clients.push(PendingSharedClient { provider: client.0, aud: client.1, effective_at_ms });
            }
        }
        // With a zero delay the additions are already in force.
        self.apply_matured_config(now);
        events::emit(
            "shared_clients_set",
            near_sdk::serde_json::json!({ "shared_clients": self.shared_clients, "pending_shared_clients": self.pending_shared_clients }),
        );
    }

    /// Anyone: folds matured pending config (shared-client additions, a scheduled `change_delay_ms` decrease) into
    /// state. Optional: every read and check already treats matured entries as in force.
    pub fn apply_pending_config(&mut self) {
        self.apply_matured_config(env::block_timestamp_ms());
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
            shared_clients: self.shared_clients_at(now),
            pending_shared_clients: self.pending_shared_clients.iter().filter(|p| now < p.effective_at_ms).cloned().collect(),
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

    /// Shared clients in force at `now`: the stored list, then pending additions that have matured, in the order
    /// they matured (`effective_at_ms`, ties in the order they were added). `apply_matured_config` appends in the
    /// same order, so the result doesn't depend on whether or when anyone applied them.
    pub(crate) fn shared_clients_at(&self, now: u64) -> Vec<(String, String)> {
        let mut matured: Vec<&PendingSharedClient> = self.pending_shared_clients.iter().filter(|p| now >= p.effective_at_ms).collect();
        matured.sort_by_key(|p| p.effective_at_ms); // stable: ties keep insertion order
        let mut clients = self.shared_clients.clone();
        clients.extend(matured.into_iter().map(PendingSharedClient::client));
        clients
    }

    /// Whether `client` is a shared client, in force or pending. Such a client can't become a scope client.
    pub(crate) fn is_shared_or_pending(&self, client: &(String, String)) -> bool {
        self.shared_clients.contains(client) || self.pending_shared_clients.iter().any(|p| p.provider == client.0 && p.aud == client.1)
    }

    /// Moves matured pending shared clients into `shared_clients` and applies a scheduled delay decrease whose time
    /// has come. Changes nothing anyone can observe through views or checks.
    pub(crate) fn apply_matured_config(&mut self, now: u64) {
        let (mut matured, pending): (Vec<_>, Vec<_>) = self.pending_shared_clients.drain(..).partition(|p| now >= p.effective_at_ms);
        matured.sort_by_key(|p| p.effective_at_ms); // same order as shared_clients_at
        self.pending_shared_clients = pending;
        self.shared_clients.extend(matured.iter().map(PendingSharedClient::client));
        if self.pending_change_delay.as_ref().is_some_and(|p| now >= p.effective_at_ms) {
            self.change_delay_ms = self.change_delay_at(now);
            self.pending_change_delay = None;
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
