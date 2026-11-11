# Hana ID: start here (testnet pilot)

Hana ID gives each of your users a Stellar wallet and an EVM wallet when they sign in with Google or with a code sent
to their email. There is no extension and no seed phrase. Keys never reach your page: they stay in a hidden Hana frame,
and every signature needs the user's Approve in a Hana window. This page is the short version. The integration guide
(`integration.md`, sent with the SDK) has the detail; each step below names the guide's section.

Last verified against code: 2026-11-11.

> **This environment, `sandbox-dev`, is testnet only.** Its wallets are test wallets: until Hana's address freeze,
> Hana may still change how keys are made, which gives every user new addresses. Never keep real funds in them. A test
> app (`pk_test_…`) signs for test networks only.

## What to send Hana

- **The app's name**, as your users will see it in Hana's windows ("Signing in to {name}"). It can't look like a web
  address or have a word starting with "Hana" (guide section 1, "App names").
- **Every origin the app runs on**, exactly: scheme, host and port, no path. For development, for example
  `http://localhost:5173` (`http://localhost:5174` is a different origin). At most 20 per app.
- **The Google account of each person who will own your organisation** (up to 5). Each gets an emailed invite and signs
  in to the partner console with that Google account. Hana adds these accounts to its Google test list (below),
  without which Google blocks the console sign-in. The owners Hana registers can change your app's security settings,
  and stay able to until another owner removes them, even after leaving your organisation: name only people who should.
- **A security contact**: an email address for the security notices ("What to expect on testnet"). The owner's own
  address is fine.
- **Which sign-in your users will use**: email for now (below).

## Sign-in for your testers: use email for now

Hana's shared Google sign-in is in Google's testing mode: Google lets through only the accounts Hana adds to its list
by hand, and shows anyone else "Access blocked: … has not completed the Google verification process". So for your
testers, use **email sign-in**: they type their address in Hana's window and get a 6-digit code.

An owner turns it on in the partner console: **Apps**, your app, the **Email login** tab. It shows a **Status** and two
steps. Each step's button, **Review and confirm with Google**, opens a confirmation page: click **Confirm with
Google**, sign in with your console account, and the page says **Done.** with **Back to Email login**, which returns
to the tab.

1. **Turn email login on for this app.** In force at once. Status: **One step left**.
2. **Add the scope's email client on chain.** Only an on-chain owner (one of the owners Hana registered) can do this
   step. Status: **Waiting for the chain**, with "You can execute this from" and the time: the chain makes everyone
   wait 1 minute on sandbox-dev, so other owners could cancel it. Leave the tab open: at that time it checks again by
   itself (no reload needed), the status turns to **Ready to execute**, and any owner clicks **Execute the change**.
   Status: **On**.

Until both are done, email isn't offered (`login_method_unavailable`). With email on, `hana.login()` lets the user
choose Google or email; `hana.login({ method: 'email' })` skips the choice, so testers never reach Google's block.
Your own Google client is an option for later (guide section 6).

## What you get back

- **The invite email**, "You're invited to {organisation} on Hana ID": click **Sign in with Google to accept** with the
  Google account it was sent to. The link works once, for that address only, for 7 days from when Hana created it.
- **The partner console**: `https://hana-id-console-sandbox-dev.tingtc.workers.dev` (later visits:
  **Sign in with Google** at `/signin`). This address will change when Hana moves to its permanent addresses.
- **Your app's page** (console, **Apps**): the **App ID** and the **Publishable key** (`pk_test_…`), each with **Copy**,
  and a **Getting started** checklist on its Overview.
- **The SDK**: four files, `hana-id-core-<version>.tgz`, `hana-id-web-…`, `hana-id-react-…` and `hana-id-sodax-…`, and
  `SHA256SUMS`. Before installing, run `shasum -a 256 -c SHA256SUMS` in their folder: every line must end in `OK`.
- **The sample app** (Vite, React, TypeScript), on `http://localhost:5173`: ask for that origin. Its Connect, Wallet,
  Sign and Identity token pages work with your test key. Its mainnet steps (the USDC trustline, the Sodax swap) use a
  demo exception only Hana's own app has, so with your key they stop at "Mainnet signing is off for this app".

## Your first sign-in

1. **Install** the files together: `npm install ./hana-id-core-<version>.tgz ./hana-id-web-<version>.tgz`, plus react
   and sodax if you use them. Commit them and depend on them by path (guide section 2).
2. **Create the client** once per page: `createHana({ publishableKey: 'pk_test_…', environment: 'sandbox-dev' })`
   (guide section 3).
3. **Call `hana.login()` in a click handler**, before any `await`, so the browser lets Hana open its window
   (guide section 4). Signing calls go in the click too (guide section 8).
