# Partner platform: a network's backend API and per-app User IDs (build spec)

A **network** is an organisation that embeds our SDK in its own SDK and switches our sign-in on for its own partners
from its own partner portal (Sodax is the first, D909). This spec is what to build so that:

- **(A)** the network's backend can create and manage its partners' test apps on its own scope, through a
  service-to-service **platform API**, without a person signing in to our partner portal for each partner;
- **(B)** each partner app on the network's shared scope gets **its own User ID** in the identity token, while the
  network (the scope's owner) and Journear staff can still link one person's IDs when they need to diagnose a problem.

Status: **proposed, not built.** Decision: D913 in `decisions.md` (the Tech Lead's answers of 2026-11-24), on top of
D909 (one wallet across the network's partner sites). Built on the recommendation for who vouches for a partner's web
address; to be adjusted after the Tech Lead has talked to the network.

Last verified: 2026-11-24 (branch `docs/partner-platform-spec`, from `next` @ 6f51a033, docs only, not merged:
every "exists today" claim checked against the code at that commit).

How to read it: **Exists today** marks what the code does now, with the file it is in; **Proposed** marks what this
spec adds. Nothing here is built.

## 0. Summary

| | Proposed |
|---|---|
| Who calls | The network's backend only, with a request-signing key (ECDSA P-256) whose public half is registered with us for one organisation and its test scope |
| What it may do | Create a test app on its own scope; propose and remove web addresses; cancel its own waiting proposals; read an app and its publishable keys; suspend and resume its own apps; create and revoke publishable keys |
| What it may never do | Owners, Google clients or anything on chain; auto-approve policies; raw signing; the mainnet demo; partner labels; live apps; deleting apps; any other organisation's scope or app |
| Who vouches for a web address | The network, for every partner site it adds; each address waits our usual guarded-change delay (at least 24 h on a production network, 60 s on the dev testnet env) after it is announced to the organisation's security contacts and to Journear, with the usual cancel link |
| Off switches | Journear staff: revoke the network's key at once, switch the platform off for the organisation at once, suspend any one partner app at once (Journear's own bit, which the network can't clear) |
| Audit | Every call, reads included, is recorded; every write is also an `app_changes` row with the new actor kind `platform` |
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

**Origins as guarded changes.** Adding an origin is a guarded change (`guarded_changes`, kind `origin_add`, with an
`app_origins` row whose `active_from` is NULL until it is announced; `apps/api/src/changes/origins.ts`). Staff
proposals (`addOrigins`) wait `appChangeDelayMs` after a scope's assignment to an org (`conflict` otherwise). Member
proposals (`ConsoleRpc.changeOrigins`) carry a fresh Google sign-in of an on-chain owner of the scope, which the API
verifies itself (`apps/api/src/changes/step-up.ts`: signature, console audience, `iat` ≤ 300 s, nonce bound to the
exact change and `origins_version`, uncached on-chain owner check, single use in the `owner-actions:tokens` limiter).
At most 20 active or pending origins per app (`MAX_APP_ORIGINS`, `packages/console-core/src/origins.ts`). Removals are
immediate (`removeOrigins`).

**The lifecycle** (`apps/api/src/changes/lifecycle.ts`): the admin Worker's 5-minute cron reads
`AdminRpc.pendingNotices` (each with the org's `org_security_contacts`), emails the security alias and every security
contact with a cancel link, and only then calls `ackNotice` (`system` actor only), which sets `active_from = now +
delayMs` and stores `sha256` of the cancel link's token (`apps/admin/src/notices.ts`). The delay is
`APP_CHANGE_DELAY_MS`: at least 60 s anywhere, at least 24 h on the production network
(`apps/api/src/guarded/config.ts`); sandbox-dev's manifest sets 60 s (`envs/sandbox-dev.json` `appChangeDelayMs`). A
change can be cancelled until it is in force by an owner (`ConsoleRpc.cancelChange`), by staff, or by the emailed link
(`cancelChangeByLink`, actor `link`). Two waivers exist, both only for `member` or `hana` proposals: `loopback` (a
member's loopback origin on a test scope in a dev env) and `no_session` (a scope nobody has used yet). Expedite is for
member proposals only (`expediteChange`). The hourly job cancels a change not announced within 7 days and records
activations (`apps/api/src/guarded/cron.ts`). The notice email names the proposer as "Journear staff", "a console
member" or "the system" (`apps/admin/src/email/messages.ts`, the "Proposed by" row).

**Writes and audit.** Every RPC write is one D1 batch whose first statement inserts its `app_changes` row
(compare-and-swap; `request_id` UNIQUE gives idempotency: a replay is `already_applied`, a reused id for another write
`conflict`; `apps/api/src/changes/cas.ts`). `app_changes` is append-only for 60 months (triggers in 0006). Its
`actor_kind` is CHECKed to `member`, `hana`, `system`, `link`, and `guarded_changes.proposed_by_kind` to `member`,
`hana`, `system` (0006); `ACTOR_KINDS` and `PROPOSER_KINDS` in `packages/console-core/src/types.ts` say the same. The
console's own `audit_log` (`apps/console/migrations/0001_init.sql`) records its members' actions; the console's Audit
page merges it with the API's `app_changes`.

**Admission.** `ConsoleRpc` calls are admitted by per-org and global token buckets with a reserve only kill switches
may spend, and a destructive-call breaker (5 per org and 20 across orgs per rolling hour) (`apps/api/src/changes/guard.ts`,
`apps/api/src/rpc/common.ts` `runRpc`). `AdminRpc` is neither counted nor charged. The `RateLimiter` Durable Object
(`apps/api/src/rate-limiter.ts`) offers fixed and sliding windows (`hit`, `hitSliding`) and single-use reservations
(`reserve`, `release`), already used for single-use tokens and proofs.

**Keys and suspension.** Publishable keys `pk_test_`/`pk_live_` + base58, at most 5 unrevoked per app, rotation keeps
the old key 24 h, revoke is immediate and may revoke the last key (`apps/api/src/changes/keys.ts`). Keys are public:
"There is no secret-key (`sk_…`) auth anywhere: publishable keys are public and origins gate them" (`docs/api.md`,
Routing). Suspension is a bitmask: Journear 1 (per app), org 2 (every app of an org, Journear), partner 4 (the
console's owners); only Journear clears 1 and 2 (`apps/api/src/changes/suspension.ts`). In the console, resuming needs a
fresh sign-in (`pending_actions` kind `app.resume`, `apps/console/migrations/0001_init.sql`).

**The console's people.** An org's members are `owner` or `viewer` (`members`, console migration 0001); a member sees
every app and every user of every scope of the org: per-app access doesn't exist (`docs/sodax-sdk-integration.md`
section 4, gap 3). Security contacts are per org, set by Journear staff only (`setSecurityContacts`,
`changes/admin.ts`). New step-up kinds have been added before by rebuilding `pending_actions`
(`apps/console/migrations/0004_label_step_ups.sql`).

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
leaks.

**Passport Home's apps.** `GET /v1/home/apps` lists, per scope, the apps that have had a login, at most 10 apps per
scope in one answer (`HOME_APPS_PER_SCOPE`, `apps/api/src/home/apps.ts`).

**Not there today:** any service-to-service caller, any `platform` actor, any per-app User ID, any record of which
apps of a scope a person has used.

---

# Part A: the platform API

## A1. What it may do, and never

| May (each only on apps of the credential's own org, on a scope the credential names, test scopes only) | Never |
|---|---|
| Create a test app (name, first origins) on the scope | Create a scope, or an app on a live scope or another org's scope |
| Read an app: name, status, origins, its waiting and in-force origin changes, its publishable keys | Read settings beyond those (no policy, raw signing, mainnet demo, labels, Google client) |
| Propose origin additions (guarded changes) | Any waiver; expedite |
| Remove origins (immediate) | Owners, Google clients, shared login, anything on chain |
| Cancel its organisation's own waiting origin proposals | Cancel a change it can't see |
| Suspend an app (the partner bit 4) and resume it (only a suspension the platform set, A4) | Clear Journear's bits 1 or 2, or a member's suspension |
| Create and revoke publishable keys | Delete an app (staff only) |
| Read its own credential's status; revoke its own key | Register or reactivate any key |
| | Auto-approve policies, raw signing, the mainnet demo (D428: a staff switch per partner app, D913 point 2), partner labels, email-sharing or session settings, logos, renames after creation |

Live apps: not in this version. A live app for a network partner is created by Journear staff, as today, until live
keys exist and the Tech Lead decides otherwise.

## A2. Threat model

| Threat | What it could give | What stops or bounds it |
|---|---|---|
| **A stolen platform credential** (the network's private key) | Create test apps under the network's name; propose look-alike origins; remove origins, suspend apps and revoke publishable keys of every partner (denial of service); read publishable keys (public anyway) | Every origin it adds waits the full delay after an email to the org's security contacts and to Journear, cancellable from the email; creation and proposal quotas (A5); the destructive-call breaker; staff revoke the key or switch the platform off for the org at once; anomaly events to staff (A7, `security_events`); a re-add of an origin it removed can be restored by staff without the wait (A6, open question 8). It can never touch owners, the chain, policies, raw signing, the mainnet demo or labels, so it can't move or sign anything on its own |
| **A malicious or compromised partner site** (one of the network's partners) | On a shared wallet: ask any of the scope's users to approve moves from the one wallet, from its own origin | Unchanged by this spec: the user's approval window names the app and its web address; the "also used on other apps" line (being built on another branch); auto-approve, raw signing and the mainnet demo stay off for apps on a shared scope (`docs/sodax-sdk-integration.md` section 4); staff suspend the app at once (bit 1); the network removes its origins at once. A partner has no platform key and no console |
| **A malicious network insider** | Everything a stolen credential gives; with console access as an owner, also the cancel links and the linking view (Part B) | Origin additions also notify Journear, and staff see every platform proposal on the admin portal's queue; key registration by an owner waits the delay with its own announcement; every call is audited where the network's other owners and Journear see it; per-app suspensions by Journear can't be undone by the network |
| **Replay** of a captured request | Repeat a write | Each request is signed over its method, path, body hash, key id, time and a single-use nonce; ±60 s clock window; the nonce is reserved until the window ends (A3); writes also carry an idempotency key (A9) |
| **Confused deputy between orgs** | Network X acting on network Y's app, or a credential's scope list naming another org's scope | The org comes only from the credential, never from the request; every query filters on that org and on the credential's scopes (the existing `WHERE org_id = ?` of `changes/`); another org's app is `not_found`, exactly like an app that doesn't exist; a key's scopes are checked against `scopes.org_id` at registration and at every call |
| **Enumeration** (of apps, changes, keys, credentials) | Learn other orgs' app ids or which key ids exist | Ids are random (`newId`); unknown and foreign ids answer the same `not_found`; every authentication failure answers the same `401 unauthenticated`; per-IP limits before the signature check and per-key limits after it |
| **App creation abused to phish under the network's name** | An app named like the network or a known partner, with an attacker's origin | The origin waits the delay with the announcement (the notice shows the origin, its decoded form and the internationalised-domain warning that exists today); app names pass `normalisePartnerAppName` (`packages/console-core/src/names.ts`: Journear's names and the reviewed lists refused) and, new, a name that reads like another app's name on the same scope is refused (the look-alike skeleton the labels already use); creation quotas; staff see every platform-created app |
| **Origin takeover of an expired domain** | A partner lets its domain lapse; someone else registers it and serves a page on an origin that is still allowed on the shared wallet | The network must remove a partner's origins when it leaves (A13); the platform's read shows each origin's age; proposed piece P9 reports origins with no sign-in for 60 days to the network and to staff (open question 9); HTTPS-only origins (`originProblem`, unchanged); staff suspend at once |
| **A leaked request log** at the network or in transit | A captured signed request | No bearer secret in any header; the signature covers the body and a single-use nonce, so a logged request can't be reused or altered |
| **Our D1 read by an attacker** | The registered public keys and the call log | Public keys sign nothing; nothing secret of the network is stored on our side |
| **Flooding the platform route** | Spend the hot DB or the limiter objects | Per-IP limit before any D1 or signature work; per-key limits; the org's own bucket under the global one with the kill-switch reserve (A5) |

## A3. Authentication

### Options compared

| | **1. Per-org asymmetric request signing** (recommended) | **2. OAuth 2.0 client credentials** (a client id and secret, or `private_key_jwt`, for a short-lived bearer access token) | 3. Mutual TLS |
|---|---|---|---|
| Secret on our side | None: we hold only public keys | A client secret's hash (secret variant); for `private_key_jwt`, a public key, plus our own new access-token signing key to protect | A CA or pinned certificates |
| What a leaked request or log gives | Nothing reusable: each request is signed over its body and a single-use nonce | The bearer access token: every call it allows until it expires (minutes), from anywhere | Nothing |
| Body integrity | Yes, the body hash is signed | No (TLS only) | No (TLS only) |
| Replay protection | Built in (time and nonce) | Only by short token life | n/a |
| Moving parts on our side | One verifier on the route, a nonce reservation per request | A token endpoint, token minting and its key, token checks on every route | Certificate handling at Cloudflare's edge, which isn't on the free plan we stay on (D417) |
| Moving parts on the network's side | Sign each request (a small function; we ship a reference implementation and test vectors) | A standard OAuth client library | Certificates on every backend |
| Key in a cloud KMS or HSM | Yes (ECDSA P-256 is in every major KMS) | Yes for `private_key_jwt`; no for a secret | Usually |

**Recommended: option 1, ECDSA P-256 with SHA-256 (ES256), the algorithm our identity token already uses.** It
keeps the property our system has everywhere else, that no shared secret exists to leak from our database or a
request log, and it binds every request to its exact body, time and nonce. Option 2 was rejected because it adds a
bearer token that any log or proxy can replay for its lifetime and a token endpoint with its own signing key to
protect; option 3 because of certificate operations and its Cloudflare plan cost.

### The request

Every request carries four headers; writes also carry `Idempotency-Key` (A9).

| Header | Value |
|---|---|
| `Journear-Key-Id` | the credential's id, `pkc_…` |
| `Journear-Timestamp` | the network's clock, unix milliseconds, decimal |
| `Journear-Nonce` | 16 random bytes, base64url without padding (22 characters), never reused |
| `Journear-Signature` | ECDSA P-256 over SHA-256 of the message below, as 64 bytes `r ‖ s` (IEEE P1363), base64url (86 characters) |

The signed message is these lines joined by `\n` (0x0A), UTF-8, no trailing newline:

```
journear-platform-v1
<SIGNER_ACCOUNT of the env>          (names the env: a request for one env never verifies in another)
<HTTP method, uppercase>
<path and query exactly as sent>     (only [A-Za-z0-9/_?=&.-]: refused otherwise, so nothing needs normalising)
<Journear-Key-Id>
<Journear-Timestamp>
<Journear-Nonce>
<Idempotency-Key, or empty>
<sha256 of the body bytes, lowercase hex; of the empty string for a GET>
```

The API checks, in order, failing closed: (1) a per-IP limit (30 a minute, `platform:ip`), before anything is read;
(2) a request with an `Origin` header is refused (`403 browser_refused`): the platform API is never for browsers and
answers no CORS headers; (3) the headers' shapes; (4) the timestamp within ±60 s of the API's clock (else
`400 stale_request {serverTimeMs}`, which says only the time); (5) the key id names a credential in force (`active`,
`active_from <= now < expires_at`, not revoked) and the signature verifies with its public key (WebCrypto
`ECDSA`/`P-256`; a signature that isn't 64 bytes, or a high-S value, is refused); a failure of (3) or (5), whatever
the reason (unknown, revoked or expired key, bad signature), is the same `401 unauthenticated` with no detail;
(6) the org's platform switch is on (else `403 platform_off`, answered only to a valid signature); (7) the nonce,
reserved on the `RateLimiter` object `platform-nonce:<keyId>` until timestamp + 120 s (`reserve`, as the identity
token's proof markers are; a second use is `409 request_replayed`); (8) the per-key and per-org limits (A5). Only
then is the body parsed.

A reference signer (TypeScript, WebCrypto) and fixed test vectors (a key, three requests and their signatures) ship
with the network's guide, generated by an independent implementation as `packages/core/test/vectors/identity-v1.json`
is.

### Registration, rotation, revocation

A **credential** is one public key for one org and one or two of its test scopes, with a label. At most two
credentials in force or waiting per org, so one can replace the other.

**Registration** (a new kind of guarded change, A6), by either:

1. **Journear staff**, in the admin portal, after checking the key's thumbprint with the network out of band (a call
   or a signed message from a known contact); or
2. **an on-chain owner of the scope**, in our partner portal, with the existing fresh Google sign-in: a new step-up
   kind `platform.key_add` whose nonce covers the signer account, the org, the scopes, the key's RFC 7638 thumbprint
   and the label; the API verifies the token itself with `verifyStepUpToken` and `confirmStepUp`
   (`changes/step-up.ts`), unchanged.

Either way the credential is **pending**: announced by email to the org's security contacts and Journear's security
alias with a cancel link, and usable only `appChangeDelayMs` after that announcement (at least 24 h on a production
network). Staff can't skip the wait. The public key is checked to be a valid P-256 point and unique across all orgs.

**Expiry and rotation.** A credential expires 365 days after it comes into force (open question 3); the admin Worker
emails the security contacts 30 and 7 days before. To rotate, register the next key (it waits the delay), switch the
network's backend to it once it is in force, then revoke the old one.

**Revocation is immediate**, never delayed, by any of: Journear staff (admin portal, with a reason); an `owner` member
of the org in our partner portal (no fresh sign-in, as for revoking a publishable key: a kill switch); the credential
itself (`POST /v1/platform/credential/revoke`, so the network's own tooling can kill a key it believes leaked); and,
for the whole org, staff's **platform switch** (`platform_orgs.enabled = 0`), which refuses every key of the org at
once without revoking them. A revoked credential is never reactivated; its id is never reused.

**Where keys live.** The private key: in the network's cloud KMS or HSM, used by its backend only, never in a browser,
the network's SDK or its partners' pages, never sent to us. On our side: the public key (65-byte uncompressed point)
and its thumbprint in the hot D1 (`platform_keys`, A7). Nothing secret of the network is held by Journear.

## A4. Authorisation rules

1. **The org is the credential's.** No endpoint takes an org id. Every read and write runs the existing `changes/`
   functions with `orgId` = the credential's org, so every query keeps its `WHERE org_id = ?`.
2. **The scope must be one of the credential's**, a `test` scope, and still the org's (`scopes.org_id`); otherwise
   `not_found` (for an app on another scope) or `forbidden` (for a create naming a scope not on the credential).
3. **A frozen org** (`orgs.status = 'frozen'` in the console's D1, mirrored into `platform_orgs.frozen` by the admin
   Worker when staff freeze it) keeps only the kill switches: remove origins, suspend, revoke keys, revoke the
   credential, cancel. As the console does for its members (D356).
4. **Create** works only on an existing scope of the org whose `app_user_ids` flag is on (Part B): the platform never
   creates a scope, so no on-chain read is needed, and every app it creates gets per-app User IDs.
5. **Origin proposals** go through `proposeOrigins` with a `platform` proposer: no waiver (both waivers already
   require a `member` or `hana` proposer, `lifecycle.ts`), refused within `appChangeDelayMs` of the scope's assignment
   (as staff proposals are), every origin through `checkOriginRules` and the 20-per-app limit, unchanged.
6. **Resume** clears bit 4 only when the latest `suspension.set` of bit 4 on that app in `app_changes` has
   `actor_kind = 'platform'`; a suspension a console member set is `forbidden` to the platform (the member resumes it
   with a fresh sign-in, as today). Journear's bits 1 and 2 are never the platform's.
7. **Reads** answer an allowlisted view (A8): never settings outside it, staff identities, `proposer_sub`, Google
   `sub`s or the mainnet demo switch.
8. **Staff's per-app off switch** is the existing Journear bit 1 (`AdminRpc.setSuspended`), unchanged; the platform
   can neither see who set it nor clear it.

## A5. Limits and quotas

Provisional numbers, on the existing `RateLimiter` windows; the org's values can be raised by staff per org
(`platform_orgs`).

| Limit | Value | Where |
|---|---|---|
| Unauthenticated attempts per IP | 30 a minute | `platform:ip:<ipSubject>`, before any read |
| Requests per credential | 60 a minute, 5 000 a UTC day | `platform:key:<keyId>`, after the signature |
| Hot-DB budget | the org's own bucket (`platform:<orgId>`) under the existing global bucket, with the kill-switch reserve | `consoleAdmit` (`changes/guard.ts`), unchanged; the platform's bucket is separate from the org's members', so neither starves the other |
| Destructive calls (remove origins, suspend, revoke a publishable key) | 10 per org per rolling hour, its own breaker; a call that changed nothing gets its slot back | `consoleAdmit`'s breaker, its own key |
| Apps per org created by the platform | 50 undeleted (Passport Home lists 10 apps per scope today: open item in A11) | checked in the create batch |
| App creations | 5 an hour, 20 a UTC day per org | windows on `platform:<orgId>` |
| Origin proposals | 20 an hour, 100 a UTC day per org; at most 100 waiting (proposed, not yet in force) per org | windows, and a count in the proposal batch |
| Origins per app | 20 active or pending (`MAX_APP_ORIGINS`) | unchanged |
| Publishable keys per app | 5 unrevoked (`MAX_UNREVOKED_KEYS`) | unchanged |
| Credentials per org | 2 in force or waiting | registration |
| Body | 16 KiB | as app endpoints |

A quota refusal is `429 rate_limited` with `retry-after` and the window's name, or `409 app_limit` for the app count.
The first refusal of a quota in a clock hour writes a `platform_quota` security event (once, as `breaker` events are
written today), which the admin Worker emails to staff. Ten or more `401`s in a minute for a known key id write a
`platform_auth_failures` event.

Cost on the free plan (D417, 10 ms CPU, 50 subrequests): a write is one signature check (WebCrypto), two limiter
calls (nonce, windows) and the existing plan read and batch; within the budget the console's writes already fit.

## A6. What is reused unchanged, and what is new

| Part | Reused unchanged | Changed | New |
|---|---|---|---|
| Origin additions | `proposeOrigins`, `guarded_changes` `origin_add`, `app_origins` with `active_from` NULL, `checkOriginRules`, `MAX_APP_ORIGINS` | `proposed_by_kind` gains `platform` (proposer id = the credential id) | — |
| Announcement | `pendingNotices` → the admin Worker's email to the security alias and every security contact → `ackNotice` (the `system` actor) with the cancel link's hash; the 7-day lapse; activation by the hourly job | The email's "Proposed by" row reads "your platform key "{label}" ({pkc_…})" for `platform` (`apps/admin/src/email/messages.ts`) | — |
| Delay | `APP_CHANGE_DELAY_MS`: ≥ 24 h on a production network, 60 s on sandbox-dev; no waiver for a platform proposal | — | — |
| Cancel | `cancelChange` (an owner, staff), `cancelChangeByLink` (the email) | The platform may cancel its org's waiting changes (`cancelChange` with the platform actor) | — |
| Expedite | Member proposals only, as today | Proposed (open question 8): staff may expedite a platform re-add of an origin that was in force on the same app within the last 7 days, with a reason, to undo a stolen key's removals | — |
| Removals, suspension, keys | `removeOrigins`, `setSuspensionBit` (bit 4), `createKey`, `revokeKey` | The resume rule (A4.6) | — |
| App creation | The body of `createApp` (name rules, first key, origins as proposals, `app.created`) | A platform variant on an existing scope only: no scope creation, no on-chain owner read, never a waiver, the look-alike name check | — |
| Ledger | `app_changes` with its kinds (`app.created`, `origin.proposed`, `origin.removed`, `change.cancelled`, `suspension.set`, `suspension.cleared`, `key.created`, `key.revoked`) | `actor_kind` gains `platform` (actor id = the credential id) | Kinds `platform.key_proposed`, `platform.key_announced`, `platform.key_cancelled`, `platform.key_active`, `platform.key_revoked`, `platform.org_switch` (org-level rows, `app_id` NULL), each with an audit title in `APP_CHANGE_KINDS` (D704) |
| Credential registration | The step-up verification (`changes/step-up.ts`); the notice email and cancel-link machinery (`linkToken`, `CANCEL_LINK_KEY`) | Console `pending_actions` gains the kinds `platform.key_add` and `platform.key_revoke` (a rebuild, as migration 0004 did) | A guarded change of its own kind, held in `platform_keys` (keys belong to an org, not an app, so `guarded_changes`, whose `app_id` is required, can't hold it): `AdminRpc.platformKeyNotices` → email → `ackPlatformKeyNotice`; cancel by an owner, staff or the link (`/cancel-platform-key/:id#t=` on the console) |
| Security events | The admin Worker's email of `security_events` | — | Kinds `platform_quota`, `platform_auth_failures` |
| Call log | — | — | `platform_calls`: every call, reads included |

## A7. Data model and migrations

API D1, one migration (the next free number when built; `0026` on `next` today):

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
  status            TEXT NOT NULL CHECK (status IN ('pending', 'active', 'cancelled', 'revoked')),
  proposed_by_kind  TEXT NOT NULL CHECK (proposed_by_kind IN ('hana', 'member')),
  proposed_by       TEXT NOT NULL,
  proposer_sub      TEXT,                                 -- the verified step-up's sub, for a member
  proposed_at       INTEGER NOT NULL,
  notified_at       INTEGER,
  active_from       INTEGER,                              -- notified_at + appChangeDelayMs
  expires_at        INTEGER,                              -- active_from + 365 days
  cancel_token_hash BLOB UNIQUE,
  cancelled_at      INTEGER, cancelled_by TEXT,
  revoked_at        INTEGER, revoked_by_kind TEXT, revoked_by TEXT, revoke_reason TEXT,
  last_used_at      INTEGER,                              -- written at most once an hour per key
  request_id        TEXT NOT NULL
);
-- Staff's per-org switch and quotas (a missing row: off).
CREATE TABLE platform_orgs (
  org_id TEXT PRIMARY KEY, enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)), frozen INTEGER NOT NULL DEFAULT 0,
  max_apps INTEGER NOT NULL DEFAULT 50, creations_per_day INTEGER NOT NULL DEFAULT 20,
  proposals_per_day INTEGER NOT NULL DEFAULT 100, set_by TEXT NOT NULL, set_at INTEGER NOT NULL
);
-- Idempotency (A9): kept 7 days.
CREATE TABLE platform_requests (
  org_id TEXT NOT NULL, idem_hash TEXT NOT NULL, key_id TEXT NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
  body_sha256 TEXT NOT NULL, request_id TEXT NOT NULL, at INTEGER NOT NULL,
  PRIMARY KEY (org_id, idem_hash)
);
-- Every call (reads too): kept 13 months, purged by the monthly retention job.
CREATE TABLE platform_calls (
  seq INTEGER PRIMARY KEY, at INTEGER NOT NULL, org_id TEXT NOT NULL, key_id TEXT NOT NULL, method TEXT NOT NULL,
  route TEXT NOT NULL,                                    -- the route's template, e.g. /v1/platform/apps/:appId
  app_id TEXT, status INTEGER NOT NULL, code TEXT, request_id TEXT NOT NULL, ip_prefix TEXT
);
CREATE INDEX platform_calls_org ON platform_calls (org_id, seq);
-- Apps the platform created (the console's badge, the quota count).
ALTER TABLE apps ADD COLUMN created_by_kind TEXT NOT NULL DEFAULT 'hana' CHECK (created_by_kind IN ('hana', 'platform'));
```

**Widening the actor CHECKs.** `app_changes.actor_kind` and `guarded_changes.proposed_by_kind` are CHECKed in 0006,
and SQLite can't widen a CHECK in place, so both tables are rebuilt in the same migration with every row kept: `seq`
copied as is (the admin Worker's feed reads `changesSince(seq)`), the indexes and the two append-only triggers of
`app_changes` recreated. Neither table is referenced by a foreign key, and a `DROP TABLE` fires no trigger, so the
rebuild deletes nothing elsewhere (unlike `apps`, which must never be rebuilt: 0006's header). `security_events.kind`
gains the two new kinds the same way, as migrations 0018 to 0025 did. The migration's test applies it to a copy with
rows in every table and checks every row, `seq`, trigger and index survives. Rejected: recording the platform as
`system` or `hana` (a ledger that misnames its actor).

Console D1: `pending_actions` rebuilt with the two new step-up kinds (as 0004). `console-core`: `ACTOR_KINDS` and
`PROPOSER_KINDS` gain `platform`; the console's Audit renders it.

## A8. Endpoints

`{API}/v1/platform/…` on the API Worker (`src/platform/`, one new route in `src/index.ts`; `fetch` serves `/v1/*`
today). JSON bodies, camelCase; success `{…fields, requestId}`; error `{error, code, requestId, …}`, as `docs/api.md`
"Conventions". RpcCodes keep their statuses (`RPC_HTTP_STATUS`, `packages/console-core/src/types.ts`). Every request
needs the A3 headers; every `POST` that writes needs `Idempotency-Key`.

**Codes every endpoint can answer:** `401 unauthenticated`, `400 stale_request {serverTimeMs}`,
`409 request_replayed`, `403 platform_off`, `403 browser_refused`, `400 bad_request`, `429 rate_limited`
(+ `retry-after`), `503 rate_limiter_unavailable`, `500 internal`. Writes also: `409 idempotency_conflict`,
`409 version_conflict`, `403 forbidden` (a frozen org's non-kill-switch write, or A4.6).

**The app view** (`PlatformApp`), an allowlist:

```json
{ "id": "app_…", "name": "…", "scopeId": "…", "environment": "test", "createdBy": "platform", "createdAt": 0,
  "userIds": "app",
  "suspended": { "byJournear": false, "byOrganisation": false, "byYou": false, "youCanResume": false },
  "originsVersion": 3,
  "origins": [ { "origin": "https://…", "display": "https://…", "idn": false,
                 "state": "waiting_announcement | waiting | active", "activeFrom": 0, "changeId": "gc_…" } ],
  "keys": [ { "id": "key_…", "key": "pk_test_…", "createdAt": 0, "revokedAt": 0 } ] }
```

`byJournear` covers bits 1 and 2 together (the network learns that Journear stopped the app, not why). No settings,
no policy, no mainnet demo, no labels, no staff identities.

| Endpoint | Body | Answer | Codes beyond the common ones |
|---|---|---|---|
| `GET /v1/platform/credential` | — | `{keyId, label, orgId, scopes, activeFrom, expiresAt, limits}` | — |
| `POST /v1/platform/credential/revoke` | `{reason?}` (≤ 200 characters) | `{revokedAt}`; the key stops at once | — |
| `POST /v1/platform/apps` | `{scopeId, name, origins?: [≤ 20]}` | `201 {app, publishableKey, changes: [{changeId, origin}]}` | `forbidden` (scope not on the key, or its `app_user_ids` off), `origin_refused`, `conflict` (scope assigned less than the delay ago; a name like another app's), `409 app_limit`, `no_security_contact` |
| `GET /v1/platform/apps?scopeId=&cursor=` | — | `{apps: [PlatformApp], next?}` (50 a page) | `forbidden` |
| `GET /v1/platform/apps/:appId` | — | `{app}` | `not_found` |
| `POST /v1/platform/apps/:appId/origins` | `{add: [≤ 20], expectedVersion}` | `202 {version, changes: [{changeId, origin}]}`; each waits for its announcement and then the delay | `not_found`, `origin_refused`, `conflict` (duplicate, more than 20, scope assigned less than the delay ago) |
| `POST /v1/platform/apps/:appId/origins/remove` | `{remove: [≤ 20], expectedVersion}` | `{version}`; immediate | `not_found`, `bad_request` (not an origin of the app) |
| `POST /v1/platform/changes/:changeId/cancel` | — | `{change}` | `not_found`, `not_pending` |
| `POST /v1/platform/apps/:appId/suspend` | `{suspended: true \| false}` | `{suspended}` (the view's object) | `not_found`, `forbidden` (A4.6) |
| `POST /v1/platform/apps/:appId/keys` | — | `201 {key}` | `not_found`, `key_limit` |
| `POST /v1/platform/apps/:appId/keys/:keyId/revoke` | — | `{warning?: 'last_key'}` | `not_found`, `conflict` (already revoked) |

Each write maps to the existing function with `Writer.actor = {kind: 'platform', id: <pkc_…>}` and `orgId` = the
credential's org: `createApp` (its platform variant), `proposeOrigins`, `removeOrigins`, `cancelChange`,
`setSuspensionBit(bit 4)`, `createKey`, `revokeKey`. Rotation is not offered: create a key, switch the network's
configuration to it, then revoke the old one.

Staff and console methods (RPC, no route): `AdminRpc.registerPlatformKey`, `revokePlatformKey`, `listPlatformKeys`,
`setPlatformOrg`, `platformKeyNotices`, `ackPlatformKeyNotice` (`system` only), `cancelPlatformKey`, `platformCalls`;
`ConsoleRpc.listPlatformKeys`, `proposePlatformKey` (with `stepUpJwt`), `revokePlatformKey` (owner, kill switch),
`cancelPlatformKey`, `cancelPlatformKeyByLink` (`link` actor), `platformCalls`. Their full shapes go in `docs/api.md`
when built.

## A9. Idempotency

- Every write needs `Idempotency-Key` (8 to 64 of `[A-Za-z0-9_-]`), chosen by the network once per logical operation
  and resent unchanged with every retry (each retry has a new nonce and signature).
- The API derives the write's `request_id` as `pf_` + base64url(sha256(org id ‖ 0x00 ‖ Idempotency-Key))[0..32], so
  two orgs' keys never collide, and records `(org, sha256(key), method, path, sha256(body))` in `platform_requests`
  in the same batch.
- A retry with the same key, method, path and body: the write isn't repeated (`app_changes.request_id` is UNIQUE,
  `cas.ts`); the API answers `200` with the current state and `"replayed": true` (for a create: the app it created,
  found through its `app_changes` row).
- The same key with another method, path or body: `409 idempotency_conflict`.
- Kept 7 days; a key reused after that is a new operation.

## A10. How the network's SDK gets each partner's key at run time

1. The network's portal switch, when a partner turns our sign-in on, makes the network's backend call
   `POST /v1/platform/apps` with the partner's name and site, and stores the answer's `app.id` and `publishableKey`
   in the partner's configuration on the network's side.
2. The network's SDK, on the partner's page, reads the partner's configuration from the network's own configuration
   service (as it reads its other partner settings) and, only when the switch is on, loads `@hana-id/web` and calls
   `createHana({ publishableKey, environment: 'test', evm, stellar })` (`docs/sodax-sdk-integration.md` section 2,
   unchanged).
3. The key is public; what protects it is the app's allowed origins. The platform API is never called from a page: it
   refuses any request with an `Origin` header.
4. Until the partner's origin is in force (about 24 h on a production network), our sign-in refuses the partner's
   site (`origin_not_allowed`); the network's portal should show "Goes live on {date}" from the app's `activeFrom`.
5. Switching off: the network calls `suspend` (logins stop at once; open pages notice within 30 s, as today). On a
   key rotation, the network creates a key, publishes it in its configuration, and revokes the old key once its
   caches have turned over.

## A11. What the console and the admin portal show

**Our partner portal, for the network's members** (`apps/console`):

- An org page **Platform keys**: each key's label, thumbprint, scopes, state (waiting with its date, in force,
  expiring, revoked, cancelled), who registered it, when it was last used; **Register a key** (owners, fresh sign-in,
  step-up kind `platform.key_add`), **Revoke** (owners, immediate), **Cancel** for a waiting one.
- **Platform activity**: the `platform_calls` rows of the org (time, key, route, app, outcome, request id), filterable
  by app.
- On each app: "Created by your platform key {label}" for an app the platform made; platform rows in the Audit with
  the key's label as the actor; origin changes proposed by the platform marked as such.
- The Users screen changes of Part B (B6).

**Partner companies get no portal of their own in this version.** A member of the network's org sees every app and
user of the org (per-app access doesn't exist, `docs/sodax-sdk-integration.md` section 4, gap 3), so no network
partner is invited to it. Security notices go to the network's security contacts only; the network tells its partner.

**The staff admin portal** (`apps/admin`):

- On the org: the platform switch (on/off, immediate, with a reason) and the org's quotas; the keys with **Register**
  (after the out-of-band check), **Revoke**, **Cancel**; the last use and the call counts; the activity.
- A platform queue: every waiting origin proposal and key registration made by or for a platform, across orgs, with
  its origin, app and time left, so staff see each one before it is in force.
- On each app: "Created by the platform"; the existing per-app suspension (bit 1), the mainnet demo switch (staff only,
  D428, D913 point 2) and delete, unchanged.
- The two new security event kinds in the existing security feed, each with a playbook (`packages/playbooks`).

**Open item, not in this spec:** Passport Home shows at most 10 apps per scope (`HOME_APPS_PER_SCOPE`), and the
sign-in windows' "also used on other apps" line is being built on another branch. A network with dozens of partners
needs Home to list the apps a person actually used first; that is Home's change to make.

## A12. On chain, and address impact

Nothing in Part A touches the contract or calls NEAR: the platform creates apps only on existing scopes (no
`get_scope` read, no `admin_register_scope`), and never makes an owner action. The credential and its checks are
off chain. No key, path or address derivation changes. **Address impact: none.**

## A13. What the network vouches for

The recommendation the Tech Lead asked to build on (D913 point 6): the network is the customer and the scope's owner,
so it vouches for every partner site it adds. Concretely the network, before calling `origins`, checks that the
partner controls the domain (its own process: for example a DNS record or a file on the site), adds only the
partner's exact HTTPS origins, and removes them as soon as the partner leaves or its domain lapses. Journear's backstops
are the delay, the announcement and cancel link, the staff queue, the off switches and the audit.

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
- It is the usual practice for one login service serving many relying parties (OpenID's pairwise subject).
- If the network later gives some partners their own wallets (their own scopes), nothing built on a shared `sub` has
  to be undone.

What they don't do: give users privacy between the network's partners. Matching by address stays possible and can't
be prevented while the wallet is shared; only separate wallets (separate scopes) would, which D909 decided against.

**Does this change the recommendation?** No: build per-app IDs (D913 point 3), because they are cheap and remove the
easiest join, but describe them to partners and users as "an ID of your own for each person", never as privacy
between sites. The sign-in windows' "also used on other apps" line (another branch) is what tells users the wallet is
shared. Open question 6 asks the Tech Lead to confirm with this caveat in view.

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
  the layout is pinned by test vectors from an independent implementation (`scripts/gen-identity-vectors.mjs`, as
  for `sub` and `sid`).

## B3. Which apps get it, and what stays exactly as it is

Proposed:

- **A scope flag** `scopes.app_user_ids` (0 or 1, default 0), set by Journear staff only (`AdminRpc.setScopeAppUserIds`,
  with an `app_changes` row `scope.app_user_ids`), one way: once on, it stays on.
- **An app column** `apps.user_ids` (`'scope'` or `'app'`, default `'scope'`), set once when the app is created:
  `'app'` when its scope's flag is on at that moment, `'scope'` otherwise. A trigger refuses any later change of
  `user_ids`, and of `scope_id` for an `'app'` app (the derivation includes both).
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

For an `'app'` app the Support ID becomes the short form of its `appSub`, so `hana.supportId` on the partner's page
equals `supportIdFromSub(token.sub)` in the partner's backend, as the partner guide promises: `sessionSupportId`
(`directory/store.ts`) takes the app and uses its mode. Two partners then see different Support IDs for one person,
which removes the second join key. The user still reads one code to whoever helps them; staff and the network
resolve both forms (B6). Open question 7.

## B5. Partners verifying tokens

Nothing changes in how a token is verified: one issuer per env (`iss`), the same JWKS (`{iss}/jwks.json`), the same
`typ`, `alg` and lifetime, `aud` = the app id as today, no new claim (the spec's "no other claim" promise, D760,
holds). What changes is the meaning of `sub` for an `'app'` app: unique per (`iss`, `aud`) instead of per scope. A
partner keys its users on `sub` within its app as today. A partner that wants one ID across two of its own sites uses
one app with both origins, not two apps. `docs/integration.md` says so when built.

## B6. Linking: who may see one person's IDs across the network's apps

**Who may:** the scope's owning organisation (the network) and Journear staff. Not partners: their IDs can't be
turned into each other's without our key, and they have no portal and no platform key.

**Proposed for this version:**

1. **In our partner portal, for the network's owners.** The Users screen of an `app_user_ids` scope lists people (by
   the scope-level User ID, labelled "User ID (all your apps)"). A person's page gains "This person on your apps": one
   row per app of the org on that scope where the person has signed in, with the app's name, that app's User ID and
   Support ID, first and last sign-in. Search accepts any per-app User ID or Support ID as well as today's forms.
   - Authenticated by the console's existing sign-in and membership; the cross-app panel and the per-app search are
     for `owner` members only (open question 5); viewers keep today's screen.
   - Audited: every opening of the panel and every per-app search writes a console `audit_log` row
     (`users.link_view`, target the scope-level User ID, no other identifier), shown on the org's Audit page.
   - Limited: 60 a member an hour, 300 a day (`console-link:<user id>`), 1 000 an org a day, `rate_limited` past them.
   - Returns: app names and ids, the per-app User IDs and Support IDs, times. No email beyond what the Users screen
     already shows, no Google `sub`, no internal id.
2. **In the staff admin portal.** The Support lookup (`AdminRpc.supportLookup`, `apps/admin/src/support.ts`) resolves
   per-app User IDs and Support IDs to the person and lists every app with that app's IDs; audited as staff lookups
   already are (D394).
3. **Not in this version: a lookup from the network's backend** through the platform API
   (`POST /v1/platform/users/lookup {appId, userId | supportId}` → the person's apps and IDs). It would let a backend
   correlate in bulk; a person diagnosing one user needs only the portal. Specified here so it can be added later with
   the same rules plus a `platform_calls` row and its own limits (open question 4).

**How the lookup works.** The forward direction (person → each app's ID) is computed from `end_users.token_sub` and
the app id (B2). The reverse direction (an app's ID → person) needs a record, proposed below: when a person signs in
on an app of an `app_user_ids` scope, the directory's existing write after login (`directory/sync.ts`
`syncAfterLogin`, `/v1/wallets/record`) also upserts one row for (person, app). That row is also what tells the panel
which apps the person used.

**Privacy note.** The network can then see which of its partner sites a person used. The network is the scope's owner
and its portal already lists the scope's users; this adds the per-site view. Open question 10 asks whether Passport
Home should say so to users.

## B7. Data model and migration

API D1, in the same migration as A7 or its own (the next free number):

```sql
ALTER TABLE scopes ADD COLUMN app_user_ids INTEGER NOT NULL DEFAULT 0 CHECK (app_user_ids IN (0, 1));
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
CREATE INDEX end_user_apps_sub ON end_user_apps (app_sub);
CREATE INDEX end_user_apps_support ON end_user_apps (support_code);
```

`createApp` (staff and platform) writes `user_ids` from the scope's flag in its batch. The new table is purged with the
directory (the retention job's `purgeDirectory`) and by the erase script (`scripts/lib/uid-erase.ts` deletes the
person's rows and, for email consents, already computes the scope-level User ID: unchanged). Nothing is backfilled:
existing apps are `'scope'`, and rows of `end_user_apps` appear from the first sign-in after the flag is on.

## B8. On chain, and address impact

Nothing in Part B touches the contract, a key, a path or an address: the per-app ID is an off-chain pseudonym computed
by the API at mint. **Address impact: none.** What becomes final when it ships is the per-app ID's layout (B2), which
partners will store.

---

## Open questions for the Tech Lead

1. Sign requests with ECDSA P-256 (the identity token's algorithm) only? **Recommend: yes.**
2. May the network's on-chain owners register a platform key themselves (it still waits the delay), besides staff?
   **Recommend: yes.**
3. Platform keys expire after one year? **Recommend: yes.**
4. A user lookup from the network's backend too, or only in our partner portal? **Recommend: portal only, for now.**
5. The cross-app view of one person: the network's owners only, not its viewers? **Recommend: owners only.**
6. Keep per-app User IDs, knowing partners can still match people by wallet address? **Recommend: yes.**
7. A per-app Support ID as well (each site sees its own code)? **Recommend: yes.**
8. Let staff restore, without the 24 h wait, an origin a stolen key removed (one in force on that app in the last 7
   days)? **Recommend: yes.**
9. Report a partner origin with no sign-in for 60 days to the network and staff? **Recommend: yes, as a later piece.**
10. Tell users in Passport Home that the network can see which of its sites they use? **Recommend: yes.**
11. Allow staff to expedite a new platform-proposed origin? **Recommend: no.**

## Build plan

Independently mergeable pieces, in order within each part. Part B doesn't depend on Part A; Part A's create needs
Part B's scope flag (A4.4), so P6 merges before P4 (or P4 ships with creates refused until it has). Each piece updates its
current-state docs (`docs/api.md`, `architecture.md`, `security.md`, `operations.md`, `integration.md` where it
applies) in the same branch. Sizes: S about 2 days, M about a week, with review.

| Piece | What | Size | Tests required | Independent security review |
|---|---|---|---|---|
| P1 | The `platform` actor: the migration's rebuilds of `app_changes`, `guarded_changes` and `security_events`; `ACTOR_KINDS`, `PROPOSER_KINDS`, audit titles; the notice email's "Proposed by" wording; the console's Audit rendering | S | The migration on a copy with rows in every table (rows, `seq`, triggers, indexes kept; an update of `app_changes` still refused); views and the email for each actor kind | No (reviewed with P3) |
| P2 | Credentials: `platform_keys`, `platform_orgs`; staff register, cancel, revoke and the switch (`AdminRpc`, admin portal); the owners' step-up kinds and the console's Platform keys page; notices, ack, cancel link, activation and expiry jobs; the new `app_changes` kinds | M | Registration by staff and by an owner (step-up nonce bound to the thumbprint, scopes and label; a token for another key refused); the delay and the waiver never applying; the link cancel; immediate revocation by each of the four routes; expiry; a key naming another org's scope refused | **Yes** |
| P3 | Request authentication and admission: the route, header checks, signature, clock, nonce, the no-browser rule, the per-IP, per-key and per-org limits, `platform_calls`, `GET /credential`, self-revoke | M | The test vectors from an independent implementation; every refusal in A3's order with its code; a replayed nonce; a request for another env; a body or path changed after signing; high-S and malformed signatures; the identical `401` for every authentication failure; timing of unknown versus known key ids | **Yes** |
| P4 | Operations: create (the platform variant, the look-alike name check, quotas), list, get (the allowlisted view), origins propose, remove and cancel, suspend and resume (A4.6), keys create and revoke; `platform_requests` | M | Each endpoint's success and refusals; every org and scope boundary (another org's app, change and key `not_found`; a scope not on the key); the resume rule; idempotency (a retry returns the first result; another body `idempotency_conflict`); the breaker and the reserve; a frozen org | **Yes** (with P3 if built together) |
| P5 | Screens: the console's Platform activity, app badges and Audit rows; the admin portal's org switch, quotas, platform queue and activity; playbooks for the two event kinds | M | Console and admin unit tests; an e2e run: register a key, create an app, propose an origin, see the notice and the queue, cancel from the link | No |
| P6 | Per-app User IDs: `appSub` in core with vectors; the scope flag and app column with their triggers; the mint, the session answers' Support ID; `end_user_apps` written after login; the erase script and retention | M | Vectors from the independent generator; an existing app's `sub` and Support ID unchanged across the migration; an `'app'` app's token `sub` and `hana.supportId` agreeing with `supportIdFromSub`; two apps of a flagged scope giving different IDs, one app on an unflagged scope giving today's; the triggers; erase and purge | **Yes** |
| P7 | Linking: the console's "This person on your apps" panel and per-app search (owners), its audit rows and limits; the staff Support lookup resolving per-app IDs | S to M | A viewer refused; another org's user `not_found`; every lookup audited before it answers; the limits; nothing beyond the listed fields in the answer | **Yes** (with P6) |
| P8 | The network's guide: a partner-facing document for the network (the request format, the reference signer, the vectors, every endpoint, the delay, the off switches), checked by the docs test that keeps partner guides free of repo paths | S | The guide's code samples run against the local stack | No |
| P9 (later, if open question 9 is yes) | An origin's last sign-in day (written at most once a day per origin) and the 60-day report; staff restore of removed origins (open question 8) | S each | As each needs | Yes for the restore |

Deploy order for each env: the API migration, then the API, then the admin and console Workers; the platform switch
stays off for every org until staff turn it on for one.

## What the network builds on its side

1. **A signing key** (ECDSA P-256) in its cloud KMS or HSM, used only by its backend; the public key sent to Journear
   staff, or registered by one of its on-chain owners in our partner portal; a second key for rotation.
2. **The request signer** (the canonical message, a fresh nonce, the timestamp from a synchronised clock) and an
   `Idempotency-Key` per operation, resent unchanged on retries.
3. **Its portal switch:** on → create the partner's app with its exact HTTPS origins after checking the partner
   controls them; store the app id and publishable key in the partner's configuration; show "goes live on {date}".
   Off → suspend. A partner leaving or its domain lapsing → remove its origins at once.
4. **Its SDK:** load our SDK only when the switch is on and create the client with the partner's publishable key
   (`docs/sodax-sdk-integration.md` section 2, including its Stellar wallet-kit change).
5. **Security contacts** who read our announcements and use the cancel link when a change isn't theirs.
6. **Support:** partners' questions about one person go to the network, whose owners use our portal's linking view;
   the network decides what to tell the partner.
7. **Telling partners** that the user ID is their own per site, and that addresses are shared across the network's
   sites.

## Not in this version

Live apps through the platform; a portal for partner companies or per-app access for members; per-app security
contacts; deleting apps through the platform; a user lookup from the network's backend (B6.3); changes to Passport
Home's app list; npm publishing and the core package's licence (parked, D913 point 4).
