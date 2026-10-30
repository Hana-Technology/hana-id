-- CONSOLE_DB (hana-id-console-<env>): the partner console's own data, bound only by the console Worker
-- (docs/batch-c-spec.md "CONSOLE_DB"). All times are integer milliseconds UTC. No staff table and no org-to-app
-- table: which app belongs to which org lives only in the hot DB (apps.org_id through scopes.org_id). Tokens, cookies
-- and link tokens are stored only as sha256; Google ID tokens never.

CREATE TABLE orgs (
  id           TEXT PRIMARY KEY,                -- org_…; 'org_legacy' below
  name         TEXT NOT NULL,
  kind         TEXT NOT NULL DEFAULT 'partner' CHECK (kind IN ('partner', 'internal')),  -- the passkey gate (Deferred)
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen')),    -- frozen: console writes refused
  required_hd  TEXT,                            -- optional Workspace domain; the login token's hd must equal it
  created_at   INTEGER NOT NULL,
  contract_ref TEXT,
  billing_email TEXT                            -- statements go to it too
);

-- Every scope the hot DB had before batch C belongs to org_legacy until Hana assigns it (AdminRpc.assignScopeOrg).
INSERT INTO orgs (id, name, kind, created_at) VALUES ('org_legacy', 'Legacy apps', 'internal', CAST(strftime('%s', 'now') AS INTEGER) * 1000);

CREATE TABLE console_users (
  id              TEXT PRIMARY KEY,             -- usr_…
  provider        TEXT NOT NULL,
  sub             TEXT NOT NULL,                -- in clear: it must equal the on-chain Owner::Oidc
  email           TEXT NOT NULL CHECK (email = lower(email)),  -- display only, never identity
  created_at      INTEGER NOT NULL,
  last_sign_in_at INTEGER,
  disabled_at     INTEGER,
  UNIQUE (provider, sub)
);

CREATE TABLE members (                          -- every org with members keeps at least one owner (enforced in code)
  org_id     TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  role_since INTEGER NOT NULL,
  added_by   TEXT NOT NULL,
  added_at   INTEGER NOT NULL,
  PRIMARY KEY (org_id, user_id)
);
CREATE INDEX members_user ON members (user_id);

CREATE TABLE invites (
  id                TEXT PRIMARY KEY,           -- inv_…
  token_hash        BLOB UNIQUE CHECK (token_hash IS NULL OR length(token_hash) = 32),  -- NULL until the notice is accepted
  email_norm        TEXT NOT NULL CHECK (email_norm = lower(email_norm)),               -- no dot/plus normalisation
  org_id            TEXT,
  new_org_name      TEXT,                       -- exactly one of org_id / new_org_name; staff only
  role              TEXT NOT NULL CHECK (role IN ('owner', 'viewer')),
  created_by_kind   TEXT NOT NULL CHECK (created_by_kind IN ('member', 'hana')),
  created_by        TEXT NOT NULL,              -- user id (with step_up_id) or staff Access sub
  step_up_id        TEXT,                       -- member invites: the pending action that authorised it
  notified_at       INTEGER,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,           -- created_at + 7 d
  accepted_at       INTEGER,
  accepted_user_id  TEXT,
  accepted_by_sub   TEXT,
  revoked_at        INTEGER,
  expired_logged_at INTEGER,
  CHECK ((org_id IS NULL) <> (new_org_name IS NULL)),
  CHECK ((created_by_kind = 'member') = (step_up_id IS NOT NULL)),
  CHECK (created_by_kind = 'hana' OR new_org_name IS NULL),
  CHECK ((token_hash IS NULL) = (notified_at IS NULL)),
  CHECK (expires_at > created_at),
  CHECK ((accepted_at IS NULL) = (accepted_user_id IS NULL) AND (accepted_at IS NULL) = (accepted_by_sub IS NULL))
);
CREATE INDEX invites_org_open ON invites (org_id, accepted_at, revoked_at);
CREATE INDEX invites_unnotified ON invites (notified_at);
CREATE INDEX invites_expires ON invites (expires_at);

CREATE TABLE owner_grants (                     -- D89: a new owner of an org that has one is a viewer until owner_from
  id                TEXT PRIMARY KEY,           -- og_…
  org_id            TEXT NOT NULL,
  user_id           TEXT,                       -- NULL until the owner invite is accepted
  invite_id         TEXT UNIQUE,                -- an owner invite; NULL for a promotion of a viewer
  granted_by_kind   TEXT NOT NULL CHECK (granted_by_kind IN ('member', 'hana')),
  granted_by        TEXT NOT NULL,
  step_up_id        TEXT,
  created_at        INTEGER NOT NULL,
  notified_at       INTEGER,                    -- the blocking notice was accepted
  owner_from        INTEGER,                    -- acceptance (invite) or notified_at (promotion) + ownerGrantDelayMs
  cancel_token_hash BLOB UNIQUE CHECK (cancel_token_hash IS NULL OR length(cancel_token_hash) = 32),
  cancelled_at      INTEGER,
  cancelled_by      TEXT,
  applied_at        INTEGER,                    -- the console cron set members.role = 'owner'
  CHECK (invite_id IS NOT NULL OR user_id IS NOT NULL),   -- a promotion names its user from the start
  CHECK ((granted_by_kind = 'member') = (step_up_id IS NOT NULL)),
  CHECK (owner_from IS NULL OR user_id IS NOT NULL),
  CHECK (NOT (cancelled_at IS NOT NULL AND applied_at IS NOT NULL))
);
CREATE INDEX owner_grants_org ON owner_grants (org_id, cancelled_at, applied_at);
CREATE INDEX owner_grants_due ON owner_grants (applied_at, cancelled_at, owner_from);

