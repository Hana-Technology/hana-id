//! Known-answer checks of this crate's byte layouts (tests/common/mod.rs) against vectors computed by a separate
//! Python implementation of docs/batch-a2-shared-client.md (hashlib + struct, written from the spec table, not from
//! either Rust implementation). No sandbox needed:
//!
//!   cargo test --test layouts

mod common;

use common::*;
use serde_json::json;

const SIGNER: &str = "signer.test.near";

#[test]
fn session_nonce_vector() {
    let pk: Vec<u8> = (0u8..32).collect();
    let salt = [9u8; 16];
    assert_eq!(session_nonce(SIGNER, "s1", &pk, 1_800_003_600_000, 7, 3, &salt), "TebGXW7fg2yLAZNQ7FAp_OVGET5oTuqpVuJkMv7XquY");
}

#[test]
fn register_nonce_vectors() {
    let owners = vec![json!({"Near": {"account_id": "alice.test.near"}}), json!({"Oidc": {"provider": "google", "sub": "owner-111"}})];
    let clients = [("google", "a.apps"), ("google", "b.apps")];
    assert_eq!(register_nonce(SIGNER, &owners, &clients, true), "xA2-3kQ9khUjbAuSVgDVjX0Zod0TsyybLvJJudyH1VU");
    assert_eq!(register_nonce(SIGNER, &owners, &[], false), "Lygc8SKa48_I2ugyVhY1963F5dR5tmrv7bi685BkbpQ");
}

#[test]
fn client_proof_nonce_vector() {
    assert_eq!(client_proof_nonce(SIGNER, "s1a", 5), "5JoCXgPwm9X678lQDVwtzvdbwrZfYcQ6cSziRWmvlwM");
}

#[test]
fn owner_action_nonce_vectors() {
    // propose_change(scope_id "s1", SetAllowShared { allow: true }, client_proof None), action_nonce 4.
    let mut args = borsh_str("s1");
    args.extend(borsh_change(&json!({"SetAllowShared": {"allow": true}})));
    args.extend(borsh_opt_str(None));
    assert_eq!(owner_action_nonce(SIGNER, "s1", "propose_change", &args, 4), "Gl9kNtDrvzc-aJirAHai1X51qBHG_f3g5ASphthPde0");
    // disable_shared_login(scope_id "s1"), action_nonce 0.
    assert_eq!(owner_action_nonce(SIGNER, "s1", "disable_shared_login", &borsh_str("s1"), 0), "Q4PPCzkgOtN8I1wvIXbJb9mTV2GWMJ0j81p0a7RRTBY");
}

#[test]
fn session_message_vector() {
    let msg = session_message(2, &ckd_payload("p1", "p2"));
    let hex: String = msg.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(hex, "68616e612d69642d73657373696f6e2d76313a0200000000000000dc3657e76fe5a5a53f309f61cb30e98c3e470e32ef7a1bcf0b15ebfd496b4b97");
}
