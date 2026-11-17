# evm-delegate

`HanaDelegateExecutor`, the EIP-7702 delegate behind sponsored EVM transactions in Journear Passport, and `CheckIn`,
the demo target. A user's account delegates to `HanaDelegateExecutor` once; after that Journear's relayer submits
batches of calls the account's key signed and pays the gas, and the calls run from the account (`msg.sender` at each
target is the user's address, which never changes). Base Sepolia (84532) first; testnet only. Built and tested here,
**not deployed** (the deploy is a later step, after 2026-11-25, with `scripts/deploy-evm-delegate.ts`). MIT licensed (`LICENSE`), unlike most of the
repository (`../../LICENSING.md`). Decisions D841 (location, licence, deployment, interface) and D845 (security
properties) in `docs/decisions.md`.

## From a fresh clone

Foundry 1.5.1 (`forge`; `foundryup --install 1.5.1`), Node 22 and pnpm, then from the repository root:

```sh
corepack pnpm install                       # also fetches the pinned Solidity dependencies (below)
cd contracts/evm-delegate && forge test     # solc 0.8.28 is downloaded on first use
```

The Solidity dependencies are packages of this pnpm workspace, so the root `pnpm-lock.yaml` pins them with their
integrity hashes: `@openzeppelin/contracts` 5.7.0 from npm (a runtime dependency, so `pnpm audit --prod` and
`pnpm deps:audit` report its advisories) and `forge-std` v1.12.0 from GitHub at commit `7117c90c` (tests only;
forge-std is not published to npm by its authors). `foundry.toml` remaps both into `node_modules/`. No git
submodules, nothing vendored.

`corepack pnpm verify` runs this package's step (`evm`) whenever a file here or the lockfile changes: `forge fmt
--check`, `forge test`, then `node scripts/generate.mjs --check`. Without `forge` on the PATH, or before `pnpm
install`, the step is skipped and the summary says why. It is not in `--quick`.

## Interface (fixed: the TypeScript signer, the relayer and the vault code against it)

```solidity
struct Call { address to; uint256 value; bytes data; }

function execute(Call[] calldata calls, uint256 nonce_, uint256 deadline, address relayer, uint256 minGas,
                 bytes calldata signature) external          // 0x440dfe2d
function nonce() external view returns (uint256)             // 0xaffed0e0
function incrementNonce() external                           // 0x627cdcb9; only msg.sender == address(this)
function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4)   // ERC-1271, below
function eip712Domain() external view returns (bytes1, string, string, uint256, address, bytes32, uint256[]) // ERC-5267
function supportsInterface(bytes4) external view returns (bool)                                     // ERC-165
function onERC721Received(...) / onERC1155Received(...) / onERC1155BatchReceived(...)                // accept all
receive() external payable

event Executed(bytes32 indexed digest, uint256 nonce, uint256 callCount);   // topic 0xfe95c383…05930b
event NonceIncremented(uint256 newNonce);

error Expired(); error InvalidNonce(); error InvalidSignature(); error EmptyBatch(); error OnlyEOA();
error WrongRelayer(); error InsufficientGas(); error CallFailed(uint256 index, bytes reason);
error ReentrancyGuardReentrantCall();   // OpenZeppelin's guard; only ever seen inside a CallFailed reason
```

EIP-712, signed by the account's key:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract,bytes32 salt)
  name "HanaDelegateExecutor", version "1", chainId = the chain's id,
  verifyingContract = the user's account (address(this) under the delegation),
  salt = the implementation's address, left-padded to 32 bytes
Execute(Call[] calls,uint256 nonce,uint256 deadline,address relayer,uint256 minGas)Call(address to,uint256 value,bytes data)
```

