// Type-checked (not run) in the throwaway project `pnpm run pack:check` installs the four tarballs into, the way a
// partner's TypeScript app would use them. Any declaration that doesn't resolve or doesn't fit fails the check
// (skipLibCheck is off). scripts/pack-check.ts.
import { VERSION as CORE_VERSION, TEST_EVM_CHAINS, toHex } from '@hana-id/core';
import { decodeEvmTransaction } from '@hana-id/core/decode';
import { DERIVATION_V1 } from '@hana-id/core/derivation';
import { type AutoApprovePolicyV1, validateAutoApprovePolicy } from '@hana-id/core/policy';
import { parseStellarEnvelope } from '@hana-id/core/signers/stellar';
import { HanaProvider, type UseHanaResult, useHana, useWallet } from '@hana-id/react';
import { createSodaxEvmProvider, createSodaxStellarProvider } from '@hana-id/sodax';
import {
  HANA_ENVIRONMENTS,
  type HanaAddresses,
  type HanaClient,
  type HanaConfig,
  HanaError,
  type HanaEthereumProvider,
  type HanaStatus,
  ProviderRpcError,
  createHana,
} from '@hana-id/web';
import { HanaIdModule } from '@hana-id/web/stellar-wallets-kit';
import type { IEvmWalletProvider, IStellarWalletProvider } from '@sodax/types';

const config: HanaConfig = {
  publishableKey: 'pk_test_example',
  environment: 'sandbox-dev',
  evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
  stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
};

export function wire(): {
  hana: HanaClient;
  evm: IEvmWalletProvider;
  stellar: IStellarWalletProvider;
  module: HanaIdModule;
  provider: HanaEthereumProvider;
} {
  const hana = createHana(config);
  const status: HanaStatus = hana.status;
  const addresses: HanaAddresses | null = hana.addresses;
  void status;
  void addresses;
  hana.on('accountsChanged', (a) => void a?.evm.toLowerCase());
  return {
    hana,
    evm: createSodaxEvmProvider(hana, { chainId: 84532, rpcUrl: 'https://sepolia.base.org' }),
    stellar: createSodaxStellarProvider(hana, {
      networkPassphrase: 'Test SDF Network ; September 2015',
      horizonUrl: 'https://horizon-testnet.stellar.org',
      sorobanRpcUrl: 'https://soroban-testnet.stellar.org',
    }),
    module: new HanaIdModule(hana),
    provider: hana.ethereum,
  };
}

export function useSignIn(): { login: UseHanaResult['login']; evm: string | null; stellar: string | null } {
  const { login } = useHana();
  return { login, evm: useWallet('evm').address, stellar: useWallet('stellar').address };
}

export const provider: typeof HanaProvider = HanaProvider;
export const envs: readonly string[] = HANA_ENVIRONMENTS;
export const errors = [HanaError, ProviderRpcError] as const;
export const core = { CORE_VERSION, TEST_EVM_CHAINS, toHex, decodeEvmTransaction, DERIVATION_V1, validateAutoApprovePolicy, parseStellarEnvelope };
export type Policy = AutoApprovePolicyV1;
