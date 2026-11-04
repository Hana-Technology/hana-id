-- Email login, build plan batch 6 (docs/email-login-spec.md "API changes", docs/email-login-build-plan.md batch 6).
-- Numbered 0010: 0006 and 0008 are merged, 0007 is reserved for batch C4b's drop of the legacy `usage` table and 0009
-- for C4's `session_markers`. This file only adds a column with a default and creates its own table, so it applies the
-- same before or after 0007 and 0009, and neither touches what it adds. No user data: no `sub`, address or token.

-- The sign-in methods an app offers: comma-separated, Google only by default, so every existing app keeps exactly what
-- it has. The API offers a method only when this lists it and the scope has its client on chain (GET /v1/app); the
-- email issuer refuses an app without `email` here. No app lists `email` before build plan batch 8.
ALTER TABLE apps ADD COLUMN login_methods TEXT NOT NULL DEFAULT 'google'
  CHECK (login_methods IN ('google', 'email', 'google,email'));

-- Email logins and new links per app and UTC day (the spec's "Usage counts email logins and links per app"), kept out
-- of the legacy `usage` table that C4b's 0007 drops, as `identity_usage` is (D172). Batch C4's usage ledger takes them
-- over like the identity counts (D223). A link is counted once, when it is made (a linked login or `link_identity`),
-- as the contract's link counter counts it (D200); cancels and unlinks are not links.
CREATE TABLE email_usage (
  app_id         TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  day            TEXT NOT NULL,                       -- UTC, YYYY-MM-DD
  email_sessions INTEGER NOT NULL DEFAULT 0 CHECK (email_sessions >= 0),
  links          INTEGER NOT NULL DEFAULT 0 CHECK (links >= 0),
  PRIMARY KEY (app_id, day)
);
