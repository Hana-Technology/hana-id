// Key persistence (docs/batch-b-spec.md "Key persistence": record, share creation, unlock, logout, lost device,
// tabs; Tests → Web unit → Persistence).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { bls12_381 as bls } from '@noble/curves/bls12-381';
import { base58 } from '@scure/base';
import { toHex } from '@hana-id/core';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { bytesEqual } from '@hana-id/core';
import type { Channel } from '../../src/vault/runtime.ts';
import { TOUCH_EVERY_MS } from '../../src/vault/vault.ts';
import { OTHER as OTHER_STELLAR, PASSPHRASE } from './chains.ts';
import {
  APP_ID,
  Browser,
  ENV,
  type Google,
  HOUR,
  PARTNER,
  SCOPE,
  START_MS,
  type Tab,
  answer,
  apiError,
  google,
  deliverToken,
  login,
  makeConfig,
  openApproval,
  openTab,
  persisted,
  popupHello,
  readyTab,
  sleepReal,
} from './harness.ts';

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
const shareIdOf = (t: Tab): Uint8Array | undefined => (t.vault as unknown as { session: { share: { shareId: Uint8Array } | null } | null }).session?.share?.shareId;
const statusOf = async (t: Tab): Promise<string> => ((await t.request('hana_status')).result as { status: string }).status;
const liveShares = (b: Browser) => [...b.backend.shares.values()].filter((s) => !s.revoked);

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await cond()) return;
    await sleepReal(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A tab that posts on the app's channel but never hears it (a tab that missed every broadcast). */
const deaf = (browser: Browser) => ({
  channel: (name: string): Channel => {
    const c = browser.bus.channel(name);
    return { postMessage: (m) => c.postMessage(m), onMessage: () => undefined, close: () => c.close() };
  },
});

/** An approved stellar_signMessage in `t` (the launcher opens the popup). */
async function approvedSign(t: Tab): Promise<void> {
  const reply = t.request('stellar_signMessage', { message: 'hello' });
  await until(() => t.launcher.label === 'Review in Hana', 'the launcher');
  const popup = openApproval(t);
  answer(t, popup, await popup.next('hana:approve-request'), true);
  expect((await reply).error).toBeUndefined();
}

describe('the record', () => {
  it('is written after login under <signer>|<appId>|<scopeId>|<keyIndex>, holding PRK only under K_s', async () => {
    const { browser, first, addresses } = await loggedIn();
    const r = (await stored(browser))!;
    // Format 2: with the identity token's wallet proofs of the same addresses (not secret).
    expect(r).toMatchObject({ v: 2, walletProofs: { stellar: { address: addresses.stellar }, evm: { address: addresses.evm } }, signer: ENV.signer, appId: APP_ID, scopeId: SCOPE, keyIndex: 0, derivationVersion: 1, parentOrigin: PARTNER, counter: 0, addresses, expiresAtMs: START_MS + 12 * HOUR });
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
    expect(await second.ready()).toEqual({ status: 'logged_in', addresses, expiresAtMs: START_MS + 12 * HOUR, persistence: 'session', timings: expect.any(Object) });
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
    expect(reply.result).toMatchObject({ persistence: 'none', warning: 'storage_unavailable' });
    expect(browser.backend.count('/v1/vault/shares')).toBe(0);
  });

  it('share creation failing twice: the login still succeeds, then persistence turns "none"', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/vault/shares', () => apiError(409, 'session_not_spent'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = await tab(browser);
      const { reply } = await login(t, g);
      // Reported before the share was tried: the mode the app asked for, no warning.
      expect(reply.result).toMatchObject({ persistence: 'session' });
      expect(reply.result).not.toHaveProperty('warning');
      expect(await stored(browser)).toBeUndefined();
      // Tried once more, then given up: status says the next reload needs a full login.
      expect(browser.backend.count('/v1/vault/shares')).toBe(2);
      expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in', persistence: 'none' });
      // The partner client is told too (hana.persistence, 'persistenceChanged').
      expect(await t.waitEvent('persistenceChanged')).toEqual({ persistence: 'none' });
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0]![0])).toContain('share:session_not_spent');
    } finally {
      warn.mockRestore();
    }
  });
});

