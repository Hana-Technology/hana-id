-- D915: shared-scope rules (docs/partner-platform-spec.md piece P0, finding H3). Additive: two new columns with
-- defaults that keep every existing row as it was, and six triggers. `scopes_app_user_ids_no_policy` reads
-- `guarded_changes`: migration 0027 (the ledger rebuild, piece P1) drops it before it drops that table and creates it
-- again, word for word, after the rename (D915). Applied by the Tech Lead on a deployed env,
-- before the API that reads the columns (the API selects both in every app read).
--
-- `scopes.app_user_ids`: Journear staff mark a scope whose one wallet is shared by several partners' apps
-- (`AdminRpc.setScopeAppUserIds`). One way: once on it stays on. While it is on, no app of the scope may have an
-- auto-approve policy (the API, the console and the admin CLI refuse one; the hourly drift check flags one found
-- there). Piece P6 will also give new apps on such a scope their own User IDs; nothing reads the flag for that yet.
-- `apps.created_by_kind`: who created the app: Journear staff (`hana`, every app until the platform API exists) or a
-- network's backend through the platform API (`platform`, piece P4). Fixed at creation. A platform-created app never
-- gets an auto-approve policy either.
--
-- Nothing here changes a key, a path or an address: the columns are off-chain settings. Times are integer ms UTC.

ALTER TABLE scopes ADD COLUMN app_user_ids INTEGER NOT NULL DEFAULT 0 CHECK (app_user_ids IN (0, 1));
ALTER TABLE apps ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'hana' CHECK (created_by_kind IN ('hana', 'platform'));

-- The flag is one way.
CREATE TRIGGER scopes_app_user_ids_one_way BEFORE UPDATE OF app_user_ids ON scopes
WHEN OLD.app_user_ids = 1 AND NEW.app_user_ids IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'scopes: app_user_ids is one way');
END;

-- The flag can't be set while any app of the scope (a deleted one aside: it serves nothing and can't come back) has an
-- auto-approve policy in force, waiting in the app's columns, or proposed (an open policy_set change). The API checks
-- the same first and answers it in words; this is the backstop.
CREATE TRIGGER scopes_app_user_ids_no_policy BEFORE UPDATE OF app_user_ids ON scopes
WHEN OLD.app_user_ids = 0 AND NEW.app_user_ids = 1
BEGIN
  SELECT RAISE(ABORT, 'scopes: an app of this scope has an auto-approve policy in force or waiting')
   WHERE EXISTS (SELECT 1 FROM apps a WHERE a.scope_id = NEW.scope_id AND a.deleted_at IS NULL
                  AND (a.auto_approve_policy IS NOT NULL OR a.auto_approve_pending IS NOT NULL
                       OR EXISTS (SELECT 1 FROM guarded_changes g WHERE g.app_id = a.id AND g.kind = 'policy_set' AND g.status IN ('pending', 'active'))));
END;

-- Only a test scope can be marked, for now (D915 after PR 145's review): a live shared scope needs its own security
-- review first (the Tech Lead's answer to the spec's N2).
CREATE TRIGGER scopes_app_user_ids_test_only BEFORE UPDATE OF app_user_ids ON scopes
WHEN OLD.app_user_ids = 0 AND NEW.app_user_ids = 1 AND NEW.environment IS NOT 'test'
BEGIN
  SELECT RAISE(ABORT, 'scopes: only a test scope can be marked as shared');
END;

-- An insert can't mark a live scope either, nor undo a mark by replacing the row (INSERT OR REPLACE, or an upsert:
-- this trigger runs before the conflict is resolved, so it still sees the marked row).
CREATE TRIGGER scopes_app_user_ids_insert BEFORE INSERT ON scopes
BEGIN
  SELECT RAISE(ABORT, 'scopes: only a test scope can be marked as shared')
   WHERE NEW.app_user_ids = 1 AND NEW.environment IS NOT 'test';
  SELECT RAISE(ABORT, 'scopes: app_user_ids is one way')
   WHERE NEW.app_user_ids IS NOT 1 AND EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id AND app_user_ids = 1);
END;

-- Nor by deleting the row and inserting it again: a marked scope is never deleted (no code deletes scope rows).
CREATE TRIGGER scopes_app_user_ids_no_delete BEFORE DELETE ON scopes
WHEN OLD.app_user_ids = 1
BEGIN
  SELECT RAISE(ABORT, 'scopes: a scope marked as shared is never deleted');
END;

-- Who created an app never changes.
CREATE TRIGGER apps_created_by_kind_fixed BEFORE UPDATE OF created_by_kind ON apps
WHEN NEW.created_by_kind IS NOT OLD.created_by_kind
BEGIN
  SELECT RAISE(ABORT, 'apps: created_by_kind is fixed');
END;
