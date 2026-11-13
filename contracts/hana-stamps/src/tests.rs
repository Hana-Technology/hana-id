//! Unit tests (mocked blockchain): every rule and every error. The sandbox tests
//! (`contracts/integration-tests/tests/stamps.rs`) cover the deployed wasm: deposits refused, real meta transactions
//! for `sponsored`, direct transactions for `own_fare`, the layover on the sandbox's clock, and gas.
//!
//! The `signature` stamp is checked against `tests/nep413-vector.json`: NEP-413 signatures made by @hana-id/core's own
//! signer (what the vault signs), written and pinned by `packages/core/test/near-stamps-vector.test.ts`.

use std::panic::{catch_unwind, AssertUnwindSafe};

use near_sdk::serde_json::{self, json, Value};
use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId};

use crate::*;

const T0_MS: u64 = 1_800_000_000_000;
const RELAYER: &str = "relayer.testnet";
const VECTOR: &str = include_str!("../tests/nep413-vector.json");

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn vector() -> Value {
    serde_json::from_str(VECTOR).unwrap()
}

fn vector_contract() -> String {
    vector()["contract"].as_str().unwrap().to_string()
}

/// The proof at `path` in the vector (`a.proof`, `a_message_signed_by_b`, ...).
fn proof(path: &str) -> SignatureProof {
    let mut v = vector();
    for part in path.split('.') {
        v = v[part].take();
    }
    serde_json::from_value(v).unwrap()
}

fn vector_account(who: &str) -> String {
    vector()[who]["account_id"].as_str().unwrap().to_string()
}

/// A call from `who`, signed by `signer` (the same account: a direct transaction; another: a relayer), at `now_ms`,
/// on the contract account `contract`. `storage` carries the storage usage over (`testing_env!` resets it).
fn context(who: &str, signer: &str, now_ms: u64, contract: &str, storage: u64) {
    testing_env!(VMContextBuilder::new()
        .current_account_id(account(contract))
        .predecessor_account_id(account(who))
        .signer_account_id(account(signer))
        .block_timestamp(now_ms * 1_000_000)
        .storage_usage(storage)
        .build());
}

/// A direct call from `who` (signer = predecessor) on the vector's contract account.
fn direct(who: &str, now_ms: u64) {
    context(who, who, now_ms, &vector_contract(), 0);
}

/// A relayed call from `who` (signer = the relayer) on the vector's contract account.
fn relayed(who: &str, now_ms: u64) {
    context(who, RELAYER, now_ms, &vector_contract(), 0);
}

/// Empties the mocked chain's storage (`testing_env!` carries it from context to context, also into a new contract).
fn fresh_chain() {
    near_sdk::mock::with_mocked_blockchain(|b| drop(b.take_storage()));
}

fn setup() -> Stamps {
    fresh_chain();
    direct("deployer.testnet", T0_MS);
    Stamps::new()
}

fn collect(s: &mut Stamps, stamp: &str) -> StampView {
    s.collect(stamp.to_string(), None, None)
}

