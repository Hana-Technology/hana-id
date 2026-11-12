// @vitest-environment happy-dom
// /login/callback (docs/batch-b-spec.md "Login" step 6, "Tests → Web unit → Callback"): unknown or reused state,
// the fragment cleared first, encryption under the stored relayKey, the POST awaited before closing, and staying open
// on 409 or a network error.
import { ApiError, type RelayCiphertext, decryptRelayPayload, relayIdFor } from '@hana-id/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { runCallbackPage } from '../../src/auth/callback-page.ts';
import { parseCallbackFragment } from '../../src/auth/google.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry, takeLoginEntry } from '../../src/auth/login-storage.ts';
import { FakeWindow, pageText, resetDom } from './helpers.ts';

const NOW = 1_800_000_000_000;
/** A JWT-shaped placeholder (not a real token; built at runtime so no token-like literal sits in the source). */
const TOKEN = [{ alg: 'RS256' }, { sub: '1' }].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');

function api(write: AuthApi['writeRelay'] = vi.fn(async () => {})): AuthApi & { writeRelay: ReturnType<typeof vi.fn> } {
  return { getApp: vi.fn(), writeRelay: vi.fn(write), readRelay: vi.fn(), login: vi.fn() } as never;
}

/** A started login: the entry /login would have stored, and the callback window Google redirects to. */
function started(hash: (state: string) => string) {
  const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const win = new FakeWindow('/login/callback', '', hash(state));
  storeLoginEntry(win.sessionStorage, state, relayKey, NOW);
  return { state, relayKey, win };
}

beforeEach(() => resetDom());

describe('callback fragment', () => {
  const s = 'a'.repeat(43);
  it('reads a token, an error, or neither', () => {
    expect(parseCallbackFragment(`#id_token=${TOKEN}&state=${s}`)).toEqual({ kind: 'token', state: s, idToken: TOKEN, accessToken: null });
    expect(parseCallbackFragment(`#error=access_denied&state=${s}`)).toEqual({ kind: 'error', state: s, error: 'access_denied' });
    expect(parseCallbackFragment(`#error=Bad%20Thing&state=${s}`)).toEqual({ kind: 'error', state: s, error: 'unknown_error' });
    expect(parseCallbackFragment(`#state=${s}`)).toEqual({ kind: 'malformed', state: s });
    expect(parseCallbackFragment(`#id_token=${TOKEN}&error=x&state=${s}`)).toEqual({ kind: 'malformed', state: s });
    for (const bad of ['', `#id_token=${TOKEN}`, `#id_token=${TOKEN}&state=short`, `#id_token=${TOKEN}&state=${s}&state=${s}`]) expect(parseCallbackFragment(bad)).toEqual({ kind: 'no_state' });
  });
});

describe('/login/callback', () => {
  it('clears the fragment before anything else, encrypts the token under the stored relayKey, awaits the POST, then closes', async () => {
    const { state, relayKey, win } = started((st) => `#id_token=${TOKEN}&state=${st}&token_type=Bearer`);
    const keyCopy = Uint8Array.from(relayKey);
    let release: () => void = () => {};
    const written: { relayId: string; value: RelayCiphertext }[] = [];
    const a = api(
      (relayId, value) =>
        new Promise<void>((resolve) => {
          written.push({ relayId, value });
          release = resolve;
        }),
    );
    const outcome = runCallbackPage({ win, api: a, now: () => NOW });
    // Synchronously, before any await: the URL no longer holds the token.
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/login/callback');
    expect(win.location.hash).toBe('');
    await vi.waitFor(() => expect(written).toHaveLength(1));
    expect(win.closed).toBe(false);
    release();
    expect(await outcome).toBe('relayed');
    expect(win.closed).toBe(true);

    expect(written[0]?.relayId).toBe(state);
    expect(JSON.stringify(written[0]?.value)).not.toContain(TOKEN);
    expect(await decryptRelayPayload(keyCopy, state, written[0]!.value)).toEqual({ idToken: TOKEN });
    // Not under another key or for another relayId.
    await expect(decryptRelayPayload(crypto.getRandomValues(new Uint8Array(32)), state, written[0]!.value)).rejects.toThrow();
    await expect(decryptRelayPayload(keyCopy, 'b'.repeat(43), written[0]!.value)).rejects.toThrow();
    expect(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)).toBeNull();
    expect(pageText()).not.toContain(TOKEN);
  });

  it('relays Google’s #error as {error}', async () => {
    const { state, relayKey, win } = started((st) => `#error=access_denied&state=${st}`);
    const keyCopy = Uint8Array.from(relayKey);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('relayed');
    expect(await decryptRelayPayload(keyCopy, state, a.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toEqual({ error: 'access_denied' });
  });

  it('relays an answer with neither token nor error as {error: invalid_response}, so the vault stops waiting', async () => {
    const { state, relayKey, win } = started((st) => `#state=${st}`);
    const keyCopy = Uint8Array.from(relayKey);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('relayed');
    expect(await decryptRelayPayload(keyCopy, state, a.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toEqual({ error: 'invalid_response' });
  });

  it('refuses an unknown state and posts nothing', async () => {
    const win = new FakeWindow('/login/callback', '', `#id_token=${TOKEN}&state=${'z'.repeat(43)}`);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('refused');
    expect(a.writeRelay).not.toHaveBeenCalled();
    expect(win.closed).toBe(false);
    expect(win.location.hash).toBe('');
    expect(pageText()).toContain('expired or was already used');
  });

  it('refuses a reused state (single use)', async () => {
    const { state, win } = started((st) => `#id_token=${TOKEN}&state=${st}`);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('relayed');
    const again = new FakeWindow('/login/callback', '', `#id_token=${TOKEN}&state=${state}`);
    expect(await runCallbackPage({ win: again, api: a, now: () => NOW })).toBe('refused');
    expect(a.writeRelay).toHaveBeenCalledTimes(1);
  });

  it('refuses a state older than 10 min, and a fragment without a state', async () => {
    const { win } = started((st) => `#id_token=${TOKEN}&state=${st}`);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW + 10 * 60_000 + 1 })).toBe('refused');
    const none = new FakeWindow('/login/callback', '', `#id_token=${TOKEN}`);
    expect(await runCallbackPage({ win: none, api: a, now: () => NOW })).toBe('refused');
    expect(a.writeRelay).not.toHaveBeenCalled();
  });

  it.each([
    ['409 relay_used', new ApiError(409, 'relay_used', 'used', null, null), 'already completed'],
    ['a network error', new TypeError('Failed to fetch'), 'couldn’t be reached'],
    ['429', new ApiError(429, 'rate_limited', 'slow down', null, null), 'couldn’t be reached'],
  ])('stays open on %s', async (_, err, text) => {
    const { win } = started((st) => `#id_token=${TOKEN}&state=${st}`);
    const a = api(async () => {
      throw err;
    });
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('relay_failed');
    expect(win.closed).toBe(false);
    expect(pageText()).toContain(text);
    expect(pageText()).not.toContain(TOKEN);
  });

  it('refuses to run framed', async () => {
    const { win } = started((st) => `#id_token=${TOKEN}&state=${st}`);
    win.top = {};
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW })).toBe('refused');
    expect(a.writeRelay).not.toHaveBeenCalled();
  });
});

