//! Sessions (an ID token binds a browser-held Ed25519 key to a derivation path) and CKD key release.
//!
//! The path is `{scope_id}#{provider}#{sub}#{key_index}` of the session's **path identity**: the token's own identity,
//! or, for a member of an account (`links.rs`), the account root's. An identity in no account opens exactly the path
//! it opened before accounts existed.

// create_session takes 8 arguments and create_session_and_derive 12 (plus self): the JSON interface is flat on purpose.
#![allow(clippy::too_many_arguments)]

use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::{env, ext_contract, near, Gas, NearToken, Promise, PromiseOrValue};
use schemars::JsonSchema;

use crate::{oidc, HanaSigner, HanaSignerExt};

/// What the NEAR MPC charges per CKD request.
const MPC_FEE: NearToken = NearToken::from_yoctonear(1);
/// The MPC requires at least 15 TGas attached to `request_app_private_key`.
const CKD_GAS: Gas = Gas::from_tgas(20);
/// Domain-separates CKD requests from anything else the session key signs.
pub const CKD_PREFIX: &str = "hana-id-ckd-v1:";
/// Domain-separates session-key signatures from anything else the key might sign.
pub const SESSION_DOMAIN: &[u8] = b"hana-id-session-v1:";
/// Domain-separates session nonces from the other nonces (registry.rs).
const SESSION_NONCE_DOMAIN: &[u8] = b"hana-id/session/v1";
pub const REVOKE_PAYLOAD: &[u8] = b"revoke";
/// What the session key signs, with counter 0, to prove possession in a bare `create_session` (D137). Counter 0 is
/// never accepted by `derive_key` or `revoke_session` (they need `used + 1` ≥ 1), and no other payload is this string.
pub const CREATE_PAYLOAD: &[u8] = b"hana-id-create-v1";

pub const MAX_SESSION_MS: u64 = 24 * 60 * 60 * 1000;
pub const MAX_USES: u32 = 500;
/// `key_index` values from 2^31 up are reserved (for a later rotation scheme): `create_session` refuses them.
pub const KEY_INDEX_LIMIT: u32 = 0x8000_0000;
pub const MAX_PRUNE: u32 = 100;
/// Expired sessions pruned by every `create_session`.
const PRUNE_ON_CREATE: u32 = 3;
const MAX_BLS_KEY_BYTES: usize = 512;

/// A session as returned by `create_session` / `get_session`.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    /// MPC derivation path: `{scope_id}#{provider}#{sub}#{key_index}`.
    pub path: String,
    pub scope_id: String,
    pub expires_at_ms: u64,
    pub max_uses: u32,
    /// Uses so far; the next request must carry counter = used + 1.
    pub used: u32,
}

/// A session as stored. Borsh: path ‖ scope_id ‖ expires_at_ms u64 ‖ max_uses u32 ‖ used u32 ‖ revoked u8, then
/// `created_at_ms` u64 for sessions opened by v2 code. Sessions opened by v1 code (before the governance migration)
/// end after `revoked`: the codec below reads both, so they keep working without a migration of every record.
#[derive(Clone, Debug, PartialEq)]
pub struct StoredSession {
    pub path: String,
    pub scope_id: String,
    pub expires_at_ms: u64,
    pub max_uses: u32,
    pub used: u32,
    /// Revoked sessions stay as tombstones until expiry, so their (public) token can't reopen them.
    pub revoked: bool,
    /// When `create_session` opened it; `None` for a session opened by v1 code.
    pub created_at_ms: Option<u64>,
}

impl BorshSerialize for StoredSession {
    fn serialize<W: borsh::io::Write>(&self, writer: &mut W) -> borsh::io::Result<()> {
        BorshSerialize::serialize(&self.path, writer)?;
        BorshSerialize::serialize(&self.scope_id, writer)?;
        BorshSerialize::serialize(&self.expires_at_ms, writer)?;
        BorshSerialize::serialize(&self.max_uses, writer)?;
        BorshSerialize::serialize(&self.used, writer)?;
        BorshSerialize::serialize(&self.revoked, writer)?;
        // A v1 session stays in the v1 form when it is written back (e.g. after a use).
        if let Some(t) = self.created_at_ms {
            BorshSerialize::serialize(&t, writer)?;
        }
        Ok(())
    }
}

