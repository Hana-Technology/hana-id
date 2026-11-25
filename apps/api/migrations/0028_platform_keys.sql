-- D918: platform keys (piece P2 of docs/partner-platform-spec.md, A3 and A7). Additive: two new tables and their
-- triggers; no existing table, index or trigger is touched, and nothing elsewhere reads these tables. Applied by the
-- Tech Lead on a deployed env (docs/operations.md "Platform keys (hot-DB migration 0028, D918)"); nothing writes them
-- until a console or admin Worker that offers platform keys is deployed, and nothing authenticates with a key until
-- piece P3.
--
-- A KEY (`platform_keys`) is one ECDSA P-256 public key (65 bytes, uncompressed; the private half never reaches us)
-- for one org and one or two of its test scopes, in this env only. Its life, as a guarded change of its own table
-- (keys belong to an org, not an app, so `guarded_changes` can't hold them):
--   registered by an on-chain owner of each scope (`pending`), or by staff (`awaiting_acceptance`, until an owner of
--   each scope accepts it, which counts as its confirmation, or a second staff member approves it: then `pending`);
--   announced by the admin Worker's notice (`notified_at`; `unconfirmed_active_from` = then + the greater of
--   appChangeDelayMs and the platform minimum of 24 h, `local*` test envs excepted);
--   in force at `active_from`: the unconfirmed date, or earlier only with a confirmation (an owner's, or the acceptance);
--   `active` once recorded (the hourly job, or the confirmation itself); `expired` a year after it came into force;
--   `cancelled` while it waits, `revoked` at any time. A cancelled, revoked or expired key never comes back.
-- Four eyes (D914, D917): `four_eyes` is written once at registration (1 on a mainnet env); a confirmation then never
-- names the registrant's console user, Google sub or email (the CHECK below, and the API's commit predicate). The
-- env's wait for a key nobody confirms (`min_delay_ms`, at least 24 h outside `local*` test envs, always on mainnet)
-- is written once at registration too, and the announcement's unconfirmed date can never be sooner.
-- `platform_orgs` is staff's switch per org (a missing row: off) and the mirror of a console freeze.
-- Times are integer ms UTC.

