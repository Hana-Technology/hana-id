-- Partner identity token, build step 2 (docs/identity-token-spec.md "D1 schema, manifest and secrets"). Numbered 0008:
-- batch C reserved 0006 (expand) and 0007 (drop the legacy `usage` table) in docs/batch-c-build-plan.md. This file
-- only creates its own tables, so it applies the same before or after those two, and 0007's drop of `usage` never
-- touches it. The email claim's columns and its consent table (build step 5) come in a later migration.
-- No user data: no `sub`, `sid`, address, email or token is stored. Retention: 24 months (D90), pruned by the cron.

-- Tokens signed per UTC hour and signing key, for the KMS `Sign` reconciliation (build step 7) and the issuance alarm.
CREATE TABLE identity_issuance_hourly (
  hour  INTEGER NOT NULL,                   -- unix ms at the start of the UTC hour
  kid   TEXT NOT NULL,                      -- RFC 7638 thumbprint of the signing key
  count INTEGER NOT NULL DEFAULT 0 CHECK (count >= 0),
  PRIMARY KEY (hour, kid)
);

-- Tokens minted per app and UTC day (the spec's `usage.identity_tokens`, kept out of the legacy `usage` table that
-- batch C's 0007 drops; batch C moves the count to its usage ledger).
CREATE TABLE identity_usage (
  app_id TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  day    TEXT NOT NULL,                     -- UTC, YYYY-MM-DD
  tokens INTEGER NOT NULL DEFAULT 0 CHECK (tokens >= 0),
  PRIMARY KEY (app_id, day)
);
