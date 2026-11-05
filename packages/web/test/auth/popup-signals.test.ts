// @vitest-environment happy-dom
// D347, popup side: the signals the vault's close watch needs. Every Hana page says so before it navigates to Google
// (`google`), the callback says it is back with its opener (`back`), and a page that closes itself after relaying says
// so first (`relayed`). Only `hana:auth-progress` with a stage, posted with vaultOrigin as the target origin.
import { relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { runCallbackPage, vaultTargets } from '../../src/auth/callback-page.ts';
import { startLoginPage } from '../../src/auth/login-page.ts';
import { storeLoginEntry } from '../../src/auth/login-storage.ts';
import { SIGNAL_ACK_WAIT_MS } from '../../src/auth/vault-signal.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

const VAULT_FRAME = `hana-vault-${'ab'.repeat(16)}`;
const NOW = 1_800_000_000_000;
const SUBJECT = '110248495921238986420';
const jwt = (claims: Record<string, unknown>) => [{ alg: 'RS256' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');

beforeEach(() => resetDom());
afterEach(() => vi.unstubAllGlobals());

/** The partner page (the popup's opener) with the vault frame as its first child frame, as a browser indexes them. */
function partnerOpener(): { opener: RemoteWindow; vault: RemoteWindow } {
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  Object.assign(opener, { length: 1, 0: vault });
  return { opener, vault };
}
const stages = (w: RemoteWindow) => w.postMessage.mock.calls.filter((c) => (c[0] as { t?: string }).t === 'hana:auth-progress').map((c) => [(c[0] as { stage: string }).stage, c[1]]);
const api = (): AuthApi => ({ getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(), login: vi.fn() }) as never;

describe('vaultTargets', () => {
  it('the opener and its frames; none without an opener', () => {
    const { opener, vault } = partnerOpener();
    const win = new FakeWindow('/login/callback');
    win.opener = asWindow(opener);
    expect(vaultTargets(win)).toEqual([opener, vault]);
    win.opener = null;
    expect(vaultTargets(win)).toEqual([]);
  });

  it('the opener alone when its frames can’t be listed', () => {
    const opener = remoteWindow();
    Object.defineProperty(opener, 'length', {
      get() {
        throw new DOMException('Blocked', 'SecurityError');
      },
    });
    const win = new FakeWindow('/login/callback');
    win.opener = asWindow(opener);
    expect(vaultTargets(win)).toEqual([opener]);
  });
});

describe('/login/callback', () => {
  it('a plain login: `back` on arrival, then `relayed` before it closes itself; to the opener and its frames, with vaultOrigin as the target', async () => {
    const { opener, vault } = partnerOpener();
    const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const win = new FakeWindow('/login/callback', '', `#id_token=${jwt({ sub: SUBJECT, aud: CLIENT_ID })}&state=${state}`);
    win.opener = asWindow(opener);
    const acked = vaultAcks(vault, win);
    storeLoginEntry(win.sessionStorage, state, crypto.getRandomValues(new Uint8Array(32)), NOW);
    expect(await runCallbackPage({ win, api: api(), now: () => NOW, authOrigin: ENV.authOrigin, vaultOrigin: ENV.vaultOrigin })).toBe('relayed');
    expect(win.closed).toBe(true);
    expect(stages(vault)).toEqual([
      ['back', ENV.vaultOrigin],
      ['relayed', ENV.vaultOrigin],
    ]);
    // The partner page gets them too, with the vault's origin as the target: the browser drops them there.
    expect(stages(opener).map((s) => s[0])).toEqual(['back', 'relayed']);
    expect(acked).toEqual(['back', 'relayed']);
  });

  it('D400: it closes itself only once the vault acked `relayed`, or after SIGNAL_ACK_WAIT_MS without an ack', async () => {
    for (const acks of [true, false]) {
      const { opener, vault } = partnerOpener();
      const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
      const win = new FakeWindow('/login/callback', '', `#id_token=${jwt({ sub: SUBJECT, aud: CLIENT_ID })}&state=${state}`);
      win.opener = asWindow(opener);
      storeLoginEntry(win.sessionStorage, state, crypto.getRandomValues(new Uint8Array(32)), NOW);
      const timers: { fn: () => void; ms: number }[] = [];
      const signalTimers = { setTimeout: (fn: () => void, ms: number) => timers.push({ fn, ms }), clearTimeout: () => {} };
      const out = runCallbackPage({ win, api: api(), now: () => NOW, authOrigin: ENV.authOrigin, vaultOrigin: ENV.vaultOrigin, signalTimers });
      await vi.waitFor(() => expect(stages(vault).map((s) => s[0])).toEqual(['back', 'relayed']));
      // `relayed` went out; the window is still open, waiting for the vault.
      expect(win.closed).toBe(false);
      if (acks) {
        win.message({ v: 1, t: 'hana:auth-progress-ack', stage: 'back' }, ENV.vaultOrigin, vault);
        expect(win.closed).toBe(false);
        win.message({ v: 1, t: 'hana:auth-progress-ack', stage: 'relayed' }, ENV.vaultOrigin, vault);
      } else {
        expect(timers.map((t) => t.ms)).toEqual([SIGNAL_ACK_WAIT_MS]);
        timers[0]!.fn();
      }
      expect(await out).toBe('relayed');
      expect(win.closed, String(acks)).toBe(true);
    }
  });

  it('token_first’s access leg: `back`, then `google` before the silent ID request', async () => {
    const { opener, vault } = partnerOpener();
    const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const win = new FakeWindow('/login/callback', '', `#access_token=ya29.x&state=${state}`);
    win.opener = asWindow(opener);
    vaultAcks(vault, win);
    storeLoginEntry(win.sessionStorage, state, crypto.getRandomValues(new Uint8Array(32)), NOW, undefined, {
      followKey: crypto.getRandomValues(new Uint8Array(32)),
      clientId: CLIENT_ID,
      tokenFirst: true,
      nonce: 'N'.repeat(43),
    });
    await runCallbackPage({ win, api: api(), now: () => NOW, authOrigin: ENV.authOrigin, vaultOrigin: ENV.vaultOrigin, tokenInfo: async () => ({ ok: true, sub: SUBJECT }) });
    expect(win.location.assigned[0]).toMatch(/^https:\/\/accounts\.google\.com/u);
    expect(stages(vault).map((s) => s[0])).toEqual(['back', 'google']);
  });

  it('severed by an IdP’s COOP (no opener): no signal, the page goes on', async () => {
    const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const win = new FakeWindow('/login/callback', '', `#id_token=${jwt({ sub: SUBJECT })}&state=${state}`);
    storeLoginEntry(win.sessionStorage, state, crypto.getRandomValues(new Uint8Array(32)), NOW);
    expect(await runCallbackPage({ win, api: api(), now: () => NOW, authOrigin: ENV.authOrigin, vaultOrigin: ENV.vaultOrigin })).toBe('relayed');
  });
});

describe('/login', () => {
  it('a login that goes straight to Google (`method: google`, a Google-only app) says `google` first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no fetch');
      }),
    );
    for (const over of [{}, { methods: ['google', 'email'], method: 'google' }]) {
      resetDom();
      const { opener, vault } = partnerOpener();
      const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
      win.opener = asWindow(opener);
      vaultAcks(vault, win);
      const page = startLoginPage({ win, env: { ...ENV, emailIssuerUrl: 'https://issuer.test', emailIss: 'https://issuer.test/v1/email' }, now: () => NOW });
      const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
      const salt = crypto.getRandomValues(new Uint8Array(32));
      const base = { signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt };
      win.message(
        {
          v: 1,
          t: 'hana:auth-params',
          pk: PK,
          appName: 'App',
          parentOrigin: PARTNER,
          clientId: CLIENT_ID,
          mode: 'shared',
          ...base,
          nonce: sessionNonce(base),
          relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
          relayKey: crypto.getRandomValues(new Uint8Array(32)),
          ...over,
        },
        ENV.vaultOrigin,
        vault,
      );
      expect((await page.done).stage, JSON.stringify(over)).toBe('redirecting');
      expect(stages(vault), JSON.stringify(over)).toEqual([['google', ENV.vaultOrigin]]);
      page.stop();
    }
  });
});
