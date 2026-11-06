-- Issuer key rollout hysteresis (D420): how many successful JWKS fetches in a row have missed a pending kid since
-- first_absent_at. A pending Add is cancelled as retired (D153), or a pending Remove confirmed, only after at least 3
-- such fetches spread over a minimum time (docs/governance-spec.md "Watchdog service"), never on two fetches 60 s
-- apart: Google's edges serve different key sets during a rollout. Existing rows count as their one fetch.

ALTER TABLE absences ADD COLUMN absent_fetches INTEGER NOT NULL DEFAULT 1;
