// Key export, vault side (docs/batch-b-spec.md "Key export" steps 1–2): the vault only opens the export window from
// its launcher and hands it public values; the export window logs in again itself. Plus the idle-slide touch
// (docs/batch-b-spec.md "Unlock", "Idle slide while active").
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CHAIN, evmTx } from './chains.ts';
import { Browser, ENV, FakeWindow, type Google, HOUR, PARTNER, SCOPE, type Tab, answer, google, login, makeConfig, openApproval, readyTab, sleepReal, waitLauncher } from './harness.ts';
import { consentDigest } from '@hana-id/core';
import { functionSelector } from '@hana-id/core/decode';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function session(o: Parameters<typeof readyTab>[1] = {}, browser = new Browser()) {
  const t = await readyTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  const { reply } = await login(t, g);
  return { t, addresses: (reply.result as { addresses: { stellar: string; evm: string } }).addresses };
}

/** Event-driven (the launcher view and its `ui` event on the port), so a loaded machine only slows it down. */
const waitLabel = (t: Tab, label: string | null): Promise<void> => waitLauncher(t, label);

describe('export (vault side)', () => {
  it('shows the launcher; its click opens a top-level /export window with a random name; the hello gets public values only', async () => {
    const { t, addresses } = await session();
    const reply = t.request('hana_export', { chain: 'stellar' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.launcher.click();
    const w = t.opened.at(-1)!;
    expect(w.url).toBe(`${ENV.authOrigin}/export`);
    expect(w.name).toMatch(/^hana-export-[0-9a-f]{32}$/u);
    // No `popup` feature: a top-level window.
    expect(w.features).toBe('');
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    const ctx = await w.next('hana:export-context');
    expect(ctx).toEqual({
      v: 1,
      t: 'hana:export-context',
      pk: makeConfig().publishableKey,
      appName: 'Partner',
      parentOrigin: PARTNER,
      scopeId: SCOPE,
      signer: ENV.signer,
      keyIndex: 0,
      chain: 'stellar',
      address: addresses.stellar,
      sessionExpiresAtMs: expect.any(Number),
    });
    expect(ctx.sessionExpiresAtMs).toBeGreaterThan(t.browser.timers.now);
    expect(w.posted[0]!.targetOrigin).toBe(ENV.authOrigin);
    expect((await reply).result).toBeNull();
    // Busy until the export window closes.
    expect((await t.request('hana_export', { chain: 'evm' })).error?.code).toBe('busy');
    w.closed = true;
    await sleepReal(30);
    const again = t.request('hana_export', { chain: 'evm' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.launcher.click();
    const w2 = t.opened.at(-1)!;
    expect(w2.name).not.toBe(w.name);
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w2 });
    expect((await w2.next('hana:export-context')).address).toBe(addresses.evm);
    expect((await again).result).toBeNull();
  });

  it('a hello after the session ended (expiry timer not yet run) gets no context; the export fails 4900', async () => {
    const { t } = await session();
    const reply = t.request('hana_export', { chain: 'evm' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.launcher.click();
    const w = t.opened.at(-1)!;
    // The session's end passes while the export window loads; no timer runs (a throttled tab or a sleeping device).
    t.browser.timers.now += 12 * HOUR;
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    expect((await reply).error?.code).toBe(4900);
    expect(w.posted).toEqual([]);
    expect(w.closed).toBe(true);
    expect(await t.waitEvent('sessionExpired')).toBeNull();
  });

  it('answers only the window it opened, from authOrigin, once', async () => {
    const { t } = await session();
    const reply = t.request('hana_export', { chain: 'evm' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.launcher.click();
    const w = t.opened.at(-1)!;
    const foreign = new FakeWindow();
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: foreign });
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: 'https://evil.test', source: w });
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.vaultOrigin, source: w });
    await sleepReal(20);
    expect(foreign.posted).toHaveLength(0);
    expect(w.posted).toHaveLength(0);
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
    await sleepReal(20);
    expect(w.posted).toHaveLength(1);
    await reply;
  });

  it('a window closed before its hello gives 4001; no click within 5 min gives 4001', async () => {
    const { t } = await session();
    const a = t.request('hana_export', { chain: 'evm' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.launcher.click();
    t.opened.at(-1)!.closed = true;
    expect((await a).error?.code).toBe(4001);
    const b = t.request('hana_export', { chain: 'evm' });
    await waitLabel(t, 'Export key in Journear Passport');
    t.browser.timers.advance(5 * 60_000);
    expect((await b).error?.code).toBe(4001);
    await waitLabel(t, null);
  });

  describe('the session end reaches a window that has its context (AUTH-1, D111)', () => {
    async function running() {
      const s = await session();
      const reply = s.t.request('hana_export', { chain: 'stellar' });
      await waitLabel(s.t, 'Export key in Journear Passport');
      s.t.launcher.click();
      const w = s.t.opened.at(-1)!;
      s.t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: w });
      await w.next('hana:export-context');
      expect((await reply).result).toBeNull();
      return { ...s, w };
    }
    const ends = (w: FakeWindow) => w.posted.filter((p) => p.message.t === 'hana:export-end');

    it('logout sends hana:export-end to authOrigin and frees the job', async () => {
      const { t, w } = await running();
      expect(ends(w)).toHaveLength(0);
      await t.request('hana_logout');
      const end = await w.next('hana:export-end');
      expect(end).toEqual({ v: 1, t: 'hana:export-end' });
      expect(ends(w)[0]!.targetOrigin).toBe(ENV.authOrigin);
      // Left open so it can say why; the page erases the key on the message.
      expect(w.closed).toBe(false);
    });

    it('the session expiry sends it too', async () => {
      const { t, w } = await running();
      t.browser.timers.advance(24 * HOUR);
      await w.next('hana:export-end');
      expect(await t.waitEvent('sessionExpired')).toBeNull();
    });

    it('the job limit (15 min) sends it, then a new export can start', async () => {
      const { t, w } = await running();
      t.browser.timers.advance(15 * 60_000 + 2_000);
      await w.next('hana:export-end');
      const again = t.request('hana_export', { chain: 'evm' });
      await waitLabel(t, 'Export key in Journear Passport');
      t.launcher.click();
      expect(t.opened.at(-1)).not.toBe(w);
      t.dispatch({ data: { v: 1, t: 'hana:export-hello' }, origin: ENV.authOrigin, source: t.opened.at(-1)! });
      expect((await again).result).toBeNull();
    });

    it('a window the user closed gets nothing', async () => {
      const { t, w } = await running();
      w.closed = true;
      t.browser.timers.advance(2_000);
      await sleepReal(20);
      await t.request('hana_logout');
      await sleepReal(20);
      expect(ends(w)).toHaveLength(0);
    });
  });

  it('is 4100 when logged out', async () => {
    const t = await readyTab(new Browser(), { googleJwk: g.jwk });
    tabs.push(t);
    expect((await t.request('hana_export', { chain: 'stellar' })).error?.code).toBe(4100);
  });
});

