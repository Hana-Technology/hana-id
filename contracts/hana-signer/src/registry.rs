//! Scope registry: which client ids (token `(provider, aud)`) belong to which scope, and who owns each scope.
//!
//! Security model:
//! - While `public_registration` is false only the Hana admin registers scopes (no proofs). Once true, everyone
//!   must prove each client with a token for it whose nonce commits to the new scope's owners.
//! - After registration only the scope's owners change it. Adding a client and changing owners are timelocked
//!   (`change_delay_ms`), so other owners can cancel. Removing a client is immediate (it only hurts the owner), but
//!   the removed client is quarantined for `change_delay_ms`: until then only its old scope may take it back, so one
//!   owner can't move a client out of a shared scope into another scope faster than the timelock. A re-add the old
//!   scope proposes during the quarantine keeps the client reserved until it is executed or cancelled (its timelock
//!   ends after the quarantine does).
//! - Every successful owner action and every `execute_change` bumps the scope's `action_nonce`, which OIDC owner
//!   tokens and client proofs commit to, so a token published on-chain (even by a failed call) can't be replayed
//!   once the scope's state has moved on.
//! - A client id belongs to at most one scope: checked at registration, at propose and again at execute. A shared
//!   client (or pending shared client) never belongs to a scope, and a client with a pending `AddClient` can't
//!   become shared.
//! - A scope without clients cost nobody an OAuth client, so sponsored (contract-paid) proposals on it are capped at
//!   `MAX_SPONSORED_PENDING_WITHOUT_CLIENTS`, and registering one without a sponsor prepays that storage.
//! - An exit client (`exit.rs`), in force or pending or retired, can't join a scope (checked at registration, propose
//!   and execute), and a self-issued provider's client must be exactly `{provider}:{scope_id}`, so an issuer audience
//!   can't be claimed by a scope.
//! - `allow_shared` lets Hana's shared clients open sessions in the scope. A scope always has a client or
//!   `allow_shared`. Enabling it on an existing scope is timelocked (`Change::SetAllowShared`); disabling is immediate.
//! - Every nonce starts with borsh(current account id), binding it to this deployment.

use near_sdk::borsh;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId};

use crate::{assert_aud, assert_provider, events, oidc, valid_provider, valid_sub, HanaSigner, HanaSignerExt};

pub const GLOBAL_SCOPE: &str = "global";
pub const MAX_OWNERS: usize = 5;
pub const MAX_CLIENTS: usize = 10;
pub const MAX_PENDING: usize = 10;
/// Pending changes a sponsor may queue (for free) on a scope that has no clients of its own.
pub const MAX_SPONSORED_PENDING_WITHOUT_CLIENTS: usize = 2;
/// The largest storage one pending change can add to its scope record: id u64 ‖ Change ‖ unlock_at_ms u64, where the
/// largest Change is `SetOwners` with 5 `Oidc` owners (tag ‖ provider ≤ 32 bytes ‖ sub ≤ 255 bytes each). An
/// `AddClient` plus the client_index record it reserves is smaller (≈ 650 bytes at most).
pub const MAX_PENDING_CHANGE_BYTES: u64 = 8 + (1 + 4 + MAX_OWNERS as u64 * (1 + 4 + 32 + 4 + 255)) + 8;
/// What a non-sponsor `register_scope` without clients prepays on top of the scope itself: the storage sponsors
/// may later add to it for free.
pub const SHARED_ONLY_RESERVE_BYTES: u64 = MAX_SPONSORED_PENDING_WITHOUT_CLIENTS as u64 * MAX_PENDING_CHANGE_BYTES;

const REGISTER_DOMAIN: &[u8] = b"hana-id/register/v1";
const CLIENT_PROOF_DOMAIN: &[u8] = b"hana-id/client-proof/v1";
const OWNER_ACTION_DOMAIN: &[u8] = b"hana-id/owner-action/v1";

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Owner {
    Near { account_id: AccountId },
    Oidc { provider: String, sub: String },
}

