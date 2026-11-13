//! NEP-366 meta transactions over the sandbox's JSON-RPC, shared by the demo contracts' sandbox tests
//! (`tests/guestbook.rs`, `tests/stamps.rs`). near-workspaces has no Delegate action, so a user's signed delegate action
//! and the relayer's transaction are built with near-primitives and sent with near-jsonrpc-client (D742).

use anyhow::{bail, Context, Result};
use near_jsonrpc_client::{methods, JsonRpcClient};
use near_jsonrpc_primitives::types::query::QueryResponseKind;
use near_primitives::action::delegate::{DelegateAction, NonDelegateAction, SignedDelegateAction};
use near_primitives::transaction::{Action, SignedTransaction, Transaction, TransactionV0};
use near_primitives::types::{BlockReference, Finality};
use near_primitives::views::{ExecutionStatusView, FinalExecutionOutcomeView, FinalExecutionStatus, QueryRequest, TxExecutionStatus};
use near_workspaces::network::Sandbox;
use near_workspaces::types::SecretKey;
use near_workspaces::{Account, AccountId, Worker};

/// The implicit account id of an ed25519 key: the lowercase hex of its 32 public key bytes.
pub fn implicit_id(sk: &SecretKey) -> AccountId {
    let data = sk.public_key().key_data().to_vec();
    assert_eq!(data.len(), 32);
    data.iter().map(|b| format!("{b:02x}")).collect::<String>().parse().unwrap()
}

pub struct Rpc {
    pub client: JsonRpcClient,
}

pub fn crypto_key(sk: &SecretKey) -> near_crypto::SecretKey {
    sk.to_string().parse().expect("same key format")
}

impl Rpc {
    pub fn new(worker: &Worker<Sandbox>) -> Self {
        Self { client: JsonRpcClient::connect(worker.rpc_addr()) }
    }

    pub async fn head(&self) -> Result<(near_primitives::hash::CryptoHash, u64)> {
        let block = self.client.call(methods::block::RpcBlockRequest { block_reference: BlockReference::Finality(Finality::Final) }).await?;
        Ok((block.header.hash, block.header.height))
    }

    /// The access key's nonce, or None when the account or key doesn't exist.
    pub async fn nonce(&self, account: &AccountId, pk: &near_crypto::PublicKey) -> Result<Option<u64>> {
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
    pub async fn sign_delegate(&self, user: &AccountId, sk: &SecretKey, receiver: &AccountId, actions: Vec<Action>) -> Result<SignedDelegateAction> {
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
    pub async fn send(&self, signer_id: &AccountId, sk: &SecretKey, receiver: &AccountId, actions: Vec<Action>) -> Result<FinalExecutionOutcomeView> {
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
    pub async fn relay(&self, relayer: &Account, signed: SignedDelegateAction) -> Result<FinalExecutionOutcomeView> {
        let user = signed.delegate_action.sender_id.clone();
        self.send(relayer.id(), relayer.secret_key(), &user, vec![Action::Delegate(Box::new(signed))]).await
    }
}

/// The receipt outcomes executed by `account`.
pub fn receipts_on<'a>(outcome: &'a FinalExecutionOutcomeView, account: &AccountId) -> Vec<&'a near_primitives::views::ExecutionOutcomeWithIdView> {
    outcome.receipts_outcome.iter().filter(|r| &r.outcome.executor_id == account).collect()
}

pub fn first_failure(outcome: &FinalExecutionOutcomeView) -> Option<String> {
    if let FinalExecutionStatus::Failure(e) = &outcome.status {
        return Some(format!("{e:?}"));
    }
    outcome.receipts_outcome.iter().find_map(|r| match &r.outcome.status {
        ExecutionStatusView::Failure(e) => Some(format!("{e:?}")),
        _ => None,
    })
}

