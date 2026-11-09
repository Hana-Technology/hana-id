-- Hana ID email issuer: the SendGrid events already counted (D446 as amended), so a redelivered webhook adds nothing to
-- `email_daily`. One row per counted bounce or complaint. `event_key` is the SHA-256 (hex) of SendGrid's `sg_event_id`
-- (src/webhook.ts): no address, no sub, no key. SendGrid retries for up to 24 hours, so `retention:issuer` deletes rows
-- older than 7 days.
CREATE TABLE email_webhook_events (
  event_key TEXT PRIMARY KEY CHECK (length(event_key) = 64),
  at_ms     INTEGER NOT NULL
) WITHOUT ROWID;
CREATE INDEX email_webhook_events_at ON email_webhook_events (at_ms);
