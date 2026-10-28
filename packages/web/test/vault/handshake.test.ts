// The partner ↔ vault handshake and the port (docs/batch-b-spec.md "Partner ↔ vault handshake", "Envelope", "Port
// methods"; Tests → Web unit → Vault).
import { afterEach, describe, expect, it } from 'vitest';
import { Browser, ENV, FakeWindow, PARTNER, type Tab, makeConfig, openTab, sleepReal } from './harness.ts';

const tabs: Tab[] = [];
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

function tab(o: Parameters<typeof openTab>[1] = {}, browser = new Browser()): Tab {
  const t = openTab(browser, o);
  tabs.push(t);
  return t;
}

const settle = () => sleepReal(40);

describe('handshake', () => {
  it('accepts a hello from window.parent on an allowed origin with one port, and replies ready on that port', async () => {
    const t = tab();
    t.hello();
    expect(await t.ready()).toEqual({ status: 'logged_out', persistence: 'session' });
  });

  it.each([
    ['another source', { source: new FakeWindow() }],
    ['an unlisted origin', { origin: 'https://evil.test' }],
    ['a path-like origin', { origin: `${PARTNER}/` }],
    ['no port', { ports: [] }],
  ])('ignores a hello from %s', async (_, h) => {
    const t = tab();
    t.hello(h as never);
    await settle();
    expect(t.events).toHaveLength(0);
    // The real hello still works afterwards.
    t.hello();
    await t.ready();
  });

  it('ignores a hello with two ports, a wrong version or extra fields', async () => {
    const t = tab();
    const extra = new MessageChannel();
    t.dispatch({ data: { v: 1, t: 'hana:hello', sdk: '0.0.0' }, origin: PARTNER, source: t.parent, ports: [extra.port1, extra.port2] });
    t.dispatch({ data: { v: 2, t: 'hana:hello', sdk: '0.0.0' }, origin: PARTNER, source: t.parent, ports: [extra.port1] });
    t.dispatch({ data: { v: 1, t: 'hana:hello', sdk: '0.0.0', prk: new Uint8Array(32) }, origin: PARTNER, source: t.parent, ports: [extra.port1] });
    await settle();
    expect(t.events).toHaveLength(0);
    extra.port1.close();
    extra.port2.close();
  });

  it('checks location.ancestorOrigins[0] where the browser provides it', async () => {
    const t = tab({ ancestorOrigin: 'https://other.test', config: makeConfig({ origins: [PARTNER, 'https://other.test'] }) });
    t.hello();
    await settle();
    expect(t.events).toHaveLength(0);
    t.hello({ origin: 'https://other.test' });
    expect((await t.ready()).status).toBe('logged_out');
  });

  it('accepts exactly one hello: a second one (another port) gets nothing, and the first port stays pinned', async () => {
    const t = tab();
    t.hello();
    await t.ready();
    const second = new MessageChannel();
    const got: unknown[] = [];
    second.port1.onmessage = (m) => got.push(m.data);
    t.hello({ ports: [second.port2] });
    second.port1.postMessage({ v: 1, id: 'x1', method: 'hana_status' });
    await settle();
    expect(got).toHaveLength(0);
    expect((await t.request('hana_status')).result).toEqual({ status: 'logged_out', persistence: 'session' });
    second.port1.close();
  });

  it('drops every window message from the parent after the handshake', async () => {
    const t = tab();
    t.hello();
    await t.ready();
    // The parent posing as an approval or login popup gets nothing.
    t.dispatch({ data: { v: 1, t: 'hana:auth-hello' }, origin: ENV.authOrigin, source: t.parent });
    t.dispatch({ data: { v: 1, t: 'hana:approve-hello' }, origin: ENV.authOrigin, source: t.parent });
    await settle();
    expect(t.parent.posted).toHaveLength(0);
  });

  describe('loopback parents (dev envs, pk_test_ only)', () => {
    const local = 'http://localhost:5173';
    it('accepts http://localhost:<port> through the wildcard for pk_test_ in a dev env', async () => {
      const t = tab({ config: makeConfig({ origins: ['http://localhost:*'] }) });
      t.hello({ origin: local });
      expect((await t.ready()).status).toBe('logged_out');
    });

    it('refuses it for pk_live_, and outside dev envs', async () => {
      const live = tab({ config: makeConfig({ origins: ['http://localhost:*', local], publishableKey: 'pk_live_1111111111111111111111' }) });
      live.hello({ origin: local });
      const prod = tab({ env: { ...ENV, name: 'prod', devEnv: false }, config: makeConfig({ origins: [local] }) });
      prod.hello({ origin: local });
      await settle();
      expect(live.events).toHaveLength(0);
      expect(prod.events).toHaveLength(0);
    });
  });

  it('ready reports storage_unavailable and persistence "none" when IndexedDB throws', async () => {
    const browser = new Browser();
    browser.storeFails = true;
    const t = tab({}, browser);
    t.hello();
    expect(await t.ready()).toEqual({ status: 'logged_out', persistence: 'none', warning: 'storage_unavailable' });
  });

  it('fetches GET /v1/app in the background after ready, with the pinned parent origin', async () => {
    const t = tab();
    t.hello();
    await t.ready();
    await settle();
    const call = t.browser.backend.calls.find((c) => c.path === '/v1/app')!;
    expect(call.headers).toMatchObject({ 'x-hana-key': makeConfig().publishableKey, 'x-hana-parent-origin': PARTNER });
  });
});

describe('the port', () => {
  async function ready(): Promise<Tab> {
    const t = tab();
    t.hello();
    await t.ready();
    return t;
  }

  it('answers an unknown method with 4200 and drops malformed requests silently', async () => {
    const t = await ready();
    expect((await t.request('eth_sign', ['0x00', '0x00'])).error?.code).toBe(4200);
    t.port.postMessage({ v: 1, id: 'bad1', method: 'hana_status', params: { x: 1 } });
    t.port.postMessage({ v: 2, id: 'bad2', method: 'hana_status' });
    t.port.postMessage({ v: 1, method: 'hana_status' });
    t.port.postMessage({ v: 1, id: 'bad3', method: 'hana_export', params: { chain: 'solana' } });
    await settle();
    expect(t.replies.filter((r) => String(r.id).startsWith('bad'))).toHaveLength(0);
  });

  it('drops a request whose id was already used on this port', async () => {
    const t = await ready();
    t.port.postMessage({ v: 1, id: 'dup', method: 'hana_status' });
    t.port.postMessage({ v: 1, id: 'dup', method: 'hana_status' });
    await settle();
    expect(t.replies.filter((r) => r.id === 'dup')).toHaveLength(1);
  });

  it('logged out: addresses and signing are 4100, eth_accounts is []', async () => {
    const t = await ready();
    expect((await t.request('stellar_getAddress')).error?.code).toBe(4100);
    expect((await t.request('eth_accounts')).result).toEqual([]);
    expect((await t.request('stellar_signMessage', { message: 'hi' })).error?.code).toBe(4100);
    expect((await t.request('hana_export', { chain: 'evm' })).error?.code).toBe(4100);
    expect((await t.request('hana_revokeOtherDevices')).error?.code).toBe(4100);
    expect((await t.request('hana_requestAutoApprove')).error?.code).toBe(4100);
    expect((await t.request('hana_autoApproveStatus')).result).toBeNull();
    expect((await t.request('hana_logout')).result).toBeNull();
  });
});
