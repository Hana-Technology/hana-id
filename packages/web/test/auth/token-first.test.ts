// @vitest-environment happy-dom
// token_first, popup side (D270, D273; auth/google.ts): the request builders under every flow (the request whose ID
// token is relayed asks for `scope=openid` only, never `email`), tokeninfo's login hint (`accessTokenSub`), /login's
// token_first request and entry, and /login/callback's two legs: the access token (tokeninfo, slot 1, the silent ID
// request) and the ID token (its `sub` against the hint, one interactive retry, the claim allow-list before relaying).
import { type RelayCiphertext, decryptRelayPayload, followSlot, relayIdFor, sessionNonce } from '@hana-id/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import { runCallbackPage } from '../../src/auth/callback-page.ts';
import { readEmailContext } from '../../src/auth/email-storage.ts';
import {
  type AccessTokenSub,
  GOOGLE_AUTH_URL,
  GOOGLE_EMAIL_FLOW,
  GOOGLE_TOKENINFO_URL,
  type GoogleEmailFlow,
  accessTokenSub,
  googleAccessUrl,
  googleAuthUrl,
  googleTokenFirstUrl,
  loginGoogleRequest,
} from '../../src/auth/google.ts';
import { startLoginPage } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, asWindow, pageText, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

const FLOWS: readonly GoogleEmailFlow[] = ['second_request', 'token_first'];
const NOW = 1_800_000_000_000;
const AUTH = 'https://auth.hana-auth.test';
const SUBJECT = '110248495921238986420';
const NONCE = 'N'.repeat(43);
const ACCESS = 'ya29.token-first';
const jwt = (claims: Record<string, unknown>) => [{ alg: 'RS256' }, claims].map((p) => Buffer.from(JSON.stringify(p)).toString('base64url')).concat('c2ln').join('.');
/** A JWT-shaped placeholder with the spike's openid claims (built at runtime: no token-like literal in the source). */
const GTOKEN = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, azp: CLIENT_ID, sub: SUBJECT, nonce: NONCE, iat: 1, exp: 2 });

beforeEach(() => resetDom());

const query = (url: string) => {
  const u = new URL(url);
  expect(`${u.origin}${u.pathname}`).toBe(GOOGLE_AUTH_URL);
  return Object.fromEntries(u.searchParams);
};

describe('the flow in force', () => {
  it('is token_first: switched on after the spike passed every leg (2026-11-04, D270); second_request stays the tested fallback', () => {
    expect(GOOGLE_EMAIL_FLOW).toBe('token_first');
  });
});

describe('the requests whose ID token goes on chain ask for scope=openid only (D25, D270)', () => {
  it('under every flow, every login shape: an ID token request is `id_token` + `openid`; token_first’s first request asks for no ID token', () => {
    expect(FLOWS).toContain(GOOGLE_EMAIL_FLOW);
    for (const flow of FLOWS) {
      for (const follow of [false, true]) {
        for (const task of [false, true]) {
          for (const forceReauth of [false, true]) {
            const r = loginGoogleRequest({ flow, clientId: CLIENT_ID, authOrigin: AUTH, nonce: NONCE, state: 's'.repeat(43), follow, task, forceReauth });
            const q = query(r.url);
            const label = JSON.stringify({ flow, follow, task, forceReauth });
            expect(r.tokenFirst, label).toBe(flow === 'token_first' && follow && !task && !forceReauth);
            if (q.response_type?.includes('id_token')) {
              expect([q.response_type, q.scope], label).toEqual(['id_token', 'openid']);
              expect(q.nonce, label).toBe(NONCE);
            } else {
              // token_first's first request: the access token only, never an ID token, so never a nonce.
              expect([q.response_type, q.scope, q.prompt, q.nonce], label).toEqual(['token', 'openid email', 'select_account', undefined]);
            }
            expect(q.scope?.split(' ').includes('email') && q.response_type?.includes('id_token'), label).toBe(false);
          }
        }
      }
    }
  });

  it('googleAuthUrl can build nothing but openid: the chooser, a proof’s hint, the silent and interactive ID requests, export', () => {
    const base = { clientId: CLIENT_ID, authOrigin: AUTH, nonce: NONCE, state: 's'.repeat(43) };
    const shapes = [
      googleAuthUrl({ ...base, forceReauth: false }),
      googleAuthUrl({ ...base, forceReauth: true }),
      googleAuthUrl({ ...base, forceReauth: false, loginHint: SUBJECT }),
      googleAuthUrl({ ...base, forceReauth: false, loginHint: SUBJECT, silent: true }),
    ].map(query);
    for (const q of shapes) expect([q.response_type, q.scope, q.nonce]).toEqual(['id_token', 'openid', NONCE]);
    expect(shapes.map((q) => [q.prompt, q.login_hint, q.max_age])).toEqual([
      ['select_account', undefined, undefined],
      ['select_account', undefined, '0'],
      [undefined, SUBJECT, undefined],
      ['none', SUBJECT, undefined],
    ]);
    // The access requests never ask for an ID token.
    expect(query(googleTokenFirstUrl({ clientId: CLIENT_ID, authOrigin: AUTH, state: 's'.repeat(43) })).response_type).toBe('token');
    expect(query(googleAccessUrl({ clientId: CLIENT_ID, authOrigin: AUTH, state: 's'.repeat(43), loginHint: SUBJECT, silent: true }))).toMatchObject({ response_type: 'token', scope: 'email' });
  });
});

