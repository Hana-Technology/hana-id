// @vitest-environment happy-dom
// @vitest-environment-options {"url":"http://localhost:5173/"}
// Boots the vault page (index.html + src/vault-page.ts) against a fake partner client and a mocked GET /v1/app: the
// env guards, mounting with the stored key (a page load is an unlock measurement), login from the click with the
// vault's timings, the persistence and unlock checks, remount, logout, the auto-approve demo and the results log.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginResult } from '@hana-id/core';
import { policyId } from '@hana-id/core/policy';
import type { HanaAddresses, HanaConfig, HanaStatus } from '@hana-id/web';
import type { PageEnv } from '../src/config.ts';
import { DEMO_POLICY, DEMO_STELLAR_PASSPHRASE } from '../src/demo-requests.ts';
import { type SmokeClient, type VaultPageDeps, startVaultPage } from '../src/vault-page.ts';

const html = readFileSync(join(import.meta.dirname, '..', 'index.html'), 'utf8');
const body = /<body>([\s\S]*)<\/body>/u.exec(html)![1]!.replace(/<script[\s\S]*?<\/script>/gu, '');
const PK = 'pk_test_1111111111111111111111';
const A: HanaAddresses = { stellar: 'GAEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSCIJBEEQSH7S', evm: '0x8ba1f109551bD432803012645Ac136ddd64DBA72' };
const B: HanaAddresses = { stellar: 'GADQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOBYHA4DQOZPI', evm: '0x000000000000000000000000000000000000dEaD' };
const TIMINGS = { app: 120, popup: 900, google: 4000, verify: 15, chain: 6200, decrypt: 40 };

const env: PageEnv = {
  name: 'sandbox-dev',
  network: 'testnet',
  signer: 'hana-id-signer-dev1.testnet',
  relayer: 'hana-id-relayer-dev1.testnet',
  mpc: 'v1.signer-prod.testnet',
  ckdDomainId: 2,
  ckdNetworkKey: 'bls12381g2:x',
  rpc: 'https://rpc.example',
  apiUrl: 'https://api.example',
  apiUrlOverridden: false,
  vaultOrigin: 'https://vault.example',
  authOrigin: 'https://auth.example',
};

type Listener = (...args: unknown[]) => void;

/** The partner client as the page sees it, driven by the test. */
class FakeClient {
  status: HanaStatus = 'unlocking';
  addresses: HanaAddresses | null = null;
  expiresAtMs: number | null = null;
  persistence: 'session' | 'none' | null = null;
  warning: 'storage_unavailable' | null = null;
  lastLogin: LoginResult | null = null;
  destroyed = false;
  readonly ready: Promise<void>;
  resolveReady!: () => void;
  rejectReady!: (e: unknown) => void;
  readonly listeners = new Map<string, Listener[]>();
  loginCalls = 0;
  finishLogin: ((r: LoginResult | Error) => void) | null = null;
  readonly logout = vi.fn(async () => {
    this.addresses = null;
    this.status = 'logged_out';
    return undefined;
  });
  readonly cancelLogin = vi.fn();
  readonly exportKey = vi.fn(async () => null);
  readonly revokeOtherDevices = vi.fn(async () => ({ revoked: 2 }));
  readonly requestAutoApprove = vi.fn(async () => ({ granted: true, policyId: policyId(DEMO_POLICY), expiresAtMs: Date.UTC(2026, 9, 28, 13) }));
  readonly autoApproveStatus = vi.fn(async () => null);
  readonly revokeAutoApprove = vi.fn(async () => null);
  readonly signRaw = vi.fn(async (): Promise<{ signature: Uint8Array }> => Promise.reject(Object.assign(new Error('Raw signing is off for this app'), { code: 4100 })));
  readonly stellar = { signTransaction: vi.fn(async (_xdr: string, _o: unknown) => ({ signedTxXdr: 'AAAA', signerAddress: A.stellar })) };
  readonly ethereum = { request: vi.fn(async (_a: { method: string; params?: unknown }): Promise<unknown> => '0x00') };

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

