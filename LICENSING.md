# Licensing

This repository is Journear Passport, licensed by Hana Tech Pty Ltd. Its working name `hana-id` appears in the
packages, the code and the testnet accounts. Most of it is under the Business Source License 1.1 ([`LICENSE`](LICENSE)),
three of the SDK packages that partners install are under the Apache License 2.0, and third-party material keeps its
own licence. This page lists what is not under `LICENSE`. Anything not listed here is under `LICENSE`.

## Under the Business Source License 1.1 (`LICENSE`)

Everything not listed below: the contracts, the API and every other Worker, the vault, sign-in, approval, export and
Passport Home pages, the consoles, the scripts, the tests, the docs and `legacy/`. `LICENSE` sets the parameters:

- **Additional Use Grant:** production use on blockchain test networks whose tokens have no monetary value, as long as
  it is not used with a network whose tokens have monetary value and is not offered to third parties as a commercial
  hosted or managed service.
- **Non-production use:** testing, evaluation and development are allowed anywhere by the licence itself.
- **Change Date and Change License:** on 2030-11-14 this code changes to the Apache License 2.0.

`packages/core` (`@hana-id/core`) is under this licence too (`"license": "BUSL-1.1"`; decided 2026-11-13, D747): it
holds the key derivation, the approval decoders and the policy engine that the service is built on. The Apache-2.0
packages below depend on it, so production use of the SDK needs an agreement with the Licensor; use on test networks
is covered by the Additional Use Grant.

## Under the Apache License 2.0

| Package | Licence file | What it covers |
|---|---|---|
| `packages/web` (`@hana-id/web`) | [`packages/web/LICENSE`](packages/web/LICENSE) | What the npm package ships: `src/client/`, `src/create-hana.ts`, `src/hana-env.ts`, `src/index.ts`, `src/stellar-wallets-kit.ts`, `src/version.ts` and the generated `src/envs.generated.ts`, as built into `dist/lib/`. The rest of `packages/web` is not in the package and stays under `LICENSE`: the vault (`src/vault/`), the sign-in, approval, export and Passport Home pages (`src/auth/`) and their page builds |
| `packages/react` (`@hana-id/react`) | [`packages/react/LICENSE`](packages/react/LICENSE) | the whole package |
| `packages/sodax` (`@hana-id/sodax`) | [`packages/sodax/LICENSE`](packages/sodax/LICENSE) | the whole package |

## Third-party material, under its own licence

| What | Where | Licence |
|---|---|---|
| The Archivo, IBM Plex Sans and IBM Plex Mono fonts (Fontsource 5.3.0) | `packages/brand/fonts/`, `apps/admin/public/fonts/` | SIL Open Font License 1.1, in the `OFL-*.txt` files beside them |
| The Unicode age table, derived from the Unicode Character Database's `DerivedAge-18.0.0.txt` | `packages/email/src/unicode-age.ts` | Unicode License v3; its notice is kept in `packages/email/LICENSE-Unicode.txt` |
| The CKD client, ported from [near/mpc](https://github.com/near/mpc) at `a7ae426` | `packages/core/src/ckd.ts` (and its source, `legacy/client/ckd.ts`) | MIT License, Copyright (c) 2025 NEAR One Limited; its notice is kept in `packages/core/LICENSE-near-mpc.txt` |
| The disposable-address domain list from `disposable-email-domains/disposable-email-domains` | `packages/email/src/disposable-domains.ts` | CC0 1.0 Universal |

The packages installed from npm and Cargo come with their own licences. They are not stored here.

## Names and logos

Neither licence grants any right in the names "Journear", "Journear Passport" or "Hana", or in their logos and marks.
That includes the Journear mark in `packages/brand` and the wallet-picker icon in `packages/web/src/client/icon.ts`.
Both licences say so: the Business Source License in its terms, and the Apache License 2.0 in section 6.