CREATE TABLE platform_keys (
  id                      TEXT PRIMARY KEY CHECK (id GLOB 'pkc_*'),
  org_id                  TEXT NOT NULL,
  label                   TEXT NOT NULL CHECK (length(label) BETWEEN 1 AND 40),
  alg                     TEXT NOT NULL CHECK (alg = 'ES256'),
  public_key              BLOB NOT NULL UNIQUE CHECK (length(public_key) = 65 AND substr(public_key, 1, 1) = x'04'),
  thumbprint              TEXT NOT NULL UNIQUE CHECK (length(thumbprint) = 43 AND thumbprint NOT GLOB '*[^A-Za-z0-9_-]*'),
  scopes_json             TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_type(scopes_json) = 'array' AND json_array_length(scopes_json) BETWEEN 1 AND 2),
  status                  TEXT NOT NULL CHECK (status IN ('awaiting_acceptance', 'pending', 'active', 'cancelled', 'revoked', 'expired')),
  proposed_by_kind        TEXT NOT NULL CHECK (proposed_by_kind IN ('hana', 'member')),
  proposed_by             TEXT NOT NULL,          -- the member's console user id, or the staff member's Access sub
  proposer_sub            TEXT,                   -- the API-verified step-up's Google sub (a member only)
  proposer_email_key      TEXT,                   -- the registrant's email as four eyes compares it (console-core personEmailKey)
  proposer_email          TEXT,                   -- a staff registrant's email, for the notice (members' are the console's)
  proposal_note           TEXT,                   -- staff: how the thumbprint was checked with the network
  proposed_at             INTEGER NOT NULL,
  accepted_by_kind        TEXT CHECK (accepted_by_kind IN ('hana', 'member')),
  accepted_by             TEXT,
  accepted_sub            TEXT,                   -- a member's acceptance: its step-up's sub
  accepted_email          TEXT,                   -- a second staff member's email, for the notice
  accepted_email_key      TEXT,
  accept_note             TEXT,                   -- a second staff member's reason
  accepted_at             INTEGER,
  notified_at             INTEGER,                -- the announcement was accepted for every recipient (the ack)
  unconfirmed_active_from INTEGER,                -- written by the ack: when it comes into force if nobody confirms it
  active_from             INTEGER,                -- when it is in force: unconfirmed_active_from, or a confirmation's time
  expires_at              INTEGER,                -- active_from + 365 days
  activated_recorded_at   INTEGER,                -- the hourly job (or the confirmation) recorded it in force
  cancel_token_hash       BLOB UNIQUE CHECK (cancel_token_hash IS NULL OR length(cancel_token_hash) = 32),
  four_eyes               INTEGER NOT NULL CHECK (four_eyes IN (0, 1)),
  min_delay_ms            INTEGER NOT NULL CHECK (min_delay_ms >= 60000), -- written once at registration: the env's wait for an unconfirmed key
  confirmed_kind          TEXT CHECK (confirmed_kind IN ('confirm', 'acceptance')),
  confirmed_by            TEXT,                   -- the confirming (or accepting) member's console user id
  confirmed_sub           TEXT,                   -- its step-up's sub
  confirmed_email_key     TEXT,
  confirmed_at            INTEGER,
  confirm_notified_at     INTEGER,                -- the notice of a confirmation (or the announcement of a key in force at once)
  revoke_link_hash        BLOB UNIQUE CHECK (revoke_link_hash IS NULL OR length(revoke_link_hash) = 32),
  revoke_link_until       INTEGER,
  cancelled_at            INTEGER,
  cancelled_by_kind       TEXT CHECK (cancelled_by_kind IN ('member', 'hana', 'system', 'link')),
  cancelled_by            TEXT,
  cancel_reason           TEXT,
  revoked_at              INTEGER,
  revoked_by_kind         TEXT CHECK (revoked_by_kind IN ('member', 'hana', 'system', 'link', 'platform')),
  revoked_by              TEXT,
  revoke_reason           TEXT,
  end_request_id          TEXT,                   -- the revocation's (or expiry's) request id: its notice lists what it cancelled
  end_notified_at         INTEGER,                -- the notice that the key stopped (revoked or expired)
  expiry_notice_stage     INTEGER NOT NULL DEFAULT 0 CHECK (expiry_notice_stage IN (0, 30, 7)),
  last_used_at            INTEGER,                -- piece P3: at most once an hour per key
  request_id              TEXT NOT NULL UNIQUE,
  -- A member registers with a verified step-up; staff without one, and with their reason.
  CHECK ((proposed_by_kind = 'member') = (proposer_sub IS NOT NULL)),
  CHECK (proposed_by_kind = 'hana' OR (proposer_email IS NULL AND proposal_note IS NULL)),
  CHECK (proposed_by_kind = 'member' OR proposal_note IS NOT NULL),
  -- Only a staff key is accepted (by a member) or approved (by a second staff member, never the registrant).
  CHECK (accepted_by_kind IS NULL OR proposed_by_kind = 'hana'),
  CHECK (accepted_by_kind IS NULL OR accepted_by_kind = 'member' OR accepted_by IS NOT proposed_by),
  CHECK ((accepted_by_kind IS NULL) = (accepted_by IS NULL) AND (accepted_by_kind IS NULL) = (accepted_at IS NULL)),
  CHECK ((accepted_by_kind IS 'member') = (accepted_sub IS NOT NULL)),
  CHECK (accepted_by_kind IS NOT 'hana' OR (accept_note IS NOT NULL AND accepted_email_key IS NOT proposer_email_key)),
  -- A staff key is used only once accepted or approved (or never, once cancelled or revoked).
  CHECK (proposed_by_kind = 'member' OR status IN ('awaiting_acceptance', 'cancelled', 'revoked') OR accepted_at IS NOT NULL),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL) AND (confirmed_at IS NULL) = (confirmed_sub IS NULL)
         AND (confirmed_at IS NULL) = (confirmed_kind IS NULL)),
  CHECK (confirmed_kind IS NOT 'acceptance' OR (accepted_by_kind IS 'member' AND confirmed_by IS accepted_by AND confirmed_sub IS accepted_sub)),
  -- Four eyes, in the database: never the registrant's own console user, Google account or email.
  CHECK (four_eyes = 0 OR confirmed_at IS NULL
         OR (confirmed_by IS NOT proposed_by AND confirmed_sub IS NOT proposer_sub AND confirmed_email_key IS NOT proposer_email_key)),
  -- In force only once announced; the unconfirmed date always written with the announcement.
  CHECK (active_from IS NULL OR (notified_at IS NOT NULL AND unconfirmed_active_from IS NOT NULL AND expires_at IS NOT NULL)),
  CHECK ((notified_at IS NULL) = (unconfirmed_active_from IS NULL)),
  CHECK (unconfirmed_active_from IS NULL OR unconfirmed_active_from >= notified_at + min_delay_ms),
  -- A real-money setup always waits at least the 24 h platform minimum for an unconfirmed key.
  CHECK (four_eyes = 0 OR min_delay_ms >= 86400000),
  CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (status NOT IN ('active', 'expired') OR activated_recorded_at IS NOT NULL),
  CHECK ((revoke_link_hash IS NULL) = (revoke_link_until IS NULL))
);

