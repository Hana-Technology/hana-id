# @hana-id/admin

The Journear Passport staff console ("Hana" in code: `hana-id-admin-<env>`, `docs/batch-c-spec.md` "Hana admin console"): a Cloudflare Worker on
`admin.origin` behind Cloudflare Access, serving a plain-JavaScript SPA (`public/`) and its `/api/*` backend. Every
`/api/*` request needs a valid Access JWT of an email on `admin.staffEmails` (checked in the Worker too, D88), then the
CSRF checks. It holds no D1 and no NEAR key: it calls the API's `AdminRpc` (`API`), the console's `StaffRpc`
(`CONSOLE`) and, for the Users screen, the email issuer's `DirectoryRpc` (`ISSUER`, C8b); it keeps its own state in the
usage ledger's `ops` schema (`USAGE_DB`, Hyperdrive, role `usage_admin`) and sends every email through SendGrid
(`@hana-id/sendgrid`, its own Mail-Send-only key `EMAIL_API_KEY`, D401).
**Not deployed** (milestone M4).

Reference: routes and crons in `docs/api.md` "Admin Worker"; setup, the crons' call budget, the Users screen's deploy
order and the runbooks in `docs/operations.md` "Admin Worker"; invariants in `docs/security.md` "Admin Worker";
decisions D278–D285 (C8), D320–D329 (C12), D330–D338 (C14), D360–D369 (C13), D380 (the call budget), D388–D392 (C8b).

## Screens

The left nav groups the screens by task (D420):

| Group | Screens |
|---|---|
| Overview | **Status** (D425): the landing page (`/`), every part of the env at a glance, below |
| Partners | **Organisations**: the list, "Invite a new partner" (a new organisation's first owner) and **Pending invites** (below); an organisation's members, invites, owner grants, "Register a scope for this organisation" (below), apps ("Create an app", "Move a legacy scope here"), security contacts, recent app changes and its danger zone (freeze, suspend every app); an app's suspension switches, allowed origins, guarded changes, signing settings, publishable keys and danger zone. **Legacy apps** (`org_legacy`) has its own page: its scopes, each with "Move to an organisation" |
| Support | **Users** (C8b), **Support ID lookup** (C15) |
| Security | **Security & monitoring**, **Feed and notices**, **Pending upgrades**, **Playbooks** (C14), **Audit log** (the console's rows, an org's app changes, the issuer's directory reads) |
| Email login | **Email issuer**: the window's totals in a stats strip, then tokens, mail with bounce and complaint rates, refusals by limit, alert occurrences per app and day, and the signer policy against the pins (batch 10's KMS figures say so). **Account links**: the totals in a stats strip, links per app and day, today against the 7-day median (build plan batch 9, D446, D448). Both pick their window (7, 14 or 31 days) with a segmented control (D765) |
| Money | **Reports**, **Statements**, **Rates** (C12) |
| System | **Retention** (C13) |

**Pending invites (D696).** An invite to a new organisation has no organisation page until its first owner accepts
(the organisation is created then), so the Organisations page lists these invites itself, above the organisations,
whenever there is at least one (and at once after "Invite a new partner" sends one, the page re-reads it): the
organisation's name (the invite id under it), its type, the invited address, the state in words (**Waiting for the
email to go out**, **Email sent, waiting for them to accept**, **Accepted**, **Revoked**, **Expired**, an ended one with
when it ended), when the email went out, when it expires, and **Revoke** on an open one (confirmed in the page; the
existing `POST /api/invites/:id/revoke`). Open invites, then those that ended in the last 30 days, at most 100
(`GET /api/invites/new-orgs`, `StaffRpc.newOrgInvites`). A failed read is said in the panel; the list still shows.
Invitations into an existing organisation stay on that organisation's page ("Invites", where Revoke is likewise on open
invites only: an expired one can't be revoked).

**After "Create an app"** the green "Created app_…" box with the publishable key stays where it is and the Apps table
above it is re-read and redrawn in place (the page isn't re-rendered, so the key isn't lost); if that read fails, the
box says to reload. **`passkeys_required`** (D242's gate, which the console applies on every network but testnet,
D698) reads "Only one partner organisation for now", with the real cause and the two ways on (revoke the open partner
invite, or choose type Internal).

**Times in emails (D697).** A time in a sentence reads as a date ("18 November 2026, 04:54 UTC", `readableTime` in
`src/email/render.ts`): the invite's expiry, in the body and the preview line, and the retention job's "was due at".
Tables and lists keep the exact ISO time (`isoTime`) in staff mails and in the digests' text part (each digest row's
`rowTime`, which shows an invalid time raw and flagged instead of throwing, D704), so it can be copied and compared;
the designed partner notices below show their table times in words too, and so does the digests' HTML part (D704).

**Names and look (D765).** Every partner and staff mail names the product "Journear Passport" and the service
"Journear": the subject prefix is `[Journear Passport <env>]` (after D419's label), the body's first line on a labelled
env "Not production: this email is from Journear Passport <env> (testnet), for testing.", and the small print "Sent by
Journear Passport security. Journear never asks you to approve anything from an email. To reach Journear security,
reply to this address or write to your Journear contact." The words are otherwise as before. The designed mails take
the Journear Passport design system's look from `@hana-id/brand/email` (teal primary, the teal-biased neutrals, 8 px
buttons, 12 px cards, the Journear lockup as the hosted logo, alt "Journear Passport").

