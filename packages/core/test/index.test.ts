import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VERSION } from '../src/index.ts';

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

describe('@hana-id/core', () => {
  it('exports its package.json version', () => {
    expect(pkg.name).toBe('@hana-id/core');
    expect(VERSION).toBe(pkg.version);
  });

  it('keeps @stellar/stellar-base out of the root entry; the decoders and policy are subpaths', () => {
    expect(pkg.exports).toEqual({
      '.': './src/index.ts',
      './decode': './src/decode/index.ts',
      './policy': './src/policy/index.ts',
    });
    const rootPackages = packagesReachedFrom(pkg.exports['.'] as string);
    expect([...rootPackages].filter((p) => p.startsWith('@stellar/'))).toEqual([]);
    expect([...rootPackages].every((p) => p.startsWith('@noble/') || p.startsWith('@scure/'))).toBe(true);
    // The walker does see stellar-base where it is used.
    expect(packagesReachedFrom(pkg.exports['./decode'] as string)).toContain('@stellar/stellar-base');
    expect(packagesReachedFrom(pkg.exports['./policy'] as string)).toContain('@stellar/stellar-base');
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
