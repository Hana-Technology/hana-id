# H6 design: the contract change for review

**Status (2026-11-09): reviewed by the user, the outcomes are section 7 (D480–D489). Not built.** It says how batch H6 of `docs/hana-home-build-plan.md` builds D468's exit client. Like a spec it is history once H6 merges: the current state lives in the reference docs (`docs/README.md`).

**Basis.** I read `origin/develop` at e6c7157f, plus `feat/hana-home-h1-2` at 1b31ea29 (then local only, with D472 numbered D474 there). I ran no tests and made no chain reads. [C] means confirmed in code or docs; [I] means inferred. Line citations are in `contracts/hana-signer/src/` unless another path is shown.

**Corrections to the current docs**
- The build plan's "no `migrate`" for H6 no longer holds: D468 adds state.
- D474's "no owner can register it" is wrong as reasoned (section 2).
- D460's delay would break an existing defence (section 3).

## 1. The exit client

**State** (appended after `link_counter`, lib.rs:244)
- `exit_clients: Vec<(String,String)>`
- `pending_exit_clients: Vec<PendingSharedClient>`, reusing `in_force_at` and `fold_matured` (lib.rs:490-504)
- `exit_window`: an hourly alert-only counter (section 2)

**Method:** `set_exit_clients(clients)`, owner only, at most 4 entries, modelled on `set_shared_clients` (lib.rs:319-370). `get_config` gains both lists.

| Change | Shared clients and console audiences (today) | Exit clients (D482, D483) |
|---|---|---|
| Add | `change_delay_ms` (≤ 7 days) | `governance_delay_ms` (72 h on mainnet, governance-spec.md:24) |
| Remove | immediate | immediate, and retired forever (`#exit` marker, as `RETIRED_SHARED`, registry.rs:83) |

- **Why the longer add delay:** an exit client reaches every scope, including those that refused shared login. That is close to the power of an upgrade, so it gets the upgrade's delay.
- **Why immediate removal:** it is the only way to stop a compromised Home without pausing every partner. It can't steal anything. This departs from D468's literal "under a timelock" for removals only (D483).

**Acceptance.** Add `exit_scope()` and call it only from `open_session` (sessions.rs:383), before `session_scope`:
- It requires the client in force now and an existing scope. It ignores `clients` and `allow_shared`.
- `session_scope` itself stays unchanged. If the exit client went there, `link_identity`, `cancel_link`, `unlink_identity` and `auto_link` (links.rs:285, 319, 350, 627) would accept it too.
- A partner has no method that touches the exit list [C].
- Google and email take the same branch. The email entry is `("email","hana-home")`, an audience on no scope.
- H10's issuer needs a change: `mint()` hardcodes `email:${scopeId}` (`apps/email-issuer/src/handlers.ts:175`).

**Use a new, dedicated Google client (D484)**, in the same Google Cloud project as the shared client. It adds no security boundary on Google's side and doesn't defend against a compromised Hana page. It exists so the contract can tell an exit from a normal login, by `aud`: partners' turning off shared login keeps meaning something, and the session limits, alert counter and emergency removal apply to exits only. Its only redirect can be Home's page. `homeAudienceRoute` gains the exit route and `/v1/home/config` gains its client id. This settles D474's open point.

**Why the address doesn't change** (sessions.rs:398-406) [C]:
```rust
let x = crate::links::ik(&scope_id, &token.provider, &token.sub);
let mut root = self.settle(&scope_id, &x, now);
let (path_provider, path_sub) = self.path_identity(&root, (&token.provider, &token.sub));
path: format!("{}#{}#{}#{}", scope_id, path_provider, path_sub, key_index),
```
- `aud` never enters the path, `ik`, `settle` or `path_identity` (links.rs:179, 509, 661) [C].
- `provider` comes from `iss`, not the client (issuers.rs:416) [C].
- Email `sub` is `HMAC(K_sub, label ‖ normalized address)` with no audience input (`packages/email/src/sub.ts:64-70`) [C].
- A linked member resolves to its account's stored root, by the same code whichever client issued the token [C]. A pending member is refused, as today.

**What I can't prove**
1. Google's `sub` being equal across clients is Google's behaviour, not our code. Evidence is one spike with two accounts and two projects (`docs/context.md:175-178`). Repeat it with the real Home client before use (D484), and put that client in the shared client's Cloud project. Same project should mean the same `sub` [I].
2. H10's route isn't built. "Same `K_sub`, same `iss`" is a requirement until a test pins it.
3. Whether Home uses the wallet's real `key_index` is off-chain.

## 2. Is one audience across all scopes safe?

**The one-scope rule.** The exit client is cross-scope by design, as shared clients are. Keep the sets disjoint:
- `assert_client_available` (registry.rs:434) also refuses exit clients, in force or pending. It already runs at propose, execute and registration (lines 279, 334, 481).
- `set_exit_clients` refuses anything registered, shared, pending-add, quarantined or a console audience.
- `set_shared_clients` and `set_console_audiences` refuse exit clients.

