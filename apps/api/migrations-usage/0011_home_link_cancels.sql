-- Usage ledger, Passport Home's cancel of a waiting link (D902): `POST /v1/home/link/cancel` relays one `cancel_link`
-- from the session pool, so each request that reached the relay is one event with endpoint `home_link_cancel`
-- (apps/api/src/usage/event.ts, packages/console-core usage-event.ts). It names a scope and no app, as a Home derive
-- does, and its `org_id` is Journear's own (the API's HANA_ORG_ID, else the legacy org): no partner is billed for it.
-- Without this row the daily nonce check could not explain the session key's nonce (apps/admin/src/nonce-check.ts).
--
-- This file widens the endpoint list of `usage.events` and of `record_event`, and the `app_id` rule of both: `app_id`
-- is NULL exactly for owner actions, Home derives and Home link cancels (the function below is 0008's with those two
-- rules changed). The reports are unchanged: in `usage.org_report` a Home link cancel is a row of kind `scope` (no app,
-- not a Home derive) of Journear's own org, with its gas, counted in no column of its own. Settlement is unchanged too:
-- it is not a Home derive, so its transaction must be the session pool's (apps/admin/src/settlement.ts `poolMatches`).
--
-- No row changes. A Home link cancel carries no uid. No user data.
--
-- Each file runs in one transaction (scripts/lib/usage-migrate.ts); as 0008, give up after 5 s rather than queue behind
-- a long statement while holding every writer up (the file then fails as a whole and can simply be run again).
--
-- There is no down file. To go back: deploy the older API first (so no `home_link_cancel` event is written), and leave
-- this schema in place; it accepts everything the older schema did. Apply it BEFORE the API that has the route: until
-- then `record_event` refuses the event (`usage_write_rejected`) and the nonce check raises `nonce_unexplained`.
--
-- Applied by the founder with scripts/usage-migrate.ts (never from a Worker).
SET LOCAL lock_timeout = '5s';

ALTER TABLE usage.events DROP CONSTRAINT events_endpoint_check;
ALTER TABLE usage.events ADD CONSTRAINT events_endpoint_check CHECK (endpoint IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink', 'home_login', 'home_link_cancel'));

ALTER TABLE usage.events DROP CONSTRAINT events_app_id_check;
ALTER TABLE usage.events ADD CONSTRAINT events_app_id_check CHECK ((endpoint IN ('owner_action', 'home_login', 'home_link_cancel')) = (app_id IS NULL));

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
  IF jsonb_typeof(e -> 'endpoint') <> 'string' OR (e ->> 'endpoint') NOT IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink', 'home_login', 'home_link_cancel') THEN PERFORM usage.event_invalid('endpoint'); END IF;
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
  IF ((e ->> 'endpoint') IN ('owner_action', 'home_login', 'home_link_cancel')) <> (ev_app IS NULL) THEN PERFORM usage.event_invalid('app_id is null exactly for owner actions, Hana Home derives and Home link cancels'); END IF;
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
