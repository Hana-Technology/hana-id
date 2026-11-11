# @hana-id/sodax

Optional Sodax wallet-provider adapters over `@hana-id/web`: an `IStellarWalletProvider` and an
`IEvmWalletProvider` (one per spoke chain), typed against `@sodax/types` 2.2.0.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs with their SHA-256 checksums: check them, then
install them together:

```sh
npm install ./hana-id-core-0.3.1.tgz ./hana-id-web-0.3.1.tgz ./hana-id-sodax-0.3.1.tgz @sodax/types@2.2.0
```

Peer dependency: `@sodax/types` `^2.2.0` (tested with 2.2.0). Install the version your `@sodax/sdk` depends on
(`@sodax/sdk` 2.2.0 pins `@sodax/types` 2.2.0), so there is one copy of Sodax's types. It is used for types only:
nothing of it is imported at runtime. ESM only, with TypeScript declarations. (SDK 0.2.0 was typed against 2.1.0.)

## Use

```ts
import { createHana } from '@hana-id/web';
import { createSodaxEvmProvider, createSodaxStellarProvider } from '@hana-id/sodax';

const hana = createHana({
  publishableKey: 'pk_test_…',
  environment: 'sandbox-dev',
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
});

const stellarProvider = createSodaxStellarProvider(hana, {
  networkPassphrase: 'Test SDF Network ; September 2015',
  horizonUrl: 'https://horizon-testnet.stellar.org',
  sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
}); // IStellarWalletProvider
const evmProvider = createSodaxEvmProvider(hana, { chainId: 84532, rpcUrl: 'https://sepolia.base.org' }); // IEvmWalletProvider
```

- The Stellar provider signs through `hana.stellar` (fee-bump allowed) and sends to Soroban RPC.
  `signAndSendTransaction(rawTx)` signs as `rawTx.from`: a transaction built for another account is refused (`4100`)
  before any popup. `waitForTransactionReceipt` polls Horizon every 2 s for 60 s.
- The EVM provider is bound to one chain, which must be in `createHana`'s `evm.chains`. It refuses a `from` other
  than the user's address and an `expectedChainId` (`@sodax/sdk` 2.2.0's second argument) other than its chain
  (`4902`, `expected_chain_mismatch`, before any popup), fills, gets the user's approval and broadcasts through the `evm.chains` RPC. `rpcUrl` is for
  receipts and must be the same chain (checked once with `eth_chainId` before the first signature; `4902`
  `receipt_rpc_wrong_chain` otherwise). `waitForTransactionReceipt` polls every 2 s for 180 s.
- Call `sendTransaction` / `signTransaction` from the user's click: the approval popup opens in that click (the EVM
  provider calls `hana.prepareApproval()` before its own awaits). A swap can need several signatures
  (`restoreFootprint`, a re-sign, a trustline); Hana's approval popup stays open 15 s after each answer, so they show
  in the same window and need an Approve each. Sodax swaps can't be
  auto-approved yet.

## What you can test with a test key

**Sodax has no testnet**: its hub is Sonic mainnet and every Sodax chain is a mainnet. During the pilot your app has a
test key (`pk_test_…`), whose keys come from the NEAR testnet MPC, and its vault refuses anything a mainnet would
accept (`4100`, `data.reason: 'mainnet_not_allowed'`), so no Sodax transaction can be signed yet. With a test key:

- Sodax quotes and intent building (`createIntent({ raw: true })`) work: read-only calls against mainnet.
- The adapters' signing, sending and receipts work with ordinary testnet transactions (Stellar testnet, Base Sepolia,
  Sonic testnet, …).
- A test app may list mainnet chains in `evm.chains` (reads work there); signing for them is refused. Through the EVM
  adapter the approval popup opens in the click and closes again when the refusal comes.

Build the transaction before the click (`createIntent({ raw: true })` when the user enters the amount), then call
`evmProvider.sendTransaction(tx)` in the click: `sodax.swaps.swap()` awaits allowance and simulation first, which costs
the click its popup. Real Sodax swaps through Hana wait for Hana's mainnet launch (live keys). Hana's own sandbox
mainnet demo runs under a Hana-internal exception that isn't available to partner apps.

Page requirements and error codes: the `@hana-id/web` README. Hana's partner guide (ask Hana for the current copy) has
the rest.
