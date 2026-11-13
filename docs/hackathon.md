# NEAR HACKATHON submission: the detail

The root [`README.md`](../README.md) has the short version for judges and screening agents ("For judges and screening
agents"). This page holds the rest: the event's rules as read on 2026-11-13 and where each is met, the git tags the
rules name and their commands, the baseline as the README states it and why (D746), the other chains, the full list of
third-party code, the AI use, the tracks against their prompts, and what the submission cannot meet yet.
`TODO(submit)` marks what the team does before submitting; `hackathon-public-checklist.md` step 8 lists them all.

Last verified against code: 2026-11-13 (branch `docs/hackathon-stamps`, docs only, against `develop` @ 2cd30973 (83ac508c, merged with PR 62): the
write-up now leads with the NEAR-only stamps demo (the new "The hosted demos" section, the rules table's Q-011 and
Q-012 rows, the risks, the counts and the baseline's commit count, the stamps contract in "What is judged", the
libraries, the tracks and what can't be met; the stamps contract's views, keys and transactions read from public
RPCs the same day; the rules not re-read, no claim here depends on a change); 2026-11-13 (branch
`docs/hackathon-submission`, docs only, against `develop` @ 35bc103e,
sandbox-dev running `develop` 1ac3bc36, and the event's live `https://nearhackathon.com/HACKATHON.md`, its home page
and the three track prompts read the same day); 2026-11-13 (same branch: the licence chosen, the baseline stated and
measured with `git blame`, the tags decided: D746, D747).

Related: the video's shot list and post texts, [`hackathon-demo-script.md`](hackathon-demo-script.md); what to check
before the repository goes public, [`hackathon-public-checklist.md`](hackathon-public-checklist.md); the licences,
[`../LICENSE`](../LICENSE) and [`../LICENSING.md`](../LICENSING.md) (why: D747).

## The event, as its pages say (read 2026-11-13)

Sources: `https://nearhackathon.com/HACKATHON.md` (the organisers' instructions for coding agents; it says "read it
again before submitting, because dates and rules may change"), the home page `https://nearhackathon.com` (its
timeline, submission form and "Questions? Start here"), and the track prompts in
`github.com/nearai/near-hackathon-prompt-examples` (`tracks/08-realworld.md`, `09-games.md`, `13-open.md`). All three
answered on 2026-11-13. The page `https://nearhackathon.com/request-changes` is a form, not rules.

| Fact | Value (quoted where it matters) |
|---|---|
| Hackathon starts | 2026-11-01T00:00:00Z; code counts "from the announcement on 2026-10-19" (Q-001) |
| Development ends, submission deadline | 2026-11-14T23:59:00Z. "Make the repository public before development ends" |
| Judging | starts 2026-11-16T00:00:00Z; "Results announced by" 2026-11-18T23:59:00Z |
| Screening | Q-017: "Screening, not deciding: reproducibility check, feature verification, structured report, preliminary score. Humans decide; low AI score alone cannot reject." Home page: Claude Code and Codex "check that it runs and does what the README says"; "Previous NEAR hackathons evaluated technical implementation, design, impact, originality and sustainability — a good guide to prepare by." |
| How to write the README | "write the README for a machine reader as well as a human one: what the product is, the problem it solves, and how to try it as "do X - see Y" steps a judge can follow. No marketing." |
| Submission | once only: "One submission per project", `POST https://nearhackathon.com/api/applications` or the form at `https://nearhackathon.com/#apply`; "A second submission of the same repository is rejected"; fixes through `https://nearhackathon.com/request-changes`. Submissions are accepted only 2026-11-01T00:00:00Z to 2026-11-14T23:59:00Z |
| What the team decides (never filled in by an agent) | project name, team lead, contact email, team size, tracks ("every track the project fits"), a mainnet NEAR account for the payout, the public repository link ("Each repository can be submitted only once"), the demo post link, "What they built (20-2000 characters): the problem, the product, and how NEAR fits in", consent to the contact notice |
| Demo post | on X: "it says the project was built at NEAR HACKATHON, tags @NEARProtocol and #NEARHackathon (optionally also @NearLegion and @NearBuilders), and has the demo video or screenshots attached"; the home page: "Both are required" (the repository link and the demo post link) |
| Hosted demo | Q-012: "Hosted demo is a plus; keep it up to 2026-11-18, ideally 2026-11-25" |
| Prizes | $250,000: one grand prize, 1st to 3rd in each of the 13 tracks, paid in NEAR to the submitted account, "within 30 days of results" (Q-016) |

## Each rule, and where the submission meets it

| Rule | The wording that matters | Where this repository answers it | State on 2026-11-13 |
|---|---|---|---|
| Q-001 | "Yes, from the announcement on 2026-10-19 … The window runs from then to 2026-11-14. Earlier commits are baseline." | README "What was built in the hackathon window"; [Baseline](#baseline-what-is-stated-and-why) below | Met: first commit 2026-10-26, none earlier on any branch; the README states what that commit imports and treats it as baseline (D746) |
| Q-002 | "Existing product on another chain? Allowed. Only the NEAR integration built in the window is judged. Disclose in README." | README "What is judged, and the other chains"; [Other chains](#other-chains) | Met: the whole repository is submitted, NEAR is the judged integration, Stellar, EVM and Sodax disclosed (D748) |
| Q-003 | "New repo required? No. Dedicated branch, or tags pre-hackathon and hackathon-submission, plus a README section linking the diff." | README "What was built in the hackathon window": the link `compare/pre-hackathon...hackathon-submission`; [Git tags](#git-tags-the-rules-name) | Met once the founder pushes the two tags: `pre-hackathon` on `e0c831fc`, `hackathon-submission` on the final submitted commit (decided 2026-11-13, D746); `TODO(submit)` in the checklist, step 6 |
| Q-004 | "Old project as-is: no. New feature in the window: yes, if separated per Q-003. No minimum code size." | as Q-003 | Met once the tags are pushed: the baseline commit is separated from the window's work by them |
| Q-005 | "All allowed, including own pre-hackathon libs and AI code. List in README; own old libs count as baseline." | README "AI tools and third-party code" (AI, the libraries, our own earlier code); [Third-party code](#third-party-code), [AI tools](#ai-tools), [Baseline](#baseline-what-is-stated-and-why) | Met |
| Q-010 | "Testnet-only projects eligible? Yes, all tracks." | everything here is testnet | Met |
| Q-011 | "Mandatory integrations? None. Hints are hints. Own contract on NEAR that fits the track is enough." | `contracts/hana-signer`, `contracts/hana-stamps`, `contracts/hana-guestbook` | Met |
| Q-012 | "Local-only demo OK? Yes: public repo, reproducible README, X post with a video; screenshots are not enough when judges cannot open the demo. Hosted demo is a plus; keep it up to 2026-11-18, ideally 2026-11-25." | README "Reproduce it" (A the stamps site with its view calls, B the hosted demo with its view calls, C local); [The hosted demos](#the-hosted-demos) below; [`hackathon-demo-script.md`](hackathon-demo-script.md) | Reproducible README: in. Public repo: `TODO(submit)` (flipped near the end, D749). Video and X post: `TODO(submit)` (a colleague records it, on the stamps site). Demo uptime: checklist step 9 |
| Q-013 | "Team keeps all rights; organizers get non-exclusive promo rights to name, screenshots, video, repo link." | `LICENSE`, `LICENSING.md` | Information: the Business Source License keeps the licensor's rights and grants no trademark right |
| Q-014 | "License? Any. MIT is fine. Repo stays public through judging; add a LICENSE file." | `LICENSE` (Business Source License 1.1), `LICENSING.md` (the SDK packages under Apache-2.0, third-party material), README "AI tools and third-party code" | Met: decided by the founder 2026-11-13 (D747) |
| Q-015 | "Allowed if projects are independent and disclosed: each README names the other project. Not the same project twice. One person, at most 2 different projects." | not applicable: nobody on the team enters another project (the founder, 2026-11-13) | Met |
| Q-017 | as in the table above | README "For judges and screening agents" | The README is written for it: claims with files and checks, "do X, see Y" steps |
| Procedure 1 | "it must be public by 2026-11-14T23:59:00Z. Judges cannot open a private one." | | `TODO(submit)`: the repository is private (checked 2026-11-13 with `gh repo view`) |
| Procedure 2 | the X post's four tips: lead with the user problem, "Show one complete moment", "Explain NEAR’s role concretely … Avoid a vague "powered by NEAR"", "Link the demo and public repo, and ask a genuine question" | [`hackathon-demo-script.md`](hackathon-demo-script.md) | Drafts in; posting `TODO(submit)` |

Q-000 (NEAR AI credits), Q-006 (1Click JWT), Q-007 (no Intents testnet), Q-008 (test funds), Q-009 (public RPCs) and
Q-016 (payout) don't change anything here.

### What changed since the table of 2026-11-11, and what is ambiguous

- **No rule change found.** The dates, Q-001 to Q-017's answers and the submission fields read the same as the
  2026-11-11 table summarised them. That table paraphrased instead of quoting, so a change of wording can't be ruled
  out; the quotes above are from 2026-11-13. Not in the old table: Q-012's "screenshots are not enough when judges
  cannot open the demo", Q-015's "One person, at most 2 different projects", the home page's judging criteria
  (technical implementation, design, impact, originality, sustainability) and Q-013's rights.
- **Ambiguous: the tags when no commit predates the window.** Q-003 names the tags `pre-hackathon` and
  `hackathon-submission` but not their commits, and every commit here is dated inside the window. Q-003 is the answer
  to "New repo required?", and Q-004 applies it to an "old project", so a repository started in the window may need
  neither; the rules don't say. Decided 2026-11-13 (D746): both tags, `pre-hackathon` on the first commit, which holds
  the baseline, and `hackathon-submission` on the submitted one.
- **Ambiguous: code imported by an in-window commit.** Q-001 calls "earlier commits" baseline and Q-005 says "own old
  libs count as baseline"; neither says how to count a commit made in the window that brings in code written before it.
  Decided 2026-11-13 (D746): the README states that the first commit imports our earlier proof of concept and treats
  it as baseline under Q-005.
- **Ambiguous: video or screenshots.** The procedure and the home page accept "the demo video or screenshots"; Q-012
  says "X post with a video" and that screenshots are not enough when judges can't open the demo. Judges can open
  this one, but a video is the safe reading, and one is planned.
- **"Only the NEAR integration built in the window is judged."** Submitting the whole repository is fine; the judged
  part is the NEAR integration (D748). The Stellar and EVM wallets share the NEAR-checked sign-in and the CKD secret,
  which the README states rather than counting them as NEAR work.

### What could put the entry at risk

1. The repository is still private, and the deadline is 2026-11-14T23:59:00Z ("Judges cannot open a private one").
2. No X post or video yet; the home page says both links are required.
3. The tags are not pushed yet, so the README's diff link opens only once both exist.
4. Once public, the history, the 241 branches (2026-11-13 evening; 238 merged, checklist step 2), the 61 pull
   requests and the 376 Actions runs are public, with the personal data and internal security notes listed in
   [`hackathon-public-checklist.md`](hackathon-public-checklist.md).
5. Both demo sites run on a personal Cloudflare account on free plans (D417). The judging week's limits (D793): 333
   code emails a day for the environment, 200 of them for Stamp Trail and 100 for the hosted demo's app; 10 sign-in
   starts per IP address per 10 minutes and 30 a day; a NEAR relay budget of 3 NEAR a day per app and 6 for the
   environment. Many judges on one day, or behind one address, can reach them (checklist step 9). Google sign-in works
   only for listed testers.
6. A screening agent that runs `corepack pnpm verify --all` needs Rust 1.85.1, `cargo-near` 0.22.0, gitleaks and
   Playwright's browsers, downloads `near-sandbox` and Cargo's crates on first use, and takes about 15 minutes on a fast
   machine (15m19s on 2026-11-13 in a fresh worktree, the Rust targets built from scratch); the README says so. A README claim that doesn't hold in that run is the main screening risk.
7. The stamps contract pays for its own storage (about 19.9 NEAR on 2026-11-13) and anyone can fill it at about the
   same cost to themselves; once it runs out new stamps fail until someone tops it up (checklist step 9).

## The hosted demos

Q-012: "Hosted demo is a plus; keep it up to 2026-11-18, ideally 2026-11-25." Both stay up through 2026-11-25
(checklist step 9); the README and the video lead with the first.

| | The stamps site (NEAR only) | The hosted demo (every chain) |
|---|---|---|
| URL | <https://hana-id-stamps-sandbox-dev.tingtc.workers.dev> | <https://hana-id-demo-sandbox-dev.tingtc.workers.dev> |
| Code | `apps/stamps` (D798–D807); its app is Stamp Trail | `apps/demo` |
| Contract | `contracts/hana-stamps` at `near.demoStamps` (`hana-id-stamps-dev1.testnet`), deployed and locked 2026-11-13: zero access keys, code hash `9pjHDkQQ5j37cU8kiVcnebh22788f6vAkS5JAY1pSNvA`, lock transaction `wUxYjzymRJ825xVs5zzr386LBfLocVsZz1fo1jAXDfU`; about 19.9 NEAR for its storage | `contracts/hana-guestbook` at `near.demoGuestbook`, locked 2026-11-12 |
| What a judge does | sign in by email, six stamps: five relayed with zero NEAR (Arrival, Fare paid, Signature with a NEP-413 message verified on chain, Postcard, Layover after 120 s of block time), one paid with testnet NEAR from NEAR's docs faucet (Own fare); a public passport page and a recent-stamps feed read from chain | sign in by email; a gasless guestbook write; a NEP-413 signature; a signed transaction; the Stellar and EVM addresses; the key export from Passport Home |
| Checked on testnet | the founder's hand-checked run of all six stamps, 2026-11-13 (the account `cceaf5d3…` and its transactions, README "Reproduce it" A) | the founder's run of 2026-11-12 (README "Reproduce it" B) |

The founder decided on 2026-11-13 to keep the locked contract as it is, with its 120-second Layover wait. A redeploy
would have to go to a new account, since the locked one can't change: `near.demoStamps` and `near.relay.receivers` in `envs/sandbox-dev.json`, the API's `gen` and
deploy, the site's deploy (`docs/operations.md` "Hosted stamps demo"), and the account and the wait as the README, this
page, the checklist and the demo script state them.

## Git tags the rules name

Q-003 offers "Dedicated branch, or tags pre-hackathon and hackathon-submission, plus a README section linking the
diff". Decided by the founder 2026-11-13 (D746): both tags, as Q-003 names them. The repository has no tags today
(`git ls-remote --tags origin` printed nothing on 2026-11-13). The founder creates and pushes them; this branch
creates none (`TODO(submit)`, checklist step 6).

- **`pre-hackathon`** on `e0c831fc`, the first commit, which holds the baseline ([Baseline](#baseline-what-is-stated-and-why)).
  It can be pushed at any time.
- **`hackathon-submission`** on the final submitted commit of `develop`. It goes on last: after everything is merged,
  just before the repository goes public. If anything changes on `develop` after that, the tag moves to the new final
  commit.

The README links `https://github.com/Hana-Technology/hana-id/compare/pre-hackathon...hackathon-submission`, which
opens only once both tags exist (and the repository is public). Commands, from a clone with `origin` =
`Hana-Technology/hana-id` (the ruleset "PR Required Ruleset" targets branches, not tags, and pushing a tag starts no
workflow: `publish-sdk.yml` is manual dispatch only, `ci.yml` runs on branch pushes and pull requests):

```sh
git fetch origin
# 1. The baseline tag, on the first commit
git tag -a pre-hackathon e0c831fc -m "Baseline: the wend-widget-demo proof of concept the first commit imports (NEAR HACKATHON Q-003, Q-005)"
git push origin pre-hackathon

# 2. Last, after everything is merged: the submission tag, on the final commit of develop
git log -1 --format='%H %ad %s' origin/develop          # check it is the commit to submit
git tag -a hackathon-submission origin/develop -m "NEAR HACKATHON submission"
git push origin hackathon-submission
git ls-remote --tags origin                               # both are there

# If develop changes after that: move the submission tag to the new final commit
git fetch origin
git tag -f -a hackathon-submission origin/develop -m "NEAR HACKATHON submission"
git push origin --force refs/tags/hackathon-submission
```

A moved tag changes what the compare link shows; anyone who fetched the old tag keeps it until they fetch with
`--force` or `--tags --force`.

## Baseline: what is stated and why

Decided by the founder 2026-11-13 (D746): the README states the baseline. Its wording, in "What was built in the
hackathon window":

> The first commit, `e0c831fc` (2026-10-26), started this repository from our earlier proof of concept,
> wend-widget-demo: a first version of the `hana-signer` contract and the reference code in `legacy/`, with three docs
> and config files (`git show --stat e0c831fc`). Per Q-005 that is baseline. Everything else, in at least 1,216
> further commits, was built in the window: the per-app scope registry, the API, the SDK, email login, the consoles,
> Passport Home and all of the NEAR wallet work. Of today's 4,337 lines of `hana-signer` contract code (tests and
> fixtures excluded), 124 still date from that first commit by `git blame`.

Why: every commit is dated inside the window, but the first one brings in code written before the announcement. Q-005
counts "own old libs" as baseline and asks to list them, so the README says what it is, how much of it is left, and
how to check.

The facts behind it (from `git`, on `develop` @ 2cd30973 unless a line says 35bc103e; `contracts/hana-signer/src`
and `legacy/` are the same at both):

- The first commit is `e0c831fc` (2026-10-26 13:43:21 +08:00): "chore: scaffold hana-id from wend-widget-demo PoC
  (contract, legacy client/relayer, docs)", 28 files, 4,609 lines: 12 files in `legacy/`, 9 in `contracts/`, 3 docs,
  and 4 config files (`.gitignore`, `CLAUDE.md`, `package.json`, `pnpm-workspace.yaml`). It is the team's own proof of
  concept, measured before the announcement (`docs/hana-embed-ckd-results.md`: "Measured 2026-10-14 on NEAR testnet").
  - `legacy/client` and `legacy/relayer` (955 lines) are unchanged since: `git diff --stat e0c831fc develop -- legacy`
    prints nothing, and `CLAUDE.md` makes `legacy/` read-only reference code.
  - The first contract was `contracts/hana-signer/src/lib.rs` (754 lines) and `src/google.rs` (85 lines), with
    `Cargo.toml`, `Cargo.lock`, `rust-toolchain.toml`, `.cargo/config.toml`, a test fixture, `deploy.sh` and
    `post-google-keys.sh`. The two scripts were deleted later, and `google.rs` became `src/oidc.rs` in the next commit,
    `eb5eb658`. `git diff --numstat e0c831fc develop -- contracts/hana-signer/src/lib.rs` shows 486 lines added and 677
    of its 754 removed. The contract's other modules are new.
  - The three docs are `docs/batch-a-spec.md`, `docs/context.md` and `docs/hana-embed-ckd-results.md`.
- How much of the first commit survives, by `git blame` (a line counts for the commit that last changed it; the
  `hana-signer` rows hold on 2cd30973, whose `contracts/hana-signer/src` is unchanged since 35bc103e; the whole-tree
  rows were measured on 35bc103e and grow with every new file):

  | Scope on `develop` | Lines from `e0c831fc` | Of | Share |
  |---|---|---|---|
  | `hana-signer`'s contract code: `src/*.rs` without the tests and fixtures | 124 (52 in `lib.rs`, 72 in `oidc.rs`) | 4,337 | 2.9% |
  | the same, with `git blame -M -C -C` (also counts lines moved or copied from other files) | 201 | 4,337 | 4.6% |
  | all of `contracts/hana-signer/src`, tests and fixtures included | 126 | 12,728 | 1.0% |
  | the whole tree outside `legacy/`, lockfiles excluded | 531 | 368,520 | 0.14% |
  | the whole tree outside `legacy/`, lockfiles included | 2,809 | 388,600 | 0.72% (2,278 of them in `contracts/hana-signer/Cargo.lock`) |

  Binary files (fonts, images) are left out. To recount one file:

  ```sh
  E=$(git rev-parse e0c831fc)
  git blame --line-porcelain develop -- contracts/hana-signer/src/lib.rs | grep -E '^[0-9a-f]{40} ' \
    | awk -v E=$E '{t++; if ($1 == E) e++} END {print e+0, "of", t}'
  ```

- Later code that started as a port of the baseline says so in its first lines: `packages/core/src/ckd.ts` (from
  `legacy/client/ckd.ts`, itself a port of `near/mpc` at `a7ae426`), `apps/api/src/near/rpc.ts` and
  `apps/api/src/near/tx.ts` (from `legacy/relayer/embed-relayer.ts`).
- Everything after `e0c831fc`: 1,216 commits on `develop` (1,222 on all the branches on GitHub), dated 2026-10-26 to
  2026-11-13. `git diff --shortstat e0c831fc develop` prints "1681 files changed, 401871 insertions(+), 897
  deletions(-)" (the lockfile and generated test vectors included).
- Commits per day on `develop` (`git log --format=%ad --date=short develop | sort | uniq -c`): 10-26 11, 10-27 19,
  10-28 136, 10-29 107, 10-30 76, 11-02 116, 11-03 24, 11-04 133, 11-05 84, 11-06 88, 11-09 99, 11-10 92, 11-11 116,
  11-12 80, 11-13 36 (by the commits' own +08:00 dates).

## Other chains

Disclosed under Q-002. They are in the submitted repository and were built in the same window; they are not NEAR
integrations, so they are not what is judged (D748):

- **Stellar**: each user gets a Stellar account from the same CKD secret (`packages/core/src/derivation.ts`,
  `stellarSeed`); signing of Stellar transactions, auth entries and SEP-53 messages; Stellar Wallets Kit support in
  `packages/web`. Test apps sign for Stellar testnet only.
- **EVM**: each user gets an EVM account (`evmPrivateKey`); an EIP-1193 provider, EIP-712 typed data and transaction
  decoding (`packages/core/src/decode`, `viem`). Test apps sign for the EVM testnets in `TEST_EVM_CHAINS`
  (`packages/core/src/networks.ts`).
- **Sodax**: `packages/sodax`, wallet-provider adapters for Sodax's cross-chain SDK. Sodax runs on mainnet only, so a
  test app can build Sodax intents but not sign them, apart from the staff-only mainnet demo (`docs/decisions.md`
  D428). A separate sample partner app (its own repository) uses it; it is not part of this submission.

What is judged is the NEAR part: the `hana-signer` contract (on-chain RS256 checks of Google's and the email issuer's
tokens, the per-app scope registry, sessions, the CKD request to NEAR's MPC, governance by a Sputnik DAO council with
public delays and a watchdog), the browser's CKD decryption, the NEAR wallet (derivation, the implicit account, signing
of transactions, NEP-366 delegate actions and NEP-413 messages behind the approval window; SDK 0.4.1's `hana.near.*`),
the meta-transaction relay (`POST /v1/near/activate`, `POST /v1/near/relay`), the wallet directory's NEAR rows, the
stamps contract and its NEAR-only site, the guestbook contract, the demo's NEAR card, Passport Home's NEAR key in "Move
this wallet" and the admin's NEAR relay tile.

## Third-party code

Versions as pinned on 2026-11-13 (the `package.json` and `Cargo.toml` files; the lockfiles have the exact tree).

### Rust

| Crate | Version | Used in | For |
|---|---|---|---|
| `near-sdk` | 5.9 | `contracts/hana-signer`, `contracts/hana-stamps`, `contracts/hana-guestbook`, `contracts/mock-mpc` | the contract framework (`env::ed25519_verify` for the stamps' NEP-413 check) |
| `num-bigint` | 0.4 | `contracts/hana-signer` | RSA modular exponentiation in `oidc.rs` `verify_rs256` |
| `borsh`, `serde`, `schemars`, `base64` | 1.3, 1, 0.8, 0.22 | the contracts | state and JSON encoding |
| `near-workspaces` | =0.23.0 | `contracts/integration-tests` | starts a local `near-sandbox` node per test |
| `near-primitives`, `near-crypto`, `near-jsonrpc-client` | 0.37, 0.37, 0.22 | `contracts/integration-tests` | delegate actions and RPC calls in the sandbox tests |
| `rsa`, `sha2`, `ed25519-dalek`, `tokio`, `anyhow`, `rand` | 0.9, 0.10, 2, 1, 1, 0.8 | `contracts/integration-tests` (`ed25519-dalek` also in the contract's unit tests) | test tokens and session keys |
| Sputnik DAO v2 wasm | 3.31, commit `7764926c` | `contracts/sputnik/pin.json` (downloaded by the sandbox tests, sha256 checked) | the owner council's code, as `sputnikv2.testnet` deploys it |

### JavaScript and TypeScript

| Package | Version | Used in | For |
|---|---|---|---|
| `@noble/curves` | 1.9.7 | `packages/core`, `packages/web`, `apps/api`, `apps/e2e`, `apps/smoke` | BLS12-381 (CKD), Ed25519, secp256k1 |
| `@noble/hashes` | 1.8.0 | `packages/core`, `apps/email-issuer` | HKDF, SHA-2, SHA-3 |
| `@scure/base` | 1.2.6 | `packages/core`, `packages/web`, `apps/demo`, `apps/stamps`, `apps/e2e`, `apps/smoke` | base58, base64 |
| `@near-js/crypto`, `@near-js/transactions`, `@near-js/utils` | 2.5.1 | `apps/api`, `apps/watchdog`, `scripts`; `packages/core`'s tests | relayer and owner transactions; the reference the NEAR codec is tested against |
| `@stellar/stellar-base` | 15.0.0 | `packages/core`, `packages/web`, `packages/sodax` | Stellar transactions and addresses |
| `viem` | 2.57.7 | `packages/core`, `apps/e2e` | EVM encoding and decoding |
| `@sodax/types` | 2.2.0 | `packages/sodax` | Sodax adapter types |
| `zod` | 4.6.6 | `packages/env`, `packages/console-core`, `apps/console` | manifest and request schemas |
| `jose` | 6.2.13 | `examples/identity-verify`, `apps/e2e` | verifying the identity token |
| `tldts`, `tr46` | 7.4.18, 7.0.0 | `packages/env`, `packages/email`, `apps/email-issuer` | domain parsing, IDNA |
| `aws4fetch` | 1.0.20 | `apps/api`, `apps/email-issuer` | the AWS KMS signer (built, unused on testnet) |
| `pg`, `@electric-sql/pglite` | 8.23.1, 0.5.11 | `apps/api`, `apps/admin`, `scripts` | the Neon usage ledger; PGlite in tests |
| `pdf-lib` | 1.17.1 | `apps/admin` | statements |
| `react`, `react-dom`, `react-router-dom` | 18.3 / 19.3, 6.30.6 | `packages/react`, `apps/console` | React bindings, the partner console |
| `wrangler`, `@cloudflare/vitest-plugin`, `@cloudflare/workers-types` | 4.151.1, 1.4.4, 5.20261016.1 | every `apps/*` Worker | Cloudflare Workers, Durable Objects, D1, R2 |
| `@playwright/test` | 1.64.1 | `apps/e2e` | browser tests |
| `@wagmi/core`, Stellar Wallets Kit 1.9.5 and 2.7.1 | 3.6.5 | `apps/e2e` | partner-library compatibility tests |
| `vitest`, `happy-dom`, `fake-indexeddb` | 4.1.12, 21.0.3, 6.2.5 | tests | unit tests |
| `vite`, `esbuild`, `tsx`, `typescript` | 7.3.7, 0.28.2, 4.23.15, 5.9.3 | builds | bundling, running TypeScript |

### Fonts, data and services

- Archivo, IBM Plex Sans and IBM Plex Mono (SIL Open Font License; Fontsource 5.3.0, Latin subset), self-hosted:
  `packages/brand/fonts/` with `OFL-Archivo.txt`, `OFL-IBMPlexSans.txt`, `OFL-IBMPlexMono.txt`.
- The disposable-domain list from `disposable-email-domains/disposable-email-domains`, pinned
  (`packages/email/README.md`).
- Services: NEAR testnet and its MPC network (`v1.signer-prod.testnet`), the Sputnik DAO v2 factory
  (`sputnikv2.testnet`), public NEAR RPCs (FastNEAR `test.rpc.fastnear.com`, `rpc.testnet.near.org`, dRPC; the
  archival RPC and NearBlocks for the checks in the README), NEAR's docs faucet
  (`docs.near.org/getting-started/faucet`, linked by the stamps site for Own fare; a third-party page), Google OAuth, Cloudflare (Workers, D1, R2, Access), Neon
  Postgres, SendGrid, CoinGecko (the mainnet demo's prices).

## AI tools

This repository is built with AI coding agents. The developer directed Claude Code (Anthropic's coding agent)
sessions in conversation and reviewed their work; the agents wrote the code, the tests and the docs, and `CLAUDE.md`
holds their project rules. On 2026-11-13, 120 of the 1,217 commits on `develop` carried a `Co-Authored-By: Claude …`
trailer (`git log -i --grep='Co-Authored-By: Claude' --oneline develop | wc -l`); the others were made the same way
without one. Treat the code as AI-written throughout. This write-up was drafted the same way.

## Tracks, against their prompts

The prompts are in `github.com/nearai/near-hackathon-prompt-examples` (read 2026-11-13). HACKATHON.md: the hints
"are hints and wishes, not requirements" (Q-011), and a project lists "every track the project fits". Which tracks go
in the form is chosen by the colleague who submits, `TODO(submit)`.

### Real-World Money (`realworld`)

Hints: "STABLECOINS, NEAR INTENTS, META TRANSACTIONS". The prompt's example is crypto invoicing; its requirements
include "Gasless for the freelancer: route their transactions through a meta transaction relayer that only pays for
calls to our own contract" and "Status updates the freelancer can trust: paid, pending or refunded, with links to the
transactions".

- Shown: a user signs in with an email code, gets a NEAR account holding no NEAR, and collects five stamps (or writes
  a guestbook message) as NEP-366 delegate actions; Journear's relay (`apps/api/src/near/relay.ts`) wraps and pays for
  them, and relays only to the allowlisted contracts (`apps/api/src/near/delegate.ts` `policyRefusal`; sandbox-dev's
  `near.relay.receivers` are the stamps contract and the guestbook); the contract itself checks that a Fare paid stamp
  was signed by someone other than the caller; each stamp and write links to NearBlocks, and a relay that timed out
  after sending says "Sent, still confirming" with its link (D788). Own fare shows the same account paying its own fee
  once it holds testnet NEAR.
- Not shown: stablecoins on NEAR, NEAR Intents (Q-007: no Intents testnet), invoices, payroll, refunds, CSV export;
  testnet only. Own fare's testnet NEAR comes from a third-party faucet page. The Stellar and EVM wallets can hold
  test USDC, but those are not NEAR.

### Games With Real Economies (`games`)

Hints: "AGENT NPCS, SOCIAL LOGIN, NEAR INTENTS, NEP-245"; judged "on the game loop, not the token". The prompt's
requirements include "Players sign in with a social or email login. No seed phrases, no wallet popups, no gas prompts
in the normal game loop."

- Shown: email or Google sign-in, no seed phrase, no extension, no NEAR and no gas prompt for the first NEAR action;
  the stamps are a small progression whose rules a contract enforces (Arrival first, each stamp once, a block-time
  wait, a public note, a signature checked on chain), five of six with no NEAR.
- Not met: "no wallet popups". Every stamp opens Journear's approval window and needs Approve (Signature twice, in
  one window); the auto-approve rules a partner can offer (`docs/architecture.md` "Signing: approval popup vs
  auto-approve") exist for Stellar and EVM only. There is no game, game loop, economy, NPC or NEP-245 token here:
  Journear Passport is the login and wallet layer a game would use.

### Open Innovation (`open`)

Hints: "EXPERIMENTAL, CHAIN ABSTRACTION, BUILD YOUR OWN". The example prompt asks that the rules "live in a contract
and anyone can read them" and for "a README section on failure cases".

- Shown: the decision "this person may have this key" is made by a public NEAR contract that checks Google's or the
  email issuer's signature itself (anyone can read its issuers and scopes, README "Reproduce it" B); the key comes from
  NEAR's MPC encrypted to the browser; one sign-in gives wallets on NEAR, Stellar and EVM. The stamps' rules live in a
  locked contract with no owner that anyone can read and call (README "Reproduce it" A), and it verifies a NEP-413
  signature on chain.
- Failure cases are written down: `docs/system-overview.md` sections 4b to 4g and 5 ("Hard questions, honest
  answers"), `docs/security.md` "What a compromise gives" and "Known open issues", `docs/playbooks.md` (a recovery
  playbook per alert and incident), `contracts/hana-stamps/README.md` "Storage and what an attacker can cost it", and
  the README's "Security and limits".

### Considered, not proposed

- `privacy` (hints "PRIVATE AI, TEE, NEAR AI CLOUD"): CKD keeps the key from Journear's servers, but there is no TEE or
  private AI here.
- `security` (hints "AGENT SECURITY, FUNCTION CALL KEYS, TEE ATTESTATION"): logins are paid with function-call keys and
  the approval window guards every signature, but the track is about giving AI agents money.
- `social` (hints "SPUTNIK DAO, TREZU, NAMED ACCOUNTS"): a Sputnik DAO council owns the contract, which is governance,
  not what the track asks ("Don't rebuild the multisig — build what communities do with it").

## What the submission cannot meet yet

- **A public repository** by 2026-11-14T23:59:00Z: private on 2026-11-13 (`gh repo view`); the founder flips it
  on 2026-11-13 after the final deploy, the branch clean-up and the tags ([`hackathon-public-checklist.md`](hackathon-public-checklist.md)
  step 11, the runbook; D749).
- **The video, the X post and the submission**: the colleague who submits records, posts and submits, after the flip
  ([`hackathon-demo-script.md`](hackathon-demo-script.md)).
- **The tags** (Q-003): decided, pushed by the founder (D746).
- **Google sign-in for judges**: Journear's Google client is in Google's testing mode, so only listed testers can use
  it. Judges use email sign-in, which works for any address.
- **Capacity during judging** (D793): 200 code emails a day for Stamp Trail and 100 for the hosted demo's app, within
  the env's daily send budget of 333; 10 sign-in starts per IP address per 10 minutes and 30 a day; 3 NEAR a day of
  relay spend per app and 6 for the env. Past any of them, sign-in or the relayed stamp refuses until 00:00 UTC
  ([`hackathon-public-checklist.md`](hackathon-public-checklist.md) step 9). The stamps contract's storage balance
  (about 19.9 NEAR) can be used up by anyone; a transfer tops it up.
- **NEAR auto-approve**: none; every NEAR signature needs Approve in the window, every stamp included.
- **Mainnet**: none of it; testnet only, and the faucet Own fare needs is a third-party page.
