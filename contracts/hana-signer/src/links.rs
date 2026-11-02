//! Accounts and identity links (`docs/email-login-spec.md` "Automatic linking", "Contract changes"; D119, D122).
//!
//! Per scope, identities `(provider, sub)` form **accounts**: a root (the identity whose own path is the wallet) and up
//! to `MAX_MEMBERS` members, at most one sign-in method per provider (the root's included). A member opens the root's
//! path; an identity is in at most one account per scope. State is keyed by identity keys
//! `ik = sha256("hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub))`; events carry keys in hex,
//! never `sub`s.
//!
//! - **Has a wallet** = a session on the identity's own path was ever used to derive its key (`opened`, set by
//!   `derive_key` and `create_session_and_derive`; D130).
//! - **Automatic links** come only through a login: `create_session_and_derive(..., link_jwt, link_immediate)`, where
//!   `link_jwt` is a self-issued (email) token whose `auto_link` nonce commits to this very session, the session
//!   identity, the target account's epoch and the link mode, all of which the issuer decided off chain.
//! - **Explicit links** (`link_identity`) need fresh proofs of the new identity and of an active identity of the
//!   account; they wait `change_delay_ms` (and never end before `changes_unlock_floor_ms`).
//! - `cancel_link` drops a pending member; `unlink_identity` drops an active one and marks the pair `unlinked`, so
//!   automatic linking never re-adds it. The root can't be removed (its path is the wallet).
//! - Every link change bumps the account's `epoch`, which every link nonce commits to, so a published proof can't be
//!   replayed once the account has moved on. An account record is never deleted (the epoch must never restart).
//!
//! No link changes an address: a member opens the root's existing path, an identity outside every account opens
//! exactly today's `{scope_id}#{provider}#{sub}#{key_index}`.

// The link methods' JSON interface is flat on purpose (as create_session's).
#![allow(clippy::too_many_arguments)]

use near_sdk::borsh;
use near_sdk::serde_json::json;
use near_sdk::{env, near};

use crate::issuers::VerifiedToken;
use crate::{assert_provider, events, oidc, valid_sub, HanaSigner, HanaSignerExt};

/// Members of one account (the root not counted), at most.
pub const MAX_MEMBERS: usize = 3;
/// Unlinked identities an account remembers (oldest dropped).
pub const MAX_UNLINKED: usize = 8;

const IDENTITY_DOMAIN: &[u8] = b"hana-id/identity/v1";
const LINK_NEW_DOMAIN: &[u8] = b"hana-id/link-new/v1";
const LINK_ACCOUNT_DOMAIN: &[u8] = b"hana-id/link-account/v1";
const LINK_CHANGE_DOMAIN: &[u8] = b"hana-id/link-change/v1";
const AUTO_LINK_DOMAIN: &[u8] = b"hana-id/auto-link/v1";

pub type IdentityKey = [u8; 32];

/// A member's pointer to its account (`HanaSigner::links`), pending or active.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct MemberRecord {
    pub root: IdentityKey,
    pub effective_at_ms: u64,
}

#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Member {
    pub key: IdentityKey,
    pub provider: String,
    /// When a pending member becomes active (it also waits for `changes_unlock_floor_ms`); for an immediate link, when
    /// it was made.
    pub effective_at_ms: u64,
    /// Marked at once for an immediate link, otherwise by the member's first login after `effective_at_ms`. A
    /// pending member past both times counts as active everywhere, marked or not.
    pub active: bool,
    /// Made by automatic linking (`link_jwt`), not by `link_identity`.
    pub auto: bool,
}

/// An account, stored under its root's identity key (`HanaSigner::accounts`).
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct Account {
    /// The root identity: the path every member opens (public anyway, in every MPC request).
    pub root_provider: String,
    pub root_sub: String,
    /// ≤ `MAX_MEMBERS`, pending and active.
    pub members: Vec<Member>,
    /// Identities unlinked from this account, which automatic linking must not re-add; ≤ `MAX_UNLINKED`, oldest
    /// dropped.
    pub unlinked: Vec<IdentityKey>,
    /// Bumped by every link change (join, cancel, unlink); link nonces commit to it.
    pub epoch: u64,
}

