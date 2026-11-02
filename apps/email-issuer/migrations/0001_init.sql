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
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY (scope_id, email_sub, google_sub)
);

-- Addresses that bounced or complained (SendGrid's Event Webhook): no mail goes to them; `start` still answers 202.
CREATE TABLE email_suppressions (
  email_key TEXT PRIMARY KEY,                -- b64url(HMAC-SHA256(K_rl, normalized address))
  reason    TEXT NOT NULL CHECK (reason IN ('bounce', 'complaint')),
  at_ms     INTEGER NOT NULL
);

-- Staff client proofs (admin/client-proof, behind Cloudflare Access and the allowlist, D88): who asked for which.
CREATE TABLE email_admin_audit (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  staff        TEXT NOT NULL,                -- the Access identity's email (staff, never an end user)
  scope_id     TEXT NOT NULL,
  action_nonce INTEGER NOT NULL,
  jti          TEXT NOT NULL
);
