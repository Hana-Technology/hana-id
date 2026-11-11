//! Sandbox tests of the hackathon demo contract `hana-guestbook` (the wasm `deploy-guestbook` deploys).
//!
//!   cd contracts/integration-tests && cargo test --test guestbook -- --nocapture
//!
//! The demo's path is the last test: a user's implicit account with no balance signs a NEP-366 delegate action
//! calling `add_message`, and another account (the relayer) wraps it in a transaction and pays the gas.
//! near-workspaces has no Delegate action, so those transactions are built with near-primitives and sent over the
//! sandbox's JSON-RPC (`Rpc` below).

mod common;

use anyhow::{bail, Context, Result};
use common::guestbook_wasm;
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::transaction::{Action, FunctionCallAction, SignedTransaction, Transaction, TransactionV0, TransferAction};
use near_primitives::types::{BlockReference, Finality};
use near_primitives::views::{ExecutionStatusView, FinalExecutionOutcomeView, FinalExecutionStatus, QueryRequest, TxExecutionStatus};
use near_workspaces::network::Sandbox;
use near_workspaces::operations::Function;
use near_workspaces::types::{Gas, KeyType, NearToken, SecretKey};
use near_workspaces::{Account, AccountId, Contract, Worker};
use serde::Deserialize;
use serde_json::json;

/// Gas the tests attach to `add_message` (what a relayer would put in the delegate action's FunctionCall).
const ADD_GAS_TGAS: u64 = 30;
/// `add_message` must burn at most this much (receipt of the call itself, the largest message, ring full): the
/// relayer's bound with a wide margin.
const ADD_BURN_LIMIT_TGAS: u64 = 10;

#[derive(Debug, Deserialize, PartialEq, Clone)]
struct Message {
    index: u64,
    account_id: String,
    text: String,
    block_timestamp_ms: u64,
}

struct Book {
    worker: Worker<Sandbox>,
    root: Account,
    contract: Contract,
}

/// A sandbox with the guestbook deployed and initialised in one transaction, as deploy-guestbook does.
async fn setup() -> Result<Book> {
    let wasm = guestbook_wasm()?;
    let worker = near_workspaces::sandbox().await?;
    let root = worker.root_account()?;
    let account = root.create_subaccount("guestbook").initial_balance(NearToken::from_near(5)).transact().await?.into_result()?;
    account.batch(account.id()).deploy(&wasm).call(Function::new("new").args_json(json!({})).gas(Gas::from_tgas(30))).transact().await?.into_result()?;
    let contract = Contract::from_secret_key(account.id().clone(), account.secret_key().clone(), &worker);
    Ok(Book { worker, root, contract })
}

impl Book {
    async fn user(&self, name: &str) -> Result<Account> {
        Ok(self.root.create_subaccount(name).initial_balance(NearToken::from_near(10)).transact().await?.into_result()?)
    }

    async fn messages(&self, from_index: Option<u64>, limit: Option<u32>) -> Result<Vec<Message>> {
        let mut args = serde_json::Map::new();
        if let Some(f) = from_index {
            args.insert("from_index".into(), json!(f));
        }
        if let Some(l) = limit {
            args.insert("limit".into(), json!(l));
        }
        Ok(self.contract.view("get_messages").args_json(args).await?.json()?)
    }

    async fn total(&self) -> Result<u64> {
        Ok(self.contract.view("total_messages").await?.json()?)
    }

    async fn storage_usage(&self) -> Result<u64> {
        Ok(self.worker.view_account(self.contract.id()).await?.storage_usage)
    }
}

async fn add(caller: &Account, book: &Book, text: &str) -> Result<near_workspaces::result::ExecutionFinalResult> {
    Ok(caller.call(book.contract.id(), "add_message").args_json(json!({ "text": text })).gas(Gas::from_tgas(ADD_GAS_TGAS)).transact().await?)
}

fn failure_text(outcome: &near_workspaces::result::ExecutionFinalResult) -> String {
    format!("{:?}", outcome.clone().into_result().expect_err("expected a failure"))
}

