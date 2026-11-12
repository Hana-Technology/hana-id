import { describe, expect, it } from 'vitest';
import { NON_PAGE_CSP, connectOrigins, pageCsp, securityHeaders } from '../src/csp.ts';
import { CONFIG } from './fixtures.ts';

const directives = (csp: string): Map<string, string[]> => new Map(csp.split(';').map((d) => d.trim().split(/\s+/u)).map(([name, ...values]) => [name!, values]));

describe('pageCsp', () => {
  const csp = pageCsp(CONFIG);
  const d = directives(csp);

  it('is the exact policy for sandbox-dev', () => {
    expect(csp).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        'connect-src https://sepolia.base.org https://rpc.test.invalid https://rpc.other.invalid https://hana-id-api-sandbox-dev.tingtc.workers.dev; ' +
        "frame-src https://hana-id-vault-sandbox-dev.tingtc.workers.dev; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
        "require-trusted-types-for 'script'; trusted-types 'none'",
    );
  });

  it('frames exactly the vault origin and connects exactly to the EVM RPC, the NEAR RPCs and the Hana API', () => {
    expect(d.get('frame-src')).toEqual([CONFIG.vaultOrigin]);
    expect(d.get('connect-src')).toEqual([new URL(CONFIG.evm.rpcUrl).origin, new URL(CONFIG.near.rpcUrl).origin, new URL(CONFIG.near.rpcFallbackUrl!).origin, new URL(CONFIG.apiUrl).origin]);
    // No child-src or worker-src: default-src 'none' covers them, and frame-src alone decides frames.
    expect(d.has('child-src')).toBe(false);
    expect(d.get('default-src')).toEqual(["'none'"]);
  });

  it('allows no inline code, no eval, no wildcard and no other host anywhere', () => {
    expect(csp).not.toMatch(/unsafe-|\*|data:|blob:|http:/u);
    const hosts = [...csp.matchAll(/https:\/\/[^\s;]+/gu)].map((m) => m[0]);
    expect(hosts.sort()).toEqual([CONFIG.vaultOrigin, 'https://sepolia.base.org', 'https://rpc.test.invalid', 'https://rpc.other.invalid', CONFIG.apiUrl].sort());
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
  });

  it('uses origins only, and refuses a value that could inject a directive', () => {
    const one = { ...CONFIG, near: { ...CONFIG.near, rpcUrl: 'https://near.test/path?k=1', rpcFallbackUrl: null }, apiUrl: 'https://api.test/v1' };
    expect(pageCsp({ ...one, vaultOrigin: 'https://vault.test', evm: { ...CONFIG.evm, rpcUrl: 'https://rpc.test/v1/key?x=1' } })).toContain('connect-src https://rpc.test https://near.test https://api.test;');
    expect(() => pageCsp({ ...one, vaultOrigin: "https://vault.test; script-src 'unsafe-inline'" })).toThrow();
    expect(() => pageCsp({ ...one, vaultOrigin: 'http://vault.test' })).toThrow(/https/u);
    expect(() => pageCsp({ ...one, near: { ...one.near, rpcUrl: "https://near.test; connect-src *" } })).toThrow();
    expect(() => pageCsp({ ...one, apiUrl: 'http://api.test' })).toThrow(/https/u);
  });

  it('lists an origin once when the NEAR RPC and the fallback share it, and leaves out a missing fallback', () => {
    expect(connectOrigins({ ...CONFIG, near: { ...CONFIG.near, rpcUrl: 'https://same.test/a', rpcFallbackUrl: 'https://same.test/b' } })).toEqual(['https://sepolia.base.org', 'https://same.test', CONFIG.apiUrl]);
    expect(connectOrigins({ ...CONFIG, near: { ...CONFIG.near, rpcFallbackUrl: null } })).toEqual(['https://sepolia.base.org', 'https://rpc.test.invalid', CONFIG.apiUrl]);
  });
});

describe('securityHeaders', () => {
  it('sets the CSP, nosniff, no-referrer, no framing and a popup-friendly COOP', () => {
    const h = securityHeaders('x');
    expect(h).toMatchObject({
      'content-security-policy': 'x',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
      // same-origin would sever the Hana login popup (coop_blocks_popup).
      'cross-origin-opener-policy': 'same-origin-allow-popups',
    });
    expect(directives(NON_PAGE_CSP).get('frame-ancestors')).toEqual(["'none'"]);
    expect(directives(NON_PAGE_CSP).has('sandbox')).toBe(true);
  });
});
