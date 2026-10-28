# @hana-id/smoke

Local test pages (Vite + vanilla TypeScript, `http://localhost:5173`) that run the Hana ID login against a **deployed
testnet** environment. They are test tooling, not the SDK and not an integration guide.

| Page | Flow | Use it for |
|---|---|---|
| `/` (`index.html`, `src/vault-page.ts`) | The real partner client, `@hana-id/web`: vault iframe → Hana login popup → Google (openid only) → `POST /v1/login` (`create_session_and_derive`) → CKD decryption and derivation v1 **inside the vault** | Everything a partner gets: login, timings, persistence and unlock, logout, export, approval and the auto-approve demo |
| `/direct.html` (`src/direct.ts`) | The in-page flow from before the vault: Google Identity Services → `POST /v1/sessions` → `POST /v1/derive` → CKD decryption in the page | The split-flow baseline for the ship gate, and what the vault can't do: `key_index` ≠ 0, choosing the Google client, derive again, revoke, replays |

The vault page sees only what a partner sees: status, addresses, expiry, persistence, events and, for `pk_test_`
apps, the login's per-stage timings. The Google token, the session key, the CKD secret and the chain keys stay in the
Hana pages. The direct page sends the Google token only to `POST /v1/sessions` (kept in memory for the replay button)
and zeroes the CKD secret and derived keys inside one function call; neither page displays, logs, stores or sends
them anywhere else. Partners integrate through `@hana-id/web` like the vault page, never like the direct
page: see [`docs/integration.md`](../../docs/integration.md).

> **The direct page works only while the env's `REJECT_PII_ON_SESSIONS` is `"0"`** (every env's default until the
> user turns it on, `docs/batch-b-spec.md` "Order of work" step 7). Google Identity Services tokens carry `email`,
> which `/v1/sessions` refuses with 400 `token_has_pii` once it is `"1"`; the page then says so. The vault's tokens
> are openid-only and pass.

> **Addresses use derivation v1** (`@hana-id/core/derivation`, HKDF-SHA256 with salt `hana-id/chain-keys/v1/extract`),
> which replaced the PROVISIONAL legacy derivation (salt `hana-embed-ckd-v1`) in batch B, so addresses logged before
> that differ. Testnet addresses stay disposable until the address freeze.

## Prerequisites

1. **A deployed environment** (`envs/<env>.json`, default `sandbox-dev`), see the root README "Deploying a sandbox
   environment end to end":
   - `hana-signer` deployed on the manifest's `signer` with `create_session_and_derive`, Google keys posted
     (`post-google-keys`), shared clients set if you test the shared client;
   - the API deployed with its relayer secrets and `VAULT_KEK`, and the vault and auth page Workers deployed
     (`pnpm --filter @hana-id/web build`, then `pnpm --filter @hana-id/api run deploy:pages`);
   - the manifest's `vaultOrigin` and `authOrigin` set (the vault page refuses to run without them) and
     `ckdNetworkKey` pinned (`pnpm --filter @hana-id/scripts fetch-ckd-key <env>`; the web build refuses the `UNSET`
     placeholder).
2. **A scope and an app** that allows this page's origin. Use a `pk_test_` key: loopback origins (this page) work only
   with `pk_test_` keys in `local*`/`sandbox*` envs, and only `pk_test_` logins return per-stage timings. For the
   isolation checks, create two (A and B) in different scopes:

   ```sh
   pnpm --filter @hana-id/scripts admin <env> scope:register --client <google client id> --owner-near <account> --yes
   # or a shared-only scope:  scope:register --allow-shared --owner-near <account> --yes
   pnpm --filter @hana-id/scripts admin <env> app:create --name smoke-a --scope s1 --origin http://localhost:5173 --remote
   ```

   `app:create` prints the publishable key (`pk_test_…`; public).
