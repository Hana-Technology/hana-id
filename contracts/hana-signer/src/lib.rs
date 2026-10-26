//! Hana signer: turns a NEAR Auth JWT into an MPC signature for Stellar or EVM.
//!
//! Forked from NEAR Auth's `fa` contract (github.com/Peersyst/fast-auth, contracts/fa) with two changes:
//! - The digest the MPC signs depends on the chain, so EVM works (keccak256) as well as Stellar (sha256).
//!   `fa` always sha256-hashes, which only fits Stellar and NEAR.
//! - No owner, pauser, upgrade or admin methods. After deployment the account's keys are deleted, so the
//!   code and config can never change and no Hana key can sign for users.
//!
//! `sign_payload` is a Borsh-encoded NEAR transaction used only as an envelope, because NEAR Auth's login (Auth0)
//! accepts nothing else and copies those exact bytes into the JWT's `fatxn` claim, which NEAR's guard compares
//! with `sign_payload`. The envelope must have this contract as receiver, an all-zero block hash (so it can
//! never execute on NEAR), and exactly one function call whose args are the bytes to sign:
//! - `sign_stellar`: args = Stellar transaction signature base. MPC Ed25519 signs sha256(args) = the tx hash.
//! - `sign_evm`: args = keccak preimage (unsigned tx serialisation, EIP-712 `0x1901 ++ domain ++ struct`, or
//!   EIP-191 prefixed message). MPC secp256k1 signs keccak256(args).
//!
//! Keys are derived per user at path `{guard_id}#{sub}`, with this contract as the MPC predecessor.
//!
//! Google sessions (POC): `create_session` checks a Google ID token on-chain (RS256 against keys in this contract's
//! registry) whose `nonce` commits to a browser-held Ed25519 session key, its expiry and a salt. After that,
//! `sign_with_session` accepts envelopes signed by that session key (with a strictly increasing counter), within the
//! session's expiry and signature limit, at path `{scope}#google#{sub}`. No popup per signature, and the Google token
//! (which is public once on-chain) can only ever authorise that one session key.
//!
//! Confidential Key Derivation (full-key mode): `derive_key` asks the MPC (CKD domain) for the session path's secret,
//! encrypted to a BLS12-381 key the browser made, so only that browser can read it. The session key must sign that
//! browser key (with the next counter), so nobody else can redirect a user's secret to a key of their own.
//!
//! POC simplifications: the account itself posts Google's keys (`set_google_key`) and the contract stays unlocked.
//! Production: 2-of-3 independent key posters with a delay, then lock.

mod google;

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::LookupMap;
use near_sdk::{env, ext_contract, near, AccountId, BorshStorageKey, Gas, NearToken, PanicOnDefault, Promise, PromiseError, PromiseOrValue};
use schemars::JsonSchema;

pub const METHOD_STELLAR: &str = "sign_stellar";
pub const METHOD_EVM: &str = "sign_evm";
/// Borsh index of `FunctionCall` in NEAR's `Action` enum.
const ACTION_FUNCTION_CALL: u8 = 2;

/// What the NEAR MPC charges per signature (and per CKD request).
const MPC_FEE: NearToken = NearToken::from_yoctonear(1);
/// The MPC's Confidential Key Derivation domain (BLS12-381) on v1.signer-prod.testnet and v1.signer.
const CKD_DOMAIN_ID: u64 = 2;
/// The MPC requires at least 15 TGas attached to `request_app_private_key`.
const CKD_GAS: Gas = Gas::from_tgas(20);
/// Domain-separates CKD requests from envelopes in what the session key signs.
const CKD_PREFIX: &str = "hana-embed-ckd-v1:";

/// Domain-separates session-key signatures from anything else the key might sign.
const SESSION_DOMAIN: &[u8] = b"hana-embed-session-v1:";
const MAX_SESSION_MS: u64 = 24 * 60 * 60 * 1000;
const MAX_SESSION_SIGNATURES: u32 = 500;
/// Scopes the POC accepts: one global account per Google user.
const SCOPES: [&str; 1] = ["global"];

#[derive(BorshStorageKey)]
#[near(serializers = [borsh])]
enum StorageKey {
    GoogleKeys,
    Sessions,
}

