-- The NEAR meta-transaction relay's billing records (D863): one permanent record per NEAR transaction the relay sent
-- for a user that reached the chain (a relayed delegate action or an account activation; success or failure), so a
-- future billing of partners can count what Journear paid (how to bill is not decided). Records exist only from the
-- deploy of this code on: nothing before it can be rebuilt from D1 (see docs/operations.md "NEAR relay billing
-- records").
--
-- Additive only, and safe on the running relay: a new table, and `security_events` rebuilt to widen its CHECK (as 0020
-- and 0022 did: same columns, rows and index). The relay never waits for this table: its write runs after the answer
-- (`waitUntil`) and a failure (this migration not applied yet) is counted and alerted, never a failed relay.
--
-- Pseudonymous, never personal by name: no name, email, account id or user id is stored; the transaction hash is public
-- chain data that can be traced to an account (its signer is the relay account, a delegate's receiver the user's
-- implicit account). Journear's own link from the hash to a person (the directory) goes with the user's erasure; these
-- rows stay. Never pruned. Amounts in yoctoNEAR (decimal strings); no USD. Copied to the usage ledger
-- (`usage.near_relayed_txs`) by the cron once final.
--
-- D1 writes per relay kept low (the free tier's daily write limit is the whole service's): a WITHOUT ROWID table (its key
-- is the row) and two indexes, the cron's to-do list and the relay key's nonces. Most relays are final at once (the
-- relay's own figures, below) and written twice: the insert and the ledger copy's mark.
CREATE TABLE near_relay_billing (
  network            TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  tx_hash            TEXT NOT NULL CHECK (length(tx_hash) BETWEEN 32 AND 44),     -- base58
  org_id             TEXT NOT NULL,
  app_id             TEXT NOT NULL,
  environment        TEXT NOT NULL,
  kind               TEXT NOT NULL CHECK (kind IN ('delegate', 'activation')),
  -- The relay's answer when it was sent; the outcome: final from the relay's own complete figures (an `ok` relay), from
  -- a read at FINAL, `not_executed` at once for a relay that certainly never ran (refused before inclusion, dropped), or
  -- `unknown` after enough tries.
  relay_code         TEXT NOT NULL CHECK (length(relay_code) BETWEEN 1 AND 40),
  outcome            TEXT NOT NULL CHECK (outcome IN ('pending', 'executed', 'failed', 'not_executed', 'unknown')),
  -- The user's own action ran, but a later receipt (a callback) failed.
  had_failed_receipt INTEGER NOT NULL DEFAULT 0 CHECK (had_failed_receipt IN (0, 1)),
  figures_from       TEXT CHECK (figures_from IS NULL OR figures_from IN ('relay', 'final')),
  block_hash         TEXT CHECK (block_hash IS NULL OR length(block_hash) BETWEEN 32 AND 44),
  block_height       TEXT,
  block_time         INTEGER,                                                     -- ms
  gas_burnt          TEXT,
  tokens_burnt       TEXT,                                                        -- yoctoNEAR
  attached_yocto     TEXT NOT NULL,                                               -- NEAR the relay attached or sent for the user
  receiver           TEXT,                                                        -- the contract (a delegate's); NULL for an activation
  methods_json       TEXT NOT NULL CHECK (json_valid(methods_json)),              -- the delegate's method names; [] for an activation
  -- The relay key and its nonce (public chain data): the daily check compares the key's nonce on chain with these.
  relayer_pk         TEXT CHECK (relayer_pk IS NULL OR length(relayer_pk) BETWEEN 40 AND 100),
  relayer_nonce      INTEGER CHECK (relayer_nonce IS NULL OR relayer_nonce >= 0),
  created_at         INTEGER NOT NULL,
  final_at           INTEGER,
  mirrored_at        INTEGER,
  -- The cron's FINAL reads: how many, and when the next (doubling from a minute).
  tries              INTEGER NOT NULL DEFAULT 0 CHECK (tries >= 0),
  next_try_at        INTEGER NOT NULL,
  PRIMARY KEY (network, tx_hash),
  CHECK ((kind = 'activation') = (receiver IS NULL))
) WITHOUT ROWID;
-- The cron's to-do list: records not yet copied to the ledger (not final: due by next_try_at; final: to copy).
CREATE INDEX near_relay_billing_todo ON near_relay_billing (next_try_at) WHERE mirrored_at IS NULL;
-- The daily nonce check: the records of one relay key between two of its nonces.
CREATE INDEX near_relay_billing_nonce ON near_relay_billing (relayer_pk, relayer_nonce);

-- Neon compute on the free plan (D872; edited into this file in place before it was applied anywhere, as 0022 and 0023
-- were before): only with the `NEON_PLAN` var. One row per UTC month of the usage ledger's wake-ups as our Workers
-- noted them (the estimate of the month's compute-hours: packages/console-core/src/neon-compute.ts): the closed
-- windows' total, the open window, how many windows, the highest alert raised (0, 70, 90), and when counting began
-- (`first_at`: after the 1st in the month of the deploy that turned it on, so that month's figure is partial). One small
-- UPSERT per wake-up (a usage event's write, a cron run that opened the ledger, a staff page or console report that
-- did). No user data. Kept (one row a month).
CREATE TABLE neon_compute (
  month      TEXT PRIMARY KEY CHECK (length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
  first_at   INTEGER NOT NULL,
  closed_ms  INTEGER NOT NULL CHECK (closed_ms >= 0),
  win_start  INTEGER NOT NULL,
  win_end    INTEGER NOT NULL CHECK (win_end >= win_start),
  windows    INTEGER NOT NULL CHECK (windows >= 1),
  alerted    INTEGER NOT NULL DEFAULT 0 CHECK (alerted IN (0, 70, 90)),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
-- The admin Worker's runs as each last saw the ledger (D872): its records `cron.last_run` and `ledger_cron.last_run`
-- and `ledger.health` (reachable, partitions ahead, settlement backlog), handed over with the run's wake-up so the
-- System status page shows them without waking Neon. Counts and timestamps only.
CREATE TABLE neon_admin_runs (
  key        TEXT PRIMARY KEY CHECK (key IN ('cron.last_run', 'ledger_cron.last_run', 'ledger.health')),
  value_json TEXT NOT NULL CHECK (json_valid(value_json) AND length(value_json) <= 4096),
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;

-- `security_events` gains `near_billing_late` (NEAR relay billing records missed or parked, not final past the give-up
-- time, not copied to the usage ledger an hour on, or the relay key's nonces showing transactions without a record; once
-- a UTC day, with the counts) and `neon_compute_high` (D872: the month's Neon compute estimate reached 70% or 90% of
-- the free plan's allowance; once per threshold a month).
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late', 'evm_relay_closed_slot_mined', 'near_billing_late', 'neon_compute_high')),
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
