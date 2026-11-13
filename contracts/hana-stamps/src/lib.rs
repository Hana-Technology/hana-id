//! Journear Passport hackathon demo: passport stamps. A user signs in through Journear Passport, gets a NEAR implicit
//! account with no balance, and collects stamps here, each one a real NEAR transaction. Six stamps, each at most once
//! per account, `arrival` first; this contract checks every rule itself and trusts nothing else (no owner, no oracle,
//! no deposit). Decisions D794–D797 in `docs/decisions.md`; the interface in `README.md`.
//!
//! - `collect({ stamp, note?, proof? })`: the caller is the predecessor (under a NEP-366 meta transaction, the
//!   delegate action's sender, not the relayer). Rules:
//!   - `arrival`: none; creates the passport.
//!   - `sponsored`: the transaction's signer is not the caller (a relayer paid: a delegate action).
//!   - `own_fare`: the signer is the caller (the user signed and paid for the transaction).
//!   - `signature`: a NEP-413 signature by the caller's own key (an implicit account: the key is the account id),
//!     verified here with `env::ed25519_verify`, over `"Stamp my passport: <account id>"` for this contract.
//!   - `postcard`: a note of 1 to `MAX_NOTE_CHARS` characters after trimming, stored and shown publicly.
//!   - `layover`: at least `LAYOVER_MS` after the account's `arrival` (block timestamps).
//! - Storage is paid by this contract's account (the caller has nothing), so each passport is bounded (six stamps, one
//!   note) and the public list of recent stamps is a ring of the latest `KEEP_RECENT`. The number of passports isn't
//!   bounded here: the README says what that can cost and what balance the account should hold.
//! - Not payable: a call with a deposit is refused, so a caller never loses NEAR to it.
//! - Notes and account ids are attacker-controlled bytes: a page shows them as text, never as HTML.

use near_sdk::base64::engine::general_purpose::STANDARD as BASE64;
use near_sdk::base64::Engine;
use near_sdk::borsh::BorshSerialize;
use near_sdk::store::{LookupMap, Vector};
use near_sdk::{env, near, require, AccountId, BorshStorageKey, PanicOnDefault};

#[cfg(test)]
mod tests;

/// The stamp ids, in catalog order (`catalog()`).
pub const CATALOG: [&str; 6] = ["arrival", "sponsored", "own_fare", "signature", "postcard", "layover"];
/// Longest postcard note, in characters (Unicode scalar values, as Rust's `chars()` counts them) after trimming.
pub const MAX_NOTE_CHARS: usize = 140;
/// Recent stamps kept for `recent()`: the ring's size.
pub const KEEP_RECENT: u32 = 100;
/// Largest `limit` of `recent()`.
pub const MAX_LIMIT: u32 = 50;
/// The layover: this long after the account's `arrival`, in milliseconds of block time.
pub const LAYOVER_MS: u64 = 120_000;
/// The `signature` stamp's message is this followed by the caller's account id.
pub const SIGN_MESSAGE_PREFIX: &str = "Stamp my passport: ";
/// NEP-413: the u32 that starts the signed bytes (2^31 + 413).
pub const NEP413_TAG: u32 = (1 << 31) + 413;

pub const ERR_UNKNOWN_STAMP: &str = "ERR_UNKNOWN_STAMP";
pub const ERR_NO_ARRIVAL: &str = "ERR_NO_ARRIVAL";
pub const ERR_ALREADY: &str = "ERR_ALREADY";
pub const ERR_NOT_SPONSORED: &str = "ERR_NOT_SPONSORED";
pub const ERR_NOT_OWN_FARE: &str = "ERR_NOT_OWN_FARE";
pub const ERR_NOT_IMPLICIT: &str = "ERR_NOT_IMPLICIT";
pub const ERR_BAD_PROOF: &str = "ERR_BAD_PROOF";
pub const ERR_BAD_NOTE: &str = "ERR_BAD_NOTE";
pub const ERR_TOO_SOON: &str = "ERR_TOO_SOON";

#[near]
#[derive(BorshStorageKey)]
enum StorageKey {
    Passports,
    Recent,
}

/// A stamp id. Stored as one byte (borsh enum tag, catalog order); the views and arguments use `CATALOG`'s strings.
#[near(serializers = [borsh])]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stamp {
    Arrival,
    Sponsored,
    OwnFare,
    Signature,
    Postcard,
    Layover,
}

impl Stamp {
    const ALL: [Stamp; 6] = [Stamp::Arrival, Stamp::Sponsored, Stamp::OwnFare, Stamp::Signature, Stamp::Postcard, Stamp::Layover];

    pub fn id(self) -> &'static str {
        CATALOG[self as usize]
    }

    /// The stamp with this exact id (case-sensitive), if any.
    pub fn parse(id: &str) -> Option<Stamp> {
        Stamp::ALL.into_iter().find(|s| s.id() == id)
    }
}

/// One collected stamp, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
struct StoredStamp {
    stamp: Stamp,
    block_timestamp_ms: u64,
    sponsored: bool,
    note: Option<String>,
}

