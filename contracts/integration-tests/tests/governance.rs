//! Sandbox tests of the governance batch (docs/governance-spec.md "Tests", "Sandbox e2e"):
//!
//! - the in-place v1 → v2 upgrade (`DeployContract` + `migrate_v1` in one transaction) on real v1 state built by the
//!   v1 wasm (`V1_COMMIT`), keeping every view and every derivation path;
//! - login gas of v2 against v1;
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
// v1 → v2 in place

/// A sandbox with a v1 hana-signer (built from V1_COMMIT) holding real state: the Google key, a console audience, a
/// sponsor, scopes, a shared client (pending), a pending AddClient, a removed (quarantined) client and a session.
struct V1World {
    worker: Worker<Sandbox>,
    signer: Contract,
    admin: Account,
    alice: Account,
    relayer: Account,
    mpc: Contract,
    issuer: TestIssuer,
    scope_a: String,
    session: TestSession,
}

/// v1 `new`, set_issuer, set_issuer_key (immediate in v1), console audience, sponsor; scopes s1 = [A, C] (alice),
/// s2 = [B] (bob).
async fn deploy_v1(root: &Account, name: &str, admin: &Account, mpc: &AccountId, issuer: &TestIssuer, relayer: &AccountId) -> Result<Contract> {
    let signer = subaccount(root, name, 50).await?.deploy(&v1_wasm()?).await?.into_result()?;
    signer.call("new").args_json(json!({"owner": admin.id(), "mpc": mpc, "ckd_domain_id": CKD_DOMAIN_ID, "change_delay_ms": CHANGE_DELAY_MS})).transact().await?.into_result()?;
    for (method, args) in [
        ("set_issuer", json!({"provider": PROVIDER, "iss_values": [ISS, "accounts.google.com"]})),
        ("set_issuer_key", json!({"provider": PROVIDER, "kid": issuer.kid, "n": issuer.n, "e": issuer.e})),
        ("set_console_audiences", json!({"audiences": [[PROVIDER, CONSOLE]]})),
        ("set_sponsors", json!({"sponsors": [relayer]})),
    ] {
        admin.call(signer.id(), method).args_json(args).transact().await?.into_result()?;
    }
    Ok(signer)
}

async fn v1_world() -> Result<V1World> {
    let (_, mpc_wasm) = wasms()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = subaccount(&root, "admin", 20).await?;
    let alice = subaccount(&root, "alice", 20).await?;
    let bob = subaccount(&root, "bob", 20).await?;
    let relayer = subaccount(&root, "relayer", 20).await?;
    let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    let issuer = TestIssuer::generate()?;
    let signer = deploy_v1(&root, "signer", &admin, mpc.id(), &issuer, relayer.id()).await?;
    let register = |owners: Value, clients: Value| {
        admin.call(signer.id(), "admin_register_scope").args_json(json!({"owners": owners, "clients": clients, "scope_id": null, "allow_shared": false})).gas(GAS).transact()
    };
    let scope_a: String = register(json!([near_owner(alice.id())]), json!([[PROVIDER, APP_A], [PROVIDER, APP_C]])).await?.into_result()?.json()?;
    let _scope_b: String = register(json!([near_owner(bob.id())]), json!([[PROVIDER, APP_B]])).await?.into_result()?.json()?;
    // A shared client (pending for CHANGE_DELAY_MS) and a shared-only scope.
    admin.call(signer.id(), "set_shared_clients").args_json(json!({"clients": [[PROVIDER, SHARED]]})).gas(GAS).transact().await?.into_result()?;
    admin
        .call(signer.id(), "admin_register_scope")
        .args_json(json!({"owners": [near_owner(bob.id())], "clients": [], "scope_id": null, "allow_shared": true}))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
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
    alice
        .call(signer.id(), "remove_client")
        .args_json(json!({"scope_id": scope_a, "auth": "Near", "provider": PROVIDER, "aud": APP_C}))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?;
    // A session (5 uses, 30 min), used once.
    let mut session = TestSession::new(&scope_a, now + 1_800_000, 0, 5);
    let jwt = issuer.jwt(APP_A, USER_SUB, Some(&session.nonce(signer.id())), now);
    relayer.call(signer.id(), "create_session").args_json(session.create_args(&jwt)).gas(GAS).transact().await?.into_result()?;
    relayer.call(signer.id(), "derive_key").args_json(session.derive_args(PK1, PK2)).gas(GAS).transact().await?.into_result()?;
    Ok(V1World { worker, signer, admin, alice, relayer, mpc, issuer, scope_a, session })
}

