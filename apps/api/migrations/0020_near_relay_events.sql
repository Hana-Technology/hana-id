-- The NEAR meta-transaction relay's alerts (D736): `security_events` gains two kinds, `near_relay_budget_high` (a day's
-- relay spend reached 80% of `near.relay.dailyBudgetNear`) and `near_relay_balance_low` (the relay account below
-- `near.relay.lowBalanceNear`, or missing). Additive: no counter is stored in D1 (the limits and the budget live in the
-- RateLimiter Durable Objects). SQLite can't alter a CHECK, so the table is rebuilt as 0018 did: same columns, rows and
-- index. No table references it. Until it is applied the API's alert inserts fail and are logged
-- (`near_relay_alert_failed`, `near_relay_funds_check` `event_write_failed`); no request fails.
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low')),
  org_id      TEXT,
  app_id      TEXT,
  scope_id    TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  notified_at INTEGER
);
INSERT INTO security_events_new (id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at)
  SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at FROM security_events;
DROP TABLE security_events;
ALTER TABLE security_events_new RENAME TO security_events;
CREATE INDEX security_events_unnotified ON security_events (notified_at);
