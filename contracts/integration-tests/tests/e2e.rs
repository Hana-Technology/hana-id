//! End-to-end tests of hana-signer + mock-mpc in a local NEAR sandbox.
//!
//!   cd contracts/integration-tests && cargo test -- --nocapture
//!
//! Each test starts its own sandbox (downloaded once by near-workspaces) and builds the two contracts once per run
//! (set HANA_SIGNER_WASM / MOCK_MPC_WASM to use prebuilt wasm instead).

mod common;

use anyhow::Result;
use common::*;
use near_workspaces::types::NearToken;
use serde_json::{json, Value};

/// Two apps with different client ids get different paths (so different keys) for the same Google user; the CKD
/// request reaches the MPC with that path, domain 2 and 1 yoctoNEAR, and its answer comes back unchanged.
#[tokio::test]
async fn derive_key_paths_are_per_scope_and_key_index() -> Result<()> {
    let env = Env::setup().await?;
    assert_ne!(env.scope_a, env.scope_b);
    assert_eq!(env.scope_for_client(APP_A).await?.as_deref(), Some(env.scope_a.as_str()));
    assert_eq!(env.scope_for_client(APP_B).await?.as_deref(), Some(env.scope_b.as_str()));
    assert_eq!(env.scope_for_client(APP_X).await?, None);

    // App A, key index 0, through the relayer's function-call key.
    let (mut sa, jwt_a) = env.new_session(APP_A, USER_SUB, 0, 600_000).await?;
    let outcome = env.create_session(&env.relayer_fc, &sa, &jwt_a).await?;
    println!("create_session gas burnt: {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= CREATE_SESSION_GAS_BUDGET, "create_session burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
    let created: SessionView = outcome.into_result()?.json()?;
    let path_a = format!("{}#google#{}#0", env.scope_a, USER_SUB);
    assert_eq!(created.path, path_a);
    assert_eq!(created.scope_id, env.scope_a);
    assert_eq!(created.used, 0);
    assert_eq!(env.get_session(&sa).await?, Some(created.clone()));

    // The contract's session_message view matches our byte layout.
    let payload = ckd_payload("bls12381g1:pk1-a", "bls12381g2:pk2-a");
    let view: Vec<u8> = env.signer.view("session_message").args_json(json!({"counter": 1, "payload": payload})).await?.json()?;
    assert_eq!(view, session_message(1, &payload));

    let args = sa.derive_args("bls12381g1:pk1-a", "bls12381g2:pk2-a");
    let replay = args.clone();
    let outcome = env.relayer_fc.call(env.signer.id(), "derive_key").args_json(args).gas(GAS).transact().await?;
    println!("derive_key gas burnt (with mock MPC): {} Tgas", outcome.total_gas_burnt.as_tgas());
    let response: CkdResponse = outcome.into_result()?.json()?;
    let expected: CkdResponse = env
        .mpc
        .view("expected_response")
        .args_json(json!({"request": {"derivation_path": path_a, "app_public_key": {"AppPublicKeyPV": {"pk1": "bls12381g1:pk1-a", "pk2": "bls12381g2:pk2-a"}}, "domain_id": CKD_DOMAIN_ID}}))
        .await?
        .json()?;
    assert_eq!(response, expected, "derive_key must return the MPC's answer unchanged");
    assert_eq!(env.get_session(&sa).await?.unwrap().used, 1);

    let calls = env.mpc_calls().await?;
    assert_eq!(calls.len(), 1);
    assert_eq!(calls[0].derivation_path, path_a);
    assert_eq!(&calls[0].predecessor, env.signer.id());
    assert_eq!(calls[0].domain_id, CKD_DOMAIN_ID);
    assert_eq!(calls[0].deposit, "1");
    assert_eq!((calls[0].pk1.as_str(), calls[0].pk2.as_str()), ("bls12381g1:pk1-a", "bls12381g2:pk2-a"));

    // Replaying the same signed request is rejected.
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(replay).gas(GAS).transact().await), "Wrong counter");
    // A signature by another key is rejected.
    let mut other = TestSession::new(0, 0, 1);
    other.counter = sa.counter;
    let mut forged = other.derive_args("bls12381g1:x", "bls12381g2:x");
    forged["session_public_key"] = json!(sa.public_key());
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(forged).gas(GAS).transact().await), "Invalid session signature");

    // Same user, app B: a different scope, so a different path.
    let (mut sb, jwt_b) = env.new_session(APP_B, USER_SUB, 0, 600_000).await?;
    let created_b: SessionView = env.create_session(&env.relayer_fc, &sb, &jwt_b).await?.into_result()?.json()?;
    let path_b = format!("{}#google#{}#0", env.scope_b, USER_SUB);
    assert_eq!(created_b.path, path_b);
    env.relayer_fc.call(env.signer.id(), "derive_key").args_json(sb.derive_args("p1", "p2")).gas(GAS).transact().await?.into_result()?;

    // Same user, app A, key index 1: a fresh wallet under the same login.
    let (mut s1, jwt_k1) = env.new_session(APP_A, USER_SUB, 1, 600_000).await?;
    let created_k1: SessionView = env.create_session(&env.relayer_fc, &s1, &jwt_k1).await?.into_result()?.json()?;
    let path_k1 = format!("{}#google#{}#1", env.scope_a, USER_SUB);
    assert_eq!(created_k1.path, path_k1);
    env.relayer_fc.call(env.signer.id(), "derive_key").args_json(s1.derive_args("p1", "p2")).gas(GAS).transact().await?.into_result()?;

    let paths: Vec<String> = env.mpc_calls().await?.into_iter().map(|c| c.derivation_path).collect();
    assert_eq!(paths, vec![path_a.clone(), path_b.clone(), path_k1.clone()]);
    assert_ne!(path_a, path_b);
    assert_ne!(path_a, path_k1);

    // A token for an unregistered client id is rejected.
    let (sx, jwt_x) = env.new_session(APP_X, USER_SUB, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sx, &jwt_x).await, "Token is for an unregistered app");
    // A token whose nonce commits to another session key is rejected.
    let (sy, _) = env.new_session(APP_A, USER_SUB, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sy, &jwt_a).await, "Token nonce doesn't commit to this session");
    // The key_index is in the nonce: a token for index 0 can't open index 1.
    let mut wrong_index = TestSession::new(sy.expires_at_ms, 1, 5);
    wrong_index.key = sy.key.clone();
    let jwt_idx0 = env.jwt(APP_A, USER_SUB, Some(&sy.nonce())).await?;
    expect_failure(env.create_session(&env.relayer_fc, &wrong_index, &jwt_idx0).await, "Token nonce doesn't commit to this session");
    // Re-opening a live session key is rejected.
    expect_failure(env.create_session(&env.relayer_fc, &sa, &jwt_a).await, "Session key already in use");

    // Revoke ends the session at once.
    let revoke = sb.revoke_args();
    env.relayer_fc.call(env.signer.id(), "revoke_session").args_json(revoke).gas(GAS).transact().await?.into_result()?;
    assert_eq!(env.get_session(&sb).await?, None);
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(sb.derive_args("p1", "p2")).gas(GAS).transact().await), "No such session");
    assert_eq!(env.mpc_calls().await?.len(), 3, "rejected requests never reach the MPC");
    Ok(())
}