`execute` checks, in this order, and reverts with the first that fails: `EmptyBatch` (no calls), `Expired`
(`block.timestamp > deadline`; the deadline second itself is accepted), `WrongRelayer` (`msg.sender != relayer`; the
zero address therefore matches no one), `InvalidNonce` (not `nonce()`), `InvalidSignature` (not a 65-byte low-s
signature by the account's key over this batch's digest). It then consumes the nonce, checks `gasleft() >= minGas`
(`InsufficientGas`), runs the calls in order and emits `Executed(digest, nonce, calls.length)`. A failing call reverts
the whole batch, nonce included, as `CallFailed(index, reason)` with at most the first 1024 bytes of the call's revert
data. A successful call's return data is never copied. A reentrant `execute` (from a target, or a call to the
account itself) fails with `ReentrancyGuardReentrantCall`, wrapped in the outer batch's `CallFailed`.

The nonce lives in the account's storage at the ERC-7201 slot of namespace `hana.storage.DelegateExecutor`,
`0xe526c94a37a61336af23ffe6f077f900033f135d7cb97e988e0cd22f1bf8ed00`; `execute` writes nothing else of the
account's storage. `CheckIn` is `checkIn()` (not payable; counts per caller in `checkIns(address)`, emits
`CheckedIn(address indexed account, uint256 count)`).

`isValidSignature` (ERC-1271) answers `0x1626ba7e` exactly when the signature over `hash` recovers to the account,
in the 65-byte (r, s, v) or the 64-byte ERC-2098 compact (r, vs) form, low s in both; anything else is `0xffffffff`.
That is what a protocol checks for a plain EOA: Permit2, for one, takes either form from an address without code and
asks ERC-1271 once the address has code, so the compact form must keep working for a delegated account. `execute`
takes only the 65-byte form (the wallet's).

## No fallback: what reverts once an account is delegated (deliberate)

The contract has `receive()` and its named functions, and no `fallback`. A plain EOA accepts any call; a delegated
account rejects calldata it doesn't know. So, once delegated:

- **ETH sent with calldata** (a wallet's "data" field, some exchanges' and bridges' withdrawals) reverts. A plain
  transfer (no calldata) still arrives.
- **Token callbacks to the account revert**: ERC-1363 `transferAndCall` / `approveAndCall` (`onTransferReceived`,
  `onApprovalReceived`), ERC-777 `tokensReceived` (and an ERC-777 send needs an ERC-1820 registration, since the
  account now has code), and any other unknown hook. ERC-721 and ERC-1155 safe transfers work.
- Plain ERC-20 `transfer` / `transferFrom` to the account are not callbacks and work as before.

Chosen on purpose: a catch-all fallback would make a wrongly encoded call (by the relayer, or anyone) look like a
success, and would answer token hooks the user never agreed to. The user's key can remove or replace the delegation.

## Duties the contract leaves to others

The contract checks what it can on chain; these must hold elsewhere, and each package that does them tests them.

**The wallet (vault), before it signs:**

- [ ] `minGas` from a simulation of the call loop: `minGas = ceil(L × 1.15) + 5 000 × calls`, `L` the gas the calls
      used when simulated from the account; refuse when it is above the app's cap. (63/64 of what is left reaches the
      first call; `test/Gas.t.sol` shows a target that swallows an inner out-of-gas has its full effect or reverts with
      such a floor, and can be degraded without one.)
- [ ] The relayer address only from its pinned build manifest, never from the page or the API's answer.
- [ ] The implementation address and its runtime code hash from the pinned table (they must equal `artifacts/`).
- [ ] Never sign this domain through the generic typed-data path, and never a raw hash for a partner (D833).

**The relayer, before and after it sends:**

- [ ] The account's code is exactly `0xef0100 ‖ implementation` before sending (or the transaction carries the
      authorization). A call to an account without it, or delegated elsewhere, runs nothing and still succeeds; an
      EIP-7702 authorization with a wrong nonce or chain is skipped by the network, not reverted.
- [ ] `gasLimit = (intrinsic + 25 000 per authorization + pre-loop overhead + minGas + event) × 1.1`, the overhead and
      event from "Gas" below; never from `eth_estimateGas` alone (it finds the least gas that succeeds, which for a
      gas-sensitive target can be a degraded run).
