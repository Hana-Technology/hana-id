// @vitest-environment happy-dom
// createHana, partner-page requirements and error mapping (docs/batch-b-spec.md "Partner client", "Partner
// requirements", "Envelope" error table, "EIP-1193", "Stellar Wallets Kit module").
import { loadEnv } from '@hana-id/env';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HANA_ENVIRONMENTS, createHana } from '../../src/create-hana.ts';
import { HanaError, ProviderRpcError, toProviderRpcError, toSwkError } from '../../src/client/errors.ts';
import { isInAppWebView, partnerPageIssues } from '../../src/client/requirements.ts';
import * as web from '../../src/index.ts';
import { FakeMessageChannel, PK, quietIframeLoads } from './harness.ts';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.replaceChildren();
  delete (window as unknown as { google?: unknown }).google;
});

describe('createHana', () => {
  it("mounts the vault from the env manifest's vaultOrigin; the partner can't choose the origins", () => {
    quietIframeLoads();
    vi.stubGlobal('MessageChannel', FakeMessageChannel);
    const env = loadEnv('sandbox-dev');
    const hana = createHana({ publishableKey: PK, environment: 'sandbox-dev', vaultOrigin: 'https://evil.test' } as never);
    const frame = document.querySelector('iframe') as HTMLIFrameElement;
    expect(frame.getAttribute('src')).toBe(`${env.vaultOrigin}/vault?pk=${PK}`);
    expect(hana.vaultOrigin).toBe(env.vaultOrigin);
    expect(hana.authOrigin).toBe(env.authOrigin);
    expect(hana.status).toBe('unlocking');
    hana.destroy();
  });

  it('knows the envs whose manifests set both Hana origins', () => {
    expect(HANA_ENVIRONMENTS).toContain('sandbox-dev');
  });

  it('refuses an unknown environment and a malformed publishable key', () => {
    expect(() => createHana({ publishableKey: PK, environment: 'mainnet' })).toThrow(/Unknown Hana environment/u);
    expect(() => createHana({ publishableKey: PK, environment: '__proto__' })).toThrow(/Unknown Hana environment/u);
    expect(() => createHana({ publishableKey: 'sk_live_abc', environment: 'sandbox-dev' })).toThrow(/publishableKey/u);
    expect(() => createHana(null as never)).toThrow(TypeError);
    expect(document.querySelector('iframe')).toBeNull();
  });

  it('warns once per page about unsupported partner setups (Google Identity Services)', () => {
    quietIframeLoads();
    vi.stubGlobal('MessageChannel', FakeMessageChannel);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    (window as unknown as { google: unknown }).google = { accounts: { id: {} } };
    createHana({ publishableKey: PK, environment: 'sandbox-dev' }).destroy();
    createHana({ publishableKey: PK, environment: 'sandbox-dev' }).destroy();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('Google Identity Services');
  });

  it('the package root exports the client API', () => {
    for (const name of ['createHana', 'HanaError', 'ProviderRpcError', 'HanaEthereumProvider', 'HanaStellarSigner', 'partnerPageIssues', 'VERSION']) {
      expect(web).toHaveProperty(name);
    }
    // The client's constructor (which takes Hana origins) is not public: createHana is the only way in (PART-5).
    expect(web).not.toHaveProperty('HanaClient');
  });
});

describe('partnerPageIssues', () => {
  it('detects Google Identity Services by its global or its script', () => {
    quietIframeLoads();
    expect(partnerPageIssues(window)).toEqual([]);
    const script = document.createElement('script');
    script.setAttribute('src', 'https://accounts.google.com/gsi/client');
    document.body.append(script);
    expect(partnerPageIssues(window).map((i) => i.code)).toEqual(['google_identity_services']);
  });

  it('detects in-app webviews, and not real browsers', () => {
    const webviews = [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/129.0 Mobile Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0]',
      'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/129.0 Mobile Safari/537.36 Instagram 350.0.0',
    ];
    const browsers = [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/129.0 Mobile/15E148',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Mobile Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36',
    ];
    for (const ua of webviews) expect(isInAppWebView(ua), ua).toBe(true);
    for (const ua of browsers) expect(isInAppWebView(ua), ua).toBe(false);
  });
});

describe('error mapping', () => {
  it('EIP-1193: numeric codes pass through; sign-ins that did not complete are 4001; a dead vault 4900; others -32603', () => {
    expect(toProviderRpcError(new HanaError(4100, 'no'))).toMatchObject({ code: 4100, message: 'no' });
    for (const c of ['login_cancelled', 'login_timeout', 'popup_blocked', 'coop_blocks_popup'] as const) {
      expect(toProviderRpcError(new HanaError(c, c))).toMatchObject({ code: 4001, data: { code: c } });
    }
    expect(toProviderRpcError(new HanaError('vault_unavailable', 'x')).code).toBe(4900);
    expect(toProviderRpcError(new HanaError('rate_limited', 'x')).code).toBe(-32005);
    expect(toProviderRpcError(new HanaError('google_error', 'x', { error: 'access_denied' }))).toMatchObject({ code: -32603, data: { code: 'google_error', data: { error: 'access_denied' } } });
    expect(toProviderRpcError(new Error('boom'))).toMatchObject({ code: -32603, message: 'boom' });
    const p = new ProviderRpcError(-32000, 'node');
    expect(toProviderRpcError(p)).toBe(p);
  });

  it('SWK: {code, message} with the Hana string code in ext', () => {
    expect(toSwkError(new HanaError(4001, 'User rejected'))).toEqual({ code: 4001, message: 'User rejected' });
    expect(toSwkError(new HanaError('session_consumed', 'again'))).toEqual({ code: -32603, message: 'again', ext: ['session_consumed'] });
  });
});
