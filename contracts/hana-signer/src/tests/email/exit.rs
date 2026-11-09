//! The permanent exit client (`docs/hana-home-h6-design.md` section 6, D468, D480–D488).

use super::*;
use crate::exit::{MAX_EXIT_CLIENTS, MAX_EXIT_SESSION_MS, MAX_EXIT_USES};
use crate::registry::RETIRED_EXIT;

const EXPIRY: u64 = EXIT_MS + MAX_EXIT_SESSION_MS;
const CONSOLE_B: &str = "console-b.apps.googleusercontent.com";

fn g_exit(sub: &str, scope: &str, seed: u8) -> String {
    google_tok(EXIT_G, sub, &nonce_for(scope, seed, EXPIRY, MAX_EXIT_USES, 0))
}

fn e_exit(sub: &str, scope: &str, seed: u8) -> String {
    email_tok(EXIT_E, sub, &nonce_for(scope, seed, EXPIRY, MAX_EXIT_USES, 0))
}

fn go(c: &mut HanaSigner, jwt: String, scope: &str, seed: u8) -> Session {
    open_at(c, jwt, scope, seed, EXIT_MS, EXPIRY, MAX_EXIT_USES, 0)
}

fn email_exit() -> (String, String) {
    (EMAIL.into(), EXIT_E.into())
}

fn exit_event() -> Vec<Value> {
    events_named("exit_session_opened")
}

// ---- Acceptance ----

#[test]
fn exit_opens_a_scope_that_refused_shared_login_for_google_and_email() {
    // s1 has its own clients and shared login off (email_setup); neither the exit client nor the scope's lists matter.
    let mut c = exit_setup();
    assert!(!c.get_scope("s1".into()).unwrap().allow_shared);
    let s = go(&mut c, g_exit(G2, "s1", 11), "s1", 11);
    assert_eq!(s, Session { path: format!("s1#google#{G2}#0"), scope_id: "s1".into(), expires_at_ms: EXPIRY, max_uses: 3, used: 0 });
    let e = esub("carol@example.com");
    let s = go(&mut c, e_exit(&e, "s1", 12), "s1", 12);
    assert_eq!(s.path, format!("s1#email#{e}#0"));
    // A scope with no client of its own and shared login on (s3 has a client; a shared-only scope works the same way).
    let s = go(&mut c, g_exit(G2, "s3", 13), "s3", 13);
    assert_eq!(s.path, format!("s3#google#{G2}#0"));
}

#[test]
fn exit_works_for_a_scope_that_kept_no_way_for_this_user_at_all() {
    // Scope s2's only client is B and it has no shared login; a user reaches it only by exit.
    let mut c = exit_setup();
    assert_eq!(c.get_scope("s2".into()).unwrap().clients.len(), 2);
    let s = go(&mut c, g_exit("g-newcomer", "s2", 11), "s2", 11);
    assert_eq!(s.path, "s2#google#g-newcomer#0");
}

#[test]
fn an_exit_session_works_like_a_session_and_derives_at_most_three_times() {
    let mut c = exit_setup();
    let s = go(&mut c, g_exit(G2, "s1", 11), "s1", 11);
    assert_eq!(s.max_uses, 3);
    for counter in 1..=3 {
        ctx(RELAYER, EXIT_MS);
        derive(&mut c, 11, counter);
        assert_eq!(mpc_path(), format!("s1#google#{G2}#0"));
    }
    ctx(RELAYER, EXIT_MS);
    expect_panic("Session use limit reached", || derive(&mut c, 11, 4));
    // It records the identity's wallet, as any derive on its own path does (`opened`).
    assert!(c.get_identity("s1".into(), "google".into(), G2.into()).opened);
    // And it ends with its session: `revoke_session` and the expiry apply as to any session.
    ctx(ANYONE, EXPIRY);
    expect_panic("Session expired", || derive(&mut c, 11, 4));
}

#[test]
fn the_combined_login_also_opens_an_exit_session() {
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS);
    let jwt = g_exit(G2, "s1", 11);
    let _ = c.create_session_and_derive(jwt, "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, MAX_EXIT_USES, ckd_sig(11, 1, PK1, PK2), PK1.into(), PK2.into(), None, None);
    assert_eq!(mpc_path(), format!("s1#google#{G2}#0"));
    assert_eq!(exit_event().len(), 1);
}

