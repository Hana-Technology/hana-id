# hana-guestbook

The NEAR hackathon demo contract: "sign in with Google, write on NEAR, pay no gas". A Hana user's NEAR wallet (an
implicit account with no balance) signs a NEP-366 delegate action calling `add_message`; Hana's relayer wraps it in a
transaction and pays the gas. Testnet only. Decisions D740–D744 in `docs/decisions.md`; deploy steps in
`docs/operations.md` "Hackathon demo guestbook (NEAR)".

The account comes from `envs/<env>.json` `near.demoGuestbook` (sandbox-dev: `hana-id-guestbook-dev1.testnet`).
Never hard-code it.

## Methods

| Method | Kind | Arguments | Returns |
|---|---|---|---|
| `new` | init (called by the deploy, in the deploy transaction) | `{}` | — |
| `add_message` | change, not payable | `{ "text": string }` | `Message` |
| `get_messages` | view | `{ "from_index"?: number, "limit"?: number }` | `Message[]`, newest first |
| `total_messages` | view | `{}` | number |

```jsonc
// Message
{
  "index": 7,                          // position in the full history: 0 = the first message ever added
  "account_id": "3f1c…e9a2",           // the predecessor of add_message: under a meta transaction, the user
  "text": "gm from Hana",              // trimmed, 1 to 200 characters
  "block_timestamp_ms": 1762851234567  // block time when it was added, ms since the Unix epoch
}
```

- **`add_message`** stores `{ account_id: predecessor, text, block_timestamp_ms }` and returns it with its `index`.
  The text is trimmed (Rust `str::trim`: Unicode White_Space) and must then be 1 to 200 characters, counted as
  Unicode scalar values (an emoji is 1, `"é"` is 1; JavaScript's `.length` counts some emoji as 2, so count with
  `[...text].length`). Refused: `Guestbook: text is empty after trimming`, `Guestbook: text is longer than 200
  characters after trimming`. Attaching any deposit is refused (`Method add_message doesn't accept deposit`), so a
  caller can never lose NEAR to it. Gas: about 1.4 Tgas burnt by the `add_message` receipt for the largest message
  (measured in the sandbox, ring full or not); 30 Tgas attached is plenty.
- **`get_messages`** lists the kept messages **newest first**: `from_index` (default 0) skips that many of the newest;
  `limit` defaults to 50 and is capped at 50 (a larger value returns at most 50). A `from_index` past the kept
  messages returns `[]`. `index` is stable while a message is kept, so it can key a list.
- **`total_messages`** counts every message ever added, including those the ring dropped.

## Limits and storage

Only the latest **50** messages are kept, in a ring: the 51st replaces the oldest. The contract account pays for its
own storage (NEAR storage staking), and the ring caps it: 50 of the largest messages (a 64-character account id and
200 four-byte characters) take 46 250 bytes, under 0.5 NEAR, on top of about 118 KB of code. The caller pays nothing
for storage, so a zero-balance account can write.

Anyone can write, and a burst of 50 messages pushes everything else out: fine for a demo. Spam control (who may relay,
how often) is the relayer's job.

## Security notes

- **The text is attacker-controlled.** The contract stores whatever UTF-8 it is given (markup, control characters,
  right-to-left marks, look-alike letters). A page must render it as text (React's `{text}`, `textContent`), never as
  HTML (`innerHTML`, `dangerouslySetInnerHTML`), and should not turn it into links. The same goes for `account_id`.
- **No owner, no admin methods, no upgrade path, no migration.** `new` runs once, in the deploy transaction.
- **The account's key.** After `deploy-guestbook … --yes` the account keeps the full-access key `near` CLI created
  (in `~/.near-credentials/testnet/`). Whoever holds it can deploy other code and rewrite every message. Once the demo
  works, `deploy-guestbook <env> --lock --yes` deletes every key on the account: the code and the messages are then
  final, and the account can never be deleted (its few NEAR stay locked; testnet only).

## Meta transactions (the demo's path)

Checked by `contracts/integration-tests/tests/guestbook.rs` against a local sandbox:

1. The user's implicit account must exist before its delegate action can run (otherwise `AccountDoesNotExist`). A
   transfer of **0 yoctoNEAR** from any account creates it with the user's key as its full-access key and a balance of
   0 (NEP-448 zero-balance account, 182 bytes).
2. The user signs `DelegateAction { sender_id: user, receiver_id: <guestbook>, actions: [FunctionCall add_message],
   nonce: access key nonce + 1, max_block_height, public_key }`; the relayer sends a transaction to the **user's
   account** with that one `Delegate` action.
3. `add_message`'s predecessor is the **user's account**, not the relayer's. The user's balance stays 0: unused gas is
   refunded to the relayer.
4. The relayer's transaction reports success even when `add_message` fails (it only ran the `Delegate` action): a
   relayer must look for a failure in every receipt outcome. A replayed signed delegate action fails with
   `DelegateActionInvalidNonce`.
5. Gas: the whole relayed transaction burns about 2.9 Tgas (about 0.0003 NEAR at testnet's gas price).

## With near CLI (near-cli-rs)

```sh
# Read
near contract call-function as-read-only hana-id-guestbook-dev1.testnet get_messages json-args '{"limit": 5}' network-config testnet now
near contract call-function as-read-only hana-id-guestbook-dev1.testnet total_messages json-args '{}' network-config testnet now

# Write from a funded account of yours (pays its own gas)
near contract call-function as-transaction hana-id-guestbook-dev1.testnet add_message json-args '{"text": "gm"}' prepaid-gas '30 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-legacy-keychain send
```

## Tests and build

```sh
cd contracts/hana-guestbook && cargo test                     # unit tests
cargo near build non-reproducible-wasm                        # wasm (target/near/hana_guestbook.wasm)
cd ../integration-tests && cargo test --test guestbook -- --nocapture   # sandbox tests, print the gas
```

`corepack pnpm verify` runs both in its contract and sandbox lanes whenever a file under `contracts/` changes.
