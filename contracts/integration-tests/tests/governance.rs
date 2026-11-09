//! Sandbox tests of the governance batch (docs/governance-spec.md "Tests", "Sandbox e2e") and of the v3 → v4 upgrade
//! (docs/hana-home-h6-design.md, batch H6):
//!
//! - the v3 → v4 upgrade through the owner DAO (`propose_upgrade`, then `execute_upgrade` = deploy + `migrate` in one
//!   receipt) on real v3 state built by the v3 wasm (`V3_COMMIT`), keeping every view, session, wallet, link, pending
//!   change and derivation path; the exit client set through the DAO and used; no way back to v3;
//! - login gas of v4 against v3, and of an exit login;
//! - `execute_upgrade` with raw wasm input: deploy + `migrate` in one receipt, a failing `migrate` rolls back;
//! - the mainnet-style creation batch (Deploy + `new` + DeleteKey signed by the deleted key);
//! - a rotation end to end (updater proposes, watchdog confirms, a forged proposal is cancelled and the updater key
//!   deleted), pause / unpause;
//! - the owner as a 2-of-3 Sputnik DAO v2 council (the pinned wasm and policy of contracts/sputnik/).
//!
//!   cd contracts/integration-tests && cargo test --test governance -- --nocapture

mod common;

use anyhow::{Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::*;
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{AccessKeyPermission, Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};

const PK1: &str = "bls12381g1:A";
const PK2: &str = "bls12381g2:B";

async fn subaccount(root: &Account, name: &str, near: u128) -> Result<Account> {
    Ok(root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
}

/// `wasm` plus a custom section (ignored by the runtime): the same contract under another code hash, so an upgrade to
/// it is visible in `view_account`.
fn with_custom_section(wasm: &[u8], name: &str, data: &[u8]) -> Vec<u8> {
    fn leb128(mut n: usize, out: &mut Vec<u8>) {
        loop {
            let byte = (n & 0x7f) as u8;
            n >>= 7;
            if n == 0 {
                out.push(byte);
                break;
            }
            out.push(byte | 0x80);
        }
    }
    let mut payload = Vec::new();
    leb128(name.len(), &mut payload);
    payload.extend_from_slice(name.as_bytes());
    payload.extend_from_slice(data);
    let mut out = wasm.to_vec();
    out.push(0);
    leb128(payload.len(), &mut out);
    out.extend(payload);
    out
}

fn events_named<'a>(events: &'a [Value], name: &str) -> Vec<&'a Value> {
    events.iter().filter(|e| e["event"] == name).collect()
}

/// Sends `code` as the raw input of `execute_upgrade`, from `caller`, with 300 Tgas.
async fn execute_upgrade(caller: &Account, signer: &AccountId, code: &[u8]) -> Result<ExecutionFinalResult> {
    Ok(caller.call(signer, "execute_upgrade").args(code.to_vec()).gas(Gas::from_tgas(300)).transact().await?)
}

async fn propose_upgrade(owner: &Account, signer: &AccountId, code: &[u8]) -> Result<u64> {
    owner.call(signer, "propose_upgrade").args_json(json!({"code_hash": code_hash(code)})).transact().await?.into_result()?;
    let governance: Value = owner.view(signer, "get_governance").await?.json()?;
    governance["pending_upgrade"]["executable_at_ms"].as_u64().context("pending upgrade")
}

// ---------------------------------------------------------------------------------------------------------------
// v3 → v4 through the DAO

/// Asserts that every field of `before` is in `after` with the same value, recursively (objects may gain fields;
/// arrays keep their length and order). Returns the paths of the fields `after` added.
fn assert_kept(before: &Value, after: &Value, at: &str, added: &mut Vec<String>) {
    match (before, after) {
        (Value::Object(b), Value::Object(a)) => {
            for (k, v) in b {
                let field = format!("{at}.{k}");
                let next = a.get(k).unwrap_or_else(|| panic!("{field} disappeared"));
                assert_kept(v, next, &field, added);
            }
            added.extend(a.keys().filter(|k| !b.contains_key(*k)).map(|k| format!("{at}.{k}")));
        }
        (Value::Array(b), Value::Array(a)) => {
            assert_eq!(b.len(), a.len(), "{at}: length changed");
            for (i, (bv, av)) in b.iter().zip(a).enumerate() {
                assert_kept(bv, av, &format!("{at}[{i}]"), added);
            }
        }
        _ => assert_eq!(before, after, "{at} changed"),
    }
}

/// A sandbox with a v3 hana-signer (the code sandbox-dev runs now, built from V3_COMMIT) holding real v3 state: Hana's
/// email issuer (self-issued, its key active), scopes s1 = [A, C, email:s1] (alice, no shared login), s2 = [B] (bob) and
/// s3 (shared only), the Google key (watchdog-confirmed), a console audience, a sponsor, a pending shared client, a
/// pending AddClient (D) in s1, a removed (quarantined) client (C), a Google session used once, Google and email wallets
/// opened by combined logins, an email identity linked to a Google wallet (a member), an updater key with a pending key
/// proposal, a watchdog, and a 2 of 3 Sputnik DAO as the owner (as on sandbox-dev).
struct V3World {
    worker: Worker<Sandbox>,
    signer: Contract,
    alice: Account,
    bob: Account,
    relayer: Account,
    watchdog: Account,
    outsider: Account,
    council: [Account; 3],
    dao: Contract,
    bond: NearToken,
    mpc: Contract,
    issuer: TestIssuer,
    email: TestIssuer,
    /// The email identity with its own wallet in s1, and the one linked (a member) into USER_SUB's Google wallet.
    e_root: String,
    e_member: String,
    scope_a: String,
    /// Opened (create_session + one derive_key) by v3 code.
    session: TestSession,
    /// The updater key's pending proposal of Google's next key.
    pending_key_id: u64,
}

