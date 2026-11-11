import { describe, expect, it } from 'vitest';
import { DEFAULT_EVM, DEFAULT_PUBLISHABLE_KEY, DEFAULT_STELLAR, type DemoConfig, demoConfigFromVars, validateDemoConfig, webOrigin } from '../src/config.ts';
import { CONFIG, MANIFEST, variant } from './fixtures.ts';

const load = () => MANIFEST;

describe('demoConfigFromVars', () => {
  it('defaults to sandbox-dev with the Smoke B app key, Base Sepolia and Stellar testnet', () => {
    expect(CONFIG).toEqual({
      environment: 'sandbox-dev',
      publishableKey: 'pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie',
      vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
      evm: { id: 84532, name: 'Base Sepolia', rpcUrl: 'https://sepolia.base.org', explorer: 'https://sepolia.basescan.org' },
      stellar: { networkPassphrase: 'Test SDF Network ; September 2015', explorer: 'https://stellar.expert/explorer/testnet' },
      apiUrl: 'https://hana-id-api-sandbox-dev.tingtc.workers.dev',
      near: { rpcUrl: 'https://rpc.test.invalid', rpcFallbackUrl: 'https://rpc.other.invalid', guestbook: 'hana-id-guestbook-dev1.testnet', explorer: 'https://testnet.nearblocks.io' },
    });
    expect(CONFIG.publishableKey).toBe(DEFAULT_PUBLISHABLE_KEY);
    expect(Object.isFrozen(CONFIG) && Object.isFrozen(CONFIG.evm) && Object.isFrozen(CONFIG.stellar) && Object.isFrozen(CONFIG.near)).toBe(true);
  });

  it("takes NEAR's RPCs, the guestbook and the API from the manifest, and works without a guestbook or a fallback", () => {
    const c = demoConfigFromVars({}, () => variant({ near: undefined, rpcFallback: undefined }));
    expect(c.near).toEqual({ rpcUrl: 'https://rpc.test.invalid', rpcFallbackUrl: null, guestbook: null, explorer: 'https://testnet.nearblocks.io' });
    expect(c.apiUrl).toBe(MANIFEST.apiUrl);
  });

  it('takes the env and key from HANA_DEMO_ENV and HANA_DEMO_PUBLISHABLE_KEY', () => {
    const names: string[] = [];
    const c = demoConfigFromVars({ HANA_DEMO_ENV: ' sandbox-other ', HANA_DEMO_PUBLISHABLE_KEY: 'pk_test_2222222222222222' }, (name) => {
      names.push(name);
      return variant({ name: 'sandbox-other' });
    });
    expect(names).toEqual(['sandbox-other']);
    expect(c.environment).toBe('sandbox-other');
    expect(c.publishableKey).toBe('pk_test_2222222222222222');
  });

  it("requires a key for an env other than sandbox-dev (the default key is sandbox-dev's)", () => {
    expect(() => demoConfigFromVars({ HANA_DEMO_ENV: 'sandbox-other' }, () => variant({ name: 'sandbox-other' }))).toThrow(/HANA_DEMO_PUBLISHABLE_KEY is required/u);
  });

  it('refuses a live key, a malformed key, a manifest without a vault and a mismatched manifest', () => {
    expect(() => demoConfigFromVars({ HANA_DEMO_PUBLISHABLE_KEY: 'pk_live_2222222222222222' }, load)).toThrow(/must be a pk_test_ key/u);
    expect(() => demoConfigFromVars({ HANA_DEMO_PUBLISHABLE_KEY: 'sk_test_2222222222222222' }, load)).toThrow(/not a publishable key/u);
    expect(() => demoConfigFromVars({}, () => ({ name: 'sandbox-dev', network: 'testnet', apiUrl: MANIFEST.apiUrl, rpc: MANIFEST.rpc }))).toThrow(/sets no vaultOrigin/u);
    expect(() => demoConfigFromVars({}, () => ({ ...MANIFEST, name: 'sandbox-x' }))).toThrow(/is named sandbox-x/u);
    expect(() => demoConfigFromVars({}, () => ({ ...MANIFEST, network: 'mainnet' }))).toThrow(/not a testnet env/u);
  });
});