/// One entry of the recent ring, as stored.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
struct StoredRecent {
    account_id: AccountId,
    stamp: Stamp,
    block_timestamp_ms: u64,
}

/// A collected stamp as `get_passport` and `collect` return it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct StampView {
    /// The stamp id (`CATALOG`).
    pub stamp: String,
    /// The block's timestamp when it was collected, in milliseconds since the Unix epoch.
    pub block_timestamp_ms: u64,
    /// Whether the transaction's signer was not the caller (a relayer paid for it), whatever the stamp.
    pub sponsored: bool,
    /// The trimmed note: `postcard` only, absent from the JSON otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// A passport: its account and its stamps in the order they were collected (`arrival` first).
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PassportView {
    pub account_id: AccountId,
    pub stamps: Vec<StampView>,
}

/// One recent stamp, as `recent` lists it.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct RecentView {
    pub account_id: AccountId,
    pub stamp: String,
    pub block_timestamp_ms: u64,
}

/// Counts since the deploy: passports (arrivals) and stamps of every kind.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct Totals {
    pub passports: u64,
    pub stamps: u64,
}

/// The `signature` stamp's proof: what `hana.near.signMessage` signed and returned. `nonce` and `signature` are
/// standard base64 (with padding) of 32 and 64 bytes.
#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct SignatureProof {
    pub message: String,
    pub nonce: String,
    pub recipient: String,
    pub signature: String,
}

/// NEP-413's Payload, borsh-serialised after the tag. `callback_url` is always None: a signature made with one doesn't
/// verify here.
#[derive(BorshSerialize)]
#[borsh(crate = "near_sdk::borsh")]
struct Nep413Payload<'a> {
    message: &'a str,
    nonce: [u8; 32],
    recipient: &'a str,
    callback_url: Option<String>,
}

/// The bytes a NEP-413 signature signs the sha256 of: `u32le(2^31 + 413) ‖ borsh(Payload)`.
pub fn nep413_bytes(message: &str, nonce: [u8; 32], recipient: &str) -> Vec<u8> {
    let mut out = NEP413_TAG.to_le_bytes().to_vec();
    Nep413Payload { message, nonce, recipient, callback_url: None }.serialize(&mut out).expect("borsh to a Vec");
    out
}

