//! OIDC issuers (Google, and the self-issued email issuer): their `iss` values and signing keys, and token
//! verification against them.
//!
//! Issuer keys change only through a public, cancellable delay (`docs/governance-spec.md` "Issuer key changes"):
//! the owner or the contract account ("self", the API's updater key) proposes an addition or removal; it enters the
//! active set when anyone executes it after `issuer_key_delay_ms`, or earlier when a watchdog that checked it
//! against the issuer's published JWKS confirms it. The owner or any watchdog cancels. Only the owner removes a key
//! at once (`remove_issuer_key`). `verify_token` reads active keys only.
//!
//! A self-issued issuer (`self_issued.rs`) is stricter: only the owner proposes its key changes, each names the key's
//! signer, waits at least `governance_delay_ms` and can't be confirmed early; its tokens are JWS JSON checked against
//! its signer policy. Every other issuer's tokens are compact RS256 JWTs, exactly as before.

use std::collections::BTreeMap;

use near_sdk::serde_json::json;
use near_sdk::{env, near, AccountId};

use crate::oidc::{self, RsaPublicKey};
use crate::{assert_provider, events, HanaSigner, HanaSignerExt};

const MAX_ISS_VALUES: usize = 4;
const MAX_KEYS_PER_ISSUER: usize = 10;
const MAX_KID_BYTES: usize = 128;
/// Pending key changes over all issuers. A pending `Add` is ≤ ~800 bytes, so this bounds contract-paid storage.
pub const MAX_PENDING_KEY_CHANGES: usize = 6;

/// An RSA public key (big-endian bytes, no leading zeros).
#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct RsaKey {
    pub n: Vec<u8>,
    pub e: Vec<u8>,
}

#[near(serializers = [borsh])]
#[derive(Clone)]
pub struct Issuer {
    pub provider: String,
    pub iss_values: Vec<String>,
    /// kid → key. Active keys only: pending ones are in `HanaSigner::key_changes`.
    pub keys: BTreeMap<String, RsaKey>,
}

#[near(serializers = [json])]
#[derive(Debug, PartialEq)]
pub struct IssuerView {
    pub provider: String,
    pub iss_values: Vec<String>,
    pub kids: Vec<String>,
}

/// What a pending key change does once executed or confirmed. Borsh variants 0 and 1 are the v2 ones, unchanged, so
/// pending changes stored by v2 code read as before.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub enum KeyOp {
    /// Big-endian bytes, leading zeros stripped (as stored in `RsaKey`).
    Add { n: Vec<u8>, e: Vec<u8> },
    Remove,
    /// A key of a self-issued issuer, for one signer of its policy.
    AddForSigner { n: Vec<u8>, e: Vec<u8>, signer: String },
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingKeyChange {
    pub id: u64,
    pub provider: String,
    pub kid: String,
    pub op: KeyOp,
    /// The owner or the contract account.
    pub by: AccountId,
    pub proposed_at_ms: u64,
    pub executable_at_ms: u64,
}

/// An active signing key as `get_issuer_keys` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IssuerKeyView {
    pub kid: String,
    /// JWK base64url of the modulus and exponent, leading zeros stripped (as `get_key_changes` shows them).
    pub n: String,
    pub e: String,
}

/// A pending key change as `get_key_changes` returns it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct KeyChangeView {
    pub id: u64,
    pub provider: String,
    pub kid: String,
    /// `"Add"` or `"Remove"`.
    pub op: String,
    /// JWK base64url of the modulus and exponent (leading zeros stripped) for an `Add`, `null` for a `Remove`.
    pub n: Option<String>,
    pub e: Option<String>,
    /// The signer of a self-issued issuer's key addition; absent for every other change.
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub signer: Option<String>,
    pub by: AccountId,
    pub proposed_at_ms: u64,
    pub executable_at_ms: u64,
}

/// What a token's signature verified against.
#[derive(Debug, Clone)]
pub struct VerifiedToken {
    pub provider: String,
    pub aud: String,
    pub sub: String,
    pub nonce: Option<String>,
}

fn strip_leading_zeros(mut bytes: Vec<u8>) -> Vec<u8> {
    let first = bytes.iter().position(|&b| b != 0).unwrap_or(bytes.len());
    bytes.drain(..first);
    bytes
}