#[tokio::test]
async fn guestbook_add_list_trim_and_limits() -> Result<()> {
    let book = setup().await?;
    let alice = book.user("alice").await?;
    assert_eq!(book.total().await?, 0);
    assert_eq!(book.messages(None, None).await?, vec![]);

    let out = add(&alice, &book, "  hello from the sandbox \n").await?;
    println!("add_message (from a named account) gas burnt in total: {} Tgas", out.total_gas_burnt.as_tgas());
    let added: Message = out.into_result()?.json()?;
    assert_eq!(added.index, 0);
    assert_eq!(added.account_id, alice.id().as_str());
    assert_eq!(added.text, "hello from the sandbox");
    let now = common::now_ms(&book.worker).await?;
    assert!(added.block_timestamp_ms <= now && added.block_timestamp_ms + 60_000 > now, "timestamp {} vs now {now}", added.block_timestamp_ms);
    assert_eq!(book.messages(None, None).await?, vec![added.clone()]);
    assert_eq!(book.total().await?, 1);

    // Length limits in characters after trimming: 200 four-byte characters are accepted, 201 refused, blank refused.
    let emoji = "🌸".repeat(200);
    assert_eq!(add(&alice, &book, &format!("\t{emoji}  ")).await?.into_result()?.json::<Message>()?.text, emoji);
    let long = add(&alice, &book, &"x".repeat(201)).await?;
    assert!(failure_text(&long).contains("Guestbook: text is longer than 200 characters after trimming"), "{}", failure_text(&long));
    for blank in ["", "   ", "\n\t \u{3000}"] {
        let r = add(&alice, &book, blank).await?;
        assert!(failure_text(&r).contains("Guestbook: text is empty after trimming"), "{blank:?}: {}", failure_text(&r));
    }
    // Markup is stored as given (the page renders it as text).
    let markup = "<img src=x onerror=alert(1)>";
    assert_eq!(add(&alice, &book, markup).await?.into_result()?.json::<Message>()?.text, markup);
    assert_eq!(book.total().await?, 3);
    let listed = book.messages(None, None).await?;
    assert_eq!(listed.iter().map(|m| m.index).collect::<Vec<_>>(), [2, 1, 0], "newest first");

    // Not payable: a call with a deposit is refused and keeps the caller's NEAR.
    let paid = alice.call(book.contract.id(), "add_message").args_json(json!({"text": "with a deposit"})).deposit(NearToken::from_yoctonear(1)).gas(Gas::from_tgas(ADD_GAS_TGAS)).transact().await?;
    assert!(failure_text(&paid).contains("doesn't accept deposit"), "{}", failure_text(&paid));
    // Initialised once, by the deploy: `new` again is refused.
    let again = alice.call(book.contract.id(), "new").args_json(json!({})).transact().await?;
    assert!(failure_text(&again).contains("The contract has already been initialized"), "{}", failure_text(&again));
    // No owner or admin method exists.
    for method in ["set_owner", "clear", "delete_message", "migrate", "upgrade"] {
        let r = alice.call(book.contract.id(), method).args_json(json!({})).transact().await?;
        assert!(failure_text(&r).contains("MethodNotFound"), "{method}: {}", failure_text(&r));
    }
    assert_eq!(book.total().await?, 3);

    // Paging: from_index/limit over newest-first, limit capped at 50.
    assert_eq!(book.messages(Some(1), Some(1)).await?.iter().map(|m| m.index).collect::<Vec<_>>(), [1]);
    assert_eq!(book.messages(Some(3), None).await?, vec![]);
    assert_eq!(book.messages(None, Some(1000)).await?.len(), 3);
    Ok(())
}

#[tokio::test]
async fn guestbook_ring_keeps_fifty_and_counts_all() -> Result<()> {
    let book = setup().await?;
    let bob = book.user("bob").await?;
    // 120 messages of equal size, 20 per transaction (one FunctionCall action each).
    let mut storage_at_50 = 0;
    for batch in 0..6u64 {
        let mut tx = bob.batch(book.contract.id());
        for i in batch * 20..batch * 20 + 20 {
            tx = tx.call(Function::new("add_message").args_json(json!({ "text": format!("message {i:03}") })).gas(Gas::from_tgas(10)));
        }
        tx.transact().await?.into_result()?;
        let total = book.total().await?;
        assert_eq!(total, batch * 20 + 20);
        if total == 60 {
            // The 51st replaced the oldest.
            let kept = book.messages(None, None).await?;
            assert_eq!(kept.len(), 50);
            assert_eq!(kept.first().unwrap().index, 59);
            assert_eq!(kept.last().unwrap().index, 10);
            storage_at_50 = book.storage_usage().await?;
        }
    }
    assert_eq!(book.total().await?, 120);
    let kept = book.messages(None, None).await?;
    assert_eq!(kept.iter().map(|m| m.index).collect::<Vec<_>>(), (70..120).rev().collect::<Vec<u64>>());
    assert!(kept.iter().all(|m| m.text == format!("message {:03}", m.index) && m.account_id == bob.id().as_str()));
    assert_eq!(book.messages(Some(49), Some(50)).await?.iter().map(|m| m.index).collect::<Vec<_>>(), [70]);
    assert_eq!(book.messages(Some(50), Some(50)).await?, vec![]);
    // The contract account's storage stops growing once the ring is full.
    assert_eq!(book.storage_usage().await?, storage_at_50);
    println!("guestbook account storage with 50 short messages: {storage_at_50} bytes");
    Ok(())
}

