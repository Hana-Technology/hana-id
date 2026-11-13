//! Sandbox tests of the Journear Passport stamps contract `hana-stamps` (the wasm `deploy-stamps` deploys).
//!
//!   cd contracts/integration-tests && cargo test --test stamps -- --nocapture
//!
//! The demo's paths on a real node: a user's implicit account with no balance signs NEP-366 delegate actions calling
//! `collect` and a relayer wraps them in its own transactions (`common::meta`, D742) for `arrival`, `sponsored`,
//! `signature`, `postcard` and `layover`; the same user, once funded, signs `own_fare` itself. `sponsored` is accepted
//! only through the real delegate action and `own_fare` only from the user's own transaction. The layover runs on the
//! sandbox's clock (fast-forward). Every `collect` attaches exactly the relay's gas cap on sandbox-dev
//! (`near.relay.maxGasTgas` = 10) and the gas each one burns is printed (and asserted under the cap).

mod common;

use anyhow::{bail, Context, Result};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use common::meta::{crypto_key, first_failure, implicit_id, receipts_on, Rpc};
use common::{advance_to, stamps_wasm};
use near_primitives::transaction::{Action, FunctionCallAction, TransferAction};
use near_primitives::views::FinalExecutionOutcomeView;
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::result::ExecutionFinalResult;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

/// The relay's cap on sandbox-dev (`envs/sandbox-dev.json` `near.relay.maxGasTgas`): the gas all inner calls of one
/// delegate may attach together. Every collect here attaches exactly this, so a success proves it fits.
const CAP_TGAS: u64 = 10;
const TGAS: f64 = 1e12;
const LAYOVER_MS: u64 = 120_000;

struct Office {
    worker: Worker<Sandbox>,
    root: Account,
    contract: Contract,
}

/// A sandbox with the stamps contract deployed and initialised in one transaction, as deploy-stamps does.
async fn setup() -> Result<Office> {
    let wasm = stamps_wasm()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let account = root.create_subaccount("stamps").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    account.batch(account.id()).deploy(&wasm).call(Function::new("new").args_json(json!({})).gas(Gas::from_tgas(30))).transact().await?.into_result()?;
    let contract = Contract::from_secret_key(account.id().clone(), account.secret_key().clone(), &worker);
    Ok(Office { worker, root, contract })
}

impl Office {
    async fn named(&self, name: &str, near: u128) -> Result<Account> {
        Ok(self.root.create_subaccount(name).initial_balance(NearToken::from_near(near)).transact().await?.into_result()?)
    }

    async fn passport(&self, account: &AccountId) -> Result<Value> {
        Ok(self.contract.view("get_passport").args_json(json!({ "account_id": account })).await?.json()?)
    }

    async fn recent(&self, args: Value) -> Result<Value> {
        Ok(self.contract.view("recent").args_json(args).await?.json()?)
    }

    async fn totals(&self) -> Result<Value> {
        Ok(self.contract.view("totals").await?.json()?)
    }

    async fn balance(&self, account: &AccountId) -> Result<u128> {
        Ok(self.worker.view_account(account).await?.balance.as_yoctonear())
    }
}

/// An implicit account with no balance, created by the relayer's zero transfer (the relay's activation, D731).
async fn activated(o: &Office, rpc: &Rpc, relayer: &Account) -> Result<(AccountId, SecretKey)> {
    let sk = SecretKey::from_random(KeyType::ED25519);
    let id = implicit_id(&sk);
    let out = rpc.send(relayer.id(), relayer.secret_key(), &id, vec![Action::Transfer(TransferAction { deposit: NearToken::from_yoctonear(0) })]).await?;
    assert_eq!(first_failure(&out), None);
    assert_eq!(o.balance(&id).await?, 0);
    Ok((id, sk))
}

fn collect_args(stamp: &str, note: Option<&str>, proof: Option<&Value>) -> Value {
    let mut args = json!({ "stamp": stamp });
    if let Some(n) = note {
        args["note"] = json!(n);
    }
    if let Some(p) = proof {
        args["proof"] = p.clone();
    }
    args
}

/// The FunctionCall a delegate action carries: `collect` with the relay's cap attached, no deposit.
fn collect_action(args: &Value) -> Action {
    Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "collect".to_string(),
        args: serde_json::to_vec(args).unwrap(),
        gas: near_primitives::types::Gas::from_teragas(CAP_TGAS),
        deposit: NearToken::from_yoctonear(0),
    }))
}

