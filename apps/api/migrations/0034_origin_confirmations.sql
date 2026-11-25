-- D931: an owner's confirmation of a web address the platform proposed, and a second person's confirmation of a web
-- address Journear staff proposed on a shared wallet (piece P10 of docs/partner-platform-spec.md, A7, A15; D914, D917).
-- Additive: two new tables (`origin_confirmations` with three indexes and three triggers, `staff_origin_waits` with
-- three), six new triggers on `guarded_changes` and three of 0033's triggers replaced (dropped and created again under
-- the same names: `guarded_changes_platform_not_early`, `app_origins_platform_not_early`,
-- `app_origins_platform_not_early_update`). No column is added to `guarded_changes` (`ledger-check` holds the ledger
-- tables' shape, D929), no table is rebuilt, no other index, trigger or view is touched (0034's test compares every one
-- by `sqlite_schema`) and no existing row changes. Applied by the Tech Lead on a deployed env before the API that writes
-- it (docs/operations.md "Owner confirmations (hot-DB migration 0034, D931)"); nothing writes these rows until an org's
-- platform switch is on, or staff add a web address to a shared wallet.
--
-- `origin_confirmations` (A7, A15): the only record that lets a web address come into force before its earliest time.
-- One row per confirmed change, written by the confirmation's own batch after its ledger row (`origin.confirmed`) and
-- before the change's `active_from` moves; never replaced, never changed but for its removal link and notice (each written once), never
-- deleted while its change exists. Who confirmed (`confirmed_by_kind`, `confirmed_by`, the step-up's verified Google
-- `confirmed_sub` for a member, the email key for four eyes), when (`confirmed_at`, never back-dated by the database's
-- clock), and
-- the sign-in's evidence: `token_sha256` is sha256 of the step-up token, the key the API reserved it under (never the
-- token itself), and `step_up_id` the console's action (its `audit_log` row's `step_up_id`). One token confirms one set:
-- a second request with the same token is refused. The insert trigger holds every rule the commit predicate holds that
-- the database can see: the change a waiting, announced `origin_add` not yet in force with no waiver or expedite, not
-- the confirmer's own; the app not deleted nor suspended by Journear (bits 1 and 2); the org not frozen; for a platform
-- proposal its wait recorded, a member confirming, the app still in the proposing key's reach (its org, a scope it
-- names, a test scope, platform-created), the key not revoked nor expired (by the database's clock) and the org's
-- switch on; for a staff proposal under four
-- eyes its wait recorded and another email than the proposer's (an owner too: one person who is staff and an owner is
-- still one person), for a staff confirmer also another Access subject.
--
-- `staff_origin_waits` (A15, D917): a web address staff propose on a platform-created app or on any app of a scope
-- marked as shared waits at least the 24 h platform minimum after its announcement unless a second person confirms
-- it. The proposal's batch writes the wait (`INSERT … SELECT` from the app's creator and the scope's flag, so a flag set
-- between the plan read and the batch is not missed: the insert trigger below refuses such a staff proposal without
-- it) with the proposer's email key; the announcement's ack writes its earliest time once, as 0033's platform waits do.
-- No waiver and no expedite, ever.
--
-- The three replaced triggers allow exactly one thing more than 0033's: an `active_from` no earlier than a recorded
-- confirmation's time. `ledger-check` compares an object a later migration replaces at the level the database
-- recorded (D931), so a database with 0033 and not 0034 reads 0033's versions as they should be.
--
-- A FUTURE REBUILD of `guarded_changes`, `app_origins`, `origin_confirmations` or `staff_origin_waits` must create
-- every trigger below again, with the same SQL: origin_confirmations_insert, origin_confirmations_update,
-- origin_confirmations_no_delete, staff_origin_waits_insert, staff_origin_waits_update, staff_origin_waits_no_delete,
-- guarded_changes_second_person_insert, guarded_changes_second_person_no_replace, guarded_changes_second_person_update,
-- guarded_changes_second_person_no_replace_update, guarded_changes_second_person_no_delete,
-- guarded_changes_confirmation_gone, guarded_changes_platform_not_early, app_origins_platform_not_early,
-- app_origins_platform_not_early_update; and on `scopes`, scopes_app_user_ids_no_waiting_staff_origin and
-- scopes_app_user_ids_insert_rules. apps/api/test/migration-0034.test.ts checks every one is in the schema after
-- every later migration.
--
-- The database's clock is `(julianday('now') - 2440587.5) * 86400000.0` (ms), as 0028's and 0033's triggers read it.
-- Nothing here changes a key, a path or an address. Times are integer ms UTC.