/// The ed25519 public key of a NEAR implicit account (64 lowercase hex characters), or None for any other account.
pub fn implicit_public_key(account: &AccountId) -> Option<[u8; 32]> {
    let hex = account.as_str().as_bytes();
    if hex.len() != 64 {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    let mut key = [0u8; 32];
    for (i, pair) in hex.chunks_exact(2).enumerate() {
        key[i] = (nibble(pair[0])? << 4) | nibble(pair[1])?;
    }
    Some(key)
}

/// Standard base64 (padding required) of exactly N bytes, or None.
fn base64_exact<const N: usize>(text: &str) -> Option<[u8; N]> {
    // Encoded length first: an attacker's long string is never decoded.
    if text.len() != N.div_ceil(3) * 4 {
        return None;
    }
    BASE64.decode(text).ok()?.try_into().ok()
}

/// Whether `proof` is a valid `signature` stamp proof for `caller` on this contract (`me`). Panics `ERR_NOT_IMPLICIT`
/// for a named caller (its key isn't its account id) and returns false for anything wrong in the proof.
fn proof_is_valid(caller: &AccountId, me: &AccountId, proof: &SignatureProof) -> bool {
    let key = implicit_public_key(caller).unwrap_or_else(|| env::panic_str(ERR_NOT_IMPLICIT));
    if proof.recipient != me.as_str() || proof.message.strip_prefix(SIGN_MESSAGE_PREFIX) != Some(caller.as_str()) {
        return false;
    }
    let (Some(nonce), Some(signature)) = (base64_exact::<32>(&proof.nonce), base64_exact::<64>(&proof.signature)) else {
        return false;
    };
    let hash = env::sha256_array(nep413_bytes(&proof.message, nonce, &proof.recipient));
    env::ed25519_verify(&signature, hash, &key)
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Stamps {
    /// Each account's stamps, in the order collected (at most one of each, so at most six).
    passports: LookupMap<AccountId, Vec<StoredStamp>>,
    /// The ring: slot `index % KEEP_RECENT` holds stamp `index` (0 = the first collected) while it is one of the latest.
    recent: Vector<StoredRecent>,
    /// Passports created (arrivals).
    total_passports: u64,
    /// Stamps collected, of every kind.
    total_stamps: u64,
}

#[near]
impl Stamps {
    /// Deployed and called in one transaction (scripts/deploy-stamps.ts), so no one else can initialise it.
    #[init]
    pub fn new() -> Self {
        Self { passports: LookupMap::new(StorageKey::Passports), recent: Vector::new(StorageKey::Recent), total_passports: 0, total_stamps: 0 }
    }

    /// Collects `stamp` for the predecessor, checking its rule (module docs; README "Rules"), and returns it.
    pub fn collect(&mut self, stamp: String, note: Option<String>, proof: Option<SignatureProof>) -> StampView {
        let id = Stamp::parse(&stamp).unwrap_or_else(|| env::panic_str(ERR_UNKNOWN_STAMP));
        // Arguments that belong to another stamp are refused, so nothing unchecked is ever stored.
        require!(note.is_none() || id == Stamp::Postcard, ERR_BAD_NOTE);
        require!(proof.is_none() || id == Stamp::Signature, ERR_BAD_PROOF);
        let caller = env::predecessor_account_id();
        let sponsored = env::signer_account_id() != caller;
        let now = env::block_timestamp_ms();
        let mut stamps = match (id, self.passports.get(&caller)) {
            (Stamp::Arrival, Some(_)) => env::panic_str(ERR_ALREADY),
            (Stamp::Arrival, None) => Vec::with_capacity(1),
            (_, None) => env::panic_str(ERR_NO_ARRIVAL),
            (_, Some(stamps)) => {
                require!(stamps.iter().all(|s| s.stamp != id), ERR_ALREADY);
                stamps.clone()
            }
        };
        let mut kept_note = None;
        match id {
            Stamp::Arrival | Stamp::OwnFare | Stamp::Sponsored => {
                require!(id != Stamp::Sponsored || sponsored, ERR_NOT_SPONSORED);
                require!(id != Stamp::OwnFare || !sponsored, ERR_NOT_OWN_FARE);
            }
            Stamp::Signature => {
                let proof = proof.unwrap_or_else(|| {
                    // A named account can't collect it at all: say so before asking for a proof.
                    implicit_public_key(&caller).unwrap_or_else(|| env::panic_str(ERR_NOT_IMPLICIT));
                    env::panic_str(ERR_BAD_PROOF)
                });
                require!(proof_is_valid(&caller, &env::current_account_id(), &proof), ERR_BAD_PROOF);
            }
            Stamp::Postcard => {
                let text = note.as_deref().unwrap_or("").trim();
                let chars = text.chars().count();
                require!((1..=MAX_NOTE_CHARS).contains(&chars), ERR_BAD_NOTE);
                kept_note = Some(text.to_string());
            }
            Stamp::Layover => {
                let arrived = stamps.first().expect("arrival is first").block_timestamp_ms;
                require!(now.saturating_sub(arrived) >= LAYOVER_MS, ERR_TOO_SOON);
            }
        }
        let stored = StoredStamp { stamp: id, block_timestamp_ms: now, sponsored, note: kept_note };
        stamps.push(stored.clone());
        self.passports.insert(caller.clone(), stamps);
        if id == Stamp::Arrival {
            self.total_passports += 1;
        }
        let index = self.total_stamps;
        let entry = StoredRecent { account_id: caller, stamp: id, block_timestamp_ms: now };
        let slot = slot_of(index);
        if self.recent.len() < KEEP_RECENT {
            // The ring fills in order: slot == len while it is not full.
            debug_assert_eq!(slot, self.recent.len());
            self.recent.push(entry);
        } else {
            self.recent.set(slot, entry);
        }
        self.total_stamps = index + 1;
        stamp_view(&stored)
    }

    /// The account's passport, or null if it has collected no stamp (no `arrival`).
    pub fn get_passport(&self, account_id: AccountId) -> Option<PassportView> {
        let stamps = self.passports.get(&account_id)?;
        Some(PassportView { stamps: stamps.iter().map(stamp_view).collect(), account_id })
    }

    /// The latest stamps of every account, newest first: skips `from_index` (default 0) of them and returns at most
    /// `limit` (default and cap `MAX_LIMIT`). Only the latest `KEEP_RECENT` are kept; past them, `[]`.
    pub fn recent(&self, from_index: Option<u64>, limit: Option<u32>) -> Vec<RecentView> {
        let kept = u64::from(self.recent.len());
        let from = from_index.unwrap_or(0);
        let limit = u64::from(limit.unwrap_or(MAX_LIMIT).min(MAX_LIMIT));
        let end = from.saturating_add(limit).min(kept);
        (from..end)
            .map(|i| {
                let r = self.recent.get(slot_of(self.total_stamps - 1 - i)).expect("kept entry");
                RecentView { account_id: r.account_id.clone(), stamp: r.stamp.id().to_string(), block_timestamp_ms: r.block_timestamp_ms }
            })
            .collect()
    }

    /// Passports and stamps since the deploy.
    pub fn totals(&self) -> Totals {
        Totals { passports: self.total_passports, stamps: self.total_stamps }
    }

    /// The stamp ids, in order: `arrival`, `sponsored`, `own_fare`, `signature`, `postcard`, `layover`.
    pub fn catalog(&self) -> Vec<String> {
        CATALOG.iter().map(|s| s.to_string()).collect()
    }
}

fn slot_of(index: u64) -> u32 {
    (index % u64::from(KEEP_RECENT)) as u32
}

fn stamp_view(s: &StoredStamp) -> StampView {
    StampView { stamp: s.stamp.id().to_string(), block_timestamp_ms: s.block_timestamp_ms, sponsored: s.sponsored, note: s.note.clone() }
}
