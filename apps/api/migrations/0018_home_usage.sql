-- Hana Home's derive (batch H3, docs/hana-home-build-plan.md, D520, D523). Two changes, both expand-only for the API that
-- reads them: applied before the API that writes the new shapes (D1 first).
--
-- `home_usage`: Home derives per UTC day (one row a day, a count: nothing personal), incremented atomically by
-- POST /v1/home/login right before it relays, and refused at the env's daily ceiling (HOME_DERIVES_PER_DAY, default 500).
CREATE TABLE home_usage (
  day     TEXT PRIMARY KEY CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  derives INTEGER NOT NULL DEFAULT 0 CHECK (derives >= 0)
);

-- `user_events.app_id` becomes nullable, for `key_exported` only: a Home derive is per scope and names no app, and
-- naming one of the scope's apps would be a false row (D520): 0016's backfill read `app_id` as proof that the app had a
-- login, and the admin's Users screen shows it as the app the user exported from. SQLite can't drop a NOT NULL, so the
-- table is rebuilt: same columns, `id`s and indexes; the one new CHECK says only a `key_exported` row may have no app.
-- No table references this one; the old API keeps working during the rebuild (it writes `app_id` always).
CREATE TABLE user_events_new (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('key_exported', 'mainnet_signature')),
  app_id     TEXT,
  scope_id   TEXT NOT NULL,
  user_id    TEXT CHECK (user_id IS NULL OR (user_id GLOB 'hu_*' AND length(user_id) = 29)),
  chain      TEXT CHECK (chain IS NULL OR chain IN ('stellar', 'evm')),
  network    TEXT CHECK (network IS NULL OR (length(network) BETWEEN 1 AND 16)),
  address    TEXT CHECK (address IS NULL OR (length(address) BETWEEN 42 AND 56)),
  usd_micros INTEGER CHECK (usd_micros IS NULL OR usd_micros >= 0),
  request_id TEXT NOT NULL,
  at         INTEGER NOT NULL CHECK (at >= 0),
  CHECK (kind <> 'key_exported' OR user_id IS NOT NULL),
  CHECK (kind <> 'mainnet_signature' OR (user_id IS NOT NULL AND address IS NOT NULL AND chain IS NOT NULL AND network IS NOT NULL)),
  CHECK (app_id IS NOT NULL OR kind = 'key_exported')
);
INSERT INTO user_events_new (id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
  SELECT id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at FROM user_events;
DROP TABLE user_events;
ALTER TABLE user_events_new RENAME TO user_events;
CREATE INDEX user_events_user ON user_events (user_id, kind, at DESC);
CREATE INDEX user_events_address ON user_events (address, at DESC);
CREATE INDEX user_events_app ON user_events (app_id, kind, at DESC);