-- ---- staff_origin_waits ----

CREATE TABLE staff_origin_waits (
  change_id               TEXT PRIMARY KEY CHECK (change_id GLOB 'gc_*'),
  app_id                  TEXT NOT NULL,
  origin                  TEXT NOT NULL,
  proposed_by             TEXT NOT NULL CHECK (length(proposed_by) BETWEEN 1 AND 255),          -- the staff member's Access subject
  proposer_email_key      TEXT NOT NULL CHECK (length(proposer_email_key) BETWEEN 3 AND 254),   -- console-core personEmailKey
  min_delay_ms            INTEGER NOT NULL CHECK (min_delay_ms >= 60000),                       -- its wait from the announcement
  unconfirmed_active_from INTEGER,                                                              -- written by the ack: not before
  at                      INTEGER NOT NULL
);

-- Never replaced; never for a change that exists already; its earliest time left for the ack.
CREATE TRIGGER staff_origin_waits_insert BEFORE INSERT ON staff_origin_waits
BEGIN
  SELECT RAISE(ABORT, 'staff_origin_waits: a wait is written once, before its proposal')
   WHERE EXISTS (SELECT 1 FROM staff_origin_waits WHERE change_id = NEW.change_id)
      OR EXISTS (SELECT 1 FROM guarded_changes WHERE id = NEW.change_id)
      OR NEW.unconfirmed_active_from IS NOT NULL;
END;

-- Only the earliest time is written, once, at least the wait from the database's now (less 2 minutes' skew).
CREATE TRIGGER staff_origin_waits_update BEFORE UPDATE ON staff_origin_waits
  WHEN NEW.change_id IS NOT OLD.change_id OR NEW.app_id IS NOT OLD.app_id OR NEW.origin IS NOT OLD.origin OR NEW.proposed_by IS NOT OLD.proposed_by
    OR NEW.proposer_email_key IS NOT OLD.proposer_email_key OR NEW.min_delay_ms IS NOT OLD.min_delay_ms OR NEW.at IS NOT OLD.at
    OR OLD.unconfirmed_active_from IS NOT NULL OR NEW.unconfirmed_active_from IS NULL
    OR NEW.unconfirmed_active_from < ((julianday('now') - 2440587.5) * 86400000.0) + OLD.min_delay_ms - 120000
BEGIN
  SELECT RAISE(ABORT, 'staff_origin_waits: only the earliest time is written, once, at least the wait away');
END;

-- Kept while its proposal exists (it goes with it: guarded_changes_confirmation_gone).
CREATE TRIGGER staff_origin_waits_no_delete BEFORE DELETE ON staff_origin_waits
  WHEN EXISTS (SELECT 1 FROM guarded_changes WHERE id = OLD.change_id)
BEGIN
  SELECT RAISE(ABORT, 'staff_origin_waits: a wait is kept while its proposal exists');
END;

-- ---- origin_confirmations ----

