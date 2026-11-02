//! Email login unit tests (`docs/email-login-spec.md` "Tests" → "Contract unit"): self-issued issuers and the signer
//! policy, JWS JSON verification, identity keys and path resolution, the four automatic-linking cases, explicit
//! links, cancel and unlink, the views, and the v2 → v3 migration.
//!
//! Tokens: `email_fixture.json` (JS-signed, `scripts/gen-email-fixtures.mjs`) for interoperability and layouts;
//! everything else is minted here with the deterministic test keys of `test_rsa.rs`.

use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::get_created_receipts;
use near_sdk::{env, NearToken};

use super::*;
use crate::links::{
    auto_link_preimage, identity_key_preimage, ik, link_account_preimage, link_change_preimage, link_new_preimage, nonce_of, IdentityKey, JOIN_LINK_IDENTITY, JOIN_SESSION_IDENTITY,
};
use crate::sessions::linked_ckd_request_bytes;
use crate::test_rsa::{key as rk, TestRsaKey};

const EMAIL: &str = "email";
const NOW_S: u64 = NOW_MS / 1000;
/// Kids of the test keys: rk(0) = hana primary, rk(1) = hana standby, rk(2) = the co-signer, rk(3) = an attacker's,
/// rk(4) = a Google key (compact tokens with any nonce), rk(5) = issuers p1..p3 (compact).
const HANA_KID: &str = "hana-1";
const HANA2_KID: &str = "hana-2";
const COSIGN_KID: &str = "cosign-1";
const GOOGLE_KID: &str = "rg-1";
const P_KID: &str = "rp-1";

const G: &str = "g-alice";
const G2: &str = "g-bob";

fn efix() -> Value {
    serde_json::from_str(include_str!("../email_fixture.json")).unwrap()
}

fn email_iss() -> String {
    efix()["email_iss"].as_str().unwrap().to_string()
}

/// A valid email `sub` (the issuer's shape: "e1." + 43 base64url characters).
fn esub(name: &str) -> String {
    format!("e1.{}", oidc::b64url(&env::sha256(name.as_bytes())))
}

fn gik(sub: &str) -> IdentityKey {
    ik("s1", "google", sub)
}

fn eik(sub: &str) -> IdentityKey {
    ik("s1", EMAIL, sub)
}

fn h(key: &IdentityKey) -> String {
    crate::links::hex(key)
}

fn claims(iss: &str, aud: &str, sub: &str, nonce: &str) -> Value {
    json!({ "iss": iss, "aud": aud, "sub": sub, "iat": NOW_S - 60, "exp": NOW_S + 3 * 3600, "nonce": nonce, "jti": "AAECAwQFBgcICQoLDA0ODw" })
}

fn b64(value: &impl serde::Serialize) -> String {
    oidc::b64url(serde_json::to_string(value).unwrap().as_bytes())
}

/// One JWS JSON signature entry over `payload` with `header` as the protected header.
fn entry(key: &TestRsaKey, header: &Value, payload: &str) -> Value {
    let prot = b64(header);
    let sig = key.sign(format!("{prot}.{payload}").as_bytes());
    json!({ "protected": prot, "signature": oidc::b64url(&sig) })
}

/// A JWS General JSON Serialization token over `claims`, one RS256 signature per (key, kid).
fn jws(claims: &Value, sigs: &[(&TestRsaKey, &str)]) -> String {
    let payload = b64(claims);
    let signatures: Vec<Value> = sigs.iter().map(|(k, kid)| entry(k, &json!({"alg":"RS256","kid":kid}), &payload)).collect();
    json!({ "payload": payload, "signatures": signatures }).to_string()
}

/// An email token for scope s1's (or `aud`'s) email client signed by hana's primary key.
fn email_tok(aud: &str, sub: &str, nonce: &str) -> String {
    jws(&claims(&email_iss(), aud, sub, nonce), &[(rk(0), HANA_KID)])
}

/// A compact RS256 JWT signed by `key` under `kid`.
fn compact(key: &TestRsaKey, kid: &str, claims: &Value) -> String {
    let input = format!("{}.{}", b64(&json!({"alg":"RS256","kid":kid,"typ":"JWT"})), b64(claims));
    let sig = key.sign(input.as_bytes());
    format!("{input}.{}", oidc::b64url(&sig))
}

fn google_tok(aud: &str, sub: &str, nonce: &str) -> String {
    compact(rk(4), GOOGLE_KID, &claims("https://accounts.google.com", aud, sub, nonce))
}

/// The session nonce preimage for key `seed` in `scope` (expiry EXPIRES_MS, max_uses 3, salt SALT).
fn sess_preimage(scope: &str, seed: u8, key_index: u32) -> Vec<u8> {
    let key = pk(seed);
    sessions::session_nonce_preimage(&commitment(ME, scope, &key, EXPIRES_MS, key_index))
}

fn sess_nonce(scope: &str, seed: u8) -> String {
    nonce_of(&sess_preimage(scope, seed, 0))
}

/// A Google session token in s1 for key `seed`.
fn g_session(sub: &str, seed: u8) -> String {
    google_tok(A, sub, &sess_nonce("s1", seed))
}

/// An email session token in s1 for key `seed`.
fn e_session(sub: &str, seed: u8) -> String {
    email_tok("email:s1", sub, &sess_nonce("s1", seed))
}

/// The session expiry `login_at` uses for a login at `ms`: an hour later (EXPIRES_MS at NOW_MS).
fn expiry_at(ms: u64) -> u64 {
    ms + HOUR_MS
}

/// An email session token in s1 for key `seed`, for a login at `ms` (`login_at`).
fn e_session_at(sub: &str, seed: u8, ms: u64) -> String {
    let key = pk(seed);
    let preimage = sessions::session_nonce_preimage(&commitment(ME, "s1", &key, expiry_at(ms), 0));
    email_tok("email:s1", sub, &nonce_of(&preimage))
}

/// The join an `auto_link` token commits to (as the issuer decides it): case A, the session identity joins the
/// account of root `.0`; case B (or C), the link identity joins the account of root `.0`.
#[derive(Clone, Copy)]
enum Join {
    A(IdentityKey),
    B(IdentityKey),
}

/// Case A into E's account (root `eik(sub)`).
fn ja(sub: &str) -> Join {
    Join::A(eik(sub))
}

/// Case B into the Google identity `g`'s account (root `gik(g)`).
fn jb(g: &str) -> Join {
    Join::B(gik(g))
}

/// The `auto_link` token for a login in s1 with key `seed` by `session_ik`, for the email identity `sub`, with `join`.
fn auto_link_tok(sub: &str, seed: u8, session_ik: &IdentityKey, target_epoch: u64, immediate: bool, join: Join) -> String {
    let hash = env::sha256_array(sess_preimage("s1", seed, 0));
    let (code, joiner, target) = match join {
        Join::A(target) => (JOIN_SESSION_IDENTITY, *session_ik, target),
        Join::B(target) => (JOIN_LINK_IDENTITY, eik(sub), target),
    };
    email_tok("email:s1", sub, &nonce_of(&auto_link_preimage(ME, "s1", &hash, session_ik, code, &joiner, &target, target_epoch, immediate)))
}

/// The session key's counter-1 signature of a combined login: over the plain CKD payload, or with a link over the
/// linked one (D133).
fn login_sig(seed: u8, link_jwt: Option<&str>, immediate: Option<bool>) -> Vec<u8> {
    match link_jwt {
        Some(link) => session_sig(seed, 1, &linked_ckd_request_bytes(PK1, PK2, link, immediate.unwrap_or(false))),
        None => ckd_sig(seed, 1, PK1, PK2),
    }
}

/// `create_session_and_derive` in s1 for key `seed` (key_index 0, max_uses 3, expiry `expiry_at(ms)`) as RELAYER at
/// `ms`, signed by the session key as the vault signs it.
fn login_at(c: &mut HanaSigner, ms: u64, jwt: String, seed: u8, link_jwt: Option<String>, immediate: Option<bool>) {
    ctx(RELAYER, ms);
    let sig = login_sig(seed, link_jwt.as_deref(), immediate);
    let _ = c.create_session_and_derive(jwt, "s1".into(), pk(seed), expiry_at(ms), SALT.to_vec(), 0, 3, sig, PK1.into(), PK2.into(), link_jwt, immediate);
}

fn login(c: &mut HanaSigner, jwt: String, seed: u8, link_jwt: Option<String>, immediate: Option<bool>) {
    login_at(c, NOW_MS, jwt, seed, link_jwt, immediate);
}

fn path_of(c: &HanaSigner, seed: u8) -> String {
    c.get_session(pk(seed)).expect("session").path
}

/// The MPC request's derivation path of the last call.
fn mpc_path() -> String {
    let receipts = get_created_receipts();
    let MockAction::FunctionCallWeight { args, .. } = &receipts.last().expect("an MPC request").actions[0] else { panic!("not a function call") };
    let args: Value = serde_json::from_slice(args).unwrap();
    args["request"]["derivation_path"].as_str().unwrap().to_string()
}

fn post_owner_key(c: &mut HanaSigner, provider: &str, kid: &str, key: &TestRsaKey, signer: Option<&str>) -> u64 {
    ctx(ADMIN, NOW_MS);
    c.set_issuer_key(provider.into(), kid.into(), key.n_b64(), key.e_b64(), signer.map(String::from))
}

/// setup() with email login: built with zero delays (so keys are in force at once), then the delays of setup().
/// Issuers: google (fixture key test-kid and test key rg-1), email (self-issued, signer hana: hana-1 and hana-2),
/// p1, p2, p3 (compact, key rp-1, for filling accounts). Scopes: s1 = owners [alice, Oidc owner-111], clients
/// [google A, google A2, email email:s1, p1/p2/p3 "p:s1"]; s2 = owners [bob], clients [google B, email email:s2].
/// WATCHDOG may confirm from NOW_MS.
fn email_setup() -> HanaSigner {
    ctx_with_storage(ADMIN, NOW_MS, Default::default());
    let f = fixture();
    let mut c = HanaSigner::new(acc(ADMIN), acc("v1.signer-prod.testnet"), 2, 0, 0, 0, vec![], vec![]);
    c.set_issuer("google".into(), vec!["https://accounts.google.com".into(), "accounts.google.com".into()]);
    for (kid, n, e) in [("test-kid", f["n"].as_str().unwrap().to_string(), f["e"].as_str().unwrap().to_string()), (GOOGLE_KID, rk(4).n_b64(), rk(4).e_b64())] {
        let id = c.set_issuer_key("google".into(), kid.into(), n, e, None);
        c.execute_issuer_key_change(id);
    }
    c.set_issuer(EMAIL.into(), vec![email_iss()]);
    c.mark_self_issued(EMAIL.into());
    for (kid, key) in [(HANA_KID, rk(0)), (HANA2_KID, rk(1))] {
        let id = c.set_issuer_key(EMAIL.into(), kid.into(), key.n_b64(), key.e_b64(), Some("hana".into()));
        c.execute_issuer_key_change(id);
    }
    for p in ["p1", "p2", "p3"] {
        c.set_issuer(p.into(), vec![format!("https://{p}.example")]);
        let id = c.set_issuer_key(p.into(), P_KID.into(), rk(5).n_b64(), rk(5).e_b64(), None);
        c.execute_issuer_key_change(id);
    }
    c.set_console_audiences(vec![google(CONSOLE)]);
    c.set_sponsors(vec![acc(RELAYER)]);
    c.add_watchdog(acc(WATCHDOG));
    c.set_change_delay_ms(DELAY_MS);
    c.set_issuer_key_delay_ms(KEY_DELAY_MS);
    c.set_governance_delay_ms(GOV_DELAY_MS);
    let mut s1 = vec![google(A), google(A2), (EMAIL.into(), "email:s1".into())];
    s1.extend(["p1", "p2", "p3"].map(|p| (p.to_string(), "p:s1".to_string())));
    assert_eq!(c.admin_register_scope(vec![near_owner(ALICE), oidc_owner(OWNER_SUB)], s1, None, false), "s1");
    assert_eq!(c.admin_register_scope(vec![near_owner(BOB)], vec![google(B), (EMAIL.into(), "email:s2".into())], None, false), "s2");
    c
}

/// A compact token of issuer `p` (p1..p3) for scope s1's client.
fn p_tok(p: &str, sub: &str, nonce: &str) -> String {
    compact(rk(5), P_KID, &claims(&format!("https://{p}.example"), "p:s1", sub, nonce))
}

fn ev12(event: &str, data: Value) -> Value {
    json!({"standard":"hana-id","version":"1.2.0","event":event,"data":[data]})
}

fn events_named(name: &str) -> Vec<Value> {
    events().into_iter().filter(|e| e["event"] == name).map(|e| e["data"][0].clone()).collect()
}

// ===================================================================================================================
// Byte layouts and JS interoperability
// ===================================================================================================================

fn check_email_layout(name: &str, rust_bytes: &[u8], rust_nonce: Option<String>) {
    let f = efix();
    let ex = &f["layouts"][name];
    assert!(ex.is_object(), "no layout example {name}");
    assert_eq!(hex(rust_bytes), ex["preimage_hex"].as_str().unwrap(), "{name}: Rust bytes differ from the JS implementation");
    match rust_nonce {
        Some(nonce) => assert_eq!(nonce, ex["nonce"].as_str().unwrap(), "{name}: nonce"),
        None => assert!(ex.get("nonce").is_none(), "{name}: unexpected nonce"),
    }
}