/// An identity as views show it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IdentityRef {
    pub provider: String,
    pub sub: String,
}

/// `get_identity`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct IdentityView {
    /// The identity key, hex.
    pub key: String,
    /// `"own"` (opens its own path), `"member"` (opens `root`'s path) or `"pending"` (refused until
    /// `effective_at_ms`).
    pub status: String,
    /// Whether its own path was ever used (it "has a wallet").
    pub opened: bool,
    /// The account root, for `member` and `pending`.
    pub root: Option<IdentityRef>,
    /// For `pending`: when logins start working (`changes_unlock_floor_ms` counted); for `member`: when it became
    /// effective.
    pub effective_at_ms: Option<u64>,
    /// The epoch of the account it is in, or roots (0: no account yet). Link nonces commit to it.
    pub account_epoch: u64,
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct MemberView {
    pub key: String,
    pub provider: String,
    /// For a pending member, when it becomes active (`changes_unlock_floor_ms` counted).
    pub effective_at_ms: u64,
    pub active: bool,
    pub auto: bool,
}

/// `get_account`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct AccountView {
    pub root: IdentityRef,
    pub members: Vec<MemberView>,
    pub epoch: u64,
    /// Identity keys (hex) unlinked from this account: automatic linking never re-adds them.
    pub unlinked: Vec<String>,
}

/// Where an identity stands at a given time.
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) enum Standing {
    /// Not a member: it opens its own path (and may be the root of an account).
    Own,
    /// An active member (or a pending one past its time and the unlock floor) of `root`'s account.
    Member { root: IdentityKey },
    /// A pending member of `root`'s account; logins wait until `until`.
    Pending { root: IdentityKey, until: u64 },
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().fold(String::with_capacity(bytes.len() * 2), |mut out, b| {
        use std::fmt::Write;
        let _ = write!(out, "{b:02x}");
        out
    })
}

fn parse_identity_key(text: &str) -> IdentityKey {
    let bytes = text.as_bytes();
    let mut key = [0u8; 32];
    let valid = bytes.len() == 64 && bytes.iter().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(b));
    assert!(valid, "Invalid identity key");
    for (i, out) in key.iter_mut().enumerate() {
        *out = u8::from_str_radix(&text[2 * i..2 * i + 2], 16).unwrap_or_else(|_| env::panic_str("Invalid identity key"));
    }
    key
}

fn borsh_str(s: &str) -> Vec<u8> {
    borsh::to_vec(s).unwrap()
}

/// "hana-id/identity/v1" ‖ borsh(scope_id) ‖ borsh(provider) ‖ borsh(sub).
pub fn identity_key_preimage(scope_id: &str, provider: &str, sub: &str) -> Vec<u8> {
    let mut preimage = IDENTITY_DOMAIN.to_vec();
    preimage.extend(borsh_str(scope_id));
    preimage.extend(borsh_str(provider));
    preimage.extend(borsh_str(sub));
    preimage
}

pub fn ik(scope_id: &str, provider: &str, sub: &str) -> IdentityKey {
    env::sha256_array(identity_key_preimage(scope_id, provider, sub))
}

/// "hana-id/link-new/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ borsh(new provider) ‖ epoch u64 LE ‖ salt.
pub fn link_new_preimage(signer: &str, scope_id: &str, root: &IdentityKey, new_provider: &str, epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut preimage = LINK_NEW_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend_from_slice(root);
    preimage.extend(borsh_str(new_provider));
    preimage.extend_from_slice(&epoch.to_le_bytes());
    preimage.extend_from_slice(salt);
    preimage
}

/// "hana-id/link-account/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ root_ik ‖ new_ik ‖ epoch u64 LE ‖ salt.
pub fn link_account_preimage(signer: &str, scope_id: &str, root: &IdentityKey, new: &IdentityKey, epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut preimage = LINK_ACCOUNT_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend_from_slice(root);
    preimage.extend_from_slice(new);
    preimage.extend_from_slice(&epoch.to_le_bytes());
    preimage.extend_from_slice(salt);
    preimage
}