#[test]
fn a_linked_member_reaches_its_root_path_by_exit_and_a_pending_member_is_refused() {
    let mut c = exit_setup();
    let e = esub("alice@gmail.com");
    email_wallet(&mut c, &e, 7);
    // G joins e's account at once (case A): the exit opens the root's path.
    login(&mut c, g_session(G, 8), 8, Some(auto_link_tok(&e, 8, &gik(G), 0, true, ja(&e))), Some(true));
    let s = go(&mut c, g_exit(G, "s1", 21), "s1", 21);
    assert_eq!(s.path, format!("s1#email#{e}#0"));
    // A pending member (case B, delayed): email e2 joining G2's account waits (the change delay raised so the link is
    // still pending at EXIT_MS), and its exit is refused as any login is.
    let e2 = esub("bob@gmail.com");
    let mut c = exit_setup();
    ctx(ADMIN, NOW_MS);
    c.set_change_delay_ms(4 * HOUR_MS);
    google_wallet(&mut c, G2, 9);
    login(&mut c, g_session(G2, 10), 10, Some(auto_link_tok(&e2, 10, &gik(G2), 0, false, jb(G2))), None);
    expect_panic("Sign-in method link is pending", || drop(go(&mut c, e_exit(&e2, "s1", 22), "s1", 22)));
}

// ---- Refusals ----

