-- Usage ledger, Hana Home batch H11: a Hana Home derive is a usage event (docs/hana-home-spec.md "Cost and latency",
-- D461, D585). `POST /v1/home/login` relays one `create_session_and_derive` from the Home pool, so each derive that
-- reached the relay is one event with endpoint `home_login` (apps/api/src/usage/event.ts, packages/console-core
-- usage-event.ts). It names a scope and no app, as an owner action does, so this file:
--
--   1. widens the endpoint list of `usage.events` and of `record_event`, and the `app_id` rule of both: `app_id` is
--      NULL exactly for owner actions and Home derives (the function below is 0005's with those two rules changed);
--   2. (below, after the report) replaces `usage.org_ledger` so a partner's ledger rows don't point at a Home derive's
--      transaction, adds `usage.org_ledger_full` for the admin, and adds `ops.nonce_checks.reason`;
--   3. replaces `usage.org_report` (0006's, with two columns added, so it is dropped and created again with the same
--      grants): `kind` says what a row is about ('app', 'scope' for a scope's owner actions, 'home' for a scope's Hana
--      Home logins), and `home_logins` counts the ok ones. A scope's Home logins are a row of their own, with the gas of
--      those logins only, so a statement can show them as their own line.
--
-- No row changes. A Home event carries no uid (only login, session and derive events do). Its `org_id` is the org that
-- pays, chosen by the API when it writes the event (apps/api/src/home/billing.ts): the scope's org while it has an
-- active app, Hana's own org otherwise. No user data.

-- Each file runs in one transaction (scripts/lib/usage-migrate.ts). The two ALTERs below take an ACCESS EXCLUSIVE lock on
-- usage.events and scan it once to check the new rules; rather than queue behind a long statement and hold every writer
-- up meanwhile, give up after 5 s (the file then fails as a whole and can simply be run again). A CHECK may be added
-- NOT VALID on a partitioned table and validated afterwards (tried on Postgres 18), but inside one transaction that
-- gains nothing: the first lock is held to the commit either way.
--
-- There is no down file. To go back: deploy the older API first (so no `home_login` event is written), and leave this
-- schema in place; it accepts everything the older schema did.
SET LOCAL lock_timeout = '5s';

ALTER TABLE usage.events DROP CONSTRAINT events_endpoint_check;
ALTER TABLE usage.events ADD CONSTRAINT events_endpoint_check CHECK (endpoint IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink', 'home_login'));

-- 0001 gave the app_id rule no name, so it is found by what it says (exactly one such constraint, or this file fails).
DO $$
DECLARE
  names text[];
BEGIN
  SELECT array_agg(c.conname) INTO names
    FROM pg_constraint c
   WHERE c.conrelid = 'usage.events'::regclass AND c.contype = 'c'
     AND pg_get_constraintdef(c.oid) LIKE '%owner_action%' AND pg_get_constraintdef(c.oid) LIKE '%app_id IS NULL%';
  IF names IS NULL OR cardinality(names) <> 1 THEN
    RAISE EXCEPTION '0008: expected one app_id rule on usage.events, found %', COALESCE(cardinality(names), 0);
  END IF;
  EXECUTE format('ALTER TABLE usage.events DROP CONSTRAINT %I', names[1]);
END
$$;
ALTER TABLE usage.events ADD CONSTRAINT events_app_id_check CHECK ((endpoint IN ('owner_action', 'home_login')) = (app_id IS NULL));

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
  IF jsonb_typeof(e -> 'endpoint') <> 'string' OR (e ->> 'endpoint') NOT IN ('login', 'session', 'derive', 'revoke', 'unlock', 'owner_action', 'link', 'link_cancel', 'link_unlink', 'home_login') THEN PERFORM usage.event_invalid('endpoint'); END IF;
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
  IF ((e ->> 'endpoint') IN ('owner_action', 'home_login')) <> (ev_app IS NULL) THEN PERFORM usage.event_invalid('app_id is null exactly for owner actions and Hana Home derives'); END IF;
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

-- ---- reports ----

-- 0006's report with `kind` and `home_logins` (see the top of this file); everything else is unchanged. An app filter
-- (`app_ids`) leaves Home rows out, as it leaves owner actions out: neither has an app.
DROP FUNCTION usage.org_report(text, date, date, text, text[], timestamptz);
CREATE FUNCTION usage.org_report(p_org text, from_day date, to_day date, p_by text, app_ids text[] DEFAULT NULL, as_of timestamptz DEFAULT NULL)
RETURNS TABLE (period text, app_id text, scope_id text, kind text,
               logins bigint, derives bigint, revokes bigint, unlocks bigint, owner_actions bigint, link_actions bigint, home_logins bigint,
               active_users bigint, new_users bigint, identity_tokens bigint, failures jsonb,
               gas text, rejected_gas text, error_gas text, burnt_yocto text, rejected_yocto text, error_yocto text,
               usd_micros text, rejected_usd_micros text, near_usd_rate bigint, rate_source text,
               login_p50 integer, login_p95 integer, derive_p50 integer, derive_p95 integer,
               unsettled bigint, after_statement bigint)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  from_ts timestamptz;
  to_ts   timestamptz;
  fmt     text;
BEGIN
  IF p_org IS NULL OR length(p_org) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'org_report: org' USING ERRCODE = '22023'; END IF;
  IF from_day IS NULL OR to_day IS NULL OR to_day < from_day OR to_day - from_day >= 400 THEN
    RAISE EXCEPTION 'org_report: a range of 1 to 400 days' USING ERRCODE = '22023';
  END IF;
  IF p_by IS NULL OR p_by NOT IN ('day', 'month') THEN RAISE EXCEPTION 'org_report: by is day or month' USING ERRCODE = '22023'; END IF;
  IF app_ids IS NOT NULL AND (cardinality(app_ids) = 0 OR cardinality(app_ids) > 100) THEN
    RAISE EXCEPTION 'org_report: 1 to 100 apps' USING ERRCODE = '22023';
  END IF;
  from_ts := from_day::timestamp AT TIME ZONE 'UTC';
  to_ts := (to_day + 1)::timestamp AT TIME ZONE 'UTC';
  fmt := CASE p_by WHEN 'day' THEN 'YYYY-MM-DD' ELSE 'YYYY-MM' END;

  RETURN QUERY
  WITH ev AS (
    SELECT c.*, (c.at AT TIME ZONE 'UTC')::date AS d, to_char(date_trunc(p_by, c.at AT TIME ZONE 'UTC'), fmt) AS p,
           CASE WHEN c.endpoint = 'home_login' THEN 'home' WHEN c.app_id IS NULL THEN 'scope' ELSE 'app' END AS k
      FROM usage.classified(p_org, from_ts, to_ts, as_of) c
     WHERE app_ids IS NULL OR c.app_id = ANY (app_ids)
  ),
  -- Gas and USD per UTC day and row key (USD is rounded per day, then summed).
  dg AS (
    SELECT ev.p, ev.d, ev.app_id, ev.scope_id, ev.k,
           COALESCE(sum(ev.tokens_burnt), 0) AS burnt,
           COALESCE(sum(ev.tokens_burnt) FILTER (WHERE ev.outcome = 'rejected'), 0) AS rej_burnt
      FROM ev WHERE ev.gas_status = 'final' GROUP BY 1, 2, 3, 4, 5
  ),
  du AS (
    SELECT dg.p, dg.app_id, dg.scope_id, dg.k,
           bool_and(r.usd_micros IS NOT NULL OR dg.burnt = 0) AS priced,
           sum(CASE WHEN r.usd_micros IS NULL THEN 0 ELSE div(dg.burnt * r.usd_micros * 2 + 10::numeric ^ 24, 2 * 10::numeric ^ 24) END) AS usd,
           sum(CASE WHEN r.usd_micros IS NULL THEN 0 ELSE div(dg.rej_burnt * r.usd_micros * 2 + 10::numeric ^ 24, 2 * 10::numeric ^ 24) END) AS rej_usd
      FROM dg LEFT JOIN usage.near_usd_rates r ON r.day = dg.d
     GROUP BY 1, 2, 3, 4
  ),
  agg AS (
    SELECT ev.p, ev.app_id, ev.scope_id, ev.k,
           count(*) FILTER (WHERE ev.endpoint IN ('login', 'session') AND ev.outcome = 'ok') AS logins,
           count(*) FILTER (WHERE ev.endpoint = 'derive' AND ev.outcome = 'ok') AS derives,
           count(*) FILTER (WHERE ev.endpoint = 'revoke' AND ev.outcome = 'ok') AS revokes,
           count(*) FILTER (WHERE ev.endpoint = 'unlock' AND ev.outcome = 'ok') AS unlocks,
           count(*) FILTER (WHERE ev.endpoint = 'owner_action' AND ev.outcome = 'ok') AS owner_actions,
           count(*) FILTER (WHERE ev.endpoint IN ('link', 'link_cancel', 'link_unlink') AND ev.outcome = 'ok') AS link_actions,
           count(*) FILTER (WHERE ev.endpoint = 'home_login' AND ev.outcome = 'ok') AS home_logins,
           count(DISTINCT ev.uid) AS active_users,
           COALESCE(sum(ev.gas_burnt) FILTER (WHERE ev.gas_status = 'final'), 0) AS gas,
           COALESCE(sum(ev.gas_burnt) FILTER (WHERE ev.gas_status = 'final' AND ev.outcome = 'rejected'), 0) AS rejected_gas,
           COALESCE(sum(ev.gas_burnt) FILTER (WHERE ev.gas_status = 'final' AND ev.outcome = 'error'), 0) AS error_gas,
           COALESCE(sum(ev.tokens_burnt) FILTER (WHERE ev.gas_status = 'final'), 0) AS burnt,
           COALESCE(sum(ev.tokens_burnt) FILTER (WHERE ev.gas_status = 'final' AND ev.outcome = 'rejected'), 0) AS rejected_burnt,
           COALESCE(sum(ev.tokens_burnt) FILTER (WHERE ev.gas_status = 'final' AND ev.outcome = 'error'), 0) AS error_burnt,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY ev.latency_ms) FILTER (WHERE ev.endpoint = 'login' AND ev.outcome = 'ok') AS login_p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY ev.latency_ms) FILTER (WHERE ev.endpoint = 'login' AND ev.outcome = 'ok') AS login_p95,
           percentile_disc(0.5) WITHIN GROUP (ORDER BY ev.latency_ms) FILTER (WHERE ev.endpoint = 'derive' AND ev.outcome = 'ok') AS derive_p50,
           percentile_disc(0.95) WITHIN GROUP (ORDER BY ev.latency_ms) FILTER (WHERE ev.endpoint = 'derive' AND ev.outcome = 'ok') AS derive_p95,
           count(*) FILTER (WHERE ev.gas_status IN ('pending', 'unsettled')) AS unsettled,
           count(*) FILTER (WHERE ev.received_at > st.as_of) AS after_statement
      FROM ev
      LEFT JOIN usage.statements st ON st.org_id = p_org AND st.month = date_trunc('month', ev.d)::date
     GROUP BY 1, 2, 3, 4
  ),
  fail AS (
    SELECT f.p, f.app_id, f.scope_id, f.k, jsonb_object_agg(f.code, f.n ORDER BY f.code) AS failures
      FROM (SELECT ev.p, ev.app_id, ev.scope_id, ev.k, ev.code, count(*) AS n FROM ev WHERE ev.outcome <> 'ok' GROUP BY 1, 2, 3, 4, 5) f
     GROUP BY 1, 2, 3, 4
  ),
  idt AS (
    SELECT to_char(date_trunc(p_by, t.day::timestamp), fmt) AS p, t.app_id, t.scope_id, sum(t.tokens)::bigint AS tokens
      FROM usage.identity_tokens t
     WHERE t.org_id = p_org AND t.day >= from_day AND t.day <= to_day AND (app_ids IS NULL OR t.app_id = ANY (app_ids))
     GROUP BY 1, 2, 3
  ),
  nu AS (
    SELECT to_char(date_trunc(p_by, u.first_seen::timestamp), fmt) AS p, u.app_id, count(*) AS n
      FROM usage.app_users u
     WHERE u.first_seen >= from_day AND u.first_seen <= to_day AND u.app_id IN (SELECT DISTINCT ev.app_id FROM ev WHERE ev.app_id IS NOT NULL)
     GROUP BY 1, 2
  ),
  -- A day row names its day's rate; a month row names none.
  rate AS (
    SELECT to_char(r.day, 'YYYY-MM-DD') AS p, r.usd_micros, r.source FROM usage.near_usd_rates r
     WHERE p_by = 'day' AND r.day >= from_day AND r.day <= to_day
  ),
  keys AS (
    SELECT agg.p, agg.app_id, agg.scope_id, agg.k FROM agg
    UNION
    SELECT idt.p, idt.app_id, idt.scope_id, 'app' FROM idt
  )
  SELECT k.p, k.app_id, k.scope_id, k.k,
         COALESCE(a.logins, 0), COALESCE(a.derives, 0), COALESCE(a.revokes, 0), COALESCE(a.unlocks, 0),
         COALESCE(a.owner_actions, 0), COALESCE(a.link_actions, 0), COALESCE(a.home_logins, 0), COALESCE(a.active_users, 0),
         COALESCE(nu.n, 0), COALESCE(idt.tokens, 0), COALESCE(fail.failures, '{}'::jsonb),
         COALESCE(a.gas, 0)::text, COALESCE(a.rejected_gas, 0)::text, COALESCE(a.error_gas, 0)::text,
         COALESCE(a.burnt, 0)::text, COALESCE(a.rejected_burnt, 0)::text, COALESCE(a.error_burnt, 0)::text,
         CASE WHEN du.p IS NULL THEN '0' WHEN du.priced THEN du.usd::text END,
         CASE WHEN du.p IS NULL THEN '0' WHEN du.priced THEN du.rej_usd::text END,
         rate.usd_micros, rate.source,
         a.login_p50, a.login_p95, a.derive_p50, a.derive_p95,
         COALESCE(a.unsettled, 0), COALESCE(a.after_statement, 0)
    FROM keys k
    LEFT JOIN agg a ON a.p = k.p AND a.app_id IS NOT DISTINCT FROM k.app_id AND a.scope_id = k.scope_id AND a.k = k.k
    LEFT JOIN du ON du.p = k.p AND du.app_id IS NOT DISTINCT FROM k.app_id AND du.scope_id = k.scope_id AND du.k = k.k
    LEFT JOIN fail ON fail.p = k.p AND fail.app_id IS NOT DISTINCT FROM k.app_id AND fail.scope_id = k.scope_id AND fail.k = k.k
    LEFT JOIN idt ON idt.p = k.p AND idt.app_id IS NOT DISTINCT FROM k.app_id AND idt.scope_id = k.scope_id AND k.k = 'app'
    LEFT JOIN nu ON nu.p = k.p AND nu.app_id = k.app_id
    LEFT JOIN rate ON rate.p = k.p
   ORDER BY k.p, (k.app_id IS NULL), k.app_id, k.scope_id, k.k DESC;