impl V3World {
    fn dao(&self) -> Dao<'_> {
        Dao { dao: &self.dao, bond: self.bond }
    }

    /// The council passes one FunctionCall proposal to the signer (2 of 3 votes); returns the proposal's last vote.
    async fn council_call(&self, method: &str, args: Value) -> Result<ExecutionFinalResult> {
        let dao = self.dao();
        let id = dao.propose(&self.council[0], method, function_call(self.signer.id(), method, args)).await?;
        dao.vote(&self.council[0], id).await?.into_result()?;
        let outcome = dao.vote(&self.council[1], id).await?;
        let status = dao.status(id).await?;
        if status != "Approved" {
            anyhow::bail!("council proposal {method} ended {status}: {:?}", outcome.into_result().err());
        }
        Ok(outcome)
    }

    /// As `council_call`, but returns the proposal's final status and the text of the last vote's outcome (with the
    /// signer's panic when the FunctionCall failed).
    async fn council_try(&self, method: &str, args: Value) -> Result<(String, String)> {
        let dao = self.dao();
        let id = dao.propose(&self.council[0], method, function_call(self.signer.id(), method, args)).await?;
        dao.vote(&self.council[0], id).await?.into_result()?;
        let outcome = dao.vote(&self.council[1], id).await?;
        Ok((dao.status(id).await?, format!("{:?}", outcome.receipt_failures())))
    }

    async fn now_ms(&self) -> Result<u64> {
        now_ms(&self.worker).await
    }

    async fn views(&self) -> Result<Value> {
        let s = &self.signer;
        let view = |method: &'static str, args: Value| async move { Ok::<Value, anyhow::Error>(s.view(method).args_json(args).await?.json()?) };
        Ok(json!({
            "config": view("get_config", json!({})).await?,
            "governance": view("get_governance", json!({})).await?,
            "issuer": view("get_issuer", json!({"provider": PROVIDER})).await?,
            "issuer_keys": view("get_issuer_keys", json!({"provider": PROVIDER})).await?,
            "email_issuer": view("get_issuer", json!({"provider": EMAIL})).await?,
            "self_issued": view("get_self_issued", json!({"provider": EMAIL})).await?,
            "key_changes": view("get_key_changes", json!({})).await?,
            "link_stats": view("get_link_stats", json!({})).await?,
            "s1": view("get_scope", json!({"scope_id": "s1"})).await?,
            "s2": view("get_scope", json!({"scope_id": "s2"})).await?,
            "s3": view("get_scope", json!({"scope_id": "s3"})).await?,
            "clients": [
                view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_A})).await?,
                view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_B})).await?,
                view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_C})).await?,
                view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_D})).await?,
                view("scope_for_client", json!({"provider": PROVIDER, "aud": SHARED})).await?,
                view("scope_for_client", json!({"provider": EMAIL, "aud": email_aud("s1")})).await?,
            ],
            "session": view("get_session", json!({"session_public_key": self.session.public_key()})).await?,
            "in_use": view("session_key_in_use", json!({"session_public_key": self.session.public_key()})).await?,
            "account": view("get_account", json!({"scope_id": "s1", "provider": PROVIDER, "sub": USER_SUB})).await?,
            "identity_member": view("get_identity", json!({"scope_id": "s1", "provider": EMAIL, "sub": self.e_member})).await?,
            "identity_user": view("get_identity", json!({"scope_id": "s1", "provider": PROVIDER, "sub": USER_SUB})).await?,
        }))
    }

    async fn expected_ckd(&self, path: &str) -> Result<CkdResponse> {
        let request = json!({"derivation_path": path, "app_public_key": {"AppPublicKeyPV": {"pk1": PK1, "pk2": PK2}}, "domain_id": CKD_DOMAIN_ID});
        Ok(self.mpc.view("expected_response").args_json(json!({"request": request})).await?.json()?)
    }

    /// A combined login with `jwt` for session `s`, as the API relays it.
    async fn relay_login(&self, s: &mut TestSession, jwt: &str) -> Result<ExecutionFinalResult> {
        Ok(self.relayer.call(self.signer.id(), "create_session_and_derive").args_json(s.login_args(jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?)
    }

    /// A combined login of `sub` in s1 through its own Google client (APP_A).
    async fn login(&self, sub: &str) -> Result<(TestSession, CkdResponse)> {
        let now = self.now_ms().await?;
        let mut s = TestSession::new(&self.scope_a, now + 600_000, 0, 5);
        let jwt = self.issuer.jwt(APP_A, sub, Some(&s.nonce(self.signer.id())), now);
        let ckd = self.relay_login(&mut s, &jwt).await?.into_result()?.json()?;
        Ok((s, ckd))
    }

    /// A combined login of email identity `sub` in s1, through s1's email client.
    async fn email_login(&self, sub: &str) -> Result<(TestSession, CkdResponse)> {
        let now = self.now_ms().await?;
        let mut s = TestSession::new(&self.scope_a, now + 600_000, 0, 5);
        let jwt = self.email.email_jws(&email_aud("s1"), sub, &s.nonce(self.signer.id()), now);
        let ckd = self.relay_login(&mut s, &jwt).await?.into_result()?.json()?;
        Ok((s, ckd))
    }

    /// A combined exit login (30 min, 3 uses) of `sub` in `scope`: Google through the exit client, or email (EMAIL) through the issuer's Home audience.
    async fn exit_login(&self, provider: &str, sub: &str, scope: &str) -> Result<(TestSession, ExecutionFinalResult)> {
        let now = self.now_ms().await?;
        let mut s = TestSession::new(scope, now + 25 * 60_000, 0, 3);
        let nonce = s.nonce(self.signer.id());
        let jwt = if provider == EMAIL { self.email.email_jws(EXIT_E, sub, &nonce, now) } else { self.issuer.jwt(EXIT_G, sub, Some(&nonce), now) };
        let outcome = self.relay_login(&mut s, &jwt).await?;
        Ok((s, outcome))
    }

    async fn root_state_len(&self) -> Result<usize> {
        let state = self.worker.view_state(self.signer.id()).await?;
        Ok(state.get(b"STATE".as_slice()).context("STATE")?.len())
    }
}

/// change_delay_ms of the v3 world: longer than the owner transfer plus the upgrade's delay (2 × GOVERNANCE_DELAY_MS).
const V3_CHANGE_DELAY_MS: u64 = 180_000;

async fn v3_world() -> Result<V3World> {
    let (_, mpc_wasm) = wasms()?;
    let v3 = v3_wasm()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = subaccount(&root, "admin", 20).await?;
    let alice = subaccount(&root, "alice", 20).await?;
    let bob = subaccount(&root, "bob", 20).await?;
    let relayer = subaccount(&root, "relayer", 20).await?;
    let watchdog = subaccount(&root, "watchdog", 20).await?;
    let outsider = subaccount(&root, "outsider", 20).await?;
    let council = [subaccount(&root, "council-a", 20).await?, subaccount(&root, "council-b", 20).await?, subaccount(&root, "council-c", 20).await?];
    let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    let issuer = TestIssuer::generate()?;
    let signer = deploy_signer_code(&root, "signer", &v3, &admin, &watchdog, mpc.id(), &issuer, relayer.id()).await?;
    assert_eq!(signer.view("get_governance").await?.json::<Value>()?["state_version"], json!(3));
    // Hana's email issuer, as sandbox-dev has it: created, marked self-issued, an owner-posted key after the governance delay.
    let email = TestIssuer::generate_with_kid(EMAIL_KID)?;
    admin.call(signer.id(), "set_issuer").args_json(json!({"provider": EMAIL, "iss_values": [EMAIL_ISS]})).gas(GAS).transact().await?.into_result()?;
    admin.call(signer.id(), "mark_self_issued").args_json(json!({"provider": EMAIL})).gas(GAS).transact().await?.into_result()?;
    let key_id = post_email_key(&admin, signer.id(), &email).await?;
    let changes: Value = signer.view("get_key_changes").await?.json()?;
    let due = changes.as_array().unwrap().iter().find(|c| c["id"] == json!(key_id)).context("the email key change")?["executable_at_ms"].as_u64().unwrap();
    advance_to(&worker, due).await?;
    outsider.call(signer.id(), "execute_issuer_key_change").args_json(json!({"id": key_id})).gas(Gas::from_tgas(30)).transact().await?.into_result()?;

    let register = |owners: Value, clients: Value, allow_shared: bool| {
        admin.call(signer.id(), "admin_register_scope").args_json(json!({"owners": owners, "clients": clients, "scope_id": null, "allow_shared": allow_shared})).gas(GAS).transact()
    };
    let aud = email_aud("s1");
    let scope_a: String = register(json!([near_owner(alice.id())]), json!([[PROVIDER, APP_A], [PROVIDER, APP_C], [EMAIL, aud]]), false).await?.into_result()?.json()?;
    assert_eq!(scope_a, "s1");
    let _s2: String = register(json!([near_owner(bob.id())]), json!([[PROVIDER, APP_B]]), false).await?.into_result()?.json()?;
    let _s3: String = register(json!([near_owner(bob.id())]), json!([]), true).await?.into_result()?.json()?;
    // A longer change delay (an increase applies at once), so C's quarantine below outlasts the owner transfer and the
    // upgrade's governance delay and is checked after the upgrade.
    admin.call(signer.id(), "set_change_delay_ms").args_json(json!({"change_delay_ms": V3_CHANGE_DELAY_MS})).transact().await?.into_result()?;
    // A shared client (pending for the change delay).
    admin.call(signer.id(), "set_shared_clients").args_json(json!({"clients": [[PROVIDER, SHARED]]})).gas(GAS).transact().await?.into_result()?;
    // A pending AddClient (D) in s1, with a client proof at action_nonce 0, then C removed (quarantined).
    let now = now_ms(&worker).await?;
    let proof = issuer.jwt(APP_D, OWNER_SUB, Some(&client_proof_nonce(signer.id().as_str(), &scope_a, 0)), now);
    alice
        .call(signer.id(), "propose_change")
        .args_json(json!({"scope_id": scope_a, "auth": "Near", "change": {"AddClient": {"provider": PROVIDER, "aud": APP_D}}, "client_proof": proof}))
        .deposit(NearToken::from_millinear(10))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    alice.call(signer.id(), "remove_client").args_json(json!({"scope_id": scope_a, "auth": "Near", "provider": PROVIDER, "aud": APP_C})).gas(GAS).transact().await?.into_result()?;
    // A session (5 uses, 30 min) used once, and Google and email wallets opened by combined logins, with the email member.
    let now = now_ms(&worker).await?;
    let mut session = TestSession::new(&scope_a, now + 1_800_000, 0, 5);
    let jwt = issuer.jwt(APP_A, USER_SUB, Some(&session.nonce(signer.id())), now);
    relayer.call(signer.id(), "create_session").args_json(session.create_args(signer.id(), &jwt)).gas(GAS).transact().await?.into_result()?;
    relayer.call(signer.id(), "derive_key").args_json(session.derive_args(PK1, PK2)).gas(GAS).transact().await?.into_result()?;
    let mut login = TestSession::new(&scope_a, now + 600_000, 0, 1);
    let jwt = issuer.jwt(APP_A, OWNER_SUB, Some(&login.nonce(signer.id())), now);
    relayer.call(signer.id(), "create_session_and_derive").args_json(login.login_args(&jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?.into_result()?;
    let e_root = email_sub("ada@example.com");
    let mut es = TestSession::new("s1", now + 600_000, 0, 5);
    let ejwt = email.email_jws(&email_aud("s1"), &e_root, &es.nonce(signer.id()), now);
    relayer.call(signer.id(), "create_session_and_derive").args_json(es.login_args(&ejwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?.into_result()?;
    // A member: the email identity joins USER_SUB's Google wallet at once (case B), through an automatic link.
    let e_member = email_sub("bea@example.com");
    let gik = identity_key("s1", PROVIDER, USER_SUB);
    let mut ls = TestSession::new("s1", now + 600_000, 0, 5);
    let jwt = issuer.jwt(APP_A, USER_SUB, Some(&ls.nonce(signer.id())), now);
    let nonce = nonce_of(&auto_link_preimage(signer.id().as_str(), "s1", &ls.preimage_hash(signer.id()), &gik, JOIN_LINK, &identity_key("s1", EMAIL, &e_member), &gik, 0, true));
    let link = email.email_jws(&email_aud("s1"), &e_member, &nonce, now);
    relayer.call(signer.id(), "create_session_and_derive").args_json(ls.linked_login_args(&jwt, PK1, PK2, &link, Some(true))).gas(Gas::from_tgas(250)).transact().await?.into_result()?;
    // An updater key, and its (not yet confirmed) proposal of Google's next key.
    let updater = add_updater_key(&worker, &admin, signer.id()).await?;
    let next = TestIssuer::generate_with_kid("google-next")?;
    let pending_key_id: u64 = updater
        .call(signer.id(), "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": next.kid, "n": next.n, "e": next.e}))
        .gas(Gas::from_tgas(30))
        .transact()
        .await?
        .into_result()?
        .json()?;

    // The council DAO becomes the owner (propose_owner, then the DAO's accept_owner after the governance delay).
    let sputnik = sputnik_wasm()?;
    let policy = sputnik_policy(&[council[0].id(), council[1].id(), council[2].id()])?;
    let dao = subaccount(&root, "council", 30).await?.deploy(&sputnik).await?.into_result()?;
    dao.call("new").args_json(json!({"config": {"name": "hana-council", "purpose": "hana-signer owner", "metadata": ""}, "policy": policy})).gas(GAS).transact().await?.into_result()?;
    let bond = NearToken::from_yoctonear(policy["proposal_bond"].as_str().unwrap().parse()?);
    admin.call(signer.id(), "propose_owner").args_json(json!({"owner": dao.id()})).transact().await?.into_result()?;
    let acceptable = signer.view("get_governance").await?.json::<Value>()?["pending_owner"]["acceptable_at_ms"].as_u64().context("pending owner")?;
    advance_to(&worker, acceptable).await?;
    let w = V3World { worker, signer, alice, bob, relayer, watchdog, outsider, council, dao, bond, mpc, issuer, email, e_root, e_member, scope_a, session, pending_key_id };
    w.council_call("accept_owner", json!({})).await?.into_result()?;
    assert_eq!(w.signer.view("get_config").await?.json::<Value>()?["owner"], json!(w.dao.id()));
    Ok(w)
}

/// The upgrade H6 needs (docs/hana-home-h6-design.md section 5): v3 → v4 through the owner DAO (`propose_upgrade` by 2 of 3,
/// then anyone `execute_upgrade`s the exact wasm, which deploys it and runs `migrate` in one receipt). Every v3 view is
/// unchanged (views only gain fields), every session, wallet, link and pending change survives, every path stays. Then
/// the exit client through the DAO: a pending client doesn't count, in force it opens sessions in a scope that refused
/// shared login, on the same paths, and it can be removed at once, for good. The v3 code can't come back.
#[tokio::test]
async fn v3_to_v4_upgrade_through_the_dao_keeps_every_view_and_path() -> Result<()> {
    let mut w = v3_world().await?;
    let signer = w.signer.id().clone();
    // The exact artifact deploy-contract deploys (--no-abi), as the v3 code was.
    let v4 = deploy_wasm()?;
    let v3 = v3_wasm()?;
    assert_eq!(account_code_hash(&w.worker, &signer).await?, code_hash(&v3));
    let before = w.views().await?;
    assert_eq!(before["governance"]["state_version"], json!(3));
    assert_eq!(before["s1"]["pending"].as_array().unwrap().len(), 1);
    assert_eq!(before["session"]["used"], json!(1));
    assert_eq!(before["key_changes"].as_array().unwrap().len(), 1);
    assert_eq!(before["link_stats"]["links_total"], json!(1));
    let path = before["session"]["path"].as_str().unwrap().to_string();
    assert_eq!(path, format!("s1#google#{USER_SUB}#0"));
    assert_eq!(before["identity_member"]["status"], json!("member"));
    let state_before = w.root_state_len().await?;
    let storage_before = w.signer.as_account().view_account().await?.storage_usage;

    // v3 has no exit methods.
    let text = expect_failure(tx(w.outsider.call(&signer, "set_exit_clients").args_json(json!({"clients": []})).transact().await), "");
    assert!(text.contains("MethodNotFound"), "{text}");

    // The council proposes the upgrade (2 of 3); after the governance delay anyone sends the exact wasm.
    w.council_call("propose_upgrade", json!({"code_hash": code_hash(&v4)})).await?.into_result()?;
    let due = w.signer.view("get_governance").await?.json::<Value>()?["pending_upgrade"]["executable_at_ms"].as_u64().context("pending upgrade")?;
    expect_failure(execute_upgrade(&w.outsider, &signer, &v4).await, "Upgrade is still delayed");
    advance_to(&w.worker, due).await?;
    expect_failure(execute_upgrade(&w.outsider, &signer, &v3).await, "Code doesn't match the proposed hash");
    let outcome = execute_upgrade(&w.outsider, &signer, &v4).await?;
    report_gas(&format!("execute_upgrade v3 → v4 ({} KB wasm, deploy + migrate)", v4.len() / 1024), &outcome, Gas::from_tgas(300));
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "upgrade_executed")[0]["data"][0], json!({"code_hash": code_hash(&v4)}));
    assert_eq!(events_named(&events, "state_migrated")[0]["data"][0], json!({"from_version": 3, "to_version": 4}));
    assert_eq!(account_code_hash(&w.worker, &signer).await?, code_hash(&v4));

    // Every v3 view is unchanged; views only gained fields, and the only changed value is the state version.
    let mut after = w.views().await?;
    assert_eq!(after["governance"]["state_version"], json!(4));
    after["governance"]["state_version"] = json!(3);
    let mut added = vec![];
    assert_kept(&before, &after, "", &mut added);
    added.sort();
    assert_eq!(added, vec![".config.exit_clients".to_string(), ".config.exit_window".to_string(), ".config.pending_exit_clients".to_string()], "fields v4 added to the v3 views");
    assert_eq!(after["config"]["exit_clients"], json!([]));
    assert_eq!(after["config"]["pending_exit_clients"], json!([]));
    let state_after = w.root_state_len().await?;
    let storage_after = w.signer.as_account().view_account().await?.storage_usage;
    println!("STORAGE root STATE v3 {state_before} B → v4 {state_after} B (+{} B); account storage {storage_before} → {storage_after} B (includes the code's size change)", state_after - state_before);

    // State no view shows survives too. The quarantine: C, removed from s1 by v3 code, can't join s2 yet.
    let now = w.now_ms().await?;
    let proof = w.issuer.jwt(APP_C, OWNER_SUB, Some(&client_proof_nonce(signer.as_str(), "s2", 0)), now);
    expect_failure(
        tx(w.bob
            .call(&signer, "propose_change")
            .args_json(json!({"scope_id": "s2", "auth": "Near", "change": {"AddClient": {"provider": PROVIDER, "aud": APP_C}}, "client_proof": proof}))
            .deposit(NearToken::from_millinear(10))
            .gas(GAS)
            .transact()
            .await),
        "Client was recently removed from another scope",
    );
    // The pending AddClient's reservation (pending_adds): D can't be made a shared client while it is pending in s1.
    let (status, text) = w.council_try("set_shared_clients", json!({"clients": [[PROVIDER, SHARED], [PROVIDER, APP_D]]})).await?;
    assert_eq!(status, "Failed");
    assert!(text.contains("Client is pending in a scope"), "{text}");
    // The scope counter: s1..s3 exist, the next registration is s4.
    w.council_call("admin_register_scope", json!({"owners": [near_owner(w.bob.id())], "clients": [], "scope_id": null, "allow_shared": true})).await?.into_result()?;
    let s4: Value = w.signer.view("get_scope").args_json(json!({"scope_id": "s4"})).await?.json()?;
    assert_eq!((s4["owners"].clone(), s4["allow_shared"].clone()), (json!([near_owner(w.bob.id())]), json!(true)));

    // The session opened by v3 code derives again with the same path; fresh logins through the own clients get the paths
    // v3 gave (Google, email, a member its root's).
    let outcome = w.relayer.call(&signer, "derive_key").args_json(w.session.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?;
    let response: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(response, w.expected_ckd(&path).await?);
    let (fresh, ckd) = w.login(USER_SUB).await?;
    assert_eq!(ckd, w.expected_ckd(&path).await?);
    assert_eq!(w.signer.view("get_session").args_json(json!({"session_public_key": fresh.public_key()})).await?.json::<Value>()?["path"], json!(path));
    let (_, ckd) = w.email_login(&w.e_root).await?;
    assert_eq!(ckd, w.expected_ckd(&format!("s1#email#{}#0", w.e_root)).await?);
    let (_, ckd) = w.email_login(&w.e_member).await?;
    assert_eq!(ckd, w.expected_ckd(&path).await?, "the member opens the root's (v3) wallet");

    // The pending AddClient executes on schedule; the updater's pending key proposal is still there and the watchdog
    // confirms it.
    let unlock = before["s1"]["pending"][0]["unlock_at_ms"].as_u64().context("pending change")?;
    advance_to(&w.worker, unlock).await?;
    w.alice.call(&signer, "execute_change").args_json(json!({"scope_id": w.scope_a, "change_id": 0})).gas(GAS).transact().await?.into_result()?;
    let d: Option<String> = w.signer.view("scope_for_client").args_json(json!({"provider": PROVIDER, "aud": APP_D})).await?.json()?;
    assert_eq!(d.as_deref(), Some(w.scope_a.as_str()));
    w.watchdog.call(&signer, "confirm_issuer_key_change").args_json(json!({"id": w.pending_key_id})).transact().await?.into_result()?;

    // The exit client, through the DAO: a pending client doesn't count yet, and the audience-shape rule refuses the email
    // audience as a scope client, even before the exit list holds it (the owner of s1 has a valid email proof).
    let now = w.now_ms().await?;
    let action_nonce = w.signer.view("get_scope").args_json(json!({"scope_id": "s1"})).await?.json::<Value>()?["action_nonce"].as_u64().context("action_nonce")?;
    let proof = w.email.email_jws(EXIT_E, &email_sub("hana-client-proof"), &client_proof_nonce(signer.as_str(), "s1", action_nonce), now);
    expect_failure(
        tx(w.alice
            .call(&signer, "propose_change")
            .args_json(json!({"scope_id": "s1", "auth": "Near", "change": {"AddClient": {"provider": EMAIL, "aud": EXIT_E}}, "client_proof": proof}))
            .deposit(NearToken::from_millinear(10))
            .gas(GAS)
            .transact()
            .await),
        "A self-issued client must be its provider and scope",
    );
    w.council_call("set_exit_clients", json!({"clients": [[PROVIDER, EXIT_G], [EMAIL, EXIT_E]]})).await?.into_result()?;
    let config: Value = w.signer.view("get_config").await?.json()?;
    assert_eq!(config["exit_clients"], json!([]));
    let due = config["pending_exit_clients"][1]["effective_at_ms"].as_u64().context("pending exit client")?;
    let now = w.now_ms().await?;
    let s = TestSession::new("s1", now + 25 * 60_000, 0, 3);
    let jwt = w.issuer.jwt(EXIT_G, USER_SUB, Some(&s.nonce(&signer)), now);
    expect_failure(tx(w.relayer.call(&signer, "create_session").args_json(s.create_args(&signer, &jwt)).gas(GAS).transact().await), "Token is for an unregistered app");
    advance_to(&w.worker, due).await?;

    // In force: the same user's exit logins in s1 (no shared login) give the identical paths. One event and counter each.
    let (s, outcome) = w.exit_login(PROVIDER, USER_SUB, "s1").await?;
    report_gas("create_session_and_derive (exit, Google)", &outcome, api_gas("create_session_and_derive"));
    let ev = hana_events(&outcome);
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd, w.expected_ckd(&path).await?, "exit: the own client's wallet");
    let exit_events = events_named(&ev, "exit_session_opened");
    assert_eq!(exit_events.len(), 1);
    let data = exit_events[0]["data"][0].to_string();
    assert!(!data.contains(USER_SUB), "the event never carries a sub: {data}");
    assert_eq!(exit_events[0]["data"][0]["identity_key"], json!(hex(&identity_key("s1", PROVIDER, USER_SUB))));
    assert_eq!(w.signer.view("get_session").args_json(json!({"session_public_key": s.public_key()})).await?.json::<Value>()?["path"], json!(path));
    let (_, outcome) = w.exit_login(EMAIL, &w.e_root, "s1").await?;
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd, w.expected_ckd(&format!("s1#email#{}#0", w.e_root)).await?, "exit: the email identity's wallet");
    let (_, outcome) = w.exit_login(EMAIL, &w.e_member, "s1").await?;
    let ckd: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(ckd, w.expected_ckd(&path).await?, "exit: a member opens its root's path");
    let config: Value = w.signer.view("get_config").await?.json()?;
    assert_eq!(config["exit_clients"].as_array().unwrap().len(), 2);
    assert_eq!(config["exit_window"]["current"], json!(3));

    // Pause stops exit too (and comes back); then the council removes the Google client at once, for good.
    w.watchdog.call(&signer, "pause").transact().await?.into_result()?;
    let (paused, ..) = {
        let now = w.now_ms().await?;
        let s = TestSession::new("s1", now + 25 * 60_000, 0, 3);
        let jwt = w.issuer.jwt(EXIT_G, USER_SUB, Some(&s.nonce(&signer)), now);
        let outcome = w.relayer.call(&signer, "create_session").args_json(s.create_args(&signer, &jwt)).gas(GAS).transact().await?;
        (outcome,)
    };
    expect_failure(Ok(paused), "Paused");
    w.council_call("unpause", json!({})).await?.into_result()?;
    let (status, text) = w.council_try("set_exit_clients", json!({"clients": [[EMAIL, EXIT_E]]})).await?;
    assert_eq!(status, "Approved", "{text}");
    let config: Value = w.signer.view("get_config").await?.json()?;
    assert_eq!(config["exit_clients"], json!([[EMAIL, EXIT_E]]));
    let now = w.now_ms().await?;
    let s = TestSession::new("s1", now + 25 * 60_000, 0, 3);
    let jwt = w.issuer.jwt(EXIT_G, USER_SUB, Some(&s.nonce(&signer)), now);
    expect_failure(tx(w.relayer.call(&signer, "create_session").args_json(s.create_args(&signer, &jwt)).gas(GAS).transact().await), "Token is for an unregistered app");
    let (status, text) = w.council_try("set_exit_clients", json!({"clients": [[EMAIL, EXIT_E], [PROVIDER, EXIT_G]]})).await?;
    assert_eq!(status, "Failed", "{text}");
    assert!(text.contains("Client was an exit client and is retired"), "{text}");

    // The v3 code can't come back: its migrate reads the v3 layout, which the v4 state isn't, so the deploy reverts.
    w.council_call("propose_upgrade", json!({"code_hash": code_hash(&v3)})).await?.into_result()?;
    let due = w.signer.view("get_governance").await?.json::<Value>()?["pending_upgrade"]["executable_at_ms"].as_u64().context("pending upgrade")?;
    advance_to(&w.worker, due).await?;
    expect_failure(execute_upgrade(&w.outsider, &signer, &v3).await, "Unexpected state version");
    assert_eq!(account_code_hash(&w.worker, &signer).await?, code_hash(&v4));
    assert_eq!(w.signer.view("get_governance").await?.json::<Value>()?["state_version"], json!(4));
    // migrate stays private.
    expect_failure(tx(w.alice.call(&signer, "migrate").args_json(json!({})).transact().await), "is private");

    // The session queue survived: once the sessions opened by v3 code expire, prune_sessions removes them.
    advance_to(&w.worker, before["session"]["expires_at_ms"].as_u64().context("expiry")? + 1_000).await?;
    let key = json!({"session_public_key": w.session.public_key()});
    assert!(w.signer.view("get_session").args_json(key.clone()).await?.json::<Value>()?.is_object(), "an expired session stays until pruned");
    let pruned: u32 = w.outsider.call(&signer, "prune_sessions").args_json(json!({"limit": 50})).gas(GAS).transact().await?.into_result()?.json()?;
    assert!(pruned >= 2, "pruned {pruned}");
    assert_eq!(w.signer.view("get_session").args_json(key).await?.json::<Value>()?, Value::Null);
    Ok(())
}

