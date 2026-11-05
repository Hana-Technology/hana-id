# Mainnet readiness checklist

Everything that must be true before Hana ID runs on mainnet with real funds. This is a current-state doc for the
two founders to track. Update a row in the same branch as the change that moves it (rule in `CLAUDE.md`).

Last verified: 2026-11-05 for row 7.11 (branch `feat/batch-c-8b`: the Users screen built, D275 confirmed); 2026-11-05 for rows 4.20 and 5.10 (branch `chore/ci-cost`: CI and the outside probe turned off on testnet, the probe to move to AWS Lambda + EventBridge, D387); 2026-11-04 for row 7.15 (branch `fix/admin-cron-budget`: every outbound call of the admin crons counted, settlement's reads a run, D380); 2026-11-04 for rows 9.3 and 9.8 (branch `feat/batch-c-13`: retention built, the issuer's part manual, the
directory expiry open; D360–D369); 2026-11-04 for row 1.7 (branch `feat/batch-c-10`: `at_hash` in the claim allow-list, D342); 2026-11-04 for rows 7.14, 7.15 and 9.4 (branch `feat/batch-c-12`: settlement's checks built, the
admin's subrequest and cron budget, the rate source; D320–D329); 2026-11-04 for row 5.9 (branch `feat/batch-c-14`: the portal's ack built, D332); 2026-11-04 for row 1.7 (branch `feat/batch-c-9`: the code-flow spike built, not run, D295); 2026-11-04 for row 7.10 (branch `feat/batch-c-6-merge`: batch C6, the console sink scope, D238, on current `develop`); 2026-11-04 for row 7.11 (branch `docs/batch-c-users-support-id`: the Users screen and Support ID proposed, D275, D276); 2026-11-04 for row 7.1h (branch `feat/token-first-on`: the spike passed, `'token_first'` switched on, D270); 2026-11-04 for row 6.8 (branch `fix/sessions-allow-list`: the claim allow-list always on, D271, D274); 2026-11-04 for row 7.1h (branch `feat/spike-leg-e`: the spike's leg E, D270); 2026-11-04 for the "Not tracked as blockers" note (branch `docs/native-apps-spec`: the native apps spec on `develop`); 2026-11-03 for row 4.19 (branch `fix/8b-rereview`, the second NEAR provider, D263); 2026-11-03 for rows 7.1h and 7.1i (branch `feat/email-login-8b` review fixes, D263–D267); 2026-11-03 for
rows 7.1f and 7.1g (branch `feat/email-login-8b`, automatic linking, D254–D259); 2026-11-02
before that (branch `feat/email-login-8a`, plain email login in the web, D245–D249);
2026-11-02 for rows 7.1–7.1e (branch `feat/email-login-6`, the API's email login part and its reviews, D230–D234, D250–D252);
2026-11-02 for rows 1.5, 1.16, 4.18 and 7.14 (branch `feat/batch-c-4`, usage capture, D220–D224);
2026-11-02 for row 2.6 (branch `feat/identity-token-7`, the KMS signer code); 2026-11-02, against `develop` @ 3c4e920 (batch C3 merged) and the docs on it; the inconsistencies, rows
1.14–1.16, 6.7 and 7.5 on 2026-11-02 against `develop` @ 1c6a124 (branch `docs/consistency-pass`). Today only
sandbox-dev (testnet) runs.

The facts come from the repo docs and from items the user named in conversation (source "conversation"). Where the
docs don't settle a status, the row says **unclear: check**. Contradictions between docs are listed at the end,
with what became of each.

## How to read it

**Status**

| Status | Means |
|---|---|
| done | True today, or decided with nothing left to do before mainnet |
| built, not deployed | Code merged on `develop` (sandbox-dev may run it); not set up for mainnet yet |
| not built | No code yet, or a setup or action not done yet |
| decision needed | Someone has to choose; nothing to build until they do |
| unclear: check | The docs disagree or don't say |

**Owner:** founder · colleague · Claude build · council (the 2-of-3 owner DAO). Two owners means both act.

**Source:** a decision (`D<n>`, `docs/decisions.md`), a doc and section, or "conversation".

## Summary

| Group | Rows | done | built, not deployed | not built | decision needed | unclear: check |
|---|---|---|---|---|---|---|
| 1. Decisions still open | 16 | 0 | 0 | 0 | 16 | 0 |
| 2. Keys and custody | 13 | 0 | 1 | 11 | 1 | 0 |
| 3. Governance | 8 | 2 | 4 | 2 | 0 | 0 |
| 4. Infrastructure and accounts | 19 | 0 | 0 | 14 | 3 | 2 |
| 5. Monitoring and paging | 10 | 0 | 2 | 7 | 1 | 0 |
| 6. Security reviews and drills | 9 | 1 | 0 | 6 | 0 | 2 |
| 7. Builds not done | 14 | 0 | 1 | 11 | 1 | 1 |
| 8. Address freeze | 7 | 1 | 1 | 2 | 2 | 1 |
| 9. Legal and product | 7 | 0 | 0 | 5 | 1 | 1 |
| **Total** | **103** | **4** | **9** | **58** | **25** | **7** |

### Top 10 blockers

These have the longest lead time, or other rows wait on them.

1. **Hana Cloudflare account, zone and the two production domains** (4.1, 4.2). Batch C's production hosting, the email
   sending subdomain, the identity token's `iss`, the Pro-plan test and staging all wait on them.
2. **Mainnet support in the manifest schema and scripts** (4.4). Both are testnet-only today, so no mainnet env can be
   created.
3. **Address freeze** (8.1). Final accounts deployed, mainnet MPC pinned, the Apple team and governance Q17 settled
   first.
4. **AWS account and KMS signers** for the email issuer (batch 10) and the identity token (step 7) (2.4–2.6).
5. **Email login batches 4 and 6–10** (7.1). Batch 4 is on a branch; batches 6–10 aren't started.
6. **Batch C console and admin portal** (C4–C17) (7.3). Monitoring (D83), partner notices (D86) and alert
   acknowledgement need it.
7. **Hana Home** (7.4). Required before mainnet (D40).
8. **Paging app and live alert channels** (5.1, 5.2). ntfy is a stand-in; the alert email is a placeholder.
9. **External audit** (6.1). Live keys are issued only after it.
10. **Staging rehearsal** (6.2). Needs a staging env, which doesn't exist yet.

## 1. Decisions still open

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 1.1 | Mainnet launch date | Plans and partner commitments (real Sodax swaps wait for it) | decision needed | founder | D39; decisions.md "Proposed, not yet confirmed" |
| 1.2 | Mainnet issuer-key delay (2 h, provisional) | Too short and a watchdog outage can let a forged key through; too long and logins with a new Google kid fail | decision needed (lead-time measurement running; needs ≥ 2 Google rotations) | founder | D33, D80; governance-spec "Delay length"; operations.md "Issuer key lead times" |
| 1.3 | User-mail provider: SendGrid, final once the colleague agrees | Delivery of login codes is a trust root | decision needed | colleague, founder | D194 (replaces D87 for user mail) |
| 1.4 | Provider for the watchdog's alert email and the admin Worker's notices (Resend today, or SendGrid too) | Two providers means two accounts to secure | decision needed ("decided separately") | founder | D87, D194 |
| 1.5 | Batch C2/C3/C4 readings to confirm: D201–D203, D205–D209, D220–D224 | Built code rests on them | decision needed | founder | decisions.md D201–D203, D205–D209, D220–D224 |
| 1.6 | Email issuer readings D195–D199 (batch 4, merged into `develop`) | Rate limits and issuer behaviour | decision needed ("to confirm") | founder | decisions.md D195–D199; `docs/email-login-build-plan.md` "Batch 4 result" |
| 1.7 | Batch C Q1: does the console's Google code flow give an `openid`-only token? | If Google always adds `email`, step-ups and owner actions stop; `at_hash` (Google documents it on server-flow tokens) is in the allow-list since D342 | test built, not run: `scripts/console-code-flow-spike.ts`, for the founder after setup step 11; the `at_hash` decision made (D342, `feat/batch-c-10`) | founder, Claude build | batch-c-spec Q1; D93; D295; operations.md "Console code-flow spike" |
| 1.8 | Batch C Q5: Neon setup (restore window, compute, owner role, Hyperdrive on the plan) | The ledger is billing data, kept for years | decision needed | founder | batch-c-spec Q5; batch-c-build-plan P3; D93 |
| 1.9 | Batch B open questions Q2, Q4, Q6, Q10, Q11, Q13, Q17, Q24, Q25, Q26, Q29 | Login UX, mobile, MPC timeout, bundle budget | decision needed | founder | decisions.md "Proposed, not yet confirmed"; batch-b-spec |
| 1.10 | Provisional thresholds: link alarms 50/500 per hour (D200), email rate limits (D123 Q22), rejection-rate alert 5% (D91), `SIGNER_RESERVE` 5 NEAR | Set from real traffic, not guesses | decision needed (tune on sandbox-dev and staging) | founder | D200, D123, D91; governance-spec "Constants"; playbooks `link-volume` |
| 1.11 | Cap self-issued (email) keys at 2048 bits in a later contract version, or keep gas for 4096 | Gas headroom vs a contract change | decision needed (option offered) | founder | D155 |
| 1.12 | VAULT_KEK: stay a Worker secret or move to KMS | A Cloudflare compromise reaches every server share | decision needed (revisit with the email issuer) | founder | D54 |
| 1.13 | SDK registry (public npm `@hana-id` or private) and licence (`UNLICENSED` today) | Partners install the SDK from it | decision needed | founder | D72, D1 (scope still to claim); operations.md "SDK publishing" |
| 1.14 | Hana Home: `disable_shared_login` delayed by `change_delay_ms`, a contract change (D98; the Home spec's "Confirmed by the user" item 4), while the Home spec's body ("Contract changes: None", its scope table) and batch-c-spec call it immediate, as the contract is today | Whether a partner with its own client can cut Home's route at once and shut down (D41's exit guarantee) | decision needed (settle when Hana Home is built) | founder | D98; hana-home-spec "Contract changes"; batch-c-spec; security.md "On chain" |
| 1.15 | Hana Home billing: D98 (and the Home spec's confirmed item 12) puts an active app's Home derives on its org's statement as their own line; the Home spec's body counts them as Hana's own, on no statement; batch C's ledger has no Home event kind | Statements and the ledger schema | decision needed (settle when Hana Home is built) | founder | D98; hana-home-spec "Cost and latency (who pays)"; batch-c-spec |
| 1.16 | Hana Home directory source: "every app with at least one login" (D98). The Home spec reads D1 `usage.sessions > 0`, which batch C stops writing (C4) and drops (migration 0007, C4b); its directory must use the hot DB's `session_markers` (migration 0009, an app's first settled session-pool relay; D220) instead, never the Neon ledger (the Home spec itself is left as written until Home is built) | Which apps Home lists for a user | decision needed (settle when Hana Home is built) | founder, Claude build | D98, D220; hana-home-spec "Discovery: finding a user's apps"; batch-c-build-plan C4b |

## 2. Keys and custody

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 2.1 | Where the offline backup council key is held (third party under written instructions, or a dual-control safe deposit box) | Neither founder may reach 2 of 3 alone | decision needed | founder | D81; governance-spec Q18; context.md "Next steps" 5 |
| 2.2 | Founders' council keys on Ledgers | Council keys are never on disk for mainnet | not built | founder | D81; governance-spec "Owner = multisig" |
| 2.3 | Mainnet council DAO created by hand (Sputnik v2, 2-of-3 for every kind; factory `sputnik-dao.near` to verify) | It owns the contract | not built | founder, council | D81; operations.md "Owner council" |
| 2.4 | AWS account: root held by both founders on hardware keys, recovery offline | Holds the KMS keys | not built | founder | D121 |
| 2.5 | Email issuer key in AWS KMS (`RSA_2048`, sign-only IAM user rotated every 90 days, CloudTrail, hourly `Sign` reconciliation, alarms, standby key in a second region) | A Worker-secret key can be copied; mainnet never takes one | not built (KMS adapter on `feat/email-login-4`, wired to no env) | Claude build, founder | D121, D123 Q11; email-login-build-plan batch 10 |
| 2.6 | Identity token key in AWS KMS (ES256, own IAM user, reconciliation against `identity_issuance_hourly`, standby region) | A leaked key forges any user's identity at every partner | code built on `feat/identity-token-7` (KMS adapter, `aws-kms` manifest signer, `identity-key kms-*`; tested against a fake KMS); AWS keys, IAM, CloudTrail, alarms and the reconciliation not built (operations.md "Identity token keys on AWS KMS") | Claude build, founder | D127, D215–D219; identity-token-spec step 7; security.md (l) |
| 2.7 | `K_sub` for mainnet: generated offline, two offline backups (one with the council backup), never rotated | Losing it locks out every email user; replacing it moves every email address | not built | founder | D123 Q6; email-login-spec "Migration" |
| 2.8 | `IDENTITY_SUB_KEY` for mainnet, backed up offline with the council backup | Changing it changes every partner's user id | not built | founder | D127; identity-token-spec; security.md inventory |
| 2.9 | `USER_ID_KEY` offline backup | Support IDs and MAU depend on it | not built | founder | batch-c-build-plan setup step 6; batch-c-spec |
| 2.10 | Mainnet signer created in one batch (`DeployContract` + `new` + `DeleteKey`), never a full-access key | No moment with both code and a full-access key | built, not deployed (`deploy-contract --creation-plan`; "the mainnet run is the user's alone") | founder | D86 Q9; operations.md; contract-interface.md |
| 2.11 | Mainnet relayer account, two key pools, allowances, funding (manual top-ups) | Logins stop when a key runs out | not built | founder | D19, D150 |
| 2.12 | Mainnet CKD key pinned from ≥ 3 providers and compared with NEAR's published MPC key, code-owner review | A wrong pin derives keys nobody else can reproduce | not built | founder | D100 (OPER-1); operations.md "Create an environment" |
| 2.13 | Mainnet watchdog NEAR account and its function-call key; mainnet updater key | The watchdog's cancel and pause powers; Google key sync | not built | founder, council | D82, D86; operations.md "Watchdog service" |

## 3. Governance

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 3.1 | Governance contract: delayed issuer keys, watchdogs, pause, timelocked upgrades, DAO owner | Bounds the updater, owner and upgrade power (D33) | built, not deployed (on sandbox-dev since 2026-10-30, drilled) | Claude build | D33, D80–D86; security.md (e) |
| 3.2 | Governance delay 72 h on mainnet (manifest value, `deploy-contract` floor 24 h) | Time for partners and users to react and export keys | built, not deployed | founder | D80 |
| 3.3 | Reproducible build, hash, commit and command published before every mainnet `propose_upgrade` | Anyone can check the code being proposed | built, not deployed (scripts refuse non-testnet today) | founder | D86 Q14; operations.md "Upgrades" |
| 3.4 | Public notice of an upgrade or owner change: email to every org's security contacts, pending-upgrades page | Users need to see an upgrade in time to leave | not built (batch C) | Claude build | D86 Q11; playbooks `unexpected-owner-action` step 5 |
| 3.5 | Council member replacement (`council:replace-member`), reject votes | Recovery from a lost or stolen member key | done | — | D151 |
| 3.6 | No upgrade guardian at launch; watchdog alerts critical on every upgrade proposal | Decided scope for launch | done | — | D84 |
| 3.7 | Watchdog powers: cancels and pauses only on clear forgeries, deletes updater keys on that pause; owner unpauses at once | Limits what a rogue watchdog can do | built, not deployed | Claude build | D82, D126, D153 |
| 3.8 | Mainnet manifest passes `deploy-plan` with no blockers before any partner goes live | Last check of accounts, keys, delays and policy | not built | founder | governance-spec "Mainnet" steps 4–5 |

## 4. Infrastructure and accounts

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 4.1 | Hana-owned Cloudflare account and zone; who holds member and API-token access | Every production Worker runs there; sandbox-dev is on a personal account | decision needed | founder | D18, D34; batch-c-spec Q3; context.md "Before mainnet" |
| 4.2 | Production domain names: the user-visible auth domain and the vault domain, on two registrable domains | Process isolation of the vault (D38); users read the auth domain | decision needed (only "two registrable domains" decided) | founder | D38; batch-b-spec Q15 |
| 4.3 | Production env manifest (`envs/<env>.json`) with final account names | Every account name comes from it (D5) | not built | founder, Claude build | D5; operations.md |
| 4.4 | Mainnet support in the manifest schema and scripts | Schema accepts only `testnet`; scripts refuse every non-testnet manifest | not built | Claude build | operations.md "Testnet only", "Upgrades" |
| 4.5 | Watchdog on its own Cloudflare account (separate login and MFA), deployed by hand from a founder's machine; AWS Lambda documented as the alternative | A compromised Hana account must not silence it | not built (sandbox-dev shares the API's account) | founder | D86 Q3, D125 |
| 4.6 | Production Neon project (AWS Sydney) with its own credentials, restore window and access list | A sandbox leak never reaches production billing data | not built | founder | D143, D73 |
| 4.7 | Cloudflare plan for production (Workers Paid for 30-day D1 Time Travel; BLS precheck needs Paid) | Recovery window and features depend on it | unclear: check (no doc names the plan) | founder | D152, D64; operations.md "Restoring a D1 database" |
| 4.8 | Pro-plan routing test: does a paid zone keep Malaysian traffic in SIN? (free plan enters in Europe) | About 1 s per round trip on logins and unlocks | decision needed (deferred, with the colleague) | founder, colleague | D18, D97; context.md "Next steps" 1; conversation |
| 4.9 | SendGrid for user mail: its own subuser, domain authentication (SPF, DKIM, DMARC) on a sending subdomain, a Mail-Send-only key | Deliverability; reputation kept apart from Hana Wallet and Wend | not built | founder, colleague | D194 |
| 4.10 | Cloudflare Access for the admin console: GitHub team `hana-admins`, exact Google-address fallback (backup Google addresses still to give) | Staff access with MFA and offboarding | not built (addresses not given) | founder | D88; batch-c-spec Q4; context.md "Next steps" 5 |
| 4.11 | Google OAuth consent screen out of Testing mode, and Google brand verification | Real users can't sign in to a Testing-mode client | not built | founder | D2; operations.md "Google Cloud OAuth" |
| 4.12 | Production Google clients: Hana's shared clients and the console client | Logins and the partner console | not built | founder | D42; batch-c-build-plan setup step 11 |
| 4.13 | Mainnet MPC account and CKD domain in the manifest | Part of every address | not built | founder | D2; architecture.md "Key derivation" |
| 4.14 | Staging env (own scope and keys, no signer full-access key) | Rehearsals, KMS latency, load tests | not built (no staging manifest exists) | founder, Claude build | D42, D86 Q9; batch-c-spec "Testnet smoke" |
| 4.15 | R2 bucket for logos, statements and exports in the Hana account | Batch C files | not built | Claude build, founder | D74 |
| 4.16 | D1 backup beyond 30 days and outside Cloudflare (export of the apps tables) | Time Travel stops at 30 days | not built | Claude build | D152; playbooks `d1-data-loss` |
| 4.17 | SDK published: `NPM_TOKEN`, drop `"private": true`, claim the `@hana-id` npm scope | Partners install outside the monorepo | unclear: check (scope claim status not recorded) | founder | D1, D72; operations.md "SDK publishing" |
| 4.18 | Usage ledger Hyperdrive configs created through Cloudflare's REST API with the role password in the HTTPS body, not `wrangler hyperdrive create --connection-string` (the password is in the local process list while it runs; acceptable on sandbox-dev only) | The writer's credential could insert made-up usage | not built | Claude build, founder | D224; operations.md "Usage capture" step 3 |
| 4.19 | Keyed, operator-independent NEAR RPC providers for `rpc` and `rpcFallback` (each its own account and API key, run by different operators), and consider requiring 2 out of 3 for D263's path confirmations (e.g. adding `near-testnet.drpc.org`'s mainnet counterpart as a third) | Every login of a linked identity is refused (`path_unconfirmed`) while either provider is down or rate-limits it; sandbox-dev's second provider is the public `rpc.testnet.near.org`, slow and rate-limited, accepted for the testnet demo | not built (2-of-3 not built; testnet accepted) | founder, Claude build | D263; operations.md "Turning linking on (batch 8b)" |
| 4.20 | CI (GitHub Actions `CI` workflow) turned back on, with D383's job gating | Nothing enforces the tests on a merge while it is off; Linux-only browser failures (D381) merge unseen | not built (disabled 2026-11-05, D387) | founder | D383, D387; conversation |

