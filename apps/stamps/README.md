# @hana-id/stamps

**Journear Passport stamps**: a NEAR-only testnet demo site for the NEAR hackathon (D798–D802). A passport booklet:
sign in with email (or Google) through Journear Passport, get a NEAR account with no seed phrase and zero NEAR, and
collect stamps, each one a real NEAR testnet transaction to the stamps contract (`contracts/hana-stamps`,
`near.demoStamps` in the manifest) approved in the Journear Passport window, most of them paid by Journear's relayer.
A public page shows anyone's passport, read live from the chain, and the recent stamps of all travellers. No Stellar or
EVM anywhere on the site (the hosted demo, `apps/demo`, shows every chain and stays as it is).

It is a partner-style page on `@hana-id/web`, built and served like the hosted demo: one Vite page in plain
TypeScript, a Cloudflare Worker with static assets, the configuration baked in at build time, no key or token ever on
the page.

| Env | URL | App |
|---|---|---|
| `sandbox-dev` | `https://hana-id-stamps-sandbox-dev.tingtc.workers.dev` (not deployed yet) | its own, created by staff (below); `HANA_STAMPS_PUBLISHABLE_KEY` |

## What the page does

- **Routes** (`src/routes.ts`): `/` is the signed-in user's passport, or the cover with *Sign in* when signed out;
  `/p/<account_id>` is anyone's passport, read-only, no sign-in. The id is validated strictly (a 64-hex implicit
  account, or a named `.testnet` account for viewing): anything else is a 404 from the Worker. Both show *Recent
  stamps* (the contract's `recent`, newest first, each linking to that traveller's passport) and the totals.
- **Sign in**: `hana.login()` in the click, with no method, so Journear Passport's window offers email and Google.
  Signing in from a public passport goes to your own.
- **The stamps** (`src/collector.ts`, one collector per stamp, D800), each `collect({ stamp, note?, proof? })` on the
  contract:

  | Stamp | How | Unlocks |
  |---|---|---|
  | Arrival | relayed (gasless): `hana.near.activate()` for a new account, a NEP-366 delegate action, `signDelegateAction`, `hana.near.relay` | always first |
  | Sponsored | relayed | after Arrival |
  | Own fare | `hana.near.signTransaction` of an ordinary `collect` transaction, sent with the RPC's `send_tx`: the user's own NEAR pays | after Arrival, once the account holds 0.01 testnet NEAR (until then "Needs testnet NEAR", the balance shown and a notice with a faucet link) |
  | Signature | `hana.near.signMessage` (NEP-413, message `Stamp my passport: <account_id>`, recipient the contract's account, a fresh 32-byte nonce), then the relayed `collect` with the proof: two approvals in one window | after Arrival, implicit accounts only |
  | Postcard | relayed, with a note of 1 to 140 characters (Rust's `trim`, Unicode scalar values, as the contract counts) | after Arrival |
  | Layover | relayed | 2 minutes (block time) after Arrival: a countdown, from the Arrival's `block_timestamp_ms` |

  The relayed flow is the hosted demo's guestbook write (D750, D751, D788): the account's key nonce, the latest final
  block and the balance are read before the click (when the passport shows, on pointer or focus over a collect button
  or the note box, which also activates a new account, and every 30 s), so the click signs at once and the approval
  opens in it; without a fresh read the click calls `hana.prepareApproval()` first. Activate and relay are retried for
  about 20 s while the API answers `409 near_account_unrecorded`; a `delegate_nonce_used` is rebuilt above the
  relayer's nonce and asked once more. A relay that timed out with its transaction sent shows "Sent, still confirming"
  with the NearBlocks link (D788). Gas on each `collect` is the manifest's relay cap (`near.relay.maxGasTgas`, 10 Tgas
  on sandbox-dev).
- **Which stamps are open** is computed on the page from the chain (`src/view.ts`), but the contract decides: its
  refusals (`ERR_NO_ARRIVAL`, `ERR_ALREADY`, `ERR_NOT_SPONSORED`, `ERR_NOT_OWN_FARE`, `ERR_BAD_PROOF`, `ERR_NOT_IMPLICIT`,
  `ERR_BAD_NOTE`, `ERR_TOO_SOON`, `ERR_UNKNOWN_STAMP`), the vault's and the relayer's come back on the stamp in plain
  words (`src/messages.ts`). A collected stamp shows at once (then confirmed from the chain), inked once (`fresh`), with
  its transaction's NearBlocks link for this session's stamps and the account's page for older ones.
- **Polling**: the passport, `recent` (both pages of the ring of 100) and `totals` every 15 s while the tab is visible,
  again when it becomes visible (back from the faucet), and after each collect until the stamp shows.

The rendering is the UI module's (`src/ui/` and `src/ui.css`, the art build's, D803–D804: the booklet and the six
stamps drawn in code, with a preview harness, `preview:ui` and `shots`; its contract with the site and the `data-*`
hooks the site uses: [`UI-CONTRACT.md`](UI-CONTRACT.md)). The rest (`src/app.ts` state, `src/view.ts` the view, `src/collector.ts`,
`src/stamps.ts` the contract's bytes and answers, `src/routes.ts`, `src/messages.ts`, `src/config.ts`, `src/csp.ts`,
`worker/`) is the site build's. It reuses the hosted demo's NEAR code by importing it (D802): `apps/demo/src/near.ts`
(`NearRpc`, the nonce rules, `displayText`, Rust's trim), `errors.ts` (`errorInfo`, `relayTransaction`), `config.ts`
(`webOrigin`) and `csp.ts` (`securityHeaders`), unchanged.

## Security

- The site holds no key, token or secret: it sees the user's NEAR account id and the signatures they approve. Keys
  stay in Journear Passport's vault and windows.
- Everything read from NEAR is untrusted (D753, D800): `get_passport`, `recent` and `totals` are parsed field by field
  (known stamp ids, valid account ids, u64 times, bounded counts and sizes, each stamp once), notes go into text nodes
  only with control, bidi and zero-width characters replaced and cut to 140 characters, and accounts a public passport
  can't show (or a `0x…` NEAR account that would read as another chain's) are left out of the recent list. Only an
  `ERR_*` code is ever matched from a contract's or NEAR's error text, never shown raw.