/// The implicit account id of an ed25519 key: the lowercase hex of its 32 public key bytes.
fn implicit_id(sk: &SecretKey) -> AccountId {
    let data = sk.public_key().key_data().to_vec();
    assert_eq!(data.len(), 32);
    data.iter().map(|b| format!("{b:02x}")).collect::<String>().parse().unwrap()
}

#[tokio::test]
async fn guestbook_call_from_an_implicit_account() -> Result<()> {
    let book = setup().await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    let id = implicit_id(&sk);
    // A transfer creates the implicit account with this key as its full-access key.
    book.root.transfer_near(&id, NearToken::from_near(1)).await?.into_result()?;
    let user = Account::from_secret_key(id.clone(), sk, &book.worker);
    let added: Message = add(&user, &book, "gm from an implicit account").await?.into_result()?.json()?;
    assert_eq!(added.account_id, id.as_str());
    assert_eq!(added.account_id.len(), 64);
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Meta transactions over raw JSON-RPC.

struct Rpc {
    client: JsonRpcClient,
}

fn crypto_key(sk: &SecretKey) -> near_crypto::SecretKey {
    sk.to_string().parse().expect("same key format")
}

impl Rpc {
    fn new(worker: &Worker<Sandbox>) -> Self {
        Self { client: JsonRpcClient::connect(worker.rpc_addr()) }
    }

    async fn head(&self) -> Result<(near_primitives::hash::CryptoHash, u64)> {
        let block = self.client.call(methods::block::RpcBlockRequest { block_reference: BlockReference::Finality(Finality::Final) }).await?;
        Ok((block.header.hash, block.header.height))
    }

    /// The access key's nonce, or None when the account or key doesn't exist.
    async fn nonce(&self, account: &AccountId, pk: &near_crypto::PublicKey) -> Result<Option<u64>> {
        let r = self
            .client
            .call(methods::query::RpcQueryRequest {
                // Optimistic: a key added a block ago is already usable.
                block_reference: BlockReference::Finality(Finality::None),
                request: QueryRequest::ViewAccessKey { account_id: account.clone(), public_key: pk.clone() },
            })
            .await;
        match r {
            Ok(resp) => match resp.kind {
                QueryResponseKind::AccessKey(k) => Ok(Some(k.nonce)),
                other => bail!("unexpected answer {other:?}"),
            },
            Err(e) => {
                let text = format!("{e:?}");
                if text.contains("UnknownAccessKey") || text.contains("UnknownAccount") {
                    Ok(None)
                } else {
                    bail!("view_access_key {account}: {text}")
                }
            }
        }
    }

    /// The user's signed delegate action: `actions` on `receiver`, valid for 100 blocks, with the next nonce of the
    /// key (or 1 when the account doesn't exist yet: it can't be relayed then anyway).
    async fn sign_delegate(&self, user: &AccountId, sk: &SecretKey, receiver: &AccountId, actions: Vec<Action>) -> Result<SignedDelegateAction> {
        let key = crypto_key(sk);
        let signer = near_crypto::InMemorySigner::from_secret_key(user.clone(), key.clone());
        let nonce = self.nonce(user, &key.public_key()).await?.unwrap_or(0) + 1;
        let (_, height) = self.head().await?;
        let delegate_action = DelegateAction {
            sender_id: user.clone(),
            receiver_id: receiver.clone(),
            actions: actions.into_iter().map(|a| NonDelegateAction::try_from(a).expect("not a delegate")).collect(),
            nonce,
            max_block_height: height + 100,
            public_key: key.public_key(),
        };
        Ok(SignedDelegateAction::sign(&signer, delegate_action))
    }

    /// Signs and sends a transaction from `signer` (its full-access key `sk`) and waits for it to be final.
    async fn send(&self, signer_id: &AccountId, sk: &SecretKey, receiver: &AccountId, actions: Vec<Action>) -> Result<FinalExecutionOutcomeView> {
        let key = crypto_key(sk);
        let signer = near_crypto::InMemorySigner::from_secret_key(signer_id.clone(), key.clone());
        let nonce = self.nonce(signer_id, &key.public_key()).await?.context("relayer key")? + 1;
        let (block_hash, _) = self.head().await?;
        let tx = Transaction::V0(TransactionV0 { signer_id: signer_id.clone(), public_key: key.public_key(), nonce, receiver_id: receiver.clone(), block_hash, actions });
        let (hash, _) = tx.get_hash_and_size();
        let signed = SignedTransaction::new(signer.sign(hash.as_ref()), tx);
        let resp = self.client.call(methods::send_tx::RpcSendTransactionRequest { signed_transaction: signed, wait_until: TxExecutionStatus::Final }).await?;
        Ok(resp.final_execution_outcome.context("no outcome")?.into_outcome())
    }

    /// The relayer's transaction: the signed delegate action, sent to the user's account.
    async fn relay(&self, relayer: &Account, signed: SignedDelegateAction) -> Result<FinalExecutionOutcomeView> {
        let user = signed.delegate_action.sender_id.clone();
        self.send(relayer.id(), relayer.secret_key(), &user, vec![Action::Delegate(Box::new(signed))]).await
    }
}

fn add_message_action(text: &str) -> Action {
    Action::FunctionCall(Box::new(FunctionCallAction {
        method_name: "add_message".to_string(),
        args: serde_json::to_vec(&json!({ "text": text })).unwrap(),
        gas: near_primitives::types::Gas::from_teragas(ADD_GAS_TGAS),
        deposit: NearToken::from_yoctonear(0),
    }))
}

/// The receipt outcomes executed by `account`.
fn receipts_on<'a>(outcome: &'a FinalExecutionOutcomeView, account: &AccountId) -> Vec<&'a near_primitives::views::ExecutionOutcomeWithIdView> {
    outcome.receipts_outcome.iter().filter(|r| &r.outcome.executor_id == account).collect()
}