/// How a caller proves it is an owner of a scope.
#[near(serializers = [json])]
#[derive(Clone, Debug)]
pub enum OwnerAuth {
    /// The predecessor is an `Owner::Near` of the scope.
    Near,
    /// An ID token of an `Owner::Oidc`, issued to a console audience, whose nonce commits to this exact action.
    Oidc { jwt: String },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    AddClient { provider: String, aud: String },
    SetOwners { owners: Vec<Owner> },
    /// Only `allow: true` is accepted (turning shared login off is `disable_shared_login`, immediate).
    SetAllowShared { allow: bool },
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub id: u64,
    pub change: Change,
    pub unlock_at_ms: u64,
}

/// `RemovedClient::scope_id` of a client dropped from the shared list. Contains `#`, so no scope can have this id.
pub const RETIRED_SHARED: &str = "#shared";
/// `RemovedClient::scope_id` of a client dropped from the exit list (D483). Contains `#`, so no scope can have this id.
pub const RETIRED_EXIT: &str = "#exit";

/// Where a removed client came from, and when another scope may take it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct RemovedClient {
    pub scope_id: String,
    pub free_at_ms: u64,
    /// The old scope's re-add (`AddClient` change id) proposed before `free_at_ms`. While it is still pending in that
    /// scope the client stays reserved for it, even after `free_at_ms`.
    pub reserved_by: Option<u64>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub id: String,
    pub owners: Vec<Owner>,
    /// (provider, aud) pairs, each registered in no other scope. Empty only if `allow_shared`.
    pub clients: Vec<(String, String)>,
    /// Whether tokens of a shared client may open sessions in this scope.
    pub allow_shared: bool,
    pub pending: Vec<PendingChange>,
    /// Bumped by every successful owner action and by `execute_change`; OIDC owner tokens and client proofs commit
    /// to it.
    pub action_nonce: u64,
    pub created_at_ms: u64,
}

fn base36(mut n: u64) -> String {
    const DIGITS: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut out = vec![];
    loop {
        out.push(DIGITS[(n % 36) as usize]);
        n /= 36;
        if n == 0 {
            break;
        }
    }
    out.reverse();
    String::from_utf8(out).unwrap()
}

fn b64_sha256(preimage: &[u8]) -> String {
    oidc::b64url(&env::sha256(preimage))
}

fn borsh_str(s: &str) -> Vec<u8> {
    borsh::to_vec(s).unwrap()
}

/// "hana-id/register/v1" ‖ borsh(signer) ‖ borsh(owners) ‖ borsh(clients) ‖ allow_shared u8.
pub fn register_preimage(signer: &str, owners: &[Owner], clients: &[(String, String)], allow_shared: bool) -> Vec<u8> {
    let mut preimage = REGISTER_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh::to_vec(owners).unwrap());
    preimage.extend(borsh::to_vec(clients).unwrap());
    preimage.push(u8::from(allow_shared));
    preimage
}

pub fn register_nonce(signer: &str, owners: &[Owner], clients: &[(String, String)], allow_shared: bool) -> String {
    b64_sha256(&register_preimage(signer, owners, clients, allow_shared))
}

/// "hana-id/client-proof/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ action_nonce u64 LE.
pub fn client_proof_preimage(signer: &str, scope_id: &str, action_nonce: u64) -> Vec<u8> {
    let mut preimage = CLIENT_PROOF_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend(action_nonce.to_le_bytes());
    preimage
}

pub fn client_proof_nonce(signer: &str, scope_id: &str, action_nonce: u64) -> String {
    b64_sha256(&client_proof_preimage(signer, scope_id, action_nonce))
}

/// "hana-id/owner-action/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(method) ‖ borsh(args without auth) ‖
/// action_nonce u64 LE. `args` is already the concatenated borsh of the arguments.
pub fn owner_action_preimage(signer: &str, scope_id: &str, method: &str, args: &[u8], action_nonce: u64) -> Vec<u8> {
    let mut preimage = OWNER_ACTION_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend(borsh_str(method));
    preimage.extend(args);
    preimage.extend(action_nonce.to_le_bytes());
    preimage
}

pub fn owner_action_nonce(signer: &str, scope_id: &str, method: &str, args: &[u8], action_nonce: u64) -> String {
    b64_sha256(&owner_action_preimage(signer, scope_id, method, args, action_nonce))
}

fn this_signer() -> String {
    env::current_account_id().to_string()
}

