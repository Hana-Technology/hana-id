-- NEAR as the directory's third wallet chain (D755–D757; docs/architecture.md "Wallet directory"). Two CHECKs widen, nothing
-- else changes: expand-only for every API that reads or writes these tables, so it applies the same before or after
-- the API that writes NEAR rows (which falls back without them: a NEAR wallet write is its own statement and its
-- failure leaves the Stellar and EVM rows written; a NEAR export is recorded with no chain). Apply it before or after
-- that API; until it is applied no NEAR account is recorded.
--
-- SQLite can't alter a CHECK, so each table is rebuilt (as 0018 did for `user_events`): same columns, rows, keys and
-- indexes. No table references either one (`end_user_wallets` references `end_users`, which this file doesn't touch).

-- `end_user_wallets`: `chain` gains 'near'; `address` may be 64 characters, a NEAR implicit account id (lowercase hex
-- of the Ed25519 key). Stellar addresses stay StrKey (56), EVM EIP-55 (42).
CREATE TABLE end_user_wallets_new (
  user_id       TEXT NOT NULL REFERENCES end_users (user_id) ON DELETE CASCADE,
  chain         TEXT NOT NULL CHECK (chain IN ('stellar', 'evm', 'near')),
  address       TEXT NOT NULL CHECK (length(address) BETWEEN 42 AND 64),
  key_index     INTEGER NOT NULL CHECK (key_index >= 0 AND key_index < 2147483648),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_used_at  INTEGER NOT NULL CHECK (last_used_at >= first_seen_at),
  PRIMARY KEY (user_id, chain, address)
);
INSERT INTO end_user_wallets_new (user_id, chain, address, key_index, first_seen_at, last_used_at)
  SELECT user_id, chain, address, key_index, first_seen_at, last_used_at FROM end_user_wallets;
DROP TABLE end_user_wallets;
ALTER TABLE end_user_wallets_new RENAME TO end_user_wallets;
CREATE INDEX end_user_wallets_address ON end_user_wallets (address);

-- `user_events`: a `key_exported` row may name 'near' (the export window's label). A mainnet demo signature never does
-- (the demo covers Stellar and EVM only), and its address stays 42 to 56 characters.
CREATE TABLE user_events_new (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('key_exported', 'mainnet_signature')),
  app_id     TEXT,
  scope_id   TEXT NOT NULL,
  user_id    TEXT CHECK (user_id IS NULL OR (user_id GLOB 'hu_*' AND length(user_id) = 29)),
  chain      TEXT CHECK (chain IS NULL OR chain IN ('stellar', 'evm', 'near')),
  network    TEXT CHECK (network IS NULL OR (length(network) BETWEEN 1 AND 16)),
  address    TEXT CHECK (address IS NULL OR (length(address) BETWEEN 42 AND 56)),
  usd_micros INTEGER CHECK (usd_micros IS NULL OR usd_micros >= 0),
  request_id TEXT NOT NULL,
  at         INTEGER NOT NULL CHECK (at >= 0),
  CHECK (kind <> 'key_exported' OR user_id IS NOT NULL),
  CHECK (kind <> 'mainnet_signature' OR (user_id IS NOT NULL AND address IS NOT NULL AND chain IS NOT NULL AND network IS NOT NULL)),
  CHECK (kind <> 'mainnet_signature' OR chain <> 'near'),
  CHECK (app_id IS NOT NULL OR kind = 'key_exported')
);
INSERT INTO user_events_new (id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at)
  SELECT id, kind, app_id, scope_id, user_id, chain, network, address, usd_micros, request_id, at FROM user_events;
DROP TABLE user_events;
ALTER TABLE user_events_new RENAME TO user_events;
CREATE INDEX user_events_user ON user_events (user_id, kind, at DESC);
CREATE INDEX user_events_address ON user_events (address, at DESC);
CREATE INDEX user_events_app ON user_events (app_id, kind, at DESC);
