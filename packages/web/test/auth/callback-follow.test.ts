// @vitest-environment happy-dom
// /login/callback in a login of an app with email (build plan batch 8b): the second, silent Google request for the
// email scope (and its one interactive retry), the access leg into follow-up slot 1, case B's proof riding with the
// token (D139), a link task's token without an access leg, a proof into its own slot, and the hand-off to the email
// page's follow-up mode.
import { type RelayCiphertext, decryptRelayPayload, followSlot, relayIdFor } from '@hana-id/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { EMAIL_PROMPT_TEXT, runCallbackPage } from '../../src/auth/callback-page.ts';
import { parseCallbackFragment } from '../../src/auth/google.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import { FakeWindow, resetDom } from './helpers.ts';

const NOW = 1_800_000_000_000;
const AUTH = 'https://auth.hana-auth.test';
const CLIENT = 'client.apps.googleusercontent.com';
const SUBJECT = '110248495921238986420';
/** A JWT-shaped placeholder (built at runtime so no token-like literal sits in the source). */
const GTOKEN = [{ alg: 'RS256' }, { sub: SUBJECT }].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');

function api(): AuthApi & { writeRelay: ReturnType<typeof vi.fn> } {
  return { getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(), login: vi.fn() } as never;
}

beforeEach(() => resetDom());

function withFollow(hash: (state: string) => string, extra: Parameters<typeof storeLoginEntry>[5] = {}) {
  const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const followKey = crypto.getRandomValues(new Uint8Array(32));
  const win = new FakeWindow('/login/callback', '', hash(state));
  storeLoginEntry(win.sessionStorage, state, relayKey, NOW, undefined, { followKey, clientId: CLIENT, ...extra });
  return { state, relayKey: Uint8Array.from(relayKey), followKey: Uint8Array.from(followKey), win };
}

/** An entry for a later leg (the access leg, a proof), under its follow-up slot. */
function leg(slotN: number, hash: (slot: string) => string, extra: Parameters<typeof storeLoginEntry>[5]) {
  const home = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const followKey = crypto.getRandomValues(new Uint8Array(32));
  const slot = followSlot(followKey, slotN).id;
  const win = new FakeWindow('/login/callback', '', hash(slot));
  storeLoginEntry(win.sessionStorage, slot, Uint8Array.from(relayKey), NOW, undefined, { followKey: Uint8Array.from(followKey), home, ...extra });
  return { home, relayKey, slot, win };
}

/** This window's sessionStorage from now on: reads and deletes work, every write throws (storage blocked or full). */
function blockWrites(win: FakeWindow): void {
  const real = win.sessionStorage;
  const blocked: Storage = {
    get length() {
      return real.length;
    },
    key: (i) => real.key(i),
    getItem: (k) => real.getItem(k),
    removeItem: (k) => real.removeItem(k),
    clear: () => real.clear(),
    setItem: () => {
      throw new DOMException('blocked', 'QuotaExceededError');
    },
  };
  Object.defineProperty(win, 'sessionStorage', { value: blocked });
}

const decrypt = (key: Uint8Array, id: string, a: ReturnType<typeof api>, n = 0) => decryptRelayPayload(key, id, a.writeRelay.mock.calls[n]?.[1] as RelayCiphertext);

