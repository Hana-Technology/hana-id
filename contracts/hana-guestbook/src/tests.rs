//! Unit tests (mocked blockchain). The sandbox tests (`contracts/integration-tests/tests/guestbook.rs`) cover the
//! deployed wasm: deposits refused, implicit accounts, meta transactions and gas.

use near_sdk::test_utils::VMContextBuilder;
use near_sdk::{env, testing_env, AccountId};

use crate::*;

const T0_MS: u64 = 1_800_000_000_000;

fn account(name: &str) -> AccountId {
    name.parse().unwrap()
}

fn as_caller(who: &str, now_ms: u64) {
    testing_env!(VMContextBuilder::new().current_account_id(account("guestbook.testnet")).predecessor_account_id(account(who)).signer_account_id(account(who)).block_timestamp(now_ms * 1_000_000).build());
}

fn setup() -> Guestbook {
    as_caller("deployer.testnet", T0_MS);
    Guestbook::new()
}

/// Adds `n` messages "m<i>" from alice, one per millisecond after T0_MS.
fn fill(g: &mut Guestbook, n: u64) {
    let start = g.total_messages();
    for i in start..start + n {
        as_caller("alice.testnet", T0_MS + i);
        g.add_message(format!("m{i}"));
    }
}

fn texts(list: &[Message]) -> Vec<String> {
    list.iter().map(|m| m.text.clone()).collect()
}

fn indexes(list: &[Message]) -> Vec<u64> {
    list.iter().map(|m| m.index).collect()
}

#[test]
fn starts_empty() {
    let g = setup();
    assert_eq!(g.total_messages(), 0);
    assert_eq!(g.get_messages(None, None), vec![]);
    assert_eq!(g.get_messages(Some(0), Some(50)), vec![]);
}

#[test]
fn add_stores_predecessor_trimmed_text_and_time() {
    let mut g = setup();
    // The predecessor counts, not the signer (a relayed call's signer is the relayer).
    testing_env!(VMContextBuilder::new()
        .current_account_id(account("guestbook.testnet"))
        .predecessor_account_id(account("user.testnet"))
        .signer_account_id(account("relayer.testnet"))
        .block_timestamp((T0_MS + 5) * 1_000_000)
        .build());
    let added = g.add_message("  hello, NEAR \n\t".to_string());
    let want = Message { index: 0, account_id: account("user.testnet"), text: "hello, NEAR".to_string(), block_timestamp_ms: T0_MS + 5 };
    assert_eq!(added, want);
    assert_eq!(g.total_messages(), 1);
    assert_eq!(g.get_messages(None, None), vec![want]);
}

#[test]
fn implicit_account_is_the_author() {
    let mut g = setup();
    let implicit = "0f".repeat(32);
    as_caller(&implicit, T0_MS);
    assert_eq!(g.add_message("gm".to_string()).account_id.as_str(), implicit);
}

#[test]
fn keeps_inner_whitespace_and_markup_as_given() {
    let mut g = setup();
    as_caller("alice.testnet", T0_MS);
    let text = "a  b\nc <script>alert(1)</script> &amp;";
    assert_eq!(g.add_message(format!(" {text} ")).text, text);
}

#[test]
#[should_panic(expected = "Guestbook: text is empty after trimming")]
fn empty_text_is_refused() {
    let mut g = setup();
    g.add_message(String::new());
}

#[test]
#[should_panic(expected = "Guestbook: text is empty after trimming")]
fn whitespace_only_text_is_refused() {
    let mut g = setup();
    // Spaces, tab, newline, carriage return, no-break space, ideographic space: Unicode White_Space.
    g.add_message(" \t\n\r\u{a0}\u{3000} ".to_string());
}

#[test]
fn two_hundred_characters_are_accepted() {
    let mut g = setup();
    let ascii = "x".repeat(MAX_TEXT_CHARS);
    assert_eq!(g.add_message(ascii.clone()).text, ascii);
    // Characters, not bytes: 200 four-byte characters (800 bytes) are accepted.
    let emoji = "🌸".repeat(MAX_TEXT_CHARS);
    assert_eq!(emoji.len(), 800);
    assert_eq!(g.add_message(emoji.clone()).text, emoji);
    // Whitespace around a 200-character text doesn't count.
    assert_eq!(g.add_message(format!("   {ascii}\n\n")).text, ascii);
    assert_eq!(g.total_messages(), 3);
}

