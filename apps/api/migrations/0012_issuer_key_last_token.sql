-- Issuer key rollout hysteresis (D420): when a verified token signed with each kid last reached the API, beside
-- first_token_ms (0004). The JWKS cron never proposes or executes the removal of a kid that signed a token in the last
-- 24 h, whatever Google's JWKS says. Written at most once per kid per isolate every few minutes (key-observations.ts).
-- Public data only: a kid and a timestamp. Existing rows start from their first token (a lower bound).

ALTER TABLE issuer_key_observations ADD COLUMN last_token_ms INTEGER;
UPDATE issuer_key_observations SET last_token_ms = first_token_ms WHERE first_token_ms IS NOT NULL;
