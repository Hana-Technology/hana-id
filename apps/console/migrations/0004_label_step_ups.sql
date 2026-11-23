-- D894: two more step-up kinds, a partner labels proposal (`labels.set`) and removal (`labels.remove`). SQLite can't
-- widen a CHECK in place, so `pending_actions` is rebuilt with every row kept (they live 5 minutes; nothing references
-- them by foreign key: auth_flows keeps the id as text). Applied by the founder only, before a console that offers the
-- kinds (piece 4); until then nothing writes them.
CREATE TABLE pending_actions_new (
  id                TEXT PRIMARY KEY,           -- act_…
  user_id           TEXT NOT NULL,
  session_hash      BLOB NOT NULL CHECK (length(session_hash) = 32),
  org_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('origin.add', 'policy.set', 'raw_sign.on', 'app.resume', 'app.settings', 'owner_action', 'member.invite', 'member.role', 'member.remove', 'org.policy', 'labels.set', 'labels.remove')),
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
INSERT INTO pending_actions_new SELECT id, user_id, session_hash, org_id, kind, action_json, digest, google_nonce, scope_id, near_action_nonce, near_args, used_at, outcome, created_at, expires_at, request_id FROM pending_actions;
DROP TABLE pending_actions;
ALTER TABLE pending_actions_new RENAME TO pending_actions;
CREATE INDEX pending_actions_expires ON pending_actions (expires_at);