CREATE INDEX platform_keys_org ON platform_keys (org_id, status);
CREATE INDEX platform_keys_unnotified ON platform_keys (status, notified_at);
CREATE INDEX platform_keys_due ON platform_keys (status, active_from);
CREATE INDEX platform_keys_expiry ON platform_keys (status, expires_at);

-- A key's scopes are test scopes of its org (a scope belongs to one org, D51), and a key starts as its registrant left it.
CREATE TRIGGER platform_keys_insert BEFORE INSERT ON platform_keys
BEGIN
  SELECT RAISE(ABORT, 'platform_keys: every scope must be a test scope of this org, named once')
   WHERE EXISTS (SELECT 1 FROM json_each(NEW.scopes_json) j
                  WHERE j.type IS NOT 'text' OR NOT EXISTS (SELECT 1 FROM scopes s WHERE s.scope_id = j.value AND s.org_id = NEW.org_id AND s.environment = 'test'))
      OR (SELECT COUNT(DISTINCT value) FROM json_each(NEW.scopes_json)) != json_array_length(NEW.scopes_json);
  SELECT RAISE(ABORT, 'platform_keys: a key starts waiting (a member registration) or awaiting acceptance (a staff one)')
   WHERE NEW.status IS NOT (CASE NEW.proposed_by_kind WHEN 'member' THEN 'pending' ELSE 'awaiting_acceptance' END)
      OR NEW.accepted_at IS NOT NULL OR NEW.notified_at IS NOT NULL OR NEW.active_from IS NOT NULL OR NEW.confirmed_at IS NOT NULL
      OR NEW.cancel_token_hash IS NOT NULL OR NEW.revoke_link_hash IS NOT NULL OR NEW.activated_recorded_at IS NOT NULL;
END;

-- What a key is, who registered it, and the four-eyes mark are written once.
CREATE TRIGGER platform_keys_fixed BEFORE UPDATE OF id, org_id, label, alg, public_key, thumbprint, scopes_json, proposed_by_kind, proposed_by, proposer_sub, proposer_email_key, proposer_email, proposal_note, proposed_at, four_eyes, min_delay_ms, request_id ON platform_keys
BEGIN
  SELECT RAISE(ABORT, 'platform_keys: a key, its registrant and its four-eyes mark are never changed');
END;