/// "hana-id/link-change/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ borsh(action) ‖ root_ik ‖ member_ik ‖ epoch u64 LE ‖
/// salt, where action is "cancel" or "unlink".
pub fn link_change_preimage(signer: &str, scope_id: &str, action: &str, root: &IdentityKey, member: &IdentityKey, epoch: u64, salt: &[u8]) -> Vec<u8> {
    let mut preimage = LINK_CHANGE_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend(borsh_str(action));
    preimage.extend_from_slice(root);
    preimage.extend_from_slice(member);
    preimage.extend_from_slice(&epoch.to_le_bytes());
    preimage.extend_from_slice(salt);
    preimage
}

/// The `join` byte of the `auto_link` nonce: the session identity joins the link identity's account (case A).
pub const JOIN_SESSION_IDENTITY: u8 = 1;
/// The `join` byte of the `auto_link` nonce: the link identity joins the session identity's account (cases B, C).
pub const JOIN_LINK_IDENTITY: u8 = 2;

/// "hana-id/auto-link/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ sha256(session nonce preimage) ‖ session_ik ‖ join u8
/// (`JOIN_SESSION_IDENTITY` | `JOIN_LINK_IDENTITY`) ‖ joiner_ik ‖ target_root_ik ‖ target epoch u64 LE ‖ mode u8
/// (1 = `link_immediate`, else 0). The issuer commits to the whole join it decided (who joins which account), so a
/// change of chain state between minting and use can only make the token fail, never turn it into another join (D133).
#[allow(clippy::too_many_arguments)]
pub fn auto_link_preimage(
    signer: &str,
    scope_id: &str,
    session_preimage_hash: &[u8; 32],
    session_ik: &IdentityKey,
    join: u8,
    joiner: &IdentityKey,
    target_root: &IdentityKey,
    target_epoch: u64,
    immediate: bool,
) -> Vec<u8> {
    let mut preimage = AUTO_LINK_DOMAIN.to_vec();
    preimage.extend(borsh_str(signer));
    preimage.extend(borsh_str(scope_id));
    preimage.extend_from_slice(session_preimage_hash);
    preimage.extend_from_slice(session_ik);
    preimage.push(join);
    preimage.extend_from_slice(joiner);
    preimage.extend_from_slice(target_root);
    preimage.extend_from_slice(&target_epoch.to_le_bytes());
    preimage.push(u8::from(immediate));
    preimage
}

/// nonce = b64url(sha256(preimage)), as every other nonce.
pub fn nonce_of(preimage: &[u8]) -> String {
    oidc::b64url(&env::sha256(preimage))
}

fn assert_salt(salt: &[u8]) {
    assert!((16..=64).contains(&salt.len()), "Salt must be 16-64 bytes");
}

/// What `auto_link` did, for the session it belongs to.
pub(crate) struct AutoLinked {
    /// The account root whose path the session opens.
    pub path_root: IdentityKey,
}

#[near]
impl HanaSigner {
    /// Explicit "add a sign-in method": the new identity N (`new_jwt`, nonce `link_new`) joins the account of the
    /// identity A that `account_jwt` proves (nonce `link_account`), pending for `change_delay_ms` (and never active
    /// before `changes_unlock_floor_ms`). Returns when it becomes active. Both tokens must open sessions in `scope_id`
    /// (a scope client, or a shared client in an `allow_shared` scope). Payable: the caller pays the storage it adds
    /// (sponsors pay nothing, excess refunded).
    #[payable]
    pub fn link_identity(&mut self, scope_id: String, account_jwt: String, new_jwt: String, epoch: u64, salt: Vec<u8>) -> u64 {
        self.assert_not_paused();
        let storage_before = env::storage_usage();
        assert_salt(&salt);
        self.assert_wallets_recorded();
        let account_token = self.verify_token(&account_jwt);
        let new_token = self.verify_token(&new_jwt);
        let scope_id = self.session_scope(&account_token.provider, &account_token.aud, &scope_id);
        self.session_scope(&new_token.provider, &new_token.aud, &scope_id);
        let a = ik(&scope_id, &account_token.provider, &account_token.sub);
        let n = ik(&scope_id, &new_token.provider, &new_token.sub);
        let root = self.root_of(&a);
        let signer = env::current_account_id();
        let new_ok = new_token.nonce.as_deref() == Some(nonce_of(&link_new_preimage(signer.as_str(), &scope_id, &root, &new_token.provider, epoch, &salt)).as_str());
        let account_ok = account_token.nonce.as_deref() == Some(nonce_of(&link_account_preimage(signer.as_str(), &scope_id, &root, &n, epoch, &salt)).as_str());
        assert!(new_ok && account_ok, "Link nonce doesn't match");
        assert!(a != n, "Identities must differ");
        let now = env::block_timestamp_ms();
        // A must be an active identity of the account (its root, or an active member).
        self.settle(&scope_id, &a, now);
        assert!(!self.opened.contains(&n), "Sign-in method already has a wallet");
        assert!(!self.is_linked(&n), "Sign-in method is already linked");
        let (root_provider, root_sub) = self.identity_of(&root, &account_token);
        self.assert_room(&root, &root_provider, &new_token.provider);
        assert!(epoch == self.epoch_of(&root), "Wrong epoch");
        let effective_at_ms = now.saturating_add(self.change_delay_at(now)).max(self.changes_unlock_floor_ms);
        self.join(&scope_id, root, (root_provider, root_sub), n, new_token.provider, effective_at_ms, false, false);
        self.flush_links();
        self.charge_storage(storage_before, 0);
        effective_at_ms
    }

