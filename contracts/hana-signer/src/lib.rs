//! Hana ID signer: turns an OIDC (Google) ID token into a session that can ask the NEAR MPC for the user's key
//! through Confidential Key Derivation (CKD), encrypted to a key only the user's browser holds.
//!
//! - `create_session` verifies the ID token on-chain (RS256 against issuer keys stored in this contract). The token's
//!   `(provider, aud)` picks a **scope** from the registry, so each partner app gets its own keys; its `nonce` commits
//!   to a browser-held Ed25519 session key. Path = `{scope_id}#{provider}#{sub}#{key_index}`.
//! - `derive_key` (signed by the session key) calls the MPC's `request_app_private_key` with that path.
//!   `create_session_and_derive` does both in one transaction (a login with a single chain round trip).
//! - The registry (`registry.rs`) maps client ids to scopes. Scope owners (NEAR accounts or OIDC identities) manage
//!   their scope; adding clients, changing owners and enabling shared login are timelocked. Hana (the `owner`)
//!   registers scopes while `public_registration` is off, and can never change a registered scope's clients or owners.
//! - Shared clients (`shared_clients`) are Hana's own login clients for partners without one: their tokens open
//!   sessions in any scope with `allow_shared`, the scope being the one the session nonce commits to. A client is
//!   never both shared and a scope client. Adding a shared client is delayed by `change_delay_ms`.
//! - Every nonce commits to `env::current_account_id()`, so tokens can't be replayed across deployments.
//! - Governance (`governance.rs`, `issuers.rs`, `docs/governance-spec.md`): an issuer key enters the active set only
//!   after `issuer_key_delay_ms` or a watchdog's confirmation; upgrades, owner transfers and surplus withdrawals wait
//!   `governance_delay_ms`; the owner or a watchdog can pause every token path, and only the owner unpauses.
//!
//! The exact JSON interface and byte layouts are in `docs/contract-interface.md`.

mod events;
mod governance;
mod init;
mod issuers;
mod migrate;
mod oidc;
mod registry;
mod sessions;
#[cfg(test)]
mod tests;

pub use governance::{
    GovernanceView, PendingOwner, PendingUpgrade, PendingUpgradeView, PendingWithdrawal, Watchdog, MAX_GOVERNANCE_DELAY_MS, MAX_ISSUER_KEY_DELAY_MS,
    MAX_UPDATER_ALLOWANCE, MAX_UPDATER_KEYS, MAX_WATCHDOGS, MIGRATE_GAS, SIGNER_RESERVE, STATE_VERSION, UPDATER_METHODS,
};
pub use issuers::{Issuer, IssuerKeyView, IssuerView, KeyChangeView, KeyOp, PendingKeyChange, RsaKey, MAX_PENDING_KEY_CHANGES};
pub use registry::{Change, Owner, OwnerAuth, PendingChange, RemovedClient, Scope};
pub use sessions::{CkdAppPublicKey, CkdRequestArgs, Session};

use near_sdk::store::LookupMap;
use near_sdk::{env, near, AccountId, BorshStorageKey, NearToken, PanicOnDefault, Promise, PublicKey};

pub const MAX_CHANGE_DELAY_MS: u64 = 7 * 24 * 60 * 60 * 1000;
const MAX_SPONSORS: usize = 10;
pub const MAX_CONSOLE_AUDIENCES: usize = 10;
pub const MAX_SHARED_CLIENTS: usize = 5;

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
pub(crate) enum StorageKey {
    Issuers,
    IssIndex,
    Scopes,
    ClientIndex,
    Sessions,
    SessionQueue,
    RemovedClients,
    PendingAdds,
}

/// A scheduled decrease of a delay (increases apply at once): of `change_delay_ms`, `issuer_key_delay_ms` or
/// `governance_delay_ms`. The field keeps its batch A name for all three (JSON compatibility): it is the new value.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct DelayChange {
    pub change_delay_ms: u64,
    pub effective_at_ms: u64,
}

/// A shared client added by `set_shared_clients`, or a console audience added by `set_console_audiences`, in force
/// from `effective_at_ms`.
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
    /// Console audiences in force now (matured pending additions included).
    pub console_audiences: Vec<(String, String)>,
    /// Console audiences not yet in force.
    pub pending_console_audiences: Vec<PendingSharedClient>,
    pub sponsors: Vec<AccountId>,
    /// Shared clients in force now (matured pending additions included).
    pub shared_clients: Vec<(String, String)>,
    /// Shared clients not yet in force.
    pub pending_shared_clients: Vec<PendingSharedClient>,
    /// The delay in force now.
    pub change_delay_ms: u64,
    pub pending_change_delay: Option<DelayChange>,
    pub public_registration: bool,
    /// The issuer-key delay in force now.
    pub issuer_key_delay_ms: u64,
    pub pending_issuer_key_delay: Option<DelayChange>,
    /// The governance delay in force now.
    pub governance_delay_ms: u64,
    pub pending_governance_delay: Option<DelayChange>,
    pub paused: bool,
}