#[test]
fn exit_is_refused_on_an_unknown_scope_a_pending_or_removed_client_paused_a_wrong_nonce_and_past_the_limits() {
    let c = exit_setup();
    // Unknown scope: the token commits to it, it just doesn't exist.
    let mut a = c;
    ctx(RELAYER, EXIT_MS);
    expect_panic("No such scope", || drop(a.create_session_signed(g_exit(G, "s9", 11), "s9".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 3)));

    // Pending: before its time it is no exit client, and no session_scope accepts it either.
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS - 1);
    expect_panic("Token is for an unregistered app", || drop(c.create_session_signed(g_exit(G, "s1", 11), "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 3)));

    // Removed: at once.
    let mut c = exit_setup();
    ctx(ADMIN, EXIT_MS);
    c.set_exit_clients(vec![email_exit()]);
    ctx(RELAYER, EXIT_MS);
    expect_panic("Token is for an unregistered app", || drop(c.create_session_signed(g_exit(G, "s1", 11), "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 3)));

    // Paused.
    let mut c = exit_setup();
    ctx(WATCHDOG, EXIT_MS);
    c.pause();
    ctx(RELAYER, EXIT_MS);
    expect_panic("Paused", || drop(c.create_session_signed(g_exit(G, "s1", 11), "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 3)));

    // A wrong nonce: the token commits to another scope.
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS);
    expect_panic("Token nonce doesn't commit to this session", || drop(c.create_session_signed(g_exit(G, "s2", 11), "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 3)));

    // Over the limits: longer than 30 minutes, more than 3 uses.
    let long = EXIT_MS + MAX_EXIT_SESSION_MS + 1;
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS);
    expect_panic("Exit session expiry must be within 30 minutes", || {
        let t = google_tok(EXIT_G, G, &nonce_for("s1", 11, long, 3, 0));
        drop(c.create_session_signed(t, "s1".into(), pk(11), long, SALT.to_vec(), 0, 3))
    });
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS);
    expect_panic("Exit session max_uses must be 1-3", || {
        let t = google_tok(EXIT_G, G, &nonce_for("s1", 11, EXPIRY, 4, 0));
        drop(c.create_session_signed(t, "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, 4))
    });
}

#[test]
fn a_link_jwt_is_refused_on_an_exit_session() {
    let mut c = exit_setup();
    let e = esub("carol@example.com");
    ctx(RELAYER, EXIT_MS);
    let link = email_tok("email:s1", &e, "x");
    let sig = login_sig(11, Some(&link), Some(true));
    expect_panic("An exit session can't carry a link", || {
        drop(c.create_session_and_derive(g_exit(G2, "s1", 11), "s1".into(), pk(11), EXPIRY, SALT.to_vec(), 0, MAX_EXIT_USES, sig, PK1.into(), PK2.into(), Some(link), Some(true)))
    });
}

#[test]
fn an_exit_token_is_refused_by_every_link_method_and_by_owner_auth() {
    // `session_scope` knows nothing of exit clients, and a console audience is not an exit client.
    let mut c = exit_setup();
    ctx(RELAYER, EXIT_MS);
    let g = g_exit(G, "s1", 11);
    let e = esub("carol@example.com");
    let normal = google_tok(A, G2, "n");
    expect_panic("Token is for an unregistered app", || { let _ = c.link_identity("s1".into(), g.clone(), normal.clone(), 0, vec![1; 16]); });
    expect_panic("Token is for an unregistered app", || { let _ = c.link_identity("s1".into(), normal.clone(), g.clone(), 0, vec![1; 16]); });
    expect_panic("Token is for an unregistered app", || c.cancel_link("s1".into(), g.clone(), h(&eik(&e)), 0, vec![1; 16]));
    expect_panic("Token is for an unregistered app", || c.unlink_identity("s1".into(), g.clone(), h(&eik(&e)), 0, vec![1; 16]));
    // The email exit audience too.
    let et = e_exit(&e, "s1", 12);
    expect_panic("Token is for an unregistered app", || { let _ = c.link_identity("s1".into(), et, normal.clone(), 0, vec![1; 16]); });
    // An exit token as the link_jwt of an ordinary login.
    let link = e_exit(&e, "s1", 13);
    let sig = login_sig(13, Some(&link), Some(true));
    expect_panic("Token is for an unregistered app", || {
        drop(c.create_session_and_derive(google_tok(A, G2, &sess_nonce_for(13)), "s1".into(), pk(13), expiry_at(EXIT_MS), SALT.to_vec(), 0, 3, sig, PK1.into(), PK2.into(), Some(link), Some(true)))
    });
    // Owner auth: a token of an owner of the scope, but not for the console. s2 has no OIDC owner, so s1, through Alice's scope.
    let owner_jwt = google_tok(EXIT_G, OWNER_SUB, "n");
    ctx(ALICE, EXIT_MS);
    expect_panic("Token is not for the Hana console", || { let _ = c.propose_change("s1".into(), OwnerAuth::Oidc { jwt: owner_jwt }, add(D), None); });
}

fn sess_nonce_for(seed: u8) -> String {
    nonce_for("s1", seed, expiry_at(EXIT_MS), 3, 0)
}

// ---- Disjointness ----

#[test]
fn set_exit_clients_refuses_anything_that_is_a_scope_client_shared_pending_quarantined_or_a_console_audience() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    let try_set = |c: &mut HanaSigner, client: (String, String)| {
        ctx(ADMIN, NOW_MS);
        c.set_exit_clients(vec![client]);
    };
    // A scope's client.
    expect_panic("Client is already registered", || try_set(&mut c, google(A)));
    expect_panic("Client is already registered", || try_set(&mut c, (EMAIL.into(), "email:s1".into())));
    // A shared client, in force or pending.
    let mut c = shared_setup_with_email();
    expect_panic("Client is a shared client", || try_set(&mut c, google(SHARED)));
    ctx(ADMIN, NOW_MS);
    c.set_shared_clients(vec![google(SHARED), google(D)]);
    expect_panic("Client is a shared client", || try_set(&mut c, google(D)));
    // A client with a pending AddClient.
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    c.propose_change("s1".into(), OwnerAuth::Near, add(E), Some(google_tok(E, OWNER_SUB, &client_proof_nonce(ME, "s1", 0))));
    expect_panic("Client is pending in a scope", || try_set(&mut c, google(E)));
    // A quarantined client (removed from s1 within change_delay_ms).
    ctx(ALICE, NOW_MS);
    c.remove_client("s1".into(), OwnerAuth::Near, "google".into(), A2.into());
    expect_panic("Client was recently removed from another scope", || try_set(&mut c, google(A2)));
    // A console audience, in force or pending.
    expect_panic("Client is a console audience", || try_set(&mut c, google(CONSOLE)));
    ctx(ADMIN, NOW_MS);
    c.set_console_audiences(vec![google(CONSOLE), google(CONSOLE_B)]);
    expect_panic("Client is a console audience", || try_set(&mut c, google(CONSOLE_B)));
    // No client is allowed on no provider, and a provider must exist. No duplicate. At most 4.
    expect_panic("Unknown issuer", || try_set(&mut c, ("nope".into(), "x".into())));
    ctx(ADMIN, NOW_MS);
    expect_panic("Duplicate exit client", || c.set_exit_clients(vec![google(EXIT_G), google(EXIT_G)]));
    ctx(ADMIN, NOW_MS);
    let too_many: Vec<(String, String)> = (0..=MAX_EXIT_CLIENTS).map(|i| google(&format!("exit-{i}"))).collect();
    expect_panic("Too many exit clients", || c.set_exit_clients(too_many));
    // Needs no proof and runs before anything mints the tokens: the email audience, on no scope, goes in.
    ctx(ADMIN, NOW_MS);
    c.set_exit_clients(vec![email_exit()]);
    assert_eq!(c.get_config().pending_exit_clients[0].aud, EXIT_E);
}

/// email_setup() with SHARED in force (for the shared-client disjointness checks).
fn shared_setup_with_email() -> HanaSigner {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS - DELAY_MS);
    c.set_shared_clients(vec![google(SHARED)]);
    ctx(ADMIN, NOW_MS);
    c
}

#[test]
fn exit_clients_cannot_become_shared_clients_console_audiences_or_scope_clients_while_listed_or_pending() {
    // Pending first: the reservation holds from the moment of set_exit_clients.
    let mut c = exit_setup();
    ctx(ADMIN, NOW_MS);
    expect_panic("Client is an exit client", || c.set_shared_clients(vec![google(EXIT_G)]));
    expect_panic("Client is an exit client", || c.set_console_audiences(vec![google(CONSOLE), google(EXIT_G)]));
    expect_panic("Client is an exit client", || drop(c.admin_register_scope(vec![near_owner(ALICE)], vec![google(EXIT_G)], None, false)));
    ctx(ALICE, NOW_MS);
    let proof = google_tok(EXIT_G, OWNER_SUB, &client_proof_nonce(ME, "s1", 0));
    expect_panic("Client is an exit client", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, add(EXIT_G), Some(proof)); });
    // In force: the same.
    ctx(ADMIN, EXIT_MS);
    expect_panic("Client is an exit client", || c.set_shared_clients(vec![google(EXIT_G)]));
    expect_panic("Client is an exit client", || c.set_console_audiences(vec![google(EXIT_G)]));
    expect_panic("Client is an exit client", || drop(c.admin_register_scope(vec![near_owner(ALICE)], vec![google(EXIT_G)], None, false)));
    ctx(ALICE, EXIT_MS);
    let proof = google_tok(EXIT_G, OWNER_SUB, &client_proof_nonce(ME, "s1", 0));
    expect_panic("Client is an exit client", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, add(EXIT_G), Some(proof)); });
}

#[test]
fn register_scope_with_an_exit_clients_proof_is_refused() {
    // Public registration: every proof is for a client it would claim, and an exit client isn't claimable.
    let mut c = exit_setup();
    ctx(ADMIN, NOW_MS);
    c.enable_public_registration();
    let owners = vec![near_owner(MALLORY)];
    let clients = vec![google(EXIT_G)];
    let nonce = register_nonce(ME, &owners, &clients, false);
    ctx(MALLORY, NOW_MS);
    expect_panic("Client is an exit client", || drop(c.register_scope(owners, vec![google_tok(EXIT_G, OWNER_SUB, &nonce)], false)));
}

#[test]
fn an_add_client_that_predates_the_exit_list_is_refused_when_it_executes() {
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    c.propose_change("s1".into(), OwnerAuth::Near, add(E), Some(google_tok(E, OWNER_SUB, &client_proof_nonce(ME, "s1", 0))));
    // No normal call can list E while it is pending (`pending_adds`); the state here is what an upgrade or a race would leave.
    c.exit_clients.push(google(E));
    ctx(ANYONE, NOW_MS + DELAY_MS);
    expect_panic("Client is an exit client", || c.execute_change("s1".into(), 0));
}

#[test]
fn a_removed_or_pending_exit_client_is_retired_forever() {
    let mut c = exit_setup();
    ctx(ADMIN, NOW_MS);
    c.set_exit_clients(vec![email_exit()]); // removes EXIT_G while it is still pending (and retires it)
    let retired = c.removed_clients.get(&google(EXIT_G)).expect("retired");
    assert_eq!((retired.scope_id.as_str(), retired.free_at_ms), (RETIRED_EXIT, u64::MAX));
    // It can't return, join a scope, or become shared or a console audience.
    expect_panic("Client was an exit client and is retired", || c.set_exit_clients(vec![email_exit(), google(EXIT_G)]));
    expect_panic("Client was an exit client and is retired", || drop(c.admin_register_scope(vec![near_owner(ALICE)], vec![google(EXIT_G)], None, false)));
    expect_panic("Client was an exit client and is retired", || c.set_shared_clients(vec![google(EXIT_G)]));
    expect_panic("Client was an exit client and is retired", || c.set_console_audiences(vec![google(EXIT_G)]));
    ctx(ALICE, NOW_MS);
    let proof = google_tok(EXIT_G, OWNER_SUB, &client_proof_nonce(ME, "s1", 0));
    expect_panic("Client was an exit client and is retired", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, add(EXIT_G), Some(proof)); });
    // Even after the free date of a normal quarantine: forever.
    ctx(ADMIN, NOW_MS + 365 * 24 * HOUR_MS);
    expect_panic("Client was an exit client and is retired", || c.set_exit_clients(vec![email_exit(), google(EXIT_G)]));
    // Removing the client in force works and retires it the same way, at once.
    let mut c = exit_setup();
    ctx(ADMIN, EXIT_MS);
    c.set_exit_clients(vec![google(EXIT_G)]); // removes email in force
    assert!(c.removed_clients.get(&email_exit()).is_some_and(|r| r.scope_id == RETIRED_EXIT));
    assert_eq!(c.get_config().exit_clients, vec![google(EXIT_G)]);
    // A retired shared client can't become an exit client either.
    let mut c = shared_setup_with_email();
    ctx(ADMIN, NOW_MS);
    c.set_shared_clients(vec![]);
    expect_panic("Client was a shared client and is retired", || c.set_exit_clients(vec![google(SHARED)]));
}

// ---- The audience shape ----

#[test]
fn a_self_issued_client_must_be_exactly_its_provider_and_scope() {
    // The email issuer's Home audience with a valid proof for this scope and action: refused at propose, even before the
    // exit list is set (the audience shape alone).
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    let proof = email_tok(EXIT_E, G, &client_proof_nonce(ME, "s1", 0));
    expect_panic("A self-issued client must be its provider and scope", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, Change::AddClient { provider: EMAIL.into(), aud: EXIT_E.into() }, Some(proof)); });
    // Another scope's email client on s1: refused, with a valid proof.
    ctx(ALICE, NOW_MS);
    let proof = email_tok("email:s2", G, &client_proof_nonce(ME, "s1", 0));
    expect_panic("A self-issued client must be its provider and scope", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, Change::AddClient { provider: EMAIL.into(), aud: "email:s2".into() }, Some(proof)); });
    // At registration: admin_register_scope, and any other form.
    ctx(ADMIN, NOW_MS);
    expect_panic("A self-issued client must be its provider and scope", || drop(c.admin_register_scope(vec![near_owner(ALICE)], vec![email_exit()], None, false)));
    ctx(ADMIN, NOW_MS);
    expect_panic("A self-issued client must be its provider and scope", || drop(c.admin_register_scope(vec![near_owner(ALICE)], vec![(EMAIL.into(), "email:s9".into())], None, false)));
    // The right form still works for the scope being registered (the next id is s3). Fresh state: a panic above took
    // `next_scope` further here than a reverted receipt would.
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    assert_eq!(c.admin_register_scope(vec![near_owner(ALICE)], vec![(EMAIL.into(), "email:s3".into()), google("not-self-issued")], None, false), "s3");
    // Ordinary providers are not affected: a Google client keeps any aud.
    assert_eq!(c.scope_for_client(EMAIL.into(), "email:s3".into()), Some("s3".into()));
    // And when the exit list holds it, the shape check still answers first for a scope.
    ctx(ADMIN, NOW_MS);
    c.set_exit_clients(vec![email_exit()]);
    ctx(ALICE, NOW_MS);
    let proof = email_tok(EXIT_E, G, &client_proof_nonce(ME, "s1", 0));
    expect_panic("A self-issued client must be its provider and scope", || { let _ = c.propose_change("s1".into(), OwnerAuth::Near, Change::AddClient { provider: EMAIL.into(), aud: EXIT_E.into() }, Some(proof)); });
}

