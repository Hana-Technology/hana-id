//! End-to-end tests of hana-signer + mock-mpc in a local NEAR sandbox.
//!
//!   cd contracts/integration-tests && cargo test -- --nocapture
//!
//! Each test starts its own sandbox (downloaded once by near-workspaces) and builds the two contracts once per run
//! (set HANA_SIGNER_WASM / MOCK_MPC_WASM to use prebuilt wasm instead).

mod common;

use anyhow::Result;
use ed25519_dalek::Signer as _;
use common::*;
use near_workspaces::types::{KeyType, NearToken, SecretKey};
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
    let (mut sa, jwt_a) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let outcome = env.create_session(&env.relayer_fc, &sa, &jwt_a).await?;
    println!("create_session gas burnt: {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= create_session_gas_budget(), "create_session burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
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
    let outcome = env.relayer_fc.call(env.signer.id(), "derive_key").args_json(args).gas(api_gas("derive_key")).transact().await?;
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
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(replay).gas(api_gas("derive_key")).transact().await), "Wrong counter");
    // A signature by another key is rejected.
    let mut other = TestSession::new(&env.scope_a, 0, 0, 1);
    other.counter = sa.counter;
    let mut forged = other.derive_args("bls12381g1:x", "bls12381g2:x");
    forged["session_public_key"] = json!(sa.public_key());
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(forged).gas(api_gas("derive_key")).transact().await), "Invalid session signature");

    // Same user, app B: a different scope, so a different path.
    let (mut sb, jwt_b) = env.new_session(APP_B, USER_SUB, &env.scope_b, 0, 600_000).await?;
    let created_b: SessionView = env.create_session(&env.relayer_fc, &sb, &jwt_b).await?.into_result()?.json()?;
    let path_b = format!("{}#google#{}#0", env.scope_b, USER_SUB);
    assert_eq!(created_b.path, path_b);
    env.relayer_fc.call(env.signer.id(), "derive_key").args_json(sb.derive_args("p1", "p2")).gas(api_gas("derive_key")).transact().await?.into_result()?;

    // Same user, app A, key index 1: a fresh wallet under the same login.
    let (mut s1, jwt_k1) = env.new_session(APP_A, USER_SUB, &env.scope_a, 1, 600_000).await?;
    let created_k1: SessionView = env.create_session(&env.relayer_fc, &s1, &jwt_k1).await?.into_result()?.json()?;
    let path_k1 = format!("{}#google#{}#1", env.scope_a, USER_SUB);
    assert_eq!(created_k1.path, path_k1);
    env.relayer_fc.call(env.signer.id(), "derive_key").args_json(s1.derive_args("p1", "p2")).gas(api_gas("derive_key")).transact().await?.into_result()?;

    let paths: Vec<String> = env.mpc_calls().await?.into_iter().map(|c| c.derivation_path).collect();
    assert_eq!(paths, vec![path_a.clone(), path_b.clone(), path_k1.clone()]);
    assert_ne!(path_a, path_b);
    assert_ne!(path_a, path_k1);

    // A token for an unregistered client id is rejected.
    let (sx, jwt_x) = env.new_session(APP_X, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sx, &jwt_x).await, "Token is for an unregistered app");
    // An own-client token can only open sessions in its own scope, whatever scope_id the caller passes.
    let (sw, jwt_w) = env.new_session(APP_A, USER_SUB, &env.scope_b, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sw, &jwt_w).await, "Token is for another app");
    // A token whose nonce commits to another session key is rejected.
    let (sy, _) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sy, &jwt_a).await, "Token nonce doesn't commit to this session");
    // The key_index is in the nonce: a token for index 0 can't open index 1.
    let mut wrong_index = TestSession::new(&env.scope_a, sy.expires_at_ms, 1, sy.max_uses);
    wrong_index.key = sy.key.clone();
    let jwt_idx0 = env.jwt(APP_A, USER_SUB, Some(&sy.nonce(env.signer.id()))).await?;
    expect_failure(env.create_session(&env.relayer_fc, &wrong_index, &jwt_idx0).await, "Token nonce doesn't commit to this session");
    // max_uses is in the nonce too: a front-runner can't open the session with a lower cap.
    let mut lower_cap = TestSession::new(&env.scope_a, sy.expires_at_ms, 0, 1);
    lower_cap.key = sy.key.clone();
    expect_failure(env.create_session(&env.relayer_fc, &lower_cap, &jwt_idx0).await, "Token nonce doesn't commit to this session");
    // Re-opening a live session key is rejected.
    expect_failure(env.create_session(&env.relayer_fc, &sa, &jwt_a).await, "Session key already in use");

    // Revoke ends the session at once.
    let revoke = sb.revoke_args();
    env.relayer_fc.call(env.signer.id(), "revoke_session").args_json(revoke).gas(api_gas("revoke_session")).transact().await?.into_result()?;
    assert_eq!(env.get_session(&sb).await?, None);
    expect_failure(tx(env.relayer_fc.call(env.signer.id(), "derive_key").args_json(sb.derive_args("p1", "p2")).gas(api_gas("derive_key")).transact().await), "No such session");
    assert_eq!(env.mpc_calls().await?.len(), 3, "rejected requests never reach the MPC");
    Ok(())
}

/// The calls only the owner may make (admin, issuer and governance methods), with plausible arguments: the access-key
/// tests below send each one with every key that isn't the owner's.
fn admin_calls(env: &Env) -> Vec<(&'static str, Value)> {
    vec![
        ("set_issuer_key", evil_issuer_key(env)),
        ("set_issuer", json!({"provider": "evil", "iss_values": ["https://evil.example"]})),
        ("admin_register_scope", json!({"owners": [near_owner(env.relayer.id())], "clients": [[PROVIDER, APP_X]], "scope_id": null, "allow_shared": false})),
        ("enable_public_registration", json!({})),
        ("propose_owner", json!({"owner": env.relayer.id()})),
        ("set_sponsors", json!({"sponsors": []})),
        ("set_change_delay_ms", json!({"change_delay_ms": 0})),
        ("set_shared_clients", json!({"clients": [[PROVIDER, APP_X]]})),
        ("remove_issuer_key", json!({"provider": PROVIDER, "kid": KID})),
        ("set_issuer_key_delay_ms", json!({"issuer_key_delay_ms": 0})),
        ("set_governance_delay_ms", json!({"governance_delay_ms": 0})),
        ("add_watchdog", json!({"account_id": env.relayer.id()})),
        ("remove_watchdog", json!({"account_id": env.watchdog.id()})),
        ("pause", json!({})),
        ("unpause", json!({})),
        ("set_sessions_valid_from_ms", json!({"sessions_valid_from_ms": 0})),
        ("add_updater_key", json!({"public_key": SecretKey::from_random(KeyType::ED25519).public_key().to_string()})),
        ("propose_upgrade", json!({"code_hash": code_hash(b"evil")})),
        ("cancel_upgrade", json!({})),
        ("cancel_owner_proposal", json!({})),
        ("propose_withdrawal", json!({"receiver": env.relayer.id(), "amount": "1"})),
        ("cancel_withdrawal", json!({})),
        ("set_link_thresholds", json!({"per_scope_per_hour": 100_000, "total_per_hour": 100_000})),
    ]
}

fn evil_issuer_key(env: &Env) -> Value {
    json!({"provider": PROVIDER, "kid": "evil", "n": env.issuer.n, "e": env.issuer.e})
}

// The access-key tests: the relayer's two key pools reach only their own methods (the session pool can't call owner
// methods and vice versa); the updater key the contract installed on the signer account reaches only UPDATER_METHODS
// (propose keys and removals, execute matured changes); nobody but the owner reaches admin and governance methods.
// One test per key and check, each on its own sandbox, so they run side by side (D423): as one test they took
// about 9 minutes, half the suite run one test at a time.

