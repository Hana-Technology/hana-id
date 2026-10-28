# @hana-id/smoke

A plain local page (Vite + vanilla TypeScript) that runs the whole Hana ID login against a **deployed testnet**
environment: Google sign-in → `POST /v1/sessions` (create_session) → `POST /v1/derive` (derive_key + the real NEAR MPC)
→ CKD decryption and pairing check in the browser → addresses. Use it to verify the real MPC, measure gas and
latency, and check per-app isolation before the SDK (batch B) exists. It is test tooling, not the SDK.

It shows public data only. The Google ID token goes only to `POST /v1/sessions` (it is kept in memory for the
"replay create_session" button and dropped with the session). The CKD secret and the derived private keys exist only
inside one function call and are zeroed afterwards; they are never displayed, logged, stored or sent.

> **Addresses use derivation v1** (`@hana-id/core/derivation`, HKDF-SHA256 with salt `hana-id/chain-keys/v1/extract`),
> which replaced the PROVISIONAL legacy derivation (salt `hana-embed-ckd-v1`) in batch B, so addresses logged before
> that differ. Testnet addresses stay disposable until the address freeze.

> **Batch B status.** The page still runs the batch A flow from the partner page itself: Google Identity Services,
> then `/v1/sessions` and `/v1/derive` (the split flow), with the session key, the BLS key and the CKD in this page.
> Since batch B the API allows these partner-origin calls only for `pk_test_` keys in envs whose name starts with
> `local` or `sandbox`. Batch B step 7 (`docs/batch-b-spec.md`, "Order of work") moves the page onto `@hana-id/web`:
> the Hana vault and one-transaction `/v1/login`. Until then:
> - keep `REJECT_PII_ON_SESSIONS = "0"`, because Google Identity Services tokens carry `email`, `name` and
>   `picture`, which the claim allow-list refuses (`400 token_has_pii`);
> - your Google client needs `http://localhost:5173` as an authorised JavaScript origin, which the vault's redirect
>   flow doesn't need;
> - the page still shows a token with personal claims to the API, and it lands on chain. Use test accounts.
>
> Partners integrate through `@hana-id/web`, never this way: see `docs/integration.md`.

## Prerequisites

1. **A deployed environment** (`envs/<env>.json`, default `sandbox-dev`), see the root README "Deploying a sandbox
   environment end to end":
   - `hana-signer` deployed on the manifest's `signer`, Google keys posted (`post-google-keys`), shared clients set if
     you test the shared client;
   - the API deployed with its relayer secrets, and the manifest's `apiUrl` set to the deployed Worker URL (or set
     `VITE_HANA_API_URL`, below);
   - `ckdNetworkKey` pinned: `pnpm --filter @hana-id/scripts fetch-ckd-key <env>`. The page refuses to derive while it
     is the `UNSET` placeholder.
2. **A scope and an app** that allows this page's origin. For an isolation test, create two (A and B):

   ```sh
   pnpm --filter @hana-id/scripts admin <env> scope:register --client <google client id> --owner-near <account> --yes
   # or a shared-only scope:  scope:register --allow-shared --owner-near <account> --yes
   pnpm --filter @hana-id/scripts admin <env> app:create --name smoke-a --scope s1 --origin http://localhost:5173 --remote
   ```

   `app:create` prints the publishable key (`pk_test_…`; public). Loopback origins only work with `pk_test_` keys.
3. **Google OAuth client(s)**: every client you sign in with (the app's own client and/or Hana's shared client) must
   list `http://localhost:5173` under *Authorized JavaScript origins* in Google Cloud console (Google also recommends
   adding `http://localhost`). Changes there can take a few minutes to apply.

## Run

```sh
pnpm install
pnpm --filter @hana-id/smoke dev                         # envs/sandbox-dev.json, http://localhost:5173
VITE_HANA_ENV=<env> pnpm --filter @hana-id/smoke dev      # another manifest
VITE_HANA_API_URL=http://localhost:8787 pnpm --filter @hana-id/smoke dev   # a local `wrangler dev` API
```

The manifest is read and validated (`@hana-id/env`) when the dev server starts; restart it after changing
`envs/<env>.json`. `VITE_HANA_ENV` / `VITE_HANA_API_URL` may also go in `apps/smoke/.env.local` (gitignored).

```sh
pnpm --filter @hana-id/smoke test        # vitest: byte layouts vs contract fixtures, CKD, addresses, page flow (mocked)
pnpm --filter @hana-id/smoke typecheck
```

## Using the page