  /** The vault finished its handshake: logged out, or unlocked `addresses`. */
  readyWith(addresses: HanaAddresses | null, persistence: 'session' | 'none' = 'session'): void {
    this.persistence = persistence;
    if (addresses) {
      this.addresses = addresses;
      this.expiresAtMs = Date.UTC(2026, 9, 28, 23);
      this.status = 'logged_in';
    } else {
      this.status = 'logged_out';
    }
    this.resolveReady();
  }

  login(): Promise<HanaAddresses> {
    this.loginCalls += 1;
    this.status = 'logging_in';
    this.emit('statusChanged', 'logging_in');
    return new Promise((resolve, reject) => {
      this.finishLogin = (r) => {
        if (r instanceof Error) {
          this.status = 'logged_out';
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

  destroy(): void {
    this.destroyed = true;
  }
}

let clients: FakeClient[] = [];
let clock = 0;
const appCalls: Headers[] = [];
let appResponse: Record<string, unknown> = {};

function stubApi(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input) !== 'https://api.example/v1/app') return new Response('not found', { status: 404 });
      appCalls.push(new Headers(init?.headers));
      return Response.json({ scopeId: 's1', signer: env.signer, google: { clientId: 'own.apps.googleusercontent.com', mode: 'own' }, name: 'Smoke A', requestId: 'r1', ...appResponse });
    }),
  );
}

function boot(over: Partial<VaultPageDeps> = {}): void {
  document.body.innerHTML = body;
  startVaultPage({
    env,
    environments: ['sandbox-dev'],
    createClient: (config) => {
      const c = new FakeClient(config);
      clients.push(c);
      return c as unknown as SmokeClient;
    },
    now: () => clock,
    ...over,
  });
}

const last = (): FakeClient => clients.at(-1)!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
const text = (id: string) => document.getElementById(id)!.textContent ?? '';
const rows = (id: string) => [...document.querySelectorAll(`#${id} tr`)].map((r) => r.textContent ?? '');
const storedRuns = () => JSON.parse(localStorage.getItem('hana-smoke.vault-runs') ?? '[]') as { kind: string; timings: { stages: unknown; totalMs: number } }[];
const login = (addresses: HanaAddresses): LoginResult => ({ addresses, expiresAtMs: Date.UTC(2026, 9, 28, 23), persistence: 'session', timings: { ...TIMINGS } });

async function loggedIn(): Promise<FakeClient> {
  localStorage.setItem('hana-smoke.publishableKey', PK);
  boot();
  last().readyWith(A);
  await vi.waitFor(() => expect(button('sign-stellar-self').disabled).toBe(false));
  return last();
}

beforeEach(() => {
  localStorage.clear();
  clients = [];
  clock = 0;
  appCalls.length = 0;
  appResponse = {};
  stubApi();
});
afterEach(() => vi.unstubAllGlobals());

describe('vault smoke page: env guards', () => {
  it('refuses to run without vault origins, and never mounts the client', () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot({ env: { ...env, vaultOrigin: null, authOrigin: null } });
    expect(document.getElementById('env-problem')!.hidden).toBe(false);
    expect(text('env-problem')).toMatch(/sets no vaultOrigin\/authOrigin.*direct page still works/u);
    expect(button('load-app').disabled).toBe(true);
    expect(button('login').disabled).toBe(true);
    expect(clients).toHaveLength(0);
  });

  it('refuses an env the @hana-id/web build does not know', () => {
    boot({ environments: ['local'] });
    expect(text('env-problem')).toMatch(/built without env sandbox-dev \(known: local\)/u);
    expect(clients).toHaveLength(0);
  });

  it('warns that an API override applies to this page only', () => {
    boot({ env: { ...env, apiUrlOverridden: true } });
    expect(document.getElementById('env-warning')!.hidden).toBe(false);
    expect(text('env-warning')).toMatch(/GET \/v1\/app only/u);
  });
});

