# NEAR HACKATHON: demo video script and post texts

For the colleague recording the video and the person posting it (`TODO(submit)`: the recording and the post). The
video is 2 to 3 minutes and leads with the NEAR-only stamps site, <https://hana-id-stamps-sandbox-dev.tingtc.workers.dev>
(`apps/stamps`; its app is "Stamp Trail"). HACKATHON.md's advice for the post: lead with the user problem, "Show one
complete moment" from a real user action to a visible result, explain NEAR's role concretely, link the demo and the
public repository and ask a genuine question. Every label below is the deployed site's; check them once on the day,
since a redeploy can change them.

Last verified against code: 2026-11-13 (branch `docs/hackathon-stamps`, docs only, against `develop` @ 83ac508c: the
stamps site's labels in `apps/stamps/src/ui/labels.ts`, `src/view.ts`, `src/collector.ts`, `src/app.ts` and
`src/stamps.ts`, the sign-in window's in `packages/web/src/auth/login-page.ts` and `email-page.ts`, the approval
window's NEAR headings in `packages/web/src/auth/render-approval.ts`, the admin's NEAR relay tile in
`apps/admin/src/status.ts`; the stamps site, its public passport page and the hosted demo answered 200 the same day; the
contract's views and keys read from a public RPC. The clicks were not recorded end to end by this branch: that needs a
real inbox. The founder's hand-checked run of all six stamps on testnet is the account `cceaf5d3…` in the README's
"Reproduce it" A); 2026-11-13 (branch `docs/hackathon-submission`: the first version, on the hosted demo).

## Before recording

1. Use a fresh browser profile (no earlier Journear session), at a window width of about 1280 px, with pop-ups allowed
   for `https://hana-id-stamps-sandbox-dev.tingtc.workers.dev`. Hard-reload the site once before you start
   (Cmd-Shift-R or Ctrl-Shift-R), so the page is the deployed build.
2. Use a **fresh email address** you can show (one that has never signed in to Journear Passport: the account must
   start with no stamps and 0 NEAR), and have its inbox open in another window that shows no other mail (or crop it).
   Google sign-in works only for listed testers: use email.
3. Open a private window too, for the public passport (shot 10), and a terminal for the locked contract's keys (shot
   12): `near account list-keys hana-id-stamps-dev1.testnet network-config testnet now` prints an empty table. The
   account is `near.demoStamps` in `envs/sandbox-dev.json`.
4. Close everything else that could show a key, a token or a personal address. The account id on screen is a
   disposable testnet account; the email address is the only personal thing shown.
5. If a stamp says the relay is busy or its budget is used up, or the contract is out of storage balance, see
   `docs/hackathon-public-checklist.md` step 9 (the balances and daily budgets).

**The order uses the Layover wait.** Layover can be collected only 2 minutes (120 s of block time; the page adds 3 s)
after Arrival. So collect Arrival first, then Fare paid, Signature, Postcard and the faucet step while its countdown
runs, and Layover last. In real time those four take about two minutes; if they take less, keep recording and cut the
wait in the edit.

## Shot list (about 2 min 45 s)

