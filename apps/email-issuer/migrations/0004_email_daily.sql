-- Hana ID email issuer: per-app daily counters for the consoles' email views (build plan batch 9, D446). One row per UTC
-- day, app and metric: `sent`, `bounced`, `complained`, `refused:<limit name>` (ip:start:10m, mailbox:…, app:start:1d),
-- `alert:<event>[:code]`. Counts only: no address, no sub, no key. Rows for no app use app_id = '' (a limit checked
-- before the app is known, a staff or alert mail).
CREATE TABLE email_daily (
  day     TEXT NOT NULL,                 -- UTC, YYYY-MM-DD
  app_id  TEXT NOT NULL DEFAULT '',
  metric  TEXT NOT NULL CHECK (length(metric) BETWEEN 1 AND 96),
  count   INTEGER NOT NULL CHECK (count >= 0),
  PRIMARY KEY (day, app_id, metric)
) WITHOUT ROWID;