/// The relayer's function-call key reaches only the relayed methods; the keys-updater key on the signer account
/// reaches only set_issuer_key / remove_issuer_key; nobody but the owner reaches admin methods.
#[tokio::test]
async fn access_keys_are_limited() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();

    // The relayer key can open sessions (see also the test above) and prune.
    let (s, jwt) = env.new_session(APP_A, USER_SUB, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
    env.relayer_fc.call(signer, "prune_sessions").args_json(json!({"limit": 10})).gas(GAS).transact().await?.into_result()?;

    // ...but not admin or issuer methods: the access key rejects the transaction before it runs.
    let issuer_key = json!({"provider": PROVIDER, "kid": "evil", "n": env.issuer.n, "e": env.issuer.e});
    let admin_calls: Vec<(&str, Value)> = vec![
        ("set_issuer_key", issuer_key.clone()),
        ("set_issuer", json!({"provider": "evil", "iss_values": ["https://evil.example"]})),
        ("admin_register_scope", json!({"owners": [near_owner(env.relayer.id())], "clients": [[PROVIDER, APP_X]], "scope_id": null})),
        ("enable_public_registration", json!({})),
        ("set_owner", json!({"owner": env.relayer.id()})),
        ("set_sponsors", json!({"sponsors": []})),
        ("set_change_delay_ms", json!({"change_delay_ms": 0})),
    ];
    for (method, args) in &admin_calls {
        let text = expect_failure(tx(env.relayer_fc.call(signer, method).args_json(args.clone()).gas(GAS).transact().await), "");
        assert!(text.contains("MethodNameMismatch"), "{method}: expected an access-key rejection, got {text}");
    }
    // Every change method outside the allowlist is refused by the access key; every allowlisted name exists in the
    // wasm (empty args fail inside the contract, not with MethodNameMismatch / MethodNotFound).
    assert_key_reaches_only(&env.relayer_fc, signer, RELAYER_METHODS, PROBE_GAS).await?;
    // Nor any other receiver.
    let text = expect_failure(tx(env.relayer_fc.call(env.mpc.id(), "request_app_private_key").args_json(json!({})).gas(GAS).transact().await), "");
    assert!(text.contains("ReceiverMismatch"), "expected a receiver rejection, got {text}");

    // Even with its full-access key, the relayer account is not the owner.
    for (method, args) in &admin_calls {
        expect_failure(tx(env.relayer.call(signer, method).args_json(args.clone()).gas(GAS).transact().await), "Only the owner");
    }

    // The keys-updater key (on the signer account itself) can rotate issuer keys. Its allowance (0.25 NEAR) must
    // cover the prepaid gas of each call (gas × gas price), so it sends 30 Tgas, not the relayer's 300.
    const UPDATER_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);
    env.keys_updater.call(signer, "set_issuer_key").args_json(json!({"provider": PROVIDER, "kid": "rotated", "n": env.issuer.n, "e": env.issuer.e})).gas(UPDATER_GAS).transact().await?.into_result()?;
    let issuer: Value = env.signer.view("get_issuer").args_json(json!({"provider": PROVIDER})).await?.json()?;
    let kids: Vec<&str> = issuer["kids"].as_array().unwrap().iter().map(|k| k.as_str().unwrap()).collect();
    assert!(kids.contains(&"rotated") && kids.contains(&KID), "kids: {kids:?}");
    let removed: bool = env.keys_updater.call(signer, "remove_issuer_key").args_json(json!({"provider": PROVIDER, "kid": "rotated"})).gas(UPDATER_GAS).transact().await?.into_result()?.json()?;
    assert!(removed);
    // ...but nothing else.
    for (method, args) in &admin_calls {
        if *method == "set_issuer_key" {
            continue;
        }
        let text = expect_failure(tx(env.keys_updater.call(signer, method).args_json(args.clone()).gas(UPDATER_GAS).transact().await), "");
        assert!(text.contains("MethodNameMismatch"), "{method}: expected an access-key rejection, got {text}");
    }
    assert_key_reaches_only(&env.keys_updater, signer, KEYS_UPDATER_METHODS, UPDATER_GAS).await?;
    // Other accounts can't touch issuer keys.
    expect_failure(tx(env.alice.call(signer, "set_issuer_key").args_json(issuer_key).gas(GAS).transact().await), "Only the owner or the contract account");

    // The owner can.
    let config: Value = env.signer.view("get_config").await?.json()?;
    assert_eq!(config["owner"], json!(env.admin.id()));
    assert_eq!(config["mpc"], json!(env.mpc.id()));
    assert_eq!(config["public_registration"], json!(false));

    // A keys-updater key re-added by hand with method_names [] (any method) fails the on-chain allowlist check
    // that Env::setup applies to the real keys...
    let wide_sk = near_workspaces::types::SecretKey::from_random(near_workspaces::types::KeyType::ED25519);
    env.signer
        .as_account()
        .batch(signer)
        .add_key(wide_sk.public_key(), near_workspaces::types::AccessKey::function_call_access(signer, &[], Some(NearToken::from_millinear(250))))
        .transact()
        .await?
        .into_result()?;
    let err = assert_function_call_key(&env.worker, signer, &wide_sk.public_key(), signer, KEYS_UPDATER_METHODS).await.expect_err("an any-method key must not pass as the keys-updater key");
    assert!(format!("{err}").contains("method_names []"), "{err}");
    // ...and, signing as the contract account, it still gets no owner powers: the contract privileges its own
    // account only for set_issuer_key / remove_issuer_key.
    let wide = near_workspaces::Account::from_secret_key(signer.clone(), wide_sk, &env.worker);
    for (method, args) in &admin_calls {
        if *method == "set_issuer_key" {
            continue;
        }
        expect_failure(tx(wide.call(signer, method).args_json(args.clone()).gas(UPDATER_GAS).transact().await), "Only the owner");
    }
    Ok(())
}