#[test]
fn a_public_registration_of_the_email_home_audience_is_refused() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.enable_public_registration();
    let owners = vec![near_owner(MALLORY)];
    let clients = vec![email_exit()];
    let nonce = register_nonce(ME, &owners, &clients, false);
    ctx(MALLORY, NOW_MS);
    expect_panic("A self-issued client must be its provider and scope", || drop(c.register_scope(owners, vec![email_tok(EXIT_E, G, &nonce)], false)));
}

#[test]
fn an_email_client_added_before_the_shape_rule_is_refused_when_it_executes() {
    // A pending AddClient queued by older code (v3 had no shape rule).
    let mut c = email_setup();
    ctx(ALICE, NOW_MS);
    let mut scope = c.get_scope("s1".into()).unwrap();
    scope.pending.push(PendingChange { id: 7, change: Change::AddClient { provider: EMAIL.into(), aud: EXIT_E.into() }, unlock_at_ms: NOW_MS });
    c.scopes.insert("s1".to_string(), scope);
    ctx(ANYONE, NOW_MS);
    expect_panic("A self-issued client must be its provider and scope", || c.execute_change("s1".into(), 7));
}

// ---- The event and the counter ----

#[test]
fn one_event_per_exit_session_with_no_sub_and_the_hourly_counter() {
    let mut c = exit_setup();
    let sub = esub("carol@example.com");
    go(&mut c, e_exit(&sub, "s1", 11), "s1", 11);
    let evs = exit_event();
    assert_eq!(evs, vec![json!({"scope_id": "s1", "provider": EMAIL, "aud": EXIT_E, "identity_key": h(&eik(&sub)), "expires_at_ms": EXPIRY, "max_uses": 3})]);
    // The raw logs carry no `sub`, for email or Google.
    let logs: Vec<String> = near_sdk::test_utils::get_logs();
    assert!(!logs.iter().any(|l| l.contains(&sub)), "{logs:?}");
    go(&mut c, g_exit(G, "s2", 12), "s2", 12);
    assert_eq!(exit_event().len(), 1); // one per session; each test env's logs reset with its context
    let logs = near_sdk::test_utils::get_logs();
    assert!(!logs.iter().any(|l| l.contains(G)), "{logs:?}");
    // A normal login opens no exit event and counts nothing.
    let e = esub("dan@example.com");
    let before = c.get_config().exit_window;
    open_at(&mut c, email_tok("email:s1", &e, &nonce_for("s1", 13, expiry_at(EXIT_MS), 3, 0)), "s1", 13, EXIT_MS, expiry_at(EXIT_MS), 3, 0);
    assert_eq!(exit_event(), Vec::<Value>::new());
    assert_eq!(c.get_config().exit_window, before);
}