/// The session pool opens sessions, the owner pool reaches owner-pool methods, neither runs the other's or the open
/// maintenance methods no endpoint relays (D455), the two allowlists don't overlap, and neither key reaches another
/// receiver.
#[tokio::test]
async fn access_keys_each_pool_runs_only_its_own_methods() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();

    // The session pool can open sessions (see also the test above).
    let (s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
    // The owner pool reaches owner-pool methods (it fails in the contract on empty args, past the access key)...
    let text = expect_failure(tx(env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({})).gas(PROBE_GAS).transact().await), "");
    assert!(!text.contains("MethodNameMismatch"), "owner pool execute_change: expected to reach the contract, got {text}");
    // ...but can't open sessions: abuse of the owner endpoint can never use up the login keys, and vice versa.
    let (s2, jwt2) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let text = expect_failure(env.create_session(&env.relayer_owner_fc, &s2, &jwt2).await, "");
    assert!(text.contains("MethodNameMismatch"), "owner pool create_session: expected an access-key rejection, got {text}");
    let text = expect_failure(tx(env.relayer_fc.call(signer, "apply_pending_config").args_json(json!({})).gas(PROBE_GAS).transact().await), "");
    assert!(text.contains("MethodNameMismatch"), "session pool apply_pending_config: expected an access-key rejection, got {text}");
    // Neither pool holds the open methods no endpoint relays: a leaked key can't spend its allowance on them.
    for (key, method) in [(&env.relayer_fc, "prune_sessions"), (&env.relayer_owner_fc, "apply_pending_config"), (&env.relayer_owner_fc, "register_scope")] {
        let text = expect_failure(tx(key.call(signer, method).args_json(json!({})).gas(PROBE_GAS).transact().await), "");
        assert!(text.contains("MethodNameMismatch"), "{method}: expected an access-key rejection, got {text}");
    }

    // The two pools don't overlap.
    for m in SESSION_RELAYER_METHODS {
        assert!(!OWNER_RELAYER_METHODS.contains(m), "{m} is in both pools");
    }
    // Nor any other receiver.
    for key in [&env.relayer_fc, &env.relayer_owner_fc] {
        let text = expect_failure(tx(key.call(env.mpc.id(), "request_app_private_key").args_json(json!({})).gas(PROBE_GAS).transact().await), "");
        assert!(text.contains("ReceiverMismatch"), "expected a receiver rejection, got {text}");
    }
    Ok(())
}

/// Neither pool reaches admin or issuer methods: the access key rejects the transaction before it runs.
#[tokio::test]
async fn access_keys_neither_pool_reaches_admin_methods() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    for key in [&env.relayer_fc, &env.relayer_owner_fc] {
        for (method, args) in &admin_calls(&env) {
            let text = expect_failure(tx(key.call(signer, method).args_json(args.clone()).gas(PROBE_GAS).transact().await), "");
            assert!(text.contains("MethodNameMismatch"), "{method}: expected an access-key rejection, got {text}");
        }
    }
    Ok(())
}

/// Every change method outside the session pool's allowlist is refused by its access key; every allowlisted name
/// exists in the wasm (it runs, or fails inside the contract, not with MethodNameMismatch / MethodNotFound).
#[tokio::test]
async fn access_keys_session_pool_reaches_exactly_its_allowlist() -> Result<()> {
    let env = Env::setup().await?;
    assert_key_reaches_only(&env.relayer_fc, env.signer.id(), SESSION_RELAYER_METHODS, PROBE_GAS).await
}

/// The same for the owner pool.
#[tokio::test]
async fn access_keys_owner_pool_reaches_exactly_its_allowlist() -> Result<()> {
    let env = Env::setup().await?;
    assert_key_reaches_only(&env.relayer_owner_fc, env.signer.id(), OWNER_RELAYER_METHODS, PROBE_GAS).await
}

/// Even with its full-access key, the relayer account is not the owner.
#[tokio::test]
async fn access_keys_the_relayer_full_access_key_is_not_the_owner() -> Result<()> {
    let env = Env::setup().await?;
    for (method, args) in &admin_calls(&env) {
        expect_failure(tx(env.relayer.call(env.signer.id(), method).args_json(args.clone()).gas(GAS).transact().await), "Only the owner");
    }
    Ok(())
}

/// The updater key's gas. Its allowance (1 NEAR) must cover the prepaid gas of each call (gas × gas price), so it
/// sends 30 Tgas, not the 300 Tgas wallet calls here attach.
const UPDATER_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);

/// The updater key (on the signer account itself) proposes issuer keys and removals and executes matured changes,
/// and nothing else (remove_issuer_key, the immediate path, is the owner's only).
#[tokio::test]
async fn access_keys_the_updater_key_proposes_and_executes_issuer_key_changes_only() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let id: u64 = env
        .keys_updater
        .call(signer, "set_issuer_key")
        .args_json(json!({"provider": PROVIDER, "kid": "rotated", "n": env.issuer.n, "e": env.issuer.e}))
        .gas(UPDATER_GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    assert_eq!(env.kids().await?, vec![KID.to_string()], "a proposed key is not active");
    env.watchdog.call(signer, "confirm_issuer_key_change").args_json(json!({"id": id})).transact().await?.into_result()?;
    assert_eq!(env.kids().await?, vec!["rotated".to_string(), KID.to_string()]);
    let id: u64 = env.keys_updater.call(signer, "propose_issuer_key_removal").args_json(json!({"provider": PROVIDER, "kid": "rotated"})).gas(UPDATER_GAS).transact().await?.into_result()?.json()?;
    let due = env.get_key_changes().await?[0]["executable_at_ms"].as_u64().unwrap();
    env.advance_to(due).await?;
    env.keys_updater.call(signer, "execute_issuer_key_change").args_json(json!({"id": id})).gas(UPDATER_GAS).transact().await?.into_result()?;
    assert_eq!(env.kids().await?, vec![KID.to_string()]);
    // ...but nothing else.
    for (method, args) in &admin_calls(&env) {
        if *method == "set_issuer_key" {
            continue;
        }
        let text = expect_failure(tx(env.keys_updater.call(signer, method).args_json(args.clone()).gas(UPDATER_GAS).transact().await), "");
        assert!(text.contains("MethodNameMismatch"), "{method}: expected an access-key rejection, got {text}");
    }
    Ok(())
}

/// Every change method outside UPDATER_METHODS is refused by the updater key; each of those reaches the contract.
#[tokio::test]
async fn access_keys_the_updater_key_reaches_exactly_its_allowlist() -> Result<()> {
    let env = Env::setup().await?;
    assert_key_reaches_only(&env.keys_updater, env.signer.id(), UPDATER_METHODS, UPDATER_GAS).await
}

/// Other accounts can't touch issuer keys, the owner is the admin, and a keys-updater key re-added by hand with any
/// method allowed fails the on-chain allowlist check and, signing as the contract account, still gets no owner or
/// watchdog powers.
#[tokio::test]
async fn access_keys_only_the_owner_sets_issuer_keys_and_a_wide_updater_key_gets_no_powers() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    // Other accounts can't touch issuer keys.
    expect_failure(tx(env.alice.call(signer, "set_issuer_key").args_json(evil_issuer_key(&env)).gas(GAS).transact().await), "Only the owner or the contract account");

    // The owner can.
    let config = env.get_config().await?;
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
    let err = assert_function_call_key(&env.worker, signer, &wide_sk.public_key(), signer, UPDATER_METHODS).await.expect_err("an any-method key must not pass as the keys-updater key");
    assert!(format!("{err}").contains("method_names []"), "{err}");
    // ...and, signing as the contract account, it still gets no owner or watchdog powers: the contract privileges
    // its own account only for proposing key changes (set_issuer_key, propose_issuer_key_removal).
    let wide = near_workspaces::Account::from_secret_key(signer.clone(), wide_sk, &env.worker);
    for (method, args) in &admin_calls(&env) {
        if *method == "set_issuer_key" {
            continue;
        }
        expect_failure(tx(wide.call(signer, method).args_json(args.clone()).gas(UPDATER_GAS).transact().await), "Only the owner");
    }
    Ok(())
}

/// Smaller gas for probe calls, so they don't drain a key's allowance.
const PROBE_GAS: near_workspaces::types::Gas = near_workspaces::types::Gas::from_tgas(30);

