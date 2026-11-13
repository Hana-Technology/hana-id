import { describe, expect, it } from 'vitest';
import { DEFAULT_COLLECT_TGAS, type ManifestSlice, NEAR_TESTNET_EXPLORER, NEAR_TESTNET_FAUCET, type StampsConfig, stampsConfigFromVars, validateStampsConfig } from '../src/config.ts';
import { CONFIG, MANIFEST, PK, STAMPS, variant, withStamps } from './fixtures.ts';

const vars = { HANA_STAMPS_PUBLISHABLE_KEY: PK };

describe('stampsConfigFromVars', () => {
  it('sandbox-dev from the manifest: vault, API, NEAR RPCs, the stamps contract and the relay’s gas cap; NearBlocks and the faucet', () => {
    expect(CONFIG).toEqual({
      environment: 'sandbox-dev',
      publishableKey: PK,
      vaultOrigin: 'https://hana-id-vault-sandbox-dev.tingtc.workers.dev',
      apiUrl: 'https://hana-id-api-sandbox-dev.tingtc.workers.dev',
      near: { rpcUrl: 'https://rpc.test.invalid', rpcFallbackUrl: 'https://rpc.other.invalid', stamps: STAMPS, collectTgas: 10, explorer: NEAR_TESTNET_EXPLORER, faucet: NEAR_TESTNET_FAUCET },
    });
    expect(Object.isFrozen(CONFIG) && Object.isFrozen(CONFIG.near)).toBe(true);
    // Nothing of another chain is configured.
    expect(JSON.stringify(CONFIG)).not.toMatch(/stellar|evm|sepolia|base/iu);
  });

  it('requires the publishable key: there is no default app', () => {
    expect(() => stampsConfigFromVars({}, () => MANIFEST)).toThrow(/HANA_STAMPS_PUBLISHABLE_KEY is required/u);
    expect(() => stampsConfigFromVars({ HANA_STAMPS_PUBLISHABLE_KEY: '  ' }, () => MANIFEST)).toThrow(/is required/u);
  });

  it('refuses to build for an env without near.demoStamps, with a clear message, and a bad one', () => {
    expect(() => stampsConfigFromVars(vars, () => withStamps(MANIFEST, undefined))).toThrow(/sets no near\.demoStamps: there is no stamps contract/u);
    expect(() => stampsConfigFromVars(vars, () => ({ ...MANIFEST, near: undefined }))).toThrow(/sets no near\.demoStamps/u);
    for (const bad of ['stamps.near', 'Stamps.testnet', 42, ['x.testnet'], 'a;b.testnet']) expect(() => stampsConfigFromVars(vars, () => withStamps(MANIFEST, bad)), String(bad)).toThrow(/is not a \.testnet account/u);
  });

  it('only testnet sandbox*/local* envs', () => {
    expect(() => stampsConfigFromVars({ ...vars, HANA_STAMPS_ENV: 'prod' }, () => variant({ name: 'prod' }))).toThrow(/sandbox\*\/local\* envs only/u);
    expect(() => stampsConfigFromVars(vars, () => ({ ...MANIFEST, network: 'mainnet' }))).toThrow(/not a testnet env/u);
    expect(() => stampsConfigFromVars(vars, () => ({ ...MANIFEST, name: 'sandbox-x' }))).toThrow(/is named sandbox-x/u);
    expect(() => stampsConfigFromVars(vars, () => ({ ...MANIFEST, vaultOrigin: undefined }))).toThrow(/sets no vaultOrigin/u);
    const local = stampsConfigFromVars({ ...vars, HANA_STAMPS_ENV: ' sandbox-other ' }, () => variant({ name: 'sandbox-other' }));
    expect(local.environment).toBe('sandbox-other');
  });

  it('the relay cap sets the gas; without one, 10 Tgas', () => {
    const m: ManifestSlice = { ...MANIFEST, near: { demoStamps: STAMPS, relay: { maxGasTgas: 30 } } };
    expect(stampsConfigFromVars(vars, () => m).near.collectTgas).toBe(30);
    expect(stampsConfigFromVars(vars, () => ({ ...MANIFEST, near: { demoStamps: STAMPS } })).near.collectTgas).toBe(DEFAULT_COLLECT_TGAS);
  });

  it('refuses a live key and a malformed key', () => {
    expect(() => stampsConfigFromVars({ HANA_STAMPS_PUBLISHABLE_KEY: 'pk_live_2222222222222222' }, () => MANIFEST)).toThrow(/must be a pk_test_ key/u);
    expect(() => stampsConfigFromVars({ HANA_STAMPS_PUBLISHABLE_KEY: 'sk_test_2222222222222222' }, () => MANIFEST)).toThrow(/not a publishable key/u);
  });
});

describe('validateStampsConfig', () => {
  it('accepts a local stack (http on loopback, no explorer or faucet)', () => {
    const local: StampsConfig = { environment: 'local-e2e', publishableKey: PK, vaultOrigin: 'http://127.0.0.1:4420', apiUrl: 'http://127.0.0.1:4430', near: { rpcUrl: 'http://127.0.0.1:4450', rpcFallbackUrl: null, stamps: 'e2e-stamps.testnet', collectTgas: 10, explorer: null, faucet: null } };
    expect(validateStampsConfig(local)).toEqual(local);
  });

  it('refuses plain http elsewhere, a vault with a path, a mainnet contract, odd gas, and lists every problem', () => {
    const base = CONFIG;
    expect(() => validateStampsConfig({ ...base, near: { ...base.near, rpcUrl: 'http://rpc.example' } })).toThrow(/near.rpcUrl must be https/u);
    expect(() => validateStampsConfig({ ...base, near: { ...base.near, faucet: 'javascript:alert(1)' } })).toThrow(/near.faucet must be https/u);
    expect(() => validateStampsConfig({ ...base, vaultOrigin: 'https://vault.test/vault' })).toThrow(/must be an origin/u);
    expect(() => validateStampsConfig({ ...base, near: { ...base.near, stamps: 'stamps.near' } })).toThrow(/is not a .testnet account/u);
    expect(() => validateStampsConfig({ ...base, near: { ...base.near, collectTgas: 0.5 } })).toThrow(/collectTgas/u);
    expect(() => validateStampsConfig({ ...base, environment: 'production' })).toThrow(/not a testnet sandbox\*\/local\* env/u);
    expect(() => validateStampsConfig({ ...base, environment: 'Bad Env', publishableKey: 'nope', apiUrl: 'ftp://x' })).toThrow(/environment "Bad Env"[\s\S]*not a publishable key[\s\S]*apiUrl must be https/u);
  });
});
