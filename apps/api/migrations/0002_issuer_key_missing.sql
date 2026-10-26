-- JWKS sync (cron): when each on-chain issuer key was first seen missing from the issuer's JWKS. A key is removed
-- on chain only after it has been missing for a while (several hourly runs in a row), never on one fetch that
-- omitted it (a stale cache or a frontend mid-rollout).

CREATE TABLE issuer_key_missing (
  provider         TEXT NOT NULL,
  kid              TEXT NOT NULL,
  first_missing_at INTEGER NOT NULL,        -- unix ms
  PRIMARY KEY (provider, kid)
);