/// Login gas of v4 against v3 (no link): the same create_session and create_session_and_derive on two deployments that
/// differ only in code (one upgraded v3 → v4 in place), then an exit login on v4. The design's estimate
/// (docs/hana-home-h6-design.md section 5): about 0.01 Tgas per call for the extra root state, under 0.1 Tgas for the
/// exit event; these runs measure it.
#[tokio::test]
async fn login_gas_of_v4_against_v3_and_of_an_exit_login() -> Result<()> {
    let (_, mpc_wasm) = wasms()?;
    let v4 = deploy_wasm()?;
    let v3 = v3_wasm()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = subaccount(&root, "admin", 20).await?;
    let relayer = subaccount(&root, "relayer", 20).await?;
    let watchdog = subaccount(&root, "watchdog", 20).await?;
    let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    let issuer = TestIssuer::generate()?;
    // Same-length account names, so nonces and storage keys have the same size.
    let old = deploy_signer_code(&root, "signer1", &v3, &admin, &watchdog, mpc.id(), &issuer, relayer.id()).await?;
    let new = deploy_signer_code(&root, "signer2", &v3, &admin, &watchdog, mpc.id(), &issuer, relayer.id()).await?;
    let due = propose_upgrade(&admin, new.id(), &v4).await?;
    advance_to(&worker, due).await?;
    let upgrade = execute_upgrade(&admin, new.id(), &v4).await?;
    report_gas(&format!("execute_upgrade v3 → v4 ({} KB wasm, small state)", v4.len() / 1024), &upgrade, Gas::from_tgas(300));
    upgrade.into_result()?;
    assert_eq!(new.view("get_governance").await?.json::<Value>()?["state_version"], json!(4));
    let state_len = |c: Contract| {
        let w = worker.clone();
        async move { Ok::<usize, anyhow::Error>(w.view_state(c.id()).await?.get(b"STATE".as_slice()).context("STATE")?.len()) }
    };
    let (v3_state, v4_state) = (state_len(old.clone()).await?, state_len(new.clone()).await?);
    println!("STORAGE root STATE v3 {v3_state} B, v4 (empty lists) {v4_state} B: +{} B", v4_state - v3_state);

    let mut burnt = vec![];
    for signer in [&old, &new] {
        let scope: String = admin
            .call(signer.id(), "admin_register_scope")
            .args_json(json!({"owners": [near_owner(admin.id())], "clients": [[PROVIDER, APP_A]], "scope_id": null, "allow_shared": false}))
            .gas(GAS)
            .transact()
            .await?
            .into_result()?
            .json()?;
        let now = now_ms(&worker).await?;
        let mut gas = vec![];
        // The first combined login of each identity (it records `opened`), then a second one, then a bare create_session.
        for sub in [USER_SUB, OWNER_SUB] {
            for _ in 0..2 {
                let mut s = TestSession::new(&scope, now + 600_000, 0, 1);
                let jwt = issuer.jwt(APP_A, sub, Some(&s.nonce(signer.id())), now);
                let outcome = relayer.call(signer.id(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?;
                gas.push(outcome.total_gas_burnt.as_gas());
                outcome.into_result()?;
            }
            let s = TestSession::new(&scope, now + 600_000, 0, 1);
            let jwt = issuer.jwt(APP_A, sub, Some(&s.nonce(signer.id())), now);
            let outcome = relayer.call(signer.id(), "create_session").args_json(s.create_args(signer.id(), &jwt)).gas(api_gas("create_session")).transact().await?;
            gas.push(outcome.total_gas_burnt.as_gas());
            outcome.into_result()?;
        }
        burnt.push((gas, scope));
    }
    let names = ["create_session_and_derive (first)", "create_session_and_derive (later)", "create_session"];
    for (i, name) in names.iter().chain(names.iter()).enumerate() {
        let (v3, v4) = (burnt[0].0[i] as f64, burnt[1].0[i] as f64);
        println!("GAS {name}, Google, no link: v3 {:.2} Tgas, v4 {:.2} Tgas ({:+.3} Tgas)", v3 / 1e12, v4 / 1e12, (v4 - v3) / 1e12);
        assert!(v4 <= v3 + 0.5e12, "{name}: v4 burnt {v4} gas, more than 0.5 Tgas over v3's {v3} (the design's estimate is 0.01 Tgas)");
    }

    // An exit login on v4: exit list set, in force, then the same flows through the exit client.
    let scope = burnt[1].1.clone();
    admin.call(new.id(), "set_exit_clients").args_json(json!({"clients": [[PROVIDER, EXIT_G]]})).gas(GAS).transact().await?.into_result()?;
    let due = new.view("get_config").await?.json::<Value>()?["pending_exit_clients"][0]["effective_at_ms"].as_u64().context("pending exit client")?;
    advance_to(&worker, due).await?;
    let v4_full_state = state_len(new.clone()).await?;
    println!("STORAGE root STATE v4 with one Google exit client: {v4_full_state} B, +{} B over v3 (the design estimated about 250 B for the full list)", v4_full_state - v3_state);
    let now = now_ms(&worker).await?;
    let mut normal = vec![];
    let mut exit = vec![];
    for sub in ["user-1", "user-2"] {
        let mut s = TestSession::new(&scope, now + 600_000, 0, 3);
        let jwt = issuer.jwt(APP_A, sub, Some(&s.nonce(new.id())), now);
        let outcome = relayer.call(new.id(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?;
        normal.push(outcome.total_gas_burnt.as_gas());
        outcome.into_result()?;
    }
    for sub in ["user-3", "user-4"] {
        let mut s = TestSession::new(&scope, now + 600_000, 0, 3);
        let jwt = issuer.jwt(EXIT_G, sub, Some(&s.nonce(new.id())), now);
        let outcome = relayer.call(new.id(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?;
        exit.push(outcome.total_gas_burnt.as_gas());
        outcome.into_result()?;
    }
    let bare_n = {
        let s = TestSession::new(&scope, now + 600_000, 0, 3);
        let jwt = issuer.jwt(APP_A, "user-5", Some(&s.nonce(new.id())), now);
        let outcome = relayer.call(new.id(), "create_session").args_json(s.create_args(new.id(), &jwt)).gas(api_gas("create_session")).transact().await?;
        let g = outcome.total_gas_burnt.as_gas();
        outcome.into_result()?;
        g
    };
    let bare_e = {
        let s = TestSession::new(&scope, now + 600_000, 0, 3);
        let jwt = issuer.jwt(EXIT_G, "user-6", Some(&s.nonce(new.id())), now);
        let outcome = relayer.call(new.id(), "create_session").args_json(s.create_args(new.id(), &jwt)).gas(api_gas("create_session")).transact().await?;
        let g = outcome.total_gas_burnt.as_gas();
        outcome.into_result()?;
        g
    };
    let avg = |v: &[u64]| v.iter().sum::<u64>() as f64 / v.len() as f64 / 1e12;
    println!("GAS create_session_and_derive (first login), v4: own client {:.3} Tgas, exit client {:.3} Tgas ({:+.3} Tgas, the design: under 0.1)", avg(&normal), avg(&exit), avg(&exit) - avg(&normal));
    println!("GAS create_session, v4: own client {:.3} Tgas, exit client {:.3} Tgas ({:+.3} Tgas)", bare_n as f64 / 1e12, bare_e as f64 / 1e12, (bare_e as f64 - bare_n as f64) / 1e12);
    assert!(avg(&exit) <= avg(&normal) + 0.5, "exit burnt {} Tgas against {} Tgas: more than the design's bound", avg(&exit), avg(&normal));
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Timelocked upgrades

#[tokio::test]
async fn execute_upgrade_deploys_and_migrates_in_one_receipt() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let (v4, mock) = wasms()?;
    let next = with_custom_section(&v4, "hana-test-upgrade", b"next");
    assert_ne!(code_hash(&next), code_hash(&v4));
    // A session opened before the upgrade.
    let (mut session, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &session, &jwt).await?.into_result()?;

    // Only the owner proposes.
    expect_failure(tx(env.alice.call(signer, "propose_upgrade").args_json(json!({"code_hash": code_hash(&next)})).transact().await), "Only the owner can do this");
    expect_failure(tx(env.watchdog.call(signer, "propose_upgrade").args_json(json!({"code_hash": code_hash(&next)})).transact().await), "Only the owner can do this");
    expect_failure(execute_upgrade(&env.alice, signer, &next).await, "No pending upgrade");
    let due = propose_upgrade(&env.admin, signer, &next).await?;
    let now = env.now_ms().await?;
    assert!(due >= now + GOVERNANCE_DELAY_MS - 5_000, "due {due}, now {now}");
    expect_failure(execute_upgrade(&env.alice, signer, &next).await, "Upgrade is still delayed");
    env.advance_to(due).await?;
    expect_failure(execute_upgrade(&env.alice, signer, &mock).await, "Code doesn't match the proposed hash");
    expect_failure(execute_upgrade(&env.alice, signer, &v4).await, "Code doesn't match the proposed hash");
    // Allowed while paused (a fix must be deployable).
    env.watchdog.call(signer, "pause").transact().await?.into_result()?;

    // Anyone sends the exact wasm.
    let outcome = execute_upgrade(&env.alice, signer, &next).await?;
    report_gas(&format!("execute_upgrade v4 → v4 ({} KB wasm, deploy + migrate)", next.len() / 1024), &outcome, Gas::from_tgas(300));
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "upgrade_executed")[0]["data"][0], json!({"code_hash": code_hash(&next)}));
    assert_eq!(events_named(&events, "state_migrated")[0]["data"][0], json!({"from_version": 4, "to_version": 4}));
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&next));
    let governance = env.get_governance().await?;
    assert_eq!((governance["pending_upgrade"].clone(), governance["state_version"].clone()), (Value::Null, json!(4)));
    assert_eq!(env.get_config().await?["paused"], json!(true));

    // State and sessions survive; the owner unpauses at once and derivation works again.
    env.admin.call(signer, "unpause").transact().await?.into_result()?;
    let outcome = env.relayer_fc.call(signer, "derive_key").args_json(session.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?;
    outcome.into_result()?;
    assert_eq!(env.mpc_calls().await?.len(), 1);
    Ok(())
}

#[tokio::test]
async fn a_failing_migrate_rolls_the_upgrade_back() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let (v4, mock) = wasms()?;
    let before = env.get_config().await?;

    // mock-mpc's migrate always panics: deploy and migrate are one receipt, so the deploy is rolled back too.
    let due = propose_upgrade(&env.admin, signer, &mock).await?;
    env.advance_to(due).await?;
    let outcome = execute_upgrade(&env.bob, signer, &mock).await?;
    let events = hana_events(&outcome);
    let text = expect_failure(Ok(outcome), "mock-mpc: migrate always fails");
    assert!(!text.contains("Code doesn't match"), "{text}");
    assert_eq!(events_named(&events, "upgrade_executed").len(), 1, "the execute receipt itself committed");
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&v4), "the old code stays");
    assert_eq!(env.get_config().await?, before);
    // The pending upgrade was consumed: a fixed build must be proposed again (and wait again).
    assert_eq!(env.get_governance().await?["pending_upgrade"], Value::Null);

    // Code whose migrate refuses this state fails the same way: the v3 code (its migrate reads only the v3 layout, or a
    // v2 state, which this isn't), so v4 can't be downgraded by upgrade.
    let v3 = v3_wasm()?;
    let due = propose_upgrade(&env.admin, signer, &v3).await?;
    env.advance_to(due).await?;
    expect_failure(execute_upgrade(&env.bob, signer, &v3).await, "Unexpected state version");
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&v4));
    assert_eq!(env.get_config().await?, before);

    // The contract still works.
    let (session, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &session, &jwt).await?.into_result()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Mainnet-style creation

