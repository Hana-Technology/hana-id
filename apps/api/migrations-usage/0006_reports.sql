-- Usage ledger, batch C12: reports, statements, settlement checks and the audited rate override (docs/batch-c-spec.md
-- "Reports", "Monthly statements", "Settlement", "Rejection-rate check"; docs/batch-c-build-plan.md C12; D320–D329).
-- Numbered 0006: 0004 and 0005 were taken by the email work, so C12 takes the next free number and C13's retention
-- functions the one after (0007).
--
-- What it adds, all owner-defined (SECURITY DEFINER, `SET search_path = usage, pg_temp`), with EXECUTE revoked from
-- PUBLIC and granted by name:
--
--   usage.classified(...)        internal: an org's events in a window as billing sees them (gas_status), the one rule
--                                every report, the ledger CSV and a statement share. Not granted to any role.
--   usage.org_report(...)        the report rows (per day or month, per app, owner actions per scope)    writer, admin
--   usage.org_statements(org)    statement metadata with the stored totals                                 writer, admin
--   usage.org_ledger(...)        the ledger CSV's rows, keyset-paged by (request_id, at)                   writer, admin
--   usage.rejection_rates(day)   per org: relayed attempts and relayed-then-rejected ones (D91)                   admin
--   usage.statement_blockers(..) what still stops a statement: unsettled-pending events, days without a rate     admin
--   usage.override_rate(...)     the audited manual NEAR/USD override: the rate and its audit row together         admin
--
-- The settlement obligation from C4 (review L7, D222; D321): a relayed event is billed only when its transaction is
-- its own. The admin's settlement checks the signer and nonce at FINAL and records a refusal as `unsettled` with a
-- `reason`; `classified` also refuses, at read time, any relayed event whose `near_tx` another relayed event (received
-- by the same `as_of`) carries, so a duplicate written after the first was settled bills neither, and a statement and
-- its ledger CSV still agree for the same `as_of`.

-- ---- settlement: why an event isn't billed, and the alerts staff see ----

ALTER TABLE usage.gas_settlements ADD COLUMN reason text
  CHECK (reason IS NULL OR reason IN ('not_final', 'duplicate_tx', 'signer_mismatch'));
ALTER TABLE usage.gas_settlements ADD CONSTRAINT gas_settlements_reason_unsettled CHECK (reason IS NULL OR result = 'unsettled');

-- The duplicate check (settlement and `classified`): relayed events by transaction hash, on every partition.
CREATE INDEX events_near_tx ON usage.events (near_tx) WHERE relayed;

-- A relayed event settlement refused to bill (a duplicate transaction, or a transaction signed by another key or at
-- another nonce): listed on the admin's security screen and emailed to the security alias once (`alerted_at`).
CREATE TABLE ops.settlement_alerts (
  request_id  text        NOT NULL,
  at          timestamptz NOT NULL,
  org_id      text        NOT NULL,
  near_tx     text        NOT NULL,
  reason      text        NOT NULL CHECK (reason IN ('duplicate_tx', 'signer_mismatch')),
  detail      jsonb       NOT NULL DEFAULT '{}',
  detected_at timestamptz NOT NULL DEFAULT now(),
  alerted_at  timestamptz,
  PRIMARY KEY (request_id, at)
);
CREATE INDEX settlement_alerts_detected ON ops.settlement_alerts (detected_at);

-- Settlement's retry state for an event whose transaction isn't final yet: one read an hour at most, so a backlog of
-- transactions the RPC can't find (or forged hashes) can't take every run's budget (D322).
CREATE TABLE ops.settlement_tries (
  request_id     text        NOT NULL,
  at             timestamptz NOT NULL,
  tries          integer     NOT NULL CHECK (tries > 0),
  last_tried_at  timestamptz NOT NULL,
  last_error     text,
  PRIMARY KEY (request_id, at)
);

-- A statement's notice to the org's security contacts and billing email (the feed, at least once).
CREATE TABLE ops.statement_notices (
  org_id      text        NOT NULL,
  month       date        NOT NULL,
  notified_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id, month)
);

-- ---- the audited rate override ----

