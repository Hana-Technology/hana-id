# Journear Passport (code name Hana ID)

Journear Passport gives each user of a partner app a wallet when they sign in with Google or with a code sent to their
email, with no seed phrase and no browser extension. The NEAR contract `hana-signer` checks the sign-in token on chain
and asks NEAR's MPC network for that user's key through Confidential Key Derivation (CKD); the MPC's answer is
encrypted to a one-time key that only the user's browser holds. The browser turns that secret into the user's NEAR,
Stellar and EVM keys, and NEAR transactions can go through a Journear relayer that pays the gas (NEP-366 meta
transactions), so a new user's first NEAR transaction needs no NEAR.

**Testnet only.** Every account is a throwaway, and wallets derived on them are disposable. Package and identifier
names are still `hana-*` (the code name); the product, its pages and its emails say "Journear Passport".

## For judges and screening agents (NEAR HACKATHON)

Written to be checked: every claim below names a file and a way to check it. `TODO(submit)` marks what the team fills
in before submitting. The detail (each event rule and where it is met, the full library list, the tracks against their
prompts) is in [`docs/hackathon.md`](docs/hackathon.md). The developer reference starts at
[Developer reference](#developer-reference).

### What NEAR does here, and where to check it

| Claim | Code | How to check |
|---|---|---|
| The contract verifies Google's RS256 ID token on chain | `contracts/hana-signer/src/issuers.rs` `verify_token` → `src/oidc.rs` `verify_signature` → `verify_rs256` (RSASSA-PKCS1-v1_5, SHA-256, modular exponentiation with `num-bigint`), reached from `create_session` and `create_session_and_derive` in `src/sessions.rs` | `cd contracts/hana-signer && cargo test --locked rejects_non_rs256`; the `get_issuer` view below lists the issuers it trusts |
| It verifies the email issuer's token on chain too | `contracts/hana-signer/src/self_issued.rs` `verify_self_issued_signatures` (JWS JSON, RS256 per signature, a signer policy), through the same `verify_token` | `get_issuer` with `{"provider":"email"}` below; `contracts/integration-tests/tests/email.rs` |
| Each partner app has its own scope; the user's path is `{scope_id}#{provider}#{sub}#{key_index}` | `contracts/hana-signer/src/registry.rs` (`scope_for_client`, `get_scope`), `src/sessions.rs` | `get_scope` with `{"scope_id":"s2"}` below (the hosted demo's app) |
| It asks NEAR's MPC for the user's key (CKD) | `contracts/hana-signer/src/sessions.rs` `derive_with` → `request_app_private_key` (declared with `#[ext_contract(mpc_contract)]` in the same file) on `v1.signer-prod.testnet`, CKD domain 2 (`mpc`, `ckdDomainId` in `envs/sandbox-dev.json`) | the receipts of a login transaction below show `request_app_private_key` on `v1.signer-prod.testnet`; `cargo test --locked derive_key_calls_the_mpc_with_the_session_path` |
| The MPC's answer is encrypted to a key only the browser holds | `packages/core/src/ckd.ts` `newAppKey` (a random BLS12-381 scalar made in the browser) and `decryptCkd` (decrypts and checks a pairing against the pinned MPC key, `ckdNetworkKey` in `envs/sandbox-dev.json`); used by the vault, a hidden iframe on Journear's own origin, in `packages/web/src/vault/login.ts` | `corepack pnpm --filter @hana-id/core exec vitest run test/ckd.test.ts` |
| One CKD secret gives a key per chain; NEAR's is an Ed25519 key and the account is its implicit account (64 hex) | `packages/core/src/derivation.ts` (HKDF-SHA256; `nearSeed`, the tuple `("near", "ed25519", account)`), golden vectors `packages/core/test/vectors/derivation-v1-near.json` | `corepack pnpm --filter @hana-id/core exec vitest run test/derivation-near.test.ts` |
| NEAR transactions, NEP-366 delegate actions and NEP-413 messages are decoded and shown in Journear's approval window, then signed in the vault | `packages/core/src/near/` (`codec.ts`, `sign.ts`), `packages/web/src/vault/near.ts`, `packages/web/src/auth/render-approval.ts`; the SDK's `hana.near.*` in `packages/web/src/client/near.ts` | `corepack pnpm --filter @hana-id/core exec vitest run test/near-codec.test.ts test/near-approval.test.ts` |
| A relayer pays for the user's NEAR calls, only for allowlisted contracts | `apps/api/src/near/relay.ts` (`POST /v1/near/activate`, `POST /v1/near/relay`), `apps/api/src/near/delegate.ts` `policyRefusal` (the sender is the key's own implicit account, FunctionCall actions only, zero deposit, the receiver in `near.relay.receivers`, a gas cap); sandbox-dev's only receiver is the guestbook | `corepack pnpm --filter @hana-id/api exec vitest run test/near-relay.test.ts`; on a real local NEAR node: `apps/api/test-sandbox/meta-tx.test.ts`; on testnet: the two transactions below |
| A demo contract the user writes to without holding NEAR | `contracts/hana-guestbook/src/lib.rs` (`add_message`, `get_messages`, `total_messages`; no owner, no upgrade path), at `near.demoGuestbook` in `envs/sandbox-dev.json`, its keys deleted on 2026-11-12 | the view calls below; `cd contracts/hana-guestbook && cargo test --locked`; `contracts/integration-tests/tests/guestbook.rs` |
| The contract's owner is a Sputnik DAO council with public delays | `contracts/hana-signer/src/governance.rs`; the DAO's code pinned in `contracts/sputnik/pin.json` | `get_config` below: `owner` is `hana-id-council-dev1.sputnikv2.testnet` |
| Logins are paid for by Journear's relayer account | `apps/api` signs `create_session_and_derive` with the relayer's function-call keys (manifest `relayer`) | the transaction list below: signer `hana-id-relayer-dev1.testnet` |

### Reproduce it

**A. On the hosted testnet demo** (no setup): <https://hana-id-demo-sandbox-dev.tingtc.workers.dev> (`apps/demo`; NEAR
testnet, Stellar testnet, Base Sepolia). Use email sign-in: **Log in with Google** works only for Google accounts on
Journear's tester list, because the Google client is still in Google's testing mode; other accounts see Google's
"Access blocked".

1. Do: open the page. See: "Journear Passport demo" and the testnet banner.
2. Do: click **Log in with email**. In the Journear window ("Sign in with email"), type an address you can read and
   click **Send code**; type the 6-digit code from the email (from "Journear Passport (testnet)", subject starting
   `[SANDBOX]`) and click **Continue**. See: "Your addresses" with a Stellar testnet and an EVM address, and a card
   headed **NEAR** with your implicit account (64 hex characters; **Show the full account ID**, **View on NearBlocks
   ↗**). A new account reads "Not on NEAR testnet yet: your first guestbook write creates it (Journear’s relayer
   sends it a zero-value transfer), for free."
3. Do: under **Write to the guestbook**, type a message in **Your message** (1 to 200 characters) and click **Write to
   the guestbook (no NEAR needed)**. See: "Preparing your NEAR account…", then "Waiting for your approval in the
   Journear window…" and a Journear window headed "NEAR transaction, fee paid by a relayer", with **From** (your
   account), **To** (`hana-id-guestbook-dev1.testnet`), "Valid until block", "Nonce", and the call: **Calls**
   `add_message` on the guestbook, its arguments (your text), deposit 0, gas 10 Tgas. Move the mouse (Approve ignores
   clicks until then and for its first second), click **Approve**. See: "Sending it through Journear’s relayer, which
   pays the fee…", then "Written to the guestbook on NEAR testnet. … You paid no gas." with **View the transaction
   ↗**, and your message under **Latest messages**, marked "you".