/// Calls every hana-signer change method with `key` and empty args: methods outside `allowed` must be refused by
/// the access key (MethodNameMismatch, before anything runs); allowed ones must reach the contract (most fail there
/// on missing args; argument-less ones such as apply_pending_config may succeed).
async fn assert_key_reaches_only(key: &near_workspaces::Account, signer: &near_workspaces::AccountId, allowed: &[&str], gas: near_workspaces::types::Gas) -> Result<()> {
    for method in ALL_CHANGE_METHODS {
        let text = match key.call(signer, method).args_json(json!({})).gas(gas).transact().await {
            Ok(outcome) => match outcome.into_result() {
                Ok(_) => String::from("<succeeded>"),
                Err(e) => format!("{e:?}"),
            },
            Err(e) => format!("{e:?}"),
        };
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

/// The tests start sandboxes on several threads at once (D423), so nothing may set an env var while they run:
/// .cargo/config.toml sets NEAR_ENABLE_SANDBOX_LOG (and NEAR_SANDBOX_LOG) before the binary starts, which turns
/// off the `set_var("NEAR_SANDBOX_LOG", …)` near-workspaces and near-sandbox otherwise make at each sandbox start.
#[test]
fn sandbox_starts_set_no_env_vars() {
    let on = std::env::var("NEAR_ENABLE_SANDBOX_LOG").unwrap_or_default();
    assert!(!on.is_empty() && on != "0", "NEAR_ENABLE_SANDBOX_LOG must be set and not 0 (contracts/integration-tests/.cargo/config.toml), got {on:?}");
    assert!(std::env::var("NEAR_SANDBOX_LOG").is_ok(), "NEAR_SANDBOX_LOG must be set (contracts/integration-tests/.cargo/config.toml)");
}

/// The sandbox relayer keys use the same allowlists deploy-contract.ts installs (scripts/lib/contract.ts), so the
/// access-key tests above check the deployed restrictions, not a copy that could drift. The updater key is no
/// longer one deploy-contract adds by hand: the contract installs it with its own constant method list
/// (`add_updater_key`), which the sandbox checks on chain against UPDATER_METHODS (Env::setup, the access_keys_* tests,
/// tests/governance.rs); scripts/lib/contract.ts UPDATER_METHODS, which deploy-plan checks the signer's keys against,
/// must be that same list.
#[test]
fn method_allowlists_match_deploy_script() -> Result<()> {
    for (name, want) in [("SESSION_RELAYER_METHODS", SESSION_RELAYER_METHODS), ("OWNER_RELAYER_METHODS", OWNER_RELAYER_METHODS), ("UPDATER_METHODS", UPDATER_METHODS)] {
        let mut got = deploy_script_methods(name)?;
        got.sort();
        let mut want: Vec<String> = want.iter().map(|s| s.to_string()).collect();
        want.sort();
        assert_eq!(got, want, "scripts/lib/contract.ts {name}");
    }
    // Neither relayer pool may ever hold issuer, admin or governance methods: only the owner-pool methods and the
    // session-pool methods are relayable at all.
    let relayable: Vec<&str> = SESSION_RELAYER_METHODS.iter().chain(OWNER_RELAYER_METHODS).copied().collect();
    for name in ["SESSION_RELAYER_METHODS", "OWNER_RELAYER_METHODS"] {
        let methods = deploy_script_methods(name)?;
        for m in ALL_CHANGE_METHODS.iter().filter(|m| !relayable.contains(m)).chain(&["set_owner"]) {
            assert!(!methods.iter().any(|r| r == m), "{name} contains {m}");
        }
    }
    // The updater key's methods are change methods of the contract, and none is relayed.
    for m in UPDATER_METHODS {
        assert!(ALL_CHANGE_METHODS.contains(m) && !relayable.contains(m), "{m}");
    }
    Ok(())
}

/// The session pool's allowlist is one of the three planned states (docs/batch-b-spec.md "Relayer allowlists"), and
/// the deploy script (scripts/lib/contract.ts, the keys it installs), the API (apps/api/src/relayer-config.ts, what its
/// relayer objects relay) and the sandbox keys all hold that same state. Moving to another state changes
/// SESSION_ALLOWLIST_STATE here and both TS lists together.
#[test]
fn session_allowlist_is_in_a_planned_state_everywhere() -> Result<()> {
    let sorted = |v: Vec<String>| {
        let mut v = v;
        v.sort();
        v
    };
    let owned = |m: &[&str]| sorted(m.iter().map(|s| s.to_string()).collect());
    // The three states, as the spec lists them less prune_sessions (D455): each keeps derive_key and revoke_session
    // (and, since email login batch 6, the link methods); state 2 drops create_session, state 3 create_session_and_derive.
    let [s1, s2, s3] = SESSION_ALLOWLIST_STATES;
    let mut first = vec!["create_session", "create_session_and_derive", "derive_key", "revoke_session"];
    first.extend_from_slice(LINK_RELAYER_METHODS);
    assert_eq!(owned(s1), owned(&first));
    for state in SESSION_ALLOWLIST_STATES {
        for m in LINK_RELAYER_METHODS {
            assert!(state.contains(m), "{m} missing from a session-pool state");
        }
    }
    assert_eq!(owned(s2), owned(&s1.iter().copied().filter(|m| *m != "create_session").collect::<Vec<_>>()));
    assert_eq!(owned(s3), owned(&s1.iter().copied().filter(|m| *m != "create_session_and_derive").collect::<Vec<_>>()));
    for state in SESSION_ALLOWLIST_STATES {
        for m in state {
            assert!(ALL_CHANGE_METHODS.contains(m), "{m} is not a hana-signer change method");
            assert!(!OWNER_RELAYER_METHODS.contains(m), "{m} is in both pools");
        }
    }
    let current = owned(SESSION_ALLOWLIST_STATES[SESSION_ALLOWLIST_STATE]);
    assert_eq!(owned(SESSION_RELAYER_METHODS), current);
    assert_eq!(sorted(deploy_script_methods("SESSION_RELAYER_METHODS")?), current, "scripts/lib/contract.ts SESSION_RELAYER_METHODS");
    assert_eq!(sorted(api_pool_methods("session")?), current, "apps/api/src/relayer-config.ts POOL_METHODS.session");
    assert_eq!(sorted(api_pool_methods("owner")?), owned(OWNER_RELAYER_METHODS), "apps/api/src/relayer-config.ts POOL_METHODS.owner");
    Ok(())
}

/// Every method a relayer pool may call has a gas value in the API (apps/api/src/gas.ts), and the API has none for
/// methods outside the pools; each fits NEAR's 300 Tgas cap. The sandbox tests attach these values to relayed calls.
#[test]
fn api_gas_covers_relayed_methods() -> Result<()> {
    let table = api_gas_table()?;
    let mut got: Vec<&str> = table.iter().map(|(m, _)| m.as_str()).collect();
    got.sort_unstable();
    let mut want: Vec<&str> = SESSION_RELAYER_METHODS.iter().chain(OWNER_RELAYER_METHODS).copied().collect();
    want.sort_unstable();
    want.dedup();
    assert_eq!(got, want, "apps/api/src/gas.ts DEFAULT_GAS_TGAS keys vs the relayer pools' methods");
    for (m, tgas) in &table {
        assert!((1..=300).contains(tgas), "{m}: {tgas} Tgas");
    }
    // The budget the create_session assertions use is the API's, not a looser sandbox value.
    assert_eq!(create_session_gas_budget(), api_gas("create_session"));
    assert!(create_session_gas_budget() < GAS);
    Ok(())
}

/// Once public registration is on, the admin path closes and anyone can register a scope with client proofs.
/// Owners add clients through a timelocked propose/execute; OIDC owners act through console tokens.
#[tokio::test]
async fn public_registration_and_timelocked_changes() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let sid = signer.as_str();

    // register_scope is closed while public_registration is false.
    let owners = vec![oidc_owner(OWNER_SUB), near_owner(env.carol.id())];
    let only_c = [(PROVIDER, APP_C)];
    let proof_c = env.jwt(APP_C, OWNER_SUB, Some(&register_nonce(sid, &owners, &only_c, false))).await?;
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_c], "allow_shared": false})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Public registration is not enabled",
    );

    env.admin.call(signer, "enable_public_registration").transact().await?.into_result()?;
    let config = env.get_config().await?;
    assert_eq!(config["public_registration"], json!(true));
    expect_failure(
        tx(env.admin.call(signer, "admin_register_scope").args_json(json!({"owners": [near_owner(env.admin.id())], "clients": [[PROVIDER, APP_X]], "scope_id": null, "allow_shared": false})).gas(GAS).transact().await),
        "Admin registration is closed",
    );

    // Proofs must commit to the owners being registered...
    let other_owners = vec![near_owner(env.bob.id())];
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": other_owners, "client_proofs": [proof_c], "allow_shared": false})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Proof nonce doesn't commit to this registration",
    );
    // ...and to allow_shared...
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_c], "allow_shared": true})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Proof nonce doesn't commit to this registration",
    );
    // A client registered elsewhere can't be claimed.
    let proof_a = env.jwt(APP_A, OWNER_SUB, Some(&register_nonce(sid, &owners, &[(PROVIDER, APP_A)], false))).await?;
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_a], "allow_shared": false})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Client is already registered",
    );
    // ...and to the whole client set, in order: a front-runner can't register a subset with proof_c alone.
    let both_clients = [(PROVIDER, APP_C), (PROVIDER, APP_D)];
    let proof_c2 = env.jwt(APP_C, OWNER_SUB, Some(&register_nonce(sid, &owners, &both_clients, false))).await?;
    let proof_d2 = env.jwt(APP_D, OWNER_SUB, Some(&register_nonce(sid, &owners, &both_clients, false))).await?;
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_c2], "allow_shared": false})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Proof nonce doesn't commit to this registration",
    );
    expect_failure(
        tx(env.carol.call(signer, "register_scope").args_json(json!({"owners": owners, "client_proofs": [proof_d2, proof_c2], "allow_shared": false})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Proof nonce doesn't commit to this registration",
    );
    // Non-sponsors pay for storage.
    let both = json!({"owners": owners, "client_proofs": [proof_c2, proof_d2], "allow_shared": false});
    expect_failure(tx(env.carol.call(signer, "register_scope").args_json(both.clone()).gas(GAS).transact().await), "Attached deposit doesn't cover storage");

    let res = env.carol.call(signer, "register_scope").args_json(both).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await?.into_result()?;
    assert!(res.logs().iter().any(|l| l.starts_with("EVENT_JSON:") && l.contains("\"scope_registered\"")), "logs: {:?}", res.logs());
    let scope_c: String = res.json()?;
    assert_eq!(env.scope_for_client(APP_C).await?.as_deref(), Some(scope_c.as_str()));
    assert_eq!(env.scope_for_client(APP_D).await?.as_deref(), Some(scope_c.as_str()));
    let scope = env.get_scope(&scope_c).await?;
    assert_eq!(scope["owners"], json!(owners));
    assert_eq!(scope["allow_shared"], json!(false));

    // A shared-only scope needs no proof (scope ids are contract-assigned, nothing to squat). From the relayer account,
    // a sponsor (no pool key holds register_scope, D455).
    let shared_only: String = env
        .relayer
        .call(signer, "register_scope")
        .args_json(json!({"owners": [near_owner(env.carol.id())], "client_proofs": [], "allow_shared": true}))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let scope_so = env.get_scope(&shared_only).await?;
    assert_eq!(scope_so["clients"], json!([]));
    assert_eq!(scope_so["allow_shared"], json!(true));
    // Without shared login a scope needs at least one client.
    expect_failure(
        tx(env.relayer.call(signer, "register_scope").args_json(json!({"owners": [near_owner(env.carol.id())], "client_proofs": [], "allow_shared": false})).gas(GAS).transact().await),
        "A scope needs a client or shared login",
    );

    // Worst case for register_scope: MAX_CLIENTS (10) RS256 proofs and 5 OIDC owners.
    let big_owners: Vec<Value> = (0..5).map(|i| oidc_owner(&format!("{OWNER_SUB}-{i}"))).collect();
    let big_auds: Vec<String> = (0..10).map(|i| format!("app-big-{i}.apps.googleusercontent.com")).collect();
    let big_clients: Vec<(&str, &str)> = big_auds.iter().map(|a| (PROVIDER, a.as_str())).collect();
    let big_nonce = register_nonce(sid, &big_owners, &big_clients, false);
    let mut big_proofs = Vec::new();
    for aud in &big_auds {
        big_proofs.push(env.jwt(aud, OWNER_SUB, Some(&big_nonce)).await?);
    }
    let big = env
        .relayer
        .call(signer, "register_scope")
        .args_json(json!({"owners": big_owners, "client_proofs": big_proofs, "allow_shared": false}))
        .gas(GAS)
        .transact()
        .await?;
    println!("register_scope with 10 proofs burnt {} Tgas", big.total_gas_burnt.as_tgas());
    let scope_big: String = big.into_result()?.json()?;
    assert_eq!(env.get_scope(&scope_big).await?["clients"].as_array().map(Vec::len), Some(10));

    // A session through the self-registered app lands in its scope.
    let (s, jwt) = env.new_session(APP_C, USER_SUB, &scope_c, 0, 600_000).await?;
    let view: SessionView = env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?.json()?;
    assert_eq!(view.path, format!("{scope_c}#google#{USER_SUB}#0"));

    // OIDC owner removes a client through the owner pool, with a console token whose nonce commits to the action.
    let action_nonce = scope["action_nonce"].as_u64().unwrap();
    let mut args = borsh_str(&scope_c);
    args.extend(borsh_str(PROVIDER));
    args.extend(borsh_str(APP_D));
    let console_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "remove_client", &args, action_nonce))).await?;
    let remove = json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": console_jwt}}, "provider": PROVIDER, "aud": APP_D});
    // A token for another audience than the console is refused.
    let app_jwt = env.jwt(APP_C, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "remove_client", &args, action_nonce))).await?;
    let mut wrong_aud = remove.clone();
    wrong_aud["auth"] = json!({"Oidc": {"jwt": app_jwt}});
    expect_failure(tx(env.relayer_owner_fc.call(signer, "remove_client").args_json(wrong_aud).gas(api_gas("remove_client")).transact().await), "Token is not for the Hana console");
    // A token for another method (same args) is refused.
    let wrong_method = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "cancel_change", &args, action_nonce))).await?;
    let mut wm = remove.clone();
    wm["auth"] = json!({"Oidc": {"jwt": wrong_method}});
    expect_failure(tx(env.relayer_owner_fc.call(signer, "remove_client").args_json(wm).gas(api_gas("remove_client")).transact().await), "Owner token nonce doesn't match");
    env.relayer_owner_fc.call(signer, "remove_client").args_json(remove.clone()).gas(api_gas("remove_client")).transact().await?.into_result()?;
    assert_eq!(env.scope_for_client(APP_D).await?, None);
    // Replay: action_nonce moved on.
    expect_failure(tx(env.relayer_owner_fc.call(signer, "remove_client").args_json(remove).gas(api_gas("remove_client")).transact().await), "Owner token nonce doesn't match");

    // The OIDC owner's heaviest action, as /v1/owner-actions relays it at the API's gas: propose_change(AddClient)
    // verifies two RS256 tokens (the console owner token and the client proof). Re-adding APP_D to the scope it was
    // removed from is allowed at once (the quarantine only blocks other scopes).
    let nonce_c = env.get_scope(&scope_c).await?["action_nonce"].as_u64().unwrap();
    let proof_d = env.jwt(APP_D, OWNER_SUB, Some(&client_proof_nonce(sid, &scope_c, nonce_c))).await?;
    let add_d = json!({"AddClient": {"provider": PROVIDER, "aud": APP_D}});
    let mut args = borsh_str(&scope_c);
    args.extend(borsh_change(&add_d));
    args.extend(borsh_opt_str(Some(&proof_d)));
    let owner_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "propose_change", &args, nonce_c))).await?;
    let propose = json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": owner_jwt}}, "change": add_d, "client_proof": proof_d});
    let outcome = env.relayer_owner_fc.call(signer, "propose_change").args_json(propose).gas(api_gas("propose_change")).transact().await?;
    println!("propose_change (OIDC owner + client proof) gas burnt: {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= api_gas("propose_change"), "propose_change burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
    let add_d_id: u64 = outcome.into_result()?.json()?;
    assert_eq!(add_d_id, nonce_c);
    // OIDC cancel_change through the owner pool.
    let mut args = borsh_str(&scope_c);
    args.extend(borsh_u64(add_d_id));
    let owner_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "cancel_change", &args, nonce_c + 1))).await?;
    env.relayer_owner_fc
        .call(signer, "cancel_change")
        .args_json(json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": owner_jwt}}, "change_id": add_d_id}))
        .gas(api_gas("cancel_change"))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(env.get_scope(&scope_c).await?["pending"], json!([]));
    // OIDC propose_change(SetAllowShared) through the owner pool; executed and then disabled below.
    let set_allow = json!({"SetAllowShared": {"allow": true}});
    let mut args = borsh_str(&scope_c);
    args.extend(borsh_change(&set_allow));
    args.extend(borsh_opt_str(None));
    let owner_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "propose_change", &args, nonce_c + 2))).await?;
    let allow_id: u64 = env
        .relayer_owner_fc
        .call(signer, "propose_change")
        .args_json(json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": owner_jwt}}, "change": set_allow, "client_proof": null}))
        .gas(api_gas("propose_change"))
        .transact()
        .await?
        .into_result()?
        .json()?;

    // Alice (NEAR owner of scope A) adds APP_E: client proof for (signer, scope A, current action_nonce), timelocked.
    let scope_a = env.get_scope(&env.scope_a).await?;
    let nonce_a = scope_a["action_nonce"].as_u64().unwrap();
    let client_proof = env.jwt(APP_E, OWNER_SUB, Some(&client_proof_nonce(sid, &env.scope_a, nonce_a))).await?;
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
        tx(env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(api_gas("execute_change")).transact().await),
        "Change is still timelocked",
    );
    assert_eq!(env.scope_for_client(APP_E).await?, None);

    env.advance_to(unlock_at_ms + 1).await?;
    // Anyone can execute (here the relayer's owner pool).
    env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(api_gas("execute_change")).transact().await?.into_result()?;
    assert_eq!(env.scope_for_client(APP_E).await?.as_deref(), Some(env.scope_a.as_str()));

    // Scope C's SetAllowShared (proposed before alice's change, so unlocked too) executes; then the OIDC owner
    // disables shared login through the owner pool, at the API's gas.
    env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": scope_c, "change_id": allow_id})).gas(api_gas("execute_change")).transact().await?.into_result()?;
    assert_eq!(env.get_scope(&scope_c).await?["allow_shared"], json!(true));
    let nonce_c = env.get_scope(&scope_c).await?["action_nonce"].as_u64().unwrap();
    let owner_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(sid, &scope_c, "disable_shared_login", &borsh_str(&scope_c), nonce_c))).await?;
    env.relayer_owner_fc
        .call(signer, "disable_shared_login")
        .args_json(json!({"scope_id": scope_c, "auth": {"Oidc": {"jwt": owner_jwt}}}))
        .gas(api_gas("disable_shared_login"))
        .transact()
        .await?
        .into_result()?;
    assert_eq!(env.get_scope(&scope_c).await?["allow_shared"], json!(false));
    let scope_a = env.get_scope(&env.scope_a).await?;
    assert_eq!(scope_a["clients"], json!([[PROVIDER, APP_A], [PROVIDER, APP_E]]));
    assert_eq!(scope_a["pending"], json!([]));

    // The new client derives in scope A: same path as APP_A for the same user.
    let (s, jwt) = env.new_session(APP_E, USER_SUB, &env.scope_a, 0, 600_000).await?;
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
        let (s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 15_000).await?;
        env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
        short.push(s);
    }
    let (long, jwt) = env.new_session(APP_B, USER_SUB, &env.scope_b, 0, 3_600_000).await?;
    env.create_session(&env.relayer_fc, &long, &jwt).await?.into_result()?;

    // Nothing has expired yet.
    let pruned: u32 = env.alice.call(signer, "prune_sessions").args_json(json!({"limit": 100})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 0);

    let latest = short.iter().map(|s| s.expires_at_ms).max().unwrap();
    env.advance_to(latest + 1).await?;

    // Expired but not yet pruned: unusable, still stored.
    let mut s0 = TestSession::new(&env.scope_a, short[0].expires_at_ms, 0, 5);
    s0.key = short[0].key.clone();
    expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(s0.derive_args("p1", "p2")).gas(api_gas("derive_key")).transact().await), "Session expired");
    assert!(env.get_session(&short[0]).await?.is_some());

    // Anyone can prune, oldest first, up to `limit`.
    let pruned: u32 = env.alice.call(signer, "prune_sessions").args_json(json!({"limit": 2})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 2);
    assert_eq!(env.get_session(&short[0]).await?, None);
    assert_eq!(env.get_session(&short[1]).await?, None);
    assert!(env.get_session(&short[2]).await?.is_some());

    // create_session prunes up to 3 expired sessions itself: the remaining two, then stops at the live one.
    let (s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let outcome = env.create_session(&env.relayer_fc, &s, &jwt).await?;
    println!("create_session gas burnt (pruning 2): {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= create_session_gas_budget(), "create_session burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
    outcome.into_result()?;
    assert_eq!(env.get_session(&short[2]).await?, None);
    assert_eq!(env.get_session(&short[3]).await?, None);
    assert!(env.get_session(&long).await?.is_some());
    assert!(env.get_session(&s).await?.is_some());

    let pruned: u32 = env.alice.call(signer, "prune_sessions").args_json(json!({"limit": 100})).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(pruned, 0);
    Ok(())
}

/// Hana's shared Google client: its tokens carry Hana's `aud`, so the scope comes from `scope_id`, committed to by
/// the session nonce. Shared-client additions are timelocked, removals immediate; a client is never both shared and
/// registered; only scopes with `allow_shared` accept shared tokens; the path for a user is the same whether they
/// come through the shared client or the app's own client.
#[tokio::test]
async fn shared_client_login() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let sid = signer.as_str();

    // A shared-only scope (no clients) is fine with allow_shared; without it a scope needs a client.
    let scope_s = env.admin_register(vec![near_owner(env.carol.id())], &[], true).await?;
    let s = env.get_scope(&scope_s).await?;
    assert_eq!((s["clients"].clone(), s["allow_shared"].clone()), (json!([]), json!(true)));
    expect_failure(env.try_admin_register_on(signer, vec![near_owner(env.carol.id())], &[], false).await, "A scope needs a client or shared login");
    assert_eq!(env.get_scope(&env.scope_a).await?["allow_shared"], json!(false));

    // Adding a shared client is timelocked.
    let before_ms = env.now_ms().await?;
    env.set_shared_clients(&[SHARED]).await?.into_result()?;
    let config = env.get_config().await?;
    println!("get_config with a pending shared client: {config}");
    assert_eq!(config["shared_clients"], json!([]), "a shared client addition must not apply before the delay");
    assert_eq!(config["pending_shared_clients"][0]["provider"], json!(PROVIDER));
    assert_eq!(config["pending_shared_clients"][0]["aud"], json!(SHARED));
    let unlock_at_ms = pending_shared_unlock(&config, SHARED).unwrap_or_else(|| panic!("pending shared addition of {SHARED} not shown in get_config: {config}"));
    assert!(unlock_at_ms >= before_ms + CHANGE_DELAY_MS, "unlock {unlock_at_ms} vs set after {before_ms}");
    // Only the owner sets shared clients.
    expect_failure(tx(env.alice.call(signer, "set_shared_clients").args_json(json!({"clients": [[PROVIDER, APP_X]]})).gas(GAS).transact().await), "Only the owner");

    // Not effective yet.
    let (s0, jwt0) = env.new_session(SHARED, USER_SUB, &scope_s, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &s0, &jwt0).await, "Token is for an unregistered app");

    // A pending shared client can't be registered to a scope...
    expect_failure(env.try_admin_register_on(signer, vec![near_owner(env.carol.id())], &[SHARED], false).await, "Client is a shared client");
    // ...and a registered client can't become shared.
    expect_failure(env.set_shared_clients(&[SHARED, APP_A]).await, "Client is already registered");

    env.advance_to(unlock_at_ms + 1).await?;
    // Lazy on read: the view shows it effective once the delay has passed.
    let config = env.get_config().await?;
    assert_eq!(config["shared_clients"], json!([[PROVIDER, SHARED]]), "config: {config}");
    // Anyone may apply it.
    env.alice.call(signer, "apply_pending_config").args_json(json!({})).gas(GAS).transact().await?.into_result()?;
    let config = env.get_config().await?;
    assert_eq!(config["shared_clients"], json!([[PROVIDER, SHARED]]), "config: {config}");
    assert_eq!(pending_shared_unlock(&config, SHARED), None, "applied addition still pending: {config}");

    // An effective shared client can't be registered either (admin path, or AddClient on a scope).
    expect_failure(env.try_admin_register_on(signer, vec![near_owner(env.carol.id())], &[SHARED], false).await, "Client is a shared client");
    let nonce_a = env.get_scope(&env.scope_a).await?["action_nonce"].as_u64().unwrap();
    let proof = env.jwt(SHARED, OWNER_SUB, Some(&client_proof_nonce(sid, &env.scope_a, nonce_a))).await?;
    expect_failure(
        tx(env.alice.call(signer, "propose_change").args_json(json!({"scope_id": env.scope_a, "auth": "Near", "change": {"AddClient": {"provider": PROVIDER, "aud": SHARED}}, "client_proof": proof})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Client is a shared client",
    );
    assert_eq!(env.scope_for_client(SHARED).await?, None);

    // Shared token into the shared-only scope.
    let (mut ss, jwt_ss) = env.new_session(SHARED, USER_SUB, &scope_s, 0, 600_000).await?;
    let view: SessionView = env.create_session(&env.relayer_fc, &ss, &jwt_ss).await?.into_result()?.json()?;
    let path_s = format!("{scope_s}#google#{USER_SUB}#0");
    assert_eq!((view.path.as_str(), view.scope_id.as_str()), (path_s.as_str(), scope_s.as_str()));
    // Shared token into a scope without allow_shared.
    let (sa0, jwt_sa0) = env.new_session(SHARED, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sa0, &jwt_sa0).await, "Scope does not allow shared login");
    // Shared token into a scope that doesn't exist.
    let (sn, jwt_sn) = env.new_session(SHARED, USER_SUB, "szzz", 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sn, &jwt_sn).await, "No such scope");
    // An app's own client can't open sessions in the shared-only scope.
    let (so, jwt_so) = env.new_session(APP_A, USER_SUB, &scope_s, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &so, &jwt_so).await, "Token is for another app");

    // SetAllowShared only enables; disabling has its own immediate method.
    expect_failure(
        tx(env.alice.call(signer, "propose_change").args_json(json!({"scope_id": env.scope_a, "auth": "Near", "change": {"SetAllowShared": {"allow": false}}, "client_proof": null})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "SetAllowShared can only enable shared login",
    );
    let set_allow = json!({"SetAllowShared": {"allow": true}});
    expect_failure(
        tx(env.carol.call(signer, "propose_change").args_json(json!({"scope_id": scope_s, "auth": "Near", "change": set_allow, "client_proof": null})).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await),
        "Shared login is already enabled",
    );
    // Scope A enables shared login through a timelocked change (alice is its NEAR owner).
    let change_id: u64 = env
        .alice
        .call(signer, "propose_change")
        .args_json(json!({"scope_id": env.scope_a, "auth": "Near", "change": set_allow, "client_proof": null}))
        .deposit(NearToken::from_millinear(10))
        .gas(GAS)
        .transact()
        .await?
        .into_result()?
        .json()?;
    let pending = env.get_scope(&env.scope_a).await?["pending"].clone();
    assert_eq!(pending[0]["change"], set_allow);
    let unlock = pending[0]["unlock_at_ms"].as_u64().unwrap();
    expect_failure(
        tx(env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(api_gas("execute_change")).transact().await),
        "Change is still timelocked",
    );
    expect_failure(env.create_session(&env.relayer_fc, &sa0, &jwt_sa0).await, "Scope does not allow shared login");
    env.advance_to(unlock + 1).await?;
    env.relayer_owner_fc.call(signer, "execute_change").args_json(json!({"scope_id": env.scope_a, "change_id": change_id})).gas(api_gas("execute_change")).transact().await?.into_result()?;
    assert_eq!(env.get_scope(&env.scope_a).await?["allow_shared"], json!(true));

    // Same sub via the shared client and via app A's own client into scope A: the SAME path.
    let (mut sa_shared, jwt_shared) = env.new_session(SHARED, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let v_shared: SessionView = env.create_session(&env.relayer_fc, &sa_shared, &jwt_shared).await?.into_result()?.json()?;
    let (mut sa_own, jwt_own) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let v_own: SessionView = env.create_session(&env.relayer_fc, &sa_own, &jwt_own).await?.into_result()?.json()?;
    let path_a = format!("{}#google#{USER_SUB}#0", env.scope_a);
    assert_eq!(v_shared.path, path_a);
    assert_eq!(v_own.path, path_a);
    // Same sub via the shared client into scopes S and A: DIFFERENT paths.
    assert_ne!(path_s, path_a);

    // The MPC sees exactly those paths.
    for s in [&mut ss, &mut sa_shared, &mut sa_own] {
        env.relayer_fc.call(signer, "derive_key").args_json(s.derive_args("bls12381g1:p1", "bls12381g2:p2")).gas(api_gas("derive_key")).transact().await?.into_result()?;
    }
    let paths: Vec<String> = env.mpc_calls().await?.into_iter().map(|c| c.derivation_path).collect();
    assert_eq!(paths, vec![path_s.clone(), path_a.clone(), path_a.clone()]);

    // The nonce commits to scope_id: a shared token for scope S can't open a session in scope A (both allow shared).
    let (s_for_s, jwt_for_s) = env.new_session(SHARED, USER_SUB, &scope_s, 0, 600_000).await?;
    let mut moved = TestSession::new(&env.scope_a, s_for_s.expires_at_ms, 0, s_for_s.max_uses);
    moved.key = s_for_s.key.clone();
    expect_failure(env.create_session(&env.relayer_fc, &moved, &jwt_for_s).await, "Token nonce doesn't commit to this session");

    // Last-client rules: a scope with clients and allow_shared may drop its last client...
    let scope_t = env.admin_register(vec![near_owner(env.carol.id())], &[APP_C], true).await?;
    env.carol.call(signer, "remove_client").args_json(json!({"scope_id": scope_t, "auth": "Near", "provider": PROVIDER, "aud": APP_C})).gas(GAS).transact().await?.into_result()?;
    assert_eq!(env.get_scope(&scope_t).await?["clients"], json!([]));
    // ...after which shared login can't be disabled (it would leave no way in).
    expect_failure(tx(env.carol.call(signer, "disable_shared_login").args_json(json!({"scope_id": scope_t, "auth": "Near"})).gas(GAS).transact().await), "Cannot disable shared login: the scope has no clients");
    expect_failure(tx(env.carol.call(signer, "disable_shared_login").args_json(json!({"scope_id": scope_s, "auth": "Near"})).gas(GAS).transact().await), "Cannot disable shared login: the scope has no clients");
    assert_eq!(env.get_scope(&scope_s).await?["allow_shared"], json!(true));
    // Without allow_shared the last client stays.
    expect_failure(tx(env.bob.call(signer, "remove_client").args_json(json!({"scope_id": env.scope_b, "auth": "Near", "provider": PROVIDER, "aud": APP_B})).gas(GAS).transact().await), "Cannot remove the last client of a scope without shared login");
    expect_failure(tx(env.bob.call(signer, "disable_shared_login").args_json(json!({"scope_id": env.scope_b, "auth": "Near"})).gas(GAS).transact().await), "Shared login is not enabled");

    // Disabling shared login is immediate and owner-only. Through the owner pool with an OIDC owner it would need a
    // console token; here alice (NEAR owner) calls directly.
    expect_failure(tx(env.bob.call(signer, "disable_shared_login").args_json(json!({"scope_id": env.scope_a, "auth": "Near"})).gas(GAS).transact().await), "Caller is not a NEAR owner of this scope");
    env.alice.call(signer, "disable_shared_login").args_json(json!({"scope_id": env.scope_a, "auth": "Near"})).gas(GAS).transact().await?.into_result()?;
    assert_eq!(env.get_scope(&env.scope_a).await?["allow_shared"], json!(false));
    let (sd, jwt_sd) = env.new_session(SHARED, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sd, &jwt_sd).await, "Scope does not allow shared login");
    // The app's own client still works.
    let (so2, jwt_so2) = env.new_session(APP_A, USER_SUB, &env.scope_a, 1, 600_000).await?;
    env.create_session(&env.relayer_fc, &so2, &jwt_so2).await?.into_result()?;

    // Removing a shared client applies at once.
    env.set_shared_clients(&[]).await?.into_result()?;
    let config = env.get_config().await?;
    assert_eq!((config["shared_clients"].clone(), config["pending_shared_clients"].clone()), (json!([]), json!([])));
    let (sr, jwt_sr) = env.new_session(SHARED, USER_SUB, &scope_s, 0, 600_000).await?;
    expect_failure(env.create_session(&env.relayer_fc, &sr, &jwt_sr).await, "Token is for an unregistered app");
    Ok(())
}

/// The unlock time of a pending shared-client addition of `aud`, as shown by get_config.
fn pending_shared_unlock(config: &Value, aud: &str) -> Option<u64> {
    let pending = config.get("pending_shared_clients")?;
    let entries: Vec<&Value> = match pending {
        Value::Array(a) => a.iter().collect(),
        Value::Null => vec![],
        other => vec![other],
    };
    for e in entries {
        if e.to_string().contains(aud) {
            return ["unlock_at_ms", "effective_at_ms"].iter().find_map(|k| e.get(*k).and_then(Value::as_u64));
        }
    }
    None
}

/// Every proof commits to the deployment (`current_account_id`): the same token, args and scope ids on a second
/// hana-signer are rejected. Covers the session nonce, client proof, owner-action nonce and register proof.
#[tokio::test]
async fn cross_deployment_replay_rejected() -> Result<()> {
    let env = Env::setup().await?;
    let main = env.signer.id().clone();
    let other = env.deploy_another_signer("signer2").await?;
    let oid = other.id().clone();

    // Same registrations in the same order on both, so the scope ids (and action nonces) coincide.
    let a2 = env.admin_register_on(&oid, vec![near_owner(env.alice.id())], &[APP_A], false).await?;
    let b2 = env.admin_register_on(&oid, vec![near_owner(env.bob.id())], &[APP_B], false).await?;
    assert_eq!((a2.as_str(), b2.as_str()), (env.scope_a.as_str(), env.scope_b.as_str()));
    let oidc_owners = vec![oidc_owner(OWNER_SUB)];
    let c1 = env.admin_register_on(&main, oidc_owners.clone(), &[APP_C, APP_D], false).await?;
    let c2 = env.admin_register_on(&oid, oidc_owners.clone(), &[APP_C, APP_D], false).await?;
    assert_eq!(c1, c2);

    // Session nonce: a token for the main deployment fails on the other, then works on main.
    let (s, jwt) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    expect_failure(tx(env.alice.call(&oid, "create_session").args_json(s.create_args(&oid, &jwt)).gas(GAS).transact().await), "Token nonce doesn't commit to this session");
    env.create_session(&env.relayer_fc, &s, &jwt).await?.into_result()?;
    // Control: a token made for the other deployment works there.
    let (s2, _) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let jwt2 = env.jwt(APP_A, USER_SUB, Some(&s2.nonce(&oid))).await?;
    let v: SessionView = env.alice.call(&oid, "create_session").args_json(s2.create_args(&oid, &jwt2)).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(v.path, format!("{}#google#{USER_SUB}#0", env.scope_a));

    // Client proof (alice adds APP_E to scope A): the proof for main fails on the other.
    let nonce_main = env.get_scope(&env.scope_a).await?["action_nonce"].as_u64().unwrap();
    let nonce_other = other.view("get_scope").args_json(json!({"scope_id": a2})).await?.json::<Value>()?["action_nonce"].as_u64().unwrap();
    assert_eq!(nonce_main, nonce_other);
    let proof = env.jwt(APP_E, OWNER_SUB, Some(&client_proof_nonce(main.as_str(), &env.scope_a, nonce_main))).await?;
    let propose = json!({"scope_id": env.scope_a, "auth": "Near", "change": {"AddClient": {"provider": PROVIDER, "aud": APP_E}}, "client_proof": proof});
    expect_failure(tx(env.alice.call(&oid, "propose_change").args_json(propose.clone()).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await), "Client proof nonce doesn't match");
    env.alice.call(&main, "propose_change").args_json(propose).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await?.into_result()?;

    // Owner-action nonce (OIDC owner removes APP_D from scope C): the console token for main fails on the other.
    let action_nonce = env.get_scope(&c1).await?["action_nonce"].as_u64().unwrap();
    let mut args = borsh_str(&c1);
    args.extend(borsh_str(PROVIDER));
    args.extend(borsh_str(APP_D));
    let console_jwt = env.jwt(CONSOLE, OWNER_SUB, Some(&owner_action_nonce(main.as_str(), &c1, "remove_client", &args, action_nonce))).await?;
    let remove = json!({"scope_id": c1, "auth": {"Oidc": {"jwt": console_jwt}}, "provider": PROVIDER, "aud": APP_D});
    expect_failure(tx(env.alice.call(&oid, "remove_client").args_json(remove.clone()).gas(GAS).transact().await), "Owner token nonce doesn't match");
    env.relayer_owner_fc.call(&main, "remove_client").args_json(remove).gas(api_gas("remove_client")).transact().await?.into_result()?;
    assert_eq!(env.scope_for_client(APP_D).await?, None);
    let still: Option<String> = other.view("scope_for_client").args_json(json!({"provider": PROVIDER, "aud": APP_D})).await?.json()?;
    assert_eq!(still.as_deref(), Some(c2.as_str()));

    // Register proof: with public registration on both, a proof made for main fails on the other.
    for signer in [&main, &oid] {
        env.admin.call(signer, "enable_public_registration").transact().await?.into_result()?;
    }
    let owners = vec![near_owner(env.carol.id())];
    let clients = [(PROVIDER, APP_X)];
    let proof_main = env.jwt(APP_X, OWNER_SUB, Some(&register_nonce(main.as_str(), &owners, &clients, false))).await?;
    let reg = json!({"owners": owners, "client_proofs": [proof_main], "allow_shared": false});
    expect_failure(tx(env.carol.call(&oid, "register_scope").args_json(reg.clone()).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await), "Proof nonce doesn't commit to this registration");
    let id: String = env.carol.call(&main, "register_scope").args_json(reg).deposit(NearToken::from_millinear(10)).gas(GAS).transact().await?.into_result()?.json()?;
    assert_eq!(env.scope_for_client(APP_X).await?.as_deref(), Some(id.as_str()));
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// One-transaction login: create_session_and_derive (docs/batch-b-spec.md "Contract changes")

const PK1: &str = "bls12381g1:pk1-login";
const PK2: &str = "bls12381g2:pk2-login";

/// Through the session pool's key with the API's gas, the combined call opens a session with used = 1 and returns
/// the MPC's answer unchanged: the same key a create_session + derive_key gives. A replay fails; a bad derive half
/// reverts the session insert; key_index 2^31 and above is reserved.
#[tokio::test]
async fn combined_login_matches_create_then_derive() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let path = format!("{}#google#{}#0", env.scope_a, USER_SUB);

    let (mut s, jwt) = env.new_session_with_uses(APP_A, USER_SUB, &env.scope_a, 0, 1, 600_000).await?;
    let args = s.login_args(&jwt, PK1, PK2);
    let outcome = env.login(&env.relayer_fc, &args).await?;
    println!("create_session_and_derive gas burnt (with mock MPC): {} Tgas", outcome.total_gas_burnt.as_tgas());
    assert!(outcome.total_gas_burnt <= api_gas("create_session_and_derive"), "burnt {} Tgas", outcome.total_gas_burnt.as_tgas());
    let response: CkdResponse = outcome.into_result()?.json()?;
    assert_eq!(response, env.expected_ckd(&path, PK1, PK2).await?, "the MPC's answer must come back unchanged");
    assert_eq!(env.get_session(&s).await?, Some(SessionView { path: path.clone(), scope_id: env.scope_a.clone(), expires_at_ms: s.expires_at_ms, max_uses: 1, used: 1 }));

    // The same user through create_session then derive_key (another session key, same BLS key): same request, same key.
    let (mut split, jwt_split) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    let created: SessionView = env.create_session(&env.relayer_fc, &split, &jwt_split).await?.into_result()?.json()?;
    assert_eq!(created.path, path);
    let split_response: CkdResponse =
        env.relayer_fc.call(signer, "derive_key").args_json(split.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await?.into_result()?.json()?;
    assert_eq!(split_response, response);
    let calls = env.mpc_calls().await?;
    assert_eq!(calls.len(), 2);
    for call in &calls {
        assert_eq!((call.derivation_path.as_str(), &call.predecessor, call.domain_id, call.deposit.as_str()), (path.as_str(), signer, CKD_DOMAIN_ID, "1"));
        assert_eq!((call.pk1.as_str(), call.pk2.as_str()), (PK1, PK2));
    }

    // Replaying the transaction fails before the MPC, and the session's one use is not spent twice.
    expect_failure(env.login(&env.relayer_fc, &args).await, "Session key already in use");
    // With max_uses = 1 nothing can derive any more.
    expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(s.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await), "Session use limit reached");
    assert_eq!(env.mpc_calls().await?.len(), 2);

    // A panic in the derive half (here a signature over counter 2) reverts the whole call: no session is left, and
    // the same token then logs in.
    let (mut bad, jwt_bad) = env.new_session_with_uses(APP_A, USER_SUB, &env.scope_a, 0, 1, 600_000).await?;
    let mut wrong_counter = bad.login_args(&jwt_bad, PK1, PK2);
    wrong_counter["signature"] = json!(bad.key.sign(&session_message(2, &ckd_payload(PK1, PK2))).to_bytes().to_vec());
    expect_failure(env.login(&env.relayer_fc, &wrong_counter).await, "Invalid session signature");
    assert_eq!(env.get_session(&bad).await?, None);
    assert!(!env.session_key_in_use(&bad).await?);
    let mut oversize = bad.login_args(&jwt_bad, PK1, PK2);
    oversize["pk2"] = json!(format!("bls12381g2:{}", "B".repeat(502)));
    expect_failure(env.login(&env.relayer_fc, &oversize).await, "BLS key too long");
    assert!(!env.session_key_in_use(&bad).await?);
    assert_eq!(env.mpc_calls().await?.len(), 2, "reverted calls never reach the MPC");
    env.login(&env.relayer_fc, &bad.login_args(&jwt_bad, PK1, PK2)).await?.into_result()?;
    assert_eq!(env.get_session(&bad).await?.unwrap().used, 1);

    // key_index: 2^31 - 1 is the last one create_session accepts; 2^31 and u32::MAX are reserved, even with a
    // token whose nonce commits to them.
    let (last, jwt_last) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0x7fff_ffff, 600_000).await?;
    let created: SessionView = env.create_session(&env.relayer_fc, &last, &jwt_last).await?.into_result()?.json()?;
    assert_eq!(created.path, format!("{}#google#{}#2147483647", env.scope_a, USER_SUB));
    for key_index in [0x8000_0000u32, u32::MAX] {
        let (mut reserved, jwt_reserved) = env.new_session(APP_A, USER_SUB, &env.scope_a, key_index, 600_000).await?;
        expect_failure(env.create_session(&env.relayer_fc, &reserved, &jwt_reserved).await, "key_index must be below 2^31");
        expect_failure(env.login(&env.relayer_fc, &reserved.login_args(&jwt_reserved, PK1, PK2)).await, "key_index must be below 2^31");
        assert!(!env.session_key_in_use(&reserved).await?);
    }

    // A vault message (off-chain, batch B) signed by a session key is neither a derive nor a revoke: the vault's
    // "unlock", and its "revoke", whose payload bytes and counter shape match revoke_session's.
    let (mut v, jwt_v) = env.new_session(APP_A, USER_SUB, &env.scope_a, 0, 600_000).await?;
    env.create_session(&env.relayer_fc, &v, &jwt_v).await?.into_result()?;
    for payload in [&b"unlock"[..], &b"revoke"[..]] {
        let vault_sig = v.key.sign(&vault_message(signer.as_str(), "app_test", &[7; 16], 1, payload)).to_bytes().to_vec();
        v.counter = 0;
        let mut derive = v.derive_args(PK1, PK2);
        derive["signature"] = json!(vault_sig);
        expect_failure(tx(env.relayer_fc.call(signer, "derive_key").args_json(derive).gas(api_gas("derive_key")).transact().await), "Invalid session signature");
        v.counter = 0;
        let mut revoke = v.revoke_args();
        revoke["signature"] = json!(vault_sig);
        expect_failure(tx(env.relayer_fc.call(signer, "revoke_session").args_json(revoke).gas(api_gas("revoke_session")).transact().await), "Invalid session signature");
        assert_eq!(env.get_session(&v).await?.unwrap().used, 0);
    }
    Ok(())
}