impl BorshDeserialize for StoredSession {
    fn deserialize_reader<R: borsh::io::Read>(reader: &mut R) -> borsh::io::Result<Self> {
        let path = String::deserialize_reader(reader)?;
        let scope_id = String::deserialize_reader(reader)?;
        let expires_at_ms = u64::deserialize_reader(reader)?;
        let max_uses = u32::deserialize_reader(reader)?;
        let used = u32::deserialize_reader(reader)?;
        let revoked = bool::deserialize_reader(reader)?;
        // Optional trailing u64: absent (a v1 record) or all 8 bytes; anything in between is corrupt.
        let mut tail = [0u8; 8];
        let mut filled = 0;
        while filled < tail.len() {
            match reader.read(&mut tail[filled..])? {
                0 => break,
                n => filled += n,
            }
        }
        let created_at_ms = match filled {
            0 => None,
            8 => Some(u64::from_le_bytes(tail)),
            _ => return Err(borsh::io::Error::new(borsh::io::ErrorKind::InvalidData, "truncated session record")),
        };
        Ok(Self { path, scope_id, expires_at_ms, max_uses, used, revoked, created_at_ms })
    }
}

impl StoredSession {
    fn view(&self) -> Session {
        Session { path: self.path.clone(), scope_id: self.scope_id.clone(), expires_at_ms: self.expires_at_ms, max_uses: self.max_uses, used: self.used }
    }

    /// The earliest time it can have been opened: `created_at_ms`, or for a v1 session `expires_at_ms -
    /// MAX_SESSION_MS` (`create_session` refuses an expiry more than `MAX_SESSION_MS` ahead, so it was opened no earlier).
    fn opened_no_earlier_than(&self) -> u64 {
        self.created_at_ms.unwrap_or(self.expires_at_ms.saturating_sub(MAX_SESSION_MS))
    }
}

#[near(serializers = [borsh])]
pub struct QueueEntry {
    pub expires_at_ms: u64,
    pub key: Vec<u8>,
}

#[allow(dead_code)]
#[ext_contract(mpc_contract)]
pub trait MpcContract {
    fn request_app_private_key(&mut self, request: CkdRequestArgs) -> PromiseOrValue<near_sdk::serde_json::Value>;
}

/// The browser's ephemeral BLS12-381 key in the MPC's publicly verifiable form: `{"AppPublicKeyPV":{"pk1","pk2"}}`
/// (near/mpc crates/near-mpc-crypto-types/src/ckd.rs). The MPC checks e(pk1, g2) = e(g1, pk2).
#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub enum CkdAppPublicKey {
    AppPublicKeyPV { pk1: String, pk2: String },
}

#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct CkdRequestArgs {
    pub derivation_path: String,
    pub app_public_key: CkdAppPublicKey,
    pub domain_id: u64,
}

/// What a session nonce commits to. Mirrors `create_session`'s arguments (minus the token) plus the deployment.
pub struct SessionCommitment<'a> {
    pub signer: &'a str,
    pub scope_id: &'a str,
    pub session_public_key: &'a [u8],
    pub expires_at_ms: u64,
    pub key_index: u32,
    pub max_uses: u32,
    pub salt: &'a [u8],
}

/// "hana-id/session/v1" ‖ borsh(signer) ‖ borsh(scope_id) ‖ session_public_key ‖ expires_at_ms u64 LE ‖
/// key_index u32 LE ‖ max_uses u32 LE ‖ salt.
pub fn session_nonce_preimage(c: &SessionCommitment) -> Vec<u8> {
    let mut preimage = SESSION_NONCE_DOMAIN.to_vec();
    preimage.extend(near_sdk::borsh::to_vec(c.signer).unwrap());
    preimage.extend(near_sdk::borsh::to_vec(c.scope_id).unwrap());
    preimage.extend_from_slice(c.session_public_key);
    preimage.extend_from_slice(&c.expires_at_ms.to_le_bytes());
    preimage.extend_from_slice(&c.key_index.to_le_bytes());
    preimage.extend_from_slice(&c.max_uses.to_le_bytes());
    preimage.extend_from_slice(c.salt);
    preimage
}

/// nonce = b64url(sha256(session_nonce_preimage)). (`create_session` hashes the preimage itself: the `auto_link` nonce
/// commits to that hash too.)
#[cfg_attr(not(test), allow(dead_code))]
pub fn session_nonce(c: &SessionCommitment) -> String {
    oidc::b64url(&env::sha256(session_nonce_preimage(c)))
}

/// What the session key signs for a CKD request: "hana-id-ckd-v1:" ‖ pk1 ‖ ":" ‖ pk2.
pub fn ckd_request_bytes(pk1: &str, pk2: &str) -> Vec<u8> {
    format!("{}{}:{}", CKD_PREFIX, pk1, pk2).into_bytes()
}

/// Domain of the CKD payload of a combined login that carries an automatic link (D133).
pub const CKD_LINK_PREFIX: &str = "hana-id-ckd-link-v1:";

