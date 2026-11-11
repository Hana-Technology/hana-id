// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://hana-id-demo-sandbox-dev.tingtc.workers.dev/"}
// Boots the demo page (index.html + src/page.ts) against a fake partner client: the createHana config, login from the
// click with timings, the addresses and explorer links, signing, export, logout, the plain error messages, and the
// diagnostics report.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type LoginResult, decodeNearDelegateAction, decodeNearTransaction, utf8 } from '@hana-id/core';
import { base58 } from '@scure/base';
import type { HanaAddresses, HanaConfig, HanaStatus } from '@hana-id/web';
import { type DemoClient, startDemo, statusText, untilText } from '../src/page.ts';
import { TEST_MESSAGE, utf8Hex } from '../src/requests.ts';
import { ADDRESSES, CONFIG, NEAR_ACCOUNT } from './fixtures.ts';
import { BLOCK_HASH, FakeNearRpc, TX_HASH, fakeNear } from './near-fakes.ts';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!;
const TIMINGS = { app: 120, popup: 900, google: 4000, verify: 15, chain: 6200, decrypt: 40 };
const b64url = (o: unknown) => btoa(JSON.stringify(o)).replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
const IDENTITY_CLAIMS = { iss: 'https://hana-id-api-sandbox-dev.tingtc.workers.dev/v1/identity', aud: 'app_demo1', sub: 'u1_8pQm3yR0tZ1vW5xA7cB2dE', sid: 's1_Jf2kL9mN0pQ3rS6tU8vW1x', iat: 1_800_000_000, exp: 1_800_003_600 };
const IDENTITY_TOKEN = `${b64url({ alg: 'ES256', kid: 'k', typ: 'hana-identity+jwt' })}.${b64url(IDENTITY_CLAIMS)}.${'A'.repeat(86)}`;

type Listener = (...args: unknown[]) => void;

class FakeClient {
  status: HanaStatus = 'unlocking';
  addresses: HanaAddresses | null = null;
  supportId: string | null = null;
  expiresAtMs: number | null = null;
  persistence: 'session' | 'none' | null = null;
  warning: 'storage_unavailable' | null = null;
  lastLogin: LoginResult | null = null;
  vaultOrigin = CONFIG.vaultOrigin;
  readonly ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (e: unknown) => void;
  readonly listeners = new Map<string, Listener[]>();
  finishLogin: ((r: LoginResult | Error) => void) | null = null;
  readonly cancelLogin = vi.fn();
  readonly logout = vi.fn(async () => {
    this.addresses = null;
    this.status = 'logged_out';
    this.emit('accountsChanged', null);
  });
  readonly exportKey = vi.fn(async (_chain: 'stellar' | 'evm' | 'near') => null);
  readonly revokeOtherDevices = vi.fn(async () => ({ revoked: 2 }));
  readonly getIdentityToken = vi.fn(async (): Promise<string | null> => IDENTITY_TOKEN);
  readonly stellar = { signMessage: vi.fn(async (_m: string, _o: unknown) => ({ signedMessage: 'c2lnbmVk', signerAddress: ADDRESSES.stellar })) };
  readonly ethereum = { request: vi.fn(async (_a: { method: string; params?: unknown }): Promise<unknown> => `0x${'ab'.repeat(65)}`) };
  readonly near = fakeNear(() => this.addresses?.near ?? null);
  readonly prepareApproval = vi.fn(() => ({ cancel: vi.fn() }));

  constructor(readonly config: HanaConfig) {
    this.ready = new Promise((res, rej) => {
      this.resolveReady = res;
      this.rejectReady = rej;
    });
  }

  on(event: string, l: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), l]);
    return this;
  }

  emit(event: string, ...args: unknown[]): void {
    for (const l of this.listeners.get(event) ?? []) l(...args);
  }

  readyWith(addresses: HanaAddresses | null): void {
    this.persistence = 'session';
    this.status = addresses ? 'logged_in' : 'logged_out';
    this.addresses = addresses;
    this.expiresAtMs = addresses ? Date.UTC(2026, 9, 29, 23) : null;
    this.resolveReady();
  }

  /** Every login's options (each demo button names its method). */
  readonly loginOptions: unknown[] = [];

  login(options?: unknown): Promise<HanaAddresses> {
    this.loginOptions.push(options);
    this.status = 'logging_in';
    this.emit('statusChanged', 'logging_in');
    return new Promise((resolve, reject) => {
      this.finishLogin = (r) => {
        if (r instanceof Error) {
          this.status = 'logged_out';
          this.emit('statusChanged', 'logged_out');
          reject(r);
          return;
        }
        this.lastLogin = r;
        this.addresses = r.addresses;
        this.persistence = r.persistence;
        this.expiresAtMs = r.expiresAtMs;
        this.status = 'logged_in';
        this.emit('accountsChanged', r.addresses);
        this.emit('statusChanged', 'logged_in');
        resolve(r.addresses);
      };
    });
  }
}

const $ = (id: string): HTMLElement => document.getElementById(id)!;
const click = (id: string): void => ($(id) as HTMLButtonElement).click();
const flush = () => new Promise((r) => setTimeout(r, 0));
const hanaError = (code: unknown, data?: unknown) => Object.assign(new Error(String(code)), { code, data });

let fake: FakeClient;
let copied: string[];
let copyFails = false;
let t = 0;
let rpc: FakeNearRpc;
let wall = Date.UTC(2026, 9, 29, 12);