/// Borsh of each value, concatenated (= borsh of the tuple).
macro_rules! borsh_args {
    ($($arg:expr),+) => {{
        let mut out = Vec::new();
        $( out.extend(borsh::to_vec($arg).unwrap()); )+
        out
    }};
}

fn validate_owners(owners: &[Owner]) {
    assert!(!owners.is_empty() && owners.len() <= MAX_OWNERS, "A scope needs 1 to 5 owners");
    for (i, owner) in owners.iter().enumerate() {
        if let Owner::Oidc { provider, sub } = owner {
            assert!(valid_provider(provider), "Invalid provider");
            assert!(valid_sub(sub), "Invalid sub");
        }
        assert!(!owners[..i].contains(owner), "Duplicate owner");
    }
}

/// Bytes of the client_index record `execute_change(AddClient)` adds: NEAR's 40-byte per-record overhead plus the
/// key (1-byte map prefix ‖ borsh((provider, aud))) and the value (borsh(scope_id)).
fn client_index_record_bytes(client: &(String, String), scope_id: &str) -> u64 {
    let key = 1 + borsh::to_vec(client).unwrap().len();
    let value = borsh::to_vec(scope_id).unwrap().len();
    (40 + key + value) as u64
}

fn owner_json(owner: &Owner) -> near_sdk::serde_json::Value {
    near_sdk::serde_json::to_value(owner).unwrap()
}

#[near]
impl HanaSigner {
    /// Hana admin registers a scope without proofs, only while public registration is off. `scope_id` may only be
    /// `"global"` (Hana's own app); otherwise the contract assigns `sN`. `clients` may be empty if `allow_shared`.
    /// Returns the scope id.
    pub fn admin_register_scope(&mut self, owners: Vec<Owner>, clients: Vec<(String, String)>, scope_id: Option<String>, allow_shared: bool) -> String {
        self.assert_owner();
        assert!(!self.public_registration, "Admin registration is closed: public registration is enabled");
        if let Some(id) = &scope_id {
            assert!(id == GLOBAL_SCOPE, "Only \"global\" can be chosen as a scope id");
        }
        self.insert_scope(owners, clients, scope_id, allow_shared, true)
    }

    /// Anyone registers a scope once public registration is on. Each proof is a token for one of the clients, with
    /// nonce = register_nonce(signer, owners, clients in proof order, allow_shared). A shared-only scope
    /// (`allow_shared`, no proofs) needs no proof. Attach storage (excess refunded) unless the caller is a sponsor;
    /// a shared-only scope also prepays `SHARED_ONLY_RESERVE_BYTES` for the proposals sponsors may relay for it.
    #[payable]
    pub fn register_scope(&mut self, owners: Vec<Owner>, client_proofs: Vec<String>, allow_shared: bool) -> String {
        // Scope registration stops while paused, with or without proofs (D86).
        self.assert_not_paused();
        assert!(self.public_registration, "Public registration is not enabled");
        let storage_before = env::storage_usage();
        validate_owners(&owners);
        assert!(client_proofs.len() <= MAX_CLIENTS, "A scope has at most 10 clients");
        let tokens: Vec<_> = client_proofs.iter().map(|jwt| self.verify_token(jwt)).collect();
        let clients: Vec<(String, String)> = tokens.iter().map(|t| (t.provider.clone(), t.aud.clone())).collect();
        self.validate_clients(&clients, allow_shared);
        let expected = register_nonce(&this_signer(), &owners, &clients, allow_shared);
        for token in &tokens {
            assert!(token.nonce.as_deref() == Some(expected.as_str()), "Proof nonce doesn't commit to this registration");
        }
        let reserved_bytes = if clients.is_empty() { SHARED_ONLY_RESERVE_BYTES } else { 0 };
        let id = self.insert_scope(owners, clients, None, allow_shared, false);
        self.flush_registry();
        self.charge_storage(storage_before, reserved_bytes);
        id
    }

