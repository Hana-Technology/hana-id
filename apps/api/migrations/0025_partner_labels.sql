-- D894: partner labels' storage (piece 2 of 5 of D892). Additive: new tables, one new column on `scopes`, and
-- `security_events` rebuilt with three more kinds (as 0023 and 0024 did, every row and the index kept). Applied only
-- by the founder on a deployed env; nothing reads these tables unless the manifest's `partnerLabels.enabled` is on.
--
-- An ENTRY (`partner_labels`) is one label document's place: owned by one org, in one scope (so one environment,
-- D51), never moved. Each VERSION of its document is a `label_changes` row, written once and never edited (the
-- document's text, its schema version, its sha256 and size, the apps it is attached to): a guarded change with the
-- lifecycle of `guarded_changes` (proposed → announced by the admin Worker's notice → in force `appChangeDelayMs`
-- later; cancelled; lapsed; blocked by staff; ended when replaced or removed). The document in force for an entry is
-- the newest version in force (`apps/api/src/labels/sql.ts` IN_FORCE). Staff controls (`label_controls`): every
-- partner label off ('*'), one org's off, or one org's (or every) change held for a staff "Allow"; one entry's off is
-- on the entry. Every control change is also a row of `label_control_log` (append-only), which drift detection reads.
-- Times are integer ms UTC.

-- Every label write in a scope bumps it: the compare-and-swap version of a proposal or removal and the step-up's nonce.
ALTER TABLE scopes ADD COLUMN labels_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE partner_labels (
  id          TEXT PRIMARY KEY,                     -- pl_…
  org_id      TEXT NOT NULL,
  scope_id    TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  created_by  TEXT NOT NULL,                        -- the proposing member's id
  removed_at  INTEGER,                              -- an owner removed it (immediate, final)
  removed_by  TEXT,
  off_at      INTEGER,                              -- staff switched this entry off (until switched back on)
  off_by      TEXT,
  off_note    TEXT,
  off_version INTEGER NOT NULL DEFAULT 0            -- bumped by every switch of this entry (the staff page's check)
);

CREATE TABLE label_changes (
  id                    TEXT PRIMARY KEY,           -- lc_…
  label_id              TEXT NOT NULL,
  org_id                TEXT NOT NULL,
  scope_id              TEXT NOT NULL,
  doc_text              TEXT NOT NULL,              -- the partner's document, exactly as proposed
  doc_schema            TEXT NOT NULL CHECK (doc_schema = 'journear-labels/1'),
  doc_sha256            TEXT NOT NULL CHECK (length(doc_sha256) = 64 AND doc_sha256 NOT GLOB '*[^0-9a-f]*'),
  doc_bytes             INTEGER NOT NULL CHECK (doc_bytes BETWEEN 1 AND 16384),
  context_key           TEXT NOT NULL,              -- what it describes: near:<network>:<account>, soroban:<passphrase>:<contract>, stellar:<passphrase>
  apps_json             TEXT NOT NULL CHECK (json_valid(apps_json) AND json_type(apps_json) = 'array' AND json_array_length(apps_json) BETWEEN 1 AND 8),
  previous_id           TEXT,                       -- the version in force when this one was proposed (the diff, "changed on")
  status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'lapsed', 'blocked', 'ended')),
  proposed_by           TEXT NOT NULL,              -- the member's id
  proposer_sub          TEXT NOT NULL,              -- the API-verified step-up's sub (an on-chain owner of the scope)
  proposed_at           INTEGER NOT NULL,
  notified_at           INTEGER,                    -- the admin Worker's notice was accepted (AdminRpc.ackLabelNotice)
  active_from           INTEGER,                    -- notified_at + appChangeDelayMs
  cancel_token_hash     BLOB UNIQUE,                -- sha256 of the emailed cancel link's token
  activated_recorded_at INTEGER,                    -- the hourly job recorded it in force
  allowed_at            INTEGER,                    -- a staff "Allow" (needed only while review is required)
  allowed_by            TEXT,
  allow_note            TEXT,
  blocked_at            INTEGER,                    -- a staff "Block this change": it never takes effect, or stops now
  blocked_by            TEXT,
  block_note            TEXT,
  was_live              INTEGER CHECK (was_live IN (0, 1)), -- blocked while in force
  cancelled_at          INTEGER,
  cancelled_by          TEXT,
  end_reason            TEXT CHECK (end_reason IN ('owner', 'link', 'removed', 'not_announced', 'not_reviewed', 'replaced')),
  ended_at              INTEGER,
  request_id            TEXT NOT NULL,
  CHECK ((status = 'blocked') = (blocked_at IS NOT NULL))
);

