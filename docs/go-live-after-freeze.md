# Go-live checklist: the first sandbox-dev deploy after the freeze

Last verified against code: 2026-11-25 (branch `fix/deploy-readiness`, after PR 151's review: 1.4's migrations check, 1.7's id from `wrangler hyperdrive list`, 0.10's export offline and row count, 2.0's retention on any day, 2.7's new verdicts, the restore to 2.6's bookmark and re-run steps 2 to 5 only, 0030 additive, D924); 2026-11-25 (branch `fix/deploy-readiness`, from `next` @ `ca37652b` with `4776f6af` merged in, not merged, nothing run against any service: 0.10 the rehearsal; 1.1 and 1.1a done on `next`; phase 2 rewritten for ledger 0009 to 0011, D1 0022 to 0027 and 0030 with the snapshot, bookmark and comparison, console 0004, the retention wait; where P2's and P6's migrations go; `gen`'s refusal in 1.7; the rollback rows, the admin's `*/30`; "If Neon's allowance is used up", D924); 2026-11-24 (branch `feat/dev-wording-reduced-motion`, from `next`, not merged, not deployed: "sponsored action" for "gas-free action" in phase 4's row, the glossary, its heading and 4.15, D905); 2026-11-24 (branch `feat/home-cancel-waiting-sign-in`, from `next`, not merged, not deployed: ledger migration 0011 listed in 1.1, not applied anywhere, D902); 2026-11-24 (branch `feat/labels-line-names-provider-rule`, from `next`, not merged, not deployed: question 7 settled, D903); 2026-11-23 (branch `feat/partner-labels-contracts`, from `next`, not merged, not deployed: question 7, a second NEAR testnet provider, D900); 2026-11-23 (branch `feat/partner-labels-storage`, from `next`, not merged, not deployed: 2.1's list may also show `0025_partner_labels.sql` and the console's `0004_label_step_ups.sql`, both additive and unused while `partnerLabels.enabled` stays absent, D894); 2026-11-23 (branch `feat/evm-relayer-auto-resume`, from `next`, not merged, not deployed: 4.16's out-of-money pause that restarts by itself after a refill, the tile's Check again, migration 0024, the alerts table's `evm_relay_auto_resumed`, D890); 2026-11-23 (branch `feat/demo-plain-wording-2`, from `next`, not merged, not deployed: 1.1a, the NEAR relay's limits back with this deploy, D793's note; 1.6a run once on 2026-11-23; phase 4 named gas sponsorship); 2026-11-19 (branch `feat/near-reviewed-calls`, from `next`, not merged, not deployed: 1.6a, the reviewed NEAR contracts checked on chain before the pages deploy, and 3.12's stamps approval reads as reviewed, D885); 2026-11-19 (branch `feat/free-fee-in-details`, from `next`, not merged, not deployed: 3.12's stamps check and 5.5's quoted heading after D884); 2026-11-19 (branch `feat/admin-gas-sponsorship-wording`, from `next`, not merged, not deployed: 4.16, the alerts table and question 5 name the staff tile, page and alerts "Gas sponsorship", D879; after its review: the relayer wallet's and the NEAR relay's billing alert titles in the alerts table and phase 3's step 6; its "gas-free" wording, the partner-side term, unchanged); 2026-11-19 (branch `feat/unbroken-address-copy`, not merged: the hand-test step's fee row words, D877); 2026-11-19 (branch `feat/remove-added-sign-in-any-age`, not merged: phase 3's note on deploying the vault and the sign-in pages together, D875); 2026-11-19 (branch `fix/neon-compute-wakeups`, after review: the deploy waits for Neon's reset (expected 2026-12-01), your decision of 2026-11-19; 2.0's pre-flight; "If Neon's allowance is used up" rewritten (only 2.4–2.6 and 3.11a need Neon; options (a) chosen and (b) the fallback, its frozen-files warning); 0.9 and 5.3: the NEAR relay's limits a separate API deploy on 2026-11-26, to plan; D872); 2026-11-19 (branch `fix/neon-compute-wakeups`, from `next`, not merged, not deployed: 1.11 and 3.11a Neon's compute before and after, 2.4's "can't connect", phase 3 row 7 resets the hand-edited triggers, "If Neon's allowance is used up", D872); 2026-11-18 (branch `test/evm-sponsor-anvil-lane`: 4.6's `cast` commands, written in the runbook and rehearsed on anvil; what the anvil lane already rehearsed and what still needs Base Sepolia, D868); 2026-11-18 (branch `feat/admin-evm-sponsor`, from `next`, not merged, not deployed: 4.16, the relayer's state on the admin portal's Free network fees tile and page, and their deploy order, D843); 2026-11-18 (branch `fix/deploy-check-sponsor-rpc`: 4.12 and 4.14 with the read endpoint
enforced, D851 as amended); 2026-11-18 (branch `docs/go-live-checklist`, with `next` @ 9a4db48f merged in (PRs 71, 77,
85 and 86 merged), docs only, nothing run against any service, testnet or account; every command, flag, path,
migration, secret and alert name checked against the scripts and the runbook on that commit).

One ordered list for the first deploy of `next` to sandbox-dev after the hackathon freeze. It is written so you can
follow it literally, one step at a time. For the reasons behind a step, follow its link into
[`operations.md`](operations.md) (the runbook) or [`decisions.md`](decisions.md).

**Testnet only.** sandbox-dev is a testnet environment on personal Cloudflare, Neon and Google accounts that must stay
on their free plans. Nothing here touches a mainnet, ever. If a screen asks for a card, a paid plan or an upgrade:
stop and ask.

**Not before Neon's allowance resets (expected 1 Dec 2026), and only on your go-ahead.** Your decision of 2026-11-19
(D872): the first deploy of `next` happens on or after the day Neon's monthly allowance resets (expected 2026-12-01;
confirm the date in Neon's console), not in the last days of November, and the ledger migrations are not applied
ahead of time. Both public demos (the stamps site and the hosted demo) must keep working exactly as they are until the
end of 2026-11-25 in any case. The NEAR relay's limits go back with this deploy, not as a separate step (your decision of
2026-11-23, D793): 1.1a put the values back on `next` (D924), phase 3 deploys them. Phase 0 changes nothing of sandbox-dev's data (0.10's export takes its database offline for a few seconds) and can be done any
time. Phases 1 to 5 wait for you to say "go ahead deploy".

## Overview

| Phase | What | When | Time | Who |
|---|---|---|---|---|
| 0 | Get ready: a deployer key, test ETH, the deploy plan, a free read endpoint, GitHub settings | any time before the day | 1–2 h of your time, spread over a few days (faucets give a little a day) | **You** |
| 1 | The NEAR relay's limits back on `next` (1.1a), merge `next` into `develop`, update the deploy checkout, run every check, write down what runs now, take a restore point | the day: on or after Neon's reset (expected 2026-12-01) | about 1 h | the assistant merges and checks; **you** say go and take the restore point |
| 2 | Database changes: three ledger migrations, six API D1 migrations (one of them the audit ledger's rebuild, with a snapshot and a comparison), one console D1 migration | the same day, right after phase 1 | 30 min | **You** |
| 3 | Deploy the new code, sponsorship still off; check both demos | the same day, right after phase 2 | about 1 h | the assistant deploys on "go ahead deploy"; **you** check the sites |
| 4 | Switch EVM gas sponsorship on: contracts, the relayer key, secrets, deploy | a later day: **recommended only once the admin portal's sponsorship page and a way to try a sponsored action on a real site exist** (neither does yet) | half a day, with a review in the middle | **you**: keys, passwords, funding, secrets, the hand test; the assistant: the PR, the deploy, the checks |
| 5 | Afterwards: CI on, the email budget, the docs, a week of watching | the week after the deploy | 30–60 min, then a look each day | **you**: CI and the email budget; the assistant: the PRs and the deploy |

The rule for who does what: anything with a password, a private key, a faucet, a third-party dashboard, a remote
database migration, a secret upload or a contract deploy is **yours** (the assistant never handles those). Merges, local checks, Worker
deploys and `deploy-check` are the assistant's once you say "go ahead deploy"; you can also run them yourself, the
commands are the same.

**Stop and ask** whenever a step shows something other than "You see", prints a line starting `FAIL`, `MISMATCH` or
`❌`, mentions a placeholder, asks for money, or a demo stops working. Copy the terminal output for the assistant.
Nothing in this list needs to be rushed.

### Words used here

- **Worker**: one of sandbox-dev's small programs on Cloudflare (the API, the vault and sign-in pages, the email
  issuer, the partner console and its sign-in, the files server, the admin portal, the watchdog, the two demo sites).
- **Deploy**: send new code to a Worker. Each `run deploy` stamps the Worker with the commit it came from.
- **`deploy-check`**: a read-only script that says whether every Worker runs the same commit as your checkout, and
  (with `--d1`) whether every database change of that commit is applied.