**Partner security notices (D699, D700).** The pending change (every kind), the invite notice to owners and contacts,
the owner grant, the login-methods change and the on-chain proposal and change use the designed layout
(`render(..., design)`, `notice` in `src/email/messages.ts`): a fixed heading, D419's banner, the hosted logo, the
cancel or console link as the one button, every value as unlinked text. The pending change's subject names the change
("New allowed origin proposed for {app}", "Auto-approve policy proposed for {app}", "Raw signing proposed for {app}")
and its "Change" row reads "Add an allowed origin (gc_…)". The statement notice and the staff alerts keep the plain
HTML.

**The feed's digests (D704).** `changesDigest`, `auditDigest` and `securityDigest` use the same layout with fixed
headings ("Changes to your apps", "Console activity", "Security events were recorded", singular forms for one row)
and no link. Their rows are a `rows` block (`src/email/render.ts`): each row's one line for the text part, as before,
and, for the HTML part, its title in words with its code under it, labelled lines (When in words, By, App, About,
Outcome, Scope) and its details in words, drawn by the brand's `entries` block with every value unlinked. The titles
and the details' words are `@hana-id/console-core` audit-words.ts, the console's Audit page's own (D704, chosen by
the user); how a row reads is `changeRow`, `auditLogRow` and `eventRow` in `src/email/messages.ts`. The intro and "End of the N rows." say how many rows there are; the HTML part stays under
`DIGEST_HTML_BUDGET` (90 KB as rendered) and says how many rows it left out and where to read them (the text part has
all). A row's invalid time reads "not a valid time: …" and is logged as `digest_bad_time` at error level (a count),
so the digest is still sent and the feed's cursors keep moving. Cuts (`cut`, `oneLine`) never split a surrogate pair.
`feed.ts` is unchanged.

**Register a scope for this organisation (D651).** A partner's apps need a scope on chain whose Google owners are
owners of the organisation, and registering one is a council action, so the panel prepares it and sends nothing. It
lists the organisation's owners who have accepted (each with their Google account, the digits-only `sub` the
contract stores) as checkboxes, none ticked (an on-chain owner stays one after leaving the organisation, and the panel
says so, D657; at most 5), and everyone who can't be one yet with why (an owner invite not accepted, an owner in the
grant period, a disabled owner). A new scope always gets Journear's shared login: there is no client-id field, and the
partner adds their own client with its proof from their console (D656). It checks the choices as the contract and
"Create an app" would and shows two commands for the env, the dry run and the one with `--yes` (`GET /api/me`
`scopeRegistration`, from the `SCOPE_REGISTRATION` var): both council votes in one run on a dev env on testnet
(`--member`/`--approve-with`), the member chosen by radio button elsewhere, the owner's key for an account owner; each
Copy re-reads the members and refuses if a ticked owner left meanwhile (D658); with what it prints (`Registered scope:
s…`) and the next steps ("Create an app" with that id; the partner's on-chain owner adds origins). No owner yet: "Waiting for the
partner" and no form. An organisation that already has an app keeps it behind "Prepare a scope:register command". The
`sub` is shown to staff and in the command only, never in a URL or a log. The organisation's registered scopes are not
offered in "Create an app" (no view lists them: D655). Tests: `test-spa/scope-register.test.ts`. The full onboarding
sequence: `docs/operations.md` "Onboarding a partner on testnet".

**Users (C8b; D275 as confirmed 2026-11-05).** Every row and opened user shows the person's Hana Home name (D714:
whatever they shared with apps; "not set" when none, "unknown" when it wasn't read, "Names unavailable" when the read
failed), read from the API (`AdminRpc.profileNames`, one call a page of at most 50). Search the email issuer's user directory by address (a full address
exactly, else ≥ 3 characters of one), account kind, app, sub or "unverified only" (`POST /api/users/search`; a support
reference required for a sub or a full address, optional to browse; D410), or the wallet directory by wallet address,
User ID or internal id (`POST /api/users/find`; a support reference required, audited first as `users.find`); a
Support ID goes to the Support ID lookup. An opened user stays in the tab's memory at the fixed path `/users/open` (no
sub in a URL; back and forward move between the users opened, a reload opens nobody). Opening a user needs a support
reference (`POST /api/users/get`): the directory row and its apps,
the wallet directory's users holding the identity (User ID, Support ID, internal id, wallets), and each scope's
on-chain path read live (`get_identity`, `get_account`). The issuer verifies the staff JWT itself, audits every read
and caps each staff member at 500 identities an hour and 2 000 a day; past that the read is refused and the security
alias is emailed. No export.

