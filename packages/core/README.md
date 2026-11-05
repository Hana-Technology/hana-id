# @hana-id/core

The pure TypeScript core of Hana ID (no DOM): byte layouts, NEAR MPC confidential key derivation, derivation v1,
the Stellar and EVM signers, the approval decoders, the auto-approve policy validator and the protocol message
schemas. `@hana-id/web`, `@hana-id/react` and `@hana-id/sodax` depend on it, and Hana's own pages are built from it.

Partner apps don't need to import it to integrate; install it with the other Hana packages (they depend on it).

## Install

The packages aren't on a registry yet. Hana sends you the tarballs; install them together:

```sh
npm install ./hana-id-core-0.2.0.tgz ./hana-id-web-0.2.0.tgz
```

ESM only, with TypeScript declarations.

## Entry points

| Import | What |
|---|---|
| `@hana-id/core` | layouts, CKD, derivation, EVM signer, approval subjects, EIP-712, protocol schemas, `TEST_EVM_CHAINS` |
| `@hana-id/core/derivation` | derivation v1 (paths and HKDF info) |
| `@hana-id/core/signers/stellar` | the Stellar signers (pulls in `@stellar/stellar-base`, so it is a separate entry) |
| `@hana-id/core/decode` | the transaction and message decoders the approval popup uses |
| `@hana-id/core/policy` | the auto-approve policy validator and matcher |

The `signers/stellar` and `decode` declarations reference Node's `Buffer` through `@stellar/stellar-base`: if you
import those in TypeScript, add `@types/node` or keep `skipLibCheck` on.

The one most partners use: check an auto-approve policy before sending it to Hana, with the same validator Hana's
vault runs.

```ts
import { validateAutoApprovePolicy } from '@hana-id/core/policy';

const r = validateAutoApprovePolicy(JSON.parse(text), { sessionTtlMs: 12 * 3_600_000 });
if (!r.ok) console.log(r.problems); // else r.policy is the normalized policy Hana will register
```

The policy format is in Hana's partner guide (`docs/integration.md` in the private Hana ID repository, section 9;
ask Hana for a copy).
