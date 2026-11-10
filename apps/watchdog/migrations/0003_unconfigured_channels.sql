-- A channel with no credentials is not a failed send (D570). The first time an alert meets one, the watchdog records
-- one `deliveries` row ("not configured") and holds the channel here, a JSON array like `pending_channels`, instead of
-- retrying it on every run. A held channel is sent once it has credentials, only while the alert is still open
-- (unresolved, or critical and unacknowledged). `pending_channels` keeps its meaning: real send failures, retried.

ALTER TABLE alerts ADD COLUMN unconfigured_channels TEXT NOT NULL DEFAULT '[]';
