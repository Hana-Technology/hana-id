-- Batch C7 (the console Worker backend): two additions 0001 left out (0001 is immutable once merged).
--
-- 1. invites.new_org_kind (D242): the kind of the org a new-org invite creates on acceptance. StaffRpc.issueInvite takes
--    `kind` (docs/batch-c-spec.md "RPC interfaces"), and the passkey gate (§Deferred) counts a still-open new partner-org
--    invite as a partner org, so the kind has to live on the invite. Set exactly with new_org_name.
ALTER TABLE invites ADD COLUMN new_org_kind TEXT CHECK (new_org_kind IN ('partner', 'internal'));

CREATE TRIGGER invites_new_org_kind_insert BEFORE INSERT ON invites
WHEN (NEW.new_org_name IS NULL) <> (NEW.new_org_kind IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invites.new_org_kind is set exactly with new_org_name');
END;

CREATE TRIGGER invites_new_org_kind_update BEFORE UPDATE OF new_org_name, new_org_kind ON invites
WHEN (NEW.new_org_name IS NULL) <> (NEW.new_org_kind IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'invites.new_org_kind is set exactly with new_org_name');
END;

-- 2. One audit row per (request id, action) (D243): every console write is one D1 batch whose first statement inserts
--    its audit row, the commit point the later statements are gated on, as app_changes is in the hot DB. A replayed
--    request id then violates this index, the whole batch aborts and writes nothing, and the caller is answered
--    `already_applied`.
CREATE UNIQUE INDEX audit_log_request_action ON audit_log (request_id, action);