## 5. Monitoring and paging

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 5.1 | Paging app: Pushover, PagerDuty or incident.io (ntfy is a stand-in; its public server returned 429 in the drill) | A forged key or an upgrade needs a human within the delay, at any hour | decision needed (pending with the colleague) | founder, colleague | D85; context.md "Next steps" 8; operations.md "Watchdog service" |
| 5.2 | Watchdog alert channels on production: Slack webhook, alert email (manifest has `example.com` placeholders), pager credentials | Critical alerts go to both founders on three channels | not built | founder | D85; `envs/sandbox-dev.json` `watchdog`; operations.md "Watchdog service" |
| 5.3 | Dead-man's switch on a third provider (5-min period, ~10-min grace) for the production watchdog | Reports a watchdog that stopped | not built (sandbox-dev uses healthchecks.io) | founder | operations.md "Setting it up" step 4 |
| 5.4 | A test critical page to both founders | Proves the alert path end to end | not built (not a command yet) | Claude build | playbooks `watchdog-first-run` step 1; governance-spec "Mainnet" step 1 |
| 5.5 | Admin portal "Security & monitoring": heartbeat, pending changes, actions, alerts with acknowledge, playbooks | Standing rule: a check isn't done until it shows there | not built (batch C14) | Claude build | D83, D126; batch-c-build-plan C14 |
| 5.6 | Identity token: watchdog JWKS pin check and "identity key on chain" check | An unpinned key in Hana's JWKS must page | not built (step 8) | Claude build | D127; identity-token-spec step 8; security.md (l) |
| 5.7 | Relayer funds monitoring (balance and per-key allowance) | A used-up key stops logins | built, not deployed | founder | D150 |
| 5.8 | `unrecorded_wallets` critical alert on every non-dev env; never true on mainnet | A pre-v3 wallet could be joined silently | built, not deployed | Claude build | D135, D139, D193 |
| 5.9 | Watchdog alert #11 on sandbox-dev (expected updater-key change) waits for the portal's acknowledge button. Testnet note, minor | It re-pages every 15 min until acknowledged; first real test of the portal's ack flow | portal built (C14, `feat/batch-c-14`), not deployed: ack it in Security & monitoring once the admin Worker runs (`docs/operations.md` "Security & monitoring" step 5) | founder | conversation |
| 5.10 | Outside identity-JWKS probe on AWS Lambda + EventBridge (SNS email for findings), in an AWS account of its own (not the KMS one), every 15 min or tighter; retire the GitHub workflow. Alternatives: Google Cloud Functions + Cloud Scheduler (also free), a small VPS with cron (~$4–6 a month) | The only check from outside Cloudflare against D210's cloaking; free at any interval there | not built (GitHub probe disabled 2026-11-05, D387) | Claude build, founder | D210, D382, D387; conversation |

