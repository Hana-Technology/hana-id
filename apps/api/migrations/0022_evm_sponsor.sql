-- EVM gas sponsorship (D847, D848, D852): the audit row of every sponsored send, the billing record of every sponsored
-- transaction, and the security event kinds.
-- Expand-only: a new table and a widened CHECK. An API ahead of it refuses every send (`503 audit_unavailable`: no row,
-- nothing is sent) and logs its alerts' failed inserts (`evm_sponsor_alert_failed`); an API without sponsorship
-- configured never touches either. Applied by the founder (docs/operations.md "Migrations").

-- One row per send that reached the reservation (`sending`), updated as it goes: `sent` (the relayer gave its hash),
-- then `executed`, `reverted` or `not_executed` from the receipt, `timeout` (no receipt within 30 s), `rejected` (no
-- node took the batch: the relayer gave its nonce to its own cancel at once; `rejection` says whose doing it was),
-- `refused` (nothing was sent: a coded relayer refusal), `duplicate` (a second row of one digest whose transaction is
-- billed to the other row: settled at zero, its reservation given back), `unknown` (the relayer failed: it may or may not have
-- broadcast), `mined` (the relayer saw it mined, its receipt unreadable), `consumed_elsewhere` (staff closed the
-- relayer's record) or `lost` (the reconciler gave up: no receipt and the relayer no longer remembers it; the
-- reservation is kept). `sending`, `sent`, `timeout`, `unknown` and `rejected` are settled by the request or, failing
-- that, by the cron's reconciler (D848); the reservation's parts are kept for it. Amounts in wei as decimal strings (they exceed 2^53). The
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
  -- Every hash the relayer reported for the digest (its answer, then each lookup: fee bumps, the deadline's cancel), so
  -- receipts can be read for all of them after the relayer forgets the digest. A JSON array, at most 80 entries.
  tx_hashes     TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(tx_hashes) AND json_type(tx_hashes) = 'array' AND json_array_length(tx_hashes) <= 80),
  relayer_nonce INTEGER CHECK (relayer_nonce IS NULL OR relayer_nonce >= 0),
  reserved_wei  TEXT NOT NULL CHECK (length(reserved_wei) BETWEEN 1 AND 78),
  deadline      INTEGER NOT NULL CHECK (deadline > 0),
  gas_limit     TEXT NOT NULL CHECK (length(gas_limit) BETWEEN 1 AND 20),
  fee_cap_wei   TEXT NOT NULL CHECK (length(fee_cap_wei) BETWEEN 1 AND 78),
  l1_bound_wei  TEXT NOT NULL CHECK (length(l1_bound_wei) BETWEEN 1 AND 78),
  op_bound_wei  TEXT NOT NULL CHECK (length(op_bound_wei) BETWEEN 1 AND 78),
  replay        INTEGER NOT NULL DEFAULT 0 CHECK (replay IN (0, 1)),
  -- The batch's shape, for its billing record: the number of calls, each call's allowlisted target and selector (public
  -- chain data, JSON), and whether it carried the one-time setup.
  call_count    INTEGER NOT NULL CHECK (call_count BETWEEN 1 AND 8),
  targets_json  TEXT NOT NULL CHECK (json_valid(targets_json)),
  with_setup    INTEGER NOT NULL CHECK (with_setup IN (0, 1)),
  settled_wei   TEXT CHECK (settled_wei IS NULL OR length(settled_wei) BETWEEN 1 AND 78),
  -- A rejected batch's `<cause>:<code>` as the relayer gave it (`request:gas_limit`, `relayer:insufficient_funds`,
  -- `pricing:…`): whose doing it was decides whether the user's failure slot was charged.
  rejection     TEXT CHECK (rejection IS NULL OR (length(rejection) BETWEEN 3 AND 65 AND rejection NOT GLOB '*[^a-z_:]*')),
  status        TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'executed', 'reverted', 'not_executed', 'mined', 'timeout', 'unknown', 'rejected', 'refused', 'lost', 'consumed_elsewhere', 'duplicate')),
  -- When the relayer's own verdict at confirmed depth (its `lookup`: mined, the row's hash) agreed with the outcome; NULL
  -- for a row settled from a receipt at head until the reconciler checks it (and corrects a reorg, D847).
  confirmed_at  INTEGER,
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
CREATE INDEX evm_sponsor_sends_open ON evm_sponsor_sends (status, updated_at) WHERE status IN ('sending', 'sent', 'timeout', 'unknown', 'rejected');
CREATE INDEX evm_sponsor_sends_created ON evm_sponsor_sends (created_at);
-- Settled from a receipt at head, not yet checked against the relayer's verdict at confirmed depth (the reconciler).
CREATE INDEX evm_sponsor_sends_unconfirmed ON evm_sponsor_sends (updated_at) WHERE confirmed_at IS NULL AND status IN ('executed', 'reverted', 'not_executed');