/// The one validation of every RSA key the contract installs (`set_issuer_key`, and a governed upgrade's
/// `set_signer_policy`): leading zeros stripped (so one modulus has one byte form and the one-modulus rule can't be
/// dodged by padding), a 2048..=4096-bit modulus, an odd exponent of 1..=8 bytes other than 1.
pub(crate) fn checked_rsa_key(n: Vec<u8>, e: Vec<u8>) -> RsaKey {
    let n = strip_leading_zeros(n);
    let e = strip_leading_zeros(e);
    assert!((256..=512).contains(&n.len()), "RSA modulus must be 2048-4096 bits");
    assert!(!e.is_empty() && e.len() <= 8 && e[e.len() - 1] & 1 == 1 && e != [1], "Invalid RSA exponent");
    RsaKey { n, e }
}

impl PendingKeyChange {
    fn view(&self) -> KeyChangeView {
        let (op, n, e, signer) = match &self.op {
            KeyOp::Add { n, e } => ("Add", Some(oidc::b64url(n)), Some(oidc::b64url(e)), None),
            KeyOp::AddForSigner { n, e, signer } => ("Add", Some(oidc::b64url(n)), Some(oidc::b64url(e)), Some(signer.clone())),
            KeyOp::Remove => ("Remove", None, None, None),
        };
        KeyChangeView {
            id: self.id,
            provider: self.provider.clone(),
            kid: self.kid.clone(),
            op: op.to_string(),
            n,
            e,
            signer,
            by: self.by.clone(),
            proposed_at_ms: self.proposed_at_ms,
            executable_at_ms: self.executable_at_ms,
        }
    }
}

#[near]
impl HanaSigner {
    /// Creates or updates an issuer. Its keys are kept on update.
    pub fn set_issuer(&mut self, provider: String, iss_values: Vec<String>) {
        self.assert_owner();
        assert_provider(&provider);
        assert!(!iss_values.is_empty() && iss_values.len() <= MAX_ISS_VALUES, "An issuer needs 1 to 4 iss values");
        for (i, iss) in iss_values.iter().enumerate() {
            assert!(!iss.is_empty() && iss.len() <= 256, "Invalid iss value");
            assert!(!iss_values[..i].contains(iss), "Duplicate iss value");
            if let Some(other) = self.iss_index.get(iss) {
                assert!(*other == provider, "iss value already used by another provider");
            }
        }
        let issuer = match self.issuers.remove(&provider) {
            Some(mut existing) => {
                for old in &existing.iss_values {
                    self.iss_index.remove(old);
                }
                existing.iss_values = iss_values.clone();
                existing
            }
            None => Issuer { provider: provider.clone(), iss_values: iss_values.clone(), keys: BTreeMap::new() },
        };
        for iss in &iss_values {
            self.iss_index.insert(iss.clone(), provider.clone());
        }
        self.issuers.insert(provider, issuer);
    }

