# Journear Passport inside Sodax's SDK: what works today and the plan

Sodax (a cross-chain swap SDK: `@sodax/sdk` with its wallet kit `@sodax/wallet-sdk-react` and `@sodax/dapp-kit`) wants
to put Journear Passport inside its own SDK, so that a Sodax partner turns on sign-in with Google or email with a
switch in Sodax's partner portal. This page says what works today, what is missing, who would build what, the risks
and the questions to settle with Sodax. Decision: D909 in `decisions.md`.

Last verified: 2026-11-24 (branch `docs/sodax-sdk-integration`, from `next`, not merged, not deployed: written from
the code and a local test against Sodax's public packages at 2.2.0, their latest release; `2.3.0-rc.4` lists the same
chains).

**Status in one line:** the founder decided that every Sodax partner site shares one wallet (one app per partner, all
in Sodax's organisation on one scope). Nothing for the portal switch is built. Who vouches for each partner's web
address is parked until the founder has talked to Sodax.

## Summary

| | Today |
|---|---|
| Our wallet in Sodax's EVM wallet list | **Works with no Sodax-specific code**: create the client and "Journear Passport" appears (EIP-6963) |
| Our wallet in Sodax's Stellar wallet list | **Needs a change in Sodax's kit**: its Stellar Wallets Kit can't take an extra module |
| Signing through Sodax's own wallet providers | **Works** on EVM and (with the change above) on Stellar; a test app is refused on mainnets, as designed |
| One wallet across partner sites | **Works** (one scope); **nothing tells the user** the wallet is shared |
| A switch in Sodax's portal | **Missing**: no service-to-service API exists; apps are made by Journear staff |
| Our SDK on npm | **No** (tarballs, D706) |
| Real swaps for Sodax partners | Only through the staff-only mainnet demo (Base and Stellar, $9.99 a transaction); real launch needs live keys |
| Sodax's chains | EVM chains and Stellar covered; Solana, Sui, Bitcoin, Injective, ICON and Stacks planned (below) |

## 1. What we checked, and how

A one-off page in a scratch folder (not in this repository): React 19, `@sodax/wallet-sdk-react` 2.2.0 (with its
`SodaxWalletProvider`, `useXConnectors`, `useXConnect`, `useWalletProvider`), `@sodax/sdk` 2.2.0 and our SDK from
this branch's sources. It ran against the local stack (`apps/e2e`, port base 4930) with the pretend Google, driven by
Playwright in Chromium. Every request to a host outside the computer was answered locally or blocked: none was made,
nothing was broadcast, no real account or funds were used. Base's RPC was a local stand-in that keeps a broadcast
instead of sending it (none arrived).

| Check | Result |
|---|---|
| Sodax's kit alone | EVM list empty; Stellar list Albedo, xBull, HOT Wallet (the ones that need no extension) |
| `createHana({ evm, stellar })` and nothing else | EVM list gains "Journear Passport" with its icon; Stellar list unchanged |
| The same, created 2 s after Sodax's kit mounted (as a switch read from a server would) | EVM: still appears (EIP-6963 listens all the time) |
| A Stellar connector passed in Sodax's `config.STELLAR.connectors` | Replaced by Sodax's own discovery: never shown |
| Our Stellar module pushed into Sodax's kit's private module list before discovery | Appears as "Journear Passport"; connect works and gives the same address as our client |
| The same push 2 s later | Never appears (Sodax looks for Stellar wallets only in the first half second) |
| Connect EVM through Sodax's own connect | Our sign-in window opens; after the pretend Google, Sodax has the address and its own `EvmWalletProvider` |
| Send on Base (8453) through Sodax's `EvmWalletProvider`, test key | Refused before any window: `4100`, "Test apps can sign only for test networks" |
| Sign a Stellar public-network payment through Sodax's `StellarWalletProvider`, test key | Refused, but Sodax reports only "Failed to sign transaction" and drops our code |
| A test app with the mainnet demo on, Base and Stellar through Sodax's providers | The approval shows the red "Real money, test system" banner, the value and the $9.99 limit; Reject reaches Sodax as `4001` (EVM) or "Failed to sign transaction" (Stellar) |
| Two apps on one scope, two web addresses, the same Google account | The same EVM and Stellar addresses on both |

Not checked: Firefox and Safari (Safari blocks a window opened after Sodax's own waits, so the sign-in goes through our
"Sign in with Journear Passport" button in the page, as `apps/e2e/tests/interfaces.spec.ts` shows for wagmi); a real
Google account; Sodax's swap itself on a real network; `@sodax/dapp-kit`'s hooks (it builds on the wallet kit and
`@sodax/sdk`).

## 2. What Sodax's SDK would do to embed us

**Packages.** `@hana-id/web` (with `@hana-id/core`, its dependency). Through Sodax's own wallet kit Sodax does not need
`@hana-id/sodax`: its `EvmWalletProvider` drives our EIP-1193 provider and its `StellarWalletProvider` drives our Stellar
Wallets Kit module. `@hana-id/sodax` stays for apps that use `@sodax/sdk` without Sodax's kit (it checks the sender
before any window and keeps our error codes).