#[test]
fn email_layouts_match_the_js_implementation() {
    ctx(ADMIN, NOW_MS);
    let f = efix();
    assert_eq!(f["signer"], ME);
    let email_sub = f["email_sub"].as_str().unwrap();
    assert_eq!(email_sub.len(), 46);
    let g = gik(USER);
    let e = eik(email_sub);
    check_email_layout("identity_key_google", &identity_key_preimage("s1", "google", USER), None);
    check_email_layout("identity_key_email", &identity_key_preimage("s1", EMAIL, email_sub), None);
    assert_eq!(h(&g), f["layouts"]["identity_key_google"]["ik"].as_str().unwrap());
    assert_eq!(h(&e), f["layouts"]["identity_key_email"]["ik"].as_str().unwrap());
    let p = link_new_preimage(ME, "s1", &g, EMAIL, 7, &SALT);
    check_email_layout("link_new", &p, Some(nonce_of(&p)));
    let p = link_account_preimage(ME, "s1", &g, &e, 7, &SALT);
    check_email_layout("link_account", &p, Some(nonce_of(&p)));
    let p = link_change_preimage(ME, "s1", "cancel", &g, &e, 8, &SALT);
    check_email_layout("link_change_cancel", &p, Some(nonce_of(&p)));
    let p = link_change_preimage(ME, "s1", "unlink", &g, &e, 8, &SALT);
    check_email_layout("link_change_unlink", &p, Some(nonce_of(&p)));
    let hash = env::sha256_array(sess_preimage("s1", 7, 0));
    let p = auto_link_preimage(ME, "s1", &hash, &g, JOIN_SESSION_IDENTITY, &g, &e, 3, true);
    check_email_layout("auto_link_immediate", &p, Some(nonce_of(&p)));
    let p = auto_link_preimage(ME, "s1", &hash, &g, JOIN_LINK_IDENTITY, &e, &g, 3, false);
    check_email_layout("auto_link_delayed", &p, Some(nonce_of(&p)));
    check_email_layout("ckd_link_payload", &linked_ckd_request_bytes("bls12381g1:A", "bls12381g2:B", r#"{"payload":"e30","signatures":[]}"#, true), None);
    // The linked payload can never equal a plain CKD payload (other domain).
    assert!(!linked_ckd_request_bytes(PK1, PK2, "x", true).starts_with(b"hana-id-ckd-v1:"));
    // The view gives the same key.
    let c = email_setup();
    assert_eq!(c.identity_key("s1".into(), "google".into(), USER.into()), h(&g));
}

/// email_setup() plus the JS fixture's hana key (kid hana-email-1) for signer hana, active.
fn with_js_email_key(c: &mut HanaSigner) {
    let f = efix();
    ctx(ADMIN, NOW_MS);
    let id = c.set_issuer_key(EMAIL.into(), f["email_kid"].as_str().unwrap().into(), f["email_n"].as_str().unwrap().into(), f["email_e"].as_str().unwrap().into(), Some("hana".into()));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
}

const ANYONE: &str = "anyone.testnet";

fn efix_tok(name: &str) -> String {
    efix()["tokens"][name].as_str().unwrap().to_string()
}

#[test]
fn js_signed_jws_tokens_verify() {
    let mut c = email_setup();
    with_js_email_key(&mut c);
    let f = efix();
    let sub = f["email_sub"].as_str().unwrap();
    // A 1-of-1 token, and the same claims with an extra co-signature (a signer not in the policy can't be counted:
    // its kid isn't an active key of this issuer).
    ctx(RELAYER, NOW_MS);
    let s = c.create_session_signed(efix_tok("email_session_s1"), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3);
    assert_eq!(s.path, format!("s1#email#{sub}#0"));
    ctx(RELAYER, NOW_MS);
    expect_panic("Unknown signing key", || drop(c.create_session_signed(efix_tok("email_session_s1_cosigned"), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3)));
    // With the co-signer in a 2-of-2 policy (a governed upgrade's migrate), the two-signature token passes and the
    // co-signer alone doesn't.
    let mut c = email_setup();
    with_js_email_key(&mut c);
    ctx(ME, NOW_MS - POLICY_OVERLAP_MS);
    c.set_signer_policy(
        EMAIL,
        vec!["hana".into(), "cosign".into()],
        2,
        vec![(f["cosign_kid"].as_str().unwrap().into(), "cosign".into(), js_key("cosign"))], true,
    );
    ctx(RELAYER, NOW_MS);
    expect_panic("Not enough signatures", || drop(c.create_session_signed(efix_tok("email_session_s1_cosign_only"), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3)));
    let s = c.create_session_signed(efix_tok("email_session_s1_cosigned"), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3);
    assert_eq!(s.path, format!("s1#email#{sub}#0"));
}

fn js_key(which: &str) -> crate::issuers::RsaKey {
    let f = efix();
    let part = |name: &str| oidc::decode_jwk_part(f[format!("{which}_{name}")].as_str().unwrap()).unwrap();
    crate::issuers::RsaKey { n: part("n"), e: part("e") }
}

// ===================================================================================================================
// Self-issued issuers: marking, key posting, delays, policy
// ===================================================================================================================

#[test]
fn mark_self_issued_is_one_way_on_a_fresh_issuer() {
    let mut c = setup();
    ctx(MALLORY, NOW_MS);
    expect_panic("Only the owner can do this", || c.mark_self_issued(EMAIL.into()));
    ctx(ADMIN, NOW_MS);
    expect_panic("Unknown issuer", || c.mark_self_issued(EMAIL.into()));
    // Only the email provider; an email issuer with a pending key change can't become self-issued.
    expect_panic("Only the email issuer can be self-issued", || c.mark_self_issued("google".into()));
    c.set_issuer(EMAIL.into(), vec![email_iss()]);
    let id = c.set_issuer_key(EMAIL.into(), "early".into(), rk(0).n_b64(), rk(0).e_b64(), None);
    expect_panic("Issuer already has keys", || c.mark_self_issued(EMAIL.into()));
    c.cancel_issuer_key_change(id);
    c.mark_self_issued(EMAIL.into());
    assert_eq!(events_named("issuer_self_issued"), vec![json!({"provider":EMAIL})]);
    assert_eq!(
        c.get_self_issued(EMAIL.into()),
        Some(SelfIssuedView { provider: EMAIL.into(), signers: vec![SignerView { id: "hana".into(), kids: vec![] }], required: 1, overlap_until_ms: None })
    );
    assert_eq!(c.get_self_issued("google".into()), None);
    // One way, and a second call can't reset a policy.
    expect_panic("Issuer is already self-issued", || c.mark_self_issued(EMAIL.into()));
}

#[test]
fn google_can_never_be_marked_self_issued() {
    // Review LOW-3: an owner who removes Google's keys can't then mark google self-issued (one way), which would stop
    // every Google login until a governed upgrade. Nor any other provider but email.
    let mut c = setup();
    ctx(ADMIN, NOW_MS);
    assert!(c.remove_issuer_key("google".into(), "test-kid".into()));
    assert!(c.get_issuer("google".into()).unwrap().kids.is_empty());
    expect_panic("Only the email issuer can be self-issued", || c.mark_self_issued("google".into()));
    c.set_issuer("other".into(), vec!["https://other.example".into()]);
    expect_panic("Only the email issuer can be self-issued", || c.mark_self_issued("other".into()));
    assert_eq!(c.get_self_issued("google".into()), None);
    assert_eq!(SELF_ISSUABLE, ["email"]);
}

#[test]
fn self_issued_keys_are_owner_posted_for_a_listed_signer() {
    let mut c = email_setup();
    // The updater key ("self") can post Google keys but no key of a self-issued issuer, nor propose removing one.
    ctx(ME, NOW_MS);
    expect_panic("Only the owner posts keys for this issuer", || { let _ = c.set_issuer_key(EMAIL.into(), "k".into(), rk(3).n_b64(), rk(3).e_b64(), Some("hana".into())); });
    expect_panic("Only the owner posts keys for this issuer", || { let _ = c.propose_issuer_key_removal(EMAIL.into(), HANA2_KID.into()); });
    ctx(ADMIN, NOW_MS);
    expect_panic("Unknown signer", || { let _ = c.set_issuer_key(EMAIL.into(), "k".into(), rk(3).n_b64(), rk(3).e_b64(), None); });
    expect_panic("Unknown signer", || { let _ = c.set_issuer_key(EMAIL.into(), "k".into(), rk(3).n_b64(), rk(3).e_b64(), Some("cosign".into())); });
    expect_panic("Only a self-issued issuer takes a signer", || { let _ = c.set_issuer_key("google".into(), "k".into(), rk(3).n_b64(), rk(3).e_b64(), Some("hana".into())); });
    // The owner's proposal names its signer in the event and the view; Google's views carry no signer field.
    let id = post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    let proposed = events_named("issuer_key_proposed");
    assert_eq!(proposed[0]["signer"], "hana");
    assert_eq!(proposed[0]["executable_at_ms"], NOW_MS + GOV_DELAY_MS);
    let view = serde_json::to_value(c.get_key_changes()).unwrap();
    assert_eq!(view[0]["signer"], "hana");
    assert_eq!(view[0]["op"], "Add");
    let gid = post_owner_key(&mut c, "google", "g-new", rk(3), None);
    let view = serde_json::to_value(c.get_key_changes()).unwrap();
    assert!(view[1].get("signer").is_none(), "a Google key change has no signer field: {}", view[1]);
    assert!(!events_named("issuer_key_proposed")[0].as_object().unwrap().contains_key("signer"));
    // Google's change is confirmable early and waits the issuer-key delay; the email one waits the governance delay
    // and a watchdog can't confirm it.
    assert_eq!(c.get_key_changes()[1].executable_at_ms, NOW_MS + KEY_DELAY_MS);
    ctx(WATCHDOG, NOW_MS);
    expect_panic("Keys of a self-issued issuer can't be confirmed early", || c.confirm_issuer_key_change(id));
    c.confirm_issuer_key_change(gid);
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS - 1);
    expect_panic("Key change is still delayed", || c.execute_issuer_key_change(id));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers, vec![SignerView { id: "hana".into(), kids: vec![HANA_KID.into(), HANA2_KID.into(), "hana-3".into()] }]);
}

#[test]
fn self_issued_keys_wait_the_longer_of_the_governance_and_the_key_delays() {
    let mut c = email_setup();
    // Issuer-key delay 30 min < governance delay 2 h: the governance delay.
    let id = post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    assert_eq!(c.get_key_changes()[0].executable_at_ms, NOW_MS + GOV_DELAY_MS);
    // The owner and a watchdog may cancel it.
    ctx(WATCHDOG, NOW_MS);
    c.cancel_issuer_key_change(id);
    assert!(c.get_key_changes().is_empty());
    // Issuer-key delay 3 h > governance delay: the issuer-key delay (every other rule still applies).
    ctx(ADMIN, NOW_MS);
    c.set_issuer_key_delay_ms(3 * HOUR_MS);
    post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    assert_eq!(c.get_key_changes()[0].executable_at_ms, NOW_MS + 3 * HOUR_MS);
}

#[test]
fn one_rsa_key_never_belongs_to_two_signers_or_two_kids() {
    let mut c = email_setup();
    // Same modulus as an active key, under another kid (with the same or another exponent).
    ctx(ADMIN, NOW_MS);
    expect_panic("Key is already registered", || { let _ = c.set_issuer_key(EMAIL.into(), "dup".into(), rk(0).n_b64(), rk(0).e_b64(), Some("hana".into())); });
    expect_panic("Key is already registered", || { let _ = c.set_issuer_key(EMAIL.into(), "dup".into(), rk(0).n_b64(), "Aw".into(), Some("hana".into())); });
    // Same modulus as a pending key.
    post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    ctx(ADMIN, NOW_MS);
    expect_panic("Key is already registered", || { let _ = c.set_issuer_key(EMAIL.into(), "dup".into(), rk(3).n_b64(), rk(3).e_b64(), Some("hana".into())); });
    // A governed upgrade can't install it for another signer either.
    ctx(ME, NOW_MS);
    expect_panic("Key is already registered", || {
        c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![("cosign-1".into(), "cosign".into(), crate::issuers::RsaKey { n: rk(0).n.to_bytes_be(), e: rk(0).e.to_bytes_be() })], true);
    });
    // And a pending addition whose key a governed upgrade installed meanwhile can't execute.
    let mut c = email_setup();
    let id = post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    ctx(ME, NOW_MS);
    c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![("cosign-1".into(), "cosign".into(), crate::issuers::RsaKey { n: rk(3).n.to_bytes_be(), e: rk(3).e.to_bytes_be() })], true);
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    expect_panic("Key is already registered", || c.execute_issuer_key_change(id));
}

#[test]
fn a_self_issued_issuer_holds_at_most_eight_keys() {
    let mut c = email_setup();
    // hana-1 and hana-2 are active: six more fit (each executed after its delay), then no more, active or pending.
    let keys: Vec<TestRsaKey> = (100..106).map(TestRsaKey::generate).collect();
    for (i, key) in keys.iter().enumerate() {
        let id = post_owner_key(&mut c, EMAIL, &format!("k{i}"), key, Some("hana"));
        if i < 5 {
            ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
            c.execute_issuer_key_change(id);
        }
    }
    ctx(ADMIN, NOW_MS);
    expect_panic("Too many keys for this issuer", || { let _ = c.set_issuer_key(EMAIL.into(), "k9".into(), rk(3).n_b64(), rk(3).e_b64(), Some("hana".into())); });
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(c.get_key_changes()[0].id);
    assert_eq!(c.get_issuer(EMAIL.into()).unwrap().kids.len(), MAX_SELF_ISSUED_KEYS);
    ctx(ADMIN, NOW_MS);
    expect_panic("Too many keys for this issuer", || { let _ = c.set_issuer_key(EMAIL.into(), "k9".into(), rk(3).n_b64(), rk(3).e_b64(), Some("hana".into())); });
}

