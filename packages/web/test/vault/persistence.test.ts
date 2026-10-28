// Key persistence (docs/batch-b-spec.md "Key persistence": record, share creation, unlock, logout, lost device,
// tabs; Tests → Web unit → Persistence).
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { toHex } from '@hana-id/core';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { APP_ID, Browser, ENV, type Google, HOUR, PARTNER, SCOPE, START_MS, type Tab, apiError, google, login, makeConfig, openTab, readyTab, sleepReal } from './harness.ts';

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

async function tab(browser: Browser, o: Parameters<typeof readyTab>[1] = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, ...o });
  tabs.push(t);
  return t;
}

const KEY = recordKey(ENV.signer, APP_ID, SCOPE, 0);

async function stored(browser: Browser, key = KEY): Promise<Record<string, unknown> | undefined> {
  return (await (await openRecordStore(browser.idb)).get(key)) as Record<string, unknown> | undefined;
}

async function put(browser: Browser, record: Record<string, unknown>, key = KEY): Promise<void> {
  await (await openRecordStore(browser.idb)).put(key, record as never);
}

/** A browser whose first tab logged in ('session' mode); returns the addresses. */
async function loggedIn(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}): Promise<{ browser: Browser; first: Tab; addresses: { stellar: string; evm: string } }> {
  const first = await tab(browser, o);
  const { reply } = await login(first, g);
  return { browser, first, addresses: (reply.result as { addresses: { stellar: string; evm: string } }).addresses };
}

const prkOf = (t: Tab): Uint8Array | undefined => (t.vault as unknown as { session: { prk: Uint8Array } | null }).session?.prk;

