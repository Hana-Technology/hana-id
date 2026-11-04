-- Usage ledger, batch C13: retention (D90; docs/batch-c-spec.md "Retention", "Usage ledger" functions; build plan C13;
-- D360–D369). Numbered 0007, after C12's 0006 (D320).
--
-- What it adds, all owner-defined (SECURITY DEFINER, `SET search_path = usage, pg_temp`), EXECUTE revoked from PUBLIC
-- and granted to `usage_admin` only (the admin Worker's monthly job; scripts/uid-erase.ts for erase_uid):
--
--   usage.strip_uids(max_rows)         raw usage 24 months: NULLs the uid on events of every UTC month that ended more
--                                      than 24 months ago and deletes app_users rows last seen more than 24 months ago,
--                                      at most max_rows of each per call; `more` says whether to call again
--   usage.drop_expired_partitions()    7 years: detaches and drops the monthly partitions whose upper bound is more than
--                                      7 years ago, and deletes the settlement records and the per-day counts of those
--                                      months (gas_settlements, identity_tokens, email_counts, the settlement alerts and
--                                      tries); never a statement, a rate or a rate override (deleted by hand, D90)
--   usage.purge_app_users(app)         an app deleted more than 30 days ago: its app_users rows
--   usage.erase_uid(uid)               an erasure request (scripts/uid-erase.ts): the user's app_users rows deleted and
--                                      the uid NULLed on every event that carries it (D362: by uid alone)
--   usage.retention_due()              what is past 7 years and waits for a person: statements, rates, overrides
--   ops.purge_expired()                the admin's own state: nonce checks and rejection alerts after 400 days, notified
--                                      watcher rows after 400 days, runs and erasure records after 60 months
--
-- And the tables the job and the erasure script write: ops.retention_runs gains the run's month, status and alert time
-- (one running run at a time), ops.erasures records each erasure (ticket, operator, counts; never a uid or a sub), and
-- the uid indexes that make strip_uids and erase_uid index reads (C15 planned `events (uid, at)`; it is here, D362).

-- ---- the monthly job's runs (shown on the admin's retention screen) ----

ALTER TABLE ops.retention_runs ADD COLUMN month date;            -- the UTC month the run is for (its first day)
ALTER TABLE ops.retention_runs ADD COLUMN status text;           -- running | ok (every step done) | partial | failed
ALTER TABLE ops.retention_runs ADD COLUMN alerted_at timestamptz; -- a failed run: retention_failed accepted by the provider
-- Nothing wrote runs before this file; any row there gets a status from what it holds.
UPDATE ops.retention_runs SET month = date_trunc('month', started_at AT TIME ZONE 'UTC')::date WHERE month IS NULL;
UPDATE ops.retention_runs SET status = CASE WHEN finished_at IS NULL THEN 'failed' WHEN error IS NULL THEN 'ok' ELSE 'failed' END,
                              finished_at = COALESCE(finished_at, started_at), error = COALESCE(error, CASE WHEN finished_at IS NULL THEN 'abandoned' END)
 WHERE status IS NULL;
ALTER TABLE ops.retention_runs ALTER COLUMN month SET NOT NULL;
ALTER TABLE ops.retention_runs ALTER COLUMN status SET NOT NULL;
ALTER TABLE ops.retention_runs ALTER COLUMN status SET DEFAULT 'running';
ALTER TABLE ops.retention_runs ADD CONSTRAINT retention_runs_status CHECK (status IN ('running', 'ok', 'partial', 'failed'));
ALTER TABLE ops.retention_runs ADD CONSTRAINT retention_runs_month CHECK (EXTRACT(DAY FROM month) = 1);
ALTER TABLE ops.retention_runs ADD CONSTRAINT retention_runs_finished CHECK ((status = 'running') = (finished_at IS NULL));
ALTER TABLE ops.retention_runs ADD CONSTRAINT retention_runs_error CHECK ((status = 'failed') = (error IS NOT NULL));
ALTER TABLE ops.retention_runs ADD CONSTRAINT retention_runs_alerted CHECK (alerted_at IS NULL OR status = 'failed');
-- At most one run at a time: a second run's insert fails on this index (a stale one is closed first, by the job).
CREATE UNIQUE INDEX retention_runs_one_running ON ops.retention_runs ((true)) WHERE status = 'running';
CREATE INDEX retention_runs_month_started ON ops.retention_runs (month, started_at);

