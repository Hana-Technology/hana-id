# @hana-id/demo

A small hosted demo so colleagues can try Hana ID on **testnet** from a URL, with no local setup: internal testing
and review. It is a partner-style app (one Vite page, plain TypeScript) built on `@hana-id/web` exactly as
[`docs/integration.md`](../../docs/integration.md) tells partners to integrate, served by a Cloudflare Worker with
static assets. It is not a Hana page and holds nothing secret.

| Env | URL | App |
|---|---|---|
| `sandbox-dev` | `https://hana-id-demo-sandbox-dev.tingtc.workers.dev` | Smoke B, `pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie` (shared Google client) |

## What the page does

One page: a testnet banner and a short explainer, then

- **Log in with Google** (`hana.login()` in the click handler), with the login's progress, *Cancel sign-in*, *Log
  out* and *Log out other devices* (`revokeOtherDevices`, which works within 5 minutes of a fresh login);
- a **status line**: logged in or out, when the session ends and the app's persistence (`session`: survives reloads
  and new tabs; `none`, or the browser's storage fallback);
- the **Stellar and EVM addresses**, each with *Copy* and a testnet explorer link (StellarExpert testnet, Base
  Sepolia's Basescan);
- **Sign**: an EVM `personal_sign` message, a Stellar (SEP-53) message, and a Base Sepolia test transaction (a 0-value
  transfer to yourself, fully filled, `eth_signTransaction`). Each needs the user's Approve in the Hana popup, and
  nothing is ever broadcast, so no funds are needed;
- **Export key** (Stellar or EVM) through Hana's export window: the key is shown only there;
- **Identity token**: *Get identity token* (`hana.getIdentityToken()`, no popup) shows the token's decoded header and
  claims (display only: the page never trusts them) and a "verify it yourself" `jose` snippet with the token's own
  `iss` and `aud` (`docs/integration.md` section 15);
- **Login timings** (collapsible): the vault's per-stage times (`app`, `popup`, `google`, `verify`, `chain`,
  `decrypt`, which `pk_test_` apps get) and the total from the click, plus the unlock time when a page load restored
  the session;
- **Copy diagnostics**: a JSON report for bug reports, also shown on the page. It holds the env, the app key's
  first 12 characters, the page and vault origins, the SDK version, status, persistence, expiry, addresses, timings,
  the user agent and the errors seen (code, `data.reason`, and the message with anything shaped like a token, key,
  signature or relay id removed). It never holds tokens, keys, signatures or relay ids: the page never sees the
  first, and `src/diagnostics.ts` builds the report field by field and scrubs the free text.

Errors are shown in plain words (`src/errors.ts`): a blocked popup (and the "Click *Sign in with Hana*" hint when
the SDK falls back to the vault's button), a cancelled or declined sign-in, a rejected request, an unreachable vault
or API, rate limits, "log out other devices" after its 5 minutes, network failures.

## Security

- No analytics, no third-party script, no inline script or style (the build sets no preload polyfill and inlines no
  asset).
- Every response carries the headers of `src/csp.ts`. The page's CSP:

  ```text
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self';
  connect-src <EVM RPC origin>; frame-src <vaultOrigin>; base-uri 'none'; form-action 'none';
  frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'
  ```

  `frame-src` is exactly the env's `vaultOrigin`. `connect-src` is exactly the EVM chain's RPC (the SDK forwards
  read-only calls there). The page itself calls no Hana API: the vault frame does, under its own CSP. Assets and errors
  get `default-src 'none'; frame-ancestors 'none'; sandbox`. Also `X-Content-Type-Options: nosniff`,
  `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, `Cross-Origin-Opener-Policy: same-origin-allow-popups` (not
  `same-origin`, which would break the Hana login popup), `Cross-Origin-Resource-Policy: same-origin`, a
  `Permissions-Policy` and HSTS.
- The Worker (`worker/index.ts`) answers only GET/HEAD on its own origin (preview URLs are off, any other hostname
  gets 404), serves the page only on `/` (no `.html` path, no HTML asset), drops cookies, and serves nothing (503)
  without its CSP var.
- `src/config.ts` refuses a `pk_live_` key, a mainnet EVM chain or the Stellar public network, and a non-https
  origin (http only on loopback). `scripts/gen-wrangler.ts` refuses envs that aren't testnet `sandbox*`/`local*`
  envs on workers.dev.

## Configuration

Chosen at build time from the shell (no `.env` files, so the build and the Worker config always agree):

| Variable | Default |
|---|---|
| `HANA_DEMO_ENV` | `sandbox-dev` (`envs/<name>.json`) |
| `HANA_DEMO_PUBLISHABLE_KEY` | the Smoke B key above, for `sandbox-dev` only; another env needs its own `pk_test_` key |

The EVM chain is Base Sepolia (84532, `https://sepolia.base.org`) and Stellar is testnet (`src/config.ts`).

## Deploy

The Worker is `hana-id-demo-<env>`, on the workers.dev subdomain of the env's other Workers (the one in `apiUrl`),
so for sandbox-dev `https://hana-id-demo-sandbox-dev.tingtc.workers.dev`.

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
corepack pnpm --filter @hana-id/demo test        # config, CSP, Worker headers, gen-wrangler, diagnostics redaction, errors, the page (happy-dom)
corepack pnpm --filter @hana-id/demo typecheck
```

`apps/e2e` also builds the demo for its local stack and serves it with this Worker handler and its real CSP
(`http://localhost:<base + 2>`): `tests/demo.spec.ts` logs in, signs, checks the diagnostics and the blocked-popup,
cancelled and declined cases in Chromium, Firefox and WebKit, with no CSP violation.
