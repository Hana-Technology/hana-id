# NEAR HACKATHON: demo video script and post texts

For the colleague recording the video and the person posting it (`TODO(submit)`: the recording and the post). The
video is 2 to 3 minutes, on the hosted testnet demo, in one take or a few. HACKATHON.md's advice for the post: lead
with the user problem, "Show one complete moment" from a real user action to a visible result, explain NEAR's role
concretely, link the demo and the public repository and ask a genuine question. Every label below is the deployed
page's; check them once on the day, since a redeploy can change them.

Last verified against code: 2026-11-13 (branch `docs/hackathon-submission`, against `develop` @ 35bc103e and the
deployed sandbox-dev pages at `develop` 1ac3bc36: the demo's labels in `apps/demo/index.html` and
`apps/demo/src/near-card.ts` (the deployed page's text is identical to the source's), the email step's in
`packages/web/src/auth/email-page.ts`, the approval window's NEAR headings in `packages/web/src/auth/render-approval.ts`,
Passport Home's in `packages/web/src/auth/home-page.ts` and `home-export.ts`, the export steps in `key-reveal.ts`, the
admin's NEAR relay tile in `apps/admin/README.md`; the demo and Passport Home answered 200 the same day. The clicks were
not recorded end to end by this branch: that needs a real inbox. The first real run of shots 2 to 5 is the founder's
of 2026-11-12, `docs/operations.md` "NEAR relay").

## Before recording

1. Use a fresh browser profile (no earlier Journear session), at a window width of about 1280 px, with pop-ups allowed
   for `https://hana-id-demo-sandbox-dev.tingtc.workers.dev` and `https://hana-id-auth-sandbox-dev.tingtc.workers.dev`.
2. Use an email address you can show, and have its inbox open in another window that shows no other mail (or crop
   it). Shot 7 needs two more codes to the same address. Google sign-in works only for listed testers: use email.
3. Close everything else that could show a key, a token or a personal address. Shot 7 shows a real private key: it is
   a disposable testnet key, but blur it in the edit anyway.