/// Smaller gas for calls that are expected to fail, so they don't drain a key's allowance.
const PROBE_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);

/// Calls every hana-signer change method with `key`: methods outside `allowed` must be refused by the access key
/// (MethodNameMismatch, before anything runs); allowed ones must reach the contract (they fail there on empty args).
async fn assert_key_reaches_only(key: &near_workspaces::Account, signer: &near_workspaces::AccountId, allowed: &[&str], gas: near_workspaces::types::Gas) -> Result<()> {
    for method in ALL_CHANGE_METHODS {
        let text = expect_failure(tx(key.call(signer, method).args_json(json!({})).gas(gas).transact().await), "");
        let refused = text.contains("MethodNameMismatch");
        if allowed.contains(method) {
            assert!(!refused && !text.contains("MethodNotFound"), "{method} is allowlisted for {} but did not reach the contract: {text}", key.id());
        } else {
            assert!(refused, "{method} is not allowlisted for {} but was not refused by the access key: {text}", key.id());
        }
    }
    for method in allowed {
        assert!(ALL_CHANGE_METHODS.contains(method), "allowlisted method {method} is not a known change method");
    }
    Ok(())
}

/// The sandbox keys use the same allowlists deploy-contract.ts installs (scripts/lib/contract.ts), so the
/// access-key test above checks the deployed restrictions, not a copy that could drift.
#[test]
fn method_allowlists_match_deploy_script() -> Result<()> {
    let mut relayer = deploy_script_methods("RELAYER_METHODS")?;
    let mut updater = deploy_script_methods("KEYS_UPDATER_METHODS")?;
    relayer.sort();
    updater.sort();
    let mut want_relayer: Vec<String> = RELAYER_METHODS.iter().map(|s| s.to_string()).collect();
    let mut want_updater: Vec<String> = KEYS_UPDATER_METHODS.iter().map(|s| s.to_string()).collect();
    want_relayer.sort();
    want_updater.sort();
    assert_eq!(relayer, want_relayer, "scripts/lib/contract.ts RELAYER_METHODS");
    assert_eq!(updater, want_updater, "scripts/lib/contract.ts KEYS_UPDATER_METHODS");
    // The relayer must never hold issuer or admin methods.
    for m in ["set_issuer_key", "remove_issuer_key", "set_issuer", "admin_register_scope", "set_owner", "enable_public_registration", "new"] {
        assert!(!relayer.iter().any(|r| r == m), "relayer allowlist contains {m}");
    }
    Ok(())
}