1. **App**: paste the publishable key (remembered in `localStorage`; it is public) → *Load app*. The page calls
   `GET /v1/app` (scope, Google client, mode), checks that the API's signer is the manifest's, and reads
   `get_scope` / `get_config().shared_clients` over RPC to offer every Google client the scope can use: its own
   clients, and Hana's shared clients when the scope has `allow_shared`.
2. **Session**: choose `key_index` (default 0; 0 to 2^31 − 1, higher values are reserved and refused) and `max_uses`
   (default 5, 1 to 500) → *Start session*. The page makes a
   non-extractable Ed25519 session key, a random 32-byte salt and an expiry of now + 1 h, computes the batch A.2 session
   nonce and renders the Google button for the chosen client.
3. Sign in. The page checks the token's `nonce` and `aud`, calls `POST /v1/sessions`, then immediately derives
   (counter 1): fresh BLS12-381 key, session signature over
   `"hana-id-session-v1:" ‖ counter u64 LE ‖ sha256("hana-id-ckd-v1:{pk1}:{pk2}")`, `POST /v1/derive`, decryption, pairing
   check against the pinned `ckdNetworkKey`, derivation v1 addresses and `app_id`.
4. Buttons: *Derive again* (counter + 1), *Revoke session* (signature over `"revoke"`), *Replay last create_session*,
   *Replay last derive*, *New session* (then change key index, client or publishable key).

Timings: **Google** is from rendering the button to the token, so it includes your clicks; **create_session** and
**derive_key** are API round trips (relay + execution); **decrypt+verify** is local; **total** runs from *Start session*
(or *Derive again*) to the addresses. Gas is read afterwards from the RPC `tx` call (sender = the manifest's `relayer`)
and sums the transaction and all its receipts, including the MPC's.

The results log keeps every run (public data, in `localStorage`) and compares each run with the earlier ones of the
same environment: same path must give the same addresses and `app_id`, a different path must give different ones.
*Copy results as JSON* copies the log.

Every relayed call costs testnet gas, including a replayed derive (it passes the API's signature check and is rejected
by the contract).

## Google openid-only spike (`spike.html`)

`http://localhost:5173/spike.html` answers batch B's go/no-go questions with no API and no chain: it runs Google's
implicit flow with `scope=openid` only (`response_type=id_token`, `prompt=select_account`, optionally `max_age=0`) in
a popup that redirects to `http://localhost:5173/spike-callback.html`, then decodes the token in the page. It shows the
claims only in the page and builds a summary with no personal values (claim names, whether `hd` or `auth_time` is
present, whether the nonce matched, and whether the popup kept `window.opener`) to paste into `docs/context.md`.
The client must list that callback URL as an Authorized redirect URI; remove it after the spike. The 2026-10-28
results are in `docs/context.md` ("Google openid-only spike").

## Test checklist

- [ ] **Real MPC**: a derive succeeds and the pairing check passes against the pinned `ckdNetworkKey` (a wrong pinned
      key fails with "CKD response failed the pairing check").
- [ ] **Isolation, app A vs B**: same Google account, apps in different scopes (`key_index` 0 both): paths differ only
      in the scope, addresses and `app_id` differ (log check "same user, other scope … addresses differ").
- [ ] **Key index**: same app and account, `key_index` 0 then 1: different paths and addresses. Back to 0 in a new
      session: same addresses as the first run.
- [ ] **Own vs shared client, same path**: on a scope with its own client and `allow_shared`, one session through the
      own client and one through the shared client (same account, same `key_index`): the same path and the same
      addresses (log check "own vs shared client … same addresses"). If the paths differ only in the `sub`, Google
      gives a different `sub` per client: raise it (docs/context.md assumes it is the same).
- [ ] **Shared-only scope**: an app on a scope registered with `--allow-shared` and no client gets `mode: shared`
      from `/v1/app` and logs in.
- [ ] **Derive again**: counter 2 gives the same addresses; *Derive again* past `max_uses` fails with
      `409 session_exhausted` (refused by the API, no transaction).
- [ ] **Revoke**: *Revoke session* succeeds; *Derive again* afterwards fails (`404 unknown_session`).
- [ ] **Replay rejected**: *Replay last create_session* → `409 session_exists`; *Replay last derive* → `409
      counter_used` (refused by the API, no transaction), `409 session_exhausted` once `max_uses` is reached, or `404`
      after a revoke. "REPLAY ACCEPTED" in the event log is a failure.
- [ ] **Latency and gas**: copy the results JSON for a few runs and note create_session / derive_key gas against the
      API defaults in `apps/api/src/gas.ts` (50 / 60 Tgas, "to measure on testnet").