/// One relayed collect: the user signs the delegate action, the relayer sends it. Returns the outcome.
async fn relay_collect(o: &Office, rpc: &Rpc, relayer: &Account, user: &AccountId, sk: &SecretKey, args: Value) -> Result<FinalExecutionOutcomeView> {
    let signed = rpc.sign_delegate(user, sk, o.contract.id(), vec![collect_action(&args)]).await?;
    rpc.relay(relayer, signed).await
}

/// Gas burnt by the receipt that ran `collect` on the contract (one receipt per relayed call).
fn collect_burnt(o: &Office, out: &FinalExecutionOutcomeView) -> f64 {
    let on = receipts_on(out, o.contract.id());
    assert_eq!(on.len(), 1, "one collect receipt");
    on[0].outcome.gas_burnt.as_gas() as f64 / TGAS
}

fn total_burnt(out: &FinalExecutionOutcomeView) -> f64 {
    (out.transaction_outcome.outcome.gas_burnt.as_gas() + out.receipts_outcome.iter().map(|r| r.outcome.gas_burnt.as_gas()).sum::<u64>()) as f64 / TGAS
}

/// The relayed collect must have succeeded; returns the collect receipt's gas.
fn ok_burnt(o: &Office, what: &str, out: &FinalExecutionOutcomeView) -> f64 {
    assert_eq!(first_failure(out), None, "{what}");
    let burnt = collect_burnt(o, out);
    assert!(burnt < CAP_TGAS as f64, "{what} burnt {burnt} Tgas, over the relay's cap");
    burnt
}

/// The relayed collect must have failed in the contract with `err` (the relayer's transaction itself succeeds).
fn refused(out: &FinalExecutionOutcomeView, err: &str) {
    let why = first_failure(out).unwrap_or_else(|| panic!("expected {err}, the call succeeded"));
    assert!(why.contains(err), "expected {err}: {why}");
}

/// A direct call (the caller signs and pays), with the relay's cap attached.
async fn direct(o: &Office, caller: &Account, args: Value) -> Result<ExecutionFinalResult> {
    Ok(caller.call(o.contract.id(), "collect").args_json(args).gas(Gas::from_tgas(CAP_TGAS)).transact().await?)
}

fn direct_failure(out: &ExecutionFinalResult) -> String {
    format!("{:?}", out.clone().into_result().expect_err("expected a failure"))
}

fn direct_burnt(o: &Office, out: &ExecutionFinalResult) -> f64 {
    let on: Vec<_> = out.receipt_outcomes().iter().filter(|r| &r.executor_id == o.contract.id()).collect();
    assert_eq!(on.len(), 1);
    on[0].gas_burnt.as_gas() as f64 / TGAS
}

/// The `signature` stamp's proof, built here independently of the contract (NEP-413: sha256 of u32le(2^31 + 413) and
/// the borsh payload with no callback URL), signed with the user's key as the vault would.
fn nep413_proof(sk: &SecretKey, account: &AccountId, recipient: &AccountId, nonce: [u8; 32]) -> Value {
    let message = format!("Stamp my passport: {account}");
    let string = |b: &mut Vec<u8>, s: &str| {
        b.extend((s.len() as u32).to_le_bytes());
        b.extend(s.as_bytes());
    };
    let mut bytes = (2u32.pow(31) + 413).to_le_bytes().to_vec();
    string(&mut bytes, &message);
    bytes.extend(nonce);
    string(&mut bytes, recipient.as_str());
    bytes.push(0); // callback_url: None
    let near_crypto::Signature::ED25519(sig) = crypto_key(sk).sign(&Sha256::digest(&bytes)) else { unreachable!("an ed25519 key") };
    json!({ "message": message, "nonce": B64.encode(nonce), "recipient": recipient, "signature": B64.encode(sig.to_bytes()) })
}

