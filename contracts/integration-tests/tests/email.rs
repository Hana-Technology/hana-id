//! Sandbox tests of email login (docs/email-login-spec.md "Tests" → "Sandbox"), on a v3 deployment created with `new`:
//!
//! - Hana's email issuer end to end with a local RSA key: `set_issuer`, `mark_self_issued`, an owner-posted key that
//!   waits `governance_delay_ms` (the updater key can't post it, a watchdog can't confirm it), then an email login
//!   whose CKD request carries the expected path `{scope}#email#{sub}#{key_index}`;
//! - automatic links (case A, case B at once and delayed) and explicit links (`link_identity`, `cancel_link`,
//!   `unlink_identity`): a login through the member derives the same `big_y` as the root, and nothing else moves;
//! - the gas of every new call, printed as `GAS ...` lines (`cargo test --test email -- --nocapture | grep '^GAS'`)
//!   and recorded in docs/contract-interface.md "Gas".
//!
//! The v3 → v4 upgrade through the DAO is in tests/governance.rs.

mod common;

use anyhow::{bail, Context, Result};
use common::*;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, NearToken};
use near_workspaces::Account;
use serde_json::{json, Value};

const PK1: &str = "bls12381g1:A";
const PK2: &str = "bls12381g2:B";

/// The attached gas D155 sets (batch 6 puts them in apps/api/src/gas.ts), sized for the worst key the contract
/// accepts (4096-bit RSA, ≈ 67 Tgas per verification; `gas_with_4096_bit_keys`): `create_session_and_derive` with a
/// `link_jwt` (two verifications plus the MPC's 20 Tgas, ≈ 156 at 4096 bits, ≈ 59 at 2048).
const LINKED_LOGIN_GAS: Gas = Gas::from_tgas(250);
/// `link_identity` (two verifications).
const LINK_IDENTITY_GAS: Gas = Gas::from_tgas(250);
/// `cancel_link` / `unlink_identity` (one verification).
const LINK_CHANGE_GAS: Gas = Gas::from_tgas(150);

/// A sandbox with Hana's email issuer set up (Env::setup_email) and a scope with both sign-in methods:
/// [google APP_E, email "email:<scope>"], owned by carol.
struct EmailWorld {
    env: Env,
    email: TestIssuer,
    scope: String,
    /// The Google key the world's Google tokens are signed with (Env's test key unless `email_world_with` was given
    /// another).
    google: Option<TestIssuer>,
}

async fn email_world() -> Result<EmailWorld> {
    email_world_with(None, None).await
}

/// `email_world` with other keys: an email issuer key, and a further Google key (posted by the owner, confirmed by
/// the watchdog) that the world's Google tokens are then signed with.
async fn email_world_with(email_key: Option<TestIssuer>, google: Option<TestIssuer>) -> Result<EmailWorld> {
    let env = Env::setup().await?;
    if let Some(g) = &google {
        post_issuer_key(&env.admin, &env.watchdog, env.signer.id(), g).await?;
    }
    let email = match email_key {
        Some(key) => env.setup_email_with(key).await?,
        None => env.setup_email().await?,
    };
    // admin_register_scope assigns ids in sequence: Env::setup registered s1 and s2, so this one is s3, and its email
    // client is "email:s3" (as Hana predicts the id at registration, decisions.md D130 point 11).
    let aud = email_aud("s3");
    let scope = env.admin_register_clients(vec![near_owner(env.carol.id())], &[(PROVIDER, APP_E), (EMAIL, &aud)], false).await?;
    if scope != "s3" {
        bail!("expected scope s3, got {scope}");
    }
    Ok(EmailWorld { env, email, scope, google })
}

impl EmailWorld {
    fn signer(&self) -> &near_workspaces::AccountId {
        self.env.signer.id()
    }

    fn ik(&self, provider: &str, sub: &str) -> [u8; 32] {
        identity_key(&self.scope, provider, sub)
    }

    fn path(&self, provider: &str, sub: &str) -> String {
        format!("{}#{provider}#{sub}#0", self.scope)
    }

    async fn google_session(&self, sub: &str) -> Result<(TestSession, String)> {
        let Some(google) = &self.google else { return self.env.new_session(APP_E, sub, &self.scope, 0, 600_000).await };
        let now = self.env.now_ms().await?;
        let session = TestSession::new(&self.scope, now + 600_000, 0, 5);
        let jwt = google.jwt(APP_E, sub, Some(&session.nonce(self.signer())), now);
        Ok((session, jwt))
    }

    fn google_jwt(&self, sub: &str, nonce: &str, now: u64) -> String {
        self.google.as_ref().unwrap_or(&self.env.issuer).jwt(APP_E, sub, Some(nonce), now)
    }

    async fn email_session(&self, sub: &str) -> Result<(TestSession, String)> {
        self.env.new_email_session(&self.email, &self.scope, sub, 600_000).await
    }

    /// A plain combined login (no link) with the API's gas; returns the CKD answer.
    async fn login(&self, session: &mut TestSession, jwt: &str) -> Result<CkdResponse> {
        let outcome = self.env.login(&self.env.relayer_fc, &session.login_args(jwt, PK1, PK2)).await?;
        Ok(outcome.into_result()?.json()?)
    }

    async fn google_login(&self, sub: &str) -> Result<(TestSession, CkdResponse)> {
        let (mut s, jwt) = self.google_session(sub).await?;
        let ckd = self.login(&mut s, &jwt).await?;
        Ok((s, ckd))
    }

