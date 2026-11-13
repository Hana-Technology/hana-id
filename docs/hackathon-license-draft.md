# Licence options for the public repository (draft for the founder's decision)

The NEAR HACKATHON rules, read 2026-11-13: Q-014 "License? Any. MIT is fine. Repo stays public through judging; add a
LICENSE file." Q-013: "Team keeps all rights; organizers get non-exclusive promo rights to name, screenshots, video,
repo link." This page lists the options. No LICENSE file has been added: the founder has not chosen one (2026-11-13,
D747), `TODO(submit)`.

Last verified against code: 2026-11-13 (branch `docs/hackathon-submission`, against `develop` @ 35bc103e: no
`LICENSE` file at the root or in any package; the four SDK packages, `@hana-id/core`, `@hana-id/web`, `@hana-id/react`
and `@hana-id/sodax`, are at version 0.4.1 with `"license": "UNLICENSED"` and `"private": true`; no other
`package.json` and no `Cargo.toml` has a `license` field; `docs/operations.md` "Releasing the SDK packages" lists the
registry and the licence as open).

## What is true today

- The repository has no LICENSE file, so by default nobody else may copy, change or redistribute the code, even once
  it is public (GitHub's terms let people view and fork it on GitHub only).
- `packages/core`, `packages/web`, `packages/react` and `packages/sodax` (SDK 0.4.1, D790) say
  `"license": "UNLICENSED"` and are not published: partners get `pnpm pack` tarballs with their `SHA256SUMS` (D706,
  `docs/operations.md` "Releasing the SDK packages").
- Third-party material in the repository keeps its own licence: the Archivo, IBM Plex Sans and IBM Plex Mono fonts
  (SIL Open Font License 1.1: `packages/brand/fonts/OFL-Archivo.txt`, `OFL-IBMPlexSans.txt`, `OFL-IBMPlexMono.txt`,
  shipped beside the fonts by every page that uses them), the disposable-domain list (`packages/email/README.md` names
  its source and pin), and code ported from `near/mpc` at `a7ae426` in `packages/core/src/ckd.ts` (by way of
  `legacy/client/ckd.ts`): check `near/mpc`'s licence and keep its notice if the chosen licence requires one. The
  Sputnik DAO wasm is downloaded by the tests (`contracts/sputnik/pin.json`), not stored here.

## Options

| Option | What others may do | Fits the rules | Consequences for Journear |
|---|---|---|---|
| **A. A source-available notice** (an "All rights reserved" LICENSE that lets people view and run the code to evaluate it, and nothing else) | Read it, clone it, run it locally to check it; no reuse | Yes: "any" licence, and a LICENSE file exists | Keeps every right; the SDK can be licensed separately later. Judges and screening agents can still clone and run it |
| **B. MIT** | Anything, with the copyright notice kept | Yes (named in the rules) | Anyone may reuse the contract, the vault and the SDK, including competitors; cannot be taken back for the versions already published |
| **C. Apache-2.0** | Anything, with the notice kept; adds an explicit patent grant and a patent-retaliation clause | Yes | As B, plus the patent grant |
| **D. A copyleft or delayed licence** (AGPL-3.0, or the Business Source License with a change date) | Reuse only on the licence's terms: AGPL requires sharing changes, including for network use; BUSL forbids production use until its change date | Yes | Discourages closed reuse; BUSL is not open source until the change date; both are unusual for an SDK partners embed |

A mixed choice is also possible: for example option A for the repository and MIT for the four SDK packages, each
package with its own `LICENSE` in its `files`.

## Draft text for option A (for the founder to edit or replace)

```text
Copyright (c) 2026 <the legal entity>. All rights reserved.

This repository is published for review, including the NEAR HACKATHON judging. You may view the source, clone it
and run it locally to evaluate it. No other right is granted: you may not copy, modify, distribute, sublicense or
use it in production without written permission from <the legal entity>.

Third-party components keep their own licences (see the files and READMEs that ship with them).

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND.
```

`TODO(submit)`: the exact legal entity's name (the GitHub organisation is `Hana-Technology` and the product is
Journear Passport; neither is necessarily the entity). For B or C, use the standard text from
<https://choosealicense.com> unchanged, with that name and the year.

## When the founder decides

1. Add `LICENSE` at the repository root with the chosen text.
2. If the SDK packages should match, change their `license` field from `UNLICENSED` to the SPDX id and add the file to
   each package's `files` (a change to `packages/*`, with its own branch, the SDK checks and a version bump).
3. Record the decision in `docs/decisions.md` (D747), and remove the `TODO(submit)` on the licence in `README.md`,
   `docs/hackathon.md` and `docs/hackathon-public-checklist.md`.
