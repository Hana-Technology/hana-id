// Zeroisation of the intermediates that never leave derivation.ts (PRK from HKDF-Extract inside
// addressesFromCkdSecret, okm inside evmPrivateKey, seeds and d inside chainAddress and the export): noble's HKDF and
// mapHashToField are wrapped to capture every buffer they return, which must all be zero afterwards, also on errors.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const captured = vi.hoisted(() => ({ buffers: [] as Uint8Array[] }));

vi.mock('@noble/hashes/hkdf', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@noble/hashes/hkdf')>();
  return {
    ...orig,
    extract: (...args: Parameters<typeof orig.extract>) => {
      const out = orig.extract(...args);
      captured.buffers.push(out);
      return out;
    },
    expand: (...args: Parameters<typeof orig.expand>) => {
      const out = orig.expand(...args);
      captured.buffers.push(out);
      return out;
    },
  };
});

vi.mock('@noble/curves/abstract/modular', async (importOriginal) => {
  const orig = await importOriginal<typeof import('@noble/curves/abstract/modular')>();
  return {
    ...orig,
    mapHashToField: (...args: Parameters<typeof orig.mapHashToField>) => {
      const out = orig.mapHashToField(...args);
      captured.buffers.push(out);
      return out;
    },
  };
});

const { addressesFromCkdSecret, chainAddress, extractPrk, withChainKey } = await import('../src/derivation.ts');
const { exportKeyString } = await import('../src/export.ts');
const { fromHex } = await import('../src/bytes.ts');

const S_HEX = 'b87c634c70a33c5422dbb6d2bd0384004dcda96c209f2da747c79070afa83bace1da710748d27c4721ce358eacef1453';
const allZero = (b: Uint8Array): boolean => b.every((x) => x === 0);

beforeEach(() => {
  captured.buffers = [];
});

describe('derivation zeroes every intermediate', () => {
  it('addressesFromCkdSecret: S, PRK, both seeds, okm and d', () => {
    const s = fromHex(S_HEX);
    const out = addressesFromCkdSecret(s);
    expect(out.stellar).toMatch(/^G/u);
    expect(allZero(s)).toBe(true);
    // extract (PRK), expand ×2 (seed, okm), mapHashToField (d)
    expect(captured.buffers).toHaveLength(4);
    for (const b of captured.buffers) expect(allZero(b)).toBe(true);
  });

  it('exportKeyString zeroes the key bytes it encoded', () => {
    const prk = extractPrk(fromHex(S_HEX));
    captured.buffers = [];
    exportKeyString(prk, 'evm');
    exportKeyString(prk, 'stellar');
    expect(captured.buffers).toHaveLength(3);
    for (const b of captured.buffers) expect(allZero(b)).toBe(true);
    expect(allZero(prk)).toBe(false); // PRK is the caller's to zero
  });

  it('a throwing callback still zeroes okm and d', () => {
    const prk = extractPrk(fromHex(S_HEX));
    captured.buffers = [];
    expect(() =>
      withChainKey(prk, 'evm', 0, () => {
        throw new Error('signer failed');
      }),
    ).toThrow('signer failed');
    expect(captured.buffers).toHaveLength(2);
    for (const b of captured.buffers) expect(allZero(b)).toBe(true);
  });

  it('chainAddress zeroes the seed', () => {
    const prk = extractPrk(fromHex(S_HEX));
    captured.buffers = [];
    chainAddress(prk, 'stellar', 1);
    expect(captured.buffers).toHaveLength(1);
    expect(allZero(captured.buffers[0]!)).toBe(true);
  });
});