    async fn email_login(&self, sub: &str) -> Result<(TestSession, CkdResponse)> {
        let (mut s, jwt) = self.email_session(sub).await?;
        let ckd = self.login(&mut s, &jwt).await?;
        Ok((s, ckd))
    }

    /// The `auto_link` email token for `session` (the session identity `session_ik`), for the email identity
    /// `email_sub`, committing to `join` into the account of `target_root` at `epoch`, in mode `immediate`.
    #[allow(clippy::too_many_arguments)]
    async fn auto_link_token(&self, session: &TestSession, session_ik: &[u8; 32], email_sub: &str, join: u8, target_root: &[u8; 32], epoch: u64, immediate: bool) -> Result<String> {
        let joiner = if join == JOIN_SESSION { *session_ik } else { self.ik(EMAIL, email_sub) };
        let nonce = nonce_of(&auto_link_preimage(self.signer().as_str(), &self.scope, &session.preimage_hash(self.signer()), session_ik, join, &joiner, target_root, epoch, immediate));
        Ok(self.email.email_jws(&email_aud(&self.scope), email_sub, &nonce, self.env.now_ms().await?))
    }

    /// `create_session_and_derive` with `link_jwt` as the relayer's session pool sends it, with LINKED_LOGIN_GAS.
    async fn linked_login(&self, session: &mut TestSession, jwt: &str, link_jwt: &str, immediate: Option<bool>) -> Result<ExecutionFinalResult> {
        let args = session.linked_login_args(jwt, PK1, PK2, link_jwt, immediate);
        Ok(self.env.relayer_fc.call(self.signer(), "create_session_and_derive").args_json(args).gas(LINKED_LOGIN_GAS).transact().await?)
    }

    async fn call(&self, caller: &Account, method: &str, args: Value, gas: Gas) -> Result<ExecutionFinalResult> {
        Ok(caller.call(self.signer(), method).args_json(args).gas(gas).deposit(NearToken::from_yoctonear(0)).transact().await?)
    }

    async fn path_of(&self, session: &TestSession) -> Result<String> {
        Ok(self.env.get_session(session).await?.context("session")?.path)
    }

    async fn expected_big_y(&self, path: &str) -> Result<String> {
        Ok(self.env.expected_ckd(path, PK1, PK2).await?.big_y)
    }
}

fn event<'a>(outcome: &'a [Value], name: &str) -> Vec<&'a Value> {
    outcome.iter().filter(|e| e["event"] == name).map(|e| &e["data"][0]).collect()
}

// ---------------------------------------------------------------------------------------------------------------
// The email issuer end to end

