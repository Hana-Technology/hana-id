# Native apps spec: iOS, Android, React Native and Expo (pre-mainnet)

**Status: DRAFT (2026-10-30), for review.** How Hana ID supports partner apps that are not web pages: native iOS
(Swift), native Android (Kotlin) and React Native (bare and Expo). Answers the native-app half of batch B's open
question Q24 ("What should in-app webviews show?") and Sign in with Apple spec Q5 (native iOS). 19
[open questions](#open-questions-for-the-user) for the user; nothing here is decided until they are answered and
recorded in `docs/decisions.md`.

This file becomes the source of truth for the batch once approved. If code and this spec disagree, fix the code or
raise the problem. Reference docs (`architecture.md`, `security.md`, `contract-interface.md`, `api.md`,
`integration.md`, `operations.md`) are updated in the same branches as the code, not now.

## Contents

- [Summary](#summary)
- [Goals and non-goals](#goals-and-non-goals)
- [Address impact (read first)](#address-impact-read-first)
- [Current state (why it is web-only)](#current-state-why-it-is-web-only)
- [The central problem: no origin boundary inside an app](#the-central-problem-no-origin-boundary-inside-an-app)
- [Platform facts (checked 2026-10-30)](#platform-facts-checked-2026-10-30)
- [How other embedded-wallet providers do it](#how-other-embedded-wallet-providers-do-it)
- [Options](#options)
  - [A. Hana in the system browser (sheets)](#a-hana-in-the-system-browser-sheets)
  - [B. App-held keys (Privy-style native SDK)](#b-app-held-keys-privy-style-native-sdk)
  - [C. Hand-off to a Hana app](#c-hand-off-to-a-hana-app)
  - [D. Other options and hybrids](#d-other-options-and-hybrids)
  - [Comparison](#comparison)
- [Recommendation](#recommendation)
- [Design of option A](#design-of-option-a)
  - [Native apps in the app registry](#native-apps-in-the-app-registry)
  - [The sheet host page](#the-sheet-host-page)
  - [Login](#login)
  - [The companion key](#the-companion-key)
  - [Signing](#signing)
  - [Auto-approve](#auto-approve)
  - [Persistence, logout and revoke](#persistence-logout-and-revoke)
  - [Identity token](#identity-token)
  - [Email login](#email-login)
  - [Sign in with Apple](#sign-in-with-apple)
  - [Key export and Hana Home](#key-export-and-hana-home)
  - [Offline, errors and recovery](#offline-errors-and-recovery)
  - [Latency budget](#latency-budget)
- [SDK surface](#sdk-surface)
- [Option B, if chosen later](#option-b-if-chosen-later)
- [Google clients on native](#google-clients-on-native)
- [App Store and Play review](#app-store-and-play-review)
- [Webviews (Q24's other half)](#webviews-q24s-other-half)
- [API changes](#api-changes)
- [Web (vault and auth pages) changes](#web-vault-and-auth-pages-changes)
- [Contract](#contract)
- [Threat model](#threat-model)
- [Invariants](#invariants)
- [Tests](#tests)
- [Build order](#build-order)
- [Docs to update when built](#docs-to-update-when-built)
- [Sources](#sources)
- [Open questions for the user](#open-questions-for-the-user)

## Summary

The web design's promise, "the partner never sees a user's key", rests on the browser keeping the partner page and
Hana's vault iframe apart. Inside a native or React Native app nothing does: the app owns any WebView it shows
(it can inject script into every frame and, on Android, replace any response), it can send any `Origin` header, and
Google refuses sign-in in embedded WebViews anyway. So the question is only **where Hana's code can run out of the
partner app's reach**. Three places exist: the platform's system browser sheet, another app signed by Hana, or the
partner app itself (which gives up the promise).

Recommended ([Q1](#open-questions-for-the-user)):

1. **Build option A first: Hana in the system browser.** Login, approvals, consent and export run on Hana's own
   origins in `ASWebAuthenticationSession` (iOS) and Chrome's Auth Tab, falling back to a Custom Tab (Android). The
   vault runs inside that sheet, with its encrypted record in the browser's storage exactly as on the web. The
   partner app gets addresses, signatures and identity tokens, never a key or a Google token. Same scope, same path,
   same addresses as the partner's website; shared and own Google clients both work; Google's web flow runs in a real
   browser, so no native Google client is needed. **No contract change, no derivation change.**
2. The app holds one small credential of its own, a **companion key** (Secure Enclave / Android Keystore, non-exportable),
   bound to the Hana share at login. It lets the app mint identity tokens, post signing requests and log out without
   opening a sheet. It can't unlock the key or sign.
3. The app is identified the way a website is identified by its origin: by a **verified https return link**
   (an associated domain on iOS 17.4+, a Digital Asset Links-verified App Link for Auth Tab), registered per app
   like an origin. Custom URL schemes are for test apps in `sandbox-*` only ([Q4](#open-questions-for-the-user)).
4. Per signature the user sees one Hana sheet (about 1–2 s to the approval screen) and taps Approve. That costs a
   little more than a web popup, and on iOS also a system "wants to use … to sign in" alert per sheet
   ([Q2](#open-questions-for-the-user)). Auto-approved requests still flash a sheet that closes itself
   ([Q7](#open-questions-for-the-user)).
5. **Option B (keys in the partner app, the brief's "Privy-style" SDK; in fact closest to Web3Auth)** is specified as a later, explicit opt-in for Enterprise scopes
   with their own Google client and no shared login, because it moves the user's key into the partner's process
   ([Q9](#open-questions-for-the-user)). **Option C (a Hana app)** waits until a Hana consumer app has real installs
   ([Q10](#open-questions-for-the-user)). A vault in a hidden WebView is rejected.

First SDK: React Native / Expo (a JS package plus a small native module and an Expo config plugin), then Swift and
Kotlin packages over the same protocol ([Q11](#open-questions-for-the-user)). Option A is about 7k lines and five
weeks of work, after a two-day spike that settles the browser behaviours this spec can't verify from documentation
([Build order](#build-order)).

## Goals and non-goals

Goals:

1. A partner's iOS, Android, React Native or Expo app logs a user in with Google (and later email and Apple), gets the
   same Stellar and EVM addresses the user has in the partner's web app, and gets signatures the user approved.
2. The web trust model holds unchanged: neither the partner app nor the partner can read a key, a Google token or a
   nonce, and every signature needs a guarded Approve on a Hana screen unless it falls under an accepted auto-approve
   policy.
3. A malicious app can't pose as another partner's app (the native twin of the origin allowlist).
4. Signing interfaces partners already use: an EIP-1193 provider (so viem, wagmi, ethers and Reown-style libraries
   work in React Native), a Stellar signer, raw sign, the identity token, the same error codes.
5. No contract or derivation change; nothing that alters an existing address.
6. Production standards: tests for every behaviour, including on simulators and emulators in CI.

Non-goals (v1):

- Keys in the partner app (option B) and a Hana app (option C): specified, not built.
- Native Google, Apple or passkey sign-in inside the partner app.
- Flutter, Unity, .NET MAUI, desktop apps (Electron, Tauri). The protocol is platform-neutral, so these can follow.
- Mobile **web** (Safari and Chrome on phones, the other half of Q24): the existing web SDK; its popup and launcher
  behaviour is checked by its own device test ([Webviews](#webviews-q24s-other-half)).
- Background signing (a signature without any Hana screen while the app is in the background), push-triggered
  signing.

## Address impact (read first)

**None.** Option A runs the existing vault code, the existing `/v1/login` and `create_session_and_derive`, the
pinned signer and CKD key, derivation v1 and the path `scope#provider#sub#key_index`. A user who logs in to the
partner's app and to its website gets the same addresses, because both use the app's scope and Google's `sub`, and
the path holds no client ID or platform.

Things that **would** give a user a different wallet, and that this spec therefore refuses or flags:

| Would-be change | Effect | Here |
|---|---|---|
| Native Sign in with Apple in a partner's app | Apple's `sub` is per developer team, and a partner's app is in the partner's team: other `sub`s, other wallets than Hana's Apple clients give (Apple spec, D124) | refused: Apple runs as a web flow in the sheet |
| A native app in its own scope | Another scope is another wallet | the app joins the scope of the partner's web app |
| A Google client in another Cloud project | none: Google's `sub` is the same for every client (`subject_types_supported: ["public"]`, and Hana's own cross-project test, D42) | allowed (option B) |
| A P-256 session key from the Secure Enclave (option B variant) | none: the session key isn't in the path; it would be an additive contract change | not proposed |

## Current state (why it is web-only)

Verified against `develop` at 997e3e1:

- The partner page mounts `{vaultOrigin}/vault?pk=…` as a hidden iframe (`packages/web/src/client/client.ts`,
  `vault-connection.ts`). The vault page's `frame-ancestors` lists the app's D1 origins; the vault sends
  `x-hana-parent-origin` and the API checks it against `app_origins` (`apps/api/src/vault/endpoints.ts`,
  `parentOriginAllowed`). Shares are bound to that partner origin (`vault_shares.partner_origin`, and the share
  creation message signs it).
- Login and approval run in popups on `authOrigin` opened with `window.open` in the click (D99); they find the vault
  through `window.opener.frames[v]` and authenticate it by `event.origin` and `event.source`. The Google token comes
  back to `/login/callback` (implicit flow, fragment) and reaches the vault only through the end-to-end encrypted
  `LoginRelay`.
- The vault keeps its record (non-extractable session `CryptoKeyPair`, `ct = AES-GCM(K_s, PRK)`) in IndexedDB on
  `vaultOrigin`, partitioned by the top-level site; `K_s` comes from `POST /v1/vault/unlock`, signed by the session
  key. Sessions default to 12 h absolute, 2 h idle (D43), capped below 24 h by the vault.
- The API's `Origin` checks (`apps/api/src/origins.ts`) are facts only browsers enforce. What actually protects a
  share is the session key's signature; what protects a login is the token's nonce, which only Hana's pages choose
  in shared mode.
- `docs/integration.md` §5 lists in-app browsers as unsupported (Google answers `disallowed_useragent`). There is no
  native SDK. The admin CLI already lets a scope hold iOS or Android Google clients and pins the web one for the
  popup (`app:settings --google-web-client`, `apps.google_web_client_id`), but nothing uses native clients.

## The central problem: no origin boundary inside an app

What a partner app controls, by surface:

| Surface | What the app can do | Consequence for a Hana vault there |
|---|---|---|
| `WKWebView` (iOS) | `WKUserScript` with `forMainFrameOnly: false` runs in every frame, cross-origin iframes included; `evaluateJavaScript(_:in:in:contentWorld:)` targets any frame; message handlers see whatever scripts post | reads PRK out of the vault iframe's memory |
| Android `WebView` | `shouldInterceptRequest` sees and can answer every request of every frame, https included; `addDocumentStartJavaScript` with origin rules injects into iframes | replaces the vault bundle with its own |
| React Native | `react-native-webview` is one of the two above | same |
| Network | a native HTTP client sends any `Origin`, `Referer` or header | the API's origin rules mean nothing for native callers |
| The system browser sheet (`ASWebAuthenticationSession`, `SFSafariViewController`, Custom Tabs, Auth Tab) | open it with a URL of its choosing; on iOS dismiss it; nothing else: the content runs in the browser's process and the app "can't access … website data" (Apple) | **out of the app's reach** |
| Another app (Hana's) | open it with a URL | out of reach |

So any design that keeps the web promise runs Hana's key code in the sheet or in a Hana app, and treats everything
that comes from the partner app (URLs, request bodies, headers) as untrusted, as the web design treats the partner
page. And because Google requires a real browser for OAuth ("must not direct a Google OAuth 2.0 authorization request
to an embedded user-agent under the developer's control"), the sheet is also where Google's own web sign-in works.

## Platform facts (checked 2026-10-30)

Primary sources unless marked *secondary* or *inferred*; the spike ([Build order](#build-order) step 0) checks every
*inferred* row before code depends on it.

### Google sign-in

| Fact | Source |
|---|---|
| OAuth requests must not go to "an embedded user-agent under the developer's control"; embedded WebViews get `disallowed_useragent`. Google Sign-In for iOS, AppAuth and SFSafariViewController are named as supported; Custom Tabs and SFSafariViewController were the 2016 recommendation (RFC 8252) | developers.google.com/identity/protocols/oauth2/policies; …/oauth2/native-app; developers.googleblog.com 2016-08 |
| The same policy page says to create a separate client per platform and "should not use a 'web' client type for your native Android or iOS app" | …/oauth2/policies |
| `sub` is "unique among all Google Accounts and never reused"; Google's discovery document declares `subject_types_supported: ["public"]` (not pairwise), so every client in every project sees the same `sub`. Hana tested this across two projects (D42, `docs/context.md` spike) | developers.google.com/identity/openid-connect/openid-connect; accounts.google.com/.well-known/openid-configuration |
| GoogleSignIn-iOS accepts a caller nonce from **9.0.0** (2025-07): `signIn(withPresenting:hint:additionalScopes:nonce:completion:)`; 10.1.0 (2026-10-23) fixed a custom nonce lost after a Device Policy app restart | github.com/google/GoogleSignIn-iOS releases, `GIDSignIn.h` |
| With `GIDConfiguration.serverClientID` set, that ID "will be returned as the `audience` property" of the ID token; without it `aud` is the iOS client ID (*secondary*) | `GIDConfiguration.h` |
| GoogleSignIn-iOS runs through AppAuth, which uses `ASWebAuthenticationSession` (an https callback on iOS 17.4+) | AppAuth-iOS `OIDExternalUserAgentIOS.m` |
| Android Credential Manager: `GetGoogleIdOption.Builder.setServerClientId` "the audience for Google ID tokens" (the **web** client ID), `setNonce` "the nonce to use when generating a Google ID token"; the Android client (package name + SHA-1) authorizes the app but isn't the `aud` | developer.android.com/identity/android-credential-manager …/GetGoogleIdOption.Builder; …/credential-manager-siwg-implementation; …/identity/authorization |
| Custom URI scheme redirects are no longer supported for Android and Chrome app clients ("risk of app impersonation"); loopback redirects are deprecated for Android, Chrome app and iOS clients | …/oauth2/native-app (updated 2026-10-29) |
| The React Native Google Sign-In module accepts a `nonce` only in its paid "Universal Sign-In" edition (*secondary*) | react-native-google-signin.github.io/docs/security |

### System browser sheets

| Fact | Source |
|---|---|
| `ASWebAuthenticationSession` (iOS 12+), non-ephemeral (the default): shares Safari's persistent cookies; "all cookies except session cookies are available". That IndexedDB and localStorage are Safari's too is *inferred*; Apple's SFSafariViewController page says "to share data between your app and Safari, use ASWebAuthenticationSession" | developer.apple.com …/authenticating-a-user-through-a-web-service; …/sfsafariviewcontroller |
| `prefersEphemeralWebBrowserSession = true` (iOS 13+): no cookies or other browsing data shared with the user's browser session; nothing persists | …/prefersephemeralwebbrowsersession |
| A non-ephemeral session shows a system alert "“App” Wants to Use “domain” to Sign In" at every start (*known behaviour; wording checked in the spike*) | — |
| `ASWebAuthenticationSession.Callback.https(host:path:)` (iOS 17.4+): the session completes on an https URL; the host must be in the app's `webcredentials` associated domains (*secondary*), so only the app that owns the domain can use it. Earlier iOS: custom scheme only | …/callback/https(host:path:) |
| `SFSafariViewController`: the app "can't access … website data"; it "may not hide or obscure" the controller. Since iOS 11 each app's controller has its own persistent cookie and data store, separate from Safari (*secondary*). No completion callback: a page returns by navigating to the app's link, or the app dismisses it | …/sfsafariviewcontroller; AppAuth-iOS issue 57 |
| ITP deletes script-writable storage (IndexedDB, localStorage) after seven days of Safari use without interaction with the site; not stated for the sheets (*assume it applies*). Irrelevant to sessions under 24 h | webkit.org/blog/10218 |
| Custom Tabs: "powered directly by the user's preferred browser", "shared cookie jar and permissions model": storage is the browser's, per browser, not per app | developer.chrome.com/docs/android/custom-tabs |
| **Auth Tab** (Chrome 137+, `AuthTabIntent`): returns the redirect to the calling activity; "for redirects using the https schema, the browser verifies that the redirect domain and client app are owned by the same publisher" (Digital Asset Links); custom schemes supported; falls back to a Custom Tab where unsupported | …/custom-tabs/guide-auth-tab |
| Ephemeral Custom Tabs (Chrome 136/137, alpha API): nothing persists beyond the tab | …/guide-ephemeral-tab |
| Partial Custom Tabs: bottom sheet from Chrome 107, at least 50 % height | …/guide-partial-custom-tabs |
| Chrome partitions iframe storage (IndexedDB, localStorage, BroadcastChannel, Web Locks, …) by top-level site since Chrome 115, as on desktop; third-party cookies stay on by default | privacysandbox.google.com/cookies/storage-partitioning; …/blog/privacy-sandbox-next-steps |
| No sheet keeps running after it is dismissed; nothing of Hana's can run in the background (*inferred*) | — |

### App identity, passkeys, attestation

| Fact | Source |
|---|---|
| Universal Links: `apple-app-site-association` at `/.well-known/` per host; App Links: `assetlinks.json` with `handle_all_urls` and the signing certificate's SHA-256 | developer.apple.com …/supporting-associated-domains; developer.android.com/training/app-links/verify-android-applinks |
| An app can use a passkey RP ID only if that domain's AASA (`webcredentials`) or `assetlinks.json` (`get_login_creds`) lists the app; only privileged browsers may assert other origins | …/supporting-associated-domains; developer.android.com/identity/credential-manager/prerequisites; …/privileged-apps |
| WebAuthn PRF: iOS 18+ (`ASAuthorizationPublicKeyCredentialPRFAssertionInput`); Android via Credential Manager depending on the provider (*secondary*) | developer.apple.com …/prfassertioninput; developer.android.com/jetpack/androidx/releases/credentials |
| App Attest (`DCAppAttestService`): a Secure Enclave key Apple certifies as belonging to "a valid instance of your app"; not in the Simulator | developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity |
| Play Integrity: `appIntegrity` `PLAY_RECOGNIZED` with package and certificate, request binding by `requestHash`; 10,000 requests a day by default | developer.android.com/google/play/integrity/overview |

### Store rules

| Rule | Text (App Review Guidelines, last updated 2026-10-16; Play Console Help) |
|---|---|
| App Store 4.8 Login Services | An app using a third-party or social login "(such as … Google Sign-In …)" for the primary account "must also offer as an equivalent option another login service" that limits data to name and email, lets users keep their email private, and doesn't track for ads without consent. Exemptions: the company's own account system, alternative marketplaces, education/enterprise, government e-ID, a client for a specific third-party service |
| App Store 3.1.5(i) | "Wallets: Apps may facilitate virtual currency storage, provided they are offered by developers enrolled as an organization." (iii) exchanges only where licensed; 3.1.1 bars crypto as a way to unlock app features |
| App Store 2.5.2 | apps "may not download, install, or execute code which introduces or changes features or functionality" (relevant to over-the-air JS updates, option B) |
| App Store 5.1.1(v) | account deletion in the app; apps "may not store credentials or tokens to social networks off of the device" ([App Store and Play review](#app-store-and-play-review)) |
| Google Play, Crypto Exchanges and Software Wallets | declared in the Financial Features declaration; per-country licensing (US MSB + state licences, UK FCA, EU MiCA CASP) for custodial services; an option "my app is a non-custodial software wallet" (*secondary: non-custodial wallets out of scope of the licence rows*) |

## How other embedded-wallet providers do it

From the providers' own docs (2026-10-30; URLs under [Sources](#sources)). None claims isolation from the partner
app on native. They fall into three patterns: the key in a remote TEE or MPC with the app holding a device
credential that **authorizes signing** (Turnkey, Coinbase CDP, Privy's default, Magic, Dynamic's server share); the
provider's web wallet in a **WebView inside the app** (Magic's Relayer, Dynamic's React Native signer, Privy's older
on-device mode); or the **key returned to app code** (Web3Auth).

| Provider | Where the key lives on native | Login | Signing UI | Can the partner app get the key or a signature? |
|---|---|---|---|---|
| Privy | TEE by default; the Swift SDK signs its authorization requests with a CryptoKit P-256 key ("replacing the webview signer"); React Native uses an "embedded wallet WebView" (its changelog fixed "wallet WebView messages being accepted from untrusted origins"); on-device mode keeps a share in iframe/WebView storage | System browser (`expo-web-browser`) and a custom scheme; an "app client" with "Allowed app identifiers" (bundle ID / package; empty = all refused) and "Allowed URL schemes"; native Sign in with Apple; Expo dev build required | Drawn by the app (React Native components, Swift "whitelabel by default"); key export through a hosted page in an in-app WebView ("use incognito or non-persistent storage") | Not the raw key in TEE mode; **any signature**, silently, with the authorization key it holds |
| Web3Auth / MetaMask Embedded Wallets | The full key is given to app code (`getPrivateKey()`, `getEd25519PrivateKey()`); session in Keychain / encrypted shared preferences | In-app browser / Custom Tabs, redirect `{bundleId}://auth` allowlisted; or "Single Factor Auth" with the partner's own Google token (no browser); no Expo Go | Optional screens in a WebView, else the app signs locally | **Yes, the key** (unless "Disable Private Key Export") |
| Dynamic | MPC: a user share on the device (Keychain, Tink), the server share in a TEE; React Native "signs inside a WebView" whose host origin must be allowlisted; no Expo Go | `react-native-inappbrowser-reborn` / Custom Tabs; deep links allowlisted | Built-in auth UI; no signing UI documented | The device share sits in the app's process; signatures through its WebView |
| Magic | Magic's TEE key management, driven through a `react-native-webview` "Relayer" the app renders; export and settings as in-app iframes | `loginWithPopup` via `expo-web-browser`; optional bundle ID / application ID allowlist | Opt-in signature UI; "Sign Confirmation" moves signing "to a safe, Magic-hosted browser window" against "front-end attacks", off by default, native behaviour not stated | Not the key; drives the WebView |
| Turnkey | Enclave; the app holds a P-256 session key (Secure Enclave when available, non-exportable); "anyone who is able to access this client-side API key has full access to a User" | Always an in-app or system browser; "the public key as the nonce for the OAuth request" binds the token to the device key; native Sign in with Apple; Expo prebuild | None: the app calls `signRawPayload` | Not the key; **any signature** within the session's policies |
| Coinbase CDP | Nitro TEE; a "Temporary Wallet Secret" on the device; opt-in App Attest / Play Integrity "legitimate, unmodified build" checks | Custom deep-link scheme; managed and bare Expo | App-drawn | Any signature within its session |
| Para | 2-of-2 MPC, device share in Keychain / AsyncStorage, the other in Para's HSMs | `react-native-inappbrowser-reborn`, custom scheme | App-drawn | The device share and signatures |

What Hana takes from this:

- **Everyone keeps Google out of WebViews** (system browser or the partner's own native token), as Hana must.
- **Everyone registers the native app** (bundle ID, package, URL scheme): Hana's native app registry is the same idea,
  with https returns instead of schemes for live apps (Google itself dropped custom schemes for Android clients
  because of app impersonation).
- **Turnkey's nonce binding** (OAuth nonce = the device key) is what Hana's session nonce already does.
- **No provider gives native apps the web guarantee.** The common native model is "the app can't read the key but can
  make it sign anything", with the confirmation screen drawn by the app. Option A is stricter than all of them: the
  app gets a signature only after an Approve on Hana's page. Option B would be roughly Web3Auth's model; a
  TEE-backed variant (Privy, Turnkey) is a different product (D5).

## Options

Each option below is judged on: security model, UX per login and per signature, persistence, latency, offline
behaviour, store-review risk, effort, and what changes on chain and on the server.

### A. Hana in the system browser (sheets)

The partner app opens a Hana URL in the platform's sheet for login and for every approval; Hana's vault runs inside
the sheet with its record in the browser's storage; results come back over a verified link or a server relay.

**Security model.** The web model, with the sheet in the role of the browser tab: the partner app is the partner
page (untrusted, sees addresses and signatures). Hana's code runs only on `authOrigin` and `vaultOrigin`, in the
browser's process. Two things are new and need their own mechanism: the app's identity (a website has an origin;
an app has a verified https link, [Native apps in the registry](#native-apps-in-the-app-registry)), and a credential
the app holds between sheets ([the companion key](#the-companion-key)), which can't reach a key.

**Storage per platform** (decides persistence between sheets):

| Sheet | Where the vault record lives | Persists between sheets | Shared with | Prompt per open |
|---|---|---|---|---|
| iOS `ASWebAuthenticationSession`, non-ephemeral | Safari's website data (*inferred*) | yes | Safari and every app's non-ephemeral sessions | yes, "“App” Wants to Use “…” to Sign In" |
| iOS `ASWebAuthenticationSession`, ephemeral | memory | **no**: every sheet is a full login | — | no |
| iOS `SFSafariViewController` | the app's own store | yes, across launches | nobody | no |
| Android Auth Tab / Custom Tab | the user's default browser profile (Chrome, Samsung Internet, Firefox) | yes, while the user keeps that browser | that browser, every app's tabs | no |
| Android ephemeral Custom Tab | memory | **no** | — | no |

Records are keyed by `signer | appId | scope | keyIndex` and need a share bound to the app, so sharing a store
across apps reveals nothing: another app's sheet can't unlock a record of this app, and records of two apps never
mix (the share check, [Threat model](#threat-model)). Because the vault is framed by Hana's host page, its storage
partition is `authOrigin`'s site: the native records are separate from the user's website records in the same
browser, which is fine (one more share, same wallet).

**UX.** Login: the app's button opens the sheet; Google's account chooser (one tap with a signed-in Google account in
that browser store, else the usual sign-in); about 7–9 s of chain work with a progress screen (as the web popup);
the sheet closes and the app has the addresses. Per signature: the sheet opens on the Hana approval screen, the user
reviews and taps Approve (the D36 guard), the sheet closes. On iOS with `ASWebAuthenticationSession` the system
alert adds a tap to both ([Q2](#open-questions-for-the-user)).

**Persistence.** As on the web: the session survives app restarts and sheet closes within the app's idle and absolute
limits (default 2 h and 12 h, D43), since the record stays in the browser store and the share in D1. After expiry,
logout, a cleared browser, or (Android) a changed default browser: a new login. Mobile users expect weeks-long
sessions; longer native sessions are [Q8](#open-questions-for-the-user).

**Latency.** Per signature about 1–2 s from tap to approval screen (sheet animation, cached bundles, one unlock
round trip), then the guard's 1 s; [Latency budget](#latency-budget). Login: the web login plus about 0.5 s.

**Offline.** Nothing works without network, as on the web (unlock is an API call). Addresses and the session's
expiry stay known to the app.

**Store review.** Low. Sheets for third-party sign-in are what Apple and Google recommend; the partner's app is the
wallet offered by an organization (3.1.5(i)); 4.8 needs an equivalent login next to Google, so App Store apps need
Hana's Apple login ([Sign in with Apple](#sign-in-with-apple)). One point to argue: Google's "don't use a web client
for native apps" rule. Hana's client is a web client used by Hana's website in a real browser; the native app never
talks to Google. That is the case the rule allows (the authorization request goes to the system browser), but a
reviewer could read it otherwise ([App Store and Play review](#app-store-and-play-review)).

**Effort.** About 7k lines, five weeks ([Build order](#build-order)). Most work is new surfaces around the existing
vault: the host page, the native app registry, the companion key and request relay, three SDKs.

**On chain and server.** Nothing on chain. Server: a native app registry next to `app_origins`, the companion key on
shares, a request relay Durable Object, the identity token endpoint accepting the companion key, the vault gate
accepting a native parent.

**Weak points.** A sheet per signature (more chrome than a popup, and iOS's alert); auto-approve isn't silent;
sessions as short as the web's; Android's storage depends on the user's browser; iOS's
`ASWebAuthenticationSession` storage is *inferred* to include IndexedDB until the spike confirms it.

### B. App-held keys (Privy-style native SDK)

"Privy-style" is the brief's name; Privy's native SDKs in fact keep the key in a TEE and give the app an
authorization key ([How others do it](#how-other-embedded-wallet-providers-do-it)), so the model here is closest to
Web3Auth's. The partner app runs Hana's login itself: native Google sign-in (GoogleSignIn-iOS ≥ 9.0 or Credential Manager) with a
nonce committing to a session key the app made, `/v1/login`, the CKD decryption and derivation v1 in the app; PRK
kept in the Keychain or Keystore, wrapped by a Secure Enclave or StrongBox key; signing and the approval screen in
native UI.

**Security model: the partner becomes a key holder.** The partner's binary, every SDK in its process (analytics,
crash reporters that capture memory), its build pipeline and, for React Native, its over-the-air JS updates (Expo
Updates, CodePush: new code without App Review) can read PRK. The approval screen and auto-approve policies become
UX, not a boundary: the app can sign anything at any time. This is the same power D42 already concedes to a partner
that holds its own Google client ("whoever controls that Google project can derive its users' keys"), but there it
needs deliberate abuse; here it is the normal path.

**Which scopes it can work for.** Only scopes with their **own** Google client:

- Native Google sign-in issues a token whose `aud` is the client the app names, with any nonce the app chooses. With
  the shared client that nonce can name **any** `allow_shared` scope (the shared client's scope comes from the
  nonce), so one partner app holding a native client in Hana's shared project could derive the keys of every
  shared-login partner's users. Hana's shared Google project must therefore never hold an iOS or Android client
  ([Invariants](#invariants)).
- A scope that also has `allow_shared` makes the same wallet reachable from the web through Hana (and from Hana Home)
  and from the app with app-held keys: the wallet is only as safe as the app, on every surface. So option B also needs
  the scope to have no shared login, or a clear statement in Hana Home that "{app} can access this wallet's key".

**UX.** Best of all options: native Google sheet once (Credential Manager's bottom sheet, GoogleSignIn's
`ASWebAuthenticationSession`), native approval screens or none, silent auto-approve, sessions as long as the partner
wants, offline signing.

**Persistence.** In the Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) or Keystore. A server share (D22)
can still gate it, so that logout-everywhere, idle limits and app suspension keep working ([Option B, if chosen
later](#option-b-if-chosen-later)).

**Store review.** Low for Hana (it ships a library); the partner's app is a self-custody wallet with its own
key-handling code (3.1.5(i) organization; Play's non-custodial declaration).

**Effort.** About 8–10 weeks plus an external audit of the native key code: CKD (BLS12-381 pairing) and derivation v1
in Swift and Kotlin (or one Rust core through UniFFI, or `@hana-id/core` in Hermes for React Native), native
decoders and approval UI per chain, Keychain/Keystore code, a new caller kind in the API with app attestation.

**On chain and server.** No contract change: Android tokens carry the scope's web client as `aud` (already
registered); iOS tokens do too when `serverClientID` is the scope's web client, otherwise the iOS client is added with
`propose_change AddClient` and a client proof (needs GoogleSignIn-iOS 9.0's nonce). Server: a native `/v1/login`
caller kind, App Attest / Play Integrity checks.

### C. Hand-off to a Hana app

The partner app opens a Hana-published app (the existing "Hana Wallet" app in Hana's Apple developer account, or a
new "Hana ID" app) through a universal link / App Link; it logs in (native Google sign-in in Hana's own Cloud
project) and approves, then returns the result to the partner app's registered link.

**Security model.** Strong: Hana's code in Hana's binary, under Hana's signing identity; keys in Hana's Keychain or
Keystore. The Hana app plays the vault. On Android the Hana app can even learn the caller (`getCallingPackage()` with
an activity result); on iOS it can't (`sourceApplication` is empty for apps of other teams since iOS 13), so the return link is the binding,
as in option A.

**UX.** Poor for onboarding: a user without the Hana app must install it first (an App Store detour in the middle of
the partner's sign-up), and every signature switches apps and back. Fine for users who already have it.

**Persistence and latency.** Native and long; about 0.5–1 s per app switch.

**Store review.** The Hana app is itself a wallet (3.1.5(i), organization: met by Hana's account; Play's
Financial Features declaration); its use of Google sign-in triggers 4.8 for the Hana app (Hana's Apple login).
The app must have its own value beyond being a signer for others, or review may call it a "shell".

**Effort.** Option B's native key code **plus** a consumer app (store listings, support, updates), about 3 months.

**On chain and server.** Hana's app needs a native client in a Hana project. If that is the shared project, the
Hana app can open sessions for every `allow_shared` scope: acceptable only because Hana already runs the vault code,
but it puts Hana's app in the trusted computing base of every shared scope (an extra root next to the pages).

### D. Other options and hybrids

| Option | What it is | Verdict |
|---|---|---|
| D1. Vault in a hidden WebView (Magic-style relayer webview), Google login in a sheet | The web SDK unchanged inside a `WKWebView` / Android `WebView` | **Rejected.** The app controls the WebView (table above): option B's trust with none of its UX, and a false impression of isolation |
| D2. Passkey-sealed record (WebAuthn PRF) | In the sheet, on Hana's RP ID, a passkey's PRF output wraps the vault record or a server-held blob. The partner app can't use Hana's RP ID (Hana's AASA / assetlinks list no partner app), so the passkey is a factor only Hana's pages have | **Later hybrid** ([Q15](#open-questions-for-the-user)). It would allow ephemeral sheets (no iOS alert, no browser-storage dependence), sessions longer than 24 h, and Face ID as the Approve. Costs: a passkey creation step, PRF support uneven on Android and third-party password managers, a new trust question (a long-lived PRF-sealed PRK) |
| D3. Android Credential Manager for Google | The native Google bottom sheet | Only with option B (the token goes to the app). Not for A |
| D4. Delegated on-chain session keys (Stellar account signers, EVM smart accounts / EIP-7702) | The vault, in a sheet, authorizes a limited key the app holds; the chain enforces the limits | **Later**, per chain. It is the only way to silent, limited signing without trusting the app; out of the MVP (chain-specific, changes what an address is on EVM) |
| D5. Remote signer in a TEE (Privy/Turnkey-style enclave) | The key lives in a Hana enclave; the app authenticates to it | **Rejected for now**: a new trust root next to the MPC; Hana's model is "Hana's servers never hold a key". Whether to offer it later as a separate opt-in tier is [Q19](#open-questions-for-the-user) |
| D6. App Clip (iOS) | A small Hana-signed binary launched from a link without installing | **Not pursued**: invocation from another app shows an App Clip card, storage and Keychain lifetimes are limited, and it is option C's trust with option A's friction |
| D7. Hybrid A + B per scope | A for every app; B as an explicit Enterprise opt-in | **Recommended path** ([Q9](#open-questions-for-the-user)) |
| D8. Hybrid A + C | A by default; if the Hana app is installed, hand off to it instead | Later, if C ever exists ([Q10](#open-questions-for-the-user)) |

### Comparison

| | A. Sheets | B. App-held keys | C. Hana app |
|---|---|---|---|
| Partner can read keys | no | **yes** | no |
| Same addresses as the partner's website | yes | yes (own-client scope) | yes |
| Works with Hana's shared Google client | yes | **no** | yes |
| Login | sheet + Google chooser + ~8 s | native Google sheet + ~8 s | install (first time), app switch, ~8 s |
| Per signature | sheet, ~1–2 s, Approve (+ iOS alert) | native, instant | app switch, ~1 s, Approve |
| Auto-approve | sheet flashes and closes | silent (but unenforced) | app switch |
| Session length | web limits (≤ 24 h today) | any | any |
| Offline signing | no | yes | yes |
| Store risk | low | low (partner is a self-custody wallet) | medium (a second wallet app) |
| Contract change | none | none | none |
| Effort | ~5 weeks | ~8–10 weeks + audit | ~3 months + an app to run |

## Recommendation

Build **A** for all three platforms first ([Q1](#open-questions-for-the-user)), because it is the only option that
keeps the property Hana sells ("the partner never sees a key") while working for every scope, including the shared
default, with no contract change and with the existing vault code. Its costs are UX costs (a sheet per signature,
iOS's alert, web-length sessions) and can be reduced later without changing the model: the passkey hybrid (D2) for
longer sessions and fewer prompts, delegated session keys (D4) for silent limited signing. Keep **B** as a later,
contract-free opt-in for Enterprise scopes that accept the trust change in writing ([Q9](#open-questions-for-the-user)).
Don't build **C** until a Hana consumer app exists for its own reasons ([Q10](#open-questions-for-the-user)).

## Design of option A

### Native apps in the app registry

A native app is registered on the D1 app like an origin, by Hana (admin CLI now, the console in batch C):

```
app_native_apps(app_id, platform 'ios' | 'android', app_ref, return_url, created_at)
  ios:     app_ref = "<TeamID>.<bundle id>"                      e.g. "ABCDE12345.com.partner.app"
  android: app_ref = "<package>:<SHA-256 of the signing cert>"   e.g. "com.partner.app:9F:3A:…"
  return_url = an https URL on a domain whose AASA (webcredentials + applinks) or assetlinks.json lists app_ref
               e.g. https://partner.example/hana/return
```

- `app_ref` is the native twin of an origin: it is what shares are bound to (`vault_shares.partner_origin =
  "ios-app:<app_ref>"` / `"android-app:<app_ref>"`, prefixed so it can never equal a web origin), so removing a
  native app ends its shares at their next unlock, as removing an origin does.
- On registration the CLI fetches the return host's AASA / `assetlinks.json` and refuses an `app_ref` it doesn't
  list (a typo check; the platforms do the real check at run time).
- A `pk_test_` app in a `sandbox-*` env may instead register a custom scheme return (`myapp://hana`), marked
  `scheme_only`, for Expo Go and quick starts ([Q4](#open-questions-for-the-user), [Q12](#open-questions-for-the-user)).
  Live apps can't.
- Android's Play App Signing certificate and the upload certificate differ: the registered digest is the one users'
  installs carry (Play Console → App integrity), and a debug build gets its own test app or a second row.

`GET /v1/app` gains `native: [{platform, appRef, returnUrl}]` for the host page.

### The sheet host page

New page `{authOrigin}/native` (one page, `op = login | approve | consent | export | manage`), served by the auth page
Worker with the auth pages' CSP. It is the native stand-in for the partner page and the popup together:

- It reads `pk`, `op`, `app` (an `app_ref`), `ret` (the return URL) and the op's parameters from its URL, loads
  `GET /v1/app`, and refuses (with a Hana error screen and a return to `ret` carrying only `error=`) unless
  `(app, ret)` is one of the app's registered native apps. That check is not what stops impersonation (the URL is the
  app's to write); the platform's return verification is ([Login](#login) step 6).
- It frames `{vaultOrigin}/vault?pk=…&host=native`. The vault page for `host=native` sets `frame-ancestors
  {authOrigin}` only, and the vault takes the native context (`app_ref`, `op`) from the host page by `postMessage`,
  authenticated as it authenticates the popups today (`event.origin === authOrigin`, `event.source === parent`). The
  vault sends `x-hana-parent-origin: ios-app:<app_ref>`; the API accepts it from `Origin: vaultOrigin` when the app
  has that native app.
- It renders what the popups render today (Google step, progress, approval, consent, export) inside the one page.
  The approval decoding, digest and guard code is the approve page's, run in the host page and talking to the vault
  frame instead of an opener.
- It opens no popups (`window.open` inside the sheets is a spike item and nothing relies on it), so the one browsing
  context navigates to Google and back ([Login](#login) step 3).

### Login

1. **App.** `hana.login()` makes (if missing) the companion key ([below](#the-companion-key)), a PKCE pair
   `verifier` (32 random bytes) and `challenge = b64url(sha256(verifier))`, and opens
   `{authOrigin}/native?op=login&pk=…&app=<app_ref>&ret=<return_url>&cpk=<companion public key>&cc=<challenge>&st=<state>`
   in the platform sheet: iOS `ASWebAuthenticationSession` with `.https(host:path:)` of the return URL (iOS 17.4+),
   Android `AuthTabIntent` with the https return (Chrome 137+), else a Custom Tab whose return is the verified App
   Link ([Q3](#open-questions-for-the-user)).
2. **Host page and vault.** The vault prepares the login exactly as today (session key, salt, `expiresAtMs`,
   `maxUses`, nonce, `relayKey`, `relayReadKey`, `relayId`, the registry check). Before leaving for Google it stores the
   pending login (`CryptoKeyPair`, salt, expiry, relay keys, `cpk`, `cc`, `st`) in its IndexedDB under
   `pending|<relayId>`, for at most 10 minutes, single use.
3. **Google.** The host page stores `{relayKey, native: true}` under `hana.login.<relayId>` in `sessionStorage` (as
   `/login` does) and navigates the sheet to Google with the nonce and `state = relayId`. The redirect stays the
   registered `{authOrigin}/login/callback`, so no Google client changes; the callback encrypts and posts the token to
   the relay as today, then, seeing `native: true`, navigates to `/native?op=resume&r=<relayId>`.
4. **Resume.** The host page frames the vault again; the vault loads `pending|<relayId>`, deletes it, reads the relay
   and runs today's steps 5–10 (token checks, `/v1/login`, CKD decrypt, PRK, addresses, the persisted record and the
   share, D79's background persist). The share is created with the native `partner_origin` and the companion key
   `cpk` and challenge `cc` in its creation payload (signed by the session key, so the API can't swap them).
5. **Grant.** The API stores the share with the companion key **inactive** and returns a one-time `grant` (32 random
   bytes; the API keeps `sha256(grant)`, 5 minutes).
6. **Return.** The host page navigates to `<return_url>?st=<state>&g=<grant>&s=<shareId>`. Only the app that owns the
   return domain receives it: iOS completes the `ASWebAuthenticationSession` only for an app with that
   `webcredentials` domain; Auth Tab delivers an https redirect only to an app of the same publisher; a Custom Tab
   follows the verified App Link. That is the impersonation barrier: an app that started the sheet with another
   app's `pk`, `app_ref` and return URL never sees the grant.
7. **Activate.** The SDK checks `st`, then `POST /v1/native/activate {shareId, grant, verifier, sig}` with `sig` by the
   companion key over `"hana-id/native-activate/v1" ‖ shareId ‖ grant`. The API checks `sha256(grant)`, the PKCE
   pair against `cc`, the signature against `cpk`, and activates the companion key. It answers `{addresses,
   expiresAtMs, persistence}` (addresses as the vault reported them when creating the share, signed by the session
   key in the creation payload). Both halves are needed: the grant reaches only the right app, and `verifier` plus
   the companion private key are only in the app that started the login.
8. **Errors.** The user closes the sheet: `login_cancelled`. Any failure in the sheet returns `error=<code>` (the
   existing `HanaError` codes); `'none'` persistence apps get no share, so the result returns in the link and
   the companion key can only mint identity tokens while the on-chain session lives (see
   [Persistence](#persistence-logout-and-revoke)).

### The companion key

A P-256 key the SDK makes once per app install: Secure Enclave (`kSecAttrTokenIDSecureEnclave`) on iOS, Android
Keystore (StrongBox when present) on Android, non-exportable, no user presence required. In React Native the native
module holds it; JS only gets signatures. It is bound to one share at a time.

| The companion key can | It can't |
|---|---|
| post signing, consent and export requests to the request relay (each still needs the sheet and the user) | unlock `K_s` or reach PRK, sign a chain transaction, accept a policy |
| read those requests' results | revoke other devices (needs a share made < 5 min ago in the vault) |
| mint the identity token ([Identity token](#identity-token)) | keep a session alive (it is not activity: D55, D112) |
| read the share's status (live, expires at, idle until) | anything after the share ends |
| revoke its own share (logout) | |

What it buys: logout, status and identity tokens without a sheet, and a way to tie each relay request to the app
that logged in. A stolen companion key (malware with the app's privileges on an unlocked device) can mint identity
tokens and send requests the user must still approve, until the share ends; that is what a partner-page XSS can do on
the web. Whether to have it at all is [Q6](#open-questions-for-the-user).

### Signing

1. **App.** A signing call (`eth_sendTransaction`, `personal_sign`, `stellar_signTransaction`, `signRaw`, …) builds the
   same request the web client sends the vault today (the SDK fills fees and nonces through the partner's RPC as the
   web SDK does), then `POST /v1/native/requests {shareId, kind, params, sig}` with the companion signature over
   `"hana-id/native-request/v1" ‖ shareId ‖ sha256(canonical request)` → `{requestId}` (128-bit random).
2. **Sheet.** `{authOrigin}/native?op=approve&pk=…&app=…&ret=…&rid=<requestId>`. The host page reads the request from
   the relay, the vault unlocks its record (one `/v1/vault/unlock`), applies today's checks (test-app network rule,
   `raw_sign` re-read, auto-approve match), and the host page shows the approval screen with the decoded request.
   The vault recomputes the digest and signs only on a match, as today.
3. **Result.** The vault writes the result to the relay slot, signed by the session key (a vault message with purpose
   `native-result`), so only the vault that holds the share can answer. The host page navigates to `<return_url>?r=
   <requestId>`; the SDK reads the result with its companion key and **checks the signature itself** against the
   address and the request bytes (Ed25519 for Stellar, secp256k1 recovery for EVM, as `@hana-id/core` already can),
   then broadcasts as the web SDK does.
4. **Transport** ([Q13](#open-questions-for-the-user)): requests go through the relay, not the URL, because
   transactions and typed data can be many kilobytes, URLs end up in browser history and logs, and the relay ties
   each request to the companion key. The relay object (`NativeRequest`, one per `requestId`, like `LoginRelay`) keeps
   one request and one result for 10 minutes, then a tombstone.
5. **Batches.** Sodax-style sequences (`restoreFootprint`, trustline, then the swap: batch B Q17) would be three
   sheets. The SDK may queue requests made within 300 ms of each other and the host page shows them one after another
   in the same sheet (each with its own Approve), returning when the queue is empty.
6. **Closing early.** A sheet the user dismisses refuses the request (`user_rejected`, 4001). On iOS the app learns
   it from the session's cancel error; on Android from Auth Tab's result code; a plain Custom Tab gives no signal,
   so the SDK treats a return to the foreground with no result within 5 s as a cancel (the request is then withdrawn
   from the relay), and otherwise gives up after the relay's 10 minutes.

### Auto-approve

The policy, the consent and the per-day counters work as today, since the vault runs them. But the vault only runs
inside a sheet, so an auto-approved request still opens one: it shows "Signing automatically under {policy label}"
and closes itself after the signature, about 1–2 s with no tap. That is parity of rules, not of feel
([Q7](#open-questions-for-the-user)). Consent (`requestAutoApprove`) is a sheet with the consent screen.

### Persistence, logout and revoke

- `'session'` persistence: the vault record stays in the sheet's browser store, the share in D1, bound to the native
  `partner_origin` and the companion key. Each approval sheet unlocks (one `/v1/vault/unlock`); the in-memory idle
  rule doesn't apply (the vault lives only while a sheet does), but the share's own `idle_until` and
  `abs_expires_at` do, slid by approved signatures as `/v1/vault/touch` slides them today.
- `'none'` persistence: every sheet is a full login (about 9 s and $0.02 per signature). Allowed, documented as
  impractical for native apps.
- **Logout**: `POST /v1/vault/revoke` signed by the companion key (new form); the record in the browser store becomes
  useless and the next sheet deletes it. No sheet.
- **Lost device**: `revokeOtherDevices()` opens a sheet with a fresh login (the vault needs a share made less than
  5 minutes ago, as today), or the user uses Hana Home.
- **App removed from the registry, app suspended, persistence switched off**: as for origins, at the next unlock.
- **Storage gone** (Safari data cleared, Android default browser changed, an ephemeral browser): the vault finds no
  record; the sheet says "Sign in again" and runs the login; the SDK replaces its share.

### Identity token

`POST /v1/identity/token` (identity token spec) gains a native form: the request is signed by the active companion
key of a live share instead of the session key. The API checks the share as it does for the vault and mints the same
token (`sub`, `wallets` with the proofs the vault stored at login and passed with the share, `sid`). So
`getIdentityToken()` is silent on native too, and the partner's backend verifies the same JWT. The email-sharing
consent (`requestEmailSharing()`) is a sheet.

### Email login

The email code flow (email login spec) runs inside the login sheet: the user types the address, switches to the mail
app, comes back to the sheet (it stays presented) and types the code; iOS's one-time-code AutoFill and Android's SMS
and mail code suggestions work in the browser sheet as in the browser (checked in the spike). Magic links stay
rejected: a link opens in the default browser or the mail app's webview, outside the sheet that holds the login's
relay key, which is exactly why the email spec chose codes.

### Sign in with Apple

Apple runs as the web flow on `authOrigin` inside the sheet (Apple spec Q5 option A): Apple's page offers Face ID
there, the `sub` is Hana's team's, and the wallet is the same as on the web. Native `ASAuthorizationController` in a
partner's app is refused: it runs in the partner's team and gives other `sub`s, so other wallets. For App Store
releases, Hana's Apple login is what makes a Google-via-Hana app pass 4.8 ([App Store and Play
review](#app-store-and-play-review)).

### Key export and Hana Home

`exportKey(chain)` opens the sheet with `op=export`: the export page's flow (fresh Google sign-in with `max_age=0`,
typed confirmation, hold to reveal, 5-minute limit, D59 limits and D111) inside the sheet, with the key shown only
there and never returned to the app. Hana Home is a link the SDK opens in the full browser (Safari, Chrome), not in a
sheet, so users reach it the same way from web and native apps.

### Offline, errors and recovery

- No network: login, signing, identity tokens fail with `api_unavailable`; status and addresses answer from the SDK's
  cache; the SDK never claims a live session past `expiresAtMs`.
- The app is killed while a sheet is open: iOS and Android dismiss the sheet. A login whose grant never arrives
  expires (5 min) and leaves an inactive share that the hourly cron deletes; a request whose result was written is
  read at the next launch if the SDK still has its `requestId` (kept in the app's storage until read or expired).
- Error codes are the web's (`docs/integration.md` §13) plus `sheet_unavailable` (no browser that can show a sheet,
  e.g. no Chrome-based browser and Custom Tabs unsupported), `return_unverified` (the platform refused the return:
  usually a wrong AASA or `assetlinks.json`), `os_unsupported` (iOS < 17.4 for a live app,
  [Q5](#open-questions-for-the-user)).

### Latency budget

Estimates to measure in the spike (iPhone 13-class, mid-range Android, warm caches):

| Step | Login | Signature |
|---|---|---|
| Sheet presentation (+ iOS alert tap) | 0.3–0.5 s (+ user) | 0.3–0.5 s (+ user) |
| Host page and vault bundles (cached) | 0.3 s | 0.3 s |
| `GET /v1/app`, unlock | 0.2 s | 0.2–0.4 s |
| Google | user | — |
| Chain (`create_session_and_derive`, CKD) | 6–9 s (as web) | — |
| Approval guard | — | 1 s minimum (D36) |
| Return, activation / result read | 0.3–0.5 s | 0.3 s |

## SDK surface

One protocol, three packages. All three expose the web SDK's names where they make sense.

**React Native / Expo: `@hana-id/react-native`** (TypeScript, plus a native module `HanaSheet` for the sheet with
https callbacks, the companion key, and secure storage of the SDK's small state; an Expo config plugin
`@hana-id/react-native/plugin` adds the associated domains, the Android intent filter and `assetlinks` guidance).

```ts
import { createHana } from '@hana-id/react-native';
const hana = createHana({
  publishableKey: 'pk_live_…', environment: 'production',
  returnUrl: 'https://partner.example/hana/return',     // must be registered for this app
  evm: { chains: [...] }, stellar: { network: 'PUBLIC' },
});
await hana.login();                     // opens the sheet; resolves { stellar, evm }
hana.status; hana.addresses; hana.expiresAtMs; hana.on('accountsChanged', …);
hana.ethereum;                          // EIP-1193 provider (viem custom transport, wagmi connector)
hana.stellar.signTransaction(xdr, { networkPassphrase });
await hana.signRaw({ … }); await hana.getIdentityToken();
await hana.requestAutoApprove(); await hana.exportKey('stellar'); await hana.logout();
```

`@hana-id/react`'s `HanaProvider`, `useHana`, `useWallet` and `useIdentityToken` get a React Native build over this
client (same hooks). Differences from the web: no `prepareApproval()` and no launcher (a sheet needs no user
activation), no `container`; `returnUrl` is required; methods may be called from any handler.

**Swift: `HanaID` (Swift Package)**, iOS 17.4+ for live apps:

```swift
let hana = try Hana(publishableKey: "pk_live_…", environment: .production,
                    returnURL: URL(string: "https://partner.example/hana/return")!)
let addresses = try await hana.login(from: window)       // ASWebAuthenticationSession
let sig = try await hana.stellar.signTransaction(xdr, networkPassphrase: …)
let tx  = try await hana.ethereum.request(method: "eth_signTransaction", params: […])
let token = try await hana.identityToken()
```

**Kotlin: `id.hana:hana-id` (Android library)**, Android 8+ (API 26), Auth Tab with Custom Tab fallback:

```kotlin
val hana = Hana(context, publishableKey = "pk_live_…", environment = Environment.Production,
                returnUrl = Uri.parse("https://partner.example/hana/return"))
val addresses = hana.login(activity)                     // suspend; AuthTabIntent / Custom Tab
val sig = hana.stellar.signTransaction(xdr, passphrase)
val token = hana.identityToken()
```

The Swift and Kotlin packages verify results with small native Ed25519 and secp256k1 checks (CryptoKit has Ed25519;
secp256k1 from a vetted library); they hold no key and do no CKD, so they stay small.

## Option B, if chosen later

Specified only so its trust change and costs are on record ([Q9](#open-questions-for-the-user)):

- Eligibility: Enterprise scopes with their own client, Hana-held (D42), `allow_shared = false`, a written opt-in by
  the partner ("our app can access our users' keys"), and the app listed in Hana Home as "{app} holds keys for this
  wallet".
- Login: native Google sign-in with `serverClientID` / `setServerClientId` = the scope's web client (so `aud` is the
  already-registered client), nonce from the session key; `/v1/login` from a new caller kind `native`, gated by
  App Attest / Play Integrity bound to the request, instead of `Origin`.
- Keys: session key Ed25519 in software, wrapped with PRK by a Secure Enclave / StrongBox key, in the Keychain
  (`WhenUnlockedThisDeviceOnly`, no backup) or Keystore; the D22 share kept so that idle limits, logout-everywhere
  and suspension keep working.
- Core: `@hana-id/core` in Hermes for React Native; for Swift and Kotlin a port checked against the frozen vectors
  (`derivation-v1.json`, CKD fixtures), or one Rust core through UniFFI. An external audit of that code before
  mainnet.
- Never with OTA updates of the key-handling JS without the partner accepting that this is a key-code deployment.

## Google clients on native

- **Option A needs no native Google client.** The sheet runs Hana's web flow with the scope's web client or the shared
  client and the registered `{authOrigin}/login/callback`. Partners with their own client change nothing.
- **Hana's shared project gets no iOS or Android client, ever** (invariant): with one, the holder of that native app
  could mint shared-client tokens with any nonce and so derive the keys of every `allow_shared` scope.
- Option B (later): Android needs an Android OAuth client (package + SHA-1) in the same Cloud project as the scope's
  web client, and the token's `aud` is the web client; iOS needs an iOS client in that project and `serverClientID`
  = the web client, so again no new on-chain client. If a partner registers an iOS client as `aud` instead,
  `propose_change AddClient` with a client proof from GoogleSignIn-iOS ≥ 9.0 (nonce support) adds it; the address is
  the same either way (`sub` is public across clients).
- `docs/integration.md`'s warning stays true and gets sharper: an iOS or Android client in a partner's own project can
  derive that scope's users' keys from any build of that app.

## App Store and Play review

- **4.8 Login Services.** A partner app whose account is a Hana Google login must offer an equivalent login that
  limits data to name and email and lets users hide their email. Hana's Apple login (D124) does; Hana's email code
  login doesn't (the user types their real address). So: App Store releases of partner apps need Hana's Apple login,
  or the partner's own qualifying login next to Hana (which would be a separate account, not a second Hana wallet
  method). Until Apple login ships, partners can test on TestFlight and ship on Android
  ([Q16](#open-questions-for-the-user)).
- **3.1.5(i) Wallets.** The partner's developer account must be an organization. The integration guide says so.
- **5.1.1(v).** Hana stores no social-network credential: a Google ID token is an expired-within-an-hour, openid-only
  assertion bound to one session key, not a credential to Google's services, and Hana keeps no access or refresh
  token. Used tokens are, however, public in NEAR transaction arguments forever (`docs/security.md`). Hana's App
  Review notes for partners explain this; it is a reviewer-interpretation risk, not a known rejection reason.
- **5.1.1(v) account deletion.** The partner deletes its own account; Hana's part is "Stop using Apple with Hana" (Apple
  spec) and, for every login, an explanation that the wallet is derived (nothing to delete) with a link to export.
- **2.5.2** matters only to option B (OTA updates of key code).
- **Google's "no web client for native apps".** Hana's web client is used by Hana's web pages in the system browser;
  the native app never sends an OAuth request. Hana asks Google during brand verification (already a pre-mainnet
  step) whether this needs a native client per partner app; if Google insists, option A still works with the scope's
  own web client, since the requirement would be about the client type and not about the flow
  ([Q17](#open-questions-for-the-user)).
- **Play.** The partner's listing declares a non-custodial software wallet in the Financial Features declaration.
  Hana's integration guide gives the wording.

## Webviews (Q24's other half)

- **A partner's web app shown in a third-party in-app browser** (Instagram, TikTok, X): Google refuses sign-in there.
  The web SDK detects common in-app browser user agents (it already warns, `docs/integration.md` §5) and the login
  popup shows "Open in Safari / Chrome" with a copy-link button instead of starting Google. Recommended
  ([Q14](#open-questions-for-the-user)).
- **A partner's own app that shows its web app in a WebView**: the vault in that WebView would be option D1
  (rejected). The partner integrates the native SDK in the app shell and the web SDK detects the shell (an injected
  flag) to forward `login()` and signing to it. Specified later, if a partner asks.
- **Mobile Safari and Chrome (no app)**: today's web SDK. Q24's first half (popups opening as tabs, Firefox strict
  tracking protection) is checked by a device test of the web SDK, not here.

## API changes

- D1 migration: `app_native_apps` (above); `vault_shares` gains `companion_pk` (nullable, 65-byte P-256 SEC1),
  `companion_state` (`inactive | active`), `grant_hash`, `grant_expires_at`, `pkce_challenge`, and the login's
  addresses with their wallet proofs (public data, for activation and the identity token).
- `GET /v1/app`: `native[]` (from a Hana page only).
- Vault gate (`apps/api/src/vault/endpoints.ts`): `x-hana-parent-origin` may be `ios-app:` / `android-app:` +
  a registered `app_ref`, accepted only with `Origin: vaultOrigin` and only for the native vault page (the vault's
  message says `host=native`).
- `POST /v1/vault/shares`: optional `{companionPk, pkceChallenge, addressesProof}` in the signed payload; returns
  `grant` once.
- `POST /v1/native/activate`: grant + PKCE + companion signature; 5 attempts per share, then the share is revoked.
- `POST /v1/native/requests`, `GET /v1/native/requests/:id` (host page), `POST /v1/native/requests/:id/result`
  (vault, session-key signed), `GET /v1/native/requests/:id/result?wait=25` (companion signed). New Durable Object
  `NativeRequest`. Limits: 60 requests a minute per share, 10 a minute per IP for activation.
- `POST /v1/vault/revoke` and `GET /v1/native/share` (status) accept a companion signature.
- `POST /v1/identity/token`: the companion form ([Identity token](#identity-token)).
- Cron: delete shares whose companion key never activated (after 10 min) and expired request objects.
- CORS: none of the native endpoints answer browsers except the vault and host-page ones; companion-signed endpoints
  accept requests without `Origin` (native clients) and refuse any `Origin` but Hana's.
- Logs: never `grant`, `verifier`, signatures or request bodies; `requestId` only as a hash.

## Web (vault and auth pages) changes

- `{authOrigin}/native` host page: op router, registered-native-app check, approval/consent/export rendering reused
  from the popups, return navigation.
- Vault: `host=native` mode (framed only by `authOrigin`, context from the host page), the pending-login stash in
  IndexedDB, the companion fields in the share payload, results to the request relay, no `BroadcastChannel`
  cross-tab logic (one sheet at a time).
- `/login/callback`: the `native: true` resume.
- Page Worker: `/native` route, CSP as `/approve` plus `frame-src {vaultOrigin}`.
- The vault page served with `host=native` sets `frame-ancestors {authOrigin}` regardless of the app's origins.
- The in-app-browser screen in `/login` ([Webviews](#webviews-q24s-other-half)).

## Contract

None for options A and C. Option B needs none either (the `aud` is the scope's registered web client, or an iOS
client added with the existing `AddClient`). No layout, nonce, path, label or key rule changes; the address freeze is
unaffected.

## Threat model

| Attacker | Can | Can't |
|---|---|---|
| The partner app (option A), incl. a malicious SDK inside it | see addresses, signatures, identity tokens; send requests the user must approve; drive the companion key while the share lives; show a fake "Hana" screen in its own UI (which gets nothing: it has no key) or a fake Google page in a WebView (phishing the Google password, as any app can) | read the sheet's content, the vault's memory or storage, the Google token or the nonce; sign without the user's Approve in the real sheet (outside an accepted policy) |
| Another app posing as partner X (option A) | open a sheet with X's `pk`, `app_ref` and return URL; the user may log in "to X" | receive the grant (the return goes only to X's verified domain), so activate a companion key or get X's users' addresses; post requests for X's shares |
| Another app sharing the browser store (Safari, Chrome) | open a sheet naming app X, in which the vault may unlock X's record | get anything out of it: requests for X's share need X's companion key, results return only to X's verified link, an export shows the key only on Hana's page after a fresh sign-in |
| A stolen companion key | as the partner app, for that share, until it ends | anything after logout, expiry or revoke |
| Custom-scheme hijack (test apps only) | receive a grant or result id meant for another app with that scheme | activate (needs the PKCE verifier and the companion private key) or read a result (companion signature) |
| A network attacker | nothing beyond TLS | — |
| The partner (option B) | **every key of every user of its app, at any time, silently** | keys of other scopes |
| Hana (option C) | as today, plus its app's native client | — |
| A compromised Hana API | as on the web (`docs/security.md`), plus: activate a companion key of its choosing on a share, so mint identity tokens and post requests (still needing approval) | unlock without the session key; sign |

What is weaker than the web, honestly:

- **Phishing surface.** A web page can't draw over the browser's address bar; a native app can draw anything,
  including a fake "Hana sheet". It still can't get a key, but it can harvest a Google password through a WebView
  styled like a sheet (as any app could). `ASWebAuthenticationSession`'s system alert and the sheet's address bar are
  the user's tells; passkeys on Google accounts defeat password phishing.
- **The approval is in a sheet the app opened.** The app chooses when to show it and can re-open it after a reject;
  it can't change what the sheet shows (decoded by Hana's page from the request bytes the vault signs).

## Invariants

1. No partner-app-controlled surface (WebView, native code, the app's network stack) ever holds a key, a Google token,
   a nonce, `K_s` or the session private key, in option A.
2. Hana's shared Google project holds web clients only; never an iOS or Android client.
3. A native share is usable only with the native `partner_origin` it was created for; companion keys act only on
   their own share and only after activation with a grant delivered over a verified link (live apps).
4. A result the SDK accepts is a signature it verified itself against the user's address and the request bytes.
5. Nothing native changes a path, a label, a tuple or a key rule.

## Tests

Core and SDK (vitest): sheet URL builder and return parser (every parameter, unknown parameters refused, `st`
mismatch); PKCE; companion message layouts against frozen vectors; result verification for Ed25519 and EVM (valid,
other address, other request, malleated); the request canonicalization; RN client state machine with a fake native
module.

API (vitest with miniflare): native app registry rules (live apps need https returns; `scheme_only` only for
`pk_test_` in `sandbox-*`); the vault gate with native parents (wrong `app_ref`, a web origin posing as native, a
native ref on the web vault page); share creation with companion fields; activation (wrong grant, expired, wrong
verifier, wrong signature, replay, the 5-attempt revoke); request relay (write once, result only with a session-key
signature for that share, read only with that share's companion key, tombstones, limits); identity token by
companion; revoke by companion; cron cleanup; no cookies; logs never contain grants or bodies.

Web (unit and Playwright in Chromium, WebKit, Firefox): the host page as a top-level page standing in for the sheet,
with the return navigation intercepted: login (pending stash survives the Google navigation; expired or reused
stash refused), approval (decode, guard, digest), auto-approve self-close, consent, export, storage cleared → re-login,
two apps sharing one browser store, the in-app-browser screen.

iOS (XCUITest on the Simulator, `xcodebuild test` on a macOS CI runner): the Swift package against a local stack
(the e2e stack's API, vault and auth hosts, mocked chain, a stub Google issuer as in `apps/e2e`):
`ASWebAuthenticationSession` with an https callback (associated domains in developer mode, `?mode=developer`),
the system alert tapped through `springboard`, cancel paths, app killed mid-sheet. App Attest isn't available in the
Simulator, so nothing in v1 depends on it.

Android (instrumented tests on an emulator with Chrome, UI Automator for the tab): Auth Tab and Custom Tab fallback,
App Link verification with a local `assetlinks.json` (debug digest), cancel and back-button paths.

React Native: a sample Expo app (`apps/native-example`, dev build) driven by **Maestro** flows on both simulators
(Maestro taps system alerts and web content in the sheets; Detox can't drive the system browser), nightly in CI; a
smoke flow per pull request on Android only (cheaper runners). Real Google in the sheet is a manual test on devices
(Google's bot detection blocks automated sign-in), recorded in `docs/context.md`; so are real devices for latency.

Testnet (sandbox-dev): the example app on a real iPhone and a real Android phone (Chrome and Samsung Internet), login,
Stellar and EVM signatures, identity token, export, logout; timings recorded.

## Build order

Sizes are rough (lines of code including tests; days of focused work).

| # | Step | Depends on | Size |
|---|---|---|---|
| 0 | **Spike** on sandbox-dev: a throwaway host page and two bare sample apps. Settle: Google sign-in in each sheet type (no `disallowed_useragent`); whether IndexedDB persists across `ASWebAuthenticationSession` opens and app restarts, and in `SFSafariViewController`; the iOS alert's wording; https callbacks and Auth Tab returns; Custom Tab returns in Chrome, Samsung Internet, Firefox; `window.open` in sheets; one-time-code AutoFill; timings. Record in `docs/context.md` | — | 0.3k, 2 d |
| 1 | API: registry, migration, vault gate, share companion fields, activation, request relay DO, companion-signed revoke/status/identity token, cron, limits, admin CLI `app:native add/remove` | 0 | 1.6k, 5 d |
| 2 | Web: `/native` host page, vault native mode, pending-login stash, callback resume, results to the relay, page Worker route, in-app-browser screen | 1 | 1.3k, 4 d |
| 3 | `@hana-id/native-core` (TS, shared by RN): protocol, URL builder, PKCE, result verification, EIP-1193 and Stellar surfaces over the relay | 1 | 0.7k, 2 d |
| 4 | `@hana-id/react-native` + native module (Swift, Kotlin) + Expo config plugin + React hooks; `apps/native-example` | 2, 3 | 1.4k, 5 d |
| 5 | Swift package `HanaID` with XCUITest | 2 | 0.8k, 3 d |
| 6 | Kotlin library with instrumented tests | 2 | 0.8k, 3 d |
| 7 | CI: macOS and Android emulator jobs, Maestro nightly; partner guide (`integration.md` native section, AASA/assetlinks how-to, review notes); reference docs; sandbox-dev run on devices | 4–6 | 0.4k, 3 d |

Total about 7.3k lines and 27 days. Steps 1–4 and 7 give React Native partners a working SDK; 5–6 add native
partners. Hana's Apple login (D124) is needed before partners' App Store releases, not before this batch. The
passkey hybrid (D2) and option B are separate batches.

## Docs to update when built

`architecture.md` (components, the native flows, data stores: browser stores per sheet, the companion key),
`security.md` (parties: the partner app, the companion key; invariants above; the shared-project invariant),
`api.md` (endpoints, schema, DO, limits), `integration.md` (a native section: registering apps, AASA and
`assetlinks.json`, review notes, errors), `operations.md` (the shared project's "web clients only" check, CI
runners), `decisions.md` (the answers), `README.md` index, `context.md` (spike results).

## Sources

Platform (checked 2026-10-30):

- Google OAuth policies ("Use secure browsers", client types): https://developers.google.com/identity/protocols/oauth2/policies
- Google OAuth for native apps (embedded user-agents, custom schemes, loopback): https://developers.google.com/identity/protocols/oauth2/native-app
- Google 2016 announcement (WebViews blocked; Custom Tabs, SFSafariViewController, AppAuth): https://developers.googleblog.com/2016/08/modernizing-oauth-interactions-in-native-apps.html
- Google OpenID Connect (`sub`): https://developers.google.com/identity/openid-connect/openid-connect ; discovery: https://accounts.google.com/.well-known/openid-configuration
- GoogleSignIn-iOS releases and headers: https://github.com/google/GoogleSignIn-iOS/releases ,
  https://github.com/google/GoogleSignIn-iOS/blob/main/GoogleSignIn/Sources/Public/GoogleSignIn/GIDSignIn.h ,
  https://github.com/google/GoogleSignIn-iOS/blob/main/GoogleSignIn/Sources/Public/GoogleSignIn/GIDConfiguration.h ;
  backend check: https://developers.google.com/identity/sign-in/ios/backend-auth
- AppAuth-iOS external user agent: https://github.com/openid/AppAuth-iOS/blob/master/Sources/AppAuth/iOS/OIDExternalUserAgentIOS.m ;
  SFSafariViewController storage: https://github.com/openid/AppAuth-iOS/issues/57
- Credential Manager: https://developers.google.com/identity/android-credential-manager/android/reference/com/google/android/libraries/identity/googleid/GetGoogleIdOption.Builder ,
  https://developer.android.com/identity/sign-in/credential-manager-siwg-implementation ,
  https://developer.android.com/identity/authorization
- React Native Google Sign-In (nonce): https://react-native-google-signin.github.io/docs/security
- ASWebAuthenticationSession: https://developer.apple.com/documentation/authenticationservices/authenticating-a-user-through-a-web-service ,
  https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/prefersephemeralwebbrowsersession ,
  https://developer.apple.com/documentation/authenticationservices/aswebauthenticationsession/callback/https(host:path:)
- SFSafariViewController: https://developer.apple.com/documentation/safariservices/sfsafariviewcontroller
- WebKit ITP and app-bound domains: https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/ ,
  https://webkit.org/blog/10882/app-bound-domains/
- Custom Tabs, Auth Tab, Ephemeral and Partial Custom Tabs: https://developer.chrome.com/docs/android/custom-tabs ,
  https://developer.chrome.com/docs/android/custom-tabs/guide-auth-tab ,
  https://developer.chrome.com/docs/android/custom-tabs/guide-ephemeral-tab ,
  https://developer.chrome.com/docs/android/custom-tabs/guide-partial-custom-tabs
- Chrome storage partitioning and third-party cookies: https://privacysandbox.google.com/cookies/storage-partitioning ,
  https://privacysandbox.google.com/blog/privacy-sandbox-next-steps
- Associated domains, App Links, passkeys: https://developer.apple.com/documentation/xcode/supporting-associated-domains ,
  https://developer.apple.com/videos/play/wwdc2022/10092/ ,
  https://developer.android.com/training/app-links/verify-android-applinks ,
  https://developer.android.com/identity/credential-manager/prerequisites ,
  https://developer.android.com/identity/passkeys/create-passkeys ,
  https://developer.android.com/training/sign-in/privileged-apps
- PRF: https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct ,
  https://developer.android.com/jetpack/androidx/releases/credentials
- App Attest and Play Integrity: https://developer.apple.com/documentation/devicecheck/establishing-your-app-s-integrity ,
  https://developer.android.com/google/play/integrity/overview
- App Review Guidelines (4.8, 3.1.5, 2.5.2, 4.7, 5.1.1; last updated 2026-10-16): https://developer.apple.com/app-store/review/guidelines/
- Google Play crypto exchanges and software wallets: https://support.google.com/googleplay/android-developer/answer/16329703 ,
  https://support.google.com/googleplay/android-developer/answer/16296680 ,
  https://support.google.com/googleplay/android-developer/answer/13607354

Providers (fetched 2026-10-30):

- Privy: https://docs.privy.io/security/wallet-infrastructure/advanced/user-device.md ,
  https://docs.privy.io/recipes/tee-wallet-migration-guide.md , https://docs.privy.io/changelogs/react-native.md ,
  https://docs.privy.io/changelogs/swift.md , https://docs.privy.io/recipes/mobile-key-export.md ,
  https://docs.privy.io/basics/get-started/dashboard/app-clients.md ,
  https://docs.privy.io/authentication/user-authentication/login-methods/oauth.md ,
  https://docs.privy.io/basics/react-native/installation.md ,
  https://docs.privy.io/basics/react-native/advanced/setup-passkeys.md
- Web3Auth / MetaMask Embedded Wallets: https://docs.metamask.io/embedded-wallets/sdk/ios.md ,
  https://docs.metamask.io/embedded-wallets/sdk/android.md ,
  https://docs.metamask.io/embedded-wallets/features/session-management/ ,
  https://docs.metamask.io/embedded-wallets/sdk/android/advanced/dapp-share/ ,
  https://docs.metamask.io/embedded-wallets/sdk/react-native.md ,
  https://docs.metamask.io/embedded-wallets/sdk/android/advanced/custom-authentication/ ,
  https://docs.metamask.io/embedded-wallets/sdk/ios/usage/request/
- Dynamic: https://www.dynamic.xyz/docs/embedded-wallets/mpc/architecture.md ,
  https://www.dynamic.xyz/docs/javascript/react-native/setup.md , https://www.dynamic.xyz/docs/javascript/react-native/expo.md ,
  https://www.dynamic.xyz/docs/swift/quickstart.md , https://www.dynamic.xyz/docs/kotlin/quickstart.md
- Magic: https://docs.magic.link/embedded-wallets/sdk/client-side/react-native.md ,
  https://docs.magic.link/embedded-wallets/wallets/overview.md ,
  https://docs.magic.link/embedded-wallets/authentication/login/oauth/implementation.md ,
  https://docs.magic.link/embedded-wallets/authentication/security/allowlists/mobile-allowlist.md ,
  https://docs.magic.link/embedded-wallets/wallets/security/sign-confirmation.md
- Turnkey: https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/swift/authentication/overview ,
  https://docs.turnkey.com/features/authentication/sessions/overview.md ,
  https://docs.turnkey.com/generated-docs/react-native-wallet-kit/client-context-type-handle-google-oauth.md ,
  https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/react-native/authentication/social-logins.md ,
  https://docs.turnkey.com/solutions/embedded-wallets/integration-guide/swift/authentication/social-logins.md ,
  https://docs.turnkey.com/features/authentication/passkeys/native.md
- Coinbase CDP: https://docs.cdp.coinbase.com/wallets/security-and-policies/security-overview.md ,
  https://docs.cdp.coinbase.com/wallets/security-and-policies/app-attestation/overview.md ,
  https://docs.cdp.coinbase.com/wallets/client-side-development/react-native.md
- Para: https://docs.getpara.com/v3/concepts/architecture.md , https://docs.getpara.com/v3/react-native/guides/custom-storage.md ,
  https://docs.getpara.com/v3/react-native/guides/add-social-login.md

Repo: `docs/architecture.md`, `docs/security.md`, `docs/contract-interface.md`, `docs/integration.md`, `docs/api.md`,
`docs/batch-b-spec.md` (Q17, Q24), `docs/decisions.md` (D22, D23, D36, D38, D42, D43, D55, D59, D99, D111, D124),
`docs/identity-token-spec.md`, `docs/email-login-spec.md`, `docs/hana-home-spec.md`, the Sign in with Apple spec
(branch `docs/apple-login-spec`, "Native iOS" and Q5), `packages/web/src`, `packages/react`.

## Open questions for the user

Each question stands alone: the options, what each costs, and the recommendation. Answer by number ("Q3: B").

1. **Which approach does Hana build first for native apps?** Inside an app nothing separates the partner's code from
   a Hana vault, so the key must run either in the system browser, in a Hana app, or in the partner's app.
   - A. **Hana in the system browser (sheets)** (recommended): the web guarantee holds (the partner never sees a key,
     every signature needs an Approve on Hana's page), works for shared-client and own-client scopes, same addresses as
     the web, no contract change, about 5 weeks. Costs: a sheet per signature (about 1–2 s), web-length sessions,
     auto-approve isn't silent.
   - B. Keys in the partner's app (Web3Auth's model): the best UX (native sheets, silent signing, long sessions,
     offline), but the partner, its SDKs and its OTA updates can read every user's key; works only for scopes with their
     own Google client; 8–10 weeks plus an audit.
   - C. A Hana app that signs for partner apps: strong security, but users must install Hana's app first and switch
     apps for each signature; about 3 months plus running a consumer app.
   - D. A first, B later as an opt-in (the recommendation of A, with Q9 deciding B).
   Recommendation: A now (D as the path).

2. **Which iOS sheet?** The choice decides where the vault's record lives and how many taps a signature costs.
   - A. **`ASWebAuthenticationSession`, non-ephemeral, for everything** (recommended, subject to the spike): Apple's
     and Google's sanctioned sign-in API; the https callback (iOS 17.4+) proves which app receives the result; storage
     is Safari's (to confirm that IndexedDB persists). Cost: iOS shows "“App” Wants to Use “…” to Sign In" at **every**
     open, signatures included: one extra tap with wording that says "sign in".
   - B. `SFSafariViewController` for everything: no alert, its own persistent store per app, Hana's address visible.
     But it has no completion callback: the login's return must be a universal link the page opens (whether iOS
     delivers it reliably from inside the controller is a spike item) or app attestation (Q18).
   - C. Ephemeral `ASWebAuthenticationSession`: no alert but nothing persists, so every signature is a full login
     (about 9 s and $0.02). Only workable with the passkey hybrid (Q15).
   Recommendation: A, switching to B if the spike shows B's return works on iOS 17–26 (then the alert disappears).

3. **Which Android tab?**
   - A. **Auth Tab when the browser supports it (Chrome 137+), else a Custom Tab returning through a verified App
     Link** (recommended): Auth Tab verifies the return domain belongs to the app's publisher and reports cancel; the
     fallback covers Samsung Internet, Firefox and older Chrome.
   - B. Custom Tabs only: one code path, but no cancel signal and returns depend on each browser's App Link handling.
   - C. Auth Tab only: refuse users whose default browser lacks it (a few percent of users, more in some markets).
   Recommendation: A.

4. **How is a native app identified, the way a website is by its origin?** Without it, any app could open Hana's
   sheet as "partner X" and receive X's users' addresses and signatures.
   - A. **A registered https return link verified by the platform** (associated domains on iOS, Digital Asset Links on
     Android), required for live apps; custom URL schemes allowed only for `pk_test_` apps in `sandbox-*` envs
     (recommended). Partners host one AASA and one `assetlinks.json` file.
   - B. Custom schemes for live apps too, made safe by App Attest / Play Integrity on activation (Q18): no web files,
     but attestation everywhere, and no Simulator support for App Attest.
   - C. Custom schemes with no binding (as several providers allow): any app can pose as another. Not acceptable.
   Recommendation: A.

5. **Minimum OS versions for live apps.**
   - A. **iOS 17.4+ (https callbacks), Android 8+ (API 26) with any Custom Tabs browser** (recommended): iOS 17.4
     shipped in March 2024 and iOS 26 is current; older iPhones would need custom schemes.
   - B. iOS 16+ with custom schemes and App Attest for the older versions: two code paths for a shrinking share of users.
   Recommendation: A.

6. **Does the app hold a companion key?** A non-exportable P-256 key in the Secure Enclave / Keystore, bound to the
   share at login, that can mint identity tokens, read status, post requests and log out, but never unlock or sign.
   - A. **Yes, with exactly those rights** (recommended): identity tokens and logout without a sheet; each request tied
     to the app that logged in. A stolen companion key equals a partner-page XSS on the web.
   - B. No: every identity token (hourly), status check and logout opens a sheet.
   - C. Yes, and let it also unlock the record: breaks the model (the app could then reach PRK). Not offered.
   Recommendation: A.

7. **Auto-approve on native.** The vault runs only inside a sheet, so an auto-approved request still opens one.
   - A. **Supported: the sheet opens, signs under the accepted policy and closes itself** (about 1–2 s, no tap)
     (recommended): same rules as the web, little code.
   - B. Not offered on native in v1: every request shows the approval screen.
   - C. Wait for delegated on-chain session keys (D4) to make it silent: chain-specific, a later batch.
   Recommendation: A (C remains the long-term answer for silent signing).

8. **How long do native sessions last?** Today 12 h absolute, 2 h idle by default, below 24 h at most (D43); mobile
   users are used to staying signed in for weeks; each re-login is a Google tap plus about 9 s and $0.02.
   - A. **The web's limits for v1, measured in the pilot** (recommended): no new security analysis.
   - B. Longer shares for native apps only (say 30 days absolute, 7 days idle): an API rule change (the share's
     lifetime would no longer follow the used-up on-chain session's expiry); a stolen browser store plus a live share
     would then be useful for longer.
   - C. The passkey hybrid (Q15) for long sessions with a Face ID unlock.
   Recommendation: A, then B or C on pilot data.

9. **May a partner's app hold the keys itself (option B), and on what terms?**
   - A. **Later, only for Enterprise scopes with a Hana-held own Google client and no shared login, with a written
     opt-in and a Hana Home notice "{app} holds keys for this wallet"** (recommended). Shared-client scopes can never
     use it: a native client on the shared client would let one app derive every shared scope's users' keys.
   - B. Any scope with its own Google client, on request.
   - C. Never: Hana's promise stays "the partner never sees a key" on every platform.
   Recommendation: A.

10. **A Hana app that signs for partner apps (option C)?**
    - A. **Not now; revisit when a Hana consumer app has its own reason to exist and real installs** (recommended).
    - B. Add it to the existing Hana Wallet app: reuses a listing, but mixes two products and puts the Hana Wallet app
      into every shared scope's trust base.
    - C. A new Hana ID app: a second wallet in the stores, about 3 months, support burden.
    Recommendation: A.

11. **Which SDK first, built how?**
    - A. **React Native / Expo first (TypeScript over a small Swift/Kotlin module, with an Expo config plugin), then
      the Swift and Kotlin packages** (recommended): most embedded-wallet partners ship React Native; under option A
      the SDK holds no key, so a thin native layer is enough.
    - B. All three at once: 2 more weeks before the first partner can start.
    - C. Swift and Kotlin first, React Native wrapping them: cleaner layering, slower for the likely first partners.
    Recommendation: A.

12. **Expo Go.** Expo Go can't carry custom native modules, entitlements or associated domains.
    - A. **Dev builds for live apps; Expo Go only for `pk_test_` apps in `sandbox-*` envs, with a custom-scheme return
      and an in-memory companion key** (recommended): a five-minute quick start for developers, no weakening for live
      apps.
    - B. Dev builds only (as Privy, Dynamic and Web3Auth require).
    Recommendation: A.

13. **How does a signing request reach the sheet?**
    - A. **Through a server relay, the sheet URL carrying only a request id** (recommended): transactions can be many
      kilobytes, URLs end up in browser history and logs, and the relay ties each request to the companion key.
    - B. In the sheet URL: no new Durable Object, but size limits, history and no binding to the app.
    Recommendation: A.

14. **What do third-party in-app browsers (Instagram, TikTok, X) show for a partner's website?** Google refuses
    sign-in there (`disallowed_useragent`).
    - A. **Detect them and show "Open in Safari / Chrome" with a copy-link button instead of starting Google**
      (recommended): honest and cheap.
    - B. Start Google anyway and let it fail: today's behaviour, a confusing Google error.
    - C. Email login only inside in-app browsers (once email login ships): works, but creates a second login path
      users may not expect.
    Recommendation: A (C as an extra once email login exists).

15. **The passkey hybrid (a passkey on Hana's domain, its PRF output sealing the vault record).** It would remove
    iOS's alert (ephemeral sheets), decouple sessions from browser storage, allow weeks-long sessions and use Face ID as
    the Approve.
    - A. **A later batch, decided on pilot data (sheet friction, re-login rates)** (recommended): PRF support is uneven
      on Android and in third-party password managers, and a long-lived sealed record needs its own security review.
    - B. Now, inside this batch: about 3 more weeks and a new trust analysis.
    - C. Never.
    Recommendation: A.

16. **App Store releases before Hana's Apple login exists.** Guideline 4.8 requires an equivalent privacy-preserving
    login next to Google; Hana's email code login doesn't qualify, Hana's Apple login (D124) does.
    - A. **Build native support now; partners ship on Android and TestFlight, and on the App Store once Hana's Apple
      login is live** (recommended).
    - B. Move Apple login ahead of other work so App Store releases aren't blocked.
    - C. Let partners add their own Sign in with Apple next to Hana: passes review, but those users get a separate
      partner account without a Hana wallet (or a second wallet if Hana ever accepted the partner's Apple tokens).
    Recommendation: A, or B if a partner's App Store date requires it.

17. **Google's "don't use a web client type for native apps" rule.** Option A runs Hana's web client in Hana's web
    pages in the system browser; the native app never talks to Google.
    - A. **Proceed, and ask Google during brand verification (already a pre-mainnet step)** (recommended): the
      authorization request goes to a real browser, which is what the policy protects.
    - B. Register an iOS and Android client per partner app anyway: no use for the web flow, and each native client
      could derive that scope's users' keys (D42's warning).
    Recommendation: A.

18. **App attestation (App Attest, Play Integrity) for option A.**
    - A. **Not in v1** (recommended): the verified return link already binds the app; App Attest doesn't run in the
      Simulator and Play Integrity has daily quotas.
    - B. Required for live apps at activation: blocks modified or re-signed builds from posing as the app; extra
      failure modes (jailbroken devices, quota exhaustion, outages).
    - C. Optional per app (Coinbase CDP-style), off by default.
    Recommendation: A, with C as a later addition.

19. **A Privy-style remote signer (option D5) as a later, separate tier?** Raised 2026-11-04. A Hana enclave (for
    example AWS Nitro) would take the vault's place at login: it makes the CKD key `a` and the session key, decrypts
    the CKD answer and keeps PRK for the session; the app holds a device authorization key (Secure Enclave /
    Keystore) bound to the session and signs requests that the enclave executes, with no Hana screen. This is the
    model the [survey](#how-other-embedded-wallet-providers-do-it) records for Privy's native SDKs (key in a TEE, the
    app authorizes signing). Expected, to be confirmed by a spike: no contract, path or derivation change (the
    contract doesn't care who made `a` or the session key), so the same addresses. Unlike Privy, nothing would be
    stored between sessions: a new login derives the key again through the MPC.
    - A. **Not now; keep option A, and reach Privy-like UX through the passkey hybrid (D2, Q15) and delegated on-chain
      session keys (D4, Q7 C); revisit D5 as an explicit opt-in tier only if partners ask for silent native signing**
      (recommended). Under that tier the partner signs in writing that its app can sign anything silently while a
      session lives, and Hana Home shows it, as for option B (Q9).
    - B. Build it as an opt-in tier after option A: native UX (instant signing, no sheet or iOS alert, any session
      length). Costs: Hana's servers hold every live session's key, so a bad enclave build or a TEE flaw exposes them
      all; a new trust root next to the MPC (attestation, reproducible builds, key-release rules, watchdog, governance
      and its own audit); the approval becomes the app's UX, not a boundary; the product reads closer to custodial.
    - C. Never: "Hana's servers never hold a key" stays an invariant on every platform.
    Recommendation: A.
