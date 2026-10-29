-- Governance batch (docs/governance-spec.md "Rotation and logins"): issuer keys change on chain only through a
-- public, cancellable delay. The JWKS cron (src/issuer-keys.ts) proposes changes and executes matured ones; these
-- tables are its memory between runs. Public data only (kids, change ids, timestamps, outcome codes).

-- One row per change the cron proposed and has not yet seen resolved. A row whose change is neither pending nor
-- applied on chain was cancelled (by the owner or a watchdog): `cancelled_seen_at` is set once, and the cron does
-- not propose that kid and op again until REPROPOSE_AFTER_CANCEL_MS later.
CREATE TABLE issuer_key_proposals (
  provider          TEXT NOT NULL,
  kid               TEXT NOT NULL,
  op                TEXT NOT NULL CHECK (op IN ('Add', 'Remove')),
  change_id         INTEGER,                -- the id set_issuer_key / propose_issuer_key_removal returned
  proposed_at       INTEGER NOT NULL,       -- unix ms
  cancelled_seen_at INTEGER,                -- unix ms: first run that saw it cancelled
  PRIMARY KEY (provider, kid, op)
);

-- The last cron sync per provider, for GET /v1/governance (the admin portal's "Security & monitoring" view).
CREATE TABLE issuer_key_sync_runs (
  provider  TEXT PRIMARY KEY,
  at_ms     INTEGER NOT NULL,               -- unix ms
  outcome   TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'skipped')),
  code      TEXT,                           -- why it skipped (e.g. no_keys_updater_key) or failed
  summary   TEXT NOT NULL                   -- JSON: the run's SyncResult (kids and change ids only)
);