#[tokio::test]
async fn email_issuer_end_to_end_with_a_local_key() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id().clone();
    let key = TestIssuer::generate_with_kid(EMAIL_KID)?;

    // set_issuer and mark_self_issued are the owner's.
    env.admin.call(&signer, "set_issuer").args_json(json!({"provider": EMAIL, "iss_values": [EMAIL_ISS]})).gas(GAS).transact().await?.into_result()?;
    expect_failure(tx(env.alice.call(&signer, "mark_self_issued").args_json(json!({"provider": EMAIL})).transact().await), "Only the owner can do this");
    // Google can never be self-issued (D134).
    expect_failure(tx(env.admin.call(&signer, "mark_self_issued").args_json(json!({"provider": PROVIDER})).transact().await), "Only the email issuer can be self-issued");
    let outcome = env.admin.call(&signer, "mark_self_issued").args_json(json!({"provider": EMAIL})).gas(GAS).transact().await?;
    report_gas("mark_self_issued", &outcome, GAS);
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(event(&events, "issuer_self_issued"), vec![&json!({"provider": EMAIL})]);
    expect_failure(tx(env.admin.call(&signer, "mark_self_issued").args_json(json!({"provider": EMAIL})).transact().await), "Issuer is already self-issued");
    let policy: Value = env.signer.view("get_self_issued").args_json(json!({"provider": EMAIL})).await?.json()?;
    assert_eq!(policy, json!({"provider": EMAIL, "signers": [{"id": EMAIL_SIGNER, "kids": []}], "required": 1, "overlap_until_ms": null}));
    let google: Value = env.signer.view("get_self_issued").args_json(json!({"provider": PROVIDER})).await?.json()?;
    assert_eq!(google, Value::Null);

    // Only the owner posts its keys (never the updater key), each under a listed signer.
    let key_args = |signer_id: Option<&str>| json!({"provider": EMAIL, "kid": key.kid, "n": key.n, "e": key.e, "signer": signer_id});
    expect_failure(tx(env.keys_updater.call(&signer, "set_issuer_key").args_json(key_args(Some(EMAIL_SIGNER))).gas(Gas::from_tgas(30)).transact().await), "Only the owner posts keys for this issuer");
    expect_failure(tx(env.admin.call(&signer, "set_issuer_key").args_json(key_args(None)).gas(Gas::from_tgas(30)).transact().await), "Unknown signer");
    expect_failure(tx(env.admin.call(&signer, "set_issuer_key").args_json(key_args(Some("cosigner"))).gas(Gas::from_tgas(30)).transact().await), "Unknown signer");
    let before = env.now_ms().await?;
    let id = post_email_key(&env.admin, &signer, &key).await?;
    let change = env.get_key_changes().await?.as_array().unwrap().iter().find(|c| c["id"] == json!(id)).cloned().context("key change")?;
    let due = change["executable_at_ms"].as_u64().unwrap();
    // The governance delay (30 s here), not the shorter issuer-key delay (20 s).
    assert!(due >= before + GOVERNANCE_DELAY_MS, "due {due}, posted after {before}");
    // No early confirm by a watchdog; no execution before the delay.
    expect_failure(tx(env.watchdog.call(&signer, "confirm_issuer_key_change").args_json(json!({"id": id})).transact().await), "Keys of a self-issued issuer can't be confirmed early");
    expect_failure(tx(env.alice.call(&signer, "execute_issuer_key_change").args_json(json!({"id": id})).transact().await), "Key change is still delayed");

    // A scope with both methods: Google APP_E and the email client "email:s3".
    let scope = env.admin_register_clients(vec![near_owner(env.carol.id())], &[(PROVIDER, APP_E), (EMAIL, &email_aud("s3"))], false).await?;
    assert_eq!(scope, "s3");
    let sub = email_sub("ada@example.com");
    // Until the key is active an email login fails on chain.
    let (mut early, jwt) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    expect_failure(env.login(&env.relayer_fc, &early.login_args(&jwt, PK1, PK2)).await, "Unknown signing key");

    env.advance_to(due).await?;
    let outcome = env.alice.call(&signer, "execute_issuer_key_change").args_json(json!({"id": id})).gas(Gas::from_tgas(30)).transact().await?;
    report_gas("execute_issuer_key_change (email)", &outcome, Gas::from_tgas(30));
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(event(&events, "issuer_key_set")[0]["how"], json!("delay"));
    let policy: Value = env.signer.view("get_self_issued").args_json(json!({"provider": EMAIL})).await?.json()?;
    assert_eq!(policy["signers"], json!([{"id": EMAIL_SIGNER, "kids": [EMAIL_KID]}]));
    let issuer: Value = env.signer.view("get_issuer").args_json(json!({"provider": EMAIL})).await?.json()?;
    assert_eq!(issuer["kids"], json!([EMAIL_KID]));

    // The email login: one transaction, the CKD request carries {scope}#email#{sub}#0, the answer comes back as is.
    let (mut s, jwt) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    let outcome = env.login(&env.relayer_fc, &s.login_args(&jwt, PK1, PK2)).await?;
    report_gas("create_session_and_derive (email, first login)", &outcome, api_gas("create_session_and_derive"));
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    let path = format!("{scope}#email#{sub}#0");
    assert_eq!(ckd, env.expected_ckd(&path, PK1, PK2).await?);
    let calls = env.mpc_calls().await?;
    assert_eq!(calls.last().unwrap().derivation_path, path);
    assert_eq!((calls.last().unwrap().domain_id, calls.last().unwrap().deposit.as_str()), (CKD_DOMAIN_ID, "1"));
    assert_eq!(env.get_session(&s).await?.unwrap().path, path);
    // The identity key matches the spec's layout; the identity now has a wallet of its own.
    let ik = hex(&identity_key(&scope, EMAIL, &sub));
    let view: String = env.signer.view("identity_key").args_json(json!({"scope_id": scope, "provider": EMAIL, "sub": sub})).await?.json()?;
    assert_eq!(view, ik);
    assert_eq!(env.get_identity(&scope, EMAIL, &sub).await?, json!({"key": ik, "status": "own", "opened": true, "root": null, "effective_at_ms": null, "account_epoch": 0}));
    assert_eq!(env.get_account(&scope, EMAIL, &sub).await?, Value::Null);
    // derive_key on the same session: same path.
    env.relayer_fc.call(&signer, "derive_key").args_json(s.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?.into_result()?;
    assert_eq!(env.mpc_calls().await?.last().unwrap().derivation_path, path);

    // A second login (the identity is already in `opened`) and a bare create_session (proof of possession).
    let (mut again, jwt) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    let outcome = env.login(&env.relayer_fc, &again.login_args(&jwt, PK1, PK2)).await?;
    report_gas("create_session_and_derive (email, later login)", &outcome, api_gas("create_session_and_derive"));
    outcome.into_result()?;
    let (bare, jwt) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    let outcome = env.create_session(&env.relayer_fc, &bare, &jwt).await?;
    report_gas("create_session (email)", &outcome, api_gas("create_session"));
    let created: SessionView = outcome.into_result()?.json()?;
    assert_eq!(created.path, path);
    // The same person's Google identity is another identity: another path (no link exists).
    let (mut g, gjwt) = env.new_session(APP_E, USER_SUB, &scope, 0, 600_000).await?;
    let outcome = env.login(&env.relayer_fc, &g.login_args(&gjwt, PK1, PK2)).await?;
    report_gas("create_session_and_derive (google, first login, v3)", &outcome, api_gas("create_session_and_derive"));
    outcome.into_result()?;
    assert_eq!(env.get_session(&g).await?.unwrap().path, format!("{scope}#google#{USER_SUB}#0"));

    // Refused tokens: the compact form for the self-issued issuer, a key the chain doesn't list under that kid, a
    // client the chain doesn't know, and a token from the email key for another scope's session.
    let now = env.now_ms().await?;
    let (other, _) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    let compact = key.compact_jwt(EMAIL_ISS, &email_aud(&scope), &sub, Some(&other.nonce(&signer)), now);
    expect_failure(env.create_session(&env.relayer_fc, &other, &compact).await, "Wrong token format for this issuer");
    let forged_key = TestIssuer::generate_with_kid(EMAIL_KID)?;
    let forged = forged_key.email_jws(&email_aud(&scope), &sub, &other.nonce(&signer), now);
    expect_failure(env.create_session(&env.relayer_fc, &other, &forged).await, "Invalid token signature");
    let stranger = TestIssuer::generate_with_kid("not-listed")?;
    expect_failure(env.create_session(&env.relayer_fc, &other, &stranger.email_jws(&email_aud(&scope), &sub, &other.nonce(&signer), now)).await, "Unknown signing key");
    expect_failure(env.create_session(&env.relayer_fc, &other, &key.email_jws("email:s9", &sub, &other.nonce(&signer), now)).await, "Token is for an unregistered app");
    let in_a = TestSession::new(&env.scope_a, now + 600_000, 0, 5);
    expect_failure(env.create_session(&env.relayer_fc, &in_a, &key.email_jws(&email_aud(&scope), &sub, &in_a.nonce(&signer), now)).await, "Token is for another app");

    // The owner removes the key at once (DoS only): email logins stop, Google's go on.
    env.admin.call(&signer, "remove_issuer_key").args_json(json!({"provider": EMAIL, "kid": EMAIL_KID})).transact().await?.into_result()?;
    let (mut late, jwt) = env.new_email_session(&key, &scope, &sub, 600_000).await?;
    expect_failure(env.login(&env.relayer_fc, &late.login_args(&jwt, PK1, PK2)).await, "Unknown signing key");
    let (mut g2, gjwt) = env.new_session(APP_E, USER_SUB, &scope, 0, 600_000).await?;
    env.login(&env.relayer_fc, &g2.login_args(&gjwt, PK1, PK2)).await?.into_result()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Automatic links (create_session_and_derive with link_jwt)

#[tokio::test]
async fn automatic_links_open_the_root_wallet() -> Result<()> {
    let w = email_world().await?;
    let env = &w.env;

    // Case B at once: G1 has a wallet; G1 logs in again with a link token for E1 (no wallet), link_immediate. E1
    // joins G1's account; the login opens G1's path.
    let (g1, e1) = ("g-1".to_string(), email_sub("e1@example.com"));
    let (_, g1_ckd) = w.google_login(&g1).await?;
    assert_eq!(g1_ckd.big_y, w.expected_big_y(&w.path(PROVIDER, &g1)).await?);
    let (mut s, jwt) = w.google_session(&g1).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g1), &e1, JOIN_LINK, &w.ik(PROVIDER, &g1), 0, true).await?;
    let outcome = w.linked_login(&mut s, &jwt, &link, Some(true)).await?;
    report_gas("create_session_and_derive + link_jwt (case B, at once)", &outcome, LINKED_LOGIN_GAS);
    let events = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd.big_y, g1_ckd.big_y);
    assert_eq!(w.path_of(&s).await?, w.path(PROVIDER, &g1));
    let (root, member) = (hex(&w.ik(PROVIDER, &g1)), hex(&w.ik(EMAIL, &e1)));
    let linked = event(&events, "identity_linked");
    assert_eq!(linked.len(), 1);
    assert_eq!((linked[0]["root"].clone(), linked[0]["member"].clone(), linked[0]["provider"].clone(), linked[0]["auto"].clone()), (json!(root), json!(member), json!(EMAIL), json!(true)));
    let account = env.get_account(&w.scope, EMAIL, &e1).await?;
    assert_eq!(account["root"], json!({"provider": PROVIDER, "sub": g1}));
    assert_eq!(account["epoch"], json!(1));
    assert_eq!((account["members"][0]["key"].clone(), account["members"][0]["active"].clone(), account["members"][0]["auto"].clone()), (json!(member), json!(true), json!(true)));
    assert_eq!(env.get_identity(&w.scope, EMAIL, &e1).await?["status"], json!("member"));
    // E1's email login now opens G1's wallet: the same big_y, the same CKD request path.
    let (s_e1, ckd) = w.email_login(&e1).await?;
    assert_eq!(ckd.big_y, g1_ckd.big_y);
    assert_eq!(w.path_of(&s_e1).await?, w.path(PROVIDER, &g1));
    assert_eq!(env.mpc_calls().await?.last().unwrap().derivation_path, w.path(PROVIDER, &g1));
    // E1 never got a wallet of its own (its own path was never derived).
    assert_eq!(env.get_identity(&w.scope, EMAIL, &e1).await?["opened"], json!(false));

    // Case B delayed (no link_immediate): E2 waits change_delay_ms, then opens G2's wallet.
    let (g2, e2) = ("g-2".to_string(), email_sub("e2@example.com"));
    let (_, g2_ckd) = w.google_login(&g2).await?;
    let (mut s, jwt) = w.google_session(&g2).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g2), &e2, JOIN_LINK, &w.ik(PROVIDER, &g2), 0, false).await?;
    // A token minted for the delayed mode can't be used at once (the mode is in the nonce).
    let (mut wrong, wrong_jwt) = w.google_session(&g2).await?;
    let wrong_link = w.auto_link_token(&wrong, &w.ik(PROVIDER, &g2), &e2, JOIN_LINK, &w.ik(PROVIDER, &g2), 0, false).await?;
    expect_failure(w.linked_login(&mut wrong, &wrong_jwt, &wrong_link, Some(true)).await, "Link token nonce doesn't match");
    let outcome = w.linked_login(&mut s, &jwt, &link, None).await?;
    report_gas("create_session_and_derive + link_jwt (case B, delayed)", &outcome, LINKED_LOGIN_GAS);
    let events = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd.big_y, g2_ckd.big_y);
    let proposed = event(&events, "identity_link_proposed");
    let effective = proposed[0]["effective_at_ms"].as_u64().context("effective_at_ms")?;
    assert!(effective >= env.now_ms().await? + CHANGE_DELAY_MS - 5_000);
    assert_eq!(env.get_identity(&w.scope, EMAIL, &e2).await?["status"], json!("pending"));
    let (mut early, jwt) = w.email_session(&e2).await?;
    expect_failure(env.login(&env.relayer_fc, &early.login_args(&jwt, PK1, PK2)).await, "Sign-in method link is pending");
    env.advance_to(effective).await?;
    let (mut s_e2, jwt) = w.email_session(&e2).await?;
    let outcome = env.login(&env.relayer_fc, &s_e2.login_args(&jwt, PK1, PK2)).await?;
    report_gas("create_session_and_derive (email member, activates the link)", &outcome, api_gas("create_session_and_derive"));
    let events = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(event(&events, "identity_link_activated").len(), 1);
    assert_eq!(ckd.big_y, g2_ckd.big_y);
    assert_eq!(w.path_of(&s_e2).await?, w.path(PROVIDER, &g2));

    // Case A: E3 has a wallet, G3 none; G3's first login carries E3's link token (join 1, at once) and opens E3's
    // wallet. From then on G3's plain logins open it too.
    let (g3, e3) = ("g-3".to_string(), email_sub("e3@example.com"));
    let (_, e3_ckd) = w.email_login(&e3).await?;
    assert_eq!(e3_ckd.big_y, w.expected_big_y(&w.path(EMAIL, &e3)).await?);
    let (mut s, jwt) = w.google_session(&g3).await?;
    // Case A must be immediate (a delayed one would open G3's own path: a second wallet).
    let delayed = w.auto_link_token(&s, &w.ik(PROVIDER, &g3), &e3, JOIN_SESSION, &w.ik(EMAIL, &e3), 0, false).await?;
    expect_failure(w.linked_login(&mut s, &jwt, &delayed, None).await, "This link must be immediate");
    let (mut s, jwt) = w.google_session(&g3).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g3), &e3, JOIN_SESSION, &w.ik(EMAIL, &e3), 0, true).await?;
    let outcome = w.linked_login(&mut s, &jwt, &link, Some(true)).await?;
    report_gas("create_session_and_derive + link_jwt (case A)", &outcome, LINKED_LOGIN_GAS);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd.big_y, e3_ckd.big_y);
    assert_eq!(w.path_of(&s).await?, w.path(EMAIL, &e3));
    let (s_g3, ckd) = w.google_login(&g3).await?;
    assert_eq!(ckd.big_y, e3_ckd.big_y);
    assert_eq!(w.path_of(&s_g3).await?, w.path(EMAIL, &e3));
    assert_eq!(env.get_account(&w.scope, PROVIDER, &g3).await?["root"], json!({"provider": EMAIL, "sub": e3}));

    // Both have a wallet: refused, and the login is reverted (no session left behind).
    let (mut s, jwt) = w.google_session(&g1).await?;
    let both = w.auto_link_token(&s, &w.ik(PROVIDER, &g1), &e3, JOIN_LINK, &w.ik(PROVIDER, &g1), 1, true).await?;
    expect_failure(w.linked_login(&mut s, &jwt, &both, Some(true)).await, "Both sign-in methods already have a wallet");
    assert!(env.get_session(&s).await?.is_none());

    // The session key alone decides the link: a link token attached to a signature over the plain payload (a relayer
    // or front-runner adding a link the vault didn't sign) fails, and leaves nothing behind.
    let (g4, e4) = ("g-4".to_string(), email_sub("e4@example.com"));
    w.google_login(&g4).await?;
    let (mut s, jwt) = w.google_session(&g4).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g4), &e4, JOIN_LINK, &w.ik(PROVIDER, &g4), 0, true).await?;
    let mut args = s.login_args(&jwt, PK1, PK2);
    args["link_jwt"] = json!(link);
    args["link_immediate"] = json!(true);
    expect_failure(tx(env.relayer_fc.call(w.signer(), "create_session_and_derive").args_json(args).gas(LINKED_LOGIN_GAS).transact().await), "Invalid session signature");
    assert_eq!(env.get_identity(&w.scope, EMAIL, &e4).await?["status"], json!("own"));
    assert_eq!(env.get_account(&w.scope, PROVIDER, &g4).await?, Value::Null);
    // The vault's own signature over the linked payload, with the same tokens, works.
    let outcome = w.linked_login(&mut s, &jwt, &link, Some(true)).await?;
    outcome.into_result()?;
    let (_, ckd) = w.email_login(&e4).await?;
    assert_eq!(ckd.big_y, w.expected_big_y(&w.path(PROVIDER, &g4)).await?);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Explicit links

