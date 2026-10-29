# Owner multisig: Sputnik DAO v2 (D81)

The `hana-signer` owner is a Sputnik DAO v2 council, 2 of 3 for every proposal kind (`docs/governance-spec.md`
"Owner = multisig", `docs/decisions.md` D81). This folder pins what the sandbox tests check, so the scripts and
the tests use the same thing:

- `pin.json`: the DAO wasm (repo, commit, sha256, NEAR `code_hash`). It is the code the testnet factory
  `sputnikv2.testnet` deploys by default (version 3.31, `get_default_code_hash` =
  `AA4nA45vauiac3jdVwJTzSdUP3oj2r1fDaPAb2mHdgcH`, checked 2026-10-29). Before creating a DAO, check that the
  factory's default hash still equals `code_hash`; if it changed, re-pin and re-run the sandbox tests first.
- `policy.json`: the DAO policy, with an empty council (`roles[0].kind.Group`). Whoever creates the DAO fills in
  the three members and passes the rest unchanged. Every proposal kind uses `default_vote_policy` (`RoleWeight`,
  threshold `[1, 2]`: on 3 members ⌊3/2⌋ + 1 = 2 votes). Only the council has permissions (no `Everyone` role, so
  non-members can't propose), and it has no `RemoveProposal` (a single member could otherwise delete proposals).
  The proposal bond is 0.1 NEAR (refunded), proposals expire after 7 days.

`contracts/integration-tests/tests/governance.rs` (`sputnik_dao_owner_2_of_3`) deploys this wasm with this policy
and checks: a non-member can't propose; one vote executes nothing and the second does, for a `FunctionCall`
(`accept_owner`, `propose_upgrade`), a `ChangePolicy` and an `AddMemberToRole` / `RemoveMemberFromRole`; the DAO
then owns `hana-signer` and an upgrade goes through propose → wait → `execute_upgrade`.

Scripts (`scripts/lib/owner-tx.ts`, governance batch step 2) must read `policy.json` rather than build their own.