CREATE TABLE origin_confirmations (
  change_id           TEXT PRIMARY KEY CHECK (change_id GLOB 'gc_*'),
  app_id              TEXT NOT NULL,
  origin              TEXT NOT NULL,
  proposal_request_id TEXT NOT NULL,                                                  -- the proposing request (guarded_changes.request_id)
  request_id          TEXT NOT NULL,                                                  -- the confirmation's ledger row (app_changes, origin.confirmed)
  confirmed_by_kind   TEXT NOT NULL CHECK (confirmed_by_kind IN ('member', 'hana')),
  confirmed_by        TEXT NOT NULL CHECK (length(confirmed_by) BETWEEN 1 AND 255),   -- the console user id, or the staff member's Access subject
  confirmed_sub       TEXT,                                                           -- a member: the step-up's verified Google sub
  confirmed_email_key TEXT NOT NULL CHECK (length(confirmed_email_key) BETWEEN 3 AND 254),
  token_sha256        TEXT CHECK (token_sha256 IS NULL OR (length(token_sha256) = 64 AND token_sha256 NOT GLOB '*[^0-9a-f]*')),
  step_up_id          TEXT CHECK (step_up_id IS NULL OR (step_up_id GLOB 'act_*' AND length(step_up_id) <= 40)),
  reason              TEXT CHECK (reason IS NULL OR length(reason) BETWEEN 20 AND 1000),  -- a staff confirmer's
  confirmed_at        INTEGER NOT NULL,                                               -- also the change's new active_from
  links_at            INTEGER,                                                        -- the removal link armed, before the first send
  removal_token_hash  BLOB UNIQUE CHECK (removal_token_hash IS NULL OR length(removal_token_hash) = 32),
  removal_until       INTEGER,
  notice_at           INTEGER,                                                        -- the confirmation's notice acked: every send accepted
  notice_failures     INTEGER NOT NULL DEFAULT 0 CHECK (notice_failures >= 0),        -- notice runs a recipient refused (a bounded retry)
  notice_failed_at    INTEGER,
  CHECK ((confirmed_by_kind = 'member') = (confirmed_sub IS NOT NULL AND token_sha256 IS NOT NULL)),
  CHECK ((confirmed_by_kind = 'hana') = (reason IS NOT NULL)),
  CHECK ((links_at IS NULL) = (removal_token_hash IS NULL) AND (links_at IS NULL) = (removal_until IS NULL)),
  CHECK (removal_until IS NULL OR removal_until = links_at + 604800000),
  CHECK (notice_at IS NULL OR links_at IS NOT NULL)
);
CREATE INDEX origin_confirmations_request ON origin_confirmations (request_id);
CREATE INDEX origin_confirmations_unnoticed ON origin_confirmations (confirmed_at) WHERE notice_at IS NULL;
CREATE INDEX origin_confirmations_recent ON origin_confirmations (confirmed_at);