4. Do: click **View the transaction ↗** (NearBlocks testnet). See: the signer is the relay account
   `hana-id-near-relay-dev1.testnet`, the action is `Delegate`, and the `add_message` receipt's predecessor is your
   account. Your account's balance stays 0.
5. Do: click **Sign a message (NEP-413)**, then **Approve** in the window headed "Sign in with your NEAR account". See:
   "NEAR message (NEP-413): signed" with Signature, Recipient (the demo's host), Account and Public key. Nothing is
   sent.
6. Do: click **Sign a transaction**, then **Approve** in the window headed "NEAR transaction". See: with 0 NEAR,
   "NEAR transaction (add_message on the guestbook): signed, not sent" with the signed transaction and its hash; it is
   sent (and linked) only when the account holds at least 0.01 NEAR for the fee.
7. Optional, the user's exit: open Passport Home, <https://hana-id-auth-sandbox-dev.tingtc.workers.dev/home>, click
   **Continue with email** and sign in with the same address. Under **Your apps**, click **View** on "Smoke B (shared
   only)" (the demo's app). See: "Your addresses" with the NEAR account. Under **Move this wallet to another wallet
   app**, click **Show how to move it**, then **Continue with a code**; after the code, the steps Verify, Understand,
   Export: "Your wallet is open", click **NEAR key**, read "Before you move a NEAR account", type `EXPORT`, click
   **Continue**, tick the box and click **Show key**. **Lock now** erases it. It is a testnet key: never fund it on
   mainnet.

