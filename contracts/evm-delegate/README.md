# evm-delegate

`HanaDelegateExecutor`, the EIP-7702 delegate behind sponsored EVM transactions in Journear Passport, and `CheckIn`,
the demo target. A user's account delegates to `HanaDelegateExecutor` once; after that Journear's relayer submits
batches of calls the account's key signed and pays the gas, and the calls run from the account (`msg.sender` at each
target is the user's address, which never changes). Base Sepolia (84532) first; testnet only. Built and tested here,
**not deployed** (the deploy is a later step, after 2026-11-25). MIT licensed (`LICENSE`), unlike most of the
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
function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4)   // ERC-1271
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

## What a submitter must check (the contract cannot)

- **The delegation is in place** before sending: the account's code is exactly `0xef0100 ‖ implementation`. A call to
  an account without it, or delegated elsewhere, runs nothing and still succeeds (an EOA accepts any calldata); an
  EIP-7702 authorization whose nonce or chain is wrong is skipped by the network, not reverted.
- **The `Executed` event** in the receipt, from the account, with the signed digest: a successful transaction without
  it ran nothing.
- **`minGas`** is the user's floor for the calls (63/64 of what is left reaches the first call): sign the batch's
  estimate with a margin, and send with enough gas above it for the checks (about 30 000 for one call).

## Deployment

Through the deterministic deployment proxy `0x4e59b44847b379578588920cA78FbF26c0B4956C` (CREATE2, present on Base
Sepolia), with a fixed salt, so the address is the same on every chain and anyone can check it from the source:

| Contract | Salt (keccak256 of) | Predicted address | Runtime code hash |
|---|---|---|---|
| `HanaDelegateExecutor` | `hana-id/evm-delegate/HanaDelegateExecutor/v1` | `0x9Da1B14209582ba699962a8a2F4e9d4506B6b762` | `0x710d7e3fd533a37e4e724da514b75b8331081e2e8b765046f7e179492edb26ba` |
| `CheckIn` | `hana-id/evm-delegate/CheckIn/v1` | `0xa84BBd91a395ae028eE2890DcA0e20570C1Aa39e` | `0x807946bfc8ed8e9b3fe9ef6bdeed6c9dfa519084bcda4a5b17c2059c96d0bb56` |

The runtime code hash is of the code at that address (the immutable implementation address filled in). The bytecode
carries no metadata hash or CBOR trailer (`bytecode_hash = "none"`, `cbor_metadata = false`), so comments and file
paths don't move the address; any change to the code, the compiler settings in `foundry.toml` or OpenZeppelin does,
and every pinned copy (the core signer's table, the manifest) must follow. `forge test --mc ArtifactsTest -vv` prints
both addresses from a real CREATE2 deployment.

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
  case's implementation address; once both files are in one checkout it and `generate.mjs --check` fail if the copy
  differs from the source.

## Tests

`test/HanaDelegateExecutor.t.sol` (real EIP-7702 delegations through `vm.signAndAttachDelegation` on Prague): the
batch runs from the account; replay, stale and future nonces; another key, another account, another chain, another
implementation (refused by the salt); every signed field tampered with; high-s, ERC-2098 compact, empty, 64, 66 and 130
bytes, v 0/1, r = s = 0; the deadline second and the one after; the relayer (another, zero, the account itself);
under-gassed submission and the signed floor; a failing call's index and roll-back, a spoofed executor error, return
and revert bombs (with a contrast that a copying caller runs out of gas); empty batch; self-calls (`incrementNonce`,
value to itself, `execute`) and reentry through another contract; the guard after a reverted and a successful batch in
one transaction; native, ERC-721 and ERC-1155 receipt; unknown calldata reverts; ERC-165; ERC-1271 (the account's
signature, everything else refused, an Execute signature useless to a Permit2-style protocol and the reverse); an
undelegated and a revoked account run nothing; the ERC-7201 slot recomputed and the only slot written; the digest
against Foundry's own EIP-712 hasher; fuzz (any other key, any signature bytes, any wrong nonce, any batch, nonce only
increases). `test/Invariant.t.sol`: random sequences of valid batches, replays, future nonces, foreign signatures and
increments; the nonce never decreases and counts exactly the accepted actions. `test/Vectors.t.sol`,
`test/Artifacts.t.sol` as above.