    /// A scope owner queues a change, applied by `execute_change` after the timelock. `AddClient` needs a token for
    /// that client whose nonce is client_proof_nonce(signer, scope_id, action_nonce). Returns the change id.
    /// The proposer pays for the pending entry and, for `AddClient`, also for the client_index record that
    /// `execute_change` will add (execute itself is free to call). A sponsor may queue at most
    /// `MAX_SPONSORED_PENDING_WITHOUT_CLIENTS` changes on a scope without clients.
    #[payable]
    pub fn propose_change(&mut self, scope_id: String, auth: OwnerAuth, change: Change, client_proof: Option<String>) -> u64 {
        let storage_before = env::storage_usage();
        let mut scope = self.scope_or_panic(&scope_id);
        let args = borsh_args!(&scope_id, &change, &client_proof);
        let by = self.authenticate(&scope, &auth, "propose_change", &args);
        assert!(scope.pending.len() < MAX_PENDING, "Too many pending changes");
        if scope.clients.is_empty() && self.sponsors.contains(&env::predecessor_account_id()) {
            assert!(scope.pending.len() < MAX_SPONSORED_PENDING_WITHOUT_CLIENTS, "Too many sponsored pending changes for a scope without clients");
        }
        let id = scope.action_nonce;
        let now = env::block_timestamp_ms();
        let mut reserved_bytes = 0;
        match &change {
            Change::AddClient { provider, aud } => {
                let jwt = client_proof.as_deref().unwrap_or_else(|| env::panic_str("AddClient needs a client_proof"));
                let token = self.verify_token(jwt);
                assert!(token.provider == *provider && token.aud == *aud, "Client proof is for another client");
                let expected = client_proof_nonce(&this_signer(), &scope_id, scope.action_nonce);
                assert!(token.nonce.as_deref() == Some(expected.as_str()), "Client proof nonce doesn't match");
                let client = (provider.clone(), aud.clone());
                self.assert_client_shape(&client, &scope_id);
                self.assert_client_available(&client, Some(&scope_id));
                assert!(!scope.pending.iter().any(|p| p.change == change), "Client is already pending");
                assert!(scope.clients.len() < MAX_CLIENTS, "A scope has at most 10 clients");
                reserved_bytes = client_index_record_bytes(&client, &scope_id);
                // A re-add during the quarantine reserves the client until it is executed or cancelled: its
                // timelock ends after the quarantine does, and nobody else may take the client in between.
                if let Some(mut removed) = self.removed_clients.get(&client).cloned() {
                    if removed.scope_id == scope_id && now < removed.free_at_ms {
                        removed.reserved_by = Some(id);
                        self.removed_clients.insert(client.clone(), removed);
                    }
                }
                self.track_pending_add(&client);
            }
            Change::SetOwners { owners } => {
                assert!(client_proof.is_none(), "client_proof is only for AddClient");
                validate_owners(owners);
            }
            Change::SetAllowShared { allow } => {
                assert!(client_proof.is_none(), "client_proof is only for AddClient");
                assert!(*allow, "SetAllowShared can only enable shared login; use disable_shared_login");
                assert!(!scope.allow_shared, "Shared login is already enabled");
                assert!(!scope.pending.iter().any(|p| p.change == change), "Change is already pending");
            }
        }
        // Never before the floor the last unpause set (an edge case: a delay decrease that came into force since).
        let unlock_at_ms = now.saturating_add(self.change_delay_at(now)).max(self.changes_unlock_floor_ms);
        scope.pending.push(PendingChange { id, change: change.clone(), unlock_at_ms });
        scope.action_nonce += 1;
        events::emit(
            "change_proposed",
            json!({ "scope_id": scope_id, "change_id": id, "change": change, "unlock_at_ms": unlock_at_ms, "by": owner_json(&by) }),
        );
        self.scopes.insert(scope_id, scope);
        self.flush_registry();
        self.charge_storage(storage_before, reserved_bytes);
        id
    }

