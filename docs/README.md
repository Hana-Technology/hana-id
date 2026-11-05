# Docs index

Two kinds of doc live here. **Reference docs** describe the system as it is now and are updated in the same branch as
any change they cover (rule in `CLAUDE.md`). **Specs** describe what a batch set out to change; they are history once
the batch merges, so where a spec and a reference doc disagree, the reference doc (and the code) wins.

Last verified: 2026-11-05 for the batch C spec and build plan rows and `operations.md`'s row (branch `feat/batch-c-15`: C15, the Support ID lookup, built, not merged, D394–D397, D393; D276 confirmed); 2026-11-05 for the `operations.md` row (branch `feat/coop-canary`: the pre-release COOP canary, D386); 2026-11-05 for the `operations.md` row (branch `feat/deploy-build-check`: "Checking a deploy", D384);
2026-11-04 for the batch C spec and build plan rows (branch `feat/batch-c-13`: C13 built, not merged,
D360–D369; `api.md`'s "Usage ledger retention functions", the retention RPCs, the admin's `GET /api/retention` and
monthly job; `operations.md`'s "Retention"); 2026-11-04 for the batch C build plan row and `api.md`'s console section (branch `feat/console-reports-upgrades`: the partner console's usage, statement and pending-upgrades screens, D370–D374, not merged); 2026-11-04 for the batch C build plan row and `api.md`'s console section (branch `feat/batch-c-10`: C10, partner management, built, not merged; D342, D343, D350–D358); 2026-11-04 for the batch C spec, build plan, identity token and Hana Home rows (branch `feat/user-id-identity-sub`: the partner User ID is the identity token's `sub`, the Support ID its short form, `hu_…` internal, D346; the wallet record's session signature, a security review fix); 2026-11-04 for the batch C spec and build plan rows (branch `feat/batch-c-12`: C12 built, not merged,
D320–D329; `api.md`'s "Usage ledger functions" and the admin Worker's report, statement, rate and export routes and
crons; `operations.md`'s "Reports and statements"); 2026-11-04 for the batch C build plan row and `api.md`'s admin Worker section (branch `feat/batch-c-14`: C14
built, not merged; D330–D338, D344); 2026-11-04 for the batch C spec and build plan rows (branch `feat/wallet-directory`: the wallet directory, D310–D317, noted where C8b, C10 and C15 use it; not merged); 2026-11-04 for the batch C spec and build plan rows and `api.md`'s console section (branch `feat/batch-c-9`: C9, partner sign-in, built on `develop` with C8 and C11, not merged; open question 1's test built, not run; D290–D297); 2026-11-04 for the batch C build plan row (branch `feat/batch-c-11`: C11 built, not merged; `api.md`'s new
files Worker section); 2026-11-04 for the batch C build plan row and `api.md`'s admin Worker section (branch `feat/batch-c-8`: C8 built, D278–D285); 2026-11-04 for the batch C build plan row (branch `feat/batch-c-6-merge`: C6 on current `develop`, with C7, not merged); 2026-11-04 for the batch C build plan row and `api.md`'s console Worker section (branch `feat/batch-c-7-merge`: C7 merged onto `develop`); 2026-11-04 for the batch C spec and build plan rows (branch `docs/batch-c-users-support-id`: the Users screen and the Support ID proposed, D275, D276); 2026-11-04 for the native apps spec row (branch `docs/native-apps-spec`: on `develop`, Q19); 2026-11-03 for the batch C, identity token and email login build plan rows (branch `docs/sandbox-dev-state`: what is merged and live on sandbox-dev); 2026-11-03 for the email login build plan's row (branch `feat/email-login-8b`); 2026-11-02 against `develop` @ 1c6a124 (branch `docs/consistency-pass`: the specs' build state); the email
login build plan's row on 2026-11-02 (branch `feat/email-login-6`, against `develop` @ bbdd8ed).

## Reference (current state)

| Doc | Answers |
|---|---|
| `architecture.md` | What the parts are, how they talk, each flow step by step, key derivation, where data lives, glossary |
| `security.md` | Who is trusted for what, what each compromise gives, key and secret inventory, invariants, open issues |
| `contract-interface.md` | `hana-signer` methods, types, byte layouts, events, panics |
| `api.md` | Every HTTP endpoint, auth, errors, rate limits; D1 schema, Durable Objects, bindings, request logs; the usage ledger's functions; the email issuer's, the console Worker's (partner sign-in, the read-only console) and console-auth's, the admin Worker's and the files Worker's routes, entrypoints and crons |
| `integration.md` | Partner guide: getting an app, `createHana`, page requirements, Google client, app settings, signing, auto-approve, React, Sodax, test and live keys, errors, the identity token and its verification (section 15) |
| `operations.md` | Setting up and deploying an environment, checking a deploy (`deploy-check`: every Worker and page bundle on one commit, D384), Google clients, key rotation, smoke tests, the hosted demo, logs, common failures; the pre-release COOP canary (D386); issuing statements, rate overrides and the ledger's alerts (batch C12); retention, the issuer's monthly purge and erasure requests (batch C13); looking a Support ID up (batch C15) |
| `playbooks.md` | Step-by-step recovery for every watchdog alert kind and every incident (signals, impact, steps with who acts, commands, verify); generated from `packages/playbooks` (D126), the same source as the admin portal's "Security & monitoring" playbooks |
| `decisions.md` | Every decision: when, why, what was rejected, status |
| `context.md` | Project background, the early design decisions, testnet measurements, next steps |
| `mainnet-readiness.md` | Everything that must be true before mainnet: each item's status, owner and source, grouped (open decisions, keys, governance, infrastructure, monitoring, reviews, builds, address freeze, legal), the top blockers, and inconsistencies found between docs |
| `../envs/README.md`, `../apps/api/README.md`, `../apps/smoke/README.md`, `../apps/e2e/README.md`, `../apps/demo/README.md` | Per-package quick starts (`apps/demo`: the hosted testnet demo for colleagues) |
| `../packages/{core,web,react,sodax}/README.md` | The partner-facing READMEs shipped in the SDK tarballs (install, minimal usage) |
| `../apps/email-issuer/README.md` | The email issuer Worker: what it holds, its endpoints and limits in short, tests, `gen`, the init script and local dev |
| `../packages/email/README.md` | Email normalization v1, the `e1.` `sub`, the Google-hosted rule, the disposable-domain list: API, the frozen rules, the `tr46` choice, the list's pinned source and how to update it |

## Specs (history)

| Doc | Batch |
|---|---|
| `batch-a-spec.md` | A: isolation (contract registry, API, environments) |
| `batch-a2-shared-client.md` | A.2: shared Google client, sessions, follow-up fixes |
| `batch-b-spec.md` | B: browser SDK, vault, one-transaction login, auto-approve policies (merged into `develop` and deployed on sandbox-dev, 2026-10-29) |
| `batch-c-spec.md` | C: developer dashboard (D34 MVP cut and D73–D75 folded in; being built in the batches of `batch-c-build-plan.md`, so still the current design until batch C merges; the staff Users screen and the Support ID lookup over D269's directory proposed 2026-11-04, D275, D276; the Support ID's derivation and the partner User ID settled by D346; D276 confirmed by the user 2026-11-05 as amended, built in C15) |
| `batch-c-build-plan.md` | C: the spec split into mergeable batches C1–C17, milestones and the setup steps (C1–C5 merged into `develop` and running in the sandbox-dev API as far as `develop` includes them: migrations 0006, 0009, 0010 applied, usage capture off; C6, C7, C8 (D278–D285) and C11 (the files Worker and logos, D300–D308) merged, not deployed (the console D1 not created; M3 not run); C9 (partner sign-in, D290–D297) merged into `develop`, not deployed; C14 (Security & monitoring, the pending-upgrades page) merged, not deployed (D330–D338); C12 (reports, settlement, statements) merged, not deployed (D320–D329; Neon 0006); C10 (partner management, D342, D343, D350–D358) merged into `develop`, not deployed; the partner usage, statement and pending-upgrades screens built on `feat/console-reports-upgrades`, not merged (D370–D374); C13 (retention, the erasure path) built on `feat/batch-c-13`, not merged, not deployed (D360–D369; Neon 0007); C15 (the Support ID lookup's backend and the user's `supportId`) built on `feat/batch-c-15`, not merged, its admin screen after C8b (D394–D397, D393; SDK 0.2.0); C16–C17 not built) |
| `governance-spec.md` | Pre-mainnet governance (D33): delayed issuer keys with a watchdog, multisig owner, timelocked upgrades, pause (built; on sandbox-dev since 2026-10-30) |
| `hana-home-spec.md` | Pre-mainnet Hana Home (D40, D45): cross-app wallets and key export for shared-login apps, consent revocation from any device (draft, for review) |
| `email-login-spec.md` | Pre-mainnet email login (D4): Hana-run email issuer (Worker-secret key on testnet, AWS KMS before mainnet, two-signer-ready), automatic Privy-style account linking with pseudonymous ids on chain, explicit `linkAccount` (approved 2026-10-30: D119, D121–D123; built in the batches of `email-login-build-plan.md`) |
| `identity-token-spec.md` | Pre-mainnet partner identity token (D120): a ≤ 1 h ES256 JWT for partner backends with a per-scope pseudonymous `sub`, proven wallet addresses, `sid`, opt-in verified email per app (sealed, never stored); JWKS, staged signing key (Worker secret on testnet, AWS KMS before mainnet), Privy migration (approved 2026-10-30: D127; build steps 1–4, no email claim, D170–D175, review fixes D176–D179; merged, deployed on sandbox-dev 2026-11-02; step 7's KMS signer code, merged, no env uses it: D215–D219, to confirm; step 8, the watchdog's JWKS pin check and outside probe (detection only), merged, the watchdog check deployed 2026-11-02: D210–D214) |
| `email-login-build-plan.md` | The email login spec split into reviewable batches (order, scope, deploy steps, what users see after each); batch 1 = contract v3 (batches 1–6, 7, 8a and 8b merged and live on sandbox-dev since 2026-11-03: contract v3, the email issuer Worker, the API, plain email login and automatic linking for the demo app in scope `s2`; the watchdog's email pins are in the manifest, a redeploy with them unverified) |
| `apple-login-spec.md` | **Paused, not built (D160):** Sign in with Apple (D124), Q1–Q5 answered: provider `apple` verified on chain (RS256, Apple's JWKS through the delayed key changes and the watchdog), every Apple client in Hana's developer team (team-scoped `sub`), no Apple scopes at launch so no email on chain, first-login screen and explicit linking, an optional email-only second client for matching (draft, 18 open questions) |
| `native-apps-spec.md` | Native iOS, Android and React Native / Expo partner apps: Hana's vault and approvals in the system browser sheet (`ASWebAuthenticationSession`, Auth Tab / Custom Tabs), a companion key in the app, verified https returns as app identity; app-held keys (Web3Auth-style), a Hana app and a Privy-style remote signer analysed as later options; no contract or derivation change (draft, 19 open questions) |
| `hana-embed-ckd-results.md` | PoC measurements from wend-widget-demo |

## Where to put new knowledge

- A new or changed behaviour: the reference doc that covers it, in the same branch.
- A decision made in conversation: a new entry in `decisions.md`.
- A new security property, key or open issue: `security.md`.
- A new command, deploy step or failure mode: `operations.md`.
- A new watchdog alert kind or incident scenario, or a changed recovery step: a playbook in `packages/playbooks`, then
  `corepack pnpm --filter @hana-id/playbooks gen-docs` (a test fails when `playbooks.md` is stale or an alert kind has
  no playbook).
