-- D919: per-app User IDs on a shared scope (docs/partner-platform-spec.md piece P6, B3, B7; finding M8). Additive: one
-- new column with a default that keeps every existing app exactly as it was, one new table, four triggers on `apps`
-- and one on the new table. No table is rebuilt and no existing trigger or view is touched (0030's test compares them
-- all by `sqlite_schema`). It reads only 0026's `scopes.app_user_ids`, so it doesn't depend on 0028 or 0029 and applies
-- in name order after them either way. Applied by the Tech Lead on a deployed env before the API that reads it (the
-- API selects `apps.user_ids` in every app read), as `docs/operations.md` says.
--
-- `apps.user_ids`: which User ID (the identity token's `sub`, and the Support ID shown with the session) the app gives
-- its users. 'scope': the person's scope-level User ID, the same on every app of the scope: every app that exists
-- today, and every app created on a scope not marked as shared. 'app': a User ID of the app's own (core identity.ts
-- `appSub`), for an app created on a scope marked as shared (`scopes.app_user_ids` = 1). Written once, at creation,
-- from the scope's mark (`INSERT … SELECT`); never changed after.
--
-- Nothing here changes a key, a path or an address: wallets are derived from the on-chain path (scope, provider, the
-- login's own sub, key index), which no part of this reads or writes. Times are integer ms UTC.

ALTER TABLE apps ADD COLUMN user_ids TEXT NOT NULL DEFAULT 'scope' CHECK (user_ids IN ('scope', 'app'));

-- Fixed once written: a change would change every one of that app's users' IDs.
CREATE TRIGGER apps_user_ids_fixed BEFORE UPDATE OF user_ids ON apps
WHEN NEW.user_ids IS NOT OLD.user_ids
BEGIN
  SELECT RAISE(ABORT, 'apps: user_ids is fixed');
END;

-- An app with its own User IDs keeps its scope: the scope is one of the derivation's inputs. Any mode but 'scope'
-- counts as 'app' here (fail closed).
CREATE TRIGGER apps_app_ids_scope_fixed BEFORE UPDATE OF scope_id ON apps
WHEN OLD.user_ids IS NOT 'scope' AND NEW.scope_id IS NOT OLD.scope_id
BEGIN
  SELECT RAISE(ABORT, 'apps: an app with its own user ids keeps its scope');
END;

-- At creation the mode follows the scope's mark at that moment: 'app' on a marked scope, 'scope' on any other. A
-- missing scope row or a mark that is neither 0 nor 1 matches nothing, so the insert is refused (fail closed). An
-- insert that would replace an existing row (INSERT OR REPLACE, an upsert) can't carry another mode for that id: this
-- runs before the conflict is resolved, so it still sees the old row.
CREATE TRIGGER apps_user_ids_insert BEFORE INSERT ON apps
BEGIN
  SELECT RAISE(ABORT, 'apps: user_ids must follow the scope''s mark (''app'' on a shared scope, ''scope'' otherwise)')
   WHERE NEW.user_ids IS NOT (SELECT CASE s.app_user_ids WHEN 1 THEN 'app' WHEN 0 THEN 'scope' END FROM scopes s WHERE s.scope_id = NEW.scope_id);
  SELECT RAISE(ABORT, 'apps: user_ids is fixed')
   WHERE EXISTS (SELECT 1 FROM apps WHERE id = NEW.id AND user_ids IS NOT NEW.user_ids);
END;

-- Which apps of a marked scope a person signed in on, and that app's User ID and Support ID (B6; the linking view of
-- piece P7 reads it, and the erase script resolves a per-app ID through it). Written by the directory's write after a
-- login (`/v1/login`, `/v1/wallets/record`) for an app on a marked scope only; nothing is backfilled. Personal data, as
-- the directory: purged with the person when the scope's directory is purged, and 30 days after the app's deletion.
CREATE TABLE end_user_apps (
  user_id       TEXT NOT NULL REFERENCES end_users (user_id) ON DELETE CASCADE, -- the person's internal id (`hu_…`)
  app_id        TEXT NOT NULL,
  app_sub       TEXT NOT NULL CHECK (app_sub GLOB 'u1_*' AND length(app_sub) = 25), -- the User ID this app gives them
  support_code  TEXT NOT NULL CHECK (length(support_code) = 8 AND support_code NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'),
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id)
);
CREATE INDEX end_user_apps_app ON end_user_apps (app_id);
CREATE INDEX end_user_apps_sub ON end_user_apps (app_sub);
CREATE INDEX end_user_apps_support ON end_user_apps (support_code);

-- A row names an app of the person's own scope, and that scope is marked as shared: no other row is ever written.
CREATE TRIGGER end_user_apps_insert BEFORE INSERT ON end_user_apps
BEGIN
  SELECT RAISE(ABORT, 'end_user_apps: the app is not on this person''s scope, or the scope is not marked as shared')
   WHERE NOT EXISTS (SELECT 1 FROM end_users u JOIN apps a ON a.scope_id = u.scope_id JOIN scopes s ON s.scope_id = a.scope_id
                      WHERE u.user_id = NEW.user_id AND a.id = NEW.app_id AND s.app_user_ids = 1);
END;
