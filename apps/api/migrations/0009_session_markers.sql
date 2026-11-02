-- Batch C4 (docs/batch-c-build-plan.md "C4. Usage capture", the obligation carried over from C3, D205): a per-app
-- session marker, the hot-DB sign of a user that replaces the legacy `usage` counters in the `no_session` waiver
-- (scripts/lib/admin-sql.ts noSessionWaiver; AdminRpc's from C5). From C4 the API writes no `usage` rows (usage goes
-- to the Neon ledger, which the hot path and the waiver never read), and C4b's 0007 drops the table.
--
-- Numbered 0009, the next free number: 0007 stays C4b's (the legacy drop) and 0008 is the identity token's. This file
-- only creates its own table and reads no other, so it applies the same before or after 0007 (wrangler applies the
-- unapplied files in name order; on a fresh database 0007 runs first). Carrying the existing `usage` rows into markers
-- is a one-off step before 0007 (docs/operations.md "Usage capture (batch C4)").
--
-- The API writes a row when the relay of a session-pool request it saw on a scope with no `first_session_at` settled
-- (apps/api/src/apps.ts markSession), whatever the outcome, beside the scope's `first_session_at` written at the
-- attempt: two independent writes, so one lost write never grants the waiver. Set once per app. No user data.
CREATE TABLE session_markers (
  app_id   TEXT PRIMARY KEY REFERENCES apps (id) ON DELETE CASCADE,
  first_at INTEGER NOT NULL CHECK (first_at >= 0)   -- unix ms, the first settled session-pool relay the API saw
);
