-- Hana Home batch H4 (docs/hana-home-spec.md "Consents and devices"; D45, D98, D465, D510): the server's record of each
-- auto-approve consent, so another device (Hana Home, H9) can see and stop it. A row can only stop auto-signing, never
-- start it: the vault still needs the sealed consent the user's guarded Allow created. No `sub`, address, key or token.

-- A coarse device label ("Chrome on macOS") sent by the vault at share creation (D98 item 10). Deleted with the share.
ALTER TABLE vault_shares ADD COLUMN device_label TEXT;
-- Home (H9) reads a user's shares across a scope's apps by path hash; vault_shares_app_path leads with app_id.
CREATE INDEX vault_shares_path_hash ON vault_shares (path_hash);

-- One row per consent. Active when revoked_at IS NULL, now < expires_at and its share (if any) is live.
-- share_id has no foreign key on purpose: a share's row is pruned on its own schedule (D178), and a consent whose share
-- row is gone reads 'revoked'. `ON DELETE SET NULL` would turn it into a live-looking 'none'-mode consent.
CREATE TABLE vault_consents (
  consent_id     BLOB PRIMARY KEY,                -- 16 random bytes, made by the vault at Allow
  app_id         TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  share_id       BLOB,                            -- the share it lives under ('session' mode); NULL in 'none' mode
  session_pk     BLOB NOT NULL,                   -- 32-byte Ed25519 session public key
  path_hash      BLOB NOT NULL,                   -- copied from the share, or sha256(utf8(get_session().path)) in 'none' mode
  partner_origin TEXT NOT NULL,                   -- the parent origin the consent was granted for
  policy_id      BLOB NOT NULL,                   -- 32 bytes: the policy in force at registration
  label          TEXT NOT NULL,                   -- that policy's label (at most 80 chars); rendered as text only
  granted_at     INTEGER NOT NULL,                -- unix ms
  expires_at     INTEGER NOT NULL,                -- unix ms: the consent's own end, at most the session's
  revoked_at     INTEGER,                         -- unix ms
  revoked_by     TEXT CHECK (revoked_by IN ('device', 'home', 'share')),
  CHECK ((revoked_at IS NULL) = (revoked_by IS NULL))
);

-- At most one active consent per session key: registering a new one revokes the previous in the same batch.
CREATE UNIQUE INDEX vault_consents_one_active ON vault_consents (session_pk) WHERE revoked_at IS NULL;
CREATE INDEX vault_consents_path_hash ON vault_consents (path_hash);
CREATE INDEX vault_consents_expires_at ON vault_consents (expires_at);
CREATE INDEX vault_consents_revoked_at ON vault_consents (revoked_at) WHERE revoked_at IS NOT NULL;