/// Someone who sees the token (the API, the mempool) can front-run the login, but never derives for themselves:
/// - a front-run create_session: the vault's combined call fails "Session key already in use", and it recovers with
///   derive_key at counter 1 (`max_uses = 1`), or counter 1 and then its spare counter 2 (`max_uses = 2`);
/// - a front-run replay of the whole combined call: with `max_uses = 1` the replay burns the only use
///   (`session_consumed`, a new login); with `max_uses = 2` the vault recovers with counter 2.
#[tokio::test]
async fn combined_login_front_running() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let path = format!("{}#google#{}#0", env.scope_a, USER_SUB);
    let expected = env.expected_ckd(&path, PK1, PK2).await?;
    let derive = |s: &mut TestSession| env.relayer_fc.call(signer, "derive_key").args_json(s.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact();

    for max_uses in [1u32, 2] {
        // Front-run create_session (by another account, with its own key).
        let (mut s, jwt) = env.new_session_with_uses(APP_A, USER_SUB, &env.scope_a, 0, max_uses, 600_000).await?;
        env.alice.call(signer, "create_session").args_json(s.create_args(signer, &jwt)).gas(GAS).transact().await?.into_result()?;
        expect_failure(env.login(&env.relayer_fc, &s.login_args(&jwt, PK1, PK2)).await, "Session key already in use");
        let synced = env.get_session(&s).await?.unwrap();
        assert_eq!((synced.path.as_str(), synced.used, synced.max_uses), (path.as_str(), 0, max_uses));
        s.counter = u64::from(synced.used);
        let response: CkdResponse = derive(&mut s).await?.into_result()?.json()?;
        assert_eq!(response, expected);
        if max_uses == 2 {
            let response: CkdResponse = derive(&mut s).await?.into_result()?.json()?;
            assert_eq!(response, expected);
        }
        expect_failure(tx(derive(&mut s).await), "Session use limit reached");

        // Front-run replay of the whole combined call (the attacker pays; the answer is encrypted to the vault's key).
        let (mut s, jwt) = env.new_session_with_uses(APP_A, USER_SUB, &env.scope_a, 0, max_uses, 600_000).await?;
        let args = s.login_args(&jwt, PK1, PK2);
        let stolen: CkdResponse = env.alice.call(signer, "create_session_and_derive").args_json(args.clone()).gas(GAS).transact().await?.into_result()?.json()?;
        assert_eq!(stolen, expected, "the replay only ever gets the answer for the vault's own BLS key");
        expect_failure(env.login(&env.relayer_fc, &args).await, "Session key already in use");
        let synced = env.get_session(&s).await?.unwrap();
        assert_eq!((synced.used, synced.max_uses), (1, max_uses));
        if max_uses == 1 {
            // used == max_uses: the vault reports session_consumed and starts a new login.
            expect_failure(tx(derive(&mut s).await), "Session use limit reached");
        } else {
            s.counter = u64::from(synced.used);
            let response: CkdResponse = derive(&mut s).await?.into_result()?.json()?;
            assert_eq!(response, expected);
            assert_eq!(env.get_session(&s).await?.unwrap().used, 2);
        }
    }
    Ok(())
}

