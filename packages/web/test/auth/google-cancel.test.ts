// @vitest-environment happy-dom
// D341, popup side: a cancel on token_first's Google screen (`access_denied` on its first request, or on D273's
// interactive retry) is not relayed. /login/callback parks the login's keys under its slot and goes back to the email
// page, which shows the screen the Google step came from: Hana's method chooser ("Google sign-in was cancelled.") or
// case B's choices. Google again is a fresh attempt under a new OAuth state whose entry names the slot; email is the
// email step; closing the window there relays `google_cancelled`. Every other Google error is still relayed.
import { type RelayCiphertext, decryptRelayPayload, followSlot, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { type CallbackOutcome, runCallbackPage } from '../../src/auth/callback-page.ts';
import type { EmailApi } from '../../src/auth/email-api.ts';
import { GOOGLE_CANCELLED_TEXT, startEmailPage } from '../../src/auth/email-page.ts';
import { EMAIL_ENTRY_PREFIX, EMAIL_STEP_LIMIT_MS, storeEmailContext } from '../../src/auth/email-storage.ts';
import { type AccessTokenSub, GOOGLE_AUTH_URL, GOOGLE_CANCELLED_RELAY_ERROR } from '../../src/auth/google.ts';
import { EMAIL_PATH } from '../../src/auth/login-page.ts';
import { type FollowEntry, LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, flush, pageText, resetDom } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const NOW = 1_800_000_000_000;
const AUTH = 'https://auth.hana-auth.test';
const SUBJECT = '110248495921238986420';
const ACCESS = 'ya29.google-cancel';
const CID = 'c'.repeat(43);
const EMAIL_TOKEN = '{"payload":"eyJ","signatures":[{"protected":"eyJ","signature":"sig"}]}';
const LINK = { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Q'.repeat(43)}` };
const jwt = (claims: Record<string, unknown>) => [{ alg: 'RS256' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');

// The relay encryptions the pages start, so a test can wait for them (not for a guessed time). The real function runs.
const encryptions = vi.hoisted(() => new Set<Promise<unknown>>());
vi.mock('@hana-id/core', async (importOriginal) => {
  const core = await importOriginal<typeof import('@hana-id/core')>();
  return {
    ...core,
    encryptRelayPayload: (...args: Parameters<typeof core.encryptRelayPayload>) => {
      const p = core.encryptRelayPayload(...args);
      encryptions.add(p);
      return p;
    },
  };
});

beforeEach(() => {
  encryptions.clear();
  resetDom();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error('no fetch expected');
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();
const submit = (id: string) => (document.getElementById(id) as HTMLButtonElement).closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
const typeInto = (id: string, value: string) => {
  (document.getElementById(id) as HTMLInputElement).value = value;
};
/**
 * The page encrypts its close value as it shows the screen (WebCrypto answers on a later task, later still under load):
 * every relay encryption started so far, tracked by the wrapper below, has settled and its callbacks have run.
 */
const encrypted = async (): Promise<void> => {
  await Promise.allSettled([...encryptions]);
  await flush();
};
const entryOf = (state: string) => {
  const raw = window.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state);
  return raw ? JSON.parse(raw) : null;
};
const query = (url: string) => {
  const u = new URL(url);
  expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTH_URL);
  return Object.fromEntries(u.searchParams);
};

/** One login: its slot (relayId), keys, nonce, and the email context /login stores before Google (D341's screen). */
function login(o: { methods?: ('google' | 'email')[]; context?: boolean; method?: 'google' | 'email' } = {}) {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const expiresAtMs = 1_900_000_000_000;
  const nonce = sessionNonce({ signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
  const relayId = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const followKey = crypto.getRandomValues(new Uint8Array(32));
  if (o.context !== false) {
    storeEmailContext(
      window.sessionStorage,
      relayId,
      {
        pk: PK,
        appName: 'Partner App',
        parentOrigin: PARTNER,
        scopeId: 's1',
        sessionPublicKey,
        expiresAtMs,
        salt,
        keyIndex: 0,
        maxUses: 1,
        nonce,
        clientId: CLIENT_ID,
        methods: o.methods ?? ['google', 'email'],
        ...(o.method ? { method: o.method } : {}),
        emailHint: null,
        opener: 'partner',
        vaultFrame: null,
        challengeId: null,
        proof: null,
        exportMode: false,
      },
      NOW,
    );
  }
  /** An entry for a Google attempt of this login under `state` (the login's own slot unless named otherwise). */
  const entry = (state: string, extra: FollowEntry = {}) =>
    storeLoginEntry(window.sessionStorage, state, Uint8Array.from(relayKey), NOW, undefined, { followKey: Uint8Array.from(followKey), clientId: CLIENT_ID, tokenFirst: true, nonce, ...extra });
  return { relayId, relayKey, followKey, nonce, entry };
}

type Login = ReturnType<typeof login>;

function api(): AuthApi & { writeRelay: ReturnType<typeof vi.fn>; readRelay: ReturnType<typeof vi.fn> } {
  return { getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(async () => {
      // The follow-up mode's long poll: nothing yet (a macrotask, as the network would be).
      await new Promise((r) => setTimeout(r, 2));
      return null;
    }), login: vi.fn() } as never;
}
const decrypt = (l: Login, id: string, a: ReturnType<typeof api>, n = 0) => decryptRelayPayload(l.relayKey, id, a.writeRelay.mock.calls[n]?.[1] as RelayCiphertext);
const tokenInfo = (r: AccessTokenSub = { ok: true, sub: SUBJECT }) => vi.fn(async () => r);

/** /login/callback with Google's answer `hash` for `state`. */
function callback(hash: string, a = api(), ti = tokenInfo()): { win: FakeWindow; a: ReturnType<typeof api>; out: Promise<CallbackOutcome> } {
  const win = new FakeWindow('/login/callback', '', hash);
  return { win, a, out: runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH, tokenInfo: ti }) };
}

/** /login/email for the login's slot, as the callback navigates to it. */
function emailPage(l: Login, a = api(), issuer: Partial<Record<keyof EmailApi, unknown>> = {}, now: () => number = () => NOW) {
  const win = new FakeWindow(EMAIL_PATH, '', `#${l.relayId}`);
  const iss = {
    start: vi.fn(async () => ({ challengeId: CID, expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 })),
    startLink: vi.fn(),
    resend: vi.fn(),
    verify: vi.fn(async () => ({ kind: 'token', idToken: EMAIL_TOKEN, deviceTicket: null })),
    ...issuer,
  };
  const page = startEmailPage({ win, env: EMAIL_ENV, issuer: iss as unknown as EmailApi, api: a, tickets: null, now, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout: () => {} });
  return { win, page, a, iss };
}

describe('/login/callback: a cancel on token_first’s Google screen goes back, nothing relayed (D341)', () => {
  it('from the chooser (the first request, under the login’s slot): the keys parked for the email page, which the window goes to', async () => {
    const l = login();
    l.entry(l.relayId);
    const c = callback(`#error=access_denied&state=${l.relayId}`);
    expect(await c.out).toBe('cancelled');
    // The vault hears nothing: its wait goes on.
    expect(c.a.writeRelay).not.toHaveBeenCalled();
    expect(c.win.location.assigned).toEqual([`/login/email#${l.relayId}`]);
    expect(c.win.closed).toBe(false);
    expect(entryOf(l.relayId)).toMatchObject({ x: 1, bk: 'c', tf: 1, n: l.nonce, c: CLIENT_ID, f: Buffer.from(l.followKey).toString('base64url') });
    // No hint: slot 1 holds nothing yet, so Google again is the first request again.
    expect(entryOf(l.relayId).h).toBeUndefined();
    expect(pageText()).toContain(GOOGLE_CANCELLED_TEXT);
    expect(pageText()).not.toContain('google_error');
  });

  it('from case B (an attempt under its own state): parked under the login’s slot with the link offer; the attempt’s state is gone', async () => {
    const l = login();
    const attempt = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    l.entry(attempt, { slot: l.relayId, back: 'case_b', offer: LINK, caseB: LINK });
    const c = callback(`#error=access_denied&state=${attempt}`);
    expect(await c.out).toBe('cancelled');
    expect(c.a.writeRelay).not.toHaveBeenCalled();
    expect(c.win.location.assigned).toEqual([`/login/email#${l.relayId}`]);
    const parked = entryOf(l.relayId);
    expect(parked).toMatchObject({ x: 1, bk: 'b', ob: LINK });
    // The choice made before the cancel isn't kept: the user picks again on case B's screen.
    expect(parked.b).toBeUndefined();
    expect(entryOf(attempt)).toBeNull();
  });

  it('D273’s interactive retry cancelled: parked with the account’s hint (slot 1 already holds its access token)', async () => {
    const l = login();
    l.entry(l.relayId, { leg: 'id', loginHint: SUBJECT, interactive: true });
    const c = callback(`#error=access_denied&state=${l.relayId}`);
    expect(await c.out).toBe('cancelled');
    expect(c.a.writeRelay).not.toHaveBeenCalled();
    expect(entryOf(l.relayId)).toMatchObject({ x: 1, bk: 'c', h: SUBJECT });
    expect(entryOf(l.relayId).leg).toBeUndefined();
  });

  it('a record-only login (Google only) goes back too', async () => {
    const l = login({ methods: ['google'] });
    l.entry(l.relayId, { record: true });
    const c = callback(`#error=access_denied&state=${l.relayId}`);
    expect(await c.out).toBe('cancelled');
    expect(c.a.writeRelay).not.toHaveBeenCalled();
    expect(entryOf(l.relayId)).toMatchObject({ x: 1, r: 1 });
  });

  it('a parked entry is never a Google answer’s: a token or an error for the login’s slot is refused, nothing relayed', async () => {
    for (const hash of [`#id_token=${jwt({ sub: SUBJECT })}`, `#access_token=${ACCESS}`, '#error=access_denied']) {
      resetDom();
      const l = login();
      l.entry(l.relayId, { back: 'chooser', cancelled: true });
      const c = callback(`${hash}&state=${l.relayId}`);
      expect(await c.out, hash).toBe('refused');
      expect(c.a.writeRelay).not.toHaveBeenCalled();
      expect(c.win.location.assigned).toEqual([]);
      expect(pageText()).toContain('expired or was already used');
    }
  });

  it('every other Google error is still relayed (the vault ends the login with google_error)', async () => {
    for (const error of ['server_error', 'temporarily_unavailable', 'invalid_request', 'unauthorized_client', 'unknown_error']) {
      resetDom();
      const l = login();
      l.entry(l.relayId);
      const c = callback(`#error=${error}&state=${l.relayId}`);
      expect(await c.out, error).toBe('relayed');
      expect(await decrypt(l, l.relayId, c.a)).toEqual({ error });
    }
    // The silent ID request's access_denied isn't the user's cancel (no screen was shown): relayed.
    resetDom();
    const l = login();
    l.entry(l.relayId, { leg: 'id', loginHint: SUBJECT });
    const c = callback(`#error=access_denied&state=${l.relayId}`);
    expect(await c.out).toBe('relayed');
    expect(await decrypt(l, l.relayId, c.a)).toEqual({ error: 'access_denied' });
    // A second failure of D273's retry that isn't a cancel: relayed.
    resetDom();
    const r = login();
    r.entry(r.relayId, { leg: 'id', loginHint: SUBJECT, interactive: true });
    const d = callback(`#error=login_required&state=${r.relayId}`);
    expect(await d.out).toBe('relayed');
    expect(await decrypt(r, r.relayId, d.a)).toEqual({ error: 'login_required' });
  });

  it('with no email context to go back to (none stored), the cancel is relayed as before', async () => {
    const l = login({ context: false });
    l.entry(l.relayId);
    const c = callback(`#error=access_denied&state=${l.relayId}`);
    expect(await c.out).toBe('relayed');
    expect(await decrypt(l, l.relayId, c.a)).toEqual({ error: 'access_denied' });
  });
});

describe('a fresh attempt after a cancel: its own OAuth state, the login’s slot (D341)', () => {
  it('the access token to slot 1, the ID request under the attempt’s state; the ID token to the login’s slot, then the follow-up mode', async () => {
    const l = login();
    const attempt = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    l.entry(attempt, { slot: l.relayId, back: 'chooser' });
    const first = callback(`#access_token=${ACCESS}&state=${attempt}`);
    expect(await first.out).toBe('relayed');
    const slot1 = followSlot(l.followKey, 1).id;
    expect(first.a.writeRelay.mock.calls.map((c) => c[0])).toEqual([slot1]);
    expect(query(first.win.location.assigned[0]!)).toMatchObject({ response_type: 'id_token', scope: 'openid', nonce: l.nonce, state: attempt, login_hint: SUBJECT, prompt: 'none' });
    expect(entryOf(attempt)).toMatchObject({ leg: 'id', s: l.relayId, bk: 'c', h: SUBJECT });
    // The cancelled attempt's state (the login's slot) finds no entry: a replay of its answer is refused.
    expect(entryOf(l.relayId)).toBeNull();
    const token = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUBJECT, nonce: l.nonce, iat: 1, exp: 2 });
    const second = callback(`#id_token=${token}&state=${attempt}`);
    expect(await second.out).toBe('relayed');
    expect(second.a.writeRelay.mock.calls.map((c) => c[0])).toEqual([l.relayId]);
    expect(await decrypt(l, l.relayId, second.a)).toEqual({ idToken: token, access: 'follow' });
    expect(second.win.location.assigned).toEqual([`/login/email#${l.relayId}`]);
    expect(entryOf(l.relayId)).toMatchObject({ next: 2, home: l.relayId });
    const replay = callback(`#error=access_denied&state=${attempt}`);
    expect(await replay.out).toBe('refused');
  });

  it('its own stops go to the login’s slot too (tokeninfo, another account)', async () => {
    const l = login();
    const attempt = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    l.entry(attempt, { slot: l.relayId, back: 'chooser' });
    const c = callback(`#access_token=${ACCESS}&state=${attempt}`, api(), tokenInfo({ ok: false, reason: 'unavailable' }));
    expect(await c.out).toBe('stopped');
    expect(c.a.writeRelay.mock.calls.map((x) => x[0])).toEqual([l.relayId]);
    expect(await decrypt(l, l.relayId, c.a)).toEqual({ error: 'tokeninfo_unavailable' });
    resetDom();
    const m = login();
    const a2 = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
    m.entry(a2, { slot: m.relayId, leg: 'id', loginHint: SUBJECT });
    const other = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1999', nonce: m.nonce, iat: 1, exp: 2 });
    const d = callback(`#id_token=${other}&state=${a2}`);
    expect(await d.out).toBe('stopped');
    expect(await decrypt(m, m.relayId, d.a)).toEqual({ error: 'google_account_mismatch' });
  });
});

describe('/login/email after a cancel: the screen the Google step came from (D341)', () => {
  const parked = (l: Login, extra: FollowEntry = {}) => l.entry(l.relayId, { back: 'chooser', cancelled: true, ...extra });

  it('the chooser: the neutral line, Google and email; the keys taken into memory (nothing reusable left under the slot)', async () => {
    const l = login();
    parked(l);
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    expect(document.getElementById('google-cancelled')?.textContent).toBe('Google sign-in was cancelled.');
    expect(document.getElementById('continue-google')).not.toBeNull();
    expect(document.getElementById('continue-email')).not.toBeNull();
    expect(p.page.notice).toBe('google_cancelled');
    expect(pageText()).not.toContain('google_error');
    expect(entryOf(l.relayId)).toBeNull();
    expect(p.a.writeRelay).not.toHaveBeenCalled();
  });

  it('Google again: token_first’s first request under a fresh state; its entry names the slot, keeps the nonce; nothing relayed', async () => {
    const l = login();
    parked(l);
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    await encrypted();
    click('continue-google');
    const q = query(p.win.location.assigned[0]!);
    expect(q).toMatchObject({ response_type: 'token', scope: 'openid email', prompt: 'select_account', client_id: CLIENT_ID, redirect_uri: `${ENV.authOrigin}/login/callback` });
    expect(q.nonce).toBeUndefined();
    expect(q.state).not.toBe(l.relayId);
    expect(entryOf(q.state!)).toMatchObject({ tf: 1, n: l.nonce, s: l.relayId, bk: 'c', c: CLIENT_ID, f: Buffer.from(l.followKey).toString('base64url') });
    expect(entryOf(l.relayId)).toBeNull();
    // Leaving for Google isn't a close: nothing is relayed.
    p.win.dispatch('pagehide');
    await flush();
    expect(p.a.writeRelay).not.toHaveBeenCalled();
  });

  it('two attempts never share a state', async () => {
    const states = new Set<string>();
    for (let i = 0; i < 3; i++) {
      resetDom();
      const l = login();
      parked(l);
      const p = emailPage(l);
      await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
      click('continue-google');
      states.add(query(p.win.location.assigned[0]!).state!);
    }
    expect(states.size).toBe(3);
  });

  it('after D273’s retry was cancelled, Google again is that retry: the openid ID token of the same account, no chooser', async () => {
    const l = login();
    parked(l, { loginHint: SUBJECT });
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    click('continue-google');
    const q = query(p.win.location.assigned[0]!);
    expect(q).toMatchObject({ response_type: 'id_token', scope: 'openid', nonce: l.nonce, login_hint: SUBJECT });
    expect(q.prompt).toBeUndefined();
    expect(entryOf(q.state!)).toMatchObject({ leg: 'id', i: 1, h: SUBJECT, s: l.relayId, n: l.nonce });
  });

  it('email: the email step here, its token relayed to the login’s slot as usual', async () => {
    const l = login();
    parked(l);
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    click('continue-email');
    expect(p.page.stage).toBe('address');
    // The login's entry is back under its slot (as /login stores it), not parked.
    expect(entryOf(l.relayId)).toMatchObject({ f: Buffer.from(l.followKey).toString('base64url') });
    expect(entryOf(l.relayId).x).toBeUndefined();
    typeInto('email-address', 'ada@example.com');
    submit('email-send');
    await vi.waitFor(() => expect(p.page.stage).toBe('code'));
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(p.a.writeRelay).toHaveBeenCalled());
    expect(p.a.writeRelay.mock.calls[0]![0]).toBe(l.relayId);
    expect(await decrypt(l, l.relayId, p.a)).toEqual({ idToken: EMAIL_TOKEN });
  });

  it('closing the window on the chooser relays google_cancelled to the login’s slot at once (the vault: login_cancelled)', async () => {
    const l = login();
    parked(l);
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    await encrypted();
    p.win.dispatch('pagehide');
    expect(p.a.writeRelay).toHaveBeenCalledTimes(1);
    expect(p.a.writeRelay.mock.calls[0]![0]).toBe(l.relayId);
    expect(await decrypt(l, l.relayId, p.a)).toEqual({ error: GOOGLE_CANCELLED_RELAY_ERROR });
    // Nothing is left to reuse: no entry, no context.
    expect(entryOf(l.relayId)).toBeNull();
    expect(window.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + l.relayId)).toBeNull();
    // Only once.
    p.win.dispatch('pagehide');
    expect(p.a.writeRelay).toHaveBeenCalledTimes(1);
  });

  it('past the login’s limit (the vault has stopped waiting), the chooser starts nothing: Google or email says it took too long', async () => {
    for (const button of ['continue-google', 'continue-email']) {
      resetDom();
      const l = login();
      parked(l);
      let clock = NOW;
      const p = emailPage(l, api(), {}, () => clock);
      await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
      clock = NOW + EMAIL_STEP_LIMIT_MS;
      click(button);
      await vi.waitFor(() => expect(p.page.stage).toBe('error'));
      expect(p.page.notice, button).toBe('login_timeout');
      expect(p.win.location.assigned, button).toEqual([]);
      expect(entryOf(l.relayId), button).toBeNull();
      expect(p.a.writeRelay, button).not.toHaveBeenCalled();
    }
  });

  it('D348: a login the partner started with `method: google` comes back to Google only, though the app has email login', async () => {
    const l = login({ method: 'google' });
    parked(l);
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    expect(document.getElementById('google-cancelled')?.textContent).toBe(GOOGLE_CANCELLED_TEXT);
    expect(document.getElementById('continue-google')).not.toBeNull();
    expect(document.getElementById('continue-email')).toBeNull();
    click('continue-google');
    expect(query(p.win.location.assigned[0]!)).toMatchObject({ response_type: 'token', scope: 'openid email' });
    // Without a method named, the same app's chooser offers email too (the test above).
  });

  it('a record-only login’s chooser offers Google only', async () => {
    const l = login({ methods: ['google'] });
    parked(l, { record: true });
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('choosing'));
    expect(document.getElementById('continue-google')).not.toBeNull();
    expect(document.getElementById('continue-email')).toBeNull();
    click('continue-google');
    expect(entryOf(query(p.win.location.assigned[0]!).state!)).toMatchObject({ r: 1, s: l.relayId });
  });

  it('from case B: case B’s own choices again (Link and continue, Sign in with Google), the link riding only with Link', async () => {
    for (const button of ['email-link-google', 'email-google']) {
      resetDom();
      const l = login();
      parked(l, { back: 'case_b', offer: LINK });
      const p = emailPage(l);
      await vi.waitFor(() => expect(p.page.stage).toBe('google_wallet'));
      expect(document.getElementById('google-cancelled')?.textContent).toBe(GOOGLE_CANCELLED_TEXT);
      expect(pageText()).toContain('Link and continue');
      expect(document.getElementById('continue-email')).toBeNull();
      click(button);
      const q = query(p.win.location.assigned[0]!);
      expect(q).toMatchObject({ response_type: 'token', scope: 'openid email' });
      const e = entryOf(q.state!);
      expect(e, button).toMatchObject({ s: l.relayId, bk: 'b', ob: LINK, tf: 1 });
      expect(e.b === undefined, button).toBe(button === 'email-google');
    }
  });

  it('case B’s Cancel there ends the login (email_cancelled, the vault: login_cancelled); without an offer only Continue with Google', async () => {
    const l = login();
    parked(l, { back: 'case_b' });
    const p = emailPage(l);
    await vi.waitFor(() => expect(p.page.stage).toBe('google_wallet'));
    expect(document.getElementById('email-link-google')).toBeNull();
    expect(document.getElementById('email-google')?.textContent).toBe('Continue with Google');
    click('email-cancel');
    await vi.waitFor(() => expect(p.win.closed).toBe(true));
    expect(p.a.writeRelay.mock.calls.map((c) => c[0])).toEqual([l.relayId]);
    expect(await decrypt(l, l.relayId, p.a)).toEqual({ error: 'email_cancelled' });
  });

  it('a reload of the chooser (pagehide, then the page again) ends the login once and shows it expired', async () => {
    const l = login();
    parked(l);
    const first = emailPage(l);
    await vi.waitFor(() => expect(first.page.stage).toBe('choosing'));
    await encrypted();
    first.win.dispatch('pagehide');
    expect(await decrypt(l, l.relayId, first.a)).toEqual({ error: GOOGLE_CANCELLED_RELAY_ERROR });
    const again = emailPage(l);
    await vi.waitFor(() => expect(again.page.stage).toBe('error'));
    expect(again.page.notice).toBe('login_timeout');
    expect(again.a.writeRelay).not.toHaveBeenCalled();
  });
});
