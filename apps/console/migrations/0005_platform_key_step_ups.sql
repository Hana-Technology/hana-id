-- D918: three more step-up kinds for platform keys (piece P2 of docs/partner-platform-spec.md): an on-chain owner of
-- each scope registers a key (`platform.key_add`), accepts a staff-registered one (`platform.key_accept`, which counts
-- as its confirmation), or confirms a waiting one so it is in force at once (`platform.key_confirm`). Revoking and
-- cancelling a key are immediate owner routes with no fresh sign-in, so they have no kind. SQLite can't widen a CHECK
-- in place, so `pending_actions` is rebuilt as 0004 did, every row and column kept (rows live 5 minutes; nothing
-- references them by foreign key: `auth_flows` keeps the id as text; no trigger or view reads the table, which the
-- migration test checks in `sqlite_schema`). Applied by the Tech Lead only (docs/operations.md), before a console that
-- offers the kinds.
CREATE TABLE pending_actions_new (
  id                TEXT PRIMARY KEY,           -- act_…
  user_id           TEXT NOT NULL,
  session_hash      BLOB NOT NULL CHECK (length(session_hash) = 32),
  org_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('origin.add', 'policy.set', 'raw_sign.on', 'app.resume', 'app.settings', 'owner_action', 'member.invite', 'member.role', 'member.remove', 'org.policy', 'labels.set', 'labels.remove', 'platform.key_add', 'platform.key_accept', 'platform.key_confirm')),
  action_json       TEXT NOT NULL CHECK (json_valid(action_json)),  -- canonical JSON; the server applies exactly this
  digest            BLOB NOT NULL CHECK (length(digest) = 32),
  google_nonce      TEXT NOT NULL,
  scope_id          TEXT,                       -- owner actions only
  near_action_nonce INTEGER,
  near_args         BLOB,
  used_at           INTEGER,
  outcome           TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,           -- + 5 min
  request_id        TEXT NOT NULL,
  CHECK ((kind = 'owner_action') = (scope_id IS NOT NULL AND near_action_nonce IS NOT NULL AND near_args IS NOT NULL))
);
INSERT INTO pending_actions_new (id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, used_at, outcome, created_at, expires_at, request_id)
  SELECT id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, used_at, outcome, created_at, expires_at, request_id FROM pending_actions;

-- The copy checks itself before anything is dropped (as the API's 0027 does): every row of each side is in the other
-- (EXCEPT compares every column, NULLs as equal, and an integer never equals its text) and the counts are equal. A
-- difference inserts 0, the CHECK refuses it, and the whole file rolls back with the old table untouched.
CREATE TABLE pending_actions_copy_check (ok INTEGER NOT NULL CHECK (ok = 1));
INSERT INTO pending_actions_copy_check (ok)
  SELECT NOT EXISTS (SELECT * FROM pending_actions EXCEPT SELECT * FROM pending_actions_new)
     AND NOT EXISTS (SELECT * FROM pending_actions_new EXCEPT SELECT * FROM pending_actions)
     AND (SELECT COUNT(*) FROM pending_actions) = (SELECT COUNT(*) FROM pending_actions_new);
DROP TABLE pending_actions_copy_check;

DROP TABLE pending_actions;
ALTER TABLE pending_actions_new RENAME TO pending_actions;
CREATE INDEX pending_actions_expires ON pending_actions (expires_at);