/// Contract state, layout version 2 (`state_version`). The fields before `state_version` are the v1 layout,
/// unchanged (`migrate.rs` keeps a copy of v1 for `migrate_v1`). The next layout change ships a `migrate` that reads
/// a copy of this exact struct.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HanaSigner {
    /// Hana admin: a Sputnik DAO council outside local envs (`docs/governance-spec.md` "Owner = multisig").
    pub(crate) owner: AccountId,
    /// NEAR MPC signer (e.g. v1.signer-prod.testnet).
    pub(crate) mpc: AccountId,
    /// The MPC's CKD (BLS12-381) domain.
    pub(crate) ckd_domain_id: u64,
    /// (provider, aud) of Hana's console in force: tokens for these may authorise OIDC owner actions. Read through
    /// `console_audiences_at`, which also counts matured `pending_console_audiences`.
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

    // ---- v2 (governance batch, docs/governance-spec.md) ----
    /// Layout version, `STATE_VERSION`. `migrate` refuses any other.
    pub(crate) state_version: u32,
    /// How long a posted issuer-key change waits before anyone may execute it.
    pub(crate) issuer_key_delay_ms: u64,
    /// A decrease of `issuer_key_delay_ms`, due after `governance_delay_ms`.
    pub(crate) pending_issuer_key_delay: Option<DelayChange>,
    /// How long upgrades, owner transfers, withdrawals, delay decreases and a new watchdog's confirm power wait.
    pub(crate) governance_delay_ms: u64,
    /// A decrease of `governance_delay_ms`, due after the current governance delay.
    pub(crate) pending_governance_delay: Option<DelayChange>,
    /// ≤ `MAX_WATCHDOGS`.
    pub(crate) watchdogs: Vec<Watchdog>,
    /// Time-based activation of key changes waits at least until here (raised when a watchdog is removed).
    pub(crate) keys_slow_until_ms: u64,
    /// Pending issuer-key changes of every issuer, ≤ `MAX_PENDING_KEY_CHANGES`, in proposal order.
    pub(crate) key_changes: Vec<PendingKeyChange>,
    pub(crate) next_key_change: u64,
    /// Function-call keys the contract added on its own account (≤ `MAX_UPDATER_KEYS`).
    pub(crate) updater_keys: Vec<PublicKey>,
    /// Stops every token path, `derive_key` and the executors; never governance, revocation, cancels or views.
    pub(crate) paused: bool,
    pub(crate) pending_upgrade: Option<PendingUpgrade>,
    pub(crate) pending_owner: Option<PendingOwner>,
    pub(crate) pending_withdrawal: Option<PendingWithdrawal>,
    /// Console-audience additions waiting for `change_delay_ms`.
    pub(crate) pending_console_audiences: Vec<PendingSharedClient>,
}

#[near]
impl HanaSigner {
    // ---- Config (owner only) ----

    pub fn set_sponsors(&mut self, sponsors: Vec<AccountId>) {
        self.assert_owner();
        assert!(sponsors.len() <= MAX_SPONSORS, "Too many sponsors");
        self.sponsors = sponsors;
    }

