# @hana-id/demo

A small hosted demo so colleagues can try Journear Passport (code name Hana ID) on **testnet** from a URL, with no local setup: internal testing
and review. It is a partner-style app (one Vite page, plain TypeScript) built on `@hana-id/web` exactly as
[`docs/integration.md`](../../docs/integration.md) tells partners to integrate, served by a Cloudflare Worker with
static assets. It is not one of Journear's own pages (no key or token ever reaches it) and holds nothing secret, but
it is Journear Passport's showcase of the SDK, so it wears the full design system (below).

| Env | URL | App |
|---|---|---|
| `sandbox-dev` | `https://hana-id-demo-sandbox-dev.tingtc.workers.dev` | Smoke B, `pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie` (shared Google client) |

## What the page does

One page: a testnet banner (Stellar, EVM and NEAR test networks) and a short explainer that leads with *Log in with
email* (most reviewers use it: Google sign-in is limited to the Google client's listed testers), then

- **Log in with email** (`hana.login({ method: 'email' })`, batch 8a): the Journear popup's email step (address, mailed
  code). It works once the demo app's `login_methods` include email and its scope holds its email client
  (`docs/operations.md` "Email login demo on sandbox-dev (batch 8a)"); until then it says email isn't turned on.
- **Log in with Google** (`hana.login({ method: 'google' })` in the click handler, so the popup skips its chooser once
  email is on), with the login's progress, *Cancel sign-in*, *Log
  out* and *Log out other devices* (`revokeOtherDevices`, which works within 5 minutes of a fresh login);
- a **status line**: logged in or out, when the session ends and the app's persistence (`session`: survives reloads
  and new tabs; `none`, or the browser's storage fallback);