/// What the session key signs for the CKD request of a `create_session_and_derive` that carries `link_jwt`:
/// "hana-id-ckd-link-v1:" ‖ sha256(link_jwt) ‖ mode u8 (1 = `link_immediate`) ‖ pk1 ‖ ":" ‖ pk2. The user's own
/// signature thus decides whether a link is attached, which one and in which mode: nobody can add, swap or strip it.
/// Its own domain (and fixed-length fields before the strings) keeps it from ever reading as a plain CKD payload.
pub fn linked_ckd_request_bytes(pk1: &str, pk2: &str, link_jwt: &str, immediate: bool) -> Vec<u8> {
    let mut payload = CKD_LINK_PREFIX.as_bytes().to_vec();
    payload.extend_from_slice(&env::sha256(link_jwt.as_bytes()));
    payload.push(u8::from(immediate));
    payload.extend_from_slice(pk1.as_bytes());
    payload.push(b':');
    payload.extend_from_slice(pk2.as_bytes());
    payload
}

/// "hana-id-session-v1:" ‖ counter u64 LE ‖ sha256(payload).
pub fn session_message_bytes(counter: u64, payload: &[u8]) -> Vec<u8> {
    let mut message = SESSION_DOMAIN.to_vec();
    message.extend_from_slice(&counter.to_le_bytes());
    message.extend_from_slice(&env::sha256(payload));
    message
}

#[near]
impl HanaSigner {
    /// Opens a session in scope `scope_id` for the user in `jwt`, bound to `session_public_key`. The token's
    /// `(provider, aud)` must be a client of that scope, or a shared client if the scope has `allow_shared`; its nonce
    /// must equal session_nonce(...), which commits to this deployment, the scope and every other argument. The path
    /// is the path identity's (the account root's for a member); a pending member is refused (`Sign-in method link is
    /// pending`). `signature` is the session key's proof of possession: Ed25519 over session_message(0,
    /// "hana-id-create-v1") (D137). Only the key holder can open the session, so a token copied from a published
    /// login (for instance a case-A login with a link) can't be used to occupy its session key with a plain session.
    pub fn create_session(
        &mut self,
        jwt: String,
        scope_id: String,
        session_public_key: Vec<u8>,
        expires_at_ms: u64,
        salt: Vec<u8>,
        key_index: u32,
        max_uses: u32,
        signature: Vec<u8>,
    ) -> Session {
        let session = self.open_session(jwt, scope_id, session_public_key.clone(), expires_at_ms, salt, key_index, max_uses, None);
        verify_session_signature(&session_public_key, signature, &session_message_bytes(0, CREATE_PAYLOAD));
        session
    }

    /// Full-key mode: asks the MPC's CKD domain for the session path's secret, encrypted to the browser's BLS key
    /// (`pk1`, `pk2`). `signature` is the session key's Ed25519 signature over
    /// session_message(counter, "hana-id-ckd-v1:{pk1}:{pk2}"). Returns the MPC's `{big_y, big_c}`. Not while paused.
    /// Records that the path's identity has a wallet (`opened`). Refused once the path's identity is a member of an
    /// account (`Sign-in method is linked to an account`): a session opened on its own path before it joined can't
    /// make a second wallet (D136).
    pub fn derive_key(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>, pk1: String, pk2: String) -> Promise {
        let payload = ckd_request_bytes(&pk1, &pk2);
        self.derive_with(session_public_key, counter, signature, pk1, pk2, &payload)
    }

