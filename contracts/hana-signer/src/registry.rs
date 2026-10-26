//! Scope registry: which client ids (token `(provider, aud)`) belong to which scope, and who owns each scope.
//!
//! Security model:
//! - While `public_registration` is false only the Hana admin registers scopes (no proofs). Once true, everyone
//!   must prove each client with a token for it whose nonce commits to the new scope's owners.
//! - After registration only the scope's owners change it. Adding a client and changing owners are timelocked
//!   (`change_delay_ms`), so other owners can cancel. Removing a client is immediate (it only hurts the owner), but
//!   the removed client is quarantined for `change_delay_ms`: until then only its old scope may take it back, so one
//!   owner can't move a client out of a shared scope into another scope faster than the timelock.
//! - Every successful owner action bumps the scope's `action_nonce`, which OIDC owner tokens and client proofs commit
//!   to, so a token published on-chain can't be replayed.
//! - A client id belongs to at most one scope: checked at registration, at propose and again at execute.

use near_sdk::borsh;
use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId};

use crate::{assert_aud, assert_provider, events, oidc, valid_provider, valid_sub, HanaSigner, HanaSignerExt};

pub const GLOBAL_SCOPE: &str = "global";
pub const MAX_OWNERS: usize = 5;
pub const MAX_CLIENTS: usize = 10;
pub const MAX_PENDING: usize = 10;

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
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingChange {
    pub id: u64,
    pub change: Change,
    pub unlock_at_ms: u64,
}