#[test]
fn removing_a_self_issued_key_forgets_its_signer() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    let id = c.propose_issuer_key_removal(EMAIL.into(), HANA2_KID.into());
    assert_eq!(c.get_key_changes()[0].executable_at_ms, NOW_MS + GOV_DELAY_MS);
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers[0].kids, vec![HANA_KID.to_string()]);
    // The owner's immediate removal (a suspected compromise): email logins stop with the last key.
    ctx(ADMIN, NOW_MS + GOV_DELAY_MS);
    assert!(c.remove_issuer_key(EMAIL.into(), HANA_KID.into()));
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers[0].kids, Vec::<String>::new());
    ctx(RELAYER, NOW_MS);
    expect_panic("Unknown signing key", || drop(c.create_session_signed(e_session(&esub("a"), 7), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3)));
}

// ===================================================================================================================
// JWS JSON verification
// ===================================================================================================================

fn try_open(c: &mut HanaSigner, jwt: String) -> Result<Session, String> {
    ctx(RELAYER, NOW_MS);
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.create_session_signed(jwt, "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3))).map_err(panic_msg)
}

fn assert_refused(c: &mut HanaSigner, jwt: String, expected: &str) {
    let err = try_open(c, jwt).err().unwrap_or_else(|| panic!("accepted; expected {expected:?}"));
    assert!(err.contains(expected), "{err:?} should contain {expected:?}");
}

#[test]
fn an_email_token_opens_its_own_path_with_either_hana_key() {
    let mut c = email_setup();
    let sub = esub("alice@example.com");
    let s = try_open(&mut c, e_session(&sub, 7)).unwrap();
    assert_eq!(s.path, format!("s1#email#{sub}#0"));
    let mut c = email_setup();
    let token = jws(&claims(&email_iss(), "email:s1", &sub, &sess_nonce("s1", 7)), &[(rk(1), HANA2_KID)]);
    assert_eq!(try_open(&mut c, token).unwrap().path, format!("s1#email#{sub}#0"));
    // Two keys of the one signer: still one signer, and 1-of-1 passes.
    let mut c = email_setup();
    let token = jws(&claims(&email_iss(), "email:s1", &sub, &sess_nonce("s1", 7)), &[(rk(0), HANA_KID), (rk(1), HANA2_KID)]);
    assert!(try_open(&mut c, token).is_ok());
}

#[test]
fn each_issuer_takes_only_its_own_token_format() {
    let mut c = email_setup();
    let sub = esub("a");
    let nonce = sess_nonce("s1", 7);
    // An email token in the compact form, signed by hana's real key: refused.
    assert_refused(&mut c, compact(rk(0), HANA_KID, &claims(&email_iss(), "email:s1", &sub, &nonce)), "Wrong token format for this issuer");
    // A Google token in the JSON form, signed by Google's key: refused.
    assert_refused(&mut c, jws(&claims("https://accounts.google.com", A, G, &nonce), &[(rk(4), GOOGLE_KID)]), "Wrong token format for this issuer");
    // And the compact Google token still works.
    assert!(try_open(&mut c, g_session(G, 7)).is_ok());
}

#[test]
fn hostile_jws_json_tokens_are_refused() {
    let mut c = email_setup();
    let sub = esub("a");
    let cl = claims(&email_iss(), "email:s1", &sub, &sess_nonce("s1", 7));
    let payload = b64(&cl);
    let good = entry(rk(0), &json!({"alg":"RS256","kid":HANA_KID}), &payload);
    let token = |v: Value| v.to_string();
    let cases: Vec<(String, &str)> = vec![
        ("{".into(), "Malformed JWS"),
        ("{}".into(), "Malformed JWS"),
        (token(json!({"payload": payload, "signatures": []})), "Malformed JWS"),
        (token(json!({"payload": payload, "signatures": good})), "Malformed JWS"),
        // The flattened form and unprotected headers are not accepted.
        (token(json!({"payload": payload, "protected": good["protected"], "signature": good["signature"]})), "Malformed JWS"),
        (token(json!({"payload": payload, "signatures": [good], "protected": good["protected"]})), "Malformed JWS"),
        (token(json!({"payload": payload, "signatures": [{"protected": good["protected"], "signature": good["signature"], "header": {"kid": HANA2_KID}}]})), "Malformed JWS"),
        // A duplicated member.
        (format!(r#"{{"payload":"{payload}","payload":"{payload}","signatures":[{good}]}}"#), "Malformed JWS"),
        // More than three signatures (each otherwise fine).
        (token(json!({"payload": payload, "signatures": [good, good, good, good]})), "Too many signatures"),
        // The same kid twice.
        (token(json!({"payload": payload, "signatures": [good, good]})), "Duplicate signature kid"),
        // Unknown kids: an attacker's, Google's key id.
        (jws(&cl, &[(rk(3), "evil")]), "Unknown signing key"),
        (jws(&cl, &[(rk(4), GOOGLE_KID)]), "Unknown signing key"),
        // A signer's kid with another key's signature, and a valid signature next to a forged one.
        (jws(&cl, &[(rk(3), HANA_KID)]), "Invalid token signature"),
        (jws(&cl, &[(rk(0), HANA_KID), (rk(3), HANA2_KID)]), "Invalid token signature"),
        // Other algorithms, critical extensions (RFC 7797 b64), headers without a kid.
        (token(json!({"payload": payload, "signatures": [entry(rk(0), &json!({"alg":"RS512","kid":HANA_KID}), &payload)]})), "Unsupported JWT algorithm"),
        (token(json!({"payload": payload, "signatures": [entry(rk(0), &json!({"alg":"none","kid":HANA_KID}), &payload)]})), "Unsupported JWT algorithm"),
        (token(json!({"payload": payload, "signatures": [entry(rk(0), &json!({"alg":"RS256","kid":HANA_KID,"b64":false,"crit":["b64"]}), &payload)]})), "Unsupported JWS header"),
        (token(json!({"payload": payload, "signatures": [entry(rk(0), &json!({"alg":"RS256"}), &payload)]})), "Malformed JWS header"),
        // A payload changed after signing; padding and base64 tricks.
        (token(json!({"payload": b64(&claims(&email_iss(), "email:s1", &esub("b"), &sess_nonce("s1", 7))), "signatures": [good]})), "Invalid token signature"),
        (token(json!({"payload": format!("{payload}*"), "signatures": [good]})), "Malformed base64url"),
        (token(json!({"payload": b64(&"not claims"), "signatures": [good]})), "Malformed JWT claims"),
        (token(json!({"payload": payload, "signatures": [{"protected": good["protected"], "signature": "AAAA"}]})), "Invalid token signature"),
        // Oversized.
        (token(json!({"payload": payload, "signatures": [good], "x": "a".repeat(8000)})), "JWT too large"),
    ];
    for (jwt, expected) in cases {
        assert_refused(&mut c, jwt, expected);
    }
    // The claim checks are today's.
    let expired = json!({ "iss": email_iss(), "aud": "email:s1", "sub": sub, "exp": NOW_S - 1, "nonce": sess_nonce("s1", 7) });
    assert_refused(&mut c, jws(&expired, &[(rk(0), HANA_KID)]), "Token expired");
    assert_refused(&mut c, email_tok("email:s1", "a#b", &sess_nonce("s1", 7)), "Invalid sub");
    assert_refused(&mut c, email_tok("email:s1", &sub, &sess_nonce("s1", 8)), "Token nonce doesn't commit to this session");
    assert_refused(&mut c, email_tok("email:s2", &sub, &sess_nonce("s1", 7)), "Token is for another app");
    assert_refused(&mut c, email_tok("email:s9", &sub, &sess_nonce("s1", 7)), "Token is for an unregistered app");
    // And the good token itself passes.
    assert!(try_open(&mut c, token(json!({"payload": payload, "signatures": [good]}))).is_ok());
}

/// email_setup() with a 2-of-2 policy (hana + cosign, key cosign-1 = rk(2)) set by a governed upgrade at `at`.
fn two_of_two(at: u64) -> HanaSigner {
    let mut c = email_setup();
    ctx(ME, at);
    c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![(COSIGN_KID.into(), "cosign".into(), crate::issuers::RsaKey { n: rk(2).n.to_bytes_be(), e: rk(2).e.to_bytes_be() })], true);
    c
}

#[test]
fn two_of_two_needs_two_distinct_signers() {
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    let cl = claims(&email_iss(), "email:s1", &esub("a"), &sess_nonce("s1", 7));
    // Two keys of hana count once; the co-signer alone is one; hana + cosign passes, in either order.
    assert_refused(&mut c, jws(&cl, &[(rk(0), HANA_KID), (rk(1), HANA2_KID)]), "Not enough signatures");
    assert_refused(&mut c, jws(&cl, &[(rk(2), COSIGN_KID)]), "Not enough signatures");
    assert_refused(&mut c, jws(&cl, &[(rk(0), HANA_KID)]), "Not enough signatures");
    assert!(try_open(&mut c, jws(&cl, &[(rk(2), COSIGN_KID), (rk(0), HANA_KID)])).is_ok());
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    assert!(try_open(&mut c, jws(&cl, &[(rk(0), HANA_KID), (rk(1), HANA2_KID), (rk(2), COSIGN_KID)])).is_ok());
    assert_eq!(
        c.get_self_issued(EMAIL.into()).unwrap(),
        SelfIssuedView {
            provider: EMAIL.into(),
            signers: vec![SignerView { id: "hana".into(), kids: vec![HANA_KID.into(), HANA2_KID.into()] }, SignerView { id: "cosign".into(), kids: vec![COSIGN_KID.into()] }],
            required: 2,
            overlap_until_ms: None,
        }
    );
}

#[test]
fn a_policy_change_accepts_the_previous_policy_for_the_overlap_only() {
    let mut c = two_of_two(NOW_MS);
    let ev = events_named("signer_policy_set");
    assert_eq!(ev, vec![json!({"provider":EMAIL,"signers":["hana","cosign"],"required":2,"overlap_until_ms":NOW_MS + POLICY_OVERLAP_MS})]);
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().overlap_until_ms, Some(NOW_MS + POLICY_OVERLAP_MS));
    let cl = claims(&email_iss(), "email:s1", &esub("a"), &sess_nonce("s1", 7));
    // A hana-only token minted just before the upgrade still passes during the overlap...
    let one = jws(&cl, &[(rk(0), HANA_KID)]);
    ctx(RELAYER, NOW_MS + POLICY_OVERLAP_MS - 1);
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| c.create_session_signed(one.clone(), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3))).is_ok());
    // ...and not after it (the view drops the overlap too).
    ctx(RELAYER, NOW_MS + POLICY_OVERLAP_MS);
    expect_panic("Not enough signatures", || drop(c.create_session_signed(one.clone(), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3)));
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().overlap_until_ms, None);
    // A co-signer alone never satisfies the previous policy (it wasn't in it).
    let mut c = two_of_two(NOW_MS);
    assert_refused(&mut c, jws(&cl, &[(rk(2), COSIGN_KID)]), "Not enough signatures");
}

#[test]
fn a_signer_policy_is_validated() {
    let mut c = email_setup();
    ctx(ME, NOW_MS);
    let key = |i: usize| crate::issuers::RsaKey { n: rk(i).n.to_bytes_be(), e: rk(i).e.to_bytes_be() };
    let s = |v: &[&str]| v.iter().map(|x| x.to_string()).collect::<Vec<_>>();
    expect_panic("A policy needs 1 to 3 signers", || c.set_signer_policy(EMAIL, vec![], 1, vec![], true));
    expect_panic("A policy needs 1 to 3 signers", || c.set_signer_policy(EMAIL, s(&["a", "b", "c", "d"]), 1, vec![], true));
    expect_panic("Duplicate signer", || c.set_signer_policy(EMAIL, s(&["hana", "hana"]), 1, vec![], true));
    expect_panic("Invalid signer id", || c.set_signer_policy(EMAIL, s(&["Hana"]), 1, vec![], true));
    expect_panic("required must be 1 to the number of signers", || c.set_signer_policy(EMAIL, s(&["hana"]), 0, vec![], true));
    expect_panic("required must be 1 to the number of signers", || c.set_signer_policy(EMAIL, s(&["hana"]), 2, vec![], true));
    expect_panic("Unknown signer", || c.set_signer_policy(EMAIL, s(&["hana"]), 1, vec![("x".into(), "cosign".into(), key(2))], true));
    expect_panic("Kid is already active", || c.set_signer_policy(EMAIL, s(&["hana", "cosign"]), 2, vec![(HANA_KID.into(), "cosign".into(), key(2))], true));
    expect_panic("Not a self-issued issuer", || c.set_signer_policy("google", s(&["hana"]), 1, vec![], true));
    // Nothing changed.
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().required, 1);
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers.len(), 1);
}

#[test]
fn no_method_changes_the_signer_policy() {
    // Every public method that touches issuers leaves the signers and required count as they are.
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    let before = c.self_issued.clone();
    ctx(ADMIN, NOW_MS);
    expect_panic("Issuer is already self-issued", || c.mark_self_issued(EMAIL.into()));
    c.set_issuer(EMAIL.into(), vec![email_iss(), "https://other-iss.example".into()]);
    let id = post_owner_key(&mut c, EMAIL, "cosign-2", rk(3), Some("cosign"));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
    ctx(ADMIN, NOW_MS + GOV_DELAY_MS);
    c.remove_issuer_key(EMAIL.into(), HANA2_KID.into());
    let after = c.self_issued[0].clone();
    assert_eq!((after.signers, after.required, after.overlap), (before[0].signers.clone(), before[0].required, before[0].overlap.clone()));
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers[1].kids, vec![COSIGN_KID.to_string(), "cosign-2".into()]);
}

// ===================================================================================================================
// Paths: golden values, resolution, `opened`
// ===================================================================================================================