## 6. Security reviews and drills

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 6.1 | External audit | `pk_live_` keys are issued only after it | not built (no auditor named) | founder | D2; context.md "Before mainnet"; integration.md |
| 6.2 | Staging rehearsal: KMS signers and p95 (≤ 100 ms), key rotation and compromise drills (for the identity KMS signer, confirm on staging that a `GetSessionToken` session of the signer user can't `Sign`, operations.md "Identity token keys on AWS KMS"), Playwright, Access header, load test | Mainnet procedures run once before they matter | not built | Claude build, founder | email-login-build-plan batch 10; identity-token-spec step 7; batch-c-spec |
| 6.3 | D1 Time Travel restore rehearsed on sandbox-dev | A restore must not undo a security response | not built | founder | D152; playbooks `d1-data-loss` |
| 6.4 | Sweep items marked "before mainnet": OPER-4, OPER-7, OPER-8, OPER-9 (publish workflow env, deploy wasm hash and extra full-access keys, near-sandbox checksum, dependency scanning) | CI and deploy hardening | not built | Claude build, founder | security.md "Security sweep 2026-10-29: API, operator tooling and CI" |
| 6.5 | Deferred sweep findings (APIW-2/5/6/7/8/9, APIV-1/2/4/6/8/9, CORE-2/6, PART-2/4, the `owner_action_nonce` recompute) | Whether each must close before mainnet isn't stated | unclear: check | founder, Claude build | security.md sweep sections |
| 6.6 | Open issues (g) cross-isolate replays and (h) wide relayer allowlists | Gas cost; a leaked key's reach | not built ((h) folded into the allowlist step) | Claude build | security.md (g), (h) |
| 6.7 | GitHub "Require review from Code Owners" on `develop` and `main`; second owner | Derivation, contract and keys code needs a second reviewer | not built for the setting; the second owner is done (`@mj-hana` in `.github/CODEOWNERS` since 2026-10-30) | founder | D58, D100; security.md OPER-3; context.md "Next steps" 2 |
| 6.8 | The claim allow-list on `/v1/sessions` (was `REJECT_PII_ON_SESSIONS = "1"`) | Keeps PII off chain on the split path | done (always on, the flag removed; also on `/v1/owner-actions`; D271, D274) | — | security.md "Claim allow-list" |
| 6.9 | Forged-key and pause drills | The watchdog acts as specified | done (sandbox-dev, 2026-10-30) | — | operations.md "Watchdog service" |

## 7. Builds not done

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 7.1 | Email login batches 6 (API, on `feat/email-login-6`), 7–8 (web), 9 (consoles), 10 (KMS, staging) | Email login is a pre-mainnet login method (D4) | not built (1–5 merged; 6 on a branch) | Claude build | D4, D119–D123; email-login-build-plan |
| 7.1b | Production route `<api host>/v1/email/*` to the email issuer Worker on Hana's zone (the issuer's `iss` under the API's URL), or `emailIssuer.url` for its own host | Addresses and codes must never pass through the API Worker (D230) | not built (needs the production zone, 4.1) | founder | D230; operations.md "Email issuer" step 7 |
| 7.1c | Email login batch 6 readings D230–D234, D250–D252 | Routing, the API's email checks, link limits, the deploy order, the issuer's APP_DB, the pool links use | decision needed ("to confirm") | founder | decisions.md D230–D234, D250–D252 |
| 7.1d | The email issuer reads the API's D1 through a read-only RPC on the API instead of the read-write `APP_DB` binding | A compromised issuer Worker could write the API's tables (origins, keys, settings) | not built (a source check holds the code to reads, D251) | Claude build | D251; security.md "Email issuer" |
| 7.1e | A third relayer pool for the link methods, or keep them on the session pool with the global cap | A link flood shares the allowance logins use | decision needed (D252) | founder | D252 |
| 7.1f | Email login batch 8a readings D245–D249 and batch 8b readings D254–D259 (Google's email by a second request, the refusal when google-match can't answer, the follow-up channel, the linked-login recovery, email export, banners and `linkAccount`) | The popup's cancel codes, the SDK surface, the demo setup by hand; how linking behaves in the popup and the vault | decision needed ("to confirm"); 8b built on `feat/email-login-8b`, not merged | founder | decisions.md D245–D249, D254–D259 |
| 7.1g | Before email is enabled for any scope with real Google users: google-match's hint writes (batch 8b), or a merge path for email wallets opened meanwhile | An email identity with a wallet can never join a Google account later ("Sign-in method already has a wallet"). Batch 8b: every Google login of an app with email runs google-match, which writes the hint, so an email login of that address reaches case B (no second wallet). Residual: a Google wallet opened before its app turned email on has no hint until its owner's next Google login there | built on `feat/email-login-8b` (hints at every Google login); D248 lifted for scopes whose Google users have signed in since email was turned on (`docs/operations.md` "Turning linking on (batch 8b)"); the residual window is accepted per scope, or waited out | founder, Claude build | D248, D249, D255 |
| 7.1h | The Google email-scope spike's legs C and D on real Google (`apps/smoke/spike-email.html`), by the user, for a Gmail, a Workspace and an outside-address account; legs C and E (and E2) before `GOOGLE_EMAIL_FLOW` becomes `'token_first'` | C: an openid-only ID token after the email grant must carry no `email` claims (else every later Google login of that user is `token_has_pii`); D: the silent email request must succeed again (the grant is no longer revoked, D265); E: `token_first`'s silent openid ID token must be clean, for the same account, with tokeninfo reachable from the browser (`tokenFirstUsable`) | **done** 2026-11-04: every leg passed for all three accounts with sandbox-dev's shared client (`docs/context.md` "Google email scope spike"); `GOOGLE_EMAIL_FLOW = 'token_first'` on `feat/token-first-on`. Re-run if the Google requests change or for a new Google project | founder | D254, D265, D270 |
| 7.1i | Batch 8b review readings D263–D267: member paths on two independent RPC providers and root pins, the email permission's screens, no revocation, the issuer's word on the match (accepted risk), the relay and google-match limits | Wallet safety against a lying RPC; the issuer's trust boundary | decision needed ("to confirm") | founder | D263–D267 |
| 7.2 | Contract v3 (email login, link counter) deployed | Every email and linking feature needs it | built, not deployed (sandbox-dev still runs v2) | founder, council | D200; contract-interface.md |
| 7.3 | Batch C C4–C17: ledger capture, console, admin console, notices, statements, Support ID | Replaces `admin app:*`; monitoring, notices, billing | not built (C1–C3 merged) | Claude build | D28–D34, D73–D75, D87–D93; batch-c-build-plan |
| 7.4 | Hana Home: export for every shared-login app, cross-device consent revocation, Support ID | Users aren't stranded when an app shuts down; required before mainnet | not built | Claude build | D40, D45, D98; hana-home-spec |
| 7.5 | `disable_shared_login` delayed by `change_delay_ms` (a contract change) | Hana Home's guarantee | decision needed (row 1.14; D98 says delayed, the Home spec's body and batch C say no contract change) | Claude build | D98; hana-home-spec |
| 7.6 | Identity token steps 5–6 (opt-in verified email claim, consent, sealing) | Partners' verified-email use (D120) | unclear: check (not built; whether required for mainnet isn't stated) | Claude build | D120, D127; identity-token-spec |
| 7.7 | User key rotation (`key_index` move) | Recovery after a leaked user key | not built ("key rotation hooks before mainnet") | Claude build | D8, D60; playbooks `user-key-leaked` |
| 7.8 | Passkeys for partner console members | Required before a second partner joins | not built (deferred, D34) | Claude build | D34; batch-c-spec "Deferred" |
| 7.9 | Origin timelock for shared mode in the partner console | Origins decide which pages get nonces | not built in the console (CLI proposals built in C3) | Claude build | D32, D34, D52 |
| 7.10 | Console sink scope | Must roll out before the address freeze | built on `feat/batch-c-6` (deploy-contract's sink steps), not run on sandbox-dev (milestone M3) | Claude build, founder (runs the plan) | D93 Q7, D238 |
| 7.11 | Support ID data path: a short spec section before C15 (and, after D269, the staff Users screen) | Staff support; partners never see addresses | spec section written 2026-11-04; the Users screen (D275) confirmed by the user 2026-11-05 and built in C8b (`feat/batch-c-8b`, not merged, not deployed; D388–D392); the Support ID lookup (D276, C15) still to confirm, not built | Claude build, founder | D96, D144, D269, D275, D276; batch-c-spec "Users and Support ID"; batch-c-build-plan C8b, C15 |
| 7.12 | Batch C usage ledger counts identity tokens per app and day | Billing of identity tokens | not built | Claude build | batch-c-build-plan "Conventions"; D172 |
| 7.13 | API-side NEAR RPC fallback | The API reads only `NEAR_RPC` | not built (whether a mainnet blocker isn't stated) | Claude build | playbooks `near-rpc-outage` |
| 7.14 | Settlement (C12) checks each relayed event against its transaction: `near_tx` unique in the ledger, and the transaction's signer key and nonce equal the event's `relayer_pk` and `relayer_nonce`; anything else is not billed and is alerted | A leaked writer credential could otherwise bill a partner for a real transaction that isn't theirs | built on `feat/batch-c-12`, not merged (D321: also a key outside the pools and a receiver mismatch; a duplicate bills neither, at read time too) | Claude build | D222, D321; batch-c-build-plan C12; security.md "What a compromise gives" |
| 7.15 | The Workers plan for the admin Worker's budgets: 40 outbound calls a run, every RPC and the connection counted (D280, D380), caps settlement at 38 transactions a 15-minute run (≈ 3 600 a day, fewer in runs that also send notices or run the monthly job; D322), and the admin's two cron triggers per env (D329) with the API's, the watchdog's and the console's exceed the free plan's 5 per account for two envs; a statement's PDF and CSV and a large export need more CPU than the free plan's per-request limit | Settlement falls behind past ≈ 3 600 relayed transactions a day; the crons don't all fit on one free account; statements may fail to render | decision needed | founder | D280, D322, D329, D380; build plan open question 3 |

Not tracked as blockers: Sign in with Apple (paused, D160) and the native apps spec (`docs/native-apps-spec.md`, a
draft with 19 open questions, on `develop` since 2026-11-04).

## 8. Address freeze

After the freeze nothing may change a path or key derivation (rule in `CLAUDE.md`). Sandbox-dev wallets are test data
discarded at the freeze (D122).

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 8.1 | Address freeze: final accounts deployed (`signer`, `mpc`, `ckdDomainId`, MPC key) | Every user's address depends on them | not built | founder | D2, D5; operations.md "Address impact" |
| 8.2 | Apple developer team: provisional (the Hana Wallet / Wend company's team, testnet). Confirm or move before the freeze | The team decides every Apple address; Apple login itself is paused | decision needed | founder | D160 Q2; apple-login-spec "Answers so far" |
| 8.3 | Governance open question 17: a compromised OIDC owner can cancel any change, including the `SetOwners` that removes it | "Decide before the address freeze" | decision needed | founder | governance-spec Q17; batch-c-spec Q9 |
| 8.4 | Email normalization v1 and the `e1.` `sub` frozen | Defines every email address | done (merged, D156–D159 confirmed) | — | D156–D159; `packages/email/README.md` |
| 8.5 | Facts to cite before the freeze: a deleted Gmail username is never reissued; `googlemail.com` is the same mailbox | The email rules rest on them | unclear: check (D159: the first cited, no current Google page for the second) | founder | D123 Q7, D159 |
| 8.6 | Mainnet signer created with `new` on v3 (`unrecorded_wallets == false`, never `accept_unrecorded_wallets`) | A migrated signer would let pre-v3 wallets be joined | built, not deployed | founder | D135, D139 |
| 8.7 | Mainnet CKD key pinned (row 2.12) and the MPC account set (row 4.13) before the freeze | Both are part of every address | not built | founder | D100; architecture.md |

## 9. Legal and product

| # | Item | Why it matters | Status | Owner | Source |
|---|---|---|---|---|---|
| 9.1 | Legal advice on the non-custodial claim | Underpins key export and partner due diligence | not built | founder | D41 |
| 9.2 | Legal review of Hana Home's privacy notice | Home lists a user's apps | not built | founder | D98; hana-home-spec Q16 |
| 9.3 | Retention periods confirmed by the company's accountant (statements 7 years, raw usage 24 months, audit 5 years) | ATO record keeping, Privacy Act APP 11 | decision needed (the job applying them is built on `feat/batch-c-13`, D360) | founder | D90 |
| 9.4 | Service contract terms: the NEAR/USD rate source (built as CoinGecko's daily history, a day's opening price, D325), retention periods, billing of partner-caused rejections above the threshold | Statements quote them | decision needed (the code names CoinGecko) | founder | D91, D93 Q17, D325; batch-c-spec |
| 9.5 | Partner terms: delete a shared email on the user's request | The identity token's email claim | not built | founder | identity-token-spec "Storage and revocation" |
| 9.6 | Enterprise contract: branded Google clients kept ≥ 2 years after exit, right to enable shared login at exit | Users of an exiting Enterprise partner can still export | not built | founder | D98 |
| 9.7 | Billing: Stripe, plans and invoicing on hold; Sodax billed by service contract | Whether this changes before mainnet isn't stated | unclear: check | founder | D31 |
| 9.8 | Personal data in the directories: an expiry for an identity's address row with no app left (D269 sets none), and the issuer's monthly purge automated (today `admin retention:issuer` by hand) | APP 11; a manual monthly step gets missed | decision needed (D363, D365) | founder | D269, D363, D365 |

## Inconsistencies found

Reference docs and status lines that disagreed, as found on 2026-11-02, and what became of each. Fixed on branch
`docs/consistency-pass` (2026-11-02) after checking the code, git and `docs/operations.md`, unless marked otherwise.
Specs and build plans are history (rule in `CLAUDE.md`): only their top-of-file Status line was updated; their bodies
are left as written.

1. **architecture.md "Status of each part" was stale.** Fixed: every row now says where the part is merged and what
   sandbox-dev runs (batch B, governance v2 owned by the council DAO, the watchdog with batch 5 and the identity token
   deployed; contract v3 and batch C C1–C3 merged, not deployed; the email issuer not merged).
2. **security.md (e)** said "not deployed" under a heading that said deployed. Fixed: the body, the watchdog notes
   (batch 5 included) and the "Known open issues" status line now say fixed on sandbox-dev, with mainnet setup left.
3. **security.md, the origin timelock (Q22).** Fixed: the batch B note now says it is built in batch C3 (staff
   proposals waiting `appChangeDelayMs`), merged, not deployed, matching "Admin CLI writes".
4. **decisions.md D80, D81, D85, D86 said "not built".** Fixed (Status lines only): built and on sandbox-dev since
   2026-10-30, with what is left for mainnet. Also stale and fixed the same way: D4, D33, D82, D87, D120, D190, D191,
   D193, D200.
5. **Second code owner.** Fixed: D100's Status line, the "Superseded or amended" row and security.md OPER-3 now name
   `@mj-hana` (in `.github/CODEOWNERS` since 2026-10-30). Row 6.7 updated. D100's body (what was decided) is unchanged.
6. **Email provider.** Fixed: decisions.md "Proposed, not yet confirmed" lists the user-mail provider as open (SendGrid,
   D194, provisional until the colleague agrees); D123 Q3 notes that D194 supersedes its provider; context.md "Next
   steps" 7 and "Before mainnet" say SendGrid for user mail and Resend (D87) for the watchdog's alert email.
7. **operations.md "Watchdog service"** said no channel was configured. Fixed: since the 2026-10-30 drills the pager
   (ntfy.sh) and the heartbeat are set; Slack and email are not, and only those report `channel_not_configured`.
8. **operations.md "Owner council"** said the DAO round trip was unverified. Fixed: verified on testnet 2026-10-30
   (handover, upgrade drill, drill proposals); the gas `create` burns wasn't recorded.
9. **playbooks.md `link-volume`** said "once the scripts list it". Fixed in the source (`packages/playbooks`) and
   regenerated: `set_link_thresholds` goes through `owner:call`. The email-login build plan's line about
   `OWNER_METHODS` is history and stays.
10. **Build-plan and spec status lines were stale.** Fixed: the Status lines of the email-login and batch C build plans,
    and of the governance, batch B, batch C, email-login and identity-token specs; the `docs/README.md` index rows. The
    batch C build plan's "this branch" label for C1 is in its body and stays.
11. **Hana Home vs D98 on `disable_shared_login`.** Kept for a decision: row 1.14.
12. **Hana Home billing.** Kept for a decision: row 1.15.
13. **Hana Home directory source.** Kept for a decision: row 1.16.
14. **governance-spec delay bound.** Not an inconsistency. With D = 2 h, P = 15 min, T = 1 min and M = max(1 h,
    L_min / 4), the availability bound holds exactly for L_min ≥ 3 h 16 min ("2 h 16 min + 1 h"); the table's
    "valid if L_min ≥ ~4 h" is the same bound rounded up. No current doc repeats either; the spec stays as written.
15. **`create_session_and_derive` gas.** Fixed: it was measured in the sandbox with the mock MPC (email-login batch 2:
    ≈ 20.5 Tgas in the signer's receipt, 22–23 in all); contract-interface.md's conventions, operations.md "Logs and
    latency" and architecture.md now point there and say it isn't measured on testnet yet. D76 is its latency.
16. **context.md** had no "Last verified" line. Fixed: it has one, "Next steps" is dated by its update (2026-11-02,
    with that day's deploys), and the dated batch B status section says it is a record.
17. **decisions.md layout.** Fixed: D160, D194 and D200 moved under headings of their own (in number order after
    D159 and D193). Also moved, as misplaced: D125, D126 and D150–D153 (governance follow-ups), D140–D145 (batch C1),
    D127 (identity token spec), D176–D179 (identity token review fixes, were under email login batch 1), D154–D155
    (email login batch 2), and batch C3 after C2. No entry's text changed in the move. D120 (the identity token on the
    roadmap) stays under the 2026-10-29 security-sweep heading, because the email login section's intro refers to it
    as "above".