4. **Your page**: allow `https://hana-id-vault-sandbox-dev.tingtc.workers.dev` in your CSP `frame-src`, allow popups,
   don't send `Cross-Origin-Opener-Policy: same-origin`, and pin your dev server's port (guide sections 3 and 5).

If `hana.ready` rejects with `vault_unavailable` and `data.reason: 'no_answer'` (after about 3 seconds), the page's
origin isn't exactly one of the app's active origins: compare `error.data.origin` with the **Origins** tab.

## What to expect on testnet

**Changes are announced before they count.** Adding an origin (or an auto-approve policy) is confirmed with Google,
then announced by email to your security contacts and to Hana within about 5 minutes. The **Origins** tab shows each
step. It then takes effect:

- **at once**, when announced, for a `http://localhost:<port>` origin (or `http://localhost:*`) on a test app, and for
  any change while nobody has signed in yet and none of your origins has been active (the origins Hana adds when it
  creates your app usually take effect this way);
- **otherwise 1 minute after the announcement** (24 hours in production). Removing an origin is immediate.

**The emails you will receive** (from `team@hanawallet.io`; on testnet the subject starts with `[SANDBOX]`):

| Email | What it is for |
|---|---|
| "New allowed origin proposed for {app}" (or "Auto-approve policy proposed") | A change that isn't in force yet, with a **Cancel this change** button. Cancel it if you didn't expect it: the page asks you to confirm, and opening the link alone changes nothing |
| "Changes to your apps" | A digest of changes already in force or done (an origin in force, a key created, a setting changed) |
| "Console activity" | Members, invites and organisation settings that changed |
| "Security events were recorded" | Something Hana's systems flagged. Reply, or tell your Hana contact, if it is unexpected |
| Others | Someone invited to your organisation, "Email login turned on for {app}", a change to your scope proposed or made on chain |

**Hana never asks you to approve anything from an email.** An email only tells you, or lets you cancel. Approving
happens in the console, after a fresh Google sign-in.

**Sessions.** A user stays signed in across reloads and tabs for 12 hours, or until 2 hours without use (both
adjustable on **Login & sessions**). A user can also sign a device out from Hana Home, Hana's own page at
`https://hana-id-auth-sandbox-dev.tingtc.workers.dev/home` (nothing links to it yet, so users go to that address; it
will change with Hana's permanent addresses). Your open tab then shows signed out within about a minute (a few minutes
in a tab nobody is using), with `disconnect` and `reason: 'signed_out'` (SDK 0.3.1 or later). Show "You were signed
out, sign in again"; no reload is needed (guide section 3).

## What you do, and what Hana does

**You, in the partner console**: origins; keys (create, rotate, revoke); email login; **Login & sessions** (session
limits, email sharing); **Signing** (the auto-approve policy); **Branding** (name and logo); **Suspend**; **Members**
(invite owners and viewers); **Users** (find a user by wallet address, User ID or Support ID); **Usage**;
**Statements**; **Audit**. Changes that matter ask you to **Confirm with Google**. Origins, policies and email login's
second step need an on-chain owner; anyone else sees one line naming them.

**Hana, during the pilot**: creates your organisation and your apps, registers your scope (the on-chain record that
holds your users' wallets and names your on-chain owners), sets your security contacts and adds Google test users.

## Limits worth knowing in the first week

- **Test networks only**: the Stellar testnet and EVM testnets such as Sepolia, Base Sepolia and Sonic testnet
  (guide section 12 lists them). A mainnet request fails with `4100` and `data.reason: 'mainnet_not_allowed'`. Sodax
  runs on mainnet only, so with a test app you can quote and build Sodax intents but not sign them. A test app never
  has raw signing.
- **Email codes**: a code lasts 10 minutes and allows 5 wrong tries, with up to 2 resends 30 seconds apart. Each app
  can send about 100 code emails a day, within a daily total every app on sandbox-dev shares; past it, email sign-in
  answers `rate_limited` until 00:00 UTC.
- **Sign-ins**: 20 a minute per app from one IP address (a team testing from one office shares it), 60 a minute per app.
- **Key export**: 3 an hour per user and app. **Identity tokens**: 10 a minute per session.
- **The invite link**: one use, 7 days. **Console sessions**: 12 hours, ending after 2 hours without activity.

## Getting help

- **Support ID** (`HANA-XXXX-XXXX`): a user sees it in Hana's approval window under their account, and on Hana Home
  (on your app's page there).
  Your page has it as `hana.supportId`: show it where your users look for help. The console's **Users** page finds a
  user by it.
- **Request ID**: on an error that came from Hana's API, `error.requestId` in the SDK; on every row of the console's
  **Audit** page.
- Send your Hana contact the Support ID, the request ID, the error `code` and `data.reason`, when it happened (with
  the time zone) and the app. Neither ID is a secret: nobody can act on a wallet with them.