/// An RSA public key from Google's JWKS (big-endian bytes).
#[near(serializers = [borsh])]
pub struct GoogleKey {
    n: Vec<u8>,
    e: Vec<u8>,
}

#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Session {
    /// MPC derivation path: `{scope}#google#{sub}`.
    pub path: String,
    pub expires_at_ms: u64,
    pub max_signatures: u32,
    /// Signatures made so far; the next request must carry counter = used + 1.
    pub used: u32,
}

/// The pre-sessions state, read once by `migrate`.
#[near(serializers = [borsh])]
struct HanaSignerV1 {
    router: AccountId,
    mpc: AccountId,
    secp256k1_domain: u64,
    ed25519_domain: u64,
}

#[ext_contract(jwt_router)]
pub trait JwtRouter {
    fn verify(&self, guard_id: String, verify_payload: String, sign_payload: Vec<u8>, predecessor: AccountId) -> (bool, String, String);
}

#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub enum PayloadType {
    Ecdsa(String),
    Eddsa(String),
}

#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone)]
#[serde(crate = "near_sdk::serde")]
pub struct SignRequestV2 {
    pub path: String,
    pub payload_v2: PayloadType,
    pub domain_id: u64,
}

#[ext_contract(mpc_contract)]
pub trait MpcContract {
    fn sign(&self, request: SignRequestV2) -> PromiseOrValue<near_sdk::serde_json::Value>;
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

/// What the session key signs for a CKD request: the prefix and the browser's BLS key, as bytes.
fn ckd_request_bytes(pk1: &str, pk2: &str) -> Vec<u8> {
    format!("{}{}:{}", CKD_PREFIX, pk1, pk2).into_bytes()
}

/// What the MPC must sign for a given `sign_payload`: the hex digest and which MPC domain signs it.
#[derive(Serialize, Deserialize, JsonSchema, Debug, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct SignTarget {
    pub payload: PayloadType,
    pub domain_id: u64,
}

impl PartialEq for PayloadType {
    fn eq(&self, other: &Self) -> bool {
        match (self, other) {
            (PayloadType::Ecdsa(a), PayloadType::Ecdsa(b)) | (PayloadType::Eddsa(a), PayloadType::Eddsa(b)) => a == b,
            _ => false,
        }
    }
}

fn session_message_bytes(counter: u64, envelope: &[u8]) -> Vec<u8> {
    let mut message = SESSION_DOMAIN.to_vec();
    message.extend_from_slice(&counter.to_le_bytes());
    message.extend_from_slice(&env::sha256(envelope));
    message
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Strict Borsh reader for the envelope: any deviation panics.
struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let end = self.at.checked_add(n).filter(|&e| e <= self.bytes.len()).unwrap_or_else(|| env::panic_str("Malformed envelope"));
        let out = &self.bytes[self.at..end];
        self.at = end;
        out
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn vec(&mut self) -> &'a [u8] {
        let len = self.u32() as usize;
        self.take(len)
    }
    fn string(&mut self) -> &'a str {
        std::str::from_utf8(self.vec()).unwrap_or_else(|_| env::panic_str("Malformed envelope"))
    }
}

