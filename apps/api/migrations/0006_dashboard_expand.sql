-- Batch C hot-DB expand (docs/batch-c-spec.md §Hot DB "Migration 0006"; build plan C3). Expand-only: ADD COLUMN and
-- new tables, never a rebuild of `apps`. A SQLite rebuild runs an implicit DELETE FROM apps, which would fire the
-- ON DELETE CASCADE of app_origins, usage, vault_shares and identity_usage (0001, 0003, 0008) and wipe them.
-- `apps.status` and `apps.publishable_key` stay, kept consistent by the triggers below; dropping them is deferred.
--
-- Numbered 0006 but written after 0008 (`0008_identity_token.sql`, its own tables only): it applies the same before or
-- after 0008, and wrangler applies the unapplied files in name order. Times are integer ms UTC.

-- ---- Scopes: one org and one environment per scope (D51) ----

CREATE TABLE scopes (
  scope_id         TEXT PRIMARY KEY,                -- contract-assigned
  org_id           TEXT NOT NULL,                   -- a scope belongs to exactly one org ...
  environment      TEXT NOT NULL CHECK (environment IN ('test', 'live')), -- ... and one environment
  first_session_at INTEGER,                         -- set once, on the first ok /v1/sessions or /v1/login the API sees
  created_at       INTEGER NOT NULL,
  assigned_at      INTEGER NOT NULL                 -- last org change; staff proposals wait appChangeDelayMs after it
);

-- ---- apps: new columns (defaults keep every existing row as it was) ----

ALTER TABLE apps ADD COLUMN org_id TEXT NOT NULL DEFAULT 'org_legacy';              -- a trigger keeps it = scopes.org_id
ALTER TABLE apps ADD COLUMN suspended_by INTEGER NOT NULL DEFAULT 0 CHECK (suspended_by BETWEEN 0 AND 7); -- hana=1, org=2, partner=4
ALTER TABLE apps ADD COLUMN origins_version INTEGER NOT NULL DEFAULT 0;             -- bumped when the set of origin rows changes
ALTER TABLE apps ADD COLUMN settings_version INTEGER NOT NULL DEFAULT 0;            -- bumped by every settings write
ALTER TABLE apps ADD COLUMN logo_key TEXT;                                          -- R2 key in LOGOS, or NULL
ALTER TABLE apps ADD COLUMN deleted_at INTEGER;                                     -- soft delete (AdminRpc.deleteApp)

-- ---- Publishable keys (secret keys: deferred) ----

CREATE TABLE app_keys (
  id         TEXT PRIMARY KEY,                      -- key_…; key_legacy_<app id> for the keys apps had before 0006
  app_id     TEXT NOT NULL,                         -- no FK to apps (see the top); the insert trigger checks it
  key        TEXT NOT NULL UNIQUE,                  -- pk_test_|pk_live_ + base58; public by design
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  revoked_at INTEGER,                               -- may be in the future: the rotation grace's end
  revoked_by TEXT
);

-- ---- Origins: announced (active_from) and explained (change_id) ----

ALTER TABLE app_origins ADD COLUMN active_from INTEGER;  -- NULL = not yet announced (never matches); 0 = migrated
ALTER TABLE app_origins ADD COLUMN change_id TEXT;       -- guarded_changes.id

-- ---- Guarded changes: origin adds, policy sets, raw-signing enables (one lifecycle) ----

CREATE TABLE guarded_changes (
  id                    TEXT PRIMARY KEY,           -- gc_…
  app_id                TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('origin_add', 'policy_set', 'raw_sign_on')),
  origin                TEXT,                       -- origin_add: ASCII (punycode) form
  policy_json           TEXT,                       -- policy_set: canonical JSON (validated)
  policy_id             TEXT,                       -- policy_set: its policyId (hex)
  status                TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'ended')),
  proposed_by_kind      TEXT NOT NULL CHECK (proposed_by_kind IN ('member', 'hana', 'system')),
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

-- ---- The append-only change ledger: one row per applied write (the CAS commit point) ----