    /// Anyone applies a pending change once its timelock has passed. Uniqueness and limits are re-checked.
    /// Increments `action_nonce`: the scope's state changed, so owner tokens and client proofs made before (including
    /// ones published by calls that failed on the old state) go stale.
    /// Not while paused: a change that may rest on a forged token (a client proof, an OIDC owner's token) never
    /// matures into force while frozen. Nor before `changes_unlock_floor_ms`: after an unpause every pending change
    /// waits a full `change_delay_ms` again, since OIDC owners couldn't cancel it while paused.
    pub fn execute_change(&mut self, scope_id: String, change_id: u64) {
        self.assert_not_paused();
        let mut scope = self.scope_or_panic(&scope_id);
        let index = scope.pending.iter().position(|p| p.id == change_id).unwrap_or_else(|| env::panic_str("No such change"));
        let now = env::block_timestamp_ms();
        assert!(now >= scope.pending[index].unlock_at_ms && now >= self.changes_unlock_floor_ms, "Change is still timelocked");
        let pending = scope.pending.remove(index);
        match &pending.change {
            Change::AddClient { provider, aud } => {
                let client = (provider.clone(), aud.clone());
                self.assert_client_shape(&client, &scope_id);
                self.assert_client_available(&client, Some(&scope_id));
                assert!(scope.clients.len() < MAX_CLIENTS, "A scope has at most 10 clients");
                self.untrack_pending_add(&client);
                self.claim_client(&client, &scope_id);
                scope.clients.push(client);
            }
            Change::SetOwners { owners } => {
                validate_owners(owners);
                scope.owners = owners.clone();
            }
            Change::SetAllowShared { allow } => {
                // propose_change only queues allow = true; keep the scope invariant regardless.
                assert!(*allow || !scope.clients.is_empty(), "A scope needs a client or shared login");
                scope.allow_shared = *allow;
            }
        }
        scope.action_nonce += 1;
        events::emit("change_executed", json!({ "scope_id": scope_id, "change_id": change_id, "change": pending.change }));
        self.scopes.insert(scope_id, scope);
    }

    /// A scope owner cancels any pending change.
    pub fn cancel_change(&mut self, scope_id: String, auth: OwnerAuth, change_id: u64) {
        let mut scope = self.scope_or_panic(&scope_id);
        let by = self.authenticate(&scope, &auth, "cancel_change", &borsh_args!(&scope_id, &change_id));
        let index = scope.pending.iter().position(|p| p.id == change_id).unwrap_or_else(|| env::panic_str("No such change"));
        let cancelled = scope.pending.remove(index);
        if let Change::AddClient { provider, aud } = cancelled.change {
            self.untrack_pending_add(&(provider, aud));
        }
        scope.action_nonce += 1;
        events::emit("change_cancelled", json!({ "scope_id": scope_id, "change_id": change_id, "by": owner_json(&by) }));
        self.scopes.insert(scope_id, scope);
    }

    /// A scope owner removes one of its clients at once. The last client can be removed only from a scope with
    /// shared login. The client is then quarantined for `change_delay_ms`: only this scope may take it back until
    /// then, so co-owners can see the removal and re-add it before anyone moves it into another scope (a re-add
    /// proposed during the quarantine keeps it reserved until executed or cancelled).
    pub fn remove_client(&mut self, scope_id: String, auth: OwnerAuth, provider: String, aud: String) {
        let mut scope = self.scope_or_panic(&scope_id);
        let by = self.authenticate(&scope, &auth, "remove_client", &borsh_args!(&scope_id, &provider, &aud));
        let client = (provider, aud);
        let index = scope.clients.iter().position(|c| *c == client).unwrap_or_else(|| env::panic_str("Client is not in this scope"));
        assert!(scope.clients.len() > 1 || scope.allow_shared, "Cannot remove the last client of a scope without shared login");
        scope.clients.remove(index);
        self.client_index.remove(&client);
        let now = env::block_timestamp_ms();
        let free_at_ms = now.saturating_add(self.change_delay_at(now));
        self.removed_clients.insert(client.clone(), RemovedClient { scope_id: scope_id.clone(), free_at_ms, reserved_by: None });
        scope.action_nonce += 1;
        events::emit(
            "client_removed",
            json!({ "scope_id": scope_id, "provider": client.0, "aud": client.1, "free_at_ms": free_at_ms, "by": owner_json(&by) }),
        );
        self.scopes.insert(scope_id, scope);
    }

    /// A scope owner turns shared login off at once. The scope must keep at least one client of its own.
    pub fn disable_shared_login(&mut self, scope_id: String, auth: OwnerAuth) {
        let mut scope = self.scope_or_panic(&scope_id);
        let by = self.authenticate(&scope, &auth, "disable_shared_login", &borsh_args!(&scope_id));
        assert!(scope.allow_shared, "Shared login is not enabled");
        assert!(!scope.clients.is_empty(), "Cannot disable shared login: the scope has no clients");
        scope.allow_shared = false;
        scope.action_nonce += 1;
        events::emit("shared_login_disabled", json!({ "scope_id": scope_id, "by": owner_json(&by) }));
        self.scopes.insert(scope_id, scope);
    }

