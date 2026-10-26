import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv, manifestPath, manifestSchema } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;

describe('loadEnv', () => {
  it('loads and validates sandbox-dev', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.network).toBe('testnet');
    expect(env.ckdDomainId).toBe(2);
    expect(env.sharedGoogleClientIds).toEqual(['UNSET-shared.apps.googleusercontent.com']);
  });

  it('rejects path-like names', () => {
    expect(() => loadEnv('../x')).toThrow();
  });
});

describe('manifestSchema: Google clients', () => {
  it('requires sharedGoogleClientIds', () => {
    const { sharedGoogleClientIds: _, ...rest } = raw();
    expect(manifestSchema.safeParse(rest).success).toBe(false);
    expect(manifestSchema.safeParse({ ...rest, sharedGoogleClientIds: [] }).success).toBe(true);
  });

  it('allows at most 5 shared clients, without duplicates or whitespace', () => {
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `s${i}.apps.googleusercontent.com`);
    expect(manifestSchema.safeParse({ ...raw(), sharedGoogleClientIds: ids(5) }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...raw(), sharedGoogleClientIds: ids(6) }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...raw(), sharedGoogleClientIds: ['a', 'a'] }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...raw(), sharedGoogleClientIds: ['a b'] }).success).toBe(false);
  });

  it('rejects a client that is both shared and a global-scope client', () => {
    const own = manifestSchema.safeParse({ ...raw(), googleClientIds: ['x.apps'], sharedGoogleClientIds: ['x.apps'] });
    expect(own.success).toBe(false);
    expect(own.error?.issues[0]?.message).toContain('either shared or a scope');
    const console = manifestSchema.safeParse({ ...raw(), consoleAudiences: [['google', 'c.apps']], sharedGoogleClientIds: ['c.apps'] });
    expect(console.success).toBe(false);
  });
});