describe('vault smoke page: app and login', () => {
  it('loads the app: mounts the client with the env and demo chains, and reads GET /v1/app', async () => {
    boot();
    expect(clients).toHaveLength(0);
    (document.getElementById('pk') as HTMLInputElement).value = 'nope';
    button('load-app').click();
    expect(text('log')).toMatch(/Enter a publishable key/u);
    expect(clients).toHaveLength(0);

    (document.getElementById('pk') as HTMLInputElement).value = PK;
    (document.getElementById('account') as HTMLInputElement).value = 'personal';
    button('load-app').click();
    expect(last().config).toMatchObject({
      publishableKey: PK,
      environment: 'sandbox-dev',
      evm: { chains: [{ id: 11155111 }], defaultChainId: 11155111 },
      stellar: { networkPassphrase: DEMO_STELLAR_PASSPHRASE },
    });
    expect(localStorage.getItem('hana-smoke.publishableKey')).toBe(PK);
    expect(localStorage.getItem('hana-smoke.account')).toBe('personal');
    await vi.waitFor(() => expect(text('app')).toContain('s1'));
    expect(appCalls[0]!.get('x-hana-key')).toBe(PK);
    expect(text('app')).toContain('Smoke A');
    expect(text('policy')).toContain('none (every request gets the approval popup)');

    clock = 250;
    last().readyWith(null);
    await vi.waitFor(() => expect(text('log')).toMatch(/Vault ready in 250 ms: logged out/u));
    expect(button('login').disabled).toBe(false);
    expect(storedRuns()).toHaveLength(0);
  });

  it('flags an API signer that is not the env signer', async () => {
    appResponse = { signer: 'someone-else.testnet' };
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot();
    await vi.waitFor(() => expect(text('log')).toMatch(/signer someone-else.testnet is not this env's hana-id-signer-dev1.testnet/u));
    expect(text('app')).toMatch(/config_mismatch/u);
  });

  it('logs in from the click (synchronously), records the vault timings, and compares runs by account label', async () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot();
    last().readyWith(null);
    await vi.waitFor(() => expect(button('login').disabled).toBe(false));
    (document.getElementById('account') as HTMLInputElement).value = 'personal';

    clock = 1000;
    button('login').click();
    // The popup must open inside the click: login() is called before the handler returns.
    expect(last().loginCalls).toBe(1);
    expect(button('cancel-login').disabled).toBe(false);
    last().emit('loginProgress', { stage: 'google' });
    expect(text('wallet')).toContain('google');
    button('cancel-login').click();
    expect(last().cancelLogin).toHaveBeenCalled();

    clock = 13_500;
    last().finishLogin!(login(A));
    await vi.waitFor(() => expect(storedRuns()).toHaveLength(1));
    expect(storedRuns()[0]).toMatchObject({ kind: 'login', account: 'personal', scopeId: 's1', clientMode: 'own', persistence: 'session', stellar: A.stellar, timings: { stages: TIMINGS, totalMs: 12_500 } });
    expect(rows('timings')[0]).toBe(['1', 'login', '120', '900', '4000', '15', '6200', '40', '12500'].join(''));
    expect(text('log')).toMatch(/Logged in through the vault in 12500 ms \(chain 6200 ms\)/u);
    expect(text('wallet')).toContain(A.stellar);
    expect(button('login').disabled).toBe(true);
    // GET /v1/app is read again for the login's client mode.
    expect(appCalls.length).toBeGreaterThanOrEqual(2);
  });

  it('refuses an email address as the account label before opening anything', async () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot();
    last().readyWith(null);
    await vi.waitFor(() => expect(button('login').disabled).toBe(false));
    (document.getElementById('account') as HTMLInputElement).value = 'me@example.com';
    button('login').click();
    expect(last().loginCalls).toBe(0);
    expect(text('log')).toMatch(/not an email address/u);
    expect(localStorage.getItem('hana-smoke.account')).toBeNull();
  });

  it('explains token_has_pii and session_consumed refusals', async () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot();
    last().readyWith(null);
    await vi.waitFor(() => expect(button('login').disabled).toBe(false));
    button('login').click();
    last().finishLogin!(Object.assign(new Error('The Google token carries a claim outside the allow-list'), { code: 'token_has_pii', data: { claim: 'email' } }));
    await vi.waitFor(() => expect(text('log')).toMatch(/Login refused: the Google token carries a claim outside the allow-list \(token_has_pii: .*"claim":"email"/u));
    await vi.waitFor(() => expect(button('login').disabled).toBe(false));
    button('login').click();
    last().finishLogin!(Object.assign(new Error('A replay used up the sign-in'), { code: 'session_consumed' }));
    await vi.waitFor(() => expect(text('log')).toMatch(/Continue signing in/u));
    expect(storedRuns()).toHaveLength(0);
  });

  it('does not record a login that only returned the existing session', async () => {
    const c = await loggedIn();
    const before = storedRuns().length;
    // As the client answers when already logged in: no popup, the same lastLogin.
    c.login = () => Promise.resolve(A);
    button('login').disabled = false; // the page disables it while logged in; click anyway
    button('login').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Already logged in: no new login/u));
    expect(storedRuns()).toHaveLength(before);
  });
});

