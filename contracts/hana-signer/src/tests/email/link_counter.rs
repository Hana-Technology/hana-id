//! Link volume: the hourly counter of new links and its alarm thresholds (D200, `src/link_counter.rs`). Nothing here
//! is ever refused.

use super::*;
use crate::link_counter::{window_start, LinkThresholds};

fn link_stats(c: &HanaSigner) -> Value {
    serde_json::to_value(c.get_link_stats()).unwrap()
}

/// A case-B automatic link of a fresh email identity `e` to Google user `g` (who gets a wallet first), in s1 at
/// NOW_MS: two logins, one new link. Seeds `seed` and `seed + 1`.
fn case_b_link(c: &mut HanaSigner, g: &str, e: &str, seed: u8) {
    google_wallet(c, g, seed);
    login(c, g_session(g, seed + 1), seed + 1, Some(auto_link_tok(e, seed + 1, &gik(g), 0, true, jb(g))), Some(true));
}

/// A case-A automatic link: email identity `e` gets a wallet, then Google user `g`'s first login joins it. Seeds
/// `seed` and `seed + 1`.
fn case_a_link(c: &mut HanaSigner, g: &str, e: &str, seed: u8) {
    email_wallet(c, e, seed);
    login(c, g_session(g, seed + 1), seed + 1, Some(auto_link_tok(e, seed + 1, &gik(g), 0, true, ja(e))), Some(true));
}

#[test]
fn link_stats_start_empty_with_the_default_thresholds() {
    let mut c = email_setup();
    ctx(ANYONE, NOW_MS + 5);
    assert_eq!(
        link_stats(&c),
        json!({
            "window_ms": 3_600_000,
            "thresholds": {"per_scope_per_hour": 50, "total_per_hour": 500},
            "pending_thresholds": null,
            "links_total": 0,
            "current": {"window_start_ms": window_start(NOW_MS + 5), "total": 0, "total_threshold_reached": false, "flagged_scopes": []},
            "previous": null
        })
    );
    // Logins without a link count nothing.
    google_wallet(&mut c, G, 7);
    assert_eq!(link_stats(&c)["links_total"], json!(0));
}

#[test]
fn every_new_link_is_counted_and_nothing_else() {
    let mut c = email_setup();
    let (e, e2, e3) = (esub("one@gmail.com"), esub("two@corp.example"), esub("three@gmail.com"));
    // A combined login with a link_jwt, case B (the email identity joins the Google wallet)...
    case_b_link(&mut c, G, &e, 7);
    assert_eq!((link_stats(&c)["links_total"].clone(), link_stats(&c)["current"]["total"].clone()), (json!(1), json!(1)));
    // ...and case A (the Google identity joins the email wallet).
    case_a_link(&mut c, "g-carol", &e3, 11);
    assert_eq!(c.get_identity("s1".into(), "google".into(), "g-carol".into()).status, "member");
    assert_eq!(link_stats(&c)["links_total"], json!(2));
    // link_identity (pending).
    google_wallet(&mut c, G2, 9);
    link_email_to_google(&mut c, G2, &e2, 0, RELAYER);
    assert_eq!(link_stats(&c)["links_total"], json!(3));
    // Cancelling it doesn't count; linking it again does; its lazy activation and an unlink don't.
    ctx(RELAYER, NOW_MS);
    c.cancel_link("s1".into(), change_tok_google(G2, "cancel", &gik(G2), &eik(&e2), 1), h(&eik(&e2)), 1, SALT.to_vec());
    assert_eq!(link_stats(&c)["links_total"], json!(3));
    link_email_to_google(&mut c, G2, &e2, 2, RELAYER);
    assert_eq!(link_stats(&c)["links_total"], json!(4));
    login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e2, 10, NOW_MS + DELAY_MS), 10, None, None);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e2.clone()).status, "member");
    ctx(RELAYER, NOW_MS + DELAY_MS);
    c.unlink_identity("s1".into(), change_tok_google(G2, "unlink", &gik(G2), &eik(&e2), 3), h(&eik(&e2)), 3, SALT.to_vec());
    let stats = link_stats(&c);
    assert_eq!(stats["links_total"], json!(4));
    // DELAY_MS is an hour: the activation and the unlink fell in the next window, which counted nothing.
    assert_eq!((stats["current"]["total"].clone(), stats["previous"]["total"].clone()), (json!(0), json!(4)));
}

