# Integrating Journear Passport (partner guide)

Journear Passport gives your users a Stellar, an EVM and a NEAR wallet from a Google login, with no extension or seed phrase.
You add the SDK to your web app, users click your "Sign in" button, and you sign through standard interfaces: an
EIP-1193 provider, a Stellar signer and a Stellar Wallets Kit module, a NEAR signer (`hana.near`, SDK 0.4.0), with an
optional Sodax adapter. Keys and Google tokens
never reach your page. They live in a hidden Journear Passport iframe, and every signature needs the user's Approve in a Journear Passport
popup, unless it falls under an auto-approve policy you set and the user accepted.

New to Journear Passport? Read the short `partner-start-here.md` first (sent with the SDK files): what to send Journear, sign-in for
your testers, and your first sign-in in four steps. This guide has the detail.

> **Renamed.** Hana ID is now called **Journear Passport** (the company, Journear; the users' own page, Passport Home).
> Only the names you and your users read changed: the popups, emails, error messages, the vault iframe's title, and
> the wallet-picker name and icon ("Journear Passport" and the Journear mark). The package names (`@hana-id/*`), the
> API (`createHana`, `HanaError`, `ProviderRpcError`, `hana.*`, `HanaIdModule`, `HanaProvider`), error codes, event
> names, the `HANA_*` settings, the EIP-6963 `rdns`, SWK's `productId` (`hana-id`), the identity token's format and the
> origins are unchanged, so no code change is needed. Match on error codes, never on messages.

> **Testnet pilot.** Keys come from the NEAR **testnet** MPC and stay disposable until the address freeze (final
> accounts, audit, mainnet). Don't keep real funds in pilot wallets, on any chain. A test app (`pk_test_…`) can't sign
> for mainnet chains at all ([section 12](#12-test-and-live-keys)).

> **NEAR is Journear Passport's chain, and since SDK 0.4.0 your users' too.** Journear Passport derives every key through NEAR's MPC network and
> records each login on NEAR; that is what "NEAR testnet" means wherever an environment's network is named. Your users
> get a Stellar and an EVM wallet and, with SDK 0.4.0, a NEAR account of their own ([section 8, NEAR](#near)), separate
> from Journear Passport's NEAR accounts.

Last verified against code: 2026-11-13 (the relay's allowlist adds the passport stamps contract), SDK 0.4.1. "SDK releases after 0.2.0" marks what came after 0.2.0.

## How it works

```
your page ──iframe──▶ vaultOrigin/vault      holds the key (in memory; on disk only under a server-held share)
    │                      ▲  MessageChannel
    └─ window.open ─▶ authOrigin/login ─▶ Google ─▶ authOrigin/login/callback ─(encrypted relay)─▶ vault
                      authOrigin/approve     approval popup: the user reviews and approves every request
                      authOrigin/export      key export window
```

1. `createHana()` inserts a hidden iframe from Journear Passport's `vaultOrigin`. It answers only your allowed origins.
2. `hana.login()`, called in your click handler, opens Journear Passport's sign-in popup. The user picks a Google account
   (Google asks only for `openid`: no email, name or picture is requested or stored). The vault gets the token over
   an end-to-end encrypted relay, sends one NEAR transaction and decrypts the user's key.
3. A reload or a new tab within the session's limits restores the wallet with one API call and no transaction.
4. A signing call made in your click handler opens the Journear Passport approval popup in that click, as `login()` does. It shows
   the decoded request and the user approves it there. If the browser doesn't allow the popup (no click, or Safari
   after an `await`), the vault shows a small "Review in Journear Passport" button instead, which opens the same popup.
5. `hana.getIdentityToken()` gives your backend a short-lived signed token saying who the user is in your app, which
   wallets they hold and which session this is, verified against Journear Passport's published keys
   ([section 15](#15-identity-token-your-backend)).

The address depends on your app's **scope** and the user's Google account, never on the browser. The same user
gets the same addresses on every device, and different addresses in another partner's app.

## 1. Your app and the partner portal

During the pilot Journear creates your organisation and your apps, and you manage them in Journear Passport's **partner portal**
(sandbox-dev: `https://hana-id-console-sandbox-dev.tingtc.workers.dev`).

**What Journear needs from you**, for a test app:

- the Google address of each person who will manage it as an **owner** (up to 5), and at least one **security
  contact**: an address that gets the announcement of every change to your apps' origins and signing settings;
- the app name your users will see ("Signing in to {name} at {origin}"), and the origins your app runs on to start with
  (more can be added in the portal; [Allowed origins](#allowed-origins));
- nothing about Google clients: your scope starts on Journear's shared Google client. If you want your own
  ([section 6](#6-google-client-shared-or-your-own)), an on-chain owner adds it in the portal once the scope exists,
  with a sign-in on your client that proves it is yours; Hana never registers a client ID you send.

**App names.** The name is shown in Journear Passport's popups and sign-in emails next to Journear Passport's own words, so a few names are
refused (when an app is created or renamed, by Journear staff or on **Branding**):

- anything that looks like a web address: a name containing `://`, a word starting with `www.`, or a dot between a
  letter or digit and a letter (`example.com`, "Sign in at app.example"). "Dr. Wallet" and "v2.0" are fine;
- a name holding "Journear" (anywhere, even inside a word: "MyJournear"), "Passport Home" as words, or a word starting
  with "Hana" (the product's former name), in any case or spelling: accents, full-width letters, look-alike letters
  from other alphabets (a Cyrillic "Н" for H, for example), digits or symbols for letters ("H4na", "J0urnear"), or
  letters split by spaces or dots ("H a n a", "J.o.u.r.n.e.a.r"). "Hana" inside a word ("Johana") and "Passport" on its
  own are fine;
- as before, control, bidi, zero-width and other invisible characters, and names over 64 characters.

An app whose name was set before this rule keeps working, but its sign-in emails say "an app" instead of the name
until it is renamed.

**In this order:**

1. Journear invites your first owner. They open the invite email and **Sign in with Google to accept** (below). This comes
   first: Journear can set up your scope only once your owners have accepted, because their Google accounts become the
   scope's **on-chain owners** ([below](#on-chain-owners)).
2. Hana registers your scope on Journear Passport's contract with the owners you name (shared login), then creates your test app
   in it. An on-chain owner stays one even after leaving your organisation in the portal: removing them takes another
   on-chain owner's proposal and the contract's timelock ([below](#on-chain-owners)), so name only people who should
   hold that.
3. You receive the app's **publishable key** and **app id** (also in the portal, below) and the SDK's tarballs with
   their checksums ([section 2](#2-install)).
4. An on-chain owner adds any further origins and, if you want them, an auto-approve policy and your own Google client
   in the portal.

What you get, and where to find it again:

| What | Looks like | Where | Used by |
|---|---|---|---|
| Publishable key | `pk_test_…` (test app), `pk_live_…` (live app) | the app page's header, **Publishable key**, with a Copy button; all keys on its **Keys** tab | your page: `createHana({ publishableKey })` |
| App id | `app_…` | the app page's header, **App ID**, with a Copy button | your backend: the identity token's `aud` ([section 15](#15-identity-token-your-backend)) |
| Identity issuer and its key thumbprints | an `https://` URL; 43-character thumbprints | this guide, per environment ([section 15](#verify-it-node-jose)) | your backend: `iss` and the pins |

The publishable key is public: ship it in your page. Your origins are what protect it. The app id is not secret
either, but your page never sees it (the SDK takes only the publishable key), so copy it from the portal into your
backend's configuration; never take it from a token you are about to verify. A scope is test or live for good, so
test and live apps never share addresses.

<a id="on-chain-owners"></a>**On-chain owners.** Your scope lives on Journear Passport's contract, and its owners there are the
Google accounts that may change it: add origins to its apps, propose an auto-approve policy, turn raw signing on, add
a Google client, change its owners. The portal checks this with your **Confirm with Google** sign-in, so an owner in
the portal who isn't an on-chain owner sees, instead of those forms, one line naming the on-chain owners. Removing an
origin or the policy, turning raw signing off, suspending and revoking keys work for every owner. An owner invited
after your scope was set up becomes an on-chain owner like this: an on-chain owner opens the scope's page ("Google
clients and on-chain owners", linked from that line and from **Login & sessions**), which lists the owners missing on
chain, and clicks **Propose: set the on-chain owners to your organisation's owners** (confirmed with Google). The
change waits the contract's timelock, then any owner clicks **Execute** on the same page. A scope has at most 5
on-chain owners. If none of your owners is an on-chain owner, ask Journear.

### Signing in to the portal

There is no self sign-up. An owner of your organisation (or Journear, for the first one) invites your Google address as
an **Owner** or a **Viewer**. The invite email ("You're invited to {org} on Journear Passport") holds the link: open it and click
**Sign in with Google to accept**, with the Google account of the address it was sent to. A link works once, for that
address only, and expires after 7 days. After that, sign in at `{portal}/signin` with **Sign in with Google**.

A portal session lasts 12 hours, and ends after 2 hours without activity. Five minutes before the 12 hours are up a
banner offers **Sign in again**. If the session ends mid-task, the page keeps what you typed: sign in again in the new
tab the banner opens, come back and click **Try again**.

Owners change apps, keys and members; viewers see everything and change nothing (where a viewer can't act, the page
says why instead of showing the control). The changes that matter for security ask you to **Confirm with Google**: a
fresh Google sign-in, as the account you are signed in with, valid for 5 minutes.

### Your app's page

**Apps** lists your organisation's apps with their id, a **Test** or **Live** badge, their status and how many
changes are waiting. An app's page shows the **App ID** and the **Publishable key** in its header, each with a
**Copy** button, and has these tabs:

| Tab | What you do there |
|---|---|
| **Overview** | a getting-started checklist, and every change waiting to take effect, with **Cancel** |
| **Origins** | the allowed origins ([below](#allowed-origins)) |
| **Keys** | **Create a key** (at most 5 active), **Rotate** (you get a new key now; the old one keeps working 24 hours), **Revoke** (at once; a page already open notices within 30 s) |
| **Login & sessions** | persistence, the session and idle limits and the Google web client ([section 7](#7-app-settings)), confirmed with Google and in force at once; a link to your scope's page ("Google clients and on-chain owners") for your own Google client ([section 6](#6-google-client-shared-or-your-own)) |
| **Signing** | the auto-approve policy ([section 9](#9-auto-approve-policies)) and raw signing ([Raw signing](#raw-signing)) |
| **Branding** | the name users see in Journear Passport's popups and sign-in emails (up to 64 characters; see "App names" below), and your logo: PNG, JPEG or WebP, at most 512 KiB, 128 to 2048 px a side, nearly square, not animated; Journear Passport re-encodes it to a 256 × 256 PNG and shows it next to the name in its popups |
| **Suspend** | **Suspend the app** stops logins at once; **Resume** (confirmed with Google). A suspension by Journear only Journear can lift |

**Saving.** On **Login & sessions**, **Branding** and the Members page's Workspace domain, a bar appears at the first
change, counts the unsaved changes and offers **Discard** and **Save changes** (**Review and confirm with Google** where
the change needs a fresh Google sign-in). A field is checked when you leave it. A finished change is confirmed by a
short notice; a failed one is explained where you made it.

**Email login**: an owner turns it on from the app's **Email login** page in two steps, each confirmed with Google: first for the
app, then an on-chain owner of the scope adds the scope's email client, which waits the scope's timelock and is then
applied (any owner, from the same page). Turning it off for the app is one confirmation, at once. The page shows the
app's mail per day (sent, bounced, complaints, refusals), never an address ([section 4](#4-log-in-log-out), "Email login").

<a id="allowed-origins"></a>**Allowed origins.** The vault loads only on pages served from one of your app's origins,
compared exactly: scheme, host and port, no path (`http://localhost:5173` and `http://localhost:5174` are two origins,
and so are `http://localhost:5173` and `http://127.0.0.1:5173`). At most 20 per app. On the **Origins** tab:

- **Add**: on-chain owners ([above](#on-chain-owners)) type one origin per line, then **Review and confirm with Google**, review the change and
  **Confirm with Google**. Journear Passport then announces the change by email to your security contacts and to Journear (the notices
  go out within about 5 minutes), and the origin takes effect a fixed delay after that announcement: 60 s on
  sandbox-dev, 24 hours on a production network. The page shows each step ("Requested", "Announced by email", "Takes
  effect"). Two kinds of addition take effect as soon as they are announced, without the delay: a loopback origin
  (`http://localhost:<port>`, `http://127.0.0.1:<port>`, or the `http://localhost:*` wildcard, which allows every
  port) on a test app in a sandbox environment, and any origin while nobody has yet signed in to your app's scope.
- **Cancel** a waiting addition from **Origins waiting to take effect** (or the Overview), or with the cancel link in
  the announcement email (no sign-in needed). Cancelling is immediate, and Journear and your owners keep a record of it.
- **Remove** takes effect at once and signs out the users who signed in on that origin; a tab of theirs already open
  there can't sign after a minute or two and then shows signed out.
- Live apps must use `https://` and can't use loopback origins. Wildcard hosts, IP addresses (other than loopback for
  test apps) and Journear Passport's own origins are refused ("A Journear origin can't be an app's origin").

**Members.** On **Members**, owners **Invite** an address as viewer or owner (**Review and confirm with Google**); the
invite email goes out after Journear Passport has notified every owner and your security contacts, and a new owner in an
organisation that has one already stays a viewer for a delay first (60 s on sandbox-dev, 24 hours on a production
network; **Cancel** under "Pending owners" keeps them a viewer). There is no link to copy: invites travel by email
only. At most 10 open invites; **Revoke** stops one at once. **Make owner**, **Make viewer** and **Remove** need a
Google confirmation, and the last owner can't be removed. An owner can also require every member to sign in with an
address of your Google Workspace domain. Your security contacts are set by Journear: ask Journear to change them.

**Reports.** **Usage** shows logins, unlocks, identity tokens, active and new users, failures by code and costs, by
day or month. **Statements** ("Journear Passport usage statement {month}") are monthly (from the 3rd of the next
month), as CSV, PDF and the ledger CSV, with their SHA-256; a row "Passport Home logins" counts your users opening
their wallet from Passport Home, each billed at its gas like a login. **Users** (where Journear has turned it on) finds a user by wallet address (Stellar, EVM or a NEAR account), User
ID (`u1_…`) or Support ID (`HANA-…`); it shows a user's email address or name only once the user shared it with one of your apps. **Audit** lists everything done in your organisation, with a request ID to
quote to Journear. **Pending upgrades** shows changes queued on Journear Passport's contract that affect you.

If Journear freezes your organisation (a security response), only cancels and kill switches still work: removing an
origin, removing the policy, turning raw signing off, suspending, revoking a key or an invite.

## 2. Install

The packages are not on a registry yet (`@hana-id/*` is the reserved scope). Journear sends you the four tarballs of one
release with their SHA-256 checksums: check them (`shasum -a 256 *.tgz`), then install them together with npm, pnpm
or yarn. Install every package you use, `@hana-id/core` included, from its tarball, never from a registry:

```sh
npm install ./hana-id-core-0.4.1.tgz ./hana-id-web-0.4.1.tgz              # always
npm install ./hana-id-react-0.4.1.tgz                                      # React apps
npm install ./hana-id-sodax-0.4.1.tgz @sodax/types@2.2.0                   # Sodax adapters
```

Commit the tarballs to your repository (or a private artifact store) and depend on them by path
(`"@hana-id/web": "file:vendor/hana-id-web-0.4.1.tgz"`), so every install gets the same bytes.

| Package | What | Peer dependencies (tested) |
|---|---|---|
| `@hana-id/core` | Shared core; a dependency of the others. `@hana-id/core/policy` validates auto-approve policies; `supportIdFromSub` (SDK releases after 0.2.0, section 15) | |
| `@hana-id/web` | `createHana`, the EIP-1193 provider, the Stellar signer, the NEAR signer (0.4.0); `@hana-id/web/stellar-wallets-kit` for SWK | |
| `@hana-id/react` | `HanaProvider`, `useHana`, `useWallet` | `react` `^18 \|\| ^19` (18.3.1, 19.3.1) |
| `@hana-id/sodax` | Optional Sodax wallet-provider adapters | `@sodax/types`: the version your `@sodax/sdk` depends on (`@sodax/sdk` 2.2.0 pins 2.2.0), so there is one copy; types only. Tested with 2.2.0 (SDK releases after 0.2.0; 0.2.0 was typed against 2.1.0) |

They are ESM with TypeScript declarations and source maps. Use a bundler (Vite, webpack, esbuild, Next.js) or
TypeScript `moduleResolution` `bundler`, `node16` or `nodenext`. The `@hana-id/core/signers/stellar` and
`/decode` declarations reference Node's `Buffer` through `@stellar/stellar-base`: if you import those, add
`@types/node` or keep `skipLibCheck`. Each package carries a README with these steps. Each release is checked by
installing the tarballs into a fresh project outside Journear's repository, type-checking and importing them there.

**Environments are built in.** `@hana-id/web` contains the configuration of every Journear Passport deployment it was released
for (Journear Passport origins, NEAR accounts, RPC, pinned MPC key; all public values), and you pick one by name with
`createHana({ environment })`. `HANA_ENVIRONMENTS` lists the names. A release ships exactly the deployed envs; this
pilot ships `sandbox-dev`, whose Journear Passport side runs on NEAR testnet (your users' wallets are Stellar, EVM and NEAR; see the note
at the top). A new environment means a new release.

### Release notes

**0.4.1** (after 0.4.0; same environments: `sandbox-dev`). **Nothing to change** unless you find Journear Passport's
wallet by its display name: code written for 0.4.0 builds and runs as it is. Replace all the tarballs you use together
(they depend on each other at `^0.4.1`).

- The product is now called Journear Passport. The wallet pickers' name (EIP-6963 `info.name`, the Stellar Wallets
  Kit's `productName`) is "Journear Passport" (was "Hana ID"), and the SDK's error messages and the launcher's labels
  say Journear Passport. Package names, the API (`createHana`, `HanaError`, `hana.*`), error codes, events, `rdns` and
  `productId` are unchanged: if you pick the connector by name, match the new name, or better its `rdns`; match errors
  on `code`, never on the message.
- New: `hana.getProfile()`, `hana.profile`, the
  `profileChanged` event and React `useProfile()`, for the name a user chose to share with your app
  ([section 15](#15-identity-token-your-backend), "The user's name"). The identity token's `given_name` and `family_name`
  claims arrive from Journear's side, so they reach any SDK version.
- A refused `hana.near.relay` or `activate` also passes on the transaction the relay sent (`data.transactionHash`, so a
  `timeout` can be looked up), NEAR's own reason for a `delegate_rejected` (`data.nearReason`) and the API's
  `retry-after` (`data.retryAfterS`); new type `NearRelayErrorData` ([section 8, NEAR](#near-errors)).
- The wallet-picker icon (`HANA_ID_ICON`: EIP-6963's `info.icon`, the Stellar Wallets Kit's `productIcon`) is Journear's
  new mark; still a 96 × 96 SVG `data:` URI, the same name and format.

**0.4.0** (after 0.3.1; same environments: `sandbox-dev`). **Nothing to change** for Stellar and EVM: code written for
0.3.x builds and runs as it is, and an app still on 0.3.x keeps working with Journear Passport's current vault (it just doesn't see
NEAR). Replace all the tarballs you use together (they depend on each other at `^0.4.0`).

- **A NEAR wallet.** `hana.near`: `accountId` and `publicKey` (the user's implicit account), `signTransaction`,
  `signDelegateAction` (NEP-366, gasless with `relay`), `signMessage` (NEP-413), `relay` and `activate` (creates a new
  account on testnet for its first gasless call); `hana.addresses.near`.
  Every NEAR request shows Journear Passport's approval window, none is signed automatically ([section 8, NEAR](#near)).
- `hana.exportKey('near')` exports the NEAR key as `ed25519:…`.
- `HanaAddresses.near` is optional in the types: it is missing only while Journear Passport's vault is older than this SDK (during a
  deployment), and `hana.near` then refuses requests with 4100. New types: `NearSignTransactionParams`,
  `NearSignDelegateActionParams`, `NearSignMessageParams`, `NearRelayParams` and their results, `NearNetwork`.
- A test app signs NEAR testnet only (4100 `mainnet_not_allowed`); new refusal reasons `near_block_unknown`,
  `near_network_mismatch`, `near_relayed_delegate`, `near_key_unknown`, `near_delegate_nonce_used`,
  `near_delegate_nonce_stale`, `near_delegate_nonce_too_large`, `near_delegate_expiry`, `near_delegate_test_app_action`,
  `near_delegate_test_app_receiver` and (with `api_unavailable`) `near_rpc_unavailable` and `near_rpc_single_provider`;
  `relay` and `activate` pass on the API's codes in `data.reason` ([section 8, NEAR](#near-errors)).
  `@hana-id/core/near` builds NEAR's bytes (`encodeNearDelegateAction`, `encodeNearTransaction`, …) and picks a
  delegate action's nonce (`nearDelegateNonce`).
- Journear Passport's relay (gasless calls, testnet) sends only zero-deposit function calls to the receivers Journear allowlists; ask
  Journear to add your contract ([section 8, NEAR](#near-relay)).
- Not yet NEAR: auto-approve policies (every NEAR request asks the user), the identity token's `wallets` (still
  Stellar and EVM; prove a NEAR account with `hana.near.signMessage`) and the React hooks (use
  `useHana().client.near`). The partner portal's Users page and Passport Home show a user's NEAR account once they sign
  in through SDK 0.4.0; Passport Home's "Move this wallet" offers the NEAR key too.

**Upgrading from 0.3.1 to 0.4.0:**

1. Replace the four tarballs (or the ones you use) together, and check them against the new `SHA256SUMS`.
2. If you use NEAR's gasless calls, add Journear Passport's API origin to your CSP `connect-src` (sandbox-dev:
   `https://hana-id-api-sandbox-dev.tingtc.workers.dev`; [section 5](#5-your-page-origins-csp-popups)).
3. `hana.addresses`, `login()`'s result and `accountsChanged` now carry a third key, `near`, for a user who signs in
   through 0.4.0. Code that reads `stellar` and `evm` is unaffected; code that checks the object's keys exactly, or
   stores it whole, should expect `near` (optional in the types: it is missing while Journear Passport's vault predates NEAR).
4. Nothing else: the Stellar and EVM calls, the identity token and the auto-approve policies behave as in 0.3.1.


**0.3.1** (after 0.3.0; same environments: `sandbox-dev`). **Nothing to change**: code written for 0.3.0 builds and
runs as it is. Replace all the tarballs you use together (they depend on each other at `^0.3.1`).

- `disconnect` now says when Journear Passport signed this device out: `{ code: 4900, reason: 'signed_out' }` (the user signed the
  device out from Journear Passport's own page, used `revokeOtherDevices()` on another device, signed in to your app again in
  another tab of this device, or your app's settings ended the session). The vault is fine: you may want to show
  "You were signed out, log in again" for it rather than a reload message ([section 3](#3-create-the-client)).
  Without `reason`, `disconnect` means what it did before. New types: `HanaDisconnect` (the event) and
  `DisconnectReason`.
- `launcher` now has `clickable`: `true` for Journear Passport's button the user must click ("Review in Journear Passport", "Sign in with
  Journear Passport", an export), `false` for the short "Signed by Journear Passport under …" notice after an auto-signed request and whenever
  it is hidden. If you point users at the button, do it only when `visible && clickable`
  ([section 5](#5-your-page-origins-csp-popups)).
- The mainnet demo's refusal reasons include `mainnet_demo_wrong_destination` in the types (a Sodax deposit, bridge or
  swap that would send funds anywhere but the user's own wallets, [section 12](#12-test-and-live-keys)).
- `@hana-id/core` also exports what Journear Passport's own pages use (`evmChainInfo`, `KNOWN_EVM_MAINNETS`, the
  `@hana-id/core/home` layouts); your app needs none of them.

Arrived from Journear Passport's side with every SDK release, no upgrade needed: an open tab of your app that was signed out from
Journear Passport's own page ends its session within about a minute while it is in use, and the vault checks again before each
signature you ask the user to approve and each cached identity token ([section 4](#4-log-in-log-out), "Signed out
from Journear Passport"); a request refused for that rejects with 4900 and `data.reason: 'signed_out'` (show the same signed-out
notice for it).

### Testnet quick start (Sodax)

**Sodax has no testnet.** Its hub is Sonic mainnet and every Sodax chain is a mainnet, while a test app signs for test
networks only. So with a test key you can integrate everything around the swap, but no Sodax swap, deposit or bridge
completes until Journear Passport's mainnet launch (live keys). What works today:

| | With a test key (`pk_test_…`) |
|---|---|
| Sodax quotes, and building an intent with `createIntent({ raw: true })` | yes: read-only calls against mainnet, nothing signed |
| The adapters' signing, sending and receipts | yes, with ordinary testnet transactions (Base Sepolia, Stellar testnet, …) |
| Signing a Sodax transaction (any mainnet chain) | no: `4100` `mainnet_not_allowed` ([section 12](#12-test-and-live-keys)) |

(Journear runs a mainnet demo of its own on sandbox under an internal exception; it is Journear-internal demo only, not
available to partner apps.)

1. Get a **test app** on `sandbox-dev` ([section 1](#1-your-app-and-the-partner-portal)), with the **shared Google
   client** (nothing to set up in Google Cloud), and add your origins in the portal: each exact origin your app runs on
   (`https://app.example.com`, staging, previews) plus `http://localhost:<port>` for development. Copy the publishable
   key `pk_test_…` from the app's page.
2. Install the tarballs above (web, core, react if you use React, sodax and the `@sodax/types` your `@sodax/sdk` uses).
3. Allow `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` in your CSP `frame-src`, and your RPCs in
   `connect-src` ([section 5](#5-your-page-origins-csp-popups)).
4. Create the client with `environment: 'sandbox-dev'`, and bind the adapters to test networks for the parts you can
   test end to end (the Stellar testnet, EVM testnets such as Base Sepolia (84532) or Sonic testnet (14601)):

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

   A test app may list mainnet chains in `evm.chains` too (`createHana` accepts them, and reads such as `eth_call`
   work there); only signing and switching to them are refused ([section 11](#11-sodax-adapter)).
5. Call `hana.login()` from a click; quote and build intents with Sodax; send testnet transactions through the
   adapters. Sodax's own mainnet swaps through Journear Passport wait for live keys.

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
hana.addresses;   // { stellar: 'G…', evm: '0x…', near: '6e5e…' } or null
hana.supportId;   // 'HANA-XXXX-XXXX' while logged in, or null (section 4, "Support ID")
```

Create one client per page and keep it. `hana.destroy()` removes the iframe and its listeners (for example on an SPA
unmount).

RPC, Horizon and Soroban RPC URLs (`evm.chains[].rpcUrl`, `stellar.horizonUrl`, `stellar.sorobanRpcUrl`, and the
Sodax adapters' `rpcUrl`, `horizonUrl`, `sorobanRpcUrl`) must be `https://` for a `pk_live_` key; plaintext `http://`
is accepted only on `localhost` and other loopback hosts (a local node), and for `pk_test_` keys anywhere. URLs with
credentials (`https://user:key@…`) are refused for every key. `hana.testApp` says which rule applies.

`environment` names the Journear Passport deployment. The client takes the Journear Passport origins from its own build, so no configuration
can point it at another vault. `sandbox-dev` (testnet) uses:

| | Origin |
|---|---|
| `vaultOrigin` | `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` |
| `authOrigin` | `https://hana-id-auth-sandbox-dev.tingtc.workers.dev` |

Events:

```ts
hana.on('statusChanged', (status) => {});
hana.on('accountsChanged', (addresses) => {}); // { stellar, evm, near } or null
hana.on('sessionExpired', () => {});            // the session reached its limit: log in again
hana.on('disconnect', ({ code, reason }) => {}); // 4900; reason 'signed_out': Hana signed this device out (log in again), else the vault is gone
hana.on('loginProgress', ({ stage }) => {});    // 'popup_connected' | 'google' | 'email_code' | 'token' | 'linking' | 'chain' | 'key_pending' | 'done'
hana.on('launcher', ({ visible, label, clickable }) => {}); // Hana's button or notice is shown or hidden; clickable: the user must click it ("Review in Journear Passport", …)
hana.on('autoApproved', ({ kind, chain, contract, function: fn }) => {});
hana.on('persistenceChanged', (persistence) => {}); // 'none': this login won't survive a reload (see "Sessions")
hana.on('linkChanged', ({ provider, status, effectiveAtMs }) => {}); // a sign-in method added, activated or removed (section 4)
hana.on('supportIdChanged', (supportId) => {}); // 'HANA-XXXX-XXXX' or null (section 4, "Support ID")
```

`disconnect` is always code 4900. With `reason: 'signed_out'` (SDK 0.3.1 or later) Journear Passport ended this device's
session: the user signed the device out from Journear Passport's own page, or used "log out other devices"
(`revokeOtherDevices()`) on another device, or signed in to your app again in another tab of this device, or your
app's settings ended it (persistence turned off, the origin removed). The vault is fine: show "You were signed out,
log in again", not "reload". Without `reason` the vault doesn't say why: the vault connection may be gone (then
`hana.status` is `'error'`: reload, or create the client again), or the session ended another way (another tab of your
app logged out, the session expired on Journear Passport's side, a stored session that couldn't be opened, a tab of an older Journear Passport
build ended it). When `hana.status` is `'logged_out'`, the vault is fine and a new login is all that's needed. The
request that was waiting when it happened (a signature, an export) rejects with 4900 and the same `data.reason:
'signed_out'`, so show one message for both. Your own `logout()` sends no `disconnect` (only `accountsChanged` with
null).

`loginProgress: key_pending` means Google has just started signing with a new key that Journear Passport hasn't activated yet
(it goes live within minutes): the vault waits up to 30 s and tries once more, then reports `chain` again. Show
something like "Google just rotated its signing key; finishing in a few seconds". If the retry is refused too, the
login rejects with `api_unavailable`; ask the user to sign in again in a few minutes.

`hana.ready` rejects with `vault_unavailable` when the vault doesn't load. The SDK gives the vault frame 5 s to answer
(the vault says `connected` as soon as it has checked your page). A frame still loading at 5 s gets 5 s more; a frame
that loaded but didn't answer within 1.5 s of loading is replaced once (SDK releases after 0.2.0; 0.2.0 waits the full
5 s). A vault that answered then has 20 s to finish starting (restoring a session waits on one Journear Passport API call). On any
failure the SDK removes the frame. `error.data.reason` says which part failed:

| `data.reason` | What happened | Usually |
|---|---|---|
| `csp_frame_src` | your page's CSP blocked the frame (detected at once, no retry) | `frame-src` ([section 5](#5-your-page-origins-csp-popups)) |
| `no_answer` | the frame loaded but the vault never answered, in either of two frames; `data.origin` and the message name the page origin that was checked (SDK releases after 0.2.0) | your page's origin (or a page framing it) isn't exactly one of your app's allowed origins (often a dev server that moved to another port), or the key is unknown or suspended: the vault page refuses to be framed and says nothing, by design |
| `frame_timeout` | the frame didn't load within 10 s | the network, or Journear Passport's page Workers slow to answer |
| `ready_timeout` | the vault answered but didn't finish starting within 20 s | the Journear Passport API slow or unreachable |
| `frame_replaced` | something navigated the vault frame before it was ready | another script on your page |

`data.attempts` is how many frames were tried. `hana.readyTimings` (test apps) has a `retry` stage when the second
frame was used. A page whose origin isn't one of your app's origins, or an unknown or suspended key, fails with
`no_answer` about 3 s after the client is created (two frames, each given 1.5 s after it loads; about 10 s with SDK
0.2.0). Journear Passport can't tell your page which of these it was (the vault refuses without saying why, so that a framing page
learns nothing about a key or an origin), so check the origin first: `data.origin` against the app's **Origins** tab.

**Dev servers that change port.** Vite (and most dev servers) moves to the next free port when its own is taken, and
`http://localhost:5174` is not `http://localhost:5173`: the page then runs on an origin your app doesn't allow. Pin the
port so a busy one fails loudly instead, and allow exactly that origin (or, for a test app, the `http://localhost:*`
wildcard):

```ts
// vite.config.ts
export default defineConfig({ server: { port: 5173, strictPort: true } });
```

Also check that `localhost` reaches your server: a server listening on IPv6 only (`[::1]:5173`) answers a browser's
`localhost:5173` before one on `127.0.0.1:5173`, so another process can hold "your" origin.

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
  still allows popups. If the browser blocks it anyway, the vault shows a "Sign in with Journear Passport" button (bottom right)
  and the call resolves once the user clicks it and signs in. That costs the user one more click.
- Already logged in: `login()` resolves at once. A second `login()` while one is pending replaces it (the first
  rejects with `login_cancelled`). `hana.cancelLogin()` ends a pending one.
- **A closed popup**. A user who closes the Journear Passport popup while it waits for them (the method chooser, Google's
  page, the email step, a linking screen) ends the sign-in: within about 2 seconds `login()` rejects with
  `login_cancelled` and `data.reason: 'popup_closed'`, and the status is `logged_out` again. Going to Google and back
  is never a close, and a slow popup is never cancelled. One exception to "within about 2 seconds": a popup closed
  within a few seconds of reaching Google's page. Journear Passport can't tell that close from an identity provider's
  Cross-Origin-Opener-Policy switching the window, so it waits up to about 90 seconds for the sign-in to finish
  there; if it doesn't, `login()` rejects with the same `login_cancelled` and `data.reason: 'popup_closed'`. A popup
  closed while Journear Passport finishes on its own (the NEAR transaction after Google) doesn't stop the sign-in: `login()`
  resolves as usual. A popup closed before it connected
  is `coop_blocks_popup` at once; one that never connects is `login_timeout` with `data.stage: 'connect'` after 15 s.
- **An unfinished login.** A user who leaves the popup open without finishing leaves `login()` pending. Keep the page
  usable meanwhile (`status` is `logging_in`; offer a Cancel that calls `cancelLogin()`). After 5 minutes the vault
  ends it: `login()` rejects with `login_timeout` and `data.stage: 'pending'`. (A popup closed within a few seconds of
  reaching Google's page ends sooner, in about 90 seconds, with `login_cancelled`: "A closed popup" above.)
- A first login takes several seconds after the Google account choice (one NEAR transaction plus the MPC; estimated
  6.5–7 s, to be measured on testnet). Show progress with `loginProgress`. A reload needs one API call (estimated
  0.1–0.3 s).
- **Sessions.** With the default `'session'` persistence the wallet survives reloads and new tabs for up to 12 h,
  or until it has been idle for 2 h. Then `sessionExpired` fires and the user signs in again. An open tab that sends
  the vault no request that uses the key (a signature, an export, revoking other devices, an auto-approve consent
  request) for the idle limit drops its key from memory; polling status or addresses doesn't count. Your page sees
  nothing (status, addresses and auto-approve status keep answering), and the next request that uses the key restores
  it with one API call, as a reload does, while the session is still alive on Journear Passport's side. With `'none'`, every page
  load is a new login. If the browser blocks storage (some private modes), the vault falls back to `'none'` and
  `hana.warning` is `storage_unavailable`. `login()` resolves as soon as the wallet is ready; the vault then saves
  the session for reloads in the background (one API call). If that fails, the wallet keeps working in this tab,
  `hana.persistence` becomes `'none'` (with a `persistenceChanged` event; `useHana()` re-renders), and the next page
  load needs a new login; a reload within that moment after `login()` resolved is a new login too.
- **Signed out from Journear Passport.** A user can sign a device out of your app from Journear Passport's own page (for a lost or stolen
  device). A tab of your app already open there can't sign after about a minute, and ends its session within about a
  minute while it is shown and in use (a few minutes in a tab nobody is using, at once when a hidden tab is shown
  again, or at its next signature or identity-token request): your page gets `accountsChanged` with no addresses and
  `disconnect` (code 4900, `reason: 'signed_out'` in SDK 0.3.1 or later), then shows signed out; tell the user
  to log in again, no reload is needed. A signature waiting for approval in that moment rejects with 4900 and
  `data.reason: 'signed_out'` (with every SDK release: it comes from the vault). To do this the vault asks Journear Passport's
  API about once a minute while a wallet is open in a shown tab in use, every 5 minutes when nothing happens there, and
  before each signature you ask the user to approve and each cached identity token. If Journear Passport's API can't be reached for
  more than 3 minutes, such a request fails with `api_unavailable` and `data.reason: 'share_unconfirmed'` before any
  popup; the user stays signed in, and the same request works again once the API answers. With `'none'` there is no
  device to sign out (each page load is its own login).
- **Email login** (off until an owner turns it on for your app in the portal, [section 1](#1-your-app-and-the-partner-portal)). With email on,
  `hana.login()` shows a chooser in the Journear Passport popup: "Continue with Google" or "Continue with email". The email path
  asks for the address, mails a 6-digit code, and the user types it into the same Journear Passport popup (never into your page).
  To skip the chooser, pass the method; to prefill the address you already know, pass `emailHint`:

  ```ts
  await hana.login({ method: 'email', emailHint: 'ada@example.com' }); // or { method: 'google' }; still in the click
  ```

  One person, one wallet: Google and email with the same verified address open the **same** wallet (automatic
  linking; [Sign-in methods](#sign-in-methods-and-links) below). In React, `useHana().login({ method: 'email' })` takes
  the same options (SDK releases after 0.2.0, [section 10](#10-react)). A method your app doesn't
  offer rejects with `login_method_unavailable`; bad options reject with `-32602` before any popup opens.
  `loginProgress` adds `email_code` (the code was sent) and `linking` (this login joins two sign-in methods); with
  email on, `google` fires only when the user goes to Google. The popup handles wrong and expired codes, "Resend code"
  and "Use a different email" itself; if the user then cancels, `login()` rejects with `code_invalid`,
  `challenge_expired`, `rate_limited` or `login_cancelled`. Your page never sees the address unless you passed it.
- <a id="sign-in-methods-and-links"></a>**Sign-in methods and links** (an app with email). What the user sees, by
  case (Journear Passport decides every case; your page only sees the result):

  | The user… | They see | Result |
  |---|---|---|
  | signs in with Google, and an email wallet exists for that Gmail address (or a Workspace address Google hosts) | nothing extra; the popup may show "Your Google sign-in now opens this wallet too" | the email wallet's addresses; Google is linked at once |
  | signs in with Google, and an email wallet exists for an address Google doesn't host | "This email already has a wallet": **Link and continue** (a code to `a…@domain`) or **Sign in with email** | the email wallet either way; linked only after the code |
  | signs in with email, and a Google wallet exists for that address | "This email belongs to a wallet you created by signing in with Google": **Link and continue** or **Sign in with Google**, then Google | the Google wallet's addresses; the email joins it at once (Google-hosted) or after 24 h (other addresses: a pending banner with **Cancel this link**) |
  | has neither wallet | the usual sign-in | a new wallet for that method |
  | signs in with Google for the first time with this Google client | Google's one sign-in screen, which also lists "Email address" (Journear Passport asks for it there); a returning user sees only Google's account chooser | as above |
  | cancels that Google screen | the Journear Passport popup goes back to its chooser: "Google sign-in was cancelled.", with **Continue with Google** and **Continue with email** (only **Continue with Google** when you called `hana.login({ method: 'google' })`; or, if the Google step started from "This email belongs to a wallet you created by signing in with Google", that screen's choices again) | `login()` keeps waiting: Google again or email signs in as usual; closing the popup there rejects with `login_cancelled`, never `google_error` |
  | signs in with Google, has no wallet yet, and Google's answers name two different Google accounts | **Sign in with email instead** or **Try Google again** (Google's "share your email address" for the account they signed in with) | an email wallet, or Google again; Cancel rejects with `login_cancelled` (`data.reason: 'google_account_mismatch'`, or `'email_consent_declined'` after declining that screen) |

  Nobody ever gets a second wallet for the same verified address. While a link is pending, signing in with the
  pending method fails with `link_pending` (`data.effectiveAtMs`: when it opens the wallet). The user can cancel it
  from the Journear Passport popup's banner at their next sign-in.
  - `await hana.account()` → `{methods: [{provider: 'google' | 'email', status: 'active' | 'pending', effectiveAtMs,
    root}]}`: the wallet's own method (`root: true`) and the ones linked to it. No identifiers, no addresses. Calls
    within 5 s of a read share it (the vault reads afresh after a login, a link or a banner's action). **Show
    pending methods to the user** ("An email will be able to open this wallet from …") and tell them to sign in to
    cancel it if it isn't theirs: the mailbox of a pending email may be an attacker's.
  - `hana.on('linkChanged', ({provider, status, effectiveAtMs}) => …)`: a method was added (`pending` or `active`),
    became active, or was `removed`. It fires after a login that linked, at the first `account()` call of a session
    for each pending method, and whenever `account()` sees a change.
  - `await hana.linkAccount({ method: 'google' | 'email' })`, in a click like `login()`: adds a sign-in method with
    another address (a second Google account, a work email). The Journear Passport popup signs in the new method, then the
    wallet's own; the link opens the wallet after 24 h (`{provider, status: 'pending', effectiveAtMs}`). It rejects
    with `link_refused` (`data.reason`: `provider_taken`, `account_full`, `already_linked`, `has_wallet` when that
    method already opened a wallet of its own, `links_unavailable`) before any transaction.
- <a id="support-id"></a>**Support ID** (SDK 0.2.0 or later). While a user is logged in,
  `hana.supportId` is their Support ID, `HANA-XXXX-XXXX` (`useHana().supportId` in React; `supportIdChanged` when it
  changes; null when logged out). It is the short form of the identity token's `sub` (section 15), so it is the same
  in every app of your scope and for every sign-in method of the user's account, and your backend can compute it from
  the `sub` it stores (`supportIdFromSub`, [section 15](#15-identity-token-your-backend)). It carries no address, email or Google account, and it isn't a credential: Journear's staff change
  nothing on a code alone. Show it where your users look for help, put it in your diagnostics, and give it to Journear
  when you escalate, with the error `code`, its request ID (`error.requestId`, section 13), when it happened and the
  app; Journear's support finds the user, their logins and sessions by it, and a failed request by its request ID (Journear Passport
  keeps no user id on failed requests). The Journear Passport
  approval popup also shows it under the account line, so a user can read it out. It comes from Journear Passport's API with the
  session: `null` for a session saved before this release (until the user's next login) and on an environment that
  can't compute it. An SDK older than 0.2.0 never receives it (the vault gives older SDKs exactly the answers they
  know).
- `await hana.logout()` signs this app out on this device, in every tab. It sends no transaction.
- `await hana.revokeOtherDevices()` signs the user out of your app everywhere else. It works only within 5 min of a
  fresh login, so offer it right after one.
- `await hana.exportKey('stellar' | 'evm' | 'near')` lets the user take their key elsewhere. Journear Passport shows a button; the key
  appears only in a top-level Journear Passport window, after a fresh sign-in (Google, or, in an app with email, a new code to the
  user's email) and a typed confirmation, in three steps (Verify, Understand, Export), and never reaches your page. A wallet with linked methods exports its one
  shared key, whichever method the user signs in with; a pending method exports nothing. That window keeps the key for 5 minutes at most, and erases it as soon as the user's session in your
  app ends (`logout()`, revoke, expiry); exporting again starts over with a new sign-in. Stellar keys export as `S…`, EVM keys as `0x…` hex, NEAR keys as `ed25519:…` (SDK 0.4.0). There is no recovery phrase. Each export is a NEAR
  transaction Journear pays for, so one account can export at most 3 times an hour per app (`rate_limited` after that).
  A shown key hides again after 60 seconds. Continue, Show key and Copy key need the user's own deliberate click (the
  approval window's guard), and Show key and Copy key work only once the user has ticked a box saying no one can see
  their screen. Journear Passport records each export (user, app, chain, time; never the key) for its support staff.
  Offer an "Export private key" entry in your account screen that calls `exportKey`: export is how users keep their
  funds if Journear Passport's key service ever can't derive their key, so don't hide it. No SDK method returns a key.

## 5. Your page: origins, CSP, popups

| Requirement | If not met |
|---|---|
| The page's origin is one of your app's origins, exactly (scheme, host and port; pin your dev server's port, [section 3](#3-create-the-client)) | the vault doesn't load (`vault_unavailable`, `no_answer`) |
| CSP `frame-src` (or `child-src`/`default-src`) allows `vaultOrigin` | `vault_unavailable` at once (an enforced violation is detected; report-only is fine) |
| CSP `connect-src` allows your own EVM RPC (and Horizon / Soroban RPC for Sodax) | your RPC calls fail; the SDK calls them from your page |
| CSP `connect-src` allows Journear Passport's API origin (sandbox-dev: `https://hana-id-api-sandbox-dev.tingtc.workers.dev`) if you use `hana.near.relay` or `hana.near.activate`, and the NEAR RPC you read from | `api_unavailable` ("Journear’s relayer could not be reached"); the SDK calls the API from your page |
| Popups allowed for your site | the "Sign in with Journear Passport" button fallback (`popup_blocked` if you cancel) |
| `Cross-Origin-Opener-Policy` is not `same-origin` (`same-origin-allow-popups` and `unsafe-none` are fine) | `coop_blocks_popup` |
| Every page that frames yours is also one of your origins (`frame-ancestors` checks all ancestors) | `vault_unavailable` |
| `login()` and `eth_requestAccounts` run in a click | one extra click (the fallback button) |
| Signing calls run in a click, before any `await` (or after `hana.prepareApproval()`) | one extra click per signature (the "Review in Journear Passport" button) |

Not supported: Google Identity Services (the "Sign in with Google" button or One Tap) on the same page, which the
SDK warns about in the console; in-app browsers (Instagram, TikTok, … webviews), where Google refuses to sign in
(`disallowed_useragent`); pages with COOP `same-origin`. A page with `Cross-Origin-Embedder-Policy: require-corp` is
untested: the vault frame sends no COEP header, so such a page may refuse to embed it.

The vault's button (sign-in fallback, "Review in Journear Passport", export) is a fixed 320×72 px Journear Passport frame at the bottom right
of the viewport, dark in both colour schemes. Don't cover it: whenever the popup couldn't open in the click (and for every export), users can't
continue without it. The `launcher` event tells you when it
shows, if you want to point at it: prompt the user to click only when `visible && clickable`. The same frame also
shows short notices that need no click ("Signed by Journear Passport under {label}" for about 3 seconds after each auto-signed
request, section 9): those arrive with `clickable: false`. `clickable` is in SDK 0.3.1 or later; with 0.3.0 or
earlier the field is absent, and a notice can't be told from a button.

Removing an origin from your app signs out the users who signed in there.

## 6. Google client: shared or your own

| | Shared (default) | Your own |
|---|---|---|
| Setup on your side | none | a Web OAuth client in **your** Google Cloud project |
| Google's consent screen shows | Hana | your app |
| Who can obtain tokens that open your users' wallets | only Journear Passport's pages, for your origins | also anyone your client trusts (see below) |
| Addresses | the same in both modes, for the same scope and Google account | |

Both modes put users in your app's own scope, so another app never gets your users' keys. The path holds no client
ID, so you can start shared and move to your own client later without changing anyone's address. Google gives one
account the same `sub` across clients, both within one Google Cloud project and across two projects (tested with a
personal and a Workspace account).

**Your own client.** In Google Cloud console → APIs & Services → Credentials, create an OAuth client ID of type "Web
application":

- **Authorized redirect URIs**: exactly `{authOrigin}/login/callback`, and nothing else. For sandbox-dev that is
  `https://hana-id-auth-sandbox-dev.tingtc.workers.dev/login/callback`.
- **Authorized JavaScript origins**: none.
- On the OAuth consent screen, add Journear Passport's domain as an authorized domain.

Then add it to your scope: in the portal, an app's **Login & sessions** tab links to your scope's page ("Google
clients and on-chain owners"), whose **Add your own Google client** steps take a client proof: a helper page you
download, host on one of the client's origins and sign in on once, whose token becomes public on chain (use a team
account). The addition is timelocked by Journear Passport's contract. Return the client to the settings above (remove the helper's
redirect URI and origin) once the change is proposed. Only an on-chain owner can propose it
([section 1](#on-chain-owners)), and this is the only way to add one: Journear doesn't register a client ID you send,
because nothing would prove it is yours. Once your own client is in, an on-chain owner can turn Journear's shared login off
on the same page. The token's audience then picks your scope. If your scope also holds iOS or Android clients, which can't run Journear Passport's web flow, set the web one as the
app's **Google web client** on **Login & sessions**. A scope with a client of its own always signs in through it.

Journear can't see your Google client's settings. Any JavaScript origin, extra redirect URI or native app on your client
can obtain tokens for it with any nonce, and so derive your users' keys, so an XSS on one of those origins puts your
users' wallets at risk. Keep the client exactly as above, or use the shared client.

## 7. App settings

You set these per app in the partner portal: **Login & sessions** for the first three and the Google web client, **Signing** for raw signing and the policy ([section 1](#your-apps-page)):

| Setting | Values | Default |
|---|---|---|
| Persistence | `'session'` (the wallet survives reloads under a server-held share) or `'none'` (every page load logs in) | `'session'` |
| Session limit | 1 h to 23 h 50 min | 12 h |
| Idle limit | 15 min to the session limit | 2 h |
| Raw signing | `'off'` or `'approval'` | `'off'` |
| Auto-approve policy | none, or a policy ([section 9](#9-auto-approve-policies)) | none |
| Google web client | your scope's web client, when it has several | the first one |

Persistence, the limits and the Google web client take effect when you confirm them with Google. Loosening a signing
setting takes effect after a delay (24 h in production; 60 s on sandbox-dev), counted from when the change is
announced by email to your security contacts, as for an origin ([Allowed origins](#allowed-origins); you can cancel it
until then): raw signing `'approval'` (live apps only: a test app never signs raw), and setting or changing a policy. Tightening takes effect at once for new page loads: raw signing `'off'`, and removing a policy.
In a tab that is already open, a removed policy stops auto-signing within 10 s ([section 9](#9-auto-approve-policies)),
and raw signing `'off'` refuses raw requests within 10 s too (the vault re-reads the setting before each one).

## 8. Signing

Every signing request goes through the user. The Journear Passport popup decodes the request bytes itself, so your page can't
misdescribe them. It lists what the request does as labelled rows, with **Reject** and **Approve** below; a plain
transfer (EVM value with no call data on a chain it names, one native XLM payment or account creation, NEAR
transfers only) also leads with the amount ("Sends 0.001 ETH"), never a contract call or a token. The popup stays open for 15 s after an answer, so a follow-up request (`restoreFootprint`, a
re-sign, a trustline) appears there without another click. Meanwhile it says "Approved" or "Declined" and counts down,
with a Close now button. Each follow-up still needs its own Approve. Reject, closing the
popup, or 5 min without an answer gives `4001`.

**Call the SDK directly in your click handler**. Every signing method (`hana.stellar.sign*`, the Stellar
Wallets Kit module, `personal_sign`, `eth_signTypedData_v4`, `eth_signTransaction`, `eth_sendTransaction`,
`hana.near.sign*`, `hana.signRaw`, `hana.requestAutoApprove`, the Sodax adapters) opens the approval popup synchronously, the moment you
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
  its "Review in Journear Passport" button (bottom right) and the call resolves after the user clicks it and approves. The same
  happens when a popup blocker refuses the window.

The Approve button arms only after the request has been on screen for 1 s and the window has had focus for 1 s, then
a mouse move, a tap, or Tab or an arrow key. The gesture that arms it doesn't approve, so a tap-only user taps twice;
clicking in place without moving the mouse, Enter and Space never arm it. That stops clickjacking and double-click
tricks. Message and raw requests (`personal_sign`, `stellar_signMessage`, `signRaw`) carry a line that the signature
isn't tied to one network: they are valid wherever the key is. For a test app every request and consent screen also
says that Journear Passport signs only for test networks (for a test app with Journear's mainnet demo on, it says what the demo signs
instead). The consent screen names the EVM chains Journear Passport knows ("Sepolia (testnet)", with the chain ID beside it) and
gives native amounts their unit ("0.001 ETH"); a chain it doesn't know shows as its number.

### Stellar

```ts
const { address } = await hana.stellar.getAddress();           // logs in if needed (call it from a click)
const { signedTxXdr, signerAddress } = await hana.stellar.signTransaction(xdr, {
  networkPassphrase, // optional: defaults to createHana({ stellar })
  address,           // optional: must be the user's address (4100 otherwise)
});
const { signedAuthEntry } = await hana.stellar.signAuthEntry(preimageXdr); // base64, 64 bytes
const { signedMessage, signerAddress } = await hana.stellar.signMessage('hello'); // SEP-53, approval every time
await hana.stellar.getNetwork();                                          // from createHana({ stellar })
```

You build, simulate and submit transactions yourself. Journear Passport only signs. Fee-bump envelopes are signed as given.

**Stellar Wallets Kit** (1.9.x, which Sodax's `wallet-sdk-react` uses, and 2.x):

```ts
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';

const kit = new StellarWalletsKit({ network, modules: [new HanaIdModule(hana), ...otherModules] });
```

The module's `productId` is `'hana-id'`; the picker shows its `productName`, "Journear Passport", and the Journear mark. `isAvailable()` is true once the vault is up, `getAddress()` logs in when
needed (with the button fallback when SWK's own awaits cost the popup), the sign methods open the approval popup in
your click the same way, `disconnect()` is `hana.logout()`. Errors are
SWK's `{code, message, ext}`, with `4001` for a rejection and the Journear Passport code in `ext`. Journear Passport only signs, so
`submit: true` is refused.

### EVM (EIP-1193)

`hana.ethereum` is an EIP-1193 provider, announced through EIP-6963 as "Journear Passport" (`info.name`, with the
Journear mark as `info.icon`; `info.rdns` is unchanged) when you pass `evm` to `createHana`:

```ts
// viem
const wallet = createWalletClient({ chain: baseSepolia, transport: custom(hana.ethereum) });
// ethers
const provider = new BrowserProvider(hana.ethereum);
// wagmi: the injected connector discovers it through EIP-6963 (name "Journear Passport")
```

| Method | Behaviour |
|---|---|
| `eth_requestAccounts` | logs in if needed (from a click; the button fallback otherwise) |
| `eth_accounts` | `[address]` or `[]` |
| `eth_chainId`, `wallet_switchEthereumChain`, `wallet_addEthereumChain` | among `evm.chains`; another chain is `4902`. A test app switching to or adding a mainnet chain gets `4100` (`data.reason: 'mainnet_not_allowed'`) |
| `eth_sendTransaction` | the SDK fills nonce, gas and fees from your RPC, the user approves, and the SDK broadcasts through the RPC of the chain it was filled on (even if the chain is switched during the approval). Sends run one at a time per chain, and a filled nonce is never below one past the last one this page broadcast, so back-to-back sends get consecutive nonces |
| `eth_signTransaction` | the SDK fills a missing nonce, gas and fees from your RPC as for `eth_sendTransaction` (fields you set are kept as given; a `chainId` must be the current chain), the user approves, and you get the signed raw transaction; nothing is broadcast. It isn't queued with sends, and its nonce comes from the RPC's `pending` count (never below one past this page's last `eth_sendTransaction`), so set `nonce` yourself when you sign several before broadcasting them |
| `personal_sign`, `eth_signTypedData_v4` | approval |
| `eth_sign` and other signing or wallet methods | `4200` |
| read-only methods (`eth_call`, `eth_getBalance`, …) | forwarded to the current chain's `rpcUrl` |
| `eth_sendRawTransaction` | forwarded to the current chain's `rpcUrl` (it broadcasts a transaction you already hold signed; Journear Passport signs nothing) |

The RPC you configure is trusted for liveness and ordering: it fills fees and nonces, answers reads and broadcasts,
so use a provider you trust, over https (required for `pk_live_` keys). The hash `eth_sendTransaction` returns is the
one your RPC reports.

One key covers every EVM chain. Contract creation (an empty `to`) works with approval, but no policy ever
auto-approves it. Errors are `ProviderRpcError` with numeric codes. A sign-in that didn't complete is `4001`, and the
Journear Passport code is in `error.data.code`. Logging out emits `accountsChanged []`, as wallets do.

### NEAR

SDK 0.4.0 or later. **What the user gets:** one NEAR account per user in your app's scope, next to their Stellar and
EVM addresses and from the same login. It is an **implicit account**: its id is the 64 lowercase hex characters of its
Ed25519 public key. Like the other addresses it is the same on every device, different in another partner's app, and
different between your test and live apps. It starts with no NEAR, and it exists on chain only once something creates
it (an implicit account is created by its first transfer). The user needs no NEAR to start: Journear Passport's relay creates the
account and pays the gas of gasless calls ([Journear Passport's relay](#near-relay)). Only an ordinary transaction needs NEAR in
the account, for its gas.

```ts
hana.near.accountId;   // '6e5e4e30…f35000ab' (64 hex), or null while logged out
hana.near.publicKey;   // 'ed25519:8RqFZBso…', or null
hana.addresses;        // { stellar, evm, near } while logged in, else null
```

`hana.near.accountId` is `hana.addresses.near`. Both are missing (`null`, and no `near` key) only while Journear Passport's vault is
older than the SDK, during a deployment; every `hana.near` call then rejects with `4100`.

| Call | What | Popup | Resolves |
|---|---|---|---|
| `hana.near.signDelegateAction({ network, delegateAction })` | signs a NEP-366 delegate action (a meta transaction: someone else sends it and pays the gas) | yes | `{ signature, signedDelegateAction }` |
| `hana.near.relay({ network: 'testnet', signedDelegateAction })` | sends a signed delegate action through Journear Passport's relay, which pays the gas | no | `{ transactionHash, status: 'executed' }` |
| `hana.near.activate()` | creates the user's account on testnet if it doesn't exist yet | no | `{ created, accountId, accessKeyNonce?, blockHeight?, transactionHash? }` |
| `hana.near.signTransaction({ network, transaction })` | signs an ordinary transaction, which the account pays for | yes | `{ signature, signedTransaction, hash }` |
| `hana.near.signMessage({ message, recipient, nonce, callbackUrl? })` | signs a NEP-413 message ("sign in with NEAR") | yes | `{ accountId, publicKey, signature }` |

Every signature needs the user's Approve in Journear Passport's window: **no NEAR request is ever signed automatically**, and no
auto-approve policy covers NEAR. Call the three sign methods in your click handler before any `await`, like the other
signing methods ([above](#8-signing)). Bytes go in as a `Uint8Array` or its standard base64, and come back as base64.
`network` is `'testnet'` or `'mainnet'`: NEAR's bytes name no network, so you say which one and Journear Passport checks it
(below). A test app signs for testnet only (`4100`, `data.reason: 'mainnet_not_allowed'`).

**Your page's CSP.** `relay` and `activate` call Journear Passport's API from your page: allow its origin in `connect-src`
(sandbox-dev: `https://hana-id-api-sandbox-dev.tingtc.workers.dev`), with the NEAR RPC you read from
([section 5](#5-your-page-origins-csp-popups)). Without it both reject with `api_unavailable` ("Journear’s relayer could
not be reached").

**Quick start: a gasless call.** The whole flow, writing to Journear's demo guestbook on testnet
(`hana-id-guestbook-dev1.testnet`, a contract sandbox-dev's relay accepts; `add_message({ text })`, no deposit). The
bytes come from `@hana-id/core/near`, which you already install, so no NEAR SDK is needed. Prepare before the click,
sign and relay in it:

```ts
import { HanaError } from '@hana-id/web';
import { nearImplicitPublicKey, utf8 } from '@hana-id/core';
import { encodeNearDelegateAction, nearDelegateNonce } from '@hana-id/core/near';

const GUESTBOOK = 'hana-id-guestbook-dev1.testnet'; // on sandbox-dev's relay allowlist
const RPC = 'https://rpc.testnet.near.org';

async function rpc(method: string, params: unknown) {
  const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json();
  // A failed query answers either `error` or (older nodes) `result.error`.
  if (body.error || typeof body.result?.error === 'string') throw new Error(JSON.stringify(body.error ?? body.result.error));
  return body.result;
}

/** A Journear Passport refusal's `data.reason`, if it has one. */
function reasonOf(e: unknown): string | undefined {
  const data = e instanceof HanaError ? e.data : undefined;
  return typeof data === 'object' && data !== null && 'reason' in data && typeof data.reason === 'string' ? data.reason : undefined;
}

/** Retries while Journear Passport hasn't recorded a new login's NEAR account yet (near_account_unrecorded), for about 20 s. */
async function whileUnrecorded<T>(call: () => Promise<T>): Promise<T> {
  for (let waited = 0; ; waited += 1000) {
    try {
      return await call();
    } catch (e) {
      if (reasonOf(e) !== 'near_account_unrecorded' || waited >= 20_000) throw e;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

/** The key's nonce and a recent final height. The first time for an account, activate() creates it if it is new. */
const activated = new Set<string>();
async function readKey(accountId: string): Promise<{ keyNonce: bigint; blockHeight: bigint }> {
  if (!activated.has(accountId)) {
    const a = await whileUnrecorded(() => hana.near.activate());
    activated.add(accountId);
    if (typeof a.accessKeyNonce === 'string' && a.blockHeight !== undefined) return { keyNonce: BigInt(a.accessKeyNonce), blockHeight: BigInt(a.blockHeight) };
  }
  // A key created a moment ago can take a block or two to show here (an UNKNOWN_ACCESS_KEY error): read again.
  const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: hana.near.publicKey });
  return { keyNonce: BigInt(key.nonce), blockHeight: BigInt(key.block_height) };
}

/** add_message({ text }) on the guestbook as a delegate action: no deposit, 10 Tgas, valid for about 6 minutes. */
async function guestbookDelegate(text: string): Promise<Uint8Array> {
  const accountId = hana.near.accountId!;
  const { keyNonce, blockHeight } = await readKey(accountId);
  return encodeNearDelegateAction({
    senderId: accountId,
    receiverId: GUESTBOOK,
    actions: [{ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text })), gas: 10_000_000_000_000n, deposit: 0n }],
    nonce: nearDelegateNonce({ keyNonce, blockHeight }),
    maxBlockHeight: blockHeight + 600n,
    publicKey: { type: 'ed25519', bytes: nearImplicitPublicKey(accountId) },
  });
}

// Before the click: when the user has typed the message (build it again once it is more than a minute old).
const delegateAction = await guestbookDelegate('gm from Journear Passport');

// In the click, with no await before it: Journear Passport's window opens, then Journear Passport's relay sends it and pays the gas.
button.addEventListener('click', () => {
  hana.near.signDelegateAction({ network: 'testnet', delegateAction })
    .then(({ signedDelegateAction }) => hana.near.relay({ network: 'testnet', signedDelegateAction }))
    .then(({ transactionHash }) => onSent(transactionHash), onError);
});
```

1. **Activate.** A brand-new user's account doesn't exist on chain yet, and Journear Passport refuses to sign a test app's delegate
   action for it (`near_key_unknown`). `hana.near.activate()` asks Journear Passport's relay to create it (a zero-value transfer
   from Journear Passport's relay account; no popup, the user pays nothing) for the logged-in user's own account. It resolves
   `created: true` when it created the account now and `created: false` when it already existed, so calling it again
   is harmless; `accessKeyNonce` (a decimal string, or `null` if the account exists without this key) and
   `blockHeight` are what the relay read, ready for `nearDelegateNonce`. Either can be missing (the relay couldn't read
   the new key back): then read `view_access_key` yourself, as `readKey` does. Call it once per account and session,
   before the click (when the gasless button appears or the user starts typing), not at every login: every request
   counts against your app's per-minute activation limit, and every account created against its daily one
   ([below](#near-relay)).
2. **Right after a login**, Journear Passport may not have recorded the user's NEAR account yet (it does so in the background,
   usually within a second, at most about 15 s). Until then `activate` and `relay` reject with `4100`, `data.reason:
   'near_account_unrecorded'` and `data.retryable: true`: retry for about 20 s, as `whileUnrecorded` does.
3. **Build** the delegate action with the key's nonce and the height from that read. `nearDelegateNonce` picks the
   nonce (below); `maxBlockHeight` 600 blocks ahead is about 6 minutes at testnet's 1.7 blocks a second (Journear Passport's
   relay takes at most 1,000 ahead). Build it again once the read is more than a minute old, so it can't expire
   while the user reads Journear Passport's window.
4. **Sign and relay** in the click. `relay` resolves once every receipt succeeded: `transactionHash` is the relay's
   transaction (base58; open it on a testnet explorer). The contract sees the user's account as the caller
   (`predecessor_account_id`), not Journear Passport's.

Several delegate actions from one read get the same nonce, and only the first can run: pass the previous one's nonce
as `lastUsed` (`nearDelegateNonce({ keyNonce, blockHeight, lastUsed })`), or read the key again.

**What Journear Passport checks before the window opens** (so a refusal costs the user no click). The delegate action's sender and
key must be the user's (`4100` otherwise). For a **test app**, a delegate action names no block hash, so Journear Passport ties it
to testnet another way, reading testnet's RPC (both of the environment's providers, when it has two):

- the account must exist there with this key (`near_key_unknown`: activate it first);
- the nonce must be above the key's current one (`near_delegate_nonce_used`), above (testnet's height − 10,000) ×
  10^6 (`near_delegate_nonce_stale`: the key's nonce + 1, as near-api-js picks, is usually too low) and below height ×
  10^6 (`near_delegate_nonce_too_large`). `nearDelegateNonce({ keyNonce, blockHeight })` from `@hana-id/core/near`
  picks one that passes: the key's nonce + 1, or (height − 100) × 10^6 if that is higher. The key's nonce moves up to
  it once the action runs, and later transactions and delegate actions simply continue from there;
- `maxBlockHeight` must be ahead of testnet's height by at most 10,000 blocks (`near_delegate_expiry`);
- it may only call contracts or send NEAR, to a `*.testnet` account other than the user's own
  (`near_delegate_test_app_action` for any other action: AddKey, DeleteKey, DeleteAccount, DeployContract,
  DeployGlobalContract, UseGlobalContract, Stake, CreateAccount; `near_delegate_test_app_receiver` for another
  receiver).

Why the last rule: nearcore runs a delegate action on any network whose own height lies between its nonce / 10^6 and
its `maxBlockHeight`, and the bounds above pin that to a window of at most 20,000 blocks around testnet's height when
it was signed. Mainnet, about 53 million blocks behind testnet in November 2026 and growing at the same rate, passes
through that window about a year later: whoever kept the signed action (your page can) could submit it there then, if
the user's implicit account exists on mainnet with the same key. A `*.testnet` account doesn't exist on mainnet (only
the `registrar` account could create `testnet` there), so such a replay calls nothing. Live apps are not restricted
this way. **Never fund or use a test app's addresses on mainnet**, and tell your users the same: the keys come from
Journear Passport's testnet MPC. For a test app Journear Passport asks both of the environment's NEAR providers; an environment with only one
fails closed (`api_unavailable`, `data.reason: 'near_rpc_single_provider'`), and so does an unreachable RPC
(`api_unavailable`, `near_rpc_unavailable`: try again).

**Who pays in a delegate action** (nearcore's rules, whichever relayer sends it): the relayer's transaction pays the
gas and prepays every deposit and transfer in the delegate action; on success those go to their receivers, and if an
action fails its NEAR is refunded to the user's account. So the user's balance goes down only for what acts on the
account itself: deleting it (everything), staking (locked), publishing a global contract (burnt), a call to a contract
on the user's own account (it decides what it moves: the popup says "Unknown") and fees spent through a function-call
key the action adds (up to its allowance). The actions run as the user's account, so a contract they call acts in the
user's name (it can move tokens the user holds there).

<a id="near-relay"></a>**Journear Passport's relay** (`hana.near.relay`, `POST /v1/near/relay`; `hana.near.activate`,
`POST /v1/near/activate`). Testnet only, and running on sandbox-dev. Both are checked against your publishable key and
your page's origin like every `/v1` call, need no session, and act only for a NEAR account Journear Passport has recorded for a
user of your app (one who signed in through SDK 0.4.0 or later). The relay sends a delegate action only if:

- every action in it is a **function call with no deposit** (no transfers, keys, deploys or stakes, even where Journear Passport
  would sign them), at most 4 of them, the signed action at most 4,096 bytes;
- it calls an **allowlisted receiver**. The allowlist is the environment's, shared by every app on it; on sandbox-dev
  it holds only Journear's two demo contracts, the guestbook `hana-id-guestbook-dev1.testnet` and the passport stamps
  `hana-id-stamps-dev1.testnet`. **To relay calls to your own contract, ask Journear to add its account** (a
  `*.testnet` account for a test app). Until then, the user signs the same way and any NEP-366 relayer of your own
  can send `signedDelegateAction` (it is the standard borsh `SignedDelegateAction`), or the user pays for an ordinary
  transaction (below);
- its calls attach at most **10 Tgas** together on sandbox-dev (the guestbook's `add_message` burns about 1.45);
- its nonce is above the key's (and above any this relay already sent for the account) and below (testnet's height +
  1) × 10^6, and its `maxBlockHeight` is at least 3 and at most **1,000 blocks** ahead of testnet's height (stricter
  than the 10,000 Journear Passport's window allows: about 10 minutes).

Journear Passport's relay account pays the gas and the activations; relays and activations are not billed to your app during the
pilot. Limits on sandbox-dev (a refusal is `rate_limited` unless the table says otherwise; the message names the
limit):

| Limit | Relays | Activations |
|---|---|---|
| Per NEAR account | 10 a minute, 50 a day | 5 requests a minute |
| Per user (all their NEAR accounts) | 200 a day | 2 a day |
| Per app | 120 a minute, 2,000 a day | 60 requests a minute, 200 a day |
| Per IP address, across every app | 30 a minute | 10 a minute |
| Across the environment | 200 a minute, 10,000 a day | 300 requests a minute, 1,000 a day |
| NEAR spent per day | 1 NEAR per app (`rate_limited`, `data.reason: 'app_budget_exhausted'`), 5 NEAR across the environment (`api_unavailable`, `relay_budget_exhausted`) | (the same budgets) |

Days are UTC days. A relay of one small call costs the relay about 0.0002 NEAR; an activation about 0.0071 NEAR. Every
activation request is counted per minute, including one for an account that already exists; only a created account
counts toward the daily activations.

**An ordinary transaction.** The account pays its gas, so it needs NEAR first (a transfer to the account id; testnet
faucets send it). Build the transaction before the click: the key's next nonce and a recent block hash come from any
NEAR RPC. This sample uses `@near-js/transactions` (near-api-js's encoder); `encodeNearTransaction` from
`@hana-id/core/near` makes the same bytes. Sign it in the click, then broadcast it yourself:

```ts
import { PublicKey } from '@near-js/crypto';
import { actionCreators, createTransaction, encodeTransaction } from '@near-js/transactions';
import { baseDecode } from '@near-js/utils';

// Before the click: the key's nonce and a recent final block (view_access_key returns both).
const signer = hana.near.accountId!;
const signerKey = PublicKey.fromString(hana.near.publicKey!);
const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: signer, public_key: signerKey.toString() });
const tx = createTransaction(signer, signerKey, GUESTBOOK, BigInt(key.nonce) + 1n,
  [actionCreators.functionCall('add_message', { text: 'gm' }, 30_000_000_000_000n, 0n)], baseDecode(key.block_hash));

button.addEventListener('click', () => {
  hana.near.signTransaction({ network: 'testnet', transaction: encodeTransaction(tx) })   // no await before it
    .then(({ signedTransaction, hash }) => rpc('send_tx', { signed_tx_base64: signedTransaction, wait_until: 'FINAL' }).then(() => hash))
    .then(onSent, onError);
});
```

`signTransaction` returns `{ signature, signedTransaction, hash }`: base64 of the 64-byte signature, base64 of the
borsh `SignedTransaction` (what `send_tx` takes) and the base58 transaction hash. The transaction's signer and key
must be the user's (`4100` otherwise). Journear Passport checks the network you name against the block hash: a `testnet`
transaction's must be a testnet block (`near_block_unknown` otherwise; if Journear Passport can't reach NEAR testnet it refuses
with `api_unavailable`, `data.reason: 'near_rpc_unavailable'`), and a `mainnet` one's must not be
(`near_network_mismatch`). Use a block hash under a day old (NEAR's own rule). A transaction that relays someone
else's delegate action (a `Delegate` action) is refused (`near_relayed_delegate`): its signer would prepay every
deposit inside it. Transactions with a priority fee (`TransactionV1`) and actions newer than `UseGlobalContract` are
refused, and a request is at most 192 KiB of base64.

**Sign in with NEAR (NEP-413).** A signature that proves the user holds the account, for your backend. It moves
nothing and names no network, so a test app may ask for it, and it is how your backend learns the NEAR account today:
the identity token's `wallets` don't list it yet ([section 15](#whats-in-it)).

```ts
// From your backend, before the click: 32 random bytes (base64) it will accept once.
const challenge = { message: 'Sign in to Guestbook', recipient: 'guestbook.example', nonce: 'qhK4GqbpzrcBGQhpVwbIqWjl8MB6uQRL9oB0LqkNWwQ=' };

button.addEventListener('click', () => {
  hana.near.signMessage(challenge)   // resolves { accountId, publicKey, signature }
    .then((signed) => fetch('/api/near-sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(signed) }), onError);
});
```

Your backend rebuilds NEP-413's payload (`u32le(2^31 + 413)` ‖ borsh `{ message, nonce, recipient, callbackUrl }`),
verifies `signature` (base64, Ed25519) over its sha256 with the account's key, checks that `publicKey` is the
account's (an implicit account is its key), and accepts the nonce only once. With `@hana-id/core` on Node 22:

```ts
import { base64Decode, nearImplicitPublicKey, nearPublicKeyString } from '@hana-id/core';
import { encodeNep413Message, nep413Hash } from '@hana-id/core/near';

/** Your backend: true when `signed` is the NEAR account's answer to the challenge you issued (check its nonce once). */
export async function verifyNearSignIn(
  signed: { accountId: string; publicKey: string; signature: string },
  issued: { message: string; recipient: string; nonce: string; callbackUrl?: string },
): Promise<boolean> {
  const key = nearImplicitPublicKey(signed.accountId);   // an implicit account is its key; throws for any other id
  if (nearPublicKeyString(key) !== signed.publicKey) return false;
  const digest = nep413Hash(encodeNep413Message({ message: issued.message, nonce: base64Decode(issued.nonce), recipient: issued.recipient, callbackUrl: issued.callbackUrl ?? null }));
  const publicKey = await crypto.subtle.importKey('raw', key, 'Ed25519', false, ['verify']);
  return crypto.subtle.verify('Ed25519', publicKey, base64Decode(signed.signature), digest);
}
```

`recipient` and `callbackUrl` are one line of visible text each (at most 1,024 bytes); Journear Passport's window shows the
recipient first, flags one that isn't your page's host, and writes out a recipient with characters outside plain
ASCII (look-alikes). `nonce` is 32 bytes (`-32602` otherwise).

**What the approval window shows** (decoded by Journear Passport from the bytes, never from your description): the network and
whether Journear Passport checked it, sender and receiver, every action in plain words (a call with its method, attached deposit,
gas in Tgas and its arguments as escaped JSON, or hex when they aren't JSON, always in full), and the NEAR leaving the
account (including what publishing a global contract burns: 0.0001 NEAR per byte of code). Adding or removing a key,
deleting the account and deploying or setting a contract change who controls the account: they are shown under a red
warning; so are a call to a contract on the user's own account and a global contract's burn.

<a id="near-errors"></a>**Errors.** The sign methods reject like every signing call: `4001` when the user declines,
closes the window or lets it time out, and Journear Passport's refusals before the window as below. `relay` and `activate` turn
the API's answer into a `HanaError`: HTTP 429 is `rate_limited`, `origin_not_allowed` and `app_suspended` keep their
code, any other 4xx is `4100` and any 5xx is `api_unavailable`; for each, `data.reason` is the API's code,
`data.status` the HTTP status and `data.requestId` its request ID (quote it to Journear, [section 13](#13-errors)), and
a nonce refusal adds `data.accessKeyNonce` (the nonce the relay holds the key at, a decimal string).

From the release after 0.4.0, `data` (type `NearRelayErrorData`) also carries, when the API sent them:

- `data.transactionHash`: the base58 hash of the transaction the relay sent, on a refusal that came after the send
  (`timeout`, `contract_rejected`, `delegate_rejected`, `near_rejected`, `near_error`, and a `relayer_busy` whose
  transaction was dropped);
- `data.nearReason`: NEAR's own reason for a `delegate_rejected` (`expired`, `invalid_nonce`, `nonce_too_large`,
  `access_key`, `invalid_signature`, `sender_mismatch` or `account_missing`);
- `data.retryAfterS`: the API's `retry-after` in whole seconds (rate limits, budgets, `near_account_unrecorded`,
  `relayer_busy`, `relayer_unavailable`).

Each is passed on only in its exact shape; anything else in the answer is left out. When the SDK can't reach Journear
Passport's API (your CSP, the network, no answer in 60 s) it rejects with `api_unavailable` and no `data.reason`.
Retrying a relay with
the same `signedDelegateAction` is always safe: NEAR never runs one delegate action twice (its nonce), and the relay
answers a copy it may already have sent with `delegate_nonce_used` without counting it.

| Code, `data.reason` | From | Meaning | What to do |
|---|---|---|---|
| `4100` (no reason) | SDK | not logged in, or Journear Passport's vault predates NEAR (`hana.near.accountId` null) | log in; after a deployment, reload |
| `-32602` | SDK | a malformed argument (`network`, bytes that aren't base64, a nonce that isn't 32 bytes, `relay`'s `network` not `'testnet'`) | fix the call |
| `4100` (no reason), `invalid_request` | vault | the bytes name another signer or key, or don't decode | build them for `hana.near.accountId` and `publicKey` |
| `4100` `mainnet_not_allowed` | vault | a test app asked to sign for `mainnet` | use testnet |
| `4100` `near_block_unknown`, `near_network_mismatch` | vault | the transaction's block hash isn't a block of the network you named | read a recent block from that network's RPC |
| `4100` `near_relayed_delegate` | vault | the transaction carries someone else's delegate action | relay through a relayer, not the user's account |
| `4100` `near_key_unknown` | vault | a test app's delegate action for an account that doesn't exist on testnet yet | `activate()` first |
| `4100` `near_delegate_nonce_used`, `near_delegate_nonce_stale`, `near_delegate_nonce_too_large`, `near_delegate_expiry` | vault | the nonce or expiry doesn't fit testnet's current key and height | read the key again, build with `nearDelegateNonce` and 600 blocks |
| `4100` `near_delegate_test_app_action`, `near_delegate_test_app_receiver` | vault | a test app's delegate action does something other than call or pay a `*.testnet` account | change the call |
| `api_unavailable` `near_rpc_unavailable`, `near_rpc_single_provider` | vault | Journear Passport couldn't check the request on NEAR testnet | try again later; report the second |
| `origin_not_allowed`, `app_suspended`; `4100` `missing_key`, `unknown_app`, `scope_conflict` | relay | as for every call to Journear Passport's API: your page's origin, your app's state or its publishable key | [section 13](#13-errors) |
| `4100` `near_account_unrecorded` (`data.retryable`) | relay | Journear Passport hasn't recorded this user's NEAR account for your app yet (usually just after a login) | retry for about 20 s; if it persists, log in again |
| `4100` `delegate_nonce_used` | relay | the relay or the chain has seen this nonce or a higher one: another tab, an earlier attempt, or a retry of one already sent | if the call must not run twice, check its effect on chain first; then build above `data.accessKeyNonce` and ask the user to approve again |
| `4100` `delegate_nonce_too_large`, `delegate_expired`, `block_height_too_far` | relay | the nonce is above testnet's height × 10^6, or `maxBlockHeight` is under 3 or over 1,000 blocks ahead | read the key again and rebuild |
| `4100` `action_not_allowed`, `deposit_not_allowed`, `receiver_not_allowed`, `gas_too_high` | relay | outside what the relay sends (above) | change the call, or ask Journear to allowlist your contract |
| `4100` `bad_request`, `bad_delegate`, `bad_delegate_signature`, `sender_not_implicit` | relay | not a signed delegate action of a Journear Passport account | send `signDelegateAction`'s `signedDelegateAction` as it is |
| `4100` `account_not_activated`, `access_key_missing` | relay | the account doesn't exist on testnet, or doesn't hold the user's key | `activate()`; with `access_key_missing`, the key was removed and the relay can't act for the account |
| `4100` `already_relayed` | relay | the same signed action is being relayed right now | wait for the first answer |
| `4100` `contract_rejected` | relay | the call ran and failed; the message is the contract's error (`data.transactionHash`: the transaction) | the nonce is used: fix the call and sign a new one |
| `4100` `delegate_rejected` | relay | NEAR refused the delegate action itself (its nonce, expiry, key or signature; `data.nearReason` says which) | read the key again, rebuild and sign a new one |
| `rate_limited` (`rate_limited` or `app_budget_exhausted`) | relay | one of the limits above | back off for `data.retryAfterS` seconds; budgets reset at 00:00 UTC |
| `api_unavailable` `timeout` | relay | the relay's transaction was sent, but its outcome didn't settle in 30 s | it may still run: look up `data.transactionHash` (below) or check its effect on chain before signing again; after `maxBlockHeight` it can no longer run |
| `api_unavailable` `relayer_busy`, `relayer_unavailable`, `near_unavailable`, `directory_unavailable`, `rate_limiter_unavailable` | relay | Journear Passport's relay or its NEAR RPC is busy or unreachable | retry the same `signedDelegateAction` after `data.retryAfterS` or a second or two (a `delegate_nonce_used` then means it may have been sent, above) |
| `api_unavailable` `near_rejected`, `near_error`, `relay_budget_exhausted`, `relayer_unconfigured` | relay | NEAR refused the relay's transaction, its outcome is unknown, the environment's daily budget is spent, or the relay is off | check on chain (`data.transactionHash`, when there is one); report it to Journear Passport with `data.requestId` |

A relay that timed out may still land: show the user it was sent, with a link to its transaction, rather than an
error (SDK after 0.4.0; with 0.4.0 `data.transactionHash` is missing, and Journear finds it from `data.requestId`):

```ts
import { HanaError, type NearRelayErrorData } from '@hana-id/web';

/** A relay refusal's transaction that may still land (a `timeout`), as an explorer link; null for any other error. */
function stillConfirming(e: unknown): string | null {
  const data = e instanceof HanaError && typeof e.data === 'object' && e.data !== null ? (e.data as NearRelayErrorData) : null;
  return data?.reason === 'timeout' && data.transactionHash !== undefined ? `https://testnet.nearblocks.io/txns/${data.transactionHash}` : null;
}
```

<a id="near-not-yet"></a>**Not supported yet:**

- **Auto-approval.** Every NEAR request asks the user; policies have no NEAR rules.
- **Journear Passport's relay for any contract.** Only allowlisted receivers (above): ask Journear, or use your own relayer.
- **Mainnet for test apps**, and Journear Passport's relay on mainnet at all: it runs on testnet only.
- **NEAR in the identity token.** Its `wallets` stay Stellar and EVM, so a backend that checks their shape keeps
  working; prove the NEAR account with `signMessage` (above).
- **React hooks.** `useWallet` and `useHana().exportKey` take `'stellar'` and `'evm'` only: read
  `useHana().addresses?.near` and call `useHana().client?.near` and `client.exportKey('near')`
  ([section 10](#10-react)).
- **Named accounts.** Journear Passport signs only as the user's implicit account, so it can't sign for a named account
  (`alice.testnet`) the user creates; nor `TransactionV1` (priority fees).

**Key export.** `hana.exportKey('near')` exports the key as `ed25519:<base58>` (near-cli and NEAR wallets import that
form), with the same safeguards as the other chains ([section 4](#4-log-in-log-out)).

### Raw signing

Off by default, and never available to a test app (`pk_test_…`): a raw digest can be a mainnet transaction's hash,
so a test app's `signRaw` is `4100` (`data.reason: 'raw_not_allowed_for_test_apps'`) whatever its setting. With raw
signing set to `'approval'` for a live app:

```ts
await hana.signRaw({ chain: 'stellar', bytes });   // Ed25519 over ≤ 4 KiB → { signature } (64 bytes)
await hana.signRaw({ chain: 'evm', digest });      // secp256k1 over 32 bytes → { signature } (r‖s‖v, v ∈ {27, 28})
```

An on-chain owner of your scope turns it on, on the **Signing** tab ([section 1](#on-chain-owners)); any owner turns
it off. The user always approves raw requests, under a red warning that raw signing can authorize any transaction on that
chain. No policy ever covers them. Ask for it only if a standard method can't do the job. With raw signing off,
`signRaw` is `4100` (`data.reason: 'raw_sign_off'`), also in a tab opened before it was turned off. Bytes in Journear Passport's
own signing domains are never raw-signed: Stellar bytes starting with `hana-id`, and the session's identity
wallet-proof digest on EVM, are `4100` (`data.reason: 'raw_reserved_domain'`) before any popup. If the vault can't
confirm the setting with Journear Passport's API (it re-reads it at most every 10 s), the request fails with `api_unavailable`
rather than going ahead.

## 9. Auto-approve policies

By default every signature needs the popup. An auto-approve policy lets matching requests be signed without one, for
example repeated deposits into your contract. It needs two opt-ins:

1. **You** set a policy for your app. It takes effect after the delay (24 h; 60 s on sandbox-dev).
2. **Each user** accepts that exact policy once, in a Journear Passport popup that shows your app, your verified origin, the
   policy's label, every contract (its name, short address and explorer link: see "Contract names" below), the
   functions, the address rule and the limits. A changed policy asks every user again.

Until both happen, matching requests simply get the normal popup. The vault, not your page, checks every request
against the policy, so an injected script on your page can do no more than the policy allows.

**How to set one.** An on-chain owner of your scope ([section 1](#on-chain-owners)) writes the policy as JSON (below) and pastes it on your app's **Signing** tab in the portal:
**Check and preview** runs the same validator the vault uses, lists any problem and shows the consent screen your users
will see; **Propose this policy (confirm with Google)** then announces it, and it takes effect after the delay. One
policy change can wait at a time. You can run the validator yourself first:

```ts
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
const r = validateAutoApprovePolicy(JSON.parse(text), { sessionTtlMs: 12 * 3_600_000 }); // { ok, policy } or { ok: false, problems }
```

Removing a policy (**Remove the policy** on the Signing tab) is immediate for new page loads. A tab that is already open re-reads the
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
(`account_control`), and the popup shows them under a red "changes who controls a Stellar account" warning:
don't build flows that need them. **Not covered in the pilot:** calls whose instructions travel in opaque bytes, such as
routers, multicall, bridges and Sodax swaps (`AssetManager.transfer`, `sendMessage`). Those always get the popup until
a protocol decoder for them ships. Token amounts other than native value are not capped in the pilot, so keep
`perDayCount` small.

**Contract names on the consent screen.** The `name` you give a contract is shown as yours: "{name} · named by
{your app name}". A contract on Journear Passport's verified list shows "✓ {verified name}" instead, and your name for it isn't
shown. If your name for any other contract reads like a verified name or mentions a verified protocol (say "Sodax
Router" on an address that isn't one of Sodax's verified contracts), the screen flags it ("— not the verified Sodax
Asset Manager", "— not a verified Sodax contract") and warns the user at the top. Check marks are removed from your
names. Every contract also shows its short address (`0x348B…7Bc3`) and a "View on {explorer}" link for its chain
(Etherscan, Basescan, SonicScan, StellarExpert and others, test networks included; a chain Journear Passport has no explorer for
shows the address alone). The verified list starts with Sodax's mainnet contracts (its Sonic hub contracts; asset
managers and bnUSD on the EVM spokes and Stellar; Connection contracts on Hedera, Kaia and Robinhood Chain), each
confirmed by two Sodax sources that agree.

**Getting a contract verified.** Ask Journear, with the chain, the address and the protocol's own official sources for
it: a page of the protocol's documentation that lists the address, and/or a published, version-pinned package of the
protocol (its SDK config) that contains it. Journear adds the entry only after confirming the address from those sources
(two that agree, where they exist), records them with the entry, and ships it in a Journear Passport release: the list is built
into Journear Passport's popup, not read from the API, so it can't be changed for one app. Your own contracts can be verified the
same way, under your protocol's name.

Your page can use:

```ts
await hana.requestAutoApprove();   // opens the consent screen now → { granted, policyId?, expiresAtMs? }; 4100 without a policy
await hana.autoApproveStatus();    // { policyId, label, expiresAtMs, used: { count, native } } or null
await hana.revokeAutoApprove();    // the user can also stop it from any Hana popup
```

Without `requestAutoApprove()`, the first matching request shows the consent screen. A request that doesn't match
gets the normal popup, which tells the user why it wasn't auto-approved. After each auto-signed request the vault
emits `autoApproved` and its button briefly shows "Signed by Journear Passport under {label}": a notice, not a prompt, so the
`launcher` event for it has `clickable: false` (SDK 0.3.1 or later) and there is nothing for the user to click.

Journear Passport records each consent on its API, so auto-approve can't be turned on while the API can't record it. After the
user presses Allow, `requestAutoApprove()` rejects with `api_unavailable` (`data.reason` is `consent_not_recorded`,
`data.granted` is `false`) rather than granting; it rejects the same way, with `consent_unconfirmed`, when Journear Passport can't
confirm a consent the user already gave. A matching request in the same situation just goes to the normal popup. Treat the rejection like any other failure: offer it again later; the user's Allow isn't remembered. If the user
stops auto-approve in Journear Passport on another device, an open tab stops auto-signing within about 10 seconds, and a Journear Passport popup
appears for the next matching request. Requests go to the popup the same way while Journear Passport's API can't be reached; your
page needs no code for this.

Auto-signed requests don't extend the session's idle limit: only a signature the user approved in a Journear Passport popup does. A
session that only auto-signs ends at your app's idle limit, and the user has to sign in again. If your app can run for
longer than that on auto-approve alone, plan for that sign-in.

## 10. React

`@hana-id/react`:

```tsx
import { HanaProvider, useHana, useIdentityToken, useWallet } from '@hana-id/react';

<HanaProvider config={{ publishableKey: 'pk_test_…', environment: 'sandbox-dev', evm, stellar }}>
  <App />
</HanaProvider>;

function SignIn() {
  const { status, addresses, persistence, error, supportId, login, logout, exportKey } = useHana();
  return (
    <>
      <button onClick={login}>Sign in</button> {/* login must run in the onClick, with no await before it */}
      <button onClick={() => login({ method: 'google' })}>Continue with Google</button>
      <button onClick={() => login({ method: 'email' })}>Continue with email</button>
    </>
  );
}

const { address, signer } = useWallet('stellar'); // signer is hana.stellar
const { address, provider } = useWallet('evm');   // provider is hana.ethereum (EIP-1193)
const { identityToken, refresh, error } = useIdentityToken(); // for your backend, kept fresh (section 15)
```

- `HanaProvider` creates one client, also under strict mode, and destroys it on unmount. It reads `config` once; to
  switch app or environment, remount it (a `key`).
- `login(options)` takes `hana.login()`'s options (`{ method, emailHint }`, [section 4](#4-log-in-log-out)); the event
  `onClick={login}` passes is ignored (SDK releases after 0.2.0; with 0.2.0, `login` ignores every argument: use
  `useHana().client.login({ method })`). Bad options reject with `-32602` before any popup.
- A failed login (popup closed, `4001`, `popup_blocked`, `login_cancelled`) is in `useHana().error`. The promise
  `login()` returns is already marked handled, so `onClick={login}` never raises an unhandled rejection; if you
  `await` or `.catch` it, you still get the rejection. `logout()` and `exportKey()` reject as usual and their
  failures aren't in `error`: handle them (`onClick={() => logout().catch(report)}`).
- NEAR (SDK 0.4.0) has no hook yet, and `useWallet` and `useHana().exportKey` take `'stellar'` and `'evm'` only:
  `useHana().addresses?.near` is the account, and `useHana().client` (null until the provider has mounted its client)
  gives `client.near` and `client.exportKey('near')` ([section 8, NEAR](#near)).
- Server rendering (Next.js): the modules are `'use client'`, and the client is created in an effect, so a server
  render shows the initial state (`status: 'unlocking'`, no addresses, `signer` / `provider` null) and never touches
  `window`.
- React 18 and 19 are both supported (peer dependency `^18 || ^19`); the test suite runs on both, and the source
  typechecks against `@types/react` 18 and 19.

## 11. Sodax adapter

`@hana-id/sodax` (optional), typed against `@sodax/types` 2.2.0 (SDK releases after 0.2.0; 0.2.0 against 2.1.0):

```ts
import { createSodaxEvmProvider, createSodaxStellarProvider } from '@hana-id/sodax';

const stellarProvider = createSodaxStellarProvider(hana, { networkPassphrase, horizonUrl, sorobanRpcUrl }); // IStellarWalletProvider
const evmProvider = createSodaxEvmProvider(hana, { chainId: 8453, rpcUrl });                              // IEvmWalletProvider, one per spoke chain
```

- The Stellar provider signs through `hana.stellar` (fee-bump allowed) and sends to Soroban RPC.
  `signAndSendTransaction(rawTx)` signs as `rawTx.from`: a transaction built for another account is refused (4100)
  before any popup. `waitForTransactionReceipt` polls Horizon every 2 s for 60 s.
- The EVM provider is bound to one chain, which must be in your `evm.chains` (it throws otherwise). It refuses a
  `from` other than the user's address, and an `expectedChainId` (`@sodax/sdk` 2.2.0's second argument) other than its
  chain (`4902`, `data.reason: 'expected_chain_mismatch'`, before any popup; SDK releases after 0.2.0), then fills, gets
  the user's approval and broadcasts. Filling and broadcasting use
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
- **What you can test with a test key.** Sodax runs on mainnet only (it has no testnet), while pilot keys are
  testnet-MPC keys, so no Sodax transaction can be signed with a test app: the vault and the SDK refuse it with `4100`
  (`data.reason: 'mainnet_not_allowed'`, [section 12](#12-test-and-live-keys)). Through the EVM adapter the approval
  popup opens in the click and closes again at once when the refusal comes (the adapter opens it before switching
  chains). You can test Sodax quotes and intent building (`createIntent({ raw: true })`, read-only against mainnet), and
  the adapters with ordinary testnet transactions. Real Sodax swaps through Journear Passport wait for Journear Passport's mainnet launch (live
  keys); Journear's own sandbox mainnet demo runs under a Journear-internal exception that partner apps can't use. The adapter
  is tested against mocks of `@sodax/sdk`'s call patterns, not end to end.
- **Build before the click.** `sodax.swaps.swap()` awaits allowance checks and a simulation before it signs, which
  costs the click its popup. Build the intent's transaction when the user enters the amount (`createIntent({ raw: true
  })`), then hand it to the provider in the click: `evmProvider.sendTransaction(tx)` opens the approval popup at once.

## 12. Test and live keys

| | `pk_test_…` | `pk_live_…` |
|---|---|---|
| Where | sandbox envs (testnet), the pilot | the production MVP (mainnet), after the audit; not issued yet |
| Loopback origins (`http://localhost:…`) | allowed, in `local*`/`sandbox*` envs only | never |
| Login result | carries per-stage `timings` (`hana.lastLogin.timings`, below); the handshake and unlock's are `hana.readyTimings` | no timings (`hana.readyTimings` is null) |
| Direct API calls from your page (`/v1/sessions`, `/v1/derive`) | only in sandbox envs, for Journear's test tooling | never |
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
`@hana-id/core`). Ask Journear to add another testnet.

**Journear's sandbox mainnet demo (not for partner apps).** Journear runs its own Sodax demo on sandbox under an internal
exception: one Journear Passport test app may sign on Base (8453) and Stellar's public network, at most $9.99 per transaction (fee
included), every request through Journear Passport's window with a red "Real funds, test custody" banner, the request's value and
the wallet's balance. Partner apps can't get it, and in production it doesn't exist. What the SDK shows of it (SDK
0.2.1; the `prices` field and `mainnetDemoKnown` need a current vault), so a page built on it knows where it stands:

- `hana.mainnetDemo`: `null` when off or not known yet; for the demo app `{evmChains: [8453],
  stellarNetworkPassphrase, txCapUsd: '9.99', txCapUsdMicros, pricesReviewedAt, pricesValidUntilMs, prices}`, from the
  vault (`mainnetDemoChanged` when it changes, the prices included). Only then does `hana.ethereum` let Base through.
- **Off or not known yet:** `hana.mainnetDemoKnown` is false until `hana.ready` resolves, then true: from then a null
  `mainnetDemo` means the demo is off for this app. A page that reads it at first render must wait for `ready`
  (the vault announces the demo before `ready`, so the state is final at that moment). In React, `useMainnetDemo()`
  returns `{ demo, known }`.
- **Prices:** `hana.mainnetDemo.prices` is `{ source, atMs, assets: { ETH, XLM, USDC, EURC } }`, each asset `{ usd:
  '2251.7985', usdMicros: '2251798500', source }`. `source` (`live` or `fixed`) is per asset, and the top-level one is
  `live` only when all four are. Live prices are CoinGecko's market price plus 5%, rounded up, within a floor and a
  ceiling per asset; `fixed` is Journear's reviewed table, used per asset when no live price is available. `atMs` is the
  oldest live price's time, or null when none is live. `prices` is null with a vault older than this SDK. Value what
  you're about to send, plus the transaction's maximum fee in the native asset, at these prices and compare with
  `txCapUsd` to know before the click what the vault will accept: they are the same numbers the vault uses.
- A refusal is `4100` before any window: `mainnet_demo_over_cap`, `mainnet_demo_unknown_call`,
  `mainnet_demo_unpriced`, `mainnet_demo_wrong_destination` (a Sodax deposit, bridge or swap that would send funds
  anywhere but the user's own wallets: another hub wallet, recipient or destination chain),
  `mainnet_demo_prices_stale` (only once the fixed prices a request depends on are past their date); any other mainnet
  stays `mainnet_not_allowed`. `data.usd` and `data.capUsd` are strings such as `"$12.40"`,
  always rounded up to the cent; compare numbers with `usdMicros`, not these. If Journear Passport can't confirm the demo is
  still on, the request fails with `api_unavailable` and `data.reason: 'mainnet_demo_unconfirmed'` (try again).
- What the demo can value (everything else is `mainnet_demo_unknown_call`, or `mainnet_demo_unpriced` for an
  unlisted asset):

  | Network | Request | Counted toward the $9.99 |
  |---|---|---|
  | Base | any transaction | its maximum fee (`gas × maxFeePerGas`), in ETH |
  | Base | plain send (`to`, no calldata) | the `value` in ETH |
  | Base | ERC-20 `transfer`, `transferFrom` or `approve` of USDC or EURC | the amount (an approval counts as what it lets the spender take: an unlimited approval is refused) |
  | Base | Sodax asset-manager deposit, native or USDC/EURC, with Sodax's own hub calls (a swap's, delivered to the user's own wallet on the destination chain, into ETH, USDC or EURC on Base or XLM, USDC or EURC on Stellar, with no partner fee, delivery hook or named solver, not partly fillable, and with a deadline at most an hour away, so no limit orders), no hub calls, or Sodax's USDC ⇄ USDC bridge to Stellar (to the user's own Stellar wallet). Every deposit must go to the signing address's own Sodax hub wallet, which the Sodax SDK does for you | the deposited amount |
  | Stellar public network | any transaction | its fee, in XLM |
  | Stellar public network | `payment` of XLM, Circle USDC or EURC; `createAccount` | the amount |
  | Stellar public network | `changeTrust` for a listed asset | nothing (it moves no funds) |
  | Stellar public network | Sodax asset-manager `transfer` deposit (a swap's, on the same terms as on Base, no hub calls, or Sodax's USDC ⇄ USDC bridge to Base, to the user's own EVM wallet). Every deposit must go to the signing account's own Sodax hub wallet, which the Sodax SDK does for you | the deposited amount |

  Refused: contract creation, any other contract or calldata, typed data (including `Permit`), Stellar auth entries,
  fee-bumps, path payments and any other operation. The fee always counts, so aim a little under the cap.
- Stellar's network is per call: the passphrase passed to `hana.stellar.signTransaction` (the Sodax Stellar provider's)
  wins, the approval window shows it, and `hana.stellar.getNetwork()` still reports `createHana`'s.

A test app and a live app never share a scope. Your staging and production apps therefore give the same Google
account **different addresses**. Wallets made with test keys are disposable.

**Login timings (test apps).** `hana.lastLogin.timings` holds consecutive stages, in ms, that add up to the login's
time: `open`, `wait`, `app` (`GET /v1/app`), `keygen`, `popup`,
`authCheck`, then the sign-in step, then `relayHeld`, `verify`, `scopeWait`, `chain`, `decrypt`, `finish`, `port`. The
sign-in step depends on the method: `choose` when the popup showed its method chooser; for Google, `google`
(the user and Google's pages, plus the relay's network legs) and `callbackRedirect`, `callbackFetch`, `callbackBoot`,
`callbackPrep`; for email, `emailLoad` (the email screen's load), `emailEntry` (typing the address), `emailStart` (the
code request), `emailCode` (waiting for the mail and typing the code), `emailVerify` (checking the code) and
`emailRelay` (the relay's network legs), and no `google`. Breakdown values that aren't added: `appRtt`, `appServer`,
`appServerGate`, `appServerSettings`, `appServerChain` (inside `app`), `scopeCheck`, `chainPrep`, `loginRtt`,
`loginServer*`, `vault`.

## 13. Errors

`hana.*` methods reject with a `HanaError {code, message, data?}`. The EIP-1193 provider maps string codes to numbers
(the Journear Passport code stays in `data.code`), and the SWK module maps them to SWK's shape.

An error that came from an answer of Journear Passport's API (a refusal, or a sign-in that gave up after one: `rate_limited`,
`api_unavailable`, `token_invalid`, `link_refused`, `identity_unavailable`, `session_ended`, `4900` from
`revokeOtherDevices()`, …) carries that request's ID in `data.requestId` (SDK 0.2.0 or later):
`error.requestId` on a `HanaError` (null without one), `data.requestId` on the EIP-1193 provider's errors too, and
`ext[1]` on the SWK module's. It is 8–64 letters, digits and `-` (e.g. `8d1f2c3a4b5e6f70-SIN` or a UUID), names one
request and nothing else, and is not secret. An error that never reached the API has none: a check in the SDK or the
vault (not logged in, a wrong address, a mainnet for a test app), the user's cancel or rejection, a network failure,
a refusal of Google's. Signing has none either (it never calls the API); key export's errors are shown in the export
window, not returned.

| Code | Meaning | What to do |
|---|---|---|
| `4001` | The user rejected, closed the popup, or let it time out | nothing; let them retry |
| `4100` | Not logged in, wrong address, or not allowed for this app (raw signing off, no policy, a mainnet for a test app: `data.reason`) | log in, or check the call |
| `4200` | Unsupported method (`eth_sign`, …) | use a supported method |
| `4900` | The session or the vault is gone. `data.reason: 'signed_out'`: Journear Passport signed this device out (Journear Passport's own page, `revokeOtherDevices()` on another device, a newer sign-in in another tab of this device, or your app's settings), and the vault is fine. Without it: the vault connection is gone (frame replaced, `hana.status` `'error'`), or the session ended another way (a logout in another tab, its end on Journear Passport's side, a stored session that couldn't be opened), where the vault is fine (`hana.status` `'logged_out'`) | with `signed_out`, or with `hana.status` `'logged_out'`, ask the user to log in again (no reload); with `'error'`, create the client again or reload |
| `4902` | EVM chain not in `evm.chains` | add it to `createHana` |
| `vault_unavailable` | The vault didn't load (one automatic retry; `data.reason`: `csp_frame_src`, `no_answer`, `frame_timeout`, `ready_timeout`, `frame_replaced`, [section 3](#3-create-the-client)) | check `frame-src`, your origins (`no_answer`'s `data.origin` against the portal's **Origins** tab), the network. A wrong origin or key takes about 3 s to report (`no_answer`; about 10 s with SDK 0.2.0) |
| `popup_blocked` | The browser blocked the popup and the sign-in was cancelled | call `login()` in a click |
| `coop_blocks_popup` | The popup closed before it connected (COOP `same-origin`, or the user closed it at once) | fix COOP |
| `login_timeout` | The popup never connected (15 s, `data.stage: 'connect'`), or the sign-in was left unfinished for 5 min (`data.stage: 'pending'`: the popup left open, or closed within a few seconds of reaching Google's page) | retry |
| `login_cancelled` | `cancelLogin()`, or a newer `login()`, or the user closed the Journear Passport popup (`data.reason: 'popup_closed'`: within about 2 s; about 90 s for a close within a few seconds of reaching Google's page), or the user cancelled the email step, or cancelled Google's sign-in screen and then closed the Journear Passport popup on the screen it went back to; `data.reason: 'email_consent_declined'` or `'google_account_mismatch'`: a new Google user refused Google's email permission (or chose another Google account there) and cancelled Journear Passport's explanation | offer email sign-in |
| `login_method_unavailable` | `login({method})` named a method your app doesn't offer (email not turned on) | offer the other method |
| `code_invalid`, `challenge_expired` | Email login: the user cancelled after a wrong or expired code | let them retry |
| `link_pending` | This sign-in method is waiting to join a wallet (`data.effectiveAtMs`: when it can open it) | show when; sign in with the wallet's other method meanwhile |
| `link_refused` | The sign-in methods can't be linked (`data.reason`); `login()` with the wallet's own method still works | offer the other method |
| `google_error` | Google returned an error (`data.error`), or Journear Passport couldn't check Google's answer (`tokeninfo_unavailable`, `tokeninfo_client_mismatch`, `tokeninfo_invalid`, `google_account_mismatch`, `invalid_response`). The user cancelling Google's sign-in screen is not one: the popup goes back to its chooser, and closing it there is `login_cancelled`. `access_denied` remains only where Journear Passport has no screen to go back to (a login in an environment without Journear Passport's email service, or the fallback Google request a Google-only app makes when Google's tokeninfo can't be reached) | retry; with `access_denied`, the user declined |
| `no_google_client` | Your scope has no usable Google client | ask Journear |
| `token_invalid`, `token_has_pii` | The Google token failed Journear Passport's checks | retry; report it if it persists |
| `config_mismatch` | Journear Passport's pages disagree about the signer, scope or client, or the scope doesn't match the on-chain registry (`data.reason: 'scope_mismatch'`) | report it to Journear; never retry around it |
| `ckd_failed`, `derive_failed`, `pairing_failed`, `address_mismatch` | The key couldn't be produced (`derive_failed` with `data.reason: 'link_restart'`: a linking login was interrupted and its session revoked; `'webcrypto_unsupported'`: the browser has no Ed25519 in WebCrypto, so Journear Passport can't make the sign-in's session key: Chrome and Edge before 137, Firefox before 129, Safari before 17; `'webcrypto_failed'`: the browser refused to make the key, `data.error` the platform error's name; both in a login, `linkAccount()` and the export window's sign-in) | the user logs in again; with `webcrypto_unsupported`, ask them to update the browser or use another |
| `session_consumed` | Someone replayed the login transaction first | the vault offers "Continue signing in" |
| `rate_limited`, `app_suspended`, `origin_not_allowed`, `api_unavailable` | From Journear Passport's API (`rate_limited` also after 3 key exports of one account in an hour), or NEAR's RPC couldn't be read. `api_unavailable` with `data.reason`: `mainnet_demo_unconfirmed` (Journear's sandbox mainnet demo couldn't be confirmed on, section 12), `email_match_unavailable` (Journear Passport's email service didn't answer for a new Google user), `path_unconfirmed` (a linked sign-in method's wallet couldn't be confirmed on both of Journear Passport's NEAR providers), `path_disputed` (they disagree: report it), `share_unconfirmed` (a signature or an identity token: Journear Passport's API couldn't confirm for 3 minutes that this device is still signed in, "Signed out from Journear Passport" in section 4) | back off, or contact Journear |
| `near_*` reasons, and the codes of `hana.near.relay` and `hana.near.activate` | NEAR: refusals before Journear Passport's window, and Journear Passport's relay (`4100`, `rate_limited` or `api_unavailable` with the API's code in `data.reason`) | the table in [section 8, NEAR](#near-errors) |
| `storage_unavailable` | The Journear Passport popup couldn't store what its next step needs (blocked or full browser storage) | ask the user to allow site data, or try another browser |
| `busy` | An export is already running | wait |
| `identity_unavailable` | `getIdentityToken()`: Journear Passport's API or signer is unavailable, or this browser couldn't keep the session (`data.reason: 'no_share'`) | retry later |
| `session_ended` | `getIdentityToken()`: the Journear Passport session is over (`sessionExpired` fires too; `data.reason: 'signed_out'` when Journear Passport signed this device out), or ends within 30 s (`data.reason: 'session_ending'`) | treat as logged out |

<a id="getting-help"></a>**Getting help.** When a user reports a problem, send Journear the user's Support ID
(`hana.supportId`, section 4) and the failed call's request ID (`error.requestId`; keep the last few in your
diagnostics, as the hosted demo's "Copy diagnostics" does), with the error `code`, when it happened (with the time
zone) and the app. The Support ID finds the user, their logins and sessions; the request ID finds the failed request
itself, which Journear can't find from the user alone. Neither is a credential: no one can act on the user's wallet with
them.

## 14. Security notes for integrators

- Your page never holds a key, a CKD secret or a Google token, and no message to it carries one. Don't try to get
  them; build on addresses and signatures.
- An XSS on your page can start a login, read addresses and queue signature requests. It can't sign anything without
  the user's Approve, except requests inside a policy the user accepted, up to its limits. Keep policies tight.
- Your page holds a handle to the approval popup it opens, as it does for any popup: it could navigate or close it,
  but the popup takes nothing from your page, and users should trust only a window whose address bar shows Journear Passport's
  `authOrigin`.
- Sandbox third-party iframes (ads, widgets, embeds): give them `sandbox` without `allow-top-navigation` and, unless
  they need it, without `allow-scripts` and `allow-same-origin` together. An unsandboxed frame can navigate its
  sibling frames, the Journear Passport vault frame included, and put its own page where the "Review in Journear Passport" launcher was. The
  SDK hides the vault frame and emits `launcher {visible: false}` as soon as its document is replaced (status
  `error`, 4900), but a frame that can do this can also overlay your page, so don't give third parties that power.
- A malicious browser extension can do anything the user can, including reading an exported key. No web wallet
  design prevents that.
- With your own Google client, your client's settings are part of your users' security ([section 6](#6-google-client-shared-or-your-own)).
- Testnet pilot keys are disposable. Until the address freeze, Journear may still change what a key derives from, and
  each such change gives every user new addresses.

## 15. Identity token (your backend)

Your backend can learn **who** the user is in your app, **which wallets** they hold and **which Journear Passport session** a
request belongs to, without calling Journear Passport and without a wallet signature: ask the page for an identity token and verify
it on your server against Journear Passport's published keys. It is the Journear Passport
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
- **Errors.** `getIdentityToken()` resolves `null` while logged out; it rejects with `identity_unavailable` (Journear Passport's API
  or signer is down, or this browser couldn't keep the session in an app that keeps logins: `data.reason: 'no_share'`;
  retry later), `session_ended` (the session is over: `sessionExpired` fires too; `data.reason: 'signed_out'` when
  Journear Passport signed this device out, `'session_ending'` when less than 30 s remain) or `rate_limited` (more than 10 mints a minute for one session or 30 for one user, or your
  app's own identity-token quota: 10 × your plan's per-minute rate a minute and your plan's daily rate an hour, apart
  from the quota your logins and unlocks use).
- **React.** `const { identityToken, refresh, error } = useIdentityToken();` mints on first use while logged in, keeps
  the token fresh (a timer at `exp` − 5 min, only while the page is visible) and re-renders on `identityTokenChanged`.
  `refresh({ maxAgeMs })` gets one now.

### What's in it

An ES256 JWT (`typ: hana-identity+jwt`, `kid` = the key's RFC 7638 thumbprint), valid for at most 1 hour and never
past the Journear Passport session:

| Claim | Value |
|---|---|
| `iss` | `{Hana API}/v1/identity` (sandbox-dev: `https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/identity`; a stable Journear Passport hostname replaces it before any partner goes live) |
| `aud` | your app id (`app_…`), not your publishable key |
| `sub` | `u1_…` (25 characters): stable per user in your app's scope, the same for every login method of their account and after a key rotation; different at every other partner; never the Google `sub`. It is also the user's User ID on the partner portal's **Users** page, and their Support ID `HANA-XXXX-XXXX` is its short form, which you can compute yourself to show beside your own records ([Support ID from the `sub`](#support-id-from-sub)) |
| `sid` | `s1_…`: one per Journear Passport session, shared by its tabs and reloads, new at every interactive login, never repeated |
| `iat`, `exp`, `jti` | seconds; `exp` ≤ `iat` + 3600 and never past the session's end; `jti` is random |
| `wallets` | `[{chain: 'stellar', address: 'G…'}, {chain: 'evm', address: '0x…'}]`, a real JSON array; the holder of this Journear Passport session proved control of each address's key (a signature bound to this session and app). Stellar and EVM only: the user's NEAR account isn't listed (SDK 0.4.0 changes nothing here); prove it with `hana.near.signMessage` ([section 8, NEAR](#near)) |
| `login_methods` | the account's login providers, sorted (`["google"]` today) |
| `email`, `email_verified` | only for a user who shared their address with your app on Journear Passport's sheet ("Email sharing" below): the verified address and `true`. Absent otherwise. Key users on `sub`, not on the address (it can change, and a user can stop sharing) |
| `given_name`, `family_name` | only for a user who shared their name with your app from Passport Home ("The user's name" below), each only when set: the first and last name as the user typed them (at most 50 characters each, one line). Absent otherwise. A display name, not an identity: never key anything on it |

### Email sharing

You see a user's email only after they share it with your app, on Journear Passport's sheet: your app's name and the exact address,
**Share email** / **Not now**. Nothing is mandatory: "Not now" always continues. Your app's **email sharing** setting
(in the partner portal, on the app's **Login & sessions** page) decides when Journear Passport asks:

| Setting | Journear Passport asks |
|---|---|
| Off (default) | never; tokens never carry an email |
| When the app asks (`on_request`) | only when you call `hana.requestEmailSharing()` (e.g. from your own "Use my email" button) |
| At first login (`at_login`) | once per user and app, at their first login, in the sign-in window before `login()` resolves; and from `requestEmailSharing()` |

```ts
// In a click handler, synchronously (it opens Hana's window, like login()).
const state = await hana.requestEmailSharing(); // 'granted' | 'declined' | 'dismissed' (the window was closed)
const token = await hana.getIdentityToken(); // with `email` when granted
```

- Once shared, every new identity token carries `email` and `email_verified: true`; `emailStatus` on Journear Passport's side says
  why a token has none. The **Users** screen of the partner portal shows the address (an Email column, "Not shared"
  otherwise) and finds a user by the full address, only among addresses shared with your org's apps.
- The consent is per app and per account (a linked account has one), for one address: a user who later signs in with
  another address (a linked email) is asked again for that one.
- **Stopping.** The user can stop sharing on the sheet (`requestEmailSharing()` when it is already shared shows "Stop
  sharing") or from the approval window's account line. New tokens and your console then lose the address at once;
  tokens you already received keep it until they expire (≤ 1 h), and the address you stored is yours to delete (your
  terms with Journear require deleting it on request).
- **Required if you use auto-approve.** Users of an app with an auto-approve policy may never see the approval window,
  so if email sharing is on you must give them a visible control (for example "Manage email sharing") that calls
  `requestEmailSharing()`, or they have no way to stop sharing.
- `hana.on('emailSharingChanged', (state) => …)` fires (`'granted'` or `'declined'`) when the user changes it on this
  device; call `getIdentityToken()` again. Errors: `email_sharing_unavailable` (`data.reason`: `off` when your setting
  is off, `no_address` when Journear Passport has no address for this session: ask the user to sign in again, `unavailable`), 4100
  when logged out, `busy` during a sign-in. React: `const { request, state, error } = useEmailSharing();` with
  `<button onClick={request}>`.
- An app on its **own Google client** can read the address from Google whatever the user chooses here; the sheet
  says so.
- SDK 0.3.0 or later (the event and the hook; older SDKs never get the event).

### The user's name

Users can set their own first and last name on Passport Home, Journear's own page, both optional, and choose app by app whether
to share it. Nothing is shared until they turn it on for your app, and they can stop or change it there at any time.
There is no setting on your side and nothing you can ask for: you get the name when the user shared it.

```ts
const profile = await hana.getProfile(); // null while logged out
// { givenName: 'Ada', familyName: 'Lovelace' }, or { givenName: null, familyName: null } when nothing is shared
hana.on('profileChanged', (profile) => render(profile)); // only when the name changes (or at logout: null)
```

- **From the identity token.** The SDK reads `given_name` and `family_name` from the token the page already has: no
  popup, no extra request. In the page, treat it as display data; on your server, read the claims from a token you
  verified ("Verify it" below).
- **When a change shows.** A name the user edits, shares or stops sharing reaches your page at its next identity token:
  up to about 55 minutes later while a token is cached, sooner with `hana.getProfile({ maxAgeMs: 60_000 })` (the same
  `maxAgeMs` as `getIdentityToken`). `profileChanged` fires when a newer token carries a different name. Your
  portal's **Users** screen shows the change at once (a Name column, "Not shared" otherwise).
- **Show it as text.** It is what the user typed (any script, at most 50 characters a part, no control or invisible
  characters), so put it in the page as text, never as HTML. Either part may be missing: some users set only one.
- **Stopping.** A stop removes the name from new tokens and your portal at once; tokens you already received keep it
  until they expire (≤ 1 h), and a copy you stored is yours to delete on request, as for a shared email.
- React: `const { profile, refresh, error } = useProfile();`. Errors are `getIdentityToken()`'s.

What `wallets` proves, and what it doesn't: the session's holder controls each key. It is **not** proof that the
address is the Journear Passport-derived wallet of that `sub`: a user who tampers with their own vault can attach another key they
control (never someone else's address), and one address can appear under several `sub`s (a key the user exported and
reuses elsewhere, an old key after a rotation). So never treat wallet → `sub` as unique, for example for per-wallet
credits or sign-up bonuses: key those on `sub`, and dedupe wallets yourself. If a request must come from one exact
wallet, keep checking that the wallet that authenticated it is in `wallets` (`assertWallet` below).

### Verify it (Node, `jose`)

The JWKS is at `{iss}/jwks.json` (cached 10 minutes; `jose` refetches on an unknown `kid`), the discovery document at
`{iss}/.well-known/openid-configuration`. **For anything of value, pin the key thumbprints** (`HANA_IDENTITY_PINS`
below: each key's thumbprint is also its `kid` in the JWKS): the JWKS is served by Journear Passport's infrastructure, and a pinned
verifier refuses a key whoever controls it publishes, where a verifier that only trusts the URL accepts it until Journear
notices and removes it.

The verifier's three settings, per environment. None is a secret; take the pins from this guide (or from Journear, out of
band), never from the JWKS itself:

| Setting | sandbox-dev |
|---|---|
| `HANA_APP_ID` | your app's id, from the app's page in the partner portal (**App ID**) |
| `HANA_IDENTITY_ISSUER` | `https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/identity` |
| `HANA_IDENTITY_PINS` | `17xAVaTfgwnOkdwq1uOmwHR31pPKB90xw5oGN5HcBgY,_MjNZC3lmy9Xk6LI1mbGVbvtoIfDN557VBZG7DXVQ-g` (the active key and its standby) |

**The verifier refuses to start without all three.** If `audience` were `undefined` (an unset `HANA_APP_ID` on a new
deploy, a typo), `jose` would skip the audience check entirely and accept a valid Journear Passport token minted for any other
partner's app. The code below checks every setting when it loads and throws with the setting's name: an app id that
isn't `app_…` (a publishable key pasted by mistake), a non-`https` issuer, and pins that aren't thumbprints. Pinning is
required the same way: set `HANA_IDENTITY_PINS=jwks-only` to trust the JWKS URL alone, so that a missing variable
never silently drops it. Journear tests this exact code against a local issuer on every change:

```ts
import { calculateJwkThumbprint, createRemoteJWKSet, errors, exportJWK, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

// Not secrets: the app id is on your app's page in the partner portal, the issuer and its key thumbprints in the
// partner guide. All three are required, and the verifier refuses to start without them: with no app id, jose would
// skip the audience check and accept a token minted for any other app.
function setting(name: string): string {
  const value = (process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is not set: the Hana identity-token verifier refuses to start without it`);
  return value;
}
const HANA_ISSUER = setting('HANA_IDENTITY_ISSUER'); // e.g. https://<hana api>/v1/identity
const HANA_APP_ID = setting('HANA_APP_ID'); // app_…
if (!/^app_[A-Za-z0-9]{1,64}$/u.test(HANA_APP_ID)) throw new Error('HANA_APP_ID must be your app id (app_…), not a publishable key');
const issuerUrl = new URL(HANA_ISSUER); // throws on a malformed URL
if (issuerUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(issuerUrl.hostname)) {
  throw new Error('HANA_IDENTITY_ISSUER must be an https:// URL');
}

// The issuer's key thumbprints (comma-separated; each is also its kid). A key that isn't one of them is refused even
// if Hana's JWKS lists it, so a key published by whoever controls Hana's servers never verifies here. Hana announces
// scheduled rotations 14 days ahead. `jwks-only` trusts the JWKS URL alone (not for anything of value); a missing
// value is refused rather than read as "no pins", so pinning can't be dropped by a forgotten variable.
const PINS = setting('HANA_IDENTITY_PINS');
const HANA_PINS = PINS === 'jwks-only' ? [] : PINS.split(',').map((s) => s.trim()).filter(Boolean);
if (PINS !== 'jwks-only' && (HANA_PINS.length === 0 || !HANA_PINS.every((p) => /^[A-Za-z0-9_-]{43}$/u.test(p)))) {
  throw new Error('HANA_IDENTITY_PINS must be key thumbprints (43 base64url characters each, comma-separated) or jwks-only');
}

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
   judged on the key itself (`calculateJwkThumbprint`), never on its `kid`. Refuse to start when the app id or the
   issuer is missing or empty: most JWT libraries, `jose` included, skip a check whose expected value is undefined.
2. Key users by `sub`, not by email or address. Store `sid` to run one session per device and to block a signed-out
   `sid`; a new interactive login always brings a new `sid`. Unlinking a login method later gives a different wallet
   and so a different `sub`: to you that is a different user.
3. The token is evidence of identity at `iat`, not your session: run your own session and end it when your page
   reports a Journear Passport logout (`statusChanged`, `identityTokenChanged(null)`). For sensitive actions require a fresh token
   (`maxAgeSec` here, `maxAgeMs` on the page).
4. Never log tokens; treat them like any bearer credential (≤ 1 h, your app only).
5. On `expired`, answer 401 with a distinct code: the page calls `getIdentityToken()` again and retries once (`null`
   means the user is logged out). On `invalid`, answer 401 and never fall back to "no token".
6. Verifying takes under 1 ms once the JWKS is cached.

Other languages: any JOSE/OIDC library works with the same checks: compact JWS, `alg` ES256 only, a key from the JWKS
by `kid`, `typ` `hana-identity+jwt`, `iss`, `aud`, `exp` (and `iat` for freshness), with up to 30 s of clock skew.

<a id="support-id-from-sub"></a>**The Support ID from the `sub`.** The Support ID `HANA-XXXX-XXXX` the SDK shows
(`hana.supportId`) is computed from the `sub` alone, with no key:

1. Take the 22 characters after `u1_` and decode them as unpadded base64url (RFC 4648 section 5): 16 bytes.
2. Take the first 5 bytes (40 bits) and write them in Crockford base32, most significant bit first, 5 bits per
   character: exactly 8 characters from `0123456789ABCDEFGHJKMNPQRSTVWXYZ` (uppercase; no I, L, O or U; no padding).
3. Write `HANA-`, the first 4 characters, `-`, the last 4.

Test vector: the `sub` `u1_ASNFZ4mrze8BI0VniavN7w` encodes the bytes `0123456789abcdef0123456789abcdef`; its first 5
bytes `01 23 45 67 89` give `04HMASW9`, so its Support ID is `HANA-04HM-ASW9`. In JavaScript, `@hana-id/core` exports
the same function the SDK and Journear Passport use (SDK releases after 0.2.0):

```ts
import { supportIdFromSub } from '@hana-id/core'; // or '@hana-id/core/support-id', which pulls in nothing else
supportIdFromSub('u1_ASNFZ4mrze8BI0VniavN7w'); // 'HANA-04HM-ASW9'; a TypeError for anything that isn't a sub
```

**Key rotation.** Journear publishes a standby key next to the active one, and both are pinned from the start: an
emergency switch to the standby needs nothing from you either way. A scheduled rotation adds a key 14 days ahead of
using it (24 h on testnet), announced to your security contact: add its thumbprint to your pins in that window. A
compromise that exposes both keys means a fresh key you must pin at once (Journear tells you); until you do, a pinned
verifier refuses the new tokens (fail closed) rather than accepting an attacker's.

**Who watches the JWKS.** Journear's independent watchdog, on its own Cloudflare account (sandbox-dev excepted), reads the
JWKS every 5 minutes, and a probe outside Cloudflare reads it every 3 hours (paused while Journear Passport runs on testnet only); either alerts Journear if it ever lists a key
whose thumbprint Journear didn't pin, private key material, or a discovery document with another `issuer` or `jwks_uri`.
That is detection, not prevention, and only of an attacker who serves the same JWKS to everyone: someone who controls
Journear Passport's servers can show the watchdog and the probe a clean JWKS and your verifier another, or publish a key between
two reads. A verifier that only trusts the JWKS URL accepts such a key until Journear notices and removes it (and its
cache expires, ≤ 10 min). Pinned thumbprints are the only defence that doesn't depend on Journear noticing.

### Migrating from Privy

| Privy | Journear Passport |
|---|---|
| access token `sid` | `sid` (same semantics; a Journear Passport session lasts ≤ 12 h by default, 2 h idle) |
| `sub` (`did:privy:…`) | `sub` (`u1_…`, per scope). Users get new wallets with Journear Passport; map existing users to new `sub`s yourself |
| `iss: "privy.io"` | `iss: "{Hana API}/v1/identity"` |
| `aud: <Privy app id>` | `aud: app_…` |
| access + identity token, one key pasted from Privy's dashboard | one identity token, keys from the JWKS URL (and thumbprints pinned from this guide) |
| `linked_accounts` (stringified JSON) | `wallets` (a JSON array), `login_methods` |
| `linked_accounts[type=wallet, chain_type=stellar / ethereum].address` | `wallets[chain=stellar / evm].address` |
| `getAccessToken()`, `getIdentityToken()`, `useIdentityToken()` | `hana.getIdentityToken()`, `useIdentityToken()` |
| `privy-id-token` cookie | a header you send (`Authorization: Bearer`); Journear Passport sets no cookie |
| refresh token | none: the live Journear Passport session refreshes |