    /// One-transaction login: exactly `create_session` followed by `derive_key` with counter 1, in one receipt.
    /// `signature` is the session key's signature over session_message(1, "hana-id-ckd-v1:{pk1}:{pk2}"). Any panic
    /// in either half (token, nonce, signature, BLS key length, ...) reverts the whole call, so no session is left
    /// behind. Returns the MPC's `{big_y, big_c}`. If the MPC itself fails, the session stays with `used = 1` (the
    /// MPC call is a separate receipt), and only a session with `max_uses ≥ 2` can retry, with `derive_key` and
    /// counter 2.
    ///
    /// `link_jwt` (optional, email login's automatic linking): a self-issued token for this scope whose nonce is the
    /// `auto_link` nonce over this session's nonce preimage, the session identity, the join (who joins which account),
    /// the target account's epoch and `link_immediate` (default false). It links the two identities before the path is
    /// chosen (`links.rs` `auto_link`); a panic there reverts the whole login too. With a link, `signature` is over
    /// session_message(1, `linked_ckd_request_bytes`) instead, so the session key holder alone decides the link (D133).
    /// Callers that pass neither are unaffected.
    pub fn create_session_and_derive(
        &mut self,
        jwt: String,
        scope_id: String,
        session_public_key: Vec<u8>,
        expires_at_ms: u64,
        salt: Vec<u8>,
        key_index: u32,
        max_uses: u32,
        signature: Vec<u8>,
        pk1: String,
        pk2: String,
        link_jwt: Option<String>,
        link_immediate: Option<bool>,
    ) -> Promise {
        assert!(link_jwt.is_some() || link_immediate.is_none(), "link_immediate needs a link_jwt");
        let link = link_jwt.map(|jwt| (jwt, link_immediate.unwrap_or(false)));
        let payload = match &link {
            Some((link_jwt, immediate)) => linked_ckd_request_bytes(&pk1, &pk2, link_jwt, *immediate),
            None => ckd_request_bytes(&pk1, &pk2),
        };
        self.open_session(jwt, scope_id, session_public_key.clone(), expires_at_ms, salt, key_index, max_uses, link);
        self.derive_with(session_public_key, 1, signature, pk1, pk2, &payload)
    }

    /// Ends a session early. Signed by the session key over session_message(counter, "revoke").
    pub fn revoke_session(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>) {
        let mut session = self.live_session(&session_public_key);
        assert!(counter == u64::from(session.used) + 1, "Wrong counter (replayed or out of order)");
        verify_session_signature(&session_public_key, signature, &session_message_bytes(counter, REVOKE_PAYLOAD));
        session.revoked = true;
        self.sessions.insert(session_public_key, session);
    }

    /// Deletes up to `limit` (≤ 100) expired sessions from the head of the expiry FIFO. Returns how many it deleted.
    pub fn prune_sessions(&mut self, limit: u32) -> u32 {
        self.prune(limit.min(MAX_PRUNE))
    }

    /// `null` if there is no session for this key, it was revoked, or it was opened before `sessions_valid_from_ms`.
    pub fn get_session(&self, session_public_key: Vec<u8>) -> Option<Session> {
        self.sessions.get(&session_public_key).filter(|s| self.in_force(s)).map(StoredSession::view)
    }

    /// True if create_session would refuse this key with "Session key already in use": a session for it, revoked or
    /// not, has not expired yet. Lets a relayer reject a replayed create_session without paying for it.
    pub fn session_key_in_use(&self, session_public_key: Vec<u8>) -> bool {
        self.sessions.get(&session_public_key).is_some_and(|s| s.expires_at_ms > env::block_timestamp_ms())
    }

    /// The bytes a session key signs for request number `counter`: "hana-id-session-v1:" ‖ counter (u64 LE) ‖ sha256(payload).
    pub fn session_message(&self, counter: u64, payload: Vec<u8>) -> Vec<u8> {
        session_message_bytes(counter, &payload)
    }
}

fn verify_session_signature(session_public_key: &[u8], signature: Vec<u8>, message: &[u8]) {
    let pk: [u8; 32] = session_public_key.try_into().unwrap_or_else(|_| env::panic_str("Bad session key"));
    let sig: [u8; 64] = signature.try_into().unwrap_or_else(|_| env::panic_str("Signature must be 64 bytes"));
    assert!(env::ed25519_verify(&sig, message, &pk), "Invalid session signature");
}

impl HanaSigner {
    /// `derive_key` with the signed `payload` given (the plain or the linked CKD payload).
    fn derive_with(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>, pk1: String, pk2: String, payload: &[u8]) -> Promise {
        self.assert_not_paused();
        assert!(pk1.len() <= MAX_BLS_KEY_BYTES && pk2.len() <= MAX_BLS_KEY_BYTES, "BLS key too long");
        let path = self.use_session(&session_public_key, counter, signature, payload);
        self.note_opened(&path);
        mpc_contract::ext(self.mpc.clone())
            .with_attached_deposit(MPC_FEE)
            .with_static_gas(CKD_GAS)
            .request_app_private_key(CkdRequestArgs { derivation_path: path, app_public_key: CkdAppPublicKey::AppPublicKeyPV { pk1, pk2 }, domain_id: self.ckd_domain_id })
    }

