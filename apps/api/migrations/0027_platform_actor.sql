-- D916: the `platform` actor (piece P1 of docs/partner-platform-spec.md, A7 "Widening the actor kinds: the ledger
-- rebuild"). SQLite can't widen a column CHECK in place, so `app_changes` and `guarded_changes` are rebuilt once, every
-- column, row, `seq`, index and trigger kept, and their actor and proposer kinds move from column CHECKs to triggers:
-- the next kind is then a DROP TRIGGER and CREATE TRIGGER, never another rebuild of the ledger. `security_events` is
-- rebuilt with three more kinds (its CHECK widened, as 0018 to 0025 did). Nothing writes `platform` or the new event
-- kinds yet (pieces P2 to P4).
--
-- Numbered 0027: 0026 is P0's (`scopes.app_user_ids`, `apps.created_by_kind`, `apps.partner_bit_by`). Neither file
-- reads or writes what the other adds, so they apply in either order (wrangler applies the unapplied files in name
-- order; 0006's header). Applied only by the Tech Lead on a deployed env, with a Time Travel bookmark first and the
-- before-and-after comparison (`ledger-check`, docs/operations.md "Ledger rebuild (hot-DB migration 0027)").
--
-- No foreign key points at these tables, no other table's trigger reads them, and a DROP TABLE fires no trigger (its
-- triggers are dropped first), so dropping the old tables deletes nothing elsewhere (unlike `apps`, never rebuilt:
-- 0006's header). D1 runs the file as one transaction: any failure leaves the database as it was.

-- ---- app_changes: every column in order, `actor_kind` without its CHECK ----

CREATE TABLE app_changes_new (
  seq         INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  org_id      TEXT NOT NULL,
  app_id      TEXT,
  scope_id    TEXT,
  kind        TEXT NOT NULL,                        -- app.*|origin.*|policy.*|raw_sign.*|settings.*|key.*|suspension.*|
                                                    -- scope.assigned|org.security_contacts|change.*|migration.baseline
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)), -- allowlisted fields only
  actor_kind  TEXT NOT NULL,
  actor_id    TEXT NOT NULL,
  actor_sub   TEXT,                                 -- the verified step-up sub when there is one
  request_id  TEXT NOT NULL UNIQUE
);

-- ---- guarded_changes: every column in order, `proposed_by_kind` without its CHECK ----

CREATE TABLE guarded_changes_new (
  id                    TEXT PRIMARY KEY,           -- gc_…
  app_id                TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('origin_add', 'policy_set', 'raw_sign_on')),
  origin                TEXT,                       -- origin_add: ASCII (punycode) form
  policy_json           TEXT,                       -- policy_set: canonical JSON (validated)
  policy_id             TEXT,                       -- policy_set: its policyId (hex)
  status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'ended')),
  proposed_by_kind      TEXT NOT NULL,
  proposed_by           TEXT NOT NULL,
  proposer_sub          TEXT,
  proposed_at           INTEGER NOT NULL,
  request_country       TEXT,
  waiver                TEXT CHECK (waiver IN ('loopback', 'no_session')),
  notified_at           INTEGER,                    -- the admin notice was accepted (or the CLI announced it)
  active_from           INTEGER,                    -- notified_at + appChangeDelayMs (notified_at under a waiver)
  cancel_token_hash     BLOB UNIQUE,                -- sha256 of the emailed link token
  activated_recorded_at INTEGER,
  expedited_by          TEXT,
  expedite_reason       TEXT,
  ended_at              INTEGER,
  cancelled_by          TEXT,
  cancelled_at          INTEGER,
  request_id            TEXT NOT NULL,
  CHECK ((kind = 'origin_add') = (origin IS NOT NULL)),
  CHECK ((kind = 'policy_set') = (policy_json IS NOT NULL AND policy_id IS NOT NULL))
);

-- ---- Copy, explicit column lists on both sides; `seq` copied as it is (the admin feed reads changesSince(seq)) ----

INSERT INTO app_changes_new (seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id)
  SELECT seq, at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, actor_sub, request_id FROM app_changes;

INSERT INTO guarded_changes_new (id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id)
  SELECT id, app_id, kind, origin, policy_json, policy_id, status, proposed_by_kind, proposed_by, proposer_sub, proposed_at, request_country, waiver, notified_at, active_from, cancel_token_hash, activated_recorded_at, expedited_by, expedite_reason, ended_at, cancelled_by, cancelled_at, request_id FROM guarded_changes;

DROP TABLE app_changes;
ALTER TABLE app_changes_new RENAME TO app_changes;
DROP TABLE guarded_changes;
ALTER TABLE guarded_changes_new RENAME TO guarded_changes;

-- ---- After the copy: every index and trigger of 0006, exactly as 0006 wrote them ----

CREATE INDEX guarded_changes_app ON guarded_changes (app_id, status);
CREATE INDEX guarded_changes_unnotified ON guarded_changes (status, notified_at);
CREATE INDEX guarded_changes_due ON guarded_changes (status, active_from);
CREATE INDEX app_changes_org_seq ON app_changes (org_id, seq);

CREATE TRIGGER guarded_changes_insert BEFORE INSERT ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: no such app') WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id);
END;

CREATE TRIGGER app_changes_no_update BEFORE UPDATE ON app_changes
BEGIN
  SELECT RAISE(ABORT, 'app_changes is append-only');
END;

CREATE TRIGGER app_changes_no_early_delete BEFORE DELETE ON app_changes
WHEN OLD.at >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months');
END;

-- ---- The kind triggers (the lists are `ACTOR_KINDS` and `PROPOSER_KINDS` in @hana-id/console-core; a test compares) ----

-- Who wrote a ledger row. `app_changes` takes no update (app_changes_no_update), so an insert is its only write.
CREATE TRIGGER app_changes_actor_kind BEFORE INSERT ON app_changes
BEGIN
  SELECT RAISE(ABORT, 'app_changes: unknown actor_kind') WHERE NEW.actor_kind NOT IN ('member', 'hana', 'system', 'link', 'platform');
END;

-- Who proposed a guarded change. Unlike the ledger, `guarded_changes` takes updates (its lifecycle columns), and the
-- column CHECK this replaces held them too, so an update of the proposer's kind is held to the same list.
CREATE TRIGGER guarded_changes_proposer_kind BEFORE INSERT ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: unknown proposed_by_kind') WHERE NEW.proposed_by_kind NOT IN ('member', 'hana', 'system', 'platform');
END;

CREATE TRIGGER guarded_changes_proposer_kind_update BEFORE UPDATE OF proposed_by_kind ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: unknown proposed_by_kind') WHERE NEW.proposed_by_kind NOT IN ('member', 'hana', 'system', 'platform');
END;

-- ---- security_events gains the platform's two kinds and the linking lookups' one (spec A5, B6) ----

CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late', 'evm_relay_closed_slot_mined', 'near_billing_late', 'neon_compute_high', 'evm_relay_auto_resumed', 'label_proposed', 'label_blocked', 'label_live', 'platform_quota', 'platform_auth_failures', 'link_lookup_volume')),
  org_id      TEXT,
  app_id      TEXT,
  scope_id    TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  notified_at INTEGER
);
INSERT INTO security_events_new (id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at)
  SELECT id, detected_at, kind, org_id, app_id, scope_id, detail_json, notified_at FROM security_events;
DROP TABLE security_events;
ALTER TABLE security_events_new RENAME TO security_events;
CREATE INDEX security_events_unnotified ON security_events (notified_at);
