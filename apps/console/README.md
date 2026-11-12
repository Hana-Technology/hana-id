# Partner console (`apps/console`)

The partner console: one Worker (`hana-id-console-<env>`) on `console.origin` that serves the partner SPA and its
`/api/*` backend, with partner sign-in through console-auth. Routes, sessions, CSRF, fresh sign-in and the write paths
are in `docs/api.md` ("Console Worker"); the security properties in `docs/security.md` ("Console Worker").

Last verified: 2026-11-12 (branch `feat/journear-design-console`, not merged, not deployed: the SPA on the Journear
Passport design system, "Brand" and "Patterns" below, D765: its tokens, component classes, self-hosted Archivo and IBM
Plex and the Journear lockup; toasts, the save bar, setting rows, choice cards, validate on blur, the stats strip; the
names users read); 2026-11-11 (branch `fix/console-email-login-flow`, not merged, not deployed: a fresh sign-in returns to the page that started it, D711; the Email login tab's live state, its plain wording and **Ready to execute**, the scope page's re-read at an unlock, D713; the preview's `unlocking` email state; after review: Execute's line when this app's email login is off, "any owner can execute it" on the scope page, no re-read loop on an inconsistent answer); 2026-11-11 (branch `docs/partner-start-here`, not merged, not deployed: the "No apps yet" page asks for the owners' Google accounts and a security contact instead of a Google client, and points testers at email sign-in, D707; "An app's page" describes the Email login page as built, correcting the 2026-11-10 note below); 2026-11-11 (branch `fix/console-users-table`, not merged, not deployed: the Users list in a card like every console table, its ids kept whole, its wallets shortened with a copy each, the header band's rounded corners, the preview's user detail); 2026-11-11 (branch `feat/designed-digests`, not merged, not deployed: "Audit": the titles and details' words from `@hana-id/console-core/audit-words`, shared with the feed digests, every code titled, a null field as "none", D704); 2026-11-11 (branch `fix/console-getting-started`, not merged, not deployed: "An app's page": changes in force never shown as waiting, the re-read at the next effective time, the snippet's environment, the install line's version, the Audit's details; the Users screen from the manifest; D701–D703; after review: "waiting" on the server's clock, "Unnamed app"); 2026-11-10 (branch `feat/partner-onboarding`, not merged, not deployed: the phone-width header and tables; Origins and Signing for an owner who isn't an on-chain owner, the preview's `not-chain-owner` scenario, D652); 2026-11-10 (branch `fix/testing-1110`, not merged, not deployed: the app's Email login page no longer has a "Scope" row in its facts; corrected 2026-11-11: step 2 still names the scope's email client, `email:<scope id>`, and links the scope's page, see "An app's page"); 2026-11-09 (branch `feat/email-login-9`, not merged: the app's Email login page, D444, D447); 2026-11-06 (branch `feat/hana-brand`: Hana's brand, its tokens, fonts and mark, "Brand" below, D426);
2026-11-06 (branch `fix/session-expiry-ux`: the session's end mid-task, the banner, the warning before
the 12 h end, `GET /api/me` `sessionExpiresAt`, the preview's two session scenarios, D424); 2026-11-06 (branch
`feat/console-ux-redesign`: the SPA's layout, error display and the local preview, D421).

## Layout

| Path | What |
|---|---|
| `src/` | The Worker: host dispatch, headers and CSRF, sign-in, sessions, fresh sign-in (`actions.ts`), the read and write routes, StaffRpc, the hourly cron |
| `web/` | The SPA (React 18, React Router 6, Vite), built to `dist/` and served as the Worker's assets |
| `web/src/pages/` | One file per page; `pages/app/` holds an app's sections (overview, origins, keys, login and sessions, signing, branding, suspend) |
| `web/src/ui.tsx` | The UI kit: errors and notes, panels, badges, copy buttons, the in-page confirm, the fresh sign-in hint, the guarded-change timeline |
| `web/src/messages.ts` | Every API error code in plain language, with what to do next |
| `web/src/lib.tsx` | The data, write and fresh-sign-in hooks, the fragment-token reader, formatting |
| `web/src/api.ts`, `web/src/session.tsx` | The requests (CSRF header, the wait for a new sign-in) and the session banner above every signed-in page |
| `preview/` | The local preview harness (dev only, below) |
| `test/`, `web/test/`, `scripts/test/` | Worker tests (workerd), SPA tests (happy-dom), build, source and harness checks (Node) |

## The SPA's rules

- **Phone width** (≤ 760 px): the sidebar becomes one header block: the lockup and Sign out on one row, the
  organisation on its own row, then the nav, which scrolls sideways. Wide tables scroll inside their `.jp-table-wrap`,
  so no page scrolls sideways (checked with the preview at 390 px, light and dark, 2026-11-12). Toasts move to the top;
  the save bar wraps (what changed, then Discard and Save).
- **CSP** `script-src 'self'; style-src 'self'; font-src 'self'`: no inline script or style anywhere, no `style` prop,
  no external URL; the only font files are the brand's own, bundled from `packages/brand` ("Brand" below); every style is a
  class in `web/src/styles.css` (light, and dark through `prefers-color-scheme`).
- **No HTML injection, no browser storage, same origin only**: checked over `web/src` by `scripts/test/spa-build.test.ts`.
- **Requests**: every write is `postJson`/`postBytes` (`web/src/api.ts`) with the CSRF header; a change marked
  "fresh sign-in" is built by `POST /api/orgs/:org/actions` and confirmed on `/actions/:id`.
- **A fresh sign-in returns to the page that started it** (D711): each page passes its own page to `useStepUp(org,
  {page, appId?})` (Origins, Signing, Login & sessions, Email login, Suspend, the scope page, Members; Keys and
  Branding have no fresh sign-in, their writes are immediate), the server checks it against the kind's allowlist and
  keeps the path it builds from ids with the action, and `/actions/:id`'s back link and **Not now** use it after Google's
  redirect (`Back to Email login`, `Back to Origins`, `Back to the scope`, `Back to members`…), for a member of several
  organisations too. The SPA links the answer only when it is one of these pages (`safeReturn`, `pages/Action.tsx`);
  anything else falls back to the kind's own page. Both Email login steps come back to the Email login tab.
- **Errors**: shown with `ErrorNote` (plain text for the code, the server's detail when it adds something, the code and
  HTTP status small). A new error code gets its line in `web/src/messages.ts`.
- **No control that can't work**: where the console would refuse (a viewer, a frozen org, a limit), the page shows one
  line saying why (`Why`) instead of the control. That includes the changes the API checks against the scope's
  on-chain owners (adding origins, proposing a policy, turning raw signing on, the scope page's owner actions, the
  email client): for an owner who isn't an on-chain owner, `pages/app/ChainOwner.tsx` reads the scope page's route
  once per page and says who the on-chain owners are and that one of them can add this account from the scope page
  (D652); kill switches stay. Destructive immediate writes use `ConfirmButton` (a second click in
  the page, never a browser dialog).
- **When the session ends mid-task** (2 h idle, 12 h absolute, or revoked: `docs/security.md` "Console Worker"; D424).
  A request answered 401 after this page has had a session isn't an error under the button and doesn't jump to
  `/signin`: it waits, the page and what was typed stay, and a banner at the top (`role=alert`) says "Your session has
  ended" with **Sign in again** (`/signin` in a new tab: the sign-in there sets the session cookie this tab uses too)
  and **Try again** (sends exactly the waiting request again; still signed out, it says so). Back on this tab after
  signing in elsewhere, the session is checked and the banner turns to "You're signed in again" until Try again sends
  what waited; nothing is sent without it, and nothing is said to have worked before the server answers. Moving to
  another page drops what waited on the old one (never sent later). It lives in the tab's memory only: no browser
  storage, so a reload or a closed tab loses unsent input, as before. A visitor who never had a session in this tab
  still goes to `/signin`; a real network failure keeps "The console couldn't be reached".
- **The warning before the 12 h end**: `GET /api/me` answers `sessionExpiresAt`; 5 minutes before it the banner says
  "Your session ends in N min" with Sign in again (a new session in the new tab; back here the new end is read and the
  warning goes), and at the end the server is asked once (the reader's clock may be off), so the ended banner shows
  before the next click. The 2 h idle end isn't warned of: each request moves it, and a check to find it would itself
  count as activity. The fresh sign-in page says when the session ends inside the confirmation's 5 minutes (the
  confirmation counts only with the session that started it, `session_ended`).

## An app's page

- **Changes waiting** (Overview, Origins, Signing) lists only guarded changes not yet in force on the server's clock
  (`isWaiting`: pending and not announced, or announced with `activeFrom` ahead), each with its timeline and an owner's
  Cancel. The server's clock is the reader's plus the offset the last app read measured (`GET /api/orgs/:org/apps/:app`
  answers `now`; `AppCtl.serverNow`), so a reader's clock that runs fast or slow never hides a Cancel the server would
  accept, nor shows a change in force as waiting; the timeline and the re-read are judged by it too. A change whose time has passed is in force (the API serves it and refuses its Cancel): it is never listed as
  waiting, the tab dots and "Getting started" step 1 agree, and the API's `getApp` answers it as `active` before the
  hourly job records it (D701). While the page is open, one timer to the next time something of the app takes effect
  (plus 1 s) re-reads the app once (`useReloadAtNextEffect`); the answer sets the next timer, if any. No polling.
- **Getting started**, step 4: the client snippet (and its Copy) names this console's environment, `GET /api/me`
  `envName` (the manifest's `name`, what `createHana({ environment })` takes, `docs/integration.md` section 3); without a
  usable name, the placeholder and where to find it. Step 3 keeps `<version>` in the tarball names: the console is
  deployed apart from SDK releases, so it can't know which release Journear sent (D703).
- **Email login** (`pages/app/EmailLogin.tsx`): a Status badge (**Off**, **One step left**, **Waiting for the chain**,
  **Ready to execute**, **On**, or **Unknown** when the chain can't be read) and, until it is on, two steps. Step 1, "Turn email login on for
  this app", is the app's setting through a fresh sign-in (in force at once). Step 2, "Add the scope's email client on
  chain", names the client it adds as `email:<scope id>` (the scope's internal id shows there, and the word "scope"
  links the scope's page) and is proposed by an on-chain owner through a fresh sign-in; while it waits the status is
  **Waiting for the chain** and the step says "You can execute this from HH:MM" (the day added when it isn't today,
  `lib.tsx` `clockTime`). The email read answers `now`, and the page judges the unlock on the server's clock as D701
  does (`clockOffset`): one timer to `unlockAt` (plus 1 s) re-reads the page once, and coming back to a hidden tab after
  that time re-reads it at once (`useReloadAt`, `pages/Apps.tsx`, shared with the app's `useReloadAtNextEffect`, D713);
  no polling (an answer saying "not yet" for a time past on its own clock sets no timer). When the server answers
  `executable` the status is **Ready to execute** and an owner's **Execute the change** runs it (a viewer is told only
  owners can); its line says this app's users can now sign in with email only when this app's email login is on, else
  that the scope now accepts email sign-in and step 1 is still needed for this app. Both steps' fresh sign-ins come back to this tab (D711). The
  wording assumes nothing: the scope is "the apps that share each user's wallet", the client `email:<scope id>` is
  named with "(<scope id> is your scope's ID)", the timelock is "a set time, so the other owners can cancel it". Turning
  it off is one in-page confirm, at once. Below: the app's mail per day (sent, bounced, complaints, refused), never an
  address.
- **The scope page** (`/orgs/:org/scopes/:scope`): its read answers `now`; the page judges its countdowns on the server's
  clock and re-reads once when the next waiting on-chain change unlocks ("Unlocked: any owner can execute it"), so its
  **Execute** appears without a reload
  (D713).
- **Audit**: each row keeps its action code under the title; its details read as words (times as dates, a null field
  as "none", yes or no, lists and objects as plain text, a value holding a separator quoted, keys in words), with no
  key hidden (D703 as amended by D704). The titles and the details' words are `@hana-id/console-core/audit-words`,
  shared with the admin's feed digests (D704): every audit action and app-change kind has a past-tense title ("Invite
  revoked", "Suspension lifted", …; `test/privacy.test.ts` wants one for each action), an unknown code reads as its
  words.
- **Users** (`/orgs/:org/users`): on where the env's manifest sets `console.usersScreen: true` (`gen` writes
  `USERS_SCREEN`; testnet only, sandbox-dev has it on, D702); off elsewhere, the tab hidden and its routes `404` (D357).
  It shows a user's email address only once the user shared it with one of the org's apps (D411); an app name that
  isn't one display-safe line shows as "Unnamed app" rather than hiding the user. The list sits in a card like every
  console table (`.jp-table-wrap` under the content; the others sit in panels); the User ID and the Support ID never break
  mid-id (the table scrolls inside its card instead, below about 1280 px wide); a wallet address shows as its ends
  (`0x4E2a…2f41`, `ui.tsx` `ShortValue`), with the whole address in its title, read out by screen readers and copied by
  its Copy button; an email address wraps only after its `@`. A user's detail shows each address in full, with a Copy.
- **Tables**: every table is the system's `.jp-table` in a `.jp-table-wrap` (surface, border, rounded corners); the
  long lists (Audit, Users, Usage, deliverability) are `.jp-table-wrap.tall`, so they scroll inside their card and their
  sticky header stays in view; numbers are `.num` (right-aligned, tabular). A bare table is a bug.

## Brand

The SPA wears the Journear Passport design system (D426 as amended by D765) from `packages/brand`: `web/src/styles.css`
imports `@hana-id/brand/fonts.css`, `tokens.css` and `components.css`, and the pages use the system's `.jp-*` classes
as they are (buttons, fields, alerts, toasts, badges, cards, tables, stats, tabs, setting rows, choice cards, the save
bar, empty and skeleton states). `styles.css` adds only the console's layout (the sidebar frame, the page header, the
checklist, the change timeline, keys, the consent preview) and reads only `--jp-*` tokens: no `--hana-*` variable, no
colour of its own, no Montserrat (`scripts/test/brand.test.ts`).

- **Colours**: the system's, light and dark through `prefers-color-scheme` (`<meta name="color-scheme" content="light
  dark">`). Brand teal for the primary and the current section; the stamp orange appears only in the lockup's chevron
  (one accent per screen); state keeps its own colours (success, warning, danger, info). The teal badge (Owner, Live)
  takes the link teal: the system's `--jp-primary` on `--jp-primary-soft` is 4.2:1 in dark. `scripts/test/brand.test.ts`
  checks every text pair the console adds is WCAG AA in both schemes; `packages/brand`'s test checks the system's own.
- **Type**: IBM Plex Sans for text (page titles 32 px semibold, card titles 17 px), IBM Plex Mono for ids, keys, hashes
  and code, Archivo only in the lockup's "PASSPORT"; tabular figures for every number.
- **Lockup**: `ui.tsx` `Lockup`, drawn inline (no image request): the mark from `MARK_FRAME`/`MARK_CHEVRON`, the
  outlined wordmark read from `logo/journear-wordmark.svg` at build time, and "PASSPORT" as text; 176 px wide (140 on a
  phone), teal and orange on light, the white variant on dark. In the sidebar and on the signed-out card, with
  "Partner console" under it. A partner app without a logo gets a neutral initial tile, never the brand's colours.
- **The select chevron** is the one image the system's `components.css` carries, a `data:` SVG: the CSP's `img-src`
  allows `data:` already, so nothing was loosened.
- **Fonts**: Archivo 500/700/900, IBM Plex Sans 400/500/600 and IBM Plex Mono 400/500 (SIL OFL 1.1, Fontsource's Latin
  builds, `FONT_FILES`). Vite bundles them as `/assets/<name>-<hash>.woff2` (never a `data:` URL: `assetsInlineLimit: 0`)
  and `vite.config.ts` emits their licences beside them as `/assets/OFL-Archivo.txt`, `OFL-IBMPlexSans.txt` and
  `OFL-IBMPlexMono.txt` (`FONT_LICENCE_FILES`); `scripts/test/spa-build.test.ts` checks each built font is the brand
  package's file byte for byte, the licences are there and the stylesheet loads nothing else.
- **Names** (D765): users read "Journear Passport" (the product, the page title), "Journear" (the company: "Contact
  Journear", "by Journear") and "Passport Home". Code identifiers keep `hana` (`createHana`, `@hana-id/*`, the
  `x-hana-console` header, `hana-signer`, the `HANA-` Support ID format).

## Patterns

The system's behaviour patterns, where they fit (`web/test/design.test.tsx`):

- **Toasts** (`web/src/toast.tsx`): a write's success (`useWrite` returning a message: "Key created", "Renamed.",
  "Executed: …") is a toast, bottom-right on a desktop and at the top on a phone, at most 3 (a fourth drops the oldest),
  gone after 5 s unless hovered or focused; a danger toast stays until dismissed. Errors stay inline (`ErrorNote`, a
  `.jp-alert-danger`), where the write was started. Final states of a page (an action's outcome, a cancelled change)
  stay inline alerts.
- **Settings as rows, with the save bar**: Login & sessions (a switch, two numbers, the optional Google client, the
  email-sharing choice cards), Branding's name and the Members page's Workspace domain. The save bar slides up at the
  first change, counts the changes, and offers Discard and Save. Save is immediate for the name ("Save changes") and is
  the same fresh sign-in as before for the others ("Review and confirm with Google": it builds the action and opens
  `/actions/:id`; nothing else about the step-up changed).
- **Validate on blur**: a field's error shows once the field is left (Session length, Idle timeout, the app name, the
  invite's address, Origins to add), then follows what is typed, so it clears as soon as it is right; Save or the submit
  stays off while a value is out of range, and nothing invalid is sent.
- **Optional fields** say "Optional" (the Google web client, the Workspace domain); required is the default.
- **Choice cards** where an option has consequences: email sharing (Off, When the app asks, At first login) and the
  invite's role (Viewer, Owner: "a viewer for the first 24 hours").
- **Stats strip**: an app's overview (active origins, working keys, pending changes) and email deliverability (codes
  sent, bounced, complaints). Usage adds nothing up (D373), so it has no strip.
- **One primary per view; danger behind a confirm**: `ConfirmButton`'s first button is secondary, its second the danger
  one (`tone="primary"` for a rotation, which removes nothing). The emailed cancel page's button is primary: the page
  itself is the confirmation and the cancel is a protective step.

## Commands

```sh
corepack pnpm --filter @hana-id/console test        # Worker, build/source/harness and SPA tests
corepack pnpm --filter @hana-id/console typecheck
corepack pnpm --filter @hana-id/console build       # vite build → dist/
```

## Local preview

A picture of the SPA for design review and screenshots, with no Worker, D1, session or Google. Dev only: the Vite
plugin in `preview/plugin.ts` runs only in `vite serve`, listens on 127.0.0.1, and nothing of it is built into `dist/`
(a build test). It answers `/api/*` with the fake data of `preview/fixtures.ts` (invented names, keys and hashes,
checked against console-core's schemas); writes answer success, or a typical refusal in the `errors` scenario, and
change nothing. It imitates none of the console's security checks. The Email login tab's state is picked with
`/__preview/<scenario>?email=<state>&to=<path>` (`off`, `stuck` (one step left), `waiting`, `ready`, `on`, `nochain`,
…; `preview/fixtures.ts` `emailStatus`); `unlocking` is proposed when picked and unlocks 60 s later, as sandbox-dev's
timelock does, to watch the page's one re-read turn it to **Ready to execute**.

```sh
corepack pnpm --filter @hana-id/console preview:web   # http://127.0.0.1:5178
```

Pick a scenario, then a page: `http://127.0.0.1:5178/__preview/<scenario>?to=<path>`. Scenarios: `owner` (the
default), `viewer`, `frozen`, `multi` (two organisations), `new-org` (no apps), `signed-out`, `errors`,
`not-chain-owner` (an owner whose Google account isn't an on-chain owner of the scope),
`session-ending` (4 min before the session's 12 h end: the warning) and `session-ended` (reads work, every write
answers 401: the "Your session has ended" banner; switch to `owner` in another tab, then Try again). The org is
`org_7Hq2Lm9Xc4`; its apps `app_Lm4Pq9Zs2v` (live, with changes waiting), `app_Ts6Ry1Hn8b` (test), `app_Rw2Bt7Kd5c`
(new, no origins), `app_Lg5Yn3Wq8d` (suspended). The fresh sign-in page's states: `/actions/act_demo_origin`,
`act_demo_policy`, `act_demo_settings`, `act_demo_invite`, `act_demo_owner`, `act_demo_ok`, `act_demo_failed`,
`act_demo_expired`. "Confirm with Google" in the preview marks the action done and comes straight back (no Google).
The invite and cancel pages: `/invite#t=<43 characters>`, `/cancel/gc_Ch4kq81Ns#t=<43 characters>`. The Users page
(`/orgs/org_7Hq2Lm9Xc4/users`) lists three made-up users, the third with a shared email; clicking a User ID opens
its detail.