    /// Proposes a new signing key; returns the key change id. `n` and `e` are JWK base64url. Owner or the contract
    /// account itself (the updater key). The kid becomes usable only once the change is executed (after the delay)
    /// or confirmed by a watchdog. An active kid is never overwritten: remove it first.
    ///
    /// For a self-issued issuer: owner only (`Only the owner posts keys for this issuer`), `signer` must be one of its
    /// policy's signers (`Unknown signer`), the key material must be new to the issuer (`Key is already registered`),
    /// ≤ 8 keys, and the change waits at least `governance_delay_ms` with no early confirm. Any other issuer refuses a
    /// `signer` (`Only a self-issued issuer takes a signer`).
    pub fn set_issuer_key(&mut self, provider: String, kid: String, n: String, e: String, signer: Option<String>) -> u64 {
        let by = self.assert_owner_or_self();
        assert!(!kid.is_empty() && kid.len() <= MAX_KID_BYTES, "Invalid kid");
        let n = oidc::decode_jwk_part(&n).unwrap_or_else(|err| env::panic_str(&err));
        let e = oidc::decode_jwk_part(&e).unwrap_or_else(|err| env::panic_str(&err));
        let RsaKey { n, e } = checked_rsa_key(n, e);
        let issuer = self.issuers.get(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        assert!(!issuer.keys.contains_key(&kid), "Kid is already active");
        self.assert_key_change_room(&provider, &kid);
        let pending_adds = self.key_changes.iter().filter(|c| c.provider == provider && c.op != KeyOp::Remove).count();
        assert!(issuer.keys.len() + pending_adds < MAX_KEYS_PER_ISSUER, "Too many keys for this issuer");
        let (n64, e64) = (oidc::b64url(&n), oidc::b64url(&e));
        let op = if self.self_issued_of(&provider).is_some() {
            assert!(by == self.owner, "Only the owner posts keys for this issuer");
            self.self_issued_key_op(&provider, signer, n, e)
        } else {
            assert!(signer.is_none(), "Only a self-issued issuer takes a signer");
            KeyOp::Add { n, e }
        };
        let signer = match &op {
            KeyOp::AddForSigner { signer, .. } => Some(signer.clone()),
            _ => None,
        };
        let change = self.queue_key_change(provider, kid, op, by);
        let mut data = json!({ "id": change.id, "provider": change.provider, "kid": change.kid, "n": n64, "e": e64, "executable_at_ms": change.executable_at_ms, "by": change.by });
        if let Some(signer) = signer {
            data["signer"] = json!(signer);
        }
        events::emit("issuer_key_proposed", data);
        change.id
    }

    /// Proposes removing an active key; returns the key change id. Owner or self (owner only for a self-issued
    /// issuer). An issuer's last key can't be proposed for removal (counting removals already pending), so a stuck
    /// sync never empties the registry.
    pub fn propose_issuer_key_removal(&mut self, provider: String, kid: String) -> u64 {
        let by = self.assert_owner_or_self();
        let issuer = self.issuers.get(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        assert!(issuer.keys.contains_key(&kid), "No such key");
        assert!(self.self_issued_of(&provider).is_none() || by == self.owner, "Only the owner posts keys for this issuer");
        self.assert_key_change_room(&provider, &kid);
        let pending_removals = self.key_changes.iter().filter(|c| c.provider == provider && c.op == KeyOp::Remove).count();
        assert!(issuer.keys.len() > pending_removals + 1, "Cannot remove the last key of an issuer");
        let change = self.queue_key_change(provider, kid, KeyOp::Remove, by);
        events::emit(
            "issuer_key_removal_proposed",
            json!({ "id": change.id, "provider": change.provider, "kid": change.kid, "executable_at_ms": change.executable_at_ms, "by": change.by }),
        );
        change.id
    }

    /// Anyone applies a pending key change once `executable_at_ms` has passed. Not while paused. Re-checks the change
    /// against the current keys; on a failed re-check the change stays pending until cancelled.
    pub fn execute_issuer_key_change(&mut self, id: u64) {
        self.assert_not_paused();
        let index = self.key_change_index(id);
        assert!(env::block_timestamp_ms() >= self.key_changes[index].executable_at_ms, "Key change is still delayed");
        self.apply_key_change(index, "delay", None);
    }

    /// A watchdog (from its `confirm_from_ms`) applies a pending key change now: the early activation of a key it
    /// checked against the issuer's published JWKS. Allowed while paused. Same re-checks as the executor. Never for a
    /// self-issued issuer: no outside JWKS vouches for Hana's own keys, so they always wait their full delay.
    pub fn confirm_issuer_key_change(&mut self, id: u64) {
        let caller = env::predecessor_account_id();
        let watchdog = self.watchdogs.iter().find(|w| w.account_id == caller).unwrap_or_else(|| env::panic_str("Only a watchdog can do this"));
        assert!(env::block_timestamp_ms() >= watchdog.confirm_from_ms, "This watchdog can't confirm yet");
        let index = self.key_change_index(id);
        assert!(self.self_issued_of(&self.key_changes[index].provider).is_none(), "Keys of a self-issued issuer can't be confirmed early");
        self.apply_key_change(index, "confirmed", Some(caller));
    }

    /// The owner or any watchdog (including one that can't confirm yet) drops a pending key change.
    pub fn cancel_issuer_key_change(&mut self, id: u64) {
        let by = self.assert_owner_or_watchdog();
        let index = self.key_change_index(id);
        let change = self.key_changes.remove(index);
        emit_cancelled(&change, &by);
    }

    /// Owner only: removes an active key at once (may remove an issuer's last key: a deliberate owner action, DoS
    /// only) and drops any pending change for that kid. Returns whether an active key was removed.
    pub fn remove_issuer_key(&mut self, provider: String, kid: String) -> bool {
        self.assert_owner();
        let issuer = self.issuers.get_mut(&provider).unwrap_or_else(|| env::panic_str("Unknown issuer"));
        let removed = issuer.keys.remove(&kid).is_some();
        if removed {
            self.forget_key_signer(&provider, &kid);
            events::emit("issuer_key_removed", json!({ "provider": provider, "kid": kid, "how": "owner" }));
        }
        if let Some(index) = self.key_changes.iter().position(|c| c.provider == provider && c.kid == kid) {
            let change = self.key_changes.remove(index);
            emit_cancelled(&change, &self.owner);
        }
        removed
    }

    pub fn get_issuer(&self, provider: String) -> Option<IssuerView> {
        self.issuers.get(&provider).map(|i| IssuerView { provider: i.provider.clone(), iss_values: i.iss_values.clone(), kids: i.keys.keys().cloned().collect() })
    }

    /// The active keys of `provider` with their key material, in kid order, or `null` for an unknown issuer. Lets a
    /// watchdog compare every active key with the issuer's JWKS, including keys that went live while it was down or
    /// arrived by an upgrade (`docs/governance-spec.md` "Watchdog service" step 5). Read-only.
    pub fn get_issuer_keys(&self, provider: String) -> Option<Vec<IssuerKeyView>> {
        self.issuers.get(&provider).map(|i| i.keys.iter().map(|(kid, k)| IssuerKeyView { kid: kid.clone(), n: oidc::b64url(&k.n), e: oidc::b64url(&k.e) }).collect())
    }

    /// Pending key changes of every issuer, in proposal order.
    pub fn get_key_changes(&self) -> Vec<KeyChangeView> {
        self.key_changes.iter().map(PendingKeyChange::view).collect()
    }
}

fn emit_cancelled(change: &PendingKeyChange, by: &AccountId) {
    events::emit("issuer_key_change_cancelled", json!({ "id": change.id, "provider": change.provider, "kid": change.kid, "by": by }));
}

impl HanaSigner {
    /// Panics unless the caller is the owner or the contract account itself; returns the caller.
    fn assert_owner_or_self(&self) -> AccountId {
        let caller = env::predecessor_account_id();
        assert!(caller == self.owner || caller == env::current_account_id(), "Only the owner or the contract account can do this");
        caller
    }

    pub(crate) fn has_issuer(&self, provider: &str) -> bool {
        self.issuers.contains_key(provider)
    }

    fn key_change_index(&self, id: u64) -> usize {
        self.key_changes.iter().position(|c| c.id == id).unwrap_or_else(|| env::panic_str("No such key change"))
    }

    /// One pending change per (provider, kid); ≤ `MAX_PENDING_KEY_CHANGES` over all issuers.
    fn assert_key_change_room(&self, provider: &str, kid: &str) {
        assert!(!self.key_changes.iter().any(|c| c.provider == provider && c.kid == kid), "Kid already has a pending change");
        assert!(self.key_changes.len() < MAX_PENDING_KEY_CHANGES, "Too many pending key changes");
    }

    /// When a change proposed now may be executed: after the issuer-key delay, never before `keys_slow_until_ms`
    /// (a watchdog was removed), and after the governance delay while no watchdog may confirm yet (none, or only ones
    /// whose `confirm_from_ms` is still ahead). A watchdog counts only once it has been public for the governance
    /// delay, so adding a fresh one (possibly a compromised owner's yes-man) never shortens the wait.
    pub(crate) fn key_change_executable_at(&self, now: u64) -> u64 {
        let trusted_watchdog = self.watchdogs.iter().any(|w| w.confirm_from_ms <= now);
        let no_watchdog = if trusted_watchdog { 0 } else { now.saturating_add(self.governance_delay_at(now)) };
        now.saturating_add(self.issuer_key_delay_at(now)).max(self.keys_slow_until_ms).max(no_watchdog)
    }

    /// `key_change_executable_at`, and for a self-issued issuer never before `now + governance_delay_ms` (nothing
    /// confirms its keys early, so the governance window is their only public review).
    fn executable_at_for(&self, provider: &str, now: u64) -> u64 {
        let at = self.key_change_executable_at(now);
        if self.self_issued_of(provider).is_some() {
            at.max(now.saturating_add(self.governance_delay_at(now)))
        } else {
            at
        }
    }

    fn queue_key_change(&mut self, provider: String, kid: String, op: KeyOp, by: AccountId) -> PendingKeyChange {
        let now = env::block_timestamp_ms();
        let executable_at_ms = self.executable_at_for(&provider, now);
        let change = PendingKeyChange { id: self.next_key_change, provider, kid, op, by, proposed_at_ms: now, executable_at_ms };
        self.next_key_change += 1;
        self.key_changes.push(change.clone());
        change
    }

    /// Re-checks the pending change at `index` against the current keys, then applies it, drops it from the queue and
    /// emits its event. A failed re-check panics before anything changes.
    fn apply_key_change(&mut self, index: usize, how: &str, by: Option<AccountId>) {
        let change = self.key_changes[index].clone();
        let mut issuer = self.issuers.get(&change.provider).cloned().unwrap_or_else(|| env::panic_str("Unknown issuer"));
        let event = match change.op {
            KeyOp::Add { n, e } => {
                assert!(!issuer.keys.contains_key(&change.kid), "Kid is already active");
                assert!(issuer.keys.len() < MAX_KEYS_PER_ISSUER, "Too many keys for this issuer");
                issuer.keys.insert(change.kid.clone(), RsaKey { n, e });
                "issuer_key_set"
            }
            KeyOp::AddForSigner { n, e, signer } => {
                assert!(!issuer.keys.contains_key(&change.kid), "Kid is already active");
                assert!(issuer.keys.len() < crate::self_issued::MAX_SELF_ISSUED_KEYS, "Too many keys for this issuer");
                // A governed upgrade may have installed the same key since the proposal.
                assert!(!issuer.keys.values().any(|k| k.n == n), "Key is already registered");
                issuer.keys.insert(change.kid.clone(), RsaKey { n, e });
                self.note_key_signer(&change.provider, &change.kid, &signer);
                "issuer_key_set"
            }
            KeyOp::Remove => {
                assert!(issuer.keys.contains_key(&change.kid), "No such key");
                assert!(issuer.keys.len() > 1, "Cannot remove the last key of an issuer");
                issuer.keys.remove(&change.kid);
                self.forget_key_signer(&change.provider, &change.kid);
                "issuer_key_removed"
            }
        };
        self.issuers.insert(change.provider.clone(), issuer);
        self.key_changes.remove(index);
        let mut data = json!({ "provider": change.provider, "kid": change.kid, "id": change.id, "how": how });
        if let Some(by) = by {
            data["by"] = json!(by);
        }
        events::emit(event, data);
    }

    /// Verifies an ID token against the stored (active) issuer keys. Panics on anything wrong, and while paused.
    /// The caller checks the nonce. A self-issued issuer's tokens must be JWS JSON passing its signer policy; every
    /// other issuer's must be a compact RS256 JWT (`Wrong token format for this issuer` otherwise).
    pub(crate) fn verify_token(&self, jwt: &str) -> VerifiedToken {
        self.assert_not_paused();
        let (provider, claims) = if oidc::is_json_form(jwt) {
            let parsed = oidc::parse_json(jwt).unwrap_or_else(|err| env::panic_str(&err));
            let provider = self.iss_index.get(&parsed.claims.iss).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
            let issuer = self.issuers.get(provider).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
            assert!(self.self_issued_of(provider).is_some(), "Wrong token format for this issuer");
            self.verify_self_issued_signatures(provider, issuer, &parsed.signatures);
            (provider.clone(), parsed.claims)
        } else {
            let parsed = oidc::parse(jwt).unwrap_or_else(|err| env::panic_str(&err));
            let provider = self.iss_index.get(&parsed.claims.iss).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
            let issuer = self.issuers.get(provider).unwrap_or_else(|| env::panic_str("Unknown token issuer"));
            assert!(self.self_issued_of(provider).is_none(), "Wrong token format for this issuer");
            let key = issuer.keys.get(&parsed.kid).unwrap_or_else(|| env::panic_str("Unknown signing key"));
            oidc::verify_signature(&parsed, RsaPublicKey { n: &key.n, e: &key.e }).unwrap_or_else(|err| env::panic_str(&err));
            (provider.clone(), parsed.claims)
        };
        let now = env::block_timestamp_ms();
        assert!(claims.exp.saturating_mul(1000) > now, "Token expired");
        assert!(crate::valid_sub(&claims.sub), "Invalid sub");
        crate::assert_aud(&claims.aud);
        VerifiedToken { provider, aud: claims.aud, sub: claims.sub, nonce: claims.nonce }
    }
}
