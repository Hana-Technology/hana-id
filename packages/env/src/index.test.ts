import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { apiRpcFallbacksOf, loadEnv, MAX_API_RPC_FALLBACKS, manifestPath, manifestSchema } from './index.ts';

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
    // Without an email issuer: with one, rpcFallback is required outside local* envs (D263, tested below).
    const { rpcFallback: _, emailIssuer: _issuer, ...base } = raw();
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

  it('is another provider than rpc (registrable domain) outside local* envs: a member path is confirmed on both (D263)', () => {
    const { rpcFallback: _, ...base } = raw();
    const host = new URL(base.rpc as string).hostname.split('.').slice(-2).join('.');
    const sameProvider = manifestSchema.safeParse({ ...base, rpcFallback: `https://other-node.${host}` });
    expect(sameProvider.success).toBe(false);
    expect(sameProvider.error?.issues.map((i) => i.message).join()).toContain('another provider');
    expect(manifestSchema.safeParse({ ...base, rpcFallback: 'https://rpc.testnet.near.org' }).success).toBe(true);
  });
});

describe('manifestSchema: apiRpcFallbacks (D435)', () => {
  const messages = (m: Record<string, unknown>): string[] => manifestSchema.safeParse(m).error?.issues.map((i) => i.message) ?? [];

  it('is optional; when set, 1 to MAX_API_RPC_FALLBACKS https URLs, kept in order', () => {
    const { apiRpcFallbacks: _, ...base } = raw();
    expect(manifestSchema.safeParse(base).success).toBe(true);
    const list = ['https://rpc.two.example', 'https://rpc.one.example'];
    expect(manifestSchema.parse({ ...base, apiRpcFallbacks: list }).apiRpcFallbacks).toEqual(list);
    expect(manifestSchema.safeParse({ ...base, apiRpcFallbacks: [] }).success).toBe(false);
    const many = Array.from({ length: MAX_API_RPC_FALLBACKS + 1 }, (_, i) => `https://rpc-${i}.example`);
    expect(manifestSchema.safeParse({ ...base, apiRpcFallbacks: many }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, apiRpcFallbacks: many.slice(0, MAX_API_RPC_FALLBACKS) }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, apiRpcFallbacks: ['not a url'] }).success).toBe(false);
  });

  it('refuses http outside a local* loopback, rpc itself and repeats', () => {
    const { apiRpcFallbacks: _, ...base } = raw();
    expect(messages({ ...base, apiRpcFallbacks: ['https://ok.example', 'http://rpc.example.com'] })).toEqual(['apiRpcFallbacks[1] must be an https URL (http only for a loopback host in local* envs)']);
    expect(messages({ ...base, apiRpcFallbacks: [base.rpc] })).toEqual(['apiRpcFallbacks must not repeat rpc (it is always asked first)']);
    expect(messages({ ...base, apiRpcFallbacks: ['https://a.example', 'https://a.example'] })).toEqual(['apiRpcFallbacks lists https://a.example twice']);
  });

  it('apiRpcFallbacksOf: the list, else rpcFallback alone, else none', () => {
    expect(apiRpcFallbacksOf({ apiRpcFallbacks: ['https://b.example', 'https://c.example'], rpcFallback: 'https://f.example' })).toEqual(['https://b.example', 'https://c.example']);
    expect(apiRpcFallbacksOf({ rpcFallback: 'https://f.example' })).toEqual(['https://f.example']);
    expect(apiRpcFallbacksOf({})).toEqual([]);
  });

  it('sandbox-dev: two testnet providers other than rpc, its rpcFallback first', () => {
    const m = loadEnv('sandbox-dev');
    expect(m.network).toBe('testnet');
    expect(m.apiRpcFallbacks).toEqual(['https://rpc.testnet.near.org', 'https://near-testnet.drpc.org']);
    expect(m.apiRpcFallbacks?.[0]).toBe(m.rpcFallback);
    expect(m.apiRpcFallbacks).not.toContain(m.rpc);
  });
});

/** The kids sandbox-dev's identity JWKS publishes. */
const identityKids = (): string[] => (raw().identityToken as { publicKeys: { kid: string }[] }).publicKeys.map((k) => k.kid);

describe('manifestSchema: homeDerivesPerDay', () => {
  const base = raw();
  it('takes an integer of 0 or more, and is optional', () => {
    expect(manifestSchema.safeParse(base).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, homeDerivesPerDay: 0 }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, homeDerivesPerDay: 500 }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, homeDerivesPerDay: -1 }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, homeDerivesPerDay: 1.5 }).success).toBe(false);
  });
});