/// Every view a v1 client reads, in one JSON object.
async fn v1_views(w: &V1World) -> Result<Value> {
    let s = &w.signer;
    let view = |method: &'static str, args: Value| async move { Ok::<Value, anyhow::Error>(s.view(method).args_json(args).await?.json()?) };
    Ok(json!({
        "config": view("get_config", json!({})).await?,
        "issuer": view("get_issuer", json!({"provider": PROVIDER})).await?,
        "s1": view("get_scope", json!({"scope_id": "s1"})).await?,
        "s2": view("get_scope", json!({"scope_id": "s2"})).await?,
        "s3": view("get_scope", json!({"scope_id": "s3"})).await?,
        "clients": [
            view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_A})).await?,
            view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_B})).await?,
            view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_C})).await?,
            view("scope_for_client", json!({"provider": PROVIDER, "aud": APP_D})).await?,
        ],
        "session": view("get_session", json!({"session_public_key": w.session.public_key()})).await?,
        "in_use": view("session_key_in_use", json!({"session_public_key": w.session.public_key()})).await?,
    }))
}

#[tokio::test]
async fn migrate_v1_in_place_keeps_every_view_and_path() -> Result<()> {
    let mut w = v1_world().await?;
    let signer = w.signer.id().clone();
    let before = v1_views(&w).await?;
    assert_eq!(before["s1"]["pending"].as_array().unwrap().len(), 1);
    assert_eq!(before["session"]["used"], json!(1));
    let path = before["session"]["path"].as_str().unwrap().to_string();
    let v1_hash = account_code_hash(&w.worker, &signer).await?;
    assert_eq!(v1_hash, code_hash(&v1_wasm()?));

    // v1 has no migrate_v1 (nobody can run it before the deploy).
    let (v2, _) = wasms()?;
    let text = expect_failure(
        tx(w.alice.call(&signer, "migrate_v1").args_json(json!({"issuer_key_delay_ms": ISSUER_KEY_DELAY_MS, "governance_delay_ms": GOVERNANCE_DELAY_MS})).transact().await),
        "",
    );
    assert!(text.contains("MethodNotFound") || text.contains("not found"), "v1 has no migrate_v1: {text}");

    // deploy-contract --upgrade: DeployContract + migrate_v1 in one transaction, signed by the signer's full-access key.
    let outcome = w
        .signer
        .as_account()
        .batch(&signer)
        .deploy(&v2)
        .call(Function::new("migrate_v1").args_json(json!({"issuer_key_delay_ms": ISSUER_KEY_DELAY_MS, "governance_delay_ms": GOVERNANCE_DELAY_MS})).gas(Gas::from_tgas(100)))
        .transact()
        .await?;
    println!("deploy + migrate_v1 gas burnt: {} Tgas", outcome.total_gas_burnt.as_tgas());
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "state_migrated")[0]["data"][0], json!({"from_version": 1, "to_version": 2}));
    assert_eq!(account_code_hash(&w.worker, &signer).await?, code_hash(&v2));

    // Every v1 view is unchanged; get_config only gained fields.
    let after = v1_views(&w).await?;
    for (key, value) in before.as_object().unwrap() {
        if key == "config" {
            for (field, v) in value.as_object().unwrap() {
                assert_eq!(&after["config"][field], v, "config.{field}");
            }
        } else {
            assert_eq!(&after[key], value, "{key}");
        }
    }
    let config = &after["config"];
    assert_eq!((config["issuer_key_delay_ms"].as_u64(), config["governance_delay_ms"].as_u64()), (Some(ISSUER_KEY_DELAY_MS), Some(GOVERNANCE_DELAY_MS)));
    assert_eq!((config["paused"].clone(), config["pending_console_audiences"].clone()), (json!(false), json!([])));
    let governance: Value = w.signer.view("get_governance").await?.json()?;
    assert_eq!(governance["state_version"], json!(2));
    assert_eq!((governance["watchdogs"].clone(), governance["updater_keys"].clone(), governance["pending_upgrade"].clone()), (json!([]), json!([]), Value::Null));

    // The session opened before the upgrade derives again, with the same path.
    let outcome = w.relayer.call(&signer, "derive_key").args_json(w.session.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?;
    let response: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(response, w.expected_ckd(&path).await?);
    let calls: Vec<RecordedCall> = w.mpc.view("get_calls").args_json(json!({"from_index": null, "limit": null})).await?.json()?;
    assert_eq!(calls.iter().map(|c| c.derivation_path.as_str()).collect::<Vec<_>>(), vec![path.as_str(), path.as_str()]);
    // A new login after the upgrade gets that path too.
    let now = now_ms(&w.worker).await?;
    let mut fresh = TestSession::new(&w.scope_a, now + 600_000, 0, 1);
    let jwt = w.issuer.jwt(APP_A, USER_SUB, Some(&fresh.nonce(&signer)), now);
    let args = fresh.login_args(&jwt, PK1, PK2);
    w.relayer.call(&signer, "create_session_and_derive").args_json(args).gas(api_gas("create_session_and_derive")).transact().await?.into_result()?;
    let session: Value = w.signer.view("get_session").args_json(json!({"session_public_key": fresh.public_key()})).await?.json()?;
    assert_eq!(session["path"], json!(path));

    // The pending AddClient executes on schedule.
    advance_to(&w.worker, now + CHANGE_DELAY_MS).await?;
    w.alice.call(&signer, "execute_change").args_json(json!({"scope_id": w.scope_a, "change_id": 0})).gas(GAS).transact().await?.into_result()?;
    let d: Option<String> = w.signer.view("scope_for_client").args_json(json!({"provider": PROVIDER, "aud": APP_D})).await?.json()?;
    assert_eq!(d.as_deref(), Some(w.scope_a.as_str()));

    // set_owner is gone; a re-run of migrate_v1 (by the contract itself) can't touch v2 state; migrate is private.
    expect_failure(tx(w.admin.call(&signer, "set_owner").args_json(json!({"owner": w.alice.id()})).transact().await), "MethodNotFound");
    let rerun = w
        .signer
        .as_account()
        .call(&signer, "migrate_v1")
        .args_json(json!({"issuer_key_delay_ms": 0, "governance_delay_ms": 0}))
        .transact()
        .await;
    expect_failure(tx(rerun), "Unexpected state version");
    for method in ["migrate_v1", "migrate"] {
        let args = if method == "migrate" { json!({}) } else { json!({"issuer_key_delay_ms": 0, "governance_delay_ms": 0}) };
        expect_failure(tx(w.alice.call(&signer, method).args_json(args).transact().await), "is private");
    }
    assert_eq!(w.signer.view("get_governance").await?.json::<Value>()?["state_version"], json!(2));
    Ok(())
}