#[tokio::test]
async fn explicit_link_cancel_and_unlink() -> Result<()> {
    let w = email_world().await?;
    let env = &w.env;
    let signer = w.signer().as_str().to_string();
    let salt: Vec<u8> = (0u8..16).map(|i| i * 5 + 1).collect();
    let (g, e) = ("g-5".to_string(), email_sub("e5@example.com"));
    let (gik, eik) = (w.ik(PROVIDER, &g), w.ik(EMAIL, &e));
    let (_, g_ckd) = w.google_login(&g).await?;
    let g_path = w.path(PROVIDER, &g);

    // link_identity: proofs of both identities (an account token for G with the link_account nonce, a new-identity
    // token for E with the link_new nonce), relayed by a sponsor (no deposit).
    let link_args = |epoch: u64, now: u64| {
        let account_jwt = env.issuer.jwt(APP_E, &g, Some(&nonce_of(&link_account_preimage(&signer, &w.scope, &gik, &eik, epoch, &salt))), now);
        let new_jwt = w.email.email_jws(&email_aud(&w.scope), &e, &nonce_of(&link_new_preimage(&signer, &w.scope, &gik, EMAIL, epoch, &salt)), now);
        json!({"scope_id": w.scope, "account_jwt": account_jwt, "new_jwt": new_jwt, "epoch": epoch, "salt": salt})
    };
    // The session pool relays it (batch 6 added the link methods to its allowlist, as the API's /v1/link): proofs for
    // another epoch than the account's (0) reach the contract and are refused there.
    expect_failure(w.call(&env.relayer_fc, "link_identity", link_args(1, env.now_ms().await?), LINK_IDENTITY_GAS).await, "Wrong epoch");
    let now = env.now_ms().await?;
    let outcome = w.call(&env.relayer_fc, "link_identity", link_args(0, now), LINK_IDENTITY_GAS).await?;
    report_gas("link_identity", &outcome, LINK_IDENTITY_GAS);
    let events = hana_events(&outcome);
    let effective: u64 = outcome.into_result()?.json()?;
    assert!(effective >= now + CHANGE_DELAY_MS);
    let proposed = event(&events, "identity_link_proposed");
    assert_eq!((proposed[0]["member"].clone(), proposed[0]["auto"].clone(), proposed[0]["effective_at_ms"].clone()), (json!(hex(&eik)), json!(false), json!(effective)));
    let (mut early, jwt) = w.email_session(&e).await?;
    expect_failure(env.login(&env.relayer_fc, &early.login_args(&jwt, PK1, PK2)).await, "Sign-in method link is pending");

    // cancel_link by the pending identity itself (epoch 1, after the link).
    let cancel = w.email.email_jws(&email_aud(&w.scope), &e, &nonce_of(&link_change_preimage(&signer, &w.scope, "cancel", &gik, &eik, 1, &salt)), env.now_ms().await?);
    let outcome = w.call(&env.relayer_fc, "cancel_link", json!({"scope_id": w.scope, "jwt": cancel, "member_key": hex(&eik), "epoch": 1, "salt": salt}), LINK_CHANGE_GAS).await?;
    report_gas("cancel_link", &outcome, LINK_CHANGE_GAS);
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(event(&events, "identity_link_cancelled")[0]["by"], json!(hex(&eik)));
    let account = env.get_account(&w.scope, PROVIDER, &g).await?;
    assert_eq!((account["members"].clone(), account["epoch"].clone()), (json!([]), json!(2)));
    // Proofs for the first link's epoch fail: the account has moved on (epoch 2).
    expect_failure(w.call(&env.relayer, "link_identity", link_args(0, env.now_ms().await?), LINK_IDENTITY_GAS).await, "Wrong epoch");

    // Link again (epoch 2); after the delay E's login opens G's wallet: the same big_y.
    let outcome = w.call(&env.relayer, "link_identity", link_args(2, env.now_ms().await?), LINK_IDENTITY_GAS).await?;
    let effective: u64 = outcome.into_result()?.json()?;
    env.advance_to(effective).await?;
    let (s_e, ckd) = w.email_login(&e).await?;
    assert_eq!(ckd.big_y, g_ckd.big_y);
    assert_eq!(w.path_of(&s_e).await?, g_path);
    let account = env.get_account(&w.scope, EMAIL, &e).await?;
    assert_eq!((account["members"][0]["active"].clone(), account["members"][0]["auto"].clone(), account["epoch"].clone()), (json!(true), json!(false), json!(3)));

    // unlink_identity by the root (epoch 3): E opens its own path again from its next login; the pair is remembered.
    let unlink = env.issuer.jwt(APP_E, &g, Some(&nonce_of(&link_change_preimage(&signer, &w.scope, "unlink", &gik, &eik, 3, &salt))), env.now_ms().await?);
    let outcome = w.call(&env.relayer_fc, "unlink_identity", json!({"scope_id": w.scope, "jwt": unlink, "member_key": hex(&eik), "epoch": 3, "salt": salt}), LINK_CHANGE_GAS).await?;
    report_gas("unlink_identity", &outcome, LINK_CHANGE_GAS);
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(event(&events, "identity_unlinked")[0]["by"], json!(hex(&gik)));
    let account = env.get_account(&w.scope, PROVIDER, &g).await?;
    assert_eq!((account["members"].clone(), account["unlinked"].clone(), account["epoch"].clone()), (json!([]), json!([hex(&eik)]), json!(4)));
    let (s_e, ckd) = w.email_login(&e).await?;
    assert_eq!(w.path_of(&s_e).await?, w.path(EMAIL, &e));
    assert_eq!(ckd.big_y, w.expected_big_y(&w.path(EMAIL, &e)).await?);
    assert_ne!(ckd.big_y, g_ckd.big_y);
    // G's wallet is where it was.
    let (_, ckd) = w.google_login(&g).await?;
    assert_eq!(ckd.big_y, g_ckd.big_y);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// accept_unrecorded_wallets on a deployment created with `new`

#[tokio::test]
async fn a_new_deployment_records_every_wallet_from_the_start() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    assert_eq!(env.get_config().await?["unrecorded_wallets"], json!(false));
    expect_failure(tx(env.alice.call(signer, "accept_unrecorded_wallets").transact().await), "Only the owner can do this");
    // A no-op for the owner here (no event): `new` never needs it.
    let outcome = env.admin.call(signer, "accept_unrecorded_wallets").gas(GAS).transact().await?;
    report_gas("accept_unrecorded_wallets (no-op)", &outcome, GAS);
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert!(events.iter().all(|e| e["event"] != "unrecorded_wallets_accepted"));
    assert_eq!(env.get_config().await?["unrecorded_wallets"], json!(false));
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The worst case: 4096-bit keys

/// Gas at the largest RSA key the contract accepts (4096 bits, `issuers.rs` `checked_rsa_key`) for every key that
/// signs a token here (Google and email), with 300 Tgas attached to measure, then with the attached gas D155 sets.
#[tokio::test]
async fn gas_with_4096_bit_keys() -> Result<()> {
    let w = email_world_with(Some(TestIssuer::generate_with_bits(EMAIL_KID, 4096)?), Some(TestIssuer::generate_with_bits("google-4096", 4096)?)).await?;
    let env = &w.env;
    let max = Gas::from_tgas(300);
    let signer = w.signer().as_str().to_string();
    let salt: Vec<u8> = (0u8..16).map(|i| i * 3 + 2).collect();

    // Plain logins (one verification each).
    let (g, e) = ("g-4096".to_string(), email_sub("big@example.com"));
    let (mut s, jwt) = w.google_session(&g).await?;
    let outcome = env.relayer_fc.call(w.signer(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(max).transact().await?;
    report_gas("4096: create_session_and_derive (Google, no link)", &outcome, max);
    outcome.into_result()?;
    let (mut s, jwt) = w.email_session(&e).await?;
    let outcome = env.relayer_fc.call(w.signer(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(max).transact().await?;
    report_gas("4096: create_session_and_derive (email, no link)", &outcome, max);
    outcome.into_result()?;
    let (bare, jwt) = w.email_session(&e).await?;
    let outcome = env.relayer_fc.call(w.signer(), "create_session").args_json(bare.create_args(w.signer(), &jwt)).gas(max).transact().await?;
    report_gas("4096: create_session (email)", &outcome, max);
    outcome.into_result()?;

    // A linked login (Google session token + email link token), case B at once.
    let (g2, e2) = ("g-4096-2".to_string(), email_sub("big2@example.com"));
    let (mut s, jwt) = w.google_session(&g2).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g2), &e2, JOIN_LINK, &w.ik(PROVIDER, &g2), 0, true).await?;
    let args = s.linked_login_args(&jwt, PK1, PK2, &link, Some(true));
    let outcome = env.relayer_fc.call(w.signer(), "create_session_and_derive").args_json(args).gas(max).transact().await?;
    report_gas("4096: create_session_and_derive + link_jwt (case B)", &outcome, max);
    outcome.into_result()?;
    // ...and with the attached gas D155 sets.
    let (g3, e3) = ("g-4096-3".to_string(), email_sub("big3@example.com"));
    let (mut s, jwt) = w.google_session(&g3).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g3), &e3, JOIN_LINK, &w.ik(PROVIDER, &g3), 0, true).await?;
    w.linked_login(&mut s, &jwt, &link, Some(true)).await?.into_result()?;

    // link_identity (two verifications), then cancel_link and, after a second link, unlink_identity (one each).
    // g (which has a wallet) gets a fresh email identity (e has a wallet of its own).
    let gik = w.ik(PROVIDER, &g);
    let e4 = email_sub("big4@example.com");
    let eik4 = w.ik(EMAIL, &e4);
    let link_args = |epoch: u64, now: u64| {
        let account_jwt = w.google_jwt(&g, &nonce_of(&link_account_preimage(&signer, &w.scope, &gik, &eik4, epoch, &salt)), now);
        let new_jwt = w.email.email_jws(&email_aud(&w.scope), &e4, &nonce_of(&link_new_preimage(&signer, &w.scope, &gik, EMAIL, epoch, &salt)), now);
        json!({"scope_id": w.scope, "account_jwt": account_jwt, "new_jwt": new_jwt, "epoch": epoch, "salt": salt})
    };
    let outcome = w.call(&env.relayer, "link_identity", link_args(0, env.now_ms().await?), max).await?;
    report_gas("4096: link_identity", &outcome, max);
    outcome.into_result()?;
    let cancel = w.email.email_jws(&email_aud(&w.scope), &e4, &nonce_of(&link_change_preimage(&signer, &w.scope, "cancel", &gik, &eik4, 1, &salt)), env.now_ms().await?);
    let outcome = w.call(&env.relayer_fc, "cancel_link", json!({"scope_id": w.scope, "jwt": cancel, "member_key": hex(&eik4), "epoch": 1, "salt": salt}), max).await?;
    report_gas("4096: cancel_link", &outcome, max);
    outcome.into_result()?;
    // With the attached gas D155 sets.
    let effective: u64 = w.call(&env.relayer, "link_identity", link_args(2, env.now_ms().await?), LINK_IDENTITY_GAS).await?.into_result()?.json()?;
    env.advance_to(effective).await?;
    let unlink = w.google_jwt(&g, &nonce_of(&link_change_preimage(&signer, &w.scope, "unlink", &gik, &eik4, 3, &salt)), env.now_ms().await?);
    let outcome = w.call(&env.relayer_fc, "unlink_identity", json!({"scope_id": w.scope, "jwt": unlink, "member_key": hex(&eik4), "epoch": 3, "salt": salt}), LINK_CHANGE_GAS).await?;
    report_gas("4096: unlink_identity", &outcome, LINK_CHANGE_GAS);
    outcome.into_result()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// The hourly link counter and its alarm thresholds (D200)

/// Links at or over a threshold still go through (the counter only records): the scope is flagged once, the event
/// fires once, case A, case B and `link_identity` are all counted, and a lowered total threshold shows in the view at
/// once.
#[tokio::test]
async fn links_over_a_threshold_succeed_and_are_recorded() -> Result<()> {
    let w = email_world().await?;
    let env = &w.env;
    // Lowering applies at once; a raise is scheduled.
    let outcome = env.admin.call(w.signer(), "set_link_thresholds").args_json(json!({"per_scope_per_hour": 1, "total_per_hour": 500})).gas(GAS).transact().await?;
    report_gas("set_link_thresholds (a lowering)", &outcome, GAS);
    outcome.into_result()?;
    let outcome = env.admin.call(w.signer(), "set_link_thresholds").args_json(json!({"per_scope_per_hour": 1, "total_per_hour": 600})).gas(GAS).transact().await?;
    report_gas("set_link_thresholds (a raise, scheduled)", &outcome, GAS);
    outcome.into_result()?;
    let stats: Value = env.signer.view("get_link_stats").await?.json()?;
    assert_eq!((stats["thresholds"].clone(), stats["pending_thresholds"]["total_per_hour"].clone()), (json!({"per_scope_per_hour": 1, "total_per_hour": 500}), json!(600)));

    // Case B: the link that reaches the scope's threshold records it.
    let (g1, e1) = ("g-thr-1".to_string(), email_sub("thr1@example.com"));
    let (_, g1_ckd) = w.google_login(&g1).await?;
    let (mut s, jwt) = w.google_session(&g1).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g1), &e1, JOIN_LINK, &w.ik(PROVIDER, &g1), 0, true).await?;
    let outcome = w.linked_login(&mut s, &jwt, &link, Some(true)).await?;
    report_gas("create_session_and_derive + link_jwt (the link that reaches the scope threshold)", &outcome, LINKED_LOGIN_GAS);
    let events = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd.big_y, g1_ckd.big_y);
    let reached = event(&events, "link_threshold_reached");
    assert_eq!((reached.len(), reached[0]["scope_id"].clone(), reached[0]["count"].clone()), (1, json!(w.scope), json!(1)));

    // Case A over the threshold: it succeeds and opens the email wallet; no second event for the scope.
    let (g2, e2) = ("g-thr-2".to_string(), email_sub("thr2@example.com"));
    let (_, e2_ckd) = w.email_login(&e2).await?;
    let (mut s, jwt) = w.google_session(&g2).await?;
    let link = w.auto_link_token(&s, &w.ik(PROVIDER, &g2), &e2, JOIN_SESSION, &w.ik(EMAIL, &e2), 0, true).await?;
    let outcome = w.linked_login(&mut s, &jwt, &link, Some(true)).await?;
    let events = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd.big_y, e2_ckd.big_y);
    assert!(event(&events, "link_threshold_reached").is_empty());
    assert_eq!(env.get_identity(&w.scope, PROVIDER, &g2).await?["status"], json!("member"));

    // link_identity over the threshold succeeds too.
    let (g3, e3) = ("g-thr-3".to_string(), email_sub("thr3@example.com"));
    w.google_login(&g3).await?;
    let signer = w.signer().as_str().to_string();
    let salt = [4u8; 16];
    let now = env.now_ms().await?;
    let (gik, eik) = (w.ik(PROVIDER, &g3), w.ik(EMAIL, &e3));
    let account_jwt = w.google_jwt(&g3, &nonce_of(&link_account_preimage(&signer, &w.scope, &gik, &eik, 0, &salt)), now);
    let new_jwt = w.email.email_jws(&email_aud(&w.scope), &e3, &nonce_of(&link_new_preimage(&signer, &w.scope, &gik, EMAIL, 0, &salt)), now);
    let args = json!({"scope_id": w.scope, "account_jwt": account_jwt, "new_jwt": new_jwt, "epoch": 0, "salt": salt});
    w.call(&env.relayer, "link_identity", args, LINK_IDENTITY_GAS).await?.into_result()?;

    let stats: Value = env.signer.view("get_link_stats").await?.json()?;
    assert_eq!(stats["links_total"], json!(3));
    assert_eq!((stats["current"]["total"].clone(), stats["current"]["flagged_scopes"].clone(), stats["current"]["total_threshold_reached"].clone()), (json!(3), json!([w.scope]), json!(false)));
    // Lowering the total threshold below the count shows it reached at once.
    env.admin.call(w.signer(), "set_link_thresholds").args_json(json!({"per_scope_per_hour": 1, "total_per_hour": 2})).transact().await?.into_result()?;
    let stats: Value = env.signer.view("get_link_stats").await?.json()?;
    assert_eq!((stats["current"]["total_threshold_reached"].clone(), stats["pending_thresholds"].clone()), (json!(true), Value::Null));
    Ok(())
}