/// The signer account's first transaction on mainnet: DeployContract + new(owner = DAO, ..., updater_keys) +
/// DeleteKey(creation key), signed by the creation key. Afterwards the account has exactly one key: the updater key
/// the contract added with its fixed permission.
#[tokio::test]
async fn mainnet_style_creation_batch_leaves_one_function_call_key() -> Result<()> {
    let (v3, _) = wasms()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = subaccount(&root, "dao", 20).await?;
    let watchdog = subaccount(&root, "watchdog", 20).await?;
    let creation = SecretKey::from_random(KeyType::ED25519);
    let fresh = root.create_subaccount("signer").keys(creation.clone()).initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let updater_sk = SecretKey::from_random(KeyType::ED25519);
    fresh
        .batch(fresh.id())
        .deploy(&v3)
        .call(
            Function::new("new")
                .args_json(json!({
                    "owner": owner.id(), "mpc": "mpc.test.near", "ckd_domain_id": CKD_DOMAIN_ID, "change_delay_ms": CHANGE_DELAY_MS,
                    "issuer_key_delay_ms": ISSUER_KEY_DELAY_MS, "governance_delay_ms": GOVERNANCE_DELAY_MS,
                    "watchdogs": [watchdog.id()], "updater_keys": [updater_sk.public_key().to_string()],
                }))
                .gas(Gas::from_tgas(100)),
        )
        .delete_key(creation.public_key())
        .transact()
        .await?
        .into_result()?;

    let keys = worker.view_access_keys(fresh.id()).await?;
    assert_eq!(keys.len(), 1, "keys: {:?}", keys.iter().map(|k| k.public_key.to_string()).collect::<Vec<_>>());
    assert_eq!(keys[0].public_key, updater_sk.public_key());
    let AccessKeyPermission::FunctionCall(fc) = &keys[0].access_key.permission else { panic!("the only key is a full-access key") };
    assert_eq!(fc.receiver_id, fresh.id().as_str());
    assert_eq!(fc.method_names, UPDATER_METHODS.iter().map(|m| m.to_string()).collect::<Vec<_>>());
    assert_eq!(fc.allowance, Some(NearToken::from_near(1)));
    let governance: Value = fresh.view(fresh.id(), "get_governance").await?.json()?;
    assert_eq!(governance["updater_keys"], json!([updater_sk.public_key().to_string()]));
    assert_eq!(governance["watchdogs"], json!([{"account_id": watchdog.id(), "confirm_from_ms": 0}]));
    let config: Value = fresh.view(fresh.id(), "get_config").await?.json()?;
    assert_eq!(config["owner"], json!(owner.id()));

    // The creation key is gone.
    expect_failure(tx(fresh.call(fresh.id(), "get_config").transact().await), "");
    // The updater key reaches exactly its three methods, and the contract refuses it everything else.
    let updater = Account::from_secret_key(fresh.id().clone(), updater_sk, &worker);
    let issuer = TestIssuer::generate()?;
    let text = expect_failure(
        tx(updater.call(fresh.id(), "set_issuer_key").args_json(json!({"provider": PROVIDER, "kid": KID, "n": issuer.n, "e": issuer.e})).gas(Gas::from_tgas(30)).transact().await),
        "Unknown issuer",
    );
    assert!(!text.contains("MethodNameMismatch"), "{text}");
    for method in ["add_updater_key", "pause", "propose_upgrade", "remove_issuer_key", "confirm_issuer_key_change", "execute_upgrade", "set_owner"] {
        let text = expect_failure(tx(updater.call(fresh.id(), method).args_json(json!({})).gas(Gas::from_tgas(30)).transact().await), "");
        assert!(text.contains("MethodNameMismatch"), "{method}: {text}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Updater keys, rotation, pause

#[tokio::test]
async fn updater_keys_are_added_and_deleted_by_the_contract_only_with_the_fixed_permission() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    // Env::setup added one (checked against UPDATER_METHODS on chain); a second fits, a third doesn't.
    let second = add_updater_key(&env.worker, &env.admin, signer).await?;
    let third = SecretKey::from_random(KeyType::ED25519);
    expect_failure(
        tx(env.admin.call(signer, "add_updater_key").args_json(json!({"public_key": third.public_key().to_string()})).gas(GAS).transact().await),
        "Too many updater keys",
    );
    let governance = env.get_governance().await?;
    // The AddKey and its callback ran in the same transaction: both keys are confirmed, none pending.
    assert_eq!(governance["updater_keys"].as_array().unwrap().len(), 2);
    assert_eq!(governance["pending_updater_keys"], json!([]));
    assert_eq!(governance["updater_methods"], json!(UPDATER_METHODS));
    // Only the owner adds.
    for caller in [&env.watchdog, &env.alice] {
        expect_failure(tx(caller.call(signer, "add_updater_key").args_json(json!({"public_key": third.public_key().to_string()})).gas(GAS).transact().await), "Only the owner can do this");
    }
    // Adding a key that is already on the account (the signer's own full-access key) fails on chain and is
    // untracked again by the callback.
    env.admin.call(signer, "delete_updater_key").args_json(json!({"public_key": second.secret_key().public_key().to_string()})).gas(GAS).transact().await?.into_result()?;
    let full_access = env.signer.as_account().secret_key().public_key();
    let outcome = env.admin.call(signer, "add_updater_key").args_json(json!({"public_key": full_access.to_string()})).gas(GAS).transact().await?;
    let events = hana_events(&outcome);
    let added: bool = outcome.into_result()?.json()?;
    assert!(!added);
    assert_eq!(events_named(&events, "updater_key_add_failed").len(), 1);
    let governance = env.get_governance().await?;
    assert_eq!(governance["updater_keys"].as_array().unwrap().len(), 1);
    assert_eq!(governance["pending_updater_keys"], json!([]), "the full-access key was never an updater key");
    // So a watchdog can't delete the signer's full-access key through delete_updater_key.
    expect_failure(tx(env.watchdog.call(signer, "delete_updater_key").args_json(json!({"public_key": full_access.to_string()})).gas(GAS).transact().await), "Not an updater key");
    let key = env.worker.view_access_key(signer, &full_access).await?;
    assert!(matches!(key.permission, AccessKeyPermission::FullAccess), "the existing key is untouched");
    // The deleted key can't sign any more.
    expect_failure(
        tx(second.call(signer, "set_issuer_key").args_json(json!({"provider": PROVIDER, "kid": "x", "n": env.issuer.n, "e": env.issuer.e})).gas(Gas::from_tgas(30)).transact().await),
        "",
    );
    // A watchdog deletes only tracked keys; others can't delete at all.
    let untracked = SecretKey::from_random(KeyType::ED25519).public_key().to_string();
    expect_failure(tx(env.watchdog.call(signer, "delete_updater_key").args_json(json!({"public_key": untracked})).gas(GAS).transact().await), "Not an updater key");
    expect_failure(
        tx(env.alice.call(signer, "delete_updater_key").args_json(json!({"public_key": env.keys_updater.secret_key().public_key().to_string()})).gas(GAS).transact().await),
        "Only the owner or a watchdog can do this",
    );
    // The callback is private.
    expect_failure(tx(env.alice.call(signer, "on_updater_key_added").args_json(json!({"public_key": untracked})).transact().await), "is private");
    Ok(())
}

#[tokio::test]
async fn rotation_end_to_end_and_a_forged_proposal() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    const UPDATER_GAS: Gas = Gas::from_tgas(30);

    // Google publishes its next key; the updater proposes it.
    let next = TestIssuer::generate_with_kid("google-next")?;
    let id: u64 = env
        .keys_updater
        .call(signer, "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": next.kid, "n": next.n, "e": next.e}))
        .gas(UPDATER_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let changes = env.get_key_changes().await?;
    assert_eq!((changes[0]["op"].clone(), changes[0]["n"].clone(), changes[0]["by"].clone()), (json!("Add"), json!(next.n), json!(signer)));
    // Until it is active a token signed with it fails on chain.
    let now = env.now_ms().await?;
    let s = TestSession::new(&env.scope_a, now + 600_000, 0, 5);
    let jwt = next.jwt(APP_A, USER_SUB, Some(&s.nonce(signer)), now);
    expect_failure(env.create_session(&env.relayer_fc, &s, &jwt).await, "Unknown signing key");
    // The watchdog checked it against Google's JWKS and confirms it: a session opens with the new kid.
    let outcome = env.watchdog.call(signer, "confirm_issuer_key_change").args_json(json!({"id": id})).transact().await?;
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "issuer_key_set")[0]["data"][0], json!({"provider": PROVIDER, "kid": "google-next", "id": id, "how": "confirmed", "by": env.watchdog.id()}));
    env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
    // Google drops the old key; the updater proposes its removal and the watchdog confirms.
    let id: u64 = env.keys_updater.call(signer, "propose_issuer_key_removal").args_json(json!({"provider": PROVIDER, "kid": KID})).gas(UPDATER_GAS).transact().await?.into_result()?.json()?;
    env.watchdog.call(signer, "confirm_issuer_key_change").args_json(json!({"id": id})).transact().await?.into_result()?;
    assert_eq!(env.kids().await?, vec!["google-next".to_string()]);
    // The last key can't be proposed for removal.
    expect_failure(
        tx(env.keys_updater.call(signer, "propose_issuer_key_removal").args_json(json!({"provider": PROVIDER, "kid": "google-next"})).gas(UPDATER_GAS).transact().await),
        "Cannot remove the last key of an issuer",
    );

    // A stolen updater key proposes a forged key. The watchdog cancels it and deletes the updater key in one
    // transaction; the thief's key stops working.
    let forged = TestIssuer::generate_with_kid("forged")?;
    let id: u64 = env
        .keys_updater
        .call(signer, "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": forged.kid, "n": forged.n, "e": forged.e}))
        .gas(UPDATER_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let updater_pk = env.keys_updater.secret_key().public_key();
    let outcome = env
        .watchdog
        .batch(signer)
        .call(Function::new("cancel_issuer_key_change").args_json(json!({"id": id})))
        .call(Function::new("delete_updater_key").args_json(json!({"public_key": updater_pk.to_string()})))
        .transact()
        .await?;
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "issuer_key_change_cancelled")[0]["data"][0]["by"], json!(env.watchdog.id()));
    assert_eq!(events_named(&events, "updater_key_deleted")[0]["data"][0], json!({"public_key": updater_pk.to_string(), "by": env.watchdog.id()}));
    assert_eq!(env.get_key_changes().await?, json!([]));
    assert_eq!(env.get_governance().await?["updater_keys"], json!([]));
    assert!(env.worker.view_access_key(signer, &updater_pk).await.is_err(), "the updater key is gone from the account");
    expect_failure(
        tx(env.keys_updater.call(signer, "set_issuer_key").args_json(json!({"provider": PROVIDER, "kid": "again", "n": forged.n, "e": forged.e})).gas(UPDATER_GAS).transact().await),
        "",
    );
    assert_eq!(env.kids().await?, vec!["google-next".to_string()]);
    Ok(())
}