**Key exports and mainnet demo signatures (D428, D430).** The Users detail and each Support ID lookup match list the
user's key exports (`key_exported`, recorded by the API at the export window's sign-in) and their mainnet demo
signatures (reported by the vault, bound to the user's session), from `user_events`, at most 20 of each kind, kept 24
months (the Retention screen's monthly job; an erasure removes them at once; D433), so an empty list says "in the last 24
months". The app page's **Signing settings** card has the
mainnet demo switch in a dev testnet env, for a test app only (`POST /api/apps/:app/mainnet-demo`).

**Support ID lookup (C15; D394–D396, D399).** A Support ID, User ID or internal id, a support reference (required),
optional request IDs (≤ 20) and a window (1–731 days, 30 by default) → `POST /api/support/lookup`: every user the code
names (a collision lists each, `truncated` past 10), their ids, identities with each one's address from the issuer's
directory (read as `support_lookup` under the same ticket; unverified Google claims marked), wallets, the scope's apps,
the vault shares not yet expired, the apps' changes, the ok ledger events, and the request IDs' events with their
errors; "ledger unavailable" with its reason when the ledger can't be read. Reached from the nav, from the Users search
(a Support ID, run at once with a support reference) and from any wallet-directory user's block (by User ID). Audited
first in the console's audit log (`support.lookup`, with the request IDs). The query and the answer stay in memory: no URL, no storage, no
export.

## System status (D425)

The landing page (`/`, nav **Overview → Status** at the top; asked for by the user 2026-11-06): one look says whether
every part of the env is up and working, and what to do when it isn't. Read-only: its one button, **Check again**,
reads again; everything else is a link.

**What it shows.** A verdict banner: **All systems operational** (green) only when every check answered and passed;
otherwise **N issues** (amber with warnings only, red with a critical one), with when it was checked ("N s ago",
refreshed in place) and how many checks passed, and under it the design system's stats strip: checks passed, critical,
warnings, unknown and not measured (D765). Then the **issues**, critical first: what is wrong in plain words,
what it affects (logins, the partner console, alerts, billing…), since when (from the source when it has a time: an
alert's, a proposal's, a cron's last run plus one interval, the oldest waiting notice; else **first seen** by this
isolate), which component, what to do, and the screen or playbook that resolves it. Then one **tile** per component,
grouped (Workers; Contract and watchdog; Relayer funds; Data; Scheduled jobs; External services; Free-tier
headroom): **OK** (green), **Warning** (amber), **Critical** (red), **Unknown** (grey, dashed: a check that should have
answered and didn't; always behind an issue, never green) or **Not measured** (outlined: nothing measures it yet, or the
piece isn't part of this env; not an issue), each with a line of detail (latency, build id, counts, ages) and "checked
N s ago". Last, **Not measured yet**: what the page can't see and how to check it meanwhile.

**The checks** (`GET /api/status`, `src/status.ts` and `src/status-probes.ts`; every source in parallel, each failing on
its own; when a source fails, the tiles it feeds are Unknown and the failure is said once, as one issue):

| Group | Tile | Source | Amber | Red |
|---|---|---|---|---|
| Workers | API, vault Worker, vault bundle, auth Worker, auth pages, email issuer, console Worker, console SPA, console-auth, files | the public build reads `deploy-check` makes (`/v1/health`, `/.well-known/hana-build`, `/vault.js`'s first line, the `<meta name="hana-build">` of `/login` and the console's `/`, `/v1/email/health`): 5 s deadline with the body, 16 KiB read (256 B of `vault.js`), no redirect followed, no credential | slower than 2 s; no build id (deployed without its `run deploy`) | no answer in 5 s, unreachable, non-2xx, a redirect, an answer that isn't the build endpoint |
| | Admin console (this Worker) | its `HANA_BUILD`; `EMAIL_API_KEY`, `CANCEL_LINK_KEY`, `INVITE_LINK_KEY` present and usable (named, never shown) | no build id | a key missing: no blocking notice can go out |
| | Watchdog | its `GET /status` (the bearer, server-side, as Security & monitoring) and its `build` (D425) | no `build` (a watchdog before D425) or none stamped | unconfigured, unreachable, refused, timed out |
| | Same build everywhere | the build ids above, by commit (a `-dirty` build of the same commit is the same) | **mixed builds**: the pieces off the majority's build named (a half-done deploy) | — |
| Contract and watchdog | Contract (hana-signer) | `AdminRpc.systemStatus`'s governance snapshot, judged by Security & monitoring's own rules (`findingsOf`, its governance part, info dropped) | its warnings (a delay decrease, a due key change, a cancelled proposal of the API's cron…); unreadable (Unknown, with an issue) | paused, a pending upgrade, owner transfer or withdrawal, a forged or published-key change, an untracked signer key |
| | Watchdog checks | its `GET /status` | heartbeat off or failing; a channel off; an open warning alert; a check `error` | an open critical alert (marked "not acknowledged: re-sent every 15 min" until it is) |
| Relayer funds | Relayer balance, session pool keys, owner pool keys | the watchdog's last relayer reading (`relayer_funds`, its own warn/critical lines) and the API's pool keys (`systemStatus`) | below warn; the reading older than 30 min; no owner-pool key; an API owner-pool key not on the account | below critical; the account missing; no session-pool key; an API session-pool key not on the account (its relays fail) |
| Data | Hot D1 (API), console D1, email issuer D1 | `AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`: one timed `SELECT 1` each | slower than 1 s; the Worker didn't answer its status call (Unknown, with an issue: often a Worker deployed before D425) | the query failed |
| | Usage ledger (Neon) | one Hyperdrive connection: `ops.state`, `partitionsAhead`, the settlement backlog | not bound; fewer than 2 partitions ahead; settlement's oldest event older than 2 h | unreachable; 0 partitions ahead |
| | R2: statements, exports, logos | a `get` of a key nothing writes (Class B; the console's `StaffRpc.health` reads LOGOS) | the read threw | — |
| Scheduled jobs | API every 15 min (Google key sync), admin every 5 min, admin every 15 min, console hourly, watchdog every 5 min | the run each records: `issuer_key_sync_runs`, `ops.state` `cron.last_run` and `ledger_cron.last_run` (new, D425), the console's `cron_runs` (console migration 0003, D425), the watchdog's `last_run` and silence rule | later than 2 intervals + 5 min; the last run `skipped`/`error` or a step failed; the console's table missing (migration 0003 not applied); no run recorded (Unknown) | later than 6 intervals (30 min for the 5-minute admin cron, 90 min for the 15-minute ones, 6 h hourly); the watchdog silent (no run in 2 intervals) |
| External services | Google signing keys (JWKS) | the API's own fetch (`issuers[].jwksKids` in the snapshot) and the watchdog's `jwks_fetch` check | the watchdog's check failed | the API can't fetch them |
| | NEAR RPC (one tile, one line per endpoint: Primary, Backup 1…, labels only, no URL) | one `block` (`finality: final`) on every endpoint the API can use (`rpc`, `apiRpcFallbacks`, else `rpcFallback`), and on `rpcFallback` when that list doesn't include it (line "Vault's fallback") | an endpoint slower than 2 s or 2–10 min behind; a backup down or stuck; the primary down while a backup serves | none of the API's endpoints answers; the one serving the API over 10 min behind (an answer isn't failed over, D435); `rpc` and `rpcFallback` both down (the vault and the watchdog have only those) |
| | Email (SendGrid) | the blocking notices waiting (`systemStatus`, `StaffRpc.health`), the last 5-minute run's failed sends, `EMAIL_API_KEY` | a send not accepted; the oldest notice waiting over 15 min | over 1 h; no key (said once, on this Worker's tile) |
| Free-tier headroom (D417) | Cron triggers on this account | `ACCOUNT_CRONS` (`gen` counts the manifest's cron Workers on the API's account) against the Free plan's 5 | not counted (an older config: Unknown) | over 5 (at 5 it is green: "full: nothing else with a cron may be added") |
| | Admin crons' call budget | each last run's `calls` against its 40 (D380) | 38 or more | — |
| | Requests, D1, Hyperdrive, R2 and SendGrid against free limits | — | Not measured: Cloudflare's GraphQL Analytics needs an API token this Worker doesn't hold, SendGrid's stats a key beyond Mail Send (`docs/mainnet-readiness.md` 5.12) | |

**Budget per page load** (Workers Free: 50 subrequests, 10 ms CPU): a cold read makes **20** outbound calls on
sandbox-dev, at most **22** with the most endpoints the manifest allows (1 watchdog `/status`; 3 RPCs:
`AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`; 10 public build reads; one NEAR `block` per
endpoint, 3 on sandbox-dev and at most 5; 1 Hyperdrive connection; 2 R2 reads), plus the Access check's certs fetch on
a cold isolate (cached ≤ 10 min): **23** at most, and 3 of the 32 Worker invocations a request may make. The answer is kept in the isolate for **30 s**
and concurrent misses share one read, so a refresh, a second tab or the other staff member costs **0** calls within that
window (the page says when it shows a kept read). `test/status.test.ts` counts a cold and a warm load from outside (the
stubs) and inside (the answer's `calls`). The admin's crons gain no call: the 15-minute run writes its record on its
open connection (a query, D380; `test-ops/budget.test.ts`).

**Security.** Staff only behind Access and the Worker's own staff check like every `/api/*` route; GET only; `no-store`.
The three health methods are authenticated as their entrypoints' other methods are (`AdminRpc` and `StaffRpc`: a
`hana` actor; `DirectoryRpc`: the staff request's Access JWT, verified by the issuer before anything is read; no audit
row, no row budget) and answer no user data: build ids, timings, counts and timestamps. No secret, token or key is in
the answer (a test checks): the admin's keys are named present or missing only, the pool keys are public keys, the
watchdog's bearer stays server-side. The page writes text only; an issue's link becomes a link only when it is one of
the console's own paths.

**Preview scenarios** (`corepack pnpm --filter @hana-id/admin preview`; `test-spa/preview-status.ts`): the real
`buildStatus` over fake sources, `PREVIEW_STATUS=<scenario>` at start or `/preview/status/<scenario>` to switch:
`green`, `warnings` (the relayer under its warn line, a watchdog channel off, notices waiting 22 min, the console's
migration 0003 missing), `critical` (the API answering 503, every NEAR RPC endpoint down, an unacknowledged critical alert),
`mixed-build` (the page Workers and bundles on the previous build), `watchdog-down`.

## UI principles

The staff SPA is a working tool for two people doing onboarding, support and security; these rules hold on every
screen (D420; tests `test-spa/ux.test.ts`).

- **Never offer an action that can't work.** What the API would refuse for a reason the page already knows is hidden
  or disabled with one line saying why: Legacy apps (`org_legacy`) has no members, so it shows no invite, member,
  owner-grant, freeze, app or scope-registration form, and offers "Invite a new partner" and, per scope, "Move to an
  organisation" instead; an organisation without a security contact gets no "Create an app"; the scope-registration
  panel shows no command until its choices would work, and none while no owner has accepted; "Issue statement" is disabled until
  the month is over, settled and rated. Everything else is left to the server, its refusal mapped: a scope moves (or
  gets an app) only when each of its Google-account owners on chain is an owner of the target organisation (a scope
  owned only by a NEAR account moves freely), else `scope_conflict`.
- **Errors in plain words.** Every API code maps to a title and what to do next (`ERRORS` in `public/app.js`); the
  server's own message sits under it and the code is kept small (`Error code forbidden (HTTP 403)`) for support. A
  dropped connection and an unknown code get their own wording.
- **Confirm in the page.** A destructive or guarded action shows a strip under its button: what will happen (with
  the names and values involved), the action's own label, Cancel; Escape cancels, and nothing is sent before the
  confirm. No browser `alert`/`confirm`/`prompt` (a source check).
- **One header per page** with crumbs to its parents where there are any, the title, one line of what the page is for,
  and at most one primary action in the whole view (a form's submit is secondary unless it is the page's main task; a
  disclosure that opens one steps down to secondary while open). Sections are cards with a heading and, where needed,
  one line of help.
- **Names first, ids small.** Organisations, apps and people are shown by name with their id underneath in
  monospace; times as `2026-11-06 04:28 UTC` with "3 h ago" under them; system words (suspension bits, change kinds,
  feed sources) in words, the raw kind kept small where staff search for it.
- **Empty states say what to do** (the brand's dashed box with an icon), a part still loading is a skeleton (its
  words for screen readers, `role=status`), and a success re-renders the page and says what it did in a toast
  (`role=status`, bottom right; at the top on a phone): at most three, each gone after 5 s unless the pointer or the
  focus is on it; a danger toast stays until dismissed. What staff must read or copy (a new app's publishable key, an
  export's hash) stays in the page as an inline alert. Alerts are inline, never floating.
- **Support references are explained where they are asked**: what to type, its rule, and that it is recorded.
- **Fields**: the label above (6 px), the hint below, "optional" on the fields that are (required is the default).
  A field is checked when it is left, never while typing; its problem replaces its hint in plain words ("Enter a full
  email address, like name@partner.example.") and clears as soon as it is right; a submit with a problem sends nothing,
  marks every field and focuses the first (`novalidate`: the page's words, not the browser's bubbles).
- **Settings are rows** (a title, one line of what it means, the control on the right: an app's signing settings).
  A settings form that edits a value the page read (an organisation's security contacts) has no submit of its own:
  the brand's save bar slides up at the first change, counts the changed fields, and offers Discard and Save; Save
  still goes through the in-page confirmation. An app's signing settings are each their own guarded action, so they
  have no save bar.
- **Danger only behind a confirm**: a destructive trigger is a secondary button in the danger colour; the red danger
  button exists only inside its confirmation (an `actionButton` marked destructive without one isn't drawn).
- **Tables** are the brand's: caps headers that stay in view while the table scrolls in its box, numbers
  right-aligned under a right-aligned header and tabular, and the pager (Next page, First page; Older rows) for the
  API's cursors. Dashboards (System status, Email issuer, Account links) open with the brand's stats strip.
- **Accessible by default**: landmarks (nav, main), a skip link, a label and help text on every input, focus moved to
  the new page's heading after a navigation, a visible focus ring, keyboard-only flows, AA contrast in the light and
  the dark theme (`prefers-color-scheme`), layouts that hold at 1024 px (wide tables scroll inside their panel).
- **Security unchanged**: same routes, bodies, CSRF headers, Access flow and CSP; text-only DOM (no HTML sink; icons
  are SVG elements built with `createElementNS`), no inline script or style, no external font or file (the brand fonts
  are this Worker's own assets, D426, D765); the Users detail and the Support ID lookup stay in memory; nothing in
  `localStorage`.
- **Sign-in expiry is said, never a network error** (D424; tests `test-spa/session.test.ts`). The Access session lasts
  1 h (D409; up to 8 h in a dev env on testnet, `admin.accessSessionDuration`, D437: sandbox-dev is 8 h; the banner reads
  the token's own `exp`, so nothing here assumes a length) and ends silently: Access then answers every `/api/*` request with a redirect to its login page on the
  team's origin, which a followed `fetch` reports as a network error (CORS). Every request is sent with `redirect:
  'manual'` (one `fetch` in `public/app.js`, a source check): that redirect, or the Worker's own 401 `unauthenticated`,
  is the expired sign-in. The request waits, the page and every typed value stay, and the banner at the top
  (`role=alert`) says "Your sign-in has expired" with **Sign in again** (a link opening `/signed-in` in a new tab:
  Access signs in there, its `CF_Authorization` cookie is this tab's too, and the page says to come back) and **Try
  again** (sends exactly the waiting request again, the same bytes; still signed out, it says so). Back on this tab
  after signing in, the sign-in is checked and the banner turns to "You're signed in again" until Try again sends
  what waited; nothing is sent without it, and no success line shows before the server answers. Moving to another
  page drops what waited on the old one (never sent later). A real network failure keeps "Can't reach the admin
  console". Nothing of it is stored: a reload loses unsent input, as before.
- **The warning before it ends**: `GET /api/me` answers the Access token's `accessExp` (seconds; never the token).
  5 minutes before, the banner says "Your sign-in ends in N min" with **Renew**, which opens the Access team's login for
  this application (`GET /api/me` `renewUrl`; it mints a fresh token while the team session lasts, checked on
  sandbox-dev 2026-11-06; without it, the same new-tab sign-in; back here
  `exp` is read again). Cloudflare Access issues a new token only once the old session has ended, so a Renew while
  the session still runs usually changes nothing, and the banner then says so plainly ("Access kept your current
  sign-in: it still ends at …"). At `exp` the Worker is asked once (the reader's clock may be off), so the expired
  banner shows before the next click.

What the redesign fixed (the audit of 2026-11-06, before → after screenshots taken with the preview below): a
one-line header of 12 links → a grouped left nav with the current page marked; every action on one long page with
no hierarchy → panels, one primary action, a danger zone at the bottom; an invite form on Legacy apps that answered
`forbidden: org_legacy has no members` → no such form, the onboarding path stated, scopes moved from their row;
"Assign a legacy scope" as a free-text field on every org → "Move a legacy scope here", a list of Legacy apps'
scopes, only where it can work; raw `code: message` errors → plain words with the next step; browser `confirm()`
dialogs → in-page confirmations; "bits 2", "Clear bit 4", "Seen kids", D-numbers and JSON blobs in cells → words and
`key: value` pairs; empty tables reading "None" → what is missing or what to do; unlabeled placeholder-only inputs →
labels with help; a 19-column report → the main columns with "Show every column".

## Design (D426, D765)

The SPA follows the Journear Passport design system (v0.5), shared with the partner console and the sign-in pages
through `packages/brand` (D765, asked for by the user 2026-11-12): its tokens (`tokens.css`, `--jp-*`, light and dark
with `prefers-color-scheme`), its components (`components.css`, the `.jp-*` classes: buttons, fields, setting rows,
the save bar, alerts, toasts, badges, cards, tables, the key/value list, the stats strip, crumbs, the pager, the
segmented control, choice cards, empty and skeleton states) and its self-hosted fonts. `public/app.css` adds only the
console's layout, written with the tokens (no colour of its own: a source check forbids hex, `rgb()` and `hsl()` after
the brand block).

- **Chrome.** The left nav is Journear ink (`--jp-ink-surface`) in both themes, a `.jp-dark` subtree so its text,
  badges and focus ring read the brand's dark tokens, with the white Journear lockup at 196 px (inline, from
  `logo/journear-lockup-white.svg`, so its "PASSPORT" is set in this page's Archivo and no image is requested), "Staff
  admin" in caps, and the env as an amber badge; the current page is marked in teal. The partner console's nav is
  light, so the two consoles never look alike. The source check holds the nav's pairs at AA (ink text 7:1, muted
  4.5:1, the env badge, the focus ring 3:1).
- **Type.** IBM Plex Sans for everything people read (page titles at 24 px semibold, section titles at 17, body 15,
  hints 13, caps labels 11 with wide tracking), IBM Plex Mono for ids, keys, hashes and commands, tabular figures
  everywhere. Archivo only in the lockup: the design system keeps it for the wordmark and marketing headings.
- **Colour.** Teal is the brand colour (the one primary button, links, the current nav item); orange appears only in
  the logo and the save bar's mark; red, amber, green and blue only for state (badges, alerts, the verdict, tiles).
- **Shape.** 8 px buttons and inputs, 12 px cards and tables, pill badges with a dot for live states; icons on the
  system's 20 px grid with a 1.75 px stroke, built as SVG elements (`ICONS` in `public/app.js`).
- **Names.** "Journear Passport", "Journear" (the company: "Journear staff", "Journear's suspension") and "Passport
  Home", from `BRAND`, mirrored from `packages/brand` (no build step; `test-spa/design.test.ts` holds the two equal
  and finds no "Hana" in what staff read). Code keeps "hana": the `hana` actor kind, `x-hana-admin`, package names,
  and the Support ID format `HANA-XXXX-XXXX` (a protocol string).

**Keeping it in step.** The SPA has no build: `public/fonts/` (the eight WOFF2 files and their three OFL licences),
the block at the top of `public/app.css` (`fonts.css`, `tokens.css`, `components.css`) and the lockup block in
`public/index.html` are copies of `packages/brand`, made by `corepack pnpm --filter @hana-id/admin sync-brand`. One
declaration is left out of the copy: `components.css` draws the select's chevron with a `data:` image, and the
stylesheet loads nothing but the fonts, so `app.css` draws that chevron with two gradients. A source check fails when
any copy drifts, when `public/fonts/` holds anything else, when the stylesheet loads anything but those fonts, or when
the nav's pairs miss AA (`scripts/test/gen-wrangler.test.ts`); `packages/brand`'s tests check the fonts and every token
pair in both themes.

## Local preview (design work and screenshots only)

```sh
corepack pnpm --filter @hana-id/admin preview     # http://127.0.0.1:8788 (PORT to change it)
```

`PREVIEW_SESSION_MIN` (default 60) sets when the fake Access sign-in ends: `GET /api/me` answers that `accessExp`, and
past it every `/api/*` request is a 302 to a fake Access login on another origin, as Access answers; opening
`/signed-in` (the tab "Sign in again" and "Renew" open) signs in again for 60 minutes. `PREVIEW_SESSION_MIN=4` shows
the warning at once and the expired banner 4 minutes later; `0.4` the expired banner after 24 s.

`test-spa/preview.ts` serves `public/` with the Worker's own headers and CSP and answers `/api/*` from
`test-spa/preview-data.ts`: fake organisations (Legacy apps with its scopes, pending invites to new organisations in each state (D696), partners with members, invites and
grants, a frozen one, one without a security contact, and for the scope-registration panel Orbit Labs (an owner invite
not accepted) and Corvid Pay (two owners, one in the grant period, an open owner invite, no app)), apps, users, a Support ID lookup, the feed, monitoring,
upgrades, the real playbooks, reports, statements, rates and retention. Writes succeed, except the refusals the real
services give for `org_legacy`. It binds to the loopback address, has no Access, secret or network, and is not part
of the Worker (wrangler serves `public/` alone; a source check keeps `public/` to the SPA's three files and the brand
fonts, D426).

## Layout

| File | Role |
|---|---|
| `src/index.ts` | host dispatch, the Access check, CSRF, the headers, the two crons |
| `src/access.ts`, `src/csrf.ts`, `src/headers.ts`, `src/http.ts` | the staff check (`@hana-id/oidc`), CSRF, CSP and headers, error codes and body limits |
| `src/routes.ts` | the staff BFF route table (the audit view's three sources) |
| `src/users.ts` | the Users screen (C8b): search, find, the joined detail, the `directory_budget` email |
| `src/support.ts` | the Support ID lookup (C15): the audit row, `AdminRpc.supportLookup`, the ledger part, the email join (D399) |
| `src/near.ts` | read-only NEAR views: `get_scope`, `tx`, `view_access_key`, `get_identity`, `get_account` |
| `src/notices.ts`, `src/feed.ts`, `src/watcher.ts`, `src/cron.ts`, `src/mail.ts` | the 5-minute cron's jobs and the call budget (D380) |
| `src/ledger*.ts`, `src/settlement.ts`, `src/statement*.ts`, `src/rates.ts`, `src/report-routes.ts`, `src/alerts.ts` | C12's ledger work and routes |
| `src/monitoring*.ts`, `src/watchdog.ts`, `src/playbooks.ts`, `src/plain.ts` | C14's Security & monitoring |
| `src/status.ts`, `src/status-probes.ts` | the System status page (D425): the sources, every check, the verdict, the 30 s cache; the counted build and NEAR reads |
| `src/retention*.ts` | C13's monthly job and screen |
| `src/email/` | the `EmailSender` (SendGrid, `sendgridSender`) and every message; `src/mail.ts` `sendToAll` skips a message this isolate saw accepted (SendGrid has no idempotency key, D401). `render.ts` writes a text part and plain HTML; a message that passes `design` (today only the partner invite, `inviteLink`, D672) gets the shared designed layout from `@hana-id/brand/email` instead, built from the same blocks, its link a button with the URL again as text, its paragraphs written so clients don't link a name, and the logo from `FILES_ORIGIN` (D685, D687). The operational mails stay plain (D674) |
| `public/` | the SPA (no build, text only: a source check forbids HTML sinks and browser dialogs) and `fonts/`, the brand's fonts and licences (copied from `packages/brand`, D426, D765) |
| `scripts/sync-brand.ts` | copies `packages/brand`'s fonts, tokens, components and white lockup into `public/` (`sync-brand`) |
| `test-spa/` | the SPA's DOM tests (`boot.ts` runs `public/app.js` in happy-dom) and the local preview (`preview.ts`, `preview-data.ts`, `preview-status.ts`: the status page's scenarios over the real `buildStatus`, typechecked with `test-ops/`) |
| `scripts/gen-wrangler.ts` | `wrangler.jsonc` from the manifest's dashboard blocks (`ISSUER` when the env has an email issuer) |

## Commands

```sh
corepack pnpm --filter @hana-id/admin test        # Worker tests over the real API, console and email issuer Workers, the config and source checks, the ops store on PGlite, the SPA in happy-dom
corepack pnpm --filter @hana-id/admin typecheck
corepack pnpm --filter @hana-id/admin preview     # the SPA on 127.0.0.1:8788 with fake data (above)
corepack pnpm --filter @hana-id/admin sync-brand  # after a change to packages/brand: its fonts, tokens, components and lockup into public/ (D426, D765)
corepack pnpm --filter @hana-id/admin gen <env> [--admin-hyperdrive-id <id>|off]
corepack pnpm --filter @hana-id/admin run deploy     # after the API, the console and (for Users) the email issuer; stamped with the build id (D406)
```

The Worker tests reach no network: the Access certs, SendGrid, NEAR and the watchdog are stubbed in the test isolate,
and the email issuer (an auxiliary Worker, so `DirectoryRpc` runs for real) gets the suite's Access certs from a fake
team (`test/fake-access.js`). The SPA's tests (`test-spa/`, `vitest.spa.config.ts`) run `public/app.js` as the browser
does, in a fresh happy-dom window per test with the API answered at `fetch` (`test-spa/boot.ts`): the Support ID
lookup screen and the Users screen's ways into it (`support.test.ts`), the UI principles above (`ux.test.ts`), and
the sign-in's end: the Access redirect, Try again, the warning (`session.test.ts`), the System status page over each
preview scenario's real answer (`status.test.ts`), and the design system's patterns: the names, one primary per view,
danger only in a confirmation, toasts, fields checked when left, the save bar, setting rows, tables, the pager and
crumbs (`design.test.ts`); the status route's checks, call count and cache are `test/status.test.ts`.

Last verified: 2026-11-12 (branch `feat/journear-design-admin`, not merged, not deployed: the SPA on the Journear Passport design system and names, "Design", `sync-brand` with `components.css` and the lockup, `test-spa/design.test.ts`, the usage report's columns lined up with their headers, D765); 2026-11-12 (branch `feat/journear-design-email`, not merged, not deployed: the mails' names and the subject prefix, the Journear look from `@hana-id/brand/email`, D765); 2026-11-11 (branch `feat/designed-digests`, not merged, not deployed: the feed's digests designed, the `rows` block and `rowTime`, D704; after review: the row count, the HTML budget, `cut`, the error-level log; the rows in plain words); 2026-11-11 (branch `feat/admin-pending-invites`, not merged, not deployed: the Organisations page's "Pending invites" panel, `GET /api/invites/new-orgs`, `test-spa/pending-invites.test.ts`, D696; after the dry run: "Create an app" refreshes the Apps table in place, the Invites panel's Revoke on open invites only, `passkeys_required`'s words, readable times in email sentences, `test-spa/onboarding.test.ts`, D697; the gate's words for a network that keeps it, D698; the designed partner security notices, D699, D700); 2026-11-10 (branch `feat/html-emails`, not merged, not deployed: the invite's logo and unlinked paragraphs, D685, D687); 2026-11-10 (branch `feat/html-emails`, not merged, not deployed: the invite's designed HTML part, D672, D674); 2026-11-10 (branch `feat/partner-onboarding`, not merged, not deployed: "Register a scope for this organisation", the staff "Propose origins" help, `ux.test.ts`'s `scope:register` rule changed, D651, D652); 2026-11-10 (branch `fix/testing-1110`, not merged, not deployed: an alert's "Details and deliveries" shows the latest result per channel above the last 20 rows, D570); 2026-11-09 (branch `feat/email-login-9`, not merged: the Email login screens, D446, D448); 2026-11-09 (branch `chore/status-access-followups`: System status's NEAR RPC tile, one line per endpoint the API can use, the calls per load and the preview's `critical`, D435's note; the Access session's length, D437); 2026-11-06 (branch `feat/user-events-retention`: the Users detail and Support ID lookup's events kept 24 months and their empty state, the Retention screen's user events rows, D433); 2026-11-06 (branch `feat/hana-brand`: "Brand", the SPA in Hana's brand, `public/fonts`, `sync-brand`, the amended source check, D426); 2026-11-06 (branch `feat/admin-system-status`: the System status page, its checks, budget and preview scenarios, D425); 2026-11-06 (branch `fix/session-expiry-ux`: the sign-in's end said as such, Try again, the warning
before `exp`, `GET /api/me` `accessExp`, `/signed-in`, the preview's `PREVIEW_SESSION_MIN`, `session.test.ts`, D424);
2026-11-06 (branch `feat/admin-ux-redesign`: the grouped nav and screens, "UI principles", the local preview, `ux.test.ts`, D420); 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: email through SendGrid, D401); 2026-11-05 (branch `feat/deploy-check-all-workers`: `run deploy`, stamped with the build id, read by `deploy-check` from the deployed version, D406); 2026-11-05 (branch `feat/batch-c-15-screen`: the Support ID lookup screen, `src/support.ts`'s email join,
the SPA tests, D399); 2026-11-05 (branch `feat/batch-c-8b`: written with the Users screen, D388–D392).
