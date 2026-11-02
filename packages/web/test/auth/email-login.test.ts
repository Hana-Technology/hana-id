// @vitest-environment happy-dom
// Email login in the popup (build plan batch 8a): /login's method chooser (still fetch-free, D77) and /login/email's
// states: address → start → code → verify → the relay; resend, a different email, wrong and expired codes, limits,
// case B (continue with Google), cancel (D245), the device ticket, and the vault's progress message.
import { ApiError, type RelayCiphertext, decryptRelayPayload, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import type { EmailApi } from '../../src/auth/email-api.ts';
import { type EmailPage, startEmailPage } from '../../src/auth/email-page.ts';
import { DEVICE_TICKET_PREFIX, EMAIL_ENTRY_PREFIX, deviceTicketFor, deviceTicketKey, readEmailContext, saveDeviceTicket } from '../../src/auth/email-storage.ts';
import { EMAIL_PATH, startLoginPage } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, flush, pageText, remoteWindow, resetDom } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'cd'.repeat(16)}`;
const NOW = 1_800_000_000_000;
const TICKET = `dt2.${'T'.repeat(75)}`;
const TICKET2 = `dt2.${'U'.repeat(75)}`;
const CID = 'c'.repeat(43);
const CID2 = 'd'.repeat(43);
const TOKEN = '{"payload":"eyJ","signatures":[{"protected":"eyJ","signature":"sig"}]}';

function authParams(over: Record<string, unknown> = {}) {
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

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  resetDom();
  window.localStorage.clear();
  fetchSpy = vi.fn(async () => {
    throw new Error('no fetch expected');
  });
  vi.stubGlobal('fetch', fetchSpy);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const click = (id: string) => (document.getElementById(id) as HTMLButtonElement).click();
const submit = (id: string) => (document.getElementById(id) as HTMLButtonElement).closest('form')!.dispatchEvent(new Event('submit', { cancelable: true }));
const typeInto = (id: string, value: string) => {
  (document.getElementById(id) as HTMLInputElement).value = value;
};

// ---- /login: the chooser ----

function loginSetup(env: HanaEnv = EMAIL_ENV) {
  const win = new FakeWindow('/login', `?v=${VAULT_FRAME}`);
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  const page = startLoginPage({ win, env, now: () => NOW });
  return { win, vault, page };
}

describe('/login method chooser', () => {
  it('a Google-only message goes straight to Google, as before', async () => {
    const s = loginSetup();
    s.win.message(authParams(), ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('redirecting');
    expect(new URL(s.win.location.assigned[0] as string).origin).toBe('https://accounts.google.com');
  });

  it('with email offered: shows both buttons and fetches nothing; Google goes to the same Google request', async () => {
    const s = loginSetup();
    const params = authParams({ methods: ['google', 'email'] });
    s.win.message(params, ENV.vaultOrigin, s.vault);
    expect((await s.page.done).stage).toBe('choosing');
    expect(pageText()).toContain('Continue with Google');
    expect(pageText()).toContain('Continue with email');
    expect(pageText()).toContain('Signing in to Partner App at https://partner.example');
    expect(s.win.location.assigned).toEqual([]);
    // The relay key is stored already, for either path.
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + params.relayId)).not.toBeNull();
    click('continue-google');
    const url = new URL(s.win.location.assigned[0] as string);
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('scope')).toBe('openid');
    expect(url.searchParams.get('nonce')).toBe(params.nonce);
    expect(url.searchParams.get('state')).toBe(params.relayId);
    expect(s.page.state.stage).toBe('redirecting');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('email: stores the email context (no relay key, no address) and goes to /login/email#<relayId>', async () => {
    const s = loginSetup();
    const params = authParams({ methods: ['google', 'email'], emailHint: 'ada@example.com' });
    const pub = Uint8Array.from(params.sessionPublicKey);
    s.win.message(params, ENV.vaultOrigin, s.vault);
    await s.page.done;
    click('continue-email');
    expect(s.win.location.assigned).toEqual([`${EMAIL_PATH}#${params.relayId}`]);
    const raw = s.win.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + params.relayId) as string;
    expect(raw).not.toContain('relayKey');
    const ctx = readEmailContext(s.win.sessionStorage, params.relayId, NOW)!.context;
    expect(ctx).toMatchObject({ pk: PK, scopeId: 's1', appName: 'Partner App', parentOrigin: PARTNER, clientId: CLIENT_ID, emailHint: 'ada@example.com', opener: 'partner', vaultFrame: VAULT_FRAME, challengeId: null });
    expect(ctx.sessionPublicKey).toEqual(pub);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a preselected method skips the chooser', async () => {
    const e = loginSetup();
    const pe = authParams({ methods: ['google', 'email'], method: 'email' });
    e.win.message(pe, ENV.vaultOrigin, e.vault);
    await e.page.done;
    expect(e.win.location.assigned).toEqual([`${EMAIL_PATH}#${pe.relayId}`]);
    resetDom();
    const g = loginSetup();
    g.win.message(authParams({ methods: ['google', 'email'], method: 'google' }), ENV.vaultOrigin, g.vault);
    await g.page.done;
    expect(new URL(g.win.location.assigned[0] as string).origin).toBe('https://accounts.google.com');
  });

  it('an env without an email issuer ignores the offer and goes to Google', async () => {
    const s = loginSetup(ENV);
    s.win.message(authParams({ methods: ['google', 'email'], method: 'email' }), ENV.vaultOrigin, s.vault);
    await s.page.done;
    expect(new URL(s.win.location.assigned[0] as string).origin).toBe('https://accounts.google.com');
  });
});