#[test]
fn a_scope_at_its_threshold_is_flagged_once_and_still_links() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_thresholds(2, 100);
    let start = window_start(NOW_MS);
    case_b_link(&mut c, G, &esub("a@gmail.com"), 7);
    assert!(events_named("link_threshold_reached").is_empty());
    // The link that makes the count reach the threshold records it.
    case_b_link(&mut c, G2, &esub("b@gmail.com"), 9);
    assert_eq!(events_named("link_threshold_reached"), vec![json!({"scope_id": "s1", "window_start_ms": start, "count": 2})]);
    assert_eq!(link_stats(&c)["current"], json!({"window_start_ms": start, "total": 2, "total_threshold_reached": false, "flagged_scopes": ["s1"]}));
    // Over the threshold links still go through, by either path; the scope stays flagged once, with no new event.
    let e = esub("c@gmail.com");
    case_b_link(&mut c, "g-carol", &e, 11);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e).status, "member");
    google_wallet(&mut c, "g-dave", 13);
    link_email_to_google(&mut c, "g-dave", &esub("d@corp.example"), 0, RELAYER);
    assert!(events_named("link_threshold_reached").is_empty());
    assert_eq!(c.link_counter.scope_counts.get("s1").map(|r| r.count), Some(4));
    assert_eq!(link_stats(&c)["current"], json!({"window_start_ms": start, "total": 4, "total_threshold_reached": false, "flagged_scopes": ["s1"]}));
    // An hour later the count restarts; the flagged hour is the previous window.
    ctx(RELAYER, NOW_MS + HOUR_MS);
    c.count_link("s1");
    let stats = link_stats(&c);
    assert_eq!(stats["current"], json!({"window_start_ms": start + HOUR_MS, "total": 1, "total_threshold_reached": false, "flagged_scopes": []}));
    assert_eq!(stats["previous"], json!({"window_start_ms": start, "total": 4, "total_threshold_reached": false, "flagged_scopes": ["s1"]}));
}

#[test]
fn the_total_threshold_is_recorded_once_per_window() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_thresholds(100, 2);
    let start = window_start(NOW_MS);
    case_b_link(&mut c, G, &esub("a@gmail.com"), 7);
    ctx(RELAYER, NOW_MS);
    c.count_link("s2");
    assert_eq!(events_named("link_threshold_reached"), vec![json!({"scope_id": null, "window_start_ms": start, "count": 2})]);
    assert_eq!(link_stats(&c)["current"]["total_threshold_reached"], json!(true));
    // More links: no second event; a linked login over the threshold succeeds.
    ctx(RELAYER, NOW_MS);
    c.count_link("s3");
    assert!(events_named("link_threshold_reached").is_empty());
    let e = esub("b@gmail.com");
    case_b_link(&mut c, G2, &e, 9);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e).status, "member");
    assert_eq!(link_stats(&c)["current"]["total"], json!(4));
}

