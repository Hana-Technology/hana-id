-- Usage ledger, email login build plan batch 6: email logins and new links per app and UTC day (docs/email-login-spec.md
-- "API changes": "Usage counts email logins and links per app"). As the identity token's counts (0002, D223): the API's
-- hot DB keeps the live counts (`email_usage`, hot-DB migration 0010, D233); the API's hourly cron copies the last 7 days
-- here (apps/api/src/usage/email-sync.ts) through `usage.record_email_counts`. Every /v1/login and /v1/sessions request
-- is already one usage event (0001); this table only says how many of them were email logins and how many made a link.
-- No user data: counts per app and day.
--
-- A copy is a snapshot of counts that only grow, so the upsert keeps the larger value of each: a replay, a late run or
-- two runs at once never lower a day's count. `org_id` and `scope_id` are the app's when the day was first copied.

CREATE TABLE usage.email_counts (
  app_id         text        NOT NULL,
  day            date        NOT NULL,
  org_id         text        NOT NULL,
  scope_id       text        NOT NULL,
  email_sessions bigint      NOT NULL CHECK (email_sessions >= 0),
  links          bigint      NOT NULL CHECK (links >= 0),
  copied_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, day)
);
CREATE INDEX email_counts_org_day ON usage.email_counts (org_id, day);

-- Rows: a JSON array of {app_id, day 'YYYY-MM-DD', org_id, scope_id, email_sessions, links} (at most 1000, each app and
-- day once). Validates every row before writing any (all or nothing), then upserts with GREATEST. Returns the rows.
CREATE FUNCTION usage.record_email_counts(rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  r      jsonb;
  k      text;
  n      integer;
  d      date;
  seen   text[] := ARRAY[]::text[];
  allowed constant text[] := ARRAY['app_id', 'day', 'org_id', 'scope_id', 'email_sessions', 'links'];
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN PERFORM usage.event_invalid('email rows: not an array'); END IF;
  n := jsonb_array_length(rows);
  IF n > 1000 THEN PERFORM usage.event_invalid('email rows: more than 1000'); END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF jsonb_typeof(r) <> 'object' THEN PERFORM usage.event_invalid('email row: not an object'); END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT (k = ANY (allowed)) THEN PERFORM usage.event_invalid('email row: unknown field ' || k); END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['app_id', 'org_id', 'scope_id'] LOOP
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR length(r ->> k) NOT BETWEEN 1 AND 64 THEN PERFORM usage.event_invalid('email row: ' || k); END IF;
    END LOOP;
    IF jsonb_typeof(r -> 'day') IS DISTINCT FROM 'string' OR (r ->> 'day') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN PERFORM usage.event_invalid('email row: day'); END IF;
    BEGIN
      d := (r ->> 'day')::date;   -- an impossible date (2026-02-30) fails the cast
    EXCEPTION WHEN others THEN
      PERFORM usage.event_invalid('email row: day');
    END;
    FOREACH k IN ARRAY ARRAY['email_sessions', 'links'] LOOP
      IF (CASE WHEN jsonb_typeof(r -> k) IS DISTINCT FROM 'number' OR (r ->> k) !~ '^(0|[1-9][0-9]{0,14})$' THEN true ELSE false END) THEN PERFORM usage.event_invalid('email row: ' || k); END IF;
    END LOOP;
    IF (r ->> 'app_id') || ' ' || (r ->> 'day') = ANY (seen) THEN PERFORM usage.event_invalid('email rows: an app and day twice'); END IF;
    seen := seen || ((r ->> 'app_id') || ' ' || (r ->> 'day'));
  END LOOP;

  INSERT INTO usage.email_counts AS t (app_id, day, org_id, scope_id, email_sessions, links)
  SELECT x ->> 'app_id', (x ->> 'day')::date, x ->> 'org_id', x ->> 'scope_id', (x ->> 'email_sessions')::bigint, (x ->> 'links')::bigint
    FROM jsonb_array_elements(rows) AS x
  ON CONFLICT (app_id, day) DO UPDATE
    SET email_sessions = GREATEST(t.email_sessions, EXCLUDED.email_sessions),
        links = GREATEST(t.links, EXCLUDED.links),
        copied_at = CASE WHEN EXCLUDED.email_sessions > t.email_sessions OR EXCLUDED.links > t.links THEN now() ELSE t.copied_at END;
  RETURN n;
END
$$;

-- Postgres lets PUBLIC execute every new function; this one is the writer's only.
REVOKE EXECUTE ON FUNCTION usage.record_email_counts(jsonb) FROM PUBLIC;
REVOKE ALL ON usage.email_counts FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.record_email_counts(jsonb) TO usage_writer;
GRANT SELECT ON usage.email_counts TO usage_admin;