describe('manifestSchema: hanaOrgId', () => {
  const base = raw();
  it('takes an org id, and is optional', () => {
    expect(manifestSchema.safeParse({ ...base, hanaOrgId: 'org_2Yh8sJq4Lm' }).success).toBe(true);
    expect(manifestSchema.safeParse({ ...base, hanaOrgId: 'hana' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, hanaOrgId: 'org_' }).success).toBe(false);
    expect(manifestSchema.safeParse({ ...base, hanaOrgId: `org_${'a'.repeat(61)}` }).success).toBe(false);
  });
});

describe('manifestSchema: watchdog', () => {
  const watchdog = (over: Record<string, unknown> = {}) => ({
    account: 'watchdog.example.testnet',
    cloudflare: { accountId: 'a'.repeat(32), workerName: 'hana-id-watchdog-test', d1Name: 'hana-id-watchdog-test' },
    alertEmails: ['a@example.com', 'b@example.com'],
    alertFrom: 'alerts@notify.example.com',
    pager: 'ntfy',
    // sandbox-dev publishes identity keys, so the watchdog pins them (D211).
    pinnedIdentityKeys: identityKids(),
    ...over,
  });
  // The service's account is also one of the contract's `watchdogs` (deploy-contract's add_watchdog).
  const withWatchdog = (w: unknown) => ({ ...raw(), watchdogs: [(w as { account?: unknown } | null)?.account], watchdog: w });
  const issues = (w: unknown) => manifestSchema.safeParse(withWatchdog(w)).error?.issues.map((i) => i.message) ?? [];

  it('takes pinned exit clients and an alarm level, refuses a duplicate, a bad provider and an out-of-range level', () => {
    expect(issues(watchdog({ pinnedExitClients: [['google', 'exit.apps'], ['email', 'hana-home']], exitAlertPerHour: 50 }))).toEqual([]);
    expect(issues(watchdog({ pinnedExitClients: [['google', 'exit.apps'], ['google', 'exit.apps']] })).join()).toContain('An exit client is pinned once');
    expect(issues(watchdog({ pinnedExitClients: [['Bad Provider', 'x']] })).join()).toContain('A provider is');
    expect(issues(watchdog({ pinnedExitClients: [] })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ pinnedExitClients: [['a', '1'], ['b', '1'], ['c', '1'], ['d', '1'], ['e', '1']] })).length).toBeGreaterThan(0);
    expect(issues(watchdog({ exitAlertPerHour: 0 })).length).toBeGreaterThan(0);
  });

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

  it('takes an optional https origin as its url (the admin Worker reads the status there, C14)', () => {
    expect(issues(watchdog({ url: 'https://hana-id-watchdog-test.ops.workers.dev' }))).toEqual([]);
    expect(issues(watchdog({ url: 'https://hana-id-api-test.ops.workers.dev' }))).toEqual(['watchdog.url on workers.dev must be https://hana-id-watchdog-test.<subdomain>.workers.dev']);
    expect(issues(watchdog({ url: 'https://a.b.ops.workers.dev' }))).toEqual(['watchdog.url on workers.dev must be https://hana-id-watchdog-test.<subdomain>.workers.dev']);
    expect(issues(watchdog({ url: 'https://watchdog.hana.example' }))).toEqual([]);
    expect(issues(watchdog({ url: 'http://watchdog.hana.example' }))).toEqual(['watchdog.url must be https']);
    expect(issues(watchdog({ url: 'https://watchdog.hana.example/' }))).toEqual(['watchdog.url must be an origin only (no path, query or trailing slash)']);
    expect(issues(watchdog({ url: 'https://watchdog.hana.example/status' }))).toEqual(['watchdog.url must be an origin only (no path, query or trailing slash)']);
    expect(issues(watchdog({ url: 'https://u:p@watchdog.hana.example' }))).toEqual(['watchdog.url must not carry credentials']);
    expect(issues(watchdog({ url: 'https://watchdog.hana.example:8443' }))).toEqual(['watchdog.url must not have a port']);
    expect(issues(watchdog({ url: 'not a url' }))).toEqual(['watchdog.url is not a URL']);
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

  describe('pinnedIssuerKeys.email (the email signer policy)', () => {
    const tp = (c: string) => c.repeat(43);
    const pins = (email: unknown) => watchdog({ pinnedIssuerKeys: { email } });

    it('is optional (absent: nothing pinned) and takes 1-of-1 and 2-of-2 policies', () => {
      expect(issues(watchdog({ pinnedIssuerKeys: {} }))).toEqual([]);
      expect(issues(pins({ required: 1, signers: { hana: [tp('a'), tp('b')] } }))).toEqual([]);
      expect(issues(pins({ required: 2, signers: { hana: [tp('a')], cosign: [tp('c')] }, jwksUrl: 'https://api.example.com/v1/email/jwks.json' }))).toEqual([]);
      const m = manifestSchema.parse({ ...withWatchdog(pins({ required: 1, signers: { hana: [tp('a')] } })) });
      expect(m.watchdog?.pinnedIssuerKeys?.email?.signers.hana).toEqual([tp('a')]);
    });

    it('pins keys by RFC 7638 thumbprint and signer ids as the contract accepts them', () => {
      expect(issues(pins({ required: 1, signers: { hana: ['short'] } }))[0]).toContain('RFC 7638 JWK thumbprint');
      expect(issues(pins({ required: 1, signers: { hana: [`${tp('a').slice(1)}+`] } }))[0]).toContain('RFC 7638 JWK thumbprint');
      expect(issues(pins({ required: 1, signers: { Hana: [tp('a')] } }))[0]).toContain('signer id');
      expect(issues(pins({ required: 1, signers: { hana: [] } })).length).toBeGreaterThan(0);
    });

    it('refuses a policy the contract could never hold', () => {
      expect(issues(pins({ required: 1, signers: {} }))).toContain('1 to 3 signers');
      expect(issues(pins({ required: 2, signers: { hana: [tp('a')] } }))).toEqual(['required must not exceed the number of signers']);
      expect(issues(pins({ required: 0, signers: { hana: [tp('a')] } })).length).toBeGreaterThan(0);
      expect(issues(pins({ required: 1, signers: { a: [tp('a')], b: [tp('b')], c: [tp('c')], d: [tp('d')] } }))).toContain('1 to 3 signers');
      const nine = 'abcdefghi'.split('').map(tp);
      expect(issues(pins({ required: 1, signers: { hana: nine.slice(0, 5), cosign: nine.slice(5) } }))).toEqual(['at most 8 pinned keys in all']);
      expect(issues(pins({ required: 1, signers: { hana: [tp('a')], cosign: [tp('a')] } }))).toEqual(['A key is pinned once, for one signer']);
      expect(issues(pins({ required: 1, signers: { hana: [tp('a'), tp('a')] } }))).toEqual(['A key is pinned once, for one signer']);
      expect(issues(pins({ required: 1, signers: { hana: [tp('a')] }, extra: true })).length).toBeGreaterThan(0);
    });

    it('needs an https JWKS URL', () => {
      expect(issues(pins({ required: 1, signers: { hana: [tp('a')] }, jwksUrl: 'http://api.example.com/jwks.json' }))[0]).toContain('watchdog.pinnedIssuerKeys.email.jwksUrl must be an https URL');
    });
  });

  describe('pinnedIdentityKeys (the identity token keys, D210, D211)', () => {
    const tp = (c: string) => c.repeat(43);

    it("sandbox-dev pins exactly the keys its JWKS publishes", () => {
      const m = manifestSchema.parse(raw());
      expect(m.watchdog?.pinnedIdentityKeys).toEqual(m.identityToken?.publicKeys.map((k) => k.kid));
    });

    it('every published identity key must be pinned; extra pins (pinned ahead) are fine', () => {
      const [active, standby] = identityKids();
      const missing = (kid: string) => `identityToken key ${kid} is not in watchdog.pinnedIdentityKeys: pin every published identity key (docs/operations.md "Identity token keys")`;
      expect(issues(watchdog({ pinnedIdentityKeys: [active] }))).toEqual([missing(standby!)]);
      const { pinnedIdentityKeys: _, ...unpinned } = watchdog();
      expect(issues(unpinned)).toEqual([missing(active!), missing(standby!)]);
      expect(issues(watchdog({ pinnedIdentityKeys: [...identityKids(), tp('n')] }))).toEqual([]);
    });

    it('optional without an identity token; thumbprints only, each once, at most 8', () => {
      const { identityToken: _, ...noIdentity } = raw();
      const { pinnedIdentityKeys: _p, ...noPins } = watchdog();
      expect(manifestSchema.safeParse({ ...noIdentity, watchdogs: [noPins.account], watchdog: noPins }).success).toBe(true);
      expect(manifestSchema.safeParse({ ...noIdentity, watchdogs: [noPins.account], watchdog: { ...noPins, pinnedIdentityKeys: [tp('a')] } }).success).toBe(true);
      const bad = (pinnedIdentityKeys: unknown) => manifestSchema.safeParse({ ...noIdentity, watchdogs: [noPins.account], watchdog: { ...noPins, pinnedIdentityKeys } }).error?.issues.map((i) => i.message) ?? [];
      expect(bad(['short'])[0]).toContain('RFC 7638 JWK thumbprint');
      expect(bad([])).toHaveLength(1);
      expect(bad([tp('a'), tp('a')])).toEqual(['An identity key is pinned once']);
      expect(bad('abcdefghi'.split('').map(tp))).toHaveLength(1);
    });
  });

});