**The key at run time.** The switch in Sodax's portal maps a Sodax partner to its Journear app's publishable key
(`pk_test_…` now, `pk_live_…` after launch). The key is public, so Sodax's SDK can read it from Sodax's partner
configuration at run time and call `createHana({ publishableKey, environment, evm, stellar })`. What protects it is the
app's list of allowed web addresses on our side.

**Loading only when the switch is on.** Possible: `@hana-id/web` has no side effects on import, so
`await import('@hana-id/web')` when the switch is on keeps it out of every other partner's page. Creating the client
inserts our hidden frame at once (one page load and one `GET /v1/app`), so create it only when the switch is on.

**Registering us, per chain family.**

| Family | What Sodax's SDK does | Sodax code change? |
|---|---|---|
| EVM | Nothing beyond creating our client: wagmi's EIP-6963 discovery lists us, also when created late | No |
| Stellar | Let its `StellarXService` take extra Stellar Wallets Kit modules (for example a `modules` option next to `allowAllModules()`), add `new HanaIdModule(hana)` there, and look for wallets again when one is added later | Yes, small |
| Stellar errors | Keep the wallet's `code` and `message` when the wallet's error isn't an `Error` object, so users see our reason, not "Failed to sign transaction" | Yes, small |
| Others | Not offered until we cover the chain (section 6) | Later |

**Size.** `createHana`, the Stellar module and the Sodax adapters together are about 114 kB minified, 36 kB gzipped
(measured with esbuild from this branch). Our test page with Sodax's wallet kit was 11.3 MB minified, so ours is about
1 percent of it; loaded on demand it costs nothing when the switch is off. Sodax's kit also needed stand-ins for Node's
`crypto` and `stream` in the browser; a partner's bundler already handles that for Sodax.

**npm.** Not published: `@hana-id/core`, `@hana-id/web` and `@hana-id/sodax` answer "not found" on the public npm
registry (checked 2026-11-24). Partners get tarballs (D706). An SDK that depends on us needs a registry: the choice of
public npm (or a private registry), the licence of `@hana-id/core` (BUSL today, D747), provenance, a publish token in
a protected environment, and removing `"private": true` (`operations.md`, "Publishing: what is left to enable it").

## 3. The portal switch: what our side lacks

**Today** no other company's backend can create an app, set its web addresses, read its key or switch it off:

- Apps are created only by Journear staff (`AdminRpc.createApp` from the admin portal, or `admin <env> app:create`).
- A partner changes its apps in our partner portal as a person: a Google sign-in, and for adding a web address a fresh
  Google sign-in by an on-chain owner of the scope (the console's step-up), checked by the API.
- Adding a web address waits after it is announced by email to the security contacts and to Journear: 24 hours on a
  production network, 60 s on sandbox-dev. On a shared scope the "nobody has signed in yet" exception ends with the
  scope's first user, so every later partner's addresses wait the full delay.

**The smallest safe design** (not built; to settle with Sodax and after the origin question):

1. **Who calls.** Sodax's backend gets a service credential bound to Sodax's organisation and scope: a signing key
   whose public half Journear staff register, each request signed with a time and a single-use number (no shared
   secret to leak from a log). Two credentials at most, so one can be rotated.
2. **What it may do.** Create a test app in Sodax's scope (name, first web addresses); propose web address additions;
   remove web addresses; read the app and its publishable key; suspend and resume (the partner's own bit); revoke
   and create keys. Nothing on chain, no owners, no auto-approve policy, no raw signing, never the mainnet demo.
3. **Limits.** A few apps per day per credential, at most 20 web addresses per app (as today), live apps only once
   live keys exist and only with Journear staff's approval.
4. **The delays stay.** Every web address it adds is a proposal like a staff one: announced to Sodax's security
   contacts and to Journear, cancellable from the email, in force 24 hours later on production. Removing and
   suspending are immediate.
5. **Audit.** Every call is recorded as the service actor in the existing change and audit records, with the
   request id, and shown in the portal's Audit page and the staff portal.
6. **Off switch.** Journear staff can revoke the credential at once; the partner switch off in Sodax's portal maps to
   suspending the app (logins stop at once; open pages notice within 30 s).

**What it reuses:** `AdminRpc`'s `createApp`, `addOrigins`, `removeOrigins`, `getApp`, `createKey`, `rotateKey`,
`revokeKey`, `setSuspended`; the guarded-change records and their announcements and cancel links; the rate limiter;
the audit log; the console's step-up checks as the model for checking a signed request. **What is new:** a service
actor kind, a table of registered keys, one small route that checks the signature and maps each call to the methods
above, staff screens to register and revoke a key, docs and tests. **Size:** medium, about one batch-C step (a few
weeks with its review), plus the origin decision.

## 4. One wallet across partner sites

**What users see today.** The sign-in window says "Signing in to {App} at {web address}" and the approval window
"From {App}" with the web address. Neither says that the wallet is also used on other sites. Signing in on a second
partner site opens the same wallet without a word about it. Only Passport Home lists the apps that use a wallet.

**What must stay off for apps on a shared scope** (each is per app today, but every one reaches the same funds):

- auto-approve policies, until the user is told which other sites share the wallet and a policy can't outlast that;
- raw signing (already refused for test apps);
- the mainnet demo, except under staff's per-app rule (section 5);
- gas sponsorship for EVM actions (not live), until each partner's sponsored calls are reviewed.

**Gaps before real money:**

1. A line in the sign-in window when the wallet is shared: "This wallet is also used on {other apps}." (wording to
   decide), and in the approval window.
2. The identity token's User ID is the same for a user across every app of a scope, so every Sodax partner's backend
   can match the same person across sites. Decide whether that is wanted, or whether partners need a per-app id.
3. Partner portal members belong to the whole organisation: a Sodax partner given portal access would see every
   other Sodax partner's apps and users. Per-app access doesn't exist.
4. Security contacts are per organisation: a web address added for one partner's app is announced to Sodax's
   contacts, not to that partner.
5. One partner's compromised site can ask the user to approve moves from the shared wallet; the user's only guard is
   reading the app's name and web address in the approval window. Who vouches for each address (parked) decides how
   much that is worth.
6. Signing out on one site doesn't sign out the others (each site has its own session). Passport Home lists the
   devices signed in to the wallet and signs each out.

## 5. Mainnet swaps on test infrastructure

**What gates the mainnet demo today** (D428, D429, D436):

- a staff switch per app (`admin <env> app:settings <app> --mainnet-demo on`, or the staff portal), refused unless the
  environment is a development environment on testnet (`local…` or `sandbox…`; sandbox-dev is one) and the app is a
  test app (the database refuses it for a live scope);
- the API serves it only in such an environment, and our vault honours it only when its own build is one;
- Base (8453) and Stellar's public network only; at most $9.99 per transaction, fee included, valued from reviewed
  prices; anything it can't value is refused; no daily limit; never auto-approved; every signature reported to staff;
- partners never see or set it.

**Many partner apps on one shared scope:** nothing in the code stops staff switching it on for every app of the scope,
one by one. With one wallet across sites that means a user's real funds, held at addresses from the test MPC network,
can be moved from any of those sites, one approved transaction at a time, with no daily limit; the balance warning
above $10 never blocks. The addresses also change at the address freeze (the production MPC network), so users would
have to move funds out themselves. Sodax partners swap on many chains; the demo covers two.

**For Sodax's portal switch to include it**, D428 would have to change: it rejected letting partners set it. The
recommendation is to keep it a staff switch per partner app, after a check with that partner, and out of the service
API; real swaps for Sodax partners wait for live keys.

## 6. Chains

Sodax 2.2.0's chains (`@sodax/types`), against what we sign for. Sonic is Sodax's hub: users sign only on the chain
they swap from. The founder's direction (D909): cover as many of Sodax's chains as we can in the long run; the ones
we lack are planned, with no dates. NEAR is left out of the Sodax swap by an earlier decision (2026-11-12).

**Covered:** every EVM chain through one secp256k1 key and our EIP-1193 provider: Sonic, Ethereum, Arbitrum, Base,
BNB Chain, Optimism, Polygon, Avalanche, HyperEVM (999), LightLink (1890), Redbelly (151), Kaia (8217), Hedera (295)
and Robinhood Chain (4663); and Stellar. Our approval window names only the first eight; for the other six it says "A network
Journear doesn't know (no. 999)" and "of this network's coin" instead of a name and a coin. Hedera runs through its EVM
relay with its own account rules: not checked.

**Planned.** Every new chain needs the same pieces: a key from the user's existing secret, an address, a signer in
our vault, a provider in our SDK and Sodax's wallet interface for it, an approval window that says in plain words what
moves (and, for Sodax, a decoder that binds the swap's delivery to the user's own wallet, as Base and Stellar have),
the rule for which of its networks count as test networks, key export and Passport Home's "Move wallet".

**Keys and the address freeze.** Our keys don't come from the MPC network one by one: the MPC gives each user one
secret, and every chain's key is derived from it in the browser. So the NEAR MPC can produce every curve below. Each
new chain is a new pair of name and curve in that derivation: no existing address moves, but the new addresses are
final at the address freeze, and building one must be called out (`CLAUDE.md`).

| Chain | Key and curve | New derivation pair | What the approval window must explain | Rough size |
|---|---|---|---|---|
| The six EVM chains above | secp256k1 (have it) | none | the chain's name and coin | small |
| Solana | Ed25519 | yes, `solana`/`ed25519` | program calls and token accounts; Sodax's calls | medium |
| Sui | Ed25519 (its default) | yes, `sui`/`ed25519` | Move calls and coins | medium |
| Bitcoin | secp256k1 (and Schnorr for Taproot addresses) | yes, `bip122`/`secp256k1` | a PSBT's inputs, outputs, change and fee | large |
| Injective | secp256k1, Ethereum-style address | yes, or reuse the EVM key (same address bytes; reusing a key across chain families is a choice to make) | Cosmos messages and contract calls | medium |
| ICON | secp256k1 | yes, `icon`/`secp256k1` | transfers and contract calls (readable JSON) | small to medium |
| Stacks | secp256k1 | yes, `stacks`/`secp256k1` | Clarity calls and their post-conditions | medium |

"Medium" is about the size of adding NEAR (D720 to D729). **Proposed order**, cheapest first and then by how much we
expect Sodax's users to use each (to confirm with Sodax, who has the numbers): the six EVM names and coins; Solana; Sui;
Bitcoin; Injective; ICON; Stacks. Real use needs live keys: Sodax has no testnet, so on testnet only the signing can
be tried, on each chain's own test network.

## 7. Who builds what

| Who | What |
|---|---|
| Journear | The service API and its staff screens (section 3); the shared-wallet line in our windows; the per-app answers in section 4; the EVM chain names; publishing the SDK; then chains in the order above |
| Sodax | Load our SDK when the switch is on; create the client with the partner's key; accept extra Stellar Wallets Kit modules and keep wallet error codes; the portal switch and its call to our API |
| Each Sodax partner | Its page meets our page requirements (popups allowed, the frame not blocked; `integration.md` section 5) |
| The founder | The decisions in "Open" below |

## 8. Risks

- One wallet for many companies' sites: the weakest site is the reach of every user's funds (section 4).
- Web addresses added by a machine: a stolen Sodax credential could add a look-alike address; the 24 hour delay and
  the announcement emails are the backstop, which is why who vouches for an address comes first.
- The mainnet demo on a shared wallet (section 5).
- Our sign-in and approval windows must open from a click: Sodax's own waits before a swap cost the click, so users
  get our "Review in Journear Passport" button instead (works, one more click).
- Sodax's wallet kit is a large, fast-moving dependency; its Stellar change is ours to ask for, not to make.

## 9. Open questions for Sodax

1. Which of Sodax's chains matter most to its partners' users (sets the chain order)?
2. Would Sodax accept the Stellar change (extra wallet modules, wallet error codes kept) upstream?
3. How does Sodax know each partner's real web addresses, and can a partner prove them (a DNS record or a file on the
   site)?
4. Does Sodax want each partner's users to see the same User ID across partners, or one per partner?
5. Can Sodax load our SDK only for partners with the switch on, from npm, once we publish?
6. Should partners see their own users in our portal (needs per-app access), or only through Sodax?

## Open (for the founder)

- Who vouches for each partner's web address (parked, D909).
- Whether the mainnet demo stays a staff switch per partner app (recommended) or joins Sodax's switch (amends D428).
- Whether to build the service API now or after the origin question.
- Publishing the SDK (registry, licence of `@hana-id/core`), needed before Sodax can depend on it.
- Whether partners on a shared scope get a per-app User ID.
