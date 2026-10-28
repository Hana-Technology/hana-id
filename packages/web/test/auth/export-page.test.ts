// @vitest-environment happy-dom
// /export (docs/batch-b-spec.md "Key export", "Tests → Web unit → Export"): refused when framed, without a gesture,
// with a vault reply from the wrong source, with a stale auth_time or on an address mismatch; the child login popup's
// name is random; a fresh login of its own (its own session key, nonce, relay and path); typed confirmation and
// hold-to-reveal; no message in either direction carries key material.
import {
  ApiError,
  type AppConfig,
  type LoginBody,
  type RelayReadResponse,
  addressOfExport,
  chainAddress,
  ckdAppId,
  encryptRelayPayload,
  extractPrk,
  newAppKey,
  parseWindowMessage,
  sessionNonce,
} from '@hana-id/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { EXPORT_CONFIRMATION, startExportPage } from '../../src/auth/export-page.ts';
import type { NearReader } from '../../src/auth/near-rpc.ts';
import { simulateMpc } from '../../../core/test/helpers.ts';
import { CLIENT_ID, ENV, EVIL, FakeWindow, NET, PARTNER, PK, type RemoteWindow, type TokenSigner, asWindow, flush, pageText, remoteWindow, resetDom, tokenSigner } from './helpers.ts';

const SCOPE = 's1';
const SUB = '110248495921238986420';
const PATH = `${SCOPE}#google#${SUB}#0`;

/** The address the fixed MPC network gives PATH (S doesn't depend on the ephemeral app key). */
function addressFor(chain: 'stellar' | 'evm', path = PATH): string {
  const { expected } = simulateMpc(newAppKey().publicKey.AppPublicKeyPV.pk1, ckdAppId(ENV.signer, path), NET);
  const prk = extractPrk(Uint8Array.from(expected));
  return chainAddress(prk, chain, 0);
}

const appConfig = (over: Partial<AppConfig> = {}): AppConfig => ({
  scopeId: SCOPE,
  signer: ENV.signer,
  google: { clientId: CLIENT_ID, mode: 'shared' },
  name: 'Partner App',
  serverTimeMs: Date.now(),
  requestId: 'r',
  ...over,
});

let signer: TokenSigner;

interface Run {
  win: FakeWindow;
  vault: RemoteWindow;
  child: RemoteWindow;
  api: AuthApi & Record<'getApp' | 'readRelay' | 'login', ReturnType<typeof vi.fn>>;
  page: ReturnType<typeof startExportPage>;
  /** Resolves the pending relay read with this payload, encrypted as the callback would. */
  deliver(claims?: Record<string, unknown> | { error: string }): Promise<void>;
  loginBodies: LoginBody[];
}

function run(o: { chain?: 'stellar' | 'evm'; address?: string; config?: AppConfig; loginPath?: string; gesture?: boolean } = {}): Run {
  const chain = o.chain ?? 'stellar';
  const win = new FakeWindow('/export');
  const vault = remoteWindow();
  const child = remoteWindow();
  win.opener = asWindow(vault);
  win.openResult = child;
  let resolveRead: (v: RelayReadResponse | null) => void = () => {};
  const loginBodies: LoginBody[] = [];
  const api = {
    getApp: vi.fn(async () => o.config ?? appConfig()),
    writeRelay: vi.fn(),
    readRelay: vi.fn(
      () =>
        new Promise<RelayReadResponse | null>((r) => {
          resolveRead = r;
        }),
    ),
    login: vi.fn(async (_pk: string, _parent: string, body: LoginBody) => {
      loginBodies.push(structuredClone(body));
      const { response } = simulateMpc(body.pk1, ckdAppId(ENV.signer, o.loginPath ?? PATH), NET);
      return { result: response, session: { scope_id: SCOPE, expires_at_ms: body.expiresAtMs, max_uses: 1, used: 1 as const }, nearTx: 'tx', requestId: 'r' };
    }),
  };
  const near: NearReader = { getSession: vi.fn(), txOutcome: vi.fn() };
  const page = startExportPage({ win, env: ENV, api, near, jwks: async (kid) => (kid === signer.jwk.kid ? signer.jwk : null), sleep: async () => {}, isGesture: () => o.gesture ?? true });
  const context = { v: 1, t: 'hana:export-context', pk: PK, appName: 'Vault name', parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, keyIndex: 0, chain, address: o.address ?? addressFor(chain) };
  win.message(context, ENV.vaultOrigin, vault);
  return {
    win,
    vault,
    child,
    api: api as never,
    page,
    loginBodies,
    async deliver(claims) {
      const params = parseWindowMessage(child.received[0], ['hana:auth-params']);
      if (!params) throw new Error('no auth-params sent');
      const now = Math.floor(Date.now() / 1000);
      const payload =
        claims && 'error' in claims
          ? { error: claims.error as string }
          : { idToken: await signer.sign({ iss: 'https://accounts.google.com', azp: CLIENT_ID, aud: CLIENT_ID, sub: SUB, iat: now, exp: now + 3600, nonce: params.nonce, ...claims }) };
      const value = await encryptRelayPayload(params.relayKey, params.relayId, payload);
      resolveRead({ ...value, serverTimeMs: Date.now() });
    },
  };
}

