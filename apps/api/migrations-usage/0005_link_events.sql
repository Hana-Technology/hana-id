-- Usage ledger, email login batch 6 review (H1): the link relays are usage events. `POST /v1/link`, `/v1/link/cancel`
-- and `/v1/link/unlink` relay through the session pool and burn its gas, so each request past their gate is one event
-- with endpoint `link`, `link_cancel` or `link_unlink` (apps/api/src/usage/event.ts, packages/console-core
-- usage-event.ts), as every login is. This file widens the endpoint list of `usage.events` and of `record_event`
-- (the function below is 0001's with that one list changed); no row changes. A link event carries no uid (only login,
-- session and derive events do). No user data.

ALTER TABLE usage.events DROP CONSTRAINT events_endpoint_check;
ALTER TABLE usage.events ADD CONSTRAINT events_endpoint_check CHECK (endpoint IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink'));

CREATE OR REPLACE FUNCTION usage.record_event(e jsonb) RETURNS boolean
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
  IF jsonb_typeof(e -> 'endpoint') <> 'string' OR (e ->> 'endpoint') NOT IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink') THEN PERFORM usage.event_invalid('endpoint'); END IF;
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

-- CREATE OR REPLACE keeps the function's owner and grants (execute for usage_writer only, from 0001).
