import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as addresses from '../src/addresses.ts';
import * as hex from '../src/decode/hex.ts';
import * as core from '../src/index.ts';
import { VERSION } from '../src/index.ts';
import * as typedData from '../src/typed-data.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  name: string;
  version: string;
  exports: Record<string, string>;
};
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Every bare package an entry file reaches through its relative imports and re-exports (type-only ones included). */
function packagesReachedFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/(?:^|\n)\s*(?:import|export)\b[^;]*?\bfrom\s+'([^']+)'/gu)) {
      const spec = m[1] as string;
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  visit(resolve(root, entry));
  return packages;
}

/** The modules the root entry re-exports with `export *`, as written in src/index.ts. */
function starModules(): string[] {
  const src = readFileSync(resolve(root, 'src/index.ts'), 'utf8');
  return [...src.matchAll(/^export \* from '(\.\/[^']+)';$/gmu)].map((m) => m[1] as string);
}

describe('@hana-id/core', () => {
  it('exports its package.json version', () => {
    expect(pkg.name).toBe('@hana-id/core');
    expect(VERSION).toBe(pkg.version);
  });

  it('publishes the derivation, identity, wallet record, Stellar signer, decode, policy, Support ID, mainnet demo, demo constants and demo prices subpaths, and they exist', () => {
    expect(pkg.exports).toEqual({
      '.': './src/index.ts',
      './derivation': './src/derivation.ts',
      './identity': './src/identity.ts',
      './wallet-record': './src/wallet-record.ts',
      './signers/stellar': './src/signers/stellar.ts',
      './decode': './src/decode/index.ts',
      './policy': './src/policy/index.ts',
      './support-id': './src/support-id.ts',
      './mainnet-demo': './src/mainnet-demo.ts',
      './demo-config': './src/demo-config.ts',
      './mainnet-demo-prices': './src/mainnet-demo-prices.ts',
    });
    for (const path of Object.values(pkg.exports)) expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
  });

  it('keeps @stellar/stellar-base out of the root entry (bundle size of pages that sign nothing on Stellar)', () => {
    expect('signStellarTransaction' in core).toBe(false);
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).not.toMatch(/from '\.\/signers\/stellar\.ts'/u);
    expect('signEvmTransaction' in core && 'deriveAddresses' in core && 'parsePortRequest' in core).toBe(true);
    const rootPackages = packagesReachedFrom(pkg.exports['.'] as string);
    expect([...rootPackages].filter((p) => p.startsWith('@stellar/'))).toEqual([]);
    expect([...rootPackages].every((p) => p.startsWith('@noble/') || p.startsWith('@scure/'))).toBe(true);
    // The walker does see stellar-base where it is used.
    expect(packagesReachedFrom(pkg.exports['./decode'] as string)).toContain('@stellar/stellar-base');
    expect(packagesReachedFrom(pkg.exports['./policy'] as string)).toContain('@stellar/stellar-base');
    expect(packagesReachedFrom(pkg.exports['./signers/stellar'] as string)).toContain('@stellar/stellar-base');
    expect(packagesReachedFrom(pkg.exports['./mainnet-demo'] as string)).toContain('@stellar/stellar-base');
  });

  it('drops no name of an `export *` module from the root entry (ambiguous star exports vanish silently)', async () => {
    const modules = starModules();
    expect(modules.length).toBeGreaterThan(10);
    for (const spec of modules) {
      const mod = (await import(resolve(root, 'src', spec))) as Record<string, unknown>;
      for (const name of Object.keys(mod)) expect(name in core, `${spec}: ${name}`).toBe(true);
    }
  });

  it('resolves the names two modules define to the documented one', () => {
    // EIP-712: the single parser's hasher only; the looser second hasher's helpers are not exported (CORE-5).
    expect(core.hashTypedData).toBe(typedData.hashTypedData);
    for (const name of ['encodeType', 'typeHash', 'hashStruct', 'domainSeparator']) expect(name in core, name).toBe(false);
    // EVM addresses: addresses.ts's byte forms; the decoders' hex helpers.
    expect(core.parseEvmAddress).toBe(addresses.parseEvmAddress);
    expect(core.isEvmAddress).toBe(addresses.isEvmAddress);
    expect(core.checksumAddress).toBe(hex.checksumAddress);
    expect(core.parseHex0x).toBe(hex.parseHex0x);
    expect(core.toHex0x).toBe(hex.toHex0x);
    expect(core.bytesToBigInt).toBe(hex.bytesToBigInt);
  });

  it('serves every decoder and policy export from its subpath', async () => {
    const decode = await import('../src/decode/index.ts');
    const policy = await import('../src/policy/index.ts');
    const decoders = ['decodeApprovalRequest', 'decodeEvmTransaction', 'decodeStellarTransaction', 'typedDataView'];
    for (const name of decoders) {
      expect(typeof (decode as Record<string, unknown>)[name], name).toBe('function');
    }
    for (const name of ['validateAutoApprovePolicy', 'matchAutoApprovePolicy', 'policyId', 'recordAutoApproveUse']) {
      expect(typeof (policy as Record<string, unknown>)[name], name).toBe('function');
    }
  });
});