const button = (label: RegExp) => [...document.querySelectorAll('button')].find((b) => label.test(b.textContent ?? '')) ?? null;
const click = (b: Element | null) => b?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

/** Context accepted → click → child hello → auth-params sent. */
async function signIn(r: Run): Promise<void> {
  await vi.waitFor(() => expect(r.page.state).toBe('ready'));
  click(button(/Sign in with Google/u));
  await vi.waitFor(() => expect(r.win.opened).toHaveLength(1));
  // The window opens the child before any await and answers its (repeated) hello once its session is ready.
  expect(r.win.opened).toHaveLength(1);
  await vi.waitFor(() => {
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.received).toHaveLength(1);
  });
}

beforeEach(async () => {
  resetDom();
  signer ??= await tokenSigner();
});

describe('/export', () => {
  it('says hello to the vault and checks its context against GET /v1/app', async () => {
    const r = run();
    expect(r.vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:export-hello' }, ENV.vaultOrigin);
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    expect(r.api.getApp).toHaveBeenCalledWith(PK, PARTNER);
    expect(pageText()).toContain('Export your Stellar key');
    expect(pageText()).toContain('Partner App');
  });

  it('exports the key after a fresh login of its own, a typed confirmation and only while the button is held', async () => {
    const address = addressFor('stellar');
    const r = run({ address });
    await signIn(r);
    const opened = r.win.opened[0];
    expect(opened?.url).toBe(`${ENV.authOrigin}/login?mode=export`);
    expect(opened?.target).toMatch(/^hana-login-[0-9a-f]{32}$/u);
    expect(opened?.features).toBe('popup,width=480,height=640');

    // auth-params to the child, on authOrigin, with this window's own max_uses = 1 session and a nonce that commits to it.
    expect(r.child.postMessage.mock.calls[0]?.[1]).toBe(ENV.authOrigin);
    const params = parseWindowMessage(r.child.received[0], ['hana:auth-params']);
    expect(params).not.toBeNull();
    expect(params).toMatchObject({ pk: PK, parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, clientId: CLIENT_ID, keyIndex: 0, maxUses: 1 });
    expect(params?.nonce).toBe(
      sessionNonce({ signer: ENV.signer, scopeId: SCOPE, sessionPublicKey: params!.sessionPublicKey, expiresAtMs: params!.expiresAtMs, keyIndex: 0, maxUses: 1, salt: params!.salt }),
    );

    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    expect(r.api.readRelay.mock.calls[0]?.[0]).toBe(params?.relayId);
    expect(r.loginBodies[0]).toMatchObject({ maxUses: 1, keyIndex: 0, expiresAtMs: params?.expiresAtMs });
    expect(r.child.closed).toBe(true);

    // Typed confirmation.
    const cont = button(/Continue/u) as HTMLButtonElement;
    const input = document.querySelector('input') as HTMLInputElement;
    expect(cont.disabled).toBe(true);
    input.value = 'export';
    input.dispatchEvent(new Event('input'));
    expect(cont.disabled).toBe(true);
    input.value = EXPORT_CONFIRMATION;
    input.dispatchEvent(new Event('input'));
    expect(cont.disabled).toBe(false);
    click(cont);
    expect(r.page.state).toBe('reveal');

    // Hold to reveal.
    const hold = button(/Hold to show/u) as HTMLButtonElement;
    const secret = document.querySelector('.secret') as HTMLElement;
    expect(secret.textContent).toBe('••••••••');
    hold.dispatchEvent(new Event('pointerdown'));
    const shown = secret.textContent as string;
    expect(shown).toMatch(/^S[A-Z2-7]{55}$/u);
    expect(addressOfExport('stellar', shown)).toBe(address);
    hold.dispatchEvent(new Event('pointerup'));
    expect(secret.textContent).toBe('••••••••');
    hold.dispatchEvent(new Event('pointerdown'));
    hold.dispatchEvent(new Event('pointerleave'));
    expect(secret.textContent).toBe('••••••••');

    // No message to the vault or the child carries the key, and only auth-params carries a secret (relayKey).
    const all = JSON.stringify([...r.vault.received, ...r.child.received], (_, v) => (v instanceof Uint8Array ? Array.from(v) : v));
    expect(all).not.toContain(shown);
    expect(r.vault.received).toEqual([{ v: 1, t: 'hana:export-hello' }]);
    expect(r.child.received).toHaveLength(1);

    // Closing the window zeroes the key: holding the button shows nothing any more.
    r.win.dispatch('pagehide');
    hold.dispatchEvent(new Event('pointerdown'));
    expect(secret.textContent).toBe('••••••••');
  });

  it('exports an EVM key as 0x + 64 lowercase hex', async () => {
    const address = addressFor('evm');
    const r = run({ chain: 'evm', address });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('confirm');
    const input = document.querySelector('input') as HTMLInputElement;
    input.value = EXPORT_CONFIRMATION;
    input.dispatchEvent(new Event('input'));
    click(button(/Continue/u));
    (button(/Hold to show/u) as HTMLButtonElement).dispatchEvent(new Event('pointerdown'));
    const shown = document.querySelector('.secret')?.textContent as string;
    expect(shown).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(addressOfExport('evm', shown)).toBe(address);
  });

  it('refuses on an address mismatch and shows nothing', async () => {
    const r = run({ address: addressFor('stellar', `${SCOPE}#google#someone-else#0`) });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('address_mismatch');
    expect(document.querySelector('.secret')).toBeNull();
  });

  it('refuses a CKD answer for another path (pairing check against its own path)', async () => {
    const r = run({ loginPath: `${SCOPE}#google#attacker#0` });
    await signIn(r);
    await r.deliver();
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('pairing_failed');
  });

  it('refuses an auth_time older than 5 min, and accepts a fresh one', async () => {
    const stale = run();
    await signIn(stale);
    await stale.deliver({ auth_time: Math.floor(Date.now() / 1000) - 6 * 60 });
    expect(await stale.page.settled).toBe('error');
    expect(stale.page.errorCode).toBe('token_invalid');
    expect(stale.api.login).not.toHaveBeenCalled();

    resetDom();
    const fresh = run();
    await signIn(fresh);
    await fresh.deliver({ auth_time: Math.floor(Date.now() / 1000) - 30 });
    expect(await fresh.page.settled).toBe('confirm');
  });

  it.each([
    ['a wrong nonce', { nonce: 'x'.repeat(43) }, 'token_invalid'],
    ['a wrong audience', { aud: 'other.apps.googleusercontent.com' }, 'token_invalid'],
    ['an email claim', { email: 'a@b.example' }, 'token_has_pii'],
  ])('refuses a token with %s before /v1/login', async (_, claims, codeExpected) => {
    const r = run();
    await signIn(r);
    await r.deliver(claims);
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe(codeExpected);
    expect(r.api.login).not.toHaveBeenCalled();
  });

  it('Google #error gives google_error', async () => {
    const r = run();
    await signIn(r);
    await r.deliver({ error: 'access_denied' });
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('google_error');
  });

  it('refuses to run framed', () => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    win.top = {};
    const page = startExportPage({ win, env: ENV, api: {} as AuthApi, near: {} as NearReader });
    expect(page.state).toBe('error');
    expect(vault.postMessage).not.toHaveBeenCalled();
    expect(win.listenerCount('message')).toBe(0);
  });

  it('refuses to start without a user gesture', async () => {
    const r = run({ gesture: false });
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await flush();
    expect(r.win.opened).toEqual([]);
  });

  it('ignores a vault reply from the wrong source or origin', async () => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    const api = { getApp: vi.fn(async () => appConfig()) } as unknown as AuthApi;
    const page = startExportPage({ win, env: ENV, api, near: {} as NearReader });
    const context = { v: 1, t: 'hana:export-context', pk: PK, appName: 'A', parentOrigin: PARTNER, scopeId: SCOPE, signer: ENV.signer, keyIndex: 0, chain: 'evm', address: addressFor('evm') };
    win.message(context, ENV.vaultOrigin, remoteWindow());
    win.message(context, EVIL, vault);
    win.message(context, ENV.authOrigin, vault);
    await flush();
    expect(page.state).toBe('connecting');
    expect(api.getApp).not.toHaveBeenCalled();
  });

  it.each([
    ['the vault names another signer', { signerInContext: 'evil-signer.testnet' }, appConfig()],
    ['the API names another signer', {}, appConfig({ signer: 'evil-signer.testnet' })],
    ['the API has another scope', {}, appConfig({ scopeId: 's2' })],
  ])('refuses (config_mismatch) when %s', async (_, o, config) => {
    const win = new FakeWindow('/export');
    const vault = remoteWindow();
    win.opener = asWindow(vault);
    const page = startExportPage({ win, env: ENV, api: { getApp: vi.fn(async () => config) } as unknown as AuthApi, near: {} as NearReader });
    const signerName = (o as { signerInContext?: string }).signerInContext ?? ENV.signer;
    win.message({ v: 1, t: 'hana:export-context', pk: PK, appName: 'A', parentOrigin: PARTNER, scopeId: SCOPE, signer: signerName, keyIndex: 0, chain: 'evm', address: addressFor('evm') }, ENV.vaultOrigin, vault);
    await vi.waitFor(() => expect(page.state).toBe('error'));
    expect(page.errorCode).toBe('config_mismatch');
  });

  it('answers auth-hello only from the child it opened, on authOrigin', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await vi.waitFor(() => expect(r.page.awaitingChild).toBe(true));
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, remoteWindow());
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.vaultOrigin, r.child);
    r.win.message({ v: 1, t: 'hana:auth-hello' }, EVIL, r.child);
    await flush();
    expect(r.child.postMessage).not.toHaveBeenCalled();
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.postMessage).toHaveBeenCalledTimes(1);
  });

  it('gives each child login popup a random name, and offers a retry when the popup is blocked', async () => {
    const names = new Set<string>();
    for (let i = 0; i < 3; i++) {
      resetDom();
      const r = run();
      r.win.openResult = null;
      await vi.waitFor(() => expect(r.page.state).toBe('ready'));
      click(button(/Sign in with Google/u));
      await vi.waitFor(() => expect(r.win.opened).toHaveLength(1));
      expect(pageText()).toContain('blocked');
      r.win.openResult = r.child;
      click(button(/Try again/u));
      await vi.waitFor(() => expect(r.win.opened).toHaveLength(2));
      for (const o of r.win.opened) names.add(o.target);
    }
    expect(names.size).toBe(6);
    for (const n of names) expect(n).toMatch(/^hana-login-[0-9a-f]{32}$/u);
  });

  it('opens the child popup synchronously in the click, before any await', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    expect(r.win.opened).toHaveLength(1);
  });

  it('offers a new attempt when the child popup is closed before it connects', async () => {
    const r = run();
    await vi.waitFor(() => expect(r.page.state).toBe('ready'));
    click(button(/Sign in with Google/u));
    await vi.waitFor(() => expect(r.page.awaitingChild).toBe(true));
    r.child.closed = true;
    await vi.waitFor(() => expect(r.page.state).toBe('ready'), { timeout: 3000 });
    expect(pageText()).toContain('closed before it finished');
    // A late hello from the closed child is not answered.
    r.win.message({ v: 1, t: 'hana:auth-hello' }, ENV.authOrigin, r.child);
    expect(r.child.postMessage).not.toHaveBeenCalled();
    const fresh = remoteWindow();
    r.win.openResult = fresh;
    click(button(/Try again/u));
    expect(r.win.opened).toHaveLength(2);
    expect(r.win.opened[1]?.target).not.toBe(r.win.opened[0]?.target);
  });

  it('a relay that answers 410 ends the export', async () => {
    const r = run();
    r.api.readRelay.mockImplementation(async () => {
      throw new ApiError(410, 'relay_gone', 'gone', null, null);
    });
    await signIn(r);
    expect(await r.page.settled).toBe('error');
    expect(r.page.errorCode).toBe('token_invalid');
  });
});
