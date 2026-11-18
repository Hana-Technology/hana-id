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
-- No personal data: no user account id, user id or IP. The transaction hash is public chain data: on NEAR it names the
-- transaction, whose signer is the relay account and whose receiver (for a delegate) is the user's implicit account, so
-- the hash leads anyone to that public account on the chain, as an EVM hash does. Journear's own link from the hash to
-- a person (the directory) goes with the user's erasure; these rows stay. Never pruned. Amounts in yoctoNEAR (decimal
-- strings); no USD. Copied to the usage ledger (`usage.near_relayed_txs`) by the cron once final.
CREATE TABLE near_relay_billing (
  network        TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  tx_hash        TEXT NOT NULL CHECK (length(tx_hash) BETWEEN 32 AND 44),     -- base58
  org_id         TEXT NOT NULL,
  app_id         TEXT NOT NULL,
  environment    TEXT NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('delegate', 'activation')),
  -- The relay's answer when it was sent (provisional), then the transaction's status at FINAL.
  relay_code     TEXT NOT NULL CHECK (length(relay_code) BETWEEN 1 AND 40),
  outcome        TEXT NOT NULL CHECK (outcome IN ('pending', 'executed', 'failed', 'unknown')),
  block_height   TEXT,
  block_time     INTEGER,                                                     -- ms
  gas_burnt      TEXT,
  tokens_burnt   TEXT,                                                        -- yoctoNEAR
  attached_yocto TEXT NOT NULL,                                               -- NEAR the relay attached or sent for the user
  receiver       TEXT,                                                        -- the contract (a delegate's); NULL for an activation
  methods_json   TEXT NOT NULL CHECK (json_valid(methods_json)),              -- the delegate's method names; [] for an activation
  created_at     INTEGER NOT NULL,
  final_at       INTEGER,                                                     -- figures re-read at FINAL (or given up: outcome unknown)
  mirrored_at    INTEGER,
  PRIMARY KEY (network, tx_hash),
  CHECK ((kind = 'activation') = (receiver IS NULL))
);
CREATE INDEX near_relay_billing_org ON near_relay_billing (org_id, created_at);
CREATE INDEX near_relay_billing_app ON near_relay_billing (app_id, created_at);
CREATE INDEX near_relay_billing_open ON near_relay_billing (created_at) WHERE final_at IS NULL;
CREATE INDEX near_relay_billing_unmirrored ON near_relay_billing (created_at) WHERE mirrored_at IS NULL AND final_at IS NOT NULL;

-- `security_events` gains `near_billing_late` (a NEAR relay billing record couldn't be written, isn't final or isn't
-- copied to the usage ledger an hour on; once an hour).
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late', 'near_billing_late')),
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
