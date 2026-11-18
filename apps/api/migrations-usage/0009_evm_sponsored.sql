-- Usage ledger, EVM gas sponsorship (D852): one permanent record per sponsored transaction Journear paid for, for a
-- future billing of partners (how to bill is not decided yet). The API's D1 table `evm_sponsor_billing` (hot-DB
-- migration 0022) is written at settlement; the API's cron copies its records here through
-- `usage.record_evm_sponsored`, retrying until they land, so nothing is lost while this database is unreachable.
--
-- One row per transaction that reached the chain (the batch: executed, reverted or run without effect; or the
-- relayer's deadline self-transfer: cancelled; `mined` when only its cost is known), plus one per charge with no mined
-- transaction of its own (`lost`, `consumed_elsewhere`: the kept reservation is the amount), so the books add up.
-- Idempotent on (chain_id, record_key): the key is the transaction hash, or 'send:<id>' for a charge without one.
--
-- No personal data: no account address, user id, uid or IP. The transaction hash is public chain data. Not partitioned,
-- and none of 0007's retention functions or `usage.erase_uid` touches this table: these rows are never pruned and stay
-- through a user's erasure (they are the business's record of what it paid). Amounts in wei, no USD: a billing job will
-- need a daily ETH/USD rate like `usage.near_usd_rates` and a rule for what to charge.
--
-- Applied by the founder with scripts/usage-migrate.ts (never from a Worker).

