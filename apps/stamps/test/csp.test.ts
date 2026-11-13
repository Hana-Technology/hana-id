import { describe, expect, it } from 'vitest';
import { NON_PAGE_CSP, connectOrigins, pageCsp, securityHeaders } from '../src/csp.ts';
import { CONFIG } from './fixtures.ts';

const directives = (csp: string): Map<string, string[]> => new Map(csp.split(';').map((d) => d.trim().split(/\s+/u)).map(([name, ...values]) => [name!, values]));

describe('pageCsp', () => {
  const csp = pageCsp(CONFIG);

  it('is the exact policy for sandbox-dev: the NEAR RPCs and the API, the vault frame, no EVM RPC', () => {
    expect(csp).toBe(
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; font-src 'self'; " +
        'connect-src https://rpc.test.invalid https://rpc.other.invalid https://hana-id-api-sandbox-dev.tingtc.workers.dev; ' +
        "frame-src https://hana-id-vault-sandbox-dev.tingtc.workers.dev; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; " +
        "require-trusted-types-for 'script'; trusted-types 'none'",
    );
  });

  it('allows no inline code, no eval, no wildcard and no other host', () => {
    expect(csp).not.toMatch(/unsafe-|\*|data:|blob:|http:/u);
    const hosts = [...csp.matchAll(/https:\/\/[^\s;]+/gu)].map((m) => m[0]);
    expect(hosts.sort()).toEqual([CONFIG.vaultOrigin, 'https://rpc.test.invalid', 'https://rpc.other.invalid', CONFIG.apiUrl].sort());
    expect(directives(csp).get('frame-src')).toEqual([CONFIG.vaultOrigin]);
  });

  it('uses origins only, refuses an injection, and lists a shared origin once', () => {
    expect(() => pageCsp({ ...CONFIG, vaultOrigin: "https://vault.test; script-src 'unsafe-inline'" })).toThrow();
    expect(() => pageCsp({ ...CONFIG, near: { ...CONFIG.near, rpcUrl: 'https://near.test; connect-src *' } })).toThrow();
    expect(connectOrigins({ ...CONFIG, near: { ...CONFIG.near, rpcUrl: 'https://same.test/a', rpcFallbackUrl: 'https://same.test/b' } })).toEqual(['https://same.test', CONFIG.apiUrl]);
    expect(connectOrigins({ ...CONFIG, near: { ...CONFIG.near, rpcFallbackUrl: null } })).toEqual(['https://rpc.test.invalid', CONFIG.apiUrl]);
  });
});

describe('securityHeaders', () => {
  it('nosniff, no-referrer, no framing and the popup-friendly COOP the login window needs', () => {
    expect(securityHeaders('x')).toMatchObject({ 'content-security-policy': 'x', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'cross-origin-opener-policy': 'same-origin-allow-popups' });
    expect(directives(NON_PAGE_CSP).has('sandbox')).toBe(true);
  });
});