impl V1World {
    async fn expected_ckd(&self, path: &str) -> Result<CkdResponse> {
        let request = json!({"derivation_path": path, "app_public_key": {"AppPublicKeyPV": {"pk1": PK1, "pk2": PK2}}, "domain_id": CKD_DOMAIN_ID});
        Ok(self.mpc.view("expected_response").args_json(json!({"request": request})).await?.json()?)
    }
}

/// Login gas on v2 stays within 2% of v1 (batch B): the same create_session and create_session_and_derive on two
/// deployments that differ only in code.
#[tokio::test]
async fn login_gas_is_unchanged_from_v1() -> Result<()> {
    let (v2, mpc_wasm) = wasms()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let admin = subaccount(&root, "admin", 20).await?;
    let relayer = subaccount(&root, "relayer", 20).await?;
    let watchdog = subaccount(&root, "watchdog", 20).await?;
    let mpc = subaccount(&root, "mpc", 20).await?.deploy(&mpc_wasm).await?.into_result()?;
    mpc.call("new").transact().await?.into_result()?;
    let issuer = TestIssuer::generate()?;
    // Same-length account names, so nonces and storage keys have the same size.
    let old = deploy_v1(&root, "signer1", &admin, mpc.id(), &issuer, relayer.id()).await?;
    let new = deploy_v1(&root, "signer2", &admin, mpc.id(), &issuer, relayer.id()).await?;
    new.as_account()
        .batch(new.id())
        .deploy(&v2)
        .call(Function::new("migrate_v1").args_json(json!({"issuer_key_delay_ms": ISSUER_KEY_DELAY_MS, "governance_delay_ms": GOVERNANCE_DELAY_MS})).gas(Gas::from_tgas(100)))
        .transact()
        .await?
        .into_result()?;
    // A watchdog, as in production (the v2 state is a little larger with one).
    admin.call(new.id(), "add_watchdog").args_json(json!({"account_id": watchdog.id()})).transact().await?.into_result()?;

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
        for _ in 0..2 {
            let s = TestSession::new(&scope, now + 600_000, 0, 1);
            let jwt = issuer.jwt(APP_A, USER_SUB, Some(&s.nonce(signer.id())), now);
            let outcome = relayer.call(signer.id(), "create_session").args_json(s.create_args(&jwt)).gas(api_gas("create_session")).transact().await?;
            gas.push(outcome.total_gas_burnt.as_gas());
            outcome.into_result()?;
            let mut s = TestSession::new(&scope, now + 600_000, 0, 1);
            let jwt = issuer.jwt(APP_A, USER_SUB, Some(&s.nonce(signer.id())), now);
            let outcome = relayer.call(signer.id(), "create_session_and_derive").args_json(s.login_args(&jwt, PK1, PK2)).gas(api_gas("create_session_and_derive")).transact().await?;
            gas.push(outcome.total_gas_burnt.as_gas());
            outcome.into_result()?;
        }
        burnt.push(gas);
    }
    for (i, name) in ["create_session", "create_session_and_derive", "create_session (2nd)", "create_session_and_derive (2nd)"].iter().enumerate() {
        let (v1, v2) = (burnt[0][i] as f64, burnt[1][i] as f64);
        println!("{name}: v1 {:.3} Tgas, v2 {:.3} Tgas ({:+.2}%)", v1 / 1e12, v2 / 1e12, (v2 / v1 - 1.0) * 100.0);
        assert!(v2 <= v1 * 1.02, "{name}: v2 burnt {v2} gas, more than 2% over v1's {v1}");
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Timelocked upgrades

#[tokio::test]
async fn execute_upgrade_deploys_and_migrates_in_one_receipt() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let (v2, mock) = wasms()?;
    let next = with_custom_section(&v2, "hana-test-upgrade", b"next");
    assert_ne!(code_hash(&next), code_hash(&v2));
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
    expect_failure(execute_upgrade(&env.alice, signer, &v2).await, "Code doesn't match the proposed hash");
    // Allowed while paused (a fix must be deployable).
    env.watchdog.call(signer, "pause").transact().await?.into_result()?;

    // Anyone sends the exact wasm.
    let outcome = execute_upgrade(&env.alice, signer, &next).await?;
    println!("execute_upgrade ({} KB wasm) gas burnt: {} Tgas", next.len() / 1024, outcome.total_gas_burnt.as_tgas());
    let events = hana_events(&outcome);
    outcome.into_result()?;
    assert_eq!(events_named(&events, "upgrade_executed")[0]["data"][0], json!({"code_hash": code_hash(&next)}));
    assert_eq!(events_named(&events, "state_migrated")[0]["data"][0], json!({"from_version": 2, "to_version": 2}));
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&next));
    let governance = env.get_governance().await?;
    assert_eq!((governance["pending_upgrade"].clone(), governance["state_version"].clone()), (Value::Null, json!(2)));
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
    let (v2, mock) = wasms()?;
    let before = env.get_config().await?;

    // mock-mpc's migrate always panics: deploy and migrate are one receipt, so the deploy is rolled back too.
    let due = propose_upgrade(&env.admin, signer, &mock).await?;
    env.advance_to(due).await?;
    let outcome = execute_upgrade(&env.bob, signer, &mock).await?;
    let events = hana_events(&outcome);
    let text = expect_failure(Ok(outcome), "mock-mpc: migrate always fails");
    assert!(!text.contains("Code doesn't match"), "{text}");
    assert_eq!(events_named(&events, "upgrade_executed").len(), 1, "the execute receipt itself committed");
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&v2), "the old code stays");
    assert_eq!(env.get_config().await?, before);
    // The pending upgrade was consumed: a fixed build must be proposed again (and wait again).
    assert_eq!(env.get_governance().await?["pending_upgrade"], Value::Null);

    // Code without a migrate method (v1) fails the same way.
    let v1 = v1_wasm()?;
    let due = propose_upgrade(&env.admin, signer, &v1).await?;
    env.advance_to(due).await?;
    expect_failure(execute_upgrade(&env.bob, signer, &v1).await, "MethodNotFound");
    assert_eq!(account_code_hash(&env.worker, signer).await?, code_hash(&v2));

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
    let (v2, _) = wasms()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let owner = subaccount(&root, "dao", 20).await?;
    let watchdog = subaccount(&root, "watchdog", 20).await?;
    let creation = SecretKey::from_random(KeyType::ED25519);
    let fresh = root.create_subaccount("signer").keys(creation.clone()).initial_balance(NearToken::from_near(50)).transact().await?.into_result()?;
    let updater_sk = SecretKey::from_random(KeyType::ED25519);
    fresh
        .batch(fresh.id())
        .deploy(&v2)
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
    let (v2, _) = wasms()?;
    let next = with_custom_section(&v2, "hana-test-upgrade", b"dao");
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
