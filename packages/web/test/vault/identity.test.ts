// The vault's side of the partner identity token (docs/identity-token-spec.md "Minting", "Wallet addresses",
// "Lifetime, refresh and caching", "Tests" → Vault): proofs made at login and stored, refresh while dormant without
// PRK, the cache shared over the channel, the Web Lock, maxAgeMs, the cache dropped at logout and expiry, and a mint
// never counting as activity.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { IDENTITY_REFRESH_MARGIN_MS, deriveAddresses, walletProofMessage } from '@hana-id/core';
import { openRecordStore, recordKey } from '../../src/vault/record.ts';
import { cacheUsable, proofsMatch, tokenIatMs } from '../../src/vault/identity.ts';
import {
  APP_ID,
  Browser,
  ENV,
  type Google,
  HOUR,
  SCOPE,
  type Tab,
  apiError,
  google,
  login,
  makeConfig,
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

async function loggedIn(browser = new Browser(), o: Parameters<typeof readyTab>[1] = {}) {
  const first = await tab(browser, o);
  const { reply } = await login(first, g);
  return { browser, first, addresses: (reply.result as { addresses: { stellar: string; evm: string } }).addresses };
}

const KEY = recordKey(ENV.signer, APP_ID, SCOPE, 0);
const mints = (b: Browser): number => b.backend.count('/v1/identity/token');
const unlocks = (b: Browser): number => b.backend.count('/v1/vault/unlock');
const identity = async (t: Tab, params?: unknown) => t.request('hana_identityToken', params);
const tokenOf = async (t: Tab, params?: unknown): Promise<string> => {
  const r = await identity(t, params);
  expect(r.error).toBeUndefined();
  return (r.result as { identityToken: string }).identityToken;
};
const mintNo = (token: string): number => JSON.parse(atob(token.split('.')[1]!.replace(/-/gu, '+').replace(/_/gu, '/'))).n as number;
const internals = (t: Tab) => t.vault as unknown as { session: { lastActivityAt: number; prk: Uint8Array } | null; dormant: object | null };

describe('hana_identityToken', () => {
  it('answers nulls while logged out, without calling the API', async () => {
    const t = await tab(new Browser());
    expect((await identity(t)).result).toEqual({ identityToken: null, expiresAtMs: null });
    expect(mints(t.browser)).toBe(0);
  });

  it('mints lazily (nothing at login), with both wallet proofs for the session’s addresses, then serves the cache', async () => {
    const { browser, first, addresses } = await loggedIn();
    expect(mints(browser)).toBe(0);
    const r = await identity(first);
    const state = r.result as { identityToken: string; expiresAtMs: number };
    expect(state.expiresAtMs).toBe((browser.timers.now / 1000 + 3600) * 1000 - (browser.timers.now % 1000));
    const call = browser.backend.calls.find((c) => c.path === '/v1/identity/token')!;
    expect(call.headers['x-hana-parent-origin']).toBe('https://partner.test');
    const body = call.body as { walletProofs: { stellar: { address: string }; evm: { address: string } }; sealedEmail?: unknown };
    expect(body.walletProofs.stellar.address).toBe(addresses.stellar);
    expect(body.walletProofs.evm.address).toBe(addresses.evm);
    expect('sealedEmail' in body).toBe(false);
    expect(await first.waitEvent('identityTokenChanged')).toEqual(state);
    // Cached: no second mint.
    expect(await tokenOf(first)).toBe(state.identityToken);
    expect(mints(browser)).toBe(1);
  });

  it('re-mints when less than the refresh margin is left', async () => {
    const { browser, first } = await loggedIn();
    const one = await tokenOf(first);
    browser.backend.serverNow = () => browser.timers.now;
    browser.timers.advance(HOUR - IDENTITY_REFRESH_MARGIN_MS - 60_000);
    expect(await tokenOf(first)).toBe(one);
    browser.timers.advance(2 * 60_000);
    const two = await tokenOf(first);
    expect(mintNo(two)).toBe(mintNo(one) + 1);
  });

  it('maxAgeMs forces a fresh mint when the cached token is older', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.serverNow = () => browser.timers.now;
    const one = await tokenOf(first);
    browser.timers.advance(20_000);
    expect(await tokenOf(first, { maxAgeMs: 30_000 })).toBe(one);
    browser.timers.advance(15_000);
    expect(mintNo(await tokenOf(first, { maxAgeMs: 30_000 }))).toBe(mintNo(one) + 1);
    // Below 30 s is not a valid request (the SDK clamps; the port refuses it, so no reply: dropped).
    const bad = first.request('hana_identityToken', { maxAgeMs: 1000 });
    await expect(Promise.race([bad, sleepReal(200).then(() => 'no reply')])).resolves.toBe('no reply');
  });

  it('a mint is never activity: the idle limit runs as if nothing happened, and a dormant session refreshes without PRK or an unlock', async () => {
    const browser = new Browser();
    const { first } = await loggedIn(browser, { config: makeConfig({ settings: { idleTtlMs: 15 * 60_000 } }) });
    browser.backend.serverNow = () => browser.timers.now;
    const before = internals(first).session!.lastActivityAt;
    browser.timers.advance(60_000);
    await tokenOf(first);
    expect(internals(first).session!.lastActivityAt).toBe(before);
    browser.timers.advance(14 * 60_000);
    // Idle: PRK gone, the session dormant.
    expect(internals(first).session).toBeNull();
    expect(internals(first).dormant).not.toBeNull();
    const unlocked = unlocks(browser);
    browser.backend.identityTtlS = 600;
    browser.timers.advance(HOUR - 15 * 60_000);
    const fresh = await tokenOf(first);
    expect(fresh).toBeTruthy();
    expect(unlocks(browser)).toBe(unlocked);
    expect(internals(first).session).toBeNull();
  });

  it('tabs of one session share the token over the channel, and the Web Lock lets only one of them mint', async () => {
    const { browser, first } = await loggedIn();
    const second = await tab(browser);
    const [a, b] = await Promise.all([tokenOf(first), tokenOf(second)]);
    expect(a).toBe(b);
    expect(mints(browser)).toBe(1);
    // The other tab heard about it (its partner page gets identityTokenChanged too).
    await second.waitUntil(() => second.events.some((e) => e.event === 'identityTokenChanged'), 'the broadcast token');
  });

  it('a broadcast for another session is ignored', async () => {
    const { browser, first } = await loggedIn();
    first.browser.bus.channel(`hana-vault:${APP_ID}`).postMessage({ v: 1, t: 'identity', sessionPk: new Uint8Array(32).fill(1), identityToken: `${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(86)}`, iatMs: browser.timers.now, expiresAtMs: browser.timers.now + HOUR });
    await sleepReal(20);
    expect(first.events.some((e) => e.event === 'identityTokenChanged')).toBe(false);
  });

  it('logout drops the token (identityTokenChanged null) and later calls answer nulls', async () => {
    const { first } = await loggedIn();
    await tokenOf(first);
    await first.request('hana_logout');
    await first.waitUntil(() => first.events.some((e) => e.event === 'identityTokenChanged' && (e.data as { identityToken: unknown }).identityToken === null), 'the null token');
    expect((await identity(first)).result).toEqual({ identityToken: null, expiresAtMs: null });
  });

  it('the session’s expiry drops the token (identityTokenChanged null)', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.serverNow = () => browser.timers.now;
    await tokenOf(first);
    browser.timers.advance(12 * HOUR);
    await first.waitUntil(() => first.events.some((e) => e.event === 'identityTokenChanged' && (e.data as { identityToken: unknown }).identityToken === null), 'the null token');
    expect((await identity(first)).result).toEqual({ identityToken: null, expiresAtMs: null });
  });

  it('a newer login drops the old session’s token; the new session gets a fresh one', async () => {
    const { browser, first } = await loggedIn();
    const one = await tokenOf(first);
    await login(first, g);
    expect(first.events.filter((e) => e.event === 'identityTokenChanged').map((e) => (e.data as { identityToken: unknown }).identityToken)).toEqual([one, null]);
    const two = await tokenOf(first);
    expect(two).not.toBe(one);
    expect(mints(browser)).toBe(2);
  });

  it('410 session_ended ends the session here too: error session_ended, sessionExpired, record deleted', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.overrides.set('/v1/identity/token', () => apiError(410, 'session_ended', { reason: 'share_revoked' }));
    const r = await identity(first);
    expect(r.error).toMatchObject({ code: 'session_ended' });
    await first.waitEvent('sessionExpired');
    const store = await openRecordStore(browser.idb);
    for (let i = 0; i < 100 && (await store.get(KEY)) !== undefined; i++) await sleepReal(5);
    expect(await store.get(KEY)).toBeUndefined();
    expect((await first.request('hana_status')).result).toMatchObject({ status: 'logged_out' });
  });

  it('410 session_ending: session_ended with reason, the session itself goes on', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.overrides.set('/v1/identity/token', () => apiError(410, 'session_ending'));
    expect((await identity(first)).error).toMatchObject({ code: 'session_ended', data: { reason: 'session_ending' } });
    expect((await first.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
  });

  it('maps a rate limit, an unavailable API and a network failure; retries a stale clock once with the API’s time', async () => {
    const { browser, first } = await loggedIn();
    browser.backend.overrides.set('/v1/identity/token', () => apiError(429, 'rate_limited'));
    expect((await identity(first)).error).toMatchObject({ code: 'rate_limited' });
    browser.backend.overrides.set('/v1/identity/token', () => apiError(503, 'identity_signer_unavailable'));
    expect((await identity(first)).error).toMatchObject({ code: 'identity_unavailable' });
    browser.backend.overrides.set('/v1/identity/token', () => {
      throw new TypeError('Failed to fetch');
    });
    expect((await identity(first)).error).toMatchObject({ code: 'identity_unavailable' });
    // The device clock is 2 min fast: the first proof is stale, the retry uses the API's time.
    browser.backend.overrides.delete('/v1/identity/token');
    let first410 = true;
    browser.backend.overrides.set('/v1/identity/token', () => {
      if (!first410) return undefined;
      first410 = false;
      return apiError(400, 'stale_proof', { serverTimeMs: browser.timers.now });
    });
    expect(await tokenOf(first)).toBeTruthy();
  });

  it("'none' mode: no share, the token comes from the chain session alone", async () => {
    const browser = new Browser();
    const { first } = await loggedIn(browser, { config: makeConfig({ settings: { persistence: 'none' } }) });
    expect(browser.backend.shares.size).toBe(0);
    expect(await tokenOf(first)).toBeTruthy();
  });

  it('an app that keeps logins but a browser that could not: identity_unavailable (no share), no API call', async () => {
    const browser = new Browser();
    browser.storeFails = true;
    const { first } = await loggedIn(browser);
    expect((await identity(first)).error).toMatchObject({ code: 'identity_unavailable', data: { reason: 'no_share' } });
    expect(mints(browser)).toBe(0);
  });

  it('a reload unlocks the record and mints from its stored proofs; a format-1 record gets proofs at unlock and becomes format 2', async () => {
    const { browser, first, addresses } = await loggedIn();
    const store = await openRecordStore(browser.idb);
    const r = (await store.get(KEY)) as Record<string, unknown>;
    expect(r.v).toBe(2);
    // Make it a format-1 record (as an older vault wrote it).
    const { walletProofs: _, ...v1 } = r;
    await store.put(KEY, { ...v1, v: 1 } as never);
    first.close();
    const reloaded = await tab(browser);
    await reloaded.waitUntil(() => true, 'ready');
    expect(await tokenOf(reloaded)).toBeTruthy();
    // The upgrade runs in the background (lock, read, put): wait for it, not for a guessed time.
    for (let i = 0; i < 400 && ((await store.get(KEY)) as Record<string, unknown> | undefined)?.v !== 2; i++) await sleepReal(5);
    const upgraded = (await store.get(KEY)) as Record<string, unknown>;
    expect(upgraded.v).toBe(2);
    expect(proofsMatch(upgraded.walletProofs, addresses)).toBe(true);
  });
});

