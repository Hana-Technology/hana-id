-- D929: the platform API's app operations (piece P4 of docs/partner-platform-spec.md, A4, A7, A9, A15; findings H1,
-- H2, L3, L4, M7). Additive: two new tables (`platform_requests` with an index and three triggers,
-- `platform_origin_waits` with three), ten triggers on `guarded_changes` (no column: `ledger-check` holds that table's
-- shape, below), one new column on `apps` with two triggers, and two triggers on `app_origins`. No table is rebuilt
-- and no existing index, trigger or view is touched (0033's test compares every one by `sqlite_schema`); no existing
-- row changes. Applied by the Tech Lead on a deployed env before the API that writes it (docs/operations.md "Platform app
-- operations (hot-DB migration 0033, D929)"); nothing writes the platform's rows until an org's platform switch is on.
--
-- `platform_requests` (A9, L3): one row per platform write that committed, beside its ledger row, in the same batch:
-- which credential sent which method, path and body under an Idempotency-Key. For 7 days the API tells a retry (the
-- same key, method, path and body from the same credential: the first result again) from another call with that
-- Idempotency-Key (`idempotency_conflict`); after 7 days the ledger's request id (`pf_…`, unique for the ledger's 60
-- months) still answers `already_applied` or `conflict`. Never updated or replaced, never deleted within 7 days; the
-- admin Worker's monthly retention job purges older rows (AdminRpc.purgePlatformRequests).
--
-- `platform_origin_waits` (A4.5, A7, A15): the earliest time a web address the platform proposed may come into force,
-- held by the database itself (A7 puts it in `guarded_changes.unconfirmed_active_from`; a table of its own instead, as
-- `ledger-check` refuses a reshape of the ledger's tables). The proposal writes its wait once (`min_delay_ms`: the
-- greater of appChangeDelayMs and the platform minimum of 24 h; `local*` test envs keep their own delay, at least 60 s);
-- the announcement's ack writes `unconfirmed_active_from` once, at least that wait after it, by the database's clock
-- too; the change's `active_from` (and the matching `app_origins.active_from`) is never earlier, whoever writes it. No
-- waiver and no expedite for a platform proposal. Nothing brings one into force sooner: an owner's confirmation (piece
-- P10) will replace `guarded_changes_platform_not_early` and `app_origins_platform_not_early*` with versions that allow
-- `active_from` = the confirmation's time, and add the confirmation's own record and rules.
--
-- `apps.partner_bit_by` (A4.6, L4): who holds the partner suspension (bit 4): `platform` (the network's backend set
-- it and no member has taken it over), `member` (a member of the org, or staff, set it, or took it over), or NULL. NULL
-- with bit 4 set (every suspension written before 0033: only members and staff set bit 4 then) reads as a member's, so
-- the platform can't resume it (fail closed). Never set while bit 4 is clear.
--
-- A FUTURE REBUILD of `guarded_changes`, `app_origins`, `apps`, `platform_requests` or `platform_origin_waits` must
-- create every trigger below again, with the same SQL: platform_requests_insert, platform_requests_no_update,
-- platform_requests_no_early_delete, platform_origin_waits_insert, platform_origin_waits_update,
-- platform_origin_waits_no_delete, guarded_changes_platform_insert, guarded_changes_platform_fixed,
-- guarded_changes_platform_announced, guarded_changes_platform_not_early, guarded_changes_platform_no_waiver,
-- guarded_changes_platform_active_on_time, guarded_changes_platform_status_moves, guarded_changes_platform_no_delete,
-- guarded_changes_platform_wait_gone, guarded_changes_platform_no_replace_update, app_origins_platform_not_early,
-- app_origins_platform_not_early_update, apps_partner_bit_by, apps_platform_insert.
-- apps/api/test/migration-0033.test.ts checks every one is in the schema after every later migration.
--
-- The database's clock is `(julianday('now') - 2440587.5) * 86400000.0` (ms), as 0028's triggers read it: an
-- announcement may be at most 5 minutes behind it, and a date at most 2 minutes ahead of it (the Worker's and D1's
-- clocks agree within seconds). Nothing here changes a key, a path or an address. Times are integer ms UTC.

-- ---- platform_requests ----

CREATE TABLE platform_requests (
  org_id      TEXT NOT NULL CHECK (org_id GLOB 'org_*'),
  idem_hash   TEXT NOT NULL CHECK (length(idem_hash) = 64 AND idem_hash NOT GLOB '*[^0-9a-f]*'),   -- sha256(Idempotency-Key), hex
  key_id      TEXT NOT NULL CHECK (key_id GLOB 'pkc_*'),                                           -- the credential that sent it
  method      TEXT NOT NULL CHECK (method = 'POST'),
  path        TEXT NOT NULL CHECK (path GLOB '/v1/platform/*' AND length(path) <= 256),            -- as sent, ids included
  body_sha256 TEXT NOT NULL CHECK (length(body_sha256) = 64 AND body_sha256 NOT GLOB '*[^0-9a-f]*'),
  request_id  TEXT NOT NULL UNIQUE CHECK (request_id GLOB 'pf_*'),                                 -- the ledger row's
  at          INTEGER NOT NULL,
  PRIMARY KEY (org_id, idem_hash)
);
CREATE INDEX platform_requests_at ON platform_requests (at);