    /// Drops a pending member (`member_key`, hex) of an account. By the pending identity itself or any active
    /// identity of the account (`jwt`, nonce `link_change` with action "cancel"). Immediate. Payable as
    /// `link_identity`.
    #[payable]
    pub fn cancel_link(&mut self, scope_id: String, jwt: String, member_key: String, epoch: u64, salt: Vec<u8>) {
        self.assert_not_paused();
        let storage_before = env::storage_usage();
        assert_salt(&salt);
        let token = self.verify_token(&jwt);
        let scope_id = self.session_scope(&token.provider, &token.aud, &scope_id);
        let j = ik(&scope_id, &token.provider, &token.sub);
        let member = parse_identity_key(&member_key);
        let root = self.links.get(&member).map(|r| r.root).unwrap_or_else(|| env::panic_str("No such member"));
        self.assert_link_change_nonce(&token, &scope_id, "cancel", &root, &member, epoch, &salt);
        let now = env::block_timestamp_ms();
        if j != member {
            self.assert_active_in(&scope_id, &j, &root, now);
        }
        assert!(epoch == self.epoch_of(&root), "Wrong epoch");
        assert!(matches!(self.standing(&member, now), Standing::Pending { .. }), "No such member");
        let provider = self.remove_member(&root, &member, false);
        events::emit(
            "identity_link_cancelled",
            json!({ "scope_id": scope_id, "root": hex(&root), "member": hex(&member), "provider": provider, "by": hex(&j) }),
        );
        self.flush_links();
        self.charge_storage(storage_before, 0);
    }

    /// Drops an active member (`member_key`, hex) of an account. By the account's root or the member itself (`jwt`,
    /// nonce `link_change` with action "unlink"). Immediate. The pair is remembered (`unlinked`): automatic linking
    /// never re-adds it (an explicit `link_identity` still can). The member opens its own path again from its next
    /// login. Sessions it already opened on the root's path keep working until they end (`docs/security.md`).
    /// Payable as `link_identity`.
    #[payable]
    pub fn unlink_identity(&mut self, scope_id: String, jwt: String, member_key: String, epoch: u64, salt: Vec<u8>) {
        self.assert_not_paused();
        let storage_before = env::storage_usage();
        assert_salt(&salt);
        let token = self.verify_token(&jwt);
        let scope_id = self.session_scope(&token.provider, &token.aud, &scope_id);
        let j = ik(&scope_id, &token.provider, &token.sub);
        let member = parse_identity_key(&member_key);
        let root = match self.links.get(&member) {
            Some(record) => record.root,
            None if self.accounts.contains_key(&member) => member,
            None => env::panic_str("No such member"),
        };
        self.assert_link_change_nonce(&token, &scope_id, "unlink", &root, &member, epoch, &salt);
        let now = env::block_timestamp_ms();
        if j != root && j != member {
            let in_account = match self.standing(&j, now) {
                Standing::Member { root: r } | Standing::Pending { root: r, .. } => r == root,
                Standing::Own => false,
            };
            assert!(in_account, "Sign-in method is not in this account");
            env::panic_str("Only the root or the member itself can unlink");
        }
        assert!(epoch == self.epoch_of(&root), "Wrong epoch");
        assert!(member != root, "Cannot unlink the root");
        assert!(matches!(self.standing(&member, now), Standing::Member { .. }), "No such member");
        let provider = self.remove_member(&root, &member, true);
        events::emit("identity_unlinked", json!({ "scope_id": scope_id, "root": hex(&root), "member": hex(&member), "provider": provider, "by": hex(&j) }));
        self.flush_links();
        self.charge_storage(storage_before, 0);
    }

