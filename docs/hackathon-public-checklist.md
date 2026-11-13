# Before the repository goes public: a checklist

For the person who flips `Hana-Technology/hana-id` to public for the NEAR HACKATHON (deadline 2026-11-14T23:59:00Z).
The founder's plan (2026-11-13): public "towards the end, but not now" (D749). Nothing here was changed by the branch
that wrote it: each item is something to check, or a decision for the founder. Making the repository public, pushing
tags and adding a LICENSE are the founder's calls (the event's own agent rules say the same: never make a repository
public, push or post without the human's confirmation).

Last verified against code: 2026-11-13 (branch `docs/hackathon-submission`, docs only: the greps below run on
`develop` @ 35bc103e, the GitHub settings read with `gh` read-only, the relay balances read from a public RPC; the
secrets scan is a separate run, section 1).

## 1. Secrets in the full history

Once public, every commit on every pushed branch is readable, including branches never merged.

```sh
git fetch origin --prune
corepack pnpm secrets:scan                                   # the repo's own: gitleaks over HEAD's history
gitleaks git --no-banner --redact --config .gitleaks.toml --exit-code 1 --log-opts="--all" .   # every local and remote-tracking branch
```

Result for 2026-11-13: see the scan report. `TODO(submit): the secrets scan's outcome (the separate scan report),
and a rerun on the day after the last push.` `.gitleaks.toml` adds Journear's own key shapes to the default rules, and
`scripts/secret-scan-selftest.mjs` checks those rules catch a fake of each (`corepack pnpm verify` runs it).

## 2. Branches, pull requests and CI logs become public too

- `git ls-remote --heads origin | wc -l` printed 231 on 2026-11-13 (214 on 2026-11-11). Every one becomes public,
  merged or not. Decide whether to delete merged branches first (`gh pr list --state merged` shows which merged). All
  their commits are dated inside the window (2026-10-26 to 2026-11-12), so none has to go for the rules.
- 55 pull requests (titles, bodies, review comments) and the 376 GitHub Actions runs (their logs) become public with
  the repository. CI never had repository secrets (`gh secret list` is empty) or environments; skim a few run logs
  anyway.

## 3. Personal data found (listed, not changed)

Found by `git grep` on `develop` @ 35bc103e for email addresses, names, handles and local paths on 2026-11-13. Each is
a decision for the founder: keep, replace with a role address, or move out before going public. Git history keeps the
old text even after a change.

| Where | What |
|---|---|
| Every commit's author and committer (`git log --remotes=origin --format='%ae'`) | `amdcopper@gmail.com` (author of 1,183 of the 1,187 commits on GitHub's branches), `hello@ting.rocks` (author of 4), the name "Ting Tze Chuen" on all 1,187; committer `noreply@github.com` on 54 merges made on GitHub |
| `packages/email/scripts/gen-vectors.mjs:127`, `packages/email/vectors/email-v1.json:75`, `:76`, `:493` | `amdcopper+1@gmail.com`, a `+tag` form of the commit address, as a test vector |
| `envs/sandbox-dev.json:19` | `hello@ting.rocks` as the watchdog's alert address |
| `envs/sandbox-dev.json:124` | `hello@ting.rocks` and `mark@hanawallet.io` as the admin's staff emails |
| `envs/sandbox-dev.json:132` | `hello@ting.rocks` as the security alias |
| `docs/operations.md:274`, `:1724` | `hello@ting.rocks`; `hello@ting.rocks` and `mark@hanawallet.io` |
| `docs/context.md:427` | the personal domain `ting.rocks` (a deferred Cloudflare test) |
| `docs/identity-token-spec.md:118` | a local path with the home folder name (`/Users/tingtzechuen/…`) and the private repository name `wend-api` (also `docs/identity-token-spec.md:955`, `docs/decisions.md:1308`) |
| `.github/CODEOWNERS`, `docs/decisions.md:619` | the GitHub handles `@tzechuen` and `@mj-hana` |
| 35 files, 120 lines (`git grep -c tingtc`) | the Cloudflare workers.dev subdomain `tingtc` in every sandbox-dev URL (the personal Cloudflare account; the move is planned, `docs/operations.md` "Moving an env to another Cloudflare account") |
| `envs/sandbox-dev.json` (`watchdog.cloudflare.accountId`, `admin.accessTeamDomain`, `admin.accessAud`); `docs/operations.md` "What sandbox-dev runs" | the Cloudflare account id and the Access team and audience: identifiers, not secrets |
| `CLAUDE.md:8`, `docs/context.md:4`, `:5`, `:402`, `docs/batch-a-spec.md:4`, `docs/batch-b-spec.md:7`, `docs/batch-c-spec.md:17`, `docs/decisions.md:11451` | links to private claude.ai artifacts (the plan doc and others); they don't open for others |
| `apps/console/preview/fixtures.ts`, `apps/console/preview/mock-api.ts`, `apps/console/scripts/test/preview.test.ts:39` | made-up people at `soralabs.io`, which may be a real company's domain; the other fixtures use `.example` |
| Many tests | made-up `@gmail.com` addresses (`alice@gmail.com` and similar) as email-normalisation cases; generic, listed for completeness |