describe('validateDemoConfig', () => {
  const base: DemoConfig = { environment: 'sandbox-dev', publishableKey: DEFAULT_PUBLISHABLE_KEY, vaultOrigin: 'https://vault.test', evm: DEFAULT_EVM, stellar: DEFAULT_STELLAR, apiUrl: 'https://api.test', near: CONFIG.near };

  it('accepts a local stack (http on loopback)', () => {
    const local = { ...base, vaultOrigin: 'http://127.0.0.1:4420', evm: { id: 31337, name: 'Local', rpcUrl: 'http://127.0.0.1:4460', explorer: null }, apiUrl: 'http://127.0.0.1:4430', near: { rpcUrl: 'http://127.0.0.1:4450', rpcFallbackUrl: null, guestbook: 'guestbook.testnet', explorer: null } };
    expect(validateDemoConfig(local)).toEqual(local);
  });

  it('refuses mainnets, plain http elsewhere, a vault with a path, and lists every problem', () => {
    expect(() => validateDemoConfig({ ...base, evm: { ...DEFAULT_EVM, id: 1 } })).toThrow(/EVM chain 1 is not a test chain/u);
    expect(() => validateDemoConfig({ ...base, evm: { ...DEFAULT_EVM, id: 8453 } })).toThrow(/EVM chain 8453/u);
    expect(() => validateDemoConfig({ ...base, stellar: { ...DEFAULT_STELLAR, networkPassphrase: 'Public Global Stellar Network ; September 2015' } })).toThrow(/public network/u);
    expect(() => validateDemoConfig({ ...base, evm: { ...DEFAULT_EVM, rpcUrl: 'http://rpc.example' } })).toThrow(/evm.rpcUrl must be https/u);
    expect(() => validateDemoConfig({ ...base, vaultOrigin: 'https://vault.test/vault' })).toThrow(/must be an origin/u);
    // NEAR: https RPCs and API, a testnet guestbook only.
    expect(() => validateDemoConfig({ ...base, near: { ...base.near, rpcUrl: 'http://rpc.example' } })).toThrow(/near.rpcUrl must be https/u);
    expect(() => validateDemoConfig({ ...base, near: { ...base.near, rpcFallbackUrl: 'ftp://rpc.example' } })).toThrow(/near.rpcFallbackUrl must be https/u);
    expect(() => validateDemoConfig({ ...base, apiUrl: 'http://api.example' })).toThrow(/apiUrl must be https/u);
    for (const bad of ['guestbook.near', 'Guestbook.testnet', 'a'.repeat(64), 'x;y.testnet']) expect(() => validateDemoConfig({ ...base, near: { ...base.near, guestbook: bad } }), bad).toThrow(/is not a .testnet account/u);
    expect(() => validateDemoConfig({ ...base, environment: 'Bad Env', publishableKey: 'nope', vaultOrigin: 'javascript:alert(1)' })).toThrow(
      /environment "Bad Env"[\s\S]*not a publishable key[\s\S]*vaultOrigin must be https/u,
    );
  });
});

describe('webOrigin', () => {
  it('returns the origin of an https or loopback-http URL and refuses the rest', () => {
    expect(webOrigin('https://sepolia.base.org/path?q=1', 'x')).toBe('https://sepolia.base.org');
    expect(webOrigin('http://localhost:5174', 'x')).toBe('http://localhost:5174');
    expect(() => webOrigin('http://example.com', 'x')).toThrow(/https/u);
    expect(() => webOrigin('https://user:pw@example.com', 'x')).toThrow(/https/u);
    expect(() => webOrigin('not a url', 'x')).toThrow(/must be a URL/u);
  });
});
