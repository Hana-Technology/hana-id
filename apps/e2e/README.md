# @hana-id/e2e

The Playwright suite of batch B (`docs/batch-b-spec.md`, "Tests → Playwright"): the real vault, login, callback,
approval and export bundles of `@hana-id/web`, and the partner client, in Chromium, WebKit and Firefox.

```sh
corepack pnpm --filter @hana-id/e2e e2e:install   # once: the browsers
corepack pnpm --filter @hana-id/e2e e2e           # build + local stack + all three browsers
corepack pnpm --filter @hana-id/e2e e2e --project webkit tests/approval.spec.ts
cd apps/e2e && corepack pnpm exec playwright test --project=chromium tests/email.spec.ts   # one spec, one browser
HANA_E2E_PORT_BASE=4510 corepack pnpm --filter @hana-id/e2e e2e   # another worktree's run at the same time (not 5010: see below)
corepack pnpm --filter @hana-id/e2e test          # unit tests of the stack's mocks (part of `pnpm -r test`)
```

An unfinished login (`tests/abandoned-login.spec.ts`; the follow-up screens in `tests/linking.spec.ts`, the demo's in
`tests/demo.spec.ts`): the popup left on the method chooser, Google's page, the email address or code step, a link
code screen or a banner, or closed. The tests install Playwright's clock (`page.clock`, for the whole context: the
partner page, the vault frame and the popup) and fast-forward past the vault's 5-minute limit; `responsive(frame)`
(`tests/fixtures.ts`) checks the vault frame and the partner page still run a script. In all three browsers the
partner page shares the vault frame's renderer here, so a loop in the vault freezes it too.

Popups that close themselves (a banner's Done or Cancel, the email step's Cancel, the callback after its relay): click
them with `clickClosing(popup, selector)` (or `clickMayClose` when the click only sometimes closes the window), and
wait with `closeOf(popup)`, never a bare `popup.waitForEvent('close')` (`tests/fixtures.ts`). A window that closes
while Playwright still performs the click makes the click reject with "Target page, context or browser has been
closed"; the helpers drop that error only when the window is in fact closed. `waitForEvent('close')` on a window that
has already closed waits for its whole timeout.

## What runs

Ports are `HANA_E2E_PORT_BASE` (default 4410) plus the offsets below: the table shows the default.

| Origin | Serves |
|---|---|
| `http://localhost:4410` | the partner test app (`partner/app.ts`): `createHana`, viem, wagmi, Stellar Wallets Kit 1.9.5 and 2.7.1 |
| `http://site-b.localhost:4411` | the same app on a second partner site (the storage-partitioning case) |
| `http://localhost:4412` | the hosted demo (`apps/demo`), built for the e2e env and served by its own Worker handler with its real CSP (`tests/demo.spec.ts`) |
| `http://127.0.0.1:4420` | `vaultOrigin`: apps/api's vault host, and the vault page rendered by apps/api's `handleVaultPage` from D1 |
| `http://127.0.0.1:4430` | `authOrigin`: apps/api's auth host over the built auth pages |
| `http://127.0.0.1:4440` | the Hana API: apps/api's Worker, with `/v1/login`, `/v1/derive`, `/v1/sessions/revoke` and `/v1/link*` mocked; plus `/__e2e/*` control endpoints (`/__e2e/google-key`: the stack's Google signing key; `/__e2e/chain`: what the relayer sent to the mocked chain) |
| `http://127.0.0.1:4442` | the email issuer: apps/email-issuer's Worker with the `outbox` stub; plus `GET /__e2e/outbox` (the mails, for the tests) and `GET /__e2e/directory?sub=` (one identity's rows in the user directory, D269) |
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

The demo (`apps/demo`) is bundled by esbuild from its own `index.html` and `src/main.ts` with a configuration for the
stack (`DEMO_CONFIG` in `src/build.ts`: the e2e env, the mocked EVM chain). It bakes its key in at build time, as the
deployed demo does, so its app has a fixed key (`DEMO_PK`): `POST /__e2e/apps` with `publishableKey` creates it once
and returns it after that, and every demo test and browser shares it (each test still has its own browser context).

The bundles are built by `@hana-id/web`'s own per-env build scripts for `local-e2e`, an env defined in `src/stack.ts`
(not in `envs/`, so the published client never lists a loopback env). Its CKD key belongs to a test MPC
(`src/server/chain.ts`, real BLS12-381), so the vault's pairing check runs as on testnet. D1 is node:sqlite with
apps/api's migrations.

Email login (`tests/email.spec.ts`, build plan batch 8a) runs apps/email-issuer's own Worker in Node
(`src/server/issuer.ts`) on its own origin, as on sandbox-dev (D230): its handlers, its `Challenge`, `RateLimiter` and
`Outbox` objects on in-memory storage, its D1 migrations, and the API's D1 as `APP_DB`. Mail goes to the `outbox` stub
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
follow-up screen gives `login_cancelled` (`popup_closed`) within seconds, and a slow trip to Google and back signs in.
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

The ports are fixed for a run (the bundles inline the origins) and chosen by `HANA_E2E_PORT_BASE`, so worktrees that
run the suite at the same time each set their own base (4410, 4510, …; the stack uses base … base + 50). A base
whose ports include one of the Fetch standard's blocked ports (5060, 5061, 6000, 6665–6669, 10080, …) is refused, since
no browser connects there. Outside CI
Playwright reuses a stack that is already listening on them. `tests/global-setup.ts` fails the run unless that stack
is this checkout's current code (`src/fingerprint.ts`: this package's path, the port base and the sources the stack
is built from), so another worktree's stack, an unrelated server, or one started before an edit, is never tested by
mistake; the error says to stop it or pick another base. In
CI a test that fails and then passes on its retry fails the run (`failOnFlakyTests`): the Approve-guard and
origin cases are timing-dependent security checks.

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