// ---- /login/email ----

interface Fakes {
  issuer: { start: ReturnType<typeof vi.fn>; resend: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  api: AuthApi & { writeRelay: ReturnType<typeof vi.fn> };
}

const challenge = (id = CID) => ({ challengeId: id, expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 });

function fakes(): Fakes {
  return {
    issuer: { start: vi.fn(async () => challenge()), resend: vi.fn(async () => challenge(CID2)), verify: vi.fn(async () => ({ kind: 'token', idToken: TOKEN, deviceTicket: TICKET })) },
    api: { getApp: vi.fn(), writeRelay: vi.fn(async () => {}), readRelay: vi.fn(), login: vi.fn() } as never,
  };
}

interface EmailSetup {
  win: FakeWindow;
  vault: RemoteWindow;
  page: EmailPage;
  f: Fakes;
  relayId: string;
  relayKey: Uint8Array;
  timers: (() => void)[];
}

function emailSetup(opts: { hint?: string | null; clientId?: string | null; env?: HanaEnv; storeEntry?: boolean; framed?: boolean; f?: Fakes } = {}): EmailSetup {
  const p = authParams();
  const relayId = p.relayId;
  const relayKey = Uint8Array.from(p.relayKey);
  const win = new FakeWindow(EMAIL_PATH, '', `#${relayId}`);
  const opener = remoteWindow();
  const vault = remoteWindow({ parent: opener });
  opener.frames[VAULT_FRAME] = vault;
  win.opener = asWindow(opener);
  if (opts.framed) win.top = {};
  if (opts.storeEntry !== false) {
    storeLoginEntry(win.sessionStorage, relayId, p.relayKey, NOW);
    win.sessionStorage.setItem(
      EMAIL_ENTRY_PREFIX + relayId,
      JSON.stringify({
        v: 1,
        createdAt: NOW,
        c: {
          pk: PK,
          appName: 'Partner App',
          parentOrigin: PARTNER,
          scopeId: 's1',
          sessionPublicKey: Buffer.from(p.sessionPublicKey).toString('base64url'),
          expiresAtMs: p.expiresAtMs,
          salt: Buffer.from(p.salt).toString('base64url'),
          keyIndex: 0,
          maxUses: 1,
          nonce: p.nonce,
          clientId: opts.clientId === undefined ? CLIENT_ID : opts.clientId,
          methods: ['google', 'email'],
          emailHint: opts.hint ?? null,
          opener: 'partner',
          vaultFrame: VAULT_FRAME,
          challengeId: null,
        },
      }),
    );
  }
  const f = opts.f ?? fakes();
  const timers: (() => void)[] = [];
  const page = startEmailPage({
    win,
    env: opts.env ?? EMAIL_ENV,
    issuer: f.issuer as unknown as EmailApi,
    api: f.api,
    tickets: window.localStorage,
    now: () => NOW,
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => {},
  });
  return { win, vault, page, f, relayId, relayKey, timers };
}

async function toCode(s: EmailSetup, address = 'Ada@Example.com'): Promise<void> {
  typeInto('email-address', address);
  submit('email-send');
  await flush();
  expect(s.page.stage).toBe('code');
}

describe('/login/email', () => {
  it('address → start → code → verify → relays the email token under the relay key and closes', async () => {
    const s = emailSetup({ hint: 'ada@example.com' });
    expect(s.page.stage).toBe('address');
    expect((document.getElementById('email-address') as HTMLInputElement).value).toBe('ada@example.com');
    await toCode(s);
    expect(s.f.issuer.start).toHaveBeenCalledTimes(1);
    const [pk, email, commitment, ticket] = s.f.issuer.start.mock.calls[0] as [string, string, Record<string, unknown>, string | null];
    expect([pk, email, ticket]).toEqual([PK, 'Ada@Example.com', null]);
    expect(commitment).toMatchObject({ scopeId: 's1', expiresAtMs: 1_900_000_000_000, keyIndex: 0, maxUses: 1 });
    // The vault hears the code went out (a progress signal only).
    expect(s.vault.postMessage).toHaveBeenCalledWith({ v: 1, t: 'hana:auth-progress', stage: 'email_code' }, ENV.vaultOrigin);
    const code = document.getElementById('email-code') as HTMLInputElement;
    expect(code.getAttribute('autocomplete')).toBe('one-time-code');
    expect(code.getAttribute('inputmode')).toBe('numeric');
    expect(pageText()).toContain('Ada@Example.com');
    typeInto('email-code', '123 456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('done'));
    expect(s.f.issuer.verify).toHaveBeenCalledWith(CID, '123456');
    expect(s.win.closed).toBe(true);
    const [state, value] = s.f.api.writeRelay.mock.calls[0] as [string, RelayCiphertext];
    expect(state).toBe(s.relayId);
    expect(await decryptRelayPayload(s.relayKey, s.relayId, value)).toEqual({ idToken: TOKEN });
    // Single use: both entries are gone; the device ticket is kept for this address (a hash key, no address stored).
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.relayId)).toBeNull();
    expect(s.win.sessionStorage.getItem(EMAIL_ENTRY_PREFIX + s.relayId)).toBeNull();
    expect(deviceTicketFor(window.localStorage, 'ada@example.com', NOW)).toBe(TICKET);
    for (let i = 0; i < window.localStorage.length; i++) expect(window.localStorage.key(i)).not.toContain('ada');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('a returning address sends its device ticket with start', async () => {
    saveDeviceTicket(window.localStorage, 'ada@example.com', TICKET, NOW - 86_400_000);
    const s = emailSetup();
    await toCode(s, ' ADA@example.com ');
    expect(s.f.issuer.start.mock.calls[0]?.[3]).toBe(TICKET);
  });

  it('resend after the issuer’s delay; a different email starts over', async () => {
    const s = emailSetup();
    await toCode(s);
    expect((document.getElementById('email-resend') as HTMLButtonElement).disabled).toBe(true);
    for (const t of s.timers) t();
    expect((document.getElementById('email-resend') as HTMLButtonElement).disabled).toBe(false);
    click('email-resend');
    await flush();
    expect(s.f.issuer.resend).toHaveBeenCalledWith(CID);
    expect(s.page.stage).toBe('code');
    expect(pageText()).toContain('A new code is on its way');
    typeInto('email-code', '654321');
    submit('email-verify');
    await flush(40);
    expect(s.f.issuer.verify).toHaveBeenCalledWith(CID2, '654321');

    const t = emailSetup();
    await toCode(t);
    click('email-other');
    expect(t.page.stage).toBe('address');
    await toCode(t, 'grace@example.com');
    expect(t.f.issuer.start.mock.calls[1]?.[1]).toBe('grace@example.com');
  });

  it('a wrong code shows the tries left; the last one, an expired code and a used one go back to the address', async () => {
    const s = emailSetup();
    await toCode(s);
    s.f.issuer.verify.mockRejectedValueOnce(new ApiError(400, 'code_invalid', 'Wrong code', null, null, { attemptsLeft: 3 }));
    typeInto('email-code', '000000');
    submit('email-verify');
    await flush();
    expect(s.page.stage).toBe('code');
    expect(pageText()).toContain('3 tries left');
    s.f.issuer.verify.mockRejectedValueOnce(new ApiError(400, 'code_invalid', 'Wrong code', null, null, { attemptsLeft: 0 }));
    typeInto('email-code', '000001');
    submit('email-verify');
    await flush();
    expect(s.page.stage).toBe('address');
    expect(pageText()).toContain('no tries left');
    await toCode(s);
    s.f.issuer.verify.mockRejectedValueOnce(new ApiError(410, 'challenge_expired', 'gone', null, null));
    typeInto('email-code', '000002');
    submit('email-verify');
    await flush();
    expect(s.page.stage).toBe('address');
    expect(s.page.notice).toBe('challenge_expired');
    expect(s.f.api.writeRelay).not.toHaveBeenCalled();
  });

  it('a malformed code is refused before any call', async () => {
    const s = emailSetup();
    await toCode(s);
    typeInto('email-code', '12345');
    submit('email-verify');
    await flush();
    expect(s.f.issuer.verify).not.toHaveBeenCalled();
    expect(pageText()).toContain('Enter the 6-digit code');
  });

  it('every limit is the same generic “try again later”', async () => {
    for (const err of [new ApiError(429, 'rate_limited', 'x', null, null), new ApiError(429, 'something_else', 'x', null, null)]) {
      resetDom();
      const s = emailSetup();
      s.f.issuer.start.mockRejectedValueOnce(err);
      typeInto('email-address', 'ada@example.com');
      submit('email-send');
      await flush();
      expect(s.page.stage).toBe('address');
      expect(pageText()).toContain('Too many attempts. Try again later.');
    }
    resetDom();
    const v = emailSetup();
    await toCode(v);
    v.f.issuer.verify.mockRejectedValueOnce(new ApiError(429, 'rate_limited', 'x', null, null));
    typeInto('email-code', '123456');
    submit('email-verify');
    await flush();
    expect(pageText()).toContain('Too many attempts. Try again later.');
  });

  it('an invalid or disposable address is told inline; an app without email ends the step', async () => {
    const s = emailSetup();
    typeInto('email-address', 'nope');
    submit('email-send');
    await flush();
    expect(s.f.issuer.start).not.toHaveBeenCalled();
    expect(pageText()).toContain('Enter a valid email address.');
    s.f.issuer.start.mockRejectedValueOnce(new ApiError(400, 'email_domain_not_allowed', 'x', null, null));
    typeInto('email-address', 'a@mailinator.com');
    submit('email-send');
    await flush();
    expect(pageText()).toContain('Addresses on this domain can’t be used');
    s.f.issuer.start.mockRejectedValueOnce(new ApiError(403, 'email_not_enabled', 'x', null, null));
    typeInto('email-address', 'ada@example.com');
    submit('email-send');
    await flush();
    expect(s.page.stage).toBe('error');
    expect(s.page.notice).toBe('login_method_unavailable');
  });

  it('cancel tells the vault why (D245) and closes', async () => {
    const plain = emailSetup();
    click('email-cancel');
    await vi.waitFor(() => expect(plain.page.stage).toBe('done'));
    expect(await decryptRelayPayload(plain.relayKey, plain.relayId, plain.f.api.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toEqual({ error: 'email_cancelled' });
    expect(plain.win.closed).toBe(true);

    resetDom();
    const wrong = emailSetup();
    await toCode(wrong);
    wrong.f.issuer.verify.mockRejectedValueOnce(new ApiError(400, 'code_invalid', 'Wrong code', null, null, { attemptsLeft: 4 }));
    typeInto('email-code', '000000');
    submit('email-verify');
    await flush();
    click('email-cancel');
    await vi.waitFor(() => expect(wrong.page.stage).toBe('done'));
    expect(await decryptRelayPayload(wrong.relayKey, wrong.relayId, wrong.f.api.writeRelay.mock.calls[0]?.[1] as RelayCiphertext)).toEqual({ error: 'email_code_invalid' });
  });

  it('case B: no token; “Continue with Google” is a plain Google login on the same slot (no link)', async () => {
    const s = emailSetup();
    s.f.issuer.verify.mockResolvedValueOnce({ kind: 'google_wallet', deviceTicket: TICKET2 });
    await toCode(s);
    typeInto('email-code', '123456');
    submit('email-verify');
    await flush();
    expect(s.page.stage).toBe('google_wallet');
    expect(s.f.api.writeRelay).not.toHaveBeenCalled();
    expect(deviceTicketFor(window.localStorage, 'ada@example.com', NOW)).toBe(TICKET2);
    click('email-google');
    const url = new URL(s.win.location.assigned[0] as string);
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('state')).toBe(s.relayId);
    expect(url.searchParams.get('scope')).toBe('openid');
    // The relay key stays for /login/callback.
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.relayId)).not.toBeNull();
  });

  it('refuses to run framed, without its context, or without an email issuer', () => {
    expect(emailSetup({ framed: true }).page.stage).toBe('error');
    resetDom();
    expect(emailSetup({ storeEntry: false }).page.notice).toBe('login_timeout');
    resetDom();
    expect(emailSetup({ env: ENV }).page.stage).toBe('error');
  });

  it('a relay that refuses the write shows the error and keeps the window open', async () => {
    const f = fakes();
    f.api.writeRelay.mockRejectedValueOnce(new ApiError(409, 'relay_used', 'used', null, null));
    const s = emailSetup({ f });
    await toCode(s);
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('error'));
    expect(s.win.closed).toBe(false);
  });
});

describe('device tickets', () => {
  it('keeps at most 5, drops expired and malformed ones, and keys by a hash of the address', () => {
    const ls = window.localStorage;
    for (let i = 0; i < 6; i++) saveDeviceTicket(ls, `u${i}@example.com`, `dt2.${String(i).repeat(75)}`, NOW + i);
    const keys = () => Array.from({ length: ls.length }, (_, i) => ls.key(i) as string).filter((k) => k.startsWith(DEVICE_TICKET_PREFIX));
    expect(keys()).toHaveLength(5);
    expect(deviceTicketFor(ls, 'u0@example.com', NOW + 10)).toBeNull();
    expect(deviceTicketFor(ls, 'U5@Example.com ', NOW + 10)).toBe(`dt2.${'5'.repeat(75)}`);
    expect(deviceTicketFor(ls, 'u5@example.com', NOW + 31 * 86_400_000)).toBeNull();
    saveDeviceTicket(ls, 'x@example.com', 'not-a-ticket', NOW);
    expect(ls.getItem(deviceTicketKey('x@example.com'))).toBeNull();
    expect(deviceTicketFor(null, 'u5@example.com', NOW)).toBeNull();
  });
});
