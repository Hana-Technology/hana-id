-- Hana ID email issuer: the user directory (D269). The verified address of every identity that logs in, for Hana
-- staff only (the admin CLI now, the admin console's Users page later). Partners never see it: the API, the SDK and
-- the partner console read nothing from this D1. Written by the issuer only, best effort after the answer (a failed
-- write never fails a login). Logs still never carry an address (src/log.ts).

-- One row per identity: email logins at every 200 of verify (session, case B, the link purposes, auto_link), Google
-- logins at google-match (or google-record, D270).
-- A Google account's address can change: the row keeps the latest.
CREATE TABLE user_emails (
  provider       TEXT NOT NULL CHECK (provider IN ('email', 'google')),
  sub            TEXT NOT NULL,              -- the identity's sub as on chain: e1.… (email) or Google's sub
  email          TEXT NOT NULL,              -- email: the normalized login address; google: userinfo's address, lowercased
  email_verified INTEGER NOT NULL,           -- 1: verified (always for email; Google's email_verified)
  hosted         INTEGER,                    -- google: 1 when Google-hosted (D158); null for email
  first_seen_ms  INTEGER NOT NULL,
  last_seen_ms   INTEGER NOT NULL,
  PRIMARY KEY (provider, sub)
);
CREATE INDEX user_emails_email ON user_emails (email);
CREATE INDEX user_emails_last_seen ON user_emails (last_seen_ms);

-- Which apps each identity logged in to (the admin view per app, as Privy's Users page).
CREATE TABLE user_email_apps (
  provider      TEXT NOT NULL CHECK (provider IN ('email', 'google')),
  sub           TEXT NOT NULL,
  app_id        TEXT NOT NULL,
  scope_id      TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  PRIMARY KEY (provider, sub, app_id)
);
CREATE INDEX user_email_apps_app ON user_email_apps (app_id, last_seen_ms);