/// Unpacks the NEAR-transaction envelope into (method, bytes to sign).
pub fn open_envelope(envelope: &[u8], receiver: &str) -> (String, Vec<u8>) {
    let mut r = Reader { bytes: envelope, at: 0 };
    r.string(); // signer id: unused
    match r.u8() {
        0 => r.take(32), // ed25519 public key: unused
        1 => r.take(64), // secp256k1 public key: unused
        _ => env::panic_str("Malformed envelope"),
    };
    r.take(8); // nonce: unused
    assert!(r.string() == receiver, "Envelope must be addressed to this contract");
    assert!(r.take(32).iter().all(|&b| b == 0), "Envelope block hash must be zero");
    assert!(r.u32() == 1, "Envelope must hold exactly one action");
    assert!(r.u8() == ACTION_FUNCTION_CALL, "Envelope action must be a function call");
    let method = r.string().to_string();
    let args = r.vec().to_vec();
    r.take(8 + 16); // gas, deposit: unused
    assert!(r.at == envelope.len(), "Trailing bytes after envelope");
    (method, args)
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct HanaSigner {
    /// NEAR Auth JWT guard router (jwt.fast-auth.testnet / jwt.fast-auth.near).
    router: AccountId,
    /// NEAR MPC signer (v1.signer-prod.testnet / v1.signer).
    mpc: AccountId,
    /// MPC domain ids: secp256k1 for EVM, Ed25519 for Stellar.
    secp256k1_domain: u64,
    ed25519_domain: u64,
    /// POC: may post Google keys and client ids. Production replaces this with 2-of-3 posters and a delay.
    owner: AccountId,
    /// Google OAuth client ids whose tokens may open sessions (the token's `aud`).
    google_client_ids: Vec<String>,
    google_keys: LookupMap<String, GoogleKey>,
    /// Session public key (32 bytes) → session.
    sessions: LookupMap<Vec<u8>, Session>,
}

#[near]
impl HanaSigner {
    #[init]
    pub fn new(router: AccountId, mpc: AccountId, secp256k1_domain: u64, ed25519_domain: u64) -> Self {
        Self {
            router,
            mpc,
            secp256k1_domain,
            ed25519_domain,
            owner: env::current_account_id(),
            google_client_ids: vec![],
            google_keys: LookupMap::new(StorageKey::GoogleKeys),
            sessions: LookupMap::new(StorageKey::Sessions),
        }
    }

    /// Upgrades the deployed pre-sessions state in place (same account, so NEAR Auth addresses stay the same).
    #[private]
    #[init(ignore_state)]
    pub fn migrate(google_client_ids: Vec<String>) -> Self {
        let old: HanaSignerV1 = env::state_read().unwrap_or_else(|| env::panic_str("No state to migrate"));
        Self {
            router: old.router,
            mpc: old.mpc,
            secp256k1_domain: old.secp256k1_domain,
            ed25519_domain: old.ed25519_domain,
            owner: env::current_account_id(),
            google_client_ids,
            google_keys: LookupMap::new(StorageKey::GoogleKeys),
            sessions: LookupMap::new(StorageKey::Sessions),
        }
    }

    // ---- Google key registry (POC: owner-posted) ----

    pub fn set_google_key(&mut self, kid: String, n: String, e: String) {
        self.only_owner();
        let n = google::decode_jwk_part(&n).unwrap_or_else(|err| env::panic_str(&err));
        let e = google::decode_jwk_part(&e).unwrap_or_else(|err| env::panic_str(&err));
        assert!(n.len() >= 256, "RSA modulus must be at least 2048 bits");
        self.google_keys.insert(kid, GoogleKey { n, e });
    }

    pub fn remove_google_key(&mut self, kid: String) {
        self.only_owner();
        self.google_keys.remove(&kid);
    }

    pub fn set_google_client_ids(&mut self, client_ids: Vec<String>) {
        self.only_owner();
        self.google_client_ids = client_ids;
    }

    pub fn has_google_key(&self, kid: String) -> bool {
        self.google_keys.contains_key(&kid)
    }

    pub fn google_client_ids(&self) -> Vec<String> {
        self.google_client_ids.clone()
    }

    fn only_owner(&self) {
        assert!(env::predecessor_account_id() == self.owner, "Only the owner can do this");
    }

    // ---- Google sessions ----

    /// Opens a session for the Google user in `jwt`, bound to `session_public_key`. The token's `nonce` must equal
    /// base64url(sha256(session_public_key ++ expires_at_ms as u64 LE ++ salt)), so Google signed off on this exact
    /// key and expiry. Returns the session (its `path` picks the user's MPC keys).
    pub fn create_session(&mut self, jwt: String, session_public_key: Vec<u8>, expires_at_ms: u64, salt: Vec<u8>, max_signatures: u32, scope: String) -> Session {
        assert!(session_public_key.len() == 32, "Session key must be a 32-byte Ed25519 public key");
        assert!((16..=64).contains(&salt.len()), "Salt must be 16-64 bytes");
        assert!(SCOPES.contains(&scope.as_str()), "Unsupported scope");
        let now = env::block_timestamp_ms();
        assert!(expires_at_ms > now && expires_at_ms <= now + MAX_SESSION_MS, "Session expiry must be within 24 hours");
        assert!(max_signatures > 0 && max_signatures <= MAX_SESSION_SIGNATURES, "Signature limit out of range");
        if let Some(existing) = self.sessions.get(&session_public_key) {
            assert!(existing.expires_at_ms <= now, "Session key already in use");
        }

        let (kid, signed, signature, claims) = google::parse(&jwt).unwrap_or_else(|err| env::panic_str(&err));
        let key = self.google_keys.get(&kid).unwrap_or_else(|| env::panic_str("Unknown Google signing key"));
        assert!(google::verify_rs256(signed.as_bytes(), &signature, &key.n, &key.e), "Invalid Google signature");
        assert!(google::GOOGLE_ISSUERS.contains(&claims.iss.as_str()), "Not a Google token");
        assert!(self.google_client_ids.contains(&claims.aud), "Token is for another app");
        assert!(claims.exp * 1000 > now, "Google token expired");
        assert!(!claims.sub.is_empty() && !claims.sub.contains('#') && claims.sub.len() <= 256, "Invalid sub");

        let mut committed = session_public_key.clone();
        committed.extend_from_slice(&expires_at_ms.to_le_bytes());
        committed.extend_from_slice(&salt);
        let nonce = google::b64url(&env::sha256(&committed));
        assert!(claims.nonce.as_deref() == Some(nonce.as_str()), "Token nonce doesn't commit to this session");

        let session = Session { path: format!("{}#google#{}", scope, claims.sub), expires_at_ms, max_signatures, used: 0 };
        self.sessions.insert(session_public_key, session.clone());
        session
    }

    pub fn get_session(&self, session_public_key: Vec<u8>) -> Option<Session> {
        self.sessions.get(&session_public_key).cloned()
    }

    /// The bytes a session key signs for request number `counter`: domain ++ counter (u64 LE) ++ sha256(envelope).
    pub fn session_message(&self, counter: u64, envelope: Vec<u8>) -> Vec<u8> {
        session_message_bytes(counter, &envelope)
    }

    /// Signs `envelope` with the session's MPC keys. `signature` is the session key's Ed25519 signature over
    /// `session_message(counter, envelope)`, and `counter` must be exactly one more than the session's last.
    pub fn sign_with_session(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>, envelope: Vec<u8>) -> Promise {
        let target = self.sign_target(envelope.clone());
        let mut session = self.sessions.get(&session_public_key).cloned().unwrap_or_else(|| env::panic_str("No such session"));
        assert!(env::block_timestamp_ms() < session.expires_at_ms, "Session expired");
        assert!(session.used < session.max_signatures, "Session signature limit reached");
        assert!(counter == u64::from(session.used) + 1, "Wrong counter (replayed or out of order)");
        let pk: [u8; 32] = session_public_key.clone().try_into().unwrap_or_else(|_| env::panic_str("Bad session key"));
        let sig: [u8; 64] = signature.try_into().unwrap_or_else(|_| env::panic_str("Signature must be 64 bytes"));
        assert!(env::ed25519_verify(&sig, &session_message_bytes(counter, &envelope), &pk), "Invalid session signature");

        session.used += 1;
        let path = session.path.clone();
        self.sessions.insert(session_public_key, session);
        mpc_contract::ext(self.mpc.clone())
            .with_attached_deposit(MPC_FEE)
            .sign(SignRequestV2 { path, payload_v2: target.payload, domain_id: target.domain_id })
    }

    /// Full-key mode: releases the session path's secret from the MPC's CKD domain, encrypted to the browser's BLS key
    /// (`pk1`, `pk2`). `signature` is the session key's Ed25519 signature over
    /// `session_message(counter, "hana-embed-ckd-v1:{pk1}:{pk2}")`. Returns the MPC's `{big_y, big_c}` response.
    pub fn derive_key(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>, pk1: String, pk2: String) -> Promise {
        let mut session = self.sessions.get(&session_public_key).cloned().unwrap_or_else(|| env::panic_str("No such session"));
        assert!(env::block_timestamp_ms() < session.expires_at_ms, "Session expired");
        assert!(session.used < session.max_signatures, "Session signature limit reached");
        assert!(counter == u64::from(session.used) + 1, "Wrong counter (replayed or out of order)");
        let pk: [u8; 32] = session_public_key.clone().try_into().unwrap_or_else(|_| env::panic_str("Bad session key"));
        let sig: [u8; 64] = signature.try_into().unwrap_or_else(|_| env::panic_str("Signature must be 64 bytes"));
        assert!(env::ed25519_verify(&sig, &session_message_bytes(counter, &ckd_request_bytes(&pk1, &pk2)), &pk), "Invalid session signature");

        session.used += 1;
        let path = session.path.clone();
        self.sessions.insert(session_public_key, session);
        mpc_contract::ext(self.mpc.clone())
            .with_attached_deposit(MPC_FEE)
            .with_static_gas(CKD_GAS)
            .request_app_private_key(CkdRequestArgs { derivation_path: path, app_public_key: CkdAppPublicKey::AppPublicKeyPV { pk1, pk2 }, domain_id: CKD_DOMAIN_ID })
    }

    /// Ends a session early. Signed by the session key over `session_message(counter, b"revoke")`.
    pub fn revoke_session(&mut self, session_public_key: Vec<u8>, counter: u64, signature: Vec<u8>) {
        let session = self.sessions.get(&session_public_key).cloned().unwrap_or_else(|| env::panic_str("No such session"));
        assert!(counter == u64::from(session.used) + 1, "Wrong counter");
        let pk: [u8; 32] = session_public_key.clone().try_into().unwrap_or_else(|_| env::panic_str("Bad session key"));
        let sig: [u8; 64] = signature.try_into().unwrap_or_else(|_| env::panic_str("Signature must be 64 bytes"));
        assert!(env::ed25519_verify(&sig, &session_message_bytes(counter, b"revoke"), &pk), "Invalid session signature");
        self.sessions.remove(&session_public_key);
    }

    /// Verifies `jwt` with NEAR Auth's guard (`guard_id` like `jwt#https://issuer`), then asks the MPC to sign
    /// the chain-specific digest of `sign_payload`. Attach ~300 TGas. Takes no deposit, so a relayer can call it
    /// with a function-call access key limited to this method; the contract pays the MPC's 1 yoctoNEAR fee.
    pub fn sign(&mut self, guard_id: String, jwt: String, sign_payload: Vec<u8>) -> Promise {
        // Fail before the cross-contract calls if the payload is malformed.
        self.sign_target(sign_payload.clone());
        jwt_router::ext(self.router.clone())
            .verify(guard_id.clone(), jwt, sign_payload.clone(), env::predecessor_account_id())
            .then(Self::ext(env::current_account_id()).on_verified(guard_id, sign_payload))
    }

    #[private]
    pub fn on_verified(
        &mut self,
        guard_id: String,
        sign_payload: Vec<u8>,
        #[callback_result] verified: Result<(bool, String, String), PromiseError>,
    ) -> Promise {
        let sub = match verified {
            Ok((true, sub, _)) if !sub.is_empty() && !sub.contains('#') && sub.len() <= 256 => sub,
            Ok((true, _, _)) => env::panic_str("Guard returned an invalid sub"),
            _ => env::panic_str("Guard verification rejected"),
        };
        let target = self.sign_target(sign_payload);
        mpc_contract::ext(self.mpc.clone())
            .with_attached_deposit(MPC_FEE)
            .sign(SignRequestV2 { path: format!("{}#{}", guard_id, sub), payload_v2: target.payload, domain_id: target.domain_id })
    }

    /// The digest and MPC domain for an envelope. Public so clients can check what will be signed.
    pub fn sign_target(&self, sign_payload: Vec<u8>) -> SignTarget {
        let (method, bytes) = open_envelope(&sign_payload, env::current_account_id().as_str());
        assert!(!bytes.is_empty(), "Nothing to sign");
        match method.as_str() {
            METHOD_STELLAR => SignTarget { payload: PayloadType::Eddsa(hex(&env::sha256(&bytes))), domain_id: self.ed25519_domain },
            METHOD_EVM => SignTarget { payload: PayloadType::Ecdsa(hex(&env::keccak256(&bytes))), domain_id: self.secp256k1_domain },
            _ => env::panic_str("Unknown method: use sign_stellar or sign_evm"),
        }
    }

    pub fn config(&self) -> (AccountId, AccountId, u64, u64) {
        (self.router.clone(), self.mpc.clone(), self.secp256k1_domain, self.ed25519_domain)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn contract() -> HanaSigner {
        HanaSigner::new("jwt.fast-auth.testnet".parse().unwrap(), "v1.signer-prod.testnet".parse().unwrap(), 0, 1)
    }

    fn put_vec(out: &mut Vec<u8>, bytes: &[u8]) {
        out.extend((bytes.len() as u32).to_le_bytes());
        out.extend(bytes);
    }

    /// Same bytes as @near-js/transactions encodeTransaction for the envelope the app builds.
    fn envelope(receiver: &str, block_hash: [u8; 32], method: &str, args: &[u8]) -> Vec<u8> {
        let mut out = vec![];
        put_vec(&mut out, b"hana-embed");
        out.push(0);
        out.extend([0u8; 32]);
        out.extend(0u64.to_le_bytes());
        put_vec(&mut out, receiver.as_bytes());
        out.extend(block_hash);
        out.extend(1u32.to_le_bytes());
        out.push(ACTION_FUNCTION_CALL);
        put_vec(&mut out, method.as_bytes());
        put_vec(&mut out, args);
        out.extend(0u64.to_le_bytes());
        out.extend(0u128.to_le_bytes());
        out
    }

    fn me() -> String {
        env::current_account_id().to_string()
    }

    #[test]
    fn stellar_signs_sha256_with_ed25519() {
        let t = contract().sign_target(envelope(&me(), [0; 32], METHOD_STELLAR, b"abc"));
        assert_eq!(t.domain_id, 1);
        assert_eq!(t.payload, PayloadType::Eddsa("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into()));
    }

    #[test]
    fn evm_signs_keccak256_with_secp256k1() {
        let t = contract().sign_target(envelope(&me(), [0; 32], METHOD_EVM, b"abc"));
        assert_eq!(t.domain_id, 0);
        assert_eq!(t.payload, PayloadType::Ecdsa("4e03657aea45a94fc7d47ba826c8d667c0d1e6e33a64a036ec44f58fa12d6c45".into()));
    }

    #[test]
    #[should_panic(expected = "Unknown method")]
    fn rejects_unknown_method() {
        contract().sign_target(envelope(&me(), [0; 32], "transfer", b"abc"));
    }

    #[test]
    #[should_panic(expected = "addressed to this contract")]
    fn rejects_other_receiver() {
        contract().sign_target(envelope("someone.testnet", [0; 32], METHOD_EVM, b"abc"));
    }

    #[test]
    #[should_panic(expected = "block hash must be zero")]
    fn rejects_executable_envelope() {
        contract().sign_target(envelope(&me(), [7; 32], METHOD_EVM, b"abc"));
    }

    #[test]
    #[should_panic(expected = "Trailing bytes")]
    fn rejects_trailing_bytes() {
        let mut e = envelope(&me(), [0; 32], METHOD_EVM, b"abc");
        e.push(0);
        contract().sign_target(e);
    }

    #[test]
    #[should_panic(expected = "Malformed envelope")]
    fn rejects_truncated() {
        let e = envelope(&me(), [0; 32], METHOD_EVM, b"abc");
        contract().sign_target(e[..e.len() - 3].to_vec());
    }

    #[test]
    #[should_panic(expected = "Nothing to sign")]
    fn rejects_empty_args() {
        contract().sign_target(envelope(&me(), [0; 32], METHOD_EVM, b""));
    }

    // ---- Google sessions ----

    use ed25519_dalek::{Signer, SigningKey};
    use near_sdk::test_utils::VMContextBuilder;
    use near_sdk::testing_env;

    const NOW_MS: u64 = 1_800_000_000_000;
    const EXPIRES_MS: u64 = NOW_MS + 3_600_000;

    fn fixture() -> near_sdk::serde_json::Value {
        near_sdk::serde_json::from_str(include_str!("test_fixture.json")).unwrap()
    }

    fn at(ms: u64) {
        let me: AccountId = "hana-signer.testnet".parse().unwrap();
        testing_env!(VMContextBuilder::new().current_account_id(me.clone()).predecessor_account_id(me).block_timestamp(ms * 1_000_000).build());
    }

    fn session_key() -> SigningKey {
        SigningKey::from_bytes(&[7u8; 32])
    }

    /// A contract that trusts the fixture's "Google" key and client id.
    fn google_contract() -> HanaSigner {
        at(NOW_MS);
        let f = fixture();
        let mut c = contract();
        c.set_google_key("test-kid".into(), f["n"].as_str().unwrap().into(), f["e"].as_str().unwrap().into());
        c.set_google_client_ids(vec!["test-client.apps.googleusercontent.com".into()]);
        c
    }

    fn open(c: &mut HanaSigner, jwt_field: &str) -> Session {
        let pk = session_key().verifying_key().to_bytes().to_vec();
        c.create_session(fixture()[jwt_field].as_str().unwrap().into(), pk, EXPIRES_MS, vec![9u8; 16], 3, "global".into())
    }

    fn session_sig(counter: u64, envelope: &[u8]) -> Vec<u8> {
        session_key().sign(&session_message_bytes(counter, envelope)).to_bytes().to_vec()
    }

    #[test]
    fn fixture_session_key_matches() {
        assert_eq!(hex(&session_key().verifying_key().to_bytes()), fixture()["session_pk_hex"].as_str().unwrap());
    }

    #[test]
    fn google_token_opens_a_session() {
        let mut c = google_contract();
        let s = open(&mut c, "jwt");
        assert_eq!(s, Session { path: "global#google#1098765432".into(), expires_at_ms: EXPIRES_MS, max_signatures: 3, used: 0 });
    }

    #[test]
    #[should_panic(expected = "another app")]
    fn rejects_token_for_another_app() {
        let mut c = google_contract();
        open(&mut c, "jwt_wrong_aud");
    }

    #[test]
    #[should_panic(expected = "nonce")]
    fn rejects_token_for_another_session_key() {
        let mut c = google_contract();
        open(&mut c, "jwt_wrong_nonce");
    }

    #[test]
    #[should_panic(expected = "expired")]
    fn rejects_expired_token() {
        let mut c = google_contract();
        open(&mut c, "jwt_expired");
    }

    #[test]
    #[should_panic(expected = "Invalid Google signature")]
    fn rejects_forged_token() {
        let mut c = google_contract();
        let jwt = fixture()["jwt"].as_str().unwrap().to_string();
        // Swap the claims for different ones, keeping Google's signature.
        let parts: Vec<&str> = jwt.split('.').collect();
        let forged_claims = google::b64url(br#"{"iss":"https://accounts.google.com","aud":"test-client.apps.googleusercontent.com","sub":"victim","exp":1800003600}"#);
        let forged = format!("{}.{}.{}", parts[0], forged_claims, parts[2]);
        let pk = session_key().verifying_key().to_bytes().to_vec();
        c.create_session(forged, pk, EXPIRES_MS, vec![9u8; 16], 3, "global".into());
    }

    #[test]
    #[should_panic(expected = "Unknown Google signing key")]
    fn rejects_unknown_signing_key() {
        let mut c = google_contract();
        c.remove_google_key("test-kid".into());
        open(&mut c, "jwt");
    }

    #[test]
    #[should_panic(expected = "Only the owner")]
    fn only_owner_posts_keys() {
        let mut c = google_contract();
        testing_env!(VMContextBuilder::new().current_account_id("hana-signer.testnet".parse().unwrap()).predecessor_account_id("mallory.testnet".parse().unwrap()).build());
        c.set_google_key("evil".into(), "AQAB".into(), "AQAB".into());
    }

    #[test]
    fn session_signs_in_order() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        c.sign_with_session(pk.clone(), 1, session_sig(1, &e), e.clone());
        c.sign_with_session(pk.clone(), 2, session_sig(2, &e), e);
        assert_eq!(c.get_session(pk).unwrap().used, 2);
    }

    #[test]
    #[should_panic(expected = "Wrong counter")]
    fn session_signature_cannot_be_replayed() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        c.sign_with_session(pk.clone(), 1, session_sig(1, &e), e.clone());
        c.sign_with_session(pk, 1, session_sig(1, &e), e);
    }

    #[test]
    #[should_panic(expected = "Invalid session signature")]
    fn session_signature_is_bound_to_the_envelope() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let approved = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        let swapped = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"steal");
        c.sign_with_session(pk, 1, session_sig(1, &approved), swapped);
    }

    #[test]
    #[should_panic(expected = "Session expired")]
    fn expired_session_cannot_sign() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        at(EXPIRES_MS);
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        c.sign_with_session(pk, 1, session_sig(1, &e), e);
    }

    #[test]
    #[should_panic(expected = "limit reached")]
    fn session_limit_is_enforced() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        for n in 1..=4 {
            c.sign_with_session(pk.clone(), n, session_sig(n, &e), e.clone());
        }
    }

    #[test]
    #[should_panic(expected = "No such session")]
    fn revoked_session_cannot_sign() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        c.revoke_session(pk.clone(), 1, session_key().sign(&session_message_bytes(1, b"revoke")).to_bytes().to_vec());
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        c.sign_with_session(pk, 1, session_sig(1, &e), e);
    }

    // ---- CKD ----

    fn ckd_sig(counter: u64, pk1: &str, pk2: &str) -> Vec<u8> {
        session_key().sign(&session_message_bytes(counter, &ckd_request_bytes(pk1, pk2))).to_bytes().to_vec()
    }

    #[test]
    fn derive_key_counts_as_a_session_use() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        c.derive_key(pk.clone(), 1, ckd_sig(1, "bls12381g1:A", "bls12381g2:B"), "bls12381g1:A".into(), "bls12381g2:B".into());
        assert_eq!(c.get_session(pk).unwrap().used, 1);
    }

    #[test]
    #[should_panic(expected = "Invalid session signature")]
    fn derive_key_cannot_be_redirected_to_another_key() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        // Signed for the user's browser key, submitted with an attacker's key.
        c.derive_key(pk, 1, ckd_sig(1, "bls12381g1:USER", "bls12381g2:USER"), "bls12381g1:EVIL".into(), "bls12381g2:EVIL".into());
    }

    #[test]
    #[should_panic(expected = "Wrong counter")]
    fn derive_key_cannot_be_replayed() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let sig = ckd_sig(1, "bls12381g1:A", "bls12381g2:B");
        c.derive_key(pk.clone(), 1, sig.clone(), "bls12381g1:A".into(), "bls12381g2:B".into());
        c.derive_key(pk, 1, sig, "bls12381g1:A".into(), "bls12381g2:B".into());
    }

    #[test]
    #[should_panic(expected = "Invalid session signature")]
    fn an_envelope_signature_cannot_be_used_for_ckd() {
        let mut c = google_contract();
        open(&mut c, "jwt");
        let pk = session_key().verifying_key().to_bytes().to_vec();
        let e = envelope("hana-signer.testnet", [0; 32], METHOD_EVM, b"abc");
        c.derive_key(pk, 1, session_sig(1, &e), "bls12381g1:A".into(), "bls12381g2:B".into());
    }

    #[test]
    fn ckd_request_serialises_as_the_mpc_expects() {
        let req = CkdRequestArgs { derivation_path: "global#google#1".into(), app_public_key: CkdAppPublicKey::AppPublicKeyPV { pk1: "bls12381g1:x".into(), pk2: "bls12381g2:y".into() }, domain_id: 2 };
        assert_eq!(
            near_sdk::serde_json::to_string(&req).unwrap(),
            r#"{"derivation_path":"global#google#1","app_public_key":{"AppPublicKeyPV":{"pk1":"bls12381g1:x","pk2":"bls12381g2:y"}},"domain_id":2}"#
        );
    }
}