describe('vault smoke page: persistence and unlock', () => {
  it('a page load that unlocks is logged with its ready time and must restore the last run', async () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    localStorage.setItem('hana-smoke.account', 'personal');
    boot();
    last().readyWith(null);
    await vi.waitFor(() => expect(button('login').disabled).toBe(false));
    button('login').click();
    last().finishLogin!(login(A));
    await vi.waitFor(() => expect(storedRuns()).toHaveLength(1));

    // Reload: a new page boots, the stored key mounts the vault at once.
    clients = [];
    clock = 0;
    boot();
    expect(clients).toHaveLength(1);
    clock = 180;
    last().readyWith(A);
    await vi.waitFor(() => expect(storedRuns()).toHaveLength(2));
    expect(storedRuns()[1]).toMatchObject({ kind: 'unlock', scopeId: 's1', clientMode: 'own', account: 'personal', timings: { stages: null, totalMs: 180 } });
    expect(rows('runs')[1]).toMatch(/#1: OK — unlock restored #1's addresses/u);
    expect(text('log')).toMatch(/Vault ready in 180 ms: unlocked/u);

    // Remount: the old client goes, a new one unlocks; events from the old one are ignored.
    const old = last();
    clock = 1000;
    button('remount').click();
    expect(old.destroyed).toBe(true);
    expect(clients).toHaveLength(2);
    old.emit('accountsChanged', null);
    expect(text('log')).not.toMatch(/accountsChanged: logged out/u);
    clock = 1150;
    last().readyWith(B);
    await vi.waitFor(() => expect(storedRuns()).toHaveLength(3));
    expect(rows('runs')[2]).toMatch(/#2: FAIL — unlock gave DIFFERENT addresses from #2/u);
    expect(text('log')).toMatch(/Run #3 check FAILED/u);
  });

  it('reports a vault that fails to load', async () => {
    localStorage.setItem('hana-smoke.publishableKey', PK);
    boot();
    last().rejectReady(Object.assign(new Error("The Hana vault didn't load"), { code: 'vault_unavailable' }));
    await vi.waitFor(() => expect(text('log')).toMatch(/Vault failed to load: vault_unavailable/u));
  });

  it('logs out, revokes other devices and starts exports', async () => {
    const c = await loggedIn();
    button('revoke-others').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Revoked 2 share\(s\) on other devices/u));
    button('export-evm').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Export evm: done/u));
    expect(c.exportKey).toHaveBeenCalledWith('evm');
    await vi.waitFor(() => expect(button('logout').disabled).toBe(false));
    button('logout').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Logged out: share revoked/u));
    expect(c.logout).toHaveBeenCalled();
    expect(button('sign-stellar-self').disabled).toBe(true);
  });

  it('reload calls the injected reload', () => {
    const reload = vi.fn();
    boot({ reload });
    button('reload').click();
    expect(reload).toHaveBeenCalled();
  });
});

