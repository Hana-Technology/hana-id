# Partner console (`apps/console`)

The partner console: one Worker (`hana-id-console-<env>`) on `console.origin` that serves the partner SPA and its
`/api/*` backend, with partner sign-in through console-auth. Routes, sessions, CSRF, fresh sign-in and the write paths
are in `docs/api.md` ("Console Worker"); the security properties in `docs/security.md` ("Console Worker").

Last verified: 2026-11-11 (branch `fix/console-users-table`, not merged, not deployed: the Users list in a card like every console table, its ids kept whole, its wallets shortened with a copy each, the header band's rounded corners, the preview's user detail); 2026-11-11 (branch `feat/designed-digests`, not merged, not deployed: "Audit": the titles and details' words from `@hana-id/console-core/audit-words`, shared with the feed digests, every code titled, a null field as "none", D704); 2026-11-11 (branch `fix/console-getting-started`, not merged, not deployed: "An app's page": changes in force never shown as waiting, the re-read at the next effective time, the snippet's environment, the install line's version, the Audit's details; the Users screen from the manifest; D701–D703; after review: "waiting" on the server's clock, "Unnamed app"); 2026-11-10 (branch `feat/partner-onboarding`, not merged, not deployed: the phone-width header and tables; Origins and Signing for an owner who isn't an on-chain owner, the preview's `not-chain-owner` scenario, D652); 2026-11-10 (branch `fix/testing-1110`, not merged, not deployed: the app's Email login page no longer shows the scope's internal id); 2026-11-09 (branch `feat/email-login-9`, not merged: the app's Email login page, D444, D447); 2026-11-06 (branch `feat/hana-brand`: Hana's brand, its tokens, fonts and mark, "Brand" below, D426);
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

- **Phone width** (≤ 760 px): the sidebar becomes one header block: Hana's gradient as a rule across its top edge
  (not under the brand text), the brand and Sign out on one row, the organisation on its own row, then the nav, which
  scrolls sideways. Wide tables scroll inside their panel (and keep their visually hidden headers inside), so no page
  scrolls sideways at 320, 375 or 420 px (checked with the preview, 2026-11-10).
- **CSP** `script-src 'self'; style-src 'self'; font-src 'self'`: no inline script or style anywhere, no `style` prop,
  no external URL; the only font files are Hana's own, bundled from `packages/brand` ("Brand" below); every style is a
  class in `web/src/styles.css` (light, and dark through `prefers-color-scheme`).
- **No HTML injection, no browser storage, same origin only**: checked over `web/src` by `scripts/test/spa-build.test.ts`.
- **Requests**: every write is `postJson`/`postBytes` (`web/src/api.ts`) with the CSRF header; a change marked
  "fresh sign-in" is built by `POST /api/orgs/:org/actions` and confirmed on `/actions/:id`.
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
  deployed apart from SDK releases, so it can't know which release Hana sent (D703).
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
  console table (`.table-wrap` under the content; the others sit in panels); the User ID and the Support ID never break
  mid-id (the table scrolls inside its card instead, below about 1280 px wide); a wallet address shows as its ends
  (`0x4E2a…2f41`, `ui.tsx` `ShortValue`), with the whole address in its title, read out by screen readers and copied by
  its Copy button; an email address wraps only after its `@`. A user's detail shows each address in full, with a Copy.
- **Tables**: a table directly in the content sits in a card (`.content > .table-wrap > .table`: surface, border,
  rounded corners, the header band rounded to match); a table in a panel gets the panel's inner frame instead. A bare
  table on the page background is a bug.

## Brand

The SPA wears Hana's brand (D426) from `packages/brand`, the set the staff admin console and the sign-in and approval
pages share: `web/src/styles.css` starts with `@import '@hana-id/brand/fonts.css'` and `'@hana-id/brand/tokens.css'`
and maps its own variables (`--ink`, `--accent`, `--ok`…) onto the `--hana-*` tokens.

- **Colours** (light / dark): ink `#16073a` / `#f1edfc`, page `#faf9fe` / `#0d0229`, cards `#ffffff` and `#f4f2f9` /
  `#170b36` and `#1f133f`, lines `#e6e0f7` / `#2c1b57`; the one accent Hana indigo `#3308a8` (dark: light purple
  `#bba8f6` with ink on it); focus `#6256e9` / `#c9a3f0`, as a two-ring outline; the gradient `#6256e9 → #7e5deb →
  #d772d3` only as the thin rule under the brand. State keeps its own non-purple colours (green, amber, red), so a
  state never reads as an accent; every text pair is WCAG AA in both schemes (`packages/brand` test).
- **Type**: Montserrat (400–700) for text, Montserrat Alternates (700) for page titles and the brand; tabular figures
  for numbers; ids and keys in the system monospace stack.
- **Shape**: pill buttons, badges and nav items (as hanawallet.io's), 16 px cards with a purple-tinted shadow.
- **Mark**: the Hana mark (`MARK_PATHS` from `@hana-id/brand`, Hana's own `hana.svg`) drawn inline in the sidebar and on
  the sign-in card; a partner app without a logo gets a neutral initial tile, never Hana's colours.
- **Sources**: Hana's apps' design tokens (`hana-app` `src/utils/designTokens.ts`, `hana-extension`
  `src/common/utils/designTokens.ts`) and hanawallet.io's stylesheet (`--lf-ink`, `--lf-line`, `--lf-accent-from/-to`,
  the `hana-*-purple` colours).
- **Fonts**: Montserrat Version 8.000 and Montserrat Alternates Version 7.200, the files Hana's extension ships, under
  the SIL Open Font License 1.1, subset to Latin as WOFF2 (about 17 KB each). Vite bundles them as
  `/assets/<name>-<hash>.woff2` (never a `data:` URL: `assetsInlineLimit: 0`) and `vite.config.ts` emits the licence
  beside them as `/assets/OFL.txt`; `scripts/test/spa-build.test.ts` checks each built font is the brand package's file
  byte for byte, the licence is there and the stylesheet loads nothing else. Hana's apps also use Proxima Nova and PP
  Agrandir: both are commercial and not shipped here.

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
change nothing. It imitates none of the console's security checks.

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