- the **Stellar and EVM addresses**, each with *Copy* and a testnet explorer link (StellarExpert testnet, Base
  Sepolia's Basescan);
- the **NEAR card** (SDK 0.4.0, the NEAR hackathon, D750–D754; `src/near-card.ts`, logic in `src/near.ts`), shown
  once the vault reports a NEAR account (after a Google or an email login alike):
  - the user's implicit account, short with *Copy*, in full on demand, a NearBlocks testnet link and its balance;
  - **Write to the guestbook (no NEAR needed)**: a message of 1 to 200 characters, counted as the contract counts
    them (Rust's `trim`, Unicode scalar values), written to `near.demoGuestbook` through Journear's relayer: `hana.near.
    activate()` for a new account (once per account and session; retried for about 20 s while the API says the
    account isn't in the wallet directory yet), a `DelegateAction` calling `add_message({ text })` with 10 Tgas and
    no deposit, expiring 600 blocks after the latest final block, `hana.near.signDelegateAction` and
    `hana.near.relay`. Each stage is shown ("Preparing your NEAR account…", "Waiting for your approval in the Journear
    window…", "Sending it through Journear’s relayer, which pays the fee…"), then the result with the transaction's
    link. The message box is validated on blur (too long, or a broken character: the field turns invalid with the
    reason) and again on the click, never on each key; the count updates as you type;
  - **the popup rule** (docs/integration.md section 8): the key's nonce and the latest block are read from the env's
    NEAR RPC when the card appears, when the message box is focused or typed in (which also activates a new account)
    and every 30 s while the user is active, so a click signs at once and the approval opens in the click. Without a
    read under 60 s old the click calls `hana.prepareApproval()` first, then reads, then signs (D751);
  - **Latest messages**: `get_messages` (20, newest first), each author short with "you" on the user's own, its time
    and text. The guestbook is attacker-controlled: entries are parsed strictly, text goes into text nodes only (no
    HTML, no links), control, bidi and zero-width characters become U+FFFD (emoji sequences kept), and text is cut to
    200 characters (D753). Refreshed after a write and with *Refresh*;
  - **Sign a message (NEP-413)** (this page's host as the recipient, a fresh 32-byte nonce) and **Sign a
    transaction**: a real `add_message` transaction, sent only when the account holds at least 0.01 NEAR; otherwise it
    shows the signed transaction and its hash and says it wasn't sent for lack of NEAR for the fee (D754);
  - the borsh bytes come from `@hana-id/core/near`'s codec, the one the vault decodes with (no NEAR SDK in the page);
- **Sign**: an EVM `personal_sign` message, a Stellar (SEP-53) message, and a Base Sepolia test transaction (a 0-value
  transfer to yourself, fully filled, `eth_signTransaction`). Each needs the user's Approve in the Journear popup, and
  nothing is ever broadcast, so no funds are needed;
- **Export key** (Stellar, EVM or NEAR) through Journear's export window: the key is shown only there;
- **Identity token**: *Get identity token* (`hana.getIdentityToken()`, no popup) shows the token's decoded header and
  claims (display only: the page never trusts them) and a "verify it yourself" `jose` snippet with the token's own
  `iss` and `aud` (`docs/integration.md` section 15);
- **Share email…** (`hana.requestEmailSharing()`, D411): Journear's email sharing sheet in a popup, when the demo app's
  `identity_email` setting is `on_request` or `at_login` (`admin <env> app:settings <app> --identity-email …`); then
  the token shows `email` and `email_verified`. With the setting off it says how to turn it on;
- **Login timings** (collapsible): per login, its method and the vault's per-stage times (`app`, `popup`, sign-in,
  `verify`, `chain`, `decrypt`, which `pk_test_` apps get) and the total from the click; sign-in is `google` for a
  Google login and, for email, the email step's address, code request, code wait and verify (each listed under the
  row, D260); other stages are listed after; plus the unlock time when a page load restored the session;
- **Copy diagnostics**: a JSON report for bug reports, also shown on the page. It holds the env, the app key's
  first 12 characters, the page and vault origins, the SDK version, status, persistence, expiry, addresses, timings,
  the user agent and the errors seen (code, `data.reason`, e.g. a `vault_unavailable`'s `no_answer` or `frame_timeout`, the API request ID
  an error came from (`data.requestId`, D405), and the message with anything shaped like a token, key,
  signature or relay id removed), plus `requestIds`, the latest five distinct request IDs, for Hana's Support ID lookup. It never holds tokens, keys, signatures or relay ids: the page never sees the
  first, and `src/diagnostics.ts` builds the report field by field and scrubs the free text.

Errors are shown in plain words (`src/errors.ts`), as inline alerts (the page's under the status line, the NEAR
card's in the card): every NEAR refusal of the vault
(`near_key_unknown`, `near_block_unknown`, `near_network_mismatch`, `near_delegate_nonce_used`,
`near_delegate_nonce_too_large`, `near_delegate_expiry`, `near_rpc_unavailable`), the relayer's refusals by
`data.reason` (a table to extend, with a default for codes it doesn't know), and the page's own NEAR reads; also a blocked popup (and the "Click *Sign in with Hana*" hint when
the SDK falls back to the vault's button), a cancelled or declined sign-in, a rejected request, an unreachable vault
or API, rate limits, "log out other devices" after its 5 minutes, network failures.

## Design

The page follows the Journear Passport design system (`packages/brand`, D765): tokens, type and the `.jp-*`
components, light and dark by the system setting, laid out for desktop and phone (`src/style.css`, tokens only):

- a top bar with the Journear lockup, the environment badge and, signed in, the **wallet pill** (the EVM address
  short; it links to the addresses);
- one primary button per view (*Log in with email* signed out; *Write to the guestbook* signed in), secondary for the
  others, ghost for inline ones (*Copy*, *Refresh*, *Cancel sign-in*);
- addresses as mono key/value rows with a **chain badge** (Stellar testnet, the EVM chain, NEAR testnet);
- signing results in the **confirm-and-sign** style read back (`src/result.ts`): the outcome first, then the facts
  (signature, transaction hash, recipient, explorer link) as mono rows, then a note;
- **inline alerts** for errors and for what lasts while its state does (the launcher's "Click … to continue", a
  session that ended, a sign-out), and **toasts** (`src/toast.ts`) for transient results (an address copied, logged
  out, other devices signed out, the export window opened, email shared, diagnostics copied): bottom right on desktop,
  at the top on phones, 380 px at most, a stack of three, gone after 5 s (paused on hover), a danger toast never;
- the login timings as a **stats strip** (the latest login's total, sign-in step and wallet-key stage, and a restored
  session's time) over the full table (sticky header, numbers on the right); diagnostics and the identity token on the
  ink code surface.

## Security

- No analytics, no third-party script, no inline script or style (the build sets no preload polyfill and inlines no
  asset; `test/brand.test.ts` checks the page has no `style` attribute or `<style>`). Toasts and results are built with
  DOM calls and text nodes only (Trusted Types: no HTML strings).
- Journear Passport's brand (D426, D765): the stylesheet imports `@hana-id/brand`'s tokens, fonts and components;
  Vite emits the Archivo and IBM Plex files into `assets/` (hashed, served immutable like the bundles) with their
  licences (`OFL-Archivo.txt`, `OFL-IBMPlexSans.txt`, `OFL-IBMPlexMono.txt`, the brand's `FONT_LICENCE_FILES`) beside
  them, so the page loads fonts from its own origin only (`font-src 'self'`, no font CDN). The Journear lockup is drawn
  inline in the top bar (the brand file's geometry, `test/brand.test.ts`; white in the dark scheme), the icons are an
  inline SVG sprite (no image request), and the favicon is the brand's `journear-mark.svg`.
- Every response carries the headers of `src/csp.ts`. The page's CSP:

  ```text
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src <EVM RPC> <NEAR rpc> <NEAR rpcFallback> <apiUrl>; frame-src <vaultOrigin>; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'
  ```

  `frame-src` is exactly the env's `vaultOrigin`. `connect-src` is exactly these origins (`src/csp.ts`
  `connectOrigins`): the EVM chain's RPC (the SDK forwards read-only calls there), the env's NEAR RPC and its fallback
  (the NEAR card's reads: access key, block, balance, `get_messages`, and `send_tx` for a funded account) and the env's
  API (the SDK's `hana.near.relay` and `activate` run in the page). Every other Hana API call is the vault frame's,
  under its own CSP. Assets and errors
  get `default-src 'none'; frame-ancestors 'none'; sandbox`. Also `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (not
  `same-origin`, which would break the Hana login popup), `Cross-Origin-Resource-Policy: same-origin`, a
  `Permissions-Policy` and HSTS.
- The Worker (`worker/index.ts`) answers only GET/HEAD on its own origin (preview URLs are off, any other hostname
  gets 404), serves the page only on `/` (no `.html` path, no HTML asset), drops cookies, and serves nothing (503)
  without its CSP var.
- `src/config.ts` refuses a `pk_live_` key, a mainnet EVM chain or the Stellar public network, and a non-https
  origin (http only on loopback). `scripts/gen-wrangler.ts` refuses envs that aren't testnet `sandbox*`/`local*`
  envs, and an env whose API isn't on workers.dev unless `HANA_DEMO_ORIGIN` names the demo's Custom Domain.

## Configuration

Chosen at build time from the shell (no `.env` files, so the build and the Worker config always agree):

| Variable | Default |
|---|---|
| `HANA_DEMO_ENV` | `sandbox-dev` (`envs/<name>.json`) |
| `HANA_DEMO_PUBLISHABLE_KEY` | the Smoke B key above, for `sandbox-dev` only; another env needs its own `pk_test_` key |
| `HANA_DEMO_ORIGIN` | none: the API's workers.dev subdomain. A bare https origin (`https://demo.<dev domain>`) makes the demo a Custom Domain on the env's account (`cloudflare.accountId`); required when the env's API is on a custom domain (D404) |

The EVM chain is Base Sepolia (84532, `https://sepolia.base.org`) and Stellar is testnet (`src/config.ts`). NEAR
comes from the manifest: `rpc` and `rpcFallback` (the card's reads), `apiUrl` (relay and activate) and
`near.demoGuestbook` (a `.testnet` account; without it the card has no guestbook write or list); the explorer is
NearBlocks testnet.

## Deploy

The Worker is `hana-id-demo-<env>`, on the workers.dev subdomain of the env's other Workers (the one in `apiUrl`),
so for sandbox-dev `https://hana-id-demo-sandbox-dev.tingtc.workers.dev`; with `HANA_DEMO_ORIGIN`, on that Custom
Domain instead (no workers.dev URL).

1. **Allow the origin on the app** (once per app; the vault refuses to load on an origin the app doesn't list). It
   needs `apps/api/wrangler.jsonc` for the env (`corepack pnpm --filter @hana-id/api run gen sandbox-dev`):

   ```sh
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:origins:add \
     --app pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie \
     --origin https://hana-id-demo-sandbox-dev.tingtc.workers.dev --remote
   corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:changes:announce <gc id> --remote   # the id printed above
   ```

   The origin is a staff proposal: it is in force 60 s after the announcement (sandbox-dev's `appChangeDelayMs`).

   The shared Google client needs nothing: the demo's origin never talks to Google (Hana's login popup does, on
   `authOrigin`).
2. **Build and deploy** (`wrangler login` first):

   ```sh
   corepack pnpm install
   corepack pnpm --filter @hana-id/demo run deploy
   HANA_DEMO_ENV=<env> HANA_DEMO_PUBLISHABLE_KEY=pk_test_… corepack pnpm --filter @hana-id/demo run deploy   # another env
   ```

   `deploy` regenerates `packages/web/src/envs.generated.ts`, builds `dist/` (`vite build`), writes the gitignored
   `apps/demo/wrangler.jsonc` (`gen`) and runs `wrangler deploy`. To check without deploying: `build`, `gen`, then
   `corepack pnpm --filter @hana-id/demo exec wrangler deploy --dry-run`.
3. Open the URL, log in, and send *Copy diagnostics* output with any bug report.

Rebuild and redeploy after a change to `envs/<env>.json` (the vault origin is in the CSP and the bundle) or to
`@hana-id/web`.

## Local

```sh
corepack pnpm --filter @hana-id/demo dev       # http://localhost:5174 (no CSP: Vite's dev server injects inline styles)
corepack pnpm --filter @hana-id/demo build && corepack pnpm --filter @hana-id/demo preview   # the built page with its headers
```

Both need `http://localhost:5174` on the app's origins (`app:origins:add … --origin http://localhost:5174`, then
`app:changes:announce`; loopback works for test apps in `sandbox*` envs only).

## Tests

```sh
corepack pnpm --filter @hana-id/demo test        # config, CSP, Worker headers, gen-wrangler, diagnostics redaction, errors, the page and its patterns (happy-dom), toasts, the brand
corepack pnpm --filter @hana-id/demo typecheck
```

`apps/e2e` also builds the demo for its local stack and serves it with this Worker handler and its real CSP
(`http://localhost:<base + 2>`): `tests/demo.spec.ts` logs in, signs, checks the diagnostics and the blocked-popup,
cancelled and declined cases in Chromium, Firefox and WebKit, with no CSP violation. Its NEAR test writes to the
guestbook end to end: the stack's mocked NEAR RPC serves `view_access_key`, `view_account`, `block` and the
guestbook's `get_messages`, and `POST /v1/near/activate` and `/v1/near/relay` are mocked at the network layer (the
stack runs no relay account). The mocks answer `409 near_account_unrecorded` until the stack's real wallet directory
holds the user's NEAR account (the vault records it after login), and a second test clicks before the record lands
and checks the card waits and retries. The approval popup shows "NEAR transaction, fee paid by a relayer" and the
`add_message` call. What keeps the page and the API from drifting is `apps/api/test/near-demo-page.test.ts`: the
page's own builders and nonce (`src/near.ts`) and the SDK's own `activate` and `relay` requests, through the real
routes with the fake NEAR RPC and sandbox-dev's 10 Tgas cap. Screens of the NEAR card (light and dark, desktop and phone, each stage):
`HANA_SHOTS_DIR=<dir> corepack pnpm exec playwright test --project=chromium tests/demo-near-shots.spec.ts` in
`apps/e2e`.