#[test]
fn the_exit_counter_counts_per_hour_rolls_over_and_never_refuses() {
    let mut c = exit_setup();
    let window = |c: &HanaSigner, ms: u64| {
        ctx(ANYONE, ms);
        c.get_config().exit_window
    };
    assert_eq!(window(&c, EXIT_MS), ExitWindow { window_start_ms: EXIT_MS, current: 0, previous: 0 });
    go(&mut c, g_exit(G, "s1", 11), "s1", 11);
    go(&mut c, g_exit(G, "s2", 12), "s2", 12);
    assert_eq!(window(&c, EXIT_MS), ExitWindow { window_start_ms: EXIT_MS, current: 2, previous: 0 });
    // The next hour: the count moves to `previous`; the view already rolls over before any new exit.
    assert_eq!(window(&c, EXIT_MS + HOUR_MS), ExitWindow { window_start_ms: EXIT_MS + HOUR_MS, current: 0, previous: 2 });
    // A count in that hour keeps `previous` (the fixture tokens expire before that hour, so the window directly).
    let ms = EXIT_MS + HOUR_MS;
    let mut w = c.exit_window.clone();
    w.count(ms);
    assert_eq!(w, ExitWindow { window_start_ms: ms, current: 1, previous: 2 });
    c.exit_window = w;
    assert_eq!(window(&c, ms), ExitWindow { window_start_ms: ms, current: 1, previous: 2 });
    // Hours later it reads empty.
    assert_eq!(window(&c, ms + 2 * HOUR_MS), ExitWindow { window_start_ms: ms + 2 * HOUR_MS, current: 0, previous: 0 });
    // It never refuses, at its saturation.
    let mut full = ExitWindow { window_start_ms: EXIT_MS, current: u32::MAX, previous: 0 };
    full.count(EXIT_MS);
    assert_eq!(full.current, u32::MAX);
}

