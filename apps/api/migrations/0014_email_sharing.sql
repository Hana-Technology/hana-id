-- Email sharing with partners (D411, D439; docs/email-sharing-spec.md "Data model"). Numbered 0014, the next free
-- number after develop's 0012 and 0013. This file only adds a column with a default and creates its own table, so
-- it applies the same before or after any other; nothing it adds is read by derivation (paths, identities and keys are
-- on chain, untouched).

-- When Hana asks a user to share their address with the app: 'off' (the default, so every existing app keeps sharing
-- nothing), 'on_request' (only when the partner calls requestEmailSharing()), 'at_login' (once per user and app, at the
-- first login). Written by updateSettings (AdminRpc, ConsoleRpc) and `admin app:settings --identity-email`.
ALTER TABLE apps ADD COLUMN identity_email TEXT NOT NULL DEFAULT 'off'
  CHECK (identity_email IN ('off', 'on_request', 'at_login'));

-- One consent per app × account × address. Written only by the API's email consent endpoints
-- (src/identity/email.ts), read by the identity token mint and ConsoleRpc (the partner Users screen: the `email` of
-- granted rows of the org's own apps), deleted by `uid-erase` (C13) and by the retention job 30 days after the app is
-- deleted.
--   - `user_sub`: the account's User ID, the identity token's `sub` (`u1_…`, the same value `end_users.token_sub`
--     holds): a consent is per account, so a linked member's login finds its root's consent (D411 point 3).
--   - `email_mac`: HMAC-SHA256(EMAIL_CONSENT_KEY, "hana-id/email-consent/v1" ‖ 0x00 ‖ lowercase address), so a
--     consent covers only the address it was given for (point 5) and a declined row keeps no address.
--   - `email`: the copy of the shared address (point 4), set exactly while the row is `granted`; a decline or a revoke
--     clears it. Personal data in Hana's hands: never logged, never in an export but the partner's own Users screen.
CREATE TABLE email_consents (
  app_id     TEXT NOT NULL,
  user_sub   TEXT NOT NULL CHECK (user_sub GLOB 'u1_*' AND length(user_sub) = 25),
  email_mac  BLOB NOT NULL CHECK (length(email_mac) = 32),
  state      TEXT NOT NULL CHECK (state IN ('granted', 'declined')),
  email      TEXT CHECK (email IS NULL OR length(email) BETWEEN 3 AND 254),
  scope_id   TEXT NOT NULL,
  decided_at INTEGER NOT NULL CHECK (decided_at >= 0),
  PRIMARY KEY (app_id, user_sub, email_mac),
  CHECK ((state = 'granted') = (email IS NOT NULL))
);
CREATE INDEX email_consents_user ON email_consents (user_sub);
CREATE INDEX email_consents_mac ON email_consents (email_mac, state);
