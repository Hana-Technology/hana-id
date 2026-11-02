//! Link volume: the hourly counter and cap on new links (D200, `src/link_cap.rs`).

use super::*;
use crate::link_cap::{window_start, LinkLimits};

fn link_stats(c: &HanaSigner) -> Value {
    serde_json::to_value(c.get_link_stats()).unwrap()
}

/// A case-B automatic link of a fresh email identity `e` to Google user `g` (who gets a wallet first), in s1 at
/// NOW_MS: two logins, one new link. Seeds `seed` and `seed + 1`.
fn case_b_link(c: &mut HanaSigner, g: &str, e: &str, seed: u8) {
    google_wallet(c, g, seed);
    login(c, g_session(g, seed + 1), seed + 1, Some(auto_link_tok(e, seed + 1, &gik(g), 0, true, jb(g))), Some(true));
}

#[test]
fn link_stats_start_empty_with_the_default_limits() {
    let mut c = email_setup();
    ctx(ANYONE, NOW_MS + 5);
    assert_eq!(
        link_stats(&c),
        json!({
            "window_ms": 3_600_000,
            "limits": {"per_scope_per_hour": 50, "total_per_hour": 500},
            "pending_limits": null,
            "links_total": 0,
            "current": {"window_start_ms": window_start(NOW_MS + 5), "total": 0, "total_cap_reached": false, "capped_scopes": []},
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
    let (e, e2) = (esub("one@gmail.com"), esub("two@corp.example"));
    // A combined login with a link_jwt (case B at once).
    case_b_link(&mut c, G, &e, 7);
    assert_eq!((link_stats(&c)["links_total"].clone(), link_stats(&c)["current"]["total"].clone()), (json!(1), json!(1)));
    // link_identity (pending).
    google_wallet(&mut c, G2, 9);
    link_email_to_google(&mut c, G2, &e2, 0, RELAYER);
    assert_eq!(link_stats(&c)["links_total"], json!(2));
    // Cancelling it doesn't count; linking it again does; its lazy activation and an unlink don't.
    ctx(RELAYER, NOW_MS);
    c.cancel_link("s1".into(), change_tok_google(G2, "cancel", &gik(G2), &eik(&e2), 1), h(&eik(&e2)), 1, SALT.to_vec());
    assert_eq!(link_stats(&c)["links_total"], json!(2));
    link_email_to_google(&mut c, G2, &e2, 2, RELAYER);
    assert_eq!(link_stats(&c)["links_total"], json!(3));
    login_at(&mut c, NOW_MS + DELAY_MS, e_session_at(&e2, 10, NOW_MS + DELAY_MS), 10, None, None);
    assert_eq!(c.get_identity("s1".into(), EMAIL.into(), e2.clone()).status, "member");
    ctx(RELAYER, NOW_MS + DELAY_MS);
    c.unlink_identity("s1".into(), change_tok_google(G2, "unlink", &gik(G2), &eik(&e2), 3), h(&eik(&e2)), 3, SALT.to_vec());
    let stats = link_stats(&c);
    assert_eq!(stats["links_total"], json!(3));
    // DELAY_MS is an hour: the activation and the unlink fell in the next window, which counted nothing.
    assert_eq!((stats["current"]["total"].clone(), stats["previous"]["total"].clone()), (json!(0), json!(3)));
}

#[test]
fn a_scope_at_its_cap_refuses_new_links_until_the_next_hour() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_limits(2, 100);
    let start = window_start(NOW_MS);
    case_b_link(&mut c, G, &esub("a@gmail.com"), 7);
    assert!(events_named("link_cap_reached").is_empty());
    // The link that makes the count equal the cap records it.
    case_b_link(&mut c, G2, &esub("b@gmail.com"), 9);
    assert_eq!(events_named("link_cap_reached"), vec![json!({"scope_id": "s1", "window_start_ms": start, "count": 2})]);
    assert_eq!(link_stats(&c)["current"], json!({"window_start_ms": start, "total": 2, "total_cap_reached": false, "capped_scopes": ["s1"]}));
    // The next link in s1 is refused before anything is counted, by either path; another scope still links.
    google_wallet(&mut c, "g-carol", 11);
    let e = esub("c@gmail.com");
    ctx(RELAYER, NOW_MS);
    expect_panic("Link rate limit reached", || login(&mut c, g_session("g-carol", 12), 12, Some(auto_link_tok(&e, 12, &gik("g-carol"), 0, true, jb("g-carol"))), Some(true)));
    expect_panic("Link rate limit reached", || {
        link_email_to_google(&mut c, "g-carol", &e, 0, RELAYER);
    });
    assert_eq!(c.link_cap.scope_counts.get("s1").map(|r| r.count), Some(2));
    assert_eq!((link_stats(&c)["current"]["total"].clone(), link_stats(&c)["links_total"].clone()), (json!(2), json!(2)));
    ctx(RELAYER, NOW_MS);
    c.count_link("s2");
    // An hour later s1 links again; the capped hour is the previous window.
    ctx(RELAYER, NOW_MS + HOUR_MS);
    c.count_link("s1");
    let stats = link_stats(&c);
    assert_eq!(stats["current"], json!({"window_start_ms": start + HOUR_MS, "total": 1, "total_cap_reached": false, "capped_scopes": []}));
    assert_eq!(stats["previous"], json!({"window_start_ms": start, "total": 3, "total_cap_reached": false, "capped_scopes": ["s1"]}));
}

#[test]
fn the_total_cap_refuses_new_links_in_every_scope() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_limits(100, 2);
    let start = window_start(NOW_MS);
    case_b_link(&mut c, G, &esub("a@gmail.com"), 7);
    ctx(RELAYER, NOW_MS);
    c.count_link("s2");
    assert_eq!(events_named("link_cap_reached"), vec![json!({"scope_id": null, "window_start_ms": start, "count": 2})]);
    assert_eq!(link_stats(&c)["current"]["total_cap_reached"], json!(true));
    expect_panic("Link rate limit reached", || c.count_link("s3"));
    google_wallet(&mut c, G2, 9);
    let e = esub("b@gmail.com");
    ctx(RELAYER, NOW_MS);
    expect_panic("Link rate limit reached", || login(&mut c, g_session(G2, 10), 10, Some(auto_link_tok(&e, 10, &gik(G2), 0, true, jb(G2))), Some(true)));
    assert_eq!(link_stats(&c)["links_total"], json!(2));
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
    // A link in the next hour keeps the previous window's per-scope entries...
    ctx(RELAYER, NOW_MS + HOUR_MS);
    c.count_link("sc");
    assert!(c.link_cap.scope_counts.get("sa").is_some() && c.link_cap.scope_counts.get("sb").is_some());
    // ...an hour later they're older than the previous window and the next link deletes them (sc, from the previous
    // window, stays).
    ctx(RELAYER, NOW_MS + 2 * HOUR_MS);
    c.count_link("sd");
    assert!(c.link_cap.scope_counts.get("sa").is_none() && c.link_cap.scope_counts.get("sb").is_none());
    assert_eq!(c.link_cap.scope_counts.get("sc").map(|r| r.window_start_ms), Some(start + HOUR_MS));
    assert_eq!((c.link_cap.gc_head, c.link_cap.gc_tail), (2, 4));
    // A scope's count restarts in a new hour.
    ctx(ADMIN, NOW_MS + 2 * HOUR_MS);
    c.set_link_limits(1, 100);
    ctx(RELAYER, NOW_MS + 2 * HOUR_MS);
    expect_panic("Link rate limit reached", || c.count_link("sd"));
    ctx(RELAYER, NOW_MS + 3 * HOUR_MS);
    c.count_link("sd");
    assert_eq!(c.link_cap.scope_counts.get("sd").map(|r| (r.window_start_ms, r.count)), Some((start + 3 * HOUR_MS, 1)));
}

#[test]
fn capped_scopes_are_bounded() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_link_limits(1, 1000);
    ctx(RELAYER, NOW_MS);
    for i in 0..70 {
        c.count_link(&format!("x{i}"));
    }
    let stats = link_stats(&c);
    let capped = stats["current"]["capped_scopes"].as_array().unwrap();
    assert_eq!((capped.len(), capped[0].clone(), capped[63].clone()), (64, json!("x0"), json!("x63")));
    assert_eq!(stats["current"]["capped_scopes_truncated"], json!(true));
    // Every scope that reached the cap still emitted its event.
    assert_eq!(events_named("link_cap_reached").len(), 70);
}