CREATE TABLE app_changes (
  seq         INTEGER PRIMARY KEY,
  at          INTEGER NOT NULL,
  org_id      TEXT NOT NULL,
  app_id      TEXT,
  scope_id    TEXT,
  kind        TEXT NOT NULL,                        -- app.*|origin.*|policy.*|raw_sign.*|settings.*|key.*|suspension.*|
                                                    -- scope.assigned|org.security_contacts|change.*|migration.baseline
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)), -- allowlisted fields only
  actor_kind  TEXT NOT NULL CHECK (actor_kind IN ('member', 'hana', 'system', 'link')),
  actor_id    TEXT NOT NULL,
  actor_sub   TEXT,                                 -- the verified step-up sub when there is one
  request_id  TEXT NOT NULL UNIQUE
);

-- ---- Security events (written by the API; the admin Worker emails and marks them) ----

CREATE TABLE security_events (
  id          TEXT PRIMARY KEY,
  detected_at INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('drift', 'breaker', 'owner_cap', 'owner_allowance_low')),
  org_id      TEXT,
  app_id      TEXT,
  scope_id    TEXT,
  detail_json TEXT NOT NULL CHECK (json_valid(detail_json)),
  notified_at INTEGER
);

-- ---- Security contacts (set only through AdminRpc, by Hana staff) ----

CREATE TABLE org_security_contacts (
  org_id   TEXT NOT NULL,
  email    TEXT NOT NULL CHECK (email = lower(email)),
  added_by TEXT NOT NULL,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, email)
);

CREATE INDEX apps_org_id ON apps (org_id);
CREATE INDEX app_keys_app_id ON app_keys (app_id);
CREATE INDEX guarded_changes_app ON guarded_changes (app_id, status);
CREATE INDEX guarded_changes_unnotified ON guarded_changes (status, notified_at);
CREATE INDEX guarded_changes_due ON guarded_changes (status, active_from);
CREATE INDEX app_changes_org_seq ON app_changes (org_id, seq);
CREATE INDEX security_events_unnotified ON security_events (notified_at);

-- ---- Backfill, in order ----

-- 1. One scope per distinct (scope_id, environment), the environment from the key prefix, in org_legacy. The times are
--    the migration's, so no existing scope gets a no_session waiver. A scope with both prefixes gives a duplicate
--    primary key, and a key with neither gives a NULL environment: either aborts the whole migration.
INSERT INTO scopes (scope_id, org_id, environment, first_session_at, created_at, assigned_at)
SELECT scope_id, 'org_legacy', environment, unixepoch('now') * 1000, unixepoch('now') * 1000, unixepoch('now') * 1000
  FROM (SELECT DISTINCT scope_id,
               CASE WHEN publishable_key LIKE 'pk\_test\_%' ESCAPE '\' THEN 'test'
                    WHEN publishable_key LIKE 'pk\_live\_%' ESCAPE '\' THEN 'live' END AS environment
          FROM apps);

-- 2. Suspended apps carry the Hana bit.
UPDATE apps SET suspended_by = 1 WHERE status = 'suspended';

-- 3. Each app's key becomes its first app_keys row.
INSERT INTO app_keys (id, app_id, key, created_by, created_at)
SELECT 'key_legacy_' || id, id, publishable_key, 'migration:0006', created_at FROM apps;

-- 4. Every existing origin is in force (0 is before any request).
UPDATE app_origins SET active_from = 0;

