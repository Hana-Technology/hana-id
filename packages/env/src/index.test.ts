import { describe, expect, it } from 'vitest';
import { loadEnv } from './index.ts';

describe('loadEnv', () => {
  it('loads and validates sandbox-dev', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.network).toBe('testnet');
    expect(env.ckdDomainId).toBe(2);
  });

  it('rejects path-like names', () => {
    expect(() => loadEnv('../x')).toThrow();
  });
});
