-- Batch B (docs/batch-b-spec.md, "Data, secrets, code"): per-app settings.

-- The scope's Google client GET /v1/app hands out (own-client mode). NULL: the scope's first Google client, as before.
-- A scope may also hold iOS and Android clients, which can't do the web implicit flow. Set by `admin app:settings
-- --google-web-client`, which checks it against the scope's on-chain clients.
ALTER TABLE apps ADD COLUMN google_web_client_id TEXT;