describe('touch (idle slide)', () => {
  const touches = (t: Tab) => t.browser.backend.calls.filter((c) => c.path === '/v1/vault/touch');

  async function approveOne(t: Tab, nonce: string): Promise<void> {
    const reply = t.request('eth_signTransaction', { tx: evmTx({ nonce }) });
    await waitLabel(t, 'Review in Journear Passport');
    const popup = openApproval(t);
    answer(t, popup, await popup.next('hana:approve-request'), true);
    expect((await reply).result).toMatch(/^0x02/u);
    popup.closed = true;
    await sleepReal(10);
  }

  it('is sent at most once per 10 min, only after an approved signature', async () => {
    const { t } = await session();
    await approveOne(t, '0x1');
    expect(touches(t)).toHaveLength(0);
    t.browser.timers.advance(11 * 60_000);
    // Time alone sends nothing.
    await sleepReal(20);
    expect(touches(t)).toHaveLength(0);
    await approveOne(t, '0x2');
    for (let i = 0; i < 50 && touches(t).length === 0; i++) await sleepReal(5);
    expect(touches(t)).toHaveLength(1);
    expect((touches(t)[0]!.body as { counter: number }).counter).toBe(1);
    await approveOne(t, '0x3');
    await sleepReal(20);
    expect(touches(t)).toHaveLength(1);
  });

  it('is not sent in "none" mode, and not for an auto-approved signature', async () => {
    const { t } = await session({ config: makeConfig({ settings: { persistence: 'none' } }) });
    t.browser.timers.advance(11 * 60_000);
    await approveOne(t, '0x1');
    await sleepReal(20);
    expect(touches(t)).toHaveLength(0);

    const policy = {
      v: 1,
      label: 'Deposits',
      maxConsentMs: 6 * HOUR,
      limits: { perDayCount: 5 },
      evm: { chains: [{ chainId: CHAIN, maxValueWei: '100000', maxValueWeiPerDay: '500000', maxFeeWei: '100000', contracts: [{ address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD', name: 'Vault', selectors: [{ selector: functionSelector('deposit(uint256)'), signature: 'deposit(uint256)' }] }] }] },
    };
    const s2 = await session({ config: makeConfig({ settings: { autoApprovePolicy: policy } }) });
    const grant = s2.t.request('hana_requestAutoApprove');
    await waitLabel(s2.t, 'Review in Journear Passport');
    const popup = openApproval(s2.t);
    const m = await popup.next('hana:consent-request');
    s2.t.dispatch({ data: { v: 1, t: 'hana:consent-result', id: m.id, allowed: true, digest: consentDigest({ id: m.id as string, policyId: m.policyId as string, parentOrigin: PARTNER, expiresAtMs: m.expiresAtMs as number }) }, origin: ENV.authOrigin, source: popup });
    await grant;
    s2.t.browser.timers.advance(11 * 60_000);
    expect((await s2.t.request('eth_signTransaction', { tx: evmTx() })).result).toMatch(/^0x02/u);
    await sleepReal(20);
    expect(touches(s2.t)).toHaveLength(0);
  });
});
