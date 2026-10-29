# @hana-id/e2e

The Playwright suite of batch B (`docs/batch-b-spec.md`, "Tests → Playwright"): the real vault, login, callback,
approval and export bundles of `@hana-id/web`, and the partner client, in Chromium, WebKit and Firefox.

```sh
corepack pnpm --filter @hana-id/e2e e2e:install   # once: the browsers
corepack pnpm --filter @hana-id/e2e e2e           # build + local stack + all three browsers
corepack pnpm --filter @hana-id/e2e e2e --project webkit tests/approval.spec.ts
HANA_E2E_PORT_BASE=4510 corepack pnpm --filter @hana-id/e2e e2e   # another worktree's run at the same time (not 5010: see below)
corepack pnpm --filter @hana-id/e2e test          # unit tests of the stack's mocks (part of `pnpm -r test`)
```

## What runs

Ports are `HANA_E2E_PORT_BASE` (default 4410) plus the offsets below: the table shows the default.

| Origin | Serves |
|---|---|
| `http://localhost:4410` | the partner test app (`partner/app.ts`): `createHana`, viem, wagmi, Stellar Wallets Kit 1.9.5 and 2.7.1 |
| `http://site-b.localhost:4411` | the same app on a second partner site (the storage-partitioning case) |
| `http://localhost:4412` | the hosted demo (`apps/demo`), built for the e2e env and served by its own Worker handler with its real CSP (`tests/demo.spec.ts`) |
| `http://127.0.0.1:4420` | `vaultOrigin`: apps/api's vault host, and the vault page rendered by apps/api's `handleVaultPage` from D1 |
| `http://127.0.0.1:4430` | `authOrigin`: apps/api's auth host over the built auth pages |
| `http://127.0.0.1:4440` | the Hana API: apps/api's Worker, with `/v1/login` and `/v1/derive` mocked; plus `/__e2e/*` control endpoints |
| `http://127.0.0.1:4450`, `:4460` | mocked NEAR RPC and EVM chain RPC |

Both partner sites are cross-site to the Hana pages, as in production, so the vault frame is a third-party frame on
each: `localhost`, `site-b.localhost` and `127.0.0.1` are three sites (ports don't count). Site B is a `*.localhost`
name rather than `[::1]` because CSP source expressions have no IPv6 form: no browser lets a `[::1]` page embed the
vault through its `frame-ancestors`.

The API is `apps/api/src/index.ts` itself, run in Node: routing, CORS, the app gate and origin rule, `GET /v1/app`,
the vault endpoints (KEK wrapping, counters and the real SQL on `vault_shares`) and the login relay (the `LoginRelay`
Durable Object class, on in-memory storage). Only `/v1/login` and `/v1/derive` are mocked (`src/server/api.ts`), after
the Worker's own app gate, since they need the relayer and the MPC. The rate limiter always allows: every page in the
suite is one client, and apps/api's tests cover the limits.

Every app the suite creates is a `pk_test_` app (loopback partner origins need one), and there is no live-app mode.
So paths that only a `pk_live_` app reaches are not browser-tested: the raw-signing approval popup (test apps never
sign raw, `docs/decisions.md` D39) and mainnet chains. `packages/web/test/vault/approval.test.ts` covers a live app's
raw request; `tests/approval.spec.ts` checks that a test app's raw request is 4100 with no popup.

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

Google is never contacted: each test's browser context routes `accounts.google.com/o/oauth2/v2/auth` and
`www.googleapis.com/oauth2/v3/certs` to an OIDC stub (`src/google-stub.ts`) that checks the request is the spec's
openid-only implicit flow and signs RS256 tokens with the claims Google sends for it. Production bundles keep the
hard-coded Google endpoints; nothing in them can select the stub.

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

## Browser differences the suite accounts for

- Playwright's browsers never block popups. Where the spec needs the blocked-popup path (Safari after an `await`: the
  wagmi and SWK connect paths in WebKit), the partner page's `window.open` returns null (`?blockPopups=1`).
- Playwright launches Chromium with storage partitioning off (microsoft/playwright#32230); Firefox runs with its
  shipped default (`network.cookie.cookieBehavior = 5`). The partitioning case asserts an empty store (IndexedDB) on
  site B in Firefox and WebKit, and in Chromium that the vault leaves the other site's record unused.
- Playwright's WebKit doesn't apply COOP to a route-fulfilled response, so the "IdP enforces COOP" case checks the
  browsing-context switch in Chromium and Firefox only.
