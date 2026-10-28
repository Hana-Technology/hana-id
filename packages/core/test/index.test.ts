import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '../src/index.ts';
import { VERSION } from '../src/index.ts';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { name: string; version: string; exports: Record<string, string> };

describe('@hana-id/core', () => {
  it('exports its package.json version', () => {
    expect(pkg.name).toBe('@hana-id/core');
    expect(VERSION).toBe(pkg.version);
  });

  it('publishes the derivation and Stellar signer subpaths, and they exist', () => {
    expect(pkg.exports).toEqual({ '.': './src/index.ts', './derivation': './src/derivation.ts', './signers/stellar': './src/signers/stellar.ts' });
    for (const path of Object.values(pkg.exports)) expect(existsSync(new URL(`../${path}`, import.meta.url))).toBe(true);
  });

  it('keeps @stellar/stellar-base out of the main entry (bundle size of pages that sign nothing on Stellar)', () => {
    expect('signStellarTransaction' in core).toBe(false);
    expect(readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')).not.toMatch(/from '\.\/signers\/stellar\.ts'/u);
    expect('signEvmTransaction' in core && 'deriveAddresses' in core && 'parsePortRequest' in core).toBe(true);
  });
});