-- Every manual NEAR/USD rate (a new day or a replaced one): append-only for every role but the owner, written only by
-- usage.override_rate in the same transaction as the rate itself.
CREATE TABLE usage.rate_overrides (
  id                  bigserial   PRIMARY KEY,
  day                 date        NOT NULL,
  usd_micros          bigint      NOT NULL CHECK (usd_micros > 0),
  previous_usd_micros bigint,
  previous_source     text,
  entered_by          text        NOT NULL CHECK (length(entered_by) BETWEEN 1 AND 254),
  reason              text        NOT NULL CHECK (length(reason) BETWEEN 10 AND 500),
  at                  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX rate_overrides_day ON usage.rate_overrides (day);
CREATE TRIGGER rate_overrides_frozen BEFORE UPDATE OR DELETE ON usage.rate_overrides
  FOR EACH ROW EXECUTE FUNCTION usage.statements_frozen();
CREATE TRIGGER rate_overrides_no_truncate BEFORE TRUNCATE ON usage.rate_overrides
  FOR EACH STATEMENT EXECUTE FUNCTION usage.statements_frozen();

-- Sets a day's rate by hand (D93: the audited manual override): inserts or replaces it with source 'manual' and the
-- staff member's id, and appends the audit row, in one transaction. A month with a statement refuses (the rates_frozen
-- trigger). Returns the audit row's id.
CREATE FUNCTION usage.override_rate(p_day date, p_usd_micros bigint, p_entered_by text, p_reason text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  prev usage.near_usd_rates%ROWTYPE;
  id   bigint;
BEGIN
  IF p_day IS NULL OR p_usd_micros IS NULL OR p_usd_micros <= 0 OR p_usd_micros > 1000000000000 THEN
    RAISE EXCEPTION 'override_rate: a day and a positive rate of at most 1 000 000 USD' USING ERRCODE = '22023';
  END IF;
  IF p_day > (now() AT TIME ZONE 'UTC')::date THEN
    RAISE EXCEPTION 'override_rate: % is in the future', p_day USING ERRCODE = '22023';
  END IF;
  IF p_entered_by IS NULL OR length(p_entered_by) NOT BETWEEN 1 AND 254 OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 10 AND 500 THEN
    RAISE EXCEPTION 'override_rate: who and why (10 to 500 characters)' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO prev FROM usage.near_usd_rates WHERE day = p_day FOR UPDATE;
  IF FOUND THEN
    UPDATE usage.near_usd_rates SET usd_micros = p_usd_micros, source = 'manual', entered_by = p_entered_by, fetched_at = now() WHERE day = p_day;
  ELSE
    INSERT INTO usage.near_usd_rates (day, usd_micros, source, entered_by) VALUES (p_day, p_usd_micros, 'manual', p_entered_by);
  END IF;
  INSERT INTO usage.rate_overrides (day, usd_micros, previous_usd_micros, previous_source, entered_by, reason)
  VALUES (p_day, p_usd_micros, prev.usd_micros, prev.source, p_entered_by, btrim(p_reason))
  RETURNING rate_overrides.id INTO id;
  RETURN id;
END
$$;

-- ---- how billing sees an event ----

-- The org's events with `at` in [from_ts, to_ts) and `received_at <= as_of` (NULL: no bound), with what billing makes
-- of each: gas_status 'none' (not relayed), 'pending' (relayed, no settlement yet), 'final' (billed: settled at FINAL
-- for this very event, and no other relayed event received by as_of carries its transaction) or 'unsettled' (not
-- billed: settled as unsettled, a duplicate transaction, or a settlement row of another event with the same request
-- id). gas_burnt and tokens_burnt are set only when final.
CREATE FUNCTION usage.classified(p_org text, from_ts timestamptz, to_ts timestamptz, as_of timestamptz)
RETURNS TABLE (request_id text, at timestamptz, received_at timestamptz, org_id text, app_id text, scope_id text,
               endpoint text, outcome text, code text, latency_ms integer, relayed boolean, near_tx text, uid bytea,
               gas_status text, gas_burnt bigint, tokens_burnt numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT e.request_id, e.at, e.received_at, e.org_id, e.app_id, e.scope_id, e.endpoint, e.outcome, e.code, e.latency_ms,
         e.relayed, e.near_tx, e.uid, s.gas_status,
         CASE WHEN s.gas_status = 'final' THEN g.gas_burnt END,
         CASE WHEN s.gas_status = 'final' THEN g.tokens_burnt END
    FROM usage.events e
    LEFT JOIN usage.gas_settlements g ON g.request_id = e.request_id AND g.at = e.at
    CROSS JOIN LATERAL (
      SELECT CASE
        WHEN NOT e.relayed THEN 'none'
        WHEN g.request_id IS NULL AND NOT EXISTS (SELECT 1 FROM usage.gas_settlements g2 WHERE g2.request_id = e.request_id) THEN 'pending'
        WHEN g.result = 'final' AND NOT EXISTS (
          SELECT 1 FROM usage.events d
           WHERE d.relayed AND d.near_tx = e.near_tx AND (d.request_id, d.at) <> (e.request_id, e.at)
             AND d.received_at <= COALESCE(as_of, 'infinity'::timestamptz)) THEN 'final'
        ELSE 'unsettled'
      END AS gas_status
    ) s
   WHERE e.org_id = p_org AND e.at >= from_ts AND e.at < to_ts
     AND e.received_at <= COALESCE(as_of, 'infinity'::timestamptz)
$$;

-- ---- reports ----

-- One org's report (docs/batch-c-spec.md "Reports"): a row per period (UTC day or month) and app, and per period and
-- scope for owner actions (app_id NULL). `from_day` and `to_day` are inclusive, at most 400 days apart; `app_ids` (NULL:
-- every app; at most 100) also leaves owner actions out. `as_of` bounds `received_at` (NULL: none). Large figures are
-- decimal text. USD: per UTC day round-half-up(yocto × usd_micros / 10^24) in micro-dollars, a period's the sum of its
-- days; NULL when a day with gas has no rate. Percentiles are exact nearest-rank over ok requests' server latency.
-- `after_statement`: events of the row received after the as_of of the month's statement (late events).
CREATE FUNCTION usage.org_report(p_org text, from_day date, to_day date, p_by text, app_ids text[] DEFAULT NULL, as_of timestamptz DEFAULT NULL)
RETURNS TABLE (period text, app_id text, scope_id text,
               logins bigint, derives bigint, revokes bigint, unlocks bigint, owner_actions bigint, link_actions bigint,
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
    SELECT c.*, (c.at AT TIME ZONE 'UTC')::date AS d, to_char(date_trunc(p_by, c.at AT TIME ZONE 'UTC'), fmt) AS p
      FROM usage.classified(p_org, from_ts, to_ts, as_of) c
     WHERE app_ids IS NULL OR c.app_id = ANY (app_ids)
  ),
  -- Gas and USD per UTC day and row key (USD is rounded per day, then summed).
  dg AS (
    SELECT ev.p, ev.d, ev.app_id, ev.scope_id,
           COALESCE(sum(ev.tokens_burnt), 0) AS burnt,
           COALESCE(sum(ev.tokens_burnt) FILTER (WHERE ev.outcome = 'rejected'), 0) AS rej_burnt
      FROM ev WHERE ev.gas_status = 'final' GROUP BY 1, 2, 3, 4
  ),
  du AS (
    SELECT dg.p, dg.app_id, dg.scope_id,
           bool_and(r.usd_micros IS NOT NULL OR dg.burnt = 0) AS priced,
           sum(CASE WHEN r.usd_micros IS NULL THEN 0 ELSE div(dg.burnt * r.usd_micros * 2 + 10::numeric ^ 24, 2 * 10::numeric ^ 24) END) AS usd,
           sum(CASE WHEN r.usd_micros IS NULL THEN 0 ELSE div(dg.rej_burnt * r.usd_micros * 2 + 10::numeric ^ 24, 2 * 10::numeric ^ 24) END) AS rej_usd
      FROM dg LEFT JOIN usage.near_usd_rates r ON r.day = dg.d
     GROUP BY 1, 2, 3
  ),
  agg AS (
    SELECT ev.p, ev.app_id, ev.scope_id,
           count(*) FILTER (WHERE ev.endpoint IN ('login', 'session') AND ev.outcome = 'ok') AS logins,
           count(*) FILTER (WHERE ev.endpoint = 'derive' AND ev.outcome = 'ok') AS derives,
           count(*) FILTER (WHERE ev.endpoint = 'revoke' AND ev.outcome = 'ok') AS revokes,
           count(*) FILTER (WHERE ev.endpoint = 'unlock' AND ev.outcome = 'ok') AS unlocks,
           count(*) FILTER (WHERE ev.endpoint = 'owner_action' AND ev.outcome = 'ok') AS owner_actions,
           count(*) FILTER (WHERE ev.endpoint IN ('link', 'link_cancel', 'link_unlink') AND ev.outcome = 'ok') AS link_actions,
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
     GROUP BY 1, 2, 3
  ),
  fail AS (
    SELECT f.p, f.app_id, f.scope_id, jsonb_object_agg(f.code, f.n ORDER BY f.code) AS failures
      FROM (SELECT ev.p, ev.app_id, ev.scope_id, ev.code, count(*) AS n FROM ev WHERE ev.outcome <> 'ok' GROUP BY 1, 2, 3, 4) f
     GROUP BY 1, 2, 3
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
    SELECT agg.p, agg.app_id, agg.scope_id FROM agg
    UNION
    SELECT idt.p, idt.app_id, idt.scope_id FROM idt
  )
  SELECT k.p, k.app_id, k.scope_id,
         COALESCE(a.logins, 0), COALESCE(a.derives, 0), COALESCE(a.revokes, 0), COALESCE(a.unlocks, 0),
         COALESCE(a.owner_actions, 0), COALESCE(a.link_actions, 0), COALESCE(a.active_users, 0),
         COALESCE(nu.n, 0), COALESCE(idt.tokens, 0), COALESCE(fail.failures, '{}'::jsonb),
         COALESCE(a.gas, 0)::text, COALESCE(a.rejected_gas, 0)::text, COALESCE(a.error_gas, 0)::text,
         COALESCE(a.burnt, 0)::text, COALESCE(a.rejected_burnt, 0)::text, COALESCE(a.error_burnt, 0)::text,
         CASE WHEN du.p IS NULL THEN '0' WHEN du.priced THEN du.usd::text END,
         CASE WHEN du.p IS NULL THEN '0' WHEN du.priced THEN du.rej_usd::text END,
         rate.usd_micros, rate.source,
         a.login_p50, a.login_p95, a.derive_p50, a.derive_p95,
         COALESCE(a.unsettled, 0), COALESCE(a.after_statement, 0)
    FROM keys k
    LEFT JOIN agg a ON a.p = k.p AND a.app_id IS NOT DISTINCT FROM k.app_id AND a.scope_id = k.scope_id
    LEFT JOIN du ON du.p = k.p AND du.app_id IS NOT DISTINCT FROM k.app_id AND du.scope_id = k.scope_id
    LEFT JOIN fail ON fail.p = k.p AND fail.app_id IS NOT DISTINCT FROM k.app_id AND fail.scope_id = k.scope_id
    LEFT JOIN idt ON idt.p = k.p AND idt.app_id IS NOT DISTINCT FROM k.app_id AND idt.scope_id = k.scope_id
    LEFT JOIN nu ON nu.p = k.p AND nu.app_id = k.app_id
    LEFT JOIN rate ON rate.p = k.p
   ORDER BY k.p, (k.app_id IS NULL), k.app_id, k.scope_id;
END
$$;

-- The org's statements, newest month first, with the stored totals (the on-screen statement, D92).
CREATE FUNCTION usage.org_statements(p_org text)
RETURNS TABLE (month text, as_of_ms bigint, csv_key text, csv_sha256 text, pdf_key text, pdf_sha256 text, totals jsonb, issued_by text, issued_at_ms bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT to_char(s.month, 'YYYY-MM'), (extract(epoch FROM s.as_of) * 1000)::bigint, s.csv_key, encode(s.csv_sha256, 'hex'),
         s.pdf_key, encode(s.pdf_sha256, 'hex'), s.totals, s.issued_by, (extract(epoch FROM s.issued_at) * 1000)::bigint
    FROM usage.statements s WHERE s.org_id = p_org ORDER BY s.month DESC LIMIT 120
$$;

-- The ledger CSV's rows for an org and month (docs/batch-c-spec.md "Ledger CSV"): every event with `at` in the month
-- and `received_at <= as_of` (NULL: now), ordered by (request_id, at) after the cursor `after` ('<request_id>,<at ms>';
-- NULL: from the start), at most `lim` (1..1000). Gas only on final rows, so the sum of the final rows' gas for the same
-- as_of is the statement's.
CREATE FUNCTION usage.org_ledger(p_org text, p_month date, as_of timestamptz, after text, lim integer)
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
  SELECT c.request_id, (extract(epoch FROM c.at) * 1000)::bigint, c.org_id, c.scope_id, c.app_id, c.endpoint, c.outcome,
         c.relayed, c.near_tx, c.gas_status, c.gas_burnt::text, c.tokens_burnt::text
    FROM usage.classified(p_org, p_month::timestamp AT TIME ZONE 'UTC', (p_month + interval '1 month')::timestamp AT TIME ZONE 'UTC', bound) c
   WHERE after IS NULL OR (c.request_id, c.at) > (after_rid, after_at)
   ORDER BY c.request_id, c.at
   LIMIT lim;
END
$$;

-- Per org, for one UTC day: relayed attempts and the relayed ones that were rejected (D91).
CREATE FUNCTION usage.rejection_rates(p_day date)
RETURNS TABLE (org_id text, relayed bigint, rejected bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT e.org_id, count(*), count(*) FILTER (WHERE e.outcome = 'rejected')
    FROM usage.events e
   WHERE e.relayed AND e.at >= p_day::timestamp AT TIME ZONE 'UTC' AND e.at < (p_day + 1)::timestamp AT TIME ZONE 'UTC'
   GROUP BY e.org_id ORDER BY e.org_id
$$;

-- What still stops a statement for an org and month: relayed events received so far with no settlement row for their
-- request id, and the days of the month without a NEAR/USD rate.
CREATE FUNCTION usage.statement_blockers(p_org text, p_month date)
RETURNS TABLE (pending bigint, missing_rate_days text[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT
    (SELECT count(*) FROM usage.events e
      WHERE e.org_id = p_org AND e.relayed
        AND e.at >= p_month::timestamp AT TIME ZONE 'UTC' AND e.at < (p_month + interval '1 month')::timestamp AT TIME ZONE 'UTC'
        AND NOT EXISTS (SELECT 1 FROM usage.gas_settlements g WHERE g.request_id = e.request_id)),
    ARRAY(SELECT to_char(d, 'YYYY-MM-DD')
            FROM generate_series(p_month::timestamp, (p_month + interval '1 month' - interval '1 day')::timestamp, interval '1 day') AS d
           WHERE NOT EXISTS (SELECT 1 FROM usage.near_usd_rates r WHERE r.day = d::date)
           ORDER BY d)
$$;

-- ---- privileges ----

REVOKE EXECUTE ON FUNCTION usage.override_rate(date, bigint, text, text), usage.classified(text, timestamptz, timestamptz, timestamptz),
  usage.org_report(text, date, date, text, text[], timestamptz), usage.org_statements(text),
  usage.org_ledger(text, date, timestamptz, text, integer), usage.rejection_rates(date), usage.statement_blockers(text, date) FROM PUBLIC;
REVOKE ALL ON usage.rate_overrides, ops.settlement_alerts, ops.settlement_tries, ops.statement_notices FROM PUBLIC;
REVOKE ALL ON SEQUENCE usage.rate_overrides_id_seq FROM PUBLIC;

GRANT EXECUTE ON FUNCTION usage.org_report(text, date, date, text, text[], timestamptz), usage.org_statements(text),
  usage.org_ledger(text, date, timestamptz, text, integer) TO usage_writer, usage_admin;
GRANT EXECUTE ON FUNCTION usage.rejection_rates(date), usage.statement_blockers(text, date),
  usage.override_rate(date, bigint, text, text) TO usage_admin;

-- The override goes through usage.override_rate only (its audit row in the same transaction): the admin role keeps
-- INSERT (a fetched rate, never replacing one) and loses the direct UPDATE 0001 gave it.
REVOKE UPDATE ON usage.near_usd_rates FROM usage_admin;
GRANT SELECT ON usage.rate_overrides TO usage_admin;
GRANT SELECT, INSERT, UPDATE, DELETE ON ops.settlement_alerts, ops.settlement_tries, ops.statement_notices TO usage_admin;
