import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { loadEnv, manifestPath, manifestSchema } from './index.ts';

const raw = () => JSON.parse(readFileSync(manifestPath('sandbox-dev'), 'utf8')) as Record<string, unknown>;

describe('loadEnv', () => {
  it('loads and validates sandbox-dev', () => {
    const env = loadEnv('sandbox-dev');
    expect(env.network).toBe('testnet');
    expect(env.ckdDomainId).toBe(2);
    // Real values once deployed: check the shape, not the IDs.
    expect(env.sharedGoogleClientIds.length).toBeGreaterThan(0);
    expect(env.sharedGoogleClientIds.every((id) => id.endsWith('.apps.googleusercontent.com'))).toBe(true);
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

describe('manifestSchema: Durable Object location', () => {
  const withLocation = (durableObjectLocation: unknown) => {
    const m = raw();
    return { ...m, cloudflare: { ...(m.cloudflare as Record<string, unknown>), durableObjectLocation } };
  };

  it('is optional', () => {
    const m = raw();
    const { durableObjectLocation: _, ...cloudflare } = m.cloudflare as Record<string, unknown>;
    expect(manifestSchema.safeParse({ ...m, cloudflare }).success).toBe(true);
  });

  it('accepts only Cloudflare location hints', () => {
    for (const hint of ['apac', 'weur', 'enam']) expect(manifestSchema.safeParse(withLocation(hint)).success).toBe(true);
    for (const bad of ['asia', 'APAC', '', 1]) expect(manifestSchema.safeParse(withLocation(bad)).success).toBe(false);
  });
});

describe('manifestSchema: rpcFallback', () => {
  it('is optional, https only, and not rpc itself', () => {
    const { rpcFallback: _, ...base } = raw();
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.parse({ ...base, rpcFallback: 'https://rpc.testnet.example' }).rpcFallback).toBe('https://rpc.testnet.example');
    const http = manifestSchema.safeParse({ ...base, rpcFallback: 'http://rpc.testnet.example' });
    expect(http.success).toBe(false);
    expect(http.error?.issues[0]?.message).toContain('https');
    expect(manifestSchema.safeParse({ ...base, rpcFallback: 'not a url' }).success).toBe(false);
    const same = manifestSchema.safeParse({ ...base, rpcFallback: base.rpc });
    expect(same.success).toBe(false);
    expect(same.error?.issues[0]?.message).toContain('different endpoint');
  });
});
