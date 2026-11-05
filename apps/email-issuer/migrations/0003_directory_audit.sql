-- Hana ID email issuer: the staff Users screen's audit (D275, confirmed 2026-11-05; batch C8b). `DirectoryRpc` (no
-- route, bound only by the admin Worker) writes one `email_admin_audit` row in the same D1 batch as each read of the
-- user directory, so a failed audit write returns no rows.
--
-- SQLite can't change a CHECK in place, so the table is rebuilt with every row kept (ids included; the AUTOINCREMENT
-- sequence moves with the rename):
--   - new actions: `user_search` (a search or list page), `user_view` (one identity opened) and `support_lookup`
--     (C15's Support ID lookup, so that batch needs no migration of its own);
--   - `ticket` stays required for every action but `user_search`, where staff may leave it out (the user's decision,
--     2026-11-05: required to open one identity, optional for list and search views);
--   - `detail`: JSON, never an address. A search: the filters, the address term as a 12-character keyed hash and the
--     row count; a view: `{provider, sub}`; a lookup (C15): the code.
-- The issuer's own staff routes (client proofs, unlocks, unsuppressions, ticket revocations) write the same columns as
-- before; `detail` is null for them.
CREATE TABLE email_admin_audit_v3 (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms        INTEGER NOT NULL,
  staff        TEXT NOT NULL,                -- the Access identity's email (staff, never an end user)
  action       TEXT NOT NULL CHECK (action IN ('client_proof', 'unlock', 'unsuppress', 'revoke_tickets', 'user_search', 'user_view', 'support_lookup')),
  ticket       TEXT CHECK (ticket IS NULL OR length(ticket) BETWEEN 1 AND 64),
  scope_id     TEXT,
  action_nonce INTEGER,
  jti          TEXT,
  subject      TEXT,
  detail       TEXT CHECK (detail IS NULL OR json_valid(detail)),
  CHECK (ticket IS NOT NULL OR action = 'user_search')
);

INSERT INTO email_admin_audit_v3 (id, at_ms, staff, action, ticket, scope_id, action_nonce, jti, subject, detail)
  SELECT id, at_ms, staff, action, ticket, scope_id, action_nonce, jti, subject, NULL FROM email_admin_audit;

DROP TABLE email_admin_audit;
ALTER TABLE email_admin_audit_v3 RENAME TO email_admin_audit;

-- The audit screen filters by staff member and walks by id; the C13 purge deletes by time.
CREATE INDEX email_admin_audit_staff ON email_admin_audit (staff, id);
CREATE INDEX email_admin_audit_at ON email_admin_audit (at_ms);
