// @vitest-environment happy-dom
// /login/email in batch 8b: case B's "Link and continue" (the ticket and the address's `sub` stored for the callback,
// D139), and the follow-up mode: the vault's notices read from their slots (link_code, use_email, prove, done with
// banners and their Cancel, stop) and the popup's answers written to the next slot.
import { type FollowNotice, type RelayCiphertext, decryptRelayPayload, encryptRelayValue, followSlot, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import type { EmailApi } from '../../src/auth/email-api.ts';
import { type EmailPage, startEmailPage } from '../../src/auth/email-page.ts';
import { EMAIL_ENTRY_PREFIX } from '../../src/auth/email-storage.ts';
import { EMAIL_PATH } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, asWindow, flush, pageText, remoteWindow, resetDom } from './helpers.ts';

const ISSUER = 'https://issuer.hana-email.test';
const EMAIL_ENV: HanaEnv = Object.freeze({ ...ENV, emailIssuerUrl: ISSUER, emailIss: `${ISSUER}/v1/email` });
const VAULT_FRAME = `hana-vault-${'cd'.repeat(16)}`;
const NOW = 1_800_000_000_000;
const CID = 'c'.repeat(43);
const TOKEN = '{"payload":"eyJ","signatures":[{"protected":"eyJ","signature":"sig"}]}';
const SUBJECT = '110248495921238986420';
const E_SUB = `e1.${'Q'.repeat(43)}`;

beforeEach(() => {
  resetDom();
  window.localStorage.clear();
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

interface Setup {
  win: FakeWindow;
  page: EmailPage;
  issuer: { start: ReturnType<typeof vi.fn>; startLink: ReturnType<typeof vi.fn>; resend: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> };
  api: AuthApi & { writeRelay: ReturnType<typeof vi.fn>; readRelay: ReturnType<typeof vi.fn> };
  relayId: string;
  relayKey: Uint8Array;
  followKey: Uint8Array;
  nonce: string;
  /** The vault writes notice `n` (encrypted as the vault does). */
  vaultSays(n: number, notice: FollowNotice): Promise<void>;
  /** The popup's answer in slot `n`, decrypted. */
  answerIn(n: number): Promise<unknown>;
}

/** The page with a login of an app with email: the context, and the login entry (`next` set: follow-up mode). */
function setup(o: { next?: number } = {}): Setup {
  const sessionPublicKey = crypto.getRandomValues(new Uint8Array(32));
  const salt = crypto.getRandomValues(new Uint8Array(32));
  const expiresAtMs = 1_900_000_000_000;
  const nonce = sessionNonce({ signer: ENV.signer, scopeId: 's1', sessionPublicKey, expiresAtMs, keyIndex: 0, maxUses: 1, salt });
  const relayId = relayIdFor(crypto.getRandomValues(new Uint8Array(32)));
  const relayKey = crypto.getRandomValues(new Uint8Array(32));
  const followKey = crypto.getRandomValues(new Uint8Array(32));
  const win = new FakeWindow(EMAIL_PATH, '', `#${relayId}`);
  const opener = remoteWindow();
  opener.frames[VAULT_FRAME] = remoteWindow({ parent: opener });
  win.opener = asWindow(opener);
  storeLoginEntry(win.sessionStorage, relayId, Uint8Array.from(relayKey), NOW, undefined, { followKey: Uint8Array.from(followKey), clientId: CLIENT_ID, ...(o.next ? { home: relayId, next: o.next } : {}) });
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
        sessionPublicKey: Buffer.from(sessionPublicKey).toString('base64url'),
        expiresAtMs,
        salt: Buffer.from(salt).toString('base64url'),
        keyIndex: 0,
        maxUses: 1,
        nonce,
        clientId: CLIENT_ID,
        methods: ['google', 'email'],
        emailHint: null,
        opener: 'partner',
        vaultFrame: VAULT_FRAME,
        challengeId: null,
      },
    }),
  );
  const slots = new Map<string, RelayCiphertext>();
  const issuer = {
    start: vi.fn(async () => ({ challengeId: CID, expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 })),
    startLink: vi.fn(async () => ({ challengeId: CID, expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 })),
    resend: vi.fn(async () => ({ challengeId: CID, expiresAtMs: NOW + 600_000, resendAfterMs: NOW + 30_000 })),
    verify: vi.fn(async () => ({ kind: 'token', idToken: TOKEN, deviceTicket: null })),
  };
  const api = {
    getApp: vi.fn(),
    login: vi.fn(),
    writeRelay: vi.fn(async (id: string, v: RelayCiphertext) => {
      slots.set(id, v);
    }),
    readRelay: vi.fn(async (id: string) => {
      const v = slots.get(id);
      if (!v) {
        await new Promise((r) => setTimeout(r, 2));
        return null;
      }
      slots.delete(id);
      return { ...v, serverTimeMs: NOW };
    }),
  };
  const page = startEmailPage({ win, env: EMAIL_ENV, issuer: issuer as unknown as EmailApi, api: api as never, tickets: window.localStorage, now: () => NOW, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout: () => {} });
  return {
    win,
    page,
    issuer,
    api: api as never,
    relayId,
    relayKey,
    followKey,
    nonce,
    async vaultSays(n, notice) {
      const { id } = followSlot(followKey, n);
      slots.set(id, await encryptRelayValue(relayKey, id, notice));
    },
    async answerIn(n) {
      const { id } = followSlot(followKey, n);
      await vi.waitFor(() => expect(api.writeRelay.mock.calls.some((c) => c[0] === id)).toBe(true));
      const call = api.writeRelay.mock.calls.find((c) => c[0] === id)!;
      return decryptRelayPayload(relayKey, id, call[1] as RelayCiphertext);
    },
  };
}