4. If the guestbook write answers that Journear's relayer is busy or its budget is used up, see
   `docs/hackathon-public-checklist.md` step 9 (the relay's balance and daily budgets).

## Shot list (about 2 min 45 s)

| # | Time | On screen | Do exactly | Say (one line each) |
|---|---|---|---|---|
| 1 | 0:00 to 0:12 | The demo page, "Journear Passport demo" | Nothing yet; show the testnet banner | "Most people won't install a wallet or write down a seed phrase. Journear Passport gives them one when they sign in with their email or Google." |
| 2 | 0:12 to 0:40 | The Journear window, "Sign in with email" | Click **Log in with email**. Type the address in **Email address**, click **Send code**. Switch to the inbox, copy the 6-digit code, switch back, type it, click **Continue** | "The code proves the email. A NEAR contract checks that proof on chain, then asks NEAR's MPC network for this user's key, encrypted so only this browser can open it." |
| 3 | 0:40 to 0:52 | "Your addresses" and the **NEAR** card | Point at the NEAR account (64 hex characters) and its line "Not on NEAR testnet yet: your first guestbook write creates it …", then at the Stellar and EVM rows | "One sign-in, one key from NEAR's MPC, and from it a NEAR account. It holds no NEAR." |
| 4 | 0:52 to 1:35 | **Write to the guestbook**, then the Journear window | Type a short message in **Your message**, click **Write to the guestbook (no NEAR needed)**. In the window headed "NEAR transaction, fee paid by a relayer", point at **From** (the user's account), **To** (`hana-id-guestbook-dev1.testnet`) and **Calls** `add_message` with the message; wait a second, move the mouse, click **Approve**. Back on the page: "Written to the guestbook on NEAR testnet. Your NEAR account was created for it. You paid no gas.", and the message under **Latest messages**, marked "you" | "The user signs a meta transaction; Journear's relayer pays the gas, and only for calls to this contract. The window shows exactly what is signed, decoded from the bytes." |
| 5 | 1:35 to 1:55 | NearBlocks, testnet | Click **View the transaction ↗**. Show the signer `hana-id-near-relay-dev1.testnet`, the `Delegate` action and the `add_message` receipt run by the user's account; then the user's account page (**View on NearBlocks ↗** in the card): balance 0 | "On NEAR testnet: the relayer paid, the user's own account made the call, and its balance is still zero." |
| 6 | 1:55 to 2:08 | The NEAR card's **Sign**, then the window | Click **Sign a message (NEP-413)**; in the window headed "Sign in with your NEAR account", **Approve**. Show "NEAR message (NEP-413): signed" | "The same account signs in to NEAR apps with NEP-413." (Cut this shot first if the video runs long.) |
| 7 | 2:08 to 2:35 | Passport Home, `https://hana-id-auth-sandbox-dev.tingtc.workers.dev/home` | Click **Continue with email**, sign in with the same address and a new code. Under **Your apps**, **View** on "Smoke B (shared only)". Under **Move this wallet to another wallet app**, click **Show how to move it**, then **Continue with a code** and type the next code (step bar: Verify, Understand, Export). On "Your wallet is open", click **NEAR key**; show "Before you move a NEAR account"; type `EXPORT`, **Continue**, tick the box, **Show key** (blur it in the edit), then **Lock now** | "The user can always take the key and leave, from Journear's own page, without the app. For NEAR, the key is the account." |
| 8 | 2:35 to 2:45 | The demo page tab | Switch back to the demo | "Built at NEAR HACKATHON. Testnet only. The repo has the commands to check every step." |

Optional, for one of the two staff only (the admin is behind Cloudflare Access for two named addresses): the admin
console's **System status** page, its **NEAR relay** tile reading On, with Balance, Today's spend and Keys ("2 of 2").
It shows the relay's health; it is not needed for the story, and the tile's account names are public anyway.

## X post (the team posts it; it must say it was built at NEAR HACKATHON and tag @NEARProtocol and #NEARHackathon)

Option A (one post; 275 characters as X counts them, each link counted as 23, once the repository link is in):

> Most people won't install a wallet. Journear Passport makes one at email sign-in: a NEAR contract checks it, NEAR's MPC derives the key, encrypted to the browser.
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
> Demo: https://hana-id-demo-sandbox-dev.tingtc.workers.dev
> Repo: TODO(submit)

Option B (a thread of two; 263 and 259 characters):

> Sign in with email, get a NEAR account, send your first NEAR transaction with zero NEAR. Built at NEAR HACKATHON with NEAR's MPC key derivation and meta transactions. @NEARProtocol #NEARHackathon
> Would you let your app's users start this way? Demo and repo below.

> A NEAR contract checks the Google or email sign-in on chain; NEAR's MPC derives the key, encrypted to the browser. A relayer pays for NEP-366 meta transactions to allowlisted contracts. Testnet only.
> Demo: https://hana-id-demo-sandbox-dev.tingtc.workers.dev
> Repo: TODO(submit)

Each line of a quote is one line of the post. Count the final text in X's composer before posting. @NearLegion and @NearBuilders are optional extra tags.

## The form's description (20 to 2,000 characters)

About 1,500 characters. The team checks it and fills in the fields the rules leave to them (project name, team lead,
email, team size, tracks, the mainnet payout account, the repository and post links, consent), `TODO(submit)`. None of
those go in this repository.

> Problem: most people will not install a wallet extension or keep a seed phrase, so apps that want to give users an
> on-chain account either hold the keys themselves or lose the user at sign-up.
>
> Product: Journear Passport is an embedded wallet that partner apps add with an SDK. A user signs in with an email
> code or Google; Journear's window (on Journear's own origin, not the app's) shows each request decoded and asks for
> Approve before it is signed. Keys never reach the app's page or Journear's servers.
>
> NEAR's role: the NEAR contract hana-signer verifies the sign-in token on chain (Google's RS256 signature, or
> Journear's email issuer's), maps it to the partner app's scope and the user's path, and calls NEAR's MPC network for
> that path through Confidential Key Derivation. The MPC's answer is encrypted to a one-time key that only the user's
> browser holds; the browser decrypts it, checks it against the MPC's public key, and derives the user's NEAR, Stellar
> and EVM keys from it. The NEAR account is the key's implicit account. Its transactions can go through NEP-366 meta
> transactions and Journear's relayer, which pays only for calls to allowlisted contracts, so a new user's first NEAR
> transaction needs no NEAR. The contract is governed by a Sputnik DAO council with public delays and a watchdog.
>
> Testnet only. The Stellar and EVM wallets are disclosed as other chains; the NEAR integration is what we submit for
> judging.