-- 5. One baseline per app, so drift detection can explain what it holds: its origins, the stored policies (as stored:
--    SQL can't compute a policyId, which the reader derives from the JSON) and the raw-signing values.
INSERT INTO app_changes (at, org_id, app_id, scope_id, kind, detail_json, actor_kind, actor_id, request_id)
SELECT unixepoch('now') * 1000, a.org_id, a.id, a.scope_id, 'migration.baseline',
       json_object(
         'origins', (SELECT json_group_array(origin) FROM (SELECT origin FROM app_origins WHERE app_id = a.id ORDER BY origin)),
         'autoApprovePolicy', a.auto_approve_policy,
         'autoApprovePending', a.auto_approve_pending,
         'autoApproveEffectiveAt', a.auto_approve_effective_at,
         'rawSign', a.raw_sign,
         'rawSignPending', a.raw_sign_pending,
         'rawSignEffectiveAt', a.raw_sign_effective_at,
         'suspendedBy', a.suspended_by),
       'system', 'migration:0006', 'migration-0006:' || a.id
  FROM apps a ORDER BY a.created_at, a.id;

-- ---- Triggers (created after the backfill, which satisfies every one of them) ----

-- An app's scope row exists, in the app's org, with the environment its key's prefix names (test and live apps never
-- share a scope, D51).
CREATE TRIGGER apps_scope_insert BEFORE INSERT ON apps
BEGIN
  SELECT RAISE(ABORT, 'apps: no scopes row for this scope in this org')
   WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id AND org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'apps: the key prefix does not match the scope environment')
   WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id
                      AND NEW.publishable_key LIKE 'pk\_' || environment || '\_%' ESCAPE '\');
END;

CREATE TRIGGER apps_scope_update BEFORE UPDATE OF org_id, scope_id ON apps
BEGIN
  SELECT RAISE(ABORT, 'apps: no scopes row for this scope in this org')
   WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id AND org_id = NEW.org_id);
  SELECT RAISE(ABORT, 'apps: the key prefix does not match the scope environment')
   WHERE NOT EXISTS (SELECT 1 FROM scopes WHERE scope_id = NEW.scope_id
                      AND NEW.publishable_key LIKE 'pk\_' || environment || '\_%' ESCAPE '\');
END;

-- Moving a scope to another org moves every app of it, in the same statement.
CREATE TRIGGER scopes_org_update AFTER UPDATE OF org_id ON scopes
BEGIN
  UPDATE apps SET org_id = NEW.org_id WHERE scope_id = NEW.scope_id;
END;

-- A scope's environment never changes: its keys and its users' addresses are test or live for good.
CREATE TRIGGER scopes_environment_fixed BEFORE UPDATE OF environment ON scopes
WHEN NEW.environment IS NOT OLD.environment
BEGIN
  SELECT RAISE(ABORT, 'scopes: environment is fixed');
END;

-- The legacy status follows the bitmask (the gate reads both).
CREATE TRIGGER apps_suspended_by AFTER UPDATE OF suspended_by ON apps
BEGIN
  UPDATE apps SET status = CASE WHEN NEW.suspended_by = 0 THEN 'active' ELSE 'suspended' END WHERE id = NEW.id;
END;

-- A key belongs to an existing app, and its prefix matches the app's scope's environment.
CREATE TRIGGER app_keys_insert BEFORE INSERT ON app_keys
BEGIN
  SELECT RAISE(ABORT, 'app_keys: no such app') WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id);
  SELECT RAISE(ABORT, 'app_keys: the key prefix does not match the scope environment')
   WHERE NOT EXISTS (SELECT 1 FROM apps a JOIN scopes s ON s.scope_id = a.scope_id
                      WHERE a.id = NEW.app_id AND NEW.key LIKE 'pk\_' || s.environment || '\_%' ESCAPE '\');
END;

CREATE TRIGGER app_origins_insert BEFORE INSERT ON app_origins
BEGIN
  SELECT RAISE(ABORT, 'app_origins: no such app') WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id);
END;

CREATE TRIGGER guarded_changes_insert BEFORE INSERT ON guarded_changes
BEGIN
  SELECT RAISE(ABORT, 'guarded_changes: no such app') WHERE NOT EXISTS (SELECT 1 FROM apps WHERE id = NEW.app_id);
END;

-- app_changes is append-only; a row may be deleted only once it is 60 months old (D90).
CREATE TRIGGER app_changes_no_update BEFORE UPDATE ON app_changes
BEGIN
  SELECT RAISE(ABORT, 'app_changes is append-only');
END;

CREATE TRIGGER app_changes_no_early_delete BEFORE DELETE ON app_changes
WHEN OLD.at >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'app_changes rows are kept 60 months');
END;
