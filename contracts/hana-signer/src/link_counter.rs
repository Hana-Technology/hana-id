//! Link volume: a counter of new links with hourly alarm thresholds (D200). It never refuses a link.
//!
//! What a stolen email signing key (1-of-1 at launch) gives a thief on its own (since D133 a link also needs the
//! session key's signature, so the key alone can't join an email identity to someone else's Google wallet): logins into
//! every email-rooted wallet, logins into every Google-rooted wallet that already has an email member, and links of the
//! thief's own Google account into victims' email wallets (case A: one Google account per victim and scope). Only
//! the last makes new links. The defence against a stolen key is its custody (KMS, a second signer, D121); this counter
//! only makes a burst of links visible: the watchdog reads `get_link_stats` and alerts when a threshold is reached.
//! A refusing cap was rejected (review H1/H2): it bounded little and anyone could burn it (one Google account and one
//! email looping `link_identity` / `cancel_link`) to lock real users out.
//!
//! - **Counted**: every new link, immediate or pending: the combined login with a `link_jwt` (cases A and B) and
//!   `link_identity` (both go through `HanaSigner::join`). Not cancels, unlinks or lazy activations.
//! - **Windows**: fixed UTC hours, `window_start_ms = floor(block_ms / 3_600_000) * 3_600_000`; one count per scope and
//!   one in total; the current window and the previous one are kept. A burst that straddles an hour boundary is split
//!   between two windows (each may stay under a threshold): the watchdog also reads `previous`.
//! - **Thresholds**: when a count is at or above its threshold after a link, the window records it: the scope goes into
//!   `flagged_scopes` (once per window, ≤ `MAX_FLAGGED_SCOPES` in the order flagged, then `flagged_scopes_truncated`),
//!   or `total_threshold_reached` becomes true; event `link_threshold_reached` at the first crossing per window.
//!   `set_link_thresholds` (owner): a lower value applies at once; a higher one (it could hide an attack) only after
//!   `governance_delay_ms`, like the delay setters' decreases.
//! - **Storage**: a per-scope count is kept only for scopes with links in the current or previous window. Each scope's
//!   first link in a window queues `(window, scope)`; every counted link deletes up to `GC_PER_LINK` queued counts
//!   older than the previous window.

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near};

use crate::{events, HanaSigner, HanaSignerExt, StorageKey};

/// The window length: one hour.
pub const LINK_WINDOW_MS: u64 = 3_600_000;
/// Default thresholds (provisional until real traffic is measured, D200).
pub const DEFAULT_PER_SCOPE_PER_HOUR: u32 = 50;
pub const DEFAULT_TOTAL_PER_HOUR: u32 = 500;
/// Each threshold is 1..=`MAX_LINK_THRESHOLD`.
pub const MAX_LINK_THRESHOLD: u32 = 100_000;
/// `flagged_scopes` per window, at most (then `flagged_scopes_truncated`).
pub const MAX_FLAGGED_SCOPES: usize = 64;
/// Stale per-scope counts deleted by each counted link, at most.
const GC_PER_LINK: u32 = 4;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinkThresholds {
    pub per_scope_per_hour: u32,
    pub total_per_hour: u32,
}

/// A scheduled raise of the thresholds (the full pair in force from `effective_at_ms`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingLinkThresholds {
    pub per_scope_per_hour: u32,
    pub total_per_hour: u32,
    pub effective_at_ms: u64,
}

/// One hour's totals.
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LinkWindow {
    pub window_start_ms: u64,
    pub total: u32,
    pub total_threshold_reached: bool,
    /// Scopes whose count reached `per_scope_per_hour` in this window, once each, in the order flagged,
    /// ≤ `MAX_FLAGGED_SCOPES`.
    pub flagged_scopes: Vec<String>,
    /// More scopes were flagged than `flagged_scopes` holds (serialized only when true).
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub flagged_scopes_truncated: bool,
}

impl LinkWindow {
    fn empty(window_start_ms: u64) -> Self {
        Self { window_start_ms, total: 0, total_threshold_reached: false, flagged_scopes: vec![], flagged_scopes_truncated: false }
    }
}

/// A scope's count in one window, and whether it was flagged there.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ScopeLinkCount {
    pub window_start_ms: u64,
    pub count: u32,
    pub flagged: bool,
}