The first run of steps 2 to 4 on testnet, 2026-11-12 (`docs/operations.md` "NEAR relay"), by a new email user: the
activation `H9kjLPrVbxfjFAvzRJh7mHxs5EetiBv9urLkbbhF8cHa` (a 0-yocto Transfer from the relay account creates the
user's implicit account `cceaf5d33b7b0fff98c15d9c3669dcfb2e0b2d1d20282382dcbfd3ad93d770c4`) and the write
`DjJAzarJpH3JsNQirQf97T1Jh2qAouebvKTfZm4u3UgX` (one `Delegate` action signed by the relay account; its `add_message`
receipt runs as the user's account). Check them, read-only:

```sh
for tx in H9kjLPrVbxfjFAvzRJh7mHxs5EetiBv9urLkbbhF8cHa DjJAzarJpH3JsNQirQf97T1Jh2qAouebvKTfZm4u3UgX; do
  curl -s https://archival-rpc.testnet.near.org -H 'content-type: application/json' \
    -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"EXPERIMENTAL_tx_status\",\"params\":{\"tx_hash\":\"$tx\",\"sender_account_id\":\"hana-id-near-relay-dev1.testnet\",\"wait_until\":\"FINAL\"}}" \
    | jq -c '{signer: .result.transaction.signer_id, receipts: [.result.receipts[] | {to: .receiver_id, by: .predecessor_id, call: (.receipt.Action.actions[0].FunctionCall.method_name // (.receipt.Action.actions[0] | if type == "object" then keys[0] else . end))}]}'
done
```

See: `{"signer":"hana-id-near-relay-dev1.testnet","receipts":[{"to":"cceaf5d3…","by":"hana-id-near-relay-dev1.testnet","call":"Transfer"},…]}`
and, for the write, `{"to":"cceaf5d3…","by":"hana-id-near-relay-dev1.testnet","call":"Delegate"},{"to":"hana-id-guestbook-dev1.testnet","by":"cceaf5d3…","call":"add_message"},…`
(account ids shortened here).

**B. View calls anyone can run** (read-only, public RPC; needs `curl` and `jq`, or [near CLI](https://github.com/near/near-cli-rs)).

```sh
RPC=https://rpc.testnet.near.org
view() { curl -s $RPC -H 'content-type: application/json' -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"query\",\"params\":{\"request_type\":\"call_function\",\"finality\":\"final\",\"account_id\":\"$1\",\"method_name\":\"$2\",\"args_base64\":\"$(printf '%s' "$3" | base64)\"}}" | jq -r '.result.result | implode'; }

# The guestbook: how many messages, and the latest (newest first)
view hana-id-guestbook-dev1.testnet total_messages '{}'
view hana-id-guestbook-dev1.testnet get_messages '{"limit":5}' | jq -c '.[]'
# It has no access key left, so nobody can change its code or its messages
curl -s $RPC -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":"1","method":"query","params":{"request_type":"view_access_key_list","finality":"final","account_id":"hana-id-guestbook-dev1.testnet"}}' | jq -c '.result.keys'

# The signer contract: owner, MPC account, CKD domain, the account allowed to pay for logins
view hana-id-signer-dev1.testnet get_config '{}' | jq -c '{owner, mpc, ckd_domain_id, sponsors, paused}'
# The issuers it checks tokens against, and the demo app's scope
view hana-id-signer-dev1.testnet get_issuer '{"provider":"google"}' | jq -c '{provider, iss_values, kids}'
view hana-id-signer-dev1.testnet get_issuer '{"provider":"email"}' | jq -c '{provider, iss_values, kids}'
view hana-id-signer-dev1.testnet get_scope '{"scope_id":"s2"}' | jq -c '{id, clients, allow_shared}'

# The same with near CLI
near contract call-function as-read-only hana-id-guestbook-dev1.testnet get_messages json-args '{"limit": 5}' network-config testnet now
```

See (2026-11-13): `2`; two messages by `cceaf5d3…` ("gm gm", "testing guestbook"; more once others write); `[]`;
`{"owner":"hana-id-council-dev1.sputnikv2.testnet","mpc":"v1.signer-prod.testnet","ckd_domain_id":2,"sponsors":["hana-id-relayer-dev1.testnet"],"paused":false}`;
`{"provider":"google","iss_values":["https://accounts.google.com","accounts.google.com"],"kids":[…]}` (Google's
current key ids, which rotate); `{"provider":"email","iss_values":["https://hana-id-email-issuer-sandbox-dev.tingtc.workers.dev/v1/email"],"kids":["v_H0YgrYDKczje-jsOa1eEdEWy9BECqRRCSp98pztsw","ziQVLEH8Qhqfq_d0XHUkC4GMIxvGoc0TlN0c7H4In_w"]}`
(the email issuer's two keys, as in `envs/sandbox-dev.json` `emailIssuer.publicKeys`);
`{"id":"s2","clients":[["email","email:s2"]],"allow_shared":true}`.

A login's transaction and its call to the MPC:

```sh
# The latest transactions to the signer contract (NearBlocks' public API)
curl -s 'https://api-testnet.nearblocks.io/v3/accounts/hana-id-signer-dev1.testnet/txns' \
  | jq -r '.data[] | "\(.transaction_hash) \(.signer_account_id) \(.actions[0].method)"' | head -5
# One of them by hash: its receipts (the archival RPC keeps old ones)
curl -s https://archival-rpc.testnet.near.org -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":"1","method":"EXPERIMENTAL_tx_status","params":{"tx_hash":"<hash>","sender_account_id":"hana-id-relayer-dev1.testnet","wait_until":"FINAL"}}' \
  | jq -c '[.result.receipts[] | {to: .receiver_id, method: .receipt.Action.actions[0].FunctionCall.method_name}]'
```

See: lines like `<hash> hana-id-relayer-dev1.testnet create_session_and_derive`, then
`[{"to":"hana-id-signer-dev1.testnet","method":"create_session_and_derive"},{"to":"v1.signer-prod.testnet","method":"request_app_private_key"},{"to":"v1.signer-prod.testnet","method":"return_ck_and_clean_state_on_success"},…]`.
The filter prints receivers and method names only: the arguments hold the user's sign-in token, public on chain by
design but with no reason to be on your screen. In a browser: <https://testnet.nearblocks.io/address/hana-id-signer-dev1.testnet>
and <https://testnet.nearblocks.io/address/hana-id-guestbook-dev1.testnet>.

**C. Locally** (no secrets, no testnet). Needs macOS or Linux, Node 22+ (24 tested), Git, `jq`; for the Rust steps
Rust through `rustup` (`contracts/hana-signer/rust-toolchain.toml` pins 1.85.1 with `wasm32-unknown-unknown`),
`cargo-near` 0.22.0 (`cargo install cargo-near --version 0.22.0 --locked`) and
[gitleaks](https://github.com/gitleaks/gitleaks) (`brew install gitleaks`). pnpm comes from Node's corepack.

1. Do:
   ```sh
   git clone https://github.com/Hana-Technology/hana-id.git && cd hana-id
   corepack enable                                    # pnpm 11.3.0, from package.json "packageManager"
   corepack pnpm install --frozen-lockfile
   corepack pnpm --filter @hana-id/e2e e2e:install    # once: Playwright's Chromium, Firefox and WebKit
   ```
   See: `Done in …s using pnpm v11.3.0`. The install also points `core.hooksPath` at `.githooks` (the gitleaks
   pre-commit hook).
2. Do: `corepack pnpm verify --all`. It runs, in phases: the lockfile check; gitleaks over the history; the typecheck
   of every package; `cargo test --locked` and the wasm build of `contracts/hana-signer` and `contracts/hana-guestbook`;
   every package's unit tests and the docs checks; the contracts on a local NEAR node (`contracts/integration-tests`,
   then the API's meta-transaction tests in `apps/api/test-sandbox`); the SDK pack check; Playwright on Chromium.
   `corepack pnpm verify --full` adds Firefox, WebKit and the dependency advisories (needs `cargo install cargo-audit
   --locked`). Leave `HANA_E2E_PORT_BASE` unset. See: a table with every step `pass`, then `total (wall clock) pass`,
   exit code 0. Measured 2026-11-13 on a
   16-core Apple M4 Max with Cargo's crates, `near-sandbox` and Playwright's browsers already downloaded:
   `total (wall clock) pass 11m25s` (the local NEAR node's tests 7m48s of it; Playwright on Chromium 142 passed, 1
   skipped). Allow longer on a machine that has to download them.
3. What the local runs simulate, and what is real:
   - `contracts/integration-tests` (`cargo test --locked -- --test-threads=8` there): the real `hana-signer` and
     guestbook wasm on a local NEAR node (near-workspaces starts `near-sandbox`, downloaded on first use), RSA test
     keys standing in for Google and the email issuer, and `contracts/mock-mpc` standing in for the MPC (it records each
     `request_app_private_key` and answers with fixed bytes; it does not run CKD). Real: the contracts, NEAR's runtime,
     gas, keys, receipts, delegate actions.
   - `corepack pnpm --filter @hana-id/e2e e2e`: Journear's real browser bundles (vault, sign-in, approval, export,
     Passport Home) and the real API and email issuer Worker code in Node, in three browsers. NEAR is a mocked
     JSON-RPC (`apps/e2e/src/server/chain.ts`), not a node; the MPC is a test key in the same file, real BLS12-381, so
     the browser's CKD decryption and pairing check run for real; Google is an OIDC stub inside each browser context
     (`apps/e2e/src/google-stub.ts`); email codes go to a local outbox. The demo's gasless guestbook write runs in
     `tests/demo.spec.ts` against a relayer the test routes (2026-11-13, Chromium: `6 passed`). Details:
     [`apps/e2e/README.md`](apps/e2e/README.md).
4. To click through the demo on that stack yourself (email sign-in; the Google stub exists only inside Playwright):
   ```sh
   corepack pnpm --filter @hana-id/e2e serve     # builds, then serves; wait for "[e2e] stack ready"
   curl -s -X POST http://127.0.0.1:4440/__e2e/apps -H 'content-type: application/json' \
     -d '{"name":"Journear Passport demo","origins":["http://localhost:4412"],"publishableKey":"pk_test_DemoE2eDemoE2eDemoE2e","loginMethods":"google,email"}'
   # open http://localhost:4412, click "Log in with email", type any address, then read the code:
   curl -s 'http://127.0.0.1:4442/__e2e/outbox?to=<the address, lowercased>'
   ```
   See: `{"appId":"app_e2e_…","pk":"pk_test_DemoE2eDemoE2eDemoE2e"}`; on the page, the Journear window, and after the
   code the Stellar and EVM addresses and the NEAR card with the account. The stack runs no NEAR relay, so by hand the
   gasless write answers "Journear’s relayer isn’t set up on this environment yet." (`503 relayer_unconfigured`);
   step 3's spec routes a relayer instead. Ports are 4410 to 4460 in a plain clone (a linked git worktree gets its own
   base, `apps/e2e/src/checkout-port.ts`); stop it with Ctrl-C.

### What was built in the hackathon window

- The window (rule Q-001): code from the announcement on 2026-10-19 to 2026-11-14 counts; earlier commits are baseline.
- This repository's first commit, `e0c831fc`, is dated 2026-10-26 13:43 +08:00. No commit on any branch has an
  earlier date. On 2026-11-13, `develop` (35bc103e) has 1,181 commits and the 231 branches on GitHub together 1,187, every
  one dated 2026-10-26 to 2026-11-12. Check: `git log --reverse --format='%h %ad %s' --date=iso | head -3`,
  `git rev-list --count develop`, `git log --format=%ad --date=short develop | sort | uniq -c`.
- `TODO(submit): baseline statement, pending the rule check`
- What was built when (dates from `git log`; each line's decisions in [`docs/decisions.md`](docs/decisions.md)):
  - 2026-10-26 to 10-30: the per-app scope registry in `hana-signer`, the API Worker, deploy and admin scripts, the
    sandbox tests; the browser SDK packages (10-28) and the vault with one-transaction login (deployed on sandbox-dev
    2026-10-29); the Sputnik DAO governance (on sandbox-dev since 10-30).
  - 2026-11-02 to 11-06: email login (the email issuer Worker 11-02, live on sandbox-dev 11-03; the contract's
    self-issued token check); the partner console and the staff admin (batch C).
  - 2026-11-09 to 11-10: Passport Home (the user's own page: key export, devices, consents, an exit sign-in path).
  - 2026-11-11 to 11-12: NEAR as a wallet chain (derivation, signing, the approval window's NEAR screens), the wallet
    directory's NEAR rows, the meta-transaction relay, the guestbook contract and the demo's NEAR card; merged and
    deployed to sandbox-dev on 2026-11-12 with the Journear Passport rename, "Move this wallet" for the NEAR key, the
    admin's NEAR relay tile and SDK 0.4.1.
- The diff for the window: <https://github.com/Hana-Technology/hana-id/compare/e0c831fc...develop>. With the tags the
  rules name (Q-003), `TODO(submit)`: <https://github.com/Hana-Technology/hana-id/compare/pre-hackathon...hackathon-submission>.

### What is judged, and the other chains (rule Q-002)

The whole repository is submitted; the NEAR integration is what is judged: the `hana-signer` contract (on-chain checks
of Google's and the email issuer's tokens, the scope registry, sessions, the CKD request to NEAR's MPC, governance by a
Sputnik DAO council), the browser's CKD decryption, the NEAR wallet (derivation, the implicit account, transaction,
delegate-action and NEP-413 signing behind the approval window), the gasless relay, the guestbook and the demo's NEAR
card. **Other chains, disclosed:** the same CKD secret also gives each user a Stellar and an EVM wallet (Stellar
testnet, Base Sepolia and other EVM testnets), and `packages/sodax` adapts Sodax's cross-chain SDK to those wallets.
They are part of the product and of this repository, built in the same window, and are not NEAR integrations.

### AI tools and third-party code (rule Q-005)

- **AI.** This repository is built with AI coding agents. Its code, tests and docs were written by Claude Code
  (Anthropic's coding agent) sessions, directed and reviewed by the developer; `CLAUDE.md` holds the agents' project
  rules. 120 of the 1,181 commits on `develop` carry a `Co-Authored-By: Claude` trailer
  (`git log -i --grep='Co-Authored-By: Claude' --oneline develop | wc -l`); the others were made the same way without
  one. Treat all of it as AI-written.
- **Third-party code that matters** (the full list with versions: [`docs/hackathon.md`](docs/hackathon.md)):
  `near-sdk` 5.9, `num-bigint`, `borsh`, `serde` in the contracts; `near-workspaces` 0.23 (with `near-sandbox`),
  `rsa`, `ed25519-dalek` in the sandbox tests; `@near-js/crypto`, `@near-js/transactions`, `@near-js/utils` in the API,
  the watchdog and the scripts (and as the reference the NEAR codec is tested against); `@noble/curves` (BLS12-381,
  Ed25519, secp256k1) and `@noble/hashes`; `@scure/base`; `@stellar/stellar-base`; `viem`; `@sodax/types`; Cloudflare
  Workers, Durable Objects and D1 through `wrangler`; Neon Postgres (`pg`, `@electric-sql/pglite` in tests); `zod`;
  `jose`; React and Vite; Playwright and Vitest; the Archivo and IBM Plex fonts (SIL Open Font License). Services: NEAR
  testnet and its MPC network (`v1.signer-prod.testnet`), the Sputnik DAO v2 factory (`sputnikv2.testnet`, code pinned in
  `contracts/sputnik/pin.json`), public NEAR RPCs, Google OAuth, SendGrid for email codes.
- `packages/core/src/ckd.ts` started as a port of `legacy/client/ckd.ts`, itself ported from `near/mpc` at `a7ae426`
  (its first lines say so).
- **Licence:** `TODO(submit)`: the rules ask for a LICENSE file (Q-014); none is chosen yet. The options:
  [`docs/hackathon-license-draft.md`](docs/hackathon-license-draft.md).

### Tracks

`TODO(submit)`: the team picks the tracks for the form. The case for each, against its example prompt
([`docs/hackathon.md`](docs/hackathon.md) has the prompts' wording):

| Track | What the demo shows | Where | What it does not meet |
|---|---|---|---|
| Real-World Money (`realworld`) | A user who never held NEAR writes to a NEAR contract through an NEP-366 meta transaction that Journear's relayer pays for, and the relayer pays only for calls to an allowlisted contract (the prompt's "a meta transaction relayer that only pays for calls to our own contract"); each write links to its transaction | `apps/api/src/near/relay.ts`, `delegate.ts`; `apps/demo/src/near-card.ts` | No stablecoin, invoice, payroll or NEAR Intents on NEAR; testnet only. Test USDC can sit in the Stellar and EVM wallets, which are not NEAR |
| Games With Real Economies (`games`) | Sign-in with an email code or Google gives a player a wallet with no seed phrase and no extension; the first NEAR action needs no NEAR and no gas prompt | `packages/web/src/auth/`, `packages/web/src/vault/login.ts`; the contract's token check above | Journear Passport is a login and wallet layer, not a game: no game loop, NPCs or NEP-245 items. Every NEAR signature opens Journear's approval window (auto-approve rules exist for Stellar and EVM only), so the prompt's "no wallet popups" is not met |
| Open Innovation (`open`) | The decision "this person may have this key" is made by a public NEAR contract that checks Google's or the email issuer's signature itself; the key comes from NEAR's MPC encrypted to the browser; one sign-in gives wallets on NEAR, Stellar and EVM; failure cases are written down (`docs/system-overview.md` sections 4b to 4g and 5, `docs/security.md` "Known open issues") | `contracts/hana-signer`, `packages/core/src/ckd.ts`, `packages/core/src/derivation.ts` | Testnet MPC; Journear serves the pages that run the key code, so a malicious deploy of them could take keys (below) |

### Security and limits

1. Testnet only: the manifest schema accepts only `testnet` (`packages/env/src/schema.ts`), and the hosted demo signs
   only for NEAR testnet, Stellar testnet and Base Sepolia (`apps/demo/src/config.ts` refuses mainnet settings).
2. The relayer pays only for FunctionCalls with zero deposit to the contracts in `near.relay.receivers` (sandbox-dev:
   the guestbook only), within budgets: 5 NEAR a day for the env, 1 NEAR a day per app, 50 relays a day per sender,
   200 activations a day per app (`envs/sandbox-dev.json` `near.relay`). Past them it answers 503 until 00:00 UTC.
3. Every NEAR signature opens Journear's approval window and needs Approve; nothing NEAR is signed automatically. The
   window decodes the exact bytes; Approve ignores clicks for its first second and until a pointer move or a focus key
   (`packages/web/src/auth/approve-guard.ts`). It shows what is called with what; it cannot say what an unknown
   contract will do.
4. A user's NEAR account is an implicit account: it exists on chain only after a first transfer (the relayer's
   activation sends 0 NEAR), and the exported NEAR key is the account itself.
5. Journear serves the vault and approval pages; a malicious deploy of them could read keys of users who load it. This
   is open (`docs/security.md` "Known open issues").
6. Email login trusts Journear's email issuer: one signer, whose key on testnet is a Worker secret, and that key could
   open any email wallet.
7. On testnet the signer account still has a full-access key (`allowSignerFullAccessKey`), and the council's three
   member keys are held by one person, with 60-second delays (`envs/sandbox-dev.json`).
8. Email codes for the demo's app are limited to about 100 a day (its plan's share of the env's 200-mail daily
   budget); Google sign-in is limited to listed testers.
9. One exception to testnet exists elsewhere: Journear staff can let a test app sign real Base and Stellar transactions
   of up to $9.99 each for a Sodax demo (`docs/decisions.md` D428); the demo's app has it on, the demo page never asks
   for it.
10. Not done for mainnet: key custody in KMS, a second email co-signer, CI turned back on, independent reviews
    ([`docs/mainnet-readiness.md`](docs/mainnet-readiness.md)). Addresses may still change before Journear's address
    freeze: never send real funds to a testnet wallet.

## Developer reference

Each partner app has its own **scope** in a registry inside the contract, so one app can never derive another app's
users' keys. The user's key path is `{scope_id}#{provider}#{sub}#{key_index}`. An app logs users in either through its
own Google OAuth client (the token's `aud` picks the scope) or through Hana's shared client (the token's nonce commits
to the scope); see [Shared vs own Google client](#shared-vs-own-google-client).

More: [`docs/README.md`](docs/README.md) (index). Current state: [`docs/context.md`](docs/context.md) (background,
status, next steps), [`docs/architecture.md`](docs/architecture.md), [`docs/security.md`](docs/security.md),
[`docs/api.md`](docs/api.md), [`docs/contract-interface.md`](docs/contract-interface.md) (contract methods and byte
layouts), [`docs/operations.md`](docs/operations.md) (runbook), [`docs/decisions.md`](docs/decisions.md),
[`docs/integration.md`](docs/integration.md) (partner integration guide). The batch specs (`docs/batch-*.md`) are
history; the reference docs and the code win where they differ.

## Shared vs own Google client

A partner app can log its users in two ways. Both land in the app's own scope, so keys stay isolated per app.

| | Own client | Shared client |
|---|---|---|
| Google OAuth client | The partner creates one in its Google Cloud project | Hana's, from `sharedGoogleClientIds` in the manifest |
| Consent screen shows | The partner's app name | Hana's |
| How the contract finds the scope | The token's `aud` is registered to exactly one scope | `aud` is a shared client, so the API passes the app's `scope_id`, and the token's nonce commits to it. The scope must allow shared login. |
| Who checks the app may use the scope | Google (only the redirect URIs and origins registered on the partner's client can get its tokens) | Hana's vault (batch B), which computes a nonce for scope X only for a parent page whose origin app X allows; the login page checks it before relaying it to Google |
| Register with | `admin scope:register --client <id>` | `admin scope:register --allow-shared` (no `--client` needed) |

A scope can have both: its own client(s) and `allow_shared`. The path doesn't include the client ID, so a user gets the
same address either way, as long as Google returns the same `sub` for both clients. It does: the same account got
the same `sub` through clients of one Cloud project (testnet smoke, 2026-10-27) and of two projects (spike,
2026-10-28; `docs/decisions.md` D42). That also lets an app start on the
shared client and add its own client later with a timelocked `propose_change(AddClient)`, without users' addresses
changing. Forging a shared-client nonce gains nothing: it can only get the forger their own key for a scope, which
they could get anyway.

Rules the contract enforces:
- A client ID is either shared or a scope's own client, never both. The manifest schema rejects an ID that is in both
  `sharedGoogleClientIds` and `googleClientIds` (or `consoleAudiences`). `scope:register` refuses a shared ID as
  `--client`.
- Shared clients are added after `change_delay_ms` (pending until then, shown by `get_config`) and removed at once.
- Enabling shared login on an existing scope is a timelocked `propose_change(SetAllowShared)`. Disabling it with
  `disable_shared_login` takes effect at once, but only if the scope has its own client.

## Layout

```
contracts/hana-signer/   Rust NEAR contract (near-sdk 5): OIDC verification, scope registry, sessions, CKD
contracts/mock-mpc/      Test MPC contract for the sandbox tests
contracts/hana-guestbook/  NEAR hackathon demo contract: a 50-message guestbook written through meta transactions
contracts/integration-tests/  near-workspaces sandbox tests (CI job "Sandbox e2e")
apps/api/                Cloudflare Worker + Durable Objects + D1: the relayer partners call (publishable keys)
apps/smoke/              Local smoke-test pages (Vite, http://localhost:5173): login through the vault, plus the direct flow
apps/e2e/                Playwright suite (Chromium, WebKit, Firefox) against a local stack: no testnet, no secrets
apps/demo/               Hosted testnet demo for colleagues (Vite page + Worker): https://hana-id-demo-sandbox-dev.tingtc.workers.dev
packages/env/            Environment manifest schema (zod) + loadEnv()
packages/core/           SDK core (batch B, pure TS): layouts, CKD, derivation v1, signers, decoders, token checks
packages/web/            Partner client (createHana) and the Hana pages (vault, login, approve, export), built per env
packages/react/          React bindings (HanaProvider, useHana, useWallet)
packages/sodax/          Optional Sodax wallet-provider adapters
packages/playbooks/      Recovery playbooks for every watchdog alert and incident (D126): docs/playbooks.md, admin portal
envs/                    One manifest per environment (sandbox-dev.json): every account name and endpoint
contracts/sputnik/       The pinned Sputnik DAO v2 code and the owner-council policy (2 of 3, D81)
scripts/                 Deploy, owner council, Google key sync, CKD key pinning, admin CLI (TypeScript, run with tsx)
legacy/                  Read-only reference: the earlier PoC client and relayer
docs/                    Reference docs (current state) and batch specs (history): docs/README.md
```

## Setup

Install [gitleaks](https://github.com/gitleaks/gitleaks) first (`brew install gitleaks`): `pnpm install` turns on a
pre-commit hook (`.githooks/pre-commit`) that refuses commits containing secrets, and CI scans the full history
(`.gitleaks.toml`). Run `pnpm secrets:scan` to scan locally.

Needs Node 22+, pnpm 11, Rust (the toolchain in `contracts/hana-signer/rust-toolchain.toml` with the
`wasm32-unknown-unknown` target), ideally `cargo-near` (`cargo install cargo-near`; CI uses 0.22.0), and near CLI
(near-cli-rs) for creating accounts. Versions: `docs/operations.md` "Prerequisites".

```sh
pnpm install          # pnpm refuses packages younger than 7 days (minimumReleaseAge); pin older versions if needed
pnpm -r typecheck
pnpm -r test
cd contracts/hana-signer && cargo test
```

CI is off while only testnet runs (D387): `pnpm verify` is the local gate (`docs/operations.md` "CI and git", D413).
`pnpm verify --quick` while working; `pnpm verify` before every merge into `develop`; `pnpm verify --full` before a
deploy. `pnpm verify:install-hook` (optional) makes a push to `develop` or `main` run `--quick` first.

## Commands

| What | Command |
|---|---|
| Contract tests / wasm | `cd contracts/hana-signer && cargo test` · `cargo near build non-reproducible-wasm` |
| TS tests / types | `pnpm -r test` · `pnpm -r typecheck` |
| Local gate (CI's checks for the change, D413) | `pnpm verify [--quick \| --full] [--all] [--base <ref>] [--plan]` · pre-push hook: `pnpm verify:install-hook [--status \| --uninstall]` |
| API dev server | `pnpm --filter @hana-id/api dev` |
| Deploy the contract | `pnpm --filter @hana-id/scripts run deploy-contract <env> [--yes]` |
| Migrate / upgrade it (propose, then execute) | `pnpm --filter @hana-id/scripts run deploy-contract <env> --upgrade [--yes]` |
| Create the dev owner council (Sputnik DAO) | `pnpm --filter @hana-id/scripts run council-setup <env> [--yes]` |
| Owner call through the owner or the council | `pnpm --filter @hana-id/scripts run admin <env> owner:call <method> --args '<json>' [--approve-with <member>] [--yes]` |
| Sync Google keys once | `pnpm --filter @hana-id/scripts run post-google-keys <env> [--dry-run] [--execute]` |
| Pin the MPC CKD key (≥ 3 RPC providers must agree) | `pnpm --filter @hana-id/scripts run fetch-ckd-key <env> [--rpc <url>]... [--dry-run]` |
| Admin (apps, scopes, app settings) | `pnpm --filter @hana-id/scripts run admin <env> <command> …` |
| API Worker config | `pnpm --filter @hana-id/api run gen <env> [--d1-id <uuid>] [--dev-vars]` |
| `VAULT_KEK` | `pnpm --filter @hana-id/scripts run vault-kek <env> init\|put\|rotate [--yes]` |
| Identity token keys (`IDENTITY_SIGNING_KEY`, `…_STANDBY`, `IDENTITY_SUB_KEY`) | `pnpm --filter @hana-id/scripts run identity-key <env> init [--local]\|put\|show [--yes]` (`docs/operations.md` "Identity token keys") |
| Hana pages (vault, auth) | `pnpm --filter @hana-id/web build` · `pnpm --filter @hana-id/api run deploy:pages` |
| After any deploy: every Worker and page bundle on this commit, no D1 migration pending | `pnpm --filter @hana-id/scripts run deploy-check <env> [--d1] [--skip-head] [--strict]` (`docs/operations.md` "Checking a deploy") |
| Recovery playbooks doc | `pnpm --filter @hana-id/playbooks gen-docs` (writes `docs/playbooks.md`; edit `packages/playbooks`) |
| SDK tarballs: build, check, install outside the repo | `pnpm run pack:check` · version: `pnpm --filter @hana-id/scripts run sdk-version <x.y.z>` (`docs/operations.md` "Releasing the SDK packages") |
| Browser tests | `pnpm --filter @hana-id/e2e e2e` (ports from 4410; a linked worktree gets its own base, `HANA_E2E_PORT_BASE` overrides; `apps/e2e/README.md`) |
| Hosted demo | `pnpm --filter @hana-id/demo run deploy` (`apps/demo/README.md`; its origin must be on the app first) |

The `@hana-id/scripts` commands take the environment name (`envs/<env>.json`) first and print `--help`.

### deploy-contract

```
deploy-contract <env> [--yes] [--relayer-keys 3] [--relayer-allowance 2]
                      [--owner-relayer-keys 1] [--owner-relayer-allowance 0.5]
                      [--upgrade] [--wasm <file>] [--skip-build]
                      [--transfer-owner] [--member <council member>] [--approve-with <council member>]
                      [--known-owner <account,…>]
deploy-contract <env> --creation-plan [--wasm <reproducible build>] [--updater-public-key <pk>] [--creation-public-key <pk>]
```

Reads what is already on chain, prints a plan, and changes nothing without `--yes`. Re-running plans only what is
missing, so it is safe to resume after a failure. Owner steps go through the manifest's owner (`ownerKind`): signed by
the owner's keychain key, or proposed to the council DAO (`--member`; `--approve-with` on dev envs approves them in the
same run). Steps:

1. Build the wasm (`cargo near build non-reproducible-wasm`, or plain `cargo build --target wasm32-unknown-unknown`
   if cargo-near is missing).
2. Deploy to `signer` and call `new(owner, mpc, ckd_domain_id, change_delay_ms, issuer_key_delay_ms,
   governance_delay_ms, watchdogs, updater_keys)` in the same transaction (only where `allowSignerFullAccessKey`
   allows the signer a full-access key; other envs are created with the `--creation-plan` batch). On an initialised
   contract `--upgrade` changes the code in place, same account, so no address changes: `propose_upgrade(<code_hash>)`
   by the owner and, on a re-run once `governance_delay_ms` has passed, `execute_upgrade` with the raw wasm (never a
   raw `DeployContract`). A v1 (pre-governance) contract is refused: current code has no v1 migration (D154).
   Details and the sandbox-dev migration: `docs/operations.md` "Governance".
3. Add two pools of function-call keys on `relayer`, both with receiver = `signer`, one transaction per pool:
   - **Session pool** (the API's `RELAYER_KEYS`, logins): `--relayer-keys` keys (default 3), limited to
     `create_session`, `create_session_and_derive`, `derive_key`, `revoke_session` and the link methods, allowance
     `--relayer-allowance` each (default 2 NEAR). A key already on chain with another method list (an earlier
     allowlist) stops the plan with the commands to delete it; re-running then re-adds it with the current list.
   - **Owner pool** (the API's `OWNER_RELAYER_KEYS`, `/v1/owner-actions`): `--owner-relayer-keys` keys (default 1),
     limited to `propose_change`, `cancel_change`, `remove_client`, `disable_shared_login`, `execute_change`,
     allowance `--owner-relayer-allowance` each (default 0.5 NEAR).
   - **Home pool** (the API's `HOME_RELAYER_KEYS`, `/v1/home/login`): `--home-relayer-keys` keys (default 1), limited to
     `create_session_and_derive`, allowance `--home-relayer-allowance` each (default 5 NEAR).

   The pools never share a key, so abuse of the public owner-actions endpoint can only drain the owner pool. It can
   never stop logins.
4. The keys-updater key (the API's `KEYS_UPDATER_KEY`, so the cron can propose Google keys without the owner): generated
   into `.secrets/<env>/keys-updater.json` and installed on `signer` by the owner's `add_updater_key`. The contract
   gives it exactly `set_issuer_key`, `propose_issuer_key_removal`, `execute_issuer_key_change`, receiver `signer`,
   1 NEAR; nobody adds keys to the signer by hand any more. A pre-governance updater key (with `remove_issuer_key`)
   still on the signer is deleted once the contract's own is in (the v1 → v2 migration did this on sandbox-dev
   on 2026-10-30). Then `add_watchdog` for each `watchdogs` account that exists,
   and `set_issuer_key_delay_ms` / `set_governance_delay_ms` if the contract's delays differ from the manifest.
   `--transfer-owner` adds `propose_owner(<council DAO>)` and, once due, the DAO's `accept_owner` (then the script sets
   `owner` / `ownerKind` in the manifest).
5. `set_issuer("google", ["https://accounts.google.com", "accounts.google.com"])`, `set_sponsors([relayer])`,
   `set_console_audiences` if the manifest lists any, `set_shared_clients` with `sharedGoogleClientIds`, the console
   sink scope (`admin_register_scope` of a new `sN` whose only clients are the `consoleAudiences`, owner `owner`,
   `allow_shared: false`), and `admin_register_scope` for the reserved `global` scope with `googleClientIds` only and
   `allow_shared: false` (Hana's own app uses its own client). The shared clients and `global` are skipped with a
   warning while their manifest field is still an `UNSET…` placeholder. The console audiences go into the sink so no
   scope owner can claim them with `propose_change(AddClient)`, and never into `global`, where a console token could
   open a session (D238). On an env whose `global` still lists them, the plan removes them from it (`remove_client`)
   and registers the sink once their quarantine is over (`docs/operations.md` "Console sink scope").

   `set_shared_clients` replaces the whole list. Clients that are new take effect after `changeDelayMs`, and until
   then the plan reports them as pending, with their unlock time. Clients no longer in the manifest are removed at
   once. The plan stops if a shared ID is already registered as some scope's client.

It does not create accounts. If one is missing, or its key is not in the keychain, the plan says so and shows the
near CLI command to fix it.

An allowance drops by the gas each call burns, not the gas attached (refunds restore it; measured on testnet,
`docs/context.md`). The API attaches per-method gas (`apps/api/src/gas.ts`: `create_session` 50 Tgas,
`create_session_and_derive` 100, `derive_key` 60, `revoke_session` 20, owner-pool methods 50). A split login burns ~40 Tgas (~0.004 NEAR), so 3 keys × 2 NEAR cover
~1,500 logins. Pass larger allowances for heavier testing. To replace a used-up key,
delete it on chain with near CLI, remove it from its `.secrets` file, and re-run.

**Existing keys are checked, not trusted.** For every key in a pool file (and the keys-updater key), the plan
compares the on-chain key's `receiver_id`, `method_names` and `allowance` with the intended permission. The plan
stops instead of passing the key as in place if:
- the key is full-access,
- the key is for another receiver,
- the key has a different method set, such as a batch A key that mixes session and owner methods,
- the key has an **empty method list**, which NEAR treats as "any method",
- the key has an **unlimited allowance**, or an allowance above the pool's `--…-allowance` flag (1 NEAR for an
  updater key). A lower allowance is fine, since NEAR lowers it as the key spends gas. If you deployed with a larger
  allowance than the default, pass the same flag on every re-run.

It also stops on:
- a key for `signer` on the relayer that is in neither pool file and has an empty method list, or methods of both
  pools (for example a batch A key left on chain after its file was moved aside),
- any function-call key on the signer that isn't in `get_governance().updater_keys` (the v1 updater key excepted: the
  migration deletes it). Such a key could propose a forged Google key,
- a full-access key on the signer in any env without `allowSignerFullAccessKey` (sandbox-dev only, D86): with it,
  anyone holding it could replace the code at once,
- a v1 contract without `--upgrade`, a missing council DAO or one with other code than the pin (for `--transfer-owner`
  or a council owner), and `--approve-with` outside dev envs.

Other stray keys are only listed as warnings, each with the command to delete it. The fix the plan prints for a
blocked key: delete it on chain (`near account delete-keys …`, printed per key) and re-run, which re-adds the key from
`.secrets` with the right permission. Or move the `.secrets` file aside, which generates fresh keys, and re-upload the
API secret. Delete the old keys on chain in that case too: left there, they keep their permission and allowance.

The same check covers switching an env to a new `signer` account. The keys in the pool files are then still
function-call keys for the old signer. NEAR can't add the same key twice, so the plan stops and lists them.

### Keys: where they come from and where they go

- **Full-access keys** for `owner`, `signer` and `relayer` are read from the near CLI **legacy keychain**:
  `~/.near-credentials/testnet/<account>.json` (`{"account_id","public_key","private_key"}`), or the per-key files in
  `~/.near-credentials/testnet/<account>/`. near-cli-rs writes these when you choose `save-to-legacy-keychain`
  (`near account create-account … save-to-legacy-keychain …` or `near account import-account … save-to-legacy-keychain`).
  The scripts only read them; they are never copied or printed.
- **Generated keys** go to `.secrets/<env>/` (gitignored; directory 0700, files 0600). Nothing generated is printed:
  - `relayer-keys.json`: JSON array of `ed25519:…` secret keys (session pool), the API's `RELAYER_KEYS` secret.
  - `owner-relayer-keys.json`: same format (owner pool), the API's `OWNER_RELAYER_KEYS` secret.
  - `home-relayer-keys.json`: same format (Home pool), the API's `HOME_RELAYER_KEYS` secret.
  - `keys-updater.json`: `{"account_id","public_key","private_key"}`, whose `private_key` is the API's
    `KEYS_UPDATER_KEY` secret.
  - `council/<member>.json` (dev envs only, `council-setup`): the full-access keys of the throwaway council member
    accounts, same format. Other envs' members keep their own keys (Ledgers on mainnet); the scripts never read a
    council key from disk outside testnet.

  Each key is saved before it is added on chain (or before its account is created), so a key that lands on chain is
  never lost.

### council-setup

```
council-setup <env> [--yes] [--funder <account>] [--member-balance 2]
```

Dev envs (`local*`, `sandbox*`) on testnet only. Creates the three `council.members` accounts (keys into
`.secrets/<env>/council/`) and the `council.dao` Sputnik DAO v2 from the `council.factory`, with
`contracts/sputnik/policy.json`: 2 of 3 for every proposal kind, only council members propose (D81). It first checks
that the factory deploys the pinned DAO code (`contracts/sputnik/pin.json`). A re-run checks what exists and stops on
a DAO with other code or another policy. `docs/operations.md` "Owner council".

### admin owner:* and governance:status

`admin <env> owner:call <method> --args '<json>'` sends one owner-only method through the manifest's owner: the owner's
keychain key signs it, or (`ownerKind: "sputnik"`) it becomes a DAO `FunctionCall` proposal by `--member`. On dev envs
`--approve-with <second member>` approves it with both members in the same command, so it executes; elsewhere the
command only proposes and prints the vote each member signs. `owner:vote <id> --member <m>` approves one proposal
(`--reject`: rejects it), `council:replace-member --remove <old> --add <new>` proposes replacing a council member
(remove, then add; 2 of 3 kept; it writes `council.members` in the manifest once the DAO has the new council),
`owner:proposals` lists them decoded, `governance:status [--json]` prints the contract's governance state, the
signer's keys against the updater keys, the council's open proposals and the findings (the source batch C's admin
portal reads; `docs/operations.md` "Governance status for the admin portal").

### post-google-keys

Fetches Google's JWKS and compares it with `get_issuer("google")` and `get_key_changes()`. On the governance contract
it proposes new kids (`set_issuer_key`) and the removal of retired ones (`propose_issuer_key_removal`, never the last
key), and with `--execute` runs `execute_issuer_key_change` for due changes that match Google's JWKS. Keys go live
when the watchdog confirms them or after `issuer_key_delay_ms`. On a v1 contract it sets and removes directly. It
signs with the keys-updater key from `.secrets/<env>/keys-updater.json` (there is no owner path: an owner post waits
the same delay, D86) and refuses to sync if Google returns no usable RS256 key.

### fetch-ckd-key

Reads `state` from the MPC contract (`manifest.mpc`) at one final block from at least three independent RPC providers
(`rpc`, `rpcFallback`, each `--rpc <https url>`, then built-in public endpoints), takes the BLS12-381 G2 public key of
`ckdDomainId`, and refuses unless every provider reports the same block hash and key. It writes the key to
`ckdNetworkKey` and the block and provider hosts to `ckdNetworkKeySource` in `envs/<env>.json`, leaving the rest of
the file as it was (D100). Clients pin this key. If it ever changes, every derived key changes with it.

### admin

```
admin <env> app:create --name <name> --scope <scope_id> --origin <origin> [--origin …] [--plan free] [--remote]
admin <env> app:origins:add    --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:origins:remove --app <app id | pk_test_…> --origin <origin> […] [--remote]
admin <env> app:suspend|app:resume --app <app id | pk_test_…> [--remote]
admin <env> app:list [--remote]
admin <env> app:settings <app id | pk_test_…> [--persistence session|none] [--session-ttl 12h] [--idle-ttl 2h]
             [--raw-sign off|approval] [--google-web-client <client id>|default] [--auto-approve <policy.json>|off] [--remote]
admin <env> scope:register [--client <google client id> …] [--allow-shared] (--owner-near <account> | --owner-google <sub>) […]
             [--member <council member>] [--approve-with <council member>] [--yes]
admin <env> owner:call <method> [--args '<json>'] [--gas <Tgas>] [--member <m>] [--approve-with <m>] [--yes]
admin <env> owner:vote <proposal id> --member <m> [--reject] [--yes]
admin <env> owner:proposals [--limit 20] [--json]
admin <env> governance:status [--json]
admin <env> council:replace-member --remove <old member> --add <new member> [--member <m>] [--approve-with <m>] [--yes]
```

- `app:*` commands write the env's D1 database with `wrangler d1 execute`, run from `apps/api`. They use the local
  database (`apps/api/.wrangler/state`, the one `wrangler dev` uses) by default, and the deployed one with
  `--remote`. They need `apps/api/wrangler.jsonc` (generate it with `apps/api/scripts/gen-wrangler.ts`) and the
  migrations applied. Values are escaped (wrangler has no bind parameters), and origins are normalised to
  `scheme://host[:port]`. Plain `http` is accepted only for localhost, plus the literal `http://localhost:*` for test
  keys.
- `app:create` checks that the scope exists on chain and the plan exists in D1. It generates the app id and a
  publishable key (`pk_test_` + base58 of 24 random bytes) and prints the key. Publishable keys are public: origins
  are what gate them.
- `app:settings` sets the app's vault settings (`docs/batch-b-spec.md` "App settings"); without setting flags it
  prints them. It checks every range (session TTL 1 h to 23 h 50 min, idle TTL 15 min to the session TTL), checks
  `--google-web-client` against the scope's Google clients on chain (`default` unpins it: the scope's first one), and
  validates `--auto-approve` with `@hana-id/core`'s `validateAutoApprovePolicy`, storing its normalized form and
  printing its `policyId`. Loosening is delayed: `--raw-sign approval` and a new policy are written as pending, in
  force after 24 h (the manifest's `changeDelayMs` in `local*`/`sandbox*` envs), and re-running doesn't restart the
  delay. `--raw-sign off` and `--auto-approve off` are immediate. Every change is printed with its time. A relative
  `--auto-approve` path is relative to where you ran `pnpm`, and the write applies only if nobody changed the app's
  settings since the command read them (else it fails and writes nothing). `docs/operations.md` has the details.
- `scope:register` calls `admin_register_scope(owners, clients, null, allow_shared)` through the owner: the owner's
  keychain key, or a council proposal (`--member`, `--approve-with` on dev envs) once the DAO owns the contract.
  Without `--yes` it prints the call and stops. It works only while `public_registration` is false, and the contract
  assigns the id (`s1`, `s2`, …), which the command prints (through the council: read it from `get_scope` or the
  `scope_registered` event). `--allow-shared` lets the app log in through Hana's
  shared Google client. With it, `--client` is optional, so a partner without its own Google client needs none.
  Without it, at least one `--client` is required. A client ID from `sharedGoogleClientIds` is refused as `--client`.

## Deploying a sandbox environment end to end

Use `sandbox-dev` as written or copy it to a new manifest (see [`envs/README.md`](envs/README.md)), with fresh
throwaway names. The signer account is part of every user's derived key, so changing it changes every address.

1. **Create and fund three testnet accounts** (the faucet gives each about 10 NEAR) and save their keys to the
   legacy keychain:
   ```sh
   near account create-account sponsor-by-faucet-service <signer>  autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <relayer> autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   near account create-account sponsor-by-faucet-service <owner>   autogenerate-new-keypair save-to-legacy-keychain network-config testnet create
   ```
   `signer` holds the contract and pays its storage, including scope registrations, so keep a few NEAR on it.
   `relayer` pays gas for the API. `owner` is the Hana admin.
2. **Create the Google OAuth clients** (Google Cloud console → APIs & Services → Credentials → OAuth client ID, type
   "Web application"). You need one for Hana's own app, and a separate one as the shared login client. They must be
   two different client IDs. Hana's pages (batch B) use the redirect flow: the shared client's only Authorized
   redirect URI is `{authOrigin}/login/callback` (step 7), never a partner origin. `apps/smoke`'s `direct.html`
   still signs in with Google Identity Services, so a client it uses also needs `http://localhost:5173` as an
   authorised JavaScript origin ([`apps/smoke/README.md`](apps/smoke/README.md)).
3. **Fill in the manifest**: account names, `googleClientIds` (Hana's own app's client IDs, which become the `global`
   scope), `sharedGoogleClientIds` (the shared login client), `consoleAudiences` if any, `changeDelayMs`, and the
   Cloudflare names. Fill these in before the first deploy. Changing them later works, but adding a shared client
   then waits out the timelock again.
4. **Pin the MPC key**: `pnpm --filter @hana-id/scripts run fetch-ckd-key <env>`.
5. **Deploy**: `pnpm --filter @hana-id/scripts run deploy-contract <env>`, read the plan, then re-run with `--yes`.
   Shared clients become effective `changeDelayMs` after this (60 s in `sandbox-dev`). Re-run without `--yes` to see
   their status.
6. **Post Google's keys**: `pnpm --filter @hana-id/scripts run post-google-keys <env>` (proposes them; they go live
   when a watchdog confirms them or after `issuerKeyDelayMs`: re-run with `--execute`).
7. **API**:
   ```sh
   pnpm --dir apps/api exec wrangler d1 create <cloudflare.d1Name>            # once; deployed envs only: prints the database id
   pnpm --filter @hana-id/api run gen <env> --d1-id <id>                      # writes apps/api/wrangler.jsonc, gitignored (omit --d1-id for local only)
   pnpm --dir apps/api exec wrangler d1 migrations apply <cloudflare.d1Name> --local   # or --remote
   # Upload secrets without echoing them (run from the repo root):
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/owner-relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put OWNER_RELAYER_KEYS
   node -e 'process.stdout.write(JSON.stringify(require("./.secrets/<env>/home-relayer-keys.json")))' \
     | pnpm --dir apps/api exec wrangler secret put HOME_RELAYER_KEYS
   node -e 'process.stdout.write(require("./.secrets/<env>/keys-updater.json").private_key)' \
     | pnpm --dir apps/api exec wrangler secret put KEYS_UPDATER_KEY
   pnpm --filter @hana-id/api run deploy
   pnpm --filter @hana-id/scripts run vault-kek <env> init --yes             # VAULT_KEK: kept in .secrets/<env>/vault-kek, set via stdin
   ```
   For local `wrangler dev`, the same three values go in `apps/api/.dev.vars` (gitignored, 0600):
   `pnpm --filter @hana-id/api run gen <env> --dev-vars` writes it from `.secrets/<env>/` without printing them.
   Then the vault and auth pages (`vaultOrigin`, `authOrigin`), each a thin Worker with its built pages; the vault
   Worker reaches the API through a service binding, so deploy the API first
   ([`apps/api/README.md`](apps/api/README.md#page-workers)):
   ```sh
   pnpm --filter @hana-id/web build              # packages/web/dist/pages/<env>/{vault,auth}
   pnpm --filter @hana-id/api run deploy:pages   # wrangler.vault.jsonc and wrangler.auth.jsonc, written by gen above
   pnpm --filter @hana-id/scripts run deploy-check <env> --d1   # every Worker and bundle on this commit (D384)
   ```
   Google redirects logins to `{authOrigin}/login/callback`: add it as an Authorized redirect URI on the shared client
   and on every own client that logs in through the Hana pages.
8. **Register a partner**, with its own Google client, or with Hana's shared one, or both:
   ```sh
   # own client
   pnpm --filter @hana-id/scripts run admin <env> scope:register --client <partner>.apps.googleusercontent.com --owner-near <partner-or-owner>.testnet --yes
   # shared client only (no Google setup on the partner's side)
   pnpm --filter @hana-id/scripts run admin <env> scope:register --allow-shared --owner-near <partner-or-owner>.testnet --yes
   pnpm --filter @hana-id/scripts run admin <env> app:create --name "Partner" --scope s1 --origin https://partner.example --origin http://localhost:5173 [--remote]
   ```
   Give the partner the printed `pk_test_…` key and [`docs/integration.md`](docs/integration.md). With its own
   client, the partner adds `{authOrigin}/login/callback` as that client's only Authorized redirect URI, with no
   JavaScript origins.

## Safety

- Testnet only. The manifest schema accepts only `testnet`, and the scripts refuse an RPC whose `chain_id` is not
  `testnet`.
- Never print, log or commit private keys, CKD outputs or Google ID tokens. Generated keys live only in
  `.secrets/<env>/` (0600). Full-access keys stay in `~/.near-credentials`. `.env`, `.dev.vars` and `.secrets/` are
  gitignored.
- Anything that changes how a path or key is derived changes every user's address: the MPC network, the signer
  account, the path format, or the local derivation. That is allowed before the address freeze, but must be called
  out. After the freeze, never.
- The relayer's keys can only call their pool's `hana-signer` methods, and only up to their allowance.
  `deploy-contract` checks this on every run. A leaked relayer key can burn gas, but it cannot derive anyone's key,
  because every session needs a Google token committing to the user's own session key and scope. Session and owner
  keys are separate pools, so draining the owner pool can't stop logins.
- On the governance contract, Google keys and code change only after public delays (`issuer_key_delay_ms`,
  `governance_delay_ms`), the owner is a 2-of-3 Sputnik DAO council, and outside sandbox-dev the signer has no
  full-access key: `deploy-contract` blocks on one, and on any signer key the contract didn't install
  (`docs/governance-spec.md`, `docs/operations.md` "Governance").
- Hana cannot change a scope's client IDs or owners after registration. On chain it can block derivation only for a
  shared-only scope, by removing the shared clients (`docs/decisions.md` D11, D12). App suspension happens only in D1,
  through the API.
