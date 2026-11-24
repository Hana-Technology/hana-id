# @hana-id/e2e

The Playwright suite of batch B (`docs/batch-b-spec.md`, "Tests → Playwright"): the real vault, login, callback,
approval and export bundles of `@hana-id/web`, and the partner client, in Chromium, WebKit and Firefox.

```sh
corepack pnpm --filter @hana-id/e2e e2e:install   # once: the browsers
corepack pnpm --filter @hana-id/e2e e2e           # build + local stack + all three browsers
corepack pnpm --filter @hana-id/e2e e2e --project webkit tests/approval.spec.ts
cd apps/e2e && corepack pnpm exec playwright test --project=chromium tests/email.spec.ts   # one spec, one browser
HANA_E2E_PORT_BASE=4510 corepack pnpm --filter @hana-id/e2e e2e   # a base of your choice (a worktree has its own by default; not 5010: see below)
corepack pnpm --filter @hana-id/e2e test          # unit tests of the stack's mocks (part of `pnpm -r test`)
corepack pnpm --filter @hana-id/e2e staff-demo out-of-money   # the staff admin portal's hand test: a relayer state (below)
corepack pnpm --filter @hana-id/e2e staff-demo labels-waiting # … or a partner's request labels in the staff feed (below)
corepack pnpm --filter @hana-id/e2e hand-browser   # a headed Chromium with the suite's Google stub and NEAR relay, for a person (below)
```

The hosted demo's NEAR card (D750–D754): `tests/demo.spec.ts` writes to the guestbook on the mocked NEAR testnet
(`src/server/chain.ts`: users' implicit accounts, `block`, the guestbook's `get_messages`, and the test-only
`e2e_near_activate` / `e2e_guestbook_add` the mocked relayer routes call, `src/near-relay.ts`, shared with the hand
browser); `tests/demo-near-shots.spec.ts` saves
its screens with `HANA_SHOTS_DIR=<dir>` (Chromium only, skipped otherwise).

The stamps site (`apps/stamps`, D798–D802): `tests/stamps.spec.ts` signs in by email, collects Arrival, Sponsored,
Postcard and Signature through the mocked relayer routes and sees them on the public passport, with no CSP violation
and nothing of another chain on the page. The mocked chain serves the stamps contract (`src/server/stamps-contract.ts`:
`get_passport`, `recent`, `totals`, `catalog`, every `collect` rule, the signature's NEP-413 proof checked with ed25519
as on chain) and the test-only `e2e_stamps_collect` the relayer routes call. Signature's two approvals land in one
window with no launcher; a second test holds the vault's key check, closes the window after the first approval and
collects through the slot's Continue (D807).

The support pages (D866): `tests/support-pages.spec.ts` locks an address with wrong codes (the dev envs' backstop),
sees the sign-in window refuse it, has staff unlock it, opens the mailed link, checks nothing happens before the
button (the token can't be used), presses it once (a double click is one request), and signs in; and bounces an
address, sees no code sent, has staff unsuppress it, presses the confirm page's button, and signs in. Staff calls and
bounces go through the issuer's real routes: `POST {ISSUER}/__e2e/staff {action: 'unlock' | 'unsuppress', email,
ticket?}` (a Cloudflare Access JWT the stack signs with a throwaway key; the issuer's Access check fetches the certs
from `e2e-access.invalid`, answered in the stack's process) and `POST {ISSUER}/__e2e/bounce {email, event?}` (a
SendGrid event signed with a throwaway P-256 key). Both no CORS, refused with an `Origin`. With `HANA_SHOTS_DIR=<dir>`
(Chromium) it saves each page at phone width before the button, after it and expired (the issuer's `410 link_expired`
routed in the browser), and the two mails. The in-memory Durable Object alarm waits past Node's longest timer (24.8
days) instead of firing at once (a staff action's 30-day log). With `soonAlarmMs` (the relayer's, on the main stack and
the hand-test lane) only an alarm set from outside the handler (or an outside `sync()` while one at most 15 s away is
pending) fires after that short delay; one the handler sets for itself keeps its time (`src/server/workers.ts`,
`MemoryStorage`; `test/stack.test.ts`, D882).

Passport Home's shell (D888): `tests/home-shell.spec.ts`, in all three browsers. A Google account at 1280 × 720,
390 × 844 and 320 × 568 reaches the move flow's guarded Continue with the API's own derive, its Home sign-in made 4
minutes long by a `GET /v1/home/config` whose server time is 11 minutes behind. On the desktop a focused Copy button
sits 16 px under the stuck bar when the sign-in's notice comes: it moves down by the bar's growth and stays uncovered.
On the phones Continue keeps its place in the window. The end keeps the warning's height; Continue is off again after
each change and after signing in again, then can be armed; the heading, Back, Continue and a Copy button focused by Tab
(Option+Tab in WebKit) are each the element at their own centre; a failed copy's line moves nothing. An email account
with a long address, at 390 and 320 px: the end by the API's 401 on a search (the who line keeps its height when the
address is masked), a sign-in again by code in the bar (its controls reachable at 390 × 844, 320 × 568, 640 × 360 and
320 × 300; a toast stays in the window at 320 × 568 and 640 × 360), then the notice; the page's clock only moves
forward. The page has one `header`, no `nav`, and a skip link that moves focus to `main#app` without changing the
page's address.

Passport Home's views and Back (D893): `tests/home.spec.ts` walks the front page as rows (opened with a click, Enter and
Space), the headings and the window's title of each view ("Your wallets", "Wallet details", "App details", "Devices and
auto-approve"), each group's empty and failed state, and, in all three browsers, Back and Forward: one entry per view
at the same address holding only `home:{tag}:{step}`, Back to the list with focus on the row, Forward to the view,
"Your wallets" back to the list's own entry, Back from the list leaving Home, nothing read by Back or Forward, no
storage; after the sign-in ends Back and Forward still move between what is on screen, and after Sign out they show the
signed-out page only. `tests/home-export.spec.ts` "D893: the browser’s Back out of an open wallet" shows a derived key,
goes Back (the key is erased from the page), then Forward (the page with the move flow collapsed, no key, no new derive).
`tests/home-devices.spec.ts` opens Devices from its row under "Your account" (one read) and at `/home?view=devices`
(one read, then Back to the list and Forward without a read). The rows' locator is `homeRow(page, appName)`
(`tests/home-steps.ts`) or `.home-row[data-scope="…"]`.

A wallet's tabs and the phone's chip (D895): `tests/home.spec.ts` checks the tabs' roles and names, the keyboard (the
arrows move, Enter and Space open), a history entry only for "Move wallet" (D901: Back from it returns to the tab it
was entered from, Addresses ↔ Security and "Move wallet" ↔ another tab, many times, leave one entry over the wallet's),
and no sideways scroll at 390 px;
360 and 430 px too, Back from "Move wallet" to a tab bringing the tab list into view and Shift+Tab back to the open tab; and the chip at
320, 360, 390 and 430 px: hidden until the ending notice is scrolled out of view, then shown at every scroll position on
the list, Addresses and Security with the last control clear above it, never on Move wallet, pressed it brings the
notice back with focus on its "Sign in again"; never on a desktop; at 195 px (200 % zoom) the tabs and chip in the window. The Home specs open a tab with `homeTab(page,
'Addresses' | 'Security' | 'Move wallet')` (`tests/home-steps.ts`): the move flow is on "Move wallet", the devices, ways
to sign in and the card "What these apps get from you" (the email sharing and the name, D901) on "Security".
`tests/home-export.spec.ts` checks that leaving "Move wallet" by Back, another tab or "Your wallets" erases a shown key
(the real derive, three browsers), and that Forward back to it after another tab shows it collapsed. `home-shell.spec.ts` measures the guarded Continue on NEAR's confirmation (the
longest, so the Move tab alone scrolls) and the email account's notice with a Security tab button in view.

