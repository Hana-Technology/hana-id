-- Usage and billing ledger (D73: Neon Postgres in Sydney, reached through Hyperdrive), docs/batch-c-spec.md
-- "Usage ledger". Applied by scripts/usage-migrate.ts as the project's owner role over a direct connection, never from
-- a Worker; one transaction per file. Least privilege is by role: the API's `usage_writer` can only call
-- `usage.record_event`; nothing but the owner can update or delete ledger rows. This file holds no credential: the
-- roles are created NOLOGIN and scripts/usage-setup.ts (batch C4) gives each LOGIN and a generated password.
--
-- Later files add the report and ledger functions (0002, batch C12) and the retention functions (0003, batch C13),
-- each with its grants and `REVOKE EXECUTE … FROM PUBLIC`.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usage_writer') THEN
    CREATE ROLE usage_writer NOLOGIN;   -- the API's Hyperdrive config
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'usage_admin') THEN
    CREATE ROLE usage_admin NOLOGIN;    -- the admin Worker's Hyperdrive config, scripts/uid-erase.ts
  END IF;
END
$$;

CREATE SCHEMA usage;                    -- the ledger and billing tables
CREATE SCHEMA ops;                      -- admin Worker state: cursors, watcher snapshots, nonce checks, runs
REVOKE ALL ON SCHEMA usage, ops FROM PUBLIC;

-- ---- the ledger ----