-- Written once per change, by its confirmer's own ledger row, of a change that may be confirmed now and by them.
CREATE TRIGGER origin_confirmations_insert BEFORE INSERT ON origin_confirmations
BEGIN
  SELECT RAISE(ABORT, 'origin_confirmations: a web address is confirmed once, never replaced')
   WHERE EXISTS (SELECT 1 FROM origin_confirmations WHERE change_id = NEW.change_id)
      OR (NEW.removal_token_hash IS NOT NULL AND EXISTS (SELECT 1 FROM origin_confirmations WHERE removal_token_hash = NEW.removal_token_hash));
  SELECT RAISE(ABORT, 'origin_confirmations: a confirmation starts with no notice')
   WHERE NEW.notice_at IS NOT NULL OR NEW.links_at IS NOT NULL OR NEW.removal_token_hash IS NOT NULL OR NEW.removal_until IS NOT NULL
      OR NEW.notice_failures IS NOT 0 OR NEW.notice_failed_at IS NOT NULL;
  SELECT RAISE(ABORT, 'origin_confirmations: one fresh sign-in confirms one set of web addresses, once')
   WHERE NEW.token_sha256 IS NOT NULL AND EXISTS (SELECT 1 FROM origin_confirmations WHERE token_sha256 = NEW.token_sha256 AND request_id IS NOT NEW.request_id);
  -- Never back-dated (2 minutes' skew): a later time only brings the web address in later, which nothing forbids.
  SELECT RAISE(ABORT, 'origin_confirmations: confirmed now, never back-dated by the database''s clock')
   WHERE NEW.confirmed_at < ((julianday('now') - 2440587.5) * 86400000.0) - 120000;
  SELECT RAISE(ABORT, 'origin_confirmations: no ledger row of this confirmer has this request id')
   WHERE NOT EXISTS (SELECT 1 FROM app_changes c WHERE c.request_id = NEW.request_id AND c.kind = 'origin.confirmed' AND c.app_id = NEW.app_id
                       AND c.actor_kind = NEW.confirmed_by_kind AND c.actor_id = NEW.confirmed_by AND c.actor_sub IS NEW.confirmed_sub);
  SELECT RAISE(ABORT, 'origin_confirmations: only a waiting, announced web address the platform asked for, or one staff added under four eyes, is confirmed, and never by its proposer')
   WHERE NOT EXISTS (
     SELECT 1 FROM guarded_changes g JOIN apps a ON a.id = g.app_id JOIN scopes s ON s.scope_id = a.scope_id
      WHERE g.id = NEW.change_id AND g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.request_id = NEW.proposal_request_id
        AND g.kind = 'origin_add' AND g.status = 'pending' AND g.notified_at IS NOT NULL
        AND g.active_from IS NOT NULL AND g.active_from > ((julianday('now') - 2440587.5) * 86400000.0)
        AND g.waiver IS NULL AND g.expedited_by IS NULL AND g.cancelled_at IS NULL AND g.proposed_by IS NOT NEW.confirmed_by
        AND a.deleted_at IS NULL AND (a.suspended_by & 3) = 0
        AND NOT EXISTS (SELECT 1 FROM platform_orgs fo WHERE fo.org_id = a.org_id AND fo.frozen = 1)
        AND ((g.proposed_by_kind = 'platform' AND NEW.confirmed_by_kind = 'member'
              AND a.created_by_kind = 'platform' AND s.environment = 'test'
              AND EXISTS (SELECT 1 FROM platform_origin_waits w WHERE w.change_id = g.id AND w.unconfirmed_active_from IS NOT NULL)
              AND EXISTS (SELECT 1 FROM platform_orgs po WHERE po.org_id = a.org_id AND po.enabled = 1 AND po.frozen = 0)
              AND EXISTS (SELECT 1 FROM platform_keys k WHERE k.id = g.proposed_by AND k.org_id = a.org_id AND k.status IN ('pending', 'active') AND k.revoked_at IS NULL
                            AND k.active_from IS NOT NULL AND k.expires_at > ((julianday('now') - 2440587.5) * 86400000.0)
                            AND EXISTS (SELECT 1 FROM json_each(k.scopes_json) ks WHERE ks.value = a.scope_id)))
          OR (g.proposed_by_kind = 'hana'
              AND EXISTS (SELECT 1 FROM staff_origin_waits sw WHERE sw.change_id = g.id AND sw.unconfirmed_active_from IS NOT NULL
                            AND sw.proposed_by IS NOT NEW.confirmed_by AND sw.proposer_email_key IS NOT NEW.confirmed_email_key))));
END;

-- Fixed once written. Its removal link is armed once (its hash and exactly 7 days, before the notice's first send,
-- so a link that reached anyone works: after PR 159's review; never back-dated, and judged by the API's clock it was
-- written with), its notice acked once and only after the link, neither back-dated nor in the future by the database's
-- clock (5 and 2 minutes' skew); a failed notice run counts up by one.
CREATE TRIGGER origin_confirmations_update BEFORE UPDATE ON origin_confirmations
BEGIN
  SELECT RAISE(ABORT, 'origin_confirmations: a confirmation is fixed; only its link and its notice are written, once')
   WHERE NEW.change_id IS NOT OLD.change_id OR NEW.app_id IS NOT OLD.app_id OR NEW.origin IS NOT OLD.origin OR NEW.proposal_request_id IS NOT OLD.proposal_request_id
      OR NEW.request_id IS NOT OLD.request_id OR NEW.confirmed_by_kind IS NOT OLD.confirmed_by_kind OR NEW.confirmed_by IS NOT OLD.confirmed_by
      OR NEW.confirmed_sub IS NOT OLD.confirmed_sub OR NEW.confirmed_email_key IS NOT OLD.confirmed_email_key OR NEW.token_sha256 IS NOT OLD.token_sha256
      OR NEW.step_up_id IS NOT OLD.step_up_id OR NEW.reason IS NOT OLD.reason OR NEW.confirmed_at IS NOT OLD.confirmed_at;
  SELECT RAISE(ABORT, 'origin_confirmations: the removal link is armed once, never back-dated')
   WHERE (OLD.links_at IS NOT NULL AND (NEW.links_at IS NOT OLD.links_at OR NEW.removal_token_hash IS NOT OLD.removal_token_hash OR NEW.removal_until IS NOT OLD.removal_until))
      OR (OLD.links_at IS NULL AND NEW.links_at IS NOT NULL AND NEW.links_at < ((julianday('now') - 2440587.5) * 86400000.0) - 300000);
  SELECT RAISE(ABORT, 'origin_confirmations: the notice is acked once, now by the database''s clock')
   WHERE (OLD.notice_at IS NOT NULL AND NEW.notice_at IS NOT OLD.notice_at)
      OR (OLD.notice_at IS NULL AND NEW.notice_at IS NOT NULL
          AND (NEW.notice_at < ((julianday('now') - 2440587.5) * 86400000.0) - 300000 OR NEW.notice_at > ((julianday('now') - 2440587.5) * 86400000.0) + 120000));
  SELECT RAISE(ABORT, 'origin_confirmations: a failed notice run counts up by one')
   WHERE NEW.notice_failures IS NOT OLD.notice_failures AND NEW.notice_failures IS NOT OLD.notice_failures + 1;
  SELECT RAISE(ABORT, 'origin_confirmations: a removal link is never another confirmation''s')
   WHERE EXISTS (SELECT 1 FROM origin_confirmations o WHERE o.rowid IS NOT OLD.rowid AND o.removal_token_hash = NEW.removal_token_hash);
END;

-- Kept while its change exists (it goes with it: guarded_changes_confirmation_gone).
CREATE TRIGGER origin_confirmations_no_delete BEFORE DELETE ON origin_confirmations
  WHEN EXISTS (SELECT 1 FROM guarded_changes WHERE id = OLD.change_id)
BEGIN
  SELECT RAISE(ABORT, 'origin_confirmations: a confirmation is kept while its change exists');
END;

-- ---- guarded_changes: a staff web address on a shared wallet waits like the platform's, unless a second person confirms it ----

-- A staff `origin_add` on a platform-created app or a marked scope starts waiting, not announced, with no waiver, and
-- with its wait already written for this app, web address and staff member.
CREATE TRIGGER guarded_changes_second_person_insert BEFORE INSERT ON guarded_changes
  WHEN NEW.proposed_by_kind = 'hana' AND NEW.kind = 'origin_add'
   AND EXISTS (SELECT 1 FROM apps a JOIN scopes s ON s.scope_id = a.scope_id WHERE a.id = NEW.app_id AND (a.created_by_kind = 'platform' OR s.app_user_ids = 1))
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address on a shared wallet starts waiting with its wait, no waiver, not announced')
   WHERE NEW.status IS NOT 'pending' OR NEW.notified_at IS NOT NULL OR NEW.active_from IS NOT NULL OR NEW.waiver IS NOT NULL
      OR NEW.expedited_by IS NOT NULL OR NEW.cancel_token_hash IS NOT NULL
      OR NOT EXISTS (SELECT 1 FROM staff_origin_waits w WHERE w.change_id = NEW.id AND w.app_id = NEW.app_id AND w.origin = NEW.origin
                       AND w.proposed_by = NEW.proposed_by AND w.unconfirmed_active_from IS NULL);
END;

-- An insert that would replace a staff web address under four eyes (by its id or its cancel link's hash) is refused
-- before the conflict is resolved, whatever the new row says it is.
CREATE TRIGGER guarded_changes_second_person_no_replace BEFORE INSERT ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes is never replaced')
   WHERE EXISTS (SELECT 1 FROM guarded_changes o JOIN staff_origin_waits w ON w.change_id = o.id
                  WHERE o.id = NEW.id OR (NEW.cancel_token_hash IS NOT NULL AND o.cancel_token_hash = NEW.cancel_token_hash));
END;

-- Its web address, app, proposer and request fixed; no waiver, no expedite; announced once, never back-dated, its
-- earliest time at least its wait away; never in force before that time unless a second person confirmed it (then no
-- earlier than the confirmation); recorded in force only once its time has passed; a cancelled or ended one never back.
CREATE TRIGGER guarded_changes_second_person_update BEFORE UPDATE ON guarded_changes
  WHEN EXISTS (SELECT 1 FROM staff_origin_waits w WHERE w.change_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes keeps its web address, app, proposer and request')
   WHERE NEW.id IS NOT OLD.id OR NEW.app_id IS NOT OLD.app_id OR NEW.kind IS NOT OLD.kind OR NEW.origin IS NOT OLD.origin
      OR NEW.proposed_by_kind IS NOT OLD.proposed_by_kind OR NEW.proposed_by IS NOT OLD.proposed_by OR NEW.proposed_at IS NOT OLD.proposed_at
      OR NEW.request_id IS NOT OLD.request_id;
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes takes no waiver and no expedite')
   WHERE NEW.waiver IS NOT NULL OR NEW.expedited_by IS NOT NULL OR NEW.expedite_reason IS NOT NULL;
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes is announced once, never back-dated, its earliest time at least its wait away')
   WHERE (OLD.notified_at IS NOT NULL AND NEW.notified_at IS NOT OLD.notified_at)
      OR (OLD.notified_at IS NULL AND NEW.notified_at IS NOT NULL
          AND (NEW.notified_at < ((julianday('now') - 2440587.5) * 86400000.0) - 300000
               OR NOT EXISTS (SELECT 1 FROM staff_origin_waits w WHERE w.change_id = OLD.id AND w.unconfirmed_active_from IS NOT NULL
                                AND w.unconfirmed_active_from >= NEW.notified_at + w.min_delay_ms)));
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes comes into force no earlier than its wait allows, unless a second person confirmed it')
   WHERE NEW.active_from IS NOT NULL AND NEW.active_from IS NOT OLD.active_from
     AND NOT EXISTS (SELECT 1 FROM staff_origin_waits w WHERE w.change_id = OLD.id AND w.unconfirmed_active_from IS NOT NULL AND NEW.active_from >= w.unconfirmed_active_from)
     AND NOT EXISTS (SELECT 1 FROM origin_confirmations oc WHERE oc.change_id = OLD.id AND NEW.active_from >= oc.confirmed_at);
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes is recorded in force only once its time has passed')
   WHERE NEW.status = 'active' AND OLD.status IS NOT 'active'
     AND (NEW.active_from IS NULL OR NEW.active_from > ((julianday('now') - 2440587.5) * 86400000.0) + 120000);
  SELECT RAISE(ABORT, 'guarded_changes: a cancelled or ended staff web address under four eyes never comes back')
   WHERE OLD.status IN ('cancelled', 'ended') AND NEW.status IS NOT OLD.status;
END;

-- An UPDATE OR REPLACE onto such a change's id or cancel link's hash would delete it (no DELETE trigger fires).
CREATE TRIGGER guarded_changes_second_person_no_replace_update BEFORE UPDATE OF id, cancel_token_hash ON guarded_changes
  WHEN EXISTS (SELECT 1 FROM guarded_changes o JOIN staff_origin_waits w ON w.change_id = o.id
                WHERE o.rowid IS NOT OLD.rowid AND (o.id = NEW.id OR (NEW.cancel_token_hash IS NOT NULL AND o.cancel_token_hash = NEW.cancel_token_hash)))
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a staff web address under four eyes is never replaced');
END;

-- Never deleted while waiting (so never deleted and inserted again without its wait).
CREATE TRIGGER guarded_changes_second_person_no_delete BEFORE DELETE ON guarded_changes
  WHEN OLD.status = 'pending' AND (OLD.active_from IS NULL OR OLD.active_from > ((julianday('now') - 2440587.5) * 86400000.0))
   AND EXISTS (SELECT 1 FROM staff_origin_waits w WHERE w.change_id = OLD.id)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a waiting staff web address under four eyes is never deleted');
END;

-- Retention's delete of an old cancelled or ended change takes its wait and its confirmation with it.
CREATE TRIGGER guarded_changes_confirmation_gone AFTER DELETE ON guarded_changes
BEGIN
  DELETE FROM origin_confirmations WHERE change_id = OLD.id;
  DELETE FROM staff_origin_waits WHERE change_id = OLD.id;
END;

-- ---- scopes: a scope is marked as shared only once no staff web address of its apps is still waiting ----
-- (after PR 159's review, L1) A staff web address proposed while the scope was plain has no wait of its own (and may
-- be a `no_session` waiver candidate): marking the scope before it is cancelled or in force would leave it on the plain
-- path. The API refuses the mark in its plan read and its commit predicate; this is the backstop, as 0026's are.
CREATE TRIGGER scopes_app_user_ids_no_waiting_staff_origin BEFORE UPDATE OF app_user_ids ON scopes
WHEN OLD.app_user_ids = 0 AND NEW.app_user_ids = 1
BEGIN
  SELECT RAISE(ABORT, 'scopes: an app of this scope has a staff web address not working yet')
   WHERE EXISTS (SELECT 1 FROM guarded_changes g JOIN apps a ON a.id = g.app_id
                  WHERE a.scope_id = NEW.scope_id AND a.deleted_at IS NULL AND g.kind = 'origin_add' AND g.proposed_by_kind = 'hana' AND g.status = 'pending'
                    AND (g.active_from IS NULL OR g.active_from > ((julianday('now') - 2440587.5) * 86400000.0)));
END;

-- The same for a mark written by an insert that replaces the scope's row (INSERT OR REPLACE, an upsert: this runs
-- before the conflict is resolved, so it sees the apps of the row being replaced; after PR 159's second review), and
-- 0027's `scopes_app_user_ids_no_policy` rule with it (that update trigger had the same gap): no app of the scope with
-- an auto-approve policy in force, waiting or proposed. A new scope has no app yet, so neither refuses it.
CREATE TRIGGER scopes_app_user_ids_insert_rules BEFORE INSERT ON scopes
WHEN NEW.app_user_ids = 1
BEGIN
  SELECT RAISE(ABORT, 'scopes: an app of this scope has a staff web address not working yet')
   WHERE EXISTS (SELECT 1 FROM guarded_changes g JOIN apps a ON a.id = g.app_id
                  WHERE a.scope_id = NEW.scope_id AND a.deleted_at IS NULL AND g.kind = 'origin_add' AND g.proposed_by_kind = 'hana' AND g.status = 'pending'
                    AND (g.active_from IS NULL OR g.active_from > ((julianday('now') - 2440587.5) * 86400000.0)));
  SELECT RAISE(ABORT, 'scopes: an app of this scope has an auto-approve policy in force or waiting')
   WHERE EXISTS (SELECT 1 FROM apps a WHERE a.scope_id = NEW.scope_id AND a.deleted_at IS NULL
                  AND (a.auto_approve_policy IS NOT NULL OR a.auto_approve_pending IS NOT NULL
                       OR EXISTS (SELECT 1 FROM guarded_changes g WHERE g.app_id = a.id AND g.kind = 'policy_set' AND g.status IN ('pending', 'active'))));
END;

-- ---- 0033's three earliest-time triggers, replaced: a recorded confirmation's time is the one earlier time allowed ----

DROP TRIGGER guarded_changes_platform_not_early;
CREATE TRIGGER guarded_changes_platform_not_early BEFORE UPDATE OF active_from ON guarded_changes
  WHEN OLD.proposed_by_kind = 'platform' AND NEW.active_from IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM platform_origin_waits w WHERE w.change_id = OLD.id AND w.unconfirmed_active_from IS NOT NULL
                    AND NEW.active_from >= w.unconfirmed_active_from)
   AND NOT EXISTS (SELECT 1 FROM origin_confirmations oc WHERE oc.change_id = OLD.id AND NEW.active_from >= oc.confirmed_at)
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: a web address the platform proposed comes into force no earlier than its wait allows, unless an owner confirmed it');
END;

-- The gate's row of a platform proposal or of a staff one under four eyes (matched by the app and the web address).
DROP TRIGGER app_origins_platform_not_early;
CREATE TRIGGER app_origins_platform_not_early BEFORE INSERT ON app_origins
  WHEN NEW.active_from IS NOT NULL
   AND EXISTS (SELECT 1 FROM guarded_changes g LEFT JOIN platform_origin_waits w ON w.change_id = g.id LEFT JOIN staff_origin_waits sw ON sw.change_id = g.id
                 LEFT JOIN origin_confirmations oc ON oc.change_id = g.id
                WHERE g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.kind = 'origin_add' AND g.status = 'pending'
                  AND (g.proposed_by_kind = 'platform' OR sw.change_id IS NOT NULL)
                  AND NOT (COALESCE(w.unconfirmed_active_from, sw.unconfirmed_active_from) IS NOT NULL AND NEW.active_from >= COALESCE(w.unconfirmed_active_from, sw.unconfirmed_active_from))
                  AND NOT (oc.confirmed_at IS NOT NULL AND NEW.active_from >= oc.confirmed_at))
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a web address the platform proposed, or staff added to a shared wallet, comes into force no earlier than its wait allows, unless confirmed');
END;

DROP TRIGGER app_origins_platform_not_early_update;
CREATE TRIGGER app_origins_platform_not_early_update BEFORE UPDATE ON app_origins
  WHEN NEW.active_from IS NOT NULL
   AND EXISTS (SELECT 1 FROM guarded_changes g LEFT JOIN platform_origin_waits w ON w.change_id = g.id LEFT JOIN staff_origin_waits sw ON sw.change_id = g.id
                 LEFT JOIN origin_confirmations oc ON oc.change_id = g.id
                WHERE g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.kind = 'origin_add' AND g.status = 'pending'
                  AND (g.proposed_by_kind = 'platform' OR sw.change_id IS NOT NULL)
                  AND NOT (COALESCE(w.unconfirmed_active_from, sw.unconfirmed_active_from) IS NOT NULL AND NEW.active_from >= COALESCE(w.unconfirmed_active_from, sw.unconfirmed_active_from))
                  AND NOT (oc.confirmed_at IS NOT NULL AND NEW.active_from >= oc.confirmed_at))
BEGIN
  SELECT RAISE(ABORT, 'app_origins: a web address the platform proposed, or staff added to a shared wallet, comes into force no earlier than its wait allows, unless confirmed');
END;
