//! Hana ID hackathon demo: a public guestbook. A Hana user signs in with Google, their NEAR wallet (an implicit
//! account, no balance) signs a NEP-366 delegate action calling `add_message`, and Hana's relayer pays the gas. Under a
//! meta transaction the predecessor of `add_message` is the user's account, not the relayer's (the sandbox tests in
//! `contracts/integration-tests/tests/guestbook.rs` check it).
//!
//! - `add_message({ text })` stores `{ account_id: predecessor, text: trimmed text, block_timestamp_ms }`. The text
//!   must be 1 to `MAX_TEXT_CHARS` characters (Unicode scalar values) after trimming (`str::trim`). No deposit: the
//!   method is not payable, so a call that attaches NEAR is refused and nothing is taken from the caller.
//! - Storage is paid by this contract's account (NEAR's storage staking), so it is capped: only the latest
//!   `KEEP_MESSAGES` messages are kept, in a ring. `total_messages` counts every message ever added. The most this
//!   state can grow to is about 50 × 0.9 KB, under 0.5 NEAR of storage.
//! - `get_messages({ from_index?, limit? })` lists the kept messages **newest first**: `from_index` 0 (the default) is
//!   the newest; `limit` defaults to and is capped at `MAX_LIMIT`. Each message carries its `index`, its position in
//!   the full history (0 = the first message ever added), stable while it is kept.
//! - No owner, no admin methods, no upgrade path. The text is attacker-controlled bytes: a page shows it as text,
//!   never as HTML.

use near_sdk::store::Vector;
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

#[cfg(test)]
mod tests;

/// Longest message, in characters (Unicode scalar values, as Rust's `chars()` counts them) after trimming.
pub const MAX_TEXT_CHARS: usize = 200;
/// Messages kept: the ring's size.
pub const KEEP_MESSAGES: u32 = 50;
/// Largest `limit` of `get_messages`.
pub const MAX_LIMIT: u32 = 50;

pub const ERR_EMPTY: &str = "Guestbook: text is empty after trimming";
pub const ERR_TOO_LONG: &str = "Guestbook: text is longer than 200 characters after trimming";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Messages,
}

/// One kept message, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
struct StoredMessage {
    account_id: AccountId,
    text: String,
    block_timestamp_ms: u64,
}

/// One message as the views and `add_message` return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Message {
    /// Position in the full history: 0 for the first message ever added, `total_messages - 1` for the newest.
    pub index: u64,
    /// Who wrote it: the predecessor of `add_message` (under a meta transaction, the delegate action's sender).
    pub account_id: AccountId,
    /// The trimmed text, 1 to `MAX_TEXT_CHARS` characters.
    pub text: String,
    /// The block's timestamp when it was added, in milliseconds since the Unix epoch.
    pub block_timestamp_ms: u64,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Guestbook {
    /// The ring: slot `index % KEEP_MESSAGES` holds message `index` while it is one of the latest `KEEP_MESSAGES`.
    messages: Vector<StoredMessage>,
    /// Every message ever added.
    total_messages: u64,
}

#[near]
impl Guestbook {
    /// Deployed and called in one transaction (scripts/deploy-guestbook.ts), so no one else can initialise it.
    #[init]
    pub fn new() -> Self {
        Self { messages: Vector::new(StorageKey::Messages), total_messages: 0 }
    }

    /// Adds a message from the predecessor; once `KEEP_MESSAGES` are kept, it replaces the oldest. Returns it.
    pub fn add_message(&mut self, text: String) -> Message {
        let text = text.trim();
        let chars = text.chars().count();
        require!(chars >= 1, ERR_EMPTY);
        require!(chars <= MAX_TEXT_CHARS, ERR_TOO_LONG);
        let index = self.total_messages;
        let stored = StoredMessage { account_id: env::predecessor_account_id(), text: text.to_string(), block_timestamp_ms: env::block_timestamp_ms() };
        let slot = slot_of(index);
        if self.messages.len() < KEEP_MESSAGES {
            // The ring fills in order: slot == len while it is not full.
            debug_assert_eq!(slot, self.messages.len());
            self.messages.push(stored.clone());
        } else {
            self.messages.set(slot, stored.clone());
        }
        self.total_messages = index + 1;
        to_view(index, stored)
    }

    /// The kept messages, newest first: skips `from_index` (default 0) of them, returns at most `limit` (default and
    /// cap `MAX_LIMIT`). A `from_index` past the kept messages returns `[]`.
    pub fn get_messages(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<Message> {
        let kept = u64::from(self.messages.len());
        let from = from_index.unwrap_or(0);
        let limit = u64::from(limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT));
        let end = from.saturating_add(limit).min(kept);
        (from..end)
            .map(|i| {
                let index = self.total_messages - 1 - i;
                let stored = self.messages.get(slot_of(index)).expect("kept message").clone();
                to_view(index, stored)
            })
            .collect()
    }

    /// Every message ever added (kept or not).
    pub fn total_messages(&self) -> u64 {
        self.total_messages
    }
}

fn slot_of(index: u64) -> u32 {
    (index % u64::from(KEEP_MESSAGES)) as u32
}

fn to_view(index: u64, m: StoredMessage) -> Message {
    Message { index, account_id: m.account_id, text: m.text, block_timestamp_ms: m.block_timestamp_ms }
}
