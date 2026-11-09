//! The permanent exit client (`docs/hana-home-h6-design.md`, D468, D480–D491): Hana Home's own login clients, whose
//! tokens open sessions in any registered scope, whatever that scope's `clients` and `allow_shared` say, so a user keeps
//! a way to their wallet whatever a partner does. The email entry is `("email", "hana-home")` (D474), an audience on no
//! scope; Google's is a dedicated client (D484).
//!
//! - **Who changes the list**: the owner (the council), `set_exit_clients`, at most `MAX_EXIT_CLIENTS` entries. A new
//!   client waits `governance_delay_ms` (D482), because an exit client reaches every scope, close to an upgrade's power.
//!   A removal is immediate and retires the client for good (D483): the way to stop a compromised Home without pausing
//!   every partner, and it can't steal anything.
//! - **Acceptance**: `exit_scope` in `sessions.rs`, called only from `open_session`, before and instead of
//!   `session_scope`. Since `session_scope` stays unchanged, the link methods and owner actions can't accept an exit
//!   token. Nothing about the session's path changes: `aud` never enters the path, `ik`, `settle` or `path_identity`.
//! - **Limits** (D486): an exit session lasts at most 30 minutes and 3 uses (2 or more are needed to retry an MPC failure)
//!   and can't carry a link. Pause still stops it (`verify_token`). A partner has no method that touches the list.
//! - **Disjointness**: an exit client (in force, pending or retired) is never a scope's client, a shared client or a console
//!   audience, and none of those can become one. Checked at `set_exit_clients` and at every place those can be added.
//! - **Alerts** (D487): one `exit_session_opened` event per session (no `sub`) and an hourly counter in `get_config` for
//!   the watchdog. The counter never refuses: a refusing cap could be burned to lock users out of their rescue route.

use near_sdk::serde_json::json;
use near_sdk::{env, near};

use crate::link_counter::{window_start, LINK_WINDOW_MS};
use crate::registry::{RemovedClient, RETIRED_EXIT};
use crate::{assert_aud, assert_provider, events, HanaSigner, HanaSignerExt, PendingSharedClient};

/// Entries in the exit list, at most.
pub const MAX_EXIT_CLIENTS: usize = 4;
/// The longest an exit session may last (D486).
pub const MAX_EXIT_SESSION_MS: u64 = 30 * 60 * 1000;
/// The most uses an exit session may have (D486).
pub const MAX_EXIT_USES: u32 = 3;

/// Exit sessions opened in the current UTC hour and in the one before it (a burst straddling an hour boundary still
/// shows, since the watchdog runs every 5 minutes). Alert only: it never refuses (D487). Both the stored value and what
/// `get_config` shows.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ExitWindow {
    pub window_start_ms: u64,
    /// Exit sessions opened in the hour from `window_start_ms`.
    pub current: u32,
    /// Exit sessions opened in the hour before it.
    pub previous: u32,
}

impl ExitWindow {
    /// The window as it stands at `now`: an older window rolls over, its count moving to `previous` only when it was the
    /// hour just before.
    pub fn at(&self, now: u64) -> Self {
        let start = window_start(now);
        if self.window_start_ms == start {
            self.clone()
        } else if self.window_start_ms.saturating_add(LINK_WINDOW_MS) == start {
            Self { window_start_ms: start, current: 0, previous: self.current }
        } else {
            Self { window_start_ms: start, current: 0, previous: 0 }
        }
    }

    /// Counts one exit session at `now`. Saturates, so it never refuses.
    pub(crate) fn count(&mut self, now: u64) {
        *self = self.at(now);
        self.current = self.current.saturating_add(1);
    }
}

#[near]
impl HanaSigner {
    /// Replaces the exit clients (≤ 4). Clients dropped from the list (in force or still pending) stop working at once
    /// and are retired for good (D483): none can ever return, join a scope or become shared or a console audience. New
    /// ones count only after `governance_delay_ms` (D482), but reserve the client at once. Pending ones already in the
    /// list keep their `effective_at_ms`. Needs no proof of the client: it can run before anything mints its tokens.
    pub fn set_exit_clients(&mut self, clients: Vec<(String, String)>) {
        self.assert_owner();
        assert!(clients.len() <= MAX_EXIT_CLIENTS, "Too many exit clients");
        let now = env::block_timestamp_ms();
        self.apply_matured_config(now);
        for (i, client) in clients.iter().enumerate() {
            assert_provider(&client.0);
            assert_aud(&client.1);
            assert!(self.has_issuer(&client.0), "Unknown issuer");
            assert!(!clients[..i].contains(client), "Duplicate exit client");
            assert!(!self.client_index.contains_key(client), "Client is already registered");
            assert!(!self.is_shared_or_pending(client), "Client is a shared client");
            assert!(!self.pending_adds.contains_key(client), "Client is pending in a scope");
            let pending_console = self.pending_console_audiences.iter().any(|p| p.provider == client.0 && p.aud == client.1);
            assert!(!self.console_audiences.contains(client) && !pending_console, "Client is a console audience");
            self.assert_not_quarantined(client, None);
        }
        let effective_at_ms = now.saturating_add(self.governance_delay_at(now));
        let dropped: Vec<(String, String)> =
            self.exit_clients.iter().cloned().chain(self.pending_exit_clients.iter().map(|p| (p.provider.clone(), p.aud.clone()))).filter(|c| !clients.contains(c)).collect();
        for client in dropped {
            self.removed_clients.insert(client, RemovedClient { scope_id: RETIRED_EXIT.to_string(), free_at_ms: u64::MAX, reserved_by: None });
        }
        self.exit_clients.retain(|c| clients.contains(c));
        self.pending_exit_clients.retain(|p| clients.iter().any(|c| c.0 == p.provider && c.1 == p.aud));
        for client in clients {
            if !self.exit_clients.contains(&client) && !self.pending_exit_clients.iter().any(|p| p.provider == client.0 && p.aud == client.1) {
                self.pending_exit_clients.push(PendingSharedClient { provider: client.0, aud: client.1, effective_at_ms });
            }
        }
        // With a zero delay the additions are already in force.
        self.apply_matured_config(now);
        events::emit("exit_clients_set", json!({ "exit_clients": self.exit_clients, "pending_exit_clients": self.pending_exit_clients }));
    }
}

impl HanaSigner {
    /// Counts one exit session (D487). Never refuses.
    pub(crate) fn count_exit(&mut self, now: u64) {
        self.exit_window.count(now);
    }
}
