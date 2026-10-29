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
| `decisions.md` | Every decision: when, why, what was rejected, status |
| `context.md` | Project background, batch B status, testnet measurements, next steps |
| `../envs/README.md`, `../apps/api/README.md`, `../apps/smoke/README.md`, `../apps/e2e/README.md`, `../apps/demo/README.md` | Per-package quick starts (`apps/demo`: the hosted testnet demo for colleagues) |

## Specs (history)

| Doc | Batch |
|---|---|
| `batch-a-spec.md` | A: isolation (contract registry, API, environments) |
| `batch-a2-shared-client.md` | A.2: shared Google client, sessions, follow-up fixes |
| `batch-b-spec.md` | B: browser SDK, vault, one-transaction login, auto-approve policies (merged on `feat/batch-b`) |
| `batch-c-spec.md` | C: developer dashboard (draft; the MVP cut is `decisions.md` D34, not yet folded in) |
| `hana-embed-ckd-results.md` | PoC measurements from wend-widget-demo |

## Where to put new knowledge

- A new or changed behaviour: the reference doc that covers it, in the same branch.
- A decision made in conversation: a new entry in `decisions.md`.
- A new security property, key or open issue: `security.md`.
- A new command, deploy step or failure mode: `operations.md`.
