# hana-stamps

The Journear Passport hackathon demo contract: a passport of six stamps. A user signs in through Journear Passport, gets
a NEAR implicit account with no balance, and collects stamps here, each one a real NEAR testnet transaction; most go
through Journear's relay as NEP-366 meta transactions (no gas for the user). The contract checks every rule itself and
trusts nothing else: no owner, no oracle, no deposit, no upgrade path. Testnet only. Decisions D794–D797 in
`docs/decisions.md`; deploy steps in `docs/operations.md` "Hackathon demo stamps (NEAR)"; the site is `apps/stamps`.

The account comes from `envs/<env>.json` `near.demoStamps` (sandbox-dev: `hana-id-stamps-dev1.testnet`), which is also
one of `near.relay.receivers`. Never hard-code it.

## Methods

| Method | Kind | Arguments | Returns |
|---|---|---|---|
| `new` | init (called by the deploy, in the deploy transaction) | `{}` | — |
| `collect` | change, not payable | `{ "stamp": string, "note"?: string, "proof"?: SignatureProof }` | `Stamp` |
| `get_passport` | view | `{ "account_id": string }` | `{ "account_id": string, "stamps": Stamp[] }` or `null` |
| `recent` | view | `{ "from_index"?: number, "limit"?: number }` | `Recent[]`, newest first |
| `totals` | view | `{}` | `{ "passports": number, "stamps": number }` |
| `catalog` | view | `{}` | `["arrival", "sponsored", "own_fare", "signature", "postcard", "layover"]` |

```jsonc
// Stamp (get_passport's stamps, in the order collected; collect returns the one it stored)
{
  "stamp": "postcard",                 // one of catalog()
  "block_timestamp_ms": 1762851234567, // block time when it was collected, ms since the Unix epoch
  "sponsored": true,                   // the transaction's signer was not the caller (someone else paid the gas)
  "note": "greetings from NEAR"        // postcard only: the trimmed note; absent on every other stamp
}

// Recent (recent())
{ "account_id": "3f1c…e9a2", "stamp": "arrival", "block_timestamp_ms": 1762851234567 }

// SignatureProof (collect's proof, signature stamp only): what hana.near.signMessage signed and returned
{
  "message": "Stamp my passport: 3f1c…e9a2",  // exactly this prefix and the caller's account id
  "nonce": "AAECAwQF…Hh8=",                    // standard base64 (with padding) of 32 bytes, any value
  "recipient": "hana-id-stamps-dev1.testnet",  // this contract's own account id
  "signature": "DJnvagCZ…JHiAA=="              // standard base64 of the 64-byte ed25519 signature
}
```

## Rules

`collect`'s caller is the predecessor: under a meta transaction, the delegate action's sender (the user), not the
relayer. Each stamp at most once per account, and `arrival` first. The first check that fails panics with one of these
exact messages (the whole panic message; NEAR shows it as `Smart contract panicked: ERR_…`). The checks run in this
order (`src/lib.rs` `collect`; pinned by the unit test `checks_run_in_the_documented_order`):