- [ ] Simulate at exactly that gas limit, and require the `Executed` event from the account with the signed digest:
      in the simulation, and in the receipt (a successful transaction without it ran nothing).
- [ ] Allowlist exact calldata where a function takes no arguments: `checkIn()` is exactly `0x183ff085`. Trailing
      bytes still run (the ABI decoder ignores them) but cost the sponsor calldata gas and L1 data fees.
- [ ] `nonce()` from the chain for the next batch.

## Gas

Measured by `test/Gas.t.sol` (`forge test --mc GasTest -vv` prints them; the test fails if they move by more than a
little), each in a fresh state: accounts and storage cold. "Frame gas" is the gas given to the call to the account (or
to `CheckIn`), not the transaction's: add the intrinsic 21 000, calldata, 25 000 per authorization and the delegated
account's access.

| What | Gas |
|---|---|
| Pre-loop overhead (from entry to the `minGas` check), 1 call, first batch (nonce 0 → 1, a zero slot) | 29 719 |
| Pre-loop overhead, 4 calls, first batch | 33 785 (about 1 360 per extra call) |
| Pre-loop overhead, 1 call, a later batch (nonce n → n + 1) | 9 819 |
| `execute` with one `checkIn()`, least frame gas that succeeds, first batch and first check-in | 58 948 |
| `execute` with one `checkIn()`, least frame gas that succeeds, later batch and later check-in | 16 648 |
| `checkIn()` alone, least frame gas, an account's first check-in | 23 899 |
| `checkIn()` alone, least frame gas, a later check-in | 4 746 |
| The `Executed` event (LOG2, 64 bytes of data) | 1 637 plus memory, about 1 700 |

At the boundary, with `minGas` 100 000, the first call received 97 503 gas (63/64 of the floor less the call's own
cost); one unit less at the check reverts `InsufficientGas` with the nonce unchanged.

## Deployment