The Security tab and Home's polish (D897): `tests/home-devices.spec.ts` checks that opening Security makes one devices
read (none on Back or Forward, one more on the wallet's next visit) with the focus left on the tab, each section's line,
"Show devices" with no second read, the email part of "What these apps get from you" (D901: its line from that read,
"Show email sharing", its stop's confirmation, Cancel and outcome in the card, the card's singular title for one app), and the device card at 320, 360, 390 and 430 px (each site and date on one line, the
app's words on their own line, the full date as the tooltip and the screen reader's text). `tests/home.spec.ts` checks
every view at 195 px (no sideways scroll, the top bar included, light and dark) and an open device card with long dates
there, every control at least 44 px tall at 320, 360, 390 and 430 px (an open stop confirmation's "More" included; Sign
out by its tap area), the focus ring on every control the keyboard reaches in both themes (WebKit with Option-Tab,
as Safari), and the wallet's head at 1280 px (the apps under their label, the answer's "No." read and not shown).

Passport Home's "Ways to sign in" (D874): `tests/home-sign-ins.spec.ts` checks Home reads nothing until "Show ways to
sign in" and then exactly `get_identity` and `get_account`; an email-only wallet's one line (the address, signed in now,
can't be removed, no other button); a waiting email linked to a Google wallet (case B) listed as waiting by kind only,
cancelled where its line points (the banner's "Cancel this link" at a Google sign-in), then one line again; a link past
its waiting period (`POST /__e2e/links/expire`) removed by the email's own sign-in (D865), then one line, and that email's
next sign-in a new wallet, alone in its own Home list; D875, a link 8 days old (`POST /__e2e/links/age`, every member of
that root started `ageMs` ago): Home's plain "choose “Remove it”" line, the Google sign-in's one quiet line with "Don’t recognise it?" and a small Remove it (D887; the
app's result in before Done), after Done the next sign-in's window closing by itself, then, the browser's `hana.ol.` keys cleared
as a private window would have them, Remove from that line, and one line in Home; a failed read (both NEAR endpoints answering a JSON-RPC error,
then only the second: Home needs both to agree) and Try again. Every page on the sign-in origin (Home and the sign-in
windows) fails on a CSP violation, an uncaught error or a console error other than the two browser lines the spec names
exactly (`ALLOWED_BROWSER_LINES`: the D347 signal refused when its opener isn't a vault frame, and Firefox's aborted
font download of the origin's own IBM Plex files). With `HANA_SHOTS_DIR=<dir>` (Chromium) it saves the screens at 390 px, light (D875's `home-sign-ins-member-older` and
`sign-in-older-line` among them).
D902 (D898 option B): a waiting email in a wallet on the shared Google client shows Home's own **Cancel this link**
(44 px on a phone; no "sign out of it first"); the confirmation and Go back; Cancel the link opens the child, Google's
chooser (`max_age=0`), then "Cancelling the link" (the request held until seen), "Link cancelled", the line and the row
changed without a reload, one `POST /v1/home/link/cancel`, and Show again agreeing; another Google account at the
check: "Nothing changed", nothing sent, the row as it was; an answer nobody can read (a routed `504 timeout`): "It may
not have been cancelled", the row kept, Show again. Option A's test now gives its wallet a coverage other than shared.
With `HANA_CANCEL_SHOTS_DIR=<dir>` (Chromium) it saves each of these screens at 390 and 1280 px, light (`cancel-offer`,
`cancel-confirm`, `cancel-signing-in`, `cancel-working`, `cancel-done`, `cancel-nothing-changed`, `cancel-unknown`).

Gas-free EVM actions (D838, D847, D851, D855, D856): `tests/evm-sponsor.spec.ts` runs `hana.evm.sendSponsored` from a
click through the vault's prepare, one approval and send against apps/api's **own** sponsorship routes (the session
proof, the allowlist and every check) and the **real relayer object** (`EvmRelayer`, in memory), which signs with the
stack's relayer key (`src/relayer-key.ts`: made at the first run, kept in `.build/`, never committed; the bundles pin
its address) and broadcasts to the mocked EVM chain (`src/server/partner.ts` `MockEvm`: each sender's own count, each
sponsored transaction mined at once and run as the delegate would: the setup's designator, the delegate nonce,
`Executed(digest)`). Chain 31337 has ONE endpoint (allowed only in a `local*` env) and `requireKnownAccount: false`
(the session's wallet proof ties the account to the user). The stack's API only counts the routes' answers and can hold
an app's sends: `POST /__e2e/evm-sponsor {account, delegation}` sets an account's code on the mocked chain ("set up by
another app" is `other`); `{appId, hold}` holds its sends; `GET /__e2e/evm-sponsor?appId=` counts. Covered: the first
action and its setup note, a later one, a decline, the D840 refusal, a second action while one is in flight, viem's
EIP-5792 `sendCalls`, the D833 typed-data refusal. With `HANA_SHOTS_DIR=<dir>` (Chromium) it saves
`sponsored-first-time(-details)`, `sponsored-later` (the demo check-in), `sponsored-token-first-time`,
`sponsored-token-later`, `sponsored-unknown-call` and `sponsored-approve-warning`. Each test uses a scope of its own,
so each has its own account.

The hosted demo's gas-free check-in card (D867): `tests/demo-gas-free.spec.ts`. The demo's build carries the stack's
sponsored chain (`DEMO_CONFIG.evmSponsor`), the API sponsors the demo's app (`DEMO_PK`) for exactly the check-in
(`E2E_DEMO_SPONSOR_TARGETS`: `exactCalldata` `0x183ff085`; every other app keeps `E2E_SPONSOR_TARGETS`), and `MockEvm`
runs a batch's exact check-in as `CheckIn.sol` does (the per-account count, `CheckedIn`, `checkIns(address)` for
`eth_call`). Each test signs in with a Google account of its own. Covered: the first check-in (setup note) and the
second (none) with the count, a rejection, the day's budget used up and paused (prepare's and status's answers changed
by a route in that test's browser context only), and no card for an app that isn't sponsored. With
`HANA_SHOTS_DIR=<dir>` (Chromium) it saves `card-{idle,in-progress,done,refused-budget,paused}-{phone,desktop}` and
`window-first-time-{phone,desktop}`.

The approval window's plain summary (D808–D813): `tests/approval-summary.spec.ts` checks the details always start closed
and the user opens them (mouse and keyboard), for a request the summary explains, one it can't (its red risk line in
view) and raw signing (live mode), and that a warning stays in view while they are closed. With
`HANA_SHOTS_DIR=<dir>` (Chromium only) it also saves each request kind's window at the popup's real size (420 × 680,
the whole page): NEAR relayed call (closed and open), NEAR transfer, NEP-413, EVM send, ERC-20 transfer and unlimited
approve, an ERC-20/721 approve of 0, an unknown call, an EIP-2612 permit, a message, a Stellar payment, an
account-control change, a payment after six steps that move nothing, an offer and a Soroban call whose authorization holds another token move, 100 NEAR actions
with one full-access key, the mainnet demo's Stellar payment, and raw signing (from the live-mode test). It drives the partner app's `stellarSignXdr`, `ethSignTypedData`, `nearSignTx`,
`nearSignDelegate` and `nearSignMessage` actions with requests the test builds.

The plain-wording review (D853, D858–D860): `tests/approval-plain-shots.spec.ts` saves, with `HANA_SHOTS_DIR=<dir>`
(Chromium only, skipped otherwise), the screens the founder reviews: the stamps demo's relayed NEAR call for a test app
and a live app, an EVM transfer of a listed token (USDC on Base Sepolia, posted to the popup as its vault would: the
partner page knows only the local chain) and of an unlisted one, an unlimited permission, an unknown call, a NEAR
full-access key, a Stellar payment, the sponsored check-in and the screen after Reject; and, for D884 (where the network
fee is), each of the sponsored check-in (first time and later), a sponsored unlimited permission, a sponsored call that moves nothing Journear sees, the relayed NEAR call
(and one that attaches NEAR), an EVM send, a NEAR transfer and a Stellar payment at 390 px and at the popup's size,
folded and with the details open (`fee-{case}-{main|details}-{phone|popup}.png`); and, for D886, a Stellar message,
an EVM message (and one Journear can't read), typed data with and without a network and a NEAR message, for a test app and a live app, at 390 px
(`msg-{kind}-{test|live}-phone.png`). It checks only the dividers (below), softly, so every screen is still saved.

The approval and consent windows' dividers (D884's note): `tests/divider-checks.ts` measures the page as drawn: no two
lines (a list's rule, a box's edge) close together with nothing between them unless both are box edges, no ruled block
around nothing, the same space above and below every rule, and a rule between any two consecutive operations or
consent contract lines (an operation's own rule under a box that ends the one before is that boundary, not a double);
it fails when it finds no window or no lines. `tests/approval-dividers.spec.ts` runs it as a gate (every browser) on
an EVM send, the sponsored check-in (later and first time), a sponsored unlimited permission, a sponsored batch whose
first call Journear can't read, a relayed NEAR postcard with its note, a NEAR transfer, a NEAR call with JSON and
with non-JSON arguments then a transfer, a message and one Journear can't read, a Stellar payment, two Stellar
operations, a Soroban call with a nested authorization and the consent screen (two contract lines), at 390 px and
the popup's size, folded and open (with `HANA_SHOTS_DIR=<dir>`, Chromium, it also saves each as
`dividers-{name}-{phone|popup}-{main|details}.png` and records a failure without stopping). The screenshot specs
(`approval-plain-shots`, `approval-near-reviewed-shots`, `approval-summary`, `evm-sponsor`) run it softly on every
screen they save; no flow test asserts it. Every screenshot in these specs waits for the page's fonts
(`fontsLoaded`), so two runs draw the same text the same way.

The mainnet demo (D428) and the export's guarded reveal (D430): `tests/mainnet-demo.spec.ts` (Horizon and Base's RPC
routed, never the real network). With `HANA_SHOTS_DIR=<dir>` it also saves its screens there (Chromium only; a shown
key is masked). Buttons behind the guard (Approve, the export's Continue and Show key) take `approve()` or
`guardedClick()` (`tests/fixtures.ts`): wait 1 s, move the pointer, then click. The first click on a freshly loaded
popup's first screen (the email step's Send code) takes `clickUntilTaken()`: under load Firefox can lose the press of
a click sent to a new popup (`mouseup` with no `mousedown`, so no click), though Playwright's checks pass. It clicks again
only while that same element is still in the page, so a click the page took is never repeated.

