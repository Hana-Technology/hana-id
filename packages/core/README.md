# @hana-id/core

The pure TypeScript core of Journear Passport (no DOM): byte layouts, NEAR MPC confidential key derivation, derivation
v1, the Stellar, EVM and NEAR signers, the approval decoders, the auto-approve policy validator and the protocol
message schemas. `@hana-id/web`, `@hana-id/react` and `@hana-id/sodax` depend on it, and Journear Passport's own pages
are built from it.

> **Renamed.** Hana ID is now called **Journear Passport**. Only the names you and your users read changed (error
> messages among them). The package names (`@hana-id/*`), the exported names, error codes and every signed or hashed
> format are unchanged, so no code change is needed.

Partner apps don't need to import it to integrate; install it with the other `@hana-id` packages (they depend on it).

## Install

The packages aren't on a registry yet. Journear sends you the tarballs with their SHA-256 checksums: check them, then
install them together:

```sh
npm install ./hana-id-core-0.4.1.tgz ./hana-id-web-0.4.1.tgz
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
| `@hana-id/core/near` | NEAR's borsh codec (`encodeNearDelegateAction`, `encodeNearTransaction`, `encodeNep413Message`, the decoders), hashes (`nep413Hash`, …) and `nearDelegateNonce`, the nonce of a delegate action Hana will sign for a test app (also in the root entry) |
| `@hana-id/core/support-id` | `supportIdFromSub` on its own (also in the root entry) |
| `@hana-id/core/mainnet-demo-prices` | the price book of Journear's sandbox mainnet demo: its floor and ceiling per asset and the strict check of a book (no other imports) |

The `signers/stellar` and `decode` declarations reference Node's `Buffer` through `@stellar/stellar-base`: if you
import those in TypeScript, add `@types/node` or keep `skipLibCheck` on.

The one most partners use: check an auto-approve policy before sending it to Journear, with the same validator
the Journear Passport vault runs.

```ts
import { validateAutoApprovePolicy } from '@hana-id/core/policy';

const r = validateAutoApprovePolicy(JSON.parse(text), { sessionTtlMs: 12 * 3_600_000 });
if (!r.ok) console.log(r.problems); // else r.policy is the normalized policy Journear Passport will register
```

The policy format is in the Journear Passport partner guide (section 9; ask Journear for the current copy).

For NEAR (0.4.0), build the bytes `hana.near.signDelegateAction` signs, with no NEAR SDK. Read the key's nonce and
the height from `hana.near.activate()` or a NEAR RPC's `view_access_key`; the receiver must be one Journear Passport's relay
allowlists (the partner guide's section 8 has the whole flow):

```ts
import { nearImplicitPublicKey, utf8 } from '@hana-id/core';
import { encodeNearDelegateAction, nearDelegateNonce } from '@hana-id/core/near';

const delegateAction = encodeNearDelegateAction({
  senderId: accountId, // hana.near.accountId
  receiverId: contract,
  actions: [{ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text })), gas: 10_000_000_000_000n, deposit: 0n }],
  nonce: nearDelegateNonce({ keyNonce, blockHeight }), // above the key's nonce and recent enough for Journear Passport's check
  maxBlockHeight: blockHeight + 600n,                  // about 6 minutes
  publicKey: { type: 'ed25519', bytes: nearImplicitPublicKey(accountId) },
});
```

The other one, for partner backends: the user's Support ID (`HANA-XXXX-XXXX`, what `hana.supportId` shows) from the
identity token's `sub`, to show beside your own records. It needs no key: the `sub`'s base64url decoded to 16 bytes,
the first 5 in Crockford base32 (most significant bit first, uppercase), split 4 + 4.

```ts
import { supportIdFromSub } from '@hana-id/core/support-id';

supportIdFromSub('u1_ASNFZ4mrze8BI0VniavN7w'); // 'HANA-04HM-ASW9'; a TypeError for anything that isn't a sub
```

## Third-party code

The CKD client (the app key, `decryptCkd`, `ckdAppId` and the pairing check) is ported from
[near/mpc](https://github.com/near/mpc) at commit `a7ae426ec6708969797c5ea9e5d4e5e84c3068f4`
(`crates/ckd-example-cli/src/ckd.rs`, `crates/near-mpc-crypto-types/src/kdf.rs`,
`crates/contract/src/primitives/ckd.rs`). near/mpc is under the MIT License:

```text
MIT License

Copyright (c) 2025 NEAR One Limited.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
