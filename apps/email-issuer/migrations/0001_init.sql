-- Hana ID email issuer: its own D1 (docs/email-login-spec.md "Privacy and what is stored"). No email address is ever
-- stored here: hints and suppressions are keyed by HMACs (the email `sub` under K_sub, `email_key` under K_rl).

-- Every token the issuer minted (D90 raw usage: 24 months). The KMS reconciliation (batch 10) counts these against
-- CloudTrail's Sign events. `kid` is the first signature's key; `purpose` one of session, link_new, link_account,
-- link_change, auto_link, client_proof.
CREATE TABLE email_issuance (
  jti     TEXT PRIMARY KEY,
  app_id  TEXT,                              -- null for staff client proofs
  purpose TEXT NOT NULL,
  kid     TEXT NOT NULL,
  iat     INTEGER NOT NULL                   -- unix seconds (the token's iat)
);
CREATE INDEX email_issuance_iat ON email_issuance (iat);

-- A Google identity that reported this verified address in this scope (written at every google-match, case B's
-- lookup at verify). Kept while the scope exists (D122: an expired hint would let a matched person get a second wallet).
CREATE TABLE email_hints (
  scope_id      TEXT NOT NULL,
  email_sub     TEXT NOT NULL,               -- e1.… (the email identity's sub)
  google_sub    TEXT NOT NULL,               -- the Google identity's sub (public on chain once it logs in)
  hosted        INTEGER NOT NULL,            -- 1: the address was Google-hosted at that login (D158); 0: honoured 180 days
  updated_at_ms INTEGER NOT NULL,              -- that Google identity's last login reporting the address
  PRIMARY KEY (scope_id, email_sub, google_sub)
);

-- Addresses that bounced or complained (SendGrid's Event Webhook, the issuer's own mail only): no mail goes to them;
-- `start` still answers alike. A bounce lapses after 30 days; a complaint lasts until a staff unsuppress.
CREATE TABLE email_suppressions (
  email_key TEXT PRIMARY KEY,                -- b64url(HMAC-SHA256(K_sup, exact normalized address)); K_sup from K_sub
  reason    TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  at_ms     INTEGER NOT NULL
);

-- Staff actions (admin/*, behind Cloudflare Access and the allowlist, D88), written before the action: client proofs
-- (scope, nonce, jti), mailbox unlocks and unsuppressions (subject = 12 characters of an HMAC key; never the address),
-- each with the support reference (ticket) staff gave.
CREATE TABLE email_admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  staff        TEXT NOT NULL,                -- the Access identity's email (staff, never an end user)
  action       TEXT NOT NULL CHECK (action IN ('client_proof', 'unlock', 'unsuppress')),
  ticket       TEXT NOT NULL,                -- the support reference
  scope_id     TEXT,
  action_nonce INTEGER,
  jti          TEXT,
  subject      TEXT
);