describe('accessTokenSub: tokeninfo, from the browser (D270)', () => {
  const answer = (status: number, body: unknown) => vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }));
  const good = { aud: CLIENT_ID, azp: CLIENT_ID, sub: SUBJECT, scope: 'openid https://www.googleapis.com/auth/userinfo.email', expires_in: '3599' };

  it('POSTs the token in a form body (never in the URL), no cookies or referrer, and reads the `sub`', async () => {
    const f = answer(200, good);
    expect(await accessTokenSub(ACCESS, CLIENT_ID, f as never)).toEqual({ ok: true, sub: SUBJECT });
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(GOOGLE_TOKENINFO_URL);
    expect(url).not.toContain(ACCESS);
    expect(init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(init.body).toBe(`access_token=${ACCESS}`);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it.each<[string, () => typeof fetch, AccessTokenSub]>([
    ['another client’s token (aud)', () => answer(200, { ...good, aud: 'other.apps.googleusercontent.com' }) as never, { ok: false, reason: 'wrong_client' }],
    ['another client’s token (azp)', () => answer(200, { ...good, azp: 'other.apps.googleusercontent.com' }) as never, { ok: false, reason: 'wrong_client' }],
    ['an expired token', () => answer(200, { ...good, expires_in: '0' }) as never, { ok: false, reason: 'invalid' }],
    ['no sub', () => answer(200, { ...good, sub: undefined }) as never, { ok: false, reason: 'invalid' }],
    ['a malformed sub', () => answer(200, { ...good, sub: 'a#b' }) as never, { ok: false, reason: 'invalid' }],
    ['a refusal', () => answer(400, { error: 'invalid_token' }) as never, { ok: false, reason: 'invalid' }],
    ['not JSON', () => answer(200, '<html>') as never, { ok: false, reason: 'invalid' }],
    ['an oversized answer', () => answer(200, 'x'.repeat(20_000)) as never, { ok: false, reason: 'invalid' }],
    ['a Google outage', () => answer(503, {}) as never, { ok: false, reason: 'unavailable' }],
    ['a network error or a CORS refusal', () => vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))) as never, { ok: false, reason: 'unavailable' }],
  ])('%s', async (_, f, want) => {
    expect(await accessTokenSub(ACCESS, CLIENT_ID, f())).toEqual(want);
  });
});