#[test]
fn golden_paths_of_identities_outside_every_account_are_unchanged() {
    // The exact strings v2 code produced (and the MPC derived from) for the fixture's Google user.
    let mut c = setup();
    ctx(RELAYER, NOW_MS);
    assert_eq!(open(&mut c, "session_a", "s1", 7, 0).path, "s1#google#1098765432#0");
    assert_eq!(open(&mut c, "session_b", "s2", 8, 0).path, "s2#google#1098765432#0");
    let mut c = setup();
    ctx(RELAYER, NOW_MS);
    assert_eq!(c.create_session_signed(tok("session_a_k1"), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 1, 3).path, "s1#google#1098765432#1");
    let mut c = shared_setup();
    ctx(RELAYER, NOW_MS);
    assert_eq!(open(&mut c, "shared_s3", "s3", 7, 0).path, "s3#google#1098765432#0");
    // The combined login sends exactly that path to the MPC.
    let mut c = setup();
    ctx(RELAYER, NOW_MS);
    let _ = c.create_session_and_derive(tok("session_a"), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3, ckd_sig(7, 1, PK1, PK2), PK1.into(), PK2.into(), None, None);
    assert_eq!(mpc_path(), "s1#google#1098765432#0");
    // The derive recorded the wallet.
    ctx(RELAYER, NOW_MS);
    assert!(c.get_identity("s1".into(), "google".into(), USER.into()).opened);
    // An email identity outside every account: {scope}#email#{sub}#{key_index}.
    let mut c = email_setup();
    let sub = esub("alice@example.com");
    login(&mut c, e_session(&sub, 7), 7, None, None);
    assert_eq!(mpc_path(), format!("s1#email#{sub}#0"));
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), sub.clone()).status, "own");
}

#[test]
fn opened_is_recorded_once_when_a_path_is_first_derived() {
    let mut c = email_setup();
    let view = |c: &HanaSigner| c.get_identity("s1".into(), "google".into(), G.into());
    assert!(!view(&c).opened);
    // A session alone doesn't make a wallet: nobody can derive without the session key (D130).
    ctx(RELAYER, NOW_MS);
    c.create_session_signed(g_session(G, 7), "s1".into(), pk(7), EXPIRES_MS, SALT.to_vec(), 0, 3);
    assert!(!view(&c).opened);
    ctx(RELAYER, NOW_MS);
    derive(&mut c, 7, 1);
    assert!(view(&c).opened);
    let usage = env::storage_usage();
    derive(&mut c, 7, 2);
    assert_eq!(env::storage_usage(), usage, "a second derive writes no opened record");
    // The combined login records it too.
    login(&mut c, g_session(G2, 8), 8, None, None);
    assert!(c.get_identity("s1".into(), "google".into(), G2.into()).opened);
    // Other scopes and providers are separate.
    assert!(!c.get_identity("s2".into(), "google".into(), G.into()).opened);
    assert!(!c.get_identity("s1".into(), EMAIL.into(), G.into()).opened);
}

#[test]
fn a_bare_create_session_front_run_does_not_create_a_wallet() {
    // An attacker who copies a published Google token into create_session opens a session it can't use, and the
    // identity still has no wallet: the legitimate case-A link still works afterwards with a fresh token.
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    login(&mut c, e_session(&e, 7), 7, None, None);
    // Without the session key the copy is refused outright (D137)...
    let (c2, err) = as_receipt(c, |c| drop(c.create_session(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3, vec![0; 64])));
    let mut c = c2;
    assert!(err.unwrap().contains("Invalid session signature"));
    // ...and even a bare session the key holder opens gives no wallet until it derives (D130).
    ctx(MALLORY, NOW_MS);
    c.create_session_signed(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3);
    assert!(!c.get_identity("s1".into(), "google".into(), G.into()).opened);
    login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 0, true, ja(&e))), Some(true));
    assert_eq!(path_of(&c, 9), format!("s1#email#{e}#0"));
}

// ===================================================================================================================
// Automatic linking: the four cases (create_session_and_derive with link_jwt)
// ===================================================================================================================

/// An email wallet for `sub` (an email login that derived).
fn email_wallet(c: &mut HanaSigner, sub: &str, seed: u8) {
    login(c, e_session(sub, seed), seed, None, None);
}

/// A Google wallet for `sub`.
fn google_wallet(c: &mut HanaSigner, sub: &str, seed: u8) {
    login(c, g_session(sub, seed), seed, None, None);
}

#[test]
fn case_a_google_joins_the_email_wallet_at_once() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    // The login opens E's wallet; G is an active automatic member of E's account.
    assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
    assert_eq!(path_of(&c, 8), format!("s1#email#{e}#0"));
    assert_eq!(events_named("identity_linked"), vec![json!({"scope_id":"s1","root":h(&eik(&e)),"member":h(&gik(G)),"provider":"google","effective_at_ms":NOW_MS,"auto":true})]);
    assert_eq!(
        c.get_identity("s1".into(), "google".into(), G.into()),
        IdentityView {
            key: h(&gik(G)),
            status: "member".into(),
            opened: false,
            root: Some(IdentityRef { provider: EMAIL.into(), sub: e.clone() }),
            effective_at_ms: Some(NOW_MS),
            account_epoch: 1
        }
    );
    let account = c.get_account("s1".into(), EMAIL.into(), e.clone()).unwrap();
    assert_eq!(account, c.get_account("s1".into(), "google".into(), G.into()).unwrap());
    assert_eq!(
        account,
        AccountView {
            root: IdentityRef { provider: EMAIL.into(), sub: e.clone() },
            members: vec![MemberView { key: h(&gik(G)), provider: "google".into(), effective_at_ms: NOW_MS, active: true, auto: true }],
            epoch: 1,
            unlinked: vec![]
        }
    );
    // Every later Google login opens E's wallet with no link token; G never gets one of its own.
    login(&mut c, g_session(G, 9), 9, None, None);
    assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
    assert!(!c.get_identity("s1".into(), "google".into(), G.into()).opened);
    // Other apps are unaffected (links are per scope).
    assert_eq!(c.get_account("s2".into(), "google".into(), G.into()), None);
}

#[test]
fn case_a_must_be_immediate() {
    let mut c = email_setup();
    let e = esub("alice@corp.example");
    email_wallet(&mut c, &e, 7);
    ctx(RELAYER, NOW_MS);
    expect_panic("This link must be immediate", || login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, ja(&e))), None));
}

#[test]
fn case_b_with_link_immediate_joins_the_email_identity_to_the_google_wallet_at_once() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
    assert_eq!(events_named("identity_linked")[0]["member"], h(&eik(&e)));
    // E's email logins now open G's wallet.
    login(&mut c, e_session(&e, 9), 9, None, None);
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
    assert!(!c.get_identity("s1".into(), EMAIL.into(), e).opened);
}

#[test]
fn case_b_without_link_immediate_waits_the_change_delay() {
    let mut c = email_setup();
    let e = esub("alice@corp.example");
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, jb(G))), None);
    // This login (G's own) opens G's wallet at once.
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
    assert_eq!(
        events_named("identity_link_proposed"),
        vec![json!({"scope_id":"s1","root":h(&gik(G)),"member":h(&eik(&e)),"provider":EMAIL,"effective_at_ms":NOW_MS + DELAY_MS,"auto":true})]
    );
    let view = c.get_identity("s1".into(), EMAIL.into(), e.clone());
    assert_eq!((view.status.as_str(), view.effective_at_ms), ("pending", Some(NOW_MS + DELAY_MS)));
    // E's email logins are refused until then (no session is left behind)...
    let queue = (c.queue_head, c.queue_tail);
    let (c2, err) = as_receipt(c, |c| login_at(c, NOW_MS + DELAY_MS - 1, e_session_at(&e, 9, NOW_MS + DELAY_MS - 1), 9, None, None));
    let mut c = c2;
    assert!(err.unwrap().contains("Sign-in method link is pending"));
    assert_nothing_left(&c, 9, queue);
    // ...and open G's wallet after it, marking the member active once.
    ctx(RELAYER, NOW_MS + DELAY_MS);
    login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e, 9, NOW_MS + DELAY_MS), 9, None, None);
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
    assert_eq!(events_named("identity_link_activated"), vec![json!({"scope_id":"s1","root":h(&gik(G)),"member":h(&eik(&e)),"provider":EMAIL})]);
    assert!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().members[0].active);
    login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e, 10, NOW_MS + DELAY_MS), 10, None, None);
    assert!(events_named("identity_link_activated").is_empty());
}

#[test]
fn lazy_activation_waits_for_the_unpause_floor() {
    let mut c = email_setup();
    let e = esub("alice@corp.example");
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, jb(G))), None);
    // A pause and unpause at NOW + 10 re-arms the change floor to NOW + 10 + DELAY: the pending link waits for it.
    ctx(ADMIN, NOW_MS + 10);
    c.pause();
    c.unpause();
    let floor = NOW_MS + 10 + DELAY_MS;
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e.clone()).effective_at_ms, Some(floor));
    assert_eq!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().members[0].effective_at_ms, floor);
    ctx(RELAYER, NOW_MS + DELAY_MS);
    expect_panic("Sign-in method link is pending", || login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e, 9, NOW_MS + DELAY_MS), 9, None, None));
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, jb(G))), None);
    ctx(ADMIN, NOW_MS + 10);
    c.pause();
    c.unpause();
    login_at(&mut c, floor, e_session_at(&e, 9, floor), 9, None, None);
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
}

#[test]
fn case_c_neither_has_a_wallet_the_session_identity_becomes_the_root() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
    assert!(c.get_identity("s1".into(), "google".into(), G.into()).opened);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e).status, "member");
}

#[test]
fn both_with_wallets_are_never_merged() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    google_wallet(&mut c, G, 8);
    ctx(RELAYER, NOW_MS);
    expect_panic("Both sign-in methods already have a wallet", || login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 0, true, ja(&e))), Some(true)));
}

#[test]
fn a_link_token_serves_only_its_session_mode_epoch_and_identity() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    let cases: Vec<(String, u8, Option<bool>, &str)> = vec![
        // Minted for the other mode.
        (auto_link_tok(&e, 8, &gik(G), 0, false, ja(&e)), 8, Some(true), "Link token nonce doesn't match"),
        // Another session key (another session nonce).
        (auto_link_tok(&e, 9, &gik(G), 0, true, ja(&e)), 8, Some(true), "Link token nonce doesn't match"),
        // Another session identity.
        (auto_link_tok(&e, 8, &gik(G2), 0, true, ja(&e)), 8, Some(true), "Link token nonce doesn't match"),
        // A stale epoch.
        (auto_link_tok(&e, 8, &gik(G), 1, true, ja(&e)), 8, Some(true), "Link token nonce doesn't match"),
        // A session token (session nonce) as a link token.
        (e_session(&e, 8), 8, Some(true), "Link token nonce doesn't match"),
    ];
    for (link, seed, immediate, expected) in cases {
        let (c2, err) = as_receipt(c, |c| login(c, g_session(G, seed), seed, Some(link), immediate));
        c = c2;
        let err = err.expect("refused");
        assert!(err.contains(expected), "{err:?} should contain {expected:?}");
        assert_eq!(c.get_account("s1".into(), EMAIL.into(), e.clone()), None, "nothing linked");
    }
    // Replaying a used link token after the account moved on (epoch 1) fails.
    let used = auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e));
    login(&mut c, g_session(G, 8), 8, Some(used), Some(true));
    let used_again = auto_link_tok(&e, 9, &gik(G2), 0, true, ja(&e));
    ctx(RELAYER, NOW_MS);
    expect_panic("Link token nonce doesn't match", || login(&mut c, g_session(G2, 9), 9, Some(used_again), Some(true)));
}

#[test]
fn link_token_checks() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    let hash = env::sha256_array(sess_preimage("s1", 8, 0));
    let nonce = nonce_of(&auto_link_preimage(ME, "s1", &hash, &gik(G), JOIN_SESSION_IDENTITY, &gik(G), &eik(&e), 0, true));
    let cases: Vec<(String, &str)> = vec![
        // Not a self-issued issuer's token.
        (google_tok(A, G2, &nonce), "Link token must come from a self-issued issuer"),
        // Another app's email client.
        (email_tok("email:s2", &e, &nonce), "Token is for another app"),
        // A forged signature.
        (jws(&claims(&email_iss(), "email:s1", &e, &nonce), &[(rk(3), HANA_KID)]), "Invalid token signature"),
    ];
    for (link, expected) in cases {
        let (c2, err) = as_receipt(c, |c| login(c, g_session(G, 8), 8, Some(link), Some(true)));
        c = c2;
        assert!(err.as_deref().unwrap_or_default().contains(expected), "{err:?} should contain {expected:?}");
    }
    // link_immediate alone is refused; old callers (neither argument) are unaffected.
    ctx(RELAYER, NOW_MS);
    expect_panic("link_immediate needs a link_jwt", || login(&mut c, g_session(G, 8), 8, None, Some(true)));
}

#[test]
fn old_callers_without_the_link_arguments_deserialize_as_before() {
    // near-sdk reads method arguments with serde; a missing Option field is None. This mirrors the generated input of
    // create_session_and_derive with the arguments every v2 caller sends.
    #[derive(serde::Deserialize)]
    #[allow(dead_code)]
    struct Input {
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
    }
    let v2_args = json!({"jwt":"x","scope_id":"s1","session_public_key":[1],"expires_at_ms":1,"salt":[9],"key_index":0,"max_uses":3,"signature":[2],"pk1":"a","pk2":"b"});
    let input: Input = serde_json::from_value(v2_args).unwrap();
    assert_eq!((input.link_jwt, input.link_immediate), (None, None));
}

