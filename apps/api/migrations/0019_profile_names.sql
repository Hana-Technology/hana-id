-- Profile names (D714): a user's own first and last name, set in Hana Home and shared per app. Both parts optional.
-- Expand-only: applied before the API that reads it (D1 first); an API before this migration never reads either table,
-- and the reads of this one treat a missing table as "no name".
--
-- `home_profiles`: one row per sign-in identity, keyed as the wallet directory keys it (`end_user_identities.provider`,
-- `.sub`, the identity Hana Home signs in as). A row exists only while at least one part is set: "Remove my name" deletes
-- it, and its shares with it. Values are `normalizeProfileName`'s (core/identity.ts): NFC, trimmed, at most 50 code
-- points, display-safe. Staff see them on the admin Users screen through the account's identities.
CREATE TABLE home_profiles (
  provider    TEXT NOT NULL,
  sub         TEXT NOT NULL,
  given_name  TEXT CHECK (given_name IS NULL OR length(given_name) BETWEEN 1 AND 50),
  family_name TEXT CHECK (family_name IS NULL OR length(family_name) BETWEEN 1 AND 50),
  updated_at  INTEGER NOT NULL,                  -- unix ms
  PRIMARY KEY (provider, sub),
  CHECK (given_name IS NOT NULL OR family_name IS NOT NULL)
);

-- `name_shares`: the apps a user shares their name with, one row per app × account (the account's User ID `u1_…` in the
-- app's scope, as `email_consents.user_sub`). No copy of the name: it is read through the identity that shared it
-- (`provider`, `sub`), so an edit in Home reaches every app it is shared with, and removing the name ends every share.
-- Off by default: no row, no name. A partner reads it in its identity tokens (`given_name`, `family_name`) and on the
-- console's Users screen. Deleted: with the profile, by "Stop sharing", by `uid-erase` (the account's User IDs), and with
-- the app (the monthly retention job, as `email_consents`).
--
-- `via`: how the sharing identity reached the account. `own`: it is the account's root (the User ID is computed from it,
-- so the share can't outlive its place in the account). `member`: a linked login of another root's account; such a share
-- counts only while the wallet directory lists that identity as a live member of the account and the share is no older
-- than its link (identity/name.ts LIVE_NAME_SHARE): an unlinked login's name stops at once, and never comes back by
-- itself if the login is linked again.
CREATE TABLE name_shares (
  app_id    TEXT NOT NULL REFERENCES apps (id) ON DELETE CASCADE,
  user_sub  TEXT NOT NULL,                       -- the account's User ID in the app's scope
  provider  TEXT NOT NULL,                       -- the Home identity whose name is shared
  sub       TEXT NOT NULL,
  via       TEXT NOT NULL CHECK (via IN ('own', 'member')),
  shared_at INTEGER NOT NULL,                    -- unix ms
  PRIMARY KEY (app_id, user_sub)
);
CREATE INDEX name_shares_owner ON name_shares (provider, sub);
CREATE INDEX name_shares_user ON name_shares (user_sub);
