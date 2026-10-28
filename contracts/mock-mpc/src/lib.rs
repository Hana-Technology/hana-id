//! Test-only stand-in for the NEAR MPC signer (`v1.signer-prod.testnet`), used by `contracts/integration-tests`.
//!
//! It implements only `request_app_private_key(request)` with the argument shape `hana-signer` sends
//! (`{"request":{"derivation_path","app_public_key":{"AppPublicKeyPV":{"pk1","pk2"}},"domain_id"}}`, 1 yoctoNEAR
//! attached). Instead of running CKD it records the call (path, predecessor, keys, domain, deposit) and returns a
//! deterministic fake `{big_y, big_c}` computed from the request, so tests can check that a response is passed
//! through unchanged and that different paths give different answers. The values are not valid BLS12-381 points.
//!
//! `set_fail(true)` makes every request panic (`Mock MPC failure`) until `set_fail(false)`, so tests can see what a
//! failed MPC receipt leaves behind in `hana-signer` (the caller's own receipt has already committed).

use near_sdk::serde::{Deserialize, Serialize};
use near_sdk::store::Vector;
use near_sdk::{env, near, AccountId, NearToken, PanicOnDefault};
use schemars::JsonSchema;

/// `{"AppPublicKeyPV":{"pk1","pk2"}}`, as in near/mpc `crates/near-mpc-crypto-types/src/ckd.rs`.
#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub enum CkdAppPublicKey {
    AppPublicKeyPV { pk1: String, pk2: String },
}

#[derive(Serialize, Deserialize, JsonSchema, Debug, Clone, PartialEq)]
#[serde(crate = "near_sdk::serde")]
pub struct CkdRequestArgs {
    pub derivation_path: String,
    pub app_public_key: CkdAppPublicKey,
    pub domain_id: u64,
}

/// The MPC's CKD response shape.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct CkdResponse {
    pub big_y: String,
    pub big_c: String,
}

/// One recorded `request_app_private_key` call.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RecordedCall {
    pub derivation_path: String,
    pub predecessor: AccountId,
    pub pk1: String,
    pub pk2: String,
    pub domain_id: u64,
    /// Attached deposit in yoctoNEAR, as a decimal string.
    pub deposit: String,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockMpc {
    calls: Vector<RecordedCall>,
    /// When set, `request_app_private_key` panics.
    fail: bool,
}

/// The real MPC charges 1 yoctoNEAR per CKD request.
const MIN_DEPOSIT: NearToken = NearToken::from_yoctonear(1);

#[near]
impl MockMpc {
    #[init]
    pub fn new() -> Self {
        Self { calls: Vector::new(b"c"), fail: false }
    }

    /// Records the request and returns `fake_response(request)`; panics without recording it while `fail` is set.
    #[payable]
    pub fn request_app_private_key(&mut self, request: CkdRequestArgs) -> CkdResponse {
        assert!(!self.fail, "Mock MPC failure");
        let deposit = env::attached_deposit();
        assert!(deposit >= MIN_DEPOSIT, "Attach at least 1 yoctoNEAR");
        let CkdAppPublicKey::AppPublicKeyPV { pk1, pk2 } = request.app_public_key.clone();
        self.calls.push(RecordedCall {
            derivation_path: request.derivation_path.clone(),
            predecessor: env::predecessor_account_id(),
            pk1,
            pk2,
            domain_id: request.domain_id,
            deposit: deposit.as_yoctonear().to_string(),
        });
        fake_response(&request)
    }

    /// The failure switch. Only the mock's own account may flip it.
    pub fn set_fail(&mut self, fail: bool) {
        assert!(env::predecessor_account_id() == env::current_account_id(), "Only the mock's account can set the failure switch");
        self.fail = fail;
    }

    pub fn fails(&self) -> bool {
        self.fail
    }

    pub fn calls_count(&self) -> u32 {
        self.calls.len()
    }

    /// Recorded calls in order, `from_index` (default 0), up to `limit` (default 100).
    pub fn get_calls(&self, from_index: Option<u32>, limit: Option<u32>) -> Vec<RecordedCall> {
        let from = from_index.unwrap_or(0);
        let limit = limit.unwrap_or(100);
        (from..self.calls.len()).take(limit as usize).filter_map(|i| self.calls.get(i).cloned()).collect()
    }

    /// The response `request_app_private_key` gives for `request` (deterministic, for test assertions).
    pub fn expected_response(&self, request: CkdRequestArgs) -> CkdResponse {
        fake_response(&request)
    }
}

/// big_y = "bls12381g1:mock-y:" ‖ hex(sha256(path ‖ 0x00 ‖ domain u64 LE)),
/// big_c = "bls12381g1:mock-c:" ‖ hex(sha256(path ‖ 0x00 ‖ pk1 ‖ 0x00 ‖ pk2)).
pub fn fake_response(request: &CkdRequestArgs) -> CkdResponse {
    let CkdAppPublicKey::AppPublicKeyPV { pk1, pk2 } = &request.app_public_key;
    let mut y = request.derivation_path.as_bytes().to_vec();
    y.push(0);
    y.extend_from_slice(&request.domain_id.to_le_bytes());
    let mut c = request.derivation_path.as_bytes().to_vec();
    c.push(0);
    c.extend_from_slice(pk1.as_bytes());
    c.push(0);
    c.extend_from_slice(pk2.as_bytes());
    CkdResponse { big_y: format!("bls12381g1:mock-y:{}", hex(&env::sha256(&y))), big_c: format!("bls12381g1:mock-c:{}", hex(&env::sha256(&c))) }
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{:02x}", b)).collect()
}