describe('cache rule and helpers', () => {
  const pk = new Uint8Array(32);
  it('more than 5 min left (or half a short token’s life), and within maxAgeMs', () => {
    const c = { sessionPk: pk, token: 't', iatMs: 0, expiresAtMs: HOUR };
    expect(cacheUsable(c, HOUR - IDENTITY_REFRESH_MARGIN_MS - 1)).toBe(true);
    expect(cacheUsable(c, HOUR - IDENTITY_REFRESH_MARGIN_MS)).toBe(false);
    expect(cacheUsable(c, 10_000, 30_000)).toBe(true);
    expect(cacheUsable(c, 40_000, 30_000)).toBe(false);
    const short = { sessionPk: pk, token: 't', iatMs: 0, expiresAtMs: 4 * 60_000 };
    expect(cacheUsable(short, 60_000)).toBe(true);
    expect(cacheUsable(short, 2 * 60_000)).toBe(false);
  });

  it('tokenIatMs reads iat (or null), and proofsMatch checks the stored shape', () => {
    const part = btoa(JSON.stringify({ iat: 1_800_000_000 })).replace(/=+$/u, '');
    expect(tokenIatMs(`x.${part}.y`)).toBe(1_800_000_000_000);
    expect(tokenIatMs('garbage')).toBeNull();
    const a = deriveAddresses(new Uint8Array(32).fill(3));
    expect(proofsMatch({ stellar: { address: a.stellar, signature: new Uint8Array(64) }, evm: { address: a.evm, signature: new Uint8Array(65) } }, a)).toBe(true);
    expect(proofsMatch({ stellar: { address: a.stellar, signature: new Uint8Array(65) }, evm: { address: a.evm, signature: new Uint8Array(65) } }, a)).toBe(false);
    expect(proofsMatch(null, a)).toBe(false);
    expect(walletProofMessage({ signer: 's', appId: 'a', sessionPublicKey: pk }, 'evm', a.evm).length).toBeGreaterThan(0);
  });
});