describe('manifestSchema: near (D733)', () => {
  const withRelay = (relay: Record<string, unknown>) => ({ ...raw(), near: { demoGuestbook: 'book.example.testnet', relay } });
  const ok = { account: 'relay.example.testnet', receivers: ['book.example.testnet'] };
  const issues = (m: unknown) => {
    const r = manifestSchema.safeParse(m);
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };

  it('is optional, sandbox-dev sets the guestbook and the relay, and the relay takes only its fields', () => {
    const { near: _, ...rest } = raw();
    expect(manifestSchema.safeParse(rest).success).toBe(true);
    const sandbox = loadEnv('sandbox-dev');
    expect(sandbox.near?.relay?.receivers).toEqual([sandbox.near?.demoGuestbook]);
    expect(issues(withRelay(ok))).toEqual([]);
    expect(manifestSchema.safeParse(withRelay({ ...ok, keys: ['ed25519:x'] })).success).toBe(false);
    expect(manifestSchema.safeParse({ ...raw(), near: { other: 1 } }).success).toBe(false);
  });

  it('keeps the relay account its own, and receivers distinct and off the signer, relayer and relay account', () => {
    const m = raw() as { signer: string; relayer: string; owner: string; mpc: string };
    for (const account of [m.signer, m.relayer, m.owner, m.mpc, 'book.example.testnet']) {
      expect(issues(withRelay({ ...ok, account })).join(' ')).toMatch(/must be its own account/u);
    }
    for (const receivers of [[m.signer], [m.relayer], [ok.account], ['a.testnet', 'a.testnet']]) {
      expect(issues(withRelay({ ...ok, receivers })).length, JSON.stringify(receivers)).toBeGreaterThan(0);
    }
  });

  it('bounds the limits as the API parses them', () => {
    for (const bad of [{ maxGasTgas: 0 }, { maxGasTgas: 301 }, { dailyBudgetNear: 0 }, { perSenderPerDay: 0 }, { perAppPerDay: 1.5 }, { activationYocto: '-1' }, { activationYocto: '10000000000000000000001' }]) {
      expect(manifestSchema.safeParse(withRelay({ ...ok, ...bad })).success, JSON.stringify(bad)).toBe(false);
    }
    expect(manifestSchema.safeParse(withRelay({ ...ok, maxGasTgas: 300, dailyBudgetNear: 0.5, activationYocto: '10000000000000000000000' })).success).toBe(true);
  });

  it('refuses a per-app cap or budget at or above the env’s (D736)', () => {
    for (const bad of [
      { perAppPerDay: 20_000 },
      { perAppPerDay: 100, relaysPerDay: 100 },
      { activationsPerAppPerDay: 1000 },
      { activationsPerAppPerDay: 50, activationsPerDay: 10 },
      { appDailyBudgetNear: 5 },
      { dailyBudgetNear: 2, appDailyBudgetNear: 3 },
      { appDailyBudgetNear: 0.0000001 },
    ]) {
      expect(issues(withRelay({ ...ok, ...bad })).join(' '), JSON.stringify(bad)).toMatch(/must be below|at least/u);
    }
    expect(issues(withRelay({ ...ok, perAppPerDay: 99, relaysPerDay: 100, activationsPerAppPerDay: 9, activationsPerDay: 10, dailyBudgetNear: 2, appDailyBudgetNear: 1.5 }))).toEqual([]);
  });

  it('requireKnownAccount: a boolean; false only on testnet (the schema allows only testnet today)', () => {
    expect(issues(withRelay({ ...ok, requireKnownAccount: false }))).toEqual([]);
    expect(manifestSchema.safeParse(withRelay({ ...ok, requireKnownAccount: 'no' })).success).toBe(false);
    expect(manifestSchema.safeParse({ ...withRelay({ ...ok, requireKnownAccount: false }), network: 'mainnet' }).success).toBe(false);
  });
});