/// The contract's panic message from `f`, which must panic (the mock wraps it in `GuestPanic { panic_msg: "…" }`).
fn panics<R>(f: impl FnOnce() -> R) -> String {
    let err = catch_unwind(AssertUnwindSafe(f)).err().expect("expected a panic");
    let text = err.downcast_ref::<String>().cloned().or_else(|| err.downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
    match text.split_once("panic_msg: \"") {
        Some((_, rest)) => rest.split_once('"').map(|(msg, _)| msg.to_string()).unwrap_or(text),
        None => text,
    }
}

/// `who` collects arrival directly at T0_MS.
fn arrive(s: &mut Stamps, who: &str) -> StampView {
    direct(who, T0_MS);
    collect(s, "arrival")
}

fn stamp_ids(s: &Stamps, who: &str) -> Vec<String> {
    s.get_passport(account(who)).map(|p| p.stamps.into_iter().map(|x| x.stamp).collect()).unwrap_or_default()
}

// ---------------------------------------------------------------------------------------------------------------
// Views and the empty contract.

#[test]
fn starts_empty() {
    let s = setup();
    assert_eq!(s.totals(), Totals { passports: 0, stamps: 0 });
    assert_eq!(s.recent(None, None), vec![]);
    assert_eq!(s.get_passport(account("alice.testnet")), None);
    assert_eq!(s.catalog(), ["arrival", "sponsored", "own_fare", "signature", "postcard", "layover"]);
}

#[test]
fn view_json_shapes() {
    let mut s = setup();
    relayed("alice.testnet", T0_MS + 1);
    collect(&mut s, "arrival");
    s.collect("postcard".into(), Some(" hi ".into()), None);
    let passport = serde_json::to_value(s.get_passport(account("alice.testnet"))).unwrap();
    assert_eq!(
        passport,
        json!({ "account_id": "alice.testnet", "stamps": [
            { "stamp": "arrival", "block_timestamp_ms": T0_MS + 1, "sponsored": true },
            { "stamp": "postcard", "block_timestamp_ms": T0_MS + 1, "sponsored": true, "note": "hi" },
        ] })
    );
    assert_eq!(serde_json::to_value(s.get_passport(account("bob.testnet"))).unwrap(), Value::Null);
    assert_eq!(
        serde_json::to_value(s.recent(None, None)).unwrap(),
        json!([
            { "account_id": "alice.testnet", "stamp": "postcard", "block_timestamp_ms": T0_MS + 1 },
            { "account_id": "alice.testnet", "stamp": "arrival", "block_timestamp_ms": T0_MS + 1 },
        ])
    );
    assert_eq!(serde_json::to_value(s.totals()).unwrap(), json!({ "passports": 1, "stamps": 2 }));
    // The proof argument's JSON shape.
    let p: SignatureProof = serde_json::from_value(json!({ "message": "m", "nonce": "n", "recipient": "r", "signature": "s" })).unwrap();
    assert_eq!(p.recipient, "r");
}

#[test]
fn stamp_ids_round_trip_in_catalog_order() {
    for (i, id) in CATALOG.iter().enumerate() {
        let stamp = Stamp::parse(id).unwrap();
        assert_eq!(stamp as usize, i);
        assert_eq!(stamp.id(), *id);
        // Stored as one byte: the borsh tag is the catalog position.
        assert_eq!(near_sdk::borsh::to_vec(&stamp).unwrap(), vec![i as u8]);
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Rules common to every stamp.

#[test]
fn unknown_stamps_are_refused() {
    let mut s = setup();
    direct("alice.testnet", T0_MS);
    for bad in ["", "Arrival", "arrival ", " arrival", "ARRIVAL", "passport", "own-fare", "ownFare", "arrival\0"] {
        assert_eq!(panics(|| collect(&mut s, bad)), ERR_UNKNOWN_STAMP, "{bad:?}");
    }
    assert_eq!(s.totals().stamps, 0);
}

#[test]
fn arrival_creates_the_passport_once() {
    let mut s = setup();
    let got = arrive(&mut s, "alice.testnet");
    assert_eq!(got, StampView { stamp: "arrival".into(), block_timestamp_ms: T0_MS, sponsored: false, note: None });
    assert_eq!(s.totals(), Totals { passports: 1, stamps: 1 });
    // Again, directly or relayed: refused.
    assert_eq!(panics(|| collect(&mut s, "arrival")), ERR_ALREADY);
    relayed("alice.testnet", T0_MS + 5);
    assert_eq!(panics(|| collect(&mut s, "arrival")), ERR_ALREADY);
    assert_eq!(s.totals(), Totals { passports: 1, stamps: 1 });
    // A relayed arrival is marked sponsored.
    relayed("bob.testnet", T0_MS + 7);
    assert!(collect(&mut s, "arrival").sponsored);
    assert_eq!(s.totals(), Totals { passports: 2, stamps: 2 });
}

#[test]
fn every_other_stamp_needs_arrival_first() {
    let mut s = setup();
    let a = vector_account("a");
    for stamp in ["sponsored", "own_fare", "layover"] {
        for ctx in [direct, relayed] {
            ctx("alice.testnet", T0_MS + 1_000_000);
            assert_eq!(panics(|| collect(&mut s, stamp)), ERR_NO_ARRIVAL, "{stamp}");
        }
    }
    relayed("alice.testnet", T0_MS);
    assert_eq!(panics(|| s.collect("postcard".into(), Some("hello".into()), None)), ERR_NO_ARRIVAL);
    relayed(&a, T0_MS);
    assert_eq!(panics(|| s.collect("signature".into(), None, Some(proof("a.proof")))), ERR_NO_ARRIVAL);
    assert_eq!(s.totals(), Totals { passports: 0, stamps: 0 });
    assert_eq!(s.get_passport(account("alice.testnet")), None);
}

#[test]
fn each_stamp_is_collected_at_most_once() {
    let mut s = setup();
    let a = vector_account("a");
    arrive(&mut s, &a);
    relayed(&a, T0_MS + 1);
    collect(&mut s, "sponsored");
    direct(&a, T0_MS + 2);
    collect(&mut s, "own_fare");
    relayed(&a, T0_MS + 3);
    s.collect("signature".into(), None, Some(proof("a.proof")));
    s.collect("postcard".into(), Some("first".into()), None);
    relayed(&a, T0_MS + LAYOVER_MS);
    collect(&mut s, "layover");
    assert_eq!(stamp_ids(&s, &a), CATALOG);
    assert_eq!(s.totals(), Totals { passports: 1, stamps: 6 });

    relayed(&a, T0_MS + 10 * LAYOVER_MS);
    for stamp in ["arrival", "sponsored", "layover"] {
        assert_eq!(panics(|| collect(&mut s, stamp)), ERR_ALREADY, "{stamp}");
    }
    assert_eq!(panics(|| s.collect("signature".into(), None, Some(proof("a.proof")))), ERR_ALREADY);
    assert_eq!(panics(|| s.collect("postcard".into(), Some("second".into()), None)), ERR_ALREADY);
    direct(&a, T0_MS + 10 * LAYOVER_MS);
    assert_eq!(panics(|| collect(&mut s, "own_fare")), ERR_ALREADY);
    assert_eq!(s.totals(), Totals { passports: 1, stamps: 6 });
    assert_eq!(s.get_passport(account(&a)).unwrap().stamps[4].note.as_deref(), Some("first"));
}

#[test]
fn arguments_of_another_stamp_are_refused() {
    let mut s = setup();
    let a = vector_account("a");
    // Before arrival too: nothing unchecked is ever stored.
    relayed(&a, T0_MS);
    assert_eq!(panics(|| s.collect("arrival".into(), Some("note".into()), None)), ERR_BAD_NOTE);
    assert_eq!(panics(|| s.collect("arrival".into(), None, Some(proof("a.proof")))), ERR_BAD_PROOF);
    collect(&mut s, "arrival");
    for stamp in ["sponsored", "layover", "signature"] {
        assert_eq!(panics(|| s.collect(stamp.into(), Some("note".into()), None)), ERR_BAD_NOTE, "{stamp}");
    }
    for stamp in ["sponsored", "layover", "postcard"] {
        assert_eq!(panics(|| s.collect(stamp.into(), Some("x".into()).filter(|_| stamp == "postcard"), Some(proof("a.proof")))), ERR_BAD_PROOF, "{stamp}");
    }
    direct(&a, T0_MS);
    assert_eq!(panics(|| s.collect("own_fare".into(), Some(String::new()), None)), ERR_BAD_NOTE);
    assert_eq!(s.totals().stamps, 1);
}

#[test]
fn the_predecessor_is_the_traveller_not_the_signer() {
    let mut s = setup();
    relayed("user.testnet", T0_MS);
    collect(&mut s, "arrival");
    assert!(s.get_passport(account("user.testnet")).is_some());
    assert_eq!(s.get_passport(account(RELAYER)), None);
}

// ---------------------------------------------------------------------------------------------------------------
// sponsored and own_fare.

#[test]
fn sponsored_only_when_someone_else_signed() {
    let mut s = setup();
    arrive(&mut s, "alice.testnet");
    direct("alice.testnet", T0_MS + 1);
    assert_eq!(panics(|| collect(&mut s, "sponsored")), ERR_NOT_SPONSORED);
    relayed("alice.testnet", T0_MS + 2);
    assert_eq!(collect(&mut s, "sponsored"), StampView { stamp: "sponsored".into(), block_timestamp_ms: T0_MS + 2, sponsored: true, note: None });
}

#[test]
fn own_fare_only_when_the_traveller_signed() {
    let mut s = setup();
    arrive(&mut s, "alice.testnet");
    relayed("alice.testnet", T0_MS + 1);
    assert_eq!(panics(|| collect(&mut s, "own_fare")), ERR_NOT_OWN_FARE);
    // Any other signer is someone else paying, not only a relayer.
    context("alice.testnet", "bob.testnet", T0_MS + 1, &vector_contract(), 0);
    assert_eq!(panics(|| collect(&mut s, "own_fare")), ERR_NOT_OWN_FARE);
    direct("alice.testnet", T0_MS + 2);
    assert_eq!(collect(&mut s, "own_fare"), StampView { stamp: "own_fare".into(), block_timestamp_ms: T0_MS + 2, sponsored: false, note: None });
}

// ---------------------------------------------------------------------------------------------------------------
// signature: the cross-language NEP-413 vector.

/// A fresh contract running as the vector's contract account, with `who` arrived.
fn arrived(who: &str) -> Stamps {
    let mut s = setup();
    arrive(&mut s, who);
    relayed(who, T0_MS + 1);
    s
}

fn try_signature(s: &mut Stamps, p: SignatureProof) -> String {
    panics(|| s.collect("signature".into(), None, Some(p)))
}

#[test]
fn signature_accepts_the_vaults_nep413_signature() {
    let v = vector();
    assert_eq!(v["nep413Tag"], json!(NEP413_TAG));
    for who in ["a", "b"] {
        let id = vector_account(who);
        let mut s = arrived(&id);
        let got = s.collect("signature".into(), None, Some(proof(&format!("{who}.proof"))));
        assert_eq!(got, StampView { stamp: "signature".into(), block_timestamp_ms: T0_MS + 1, sponsored: true, note: None });
        assert_eq!(stamp_ids(&s, &id), ["arrival", "signature"]);
    }
    // Directly signed transactions may collect it too (the rule is the proof, not the transport).
    let a = vector_account("a");
    let mut s = setup();
    arrive(&mut s, &a);
    assert!(!s.collect("signature".into(), None, Some(proof("a.proof"))).sponsored);
}

#[test]
fn signature_refuses_any_altered_field() {
    let a = vector_account("a");
    let good = proof("a.proof");
    let flip_b64 = |b64: &str, at: usize| {
        let mut bytes = BASE64.decode(b64).unwrap();
        bytes[at] ^= 1;
        BASE64.encode(bytes)
    };
    let mut cases: Vec<(&str, SignatureProof)> = vec![];
    let mut p = good.clone();
    p.message = format!("Stamp my passport:  {a}");
    cases.push(("message: two spaces", p));
    let mut p = good.clone();
    p.message = format!("stamp my passport: {a}");
    cases.push(("message: lowercase", p));
    let mut p = good.clone();
    p.message.push(' ');
    cases.push(("message: trailing space", p));
    let mut p = good.clone();
    p.message = format!("Stamp my passport: {}", vector_account("b"));
    cases.push(("message: another account", p));
    for at in [0, 31] {
        let mut p = good.clone();
        p.nonce = flip_b64(&good.nonce, at);
        cases.push(("nonce: one bit", p));
    }
    for at in [0, 32, 63] {
        let mut p = good.clone();
        p.signature = flip_b64(&good.signature, at);
        cases.push(("signature: one bit", p));
    }
    let mut p = good.clone();
    p.recipient = "other.testnet".into();
    cases.push(("recipient: another", p));
    let mut p = good.clone();
    p.recipient = format!("{} ", good.recipient);
    cases.push(("recipient: trailing space", p));
    for (what, p) in cases {
        let mut s = arrived(&a);
        assert_eq!(try_signature(&mut s, p), ERR_BAD_PROOF, "{what}");
        assert_eq!(stamp_ids(&s, &a), ["arrival"], "{what}");
    }
}

#[test]
fn signature_refuses_another_recipient_or_contract() {
    let a = vector_account("a");
    // Signed for other.testnet: refused as given (not this contract) and with the recipient swapped (bad signature).
    let other = proof("a_for_other_recipient");
    assert_eq!(other.recipient, "other.testnet");
    let mut s = arrived(&a);
    assert_eq!(try_signature(&mut s, other.clone()), ERR_BAD_PROOF);
    let mut swapped = other;
    swapped.recipient = vector_contract();
    assert_eq!(try_signature(&mut s, swapped), ERR_BAD_PROOF);
    // The good proof on a contract deployed at another account: refused there.
    fresh_chain();
    context(&a, &a, T0_MS, "stamps-two.testnet", 0);
    let mut s = Stamps::new();
    collect(&mut s, "arrival");
    assert_eq!(try_signature(&mut s, proof("a.proof")), ERR_BAD_PROOF);
    // Signed with a callbackUrl: the contract verifies with callback_url None.
    let mut s = arrived(&a);
    assert_eq!(try_signature(&mut s, proof("a_with_callback_url")), ERR_BAD_PROOF);
}

#[test]
fn signature_refuses_another_accounts_key_and_a_replay_by_another_account() {
    let a = vector_account("a");
    let b = vector_account("b");
    // A's message signed by B's key, sent by A: not A's key.
    let mut s = arrived(&a);
    assert_eq!(try_signature(&mut s, proof("a_message_signed_by_b")), ERR_BAD_PROOF);
    // A's valid proof replayed by B (or B's sent by A): the message names another account and the key is the caller's.
    let mut s = arrived(&b);
    assert_eq!(try_signature(&mut s, proof("a.proof")), ERR_BAD_PROOF);
    let mut s = arrived(&a);
    assert_eq!(try_signature(&mut s, proof("b.proof")), ERR_BAD_PROOF);
    // B's message with A's signature on it.
    let mut mixed = proof("b.proof");
    mixed.signature = proof("a.proof").signature;
    let mut s = arrived(&b);
    assert_eq!(try_signature(&mut s, mixed), ERR_BAD_PROOF);
    // And after both, each still collects with its own.
    assert_eq!(s.collect("signature".into(), None, Some(proof("b.proof"))).stamp, "signature");
}

#[test]
fn signature_refuses_a_named_account() {
    // A named account's key isn't its account id: refused before any proof is looked at, with or without one.
    let mut s = arrived("alice.testnet");
    assert_eq!(try_signature(&mut s, proof("a.proof")), ERR_NOT_IMPLICIT);
    assert_eq!(panics(|| s.collect("signature".into(), None, None)), ERR_NOT_IMPLICIT);
    // 64 characters but not hex, and an EVM-style implicit account: not NEAR implicit accounts either.
    for named in [format!("{}.testnet", "a".repeat(56)), format!("0x{}", "ab".repeat(20)), "g".repeat(64)] {
        let mut s = arrived(&named);
        assert_eq!(try_signature(&mut s, proof("a.proof")), ERR_NOT_IMPLICIT, "{named}");
    }
}

#[test]
fn signature_refuses_wrong_lengths_and_encodings() {
    let a = vector_account("a");
    let good = proof("a.proof");
    let nonce = BASE64.decode(&good.nonce).unwrap();
    let sig = BASE64.decode(&good.signature).unwrap();
    let with = |n: Option<String>, s: Option<String>| SignatureProof { nonce: n.unwrap_or(good.nonce.clone()), signature: s.unwrap_or(good.signature.clone()), ..good.clone() };
    let unpadded = good.signature.trim_end_matches('=').to_string();
    let urlsafe = good.signature.replace('+', "-").replace('/', "_");
    assert_ne!(urlsafe, good.signature, "the vector's signature has a + or / to test base64url");
    let cases = [
        ("nonce 31 bytes", with(Some(BASE64.encode(&nonce[..31])), None)),
        ("nonce 33 bytes", with(Some(BASE64.encode([nonce.clone(), vec![0]].concat())), None)),
        ("nonce empty", with(Some(String::new()), None)),
        ("nonce hex", with(Some(nonce.iter().map(|b| format!("{b:02x}")).collect()), None)),
        ("signature 63 bytes", with(None, Some(BASE64.encode(&sig[..63])))),
        ("signature 65 bytes", with(None, Some(BASE64.encode([sig.clone(), vec![0]].concat())))),
        ("signature unpadded", with(None, Some(unpadded))),
        ("signature base64url", with(None, Some(urlsafe))),
        ("signature with a newline", with(None, Some(format!("{}\n", good.signature)))),
        ("signature long", with(None, Some("A".repeat(100_000)))),
    ];
    for (what, p) in cases {
        let mut s = arrived(&a);
        assert_eq!(try_signature(&mut s, p), ERR_BAD_PROOF, "{what}");
    }
    let mut s = arrived(&a);
    assert_eq!(panics(|| s.collect("signature".into(), None, None)), ERR_BAD_PROOF, "no proof");
}

#[test]
fn nep413_bytes_are_the_tag_and_borsh_payload() {
    let nonce: [u8; 32] = core::array::from_fn(|i| i as u8);
    let bytes = nep413_bytes("hi", nonce, "x.testnet");
    let mut want = (2u32.pow(31) + 413).to_le_bytes().to_vec();
    want.extend(2u32.to_le_bytes());
    want.extend(b"hi");
    want.extend(nonce);
    want.extend(9u32.to_le_bytes());
    want.extend(b"x.testnet");
    want.push(0);
    assert_eq!(bytes, want);
}

#[test]
fn implicit_public_key_reads_only_lowercase_hex_of_64() {
    let id = vector_account("a");
    let key = implicit_public_key(&account(&id)).unwrap();
    assert_eq!(key.iter().map(|b| format!("{b:02x}")).collect::<String>(), id);
    assert_eq!(implicit_public_key(&account(&"0".repeat(64))), Some([0; 32]));
    for named in ["alice.testnet".to_string(), "a".repeat(63), format!("{}.testnet", "a".repeat(56)), "g".repeat(64)] {
        assert_eq!(implicit_public_key(&account(&named)), None, "{named}");
    }
}

// ---------------------------------------------------------------------------------------------------------------
// postcard.

#[test]
fn postcard_stores_the_trimmed_note() {
    let mut s = arrived("alice.testnet");
    let got = s.collect("postcard".into(), Some("  greetings from <b>NEAR</b> \n".into()), None);
    assert_eq!(got.note.as_deref(), Some("greetings from <b>NEAR</b>"));
    assert_eq!(s.get_passport(account("alice.testnet")).unwrap().stamps[1], got);
}

#[test]
fn postcard_takes_1_to_140_characters_after_trimming() {
    for ok in ["x".to_string(), "x".repeat(MAX_NOTE_CHARS), "🌸".repeat(MAX_NOTE_CHARS), format!("\t {} \n", "é".repeat(MAX_NOTE_CHARS))] {
        let mut s = arrived("alice.testnet");
        let note = s.collect("postcard".into(), Some(ok.clone()), None).note.unwrap();
        assert_eq!(note, ok.trim());
        assert_eq!(note.chars().count(), ok.trim().chars().count());
    }
    let mut s = arrived("alice.testnet");
    for bad in [None, Some(String::new()), Some(" \t\n\r\u{a0}\u{3000} ".into()), Some("x".repeat(MAX_NOTE_CHARS + 1)), Some("🌸".repeat(MAX_NOTE_CHARS + 1))] {
        assert_eq!(panics(|| s.collect("postcard".into(), bad.clone(), None)), ERR_BAD_NOTE, "{bad:?}");
    }
    assert_eq!(stamp_ids(&s, "alice.testnet"), ["arrival"]);
}

// ---------------------------------------------------------------------------------------------------------------
// layover.

#[test]
fn layover_needs_120_seconds_after_arrival() {
    let mut s = setup();
    arrive(&mut s, "alice.testnet");
    for early in [0, 1, LAYOVER_MS - 1] {
        relayed("alice.testnet", T0_MS + early);
        assert_eq!(panics(|| collect(&mut s, "layover")), ERR_TOO_SOON, "{early}");
    }
    // A clock before the arrival (it can't go back on chain) is too soon too, not an overflow.
    relayed("alice.testnet", T0_MS - 1);
    assert_eq!(panics(|| collect(&mut s, "layover")), ERR_TOO_SOON);
    // Measured from arrival, not from the latest stamp.
    relayed("alice.testnet", T0_MS + LAYOVER_MS - 10);
    collect(&mut s, "sponsored");
    relayed("alice.testnet", T0_MS + LAYOVER_MS);
    let got = collect(&mut s, "layover");
    assert_eq!(got, StampView { stamp: "layover".into(), block_timestamp_ms: T0_MS + LAYOVER_MS, sponsored: true, note: None });
    // Directly signed works as well.
    let mut s = setup();
    arrive(&mut s, "bob.testnet");
    direct("bob.testnet", T0_MS + 3 * LAYOVER_MS);
    assert!(!collect(&mut s, "layover").sponsored);
}

// ---------------------------------------------------------------------------------------------------------------
// recent, totals, refusals.

#[test]
fn a_refused_collect_changes_nothing() {
    let mut s = setup();
    arrive(&mut s, "alice.testnet");
    let before = (s.get_passport(account("alice.testnet")), s.recent(None, None), s.totals());
    direct("alice.testnet", T0_MS + 1);
    for (stamp, note) in [("sponsored", None), ("postcard", Some("   ")), ("layover", None), ("nope", None)] {
        assert!(catch_unwind(AssertUnwindSafe(|| s.collect(stamp.into(), note.map(String::from), None))).is_err());
    }
    assert_eq!((s.get_passport(account("alice.testnet")), s.recent(None, None), s.totals()), before);
}

/// `n` passports `u<i>.testnet`, each arriving at T0_MS + i: n stamps.
fn arrivals(s: &mut Stamps, from: u64, n: u64) {
    for i in from..from + n {
        direct(&format!("u{i}.testnet"), T0_MS + i);
        collect(s, "arrival");
    }
}

#[test]
fn recent_lists_newest_first_capped_at_fifty() {
    let mut s = setup();
    arrivals(&mut s, 0, 5);
    let all = s.recent(None, None);
    assert_eq!(all.iter().map(|r| r.account_id.to_string()).collect::<Vec<_>>(), ["u4.testnet", "u3.testnet", "u2.testnet", "u1.testnet", "u0.testnet"]);
    assert_eq!(all[0], RecentView { account_id: account("u4.testnet"), stamp: "arrival".into(), block_timestamp_ms: T0_MS + 4 });
    assert_eq!(s.recent(Some(1), Some(2)).iter().map(|r| r.block_timestamp_ms).collect::<Vec<_>>(), [T0_MS + 3, T0_MS + 2]);
    assert_eq!(s.recent(Some(4), Some(10)).len(), 1);
    assert_eq!(s.recent(Some(5), None), vec![]);
    assert_eq!(s.recent(Some(u64::MAX), Some(MAX_LIMIT)), vec![]);
    assert_eq!(s.recent(None, Some(0)), vec![]);
    arrivals(&mut s, 5, 60);
    assert_eq!(s.recent(None, None).len(), 50);
    assert_eq!(s.recent(None, Some(51)).len(), 50);
    assert_eq!(s.recent(None, Some(u32::MAX)).len(), 50);
    assert_eq!(s.recent(Some(20), Some(u32::MAX)).len(), 45);
}

#[test]
fn the_ring_keeps_the_latest_hundred() {
    let mut s = setup();
    arrivals(&mut s, 0, 100);
    assert_eq!(s.recent(Some(99), None)[0].account_id.as_str(), "u0.testnet");
    arrivals(&mut s, 100, 137);
    assert_eq!(s.totals(), Totals { passports: 237, stamps: 237 });
    let mut kept = s.recent(None, None);
    kept.extend(s.recent(Some(50), None));
    assert_eq!(kept.len(), 100);
    let want: Vec<String> = (137..237).rev().map(|i| format!("u{i}.testnet")).collect();
    assert_eq!(kept.iter().map(|r| r.account_id.to_string()).collect::<Vec<_>>(), want);
    assert!(kept.iter().all(|r| r.block_timestamp_ms == T0_MS + r.account_id.as_str()[1..].trim_end_matches(".testnet").parse::<u64>().unwrap()));
    assert_eq!(s.recent(Some(100), None), vec![]);
    // Every passport is still there, ring or not.
    assert_eq!(stamp_ids(&s, "u0.testnet"), ["arrival"]);
}

#[test]
fn recent_mixes_accounts_and_stamps_in_order() {
    let mut s = setup();
    arrive(&mut s, "alice.testnet");
    arrive(&mut s, "bob.testnet");
    relayed("alice.testnet", T0_MS + 1);
    collect(&mut s, "sponsored");
    let got: Vec<(String, String)> = s.recent(None, None).into_iter().map(|r| (r.account_id.to_string(), r.stamp)).collect();
    assert_eq!(got, [("alice.testnet".to_string(), "sponsored".to_string()), ("bob.testnet".into(), "arrival".into()), ("alice.testnet".into(), "arrival".into())]);
}

// ---------------------------------------------------------------------------------------------------------------
// Storage bounds: what one passport and the ring can cost the contract account.

/// Runs `f` as `who` signed by `signer` at `at`, carrying the storage counter `usage` over (`testing_env!` resets it);
/// writes the collections' caches as the end of a wasm call would, and returns the new usage.
fn step(s: &mut Stamps, who: &str, signer: &str, at: u64, usage: u64, f: impl FnOnce(&mut Stamps)) -> u64 {
    context(who, signer, at, &vector_contract(), usage);
    f(s);
    s.passports.flush();
    s.recent.flush();
    env::storage_usage()
}

/// Collects all six stamps for the vector's account A, the largest (a 64-character account id and a postcard of 140
/// four-byte characters). Returns the storage usage after it.
fn largest_passport(s: &mut Stamps, usage: u64) -> u64 {
    let a = vector_account("a");
    let mut u = usage;
    u = step(s, &a, &a, T0_MS, u, |s| drop(collect(s, "arrival")));
    u = step(s, &a, RELAYER, T0_MS, u, |s| drop(collect(s, "sponsored")));
    u = step(s, &a, &a, T0_MS, u, |s| drop(collect(s, "own_fare")));
    u = step(s, &a, RELAYER, T0_MS, u, |s| drop(s.collect("signature".into(), None, Some(proof("a.proof")))));
    u = step(s, &a, RELAYER, T0_MS, u, |s| drop(s.collect("postcard".into(), Some("🌸".repeat(MAX_NOTE_CHARS)), None)));
    step(s, &a, RELAYER, T0_MS + LAYOVER_MS, u, |s| drop(collect(s, "layover")))
}

#[test]
fn storage_per_passport_and_ring_is_bounded() {
    let mut s = setup();
    s.recent.flush();
    let base = env::storage_usage();
    let after_a = largest_passport(&mut s, base);
    let passport = after_a - base;
    assert_eq!(stamp_ids(&s, &vector_account("a")), CATALOG);
    // One passport, its six stamps and six ring entries (the ring isn't full yet).
    assert!(passport > 1_000 && passport < 2_000, "the largest passport took {passport} bytes");
    // Fill the ring with the largest entries (64-character accounts), then measure that it stops growing.
    let arrive_as = |s: &mut Stamps, i: u64, usage: u64| {
        let who = format!("{i:064x}");
        step(s, &who, &who, T0_MS, usage, |s| drop(collect(s, "arrival")))
    };
    let mut usage = after_a;
    for i in 0..u64::from(KEEP_RECENT) - 6 {
        usage = arrive_as(&mut s, i, usage);
    }
    assert_eq!(s.recent.len(), KEEP_RECENT);
    let full = usage;
    // Past the ring: each new arrival adds its passport only (the ring entry replaces the oldest in place).
    usage = arrive_as(&mut s, 1_000, usage);
    let arrival_only = usage - full;
    usage = arrive_as(&mut s, 1_001, usage);
    assert_eq!(usage - full, 2 * arrival_only, "a full ring replaces in place");
    let ring_and_arrivals = full - base;
    println!(
        "storage: largest passport (6 stamps, 140 four-byte note, 64-char account) {passport} bytes incl. 6 ring entries; \
         an arrival-only passport {arrival_only} bytes once the ring is full; the full ring of 100 with 95 passports {ring_and_arrivals} bytes"
    );
    assert!(arrival_only > 100 && arrival_only < 250, "{arrival_only}");
}

// ---------------------------------------------------------------------------------------------------------------
// The order of the checks (README "Rules"): the stamp id; a note or proof that belongs to another stamp; arrival first
// and once each; then the stamp's own rule. So a postcard without a note, or a signature without a proof, is refused
// for the passport (ERR_NO_ARRIVAL, ERR_ALREADY) before its own argument is looked at.

#[test]
fn checks_run_in_the_documented_order() {
    let mut s = setup();
    let a = vector_account("a");
    relayed(&a, T0_MS);
    // Before arrival: the id, then a foreign argument, then ERR_NO_ARRIVAL before the stamp's own rule.
    assert_eq!(panics(|| s.collect("nope".into(), Some("note".into()), Some(proof("a.proof")))), ERR_UNKNOWN_STAMP);
    assert_eq!(panics(|| s.collect("sponsored".into(), Some("note".into()), Some(proof("a.proof")))), ERR_BAD_NOTE);
    assert_eq!(panics(|| s.collect("sponsored".into(), None, Some(proof("a.proof")))), ERR_BAD_PROOF);
    assert_eq!(panics(|| s.collect("postcard".into(), None, None)), ERR_NO_ARRIVAL);
    assert_eq!(panics(|| s.collect("postcard".into(), Some(String::new()), None)), ERR_NO_ARRIVAL);
    assert_eq!(panics(|| s.collect("signature".into(), None, None)), ERR_NO_ARRIVAL);
    assert_eq!(panics(|| s.collect("layover".into(), None, None)), ERR_NO_ARRIVAL);
    collect(&mut s, "arrival");
    // Once held: ERR_ALREADY before the stamp's own rule.
    s.collect("postcard".into(), Some("hello".into()), None);
    assert_eq!(panics(|| s.collect("postcard".into(), Some(String::new()), None)), ERR_ALREADY);
    assert_eq!(panics(|| s.collect("postcard".into(), None, None)), ERR_ALREADY);
    s.collect("signature".into(), None, Some(proof("a.proof")));
    assert_eq!(panics(|| s.collect("signature".into(), None, None)), ERR_ALREADY);
    // A note on another stamp is refused even when that stamp is already held.
    assert_eq!(panics(|| s.collect("signature".into(), Some("x".into()), None)), ERR_BAD_NOTE);
    // The stamp's own rule last: a named account's signature is ERR_NOT_IMPLICIT with or without a proof.
    arrive(&mut s, "alice.testnet");
    relayed("alice.testnet", T0_MS + 1);
    assert_eq!(panics(|| s.collect("signature".into(), None, None)), ERR_NOT_IMPLICIT);
    assert_eq!(panics(|| s.collect("signature".into(), None, Some(proof("a.proof")))), ERR_NOT_IMPLICIT);
    assert_eq!(panics(|| s.collect("layover".into(), None, None)), ERR_TOO_SOON);
}

#[test]
fn invisible_control_and_bidi_notes_are_stored_as_given_and_read_back_as_json() {
    let mut s = setup();
    let who = "bob.testnet";
    arrive(&mut s, who);
    relayed(who, T0_MS + 1);
    // U+FEFF and U+200B are not White_Space (kept by trim); NUL, RLO and other controls are characters like any other.
    let note = format!("\u{FEFF}{}\u{202E}\u{0000}\u{0007}", "\u{200B}".repeat(136));
    let stored = s.collect("postcard".into(), Some(note.clone()), None);
    assert_eq!(stored.note.as_deref(), Some(note.as_str()));
    let json = serde_json::to_string(&s.get_passport(account(who))).unwrap();
    let back: Value = serde_json::from_str(&json).unwrap();
    assert_eq!(back["stamps"][1]["note"].as_str(), Some(note.as_str()));
    // 141 invisible characters are one too many.
    let mut t = setup();
    arrive(&mut t, who);
    relayed(who, T0_MS + 1);
    assert_eq!(panics(|| t.collect("postcard".into(), Some("\u{200B}".repeat(141)), None)), ERR_BAD_NOTE);
}
