-- Usage ledger, batch C4: identity tokens minted per app and UTC day (docs/batch-c-build-plan.md "Conventions": the
-- ledger counts `identity_tokens` per app and day). The API's hot DB keeps the live count (`identity_usage`, hot-DB
-- migration 0008, D172); the API's hourly cron copies the last 7 days of it here (apps/api/src/usage/identity-sync.ts)
-- through `usage.record_identity_tokens`, the writer's only other function. No user data: counts per app and day.
--
-- A copy is a snapshot of a count that only grows, so the upsert keeps the larger value: a replay, a late run or two
-- runs at once never lower a day's count. `org_id` and `scope_id` are the app's when the day was first copied (as
-- events keep the org of the time). The report functions (batch C12) read it; retention follows D90 there (C13).

CREATE TABLE usage.identity_tokens (
  app_id    text        NOT NULL,
  day       date        NOT NULL,
  org_id    text        NOT NULL,
  scope_id  text        NOT NULL,
  tokens    bigint      NOT NULL CHECK (tokens >= 0),
  copied_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, day)
);
CREATE INDEX identity_tokens_org_day ON usage.identity_tokens (org_id, day);

-- Rows: a JSON array of {app_id, day 'YYYY-MM-DD', org_id, scope_id, tokens} (at most 1000, each app and day once).
-- Validates every row before writing any (all or nothing), then upserts with GREATEST. Returns the rows received.
CREATE FUNCTION usage.record_identity_tokens(rows jsonb) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = usage, pg_temp SET timezone = 'UTC' AS $$
DECLARE
  r      jsonb;
  k      text;
  n      integer;
  d      date;
  seen   text[] := ARRAY[]::text[];
  allowed constant text[] := ARRAY['app_id', 'day', 'org_id', 'scope_id', 'tokens'];
BEGIN
  IF rows IS NULL OR jsonb_typeof(rows) <> 'array' THEN PERFORM usage.event_invalid('identity rows: not an array'); END IF;
  n := jsonb_array_length(rows);
  IF n > 1000 THEN PERFORM usage.event_invalid('identity rows: more than 1000'); END IF;
  FOR r IN SELECT value FROM jsonb_array_elements(rows) LOOP
    IF jsonb_typeof(r) <> 'object' THEN PERFORM usage.event_invalid('identity row: not an object'); END IF;
    FOR k IN SELECT jsonb_object_keys(r) LOOP
      IF NOT (k = ANY (allowed)) THEN PERFORM usage.event_invalid('identity row: unknown field ' || k); END IF;
    END LOOP;
    FOREACH k IN ARRAY ARRAY['app_id', 'org_id', 'scope_id'] LOOP
      IF jsonb_typeof(r -> k) IS DISTINCT FROM 'string' OR length(r ->> k) NOT BETWEEN 1 AND 64 THEN PERFORM usage.event_invalid('identity row: ' || k); END IF;
    END LOOP;
    IF jsonb_typeof(r -> 'day') IS DISTINCT FROM 'string' OR (r ->> 'day') !~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' THEN PERFORM usage.event_invalid('identity row: day'); END IF;
    BEGIN
      d := (r ->> 'day')::date;   -- an impossible date (2026-02-30) fails the cast
    EXCEPTION WHEN others THEN
      PERFORM usage.event_invalid('identity row: day');
    END;
    IF (CASE WHEN jsonb_typeof(r -> 'tokens') IS DISTINCT FROM 'number' OR (r ->> 'tokens') !~ '^(0|[1-9][0-9]{0,14})$' THEN true ELSE false END) THEN PERFORM usage.event_invalid('identity row: tokens'); END IF;
    IF (r ->> 'app_id') || ' ' || (r ->> 'day') = ANY (seen) THEN PERFORM usage.event_invalid('identity rows: an app and day twice'); END IF;
    seen := seen || ((r ->> 'app_id') || ' ' || (r ->> 'day'));
  END LOOP;

  INSERT INTO usage.identity_tokens AS t (app_id, day, org_id, scope_id, tokens)
  SELECT x ->> 'app_id', (x ->> 'day')::date, x ->> 'org_id', x ->> 'scope_id', (x ->> 'tokens')::bigint
    FROM jsonb_array_elements(rows) AS x
  ON CONFLICT (app_id, day) DO UPDATE
    SET tokens = GREATEST(t.tokens, EXCLUDED.tokens),
        copied_at = CASE WHEN EXCLUDED.tokens > t.tokens THEN now() ELSE t.copied_at END;
  RETURN n;
END
$$;

-- Postgres lets PUBLIC execute every new function; this one is the writer's only.
REVOKE EXECUTE ON FUNCTION usage.record_identity_tokens(jsonb) FROM PUBLIC;
REVOKE ALL ON usage.identity_tokens FROM PUBLIC;
GRANT EXECUTE ON FUNCTION usage.record_identity_tokens(jsonb) TO usage_writer;
GRANT SELECT ON usage.identity_tokens TO usage_admin;