END
$$;

REVOKE EXECUTE ON FUNCTION usage.org_report(text, date, date, text, text[], timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.org_report(text, date, date, text, text[], timestamptz) TO usage_writer, usage_admin;

-- ---- the ledger CSV: what a partner may read of a Home derive ----

-- A Home derive's transaction is public on chain and its arguments carry the user's ID token, so a partner's ledger
-- must not point at it. `usage.org_ledger` (the partner's rows through the API's writer role, as before) now returns a
-- Home row without its transaction hash, with the UTC day in place of the exact time, and with a row id that is a hash
-- of the request id (stable, unique, and no key into Hana's logs). Its gas stays, so the CSV still sums to the
-- statement. Every other row is unchanged. The admin Worker reads the full rows from `usage.org_ledger_full` (0006's
-- function under a new name, admin only), to reconcile a statement against the chain.
CREATE FUNCTION usage.org_ledger_full(p_org text, p_month date, as_of timestamptz, after text, lim integer)
RETURNS TABLE (request_id text, at_ms bigint, org_id text, scope_id text, app_id text, endpoint text, outcome text,
               relayed boolean, near_tx text, gas_status text, gas_burnt text, tokens_burnt text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  after_rid text;
  after_at  timestamptz;
  bound     timestamptz := COALESCE(as_of, now());
BEGIN
  IF p_org IS NULL OR length(p_org) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'org_ledger_full: org' USING ERRCODE = '22023'; END IF;
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN RAISE EXCEPTION 'org_ledger_full: month is a first of month' USING ERRCODE = '22023'; END IF;
  IF lim IS NULL OR lim < 1 OR lim > 1000 THEN RAISE EXCEPTION 'org_ledger_full: lim 1..1000' USING ERRCODE = '22023'; END IF;
  IF after IS NOT NULL THEN
    IF after !~ '^[A-Za-z0-9_-]{8,128},(0|[1-9][0-9]{0,15})$' THEN RAISE EXCEPTION 'org_ledger_full: cursor' USING ERRCODE = '22023'; END IF;
    after_rid := split_part(after, ',', 1);
    after_at := timestamptz 'epoch' + (split_part(after, ',', 2)::bigint / 1000) * interval '1 second' + (split_part(after, ',', 2)::bigint % 1000) * interval '1 millisecond';
  END IF;
  RETURN QUERY
  SELECT c.request_id, (extract(epoch FROM c.at) * 1000)::bigint, c.org_id, c.scope_id, c.app_id, c.endpoint, c.outcome,
         c.relayed, c.near_tx, c.gas_status, c.gas_burnt::text, c.tokens_burnt::text
    FROM usage.classified(p_org, p_month::timestamp AT TIME ZONE 'UTC', (p_month + interval '1 month')::timestamp AT TIME ZONE 'UTC', bound) c
   WHERE after IS NULL OR (c.request_id, c.at) > (after_rid, after_at)
   ORDER BY c.request_id, c.at
   LIMIT lim;
END
$$;

CREATE OR REPLACE FUNCTION usage.org_ledger(p_org text, p_month date, as_of timestamptz, after text, lim integer)
RETURNS TABLE (request_id text, at_ms bigint, org_id text, scope_id text, app_id text, endpoint text, outcome text,
               relayed boolean, near_tx text, gas_status text, gas_burnt text, tokens_burnt text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  after_rid text;
  after_at  timestamptz;
  bound     timestamptz := COALESCE(as_of, now());
BEGIN
  IF p_org IS NULL OR length(p_org) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'org_ledger: org' USING ERRCODE = '22023'; END IF;
  IF p_month IS NULL OR EXTRACT(DAY FROM p_month) <> 1 THEN RAISE EXCEPTION 'org_ledger: month is a first of month' USING ERRCODE = '22023'; END IF;
  IF lim IS NULL OR lim < 1 OR lim > 1000 THEN RAISE EXCEPTION 'org_ledger: lim 1..1000' USING ERRCODE = '22023'; END IF;
  IF after IS NOT NULL THEN
    IF after !~ '^[A-Za-z0-9_-]{8,128},(0|[1-9][0-9]{0,15})$' THEN RAISE EXCEPTION 'org_ledger: cursor' USING ERRCODE = '22023'; END IF;
    after_rid := split_part(after, ',', 1);
    after_at := timestamptz 'epoch' + (split_part(after, ',', 2)::bigint / 1000) * interval '1 second' + (split_part(after, ',', 2)::bigint % 1000) * interval '1 millisecond';
  END IF;
  RETURN QUERY
  SELECT r.rid, (extract(epoch FROM r.rat) * 1000)::bigint, r.org_id, r.scope_id, r.app_id, r.endpoint, r.outcome,
         r.relayed, r.tx, r.gas_status, r.gas_burnt::text, r.tokens_burnt::text
    FROM (
      SELECT CASE WHEN c.endpoint = 'home_login'
                  THEN 'home_' || substr(encode(sha256(convert_to(c.request_id || ',' || (extract(epoch FROM c.at) * 1000)::bigint::text, 'UTF8')), 'hex'), 1, 32)
                  ELSE c.request_id END AS rid,
             CASE WHEN c.endpoint = 'home_login' THEN date_trunc('day', c.at) ELSE c.at END AS rat,
             CASE WHEN c.endpoint = 'home_login' THEN NULL ELSE c.near_tx END AS tx,
             c.org_id, c.scope_id, c.app_id, c.endpoint, c.outcome, c.relayed, c.gas_status, c.gas_burnt, c.tokens_burnt
        FROM usage.classified(p_org, p_month::timestamp AT TIME ZONE 'UTC', (p_month + interval '1 month')::timestamp AT TIME ZONE 'UTC', bound) c
    ) r
   WHERE after IS NULL OR (r.rid, r.rat) > (after_rid, after_at)
   ORDER BY r.rid, r.rat
   LIMIT lim;
END
$$;

REVOKE EXECUTE ON FUNCTION usage.org_ledger_full(text, date, timestamptz, text, integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.org_ledger_full(text, date, timestamptz, text, integer) TO usage_admin;

-- ---- the nonce check: why a check was taken as explained ----

-- 'capture_off': the API reported usage capture off, so the nonce was recorded as a baseline and nothing was judged.
-- 'capture_on': the first check after capture came back on, a fresh baseline. NULL: judged by the ledger, as before.
ALTER TABLE ops.nonce_checks ADD COLUMN reason text CHECK (reason IS NULL OR reason IN ('capture_off', 'capture_on'));