async function toCode(address = 'ada@example.com'): Promise<void> {
  typeInto('email-address', address);
  submit('email-send');
  await flush();
}

describe('case B: “Link and continue” (D139)', () => {
  it('with a ticket: both buttons; Link stores the ticket and the address’s sub for the callback and goes to Google', async () => {
    const s = setup();
    s.issuer.verify.mockResolvedValueOnce({ kind: 'google_wallet', deviceTicket: null, link: { linkTicket: 'T'.repeat(43), emailSub: E_SUB } });
    await toCode();
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('google_wallet'));
    expect(pageText()).toContain('Link and continue');
    expect(pageText()).toContain('Sign in with Google');
    expect(pageText()).toContain('waits 24 hours');
    click('email-link-google');
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.relayId)!);
    expect(entry.b).toEqual({ linkTicket: 'T'.repeat(43), emailSub: E_SUB });
    expect(entry.f).toBe(Buffer.from(s.followKey).toString('base64url'));
    const url = new URL(s.win.location.assigned[0]!);
    expect(url.searchParams.get('nonce')).toBe(s.nonce);
    expect(url.searchParams.get('state')).toBe(s.relayId);
    expect(url.searchParams.get('scope')).toBe('openid');
  });

  it('“Sign in with Google” stores no ticket (a plain Google login, never linked)', async () => {
    const s = setup();
    s.issuer.verify.mockResolvedValueOnce({ kind: 'google_wallet', deviceTicket: null, link: { linkTicket: 'T'.repeat(43), emailSub: E_SUB } });
    await toCode();
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('google_wallet'));
    click('email-google');
    expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.relayId)!).b).toBeUndefined();
    expect(s.win.location.assigned).toHaveLength(1);
  });
});

describe('the follow-up mode', () => {
  it('after an email login’s token: reads the vault’s last word in slot 2; done without banners closes', async () => {
    const s = setup();
    await toCode();
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('following'));
    expect(s.win.closed).toBe(false);
    await s.vaultSays(2, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(s.win.closed).toBe(true));
    expect(pageText()).toContain('Signed in');
  });

  it('case A, not hosted: the screen; “Link and continue” sends google-match’s code, and the auto_link token answers slot 2', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'link_code', challengeId: CID, expiresAtMs: NOW + 600_000, to: 'a…@example.com' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    expect(pageText()).toContain('a…@example.com');
    click('link-continue');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    expect(s.issuer.resend).toHaveBeenCalledWith(CID);
    expect(s.issuer.start).not.toHaveBeenCalled();
    expect(pageText()).toContain('a…@example.com');
    typeInto('email-code', '654321');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'link' });
    // No device ticket under the masked address.
    expect(window.localStorage.length).toBe(0);
    await s.vaultSays(4, { t: 'done', banners: [{ provider: 'google', status: 'active', effectiveAtMs: NOW, fresh: true }] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(pageText()).toContain('Your Google sign-in now opens this wallet too.');
    click('banner-done');
    expect(s.win.closed).toBe(true);
  });

  it('case A: “Sign in with email” is an email login (session code), answered as a session token', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'use_email', reason: 'provider_taken' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    click('link-use-email');
    await toCode('ada@example.com');
    expect(s.issuer.start).toHaveBeenCalledTimes(1);
    typeInto('email-code', '111111');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'session' });
  });

  it('a cancel on the case-A screen answers {error}', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'link_code', challengeId: CID, expiresAtMs: NOW + 600_000, to: 'a…@example.com' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    click('email-cancel');
    expect(await s.answerIn(3)).toEqual({ error: 'email_cancelled' });
  });

  it('a pending link: the stop says when it activates', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'stop', code: 'link_pending', effectiveAtMs: NOW + 86_400_000 });
    await vi.waitFor(() => expect(s.page.stage).toBe('stopped'));
    expect(pageText()).toContain('It can open the wallet from');
  });

  it('a pending banner’s Cancel: a Google proof over the vault’s nonce, for this account, into slot 3', async () => {
    const s = setup({ next: 2 });
    const nonce = 'N'.repeat(43);
    await s.vaultSays(2, { t: 'done', banners: [{ provider: 'email', status: 'pending', effectiveAtMs: NOW + 86_400_000, fresh: true, action: { kind: 'cancel', prove: { method: 'google', nonce, loginHint: SUBJECT } } }] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(pageText()).toContain('An email will be able to open this wallet from');
    click('banner-cancel-0');
    const url = new URL(s.win.location.assigned[0]!);
    expect(url.searchParams.get('nonce')).toBe(nonce);
    expect(url.searchParams.get('login_hint')).toBe(SUBJECT);
    expect(url.searchParams.get('prompt')).toBeNull();
    const slot3 = followSlot(s.followKey, 3).id;
    expect(url.searchParams.get('state')).toBe(slot3);
    expect(JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + slot3)!)).toMatchObject({ leg: 'proof', next: 4, home: s.relayId });
  });

  it('an email proof (link_account): the code over the vault’s commitment, answered as a proof', async () => {
    const s = setup({ next: 2 });
    const commitment = { scopeId: 's1', rootIk: 'a'.repeat(64), newIk: 'b'.repeat(64), epoch: 0, salt: [1, 2, 3] };
    await s.vaultSays(2, { t: 'prove', why: 'link_account', provider: 'email', prove: { method: 'email', purpose: 'link_account', commitment } });
    await vi.waitFor(() => expect(s.page.stage).toBe('address'));
    expect(pageText()).toContain('Enter the email that opens this wallet');
    await toCode('root@example.com');
    expect(s.issuer.startLink).toHaveBeenCalledWith(PK, 'root@example.com', 'link_account', commitment, null);
    typeInto('email-code', '222222');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'proof' });
  });
});