    /// Where `(provider, sub)` stands in `scope_id`: its key, whether it opens its own path, a root's (`member`) or
    /// is waiting (`pending`), whether it has a wallet, and the epoch link nonces must commit to.
    pub fn get_identity(&self, scope_id: String, provider: String, sub: String) -> IdentityView {
        assert_provider(&provider);
        assert!(valid_sub(&sub), "Invalid sub");
        let key = ik(&scope_id, &provider, &sub);
        let now = env::block_timestamp_ms();
        let standing = self.standing(&key, now);
        let (status, root, effective_at_ms) = match standing {
            Standing::Own => ("own", None, None),
            Standing::Member { root } => ("member", Some(root), self.member_of(&root, &key).map(|m| m.effective_at_ms)),
            Standing::Pending { root, until } => ("pending", Some(root), Some(until)),
        };
        let root_ref = root.and_then(|r| self.accounts.get(&r)).map(|a| IdentityRef { provider: a.root_provider.clone(), sub: a.root_sub.clone() });
        IdentityView {
            key: hex(&key),
            status: status.to_string(),
            opened: self.opened.contains(&key),
            root: root_ref,
            effective_at_ms,
            account_epoch: self.epoch_of(&root.unwrap_or(key)),
        }
    }

    /// The account `(provider, sub)` belongs to in `scope_id` (as root or member), or `null` if it is in none.
    pub fn get_account(&self, scope_id: String, provider: String, sub: String) -> Option<AccountView> {
        assert_provider(&provider);
        assert!(valid_sub(&sub), "Invalid sub");
        let key = ik(&scope_id, &provider, &sub);
        let now = env::block_timestamp_ms();
        let root = self.root_of(&key);
        self.accounts.get(&root).map(|a| AccountView {
            root: IdentityRef { provider: a.root_provider.clone(), sub: a.root_sub.clone() },
            members: a
                .members
                .iter()
                .map(|m| {
                    let active = self.member_active(m, now);
                    MemberView {
                        key: hex(&m.key),
                        provider: m.provider.clone(),
                        effective_at_ms: if active { m.effective_at_ms } else { m.effective_at_ms.max(self.changes_unlock_floor_ms) },
                        active,
                        auto: m.auto,
                    }
                })
                .collect(),
            epoch: a.epoch,
            unlinked: a.unlinked.iter().map(|k| hex(k)).collect(),
        })
    }

    /// Owner, one way: declares that the wallets opened before this deployment had v3 code (when `opened` didn't
    /// exist yet) may be ignored, which lets links be made. Needed only after a migration from v1 or v2 (sandbox-dev,
    /// whose pre-v3 wallets are test data, D135); a deployment created with `new` records every wallet from the start
    /// and never needs it. Event `unrecorded_wallets_accepted`.
    pub fn accept_unrecorded_wallets(&mut self) {
        self.assert_owner();
        if self.unrecorded_wallets {
            self.unrecorded_wallets = false;
            events::emit("unrecorded_wallets_accepted", json!({}));
        }
    }

    /// The identity key of `(provider, sub)` in `scope_id`, hex (for monitors and tests).
    pub fn identity_key(&self, scope_id: String, provider: String, sub: String) -> String {
        assert_provider(&provider);
        assert!(valid_sub(&sub), "Invalid sub");
        hex(&ik(&scope_id, &provider, &sub))
    }
}