- **D1**: Cloudflare's database for the API. **Migration**: a numbered file that changes a database's tables.
- **Usage ledger**: the billing database on Neon (Postgres). Its migrations are applied by `usage-migrate`.
- **Time Travel bookmark**: a D1 restore point. Restoring to it undoes every write after it, so it is a last resort.
- **Manifest**: `envs/sandbox-dev.json`, the environment's settings. It only changes through a reviewed PR.
- **Keystore**: an encrypted key file Foundry's `cast` keeps; it asks for its password every time it signs.
- **Faucet**: a website that gives free test ETH on Base Sepolia (Base's test network, chain 84532).
- **Read endpoint (RPC provider)**: a service that answers questions about the chain. A free account gives you a
  private URL with a key in it.
- **Relayer**: Journear's own wallet that pays the network fee for a user's sponsored action. **Delegate contract**:
  the small on-chain program a user's wallet points at so the relayer can send its actions.
- **Durable Object**: a long-lived Cloudflare object; the EVM relayer is one. Creating it is a one-way change
  (wrangler migration `v3`).
- **CI**: GitHub's automatic checks on every pull request and push.

## Phase 0: before the day (changes nothing of sandbox-dev's data)

Each step can be done on any day. None of them deploys, migrates or uploads anything to sandbox-dev. One reads it in a way users notice: 0.10's export makes its database unavailable while it runs (sign-ins fail for those seconds).

### 0.1 Install Foundry 1.5.1

Foundry gives you `cast` and `forge`, which sign and check the contract deploy.

```sh
cast --version
```

You see: `cast Version: 1.5.1-stable` (the dev Mac has it already). If it shows another version:
`foundryup --install 1.5.1`, then check again. If `cast` isn't found at all, ask the assistant to install Foundry
1.5.1 from its release; don't pick an installer from a search result.

### 0.2 A copy of `next` to run the plan from

Your main checkout (the folder you always deploy from) stays on `develop` until phase 1. For phase 0, use a second
folder with `next` in it, so the deploy checkout is never left on the wrong branch. From your main checkout:

```sh
git fetch origin
git worktree add ../hana-id-next origin/next
cd ../hana-id-next
corepack pnpm install
```

You see: `HEAD is now at …` and then pnpm's install summary with no error. The folder `../hana-id-next` sits beside
the main checkout. Remove it after phase 1 with `git worktree remove ../hana-id-next` (from the main checkout).

### 0.3 Create the testnet-only deployer keystore (once)

This key pays for the two contract deploys on Base Sepolia and nothing else. It is a fresh key, used only on testnet.
Runbook: [EVM sponsorship relay, step 1](operations.md#evm-sponsorship-relay-not-live).

```sh
mkdir -p -m 700 ~/.foundry/keystores
cast wallet new ~/.foundry/keystores hana-evm-deployer
```

`cast` asks for a new password twice. Make it a strong one and save it in your password manager.
You see: an `Address:` line (`0x…`) and the keystore file's path. Write the address down (it is public).
To see the address again later: `cast wallet address --account hana-evm-deployer` (it asks for the password).
Never type a private key on a command line, and never use `--private-key`.

### 0.4 Get test ETH for the deployer

1. Open Base's faucet list: docs.base.org, page "Network faucets" (Coinbase's Developer Platform faucet is one).
2. Ask for Base Sepolia test ETH to the deployer address from 0.3.
3. Check it arrived:

```sh
cast balance <deployer address> --rpc-url https://sepolia.base.org --ether
```

You see: a number above `0`. 0.01 test ETH is plenty for the two deploys. Phase 4 also needs about 0.1 test ETH for
the relayer; faucets limit how much they give a day, so start collecting early (see 4.5).
If it stays `0` after an hour: try another faucet from the list. Some faucets ask for a mainnet balance or a sign-in;
skip those that want money.

### 0.5 Run the deploy plan (sends nothing)

From the `next` folder of 0.2:

```sh
corepack pnpm --filter @hana-id/scripts run deploy-evm-delegate sandbox-dev --rpc https://sepolia.base.org
```

You see, in order: `eth_chainId 84532: the right chain`; the deployment proxy `present, with its known code`; both
contracts `not deployed` at `0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA` (the delegate) and
`0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e` (the demo check-in); a two-step plan; and `Dry run: nothing sent.`
If it says `already deployed, matches the artifact`: someone deployed them already; that is fine, note it.
If it says `MISMATCH`: stop and ask. Any other error: the table "What each failure means" in
[the runbook](operations.md#what-each-failure-means) says what to do.

### 0.6 A free read endpoint for Base Sepolia

The relayer reads the chain from one place only and believes it, so it gets its own keyed URL from a provider account
of yours (the runbook names Alchemy, QuickNode and Infura as examples). Before you sign up, check:

- the **free** plan includes **Base Sepolia** (a testnet);
- sign-up needs **no payment card**; if it asks for one, stop and ask (personal accounts stay on free plans, D417);
- what happens at the free limit: requests are **refused** (fine) and not billed as "pay as you go" or "overage" (not
  fine; switch any automatic upgrade off);
- the free allowance is far above what the relayer needs: demo traffic is tens of actions a day; the runbook's worst
  case is about 170,000 read calls a day if it were busy all day, about 5 million a month.

Then:

1. Create an app (or "endpoint") for **Base Sepolia**.
2. Copy its **https** URL into your password manager. It contains a key: never paste it into a file, a chat, an
   issue or the repo. You paste it once, in phase 4.
3. Leave the browser tab; nothing else is set up now.

The runbook makes this keyed endpoint **required** for sandbox-dev (only a `local*` env goes without it), and the two
measurements of 4.6 run against it. Which provider is your choice (question 1 at the end).

### 0.7 The three GitHub settings before CI goes on

You change these; assistants don't change settings. In GitHub: the repository → **Settings** → **Actions** →
**General**, then **Save** in each section you change. Runbook: [CI and git](operations.md#ci-and-git).

1. **Artifact and log retention** (shown as "Check, workflow run, status, artifact and log retention"): **3** days.
   You see: the field shows 3 after Save.
2. **Approval for running fork pull request workflows from contributors**: choose **Require approval for all external
   contributors**. You see: that option selected after Save.
3. **Workflow permissions**: the read-only option ("just read access for the `contents` and `packages`
   permissions"). You see: it selected after Save. (The exact label isn't checked in today's screen: pick the
   read-only one.)

Optional, a fourth: **Actions permissions** → allow Hana-Technology and select non-Hana-Technology actions, allow
actions created by GitHub, list `pnpm/action-setup@*` and `Swatinem/rust-cache@*`, and tick **Require actions to be
pinned to a full-length commit SHA**.

### 0.8 Check the $0 Actions budget still exists

The organisation → **Settings** → in the sidebar **Billing & Licensing** (under "Access") → **Budgets and alerts** →
the **Actions** budget.
You see: **$0**, "Stop usage when budget limit is reached" ticked, alerts on.
If it is missing or not $0: stop and ask before CI goes on (phase 5).

### 0.9 Decide two things for 2026-11-26 (optional now)

- the NEAR relay's limits: **decided 2026-11-23** (D793): they go back with this deploy, not in a separate small
  deploy on 2026-11-26 (1.1a; the values are fixed by D793, on `next` since D924). Until then sandbox-dev keeps the
  judging-week values;
- the email budget: keep it, or lower it (5.4 has the choices); it can ride along with phase 3.

Tell the assistant your choice; it prepares the PR. Nothing changes until it is merged and deployed.

### 0.10 Rehearse the ledger rebuild on a scratch copy (you, with the assistant; required before phase 2)

Migration 0027 rebuilds the audit ledger, and its rollback is a Time Travel restore, never yet done on sandbox-dev
(D152, D916). So once `next` holds everything for this deploy (the commit you will deploy), rehearse every pending D1
migration on a scratch copy of sandbox-dev's D1, restore drill included: the runbook's
[Ledger rebuild](operations.md#ledger-rebuild-hot-db-migration-0027-d916) step 1, a to f, from a checkout at that commit
(for example 0.2's folder; run `gen` there with `--d1-id <the env's database id>` and `--usage-hyperdrive-id off`: that
config is never deployed). It needs no Neon, so it can be done before the reset.

Before you start (read-only): the row count query of [Ledger rebuild](operations.md#ledger-rebuild-hot-db-migration-0027-d916)
"What the rehearsal costs on the Free plan" (`wrangler d1 info` gives the size, not the rows) and `corepack pnpm --dir
apps/api exec wrangler d1 list` (fewer than 10 databases, the Free plan's limit). The copy and the migrations count against D1's
free 100,000 rows written a day for the whole account; past it, D1 refuses writes until 00:00 UTC and sign-ins fail.
If the database holds many thousands of rows, rehearse on another UTC day than the deploy. **Step a's export takes
sandbox-dev's database offline while it runs**: wrangler asks you to confirm and says so; every sign-in and app request
fails until it finishes (seconds for a small database). Do it at a quiet hour; the demos' judging freeze ended on
2026-11-25, so any day from the 26th. **Not
tested:** importing an export into a database whose triggers check each row (0006's, 0013's): if step a's import fails
with a trigger's message, stop, delete the scratch database and ask; nothing touched sandbox-dev.

You see: step c `Verdict: identical`, step d `Verdict: migration 0027 is not applied` (the restore worked), step e
`Verdict: identical` again. Anything else: stop and ask; don't start phase 2. If more is merged into `next` after the
rehearsal (P2, P6), rehearse again on the new commit.

## Phase 1: the day's preparation

Start only on or after the day Neon's allowance resets (expected 2026-12-01: check the date in Neon's console, 1.11),
and only after you have said "go ahead deploy".

### 1.1 `next` holds everything that goes live (the assistant)

The sponsorship routes (D1 migration 0022, ledger migration 0009), the NEAR relay's billing records (0023, 0010), the
relayer's restart after a refill (0024), partner labels' storage (0025 and the console's 0004, switched off), the
shared-scope rules (0026), the `platform` actor's ledger rebuild (0027), Passport Home's cancel (ledger 0011), the
sign-in's Keep it / Remove notice and the NEAR relay limits of 1.1a are already merged into `next` (D924). The assistant merges, each after `pnpm verify`
passes on the merged result, anything else you want in this deploy: the PR of 0.9 if you chose to fold it in, and any
later PR you name.

You see: on GitHub, no open PR into `next` that you expected to ship.

**Ledger migration `0011_home_link_cancels.sql`** (D902, Passport Home's "Cancel this link") is merged and **not
applied anywhere**: 2.1 to 2.3 apply it with 0009 and 0010, before the new API is deployed (until then the ledger
refuses the API's `home_link_cancel` events and the daily nonce check raises `nonce_unexplained` for each Home
cancel). **If P2 (D918) or P6 (D919) merges before this deploy**, phase 2's lists gain its files (2.4, 2.8).

### 1.1a The NEAR relay's limits back to normal (D793; with this deploy)

Your decision of 2026-11-23: the judging week's NEAR relay limits go back with this deploy of `next`, not as a
separate deploy. **Done on `next` (D924, branch `fix/deploy-readiness`):** the four `near.relay` values in
`envs/sandbox-dev.json`, with `apps/api/scripts/test/near-relay-sandbox.test.ts`, the partner guide's limits table and
the runbook's figures:

| Setting | Judging week | Back to |
|---|---|---|
| `appDailyBudgetNear` | 3 | 1 |
| `dailyBudgetNear` | 6 | 5 |
| `activationsPerAppPerDay` | 300 | 200 |
| `lowBalanceNear` | 9 | 2 |

Phase 3's API deploy (`gen`, then `deploy`) applies them. The relay account then needs at least 3 + 2 + 5 = 10 NEAR
(`inFlightNear` + `lowBalanceNear` + `dailyBudgetNear`); the System status tile turns amber below 2.

You see: `envs/sandbox-dev.json` on `next` with the four values on the right. At 1 NEAR a day an app covers about 120
new users; a busy day on the stamps site ends with its relays refused (`app_budget_exhausted`) until 00:00 UTC.

### 1.2 Merge `next` into `develop` (the assistant opens it, you say go)

`develop` is the deploy branch. The merge ends the freeze.

```sh
gh pr create --repo Hana-Technology/hana-id --base develop --head next --title "Go-live: next into develop"
```

The assistant runs `corepack pnpm verify` on the merged result first, then merges with a merge commit (never squash,
never `main`):

```sh
gh pr merge <PR number> --repo Hana-Technology/hana-id --admin --merge
```

You see: the PR "Merged". If GitHub prints a "Bypassed rule violations" line, that is the organisation's PR rule being
bypassed with your account: the assistant reports it to you each time.

### 1.3 Tag what goes live

A tag marks the exact commit, so anyone can find it later. Never move the `pre-hackathon` or `hackathon-submission`
tags: the hackathon's compare link depends on them.

```sh
git fetch origin
git tag -a sandbox-dev-<yyyy-mm-dd> origin/develop -m "sandbox-dev: the first deploy after the hackathon freeze"
git push origin sandbox-dev-<yyyy-mm-dd>
```

You see: `* [new tag] sandbox-dev-…`. The repo has no naming rule for deploy tags yet: the name is question 2 at the
end.

### 1.4 Update the deploy checkout

In your main checkout:

```sh
git status
```

You see: `On branch develop` and `nothing to commit, working tree clean`. If not: stop and ask (a deploy from a dirty
tree is marked `-dirty` and migrations must come from a clean checkout).

```sh
git pull --ff-only
corepack pnpm install --frozen-lockfile
git log -1 --format='%h %s'
```

You see: the merge commit of 1.2 ("Merge pull request #… from Hana-Technology/next"). Then:

```sh
git status --porcelain -- apps/api/migrations
git diff --stat <the commit you rehearsed on in 0.10> HEAD -- apps/api/migrations
```

You see: nothing from either (no uncommitted migration, and the migrations are the ones 0.10 rehearsed). `ledger-check`
records the commit and whether `apps/api/migrations` is dirty in every snapshot, and its compare refuses to judge
("can't judge", exit 2) a dirty checkout, a snapshot from another commit, or a database with a migration this checkout
doesn't have (D924): take 2.5 and run 2.7 from this checkout, at this commit.

### 1.5 Every check (`verify --full`)

```sh
corepack pnpm verify --full
```

It takes about 6–10 minutes. You see: a summary table at the end with every step passed and no failure. If one fails:
stop; the assistant reruns a suspected flaky test alone and says so. Nothing deploys on a failure.

### 1.6 Write down what runs now (the rollback point)

```sh
corepack pnpm --dir apps/api exec wrangler whoami
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --skip-head
```

You see: `whoami` names the personal Cloudflare account you always deploy with. `deploy-check` lists each Worker with
the commit it runs today (`OK: every piece of sandbox-dev runs <commit>`, or a list of pieces on different commits).
Copy that output into your notes: it is what a rollback goes back to. It changes nothing.

### 1.6a The reviewed NEAR contracts, on chain (D885), before the pages deploy

This deploy's vault and sign-in pages (phase 3, step 3) carry Journear's reviewed NEAR calls: the stamps and guestbook
approvals read in plain words, "checked by Journear". That is true only while both contracts are still locked and run
the reviewed code. Check it first (read-only, both of the manifest's NEAR endpoints):

```sh
corepack pnpm --filter @hana-id/scripts run check-reviewed-near sandbox-dev
```

You see: the time, then for each contract and each endpoint "code_hash … (block …), 0 access keys (block …), no global
contract", and last `OK: sandbox-dev's reviewed NEAR contracts are locked and run the reviewed code on both endpoints`.
Run once already, on 2026-11-23 from `next` @ 0c47747b (passed; the output is in D885 and the runbook): that doesn't
count for the deploy, so run it again here, on the day. Copy the whole output into D885 ("Last on-chain check") and
`docs/operations.md` "Reviewed NEAR calls: adding one"
(same heading), in the branch that records the deploy. Any `FAIL` line: stop, don't deploy the pages; ask. (The
same check is `deploy-check sandbox-dev --only near-reviewed`. 1.5's `verify --full` has already rebuilt both
contracts and compared their code hashes with the records, or said it skipped for want of cargo-near 0.22.0.)

### 1.7 The API config for this commit

```sh
corepack pnpm --filter @hana-id/api gen sandbox-dev
```

You see: `wrote …apps/api/wrangler.jsonc (env sandbox-dev, worker hana-id-api-sandbox-dev)` with **no** "local D1
placeholder id" in it, then `usage capture: on (USAGE_DB → Hyperdrive …)`, then two `wrote …` lines for the page
Workers. If it says placeholder or `usage capture: off`: stop and ask (the config lost the database or ledger link).
Since D924 `gen` refuses, and writes nothing, rather than drop the ledger link silently: if it says "has a usage
ledger … but no writer Hyperdrive id is known", read the id with `corepack pnpm --dir apps/api exec wrangler hyperdrive
list` (read-only): the row named `hana-id-usage-writer-sandbox-dev` (the manifest's `usage.writerHyperdrive`), **never**
`hana-id-usage-admin-sandbox-dev`; then `gen sandbox-dev --usage-hyperdrive-id <that id>`. Don't run `usage-setup … hyperdrive`
for it: it creates configs, needs the token file the runbook has you delete, and its "already exists" hint (delete the
config) would break the deployed API's `USAGE_DB`. After the deploy, `deploy-check sandbox-dev --usage-binding` checks
the binding names the writer config (D924, untried against Cloudflare).

### 1.8 Take the restore point (Time Travel bookmark)

```sh
corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-sandbox-dev
```

You see: `⚠️ The current bookmark is '…'`. Copy the bookmark into your notes with the time (UTC). On the free plan a
bookmark can be restored for 7 days. (Time Travel has never been rehearsed on sandbox-dev, D152: treat it as a last
resort.)

### 1.9 Note the balances

```sh
near account view-account-summary hana-id-near-relay-dev1.testnet network-config testnet now
near account view-account-summary hana-id-relayer-dev1.testnet network-config testnet now
near account view-account-summary hana-id-stamps-dev1.testnet network-config testnet now
```

You see: each account's balance. Write them down. The NEAR relay should hold at least 18 NEAR while the judging limits
are in place (10 once phase 3 deploys 1.1a's values). Also open the admin portal's **System status** page: the **NEAR relay**
tile should read On.

### 1.10 Hand check of both demos, before

Use a fresh email address and a private browser window.

1. The stamps site, <https://hana-id-stamps-sandbox-dev.tingtc.workers.dev>: **Sign in** → **Continue with email** →
   the code from the mail → "Your passport" with an account and "Balance 0 NEAR". Collect **Arrival**: it is stamped
   within seconds.
2. The hosted demo, <https://hana-id-demo-sandbox-dev.tingtc.workers.dev>: sign in by email; your addresses show; one
   signature opens the approval window and returns.
3. The public Sodax sample site loads and signs in (its address isn't in this repository: question 3 at the end).

Note what the approval windows say: phase 3 changes their wording, and you compare after.
If a demo doesn't work **before** you deployed anything: stop. Don't deploy on top of a broken demo.

### 1.11 Neon's compute, before (D872)

Open Neon's console: the project, then **Usage** (or **Billing**). Write down the compute-hours used this period, the
allowance (100) and the date it resets. The deploy waits for that date (your decision, D872): on it the usage is near
0. Also open the project's compute (Edit) and check its autoscaling minimum and maximum are both 0.25 CU (if it can
grow, the System status estimate is only a floor). Phase 2 starts with its own check (2.0).

## Phase 2: database changes

What `next` brings (D924, read from `next` @ `4776f6af`): the API's D1 `0022_evm_sponsor.sql` to
`0027_platform_actor.sql` and `0030_app_user_ids.sql` (seven files, P6's included; sandbox-dev's D1 is at 0021), the
console's D1 `0004_label_step_ups.sql`, and the ledger's `0009_evm_sponsored.sql`, `0010_near_relayed.sql` and
`0011_home_link_cancels.sql`. 0027 rebuilds the audit ledger, so it needs 0.10's rehearsal first and here a snapshot,
a bookmark and a comparison. When its PR merges, P2 adds the API's `0028_platform_keys.sql` (and maybe a `0029`) and
the console's `0005_platform_key_step_ups.sql`: each applies in name order in the same commands below (between 0027
and 0030, and after 0004), and the lists below gain them.

### 2.0 Pre-flight: Neon reachable, and how much allowance is left

The ledger migrations (2.1 to 2.3) and the Neon checks after the deploy (3.11a) are the only steps that need Neon;
D1's migrations, every Worker deploy and `deploy-check --d1` don't touch it. So check Neon first, and do the ledger
first: if it fails, nothing of sandbox-dev has changed yet.

1. Neon's console, the project: the compute is not suspended for its allowance, and **Usage** shows what is left of
   this period's 100 compute-hours.
2. **The monthly retention job is not running**: the admin portal's **Retention** screen shows this month's run `ok`.
   It is due from the 1st at 01:00 UTC (09:00 in Malaysia) until a run of the month completes, on any day (a `failed`
   or `partial` run keeps it due), and it needs Neon; while it runs, 2.7's comparison would count its deletions as
   lost rows ([Ledger rebuild](operations.md#ledger-rebuild-hot-db-migration-0027-d916) step 2). A
   `failed` run is retried an hour later; wait for `ok`.

What to do:

- **It connects and the period has just reset (the plan):** go on with 2.1.
- **It can't connect, or the allowance is used up:** stop; don't start phase 2. Wait for the reset (your decision:
  the deploy happens on or after it).
- **It connects, but little is left (under about 10 compute-hours):** the deploy and its checks use well under one
  hour of compute; go on, or wait for the reset if the reset is within a day or two.

You run these, from the main checkout, right after phase 1. Runbook: [Checking a deploy](operations.md#checking-a-deploy-deploy-check-d384-d406)
("Migrations: apply from the deployed commit"),
[NEAR relay billing records](operations.md#near-relay-billing-records-d863-built-not-deployed) steps 1 to 3 and
[Ledger rebuild](operations.md#ledger-rebuild-hot-db-migration-0027-d916) steps 2 to 6.

**Why this order.** Every migration but 0027 only adds tables, columns or triggers, and 0027 keeps every row, so the
API running now (the old code) keeps working while you apply them. The new API, deployed in phase 3, reads 0026's
columns in every app read and writes billing records and Home cancel events from its first request: if it ran before
the migrations, sign-ins would fail. So: the ledger, then D1, then the API. 0023, 0024, 0025 and 0027 each rebuild the
alerts table with the kinds of the ones before, so only `wrangler d1 migrations apply` runs them safely, by name, and
records each as done. **Never** run a migration file with `wrangler d1 execute --file`.

### 2.1 See what the ledger will apply

```sh
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev
```

You see: `pending on sandbox-dev: 0009_evm_sponsored.sql, 0010_near_relayed.sql, 0011_home_link_cancels.sql (run again
with --yes to apply)`. If it lists other files, says the database and the repo disagree, or that a file changed after
it was applied: stop and ask. If it can't connect, whatever the error says: stop here; nothing has changed
([If Neon's allowance is used up](#if-neons-allowance-is-used-up)).

### 2.2 Apply them

```sh
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev --yes
```

You see: three `applied …` lines, then `sandbox-dev: applied 3 migration(s)`. If 0011 gives up on its 5-second lock
wait: run the same command again (the file runs as one transaction).

### 2.3 Confirm the ledger

```sh
corepack pnpm --filter @hana-id/scripts usage-migrate sandbox-dev
```

You see: `sandbox-dev is up to date (11 applied)`.

### 2.4 See what D1 will apply

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations list hana-id-sandbox-dev --remote
```

You see: a table with exactly `0022_evm_sponsor.sql` to `0027_platform_actor.sql` and `0030_app_user_ids.sql`
(seven). If it lists anything else (other than P2's files once merged), or `✅ No migrations to apply!`: stop and ask.

Nothing reads or writes 0025's partner labels' tables while the manifest has no `partnerLabels` block: **keep
`partnerLabels.enabled` out of `envs/sandbox-dev.json`** (turning it on is its own go-live decision, after the re-parse
of every stored version, [Before switching partner labels on](operations.md#partner-labels-in-the-admin-portal-d894)).

### 2.5 The snapshot (right before 2.6)

```sh
corepack pnpm --filter @hana-id/scripts run ledger-check sandbox-dev snapshot --remote
```

You see: `snapshot written to /…/.secrets/sandbox-dev/ledger-snapshot-….json` (note the path), three table lines and
"0027's triggers absent". One snapshot before all six migrations is right: `ledger-check` knows what each of 0022 to
0026 changes (D924).

### 2.6 At once: the bookmark, then every D1 migration

```sh
corepack pnpm --dir apps/api exec wrangler d1 time-travel info hana-id-sandbox-dev
corepack pnpm --dir apps/api exec wrangler d1 migrations apply hana-id-sandbox-dev --remote
```

You see: `⚠️ The current bookmark is '…'`: copy it with the UTC time (it undoes 2.6; 1.8's bookmark undoes the same and
a little more). Then "Migrations to be applied:" with the seven names of 2.4, "About to apply 7 migration(s) … continue?".
Type `y`. Then a table with each name and `✅`. A `❌`: stop and ask; don't restore without the assistant (a restore loses
every sign-in made since).

### 2.7 The comparison

```sh
corepack pnpm --filter @hana-id/scripts run ledger-check sandbox-dev compare --remote --before .secrets/sandbox-dev/ledger-snapshot-<time>.json
```

(a relative path is relative to the folder you run pnpm from, D924; or paste 2.5's full path). You see: a line
`security_events' kinds: at migration 0021 before, 0027 after`, `New since:` naming 0026's and 0027's triggers (0030's
are on `apps`, not compared), then `Verdict: identical` or `Verdict: kept` (rows the
running API wrote since, each named). `Verdict: ROLL BACK`: stop; the rollback is the runbook's
[Ledger rebuild, Rolling back](operations.md#ledger-rebuild-hot-db-migration-0027-d916), with the assistant.
`Verdict: migration 0027 is not applied`: 2.6 didn't apply it; nothing to undo; ask. `Verdict: can't judge` (exit 2) or
`Verdict: unknown level` (exit 3): **not** a rollback; nothing was compared or nothing was found damaged; ask (D924).

### 2.8 Confirm D1, then the console's D1

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations list hana-id-sandbox-dev --remote
corepack pnpm --filter @hana-id/console gen sandbox-dev
corepack pnpm --dir apps/console exec wrangler d1 migrations list hana-id-console-sandbox-dev --remote
corepack pnpm --dir apps/console exec wrangler d1 migrations apply hana-id-console-sandbox-dev --remote
```

You see: `✅ No migrations to apply!` for the API's (then P6's check, [D1: migration 0030](operations.md#evm-gas-sponsorship-not-live-yet-d834d836-d847-d848-d851-d856) step 2:
`corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT user_ids, COUNT(*) AS n FROM apps GROUP BY user_ids"`
gives one row, `scope` with every app); the console's `gen` with no placeholder; its list with only
`0004_label_step_ups.sql` (it rebuilds the 5-minute `pending_actions` table with two more kinds); `y`; `✅`. It has to be
applied: 3.11's `deploy-check --d1` fails while any D1 lacks a migration of the checkout.

## Phase 3: deploy the new code, sponsorship still off

**This phase changes what both demos look like.** The approval windows get their plain-language summary and wording,
the sign-in gets its new screens, and the stamps site's messages change (for example "It was free for you." where the
hackathon site said "You paid no gas."). The README's judge steps quote the old words. That is why it waits until
until Neon's reset (expected 2026-12-01) and your go-ahead.

Sponsorship stays off: the manifest has no `evm.sponsor` block yet, so no EVM relayer is created and the new
sponsorship routes answer "not configured".

The assistant runs this on "go ahead deploy", from the main checkout at the commit of 1.4. The order is the one every
full deploy has used (2026-11-12): the API before the pages, the email issuer and the admin portal. Each `gen` keeps
the database and ledger ids already in that app's config.

| # | Piece | Commands | You see |
|---|---|---|---|
| 1 | Files | `corepack pnpm --filter @hana-id/files gen sandbox-dev` then `corepack pnpm --filter @hana-id/files run deploy` | `wrote …`, then wrangler's `Deployed …` |
| 2 | API | (gen done in 1.7) `corepack pnpm --filter @hana-id/api run deploy` | `Deployed …`; then `curl -s https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/health` shows `"build"` with the first 12 characters of the commit of 1.4 |
| 3 | Vault and sign-in pages | `corepack pnpm --filter @hana-id/api run deploy:pages` | the web build, then two `Deployed …` |
| 4 | Email issuer | `corepack pnpm --filter @hana-id/email-issuer gen sandbox-dev` then `corepack pnpm --filter @hana-id/email-issuer run deploy` | `wrote …` with no placeholder, then `Deployed …` |
| 5 | Partner console | `corepack pnpm --filter @hana-id/console gen sandbox-dev` then `corepack pnpm --filter @hana-id/console run deploy` | `wrote …` with no placeholder; the console build; `Deployed …` |
| 6 | Console sign-in | `corepack pnpm --filter @hana-id/console-auth gen sandbox-dev` then `corepack pnpm --filter @hana-id/console-auth run deploy` | `wrote …`, `Deployed …` |
| 7 | Admin portal | `corepack pnpm --filter @hana-id/admin gen sandbox-dev` then `corepack pnpm --filter @hana-id/admin run deploy` | `wrote …` then `feed and watcher: on (…)`, then `Deployed …`. This deploy also puts the admin's triggers back to `*/5` + `*/15` (undoing the hand change of 2026-11-19); with the manifest's `admin.opsEveryMinutes` 15 the feed and the watcher then run every 15 minutes, the notices every 5 (D872) |
| 8 | Watchdog | `corepack pnpm --filter @hana-id/watchdog gen sandbox-dev` then `corepack pnpm --filter @hana-id/watchdog run deploy` | `wrote …` with no placeholder, `Deployed …` |
| 9 | Hosted demo | `corepack pnpm --filter @hana-id/demo run deploy` | its build, then `Deployed …` |
| 10 | Stamps site | `HANA_STAMPS_PUBLISHABLE_KEY=pk_test_Krd4BctwkZYeHB2yTqnV3HgAGX6huXXWZ corepack pnpm --filter @hana-id/stamps run deploy` | its build, then `Deployed …` (the key is Stamp Trail's public key, "Hosted stamps demo") |

If any `gen` says "local D1 placeholder id" or "off", or any deploy fails: stop there. The pieces already deployed keep
working with the old ones for a few minutes; see "Rollback" below.

Step 3 deploys the vault, then the sign-in pages, from one web build, seconds apart: keep them together. If this
deploy includes D875 (Remove at any age), a new vault behind old sign-in pages makes the old window show an added
sign-in older than 7 days as a full banner at every sign-in of the wallet's own sign-in. That is louder, not broken,
and stops once the sign-in pages are deployed. Rolling back only the sign-in pages does the same. Rolling back only
the vault is harmless.

### 3.11 Check the deploy

```sh
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --d1
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --only watchdog --d1
```

You see: the first ends `OK: every piece of sandbox-dev runs <commit> (this checkout); not read: watchdog`, with
`every migration of this checkout is applied (hana-id-sandbox-dev)` among its lines. The second ends with the same
commit. Any `FAIL:` line: stop and ask. (The two demo sites aren't stamped, so `deploy-check` doesn't read them.)

### 3.11a Neon's compute, after (D872)

1. `apps/admin/wrangler.jsonc` (just generated) has `"OPS_EVERY_MINUTES": "15"` and
   `"NEON_PLAN": "{\"computeHoursPerMonth\":100,\"computeUnits\":0.25}"` among its vars, and the triggers
   `*/5 * * * *` and `*/15 * * * *`; `apps/api/wrangler.jsonc` has the same `NEON_PLAN`. In Cloudflare: the admin
   Worker, Settings, Triggers shows both (a trigger change can take up to 15 minutes to reach every location, and a run
   can be missed meanwhile).
2. An hour later, open **System status**: **Neon compute this month** reads "About N of 100 compute-hours used this
   month (estimate) (counting began on 1 Dec; the hours before are assumed awake)", green below 70%. A deploy within
   48 hours of the reset counts the month as whole, the hours before the deploy taken as fully awake (at most 12
   compute-hours), so the figure errs high. Deployed later than that, it reads in amber "Counted since <date>: about N
   compute-hours since then. Neon's own figure for the month is higher: check Neon's console." for that month: read
   Neon's own figure then.
3. In Neon's console the compute's activity, over a quiet hour, should show it suspended for about 10 minutes of
   every 15. If it never suspends: tell the assistant (something still opens the database every few minutes, or
   Hyperdrive's pool keeps it awake: [Neon compute on the free plan](operations.md#neon-compute-on-the-free-plan-d872)
   "Hyperdrive").
4. Write down Neon's figure again. A day later it should have grown by about 2 to 2.5.

### 3.12 Hand check on the real sites

A fresh email address, a private window. Give each site a minute after the deploy (cold Workers).

1. Stamps site: sign in by email. Collect **Arrival**. In the approval window you see a plain summary at the top,
   "Stamp Trail wants to collect the Arrival stamp for you", "Collecting a stamp doesn’t move any money or tokens."
   and "It uses **Journear demo stamps** (hana-id-stamps-dev1.testnet, checked by Journear)." (D885: a reviewed call,
   so no amber line and no "NEAR leaving your account" row), the network row (no fee row: D884), and the technical
   part folded behind **Show details**, which starts with "Network fee: Free. Sponsored by {the stamps app's name}."
   After you approve: "It was free for you." Keep the tab open: item 5 uses your next stamp.
2. Hosted demo: sign in by email; the addresses show; one signature: the window starts with a plain summary and
   **Show details** is folded; the NEAR card's guestbook write goes through with 0 NEAR.
3. The Sodax sample site still signs in and signs (question 3).
4. The admin portal: **System status** loads and the **NEAR relay** tile reads On; **Security & monitoring** shows no
   new alert from the deploy.
5. **One NEAR billing record against the chain** (once; runbook "NEAR relay billing records" step 4). Just before
   your second stamp (**Fare paid**, same user as item 1, so there is no account creation in it), and again just after
   it is stamped, read the relay account's balance:

   ```sh
   near account view-account-summary hana-id-near-relay-dev1.testnet network-config testnet now
   ```

   Then read the newest record (you run it: it reads the remote database):

   ```sh
   corepack pnpm --dir apps/api exec wrangler d1 execute hana-id-sandbox-dev --remote --command "SELECT tokens_burnt, attached_yocto, figures_from FROM near_relay_billing ORDER BY created_at DESC LIMIT 1"
   ```

   You see: one row. `tokens_burnt` + `attached_yocto` (both in yoctoNEAR: 1 NEAR is 10^24) equals what the relay
   account lost between the two balances. Do it at a quiet moment, so no one else's stamp lands in between, and read
   the second balance about 30 seconds after the stamp (the relay holds some gas while a transaction runs and gets it
   back a few blocks later). If the balance shown is rounded too much to compare, read both from the relay account's
   page on a NEAR testnet explorer instead (the runbook allows either). If the
   account lost more: newer NEAR versions charge something the record misses; tell the developer team (the records
   would under-count the cost, D863). Nothing needs undoing.
6. The next day, the admin portal: no "NEAR relay: a billing record is late" alert. If one comes, its
   counts say why: `parked` and `unmirrored` usually catch up by themselves; `misses` or `unrecordedLast` (the last
   transaction the chain took from a relay key that day has no record) go to the developer team with the day;
   `notFinal` means checking the NEAR RPC endpoints.

If a demo is broken after the deploy and you can't wait: "Rollback", phase 3.

Then the assistant updates [`operations.md`](operations.md) "What sandbox-dev runs" with the commit, the migrations
and your hand check (docs go with every deploy).

## Phase 4: switching gas sponsorship on

**Recommendation: wait with this phase** until two things exist: the admin portal's sponsorship page (until then,
if the relayer stops itself, only an engineer can see why and restart it) and a way to try a sponsored action on a real
site (the hosted demo has no check-in card yet, so 4.15 can't be done). Phases 1 to 3 and 5 don't depend on it.

When you go ahead, only on your go-ahead, the numbered runbook is
[EVM sponsorship relay (not live)](operations.md#evm-sponsorship-relay-not-live); this phase follows it, with the
go-live order. **Read "What cannot be undone" in the rollback section first**: after 4.13 the EVM relayer exists for
good.

From your main checkout, on `develop`, `git status` clean, Foundry 1.5.1.

### 4.1 Deploy the two contracts on Base Sepolia (you)

```sh
corepack pnpm --filter @hana-id/scripts run deploy-evm-delegate sandbox-dev --rpc https://sepolia.base.org --yes --account hana-evm-deployer
```

`cast` asks for the keystore password once per transaction (two).
You see: each receipt (keep both transaction hashes in your notes), then
`✓ HanaDelegateExecutor at 0xfC5e…: runtime code hash 0xfcc8…, the artifact's` and the same line for `CheckIn`. At
the end it prints the explorer commands and the follow-up PR's content (the pinned-table entry and the manifest
block): copy all of it for the assistant.
A re-run is safe: `already deployed, matches the artifact`, nothing sent. `MISMATCH`: stop, pin nothing, ask.
`insufficient funds`: back to 0.4.

### 4.2 Verify both contracts on the explorers

```sh
corepack pnpm --filter @hana-id/scripts run deploy-evm-delegate sandbox-dev --rpc https://sepolia.base.org --verify
```

You see: the verification runs on Blockscout (no key needed); Basescan's runs only if an Etherscan API key is in the
shell (`read -rs ETHERSCAN_API_KEY; export ETHERSCAN_API_KEY`, never in a file). Then open both explorer pages it
printed: each says **verified**. A failure here doesn't block anything; the assistant can retry it.

### 4.3 The relayer key (you)

```sh
corepack pnpm --filter @hana-id/scripts run evm-relay-keys sandbox-dev
```

You see: the relayer's address (`0x…`) and the next steps. It wrote `.secrets/sandbox-dev/evm-relay-keys.json`
(0600). It never prints the key. Back the file up offline with your other `.secrets` files.
If it says `already exists: refusing to overwrite it`: a key is already there (it is the only copy). See its address
with `--show-address`; never delete the file.

### 4.4 Tell the assistant the relayer address

It goes into the follow-up PR (4.7). The address is public.

### 4.5 Fund the relayer

From the faucet, as in 0.4, to the relayer address: about **0.1 test ETH** (at least `lowBalanceEth` 0.05 plus
`dailyBudgetEth` 0.02).

```sh
cast balance <relayer address> --rpc-url https://sepolia.base.org --ether
```

You see: at least `0.07`, ideally `0.1`.
If the faucets give too little a day: question 4 at the end (moving test ETH from the deployer).

### 4.6 The two measurements owed on Base Sepolia (you and the assistant)

The relayer's rule for a user's action that no node takes relies on two behaviours of **your** read endpoint (0.6).
They are measured once before switching on (D851 item 18; runbook "The relayer", "Two checks owed").

- Send from the **deployer** keystore, **never** from the relayer key: a transaction the relayer didn't send makes
  it stop as if its key had leaked (`foreign_transactions`).
- The keyed URL goes into the shell without echo (`read -rs`), never on a command line.
- The exact `cast` commands are in the runbook ("The relayer", "Two checks owed"), rehearsed on a local anvil by the
  anvil lane (D868): you paste the keyed URL once and type the keystore password at each `cast`; the last command
  replaces the waiting test transaction so the deployer has nothing pending.

1. A test transaction with a very low tip, so it waits. Ask the endpoint for the deployer's pending transaction count
   (`eth_getTransactionCount` with `pending`) before and after.
   **Good**: the count goes up by one while the transaction waits. **Bad**: it doesn't move.
2. Send the same signed transaction a second time.
   **Good**: the endpoint answers "already known" (or the same words). **Bad**: any other answer.

If either is bad: don't switch on. Tell engineering; the rule has to be revisited or another provider chosen.

What the anvil lane already rehearsed on a real (local) node, so it is not owed here: both checks' behaviour as the
relayer assumes it (anvil: the count rises; the same bytes again answer `transaction already imported`), every
scenario of the relayer's rules (bumps, deadline cancels, halts and staff tools, a reorg's correction) and the gas
formula against the real delegate (`docs/operations.md` "The anvil lane"). What still needs Base Sepolia, and goes into
the follow-up PR with the two answers above: the receipts' OP Stack L1 data fee and operator fee against the
GasPriceOracle bounds (the first real sponsored action's receipt, 4.15); the provider's wording of its refusals
(recorded as they occur in the relayer's logs and `evmRelayerStaffStatus`'s `unconfirmedRefusal`); and the pool rules
anvil lacks (+10% replacement, the 128 KiB limit, `authority already reserved`): nothing to send for these on the day.

### 4.7 The follow-up PR (the assistant; you review the numbers)

A branch from `develop` (the freeze is over), PR into `develop`. It holds:

- core's pinned-table entry for chain 84532, pasted exactly as 4.1 printed it;
- the `"evm": { "sponsor": { … } }` block at the top level of `envs/sandbox-dev.json`, beside `"near"`, with:
  - `relayerAddress`: the address of 4.3;
  - the two public endpoints, with no key in them: `"rpc": "https://sepolia.base.org"` and
    `"rpcFallback": "https://base-sepolia-rpc.publicnode.com"`;
  - `delegate` `0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA` and the check-in target
    `0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e`;
  - your limits (D836): `dailyBudgetEth` **0.02** (all apps together), `appDailyBudgetEth` **0.01** (each app),
    `perUserPerDay` **30**, `deadlineMaxS` **300**; and the rest as printed (`lowBalanceEth` 0.05, `perAppPerDay`
    2000, `sendsPerDay` 5000, `sendsPerMinute` 60, `maxGasPerTx` 300000, `maxFeePerGasGwei` 1,
    `requireKnownAccount` true);
  - the app allowed to use it (question 5 at the end), by its `app_…` id from
    `corepack pnpm --filter @hana-id/scripts run admin sandbox-dev app:list --remote`;
- the docs that still say "no Base Sepolia entry yet", and the deploy recorded in D849 (date, addresses, both
  transaction hashes, the explorer links).

You see: the PR's diff with exactly those numbers. Merge only once you agree. The assistant runs
`corepack pnpm verify` first.

### 4.8 Update the deploy checkout again

```sh
git status
git pull --ff-only
corepack pnpm install --frozen-lockfile
corepack pnpm verify --full
```

You see: clean, the follow-up PR's merge commit, and every check passed.

### 4.9 Migrations: nothing new

```sh
corepack pnpm --dir apps/api exec wrangler d1 migrations list hana-id-sandbox-dev --remote
```

You see: `✅ No migrations to apply!` (phase 2 applied 0022). Anything else: stop and ask.

### 4.10 The API config with sponsorship

```sh
corepack pnpm --filter @hana-id/api gen sandbox-dev
```

You see: the same lines as in 1.7, no error. If it refuses the block ("no pinned delegate for chain 84532" or "the
API would refuse it"): the follow-up PR isn't in this checkout, or a number is out of bounds; stop.

### 4.11 Upload the relayer key (you)

Check first (uploads nothing):

```sh
corepack pnpm --filter @hana-id/scripts run env-secrets sandbox-dev --worker api --secret EVM_RELAY_KEYS
```

You see: `EVM_RELAY_KEYS <- …: ok`. If not ok: the line says why (missing, not 0600, another address); stop.

Then upload that one secret (the value goes to wrangler on its input; nothing is printed, no other secret is touched):

```sh
corepack pnpm --filter @hana-id/scripts run env-secrets sandbox-dev --worker api --secret EVM_RELAY_KEYS --yes
```

You see: `Set EVM_RELAY_KEYS on Worker …`. Until the deploy of 4.13 nothing uses it: the running API still answers
"not configured".

### 4.12 Upload the read endpoint (you; required)

```sh
corepack pnpm --dir apps/api exec wrangler secret put EVM_SPONSOR_RPC_84532
```

wrangler asks for the value and doesn't show it: paste the URL from your password manager (0.6), then Enter.
You see: a success line for `EVM_SPONSOR_RPC_84532`. Never type the URL anywhere else.
Without this secret sandbox-dev keeps sponsorship off (every sponsorship request answers "not configured", and the
API's log says `evm_sponsor_rpc_missing`), and 4.14's check fails until it is there: it never falls back to the public
endpoint.

### 4.13 Deploy (the assistant, on "go ahead deploy")

The same ten steps as phase 3, in the same order, from this checkout (every stamped Worker must run one commit for
`deploy-check`). This deploy creates the EVM relayer (wrangler migration `v3`): from here on it can't be undone. The
vault pages now carry the chain's delegate and relayer. Rows 9 and 10 (the two demo sites) can be skipped: neither
uses sponsorship yet, and `deploy-check` doesn't read them.

### 4.14 Check the deploy

```sh
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --d1
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --only watchdog --d1
```

You see: the `evm` group for 84532: both endpoints on the right chain, `delegate 0xfC5e… runs the artifact's code`,
the relayer's balance against `lowBalanceEth`, `has code` for the check-in target, and
`evm 84532  secret EVM_SPONSOR_RPC_84532 is set on hana-id-api-sandbox-dev (its name only: the value is never read)`;
the last line is the `OK: …` line with `EVM sponsorship checked` in it. A `warning: … below lowBalanceEth`: fund the
relayer (4.5). `FAIL: evm 84532: the API Worker hana-id-api-sandbox-dev has no secret EVM_SPONSOR_RPC_84532 …`: do
4.12, then run the check again (sponsorship is still off meanwhile, nothing to switch off). Any other `FAIL:`: use the
off switch (below) and ask.

### 4.15 The first sponsored action, by hand (you)

Not possible yet: the demo's check-in card comes with a later package, and until it is deployed no real site has a
button for it (the reason for the recommendation above). When it exists: sign in with a fresh test user (0 ETH), check in on Base Sepolia, approve
in the window. You see: it goes through, the user's balance stays 0, and on the explorer the transaction was sent by
the relayer address.

### 4.15a Checks on Base Sepolia before switching on (the assistant, then you)

A gate (D890, after its security review): run these on Base Sepolia before gas sponsorship is switched on for any app,
and in particular before the chain's `autoRestart` (the relayer restarting by itself after a refill) is set to `true`
in `envs/sandbox-dev.json`. Use throwaway test keys and test ETH only: a fresh test relayer key and test accounts made
for this, never the production relayer key, never mainnet. Record each result (the commands, the hashes, the answers)
in the PR that turns `autoRestart` on. Until then leave `autoRestart` out (it is off by default); staff Resume always
works.

1. **A deposit from Sepolia raises the relayer's count on Base Sepolia.** From the test relayer key on Sepolia, call
   `OptimismPortal.depositTransaction` (Base Sepolia's portal on Sepolia; `_to` any address, `_value` > 0, `_gasLimit`
   100 000; `cast send` with the key from `.secrets/`). Required: once it lands on Base Sepolia, `eth_getTransactionCount`
   of the relayer address is one higher on BOTH providers (the keyed read endpoint and `rpcFallback`), `_value` left the
   relayer's L2 balance, and a test relayer object then halts `foreign_transactions`. If the count does not rise, stop:
   the relayer can't see this way of moving its money; ask the assistant.
2. **An EIP-7702 authorization by the relayer key, carried by another account.** Sign an authorization with the test
   relayer key (any contract address, its current count) and send it in a type-4 transaction from another funded test
   account. Required: the count +1 and `eth_getCode` of the relayer address returns `0xef0100…` on both providers, and the
   relayer halts `relayer_has_code`; an authorization to the zero address then gives +1 again and `0x`. Also note
   op-geth's answer to a second in-flight transaction from the delegated relayer ("in-flight transaction limit reached
   for delegated accounts" expected).
3. **The `pending` count**, D851 item 18's two checks, on the keyed endpoint AND on `rpcFallback`: does
   `eth_getTransactionCount(pending)` rise between `eth_sendRawTransaction` and inclusion (send a low-tip transaction), and
   does re-sending the same raw answer "already known". Base's pool is private, so `pending` may equal `latest`; write
   down what each provider answers.
4. **Refill to restart, timed.** With `autoRestart: true` on a test env only: drain the test relayer below a send's cost,
   let it pause for money, send the amount the tile names, and time the restart, once within the pause's first 10
   minutes (runs every 15 s) and once after (every 60 s). Required: "Restarted by itself after a refill" within 2 minutes
   each time. Note how often the first try ends in `unexplained_slot`, `counts_moving` or a disagreement (the Gas
   sponsorship page's "Restarts by itself" line and the API's `evm_relayer_auto_restart_waiting` log lines).
5. **The second provider from Workers:** its answers and rate limits as the API Worker reaches it (a day of the paused
   cadence's 5 reads a check is the most it is asked); `second_endpoint_unavailable` should be rare. If it is not, pick
   another provider for `rpcFallback` (another company than the keyed endpoint's).
6. **The tile's amount with real L1 data fees:** sending exactly the "Send at least" amount restarts it, and the next
   sponsored action goes through without a second pause.

Then, only with all six recorded: `autoRestart: true` in the chain's block, `gen`, deploy the API (a PR on its own).

### 4.16 What the admin portal should show (you)

- **Security & monitoring**: no "Gas sponsorship: …" alert (their meanings: operations "EVM gas sponsorship",
  "Watching it").
- The relayer's state: System status's tile **Gas sponsorship (Base Sepolia)** says "Working" (else why and what
  to do, as numbered steps); its link opens the Gas sponsorship page, with what is waiting and the staff tools
  (operations "Gas sponsorship in the admin portal (D843)"). The table in phase 3 already deploys the API (row 2)
  and the console (row 5) before the admin portal (row 7), which this needs: with an older API the tile says "This page
  is newer than the API: deploy the API first" and the tools do nothing; with an older console the tools say so and do
  nothing. Without the read endpoint (4.12) the tile says "Not set up" with the upload step.
- If it pauses because the relayer wallet is out of money (**Paused: needs money**): do the tile's first step (look at
  the wallet on Basescan; transfers nobody at Journear made: stop, tell the assistant, don't send money), then send the
  amount it names once. Where `autoRestart` is on (after 4.15a), it restarts by itself within 2 minutes of the money arriving (D890: it says
  **Restarting by itself**, then **Working** with "Last restart: Restarted by itself after a refill", and the alert
  "Gas sponsorship: restarted by itself after the relayer wallet was refilled" follows). You don't press Resume unless
  the tile says it can't restart by itself (3 times already today, it ran out again within 30 minutes, or the two
  network servers disagree, restarting by itself is off, or the tile names another blocker). The tile's **Check
  again** shows a fresh reading at once. Migration 0024 (phase 3's D1
  migrations) must be applied for that alert.

### 4.17 The free-plan CPU measurement (the assistant)

After the first sends, the assistant reads the API's logs for the `evmOps` lines beside Cloudflare's CPU time. A cold
first send must stay within the free plan's 10 ms. If sends fail with a Cloudflare limit error: use the off switch and
ask (D851).

### The off switch

```sh
corepack pnpm --dir apps/api exec wrangler secret delete EVM_RELAY_KEYS
```

Sponsorship stops at once: the API answers "not configured" and the relayer signs nothing new (what it already sent is
still followed up on the chain). To switch back on: 4.11's upload. Never remove the `evm.sponsor` block after 4.13
(below).

## Phase 5: afterwards

### 5.1 Switch CI on (you)

After phase 1 `develop` carries the new CI file, which has no nightly run, so switching on now avoids `develop`'s old
nightly (runbook "Enabling CI also starts a nightly run").

```sh
gh workflow enable CI -R Hana-Technology/hana-id
gh workflow list -R Hana-Technology/hana-id --all
```

Or in GitHub: the repository → **Actions** → **CI** in the left sidebar → **Enable workflow**.
You see: CI `active`. Leave the identity probe disabled (not part of this, D857).

### 5.2 The first CI run (you)

The next PR or push starts it (or Actions → CI → **Run workflow** on `develop`).
You see: the jobs get runners and run. If every job fails within seconds with no steps run and a note about billing
or a spending limit: on the $0 Actions budget (0.8), untick "stop usage", keep the alerts on, re-run, and tell the
assistant (it records it in D857).
To switch CI off again: `gh workflow disable CI -R Hana-Technology/hana-id`.

### 5.3 The NEAR relay's limits back to normal (D793): done with the deploy

Decided 2026-11-23: not a separate step any more. 1.1a put the four `near.relay` values back on `next` and phase 3
deployed them with the API. Check once, after phase 3: the admin portal's **System status** page, **NEAR relay** tile
On, and the relay account holding at least 10 NEAR (1.9's command).

### 5.4 Review the email budget (you decide; D793)

Today, in `envs/sandbox-dev.json` `emailIssuer`: `dailySendBudget` 333 (30% of the shared SendGrid plan; it was 200
before the judging), `appShares` 200 a day for Stamp Trail, and `tighterLimits` (lower per-address limits). Your
choices: keep all three; lower `dailySendBudget` (200 is the pre-judging value); drop `appShares` (Stamp Trail then
gets 100 a day); drop `tighterLimits` (back to the dev limits). Past 50,000 mails a month SendGrid bills each mail, so
lower is safer. Runbook: [Judging week on sandbox-dev](operations.md#judging-week-on-sandbox-dev-d793).
Any change: a PR, then

```sh
corepack pnpm --filter @hana-id/email-issuer gen sandbox-dev
corepack pnpm --filter @hana-id/email-issuer run deploy
corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev --only issuer
```

### 5.5 Refresh the docs frozen for the hackathon (the assistant)

- The README's "For judges" steps and `docs/hackathon-demo-script.md` quote the judging site's words ("NEAR
  transaction, fee paid by a relayer", "You paid no gas."): bring them to what the live sites now say (after D884 that
  heading, inside **Show details**, is "NEAR transaction, sent for you", under "Network fee: Free. Sponsored by
  {app}."), or say they describe the submission (the tags `pre-hackathon` and `hackathon-submission` stay where they are).
- `docs/hackathon-public-checklist.md` step 9 and `docs/hackathon.md` "The hosted demos": the sites are no longer
  frozen.
- [`operations.md`](operations.md) "Hosted stamps demo": drop the "(the deployed judging site: …)" asides.
- "What sandbox-dev runs": the commits, migrations and the sponsorship state.

### 5.6 The first week: what to watch

Look at the admin portal (**Security & monitoring** and **System status**) once a day, and at your alert mail.

| Alert or sign | What it means, in one line | Where to look |
|---|---|---|
| `near_relay_balance_low` | The NEAR relay account is below its low line | [playbook](playbooks.md#near-relay-balance-low) |
| `near_relay_budget_high` | Today's NEAR relay spend reached 80% of its budget | [playbook](playbooks.md#near-relay-budget-high) |
| "NEAR relay: a billing record is late" (`near_billing_late`) | A NEAR relay's record is missing, waiting, not read back, not copied to the ledger, or a key's last transaction of the day has none (`unrecordedLast`) | operations "NEAR relay billing records", "Watching it"; 3.12 item 6 |
| `relayer_balance_low` and the other relayer funds alerts | The sign-in relayer is running low | [playbook](playbooks.md#relayer-out-of-funds) |
| "Gas sponsorship: the relayer wallet is running low" (`evm_relay_balance_low`) | The EVM relayer needs test ETH | operations "EVM gas sponsorship", "Watching it"; fund it (4.5) |
| "Gas sponsorship: paused or slow, needs a look" (`evm_relay_stuck`) | The relayer stopped itself, refused an action, its oldest transaction waited over 2 minutes, or a send stayed unsettled over 10 | operations "The relayer: what it does, when it stops, what to do" |
| "Gas sponsorship: today's budget is nearly used up" (`evm_relay_budget_high`) | 80% of the day's 0.02 test ETH is used | usually nothing; it resets at 00:00 UTC |
| "Gas sponsorship: a payment looked wrong …" (`evm_relay_receipt_odd`) | The read endpoint gave an odd answer | check or replace the endpoint (4.12) |
| "Gas sponsorship: a payment slot was used by another transaction" (`evm_relay_nonce_taken`) | The relayer key may be used elsewhere | the leaked-key steps in operations "EVM sponsorship relay" |
| "Gas sponsorship: restarted by itself after the relayer wallet was refilled" (`evm_relay_auto_resumed`) | It had paused for money and restarted itself after a refill, every check passed (D890) | nothing if one of us sent the money; else, and anyway, look at the wallet on Basescan ([playbook](playbooks.md#evm-relay-auto-resumed)) |
| "Gas sponsorship: a billing record is late" (`evm_billing_late`) | A sponsored send's record didn't reach the ledger | check the ledger connection first |
| `usage_write_failed` in the API's logs | A usage event didn't reach the ledger | operations "Usage capture", "What to watch" |
| A demo says the vault didn't load | Usually a cold Worker for a minute after a deploy; else an origin or build problem | operations "Common failures" |
| Cloudflare's usage page near a free limit | Requests, Durable Objects or D1 near the day's free allowance | stop and ask before anything upgrades |

## Rollback: how to stop safely

**When to stop and ask:** any `FAIL`, `MISMATCH` or `❌`; a demo that worked before and doesn't now; a balance far from
your notes; anything that asks for money; any message this list doesn't mention.

| Phase | How to undo or stop | Notes |
|---|---|---|
| 0 | Nothing to undo. The plan sent nothing. GitHub settings change back in the same place. | The keystore and the provider account are yours; keep them. |
| 1 | If you stop before phase 2, just don't deploy: nothing on sandbox-dev changed. A wrong tag: `git push origin :refs/tags/sandbox-dev-<yyyy-mm-dd>`. | Undoing the merge into `develop` is a revert PR; ask the assistant. |
| 2 | Nothing to undo after a success: the ledger's three and D1's 0022 to 0026, 0030 and console 0004 only add (tables, columns, triggers, kinds), 0027 keeps every row, and the old API, console and admin work on all of them (D916). | A failed migration (`❌`), or 2.7's `ROLL BACK`: stop and ask. The Time Travel restore (below, to 2.6's bookmark) is a last resort: it loses every write after the bookmark (sign-ins, new wallets, app changes, suspensions) and needs the admin feed's cursor lowered at once (`ledger-check sandbox-dev feed-cursor`, a Neon connection). The ledger's migrations have no down files and stay. |
| 3 | Roll each Worker back to its previous version, in the reverse order of the table (stamps site first, files last): `corepack pnpm --dir apps/api exec wrangler rollback` for the API, `corepack pnpm --dir apps/api exec wrangler rollback --name hana-id-vault-sandbox-dev` and `… --name hana-id-auth-sandbox-dev` for the two page Workers, and `wrangler rollback` from each other app's own folder (`apps/files`, `apps/email-issuer`, `apps/console`, `apps/console-auth`, `apps/admin`, `apps/watchdog`, `apps/demo`, `apps/stamps`). wrangler shows the version it goes back to and asks first. Or redeploy every piece from a checkout at the commit you wrote down in 1.6. | The phase 2 migrations stay: the older code works with them. After a rollback, `deploy-check sandbox-dev --skip-head` checks the pieces agree. **The admin Worker:** a rollback doesn't bring back the hand-set `*/30` trigger; old code with `*/5` opens Neon every 5 minutes (D872), so after rolling it back run `corepack pnpm exec wrangler triggers deploy --triggers "*/30 * * * *" "*/15 * * * *"` from `apps/admin` (never change `*/15`). |
| 4 | **The off switch**: `corepack pnpm --dir apps/api exec wrangler secret delete EVM_RELAY_KEYS`. The read endpoint stays: it is required, and replacing it is the same `wrangler secret put EVM_SPONSOR_RPC_84532` with the new URL. | After 4.13, fix forward: don't roll the API back past the deploy that created the relayer. A rollback never undoes a Durable Object (wrangler says so), so the old code would run beside the relayer's stored state; use the off switch. |
| 5 | CI off: `gh workflow disable CI -R Hana-Technology/hana-id`. Limits or email budget: a PR with the old values, then the same `gen` and deploy. | |

**The D1 restore** (only with the assistant, only if the data is damaged): runbook
[Restoring a D1 database (Time Travel)](operations.md#restoring-a-d1-database-time-travel). For a `ROLL BACK` of 2.7, or
damage found after 2.5: **2.6's bookmark**, as [Ledger rebuild, Rolling back](operations.md#ledger-rebuild-hot-db-migration-0027-d916)
says (2.5's snapshot holds the rows written up to it; a restore to 1.8's earlier bookmark loses some of them, and the
check after the restore then says ROLL BACK again). 1.8's bookmark only for damage found before 2.5. After the restore,
that section's steps 2 to 5 of "Re-run afterwards" only, never its step 1 (it would re-apply the migrations at once).
It exports the damaged state first, restores in place, and lists what to re-run afterwards.

**What cannot be undone:**

- The two contracts on Base Sepolia (4.1). They have no owner and hold nothing; they just stay.
- The EVM relayer's creation (wrangler migration `v3`, 4.13). From then on **the `evm.sponsor` block must stay in the
  manifest**: removing it drops `v3` from the generated config and every later API deploy fails. Turn sponsorship off
  with the off switch, never by removing the block.
- Any sponsored or relayed transaction already on the chain, and the billing records (kept for good, also after a
  user's erasure; they hold no name or email).
- Mail already sent.

## If Neon's allowance is used up

Neon's free plan stops the usage database until its next period, and nothing can connect to it, whatever the error
says. During a deploy, only these steps fail:

- **2.1 to 2.3, the ledger migrations** (`usage-migrate`: 0009, 0010 and 0011).
- **3.11a, the Neon checks after the deploy.**

Everything else works: D1's migrations (2.4 to 2.8), every Worker deploy, `deploy-check --d1`, sign-ins, wallets, the
demos, the blocking notices and the watchdog. What stops while it lasts, deploy or not: usage records (each one lost),
the security feed and the watcher emails, gas settlement, the ledger's alerts, statements, reports and exports, the
partner console's Usage and Statements pages. The new API keeps every NEAR relay and sponsored-action billing record
in D1 and copies them once the ledger is back and migrated ("billing record is late" alerts meanwhile).

Two clean ways to avoid a half-done deploy (D1 and the code new, the ledger not migrated):

- **(a) Do the first deploy on or after the day the allowance resets.** **Your choice (2026-11-19, D872)**: expected
  2026-12-01, the date from Neon's console.
- **(b) Apply ledger migrations 0009 to 0011 ahead of time, while allowance remains** (2.1 to 2.3 on an earlier day).
  Not chosen, kept as the fallback. They only add tables and views, and the running code doesn't use them, so nothing
  changes for it. **But from then on those three files are frozen**: `usage-migrate` refuses a file changed after it was
  applied, so any later change to them must be a new migration (0012 and on), and the branch that changes them must be
  fixed before the deploy.

If you find it used up in the middle of a deploy anyway (after 2.3, phase 2 needs no Neon): finish phase 3, skip
3.11a, and run 3.11a on the day it resets (and 2.1 to 2.3 then, if they hadn't run); until then expect "Usage ledger (Neon)" red on System status and the
"billing record is late" alerts.

## Things that cost money (none expected)

Everything here runs on free plans. These would cost money; each needs your explicit yes first:

- a paid plan, "pay as you go" or overage on the RPC provider (0.6);
- Cloudflare Workers Paid (for example to lift the 10 ms CPU limit, more Durable Object use, or 30-day Time Travel);
- a paid Neon plan;
- SendGrid mail past the shared plan's 50,000 a month (billed per mail, not refused);
- GitHub: making the repository private again with CI on (every minute billed), a larger, ARM, GPU or macOS-large
  runner, artifact storage past the plan's allowance, or a cache limit raised above 10 GB.

Free: faucets, Blockscout and Basescan verification, standard GitHub runners on a public repository.

## Questions for you (each with the recommended answer)

1. **Which RPC provider for the Base Sepolia read endpoint (0.6)?** Recommended: whichever of Alchemy or QuickNode
   offers Base Sepolia on a free plan with no card and refuses requests at the limit instead of billing them.
2. **What do we call the deploy tag (1.3)?** Recommended: `sandbox-dev-<the deploy date>`, for example
   `sandbox-dev-2026-12-01`.
3. **What is the Sodax sample site's address, to check it before and after (1.10, 3.12)?** Recommended: check it in
   both places; the address isn't in this repository.
4. **If faucets are slow, may the assistant give you a `cast send` command that moves 0.1 test ETH from the deployer
   to the relayer (4.5)?** Recommended: yes; it signs with your keystore and asks for its password.
5. **Which app may use gas sponsorship (4.7)?** Recommended: the hosted demo's app only, the one the check-in card
   will live in, and no partner app until the admin page exists.
6. **When does phase 4 happen?** Recommended: not on the first deploy day; once the admin portal's sponsorship page
   and the demo's check-in card are merged and deployed.
7. **A second, independently operated NEAR testnet RPC provider (D900, after PR 128's review)? Settled 2026-11-24
   (D903): no; one operator is accepted on testnet, and a production network must name two different operators in its
   manifest (the schema and `deploy-check` refuse it otherwise; not in force until the schema admits another network
   than testnet, and the names are a declaration a reviewer checks, not proof). Nothing to do for this deploy.** sandbox-dev's `rpc`
   (test.rpc.fastnear.com) and `rpcFallback` (rpc.testnet.near.org) are both run by FastNear today (the second is
   heavily rate-limited). Every check that asks "both providers" (a test app's network and delegate checks, D263/D729,
   and the code hash a NEAR request label is tied to, D900) then rests on one operator, and the docs say so. It was to
   be settled before any env turns request labels on; the options were (a) a second provider run by another company,
   (b) a self-hosted testnet node, (c) accept it for testnet, with the docs saying one operator. The Tech Lead chose (c),
   enforced on production only. `envs/sandbox-dev.json` is unchanged.