#[test]
fn raising_a_link_limit_waits_the_governance_delay_lowering_applies_at_once() {
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    expect_panic("Only the owner can do this", || c.set_link_limits(10, 10));
    ctx(ADMIN, NOW_MS);
    expect_panic("Link limits must be 1 to 100000", || c.set_link_limits(0, 10));
    expect_panic("Link limits must be 1 to 100000", || c.set_link_limits(10, 100_001));
    // Lower: at once.
    c.set_link_limits(10, 100);
    assert_eq!((link_stats(&c)["limits"].clone(), link_stats(&c)["pending_limits"].clone()), (json!({"per_scope_per_hour": 10, "total_per_hour": 100}), Value::Null));
    assert_eq!(events_named("link_limits_set").last().unwrap()["effective_at_ms"], json!(NOW_MS));
    // One raised, one lowered: the lowered one applies now, the pair after the governance delay.
    c.set_link_limits(20, 50);
    let stats = link_stats(&c);
    assert_eq!(stats["limits"], json!({"per_scope_per_hour": 10, "total_per_hour": 50}));
    assert_eq!(stats["pending_limits"], json!({"per_scope_per_hour": 20, "total_per_hour": 50, "effective_at_ms": NOW_MS + GOV_DELAY_MS}));
    assert_eq!(
        events_named("link_limits_set").last().unwrap(),
        &json!({"per_scope_per_hour": 20, "total_per_hour": 50, "effective_at_ms": NOW_MS + GOV_DELAY_MS, "in_force": {"per_scope_per_hour": 10, "total_per_hour": 50}})
    );
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS - 1);
    assert_eq!(link_stats(&c)["limits"]["per_scope_per_hour"], json!(10));
    ctx(ANYONE, NOW_MS + GOV_DELAY_MS);
    assert_eq!((link_stats(&c)["limits"].clone(), link_stats(&c)["pending_limits"].clone()), (json!({"per_scope_per_hour": 20, "total_per_hour": 50}), Value::Null));
    // Counting uses the matured value and folds it in.
    c.count_link("s1");
    assert_eq!(c.link_cap.limits, LinkLimits { per_scope_per_hour: 20, total_per_hour: 50 });
    assert!(c.link_cap.pending.is_none());
    // A new call replaces a scheduled raise; setting what is in force cancels it.
    ctx(ADMIN, NOW_MS + GOV_DELAY_MS);
    c.set_link_limits(30, 50);
    assert!(c.link_cap.pending.is_some());
    c.set_link_limits(20, 50);
    assert!(c.link_cap.pending.is_none());
    assert_eq!(link_stats(&c)["limits"], json!({"per_scope_per_hour": 20, "total_per_hour": 50}));
}

#[test]
fn migrate_starts_the_link_counter_empty_with_the_default_limits() {
    ctx_with_storage(ME, NOW_MS, v2_storage());
    let c = HanaSigner::migrate();
    let stats = link_stats(&c);
    assert_eq!((stats["limits"].clone(), stats["pending_limits"].clone(), stats["links_total"].clone(), stats["previous"].clone()), (json!({"per_scope_per_hour": 50, "total_per_hour": 500}), Value::Null, json!(0), Value::Null));
    assert_eq!(stats["current"], json!({"window_start_ms": window_start(NOW_MS), "total": 0, "total_cap_reached": false, "capped_scopes": []}));
    assert_eq!((c.link_cap.gc_head, c.link_cap.gc_tail), (0, 0));
}
