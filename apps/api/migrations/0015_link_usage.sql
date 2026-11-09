-- Links per app and UTC day (build plan batch 9, the links view; D445): counts only, from the contract's own NEP-297
-- `identity_link*` log lines as each relayed transaction settles (src/link-usage.ts `linkTallyOf`). Beside `email_usage`,
-- which counts links made (D233); this one says what happened to them. A change is counted once, in the UTC day its
-- event was seen. `auto` and `explicit` split `proposed` + `linked` by the event's `auto` flag.
-- No user data: no `sub`, address, identity key or token. Nothing here is read by derivation.
CREATE TABLE link_usage (
  app_id    TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  day       TEXT NOT NULL,                       -- UTC, YYYY-MM-DD
  proposed  INTEGER NOT NULL DEFAULT 0 CHECK (proposed >= 0),   -- pending links (identity_link_proposed)
  linked    INTEGER NOT NULL DEFAULT 0 CHECK (linked >= 0),     -- links active at once (identity_linked)
  activated INTEGER NOT NULL DEFAULT 0 CHECK (activated >= 0),  -- pending links marked active (identity_link_activated)
  cancelled INTEGER NOT NULL DEFAULT 0 CHECK (cancelled >= 0),  -- identity_link_cancelled
  unlinked  INTEGER NOT NULL DEFAULT 0 CHECK (unlinked >= 0),   -- identity_unlinked
  auto      INTEGER NOT NULL DEFAULT 0 CHECK (auto >= 0),       -- proposed + linked with auto: true
  explicit  INTEGER NOT NULL DEFAULT 0 CHECK (explicit >= 0),   -- proposed + linked with auto: false
  PRIMARY KEY (app_id, day)
);