`team@hanawallet.io` (the sender of Journear's mail) and the `id-dev.hanawallet.io` names in tests and docs are the
company's, not personal. The commit email is the hardest to change: rewriting 1,187 commits changes every hash, breaks
every open branch and the links in the docs. GitHub can hide it for future commits ("Keep my email addresses
private"); it cannot hide it in existing ones.

## 4. Internal docs that describe open security items

These are written for the team and are candid about what is not done. Publishing them is a decision for the founder,
not a recommendation either way. Judges will read the code anyway, and the README already summarises the limits.

- `docs/security.md` "Known open issues" (the page-serving trust root, the 1-of-1 email signer, and others), "What a
  compromise gives", "The NEAR meta-transaction relay" (its abuse analysis) and the security sweep sections.
- `docs/system-overview.md` sections 4b to 4g and 5 ("Hard questions, honest answers").
- `docs/mainnet-readiness.md` (every open item before mainnet, the top blockers).
- `docs/playbooks.md` and `packages/playbooks` (step-by-step incident responses, which name the alerts the watchdog
  sends).
- `docs/decisions.md` (every decision, including rejected options and security review findings).
- `docs/operations.md` (runbooks, including who holds which key on sandbox-dev, and the relay's limits).

## 5. GitHub settings to check

Read on 2026-11-13 with `gh repo view` and `gh api` (read-only): visibility private, default branch `develop`, no
licence detected, no description, no topics, wiki on, issues on, projects on, discussions off; the ruleset "PR Required
Ruleset" (active, on branches); workflows CI and "Identity JWKS probe" disabled manually, "Publish SDK packages"
active (manual dispatch only); secret scanning, push protection and Dependabot security updates all off; no repository
secrets, no environments.

- [ ] Settings, General: visibility to public (Danger Zone), only when the founder says so (`TODO(submit)`).
- [ ] Settings, Code security: secret scanning and push protection on (free for public repositories); Dependabot
      alerts as the founder prefers; private vulnerability reporting on, or a `SECURITY.md` saying where to report.
- [ ] Settings, Actions: if CI is turned back on while public, "Require approval for all outside collaborators" for
      fork pull requests (`ci.yml` runs on `pull_request`), and keep `GITHUB_TOKEN` read-only by default.
- [ ] Settings, Rules: the ruleset still applies to `develop`; forks can't push.
- [ ] Wiki and Projects: turn off if unused, since they become public too.
- [ ] Deploy keys, webhooks, collaborators and installed apps: nothing unexpected.
- [ ] The repository description and topics: plain, no claims the README doesn't back.

## 6. Tags for the window (rule Q-003)

The rules offer "Dedicated branch, or tags pre-hackathon and hackathon-submission, plus a README section linking the
diff". The repository has no tags (`git ls-remote --tags origin` printed nothing on 2026-11-13). Which commits they go
on, and whether `pre-hackathon` is needed at all, depends on the baseline decision (D746, open): the options and the
exact commands are in [`hackathon.md`](hackathon.md) "Git tags the rules name". `TODO(submit)`: the founder creates
and pushes them after the last submission commit is on `develop`, then fixes or removes the README's link
`compare/pre-hackathon...hackathon-submission`. Pushing a tag starts no workflow (`publish-sdk.yml` is manual dispatch
only; `ci.yml` runs on branch pushes and pull requests).

## 7. LICENSE

The rules ask for a LICENSE file (Q-014). The founder has not chosen one (D747): `TODO(submit)`. Options:
[`hackathon-license-draft.md`](hackathon-license-draft.md). Add the chosen file at the root, and the matching
`license` field in the four SDK `package.json` files if they should agree.

## 8. The placeholders

`git grep -n "TODO(submit)" -- README.md docs/hackathon*.md` lists every one. On 2026-11-13:

| Where | What it needs |
|---|---|
| `README.md` "What was built in the hackathon window" | the baseline statement, after the rule check (D746) |
| `README.md` "What was built in the hackathon window" | the tags' diff link, or its removal (step 6) |
| `README.md` "AI tools and third-party code" | the licence (step 7) |
| `README.md` "Tracks" | the tracks for the form |
| `docs/hackathon.md` | the same items, in its rules table and its tags section |
| this page, step 1 | the secrets scan's outcome |
| this page, steps 5 to 7 | the visibility flip, the tags, the licence |
| `docs/hackathon-demo-script.md` | the recording, the X post (its repository link), the form's fields |
| `docs/hackathon-license-draft.md` | the licence choice and the legal entity's exact name |

Also for the form, never written here: the project name, team lead, contact email, team size, the mainnet NEAR payout
account, the repository and post links, consent (HACKATHON.md "What the human decides").

## 9. The hosted demo through judging

- Keep `https://hana-id-demo-sandbox-dev.tingtc.workers.dev`, Passport Home and every sandbox-dev Worker up until at
  least 2026-11-18, ideally 2026-11-25 (Q-012): no redeploy that renames or moves them in that time, no account move.
  They run on the personal Cloudflare account's free plans (D417), whose daily limits apply.
- **Email codes** (judges' sign-in; Google is limited to listed testers). The real limits, from
  `apps/email-issuer/src/limits.ts` and `envs/sandbox-dev.json`:
  - per app and UTC day, its share of the env's general pool: 2% of its plan's `per_day`, at least 10, so 100 on the
    `free` plan (`per_day` 5000, `apps/api/migrations/0001_init.sql`; the demo app's plan was not read here, check it in
    the admin);
  - the env's `emailIssuer.dailySendBudget`, 200: 1% (at least 5) for staff mail, the rest (195) shared by every app,
    of which the last 20% goes only to apps that have used less than half their share; returning devices with a
    device ticket draw on a separate owner pool of 30% (60); Passport Home's own codes have their own 6% plus 4% share;
  - per address (dev envs): 30 codes per 15 minutes and 200 a day; per IP 300 starts a day; per recipient domain 100
    codes a day unless the provider is exempt.
  Past the app's share, its sign-in answers 429 (`send_budget_exhausted`, `app`) until 00:00 UTC. To raise it: a larger
  `dailySendBudget` (`gen`, deploy the issuer) or the app on a plan with a larger `per_day`; check SendGrid's own plan
  limit before raising either.
- **The NEAR relay** (the gasless guestbook write). Its account `hana-id-near-relay-dev1.testnet` held 9.99 NEAR on
  2026-11-13; `docs/operations.md` "NEAR relay" says to fund at least `inFlightNear` + `lowBalanceNear` +
  `dailyBudgetNear` (3 + 2 + 5 = 10) and keep about 15: top it up before judging. Daily limits
  (`envs/sandbox-dev.json` `near.relay`): 5 NEAR for the env, 1 NEAR per app, 50 relays per sender, 2,000 relays and
  200 activations per app, 10,000 relays and 1,000 activations for the env, 200 relays a minute. A message costs about
  0.0002 NEAR and an activation about 0.0071 NEAR, so the app's 1 NEAR is about 140 new users who each write once.
  Past a budget the relay answers `503 relay_budget_exhausted` until 00:00 UTC. Watch the admin's System status
  **NEAR relay** tile and the `near_relay_balance_low` and `near_relay_budget_high` events.
- **Logins**: the relayer `hana-id-relayer-dev1.testnet` held 9.50 NEAR on 2026-11-13, its three login keys about
  1.97 NEAR of allowance each and the Passport Home key about 4.99; the watchdog's relayer funds checks warn when they
  run low (`docs/operations.md`).
- A judge's login writes to the wallet directory and the usage ledger like any user's (`docs/architecture.md` "Data
  stores"); judges' email addresses end up in the email issuer's directory; guestbook messages are public on chain and
  permanent (the guestbook is locked).

## 10. After it is public

- [ ] Open the repository logged out; check the README renders and its links work.
- [ ] Clone it fresh and run the README's "Reproduce it" part C, steps 1 and 2.
- [ ] Never commit the submission payload: it holds personal data (the event's rules say the same).