describe('the share and record after the login is reported (D79)', () => {
  /** A gate for POST /v1/vault/shares: calls wait until `open()` (then reach the fake API as usual). */
  function gateShares(browser: Browser, only?: (n: number) => boolean) {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => (open = resolve));
    let n = 0;
    browser.backend.overrides.set('/v1/vault/shares', async () => {
      n += 1;
      if (!only || only(n)) await opened;
      return undefined;
    });
    return { open, calls: () => n };
  }

  /** hana_login through the token, without waiting for the persist. */
  async function loginReply(t: Tab, over: Record<string, unknown> = {}) {
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await deliverToken(t, g, run, over);
    return pending;
  }

  const persistOf = (t: Tab) => (t.vault as unknown as { session: { persist: { done: Promise<void> } | null } | null }).session?.persist ?? null;

  it('replies before POST /v1/vault/shares answers; the record and share follow', async () => {
    const browser = new Browser();
    const gate = gateShares(browser);
    const t = await tab(browser);
    const reply = await loginReply(t);
    expect(reply.result).toMatchObject({ persistence: 'session' });
    await until(() => gate.calls() === 1, 'the share request');
    // The partner already has its addresses and the session works in memory; nothing is on disk yet.
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in', persistence: 'session' });
    expect(await stored(browser)).toBeUndefined();
    expect(shareIdOf(t)).toBeUndefined();
    gate.open();
    await persisted(t);
    expect(persistOf(t)).toBeNull();
    expect(bytesEqual(shareIdOf(t)!, (await stored(browser))!.shareId as Uint8Array)).toBe(true);
    // A reload now unlocks.
    expect((await (await tab(browser)).ready()).status).toBe('logged_in');
  });

  it('a failed share request is tried once more, and the login persists', async () => {
    const browser = new Browser();
    let n = 0;
    browser.backend.overrides.set('/v1/vault/shares', () => {
      n += 1;
      if (n === 1) throw new TypeError('Failed to fetch');
      return undefined;
    });
    const t = await tab(browser);
    await login(t, g);
    expect(n).toBe(2);
    expect(await stored(browser)).toBeDefined();
    expect((await t.request('hana_status')).result).toMatchObject({ persistence: 'session' });
  });

  it('giving up clears the older session’s record (and revokes its share), so the next reload is a full login', async () => {
    const browser = new Browser();
    const { first } = await loggedIn(browser);
    const olderShare = [...browser.backend.shares.values()][0]!;
    // A second tab that could not unlock (network), so the record is still the first tab's session.
    browser.backend.overrides.set('/v1/vault/unlock', () => {
      throw new TypeError('Failed to fetch');
    });
    const second = await tab(browser);
    expect((await second.ready()).status).toBe('logged_out');
    browser.backend.overrides.delete('/v1/vault/unlock');
    browser.backend.overrides.set('/v1/vault/shares', () => apiError(503, 'config_unavailable'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await login(second, g, { sub: '220000000000000000001' });
      expect(await stored(browser)).toBeUndefined();
      await until(() => olderShare.revoked, 'the older share revoked');
      expect(await first.waitEvent('disconnect')).toEqual({ code: 4900 });
      browser.backend.overrides.delete('/v1/vault/shares');
      expect((await (await tab(browser)).ready()).status).toBe('logged_out');
      // Its in-memory session goes on.
      expect((await second.request('hana_status')).result).toMatchObject({ status: 'logged_in', persistence: 'none' });
      // The log names a reason code only.
      const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
      expect(text).toContain('share:config_unavailable');
      expect(text).not.toMatch(/[0-9a-f]{32}/u);
    } finally {
      warn.mockRestore();
    }
  });

  it('a logout while the share request is in flight: the share is revoked once made, and no record is written', async () => {
    const browser = new Browser();
    const gate = gateShares(browser);
    const t = await tab(browser);
    await loginReply(t);
    await until(() => gate.calls() === 1, 'the share request');
    // Logout doesn't wait for the share.
    expect((await t.request('hana_logout')).result).toBeNull();
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_out' });
    gate.open();
    await until(() => browser.backend.shares.size === 1 && liveShares(browser).length === 0, 'the new share revoked');
    expect(await stored(browser)).toBeUndefined();
    // A cancelled persist is not a failure: no persistenceChanged.
    expect(t.events.some((e) => e.event === 'persistenceChanged')).toBe(false);
    // Nothing comes back on a reload.
    expect((await (await tab(browser)).ready()).status).toBe('logged_out');
  });

  it('a logout while the record is being written takes the record back and revokes the share', async () => {
    const browser = new Browser();
    // This tab's store holds its first record write until the logout has started.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let writes = 0;
    browser.openStore = async () => {
      const store = await openRecordStore(browser.idb);
      return {
        ...store,
        put: async (key, record) => {
          // The record's writes only (a login also stores its root pin, D263, under its own key).
          if (key.startsWith('pin|')) return store.put(key, record);
          writes += 1;
          if (writes === 1) await held;
          await store.put(key, record);
        },
      };
    };
    const t = await tab(browser);
    await loginReply(t);
    await until(() => writes === 1, 'the record write');
    const logout = t.request('hana_logout');
    await sleepReal(10);
    release();
    expect((await logout).result).toBeNull();
    await until(() => browser.backend.shares.size === 1 && liveShares(browser).length === 0, 'the new share revoked');
    expect(await stored(browser)).toBeUndefined();
  });

  it('a newer login in the same tab while the first one’s share is in flight: only the newer one persists', async () => {
    const browser = new Browser();
    const gate = gateShares(browser, (n) => n === 1);
    const t = await tab(browser);
    await loginReply(t);
    await until(() => gate.calls() === 1, 'the first share request');
    await login(t, g, { sub: '220000000000000000001' });
    expect((await stored(browser))!.path).toBe(`${SCOPE}#google#220000000000000000001#0`);
    gate.open();
    await until(() => browser.backend.shares.size === 2 && liveShares(browser).length === 1, 'the first share revoked');
    // The record is still the newer login's, and its share the live one.
    const r = (await stored(browser))!;
    expect(r.path).toBe(`${SCOPE}#google#220000000000000000001#0`);
    expect(bytesEqual(liveShares(browser)[0]!.shareId, r.shareId as Uint8Array)).toBe(true);
  });

  it('revoke-other-devices right after a login waits for the share instead of refusing', async () => {
    const browser = new Browser();
    const old = await loggedIn(browser);
    await old.first.request('hana_logout');
    for (const s of browser.backend.shares.values()) s.revoked = false;
    const gate = gateShares(browser);
    const t = await tab(browser);
    await loginReply(t);
    const revoke = t.request('hana_revokeOtherDevices');
    await until(() => gate.calls() === 1, 'the share request');
    await sleepReal(20);
    expect(browser.backend.count('/v1/vault/revoke-all')).toBe(0);
    gate.open();
    expect((await revoke).result).toEqual({ revoked: 1 });
  });

  it('revoke-other-devices after the share failed: refused as persistence_off', async () => {
    const browser = new Browser();
    browser.backend.overrides.set('/v1/vault/shares', () => apiError(409, 'session_not_spent'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const t = await tab(browser);
      await loginReply(t);
      expect((await t.request('hana_revokeOtherDevices')).error).toMatchObject({ code: 4100, data: { reason: 'persistence_off' } });
    } finally {
      warn.mockRestore();
    }
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

  it('a login in one tab replaces the session on this device: tabs on the old share drop it', async () => {
    const { browser, first } = await loggedIn();
    const second = await tab(browser);
    const oldShare = shareIdOf(first)!;
    const oldPrk = prkOf(first)!;
    await login(second, g, { sub: '220000000000000000001' });
    expect(bytesEqual(shareIdOf(second)!, oldShare)).toBe(false);
    // The old share's tab hears a revocation naming that share, zeroes PRK and disconnects.
    const revoked = browser.bus.sent.find((m) => (m.data as { t: string }).t === 'revoked')!.data as { shareId: Uint8Array };
    expect(bytesEqual(revoked.shareId, oldShare)).toBe(true);
    expect(await first.waitEvent('disconnect')).toEqual({ code: 4900 });
    expect(oldPrk.every((b) => b === 0)).toBe(true);
    expect(await statusOf(first)).toBe('logged_out');
    expect(await statusOf(second)).toBe('logged_in');
    await until(() => liveShares(browser).length === 1, 'the old share revoked');
  });

  it("a login in a tab with no session, over another tab's record, revokes that record's share", async () => {
    const { browser, first: a } = await loggedIn();
    const shareA = shareIdOf(a)!;
    // B's unlock fails (network): B is logged out and the record (A's) stays.
    browser.backend.overrides.set('/v1/vault/unlock', () => {
      throw new TypeError('Failed to fetch');
    });
    const b = await tab(browser);
    expect((await b.ready()).status).toBe('logged_out');
    browser.backend.overrides.delete('/v1/vault/unlock');
    await login(b, g, { sub: '220000000000000000001' });
    await until(() => browser.backend.shares.get(toHex(shareA))!.revoked, "the replaced record's share revoked");
    expect(await a.waitEvent('disconnect')).toEqual({ code: 4900 });
    expect(liveShares(browser)).toHaveLength(1);
    expect(bytesEqual((await stored(browser))!.shareId as Uint8Array, shareIdOf(b)!)).toBe(true);
  });

  it('A and B unlocked, B logs in again, A logs out: no record and no live share remain, both tabs logged out', async () => {
    const { browser, first: a } = await loggedIn();
    const b = await tab(browser);
    expect(await statusOf(b)).toBe('logged_in');
    await login(b, g, { sub: '220000000000000000001' });
    await until(async () => (await statusOf(a)) === 'logged_out', 'A to drop the replaced share');
    // A logs out with no session of its own: still app-wide on this device.
    expect((await a.request('hana_logout')).result).toBeNull();
    expect(await stored(browser)).toBeUndefined();
    expect(liveShares(browser)).toHaveLength(0);
    expect(await b.waitEvent('disconnect')).toEqual({ code: 4900 });
    expect(await statusOf(b)).toBe('logged_out');
    // A reload stays logged out.
    const c = await tab(browser);
    expect((await c.ready()).status).toBe('logged_out');
  });

  it('a logout from a tab that missed the revocation still revokes the newer session and its record', async () => {
    const browser = new Browser();
    const a = await tab(browser, { options: deaf(browser) });
    await login(a, g);
    const b = await tab(browser);
    await login(b, g, { sub: '220000000000000000001' });
    // A never heard that its share was replaced: it is still logged in on it.
    expect(await statusOf(a)).toBe('logged_in');
    await a.request('hana_logout');
    expect(await stored(browser)).toBeUndefined();
    await until(() => liveShares(browser).length === 0, 'every share revoked');
    expect(await b.waitEvent('disconnect')).toEqual({ code: 4900 });
    expect(await statusOf(a)).toBe('logged_out');
    expect(await statusOf(b)).toBe('logged_out');
  });

  it("a stale tab's 410 on touch ends only that tab, never another tab's newer session", async () => {
    const browser = new Browser();
    const a = await tab(browser, { options: deaf(browser) });
    await login(a, g);
    const staleShare = shareIdOf(a)!;
    const b = await tab(browser);
    await login(b, g, { sub: '220000000000000000001' });
    await until(() => browser.backend.shares.get(toHex(staleShare))!.revoked, 'the stale share revoked');
    expect(await statusOf(a)).toBe('logged_in');
    browser.timers.advance(TOUCH_EVERY_MS);
    await approvedSign(a);
    expect(await a.waitEvent('disconnect')).toEqual({ code: 4900 });
    const revocations = browser.bus.sent.filter((m) => (m.data as { t: string }).t === 'revoked').map((m) => (m.data as { shareId: Uint8Array }).shareId);
    expect(revocations.at(-1) && bytesEqual(revocations.at(-1)!, staleShare)).toBe(true);
    await sleepReal(30);
    expect(await statusOf(b)).toBe('logged_in');
    expect(b.events.some((e) => e.event === 'disconnect')).toBe(false);
    expect(await stored(browser)).toBeDefined();
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
  it('past expiresAtMs with the expiry timer not yet run (a throttled tab or a sleeping device): refused and PRK zeroed', async () => {
    const { browser, first } = await loggedIn();
    const prk = prkOf(first)!;
    // The clock passes the session end; no timer runs.
    browser.timers.now += 12 * HOUR;
    expect((await first.request('stellar_signMessage', { message: 'late' })).error?.code).toBe(4100);
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(first.launcher.label).toBeNull();
    expect(await first.waitEvent('sessionExpired')).toBeNull();
    expect(await statusOf(first)).toBe('logged_out');
    expect((await first.request('hana_export', { chain: 'evm' })).error?.code).toBe(4100);
    expect((await first.request('eth_accounts')).result).toEqual([]);
    await until(async () => (await stored(browser)) === undefined, 'the record deleted');
  });

  it('a request approved after expiresAtMs is not signed (4900)', async () => {
    const { browser, first } = await loggedIn();
    const prk = prkOf(first)!;
    browser.timers.now += 12 * HOUR - 60_000;
    const reply = first.request('stellar_signMessage', { message: 'almost' });
    await until(() => first.launcher.label === 'Review in Hana', 'the launcher');
    const popup = openApproval(first);
    const m = await popup.next('hana:approve-request');
    browser.timers.now += 2 * 60_000;
    answer(first, popup, m, true);
    expect((await reply).error?.code).toBe(4900);
    expect(prk.every((b) => b === 0)).toBe(true);
  });

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

describe('in-memory idle limit (Q28)', () => {
  const IDLE = 2 * HOUR;
  const unlocks = (b: Browser) => b.backend.count('/v1/vault/unlock');

  async function signMessage(t: Tab, message: string): Promise<string> {
    const reply = t.request('stellar_signMessage', { message });
    await until(() => t.launcher.label === 'Review in Hana', 'the launcher');
    const popup = openApproval(t);
    answer(t, popup, await popup.next('hana:approve-request'), true);
    const r = await reply;
    popup.closed = true;
    return (r.result as { signerAddress: string }).signerAddress;
  }

  it("zeroes PRK after idleTtlMs with no request; the session stays (dormant) and the next request unlocks it again", async () => {
    const { browser, first, addresses } = await loggedIn();
    const prk = prkOf(first)!;
    browser.timers.advance(IDLE);
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(prkOf(first)).toBeUndefined();
    // No event: for the page the wallet is still there, and the record is kept.
    await sleepReal(20);
    expect(first.events.filter((e) => e.event === 'sessionExpired' || e.event === 'disconnect')).toHaveLength(0);
    expect(await stored(browser)).toBeDefined();
    // Status and addresses answer without the key (and without an unlock).
    const before = unlocks(browser);
    expect((await first.request('hana_status')).result).toMatchObject({ status: 'logged_in', addresses });
    expect((await first.request('eth_accounts')).result).toEqual([addresses.evm]);
    expect(unlocks(browser)).toBe(before);
    // A request that needs the key unlocks the record first (one API call, as a reload).
    expect(await signMessage(first, 'after a break')).toBe(addresses.stellar);
    expect(unlocks(browser)).toBe(before + 1);
    expect(prkOf(first)!.some((b) => b !== 0)).toBe(true);
  });

  it('a request that uses the key (a signature) restarts the idle limit', async () => {
    const { browser, first, addresses } = await loggedIn();
    browser.timers.advance(IDLE - 60_000);
    expect(await signMessage(first, 'still here')).toBe(addresses.stellar);
    browser.timers.advance(IDLE - 60_000);
    expect(prkOf(first)?.some((b) => b !== 0)).toBe(true);
    browser.timers.advance(60_000);
    expect(prkOf(first)).toBeUndefined();
  });

  it('reads (status, addresses, auto-approve status) never keep PRK in memory, and answer while dormant without an unlock', async () => {
    const { browser, first, addresses } = await loggedIn();
    const reads = async () => {
      expect((await first.request('hana_status')).result).toMatchObject({ status: 'logged_in', addresses });
      expect((await first.request('eth_accounts')).result).toEqual([addresses.evm]);
      expect((await first.request('stellar_getAddress')).result).toEqual({ address: addresses.stellar });
      expect((await first.request('hana_autoApproveStatus')).result).toBeNull();
    };
    browser.timers.advance(IDLE - 60_000);
    await reads();
    // Polled just before the limit, yet the limit still counts from the login.
    browser.timers.advance(60_000);
    expect(prkOf(first)).toBeUndefined();
    const before = unlocks(browser);
    for (let i = 0; i < 3; i++) {
      await reads();
      browser.timers.advance(10 * 60_000);
    }
    expect(unlocks(browser)).toBe(before);
    expect(prkOf(first)).toBeUndefined();
  });

  it('key requests refused without the key never restart the idle limit, nor unlock a dormant session (VAUL-1, D112)', async () => {
    const { browser, first, addresses } = await loggedIn();
    const OTHER_EVM = '0x000000000000000000000000000000000000dEaD';
    const refusals = async () => {
      // Another address, a malformed request, revoke-other-devices long after the login, a second export.
      expect((await first.request('personal_sign', ['0x6869', OTHER_EVM])).error?.code).toBe(4100);
      expect((await first.request('stellar_signMessage', { message: 'x', address: OTHER_STELLAR })).error?.code).toBe(4100);
      expect((await first.request('stellar_signTransaction', { xdr: 'AAAA', networkPassphrase: PASSPHRASE })).error?.data).toMatchObject({ reason: 'invalid_request' });
      expect((await first.request('hana_revokeOtherDevices')).error?.data).toMatchObject({ reason: 'share_not_fresh' });
    };
    // An export left waiting (it counts, at the login's time) makes a second one busy, which doesn't count.
    const exporting = first.request('hana_export', { chain: 'evm' });
    await until(() => first.launcher.label === 'Export key in Hana', 'the export launcher');
    browser.timers.advance(4 * 60_000);
    expect((await first.request('hana_export', { chain: 'stellar' })).error?.code).toBe('busy');
    browser.timers.advance(IDLE - 4 * 60_000 - 60_000);
    expect((await exporting).error?.code).toBe(4001);
    await refusals();
    expect(prkOf(first)?.some((b) => b !== 0)).toBe(true);
    // The limit still counts from the login.
    browser.timers.advance(60_000);
    expect(prkOf(first)).toBeUndefined();
    // Dormant: the same refusals answer without an unlock.
    const before = unlocks(browser);
    await refusals();
    expect(unlocks(browser)).toBe(before);
    expect(prkOf(first)).toBeUndefined();
    // A request that passes the cheap checks still unlocks, as before.
    expect(await signMessage(first, 'mine')).toBe(addresses.stellar);
    expect(unlocks(browser)).toBe(before + 1);
  });

  it('follows the app’s idle setting, and a late timer (a throttled tab) still zeroes PRK on the next use', async () => {
    const { browser, first } = await loggedIn(new Browser(), { config: makeConfig({ settings: { idleTtlMs: 15 * 60_000 } }) });
    const prk = prkOf(first)!;
    // The clock passes the idle limit without any timer running.
    browser.timers.now += 15 * 60_000;
    const before = unlocks(browser);
    const reply = first.request('stellar_signMessage', { message: 'late' });
    await until(() => first.launcher.label === 'Review in Hana', 'the launcher');
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(unlocks(browser)).toBe(before + 1);
    const popup = openApproval(first);
    answer(first, popup, await popup.next('hana:approve-request'), true);
    expect((await reply).error).toBeUndefined();
  });

  it('a dormant session whose server share is gone ends at the next request that needs the key', async () => {
    const { browser, first } = await loggedIn();
    browser.timers.advance(IDLE);
    for (const share of browser.backend.shares.values()) share.revoked = true;
    expect((await first.request('stellar_signMessage', { message: 'x' })).error?.code).toBe(4100);
    expect(await first.waitEvent('sessionExpired')).toBeNull();
    expect(first.events.filter((e) => e.event === 'accountsChanged').at(-1)!.data).toEqual({ addresses: null });
    expect(await statusOf(first)).toBe('logged_out');
    await until(async () => (await stored(browser)) === undefined, 'the record deleted');
  });

  it('a dormant session ends at expiresAtMs (record deleted, sessionExpired), and on a logout or revocation', async () => {
    const { browser, first } = await loggedIn();
    browser.timers.advance(IDLE);
    browser.timers.advance(12 * HOUR - IDLE);
    expect(await first.waitEvent('sessionExpired')).toBeNull();
    expect(await statusOf(first)).toBe('logged_out');
    await until(async () => (await stored(browser)) === undefined, 'the record deleted');

    // Logout while dormant revokes the share and wipes the record.
    const second = await loggedIn();
    second.browser.timers.advance(IDLE);
    expect(liveShares(second.browser)).toHaveLength(1);
    await second.first.request('hana_logout');
    expect(liveShares(second.browser)).toHaveLength(0);
    expect(await stored(second.browser)).toBeUndefined();
    expect(await statusOf(second.first)).toBe('logged_out');
  });

  it('"none" mode: the idle limit ends the session (nothing to unlock)', async () => {
    const { browser, first } = await loggedIn(new Browser(), { config: makeConfig({ settings: { persistence: 'none' } }) });
    const prk = prkOf(first)!;
    browser.timers.advance(IDLE);
    expect(prk.every((b) => b === 0)).toBe(true);
    expect(await first.waitEvent('sessionExpired')).toBeNull();
    expect(await statusOf(first)).toBe('logged_out');
    expect((await first.request('stellar_signMessage', { message: 'x' })).error?.code).toBe(4100);
  });
});

describe('zeroization', () => {
  it('K_s (share creation and unlock), and the login relayKey and salt, are zeroed once used, every copy', async () => {
    // Taint tracking: K_s as the API's JSON gives it, the vault's random relayKey and salt, and every Uint8Array.from
    // copy made of them (the copies importKey gets included).
    const ks = new Set<unknown>();
    const random = new Map<unknown, Uint8Array>();
    const parse = JSON.parse;
    const from = Uint8Array.from;
    const getRandomValues = crypto.getRandomValues.bind(crypto);
    vi.spyOn(JSON, 'parse').mockImplementation((text: string, reviver?: Parameters<typeof JSON.parse>[1]) => {
      const v: unknown = parse(text, reviver);
      if (typeof v === 'object' && v !== null && Array.isArray((v as { ks?: unknown }).ks)) ks.add((v as { ks: unknown }).ks);
      return v;
    });
    vi.spyOn(Uint8Array, 'from').mockImplementation(function (this: unknown, src: never, ...rest: never[]) {
      const out = (from as (...a: unknown[]) => Uint8Array).call(Uint8Array, src, ...rest);
      if (ks.has(src)) ks.add(out);
      const root = random.get(src);
      if (root) random.set(out, root);
      return out;
    } as never);
    vi.spyOn(crypto, 'getRandomValues').mockImplementation(<T extends ArrayBufferView | null>(a: T): T => {
      const out = getRandomValues(a as never) as unknown as T;
      if (out instanceof Uint8Array && out.length === 32) random.set(out, out.slice());
      return out;
    });
    try {
      const browser = new Browser();
      const first = await tab(browser);
      const { run } = await login(first, g);
      const second = await tab(browser);
      expect((await second.ready()).status).toBe('logged_in');
      // Two K_s (share creation and the unlock), each as JSON numbers, the vault's copy and importKey's copy.
      expect(ks.size).toBeGreaterThanOrEqual(6);
      for (const k of ks) expect(Array.from(k as ArrayLike<number>).every((b) => b === 0)).toBe(true);
      // The relayKey and salt the popup got: the vault's original and each copy it made (the popup's own
      // structured-clone copy is the popup's to zero).
      for (const name of ['relayKey', 'salt'] as const) {
        const family = [...random.entries()].filter(([, root]) => bytesEqual(root, run.params[name] as Uint8Array)).map(([a]) => a as Uint8Array);
        expect(family.length).toBeGreaterThanOrEqual(3);
        for (const a of family) expect(a.every((b) => b === 0)).toBe(true);
      }
    } finally {
      vi.restoreAllMocks();
    }
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