-- Written only beside its own ledger row (the same batch, the ledger row first), by the credential that row names; an
-- insert that would replace a row (INSERT OR REPLACE, an upsert) is refused before the conflict is resolved.
CREATE TRIGGER platform_requests_insert BEFORE INSERT ON platform_requests
BEGIN
  SELECT RAISE(ABORT, 'platform_requests: a recorded request is never replaced')
   WHERE EXISTS (SELECT 1 FROM platform_requests WHERE (org_id = NEW.org_id AND idem_hash = NEW.idem_hash) OR request_id = NEW.request_id);
  SELECT RAISE(ABORT, 'platform_requests: no ledger row of this credential has this request id')
   WHERE NOT EXISTS (SELECT 1 FROM app_changes WHERE request_id = NEW.request_id AND org_id = NEW.org_id AND actor_kind = 'platform' AND actor_id = NEW.key_id);
END;

CREATE TRIGGER platform_requests_no_update BEFORE UPDATE ON platform_requests
BEGIN
  SELECT RAISE(ABORT, 'platform_requests is append-only');
END;

CREATE TRIGGER platform_requests_no_early_delete BEFORE DELETE ON platform_requests
  WHEN OLD.at >= ((julianday('now') - 2440587.5) * 86400000.0) - 604800000
BEGIN
  SELECT RAISE(ABORT, 'platform_requests rows are kept 7 days');
END;

-- ---- a platform proposal's wait and earliest time (`platform_origin_waits`) ----
-- One row per web address the platform proposed, written in the proposal's batch before its guarded change, and its
-- earliest time written once by the announcement's ack before the change's `active_from`. In a table of its own, not
-- as columns of `guarded_changes`: `ledger-check` (the deploy step of migration 0027, D916, D924) refuses any later
-- migration that reshapes the ledger's tables, and 0033 may be applied in the same deploy as 0027.

CREATE TABLE platform_origin_waits (
  change_id               TEXT PRIMARY KEY CHECK (change_id GLOB 'gc_*'),
  app_id                  TEXT NOT NULL,
  origin                  TEXT NOT NULL,
  key_id                  TEXT NOT NULL CHECK (key_id GLOB 'pkc_*'),                  -- the proposing key
  min_delay_ms            INTEGER NOT NULL CHECK (min_delay_ms >= 60000),              -- its wait from the announcement
  unconfirmed_active_from INTEGER,                                                      -- written by the ack: not before
  at                      INTEGER NOT NULL
);

-- Never replaced; a wait for a change that exists already can't be written (it would be a wait the proposal didn't have).
CREATE TRIGGER platform_origin_waits_insert BEFORE INSERT ON platform_origin_waits
BEGIN
  SELECT RAISE(ABORT, 'platform_origin_waits: a wait is written once, before its proposal')
   WHERE EXISTS (SELECT 1 FROM platform_origin_waits WHERE change_id = NEW.change_id)
      OR EXISTS (SELECT 1 FROM guarded_changes WHERE id = NEW.change_id)
      OR NEW.unconfirmed_active_from IS NOT NULL;
END;

-- Only the earliest time is written, once, at least the wait from the database's now (less 2 minutes' skew).
CREATE TRIGGER platform_origin_waits_update BEFORE UPDATE ON platform_origin_waits
  WHEN NEW.change_id IS NOT OLD.change_id OR NEW.app_id IS NOT OLD.app_id OR NEW.origin IS NOT OLD.origin OR NEW.key_id IS NOT OLD.key_id
    OR NEW.min_delay_ms IS NOT OLD.min_delay_ms OR NEW.at IS NOT OLD.at
    OR OLD.unconfirmed_active_from IS NOT NULL OR NEW.unconfirmed_active_from IS NULL
    OR NEW.unconfirmed_active_from < ((julianday('now') - 2440587.5) * 86400000.0) + OLD.min_delay_ms - 120000
BEGIN
  SELECT RAISE(ABORT, 'platform_origin_waits: only the earliest time is written, once, at least the wait away');
END;

-- Kept while its proposal exists (it goes with it: guarded_changes_platform_wait_gone).
CREATE TRIGGER platform_origin_waits_no_delete BEFORE DELETE ON platform_origin_waits
  WHEN EXISTS (SELECT 1 FROM guarded_changes WHERE id = OLD.change_id)
