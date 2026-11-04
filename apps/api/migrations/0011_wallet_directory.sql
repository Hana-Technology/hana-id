-- The wallet directory (D310, D312–D315; docs/architecture.md "Data stores"): each end user per scope, the wallet
-- addresses their logins reported, and the identities (sign-in methods) of their account. Written only by the API:
-- apps/api/src/directory/ (the vault's signed wallet record, POST /v1/wallets/record; the API's own chain reads after
-- /v1/login and the link relays). Read by AdminRpc (staff: everything here), ConsoleRpc (a partner's own scopes:
-- user ids, times, account kinds and addresses, never a sub or an identity key) and `admin user:*`.
--
-- Numbered 0011, the next free number: 0007 stays batch C4b's (the legacy `usage` drop). This file only creates its
-- own tables and reads no other, so it applies the same before or after 0007. No foreign key into `apps` or `scopes`:
-- a user is per scope, and a scope's rows outlive an app deleted from it.
--
-- What it holds is personal data in Hana's hands (D269's cost, now in the hot DB too): a Google `sub` or email `sub`
-- per identity, and the public wallets of the account, so a reader of this database can map Google accounts to
-- on-chain balances. Never a key, a token, a signature, an email address or a session key.

-- One row per user: the account root of a scope. `user_id` is "hu_" + Crockford base32 of the uid (HMAC of
-- USER_ID_KEY over the scope and the root's provider and sub, D96, D312), the ledger's pseudonym: the same login
-- always lands on the same row. `support_code` is its first 8 characters, uppercase (the Support ID HANA-XXXX-XXXX,
-- D276). Times are unix ms; `created_at` is the MIN and `last_seen_at` the MAX of every write's time.
CREATE TABLE end_users (
  user_id      TEXT PRIMARY KEY CHECK (user_id GLOB 'hu_*' AND length(user_id) = 29),
  support_code TEXT NOT NULL CHECK (length(support_code) = 8),
  scope_id     TEXT NOT NULL,
  created_at   INTEGER NOT NULL CHECK (created_at >= 0),
  last_seen_at INTEGER NOT NULL CHECK (last_seen_at >= created_at)
);
CREATE INDEX end_users_scope ON end_users (scope_id, last_seen_at DESC, user_id);
CREATE INDEX end_users_recent ON end_users (last_seen_at DESC, user_id);
CREATE INDEX end_users_support ON end_users (support_code);

-- The wallets a user's logins reported, each proven by the address's own key for a live session of the user's path
-- (core wallet-record.ts). Stellar addresses as StrKey, EVM in EIP-55. `last_used_at` is the last login that
-- recorded it, never on-chain activity. One address can appear under two users (an exported or reused key, D179's
-- residual): the key is per user, and the address index finds every one.
CREATE TABLE end_user_wallets (
  user_id       TEXT NOT NULL REFERENCES end_users (user_id) ON DELETE CASCADE,
  chain         TEXT NOT NULL CHECK (chain IN ('stellar', 'evm')),
  address       TEXT NOT NULL CHECK (length(address) BETWEEN 42 AND 56),
  key_index     INTEGER NOT NULL CHECK (key_index >= 0 AND key_index < 2147483648),
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  last_used_at  INTEGER NOT NULL CHECK (last_used_at >= first_seen_at),
  PRIMARY KEY (user_id, chain, address)
);
CREATE INDEX end_user_wallets_address ON end_user_wallets (address);

-- The identities of a user's account, one row per identity per scope (an identity is in at most one account of a
-- scope; a member that moves to another account moves its row). `identity_key` is the contract's `ik`, hex
-- (sha256 of the scope, provider and sub: public). `sub` is NULL for a member Hana only saw on chain (a link made by
-- calling the contract directly). A member's status is `pending` until `effective_at`, which readers apply at read
-- time; a removed member keeps its row (`unlinked` / `cancelled`) until it joins another account. `observed_at` is
-- the time of the chain read or the record that wrote the row: a write lands only when it is no older than the row's,
-- so writes that arrive late never undo newer ones.
CREATE TABLE end_user_identities (
  scope_id      TEXT NOT NULL,
  identity_key  TEXT NOT NULL CHECK (length(identity_key) = 64),
  user_id       TEXT NOT NULL REFERENCES end_users (user_id) ON DELETE CASCADE,
  provider      TEXT NOT NULL,
  sub           TEXT,
  role          TEXT NOT NULL CHECK (role IN ('root', 'member')),
  status        TEXT NOT NULL CHECK (status IN ('active', 'pending', 'unlinked', 'cancelled')),
  effective_at  INTEGER,
  first_seen_at INTEGER NOT NULL CHECK (first_seen_at >= 0),
  observed_at   INTEGER NOT NULL CHECK (observed_at >= 0),
  PRIMARY KEY (scope_id, identity_key)
);
CREATE INDEX end_user_identities_user ON end_user_identities (user_id);
CREATE INDEX end_user_identities_sub ON end_user_identities (sub);