3. **Google OAuth clients.** Vault page: every client the app logs in with (its own, or Hana's shared one) lists
   `{authOrigin}/login/callback` under *Authorized redirect URIs*. Direct page: the client also lists
   `http://localhost:5173` under *Authorized JavaScript origins* (Google also recommends `http://localhost`). Changes
   there can take a few minutes to apply.

## Run

```sh
pnpm install
pnpm --filter @hana-id/smoke dev                         # envs/sandbox-dev.json, http://localhost:5173
VITE_HANA_ENV=<env> pnpm --filter @hana-id/smoke dev      # another manifest
VITE_HANA_API_URL=http://localhost:8787 pnpm --filter @hana-id/smoke dev   # a local `wrangler dev` API
```

`dev` and `build` first regenerate `packages/web/src/envs.generated.ts` (`gen:envs`), the env constants the partner
client is built with (`typecheck` writes it only when it is missing). The manifest is read and validated (`@hana-id/env`) when the dev server starts;
restart it after changing `envs/<env>.json`. `VITE_HANA_ENV` / `VITE_HANA_API_URL` may also go in
`apps/smoke/.env.local` (gitignored). `VITE_HANA_API_URL` changes only the pages' own API calls: the vault and login
pages use the `apiUrl` they were built with.

```sh
pnpm --filter @hana-id/smoke test        # vitest: both pages (mocked), results logs, ship gate, the auto-approve demo
pnpm --filter @hana-id/smoke typecheck
```

## Using the vault page

1. **App**: paste the publishable key (remembered in `localStorage`; it is public) and, optionally, a label for the
   Google account you will use (`personal`, `workspace`: up to 32 letters, digits, spaces, `_ . -`, never an email
   address) → *Load app*. The page mounts the vault (`createHana`) and calls `GET /v1/app` itself to show the app's
   name, scope, Google client and auto-approve policy, and to check that the API's signer is the manifest's.
2. **Wallet**: *Log in with Hana* opens the Hana login popup from the click. *Cancel login*, *Log out*, *Remount the
   vault* (destroys the client and mounts a new one, as a reload does), *Reload the page*, *Revoke other devices*
   (only within 5 min of a fresh login), *Export Stellar key* / *Export EVM key* (the vault shows its launcher; the
   key is shown only in the Hana export window, after a fresh Google sign-in).
3. **Signing and auto-approve**: the request buttons sign (never broadcast) one request each and log the outcome:
   *signed, auto-approved (no popup)*, *signed after approval*, *rejected (4001)* or *refused* with the code. See
   [Auto-approve demo](#auto-approve-demo).

Every login is a results-log run with the vault's stages (pk_test_ apps): **app** (Google client), **popup** (until
the login popup connected), **google** (Google's pages and the relay, so it includes your clicks), **verify** (RS256
and claims), **chain** (`POST /v1/login`, with any retries), **decrypt** (CKD decryption, pairing check, derivation
v1), and **total** from the click to the addresses on this page (it also covers the share creation). Every mount that
comes back logged in (page load, reload, new tab, *Remount*) is an **unlock** run, with **total** from `createHana`
to `ready`: the iframe load, the vault page render and one `POST /v1/vault/unlock`.

The results log keeps every run (public data, in `localStorage`) and checks it against the earlier ones of the same
environment and signer:
- an unlock must give the addresses of the latest earlier run of the same app;
- a login with the same account label and scope must give the same addresses (also across own and shared client);
- the same label in another scope, or another label, must give different addresses;
- a login whose addresses equal a direct-page run's (same scope, `key_index` 0) is noted: the vault and the in-page
  derivation agree.

*Copy results as JSON* copies both logs (vault and direct). Gas isn't in the vault log: the vault returns no
transaction hash, so read `create_session_and_derive` gas from the relayer's transactions on nearblocks (linked under
the environment).

### Ship gate

The *Ship gate* panel compares the median of the latest 10 vault logins' **chain** stage (`create_session_and_derive`
round trip) with the median of the latest 10 direct-page sessions' create_session + derive_key round trips (counter 1).
If the combined call saves less than 1.5 s, it is removed before the audit (session keys go to allowlist state 3;
otherwise state 2). The panel only computes; recording the result in `docs/context.md` and rotating the keys are the
user's steps.

### Auto-approve demo