/// Once public registration is on, the admin path closes and anyone can register a scope with client proofs.
/// Owners add clients through a timelocked propose/execute; OIDC owners act through console tokens.
#[tokio::test]
async fn public_registration_and_timelocked_changes() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();

    // register_scope is closed while public_registration is false.
    let owners = vec![oidc_owner(OWNER_SUB), near_owner(env.carol.id())];
    let proof_c = env.jwt(APP_C, OWNER_SUB, Some(&register_nonce(&owners))).await?;
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_c]})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Public registration is not enabled",
    );

    env.admin.call(signer, "enable_public_registration").transact().await?.into_result()?;
    let config: Value = env.signer.view("get_config").await?.json()?;
    assert_eq!(config["public_registration"], json!(true));
    expect_failure(
        tx(env.admin.call(signer, "admin_register_scope").args_json(json!({"owners": [near_owner(env.admin.id())], "clients": [[PROVIDER, APP_X]], "scope_id": null})).gas(GAS).transact().await),
        "Admin registration is closed",
    );

    // Proofs must commit to the owners being registered.
    let other_owners = vec![near_owner(env.bob.id())];
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": other_owners, "client_proofs": [proof_c]})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Proof nonce doesn't commit to these owners",
    );
    // A client registered elsewhere can't be claimed.
    let proof_a = env.jwt(APP_A, OWNER_SUB, Some(&register_nonce(&owners))).await?;
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_a]})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Client is already registered",
    );
    // Non-sponsors pay for storage.
    let proof_d = env.jwt(APP_D, OWNER_SUB, Some(&register_nonce(&owners))).await?;
    let both = json!({"owners": owners, "client_proofs": [proof_c, proof_d]});
    expect_failure(tx(env.carol.call(signer, "register_scope").args_json(both.clone()).gas(GAS).transact().await), "Attached deposit doesn't cover storage");

    let res = env.carol.call(signer, "register_scope").args_json(both).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await?.into_result()?;
    assert!(res.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"scope_registered\"")), "logs: {:?}", res.logs());
    let scope_c: String = res.json()?;
    assert_eq!(env.scope_for_client(APP_C).await?.as_deref(), Some(scope_c.as_str()));
    assert_eq!(env.scope_for_client(APP_D).await?.as_deref(), Some(scope_c.as_str()));
    let scope = env.get_scope(&scope_c).await?;
    assert_eq!(scope["owners"], json!(owners));

    // A session through the self-registered app lands in its scope.
    let (s, jwt) = env.new_session(APP_C, USER_SUB, 0, 600_000).await?;
    let view: SessionView = env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?.json()?;
    assert_eq!(view.path, format!("{scope_c}#google#{USER_SUB}#0"));

    // OIDC owner removes a client through the relayer, with a console token whose nonce commits to the action.
    let action_nonce = scope["action_nonce"].as_u64().unwrap();
    let mut args = borsh_str(&scope_c);
    args.extend(borsh_str(PROVIDER));
    args.extend(borsh_str(APP_D));
    let console_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(&scope_c, "remove_client", &args, action_nonce))).await?;
    let remove = json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": console_jwt}}, "provider": PROVIDER, "aud": APP_D});
    // A token for another audience than the console is refused.
    let app_jwt = env.jwt(APP_C, OWNER_SUB, Some(&owner_action_nonce(&scope_c, "remove_client", &args, action_nonce))).await?;
    let mut wrong_aud = remove.clone();
    wrong_aud["auth"] = json!({"Oidc": {"jwt": app_jwt}});
    expect_failure(tx(env.relayer_fc.call(signer, "remove_client").args_json(wrong_aud).gas(GAS).transact().await), "Token is not for the Hana console");
    env.relayer_fc.call(signer, "remove_client").args_json(remove.clone()).gas(GAS).transact().await?.into_result()?;
    assert_eq!(env.scope_for_client(APP_D).await?, None);
    // Replay: action_nonce moved on.
    expect_failure(tx(env.relayer_fc.call(signer, "remove_client").args_json(remove).gas(GAS).transact().await), "Owner token nonce doesn't match");

    // Alice (NEAR owner of scope A) adds APP_E: client proof for (scope A, current action_nonce), timelocked.
    let scope_a = env.get_scope(&env.scope_a).await?;
    let nonce_a = scope_a["action_nonce"].as_u64().unwrap();
    let client_proof = env.jwt(APP_E, OWNER_SUB, Some(&client_proof_nonce(&env.scope_a, nonce_a))).await?;
    let change = json!({"AddClient": {"provider": PROVIDER, "aud": APP_E}});
    // Bob is not an owner of scope A.
    expect_failure(
        tx(env.bob.call(signer, "propose_change").args_json(json!({"scope_id": env.scope_a, "auth": "Near", "change": change, "client_proof": client_proof})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Caller is not a NEAR owner of this scope",
    );
    let before_ms = env.now_ms().await?;
    let change_id: u64 = env
        .alice
        .call(signer, "propose_change")
        .args_json(json!({"scope_id": env.scope_a, "auth": "Near", "change": change, "client_proof": client_proof}))
        .deposit(NearToken::from_millinear(10))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(change_id, nonce_a);
    let pending = env.get_scope(&env.scope_a).await?["pending"].clone();
    assert_eq!(pending[0]["change"], change);
    let unlock_at_ms = pending[0]["unlock_at_ms"].as_u64().unwrap();
    assert!(unlock_at_ms >= before_ms + CHANGE_DELAY_MS, "unlock {unlock_at_ms} vs proposed after {before_ms}");

    // Too early.
    expect_failure(
        tx(env.relayer_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(GAS).transact().await),
        "Change is still timelocked",
    );
    assert_eq!(env.scope_for_client(APP_E).await?, None);

    env.advance_to(unlock_at_ms + 1).await?;
    // Anyone can execute (here the relayer).
    env.relayer_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(GAS).transact().await?.into_result()?;
    assert_eq!(env.scope_for_client(APP_E).await?.as_deref(), Some(env.scope_a.as_str()));
    let scope_a = env.get_scope(&env.scope_a).await?;
    assert_eq!(scope_a["clients"], json!([[PROVIDER, APP_A], [PROVIDER, APP_E]]));
    assert_eq!(scope_a["pending"], json!([]));

    // The new client derives in scope A: same path as APP_A for the same user.
    let (s, jwt) = env.new_session(APP_E, USER_SUB, 0, 600_000).await?;
    let view: SessionView = env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?.json()?;
    assert_eq!(view.path, format!("{}#google#{USER_SUB}#0", env.scope_a));
    Ok(())
}

/// Expired sessions are deleted by prune_sessions (and opportunistically by create_session).
#[tokio::test]
async fn prune_sessions_after_expiry() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();

    let mut short = Vec::new();
    for _ in 0..4 {
        let (s, jwt) = env.new_session(APP_A, USER_SUB, 0, 15_000).await?;
        env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
        short.push(s);
    }
    let (long, jwt) = env.new_session(APP_B, USER_SUB, 0, 3_600_000).await?;
    env.create_session(&env.relayer_fc, &long, &jwt).await?.into_result()?;

    // Nothing has expired yet.
    let pruned: u32 = env.alice.call(signer, "prune_sessions").args_json(json!({"limit": 100})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 0);

    let latest = short.iter().map(|s| s.expires_at_ms).max().unwrap();
    env.advance_to(latest + 1).await?;

    // Expired but not yet pruned: unusable, still stored.
    let mut s0 = TestSession::new(short[0].expires_at_ms, 0, 5);
    s0.key = short[0].key.clone();
    expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(s0.derive_args("p1", "p2")).gas(GAS).transact().await), "Session expired");
    assert!(env.get_session(&short[0]).await?.is_some());

    // Anyone can prune, oldest first, up to `limit`.
    let pruned: u32 = env.alice.call(signer, "prune_sessions").args_json(json!({"limit": 2})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 2);
    assert_eq!(env.get_session(&short[0]).await?, None);
    assert_eq!(env.get_session(&short[1]).await?, None);
    assert!(env.get_session(&short[2]).await?.is_some());

    // create_session prunes up to 3 expired sessions itself: the remaining two, then stops at the live one.
    let (s, jwt) = env.new_session(APP_A, USER_SUB, 0, 600_000).await?;
    let outcome = env.create_session(&env.relayer_fc, &s, &jwt).await?;
    println!("create_session gas burnt (pruning 2): {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= CREATE_SESSION_GAS_BUDGET, "create_session burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
    outcome.into_result()?;
    assert_eq!(env.get_session(&short[2]).await?, None);
    assert_eq!(env.get_session(&short[3]).await?, None);
    assert!(env.get_session(&long).await?.is_some());
    assert!(env.get_session(&s).await?.is_some());

    let pruned: u32 = env.relayer_fc.call(signer, "prune_sessions").args_json(json!({"limit": 100})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 0);
    Ok(())
}