    /// Each pending change's `unlock_at_ms` is when `execute_change` accepts it: its own timelock, or the floor the
    /// last unpause set if that is later.
    pub fn get_scope(&self, scope_id: String) -> Option<Scope> {
        self.scopes.get(&scope_id).cloned().map(|mut scope| {
            for p in &mut scope.pending {
                p.unlock_at_ms = p.unlock_at_ms.max(self.changes_unlock_floor_ms);
            }
            scope
        })
    }

    pub fn scope_for_client(&self, provider: String, aud: String) -> Option<String> {
        self.client_index.get(&(provider, aud)).cloned()
    }
}

impl HanaSigner {
    fn scope_or_panic(&self, scope_id: &str) -> Scope {
        self.scopes.get(scope_id).cloned().unwrap_or_else(|| env::panic_str("No such scope"))
    }

    pub(crate) fn flush_registry(&mut self) {
        self.scopes.flush();
        self.client_index.flush();
        self.removed_clients.flush();
        self.pending_adds.flush();
    }

    /// Panics unless `client` may join `scope_id` (`None` = a new scope): it must not be registered anywhere, must
    /// not be a shared (or pending shared) or exit (or pending exit) client, and must not be quarantined for another
    /// scope or retired.
    fn assert_client_available(&self, client: &(String, String), scope_id: Option<&str>) {
        assert!(!self.client_index.contains_key(client), "Client is already registered");
        assert!(!self.is_shared_or_pending(client), "Client is a shared client");
        assert!(!self.is_exit_or_pending(client), "Client is an exit client");
        self.assert_not_quarantined(client, scope_id);
    }

    /// Panics unless a self-issued provider's client is exactly `{provider}:{scope_id}`. Hana's issuer can mint a token
    /// for any audience, so an audience of another form (`("email", "hana-home")`, Home's) must never become a scope
    /// client, or that scope would capture it (a client proof checks only provider, audience and nonce). Checks the
    /// name, not `self_issued`: true even before the provider is marked self-issued.
    fn assert_client_shape(&self, client: &(String, String), scope_id: &str) {
        if crate::self_issued::SELF_ISSUABLE.contains(&client.0.as_str()) {
            assert!(client.1 == format!("{}:{scope_id}", client.0), "A self-issued client must be its provider and scope");
        }
    }

    /// Panics if `client` was removed from a scope other than `scope_id` (`None` = no scope, e.g. a new scope or the
    /// shared list) and is still quarantined: before its `free_at_ms`, or while the old scope's re-add proposed during
    /// the quarantine (`reserved_by`) is still pending.
    pub(crate) fn assert_not_quarantined(&self, client: &(String, String), scope_id: Option<&str>) {
        let Some(removed) = self.removed_clients.get(client) else { return };
        if scope_id == Some(removed.scope_id.as_str()) {
            return;
        }
        assert!(removed.scope_id != RETIRED_SHARED, "Client was a shared client and is retired");
        assert!(removed.scope_id != RETIRED_EXIT, "Client was an exit client and is retired");
        let reserved = removed.reserved_by.is_some_and(|id| self.scopes.get(&removed.scope_id).is_some_and(|s| s.pending.iter().any(|p| p.id == id)));
        assert!(env::block_timestamp_ms() >= removed.free_at_ms && !reserved, "Client was recently removed from another scope");
    }

    /// Counts a pending `AddClient` for `client` (in any scope).
    fn track_pending_add(&mut self, client: &(String, String)) {
        let count = self.pending_adds.get(client).copied().unwrap_or(0);
        self.pending_adds.insert(client.clone(), count + 1);
    }

    /// Forgets one pending `AddClient` for `client` (executed or cancelled).
    fn untrack_pending_add(&mut self, client: &(String, String)) {
        match self.pending_adds.get(client).copied() {
            Some(count) if count > 1 => {
                self.pending_adds.insert(client.clone(), count - 1);
            }
            Some(_) => {
                self.pending_adds.remove(client);
            }
            None => {}
        }
    }