describe('the record', () => {
  it('is written after login under <signer>|<appId>|<scopeId>|<keyIndex>, holding PRK only under K_s', async () => {
    const { browser, first, addresses } = await loggedIn();
    const r = (await stored(browser))!;
    expect(r).toMatchObject({ v: 1, signer: ENV.signer, appId: APP_ID, scopeId: SCOPE, keyIndex: 0, derivationVersion: 1, parentOrigin: PARTNER, counter: 0, addresses, expiresAtMs: START_MS + 12 * HOUR });
    expect(r.path).toMatch(new RegExp(`^${SCOPE}#google#\\d+#0$`, 'u'));
    expect((r.ct as Uint8Array).length).toBe(32 + 16);
    expect((r.sessionKeyPair as CryptoKeyPair).privateKey.extractable).toBe(false);
    // PRK itself is not in the record.
    const prk = prkOf(first)!;
    const values = Object.values(r).filter((v): v is Uint8Array => v instanceof Uint8Array);
    expect(values.some((v) => toHex(v).includes(toHex(prk)))).toBe(false);
    // The share was created with the create-share message, and the API saw the session used up.
    expect(browser.backend.count('/v1/vault/shares')).toBe(1);
  });

  it('a reload (new tab) unlocks with one API call: zero /v1/derive, no /v1/login, no chain RPC', async () => {
    const { browser, addresses } = await loggedIn();
    const rpcBefore = browser.backend.rpcCalls.length;
    const loginsBefore = browser.backend.count('/v1/login');
    const second = await tab(browser);
    expect(await second.ready()).toEqual({ status: 'logged_in', addresses, expiresAtMs: START_MS + 12 * HOUR, persistence: 'session' });
    expect(browser.backend.count('/v1/vault/unlock')).toBe(1);
    expect(browser.backend.count('/v1/derive')).toBe(0);
    expect(browser.backend.count('/v1/login')).toBe(loginsBefore);
    expect(browser.backend.rpcCalls.length).toBe(rpcBefore);
    // The unlock is signed over counter n + 1 = 1, and the counter is written back before the lock is released.
    expect((browser.backend.calls.find((c) => c.path === '/v1/vault/unlock')!.body as { counter: number }).counter).toBe(1);
    expect((await stored(browser))!.counter).toBe(1);
    // It broadcast the new counter (no key material).
    expect(browser.bus.sent.find((m) => (m.data as { t: string }).t === 'counter')).toBeDefined();
  });

  it('a reload in "none" mode is a full login (nothing persisted)', async () => {
    const browser = new Browser();
    await loggedIn(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
    expect(await stored(browser)).toBeUndefined();
    const second = await tab(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
    expect((await second.ready()).status).toBe('logged_out');
  });

  it('is not used from another parent origin (and not deleted)', async () => {
    const { browser } = await loggedIn(new Browser(), { config: makeConfig({ origins: [PARTNER, 'https://other.test'] }) });
    const t = openTab(browser, { googleJwk: g.jwk, config: makeConfig({ origins: [PARTNER, 'https://other.test'] }) });
    tabs.push(t);
    t.hello({ origin: 'https://other.test' });
    expect((await t.ready()).status).toBe('logged_out');
    expect(await stored(browser)).toBeDefined();
    expect(browser.backend.count('/v1/vault/unlock')).toBe(0);
  });

  describe('tamper', () => {
    const fields: [string, (r: Record<string, unknown>) => void][] = [
      ['appId', (r) => (r.appId = 'app_2')],
      ['path', (r) => (r.path = `${SCOPE}#google#999#0`)],
      ['sessionPk', (r) => ((r.sessionPk as Uint8Array)[0]! ^= 1)],
      ['expiresAtMs', (r) => (r.expiresAtMs = (r.expiresAtMs as number) + HOUR)],
      ['ct', (r) => ((r.ct as Uint8Array)[0]! ^= 1)],
      ['iv', (r) => ((r.iv as Uint8Array)[0]! ^= 1)],
      ['signer', (r) => (r.signer = 'evil-signer.testnet')],
      ['derivationVersion', (r) => (r.derivationVersion = 2)],
      ['ckdKeyHash', (r) => ((r.ckdKeyHash as Uint8Array)[0]! ^= 1)],
      ['scopeId', (r) => (r.scopeId = 'other')],
      ['an expired record', (r) => (r.expiresAtMs = START_MS - 1)],
      ['addresses (not in the AAD: the recomputed addresses differ)', (r) => (r.addresses = { stellar: 'G'.padEnd(56, 'A'), evm: '0x0000000000000000000000000000000000000001' })],
      ['a malformed shape', (r) => (r.counter = 'x')],
    ];
    it.each(fields)('%s: refused and the record deleted, logged out', async (_, change) => {
      const { browser } = await loggedIn();
      const r = (await stored(browser))!;
      change(r);
      await put(browser, r);
      const t = await tab(browser);
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
      expect(browser.backend.count('/v1/derive')).toBe(0);
    });

    it('parentOrigin: a record edited to another allowed origin fails its AAD there and is deleted', async () => {
      const config = makeConfig({ origins: [PARTNER, 'https://other.test'] });
      const { browser } = await loggedIn(new Browser(), { config });
      const r = (await stored(browser))!;
      r.parentOrigin = 'https://other.test';
      await put(browser, r);
      const t = openTab(browser, { googleJwk: g.jwk, config });
      tabs.push(t);
      t.hello({ origin: 'https://other.test' });
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
    });

    it('a bundle with another pinned CKD key (or derivation version) drops the record', async () => {
      const { browser } = await loggedIn();
      const otherKey = `bls12381g2:${base58.encode(bls.G2.ProjectivePoint.BASE.multiply(7n).toRawBytes(true))}`;
      const t = await tab(browser, { env: { ...ENV, ckdNetworkKey: otherKey } });
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
      expect(browser.backend.count('/v1/vault/unlock')).toBe(0);
    });
  });

  describe('unlock errors', () => {
    it('404 unknown_share deletes the record (logged out)', async () => {
      const { browser } = await loggedIn();
      browser.backend.shares.clear();
      const t = await tab(browser);
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
    });

    it('410 deletes the record and broadcasts revoked; the next login is a full login, never a derive', async () => {
      const { browser, first } = await loggedIn();
      for (const s of browser.backend.shares.values()) s.revoked = true;
      const t = await tab(browser);
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
      expect(browser.bus.sent.some((m) => (m.data as { t: string }).t === 'revoked')).toBe(true);
      // The first tab zeroes PRK and disconnects.
      expect(await first.waitEvent('disconnect')).toEqual({ code: 4900 });
      expect(prkOf(first)).toBeUndefined();
      const derives = browser.backend.count('/v1/derive');
      const { reply } = await login(t, g);
      expect(reply.result).toHaveProperty('addresses');
      expect(browser.backend.count('/v1/derive')).toBe(derives);
    });

    it('409 bad_counter retries once with expected, then succeeds', async () => {
      const { browser, addresses } = await loggedIn();
      // Another device advanced the share's counter (or a lost write): the API wants 3.
      for (const s of browser.backend.shares.values()) s.counter = 2;
      const t = await tab(browser);
      expect(await t.ready()).toMatchObject({ status: 'logged_in', addresses });
      expect(browser.backend.calls.filter((c) => c.path === '/v1/vault/unlock').map((c) => (c.body as { counter: number }).counter)).toEqual([1, 3]);
      expect((await stored(browser))!.counter).toBe(3);
    });

    it('a second 409 deletes the record', async () => {
      const { browser } = await loggedIn();
      browser.backend.overrides.set('/v1/vault/unlock', () => apiError(409, 'bad_counter', { expected: 7 }));
      const t = await tab(browser);
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeUndefined();
    });

    it('a network failure keeps the record (a later reload can still unlock)', async () => {
      const { browser } = await loggedIn();
      browser.backend.overrides.set('/v1/vault/unlock', () => {
        throw new TypeError('Failed to fetch');
      });
      const t = await tab(browser);
      expect((await t.ready()).status).toBe('logged_out');
      expect(await stored(browser)).toBeDefined();
    });
  });

  it('storage throwing falls back to "none": login uses max_uses 2, reports storage_unavailable', async () => {
    const browser = new Browser();
    browser.storeFails = true;
    const t = await tab(browser);
    const { reply, run } = await login(t, g);
    expect(run.params.maxUses).toBe(2);
    expect(reply.result).toMatchObject({ persistence: 'none' });
    expect(browser.backend.count('/v1/vault/shares')).toBe(0);
  });

  it('share creation failing falls back to "none" with storage_unavailable', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/vault/shares', () => apiError(409, 'session_not_spent'));
    const t = await tab(browser);
    const { reply } = await login(t, g);
    expect(reply.result).toMatchObject({ persistence: 'none', warning: 'storage_unavailable' });
    expect(await stored(browser)).toBeUndefined();
  });
});

describe('a second login in the same tab', () => {
  it('replaces the session and record, and revokes the old share', async () => {
    const { browser, first } = await loggedIn();
    const oldPrk = prkOf(first)!;
    const oldShare = [...browser.backend.shares.values()][0]!;
    const { reply } = await login(first, g, { sub: '220000000000000000001' });
    expect(reply.result).toHaveProperty('addresses');
    expect(oldPrk.every((b) => b === 0)).toBe(true);
    for (let i = 0; i < 50 && !oldShare.revoked; i++) await sleepReal(5);
    expect(oldShare.revoked).toBe(true);
    const r = (await stored(browser))!;
    expect(r.path).toBe(`${SCOPE}#google#220000000000000000001#0`);
    expect(browser.backend.shares.size).toBe(2);
  });
});

describe('two apps on one scope and one site', () => {
  it('see only their own record, lock and channel; a logout in one does not touch the other', async () => {
    const browser = new Browser();
    const configB = makeConfig({ appId: 'app_2', publishableKey: 'pk_test_2222222222222222222222' });
    const a = await tab(browser);
    await login(a, g);
    // App B's fake share endpoints sign for app_1 only; give app B a "none" persistence so its login needs no share.
    const b = await tab(browser, { config: { ...configB, settings: { ...configB.settings, persistence: 'none' } } });
    expect((await b.ready()).status).toBe('logged_out');
    expect(await stored(browser, recordKey(ENV.signer, 'app_2', SCOPE, 0))).toBeUndefined();
    await login(b, g);
    // A logout in app B broadcasts on hana-vault:app_2 only.
    await b.request('hana_logout');
    expect(browser.bus.sent.filter((m) => (m.data as { t: string }).t === 'logout').map((m) => m.name)).toEqual(['hana-vault:app_2']);
    await sleepReal(20);
    expect((await a.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
    expect(await stored(browser)).toBeDefined();
  });
});

describe('tabs', () => {
  it('a second tab unlocks itself; each unlock advances the counter under the per-app lock', async () => {
    const { browser } = await loggedIn();
    const t2 = await tab(browser);
    const t3 = await tab(browser);
    expect((await t2.ready()).status).toBe('logged_in');
    expect((await t3.ready()).status).toBe('logged_in');
    expect(browser.backend.calls.filter((c) => c.path === '/v1/vault/unlock').map((c) => (c.body as { counter: number }).counter)).toEqual([1, 2]);
  });

  it('concurrent unlocks are serialised by the lock (no counter collision)', async () => {
    const { browser } = await loggedIn();
    const a = openTab(browser, { googleJwk: g.jwk });
    const b = openTab(browser, { googleJwk: g.jwk });
    tabs.push(a, b);
    a.hello();
    b.hello();
    expect((await a.ready()).status).toBe('logged_in');
    expect((await b.ready()).status).toBe('logged_in');
    expect(browser.backend.calls.filter((c) => c.path === '/v1/vault/unlock').map((c) => (c.body as { counter: number }).counter).sort()).toEqual([1, 2]);
  });

  it('logout revokes the share, wipes the record, zeroes PRK and broadcasts so other tabs disconnect', async () => {
    const { browser, first } = await loggedIn();
    const second = await tab(browser);
    const prk1 = prkOf(first)!;
    const prk2 = prkOf(second)!;
    expect((await first.request('hana_logout')).result).toBeNull();
    expect(prk1.every((b) => b === 0)).toBe(true);
    expect(await stored(browser)).toBeUndefined();
    const revoke = browser.backend.calls.find((c) => c.path === '/v1/vault/revoke')!;
    expect((revoke.body as { counter: number }).counter).toBe(2);
    expect([...browser.backend.shares.values()][0]!.revoked).toBe(true);
    expect(await first.waitEvent('accountsChanged', 1)).toEqual({ addresses: null });
    expect(await second.waitEvent('disconnect')).toEqual({ code: 4900 });
    expect(prk2.every((b) => b === 0)).toBe(true);
    expect((await second.request('hana_status')).result).toMatchObject({ status: 'logged_out' });
    // No chain transaction for a logout.
    expect(browser.backend.calls.filter((c) => c.path === '/v1/sessions/revoke')).toHaveLength(0);
  });

  it('logout still ends the session locally when the API is down', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.overrides.set('/v1/vault/revoke', () => apiError(503, 'config_unavailable'));
    await first.request('hana_logout');
    expect(await stored(browser)).toBeUndefined();
    expect((await first.request('hana_status')).result).toMatchObject({ status: 'logged_out' });
  });
});

describe('expiry', () => {
  it('zeroes PRK at expiresAtMs, deletes the record and emits sessionExpired', async () => {
    const { browser, first } = await loggedIn();
    const prk = prkOf(first)!;
    browser.timers.advance(12 * HOUR);
    expect(await first.waitEvent('sessionExpired')).toBeNull();
    expect(prk.every((b) => b === 0)).toBe(true);
    await sleepReal(30);
    expect(await stored(browser)).toBeUndefined();
  });
});

describe('lost device', () => {
  it('revoke-other-devices works within 5 min of a fresh login and revokes the other shares', async () => {
    const browser = new Browser();
    // An older device's share.
    const old = await loggedIn(browser);
    await old.first.request('hana_logout');
    for (const s of browser.backend.shares.values()) s.revoked = false;
    const t = await tab(browser);
    await login(t, g);
    expect((await t.request('hana_revokeOtherDevices')).result).toEqual({ revoked: 1 });
  });

  it('is refused after 5 min, and after a reload unlock (not a fresh login)', async () => {
    const { browser, first } = await loggedIn();
    const reloaded = await tab(browser);
    expect((await reloaded.request('hana_revokeOtherDevices')).error).toMatchObject({ code: 4100, data: { reason: 'share_not_fresh' } });
    browser.timers.advance(5 * 60_000);
    expect((await first.request('hana_revokeOtherDevices')).error).toMatchObject({ code: 4100, data: { reason: 'share_not_fresh' } });
    expect(browser.backend.count('/v1/vault/revoke-all')).toBe(0);
  });

  it('is refused in "none" mode', async () => {
    const t = await tab(new Browser(), { config: makeConfig({ settings: { persistence: 'none' } }) });
    await login(t, g);
    expect((await t.request('hana_revokeOtherDevices')).error).toMatchObject({ code: 4100, data: { reason: 'persistence_off' } });
  });
});