impl HanaSigner {
    /// Links need `opened` to be complete: after a migration from pre-v3 state, until the owner accepts the wallets it
    /// can't see (`accept_unrecorded_wallets`), every link is refused, so a funded pre-v3 wallet is never silently
    /// joined to another identity's account.
    fn assert_wallets_recorded(&self) {
        assert!(!self.unrecorded_wallets, "Links wait until the owner accepts the wallets opened before v3");
    }

    /// The root of `key`'s account (itself unless it is a member, pending or active).
    pub(crate) fn root_of(&self, key: &IdentityKey) -> IdentityKey {
        self.links.get(key).map_or(*key, |r| r.root)
    }

    fn member_of(&self, root: &IdentityKey, key: &IdentityKey) -> Option<Member> {
        self.accounts.get(root).and_then(|a| a.members.iter().find(|m| m.key == *key).cloned())
    }

    fn member_active(&self, m: &Member, now: u64) -> bool {
        m.active || (now >= m.effective_at_ms && now >= self.changes_unlock_floor_ms)
    }

    pub(crate) fn standing(&self, key: &IdentityKey, now: u64) -> Standing {
        let Some(record) = self.links.get(key) else { return Standing::Own };
        let member = self.member_of(&record.root, key).unwrap_or_else(|| env::panic_str("Corrupt link record"));
        if self.member_active(&member, now) {
            Standing::Member { root: record.root }
        } else {
            Standing::Pending { root: record.root, until: member.effective_at_ms.max(self.changes_unlock_floor_ms) }
        }
    }

    fn epoch_of(&self, root: &IdentityKey) -> u64 {
        self.accounts.get(root).map_or(0, |a| a.epoch)
    }

    /// In an account: a member (pending or active), or a root that has members.
    fn is_linked(&self, key: &IdentityKey) -> bool {
        self.links.contains_key(key) || self.accounts.get(key).is_some_and(|a| !a.members.is_empty())
    }

    /// Reaches a wallet: an active member (it opens its root's), or an identity outside every account that has its own.
    fn reaches_wallet(&self, key: &IdentityKey, now: u64) -> bool {
        match self.standing(key, now) {
            Standing::Member { .. } => true,
            Standing::Pending { .. } => false,
            Standing::Own => self.opened.contains(key),
        }
    }

    /// The (provider, sub) of `root`: its account's record, or, for an identity with no account yet, the token's.
    fn identity_of(&self, root: &IdentityKey, token: &VerifiedToken) -> (String, String) {
        match self.accounts.get(root) {
            Some(a) => (a.root_provider.clone(), a.root_sub.clone()),
            None => (token.provider.clone(), token.sub.clone()),
        }
    }

    /// Panics unless `key` may act for its account now: a pending member is refused (`Sign-in method link is
    /// pending`). A pending member past its time and the unlock floor is marked active here (`identity_link_activated`).
    /// Returns its root (itself if it is in no account, or is the root).
    pub(crate) fn settle(&mut self, scope_id: &str, key: &IdentityKey, now: u64) -> IdentityKey {
        match self.standing(key, now) {
            Standing::Own => *key,
            Standing::Pending { .. } => env::panic_str("Sign-in method link is pending"),
            Standing::Member { root } => {
                let mut account = self.accounts.get(&root).cloned().expect("account of a member");
                let member = account.members.iter_mut().find(|m| m.key == *key).expect("member of its account");
                if !member.active {
                    member.active = true;
                    let provider = member.provider.clone();
                    self.accounts.insert(root, account);
                    events::emit("identity_link_activated", json!({ "scope_id": scope_id, "root": hex(&root), "member": hex(key), "provider": provider }));
                }
                root
            }
        }
    }

    /// Panics unless `j` is an active identity of `root`'s account (the root, or an active member).
    fn assert_active_in(&mut self, scope_id: &str, j: &IdentityKey, root: &IdentityKey, now: u64) {
        match self.standing(j, now) {
            Standing::Own => assert!(j == root, "Sign-in method is not in this account"),
            Standing::Pending { root: r, .. } => {
                assert!(r == *root, "Sign-in method is not in this account");
                env::panic_str("Sign-in method link is pending");
            }
            Standing::Member { root: r } => {
                assert!(r == *root, "Sign-in method is not in this account");
                self.settle(scope_id, j, now);
            }
        }
    }

