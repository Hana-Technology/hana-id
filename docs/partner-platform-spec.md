# Partner platform: a network's backend API and per-app User IDs (build spec)

A **network** is an organisation that embeds our SDK in its own SDK and switches our sign-in on for its own partners
from its own partner portal (Sodax is the first, D909). This spec is what to build so that:

- **(A)** the network's backend can create and manage its partners' test apps on its own scope, through a
  service-to-service **platform API**, without a person signing in to our partner portal for each partner;
- **(B)** each partner app on the network's shared scope gets **its own User ID** in the identity token, while the
  network (the scope's owner) and Journear staff can still link one person's IDs when they need to diagnose a problem.

Status: **proposed, not built.** Decisions: D917 (the Tech Lead's confirmations of 2026-11-25, including four eyes for
staff proposals on a shared scope), D913 in `decisions.md` (the Tech Lead's answers of 2026-11-24, including
the eleven open questions of this spec's first version, answered "yes all" to the recommendations) and D914 (the Tech
Lead's answers of 2026-11-25 to the nine further questions N1 to N9, with N3 decided differently from the
recommendation: an owner's confirmation, A15; and question 8 re-confirmed as **no**), on top of D909 (one wallet
across the network's partner sites). Built on the recommendation for who vouches for a partner's web address; to be
adjusted after the Tech Lead has talked to the network. This version folds in PR 139's security review (its findings
are named H1 to H3, M1 to M9 and L1 to L16 below, each tied to the build piece it gates).

**Piece P0 built** (2026-11-25, branch `feat/shared-scope-rules`, D915): the shared-scope rules of the P0 row below.
Its current state is in `api.md`, `architecture.md`, `security.md` and `operations.md`; every other piece is still
proposed. **Piece P6 built** (2026-11-25, branch `feat/app-user-ids`, D919, not merged, not deployed): per-app User
IDs as B2 to B4 and B7 describe, with migration **0030** (0028 and 0029 are piece P2's); its current state is
in the same docs and `integration.md`. Where it differs from Part B, D919 says so (the triggers' insert rule, the
`'scope'` app on a marked scope having an `end_user_apps` row, the erase script's inputs). **Piece P7 built**
(2026-11-25, branch `feat/app-user-linking`, D925, not merged, not deployed, no migration): the linking of B6 (the
console's panel and per-app search for owners, its audit, limits and volume alert, the staff lookup of either code,
Passport Home's line); its current state is in `api.md`, `architecture.md`, `security.md` and `operations.md`. Where
it differs from B6, D925 says so (Home's line names no network, the audit row's app, the staff lookup listing an
ambiguous code's matches).

Last verified: 2026-11-25 (branch `feat/app-user-linking`, from `next`, not merged: the status line of piece P7, D925; no other text changed); 2026-11-25 (branch `docs/sodax-decisions`, from `next`, not merged, docs only: a partner on the network's own widget (A4.5, A5, A8, A10, A13, A15, the build plan's later pieces P11 and P12, "What the network builds"), D926); 2026-11-25 (branch `chore/tidy-1125`, from `next`, not merged: "Passport Home's apps" and A11's open item, D922); 2026-11-25 (branch `feat/app-user-ids`, from `next`, not merged: the status line of piece P6, D919; no other text changed); 2026-11-25 (branch `docs/confirmations-1125`, from `next` @ b3783b46, docs only, not merged: the Tech
Lead's confirmations of D914's proposals and the four-eyes rule for staff proposals on a shared scope (D917) folded
into A2, A3, A6, A7, A8, A11, A14, A15 and the build plan; the admin portal's identity checked in
`apps/admin/src/access.ts`); 2026-11-25 (branch `docs/platform-answers`, after PR 142's review: its 16 findings folded in (revocation
cancels waiting proposals, the confirmation's removal link, one ledger row per confirmation set, a create's origins as
platform proposals, the email's wait line, the CLI's announce, staff proposals on shared scopes, the code citations of
who may confirm, the database's earliest time, the `local*` guard); the Tech Lead's rule on keys (four eyes) and
"ok with fresh sign in when confirming"; every cited file checked again against `next` @ 0b99ec12); 2026-11-25
(branch `docs/platform-answers`, docs only, not merged, from `next` @ 0b99ec12: the Tech
Lead's answers to N1 to N9 and question 8 (D914) folded into every section; the owner's confirmation (A15) and its
piece P10 added; the staff restore removed (A14); the console's roles and step-up kinds and `guarded_changes` checked
against the code); 2026-11-24 (branch `docs/partner-platform-spec`, docs only, not merged: after PR 139's security review,
every cited file and line checked again against `next` @ 6f51a033); 2026-11-24 (the same branch, first version, from
`next` @ 6f51a033).

How to read it: **Exists today** marks what the code does now, with the file it is in; **Proposed** marks what this
spec adds. Nothing here is built.

## 0. Summary

| | Proposed |
|---|---|
| Who calls | The network's backend only, with a request-signing key (ECDSA P-256, ES256) whose public half is registered with us for one organisation, one env and one or two of its test scopes |
| What it may do | Only on apps it created on those scopes (decided, N1): create a test app; propose and remove web addresses; cancel its own waiting proposals; read an app and its publishable keys; suspend and resume; create and revoke publishable keys |
| What it may never do | Owners, Google clients or anything on chain; auto-approve policies; raw signing; gas sponsorship; the mainnet demo; partner labels; live apps; deleting apps; confirming a web address (only an owner in our partner portal can, A15); any app it didn't create, any live app, any other scope or organisation |
| Who vouches for a web address | The network, for every partner site it adds, and then one of its owners (decided, N3). A web address the network's backend proposes is announced to the organisation's security contacts and to Journear, with the usual cancel link, as today. It comes into force **at once when an owner of the organisation confirms it** in our partner portal (signed in, on a page that shows the app and the address; A15). If nobody confirms it, it comes into force after at least 24 h (the platform minimum, in every env except `local*` test envs, and at least our guarded-change delay), unless cancelled. So a stolen platform key alone gets only the slow, cancellable path |
| A new platform key | Announced to the security contacts, every owner and Journear; in force when an owner confirms it in our partner portal, or after 24 h. On a test setup any owner may confirm, the registrant too; on a real-money setup only a **different** owner (four eyes), so an org with one owner always waits (A3, D914). Revocation is immediate |
| Off switches | Journear staff: revoke the network's key at once, switch the platform off for the organisation at once, suspend any one partner app at once (Journear's own bit, which the network can't clear) |
| Audit | Every call that passes the signature check is recorded, reads included; failures before it are counted and alerted on, not stored; every write is also an `app_changes` row with the new actor kind `platform` |
| Shared scope rules, in code | Auto-approve refused for every app on a shared scope and every platform-created app (piece P0, before the platform is switched on for any org) |
| Per-app User ID | New apps on a scope marked for it get a `sub` (and Support ID) of their own, derived from the person's scope-level User ID and the app id; no existing app's IDs change |
| Linking | The network's on-chain owners in our partner portal, and Journear staff in the admin portal, can see one person's IDs across the network's apps; partners can't through the IDs |
| Honest limit | On a shared wallet the wallet **addresses are the same on every site** and are in every identity token: partners who compare addresses can match users anyway. Per-app IDs remove the free join key; they are not privacy between partners |
| On chain | Nothing. No contract call, no new contract state, no change to any key or address derivation. **Address impact: none** |

## 1. What exists today (the parts this builds on)

**Organisations, scopes and apps.** A scope belongs to exactly one organisation and one environment (`scopes`,
`apps/api/migrations/0006_dashboard_expand.sql`; D51: test and live apps never share a scope). An app belongs to one
scope; its org follows the scope's (trigger `scopes_org_update`). Apps are created only by Journear staff:
`AdminRpc.createApp` (`apps/api/src/rpc/admin.ts` → `createApp` in `apps/api/src/changes/admin.ts`) or the admin CLI
`app:create`. `createApp` refuses an org with no security contact (`no_security_contact`), reads the scope on chain and
checks every on-chain `Owner::Oidc` is an owner of the org (`requireOwnersInOrg`, `changes/chain.ts`), creates the
scope row when it is new, writes the app with its first publishable key, and the initial origins as staff proposals.

**The writers filter on the org only.** Every app write's plan read (`planApp`, `apps/api/src/changes/apps.ts:162`,
`LEFT JOIN apps a ON a.id = ? AND <orgFilter>`) and its commit row (`commitOnApp`, `apps/api/src/changes/cas.ts:85`)
restrict to `org_id` and nothing else; so do the key writers (`changes/keys.ts:49-96`), `removeOrigins`
(`changes/origins.ts:49`), `setSuspensionBit` (`changes/suspension.ts:17`) and `cancelChange`
(`changes/lifecycle.ts:94`, which cancels any pending change of any kind on any app of the org). That is right for the
console and staff, who act for the whole org; a platform credential must be held to less (H1, H2).

**Origins as guarded changes.** Adding an origin is a guarded change (`guarded_changes`, kind `origin_add`, with an
`app_origins` row whose `active_from` is NULL until it is announced; `apps/api/src/changes/origins.ts`). Staff
proposals (`addOrigins`) wait `appChangeDelayMs` after a scope's assignment to an org (`conflict` otherwise). Member
proposals (`ConsoleRpc.changeOrigins`) carry a fresh Google sign-in of an on-chain owner of the scope, which the API
verifies itself (`apps/api/src/changes/step-up.ts`: signature, console audience, `iat` ≤ 300 s, nonce bound to the
exact change and `origins_version`, uncached on-chain owner check, single use in the `owner-actions:tokens` limiter).
At most 20 active or pending origins per app (`MAX_APP_ORIGINS`, `packages/console-core/src/origins.ts`). An origin's
rules (`originProblem`, `packages/console-core/src/origins.ts:226-241`) allow loopback and the localhost wildcard only
on test scopes in dev envs, require https otherwise, and refuse mixed-script host labels on live scopes only. Removals
are immediate (`removeOrigins`).

**The lifecycle** (`apps/api/src/changes/lifecycle.ts`): the admin Worker's 5-minute cron reads
`AdminRpc.pendingNotices` (each with the org's `org_security_contacts`), emails the security alias and every security
contact with a cancel link, one message per change, and only then calls `ackNotice` (`system` actor only), which sets
`active_from = now + delayMs` and stores `sha256` of the cancel link's token (`apps/admin/src/notices.ts`). The delay
is `APP_CHANGE_DELAY_MS`: at least 60 s anywhere, at least 24 h on the production network
(`apps/api/src/guarded/config.ts`); sandbox-dev's manifest sets 60 s (`envs/sandbox-dev.json` `appChangeDelayMs`). A
change can be cancelled until it is in force by an owner (`ConsoleRpc.cancelChange`), by staff, or by the emailed link
(`cancelChangeByLink`, actor `link`). Two waivers exist, both only for `member` or `hana` proposals: `loopback` (a
member's loopback origin on a test scope in a dev env) and `no_session` (a scope nobody has used yet). Expedite is for
member proposals only (`expediteChange`). The hourly job cancels a change not announced within 7 days and records
activations (`apps/api/src/guarded/cron.ts`). The notice email names the proposer as "Journear staff", "a console
member" or "the system" (`apps/admin/src/email/messages.ts`, the "Proposed by" row). The admin Worker already emails
every owner of an org for member invites and owner grants (`apps/admin/src/notices.ts`, header).

**Writes and audit.** Every RPC write is one D1 batch whose first statement inserts its `app_changes` row
(compare-and-swap; `request_id` UNIQUE, for the ledger's 60-month life, gives idempotency: a replay is
`already_applied`, a reused id for another write or by another actor `conflict`; `apps/api/src/changes/cas.ts`
`refuseReplay`). `app_changes` is append-only for 60 months (triggers `app_changes_no_update` and
`app_changes_no_early_delete` in 0006). Its `actor_kind` is CHECKed to `member`, `hana`, `system`, `link`, and
`guarded_changes.proposed_by_kind` to `member`, `hana`, `system` (0006); `ACTOR_KINDS` and `PROPOSER_KINDS` in
`packages/console-core/src/types.ts` say the same. The console's own `audit_log` (`apps/console/migrations/0001_init.sql`)
records its members' actions; the console's Audit page merges it with the API's `app_changes`.

**Admission.** `ConsoleRpc` calls are admitted by per-org and global token buckets with a reserve only kill switches
may spend, and a destructive-call breaker (5 per org and 20 across orgs per rolling hour) (`apps/api/src/changes/guard.ts`,
`apps/api/src/rpc/common.ts` `runRpc`), all on one `RateLimiter` object `console-rpc` under the keys `console:bucket`,
`console:breaker:org:<org>` and `console:breaker:global` (`apps/api/src/rate-limiter.ts` `consoleAdmit`). A console
call is held to `CONSOLE_DB_LIMITS` (2 reads, 1 batch, 8 statements; `apps/api/src/changes/db.ts`). `AdminRpc` is
neither counted nor charged. The `RateLimiter` Durable Object offers fixed and sliding windows (`hit`, `unhit`,
`hitSliding`) and single-use reservations (`reserve`, `release`); shared objects are pinned to the env's
`DO_LOCATION_HINT` by `placedStub` (`apps/api/src/placement.ts`), per-IP ones are not.

**Keys and suspension.** Publishable keys `pk_test_`/`pk_live_` + base58, at most 5 unrevoked per app, rotation keeps
the old key 24 h, revoke is immediate and may revoke the last key (`apps/api/src/changes/keys.ts`). Keys are public:
"There is no secret-key (`sk_…`) auth anywhere: publishable keys are public and origins gate them" (`docs/api.md`,
Routing). Suspension is a bitmask: Journear 1 (per app), org 2 (every app of an org, Journear), partner 4 (the
console's owners); only Journear clears 1 and 2; setting a bit already set writes nothing
(`apps/api/src/changes/suspension.ts`). In the console, resuming needs a fresh sign-in (`pending_actions` kind
`app.resume`, `apps/console/migrations/0001_init.sql`).

**Shared-scope safety today.** Raw signing is refused for test apps (D39). Gas sponsorship for EVM actions is not
live, and when it is, its apps are a staff-only allowlist in the env's manifest (`evm.sponsor.apps`, at most 8 apps;
`envs/README.md`, D835), deployed by staff: nothing an org can call reaches it. The mainnet demo is a staff switch per
test app in a dev env (D428). Auto-approve policies are a guarded change an on-chain owner or staff proposes
(`proposeChange`); nothing in the code refuses them for an app on a scope that several partners share
(`docs/sodax-sdk-integration.md` section 4 lists them as "must stay off", a rule kept by hand today).

**The console's people.** An org's members are `owner` or `viewer` (`members`, console migration 0001); a member sees
every app and every user of every scope of the org: per-app access doesn't exist (`docs/sodax-sdk-integration.md`
section 4, gap 3). Security contacts are per org, set by Journear staff only (`setSecurityContacts`,
`changes/admin.ts`, with an `org.security_contacts` row in `app_changes`). New step-up kinds have been added before by
rebuilding `pending_actions` (`apps/console/migrations/0004_label_step_ups.sql`).

**The identity token's User ID.** `sub` = `"u1_"` ‖ base64url of the first 16 bytes of HMAC-SHA256(`IDENTITY_SUB_KEY`,
`"hana-id/idt-sub/v1"` ‖ 0x00 ‖ borsh(scope_id) ‖ borsh(root provider) ‖ borsh(root sub)) (`identitySub`,
`identitySubBytes` in `packages/core/src/identity.ts`; used by `apps/api/src/identity/token.ts` at mint). So `sub` is
**per scope**: every app of a scope gives one person the same `sub`. `aud` is the app id, `sid` is already per app and
session. The same value is the User ID in the wallet directory (`end_users.token_sub`, UNIQUE, migration 0011;
`directoryUser` in `apps/api/src/directory/store.ts`), the key of `email_consents.user_sub` (0014) and
`name_shares.user_sub` (0021), and the source of the Support ID (`HANA-XXXX-XXXX`, the first 5 of its 16 bytes,
`supportIdFromSub` in `packages/core/src/support-id.ts`). The session answers of `/v1/login` and `/v1/sessions` carry
that Support ID (`sessionSupportId`, called from `apps/api/src/login.ts` and `apps/api/src/handlers.ts`), which
`hana.supportId` shows; the partner guide tells partners to compute it from `sub` themselves (`docs/integration.md`,
the `sub` claim and "Support ID from the `sub`"). `buildIdentityClaims` refuses a `sub` that isn't `u1_` + 22
characters. `IDENTITY_SUB_KEY` is never rotated (D127); `docs/security.md` reserves a `u2_` scheme for the day it
leaks. The identity vectors are written by `packages/core/scripts/gen-identity-vectors.mjs`, an independent
`node:crypto` implementation.

**Retention.** A deleted app's `email_consents` and `name_shares` rows are purged 30 days after its deletion, and a
scope's wallet directory 30 days after its last app's deletion (`purgeDirectory`, `apps/api/src/changes/retention.ts`);
`scripts/lib/uid-erase.ts` erases one person on request.

**Passport Home's apps.** `GET /v1/home/apps` lists, per scope, the apps that have had a login, at most 10 apps per
scope in one answer (`HOME_APPS_PER_SCOPE`, `apps/api/src/home/apps.ts`). Since D922 (branch `chore/tidy-1125`, to
confirm) every scope also says how many apps it has (`appsTotal`) and one scope's answer carries up to 100, so Home
says "and N more apps" and shows them on the wallet's page; none is left out without a word.

**Not there today:** any service-to-service caller, any `platform` actor, any per-app User ID, any record of which
apps of a scope a person has used, any code rule tied to a shared scope.

---

# Part A: the platform API

## A1. What it may do, and never

The platform's **reach**: apps of the credential's org, on a scope the credential names, on a `test` scope, and
created by the platform (`apps.created_by_kind = 'platform'`; decided, N1: it sees and changes only apps it created).
The network's own apps and every staff-created app of the org stay outside it.

| May (only within its reach) | Never |
|---|---|
| Create a test app (name, first origins) on one of its scopes | Create a scope, or an app on a live scope or another org's scope |
| Read an app: name, status, origins, its waiting and in-force origin changes (and whether an owner confirmed each), its publishable keys | Read settings beyond those (no policy, raw signing, mainnet demo, labels, Google client, sponsorship) |
| Propose origin additions (guarded changes), which come into force when an owner of the org confirms them in our partner portal, or after the delay with the platform minimum (A15) | Confirm an origin, its own or any other (the confirmation is a console route only an owner reaches, never a platform route, A15); any waiver; expedite (decided, D913 question 11) |
| Remove origins (immediate) | Owners, Google clients, shared login, anything on chain |
| Cancel waiting `origin_add` changes that a platform key of its org proposed | Cancel any other change (H2) |
| Suspend an app (the partner bit 4) and resume a suspension the platform set and no member has taken over (A4.6) | Clear Journear's bits 1 or 2, or a member's suspension |
| Create and revoke publishable keys | Delete an app (staff only) |
| Read its own credential's status; revoke its own key, also while the org's switch is off | Register or reactivate any key |
| | Auto-approve policies (refused in code for its apps, P0), raw signing, gas sponsorship (staff-only manifest allowlist, unreachable from any API), the mainnet demo (D428: a staff switch per partner app, D913 point 2), partner labels, email-sharing or session settings, logos, renames after creation |

Live apps: not in this version. The same credential model will serve the network's future live scope (decided, N2),
with a separate key and its own security review before any live app is opened to it; until then a live app for a
network partner is created by Journear staff, as today.

## A2. Threat model

| Threat | What it could give | What stops or bounds it |
|---|---|---|
| **A stolen platform credential** (the network's private key) | Create test apps under the network's name; propose look-alike origins; remove origins, suspend apps and revoke publishable keys of the platform's apps (denial of service); read publishable keys (public anyway) | Its reach (A1) and the reach filter inside every plan read and commit (H1); every origin it adds waits at least 24 h (the platform minimum, and at least the delay) after an email to the org's security contacts and to Journear, cancellable from the email, unless an owner confirms it in our partner portal, which the key can't do (A15); creation and proposal quotas (A5); the platform's own destructive-call breaker (M3); staff revoke the key or switch the platform off for the org at once, and a revocation, the switch-off or a freeze of the org **also cancels every origin the key proposed that isn't in force yet** (A3), since an announced origin otherwise comes into force by itself when its time comes; anomaly events to staff (A5). It can never touch owners, the chain, policies, raw signing, sponsorship, the mainnet demo or labels, so it can't move or sign anything on its own |
| **A malicious or compromised partner site** (one of the network's partners) | On a shared wallet: ask any of the scope's users to approve moves from the one wallet, from its own origin | The user's approval window names the app and its web address; the "also used on other apps" line (another branch; decided, N6: it ships before the platform is on for any org); auto-approve refused in code for every app on a shared scope (P0, H3), raw signing refused for test apps, sponsorship staff-only, the mainnet demo staff-only with a warning for a platform-created app (A11); staff suspend the app at once (bit 1); the network removes its origins at once. A partner has no platform key and no console |
| **A malicious network insider** | Everything a stolen credential gives; with console access as an owner, also the cancel links and the linking view (Part B); registering a key of its own and, on a test setup, confirming it at once (A3); as an on-chain owner of the scope, proposing an origin through the platform and confirming it at once (A15), where adding it by hand on a production network would wait the full delay (the open point of A15) | Origin additions also notify Journear, and a confirmation notifies the security contacts, every owner and Journear and names who confirmed (A15); and staff see every platform proposal on the admin portal's queue; a key registered by an owner is announced to the security contacts, the org's owners and Journear, naming who registered it (M5), and on a real-money setup comes into force before the 24 h only when a **different** owner confirms it (four eyes, A3); a staff-registered key needs an owner's acceptance or a second staff member (M5); a registration within 7 days of a security-contact change is refused (M5); every call is audited where the network's other owners and Journear see it; linking lookups are audited and their volume alerted (L9); Journear's per-app suspensions can't be undone by the network |
| **A Journear staff member acting alone** | Register a key for an org | A staff-registered key comes into force only after the network's owner accepts it with a fresh sign-in (then, proposed, at once once announced: the acceptance counts as the confirmation, A3), or a second staff member approves it (then after the delay, unless an owner confirms it), and always after the notice (M5) |
| **A key confirmed by a taken-over owner account** | On a test setup: one taken-over owner account registers a key and confirms it itself, in force within minutes | Accepted on a test setup (the Tech Lead, D914: an owner can already add an origin there with the 60 s delay, test funds are worthless); the notice to every owner, the security contacts and Journear names who registered and confirmed; revocation is immediate by any owner or staff. **On a real-money setup** one taken-over owner account alone can't: the confirmation needs a different owner (A3), so the key waits 24 h, announced, cancellable (the open point of A3 and D914) |
| **One person posing as two owners** (to pass the four-eyes rule) | A key in force at once on a real-money setup on one person's word | The confirmer must differ from the registrant in console user, Google `sub` and email, and have been an owner since before the registration (A3); a new owner waits the owner-grant delay and is announced to every owner (D89). Residual: one person with two separate Google accounts, both owners for long enough, or two owners who collude |
| **The platform key confirming a key** | A stolen key bringing a new key into force | No platform route confirms anything; `ConsoleRpc.confirmPlatformKey` refuses every actor but a member (A3, A8) |
| **Replay** of a captured request | Repeat a write | Each request is signed over the env, its method, path, body hash, key id, time and a single-use nonce; ±60 s clock window; the nonce is reserved until the window ends (A3); writes also carry an idempotency key (A9) |
| **Confused deputy between orgs, scopes or environments** | Network X acting on network Y's app; a credential acting on a live app, a staff-created app or another scope of its own org | The org comes only from the credential, never from the request; every plan read and every commit predicate holds the reach filter (org, the credential's scopes, `environment = 'test'`, platform-created), not only a check at the route (H1); a cancel is held to platform-proposed `origin_add` changes (H2); anything outside the reach is `not_found`, exactly like an app that doesn't exist; a key's scopes are checked against `scopes.org_id` at registration and inside every call |
| **Enumeration** (of apps, changes, keys, credentials) | Learn other orgs' app ids or which key ids exist | Ids are random (`newId`, 12 random bytes); unknown and foreign ids answer the same `not_found`; every authentication failure answers the same `401 unauthenticated`; failures are limited per IP, successes per key |
| **App creation abused to phish under the network's name** | An app named like the network or a known partner, with an attacker's origin | The origin waits the delay with the announcement (the notice shows the origin, its decoded form and the internationalised-domain warning that exists today); platform origins follow the live-scope rules (no loopback, no http, no mixed-script host, M7); app names pass `normalisePartnerAppName` (`packages/console-core/src/names.ts`: Journear's names and the reviewed lists refused) and, new, a name that reads like another app's name **on the same scope** is refused (the look-alike skeleton the labels already use; apps on other scopes or of other orgs aren't compared, L15); creation quotas; staff see every platform-created app |
| **Origin takeover of an expired domain** | A partner lets its domain lapse; someone else registers it and serves a page on an origin that is still allowed on the shared wallet | The network must remove a partner's origins when it leaves (A13); the platform's read shows each origin's age; piece P9 reports origins with no sign-in for 60 days to the network and staff (decided as a later piece, D913 question 9); HTTPS only; staff suspend at once |
| **The dev testnet env's short delay** | On sandbox-dev the delay is 60 s and the notice job runs every 5 minutes, so an added origin is in force about a minute after its email: nobody can cancel it in time. The delay protects almost nothing there, and sandbox-dev is where the mainnet demo (real money, D428) runs | A platform minimum delay of 24 h in every env but `local*` test envs (M6): for platform-proposed origins (decided, N3) and for platform keys (decided by the Tech Lead's later rule on keys, D914). An origin or a key comes into force sooner only when an owner confirms it (A15, A3), never on the platform key's word alone. Staff proposals on a flagged scope or a platform-created app: the same minimum, unless a second person confirms them (four eyes, decided by the Tech Lead, D917; A15). The platform is not switched on for any org until the minimum and the confirmations (P2, P4, P10) are built, reviewed and deployed |
| **A confirmation by a taken-over owner account** (someone holds one owner's Google account) | Through the platform, nothing: a Google account proposes nothing there. Together with a stolen platform key, or with any origin the key proposed: confirm an attacker's origin at once, with no time to cancel. **The accepted risk** (the Tech Lead, N3: an owner whose own Google account is taken over has more at risk than this) | The confirmation needs a console `owner` member who is also an on-chain owner of the app's scope, with a fresh Google sign-in (decided, D914, A15); the confirmation's notice goes at once to the security contacts, every owner and Journear, naming who confirmed; the user's approval window names the app and its web address, with the "also used on other apps" line (N6); staff suspend the app at once; the network or an owner removes the origin at once |
| **Confirm fatigue** (owners confirm by habit, without reading) | An attacker's origin confirmed by a real owner | The email never confirms: its Confirm link only opens the console page; the page shows the app, the origin in full and decoded, the internationalised-domain warning, who proposed it and when; each origin is ticked one by one (none ticked at first, no "confirm all"); each confirmation is its own fresh sign-in; the platform's proposal quotas (A5) bound how many there can be |
| **CSRF on the confirmation**, a mail scanner or a forwarded email | A confirmation nobody meant | A GET never confirms (the page only shows the proposal); the confirm is a console `POST` under the console's CSRF rules (`apps/console/src/csrf.ts`: `Sec-Fetch-Site`, `Origin`, the custom header, JSON) with a `SameSite=Strict` session, and the fresh sign-in's nonce is bound to the exact change ids, app and origins (A15); a forwarded email gives its reader the page, not a session |
| **A confirmation racing a cancel or a key revocation** | An origin in force after someone cancelled it, or after the proposing key was revoked | A revocation cancels the key's waiting proposals in its own batch (A3), so nothing is left to confirm; the confirmation is one compare-and-swap batch whose commit predicate requires every listed change still `pending`, announced, not cancelled and not yet in force, the proposing key in force and the org's platform switch on (A15); whichever lands first wins, and a cancel or revoke that lands first makes the confirmation write nothing |
| **A confirmation after the app left the platform's reach** (deleted, moved, its scope dropped from the key, suspended by Journear) | An origin in force on an app the platform should no longer touch | The same commit predicate holds the proposing key's reach (A4.2) and refuses an app Journear suspended (bit 1 or 2); a refused confirmation leaves the proposal as it was (still waiting, still cancellable) |
| **A leaked request log** at the network or in transit | A captured signed request | No bearer secret in any header; the signature covers the body and a single-use nonce, so a logged request can't be reused or altered |
| **Our D1 read by an attacker** | The registered public keys and the call log | Public keys sign nothing; nothing secret of the network is stored on our side |
| **Flooding the platform route** | Spend the hot DB or the limiter objects; lock the network out from a shared egress IP | Failures are limited per IP and counted only while they fail (M2), so a valid key is never locked out by others behind the same IP; successes are limited per key; the org's own bucket under the global one keeps the kill-switch reserve (A5) |

## A3. Authentication

### Options compared

| | **1. Per-org asymmetric request signing** (decided: ES256 only, D913 question 1) | **2. OAuth 2.0 client credentials** (a client id and secret, or `private_key_jwt`, for a short-lived bearer access token) | 3. Mutual TLS |
|---|---|---|---|
| Secret on our side | None: we hold only public keys | A client secret's hash (secret variant); for `private_key_jwt`, a public key, plus our own new access-token signing key to protect | A CA or pinned certificates |
| What a leaked request or log gives | Nothing reusable: each request is signed over its body and a single-use nonce | The bearer access token: every call it allows until it expires (minutes), from anywhere | Nothing |
| Body integrity | Yes, the body hash is signed | No (TLS only) | No (TLS only) |
| Replay protection | Built in (time and nonce) | Only by short token life | n/a |
| Moving parts on our side | One verifier on the route, a nonce reservation per request | A token endpoint, token minting and its key, token checks on every route | Certificate handling at Cloudflare's edge, which isn't on the free plan we stay on (D417) |
| Moving parts on the network's side | Sign each request (a small function; we ship a reference implementation and test vectors) | A standard OAuth client library | Certificates on every backend |
| Key in a cloud KMS or HSM | Yes (ECDSA P-256 is in every major KMS) | Yes for `private_key_jwt`; no for a secret | Usually |

**Option 1, ECDSA P-256 with SHA-256 (ES256), the algorithm our identity token already uses.** It keeps the property
our system has everywhere else, that no shared secret exists to leak from our database or a request log, and it binds
every request to its exact body, time and nonce. Option 2 was rejected because it adds a bearer token that any log or
proxy can replay for its lifetime and a token endpoint with its own signing key to protect; option 3 because of
certificate operations and its Cloudflare plan cost.

### The request (gates P3: L1, L2, M4)

Methods: `GET` and `POST` only (anything else `405 method_not_allowed`). A `POST` has
`content-type: application/json` exactly (optionally `; charset=utf-8`), no `content-encoding` header, and a body of
at most 16 KiB; a `GET` has no body. Every request carries these headers, each matched in full:

| Header | Value | Exact form |
|---|---|---|
| `Journear-Key-Id` | the credential's id | `pkc_` and the body of every console-core id (`newId`: base58 of 12 random bytes, `packages/console-core/src/ids.ts`), checked with the same id rule |
| `Journear-Timestamp` | the network's clock, unix milliseconds | `^[1-9][0-9]{12}$` |
| `Journear-Nonce` | 16 random bytes, base64url without padding, never reused | `^[A-Za-z0-9_-]{21}[AQgw]$` |
| `Journear-Signature` | the signature, 64 bytes `r ‖ s` (IEEE P1363), base64url without padding | `^[A-Za-z0-9_-]{85}[AQgw]$` |
| `Idempotency-Key` | writes only (A9) | `^[A-Za-z0-9_-]{8,64}$` |

**The path, parsed once.** The API parses `request.url` once (`new URL`) and uses that one result both to route and to
build the signed message: the path must match `^/v1/platform(/[A-Za-z0-9_-]+)+$` (so no empty segment, no `.` or `..`
segment, no percent-encoding, no trailing slash), and the query, when present, must match
`^\?[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}(&[a-z][A-Za-z]{0,31}=[A-Za-z0-9_-]{1,128}){0,3}$` (writes take no query).
Anything else is `400 bad_request` before the signature is checked, so nothing ever needs normalising.

**The signed message** is these lines joined by `\n` (0x0A), UTF-8, no trailing newline:

```
journear-platform-v1
<ENV_NAME>                           (the env's name)
<SIGNER_ACCOUNT>                     (the env's contract account: with ENV_NAME, a request for one env never verifies in another)
<method, uppercase>
<path, then the query as parsed above, or nothing>
<Journear-Key-Id>
<Journear-Timestamp>
<Journear-Nonce>
<Idempotency-Key, or empty>
<sha256 of the exact body bytes, lowercase hex; of the empty string for a GET>
```

**The signature is plain ES256 over that message** (M4): ECDSA on P-256 with SHA-256, the signer hashing the message
bytes once (WebCrypto `sign({name: 'ECDSA', hash: 'SHA-256'}, key, message)`; a KMS asked to sign a digest is given
`sha256(message)`). On the wire it is the raw 64-byte `r ‖ s`, each 32 bytes big-endian left-padded with zeros. A KMS
that answers DER (`SEQUENCE { INTEGER r, INTEGER s }`) is converted by the client: read both integers, drop a leading
0x00, left-pad each to 32 bytes; a DER signature sent as it is fails the length rule and is `401`. **Both S values are
accepted** (low and high): replay protection is the nonce, not the signature's form, and requiring low S would refuse
KMS signatures for no gain. The verifier is WebCrypto `verify({name: 'ECDSA', hash: 'SHA-256'}, publicKey, sig,
message)`.

**The checks, in order, failing closed** (M2, L5):

1. **Per IP, failures only**: a `hit` on `platform:ip:<ipSubject>` (30 a minute), given back (`unhit`) as soon as the
   signature verifies; so only failing requests use the window, and a network whose backends share an egress IP with
   someone failing can still always reach its kill switches. Not pinned (as today's per-IP limiters).
2. A request with an `Origin` header: `403 browser_refused`, with no CORS headers (the platform API is never for
   browsers).
3. The method, content type, encoding, path, query and header shapes above (`400 bad_request` for the path and query;
   `401 unauthenticated` for a malformed authentication header).
4. The timestamp within ±60 s of the API's clock (else `400 stale_request {serverTimeMs}`, which says only the time).
5. The key id names a credential in force (`active`, `active_from <= now < expires_at`, not revoked) **in this env**,
   and the signature verifies with its public key. Any failure of 5, whatever the reason (unknown, revoked or expired
   key, bad signature), is the same `401 unauthenticated` with no detail.
6. The org's platform switch is on (else `403 platform_off`, answered only to a valid signature). The one exception:
   `POST /v1/platform/credential/revoke` is allowed while the switch is off, so a network can always kill its own key.
7. The nonce, reserved until timestamp + 120 s on the `RateLimiter` object `platform-nonce:<keyId>`, created through
   `placedStub` so it is pinned to `DO_LOCATION_HINT` (its name then ends `@<hint>`, as every pinned object's does);
   a second use is `409 request_replayed`.
8. The per-key and per-org limits (A5). Only then is the body parsed.

A reference signer (TypeScript, WebCrypto, with the DER conversion) and fixed test vectors ship with the network's
guide, generated by an independent implementation (as `packages/core/scripts/gen-identity-vectors.mjs` does for the
identity token): a key, a GET, a POST with a body, a POST with an Idempotency-Key, a **high-S signature that must
verify**, a DER signature that must be refused, and a request signed for another env that must be refused.

**One key per env** (L2): each env has its own D1, so a credential exists in one env only; the network should also use
a different key pair in each env, so a test env's key can never sign for another.

### Registration, rotation, revocation (gates P2: M5, L6)

A **credential** is one public key for one org and one or two of its test scopes, in one env, with a label. At most two
credentials in force or waiting per org, so one can replace the other.

**Registration** (a new kind of guarded change, A6), by either:

1. **an on-chain owner of each scope it names** (decided, D913 question 2), in our partner portal, with the existing
   fresh Google sign-in: a new step-up kind `platform.key_add` whose nonce covers the signer account, the env, the
   org, the scopes, the key's RFC 7638 thumbprint and the label; the API verifies the token itself with
   `verifyStepUpToken` and runs `confirmStepUp` **once for each scope** (`changes/step-up.ts`, unchanged), so a
   credential for two scopes needs an owner of both (L6); or
2. **Journear staff**, in the admin portal, after checking the key's thumbprint with the network out of band. A
   staff-registered key is held as `awaiting_acceptance` until **an on-chain owner of each scope accepts it** in our
   partner portal with a fresh sign-in (step-up kind `platform.key_accept`, the same nonce fields), **or a second
   staff member** (not the one who registered it) approves it in the admin portal with a reason (M5; decided, N5).
   Only then is it announced.

Either way the credential is then **pending**: announced by email to the org's security contacts, **to every owner of
the org**, and to Journear's security alias, naming who registered it (the member's email or "Journear staff" with the
staff member's name) and who accepted it, with a cancel link (M5; decided, N9). It then comes into force **when an
owner confirms it** (below), or else after the delay (the greater of `appChangeDelayMs` and the platform minimum of
24 h, in every env but `local*` test envs; decided by the Tech Lead's rule on keys, D914), unless it is cancelled
first. Staff can't skip the wait. The
public key is checked to be a valid P-256 point, unique across all orgs.

**An owner's confirmation of a key** (decided by the Tech Lead 2026-11-25, D914; the "four eyes" rule). The
mechanics are the origin confirmation's (A15): the announcement email carries a Confirm link that only opens the
console's page for that key (label, thumbprint, scopes, who registered and accepted it, when it comes into force if
nobody confirms); **a GET never confirms**; the confirmation is a console route (`ConsoleRpc.confirmPlatformKey`,
after a step-up of kind `platform.key_confirm`) that refuses every actor but a member, so **no platform key can ever
confirm a key**, its own or another; the cancel link stays one click from the email with no sign-in. Only a `pending`,
announced, unconfirmed and uncancelled key can be confirmed. Revocation stays immediate, whatever the key's state.

- **Who may confirm:** the same bar as for an origin (decided by the Tech Lead, D914, A15): a console `owner` member
  who is an on-chain owner of **each** scope the key names, with the fresh Google sign-in (`confirmStepUp` once per
  scope, as the registration). The step-up's nonce has its own label (`"hana-id/console-key-confirm/v1"`) over the
  signer account, the env, the org, the key id, its thumbprint and scopes.
- **The notice of a key's confirmation** (proposed, **still to confirm (the Tech Lead)**: on 2026-11-25 the Tech
  Lead confirmed the removal link of the "address confirmed" email, D917, but the key's revoke link was not put to
  them separately, so it isn't read as covered): the
  security alias, every security contact and every owner get an email naming who confirmed, with a one-click
  **revoke link** valid 7 days (a console page `/revoke-platform-key/:id#t=` with no sign-in, a GET revokes nothing,
  its `POST` revokes at once with the `link` actor), since a security contact need not be a console member and the
  registration's cancel link no longer works once the key is in force.
- **On a test setup** (a dev env: a testnet env that isn't `local*`; `local*` test envs keep their own short delay
  and no 24 h minimum): any owner who meets the bar may confirm, **including the owner who registered it**, and the
  key is in force at once. In practice that is **no wait** for an owner-registered key: the owner registers it, the
  announcement goes out on the next notice run (at most about 5 minutes), and the same owner confirms it. Accepted
  there because an owner can already add an origin by hand with the 60 s delay, test funds are worthless, and partner
  testing and an urgent rotation need the speed.
- **On a real-money setup** (an env whose network is `mainnet`, `PRODUCTION_NETWORK` in
  `apps/api/src/guarded/config.ts`): **four eyes.** The confirming owner must be a **different person** from the one
  who registered the key; the registrant's own confirmation is refused (`forbidden`); with no second owner's
  confirmation the key waits the full delay (at least 24 h). An org with one owner therefore always waits.
- **"A different person"** (confirmed by the Tech Lead 2026-11-25, D917): the confirmer must differ from the
  registrant in all of: the console user (`console_users.id`; one console user is one Google account, `UNIQUE
  (provider, sub)`, so this also rules out one user with two memberships), the verified Google `sub` of the step-up
  (against the registration's `proposer_sub`), and the email address (compared in lower case with dots and a `+tag`
  removed from the local part, so `a.b+x@` and `ab@` are one person). And the confirmer must have been an owner of the
  org **since before the key was registered** (`role_since`, or the owner grant's `owner_from`, at or before the key's
  `proposed_at`), so a second Google account made an owner afterwards can't confirm; a new owner already waits the
  owner-grant delay and is announced to every owner (D89, `owner_grants`). The console user and the `sub` are held in
  the API's write itself (the commit predicate and a table CHECK, A7), not only in the console's screens; the email
  and owner-since checks are made by the console's server before it calls the API (the API doesn't hold members'
  emails or roles). **What this can't catch:** one person with two genuinely separate Google accounts, both owners
  since before the registration (on-chain owners too); two owners who collude; a compromised console server, which
  could skip the email and owner-since checks (not the user and `sub` checks).
- **A staff-registered key** (N5) still needs an owner's acceptance first (or a second staff member's approval).
  Confirmed by the Tech Lead 2026-11-25 (D917): an owner's acceptance of a staff-registered key **counts as its
  confirmation**: on a test setup because any owner may confirm, and on a real-money setup because a staff
  registration and one owner's acceptance are already two people. The key then comes into force as soon as its
  announcement has been sent (the next notice run), so the security contacts and owners always hear of it before it
  works. A key approved by a second staff member (no owner involved) waits the delay unless an owner then confirms it
  (any owner: none of them registered it).
- **Refusals shared with registration:** a confirmation is refused while the org's security contacts changed less
  than 7 days ago (as below), and while the org is frozen.

**Refused after a security-contact change** (M5): a registration, an acceptance and a confirmation are refused with
`conflict` while the org's security contacts changed less than **7 days** ago (the latest `org.security_contacts` row
in `app_changes`), so an insider can't swap the contacts and register a key the same week.

**Expiry and rotation.** A credential expires 365 days after it comes into force (decided, D913 question 3); the admin
Worker emails the security contacts and owners 30 and 7 days before. To rotate, register the next key, switch the
network's backend to it once it is in force, then revoke the old one. On a real-money setup the next key waits 24 h
unless a second owner confirms it. **Advice to the network:** keep a second key registered and in force as a standby
(the two-credential quota of A5 exists for this), so an urgent rotation is a switch to the standby and a revoke of the
old key, with no wait at all; then register a new standby.

**Revocation is immediate**, never delayed, by any of: Journear staff (admin portal, with a reason); an `owner` member
of the org in our partner portal (no fresh sign-in, as for revoking a publishable key: a kill switch); the credential
itself (`POST /v1/platform/credential/revoke`, allowed while the org's switch is off: check 6); the confirmation
notice's revoke link (proposed, above); and, for the whole
org, staff's **platform switch** (`platform_orgs.enabled = 0`), which refuses every key of the org at once without
revoking them.

**A revocation also cancels what the key left waiting.** An announced origin comes into force by itself when its
`active_from` passes (activation is passive: `app_origins.active_from` is set at the announcement), so a stolen key's
proposals would still come into force 24 h later after the key itself was stopped. So **in the same batch** as each
revocation route (staff, an owner, the credential itself, the revoke link), as the hourly job's write when a key
expires (actor `system`), as staff's switch-off of the org, and as the mirroring of a freeze into
`platform_orgs.frozen`: every `origin_add` that key (for the switch-off and the freeze:
any key of the org) proposed and that is still `pending` and not in force is cancelled (`status = 'cancelled'`, its
`app_origins` row removed, as `cancelBatch` does), as one set update, with one `change.cancelled` ledger row per call
listing the change ids (the set form of A15), its actor the revoker (the staff member, the member, the credential, or
`system` for expiry), its detail `reason: 'key_revoked' | 'platform_off' | 'org_frozen'`. The revocation's notice
lists them. An origin already in force stays; owners or the network remove it (this cancelling confirmed by the Tech
Lead 2026-11-25, D917). The same for **waiting key registrations** (confirmed by the Tech Lead 2026-11-25, D917): staff's switch-off and a freeze cancel every key of the org that
is `awaiting_acceptance` or `pending` (a waiting key that comes into force on its own date would otherwise work the
moment the switch is turned back on, which L5's key review catches only for keys in force); revoking one key cancels
no other key's registration (that one is usually its replacement), but its notice lists any waiting registration
with its cancel link. **Before staff turn a switch back on** (L5), the admin portal lists every key of the org in force and
staff confirm or revoke each, recorded with the `platform.org_switch` row. A revoked credential is never reactivated;
its id is never reused.

**Where keys live.** The private key: in the network's cloud KMS or HSM, used by its backend only, never in a browser,
the network's SDK or its partners' pages, never sent to us. On our side: the public key (65-byte uncompressed point)
and its thumbprint in the hot D1 (`platform_keys`, A7). Nothing secret of the network is held by Journear.

## A4. Authorisation rules (gates P4: H1, H2, M7, L3, L4)

1. **The org is the credential's.** No endpoint takes an org id.
2. **The reach filter is in the SQL of every call, not at the route** (H1). Every reused writer gains an optional
   `reach` predicate, passed by the platform and absent for the console and staff, which is added **both** to the plan
   read's join (`planApp`, `planChange`, the key and suspension writers' reads) **and** to the commit row's predicate
   (`commitOnApp`, `commitOnChange`):
   `a.org_id = :org AND a.scope_id IN (SELECT value FROM json_each(:credentialScopes)) AND s.environment = 'test' AND
   a.created_by_kind = 'platform'` (the last term per N1, decided). A state that moves between the read and the
   batch (an app moved to another scope, say) makes the commit insert nothing (`version_conflict`), so the write never
   lands outside the reach. Reads (`listApps`, `getApp`) take the same predicate. Anything outside it is `not_found`.
   Tests (P4): an org with a live app, a staff-created test app and a platform-created test app on the same scope and
   another scope: every platform endpoint leaves the first two and the other scope untouched and answers `not_found`
   for them; a commit predicate test moves an app's scope between the plan read and the batch.
3. **A frozen org** (`orgs.status = 'frozen'` in the console's D1, mirrored into `platform_orgs.frozen` by the admin
   Worker when staff freeze it) keeps only the kill switches: remove origins, suspend, revoke keys, revoke the
   credential, cancel. As the console does for its members (D356). Mirroring the freeze cancels the platform's
   waiting proposals (A3).
4. **Create** works only on a scope in the credential whose shared-scope flag (`scopes.app_user_ids`, P0) is on: the
   platform never creates a scope, so no on-chain read is needed, and every app it creates gets per-app User IDs. The
   app's `user_ids` and `created_by_kind` are written by `INSERT … SELECT` from the `scopes` row inside the create
   batch (L16), so a flag that changes between the plan read and the batch can't give the app the wrong mode. **The
   origins sent with a create are platform proposals**: recorded `proposed_by_kind = 'platform'` with the proposer id
   the key's id, exactly as A4.5's proposals (today `createApp` writes its initial origins as `hana` proposals, which
   would miss the platform minimum, be refused by the confirmation's predicate and qualify for the `no_session`
   waiver in `lifecycle.ts`). The platform variant of create must not reuse that part of `createApp` unchanged.
5. **Origin proposals** (M7) go through `proposeOrigins` with a `platform` proposer and are checked with the
   **live-scope rules even on a test scope**: `originProblem` is called with `environment: 'live'`, so no loopback, no
   localhost wildcard, no http and no mixed-script host label. No waiver (both waivers already require a `member` or
   `hana` proposer, `lifecycle.ts`); refused within the delay of the scope's assignment (as staff proposals are); the
   20-per-app limit unchanged (a partner on the network's widget spends one on the widget's origin, A13); `ackNotice` sets `active_from` from the greater of `appChangeDelayMs` and the platform
   minimum (`PLATFORM_MIN_DELAY_MS`, 24 h, in every env but `local*` test envs; decided, N3) for a `platform`
   proposal. An owner's confirmation (A15) may bring it forward to the moment of the confirmation; nothing else can.
   The admin CLI's `app:changes:announce` (`announceWrite`, `scripts/lib/admin-sql.ts`), which announces any pending
   change with only the env's `delayMs` and can grant `no_session`, **refuses a `platform` proposal** (`forbidden`:
   only the admin Worker announces them, so their email and its Confirm link always go out), with a test.
6. **Resume** (L4). A new column `apps.partner_bit_by` (`'member'`, `'platform'` or NULL) says who holds the partner
   bit. The platform's suspend sets bit 4 and, only if the bit was clear, `partner_bit_by = 'platform'`. A member's
   suspend in the console always sets `partner_bit_by = 'member'`, **also when bit 4 is already set** (it then writes a
   `suspension.set` row with `{"bit": 4, "takenOver": true}`, where today it writes nothing), so a member who suspends
   after the platform takes the suspension over. The platform may clear bit 4 only while `partner_bit_by = 'platform'`
   (`forbidden` otherwise); a member resumes it with a fresh sign-in, as today. Journear's bits 1 and 2 are never the
   platform's.
7. **Cancel** (H2): the platform's cancel adds to the plan read and the commit predicate `g.kind = 'origin_add' AND
   g.proposed_by_kind = 'platform'` plus the reach filter; a member's, staff's or another kind of change is
   `not_found` to it.
8. **Reads** answer an allowlisted view (A8): never settings outside it, staff identities, `proposer_sub`, Google
   `sub`s, sponsorship or the mainnet demo switch.
9. **Staff's per-app off switch** is the existing Journear bit 1 (`AdminRpc.setSuspended`), unchanged; the platform
   can neither see who set it nor clear it.

## A5. Limits and quotas (gates P3: M2, M3, L8; P4; defaults lowered per L14)

Provisional numbers, on the existing `RateLimiter` windows, **kept low while the network has few partners** (L14);
staff raise an org's values in `platform_orgs` when it needs more.

| Limit | Value | Where |
|---|---|---|
| Failed requests per IP | 30 a minute, counted only while they fail (hit, then `unhit` once the signature verifies) | `platform:ip:<ipSubject>`, not pinned |
| Requests per credential | 60 a minute, 2 000 a UTC day | `platform:key:<keyId>`, after the signature |
| Hot-DB budget | the org's own bucket (`platform:bucket:org:<orgId>`) under the existing global bucket with its kill-switch reserve; one call at most 3 reads, 2 batches and 12 statements (`PLATFORM_DB_LIMITS`, below) | `consoleAdmit`'s buckets, the platform's own keys |
| Destructive calls (remove origins, suspend, revoke a publishable key) | 10 per org and **30 across every org** per rolling hour, on the platform's own counters `platform:breaker:org:<org>` and `platform:breaker:global`, separate from `console:breaker:global` (M3), so a platform flood never uses up the console's kill switches and the reverse; a call that changed nothing gets its slot back | the `consoleAdmit` mechanism with the platform's keys |
| Apps per org created by the platform | 10 undeleted (Passport Home lists 10 apps per scope today: A11) | checked in the create batch's predicate |
| App creations | 2 an hour, 5 a UTC day per org | windows on `platform:<orgId>` |
| Origin proposals | 10 an hour, 30 a UTC day per org; at most 30 waiting (proposed, not yet in force) per org | windows, and a count in the proposal batch's predicate |
| Origins per app | 20 active or pending (`MAX_APP_ORIGINS`); a partner on the network's widget spends one on the widget's origin (A13) | unchanged |
| Publishable keys per app | 5 unrevoked (`MAX_UNREVOKED_KEYS`) | unchanged |
| Credentials per org | 2 in force, waiting or awaiting acceptance (so the network can keep a standby key in force for an urgent rotation, A3) | registration |

**The hot-DB budget, worked out (L8).** Each call: one read of the credential joined to `platform_orgs` (1 read). Then
a write: its plan read (1 read), one batch with the existing statements plus the `platform_requests` and
`platform_calls` inserts and, at most once an hour per key, the `last_used_at` update (the per-key limiter object says
when), and the one diagnostic read a failed batch may need (1 read). The largest are origin proposals (the console's
`changeOrigins` costs 8 statements; with the two inserts and `last_used_at`, 11) and create (commit, app, key,
guarded changes, origin rows, the two inserts, `last_used_at`: 8). A read endpoint: `getApp`'s one batch of four reads
plus a second batch of one statement (the `platform_calls` insert). So `PLATFORM_DB_LIMITS` = 3 reads, 2 batches, 12
statements, and each route's cost is charged to the bucket before it runs, with a test that each stays within it, as
`CONSOLE_COSTS` does.

A quota refusal is `429 rate_limited` with `retry-after` and the window's name, or `409 app_limit` for the app count.
The first refusal of a quota in a clock hour writes a `platform_quota` security event (once, as `breaker` events are
written today), which the admin Worker emails to staff. Ten or more failed signatures in a minute for a known key id
write a `platform_auth_failures` event.

Cost on the free plan (D417, 10 ms CPU, 50 subrequests): one signature check (WebCrypto), three limiter calls (IP,
nonce, key windows) and at most three reads and two batches.

## A6. What is reused unchanged, and what is new

| Part | Reused unchanged | Changed | New |
|---|---|---|---|
| Origin additions | `guarded_changes` `origin_add`, `app_origins` with `active_from` NULL, `MAX_APP_ORIGINS` | `proposeOrigins` takes the reach predicate (H1); `proposed_by_kind` gains `platform` (proposer id = the credential id); `checkOriginRules` called with the live rules for a platform proposal (M7) | — |
| Announcement | `pendingNotices` → the admin Worker's email to the security alias and every security contact → `ackNotice` (the `system` actor) with the cancel link's hash; the 7-day lapse; activation by the hourly job | Platform proposals of one request are sent as **one email** listing every origin, each with its own cancel link (L14), to the security alias, every security contact **and every owner of the org** (owners are the ones who can confirm; confirmed by the Tech Lead, D917); the "Proposed by" row reads "your platform key "{label}" ({pkc_…})"; `ackNotice` applies the platform minimum delay (N3); the email's wait line states the platform minimum, not the env's delay ("It starts working on {date}, 24 hours from now, or sooner if an owner of your organisation confirms it"; the admin Worker passes `APP_CHANGE_DELAY_MS` into the email today, `apps/admin/src/notices.ts`), with a test; the email also carries a **Confirm** link that only opens the console's confirmation page (A15) | The notice of a confirmation, with its own ack and a one-click **removal link** valid 7 days (A15; confirmed, D917), to the security alias, every security contact and every owner |
| Delay | `APP_CHANGE_DELAY_MS`; no waiver for a platform proposal | The platform minimum, 24 h, in every env but `local*` test envs (A15, "Which envs are `local*`"): for platform proposals (decided, N3), for platform keys (decided by the Tech Lead's rule on keys, D914), and for staff proposals on a flagged scope or a platform-created app when no second person confirms them (decided by the Tech Lead, "four eyes", D917; A15) | A second person's confirmation of a staff proposal (A15, D917) |
| Cancel | `cancelChange` (an owner, staff), `cancelChangeByLink` (the email) | The platform's cancel, held to platform-proposed `origin_add` changes in its reach (H2) | — |
| Expedite | Member proposals only, as today; never a platform proposal (decided, D913 question 11). Staff restore of a removed origin without the wait: refused (A14) | — | — |
| Confirmation | The step-up verification (`verifyStepUpToken`, `confirmStepUp`), the console's CSRF rules, the compare-and-swap commit; `expediteChange`'s way of setting `active_from = now` and the matching `app_origins.active_from`; `removeOrigins` for the removal link | — | `ConsoleRpc.confirmOrigins` (a console route only: no platform route, A15), one set per call; step-up kind `origin.confirm` with its own nonce label; `guarded_changes.confirmed_*`, `unconfirmed_active_from` and the removal link's columns with their triggers (A7); `app_changes` kind `origin.confirmed` (one row per call); `AdminRpc.confirmationNotices` and `ackConfirmationNotice`; `ConsoleRpc.removeOriginByLink` (`link` actor) |
| Removals, suspension, keys | `removeOrigins`, `setSuspensionBit`, `createKey`, `revokeKey` | Each takes the reach predicate (H1); `apps.partner_bit_by` and the member's take-over write (A4.6) | — |
| App creation | The body of `createApp` (name rules, first key, origins as proposals, `app.created`) | A platform variant on an existing flagged scope only: no scope creation, no on-chain owner read, never a waiver, the look-alike name check within the scope, `user_ids` and `created_by_kind` by `INSERT … SELECT` | — |
| Auto-approve | `proposeChange`'s rules for everyone else | `proposeChange` (ConsoleRpc and AdminRpc), the admin CLI's `app:settings` and the hourly drift check refuse or flag a `policy_set` for an app on a flagged scope or created by the platform (P0, H3) | — |
| Ledger | `app_changes` with its kinds (`app.created`, `origin.proposed`, `origin.removed`, `change.cancelled`, `suspension.set`, `suspension.cleared`, `key.created`, `key.revoked`) | `actor_kind` gains `platform` (actor id = the credential id) | Kind `origin.confirmed` (actor `member`, with the step-up's `actor_sub`; detail: the change id, the origin, the proposing key's id); kinds `platform.key_proposed`, `platform.key_accepted`, `platform.key_announced`, `platform.key_confirmed`, `platform.key_cancelled`, `platform.key_active`, `platform.key_revoked`, `platform.org_switch`, `scope.app_user_ids` (org-level rows, `app_id` NULL), each with an audit title in `APP_CHANGE_KINDS` (D704) |
| Credential registration | The step-up verification (`changes/step-up.ts`); the notice email and cancel-link machinery (`linkToken`, `CANCEL_LINK_KEY`); the owners' email list the admin Worker already uses for invites | Console `pending_actions` gains `platform.key_add`, `platform.key_accept`, `platform.key_revoke` and `platform.key_confirm` (a rebuild, as migration 0004 did), and `origin.confirm` (P10; in the same rebuild if P2 and P10 ship together, else its own) | A guarded change of its own kind, held in `platform_keys` (keys belong to an org, not an app, so `guarded_changes`, whose `app_id` is required, can't hold it): `AdminRpc.platformKeyNotices` → email → `ackPlatformKeyNotice`; cancel by an owner, staff or the link (`/cancel-platform-key/:id#t=` on the console); an owner's confirmation (`ConsoleRpc.confirmPlatformKey`, step-up kind `platform.key_confirm`, the console page `/confirm-platform-key/:id`; four eyes on a real-money setup, A3) |
| Security events | The admin Worker's email of `security_events` | — | Kinds `platform_quota`, `platform_auth_failures`, `link_lookup_volume` (B6) |
| Call log | — | — | `platform_calls`: every call that passed the signature check |

## A7. Data model and migrations (gates: M9 before P1)

API D1, the next free migration numbers when built (`0026` on `next` today).

```sql
-- The platform's credentials: one public key per row, for one org and one or two of its test scopes.
CREATE TABLE platform_keys (
  id                TEXT PRIMARY KEY,                     -- pkc_…
  org_id            TEXT NOT NULL,
  label             TEXT NOT NULL,                        -- ≤ 40 characters, display-safe
  alg               TEXT NOT NULL CHECK (alg = 'ES256'),
  public_key        BLOB NOT NULL UNIQUE CHECK (length(public_key) = 65),
  thumbprint        TEXT NOT NULL UNIQUE,                 -- RFC 7638, base64url
  scopes_json       TEXT NOT NULL CHECK (json_valid(scopes_json) AND json_array_length(scopes_json) BETWEEN 1 AND 2),
  status            TEXT NOT NULL CHECK (status IN ('awaiting_acceptance', 'pending', 'active', 'cancelled', 'revoked')),
  proposed_by_kind  TEXT NOT NULL CHECK (proposed_by_kind IN ('hana', 'member')),
  proposed_by       TEXT NOT NULL,
  proposer_sub      TEXT,                                 -- the verified step-up's sub, for a member
  proposed_at       INTEGER NOT NULL,
  accepted_by_kind  TEXT CHECK (accepted_by_kind IN ('hana', 'member')), -- a staff registration's acceptance (M5)
  accepted_by       TEXT, accepted_sub TEXT, accepted_at INTEGER,
  notified_at       INTEGER,
  active_from       INTEGER,                              -- notified_at + the delay
  expires_at        INTEGER,                              -- active_from + 365 days
  cancel_token_hash BLOB UNIQUE,
  cancelled_at      INTEGER, cancelled_by TEXT,
  revoked_at        INTEGER, revoked_by_kind TEXT, revoked_by TEXT, revoke_reason TEXT,
  last_used_at      INTEGER,                              -- written at most once an hour per key
  request_id        TEXT NOT NULL,
  -- The owner's confirmation (A3, D914). four_eyes is written once at registration: 1 on a real-money setup.
  four_eyes         INTEGER NOT NULL CHECK (four_eyes IN (0, 1)),
  confirmed_kind    TEXT CHECK (confirmed_kind IN ('confirm', 'acceptance')), -- 'acceptance': a staff key's owner acceptance
  confirmed_by      TEXT, confirmed_sub TEXT, confirmed_at INTEGER,
  unconfirmed_active_from INTEGER,                        -- the ack's notified_at + the delay: in force then if unconfirmed
  confirm_notified_at INTEGER,                            -- the confirmation's notice (proposed, A3)
  revoke_link_hash  BLOB UNIQUE, revoke_link_until INTEGER, -- its one-click revoke link (proposed, A3)
  CHECK (proposed_by_kind = 'member' OR status IN ('awaiting_acceptance', 'cancelled') OR accepted_at IS NOT NULL),
  CHECK (accepted_by_kind IS NULL OR accepted_by_kind = 'member' OR accepted_by IS NOT proposed_by),
  CHECK ((confirmed_at IS NULL) = (confirmed_by IS NULL) AND (confirmed_at IS NULL) = (confirmed_sub IS NULL)
         AND (confirmed_at IS NULL) = (confirmed_kind IS NULL)),
  -- Four eyes, in the database: never the registrant's own console user or Google account.
  CHECK (four_eyes = 0 OR confirmed_at IS NULL
         OR (confirmed_by IS NOT proposed_by AND confirmed_sub IS NOT proposer_sub))
);
-- four_eyes and the confirmation are fixed once written.
CREATE TRIGGER platform_keys_confirm_fixed BEFORE UPDATE OF four_eyes, confirmed_kind, confirmed_by, confirmed_sub,
  confirmed_at ON platform_keys
  WHEN NEW.four_eyes IS NOT OLD.four_eyes OR OLD.confirmed_at IS NOT NULL
    OR (NEW.confirmed_kind = 'confirm' AND (OLD.status IS NOT 'pending' OR OLD.notified_at IS NULL))
    OR (NEW.confirmed_kind = 'acceptance' AND OLD.status IS NOT 'awaiting_acceptance')
BEGIN SELECT RAISE(ABORT, 'platform_keys: the confirmation is written once'); END;
-- No earlier active_from without a confirmation, whoever writes it (as guarded_changes, below).
CREATE TRIGGER platform_keys_not_early BEFORE UPDATE OF active_from ON platform_keys
  WHEN OLD.unconfirmed_active_from IS NOT NULL AND NEW.active_from < OLD.unconfirmed_active_from
    AND NEW.confirmed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'platform_keys: a key comes into force early only when confirmed'); END;
-- Staff's per-org switch and quotas (a missing row: off).
CREATE TABLE platform_orgs (
  org_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), frozen INTEGER NOT NULL DEFAULT 0,
  max_apps INTEGER NOT NULL DEFAULT 10, creations_per_day INTEGER NOT NULL DEFAULT 5,
  proposals_per_day INTEGER NOT NULL DEFAULT 30, set_by TEXT NOT NULL, set_at INTEGER NOT NULL
);
-- Idempotency (A9): kept 7 days, for telling a retry from a different call; the ledger's request id outlives it.
CREATE TABLE platform_requests (
  org_id TEXT NOT NULL, idem_hash TEXT NOT NULL, key_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
  body_sha256 TEXT NOT NULL, request_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (org_id, idem_hash)
);
-- Every call that passed the signature check (reads too): kept 13 months, purged by the monthly retention job.
CREATE TABLE platform_calls (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, org_id TEXT NOT NULL, key_id TEXT NOT NULL, method TEXT NOT NULL,
  route TEXT NOT NULL,                                    -- the route's template, e.g. /v1/platform/apps/:appId
  app_id TEXT, status INTEGER NOT NULL, code TEXT, request_id TEXT NOT NULL, ip_prefix TEXT
);
CREATE INDEX platform_calls_org ON platform_calls (org_id, seq);
-- P0: the shared-scope flag, who created an app, who holds the partner bit.
ALTER TABLE scopes ADD COLUMN app_user_ids INTEGER NOT NULL DEFAULT 0 CHECK (app_user_ids IN (0, 1));
ALTER TABLE apps ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'hana' CHECK (created_by_kind IN ('hana', 'platform'));
ALTER TABLE apps ADD COLUMN partner_bit_by TEXT CHECK (partner_bit_by IN ('member', 'platform'));
```

**A key's confirmation in the database** (A3). `four_eyes` is set by the registration's write from the env
(`NETWORK = 'mainnet'`, the rule `changeConfig` already reads), never from the request; a test checks it is 1 on
every mainnet config. The confirmation's commit predicate repeats the four-eyes rule (`confirmed_by IS NOT proposed_by
AND confirmed_sub IS NOT proposer_sub` when `four_eyes = 1`; `IS NOT`, since a staff registration has no
`proposer_sub`) and requires `status = 'pending' AND notified_at IS NOT NULL AND confirmed_at IS NULL AND revoked_at
IS NULL AND cancelled_at IS NULL`, so a cancel or revocation that lands first wins; it sets `active_from = now`. An
owner's acceptance of a staff key (confirmed, D917) writes `confirmed_kind = 'acceptance'` with the acceptance's member and
`sub`, and the ack then sets `active_from = notified_at`. The email and owner-since checks (A3) are made by the
console's server, which holds members' emails and roles.

```sql
-- P10: who confirmed a platform-proposed origin, and when (A15). After P1's rebuild, so plain added columns.
ALTER TABLE guarded_changes ADD COLUMN confirmed_by  TEXT;     -- the console member's user id
ALTER TABLE guarded_changes ADD COLUMN confirmed_sub TEXT;     -- the verified step-up's Google sub (an on-chain owner)
ALTER TABLE guarded_changes ADD COLUMN confirmed_at  INTEGER;  -- also the new active_from
-- Written by the ack for a platform proposal: when it comes into force if nobody confirms it.
ALTER TABLE guarded_changes ADD COLUMN unconfirmed_active_from INTEGER;
-- Four eyes for staff proposals on a shared scope (A15, D917): set once at the proposal; who confirmed.
ALTER TABLE guarded_changes ADD COLUMN second_person INTEGER NOT NULL DEFAULT 0 CHECK (second_person IN (0, 1));
ALTER TABLE guarded_changes ADD COLUMN confirmed_by_kind TEXT CHECK (confirmed_by_kind IN ('member', 'hana'));
-- The confirmation's notice (A15; the removal link confirmed, D917): its ack, and the one-click removal link's hash and end.
ALTER TABLE guarded_changes ADD COLUMN confirm_notified_at INTEGER;
ALTER TABLE guarded_changes ADD COLUMN removal_token_hash  BLOB;   -- UNIQUE by the index below
ALTER TABLE guarded_changes ADD COLUMN removal_until       INTEGER;
CREATE UNIQUE INDEX guarded_changes_removal_token ON guarded_changes (removal_token_hash)
  WHERE removal_token_hash IS NOT NULL;
-- Only a platform-proposed origin_add, or a staff one under four eyes, pending and announced, only once; never the
-- proposer; a member confirms with a step-up sub, a staffer without one.
CREATE TRIGGER guarded_changes_confirm_rule BEFORE UPDATE OF confirmed_by, confirmed_sub, confirmed_at, confirmed_by_kind
  ON guarded_changes
  WHEN OLD.confirmed_at IS NOT NULL
    OR NEW.confirmed_at IS NULL OR NEW.confirmed_by IS NULL OR NEW.confirmed_by_kind IS NULL
    OR (NEW.confirmed_by_kind = 'member' AND NEW.confirmed_sub IS NULL)
    OR NEW.confirmed_by IS OLD.proposed_by
    OR OLD.kind IS NOT 'origin_add'
    OR NOT (OLD.proposed_by_kind = 'platform' OR (OLD.proposed_by_kind = 'hana' AND OLD.second_person = 1))
    OR OLD.status IS NOT 'pending' OR OLD.notified_at IS NULL
BEGIN SELECT RAISE(ABORT, 'guarded_changes: only a waiting, announced platform origin is confirmed, once'); END;
-- No earlier active_from for a platform origin without a confirmation, whoever writes it.
CREATE TRIGGER guarded_changes_platform_not_early BEFORE UPDATE OF active_from ON guarded_changes
  WHEN OLD.unconfirmed_active_from IS NOT NULL
    AND NEW.active_from < OLD.unconfirmed_active_from AND NEW.confirmed_at IS NULL
BEGIN SELECT RAISE(ABORT, 'guarded_changes: a platform origin comes into force early only when confirmed'); END;
CREATE TRIGGER app_origins_platform_not_early BEFORE UPDATE OF active_from ON app_origins
  WHEN EXISTS (SELECT 1 FROM guarded_changes g
               WHERE g.app_id = NEW.app_id AND g.origin = NEW.origin AND g.kind = 'origin_add' AND g.status = 'pending'
                 AND g.unconfirmed_active_from IS NOT NULL
                 AND NEW.active_from < g.unconfirmed_active_from AND g.confirmed_at IS NULL)
BEGIN SELECT RAISE(ABORT, 'app_origins: a platform origin comes into force early only when confirmed'); END;
```

The confirmation's batch updates `guarded_changes` first (so the `app_origins` trigger sees `confirmed_at`), then
`app_origins`. The ack writes `unconfirmed_active_from` and `active_from` to the same value, which neither trigger
refuses. `second_person` is written by the proposal's own insert (`INSERT … SELECT` from the app's `created_by_kind`
and its scope's `app_user_ids`, so a flag set between the plan read and the batch can't be missed) and a trigger
refuses any later change of it. A migration test checks each trigger against a bare D1 write.

The confirmation is recorded three times, each in its own place: the changes' `confirmed_by`, `confirmed_sub` and
`confirmed_at` (with `active_from = confirmed_at` on each change and its `app_origins` row); **one** `app_changes` row
`origin.confirmed` for the whole call (actor `member`, the member's id, `actor_sub` the step-up's `sub`; its detail
lists every change id and origin, since `request_id` is UNIQUE); and a console `audit_log` row for the member's
action, as every step-up write writes today. The confirmation's notice is its own announce-and-ack pair
(`AdminRpc.confirmationNotices`, `ackConfirmationNotice`), not read from the change feed, so its removal links are
stored before anyone can use them (A15).

**What isn't stored** (L7): a request that fails before the signature verifies has no authenticated key, and writing a
row for each would let anyone fill the hot DB, so it is counted (the per-IP window, the per-key failure counter that
raises `platform_auth_failures`) and written to the request log (`event: "platform"`, route template, code, IP prefix,
the key id as sent when it is well formed), never to `platform_calls`. Every call that passes the signature check is
in `platform_calls`, whatever its outcome.

### Widening the actor kinds: the ledger rebuild (M9, before P1)

`app_changes.actor_kind` and `guarded_changes.proposed_by_kind` are column CHECKs (0006), and SQLite can't widen a CHECK
in place. **Recommended: rebuild both tables once, and in that rebuild move the two kind checks from column CHECKs to
`BEFORE INSERT` triggers**, so any later kind (the next actor, a new proposer) is a `DROP TRIGGER` and `CREATE
TRIGGER`, never another rebuild of the ledger. A trigger is as strict for inserts (the only writes the ledger allows);
the cost is that `PRAGMA integrity_check` no longer reports the rule, which the migration test covers instead.
Rejected: recording the platform as `system` or `hana` (a ledger that misnames its actor), and rebuilding with a wider
CHECK each time a kind is added.

The rebuild, in one migration file, in this order:

1. Create `app_changes_new` with every column of `app_changes` in order (`seq INTEGER PRIMARY KEY`, `at`, `org_id`,
   `app_id`, `scope_id`, `kind`, `detail_json` with `CHECK (json_valid(detail_json))`, `actor_kind` with no CHECK,
   `actor_id`, `actor_sub`, `request_id TEXT NOT NULL UNIQUE`), and `guarded_changes_new` with every column of
   `guarded_changes` in order, keeping its CHECKs on `kind`, `status` and `waiver`, its two table CHECKs (`origin_add`
   ⇔ `origin`, `policy_set` ⇔ `policy_json` and `policy_id`) and `cancel_token_hash BLOB UNIQUE`, with no CHECK on
   `proposed_by_kind`.
2. Copy with explicit column lists on both sides (`INSERT INTO app_changes_new (seq, at, …) SELECT seq, at, … FROM
   app_changes`, the same for `guarded_changes`), `seq` copied as it is (the admin Worker's feed reads
   `changesSince(seq)`).
3. `DROP TABLE` the old tables (no foreign key references them, and a `DROP TABLE` fires no trigger, so nothing
   elsewhere is deleted; unlike `apps`, which must never be rebuilt: 0006's header) and rename the new ones.
4. Then, after the copy, recreate every index (`app_changes_org_seq`; `guarded_changes_app`,
   `guarded_changes_unnotified`, `guarded_changes_due`) and every trigger (`app_changes_no_update`,
   `app_changes_no_early_delete` with its 60-month rule, `guarded_changes_insert`), and the two new kind triggers
   (`app_changes_actor_kind`: `RAISE(ABORT)` unless `NEW.actor_kind IN ('member', 'hana', 'system', 'link',
   'platform')`; `guarded_changes_proposer_kind`: unless `NEW.proposed_by_kind IN ('member', 'hana', 'system',
   'platform')`).

`security_events.kind` gains its three kinds the same way, as migrations 0018 to 0025 did.

**Checks** (the migration test and the deploy step): the test applies the migration to a copy with rows in every table
and checks every row and `seq`, that every index and trigger exists with the same SQL (`sqlite_schema`), that an update
or early delete of `app_changes` is still refused, and that an unknown actor kind is refused. **The deploy step**: take
a D1 Time Travel bookmark first (`docs/operations.md`, "Restoring a D1 database (Time Travel)"); record for each table,
before and after, the row count, `max(seq)` (for `app_changes`) and an aggregate hash (an ops script reads every row
ordered by its key through `wrangler d1 execute --json` and hashes the canonical JSON with SHA-256 locally, since D1 has
no hash function); any difference is a rollback to the bookmark.

Console D1: `pending_actions` rebuilt with the three new step-up kinds (as 0004), and with `origin.confirm` (P10). `console-core`: `ACTOR_KINDS` and
`PROPOSER_KINDS` gain `platform`; the console's Audit renders it.

## A8. Endpoints

`{API}/v1/platform/…` on the API Worker (`src/platform/`, one new route in `src/index.ts`; `fetch` serves `/v1/*`
today). JSON bodies, camelCase; success `{…fields, requestId}`; error `{error, code, requestId, …}`, as `docs/api.md`
"Conventions". RpcCodes keep their statuses (`RPC_HTTP_STATUS`, `packages/console-core/src/types.ts`). Every request
needs the A3 headers; every `POST` that writes needs `Idempotency-Key`.

**Codes every endpoint can answer:** `401 unauthenticated`, `400 stale_request {serverTimeMs}`,
`409 request_replayed`, `403 platform_off`, `403 browser_refused`, `400 bad_request`, `405 method_not_allowed`,
`429 rate_limited` (+ `retry-after`), `503 rate_limiter_unavailable`, `500 internal`. Writes also:
`409 idempotency_conflict`, `409 conflict` (an idempotency key used by another credential or for another write, A9),
`409 version_conflict`, `403 forbidden` (a frozen org's non-kill-switch write, or A4.6).

**The app view** (`PlatformApp`), an allowlist:

```json
{ "id": "app_…", "name": "…", "scopeId": "…", "environment": "test", "createdBy": "platform", "createdAt": 0,
  "userIds": "app",
  "suspended": { "byJournear": false, "byOrganisation": false, "byYou": false, "youCanResume": false },
  "originsVersion": 3,
  "origins": [ { "origin": "https://…", "display": "https://…", "idn": false,
                 "state": "waiting_announcement | waiting | active", "activeFrom": 0, "confirmedAt": null,
                 "changeId": "gc_…" } ],
  "keys": [ { "id": "key_…", "key": "pk_test_…", "createdAt": 0, "revokedAt": 0 } ] }
```

`byJournear` covers bits 1 and 2 together (the network learns that Journear stopped the app, not why); `byOrganisation`
is bit 4 held by a member, `byYou` bit 4 held by the platform. For a waiting origin, `activeFrom` is the date it comes
into force if nobody confirms it; once an owner confirms it (A15), `confirmedAt` is the time and `activeFrom` the
same (never who confirmed). No settings, no policy, no mainnet demo, no labels, no staff identities.

| Endpoint | Body | Answer | Codes beyond the common ones |
|---|---|---|---|
| `GET /v1/platform/credential` | — | `{keyId, label, orgId, scopes, activeFrom, expiresAt, limits}` | — |
| `POST /v1/platform/credential/revoke` | `{reason?}` (≤ 200 characters) | `{revokedAt}`; the key stops at once; allowed while the switch is off | — |
| `POST /v1/platform/apps` | `{scopeId, name, origins?: [≤ 20]}` (for a partner on the network's widget, the widget's origin and the partner's pages, A13) | `201 {app, publishableKey, changes: [{changeId, origin}]}`; the origins are platform proposals (A4.4), each waiting for an owner's confirmation or the platform minimum | `forbidden` (scope not on the key, or not flagged), `origin_refused`, `conflict` (scope assigned less than the delay ago; a name like another app's on the scope), `409 app_limit`, `no_security_contact` |
| `GET /v1/platform/apps?scopeId=&cursor=` | — | `{apps: [PlatformApp], next?}` (50 a page, within the reach) | `forbidden` |
| `GET /v1/platform/apps/:appId` | — | `{app}` | `not_found` |
| `POST /v1/platform/apps/:appId/origins` | `{add: [≤ 20], expectedVersion}` | `202 {version, changes: [{changeId, origin}]}`; each waits for its announcement, then comes into force when an owner confirms it (A15) or after the delay with the platform minimum | `not_found`, `origin_refused` (the live rules, A4.5), `conflict` (duplicate, more than 20, scope assigned less than the delay ago) |
| `POST /v1/platform/apps/:appId/origins/remove` | `{remove: [≤ 20], expectedVersion}` | `{version}`; immediate | `not_found`, `bad_request` (not an origin of the app) |
| `POST /v1/platform/changes/:changeId/cancel` | — | `{change}` | `not_found` (also any change the platform didn't propose, A4.7), `not_pending` |
| `POST /v1/platform/apps/:appId/suspend` | `{suspended: true \| false}` | `{suspended}` (the view's object) | `not_found`, `forbidden` (A4.6) |
| `POST /v1/platform/apps/:appId/keys` | — | `201 {key}` | `not_found`, `key_limit` |
| `POST /v1/platform/apps/:appId/keys/:keyId/revoke` | — | `{warning?: 'last_key'}` | `not_found`, `conflict` (already revoked) |

Each write maps to the existing function with `Writer.actor = {kind: 'platform', id: <pkc_…>}`, `orgId` = the
credential's org and the reach predicate: `createApp` (its platform variant), `proposeOrigins`, `removeOrigins`,
`cancelChange`, `setSuspensionBit(bit 4)`, `createKey`, `revokeKey`. Rotation is not offered: create a key, switch
the network's configuration to it, then revoke the old one.

Staff and console methods (RPC, no route): `AdminRpc.registerPlatformKey`, `approvePlatformKey` (the second staff
member), `revokePlatformKey`, `listPlatformKeys`, `setPlatformOrg`, `setScopeAppUserIds`, `platformKeyNotices`,
`ackPlatformKeyNotice` (`system` only), `cancelPlatformKey`, `platformCalls`; `ConsoleRpc.listPlatformKeys`,
`proposePlatformKey` and `acceptPlatformKey` (with `stepUpJwt`), `revokePlatformKey` (owner, kill switch),
`cancelPlatformKey`, `cancelPlatformKeyByLink` (`link` actor), `platformCalls`; `ConsoleRpc.confirmPlatformKey`
(P2, A3: `{keyId, stepUpJwt}`, a member actor only), `revokePlatformKeyByLink` (`link` actor, proposed);
`ConsoleRpc.confirmOrigins` (P10, A15: `{appId, changeIds: [1..20], stepUpJwt}`, one app and one proposing request,
a member actor only), `removeOriginByLink` (`link` actor); `AdminRpc.confirmationNotices` and
`ackConfirmationNotice` (`system` only). Their full shapes go in `docs/api.md` when built.

**No platform route confirms.** There is no `/v1/platform/…/confirm` and none may be added: the confirmation is the
console's `POST /api/orgs/:org/actions` step-up (kind `origin.confirm`) and then `ConsoleRpc.confirmOrigins`, which
refuses any actor but `member` (`verifyStepUpToken` already does) and so can never be reached with a platform key. A
test (P10) walks every platform route and checks none changes `confirmed_at` or brings an `active_from` forward.

## A9. Idempotency (gates P4: L3)

- Every write needs `Idempotency-Key`, chosen by the network once per logical operation and resent unchanged with every
  retry (each retry has a new nonce and signature).
- The API derives the write's `request_id` as `pf_` + base64url(sha256(org id ‖ 0x00 ‖ Idempotency-Key))[0..32], so
  two orgs' keys never collide, and records `(org, sha256(key), credential, method, path, sha256(body))` in
  `platform_requests` in the same batch.
- A retry with the same key, method, path and body, from the same credential: the write isn't repeated; the API answers
  `200` with the current state and `"replayed": true` (for a create: the app it created, found through its
  `app_changes` row).
- The same key with another method, path or body, within the 7 days `platform_requests` keeps it:
  `409 idempotency_conflict`.
- **The request id is unique for the ledger's whole life** (60 months), not 7 days: an Idempotency-Key reused after
  7 days still maps to the same `request_id`, so `refuseReplay` (`cas.ts`) answers `already_applied` for the same
  write by the same credential, and `conflict` for anything else. **A retry from another credential** (the network
  rotated its key mid-retry) is `conflict`, because the ledger row names the first credential as its actor. What the
  client should do then: read the state (`GET` the app) to see whether the operation applied, and if it didn't,
  start again with a new Idempotency-Key.

## A10. How the network's SDK gets each partner's key at run time

1. The network's portal switch, when a partner turns our sign-in on, makes the network's backend call
   `POST /v1/platform/apps` with the partner's name and site, and stores the answer's `app.id` and `publishableKey`
   in the partner's configuration on the network's side.
2. The network's SDK, on the partner's page, reads the partner's configuration from the network's own configuration
   service (as it reads its other partner settings) and, only when the switch is on, loads `@hana-id/web` and calls
   `createHana({ publishableKey, environment: 'test', evm, stellar })` (`docs/sodax-sdk-integration.md` section 2,
   unchanged). **When the partner uses the network's own widget** (an iframe on the network's origin inside the
   partner's page, as Sodax's swap widget is), the widget does the same inside its iframe with the partner's key.
   Decided (the Tech Lead, 2026-11-25, D926): still one app per partner, and that app lists **the widget's origin as
   well as the partner's own pages**. Our vault refuses a frame unless every page around it is an origin of the app
   (tested, D923: an app with only the widget's origin doesn't work on the partner's page), so the partner's pages
   bind its key to its own sites.
3. The key is public; what protects it is the app's allowed origins. The platform API is never called from a page: it
   refuses any request with an `Origin` header.
4. Until the partner's origin is in force, our sign-in refuses the partner's site (`origin_not_allowed`); the
   network's portal should show "Waiting for your owner to confirm, or live on {date}" from the origin's
   `activeFrom`, and "Live" once it is in force (at once after an owner confirms it, A15).
5. Switching off: the network calls `suspend` (logins stop at once; open pages notice within 30 s, as today). On a
   key rotation, the network creates a key, publishes it in its configuration, and revokes the old key once its
   caches have turned over. Decided (the Tech Lead, 2026-11-25, D926): turning a partner off in the network's portal
   does **not** sign its users out on their devices (the network's SDK only drops our wallet from its lists and
   removes our client, as closing the tab does); suspending the partner's app is what ends its sign-ins.

## A11. What the console and the admin portal show

**Our partner portal, for the network's members** (`apps/console`):

- An org page **Platform keys**: each key's label, thumbprint, scopes, state (awaiting acceptance, waiting with its
  date, in force, expiring, revoked, cancelled), who registered and who accepted it, when it was last used;
  **Register a key** and **Accept** (owners of each scope, fresh sign-in), **Confirm** for a waiting one (the page
  the announcement's Confirm link opens, `/confirm-platform-key/:id`: the key's label, thumbprint, scopes, who
  registered it and when it comes into force if nobody confirms; then the fresh sign-in), **Revoke** (owners,
  immediate), **Cancel** for a waiting one. On a real-money setup the registrant sees no Confirm button but "Another
  owner needs to confirm this key. If nobody does, it starts working on {date}."; in an org with one owner: "Your
  organisation has one owner, so this key starts working on {date}."; the state "Waiting for another owner to
  confirm, or in force on {date}".
- **Platform activity**: the `platform_calls` rows of the org (time, key, route, app, outcome, request id), filterable
  by app.
- On each app: "Created by your platform key {label}"; platform rows in the Audit with the key's label as the actor;
  origin changes proposed by the platform marked as such; on the scope, "Shared wallet: apps here get their own user
  IDs, and auto-approve is off" for a flagged scope.
- **Confirm a web address** (P10, A15): the page the email's Confirm link opens (`/confirm/:changeId`, a console
  page behind the usual sign-in). It shows the app's name, each waiting address of that one platform request in full
  with its decoded form and the internationalised-domain warning, which platform key proposed it and when, "Comes
  into force on {date} if nobody confirms it", and the line "This wallet is also used on {other apps}" when the
  scope is shared. Each address has its own tick box, none ticked at first, and there is no "confirm all";
  **Confirm** then asks for the usual fresh Google sign-in. Plain words on the page: "Only confirm web addresses you
  know belong to {app}. Once you confirm, {app} can use this wallet there straight away." and, beside the cancel:
  "Not yours? Cancel it." A viewer, or an owner who isn't an owner of the app's scope on chain (the console reads the
  scope's owners on chain for this, as `buildOwnerAction` does), sees the page without the Confirm button and the
  reason ("Only an owner of this wallet's settings can confirm"). The app's origins list shows "Waiting for an owner
  to confirm, or live on {date}" for each such address.
- **Remove a confirmed web address** (P10; confirmed by the Tech Lead, D917): the page the confirmation notice's removal link opens
  (`/remove/:changeId#t=`, no sign-in, for 7 days): the app, the address, who confirmed it and when, and one button,
  "Remove this web address", which stops it at once. **Revoke a confirmed key** (P2; proposed, still to confirm): the same for a key
  (`/revoke-platform-key/:id#t=`), "Stop this key".
- The Users screen changes of Part B (B6).

**Partner companies get no portal of their own in this version.** A member of the network's org sees every app and
user of the org (per-app access doesn't exist), so no network partner is invited to it. Security notices go to the
network's security contacts (and, for keys, its owners); the network tells its partner.

**The staff admin portal** (`apps/admin`):

- On the org: the platform switch (on/off, immediate, with a reason; turning it back on lists every key for review,
  L5) and the org's quotas; the keys with **Register**, **Approve** (a second staff member, never the one who
  registered), **Revoke**, **Cancel**; the last use and the call counts; the activity.
- On the scope: the shared-scope flag (one way; refused while any app on the scope has a policy in force or waiting,
  P0).
- A platform queue: every waiting origin proposal and key registration made by or for a platform, across orgs, with
  its origin, app and time left, so staff see each one before it is in force; and, for 7 days, every origin an owner
  confirmed, with who confirmed it and when (a confirmed origin is in force before staff can see it in the queue,
  so staff review it after the fact and suspend or remove it if it is wrong).
- On each app: "Created by the platform"; the existing per-app suspension (bit 1) and delete, unchanged; the mainnet
  demo switch (staff only, D428, D913 point 2), which for a platform-created app or an app on a flagged scope first
  shows a warning that asks staff to confirm: "This app shares one wallet with every app on its scope. Real money
  signed here comes from the same wallet as on the network's other sites." (H3).
- The new security event kinds in the existing security feed, each with a playbook (`packages/playbooks`).

**Open item, not in this spec** (partly met by D922, to confirm: Home now counts every app and shows up to 100 on a
wallet's page; the order is still the scope's, not the apps a person used): Passport Home shows at most 10 apps per scope (`HOME_APPS_PER_SCOPE`), and the
sign-in windows' "also used on other apps" line is being built on another branch. A network with many partners needs
Home to list the apps a person actually used first. Platform-created test apps are listed in Home on dev envs like
any app a person signed in on (decided, N8), so users see every site their wallet is used on.

## A12. On chain, and address impact

Nothing in Part A touches the contract or calls NEAR: the platform creates apps only on existing scopes (no
`get_scope` read, no `admin_register_scope`), and never makes an owner action; the owners' step-up for registering a
key reads the scope's owners, as every console step-up does, and writes nothing on chain. No key, path or address
derivation changes. **Address impact: none.**

## A13. What the network vouches for

The recommendation the Tech Lead asked to build on (D913 point 6): the network is the customer and the scope's owner,
so it vouches for every partner site it adds. Concretely the network, before calling `origins`, checks that the
partner controls the domain (its own process: for example a DNS record or a file on the site), adds only the
partner's exact HTTPS origins, and removes them as soon as the partner leaves or its domain lapses. Then one of the
network's owners confirms each new address in our partner portal, or lets it wait (A15). Journear's backstops are the
delay with the platform minimum, the announcement and cancel link, the confirmation's notice, the staff queue, the
off switches and the audit.

**A partner on the network's widget** (decided: one app per partner listing the widget's origin and the partner's
pages, D926). What follows, each a reading of the existing rules unless marked:

- **The widget's origin is the network's own**, so the network vouches for it as for its own site; it is proposed,
  announced and confirmed (A15) like any other origin, once per partner app, normally in the same create request as
  the partner's pages, so one confirmation covers them. Proposed, **to confirm (the Tech Lead):** no exception for it
  (no standing confirmation, no shorter wait): a stolen platform key could otherwise attach the widget's origin to an
  app without an owner looking.
- **The partner's own pages still decide where the key works.** In a frame, every ancestor must be an origin of the
  app (Chromium and WebKit by `location.ancestorOrigins`, every browser by the vault's `frame-ancestors`), so partner
  B's page can't use partner A's app through the widget (tested, D923).
- **The gap:** the widget's origin alone is enough when the widget is opened **top-level**. Anyone can open the
  widget's own page with a partner's settings and get that partner's app, outside the partner's pages. Read in our
  code and inferred, **not tested** (the test opened the widget top-level only for an app listing every partner page,
  where it worked). The windows still show the app's name and the widget's address. Later piece P12 (proposed) closes
  it.
- **Two apps may list the same origin**: the schema has no uniqueness across apps (`app_origins` has a plain index on
  `origin`), and two test apps on one scope both listing the widget's origin worked (tested, created through the e2e
  stack's own endpoint, which writes the rows directly). The platform's propose path has no rule against it (read).
- **The per-app quota:** the widget's origin takes one of the app's 20 origins (`MAX_APP_ORIGINS`), leaving 19 for the
  partner's pages (A5).
- **The "also used on other apps" line** (D912) counts apps, not origins, so it is unchanged: on partner A's app it
  names the network's other partner apps (tested, D923). What changes is the address under "From {App}": the
  requesting site our windows show is the vault's parent, the **widget's** origin, the same on every partner's site;
  the app's name is the only partner-specific part. Later piece P11 (proposed) shows the partner's page instead.

## A14. Staff restore of removed origins: considered and refused

The first version of this spec let Journear staff restore, without the wait, an origin a stolen key removed (D913,
question 8, first answered yes). The Tech Lead re-confirmed it as **no** on 2026-11-25 (D914), as PR 139's security
review advised (M1): a restore that skips the delay would be a path by which an origin comes into force with no time
for anyone to object, and a staffer tricked by someone posing as the network could use it to put an attacker's origin
back. Nothing of it is built. An origin a stolen key removed comes back as any other: the network proposes it again
(once its key is replaced) and an owner confirms it (A15), or a member adds it by hand. Staff's own `addOrigins` on
these apps is the same kind of path; it now needs a second person, or waits the platform minimum (A15, "Staff
proposals on a shared scope: four eyes", decided by the Tech Lead 2026-11-25, D917).

## A15. An owner's confirmation of a platform-proposed origin (decided, N3; gates P10)

**The rule** (the Tech Lead, 2026-11-25, D914), the same in every env except `local*` test envs:

1. An origin the platform proposes starts waiting and is announced as today (A4.5, A6): one email per request to the
   security alias and every security contact, with its cancel link. The spec adds **every owner of the org** to the
   recipients, since only owners can confirm (confirmed by the Tech Lead 2026-11-25, D917).
2. It comes into force **at once** when an owner of the organisation confirms it: signed in to our partner portal,
   pressing Confirm on a page that shows the app and the origin (A11). The email's Confirm link only opens that page;
   **a GET never confirms** (mail scanners open links, emails get forwarded). The cancel link stays one click from the
   email with no sign-in, as today (the page `/cancel/:changeId#t=` and its `POST`).
3. If nobody confirms it, it comes into force after the platform minimum (24 h, and at least `appChangeDelayMs`),
   unless it is cancelled first.

What follows from it (the spec's reading, not the Tech Lead's words): a stolen platform key alone gets only the slow,
cancellable path.

**Which envs are `local*`.** Today the only test is the env's name: `isLocalEnv` (`packages/env/src/origins.ts`,
`/^local/`). What else exists: the manifest schema allows http and loopback URLs only for `local*` names
(`packages/env/src/schema.ts`), `deploy-check` refuses a `local*` env ("local* envs run on wrangler dev, never
deployed", `scripts/lib/deploy-check.ts`), and the API's generated config serves a loopback env with no deployment
target (`apps/api/scripts/pages-wrangler.ts`). Nothing refuses a `wrangler deploy` of an env named `local…`. Proposed,
**to confirm (the Tech Lead)**: the exemption holds only when **both** the name is `local*` **and** the env's network
is `testnet` and its API URL is a loopback http URL (a new manifest schema rule: a `local*` env must have them, so a
real host can never be `local*`); the generator then writes `PLATFORM_MIN_DELAY_MS` (24 h, or the env's own delay
in such a `local*` env), the API refuses to start a guarded write with it under 24 h unless `ENV_NAME` is `local*` and
`NETWORK` is `testnet` (as `changeConfig` refuses a short delay on mainnet), and the stamped deploy wrapper
(`packages/env/src/stamped-deploy.ts`) refuses a `local*` env, with a test for each.

**Who may confirm** (decided by the Tech Lead 2026-11-25, D914: "ok with fresh sign in when confirming"; the same for
origins and for keys, A3): a console member whose role is `owner` (`members.role`,
`apps/console/migrations/0001_init.sql`; the role read fresh on the request, `ownerNow`, `apps/console/src/sql.ts`)
of an active org, **and** an on-chain owner (`Owner::Oidc`) of the app's scope, proving it is them with the console's
fresh Google sign-in at the moment they press Confirm (a new step-up kind `origin.confirm`), which the API verifies
itself as it does for `ConsoleRpc.changeOrigins` (`verifyStepUpToken`, `confirmStepUp`,
`apps/api/src/changes/step-up.ts`). That is the bar for adding an origin by hand today, so a confirmation never lets
anyone bring an origin into force who couldn't add it themselves. How today's code holds that bar, and what the
confirmation reuses: a `viewer` is refused by the console's route matrix with `forbidden` before anything else
(`runOrgRoute`, `apps/console/src/writes.ts`); the console builds the `origin.add` step-up without reading the chain;
an `owner` member who isn't an on-chain owner of the scope is refused by the API's `confirmStepUp` with `not_owner`
after the Google sign-in. So **hiding** the Confirm button from such an owner (A11) needs a chain read in the console,
as `buildOwnerAction` already makes (`apps/console/src/actions.ts`, its `not_owner` for owner actions); the API's
check stays the one that counts.

**What the confirmation checks** (`ConsoleRpc.confirmOrigins`, one compare-and-swap batch, failing closed):

- The actor is a `member` (`forbidden` otherwise: the platform, staff, the system and the link never confirm). The
  step-up token's nonce is the `origin.confirm` layout, with **its own label** (`"hana-id/console-origin-confirm/v1"`,
  so no `origin.add`, settings or owner-action token can stand in for it), over the signer account, the env, the
  org, the app, the scope and the sorted list of (change id, origin), so a token for one set of addresses confirms no
  other; the token is single use (`owner-actions:tokens`).
- **One set, all or nothing.** The call names 1 to 20 changes (`bad_request` beyond 20), all on **one app** and from
  **one proposing request** (the same `guarded_changes.request_id`), else `bad_request`. Each must be an `origin_add`
  proposed by the `platform`, `pending`, **announced** (`notified_at` set: so the security contacts and owners always
  hear of it first), not cancelled, not yet in force and not already confirmed; if any one fails, nothing is written
  (`not_pending`).
- The proposing key is still in force (not revoked, not expired) and the org's platform switch is on (`conflict`
  otherwise; a revocation or switch-off cancels the key's waiting proposals anyway, A3). The app is still in the
  proposing key's reach (A4.2: same org, a scope the key names, `test`, platform-created), not deleted, and not
  suspended by Journear (bits 1 and 2) (`not_found` or `conflict`). The org isn't frozen (`forbidden`).
- All of it is in the commit predicate, not only in the plan read: the commit row is inserted only if the count of
  qualifying changes among the listed ids (`json_each` of the list) equals the list's length, so a cancel, a key
  revocation, a switch-off, a move of the app or a staff suspension that lands between the read and the batch makes
  the confirmation write nothing (`version_conflict`). A cancel and a confirmation of the same change: whichever
  commits first wins.
- **Three statements**: one `origin.confirmed` row in `app_changes` for the whole call (`commitOnApp`: one row per
  call, since `request_id` is UNIQUE; its detail lists every change id and origin, as `origin.proposed` lists its
  origins), then one set update of `guarded_changes` (`confirmed_by`, `confirmed_sub`, `confirmed_at`, `active_from =
  now`) and one of the matching `app_origins` rows (`active_from = now`, as `expediteChange` does), each `WHERE id IN
  (SELECT value FROM json_each(:ids))` and guarded by the commit row's existence. Within `CONSOLE_DB_LIMITS` (2
  reads, 1 batch, 8 statements), with its entry in the console's costs.
- **In the database too** (A7): a trigger allows `confirmed_*` only on a platform `origin_add` that is `pending` and
  announced, once; and a stored earliest time (`guarded_changes.unconfirmed_active_from`, written at the ack) lets a
  trigger on `app_origins` refuse an `active_from` earlier than it unless the change is confirmed, so no other writer
  (the CLI, a bad deploy, a bare D1 write) can bring a platform origin forward.

**The notice of a confirmation** (the removal link, about a week, confirmed by the Tech Lead 2026-11-25, D917; the
rest proposed design). The origin is in
force before anyone else hears of the confirmation, and the announcement's cancel link then answers `not_pending`
(`cancelChangeByLink`, `apps/api/src/changes/lifecycle.ts`: a change in force can't be cancelled), while security
contacts need not be console members. So the confirmation's notice carries a **one-click removal link**: the admin
Worker reads `AdminRpc.confirmationNotices` (each confirmed, un-noticed set, with the org's contacts and owners),
emails the security alias, every security contact and **every owner of the org** one email per confirmation call:
"{Member email} confirmed {origin} for {app}. It works there now. If this wasn't meant to happen, remove it here: it
stops at once." with one removal link per origin, and then calls `ackConfirmationNotice` (`system` only), which stores
`sha256` of each link's token (`guarded_changes.removal_token_hash`) and `removal_until = now + 7 days`. The link
opens a console page (`/remove/:changeId#t=`, no sign-in; a GET removes nothing) whose `POST` removes that origin at
once (`removeOrigins` with the `link` actor, `ConsoleRpc.removeOriginByLink`), single use, refused after
`removal_until` or once the origin is gone. Chosen over reopening the original cancel link for a confirmed origin
because it keeps "cancel" (before in force) and "remove" (after) as two separate, separately audited acts. The
console's Audit shows the `origin.confirmed` row with the member as the actor and its console `audit_log` row (the
step-up write); the staff queue lists it for 7 days (A11).

**The accepted risk** (the Tech Lead, 2026-11-25, D914). One owner's Google account taken over can propose nothing
through the platform, but it can confirm an origin a stolen platform key proposed, or both can be in one attacker's
hands; then an attacker's origin is in force at once, with no time to cancel. The Tech Lead accepted this: "I think
this is too pessimistic, if an owner's own Google account is taken over, then more is at risk (other than these
stuff), his banking etc". What still bounds it (the spec's list, not the Tech Lead's words): the user's approval
window names the app and its web address, with the "also used on other apps" line (N6); the confirmation's notice to
every owner, the security contacts and Journear, with its removal link; staff suspend the app at once (bit 1); the
network or any owner removes the origin at once.

**Staff proposals on a shared scope: four eyes** (decided by the Tech Lead 2026-11-25, "four eyes", D917; it replaces
D914's proposal of a flat 24 h wait). Staff's `addOrigins` on a platform-created app, or on any app of a flagged scope
(the reach D914's proposal had; staff's `createApp` initial origins on a flagged scope included), would otherwise
wait only `appChangeDelayMs` (60 s on sandbox-dev) and, for a scope nobody has used, could get the `no_session`
waiver (`lifecycle.ts`): the same "a staffer tricked by someone posing as the network" path that the refused restore
had (A14, M1). **The rule:**

1. Such an origin comes into force **at once when a second person confirms it**: a **different staff member** in the
   admin portal, or **an owner of the org** in the console, with the same bar as for a platform proposal (a console
   `owner` who is an on-chain owner of the app's scope, with a fresh Google sign-in).
2. With no confirmation it comes into force after the 24 h platform minimum (and at least `appChangeDelayMs`), unless
   cancelled. No waiver, and no expedite by the proposer alone.
3. The staff member who proposed it can never be the one who confirms it.

**The catch, told to the Tech Lead:** today the Tech Lead is the only staff member, so until a second admin exists a
Sodax owner confirms it in the console, or it waits the day.

**Proposed, to confirm (the Tech Lead):**

- **How the second staff member proves who they are**: the admin portal's existing identity, the Cloudflare Access
  application token checked on every `/api/*` request (`Cf-Access-Jwt-Assertion`, verified by `AccessJwtVerifier`:
  RS256 against the team's certs, `aud = ACCESS_AUD`, `type = 'app'`, a non-empty `sub`, so no service token), and the
  lowercased email on the manifest's staff list (`STAFF_EMAILS`), as `apps/admin/src/access.ts` does; the staff actor's
  id is the Access `sub`, a per-identity UUID. "A different staff member" is a different Access `sub` **and** a
  different email from the proposer's, with a reason of at least 20 characters, as expedite takes. What it can't
  catch: one person with two identities on the staff list (two emails, two Access identities); the staff list is
  changed only by a reviewed commit to the manifest and Access stays on two seats, which bounds it.
- **Held in the database write**, not only in the screens: `AdminRpc.confirmStaffOrigins` (a second staffer) and the
  console's `ConsoleRpc.confirmOrigins` (an owner, extended to these changes) share the commit predicate of A15 (the
  set, one app, one proposing request, pending, announced, unconfirmed), plus `confirmed_by IS NOT proposed_by` for a
  staff confirmer; the confirm trigger and the earliest-time triggers of A7 cover a staff proposal marked for the rule
  (a new `guarded_changes.second_person` flag, written once at the proposal from the app's `created_by_kind` and the
  scope's flag, and a `confirmed_by_kind` of `'member'` or `'hana'`), and a CHECK refuses `confirmed_by` equal to
  `proposed_by`. `ackNotice` writes `unconfirmed_active_from` for such a proposal as for a platform one, the CLI's
  `app:changes:announce` refuses it as it refuses a platform proposal, and `expediteChange` already refuses every staff
  proposal.
- **The notices**: the proposal's announcement to the security alias, every security contact and every owner, with
  its cancel link and the Confirm link (for owners); the confirmation's notice to the same people **naming both
  people** (the proposing staff member and the confirming staff member or owner), with the removal link, valid about
  a week, as for other confirmations.
- **Built in P10** (it reuses P10's confirmation, triggers, notices and removal link), with the tests in P10's row
  and an independent security review.

**Open, to revisit at mainnet preparation (not decided).** On a production env, an origin a member adds by hand in
the console still waits the full guarded-change delay (at least 24 h), while an owner's confirmation of the
platform's proposal brings one into force at once. Confirming the platform's proposal is therefore faster than adding
one by hand, and an on-chain owner who also holds the platform key can use the platform to skip the production delay.
Nothing changes now; the two paths are to be made consistent (one way or the other) when mainnet is prepared.

**Platform keys** have a confirmation of their own, with the same mechanics and one more rule on a real-money setup
(four eyes: the confirming owner is not the one who registered the key): A3, "An owner's confirmation of a key"
(decided by the Tech Lead 2026-11-25, D914).

**Address impact: none.** The confirmation changes when a web address may use an app, an off-chain record; no
contract call, key, path or address derivation.

---

# Part B: per-app User IDs on a shared scope, and linking

## B1. What per-app IDs protect, and what they don't

On a shared scope every partner site opens the **same wallet** (D909): the same Stellar, EVM and NEAR addresses for
one person on every site. Those addresses are in every identity token's `wallets` claim, proven by the wallet's own
keys, and they are public on chain. So **any two partners who compare the addresses they hold can match their users,
with or without per-app IDs**, and so can anyone watching the chain. A shared email (if the user shared it with both)
or a name also matches.

What per-app IDs do:

- Partners no longer get a ready-made join key: today every partner on the scope gets the same `sub` and the same
  Support ID for a person, an identifier designed for matching. A per-app `sub` leaked from one partner (a log, an
  analytics tool, a breach) doesn't name the person at another.
- **They protect a partner that forgets to check `aud`** (L12). Today, on a shared scope, a token minted for partner
  X's app carries the same `sub` as the person's token at partner Y; a backend at Y that skips the `aud` check would
  take X's token (from X's logs, or X itself) as that person. With per-app IDs, X's token names an ID Y has never seen.
  The guide still says to check `aud` every time (`docs/integration.md`, the `sub` claim and rule 1).
- It is the usual practice for one login service serving many relying parties (OpenID's pairwise subject).
- If the network later gives some partners their own wallets (their own scopes), nothing built on a shared `sub` has
  to be undone.

What they don't do: give users privacy between the network's partners. Matching by address stays possible and can't
be prevented while the wallet is shared; only separate wallets (separate scopes) would, which D909 decided against.

The Tech Lead confirmed keeping per-app IDs with this caveat in view (D913, question 6). They are described to
partners and users as "an ID of your own for each person", never as privacy between sites; the sign-in windows' "also
used on other apps" line (another branch) is what tells users the wallet is shared.

## B2. Derivation

Proposed, in `packages/core/src/identity.ts` beside `identitySub`:

```
appSubBytes = HMAC-SHA256(IDENTITY_SUB_KEY,
                "hana-id/idt-app-sub/v1" ‖ 0x00 ‖ borsh(scope_id) ‖ borsh(app_id) ‖ scopeSubBytes)[0..16]
appSub      = "u1_" ‖ base64url(appSubBytes)          (25 characters, the existing format)
```

where `scopeSubBytes` are the 16 bytes behind today's `sub` (`identitySubBytes`). Choices:

- **The same key, a new label**: domain separation as `sid` already has (`"hana-id/idt-sid/v1"`). No new secret to
  generate, store or protect; a leak of `IDENTITY_SUB_KEY` already maps every ID, so a second key would add no
  protection.
- **From the scope-level bytes, not the root identity**: the API, the linking view and the erase script can compute
  any app's ID from `end_users.token_sub` alone, without the Google `sub`.
- **The same `u1_` format**: partners' existing code keeps working (`buildIdentityClaims`' check, the SDK's
  `IDENTITY_SUB_RE`, `supportIdFromSub` in partner backends); `u2_` stays reserved for a key leak (`docs/security.md`).
  The value is opaque to partners; only we know which rule made it.
- **Final from the day it ships**: changing the label or the inputs later would change every such partner's IDs, so
  the layout is pinned by test vectors from `packages/core/scripts/gen-identity-vectors.mjs` (L10: the path), as for
  `sub` and `sid`.

## B3. Which apps get it, and what stays exactly as it is

Proposed:

- **The shared-scope flag** `scopes.app_user_ids` (0 or 1, default 0; P0), set by Journear staff only
  (`AdminRpc.setScopeAppUserIds`, with an `app_changes` row `scope.app_user_ids`), one way: once on, it stays on;
  refused while any app on the scope has an auto-approve policy in force or waiting (P0).
- **An app column** `apps.user_ids` (`'scope'` or `'app'`, default `'scope'`), written once by `INSERT … SELECT` from
  the scope's flag inside the create batch (staff's `createApp` and the platform's): `'app'` when the flag is on at
  that moment, `'scope'` otherwise. A trigger refuses any later change of `user_ids`, and of `scope_id` for an `'app'`
  app (the derivation includes both).
- The identity token's `sub`, the session answers' Support ID and the partner portal's per-app User ID use `appSub`
  for an `'app'` app and today's `sub` for a `'scope'` app.

**Existing apps are unaffected, bit for bit.** The migration adds the column with default `'scope'` and the flag with
default 0, and sets nothing else: every existing app, the hosted demo apps, the stamps site's app and every
single-app scope keep `user_ids = 'scope'`, so their tokens' `sub`, their Support IDs and the User IDs in the portal
stay exactly what they are. A test pins this: the identity vectors for a `'scope'` app are unchanged, and a token
minted for an existing app before and after the migration has the same `sub`.

**A second app joining a scope whose first app already has users.** Turning the flag on changes no existing app: the
first app keeps `'scope'`, its partner keeps the IDs it already stores; the second and later apps get `'app'`. The
first app's IDs are the scope-level IDs, which the network also sees in its portal; that partner can't compute any
other app's IDs from them (they need our key). For the network's scope the recommendation is to set the flag before
its first partner app, so every partner app is `'app'` from its first login; any app the network already has on that
scope (for example its own site) keeps its IDs.

**What stays per scope** (unchanged, internal): `end_users.token_sub` (the person's scope-level User ID, the
directory's key for partners), the keys of `email_consents.user_sub` and `name_shares.user_sub`, the identity token's
per-account rate-limit key, Passport Home's Support ID (Home is ours; staff and the network resolve it), and the
internal id `hu_…`.

## B4. Support ID

For an `'app'` app the Support ID becomes the short form of its `appSub` (decided, D913 question 7), so `hana.supportId`
on the partner's page equals `supportIdFromSub(token.sub)` in the partner's backend, as the partner guide promises:
`sessionSupportId` (`directory/store.ts`) takes the app and uses its mode. Two partners then see different Support IDs
for one person, which removes the second join key. The user still reads one code to whoever helps them; staff and the
network resolve both forms (B6).

## B5. Partners verifying tokens

Nothing changes in how a token is verified: one issuer per env (`iss`), the same JWKS (`{iss}/jwks.json`), the same
`typ`, `alg` and lifetime, `aud` = the app id as today, no new claim (the spec's "no other claim" promise, D760,
holds). What changes is the meaning of `sub` for an `'app'` app: unique per (`iss`, `aud`) instead of per scope. A
partner keys its users on `sub` within its app as today. A partner that wants one ID across two of its own sites uses
one app with both origins, not two apps. `docs/integration.md` says this when built; this branch already corrects its
`sub` row, which said the `sub` is "different at every other partner" (not true on a shared scope today) and now asks
partners to check `aud` there too (L11).

## B6. Linking: who may see one person's IDs across the network's apps (gates P7: L9)

**Who may:** the scope's owning organisation (the network) and Journear staff. Not partners: their IDs can't be
turned into each other's without our key, and they have no portal and no platform key.

**Built:**

1. **In our partner portal, for the network's owners only** (decided, D913 questions 4 and 5). The Users screen of a
   flagged scope lists people (by the scope-level User ID, labelled "User ID (all your apps)"). A person's page gains
   "This person on your apps": one row per app of the org on that scope where the person has signed in, with the
   app's name, that app's User ID and Support ID, first and last sign-in. Search accepts any per-app User ID or
   Support ID as well as today's forms.
   - Authenticated by the console's existing sign-in and membership; the cross-app panel and the per-app search are
     for `owner` members only; viewers keep today's screen.
   - Audited: every opening of the panel and every per-app search writes a console `audit_log` row
     (`users.link_view`, target the scope-level User ID, no other identifier) before it answers, shown on the org's
     Audit page.
   - Limited: 60 a member an hour, 300 a day (`console-link:<user id>`), 1 000 an org a day, `rate_limited` past them.
   - **Alerted** (L9): an org past 200 lookups in a UTC day, or a member past 30 in an hour, writes a
     `link_lookup_volume` security event, which the admin Worker emails to staff (once per window).
   - Returns: app names and ids, the per-app User IDs and Support IDs, times. No email beyond what the Users screen
     already shows, no Google `sub`, no internal id.
2. **In the staff admin portal.** The Support lookup (`AdminRpc.supportLookup`, `apps/admin/src/support.ts`) resolves
   per-app User IDs and Support IDs to the person and lists every app with that app's IDs; audited as staff lookups
   already are (D394).

**Not built: a lookup from the network's backend** (decided: portal only for now, D913 question 4). If it is wanted
later, it is `POST /v1/platform/users/lookup {appId, userId | supportId}` with the same rules plus a `platform_calls`
row and its own limits.

**The data-sharing rule** (L9; decided, N7): the network may **not** give one partner another partner's ID for the
same person (the network's agreement with us and its guide say so), since it would rebuild the join key per-app IDs
remove.

**How the lookup works.** The forward direction (person → each app's ID) is computed from `end_users.token_sub` and
the app id (B2). The reverse direction (an app's ID → person) needs a record, proposed below: when a person signs in
on an app of a flagged scope, the directory's existing write after login (`directory/sync.ts` `syncAfterLogin`,
`/v1/wallets/record`) also upserts one row for (person, app). That row is also what tells the panel which apps the
person used.

**Telling users** (decided, D913 question 10). Passport Home, on a wallet of a flagged scope, says in plain words:
"{Network} can see which of its partner sites you use this wallet on."

## B7. Data model, migration, retention (gates P6: M8)

API D1, with P0's flag (A7) already in place:

```sql
ALTER TABLE apps ADD COLUMN user_ids TEXT NOT NULL DEFAULT 'scope' CHECK (user_ids IN ('scope', 'app'));
-- Fixed once written: a change would change that app's users' IDs.
CREATE TRIGGER apps_user_ids_fixed BEFORE UPDATE OF user_ids ON apps WHEN NEW.user_ids IS NOT OLD.user_ids
BEGIN SELECT RAISE(ABORT, 'apps: user_ids is fixed'); END;
CREATE TRIGGER apps_app_ids_scope_fixed BEFORE UPDATE OF scope_id ON apps
  WHEN OLD.user_ids = 'app' AND NEW.scope_id IS NOT OLD.scope_id
BEGIN SELECT RAISE(ABORT, 'apps: an app with its own user ids keeps its scope'); END;
CREATE TRIGGER scopes_app_user_ids_one_way BEFORE UPDATE OF app_user_ids ON scopes
  WHEN OLD.app_user_ids = 1 AND NEW.app_user_ids = 0
BEGIN SELECT RAISE(ABORT, 'scopes: app_user_ids stays on'); END;
-- Which apps of a flagged scope a person signed in on, and that app's IDs (B6). Personal data, as the directory.
CREATE TABLE end_user_apps (
  user_id       TEXT NOT NULL REFERENCES end_users (user_id) ON DELETE CASCADE,
  app_id        TEXT NOT NULL,
  app_sub       TEXT NOT NULL CHECK (app_sub GLOB 'u1_*' AND length(app_sub) = 25),
  support_code  TEXT NOT NULL CHECK (length(support_code) = 8),
  first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, app_id)
);
CREATE INDEX end_user_apps_app ON end_user_apps (app_id);
CREATE INDEX end_user_apps_sub ON end_user_apps (app_sub);
CREATE INDEX end_user_apps_support ON end_user_apps (support_code);
```

**Retention and erasure (M8).** `end_user_apps` follows the rule of `email_consents` and `name_shares`: a deleted
app's rows are purged **30 days after its deletion**, in the same `purgeDirectory` pass and pages
(`apps/api/src/changes/retention.ts`), and every row goes with its person when the scope's directory is purged
(`ON DELETE CASCADE` from `end_users`). The erase script (`scripts/lib/uid-erase.ts`) **accepts a per-app User ID or
a per-app Support ID** as well as today's forms, resolves it through `end_user_apps` to the person, and erases that
person's rows here with the rest. Nothing is backfilled: existing apps are `'scope'`, and rows of `end_user_apps`
appear from the first sign-in after the flag is on.

## B8. On chain, and address impact

Nothing in Part B touches the contract, a key, a path or an address: the per-app ID is an off-chain pseudonym computed
by the API at mint. **Address impact: none.** What becomes final when it ships is the per-app ID's layout (B2), which
partners will store.

---

## Decided by the Tech Lead (2026-11-24): this spec's first eleven questions

Answered "yes all" to the recommendations (D913). Each is now part of the design above.

1. Sign requests with ECDSA P-256 only: **yes** (A3).
2. The network's on-chain owners may register a key themselves; it still waits the delay: **yes** (A3).
3. Platform keys expire after one year: **yes** (A3).
4. A user lookup from the network's backend: **no, portal only for now** (B6).
5. The cross-app view of one person: **owners only** (B6).
6. Keep per-app User IDs, knowing partners can still match people by wallet address: **yes** (B1).
7. A per-app Support ID as well: **yes** (B4).
8. Staff may restore, without the 24 h wait, an origin a stolen key removed: first answered yes; **re-confirmed as no
   on 2026-11-25** (D914), as the security review advised (M1). Not built (A14).
9. Report a partner origin with no sign-in for 60 days to the network and staff: **yes, as a later piece** (P9).
10. Tell users in Passport Home that the network can see which of its sites they use: **yes** (B6).
11. Staff may expedite a new platform-proposed origin: **no** (A6).

## Decided by the Tech Lead (2026-11-25): the questions from PR 139's security review

How it was put (D914): the nine questions as a table numbered 1 to 9, plus "The re-check (earlier question 8)" with
the recommendation no and the line: Reply "yes all, restore no" to accept everything. The Tech Lead answered "yes to
all except for number 3", that is, the recommendations accepted for N1, N2 and N4 to N9, the recommendation on the
restore being no ("number 3" is N3, not D913's question 3); the reply "Noted: yes to the other eight, and no to staff
restoring without the wait" drew no objection. N3 was then decided differently after a discussion. Each is now part
of the design above.

- **N1.** May the platform act on apps it didn't create (the network's own site, apps staff made for it)? **No.** It
  sees and changes only apps it created (A1, A4.2).
- **N2.** Will the same credential model serve the network's future live scope? **Yes, with a separate key and its
  own security review before any live app is opened to it** (A1).
- **N3.** A minimum delay for platform-proposed origins and keys on dev envs, where the usual 60 s protects almost
  nothing? Recommended: 24 h in every env except `local*` test envs. **Decided differently:** the 24 h minimum stays
  for an origin nobody confirms, and an origin comes into force **at once when an owner of the organisation confirms
  it** in our partner portal; the same in every env except `local*` test envs (A15, P10). The Tech Lead accepted the
  remaining risk of a taken-over owner account (A15). **Who may confirm**, decided later the same day ("ok with fresh
  sign in when confirming", D914): a console `owner` member who is an on-chain owner of the app's scope, with a fresh
  Google sign-in when pressing Confirm, for origins and keys alike (A15, A3). **Open, for mainnet preparation:** a
  member's own origin on a production env still waits the full delay (A15).
- **Platform keys** (decided by the Tech Lead later the same day, D914, not part of N3's answer): a new key is
  announced and waits the 24 h platform minimum unless an owner confirms it; on a test setup any owner may confirm it,
  the registrant too, and it is in force at once; on a real-money setup only a different owner (four eyes) (A3).
  **Open:** on a real-money setup one taken-over owner account alone can't get a key in force at once; on a test
  setup it can.
- **N4.** Refuse auto-approve in code for every app on a shared scope? **Yes** (piece P0).
- **N5.** Must a key that staff register be accepted by the network's owner (or a second staff member) before it
  works? **Yes** (A3).
- **N6.** Must the "also used on other apps" line ship before the platform is switched on for any org? **Yes**
  (build plan, gates).
- **N7.** May the network give one partner another partner's ID for the same person? **No** (B6).
- **N8.** Should platform-created test apps appear in Passport Home's list on dev envs? **Yes**, like any app a
  person signed in on, so users see every site their wallet is used on (A11).
- **N9.** Should key-registration notices also go to the org's owners, not only the security contacts? **Yes** (A3).

## Confirmed by the Tech Lead (2026-11-25): D914's proposals

From a numbered list put to the Tech Lead (D917): "ok for A to E except E's 17", then "ok for items 20 to 22 as
well.", then, on 17, "four eyes". Each is now part of the design above.

- **14.** A revocation (and the switch-off and a freeze) also cancels every waiting origin the key proposed: **yes** (A3).
- **15.** The one-click removal link in the "address confirmed" email, about a week: **yes** (A15). The key's revoke
  link (A3) was not put separately: still to confirm.
- **16.** The org's owners also get the "new address proposed" email: **yes** (A6, A15).
- **17.** Staff proposals on a shared scope: **not** the flat 24 h wait D914 proposed, but **four eyes**: in force at
  once when a different staff member or an owner confirms, else after 24 h; the proposer never confirms (A15).
- **20.** What "a different person" means for four eyes on keys: **yes** (A3).
- **21.** An owner's acceptance of a staff-registered key counts as its confirmation: **yes** (A3).
- **22.** Switching the org's platform off or freezing it also cancels waiting keys: **yes** (A3).

Not put, **still to confirm**: the `local*` guard (A15), the standby-key advice (A3), the key's revoke link (A3), and,
for the four-eyes rule on staff proposals, how the second staff member proves who they are, its database rules, its
notices and that P10 builds it (A15).

## Build plan

Independently mergeable pieces. Part B doesn't depend on Part A, except that both need P0's flag; Part A's create
needs it (A4.4). Each piece updates its current-state docs (`docs/api.md`, `architecture.md`, `security.md`,
`operations.md`, `integration.md` where it applies) in the same branch. Sizes: S about 2 days, M about a week, with
review.

**The review's findings, by the piece they gate:**

| Gate | Findings |
|---|---|
| Before P1 | M9 (the ledger rebuild as specified in A7, the kind triggers, the deploy's bookmark and comparison) |
| P2 | M5 (acceptance of staff-registered keys, owners in the notices, no registration within 7 days of a contact change), L6 (an owner of each scope), the key confirmation and its four-eyes rule (A3, D914) |
| P3 | M2 (per-IP counts failures only), M3 (the platform's own global breaker), M4 (plain ES256, both S values, DER and raw, the high-S vector), L1 (exact regexes, one parsed path, no dot or empty segments, GET and POST only, JSON, no encoding), L2 (`ENV_NAME` signed, one key per env), L5 (self-revoke with the switch off, the key review before re-enabling), L8 (the hot-DB budget, the nonce object's name and location) |
| P4 | H1 (the reach filter in every plan read and commit predicate), H2 (cancel held to platform-proposed origin adds), M7 (live origin rules), L3 (idempotency for the ledger's lifetime, the rotated-key retry), L4 (who holds the partner bit), L15 (look-alike names within the scope), L16 (`INSERT … SELECT` of the app's mode) |
| P5 | L7 (what is recorded and what is only counted), L14 (one email per request, lower quotas), H3's mainnet demo warning |
| P10 | M6 (decided as N3: the owner's confirmation and its threats, A2 and A15), PR 142's review (the set write, the removal link, revocation cancelling waiting proposals, the database's earliest time, the `local*` guard) |
| Before the platform switch is on for any org | P0 (H3, in code), the key confirmation (P2), the platform minimum (P4) and the owner's confirmation of origins (P10, M6), each built, reviewed and deployed; the "also used on other apps" line (N6) |
| P6 and P7 | M8 (retention and erasure), L9 (lookup volume alerts, the data-sharing rule N7), L12 (the `aud` benefit and the guide), L10 (the vectors' path) |
| None | M1 (staff restore): closed by refusing the restore (question 8, A14) |
| This branch | L11 (`docs/integration.md`'s `sub` row corrected), L13 (D913 split into the Tech Lead's words, their answers and what is only proposed) |

| Piece | What | Size | Tests required | Independent security review |
|---|---|---|---|---|
| P0 | **Shared-scope rules in code** (H3): `scopes.app_user_ids`, `apps.created_by_kind`; `AdminRpc.setScopeAppUserIds` (one way, refused while a policy is in force or waiting); `proposeChange` in ConsoleRpc and AdminRpc and the admin CLI's `app:settings` refuse a `policy_set` (`policy_invalid`, "Auto-approve is off for apps that share a wallet") for an app on a flagged scope or created by the platform; the hourly drift check flags a policy on such an app; the console and the admin portal hide the policy editor for them. Ships before the platform is switched on for any org | S | Refused through each of the three paths for a flagged scope and for a platform-created app; an unflagged app unchanged; the flag refused with a waiting policy; the drift flag for a bare D1 write | **Yes** |
| P1 | The `platform` actor: the rebuild of `app_changes`, `guarded_changes` and `security_events` with the kind triggers (A7); `ACTOR_KINDS`, `PROPOSER_KINDS`, audit titles; the notice email's "Proposed by" wording; the console's Audit rendering | S | The migration test of A7 (rows, `seq`, every index and trigger by its SQL, refusals kept, an unknown kind refused); the ops script's before and after comparison; views and the email for each actor kind | **Yes** (the ledger) |
| P2 | Credentials: `platform_keys`, `platform_orgs`; registration by an owner of each scope and by staff with acceptance or a second staff member; the 7-day contact rule; notices to contacts, owners and the alias naming who registered and accepted; ack, cancel link, activation and expiry jobs; the four revocation routes; the switch with the key review; **the owner's confirmation of a key** (A3, A7: `ConsoleRpc.confirmPlatformKey`, step-up kind `platform.key_confirm`, `platform_keys.four_eyes` and `confirmed_*` with their CHECKs and trigger, the Confirm link in the key's announcement and the console page, the notice of a confirmation, the acceptance counting as the confirmation (proposed)); P10 reuses its page, step-up and notice machinery for origins | M to L | Each registration route; the step-up nonce bound to env, thumbprint, scopes and label (a token for another key refused); one owner of only one of two scopes refused; a staff key unusable until accepted, and the registering staffer can't approve it; a registration within 7 days of a contact change refused; the delay with no waiver, at least the 24 h platform minimum on a dev env when nobody confirms; the link cancel; immediate revocation by each route; expiry. The key confirmation: on a dev env the registrant's own confirmation brings the key into force at once; **on a production env the registrant's confirmation refused** (by the API and by a bare D1 write against the CHECK), **a second owner's confirmation brings it into force**, **one owner only: the key waits the 24 h**; a confirmer who differs only in email, or who became an owner after the registration, refused; `four_eyes` 1 on every mainnet config and fixed once written; **the platform key cannot confirm a key** (no platform route; `ConsoleRpc.confirmPlatformKey` refuses every non-member actor); a GET of the page or the link changes nothing; a confirmation before the announcement, after a cancel or after a revocation refused, and a revocation racing a confirmation (each order); a staff key's owner acceptance in force once announced, a second-staff approval waiting unless an owner confirms; a confirmation within 7 days of a contact change refused; **each revocation route, expiry, the switch-off and the freeze cancelling, in the same batch, every waiting origin the key (or the org's keys) proposed, with one `change.cancelled` row naming the revoker; an origin in force left as it is; the switch-off and the freeze cancelling the org's waiting key registrations (proposed)**; the key confirmation's notice and its revoke link (single use, 7 days, a GET revoking nothing; proposed); an early `active_from` without a confirmation refused by the trigger | **Yes** |
| P3 | Request authentication and admission: the route, A3's checks in order, the failure-only per-IP window, the nonce object (pinned), the per-key and per-org limits, the platform's breakers, `PLATFORM_DB_LIMITS`, `platform_calls`, `GET /credential`, self-revoke | M | The vectors from an independent implementation, the high-S one verifying and the DER one refused; every refusal in A3's order with its code; a path with `//`, `.`, `..`, `%2F` or a trailing slash refused; a PUT, a non-JSON or encoded body refused; a replayed nonce; a request signed for another env (`ENV_NAME` or `SIGNER_ACCOUNT`); a body or path changed after signing; the identical `401` for every authentication failure; a valid key behind an IP that is failing still admitted; self-revoke with the switch off; a platform breaker flood leaving the console's breaker untouched; each route within its cost | **Yes** |
| P4 | Operations: create (the platform variant, the look-alike name check within the scope, quotas, `INSERT … SELECT`), list, get (the allowlisted view), origins propose (live rules; `ackNotice`'s platform minimum, `PLATFORM_MIN_DELAY_MS`, for platform proposals), remove and cancel, suspend and resume (`partner_bit_by`), keys create and revoke; the reach predicate in every reused writer; `platform_requests` | M | H1's tests (a live app, a staff-created app and another scope untouched; the scope moved between the read and the commit); H2 (a member's, staff's or policy change `not_found` to the platform's cancel); M7 (a loopback, http or mixed-script origin refused on a test scope); the platform minimum (a platform proposal's `active_from` at least 24 h after its ack on a dev env, its env's delay in a `local*` env, a member's proposal unchanged); **a create's origins recorded as platform proposals, waiting 24 h on a dev env, never given `no_session`, and confirmable**; the CLI's `app:changes:announce` refusing a platform proposal; staff proposals on a flagged scope or platform-created app waiting the minimum with no waiver unless a second person confirms them (A15, D917, with P10); the resume rule including a member suspending after the platform; idempotency (a retry returns the first result; another body `idempotency_conflict`; another credential `conflict`; after 7 days `already_applied`); the breaker and the reserve; a frozen org | **Yes** (with P3 if built together) |
| P5 | Screens: the console's Platform keys, activity, app badges and Audit rows; the admin portal's org switch with the key review, quotas, approvals, platform queue and activity; the mainnet demo warning; one email per request; playbooks for the new event kinds | M | Console and admin unit tests; an e2e run: register a key, accept it, create an app, propose origins, see one notice and the queue, cancel from the link | No |
| P6 | Per-app User IDs: `appSub` in core with vectors from `packages/core/scripts/gen-identity-vectors.mjs`; `apps.user_ids` with its triggers; the mint, the session answers' Support ID; `end_user_apps` written after login; retention and the erase script (M8); the guide's `sub` text | M | Vectors from the independent generator; an existing app's `sub` and Support ID unchanged across the migration; an `'app'` app's token `sub` and `hana.supportId` agreeing with `supportIdFromSub`; two apps of a flagged scope giving different IDs, one app on an unflagged scope giving today's; the triggers; a deleted app's rows purged at 30 days, not before; erase by a per-app User ID and by a per-app Support ID | **Yes** |
| P7 | Linking: the console's "This person on your apps" panel and per-app search (owners), its audit rows, limits and volume alert; the staff Support lookup resolving per-app IDs; Passport Home's line for a flagged scope | S to M | A viewer refused; another org's user `not_found`; every lookup audited before it answers; the limits; the alert once per window; nothing beyond the listed fields in the answer | **Yes** (with P6) |
| P8 | The network's guide: a partner-facing document for the network (the request format, the reference signer with the DER conversion, the vectors, every endpoint, the delay, the off switches, "check `aud`"), checked by the docs test that keeps partner guides free of repo paths | S | The guide's code samples run against the local stack | No |
| P9 (later) | The 60-day unused-origin report (an origin's last sign-in day, written at most once a day per origin), to the network and staff. No staff restore (A14) | S | The report lists an origin with no sign-in for 60 days and not one used within them; at most one write a day per origin | No |
| P10 | **The owner's confirmation of origins** (A15, decided N3; who may confirm decided, D914): `ConsoleRpc.confirmOrigins` with its set commit predicate (one app, one proposing request, 1 to 20 changes, all or nothing); the console's step-up kind `origin.confirm` (the `pending_actions` rebuild) with its own nonce label; `guarded_changes.confirmed_*`, `unconfirmed_active_from`, the removal link's columns and the three triggers (A7); `origin.confirmed` in the ledger and `APP_CHANGE_KINDS`; the confirmation's notice with its ack and removal link (`AdminRpc.confirmationNotices`, `ackConfirmationNotice`, `ConsoleRpc.removeOriginByLink`, the `/remove/:changeId#t=` page); owners added to the platform proposal's notice, its wait line and its Confirm link; the console's confirmation page (with the chain read that hides Confirm) and origin states (A11); the admin portal's queue of confirmed origins; the platform view's `confirmedAt`; the `local*` guard (A15, proposed); **the second person's confirmation of staff proposals on a shared scope** (A15, four eyes, D917: `AdminRpc.confirmStaffOrigins`, the console's confirmation for them, `second_person`, `confirmed_by_kind`). Reuses P2's page, step-up and notice machinery. After P2, P4 and P5; before the platform is switched on for any org | M | **Who and how:** a confirmation by an `owner` member who is an on-chain owner of the scope brings each ticked origin into force at once, and no other; refused for a viewer (`forbidden` from the route matrix), for an owner member who isn't an on-chain owner of that scope (`not_owner` after the sign-in), for a member demoted to viewer between creating the action and signing in, and for every non-member actor; ConsoleRpc refusing a member's or staff's change (not a platform proposal); no platform route can confirm or bring an `active_from` forward (every route walked). **The token:** a token for another set of changes, another app, another org, another scope or another env refused; a token of another kind (an `origin.add` token, a settings token) refused, the `origin.confirm` nonce having its own label; a used token refused. **Requests:** a GET of the confirm page or of the email's link changes nothing; a confirm without the console's CSRF headers refused. **State:** refused before the announcement, after a cancel, after it came into force, twice; a cancel and a confirmation racing (each order; the second loses); the proposing key revoked or expired, the org's switch off, the org frozen, the app deleted, moved off the key's scopes or suspended by Journear, each between the plan read and the batch (nothing written). **The set:** a partly stale set writes nothing; a set spanning two apps or two proposing requests refused; 21 changes refused; the call within `CONSOLE_DB_LIMITS` and its cost. **The database:** the confirm trigger refusing a member's or staff's change, a change not pending or not announced, and a second confirmation, through bare D1 writes; an early `active_from` on `guarded_changes` or `app_origins` without a confirmation refused. **Records:** one `origin.confirmed` ledger row listing every change, and the console `audit_log` row; the notice sent once to the security alias, every contact and every owner, after the ack stored the removal links; the removal link removing the origin at once, single use, refused after 7 days, a GET of it removing nothing; the staff queue listing confirmed origins for 7 days; `confirmedAt` in the platform's view, never who confirmed. **The page:** nothing ticked at first, no "confirm all", Confirm hidden for an owner who isn't an on-chain owner. **Revocation:** a revocation, a switch-off and a freeze cancelling the key's waiting proposals in their own batch, with the ledger row, and an origin in force left as it is. **Timing:** an unconfirmed origin waiting 24 h on a dev env and its env's delay in a `local*` env; the proposal email's wait line saying 24 hours on sandbox-dev's config; the `local*` guard refusing a `local*` env with a non-loopback API or a deploy. **e2e:** a platform proposal, its email, the Confirm page, the fresh sign-in, the origin working at once, the notice, the removal link. **Staff proposals on a shared scope (four eyes, D917):** the proposing staffer's confirm refused (by the API and by a bare D1 write against the CHECK); a second staffer's confirm (another Access `sub` and email) brings it into force at once; an owner's confirm brings it into force at once; nobody: it waits 24 h; no waiver (`no_session`, `loopback`) and no expedite path, through AdminRpc and the CLI; the `second_person` flag written for a platform-created app and a flagged scope, not for other apps; the notice naming both people | **Yes** |
| P11 (later, proposed) | **The partner's page in our windows** (D926, from D923; not decided): when the vault is framed by a page other than its parent (the network's widget inside a partner's page), the sign-in and approval windows show the outermost page's origin (`location.ancestorOrigins` where the browser gives it; else, in Firefox, the app's one origin that isn't the widget's, when there is exactly one) beside or instead of the widget's. Why: today every partner's site shows the same address, the widget's (tested, D923) | S | The window's address in Chromium, Firefox and WebKit, framed and top-level; an app with two partner pages in Firefox falls back to the widget's address and says so | No |
| P12 (later, proposed) | **The widget's origin only as a frame** (D926, from D923; not decided): an origin marked frame-only for an app is accepted as the vault's parent only when another of the app's origins is around it, never top-level. Why: anyone can open the widget's own page with a partner's settings and get that partner's app (read in code, inferred, not tested). Needs a way to mark the origin (a flag on `app_origins`, proposed with it) | S to M | Top-level on a frame-only origin refused (`vault_unavailable`); framed by a listed partner page accepted; the flag can only be set with the origin's own proposal | Yes |

**Order:** P0 and P1 first (either order), then P2, P3, P4, P5, P10; P6 and P7 after P0, in parallel with Part A. P11 and P12 are proposals, not decided (D926); if taken up, after P4, before a partner on the network's widget handles real money.
Deploy order for each env: the API migration (with its Time Travel bookmark and comparison), then the API, then the
admin and console Workers. The platform switch stays off for every org until P0 is deployed, the platform minimum
(P4) and the owner's confirmation (P10) are built, reviewed and deployed, and, per N6, the "also used on other apps"
line has shipped.

## What the network builds on its side

1. **A signing key** (ECDSA P-256) per env in its cloud KMS or HSM, used only by its backend; the public key
   registered by one of its on-chain owners in our partner portal, or sent to Journear staff and then accepted by its
   owner. On a real-money setup a second owner confirms a new key, or it waits 24 h; so the network should have at
   least two owners, and keep **a second key registered and in force as a standby**, so an urgent rotation needs no
   wait at all (A3).
2. **The request signer** (the canonical message, plain ES256, the DER-to-raw conversion if its KMS answers DER, a
   fresh nonce, the timestamp from a synchronised clock) and an `Idempotency-Key` per operation, resent unchanged on
   retries from the same key.
3. **Its portal switch:** on → create the partner's app with its exact HTTPS origins after checking the partner
   controls them (and, for a partner on the network's widget, the widget's origin too, A13); store the app id and publishable key in the partner's configuration; show "Waiting for your owner
   to confirm, or live on {date}" from each origin's `activeFrom` (A10), then "Live". Off → suspend. A partner leaving or its domain lapsing → remove its origins at once.
4. **Its SDK:** load our SDK only when the switch is on and create the client with the partner's publishable key
   (`docs/sodax-sdk-integration.md` section 2, including its Stellar wallet-kit change; a worked add-on is in the
   sample-partner repository, `examples/sodax-wallet-kit/`). Switching a partner off drops our wallet from its lists
   and doesn't sign users out; suspending the app does (A10).
5. **Security contacts and owners** who read our announcements and use the cancel link when a change isn't theirs;
   and owners (on-chain owners of the scope, A15) who confirm each new partner address in our partner portal once
   they have checked it is the partner's, or leave it to come into force after the 24 h wait.
6. **Support:** partners' questions about one person go to the network, whose owners use our portal's linking view;
   the network doesn't give one partner another partner's ID (N7).
7. **Telling partners** that the user ID is their own per site, that addresses are shared across the network's sites,
   and to check `aud` on every token.

## Not in this version

Live apps through the platform (decided for later, with a separate key and its own review, N2); staff restore of
removed origins (refused, A14); a portal for partner companies or per-app access for members; per-app security
contacts; deleting apps through the platform; a user lookup from the network's backend (B6); changes to Passport
Home's app list beyond the line of B6; npm publishing and the core package's licence (parked, D913 point 4).
