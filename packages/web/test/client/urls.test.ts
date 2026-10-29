// @vitest-environment happy-dom
// The service-URL rule for partner-configured RPC, Horizon and Soroban RPC URLs (sweep PART-3, docs/decisions.md D115):
// http(s) only; a live app (pk_live_) needs https except on a loopback host.
import { describe, expect, it, vi } from 'vitest';
import { HanaClient } from '../../src/client/client.ts';
import { validateEvmConfig } from '../../src/client/ethereum.ts';
import { validateStellarConfig } from '../../src/client/stellar.ts';
import { isLoopbackHost, serviceUrl } from '../../src/client/urls.ts';
import { ORIGINS, PK, quietIframeLoads } from './harness.ts';

const LIVE_PK = 'pk_live_1111111111111111';

describe('serviceUrl', () => {
  it.each(['localhost', 'app.localhost', '127.0.0.1', '127.9.8.7', '[::1]', 'LOCALHOST'])('%s is loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(true);
  });

  it.each(['example.com', 'localhost.example.com', '128.0.0.1', '127.0.0.256', '10.0.0.1', '[::2]', '127.0.0.1.nip.io'])('%s is not loopback', (h) => {
    expect(isLoopbackHost(h)).toBe(false);
  });

  it('a live app needs https outside loopback; a test app may use http anywhere', () => {
    expect(serviceUrl('https://rpc.example', 'rpcUrl', true)).toBe('https://rpc.example');
    expect(() => serviceUrl('http://rpc.example', 'rpcUrl', true)).toThrow(/rpcUrl must be https for a live app/u);
    expect(() => serviceUrl('http://192.168.1.5:8545', 'rpcUrl', true)).toThrow(TypeError);
    expect(serviceUrl('http://localhost:8545', 'rpcUrl', true)).toBe('http://localhost:8545');
    expect(serviceUrl('http://127.0.0.1:8545', 'rpcUrl', true)).toBe('http://127.0.0.1:8545');
    expect(serviceUrl('http://192.168.1.5:8545', 'rpcUrl', false)).toBe('http://192.168.1.5:8545');
    // The default is the strict rule.
    expect(() => serviceUrl('http://rpc.example', 'rpcUrl')).toThrow(TypeError);
  });

  it('refuses other schemes, non-strings, non-URLs and credentials for any app', () => {
    for (const live of [true, false]) {
      expect(() => serviceUrl('ws://rpc.example', 'x', live)).toThrow(/http\(s\)/u);
      expect(() => serviceUrl('javascript:alert(1)', 'x', live)).toThrow(TypeError);
      expect(() => serviceUrl('not a url', 'x', live)).toThrow(/must be a URL/u);
      expect(() => serviceUrl(new URL('https://rpc.example'), 'x', live)).toThrow(TypeError);
      expect(() => serviceUrl('https://user:key@rpc.example', 'x', live)).toThrow(/credentials/u);
    }
  });

  it('applies to evm.chains rpcUrl and stellar horizonUrl / sorobanRpcUrl', () => {
    const evm = { chains: [{ id: 8453, rpcUrl: 'http://rpc.example' }], defaultChainId: 8453 };
    expect(() => validateEvmConfig(evm, true)).toThrow(/evm\.chains\[0\]\.rpcUrl must be https/u);
    expect(validateEvmConfig(evm, false).chains[0]?.rpcUrl).toBe('http://rpc.example');
    const stellar = { networkPassphrase: 'Test SDF Network ; September 2015', horizonUrl: 'https://h.example', sorobanRpcUrl: 'http://s.example' };
    expect(() => validateStellarConfig(stellar, true)).toThrow(/stellar\.sorobanRpcUrl must be https/u);
    expect(validateStellarConfig(stellar, false)).toEqual(stellar);
  });
});

describe('the client applies it by key type', () => {
  const make = (publishableKey: string, rpcUrl: string) =>
    new HanaClient({ publishableKey, environment: 'test', evm: { chains: [{ id: 84532, rpcUrl }], defaultChainId: 84532 } }, { win: window, origins: ORIGINS, fetch: vi.fn() });

  it('pk_live_ refuses an http RPC outside loopback; pk_test_ accepts it; both accept https and loopback', () => {
    quietIframeLoads();
    expect(() => make(LIVE_PK, 'http://rpc.example')).toThrow(/must be https for a live app/u);
    const clients = [make(PK, 'http://rpc.example'), make(LIVE_PK, 'http://localhost:8545'), make(LIVE_PK, 'https://rpc.example')];
    expect(clients.map((c) => c.testApp)).toEqual([true, false, false]);
    for (const c of clients) c.destroy();
  });
});