#[test]
fn the_link_and_the_session_are_one_receipt() {
    // A front-run of the combined call with a wrong session signature reverts everything: no link, no session.
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    let queue = (c.queue_head, c.queue_tail);
    let link = auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e));
    let (c, err) = as_receipt(c, |c| {
        let _ = c.create_session_and_derive(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3, ckd_sig(9, 1, PK1, PK2), PK1.into(), PK2.into(), Some(link.clone()), Some(true));
    });
    assert!(err.unwrap().contains("Invalid session signature"));
    assert_nothing_left(&c, 8, queue);
    assert_eq!(c.get_account("s1".into(), EMAIL.into(), e.clone()), None);
    assert_eq!(c.get_identity("s1".into(), "google".into(), G.into()).status, "own");
}

#[test]
fn a_pending_session_identity_or_link_identity_is_refused() {
    let mut c = email_setup();
    let e = esub("alice@corp.example");
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, jb(G))), None);
    // E is pending in G's account: an email login with any link token is refused before the link is looked at.
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method link is pending", || login(&mut c, e_session(&e, 9), 9, Some(auto_link_tok(&e, 9, &eik(&e), 1, true, jb(G))), Some(true)));
    // A second Google identity linking E (pending elsewhere) is refused too.
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method link is pending", || login(&mut c, g_session(G2, 9), 9, Some(auto_link_tok(&e, 9, &gik(G2), 1, true, jb(G))), Some(true)));
}

#[test]
fn already_linked_identities_and_identities_of_the_same_kind_are_refused() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    // The same pair again (a race the vault retries without the link).
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method is already linked", || login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 1, true, ja(&e))), Some(true)));
    // A second Google identity can't join E's account: one sign-in method per provider.
    ctx(RELAYER, NOW_MS);
    expect_panic("Account already has a sign-in method of this kind", || login(&mut c, g_session(G2, 10), 10, Some(auto_link_tok(&e, 10, &gik(G2), 1, true, ja(&e))), Some(true)));
    // An email identity can't join a Google root that already has an email member, nor a root that is email.
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    ctx(RELAYER, NOW_MS);
    let e2 = esub("bob@gmail.com");
    expect_panic("Account already has a sign-in method of this kind", || login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e2, 9, &gik(G), 1, true, jb(G))), Some(true)));
    let mut c = email_setup();
    email_wallet(&mut c, &e, 7);
    ctx(RELAYER, NOW_MS);
    expect_panic("Account already has a sign-in method of this kind", || login(&mut c, e_session(&e, 8), 8, Some(auto_link_tok(&e2, 8, &eik(&e), 0, true, Join::B(eik(&e)))), Some(true)));
    expect_panic("Identities must differ", || login(&mut c, e_session(&e, 8), 8, Some(auto_link_tok(&e, 8, &eik(&e), 0, true, Join::B(eik(&e)))), Some(true)));
}

// ===================================================================================================================
// Explicit links
// ===================================================================================================================

/// `link_identity` in s1: `account_jwt` proves A (root `root`), `new_jwt` the new identity, both minted here.
fn link_tokens(root: &IdentityKey, new_provider: &str, new_key: &IdentityKey, epoch: u64) -> (String, String) {
    (nonce_of(&link_account_preimage(ME, "s1", root, new_key, epoch, &SALT)), nonce_of(&link_new_preimage(ME, "s1", root, new_provider, epoch, &SALT)))
}

/// G (Google, with a wallet) adds email identity `e` explicitly, as `caller`, at NOW_MS. Returns effective_at_ms.
fn link_email_to_google(c: &mut HanaSigner, g: &str, e: &str, epoch: u64, caller: &str) -> u64 {
    let root = c.root_of(&gik(g));
    let (a_nonce, n_nonce) = link_tokens(&root, EMAIL, &eik(e), epoch);
    ctx(caller, NOW_MS);
    c.link_identity("s1".into(), google_tok(A, g, &a_nonce), email_tok("email:s1", e, &n_nonce), epoch, SALT.to_vec())
}

#[test]
fn link_identity_adds_a_pending_member_after_the_change_delay() {
    let mut c = email_setup();
    let e = esub("work@corp.example");
    google_wallet(&mut c, G, 7);
    assert_eq!(link_email_to_google(&mut c, G, &e, 0, RELAYER), NOW_MS + DELAY_MS);
    assert_eq!(
        events_named("identity_link_proposed"),
        vec![json!({"scope_id":"s1","root":h(&gik(G)),"member":h(&eik(&e)),"provider":EMAIL,"effective_at_ms":NOW_MS + DELAY_MS,"auto":false})]
    );
    assert!(transfers().iter().all(|(to, _)| to == RELAYER), "the sponsor gets its deposit back and pays nothing");
    let account = c.get_account("s1".into(), "google".into(), G.into()).unwrap();
    assert_eq!(account.members, vec![MemberView { key: h(&eik(&e)), provider: EMAIL.into(), effective_at_ms: NOW_MS + DELAY_MS, active: false, auto: false }]);
    assert_eq!(account.epoch, 1);
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method link is pending", || login(&mut c, e_session(&e, 8), 8, None, None));
    login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e, 8, NOW_MS + DELAY_MS), 8, None, None);
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
}

#[test]
fn link_identity_charges_non_sponsors_for_storage() {
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let attached = NearToken::from_near(1).as_yoctonear();
    link_email_to_google(&mut c, G, &esub("w"), 0, MALLORY);
    let refund: u128 = transfers().iter().filter(|(to, _)| to == MALLORY).map(|(_, a)| *a).sum();
    assert!(refund < attached && refund > 0, "storage was charged: refund {refund}");
    // Without enough deposit it fails.
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let root = gik(G);
    let e = esub("w");
    let (a_nonce, n_nonce) = link_tokens(&root, EMAIL, &eik(&e), 0);
    ctx_with(MALLORY, NOW_MS, NearToken::from_yoctonear(1));
    expect_panic("Attached deposit doesn't cover storage", || { let _ = c.link_identity("s1".into(), google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()); });
}

#[test]
fn link_identity_refusals_in_order() {
    let e = esub("work@corp.example");
    let root = gik(G);
    let (a_nonce, n_nonce) = link_tokens(&root, EMAIL, &eik(&e), 0);
    let call = |c: &mut HanaSigner, scope: &str, a: String, n: String, epoch: u64, salt: Vec<u8>| {
        ctx(RELAYER, NOW_MS);
        { let _ = c.link_identity(scope.into(), a, n, epoch, salt); };
    };
    let fresh = || {
        let mut c = email_setup();
        google_wallet(&mut c, G, 7);
        c
    };
    let mut c = fresh();
    ctx(ADMIN, NOW_MS);
    c.pause();
    expect_panic("Paused", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()));
    let mut c = fresh();
    expect_panic("Salt must be 16-64 bytes", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, vec![1; 15]));
    expect_panic("Invalid token signature", || call(&mut c, "s1", google_tok(A, G, &a_nonce), jws(&claims(&email_iss(), "email:s1", &e, &n_nonce), &[(rk(3), HANA_KID)]), 0, SALT.to_vec()));
    expect_panic("Token is for another app", || call(&mut c, "s2", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()));
    expect_panic("Token is for another app", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s2", &e, &n_nonce), 0, SALT.to_vec()));
    // The nonces are swapped, or one commits to another salt or epoch.
    expect_panic("Link nonce doesn't match", || call(&mut c, "s1", google_tok(A, G, &n_nonce), email_tok("email:s1", &e, &a_nonce), 0, SALT.to_vec()));
    expect_panic("Link nonce doesn't match", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, vec![8; 16]));
    expect_panic("Link nonce doesn't match", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 1, SALT.to_vec()));
    // A link token for another new identity.
    let (a2, _) = link_tokens(&root, EMAIL, &eik(&esub("other")), 0);
    expect_panic("Link nonce doesn't match", || call(&mut c, "s1", google_tok(A, G, &a2), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()));
    // The same identity twice.
    let (sa, sn) = link_tokens(&root, "google", &root, 0);
    expect_panic("Identities must differ", || call(&mut c, "s1", google_tok(A, G, &sa), google_tok(A2, G, &sn), 0, SALT.to_vec()));
    // N already has a wallet.
    let mut c = fresh();
    email_wallet(&mut c, &e, 8);
    expect_panic("Sign-in method already has a wallet", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()));
    // N is already in another account (pending there).
    let mut c = fresh();
    google_wallet(&mut c, G2, 8);
    link_email_to_google(&mut c, G2, &e, 0, RELAYER);
    expect_panic("Sign-in method is already linked", || call(&mut c, "s1", google_tok(A, G, &a_nonce), email_tok("email:s1", &e, &n_nonce), 0, SALT.to_vec()));
    // A wrong epoch (the nonces match the argument, the account is elsewhere).
    let mut c = fresh();
    let (a1, n1) = link_tokens(&root, EMAIL, &eik(&e), 5);
    expect_panic("Wrong epoch", || call(&mut c, "s1", google_tok(A, G, &a1), email_tok("email:s1", &e, &n1), 5, SALT.to_vec()));
    // A pending identity can't vouch for its account.
    let mut c = fresh();
    link_email_to_google(&mut c, G, &e, 0, RELAYER);
    let (pa, pn) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "p-user"), 1, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 1, &SALT)));
    expect_panic("Sign-in method link is pending", || call(&mut c, "s1", email_tok("email:s1", &e, &pa), p_tok("p1", "p-user", &pn), 1, SALT.to_vec()));
}

#[test]
fn an_account_holds_three_members_of_three_other_providers() {
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let root = gik(G);
    for (i, p) in ["p1", "p2", "p3"].into_iter().enumerate() {
        let sub = format!("{p}-user");
        let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", p, &sub), i as u64, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, p, i as u64, &SALT)));
        ctx(RELAYER, NOW_MS);
        c.link_identity("s1".into(), google_tok(A, G, &a), p_tok(p, &sub, &n), i as u64, SALT.to_vec());
    }
    assert_eq!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().members.len(), MAX_MEMBERS);
    // Neither an explicit nor an automatic link fits any more.
    let e = esub("x");
    let (a, n) = link_tokens(&root, EMAIL, &eik(&e), 3);
    ctx(RELAYER, NOW_MS);
    expect_panic("Account is full", || { let _ = c.link_identity("s1".into(), google_tok(A, G, &a), email_tok("email:s1", &e, &n), 3, SALT.to_vec()); });
    expect_panic("Account is full", || login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 3, true, jb(G))), Some(true)));
    // A provider the account already has (p1 again, another sub).
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "u1"), 0, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 0, &SALT)));
    ctx(RELAYER, NOW_MS);
    c.link_identity("s1".into(), google_tok(A, G, &a), p_tok("p1", "u1", &n), 0, SALT.to_vec());
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "u2"), 1, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 1, &SALT)));
    expect_panic("Account already has a sign-in method of this kind", || { let _ = c.link_identity("s1".into(), google_tok(A, G, &a), p_tok("p1", "u2", &n), 1, SALT.to_vec()); });
}

#[test]
fn an_active_member_can_vouch_for_a_new_member() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    // E (an active member) proves the account for p1's new identity; root = G.
    let root = gik(G);
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "u1"), 1, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 1, &SALT)));
    ctx(RELAYER, NOW_MS);
    c.link_identity("s1".into(), email_tok("email:s1", &e, &a), p_tok("p1", "u1", &n), 1, SALT.to_vec());
    assert_eq!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().members.len(), 2);
}

#[test]
fn explicit_links_respect_the_unpause_floor() {
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    // A decrease of the change delay to 0, in force from NOW + DELAY / 2; an unpause at NOW sets the floor to
    // NOW + DELAY. A link proposed at NOW + DELAY / 2 (delay 0 then) still waits for the floor.
    ctx(ADMIN, NOW_MS - DELAY_MS / 2);
    c.set_change_delay_ms(0);
    ctx(ADMIN, NOW_MS);
    c.pause();
    c.unpause();
    let root = gik(G);
    let e = esub("w");
    let (a, n) = link_tokens(&root, EMAIL, &eik(&e), 0);
    ctx(RELAYER, NOW_MS + DELAY_MS / 2);
    assert_eq!(c.link_identity("s1".into(), google_tok(A, G, &a), email_tok("email:s1", &e, &n), 0, SALT.to_vec()), NOW_MS + DELAY_MS);
}

// ===================================================================================================================
// Cancel and unlink
// ===================================================================================================================

fn change_tok_google(g: &str, action: &str, root: &IdentityKey, member: &IdentityKey, epoch: u64) -> String {
    google_tok(A, g, &nonce_of(&link_change_preimage(ME, "s1", action, root, member, epoch, &SALT)))
}

fn change_tok_email(e: &str, action: &str, root: &IdentityKey, member: &IdentityKey, epoch: u64) -> String {
    email_tok("email:s1", e, &nonce_of(&link_change_preimage(ME, "s1", action, root, member, epoch, &SALT)))
}

/// G with a wallet and E pending in its account (epoch 1).
fn pending_setup(e: &str) -> HanaSigner {
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    link_email_to_google(&mut c, G, e, 0, RELAYER);
    c
}

#[test]
fn cancel_link_by_the_root_or_the_pending_identity() {
    let e = esub("work@corp.example");
    let (root, member) = (gik(G), eik(&e));
    for by_member in [false, true] {
        let mut c = pending_setup(&e);
        let jwt = if by_member { change_tok_email(&e, "cancel", &root, &member, 1) } else { change_tok_google(G, "cancel", &root, &member, 1) };
        ctx(RELAYER, NOW_MS);
        c.cancel_link("s1".into(), jwt, h(&member), 1, SALT.to_vec());
        let by = if by_member { h(&member) } else { h(&root) };
        assert_eq!(events_named("identity_link_cancelled"), vec![json!({"scope_id":"s1","root":h(&root),"member":h(&member),"provider":EMAIL,"by":by})]);
        let account = c.get_account("s1".into(), "google".into(), G.into()).unwrap();
        assert_eq!((account.members.len(), account.epoch, account.unlinked.len()), (0, 2, 0));
        assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e.clone()).status, "own");
        // The cancelled identity opens its own path again.
        login(&mut c, e_session(&e, 8), 8, None, None);
        assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
    }
}

