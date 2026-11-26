# Journear Passport inside Sodax's SDK: what works today and the plan

Sodax is a cross-chain swap SDK: `@sodax/sdk`, its wallet kit `@sodax/wallet-sdk-react` and `@sodax/dapp-kit`. The
aim (D909): our SDK inside Sodax's SDK, switched on from Sodax's partner portal, so that a Sodax partner turns on
sign-in with Google or email with a switch. This page says what works today, what is missing, who would build what,
the risks and the questions to settle with Sodax. Decisions: D909, D913 and D923 in `decisions.md`. The build spec
for the portal connection (the platform API) and per-app User IDs: `partner-platform-spec.md`.

Last verified: 2026-11-26 (branch `docs/platform-guide`, after PRs 158 and 159 merged: "Open" and section 12, the Tech Lead's settled module id and approved P11 and P12, D923, D926); 2026-11-26 (branch `docs/platform-guide`, from `feat/owner-confirmation`, not merged, docs only: the summary's portal-switch row and a pointer at the top of section 3 to `platform-guide.md`, D932; no other text changed); 2026-11-26 (branch `docs/confirmations-1126`, docs only: the fork's Actions switched off and its commit email, the worked example's branch pushed to the sample repository, D928; no other text changed); 2026-11-25 (branch `feat/app-user-linking`, from `next`, not merged, not deployed: section 4's item 2, the linking built, D925); 2026-11-25 (branch `docs/sodax-decisions`, from `next`, not merged, docs only: the Tech Lead's
answers to D923 (D926): the fork holding the Stellar change (section 2, "The Stellar change, on our fork"), the
widget decided as one app per partner (section 12), switching off decided, the worked example's home (section 2), "Open";
nothing else re-checked); 2026-11-25 (branch `chore/tidy-1125`, from `next`, not merged, not deployed: "Chains", the window's details
in weibars on Hedera, D922); 2026-11-25 (branch `feat/sodax-followups`, from `next`, not merged, not deployed: Sodax's public
source read at `7c1ff2e` (main) and the tags `@sdks@2.3.0` and `@sdks@2.4.0-rc.1`, and a local test against the
published 2.3.0 packages, stock and with the Stellar change applied to their build output (D923): the summary, sections
1, 2, 6 ("Sodax's other chains"), 7, 8, 9 and "Open", and the new sections 10 (Sodax's public source), 11 (the naming
clash), 12 (inside Sodax's widget iframe)); 2026-11-25 (branch `feat/app-user-ids`, from `next`, not merged, not deployed: section 4's item 2, the per-app User IDs built, D919); 2026-11-25 (branch `feat/shared-scope-rules`, after PR 145's review: section 4's mark at the first
app, test scopes only, D915); 2026-11-25 (branch `feat/shared-scope-rules`, from `next`, not merged, not deployed: section 4's
auto-approve item, now refused in code once staff mark the scope as shared, D915);
2026-11-25 (branch `docs/platform-answers`, from `next`, not merged, docs only: section 3's point 4
and "Open" carry the Tech Lead's answers of 2026-11-25 (D914), revised after PR 142's review; nothing else
re-checked);
2026-11-24 (branch `feat/shared-wallet-line`, after PR 141's review: section 4's count and "may" line,
D912); 2026-11-24 (branch `feat/shared-wallet-line`, from `next`, not merged, not deployed: the sign-in and
approval windows now say when the wallet is also used on other apps, D912: the summary's row, section 4, section 7);
2026-11-24 (branch `feat/name-sodax-evm-chains`, from `next`, not merged, not deployed: the approval
window names all 14 of Sodax's EVM chains, D910; "Chains", the summary's last row and "Who builds what" updated);
2026-11-24 (branch `docs/partner-platform-spec`, from `next`, not merged, docs only: the Tech Lead's
answers of 2026-11-24 (D913) in the status line, sections 3, 4, 5 and "Open", and links to `partner-platform-spec.md`;
nothing else re-checked); 2026-11-24 (branch `docs/sodax-sdk-integration`, from `next`, not merged, not deployed: written from
the code and a local test against Sodax's public packages at 2.2.0, their latest release; `2.3.0-rc.4` lists the same
chains); after PR 136's review: claims about Sodax's packages marked tested, read in source or inferred; the
address-freeze wording; facts on the origin exception, demo prices and partner labels).

**Status in one line:** the Tech Lead decided that every Sodax partner site shares one wallet (one app per partner, all
in Sodax's organisation on one scope). Test and live apps never share a scope (D51), so that is one test scope now and
a separate live scope, with different addresses, later. Nothing for the portal switch is built. Who vouches for each
partner's web address: built on the recommendation (Sodax vouches; every address is announced as usual and
comes into force when one of Sodax's owners confirms it, or after 24 h, D914), to be adjusted after the Tech Lead has
talked to Sodax (D913); the spec is `partner-platform-spec.md`.

## Summary

| | Today |
|---|---|
| Our wallet in Sodax's EVM wallet list | **Works with no Sodax-specific code**: create the client and "Journear Passport" appears (EIP-6963) |
| Our wallet in Sodax's Stellar wallet list | **Needs a change in Sodax's kit**: its Stellar Wallets Kit can't take an extra module. The change is written and tested locally, **not sent** (section 2, D923) |
| Signing through Sodax's own wallet providers | **Works** on EVM and (with the change above) on Stellar; a test app is refused on mainnets, as designed; with the change, Sodax keeps our Stellar error code |
| Inside Sodax's swap widget (an iframe on the partner's page) | **Works only if every page around the widget is a registered web address of the app**; decided: one app per partner listing the widget's address and the partner's pages (D926); the approval window names the widget's address, not the partner's page (section 12) |
| Sodax's built-in Hana Wallet entries | Sodax's "Hana" calls also catch our Stellar module (`hana-id`); hosts can now pick another id (`journear-passport`, D923; section 11) |
| One wallet across partner sites | **Works** (one scope); the sign-in and approval windows say the wallet is also used on other apps (D912) |
| A switch in Sodax's portal | **Built, not deployed or switched on**: the platform API (`partner-platform-spec.md`), with the guide for Sodax's backend team, `platform-guide.md` (section 3) |
| Our SDK on npm | **No** (tarballs, D706) |
| Real swaps for Sodax partners | Only through the staff-only mainnet demo (Base and Stellar, $9.99 a transaction); real launch needs live keys |
| Sodax's chains | EVM chains (all 14 named in our windows, D910) and Stellar covered; Solana, Sui, Bitcoin, Injective, ICON and Stacks planned (below); NEAR: not planned for the swap |

## 1. What we checked, and how

**2026-11-25 (D923).** The same kind of page against the published **2.3.0** packages (`@sodax/wallet-sdk-react`,
`wallet-sdk-core`, `sdk`, `types`; installed with `--ignore-scripts`), once as published and once with the Stellar
change of section 2 applied to their build output, and our SDK from the branch's sources, on the local stack (port base
4810) with the pretend Google, in Chromium; and a stand-in for Sodax's swap widget (section 12) in Chromium, Firefox
and WebKit. Only icon requests of Sodax's built-in Stellar wallets tried to leave the computer, and they were
blocked. Sodax's own install, build, tests and scripts were not run. Results (all tested):