CREATE TABLE auth_flows (
  state_hash        BLOB PRIMARY KEY CHECK (length(state_hash) = 32),    -- sha256(state); state is 32 random bytes
  start_hash        BLOB NOT NULL UNIQUE CHECK (length(start_hash) = 32),-- sha256(f), the handle in <authOrigin>/start?f=
  purpose           TEXT NOT NULL CHECK (purpose IN ('login', 'step_up')),
  pre_cookie_hash   BLOB,                       -- login: __Host-hana_pre on the console origin
  af_cookie_hash    BLOB,                       -- __Host-hana_af on the auth origin, set by /start
  pkce_verifier     TEXT NOT NULL,              -- server-side; S256 challenge sent to Google
  nonce             TEXT NOT NULL,
  scope             TEXT NOT NULL CHECK (scope IN ('openid email', 'openid')),
  invite_id         TEXT,
  pending_action_id TEXT,
  login_hint        TEXT,
  created_at        INTEGER NOT NULL,
  expires_at        INTEGER NOT NULL,           -- + 5 min
  started_at        INTEGER,
  used_at           INTEGER,
  CHECK ((purpose = 'login') = (pre_cookie_hash IS NOT NULL)),
  CHECK ((purpose = 'step_up') = (pending_action_id IS NOT NULL AND scope = 'openid')),
  CHECK (purpose = 'step_up' OR scope = 'openid email'),   -- a login needs the verified email; a step-up never gets it
  CHECK (purpose = 'login' OR invite_id IS NULL),
  CHECK (used_at IS NULL OR started_at IS NOT NULL)
);
CREATE INDEX auth_flows_expires ON auth_flows (expires_at);

CREATE TABLE handoff_codes (
  code_hash   BLOB PRIMARY KEY CHECK (length(code_hash) = 32),
  state_hash  BLOB NOT NULL,
  result_json TEXT NOT NULL CHECK (json_valid(result_json)),  -- allowlisted: user id, invite outcome; never a token
  expires_at  INTEGER NOT NULL,               -- + 60 s
  used_at     INTEGER
);
CREATE INDEX handoff_codes_expires ON handoff_codes (expires_at);

CREATE TABLE console_sessions (
  id_hash             BLOB PRIMARY KEY CHECK (length(id_hash) = 32),  -- sha256 of the 32-byte cookie value
  user_id             TEXT NOT NULL,
  hd                  TEXT,
  auth_at             INTEGER NOT NULL,
  last_seen_at        INTEGER NOT NULL,         -- written at most every 5 min
  absolute_expires_at INTEGER NOT NULL,         -- auth_at + 12 h
  revoked_at          INTEGER,
  country             TEXT,                     -- staff-only forensics, 90 days (D93)
  asn                 INTEGER,
  ip_prefix           TEXT,                     -- /24 or /48, never a full address
  CHECK (absolute_expires_at > auth_at)
);
CREATE INDEX console_sessions_user ON console_sessions (user_id);
CREATE INDEX console_sessions_expires ON console_sessions (absolute_expires_at);

CREATE TABLE pending_actions (
  id                TEXT PRIMARY KEY,           -- act_…
  user_id           TEXT NOT NULL,
  session_hash      BLOB NOT NULL CHECK (length(session_hash) = 32),
  org_id            TEXT NOT NULL,
  kind              TEXT NOT NULL CHECK (kind IN ('origin.add', 'policy.set', 'raw_sign.on', 'app.resume', 'app.settings',
                                                  'owner_action', 'member.invite', 'member.role', 'member.remove', 'org.policy')),
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
CREATE INDEX pending_actions_expires ON pending_actions (expires_at);

CREATE TABLE logo_objects (                     -- every LOGOS object the console wrote, for the 30-day purge
  key         TEXT PRIMARY KEY,
  app_id      TEXT NOT NULL,
  created_at  INTEGER NOT NULL,
  replaced_at INTEGER
);
CREATE INDEX logo_objects_replaced ON logo_objects (replaced_at);

CREATE TABLE audit_log (
  seq          INTEGER PRIMARY KEY,
  at           INTEGER NOT NULL,
  actor_kind   TEXT NOT NULL CHECK (actor_kind IN ('member', 'hana', 'system', 'link')),
  actor_id     TEXT NOT NULL,
  actor_email  TEXT,
  actor_sub    TEXT,
  org_id       TEXT,
  app_id       TEXT,
  action       TEXT NOT NULL,
  target       TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),  -- allowlisted: no tokens, secrets, cookies or full IPs
  step_up_id   TEXT,
  request_id   TEXT NOT NULL,
  near_tx      TEXT,
  ip_prefix    TEXT,
  country      TEXT,
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'failed'))
);
CREATE INDEX audit_log_org_seq ON audit_log (org_id, seq);

-- Append-only (D90): no row changes; a row can be deleted only once it is more than 60 months old (the monthly
-- retention job, StaffRpc.purgeAudit).
CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit_log is append-only');
END;

CREATE TRIGGER audit_log_no_early_delete BEFORE DELETE ON audit_log
WHEN OLD.at >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'audit_log rows are kept 60 months');
END;
