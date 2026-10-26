-- Hana ID API: off-chain app config (publishable keys, origins, plans, status) and usage.

CREATE TABLE plans (
  id            TEXT PRIMARY KEY,
  per_minute    INTEGER NOT NULL,          -- requests per app per minute
  per_day       INTEGER NOT NULL,          -- requests per app per UTC day
  per_ip_minute INTEGER NOT NULL DEFAULT 20 -- requests per client IP per app per minute
);

INSERT INTO plans (id, per_minute, per_day, per_ip_minute) VALUES ('free', 60, 5000, 20);

CREATE TABLE apps (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  scope_id        TEXT NOT NULL,           -- hana-signer registry scope (e.g. "global", "s1")
  publishable_key TEXT NOT NULL UNIQUE,    -- pk_test_<base58>
  status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended')),
  plan            TEXT NOT NULL DEFAULT 'free' REFERENCES plans (id),
  created_at      INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000) -- unix ms
);

CREATE INDEX apps_scope_id ON apps (scope_id);

CREATE TABLE app_origins (
  app_id TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  origin TEXT NOT NULL,                    -- exact Origin, e.g. https://app.example.com; 'http://localhost:*' for pk_test_ only
  PRIMARY KEY (app_id, origin)
);

CREATE INDEX app_origins_origin ON app_origins (origin);

CREATE TABLE usage (
  app_id   TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  day      TEXT NOT NULL,                  -- UTC, YYYY-MM-DD
  sessions INTEGER NOT NULL DEFAULT 0,     -- successful create_session
  derives  INTEGER NOT NULL DEFAULT 0,     -- successful derive_key
  PRIMARY KEY (app_id, day)
);