BEGIN
  SELECT RAISE(ABORT, 'platform_origin_waits: a wait is kept while its proposal exists');
END;

-- ---- guarded_changes: a platform proposal never comes into force before its earliest time ----

-- A platform proposal starts as a waiting web address, nothing announced, with its wait already written for this
-- app, web address and key; an insert that would replace a platform proposal (by its id or its cancel link's hash) is
-- refused before the conflict is resolved.
CREATE TRIGGER guarded_changes_platform_insert BEFORE INSERT ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal starts as a waiting web address with its wait, not announced')
   WHERE NEW.proposed_by_kind = 'platform'
     AND (NEW.kind IS NOT 'origin_add' OR NEW.status IS NOT 'pending' OR NEW.notified_at IS NOT NULL OR NEW.active_from IS NOT NULL
          OR NEW.waiver IS NOT NULL OR NEW.expedited_by IS NOT NULL OR NEW.cancel_token_hash IS NOT NULL
          OR NOT EXISTS (SELECT 1 FROM platform_origin_waits w WHERE w.change_id = NEW.id AND w.app_id = NEW.app_id AND w.origin = NEW.origin
                          AND w.key_id = NEW.proposed_by AND w.unconfirmed_active_from IS NULL));
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal is never replaced')
   WHERE EXISTS (SELECT 1 FROM guarded_changes o WHERE o.proposed_by_kind = 'platform'
                  AND (o.id = NEW.id OR (NEW.cancel_token_hash IS NOT NULL AND o.cancel_token_hash = NEW.cancel_token_hash)));
END;

-- Its web address, app, proposer and request never change, and no other change becomes a platform one.
CREATE TRIGGER guarded_changes_platform_fixed BEFORE UPDATE OF id, app_id, kind, origin, proposed_by_kind, proposed_by, proposed_at, request_id ON guarded_changes
  WHEN (OLD.proposed_by_kind = 'platform' OR NEW.proposed_by_kind = 'platform')
   AND (NEW.id IS NOT OLD.id OR NEW.app_id IS NOT OLD.app_id OR NEW.kind IS NOT OLD.kind OR NEW.origin IS NOT OLD.origin
        OR NEW.proposed_by_kind IS NOT OLD.proposed_by_kind OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.proposed_at IS NOT OLD.proposed_at
        OR NEW.request_id IS NOT OLD.request_id)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal''s web address, app, proposer and request are fixed');
END;

-- Announced once, never back-dated by more than 5 minutes, and only once its earliest time is written, at least its
-- wait after the announcement.
CREATE TRIGGER guarded_changes_platform_announced BEFORE UPDATE OF notified_at ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform'
   AND ((OLD.notified_at IS NOT NULL AND NEW.notified_at IS NOT OLD.notified_at)
        OR (OLD.notified_at IS NULL AND NEW.notified_at IS NOT NULL
            AND (NEW.notified_at < ((julianday('now') - 2440587.5) * 86400000.0) - 300000
                 OR NOT EXISTS (SELECT 1 FROM platform_origin_waits w WHERE w.change_id = OLD.id AND w.unconfirmed_active_from IS NOT NULL
                                 AND w.unconfirmed_active_from >= NEW.notified_at + w.min_delay_ms))))
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal is announced once, never back-dated, its earliest time at least its wait away');
END;

-- Never in force before its earliest time (P10 replaces this with a version that also allows an owner's confirmation).
CREATE TRIGGER guarded_changes_platform_not_early BEFORE UPDATE OF active_from ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND NEW.active_from IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM platform_origin_waits w WHERE w.change_id = OLD.id AND w.unconfirmed_active_from IS NOT NULL
                    AND NEW.active_from >= w.unconfirmed_active_from)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a web address the platform proposed comes into force no earlier than its wait allows');
END;

-- No waiver and no expedite, ever.
CREATE TRIGGER guarded_changes_platform_no_waiver BEFORE UPDATE OF waiver, expedited_by, expedite_reason ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND (NEW.waiver IS NOT NULL OR NEW.expedited_by IS NOT NULL OR NEW.expedite_reason IS NOT NULL)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal takes no waiver and no expedite');
END;

-- Recorded `active` only once its time has passed by the database's clock (2 minutes' skew).
CREATE TRIGGER guarded_changes_platform_active_on_time BEFORE UPDATE OF status ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND NEW.status = 'active' AND OLD.status IS NOT 'active'
   AND (NEW.active_from IS NULL OR NEW.active_from > ((julianday('now') - 2440587.5) * 86400000.0) + 120000)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal is recorded in force only once its time has passed');
END;