-- ---- erasures (scripts/uid-erase.ts): who, when, under which ticket, how many rows; never a uid, a sub or an address ----

CREATE TABLE ops.erasures (
  id        bigserial   PRIMARY KEY,
  at        timestamptz NOT NULL DEFAULT now(),
  ticket    text        NOT NULL CHECK (length(ticket) BETWEEN 1 AND 128),
  operator  text        NOT NULL CHECK (length(operator) BETWEEN 1 AND 128),
  scope_id  text        NOT NULL CHECK (length(scope_id) BETWEEN 1 AND 64),
  rows      jsonb       NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(rows) = 'object')
);
CREATE INDEX erasures_at ON ops.erasures (at);

-- Append-only, as the other audit logs (D90): no row changes, and a row may be deleted only once it is 60 months old
-- (by ops.purge_expired). A trigger, so it holds for the owner too.
CREATE FUNCTION ops.erasures_append_only() RETURNS trigger
LANGUAGE plpgsql SET search_path = ops, pg_temp AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD.at < now() - interval '60 months' THEN RETURN OLD; END IF;
  END IF;
  RAISE EXCEPTION 'ops.erasures rows are kept 60 months and never changed (D90)' USING ERRCODE = '42501';
END
$$;
CREATE TRIGGER erasures_append_only BEFORE UPDATE OR DELETE ON ops.erasures FOR EACH ROW EXECUTE FUNCTION ops.erasures_append_only();
CREATE TRIGGER erasures_no_truncate BEFORE TRUNCATE ON ops.erasures FOR EACH STATEMENT EXECUTE FUNCTION ops.erasures_append_only();

-- ---- indexes the uid purges read ----

-- Events that still carry a uid: strip_uids reads the oldest of them, erase_uid one uid's (and C15's lookup by uid).
CREATE INDEX events_uid_at ON usage.events (uid, at) WHERE uid IS NOT NULL;
CREATE INDEX app_users_uid ON usage.app_users (uid);
CREATE INDEX app_users_last_seen ON usage.app_users (last_seen);

-- ---- the D90 periods, in one place ----

-- The first instant whose month is still kept raw (uids): the start of the UTC month 24 months before the current one's
-- start. Events before it are in months that ended more than 24 months ago.
CREATE FUNCTION usage.uid_cutoff() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT date_trunc('month', now() - interval '24 months')
$$;

