-- D925 after PR 153's review: one index on `audit_log`, so the linking view's "one `rate_limited` row per member per
-- hour" check (apps/console/src/users.ts `firstRefusalInWindow`) reads that member's recent rows only, however large the
-- 60-month log grows. Additive: no table rebuilt, no trigger or view touched (the console's migration test compares
-- them), no row written. The Worker works without it (that check is then a scan), so it may be applied before or after
-- the Worker that reads it. Applied by the Tech Lead with the others.
CREATE INDEX audit_log_actor_action_at ON audit_log (actor_id, action, at);
