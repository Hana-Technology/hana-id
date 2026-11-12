// @vitest-environment happy-dom
// /home/callback (D491): the exit Google client's only redirect URI. It relays only what it should: a state whose entry
// the Home sign-in child stored for the exit client, an ID token of that client with that entry's nonce, in a window
// opened by Hana Home (or with no opener left), never a plain login's entry; /login/callback never takes an exit entry.
import { type RelayCiphertext, decryptRelayPayload, relayIdFor } from '@hana-id/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { runCallbackPage } from '../../src/auth/callback-page.ts';
import { googleAuthUrl } from '../../src/auth/google.ts';
import { runHomeCallbackPage } from '../../src/auth/home-callback-page.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import { ENV, FakeWindow, crossOriginWindow, pageText, remoteWindow, resetDom } from './helpers.ts';

const NOW = 1_800_000_000_000;
const EXIT = 'hana-exit.apps.googleusercontent.com';
const NONCE = 'N'.repeat(43);
/** A JWT-shaped placeholder with these claims (unsigned: this page reads claims only, Hana Home checks the signature). */
const token = (claims: Record<string, unknown>): string => [{ alg: 'RS256' }, { iss: 'https://accounts.google.com', sub: '1', ...claims }].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');
const GOOD = token({ aud: EXIT, nonce: NONCE });

function api() {
  const written: { relayId: string; value: RelayCiphertext }[] = [];
  const a = { writeRelay: vi.fn(async (relayId: string, value: RelayCiphertext) => void written.push({ relayId, value })) } as unknown as Pick<AuthApi, 'writeRelay'>;
  return { a, written };
}

/** The entry the child stores for the exit client, and the window Google redirects to. */
function started(hash: (state: string) => string, entry: Parameters<typeof storeLoginEntry>[5] = { exit: true, clientId: EXIT, nonce: NONCE }) {
  const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const win = new FakeWindow('/home/callback', '', hash(state));
  win.opener = remoteWindow({ location: { pathname: '/home', origin: ENV.authOrigin } as never }) as never;
  storeLoginEntry(win.sessionStorage, state, relayKey, NOW, undefined, entry);
  return { state, relayKey: Uint8Array.from(relayKey), win };
}

const run = (win: FakeWindow, a: Pick<AuthApi, 'writeRelay'>) => runHomeCallbackPage({ win, api: a, authOrigin: ENV.authOrigin, now: () => NOW });

beforeEach(() => {
  resetDom();
  window.sessionStorage.clear();
});

