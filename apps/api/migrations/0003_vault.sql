-- Batch B vault (docs/batch-b-spec.md "Data, secrets, code"): per-app vault settings, unlock usage, and the server-held
-- shares that let a vault reopen its key after a reload. The admin CLI and the API check the same ranges as the CHECKs.

-- Key persistence: 'session' keeps the wallet across reloads through a vault share; 'none' never stores one.
ALTER TABLE apps ADD COLUMN persistence TEXT NOT NULL DEFAULT 'session' CHECK (persistence IN ('session', 'none'));
-- Absolute session and share lifetime: 1 h to 23 h 50 min (10 min under the contract's 24 h cap). Default 12 h.
ALTER TABLE apps ADD COLUMN session_ttl_ms INTEGER NOT NULL DEFAULT 43200000 CHECK (session_ttl_ms BETWEEN 3600000 AND 85800000);
-- Share idle limit: 15 min to session_ttl_ms. Default 2 h.
ALTER TABLE apps ADD COLUMN idle_ttl_ms INTEGER NOT NULL DEFAULT 7200000 CHECK (idle_ttl_ms >= 900000 AND idle_ttl_ms <= session_ttl_ms);
-- Raw signing: 'off' takes effect at once; 'approval' is written as pending and applies from raw_sign_effective_at.
ALTER TABLE apps ADD COLUMN raw_sign TEXT NOT NULL DEFAULT 'off' CHECK (raw_sign IN ('off', 'approval'));
ALTER TABLE apps ADD COLUMN raw_sign_pending TEXT CHECK (raw_sign_pending IN ('approval'));
ALTER TABLE apps ADD COLUMN raw_sign_effective_at INTEGER CHECK ((raw_sign_effective_at IS NULL) = (raw_sign_pending IS NULL)); -- unix ms
-- Auto-approve policy (AutoApprovePolicyV1 JSON, validated by @hana-id/core before it is written). Removal is
-- immediate; a new or changed policy is written as pending and applies from auto_approve_effective_at.
ALTER TABLE apps ADD COLUMN auto_approve_policy TEXT CHECK (auto_approve_policy IS NULL OR json_valid(auto_approve_policy));
ALTER TABLE apps ADD COLUMN auto_approve_pending TEXT CHECK (auto_approve_pending IS NULL OR json_valid(auto_approve_pending));
ALTER TABLE apps ADD COLUMN auto_approve_effective_at INTEGER CHECK ((auto_approve_effective_at IS NULL) = (auto_approve_pending IS NULL)); -- unix ms
-- The scope's Google web client for the implicit flow (null: the scope's first Google client).
ALTER TABLE apps ADD COLUMN google_web_client_id TEXT;

ALTER TABLE usage ADD COLUMN unlocks INTEGER NOT NULL DEFAULT 0; -- successful POST /v1/vault/unlock

-- One row per vault share. share_enc = iv (12) ‖ AES-GCM(VAULT_KEK #kek_id, iv, K_s, aad = share_id ‖ app_id ‖
-- session_pk): D1 never holds K_s in the clear. counter is the last vault-message counter used (the next is
-- counter + 1). Rows past abs_expires_at or revoked are pruned by the hourly cron.
CREATE TABLE vault_shares (
  share_id       BLOB PRIMARY KEY,                -- 16 random bytes
  app_id         TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  session_pk     BLOB NOT NULL UNIQUE,            -- 32-byte Ed25519 session public key: one share per session key
  path_hash      BLOB NOT NULL,                   -- sha256(utf8(path)), path from get_session at creation
  partner_origin TEXT NOT NULL,                   -- the parent origin the share was created for
  share_enc      BLOB NOT NULL,
  kek_id         INTEGER NOT NULL,
  counter        INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,                -- unix ms
  idle_until     INTEGER NOT NULL,                -- unix ms
  abs_expires_at INTEGER NOT NULL,                -- unix ms
  revoked_at     INTEGER                          -- unix ms
);

CREATE INDEX vault_shares_app_path ON vault_shares (app_id, path_hash);
CREATE INDEX vault_shares_abs_expires_at ON vault_shares (abs_expires_at);
CREATE INDEX vault_shares_kek_id ON vault_shares (kek_id);
