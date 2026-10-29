-- Watchdog state (apps/watchdog, docs/governance-spec.md "Watchdog service"). Holds no secret: kids and key material
-- are public, alerts carry only public on-chain data.

-- Small key/value state: the last chain snapshot (for governance diffs), failure counters, digest and heartbeat state.
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Every kid this watchdog has seen in the issuer's JWKS (source 'jwks'), or found active on chain at its first run
-- without Google publishing it (source 'baseline': history it can't judge, so never paused on). n/e are JWK
-- base64url as first seen.
CREATE TABLE seen_kids (
  provider TEXT NOT NULL,
  kid TEXT NOT NULL,
  n TEXT,
  e TEXT,
  source TEXT NOT NULL CHECK (source IN ('jwks', 'baseline')),
  first_seen_at INTEGER NOT NULL,
  -- Last fetch that listed it (null for a baseline kid Google never listed).
  last_seen_at INTEGER,
  PRIMARY KEY (provider, kid)
);

-- First fetch (time of a successful JWKS fetch) at which a kid with a pending change was absent. A kid absent from two
-- fetches at least 60 s apart counts as not published. Deleted once the kid is listed again.
CREATE TABLE absences (
  provider TEXT NOT NULL,
  kid TEXT NOT NULL,
  first_absent_at INTEGER NOT NULL,
  PRIMARY KEY (provider, kid)
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  -- ok: every check ran; degraded: some were skipped (RPC or JWKS down); error: the run itself failed.
  outcome TEXT CHECK (outcome IN ('ok', 'degraded', 'error')),
  first_run INTEGER NOT NULL DEFAULT 0,
  -- JSON array of {id, outcome, detail?} (src/checks.ts CHECKS).
  checks TEXT NOT NULL DEFAULT '[]'
);

-- Every transaction the watchdog sent.
CREATE TABLE actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  method TEXT NOT NULL,
  args TEXT NOT NULL,
  reason TEXT NOT NULL,
  ok INTEGER NOT NULL,
  tx_hash TEXT,
  error TEXT
);
CREATE INDEX actions_at ON actions (at);

CREATE TABLE alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  -- Dedup key: a condition alert is raised once while its condition lasts; an event alert once ever.
  key TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('critical', 'warning', 'info')),
  title TEXT NOT NULL,
  details TEXT NOT NULL,
  run_id INTEGER,
  created_at INTEGER NOT NULL,
  -- When the condition stopped (event alerts: at creation).
  resolved_at INTEGER,
  -- JSON array of channels whose first delivery hasn't succeeded yet (retried whether or not the alert is acked).
  pending_channels TEXT NOT NULL DEFAULT '[]',
  last_sent_at INTEGER,
  send_count INTEGER NOT NULL DEFAULT 0,
  -- The paging app's reference for the last page (Pushover receipt, PagerDuty dedup key), for ack polling.
  pager_ref TEXT,
  acked_at INTEGER,
  acked_by TEXT,
  acked_via TEXT CHECK (acked_via IS NULL OR acked_via IN ('portal', 'pager'))
);
CREATE INDEX alerts_key ON alerts (key);
CREATE INDEX alerts_open ON alerts (severity, acked_at);

-- One row per send attempt per channel (first delivery, re-send, digest).
CREATE TABLE deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  alert_id INTEGER,
  channel TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('first', 'resend', 'digest')),
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  error TEXT
);
CREATE INDEX deliveries_alert ON deliveries (alert_id);