describe('/login/callback with the follow-up channel (batch 8b)', () => {
  it('two-request mode: relays the openid token with `access: follow`, then asks Google silently for the email scope', async () => {
    const { state, relayKey, followKey, win } = withFollow((st) => `#id_token=${GTOKEN}&state=${st}`);
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('relayed');
    expect(await decrypt(relayKey, state, a)).toEqual({ idToken: GTOKEN, access: 'follow' });
    const url = new URL(win.location.assigned[0]!);
    const slot1 = followSlot(followKey, 1).id;
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: CLIENT,
      redirect_uri: `${AUTH}/login/callback`,
      response_type: 'token',
      response_mode: 'fragment',
      scope: 'email',
      login_hint: SUBJECT,
      state: slot1,
      prompt: 'none',
    });
    // The window stays open for the second answer, whose leg is stored under follow-up slot 1.
    expect(win.closed).toBe(false);
    expect(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + slot1)).not.toBeNull();
    expect(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)).toBeNull();
  });

  it('the access leg relays the access token to slot 1, then goes to the email page’s follow-up mode', async () => {
    const { home, relayKey, slot, win } = leg(1, (s) => `#access_token=ya29.abc&token_type=Bearer&expires_in=3599&scope=email&state=${s}`, { next: 2, leg: 'access', clientId: CLIENT, loginHint: SUBJECT });
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('relayed');
    expect(a.writeRelay.mock.calls[0]?.[0]).toBe(slot);
    expect(await decrypt(relayKey, slot, a)).toEqual({ accessToken: 'ya29.abc' });
    expect(win.location.assigned).toEqual([`/login/email#${home}`]);
    expect(JSON.parse(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + home)!)).toMatchObject({ next: 2, home });
  });

  it('a silent attempt Google needs the user for is explained, then asked once more interactively on Continue; a second failure is relayed', async () => {
    const { home, relayKey, slot, win } = leg(1, (s) => `#error=consent_required&state=${s}`, { next: 2, leg: 'access', clientId: CLIENT, loginHint: SUBJECT });
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('confirm');
    expect(a.writeRelay).not.toHaveBeenCalled();
    // D264 (G-M2): Hana's own screen first; Google's prompt only after the click.
    expect(win.location.assigned).toEqual([]);
    expect(document.getElementById('email-prompt-text')?.textContent).toBe(EMAIL_PROMPT_TEXT);
    expect(EMAIL_PROMPT_TEXT).toMatch(/share your email address/u);
    // D269: Hana keeps the address; the partner app doesn't get it from Hana.
    expect(EMAIL_PROMPT_TEXT).toMatch(/keeps it with your account/u);
    expect(EMAIL_PROMPT_TEXT).toMatch(/doesn’t share it with the app you’re signing in to/u);
    expect(EMAIL_PROMPT_TEXT).not.toMatch(/isn’t kept|doesn’t keep/u);
    (document.getElementById('email-prompt-continue') as HTMLButtonElement).click();
    const url = new URL(win.location.assigned[0]!);
    expect(url.searchParams.get('prompt')).toBeNull();
    expect(url.searchParams.get('login_hint')).toBe(SUBJECT);
    expect(url.searchParams.get('state')).toBe(slot);
    // Google answers the interactive attempt with an error too: relayed this time (the vault decides).
    win.location.hash = `#error=consent_required&state=${slot}`;
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('relayed');
    expect(await decrypt(relayKey, slot, a)).toEqual({ error: 'consent_required' });
    expect(win.location.assigned.at(-1)).toBe(`/login/email#${home}`);
  });

  it('“Not now” on the explainer relays access_denied to slot 1 (the vault’s consent screen follows)', async () => {
    const { home, relayKey, slot, win } = leg(1, (s) => `#error=interaction_required&state=${s}`, { next: 2, leg: 'access', clientId: CLIENT, loginHint: SUBJECT });
    const a = api();
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('confirm');
    (document.getElementById('email-prompt-skip') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(win.location.assigned).toEqual([`/login/email#${home}`]));
    expect(a.writeRelay.mock.calls[0]?.[0]).toBe(slot);
    expect(await decrypt(relayKey, slot, a)).toEqual({ error: 'access_denied' });
  });

  it('G-L2: storage blocked for the access leg: slot 1 says storage_unavailable and the window shows an error, never “Signed in”', async () => {
    const { state, relayKey, followKey, win } = withFollow((st) => `#id_token=${GTOKEN}&state=${st}`);
    const a = api();
    blockWrites(win);
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('relay_failed');
    expect(await decrypt(relayKey, state, a, 0)).toEqual({ idToken: GTOKEN, access: 'follow' });
    const slot1 = followSlot(followKey, 1).id;
    expect(a.writeRelay.mock.calls[1]?.[0]).toBe(slot1);
    expect(await decrypt(relayKey, slot1, a, 1)).toEqual({ error: 'storage_unavailable' });
    expect(document.body.textContent).toContain('blocked the storage');
    expect(document.body.textContent).not.toContain('Signed in');
    expect(win.location.assigned).toEqual([]);
  });

  it('G-L2: storage blocked before the interactive retry: slot 1 says storage_unavailable at once', async () => {
    const { relayKey, slot, win } = leg(1, (s) => `#error=consent_required&state=${s}`, { next: 2, leg: 'access', clientId: CLIENT, loginHint: SUBJECT });
    const a = api();
    blockWrites(win);
    expect(await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH })).toBe('relay_failed');
    expect(await decrypt(relayKey, slot, a)).toEqual({ error: 'storage_unavailable' });
    expect(document.body.textContent).toContain('blocked the storage');
  });

  it('case B’s “Link and continue” rides with the token (D139); a link task’s token gets no access leg', async () => {
    const caseB = { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Q'.repeat(43)}` };
    const b = withFollow((st) => `#id_token=${GTOKEN}&state=${st}`, { caseB });
    const a = api();
    await runCallbackPage({ win: b.win, api: a, now: () => NOW, authOrigin: AUTH });
    expect(await decrypt(b.relayKey, b.state, a)).toEqual({ idToken: GTOKEN, access: 'follow', caseB });

    const t = withFollow((st) => `#id_token=${GTOKEN}&state=${st}`, { task: true });
    const c = api();
    await runCallbackPage({ win: t.win, api: c, now: () => NOW, authOrigin: AUTH });
    expect(await decrypt(t.relayKey, t.state, c)).toEqual({ idToken: GTOKEN });
    expect(t.win.location.assigned).toEqual([`/login/email#${t.state}`]);
  });

  it('a proof the vault asked for goes to its own slot, then back to the follow-up mode at the next notice', async () => {
    const { home, relayKey, slot, win } = leg(3, (s) => `#id_token=${GTOKEN}&state=${s}`, { next: 4, leg: 'proof', clientId: CLIENT });
    const a = api();
    await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH });
    expect(await decrypt(relayKey, slot, a)).toEqual({ idToken: GTOKEN, as: 'proof' });
    expect(win.location.assigned).toEqual([`/login/email#${home}`]);
    expect(JSON.parse(win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + home)!)).toMatchObject({ next: 4 });
  });

  it('an access token answered for the login’s own leg (not one-request mode) is not relayed', async () => {
    const { state, relayKey, win } = withFollow((st) => `#id_token=${GTOKEN}&access_token=ya29.x&state=${st}`);
    const a = api();
    await runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH });
    expect(await decrypt(relayKey, state, a)).toEqual({ idToken: GTOKEN, access: 'follow' });
  });

  it('parses the access token answers (and refuses two)', () => {
    const s = 'a'.repeat(43);
    expect(parseCallbackFragment(`#access_token=ya29.x&state=${s}`)).toEqual({ kind: 'access', state: s, accessToken: 'ya29.x' });
    expect(parseCallbackFragment(`#id_token=${GTOKEN}&access_token=ya29.x&state=${s}`)).toEqual({ kind: 'token', state: s, idToken: GTOKEN, accessToken: 'ya29.x' });
    expect(parseCallbackFragment(`#access_token=a&access_token=b&state=${s}`)).toEqual({ kind: 'malformed', state: s });
  });
});