-- A cancelled or ended platform proposal never comes back (its earliest time has passed, so it would be in force at once).
CREATE TRIGGER guarded_changes_platform_status_moves BEFORE UPDATE OF status ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND OLD.status IN ('cancelled', 'ended') AND NEW.status IS NOT OLD.status
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a cancelled or ended platform proposal never comes back');
END;

-- A waiting platform proposal is never deleted (so never deleted and inserted again without its wait). Retention
-- deletes only cancelled or ended rows, or a deleted app's (whose waiting changes the deletion cancelled).
CREATE TRIGGER guarded_changes_platform_no_delete BEFORE DELETE ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND OLD.status = 'pending'
   AND (OLD.active_from IS NULL OR OLD.active_from > ((julianday('now') - 2440587.5) * 86400000.0))
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a waiting platform proposal is never deleted');
END;

-- Its wait goes with it (retention's delete of an old cancelled or ended proposal).
CREATE TRIGGER guarded_changes_platform_wait_gone AFTER DELETE ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform'
BEGIN
  DELETE FROM platform_origin_waits WHERE change_id = OLD.id;
END;

-- An UPDATE OR REPLACE onto a platform proposal's id or cancel link's hash would delete it (no DELETE trigger fires).
CREATE TRIGGER guarded_changes_platform_no_replace_update BEFORE UPDATE OF id, cancel_token_hash ON guarded_changes
  WHEN EXISTS (SELECT 1 FROM guarded_changes o WHERE o.rowid IS NOT OLD.rowid AND o.proposed_by_kind = 'platform'
                AND (o.id = NEW.id OR (NEW.cancel_token_hash IS NOT NULL AND o.cancel_token_hash = NEW.cancel_token_hash)))
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a platform proposal is never replaced');
END;

-- ---- app_origins: the gate's row of a platform proposal is never in force before the proposal's earliest time ----
-- Matched by the app and the web address (not only `change_id`, which a bare write could clear in the same statement),
-- on an insert (a replacing insert or one after a delete included) and on any update.

CREATE TRIGGER app_origins_platform_not_early BEFORE INSERT ON app_origins
  WHEN NEW.active_from IS NOT NULL
   AND EXISTS (SELECT 1 FROM guarded_changes g LEFT JOIN platform_origin_waits w ON w.change_id = g.id
                WHERE g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND g.status = 'pending'
                  AND (w.unconfirmed_active_from IS NULL OR NEW.active_from < w.unconfirmed_active_from))
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a web address the platform proposed comes into force no earlier than its wait allows');
END;

CREATE TRIGGER app_origins_platform_not_early_update BEFORE UPDATE ON app_origins
  WHEN NEW.active_from IS NOT NULL
   AND EXISTS (SELECT 1 FROM guarded_changes g LEFT JOIN platform_origin_waits w ON w.change_id = g.id
                WHERE g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.kind = 'origin_add' AND g.proposed_by_kind = 'platform' AND g.status = 'pending'
                  AND (w.unconfirmed_active_from IS NULL OR NEW.active_from < w.unconfirmed_active_from))
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a web address the platform proposed comes into force no earlier than its wait allows');
END;

-- ---- apps: who holds the partner suspension ----

ALTER TABLE apps ADD COLUMN partner_bit_by TEXT CHECK (partner_bit_by IN ('member', 'platform'));

-- Only while bit 4 is set: a resume clears it in the same statement, so a later suspension never inherits a stale holder.
CREATE TRIGGER apps_partner_bit_by BEFORE UPDATE OF suspended_by, partner_bit_by ON apps
  WHEN NEW.partner_bit_by IS NOT NULL AND (NEW.suspended_by & 4) = 0
BEGIN
  SELECT RAISE(ABORT, 'apps: partner_bit_by names who holds the partner suspension, so only while it is set');
END;

-- An insert follows the same rule, and one that would replace an app (INSERT OR REPLACE, an upsert: no UPDATE trigger
-- fires) can't change who created it (the platform's reach is its creator) nor who holds its partner suspension.
CREATE TRIGGER apps_platform_insert BEFORE INSERT ON apps
BEGIN
  SELECT RAISE(ABORT, 'apps: partner_bit_by names who holds the partner suspension, so only while it is set')
   WHERE NEW.partner_bit_by IS NOT NULL AND (NEW.suspended_by & 4) = 0;
  SELECT RAISE(ABORT, 'apps: created_by_kind is fixed')
   WHERE EXISTS (SELECT 1 FROM apps WHERE id = NEW.id AND created_by_kind IS NOT NEW.created_by_kind);
  SELECT RAISE(ABORT, 'apps: who holds the partner suspension changes only with the suspension')
   WHERE EXISTS (SELECT 1 FROM apps WHERE id = NEW.id AND partner_bit_by IS NOT NEW.partner_bit_by);
END;