#[test]
fn cancel_link_refusals() {
    let e = esub("work@corp.example");
    let (root, member) = (gik(G), eik(&e));
    let mut c = pending_setup(&e);
    let call = |c: &mut HanaSigner, jwt: String, key: String, epoch: u64| {
        ctx(RELAYER, NOW_MS);
        c.cancel_link("s1".into(), jwt, key, epoch, SALT.to_vec());
    };
    expect_panic("Invalid identity key", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 1), "zz".repeat(32), 1));
    expect_panic("Invalid identity key", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 1), h(&member).to_uppercase(), 1));
    expect_panic("No such member", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 1), h(&gik(G2)), 1));
    // The unlink nonce isn't a cancel nonce; another epoch's nonce isn't this one.
    expect_panic("Link nonce doesn't match", || call(&mut c, change_tok_google(G, "unlink", &root, &member, 1), h(&member), 1));
    expect_panic("Link nonce doesn't match", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 0), h(&member), 1));
    // An outsider, and the right nonce with a stale epoch.
    expect_panic("Sign-in method is not in this account", || call(&mut c, change_tok_google(G2, "cancel", &root, &member, 1), h(&member), 1));
    expect_panic("Wrong epoch", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 0), h(&member), 0));
    // Once active it is an unlink, not a cancel.
    ctx(RELAYER, NOW_MS + DELAY_MS);
    let jwt = change_tok_google(G, "cancel", &root, &member, 1);
    expect_panic("No such member", || c.cancel_link("s1".into(), jwt, h(&member), 1, SALT.to_vec()));
    // Another pending member can't cancel.
    let mut c = pending_setup(&e);
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "u1"), 1, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 1, &SALT)));
    ctx(RELAYER, NOW_MS);
    c.link_identity("s1".into(), google_tok(A, G, &a), p_tok("p1", "u1", &n), 1, SALT.to_vec());
    let jwt = p_tok("p1", "u1", &nonce_of(&link_change_preimage(ME, "s1", "cancel", &root, &member, 2, &SALT)));
    expect_panic("Sign-in method link is pending", || call(&mut c, jwt, h(&member), 2));
}

#[test]
fn unlink_by_the_root_or_the_member_and_never_automatic_again() {
    let e = esub("alice@gmail.com");
    let (root, member) = (gik(G), eik(&e));
    for by_member in [false, true] {
        let mut c = email_setup();
        google_wallet(&mut c, G, 7);
        login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
        let jwt = if by_member { change_tok_email(&e, "unlink", &root, &member, 1) } else { change_tok_google(G, "unlink", &root, &member, 1) };
        ctx(RELAYER, NOW_MS);
        c.unlink_identity("s1".into(), jwt, h(&member), 1, SALT.to_vec());
        let by = if by_member { h(&member) } else { h(&root) };
        assert_eq!(events_named("identity_unlinked"), vec![json!({"scope_id":"s1","root":h(&root),"member":h(&member),"provider":EMAIL,"by":by})]);
        let account = c.get_account("s1".into(), "google".into(), G.into()).unwrap();
        assert_eq!((account.members.len(), account.epoch, account.unlinked.clone()), (0, 2, vec![h(&member)]));
        // The pair is never matched automatically again, in either direction...
        ctx(RELAYER, NOW_MS);
        expect_panic("This sign-in method was unlinked", || login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 2, true, jb(G))), Some(true)));
        // ...the member opens its own path (a new wallet: the user's explicit choice)...
        login(&mut c, e_session(&e, 10), 10, None, None);
        assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
    }
    // ...and an explicit link can still re-add it (if it has no wallet of its own).
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    ctx(RELAYER, NOW_MS);
    c.unlink_identity("s1".into(), change_tok_google(G, "unlink", &root, &member, 1), h(&member), 1, SALT.to_vec());
    assert_eq!(link_email_to_google(&mut c, G, &e, 2, RELAYER), NOW_MS + DELAY_MS);
}

#[test]
fn a_google_member_unlinked_from_an_email_account_is_not_rematched() {
    // Case A, then the email root unlinks the Google member: G (still without a wallet of its own) can't rejoin
    // automatically, while it has no wallet and E does.
    let e = esub("alice@gmail.com");
    let (root, member) = (eik(&e), gik(G));
    let mut c = email_setup();
    email_wallet(&mut c, &e, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    ctx(RELAYER, NOW_MS);
    c.unlink_identity("s1".into(), change_tok_email(&e, "unlink", &root, &member, 1), h(&member), 1, SALT.to_vec());
    assert!(!c.get_identity("s1".into(), "google".into(), G.into()).opened);
    ctx(RELAYER, NOW_MS);
    expect_panic("This sign-in method was unlinked", || login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 2, true, ja(&e))), Some(true)));
}

#[test]
fn unlink_refusals() {
    let e = esub("alice@gmail.com");
    let (root, member) = (gik(G), eik(&e));
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, jb(G))), Some(true));
    // A second member, p1 (pending).
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &root, &ik("s1", "p1", "u1"), 1, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &root, "p1", 1, &SALT)));
    ctx(RELAYER, NOW_MS);
    c.link_identity("s1".into(), google_tok(A, G, &a), p_tok("p1", "u1", &n), 1, SALT.to_vec());
    let p1 = ik("s1", "p1", "u1");
    let call = |c: &mut HanaSigner, jwt: String, key: &IdentityKey, epoch: u64| {
        ctx(RELAYER, NOW_MS);
        c.unlink_identity("s1".into(), jwt, h(key), epoch, SALT.to_vec());
    };
    expect_panic("No such member", || call(&mut c, change_tok_google(G, "unlink", &root, &gik(G2), 2), &gik(G2), 2));
    expect_panic("Link nonce doesn't match", || call(&mut c, change_tok_google(G, "cancel", &root, &member, 2), &member, 2));
    expect_panic("Sign-in method is not in this account", || call(&mut c, change_tok_google(G2, "unlink", &root, &member, 2), &member, 2));
    // Another member (here pending p1) can't unlink E.
    let jwt = p_tok("p1", "u1", &nonce_of(&link_change_preimage(ME, "s1", "unlink", &root, &member, 2, &SALT)));
    expect_panic("Only the root or the member itself can unlink", || call(&mut c, jwt, &member, 2));
    expect_panic("Wrong epoch", || call(&mut c, change_tok_google(G, "unlink", &root, &member, 1), &member, 1));
    expect_panic("Cannot unlink the root", || call(&mut c, change_tok_google(G, "unlink", &root, &root, 2), &root, 2));
    // A pending member is cancelled, not unlinked.
    expect_panic("No such member", || call(&mut c, change_tok_google(G, "unlink", &root, &p1, 2), &p1, 2));
    // Paused.
    ctx(ADMIN, NOW_MS);
    c.pause();
    expect_panic("Paused", || call(&mut c, change_tok_google(G, "unlink", &root, &member, 2), &member, 2));
}

#[test]
fn an_account_remembers_the_last_eight_unlinked_identities() {
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let root = gik(G);
    let mut epoch = 0;
    let subs: Vec<String> = (0..9).map(|i| esub(&format!("u{i}"))).collect();
    for sub in &subs {
        let member = eik(sub);
        link_email_to_google(&mut c, G, sub, epoch, RELAYER);
        epoch += 1;
        ctx(RELAYER, NOW_MS + DELAY_MS);
        c.unlink_identity("s1".into(), change_tok_google(G, "unlink", &root, &member, epoch), h(&member), epoch, SALT.to_vec());
        epoch += 1;
    }
    let unlinked = c.get_account("s1".into(), "google".into(), G.into()).unwrap().unlinked;
    assert_eq!(unlinked.len(), MAX_UNLINKED);
    assert_eq!(unlinked, subs[1..].iter().map(|s| h(&eik(s))).collect::<Vec<_>>());
}

// ===================================================================================================================
// Views
// ===================================================================================================================

#[test]
fn identity_and_account_views() {
    let mut c = email_setup();
    let e = esub("work@corp.example");
    let own = c.get_identity("s1".into(), "google".into(), G.into());
    assert_eq!(own, IdentityView { key: h(&gik(G)), status: "own".into(), opened: false, root: None, effective_at_ms: None, account_epoch: 0 });
    assert_eq!(c.get_account("s1".into(), "google".into(), G.into()), None);
    google_wallet(&mut c, G, 7);
    link_email_to_google(&mut c, G, &e, 0, RELAYER);
    ctx(RELAYER, NOW_MS);
    assert_eq!(
        c.get_identity("s1".into(), EMAIL.into(), e.clone()),
        IdentityView {
            key: h(&eik(&e)),
            status: "pending".into(),
            opened: false,
            root: Some(IdentityRef { provider: "google".into(), sub: G.into() }),
            effective_at_ms: Some(NOW_MS + DELAY_MS),
            account_epoch: 1
        }
    );
    assert_eq!(c.get_identity("s1".into(), "google".into(), G.into()).account_epoch, 1);
    // Past its time a pending member reads as a member even before anyone marks it.
    ctx(RELAYER, NOW_MS + DELAY_MS);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e.clone()).status, "member");
    assert!(c.get_account("s1".into(), EMAIL.into(), e).unwrap().members[0].active);
    // Bad inputs.
    expect_panic("Invalid provider", || drop(c.get_identity("s1".into(), "Google".into(), G.into())));
    expect_panic("Invalid sub", || drop(c.get_account("s1".into(), "google".into(), "a#b".into())));
    expect_panic("Invalid sub", || drop(c.identity_key("s1".into(), "google".into(), "".into())));
}

// ===================================================================================================================
// Migration v2 → v3
// ===================================================================================================================

/// The v2 storage in src/v2_state_fixture.json (built by the v2 code, develop d1837ec; see its "about").
fn v2_storage() -> std::collections::HashMap<Vec<u8>, Vec<u8>> {
    let f: Value = serde_json::from_str(include_str!("../v2_state_fixture.json")).unwrap();
    f["storage"].as_array().unwrap().iter().map(|kv| (unhex(kv[0].as_str().unwrap()), unhex(kv[1].as_str().unwrap()))).collect()
}

#[test]
fn the_v2_layout_copy_round_trips_the_v2_state_fixture() {
    use near_sdk::borsh::BorshDeserialize;
    let storage = v2_storage();
    let raw = &storage[b"STATE".as_slice()];
    let v2 = crate::migrate::HanaSignerV2::try_from_slice(raw).expect("the v2 layout reads the v2 state");
    assert_eq!(&near_sdk::borsh::to_vec(&v2).unwrap(), raw);
    assert_eq!(v2.state_version, 2);
    // The v3 layout doesn't read v2 state, and the v2 layout (v2 code's migrate) doesn't read v3 state: an upgrade back
    // to v2 code panics in its migrate and is reverted.
    assert!(HanaSigner::try_from_slice(raw).is_err());
    let c = setup();
    let v3 = near_sdk::borsh::to_vec(&c).unwrap();
    assert!(crate::migrate::HanaSignerV2::try_from_slice(&v3).is_err());
    // v3 = the v2 bytes, unchanged, followed by the v3 fields.
    let v2_part = crate::migrate::HanaSignerV2::deserialize(&mut v3.as_slice()).unwrap();
    let prefix = near_sdk::borsh::to_vec(&v2_part).unwrap();
    assert_eq!(prefix, v3[..prefix.len()].to_vec());
}

