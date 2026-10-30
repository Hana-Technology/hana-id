# Sign in with Apple spec (pre-mainnet)

**Status: DRAFT (2026-10-30), for review.** Specifies `docs/decisions.md` D124 (Sign in with Apple, after email login
and the partner identity token). 18 [open questions](#open-questions-for-the-user) for the user; nothing here is
decided until they are answered and recorded in `docs/decisions.md`.

This file becomes the source of truth for the batch once approved. If code and this spec disagree, fix the code or
raise the problem. Reference docs (`architecture.md`, `security.md`, `contract-interface.md`, `api.md`,
`integration.md`, `operations.md`, `playbooks.md`) are updated in the same branches as the code, not now.

## Contents

- [Summary](#summary)
- [What D124 assumed, and what Apple's documentation changes](#what-d124-assumed-and-what-apples-documentation-changes)
- [Goals and non-goals](#goals-and-non-goals)
- [Address impact (read first)](#address-impact-read-first)
- [Current state and baseline](#current-state-and-baseline)
- [How Sign in with Apple works (verified 2026-10-30)](#how-sign-in-with-apple-works-verified-2026-10-30)
- [What Privy does](#what-privy-does)
- [Design overview](#design-overview)
- [Apple developer team, App IDs and Services IDs](#apple-developer-team-app-ids-and-services-ids)
- [Login flow](#login-flow)
- [The on-chain token](#the-on-chain-token)
- [Contract, issuer and keys](#contract-issuer-and-keys)
- [Accounts and linking](#accounts-and-linking)
- [Email for Apple users (option B, only if Q1 = B)](#email-for-apple-users-option-b-only-if-q1--b)
- [Hide My Email users](#hide-my-email-users)
- [Identity token](#identity-token)
- [Export and Hana Home](#export-and-hana-home)
- [Revocation, account deletion and Apple's notifications](#revocation-account-deletion-and-apples-notifications)
- [Watchdog and governance](#watchdog-and-governance)
- [API changes](#api-changes-appsapi)
- [Popup, vault and SDK changes](#popup-vault-and-sdk-changes-packagesweb)
- [Manifest, secrets and D1](#manifest-secrets-and-d1)
- [Partner console and admin portal (batch C)](#partner-console-and-admin-portal-batch-c)
- [Threat model](#threat-model)
- [Privacy](#privacy)
- [Tests](#tests)
- [Migration and rollout](#migration-and-rollout)
- [Build order](#build-order)
- [Docs to update when built](#docs-to-update-when-built)
- [Sources](#sources)
- [Open questions for the user](#open-questions-for-the-user)

## Summary

"Sign in with Apple" becomes a third login method in the Hana popup, next to Google and email. Apple signs an
OIDC ID token (RS256, `iss` `https://appleid.apple.com`); the contract verifies it on chain exactly as it verifies
Google's, through a new issuer `apple` whose keys follow Apple's published JWKS through the same delayed, cancellable,
watchdog-checked key changes as Google's (D33, D80). The wallet path is `{scope}#apple#{sub}#{key_index}`: a new
provider name, so **no existing address changes**.

The proposed launch shape (Q1 = A) requests **no Apple scopes at all**. That keeps the on-chain token free of any
email (D25), lets Apple answer in the URL fragment, and so reuses today's static `/login/callback` page: no POST route,
no server-side token handling, `/login` stays fetch-free (D77). The cost: Hana never learns an Apple user's email,
so Apple identities never link automatically (D119); they join other methods only through explicit
`hana.linkAccount()`, and the partner identity token carries no email for Apple sign-ins. A first-login screen asks a
new Apple identity whether it already uses the app with Google or email, as Apple itself recommends, so a person
rarely ends up with two wallets.

Option B (Q1) adds the email later without moving anyone's address: a second, Hana-held Services ID in a separate
Apple "app group" requests `email` with `response_mode=form_post`, its token never goes on chain, and the email
issuer uses it off chain for D119-style matching (with an "Apple-hosted" twin of the Google-hosted rule) and for the
identity token's email claim. It costs a second Apple prompt at an Apple identity's first login in an app.

Every Apple client sits in **Hana's Apple developer team**, because Apple's `sub` is the same across a team's apps
and different in every other team. That team becomes an address-freeze input: moving Hana's Apple clients to another
team later would change every Apple user's `sub` and so every Apple wallet.

## What D124 assumed, and what Apple's documentation changes

Read with D124 in `docs/decisions.md`. Each point is cited under [How Sign in with Apple works](#how-sign-in-with-apple-works-verified-2026-10-30).

| D124 assumption | What Apple's documentation says | Consequence |
|---|---|---|
| "Requesting `email` makes Apple answer with `response_mode=form_post`, so the callback needs a POST route" | True ("If you requested any scopes, the value must be `form_post`"). But with `email` granted, Apple puts `email`, `email_verified` and `is_private_email` **in the ID token itself**, "on all subsequent API responses"; Apple has no userinfo endpoint. And scopes are **not incremental**: what a user granted at the first authorization of an app group sticks to every later token of that group, whatever later requests ask for (Apple DTS) | One Services ID that ever asks for `email` can never give an email-free token for the chain again, so D25 can't hold with D124's single-client plan. Either no email (Q1 = A: fragment, no POST route) or a second Services ID in its own group whose tokens stay off chain (Q1 = B). Putting the email on chain (Q1 = C) contradicts D25 |
| RS256, "already the contract's one algorithm" | Confirmed: discovery lists `id_token_signing_alg_values_supported: ["RS256"]`; the JWKS holds three RSA-2048 RS256 keys (2026-10-30). Apple's "Verifying a user" page says "JWS E256", which contradicts the discovery document and the keys (a doc error) | No contract change for verification |
| "Apple-hosted" twin of D119 (`icloud.com`, `me.com`, `mac.com`), "to be checked against Apple's documentation" | Apple documents no `hd`-like signal and, in the pages read, no statement that deleted iCloud addresses are never reissued (community answers conflict). iCloud+ custom email domains exist and can't be recognised by domain. Only relevant if Hana sees the email (Q1 = B) | The rule needs an Apple statement to cite before the freeze, or a code is required for Apple addresses too ([Q16](#open-questions-for-the-user)) |
| The App Store "generally expects iOS apps that offer a third-party login such as Google to also offer Sign in with Apple" | Guideline 4.8 today doesn't name Sign in with Apple: an app using a third-party or social login must also offer "an equivalent option another login service" that limits data to name and email, lets users keep their email private, and doesn't track for ads without consent | In practice Sign in with Apple is that option; Hana's email login doesn't qualify (the address isn't private). D124's reason stands, worded differently |
| "partners with native apps will ask for it" | Native Sign in with Apple uses the app's bundle ID as `client_id`, in the app's own team. A partner's iOS app is in the partner's team, so its native Apple sign-in yields other `sub`s than Hana's team | Partners' native apps can't use the native Apple sheet for Hana wallets; they use Hana's web flow ([Q5](#open-questions-for-the-user)). Privy can use the partner's bundle ID because its wallets aren't derived from `sub` |
| Hide My Email never matches by email | Confirmed by design. Also: relay addresses are per developer team, so one user has **one** relay address across all of Hana's partner apps, and mail reaches it only from senders registered in Hana's team (≤ 100 sources for an organization) | Matters only under Q1 = B, for the identity token's email claim ([Q18](#open-questions-for-the-user)) |
| (not in D124) | `response_type=id_token` alone is unsupported: it must be `code id_token`, so the fragment also carries a 5-minute authorization `code`. Redirect URIs can't be `localhost` | The callback drops `code`; `local*` envs test against the e2e stub issuer only |
| (not in D124) | An app transfer between teams gives every user a new `sub` and needs a list of every user's old `sub` within 60 days (TN3159) | Hana's team is permanent; Hana keeps no user list, so a transfer would also need the subs recovered from chain history ([Address impact](#address-impact-read-first)) |

## Goals and non-goals

Goals:

1. A user can sign in with Apple in the Hana popup on any browser and get a Stellar and an EVM wallet exactly as with
   Google, with no PII on chain (the token carries `iss aud sub iat exp nonce` and Apple's technical claims only).
2. An existing Google or email user's address doesn't move, bit for bit.
3. Apple's key rotations reach the contract through the existing delayed key changes, checked by the watchdog, with no
   new trust in Hana's servers.
4. Partners enable Apple per app, on the shared Apple client (Standard) or a Hana-held branded one (Enterprise, D42),
   and moving between them keeps addresses.
5. A partner's App Store app can meet guideline 4.8 by showing Hana's popup with "Sign in with Apple", and guideline
   5.1.1(v)'s deletion requirement with Hana's documented revocation path.
6. Production standards: tests for every behaviour, the watchdog extension, the recovery playbooks.

Non-goals (this batch):

- The Apple email in any form under Q1 = A (B is specified below so it can follow without an address change).
- Native Apple sign-in (`ASAuthorizationController`) inside partners' iOS apps ([Q5](#open-questions-for-the-user)).
- Apple's `name` scope, ever (D25: no name anywhere).
- Moving Hana's Apple clients to another team, or partner-held Apple clients ([Q3](#open-questions-for-the-user)).
- Sign in with Apple for the partner console or the admin portal (they stay on Google, D75).

## Address impact (read first)

**No existing address changes.** Google and email identities keep their paths; derivation v1, the CKD request, the
session nonce and every existing byte layout are untouched. An Apple identity's own path is
`{scope_id}#apple#{sub}#{key_index}`, built by the existing `create_session` code from the token's provider and `sub`.

New, and **frozen at the address freeze** (after it, never changed; before it, a change moves every Apple wallet on
sandbox-dev and must be called out):

| Input | Value | Why it decides addresses |
|---|---|---|
| Provider name | `apple` (`set_issuer("apple", …)`) | path = `s1#apple#<sub>#0` |
| `sub` | Apple's `sub`, as given (format `000123.<32 hex>.0456`, about 44 bytes, no `#`) | the path's `sub` |
| Hana's Apple developer team (Team ID) | the team that holds every Apple client ([Q2](#open-questions-for-the-user)) | Apple's `sub` is team-scoped: "Differs for the same user across different development teams". Another team = other subs = other wallets |

Not address inputs (may change freely): the Services ID (`aud`; Standard → Enterprise moves keep addresses, because
`sub` is team-wide), the app group, the Sign in with Apple private key, `iss` values, the callback path.

**A team change is an address change.** Apple's only migration is an App Store Connect app transfer, which gives
every user a new `sub` and a 60-day window in which the old team must produce a `transfer_sub` for each old `sub`
(TN3159). Hana keeps no user list (D96), so the old subs would have to be recovered from chain history (every
session's token is a public transaction argument), and the contract would need a governed upgrade mapping each new
`sub` to its old path. Neither is built; the spec treats Hana's team as permanent and the operations doc will say
"never transfer an app or Services ID out of Hana's team". Losing the team (membership lapse, termination) would end
Apple sign-in for every Apple user: their wallets stay derivable only through another linked method or an exported
key (D41), which is one more reason for the first-login screen and for Hana Home's export.

## Current state and baseline

Verified against the code on `develop` at 3f8cfe9:

- **Contract.** `verify_token` is provider-generic: `iss` → provider through the issuer registry, an active `kid`,
  RS256 only, `exp`, `sub` 1..=255 bytes without `#`, `aud` a single string 1..=256 bytes, JWT ≤ 7168 bytes. No claim
  allow-list on chain. `set_shared_clients` takes any configured provider (≤ 5 shared clients over all providers).
  Issuer keys: ≤ 10 per issuer, **≤ 6 pending key changes over all issuers**.
- **API.** `apps/api/src/jwt.ts` `ISSUER_PROVIDERS` knows Google's two `iss` values only; `jwks.ts` `JWKS_URLS` is
  `{google}`; `claims.ts` `ALLOWED_CLAIMS` is one global list (`iss azp aud sub iat exp nonce nbf jti auth_time`);
  `handleAppConfig` (`GET /v1/app`) returns a Google client or 409 `no_google_client`; `apps.google_web_client_id`.
  The key cron `syncIssuerKeys(env, provider = 'google', jwksUrl = GOOGLE_JWKS_URL)` is already parametrised by
  provider, and `key-observations.ts` records kids per provider.
- **Pages.** `packages/web/src/auth/google.ts` builds Google's URL (`response_type=id_token`, `response_mode=fragment`,
  `scope=openid`) and parses the fragment (`id_token`, `state`, `error`); the redirect URI is `{authOrigin}/login/callback`.
  `/login` has no `connect-src` (D77). The auth origin's Worker (`apps/api/src/pages/host.ts`) allows **GET and HEAD
  only**. The vault and export window hard-code `#google#` in the path (`vault/login.ts:357`,
  `auth/export-page.ts:457`) and the record check (`vault/vault.ts:1208`).
- **Watchdog.** Google only: `jwks_fetch`, `pending_key_changes` and `active_keys` read Google's JWKS; a pending change
  for another provider is `unverifiable_key_change` (alert only), or `updater_other_provider` (cancel, delete the
  updater keys) when the updater proposed it. `packages/jwks` exports Google's constants and an RS256 filter.

Baseline this spec builds on (D124: Apple comes after them; both approved, not built): the email login batch
(contract v3: identity keys, `opened`, accounts and links, `get_identity`, vault path resolution without `#google#`,
`GET /v1/app` `loginMethods`, the method chooser) and the identity token batch (`login_methods`). If Apple were built
first, its web step would carry the vault's provider-neutral path resolution itself (about +0.4k lines), and the
account rules below would wait for v3.

## How Sign in with Apple works (verified 2026-10-30)

From Apple's documentation, Apple staff answers on the developer forums, and Apple's live endpoints. Sources at the
end.

### Authorization request (web, REST)

`GET https://appleid.apple.com/auth/authorize` with:

- `client_id` (required): a Services ID for the web (an App ID for native apps); must not include the Team ID.
- `redirect_uri` (required): "must include a domain name and can't be an IP address or `localhost`, and must not
  contain a fragment identifier".
- `response_type` (required): `code`, or `code id_token`. "Requesting only `id_token` is unsupported. When requesting
  `id_token`, `response_mode` must be either `fragment` or `form_post`."
- `scope`: `name`, `email`, both or none. "Use space separation and percent-encoding" (`%20`; a forum report shows `+`
  silently dropping the scope).
- `response_mode`: `query`, `fragment` or `form_post`. "If you requested any scopes, the value must be `form_post`."
- `state`, `nonce`: returned as given; the nonce appears in the ID token.
- No `prompt`, `max_age` or `login_hint`. The user must interact every time ("User interaction is required any time a
  new identity token is requested"): Face ID or Touch ID on Apple devices, or Apple Account, password and a
  two-factor code on other devices.

Response: `code` (single use, valid 5 minutes, exchangeable only with Hana's client secret), `id_token`, `state`, and,
with `form_post` and scopes, a `user` JSON (`name`, `email`) **only the first time** the user authorizes. Errors:
`error=user_cancelled_authorize` is the only one documented.

### ID token

Claims (Apple's `id_token` reference): `iss` (`https://appleid.apple.com`), `sub`, `aud` (the `client_id`), `iat`,
`exp`, `nonce` ("present only if you pass it"), `nonce_supported` ("If this claim returns `true`, treat `nonce` as
mandatory"), `email`, `email_verified` and `is_private_email` (each "a string or Boolean"; email claims only when the
`email` scope was granted), `real_user_status` ("isn't present or supported for web-based apps"), `transfer_sub`
("present only during the 60-day transfer period"), `org_id` and `scopes` (Managed Apple Accounts in Apple School or
Business Manager only). Observed in real tokens but not in the list: `c_hash` (with `code id_token`), `auth_time`,
`at_hash`. The discovery document's `claims_supported` matches the list.

`sub`: "Uses the same identifier across all of the apps in the development team", "Differs for the same user across
different development teams", "Doesn't change if the user stops using Sign in with Apple with your app and later starts
using it again". Apple DTS: the user identifier and private email address "are team-scoped … They cannot be used or
mapped across development teams."

Lifetime: Apple documents no fixed `exp`; a 2019 sample showed `iat + 600 s` (to measure, step 0).

Scopes stick to the authorization: "Sign in with Apple does not provide incremental changes to the user scope. If the
application initially omitted, and later included, the email scope, only newly authorized users would include the
email claim" (Apple DTS, 2021); "If the original authorization request did not contain the email scope, the email will
not be returned in the initial authorization response, nor in the identity token on subsequent requests" (Apple DTS,
2024). The reverse (granted once, then not requested) is reported by developers to keep returning the email. Apple:
"the user's email is provided in the identity token for all requests".

### Keys

`https://appleid.apple.com/auth/keys`, fetched 2026-10-30: three keys, `kty RSA`, `alg RS256`, `use sig`, 2048-bit,
`e AQAB`, kids `8nTlO3M2Bk`, `GNCf4J83Oh`, `nP41CGTvOz` (10 characters). The response carries `Cache-Control:
no-store` (no `max-age` hint, unlike Google). Apple publishes no rotation schedule or lead time; the kids have changed
over the years (older tokens used 7-character kids). Discovery: `https://appleid.apple.com/.well-known/openid-configuration`.

### Services IDs, groups, return URLs

A Services ID is created in Certificates, Identifiers & Profiles and associated with a **primary App ID** enabled for
Sign in with Apple; "Under Website URLs, provide your domains, subdomains, or return URLs"; an organization can
register up to 100 website URLs; "You don't need to upload a file on your server" (no domain-verification file any
more). Apps and Services IDs grouped under one primary App ID share one user authorization: "If your app is contained
within an app group, the user credentials are associated with the primary app and shared across the group"; a user
consents once per group and sees the group in their Apple Account's "apps using Sign in with Apple". The App ID doesn't
need a published app.

### Client secret

Needed only for Apple's token, revoke and migration endpoints, never for verifying an ID token: an ES256 JWT signed
with a Sign in with Apple private key (`.p8`, P-256) downloaded once from the developer account, header `{alg: ES256,
kid: <10-character key id>}`, claims `iss` = Team ID, `iat`, `exp` ("It's an error to request an expiration time more
than 15777000 seconds (six months) in the future"), `aud` = `https://appleid.apple.com`, `sub` = the `client_id`.

### Private email relay

A user who picks "Hide My Email" gets an `…@privaterelay.appleid.com` address unique to the user and the developer
team. Mail to it is forwarded only from registered sources: "If you're enrolled as an individual, you can register up
to 32 email sources … organization enrollees can register up to 100", each passing SPF or DKIM with exact domain
alignment; unregistered senders bounce. The user can disable forwarding per developer (`email-disabled`
notification).

### Revocation, deletion and notifications

- Guideline 5.1.1(v): an App Store app that supports account creation must let users delete their account in the
  app (since 2022-06-30). TN3194 (2025): store tokens to support deletion, and revoke through `POST /auth/revoke`
  (needs a refresh or access token, so the code must have been exchanged with the client secret). "If you don't have
  the user's refresh token, access token, or authorization code, you must still fulfill the user's account deletion
  request": delete the data, direct the user to revoke manually in their Apple Account settings, and handle the
  `consent-revoked` notification.
- Server-to-server notifications (endpoint registered per primary App ID, TLS 1.2+, the same URL may serve several
  teams): a JWS signed with Apple's keys, `events.type` one of `email-disabled`, `email-enabled`, `consent-revoked`
  ("The user revokes consent for your app … and their credentials become invalid"), `account-deleted` (the Apple
  Account is permanently deleted: tokens invalidated, forwarding off). Each event carries `sub`.

### App transfer (TN3159)

Moving an app (and the Services IDs associated with its primary App ID) to another team: within 60 days the old team
generates a `transfer_sub` per user (`POST /auth/usermigrationinfo` with each old `sub`), the new team exchanges them
for new subs (and new relay addresses). Groups must be dissolved first. Missing the window means transferring back and
starting over.

### App Store guideline 4.8 (current text)

"Apps that use a third-party or social login service (such as … Google Sign-In …) to set up or authenticate the user's
primary account with the app must also offer as an equivalent option another login service with the following
features: the login service limits data collection to the user's name and email address; the login service allows
users to keep their email address private as part of setting up their account; and the login service does not
collect interactions with your app for advertising purposes without consent." Exceptions: the company's own account
system only, alternative marketplaces, education/enterprise accounts, government ID, clients of a specific third-party
service.

## What Privy does

From Privy's docs (2026-10-30):

- Apple can use **Privy's default credentials** or the app's **custom credentials** (Team ID, Services ID as Client ID,
  Key ID, signing key; redirect URI `https://auth.privy.io/api/v1/oauth/callback`). Apple is one of the providers whose
  credentials can't be changed freely: apps already on the defaults can't move to custom credentials, custom ones can't
  be reset, "due to user migration". That is Apple's team-scoped `sub`.
- Native iOS: the Client ID is the app's bundle ID (the partner's team), and Privy's Swift SDK launches Apple's native
  `ASAuthorizationController`; React Native/Expo fall back to the web flow on Android.
- Privy has a team-migration recipe: export users, generate `transfer_sub`s, exchange, send Privy a CSV mapping old to
  new subs; "same Privy ID, same linked accounts, same wallets". Privy can do this because its wallets belong to the
  Privy user, not to the Apple `sub`.
- Its docs read show no Apple-specific email linking rules.

Hana matches the default-credentials tier (the shared Apple client) and the "can't switch teams" property, and
differs on purpose where the `sub` is a derivation input: no partner-held credentials, no native bundle-ID clients,
no team migration.

## Design overview

```
partner page ──hana.login()──▶ vault (vaultOrigin) ──hana:auth-params (Google, email and Apple clients)──▶ /login popup (authOrigin)
                                                                                                │ user picks "Sign in with Apple"
                                                                                                ▼
             appleid.apple.com/auth/authorize?client_id=<Services ID>&response_type=code%20id_token
                       &response_mode=fragment&nonce=<session nonce>&state=<relayId>   (no scope)
                                                                                                │ Face ID / password
                                                                                                ▼
             {authOrigin}/login/callback#code=…&id_token=…&state=…   (the same static page as Google; `code` dropped)
                                                                                                │ encrypted relay slot
                                                                                                ▼
 vault: verify against get_issuer_keys("apple"), get_identity(scope,"apple",sub) → own path, member, or new
        new and the app offers other methods → first-login screen (Q12) in the popup
        → POST /v1/login → create_session_and_derive (contract verifies RS256 on chain) → CKD → wallet
```

Nothing new is trusted for key derivation: Apple signs, the contract verifies, the watchdog checks Apple's keys. What
is new is Apple itself as a trust root for Apple wallets, and Hana's Apple developer account as a phishing-capable
one ([Threat model](#threat-model)).

## Apple developer team, App IDs and Services IDs

### Team

One Apple Developer Program **organization** team owned by the entity that operates Hana ID ([Q2](#open-questions-for-the-user)).
Roles: Account Holder and Admin held by the two founders only, Apple Accounts protected with hardware security keys;
no other member gets "Certificates, Identifiers & Profiles" access. The Team ID is in the manifest (it isn't a
secret; client secrets need it). The team never transfers an app or Services ID out ([Address impact](#address-impact-read-first)).

### Identifiers

| Identifier | Kind | Group (primary App ID) | Used for |
|---|---|---|---|
| `id.hana.signin` | App ID (no app shipped) | itself | primary of the shared group, named "Hana" on Apple's screens |
| `id.hana.signin.web` | Services ID | `id.hana.signin` | the **shared Apple client** (Standard tier): `set_shared_clients` gains `["apple", "id.hana.signin.web"]` |
| `id.hana.signin.<partner>` + `.web` | App ID + Services ID | its own App ID | a **Hana-held branded client** per Enterprise partner (D42 twin), registered as that scope's own client (`AddClient{apple, …}`) |
| `id.hana.signin.home` | Services ID | `id.hana.signin` | Hana's own client for the `global` scope (like `googleClientIds`), if Hana Home needs one ([Q15](#open-questions-for-the-user)) |
| `id.hana.email.web` (option B only) | App ID + Services ID | its own group, never shared with a login client | the email-discovery client ([option B](#email-for-apple-users-option-b-only-if-q1--b)) |

Names are illustrative; the real ones go in `envs/<env>.json`. sandbox-dev and production use the same team (one
team per legal entity); they differ by scope (D51), so their addresses differ anyway. Each login Services ID's only
return URL is `{authOrigin}/login/callback` for every env that uses it; a Services ID never lists a partner's domain.

**One invariant guards D25: a login client's group never requests a scope.** If any client in a login group ever
asked for `email`, every later token of the users who authorized then would carry their email, and the API would
refuse them (`token_has_pii`) until they revoke Hana in their Apple Account settings. So: the URL builder has no scope
parameter for login clients (a test greps the built bundle), Apple's portal holds no other Services ID in those
groups, and the operations doc forbids adding one.

Groups ([Q4](#open-questions-for-the-user)): the shared client in Hana's group (the consent screen names Hana, as Google's shared client does); each
Enterprise client in its own group so Apple's screen and the user's Apple settings show the partner's name, and a
revocation affects only that partner. Every group shares the team's `sub`, so a Standard → Enterprise move keeps the
address.

### Tiers (D42 twin, [Q3](#open-questions-for-the-user))

| Tier | Apple client | Who holds it | Notes |
|---|---|---|---|
| Standard (default) | the shared Services ID | Hana | scope with `allow_shared`; Apple's screen names Hana |
| Enterprise | a branded Services ID per partner | Hana, in Hana's team | the scope's own client; Hana produces the client proof |
| Partner-held | — | refused | another team gives other subs (other wallets, and no later move to Hana's team without moving every address); the partner's team could also add return URLs and collect tokens. D42's "only if a partner insists" doesn't carry over |

## Login flow

Steps follow batch B's "Login" and the email spec's popup; only the Apple parts are new.

1. **App facts.** `GET /v1/app` returns `loginMethods` (the D1 setting ∩ what the scope can use) and, when Apple is
   on, `apple: {clientId, mode: "own" | "shared"}` chosen like Google's (`apps.apple_services_id` if set and still a
   scope client, else the scope's first Apple client, else the first shared Apple client in force when
   `allow_shared`).
2. **Popup.** The vault's `hana:auth-params` carries the Apple client next to Google's. `/login` shows "Sign in with
   Apple" in Apple's button style (the image assets vendored into the auth bundle: the CSP has `img-src 'self' data:`
   and no third-party origin); the partner's `loginMethods` narrows the list (`createHana`, as in the email spec).
3. **Authorize.** `/login` checks the pinned signer and recomputes the session nonce (unchanged, D77), stores the
   `relayKey` under the `relayId` (unchanged), and navigates to

   ```
   https://appleid.apple.com/auth/authorize?client_id=<clientId>&redirect_uri=<authOrigin>%2Flogin%2Fcallback
     &response_type=code%20id_token&response_mode=fragment&nonce=<nonce>&state=<relayId>
   ```

   built by hand with `%20` (not `URLSearchParams`, which writes `+`), and no `scope`. Export mode has no `max_age`
   equivalent and needs none: Apple always asks for Face ID, a passcode or the password.
4. **Callback.** Apple redirects to `{authOrigin}/login/callback#code=…&id_token=…&state=…` (or
   `#error=user_cancelled_authorize&state=…`). The same page as Google ([Q6](#open-questions-for-the-user)): it clears
   the fragment first (as today), takes the login entry for `state`, and relays `{idToken}` (or `{error}`) through the
   encrypted slot. The parser accepts exactly one `code` with an `id_token` and **drops it**: never relayed, logged,
   stored or shown (with Hana's client secret it would be exchangeable for Apple tokens). A fragment with `code` but no
   `id_token` is `malformed`. No `connect-src` change.
5. **Vault.** Verifies the token against the on-chain `get_issuer_keys("apple")` on its own RPC (defence in depth;
   no new `connect-src` for Apple's JWKS), checks `iss` is Apple's, `aud` is the client it prepared, the nonce, and that
   the token's claims pass the Apple allow-list ([below](#the-on-chain-token)). Resolves the path with
   `get_identity(scope, "apple", sub)` (email spec): `own` → `{scope}#apple#{sub}#0`; `member` → the root's path;
   `pending` → `link_pending`.
6. **First login in this app** (`own`, not `opened`, no account) and the app offers another method: the first-login
   screen ([Q12](#open-questions-for-the-user)) appears before anything is relayed or sent to the chain. The callback
   page decides it, as it already decides the identity token's email screen (D127): before relaying, it calls the
   identity spec's `POST /v1/identity/email-consent/lookup {pk, idToken}`, extended to also answer `hasWallet` (the
   identity, or its account root, is in `opened` in the app's scope; the API reads `get_identity` and reveals nothing
   the token holder can't read on chain). `hasWallet: false` → the screen; "Create my wallet" relays the token as
   usual; another method discards it. The vault re-checks the same facts on its own RPC (step 5).
7. **Chain.** `POST /v1/login` → `create_session_and_derive` with the Apple token, unchanged otherwise. The contract
   verifies RS256 against the active Apple keys and builds the path.

Timing: Apple's page adds its own time (biometrics on Apple devices, two-factor codes elsewhere); the Hana side is the
Google path's. Step 0 measures the whole login on Safari (macOS, iOS), Chrome and Firefox.

Apple's web page and pop-up windows: the popup is a normal top-level window that navigates to Apple and back, like
Google; sessionStorage survives the navigations (same tab, same origin). Step 0 checks iOS Safari, which may show the
system sheet, and that Apple's own COOP doesn't break the return.

## The on-chain token

Expected claims with no scope requested (to confirm in step 0 on several accounts, including one that once used
Sign in with Apple elsewhere): `iss aud sub iat exp nonce nonce_supported c_hash auth_time` (maybe `at_hash`). The
API's claim allow-list becomes **per provider**:

| Provider | Allowed claims | Refused (`token_has_pii`) |
|---|---|---|
| `google` | unchanged: `iss azp aud sub iat exp nonce nbf jti auth_time` | anything else |
| `apple` | `iss aud sub iat exp nonce nonce_supported c_hash at_hash auth_time` | `email`, `email_verified`, `is_private_email`, `org_id`, `scopes` (personal or organisational data), `real_user_status` (a fraud signal about the person), `transfer_sub` (only during a team transfer, which would move the address anyway); and anything else not allowed |

The API also requires `nonce` (the contract does too). `transfer_sub` would mean someone transferred a Hana app out
of Hana's team: the API answers `apple_team_changed` and alerts (critical). A refused Apple token gets a popup message
naming the cause: for `email` claims, "Hana can't use this Apple ID's sign-in because it shares an email with Hana;
remove Hana from your Apple ID's 'Sign in with Apple' settings and try again" (should never happen, by the
invariant above).

As for Google, the contract has no allow-list: a direct caller can put any valid Apple token on chain. Keeping
personal data off chain is the API's and vault's rule for tokens they relay (D25).

## Contract, issuer and keys

No contract code is needed for Apple itself:

- `set_issuer("apple", ["https://appleid.apple.com"])` (owner DAO proposal), then keys.
- Keys follow Apple's JWKS exactly as Google's do (D33, [Q7](#open-questions-for-the-user)): the API's updater key
  proposes an `Add` for every kid Apple publishes (`set_issuer_key`, waits `issuer_key_delay_ms`), the watchdog
  confirms early when the key matches Apple's JWKS, removals after the kid is missing ≥ 55 min, never the last key.
  Apple is **not** self-issued (that is the email issuer's governance-delay rule, for keys Hana holds).
- Clients: `set_shared_clients` adds `["apple", sharedServicesId]` (pending `change_delay_ms`, as any shared client);
  Enterprise scopes get `AddClient{apple, servicesId}` with a client proof (an Apple token from that client whose nonce
  is `client_proof_nonce`, made by staff through Hana's popup in a staff mode, like the Google proof). `remove_client`
  turns Apple off for a scope at once.
- Checks that already hold: RSA 2048 within 2048..=4096; kid 10 bytes ≤ 128; `aud` a string; `sub` without `#`; a
  token well under 7168 bytes; ≤ 10 keys per issuer (Apple has 3).

**One contract change proposed ([Q8](#open-questions-for-the-user)):** today's cap of **6 pending key changes over all
issuers** becomes **≤ 4 per provider and ≤ 10 in total**, folded into the v3 upgrade (email login). With two JWKS
providers a full Apple rotation (3 adds and 3 removals) could otherwise fill the queue and block a Google rotation, and
a stolen updater key filling one provider's slots (D126) no longer starves the other. No address effect; unit tests
for both caps.

**Lead time.** Apple publishes no schedule and its JWKS has no cache hint, so the delay's safety for Apple is unknown:
if Apple signs with a kid the moment it appears, Apple logins with that kid fail until the watchdog confirms it (one
cron period plus one watchdog run, ≤ 20 min today). Mitigations, all in this spec:

1. **Start measuring now** (build step 1, before any login code): the existing `key-observations.ts` records Apple's
   kids every 15 minutes, as it does Google's (`admin issuer-keys:lead-times --provider apple`), so first-seen-in-JWKS
   versus first-seen-in-a-token is known before launch.
2. **On-demand sync:** when `/v1/login` gets an Apple token whose kid is in Apple's JWKS but not active on chain, the
   API runs `syncIssuerKeys("apple")` at once (at most once per kid per 5 minutes) and answers `503
   issuer_key_pending` with `Retry-After`; the popup says "Apple just changed its keys; try again in a few minutes".
3. The watchdog confirms within its next run (5 min).

## Accounts and linking

On the email login batch's model (D119, D122): per scope, identities form accounts (a root whose path is the wallet,
≤ 3 members, one per provider). `apple` is one more provider.

Under Q1 = A (no Apple email):

- **No automatic linking for Apple.** No case of D119's four cases involves an Apple identity; Google/email
  auto-linking is unchanged. The issuer never sees an Apple identity.
- **Explicit linking works in both directions** with `hana.linkAccount({method})` (email spec "Explicit linking"):
  Apple as the new identity N (an Apple token whose nonce is `link_new`), or Apple as the active identity A proving the
  account (`link_account`). Pending `change_delay_ms` (24 h in production), notices as specified there. Apple's nonce
  is passed verbatim, so every existing nonce layout works unchanged.
- **First-login screen ([Q12](#open-questions-for-the-user)).** Apple's own guidance: "For new accounts that use Sign in with Apple, let the user know that
  they're creating a new account, and ask if they have any existing accounts to link to." When an Apple identity has no
  wallet and no account in this scope and the app offers other methods, the popup asks: "**{App}** has no wallet for
  this Apple ID yet. [Create my wallet] · Already use {App}? [Continue with Google] [Use email]". Choosing another
  method discards the Apple token (never on chain), signs in with that method, then offers "Add Apple sign-in to this
  wallet" (the explicit link: an Apple sign-in with `link_new`, a fresh sign-in of the active identity with
  `link_account`, pending 24 h) or "Not now". Shown at every Apple login of that identity in that app until it has a
  wallet or an account there (on chain, so on every device); after "Create my wallet" it never appears again.
- **D122 holds for detected matches only.** With no email, an Apple identity and a Google identity of the same person
  are never detected as a match. If the user picks "Create my wallet" while having a Google wallet, they have two
  wallets that can't be merged later (D122: `Both sign-in methods already have a wallet`). The screen is the
  mitigation; option B is the fix.
- Unlink, cancel, notices, banners, share revocation: as the email spec, with `apple` as a provider name.

## Email for Apple users (option B, only if Q1 = B)

Specified so it can follow A without an address change (the email client is another Services ID; `sub` is team-wide).

- **Client.** `id.hana.email.web`, in its own group, `scope=email` (never `name`), `response_mode=form_post`, return URL
  `{authOrigin}/login/apple/email`. Its tokens **never go on chain** (the contract doesn't know its `aud`: it is no
  scope's client and not shared, so a relayed one would fail `Token is for another app`; the API refuses it on every
  chain path anyway).
- **When ([Q17](#open-questions-for-the-user)).** After the login token (step 5) shows an Apple identity with no wallet and no account in this scope
  (where a match matters), and through `requestEmailSharing()` for the identity token. The popup navigates to Apple a
  second time with this client and a nonce `apple_match = b64url(sha256("hana-id/apple-match/v1" ‖ borsh(signer) ‖
  borsh(scope_id) ‖ sha256(session nonce preimage) ‖ utf8(sub)))`, binding the email token to this login and Apple user.
  The first authorization of this group shows Apple's "Share My Email / Hide My Email" sheet; later ones a
  confirmation (to measure: step 0).
- **POST route.** The auth Worker's first non-GET route: `POST {authOrigin}/login/apple/email`
  (`application/x-www-form-urlencoded`, ≤ 8 KiB, `Origin` must be `https://appleid.apple.com` or `null`). It parses
  `state`, `id_token`, `error`; never logs the body; discards `code` and `user`; and answers `303 See Other` with
  `Location: /login/apple/email-done#id_token=…&state=…` (or `#error=…`), `Cache-Control: no-store`, no cookie (D70). The
  static `/login/apple/email-done` page behaves like the callback (clear the fragment, take the login entry, relay
  `{appleEmailToken}`). A forged POST gets nowhere: the page relays only for a `state` stored in that tab, and the vault
  verifies the token and its nonce.
- **Matching.** The vault sends `POST /v1/email/apple-match {pk, appleSessionToken, appleEmailToken, commitment,
  linkTicket?, link}` to the email issuer, which verifies both tokens (same `sub`, the email client's `aud`, the
  `apple_match` nonce), reads `email`, `email_verified`, `is_private_email` transiently, and decides like
  `google-match`: a relay address or `email_verified` false → no match; otherwise `sub_E` = the email spec's HMAC of the
  normalized address, and the four cases with Apple in Google's place. **Apple-hosted** (`icloud.com`, `me.com`,
  `mac.com` after normalization, [Q16](#open-questions-for-the-user)) plays Google-hosted's role against an email
  identity: case A at once, silently; otherwise a code first. Apple identity against a **Google** identity with the same
  address: never at once (neither provider hosts the other's account): case A analogue with a code to the address, case
  B analogue pending 24 h. Hints: an Apple login that got the email writes `email_hints` like a Google login, so an email
  login later finds the Apple wallet (case B).
- **Identity token email.** The issuer seals the address (`src: "apple"`) as for Google. A relay address is shared as
  is; partners can only mail it if their sending domain is registered in Hana's team ([Q18](#open-questions-for-the-user)).
- **Size:** about 2.5k lines and 6–7 engineer-days on top of A (POST route and page, `apple-match`, issuer rules and
  hints, popup second step, relay-source tooling, tests).

## Hide My Email users

- Under A: Hana never asks for an email, so Apple shows no share/hide choice and Hana never receives any address.
  Nothing to handle.
- Under B: a relay address never matches by email (D124) and is never Apple-hosted; such users link by hand
  (`linkAccount`). Hana's own mail (email-login codes, link notices) never goes to a relay address it got from Apple
  (Hana sends to addresses typed at email login only). If a user types a relay address at email login, the code
  reaches them only if Hana's user-mail sending subdomain is a registered relay source in Hana's team; register it
  (one of the 100 sources), so such logins work instead of silently bouncing.

## Identity token

From `docs/identity-token-spec.md` (D127), unchanged except:

- `login_methods` gains `"apple"` (sorted with the others) for accounts with an active Apple member or root.
- `sub` for an Apple-root account comes from `(scope, "apple", apple_sub)` like any root; linking never changes it.
- Email claim: under A, an Apple session has no address to seal, so tokens for Apple sessions carry no `email` even
  when the app and the user enabled sharing (`requestEmailSharing()` in an Apple session says "Hana doesn't receive your
  email from Apple; sign in with Google or email to share it"). Under B, the sealed email comes from the email client
  (`src: "apple"`), possibly a relay address.
- The integration guide tells partners that Apple users may have no email in the token and a relay address under B.

## Export and Hana Home

- **Export** works for Apple wallets: the export window runs its own Apple login (fresh by construction: Apple always
  asks for biometrics or the password), resolves the path through `get_identity` (email spec), and refuses if the
  address differs from the vault's. Apple's `exp` isn't a freshness proof; the session nonce is.
- **Hana Home ([Q15](#open-questions-for-the-user)).** Every Apple client is Hana-held and returns to Hana's
  `authOrigin`, so Hana Home can export for Apple users of **every** app, Enterprise included (unlike Google, where an
  app on its own client can't be covered, D40). Home opens `/login?mode=home` with the app's Apple client, as for the
  shared Google client.

## Revocation, account deletion and Apple's notifications

### What a partner's App Store app needs

Guideline 5.1.1(v) makes the partner's app offer deletion of the partner's account. The Apple authorization, though,
belongs to Hana's client, so Hana provides the Apple part: "**Stop using Apple with Hana**" in Hana Home and the
account panel of the Hana popup ([Q11](#open-questions-for-the-user)). It explains that the wallet stays (keys are
derived, nothing to delete; export or link another method first), then:

1. A fresh Apple sign-in through the same client, purpose `revoke` (nonce `b64url(sha256("hana-id/apple-revoke/v1" ‖
   borsh(signer) ‖ borsh(scope_id) ‖ salt))`), whose callback relays `{idToken, code}` this one time (the only flow that
   relays `code`).
2. The vault calls `POST /v1/apple/revoke {idToken, code, salt}`. The API verifies the token (the revoke nonce, `c_hash`
   binds `code` to it), exchanges the code at `https://appleid.apple.com/auth/token` with a client secret it signs
   for that call (`exp` = now + 5 min), revokes the returned refresh token at `/auth/revoke`, and discards everything.
3. It revokes the vault shares of that identity's path in that scope (as an unlink does) and answers. Apple then shows
   the consent again at the next sign-in; the `sub` is unchanged, so the same wallet comes back.

No tokens are stored at login (TN3194 prefers storing them; D96 and the no-stored-credential design weigh against it,
and Apple documents the fallback: manual revocation in the user's Apple settings plus the `consent-revoked`
notification). The integration guide gives partners the wording for their deletion screen.

### The Sign in with Apple key ([Q9](#open-questions-for-the-user))

One Sign in with Apple private key (`.p8`, P-256) in Hana's team, used only to sign client secrets for revocation
(and a future migration). It is an API Worker secret `APPLE_SIGNIN_KEY` (PKCS #8), backed up in
`.secrets/<env>/apple-signin-key.p8` (0600), never printed (`scripts/apple.ts init` stores it from the downloaded file
and deletes the download). A thief can exchange intercepted codes (5 minutes, and Hana's pages never let one out except
in the revoke flow) and revoke users' Apple consent (an annoyance: the next sign-in shows Apple's consent screen; the
wallet is unaffected). It can't mint ID tokens. Rotation: create a new key in the portal, swap the secret, revoke the
old key. A Worker secret is acceptable on mainnet for this power (unlike the email or identity keys).

### Server-to-server notifications ([Q10](#open-questions-for-the-user))

`POST {apiUrl}/v1/apple/notifications`, registered for every primary App ID. The API verifies the JWS against Apple's
JWKS (`iss`, `aud` one of Hana's Apple clients, `iat` within 1 h, `jti` not seen in 24 h), then:

- `consent-revoked`, `account-deleted`: end that identity's Hana sessions. The API computes `sha256(path)` of
  `{scope}#apple#{sub}#0` for every scope that has an Apple client (or the shared one), revokes matching
  `vault_shares`, and for scopes where the identity is a linked member revokes the root path's shares too (one
  `get_identity` per such scope, bounded: the API caches which scopes have Apple clients). No `sub` is stored; the
  event is counted per day.
- `email-enabled`, `email-disabled`: ignored under A; under B nothing is stored either, so also ignored (the next
  sealed email reflects Apple's answer).
- Always `200` once verified (Apple retries otherwise); `400` for a bad signature, counted and alerted at volume.

`account-deleted` means the Apple Account is gone for good: that identity can never sign in again. The wallet remains
reachable only through a linked method or an earlier export. Hana can't notify the user (D96); Hana Home's and the
first-login screen's wording says it up front.

## Watchdog and governance

The watchdog (`apps/watchdog`) and `packages/jwks` generalise from "Google" to a **JWKS provider registry**:

```ts
JWKS_PROVIDERS = {
  google: { jwksUrl: 'https://www.googleapis.com/oauth2/v3/certs', issValues: ['https://accounts.google.com', 'accounts.google.com'] },
  apple:  { jwksUrl: 'https://appleid.apple.com/auth/keys',          issValues: ['https://appleid.apple.com'] },
}
```

- **`jwks_fetch`** per provider (no cache), first-seen times and material recorded per provider; `jwks_failing`
  per provider (details name it).
- **`pending_key_changes`**: for each JWKS provider, the existing rules against that provider's JWKS (confirm matches,
  cancel keys absent from two fetches ≥ 60 s apart or with other material, `published_key_removal` alerts). A pending
  change for a provider outside the registry and not self-issued stays `unverifiable_key_change`. The updater rule
  becomes: a change the updater proposed for a provider **outside its set `{google, apple}`** (e.g. `email`) is
  `updater_other_provider` (cancel, delete the updater keys).
- **`active_keys`**: every active `apple` key must be one Apple has published with the same material, else pause
  and `forged_active_key` (D82, D126: also delete every updater key); `stale_active_key` per provider; the first-run
  baseline per provider (adding Apple to an already running watchdog baselines Apple only).
- **New in `governance_diff`**: each JWKS provider's `iss_values` (from `get_issuer`) against the registry (critical
  `issuer_config_change` on any difference: `set_issuer` is owner-only and immediate, and a changed list is the first
  step of an issuer swap); the shared-client list already alerts as `config_change`.
- Alert texts and portal renderings name the provider; the playbooks in `packages/playbooks` for `forged_key_change`,
  `forged_active_key`, `jwks_failing`, `stale_active_key` and the new `issuer_config_change` say where to find each
  provider's JWKS and how to compare it. The registry test keeps every kind covered (D126).
- The watchdog's account and hosting (D86, D125) are unchanged. It never reads Apple's developer portal (Apple has no
  API for Services ID return URLs); that risk is covered under [Threat model](#threat-model).

Governance: `set_issuer("apple", …)`, `set_shared_clients` with the Apple client and the per-provider cap upgrade go
through the owner DAO (2-of-3, D81) like every owner action. The API's updater key gains no method (its three methods
are provider-generic).

## API changes (`apps/api`)

- `jwt.ts` `ISSUER_PROVIDERS` += `'https://appleid.apple.com': 'apple'`; `jwks.ts` `JWKS_URLS` += Apple's;
  `@hana-id/jwks` exports `APPLE_JWKS_URL`, `APPLE_PROVIDER` and the registry.
- `claims.ts`: the allow-list per provider ([The on-chain token](#the-on-chain-token)); `apple_team_changed` for
  `transfer_sub`.
- `/v1/login`, `/v1/sessions`: Apple tokens through the same checks (signature against Apple's JWKS, cached like
  Google's; `aud` a client of the app's scope or a shared client with `allow_shared`, `checkClientScope`); the
  on-demand key sync and `503 issuer_key_pending`.
- `GET /v1/app`: `loginMethods` includes `"apple"` when D1 has it and the scope can use an Apple client; `apple:
  {clientId, mode}`; `409 no_login_method` when nothing is left (email spec).
- Cron: `syncIssuerKeys(env, "apple", APPLE_JWKS_URL)` beside Google's, every 15 min; observations for Apple.
- `POST /v1/identity/email-consent/lookup` (identity spec, auth pages only) also answers `hasWallet` for any provider's
  token, for the first-login screen; same verification, no new data revealed.
- New: `POST /v1/apple/revoke` (vault and Home only: `x-hana-key`, origin checks, its own per-app and per-IP limits),
  `POST /v1/apple/notifications` (public, Apple-signed, per-IP limit), both `no-store`, neither logging tokens, codes or
  subs. The client-secret signer (`apple-client-secret.ts`: ES256 over WebCrypto from `APPLE_SIGNIN_KEY`, minted per
  call).
- Usage: Apple logins counted per app and day (batch C ledger event kinds gain `login.apple`).

## Popup, vault and SDK changes (`packages/web`)

- `auth/apple.ts` (beside `google.ts`): the authorize URL (no scope, `%20`, fragment) and nothing else; a test that
  the built bundle contains no `scope=` for Apple login clients.
- `auth/google.ts`'s fragment parser becomes provider-neutral (`auth/callback-fragment.ts`): `id_token`, `state`,
  `error`, an optional single `code` that is dropped (kept only in the revoke purpose).
- `/login`: the Apple button (vendored assets), the method list from the vault's auth params. The callback page shows
  the first-login screen after its lookup (login flow step 6); "Continue with Google" or "Use email" navigate the same
  window back through `/login` with that method preselected (the login entry and `relayKey` stay in its
  sessionStorage).
- Vault: Apple token verification against on-chain keys; Apple's allow-list mirrored; path resolution via
  `get_identity` (from the email batch); the first-login decision; `hana:auth-params` with the Apple client.
- Export window and Hana Home: Apple login and path resolution; the "Stop using Apple with Hana" flow.
- SDK: `loginMethods?: ('google' | 'email' | 'apple')[]`, `hana.login({ method: 'apple' })`,
  `hana.linkAccount({ method: 'apple' })`, `hana.account()` lists `apple`; errors `apple_cancelled` (from
  `user_cancelled_authorize`), `issuer_key_pending`, `apple_unavailable` (the app has no Apple client).
- Native apps: partners open the Hana popup flow in `ASWebAuthenticationSession` / `SFSafariViewController` (iOS) or
  Custom Tabs (Android); this depends on batch B's open question on mobile and in-app webviews (Q24) and is
  documented there, not built here ([Q5](#open-questions-for-the-user)).

## Manifest, secrets and D1

Manifest (`packages/env` schema, `envs/<env>.json`):

```jsonc
"apple": {
  "teamId": "ABCDE12345",                         // Hana's team (not secret; address-freeze input, documented)
  "sharedServicesIds": ["id.hana.signin.web"],    // set_shared_clients (≤ 5 shared clients over all providers)
  "servicesIds": [],                              // Hana's own, registered to `global` (Hana Home, if needed)
  "signinKeyId": "KEY1234567",                    // the .p8 key's id, for client secrets
  "emailServicesId": null                         // option B only; refused in sharedServicesIds/servicesIds
}
```

`gen` refuses: an Apple shared client that is also a scope client (the contract's disjointness), an
`emailServicesId` that is a login client, a Team ID that isn't 10 characters, and Apple in an env whose `authOrigin`
is loopback (Apple refuses `localhost`); `local*` envs use the e2e stub issuer with provider `apple`.

Secrets: `APPLE_SIGNIN_KEY` (API Worker; `.secrets/<env>/apple-signin-key.p8`, 0600). No other Apple secret.

D1 migration: `apps.apple_services_id TEXT` (an Enterprise app's branded client, like `google_web_client_id`),
`apps.login_methods` gains `'apple'` (default off), `apple_notifications_daily(day, type, count)`.

## Partner console and admin portal (batch C)

Following D83:

- **Partner console**: an "Apple" toggle per app (D1 `login_methods` plus, for Enterprise, the on-chain `AddClient`
  guarded like an origin change, D32; removal immediate through `remove_client`), the tier shown (shared or branded),
  Apple logins per day. Partners enable Apple themselves ([Q14](#open-questions-for-the-user)); a branded client is a
  Hana staff action (it needs Hana's Apple portal). The partner guide's 4.8 and 5.1.1(v) notes are linked.
- **Admin portal**: Apple issuer view (on-chain kids vs Apple's JWKS vs the watchdog's view, lead-time history,
  pending changes, on-demand syncs), the Apple clients per scope, notification counts by type, `apple_team_changed`
  and `issuer_key_pending` counts, the Sign in with Apple key's id and age.

## Threat model

| Threat | Bound or mitigation |
|---|---|
| Apple mints a token for any user (Apple compromise, insider, legal order) | Apple is a trust root for Apple wallets, as Google is for Google wallets. A user who links Google, email and Apple is reachable by whichever is weakest: the notices and the explicit link's 24 h delay make every link the user's own choice |
| A forged Apple key installed on chain (stolen updater key or owner DAO) | The same as Google's: `issuer_key_delay_ms`, the watchdog cancels keys Apple doesn't publish, pauses on an active one and deletes the updater keys (D82, D126); the per-provider cap keeps one provider's queue from blocking the other |
| A change to Apple's issuer config (`set_issuer` adding an `iss`, removing Apple's) | Owner DAO 2-of-3 only; the watchdog alerts on any `iss_values` difference; a new `iss` still needs keys, which wait the delay |
| **Hana's Apple developer account is compromised** (Account Holder or Admin) | The attacker can add return URLs on its own domain to Hana's Services IDs at once (no API to watch it) and phish: a user who signs in with Apple on the attacker's page gives a token with Hana's `aud` and a nonce the attacker chose, so a session and that user's key in every `allow_shared` scope (shared client) or that partner's scope (branded). The same power D42 describes for whoever controls a Google Cloud project. Mitigations: two founders only, hardware security keys on their Apple Accounts, no other team member with identifier access, a monthly manual review of every Services ID's return URLs logged in the admin portal, Apple's account-change emails routed to both founders. Residual risk accepted as for Google |
| A partner (or its team) obtains tokens | No Apple client is partner-held; Services IDs list only Hana's `authOrigin` |
| A leaked authorization `code` | Dropped by the callback, never relayed except in the revoke flow; useless without `APPLE_SIGNIN_KEY`; 5-minute life |
| `APPLE_SIGNIN_KEY` stolen | Can revoke users' consent (they consent again; same `sub`, same wallet) and exchange intercepted codes; no token minting. Rotate in the portal |
| Email on chain by accident (a login group gains the `email` scope) | The scope invariant (no scope parameter, bundle test, no other Services ID in login groups) and the API's allow-list refusing email claims |
| Login CSRF / token injection into the callback | Unchanged from Google: the relay needs the `relayKey` stored for that `state` in that tab; the vault checks nonce, `aud` and issuer |
| Under B: a forged POST to `/login/apple/email` | The page only relays for a stored `state`; the issuer verifies the Apple signature and the `apple_match` nonce; nothing is stored or logged by the route |
| Under B: a recycled or administrator-controlled mailbox | Apple-hosted only at once (if Q16 confirms it), Google identities never at once, otherwise a code or 24 h, as D119 |
| Managed Apple Accounts (school or company) | The organisation controls the account and so the wallet, like a Workspace administrator; `org_id` is refused by the allow-list ([Q13](#open-questions-for-the-user)) |
| Apple Account deleted or Hana's team lost | Apple sign-in ends for those users; the wallet stays reachable only through a linked method or an export (D41). Wording in the first-login screen and Hana Home |
| Apple key rotation with no lead time | Logins with the new kid fail up to ~20 min: on-demand sync, watchdog confirm, measured lead time before launch |
| Apple throttles frequent token requests ("calling for a new identity token … more frequently than once a day, can result in your request failing due to throttling", native guidance) | Hana asks for a token only at interactive logins and exports; step 0 checks whether the web flow is throttled for frequent logins (D43's session lengths keep logins rare) |

## Privacy

- On chain: Apple's `sub` (team-scoped, pseudonymous) in paths and token arguments, public forever; no email, name,
  organisation or fraud signal (allow-list). The `sub` reveals only "this Apple user of Hana's team", but it is the same
  in every Hana app (team-wide), as a Google `sub` is: the path's scope keeps wallets apart, and partners get the
  per-scope identity-token `sub`, not Apple's.
- Hana stores no Apple `sub` list, no Apple token, no code, no email (under B the address lives in one `apple-match`
  call's memory, as Google's does in `google-match`).
- Logs: never a token, code, `sub` or address; the notification counter keeps only type and day.
- Apple sees which Hana group a user signs in to (Hana, or the partner's name for branded clients), as Google does.

## Tests

### Contract (`tests.rs`, sandbox)

- An `apple` issuer with RSA keys, an Apple-shaped token (`sub` with dots, `c_hash`, `nonce_supported`, `email` absent)
  passes `create_session_and_derive`; the path is `s1#apple#<sub>#0` (golden), byte-identical to the generic format.
- Shared Apple client in an `allow_shared` scope; an Apple branded client as a scope client; `remove_client`.
- Per-provider pending cap: 4 per provider refused at the 5th, 10 in total, Google unaffected by a full Apple queue.
- Sandbox: Apple login through the relayer, CKD `app_id` matches the expected path; explicit link with Apple as N and
  as A.

### API (vitest)

- Issuer map, Apple JWKS cache, allow-list per provider (each refused claim, `transfer_sub` → `apple_team_changed`),
  nonce required; `GET /v1/app` Apple selection (own, shared, none, stale `apple_services_id`).
- On-demand sync: an unknown kid present in the JWKS triggers one sync and `503 issuer_key_pending`; absent → `401`.
- Client secret: header and claims, `exp` 5 min, signature verifies; never logged (log-capture test greps for the key,
  code, token and `sub`).
- `/v1/apple/revoke`: nonce and `c_hash` binding, token and revoke calls against a stub Apple, shares revoked, errors.
- `/v1/apple/notifications`: signature, `aud`, replay, each event type, shares revoked for own and member paths, `200`
  semantics.

### Web (unit)

- Apple URL (no `scope`, `%20`, fragment, nonce, state); bundle grep for `scope=` on login clients.
- Fragment parser: Google and Apple fragments, `code` dropped, duplicates refused, `user_cancelled_authorize`.
- Vault: Apple verification against on-chain keys, allow-list, path resolution, first-login decision, no `#google#`.
- Export and Home with Apple; the revoke flow relays `code` only in purpose `revoke`.

### Watchdog (vitest with stub RPC and two JWKS)

- Provider registry: confirm, cancel and pause per provider; an Apple forged key doesn't touch Google's state; first-run
  baseline per provider; `updater_other_provider` for `email` but not `apple`; `issuer_config_change`; `jwks_failing`
  per provider; playbook registry covers the new kind.

### Playwright (Chromium, WebKit, Firefox)

The e2e stub issuer gains an `apple` mode (Apple-shaped claims, `code id_token` fragment, `user_cancelled_authorize`):
Apple login gives a wallet; cancel; first-login screen → "Continue with Google" → add Apple (pending link) → the
partner page sees `linkChanged`; Apple as the active identity of an explicit link; export with Apple; a token with
`email` refused with the help text; on-demand key sync message. Under B: the POST route and second step with a stub
`form_post`.

### Testnet (sandbox-dev, real Apple)

Step 0's spike and the end-to-end login on Safari (macOS, iOS), Chrome and Firefox, login latency, the claim set, the
token lifetime, consent-screen naming per group, Apple's JWKS lead time from the observations.

## Migration and rollout

- **Apple setup (both founders, never agents):** the organization team (Q2), App IDs and Services IDs, return URLs,
  the Sign in with Apple key (`scripts/apple.ts init` → Worker secret and `.secrets`), notification endpoint, relay
  sources (Hana's user-mail subdomain). Documented in `operations.md` when built.
- **sandbox-dev:** start the Apple key observations at once (step 1); then the owner DAO proposes `set_issuer("apple",
  …)`; the updater syncs Apple's keys (60 s delay there) and the watchdog confirms; `set_shared_clients` adds the
  shared Apple client (waits `change_delay_ms`); D1 migration; Apple enabled for the demo app; watchdog redeploy with
  the registry. Apple wallets opened before the address freeze are test data.
- **Mainnet (at the address freeze):** the same steps by the user through the DAO; the team, the provider name and
  the scope invariant frozen; the per-provider cap ships with v3.

## Build order

Rough sizes (lines with tests, engineer-days). Option A unless noted.

0. **Apple team and spike** (0.2k, 1.5 d): identifiers in Hana's team; a spike page on sandbox-dev's `authOrigin`
   (like `apps/smoke/spike.html`): the no-scope token's exact claims for new and returning accounts (including one that
   granted email to another team's app), `exp − iat`, `%20` vs `+`, consent text per group, iOS Safari popup behaviour,
   repeated logins (throttling); under B, the second prompt's UX on Safari and Chrome.
1. **Key observations and sync for Apple** (0.3k, 1 d): cron and observations, `admin issuer-keys:lead-times
   --provider apple`. Can start now, before anything else.
2. **Contract: per-provider cap** (0.2k, 0.5 d), in the v3 upgrade.
3. **`packages/jwks` and watchdog registry** (0.7k, 2 d): providers, per-provider checks, `issuer_config_change`,
   playbooks, portal renderings.
4. **API** (0.9k, 2.5 d): issuer map, allow-list per provider, `/v1/app`, D1, on-demand sync, client secret, revoke,
   notifications.
5. **Web and SDK** (1.3k, 3.5 d): Apple URL, neutral callback parser, button, vault, first-login screen, Apple in
   `linkAccount`, export, Home, revoke flow, SDK types and errors.
6. **Manifest, scripts, deploy** (0.4k, 1 d): `apple` block and `gen` rules, deploy steps (`set_issuer`, shared
   clients), `admin client-proof --provider apple`, `scripts/apple.ts`.
7. **Partner console and admin views** (0.3k, 1 d; needs batch C's Workers).
8. **Playwright, sandbox-dev deploy and measurements** (0.7k, 2 d).

About 5.0k lines and 15 engineer-days for A; steps 1–3 can run beside the email batch. Option B adds about 2.5k lines
and 6–7 days after A.

## Docs to update when built

`architecture.md` (login flow with Apple, the provider list), `security.md` (Apple and Hana's Apple account as trust
roots, `APPLE_SIGNIN_KEY` in the inventory, the scope invariant), `contract-interface.md` (the `apple` issuer, the
per-provider cap), `api.md` (endpoints, errors, D1), `integration.md` (enabling Apple, tiers, native apps, 4.8 and
5.1.1(v) notes, no email for Apple users), `operations.md` (Apple team setup, Services IDs, key rotation, notification
endpoint, relay sources, "never transfer"), `packages/playbooks` → `playbooks.md` (provider-aware playbooks and
`issuer_config_change`), `decisions.md` (the answers to the questions below).

## Sources

Read 2026-10-30.

Apple:

- Incorporating Sign in with Apple into other platforms (authorize parameters, response):
  https://developer.apple.com/documentation/signinwithapple/incorporating-sign-in-with-apple-into-other-platforms
- Request an authorization to the Sign in with Apple server:
  https://developer.apple.com/documentation/signinwithapplerestapi/request-an-authorization-to-the-sign-in-with-apple-server.
- `id_token` claims: https://developer.apple.com/documentation/signinwithapplejs/authorizationi/id_token
- Authenticating users with Sign in with Apple (email in subsequent tokens, groups, duplicate accounts):
  https://developer.apple.com/documentation/signinwithapple/authenticating-users-with-sign-in-with-apple
- Verifying a user (verification steps, refresh tokens, throttling):
  https://developer.apple.com/documentation/signinwithapple/verifying-a-user
- Creating a client secret: https://developer.apple.com/documentation/accountorganizationaldatasharing/creating-a-client-secret
- Generate and validate tokens: https://developer.apple.com/documentation/signinwithapplerestapi/generate-and-validate-tokens
- Revoke tokens: https://developer.apple.com/documentation/signinwithapplerestapi/revoke-tokens
- TN3194, account deletions and revoking tokens:
  https://developer.apple.com/documentation/technotes/tn3194-handling-account-deletions-and-revoking-tokens-for-sign-in-with-apple
- TN3159, migrating users for an app transfer:
  https://developer.apple.com/documentation/technotes/tn3159-migrating-sign-in-with-apple-users-for-an-app-transfer
- Processing changes for Sign in with Apple accounts (server-to-server notifications):
  https://developer.apple.com/documentation/signinwithapple/processing-changes-for-sign-in-with-apple-accounts
- Configure Sign in with Apple for the web (Services IDs, website URLs, no verification file):
  https://developer.apple.com/help/account/configure-app-capabilities/configure-sign-in-with-apple-for-the-web/
- Configure private email relay service (sources, SPF/DKIM, 32/100 limits):
  https://developer.apple.com/help/account/capabilities/configure-private-email-relay-service
- App Review Guidelines 4.8 and 5.1.1(v): https://developer.apple.com/app-store/review/guidelines/
- Manage apps that use Sign in with Apple (manual revocation): https://support.apple.com/en-us/102571
- Sign in with Apple white paper (relay unique per user and developer):
  https://www.apple.com/privacy/docs/Sign_in_with_Apple_White_Paper_Nov_2019.pdf
- Live endpoints: https://appleid.apple.com/.well-known/openid-configuration, https://appleid.apple.com/auth/keys
- Apple DTS on the forums: scopes not incremental https://developer.apple.com/forums/thread/678930; no email when the
  original request lacked the scope https://developer.apple.com/forums/thread/745928; `sub` and relay team-scoped
  https://developer.apple.com/forums/thread/767711

Privy:

- Configure login methods (Apple default vs custom credentials, iOS bundle ID):
  https://docs.privy.io/basics/get-started/dashboard/configure-login-methods
- Apple team migration: https://docs.privy.io/recipes/apple-team-migration
- Swift Apple login (native `ASAuthorizationController`): https://docs.privy.io/recipes/swift/apple
- React Native Apple setup: https://docs.privy.io/basics/react-native/advanced/setup-apple-login

Hana: `docs/decisions.md` D25, D33, D40–D42, D77, D80–D86, D96, D119–D127; `docs/email-login-spec.md`;
`docs/identity-token-spec.md`; `docs/governance-spec.md`; `docs/batch-c-spec.md`; the code paths named under
[Current state](#current-state-and-baseline).

## Open questions for the user

Each question stands alone: the options, what each costs, and the recommendation. Answer by number ("Q3: A").
Questions 16–18 matter only if Q1 is B.

1. **How does Hana get an Apple user's email?** Apple puts the email inside the ID token whenever a user granted the
   `email` scope, and that grant sticks to every later token of the same Apple "app group". The token that goes on
   chain must stay email-free (D25).
   - A. **No email at launch** (recommended): no scopes, fragment response, today's static callback, no POST route, one
     Apple prompt per login. Apple identities never link automatically; they join other methods through
     `linkAccount()` (24 h delay), helped by a first-login screen (Q12). Identity tokens carry no email for Apple
     sessions. B can follow later without moving any address.
   - B. **A second, email-only Apple client** in its own app group: `scope=email`, `form_post` to a new POST route; its
     token never goes on chain; the email issuer uses the address off chain for D119-style matching and the identity
     token's email. Costs a second Apple prompt at an Apple identity's first login per app and about 2.5k lines more.
   - C. One client with `email`, the token with the email on chain: violates D25 (the address public forever).
   Recommendation: A now; B when a partner needs Apple users' emails or the duplicate-wallet rate (measured from the
   first-login screen's choices) says so.

2. **Which Apple developer team holds Hana's Apple clients?** Apple's `sub` is per team, so this team decides every
   Apple wallet forever; leaving it changes every Apple address.
   - A. **The organization team of the legal entity that will operate Hana ID long-term** (recommended): Account Holder
     and Admin only the two founders with hardware security keys; it may also hold Hana's own future native apps,
     which would then share the same `sub` (a Hana-made iOS app could use the native Apple sheet for Hana wallets).
   - B. The existing team that ships other Hana products (Hana Wallet, Wend), if that is a different entity: no new
     enrollment, but Hana ID's addresses would then depend on that entity and its App Store standing.
   - C. A new team for a new, Hana ID-only entity: the cleanest isolation, but a second legal entity and enrollment
     (Apple ties an organization enrollment to the entity's D-U-N-S number).
   Recommendation: A; decide before the first sandbox-dev Apple login you want to keep, and in any case before the
   address freeze.

3. **Apple client tiers.**
   - A. **Shared Hana Services ID (Standard) and Hana-held branded Services IDs for Enterprise; no partner-held Apple
     clients** (recommended): every client in Hana's team, so Standard ↔ Enterprise moves keep addresses.
   - B. Also allow a partner's own Apple team, as D42 tolerates partner-held Google clients: that partner's users get
     other subs (other wallets than in Hana's team, no move later), and the partner can collect tokens with its own
     return URLs.
   Recommendation: A.

4. **App groups.** A user consents once per group, and Apple's screen and the user's Apple settings show the group's
   name; revoking affects the whole group.
   - A. **The shared client in Hana's group; each Enterprise client in its own group** (recommended): Enterprise
     partners get their name on Apple's screen and a revocation affects one partner; the `sub` is the same everywhere
     (team-wide).
   - B. Everything in one Hana group: one consent per user for all apps, but Apple's screen always says Hana and one
     revocation logs the user out of Apple everywhere.
   Recommendation: A.

5. **Partners' native iOS apps.** Native Apple sign-in in a partner's app runs in the partner's team (other subs).
   - A. **Web flow only** (recommended): the partner opens Hana's popup in `ASWebAuthenticationSession` or
     `SFSafariViewController`; Apple's page offers Face ID there. Specified with batch B's open question on mobile and
     webviews (Q24).
   - B. Native sign-in in apps that Hana's team builds or hosts for partners: possible only for apps in Hana's team,
     which partners won't hand over.
   Recommendation: A.

6. **Callback path.**
   - A. **Reuse `/login/callback` for Google and Apple** (recommended): one static page, a provider-neutral parser that
     drops Apple's `code`; the vault checks which issuer it expected.
   - B. A separate `/login/apple/callback`: clearer logs and CSP per provider, a second page and route to keep in step.
   Recommendation: A.

7. **Apple's key changes.**
   - A. **Like Google's: the updater syncs Apple's JWKS, the watchdog confirms matches early, the same
     `issuer_key_delay_ms`, plus an on-demand sync when a login shows a new kid** (recommended): no outage longer than
     about a watchdog run on a rotation with no lead time.
   - B. Owner-posted only with the governance delay (the email issuer's rule): no updater power over Apple keys, but
     every Apple rotation would break Apple logins for up to 72 h.
   Recommendation: A, and start recording Apple's lead times now (build step 1).

8. **Pending key-change cap.** Today 6 pending changes over all issuers.
   - A. **≤ 4 per provider and ≤ 10 in total, in the v3 upgrade** (recommended): a full Apple rotation or a stolen
     updater key filling one provider's slots can't block the other provider's rotation.
   - B. Keep 6 in total: no contract change; a busy Apple rotation can delay a Google one.
   Recommendation: A.

9. **The Sign in with Apple private key (`.p8`) and revocation.**
   - A. **One key as an API Worker secret, used only to sign short client secrets for revocation; no Apple tokens
     stored** (recommended): its power is revoking consents and exchanging intercepted codes, never minting tokens.
   - B. No key until needed: nothing to protect, but no programmatic revocation (users revoke in their Apple settings,
     Apple's documented fallback).
   - C. Exchange every login's code and store refresh tokens (TN3194's preferred path): programmatic revocation for any
     user at any time, but Hana then holds a credential per Apple user, against D96's minimal-data design.
   Recommendation: A.

10. **Apple's server-to-server notifications.**
    - A. **Receive them; on `consent-revoked` or `account-deleted` end that identity's Hana sessions everywhere; store
        nothing but daily counts** (recommended): follows TN3194's "revert the client to an unauthenticated state".
    - B. No endpoint: simpler; a user who revokes Hana in Apple's settings stays signed in on open devices until the
        session ends (≤ 12 h by default).
    Recommendation: A.

11. **"Stop using Apple with Hana" (for partners' deletion screens).**
    - A. **In Hana Home and the popup's account panel, with a fresh Apple sign-in, then Apple's revoke; partners link
        to it from their deletion flow** (recommended): meets 5.1.1(v) for the Apple part; the wallet stays (keys are
        derived), with an export/link warning first.
    - B. An SDK method (`hana.revokeLoginMethod('apple')`) partners call in their own UI: more integrated, more surface;
        can come later.
    - C. Documentation only (manual revocation in Apple settings).
    Recommendation: A.

12. **First-login screen for new Apple identities.**
    - A. **Show it** (recommended, Apple's own advice): "No wallet for this Apple ID in {App} yet: Create my wallet ·
        Continue with Google · Use email", then optionally add Apple to that wallet (explicit link, 24 h).
    - B. No screen: one screen fewer; a user with a Google wallet who taps Apple gets a second wallet that can never be
        merged (D122).
    Recommendation: A (only shown when the app offers another method).

13. **Managed Apple Accounts (Apple School or Business Manager).** Their tokens may carry `org_id` (the organisation).
    - A. **Refuse `org_id` like an email claim** (recommended): no organisation on chain; such users can't sign in with
        Apple (step 0 checks whether no-scope tokens carry it at all).
    - B. Allow it: managed users can sign in, and their organisation's id is public forever next to their path.
    Recommendation: A.

14. **Who enables Apple for an app?**
    - A. **The partner, per app, off by default** (partner console toggle; Enterprise branded clients by Hana staff)
        (recommended): as D123 Q20 for email.
    - B. On for every app with shared login: more users get Apple without asking, but partners discover a new login
        method in their app they didn't choose (and its support questions).
    Recommendation: A.

15. **Apple in Hana Home.**
    - A. **Hana Home supports Apple for every app** (recommended): all Apple clients are Hana-held and return to Hana's
        origin, so even Enterprise apps are covered (better than Google's own-client apps, D40).
    - B. Only for shared-client apps, matching Google's coverage: simpler to explain, needlessly strands branded-client
        users if a partner shuts down.
    Recommendation: A.

16. **(Only if Q1 = B) The "Apple-hosted" rule.** Should an `@icloud.com`, `@me.com` or `@mac.com` address from Apple
    link at once to an email-login wallet, like a Gmail address from Google (D119)?
    - A. **Yes, once an Apple statement that such addresses are never reissued is cited in the guard test before the
        freeze; until then a code first** (recommended): the same standard as D123 Q7 for Gmail.
    - B. Yes, now: community answers suggest deleted iCloud addresses aren't reused, but Apple's pages read don't say so.
    - C. Never: always a code first for Apple addresses (one extra step for those users).
    Recommendation: A.

17. **(Only if Q1 = B) When does the second, email prompt run?**
    - A. **At an Apple identity's first login in an app (where a match matters) and through `requestEmailSharing()`**
        (recommended): returning users see one Apple prompt; the identity token's email is available after a first
        login or an explicit request.
    - B. At every login when the app has the identity-token email on: an email in every session, two Apple prompts every
        time.
    Recommendation: A.

18. **(Only if Q1 = B) Relay addresses in identity tokens.** Partners can mail a relay address only if their sending
    domain is registered in Hana's Apple team (≤ 100 sources per team, shared by all partners).
    - A. **Share relay addresses as is; register a partner's sending domain on request (staff, first come, logged), and
        tell partners the limit** (recommended).
    - B. Withhold relay addresses (no `email` for Hide My Email users): no limit to manage, but partners lose a working
        channel for users who registered their domain.
    Recommendation: A, and revisit when the source count passes 50.
