// Hana's verified Sodax contracts (packages/core/src/verified-contracts.ts, docs/decisions.md D44) against the
// installed @sodax/types config, the package the entries cite: every Sodax entry is the address that config gives for
// its role on its chain, and every entry is covered here. A @sodax/types upgrade that moves a contract fails this test,
// so the list is re-confirmed before it ships.
import { type ContractChain, STELLAR_MAINNET_PASSPHRASE, VERIFIED_CONTRACTS, verifiedContract } from '@hana-id/core';
import { ChainKeys, concentratedLiquidityConfig, hubConfig, moneyMarketConfig, solverConfig, spokeChainConfig } from '@sodax/types';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Expectation = readonly [chain: ContractChain, name: string, address: string];

const SONIC: ContractChain = { kind: 'evm', chainId: 146 };
const STELLAR: ContractChain = { kind: 'stellar', networkPassphrase: STELLAR_MAINNET_PASSPHRASE };
const spokes = spokeChainConfig as unknown as Record<string, { chain: { chainId: number | string }; addresses: Record<string, string>; bnUSD: string }>;

/** EVM spoke chains Hana lists, and whether the docs list their Connection contract too. */
const EVM_SPOKES: readonly (readonly [key: string, connection: boolean])[] = [
  [ChainKeys.ETHEREUM_MAINNET, false],
  [ChainKeys.OPTIMISM_MAINNET, false],
  [ChainKeys.BSC_MAINNET, false],
  [ChainKeys.POLYGON_MAINNET, false],
  [ChainKeys.REDBELLY_MAINNET, false],
  [ChainKeys.HEDERA_MAINNET, true],
  [ChainKeys.HYPEREVM_MAINNET, false],
  [ChainKeys.LIGHTLINK_MAINNET, false],
  [ChainKeys.ROBINHOOD_MAINNET, true],
  [ChainKeys.KAIA_MAINNET, true],
  [ChainKeys.BASE_MAINNET, false],
  [ChainKeys.ARBITRUM_MAINNET, false],
  [ChainKeys.AVALANCHE_MAINNET, false],
];

const EXPECTED: readonly Expectation[] = [
  [SONIC, 'Sodax Hub Asset Manager', hubConfig.addresses.assetManager],
  [SONIC, 'Sodax Hub Wallet Factory', hubConfig.addresses.hubWallet],
  [SONIC, 'Sodax Sonic Router', hubConfig.addresses.walletRouter],
  [SONIC, 'Sodax ICX Migration', hubConfig.addresses.icxMigration],
  [SONIC, 'Sodax BALN Migration', hubConfig.addresses.balnSwap],
  [SONIC, 'Sodax SODA token', hubConfig.addresses.sodaToken],
  [SONIC, 'Sodax SODA Vault', hubConfig.addresses.sodaVault],
  [SONIC, 'Sodax Staked SODA', hubConfig.addresses.stakedSoda],
  [SONIC, 'Sodax xSODA', hubConfig.addresses.xSoda],
  [SONIC, 'Sodax Staking Router', hubConfig.addresses.stakingRouter],
  [SONIC, 'Sodax Intents', solverConfig.intentsContract],
  [SONIC, 'Sodax Protocol Intents', solverConfig.protocolIntentsContract],
  [SONIC, 'Sodax Money Market Pool', moneyMarketConfig.lendingPool],
  [SONIC, 'Sodax bnUSD', moneyMarketConfig.bnUSD],
  [SONIC, 'Sodax bnUSD aToken', moneyMarketConfig.bnUSDAToken],
  [SONIC, 'Sodax bnUSD Vault', moneyMarketConfig.bnUSDVault],
  [SONIC, 'Sodax DEX Router', concentratedLiquidityConfig.router],
  [SONIC, 'Sodax DEX Position Manager', concentratedLiquidityConfig.clPositionManager],
  [SONIC, 'Sodax DEX Pool Manager', concentratedLiquidityConfig.clPoolManager],
  ...EVM_SPOKES.flatMap(([key, connection]): Expectation[] => {
    const s = spokes[key];
    if (!s) throw new Error(`no spoke config for ${key}`);
    const chain: ContractChain = { kind: 'evm', chainId: Number(s.chain.chainId) };
    return [
      [chain, 'Sodax Asset Manager', s.addresses.assetManager as string],
      [chain, 'Sodax bnUSD', s.bnUSD],
      ...(connection ? [[chain, 'Sodax Connection', s.addresses.connection as string] as const] : []),
    ];
  }),
  [STELLAR, 'Sodax Asset Manager', spokes[ChainKeys.STELLAR_MAINNET]?.addresses.assetManager as string],
  [STELLAR, 'Sodax bnUSD', spokes[ChainKeys.STELLAR_MAINNET]?.bnUSD as string],
];

describe('verified Sodax contracts vs @sodax/types', () => {
  it('cites the installed @sodax/types version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../node_modules/@sodax/types/package.json', import.meta.url), 'utf8')) as { version: string };
    for (const e of VERIFIED_CONTRACTS.filter((x) => x.protocol === 'Sodax')) {
      expect(e.sources.some((s) => s.startsWith(`https://unpkg.com/@sodax/types@${pkg.version}/`))).toBe(true);
    }
  });

  it.each(EXPECTED.map((x) => [`${x[1]} on ${x[0].kind === 'evm' ? x[0].chainId : 'Stellar'}`, ...x] as const))('%s', (_, chain, name, address) => {
    expect(address).toBeTruthy();
    expect(verifiedContract(chain, address)?.name).toBe(name);
  });

  it('every Sodax entry is one of the checked addresses', () => {
    const key = (c: ContractChain, a: string) => (c.kind === 'evm' ? `evm:${c.chainId}|${a.toLowerCase()}` : `stellar:${c.networkPassphrase}|${a}`);
    const checked = new Set(EXPECTED.map(([c, , a]) => key(c, a)));
    const sodax = VERIFIED_CONTRACTS.filter((e) => e.protocol === 'Sodax');
    expect(sodax.filter((e) => !checked.has(key(e.chain, e.address))).map((e) => `${e.name} ${e.address}`)).toEqual([]);
    expect(sodax.length).toBe(EXPECTED.length);
  });
});
