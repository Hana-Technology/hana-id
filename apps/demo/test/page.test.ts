// @vitest-environment happy-dom
// @vitest-environment-options {"url":"https://hana-id-demo-sandbox-dev.tingtc.workers.dev/"}
// Boots the demo page (index.html + src/page.ts) against a fake partner client: the createHana config, login from the
// click with timings, the addresses and explorer links, signing, export, logout, the plain error messages, and the
// diagnostics report.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResult } from '@hana-id/core';
import type { HanaAddresses, HanaConfig, HanaStatus } from '@hana-id/web';
import { type DemoClient, startDemo, statusText, untilText } from '../src/page.ts';
import { TEST_MESSAGE, utf8Hex } from '../src/requests.ts';
import { ADDRESSES, CONFIG } from './fixtures.ts';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!;
const TIMINGS = { app: 120, popup: 900, google: 4000, verify: 15, chain: 6200, decrypt: 40 };

type Listener = (...args: unknown[]) => void;

class FakeClient {
  status: HanaStatus = 'unlocking';
  addresses: HanaAddresses | null = null;
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
  readonly exportKey = vi.fn(async (_chain: 'stellar' | 'evm') => null);
  readonly revokeOtherDevices = vi.fn(async () => ({ revoked: 2 }));
  readonly stellar = { signMessage: vi.fn(async (_m: string, _o: unknown) => ({ signedMessage: 'c2lnbmVk', signerAddress: ADDRESSES.stellar })) };
  readonly ethereum = { request: vi.fn(async (_a: { method: string; params?: unknown }): Promise<unknown> => `0x${'ab'.repeat(65)}`) };

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

  login(): Promise<HanaAddresses> {
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

function boot(): void {
  copied = [];
  startDemo({
    config: CONFIG,
    sdkVersion: '0.0.0',
    createClient: (c) => {
      fake = new FakeClient(c);
      return fake as unknown as DemoClient;
    },
    now: () => t,
    clock: () => Date.UTC(2026, 9, 29, 12),
    copy: async (text) => {
      if (copyFails) throw new Error('denied');
      copied.push(text);
    },
  });
}

beforeEach(() => {
  document.body.innerHTML = body;
  t = 0;
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
  it('creates the client exactly as a partner does, from the baked configuration', () => {
    boot();
    expect(fake.config).toEqual({
      publishableKey: 'pk_test_85gdPtFF4kYzqgPisccZbsT9fQP1tq7ie',
      environment: 'sandbox-dev',
      evm: { chains: [{ id: 84532, rpcUrl: 'https://sepolia.base.org' }], defaultChainId: 84532 },
      stellar: { networkPassphrase: 'Test SDF Network ; September 2015' },
    });
    expect($('testnet-banner').textContent).toContain('Testnet demo — test networks only, nothing here holds real funds.');
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
    expect(cells.slice(1)).toEqual(['120', '900', '4000', '15', '6200', '40', '7000']);
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
    fake.emit('launcher', { visible: true, label: 'Review in Hana' });
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

  it('exports through the Hana window, logs out other devices and logs out', async () => {
    boot();
    await loginFlow();
    click('export-stellar');
    await flush();
    expect(fake.exportKey).toHaveBeenCalledWith('stellar');
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
    fake.ethereum.request.mockRejectedValueOnce(Object.assign(new Error(`relay Zm9vYmFyYmF6cXV4cXV1eGNvcmdlZ3JhdWx0Z2FycGx5 failed`), { code: -32603 }));
    click('sign-personal');
    await flush();
    click('copy-diagnostics');
    await flush();
    expect(copied).toHaveLength(1);
    const text = copied[0]!;
    expect($('diagnostics').textContent).toBe(text);
    const d = JSON.parse(text) as Record<string, unknown>;
    expect(d).toMatchObject({ environment: 'sandbox-dev', appKey: 'pk_test_85gd…', status: 'logged_in', addresses: ADDRESSES, pageOrigin: 'https://hana-id-demo-sandbox-dev.tingtc.workers.dev' });
    expect(d.logins).toEqual([{ at: '2026-10-29T12:00:00.000Z', totalMs: 7000, stages: TIMINGS }]);
    expect(d.errors).toEqual([{ at: '2026-10-29T12:00:00.000Z', action: 'sign', code: -32603, reason: null, message: 'relay [redacted] failed' }]);
    expect(text).not.toContain(CONFIG.publishableKey);
    expect(text).not.toContain('ab'.repeat(65));
    expect(text).not.toContain('Zm9vYmFy');
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