/// The counter's state (one field of the root struct, v3).
#[near(serializers = [borsh])]
pub struct LinkCounter {
    /// The thresholds in force, unless `pending` has matured (read through `thresholds_at`).
    pub thresholds: LinkThresholds,
    pub pending: Option<PendingLinkThresholds>,
    /// New links since v3 (cumulative).
    pub links_total: u64,
    /// The latest window with links, and the one before it if that had links too and was the hour just before.
    pub current: Option<LinkWindow>,
    pub previous: Option<LinkWindow>,
    /// scope id → its count in the latest window it had a link in.
    pub scope_counts: LookupMap<String, ScopeLinkCount>,
    /// FIFO of (window_start_ms, scope id), one per scope and window with links: entries [gc_head, gc_tail).
    pub gc_queue: LookupMap<u64, (u64, String)>,
    pub gc_head: u64,
    pub gc_tail: u64,
}

impl LinkCounter {
    pub fn new() -> Self {
        Self {
            thresholds: LinkThresholds { per_scope_per_hour: DEFAULT_PER_SCOPE_PER_HOUR, total_per_hour: DEFAULT_TOTAL_PER_HOUR },
            pending: None,
            links_total: 0,
            current: None,
            previous: None,
            scope_counts: LookupMap::new(StorageKey::LinkScopeCounts),
            gc_queue: LookupMap::new(StorageKey::LinkGcQueue),
            gc_head: 0,
            gc_tail: 0,
        }
    }

    /// The thresholds in force at `now` (a scheduled raise counts once its time has come).
    pub fn thresholds_at(&self, now: u64) -> LinkThresholds {
        match &self.pending {
            Some(p) if now >= p.effective_at_ms => LinkThresholds { per_scope_per_hour: p.per_scope_per_hour, total_per_hour: p.total_per_hour },
            _ => self.thresholds,
        }
    }

    /// (current, previous) as they stand at `now`: a window older than the current hour has rolled over.
    pub fn windows_at(&self, now: u64) -> (LinkWindow, Option<LinkWindow>) {
        let start = window_start(now);
        match &self.current {
            Some(c) if c.window_start_ms == start => (c.clone(), self.previous.clone()),
            Some(c) if c.window_start_ms + LINK_WINDOW_MS == start => (LinkWindow::empty(start), Some(c.clone())),
            _ => (LinkWindow::empty(start), None),
        }
    }

    pub fn flush(&mut self) {
        self.scope_counts.flush();
        self.gc_queue.flush();
    }
}

impl Default for LinkCounter {
    fn default() -> Self {
        Self::new()
    }
}

pub fn window_start(ms: u64) -> u64 {
    ms / LINK_WINDOW_MS * LINK_WINDOW_MS
}

#[near(serializers = [json])]
#[derive(Clone, Debug, PartialEq)]
pub struct LinkStatsView {
    pub window_ms: u64,
    pub thresholds: LinkThresholds,
    /// A raise not yet in force.
    pub pending_thresholds: Option<PendingLinkThresholds>,
    pub links_total: u64,
    pub current: LinkWindow,
    /// The hour before `current`, when it had links.
    pub previous: Option<LinkWindow>,
}

#[near]
impl HanaSigner {
    /// Owner: sets the hourly alarm thresholds (each 1..=100000). They never refuse a link. A value lower than the one
    /// in force applies at once; a higher one could hide an attack, so it applies only after `governance_delay_ms`
    /// (the lowered parts of the pair apply now, the whole pair at the scheduled time). A new call replaces a scheduled
    /// raise. Event `link_thresholds_set`.
    pub fn set_link_thresholds(&mut self, per_scope_per_hour: u32, total_per_hour: u32) {
        self.assert_owner();
        let valid = |v: u32| (1..=MAX_LINK_THRESHOLD).contains(&v);
        assert!(valid(per_scope_per_hour) && valid(total_per_hour), "Link thresholds must be 1 to 100000");
        let now = env::block_timestamp_ms();
        let current = self.link_counter.thresholds_at(now);
        let lowered = LinkThresholds { per_scope_per_hour: per_scope_per_hour.min(current.per_scope_per_hour), total_per_hour: total_per_hour.min(current.total_per_hour) };
        self.link_counter.thresholds = lowered;
        let wanted = LinkThresholds { per_scope_per_hour, total_per_hour };
        let effective_at_ms = if wanted == lowered {
            self.link_counter.pending = None;
            now
        } else {
            let effective_at_ms = now.saturating_add(self.governance_delay_at(now));
            self.link_counter.pending = Some(PendingLinkThresholds { per_scope_per_hour, total_per_hour, effective_at_ms });
            effective_at_ms
        };
        events::emit(
            "link_thresholds_set",
            json!({ "per_scope_per_hour": per_scope_per_hour, "total_per_hour": total_per_hour, "effective_at_ms": effective_at_ms, "in_force": lowered }),
        );
    }