| # | Time | On screen | Do exactly | Say (one line each) |
|---|---|---|---|---|
| 1 | 0:00 to 0:08 | The stamps site's passport cover | Nothing yet; show "Journear Passport" and the six empty stamps | "Most people won't install a wallet or write down a seed phrase. Journear Passport gives them a NEAR account when they sign in with their email." |
| 2 | 0:08 to 0:30 | The Journear Passport window | Click **Sign in**. In the window ("Sign in"), click **Continue with email**, type the address in **Email address**, click **Send code**. Switch to the inbox, show the mail with the 6-digit code, switch back, type it, click **Continue** | "The code proves the email. A NEAR contract checks that proof on chain, then asks NEAR's MPC network for this user's key, encrypted so only this browser can open it." |
| 3 | 0:30 to 0:38 | "Your passport" | Point at **Account** (64 hex characters, shortened), **Network** "NEAR testnet" and **Balance** "0 NEAR" | "A NEAR account, no seed phrase, and no NEAR in it." |
| 4 | 0:38 to 0:55 | Arrival, then the window | Click **Collect** on Arrival. In the window headed "NEAR transaction, fee paid by a relayer", point at **From** (the user's account), **To** (`hana-id-stamps-dev1.testnet`) and the `collect` call; move the mouse, click **Approve**. Back on the page: "Arrival stamped on NEAR testnet. Your NEAR account was created for it. You paid no gas.", the stamp inked with **No gas**, and Layover's countdown starting | "The user signs a meta transaction; Journear's relay sends it and pays the fee. The Layover stamp's two-minute clock starts now." |
| 5 | 0:55 to 1:08 | NearBlocks, testnet | Click **View transaction ↗** on the Arrival stamp. Point at the signer, `hana-id-near-relay-dev1.testnet` (it paid the fee), the `Delegate` action, and the `collect` receipt whose predecessor is the user's account. Switch back to the site | "On chain: the relay signed and paid, and the call to the stamps contract came from the user's own account." |
| 6 | 1:08 to 1:15 | Fare paid | **Collect**, **Approve**. "Fare paid stamped on NEAR testnet. You paid no gas." | "This stamp only exists if someone else paid: the contract checks that the signer isn't the caller." |
| 7 | 1:15 to 1:35 | Signature, then the window | Click **Collect** on Signature ("Two approvals: sign a message, then send it. …"). The window, headed "Sign in with your NEAR account", shows `Stamp my passport: <account>` for `hana-id-stamps-dev1.testnet`: **Approve**. **Leave the window open**: within a few seconds it shows the `collect` call ("Approval 2 of 2: send it to the contract…" on the slot): **Approve**. "Signature stamped on NEAR testnet. You paid no gas." | "Two approvals in one window: sign a message, then send it. The contract verifies the signature on chain, against the account's own key." |
| 8 | 1:35 to 1:45 | Postcard | Type a short note in **Your note**, click **Send postcard**, **Approve**. The note shows on the stamp | "A public note, kept by the contract." |
| 9 | 1:45 to 2:10 | Own fare, then NEAR's faucet | Point at "The one stamp that needs your own testnet NEAR". Click **Copy account id**, then **Get testnet NEAR ↗**; on NEAR's docs faucet page paste the id and request the NEAR; switch back to the site tab. The Balance updates within about 5 s. **Collect**; the window is headed "NEAR transaction" (no relayer): **Approve**. "Own fare stamped on NEAR testnet. Your NEAR paid the fee.", and no **No gas** mark | "Real testnet tokens from NEAR's faucet. This one the user signs and pays for, with their own NEAR." |
| 10 | 2:10 to 2:18 | Layover | Once the countdown is over: **Collect**, **Approve**. "6 of 6" | "Two minutes of block time after Arrival: the contract reads NEAR's own clock." |
| 11 | 2:18 to 2:30 | The private window | Copy the **Public passport** link, open it in the private window: "Passport", "Read from NEAR testnet. Anyone can see it.", the six stamps and the note; scroll to **Recent stamps** | "Anyone can open this passport without signing in. It is read live from the chain, with everyone's recent stamps." |
| 12 | 2:30 to 2:40 | The admin's System status, then the terminal | Ten seconds: the **NEAR relay** tile (**Balance**, **Today's spend**); then the terminal's empty key table for the stamps contract | "The relay's balance and today's spend. And the stamps contract has no keys left: nobody can change its rules or its passports." |
| 13 | 2:40 to 2:48 | The site, the full passport | Nothing | "Built at NEAR HACKATHON. Testnet only. The repo has the commands to check every step, and says what was built when." |

Shot 12's admin part is for one of the two staff only (the admin console is behind Cloudflare Access for two named
addresses); show the tile alone, nothing else on the page. Skip it if neither records; the terminal half is enough.
Shot 5 can be cut first if the video runs long, then shot 8.

If the window was closed between Signature's two approvals, the slot says "Step 2 of 2: send your signed message to
the contract." with **Continue**: click it and approve. It works, but re-record shot 7 if you can: the one-window take
is the point.

The broader hosted demo (<https://hana-id-demo-sandbox-dev.tingtc.workers.dev>: the Stellar and EVM wallets, the
guestbook, the key export from Passport Home) is not in the video; the README's "Reproduce it" B walks through it.

## X post (the team posts it)

The rules' procedure: the post "says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon
(optionally also @NearLegion and @NearBuilders), and has the demo video or screenshots attached". Attach the video to
the post itself (the first post of a thread). The home page asks for both the repository link and the demo post link
in the form.

Option A (one post; 278 characters as X counts them, each link counted as 23, once the repository link is in):

> No seed phrase, no NEAR: sign in with email and collect six passport stamps on NEAR testnet, each a transaction the contract checks. Would your users start this way?
> Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
> Demo: https://hana-id-stamps-sandbox-dev.tingtc.workers.dev
> Repo: TODO(submit)

Option B (a thread of two; 271 and 264 characters, counted the same way; the video goes on the first):

> Sign in with email, get a NEAR account holding zero NEAR, and collect six passport stamps on NEAR testnet. Five go through a relay that pays the fee; one you pay yourself. Built at NEAR HACKATHON @NEARProtocol #NEARHackathon
> Would you let your app's users start this way?

> A NEAR contract checks the email or Google sign-in on chain; NEAR's MPC derives the key, encrypted to the browser. The stamps contract checks every rule itself, a NEP-413 signature included. Testnet only.
> Demo: https://hana-id-stamps-sandbox-dev.tingtc.workers.dev
> Repo: TODO(submit)

Each line of a quote is one line of the post. Count the final text in X's composer before posting.

## The form's description (20 to 2,000 characters)

1,751 characters (under the form's 2,000). The team checks it and fills in the fields the rules leave to them (project name, team lead,
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
> The demo: a NEAR-only passport site where a new user collects six stamps, each a NEAR testnet transaction whose rule
> a locked contract checks itself: five relayed with no NEAR, one paid with the user's own testnet NEAR, one carrying a
> NEP-413 signature verified on chain, one only after two minutes of block time.
>
> Testnet only. The Stellar and EVM wallets are disclosed as other chains; the NEAR integration is what we submit for
> judging.
