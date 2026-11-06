# @hana-id/sodax

Optional Sodax wallet-provider adapters over `@hana-id/web`: an `IStellarWalletProvider` and an
`IEvmWalletProvider` (one per spoke chain), typed against `@sodax/types` 2.1.0.

## Install

The packages aren't on a registry yet. Hana sends you the tarballs; install them together:

```sh
npm install ./hana-id-core-0.3.0.tgz ./hana-id-web-0.3.0.tgz ./hana-id-sodax-0.3.0.tgz @sodax/types@2.1.0
```

Peer dependency: `@sodax/types` `^2.1.0` (tested with 2.1.0). It is used for types only: nothing of it is imported at
runtime. ESM only, with TypeScript declarations.

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
  than the user's address, fills, gets the user's approval and broadcasts through the `evm.chains` RPC. `rpcUrl` is for
  receipts and must be the same chain (checked once with `eth_chainId` before the first signature; `4902`
  `receipt_rpc_wrong_chain` otherwise). `waitForTransactionReceipt` polls every 2 s for 180 s.
- Call `sendTransaction` / `signTransaction` from the user's click: the approval popup opens in that click (the EVM
  provider calls `hana.prepareApproval()` before its own awaits). A swap can need several signatures
  (`restoreFootprint`, a re-sign, a trustline); Hana's approval popup stays open 15 s after each answer, so they show
  in the same window and need an Approve each. Sodax swaps can't be
  auto-approved yet.

## Test networks only

During the pilot your app has a test key (`pk_test_…`) and its keys come from the NEAR testnet MPC. Its vault refuses
anything a mainnet would accept (`4100`, `data.reason: 'mainnet_not_allowed'`), including Sodax's mainnet
transactions. Integrate and test on chain testnets (Stellar testnet, Base Sepolia, Sonic testnet, …); real Sodax
swaps through Hana wait for live keys.

Page requirements and error codes: the `@hana-id/web` README. Hana's partner guide (`docs/integration.md` in the
private Hana ID repository; ask Hana for a copy) has the rest.
