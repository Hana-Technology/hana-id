-- D927: the platform API's call log (piece P3 of docs/partner-platform-spec.md, A7 `platform_calls`, L7). Additive:
-- one new table, its two indexes and its three triggers; no existing table, index or trigger is touched, and nothing
-- elsewhere reads it. Applied by the Tech Lead on a deployed env (docs/operations.md "Platform API (hot-DB migration
-- 0032, D927)"); nothing writes it until an org's platform switch is on.
--
-- One row per platform request that was authenticated AND admitted (its signature verified with a key in force here,
-- its org's switch on and not frozen or the route a kill switch allowed then, its nonce fresh, its limits not
-- reached), whatever the route then answered. A request refused before that is never stored (anyone could fill the
-- hot DB with them): it is counted by the limiter objects and written to the request log (`event: "platform"`). Kept
-- 13 months, then purged by the admin Worker's monthly retention job (AdminRpc.purgePlatformCalls). Append-only:
-- an update is refused, a delete before 13 months is refused, an insert that would replace a row is refused.
-- Times are integer ms UTC. No secret, no signature, no nonce, no body: the route's template, never its ids beyond
-- the app's.

CREATE TABLE platform_calls (
  seq        INTEGER PRIMARY KEY CHECK (seq > 0),
  at         INTEGER NOT NULL,
  org_id     TEXT NOT NULL CHECK (org_id GLOB 'org_*'),
  key_id     TEXT NOT NULL CHECK (key_id GLOB 'pkc_*'),
  method     TEXT NOT NULL CHECK (method IN ('GET', 'POST')),
  route      TEXT NOT NULL CHECK (route GLOB '/v1/platform/*' AND length(route) <= 128),  -- the route's template, e.g. /v1/platform/apps/:appId
  app_id     TEXT CHECK (app_id IS NULL OR app_id GLOB 'app_*'),
  status     INTEGER NOT NULL CHECK (status BETWEEN 200 AND 599),
  code       TEXT CHECK (code IS NULL OR (length(code) BETWEEN 1 AND 64 AND code NOT GLOB '*[^a-z_]*')),  -- the error code; NULL for a success
  request_id TEXT NOT NULL CHECK (length(request_id) BETWEEN 1 AND 128),                -- the answer's `requestId` (x-request-id)
  ip_prefix  TEXT CHECK (ip_prefix IS NULL OR length(ip_prefix) <= 64)                  -- IPv4 /24 or IPv6 /48 of the caller
);

CREATE INDEX platform_calls_org ON platform_calls (org_id, seq);
CREATE INDEX platform_calls_at ON platform_calls (at);

-- An INSERT OR REPLACE naming a `seq` already held would delete that row without a DELETE trigger firing: refused.
-- In a BEFORE INSERT trigger an automatic rowid reads as -1, so the rule looks only at a `seq` the writer named (> 0;
-- the CHECK keeps every stored `seq` above 0, so no row can sit at -1 and block every automatic insert: after PR 156's
-- review, F6).
CREATE TRIGGER platform_calls_no_replace BEFORE INSERT ON platform_calls
  WHEN NEW.seq > 0 AND EXISTS (SELECT 1 FROM platform_calls WHERE seq = NEW.seq)
BEGIN
  SELECT RAISE(ABORT, 'platform_calls is append-only');
END;

CREATE TRIGGER platform_calls_no_update BEFORE UPDATE ON platform_calls
BEGIN
  SELECT RAISE(ABORT, 'platform_calls is append-only');
END;

CREATE TRIGGER platform_calls_no_early_delete BEFORE DELETE ON platform_calls
  WHEN OLD.at >= (unixepoch('now', '-13 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'platform_calls rows are kept 13 months');
END;