// ---- /login ----

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'cd'.repeat(16)}`;

function params(over: Record<string, unknown> = {}) {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const base = { signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1, salt };
  return {
    v: 1,
    t: 'hana:auth-params',
    pk: PK,
    appName: 'Partner App',
    parentOrigin: PARTNER,
    scopeId: 's1',
    signer: ENV.signer,
    clientId: CLIENT_ID,
    mode: 'shared',
    sessionPublicKey,
    expiresAtMs: base.expiresAtMs,
    salt,
    keyIndex: 0,
    maxUses: 1,
    nonce: sessionNonce(base),
    relayId: relayIdFor(crypto.getRandomValues(new Uint8Array(32))),
    relayKey: crypto.getRandomValues(new Uint8Array(32)),
    ...over,
  };
}

function loginPage(flow: GoogleEmailFlow) {
  const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  vaultAcks(vault, win);
  const page = startLoginPage({ win, env: EMAIL_ENV, now: () => NOW, googleEmailFlow: flow });
  return { win, vault, page };
}

describe('/login under token_first', () => {
  it('an app with email login: the access token request first; the entry keeps the nonce for the ID request after it', async () => {
    const s = loginPage('token_first');
    const p = params({ methods: ['google', 'email'], method: 'google', followKey: crypto.getRandomValues(new Uint8Array(32)) });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(query(s.win.location.assigned[0]!)).toMatchObject({ response_type: 'token', scope: 'openid email', prompt: 'select_account', state: p.relayId });
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!);
    expect(entry).toMatchObject({ tf: 1, n: p.nonce, c: CLIENT_ID });
    expect(entry.r).toBeUndefined();
    // The follow-up mode's context, as in second_request, with the method the partner named (D348).
    expect(readEmailContext(s.win.sessionStorage, p.relayId, NOW)?.context).toMatchObject({ methods: ['google', 'email'], method: 'google' });
  });

  it('a record-only login (`emailRecord`, an app without email login): the same request, marked `r`; an email context with Google only (D341’s screen after a cancel)', async () => {
    const s = loginPage('token_first');
    const p = params({ emailRecord: true, followKey: crypto.getRandomValues(new Uint8Array(32)) });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(query(s.win.location.assigned[0]!)).toMatchObject({ response_type: 'token', scope: 'openid email' });
    expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!)).toMatchObject({ tf: 1, r: 1, n: p.nonce });
    expect(readEmailContext(s.win.sessionStorage, p.relayId, NOW)?.context).toMatchObject({ methods: ['google'], clientId: CLIENT_ID, appName: 'Partner App' });
  });

  it('a Google-only login (no follow-up key) and a link task stay openid-only ID token requests', async () => {
    const plain = loginPage('token_first');
    const p = params();
    plain.win.message(p, ENV.vaultOrigin, plain.vault);
    await plain.page.done;
    expect(query(plain.win.location.assigned[0]!)).toMatchObject({ response_type: 'id_token', scope: 'openid', nonce: p.nonce });
    expect(JSON.parse(plain.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + p.relayId)!).tf).toBeUndefined();
    resetDom();
    const task = loginPage('token_first');
    const nonce = 'L'.repeat(43);
    const t = params({ methods: ['google', 'email'], followKey: crypto.getRandomValues(new Uint8Array(32)), task: { kind: 'link', provider: 'google', prove: { method: 'google', nonce, loginHint: null } } });
    task.win.message(t, ENV.vaultOrigin, task.vault);
    await task.page.done;
    expect(query(task.win.location.assigned[0]!)).toMatchObject({ response_type: 'id_token', scope: 'openid', nonce });
  });

  it('second_request: a record-only message (a vault ahead of this popup) makes batch B’s openid request', async () => {
    const s = loginPage('second_request');
    const p = params({ emailRecord: true, followKey: crypto.getRandomValues(new Uint8Array(32)) });
    s.win.message(p, ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(query(s.win.location.assigned[0]!)).toMatchObject({ response_type: 'id_token', scope: 'openid' });
  });
});

// ---- /login/callback ----

function api(write?: AuthApi['writeRelay']): AuthApi & { writeRelay: ReturnType<typeof vi.fn> } {
  return { getApp: vi.fn(), writeRelay: vi.fn(write ?? (async () => {})), readRelay: vi.fn(), login: vi.fn() } as never;
}

/** A token_first login /login started (the entry it stored), and the callback window Google redirected to. */
function started(hash: (state: string) => string, extra: Parameters<typeof storeLoginEntry>[5] = {}) {
  const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const followKey = crypto.getRandomValues(new Uint8Array(32));
  const win = new FakeWindow('/login/callback', '', hash(state));
  storeLoginEntry(win.sessionStorage, state, Uint8Array.from(relayKey), NOW, undefined, { followKey: Uint8Array.from(followKey), clientId: CLIENT_ID, tokenFirst: true, nonce: NONCE, ...extra });
  return { state, relayKey, followKey, win, slot1: followSlot(followKey, 1).id };
}

/** The ID leg's entry (what the first leg stores), under the login's own slot. */
function idLeg(hash: (state: string) => string, extra: Parameters<typeof storeLoginEntry>[5] = {}) {
  return started(hash, { leg: 'id', loginHint: SUBJECT, ...extra });
}

const decrypt = (key: Uint8Array, id: string, a: ReturnType<typeof api>, n = 0) => decryptRelayPayload(key, id, a.writeRelay.mock.calls[n]?.[1] as RelayCiphertext);
const tokenInfo = (r: AccessTokenSub = { ok: true, sub: SUBJECT }) => vi.fn(async () => r);
const run = (win: FakeWindow, a: ReturnType<typeof api>, ti = tokenInfo()) => runCallbackPage({ win, api: a, now: () => NOW, authOrigin: AUTH, tokenInfo: ti });

describe('/login/callback, token_first’s access leg', () => {
  it('asks tokeninfo, relays the access token to slot 1 at once, then asks Google silently for the openid ID token of that sub', async () => {
    const s = started((st) => `#access_token=${ACCESS}&token_type=Bearer&expires_in=3599&scope=openid%20email&state=${st}`);
    const a = api();
    const ti = tokenInfo();
    expect(await run(s.win, a, ti)).toBe('relayed');
    expect(ti).toHaveBeenCalledWith(ACCESS, CLIENT_ID);
    // Only slot 1 is written: the login's own slot waits for the ID token.
    expect(a.writeRelay.mock.calls.map((c) => c[0])).toEqual([s.slot1]);
    expect(await decrypt(s.relayKey, s.slot1, a)).toEqual({ accessToken: ACCESS });
    expect(query(s.win.location.assigned[0]!)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${AUTH}/login/callback`,
      response_type: 'id_token',
      response_mode: 'fragment',
      scope: 'openid',
      nonce: NONCE,
      state: s.state,
      login_hint: SUBJECT,
      prompt: 'none',
    });
    // The ID leg's entry, under the same slot; the access token itself is never stored.
    const raw = s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.state)!;
    expect(JSON.parse(raw)).toMatchObject({ leg: 'id', h: SUBJECT, n: NONCE, tf: 1 });
    expect(raw).not.toContain(ACCESS);
    expect(s.win.closed).toBe(false);
    expect(pageText()).not.toContain(ACCESS);
  });

  it.each<[string, AccessTokenSub, string]>([
    ['tokeninfo can’t be reached (or the browser refused its answer)', { ok: false, reason: 'unavailable' }, 'tokeninfo_unavailable'],
    ['the access token is another client’s', { ok: false, reason: 'wrong_client' }, 'tokeninfo_client_mismatch'],
    ['tokeninfo refuses the token', { ok: false, reason: 'invalid' }, 'tokeninfo_invalid'],
  ])('an app with email login, %s: the login ends with a clear error, never an unhinted request (D255)', async (_, info, code) => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`);
    const a = api();
    expect(await run(s.win, a, tokenInfo(info))).toBe('stopped');
    expect(a.writeRelay.mock.calls.map((c) => c[0])).toEqual([s.state]);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: code });
    expect(s.win.location.assigned).toEqual([]);
    expect(pageText()).toContain(`Code: ${code}`);
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.state)).toBeNull();
  });

  it.each<[string, AccessTokenSub]>([
    ['tokeninfo can’t be reached (network, CORS, a timeout, an outage)', { ok: false, reason: 'unavailable' }],
    ['tokeninfo refuses the token', { ok: false, reason: 'invalid' }],
  ])('a record-only login, %s: no slot 1, the access token dropped, batch B’s openid request with the chooser and the login’s nonce', async (_, info) => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`, { record: true });
    const a = api();
    expect(await run(s.win, a, tokenInfo(info))).toBe('relayed');
    // Nothing relayed yet: not slot 1, not the login's slot.
    expect(a.writeRelay).not.toHaveBeenCalled();
    expect(query(s.win.location.assigned[0]!)).toEqual({
      client_id: CLIENT_ID,
      redirect_uri: `${AUTH}/login/callback`,
      response_type: 'id_token',
      response_mode: 'fragment',
      scope: 'openid',
      nonce: NONCE,
      state: s.state,
      prompt: 'select_account',
    });
    // A plain login's entry under the login's slot: no follow-up key, no leg, no hint; the access token isn't in it.
    const raw = s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.state)!;
    const entry = JSON.parse(raw);
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'relayKey', 'v']);
    expect(raw).not.toContain(ACCESS);
    expect(s.win.closed).toBe(false);
    // Google's answer: the ID token is relayed without `access: 'follow'` (the vault reads no slot 1), and the window closes.
    s.win.location.hash = `#id_token=${GTOKEN}&state=${s.state}`;
    expect(await run(s.win, a)).toBe('relayed');
    expect(a.writeRelay.mock.calls.map((c) => c[0])).toEqual([s.state]);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ idToken: GTOKEN });
    expect(s.win.closed).toBe(true);
    expect(JSON.stringify(a.writeRelay.mock.calls)).not.toContain(ACCESS);
  });

  it('a record-only fallback still holds the ID token to the claim allow-list, and relays Google’s refusal', async () => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`, { record: true });
    const a = api();
    await run(s.win, a, tokenInfo({ ok: false, reason: 'unavailable' }));
    s.win.location.hash = `#id_token=${jwt({ sub: SUBJECT, nonce: NONCE, email: 'a@gmail.com' })}&state=${s.state}`;
    expect(await run(s.win, a)).toBe('stopped');
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'token_has_pii', claim: 'email' });
    resetDom();
    const r = started((st) => `#access_token=${ACCESS}&state=${st}`, { record: true });
    const b = api();
    await run(r.win, b, tokenInfo({ ok: false, reason: 'invalid' }));
    r.win.location.hash = `#error=access_denied&state=${r.state}`;
    expect(await run(r.win, b)).toBe('relayed');
    expect(await decrypt(r.relayKey, r.state, b)).toEqual({ error: 'access_denied' });
    expect(r.win.closed).toBe(true);
  });

  it('a record-only login with another client’s access token still ends (not an outage)', async () => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`, { record: true });
    const a = api();
    expect(await run(s.win, a, tokenInfo({ ok: false, reason: 'wrong_client' }))).toBe('stopped');
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'tokeninfo_client_mismatch' });
    expect(s.win.location.assigned).toEqual([]);
  });

  it('a record-only fallback that can’t store its entry tells the vault (storage_unavailable)', async () => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`, { record: true });
    const a = api();
    const real = s.win.sessionStorage;
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
    Object.defineProperty(s.win, 'sessionStorage', { value: blocked });
    expect(await run(s.win, a, tokenInfo({ ok: false, reason: 'unavailable' }))).toBe('relay_failed');
    expect(a.writeRelay.mock.calls.map((c) => c[0])).toEqual([s.state]);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'storage_unavailable' });
    expect(s.win.location.assigned).toEqual([]);
  });

  it('an ID token answered to the access request is never relayed (it would carry the email)', async () => {
    const s = started((st) => `#id_token=${jwt({ sub: SUBJECT, email: 'a@gmail.com' })}&access_token=${ACCESS}&state=${st}`);
    const a = api();
    const ti = tokenInfo();
    await run(s.win, a, ti);
    expect(ti).not.toHaveBeenCalled();
    expect(a.writeRelay).toHaveBeenCalledTimes(1);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'invalid_response' });
  });

  it('Google’s error with no email context to go back to is relayed: no Google login at all (with one, a cancel goes back to the chooser: google-cancel.test.ts, D341)', async () => {
    const s = started((st) => `#error=access_denied&state=${st}`);
    const a = api();
    await run(s.win, a);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'access_denied' });
    // An app with email login hears the vault's last word in the follow-up mode.
    expect(s.win.location.assigned).toEqual([`/login/email#${s.state}`]);
    // A record-only login closes.
    resetDom();
    const r = started((st) => `#error=access_denied&state=${st}`, { record: true });
    const b = api();
    await run(r.win, b);
    expect(await decrypt(r.relayKey, r.state, b)).toEqual({ error: 'access_denied' });
    expect(r.win.closed).toBe(true);
  });

  it('slot 1 can’t be written: the login’s slot says so, nothing else is asked of Google', async () => {
    const s = started((st) => `#access_token=${ACCESS}&state=${st}`);
    let n = 0;
    const a = api(async () => {
      if (n++ === 0) throw new TypeError('Failed to fetch');
    });
    expect(await run(s.win, a)).toBe('relay_failed');
    expect(a.writeRelay.mock.calls.map((c) => c[0])).toEqual([s.slot1, s.state]);
    expect(await decrypt(s.relayKey, s.state, a, 1)).toEqual({ error: 'relay_failed' });
    expect(s.win.location.assigned).toEqual([]);
  });
});