// ---- The list ----

#[test]
fn set_exit_clients_waits_the_governance_delay_and_reserves_at_once() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_exit_clients(vec![google(EXIT_G)]);
    let cfg = c.get_config();
    assert_eq!(cfg.exit_clients, Vec::<(String, String)>::new());
    assert_eq!(cfg.pending_exit_clients, vec![PendingSharedClient { provider: "google".into(), aud: EXIT_G.into(), effective_at_ms: NOW_MS + GOV_DELAY_MS }]);
    assert_eq!(events(), vec![ev13("exit_clients_set", json!({"exit_clients": [], "pending_exit_clients": [{"provider": "google", "aud": EXIT_G, "effective_at_ms": NOW_MS + GOV_DELAY_MS}]}))]);
    // Not in force before its time, in force at it (the view counts matured entries before anyone folds them).
    ctx(ANYONE, EXIT_MS - 1);
    assert!(c.get_config().exit_clients.is_empty());
    ctx(ANYONE, EXIT_MS);
    assert_eq!(c.get_config().exit_clients, vec![google(EXIT_G)]);
    assert!(c.get_config().pending_exit_clients.is_empty());
    // `apply_pending_config` folds it into state.
    c.apply_pending_config();
    assert_eq!(c.exit_clients, vec![google(EXIT_G)]);
    assert!(c.pending_exit_clients.is_empty());
    // A pending entry keeps its time when the list is re-set with it in it; a new delay applies only to new entries.
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_exit_clients(vec![google(EXIT_G)]);
    ctx(ADMIN, NOW_MS + HOUR_MS);
    c.set_exit_clients(vec![google(EXIT_G), email_exit()]);
    let pending = c.get_config().pending_exit_clients;
    assert_eq!((pending[0].effective_at_ms, pending[1].effective_at_ms), (NOW_MS + GOV_DELAY_MS, NOW_MS + HOUR_MS + GOV_DELAY_MS));
}