#[test]
fn migrate_v2_to_v3_keeps_every_field_and_every_path() {
    ctx_with_storage(ME, NOW_MS, v2_storage());
    let mut c = HanaSigner::migrate();
    assert_eq!(events(), vec![ev12("state_migrated", json!({"from_version":2,"to_version":3}))]);
    // Every v2 field as the fixture's v2 code left it.
    assert_eq!(
        serde_json::to_value(c.get_config()).unwrap(),
        json!({
            "owner":ADMIN,"mpc":"v1.signer-prod.testnet","ckd_domain_id":2,
            "console_audiences":[["google",CONSOLE]],
            "pending_console_audiences":[{"provider":"google","aud":A,"effective_at_ms":NOW_MS + DELAY_MS}],
            "sponsors":[RELAYER],
            "shared_clients":[["google",SHARED]],
            "pending_shared_clients":[{"provider":"google","aud":D,"effective_at_ms":NOW_MS + DELAY_MS}],
            "change_delay_ms":DELAY_MS,"pending_change_delay":{"change_delay_ms":0,"effective_at_ms":NOW_MS + DELAY_MS},
            "public_registration":false,
            "issuer_key_delay_ms":KEY_DELAY_MS,"pending_issuer_key_delay":{"change_delay_ms":0,"effective_at_ms":NOW_MS + GOV_DELAY_MS},
            "governance_delay_ms":GOV_DELAY_MS,"pending_governance_delay":{"change_delay_ms":HOUR_MS,"effective_at_ms":NOW_MS + GOV_DELAY_MS},
            "paused":false,"unpaused_at_ms":NOW_MS,"changes_unlock_floor_ms":NOW_MS + DELAY_MS,"sessions_valid_from_ms":NOW_MS - HOUR_MS,"unrecorded_wallets":true
        })
    );
    let gov = c.get_governance();
    assert_eq!(gov.state_version, 3);
    assert_eq!(gov.watchdogs.iter().map(|w| w.account_id.to_string()).collect::<Vec<_>>(), vec![WATCHDOG, WATCHDOG2]);
    assert_eq!(gov.updater_keys, vec![near_pk(3)]);
    assert_eq!(gov.pending_upgrade.unwrap().code_hash, code_hash(NEW_CODE));
    assert_eq!(gov.pending_owner.unwrap().owner, acc(CAROL));
    assert_eq!(gov.pending_withdrawal.unwrap().amount, NearToken::from_near(1));
    // The owner's pending key change (stored by v2 code as KeyOp::Add) reads as before, with no signer field.
    let changes = serde_json::to_value(c.get_key_changes()).unwrap();
    assert_eq!(changes.as_array().unwrap().len(), 1);
    assert_eq!((changes[0]["kid"].as_str(), changes[0]["op"].as_str(), changes[0].get("signer")), (Some("k2"), Some("Add"), None));
    assert_eq!(kids(&c), vec!["test-kid".to_string()]);
    assert_eq!(c.get_issuer("other".into()).unwrap().kids, vec!["test-kid2".to_string()]);
    let s1 = c.get_scope("s1".into()).unwrap();
    assert_eq!(s1.clients, vec![google(A)]);
    assert_eq!(s1.pending.len(), 1);
    assert_eq!(c.scope_for_client("google".into(), B.into()), Some("s2".into()));
    assert!(c.get_scope("s3".into()).unwrap().allow_shared);
    // Sessions and their paths, byte for byte.
    assert_eq!(c.get_session(pk(7)), Some(Session { path: format!("s1#google#{USER}#0"), scope_id: "s1".into(), expires_at_ms: EXPIRES_MS, max_uses: 3, used: 1 }));
    assert_eq!(c.get_session(pk(8)).unwrap().path, format!("s2#google#{USER}#0"));
    // The v3 fields start empty: no self-issued issuer, no account, nothing opened (v2 wallets aren't in `opened`).
    assert!(c.self_issued.is_empty());
    assert_eq!(c.get_self_issued("google".into()), None);
    assert_eq!(c.get_identity("s1".into(), "google".into(), USER.into()).status, "own");
    assert!(!c.get_identity("s1".into(), "google".into(), USER.into()).opened);
    // The state round-trips as v3.
    env::state_write(&c);
    let stored: HanaSigner = env::state_read().unwrap();
    assert_eq!(stored.state_version, 3);

    // It keeps working: the v2 session derives with the same path, and that marks its identity opened...
    ctx(RELAYER, NOW_MS);
    derive(&mut c, 7, 2);
    assert_eq!(mpc_path(), format!("s1#google#{USER}#0"));
    assert!(c.get_identity("s1".into(), "google".into(), USER.into()).opened);
    // ...a fresh Google login gives the same path the v2 code gave...
    post_key(&mut c, "google", GOOGLE_KID, &rk(4).n_b64(), &rk(4).e_b64());
    ctx(RELAYER, NOW_MS);
    let s = c.create_session_signed(google_tok(B, USER, &sess_nonce("s2", 9)), "s2".into(), pk(9), EXPIRES_MS, SALT.to_vec(), 0, 3);
    assert_eq!(s.path, format!("s2#google#{USER}#0"));
    // ...and email login can be set up on it (owner-posted key after the governance delay).
    ctx(ADMIN, NOW_MS);
    c.set_issuer(EMAIL.into(), vec![email_iss()]);
    c.mark_self_issued(EMAIL.into());
    let id = c.set_issuer_key(EMAIL.into(), HANA_KID.into(), rk(0).n_b64(), rk(0).e_b64(), Some("hana".into()));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    c.execute_issuer_key_change(id);
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().signers[0].kids, vec![HANA_KID.to_string()]);
}

#[test]
fn migrate_refuses_every_state_it_does_not_migrate_from() {
    // A state shorter than the v2 layout (a v1 state is a strict prefix of it, and v1 has no migration any more), no
    // state, a v2 layout that claims another version, a v3 layout that claims another version.
    let mut storage = v2_storage();
    let raw = storage.get_mut(b"STATE".as_slice()).unwrap();
    raw.truncate(raw.len() - 8);
    ctx_with_storage(ME, NOW_MS, storage);
    expect_panic("Unexpected state version", || drop(HanaSigner::migrate()));
    ctx_with_storage(ME, NOW_MS, Default::default());
    expect_panic("Unexpected state version", || drop(HanaSigner::migrate()));
    let mut storage = v2_storage();
    let raw = storage.get_mut(b"STATE".as_slice()).unwrap();
    let mut v2 = <crate::migrate::HanaSignerV2 as near_sdk::borsh::BorshDeserialize>::try_from_slice(raw).unwrap();
    v2.state_version = 3;
    *raw = near_sdk::borsh::to_vec(&v2).unwrap();
    ctx_with_storage(ME, NOW_MS, storage);
    expect_panic("Unexpected state version", || drop(HanaSigner::migrate()));
    let mut c = setup();
    c.state_version = 2;
    env::state_write(&c);
    expect_panic("Unexpected state version", || drop(HanaSigner::migrate()));
    // Trailing garbage after a v3 state.
    let c = setup();
    let mut bytes = near_sdk::borsh::to_vec(&c).unwrap();
    bytes.push(0);
    env::storage_write(b"STATE", &bytes);
    expect_panic("Unexpected state version", || drop(HanaSigner::migrate()));
}

#[test]
fn migrate_on_a_v3_state_keeps_accounts_and_policies() {
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    let (policy, account) = (c.get_self_issued(EMAIL.into()), c.get_account("s1".into(), EMAIL.into(), e.clone()));
    env::state_write(&c);
    drop(c);
    ctx(ME, NOW_MS);
    let c = HanaSigner::migrate();
    assert_eq!(events(), vec![ev12("state_migrated", json!({"from_version":3,"to_version":3}))]);
    assert_eq!((c.get_self_issued(EMAIL.into()), c.get_account("s1".into(), EMAIL.into(), e)), (policy, account));
}

#[test]
fn storage_keys_of_the_v3_collections_are_new_prefixes() {
    use near_sdk::borsh::to_vec;
    // Appended StorageKey variants: the v1/v2 prefixes (0..=7) are unchanged.
    assert_eq!(to_vec(&crate::StorageKey::PendingAdds).unwrap(), vec![7]);
    assert_eq!(to_vec(&crate::StorageKey::Links).unwrap(), vec![8]);
    assert_eq!(to_vec(&crate::StorageKey::Accounts).unwrap(), vec![9]);
    assert_eq!(to_vec(&crate::StorageKey::Opened).unwrap(), vec![10]);
    // And a v2 pending key change (KeyOp::Add, variant 0) reads back unchanged.
    let op = crate::issuers::KeyOp::Add { n: vec![1], e: vec![3] };
    assert_eq!(to_vec(&op).unwrap(), vec![0, 1, 0, 0, 0, 1, 1, 0, 0, 0, 3]);
}

#[test]
fn derivation_is_unchanged_for_v2_sessions_after_the_migration() {
    // The v2 fixture's s2 session (key 8, opened by v2 code) derives with the v2 path.
    ctx_with_storage(ME, NOW_MS, v2_storage());
    let mut c = HanaSigner::migrate();
    ctx(RELAYER, NOW_MS);
    derive(&mut c, 8, 1);
    assert_eq!(mpc_path(), format!("s2#google#{USER}#0"));
}

// ===================================================================================================================
// Security review of batch 1 (2026-10-30): one regression test per finding, each failing on the code before the fix
// ===================================================================================================================

/// The combined login, with every argument given (as a front-runner or a replayer would send it).
fn combined_with(c: &mut HanaSigner, jwt: String, seed: u8, sig: Vec<u8>, link_jwt: Option<String>, immediate: Option<bool>) {
    let _ = c.create_session_and_derive(jwt, "s1".into(), pk(seed), EXPIRES_MS, SALT.to_vec(), 0, 3, sig, PK1.into(), PK2.into(), link_jwt, immediate);
}

#[test]
fn review_high_1a_a_replayed_google_login_cannot_get_an_attacker_link() {
    // A Google combined login whose arguments are public (failed, or seen in the mempool): token valid, session key
    // unused, signature valid. Whoever can mint email tokens (a stolen issuer key) resubmits it with its own
    // auto_link token for a fresh email identity, immediate: case B would join that email identity to G's wallet. The
    // user's signature covers only the plain CKD payload, so the replay fails and nothing is linked (D133).
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    let user_sig = login_sig(8, None, None);
    let attacker = esub("attacker@evil.example");
    let link = auto_link_tok(&attacker, 8, &gik(G), 0, true, jb(G));
    let queue = (c.queue_head, c.queue_tail);
    let (c, err) = as_receipt(c, |c| combined_with(c, g_session(G, 8), 8, user_sig.clone(), Some(link.clone()), Some(true)));
    assert!(err.as_deref().unwrap_or_default().contains("Invalid session signature"), "{err:?}");
    assert_nothing_left(&c, 8, queue);
    assert_eq!(c.get_account("s1".into(), "google".into(), G.into()), None);
    // The user's own call (no link) still works with that signature.
    let (c, err) = as_receipt(c, |c| combined_with(c, g_session(G, 8), 8, user_sig.clone(), None, None));
    assert_eq!(err, None);
    assert_eq!(c.get_session(pk(8)).unwrap().path, format!("s1#google#{G}#0"));
}

#[test]
fn review_high_1b_the_link_of_a_case_a_login_can_be_neither_stripped_nor_changed() {
    // The user's case-A login (G joins E's wallet) is public. Resubmitting it without the link would derive G's own
    // path and give G a wallet, so every later case-A link fails with "both have a wallet" (D122). The signature
    // covers the link and its mode, so stripping or changing either fails, and so does a bare create_session plus
    // derive_key with that signature (even the key holder's own bare session: an attacker can't open one, D137).
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    let link = auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e));
    let sig = login_sig(8, Some(&link), Some(true));
    let g_opened = |c: &HanaSigner| c.get_identity("s1".into(), "google".into(), G.into()).opened;
    for (link_jwt, immediate) in [(None, None), (Some(link.clone()), Some(false)), (Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e)) + " "), Some(true))] {
        let (c2, err) = as_receipt(c, |c| combined_with(c, g_session(G, 8), 8, sig.clone(), link_jwt.clone(), immediate));
        c = c2;
        assert!(err.is_some(), "accepted {link_jwt:?} {immediate:?}");
        assert!(!g_opened(&c));
        assert_eq!(c.get_identity("s1".into(), "google".into(), G.into()).status, "own");
    }
    ctx(MALLORY, NOW_MS);
    c.create_session_signed(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3);
    expect_panic("Invalid session signature", || {
        let _ = c.derive_key(pk(8), 1, sig.clone(), PK1.into(), PK2.into());
    });
    assert!(!g_opened(&c));
    // The user's call as signed links G into E's account (with a fresh session key: 8 is now taken).
    login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 0, true, ja(&e))), Some(true));
    assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
}

#[test]
fn review_medium_1_a_case_a_token_cannot_execute_as_case_b() {
    // The issuer minted a case-A token (G joins E's account) while E had a wallet. If the chain state then says case
    // B (E joins G's account) at the same epoch, the old nonce (session, G, epoch, mode) matched it. The nonce now
    // commits to the join (who joins which account), so the token fails.
    let mut c = email_setup();
    let e = esub("bob@corp.example");
    // G: no wallet, the root of an empty account at epoch 2 (a p1 identity linked, then unlinked).
    let (g, p) = (gik(G), ik("s1", "p1", "u1"));
    let (a, n) = (nonce_of(&link_account_preimage(ME, "s1", &g, &p, 0, &SALT)), nonce_of(&link_new_preimage(ME, "s1", &g, "p1", 0, &SALT)));
    ctx(RELAYER, NOW_MS);
    c.link_identity("s1".into(), google_tok(A, G, &a), p_tok("p1", "u1", &n), 0, SALT.to_vec());
    ctx(RELAYER, NOW_MS + DELAY_MS);
    c.unlink_identity("s1".into(), change_tok_google(G, "unlink", &g, &p, 1), h(&p), 1, SALT.to_vec());
    assert_eq!(c.get_identity("s1".into(), "google".into(), G.into()).account_epoch, 2);
    // A case-A token at epoch 2 while E has no wallet: the chain sees case B at epoch 2; refused.
    let token = auto_link_tok(&e, 8, &g, 2, true, Join::A(eik(&e)));
    let (c, err) = as_receipt(c, |c| login(c, g_session(G, 8), 8, Some(token.clone()), Some(true)));
    assert!(err.as_deref().unwrap_or_default().contains("Link token nonce doesn't match"), "{err:?}");
    assert!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().members.is_empty());
    // The case-B token the issuer would mint for this state works.
    let mut c = c;
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &g, 2, true, jb(G))), Some(true));
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e).status, "member");
}

#[test]
fn review_low_1_a_padded_or_weak_key_never_enters_a_signer_policy() {
    // A zero-padded copy of hana's modulus as the co-signer's key would let one private key satisfy 2-of-2. The
    // upgrade path now checks keys exactly as set_issuer_key does.
    let mut c = email_setup();
    ctx(ME, NOW_MS);
    let mut padded = vec![0u8, 0u8];
    padded.extend(rk(0).n.to_bytes_be());
    let e = rk(0).e.to_bytes_be();
    let policy = |c: &mut HanaSigner, n: Vec<u8>, e: Vec<u8>| {
        c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![(COSIGN_KID.into(), "cosign".into(), crate::issuers::RsaKey { n, e })], true);
    };
    expect_panic("Key is already registered", || policy(&mut c, padded.clone(), e.clone()));
    expect_panic("Invalid RSA exponent", || policy(&mut c, rk(2).n.to_bytes_be(), vec![1]));
    expect_panic("Invalid RSA exponent", || policy(&mut c, rk(2).n.to_bytes_be(), vec![0, 1]));
    expect_panic("RSA modulus must be 2048-4096 bits", || policy(&mut c, vec![0xff; 128], e.clone()));
    assert_eq!(c.get_self_issued(EMAIL.into()).unwrap().required, 1);
    // A padded copy of a real new key is stored stripped.
    let mut padded_new = vec![0u8];
    padded_new.extend(rk(2).n.to_bytes_be());
    policy(&mut c, padded_new, e);
    let keys = c.get_issuer_keys(EMAIL.into()).unwrap();
    assert_eq!(keys.iter().find(|k| k.kid == COSIGN_KID).unwrap().n, rk(2).n_b64());
}