    /// Room in `root`'s account for one more member of `provider`: fewer than `MAX_MEMBERS` members, and no sign-in
    /// method of that provider yet (the root's included).
    fn assert_room(&self, root: &IdentityKey, root_provider: &str, provider: &str) {
        let members = self.accounts.get(root).map(|a| a.members.clone()).unwrap_or_default();
        assert!(members.len() < MAX_MEMBERS, "Account is full");
        assert!(root_provider != provider && !members.iter().any(|m| m.provider == provider), "Account already has a sign-in method of this kind");
    }

    fn assert_link_change_nonce(&self, token: &VerifiedToken, scope_id: &str, action: &str, root: &IdentityKey, member: &IdentityKey, epoch: u64, salt: &[u8]) {
        let signer = env::current_account_id();
        let expected = nonce_of(&link_change_preimage(signer.as_str(), scope_id, action, root, member, epoch, salt));
        assert!(token.nonce.as_deref() == Some(expected.as_str()), "Link nonce doesn't match");
    }

    /// Adds `joiner` (of `provider`) to `root`'s account, creating the account record with `root_identity` if needed,
    /// and bumps the epoch. Emits `identity_linked` (active now) or `identity_link_proposed` (pending).
    /// Every new link (automatic or explicit, immediate or pending) comes through here, so this is where it is counted
    /// against the hourly cap (`link_cap.rs`, D200): over the cap the call panics before anything is written.
    fn join(&mut self, scope_id: &str, root: IdentityKey, root_identity: (String, String), joiner: IdentityKey, provider: String, effective_at_ms: u64, active: bool, auto: bool) {
        self.count_link(scope_id);
        let mut account = self.accounts.get(&root).cloned().unwrap_or(Account {
            root_provider: root_identity.0,
            root_sub: root_identity.1,
            members: vec![],
            unlinked: vec![],
            epoch: 0,
        });
        account.members.push(Member { key: joiner, provider: provider.clone(), effective_at_ms, active, auto });
        account.epoch += 1;
        self.accounts.insert(root, account);
        self.links.insert(joiner, MemberRecord { root, effective_at_ms });
        let event = if active { "identity_linked" } else { "identity_link_proposed" };
        events::emit(
            event,
            json!({ "scope_id": scope_id, "root": hex(&root), "member": hex(&joiner), "provider": provider, "effective_at_ms": effective_at_ms, "auto": auto }),
        );
    }

    /// Removes `member` from `root`'s account (and its link record), bumps the epoch, and with `remember` adds it to
    /// `unlinked`. Returns its provider.
    fn remove_member(&mut self, root: &IdentityKey, member: &IdentityKey, remember: bool) -> String {
        let mut account = self.accounts.get(root).cloned().expect("account of a member");
        let index = account.members.iter().position(|m| m.key == *member).expect("member of its account");
        let removed = account.members.remove(index);
        if remember {
            account.unlinked.retain(|k| k != member);
            if account.unlinked.len() >= MAX_UNLINKED {
                account.unlinked.remove(0);
            }
            account.unlinked.push(*member);
        }
        account.epoch += 1;
        self.accounts.insert(*root, account);
        self.links.remove(member);
        removed.provider
    }

    /// Whether automatic linking must not join `joiner` to `target`'s account: either was unlinked from the other's.
    fn unlinked_pair(&self, joiner: &IdentityKey, target: &IdentityKey) -> bool {
        let lists = |owner: &IdentityKey, other: &IdentityKey| self.accounts.get(owner).is_some_and(|a| a.unlinked.contains(other));
        lists(target, joiner) || lists(joiner, target)
    }