#[tokio::test]
async fn stamps_the_full_passport_relayed_and_direct_with_gas() -> Result<()> {
    let o = setup().await?;
    let rpc = Rpc::new(&o.worker);
    let relayer = o.named("relayer", 20).await?;
    let (user, sk) = activated(&o, &rpc, &relayer).await?;
    assert_eq!(o.passport(&user).await?, Value::Null);
    let mut gas: Vec<(&str, f64, f64)> = vec![];

    // arrival, relayed: the predecessor is the user, the signer the relayer, so it is marked sponsored.
    let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("arrival", None, None)).await?;
    gas.push(("arrival", ok_burnt(&o, "arrival", &out), total_burnt(&out)));
    let passport = o.passport(&user).await?;
    assert_eq!(passport["account_id"], json!(user));
    let arrived_ms = passport["stamps"][0]["block_timestamp_ms"].as_u64().context("timestamp")?;
    assert_eq!(passport["stamps"], json!([{ "stamp": "arrival", "block_timestamp_ms": arrived_ms, "sponsored": true }]));
    assert_eq!(o.passport(relayer.id()).await?, Value::Null, "the relayer has no passport");

    // layover right away: too soon (the sandbox clock is real time until fast-forwarded).
    refused(&relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("layover", None, None)).await?, "ERR_TOO_SOON");

    // sponsored: accepted through the real delegate action.
    let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("sponsored", None, None)).await?;
    gas.push(("sponsored", ok_burnt(&o, "sponsored", &out), total_burnt(&out)));

    // own_fare through the relay: refused (someone else paid).
    refused(&relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("own_fare", None, None)).await?, "ERR_NOT_OWN_FARE");

    // signature: a NEP-413 signature by the user's key, verified on chain.
    let proof = nep413_proof(&sk, &user, o.contract.id(), [7; 32]);
    let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("signature", None, Some(&proof))).await?;
    gas.push(("signature", ok_burnt(&o, "signature", &out), total_burnt(&out)));

    // postcard with the largest note: 140 four-byte characters.
    let note = "🌸".repeat(140);
    let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("postcard", Some(&format!("  {note} ")), None)).await?;
    gas.push(("postcard", ok_burnt(&o, "postcard (140 four-byte characters)", &out), total_burnt(&out)));

    // Five relayed calls and the user still holds nothing.
    assert_eq!(o.balance(&user).await?, 0);

    // layover after 120 s of block time.
    advance_to(&o.worker, arrived_ms + LAYOVER_MS).await?;
    let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("layover", None, None)).await?;
    gas.push(("layover", ok_burnt(&o, "layover", &out), total_burnt(&out)));

    // own_fare: the user, now holding testnet NEAR, signs and pays for the transaction itself.
    o.root.transfer_near(&user, NearToken::from_near(1)).await?.into_result()?;
    let traveller = Account::from_secret_key(user.clone(), sk.clone(), &o.worker);
    let out = direct(&o, &traveller, collect_args("own_fare", None, None)).await?;
    let own = direct_burnt(&o, &out);
    let own_total = out.total_gas_burnt.as_gas() as f64 / TGAS;
    let view: Value = out.into_result()?.json()?;
    assert_eq!(view["stamp"], "own_fare");
    assert_eq!(view["sponsored"], false);
    assert!(own < CAP_TGAS as f64);
    gas.push(("own_fare (direct)", own, own_total));

    // The whole passport, in the order collected; sponsored = relayed; the note trimmed.
    let p = o.passport(&user).await?;
    let stamps = p["stamps"].as_array().context("stamps")?;
    let ids: Vec<&str> = stamps.iter().map(|s| s["stamp"].as_str().unwrap()).collect();
    assert_eq!(ids, ["arrival", "sponsored", "signature", "postcard", "layover", "own_fare"]);
    let sponsored: Vec<bool> = stamps.iter().map(|s| s["sponsored"].as_bool().unwrap()).collect();
    assert_eq!(sponsored, [true, true, true, true, true, false]);
    assert_eq!(stamps[3]["note"], json!(note));
    assert!(stamps.iter().enumerate().all(|(i, s)| (i == 3) == s.get("note").is_some()), "only the postcard has a note");
    assert!(stamps[4]["block_timestamp_ms"].as_u64().unwrap() >= arrived_ms + LAYOVER_MS);
    assert_eq!(o.totals().await?, json!({ "passports": 1, "stamps": 6 }));
    let recent = o.recent(json!({})).await?;
    let recent_ids: Vec<&str> = recent.as_array().unwrap().iter().map(|r| r["stamp"].as_str().unwrap()).collect();
    assert_eq!(recent_ids, ["own_fare", "layover", "postcard", "signature", "sponsored", "arrival"]);
    assert_eq!(recent[0], json!({ "account_id": user, "stamp": "own_fare", "block_timestamp_ms": stamps[5]["block_timestamp_ms"] }));
    assert_eq!(o.recent(json!({ "from_index": 4, "limit": 1 })).await?.as_array().unwrap().len(), 1);
    // Everything again: each at most once.
    refused(&relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("arrival", None, None)).await?, "ERR_ALREADY");
    assert!(direct_failure(&direct(&o, &traveller, collect_args("own_fare", None, None)).await?).contains("ERR_ALREADY"));

    println!("collect gas, {CAP_TGAS} Tgas attached (the relay's cap on sandbox-dev): collect receipt burnt / whole transaction burnt");
    for (stamp, receipt, whole) in &gas {
        println!("  {stamp:<36} {receipt:.3} Tgas / {whole:.3} Tgas");
    }
    Ok(())
}