describe('/login/callback, token_first’s ID leg', () => {
  it('an app with email login: relays the openid token with `access: follow`, then the follow-up mode', async () => {
    const s = idLeg((st) => `#id_token=${GTOKEN}&state=${st}`);
    const a = api();
    expect(await run(s.win, a)).toBe('relayed');
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ idToken: GTOKEN, access: 'follow' });
    expect(s.win.location.assigned).toEqual([`/login/email#${s.state}`]);
    expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.state)!)).toMatchObject({ next: 2 });
  });

  it('a record-only login: relays the same, then closes (no follow-up mode); case B’s proof rides in an email app', async () => {
    const r = idLeg((st) => `#id_token=${GTOKEN}&state=${st}`, { record: true });
    const a = api();
    expect(await run(r.win, a)).toBe('relayed');
    expect(await decrypt(r.relayKey, r.state, a)).toEqual({ idToken: GTOKEN, access: 'follow' });
    expect(r.win.closed).toBe(true);
    expect(r.win.location.assigned).toEqual([]);
    resetDom();
    const caseB = { linkTicket: 'T'.repeat(43), emailSub: `e1.${'Q'.repeat(43)}` };
    const b = idLeg((st) => `#id_token=${GTOKEN}&state=${st}`, { caseB });
    const c = api();
    await run(b.win, c);
    expect(await decrypt(b.relayKey, b.state, c)).toEqual({ idToken: GTOKEN, access: 'follow', caseB });
  });

  it('an ID token of another account than tokeninfo’s ends the login (google_account_mismatch), nothing relayed', async () => {
    const other = jwt({ iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: '1999', nonce: NONCE, iat: 1, exp: 2 });
    const s = idLeg((st) => `#id_token=${other}&state=${st}`);
    const a = api();
    expect(await run(s.win, a)).toBe('stopped');
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'google_account_mismatch' });
    expect(JSON.stringify(a.writeRelay.mock.calls)).not.toContain(other);
    expect(pageText()).toContain('another account');
  });

  it('D273: a silent failure is asked once more interactively (openid only, the same account); a second failure is relayed', async () => {
    for (const error of ['login_required', 'interaction_required', 'consent_required', 'account_selection_required']) {
      resetDom();
      const s = idLeg((st) => `#error=${error}&state=${st}`);
      const a = api();
      expect(await run(s.win, a), error).toBe('relayed');
      expect(a.writeRelay).not.toHaveBeenCalled();
      // No Hana screen first: Google asks for nothing new (the email was granted on its first screen).
      const q = query(s.win.location.assigned[0]!);
      expect(q).toMatchObject({ response_type: 'id_token', scope: 'openid', nonce: NONCE, login_hint: SUBJECT, state: s.state });
      expect(q.prompt).toBeUndefined();
      expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.state)!)).toMatchObject({ leg: 'id', i: 1 });
      // Google fails again: relayed this time, the vault ends the login.
      s.win.location.hash = `#error=${error}&state=${s.state}`;
      expect(await run(s.win, a)).toBe('relayed');
      expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error });
    }
  });

  it('other errors are relayed at once (no retry); an access token answered here is refused', async () => {
    const s = idLeg((st) => `#error=access_denied&state=${st}`);
    const a = api();
    await run(s.win, a);
    expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'access_denied' });
    resetDom();
    const t = idLeg((st) => `#access_token=${ACCESS}&state=${st}`);
    const b = api();
    await run(t.win, b);
    expect(await decrypt(t.relayKey, t.state, b)).toEqual({ error: 'invalid_response' });
  });
});