    /// Client list of a new scope: ≤ 10, at least one unless `allow_shared`, each valid, unique and available.
    fn validate_clients(&self, clients: &[(String, String)], allow_shared: bool) {
        assert!(clients.len() <= MAX_CLIENTS, "A scope has at most 10 clients");
        assert!(!clients.is_empty() || allow_shared, "A scope needs a client or shared login");
        for (i, client) in clients.iter().enumerate() {
            assert_provider(&client.0);
            assert_aud(&client.1);
            assert!(self.has_issuer(&client.0), "Unknown issuer");
            assert!(!clients[..i].contains(client), "Duplicate client");
            self.assert_client_available(client, None);
        }
    }

    /// Maps `client` to `scope_id` and drops any quarantine record for it.
    fn claim_client(&mut self, client: &(String, String), scope_id: &str) {
        self.client_index.insert(client.clone(), scope_id.to_string());
        self.removed_clients.remove(client);
    }

    /// The scope a session token may open a session in, given the scope the caller asks for:
    /// a scope client only in its own scope; a shared client (in force now) in any existing scope with
    /// `allow_shared`; anything else nowhere.
    pub(crate) fn session_scope(&self, provider: &str, aud: &str, scope_id: &str) -> String {
        let client = (provider.to_string(), aud.to_string());
        if let Some(registered) = self.client_index.get(&client) {
            assert!(registered == scope_id, "Token is for another app");
            return registered.clone();
        }
        if self.shared_clients_at(env::block_timestamp_ms()).contains(&client) {
            let scope = self.scopes.get(scope_id).unwrap_or_else(|| env::panic_str("No such scope"));
            assert!(scope.allow_shared, "Scope does not allow shared login");
            return scope.id.clone();
        }
        env::panic_str("Token is for an unregistered app")
    }

    /// Checks `auth` against the scope's owners and returns the owner it proved. The caller bumps `action_nonce`.
    fn authenticate(&self, scope: &Scope, auth: &OwnerAuth, method: &str, args: &[u8]) -> Owner {
        match auth {
            OwnerAuth::Near => {
                let caller = Owner::Near { account_id: env::predecessor_account_id() };
                assert!(scope.owners.contains(&caller), "Caller is not a NEAR owner of this scope");
                caller
            }
            OwnerAuth::Oidc { jwt } => {
                let token = self.verify_token(jwt);
                // Console audiences in force now: an addition counts only after change_delay_ms.
                let console = self.console_audiences_at(env::block_timestamp_ms());
                assert!(console.contains(&(token.provider.clone(), token.aud.clone())), "Token is not for the Hana console");
                let owner = Owner::Oidc { provider: token.provider, sub: token.sub };
                assert!(scope.owners.contains(&owner), "Token is not from an owner of this scope");
                let expected = owner_action_nonce(&this_signer(), &scope.id, method, args, scope.action_nonce);
                assert!(token.nonce.as_deref() == Some(expected.as_str()), "Owner token nonce doesn't match this action");
                owner
            }
        }
    }

    fn insert_scope(&mut self, owners: Vec<Owner>, clients: Vec<(String, String)>, chosen_id: Option<String>, allow_shared: bool, admin: bool) -> String {
        validate_owners(&owners);
        self.validate_clients(&clients, allow_shared);
        let id = match chosen_id {
            Some(id) => id,
            None => {
                let id = format!("s{}", base36(self.next_scope));
                self.next_scope += 1;
                id
            }
        };
        assert!(!self.scopes.contains_key(&id), "Scope already exists");
        for client in &clients {
            self.assert_client_shape(client, &id);
            self.claim_client(client, &id);
        }
        events::emit(
            "scope_registered",
            json!({ "scope_id": id, "owners": owners, "clients": clients, "allow_shared": allow_shared, "by": env::predecessor_account_id(), "admin": admin }),
        );
        let scope = Scope { id: id.clone(), owners, clients, allow_shared, pending: vec![], action_nonce: 0, created_at_ms: env::block_timestamp_ms() };
        self.scopes.insert(id.clone(), scope);
        id
    }
}

#[cfg(test)]
mod unit {
    use super::base36;

    #[test]
    fn base36_ids() {
        assert_eq!(base36(1), "1");
        assert_eq!(base36(10), "a");
        assert_eq!(base36(35), "z");
        assert_eq!(base36(36), "10");
        assert_eq!(base36(36 * 36 + 1), "101");
    }
}