#[tokio::test]
async fn pause_freezes_logins_until_the_owner_unpauses() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let (mut early, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &early, &jwt).await?.into_result()?;
    expect_failure(tx(env.alice.call(signer, "pause").transact().await), "Only the owner or a watchdog can do this");
    let outcome = env.watchdog.call(signer, "pause").transact().await?;
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "paused")[0]["data"][0], json!({"by": env.watchdog.id()}));
    // Logins, derivation and the executors stop; revocation doesn't.
    let (mut s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(env.login(&env.relayer_fc, &s.login_args(&jwt, PK1, PK2)).await, "Paused");
    expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(early.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await), "Paused");
    early.counter -= 1;
    expect_failure(tx(env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": 0})).gas(api_gas("execute_change")).transact().await), "Paused");
    // Only the owner unpauses, at once.
    expect_failure(tx(env.watchdog.call(signer, "unpause").transact().await), "Only the owner can do this");
    env.admin.call(signer, "unpause").transact().await?.into_result()?;
    let (mut s2, jwt2) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.login(&env.relayer_fc, &s2.login_args(&jwt2, PK1, PK2)).await?.into_result()?;
    env.relayer_fc.call(signer, "derive_key").args_json(early.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?.into_result()?;
    env.relayer_fc.call(signer, "revoke_session").args_json(early.revoke_args()).gas(api_gas("revoke_session")).transact().await?.into_result()?;
    Ok(())
}

/// The forged_active_key runbook's last step before the unpause: sessions opened before the pause (with the forged key,
/// or not) stop deriving once the owner raises the session floor past the pause; logins after the unpause work.
#[tokio::test]
async fn the_session_floor_retires_sessions_opened_before_it() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let (mut early, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &early, &jwt).await?.into_result()?;
    env.watchdog.call(signer, "pause").transact().await?.into_result()?;
    let floor = env.now_ms().await?;
    expect_failure(tx(env.watchdog.call(signer, "set_sessions_valid_from_ms").args_json(json!({"sessions_valid_from_ms": floor})).transact().await), "Only the owner can do this");
    env.admin.call(signer, "set_sessions_valid_from_ms").args_json(json!({"sessions_valid_from_ms": floor})).transact().await?.into_result()?;
    env.admin.call(signer, "unpause").transact().await?.into_result()?;
    assert_eq!(env.get_config().await?["sessions_valid_from_ms"], json!(floor));
    expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(early.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await), "No such session");
    assert!(env.get_session(&early).await?.is_none());
    let (mut s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.login(&env.relayer_fc, &s.login_args(&jwt, PK1, PK2)).await?.into_result()?;
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Owner = Sputnik DAO v2, 2 of 3 (D81)

struct Dao<'a> {
    dao: &'a Contract,
    bond: NearToken,
}

impl Dao<'_> {
    async fn try_propose(&self, member: &Account, description: &str, kind: Value) -> Result<ExecutionFinalResult> {
        Ok(member.call(self.dao.id(), "add_proposal").args_json(json!({"proposal": {"description": description, "kind": kind}})).deposit(self.bond).gas(GAS).transact().await?)
    }

    async fn propose(&self, member: &Account, description: &str, kind: Value) -> Result<u64> {
        Ok(self.try_propose(member, description, kind).await?.into_result()?.json()?)
    }

    async fn vote(&self, member: &Account, id: u64) -> Result<ExecutionFinalResult> {
        Ok(member.call(self.dao.id(), "act_proposal").args_json(json!({"id": id, "action": "VoteApprove", "memo": null})).gas(GAS).transact().await?)
    }

    async fn status(&self, id: u64) -> Result<String> {
        let p: Value = self.dao.view("get_proposal").args_json(json!({"id": id})).await?.json()?;
        Ok(p["status"].as_str().context("status")?.to_string())
    }

    async fn policy(&self) -> Result<Value> {
        Ok(self.dao.view("get_policy").await?.json()?)
    }
}