describe('D264’s explainer (“One more step with Google”) never shows under token_first', () => {
  const noExplainer = (label: string) => {
    expect(document.getElementById('email-prompt-continue'), label).toBeNull();
    expect(pageText(), label).not.toContain('One more step with Google');
  };

  it('on the access leg (Google’s answer, success or any error), the ID leg (silent failures, the interactive retry, success) and for a record-only login', async () => {
    for (const record of [false, true]) {
      const extra = record ? { record: true } : {};
      for (const error of [...['login_required', 'interaction_required', 'consent_required', 'account_selection_required'], 'access_denied']) {
        resetDom();
        const s = started((st) => `#error=${error}&state=${st}`, extra);
        const a = api();
        expect(await run(s.win, a), `access ${error}`).toBe('relayed');
        noExplainer(`access ${error} record=${record}`);
        expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error });
        // The ID leg: the first silent failure goes straight to Google's own page; the second is relayed.
        resetDom();
        const t = idLeg((st) => `#error=${error}&state=${st}`, extra);
        const b = api();
        expect(await run(t.win, b)).toBe('relayed');
        noExplainer(`id ${error} record=${record}`);
        if (error === 'access_denied') continue;
        t.win.location.hash = `#error=${error}&state=${t.state}`;
        expect(await run(t.win, b)).toBe('relayed');
        noExplainer(`id retry ${error} record=${record}`);
      }
      resetDom();
      const ok = started((st) => `#access_token=${ACCESS}&state=${st}`, extra);
      expect(await run(ok.win, api())).toBe('relayed');
      noExplainer(`access token record=${record}`);
      resetDom();
      const id = idLeg((st) => `#id_token=${GTOKEN}&state=${st}`, extra);
      expect(await run(id.win, api())).toBe('relayed');
      noExplainer(`id token record=${record}`);
    }
  });
});

