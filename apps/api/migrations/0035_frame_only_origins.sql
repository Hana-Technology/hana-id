-- D934 (piece P12 of docs/partner-platform-spec.md, A13; D923, D926): a web address an app may use only inside a frame,
-- for a network's widget served from its own web address inside its partners' pages. Additive: one column on
-- `app_origins`, three triggers on it, and one index on `app_changes` (`app_changes_kind_app`: the hourly drift check
-- reads only the origin ledger kinds through it, once a run, instead of scanning the ledger). No column is added to
-- `guarded_changes` or `app_changes` (`ledger-check` holds the ledger tables' shape, D929; an index isn't shape), no
-- table is rebuilt, no other index, trigger or view is touched (0035's test compares every one by `sqlite_schema`) and
-- no existing row changes: every row reads `frame_only = 0`, today's behaviour. Applied by the
-- Tech Lead on a deployed env before the API that reads it (docs/operations.md "Frame-only web addresses (hot-DB
-- migration 0035, D934)"); the API's login-path read names the column, so the API needs it first.
--
-- `frame_only` = 1: the vault (packages/web/src/vault/vault.ts `frameRule`) takes this web address as its parent only
-- when the page at the top of the browser window is another of the app's web addresses that is not frame-only, never
-- when this one is the top-level page; every page around the vault must still be one of the app's web addresses (the
-- vault page's `frame-ancestors`, and `location.ancestorOrigins` where the browser has it, as before). Set with the
-- web address's own proposal (a member's, staff's or the platform's, each guarded as any add), or later at once by an
-- owner or staff (`origin.frame_only`, a tightening). Never cleared in place: a web address becomes usable anywhere
-- only by being removed and proposed again (a new add, with its announcement, wait, cancel link, owner's
-- confirmation and four eyes, unchanged). The triggers below hold, against bare D1 writes, exactly this: no update of
-- the flag from 1 to 0; no insert (a REPLACE, an upsert) of a usable-anywhere row over a frame-only one; and no change
-- of a row's `origin` or `app_id` at all (no code renames a row; an `UPDATE OR REPLACE` that renamed another row onto
-- a frame-only one would replace it unseen by the first two). What a trigger can't tell apart: a bare writer deleting
-- a frame-only row and inserting it again as usable anywhere is, at this level, a removal and a new add; the API's
-- hourly drift check (`apps/api/src/changes/drift.ts`) reports a row reading 0 whose ledger says frame-only (its
-- proposal marked its change id, or an `origin.frame_only` row named its web address with its change id and no removal
-- since). Never for the
-- `http://localhost:*` wildcard (a pattern, never a page's address).
--
-- A FUTURE REBUILD of `app_origins` must create these triggers again, with the same SQL: app_origins_frame_only_kept,
-- app_origins_frame_only_no_replace, app_origins_fixed (and 0033's and 0034's, as 0034's header lists them); a rebuild
-- of `app_changes` must create `app_changes_kind_app` again. apps/api/test/migration-0035.test.ts
-- checks every one is in the schema after every later migration.
--
-- Nothing here changes a key, a path or an address: the flag only decides which pages may use an app's vault.

ALTER TABLE app_origins ADD COLUMN frame_only INTEGER NOT NULL DEFAULT 0 CHECK (frame_only IN (0, 1) AND (frame_only = 0 OR origin <> 'http://localhost:*'));

-- A frame-only web address is never made usable anywhere in place (remove it, and propose it again).
CREATE TRIGGER app_origins_frame_only_kept BEFORE UPDATE OF frame_only ON app_origins
  WHEN OLD.frame_only = 1 AND NEW.frame_only IS NOT 1
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a frame-only web address becomes usable anywhere only by being removed and proposed again');
END;

-- Nor replaced (INSERT OR REPLACE, REPLACE, an upsert's insert) by a usable-anywhere row: the trigger runs before the
-- conflict is resolved.
CREATE TRIGGER app_origins_frame_only_no_replace BEFORE INSERT ON app_origins
  WHEN NEW.frame_only IS NOT 1
   AND EXISTS (SELECT 1 FROM app_origins WHERE app_id = NEW.app_id AND origin = NEW.origin AND frame_only = 1)
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a frame-only web address becomes usable anywhere only by being removed and proposed again');
END;

-- A row is never moved to another web address or app (removals delete it, adds insert one).
CREATE TRIGGER app_origins_fixed BEFORE UPDATE OF origin, app_id ON app_origins
  WHEN NEW.origin IS NOT OLD.origin OR NEW.app_id IS NOT OLD.app_id
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a row keeps its web address and app (remove it and add another)');
END;

-- The drift check's read of the origin ledger kinds (`origin.proposed`, `app.created`, `origin.frame_only`,
-- `origin.removed`), by kind, without a scan of the whole ledger.
CREATE INDEX app_changes_kind_app ON app_changes (kind, app_id, seq);
