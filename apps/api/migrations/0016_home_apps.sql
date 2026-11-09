-- Hana Home's app list (batch H2, docs/hana-home-build-plan.md, D462, D466, D500-D503). Expand only: a new table and a
-- new column with a default, so every existing row reads as it did. Applied before the API that reads them (D1 first).
--
-- `home_quiet`, the quieter listing (D98 item 8, D502): an Enterprise partner's scope that Home's list leaves out, but
-- which a full-name search, its own scope or app id (the partner's link) and its own users still reach. Set by staff
-- (`admin home:listing`), never by a partner.
ALTER TABLE scopes ADD COLUMN home_quiet INTEGER NOT NULL DEFAULT 0 CHECK (home_quiet IN (0, 1));

-- The list's page order on a live env: only the scopes the page reads (`first_session_at` set, not quiet), so a page
-- doesn't scan what it filters out.
CREATE INDEX scopes_home_listed ON scopes (environment, scope_id) WHERE first_session_at IS NOT NULL AND home_quiet = 0;

-- The Google clients Hana holds for a scope (D42's Enterprise tier, D98 item 3), written by `admin home:client:add` at
-- Enterprise onboarding. It only says whose project a client is in: the chain still decides whether the client belongs
-- to the scope, and a row for a client the scope no longer lists changes nothing (home/coverage.ts). Public values: a
-- client id is in every partner page that uses it. Never a secret, a user or a key.
CREATE TABLE hana_held_clients (
  provider TEXT NOT NULL,
  aud      TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  added_at INTEGER NOT NULL CHECK (added_at >= 0),
  PRIMARY KEY (provider, aud)
);
CREATE INDEX hana_held_clients_scope ON hana_held_clients (scope_id);
