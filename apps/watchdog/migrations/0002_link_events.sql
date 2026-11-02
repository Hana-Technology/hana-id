-- The link-volume check (email login, docs/email-login-spec.md "Watchdog"): the signer's identity_link_* events as
-- the indexer reported them, kept 8 days. Counts only: scope and provider, never a root or member identity key.
CREATE TABLE link_events (
  -- `<receipt id>:<log index>:<data index>`: one event, however often a scan re-reads its block.
  id TEXT PRIMARY KEY,
  event TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  -- 1/0 for identity_linked and identity_link_proposed (an automatic link), NULL for the other events.
  auto INTEGER,
  -- Block time of the receipt (ms).
  at INTEGER NOT NULL,
  block_height INTEGER NOT NULL
);
CREATE INDEX link_events_at ON link_events (at);