/// A Sputnik `FunctionCall` proposal kind: one call to `receiver` with JSON `args`, no deposit, 100 Tgas.
fn function_call(receiver: &AccountId, method: &str, args: Value) -> Value {
    json!({"FunctionCall": {"receiver_id": receiver, "actions": [{"method_name": method, "args": B64.encode(args.to_string()), "deposit": "0", "gas": "100000000000000"}]}})
}

fn council_of(policy: &Value) -> Vec<String> {
    let mut members: Vec<String> = policy["roles"][0]["kind"]["Group"].as_array().unwrap().iter().map(|m| m.as_str().unwrap().to_string()).collect();
    members.sort();
    members
}

#[tokio::test]
async fn sputnik_dao_owner_2_of_3() -> Result<()> {
    let wasm = sputnik_wasm()?;
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let root = env.worker.root_account()?;
    let a = subaccount(&root, "council-a", 20).await?;
    let b = subaccount(&root, "council-b", 20).await?;
    let c = subaccount(&root, "council-c", 20).await?;
    let d = subaccount(&root, "council-d", 20).await?;
    let outsider = subaccount(&root, "outsider", 20).await?;

    // The DAO, created with the policy the scripts use (contracts/sputnik/policy.json).
    let policy = sputnik_policy(&[a.id(), b.id(), c.id()])?;
    let dao = subaccount(&root, "council", 30).await?.deploy(&wasm).await?.into_result()?;
    assert_eq!(account_code_hash(&env.worker, dao.id()).await?, code_hash(&wasm));
    dao.call("new").args_json(json!({"config": {"name": "hana-council", "purpose": "hana-signer owner", "metadata": ""}, "policy": policy})).gas(GAS).transact().await?.into_result()?;
    let bond = NearToken::from_yoctonear(policy["proposal_bond"].as_str().unwrap().parse()?);
    let dao = Dao { dao: &dao, bond };
    let stored = dao.policy().await?;
    assert_eq!(council_of(&stored), vec![a.id().to_string(), b.id().to_string(), c.id().to_string()]);
    assert_eq!(stored["roles"].as_array().unwrap().len(), 1, "no Everyone role");
    assert_eq!(stored["default_vote_policy"], json!({"weight_kind": "RoleWeight", "quorum": "0", "threshold": [1, 2]}));

    // A non-member can neither propose nor vote.
    expect_failure(dao.try_propose(&outsider, "spam", json!("Vote")).await, "ERR_PERMISSION_DENIED");

    // Owner transfer: the old owner proposes the DAO; after the governance delay the DAO accepts, by 2 of 3 votes.
    env.admin.call(signer, "propose_owner").args_json(json!({"owner": dao.dao.id()})).transact().await?.into_result()?;
    let accept = dao.propose(&a, "accept_owner", function_call(signer, "accept_owner", json!({}))).await?;
    expect_failure(dao.vote(&outsider, accept).await, "ERR_PERMISSION_DENIED");
    let acceptable = env.get_governance().await?["pending_owner"]["acceptable_at_ms"].as_u64().unwrap();
    env.advance_to(acceptable).await?;
    dao.vote(&a, accept).await?.into_result()?;
    assert_eq!(dao.status(accept).await?, "InProgress", "one vote of three executes nothing");
    assert_eq!(env.get_config().await?["owner"], json!(env.admin.id()));
    dao.vote(&b, accept).await?.into_result()?;
    assert_eq!(dao.status(accept).await?, "Approved");
    assert_eq!(env.get_config().await?["owner"], json!(dao.dao.id()));
    // The old owner is out.
    expect_failure(tx(env.admin.call(signer, "set_sponsors").args_json(json!({"sponsors": []})).transact().await), "Only the owner can do this");

    // An upgrade through the DAO: propose_upgrade (2 of 3), then anyone executes after the governance delay.
    let (v3, _) = wasms()?;
    let next = with_custom_section(&v3, "hana-test-upgrade", b"dao");
    let upgrade = dao.propose(&b, "propose_upgrade", function_call(signer, "propose_upgrade", json!({"code_hash": code_hash(&next)}))).await?;
    dao.vote(&c, upgrade).await?.into_result()?;
    assert_eq!(env.get_governance().await?["pending_upgrade"], Value::Null);
    dao.vote(&a, upgrade).await?.into_result()?;
    let due = env.get_governance().await?["pending_upgrade"]["executable_at_ms"].as_u64().context("pending upgrade")?;
    expect_failure(execute_upgrade(&outsider, signer, &next).await, "Upgrade is still delayed");
    env.advance_to(due).await?;
    execute_upgrade(&outsider, signer, &next).await?.into_result()?;
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&next));

    // A FunctionCall that fails in hana-signer leaves the proposal Failed (no owner powers leak).
    let again = dao.propose(&a, "accept_owner again", function_call(signer, "accept_owner", json!({}))).await?;
    dao.vote(&a, again).await?.into_result()?;
    let _ = dao.vote(&c, again).await?;
    assert_eq!(dao.status(again).await?, "Failed");

    // ChangePolicy: 1 vote no, 2 votes yes.
    let mut changed = stored.clone();
    changed["proposal_period"] = json!("259200000000000");
    let change = dao.propose(&c, "shorter proposal period", json!({"ChangePolicy": {"policy": changed}})).await?;
    dao.vote(&c, change).await?.into_result()?;
    assert_eq!(dao.policy().await?["proposal_period"], stored["proposal_period"]);
    dao.vote(&b, change).await?.into_result()?;
    assert_eq!(dao.policy().await?["proposal_period"], json!("259200000000000"));

    // AddMemberToRole: 1 vote no, 2 votes yes.
    let add = dao.propose(&a, "add d", json!({"AddMemberToRole": {"member_id": d.id(), "role": "council"}})).await?;
    dao.vote(&a, add).await?.into_result()?;
    assert_eq!(council_of(&dao.policy().await?).len(), 3);
    dao.vote(&c, add).await?.into_result()?;
    assert_eq!(council_of(&dao.policy().await?).len(), 4);
    // RemoveMemberFromRole: with 4 members the [1, 2] ratio needs ⌊4/2⌋ + 1 = 3 votes.
    let remove = dao.propose(&d, "remove d", json!({"RemoveMemberFromRole": {"member_id": d.id(), "role": "council"}})).await?;
    dao.vote(&a, remove).await?.into_result()?;
    dao.vote(&b, remove).await?.into_result()?;
    assert_eq!(council_of(&dao.policy().await?).len(), 4, "2 of 4 is not enough");
    dao.vote(&c, remove).await?.into_result()?;
    assert_eq!(council_of(&dao.policy().await?), vec![a.id().to_string(), b.id().to_string(), c.id().to_string()]);

    // Back at 3 members, a 2-of-3 FunctionCall still governs hana-signer (here: unpause after a watchdog pause).
    env.watchdog.call(signer, "pause").transact().await?.into_result()?;
    let unpause = dao.propose(&b, "unpause", function_call(signer, "unpause", json!({}))).await?;
    dao.vote(&b, unpause).await?.into_result()?;
    assert_eq!(env.get_config().await?["paused"], json!(true));
    dao.vote(&c, unpause).await?.into_result()?;
    assert_eq!(env.get_config().await?["paused"], json!(false));
    Ok(())
}
