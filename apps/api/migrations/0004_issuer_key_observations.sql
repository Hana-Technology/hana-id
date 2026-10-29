-- Issuer signing-key lead time (D33 "Open", docs/security.md open issue (e)): for each issuer kid, when it first and
-- last appeared in the issuer's published JWKS, when it was first seen missing after that, when a token signed with
-- it first reached the API, and the JWKS response's Cache-Control max-age the last time the kid was listed. Public
-- data only: kids and timestamps, never tokens or anything about a user. Read with
-- `admin.ts <env> issuer-keys:lead-times` (docs/operations.md "Issuer key lead times").

CREATE TABLE issuer_key_observations (
  provider           TEXT NOT NULL,
  kid                TEXT NOT NULL,
  first_seen_jwks_ms INTEGER,               -- unix ms; null: a token was seen before any JWKS fetch listed the kid
  last_seen_jwks_ms  INTEGER,               -- unix ms
  removed_jwks_ms    INTEGER,               -- unix ms: first fetch without the kid after last_seen; cleared if it reappears
  first_token_ms     INTEGER,               -- unix ms: first verified token signed with this kid
  max_age_s_last     INTEGER,               -- seconds; null when the response had no max-age
  PRIMARY KEY (provider, kid)
);