**Picking a scope.** `scope_id` is the caller's argument and the token's nonce commits to it (sessions.rs:385-395). The page chooses it, and it can be any scope. `sub` and `provider` come only from the signed token. So an attacker with their own token reaches only their own key in that scope, never another user's [C]. The existence check stops paths on unregistered scope ids. Scopes can't be deleted (no `scopes.remove` in the contract) [C].

**Session versus export.** They are equivalent: a session's only powers are `derive_key` and `revoke_session`, and a derive releases the full key to the browser [C].

**On-chain limits (D486)**
- Exit sessions: at most 30 minutes and 3 uses (2 or more are needed to retry an MPC failure, sessions.rs:274-276). These stop exit becoming a general login route but don't stop a compromised page.
- Refuse `link_jwt` on exit sessions.
- Pause still stops exit (issuers.rs:406).

**Event.** Emit `exit_session_opened {scope_id, provider, aud, identity_key (hex), expires_at_ms, max_uses}` from `open_session`, so both entry points are covered and a reverted login leaves nothing. No `sub`, as `links.rs:6-7` requires. Bump events to 1.3.0. One event per session (D487), because later derives in it release the same key. Counting every derive would need a change to the session record.

The watchdog reads views only, never logs (`apps/watchdog/README.md:23`), so "the watchdog can see" needs a counter (D487). Add the hourly total to `get_config`: alert-only, as D200 reasoned, because a refusing cap could be burned to lock users out of their rescue route. There is no new RPC or cron, so D380 and D417 hold [I]. Add both lists to the watchdog's critical diff, plus a pinned expected value.

**Refusing `("email","hana-home")` as a scope client.** D474 says a client proof is minted only for `email:{scope}`. But `propose_change` checks only provider, audience and nonce (registry.rs:272-277). Any `hana-home` token with a chosen nonce would be a valid proof, and the owner's scope would then capture Home's email route. Three layers:
- **Contract, exit list:** the disjointness check above.
- **Contract, audience shape:** a self-issued provider's client must be exactly `email:{scope_id}`, checked in `insert_scope` and at propose and execute. This holds even before the exit list is set. The existing test fixtures use this form [C].
- **Issuer:** the Home route computes the nonce from typed inputs and never accepts a nonce, as `commitment.ts` already does for logins [C].

**Order matters:** run `set_exit_clients` before anything can mint these tokens. A pending entry reserves the client at once.

## 3. D460 and D464, given D468

| Item | Outcome | Why |
|---|---|---|
| Delay on turning off shared login | **Dropped** (D480) | Exit now protects access, so the delay protects nothing for users. It also costs a defence: owners answer a new shared client by turning shared login off first (lib.rs:312-315), and a delay of the same length can't land first. |
| "Needs a remaining Google client" | **Dropped** (D480) | Exit covers unlinked Google users. |
| `remove_client` of the last Google client | **Today's rule kept** (registry.rs:378, D480) | Exit covers it. |
| `disable_shared_login` | **Keeps working, unchanged** (neither removed nor a stub, D480) | Plan item 3 falls away, along with the caller changes (`validate.ts`, `SAFETY_METHODS`, console) and the partner notice. |
| D464 owner seat | **Dropped** (D481) | Its only purpose was proposing `SetAllowShared` at exit. Keeping it leaves Hana with `SetOwners` and `AddClient` proposal rights over partner scopes for no gain. Plan item 6 falls away; readiness 9.11 and D98's "right to enable at exit" need rewording. |

Dropping the delay reverses a decision the user made on 2026-11-09; D468 had left open only the Google-client rule and the seat. The user agreed (D480), so the plan's H6 caller list falls away.

## 4. If Hana is compromised

**Home page or `authOrigin` bundles.** The attacker gets tokens from users who sign in there, with attacker-chosen nonces, for any scope. Further scopes may need no extra click (Google `prompt=none`) [I]. New reach is small: the spec already treats this origin as the single trust root (`docs/hana-home-spec.md`, Security model), and D42 clients serve only Hana's pages. The main additions are partner-held clients that would otherwise be out of reach, and scopes that refused shared login. Detection is the counter and event, then watchdog pause. Users who never sign in are untouched.

**Email is different.** "Needs the user's own sign-in" fails for a stolen issuer key, which already forges logins (`link_counter.rs:3-9`). Exit extends that to scopes that dropped their email client. The defence is key custody and a second signer. A phisher can also relay a code to the Home route, so its email must name the action and the app, with tight limits.

**Council.** 2-of-3 can add a malicious exit client only after `governance_delay_ms`, in public. A watchdog pin mismatch is then critical and triggers a pause. A council compromise can already upgrade the contract, so exit adds little.

**Optional delay on exit derives: no (D488).**
- It would cover only scopes with shared login off.
- It needs a marker on every session and a two-visit Home flow.
- It would slow the rescue exactly when it's needed.
- The only real gain, time for a mass-harvest alarm, comes mostly from the counter, without touching real users.

## 5. Migration and upgrade

**`migrate` is needed.** Copy the exact v3 struct (lib.rs:145 says to), append the new fields empty, and set `STATE_VERSION` to 4. Drop the v2 path once every env is confirmed v3. Then `migrate` on a v2 state panics and the deploy reverts harmlessly. Rollback to v3 is impossible after this (the rule at migrate.rs:13-15).