| Check (2.3.0) | As published | With the change |
|---|---|---|
| Our module in `config.STELLAR.modules` | Not listed (the field doesn't exist; the list stays Albedo, xBull, HOT Wallet) | Listed as "Journear Passport" with the Journear mark |
| Our module added 2 s after mount | Not listed (pushed into the kit's private list, as in the 2.2.0 test) | Listed (`addStellarWalletModules`) |
| Connect through Sodax's `useXConnect` | (only with the private-list push) | The same address as our own client, for a module given in the config and one added late |
| Reload with that connection saved | — | Restored once the module is added again (late), the same address |
| Sign a Stellar public-network payment through Sodax's provider, test key | "Failed to sign transaction", `SIGN_TX_ERROR`, nothing else | The same message and code, plus `cause: { code: 4100, message: "Test apps (pk_test_ keys) can sign only for test networks: …" }` |
| `removeStellarWalletModules` | — | Our wallet leaves the Stellar list; the Stellar connection is cleared |

The 2.2.0 test of 2026-11-24 follows.

A one-off page in a scratch folder (not in this repository): React 19, `@sodax/wallet-sdk-react` 2.2.0 (with its
`SodaxWalletProvider`, `useXConnectors`, `useXConnect`, `useWalletProvider`), `@sodax/sdk` 2.2.0 and our SDK from
this branch's sources. It ran against the local stack (`apps/e2e`, port base 4930) with the pretend Google, driven by
Playwright in Chromium. Every request to a host outside the computer was answered locally or blocked: none was made,
nothing was broadcast, no real account or funds were used. Base's RPC was a local stand-in that keeps a broadcast
instead of sending it (none arrived). Below, "tested" means seen on that page; "read" means read in Sodax's 2.2.0
published code; "inferred" means neither.

| Check | Result |
|---|---|
| Sodax's kit alone | EVM list empty; Stellar list Albedo, xBull, HOT Wallet (the ones that need no extension) |
| `createHana({ evm, stellar })` and nothing else | EVM list gains "Journear Passport" with its icon; Stellar list unchanged |
| The same, created 2 s after Sodax's kit mounted (as a switch read from a server would) | EVM: still appears. Our client announces itself when created and on every EIP-6963 request; wagmi keeps listening for announcements |
| A Stellar connector passed in Sodax's `config.STELLAR.connectors` | Replaced by Sodax's own discovery: never shown |
| Our Stellar module pushed into Sodax's kit's private module list before discovery | Appears as "Journear Passport"; connect works and gives the same address as our client |
| The same push 2 s later | Never appears (tested). Read: Sodax looks for Stellar wallets at 0, 100 and 500 ms after mounting, then stops |
| Connect EVM through Sodax's own connect | Our sign-in window opens; after the pretend Google, Sodax has the address and its own `EvmWalletProvider` |
| Send on Base (8453) through Sodax's `EvmWalletProvider`, test key | Refused before any window: `4100`, "Test apps can sign only for test networks" |
| Sign a Stellar public-network payment through Sodax's `StellarWalletProvider`, test key | Refused, but Sodax reports only "Failed to sign transaction" and drops our code (tested in the two cases tried: this refusal and a Reject, next row) |
| A test app with the mainnet demo on, Base and Stellar through Sodax's providers | The approval shows the red "Real money, test system" banner, the value and the $9.99 limit; Reject reaches Sodax as `4001` (EVM) or "Failed to sign transaction" (Stellar) |
| Two apps on one scope, two web addresses, the same Google account | The same EVM and Stellar addresses on both |

Not checked: Firefox and Safari (Safari blocks a window opened after Sodax's own waits, so the sign-in goes through our
"Sign in with Journear Passport" button in the page, as `apps/e2e/tests/interfaces.spec.ts` shows for wagmi); a real
Google account; Sodax's swap itself on a real network; `@sodax/dapp-kit`'s hooks (read: `@sodax/dapp-kit` 2.2.0
depends on `@sodax/sdk` and `viem` only, not on the wallet kit, so it takes wallet providers from the page).

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
| Stellar | Take extra Stellar Wallets Kit modules and look for wallets again when one is added later; add `new HanaIdModule(hana, { productId: JOURNEAR_PASSPORT_MODULE_ID })` (section 11). Read in source (2.3.0 and `7c1ff2e`): `packages/wallet-sdk-react/src/xchains/stellar/StellarXService.ts` builds its kit once, in a singleton, with `allowAllModules()` and no module option (lines 52-58); `src/chainRegistry.ts`'s STELLAR `discoverConnectors` (lines 287-336 at `7c1ff2e`) runs once per mount at 0, 100 and 500 ms and replaces the connector list, so a `STELLAR.connectors` entry never shows. The change (written, tested on the 2.3.0 build output, not sent): `config.STELLAR.modules`; `addStellarWalletModules` / `removeStellarWalletModules` from `@sodax/wallet-sdk-react/xchains/stellar`, which change the kit's module list and run discovery again; discovery runs ordered so an older one never overwrites a newer list | Yes, small (tested) |
| Stellar errors | Keep the wallet's own error. Read in source: `packages/wallet-sdk-core/src/wallet-providers/stellar/StellarWalletProvider.ts` replaces a non-`Error` rejection (Stellar Wallets Kit modules reject with `{code, message, ext}`) by "Failed to sign transaction" (lines 164-169) or "Failed to get wallet address" (lines 129-134). The change: the same message and code, and the wallet's error as `cause` | Yes, small (tested) |
| Others | Not offered until we cover the chain (section 6) | Later |

**Size.** `createHana`, the Stellar module and the Sodax adapters together are about 114 kB minified, 36 kB gzipped
(measured with esbuild from this branch). Our test page with Sodax's wallet kit was 11.3 MB minified, so ours is about
1 percent of it; loaded on demand it costs nothing when the switch is off. Measured 2026-11-25 on the worked example
(below; esbuild, minified, code splitting on): with the switch off the widget's page code carries 1.3 kB of the add-on
and none of our SDK; with it on, our SDK comes as 3 chunks of 106 kB minified, 35 kB gzipped, against 8.45 MB (2.25 MB
gzipped) of the stand-in widget's own page code.

**The Stellar change, on our fork** (2026-11-25, D926). The Tech Lead chose a public fork over sending it now ("public
fork is fine. use Hana-Technology org."): `https://github.com/Hana-Technology/sodax-sdks`, a fork of
`gosodax/sodax-sdks`, branch `feat/stellar-wallet-modules` = Sodax's `main` @ `7c1ff2e1` plus the two commits of the
review folder's `stellar-modules.patch` (`ef43cca2` fix(wallet-sdk-core), `10b651f8` feat(wallet-sdk-react); the same
tree as the patch, checked), authored under the Tech Lead's git identity. A local clone is in
`~/Documents/sodax-sdks-fork`, with `origin` the fork and `upstream` Sodax's, pushing to `upstream` disabled. Nothing
was opened on Sodax's repository: a spec issue and a pull request wait for the Tech Lead ("we can make a PR later if
needed"); Sodax's own tests have not been run on the branch. GitHub Actions are switched off on the fork (the Tech
Lead's "switch them off", D928; none had run); the two commits carry the Tech Lead's personal commit email, which
they said is fine. The patch file in the review folder is now mirrored
there; the branch is the copy to keep current.

**Keeping the branch current** (in the clone; pushing to the fork is a Journear person's step, not an agent's):
`git fetch upstream`, then `git rebase upstream/main` on `feat/stellar-wallet-modules` (two small commits; a conflict
is most likely in `src/types/config.ts` or `src/chainRegistry.ts`, where Sodax adds chains), then
`git push --force-with-lease origin feat/stellar-wallet-modules`. Before a pull request, their checks on the branch:
`pnpm i`, `pnpm checkTs`, `pnpm lint`, the two packages' `pnpm test`, `pnpm check:circular-deps`, `pnpm check:knip`
(their `CONTRIBUTING.md`), and their process: a spec issue first (the review folder's `spec-issue-draft.md`), a
maintainer's plan and `plan-approved`, then the pull request (`pr-description-draft.md`). The fork's `main` can follow
theirs with `gh repo sync Hana-Technology/sodax-sdks --branch main`.

**A worked example** (2026-11-25, D923; now in the sample-partner repository, decided D926: `examples/sodax-wallet-kit/`
on that repository's branch `sodax-bundle-example`, pushed to `Hana-Technology/hana-id-sodax-sample` (private) on
2026-11-26 with the Tech Lead's "yes" (D928), with the seven earlier commits of `feat/sdk-0-5-0` it builds on, not merged
into its `main`; the first version stays in the review folder's
`sodax-bundle/example/`): an add-on shaped like Sodax's optional Privy email login (a sub-path,
`@sodax/wallet-sdk-react/journear`, the only entry that imports our SDK, an optional peer): a `<JournearPassport
setting={…} />` component inside `SodaxWalletProvider` that, when the partner's setting `{ socialLogin, publishableKey }`
arrives (after the provider mounted, as Sodax's widget fetches its partner config) and is on, imports our SDK, creates
the client with the partner's key, adds our Stellar module (the change above) and lets EIP-6963 list us on EVM; when the
setting turns off it removes the module, takes our connector out of wagmi (EIP-6963 has no removal event; done through
wagmi's internal connector store in the example, by Sodax's own EVM provider in the real thing), disconnects and calls
`hana.destroy()`. Tested in Chromium, Firefox and WebKit: the wallet appears in both lists after the config arrives,
connects, signs, and leaves both lists with its hidden frame gone when switched off. Decided (the Tech Lead,
2026-11-25, D926): switching a partner off doesn't sign its users out (as closing the tab); suspending the partner's
app on our side ends its sign-ins (`partner-platform-spec.md` A10). In the sample-partner repository the example has
its own `package.json` (Sodax's kit needs React 19; the sample is React 18), takes our SDK from the sample's vendored
tarballs (repacked from `next` @ `287ec88e` for the `productId` option), applies the Stellar change to the published
2.3.0 packages with `patch-package`, and uses the `journear-passport` id; measured there with Vite: our SDK 96 kB
minified, 31 kB gzipped, loaded only when on. Tested: bundling Sodax's kit with esbuild
for the browser needed stand-ins for Node's `crypto` and `stream`; inferred: a partner already using Sodax's kit has
its bundler set up for that.

**npm.** Not published: `@hana-id/core`, `@hana-id/web` and `@hana-id/sodax` answer "not found" on the public npm
registry (checked 2026-11-24). Partners get tarballs (D706). An SDK that depends on us needs a registry: the choice of
public npm (or a private registry), the licence of `@hana-id/core` (BUSL today, D747), provenance, a publish token in
a protected environment, and removing `"private": true` (`operations.md`, "Publishing: what is left to enable it").

## 3. The portal switch: what our side lacks

**Since 2026-11-25 (not deployed, not switched on for any organisation):** the platform API below is built
(`partner-platform-spec.md`, its status line), and `platform-guide.md` is the guide for Sodax's backend team (keys,
signing, every endpoint, the wait and the owner's confirmation, limits, the toggle recipe). The rest of this section
is the first design note, kept as it was written; where they differ, the guide and `api.md` are current.

**Today** no other company's backend can create an app, set its web addresses, read its key or switch it off:

- Apps are created only by Journear staff (`AdminRpc.createApp` from the admin portal, or `admin <env> app:create`).
- A partner changes its apps in our partner portal as a person: a Google sign-in, and for adding a web address a fresh
  Google sign-in by an on-chain owner of the scope (the console's step-up), checked by the API.
- Adding a web address waits after it is announced by email to the security contacts and to Journear: at least 24
  hours on a production network, 60 s on sandbox-dev. The "nobody has signed in yet" exception ends as soon as any
  origin of the scope has been in force (or a user has a session in it), and for a staff-created app it applies only
  when that create made the scope. So on a shared scope every later partner's addresses wait the full delay.

**The smallest safe design** (not built; the full build spec, with its threat model, endpoints and build plan, is
`partner-platform-spec.md`, D913; to be adjusted after the Tech Lead has talked to Sodax):

1. **Who calls.** Sodax's backend gets a service credential bound to Sodax's organisation and scope: a signing key
   whose public half Journear staff register, each request signed with a time and a single-use number (no shared
   secret to leak from a log). Two credentials at most, so one can be rotated.
2. **What it may do.** Create a test app in Sodax's scope (name, first web addresses); propose web address additions;
   remove web addresses; read the app and its publishable key; suspend and resume (the partner's own bit); revoke
   and create keys. Nothing on chain, no owners, no auto-approve policy, no raw signing, never the mainnet demo.
3. **Limits.** A few apps per day per credential, at most 20 web addresses per app (as today), live apps only once
   live keys exist and only with Journear staff's approval.
4. **The delays stay, unless an owner confirms.** Every web address it adds is a proposal like a staff one:
   announced to Sodax's security contacts and to Journear, cancellable from the email. It is in force at once when one
   of Sodax's owners confirms it in our partner portal (signed in, on a page that shows the app and the address), and
   otherwise 24 hours later, in every env except local test envs (the Tech Lead, 2026-11-25, D914;
   `partner-platform-spec.md` A15). Removing and suspending are immediate.
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

**What users see today (D912).** The sign-in window says "Signing in to {App} at {web address}" and the approval
window "From {App}" with the web address; when other apps share the wallet, each adds right under that "This wallet is
also used on 2 other apps." with "See which": the other apps' names (at most 5, then "and N more apps") and "Any of
them can ask you to approve payments from this wallet, so check who is asking each time." Counted: the scope's other
apps that aren't suspended or deleted, have had a sign-in and have a web address in force. When Journear can't tell
(no answer yet, none kept), the windows say "This wallet may also be used on other apps.". The names come from Journear's own data, on the
vault's read of the app only; the partner page never gets them. A Google-only app's sign-in window goes straight to
Google, and any partner can send its sign-in straight to Google (`method: 'google'`), so there the line shows only for
a moment; the approval window is the screen relied on. Passport Home
still lists the apps that use a wallet. The line must be live before the partner platform is switched on for any organisation
(`partner-platform-spec.md` N6, D913).

**What must stay off for apps on a shared scope** (each is per app today, but every one reaches the same funds):

- auto-approve policies: the consent screen now names the other apps (D912), but a consent given while the scope
  had N apps isn't asked again when another joins, so a policy can outlast what the user was told (auto-approved Sodax
  swaps stay deferred, D708). Refused in code (D915) once Journear staff mark the scope as shared (one way; test scopes
  only for now) and for every app the platform creates: until the scope is marked it is still a rule kept by hand, so
  mark Sodax's test scope when its first app is created (`admin app:create … --shared-wallet`, `docs/operations.md`);
- raw signing (already refused for test apps);
- the mainnet demo, except under staff's per-app rule (section 5);
- gas sponsorship for EVM actions (not live), until each partner's sponsored calls are reviewed.

**Gaps before real money:**

1. ~~A line in the sign-in and approval windows when the wallet is shared.~~ Built (D912): "This wallet is also used
   on 2 other apps." with the names behind "See which"; its words, placement, counting rule and cap are to confirm.
2. The identity token's User ID is the same for a user across every app of a scope, so every Sodax partner's backend
   can match the same person across sites. Decided (D913): each app on a shared scope gets its own User ID, with
   linking for Sodax and Journear staff (`partner-platform-spec.md` Part B). The wallet addresses stay the same on
   every site, so partners who compare addresses can still match users. **The per-app User IDs are built (D919, piece
   P6, not deployed):** an app created after staff mark the scope gets its own User ID and Support ID; Sodax's own
   apps made before the mark keep theirs. **The linking is built too (D925, piece P7, not deployed):** Sodax's owners
   see one person across its partners' apps in our partner portal (a person's "This person on your apps", and a
   search by any app's User ID or Support ID; owners only, each look-up recorded and limited, never from Sodax's
   backend), and Journear staff find a person by either kind of code. Sodax may not give one partner another
   partner's ID for the same person; the portal says so beside the IDs. Mark the scope for real partners only once
   P6 and P7 are deployed.
3. Partner portal members belong to the whole organisation: a Sodax partner given portal access would see every
   other Sodax partner's apps and users. Per-app access doesn't exist.
4. Security contacts are per organisation: a web address added for one partner's app is announced to Sodax's
   contacts, not to that partner.
5. One partner's compromised site can ask the user to approve moves from the shared wallet; the user's only guard is
   reading the app's name and web address in the approval window, now with the line that the wallet is also used on
   other apps (D912). Who vouches for each address (parked) decides how
   much that is worth.
6. Signing out on one site doesn't sign out the others (each site has its own session). Passport Home lists the
   devices signed in to the wallet and signs each out.
7. Partner labels (your own words for requests in the approval window) belong to the scope: on a shared scope they
   are set by the scope's on-chain owners, Sodax's, not by each partner, and each version attaches to at most 8 apps.

## 5. Mainnet swaps on test infrastructure

**What gates the mainnet demo today** (D428, D429, D436):

- a staff switch per app (`admin <env> app:settings <app> --mainnet-demo on`, or the staff portal), refused unless the
  environment is a development environment on testnet (`local…` or `sandbox…`; sandbox-dev is one) and the app is a
  test app (the database refuses it for a live scope);
- the API serves it only in such an environment, and our vault honours it only when its own build is one;
- Base (8453) and Stellar's public network only; at most $9.99 per transaction, fee included, valued from live
  prices kept within a band that ends at the reviewed table (D436); anything it can't value is refused; no daily limit; never auto-approved; every signature reported to staff;
- partners never see or set it.

**Many partner apps on one shared scope:** nothing in the code stops staff switching it on for every app of the scope,
one by one. With one wallet across sites that means a user's real funds, held at addresses from the test MPC network,
can be moved from any of those sites, one approved transaction at a time, with no daily limit; the balance warning
above $10 never blocks. The addresses also change at the address freeze (the production MPC network), so users would
have to move funds out themselves. Sodax partners swap on many chains; the demo covers two.

**For Sodax's portal switch to include it**, D428 would have to change: it rejected letting partners set it. Decided
(D913): it stays a staff switch per partner app, for a short pilot list, and out of Sodax's switch and the service
API; real swaps for Sodax partners wait for live keys.

## 6. Chains

Sodax 2.2.0's chains (`@sodax/types`), against what we sign for. Sonic is Sodax's hub: users sign only on the chain
they swap from. The Tech Lead's direction (D909): cover as many of Sodax's chains as we can in the long run; the ones
we lack are planned, with no dates. NEAR is not planned for the Sodax swap (the Tech Lead, 2026-11-12).

**Covered:** every EVM chain through one secp256k1 key and our EIP-1193 provider: Sonic, Ethereum, Arbitrum, Base,
BNB Chain, Optimism, Polygon, Avalanche, HyperEVM (999), LightLink (1890), Redbelly (151), Kaia (8217), Hedera (295)
and Robinhood Chain (4663); and Stellar. Our approval window names all fourteen with their own coin, as real-money
networks (D910): "HyperEVM (real money)" and HYPE, "LightLink" and ETH, "Redbelly Network" and RBNT, "Kaia" and KAIA,
"Hedera" and HBAR, "Robinhood Chain" and ETH, each checked against the chain's own docs and the public chain
registries. Naming a chain is display only: test apps still refuse all of them, the mainnet demo stays Base and
Stellar, and an unknown token or call on a named chain is still unknown. A transaction counts HBAR in 18 decimals
(Hedera's relay takes weibars), which is how the window shows it, its folded details and the auto-approve consent
screen writing the raw number as weibars (D922); Sodax's own token list gives HBAR 8 (tinybars, as programs see it). Hedera's own account and fee rules through its relay: not checked.

**Planned.** Every new chain needs the same pieces: a key from the user's existing secret, an address, a signer in
our vault, a provider in our SDK and Sodax's wallet interface for it, an approval window that says in plain words what
moves (and, for Sodax, a decoder that binds the swap's delivery to the user's own wallet, as Base and Stellar have),
the rule for which of its networks count as test networks, key export and Passport Home's "Move wallet".

**Keys and the address freeze.** Our keys don't come from the MPC network one by one: the NEAR MPC gives each user
one secret, and HKDF derives every chain's key from it in the browser. That one secret is enough to derive a key on
every curve below. Each new chain adds a new (name, curve) pair: no existing address moves, but that pair's name,
curve and key rule are final from the day it ships (from the address freeze if it ships before it). Bitcoin's Taproot
rule and whether Injective reuses the EVM key are part of what becomes final. Call it out when built (`CLAUDE.md`).

| Chain | Key and curve | New derivation pair | What the approval window must explain | Rough size |
|---|---|---|---|---|
| The six EVM chains above | secp256k1 (have it) | none | done: named with their coin (D910) | done |
| Solana | Ed25519 | yes, `solana`/`ed25519` | program calls and token accounts; Sodax's calls | medium |
| Sui | Ed25519 (its default) | yes, `sui`/`ed25519` | Move calls and coins | medium |
| Bitcoin | secp256k1 (and Schnorr for Taproot addresses) | yes, `bip122`/`secp256k1` | a PSBT's inputs, outputs, change and fee | large |
| Injective | secp256k1, Ethereum-style address | yes, or reuse the EVM key (same address bytes; reusing a key across chain families is a choice to make) | Cosmos messages and contract calls | medium |
| ICON | secp256k1 | yes, `icon`/`secp256k1` | transfers and contract calls (readable JSON) | small to medium |
| Stacks | secp256k1 | yes, `stacks`/`secp256k1` | Clarity calls and their post-conditions | medium |

"Medium" is about the size of adding NEAR (D720 to D729). **Proposed order**, cheapest first and then by how much we
expect Sodax's users to use each (to confirm with Sodax, who has the numbers): the six EVM names and coins (done,
D910); Solana; Sui;
Bitcoin; Injective; ICON; Stacks. Real use needs live keys: Sodax has no testnet, so on testnet only the signing can
be tried, on each chain's own test network.

**Sodax's other chains: how its kit finds wallets** (read in source, `packages/wallet-sdk-react/src/chainRegistry.ts`
at the tags; what a wallet of ours on that chain would have to plug into):

| Family | How Sodax's kit finds wallets | So our wallet would |
|---|---|---|
| EVM | wagmi with EIP-6963 on; late announcements are picked up (`EvmHydrator.tsx` lines 30-48) | work today (tested) |
| Stellar | Stellar Wallets Kit 1.x, `allowAllModules()`, discovery at mount | need the change of section 2 (prepared) |
| Solana | `@solana/wallet-adapter-react` (provider-managed): Wallet Standard wallets (inferred: the adapter lists Wallet Standard wallets it detects) | register as a Wallet Standard wallet |
| Sui | `@mysten/dapp-kit-react` (provider-managed): Wallet Standard | register as a Wallet Standard wallet |
| Bitcoin | a fixed list: Unisat, Xverse, OKX, Hana Wallet | need a connector in Sodax's list or a config override |
| Injective | a fixed list: MetaMask, Keplr, Leap | the same |
| ICON | Hana Wallet only | the same |
| Stacks | a list of providers plus a Leather probe | the same |
| NEAR | `@hot-labs/near-connect` (its wallet manifest) | not planned for the swap (the Tech Lead, 2026-11-12) |
| Tron, XRP, TON, Zcash, Cardano | in `@sdks@2.4.0-rc.1` and `main`, not in 2.3.0: TIP-6963 or `window.tron`; GemWallet; TonConnect; Noir Wallet; Lace | not covered or planned yet (new since this page's chain list; to add to the plan) |

## 7. Who builds what

| Who | What |
|---|---|
| Journear | The service API and its staff screens (section 3); the per-app answers in section 4 (the shared-wallet line in our windows is built, D912); publishing the SDK; then chains in the order above |
| Sodax | Load our SDK when the switch is on; create the client with the partner's key; accept extra Stellar Wallets Kit modules and keep wallet error codes (the change is on our public fork, a spec issue and pull request drafted, to send only when the Tech Lead says, D926); the portal switch and its call to our API; for its swap widget, register each partner's page addresses with the partner's app (section 12) |
| Each Sodax partner | Its page meets our page requirements (popups allowed, the frame not blocked; `integration.md` section 5) |
| The Tech Lead | The decisions in "Open" below |

## 8. Risks

- One wallet for many companies' sites: the weakest site is the reach of every user's funds (section 4).
- Web addresses added by a machine: a stolen Sodax credential could add a look-alike address; the 24 hour delay and
  the announcement emails are the backstop, which is why who vouches for an address comes first.
- The mainnet demo on a shared wallet (section 5).
- Our sign-in and approval windows must open from a click: Sodax's own waits before a swap cost the click, so users
  get our "Review in Journear Passport" button instead (works, one more click).
- Sodax's wallet kit is a large, fast-moving dependency; its Stellar change is ours to ask for, not to make. Releases
  move fast (2.3.0 and 2.4.0-rc.1 on the same day, 2026-11-24; `main` 50 commits past 2.3.0 at `7c1ff2e`).
- Inside Sodax's swap widget, our approval window shows the widget's address, the same on every partner's site; the
  app's name is the only partner-specific part (section 12).

## 9. Open questions for Sodax

1. Which of Sodax's chains matter most to its partners' users (sets the chain order)?
2. Would Sodax accept the Stellar change (extra wallet modules, wallet error codes kept) upstream?
3. How does Sodax know each partner's real web addresses, and can a partner prove them (a DNS record or a file on the
   site)?
4. Does Sodax want each partner's backend to get the same User ID for a person, or one per partner?
5. Can Sodax load our SDK only for partners with the switch on, from npm, once we publish?
6. Should partners see their own users in our portal (needs per-app access), or only through Sodax?
7. Would Sodax take the change in their usual way (a spec issue, a maintainer's plan and `plan-approved`, then a pull
   request from a fork), or prefer to write it themselves from the spec?
8. Is the add-on shape right for them (a `./journear` sub-path like `./privy`, our SDK an optional peer), and would
   they rather own it in their repository or have us maintain it?
9. In the swap widget, can the partner's settings carry the switch and the publishable key, and can Sodax's backend
   register each partner's page addresses with that partner's app (section 12)? Would they want the widget refused
   when it is opened top-level for a partner (section 12, the gap)?
10. Should their "Hana" brand calls (`useBatchConnect(['hana'])`, `useIsWalletInstalled`) match whole ids only, so
    they never catch another wallet whose id merely contains "hana" (section 11)?
11. Which of the chains new in 2.4.0-rc.1 (Tron, XRP, TON, Zcash, Cardano; Monad on EVM) matter to their partners?

## Open (for the Tech Lead)

Answered by the Tech Lead on 2026-11-24 (D913): the mainnet demo stays a staff switch per partner app; each app on a
shared scope gets its own User ID, with linking for Sodax and staff; the service API is built now on the origin
recommendation, to be adjusted after the talk with Sodax. Still open:

- Publishing the SDK (registry, licence of `@hana-id/core`), needed before Sodax can depend on it: parked (D913).
- The spec's own questions N1 to N9: answered by the Tech Lead on 2026-11-25 (D914; `partner-platform-spec.md`,
  "Decided by the Tech Lead (2026-11-25)"), with who may confirm (an owner, with a fresh Google sign-in) and a rule
  for platform keys (a second owner confirms on real money) decided the same day; several design points proposed and
  still to confirm, and two open points (D914).
- D923's points answered by the Tech Lead (2026-11-25, D926): the Stellar change goes on a public fork in the
  Hana-Technology org, a pull request "later if needed" (section 2); one app per partner, including for the widget
  (section 12); the example lives in the sample-partner repository; switching off doesn't sign users out.
- Settled by the Tech Lead (2026-11-26, D923): `hana-id` stays the default Stellar module id, with `journear-passport`
  offered through the `productId` option for hosts (section 11). Still to confirm: no EVM change, the production
  domain decides it (section 11).
- Approved by the Tech Lead (2026-11-26, D926), to build: pieces P11 (the partner's page in our windows) and P12 (the
  widget's origin only as a frame) in `partner-platform-spec.md`'s build plan.

## 10. Sodax's public source

Read in source (`gosodax/sodax-sdks`, a shallow clone at `7c1ff2e` on `main`, with the tags `@sdks@2.2.0`,
`@sdks@2.3.0` and `@sdks@2.4.0-rc.1`), unless marked otherwise:

- **All SDK code is public, under the MIT licence**: `@sodax/sdk`, `@sodax/wallet-sdk-core`,
  `@sodax/wallet-sdk-react`, `@sodax/dapp-kit` and the rest, with the example and test apps (`apps/playground` is the
  swap widget) and the docs site's sources. Sodax's partner portal (`portal.sodax.com`) and backend (`api.sodax.com`)
  are not in it (inferred: private).
- **How outside changes get in** (`CONTRIBUTING.md`, `.github/issue-workflow.md`): every change starts from an issue
  whose body is the spec (their template: goal, requirements, non-goals, constraints, acceptance criteria); a
  maintainer writes or accepts a plan comment and applies the `plan-approved` label; outside contributors open a pull
  request from a fork against `main`, with `Closes #N`, a Conventional Commit title, tests beside the code and the
  package README or docs updated (a "docs ship with code" check). Only Sodax publishes (releases are cut by
  maintainers from a `release` branch).
- **Versions** (tested on the npm registry, 2026-11-25): `latest` is 2.3.0 (published 2026-11-24), `rc` is
  2.4.0-rc.1 (the same day). 2.4.0-rc.1 adds Tron, XRP, TON, Zcash and Cardano to the wallet kit (section 6).
- **The optional Privy email login** (2.3.0): an "Email (Privy)" EVM wallet, configured as `EVM.privy: privy({ appId })`
  from the sub-path `@sodax/wallet-sdk-react/privy`, the only entry that loads `@privy-io/react-auth`, an optional peer
  dependency; partners who don't use it install nothing. Our worked example follows that shape (section 2). (The pull
  request number, #486, is from the survey, not re-checked: the clone is shallow.)
- **The swap widget** is one iframe from `https://widget.sodax.com/?embed=1&appId=…`, with
  `allow="ethereum; solana; clipboard-write"`, `referrerpolicy="origin"` and no `sandbox` (`docs/widget/index.mdx`),
  so popups from it are allowed. Its per-partner settings come from `GET {api}/swaps/widget/config/{appId}` →
  `{ appId, feeBps, feeReceiver }` (`apps/playground/src/lib/appId.ts` lines 45-50), fetched in `useSwapFlow` after
  the wallet provider's config was fixed at module level (`apps/playground/src/providers.tsx` lines 14-30).
- **Featuring a wallet first** needs the page to call `sortConnectors(connectors, { preferred: [id] })` (exact ids);
  the widget's wallet list (`apps/playground/src/components/WalletControls.tsx` line 45) doesn't, so wallets show in
  the order they were found.

## 11. The naming clash with Hana Wallet

Hana Wallet (the browser extension, a different product) is built into Sodax's kit: EVM `io.hana.wallet` (through
EIP-6963), ICON `hana`, Bitcoin `hana-bitcoin`, Stacks `hanaWallet.stacks`, and Stellar Wallets Kit's own `hana`
module, all named "Hana Wallet".

**What our wallet announces** (read in our code): EIP-6963 `info.name` "Journear Passport", `info.icon` the Journear
mark (a data URI), `info.uuid` random per client, `info.rdns` the reverse of the env's sign-in host
(`packages/web/src/client/ethereum.ts` `rdnsFor`: on sandbox-dev `dev.workers.tingtc.hana-id-auth-sandbox-dev`, so it
contains "hana"; locally `1.0.0.127`); the Stellar Wallets Kit module's `productId` `hana-id`, `productName`
"Journear Passport", `productUrl` the sign-in origin, `productIcon` the mark; nothing on NEAR (no wallet-selector
entry; `hana.near` only); SDK exports `createHana`, `HanaIdModule`, `HANA_ID_MODULE_ID`.

**Sodax's matcher** (`packages/wallet-sdk-react/src/utils/matchConnectorIdentifier.ts` lines 35-45) treats an
identifier as a brand and matches any wallet whose id or name contains it, without case. It is used by
`useBatchConnect`, `useBatchDisconnect` and `useIsWalletInstalled`; Sodax's own `apps/wallet-modal-example` shows a
"Connect All Hana" button when `useIsWalletInstalled({ connectors: ['hana'] })` is true. Tested on 2.3.0 (no Hana
Wallet extension present):

| Call | Our module `hana-id` | Our module `journear-passport` |
|---|---|---|
| `useIsWalletInstalled({ connectors: ['hana'] })` | true (Stellar; and EVM where `rdns` contains "hana", as on sandbox-dev: tested with a stand-in announcement) | false |
| `useBatchConnect({ connectors: ['hana'] }).run()` | connects **our** wallet on Stellar (our sign-in window opens) and tries our EVM entry on sandbox-dev | matches nothing, no window |
| `useBatchDisconnect({ connectors: ['hana'] })` | would disconnect ours (read in source) | not matched |

Not affected: `sortConnectors`' `preferred` (exact ids); icons and names (each connector has its own; ours is never
shown as Hana Wallet's, read in source). When both wallets are present, `find` takes the first match, so the order
of the list decides (read in source; the extension's modules come first on Stellar, ours is appended).

**What persists an id** (read in source): Sodax's store saves each chain's connector id in `localStorage`
(`xwagmi-store`) and restores it after a reload; a missing id makes the Stellar reconnect fail with a console warning
and leaves the saved connection showing, so signing fails until the user connects again; wagmi saves the EVM
connector id (`wagmi.recentConnectorId`, the `rdns`); Stellar Wallets Kit 2.x saves `@StellarWalletsKit/selectedModuleId`
and `usedWalletsIds` (1.9.x keeps the selection in memory only); our own partner test page names `selectedWalletId:
'hana-id'`, and `docs/integration.md` has promised partners since the rename that `productId` and `rdns` stay. Our
vault stores neither (its records are keyed by app and scope).

**Done (D923, to confirm (the Tech Lead)).** Renaming the default would make returning users pick the wallet again
in every host that saved it (and leave Sodax's saved connection unusable until they do) and break partner code that
names `hana-id`, so the default stays. Instead `new HanaIdModule(hana, { productId })` takes another id, and the SDK
exports `JOURNEAR_PASSPORT_MODULE_ID` (`journear-passport`) for hosts that match by part of a name; the worked example
uses it. Nothing is stored or derived from it; no address changes. The EVM `rdns` has no such option: it should stay
truthful (a domain we control), and on production it comes from the production domain, still to be chosen (Q15, Q26):
choosing one without "hana" in the sign-in host avoids the clash there (inferred). The other way round (Hana Wallet
mistaken for ours) doesn't happen: nothing of ours matches "Hana Wallet" or `io.hana.wallet` (read in source), and the
option refuses `hana` and `io.hana.wallet` as ids.

## 12. Inside Sodax's swap widget: our wallet in a third-party iframe

Sodax's widget runs as an iframe from its own origin on each partner's page. Tested 2026-11-25 with a stand-in widget
(the worked example) on the local stack: partner pages on `http://site-b.localhost:4873` and
`http://site-c.localhost:4875`, the widget on `http://localhost:4874`, our vault and sign-in on `127.0.0.1` (three
different sites), in Chromium (with third-party storage partitioning switched back on: Playwright switches it off,
shipped Chrome has it on), Firefox (with its shipped Total Cookie Protection) and WebKit (with `window.open` returning
null in the widget, as Safari's popup blocker does after a library's waits). The same results in all three unless
noted (tested):

| Question | Result |
|---|---|
| Which origin do our vault and API see? | The **widget's** (the vault's parent). The vault also requires **every** page around it to be a registered origin of the app (sweep VAUL-6: `location.ancestorOrigins` where the browser has it, and the CSP `frame-ancestors` everywhere) |
| An app that registers only the widget's origin | **Refused** on a partner's page ("didn't answer this page … and that every page framing it is too"); our wallet leaves the lists |
| An app that registers the widget's and the partner pages' origins | Works: lists, sign-in, signing, reload |
| The hidden frame | Loads inside the widget's iframe once the origins are registered |
| Popups | The sign-in and approval windows open from a click in the widget (Chromium, Firefox); with popups blocked (WebKit as Safari), through our in-page "Sign in with Journear Passport" and review buttons |
| Google sign-in | Works (a top-level window) |
| Storage | Belongs to the partner's site: a reload keeps the session; the same widget top-level, or on another partner's site, needs its own sign-in (the Google account chosen again), and gets **the same wallet** (one scope). Chromium and Firefox partition by the top-level site (a probe page showed it); Playwright's WebKit doesn't partition `localStorage`, but our vault's records still weren't shared there; shipped Safari partitions too (inferred) |
| The approval window's requesting site | "From {App}" and the **widget's** address (`http://localhost:4874`), not the partner's page |
| "Also used on other apps" | With one app for all partners: no line (one app); the window looks the same on every partner's site. With one app per partner on one scope: "From Partner A Swaps", the widget's address, and "This wallet is also used on 1 other app." |
| A partner page reusing another partner's widget settings | Refused (partner B's page is not registered for partner A's app) |
| Switching the partner off in the widget | Our wallet leaves both lists, the connection ends, the hidden frame is removed |

Not tested: the widget opened top-level with a partner's settings in the per-partner setup; read and inferred: it
works, because the widget's origin is registered for every partner's app, so anyone can open
`widget/?appId=<partner>` top-level and get that partner's app (the address bar then shows the widget's address).

**Options for the Tech Lead** (none built):

- **A. One app for the widget's origin, the partner shown from a signed config.** Sodax's backend signs "this is
  partner X" for the widget, our window shows it. One app means one User ID set, one suspend for all, the 20-origin
  cap if partner pages must be registered anyway (they must, as tested), and our window then trusts Sodax's signature
  for the name it shows: a stolen Sodax signing key names any partner. Not recommended.
- **B. The widget posts the parent's origin.** Forgeable by the widget's code and unverifiable in Firefox (no
  `ancestorOrigins`); with VAUL-6 our vault already knows the real ancestors where the browser tells it, so this adds
  nothing we can trust. Not recommended.
- **C. Refuse to run framed.** Safest for the window's address, but Sodax's widget is an iframe by design: Sodax would
  have to open a top-level page or window for sign-in and every approval. Breaks the integration.
- **D. One app per partner, each registering the widget's origin and the partner's own pages** (works today, tested;
  D909's model). The vault's check of every ancestor (and `frame-ancestors`) binds each partner's key to its own pages;
  each partner gets its own name, User IDs (D913), suspend and "also used" line; the widget's embed already allows
  popups. What it needs: Sodax's backend registers each partner's page origins with the partner's app, as the platform
  API plans (A13), plus the widget's origin; and two small changes of ours, to propose: show the partner page's
  address in the windows (the outermost ancestor where the browser gives it, else the app's one non-widget origin)
  instead of the widget's, and refuse the widget's origin top-level for a partner app (allow it only as a frame), so a
  partner's app can't be used outside the partner's pages.

**Decided: D** (the Tech Lead, 2026-11-25: "ok", D926): one app per partner, also for Sodax's widget; each partner's
app lists the widget's address and the partner's own pages (`partner-platform-spec.md` A10, A13). The two changes are
**approved** (the Tech Lead, 2026-11-26, D926), to build as pieces P11 and P12 of that spec's build plan; P12's reason (anyone can open the
widget top-level with a partner's settings and get that partner's app) was read in our code and inferred, not
tested.
