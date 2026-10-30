# Docs index

Two kinds of doc live here. **Reference docs** describe the system as it is now and are updated in the same branch as
any change they cover (rule in `CLAUDE.md`). **Specs** describe what a batch set out to change; they are history once
the batch merges, so where a spec and a reference doc disagree, the reference doc (and the code) wins.

## Reference (current state)

| Doc | Answers |
|---|---|
| `architecture.md` | What the parts are, how they talk, each flow step by step, key derivation, where data lives, glossary |
| `security.md` | Who is trusted for what, what each compromise gives, key and secret inventory, invariants, open issues |
| `contract-interface.md` | `hana-signer` methods, types, byte layouts, events, panics |
| `api.md` | Every HTTP endpoint, auth, errors, rate limits; D1 schema, Durable Objects, bindings, request logs |
| `integration.md` | Partner guide: getting an app, `createHana`, page requirements, Google client, app settings, signing, auto-approve, React, Sodax, test and live keys, errors |
| `operations.md` | Setting up and deploying an environment, Google clients, key rotation, smoke tests, the hosted demo, logs, common failures |
| `playbooks.md` | Step-by-step recovery for every watchdog alert kind and every incident (signals, impact, steps with who acts, commands, verify); generated from `packages/playbooks` (D126), the same source as the admin portal's "Security & monitoring" playbooks |
| `decisions.md` | Every decision: when, why, what was rejected, status |
| `context.md` | Project background, batch B status, testnet measurements, next steps |
| `../envs/README.md`, `../apps/api/README.md`, `../apps/smoke/README.md`, `../apps/e2e/README.md`, `../apps/demo/README.md` | Per-package quick starts (`apps/demo`: the hosted testnet demo for colleagues) |
| `../packages/{core,web,react,sodax}/README.md` | The partner-facing READMEs shipped in the SDK tarballs (install, minimal usage) |

## Specs (history)

| Doc | Batch |
|---|---|
| `batch-a-spec.md` | A: isolation (contract registry, API, environments) |
| `batch-a2-shared-client.md` | A.2: shared Google client, sessions, follow-up fixes |
| `batch-b-spec.md` | B: browser SDK, vault, one-transaction login, auto-approve policies (merged on `feat/batch-b`) |
| `batch-c-spec.md` | C: developer dashboard (draft for implementation review; D34 MVP cut and D73–D75 folded in) |
| `batch-c-build-plan.md` | C: the spec split into mergeable batches C1–C17, milestones and the setup steps (C1 on `feat/batch-c-1`) |
| `governance-spec.md` | Pre-mainnet governance (D33): delayed issuer keys with a watchdog, multisig owner, timelocked upgrades, pause (draft, for review) |
| `hana-home-spec.md` | Pre-mainnet Hana Home (D40, D45): cross-app wallets and key export for shared-login apps, consent revocation from any device (draft, for review) |
| `email-login-spec.md` | Pre-mainnet email login (D4): Hana-run email issuer (Worker-secret key on testnet, AWS KMS before mainnet, two-signer-ready), automatic Privy-style account linking with pseudonymous ids on chain, explicit `linkAccount` (approved 2026-10-30: D119, D121–D123; not built) |
| `identity-token-spec.md` | Pre-mainnet partner identity token (D120): a ≤ 1 h ES256 JWT for partner backends with a per-scope pseudonymous `sub`, proven wallet addresses, `sid`, opt-in verified email per app (sealed, never stored); JWKS, staged signing key (Worker secret on testnet, AWS KMS before mainnet), Privy migration (draft, 16 open questions) |
| `native-apps-spec.md` | Native iOS, Android and React Native / Expo partner apps: Hana's vault and approvals in the system browser sheet (`ASWebAuthenticationSession`, Auth Tab / Custom Tabs), a companion key in the app, verified https returns as app identity; app-held keys (Privy-style) and a Hana app analysed as later options; no contract or derivation change (draft, 18 open questions) |
| `hana-embed-ckd-results.md` | PoC measurements from wend-widget-demo |

## Where to put new knowledge

- A new or changed behaviour: the reference doc that covers it, in the same branch.
- A decision made in conversation: a new entry in `decisions.md`.
- A new security property, key or open issue: `security.md`.
- A new command, deploy step or failure mode: `operations.md`.
- A new watchdog alert kind or incident scenario, or a changed recovery step: a playbook in `packages/playbooks`, then
  `corepack pnpm --filter @hana-id/playbooks gen-docs` (a test fails when `playbooks.md` is stale or an alert kind has
  no playbook).
