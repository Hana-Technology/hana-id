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

describe('manifestSchema: watchdog', () => {
  const watchdog = (over: Record<string, unknown> = {}) => ({
    account: 'watchdog.example.testnet',
    cloudflare: { accountId: 'a'.repeat(32), workerName: 'hana-id-watchdog-test', d1Name: 'hana-id-watchdog-test' },
    alertEmails: ['a@example.com', 'b@example.com'],
    alertFrom: 'alerts@notify.example.com',
    pager: 'ntfy',
    ...over,
  });
  // The service's account is also one of the contract's `watchdogs` (deploy-contract's add_watchdog).
  const withWatchdog = (w: unknown) => ({ ...raw(), watchdogs: [(w as { account?: unknown } | null)?.account], watchdog: w });
  const issues = (w: unknown) => manifestSchema.safeParse(withWatchdog(w)).error?.issues.map((i) => i.message) ?? [];

  it('is optional', () => {
    const { watchdog: _, ...base } = raw();
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.parse({ ...base, watchdogs: [watchdog().account], watchdog: watchdog() }).watchdog?.pager).toBe('ntfy');
  });

  it("must be one of the contract's watchdogs", () => {
    const { watchdogs: _, ...base } = raw();
    const msg = 'watchdog.account watchdog.example.testnet must be listed in watchdogs (the contract\'s watchdog accounts)';
    expect(manifestSchema.safeParse({ ...base, watchdog: watchdog() }).error?.issues.map((i) => i.message)).toEqual([msg]);
    expect(manifestSchema.safeParse({ ...base, watchdogs: ['other.example.testnet'], watchdog: watchdog() }).error?.issues.map((i) => i.message)).toEqual([msg]);
    expect(manifestSchema.safeParse({ ...base, watchdogs: ['other.example.testnet', watchdog().account], watchdog: watchdog() }).success).toBe(true);
  });

  it('accepts each paging app and an UNSET Cloudflare account id', () => {
    for (const pager of ['ntfy', 'pushover', 'pagerduty']) expect(issues(watchdog({ pager }))).toEqual([]);
    expect(issues(watchdog({ cloudflare: { ...watchdog().cloudflare, accountId: 'UNSET' } }))).toEqual([]);
    expect(issues(watchdog({ digestHourUtc: 23 }))).toEqual([]);
  });

  it('rejects bad fields', () => {
    expect(issues(watchdog({ pager: 'sms' })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ alertEmails: [] })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ alertEmails: ['not-an-email'] })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ alertFrom: 'x' })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ digestHourUtc: 24 })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ cloudflare: { ...watchdog().cloudflare, accountId: 'ABC' } }))[0]).toContain('Cloudflare account id');
    expect(issues(watchdog({ cloudflare: { ...watchdog().cloudflare, workerName: 'Bad_Name' } }))[0]).toContain('Worker name');
    expect(issues(watchdog({ account: 'Not An Account' })).length).toBeGreaterThan(0);
  });

  it('takes optional relayer funds thresholds in NEAR, critical below warn', () => {
    expect(issues(watchdog({ relayerFunds: {} }))).toEqual([]);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: 10, critical: 2 }, sessionAllowance: { warn: 1, critical: 0.2 }, ownerAllowance: { warn: 0.2, critical: 0 } } }))).toEqual([]);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: 1, critical: 1 } } }))).toEqual(['critical must be below warn']);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: 1, critical: 2 } } }))).toEqual(['critical must be below warn']);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: -1, critical: 0 } } })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: 1e9, critical: 0 } } })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ relayerFunds: { balance: { warn: 5 } } })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ relayerFunds: { topUp: true } })).length).toBeGreaterThan(0);
  });

  it('is a different account from those it watches, and a different Worker from the API', () => {
    const m = raw();
    for (const field of ['signer', 'relayer', 'owner', 'mpc']) {
      // (signer/relayer/owner also trip the `watchdogs` rule, since the helper lists the account there too.)
      expect(issues(watchdog({ account: m[field] }))).toContain(`watchdog.account must not be the ${field} account`);
    }
    const api = (m.cloudflare as { workerName: string }).workerName;
    expect(issues(watchdog({ cloudflare: { ...watchdog().cloudflare, workerName: api } }))[0]).toContain("differ from the API's Worker name");
    expect(issues(watchdog({ alertEmails: ['a@example.com', 'a@example.com'] }))).toEqual(['Duplicate alert email']);
  });
});
