# @hana-id/smoke

Local test pages (Vite + vanilla TypeScript, `http://localhost:5173`) that run the Hana ID login against a **deployed
testnet** environment. They are test tooling, not the SDK and not an integration guide.

| Page | Flow | Use it for |
|---|---|---|
| `/` (`index.html`, `src/vault-page.ts`) | The real partner client, `@hana-id/web`: vault iframe → Hana login popup → Google (openid only) → `POST /v1/login` (`create_session_and_derive`) → CKD decryption and derivation v1 **inside the vault** | Everything a partner gets: login, timings, persistence and unlock, logout, export, approval and the auto-approve demo |
| `/direct.html` (`src/direct.ts`) | The in-page flow from before the vault: Google, `scope=openid` only (a popup through `direct-callback.html`) → `POST /v1/sessions` → `POST /v1/derive` → CKD decryption in the page | The split-flow baseline for the ship gate, and what the vault can't do: `key_index` ≠ 0, choosing the Google client, derive again, revoke, replays |

The vault page sees only what a partner sees: status, addresses, expiry, persistence, events and, for `pk_test_`
apps, the login's and the unlock's per-stage timings (names and durations only, [Timings](#timings)). The Google token, the session key, the CKD secret and the chain keys stay in the
Hana pages. The direct page sends the Google token only to `POST /v1/sessions` (kept in memory for the replay button),
never one with a claim outside the API's allow-list, and zeroes the CKD secret and derived keys inside one function call; neither page displays, logs, stores or sends
them anywhere else. Partners integrate through `@hana-id/web` like the vault page, never like the direct
page: see [`docs/integration.md`](../../docs/integration.md).

> **Both pages get openid-only Google tokens.** The API refuses any Google token with a claim outside the allow-list
> (`iss azp aud sub iat exp nonce nbf jti auth_time at_hash`; `at_hash` since D342) with 400 `token_has_pii` on every route, `/v1/sessions`
> included, with no flag to turn it off (D271). The direct page used Google Identity Services, whose tokens carry
> `email`, until D271; it now asks Google's implicit flow for `response_type=id_token`, `scope=openid` (as the Hana
> login popup does) and checks the claims itself before sending anything.

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
   with `pk_test_` keys in `local*`/`sandbox*` envs, and only `pk_test_` apps get per-stage timings. For the
   isolation checks, create two (A and B) in different scopes:

   ```sh
   pnpm --filter @hana-id/scripts admin <env> scope:register --client <google client id> --owner-near <account> --yes
   # or a shared-only scope:  scope:register --allow-shared --owner-near <account> --yes
   pnpm --filter @hana-id/scripts admin <env> app:create --org org_legacy --name smoke-a --scope s1 --environment test --origin http://localhost:5173 --remote
   pnpm --filter @hana-id/scripts admin <env> app:changes:announce <gc id> --remote   # each origin's gc_… id, printed above
   ```

   `app:create` prints the publishable key (`pk_test_…`; public) and each origin's proposal id; an origin is in force
   once announced (at once on a scope with no login yet, else `appChangeDelayMs` later; `docs/operations.md` "Admin
   CLI"). `--environment` is needed only for a scope with no app yet.
3. **Google OAuth clients.** Vault page: every client the app logs in with (its own, or Hana's shared one) lists
   `{authOrigin}/login/callback` under *Authorized redirect URIs*. Direct page: the client also lists
   `http://localhost:5173/direct-callback.html` under *Authorized redirect URIs* (exact; no JavaScript origin is needed
   any more). Changes
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
   *signed, auto-approved (no popup)* (the approval popup the click opened closes at once), *signed under the policy,
   after the consent screen* (a covered request with no consent in force, or one for which the vault showed its
   launcher), *signed after approval*, *rejected (4001)* or
   *refused* with the code. One request runs at a time: the sign, auto-approve and export buttons stay disabled until
   it settles, so each label is that request's own. See [Auto-approve demo](#auto-approve-demo).

Every login is a results-log run with **total** from the click to the addresses on this page, and every mount that
comes back logged in (page load, reload, new tab, *Remount*) is an **unlock** run with **total** from `createHana` to
`ready`. For `pk_test_` apps both carry their stages ([Timings](#timings)) in the *Timings* table and the JSON.

The results log keeps every run (public data, in `localStorage`) and checks it against the earlier ones of the same
environment and signer:
- an unlock must give the addresses of the latest earlier run of the same app;
- a login with the same account label and scope must give the same addresses (also across own and shared client);
- the same label in another scope, or another label, must give different addresses;
- a login whose addresses equal a direct-page run's (same scope, `key_index` 0) is noted: the vault and the in-page
  derivation agree.

Tabs share the log: each run is appended to the log as stored at that moment, and a tab shows another tab's runs as
soon as they are written, so a second tab's unlock run is never lost. Each run also records the API it called (the
vault's is always the manifest's `apiUrl`; the direct page's is `VITE_HANA_API_URL` when set).

*Copy results as JSON* copies both logs (vault and direct). Gas isn't in the vault log: the vault returns no
transaction hash, so read `create_session_and_derive` gas from the relayer's transactions on nearblocks (linked under
the environment).

### Timings

`pk_test_` apps only (`pk_live_` apps never get any: the vault, the login popup, the partner client and the API each
check). Every number is a duration measured on one clock (a page's `performance.now()`, its navigation timing, or
the API's own) and passed on as a duration, never a timestamp compared across pages. The names are
`@hana-id/core`'s `LOGIN_TIMING_*` / `UNLOCK_TIMING_*` (`packages/core/src/timings.ts`).

**Stages** follow one another: with **other** (added by this page: its total minus their sum) they add up to the run's
**total**. If the stages ever pass the total, `other` is 0 and the excess is **overrun**. **Breakdown** values are parts
of one stage (the API's own time inside a round trip) or run alongside the others; they are not added.

Login stages, in order:

| Stage | Clock | What it covers |
|---|---|---|
| `open` | partner page | `window.open` of the login popup in the click |
| `wait` | partner page | until the vault's handshake was done and `hana_login` sent (0 once the page is ready) |
| `app` | vault | `GET /v1/app` (normally answered already: the vault asks right after `ready`; a 5xx or network failure is asked once more) |
| `keygen` | vault | the session key, salt, nonce and relay keys |
| `popup` | vault | until the login popup's hello (popup window, `/login` load) |
| `authCheck` | `/login` | its checks of the vault's message (pinned signer, nonce) and storing the relay key, until it shows the chooser or navigates on; no API call since D77 |
| `choose` | `/login` | only when the popup shows the method chooser (an app with email): chooser shown → click (D260) |
| `emailLoad` | `/login/email` | email login only: the email step's navigation, the chooser's click → the address screen |
| `emailEntry` | `/login/email` | email login only: the user on the address screen (summed over visits) |
| `emailStart` | `/login/email` | email login only: the issuer's `start` round trip (and any `resend`) |
| `emailCode` | `/login/email` | email login only: the code screen, the mail's delivery and the user typing the code |
| `emailVerify` | `/login/email` | email login only: the issuer's `verify` round trip and encrypting the token, until the relay POST is sent |
| `emailRelay` | vault | email login only, instead of `google`: what is left of hello → token, the relay's network legs (the page's POST upstream, the vault's read downstream) and any gap between the measured parts |
| `google` | vault | Google login only: what is left of hello → token: the user at Google and Google's pages, **plus the relay's network legs** no single clock sees (the callback's CORS preflight and POST upstream, the vault's read response downstream, ≈ 1.5 API round trips) |
| `callbackRedirect` | `/login/callback` | Google's redirect hops before the callback page was fetched (its navigation `fetchStart`) |
| `callbackFetch` | `/login/callback` | DNS, TLS, the auth page Worker and the HTML (`fetchStart` → `responseEnd`) |
| `callbackBoot` | `/login/callback` | parsing and loading the callback script (`responseEnd` → script start) |
| `callbackPrep` | `/login/callback` | taking the relay key and encrypting, until the relay POST is sent |
| `relayHeld` | API (relay object) | how long the token sat in the slot before the vault's read answered (≈ 0 while it long-polls) |
| `verify` | vault | RS256 and claims (and Google's JWKS fetch on a cold vault) |
| `scopeWait` | vault | the wait for the registry scope check (0 when it finished while the user was at Google) |
| `chain` | vault | the BLS key, the counter-1 signature and `POST /v1/login` with any recovery (the ship gate's number) |
| `decrypt` | vault | CKD decryption, pairing check, derivation v1 |
| `finish` | vault | switching to the new session, revoking the replaced share (not awaited), starting the share and record (not awaited), the events |
| `port` | partner page | the `hana_login` round trip minus the vault's own time (postMessage both ways, queueing) |

Login breakdown: `appRtt` / `appServer` (inside `app`: the `GET /v1/app` request it waited for, on the vault's clock,
which may have started before the login / the API's own total) with `appServerGate` (D1 app + IP limiter),
`appServerSettings` (the settings and login-methods rows) and `appServerChain` (`get_scope`, and `get_config` for a
shared client, read side by side with the settings; D261), `scopeCheck` (the registry view itself, overlapped), `chainPrep` (BLS key + signature, inside
`chain`), `loginRtt` / `loginServer` (`POST /v1/login` on the vault's clock / the API's own total, so `loginRtt −
loginServer` is network, CORS preflight and Worker routing) with `loginServerGate` (D1 app + limiter objects),
`loginServerChecks` (token, chain reads, signature), `loginServerRelay` (relayer key object round trip),
`loginServerBroadcast` (until broadcast), `loginServerWait` (broadcast → outcome: the chain and the MPC); `vault`
(the vault's own total). Since D79 the vault replies before it makes the share and record (`POST /v1/vault/shares`
and IndexedDB, in the background), so the login's timings have no `persist` stage and no `shareRtt` / `shareServer*`
details; share creation's server phases are in the API's request log. Runs logged before that keep their `persist`
and `share*` values (shown with the stages).

Unlock stages, in order:

| Stage | Clock | What it covers |
|---|---|---|
| `mount` | partner page | `createHana` until the (first) iframe is in the document |
| `retry` | partner page | only when the first frame loaded but didn't answer in time: the first iframe → the second one (D262) |
| `frameStart` | partner page | the iframe's load as the page sees it, minus the four `vault*` stages: its navigation start |
| `vaultFetch` | vault document | navigation start → the vault page's last byte (DNS, TLS, the page Worker, the API Worker's D1 reads, the HTML) |
| `vaultScript` | vault document | parsing and loading `/vault.js` until it runs |
| `vaultConfig` | vault document | reading the inlined config and constructing the vault |
| `vaultLoad` | vault document | the rest of the document load (when the partner sends its hello) |
| `store` | vault | opening IndexedDB |
| `record` | vault | reading the record, its lock, and the checks |
| `unlock` | vault | signing and `POST /v1/vault/unlock` |
| `counter` | vault | writing the new counter to IndexedDB |
| `unwrap` | vault | K_s → PRK (AES-GCM) |
| `addresses` | vault | deriving and checking the addresses and the consent, then `ready` |
| `port` | partner page | hello → `ready` minus the vault's own time |

A load with no record (logged out) ends at `record`. Unlock breakdown: `unlockRtt` / `unlockServer` with
`unlockServerGate` (the app row, from D1 or the API isolate's 30 s cache, and the limits: per IP and per share on
local Rate Limiting bindings, per app on its limiter object, the one round trip left; D78, D95), `unlockServerShare` (the KEK, the share and settings rows; before
D78 it also held the share limiter) and `unlockServerAdvance` (the counter update); `vault` (hello → `ready`).

Results JSON version 3 adds `other` and these stages. Older runs keep what they had: login `app`, `popup`, `google`
(which then included the callback and the relay), `verify`, `scopeCheck`, `scopeWait`, `chain`, `decrypt`, and no
unlock stages; the table shows them as they are.

### Ship gate

The *Ship gate* panel compares the median of the latest 10 vault logins' **chain** stage (`create_session_and_derive`
round trip) with the median of the latest 10 direct-page sessions' create_session + derive_key round trips (counter 1).
If the combined call saves less than 1.5 s, it is removed before the audit (session keys go to allowlist state 3;
otherwise state 2). Both sides must have run against the same API: the vault always calls the manifest's `apiUrl`,
so direct-page runs against a `VITE_HANA_API_URL` override (a local `wrangler dev`), and runs logged before runs
recorded their API, are left out, and the verdict says how many. Measure the split side with no override. The panel
only computes; recording the result in `docs/context.md` and rotating the keys are the user's steps.

### Auto-approve demo

`policies/demo-auto-approve.json` is a testnet policy that covers exactly two harmless requests: a native-XLM SAC
`transfer` of 1 stroop to yourself on Stellar testnet, and a Sepolia USDC `approve(you, 1)` (address rule
`self-or-listed`, 20 a day, consent for 1 h). Set it on the app (it takes effect after the env's `changeDelayMs`).
A relative policy path is resolved against the directory you ran `pnpm` from (pnpm's `INIT_CWD`), not `scripts/`,
so from the repo root:

```sh
pnpm --filter @hana-id/scripts admin <env> app:settings <app id | pk> --auto-approve apps/smoke/policies/demo-auto-approve.json --remote
pnpm --filter @hana-id/scripts admin <env> app:settings <app id | pk> --auto-approve off --remote   # immediate
```

Reload the page after the delay: *App policy in force* shows `= the demo policy` with its policyId. Then *Accept the
policy* (or the first covered request) opens the consent screen, after which the "covered" buttons sign with no popup;
the "stranger" / "burn address" ones break the address rule and get the popup, which says why; `personal_sign` always
gets the popup; raw signing is always 4100 here: this page's apps are `pk_test_` apps, which never sign raw, even with
`--raw-sign approval` (`raw_not_allowed_for_test_apps`, `docs/decisions.md` D39).

## Using the direct page

1. **App**: paste the publishable key → *Load app*. The page calls `GET /v1/app` (scope, Google client, mode), checks
   that the API's signer is the manifest's, and reads `get_scope` / `get_config().shared_clients` over RPC to offer
   every Google client the scope can use: its own clients, and Hana's shared clients when the scope has
   `allow_shared`.
2. **Session**: choose `key_index` (default 0; 0 to 2^31 − 1, higher values are reserved and refused) and `max_uses`
   (default 5, 1 to 500) → *Start session*. The page makes a
   non-extractable Ed25519 session key, a random 32-byte salt and an expiry of now + 1 h, computes the batch A.2 session
   nonce and shows *Sign in with Google (openid only)* for the chosen client.
3. Click it: Google's account chooser opens in a popup (`response_type=id_token`, `scope=openid`,
   `prompt=select_account`, the session nonce, a random `state`) and returns through `/direct-callback.html` (to the
   page by `postMessage`, or a same-origin `BroadcastChannel` when Google's pages severed the opener; nothing is
   stored). The page takes only the fragment with its own `state`, checks the token's `nonce` and `aud` and that every
   claim is in the allow-list (otherwise it logs the claim and sends nothing), calls `POST /v1/sessions`, then immediately derives
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

Every relayed call costs testnet gas. A replayed derive doesn't: the API refuses a counter the session has already
used with `409 counter_used` before relaying anything (no transaction, no gas); the contract would refuse it too.

## Google openid-only spike (`spike.html`)

`http://localhost:5173/spike.html` answers batch B's go/no-go questions with no API and no chain: it runs Google's
implicit flow with `scope=openid` only (`response_type=id_token`, `prompt=select_account`, optionally `max_age=0`) in
a popup that redirects to `http://localhost:5173/spike-callback.html`, then decodes the token in the page. It shows the
claims only in the page and builds a summary with no personal values (claim names, whether `hd` or `auth_time` is
present, whether the nonce matched, and whether the popup kept `window.opener`) to paste into `docs/context.md`.
The client must list that callback URL as an Authorized redirect URI; remove it after the spike. The 2026-10-28
results are in `docs/context.md` ("Google openid-only spike").

The summary also has `audProject` (the Cloud project number the client ID starts with) and `subFingerprint` (the first
6 bytes of `sha256(sub)`, never `sub` itself). Signing in with the same Google account through clients in two
different projects and getting the same `subFingerprint` shows that a partner can move from Hana's shared client to a
Hana-held branded client without any address change (the path is `scope#provider#sub#key_index`, with no client ID).

## Google email scope spike (`spike-email.html`)

`http://localhost:5173/spike-email.html` is email login's batch 0 spike (`docs/email-login-build-plan.md`; **passed
on 2026-11-04**, every leg for a Gmail, a Workspace and an outside-address account: `docs/context.md` "Google email
scope spike"): it checks, on real Google, how the login popup can get an access token for the `email` scope while the
ID token that goes on chain stays openid-only (D25). Leg E is the flow decided in D270, `'token_first'`, which the
popup runs since that run (`GOOGLE_EMAIL_FLOW = 'token_first'` in `packages/web/src/auth/google.ts`;
`'second_request'` is the fallback). Re-run it after any change to the Google requests and for a new Google project.
Same callback and redirect-URI rule as `spike.html`; no Hana API, no chain.

### Running it

1. **A Google client.** Use a *Web application* OAuth client whose consent screen is the one users will see: the env's
   shared login client (`sharedGoogleClientIds` in `envs/sandbox-dev.json`) for the real screen, or any test client in
   a Google Cloud project you control. In Google Cloud > APIs & Services > Credentials, add
   `http://localhost:5173/spike-callback.html` (exact: `http`, `localhost`, port 5173) under *Authorized redirect
   URIs*; changes can take a few minutes. That redirect URI is the only client setting the page needs: its origin is
   `http://localhost:5173` (open it as `localhost`, not `127.0.0.1`, or the callback can't hand back), and it doesn't
   need to be an *Authorized JavaScript origin* (the 2026-10-28 `spike.html` run worked without; if Google shows
   `origin_mismatch`, add `http://localhost:5173` there too). Remove the redirect URI after the spike.
2. **Serve the page**: `pnpm install`, then `pnpm --filter @hana-id/smoke dev` (Vite on `http://localhost:5173`, port
   fixed). It reads the env manifest at start (default `sandbox-dev`) but this page calls no Hana API.
3. **Open** `http://localhost:5173/spike-email.html?client=<client id>` (or paste the ID into the field). Allow
   popups for `localhost`.
4. **For each of three accounts**: a personal Gmail account (`@gmail.com`); a Google Workspace account on its own
   domain (Google returns `hd` for it); and a Google account registered with a non-Google address (a consumer Google
   account created with, for example, an Outlook or company address, no Workspace). Run **B, C, D, then E and E2**
   (A too if you want its answer; it doesn't gate anything). Between accounts, remove the client's access at
   <https://myaccount.google.com/connections> only if you want to see the first-time consent screen again; the gate
   is about what Google does with the grant in place, so don't remove it between the legs of one account.
5. **Write down** what each consent screen listed, copy the *Summary to paste back* block (booleans, claim names,
   error codes and scope names only: never an address, a `sub` or a token), and record both in `docs/context.md`.

### The legs

- **A** asks once: `response_type=id_token token`, `scope=openid email`. The summary's `oneRequestUsable` is true only
  when the ID token carried no personal claim (`emailInIdToken: false`) and an access token came with it.
- **B** is the fallback: `scope=openid` first, then `response_type=token`, `scope=email`, `prompt=none`,
  `login_hint=<sub>`; when Google answers that silent request with `consent_required` (or another "needs the user"
  error) it asks once more without `prompt=none`, as the popup does.

- **C** (after B, its button unlocks): a plain `scope=openid` login of the same account now that B granted `email`.
  The summary records the ID token's claim names and `tokenHasPiiLockout`: true if `email` or `email_verified`
  appear, which would make every later Google login of that user fail with `token_has_pii` (the vault and the API
  refuse such a token). That must be false.
- **D** (after B): B's silent request again (`prompt=none`, the same `login_hint`), with no interactive retry. With
  the grant no longer revoked (D265) it must answer an access token silently (`silentAccessToken: true`, no
  `silentError`); a `silentError` means Google asks for consent at every login.
- **E** is D270's `'token_first'`, exactly as production will run it. Step 1: `response_type=token`,
  `scope=openid email`, `prompt=select_account` (no ID token in this answer: `idTokenInAccessAnswer: false`). Step 2:
  the account's `sub` from that access token, by `POST https://oauth2.googleapis.com/tokeninfo` with the form body
  `access_token=…` (as `apps/email-issuer/src/google.ts` `checkAccessToken`; the token never goes in a URL). The
  summary records `tokeninfoReachable` (false when the browser's fetch threw: a CORS refusal from the page, or no
  network; the console says which), `tokeninfoStatus`, `tokeninfoHasSub`, `tokeninfoAudIsClient` and
  `tokeninfoScopes`. (Checked from the command line on 2026-11-04 with a dummy token: tokeninfo answers
  `access-control-allow-origin` with the request's `Origin`, any origin, and its preflight allows `POST` with
  `content-type`; E confirms it in a real browser with a real token.) Without a `sub` no silent request is sent (`silentRequest: 'not sent: no sub'`). Step 3: a
  silent `response_type=id_token`, `scope=openid`, `prompt=none`, `login_hint=<that sub>` request with a fresh nonce;
  the summary has `silentIdToken` or Google's `silentError` (no interactive retry), the ID token's
  `idTokenClaimNames` and `idTokenPersonalClaims`, `emailInIdToken`, `nonceMatches` and `sameAccount` (the ID token's
  `sub` equals tokeninfo's), plus step 1's `userinfo` checks (what google-match would read). The verdict
  `tokenFirstUsable` is true only when the silent request answered an ID token with no personal claim, for the same
  account, with the nonce sent.
- **E2** (after E, its button unlocks): E's silent `id_token`/`openid` request alone, again, for E's account, with a
  fresh nonce: a returning user's login now that the email grant exists. Its verdict `returningTokenClean` has the
  same four conditions; it shows a returning user's on-chain token stays clean.

A, B, D and E then call Google's `tokeninfo` by POST (aud and sub match; the token never goes in a URL) and `userinfo`
(an address, `email_verified`, `hd` present and equal to the address's domain, a Gmail address), from the page, and
never revoke the token (as production, D265). Each leg has its own single-use `state`, and a fragment with more than
one `state` is ignored, as production's callback. The summary holds booleans and claim names only (never the
address, `sub` or a token). A's `'one_request'` stays rejected (D270: Google puts `email` in that ID token), and the
popup no longer has that flow (D273); A is kept to record that. `GOOGLE_EMAIL_FLOW` is `'token_first'` (D270:
`packages/web/src/auth/google.ts`, the same three steps as E, with one interactive openid-only retry of step 3, D273)
since the gates below were met: a reviewed one-line change; deploying it is `docs/operations.md` "Turning linking on
(batch 8b)".

**Gate (D265), met 2026-11-04:** legs C and D on real Google, by the user, before batch 8b reaches real users: C must
show no lockout and D must succeed silently (`docs/email-login-build-plan.md` batch 8b, `docs/operations.md` "Turning
linking on (batch 8b)"). All three accounts: `tokenHasPiiLockout: false`; D silent, no prompt.

**Gate (D270), met 2026-11-04:** legs **C and E must pass**, for all three accounts, before `GOOGLE_EMAIL_FLOW`
becomes `'token_first'`: C with `tokenHasPiiLockout: false`, E with `tokenFirstUsable: true` (and E2 with
`returningTokenClean: true`). All three passed (E: `tokeninfoReachable: true`, status 200, `emailInIdToken: false`,
`idTokenPersonalClaims: []`, `nonceMatches`, `sameAccount`), and the switch was made. Should a later run show
`tokeninfoReachable: false`, the popup can't take the `sub` from tokeninfo in the browser: switch back to
`'second_request'` (`docs/operations.md`) until `'token_first'` has another source for `login_hint`. The vault and the
API keep refusing any ID token with a claim outside the allow-list (`token_has_pii`) either way.

## Test checklist

### Vault page

- [ ] **Login through the vault**: one click on *Log in with Hana* → Google's account chooser → addresses. The run
      has every login stage of [Timings](#timings) with a small `other`, and the log shows no `/v1/sessions` or
      `/v1/derive` call from this page (DevTools → Network, this page and the vault frame: one `POST /v1/login`).
- [ ] **openid-only token**: the login succeeds (the vault and the API always apply the claim allow-list; a refused
      claim shows as `token_has_pii` with the claim).
- [ ] **Vault agrees with the in-page derivation**: same Google account and scope, a direct-page run at `key_index` 0
      and a vault login: the vault run notes "same addresses as the in-page derivation".
- [ ] **Isolation, app A vs B**: same account label, apps in different scopes: "same account, other scope … addresses
      differ"; another Google account with another label: "other account … addresses differ".
- [ ] **Own vs shared client**: one scope, a login while it uses the shared client and one after it has its own client
      (or the reverse), same account label: "same account and scope, shared → own client: same addresses". Use an own
      client in a **separate Google Cloud project** from the shared one, or this doesn't prove the A.2 promise (the spike
      already matched `sub` across two projects, `docs/decisions.md` D42; this checks it end to end).
- [ ] **Persistence 'session' (default), reload**: *Reload the page* → an unlock run "OK — unlock restored #n's
      addresses" in well under a second (note the total and its stages), and DevTools shows no `/v1/derive`, no
      `/v1/login` and no NEAR RPC call, only `POST /v1/vault/unlock`.
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
      sign-in, the key shown on *Show key* next to the address that matches this page's (never on this page); *Copy
      key* says "Copied" and pastes the same key (D268; in Chromium the clipboard is blank again 60 s later while the
      export window stays in front).
- [ ] **Approval**: with no auto-approve policy, each request button opens the Hana approval popup; Approve gives
      "signed after approval", Reject or closing it gives "rejected (4001)".
- [ ] **Auto-approve**: with the demo policy in force: *Accept the policy* → consent; the two "covered" requests give
      "signed, auto-approved (no popup)" (without *Accept the policy* first, the first covered request gives "signed
      under the policy, after the consent screen"); the "stranger" and "burn address" ones open the popup with the reason;
      `personal_sign` always opens it; *Stop auto-approving* → the covered ones need the popup again; `--auto-approve
      off` stops it at once (reload).
- [ ] **Raw signing refused for test apps**: *Raw sign* is "refused: 4100" (`raw_not_allowed_for_test_apps`) with no
      popup, also after `--raw-sign approval` has taken effect (D39). The raw approval popup needs a `pk_live_` app,
      which this page can't use (loopback origin).
- [ ] **Safari/WebKit storage retention**: in Safari, log in, then reload after 10 min, 1 h and a day idle, and after
      quitting and reopening Safari: each reload gives an unlock run, or a logged-out load (no unlock run) if Safari
      dropped the vault's partitioned IndexedDB. Record which in `docs/context.md`.
- [ ] **Ship gate**: 10 vault logins and 10 direct-page sessions, with no `VITE_HANA_API_URL` override: the panel's
      verdict. Record it, the gas of a few
      `create_session_and_derive` transactions (nearblocks) and the unlock total in `docs/context.md`.
- [ ] **BLS precheck CPU time** (D64, before `BLS_PRECHECK` is turned on in any env): on a scratch deploy only, on the
      Workers Paid plan, set the var `BLS_PRECHECK = "1"`, do a few vault logins and read the `/v1/login` CPU time
      per request from the Workers dashboard (the Worker's metrics or its logs). Record it in `docs/context.md` next to the
      ship gate and the unlock total, then delete the scratch deploy.

### Direct page

- [ ] **openid-only sign-in**: DevTools → Network shows the popup's `accounts.google.com/o/oauth2/v2/auth` request with
      `scope=openid` and `response_type=id_token` (no `gsi/client` script anywhere), and `POST /v1/sessions` succeeds.
      A token with any other claim would be logged as "… outside the allow-list (openid only): not sent".

- [ ] **Real MPC**: a derive succeeds and the pairing check passes against the pinned `ckdNetworkKey` (a wrong pinned
      key fails with "CKD response failed the pairing check").
- [ ] **Isolation, app A vs B**: same Google account, apps in different scopes (`key_index` 0 both): paths differ only
      in the scope, addresses and `app_id` differ (log check "same user, other scope … addresses differ").
- [ ] **Key index**: same app and account, `key_index` 0 then 1: different paths and addresses. Back to 0 in a new
      session: same addresses as the first run.
- [ ] **Own vs shared client, same path**: on a scope with its own client and `allow_shared`, one session through the
      own client and one through the shared client (same account, same `key_index`): the same path and the same
      addresses (log check "own vs shared client … same addresses"). If the paths differ only in the `sub`, Google
      gives a different `sub` per client: raise it (the spike found the same `sub` across clients and projects, D42).
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