#[test]
fn a_lowered_threshold_shows_at_once_and_records_at_the_next_link() {
    let mut c = email_setup();
    ctx(RELAYER, NOW_MS);
    for scope in ["s1", "s1", "s1", "s2"] {
        c.count_link(scope);
    }
    assert_eq!(link_stats(&c)["current"]["total_threshold_reached"], json!(false));
    // Lowering the total below the count shows it reached in the view at once (computed); no event yet.
    ctx(ADMIN, NOW_MS);
    c.set_link_thresholds(2, 3);
    assert_eq!(link_stats(&c)["current"]["total_threshold_reached"], json!(true));
    assert!(events_named("link_threshold_reached").is_empty());
    assert_eq!(link_stats(&c)["current"]["flagged_scopes"], json!([]));
    // The next link records both (>=, not ==): s1 is at 4 ≥ 2, the total at 5 ≥ 3.
    ctx(RELAYER, NOW_MS);
    c.count_link("s1");
    let start = window_start(NOW_MS);
    assert_eq!(
        events_named("link_threshold_reached"),
        vec![json!({"scope_id": "s1", "window_start_ms": start, "count": 4}), json!({"scope_id": null, "window_start_ms": start, "count": 5})]
    );
    assert_eq!(link_stats(&c)["current"]["flagged_scopes"], json!(["s1"]));
    assert!(c.link_counter.current.as_ref().unwrap().total_threshold_reached);
}

#[test]
fn windows_roll_over_and_old_scope_counts_are_deleted() {
    let mut c = email_setup();
    let start = window_start(NOW_MS);
    ctx(RELAYER, NOW_MS + 10);
    c.count_link("sa");
    c.count_link("sb");
    c.count_link("sa");
    // A view in a later hour shows the rollover without a write.
    ctx(ANYONE, NOW_MS + HOUR_MS);
    let stats = link_stats(&c);
    assert_eq!((stats["current"]["window_start_ms"].clone(), stats["current"]["total"].clone()), (json!(start + HOUR_MS), json!(0)));
    assert_eq!((stats["previous"]["window_start_ms"].clone(), stats["previous"]["total"].clone()), (json!(start), json!(3)));
    ctx(ANYONE, NOW_MS + 2 * HOUR_MS);
    assert_eq!(link_stats(&c)["previous"], Value::Null, "an hour without links in between");
    // A link in the next hour keeps the previous window's per-scope counts...
    ctx(RELAYER, NOW_MS + HOUR_MS);
    c.count_link("sc");
    assert!(c.link_counter.scope_counts.get("sa").is_some() && c.link_counter.scope_counts.get("sb").is_some());
    // ...an hour later they're older than the previous window and the next link deletes them (sc, from the previous
    // window, stays).
    ctx(RELAYER, NOW_MS + 2 * HOUR_MS);
    c.count_link("sd");
    assert!(c.link_counter.scope_counts.get("sa").is_none() && c.link_counter.scope_counts.get("sb").is_none());
    assert_eq!(c.link_counter.scope_counts.get("sc").map(|r| r.window_start_ms), Some(start + HOUR_MS));
    assert_eq!((c.link_counter.gc_head, c.link_counter.gc_tail), (2, 4));
    // A scope's count and flag restart in a new hour.
    ctx(ADMIN, NOW_MS + 2 * HOUR_MS);
    c.set_link_thresholds(1, 100);
    ctx(RELAYER, NOW_MS + 2 * HOUR_MS);
    c.count_link("sd");
    assert_eq!(c.link_counter.scope_counts.get("sd").map(|r| (r.count, r.flagged)), Some((2, true)));
    ctx(RELAYER, NOW_MS + 3 * HOUR_MS);
    c.count_link("sd");
    assert_eq!(c.link_counter.scope_counts.get("sd").map(|r| (r.window_start_ms, r.count)), Some((start + 3 * HOUR_MS, 1)));
    assert_eq!(link_stats(&c)["current"]["flagged_scopes"], json!(["sd"]));
}

#[test]
fn flagged_scopes_are_bounded_and_de_duplicated() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_thresholds(1, 1000);
    ctx(RELAYER, NOW_MS);
    for i in 0..70 {
        c.count_link(&format!("x{i}"));
        c.count_link(&format!("x{i}"));
    }
    let stats = link_stats(&c);
    let flagged = stats["current"]["flagged_scopes"].as_array().unwrap();
    assert_eq!((flagged.len(), flagged[0].clone(), flagged[63].clone()), (64, json!("x0"), json!("x63")));
    assert_eq!(stats["current"]["flagged_scopes_truncated"], json!(true));
    // One event per scope (its first crossing), also for the ones past the list.
    assert_eq!(events_named("link_threshold_reached").len(), 70);
}

