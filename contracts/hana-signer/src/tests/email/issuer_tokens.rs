//! Tokens minted by the email issuer's own code (`apps/email-issuer/scripts/gen-contract-fixture.ts`: its layouts, its
//! `judge` of the four cases, its commitment parser, its signer and JWS JSON minting) through the real contract: an
//! email login, automatic links in case A and case B, and `link_identity` with a `link_account` token. Tests only.

use super::*;

fn ifix() -> Value {
    serde_json::from_str(include_str!("../../issuer_tokens_fixture.json")).unwrap()
}

fn itok(name: &str) -> String {
    ifix()["tokens"][name].as_str().unwrap().to_string()
}

fn isub() -> String {
    ifix()["email_sub"].as_str().unwrap().to_string()
}

/// email_setup() with the issuer's key active for signer `hana` (owner-posted, after the governance delay).
fn issuer_setup() -> HanaSigner {
    let mut c = email_setup();
    let f = ifix();
    assert_eq!(f["signer"], ME);
    assert_eq!(f["iss"].as_str().unwrap(), email_iss());
    for seed in [7u8, 8, 9] {
        assert_eq!(hex(&pk(seed)), f["session_pk_hex"][seed.to_string()].as_str().unwrap(), "session key {seed}");
    }
    ctx(ADMIN, NOW_MS);
    let id = c.set_issuer_key(EMAIL.into(), f["kid"].as_str().unwrap().into(), f["n"].as_str().unwrap().into(), f["e"].as_str().unwrap().into(), Some("hana".into()));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
    c
}

fn email_path() -> String {
    format!("s1#email#{}#0", isub())
}

#[test]
fn an_issuer_minted_email_token_logs_in() {
    let mut c = issuer_setup();
    login(&mut c, itok("session_e7"), 7, None, None);
    assert_eq!(path_of(&c, 7), email_path());
    assert_eq!(mpc_path(), email_path());
}

#[test]
fn an_issuer_minted_auto_link_token_joins_google_to_the_email_wallet_case_a() {
    let mut c = issuer_setup();
    login(&mut c, itok("session_e7"), 7, None, None);
    let g = ifix()["google"].as_str().unwrap().to_string();
    login(&mut c, g_session(&g, 8), 8, Some(itok("auto_link_a_g8")), Some(true));
    // The Google login opens the email identity's wallet: one person, one wallet.
    assert_eq!(path_of(&c, 8), email_path());
    let account = c.get_identity("s1".into(), "google".into(), g);
    assert_eq!(account.status, "member");
}

#[test]
fn an_issuer_minted_auto_link_token_joins_email_to_the_google_wallet_case_b() {
    let mut c = issuer_setup();
    let g = ifix()["google"].as_str().unwrap().to_string();
    login(&mut c, g_session(&g, 7), 7, None, None);
    let google_path = format!("s1#google#{g}#0");
    assert_eq!(path_of(&c, 7), google_path);
    login(&mut c, g_session(&g, 8), 8, Some(itok("auto_link_b_g8")), Some(true));
    assert_eq!(path_of(&c, 8), google_path);
    // A later email login (key 9) opens the Google wallet.
    login(&mut c, itok("session_e9"), 9, None, None);
    assert_eq!(path_of(&c, 9), google_path);
}

#[test]
fn an_issuer_minted_link_account_token_proves_the_account_in_link_identity() {
    let mut c = issuer_setup();
    login(&mut c, itok("session_e7"), 7, None, None);
    let g2 = ifix()["google2"].as_str().unwrap().to_string();
    let root = eik(&isub());
    let new_nonce = nonce_of(&link_new_preimage(ME, "s1", &root, "google", 0, &SALT));
    ctx(RELAYER, NOW_MS);
    let effective = c.link_identity("s1".into(), itok("link_account_e_g2"), google_tok(A, &g2, &new_nonce), 0, SALT.to_vec());
    assert!(effective > NOW_MS);
    assert_eq!(c.get_identity("s1".into(), "google".into(), g2).status, "pending");
    // A token for another purpose can't stand in for it.
    let mut c = issuer_setup();
    login(&mut c, itok("session_e7"), 7, None, None);
    let g2 = ifix()["google2"].as_str().unwrap().to_string();
    ctx(RELAYER, NOW_MS);
    expect_panic("Link nonce doesn't match", || {
        let _ = c.link_identity("s1".into(), itok("session_e9"), google_tok(A, &g2, &new_nonce), 0, SALT.to_vec());
    });
}

/// issuer_setup() with s3 = owners [bob], clients [google "app-s3"]: no email client yet, action_nonce 0.
fn issuer_setup_with_s3() -> HanaSigner {
    let mut c = issuer_setup();
    ctx(ADMIN, NOW_MS);
    assert_eq!(c.admin_register_scope(vec![near_owner(BOB)], vec![google("app-s3.apps.googleusercontent.com")], None, false), "s3");
    assert_eq!(c.get_scope("s3".into()).unwrap().action_nonce, 0);
    c
}

fn add_email(scope: &str) -> Change {
    Change::AddClient { provider: EMAIL.into(), aud: format!("email:{scope}") }
}

#[test]
fn an_issuer_minted_client_proof_adds_the_email_client() {
    // The claims and nonce of apps/email-issuer/src/client-proof.ts, which the issuer's staff route and the dev-env
    // CLI's local mint (`admin scope:add-email-client`, D253) both use.
    let mut c = issuer_setup_with_s3();
    ctx(BOB, NOW_MS);
    let id = c.propose_change("s3".into(), OwnerAuth::Near, add_email("s3"), Some(itok("client_proof_s3_0")));
    assert_eq!(id, 0);
    assert_eq!(c.get_scope("s3".into()).unwrap().pending[0].change, add_email("s3"));
    ctx(ANYONE, NOW_MS + DELAY_MS);
    c.execute_change("s3".into(), id);
    let s3 = c.get_scope("s3".into()).unwrap();
    assert!(s3.clients.contains(&(EMAIL.to_string(), "email:s3".to_string())));
    assert_eq!(c.scope_for_client(EMAIL.into(), "email:s3".into()), Some("s3".into()));
}

#[test]
fn an_issuer_minted_client_proof_is_bound_to_its_scope_nonce_client_and_lifetime() {
    // A later action_nonce: stale.
    let mut c = issuer_setup_with_s3();
    ctx(BOB, NOW_MS);
    let id = c.propose_change("s3".into(), OwnerAuth::Near, Change::SetOwners { owners: vec![near_owner(BOB), near_owner(ALICE)] }, None);
    c.cancel_change("s3".into(), OwnerAuth::Near, id);
    expect_panic("Client proof nonce doesn't match", || {
        let _ = c.propose_change("s3".into(), OwnerAuth::Near, add_email("s3"), Some(itok("client_proof_s3_0")));
    });
    // Another client than the proof's.
    let mut c = issuer_setup_with_s3();
    ctx(BOB, NOW_MS);
    expect_panic("Client proof is for another client", || {
        let _ = c.propose_change("s3".into(), OwnerAuth::Near, add_email("s4"), Some(itok("client_proof_s3_0")));
    });
    // Expired: its exp is iat + 600 s, and the fixture's iat is NOW - 60 s.
    let mut c = issuer_setup_with_s3();
    ctx(BOB, NOW_MS + 540_000);
    expect_panic("Token expired", || {
        let _ = c.propose_change("s3".into(), OwnerAuth::Near, add_email("s3"), Some(itok("client_proof_s3_0")));
    });
}
