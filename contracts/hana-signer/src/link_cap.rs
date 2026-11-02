//! Link volume: a counter and an hourly cap on new links (D200).
//!
//! A stolen email signing key can sign "owns victim@gmail.com" and, through automatic linking (D119), join that email
//! identity to the victim's Google identity: the thief then derives the victim's wallet. Every such takeover makes a
//! new link, so the contract counts new links and refuses them past an hourly cap, which bounds how many accounts a
//! thief can take over before the watchdog pages and pauses.
//!
//! - **Counted**: every new link, immediate or pending: the combined login with a `link_jwt` and `link_identity`
//!   (both go through `HanaSigner::join`). Not cancels, unlinks or lazy activations.
//! - **Windows**: fixed UTC hours, `window_start_ms = floor(block_ms / 3_600_000) * 3_600_000`. One count per scope
//!   and one in total; the current window and the previous one are kept, and a rollover starts a new current window.
//! - **Cap**: before a new link, if the scope's count in this window is already `per_scope_per_hour`, or the total is
//!   `total_per_hour`, the call panics `Link rate limit reached` (the whole call reverts: a capped login is refused,
//!   never completed without its link, D122). The link that makes a count equal its cap records it (`capped_scopes`,
//!   ≤ `MAX_CAPPED_SCOPES` in the order reached, or `total_cap_reached`) and emits `link_cap_reached`.
//! - **Limits**: `set_link_limits` (owner). A lower value applies at once; a higher one (a weakening) only after
//!   `governance_delay_ms`, like the delay setters' decreases.
//! - **Storage**: a per-scope count is kept only for scopes with links in the current or previous window. Each scope's
//!   first link in a window queues `(window, scope)`; every counted link deletes up to `GC_PER_LINK` queued entries
//!   older than the previous window, so the entries left behind never outnumber the links of the last windows that
//!   had any.

use near_sdk::serde_json::json;
use near_sdk::store::LookupMap;
use near_sdk::{env, near};

use crate::{events, HanaSigner, HanaSignerExt, StorageKey};

/// The window length: one hour.
pub const LINK_WINDOW_MS: u64 = 3_600_000;
/// Default caps (provisional until real traffic is measured, D200).
pub const DEFAULT_PER_SCOPE_PER_HOUR: u32 = 50;
pub const DEFAULT_TOTAL_PER_HOUR: u32 = 500;
/// Each cap is 1..=`MAX_LINK_LIMIT`.
pub const MAX_LINK_LIMIT: u32 = 100_000;
/// `capped_scopes` per window, at most (then `capped_scopes_truncated`).
pub const MAX_CAPPED_SCOPES: usize = 64;
/// Stale per-scope entries deleted by each counted link, at most.
const GC_PER_LINK: u32 = 4;

#[near(serializers = [borsh, json])]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct LinkLimits {
    pub per_scope_per_hour: u32,
    pub total_per_hour: u32,
}

/// A scheduled raise of the link limits (the full pair in force from `effective_at_ms`).
#[near(serializers = [borsh, json])]
#[derive(Clone, Debug, PartialEq)]
pub struct PendingLinkLimits {
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
    pub total_cap_reached: bool,
    /// Scopes that reached `per_scope_per_hour` in this window, in the order they reached it, ≤ `MAX_CAPPED_SCOPES`.
    pub capped_scopes: Vec<String>,
    /// More scopes reached the cap than `capped_scopes` holds (serialized only when true).
    #[serde(skip_serializing_if = "std::ops::Not::not", default)]
    pub capped_scopes_truncated: bool,
}

impl LinkWindow {
    fn empty(window_start_ms: u64) -> Self {
        Self { window_start_ms, total: 0, total_cap_reached: false, capped_scopes: vec![], capped_scopes_truncated: false }
    }
}

/// A scope's count in one window.
#[near(serializers = [borsh])]
#[derive(Clone, Debug, PartialEq)]
pub struct ScopeLinkCount {
    pub window_start_ms: u64,
    pub count: u32,
}