-- The billing record (D852): one per sponsored transaction that reached the chain (the batch: executed, reverted or run
-- without effect; or the relayer's deadline self-transfer: cancelled), and one per charge with no mined transaction of
-- its own (`lost`, `consumed_elsewhere`: the kept reservation is the amount), so the books add up. Written in the same D1
-- batch as the audit row's final move, at most once per (chain, transaction) and per send. NO personal data: no account
-- address, user id or IP; the transaction hash is public chain data. NEVER pruned and NOT erased with a user (it is the
-- business's record of what it paid; the audit row that linked it to a user goes with the user). No foreign key, so
-- neither the audit row's erasure nor its 24-month retention touches it. Amounts in wei (decimal strings); no USD here.
-- Copied to the usage ledger (`usage.evm_sponsored_txs`) by the cron; `mirrored_at` says when.
CREATE TABLE evm_sponsor_billing (
  chain_id                INTEGER NOT NULL CHECK (chain_id > 0),
  record_key              TEXT NOT NULL CHECK (length(record_key) BETWEEN 1 AND 80),  -- the tx hash, or 'send:<es_…>' without one
  send_id                 TEXT NOT NULL CHECK (send_id GLOB 'es_*'),
  -- A correction (D847, a reorg the relayer's verdict showed): the key of the record it supersedes for this send; the
  -- correction's own key is 'fix:<send>'. Records are never edited.
  corrects                TEXT CHECK (corrects IS NULL OR length(corrects) BETWEEN 1 AND 80),
  org_id                  TEXT NOT NULL,
  app_id                  TEXT NOT NULL,
  environment             TEXT NOT NULL,
  tx_hash                 TEXT CHECK (tx_hash IS NULL OR (length(tx_hash) = 66 AND tx_hash GLOB '0x*')),
  block_number            TEXT,
  block_timestamp         INTEGER,
  outcome                 TEXT NOT NULL CHECK (outcome IN ('executed', 'reverted', 'not_executed', 'cancelled', 'mined', 'lost', 'consumed_elsewhere')),
  gas_used                TEXT,
  effective_gas_price_wei TEXT,
  execution_wei           TEXT,
  l1_fee_wei              TEXT,
  operator_fee_wei        TEXT,
  total_cost_wei          TEXT,
  settled_wei             TEXT NOT NULL CHECK (length(settled_wei) BETWEEN 1 AND 78),
  call_count              INTEGER NOT NULL,
  targets_json            TEXT NOT NULL CHECK (json_valid(targets_json)),
  with_setup              INTEGER NOT NULL CHECK (with_setup IN (0, 1)),
  created_at              INTEGER NOT NULL,
  settled_at              INTEGER NOT NULL,
  mirrored_at             INTEGER,
  -- A record the ledger refused on its own (one bad row never blocks the others): set aside, with `evm_billing_late`.
  quarantined_at          INTEGER,
  PRIMARY KEY (chain_id, record_key),
  -- A mined transaction has its hash as its key; a charge without one has the send as its key.
  CHECK ((tx_hash IS NOT NULL AND corrects IS NULL AND record_key = tx_hash) OR (tx_hash IS NOT NULL AND corrects IS NOT NULL AND record_key = 'fix:' || send_id)
         OR (tx_hash IS NULL AND corrects IS NULL AND outcome IN ('lost', 'consumed_elsewhere') AND record_key = 'send:' || send_id))
);
-- One record per send, and at most one correction of it.
CREATE UNIQUE INDEX evm_sponsor_billing_send ON evm_sponsor_billing (send_id) WHERE corrects IS NULL;
CREATE UNIQUE INDEX evm_sponsor_billing_fix ON evm_sponsor_billing (send_id) WHERE corrects IS NOT NULL;
CREATE INDEX evm_sponsor_billing_org ON evm_sponsor_billing (org_id, settled_at);
CREATE INDEX evm_sponsor_billing_app ON evm_sponsor_billing (app_id, settled_at);
CREATE INDEX evm_sponsor_billing_unmirrored ON evm_sponsor_billing (settled_at) WHERE mirrored_at IS NULL AND quarantined_at IS NULL;
CREATE INDEX evm_sponsor_billing_quarantined ON evm_sponsor_billing (settled_at) WHERE quarantined_at IS NOT NULL AND mirrored_at IS NULL;

-- `security_events` gains `evm_relay_budget_high` (a chain's day spend reached 80% of `dailyBudgetEth`, once a day),
-- `evm_relay_balance_low` (the relayer below `lowBalanceEth`, once a day), `evm_relay_stuck` (a relayer transaction
-- unmined over 10 minutes, the relayer halted, or a send unsettled over 10, once an hour) and `evm_relay_receipt_odd` (a receipt outside what
-- the reservation assumed, settled at the reservation; once an hour) and `evm_relay_nonce_taken` (the relayer's nonce for
-- a batch went to something that is no version of it; the batch didn't run; once an hour) and `evm_billing_late` (a
-- settled send without its billing record, or a record not yet copied to the usage ledger, an hour on; once an hour). SQLite can't alter a CHECK, so the table is rebuilt as 0020 did:
-- same columns, rows and index. No table references it.
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late')),
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
