# Before the repository goes public: a checklist

For the person who flips `Hana-Technology/hana-id` to public for the NEAR HACKATHON (deadline 2026-11-14T23:59:00Z).
The founder's plan (2026-11-13): public "towards the end, but not now" (D749). Nothing here was changed by the branch
that wrote it: each item is something to check, or a decision for the founder. Making the repository public and pushing
tags are the founder's calls (the event's own agent rules say the same: never make a repository
public, push or post without the human's confirmation). Step 11 has the order of the last steps.

Last verified against code: 2026-11-13 (branch `docs/hackathon-stamps`, docs only, against `develop` @ 83ac508c:
the stamps demo added to steps 8 and 9, the secrets audit's outcome in step 1, the branch counts and the clean-up
command in step 2, the personal-data lines rechecked by `git grep` in step 3, the GitHub settings re-read with `gh`
read-only in step 5, the balances read from a public RPC in step 9, the judging-week limits (D793), and the new step 11,
the order of the final steps); 2026-11-13 (branch `docs/hackathon-submission`, docs only: the first version at
`develop` @ 35bc103e; steps 6 to 8 after the founder's decisions on the tags and the licence, D746, D747).

## 1. Secrets in the full history

Once public, every commit on every pushed branch is readable, including branches never merged.

```sh
git fetch origin --prune
corepack pnpm secrets:scan                                   # the repo's own: gitleaks over HEAD's history
gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 --log-opts="--all" .   # every local and remote-tracking branch
```

Result for 2026-11-13: an independent, read-only audit that day over all 231 branches then on GitHub and the full
history found **no live secret**. `.gitleaks.toml` adds Journear's own key shapes to the default rules, and
`scripts/secret-scan-selftest.mjs` checks those rules catch a fake of each (`corepack pnpm verify` runs it).

- [ ] `TODO(submit)`: rerun the two commands above on the day, after the last push and before the flip (branches
      pushed since the audit, 240 on 2026-11-13 evening, are not covered by it).

## 2. Branches, pull requests and CI logs become public too

- `git ls-remote --heads origin | wc -l` printed 240 on 2026-11-13 evening (231 that morning, 214 on 2026-11-11);
  `docs/hackathon-stamps` makes 241. Every one becomes public, merged or not. 237 are merged into `develop` (all but
  `develop`, `docs/near-hackathon` and `feat/email-login-1`); there is no `main` on GitHub. All their commits are
  dated inside the window (2026-10-26 to 2026-11-13), so none has to go for the rules.
- To delete the merged branches before the flip (the founder's call; the ruleset protects `develop` from deletion,
  and a deleted branch's commits stay reachable from `develop`):

  ```sh
  git fetch origin --prune
  git branch -r --merged origin/develop | grep -v -- '->' | sed 's|^ *origin/||' | grep -vxE 'develop|main' > merged-branches.txt
  wc -l < merged-branches.txt                                  # 237 on 2026-11-13 (more once this branch is merged)
  xargs -n 20 git push origin --delete < merged-branches.txt
  git fetch origin --prune && git ls-remote --heads origin    # develop and the unmerged ones are left
  rm merged-branches.txt
  ```

  The two unmerged branches: `docs/near-hackathon` (an older write-up, superseded, D745) and `feat/email-login-1`;
  delete them too or keep them, the founder's call.
- 61 pull requests (titles, bodies, review comments) and the 376 GitHub Actions runs (their logs) become public with
  the repository. CI never had repository secrets (`gh secret list` is empty) or environments; skim a few run logs
  anyway.

## 3. Personal data found (listed, not changed)

Found by `git grep` on `develop` @ 83ac508c for email addresses, names, handles and local paths on 2026-11-13. Each is
a decision for the founder: keep, replace with a role address, or move out before going public. Git history keeps the
old text even after a change.

| Where | What |
|---|---|
| Every commit's author and committer (`git log --remotes=origin --format='%ae'`) | `amdcopper@gmail.com` (author of 1,217 of the 1,221 commits on GitHub's branches), `hello@ting.rocks` (author of 4), the name "Ting Tze Chuen" on all of them; committer `noreply@github.com` on 60 merges made on GitHub |
| History only (replaced on `develop` on 2026-11-13, D792 and the pre-public tidy) | `amdcopper+1@gmail.com` as an email test vector; a local path with the home folder name and the private repository name `wend-api` in `docs/identity-token-spec.md` |
| `envs/sandbox-dev.json:19` | `hello@ting.rocks` as the watchdog's alert address |
| `envs/sandbox-dev.json:131` | `hello@ting.rocks` and `mark@hanawallet.io` as the admin's staff emails |
| `envs/sandbox-dev.json:139` | `hello@ting.rocks` as the security alias |
| `docs/operations.md:275`, `:1736` | `hello@ting.rocks`; `hello@ting.rocks` and `mark@hanawallet.io` |
| `docs/context.md:427` | the personal domain `ting.rocks` (a deferred Cloudflare test) |
| `.github/CODEOWNERS`, `docs/decisions.md` (lines 619, 1123, 9639), `docs/mainnet-readiness.md:202`, `:290`, `docs/security.md:2398` | the GitHub handles `@tzechuen` and `@mj-hana` |
| 46 files, 154 lines (`git grep -c tingtc`) | the Cloudflare workers.dev subdomain `tingtc` in every sandbox-dev URL, both demo sites' included (the personal Cloudflare account; the move is planned, `docs/operations.md` "Moving an env to another Cloudflare account") |
| `envs/sandbox-dev.json` (`watchdog.cloudflare.accountId`, `admin.accessTeamDomain`, `admin.accessAud`); `docs/operations.md` "What sandbox-dev runs" | the Cloudflare account id and the Access team and audience: identifiers, not secrets |
| `CLAUDE.md:8`, `docs/context.md:4`, `:5`, `:402`, `docs/batch-a-spec.md:4`, `docs/batch-b-spec.md:7`, `docs/batch-c-spec.md:17`, `docs/decisions.md:11574` | links to private claude.ai artifacts (the plan doc and others); they don't open for others |
| `apps/console/preview/fixtures.ts`, `apps/console/preview/mock-api.ts`, `apps/console/scripts/test/preview.test.ts` | made-up people at `soralabs.io`, which may be a real company's domain; the other fixtures use `.example` |
| Many tests | made-up `@gmail.com` addresses (`alice@gmail.com` and similar) as email-normalisation cases; generic, listed for completeness |

`team@hanawallet.io` (the sender of Journear's mail) and the `id-dev.hanawallet.io` names in tests and docs are the
company's, not personal. The commit email is the hardest to change: rewriting 1,221 commits changes every hash, breaks
every open branch and the links in the docs. GitHub can hide it for future commits ("Keep my email addresses
private"); it cannot hide it in existing ones.

## 4. Internal docs that describe open security items

These are written for the team and are candid about what is not done. Publishing them is a decision for the founder,
not a recommendation either way. Judges will read the code anyway, and the README already summarises the limits.

- `docs/security.md` "Known open issues" (the page-serving trust root, the 1-of-1 email signer, and others), "What a
  compromise gives", "The NEAR meta-transaction relay" (its abuse analysis), "The passport stamps demo contract" and the
  security sweep sections.
- `docs/system-overview.md` sections 4b to 4g and 5 ("Hard questions, honest answers").
- `docs/mainnet-readiness.md` (every open item before mainnet, the top blockers).
- `docs/playbooks.md` and `packages/playbooks` (step-by-step incident responses, which name the alerts the watchdog
  sends).
- `docs/decisions.md` (every decision, including rejected options and security review findings).
- `docs/operations.md` (runbooks, including who holds which key on sandbox-dev, and the relay's limits).

## 5. GitHub settings to check

Read on 2026-11-13 evening with `gh repo view` and `gh api` (read-only): visibility private; the ruleset "PR Required
Ruleset" (active, on branches: the default branch, `main`, `master` and `develop`; rules deletion, non-fast-forward,
pull request); secret scanning, push protection, validity checks and Dependabot security updates all off. Read that
morning and not re-read: default branch `develop`, no licence detected, no description, no topics, wiki on, issues on,
projects on, discussions off; workflows CI and "Identity JWKS probe" disabled manually, "Publish SDK packages" active
(manual dispatch only); no repository secrets, no environments.

- [ ] Settings, General: visibility to public (Danger Zone), only when the founder says so (`TODO(submit)`).
- [ ] At the flip, Settings, Code security: **secret scanning and push protection on** (free for public
      repositories; `gh api` read both off on 2026-11-13); Dependabot alerts as the founder prefers; private
      vulnerability reporting on, or a `SECURITY.md` saying where to report.
- [ ] Settings, Actions: if CI is turned back on while public, "Require approval for all outside collaborators" for
      fork pull requests (`ci.yml` runs on `pull_request`), and keep `GITHUB_TOKEN` read-only by default.
- [ ] Settings, Rules: the ruleset still applies to `develop`; forks can't push.
- [ ] Wiki and Projects: turn off if unused, since they become public too.
- [ ] Deploy keys, webhooks, collaborators and installed apps: nothing unexpected.
- [ ] The repository description and topics: plain, no claims the README doesn't back.

## 6. Tags for the window (rule Q-003)

Decided by the founder 2026-11-13 (D746): both tags, as the rules name them. The repository has none yet
(`git ls-remote --tags origin` printed nothing on 2026-11-13 evening). The exact commands, and how to move the
submission tag, are in [`hackathon.md`](hackathon.md) "Git tags the rules name".

- [ ] `TODO(submit)`: the founder pushes `pre-hackathon` on `e0c831fc` (any time), then `hackathon-submission` on the
      final commit of `develop`, last: after everything is merged, just before the repository goes public. If
      `develop` changes after that, move the tag to the new final commit.
- [ ] Then open `https://github.com/Hana-Technology/hana-id/compare/pre-hackathon...hackathon-submission`: the README
      links it, and it works only once both tags exist and the repository is public.

Pushing a tag starts no workflow (`publish-sdk.yml` is manual dispatch only; `ci.yml` runs on branch pushes and pull
requests).

## 7. LICENSE

Done (D747, decided by the founder 2026-11-13): the root [`LICENSE`](../LICENSE) is the Business Source License 1.1,
with Hana Tech Pty Ltd as the Licensor, an Additional Use Grant for test networks, the Change Date 2030-11-14 and the
Apache License 2.0 as the Change License. [`LICENSING.md`](../LICENSING.md) lists what is not under it: `@hana-id/web`,
`@hana-id/react` and `@hana-id/sodax` under Apache-2.0 (their own `LICENSE`), and third-party material. Still open:

- [x] `@hana-id/core`'s licence: it stays `BUSL-1.1` (decided by the user 2026-11-13, D747); its tarball carries the root `LICENSE`.
- [ ] Partners get the licences only from the next SDK release (0.4.2): the 0.4.1 tarballs say `UNLICENSED`.

## 8. The placeholders

`git grep -n "TODO(submit)" -- README.md docs/hackathon*.md` lists every one. On 2026-11-13:

| Where | What it needs |
|---|---|
| `README.md` "Tracks"; `docs/hackathon.md` "Tracks, against their prompts" | the tracks for the form |
| `docs/hackathon.md` rules table (Q-003, Q-012, Q-015, Procedures 1 and 2) and its tags section | the tags, the public repository, the video and the post, the check that nobody enters a second project |
| this page, step 1 | the secrets scan rerun after the last push |
| this page, steps 5 and 6 | the visibility flip, the tags |
| this page, step 11 | the final steps, in order: the deploy, the tags, the flip, the video, the post, the submission |
| `docs/hackathon-demo-script.md` | the recording, the X post (its repository link), the form's fields |

Also for the form, never written here: the project name, team lead, contact email, team size, the mainnet NEAR payout
account, the repository and post links, consent (HACKATHON.md "What the human decides").

## 9. The hosted demos through judging

- Keep both sites, <https://hana-id-stamps-sandbox-dev.tingtc.workers.dev> (the stamps demo, which the README and the
  video lead with) and <https://hana-id-demo-sandbox-dev.tingtc.workers.dev> (the broader hosted demo), Passport Home
  and every sandbox-dev Worker up until at least 2026-11-18, ideally 2026-11-25 (Q-012): no redeploy that renames or
  moves them in that time, no account move. They run on the personal Cloudflare account's free plans (D417), whose
  daily limits apply.
- **The stamps contract** `hana-id-stamps-dev1.testnet` (`near.demoStamps`) is deployed and **locked** (2026-11-13:
  zero access keys, code hash `9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA`, lock transaction
  `wUxYjzymRJ825xVs5zzr386LBfLocVsZz1fo1jAXDfU`). A redeploy, for example with a shorter Layover wait, needs a new
  account (`near.demoStamps` and `near.relay.receivers` in `envs/sandbox-dev.json`, then the API's `gen` and deploy and
  the stamps site's deploy, `docs/operations.md` "Hosted stamps demo"), and the README, `docs/hackathon.md`, this page
  and the demo script name the account and the 120-second wait.
- **Balances to watch** (read from a public RPC, 2026-11-13 evening; `near account view-account-summary <account>
  network-config testnet now`):

  | Account | Pays for | Held | Watch |
  |---|---|---|---|
  | `hana-id-near-relay-dev1.testnet` (the NEAR relay) | every relayed stamp and guestbook write, and each new account's activation | 29.78 NEAR | the admin's System status **NEAR relay** tile turns amber below `lowBalanceNear` 9; keep at least 18 (D793) |
  | `hana-id-relayer-dev1.testnet` (the login relayer) | every sign-in's `create_session_and_derive` | 19.39 NEAR | the watchdog's relayer funds checks (`docs/operations.md`) |
  | `hana-id-stamps-dev1.testnet` (the stamps contract) | its own storage, about 740 bytes at most per passport | 19.90 NEAR | new stamps fail with "The stamps contract is out of storage balance …" when it runs out; anyone can top it up, also after the lock |

- **How to top one up** (what the founder did on 2026-11-13): make a fresh named account that NEAR's faucet service
  funds with about 10 testnet NEAR, then send it on. Each run needs a new name.

  ```sh
  near account create-account sponsor-by-faucet-service <a new name>.testnet autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
  near tokens <that name>.testnet send-near <the account to top up> '9.9 NEAR' network-config testnet sign-with-legacy-keychain send
  ```

  NEAR's docs faucet, <https://docs.near.org/getting-started/faucet>, funds an implicit (64-hex) account with no login:
  that is how a judge gets testnet NEAR for the Own fare stamp; it can't fund the named accounts above.
- **Email codes** (judges' sign-in; Google is limited to listed testers). The judging week's limits (D793,
  `envs/sandbox-dev.json` `emailIssuer`, `apps/email-issuer/src/limits.ts`): the env's `dailySendBudget` 333 a day;
  Stamp Trail's share 200 a day (`appShares`); the hosted demo's app its plan's share, 100 on `free`; per IP address,
  10 sign-in starts per 10 minutes and 30 a day (`tighterLimits`; judges behind one shared address share them); per
  mailbox from one requester 5 codes per 15 minutes and 15 a day. Past the app's share, its sign-in answers 429
  (`send_budget_exhausted`, `app`) until 00:00 UTC. To raise it: `appShares` or `dailySendBudget` in the manifest,
  then the issuer's `gen` and deploy ("Judging week on sandbox-dev" in `docs/operations.md`); check SendGrid's plan
  first (D793: the budget is sized to 30% of a shared plan).
- **The NEAR relay's budgets** (D793, `near.relay`): 6 NEAR a day for the env, 3 NEAR a day per app, 50 relays a day
  per sender, 2,000 relays and 300 activations a day per app, 10,000 relays and 1,000 activations for the env, 200
  relays a minute. A relayed stamp costs about 0.0003 NEAR and an activation about 0.0071, so a Stamp Trail user who
  collects the five relayed stamps costs about 0.0086 NEAR: the app's 3 NEAR covers about 350 such users a day, and its
  300 activations a day bind first. Past a
  budget the relay answers `503 relay_budget_exhausted` until 00:00 UTC. Watch the admin's System status **NEAR
  relay** tile (Balance, Today's spend) and the `near_relay_balance_low` and `near_relay_budget_high` events. D793
  puts the four raised values back on 2026-11-26.
- A judge's login writes to the wallet directory and the usage ledger like any user's (`docs/architecture.md` "Data
  stores"); judges' email addresses end up in the email issuer's directory; postcard notes and guestbook messages are
  public on chain and permanent (both contracts are locked).

## 10. After it is public

- [ ] Open the repository logged out; check the README renders and its links work.
- [ ] Clone it fresh and run the README's "Reproduce it" part C, steps 1 and 2.
- [ ] Never commit the submission payload: it holds personal data (the event's rules say the same).

## 11. The order of the final steps

Each is the founder's or the team's act (`TODO(submit)`), before 2026-11-14T23:59:00Z, in this order:

1. Merge everything into `develop`; that commit is the submission commit.
2. The final full deploy from it, from the main checkout: `corepack pnpm verify --full` (D413), then every sandbox-dev
   piece whose code or manifest changed since its last deploy (`docs/operations.md` "What sandbox-dev runs"), both demo
   sites (`corepack pnpm --filter @hana-id/demo run deploy`; `HANA_STAMPS_PUBLISHABLE_KEY=pk_test_… corepack pnpm
   --filter @hana-id/stamps run deploy`) and `corepack pnpm --filter @hana-id/scripts run deploy-check sandbox-dev
   --d1`. A docs-only submission commit needs no deploy.
3. The tags (step 6): `pre-hackathon`, then `hackathon-submission` on the submission commit.
4. Step 1's secrets rerun, step 2's branch clean-up if wanted, step 5's settings, then the public flip.
5. The video ([`hackathon-demo-script.md`](hackathon-demo-script.md)), on the deployed sites.
6. The X post with the video attached and the public repository's link.
7. The one submission (`https://nearhackathon.com/#apply` or `POST https://nearhackathon.com/api/applications`): "One
   submission per project"; fixes after it go through `https://nearhackathon.com/request-changes`.
