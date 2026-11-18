-- Usage ledger, the NEAR meta-transaction relay's billing records (D863): one permanent record per NEAR transaction the
-- relay sent for a user that reached the chain (a relayed delegate action or an account activation; success or
-- failure), copied by the API's cron from its D1 table `near_relay_billing` (hot-DB migration 0023) once the
-- transaction was read at FINAL, through `usage.record_near_relayed`. As EVM sponsorship's (0009, D852): idempotent on
-- (network, tx_hash); no personal data (no user account id, user id or IP; the transaction hash is public chain data);
-- not partitioned, and none of 0007's retention functions or `usage.erase_uid` touches it: never pruned, kept through a
-- user's erasure. Amounts in yoctoNEAR, no USD: a billing job can price them with `usage.near_usd_rates` (the daily
-- NEAR/USD rate the admin Worker already fetches, D325). Records exist only from the deploy of this code on.
--
-- Applied by the founder with scripts/usage-migrate.ts (never from a Worker).

CREATE TABLE usage.near_relayed_txs (
  network        text           NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  tx_hash        text           NOT NULL CHECK (tx_hash ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  org_id         text           NOT NULL,
  app_id         text           NOT NULL,
  environment    text           NOT NULL,
  kind           text           NOT NULL CHECK (kind IN ('delegate', 'activation')),
  relay_code     text           NOT NULL,
  outcome        text           NOT NULL CHECK (outcome IN ('executed', 'failed', 'unknown')),
  block_height   numeric(20, 0),
  block_time     timestamptz,
  gas_burnt      numeric(20, 0),
  tokens_burnt   numeric(39, 0),
  attached_yocto numeric(39, 0) NOT NULL CHECK (attached_yocto >= 0),
  receiver       text,
  methods        jsonb          NOT NULL CHECK (jsonb_typeof(methods) = 'array'),
  created_at     timestamptz    NOT NULL,
  final_at       timestamptz    NOT NULL,
  copied_at      timestamptz    NOT NULL DEFAULT now(),
  PRIMARY KEY (network, tx_hash),
  CHECK ((kind = 'activation') = (receiver IS NULL))
);
CREATE INDEX near_relayed_txs_org ON usage.near_relayed_txs (org_id, created_at);
CREATE INDEX near_relayed_txs_app ON usage.near_relayed_txs (app_id, created_at);

-- Rows: a JSON array of at most 500 final records (the D1 table's columns, times as ISO strings, `methods` an array of
-- method names). Validates every row before writing any (all or nothing), then inserts, ignoring any already held.
-- Returns how many were new.
CREATE FUNCTION usage.record_near_relayed(rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  r       jsonb;
  k       text;
  m       jsonb;
  n       integer;
  allowed constant text[] := ARRAY['network', 'tx_hash', 'org_id', 'app_id', 'environment', 'kind', 'relay_code', 'outcome', 'block_height',
    'block_time', 'gas_burnt', 'tokens_burnt_yocto', 'attached_yocto', 'receiver', 'methods', 'created_at', 'final_at'];
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN PERFORM usage.event_invalid('near rows: not an array'); END IF;
  IF jsonb_array_length(rows) > 500 THEN PERFORM usage.event_invalid('near rows: more than 500'); END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF jsonb_typeof(r) <> 'object' THEN PERFORM usage.event_invalid('near row: not an object'); END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT (k = ANY (allowed)) THEN PERFORM usage.event_invalid('near row: unknown field ' || k); END IF;
    END LOOP;
    IF (r ->> 'network') IS DISTINCT FROM 'testnet' AND (r ->> 'network') IS DISTINCT FROM 'mainnet' THEN PERFORM usage.event_invalid('near row: network'); END IF;
    IF jsonb_typeof(r -> 'tx_hash') IS DISTINCT FROM 'string' OR (r ->> 'tx_hash') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' THEN PERFORM usage.event_invalid('near row: tx_hash'); END IF;
    FOREACH k IN ARRAY ARRAY['org_id', 'app_id', 'environment', 'relay_code'] LOOP
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR length(r ->> k) NOT BETWEEN 1 AND 64 THEN PERFORM usage.event_invalid('near row: ' || k); END IF;
    END LOOP;
    IF NOT ((r ->> 'kind') = ANY (ARRAY['delegate', 'activation'])) OR jsonb_typeof(r -> 'kind') <> 'string' THEN PERFORM usage.event_invalid('near row: kind'); END IF;
    IF NOT ((r ->> 'outcome') = ANY (ARRAY['executed', 'failed', 'unknown'])) OR jsonb_typeof(r -> 'outcome') <> 'string' THEN PERFORM usage.event_invalid('near row: outcome'); END IF;
    IF NOT usage.evm_amount_ok(r -> 'block_height', 20, true) OR NOT usage.evm_amount_ok(r -> 'gas_burnt', 20, true) OR NOT usage.evm_amount_ok(r -> 'tokens_burnt_yocto', 39, true)
       OR NOT usage.evm_amount_ok(r -> 'attached_yocto', 39, false) THEN PERFORM usage.event_invalid('near row: an amount'); END IF;
    IF (r ->> 'kind') = 'activation' THEN
      IF jsonb_typeof(r -> 'receiver') IS DISTINCT FROM 'null' THEN PERFORM usage.event_invalid('near row: an activation names no receiver'); END IF;
    ELSIF jsonb_typeof(r -> 'receiver') IS DISTINCT FROM 'string' OR (r ->> 'receiver') !~ '^[a-z0-9._-]{2,64}$' THEN PERFORM usage.event_invalid('near row: receiver');
    END IF;
    IF jsonb_typeof(r -> 'methods') IS DISTINCT FROM 'array' OR jsonb_array_length(r -> 'methods') > 8 THEN PERFORM usage.event_invalid('near row: methods'); END IF;
    FOR m IN SELECT value FROM jsonb_array_elements(r -> 'methods') LOOP
      IF jsonb_typeof(m) <> 'string' OR (m #>> '{}') !~ '^[A-Za-z0-9_]+$' OR length(m #>> '{}') > 256 THEN PERFORM usage.event_invalid('near row: a method'); END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['created_at', 'final_at', 'block_time'] LOOP
      IF k = 'block_time' AND jsonb_typeof(r -> k) = 'null' THEN CONTINUE; END IF;
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR (r ->> k) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' THEN PERFORM usage.event_invalid('near row: ' || k); END IF;
    END LOOP;
  END LOOP;

  INSERT INTO usage.near_relayed_txs (network, tx_hash, org_id, app_id, environment, kind, relay_code, outcome, block_height, block_time, gas_burnt,
      tokens_burnt, attached_yocto, receiver, methods, created_at, final_at)
  SELECT x ->> 'network', x ->> 'tx_hash', x ->> 'org_id', x ->> 'app_id', x ->> 'environment', x ->> 'kind', x ->> 'relay_code', x ->> 'outcome',
         (x ->> 'block_height')::numeric, (x ->> 'block_time')::timestamptz, (x ->> 'gas_burnt')::numeric, (x ->> 'tokens_burnt_yocto')::numeric,
         (x ->> 'attached_yocto')::numeric, x ->> 'receiver', x -> 'methods', (x ->> 'created_at')::timestamptz, (x ->> 'final_at')::timestamptz
    FROM jsonb_array_elements(rows) AS x
  ON CONFLICT (network, tx_hash) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- Per org, app, network, UTC month, kind and outcome: the count and the yoctoNEAR sums (staff only).
CREATE VIEW usage.near_relayed_monthly AS
  SELECT org_id, app_id, network, date_trunc('month', created_at)::date AS month, kind, outcome,
         count(*) AS transactions, sum(tokens_burnt) AS tokens_burnt_yocto, sum(attached_yocto) AS attached_yocto,
         sum(gas_burnt) AS gas_burnt
    FROM usage.near_relayed_txs
   GROUP BY org_id, app_id, network, date_trunc('month', created_at)::date, kind, outcome;

REVOKE EXECUTE ON FUNCTION usage.record_near_relayed(jsonb) FROM PUBLIC;
REVOKE ALL ON usage.near_relayed_txs, usage.near_relayed_monthly FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.record_near_relayed(jsonb) TO usage_writer;
GRANT SELECT ON usage.near_relayed_txs, usage.near_relayed_monthly TO usage_admin;
