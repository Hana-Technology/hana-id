// The package surface, and the type check against @sodax/types 2.2.0 (Tests → Sodax → "The adapters type-check against
// @sodax/types 2.2.0"): `pnpm typecheck` compiles this file, so the assignments below fail CI if the adapters stop
// fitting the SDK's wallet-provider slots; the version test fails if the pinned types drift from 2.2.0.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { EvmRawTransaction, EvmRawTransactionReceipt, EvmSendTransactionOptions, Hash, IEvmWalletProvider, IStellarWalletProvider, StellarRawTransaction, StellarRawTransactionReceipt } from '@sodax/types';
import * as sodax from '../src/index.ts';
import { VERSION, createSodaxEvmProvider, createSodaxStellarProvider } from '../src/index.ts';

describe('@hana-id/sodax', () => {
  it('exports its package.json version', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string };
    expect(pkg.name).toBe('@hana-id/sodax');
    expect(VERSION).toBe(pkg.version);
  });

  it('exports the two factories and the receipt timings', () => {
    expect(Object.keys(sodax).sort()).toEqual(
      ['EVM_RECEIPT_POLL_MS', 'EVM_RECEIPT_TIMEOUT_MS', 'STELLAR_RECEIPT_POLL_MS', 'STELLAR_RECEIPT_TIMEOUT_MS', 'VERSION', 'createSodaxEvmProvider', 'createSodaxStellarProvider'].sort(),
    );
    expect([sodax.STELLAR_RECEIPT_POLL_MS, sodax.STELLAR_RECEIPT_TIMEOUT_MS, sodax.EVM_RECEIPT_POLL_MS, sodax.EVM_RECEIPT_TIMEOUT_MS]).toEqual([2_000, 60_000, 2_000, 180_000]);
  });

  it('is type-checked against exactly @sodax/types 2.2.0', () => {
    const pkg = createRequire(import.meta.url)('@sodax/types/package.json') as { version: string };
    expect(pkg.version).toBe('2.2.0');
    const own = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { devDependencies: Record<string, string> };
    expect(own.devDependencies['@sodax/types']).toBe('2.2.0');
  });

  it('the adapters fit the SDK wallet-provider types (compile-time)', () => {
    type Stellar = ReturnType<typeof createSodaxStellarProvider>;
    type Evm = ReturnType<typeof createSodaxEvmProvider>;
    expectTypeOf<Stellar>().toExtend<IStellarWalletProvider>();
    expectTypeOf<Evm>().toExtend<IEvmWalletProvider>();
    expectTypeOf<Stellar['chainType']>().toEqualTypeOf<'STELLAR'>();
    expectTypeOf<Evm['chainType']>().toEqualTypeOf<'EVM'>();
    // The SDK's calls: signTransaction(xdr) and signTransaction(xdr, {address}); sendTransaction(rawTx) with one argument, or with 2.2.0's options.
    expectTypeOf<Stellar['signTransaction']>().toBeCallableWith('AAAA');
    expectTypeOf<Stellar['signTransaction']>().toBeCallableWith('AAAA', { address: 'G' });
    expectTypeOf<Stellar['sendTransaction']>().returns.toEqualTypeOf<Promise<string>>();
    expectTypeOf<Stellar['signAndSendTransaction']>().parameters.toEqualTypeOf<[StellarRawTransaction]>();
    expectTypeOf<Stellar['waitForTransactionReceipt']>().returns.toEqualTypeOf<Promise<StellarRawTransactionReceipt>>();
    expectTypeOf<Evm['sendTransaction']>().parameters.toEqualTypeOf<[EvmRawTransaction, EvmSendTransactionOptions?]>();
    expectTypeOf<Evm['sendTransaction']>().toBeCallableWith({ from: '0x', to: '0x', value: 0n, data: '0x' });
    expectTypeOf<Evm['sendTransaction']>().returns.toEqualTypeOf<Promise<Hash>>();
    expectTypeOf<Evm['waitForTransactionReceipt']>().returns.toEqualTypeOf<Promise<EvmRawTransactionReceipt>>();
  });
});