    /// The link counter: thresholds in force, a scheduled raise, the cumulative count, the current and previous hours.
    /// `total_threshold_reached` also reads the thresholds in force now, so a lowered threshold shows at once.
    pub fn get_link_stats(&self) -> LinkStatsView {
        let now = env::block_timestamp_ms();
        let thresholds = self.link_counter.thresholds_at(now);
        let (mut current, mut previous) = self.link_counter.windows_at(now);
        for window in std::iter::once(&mut current).chain(previous.iter_mut()) {
            window.total_threshold_reached |= window.total >= thresholds.total_per_hour;
        }
        LinkStatsView {
            window_ms: LINK_WINDOW_MS,
            thresholds,
            pending_thresholds: self.link_counter.pending.clone().filter(|p| now < p.effective_at_ms),
            links_total: self.link_counter.links_total,
            current,
            previous,
        }
    }
}

impl HanaSigner {
    /// Counts one new link in `scope_id` and records a threshold the count is at or above (event
    /// `link_threshold_reached` at the first crossing per window). Never refuses.
    pub(crate) fn count_link(&mut self, scope_id: &str) {
        let now = env::block_timestamp_ms();
        let thresholds = self.link_counter.thresholds_at(now);
        if let Some(p) = self.link_counter.pending.take_if(|p| now >= p.effective_at_ms) {
            self.link_counter.thresholds = LinkThresholds { per_scope_per_hour: p.per_scope_per_hour, total_per_hour: p.total_per_hour };
        }
        let (mut window, previous) = self.link_counter.windows_at(now);
        let start = window.window_start_ms;
        let mut record = self.link_counter.scope_counts.get(scope_id).filter(|c| c.window_start_ms == start).cloned().unwrap_or(ScopeLinkCount { window_start_ms: start, count: 0, flagged: false });
        if record.count == 0 {
            let tail = self.link_counter.gc_tail;
            self.link_counter.gc_queue.insert(tail, (start, scope_id.to_string()));
            self.link_counter.gc_tail = tail + 1;
        }
        record.count = record.count.saturating_add(1);
        window.total = window.total.saturating_add(1);
        if record.count >= thresholds.per_scope_per_hour && !record.flagged {
            record.flagged = true;
            if window.flagged_scopes.len() < MAX_FLAGGED_SCOPES {
                window.flagged_scopes.push(scope_id.to_string());
            } else {
                window.flagged_scopes_truncated = true;
            }
            events::emit("link_threshold_reached", json!({ "scope_id": scope_id, "window_start_ms": start, "count": record.count }));
        }
        if window.total >= thresholds.total_per_hour && !window.total_threshold_reached {
            window.total_threshold_reached = true;
            events::emit("link_threshold_reached", json!({ "scope_id": null, "window_start_ms": start, "count": window.total }));
        }
        self.link_counter.scope_counts.insert(scope_id.to_string(), record);
        self.link_counter.current = Some(window);
        self.link_counter.previous = previous;
        self.link_counter.links_total += 1;
        self.gc_link_counts(start);
    }

    /// Deletes up to `GC_PER_LINK` per-scope counts from windows older than the previous one (an entry refreshed in a
    /// later window has a later queue entry and is kept).
    fn gc_link_counts(&mut self, current_start: u64) {
        let keep_from = current_start.saturating_sub(LINK_WINDOW_MS);
        for _ in 0..GC_PER_LINK {
            let head = self.link_counter.gc_head;
            if head >= self.link_counter.gc_tail {
                break;
            }
            let Some((start, scope)) = self.link_counter.gc_queue.get(&head).cloned() else { break };
            if start >= keep_from {
                break;
            }
            if self.link_counter.scope_counts.get(&scope).is_some_and(|c| c.window_start_ms == start) {
                self.link_counter.scope_counts.remove(&scope);
            }
            self.link_counter.gc_queue.remove(&head);
            self.link_counter.gc_head = head + 1;
        }
    }
}