CREATE TABLE label_controls (
  target          TEXT PRIMARY KEY CHECK (target = '*' OR target GLOB 'org_*'), -- every org, or one org
  labels_off      INTEGER NOT NULL DEFAULT 0 CHECK (labels_off IN (0, 1)),
  review_required INTEGER NOT NULL DEFAULT 0 CHECK (review_required IN (0, 1)),
  updated_at      INTEGER NOT NULL,
  updated_by      TEXT NOT NULL,
  note            TEXT,
  version         INTEGER NOT NULL DEFAULT 0
);

-- Append-only: every staff control change (an entry's, an org's, every org's), the state it set. Drift detection
-- compares each control with its last row here.
CREATE TABLE label_control_log (
  seq             INTEGER PRIMARY KEY,
  at              INTEGER NOT NULL,
  target          TEXT NOT NULL,                     -- '*', an org id, or an entry id (pl_…)
  labels_off      INTEGER NOT NULL CHECK (labels_off IN (0, 1)),
  review_required INTEGER NOT NULL CHECK (review_required IN (0, 1)),
  actor_id        TEXT NOT NULL,
  note            TEXT NOT NULL,
  request_id      TEXT NOT NULL UNIQUE
);

CREATE INDEX partner_labels_scope ON partner_labels (scope_id, org_id);
CREATE INDEX partner_labels_org ON partner_labels (org_id);
CREATE INDEX label_changes_label ON label_changes (label_id, status, active_from);
CREATE INDEX label_changes_org ON label_changes (org_id, proposed_at);
CREATE INDEX label_changes_unnotified ON label_changes (status, notified_at);
CREATE INDEX label_changes_due ON label_changes (status, active_from);
CREATE INDEX label_control_log_target ON label_control_log (target, seq);

-- An entry's scope is its org's (a scope belongs to one org, D51).
CREATE TRIGGER partner_labels_insert BEFORE INSERT ON partner_labels
BEGIN
  SELECT RAISE(ABORT, 'partner_labels: no scopes row for this scope in this org')
   WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id AND org_id = NEW.org_id);
END;

CREATE TRIGGER partner_labels_fixed BEFORE UPDATE OF id, org_id, scope_id, created_at, created_by ON partner_labels
BEGIN
  SELECT RAISE(ABORT, 'partner_labels: an entry never moves');
END;

-- A version belongs to its entry's org and scope, and every app it is attached to is a live app of that scope and org.
CREATE TRIGGER label_changes_insert BEFORE INSERT ON label_changes
BEGIN
  SELECT RAISE(ABORT, 'label_changes: no such entry in this org and scope')
   WHERE NOT EXISTS (SELECT 1 FROM partner_labels WHERE id = NEW.label_id AND org_id = NEW.org_id AND scope_id = NEW.scope_id);
  SELECT RAISE(ABORT, 'label_changes: an attached app is not a live app of this scope in this org')
   WHERE EXISTS (SELECT 1 FROM json_each(NEW.apps_json) j
                  WHERE NOT EXISTS (SELECT 1 FROM apps a WHERE a.id = j.value AND a.scope_id = NEW.scope_id AND a.org_id = NEW.org_id AND a.deleted_at IS NULL));
END;

-- What a version says and where it applies are written once.
CREATE TRIGGER label_changes_fixed BEFORE UPDATE OF id, label_id, org_id, scope_id, doc_text, doc_schema, doc_sha256, doc_bytes, context_key, apps_json, previous_id, proposed_by, proposer_sub, proposed_at, request_id ON label_changes
BEGIN
  SELECT RAISE(ABORT, 'label_changes: a version is never edited');
END;

-- Versions are kept 60 months, as app_changes (D90).
CREATE TRIGGER label_changes_no_early_delete BEFORE DELETE ON label_changes
WHEN OLD.proposed_at >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'label_changes rows are kept 60 months');
END;

CREATE TRIGGER label_control_log_no_update BEFORE UPDATE ON label_control_log
BEGIN
  SELECT RAISE(ABORT, 'label_control_log is append-only');
END;

CREATE TRIGGER label_control_log_no_early_delete BEFORE DELETE ON label_control_log
WHEN OLD.at >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'label_control_log rows are kept 60 months');
END;

-- security_events gains the partner labels' three kinds: a change proposed, blocked by staff, in force (D894).
CREATE TABLE security_events_new (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low', 'home_budget_high', 'near_relay_budget_high', 'near_relay_balance_low', 'evm_relay_budget_high', 'evm_relay_balance_low', 'evm_relay_stuck', 'evm_relay_receipt_odd', 'evm_relay_nonce_taken', 'evm_billing_late', 'evm_relay_closed_slot_mined', 'near_billing_late', 'neon_compute_high', 'evm_relay_auto_resumed', 'label_proposed', 'label_blocked', 'label_live')),
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