/// When the MPC receipt fails, the signer's receipt has already committed: the session stays with used = 1. A
/// two-use session retries with derive_key at counter 2; a one-use session can't (a new login).
#[tokio::test]
async fn combined_login_mpc_failure_keeps_the_session() -> Result<()> {
    let env = Env::setup().await?;
    let signer = env.signer.id();
    let path = format!("{}#google#{}#0", env.scope_a, USER_SUB);

    // Only the mock's own account flips the switch.
    expect_failure(tx(env.alice.call(env.mpc.id(), "set_fail").args_json(json!({"fail": true})).transact().await), "Only the mock's account");
    env.set_mpc_fail(true).await?;
    let fails: bool = env.mpc.view("fails").await?.json()?;
    assert!(fails);

    for max_uses in [2u32, 1] {
        let (mut s, jwt) = env.new_session_with_uses(APP_A, USER_SUB, &env.scope_a, 0, max_uses, 600_000).await?;
        let outcome = env.login(&env.relayer_fc, &s.login_args(&jwt, PK1, PK2)).await?;
        let failures: Vec<&str> = outcome.receipt_failures().iter().map(|o| o.executor_id.as_str()).collect();
        assert_eq!(failures, vec![env.mpc.id().as_str()], "only the MPC receipt fails");
        expect_failure(Ok(outcome), "Mock MPC failure");
        assert_eq!(env.get_session(&s).await?.unwrap().used, 1);

        env.set_mpc_fail(false).await?;
        let retry = env.relayer_fc.call(signer, "derive_key").args_json(s.derive_args(PK1, PK2)).gas(api_gas("derive_key")).transact().await;
        if max_uses == 2 {
            let response: CkdResponse = retry?.into_result()?.json()?;
            assert_eq!(response, env.expected_ckd(&path, PK1, PK2).await?);
            assert_eq!(env.get_session(&s).await?.unwrap().used, 2);
            env.set_mpc_fail(true).await?;
        } else {
            expect_failure(tx(retry), "Session use limit reached");
        }
    }
    assert_eq!(env.mpc_calls().await?.len(), 1, "only the successful retry is recorded");
    Ok(())
}