- Every response carries the demo's headers (`src/csp.ts`). The page's CSP:

  ```text
  default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self';
  connect-src <NEAR rpc> <NEAR rpcFallback> <apiUrl>; frame-src <vaultOrigin>; base-uri 'none';
  form-action 'none'; frame-ancestors 'none'; require-trusted-types-for 'script'; trusted-types 'none'
  ```

  No EVM RPC, no inline code, no third-party script. COOP `same-origin-allow-popups` (the login and approval windows
  are popups). The Worker answers only GET/HEAD on its own origin, serves the page only on `/` and valid `/p/<id>`,
  drops cookies, and serves nothing (503) without its CSP var.
- `src/config.ts` refuses a `pk_live_` key, a non-testnet or non-`sandbox*`/`local*` env, a stamps contract that
  isn't a `.testnet` account, and a non-https origin (http only on loopback).
- `test/brand.test.ts` fails on "Hana" in any string the site can show, on Stellar, EVM or Ethereum text or addresses,
  on `innerHTML`, and on raw colours or `--hana-` variables in any stylesheet (the art build's included).

## Configuration

Chosen at build time from the shell (no `.env` files):

| Variable | |
|---|---|
| `HANA_STAMPS_ENV` | `envs/<name>.json`, default `sandbox-dev`; testnet `sandbox*`/`local*` envs only |
| `HANA_STAMPS_PUBLISHABLE_KEY` | required: the stamps app's `pk_test_` key (no default) |
| `HANA_STAMPS_ORIGIN` | none: the API's workers.dev subdomain; a bare https origin makes it a Custom Domain (D404) |

From the manifest: `vaultOrigin`, `apiUrl`, `rpc`, `rpcFallback`, `near.demoStamps` (required: without it the build
and `gen` refuse with "sets no near.demoStamps") and `near.relay.maxGasTgas` (the gas on `collect`, default 10). The
explorer is NearBlocks testnet; the faucet link is `https://near-faucet.io/` (`src/config.ts`).

## Deploy

1. **The contract** (the contract build): `contracts/hana-stamps` deployed and locked, its account in
   `near.demoStamps` and in `near.relay.receivers`, the API redeployed with the receivers (`docs/operations.md`).
2. **The app** (staff, once): an app of its own on a test scope that has email login (sandbox-dev's demo scope `s2`),
   with the site's origin and `http://localhost:5175`, and email login on: `docs/operations.md` "Hosted stamps demo".
3. **Build and deploy** (`wrangler login` first):

   ```sh
   HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… corepack pnpm --filter @hana-id/stamps run deploy
   ```

   `deploy` regenerates `packages/web/src/envs.generated.ts`, builds `dist/`, writes the gitignored
   `apps/stamps/wrangler.jsonc` (`gen`) and runs `wrangler deploy`. To check without deploying: `build`, `gen`, then
   `corepack pnpm --filter @hana-id/stamps exec wrangler deploy --dry-run`.

Redeploy after a change to `envs/<env>.json` (the vault, the RPCs, the API and the contract are in the CSP and the
bundle) or to `@hana-id/web`.

## Local

```sh
HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… corepack pnpm --filter @hana-id/stamps dev       # http://localhost:5175 (no CSP: Vite's dev server injects inline styles)
HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… corepack pnpm --filter @hana-id/stamps build && corepack pnpm --filter @hana-id/stamps preview   # the built page with its headers
```

Both need `http://localhost:5175` on the app's origins. Both serve the page on `/p/<id>` too.

## Tests

```sh
corepack pnpm --filter @hana-id/stamps test        # state machine, collectors, parsing, view, routes, config, CSP, Worker, gen, guards
corepack pnpm --filter @hana-id/stamps typecheck
```

`apps/e2e` builds the site for its local stack and serves it with this Worker handler and its real CSP
(`http://localhost:<base + 3>`): `tests/stamps.spec.ts` signs in by email, collects Arrival, Sponsored, Postcard and
Signature and sees them on the public passport, with no CSP violation and nothing of another chain on the page, in
Chromium, Firefox and WebKit. The stack's mocked NEAR RPC serves the stamps contract (`src/server/stamps-contract.ts`:
its views and rules, the signature's NEP-413 proof verified with ed25519 as on chain); `POST /v1/near/activate` and
`/relay` are mocked at the network layer as in the demo's spec.