describe('vault smoke page: auto-approve demo', () => {
  it('shows whether the app policy in force is the demo policy', async () => {
    appResponse = { autoApprovePolicy: DEMO_POLICY };
    await loggedIn();
    await vi.waitFor(() => expect(text('policy')).toContain('= the demo policy'));
    expect(text('policy')).toContain(policyId(DEMO_POLICY));
    expect(text('demo-policy')).toContain('"perDayCount": 20');
  });

  it('flags an invalid app policy', async () => {
    appResponse = { autoApprovePolicy: { v: 2 } };
    await loggedIn();
    await vi.waitFor(() => expect(text('policy')).toMatch(/Invalid auto-approve policy/u));
  });

  it('consent, status and stop go to the vault', async () => {
    const c = await loggedIn();
    button('aa-request').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Auto-approve accepted: policy [0-9a-f]{64} until .*\(the demo policy\)/u));
    button('aa-status').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Auto-approve: no consent in force/u));
    button('aa-revoke').click();
    await vi.waitFor(() => expect(text('log')).toMatch(/Auto-approve stopped/u));
    expect(c.revokeAutoApprove).toHaveBeenCalled();
  });

  it('tells auto-approved, approved, rejected and refused requests apart', async () => {
    const c = await loggedIn();
    c.stellar.signTransaction.mockImplementationOnce(async () => {
      c.emit('autoApproved', { kind: 'stellar_signTransaction', chain: 'stellar', contract: 'CDLZ', function: 'transfer' });
      return { signedTxXdr: 'AAAA', signerAddress: A.stellar };
    });
    clock = 0;
    button('sign-stellar-self').click();
    await vi.waitFor(() => expect(rows('signs')[0]).toMatch(/signed, auto-approved \(no popup\)/u));
    const [xdr, opts] = c.stellar.signTransaction.mock.calls[0]!;
    expect(opts).toEqual({ networkPassphrase: DEMO_STELLAR_PASSPHRASE });
    expect(typeof xdr).toBe('string');

    button('sign-stellar-other').click();
    await vi.waitFor(() => expect(rows('signs')[0]).toMatch(/signed after approval/u));

    button('sign-evm-self').click();
    await vi.waitFor(() => expect(c.ethereum.request).toHaveBeenCalledTimes(1));
    const call = c.ethereum.request.mock.calls[0]![0] as { method: string; params: [{ to: string; data: string; chainId: string }] };
    expect(call.method).toBe('eth_signTransaction');
    expect(call.params[0]).toMatchObject({ chainId: '0xaa36a7', to: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238' });
    expect(call.params[0].data).toContain(A.evm.slice(2).toLowerCase());

    c.ethereum.request.mockImplementationOnce(async () => Promise.reject(Object.assign(new Error('User rejected'), { code: 4001 })));
    button('sign-personal').click();
    await vi.waitFor(() => expect(rows('signs')[0]).toMatch(/personal_signrejected \(4001\)/u));
    expect(c.ethereum.request.mock.calls[1]![0]).toMatchObject({ method: 'personal_sign', params: [expect.stringMatching(/^0x[0-9a-f]+$/u), A.evm] });

    button('sign-raw').click();
    await vi.waitFor(() => expect(rows('signs')[0]).toMatch(/refused: 4100: Raw signing is off/u));
    expect(c.signRaw).toHaveBeenCalledWith({ chain: 'stellar', bytes: expect.any(Uint8Array) });
    expect(rows('signs')).toHaveLength(5);
  });
});

describe('vault smoke page: results log', () => {
  it('shows the ship gate, copies both logs as JSON and clears the vault log', async () => {
    const direct = [{ run: 1, env: 'sandbox-dev', signer: env.signer, path: 's1#google#111#0', stellar: 'GA', evm: '0xA', appIdHex: 'aa', derivation: 1, keyIndex: 0, scopeId: 's1', counter: 1, timings: { googleMs: 1, createSessionMs: 4000, deriveMs: 4000, decryptVerifyMs: 4, totalMs: 10 } }];
    localStorage.setItem('hana-smoke.runs', JSON.stringify(direct));
    const writeText = vi.fn(async (_: string) => undefined);
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } });
    await loggedIn();
    expect(text('ship-gate')).toMatch(/pending: Needs 10 more vault login\(s\) and 9 more direct-page session\(s\) on sandbox-dev/u);
    expect(text('ship-gate')).toMatch(/median 8000 ms over 1 of 1 session/u);
    button('copy-json').click();
    await vi.waitFor(() => expect(writeText).toHaveBeenCalled());
    const out = JSON.parse(writeText.mock.calls[0]![0]) as { version: number; vaultRuns: unknown[]; directRuns: unknown[] };
    expect(out.version).toBe(2);
    expect(out.vaultRuns).toHaveLength(1);
    expect(out.directRuns).toEqual(direct);
    button('clear-log').click();
    expect(rows('runs')).toHaveLength(0);
    expect(storedRuns()).toHaveLength(0);
    expect(localStorage.getItem('hana-smoke.runs')).not.toBeNull();
  });
});