fn first_failure(outcome: &FinalExecutionOutcomeView) -> Option<String> {
    if let FinalExecutionStatus::Failure(e) = &outcome.status {
        return Some(format!("{e:?}"));
    }
    outcome.receipts_outcome.iter().find_map(|r| match &r.outcome.status {
        ExecutionStatusView::Failure(e) => Some(format!("{e:?}")),
        _ => None,
    })
}

#[tokio::test]
async fn guestbook_meta_transaction_from_an_unfunded_implicit_account() -> Result<()> {
    let book = setup().await?;
    let rpc = Rpc::new(&book.worker);
    let relayer = book.user("relayer").await?;
    let sk = SecretKey::from_random(KeyType::ED25519);
    let user = implicit_id(&sk);

    // 1. Before the implicit account exists on chain, its delegate action can't run: NEAR checks the sender's access
    //    key (and nonce) when the delegate receipt executes on the sender's account.
    let signed = rpc.sign_delegate(&user, &sk, book.contract.id(), vec![add_message_action("too early")]).await?;
    let early = rpc.relay(&relayer, signed).await?;
    let why = first_failure(&early).context("a delegate action from a missing account must fail")?;
    println!("delegate action before the account exists: {why}");
    assert!(why.contains("AccountDoesNotExist") || why.contains("DelegateActionAccessKeyError"), "{why}");
    assert_eq!(book.total().await?, 0);

    // 2. Activation: the relayer creates the implicit account with a transfer of 0 yoctoNEAR (NEP-448: an account
    //    under 770 bytes of storage needs no balance for its storage). Its one key is the user's, full access.
    let activation = rpc.send(relayer.id(), relayer.secret_key(), &user, vec![Action::Transfer(TransferAction { deposit: NearToken::from_yoctonear(0) })]).await?;
    assert_eq!(first_failure(&activation), None);
    let created = book.worker.view_account(&user).await?;
    println!("activated implicit account: balance {} yoctoNEAR, storage {} bytes", created.balance.as_yoctonear(), created.storage_usage);
    assert_eq!(created.balance, NearToken::from_yoctonear(0));
    assert!(rpc.nonce(&user, &crypto_key(&sk).public_key()).await?.is_some(), "the user's key is on the new account");

    // 3. The demo's path: the user signs, the relayer relays and pays.
    let relayer_before = book.worker.view_account(relayer.id()).await?.balance;
    let text = "🌸".repeat(200);
    let signed = rpc.sign_delegate(&user, &sk, book.contract.id(), vec![add_message_action(&text)]).await?;
    let replay = signed.clone();
    let outcome = rpc.relay(&relayer, signed).await?;
    assert_eq!(first_failure(&outcome), None);
    let on_contract = receipts_on(&outcome, book.contract.id());
    assert_eq!(on_contract.len(), 1, "one add_message receipt");
    let add_burnt = on_contract[0].outcome.gas_burnt;
    let total_burnt = outcome.transaction_outcome.outcome.gas_burnt.as_gas() + outcome.receipts_outcome.iter().map(|r| r.outcome.gas_burnt.as_gas()).sum::<u64>();
    println!(
        "meta transaction: add_message receipt burnt {:.3} Tgas (largest text, ring not full); whole transaction burnt {:.3} Tgas",
        add_burnt.as_gas() as f64 / 1e12,
        total_burnt as f64 / 1e12
    );
    assert!(add_burnt.as_gas() <= ADD_BURN_LIMIT_TGAS * 1_000_000_000_000);

    // The predecessor of add_message is the user's account, not the relayer's.
    let newest = &book.messages(None, Some(1)).await?[0];
    assert_eq!(newest.account_id, user.as_str());
    assert_eq!(newest.text, text);
    // The user paid nothing: the balance is still 0 (unused gas is refunded to the relayer, who bought it).
    assert_eq!(book.worker.view_account(&user).await?.balance, NearToken::from_yoctonear(0));
    assert!(book.worker.view_account(relayer.id()).await?.balance < relayer_before);

    // 4. A replayed delegate action is refused (its nonce is used).
    let replayed = rpc.relay(&relayer, replay).await?;
    let why = first_failure(&replayed).context("a replay must fail")?;
    assert!(why.contains("DelegateActionInvalidNonce"), "{why}");
    assert_eq!(book.total().await?, 1);

    // 5. A refused message under a meta transaction: the transaction's own status is still success (it only ran the
    //    Delegate action); the failure is in the add_message receipt. A relayer must check every receipt.
    let signed = rpc.sign_delegate(&user, &sk, book.contract.id(), vec![add_message_action("   ")]).await?;
    let refused = rpc.relay(&relayer, signed).await?;
    println!("meta transaction with a blank text: transaction status {:?}", refused.status);
    let receipt = receipts_on(&refused, book.contract.id());
    assert_eq!(receipt.len(), 1);
    let ExecutionStatusView::Failure(err) = &receipt[0].outcome.status else { bail!("add_message should have failed: {:?}", receipt[0].outcome.status) };
    assert!(format!("{err:?}").contains("Guestbook: text is empty after trimming"), "{err:?}");
    assert_eq!(book.total().await?, 1);

    // 6. Ring full: the replacing write costs about the same (measured with the largest text from the user).
    let filler = book.user("filler").await?;
    for chunk in [0..25, 25..49] {
        let mut tx = filler.batch(book.contract.id());
        for i in chunk {
            tx = tx.call(Function::new("add_message").args_json(json!({ "text": format!("filler {i}") })).gas(Gas::from_tgas(10)));
        }
        tx.transact().await?.into_result()?;
    }
    assert_eq!(book.total().await?, 50);
    let signed = rpc.sign_delegate(&user, &sk, book.contract.id(), vec![add_message_action(&text)]).await?;
    let full = rpc.relay(&relayer, signed).await?;
    assert_eq!(first_failure(&full), None);
    let burnt = receipts_on(&full, book.contract.id())[0].outcome.gas_burnt;
    println!("meta transaction, ring full (replaces the oldest): add_message receipt burnt {:.3} Tgas", burnt.as_gas() as f64 / 1e12);
    assert!(burnt.as_gas() <= ADD_BURN_LIMIT_TGAS * 1_000_000_000_000);
    assert_eq!(book.total().await?, 51);
    assert_eq!(book.messages(None, Some(1)).await?[0].account_id, user.as_str());
    assert_eq!(book.worker.view_account(&user).await?.balance, NearToken::from_yoctonear(0));
    Ok(())
}