-- The acceptance and the confirmation are written once: a confirmation only of a waiting, announced key; an acceptance
-- only of a staff key awaiting it.
CREATE TRIGGER platform_keys_confirm_fixed BEFORE UPDATE OF accepted_by_kind, accepted_by, accepted_sub, accepted_at, confirmed_kind, confirmed_by, confirmed_sub, confirmed_email_key, confirmed_at ON platform_keys
  WHEN (OLD.accepted_at IS NOT NULL AND (NEW.accepted_at IS NOT OLD.accepted_at OR NEW.accepted_by IS NOT OLD.accepted_by OR NEW.accepted_sub IS NOT OLD.accepted_sub OR NEW.accepted_by_kind IS NOT OLD.accepted_by_kind))
    OR (OLD.confirmed_at IS NOT NULL AND (NEW.confirmed_at IS NOT OLD.confirmed_at OR NEW.confirmed_by IS NOT OLD.confirmed_by OR NEW.confirmed_sub IS NOT OLD.confirmed_sub OR NEW.confirmed_kind IS NOT OLD.confirmed_kind OR NEW.confirmed_email_key IS NOT OLD.confirmed_email_key))
    OR (OLD.accepted_at IS NULL AND NEW.accepted_at IS NOT NULL AND OLD.status IS NOT 'awaiting_acceptance')
    OR (OLD.confirmed_at IS NULL AND NEW.confirmed_kind = 'confirm' AND (OLD.status IS NOT 'pending' OR OLD.notified_at IS NULL OR OLD.revoked_at IS NOT NULL OR OLD.cancelled_at IS NOT NULL))
    OR (OLD.confirmed_at IS NULL AND NEW.confirmed_kind = 'acceptance' AND OLD.status IS NOT 'awaiting_acceptance')
BEGIN
  SELECT RAISE(ABORT, 'platform_keys: the acceptance and the confirmation are written once');
END;

-- No earlier active_from without a confirmation, whoever writes it; the unconfirmed date is fixed once written.
CREATE TRIGGER platform_keys_not_early BEFORE UPDATE OF active_from, unconfirmed_active_from, confirmed_at ON platform_keys
  WHEN (NEW.active_from IS NOT NULL AND NEW.unconfirmed_active_from IS NOT NULL AND NEW.active_from < NEW.unconfirmed_active_from AND NEW.confirmed_at IS NULL)
    OR (OLD.unconfirmed_active_from IS NOT NULL AND NEW.unconfirmed_active_from IS NOT OLD.unconfirmed_active_from)
BEGIN
  SELECT RAISE(ABORT, 'platform_keys: a key comes into force early only when confirmed');
END;

-- A key's state only moves forward, and a cancelled, revoked or expired key never comes back (its id is never reused).
CREATE TRIGGER platform_keys_status_moves BEFORE UPDATE OF status ON platform_keys
  WHEN NEW.status IS NOT OLD.status AND NOT (
       (OLD.status = 'awaiting_acceptance' AND NEW.status IN ('pending', 'cancelled', 'revoked'))
    OR (OLD.status = 'pending' AND NEW.status IN ('active', 'cancelled', 'revoked'))
    OR (OLD.status = 'active' AND NEW.status IN ('revoked', 'expired')))
BEGIN
  SELECT RAISE(ABORT, 'platform_keys: a key never comes back once cancelled, revoked or expired');
END;

-- A key's row stays while it can still work, and for 60 months after it stopped (the ledger's life, D90).
CREATE TRIGGER platform_keys_no_early_delete BEFORE DELETE ON platform_keys
  WHEN OLD.status NOT IN ('cancelled', 'revoked', 'expired')
    OR MAX(COALESCE(OLD.cancelled_at, 0), COALESCE(OLD.revoked_at, 0), COALESCE(OLD.expires_at, 0)) >= (unixepoch('now', '-60 months') * 1000)
BEGIN
  SELECT RAISE(ABORT, 'platform_keys rows are kept 60 months after the key stopped');
END;

-- Staff's per-org switch and the org's quotas (a missing row: off, the defaults), and the mirror of a console freeze.
CREATE TABLE platform_orgs (
  org_id            TEXT PRIMARY KEY CHECK (org_id GLOB 'org_*'),
  enabled           INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
  frozen            INTEGER NOT NULL DEFAULT 0 CHECK (frozen IN (0, 1)),
  max_apps          INTEGER NOT NULL DEFAULT 10 CHECK (max_apps BETWEEN 0 AND 1000),
  creations_per_day INTEGER NOT NULL DEFAULT 5 CHECK (creations_per_day BETWEEN 0 AND 1000),
  proposals_per_day INTEGER NOT NULL DEFAULT 30 CHECK (proposals_per_day BETWEEN 0 AND 1000),
  set_by            TEXT NOT NULL,
  set_at            INTEGER NOT NULL,
  version           INTEGER NOT NULL DEFAULT 0
);