#[tokio::test]
async fn stamps_sponsored_and_own_fare_depend_on_who_signed() -> Result<()> {
    let o = setup().await?;
    let rpc = Rpc::new(&o.worker);
    let relayer = o.named("relayer", 20).await?;
    // A named account calling directly: arrival yes, sponsored no (it paid), own_fare yes.
    let alice = o.named("alice", 5).await?;
    assert!(direct_failure(&direct(&o, &alice, collect_args("sponsored", None, None)).await?).contains("ERR_NO_ARRIVAL"));
    let arrival: Value = direct(&o, &alice, collect_args("arrival", None, None)).await?.into_result()?.json()?;
    assert_eq!(arrival["sponsored"], false);
    assert!(direct_failure(&direct(&o, &alice, collect_args("sponsored", None, None)).await?).contains("ERR_NOT_SPONSORED"));
    assert_eq!(direct(&o, &alice, collect_args("own_fare", None, None)).await?.into_result()?.json::<Value>()?["stamp"], "own_fare");
    // A named account can't collect signature, with any proof.
    let (user, sk) = activated(&o, &rpc, &relayer).await?;
    let someone_elses = nep413_proof(&sk, &user, o.contract.id(), [1; 32]);
    assert!(direct_failure(&direct(&o, &alice, collect_args("signature", None, Some(&someone_elses))).await?).contains("ERR_NOT_IMPLICIT"));

    // An implicit account through the relay: sponsored yes, own_fare no.
    refused(&relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("sponsored", None, None)).await?, "ERR_NO_ARRIVAL");
    relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("arrival", None, None)).await.map(|out| assert_eq!(first_failure(&out), None))?;
    refused(&relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("own_fare", None, None)).await?, "ERR_NOT_OWN_FARE");
    relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args("sponsored", None, None)).await.map(|out| assert_eq!(first_failure(&out), None))?;

    // Another implicit account replaying the first one's proof through the relay: refused.
    let (other, other_sk) = activated(&o, &rpc, &relayer).await?;
    relay_collect(&o, &rpc, &relayer, &other, &other_sk, collect_args("arrival", None, None)).await.map(|out| assert_eq!(first_failure(&out), None))?;
    refused(&relay_collect(&o, &rpc, &relayer, &other, &other_sk, collect_args("signature", None, Some(&someone_elses))).await?, "ERR_BAD_PROOF");
    // A proof for another recipient: refused; its own proof: accepted.
    let elsewhere = nep413_proof(&other_sk, &other, relayer.id(), [2; 32]);
    refused(&relay_collect(&o, &rpc, &relayer, &other, &other_sk, collect_args("signature", None, Some(&elsewhere))).await?, "ERR_BAD_PROOF");
    let own = nep413_proof(&other_sk, &other, o.contract.id(), [2; 32]);
    relay_collect(&o, &rpc, &relayer, &other, &other_sk, collect_args("signature", None, Some(&own))).await.map(|out| assert_eq!(first_failure(&out), None))?;
    assert_eq!(o.totals().await?, json!({ "passports": 3, "stamps": 6 }));
    Ok(())
}