`policies/demo-auto-approve.json` is a testnet policy that covers exactly two harmless requests: a native-XLM SAC
`transfer` of 1 stroop to yourself on Stellar testnet, and a Sepolia USDC `approve(you, 1)` (address rule
`self-or-listed`, 20 a day, consent for 1 h). Set it on the app (it takes effect after the env's `changeDelayMs`):

```sh
pnpm --filter @hana-id/scripts admin <env> app:settings <app id | pk> --auto-approve apps/smoke/policies/demo-auto-approve.json --remote
pnpm --filter @hana-id/scripts admin <env> app:settings <app id | pk> --auto-approve off --remote   # immediate
```

Reload the page after the delay: *App policy in force* shows `= the demo policy` with its policyId. Then *Accept the
policy* (or the first covered request) opens the consent screen, after which the "covered" buttons sign with no popup;
the "stranger" / "burn address" ones break the address rule and get the popup, which says why; `personal_sign` always
gets the popup; raw signing is 4100 unless the app has `--raw-sign approval`.

## Using the direct page

1. **App**: paste the publishable key → *Load app*. The page calls `GET /v1/app` (scope, Google client, mode), checks
   that the API's signer is the manifest's, and reads `get_scope` / `get_config().shared_clients` over RPC to offer
   every Google client the scope can use: its own clients, and Hana's shared clients when the scope has
   `allow_shared`.
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
and sums the transaction and all its receipts, including the MPC's. Its results log compares runs by path: same path
must give the same addresses and `app_id`, a different path must give different ones.

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

### Vault page

- [ ] **Login through the vault**: one click on *Log in with Hana* → Google's account chooser → addresses. The run
      has all six stages and the log shows no `/v1/sessions` or `/v1/derive` call from this page (DevTools →
      Network, this page and the vault frame: one `POST /v1/login`).
- [ ] **openid-only token**: the login succeeds with `REJECT_PII_ON_SESSIONS` either way (the vault and `/v1/login`
      always apply the claim allow-list; a refused claim shows as `token_has_pii` with the claim).
- [ ] **Vault agrees with the in-page derivation**: same Google account and scope, a direct-page run at `key_index` 0
      and a vault login: the vault run notes "same addresses as the in-page derivation".
- [ ] **Isolation, app A vs B**: same account label, apps in different scopes: "same account, other scope … addresses
      differ"; another Google account with another label: "other account … addresses differ".
- [ ] **Own vs shared client**: one scope, a login while it uses the shared client and one after it has its own client
      (or the reverse), same account label: "same account and scope, shared → own client: same addresses". Use an own
      client in a **separate Google Cloud project** from the shared one, or this doesn't prove the A.2 promise.
- [ ] **Persistence 'session' (default), reload**: *Reload the page* → an unlock run "OK — unlock restored #n's
      addresses" in well under a second (note the total), and DevTools shows no `/v1/derive`, no `/v1/login` and no
      NEAR RPC call, only `POST /v1/vault/unlock`.
- [ ] **New tab**: open `http://localhost:5173` in a second tab: it unlocks the same addresses. *Remount the vault*
      does the same within one tab.
- [ ] **Logout**: *Log out* in one tab: the other tab of the app logs out too (`accountsChanged: logged out`), and a
      reload stays logged out (no unlock run).
- [ ] **Other app, same site**: app B in the same browser: no unlock of app A's wallet (B's first load is logged out).
- [ ] **Persistence 'none'**: `admin app:settings <app> --persistence none --remote`, log in, reload: logged out (a full
      login each load). Back to `--persistence session` afterwards.
- [ ] **Idle and absolute limits**: with `--idle-ttl 15m`, reload after 15 idle minutes → logged out (410
      `share_expired`: the vault deletes the record and needs a full login, never a derive). Optional:
      `--session-ttl 1h` and reload after an hour.
- [ ] **Revoke other devices**: log in in two browser profiles, then *Revoke other devices* within 5 min of the second
      login: the first profile's reload is logged out. After 5 min it is refused (4100, `share_not_fresh`).
- [ ] **Export**: *Export Stellar key* and *Export EVM key*: the launcher, the Hana export window, a fresh Google
      sign-in, the key shown next to the address that matches this page's (never on this page).
- [ ] **Approval**: with no auto-approve policy, each request button opens the Hana approval popup; Approve gives
      "signed after approval", Reject or closing it gives "rejected (4001)".
- [ ] **Auto-approve**: with the demo policy in force: *Accept the policy* → consent; the two "covered" requests give
      "signed, auto-approved (no popup)"; the "stranger" and "burn address" ones open the popup with the reason;
      `personal_sign` always opens it; *Stop auto-approving* → the covered ones need the popup again; `--auto-approve
      off` stops it at once (reload).
- [ ] **Raw signing**: *Raw sign* is "refused: 4100" by default; with `--raw-sign approval` (after the delay) it opens
      the popup with the raw warning.
- [ ] **Ship gate**: 10 vault logins and 10 direct-page sessions (the direct page needs `REJECT_PII_ON_SESSIONS = "0"`):
      the panel's verdict. Record it, the gas of a few `create_session_and_derive` transactions (nearblocks) and the
      unlock total in `docs/context.md`.
- [ ] **After `REJECT_PII_ON_SESSIONS = "1"`** (the user's switch): the direct page's sign-in fails with "400
      token_has_pii … the direct flow is retired here", and the vault page keeps logging in.

### Direct page (while `REJECT_PII_ON_SESSIONS = "0"`)

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
