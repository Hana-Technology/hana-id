-- The mainnet demo exception to D39 and key export events (D428, D430; docs/mainnet-demo-and-key-export-spec.md).
-- Numbered 0013, the next free number on develop (feat/email-sharing's unmerged 0012 takes a later number at its
-- merge). Applying it is a manual step (docs/operations.md "Migrations"); until then the API serves
-- `mainnetDemo: false` and records no event (it reads and writes these with a fallback).

-- apps.mainnet_demo: Hana staff's switch (admin.ts app:settings --mainnet-demo, AdminRpc.setMainnetDemo), 0 or 1. The
-- writers refuse it outside a dev env on testnet; the API serves it only there; these triggers refuse 1 for an app
-- whose scope isn't a test scope, whatever writes it.
ALTER TABLE apps ADD COLUMN mainnet_demo INTEGER NOT NULL DEFAULT 0 CHECK (mainnet_demo IN (0, 1));

CREATE TRIGGER apps_mainnet_demo_test_only_insert
BEFORE INSERT ON apps
WHEN NEW.mainnet_demo = 1 AND COALESCE((SELECT environment FROM scopes WHERE scope_id = NEW.scope_id), 'live') <> 'test'
BEGIN
  SELECT RAISE(ABORT, 'mainnet_demo is for test apps only');
END;

CREATE TRIGGER apps_mainnet_demo_test_only_update
BEFORE UPDATE OF mainnet_demo, scope_id ON apps
WHEN NEW.mainnet_demo = 1 AND COALESCE((SELECT environment FROM scopes WHERE scope_id = NEW.scope_id), 'live') <> 'test'
BEGIN
  SELECT RAISE(ABORT, 'mainnet_demo is for test apps only');
END;

-- What happened to a user's keys that staff should see (the admin's Users detail and Support ID lookup):
--   key_exported       the export window's /v1/login succeeded (the key could reach that window), written by the API;
--                      user_id is the account's internal id (hu_…), chain from the export window's label (or NULL).
--   mainnet_signature  a mainnet demo signature, as the vault reported it after signing (its word, not a proof);
--                      address is the signing wallet, network the EVM chain ID or 'pubnet', usd_micros the value.
-- Never a key, a token, a signature, the signed bytes or a path. Times are unix ms.
CREATE TABLE user_events (
  id         INTEGER PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('key_exported', 'mainnet_signature')),
  app_id     TEXT NOT NULL,
  scope_id   TEXT NOT NULL,
  user_id    TEXT CHECK (user_id IS NULL OR (user_id GLOB 'hu_*' AND length(user_id) = 29)),
  chain      TEXT CHECK (chain IS NULL OR chain IN ('stellar', 'evm')),
  network    TEXT CHECK (network IS NULL OR (length(network) BETWEEN 1 AND 16)),
  address    TEXT CHECK (address IS NULL OR (length(address) BETWEEN 42 AND 56)),
  usd_micros INTEGER CHECK (usd_micros IS NULL OR usd_micros >= 0),
  request_id TEXT NOT NULL,
  at         INTEGER NOT NULL CHECK (at >= 0),
  CHECK (kind <> 'key_exported' OR user_id IS NOT NULL),
  CHECK (kind <> 'mainnet_signature' OR (address IS NOT NULL AND chain IS NOT NULL AND network IS NOT NULL))
);
CREATE INDEX user_events_user ON user_events (user_id, at DESC);
CREATE INDEX user_events_address ON user_events (address, at DESC);
CREATE INDEX user_events_app ON user_events (app_id, kind, at DESC);