describe('the claim allow-list before anything is relayed (D270)', () => {
  it.each([
    ['token_first’s ID leg', (c: Record<string, unknown>) => idLeg((st) => `#id_token=${jwt(c)}&state=${st}`)],
    ['second_request’s login token', (c: Record<string, unknown>) => started((st) => `#id_token=${jwt(c)}&state=${st}`, { tokenFirst: false, nonce: undefined })],
    [
      'a Google-only login',
      (c: Record<string, unknown>) => {
        const state = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
        const relayKey = crypto.getRandomValues(new Uint8Array(32));
        const win = new FakeWindow('/login/callback', '', `#id_token=${jwt(c)}&state=${state}`);
        storeLoginEntry(win.sessionStorage, state, Uint8Array.from(relayKey), NOW);
        return { state, relayKey, win };
      },
    ],
  ])('%s: a token with email, email_verified or hd is never relayed; the slot says token_has_pii', async (_, make) => {
    for (const claim of [{ email: 'someone@gmail.com' }, { email_verified: true }, { hd: 'corp.example' }, { name: 'Someone' }]) {
      resetDom();
      const claims = { iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: SUBJECT, nonce: NONCE, ...claim };
      const s = make(claims);
      const a = api();
      expect(await run(s.win, a)).toBe('stopped');
      expect(a.writeRelay).toHaveBeenCalledTimes(1);
      expect(await decrypt(s.relayKey, s.state, a)).toEqual({ error: 'token_has_pii', claim: Object.keys(claim)[0] });
      expect(JSON.stringify(a.writeRelay.mock.calls)).not.toContain(jwt(claims));
      expect(s.win.location.assigned).toEqual([]);
      expect(pageText()).toContain('Code: token_has_pii');
    }
  });
});