**Cost** [I, measure in sandbox]: about 250 extra bytes of root state, roughly 0.002 NEAR and 0.01 Tgas per call. On exit logins, the event adds under 0.1 Tgas. That is small against about 89 needed of 150 attached (`apps/api/src/gas.ts:12-17`). `StoredSession` is unchanged.

**Order on sandbox-dev**
1. Confirm `state_version == 3` and `scope_for_client("email","hana-home")` is null.
2. Deploy the watchdog with the new diff. Fields it doesn't know are ignored [C].
3. DAO `propose_upgrade`, wait, then `execute_upgrade`, using `deploy-contract --upgrade` (`docs/operations.md:3935-3938`). Do this even though sandbox-dev keeps a full-access key. Check `state_version == 4`.
4. Council calls `set_exit_clients` (2-of-3).
5. API, issuer H10, pages.

**Compatibility.** Old API on the new contract works: calls are unchanged and `get_config` only gains fields. A new API on the old contract sees empty lists and fails closed. `checkClientScope` (`apps/api/src/handlers.ts:662`) must stay closed to exit clients for partner logins; only `/v1/home/login` admits them. That's an API rule, since anyone can call the contract directly.

## 6. Tests

**Unit**
- Exit works on a scope with `allow_shared` false, for Google and email.
- Refused: unknown scope, pending client, removed client, paused contract, wrong nonce, over the caps.
- `link_jwt` is refused, and exit tokens are refused by all three link methods and owner auth.
- Disjointness at propose, execute and registration; a retired client is never claimable.
- `("email","hana-home")` with a valid proof is refused; `email:s2` on s1 is refused.
- The event contains no `sub`.
- v3 to v4 keeps every field; v4 to v4 works.

**Golden paths.** Extend `golden_paths_of_identities_outside_every_account_are_unchanged` (tests/email.rs:697). Open the same user through own client, shared client and exit, and assert identical path strings. Include email (`s1#email#{sub}#0`) and a linked member reaching the root's path. Derivation-v1 vectors must not change.

**near-workspaces.** Add a v3-to-v4 upgrade through the DAO that keeps every view and path, modelled on `integration-tests/tests/governance.rs:287`: open sessions before and after, compare paths. Include a failing `migrate` rollback and a gas measurement.

**Live.** The real Google account through the shared and exit clients, comparing the derived address. Issuer tests: no free-form nonce on the Home route, and same `sub` as a normal login.

**Ask the auditor to examine**
- That exit acceptance can't leak outside `open_session`.
- Client-set disjointness under propose/execute races, retirement and quarantine.
- The email audience-shape rule.
- The exactness of the v3 layout copy.
- Effects of exit on `settle` and `opened`.
- Delay decreases versus the exit timelock.
- Issuer Home-route nonce handling, and event privacy.

## 7. Decisions (the user, 2026-11-09)

Each is recorded in `docs/decisions.md`.

| # | Question | Outcome |
|---|---|---|
| D480 | Should turning off shared login still wait, and need a Google client left? | No: D460 is dropped. It stays immediate and needs no remaining Google client; `disable_shared_login` keeps working unchanged; `remove_client` of the last Google client keeps today's rule. |
| D481 | Should Hana stay an owner of Enterprise scopes? | No: D464's owner seat is dropped. Hana holds no owner rights over partner scopes. |
| D482 | How long must a new exit client wait? | The upgrade delay (`governance_delay_ms`, 72 h on mainnet). |
| D483 | Can Hana remove an exit client at once? | Yes: the council removes it immediately and it is retired forever. Amends D468's "under a timelock", for removals only. |
| D484 | Should exit use its own Google client? | Yes: a new, dedicated client in the same Google Cloud project as the shared client, so the contract can tell an exit from a normal login, by `aud`. It adds no security boundary on Google's side and no defence against a compromised Hana page. Its only redirect can be Home's page. The same Google `sub` across clients must be confirmed live before use. |
| D485 | Should email exit reach scopes that dropped email? | Yes, as D468 says, accepting that a stolen email signing key reaches further. A second signer for the email issuer is a priority (readiness 2.5a). |
| D486 | Limit exit sessions? | Yes: on chain, 30 minutes and 3 uses; `link_jwt` is refused on them. |
| D487 | Add an on-chain alert counter for exit use? | Yes: hourly, alerts and never refuses, for the watchdog; one event per session. |
| D488 | Add a waiting period before exit releases a key? | No. |
| D489 | What should Enterprise partners be told? | Plainly that they can't exclude Hana Home (readiness 9.12); legal reviews 9.6's "keep clients 2 years" wording. |

Exit is permanent only within limits: a pause stops it, Hana can remove it, and it depends on Google keeping the client alive.

## Critical files for implementation
- contracts/hana-signer/src/registry.rs
- contracts/hana-signer/src/sessions.rs
- contracts/hana-signer/src/lib.rs
- contracts/hana-signer/src/migrate.rs
- apps/watchdog/src/diff.ts
