# @hana-id/admin

The Hana staff console (`hana-id-admin-<env>`, `docs/batch-c-spec.md` "Hana admin console"): a Cloudflare Worker on
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
| Partners | **Organisations**: the list and "Invite a new partner" (a new organisation's first owner); an organisation's members, invites, owner grants, apps ("Create an app", "Move a legacy scope here"), security contacts, recent app changes and its danger zone (freeze, suspend every app); an app's suspension switches, allowed origins, guarded changes, signing settings, publishable keys and danger zone. **Legacy apps** (`org_legacy`) has its own page: its scopes, each with "Move to an organisation" |
| Support | **Users** (C8b), **Support ID lookup** (C15) |
| Security | **Security & monitoring**, **Feed and notices**, **Pending upgrades**, **Playbooks** (C14), **Audit log** (the console's rows, an org's app changes, the issuer's directory reads) |
| Money | **Reports**, **Statements**, **Rates** (C12) |
| System | **Retention** (C13) |

**Users (C8b; D275 as confirmed 2026-11-05).** Search the email issuer's user directory by address (a full address
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

The landing page (`/`, nav **Status** at the top; asked for by the user 2026-11-06): one look says whether every part
of the env is up and working, and what to do when it isn't. Read-only: nothing on it acts, it only links.

**What it shows.** A verdict banner: **All systems operational** (green) only when every check answered and passed;
otherwise **N issues** (amber with warnings only, red with a critical one), with when it was checked. Then the issues,
critical first: what is wrong in plain words, what it affects (logins, the partner console, alerts, billing…), since
when (known from the source, e.g. an alert's or a proposal's time, a cron's last run; else "first seen" by this
isolate), and the screen or playbook that resolves it. Then one tile per component, grouped (Workers, contract and
watchdog, relayer funds, data, scheduled jobs, external services, free-tier headroom): green, amber, red, grey
**unknown** (a check that should have answered and didn't: always an issue, never green) or grey **not measured**
(nothing can measure it yet: listed under the tiles as a follow-up, not an issue), with "checked N s ago" and a line of
detail (latency, build id, counts, ages).

**Where each check comes from** (`GET /api/status`, `src/status.ts`; every source in parallel, each failing on its own):

| Group | Tile | Source | Green | Amber | Red |
|---|---|---|---|---|---|
| Workers | API, vault Worker, vault bundle, auth Worker, auth pages, email issuer, console Worker, console SPA, console-auth, files | the public build reads `deploy-check` uses (`/v1/health`, `/.well-known/hana-build`, `/vault.js`'s banner, `/login`'s and the console's `<meta name="hana-build">`, `/v1/email/health`): 5 s timeout, no redirect followed, 16 KiB read (256 B of `vault.js`) | 2xx with a build id, < 2 s | slower than 2 s; no build id (unstamped) | no answer, timeout, non-2xx, redirect |
| | Admin (this Worker) | `HANA_BUILD`; its secrets present (names only, never values) | stamped, every secret set | unstamped; `COINGECKO_API_KEY`… optional ones aren't checked | `EMAIL_API_KEY`, `CANCEL_LINK_KEY` or `INVITE_LINK_KEY` missing (no notice can go out) |
| | Watchdog | its `GET /status` (bearer, as Security & monitoring) | answered, `build` stamped | unstamped (a watchdog before D425 has no `build`) | unreachable, refused, unconfigured |
| | (all) | the build ids above | one build everywhere | **mixed builds**: the Workers not on the majority's build named (a deploy half done; `docs/operations.md` "Checking a deploy") | — |
| Contract and watchdog | Contract | `AdminRpc.systemStatus` → the governance snapshot, judged by Security & monitoring's own rules (`findingsOf`, governance part) | no finding | its warnings (a delay decrease, a due key change, …) | paused, a pending upgrade, owner transfer or withdrawal, a forged or published-key change, an untracked signer key |
| | Watchdog | its `GET /status` | last run < 2 intervals ago, heartbeat ok, every channel on, no open alert | heartbeat failing or off, a channel off, an open warning alert, a check `error` | silent (no run in 2 intervals), an open critical alert (unacknowledged: re-paging) |
| Relayer funds | Session pool, owner pool, relayer balance | the watchdog's last relayer reading (`relayer_funds`, its own thresholds) and the API's pool keys (`systemStatus`) | above `warn` | below `warn`; reading older than 30 min | below `critical`; account missing; an API pool key not on the account (its relays fail) |
| Data | Hot D1 (API), console D1, email issuer D1 | `AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`: one `SELECT 1` each, timed | answered < 1 s | slower | failed, or the RPC didn't answer |
| | Usage ledger | one Hyperdrive connection: `ops.state` reads, `partitionsAhead`, the settlement backlog | reachable, ≥ 2 partitions ahead | < 2 partitions ahead; settlement backlog older than 2 h | unreachable or unbound (reports, statements, settlement, the feed and the watcher stop; logins don't); 0 partitions ahead |
| | R2: statements, exports (admin), logos (console) | `head` of a key that never exists (a Class B read; `StaffRpc.health` heads `LOGOS`) | answered | — | threw |
| Scheduled jobs | API `*/15` (Google key sync), admin `*/5` (notices, feed, watcher), admin `*/15` (ledger), console hourly, watchdog `*/5` | the last run each records: `issuer_key_sync_runs`, `ops.state` `cron.last_run` and `ledger_cron.last_run` (new, D425), the console's `cron_runs` (migration 0003, D425), the watchdog's `last_run` | ran within 2 intervals + 5 min | later than that; last outcome `error`/`skipped`; a run's call budget ≥ 38 of 40 | later than 6 intervals (2 h for the 15-minute ones, 6 h hourly; the watchdog: 2 intervals, as its silence rule) |
| External | Google JWKS | the API's governance snapshot (`issuers[].jwksKids`, the API's own fetch) and the watchdog's `jwks_fetch` check | listed | the watchdog's check failed | the API can't read it (Google logins fail when its cache runs out) |
| | NEAR RPC primary, fallback | one `block` (`finality: final`) on each of the manifest's `rpc` and `rpcFallback` | answered, block < 2 min old | slow (> 2 s), or block 2–10 min old; the fallback down | the primary down (the API relays and reads through it) or > 10 min behind |
| | Email (SendGrid) | `systemStatus` and `StaffRpc.health`: the blocking-notice backlog; `cron.last_run`: the last run's failed sends; `EMAIL_API_KEY` set | no backlog older than 15 min, no failed send | a failed send; backlog older than 15 min | backlog older than 1 h; no key |
| Free-tier headroom (D417) | Cron triggers on the account | the manifest's cron Workers on this account (`gen`'s `ACCOUNT_CRONS`) against the Free plan's 5 | under 5 | at 5: full by design ("nothing else with a cron may be added") is green with that note | over 5 |
| | Admin crons' call budget | each last run's `calls` against its 40 | < 38 | ≥ 38 (a backlog, D380) | — |
| | Workers requests, D1, Hyperdrive queries, R2 storage and operations, SendGrid's 100 a day | — | not measured: the admin Worker holds no Cloudflare API token (Cloudflare's GraphQL/billing APIs) and SendGrid's stats need a key with more than Mail Send; follow-up in `docs/mainnet-readiness.md` | | |

**Budget per page load** (Workers Free: 50 subrequests, 10 ms CPU): at most **22** outbound calls on a cache miss
(1 watchdog `/status`, 3 RPCs: `AdminRpc.systemStatus`, `StaffRpc.health`, `DirectoryRpc.health`; 10 public build
reads; 2 NEAR RPC; 1 Hyperdrive connection; 2 R2 heads; 1 Access certs fetch on a cold isolate, cached ≤ 10 min,
the Access check's), 3 Worker invocations of the 32 a request may make. The answer is cached in the isolate for
**30 s**, and concurrent misses share one read, so a refresh, a second tab or the other staff member costs 0 calls
within that window; `test/status.test.ts` counts the calls of a cold and a warm load. Nothing is added to the admin's
crons but one `ops.state` write in the `*/15` run, on the run's open connection (a query, not a call, D380).

**Security.** Staff only behind Access and the Worker's own staff check like every `/api/*` route; GET only. The three
health methods are authenticated as their entrypoints' other methods are (`AdminRpc` and `StaffRpc`: a `hana`
actor; `DirectoryRpc`: the staff request's Access JWT, verified by the issuer) and answer no user data: build ids,
timings, counts and timestamps. No secret, token or key is in the answer: the admin's secrets are named with
present/missing only; the watchdog's bearer stays server-side. The page writes text only, links are the console's own
paths, and nothing is stored in the browser.

## UI principles

The staff SPA is a working tool for two people doing onboarding, support and security; these rules hold on every
screen (D420; tests `test-spa/ux.test.ts`).

- **Never offer an action that can't work.** What the API would refuse for a reason the page already knows is hidden
  or disabled with one line saying why: Legacy apps (`org_legacy`) has no members, so it shows no invite, member,
  owner-grant, freeze or app form, and offers "Invite a new partner" and, per scope, "Move to an organisation"
  instead; an organisation without a security contact gets no "Create an app"; "Issue statement" is disabled until
  the month is over, settled and rated. Everything else is left to the server, its refusal mapped: a scope moves (or
  gets an app) only when each of its Google-account owners on chain is an owner of the target organisation (a scope
  owned only by a NEAR account moves freely), else `scope_conflict`.
- **Errors in plain words.** Every API code maps to a title and what to do next (`ERRORS` in `public/app.js`); the
  server's own message sits under it and the code is kept small (`Error code forbidden (HTTP 403)`) for support. A
  dropped connection and an unknown code get their own wording.
- **Confirm in the page.** A destructive or guarded action shows a strip under its button: what will happen (with
  the names and values involved), the action's own label, Cancel; Escape cancels, and nothing is sent before the
  confirm. No browser `alert`/`confirm`/`prompt` (a source check).
- **One header per page** with a back link where there is a parent, the title, one line of what the page is for,
  and at most one primary action. Sections are panels with a heading and, where needed, one line of help.
- **Names first, ids small.** Organisations, apps and people are shown by name with their id underneath in
  monospace; times as `2026-11-06 04:28 UTC` with "3 h ago" under them; system words (suspension bits, change kinds,
  feed sources) in words, the raw kind kept small where staff search for it.
- **Empty states say what to do**, loading says "Loading…", a success re-renders the page with one line of what
  happened (`role=status`).
- **Support references are explained where they are asked**: what to type, its rule, and that it is recorded.
- **Accessible by default**: landmarks (nav, main), a skip link, a label and help text on every input, focus moved to
  the new page's heading after a navigation, a visible focus ring, keyboard-only flows, AA contrast in the light and
  the dark theme (`prefers-color-scheme`), layouts that hold at 1024 px (wide tables scroll inside their panel).
- **Security unchanged**: same routes, bodies, CSRF headers and Access flow; text-only DOM (no HTML sink), no inline
  script or style, no external font or file; the Users detail and the Support ID lookup stay in memory; nothing in
  `localStorage`.

What the redesign fixed (the audit of 2026-11-06, before → after screenshots taken with the preview below): a
one-line header of 12 links → a grouped left nav with the current page marked; every action on one long page with
no hierarchy → panels, one primary action, a danger zone at the bottom; an invite form on Legacy apps that answered
`forbidden: org_legacy has no members` → no such form, the onboarding path stated, scopes moved from their row;
"Assign a legacy scope" as a free-text field on every org → "Move a legacy scope here", a list of Legacy apps'
scopes, only where it can work; raw `code: message` errors → plain words with the next step; browser `confirm()`
dialogs → in-page confirmations; "bits 2", "Clear bit 4", "Seen kids", D-numbers and JSON blobs in cells → words and
`key: value` pairs; empty tables reading "None" → what is missing or what to do; unlabeled placeholder-only inputs →
labels with help; a 19-column report → the main columns with "Show every column".

## Local preview (design work and screenshots only)

```sh
corepack pnpm --filter @hana-id/admin preview     # http://127.0.0.1:8788 (PORT to change it)
```

`test-spa/preview.ts` serves `public/` with the Worker's own headers and CSP and answers `/api/*` from
`test-spa/preview-data.ts`: fake organisations (Legacy apps with its scopes, partners with members, invites and
grants, a frozen one, one without a security contact), apps, users, a Support ID lookup, the feed, monitoring,
upgrades, the real playbooks, reports, statements, rates and retention. Writes succeed, except the refusals the real
services give for `org_legacy`. It binds to the loopback address, has no Access, secret or network, and is not part
of the Worker (wrangler serves `public/` alone; a source check keeps `public/` to the SPA's three files).

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
| `src/retention*.ts` | C13's monthly job and screen |
| `src/email/` | the `EmailSender` (SendGrid, `sendgridSender`) and every message; `src/mail.ts` `sendToAll` skips a message this isolate saw accepted (SendGrid has no idempotency key, D401) |
| `public/` | the SPA (no build, text only: a source check forbids HTML sinks and browser dialogs) |
| `test-spa/` | the SPA's DOM tests (`boot.ts` runs `public/app.js` in happy-dom) and the local preview (`preview.ts`, `preview-data.ts`) |
| `scripts/gen-wrangler.ts` | `wrangler.jsonc` from the manifest's dashboard blocks (`ISSUER` when the env has an email issuer) |

## Commands

```sh
corepack pnpm --filter @hana-id/admin test        # Worker tests over the real API, console and email issuer Workers, the config and source checks, the ops store on PGlite, the SPA in happy-dom
corepack pnpm --filter @hana-id/admin typecheck
corepack pnpm --filter @hana-id/admin preview     # the SPA on 127.0.0.1:8788 with fake data (above)
corepack pnpm --filter @hana-id/admin gen <env> [--admin-hyperdrive-id <id>|off]
corepack pnpm --filter @hana-id/admin run deploy     # after the API, the console and (for Users) the email issuer; stamped with the build id (D406)
```

The Worker tests reach no network: the Access certs, SendGrid, NEAR and the watchdog are stubbed in the test isolate,
and the email issuer (an auxiliary Worker, so `DirectoryRpc` runs for real) gets the suite's Access certs from a fake
team (`test/fake-access.js`). The SPA's tests (`test-spa/`, `vitest.spa.config.ts`) run `public/app.js` as the browser
does, in a fresh happy-dom window per test with the API answered at `fetch` (`test-spa/boot.ts`): the Support ID
lookup screen and the Users screen's ways into it (`support.test.ts`), and the UI principles above (`ux.test.ts`).

Last verified: 2026-11-06 (branch `feat/admin-ux-redesign`: the grouped nav and screens, "UI principles", the local preview, `ux.test.ts`, D420); 2026-11-05 (branch `feat/sandbox-dev-dashboard-blocks`: email through SendGrid, D401); 2026-11-05 (branch `feat/deploy-check-all-workers`: `run deploy`, stamped with the build id, read by `deploy-check` from the deployed version, D406); 2026-11-05 (branch `feat/batch-c-15-screen`: the Support ID lookup screen, `src/support.ts`'s email join,
the SPA tests, D399); 2026-11-05 (branch `feat/batch-c-8b`: written with the Users screen, D388–D392).