CREATE TABLE usage.events (             -- insert-only
  request_id         text        NOT NULL,      -- the API's requestId: the idempotency key
  at                 timestamptz NOT NULL,      -- request start; sets the UTC day and the partition
  received_at        timestamptz NOT NULL DEFAULT now(),
  org_id             text        NOT NULL,      -- the scope's org when the event was produced (from the gate row)
  app_id             text,                      -- NULL only for owner actions
  scope_id           text        NOT NULL,
  endpoint           text        NOT NULL CHECK (endpoint IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action')),
  outcome            text        NOT NULL CHECK (outcome IN ('ok', 'rejected', 'error')),
  code               text,
  status             smallint    NOT NULL,
  latency_ms         integer     NOT NULL CHECK (latency_ms >= 0),
  relayed            boolean     NOT NULL,      -- a transaction that can execute was sent (gas may be burnt)
  near_tx            text,
  relayer_pk         text,                      -- 'ed25519:…' of the pool key that signed it
  relayer_nonce      bigint,
  relay_gas_burnt    bigint,                    -- provisional (EXECUTED_OPTIMISTIC); never billed
  relay_tokens_burnt numeric(39, 0),
  uid                bytea CHECK (uid IS NULL OR octet_length(uid) = 16),
  PRIMARY KEY (request_id, at),
  CHECK (NOT relayed OR (near_tx IS NOT NULL AND relayer_pk IS NOT NULL AND relayer_nonce IS NOT NULL)),
  CHECK ((endpoint = 'owner_action') = (app_id IS NULL)),
  CHECK (uid IS NULL OR (outcome = 'ok' AND endpoint IN ('login', 'session', 'derive')))
) PARTITION BY RANGE (at);              -- one partition per UTC month: usage.events_2026_11 …; no default partition
CREATE INDEX events_org_at ON usage.events (org_id, at);
CREATE INDEX events_app_at ON usage.events (app_id, at);
CREATE INDEX events_owner_scope_at ON usage.events (scope_id, at) WHERE endpoint = 'owner_action';
CREATE INDEX events_relayed_at ON usage.events (at) WHERE relayed;                          -- settlement queue
CREATE INDEX events_relayer_nonce ON usage.events (relayer_pk, relayer_nonce) WHERE relayed; -- nonce cross-check

CREATE TABLE usage.app_users (          -- first and last day per pseudonymous user: new-user counts
  app_id     text  NOT NULL,
  uid        bytea NOT NULL CHECK (octet_length(uid) = 16),
  first_seen date  NOT NULL,
  last_seen  date  NOT NULL,
  PRIMARY KEY (app_id, uid),
  CHECK (first_seen <= last_seen)
);
CREATE INDEX app_users_first_seen ON usage.app_users (app_id, first_seen);

CREATE TABLE usage.gas_settlements (    -- admin: billed gas of every relayed event, from the tx at FINAL
  request_id   text        PRIMARY KEY,
  at           timestamptz NOT NULL,
  near_tx      text        NOT NULL,
  result       text        NOT NULL CHECK (result IN ('final', 'unsettled')),
  gas_burnt    bigint,                  -- BigInt sums over the tx and every receipt
  tokens_burnt numeric(39, 0),
  settled_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((result = 'final') = (gas_burnt IS NOT NULL AND tokens_burnt IS NOT NULL)),
  CHECK (gas_burnt IS NULL OR gas_burnt >= 0),
  CHECK (tokens_burnt IS NULL OR tokens_burnt >= 0)
);
CREATE INDEX gas_settlements_at ON usage.gas_settlements (at);

CREATE TABLE usage.near_usd_rates (
  day        date        PRIMARY KEY,
  usd_micros bigint      NOT NULL CHECK (usd_micros > 0),
  source     text        NOT NULL,
  entered_by text,                      -- NULL = fetched; a staff id for the audited manual override
  fetched_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE usage.statements (         -- frozen once per org and month
  org_id     text        NOT NULL,
  month      date        NOT NULL CHECK (EXTRACT(DAY FROM month) = 1),
  as_of      timestamptz NOT NULL,      -- the statement covers events with received_at <= as_of
  csv_key    text        NOT NULL,
  csv_sha256 bytea       NOT NULL CHECK (octet_length(csv_sha256) = 32),
  pdf_key    text,
  pdf_sha256 bytea CHECK (pdf_sha256 IS NULL OR octet_length(pdf_sha256) = 32),
  totals     jsonb       NOT NULL,      -- the total rows, for the report screens
  issued_by  text        NOT NULL,
  issued_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month),
  CHECK ((pdf_key IS NULL) = (pdf_sha256 IS NULL))
);

-- ---- admin Worker state ----

CREATE TABLE ops.state (key text PRIMARY KEY, value text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE ops.scope_snapshot (
  scope_id     text PRIMARY KEY,
  owners       jsonb NOT NULL,
  clients      jsonb NOT NULL,
  allow_shared boolean NOT NULL,
  seen_at      timestamptz NOT NULL
);
CREATE TABLE ops.scope_watch (
  scope_id      text NOT NULL,
  change_id     bigint NOT NULL,
  first_seen_at timestamptz NOT NULL,
  notified_at   timestamptz,
  PRIMARY KEY (scope_id, change_id)
);
CREATE TABLE ops.nonce_checks (
  relayer_pk               text NOT NULL,
  checked_at               timestamptz NOT NULL,
  chain_nonce              bigint NOT NULL,
  explained                boolean NOT NULL,
  ledger_relayed_since_last bigint NOT NULL,
  alerted_at               timestamptz,
  PRIMARY KEY (relayer_pk, checked_at)
);
CREATE TABLE ops.retention_runs (       -- D90, shown in the admin console
  id          bigserial PRIMARY KEY,
  started_at  timestamptz NOT NULL,
  finished_at timestamptz,
  rows        jsonb NOT NULL DEFAULT '{}',
  error       text
);
CREATE TABLE ops.rejection_alerts (     -- D91
  org_id     text NOT NULL,
  day        date NOT NULL,
  relayed    bigint NOT NULL,
  rejected   bigint NOT NULL,
  alerted_at timestamptz,
  PRIMARY KEY (org_id, day)
);

-- ---- defence behind the grants: frozen statements and their rates ----

CREATE FUNCTION usage.statements_frozen() RETURNS trigger
LANGUAGE plpgsql SET search_path = usage, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'usage.% rows are frozen (D92); retention removes them by hand after review', TG_TABLE_NAME USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER statements_frozen BEFORE UPDATE OR DELETE ON usage.statements
  FOR EACH ROW EXECUTE FUNCTION usage.statements_frozen();
CREATE TRIGGER statements_no_truncate BEFORE TRUNCATE ON usage.statements
  FOR EACH STATEMENT EXECUTE FUNCTION usage.statements_frozen();

-- A rate can't be added, changed or removed for a month that has a statement (in either the old or the new day).
CREATE FUNCTION usage.rates_frozen() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp AS $$
DECLARE
  d date;
BEGIN
  FOREACH d IN ARRAY CASE TG_OP WHEN 'INSERT' THEN ARRAY[NEW.day] WHEN 'DELETE' THEN ARRAY[OLD.day] ELSE ARRAY[OLD.day, NEW.day] END LOOP
    IF EXISTS (SELECT 1 FROM usage.statements s WHERE s.month = date_trunc('month', d::timestamp)::date) THEN
      RAISE EXCEPTION 'The NEAR/USD rate of % is frozen: a statement exists for that month', d USING ERRCODE = '42501';
    END IF;
  END LOOP;
  RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
END
$$;
CREATE TRIGGER rates_frozen BEFORE INSERT OR UPDATE OR DELETE ON usage.near_usd_rates
  FOR EACH ROW EXECUTE FUNCTION usage.rates_frozen();
CREATE TRIGGER rates_no_truncate BEFORE TRUNCATE ON usage.near_usd_rates
  FOR EACH STATEMENT EXECUTE FUNCTION usage.statements_frozen();

-- ---- partitions ----

-- Creates the monthly partitions of usage.events from the current UTC month to `months_ahead` months ahead (the
-- admin's daily cron calls it with 3). Returns how many it created.
CREATE FUNCTION usage.ensure_partitions(months_ahead integer DEFAULT 3) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  first_month date := date_trunc('month', now() AT TIME ZONE 'UTC')::date;
  m date;
  part text;
  created integer := 0;
BEGIN
  IF months_ahead IS NULL OR months_ahead < 0 OR months_ahead > 24 THEN
    RAISE EXCEPTION 'months_ahead must be 0..24' USING ERRCODE = '22023';
  END IF;
  FOR i IN 0..months_ahead LOOP
    m := (first_month + make_interval(months => i))::date;
    part := format('events_%s', to_char(m, 'YYYY_MM'));
    IF to_regclass(format('usage.%I', part)) IS NULL THEN
      EXECUTE format('CREATE TABLE usage.%I PARTITION OF usage.events FOR VALUES FROM (%L) TO (%L)',
        part, m::timestamp AT TIME ZONE 'UTC', (m + interval '1 month')::timestamp AT TIME ZONE 'UTC');
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END
$$;

-- ---- record_event (UsageEvent v1, packages/console-core/src/usage-event.ts) ----

CREATE FUNCTION usage.event_invalid(why text) RETURNS void
LANGUAGE plpgsql SET search_path = usage, pg_temp AS $$
BEGIN
  RAISE EXCEPTION 'usage_event_invalid: %', why USING ERRCODE = '22023';
END
$$;

-- Validates the shape (fields, types, ranges, the cross-field rules), inserts the event once (a retry with the same
-- request_id and at is ignored), and for an event with a uid records the user's first and last day, in one
-- transaction. Returns true when the event was new. An event outside every partition fails (no default partition).
CREATE FUNCTION usage.record_event(e jsonb) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  allowed  constant text[] := ARRAY['v', 'request_id', 'at_ms', 'org_id', 'app_id', 'scope_id', 'endpoint', 'outcome', 'code',
    'status', 'latency_ms', 'relayed', 'near_tx', 'relayer_pk', 'relayer_nonce', 'relay_gas_burnt', 'relay_tokens_burnt_yocto', 'uid'];
  required constant text[] := ARRAY['v', 'request_id', 'at_ms', 'org_id', 'app_id', 'scope_id', 'endpoint', 'outcome', 'code',
    'status', 'latency_ms', 'relayed'];
  k        text;
  ev_at    timestamptz;
  ev_uid   bytea;
  ev_app   text;
  ev_code  text;
  n        integer;
BEGIN
  IF e IS NULL OR jsonb_typeof(e) <> 'object' THEN PERFORM usage.event_invalid('not an object'); END IF;
  FOR k IN SELECT jsonb_object_keys(e) LOOP
    IF NOT (k = ANY (allowed)) THEN PERFORM usage.event_invalid('unknown field ' || k); END IF;
  END LOOP;
  FOREACH k IN ARRAY required LOOP
    IF NOT (e ? k) THEN PERFORM usage.event_invalid('missing ' || k); END IF;
  END LOOP;

  IF e -> 'v' IS DISTINCT FROM '1'::jsonb THEN PERFORM usage.event_invalid('v'); END IF;
  IF jsonb_typeof(e -> 'request_id') <> 'string' OR (e ->> 'request_id') !~ '^[A-Za-z0-9_-]{8,128}$' THEN PERFORM usage.event_invalid('request_id'); END IF;
  -- CASE, not OR: Postgres doesn't promise to skip the cast when the pattern already failed.
  IF (CASE WHEN jsonb_typeof(e -> 'at_ms') <> 'number' OR (e ->> 'at_ms') !~ '^(0|[1-9][0-9]{0,15})$' THEN true
          ELSE (e ->> 'at_ms')::bigint > 8640000000000000 END) THEN PERFORM usage.event_invalid('at_ms'); END IF;
  FOREACH k IN ARRAY ARRAY['org_id', 'scope_id'] LOOP
    IF jsonb_typeof(e -> k) <> 'string' OR length(e ->> k) NOT BETWEEN 1 AND 64 THEN PERFORM usage.event_invalid(k); END IF;
  END LOOP;
  IF jsonb_typeof(e -> 'app_id') = 'null' THEN
    ev_app := NULL;
  ELSIF jsonb_typeof(e -> 'app_id') = 'string' AND length(e ->> 'app_id') BETWEEN 1 AND 64 THEN
    ev_app := e ->> 'app_id';
  ELSE
    PERFORM usage.event_invalid('app_id');
  END IF;
  IF jsonb_typeof(e -> 'endpoint') <> 'string' OR (e ->> 'endpoint') NOT IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action') THEN PERFORM usage.event_invalid('endpoint'); END IF;
  IF jsonb_typeof(e -> 'outcome') <> 'string' OR (e ->> 'outcome') NOT IN ('ok', 'rejected', 'error') THEN PERFORM usage.event_invalid('outcome'); END IF;
  IF jsonb_typeof(e -> 'code') = 'null' THEN
    ev_code := NULL;
  ELSIF jsonb_typeof(e -> 'code') = 'string' AND (e ->> 'code') ~ '^[a-z][a-z0-9_]{0,63}$' THEN
    ev_code := e ->> 'code';
  ELSE
    PERFORM usage.event_invalid('code');
  END IF;
  IF jsonb_typeof(e -> 'status') <> 'number' OR (e ->> 'status') !~ '^[1-5][0-9]{2}$' THEN PERFORM usage.event_invalid('status'); END IF;
  IF (CASE WHEN jsonb_typeof(e -> 'latency_ms') <> 'number' OR (e ->> 'latency_ms') !~ '^(0|[1-9][0-9]{0,9})$' THEN true
          ELSE (e ->> 'latency_ms')::bigint > 2147483647 END) THEN PERFORM usage.event_invalid('latency_ms'); END IF;
  IF jsonb_typeof(e -> 'relayed') <> 'boolean' THEN PERFORM usage.event_invalid('relayed'); END IF;

  IF e ? 'near_tx' AND (jsonb_typeof(e -> 'near_tx') <> 'string' OR (e ->> 'near_tx') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN PERFORM usage.event_invalid('near_tx'); END IF;
  IF e ? 'relayer_pk' AND (jsonb_typeof(e -> 'relayer_pk') <> 'string' OR (e ->> 'relayer_pk') !~ '^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$') THEN PERFORM usage.event_invalid('relayer_pk'); END IF;
  FOREACH k IN ARRAY ARRAY['relayer_nonce', 'relay_gas_burnt'] LOOP
    IF e ? k AND (CASE WHEN jsonb_typeof(e -> k) <> 'string' OR (e ->> k) !~ '^(0|[1-9][0-9]{0,18})$' THEN true
                      ELSE (e ->> k)::numeric > 9223372036854775807 END) THEN PERFORM usage.event_invalid(k); END IF;
  END LOOP;
  IF e ? 'relay_tokens_burnt_yocto' AND (jsonb_typeof(e -> 'relay_tokens_burnt_yocto') <> 'string' OR (e ->> 'relay_tokens_burnt_yocto') !~ '^(0|[1-9][0-9]{0,38})$') THEN PERFORM usage.event_invalid('relay_tokens_burnt_yocto'); END IF;
  IF e ? 'uid' THEN
    IF jsonb_typeof(e -> 'uid') <> 'string' OR (e ->> 'uid') !~ '^[A-Za-z0-9_-]{21}[AQgw]$' THEN PERFORM usage.event_invalid('uid'); END IF;
    ev_uid := decode(translate(e ->> 'uid', '-_', '+/') || '==', 'base64');
  END IF;

  -- The cross-field rules (the table CHECKs repeat the first three).
  IF (e -> 'relayed')::boolean AND NOT (e ? 'near_tx' AND e ? 'relayer_pk' AND e ? 'relayer_nonce') THEN PERFORM usage.event_invalid('a relayed event names near_tx, relayer_pk and relayer_nonce'); END IF;
  IF ((e ->> 'endpoint') = 'owner_action') <> (ev_app IS NULL) THEN PERFORM usage.event_invalid('app_id is null exactly for owner actions'); END IF;
  IF ev_uid IS NOT NULL AND NOT ((e ->> 'outcome') = 'ok' AND (e ->> 'endpoint') IN ('login', 'session', 'derive')) THEN PERFORM usage.event_invalid('only ok login, session and derive events carry a uid'); END IF;
  IF ((e ->> 'outcome') = 'ok') <> (ev_code IS NULL) THEN PERFORM usage.event_invalid('code is null exactly for ok outcomes'); END IF;

  -- Exact to the millisecond (no float): whole seconds, then the remaining milliseconds.
  ev_at := timestamptz 'epoch' + ((e ->> 'at_ms')::bigint / 1000) * interval '1 second' + ((e ->> 'at_ms')::bigint % 1000) * interval '1 millisecond';
  INSERT INTO usage.events (request_id, at, org_id, app_id, scope_id, endpoint, outcome, code, status, latency_ms, relayed,
                            near_tx, relayer_pk, relayer_nonce, relay_gas_burnt, relay_tokens_burnt, uid)
  VALUES (e ->> 'request_id', ev_at, e ->> 'org_id', ev_app, e ->> 'scope_id', e ->> 'endpoint', e ->> 'outcome', ev_code,
          (e ->> 'status')::smallint, (e ->> 'latency_ms')::integer, (e -> 'relayed')::boolean,
          e ->> 'near_tx', e ->> 'relayer_pk', (e ->> 'relayer_nonce')::bigint, (e ->> 'relay_gas_burnt')::bigint,
          (e ->> 'relay_tokens_burnt_yocto')::numeric, ev_uid)
  ON CONFLICT (request_id, at) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;

  IF ev_uid IS NOT NULL THEN
    INSERT INTO usage.app_users AS u (app_id, uid, first_seen, last_seen)
    VALUES (ev_app, ev_uid, (ev_at AT TIME ZONE 'UTC')::date, (ev_at AT TIME ZONE 'UTC')::date)
    ON CONFLICT (app_id, uid) DO UPDATE
      SET first_seen = LEAST(u.first_seen, EXCLUDED.first_seen), last_seen = GREATEST(u.last_seen, EXCLUDED.last_seen);
  END IF;
  RETURN n = 1;
END
$$;

-- ---- privileges ----

-- Postgres lets PUBLIC execute every new function; nothing here is for PUBLIC.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA usage, ops FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA usage, ops FROM PUBLIC;

GRANT USAGE ON SCHEMA usage TO usage_writer, usage_admin;
GRANT EXECUTE ON FUNCTION usage.record_event(jsonb) TO usage_writer;

GRANT SELECT ON ALL TABLES IN SCHEMA usage TO usage_admin;
GRANT INSERT ON usage.gas_settlements, usage.near_usd_rates, usage.statements TO usage_admin;
GRANT UPDATE (usd_micros, source, entered_by, fetched_at) ON usage.near_usd_rates TO usage_admin;
GRANT EXECUTE ON FUNCTION usage.ensure_partitions(integer) TO usage_admin;

GRANT USAGE ON SCHEMA ops TO usage_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ops TO usage_admin;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA ops TO usage_admin;

ALTER ROLE usage_writer SET statement_timeout = '5s';
ALTER ROLE usage_admin SET statement_timeout = '60s';

-- The current month and the next 3.
SELECT usage.ensure_partitions(3);