#[test]
fn raising_a_link_threshold_waits_the_governance_delay_lowering_applies_at_once() {
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    expect_panic("Only the owner can do this", || c.set_link_thresholds(10, 10));
    ctx(ADMIN, NOW_MS);
    expect_panic("Link thresholds must be 1 to 100000", || c.set_link_thresholds(0, 10));
    expect_panic("Link thresholds must be 1 to 100000", || c.set_link_thresholds(10, 100_001));
    // Lower: at once.
    c.set_link_thresholds(10, 100);
    assert_eq!((link_stats(&c)["thresholds"].clone(), link_stats(&c)["pending_thresholds"].clone()), (json!({"per_scope_per_hour": 10, "total_per_hour": 100}), Value::Null));
    assert_eq!(events_named("link_thresholds_set").last().unwrap()["effective_at_ms"], json!(NOW_MS));
    // One raised, one lowered: the lowered one applies now, the pair after the governance delay.
    c.set_link_thresholds(20, 50);
    let stats = link_stats(&c);
    assert_eq!(stats["thresholds"], json!({"per_scope_per_hour": 10, "total_per_hour": 50}));
    assert_eq!(stats["pending_thresholds"], json!({"per_scope_per_hour": 20, "total_per_hour": 50, "effective_at_ms": NOW_MS + GOV_DELAY_MS}));
    assert_eq!(
        events_named("link_thresholds_set").last().unwrap(),
        &json!({"per_scope_per_hour": 20, "total_per_hour": 50, "effective_at_ms": NOW_MS + GOV_DELAY_MS, "in_force": {"per_scope_per_hour": 10, "total_per_hour": 50}})
    );
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS - 1);
    assert_eq!(link_stats(&c)["thresholds"]["per_scope_per_hour"], json!(10));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    assert_eq!((link_stats(&c)["thresholds"].clone(), link_stats(&c)["pending_thresholds"].clone()), (json!({"per_scope_per_hour": 20, "total_per_hour": 50}), Value::Null));
    // Counting uses the matured value and folds it in.
    c.count_link("s1");
    assert_eq!(c.link_counter.thresholds, LinkThresholds { per_scope_per_hour: 20, total_per_hour: 50 });
    assert!(c.link_counter.pending.is_none());
    // A new call replaces a scheduled raise; setting what is in force cancels it.
    ctx(ADMIN, NOW_MS + GOV_DELAY_MS);
    c.set_link_thresholds(30, 50);
    assert!(c.link_counter.pending.is_some());
    c.set_link_thresholds(20, 50);
    assert!(c.link_counter.pending.is_none());
    assert_eq!(link_stats(&c)["thresholds"], json!({"per_scope_per_hour": 20, "total_per_hour": 50}));
}

#[test]
fn migrate_starts_the_link_counter_empty_with_the_default_thresholds() {
    ctx_with_storage(ME, NOW_MS, v2_storage());
    let c = HanaSigner::migrate();
    let stats = link_stats(&c);
    assert_eq!(
        (stats["thresholds"].clone(), stats["pending_thresholds"].clone(), stats["links_total"].clone(), stats["previous"].clone()),
        (json!({"per_scope_per_hour": 50, "total_per_hour": 500}), Value::Null, json!(0), Value::Null)
    );
    assert_eq!(stats["current"], json!({"window_start_ms": window_start(NOW_MS), "total": 0, "total_threshold_reached": false, "flagged_scopes": []}));
    assert_eq!((c.link_counter.gc_head, c.link_counter.gc_tail), (0, 0));
}