CREATE TABLE usage.evm_sponsored_txs (
  chain_id                integer        NOT NULL CHECK (chain_id > 0),
  record_key              text           NOT NULL CHECK (length(record_key) BETWEEN 1 AND 80),
  org_id                  text           NOT NULL,
  app_id                  text           NOT NULL,
  environment             text           NOT NULL,
  tx_hash                 text CHECK (tx_hash IS NULL OR tx_hash ~ '^0x[0-9a-f]{64}$'),
  block_number            numeric(20, 0),
  block_time              timestamptz,
  outcome                 text           NOT NULL CHECK (outcome IN ('executed', 'reverted', 'not_executed', 'cancelled', 'mined', 'lost', 'consumed_elsewhere')),
  gas_used                numeric(20, 0),
  effective_gas_price_wei numeric(78, 0),
  execution_wei           numeric(78, 0),
  l1_fee_wei              numeric(78, 0),
  operator_fee_wei        numeric(78, 0),
  total_cost_wei          numeric(78, 0),
  settled_wei             numeric(78, 0) NOT NULL CHECK (settled_wei >= 0),
  call_count              smallint       NOT NULL CHECK (call_count BETWEEN 1 AND 8),
  targets                 jsonb          NOT NULL CHECK (jsonb_typeof(targets) = 'array'),
  with_setup              boolean        NOT NULL,
  created_at              timestamptz    NOT NULL,
  settled_at              timestamptz    NOT NULL,
  copied_at               timestamptz    NOT NULL DEFAULT now(),
  -- A correction (D847: a reorg the relayer's verdict at confirmed depth showed) names the record it supersedes.
  corrects                text           CHECK (corrects IS NULL OR length(corrects) BETWEEN 1 AND 80),
  PRIMARY KEY (chain_id, record_key),
  CHECK ((tx_hash IS NOT NULL AND corrects IS NULL AND record_key = tx_hash) OR (tx_hash IS NOT NULL AND corrects IS NOT NULL AND record_key LIKE 'fix:%')
         OR (tx_hash IS NULL AND corrects IS NULL AND outcome IN ('lost', 'consumed_elsewhere') AND record_key LIKE 'send:%')
         OR (tx_hash IS NULL AND corrects IS NOT NULL AND outcome = 'consumed_elsewhere' AND record_key LIKE 'fix:%'))
);
CREATE INDEX evm_sponsored_txs_org ON usage.evm_sponsored_txs (org_id, settled_at);
CREATE INDEX evm_sponsored_txs_app ON usage.evm_sponsored_txs (app_id, settled_at);

-- A non-negative decimal string of at most `digits` digits, or JSON null when `nullable`.
CREATE FUNCTION usage.evm_amount_ok(v jsonb, digits integer, nullable boolean) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN v IS NULL OR jsonb_typeof(v) = 'null' THEN nullable
              WHEN jsonb_typeof(v) = 'string' THEN (v #>> '{}') ~ ('^(0|[1-9][0-9]{0,' || (digits - 1) || '})$')
              ELSE false END
$$;

-- Rows: a JSON array of at most 500 records (the D1 table's columns, times as ISO strings, `targets` an array of
-- {address, selector}). Validates every row before writing any (all or nothing), then inserts, ignoring any already
-- held. Returns how many were new.
CREATE FUNCTION usage.record_evm_sponsored(rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  r       jsonb;
  k       text;
  t       jsonb;
  n       integer;
  allowed constant text[] := ARRAY['chain_id', 'record_key', 'org_id', 'app_id', 'environment', 'tx_hash', 'block_number', 'block_time',
    'outcome', 'gas_used', 'effective_gas_price_wei', 'execution_wei', 'l1_fee_wei', 'operator_fee_wei', 'total_cost_wei', 'settled_wei',
    'call_count', 'targets', 'with_setup', 'created_at', 'settled_at', 'corrects'];
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN PERFORM usage.event_invalid('evm rows: not an array'); END IF;
  IF jsonb_array_length(rows) > 500 THEN PERFORM usage.event_invalid('evm rows: more than 500'); END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF jsonb_typeof(r) <> 'object' THEN PERFORM usage.event_invalid('evm row: not an object'); END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT (k = ANY (allowed)) THEN PERFORM usage.event_invalid('evm row: unknown field ' || k); END IF;
    END LOOP;
    IF jsonb_typeof(r -> 'chain_id') IS DISTINCT FROM 'number' OR (r ->> 'chain_id') !~ '^[1-9][0-9]{0,8}$' THEN PERFORM usage.event_invalid('evm row: chain_id'); END IF;
    FOREACH k IN ARRAY ARRAY['record_key', 'org_id', 'app_id', 'environment'] LOOP
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR length(r ->> k) NOT BETWEEN 1 AND 80 THEN PERFORM usage.event_invalid('evm row: ' || k); END IF;
    END LOOP;
    IF NOT (jsonb_typeof(r -> 'tx_hash') = 'null' OR (jsonb_typeof(r -> 'tx_hash') = 'string' AND (r ->> 'tx_hash') ~ '^0x[0-9a-f]{64}$')) THEN PERFORM usage.event_invalid('evm row: tx_hash'); END IF;
    IF jsonb_typeof(r -> 'outcome') IS DISTINCT FROM 'string' OR NOT ((r ->> 'outcome') = ANY (ARRAY['executed', 'reverted', 'not_executed', 'cancelled', 'mined', 'lost', 'consumed_elsewhere'])) THEN PERFORM usage.event_invalid('evm row: outcome'); END IF;
    IF NOT usage.evm_amount_ok(r -> 'block_number', 20, true) OR NOT usage.evm_amount_ok(r -> 'gas_used', 20, true) THEN PERFORM usage.event_invalid('evm row: block or gas'); END IF;
    FOREACH k IN ARRAY ARRAY['effective_gas_price_wei', 'execution_wei', 'l1_fee_wei', 'operator_fee_wei', 'total_cost_wei'] LOOP
      IF NOT usage.evm_amount_ok(r -> k, 78, true) THEN PERFORM usage.event_invalid('evm row: ' || k); END IF;
    END LOOP;
    IF NOT usage.evm_amount_ok(r -> 'settled_wei', 78, false) THEN PERFORM usage.event_invalid('evm row: settled_wei'); END IF;
    IF jsonb_typeof(r -> 'call_count') IS DISTINCT FROM 'number' OR (r ->> 'call_count') !~ '^[1-8]$' THEN PERFORM usage.event_invalid('evm row: call_count'); END IF;
    IF jsonb_typeof(r -> 'targets') IS DISTINCT FROM 'array' OR jsonb_array_length(r -> 'targets') > 8 THEN PERFORM usage.event_invalid('evm row: targets'); END IF;
    FOR t IN SELECT value FROM jsonb_array_elements(r -> 'targets') LOOP
      IF jsonb_typeof(t) <> 'object' OR (SELECT count(*) FROM jsonb_object_keys(t)) <> 2
         OR (t ->> 'address') !~ '^0x[0-9a-f]{40}$' OR (t ->> 'selector') !~ '^0x[0-9a-f]{8}$' THEN PERFORM usage.event_invalid('evm row: a target'); END IF;
    END LOOP;
    IF jsonb_typeof(r -> 'with_setup') IS DISTINCT FROM 'boolean' THEN PERFORM usage.event_invalid('evm row: with_setup'); END IF;
    IF NOT (r ? 'corrects') OR jsonb_typeof(r -> 'corrects') = 'null' THEN NULL;
    ELSIF jsonb_typeof(r -> 'corrects') <> 'string' OR length(r ->> 'corrects') NOT BETWEEN 1 AND 80 OR (r ->> 'record_key') NOT LIKE 'fix:%' THEN PERFORM usage.event_invalid('evm row: corrects');
    END IF;
    FOREACH k IN ARRAY ARRAY['created_at', 'settled_at', 'block_time'] LOOP
      IF k = 'block_time' AND jsonb_typeof(r -> k) = 'null' THEN CONTINUE; END IF;
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR (r ->> k) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' THEN PERFORM usage.event_invalid('evm row: ' || k); END IF;
    END LOOP;
  END LOOP;

  INSERT INTO usage.evm_sponsored_txs (chain_id, record_key, org_id, app_id, environment, tx_hash, block_number, block_time, outcome, gas_used,
      effective_gas_price_wei, execution_wei, l1_fee_wei, operator_fee_wei, total_cost_wei, settled_wei, call_count, targets, with_setup,
      created_at, settled_at, corrects)
  SELECT (x ->> 'chain_id')::integer, x ->> 'record_key', x ->> 'org_id', x ->> 'app_id', x ->> 'environment', x ->> 'tx_hash',
         (x ->> 'block_number')::numeric, (x ->> 'block_time')::timestamptz, x ->> 'outcome', (x ->> 'gas_used')::numeric,
         (x ->> 'effective_gas_price_wei')::numeric, (x ->> 'execution_wei')::numeric, (x ->> 'l1_fee_wei')::numeric,
         (x ->> 'operator_fee_wei')::numeric, (x ->> 'total_cost_wei')::numeric, (x ->> 'settled_wei')::numeric,
         (x ->> 'call_count')::smallint, x -> 'targets', (x ->> 'with_setup')::boolean, (x ->> 'created_at')::timestamptz,
         (x ->> 'settled_at')::timestamptz, x ->> 'corrects'
    FROM jsonb_array_elements(rows) AS x
  ON CONFLICT (chain_id, record_key) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Per org, app, chain, UTC month and outcome: the sums a statement or a billing job starts from (staff only).
CREATE VIEW usage.evm_sponsored_monthly AS
  SELECT org_id, app_id, chain_id, date_trunc('month', settled_at)::date AS month, outcome,
         count(*) AS transactions, sum(settled_wei) AS settled_wei, sum(total_cost_wei) AS total_cost_wei,
         sum(l1_fee_wei) AS l1_fee_wei, sum(operator_fee_wei) AS operator_fee_wei
    FROM usage.evm_sponsored_txs t
   -- A record a correction superseded counts no more: the correction carries the send's final figures.
   WHERE NOT EXISTS (SELECT 1 FROM usage.evm_sponsored_txs c WHERE c.chain_id = t.chain_id AND c.corrects = t.record_key)
   GROUP BY org_id, app_id, chain_id, date_trunc('month', settled_at)::date, outcome;

REVOKE EXECUTE ON FUNCTION usage.record_evm_sponsored(jsonb), usage.evm_amount_ok(jsonb, integer, boolean) FROM PUBLIC;
REVOKE ALL ON usage.evm_sponsored_txs, usage.evm_sponsored_monthly FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.record_evm_sponsored(jsonb) TO usage_writer;
GRANT SELECT ON usage.evm_sponsored_txs, usage.evm_sponsored_monthly TO usage_admin;