    /// Replaces the console audiences (≤ 10). Audiences dropped from the list stop authorising OIDC owner actions at
    /// once; new ones count only after `change_delay_ms` (the delay in force now): a console audience's tokens act
    /// for OIDC owners, so a new one gets the same public window as a new shared client. Pending ones already in the
    /// list keep their `effective_at_ms`.
    pub fn set_console_audiences(&mut self, audiences: Vec<(String, String)>) {
        self.assert_owner();
        assert!(audiences.len() <= MAX_CONSOLE_AUDIENCES, "Too many console audiences");
        for (i, (provider, aud)) in audiences.iter().enumerate() {
            assert_provider(provider);
            assert_aud(aud);
            assert!(!audiences[..i].contains(&audiences[i]), "Duplicate console audience");
        }
        let now = env::block_timestamp_ms();
        self.apply_matured_config(now);
        let effective_at_ms = now.saturating_add(self.change_delay_at(now));
        self.console_audiences.retain(|a| audiences.contains(a));
        self.pending_console_audiences.retain(|p| audiences.contains(&p.client()));
        for audience in audiences {
            if !self.console_audiences.contains(&audience) && !self.pending_console_audiences.iter().any(|p| p.client() == audience) {
                self.pending_console_audiences.push(PendingSharedClient { provider: audience.0, aud: audience.1, effective_at_ms });
            }
        }
        // With a zero delay the additions are already in force.
        self.apply_matured_config(now);
        events::emit(
            "console_audiences_set",
            near_sdk::serde_json::json!({ "console_audiences": self.console_audiences, "pending_console_audiences": self.pending_console_audiences }),
        );
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

    /// Anyone: folds matured pending config (shared-client and console-audience additions, scheduled decreases of
    /// `change_delay_ms`, `issuer_key_delay_ms` and `governance_delay_ms`) into state. Optional: every read and check
    /// already treats matured entries as in force.
    pub fn apply_pending_config(&mut self) {
        self.apply_matured_config(env::block_timestamp_ms());
    }

    pub fn get_config(&self) -> ConfigView {
        let now = env::block_timestamp_ms();
        let not_yet = |p: &Option<DelayChange>| p.clone().filter(|p| now < p.effective_at_ms);
        ConfigView {
            owner: self.owner.clone(),
            mpc: self.mpc.clone(),
            ckd_domain_id: self.ckd_domain_id,
            console_audiences: self.console_audiences_at(now),
            pending_console_audiences: self.pending_console_audiences.iter().filter(|p| now < p.effective_at_ms).cloned().collect(),
            sponsors: self.sponsors.clone(),
            shared_clients: self.shared_clients_at(now),
            pending_shared_clients: self.pending_shared_clients.iter().filter(|p| now < p.effective_at_ms).cloned().collect(),
            change_delay_ms: self.change_delay_at(now),
            pending_change_delay: not_yet(&self.pending_change_delay),
            public_registration: self.public_registration,
            issuer_key_delay_ms: self.issuer_key_delay_at(now),
            pending_issuer_key_delay: not_yet(&self.pending_issuer_key_delay),
            governance_delay_ms: self.governance_delay_at(now),
            pending_governance_delay: not_yet(&self.pending_governance_delay),
            paused: self.paused,
        }
    }
}

impl HanaSigner {
    pub(crate) fn assert_owner(&self) {
        assert!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    /// The timelock in force at `now` (a scheduled decrease counts once its time has come).
    pub(crate) fn change_delay_at(&self, now: u64) -> u64 {
        delay_at(self.change_delay_ms, &self.pending_change_delay, now)
    }

    /// The issuer-key delay in force at `now`.
    pub(crate) fn issuer_key_delay_at(&self, now: u64) -> u64 {
        delay_at(self.issuer_key_delay_ms, &self.pending_issuer_key_delay, now)
    }

    /// The governance delay in force at `now`.
    pub(crate) fn governance_delay_at(&self, now: u64) -> u64 {
        delay_at(self.governance_delay_ms, &self.pending_governance_delay, now)
    }

    /// Shared clients in force at `now`: the stored list, then pending additions that have matured, in the order
    /// they matured (`effective_at_ms`, ties in the order they were added). `apply_matured_config` appends in the
    /// same order, so the result doesn't depend on whether or when anyone applied them.
    pub(crate) fn shared_clients_at(&self, now: u64) -> Vec<(String, String)> {
        in_force_at(&self.shared_clients, &self.pending_shared_clients, now)
    }

    /// Console audiences in force at `now`, in the same order rules as `shared_clients_at`.
    pub(crate) fn console_audiences_at(&self, now: u64) -> Vec<(String, String)> {
        in_force_at(&self.console_audiences, &self.pending_console_audiences, now)
    }

    /// Whether `client` is a shared client, in force or pending. Such a client can't become a scope client.
    pub(crate) fn is_shared_or_pending(&self, client: &(String, String)) -> bool {
        self.shared_clients.contains(client) || self.pending_shared_clients.iter().any(|p| p.provider == client.0 && p.aud == client.1)
    }

    /// Moves matured pending shared clients and console audiences into their lists and applies scheduled delay
    /// decreases whose time has come. Changes nothing anyone can observe through views or checks.
    pub(crate) fn apply_matured_config(&mut self, now: u64) {
        fold_matured(&mut self.shared_clients, &mut self.pending_shared_clients, now);
        fold_matured(&mut self.console_audiences, &mut self.pending_console_audiences, now);
        for (value, pending) in [
            (&mut self.change_delay_ms, &mut self.pending_change_delay),
            (&mut self.issuer_key_delay_ms, &mut self.pending_issuer_key_delay),
            (&mut self.governance_delay_ms, &mut self.pending_governance_delay),
        ] {
            if let Some(p) = pending.take_if(|p| now >= p.effective_at_ms) {
                *value = p.change_delay_ms;
            }
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

/// `value`, or the scheduled decrease once its time has come.
fn delay_at(value: u64, pending: &Option<DelayChange>, now: u64) -> u64 {
    match pending {
        Some(p) if now >= p.effective_at_ms => p.change_delay_ms,
        _ => value,
    }
}

/// `stored` followed by the entries of `pending` matured at `now`, in the order they matured (ties in insertion
/// order).
fn in_force_at(stored: &[(String, String)], pending: &[PendingSharedClient], now: u64) -> Vec<(String, String)> {
    let mut matured: Vec<&PendingSharedClient> = pending.iter().filter(|p| now >= p.effective_at_ms).collect();
    matured.sort_by_key(|p| p.effective_at_ms); // stable: ties keep insertion order
    let mut out = stored.to_vec();
    out.extend(matured.into_iter().map(PendingSharedClient::client));
    out
}

/// Moves the entries of `pending` matured at `now` to the end of `stored`, in the order `in_force_at` lists them.
fn fold_matured(stored: &mut Vec<(String, String)>, pending: &mut Vec<PendingSharedClient>, now: u64) {
    let (mut matured, rest): (Vec<_>, Vec<_>) = pending.drain(..).partition(|p| now >= p.effective_at_ms);
    matured.sort_by_key(|p| p.effective_at_ms);
    *pending = rest;
    stored.extend(matured.iter().map(PendingSharedClient::client));
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