| Step | Message | When |
|---|---|---|
| 1 | `ERR_UNKNOWN_STAMP` | `stamp` is not one of `catalog()` (exact, case-sensitive) |
| 2 | `ERR_BAD_NOTE` | a `note` sent with any stamp but `postcard` |
| 3 | `ERR_BAD_PROOF` | a `proof` sent with any stamp but `signature` |
| 4 | `ERR_ALREADY` | `arrival` when the account has a passport, or any stamp the account already holds |
| 4 | `ERR_NO_ARRIVAL` | any stamp but `arrival` before the account's `arrival` |
| 5 | `ERR_NOT_SPONSORED` | `sponsored` when the signer is the caller (the caller paid for it) |
| 5 | `ERR_NOT_OWN_FARE` | `own_fare` when the signer is not the caller (someone else paid for it) |
| 5 | `ERR_NOT_IMPLICIT` | `signature` from a named account (its key isn't its account id), with or without a proof |
| 5 | `ERR_BAD_PROOF` | `signature` without a proof, or a proof that doesn't verify (below) |
| 5 | `ERR_BAD_NOTE` | `postcard` without a note, or a note that is empty or over 140 characters after trimming |
| 5 | `ERR_TOO_SOON` | `layover` less than 120 000 ms of block time after the account's `arrival` |

So the stamp's own argument is looked at last: a `postcard` without a note before `arrival` is `ERR_NO_ARRIVAL`, an
empty note on a postcard already collected is `ERR_ALREADY`, and the same for a `signature` without a proof.

- **`arrival`**: no rule; creates the passport.
- **`sponsored`**: `signer_account_id != predecessor_account_id`, and nothing more: the transaction was signed by
  someone other than the caller. A delegate action relayed by Journear's relay or by any other NEP-366 relayer passes,
  and so does a call made through another contract (that contract is the caller: it gets its own passport, marked
  sponsored, and the human who signed is untouched). It doesn't prove who paid or that Journear relayed it.
- **`own_fare`**: `signer_account_id == predecessor_account_id`: the user signed and paid for the transaction with
  their own testnet NEAR (`hana.near.signTransaction` and `send_tx`). Journear's relay can't collect it.
- **`signature`**: a NEP-413 signature by the caller's own key, verified on chain with `env::ed25519_verify`. The
  public key is the caller's implicit account id (64 lowercase hex characters → 32 bytes); the signed bytes are
  `sha256(u32le(2^31 + 413) ‖ borsh({ message, nonce: [u8; 32], recipient, callback_url: None }))`, exactly what
  Journear Passport's vault signs for `hana.near.signMessage({ message, recipient, nonce })` **without a
  `callbackUrl`** (a signature made with one doesn't verify). `recipient` must be this contract's account id and
  `message` exactly `"Stamp my passport: " + <the caller's account id>`, so a proof works only for its own account,
  here, once (the stamp is once per account). The nonce isn't tracked: replaying your own proof only hits
  `ERR_ALREADY`. The proof isn't stored.
- **`postcard`**: the note is trimmed (Rust `str::trim`: Unicode White_Space) and must then be 1 to 140 characters,
  counted as Unicode scalar values (`[...note].length` in JavaScript, not `.length`). Stored and shown publicly.
- **`layover`**: `block_timestamp_ms - arrival's block_timestamp_ms >= 120 000`.
- Every stored stamp records `sponsored` (signer ≠ caller) whatever the stamp: `arrival` relayed is `true`, `own_fare`
  always `false`.
- `collect` is not payable: attaching any deposit is refused (`Method collect doesn't accept deposit`). The views
  (`get_passport`, `recent`, `totals`, `catalog`) have no deposit check (near-sdk adds none to a `&self` method): NEAR
  attached to a view called as a transaction stays in the contract (it only adds to its balance). Malformed arguments (a non-string `stamp`) fail to deserialise, as for any near-sdk method.
- A failed `collect` changes nothing.

**Views.** `get_passport` is `null` for an account with no `arrival`. `recent` lists the ring of the latest 100 stamps
of every account, newest first: `from_index` (default 0) skips that many of the newest; `limit` defaults to and is
capped at 50 (a larger value is clamped); past the kept entries, `[]`. `totals` counts passports (arrivals) and stamps
since the deploy, including those the ring dropped.

## Gas

Measured in the sandbox (`contracts/integration-tests/tests/stamps.rs`, near-sandbox 2.13.4), each `collect` attaching
**10 Tgas**, sandbox-dev's relay cap (`near.relay.maxGasTgas`): every stamp fits with a wide margin.

| Stamp | `collect` receipt burnt | whole relayed transaction |
|---|---|---|
| `arrival` | 1.51 Tgas (1.54 with the ring full) | 2.97 Tgas |
| `sponsored` | 1.55 Tgas | 3.01 Tgas |
| `signature` (ed25519 verify on chain) | 1.84 Tgas (1.85 with the ring full) | 3.33 Tgas |
| `postcard` (140 four-byte characters) | 1.63 Tgas | 3.14 Tgas |
| `layover` | 1.63 Tgas | 3.09 Tgas |
| `own_fare` (direct, the user's own transaction) | 1.63 Tgas | 1.94 Tgas |

At testnet's gas price (10^8 yocto/gas) a relayed stamp costs the relay about 0.0003 NEAR; `own_fare` costs the user
about 0.0002 NEAR. Attach 10 Tgas (the relay refuses more than its cap; unused gas is refunded).

## Storage and what an attacker can cost it

The contract account pays for its own storage (NEAR storage staking, 10^19 yocto per byte, so 100 KB = 1 NEAR); the
caller pays nothing for storage, so a zero-balance account can collect. Measured in the unit test
`storage_per_passport_and_ring_is_bounded` and the sandbox:

- **Code**: about 149 KB (1.49 NEAR).
- **The recent ring**: 100 entries, at most about 122 bytes each (a 64-character account id): at most about 12 200
  bytes (0.12 NEAR). It stops growing once full: entries replace the oldest in place.
- **One passport**: at most six stamps and one note. An arrival-only passport of a 64-character account is 124 bytes;
  the largest (all six, a 140-character note of four-byte characters) about 740 bytes (0.0074 NEAR); a typical one
  (all six, a short note) about 200 bytes. **An account can never cost more than about 740 bytes, whatever it sends.**
- **The number of passports is not bounded**: one per account, and anyone can make accounts.

Through Journear's relay (sandbox-dev's limits in `envs/sandbox-dev.json` `near.relay` and the API's fixed ones):
every relayed sender must be a NEAR account the wallet directory holds for a Journear user (`requireKnownAccount`), so
new passports need new Journear sign-ups; an account's relays (at most 4 calls in 10 Tgas each) can add at most its
own ~740 bytes in all, since every stamp is once per account and `own_fare` is never relayed. So the relay bounds the
growth to about 740 bytes per new Journear user, and per UTC day (each relay at most one new passport) to
`perAppPerDay` (2 000) × 740 bytes ≈ 1.5 MB ≈ **15 NEAR a day through one app** (the stamps site's publishable key is
public) and `relaysPerDay` (10 000) × 740 bytes ≈ 7.4 MB ≈ **74 NEAR a day across the environment** in the worst
case, and only with that many fresh users signing up (activations: 200 a day per app, 1 000 across the environment,
or accounts the attacker creates itself). Outside the relay, anyone with testnet NEAR can create accounts and collect
`arrival`, `own_fare`, `postcard` and `layover` directly, paying the gas (about 0.0008 NEAR for the four) plus the
account (an implicit account's 0-yocto activation costs about 0.007 NEAR) for about 0.007 NEAR of the contract's
storage: about as much as it costs the contract. Testnet NEAR is free from faucets, so a determined spammer can use up
any balance; nothing more is at stake.

**When the balance runs out**: a `collect` that needs new storage fails (NEAR refuses state the account's balance
can't cover; nothing is stored); every passport stays readable; anyone can top the account up with a plain transfer, also after
the lock (transfers need no key on the receiving account). **Hold about 20 NEAR** (testnet NEAR is free; anyone can
fill the storage at about what it costs them): the code's 1.5, the ring's 0.12 and about 18 NEAR for passports (over
2 000 of the largest, about 9 000 typical ones), and check the balance during the judging
(`near account view-account-summary hana-id-stamps-dev1.testnet network-config testnet now`). `deploy-stamps` refuses
to deploy with less than the code, 200 000 bytes of state and 0.1 NEAR of gas (about 3.6 NEAR).

## Security notes

- **The contract trusts nothing but its own checks**: the predecessor and signer NEAR gives it, the block time, and
  the signature it verifies itself. It never calls another contract and holds no key. Journear's relay, the API and
  the site can refuse to send a call, never make a forbidden one pass.
- **`sponsored` and `own_fare` only say who signed the transaction.** Any relayer can sponsor; a contract calling
  `collect` is its own predecessor. They are demo stamps, not proofs of anything else.
- **Notes and account ids are attacker-controlled bytes**: any UTF-8 up to 140 characters (markup, control and
  bidirectional characters, look-alike letters). A page renders them as text (`textContent`), never as HTML, and
  neutralises invisible and bidi characters (D753).
- **No owner, no admin method, no upgrade path, no migration.** `new` runs once, in the deploy transaction.
- **The account's key.** After `deploy-stamps … --yes` the account keeps the full-access key `near` CLI created (in
  `~/.near-credentials/testnet/`). Whoever holds it can deploy other code and rewrite every passport. Once the demo
  works, `deploy-stamps <env> --lock --yes` deletes every key on the account: the code and the passports are then
  final, and the account can never be deleted (its NEAR stays staked; top-ups still work; testnet only).

## Cross-language test vector

`tests/nep413-vector.json` holds NEP-413 signatures made by `@hana-id/core`'s own signer (`encodeNep413Message` and
`signNep413Message`, what the vault signs) for two throwaway TEST keys; `packages/core/test/near-stamps-vector.test.ts`
writes and pins it, and the unit tests here must accept the good proofs and refuse every altered field, another
recipient, another contract account, another account's key, a callback URL, a named account, wrong-length or
non-standard base64 and a replay by another account. If the SDK's signer changed its bytes, the TypeScript test fails;
if the contract changed its check, the Rust tests fail. `apps/api/test-sandbox/stamps.test.ts` repeats it on a real
node: the SDK's signer, the relay's own code and the deployed wasm.

## With near CLI (near-cli-rs)

```sh
# Read
near contract call-function as-read-only hana-id-stamps-dev1.testnet catalog json-args '{}' network-config testnet now
near contract call-function as-read-only hana-id-stamps-dev1.testnet totals json-args '{}' network-config testnet now
near contract call-function as-read-only hana-id-stamps-dev1.testnet recent json-args '{"limit": 5}' network-config testnet now
near contract call-function as-read-only hana-id-stamps-dev1.testnet get_passport json-args '{"account_id": "<account>"}' network-config testnet now

# Collect from a funded account of yours (pays its own gas: arrival, own_fare, postcard, layover)
near contract call-function as-transaction hana-id-stamps-dev1.testnet collect json-args '{"stamp": "arrival"}' prepaid-gas '10 Tgas' attached-deposit '0 NEAR' sign-as <your-account>.testnet network-config testnet sign-with-legacy-keychain send
```

## Tests and build

```sh
cd contracts/hana-stamps && cargo test                        # unit tests: every rule and error, the vector, storage
cargo near build non-reproducible-wasm                        # wasm (target/near/hana_stamps.wasm)
cd ../integration-tests && cargo test --test stamps -- --nocapture   # sandbox tests, print the gas
```

`corepack pnpm verify` runs them in its contract and sandbox lanes whenever a file under `contracts/` changes, and the
sandbox lane's `apps/api` step runs `test-sandbox/stamps.test.ts` after them.