#[test]
#[should_panic(expected = "Guestbook: text is longer than 200 characters after trimming")]
fn two_hundred_and_one_characters_are_refused() {
    let mut g = setup();
    g.add_message("x".repeat(MAX_TEXT_CHARS + 1));
}

#[test]
#[should_panic(expected = "Guestbook: text is longer than 200 characters after trimming")]
fn two_hundred_and_one_multibyte_characters_are_refused() {
    let mut g = setup();
    g.add_message("é".repeat(MAX_TEXT_CHARS + 1));
}

#[test]
fn a_refused_message_changes_nothing() {
    let mut g = setup();
    fill(&mut g, 3);
    let before = g.get_messages(None, None);
    let r = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| g.add_message("   ".to_string())));
    assert!(r.is_err());
    assert_eq!(g.total_messages(), 3);
    assert_eq!(g.get_messages(None, None), before);
}

#[test]
fn lists_newest_first_with_history_indexes() {
    let mut g = setup();
    fill(&mut g, 5);
    let all = g.get_messages(None, None);
    assert_eq!(texts(&all), ["m4", "m3", "m2", "m1", "m0"]);
    assert_eq!(indexes(&all), [4, 3, 2, 1, 0]);
    assert_eq!(all[0].block_timestamp_ms, T0_MS + 4);
    assert_eq!(texts(&g.get_messages(Some(1), Some(2))), ["m3", "m2"]);
    assert_eq!(texts(&g.get_messages(Some(4), Some(10))), ["m0"]);
    assert_eq!(g.get_messages(Some(5), None), vec![]);
    assert_eq!(g.get_messages(Some(u64::MAX), Some(MAX_LIMIT)), vec![]);
    assert_eq!(g.get_messages(None, Some(0)), vec![]);
}

#[test]
fn limit_is_capped_at_fifty() {
    let mut g = setup();
    fill(&mut g, 60);
    assert_eq!(g.get_messages(None, None).len(), 50);
    assert_eq!(g.get_messages(None, Some(51)).len(), 50);
    assert_eq!(g.get_messages(None, Some(u32::MAX)).len(), 50);
    assert_eq!(g.get_messages(Some(10), Some(u32::MAX)).len(), 40);
}

#[test]
fn the_ring_keeps_the_latest_fifty() {
    let mut g = setup();
    fill(&mut g, 50);
    assert_eq!(g.total_messages(), 50);
    assert_eq!(indexes(&g.get_messages(None, None)), (0..50).rev().collect::<Vec<u64>>());

    // The 51st replaces the oldest (m0).
    fill(&mut g, 1);
    assert_eq!(g.total_messages(), 51);
    let kept = g.get_messages(None, None);
    assert_eq!(kept.len(), 50);
    assert_eq!(indexes(&kept), (1..51).rev().collect::<Vec<u64>>());
    assert_eq!(kept[0].text, "m50");
    assert_eq!(kept[49].text, "m1");

    // Many laps later the order and indexes still hold.
    fill(&mut g, 137);
    assert_eq!(g.total_messages(), 188);
    let kept = g.get_messages(None, None);
    assert_eq!(indexes(&kept), (138..188).rev().collect::<Vec<u64>>());
    assert!(kept.iter().all(|m| m.text == format!("m{}", m.index) && m.block_timestamp_ms == T0_MS + m.index));
    assert_eq!(texts(&g.get_messages(Some(48), Some(5))), ["m139", "m138"]);
}

#[test]
fn storage_stops_growing_at_fifty_messages() {
    let mut g = setup();
    // The largest message: a 64-character account id and 200 four-byte characters. One context for the whole test:
    // `testing_env!` resets the storage usage counter.
    let long_account = format!("{}.testnet", "a".repeat(56));
    assert_eq!(long_account.len(), 64);
    as_caller(&long_account, T0_MS);
    g.messages.flush();
    let base = env::storage_usage();
    let largest = "🌸".repeat(MAX_TEXT_CHARS);
    for _ in 0..KEEP_MESSAGES {
        g.add_message(largest.clone());
    }
    // The collection writes its cache at the end of a wasm call; here, by hand.
    g.messages.flush();
    let full = env::storage_usage();
    for _ in 0..(3 * KEEP_MESSAGES) {
        g.add_message(largest.clone());
    }
    g.messages.flush();
    assert_eq!(env::storage_usage(), full, "a full ring replaces in place");
    let used = full - base;
    assert!(used > 40_000 && used < 50_000, "50 largest messages took {used} bytes");
    println!("storage: {used} bytes for the 50 largest messages ({} each)", used / u64::from(KEEP_MESSAGES));
}
