// Every EVM chain the installed @sodax/types lists is one Journear's approval window names (@hana-id/core's
// evmChainInfo), as a real-money network, with the native coin Sodax gives it. A @sodax/types upgrade that adds an
// EVM chain fails this test until the chain is checked against its own docs and the public registries and named.
// Naming a chain allows nothing: a test app still refuses every one of them, and the mainnet demo stays Base only.
import { MAINNET_DEMO_EVM_CHAINS, evmChainInfo, evmNativeUnits, isTestEvmChain } from '@hana-id/core';
import { baseChainInfo, spokeChainConfig } from '@sodax/types';
import { describe, expect, it } from 'vitest';

type Info = { name: string; type: string; chainId: number | string; mainnet: boolean };
type Spoke = { nativeToken?: string; supportedTokens?: Record<string, { symbol: string; decimals: number; address: string }> };

const evmChains = Object.entries(baseChainInfo as unknown as Record<string, Info>).filter(([, c]) => c.type === 'EVM');
const spokes = spokeChainConfig as unknown as Record<string, Spoke>;

/** The native coin as Sodax lists it: the supported token at the chain's native token address. */
function sodaxNative(key: string): { symbol: string; decimals: number } | null {
  const s = spokes[key];
  const native = (s?.nativeToken ?? '').toLowerCase();
  const token = Object.values(s?.supportedTokens ?? {}).find((t) => t.address.toLowerCase() === native);
  return token ? { symbol: token.symbol, decimals: token.decimals } : null;
}

describe('the EVM chains Sodax lists', () => {
  it('are fourteen, all mainnets', () => {
    expect(evmChains.map(([, c]) => Number(c.chainId)).sort((a, b) => a - b)).toEqual([1, 10, 56, 137, 146, 151, 295, 999, 1890, 4663, 8217, 8453, 42161, 43114]);
    for (const [, c] of evmChains) expect(c.mainnet, c.name).toBe(true);
  });

  it.each(evmChains.map(([key, c]) => [c.name, key, Number(c.chainId)] as const))('%s is named, as real money, with Sodax’s native coin', (_, key, chainId) => {
    const info = evmChainInfo(chainId);
    expect(info, String(chainId)).not.toBeNull();
    expect(info?.testnet).toBe(false);
    expect(info?.label).toMatch(/ \(real money\)$/u);
    const native = sodaxNative(key);
    expect(native, key).not.toBeNull();
    expect(info?.nativeSymbol).toBe(native?.symbol);
    // Naming allows nothing.
    expect(isTestEvmChain(chainId)).toBe(false);
  });

  it('Hedera: Sodax counts HBAR in 8 decimals (tinybars, as programs see it); a transaction counts it in 18 (weibars), as the window shows it', () => {
    expect(sodaxNative('hedera')).toEqual({ symbol: 'HBAR', decimals: 8 });
    // Every other EVM chain's native coin has 18 decimals in Sodax's list too.
    for (const [key, c] of evmChains) if (key !== 'hedera') expect(sodaxNative(key)?.decimals, c.name).toBe(18);
    // The window's own units (D922): 18 decimals on every one of them, so nothing is scaled by Sodax's 8; the raw
    // number is in weibars on Hedera and wei on the rest.
    for (const [key, c] of evmChains) {
      const units = evmNativeUnits(Number(c.chainId));
      expect(units.decimals, c.name).toBe(18);
      expect(units.smallest, c.name).toBe(key === 'hedera' ? 'weibars' : 'wei');
    }
  });

  it('the mainnet demo stays Base only', () => {
    expect(MAINNET_DEMO_EVM_CHAINS).toEqual([8453]);
  });
});