-- The 7-year bound: a month whose end (its partition's upper bound) is at or before it is more than 7 years old.
CREATE FUNCTION usage.records_cutoff() RETURNS timestamptz
LANGUAGE sql STABLE SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT date_trunc('month', now() - interval '7 years')
$$;

-- ---- raw usage: 24 months ----

CREATE FUNCTION usage.strip_uids(max_rows integer DEFAULT 10000)
RETURNS TABLE (events bigint, app_users bigint, more boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  cutoff  timestamptz := usage.uid_cutoff();
  seen    date := (now()::date - interval '24 months')::date;
  n_ev    bigint;
  n_users bigint;
BEGIN
  IF max_rows IS NULL OR max_rows < 1 OR max_rows > 100000 THEN RAISE EXCEPTION 'strip_uids: max_rows 1..100000' USING ERRCODE = '22023'; END IF;
  UPDATE usage.events e SET uid = NULL
    FROM (SELECT x.request_id, x.at FROM usage.events x WHERE x.uid IS NOT NULL AND x.at < cutoff ORDER BY x.at LIMIT max_rows) s
   WHERE e.request_id = s.request_id AND e.at = s.at AND e.at < cutoff;
  GET DIAGNOSTICS n_ev = ROW_COUNT;
  DELETE FROM usage.app_users u
   USING (SELECT y.app_id, y.uid FROM usage.app_users y WHERE y.last_seen < seen ORDER BY y.last_seen LIMIT max_rows) s
   WHERE u.app_id = s.app_id AND u.uid = s.uid;
  GET DIAGNOSTICS n_users = ROW_COUNT;
  RETURN QUERY SELECT n_ev, n_users,
    EXISTS (SELECT 1 FROM usage.events x WHERE x.uid IS NOT NULL AND x.at < cutoff)
    OR EXISTS (SELECT 1 FROM usage.app_users y WHERE y.last_seen < seen);
END
$$;

-- ---- settlement records: 7 years, whole months ----

-- Drops each `usage.events_YYYY_MM` partition whose month ended at or before records_cutoff() (detached first, so the
-- parent never scans a half-dropped table), then deletes the rows of those months elsewhere. The lock timeout keeps the
-- detach from queueing the writer's inserts behind a long report: it fails instead, and the job retries.
CREATE FUNCTION usage.drop_expired_partitions()
RETURNS TABLE (partitions integer, settlements bigint, identity_tokens bigint, email_counts bigint, settlement_alerts bigint, settlement_tries bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' SET lock_timeout = '5s' AS $$
DECLARE
  cutoff timestamptz := usage.records_cutoff();
  part   record;
  m      date;
  n_part integer := 0;
  n_set  bigint;
  n_idt  bigint;
  n_eml  bigint;
  n_alr  bigint;
  n_try  bigint;
BEGIN
  FOR part IN
    SELECT c.relname FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = 'usage.events'::regclass AND c.relname ~ '^events_[0-9]{4}_(0[1-9]|1[0-2])$'
     ORDER BY c.relname
  LOOP
    m := to_date(substr(part.relname, 8), 'YYYY_MM');
    EXIT WHEN (m + interval '1 month') > cutoff;
    EXECUTE format('ALTER TABLE usage.events DETACH PARTITION usage.%I', part.relname);
    EXECUTE format('DROP TABLE usage.%I', part.relname);
    n_part := n_part + 1;
  END LOOP;
  DELETE FROM usage.gas_settlements WHERE at < cutoff;
  GET DIAGNOSTICS n_set = ROW_COUNT;
  DELETE FROM usage.identity_tokens WHERE day < cutoff::date;
  GET DIAGNOSTICS n_idt = ROW_COUNT;
  DELETE FROM usage.email_counts WHERE day < cutoff::date;
  GET DIAGNOSTICS n_eml = ROW_COUNT;
  DELETE FROM ops.settlement_alerts WHERE at < cutoff;
  GET DIAGNOSTICS n_alr = ROW_COUNT;
  DELETE FROM ops.settlement_tries WHERE at < cutoff;
  GET DIAGNOSTICS n_try = ROW_COUNT;
  RETURN QUERY SELECT n_part, n_set, n_idt, n_eml, n_alr, n_try;
END
$$;

-- ---- an app deleted more than 30 days ago (the admin job lists them with AdminRpc.deletedApps) ----

CREATE FUNCTION usage.purge_app_users(app text) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp AS $$
DECLARE
  n bigint;
BEGIN
  IF app IS NULL OR length(app) NOT BETWEEN 1 AND 64 THEN RAISE EXCEPTION 'purge_app_users: an app id' USING ERRCODE = '22023'; END IF;
  DELETE FROM usage.app_users WHERE app_id = app;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$$;

-- ---- an erasure request (scripts/uid-erase.ts) ----

-- A uid is an HMAC over the scope and one identity (D96), so it names one user of one scope: every row carrying it is
-- that user's, in whichever app (deleted and moved apps included).
CREATE FUNCTION usage.erase_uid(p_uid bytea)
RETURNS TABLE (app_users bigint, events bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp AS $$
DECLARE
  n_users bigint;
  n_ev    bigint;
BEGIN
  IF p_uid IS NULL OR octet_length(p_uid) <> 16 THEN RAISE EXCEPTION 'erase_uid: a 16-byte uid' USING ERRCODE = '22023'; END IF;
  DELETE FROM usage.app_users u WHERE u.uid = p_uid;
  GET DIAGNOSTICS n_users = ROW_COUNT;
  UPDATE usage.events e SET uid = NULL WHERE e.uid = p_uid;
  GET DIAGNOSTICS n_ev = ROW_COUNT;
  RETURN QUERY SELECT n_users, n_ev;
END
$$;

-- ---- what waits for a person (D90: statements, rates and their files are deleted by hand after review) ----

CREATE FUNCTION usage.retention_due()
RETURNS TABLE (statements bigint, rates bigint, rate_overrides bigint, oldest_statement text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
  SELECT (SELECT count(*) FROM usage.statements s WHERE (s.month + interval '1 month') <= usage.records_cutoff()),
         (SELECT count(*) FROM usage.near_usd_rates r WHERE (r.day + 1) <= usage.records_cutoff()::date),
         (SELECT count(*) FROM usage.rate_overrides o WHERE (o.day + 1) <= usage.records_cutoff()::date),
         (SELECT to_char(min(s.month), 'YYYY-MM') FROM usage.statements s WHERE (s.month + interval '1 month') <= usage.records_cutoff())
$$;

-- ---- the admin Worker's own state ----

CREATE FUNCTION ops.purge_expired()
RETURNS TABLE (nonce_checks bigint, rejection_alerts bigint, scope_watch bigint, retention_runs bigint, erasures bigint)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  n_nonce bigint;
  n_rej   bigint;
  n_watch bigint;
  n_runs  bigint;
  n_era   bigint;
BEGIN
  DELETE FROM ops.nonce_checks WHERE checked_at < now() - interval '400 days';
  GET DIAGNOSTICS n_nonce = ROW_COUNT;
  DELETE FROM ops.rejection_alerts WHERE day < (now() - interval '400 days')::date;
  GET DIAGNOSTICS n_rej = ROW_COUNT;
  -- A watched on-chain change notified 400 days ago is long settled; a row still pending is never removed.
  DELETE FROM ops.scope_watch WHERE notified_at IS NOT NULL AND notified_at < now() - interval '400 days';
  GET DIAGNOSTICS n_watch = ROW_COUNT;
  DELETE FROM ops.retention_runs WHERE status <> 'running' AND started_at < now() - interval '60 months';
  GET DIAGNOSTICS n_runs = ROW_COUNT;
  DELETE FROM ops.erasures WHERE at < now() - interval '60 months';
  GET DIAGNOSTICS n_era = ROW_COUNT;
  RETURN QUERY SELECT n_nonce, n_rej, n_watch, n_runs, n_era;
END
$$;

-- ---- privileges ----

REVOKE EXECUTE ON FUNCTION usage.uid_cutoff(), usage.records_cutoff(), usage.strip_uids(integer), usage.drop_expired_partitions(),
  usage.purge_app_users(text), usage.erase_uid(bytea), usage.retention_due(), ops.purge_expired(), ops.erasures_append_only() FROM PUBLIC;
REVOKE ALL ON ops.erasures FROM PUBLIC;
REVOKE ALL ON SEQUENCE ops.erasures_id_seq FROM PUBLIC;

GRANT EXECUTE ON FUNCTION usage.strip_uids(integer), usage.drop_expired_partitions(), usage.purge_app_users(text),
  usage.erase_uid(bytea), usage.retention_due(), ops.purge_expired() TO usage_admin;
-- The erasure record: written once by the script, read by the retention screen; never changed by the role.
GRANT SELECT, INSERT ON ops.erasures TO usage_admin;
GRANT USAGE ON SEQUENCE ops.erasures_id_seq TO usage_admin;