#[test]
fn review_low_2_a_member_cannot_derive_its_own_path_through_an_old_session() {
    // Active member: G opened a session on its own path (never derived), then joined E's account (case A).
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    ctx(RELAYER, NOW_MS);
    c.create_session_signed(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3);
    login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 0, true, ja(&e))), Some(true));
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method is linked to an account", || derive(&mut c, 8, 1));
    assert!(!c.get_identity("s1".into(), "google".into(), G.into()).opened);
    // Pending member: E opened a session on its own path (never derived), then joined G's account pending (case B).
    let mut c = email_setup();
    google_wallet(&mut c, G, 7);
    ctx(RELAYER, NOW_MS);
    c.create_session_signed(e_session(&e, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3);
    login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 0, false, jb(G))), None);
    ctx(RELAYER, NOW_MS);
    expect_panic("Sign-in method is linked to an account", || derive(&mut c, 8, 1));
    assert!(!c.get_identity("s1".into(), EMAIL.into(), e).opened);
    // A member's own session on the root's path still derives.
    ctx(RELAYER, NOW_MS);
    derive(&mut c, 9, 2);
    assert_eq!(mpc_path(), format!("s1#google#{G}#0"));
}

#[test]
fn review_low_4_links_wait_for_the_owner_after_a_pre_v3_migration() {
    // After a v1/v2 → v3 migration, wallets derived before v3 aren't in `opened`: every link is refused until the
    // owner accepts that (`migrate_v2_to_v3_keeps_every_field_and_every_path` shows the migration sets the flag).
    let mut c = email_setup();
    c.unrecorded_wallets = true;
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    google_wallet(&mut c, G2, 6);
    ctx(RELAYER, NOW_MS);
    expect_panic("Links wait until the owner accepts the wallets opened before v3", || {
        login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    });
    let (a, n) = link_tokens(&gik(G2), EMAIL, &eik(&esub("w")), 0);
    ctx(RELAYER, NOW_MS);
    expect_panic("Links wait until the owner accepts the wallets opened before v3", || {
        let _ = c.link_identity("s1".into(), google_tok(A, G2, &a), email_tok("email:s1", &esub("w"), &n), 0, SALT.to_vec());
    });
    // Logins without a link are unaffected; only the owner accepts, once.
    login(&mut c, g_session(G, 9), 9, None, None);
    ctx(MALLORY, NOW_MS);
    expect_panic("Only the owner can do this", || c.accept_unrecorded_wallets());
    ctx(ADMIN, NOW_MS);
    c.accept_unrecorded_wallets();
    assert_eq!(events_named("unrecorded_wallets_accepted"), vec![json!({})]);
    assert!(!c.get_config().unrecorded_wallets);
    ctx(ADMIN, NOW_MS);
    c.accept_unrecorded_wallets();
    assert!(events_named("unrecorded_wallets_accepted").is_empty());
    login(&mut c, g_session(G2, 10), 10, Some(auto_link_tok(&esub("w2"), 10, &gik(G2), 0, true, jb(G2))), Some(true));
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), esub("w2")).status, "member");
}

#[test]
fn review_info_a_replacing_upgrade_can_drop_the_old_signer_at_once() {
    // A "replace the compromised co-signer" upgrade chooses no overlap: the old co-signer's keys go at once and its
    // signatures stop counting immediately. With the overlap (adding a signer), dropped signers' keys stay until the
    // owner removes them, but can't count once the overlap ends.
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    ctx(ME, NOW_MS);
    c.set_signer_policy(
        EMAIL,
        vec!["hana".into(), "cosign2".into()],
        2,
        vec![("cosign2-1".into(), "cosign2".into(), crate::issuers::RsaKey { n: rk(3).n.to_bytes_be(), e: rk(3).e.to_bytes_be() })],
        false,
    );
    let view = c.get_self_issued(EMAIL.into()).unwrap();
    assert_eq!(view.overlap_until_ms, None);
    assert!(!c.get_issuer_keys(EMAIL.into()).unwrap().iter().any(|k| k.kid == COSIGN_KID));
    let cl = claims(&email_iss(), "email:s1", &esub("a"), &sess_nonce("s1", 7));
    assert_refused(&mut c, jws(&cl, &[(rk(0), HANA_KID), (rk(2), COSIGN_KID)]), "Unknown signing key");
    assert!(try_open(&mut c, jws(&cl, &[(rk(0), HANA_KID), (rk(3), "cosign2-1")])).is_ok());
    // With the overlap, the dropped signer's key stays listed but can't count after the overlap.
    let mut c = two_of_two(NOW_MS - 2 * POLICY_OVERLAP_MS);
    ctx(ME, NOW_MS - POLICY_OVERLAP_MS);
    c.set_signer_policy(EMAIL, vec!["hana".into()], 1, vec![], true);
    assert!(c.get_issuer_keys(EMAIL.into()).unwrap().iter().any(|k| k.kid == COSIGN_KID));
    assert_refused(&mut c, jws(&cl, &[(rk(2), COSIGN_KID)]), "Unknown signing key");
    assert!(try_open(&mut c, jws(&cl, &[(rk(0), HANA_KID)])).is_ok());
}

#[test]
fn a_cancelled_automatic_link_still_matches() {
    // User decision 2026-10-30 (D132): cancel_link doesn't mark the pair unlinked; the match stays (no second wallet).
    let mut c = email_setup();
    let e = esub("alice@corp.example");
    let (root, member) = (gik(G), eik(&e));
    google_wallet(&mut c, G, 7);
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, false, jb(G))), None);
    ctx(RELAYER, NOW_MS);
    c.cancel_link("s1".into(), change_tok_google(G, "cancel", &root, &member, 1), h(&member), 1, SALT.to_vec());
    assert!(c.get_account("s1".into(), "google".into(), G.into()).unwrap().unlinked.is_empty());
    login(&mut c, g_session(G, 9), 9, Some(auto_link_tok(&e, 9, &gik(G), 2, false, jb(G))), None);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e).status, "pending");
}

// ===================================================================================================================
// Second security review (2026-10-30): regression tests, each failing with its fix reverted
// ===================================================================================================================

#[test]
fn review2_n1_the_proof_of_possession_layout_matches_the_js_implementation() {
    ctx(ADMIN, NOW_MS);
    let hash = env::sha256_array(sess_preimage("s1", 7, 0));
    check_email_layout("session_message_create", &sessions::session_message_bytes(0, &sessions::create_proof_bytes(&hash)), None);
}

#[test]
fn review2_n1_a_bare_create_session_needs_the_session_key() {
    // The user's case-A linked login is public (mempool, or a failed transaction). Before D137 anyone could copy its
    // Google token into a bare create_session with the same session key and no link: the user's call then failed
    // "Session key already in use", and a vault recovering with a plain derive_key (counter 1) derived G's own path,
    // splitting the person (D122). Now the bare call needs the session key's signature.
    let mut c = email_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    let link = auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e));
    let linked_sig = login_sig(8, Some(&link), Some(true));
    // Neither nothing, nor the user's linked CKD signature, nor another key's proof opens the session.
    for sig in [vec![0u8; 64], linked_sig.clone(), pop_sig(9, "s1", EXPIRES_MS, &SALT, 0, 3), session_sig(8, 1, &sessions::create_proof_bytes(&env::sha256_array(sess_preimage("s1", 8, 0))))] {
        let (c2, err) = as_receipt(c, |c| drop(c.create_session(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3, sig.clone())));
        c = c2;
        assert!(err.as_deref().unwrap_or_default().contains("Invalid session signature"), "{err:?}");
        assert!(!c.session_key_in_use(pk(8)));
    }
    // So the user's linked login still goes through as signed.
    login(&mut c, g_session(G, 8), 8, Some(link), Some(true));
    assert_eq!(mpc_path(), format!("s1#email#{e}#0"));
    assert_eq!(c.get_identity("s1".into(), "google".into(), G.into()).status, "member");
}

#[test]
fn review2_n1_the_proof_of_possession_is_never_a_derive_or_revoke_signature() {
    // Counter 0 is never accepted after a session exists, so a published proof can't spend a session.
    let mut c = email_setup();
    ctx(RELAYER, NOW_MS);
    c.create_session_signed(g_session(G, 8), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3);
    let pop = pop_sig(8, "s1", EXPIRES_MS, &SALT, 0, 3);
    expect_panic("Wrong counter", || drop(c.derive_key(pk(8), 0, pop.clone(), PK1.into(), PK2.into())));
    expect_panic("Wrong counter", || c.revoke_session(pk(8), 0, pop.clone()));
    expect_panic("Invalid session signature", || drop(c.derive_key(pk(8), 1, pop.clone(), PK1.into(), PK2.into())));
    expect_panic("Invalid session signature", || c.revoke_session(pk(8), 1, pop.clone()));
}

#[test]
fn review2_n3a_a_replacing_policy_cannot_keep_a_signer_id_with_a_new_key() {
    // A "replace the compromised co-signer" upgrade (no overlap) that kept the id `cosign` and added a new key would
    // leave the old, compromised cosign key counting. The replacement must come under a new id.
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    ctx(ME, NOW_MS);
    let new_key = crate::issuers::RsaKey { n: rk(3).n.to_bytes_be(), e: rk(3).e.to_bytes_be() };
    expect_panic("A replacing policy adds keys only for new signer ids", || {
        c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![("cosign-2".into(), "cosign".into(), new_key.clone())], false);
    });
    assert!(c.get_issuer_keys(EMAIL.into()).unwrap().iter().any(|k| k.kid == COSIGN_KID));
    // With a new id the old signer's key goes at once.
    c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign2".into()], 2, vec![("cosign2-1".into(), "cosign2".into(), new_key)], false);
    assert!(!c.get_issuer_keys(EMAIL.into()).unwrap().iter().any(|k| k.kid == COSIGN_KID));
}

#[test]
fn review2_n3b_a_dropped_signers_pending_key_never_revives() {
    // The owner posted a key for `cosign`; an upgrade then drops `cosign` (either mode): the pending addition is
    // cancelled, so a later upgrade listing `cosign` again can't bring it back (anyone could have executed it).
    for overlap in [false, true] {
        let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
        let id = post_owner_key(&mut c, EMAIL, "cosign-old", rk(3), Some("cosign"));
        ctx(ME, NOW_MS);
        c.set_signer_policy(EMAIL, vec!["hana".into()], 1, vec![], overlap);
        assert!(c.get_key_changes().iter().all(|k| k.id != id), "overlap {overlap}: the dropped signer's pending key is gone");
        assert_eq!(events_named("issuer_key_change_cancelled")[0]["id"], id);
        ctx(ME, NOW_MS + POLICY_OVERLAP_MS);
        c.set_signer_policy(EMAIL, vec!["hana".into(), "cosign".into()], 2, vec![], true);
        ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
        expect_panic("No such key change", || c.execute_issuer_key_change(id));
        assert!(!c.get_issuer_keys(EMAIL.into()).unwrap().iter().any(|k| k.kid == "cosign-old"));
    }
    // A pending key of a signer that stays is kept.
    let mut c = two_of_two(NOW_MS - POLICY_OVERLAP_MS);
    let id = post_owner_key(&mut c, EMAIL, "hana-3", rk(3), Some("hana"));
    ctx(ME, NOW_MS);
    c.set_signer_policy(EMAIL, vec!["hana".into()], 1, vec![], true);
    assert!(c.get_key_changes().iter().any(|k| k.id == id));
}

/// A Google session token whose nonce commits to exactly these session parameters (key `seed`).
fn g_tok_for(scope: &str, seed: u8, expires_at_ms: u64, salt: &[u8], key_index: u32, max_uses: u32) -> String {
    let key = pk(seed);
    let c = SessionCommitment { signer: ME, scope_id: scope, session_public_key: &key, expires_at_ms, key_index, max_uses, salt };
    google_tok(if scope == "s2" { B } else { A }, G, &sessions::session_nonce(&c))
}

#[test]
fn review2_n1_a_proof_of_possession_serves_only_its_session_parameters() {
    // A proof is bound to the session nonce preimage (signer, scope, key, expiry, key_index, max_uses, salt): seen once
    // (it is public in the transaction), it can't open the same key with any other parameters.
    let mut c = email_setup();
    let proof = pop_sig(8, "s1", EXPIRES_MS, &SALT, 0, 3);
    let other_salt = [8u8; 16];
    let cases: Vec<(&str, u64, &[u8], u32, u32)> =
        vec![("s1", EXPIRES_LATE_MS, &SALT, 0, 3), ("s1", EXPIRES_MS, &other_salt, 0, 3), ("s1", EXPIRES_MS, &SALT, 1, 3), ("s1", EXPIRES_MS, &SALT, 0, 1), ("s2", EXPIRES_MS, &SALT, 0, 3)];
    for (scope, expires, salt, key_index, max_uses) in cases {
        let token = g_tok_for(scope, 8, expires, salt, key_index, max_uses);
        let (c2, err) = as_receipt(c, |c| drop(c.create_session(token.clone(), scope.into(), pk(8), expires, salt.to_vec(), key_index, max_uses, proof.clone())));
        c = c2;
        assert!(err.as_deref().unwrap_or_default().contains("Invalid session signature"), "{scope} {expires} {key_index} {max_uses}: {err:?}");
        assert!(!c.session_key_in_use(pk(8)));
    }
    // With the parameters it signed, it opens the session.
    ctx(RELAYER, NOW_MS);
    let s = c.create_session(g_tok_for("s1", 8, EXPIRES_MS, &SALT, 0, 3), "s1".into(), pk(8), EXPIRES_MS, SALT.to_vec(), 0, 3, proof);
    assert_eq!(s.path, format!("s1#google#{G}#0"));
}