#[test]
fn with_a_zero_governance_delay_exit_clients_are_in_force_at_once() {
    let mut c = email_setup();
    ctx(ADMIN, NOW_MS);
    c.set_governance_delay_ms(0);
    ctx(ADMIN, NOW_MS + GOV_DELAY_MS);
    assert_eq!(c.get_config().governance_delay_ms, 0);
    c.set_exit_clients(vec![google(EXIT_G)]);
    assert_eq!(c.get_config().exit_clients, vec![google(EXIT_G)]);
    assert!(c.pending_exit_clients.is_empty());
}

#[test]
fn a_partner_owner_has_no_method_that_reaches_the_exit_list() {
    // Owner of a scope can't change it: set_exit_clients is owner-only (tests.rs owner_only_calls), and no scope method
    // touches it. Shown here by what a scope owner's actions leave behind.
    let mut c = exit_setup();
    ctx(ALICE, NOW_MS);
    c.remove_client("s1".into(), OwnerAuth::Near, "google".into(), A2.into());
    ctx(BOB, NOW_MS);
    c.disable_shared_login("s3".into(), OwnerAuth::Near);
    assert_eq!(c.get_config().pending_exit_clients.len(), 2);
    // And the exit still reaches s3 after its owner turned shared login off.
    let s = go(&mut c, g_exit(G, "s3", 11), "s3", 11);
    assert_eq!(s.path, format!("s3#google#{G}#0"));
}