describe('login sessionStorage entry', () => {
  it('is taken once, and refuses a malformed state or key', () => {
    const state = 'q'.repeat(43);
    const key = crypto.getRandomValues(new Uint8Array(32));
    storeLoginEntry(window.sessionStorage, state, key, NOW);
    expect(takeLoginEntry(window.sessionStorage, state, NOW)).toEqual(key);
    expect(takeLoginEntry(window.sessionStorage, state, NOW)).toBeNull();
    expect(() => storeLoginEntry(window.sessionStorage, 'short', key, NOW)).toThrow();
    expect(() => storeLoginEntry(window.sessionStorage, state, new Uint8Array(31), NOW)).toThrow();
    window.sessionStorage.setItem(LOGIN_ENTRY_PREFIX + state, '{"v":1,"createdAt":1,"relayKey":"!!"}');
    expect(takeLoginEntry(window.sessionStorage, state, 2)).toBeNull();
  });
});

describe('/login/callback timings (pk_test_ apps)', () => {
  const nav = () => ({ fetchStart: 400, responseEnd: 650 });
  /** A login /login started for a pk_test_ app (its entry carries authCheck). */
  function startedTest(hash: (state: string) => string, timings: Record<string, number> | null = { authCheck: 310 }) {
    const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    const relayKey = crypto.getRandomValues(new Uint8Array(32));
    const win = new FakeWindow('/login/callback', '', hash(state));
    storeLoginEntry(win.sessionStorage, state, relayKey, NOW, timings ?? undefined);
    return { state, relayKey: Uint8Array.from(relayKey), win };
  }

  it('adds /login’s and its own stage durations to the encrypted slot, and nothing else', async () => {
    const { state, relayKey, win } = startedTest((st) => `#id_token=${TOKEN}&state=${st}`);
    let t = 700;
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW, perfNow: () => (t += 5), navigation: nav })).toBe('relayed');
    const payload = await decryptRelayPayload(relayKey, state, a.writeRelay.mock.calls[0]?.[1] as RelayCiphertext);
    // Redirect hops 0 → fetchStart, the auth page Worker fetchStart → responseEnd, then this script from 705.
    expect(payload).toEqual({ idToken: TOKEN, timings: { authCheck: 310, callbackRedirect: 400, callbackFetch: 250, callbackBoot: 55, callbackPrep: 5 } });
    // The timings hold no part of the token or the state.
    expect(JSON.stringify((payload as { timings: unknown }).timings)).not.toMatch(new RegExp(`${state}|${TOKEN.split('.')[1]}`, 'u'));
  });

  it('a Google error carries the timings too; a pk_live_ login (no stored timings) carries none', async () => {
    const err = startedTest((st) => `#error=access_denied&state=${st}`);
    const a = api();
    await runCallbackPage({ win: err.win, api: a, now: () => NOW, navigation: nav });
    expect(await decryptRelayPayload(err.relayKey, err.state, a.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toMatchObject({ error: 'access_denied', timings: { authCheck: 310 } });

    const live = startedTest((st) => `#id_token=${TOKEN}&state=${st}`, null);
    const b = api();
    await runCallbackPage({ win: live.win, api: b, now: () => NOW, navigation: nav });
    expect(await decryptRelayPayload(live.relayKey, live.state, b.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toEqual({ idToken: TOKEN });
  });

  it('without navigation timing it still reports callbackPrep', async () => {
    const { state, relayKey, win } = startedTest((st) => `#id_token=${TOKEN}&state=${st}`);
    const a = api();
    await runCallbackPage({ win, api: a, now: () => NOW, navigation: () => null });
    const payload = (await decryptRelayPayload(relayKey, state, a.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)) as { timings: Record<string, number> };
    expect(Object.keys(payload.timings).sort()).toEqual(['authCheck', 'callbackPrep']);
  });
});
