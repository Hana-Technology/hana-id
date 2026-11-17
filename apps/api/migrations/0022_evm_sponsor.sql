-- EVM gas sponsorship (D847, D848): the audit row of every sponsored send, and three security event kinds.
-- Expand-only: a new table and a widened CHECK. An API ahead of it refuses every send (`503 audit_unavailable`: no row,
-- nothing is sent) and logs its alerts' failed inserts (`evm_sponsor_alert_failed`); an API without sponsorship
-- configured never touches either. Applied by the founder (docs/operations.md "Migrations").

-- One row per send that reached the reservation (`sending`), updated as it goes: `sent` (the relayer gave its hash),
-- then `executed`, `reverted` or `not_executed` from the receipt, `timeout` (no receipt within 30 s), `refused` (nothing
-- was sent: a simulation revert, a coded relayer refusal, or the reconciler finding the relayer never had it past the
-- deadline), `unknown` (the relayer failed: it may or may not have broadcast) or `lost` (the reconciler gave up: no
-- receipt and the relayer no longer remembers it; the reservation is kept). `sending`, `sent`, `timeout` and `unknown`
-- are settled by the request or, failing that, by the cron's reconciler (D848); the reservation's parts are kept for it. Amounts in wei as decimal strings (they exceed 2^53). The
-- user's rows go with the user (`ON DELETE CASCADE` from the directory's `end_users`, and `scripts/lib/uid-erase.ts`
-- deletes by the user's wallet addresses too, for rows written without a directory user).
CREATE TABLE evm_sponsor_sends (
  id            TEXT PRIMARY KEY CHECK (id GLOB 'es_*' AND length(id) = 35),
  app_id        TEXT NOT NULL,
  chain_id      INTEGER NOT NULL CHECK (chain_id > 0),
  account       TEXT NOT NULL CHECK (length(account) = 42 AND account GLOB '0x*'),
  user_id       TEXT REFERENCES end_users (user_id) ON DELETE CASCADE CHECK (user_id IS NULL OR (user_id GLOB 'hu_*' AND length(user_id) = 29)),
  digest        TEXT NOT NULL CHECK (length(digest) = 66 AND digest GLOB '0x*'),
  execute_nonce TEXT NOT NULL CHECK (length(execute_nonce) BETWEEN 1 AND 20),
  tx_hash       TEXT CHECK (tx_hash IS NULL OR (length(tx_hash) = 66 AND tx_hash GLOB '0x*')),
  relayer_nonce INTEGER CHECK (relayer_nonce IS NULL OR relayer_nonce >= 0),
  reserved_wei  TEXT NOT NULL CHECK (length(reserved_wei) BETWEEN 1 AND 78),
  deadline      INTEGER NOT NULL CHECK (deadline > 0),
  gas_limit     TEXT NOT NULL CHECK (length(gas_limit) BETWEEN 1 AND 20),
  fee_cap_wei   TEXT NOT NULL CHECK (length(fee_cap_wei) BETWEEN 1 AND 78),
  l1_bound_wei  TEXT NOT NULL CHECK (length(l1_bound_wei) BETWEEN 1 AND 78),
  op_bound_wei  TEXT NOT NULL CHECK (length(op_bound_wei) BETWEEN 1 AND 78),
  replay        INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0, 1)),
  settled_wei   TEXT CHECK (settled_wei IS NULL OR length(settled_wei) BETWEEN 1 AND 78),
  status        TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'executed', 'reverted', 'not_executed', 'timeout', 'unknown', 'refused', 'lost')),
  request_id    TEXT NOT NULL,
  created_at    INTEGER NOT NULL CHECK (created_at >= 0),
  updated_at    INTEGER NOT NULL CHECK (updated_at >= created_at)
);
-- A replay's answer (chain, digest), the erasure by address, the erasure and cascade by user, an app's history, the
-- reconciler's open rows, the retention prune (24 months).
CREATE INDEX evm_sponsor_sends_digest ON evm_sponsor_sends (chain_id, digest, created_at DESC);
CREATE INDEX evm_sponsor_sends_account ON evm_sponsor_sends (account);
CREATE INDEX evm_sponsor_sends_user ON evm_sponsor_sends (user_id);
CREATE INDEX evm_sponsor_sends_app ON evm_sponsor_sends (app_id, created_at DESC);
CREATE INDEX evm_sponsor_sends_open ON evm_sponsor_sends (status, updated_at) WHERE status IN ('sending', 'sent', 'timeout', 'unknown');
CREATE INDEX evm_sponsor_sends_created ON evm_sponsor_sends (created_at);

-- `security_events` gains `evm_relay_budget_high` (a chain's day spend reached 80% of `dailyBudgetEth`, once a day),
-- `evm_relay_balance_low` (the relayer below `lowBalanceEth`, once a day), `evm_relay_stuck` (a relayer transaction
-- pending over 5 minutes, or a send unsettled over 10, once an hour) and `evm_relay_receipt_odd` (a receipt outside what
-- the reservation assumed, settled at the reservation; once an hour) and `evm_relay_nonce_taken` (the relayer's nonce for
-- a batch went to something that is no version of it; the batch didn't run; once an hour). SQLite can't alter a CHECK, so the table is rebuilt as 0020 did:
-- same columns, rows and index. No table references it.
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken')),
  org_id      TEXT,
  app_id      TEXT,
  scope_id    TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  notified_at INTEGER
);
INSERT INTO security_events_new (id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at)
  SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at FROM security_events;
DROP TABLE security_events;
ALTER TABLE security_events_new RENAME TO security_events;
CREATE INDEX security_events_unnotified ON security_events (notified_at);