    /// `create_session`, with an optional automatic link `(link_jwt, link_immediate)` made before the path is chosen.
    fn open_session(
        &mut self,
        jwt: String,
        scope_id: String,
        session_public_key: Vec<u8>,
        expires_at_ms: u64,
        salt: Vec<u8>,
        key_index: u32,
        max_uses: u32,
        link: Option<(String, bool)>,
    ) -> Session {
        self.assert_not_paused();
        assert!(session_public_key.len() == 32, "Session key must be a 32-byte Ed25519 public key");
        assert!((16..=64).contains(&salt.len()), "Salt must be 16-64 bytes");
        let now = env::block_timestamp_ms();
        assert!(expires_at_ms > now && expires_at_ms <= now.saturating_add(MAX_SESSION_MS), "Session expiry must be within 24 hours");
        assert!(max_uses > 0 && max_uses <= MAX_USES, "max_uses must be 1-500");
        assert!(key_index < KEY_INDEX_LIMIT, "key_index must be below 2^31");
        if let Some(existing) = self.sessions.get(&session_public_key) {
            assert!(existing.expires_at_ms <= now, "Session key already in use");
        }

        let token = self.verify_token(&jwt);
        let scope_id = self.session_scope(&token.provider, &token.aud, &scope_id);
        let signer = env::current_account_id();
        let preimage = session_nonce_preimage(&SessionCommitment {
            signer: signer.as_str(),
            scope_id: &scope_id,
            session_public_key: &session_public_key,
            expires_at_ms,
            key_index,
            max_uses,
            salt: &salt,
        });
        let nonce = oidc::b64url(&env::sha256(&preimage));
        assert!(token.nonce.as_deref() == Some(nonce.as_str()), "Token nonce doesn't commit to this session");

        // The path identity: the token's own, or its account root's (a pending member is refused).
        let x = crate::links::ik(&scope_id, &token.provider, &token.sub);
        let mut root = self.settle(&scope_id, &x, now);
        if let Some((link_jwt, immediate)) = link {
            root = self.auto_link(&scope_id, x, root, &token, &link_jwt, immediate, &env::sha256_array(&preimage), now).path_root;
        }
        let (path_provider, path_sub) = self.path_identity(&root, (&token.provider, &token.sub));

        let stored = StoredSession {
            path: format!("{}#{}#{}#{}", scope_id, path_provider, path_sub, key_index),
            scope_id,
            expires_at_ms,
            max_uses,
            used: 0,
            revoked: false,
            created_at_ms: Some(now),
        };
        let session = stored.view();
        self.sessions.insert(session_public_key.clone(), stored);
        self.session_queue.insert(self.queue_tail, QueueEntry { expires_at_ms, key: session_public_key });
        self.queue_tail += 1;
        self.prune(PRUNE_ON_CREATE);
        session
    }

    /// Not revoked, and not opened before the owner's `sessions_valid_from_ms` floor. Expiry is checked by the caller.
    fn in_force(&self, s: &StoredSession) -> bool {
        !s.revoked && s.opened_no_earlier_than() >= self.sessions_valid_from_ms
    }

    fn live_session(&self, session_public_key: &Vec<u8>) -> StoredSession {
        self.sessions.get(session_public_key).filter(|s| self.in_force(s)).cloned().unwrap_or_else(|| env::panic_str("No such session"))
    }

    /// Checks expiry, use limit, counter and signature over `payload`, counts the use, returns the path.
    fn use_session(&mut self, session_public_key: &Vec<u8>, counter: u64, signature: Vec<u8>, payload: &[u8]) -> String {
        let mut session = self.live_session(session_public_key);
        assert!(env::block_timestamp_ms() < session.expires_at_ms, "Session expired");
        assert!(session.used < session.max_uses, "Session use limit reached");
        assert!(counter == u64::from(session.used) + 1, "Wrong counter (replayed or out of order)");
        verify_session_signature(session_public_key, signature, &session_message_bytes(counter, payload));
        session.used += 1;
        let path = session.path.clone();
        self.sessions.insert(session_public_key.clone(), session);
        path
    }

    /// Pops up to `limit` queue entries while the head has expired; deletes each entry's session unless it is
    /// already gone or was replaced by a newer session for the same key. Returns how many sessions it deleted.
    pub(crate) fn prune(&mut self, limit: u32) -> u32 {
        let now = env::block_timestamp_ms();
        let mut deleted = 0;
        for _ in 0..limit {
            if self.queue_head >= self.queue_tail {
                break;
            }
            let Some(entry) = self.session_queue.get(&self.queue_head) else { break };
            if entry.expires_at_ms > now {
                break;
            }
            let (expires_at_ms, key) = (entry.expires_at_ms, entry.key.clone());
            self.session_queue.remove(&self.queue_head);
            self.queue_head += 1;
            if self.sessions.get(&key).is_some_and(|s| s.expires_at_ms == expires_at_ms) {
                self.sessions.remove(&key);
                deleted += 1;
            }
        }
        deleted
    }
}