function boot(): void {
  copied = [];
  rpc = new FakeNearRpc();
  startDemo({
    fetch: rpc.fetch,
    sleep: async () => {},
    config: CONFIG,
    sdkVersion: '0.0.0',
    createClient: (c) => {
      fake = new FakeClient(c);
      return fake as unknown as DemoClient;
    },
    now: () => t,
    clock: () => wall,
    copy: async (text) => {
      if (copyFails) throw new Error('denied');
      copied.push(text);
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = body;
  t = 0;
  wall = Date.UTC(2026, 9, 29, 12);
  copyFails = false;
  vi.useFakeTimers({ toFake: ['setInterval'] });
});

afterEach(() => {
  vi.useRealTimers();
});

async function loginFlow(): Promise<void> {
  fake.readyWith(null);
  await flush();
  t = 1000;
  click('login');
  t = 8000;
  fake.emit('loginProgress', { stage: 'chain' });
  expect($('progress').textContent).toMatch(/NEAR testnet/u);
  fake.finishLogin!({ addresses: ADDRESSES, expiresAtMs: Date.UTC(2026, 9, 29, 23), persistence: 'session', timings: TIMINGS });
  await flush();
}

describe('demo page', () => {
  it('“Log in with Google” and “Log in with email” each open their own method (batch 8a)', async () => {
    boot();
    fake.readyWith(null);
    await flush();
    expect($('login-email').hidden).toBe(false);
    expect(($('login-email') as HTMLButtonElement).disabled).toBe(false);
    click('login');
    expect(fake.loginOptions).toEqual([{ method: 'google' }]);
    // While a login is pending, both buttons are disabled.
    expect(($('login-email') as HTMLButtonElement).disabled).toBe(true);
    fake.finishLogin!(Object.assign(new Error('x'), { code: 'login_cancelled' }));
    await flush();
    click('login-email');
    expect(fake.loginOptions).toEqual([{ method: 'google' }, { method: 'email' }]);
  });

  it('creates the client exactly as a partner does, from the baked configuration, and says NEAR in the banner', () => {
    boot();
    expect(fake.config).toEqual({
      publishableKey: 'pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie',
      environment: 'sandbox-dev',
      evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
      stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
    });
    expect($('testnet-banner').textContent).toBe('Testnet demo: Stellar, EVM and NEAR test networks only, nothing here holds real funds.');
    expect(document.querySelector('.lead')!.textContent).toMatch(/^\s*Log in with email \(a code sent to your inbox; Google sign-in works for listed testers\) to get a\s+Stellar, an EVM and a NEAR wallet/u);
    expect($('login-email').classList.contains('primary')).toBe(true);
    expect($('footer-env').textContent).toContain('NEAR: testnet, guestbook hana-id-guestbook-dev1.testnet');
    expect($('env-badge').textContent).toBe('sandbox-dev · testnet');
    expect($('status').textContent).toBe('Connecting to the Hana vault…');
    expect(($('login') as HTMLButtonElement).disabled).toBe(true);
  });

  it('logs in from the click, then shows addresses, explorer links, status and timings', async () => {
    boot();
    await loginFlow();
    expect($('stellar-address').textContent).toBe(ADDRESSES.stellar);
    expect($('evm-address').textContent).toBe(ADDRESSES.evm);
    expect(($('stellar-link') as HTMLAnchorElement).href).toBe(`https://stellar.expert/explorer/testnet/account/${ADDRESSES.stellar}`);
    expect(($('evm-link') as HTMLAnchorElement).href).toBe(`https://sepolia.basescan.org/address/${ADDRESSES.evm}`);
    expect($('evm-link').getAttribute('rel')).toBe('noopener noreferrer');
    expect($('wallet').hidden).toBe(false);
    expect($('login').hidden).toBe(true);
    expect($('logout').hidden).toBe(false);
    expect($('status').textContent).toMatch(/^Logged in · session ends by .* \(in 11 h 0 min\), or sooner if idle · persistence: session/u);
    const cells = [...$('timings').querySelectorAll('td')].map((td) => td.textContent);
    expect(cells.slice(1)).toEqual(['google', '120', '900', '4000', '15', '6200', '40', '7000']);
  });

  it('an email login shows its method, the email step as sign-in and its parts, and no google stage', async () => {
    boot();
    fake.readyWith(null);
    await flush();
    t = 1000;
    click('login-email');
    t = 40_000;
    const stages = { app: 9954, popup: 300, emailLoad: 150, emailEntry: 4000, emailStart: 420, emailCode: 25_000, emailVerify: 310, emailRelay: 600, verify: 20, chain: 6200, decrypt: 40 };
    fake.finishLogin!({ addresses: ADDRESSES, expiresAtMs: Date.UTC(2026, 9, 29, 23), persistence: 'session', timings: stages });
    await flush();
    const rows = [...$('timings').querySelectorAll('tr')];
    expect([...rows[0]!.querySelectorAll('td')].map((td) => td.textContent).slice(1)).toEqual(['email', '9954', '300', '29730', '20', '6200', '40', '39000']);
    expect(rows[1]!.textContent).toBe('Email sign-in: address 4000, code request 420, code wait 25000, verify 310');
    expect(rows[2]!.textContent).toBe('Other stages: emailLoad 150, emailRelay 600');
    expect($('timings').textContent).not.toContain('google');
    click('copy-diagnostics');
    await flush();
    const d = JSON.parse(copied.at(-1)!) as { logins: unknown[] };
    expect(d.logins).toEqual([{ at: '2026-10-29T12:00:00.000Z', method: 'email', totalMs: 39000, stages }]);
  });

  it('copies addresses', async () => {
    boot();
    await loginFlow();
    click('copy-evm');
    await flush();
    expect(copied).toEqual([ADDRESSES.evm]);
    expect($('notice').textContent).toBe('EVM address copied.');
  });

  it('signs a personal_sign message, a Stellar message and a test transaction, never broadcasting', async () => {
    boot();
    await loginFlow();
    click('sign-personal');
    await flush();
    expect(fake.ethereum.request).toHaveBeenLastCalledWith({ method: 'personal_sign', params: [utf8Hex(TEST_MESSAGE), ADDRESSES.evm] });
    click('sign-stellar');
    await flush();
    expect(fake.stellar.signMessage).toHaveBeenLastCalledWith(TEST_MESSAGE, { address: ADDRESSES.stellar });
    click('sign-evm-tx');
    await flush();
    expect(fake.ethereum.request).toHaveBeenLastCalledWith({
      method: 'eth_signTransaction',
      params: [{ type: '0x2', chainId: '0x14a34', nonce: '0x0', gas: '0x5208', maxFeePerGas: '0x3b9aca00', maxPriorityFeePerGas: '0x5f5e100', to: ADDRESSES.evm, value: '0x0', data: '0x' }],
    });
    expect(fake.ethereum.request.mock.calls.map(([a]) => a.method)).not.toContain('eth_sendTransaction');
    const items = [...$('results').querySelectorAll('li')].map((li) => li.textContent ?? '');
    expect(items).toHaveLength(3);
    expect(items[0]).toMatch(/Base Sepolia transaction .*: signed/u);
    expect(items[2]).toContain(`0x${'ab'.repeat(65)}`);
  });

  it('runs one request at a time and shows a rejection in plain words', async () => {
    boot();
    await loginFlow();
    let reject!: (e: unknown) => void;
    fake.ethereum.request.mockImplementationOnce(() => new Promise((_res, rej) => (reject = rej)));
    click('sign-personal');
    expect(($('sign-stellar') as HTMLButtonElement).disabled).toBe(true);
    expect(($('export-evm') as HTMLButtonElement).disabled).toBe(true);
    // A notice (after an auto-sign) asks for no click; a button does.
    fake.emit('launcher', { visible: true, label: 'Signed by Hana under Demo', clickable: false });
    expect($('notice').textContent ?? '').not.toContain('Click');
    fake.emit('launcher', { visible: true, label: 'Review in Hana', clickable: true });
    expect($('notice').textContent).toBe('Click “Review in Hana” on the Hana button at the bottom right of the page to continue.');
    reject(Object.assign(new Error('User rejected'), { code: 4001 }));
    await flush();
    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('Rejected in the Hana window: nothing was signed.');
    expect(($('sign-stellar') as HTMLButtonElement).disabled).toBe(false);
    expect($('results').textContent).toContain('EVM personal_sign: not signed');
  });

  it('shows plain messages for a blocked popup, a cancelled login and an unreachable vault', async () => {
    boot();
    fake.readyWith(null);
    await flush();
    click('login');
    expect($('cancel-login').hidden).toBe(false);
    click('cancel-login');
    expect(fake.cancelLogin).toHaveBeenCalled();
    fake.finishLogin!(hanaError('popup_blocked'));
    await flush();
    expect($('error').textContent).toMatch(/blocked the Hana sign-in window/u);
    click('login');
    expect($('error').hidden).toBe(true);
    fake.finishLogin!(hanaError('login_cancelled'));
    await flush();
    expect($('error').textContent).toBe('Sign-in cancelled.');

    document.body.innerHTML = body;
    boot();
    fake.rejectReady(hanaError('vault_unavailable'));
    await flush();
    expect($('error').textContent).toMatch(/Could not load the Hana vault/u);
  });

  it('D695: signed out by Hana while a signature waits: one notice to log in again, never the reload text, also after the refusal', async () => {
    boot();
    await loginFlow();
    let reject!: (e: unknown) => void;
    fake.ethereum.request.mockImplementationOnce(() => new Promise((_res, rej) => (reject = rej)));
    click('sign-personal');
    // The vault ends the session: the client reports logged out, then the disconnect with its reason.
    fake.addresses = null;
    fake.status = 'logged_out';
    fake.emit('accountsChanged', null);
    fake.emit('statusChanged', 'logged_out');
    fake.emit('disconnect', { code: 4900, reason: 'signed_out' });
    const signedOut = 'You were signed out on this device (from Hana Home, another tab or another device). Log in again.';
    expect($('notice').textContent).toBe(signedOut);
    expect($('notice').hidden).toBe(false);
    expect($('error').hidden).toBe(true);
    // The approved signature is refused in the same moment: it must not turn this into "reload".
    reject(hanaError(4900, { reason: 'signed_out' }));
    await flush();
    expect($('notice').textContent).toBe(signedOut);
    expect($('error').hidden).toBe(true);
    expect(document.body.textContent).not.toContain('Reload the page');
    expect($('results').textContent).toContain(`EVM personal_sign: not signed${signedOut}`);
    expect($('login').hidden).toBe(false);
    // Both are in the diagnostics, with their reason.
    click('copy-diagnostics');
    await flush();
    const d = JSON.parse(copied.at(-1)!) as { errors: { action: string; code: unknown; reason: unknown }[] };
    expect(d.errors.map((e) => [e.action, e.code, e.reason])).toEqual([
      ['load', 4900, 'signed_out'],
      ['sign', 4900, 'signed_out'],
    ]);
  });

  it('D695: a disconnect with no reason is still a lost vault: the reload text', async () => {
    boot();
    await loginFlow();
    fake.emit('disconnect', { code: 4900 });
    expect($('error').hidden).toBe(false);
    expect($('error').textContent).toBe('The connection to the Hana vault was lost. Reload the page.');
  });

  it('exports through the Hana window, logs out other devices and logs out', async () => {
    boot();
    await loginFlow();
    click('export-stellar');
    await flush();
    expect(fake.exportKey).toHaveBeenCalledWith('stellar');
    expect($('export-near').hidden).toBe(false);
    click('export-near');
    await flush();
    expect(fake.exportKey).toHaveBeenLastCalledWith('near');
    expect($('notice').textContent).toMatch(/export window is open/u);
    click('revoke');
    await flush();
    expect($('notice').textContent).toBe('Signed out 2 other devices.');
    fake.revokeOtherDevices.mockRejectedValueOnce(hanaError(4100, { reason: 'share_not_fresh' }));
    click('revoke');
    await flush();
    expect($('error').textContent).toMatch(/within 5 minutes/u);
    click('logout');
    await flush();
    expect(fake.logout).toHaveBeenCalled();
    expect($('wallet').hidden).toBe(true);
    expect($('login').hidden).toBe(false);
    expect($('status').textContent).toBe('Logged out.');
  });

  it('gets an identity token without a popup, shows its decoded claims and a verify snippet for its iss and aud', async () => {
    boot();
    expect($('identity').hidden).toBe(true);
    await loginFlow();
    expect($('identity').hidden).toBe(false);
    expect($('identity-result').hidden).toBe(true);
    click('identity-token');
    await flush();
    expect(fake.getIdentityToken).toHaveBeenCalledTimes(1);
    expect($('identity-result').hidden).toBe(false);
    expect(JSON.parse($('identity-claims').textContent!)).toEqual({ header: { alg: 'ES256', kid: 'k', typ: 'hana-identity+jwt' }, claims: IDENTITY_CLAIMS });
    const snippet = $('identity-snippet').textContent!;
    expect(snippet).toContain(`new URL('${IDENTITY_CLAIMS.iss}/jwks.json')`);
    expect(snippet).toContain(`audience: '${IDENTITY_CLAIMS.aud}'`);
    expect(snippet).toContain("algorithms: ['ES256']");
    // A failure is shown in plain words; a logout hides the token.
    fake.getIdentityToken.mockRejectedValueOnce(hanaError('identity_unavailable'));
    click('identity-token');
    await flush();
    expect($('error').textContent).toMatch(/could not issue an identity token/u);
    click('logout');
    await flush();
    expect($('identity').hidden).toBe(true);
    expect($('identity-claims').textContent).toBe('');
  });

  it('records an unlock on a logged-in page load', async () => {
    boot();
    t = 180;
    fake.readyWith(ADDRESSES);
    await flush();
    expect($('unlock').textContent).toContain('restored your session in 180 ms');
    expect($('stellar-address').textContent).toBe(ADDRESSES.stellar);
  });

  it('copies diagnostics with timings and errors, and nothing sensitive', async () => {
    boot();
    await loginFlow();
    fake.supportId = 'HANA-2750-G5HM';
    fake.ethereum.request.mockRejectedValueOnce(Object.assign(new Error(`relay Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5 failed`), { code: -32603 }));
    click('sign-personal');
    await flush();
    click('copy-diagnostics');
    await flush();
    expect(copied).toHaveLength(1);
    const text = copied[0]!;
    expect($('diagnostics').textContent).toBe(text);
    const d = JSON.parse(text) as Record<string, unknown>;
    expect(d).toMatchObject({ environment: 'sandbox-dev', appKey: 'pk_test_85gd…', status: 'logged_in', addresses: ADDRESSES, supportId: 'HANA-2750-G5HM', pageOrigin: 'https://hana-id-demo-sandbox-dev.tingtc.workers.dev' });
    expect(d.logins).toEqual([{ at: '2026-10-29T12:00:00.000Z', method: 'google', totalMs: 7000, stages: TIMINGS }]);
    expect(d.errors).toEqual([{ at: '2026-10-29T12:00:00.000Z', action: 'sign', code: -32603, reason: null, message: 'relay [redacted] failed', requestId: null }]);
    expect(d.requestIds).toEqual([]);
    expect(text).not.toContain(CONFIG.publishableKey);
    expect(text).not.toContain('ab'.repeat(65));
    expect(text).not.toContain('Zm9vYmFy');
  });

  it('D405: an error from a Hana API answer puts its request ID in the diagnostics', async () => {
    boot();
    await loginFlow();
    const RQ = '3f2a9c1e-7b4d-4e8f-9a6b-0c1d2e3f4a5b';
    fake.ethereum.request.mockRejectedValueOnce(Object.assign(new Error('The Hana API could not complete the request'), { code: -32603, data: { code: 'api_unavailable', requestId: RQ } }));
    click('sign-personal');
    await flush();
    click('copy-diagnostics');
    await flush();
    const d = JSON.parse(copied[0]!) as { requestIds: string[]; errors: { code: unknown; requestId: unknown }[] };
    expect(d.requestIds).toEqual([RQ]);
    expect(d.errors).toEqual([expect.objectContaining({ code: 'api_unavailable', requestId: RQ })]);
  });

  it("says so when the clipboard refuses, and leaves the report on the page", async () => {
    boot();
    fake.readyWith(null);
    await flush();
    copyFails = true;
    click('copy-diagnostics');
    await flush();
    expect($('error').textContent).toMatch(/Could not copy/u);
    expect($('diagnostics').textContent).toContain('"environment": "sandbox-dev"');
  });

  it("refuses to pretend when the SDK's vault isn't the one the CSP allows", () => {
    startDemo({
      config: CONFIG,
      sdkVersion: '0.0.0',
      createClient: (c) => Object.assign(new FakeClient(c), { vaultOrigin: 'https://other.example' }) as unknown as DemoClient,
    });
    expect($('error').textContent).toMatch(/Sign-in failed \(config_mismatch\)/u);
  });
});

describe('status text', () => {
  it('formats the remaining session time', () => {
    expect(untilText(10_000)).toBe('now');
    expect(untilText(4 * 60_000)).toBe('in 4 min');
    expect(untilText((11 * 60 + 58) * 60_000)).toBe('in 11 h 58 min');
  });

  it('describes each status and the storage fallback', () => {
    expect(statusText(null, 0)).toBe('The Hana client could not start.');
    expect(statusText({ status: 'error', expiresAtMs: null, persistence: null, warning: null }, 0)).toMatch(/Reload/u);
    expect(statusText({ status: 'logged_in', expiresAtMs: null, persistence: 'none', warning: 'storage_unavailable' }, 0)).toBe(
      'Logged in · persistence: none, every page load signs in again (your browser blocks storage here).',
    );
  });
});

// ---- the NEAR card ----

const settle = async () => {
  for (let i = 0; i < 12; i++) await flush();
};

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const type = (text: string): void => {
  const input = $('near-text') as HTMLInputElement;
  input.value = text;
  input.dispatchEvent(new Event('input'));
};

/** The delegate action the vault was asked to sign, decoded. */
const signedDelegate = () => decodeNearDelegateAction(fake.near.signDelegateAction.mock.calls.at(-1)![0].delegateAction as Uint8Array);

const message = (index: number, account_id: string, text: string) => ({ index, account_id, text, block_timestamp_ms: Date.UTC(2026, 10, 11, 9, 30) });

describe('the NEAR card', () => {
  it('is hidden while signed out, and shows the account short with copy, in full on demand, and its explorer link', async () => {
    boot();
    fake.readyWith(null);
    await settle();
    expect($('near').hidden).toBe(true);
    await loginFlow();
    await settle();
    expect($('near').hidden).toBe(false);
    expect($('near-account').textContent).toBe(`${NEAR_ACCOUNT.slice(0, 6)}…${NEAR_ACCOUNT.slice(-6)}`);
    expect($('near-account-full').textContent).toBe(NEAR_ACCOUNT);
    expect(($('near-link') as HTMLAnchorElement).href).toBe(`https://testnet.nearblocks.io/address/${NEAR_ACCOUNT}`);
    expect($('near-link').getAttribute('rel')).toBe('noopener noreferrer');
    expect($('near-guestbook').textContent).toBe('hana-id-guestbook-dev1.testnet');
    expect($('near-balance').textContent).toBe('Balance: 0 NEAR. The guestbook write needs none.');
    click('copy-near');
    await flush();
    expect(copied).toEqual([NEAR_ACCOUNT]);
    expect($('notice').textContent).toBe('NEAR account copied.');
    // Reads only, at login: no activation, no signing.
    expect(fake.near.activate).not.toHaveBeenCalled();
    expect(rpc.count((c) => c.params.request_type === 'view_access_key')).toBe(1);
    expect(rpc.calls.every((c) => c.url === CONFIG.near.rpcUrl)).toBe(true);
    click('logout');
    await settle();
    expect($('near').hidden).toBe(true);
  });

  it('works the same after an email login', async () => {
    boot();
    fake.readyWith(null);
    await settle();
    click('login-email');
    fake.finishLogin!({ addresses: ADDRESSES, expiresAtMs: Date.UTC(2026, 9, 29, 23), persistence: 'session', timings: { app: 1, popup: 1, emailEntry: 1, emailStart: 1, emailCode: 1, emailVerify: 1, verify: 1, chain: 1, decrypt: 1 } });
    await settle();
    expect(fake.loginOptions).toEqual([{ method: 'email' }]);
    expect($('near').hidden).toBe(false);
    type('gm by email');
    click('near-write-button');
    expect(fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
    await settle();
    expect($('near-done').hidden).toBe(false);
  });

  it('stays hidden with a vault that has no NEAR account', async () => {
    boot();
    fake.readyWith({ stellar: ADDRESSES.stellar, evm: ADDRESSES.evm });
    await settle();
    expect($('wallet').hidden).toBe(false);
    expect($('near').hidden).toBe(true);
    expect($('export-near').hidden).toBe(true);
    expect(rpc.calls).toEqual([]);
  });

  it('counts characters as the contract does and refuses an empty or long message before any request', async () => {
    boot();
    await loginFlow();
    await settle();
    type('  🌸🌸  ');
    expect($('near-count').textContent).toBe('2 / 200');
    type('a'.repeat(201));
    expect($('near-count').textContent).toBe('201 / 200');
    expect($('near-count').classList.contains('over')).toBe(true);
    click('near-write-button');
    expect($('near-hint').textContent).toBe('That is 201 characters: the guestbook takes at most 200.');
    type('   ');
    click('near-write-button');
    expect($('near-hint').textContent).toBe('Write a message first (1 to 200 characters).');
    expect(fake.near.signDelegateAction).not.toHaveBeenCalled();
    expect(fake.prepareApproval).not.toHaveBeenCalled();
  });

  it('prepared: the click signs at once (the popup opens in the click), then relays, shows each stage, the transaction and the list', async () => {
    boot();
    rpc.messages = [message(0, 'alice.testnet', 'first!')];
    await loginFlow();
    await settle();
    expect($('near-messages').textContent).toContain('first!');
    type('gm from Hana');
    await settle();
    const sign = deferred<{ signature: string; signedDelegateAction: string }>();
    const relay = deferred<{ transactionHash: string; status: string }>();
    fake.near.signDelegateAction.mockImplementationOnce(() => sign.promise);
    fake.near.relay.mockImplementationOnce(() => relay.promise);
    click('near-write-button');
    // Synchronously in the click: the request is sent, and no window was opened in advance.
    expect(fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
    expect(fake.prepareApproval).not.toHaveBeenCalled();
    expect($('near-stage').textContent).toBe('Waiting for your approval in the Hana window…');
    expect(($('near-write-button') as HTMLButtonElement).disabled).toBe(true);
    expect(fake.near.signDelegateAction.mock.calls[0]![0].network).toBe('testnet');
    const d = signedDelegate();
    expect(d).toMatchObject({ senderId: NEAR_ACCOUNT, receiverId: 'hana-id-guestbook-dev1.testnet', nonce: 199_990_000_000_001n, maxBlockHeight: BigInt(rpc.height) + 600n });
    expect(d.actions).toEqual([{ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text: 'gm from Hana' })), gas: 30_000_000_000_000n, deposit: 0n }]);
    sign.resolve({ signature: 'c2ln', signedDelegateAction: 'U0RB' });
    await settle();
    expect($('near-stage').textContent).toBe('Sending it through Hana’s relayer, which pays the fee…');
    expect(fake.near.relay).toHaveBeenCalledWith({ network: 'testnet', signedDelegateAction: 'U0RB' });
    rpc.messages = [message(1, NEAR_ACCOUNT, 'gm from Hana'), ...rpc.messages];
    relay.resolve({ transactionHash: TX_HASH, status: 'executed' });
    await settle();
    expect($('near-stage').hidden).toBe(true);
    expect($('near-done').hidden).toBe(false);
    expect($('near-done-text').textContent).toBe('Written to the guestbook on NEAR testnet. You paid no gas.');
    expect(($('near-tx-link') as HTMLAnchorElement).href).toBe(`https://testnet.nearblocks.io/txns/${TX_HASH}`);
    const items = [...$('near-messages').querySelectorAll('li')];
    expect(items).toHaveLength(2);
    expect(items[0]!.classList.contains('mine')).toBe(true);
    expect(items[0]!.querySelector('.you')!.textContent).toBe('you');
    expect(items[0]!.querySelector('.text')!.textContent).toBe('gm from Hana');
    expect(items[1]!.querySelector('.you')).toBeNull();
    expect(($('near-text') as HTMLInputElement).value).toBe('');
    expect(fake.near.activate).not.toHaveBeenCalled();
    // A second write before the next read still uses a higher nonce.
    type('again');
    click('near-write-button');
    expect(signedDelegate().nonce).toBe(199_990_000_000_002n);
    await settle();
  });

  it('a new account: focusing the box activates it once, in the background, so the click still signs at once', async () => {
    boot();
    rpc.key = null;
    await loginFlow();
    await settle();
    expect($('near-balance').textContent).toMatch(/^Not on NEAR testnet yet: your first guestbook write creates it/u);
    fake.near.activate.mockImplementationOnce(async () => {
      rpc.key = { nonce: 199_999_999_000_000 };
      return { created: true };
    });
    $('near-text').dispatchEvent(new Event('focus'));
    await settle();
    expect(fake.near.activate).toHaveBeenCalledTimes(1);
    expect($('near-balance').textContent).toBe('Balance: 0 NEAR. The guestbook write needs none.');
    type('first write');
    click('near-write-button');
    expect(fake.prepareApproval).not.toHaveBeenCalled();
    expect(signedDelegate().nonce).toBe(199_999_999_000_001n);
    await settle();
    expect(fake.near.activate).toHaveBeenCalledTimes(1);
  });

  it('not prepared: the click opens Hana’s window first (prepareApproval), activates, reads, then signs into it', async () => {
    boot();
    rpc.key = null;
    await loginFlow();
    await settle();
    const activation = deferred<{ created: boolean }>();
    fake.near.activate.mockImplementationOnce(() => activation.promise);
    // Typed long ago: the read is stale, as on a slow first visit.
    ($('near-text') as HTMLInputElement).value = 'hello';
    wall += 61_000;
    click('near-write-button');
    expect(fake.prepareApproval).toHaveBeenCalledTimes(1);
    expect(fake.near.signDelegateAction).not.toHaveBeenCalled();
    expect($('near-stage').textContent).toBe('Reading your NEAR account on testnet…');
    await settle();
    expect($('near-stage').textContent).toBe('Preparing your NEAR account…');
    rpc.key = { nonce: 5_000_000 };
    activation.resolve({ created: true });
    await settle();
    expect(fake.near.signDelegateAction).toHaveBeenCalledTimes(1);
    // The key's nonce is far below testnet's window: the nonce is the window's floor.
    expect(signedDelegate().nonce).toBe(199_990_000_000_001n);
    expect($('near-done-text').textContent).toBe('Written to the guestbook on NEAR testnet. Your NEAR account was created for it. You paid no gas.');
    // Cached for the session: the next write doesn't activate again.
    type('second');
    click('near-write-button');
    await settle();
    expect(fake.near.activate).toHaveBeenCalledTimes(1);
  });

  it('right after login: retries activate and relay while the account is not in Hana’s wallet directory yet (409), then gives up', async () => {
    boot();
    rpc.key = null;
    await loginFlow();
    await settle();
    const unrecorded = () => hanaError(4100, { status: 409, reason: 'near_account_unrecorded' });
    fake.near.activate
      .mockRejectedValueOnce(unrecorded())
      .mockRejectedValueOnce(unrecorded())
      .mockImplementationOnce(async () => {
        rpc.key = { nonce: 199_999_999_000_000 };
        return { created: true };
      });
    fake.near.relay.mockRejectedValueOnce(unrecorded());
    ($('near-text') as HTMLInputElement).value = 'early bird';
    click('near-write-button');
    await settle();
    expect(fake.near.activate).toHaveBeenCalledTimes(3);
    expect(fake.near.relay).toHaveBeenCalledTimes(2);
    expect($('near-done').hidden).toBe(false);

    // Still unrecorded after about 20 s: a plain error, not an endless wait.
    document.body.innerHTML = body;
    boot();
    rpc.key = null;
    await loginFlow();
    await settle();
    fake.near.activate.mockRejectedValue(unrecorded());
    ($('near-text') as HTMLInputElement).value = 'too early';
    click('near-write-button');
    await settle();
    await settle();
    expect(fake.near.activate.mock.calls.length).toBeGreaterThan(3);
    expect(fake.near.activate.mock.calls.length).toBeLessThan(12);
    expect($('near-error').textContent).toMatch(/still setting up your NEAR account/u);
    expect(fake.near.signDelegateAction).not.toHaveBeenCalled();
  });

  it('cancels the prepared window when reading NEAR fails, and says so in the card', async () => {
    boot();
    await loginFlow();
    await settle();
    rpc.down = true;
    wall += 61_000;
    ($('near-text') as HTMLInputElement).value = 'hello';
    const cancel = vi.fn();
    fake.prepareApproval.mockReturnValueOnce({ cancel });
    click('near-write-button');
    await settle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(fake.near.signDelegateAction).not.toHaveBeenCalled();
    expect($('near-error').textContent).toBe('This page couldn’t read NEAR testnet (its RPC didn’t answer). Check your connection and try again.');
    expect($('near-stage').hidden).toBe(true);
    expect($('error').hidden).toBe(true);
    // The fallback RPC was tried too.
    expect(new Set(rpc.calls.map((c) => c.url))).toEqual(new Set([CONFIG.near.rpcUrl, CONFIG.near.rpcFallbackUrl]));
  });

  it.each([
    ['the vault refuses an unknown key', 'signDelegateAction', hanaError(4100, { reason: 'near_key_unknown' }), /doesn’t exist on testnet yet/u],
    ['the vault refuses an expired action', 'signDelegateAction', hanaError(4100, { reason: 'near_delegate_expiry' }), /expired before it was approved/u],
    ['the user rejects', 'signDelegateAction', hanaError(4001), /^Rejected in the Hana window: nothing was signed\.$/u],
    ['the relayer refuses the receiver', 'relay', hanaError(4100, { status: 403, reason: 'receiver_not_allowed' }), /pays only for calls to the demo guestbook/u],
    ['the relayer refuses with a code the demo doesn’t know', 'relay', hanaError(4100, { status: 400, reason: 'brand_new_code' }), /^Hana’s relayer refused this request \(brand_new_code\)/u],
    ['the relayer is down', 'relay', hanaError('api_unavailable', { status: 503, reason: 'relayer_unavailable' }), /relayer is unavailable right now/u],
    ['the relayer rate-limits', 'relay', hanaError('rate_limited', { status: 429, reason: 'rate_limited' }), /Too many guestbook writes/u],
  ] as const)('shows a plain message in the card when %s', async (_name, method, error, text) => {
    boot();
    await loginFlow();
    await settle();
    fake.near[method].mockRejectedValueOnce(error);
    type('hello');
    click('near-write-button');
    await settle();
    expect($('near-error').hidden).toBe(false);
    expect($('near-error').textContent).toMatch(text);
    expect($('near-error').textContent).not.toMatch(/[–—]/u);
    expect($('near-stage').hidden).toBe(true);
    expect($('near-done').hidden).toBe(true);
  });

  it('renders hostile guestbook entries strictly as text: no markup, no links, bidi and invisible characters neutralised, bounded', async () => {
    boot();
    rpc.messages = [
      message(5, NEAR_ACCOUNT, '<img src=x onerror="window.__xss=1">'),
      message(4, 'mallory.testnet', 'https://evil.example click me'),
      message(3, 'eve.testnet', 'gm‮txt.exe​'),
      message(2, '<b>bob</b>.testnet', 'invalid author: dropped'),
      message(1, 'long.testnet', 'y'.repeat(800)),
      { index: 0, account_id: 'x.testnet', text: { html: '<b>' }, block_timestamp_ms: 1 },
    ];
    await loginFlow();
    await settle();
    const list = $('near-messages');
    expect(list.querySelectorAll('img, a, b, script')).toHaveLength(0);
    const texts = [...list.querySelectorAll('.text')].map((p) => p.textContent);
    expect(texts).toEqual(['<img src=x onerror="window.__xss=1">', 'https://evil.example click me', 'gm�txt.exe�', `${'y'.repeat(200)}…`]);
    expect([...list.querySelectorAll('.text')].every((p) => p.childNodes.length === 1 && p.firstChild!.nodeType === 3)).toBe(true);
    expect([...list.querySelectorAll('.author')].map((a) => a.textContent)).toEqual([`${NEAR_ACCOUNT.slice(0, 6)}…${NEAR_ACCOUNT.slice(-6)}`, 'mallory.testnet', 'eve.testnet', 'long.testnet']);
    expect(list.querySelectorAll('.you')).toHaveLength(1);
    expect((window as unknown as { __xss?: number }).__xss).toBeUndefined();
    // Refresh reads again.
    rpc.messages = [];
    click('near-refresh');
    await settle();
    expect(list.children).toHaveLength(0);
    expect($('near-book-status').textContent).toBe('No messages yet. Be the first.');
  });

  it('Sign a transaction with no NEAR: signs a real add_message transaction, shows it and says it was not sent', async () => {
    boot();
    await loginFlow();
    await settle();
    type('signed only');
    click('sign-near-tx');
    expect(fake.near.signTransaction).toHaveBeenCalledTimes(1);
    const { network, transaction } = fake.near.signTransaction.mock.calls[0]![0];
    expect(network).toBe('testnet');
    const tx = decodeNearTransaction(transaction as Uint8Array);
    expect(tx).toMatchObject({ signerId: NEAR_ACCOUNT, receiverId: 'hana-id-guestbook-dev1.testnet', nonce: 1001n, blockHash: base58.decode(BLOCK_HASH) });
    expect(tx.actions).toEqual([{ type: 'functionCall', methodName: 'add_message', args: utf8(JSON.stringify({ text: 'signed only' })), gas: 30_000_000_000_000n, deposit: 0n }]);
    await settle();
    const item = $('near-results').querySelector('li')!;
    expect(item.textContent).toContain('NEAR transaction (add_message on the guestbook): signed, not sent');
    expect(item.textContent).toContain('Not sent: your NEAR account has no NEAR to pay the network fee.');
    expect(item.textContent).toContain('“Write to the guestbook (no NEAR needed)”');
    expect(rpc.sent).toEqual([]);
  });

  it('Sign a transaction with NEAR for the fee: signs and sends it, with its explorer link', async () => {
    boot();
    rpc.balance = '2000000000000000000000000';
    await loginFlow();
    await settle();
    expect($('near-balance').textContent).toBe('Balance: 2 NEAR.');
    click('sign-near-tx');
    await settle();
    expect(rpc.sent).toEqual(['U0lHTkVEVFJBTlNBQ1RJT05TSUdORURUUkFOU0FDVElPTg==']);
    const tx = decodeNearTransaction(fake.near.signTransaction.mock.calls[0]![0].transaction as Uint8Array);
    expect(JSON.parse(new TextDecoder().decode((tx.actions[0] as { args: Uint8Array }).args))).toEqual({ text: 'Hello from Hana ID (a signed NEAR transaction)' });
    const item = $('near-results').querySelector('li')!;
    expect(item.textContent).toContain('signed and sent');
    expect(item.querySelector('a')!.getAttribute('href')).toBe(`https://testnet.nearblocks.io/txns/${TX_HASH}`);
  });

  it('Sign a message (NEP-413): this page as the recipient, a fresh 32-byte nonce, signed in the click', async () => {
    boot();
    await loginFlow();
    await settle();
    click('sign-near-message');
    expect(fake.near.signMessage).toHaveBeenCalledTimes(1);
    const p = fake.near.signMessage.mock.calls[0]![0];
    expect(p.message).toBe('Hana ID testnet demo: sign in with NEAR (NEP-413). This signature moves nothing.');
    expect(p.recipient).toBe('hana-id-demo-sandbox-dev.tingtc.workers.dev');
    expect((p.nonce as Uint8Array).length).toBe(32);
    await settle();
    expect($('near-results').textContent).toContain('NEAR message (NEP-413): signed');
    expect($('near-results').textContent).toContain('TkVQNDEzU0lH');
  });

  it('the diagnostics carry the NEAR account, and a NEAR failure', async () => {
    boot();
    await loginFlow();
    await settle();
    fake.near.signDelegateAction.mockRejectedValueOnce(hanaError(4100, { reason: 'near_delegate_nonce_used' }));
    type('x');
    click('near-write-button');
    await settle();
    click('copy-diagnostics');
    await flush();
    const d = JSON.parse(copied.at(-1)!) as { addresses: Record<string, string>; errors: { action: string; code: unknown; reason: unknown }[] };
    expect(d.addresses.near).toBe(NEAR_ACCOUNT);
    expect(d.errors.map((e) => [e.action, e.code, e.reason])).toEqual([['near', 4100, 'near_delegate_nonce_used']]);
  });
});