#[tokio::test]
async fn stamps_not_payable_no_owner_and_bad_input() -> Result<()> {
    let o = setup().await?;
    let alice = o.named("alice", 5).await?;
    assert_eq!(o.contract.view("catalog").await?.json::<Value>()?, json!(["arrival", "sponsored", "own_fare", "signature", "postcard", "layover"]));
    assert_eq!(o.totals().await?, json!({ "passports": 0, "stamps": 0 }));
    assert_eq!(o.recent(json!({ "limit": 50 })).await?, json!([]));
    // Not payable: a deposit is refused and stays with the caller.
    let paid = alice.call(o.contract.id(), "collect").args_json(collect_args("arrival", None, None)).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(CAP_TGAS)).transact().await?;
    assert!(direct_failure(&paid).contains("doesn't accept deposit"), "{}", direct_failure(&paid));
    // Initialised once, by the deploy.
    let again = alice.call(o.contract.id(), "new").args_json(json!({})).transact().await?;
    assert!(direct_failure(&again).contains("The contract has already been initialized"));
    // No owner or admin method.
    for method in ["set_owner", "reset", "delete_passport", "migrate", "upgrade", "add_stamp"] {
        let r = alice.call(o.contract.id(), method).args_json(json!({})).transact().await?;
        assert!(direct_failure(&r).contains("MethodNotFound"), "{method}: {}", direct_failure(&r));
    }
    for bad in ["", "ARRIVAL", "visa"] {
        assert!(direct_failure(&direct(&o, &alice, collect_args(bad, None, None)).await?).contains("ERR_UNKNOWN_STAMP"), "{bad:?}");
    }
    direct(&o, &alice, collect_args("arrival", None, None)).await?.into_result()?;
    for (note, err) in [(None, "ERR_BAD_NOTE"), (Some("   "), "ERR_BAD_NOTE")] {
        assert!(direct_failure(&direct(&o, &alice, collect_args("postcard", note, None)).await?).contains(err));
    }
    assert!(direct_failure(&direct(&o, &alice, collect_args("postcard", Some(&"x".repeat(141)), None)).await?).contains("ERR_BAD_NOTE"));
    let markup = "<img src=x onerror=alert(1)>";
    let card: Value = direct(&o, &alice, collect_args("postcard", Some(markup), None)).await?.into_result()?.json()?;
    assert_eq!(card["note"], markup, "stored as given: the page renders it as text");
    // Malformed arguments fail to deserialise (no state change).
    let r = alice.call(o.contract.id(), "collect").args_json(json!({ "stamp": 7 })).gas(Gas::from_tgas(CAP_TGAS)).transact().await?;
    assert!(r.clone().into_result().is_err());
    assert_eq!(o.totals().await?, json!({ "passports": 1, "stamps": 2 }));
    Ok(())
}

#[tokio::test]
async fn stamps_gas_with_the_ring_full() -> Result<()> {
    // Fill the ring of 100 recent stamps (34 named accounts × arrival, own_fare, postcard in one transaction each),
    // then measure the costliest stamps replacing the oldest entry.
    let o = setup().await?;
    let rpc = Rpc::new(&o.worker);
    let relayer = o.named("relayer", 20).await?;
    for i in 0..34 {
        let a = o.named(&format!("t{i}"), 2).await?;
        a.batch(o.contract.id())
            .call(Function::new("collect").args_json(collect_args("arrival", None, None)).gas(Gas::from_tgas(CAP_TGAS)))
            .call(Function::new("collect").args_json(collect_args("own_fare", None, None)).gas(Gas::from_tgas(CAP_TGAS)))
            .call(Function::new("collect").args_json(collect_args("postcard", Some(&format!("filler {i}")), None)).gas(Gas::from_tgas(CAP_TGAS)))
            .transact()
            .await?
            .into_result()?;
    }
    assert_eq!(o.totals().await?, json!({ "passports": 34, "stamps": 102 }));
    let storage_full = o.worker.view_account(o.contract.id()).await?.storage_usage;
    let (user, sk) = activated(&o, &rpc, &relayer).await?;
    let mut lines = vec![];
    for (stamp, note, proof) in [
        ("arrival", None, None),
        ("signature", None, Some(nep413_proof(&sk, &user, o.contract.id(), [9; 32]))),
        ("postcard", Some("🌸".repeat(140)), None),
    ] {
        let out = relay_collect(&o, &rpc, &relayer, &user, &sk, collect_args(stamp, note.as_deref(), proof.as_ref())).await?;
        lines.push((stamp, ok_burnt(&o, stamp, &out), total_burnt(&out)));
    }
    let newest = o.recent(json!({ "limit": 1 })).await?;
    assert_eq!(newest[0]["account_id"], json!(user));
    let mut all = o.recent(json!({})).await?.as_array().unwrap().clone();
    all.extend(o.recent(json!({ "from_index": 50 })).await?.as_array().unwrap().clone());
    assert_eq!(all.len(), 100);
    assert_eq!(o.recent(json!({ "from_index": 100 })).await?, json!([]));
    let grew = o.worker.view_account(o.contract.id()).await?.storage_usage - storage_full;
    println!("ring full: the contract account's storage grew {grew} bytes for one passport of three stamps (its ring entries replace the oldest in place)");
    println!("collect gas with the ring full, {CAP_TGAS} Tgas attached: collect receipt burnt / whole transaction burnt");
    for (stamp, receipt, whole) in &lines {
        println!("  {stamp:<36} {receipt:.3} Tgas / {whole:.3} Tgas");
    }
    if lines.iter().any(|(_, r, _)| *r >= CAP_TGAS as f64) {
        bail!("a collect burnt more than the cap");
    }
    Ok(())
}
