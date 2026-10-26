import { describe, expect, it } from 'vitest';
import { baseDecode } from '@near-js/utils';
import { isPublishableKey, newAppId, PK_RANDOM_BYTES, publishableKey } from '../lib/pk.ts';

describe('publishable keys', () => {
  it('is pk_test_ + base58 of 24 random bytes', () => {
    const k = publishableKey();
    expect(k.startsWith('pk_test_')).toBe(true);
    expect(isPublishableKey(k)).toBe(true);
    expect(baseDecode(k.slice('pk_test_'.length))).toHaveLength(PK_RANDOM_BYTES);
  });

  it('is deterministic given bytes and differs between calls', () => {
    const bytes = new Uint8Array(24).fill(255);
    expect(publishableKey(bytes)).toBe(publishableKey(bytes));
    expect(publishableKey()).not.toBe(publishableKey());
  });

  it('rejects other lengths and formats', () => {
    expect(() => publishableKey(new Uint8Array(16))).toThrow();
    expect(isPublishableKey('pk_live_abc')).toBe(false);
    expect(isPublishableKey('pk_test_0OIl')).toBe(false);
  });

  it('app ids', () => {
    expect(newAppId()).toMatch(/^app_[1-9A-HJ-NP-Za-km-z]+$/u);
  });
});