/// Where a removed client came from, and when another scope may take it.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct RemovedClient {
    pub scope_id: String,
    pub free_at_ms: u64,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Scope {
    pub id: String,
    pub owners: Vec<Owner>,
    /// (provider, aud) pairs, each registered in no other scope.
    pub clients: Vec<(String, String)>,
    pub pending: Vec<PendingChange>,
    /// Bumped by every successful owner action; OIDC owner tokens and client proofs commit to it.
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

/// nonce = b64url(sha256("hana-id/register/v1" ‖ borsh(owners))).
pub fn register_nonce(owners: &[Owner]) -> String {
    let mut preimage = REGISTER_DOMAIN.to_vec();
    preimage.extend(borsh::to_vec(&owners.to_vec()).unwrap());
    b64_sha256(&preimage)
}

/// nonce = b64url(sha256("hana-id/client-proof/v1" ‖ scope_id ‖ action_nonce u64 LE)).
pub fn client_proof_nonce(scope_id: &str, action_nonce: u64) -> String {
    let mut preimage = CLIENT_PROOF_DOMAIN.to_vec();
    preimage.extend(scope_id.as_bytes());
    preimage.extend(action_nonce.to_le_bytes());
    b64_sha256(&preimage)
}

/// nonce = b64url(sha256("hana-id/owner-action/v1" ‖ scope_id ‖ method ‖ borsh(args without auth) ‖ action_nonce u64 LE)).
pub fn owner_action_nonce(scope_id: &str, method: &str, args: &[u8], action_nonce: u64) -> String {
    let mut preimage = OWNER_ACTION_DOMAIN.to_vec();
    preimage.extend(scope_id.as_bytes());
    preimage.extend(method.as_bytes());
    preimage.extend(args);
    preimage.extend(action_nonce.to_le_bytes());
    b64_sha256(&preimage)
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
    /// `"global"` (Hana's own app); otherwise the contract assigns `sN`. Returns the scope id.
    pub fn admin_register_scope(&mut self, owners: Vec<Owner>, clients: Vec<(String, String)>, scope_id: Option<String>) -> String {
        self.assert_owner();
        assert!(!self.public_registration, "Admin registration is closed: public registration is enabled");
        if let Some(id) = &scope_id {
            assert!(id == GLOBAL_SCOPE, "Only \"global\" can be chosen as a scope id");
        }
        self.insert_scope(owners, clients, scope_id, true)
    }

    /// Anyone registers a scope once public registration is on. Each proof is a token for one of the clients, with
    /// nonce = register_nonce(owners). Attach storage (excess refunded) unless the caller is a sponsor.
    #[payable]
    pub fn register_scope(&mut self, owners: Vec<Owner>, client_proofs: Vec<String>) -> String {
        assert!(self.public_registration, "Public registration is not enabled");
        let storage_before = env::storage_usage();
        validate_owners(&owners);
        assert!(!client_proofs.is_empty() && client_proofs.len() <= MAX_CLIENTS, "A scope needs 1 to 10 clients");
        let expected = register_nonce(&owners);
        let clients = client_proofs
            .iter()
            .map(|jwt| {
                let token = self.verify_token(jwt);
                assert!(token.nonce.as_deref() == Some(expected.as_str()), "Proof nonce doesn't commit to these owners");
                (token.provider, token.aud)
            })
            .collect();
        let id = self.insert_scope(owners, clients, None, false);
        self.flush_registry();
        self.charge_storage(storage_before, 0);
        id
    }

    /// A scope owner queues a change, applied by `execute_change` after the timelock. `AddClient` needs a token for
    /// that client whose nonce is client_proof_nonce(scope_id, action_nonce). Returns the change id.
    /// The proposer pays for the pending entry and, for `AddClient`, also for the client_index record that
    /// `execute_change` will add (execute itself is free to call).
    #[payable]
    pub fn propose_change(&mut self, scope_id: String, auth: OwnerAuth, change: Change, client_proof: Option<String>) -> u64 {
        let storage_before = env::storage_usage();
        let mut scope = self.scope_or_panic(&scope_id);
        let args = borsh_args!(&scope_id, &change, &client_proof);
        let by = self.authenticate(&scope, &auth, "propose_change", &args);
        assert!(scope.pending.len() < MAX_PENDING, "Too many pending changes");
        let mut reserved_bytes = 0;
        match &change {
            Change::AddClient { provider, aud } => {
                let jwt = client_proof.as_deref().unwrap_or_else(|| env::panic_str("AddClient needs a client_proof"));
                let token = self.verify_token(jwt);
                assert!(token.provider == *provider && token.aud == *aud, "Client proof is for another client");
                let expected = client_proof_nonce(&scope_id, scope.action_nonce);
                assert!(token.nonce.as_deref() == Some(expected.as_str()), "Client proof nonce doesn't match");
                let client = (provider.clone(), aud.clone());
                self.assert_client_available(&client, Some(&scope_id));
                assert!(!scope.pending.iter().any(|p| p.change == change), "Client is already pending");
                assert!(scope.clients.len() < MAX_CLIENTS, "A scope needs 1 to 10 clients");
                reserved_bytes = client_index_record_bytes(&client, &scope_id);
            }
            Change::SetOwners { owners } => {
                assert!(client_proof.is_none(), "client_proof is only for AddClient");
                validate_owners(owners);
            }
        }
        let id = scope.action_nonce;
        let unlock_at_ms = env::block_timestamp_ms().saturating_add(self.change_delay_at(env::block_timestamp_ms()));
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
    pub fn execute_change(&mut self, scope_id: String, change_id: u64) {
        let mut scope = self.scope_or_panic(&scope_id);
        let index = scope.pending.iter().position(|p| p.id == change_id).unwrap_or_else(|| env::panic_str("No such change"));
        assert!(env::block_timestamp_ms() >= scope.pending[index].unlock_at_ms, "Change is still timelocked");
        let pending = scope.pending.remove(index);
        match &pending.change {
            Change::AddClient { provider, aud } => {
                let client = (provider.clone(), aud.clone());
                self.assert_client_available(&client, Some(&scope_id));
                assert!(scope.clients.len() < MAX_CLIENTS, "A scope needs 1 to 10 clients");
                self.claim_client(&client, &scope_id);
                scope.clients.push(client);
            }
            Change::SetOwners { owners } => {
                validate_owners(owners);
                scope.owners = owners.clone();
            }
        }
        events::emit("change_executed", json!({ "scope_id": scope_id, "change_id": change_id, "change": pending.change }));
        self.scopes.insert(scope_id, scope);
    }

    /// A scope owner cancels any pending change.
    pub fn cancel_change(&mut self, scope_id: String, auth: OwnerAuth, change_id: u64) {
        let mut scope = self.scope_or_panic(&scope_id);
        let by = self.authenticate(&scope, &auth, "cancel_change", &borsh_args!(&scope_id, &change_id));
        let index = scope.pending.iter().position(|p| p.id == change_id).unwrap_or_else(|| env::panic_str("No such change"));
        scope.pending.remove(index);
        scope.action_nonce += 1;
        events::emit("change_cancelled", json!({ "scope_id": scope_id, "change_id": change_id, "by": owner_json(&by) }));
        self.scopes.insert(scope_id, scope);
    }

    /// A scope owner removes one of its clients at once. The last client can't be removed. The client is then
    /// quarantined for `change_delay_ms`: only this scope may take it back until then, so co-owners can see the
    /// removal and re-add it before anyone moves it into another scope.
    pub fn remove_client(&mut self, scope_id: String, auth: OwnerAuth, provider: String, aud: String) {
        let mut scope = self.scope_or_panic(&scope_id);
        let by = self.authenticate(&scope, &auth, "remove_client", &borsh_args!(&scope_id, &provider, &aud));
        let client = (provider, aud);
        let index = scope.clients.iter().position(|c| *c == client).unwrap_or_else(|| env::panic_str("Client is not in this scope"));
        assert!(scope.clients.len() > 1, "Cannot remove the last client");
        scope.clients.remove(index);
        self.client_index.remove(&client);
        let now = env::block_timestamp_ms();
        let free_at_ms = now.saturating_add(self.change_delay_at(now));
        self.removed_clients.insert(client.clone(), RemovedClient { scope_id: scope_id.clone(), free_at_ms });
        scope.action_nonce += 1;
        events::emit(
            "client_removed",
            json!({ "scope_id": scope_id, "provider": client.0, "aud": client.1, "free_at_ms": free_at_ms, "by": owner_json(&by) }),
        );
        self.scopes.insert(scope_id, scope);
    }

    pub fn get_scope(&self, scope_id: String) -> Option<Scope> {
        self.scopes.get(&scope_id).cloned()
    }

    pub fn scope_for_client(&self, provider: String, aud: String) -> Option<String> {
        self.client_index.get(&(provider, aud)).cloned()
    }
}

impl HanaSigner {
    fn scope_or_panic(&self, scope_id: &str) -> Scope {
        self.scopes.get(scope_id).cloned().unwrap_or_else(|| env::panic_str("No such scope"))
    }

    fn flush_registry(&mut self) {
        self.scopes.flush();
        self.client_index.flush();
        self.removed_clients.flush();
    }

    /// Panics unless `client` may join `scope_id` (`None` = a new scope): it must not be registered anywhere, and a
    /// client removed from another scope stays quarantined until its `free_at_ms`.
    fn assert_client_available(&self, client: &(String, String), scope_id: Option<&str>) {
        assert!(!self.client_index.contains_key(client), "Client is already registered");
        if let Some(removed) = self.removed_clients.get(client) {
            let same_scope = scope_id == Some(removed.scope_id.as_str());
            assert!(same_scope || env::block_timestamp_ms() >= removed.free_at_ms, "Client was recently removed from another scope");
        }
    }

    /// Maps `client` to `scope_id` and drops any quarantine record for it.
    fn claim_client(&mut self, client: &(String, String), scope_id: &str) {
        self.client_index.insert(client.clone(), scope_id.to_string());
        self.removed_clients.remove(client);
    }

    pub(crate) fn scope_id_for(&self, provider: &str, aud: &str) -> Option<String> {
        self.client_index.get(&(provider.to_string(), aud.to_string())).cloned()
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
                assert!(self.console_audiences.contains(&(token.provider.clone(), token.aud.clone())), "Token is not for the Hana console");
                let owner = Owner::Oidc { provider: token.provider, sub: token.sub };
                assert!(scope.owners.contains(&owner), "Token is not from an owner of this scope");
                let expected = owner_action_nonce(&scope.id, method, args, scope.action_nonce);
                assert!(token.nonce.as_deref() == Some(expected.as_str()), "Owner token nonce doesn't match this action");
                owner
            }
        }
    }

    fn insert_scope(&mut self, owners: Vec<Owner>, clients: Vec<(String, String)>, chosen_id: Option<String>, admin: bool) -> String {
        validate_owners(&owners);
        assert!(!clients.is_empty() && clients.len() <= MAX_CLIENTS, "A scope needs 1 to 10 clients");
        for (i, client) in clients.iter().enumerate() {
            assert_provider(&client.0);
            assert_aud(&client.1);
            assert!(self.has_issuer(&client.0), "Unknown issuer");
            assert!(!clients[..i].contains(client), "Duplicate client");
            self.assert_client_available(client, None);
        }
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
            self.claim_client(client, &id);
        }
        events::emit(
            "scope_registered",
            json!({ "scope_id": id, "owners": owners, "clients": clients, "by": env::predecessor_account_id(), "admin": admin }),
        );
        let scope = Scope { id: id.clone(), owners, clients, pending: vec![], action_nonce: 0, created_at_ms: env::block_timestamp_ms() };
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
