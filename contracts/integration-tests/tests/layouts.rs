//! Known-answer checks of this crate's byte layouts (tests/common/mod.rs) against vectors computed by a separate
//! Python implementation of docs/batch-a2-shared-client.md and the vault message of docs/batch-b-spec.md (hashlib +
//! struct, written from the spec tables, not from either Rust implementation). No sandbox needed:
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
    // The highest key_index create_session accepts (2^31 - 1), with max_uses 1 (a 'session'-mode login, batch B).
    assert_eq!(session_nonce(SIGNER, "s1", &pk, 1_800_003_600_000, 0x7fff_ffff, 1, &salt), "Xmr66HxtWjh1HoRIJFQ98nVeBVVgjmPHJW6LLF2qpw0");
}

#[test]
fn vault_message_vector() {
    let share_id: [u8; 16] = std::array::from_fn(|i| i as u8 + 1);
    let msg = vault_message(SIGNER, "app_test", &share_id, 1, b"unlock");
    let hex: String = msg.iter().map(|b| format!("{b:02x}")).collect();
    assert_eq!(
        hex,
        "68616e612d69642d7661756c742d76313a100000007369676e65722e746573742e6e656172080000006170705f746573740102030405060708090a0b0c0d0e0f100100000000000000787600ebe6d6c75b6bc0b2db0bfd6aeec78897b67d3192e2208bc8b714237841"
    );
    // It can never be mistaken for a session message (derive_key / revoke_session).
    assert!(!msg.starts_with(b"hana-id-session-v1:"));
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

/// The email-login layouts of tests/common/mod.rs (identity key, the four link nonces, the linked CKD payload)
/// against the worked examples of a separate JS implementation (contracts/hana-signer/scripts/gen-email-fixtures.mjs,
/// written to contracts/hana-signer/src/email_fixture.json), so the sandbox tests mint what the issuer and vault will.
#[test]
fn email_layouts_match_the_js_worked_examples() {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../hana-signer/src/email_fixture.json");
    let f: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&path).expect("email_fixture.json")).unwrap();
    let ex = |name: &str| f["layouts"][name].clone();
    let signer = f["signer"].as_str().unwrap();
    let email_sub = f["email_sub"].as_str().unwrap();
    let (g, e) = (identity_key("s1", "google", "1098765432"), identity_key("s1", "email", email_sub));
    assert_eq!(hex(&g), ex("identity_key_google")["ik"].as_str().unwrap());
    assert_eq!(hex(&e), ex("identity_key_email")["ik"].as_str().unwrap());
    let salt = [9u8; 16];
    // The auto_link examples commit to the session nonce preimage of test_fixture.json's session nonce example: scope
    // s1, the Ed25519 key of seed [7; 32], expiry 1800003600000, key_index 0, max_uses 3, salt [9; 16]. Computed here
    // with this crate's own session_nonce_preimage (not read from the fixture), then checked against the part the JS
    // implementation wrote.
    let pk7 = ed25519_dalek::SigningKey::from_bytes(&[7u8; 32]).verifying_key().to_bytes();
    let own_hash = sha256(&session_nonce_preimage(signer, "s1", &pk7, 1_800_003_600_000, 0, 3, &[9u8; 16]));
    let session_hash = |name: &str| {
        let parts = ex(name)["parts"].as_array().unwrap().clone();
        let part = parts.iter().find(|p| p[0].as_str().unwrap().starts_with("sha256(session nonce preimage)")).expect("session hash part").clone();
        assert_eq!(part[1].as_str().unwrap(), hex(&own_hash), "{name}: session nonce preimage hash");
        own_hash.clone()
    };
    let checks: Vec<(&str, Vec<u8>)> = vec![
        ("link_new", link_new_preimage(signer, "s1", &g, "email", 7, &salt)),
        ("link_account", link_account_preimage(signer, "s1", &g, &e, 7, &salt)),
        ("link_change_cancel", link_change_preimage(signer, "s1", "cancel", &g, &e, 8, &salt)),
        ("link_change_unlink", link_change_preimage(signer, "s1", "unlink", &g, &e, 8, &salt)),
        ("auto_link_immediate", auto_link_preimage(signer, "s1", &session_hash("auto_link_immediate"), &g, JOIN_SESSION, &g, &e, 3, true)),
        ("auto_link_delayed", auto_link_preimage(signer, "s1", &session_hash("auto_link_delayed"), &g, JOIN_LINK, &e, &g, 3, false)),
    ];
    for (name, preimage) in checks {
        assert_eq!(hex(&preimage), ex(name)["preimage_hex"].as_str().unwrap(), "{name}");
        assert_eq!(nonce_of(&preimage), ex(name)["nonce"].as_str().unwrap(), "{name}");
    }
    let payload = linked_ckd_payload(r#"{"payload":"e30","signatures":[]}"#, true, "bls12381g1:A", "bls12381g2:B");
    assert_eq!(hex(&payload), ex("ckd_link_payload")["preimage_hex"].as_str().unwrap());
}
