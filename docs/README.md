# Docs index

Two kinds of doc live here. **Reference docs** describe the system as it is now and are updated in the same branch as
any change they cover (rule in `CLAUDE.md`). **Specs** describe what a batch set out to change; they are history once
the batch merges, so where a spec and a reference doc disagree, the reference doc (and the code) wins.

Last verified: 2026-11-03 for the email login build plan's row (branch `feat/email-login-8b`); 2026-11-02 against `develop` @ 1c6a124 (branch `docs/consistency-pass`: the specs' build state); the email
login build plan's row on 2026-11-02 (branch `feat/email-login-6`, against `develop` @ bbdd8ed).

## Reference (current state)

| Doc | Answers |
|---|---|
| `architecture.md` | What the parts are, how they talk, each flow step by step, key derivation, where data lives, glossary |
| `security.md` | Who is trusted for what, what each compromise gives, key and secret inventory, invariants, open issues |
| `contract-interface.md` | `hana-signer` methods, types, byte layouts, events, panics |
| `api.md` | Every HTTP endpoint, auth, errors, rate limits; D1 schema, Durable Objects, bindings, request logs |
| `integration.md` | Partner guide: getting an app, `createHana`, page requirements, Google client, app settings, signing, auto-approve, React, Sodax, test and live keys, errors, the identity token and its verification (section 15) |
| `operations.md` | Setting up and deploying an environment, Google clients, key rotation, smoke tests, the hosted demo, logs, common failures |
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
| `batch-c-spec.md` | C: developer dashboard (D34 MVP cut and D73–D75 folded in; being built in the batches of `batch-c-build-plan.md`) |
| `batch-c-build-plan.md` | C: the spec split into mergeable batches C1–C17, milestones and the setup steps (C1–C3 merged into `develop`, not deployed; C4–C17 not built) |
| `governance-spec.md` | Pre-mainnet governance (D33): delayed issuer keys with a watchdog, multisig owner, timelocked upgrades, pause (built; on sandbox-dev since 2026-10-30) |
| `hana-home-spec.md` | Pre-mainnet Hana Home (D40, D45): cross-app wallets and key export for shared-login apps, consent revocation from any device (draft, for review) |
| `email-login-spec.md` | Pre-mainnet email login (D4): Hana-run email issuer (Worker-secret key on testnet, AWS KMS before mainnet, two-signer-ready), automatic Privy-style account linking with pseudonymous ids on chain, explicit `linkAccount` (approved 2026-10-30: D119, D121–D123; built in the batches of `email-login-build-plan.md`) |
| `identity-token-spec.md` | Pre-mainnet partner identity token (D120): a ≤ 1 h ES256 JWT for partner backends with a per-scope pseudonymous `sub`, proven wallet addresses, `sid`, opt-in verified email per app (sealed, never stored); JWKS, staged signing key (Worker secret on testnet, AWS KMS before mainnet), Privy migration (approved 2026-10-30: D127; build steps 1–4, no email claim, D170–D175, review fixes D176–D179; merged, deployed on sandbox-dev 2026-11-02; step 7's KMS signer code on `feat/identity-token-7`: D215–D219, to confirm; step 8, the watchdog's JWKS pin check and outside probe (detection only), on `feat/identity-token-8`: D210–D214) |
| `email-login-build-plan.md` | The email login spec split into reviewable batches (order, scope, deploy steps, what users see after each); batch 1 = contract v3 (batches 1–5 merged; only batch 5's watchdog deployed; batch 6, the API and the sandbox-dev steps, on `feat/email-login-6`; batch 8a, plain email login in the popup, merged and live on sandbox-dev for the demo app; batches 7 and 8b, the path through `get_identity` and automatic linking, on `feat/email-login-8b`) |
| `apple-login-spec.md` | **Paused, not built (D160):** Sign in with Apple (D124), Q1–Q5 answered: provider `apple` verified on chain (RS256, Apple's JWKS through the delayed key changes and the watchdog), every Apple client in Hana's developer team (team-scoped `sub`), no Apple scopes at launch so no email on chain, first-login screen and explicit linking, an optional email-only second client for matching (draft, 18 open questions) |
| `hana-embed-ckd-results.md` | PoC measurements from wend-widget-demo |

## Where to put new knowledge

- A new or changed behaviour: the reference doc that covers it, in the same branch.
- A decision made in conversation: a new entry in `decisions.md`.
- A new security property, key or open issue: `security.md`.
- A new command, deploy step or failure mode: `operations.md`.
- A new watchdog alert kind or incident scenario, or a changed recovery step: a playbook in `packages/playbooks`, then
  `corepack pnpm --filter @hana-id/playbooks gen-docs` (a test fails when `playbooks.md` is stale or an alert kind has
  no playbook).