describe('/home/callback', () => {
  it('clears the fragment first, relays the exit client’s token for the entry’s nonce under its relay key, then closes', async () => {
    const { state, relayKey, win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    const { a, written } = api();
    const outcome = run(win, a);
    expect(win.history.replaceState).toHaveBeenCalledWith(null, '', '/home/callback');
    expect(win.location.hash).toBe('');
    expect(await outcome).toBe('relayed');
    expect(win.closed).toBe(true);
    expect(written).toHaveLength(1);
    expect(written[0]!.relayId).toBe(state);
    expect(await decryptRelayPayload(relayKey, state, written[0]!.value)).toEqual({ idToken: GOOD });
    expect(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)).toBeNull();
    expect(pageText()).not.toContain(GOOD);
  });

  it('relays Google’s error (a cancel) so Hana Home stops waiting', async () => {
    const { state, relayKey, win } = started((s) => `#error=access_denied&state=${s}`);
    const { a, written } = api();
    expect(await run(win, a)).toBe('relayed');
    expect(await decryptRelayPayload(relayKey, state, written[0]!.value)).toEqual({ error: 'access_denied' });
  });

  it.each([
    ['another client’s token', token({ aud: 'shared.apps.googleusercontent.com', nonce: NONCE })],
    ['a token for another nonce', token({ aud: EXIT, nonce: 'M'.repeat(43) })],
    ['a token with no nonce', token({ aud: EXIT })],
  ])('never relays %s: the slot says invalid_response', async (_, idToken) => {
    const { state, relayKey, win } = started((s) => `#id_token=${idToken}&state=${s}`);
    const { a, written } = api();
    expect(await run(win, a)).toBe('relayed');
    expect(await decryptRelayPayload(relayKey, state, written[0]!.value)).toEqual({ error: 'invalid_response' });
  });

  it('never relays a token with a claim outside the allow-list', async () => {
    const { state, relayKey, win } = started((s) => `#id_token=${token({ aud: EXIT, nonce: NONCE, email: 'a@b.c' })}&state=${s}`);
    const { a, written } = api();
    await run(win, a);
    expect(await decryptRelayPayload(relayKey, state, written[0]!.value)).toEqual({ error: 'token_has_pii', claim: 'email' });
  });

  it('an access token is never relayed', async () => {
    const { state, relayKey, win } = started((s) => `#access_token=ya29.x&state=${s}`);
    const { a, written } = api();
    await run(win, a);
    expect(await decryptRelayPayload(relayKey, state, written[0]!.value)).toEqual({ error: 'invalid_response' });
  });

  it.each([
    ['no state', () => started(() => `#id_token=${GOOD}`)],
    ['a state with no entry', () => ({ ...started((s) => `#id_token=${GOOD}&state=${s}`), wipe: true })],
    ['a plain login’s entry (the shared client’s)', () => started((s) => `#id_token=${GOOD}&state=${s}`, {})],
    ['an exit entry without its client or nonce', () => started((s) => `#id_token=${GOOD}&state=${s}`, { exit: true })],
    ['a parked entry', () => started((s) => `#id_token=${GOOD}&state=${s}`, { exit: true, clientId: EXIT, nonce: NONCE, cancelled: true })],
  ])('refuses %s: nothing relayed', async (_, make) => {
    const made = make() as ReturnType<typeof started> & { wipe?: boolean };
    if (made.wipe) made.win.sessionStorage.clear();
    const { a, written } = api();
    expect(await run(made.win, a)).toBe('refused');
    expect(written).toEqual([]);
    expect(made.win.closed).toBe(false);
  });

  it('a used state finds nothing the second time', async () => {
    const { state, win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    const { a, written } = api();
    await run(win, a);
    const again = new FakeWindow('/home/callback', '', `#id_token=${GOOD}&state=${state}`);
    expect(await run(again, a)).toBe('refused');
    expect(written).toHaveLength(1);
  });

  it.each([
    ['opened by another site', () => crossOriginWindow()],
    ['opened by another Journear page', () => remoteWindow({ location: { pathname: '/login', origin: ENV.authOrigin } as never })],
    ['opened by Passport Home of another origin', () => remoteWindow({ location: { pathname: '/home', origin: 'https://evil.example' } as never })],
  ])('refuses a window %s, before the entry is touched', async (_, opener) => {
    const { state, win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    win.opener = opener() as never;
    const { a, written } = api();
    expect(await run(win, a)).toBe('refused');
    expect(written).toEqual([]);
    expect(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)).not.toBeNull();
  });

  it('takes a window whose opener Google’s pages cut (no opener left)', async () => {
    const { win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    win.opener = null;
    const { a } = api();
    expect(await run(win, a)).toBe('relayed');
  });

  it('refuses inside a frame', async () => {
    const { win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    win.top = {};
    const { a, written } = api();
    expect(await run(win, a)).toBe('refused');
    expect(written).toEqual([]);
  });
});

describe('/login/callback and the exit client', () => {
  it('never relays for an exit entry: an answer for it must come to /home/callback', async () => {
    const { win } = started((s) => `#id_token=${GOOD}&state=${s}`);
    const { a, written } = api();
    const outcome = await runCallbackPage({ win, api: { ...a, getApp: vi.fn(), readRelay: vi.fn(), login: vi.fn() } as never, now: () => NOW });
    expect(outcome).toBe('refused');
    expect(written).toEqual([]);
  });

  it('the exit request answers to /home/callback; every other request to /login/callback', () => {
    const base = { clientId: EXIT, authOrigin: ENV.authOrigin, nonce: NONCE, state: 'a'.repeat(43), forceReauth: false };
    expect(new URL(googleAuthUrl({ ...base, exit: true })).searchParams.get('redirect_uri')).toBe(`${ENV.authOrigin}/home/callback`);
    expect(new URL(googleAuthUrl(base)).searchParams.get('redirect_uri')).toBe(`${ENV.authOrigin}/login/callback`);
  });
});