Through the deterministic deployment proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` (CREATE2, present on Base
Sepolia), with a fixed salt, so the address is the same on every chain and anyone can check it from the source. The
deploy script is `scripts/deploy-evm-delegate.ts <env>` (plan by default, `--yes --account <Foundry keystore>` to
send; it re-derives each address from these artifacts, compares the code at it with the runtime code hash, and prints
the verification commands and the pinned-table entry): `docs/operations.md` "EVM sponsorship relay (not live)", D849.

| Contract | Salt (keccak256 of) | Predicted address | Runtime code hash |
|---|---|---|---|
| `HanaDelegateExecutor` | `hana-id/evm-delegate/HanaDelegateExecutor/v1` | `0xfC5e59d87a21045E5A480cFD75fcf1b010e8e4AA` | `0xfcc832fe6c7167e0d45589881b103fed92b3a44fe3dd5d489f43e9d44b1e5fd2` |
| `CheckIn` | `hana-id/evm-delegate/CheckIn/v1` | `0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e` | `0x807946bfc8ed8e9b3fe9ef6bdeed6c9dfa519084bcda4a5b17c2059c96d0bb56` |

The runtime code hash is of the code at that address (the immutable implementation address filled in). The bytecode
carries no metadata hash or CBOR trailer (`bytecode_hash = "none"`, `cbor_metadata = false`), so comments and file
paths don't move the address; any change to the code, the compiler settings in `foundry.toml` or OpenZeppelin does,
and every pinned copy (the core signer's table, the manifest) must follow. `forge test --mc ArtifactsTest -vv` prints
both addresses from a real CREATE2 deployment.

**Verifying on an explorer:** the metadata is stripped, so a Sourcify exact (full) match is not available and
"flattened source" uploads may not match. Verify with the **standard-JSON input** (`forge verify-contract` builds it
from `foundry.toml`; or `forge build --build-info`): solc `0.8.28+commit.7893614a`, optimizer on with 10 000 runs, EVM
`prague`, `metadata.bytecodeHash` `none`, `metadata.appendCBOR` false, the remappings above, no constructor arguments.

## Checked-in outputs (`node scripts/generate.mjs`, after `forge build`; `pnpm run generate` does both)

- `artifacts/HanaDelegateExecutor.json`, `artifacts/CheckIn.json`: `contractName`, `source`, `license`, `compiler`
  (`version`, `evmVersion`, `optimizer`, `viaIR`, `metadata`), `create2` (`deployer`, `saltLabel`, `salt`,
  `initCodeHash`, `address`), `runtimeCodeHash`, `eip712` (delegate only: `name`, `version`, `salt`, `executeType`,
  `callType`), `abi`, `bytecode` (creation), `deployedBytecode` (immutables zero, as compiled), `immutableReferences`.
  `test/Artifacts.t.sol` fails when they no longer match the build; `--check` compares every byte, the ABI included.
- `test/vectors/execute-v1.json`: a byte-for-byte copy of the TypeScript signer's vector,
  `packages/core/test/vectors/evm-sponsor-v1.json` (generated there with viem; **the core file is the source**:
  change it there, then `pnpm run generate` here copies it). Its `contract` block (name, version, the domain, Execute
  and Call type strings and hashes, the function and selector `0x440dfe2d`), the test keys' seeds (`keccak256(utf8(
  seed))`, test only) and `cases[]`, each with `inputs { chainId, account, implementation, calls[{ to, value, data }],
  nonce, deadline, relayer, minGas }` (integers as decimal strings, `chainId` a number), `domainSeparator`,
  `structHash`, `digest`, `signature`, `calldata`, and the core-only `authorization`, `subject` and `relayerTx`.
  `test/Vectors.t.sol` checks the contract block against the contract, recomputes every case's hashes, the RFC 6979
  signature and the calldata, then runs the calldata from the vector's relayer against the contract deployed at the
  case's implementation address; it and `generate.mjs --check` fail if the copy differs from the source (or the source
  is missing). `packages/core/test/evm-sponsor.test.ts` in turn fails if the core signer's pinned delegate disagrees
  with `artifacts/HanaDelegateExecutor.json` on the address or the runtime code hash.

## Tests

`test/HanaDelegateExecutor.t.sol` (real EIP-7702 delegations through `vm.signAndAttachDelegation` on Prague): the
batch runs from the account; the authorization in the same transaction as `execute`; batches of 1 to 8 calls with data
of any length (fuzz); value running out partway; a failing call after others (index, the 1024-byte cap, roll-back); replay, stale and future nonces; another key, another account, another chain, another
implementation (refused by the salt); every signed field tampered with; high-s, ERC-2098 compact, empty, 64, 66 and 130
bytes, v 0/1, r = s = 0; the deadline second and the one after; the relayer (another, zero, the account itself);
under-gassed submission and the signed floor; a failing call's index and roll-back, a spoofed executor error, return
and revert bombs (with a contrast that a copying caller runs out of gas); empty batch; self-calls (`incrementNonce`,
value to itself, `execute`) and reentry through another contract; the guard after a reverted and a successful batch in
one transaction; native, ERC-721 and ERC-1155 receipt; unknown calldata reverts; ERC-165; ERC-1271 (the account's
signature in both the 65-byte and compact forms, both parities, everything else refused including any other length,
an Execute signature useless to a Permit2-style protocol and the reverse, a compact permit accepted); an
undelegated and a revoked account run nothing; the ERC-7201 slot recomputed and the only slot written; the digest
against Foundry's own EIP-712 hasher; fuzz (any other key, any signature bytes, any wrong nonce, any batch, nonce only
increases). `test/Invariant.t.sol`: random sequences of valid batches, replays, future nonces, foreign signatures and
increments; the nonce never decreases and counts exactly the accepted actions. `test/Gas.t.sol`: the floor at its
exact boundary, the swallowing target with and without a floor, the gas numbers. `test/Vectors.t.sol`,
`test/Artifacts.t.sol` as above. Every check of `execute` (and the gas check moved before the nonce write, or loosened
by 3 000 or 30 000 gas, and the compact branch) was removed or altered one at a time: each fails the suite.