/// The counter's state (one field of the root struct, v3).
#[near(serializers = [borsh])]
pub struct LinkCap {
    /// The limits in force, unless `pending` has matured (read through `limits_at`).
    pub limits: LinkLimits,
    pub pending: Option<PendingLinkLimits>,
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

impl LinkCap {
    pub fn new() -> Self {
        Self {
            limits: LinkLimits { per_scope_per_hour: DEFAULT_PER_SCOPE_PER_HOUR, total_per_hour: DEFAULT_TOTAL_PER_HOUR },
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

    /// The limits in force at `now` (a scheduled raise counts once its time has come).
    pub fn limits_at(&self, now: u64) -> LinkLimits {
        match &self.pending {
            Some(p) if now >= p.effective_at_ms => LinkLimits { per_scope_per_hour: p.per_scope_per_hour, total_per_hour: p.total_per_hour },
            _ => self.limits,
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

impl Default for LinkCap {
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
    pub limits: LinkLimits,
    /// A raise not yet in force.
    pub pending_limits: Option<PendingLinkLimits>,
    pub links_total: u64,
    pub current: LinkWindow,
    /// The hour before `current`, when it had links.
    pub previous: Option<LinkWindow>,
}

#[near]
impl HanaSigner {
    /// Owner: sets the hourly link caps (each 1..=100000). A value lower than the one in force applies at once; a
    /// higher one is a weakening and applies only after `governance_delay_ms` (the lower parts of the pair apply now,
    /// the whole pair at the scheduled time). A new call replaces a scheduled raise. Event `link_limits_set`.
    pub fn set_link_limits(&mut self, per_scope_per_hour: u32, total_per_hour: u32) {
        self.assert_owner();
        let valid = |v: u32| (1..=MAX_LINK_LIMIT).contains(&v);
        assert!(valid(per_scope_per_hour) && valid(total_per_hour), "Link limits must be 1 to 100000");
        let now = env::block_timestamp_ms();
        let current = self.link_cap.limits_at(now);
        let lowered = LinkLimits { per_scope_per_hour: per_scope_per_hour.min(current.per_scope_per_hour), total_per_hour: total_per_hour.min(current.total_per_hour) };
        self.link_cap.limits = lowered;
        let wanted = LinkLimits { per_scope_per_hour, total_per_hour };
        let effective_at_ms = if wanted == lowered {
            self.link_cap.pending = None;
            now
        } else {
            let effective_at_ms = now.saturating_add(self.governance_delay_at(now));
            self.link_cap.pending = Some(PendingLinkLimits { per_scope_per_hour, total_per_hour, effective_at_ms });
            effective_at_ms
        };
        events::emit(
            "link_limits_set",
            json!({ "per_scope_per_hour": per_scope_per_hour, "total_per_hour": total_per_hour, "effective_at_ms": effective_at_ms, "in_force": lowered }),
        );
    }

    /// The link counter: limits in force, a scheduled raise, the cumulative count, and the current and previous hours.
    pub fn get_link_stats(&self) -> LinkStatsView {
        let now = env::block_timestamp_ms();
        let (current, previous) = self.link_cap.windows_at(now);
        LinkStatsView {
            window_ms: LINK_WINDOW_MS,
            limits: self.link_cap.limits_at(now),
            pending_limits: self.link_cap.pending.clone().filter(|p| now < p.effective_at_ms),
            links_total: self.link_cap.links_total,
            current,
            previous,
        }
    }
}

impl HanaSigner {
    /// Counts one new link in `scope_id`, or panics `Link rate limit reached` if the scope or the total has reached its
    /// cap in this hour. Records a cap the moment a count reaches it (event `link_cap_reached`).
    pub(crate) fn count_link(&mut self, scope_id: &str) {
        let now = env::block_timestamp_ms();
        let limits = self.link_cap.limits_at(now);
        if let Some(p) = self.link_cap.pending.take_if(|p| now >= p.effective_at_ms) {
            self.link_cap.limits = LinkLimits { per_scope_per_hour: p.per_scope_per_hour, total_per_hour: p.total_per_hour };
        }
        let (mut window, previous) = self.link_cap.windows_at(now);
        let start = window.window_start_ms;
        let scope_count = self.link_cap.scope_counts.get(scope_id).filter(|c| c.window_start_ms == start).map_or(0, |c| c.count);
        assert!(scope_count < limits.per_scope_per_hour && window.total < limits.total_per_hour, "Link rate limit reached");
        let scope_count = scope_count + 1;
        window.total += 1;
        if scope_count == 1 {
            let tail = self.link_cap.gc_tail;
            self.link_cap.gc_queue.insert(tail, (start, scope_id.to_string()));
            self.link_cap.gc_tail = tail + 1;
        }
        self.link_cap.scope_counts.insert(scope_id.to_string(), ScopeLinkCount { window_start_ms: start, count: scope_count });
        if scope_count == limits.per_scope_per_hour {
            if window.capped_scopes.len() < MAX_CAPPED_SCOPES {
                window.capped_scopes.push(scope_id.to_string());
            } else {
                window.capped_scopes_truncated = true;
            }
            events::emit("link_cap_reached", json!({ "scope_id": scope_id, "window_start_ms": start, "count": scope_count }));
        }
        if window.total == limits.total_per_hour {
            window.total_cap_reached = true;
            events::emit("link_cap_reached", json!({ "scope_id": null, "window_start_ms": start, "count": window.total }));
        }
        self.link_cap.current = Some(window);
        self.link_cap.previous = previous;
        self.link_cap.links_total += 1;
        self.gc_link_counts(start);
    }

    /// Deletes up to `GC_PER_LINK` per-scope counts from windows older than the previous one (an entry refreshed in a
    /// later window has a later queue entry and is kept).
    fn gc_link_counts(&mut self, current_start: u64) {
        let keep_from = current_start.saturating_sub(LINK_WINDOW_MS);
        for _ in 0..GC_PER_LINK {
            let head = self.link_cap.gc_head;
            if head >= self.link_cap.gc_tail {
                break;
            }
            let Some((start, scope)) = self.link_cap.gc_queue.get(&head).cloned() else { break };
            if start >= keep_from {
                break;
            }
            if self.link_cap.scope_counts.get(&scope).is_some_and(|c| c.window_start_ms == start) {
                self.link_cap.scope_counts.remove(&scope);
            }
            self.link_cap.gc_queue.remove(&head);
            self.link_cap.gc_head = head + 1;
        }
    }
}