An unfinished login (`tests/abandoned-login.spec.ts`; the follow-up screens in `tests/linking.spec.ts`, the demo's in
`tests/demo.spec.ts`): the popup left on the method chooser, Google's page, the email address or code step, a link
code screen or a banner, or closed (on the chooser: `login_cancelled` within seconds, D347, in real time). The tests install Playwright's clock (`page.clock`, for the whole context: the
partner page, the vault frame and the popup) and fast-forward past the vault's 5-minute limit; `responsive(frame)`
(`tests/fixtures.ts`) checks the vault frame and the partner page still run a script. In all three browsers the
partner page shares the vault frame's renderer here, so a loop in the vault freezes it too.

Popups that close themselves (a banner's Done, the Close on what became of a banner's Remove or Cancel, D881, the email step's Cancel, the callback after its relay): click
them with `clickClosing(popup, selector)` (or `clickMayClose` when the click only sometimes closes the window), and
wait with `closeOf(popup)`, never a bare `popup.waitForEvent('close')` (`tests/fixtures.ts`). A window that closes
while Playwright still performs the click makes the click reject with "Target page, context or browser has been
closed"; the helpers drop that error only when the window is in fact closed. `waitForEvent('close')` on a window that
has already closed waits for its whole timeout.

## Trying sign-ins and NEAR actions by hand: the hand browser (D880)

A person's own browser on the stack can't sign in with Google (the bundles keep Google's real endpoints) or write to
the guestbook (the stack's API has no NEAR relayer: `503 relayer_unconfigured`): the tests supply both inside their
browser context. `corepack pnpm --filter @hana-id/e2e hand-browser [--tag <tag>]` (`src/hand-browser.ts`, with the same
`HANA_E2E_PORT_BASE` as the running `serve`) launches a headed Chromium whose one context has exactly those routes
(`src/hand-test.ts`):

- `routeStubs` (`src/browser-routes.ts`, moved out of `tests/fixtures.ts`, which re-exports it and installs it in every
  test's context): the Google stub, the foreign site, live mode's origins. The stub's chooser lists six named test
  accounts fixed by the tag (`handAccounts`): Ada (a Gmail address: case A), Ben, Cleo, Dev, Eve (a made-up domain: case
  B waits 24 h) and Finn. One stub for the whole context, so popups and new tabs share it.
- `routeNearRelayer(context, ['demo', 'stamps'])` (`src/near-relay.ts`): the NEAR relay mock `tests/demo.spec.ts`,
  `tests/stamps.spec.ts` and `tests/demo-near-shots.spec.ts` use, chosen by the request's Origin (a request from another
  origin falls through to the API). A call that isn't the site's own (another key, receiver or method, a deposit, over
  10 Tgas) is answered `400 e2e_relay_mismatch` and kept in `problems`, which those specs assert empty.
- A start page at `http://hand-test.localhost/`, answered by a route (never by the stack): the local sites, the
  accounts with their addresses, and buttons that call the stack's test-only controls from the script's process (they
  refuse any request with an Origin): `POST /__e2e/links/expire` (**Make its waiting link take effect**),
  `POST /__e2e/links/age` 8 days (**Make its link 8 days old**), the outbox's newest code (**Show the latest code**), and
  clearing the sign-in origin's `hana.ol.*` keys as a private window would (**Forget “Done” in this browser**, D875).
  It answers only POSTs with its own Origin and an `x-hand-test` header. The same helpers from the terminal:
  `hand-browser expire|age|code <name>` (the tag of the browser opened last on that base, `.build/hand-browser-<base>.json`).

No `bypassCSP`, no disabled web security, no product change: the pages run with their own CSPs, as in the suite; CSP
violations and page errors are printed in the terminal instead of failing. The browser runs until every window is
closed (or Ctrl+C, or the browser goes away), then the command ends with 0. It warns, and still runs, when the stack's
fingerprint isn't this checkout's. `--headless` is for checks only. The steps a person follows: `docs/operations.md`
"Trying sign-ins and NEAR actions by hand on the local stack". `tests/hand-browser.spec.ts` (Chromium) runs those flows
headless through `openHandSession` by the pages' labels (flow D goes on to the email's next sign-in: "Don’t recognise
it?" and Remove it under the Google account's banner, which asks first, D887; with `HANA_SHOTS_DIR` it saves
`sign-in-auto-link-recent-390` and `-popup-480x640`); `test/hand-browser.test.ts` checks the hand browser's route
set equals `routeStubs` + `routeNearRelayer` plus only its start page, that no spec routes Google or `/v1/near/*`
itself, the accounts and the start page's Origin check; `test/near-relay.test.ts` the relay's answers.

## What runs

Ports are `HANA_E2E_PORT_BASE` (default 4410 in the main checkout; a linked worktree's own base, below) plus the offsets
below: the table shows 4410.

| Origin | Serves |
|---|---|
| `http://localhost:4410` | the partner test app (`partner/app.ts`): `createHana`, viem, wagmi, Stellar Wallets Kit 1.9.5 and 2.7.1 |
| `http://site-b.localhost:4411` | the same app on a second partner site (the storage-partitioning case) |
| `http://localhost:4412` | the hosted demo (`apps/demo`), built for the e2e env and served by its own Worker handler with its real CSP (`tests/demo.spec.ts`) |
| `http://localhost:4413` | the stamps site (`apps/stamps`), built the same way with its Worker handler and CSP (`tests/stamps.spec.ts`) |
| `http://127.0.0.1:4420` | `vaultOrigin`: apps/api's vault host, and the vault page rendered by apps/api's `handleVaultPage` from D1 |
| `http://127.0.0.1:4430` | `authOrigin`: apps/api's auth host over the built auth pages |
| `http://127.0.0.1:4440` | the Hana API: apps/api's Worker, with `/v1/login`, `/v1/derive`, `/v1/sessions/revoke` and `/v1/link*` mocked; plus `/__e2e/*` control endpoints (`/__e2e/google-key`: the stack's Google signing key; `/__e2e/chain`: what the relayer sent to the mocked chain) |
| `http://127.0.0.1:4442` | the email issuer: apps/email-issuer's Worker with the `outbox` stub; plus `GET /__e2e/outbox` (the mails, for the tests) and `GET /__e2e/directory?sub=` (one identity's rows in the user directory, D269) |
| `http://127.0.0.1:4443` | the staff admin portal, hand-test lane: apps/admin's Worker and SPA behind the stack's Cloudflare Access stand-in (below); sign in at `/__e2e/access/sign-in?as=staff` |
| `http://127.0.0.1:4444`, `:4445`, `:4446` | the same, one lane per browser project (Chromium, Firefox, WebKit) for `tests/admin-portal.spec.ts` |
| `http://127.0.0.1:4450`, `:4460` | mocked NEAR RPC and EVM chain RPC |
| `http://127.0.0.1:4451` | the same mocked chain as the env's `rpcFallback`: a member's path is confirmed on both (D263) |
| `http://127.0.0.1:4421`, `:4431`, `:4441` | live mode's vault, auth and API hosts (below): reached only through the tests' routes |

Both partner sites are cross-site to the Hana pages, as in production, so the vault frame is a third-party frame on
each: `localhost`, `site-b.localhost` and `127.0.0.1` are three sites (ports don't count). Site B is a `*.localhost`
name rather than `[::1]` because CSP source expressions have no IPv6 form: no browser lets a `[::1]` page embed the
vault through its `frame-ancestors`.

The API is `apps/api/src/index.ts` itself, run in Node: routing, CORS, the app gate and origin rule, `GET /v1/app`,
the vault endpoints (KEK wrapping, counters and the real SQL on `vault_shares`) and the login relay (the `LoginRelay`
Durable Object class, on in-memory storage). Only `/v1/login` and `/v1/derive` (and batch 8b's link calls, below) are mocked (`src/server/api.ts`), after
the Worker's own app gate, since they need the relayer and the MPC. The mocked `/v1/login` applies the Worker's own claim
allow-list (apps/api `claims.ts`: a Google token with any other claim is `400 token_has_pii`), and every transaction the
mock relays with a token (`create_session_and_derive`, the link methods) is recorded with its identities and claim
names, never the token: `GET {API}/__e2e/chain[?sub=<sub>]` lists them (of that `sub`) and counts the live sessions on
its path, which is how a test asserts that nothing reached the chain. The rate limiter object and the vault's Rate
Limiting bindings always allow (and the limiter grants every single-use marker): every page in the suite is one
client, and apps/api's tests cover the limits. The partner identity token is the real one: the stack gives the Worker
a fresh throwaway P-256 key pair, a standby and a sub key per run (`identityBindings`), and `tests/identity.spec.ts`
verifies the tokens the page gets with `jose` against the stack's own JWKS (`{API}/v1/identity/jwks.json`).

The mocked NEAR RPC (`src/server/chain.ts`) answers the vault's and the export window's reads (`get_session`, tx
status, and the login's registry check, `get_scope` / `scope_for_client`, D56) and the Worker's (`get_session`,
`get_scope`, `get_config`).

Hana Home's derive, `POST /v1/home/login`, is not mocked (`tests/home-export.spec.ts`): the Worker's own handler runs
whole (the Home identity gate, the token's signature against the stack's Google key, the nonce, the chain reads,
`home_usage` in D1, the directory writes). Only the `home` relayer pool's key object behind it is stood in for
(`relayHome` in `src/server/api.ts`): it applies `create_session_and_derive` to the mocked chain and answers with the
test MPC instead of signing a NEAR transaction. For that handler the mocked chain also answers `session_key_in_use`
and `get_issuer("google")` (the stack's Google kid). `POST /__e2e/apps` takes `launched: true` to set the app's
`first_login_at`, which the Worker's own `/v1/login` sets and the mocked one doesn't: Hana Home then lists the app to
a user the wallet directory has no row for (a linked member's row is also written by the Worker's own login only).

The demo (`apps/demo`) is bundled by esbuild from its own `index.html` and `src/main.ts` with a configuration for the
stack (`DEMO_CONFIG` in `src/build.ts`: the e2e env, the mocked EVM chain, its sponsorship). It bakes its key in at build time, as the
deployed demo does, so its app has a fixed key (`DEMO_PK`): `POST /__e2e/apps` with `publishableKey` creates it once
and returns it after that, and every demo test and browser shares it (each test still has its own browser context);
every demo spec creates it with `DEMO_APP` (`src/site-apps.ts`, re-exported by `tests/fixtures.ts`, named "Journear
demo", email sign-in on since D880; the hand browser creates the same app).
The stamps site is built the same way (`STAMPS_CONFIG`, its fixed key `STAMPS_PK`, the contract `e2e-stamps.testnet`).

The bundles are built by `@hana-id/web`'s own per-env build scripts for `local-e2e`, an env defined in `src/stack.ts`
(not in `envs/`, so the published client never lists a loopback env). Its CKD key belongs to a test MPC
(`src/server/chain.ts`, real BLS12-381), so the vault's pairing check runs as on testnet. D1 is node:sqlite with
apps/api's migrations.

Email login (`tests/email.spec.ts`, build plan batch 8a) runs apps/email-issuer's own Worker in Node
(`src/server/issuer.ts`) on its own origin, as on sandbox-dev (D230): its handlers, its `Challenge`, `RateLimiter` and
`Outbox` objects on in-memory storage, its D1 migrations, and the API's real read-only `IssuerRpc` (on the API's D1) as its `API` binding (D434). Mail goes to the `outbox` stub
(`local*` envs only), which the tests read through `GET /__e2e/outbox?to=<address>` (no CORS, refused with an
`Origin`). The stack makes a throwaway RSA signing key and HMAC keys per run; the mocked chain lists the key as the
active `email` key of signer `hana` and gives every scope its email client, so the vault's on-chain token check passes,
and `POST /__e2e/apps` takes `loginMethods: 'google,email'` to turn email on for one app. Each issuer request gets a
fresh client address from 198.18.0.0/15 (`cf-connecting-ip`), since every page in the suite is one client; the
per-address limits stay real, so each test uses its own address.

Linking (`tests/linking.spec.ts`, build plan batch 8b): the mocked chain keeps contract v3's accounts and links (the
`opened` set, accounts by root identity key with their members) and answers `get_identity`, `get_account` and
`get_config().unrecorded_wallets = false`. The mocked `/v1/login` resolves the path as the contract does (an active
member opens its account root's path, a pending one is `409 link_pending`), checks the session signature over the
linked CKD payload when the body carries `linkJwt`, applies the link (case A: the Google identity joins the email
wallet's account at once; else the email identity joins, at once or pending 24 h), and marks the path's identity
opened. `/v1/sessions/revoke`, `/v1/link`, `/v1/link/cancel` and `/v1/link/unlink` are mocked the same way (they need
the relayer); the vault's own D133 and D139 checks are what the specs exercise, the API's link precheck has its own
tests in apps/api. The vault page's CSP names the issuer (`EMAIL_ISSUER_URL`), since the vault calls google-match.
Each test uses its own Google account and addresses: links are per scope, and the stack's test apps share scope `e2e`.
A linked member's key export (Google joined to an email wallet) is exported from the member: the export window
confirms the root's path on `rpc` and on `rpcFallback` (`:4451`, the same chain on a second origin, D263), and the
test checks both answered its `get_identity` reads, so an export page CSP without the fallback fails it
(`path_unconfirmed`).

Google is never contacted. In the browser, each test's context routes `accounts.google.com/o/oauth2/v2/auth`,
`www.googleapis.com/oauth2/v3/certs` and `oauth2.googleapis.com/tokeninfo` to an OIDC stub (`src/google-stub.ts`)
that takes exactly the popup's requests. The bundles are built with the flow in force, `'token_first'` (D270, on since
the spike passed on 2026-11-04), and the stack's env has an email issuer, so every Google login of the suite runs it:
the access token request with the account chooser (`response_type=token`, `scope=openid email`, no nonce; each
chooser link carries an access token), tokeninfo from the callback (a form POST answered with Google's CORS for the
page's Origin, as the spike's leg E saw; `google.tokeninfoCors = false` answers for another origin instead, since
Playwright adds a missing `access-control-allow-origin` to a fulfilled route itself), then the silent openid-only ID
request (`login_hint`, `prompt=none`, the login's nonce; an account's `silentIdError` makes Google answer it with that
error, and D273's interactive retry, the same request without `prompt`, is answered). It also takes batch B's
openid-only login with the chooser (the export window's, and a record-only login's fallback when tokeninfo can't
answer), a proof the vault asks for (`login_hint`, answered at once), and `second_request`'s request for the email
scope (`response_type=token`, `scope=email`, `login_hint`, `prompt=none` or none; D264's "Try Google again" too).
`google.kinds` lists each request's kind in order (`token_first`, `id`, `login`, `proof`, `access`) and
`google.tokeninfoCalls` each tokeninfo call's account. It refuses an ID token with the email scope, and signs RS256
tokens with the claims Google sends for `scope=openid`; an account with `emailInIdToken` gets `email` and
`email_verified` in its ID token too (a Google that leaks the address: `tests/login.spec.ts` checks the login popup's
callback refuses it before relaying it, D273, so only `{error: 'token_has_pii', claim}` crosses the relay, the SDK gets
`token_has_pii` with the claim, no `/v1/login` call is made and nothing reaches the chain). `google.issued` lists each
token's account and claim names. `tests/token-first.spec.ts` covers the flow itself: the requests, tokeninfo, D273's
retry, tokeninfo unreadable (an app with email login ends `tokeninfo_unavailable`; a Google-only app falls back to the
chooser and records nothing), the address in the issuer's directory (google-record for a Google-only app, google-match
for one with email login, read through `GET {ISSUER}/__e2e/directory?sub=`: no CORS, refused with an `Origin`) and
that every token on the mocked chain is openid only. `tests/google-cancel.spec.ts` covers a cancel on Google's
screen (the stub's `#deny`, Google's `access_denied`; D341): back to the chooser (an app with email login, a
Google-only app) or to case B's choices, Google again signs in under a fresh OAuth state, email from the chooser
signs in, and closing the popup there (or case B's Cancel) gives `login_cancelled`. `tests/popup-close.spec.ts` covers
D347: closing the popup on the chooser, on Google's page (past the 8 s COOP window), on the email code step and on a
follow-up screen gives `login_cancelled` (`popup_closed`) within seconds, and a slow trip to Google and back signs in;
a close a couple of seconds after reaching Google's page gives the same at D398's 90 s deadline (the page's clock
fast-forwarded; from the chooser's click and from a Google-only app, in all three browsers: the page leaves for Google
only once the vault acked its `google` signal, D400), and with the stub enforcing COOP (Chromium and Firefox) the
account chosen in time still signs in. `page.clock.install()` lets time run on in real time; `fastForward` moves every
overdue timer to the target time and runs ties in creation order, so a test that fast-forwards past two timers can't
tell which a user would see first (abandoned-login's chooser close waits in real time for that reason, D400).
`tests/login.spec.ts` checks that
another Google error (`server_error`, sent to the callback directly) still gives `google_error`. The `second_request` flow is covered by `@hana-id/web`'s unit and
vault-harness tests only (the bundles have one flow compiled in). `tests/webcrypto.spec.ts` (D385) checks, in
every browser, that the WebCrypto calls Hana's pages make accept keys starting with zero bytes and give Node's bytes
(AES-GCM and HKDF raw imports, Ed25519 raw public import and verify, the session key's generate, sign and export, RS256
JWK verify): WebKit's Linux ports refuse such keys in Ed25519 generateKey (D381) and in PKCS#8 private imports, which
Hana doesn't make. `tests/login.spec.ts`'s D385 case gives a browser without Ed25519 `derive_failed`
(`webcrypto_unsupported`). On the server side
(`src/server/google-backend.ts`), the stack answers Google's JWKS, `tokeninfo`, `userinfo` and revoke (which the
issuer must never call, D265) for the Workers in its process (the issuer's google-match and google-record), by wrapping
that process's `fetch` for those three Google hosts; the browser's tokeninfo route gives the same answer
(`tokeninfoAnswer`). One RSA key per stack signs every ID token: the browser stubs fetch it from
`GET {API}/__e2e/google-key` (no CORS, refused with an `Origin`), so the issuer's JWKS cache always knows the kid.
Access tokens are self-describing test values (`ya29.e2e.<b64url JSON>`: the client, sub, email, email_verified, hd)
that `tokeninfo` and `userinfo` read back; a test sets its accounts' email and `hd` on `google.accounts`. Production
bundles keep the hard-coded Google endpoints; nothing in them can select the stub.

The ports are fixed for a run (the bundles inline the origins) and chosen by `HANA_E2E_PORT_BASE` (the stack uses
base … base + 50). Unset, it is the checkout's default (`src/checkout-port.ts`, applied by `src/port-env.ts` in the
Playwright config, the stack's entry point and the build): 4410 in the main checkout, and in a linked git worktree a
base of its own from 4510 up to 48910 in steps of 100, picked by a hash of the worktree's path, so worktrees running the
suite or `pnpm verify` at the same time don't meet on one stack (two can still draw the same base, about 1 in 440:
the fingerprint check below then refuses, and `HANA_E2E_PORT_BASE` picks another). To see a checkout's base:
`node --import tsx -e "import('./src/checkout-port.ts').then((m) => console.log(m.checkoutPortBase()))"` in
`apps/e2e`. A base
whose ports include one of the Fetch standard's blocked ports (5060, 5061, 6000, 6665–6669, 10080, …) is refused, since
no browser connects there. Outside CI
Playwright reuses a stack that is already listening on them. `tests/global-setup.ts` fails the run unless that stack
is this checkout's current code (`src/fingerprint.ts`: this package's path, the port base and the sources the stack
is built from), so another worktree's stack, an unrelated server, or one started before an edit, is never tested by
mistake; the error says to stop it or pick another base. In
CI a test that fails and then passes on its retry fails the run (`failOnFlakyTests`): the Approve-guard and
origin cases are timing-dependent security checks.

## The staff admin portal (D873)

`tests/admin-portal.spec.ts` runs apps/admin's REAL Worker and SPA, one LANE per origin (`src/stack.ts`
`ADMIN_LANES`): `demo` (base + 33) for a person's hand test (`docs/operations.md` "Trying the staff admin portal by hand
on the local stack", with `pnpm --filter @hana-id/e2e staff-demo <state>`), then one per browser project (base + 34 to
+ 36), so the browsers never share a relayer. Each lane is a worker thread of the stack's process
(`src/server/admin-lane.ts` hands it the HTTP requests; `src/server/admin-lane-worker.ts` is the lane), started on its
first request, with:

- `API`: apps/api's real `AdminRpc` entrypoint on the lane's own D1, with EVM gas sponsorship's real relayer object on
  chain 31337, signing with a key made when the lane starts. Its chain (`src/server/lane-evm.ts`) is the stack's
  `MockEvm` behind a pool the controls drive (hold, refuse for lack of funds, a transaction with the relayer's key it
  never sent, mined or pooled then dropped, the wallet's balance); the pinned delegate's address answers its real
  runtime code (the checked-in artifact), so the page's "Account helper program" check meets core's pin. Waiting
  transactions are sent through apps/api's own sponsorship routes, with the session proof, as the vault sends them.
  The same API has partner labels on, and a partner org whose owner proposes them (below).
- `CONSOLE`: apps/console's real `StaffRpc` on its own D1 (the audit log). `ISSUER`: the stack's email issuer's real
  `DirectoryRpc`, in the main thread (a message bridge): it checks the forwarded staff token itself (the issuer's
  `ADMIN_ACCESS_*` vars are the stand-in's).
- `USAGE_DB`: PGlite with apps/api's `migrations-usage`, behind a loopback Postgres wire-protocol listener
  (`src/server/pglite-wire.ts`) that the admin's own `pg` client connects to as role `usage_admin`, as through
  Hyperdrive. One connection at a time (PGlite is one session). Empty: the stack's API writes no usage events.
  Both lane Workers have `NEON_PLAN` (D872, testnet's free plan): System status never opens the ledger (the spec
  counts the listener's connections, `ledgerConnections` in the lane's state), and the pages that do report their
  wake-ups for the "Neon compute this month" tile.
- A clock of its own (`src/server/lane-clock.ts`, the thread's `Date`), moved only forward by a control (up to 62
  days at a time: the Neon spec moves it to the next month). Access tokens expire 24 hours after the lane's clock.

Each binding is called as a service binding: arguments and answers are structured clones. Not in the stack: the
partner console and files Workers, the watchdog, the contract's governance views, R2, SendGrid and the admin's crons;
the pages say so where they read them.

**Access.** The stand-in (`src/server/access.ts`, in front of the Worker as Cloudflare Access is) decides nothing: it
puts the `CF_Authorization` cookie into `Cf-Access-Jwt-Assertion` (any such header the client sent is dropped) and the
Worker's own `src/access.ts` verifies it against the team certs at `https://e2e-access.invalid/cdn-cgi/access/certs`,
answered inside the stack's threads only, then the staff list. One RS256 team key per stack start, never written
anywhere; the email issuer's staff routes use the same stand-in. `GET /__e2e/access/sign-in?as=staff|outsider[&to=/path]`
signs a token for `staff@e2e.invalid` (the one staff member) or `outsider@e2e.invalid` (on no list) at the real time
and sets the cookie; `/__e2e/access/sign-out` clears it. `test/admin-lane.test.ts` checks the stand-in's tokens against
the admin's own check, and that no admin source names `__e2e`, the stand-in or a sign-in bypass.

**Controls** (`/__e2e/lane/*` on a lane's origin, no CORS, refused with an `Origin`, served by the stand-in and never by
the Worker): `GET state` (the relayer's slots, pause and staff log, the chain's counts, the clock), `POST scenario
{name}` (`ready`, `working`, `low-money`, `waiting`, `past-deadline`, `out-of-money`, `money-arrives` (the wallet
refilled, nothing run yet), `refill` (refilled, the lane's clock past the pause's first 60 s, two runs: it restarts
by itself, D890, unless it can't), `out-of-money-again` (after a restart by itself, the next check-in finds the wallet
empty: that pause waits for a person), `key-used-elsewhere`, `foreign-transactions`, `gap`: each runs the relayer's own
alarm until the relayer itself is in that state; the lane's EVM settings have a second endpoint, `rpcFallback`, on the
same chain, which the restart asks), `POST run {times?}` (time passes for the relayer: its alarm, then the API cron's
relay check, which writes the security events), `POST clock {advanceMs?, freeze?, keepStatusCache?}` (the status
page's 30 s reading kept with `keepStatusCache`; `freeze: true` stops the lane's clock first so a test steps it to the
millisecond, `false` lets it run on from real time plus the offset, never backwards), `POST labels {action, …}`
(partner labels, below), and `POST acquire` / `release {lease}`: each test holds its lane (`tests/admin-fixtures.ts`),
so two runs on one stack or `--repeat-each` never share a relayer at once. In the suite's lanes the relayer's alarm runs
only by a control; in the hand-test lane also by itself: 250 ms after a change from outside the alarm (a send, a staff
tool), then as deployed (the relayer's own 15 s, or its backoff up to 5 minutes), never in a loop (D882; while paused
with a transaction no node took, that is every 15 s; while paused for money, D890, every 15 s for 10 minutes, then
every 60 s).

**Partner labels in the approval window (D896, `tests/partner-labels-window.spec.ts`).** The main stack's API also has
`PARTNER_LABELS = "on"`; an app has labels only when a test writes one in force straight to D1 (`POST /__e2e/labels
{appId, text}` → `{labelId, changeId}`, not the guarded path; `POST /__e2e/labels/remove {labelId}` removes it at once; `GET /__e2e/app-reads?pk=` lists when the vault's
`GET /v1/app` reads of an app arrived, so a test waits for the vault's labels read to be older than its 10 s window).
The spec walks one app's Stellar payments through a matching label, a warning beside one, the amber mismatch, the red
line for a payment and a path payment to an unlisted account, the till's muxed (M…) form and a request the label
doesn't describe (the same window after the label's removal and a fresh read), with the divider checks at 390 and
1280 px, light and dark, in every browser; `HANA_SHOTS_DIR` (Chromium) saves each screen.

**Partner labels (D894, `src/server/lane-labels.ts`).** The lanes' API env turns partner labels on
(`PARTNER_LABELS = "on"`, with `APP_CHANGE_DELAY_MS` 24 h as the admin env's, and `REFUSED_ORIGINS` the stack's API,
vault and auth origins, as gen-wrangler sets a real env’s); the main stack’s API has them on too (above). A lane has a partner org
of its own (`org_e2elabels…`, scope `stafflabelsN`, app "Stamp Rally" on the stamps origin, security contact
`security@stamp-rally.e2e.invalid`) whose owner proposes through apps/api's REAL `ConsoleRpc.proposeLabels`, with a
console step-up the API verifies itself: an RS256 token for the label-change layout over exactly that change, signed by a
Google key of the lane's own (its JWKS answered in the lane's thread), for a console audience the lane's chain lists in
`get_config.console_audiences`, from a `sub` the chain lists as an `Owner::Oidc` of the scope (`src/server/chain.ts`
`consoleAudiences`, `scopeOwners`). The token's single use is apps/api's real `RateLimiter` (in memory); the console's
budget allows in the lanes (the controls call faster than a person clicks; apps/api's tests hold it). The document is a
fixed `journear-labels/1` one for `stamp-rally.testnet` (a fresh code hash per version; verb "collect", object "the
stamp", the enum's "Fare paid"; from the second version on, one more stamp, "Summit"). `POST /__e2e/lane/labels`
`{action}`: every action but `app` answers `{…, state}` (the org's versions oldest first as staff see them, its switches
and everyone's, the lane's clock):

- `reset`: a new org, scope and app; the last org's entries are removed by its owner (the same step-up,
  `labels_remove`) and the switches it or everyone had set are turned back. Every action starts from one if none exists.
- `propose {next?}`: the entry's first version, or with `next: true` a new version of it → `proposed: {changeId,
  labelId, sha256, document}`. The API's refusals (one entry per contract, one waiting version) answer 409 with its message.
- `announce {changeId?}`: what the admin Worker's notice does once every email is accepted: `AdminRpc.labelNotices`, then
  `ackLabelNotice` as its system actor with sha256 of the cancel link's token (the lane's `CANCEL_LINK_KEY`). No email is
  sent (no `EMAIL_API_KEY`): `announced: [{changeId, activeFrom, wouldEmail}]` names who would have had it.
- `cron`: the API's hourly job for labels at the lane's clock (`labelsMaintenance`, then `detectLabelDrift`) →
  `run: {activated, lapsed, drift}`.
- `app`: `GET /v1/app` through apps/api's Worker as the vault reads it (Origin the vault's, the app's key and parent
  origin) → `{status, partnerLabels}` (null when the answer has no such field).
- `state`; `block` / `allow {changeId?, note?}` (`AdminRpc.labelStaffAct` as `staff@e2e.invalid`, default the newest
  version; no audit row, which the admin Worker writes before its own call); `switch {target: all|org|entry, what:
  off|on|review_on|review_off, note?}` (`AdminRpc.labelControl`); `scenario {name}` (below).

Time is the lane's clock (`POST clock`), never a wait. The hand-test states, each from a reset, are
`pnpm --filter @hana-id/e2e staff-demo <state>`: `labels-waiting` (proposed and announced: goes live in 24 h),
`labels-review` (review required for the org, its 24 h passed: waiting for Allow), `labels-live` (in force, recorded by
the hourly job), `labels-update` (one in force and a second version announced: the diff), `labels-off` (one in force and
every partner label switched off: the status page's switch); `staff-demo labels-later` moves the lane's clock 24 h on
and runs the hourly job, `staff-demo labels-state` prints the versions. Each prints the versions in plain words and what
to open: `/labels/<changeId>` (and the feed, `/labels`), or for `labels-off` `/status`, with the sign-in URL.
`test/admin-lane.test.ts` starts a lane thread of its own and checks the controls: proposed, announced, not served a
millisecond before `active_from` and served at it (the text's sha256 the delivered one), recorded by the cron, gone after
Block; the API's refusals; a second version with `previousEffectiveSince`; review and Allow; the kill switch and a reset.

The lane's Google key is made when the lane's thread starts (`crypto.subtle.generateKey`, in memory only, never written
or printed), and from then on that thread answers Google's endpoints itself: apps/api's JWKS cache there (the step-up's
check, and the governance read System status shows) never holds, or fetches, Google's real keys.

`tests/partner-labels.spec.ts`, in each browser's lane (its lease held, as `tests/admin-portal.spec.ts`): a change
proposed and announced by the controls is in the staff feed (`/labels`, "Goes live … (in 24 h)", what users would see:
"Stamp Rally says: collect the stamp “Arrival”") → its page → Block with a note (its confirmation) → "Blocked by staff"
with the note on the page, never served by `GET /v1/app` even after its time, and under "Decided" in the feed; and, with
the lane's clock frozen, a change not served a millisecond before its `active_from`, served at it (sha256 of the text
the delivered one) and "Live" on its page. The browser's `Date` is fixed at the lane's time (`page.clock.setFixedTime`),
as the pages' "in 24 h" and "Live" are worked out against the reader's clock; the staff member signs in again after
the lane's clock moves a day (the stand-in's token ends 24 h after the lane's clock). With `HANA_SHOTS_DIR=<dir>`
(Chromium) its last test saves the founder's screenshots there, light theme, the whole page at 1366 and 390 px wide (the
viewport made as tall as the page, so the sticky sidebar stays put; each also fails if the page is wider than the
screen): `01-feed`, `01-change-block` (the confirmation open), `02-blocked` (and `02-blocked-answer-1366`, the answer
at the top), `03-review-allow` and `03-review-feed` (required review, waiting for Allow), `04-status` and
`04-status-tile` (System status with every partner label switched off), each `-1366.png` and `-390.png`:

```sh
HANA_SHOTS_DIR=<dir> corepack pnpm --filter @hana-id/e2e e2e tests/partner-labels.spec.ts --project=chromium
```

**The partner console in the lanes (D899, `src/server/lane-console.ts`).** Each browser lane also serves apps/console's
real Worker and its SPA (built by `src/build.ts` into `.build/console/`) on an origin of its own
(`http://127.0.0.1:<base+37 | +38 | +39>`, chromium, firefox, webkit) and its auth origin (`<base+42 | +43 | +44>`),
over the lane's own API and console D1. Two stand-ins sit at its edge, as the Access stand-in does for the admin
portal: `GET /__e2e/console/sign-in?to=/path` makes the lane labels org's owner (the scope's on-chain owner on the lane's
chain) a console owner and gives it a session made by the console's own `createSession`; and the fresh sign-in's Google
step is answered at once by the edge (the console's real `/start` and `/callback`, and its own code exchange, answered
in the lane thread's fetch with an ID token from the lane's Google key for exactly that flow's nonce, after its PKCE
verifier checks out). Browsers keep `Secure` cookies only from https (WebKit not even on loopback), so the edge renames
the console's `__Host-…; Secure` cookies to `e2e-host-…` without `Secure` on the way out and back on the way in.
`tests/partner-labels-console.spec.ts`, in each browser's lane (its lease held): the Request labels tab's form filled
(an account, the phrase, the memo, the sentence's order by its buttons, the suggested fee), the window's own preview
(the partner's box; the amber and red lines), a claim word refused beside its field, Review → the confirmation's diff →
Confirm with Google → proposed, the change waiting with its time once the lane announces it, Cancel; and a change
staff blocked, listed with its note. With `HANA_SHOTS_DIR=<dir>` (Chromium) its last test saves the founder's
screenshots, at 1280 and 390 px, light and dark: `01-editor-match`, `01-editor-mismatch`, `01-editor-not-listed`,
`02-editor-problem`, `03-review`, `04-list`, `05-list-blocked`, `06-editor-near`.

Partner labels' app changes and the Block's audit rows stay in the lane, and the stack runs no admin cron to mail them:
Feed and notices' Feeds panel may show them behind, which `tests/admin-portal.spec.ts` allows.

**What the spec covers**, in every browser: sign-in and the refusals (no token, a forged one, a client's own header,
someone not on the list); every page in the sidebar opens; System status's tile **Gas sponsorship (local test network)**
in each state, and its link to the page `/gas-sponsorship/31337` (staff's name for the feature since D879; users still
read "free network fees"; `staff-demo` prints that address); a waiting transaction
and Cancel only past its time limit; out of money, the money arriving ("Restarting by itself"), refilled and restarted
by itself (no Resume), out again at once, refilled, Resume needed and done; the tile's own Check again past the 30 s
reading; someone else using the relayer's key three ways
(Close, Set the next slot number, Fill a gap, each confirmed, and Resume only with the engineer's word, refused by the
page and by the Worker without it); a stale page and a second tab; the audit log's rows with who, when and the note;
the sponsorship's events with their playbooks on Feed and notices and Security & monitoring; the ledger's pages; the
"Neon compute this month" tile (nothing yet, a whole month, counting began late) with no ledger connection from System
status; the
staff unlock and unsuppress (the issuer's routes, no admin page) in the audit log. Every page is watched: a console
error, an uncaught error, a CSP violation or a cookie set by the Worker fails it, except WebKit's own `<select>` CSP
report (D873 item 8). With `HANA_SHOTS_DIR=<dir>` (Chromium) it saves the founder's screens (desktop, light).

## Live mode: `pk_live_` apps

Most of the suite's apps are `pk_test_` apps on the loopback partner origins above. Paths only a `pk_live_` app reaches,
such as the raw-signing approval popup (test apps never sign raw, `docs/decisions.md` D39), run in live mode:
`newLiveApp()` creates a live app and `openPartner(page, app, { live: true })` opens the partner test app for it
(`tests/approval.spec.ts` "raw signing" and the chain-only digest case).

Every env, the e2e ones included, allows loopback partner origins only for `pk_test_` keys (`apps/api/src/origins.ts`,
the vault's `parentAllowed`), so a live app needs a non-loopback partner origin. That page must be https (an http page
on a non-loopback host isn't a secure context, and the SDK and the vault need one), and an https page can't use the
`http://127.0.0.1` Hana origins (WebKit blocks them as mixed content, Chromium as local network access). So live mode
is a second env, `local-e2e-live` (`LIVE_ENV` in `src/stack.ts`), whose every origin is https on a reserved `.test` name:

| Origin | Routed to |
|---|---|
| `https://partner.e2e-live.test` | the partner server (the same page, with `?env=local-e2e-live`) |
| `https://vault.e2e-hana.test`, `https://auth.e2e-hana-auth.test`, `https://api.e2e-hana.test` | apps/api's vault host, auth host and Worker for `LIVE_ENV`, on the same D1 and mocked chain |
| `https://rpc.e2e-near.test`, `https://rpc.e2e-evm.test` | the mocked NEAR and EVM RPCs |

Nothing resolves those names: each test's browser context routes them (`tests/fixtures.ts`, `LIVE_UPSTREAMS`) to the
stack's servers, which see each request at its https URL (`servedAt` in `src/server/http.ts`, as a TLS-terminating
front would). The vault and auth bundles are built for `LIVE_ENV` by the same per-env build scripts, the Google stub
accepts each env's callback, and live apps get their own scope (`e2elive`: a test app on a live app's scope is
refused, D51). No origin rule is relaxed and no production env or manifest changes: a live app goes through the rules
production applies. Mainnet chains are still not browser-tested.

One thing routing changes: Playwright answers the CORS preflight of a routed request itself (allowing it), so in live
mode the API's preflight answer isn't what the browser checks; the actual response's CORS headers, which are the
API's, still are. The test-app pages reach the API unrouted, so the preflight rule stays browser-tested there.

## Browser differences the suite accounts for

- Playwright's browsers never block popups. Where the spec needs the blocked-popup path (Safari after an `await`: the
  wagmi and SWK connect paths in WebKit), the partner page's `window.open` returns null (`?blockPopups=1`; only for
  the approval popup with `?blockPopups=approve`, D99).
- `page.evaluate` runs with an emulated user gesture in all three browsers, so a signing call it starts would open
  the approval popup in "the click". `e2e.run` (an action outside any click) therefore makes
  `navigator.userActivation.isActive` read false until the next `e2e.arm`, so those tests see the launcher path;
  `clickAction` actions run inside a real click on `#act`.
- Playwright launches Chromium with storage partitioning off (microsoft/playwright#32230); Firefox runs with its
  shipped default (`network.cookie.cookieBehavior = 5`). The partitioning case asserts an empty store (IndexedDB) on
  site B in Firefox and WebKit, and in Chromium that the vault leaves the other site's record unused.
- Playwright's WebKit doesn't apply COOP to a route-fulfilled response, so the "IdP enforces COOP" case checks the
  browsing-context switch in Chromium and Firefox only.
