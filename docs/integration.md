# Integrating Hana ID (partner guide)

Hana ID gives your users a Stellar and an EVM wallet from a Google login, with no extension or seed phrase. You add
the SDK to your web app, users click your "Sign in" button, and you sign through standard interfaces: an EIP-1193
provider, a Stellar signer and a Stellar Wallets Kit module, with an optional Sodax adapter. Keys and Google tokens
never reach your page. They live in a hidden Hana iframe, and every signature needs the user's Approve in a Hana
popup, unless it falls under an auto-approve policy you set and the user accepted.

> **Testnet pilot.** Keys come from the NEAR **testnet** MPC and stay disposable until the address freeze (final
> accounts, audit, mainnet). Don't keep real funds in pilot wallets, on any chain. A test app (`pk_test_…`) can't sign
> for mainnet chains at all ([section 12](#12-test-and-live-keys)). This guide follows the code; the original
> specification is `docs/batch-b-spec.md`.

Last verified against code: 2026-11-04 (branch `fix/google-cancel-back-to-chooser`: a cancel on Google's sign-in screen goes back to the chooser, closing there is `login_cancelled`, in "Sign-in methods and links" and the error table; D341); 2026-11-04 (branch `feat/token-first-on`: "Sign-in methods and links": Google's one
sign-in screen lists the email, cancelling it, the two-accounts screen; D270); 2026-11-03 (branch `feat/email-login-8b` review fixes: the email permission's screens and
reasons, `api_unavailable`'s `path_unconfirmed` / `path_disputed`, `storage_unavailable` in a login, `hana.account()`'s
5 s cache, D263–D265); 2026-11-03 (branch `feat/email-login-8b`: one wallet per person, "Sign-in methods and
links" in section 4 (`hana.account()`, `linkChanged`, `hana.linkAccount()`, what users see in each case), key export
for email wallets, `link_refused`, `link_pending`'s `effectiveAtMs`, the `linking` progress stage); 2026-11-03 (branch
`fix/demo-polish`: the vault load's one retry and `vault_unavailable`'s `data.reason` in section 3 and 13, the login
timings' stages in section 12); 2026-11-02 (branch `feat/email-login-8a`: email login, "Email login" in section 4, the
new error codes and the `email_code` progress stage).

## How it works

```
your page ──iframe──▶ vaultOrigin/vault      holds the key (in memory; on disk only under a server-held share)
    │                      ▲  MessageChannel
    └─ window.open ─▶ authOrigin/login ─▶ Google ─▶ authOrigin/login/callback ─(encrypted relay)─▶ vault
                      authOrigin/approve     approval popup: the user reviews and approves every request
                      authOrigin/export      key export window
```

1. `createHana()` inserts a hidden iframe from Hana's `vaultOrigin`. It answers only your allowed origins.
2. `hana.login()`, called in your click handler, opens Hana's sign-in popup. The user picks a Google account
   (Google asks only for `openid`: no email, name or picture is requested or stored). The vault gets the token over
   an end-to-end encrypted relay, sends one NEAR transaction and decrypts the user's key.
3. A reload or a new tab within the session's limits restores the wallet with one API call and no transaction.
4. A signing call made in your click handler opens the Hana approval popup in that click, as `login()` does. It shows
   the decoded request and the user approves it there. If the browser doesn't allow the popup (no click, or Safari
   after an `await`), the vault shows a small "Review in Hana" button instead, which opens the same popup.
5. `hana.getIdentityToken()` gives your backend a short-lived signed token saying who the user is in your app, which
   wallets they hold and which session this is, verified against Hana's published keys
   ([section 15](#15-identity-token-your-backend)).

The address depends on your app's **scope** and the user's Google account, never on the browser. The same user
gets the same addresses on every device, and different addresses in another partner's app.

## 1. Get an app

Hana registers apps during the pilot (the self-serve dashboard comes with batch C). Send Hana:

- the app name your users will see ("Signing in to {name} at {origin}");
- every origin your app runs on, as exact origins (`https://app.example.com`, no path). At most 20. Add
  `http://localhost:<port>` (or `http://localhost:*`) for local development; loopback works only for test keys in
  `local*`/`sandbox*` envs;
- whether you use Hana's shared Google client or your own ([section 6](#6-google-client-shared-or-your-own));
- any [settings](#7-app-settings) other than the defaults.

You get a **publishable key** (`pk_test_…` for a test app, `pk_live_…` for a live one; a scope is test or live for
good, so test and live apps never share addresses). It is public: ship it in your page. Your origins are what protect
it. A new origin takes effect after the same delay as a policy (24 h in production; 60 s on sandbox-dev) once Hana
has announced it (on a new app, before anyone has logged in to it, at once); removing one takes effect at once.

## 2. Install

The packages are not on a registry yet (`@hana-id/*` is the reserved scope). Hana sends you the tarballs of one
release, built with `pnpm pack` (`docs/operations.md` "Releasing the SDK packages"), and you install them together
with npm, pnpm or yarn:

```sh
npm install ./hana-id-core-0.1.0.tgz ./hana-id-web-0.1.0.tgz              # always
npm install ./hana-id-react-0.1.0.tgz                                      # React apps
npm install ./hana-id-sodax-0.1.0.tgz @sodax/types@2.1.0                   # Sodax adapters
```

Commit the tarballs to your repository (or a private artifact store) and depend on them by path
(`"@hana-id/web": "file:vendor/hana-id-web-0.1.0.tgz"`), so every install gets the same bytes.

| Package | What | Peer dependencies (tested) |
|---|---|---|
| `@hana-id/core` | Shared core; a dependency of the others. `@hana-id/core/policy` validates auto-approve policies | |
| `@hana-id/web` | `createHana`, the EIP-1193 provider, the Stellar signer; `@hana-id/web/stellar-wallets-kit` for SWK | |
| `@hana-id/react` | `HanaProvider`, `useHana`, `useWallet` | `react` `^18 \|\| ^19` (18.3.1, 19.3.1) |
| `@hana-id/sodax` | Optional Sodax wallet-provider adapters | `@sodax/types` `^2.1.0` (2.1.0, types only) |

They are ESM with TypeScript declarations and source maps. Use a bundler (Vite, webpack, esbuild, Next.js) or
TypeScript `moduleResolution` `bundler`, `node16` or `nodenext`. The `@hana-id/core/signers/stellar` and
`/decode` declarations reference Node's `Buffer` through `@stellar/stellar-base`: if you import those, add
`@types/node` or keep `skipLibCheck`. Each package carries a README with these steps. Each release is checked by
installing the tarballs into a fresh project outside Hana's repository, type-checking and importing them there.

**Environments are built in.** `@hana-id/web` contains the configuration of every Hana deployment it was released
for (Hana origins, NEAR accounts, RPC, pinned MPC key; all public values), and you pick one by name with
`createHana({ environment })`. `HANA_ENVIRONMENTS` lists the names. A release ships exactly the deployed envs; this
pilot ships `sandbox-dev` (NEAR testnet). A new environment means a new release.

### Testnet quick start (Sodax)

1. Ask Hana for a **test app** on `sandbox-dev`, with the **shared Google client** (nothing to set up in Google
   Cloud), your app's name, and its **allowed origins**: each exact origin your app runs on (`https://app.example.com`,
   staging, previews) plus `http://localhost:<port>` for development. You get a publishable key `pk_test_…`.
2. Install the tarballs above (web, core, react if you use React, sodax and `@sodax/types@2.1.0`).
3. Allow `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` in your CSP `frame-src`, and your RPCs in
   `connect-src` ([section 5](#5-your-page-origins-csp-popups)).
4. Create the client with `environment: 'sandbox-dev'` and **test networks only**: a test app's vault refuses
   anything a mainnet would accept (D39, [section 12](#12-test-and-live-keys)), so use the Stellar testnet and EVM
   testnets such as Base Sepolia (84532) or Sonic testnet (14601):

   ```ts
   const hana = createHana({
     publishableKey: 'pk_test_…',
     environment: 'sandbox-dev',
     evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
     stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
   });
   const stellarProvider = createSodaxStellarProvider(hana, {
     networkPassphrase: 'Test SDF Network ; September 2015',
     horizonUrl: 'https://horizon-testnet.stellar.org',
     sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
   });
   const evmProvider = createSodaxEvmProvider(hana, { chainId: 84532, rpcUrl: 'https://sepolia.base.org' });
   ```

5. Call `hana.login()` from a click and sign. Sodax's own mainnet swaps through Hana wait for live keys
   ([section 11](#11-sodax-adapter)).

## 3. Create the client

```ts
import { createHana } from '@hana-id/web';

const hana = createHana({
  publishableKey: 'pk_test_…',
  environment: 'sandbox-dev',
  // optional: only if you use EVM chains
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
  // optional: only if you use Stellar
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
  // optional: where the vault iframe goes (default document.body)
  container: document.body,
});

await hana.ready; // the vault is up and the status is known (a reload has already been restored)
hana.status;      // 'logged_out' | 'unlocking' | 'logging_in' | 'logged_in' | 'error'
hana.addresses;   // { stellar: 'G…', evm: '0x…' } or null
```

Create one client per page and keep it. `hana.destroy()` removes the iframe and its listeners (for example on an SPA
unmount).

RPC, Horizon and Soroban RPC URLs (`evm.chains[].rpcUrl`, `stellar.horizonUrl`, `stellar.sorobanRpcUrl`, and the
Sodax adapters' `rpcUrl`, `horizonUrl`, `sorobanRpcUrl`) must be `https://` for a `pk_live_` key; plaintext `http://`
is accepted only on `localhost` and other loopback hosts (a local node), and for `pk_test_` keys anywhere. URLs with
credentials (`https://user:key@…`) are refused for every key (D115). `hana.testApp` says which rule applies.

`environment` names the Hana deployment. The client takes the Hana origins from its own build, so no configuration
can point it at another vault. `sandbox-dev` (testnet) uses:

| | Origin |
|---|---|
| `vaultOrigin` | `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` |
| `authOrigin` | `https://hana-id-auth-sandbox-dev.tingtc.workers.dev` |

Events:

```ts
hana.on('statusChanged', (status) => {});
hana.on('accountsChanged', (addresses) => {}); // { stellar, evm } or null
hana.on('sessionExpired', () => {});            // the session reached its limit: log in again
hana.on('disconnect', ({ code }) => {});        // 4900: the vault connection is gone
hana.on('loginProgress', ({ stage }) => {});    // 'popup_connected' | 'google' | 'email_code' | 'token' | 'linking' | 'chain' | 'key_pending' | 'done'
hana.on('launcher', ({ visible, label }) => {}); // Hana's button is shown or hidden ("Review in Hana", …)
hana.on('autoApproved', ({ kind, chain, contract, function: fn }) => {});
hana.on('persistenceChanged', (persistence) => {}); // 'none': this login won't survive a reload (see "Sessions")
hana.on('linkChanged', ({ provider, status, effectiveAtMs }) => {}); // a sign-in method added, activated or removed (section 4)
```

`loginProgress: key_pending` means Google has just started signing with a new key that Hana ID hasn't activated yet
(it goes live within minutes): the vault waits up to 30 s and tries once more, then reports `chain` again. Show
something like "Google just rotated its signing key; finishing in a few seconds". If the retry is refused too, the
login rejects with `api_unavailable`; ask the user to sign in again in a few minutes.

`hana.ready` rejects with `vault_unavailable` when the vault doesn't load. The SDK gives the vault frame 5 s to answer
(the vault says `connected` as soon as it has checked your page). A frame still loading at 5 s gets 5 s more; a frame
that loaded but didn't answer is replaced once. A vault that answered then has 20 s to finish starting (restoring a
session waits on one Hana API call). On any failure the SDK removes the frame. `error.data.reason` says which part
failed (D262):

| `data.reason` | What happened | Usually |
|---|---|---|
| `csp_frame_src` | your page's CSP blocked the frame (detected at once, no retry) | `frame-src` ([section 5](#5-your-page-origins-csp-popups)) |
| `no_answer` | the frame loaded but the vault never answered, in either of two frames | your page's origin (or a page framing it) isn't one of your app's origins, or the key is unknown or suspended: the vault page refuses to be framed and says nothing, by design |
| `frame_timeout` | the frame didn't load within 10 s | the network, or Hana's page Workers slow to answer |
| `ready_timeout` | the vault answered but didn't finish starting within 20 s | the Hana API slow or unreachable |
| `frame_replaced` | something navigated the vault frame before it was ready | another script on your page |

`data.attempts` is how many frames were tried. `hana.readyTimings` (test apps) has a `retry` stage when the second
frame was used. **A misconfiguration is slower to show than it used to be:** a page whose origin isn't one of your
app's origins, or an unknown or suspended key, now fails with `no_answer` after about 10 s (two frames of 5 s), not 5 s.
While you set up a page, check `data.reason` rather than waiting for it.

## 4. Log in, log out

```ts
button.addEventListener('click', async () => {
  try {
    const { stellar, evm } = await hana.login(); // call it directly in the click handler, before any await
  } catch (e) {
    // e is a HanaError: e.code is a number (4001, …) or a string ('login_cancelled', 'google_error', …)
  }
});
```

- **Call `login()` synchronously in a user click.** It opens the popup before anything else, while the browser
  still allows popups. If the browser blocks it anyway, the vault shows a "Sign in with Hana" button (bottom right)
  and the call resolves once the user clicks it and signs in. That costs the user one more click.
- Already logged in: `login()` resolves at once. A second `login()` while one is pending replaces it (the first
  rejects with `login_cancelled`). `hana.cancelLogin()` ends a pending one.
- A first login takes several seconds after the Google account choice (one NEAR transaction plus the MPC; estimated
  6.5–7 s, to be measured on testnet). Show progress with `loginProgress`. A reload needs one API call (estimated
  0.1–0.3 s).
- **Sessions.** With the default `'session'` persistence the wallet survives reloads and new tabs for up to 12 h,
  or until it has been idle for 2 h. Then `sessionExpired` fires and the user signs in again. An open tab that sends
  the vault no request that uses the key (a signature, an export, revoking other devices, an auto-approve consent
  request) for the idle limit drops its key from memory; polling status or addresses doesn't count. Your page sees
  nothing (status, addresses and auto-approve status keep answering), and the next request that uses the key restores
  it with one API call, as a reload does, while the session is still alive on Hana's side. With `'none'`, every page
  load is a new login. If the browser blocks storage (some private modes), the vault falls back to `'none'` and
  `hana.warning` is `storage_unavailable`. `login()` resolves as soon as the wallet is ready; the vault then saves
  the session for reloads in the background (one API call). If that fails, the wallet keeps working in this tab,
  `hana.persistence` becomes `'none'` (with a `persistenceChanged` event; `useHana()` re-renders), and the next page
  load needs a new login; a reload within that moment after `login()` resolved is a new login too.
- **Email login** (build plan batch 8a; off until Hana turns it on for your app, `login_methods`). With email on,
  `hana.login()` shows a chooser in the Hana popup: "Continue with Google" or "Continue with email". The email path
  asks for the address, mails a 6-digit code, and the user types it into the same Hana popup (never into your page).
  To skip the chooser, pass the method; to prefill the address you already know, pass `emailHint`:

  ```ts
  await hana.login({ method: 'email', emailHint: 'ada@example.com' }); // or { method: 'google' }; still in the click
  ```

  One person, one wallet: Google and email with the same verified address open the **same** wallet (automatic
  linking, build plan batch 8b; [Sign-in methods](#sign-in-methods-and-links) below). A method your app doesn't
  offer rejects with `login_method_unavailable`; bad options reject with `-32602` before any popup opens.
  `loginProgress` adds `email_code` (the code was sent) and `linking` (this login joins two sign-in methods); with
  email on, `google` fires only when the user goes to Google. The popup handles wrong and expired codes, "Resend code"
  and "Use a different email" itself; if the user then cancels, `login()` rejects with `code_invalid`,
  `challenge_expired`, `rate_limited` or `login_cancelled`. Your page never sees the address unless you passed it.
- <a id="sign-in-methods-and-links"></a>**Sign-in methods and links** (an app with email). What the user sees, by
  case (Hana decides every case; your page only sees the result):

  | The user… | They see | Result |
  |---|---|---|
  | signs in with Google, and an email wallet exists for that Gmail address (or a Workspace address Google hosts) | nothing extra; the popup may show "Your Google sign-in now opens this wallet too" | the email wallet's addresses; Google is linked at once |
  | signs in with Google, and an email wallet exists for an address Google doesn't host | "This email already has a wallet": **Link and continue** (a code to `a…@domain`) or **Sign in with email** | the email wallet either way; linked only after the code |
  | signs in with email, and a Google wallet exists for that address | "This email belongs to a wallet you created by signing in with Google": **Link and continue** or **Sign in with Google**, then Google | the Google wallet's addresses; the email joins it at once (Google-hosted) or after 24 h (other addresses: a pending banner with **Cancel this link**) |
  | has neither wallet | the usual sign-in | a new wallet for that method |
  | signs in with Google for the first time with this Google client | Google's one sign-in screen, which also lists "Email address" (Hana asks for it there, D270); a returning user sees only Google's account chooser | as above |
  | cancels that Google screen | the Hana popup goes back to its chooser: "Google sign-in was cancelled.", with **Continue with Google** and **Continue with email** (or, if the Google step started from "This email belongs to a wallet you created by signing in with Google", that screen's choices again) | `login()` keeps waiting: Google again or email signs in as usual; closing the popup there rejects with `login_cancelled`, never `google_error` (D341) |
  | signs in with Google, has no wallet yet, and Google's answers name two different Google accounts | **Sign in with email instead** or **Try Google again** (Google's "share your email address" for the account they signed in with) | an email wallet, or Google again; Cancel rejects with `login_cancelled` (`data.reason: 'google_account_mismatch'`, or `'email_consent_declined'` after declining that screen) |

  Nobody ever gets a second wallet for the same verified address. While a link is pending, signing in with the
  pending method fails with `link_pending` (`data.effectiveAtMs`: when it opens the wallet). The user can cancel it
  from the Hana popup's banner at their next sign-in.
  - `await hana.account()` → `{methods: [{provider: 'google' | 'email', status: 'active' | 'pending', effectiveAtMs,
    root}]}`: the wallet's own method (`root: true`) and the ones linked to it. No identifiers, no addresses. Calls
    within 5 s of a read share it (the vault reads afresh after a login, a link or a banner's action). **Show
    pending methods to the user** ("An email will be able to open this wallet from …") and tell them to sign in to
    cancel it if it isn't theirs: the mailbox of a pending email may be an attacker's.
  - `hana.on('linkChanged', ({provider, status, effectiveAtMs}) => …)`: a method was added (`pending` or `active`),
    became active, or was `removed`. It fires after a login that linked, at the first `account()` call of a session
    for each pending method, and whenever `account()` sees a change.
  - `await hana.linkAccount({ method: 'google' | 'email' })`, in a click like `login()`: adds a sign-in method with
    another address (a second Google account, a work email). The Hana popup signs in the new method, then the
    wallet's own; the link opens the wallet after 24 h (`{provider, status: 'pending', effectiveAtMs}`). It rejects
    with `link_refused` (`data.reason`: `provider_taken`, `account_full`, `already_linked`, `has_wallet` when that
    method already opened a wallet of its own, `links_unavailable`) before any transaction.
- `await hana.logout()` signs this app out on this device, in every tab. It sends no transaction.
- `await hana.revokeOtherDevices()` signs the user out of your app everywhere else. It works only within 5 min of a
  fresh login, so offer it right after one.
- `await hana.exportKey('stellar' | 'evm')` lets the user take their key elsewhere. Hana shows a button; the key
  appears only in a top-level Hana window, after a fresh sign-in (Google, or, in an app with email, a new code to the
  user's email) and a typed confirmation, and never reaches your page. A wallet with linked methods exports its one
  shared key, whichever method the user signs in with; a pending method exports nothing. That window keeps the key for 5 minutes at most, and erases it as soon as the user's session in your
  app ends (`logout()`, revoke, expiry); exporting again starts over with a new sign-in. Stellar keys export as `S…`, EVM keys as `0x…` hex. There is no recovery phrase. Each export is a NEAR
  transaction Hana pays for, so one account can export at most 3 times an hour per app (`rate_limited` after that).

## 5. Your page: origins, CSP, popups

| Requirement | If not met |
|---|---|
| The page's origin is one of your app's origins, exactly | the vault doesn't load (`vault_unavailable`) |
| CSP `frame-src` (or `child-src`/`default-src`) allows `vaultOrigin` | `vault_unavailable` at once (an enforced violation is detected; report-only is fine) |
| CSP `connect-src` allows your own EVM RPC (and Horizon / Soroban RPC for Sodax) | your RPC calls fail; the SDK calls them from your page |
| Popups allowed for your site | the "Sign in with Hana" button fallback (`popup_blocked` if you cancel) |
| `Cross-Origin-Opener-Policy` is not `same-origin` (`same-origin-allow-popups` and `unsafe-none` are fine) | `coop_blocks_popup` |
| Every page that frames yours is also one of your origins (`frame-ancestors` checks all ancestors) | `vault_unavailable` |
| `login()` and `eth_requestAccounts` run in a click | one extra click (the fallback button) |
| Signing calls run in a click, before any `await` (or after `hana.prepareApproval()`) | one extra click per signature (the "Review in Hana" button) |

Not supported: Google Identity Services (the "Sign in with Google" button or One Tap) on the same page, which the
SDK warns about in the console; in-app browsers (Instagram, TikTok, … webviews), where Google refuses to sign in
(`disallowed_useragent`); pages with COOP `same-origin`. A page with `Cross-Origin-Embedder-Policy: require-corp` is
untested: the vault frame sends no COEP header, so such a page may refuse to embed it.

The vault's button (sign-in fallback, "Review in Hana", export) is a fixed 320×72 px Hana frame at the bottom right
of the viewport. Don't cover it: whenever the popup couldn't open in the click (and for every export), users can't
continue without it. The `launcher` event tells you when it
shows, if you want to point at it.

Removing an origin from your app signs out the users who signed in there.

## 6. Google client: shared or your own

| | Shared (default) | Your own |
|---|---|---|
| Setup on your side | none | a Web OAuth client in **your** Google Cloud project |
| Google's consent screen shows | Hana | your app |
| Who can obtain tokens that open your users' wallets | only Hana's pages, for your origins | also anyone your client trusts (see below) |
| Addresses | the same in both modes, for the same scope and Google account | |

Both modes put users in your app's own scope, so another app never gets your users' keys. The path holds no client
ID, so you can start shared and move to your own client later without changing anyone's address. Google gives one
account the same `sub` across clients, both within one Google Cloud project and across two projects (tested with a
personal and a Workspace account, D42).

**Your own client.** In Google Cloud console → APIs & Services → Credentials, create an OAuth client ID of type "Web
application":

- **Authorized redirect URIs**: exactly `{authOrigin}/login/callback`, and nothing else. For sandbox-dev that is
  `https://hana-id-auth-sandbox-dev.tingtc.workers.dev/login/callback`.
- **Authorized JavaScript origins**: none.
- On the OAuth consent screen, add Hana's domain as an authorized domain.

Send Hana the client ID. Hana registers it as your scope's client; the token's audience then picks your scope.
If your scope also holds iOS or Android clients, which can't run Hana's web flow, Hana pins the web one for you
(`--google-web-client`). A scope with a client of its own always signs in through it.

Hana can't see your Google client's settings. Any JavaScript origin, extra redirect URI or native app on your client
can obtain tokens for it with any nonce, and so derive your users' keys, so an XSS on one of those origins puts your
users' wallets at risk. Keep the client exactly as above, or use the shared client.

## 7. App settings

Hana sets these per app on request (`admin app:settings` now, the dashboard in batch C):

| Setting | Values | Default |
|---|---|---|
| Persistence | `'session'` (the wallet survives reloads under a server-held share) or `'none'` (every page load logs in) | `'session'` |
| Session limit | 1 h to 23 h 50 min | 12 h |
| Idle limit | 15 min to the session limit | 2 h |
| Raw signing | `'off'` or `'approval'` | `'off'` |
| Auto-approve policy | none, or a policy ([section 9](#9-auto-approve-policies)) | none |
| Google web client | your scope's web client, when it has several | the first one |

Loosening takes effect after a delay (24 h in production; 60 s on sandbox-dev), counted from when the change is
announced (by Hana by hand during the pilot; by email to your security contacts once the admin console runs): raw signing `'approval'` (live apps only: a test app never signs raw), and setting
or changing a policy. Tightening takes effect at once for new page loads: raw signing `'off'`, and removing a policy.
In a tab that is already open, a removed policy stops auto-signing within 10 s ([section 9](#9-auto-approve-policies)),
and raw signing `'off'` refuses raw requests within 10 s too (the vault re-reads the setting before each one).

## 8. Signing

Every signing request goes through the user. The Hana popup decodes the request bytes itself, so your page can't
misdescribe them. The popup stays open for 15 s after an answer, so a follow-up request (`restoreFootprint`, a
re-sign, a trustline) appears there without another click. Each one still needs its own Approve. Reject, closing the
popup, or 5 min without an answer gives `4001`.

**Call the SDK directly in your click handler** (D99). Every signing method (`hana.stellar.sign*`, the Stellar
Wallets Kit module, `personal_sign`, `eth_signTypedData_v4`, `eth_signTransaction`, `eth_sendTransaction`,
`hana.signRaw`, `hana.requestAutoApprove`, the Sodax adapters) opens the approval popup synchronously, the moment you
call it, while the browser still treats the click as a user gesture:

```ts
signButton.addEventListener('click', () => {
  // No await before the call: the popup opens in this click.
  hana.ethereum.request({ method: 'eth_sendTransaction', params: [tx] }).then(onSent, onError);
});
```

- **Prepare before the click.** Build the transaction, fetch the quote and simulate when the user enters the amount,
  not in the click handler. `eth_sendTransaction` may fill gas and fees itself; that happens after the popup is open.
- **Safari blocks popups after an `await`.** If the handler must await something first, call `hana.prepareApproval()`
  at its top: it opens the popup now, and the next signing call uses it. If you end up not signing, call the ticket's
  `cancel()` (or leave it: an unused popup closes itself after 8 s).

  ```ts
  button.addEventListener('click', async () => {
    const ticket = hana.prepareApproval();   // first, before any await
    try {
      const quote = await getQuote();
      await hana.stellar.signTransaction(quote.xdr);
    } catch (e) {
      ticket.cancel();                        // closes the popup if nothing used it
      throw e;
    }
  });
  ```
- **Sequential signatures reuse the window.** A second request while the popup is open (an approve then a swap, a
  re-sign) goes to the same window, with its position ("Request 2 of 2"); no new popup opens.
- **Auto-approved requests.** Under a policy the user accepted, the popup opens in the click and closes at once
  without showing anything, then the signature returns.
- **Without a click** (a call from a timer, or after the browser dropped the gesture), nothing opens: the vault shows
  its "Review in Hana" button (bottom right) and the call resolves after the user clicks it and approves. The same
  happens when a popup blocker refuses the window.

The Approve button arms only after the request has been on screen for 1 s and the window has had focus for 1 s, then
a mouse move, a tap, or Tab or an arrow key. The gesture that arms it doesn't approve, so a tap-only user taps twice;
clicking in place without moving the mouse, Enter and Space never arm it. That stops clickjacking and double-click
tricks. Message and raw requests (`personal_sign`, `stellar_signMessage`, `signRaw`) carry a line that the signature
isn't tied to one network: they are valid wherever the key is. For a test app every request and consent screen also
says that Hana signs only for test networks.

### Stellar

```ts
const { address } = await hana.stellar.getAddress();           // logs in if needed (call it from a click)
const { signedTxXdr, signerAddress } = await hana.stellar.signTransaction(xdr, {
  networkPassphrase, // optional: defaults to createHana({ stellar })
  address,           // optional: must be the user's address (4100 otherwise)
});
const { signedAuthEntry } = await hana.stellar.signAuthEntry(preimageXdr); // base64, 64 bytes
const { signedMessage } = await hana.stellar.signMessage('hello');        // SEP-53, approval every time
await hana.stellar.getNetwork();                                          // from createHana({ stellar })
```

You build, simulate and submit transactions yourself. Hana only signs. Fee-bump envelopes are signed as given.

**Stellar Wallets Kit** (1.9.x, which Sodax's `wallet-sdk-react` uses, and 2.x):

```ts
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';

const kit = new StellarWalletsKit({ network, modules: [new HanaIdModule(hana), ...otherModules] });
```

The module's `productId` is `'hana-id'`. `isAvailable()` is true once the vault is up, `getAddress()` logs in when
needed (with the button fallback when SWK's own awaits cost the popup), the sign methods open the approval popup in
your click the same way, `disconnect()` is `hana.logout()`. Errors are
SWK's `{code, message, ext}`, with `4001` for a rejection and the Hana code in `ext`. Hana only signs, so
`submit: true` is refused.

### EVM (EIP-1193)

`hana.ethereum` is an EIP-1193 provider, announced through EIP-6963 as "Hana ID" when you pass `evm` to
`createHana`:

```ts
// viem
const wallet = createWalletClient({ chain: baseSepolia, transport: custom(hana.ethereum) });
// ethers
const provider = new BrowserProvider(hana.ethereum);
// wagmi: the injected connector discovers it through EIP-6963 (name "Hana ID")
```

| Method | Behaviour |
|---|---|
| `eth_requestAccounts` | logs in if needed (from a click; the button fallback otherwise) |
| `eth_accounts` | `[address]` or `[]` |
| `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` | among `evm.chains`; another chain is `4902`. A test app switching to or adding a mainnet chain gets `4100` (`data.reason: 'mainnet_not_allowed'`) |
| `eth_sendTransaction` | the SDK fills nonce, gas and fees from your RPC, the user approves, and the SDK broadcasts through the RPC of the chain it was filled on (even if the chain is switched during the approval). Sends run one at a time per chain, and a filled nonce is never below one past the last one this page broadcast, so back-to-back sends get consecutive nonces |
| `eth_signTransaction`, `personal_sign`, `eth_signTypedData_v4` | approval |
| `eth_sign` and other signing or wallet methods | `4200` |
| read-only methods (`eth_call`, `eth_getBalance`, …) | forwarded to the current chain's `rpcUrl` |
| `eth_sendRawTransaction` | forwarded to the current chain's `rpcUrl` (it broadcasts a transaction you already hold signed; Hana signs nothing) |

The RPC you configure is trusted for liveness and ordering: it fills fees and nonces, answers reads and broadcasts,
so use a provider you trust, over https (required for `pk_live_` keys). The hash `eth_sendTransaction` returns is the
one your RPC reports.

One key covers every EVM chain. Contract creation (an empty `to`) works with approval, but no policy ever
auto-approves it. Errors are `ProviderRpcError` with numeric codes. A sign-in that didn't complete is `4001`, and the
Hana code is in `error.data.code`. Logging out emits `accountsChanged []`, as wallets do.

### Raw signing

Off by default, and never available to a test app (`pk_test_…`): a raw digest can be a mainnet transaction's hash,
so a test app's `signRaw` is `4100` (`data.reason: 'raw_not_allowed_for_test_apps'`) whatever its setting. With raw
signing set to `'approval'` for a live app:

```ts
await hana.signRaw({ chain: 'stellar', bytes });   // Ed25519 over ≤ 4 KiB → { signature } (64 bytes)
await hana.signRaw({ chain: 'evm', digest });      // secp256k1 over 32 bytes → { signature } (r‖s‖v, v ∈ {27, 28})
```

The user always approves raw requests, under a red warning that raw signing can authorize any transaction on that
chain. No policy ever covers them. Ask for it only if a standard method can't do the job. With raw signing off,
`signRaw` is `4100` (`data.reason: 'raw_sign_off'`), also in a tab opened before it was turned off. Bytes in Hana's
own signing domains are never raw-signed: Stellar bytes starting with `hana-id`, and the session's identity
wallet-proof digest on EVM, are `4100` (`data.reason: 'raw_reserved_domain'`) before any popup (D179). If the vault can't
confirm the setting with Hana's API (it re-reads it at most every 10 s), the request fails with `api_unavailable`
rather than going ahead.

## 9. Auto-approve policies

By default every signature needs the popup. An auto-approve policy lets matching requests be signed without one, for
example repeated deposits into your contract. It needs two opt-ins:

1. **You** set a policy for your app. It takes effect after the delay (24 h; 60 s on sandbox-dev).
2. **Each user** accepts that exact policy once, in a Hana popup that shows your app, your verified origin, the
   policy's label, every contract (its name, short address and explorer link: see "Contract names" below), the
   functions, the address rule and the limits. A changed policy asks every user again.

Until both happen, matching requests simply get the normal popup. The vault, not your page, checks every request
against the policy, so an injected script on your page can do no more than the policy allows.

**How to request one.** Write the policy as JSON (below) and send it to Hana with your app's id or key. Hana runs it
through the same validator the vault uses (`admin app:settings <app> --auto-approve policy.json`), which lists any
problem and prints the `policyId` your users will accept. You can run the validator yourself first:

```ts
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
const r = validateAutoApprovePolicy(JSON.parse(text), { sessionTtlMs: 12 * 3_600_000 }); // { ok, policy } or { ok: false, problems }
```

Removing a policy (`--auto-approve off`) is immediate for new page loads. A tab that is already open re-reads the
policy in force (`GET /v1/app`) before an auto-sign whenever its last check is 10 s old or more, and every 60 s in the
background, so a removed or changed policy auto-signs nothing more within 10 s; if that re-read fails, the request
gets the popup. A changed policy is treated as no policy until the page reloads, and then needs the users' consent.

**Example** (validated against `@hana-id/core`; the addresses are placeholders):

```json
{
  "v": 1,
  "label": "Deposits on Example Vault",
  "maxConsentMs": 43200000,
  "limits": { "perDayCount": 20 },
  "stellar": {
    "networkPassphrases": ["Test SDF Network ; September 2015"],
    "maxFeeStroops": "200000",
    "contracts": [
      {
        "id": "CAAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQC526",
        "name": "Example Vault",
        "functions": [{ "name": "deposit" }, { "name": "withdraw", "addressArgs": "self-or-listed" }]
      },
      {
        "id": "CABAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAEAQCAIBAFNSZ",
        "name": "USDC",
        "functions": [{ "name": "approve" }]
      }
    ],
    "changeTrustAssets": ["USDC:GABQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQGAYDAMBQHGPC"]
  },
  "evm": {
    "chains": [
      {
        "chainId": 84532,
        "maxValueWei": "50000000000000",
        "maxValueWeiPerDay": "1000000000000000",
        "maxFeeWei": "50000000000000",
        "contracts": [
          {
            "address": "0x1111111111111111111111111111111111111111",
            "name": "USDC",
            "selectors": [{ "selector": "0x095ea7b3", "signature": "approve(address,uint256)", "addressArgs": "self-or-listed" }]
          },
          {
            "address": "0x2222222222222222222222222222222222222222",
            "name": "Example Vault",
            "selectors": [
              { "selector": "0xb6b55f25", "signature": "deposit(uint256)" },
              { "selector": "0x00f714ce", "signature": "withdraw(uint256,address)", "addressArgs": "self-or-listed" }
            ]
          }
        ]
      }
    ]
  }
}
```

| Field | Rule |
|---|---|
| `label` | ≤ 80 characters, shown to the user |
| `maxConsentMs` | how long one acceptance lasts: 1 min up to your session limit (it also ends with the session, on logout, or when the user stops it) |
| `limits.perDayCount` | auto-signed requests per user per UTC day, 1 to 500, counted per device |
| `stellar.networkPassphrases`, `maxFeeStroops` | the networks, and the most fee one transaction may pay |
| `stellar.contracts[].functions[]` | Soroban functions by name; the whole authorization tree must stay inside listed contracts and functions |
| `stellar.changeTrustAssets` | `CODE:ISSUER`: `changeTrust` is the only classic operation a policy can cover |
| `evm.chains[]` | per `chainId`: `maxValueWei` per transaction and `maxValueWeiPerDay` of native spend, where spend is the value **plus the maximum fee** (gas limit × max fee per gas, or gas price); `maxFeeWei` caps the fee alone per transaction. So `maxValueWei` must be at least `maxFeeWei` (the validator refuses less: such a rule could never auto-approve a call at its fee cap), even if your calls send no value (the example allows fees only: 20 calls at up to 0.00005 ETH). The consent screen shows these as "Maximum value plus network fees, per transaction / per day" |
| `evm.chains[].contracts[].selectors[]` | the 4-byte `selector` and its canonical `signature`; calldata must decode against it |
| `evm.chains[].typedData` | `(verifyingContract, primaryType)` pairs for EIP-712 (permit-style signatures are never covered by default) |
| `addresses` (either chain) | extra addresses allowed as call arguments |

**The address rule.** With `addressArgs: 'self-or-listed'` (the default), every address argument, at any depth of the
Soroban call tree or the ABI-decoded calldata, must be the user's own address, a listed contract or an `addresses`
entry. That is what stops an injected script from sending funds or allowances to itself through an allowed
function. `'any'` must be set explicitly, and the user sees "can send to any address". The validator refuses
`'any'` on approve-, transfer-, send-, permit- and ownership-style functions, and on execute-style ones (`execute`,
`multicall`, `aggregate`, `call`, `batch…`, `delegatecall`, `upgradeTo` and the like), which run calls described in
their arguments. It also requires `addressArgs` on every EVM function that takes an address. Arguments where an
address could hide unseen (`bytes`, `string`, `bytes20`–`bytes32`, `uint160`/`int160`, at any depth of arrays and
tuples; on Stellar `Bytes`, `BytesN` and `String`) are never auto-approved under either rule: the validator refuses
such EVM functions, and the vault sends any Stellar call carrying them to the popup. They need a protocol decoder.
Note that 160-bit integers include Permit2's `uint160` amounts, so Permit2 `PermitSingle`/`PermitBatch` typed data
and calls with a `uint160` argument (Uniswap v3's `sqrtPriceLimitX96`) always get the popup. Wider integers
(`uint256`) are treated as amounts.

**Never covered, whatever the policy says:** raw signing, `personal_sign`, Stellar messages, EVM contract creation,
`eth_sign`, Stellar classic operations other than a listed `changeTrust`, fee-bump envelopes, and anything the
vault can't fully decode. Operations that change who controls a Stellar account (a `setOptions` that adds,
re-weights or removes a signer or changes a threshold or the master weight, and `accountMerge`) are refused first
(`account_control`), and the popup shows them under a red "changes who controls a Stellar account" warning (D110):
don't build flows that need them. **Not covered in the pilot:** calls whose instructions travel in opaque bytes, such as
routers, multicall, bridges and Sodax swaps (`AssetManager.transfer`, `sendMessage`). Those always get the popup until
a protocol decoder for them ships. Token amounts other than native value are not capped in the pilot (D46), so keep
`perDayCount` small.

**Contract names on the consent screen.** The `name` you give a contract is shown as yours: "{name} · named by
{your app name}". A contract on Hana's verified list shows "✓ {verified name}" instead, and your name for it isn't
shown. If your name for any other contract reads like a verified name or mentions a verified protocol (say "Sodax
Router" on an address that isn't one of Sodax's verified contracts), the screen flags it ("— not the verified Sodax
Asset Manager", "— not a verified Sodax contract") and warns the user at the top. Check marks are removed from your
names. Every contract also shows its short address (`0x348B…7Bc3`) and a "View on {explorer}" link for its chain
(Etherscan, Basescan, SonicScan, StellarExpert and others, test networks included; a chain Hana has no explorer for
shows the address alone). The verified list starts with Sodax's mainnet contracts (its Sonic hub contracts; asset
managers and bnUSD on the EVM spokes and Stellar; Connection contracts on Hedera, Kaia and Robinhood Chain), each
confirmed by two Sodax sources that agree (D44).

**Getting a contract verified.** Ask Hana, with the chain, the address and the protocol's own official sources for
it: a page of the protocol's documentation that lists the address, and/or a published, version-pinned package of the
protocol (its SDK config) that contains it. Hana adds the entry only after confirming the address from those sources
(two that agree, where they exist), records them with the entry, and ships it in a Hana release: the list is built
into Hana's popup, not read from the API, so it can't be changed for one app. Your own contracts can be verified the
same way, under your protocol's name.

Your page can use:

```ts
await hana.requestAutoApprove();   // opens the consent screen now → { granted, policyId?, expiresAtMs? }; 4100 without a policy
await hana.autoApproveStatus();    // { policyId, label, expiresAtMs, used: { count, native } } or null
await hana.revokeAutoApprove();    // the user can also stop it from any Hana popup
```

Without `requestAutoApprove()`, the first matching request shows the consent screen. A request that doesn't match
gets the normal popup, which tells the user why it wasn't auto-approved. After each auto-signed request the vault
emits `autoApproved` and its button briefly shows "Signed by Hana under {label}".

## 10. React

`@hana-id/react`:

```tsx
import { HanaProvider, useHana, useIdentityToken, useWallet } from '@hana-id/react';

<HanaProvider config={{ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm, stellar }}>
  <App />
</HanaProvider>;

function SignIn() {
  const { status, addresses, persistence, error, login, logout, exportKey } = useHana();
  return <button onClick={login}>Sign in</button>; // login must run in the onClick, with no await before it
}

const { address, signer } = useWallet('stellar'); // signer is hana.stellar
const { address, provider } = useWallet('evm');   // provider is hana.ethereum (EIP-1193)
const { identityToken, refresh, error } = useIdentityToken(); // for your backend, kept fresh (section 15)
```

- `HanaProvider` creates one client, also under strict mode, and destroys it on unmount. It reads `config` once; to
  switch app or environment, remount it (a `key`).
- A failed login (popup closed, `4001`, `popup_blocked`, `login_cancelled`) is in `useHana().error`. The promise
  `login()` returns is already marked handled, so `onClick={login}` never raises an unhandled rejection; if you
  `await` or `.catch` it, you still get the rejection. `logout()` and `exportKey()` reject as usual and their
  failures aren't in `error`: handle them (`onClick={() => logout().catch(report)}`).
- Server rendering (Next.js): the modules are `'use client'`, and the client is created in an effect, so a server
  render shows the initial state (`status: 'unlocking'`, no addresses, `signer` / `provider` null) and never touches
  `window`.
- React 18 and 19 are both supported (peer dependency `^18 || ^19`); the test suite runs on both, and the source
  typechecks against `@types/react` 18 and 19.

## 11. Sodax adapter

`@hana-id/sodax` (optional), typed against `@sodax/types` 2.1.0:

```ts
import { createSodaxEvmProvider, createSodaxStellarProvider } from '@hana-id/sodax';

const stellarProvider = createSodaxStellarProvider(hana, { networkPassphrase, horizonUrl, sorobanRpcUrl }); // IStellarWalletProvider
const evmProvider = createSodaxEvmProvider(hana, { chainId: 8453, rpcUrl });                              // IEvmWalletProvider, one per spoke chain
```

- The Stellar provider signs through `hana.stellar` (fee-bump allowed) and sends to Soroban RPC.
  `signAndSendTransaction(rawTx)` signs as `rawTx.from`: a transaction built for another account is refused (4100)
  before any popup. `waitForTransactionReceipt` polls Horizon every 2 s for 60 s.
- The EVM provider is bound to one chain, which must be in your `evm.chains` (it throws otherwise). It refuses a
  `from` other than the user's address, fills, gets the user's approval and broadcasts. Filling and broadcasting use
  the `evm.chains` RPC; `rpcUrl` is for receipts and must be the same chain: the provider checks its `eth_chainId`
  once, before the first transaction is signed, and refuses another chain with `4902` (`data.reason:
  'receipt_rpc_wrong_chain'`). If that RPC can't be reached for the check, the send fails with nothing signed
  (`-32603`, `receipt_rpc_unreachable`); the next send checks again.
- `waitForTransactionReceipt` (EVM) polls `rpcUrl` every 2 s for 180 s. RPC faults and receipts that don't parse
  are retried until the deadline, never reported as a failed transaction, since the transaction is already
  broadcast; only `receipt_timeout` ends it. The receipt is passed through leniently, as viem does (a null `type`,
  an unknown `status` or missing optional fields stay as the node sent them).
- Call the providers' `sendTransaction` / `signTransaction` / `signAndSendTransaction` from your click: the EVM
  provider opens the approval popup before its own chain check and queue, and the Stellar provider signs at once, so
  the popup opens in that click. If your handler awaits a Sodax quote first, call `hana.prepareApproval()` before it
  ([section 8](#8-signing)).
- A Sodax swap can need several signatures (`restoreFootprint`, a re-sign, a trustline). The approval popup's 15 s
  keep-open covers them in one session of clicks. Sodax swaps can't be auto-approved yet (see section 9).
- Sodax runs on mainnet only, while pilot keys are testnet-MPC keys: the adapter is tested against mocks of the
  `@sodax/sdk` 2.1.0 call patterns, not end to end. A test app's vault refuses Sodax's mainnet transactions
  (`mainnet_not_allowed`, [section 12](#12-test-and-live-keys)): integrate and test on chain testnets; real Sodax swaps
  through Hana wait for live keys (D39).

## 12. Test and live keys

| | `pk_test_…` | `pk_live_…` |
|---|---|---|
| Where | sandbox envs (testnet), the pilot | the production MVP (mainnet), after the audit; not issued yet |
| Loopback origins (`http://localhost:…`) | allowed, in `local*`/`sandbox*` envs only | never |
| Login result | carries per-stage `timings` (`hana.lastLogin.timings`, below); the handshake and unlock's are `hana.readyTimings` | no timings (`hana.readyTimings` is null) |
| Direct API calls from your page (`/v1/sessions`, `/v1/derive`) | only in sandbox envs, for test tooling such as `apps/smoke` | never |
| Networks | test networks only: any Stellar network but the public one, and the EVM chains below | any |

A test app's keys come from the testnet MPC, which can lose or leak them, so its vault refuses anything a mainnet would
accept (`4100`, `data.reason: 'mainnet_not_allowed'`, before any popup or policy): a Stellar transaction or auth entry
for `Public Global Stellar Network ; September 2015`, an EVM transaction on a chain outside the list below, and typed
data whose domain names such a chain. `eth_sendTransaction`, `eth_signTransaction` and switching to or adding such a
chain are refused by the SDK the same way. Raw signing is refused for test apps altogether
([section 8](#8-signing)). Messages and typed data without a `chainId` name no network and are not refused; don't use
them to move mainnet funds from a test app either.

EVM chains a test app may use: Sepolia (11155111), Holesky (17000), Hoodi (560048), Base Sepolia (84532), Arbitrum
Sepolia (421614), OP Sepolia (11155420), Sonic testnet (14601), Sonic Blaze testnet (57054), BNB Smart Chain testnet
(97), Polygon Amoy (80002), Avalanche Fuji (43113), and local chains 31337 and 1337 (`TEST_EVM_CHAINS` in
`@hana-id/core`). Ask Hana to add another testnet.

A test app and a live app never share a scope. Your staging and production apps therefore give the same Google
account **different addresses** (D51). Wallets made with test keys are disposable.

**Login timings (test apps).** `hana.lastLogin.timings` holds consecutive stages, in ms, that add up to the login's
time (the full table: `apps/smoke/README.md` "Timings"): `open`, `wait`, `app` (`GET /v1/app`), `keygen`, `popup`,
`authCheck`, then the sign-in step, then `relayHeld`, `verify`, `scopeWait`, `chain`, `decrypt`, `finish`, `port`. The
sign-in step depends on the method (D260): `choose` when the popup showed its method chooser; for Google, `google`
(the user and Google's pages, plus the relay's network legs) and `callbackRedirect`, `callbackFetch`, `callbackBoot`,
`callbackPrep`; for email, `emailLoad` (the email screen's load), `emailEntry` (typing the address), `emailStart` (the
code request), `emailCode` (waiting for the mail and typing the code), `emailVerify` (checking the code) and
`emailRelay` (the relay's network legs), and no `google`. Breakdown values that aren't added: `appRtt`, `appServer`,
`appServerGate`, `appServerSettings`, `appServerChain` (inside `app`), `scopeCheck`, `chainPrep`, `loginRtt`,
`loginServer*`, `vault`.

## 13. Errors

`hana.*` methods reject with a `HanaError {code, message, data?}`. The EIP-1193 provider maps string codes to numbers
(the Hana code stays in `data.code`), and the SWK module maps them to SWK's shape.

| Code | Meaning | What to do |
|---|---|---|
| `4001` | The user rejected, closed the popup, or let it time out | nothing; let them retry |
| `4100` | Not logged in, wrong address, or not allowed for this app (raw signing off, no policy, a mainnet for a test app: `data.reason`) | log in, or check the call |
| `4200` | Unsupported method (`eth_sign`, …) | use a supported method |
| `4900` | The vault is gone (logged out, session ended, frame replaced) | create the client again, or log in |
| `4902` | EVM chain not in `evm.chains` | add it to `createHana` |
| `vault_unavailable` | The vault didn't load (one automatic retry; `data.reason`: `csp_frame_src`, `no_answer`, `frame_timeout`, `ready_timeout`, `frame_replaced`, [section 3](#3-create-the-client)) | check `frame-src`, your origins, the network. A wrong origin or key takes about 10 s to report (`no_answer`) |
| `popup_blocked` | The browser blocked the popup and the sign-in was cancelled | call `login()` in a click |
| `coop_blocks_popup` | The popup closed before it connected (COOP `same-origin`, or the user closed it at once) | fix COOP |
| `login_timeout` | The popup never connected (15 s), or the sign-in took over 5 min | retry |
| `login_cancelled` | `cancelLogin()`, or a newer `login()`, or the user cancelled the email step, or cancelled Google's sign-in screen and then closed the Hana popup on the screen it went back to (D341); `data.reason: 'email_consent_declined'` or `'google_account_mismatch'`: a new Google user refused Google's email permission (or chose another Google account there) and cancelled Hana's explanation | offer email sign-in |
| `login_method_unavailable` | `login({method})` named a method your app doesn't offer (email not turned on) | offer the other method |
| `code_invalid`, `challenge_expired` | Email login: the user cancelled after a wrong or expired code | let them retry |
| `link_pending` | This sign-in method is waiting to join a wallet (`data.effectiveAtMs`: when it can open it) | show when; sign in with the wallet's other method meanwhile |
| `link_refused` | The sign-in methods can't be linked (`data.reason`); `login()` with the wallet's own method still works | offer the other method |
| `google_error` | Google returned an error (`data.error`), or Hana couldn't check Google's answer (`tokeninfo_unavailable`, `tokeninfo_client_mismatch`, `tokeninfo_invalid`, `google_account_mismatch`, `invalid_response`). The user cancelling Google's sign-in screen is not one: the popup goes back to its chooser, and closing it there is `login_cancelled` (D341). `access_denied` remains only where Hana has no screen to go back to (a login in an environment without Hana's email service, or the fallback Google request a Google-only app makes when Google's tokeninfo can't be reached) | retry; with `access_denied`, the user declined |
| `no_google_client` | Your scope has no usable Google client | ask Hana |
| `token_invalid`, `token_has_pii` | The Google token failed Hana's checks | retry; report it if it persists |
| `config_mismatch` | Hana's pages disagree about the signer, scope or client, or the scope doesn't match the on-chain registry (`data.reason: 'scope_mismatch'`) | report it to Hana; never retry around it |
| `ckd_failed`, `derive_failed`, `pairing_failed`, `address_mismatch` | The key couldn't be produced (`derive_failed` with `data.reason: 'link_restart'`: a linking login was interrupted and its session revoked) | the user logs in again |
| `session_consumed` | Someone replayed the login transaction first | the vault offers "Continue signing in" |
| `rate_limited`, `app_suspended`, `origin_not_allowed`, `api_unavailable` | From Hana's API (`rate_limited` also after 3 key exports of one account in an hour), or NEAR's RPC couldn't be read. `api_unavailable` with `data.reason`: `email_match_unavailable` (Hana's email service didn't answer for a new Google user), `path_unconfirmed` (a linked sign-in method's wallet couldn't be confirmed on both of Hana's NEAR providers), `path_disputed` (they disagree: report it) | back off, or contact Hana |
| `storage_unavailable` | The Hana popup couldn't store what its next step needs (blocked or full browser storage) | ask the user to allow site data, or try another browser |
| `busy` | An export is already running | wait |
| `identity_unavailable` | `getIdentityToken()`: Hana's API or signer is unavailable, or this browser couldn't keep the session (`data.reason: 'no_share'`) | retry later |
| `session_ended` | `getIdentityToken()`: the Hana session is over (`sessionExpired` fires too), or ends within 30 s (`data.reason: 'session_ending'`) | treat as logged out |

## 14. Security notes for integrators

- Your page never holds a key, a CKD secret or a Google token, and no message to it carries one. Don't try to get
  them; build on addresses and signatures.
- An XSS on your page can start a login, read addresses and queue signature requests. It can't sign anything without
  the user's Approve, except requests inside a policy the user accepted, up to its limits. Keep policies tight.
- Your page holds a handle to the approval popup it opens, as it does for any popup: it could navigate or close it,
  but the popup takes nothing from your page, and users should trust only a window whose address bar shows Hana's
  `authOrigin`.
- Sandbox third-party iframes (ads, widgets, embeds): give them `sandbox` without `allow-top-navigation` and, unless
  they need it, without `allow-scripts` and `allow-same-origin` together. An unsandboxed frame can navigate its
  sibling frames, the Hana vault frame included, and put its own page where the "Review in Hana" launcher was. The
  SDK hides the vault frame and emits `launcher {visible: false}` as soon as its document is replaced (status
  `error`, 4900), but a frame that can do this can also overlay your page, so don't give third parties that power.
- A malicious browser extension can do anything the user can, including reading an exported key. No web wallet
  design prevents that.
- With your own Google client, your client's settings are part of your users' security ([section 6](#6-google-client-shared-or-your-own)).
- Testnet pilot keys are disposable. Until the address freeze, Hana may still change what a key derives from, and
  each such change gives every user new addresses.

## 15. Identity token (your backend)

Your backend can learn **who** the user is in your app, **which wallets** they hold and **which Hana session** a
request belongs to, without calling Hana and without a wallet signature: ask the page for an identity token and verify
it on your server against Hana's published keys (`docs/identity-token-spec.md`, D120, D127). It is the Hana
counterpart of Privy's identity token (see "Migrating from Privy" below).

```ts
const token = await hana.getIdentityToken(); // string, or null while logged out
await fetch('/api/session', { method: 'POST', headers: { authorization: `Bearer ${token}` } });
```

- **Silent.** No popup, no user activation: call it from any handler, an effect or a timer. It doesn't count as
  activity, so polling it never keeps a session alive.
- **Cached.** The vault keeps one token per session, shared by every tab of that session; a new one is minted when
  less than 5 minutes remain. `getIdentityToken({ maxAgeMs })` forces a fresh one when the cached token is older
  (30 s minimum, 1 h maximum): use it before a sensitive action, with `maxAgeSec` on your server.
- **Events.** `hana.on('identityTokenChanged', (token) => …)` fires after every mint (in this tab or another tab of the
  session) and with `null` at logout, expiry, revocation or a newer login. `hana.identityToken` is the last one.
- **Errors.** `getIdentityToken()` resolves `null` while logged out; it rejects with `identity_unavailable` (Hana's API
  or signer is down, or this browser couldn't keep the session in an app that keeps logins: `data.reason: 'no_share'`;
  retry later), `session_ended` (the session is over: `sessionExpired` fires too; `data.reason: 'session_ending'` when
  less than 30 s remain) or `rate_limited` (more than 10 mints a minute for one session or 30 for one user, or your
  app's own identity-token quota: 10 × your plan's per-minute rate a minute and your plan's daily rate an hour, apart
  from the quota your logins and unlocks use; D176).
- **React.** `const { identityToken, refresh, error } = useIdentityToken();` mints on first use while logged in, keeps
  the token fresh (a timer at `exp` − 5 min, only while the page is visible) and re-renders on `identityTokenChanged`.
  `refresh({ maxAgeMs })` gets one now.

### What's in it

An ES256 JWT (`typ: hana-identity+jwt`, `kid` = the key's RFC 7638 thumbprint), valid for at most 1 hour and never
past the Hana session:

| Claim | Value |
|---|---|
| `iss` | `{Hana API}/v1/identity` (sandbox-dev: `https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/identity`; a stable Hana hostname replaces it before any partner goes live, D127) |
| `aud` | your app id (`app_…`), not your publishable key |
| `sub` | `u1_…` (25 characters): stable per user in your app's scope, the same for every login method of their account and after a key rotation; different at every other partner; never the Google `sub` |
| `sid` | `s1_…`: one per Hana session, shared by its tabs and reloads, new at every interactive login, never repeated |
| `iat`, `exp`, `jti` | seconds; `exp` ≤ `iat` + 3600 and never past the session's end; `jti` is random |
| `wallets` | `[{chain: 'stellar', address: 'G…'}, {chain: 'evm', address: '0x…'}]`, a real JSON array; the holder of this Hana session proved control of each address's key (a signature bound to this session and app) |
| `login_methods` | the account's login providers, sorted (`["google"]` today) |
| `email`, `email_verified` | not issued yet: an opt-in verified email per app comes with email login (the claim pair then appears only for users who agreed to share it with you) |

What `wallets` proves, and what it doesn't: the session's holder controls each key. It is **not** proof that the
address is the Hana-derived wallet of that `sub`: a user who tampers with their own vault can attach another key they
control (never someone else's address), and one address can appear under several `sub`s (a key the user exported and
reuses elsewhere, an old key after a rotation). So never treat wallet → `sub` as unique, for example for per-wallet
credits or sign-up bonuses: key those on `sub`, and dedupe wallets yourself. If a request must come from one exact
wallet, keep checking that the wallet that authenticated it is in `wallets` (`assertWallet` below).

### Verify it (Node, `jose`)

The JWKS is at `{iss}/jwks.json` (cached 10 minutes; `jose` refetches on an unknown `kid`), the discovery document at
`{iss}/.well-known/openid-configuration`. **For anything of value, pin the key thumbprints** (`HANA_IDENTITY_PINS`
below: each key's thumbprint is also its `kid` in the JWKS; confirm the list with Hana out of band, e.g. with your
security contact, rather than trusting one fetch): the JWKS is served by Hana's
infrastructure, and a pinned verifier refuses a key whoever controls it publishes, where a verifier that only trusts
the URL accepts it until Hana notices and removes it. This is `examples/identity-verify/src/verify.ts`, tested against a
local issuer on every run:

```ts
import { calculateJwkThumbprint, createRemoteJWKSet, errors, exportJWK, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// From Hana's partner console / your Hana app page. Not secrets.
const HANA_ISSUER = process.env.HANA_IDENTITY_ISSUER!; // e.g. https://<hana api>/v1/identity
const HANA_APP_ID = process.env.HANA_APP_ID!; // app_…

// Recommended for anything of value: the key thumbprints Hana gives you (comma-separated; each is also its kid). A key
// that isn't one of them is refused even if Hana's JWKS lists it, so a key published by whoever controls Hana's
// servers never verifies here. Hana announces scheduled rotations 14 days ahead. Unset: the JWKS URL alone is trusted.
const HANA_PINS = (process.env.HANA_IDENTITY_PINS ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// Caches the keys for 10 minutes and refetches on an unknown kid (at most every 30 s).
const remoteKeys = createRemoteJWKSet(new URL(`${HANA_ISSUER}/jwks.json`));
const hanaKeys: JWTVerifyGetKey = async (header, token) => {
  const key = await remoteKeys(header, token);
  // Judged by the key itself, never by its kid (anyone can put a pinned kid on another key).
  if (HANA_PINS.length && !HANA_PINS.includes(await calculateJwkThumbprint(await exportJWK(key)))) throw new errors.JWKSNoMatchingKey();
  return key;
};

export interface HanaIdentity {
  userId: string; // sub: stable per user in your app
  sessionId: string; // sid: one per Hana session (device)
  wallets: { chain: 'stellar' | 'evm'; address: string }[];
  email: string | null; // only if the user agreed to share it with you
  loginMethods: string[];
  issuedAt: number; // seconds
}

export class HanaTokenError extends Error {
  constructor(readonly code: 'expired' | 'invalid' | 'stale') {
    super(code);
  }
}

export async function verifyHanaIdentityToken(token: string, opts: { maxAgeSec?: number } = {}): Promise<HanaIdentity> {
  let payload: JWTPayload;
  try {
    ({ payload } = await jwtVerify(token, hanaKeys, {
      issuer: HANA_ISSUER,
      audience: HANA_APP_ID, // mandatory: a token for another app must fail
      algorithms: ['ES256'],
      typ: 'hana-identity+jwt',
      requiredClaims: ['sub', 'sid', 'iat', 'exp', 'wallets'],
      clockTolerance: 30,
      ...(opts.maxAgeSec ? { maxTokenAge: opts.maxAgeSec } : {}),
    }));
  } catch (e) {
    if (e instanceof errors.JWTExpired) throw new HanaTokenError(opts.maxAgeSec && e.claim === 'iat' ? 'stale' : 'expired');
    throw new HanaTokenError('invalid'); // fail closed
  }
  const wallets = Array.isArray(payload.wallets) ? (payload.wallets as HanaIdentity['wallets']) : [];
  return {
    userId: payload.sub!,
    sessionId: payload.sid as string,
    wallets,
    email: payload.email_verified === true && typeof payload.email === 'string' ? payload.email : null,
    loginMethods: Array.isArray(payload.login_methods) ? (payload.login_methods as string[]) : [],
    issuedAt: payload.iat!,
  };
}

// Bind the token to the request's wallet when the wallet also authenticated (e.g. a signed challenge):
export function assertWallet(identity: HanaIdentity, chain: 'stellar' | 'evm', address: string): void {
  const ok = identity.wallets.some((w) => w.chain === chain && (chain === 'evm' ? w.address.toLowerCase() === address.toLowerCase() : w.address === address));
  if (!ok) throw new HanaTokenError('invalid');
}
```

Rules:

1. Always check `aud` (your app id), `iss`, `typ` and `alg` (pinned to ES256); take keys from the JWKS URL, never a key
   named in the token's header; and for anything of value (credits, payouts, account access) pin the thumbprints,
   judged on the key itself (`calculateJwkThumbprint`), never on its `kid`.
2. Key users by `sub`, not by email or address. Store `sid` to run one session per device and to block a signed-out
   `sid`; a new interactive login always brings a new `sid`. Unlinking a login method later gives a different wallet
   and so a different `sub`: to you that is a different user.
3. The token is evidence of identity at `iat`, not your session: run your own session and end it when your page
   reports a Hana logout (`statusChanged`, `identityTokenChanged(null)`). For sensitive actions require a fresh token
   (`maxAgeSec` here, `maxAgeMs` on the page).
4. Never log tokens; treat them like any bearer credential (≤ 1 h, your app only).
5. On `expired`, answer 401 with a distinct code: the page calls `getIdentityToken()` again and retries once (`null`
   means the user is logged out). On `invalid`, answer 401 and never fall back to "no token".
6. Verifying takes under 1 ms once the JWKS is cached.

Other languages: any JOSE/OIDC library works with the same checks: compact JWS, `alg` ES256 only, a key from the JWKS
by `kid`, `typ` `hana-identity+jwt`, `iss`, `aud`, `exp` (and `iat` for freshness), with up to 30 s of clock skew.

**Key rotation.** Hana publishes a standby key next to the active one, and both are pinned from the start: an
emergency switch to the standby needs nothing from you either way. A scheduled rotation adds a key 14 days ahead of
using it (24 h on testnet), announced to your security contact: add its thumbprint to your pins in that window. A
compromise that exposes both keys means a fresh key you must pin at once (Hana tells you); until you do, a pinned
verifier refuses the new tokens (fail closed) rather than accepting an attacker's.

**Who watches the JWKS.** Hana's independent watchdog, on its own Cloudflare account (sandbox-dev excepted), reads the
JWKS every 5 minutes, and a probe outside Cloudflare reads it every 15; either alerts Hana if it ever lists a key
whose thumbprint Hana didn't pin, private key material, or a discovery document with another `issuer` or `jwks_uri`.
That is detection, not prevention, and only of an attacker who serves the same JWKS to everyone: someone who controls
Hana's servers can show the watchdog and the probe a clean JWKS and your verifier another, or publish a key between
two reads. A verifier that only trusts the JWKS URL accepts such a key until Hana notices and removes it (and its
cache expires, ≤ 10 min). Pinned thumbprints are the only defence that doesn't depend on Hana noticing.

### Migrating from Privy

| Privy | Hana |
|---|---|
| access token `sid` | `sid` (same semantics; a Hana session lasts ≤ 12 h by default, 2 h idle) |
| `sub` (`did:privy:…`) | `sub` (`u1_…`, per scope). Users get new wallets with Hana; map existing users to new `sub`s yourself |
| `iss: "privy.io"` | `iss: "{Hana API}/v1/identity"` |
| `aud: <Privy app id>` | `aud: app_…` |
| access + identity token, one key pasted from the dashboard | one identity token, keys from the JWKS URL |
| `linked_accounts` (stringified JSON) | `wallets` (a JSON array), `login_methods` |
| `linked_accounts[type=wallet, chain_type=stellar / ethereum].address` | `wallets[chain=stellar / evm].address` |
| `getAccessToken()`, `getIdentityToken()`, `useIdentityToken()` | `hana.getIdentityToken()`, `useIdentityToken()` |
| `privy-id-token` cookie | a header you send (`Authorization: Bearer`); Hana sets no cookie |
| refresh token | none: the live Hana session refreshes |