    /// The automatic link inside a login (`create_session_and_derive` with `link_jwt`). `x` is the session identity
    /// (already settled: not pending), `x_root` its account root, `session_hash` = sha256 of this session's nonce
    /// preimage. The four cases (`docs/email-login-spec.md` "The four cases"):
    /// - E (the link token's identity) has a wallet and X none: X joins E's account at once (case A; the link must be
    ///   immediate) and the session opens E's root's path;
    /// - E has none: E joins X's account, at once with `link_immediate`, else pending for `change_delay_ms` (case B),
    ///   and the session opens X's root's path;
    /// - both have one: refused. Already in one account, or an `unlinked` pair: refused.
    pub(crate) fn auto_link(
        &mut self,
        scope_id: &str,
        x: IdentityKey,
        x_root: IdentityKey,
        session_token: &VerifiedToken,
        link_jwt: &str,
        immediate: bool,
        session_hash: &[u8; 32],
        now: u64,
    ) -> AutoLinked {
        self.assert_wallets_recorded();
        let link = self.verify_token(link_jwt);
        assert!(self.self_issued_of(&link.provider).is_some(), "Link token must come from a self-issued issuer");
        let link_scope = self.session_scope(&link.provider, &link.aud, scope_id);
        assert!(link_scope == scope_id, "Token is for another app");
        let e = ik(scope_id, &link.provider, &link.sub);
        assert!(e != x, "Identities must differ");
        if let Standing::Pending { .. } = self.standing(&e, now) {
            env::panic_str("Sign-in method link is pending");
        }
        let e_root = self.root_of(&e);
        assert!(e_root != x_root, "Sign-in method is already linked");
        let (x_has, e_has) = (self.reaches_wallet(&x, now), self.reaches_wallet(&e, now));
        assert!(!(x_has && e_has), "Both sign-in methods already have a wallet");
        let case_a = e_has;
        let (joiner, joiner_provider, target) = if case_a {
            assert!(!self.is_linked(&x), "Sign-in method is already linked");
            (x, session_token.provider.clone(), e_root)
        } else {
            assert!(!self.is_linked(&e), "Sign-in method is already linked");
            (e, link.provider.clone(), x_root)
        };
        let target_epoch = self.epoch_of(&target);
        let signer = env::current_account_id();
        let join = if case_a { JOIN_SESSION_IDENTITY } else { JOIN_LINK_IDENTITY };
        let expected = nonce_of(&auto_link_preimage(signer.as_str(), scope_id, session_hash, &x, join, &joiner, &target, target_epoch, immediate));
        assert!(link.nonce.as_deref() == Some(expected.as_str()), "Link token nonce doesn't match");
        assert!(!case_a || immediate, "This link must be immediate");
        assert!(!self.unlinked_pair(&joiner, &target), "This sign-in method was unlinked");
        let target_identity = if case_a { self.identity_of(&target, &link) } else { self.identity_of(&target, session_token) };
        self.assert_room(&target, &target_identity.0, &joiner_provider);
        let effective_at_ms = if immediate { now } else { now.saturating_add(self.change_delay_at(now)).max(self.changes_unlock_floor_ms) };
        self.join(scope_id, target, target_identity, joiner, joiner_provider, effective_at_ms, immediate, true);
        AutoLinked { path_root: target }
    }

    /// The (provider, sub) whose path `root` opens: its account's root, or `fallback` (the identity itself).
    pub(crate) fn path_identity(&self, root: &IdentityKey, fallback: (&str, &str)) -> (String, String) {
        match self.accounts.get(root) {
            Some(a) => (a.root_provider.clone(), a.root_sub.clone()),
            None => (fallback.0.to_string(), fallback.1.to_string()),
        }
    }

    /// Records that the identity whose own path is `path` (`{scope}#{provider}#{sub}#{key_index}`) has a wallet.
    /// Panics if that identity is now a member (pending or active) of an account: a session it opened on its own
    /// path before joining must not make a second wallet (D136). A path identity of a member's session is the root,
    /// which is never a member.
    pub(crate) fn note_opened(&mut self, path: &str) {
        let parts: Vec<&str> = path.split('#').collect();
        if let [scope_id, provider, sub, _key_index] = parts.as_slice() {
            let key = ik(scope_id, provider, sub);
            assert!(!self.links.contains_key(&key), "Sign-in method is linked to an account");
            if !self.opened.contains(&key) {
                self.opened.insert(key);
            }
        }
    }

    fn flush_links(&mut self) {
        self.links.flush();
        self.accounts.flush();
        self.link_cap.flush();
    }
}
