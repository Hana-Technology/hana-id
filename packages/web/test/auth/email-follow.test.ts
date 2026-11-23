// @vitest-environment happy-dom
// /login/email in batch 8b: case B's "Link and continue" (the ticket and the address's `sub` stored for the callback,
// D139), and the follow-up mode: the vault's notices read from their slots (link_code, use_email, prove, done with
// banners and their Cancel, stop) and the popup's answers written to the next slot.
import { ApiError, type FollowNotice, type LinkBanner, RECENT_LINK_MS, type RelayCiphertext, decryptRelayPayload, encryptRelayValue, followSlot, relayIdFor, sessionNonce } from '@hana-id/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthApi } from '../../src/auth/api.ts';
import type { EmailApi } from '../../src/auth/email-api.ts';
import { BANNER_ACTION_TEXT, CHANGE_TEXT, type EmailPage, FOLLOW_LIMIT_MS, FRESH_TEXT, HOME_SIGN_INS_SECTION, KEEP_WRITE_MS, OLDER_LINK_NOTE, changeFailure, kindName, olderLinkText, startEmailPage } from '../../src/auth/email-page.ts';
import { HOME_SIGN_INS_TITLE, SIGN_IN_TEXT } from '../../src/auth/home-sign-ins.ts';
import { EMAIL_ENTRY_PREFIX, readEmailContext } from '../../src/auth/email-storage.ts';
import type { GoogleEmailFlow } from '../../src/auth/google.ts';
import { EMAIL_PATH } from '../../src/auth/login-page.ts';
import { LOGIN_ENTRY_PREFIX, storeLoginEntry } from '../../src/auth/login-storage.ts';
import { SHARE_PATH, markEmailShare } from '../../src/auth/share-handoff.ts';
import type { HanaEnv } from '../../src/hana-env.ts';
import { CLIENT_ID, ENV, FakeWindow, PARTNER, PK, type RemoteWindow, asWindow, flush, pageText, remoteWindow, resetDom, vaultAcks } from './helpers.ts';

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
/** What the eye reads: an element's text without its visually hidden parts (`.sr-only`, D887's button names). */
const seen = (el: Element | null | undefined): string | null => {
  if (!el) return null;
  const c = el.cloneNode(true) as Element;
  for (const x of c.querySelectorAll('.sr-only')) x.remove();
  return c.textContent;
};
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
function setup(o: { next?: number; flow?: GoogleEmailFlow; serverNow?: number; tickets?: Storage | null; realTimers?: boolean } = {}): Setup {
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
  vaultAcks(opener.frames[VAULT_FRAME] as RemoteWindow, win);
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
      return { ...v, serverTimeMs: o.serverNow ?? NOW };
    }),
  };
  const page = startEmailPage({ win, env: EMAIL_ENV, issuer: issuer as unknown as EmailApi, api: api as never, tickets: o.tickets === undefined ? window.localStorage : o.tickets, now: () => NOW, setTimeout: (fn, ms) => setTimeout(fn, o.realTimers ? ms : Math.min(ms, 5)), clearTimeout: () => {}, ...(o.flow ? { googleEmailFlow: o.flow } : {}) });
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

/**
 * The same window back from a Google proof: /login/callback relayed it and stored the login entry for the vault's next
 * notice (`next`), then navigated here again; the email context (and what it remembered) is the same storage's.
 */
function backFromGoogle(s: Setup, next: number, at: number = NOW): EmailPage {
  const kept = Object.entries(window.sessionStorage).filter(([k]) => k.startsWith(EMAIL_ENTRY_PREFIX));
  resetDom();
  for (const [k, v] of kept) window.sessionStorage.setItem(k, v);
  const win = new FakeWindow(EMAIL_PATH, '', `#${s.relayId}`);
  win.opener = s.win.opener;
  storeLoginEntry(win.sessionStorage, s.relayId, Uint8Array.from(s.relayKey), NOW, undefined, { followKey: Uint8Array.from(s.followKey), home: s.relayId, next });
  s.win = win;
  return startEmailPage({ win, env: EMAIL_ENV, issuer: s.issuer as unknown as EmailApi, api: s.api as never, tickets: window.localStorage, now: () => at, setTimeout: (fn, ms) => setTimeout(fn, Math.min(ms, 5)), clearTimeout: () => {} });
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
    expect(pageText()).toContain('If this isn’t a Gmail or Google Workspace address, the link starts working after a waiting period (24 hours; shorter in a test version), and you can cancel it until then.');
    click('email-link-google');
    await flush();
    const url = new URL(s.win.location.assigned[0]!);
    // token_first (D341): the attempt's own OAuth state, its entry naming the login's slot; nothing left under the slot.
    const state = url.searchParams.get('state')!;
    expect(state).not.toBe(s.relayId);
    expect(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + s.relayId)).toBeNull();
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)!);
    expect(entry.b).toEqual({ linkTicket: 'T'.repeat(43), emailSub: E_SUB });
    expect(entry.f).toBe(Buffer.from(s.followKey).toString('base64url'));
    // The default flow (token_first, D270): the access token's request first, the nonce kept on the entry for the
    // ID request after it (G-L3 below runs both flows); a cancel comes back to these choices, the offer kept (D341).
    expect(entry).toMatchObject({ tf: 1, n: s.nonce, s: s.relayId, bk: 'b', ob: { linkTicket: 'T'.repeat(43), emailSub: E_SUB } });
    expect([url.searchParams.get('response_type'), url.searchParams.get('scope'), url.searchParams.get('nonce')]).toEqual(['token', 'openid email', null]);
  });

  it('G-L3: case B’s Google request is the login’s own, as /login makes it under each flow (google-match needs the access token)', async () => {
    for (const flow of ['token_first', 'second_request'] as const) {
      for (const button of ['email-google', 'email-link-google']) {
        resetDom();
        const s = setup({ flow });
        s.issuer.verify.mockResolvedValueOnce({ kind: 'google_wallet', deviceTicket: null, link: { linkTicket: 'T'.repeat(43), emailSub: E_SUB } });
        await toCode();
        typeInto('email-code', '123456');
        submit('email-verify');
        await vi.waitFor(() => expect(s.page.stage).toBe('google_wallet'));
        click(button);
        await flush();
        const url = new URL(s.win.location.assigned[0]!);
        const state = url.searchParams.get('state')!;
        const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)!);
        if (flow === 'token_first') {
          // The access token first (`openid email`, no ID token, no nonce); the entry keeps the nonce for the ID request,
          // under the attempt's own state, naming the login's slot (D341).
          expect([url.searchParams.get('response_type'), url.searchParams.get('scope'), url.searchParams.get('nonce')], button).toEqual(['token', 'openid email', null]);
          expect(entry).toMatchObject({ tf: 1, n: s.nonce, s: s.relayId, bk: 'b' });
          expect(state).not.toBe(s.relayId);
        } else {
          expect([url.searchParams.get('response_type'), url.searchParams.get('scope'), url.searchParams.get('nonce')], button).toEqual(['id_token', 'openid', s.nonce]);
          expect(entry.tf).toBeUndefined();
          expect(state).toBe(s.relayId);
        }
        // The ticket rides only with "Link and continue" (D139).
        expect(entry.b === undefined, button).toBe(button === 'email-google');
      }
    }
  });

  it('“Sign in with Google” stores no ticket (a plain Google login, never linked)', async () => {
    const s = setup();
    s.issuer.verify.mockResolvedValueOnce({ kind: 'google_wallet', deviceTicket: null, link: { linkTicket: 'T'.repeat(43), emailSub: E_SUB } });
    await toCode();
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('google_wallet'));
    click('email-google');
    await flush();
    expect(s.win.location.assigned).toHaveLength(1);
    const state = new URL(s.win.location.assigned[0]!).searchParams.get('state')!;
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + state)!);
    expect(entry.b).toBeUndefined();
    // The offer stays only so a cancel can show "Link and continue" again (D341); the callback never relays it.
    expect(entry.ob).toEqual({ linkTicket: 'T'.repeat(43), emailSub: E_SUB });
  });
});

describe('D347: the close watch’s signals from the follow-up mode', () => {
  const vaultOf = (s: Setup) => ((s.win.opener as unknown as { frames: Record<string, { postMessage: ReturnType<typeof vi.fn> }> }).frames[VAULT_FRAME]!);
  const stagesOf = (s: Setup) => vaultOf(s).postMessage.mock.calls.filter((c) => (c[0] as { t?: string }).t === 'hana:auth-progress').map((c) => (c[0] as { stage: string }).stage);

  it('a Google proof says `google` before the navigation', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'prove', why: 'link_account', provider: 'google', prove: { method: 'google', nonce: 'P'.repeat(43), loginHint: SUBJECT } });
    await vi.waitFor(() => expect(s.win.location.assigned).toHaveLength(1));
    expect(stagesOf(s)).toEqual(['google']);
  });

  it('a Cancel answer says `relayed` before the window closes itself', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'use_email', reason: 'unavailable' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    click('email-cancel');
    await vi.waitFor(() => expect(s.win.closed).toBe(true));
    expect(stagesOf(s)).toEqual(['relayed']);
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
    // D881: the wallet is named by the address the case-A screen showed.
    expect(document.querySelector('h1')?.textContent).toBe('You can now sign in with Google too');
    expect(document.querySelector('#link-banners li[data-fresh="true"]')?.textContent).toBe(
      'You already have a wallet here, made when you signed in with a…@example.com. You confirmed that address with a code, so signing in with Google now opens that same wallet. Nothing was moved or lost, and you can sign in either way.',
    );
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

  it('D264: declined Google email permission: the screen explains; “Sign in with email instead” answers an email login', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'email_consent', reason: 'declined', loginHint: SUBJECT });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    expect(s.page.notice).toBe('email_consent_declined');
    expect(pageText()).toContain('Journear checks whether your Google address already has a wallet. It keeps the address with your account and doesn’t share it with the app you’re signing in to.');
    expect(pageText()).not.toMatch(/doesn’t keep|isn’t kept/u);
    expect(pageText()).toContain('Without it you can’t open a new wallet with Google here.');
    expect(pageText()).toContain('Sign in with email instead');
    expect(pageText()).toContain('Try Google again');
    click('consent-email');
    await toCode('ada@example.com');
    typeInto('email-code', '111111');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'session' });
  });

  it('D264: “Try Google again” asks Google’s permission interactively for the signed-in account; its answer goes to slot 3', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'email_consent', reason: 'declined', loginHint: SUBJECT });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    click('consent-google');
    await flush();
    const url = new URL(s.win.location.assigned[0]!);
    const slot3 = followSlot(s.followKey, 3).id;
    expect(Object.fromEntries(url.searchParams)).toMatchObject({ response_type: 'token', scope: 'email', login_hint: SUBJECT, state: slot3, client_id: CLIENT_ID });
    expect(url.searchParams.get('prompt')).toBeNull();
    // The callback's entry for that leg: interactive already (no second explainer), the vault's next notice is slot 4.
    const entry = JSON.parse(s.win.sessionStorage.getItem(LOGIN_ENTRY_PREFIX + slot3)!);
    expect(entry).toMatchObject({ leg: 'access', i: 1, next: 4, h: SUBJECT, home: s.relayId });
  });

  it('D264: another Google account picked on Google’s screen gets its own message; Cancel answers {error}', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'email_consent', reason: 'account_mismatch', loginHint: SUBJECT });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_choice'));
    expect(s.page.notice).toBe('google_account_mismatch');
    expect(pageText()).toContain('pick the account you signed in with');
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
    await flush();
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

describe('D864: the email that waits to join a wallet', () => {
  const AT = NOW + 86_400_000;
  const commitment = { scopeId: 's1', action: 'cancel', rootIk: 'a'.repeat(64), memberIk: 'b'.repeat(64), epoch: 1, salt: Array.from({ length: 32 }, (_, i) => i) };
  const waitingNotice: FollowNotice = { t: 'link_waiting', provider: 'google', effectiveAtMs: AT, prove: { method: 'email', purpose: 'link_change', commitment } };

  /** An email login whose token was relayed, then the vault's link_waiting in slot 2. */
  async function onWaiting(): Promise<Setup> {
    const s = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('following'));
    await s.vaultSays(2, waitingNotice);
    await vi.waitFor(() => expect(s.page.stage).toBe('link_waiting'));
    return s;
  }

  it('says what is waiting and from when, in plain words; Cancel is first, Keep the link second', async () => {
    const s = await onWaiting();
    expect(document.querySelector('h1')?.textContent).toBe('A Google account is being linked to this email');
    const what = document.getElementById('link-waiting-what')!;
    expect(what.className).toContain('jp-alert-warning');
    expect(what.textContent).toContain('This email is being linked with a Google account, so both will open the same Journear wallet.');
    expect(what.textContent).toContain('The link starts working on');
    expect(document.getElementById('link-waiting-advice')?.textContent).toBe('Didn’t do this? Cancel the link. We’ll send one more code to this email to check it’s you. If you’re not sure, cancel it.');
    expect(document.getElementById('link-waiting-keep')?.textContent).toContain('If you linked this email yourself, keep the link.');
    const buttons = [...document.querySelectorAll('.actions button')].map((b) => [b.id, b.textContent]);
    expect(buttons).toEqual([
      ['link-cancel', 'Cancel this link'],
      ['link-keep', 'Keep the link'],
    ]);
    expect(s.page.notice).toBe('link_pending');
    // Nothing of the other sign-in but its kind.
    expect(pageText()).not.toContain('@');
  });

  it('Cancel sends one more code to the same address over the vault’s link_change commitment; the code answers slot 3 as a proof', async () => {
    const s = await onWaiting();
    click('link-cancel');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    expect(s.issuer.startLink).toHaveBeenCalledTimes(1);
    expect(s.issuer.startLink).toHaveBeenCalledWith(PK, 'ada@example.com', 'link_change', commitment, null);
    expect(pageText()).toContain('ada@example.com');
    typeInto('email-code', '333333');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'proof' });
    await s.vaultSays(4, { t: 'link_cancel', outcome: 'cancelled' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_cancelled'));
    expect(document.querySelector('h1')?.textContent).toBe('Link cancelled');
    expect(document.getElementById('link-cancel-what')?.className).toContain('jp-alert-success');
    expect(pageText()).toContain('This email is no longer being linked with that Google account.');
    expect(pageText()).not.toContain('Nothing else changed');
    // The cancel signs that wallet's devices out in this app (the API revokes its shares): said plainly.
    expect(pageText()).toContain('Anyone signed in to that wallet will be asked to sign in again.');
    expect(pageText()).toContain('If you didn’t start this link, change your email password.');
    click('link-cancel-close');
    expect(s.win.closed).toBe(true);
  });

  it('a double tap on Cancel sends one code', async () => {
    const s = await onWaiting();
    // The same button twice, as a quick double tap reaches it (the second lands on the disabled button).
    const button = document.getElementById('link-cancel') as HTMLButtonElement;
    button.click();
    expect(button.disabled).toBe(true);
    expect((document.getElementById('link-keep') as HTMLButtonElement | null)?.disabled ?? true).toBe(true);
    button.click();
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    await flush();
    expect(s.issuer.startLink).toHaveBeenCalledTimes(1);
  });

  it('Keep the link closes the window and answers nothing (the link stays)', async () => {
    const s = await onWaiting();
    click('link-keep');
    expect(s.win.closed).toBe(true);
    expect(pageText()).toContain('The link stays');
    await flush();
    const slot3 = followSlot(s.followKey, 3).id;
    expect(s.api.writeRelay.mock.calls.some((c) => c[0] === slot3)).toBe(false);
    expect(s.issuer.startLink).not.toHaveBeenCalled();
  });

  it('too late: the waiting period ended (danger, the corrected advice); Remove this email right there, after its confirmation', async () => {
    const s = await onWaiting();
    await s.vaultSays(4, { t: 'link_cancel', outcome: 'now_active' });
    // Slot 4 is read only after an answer: give it one, as the code would.
    click('link-cancel');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    typeInto('email-code', '333333');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('link_cancelled'));
    expect(document.querySelector('h1')?.textContent).toBe('This link can’t be cancelled any more');
    expect(document.getElementById('link-cancel-what')?.className).toContain('jp-alert-danger');
    expect(document.getElementById('link-cancel-what')?.textContent).toBe('The waiting period has ended: this email and that Google account now open the same wallet.');
    expect(document.getElementById('link-cancel-advice')?.textContent).toBe('If you didn’t set this up, don’t add money to it. Choose Remove this email below, and change your email password.');
    expect(pageText()).not.toContain('Within 7 days');
    expect([...document.querySelectorAll('.actions button')].map((b) => [b.id, b.textContent])).toEqual([
      ['link-active-remove', 'Remove this email'],
      ['link-cancel-close', 'Close'],
    ]);
    click('link-active-remove');
    expect(s.page.stage).toBe('member_confirm');
    expect(document.querySelector('h1')?.textContent).toBe('Remove this email from that wallet?');
    click('member-remove-back');
    expect(s.page.stage).toBe('link_cancelled');
    click('link-active-remove');
    click('member-remove-confirm');
    expect(await s.answerIn(5)).toEqual({ choice: 'remove' });
    const commitment = { scopeId: 's1', action: 'unlink', rootIk: 'a'.repeat(64), memberIk: 'b'.repeat(64), epoch: 1, salt: [1] };
    await s.vaultSays(6, { t: 'member_remove', prove: { method: 'email', purpose: 'link_change', commitment } });
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    expect(s.issuer.startLink).toHaveBeenLastCalledWith(PK, 'ada@example.com', 'link_change', commitment, null);
    typeInto('email-code', '555555');
    submit('email-verify');
    expect(await s.answerIn(7)).toEqual({ idToken: TOKEN, as: 'proof' });
    await s.vaultSays(8, { t: 'member_removed', outcome: 'removed' });
    await vi.waitFor(() => expect(s.page.stage).toBe('member_removed'));
    expect(document.querySelector('h1')?.textContent).toBe('This email was removed');
  });

  for (const [outcome, title, line, code] of [
    ['already_cancelled', 'This link was already cancelled', 'There’s nothing more to do.', undefined],
    ['not_cancelled', 'The link wasn’t cancelled', 'Nothing changed: the link is still waiting.', 'stale_epoch'],
    ['unknown', 'We couldn’t check the link', 'Journear couldn’t be reached, so we can’t tell whether the link was cancelled.', 'api_unavailable'],
  ] as const) {
    it(`outcome ${outcome}: “${title}”`, async () => {
      const s = await onWaiting();
      click('link-cancel');
      await vi.waitFor(() => expect(s.page.stage).toBe('code'));
      typeInto('email-code', '333333');
      submit('email-verify');
      await s.answerIn(3);
      await s.vaultSays(4, { t: 'link_cancel', outcome, ...(code ? { code } : {}) });
      await vi.waitFor(() => expect(s.page.stage).toBe('link_cancelled'));
      expect(document.querySelector('h1')?.textContent).toBe(title);
      expect(pageText()).toContain(line);
      if (code) expect(pageText()).toContain(`Error code (for support): ${code}`);
      expect(s.page.notice).toBe(code ?? outcome);
    });
  }

  it('a link_waiting whose proof isn’t an email link_change cancels nothing', async () => {
    const s = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('following'));
    await s.vaultSays(2, { t: 'link_waiting', provider: 'google', effectiveAtMs: AT, prove: { method: 'email', purpose: 'session', commitment: {} } });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_waiting'));
    click('link-cancel');
    await vi.waitFor(() => expect(s.page.stage).toBe('error'));
    expect(s.issuer.startLink).not.toHaveBeenCalled();
    expect(s.issuer.start).toHaveBeenCalledTimes(1);
  });
});

describe('D865: an active member’s own notice', () => {
  const SINCE = NOW - 3 * 86_400_000;
  const LINK_ID = 'f'.repeat(64);
  const memberNotice: FollowNotice = { t: 'member_link', method: 'email', rootProvider: 'google', sinceMs: SINCE, linkId: LINK_ID, how: 'chosen' };
  const commitment = { scopeId: 's1', action: 'unlink', rootIk: 'a'.repeat(64), memberIk: 'b'.repeat(64), epoch: 1, salt: Array.from({ length: 32 }, (_, i) => i) };

  async function onNotice(): Promise<Setup> {
    const s = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('following'));
    await s.vaultSays(2, memberNotice);
    await vi.waitFor(() => expect(s.page.stage).toBe('member_link'));
    return s;
  }

  it('says, before the sign-in goes on, that this email opens a wallet a Google account also opens; Remove, Not now, and a separate Don’t ask again', async () => {
    await onNotice();
    expect(document.querySelector('h1')?.textContent).toBe('This email now also opens another wallet');
    const what = document.getElementById('member-link-what')!;
    expect(what.className).toContain('jp-alert-warning');
    expect(what.textContent).toMatch(/^Since .+, this email opens a wallet that a Google account also opens\. Whoever holds that Google account can open it too\.$/u);
    expect(document.getElementById('member-link-advice')?.textContent).toBe('If you didn’t set this up, remove this email from it.');
    expect(document.getElementById('member-link-keep')?.textContent).toBe('If you set this up yourself, you can choose Don’t ask again on this device.');
    expect([...document.querySelectorAll('.actions button')].map((b) => [b.id, b.textContent])).toEqual([
      ['member-remove', 'Remove this email'],
      ['member-not-now', 'Not now'],
    ]);
    // The lasting choice is smaller and apart from the two main buttons.
    const dontAsk = document.getElementById('member-dont-ask')!;
    expect(dontAsk.textContent).toBe('Don’t ask again on this device');
    expect(dontAsk.closest('.actions')).toBeNull();
  });

  it('Not now answers keep and stores nothing: the next sign-in asks again', async () => {
    const s = await onNotice();
    click('member-not-now');
    expect(await s.answerIn(3)).toEqual({ choice: 'keep' });
    expect(window.localStorage.getItem(`hana.ml.${LINK_ID}`)).toBeNull();
    resetDom();
    const again = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(again.page.stage).toBe('following'));
    await again.vaultSays(2, memberNotice);
    await vi.waitFor(() => expect(again.page.stage).toBe('member_link'));
  });

  it('Don’t ask again on this device answers keep, and this device isn’t asked again about this link', async () => {
    const s = await onNotice();
    click('member-dont-ask');
    expect(await s.answerIn(3)).toEqual({ choice: 'keep' });
    expect(window.localStorage.getItem(`hana.ml.${LINK_ID}`)).not.toBeNull();
    // Another sign-in on this device: answered at once, no screen.
    resetDom();
    const again = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(again.page.stage).toBe('following'));
    await again.vaultSays(2, memberNotice);
    expect(await again.answerIn(3)).toEqual({ choice: 'keep' });
    expect(document.getElementById('member-link')).toBeNull();
  });

  it('Remove asks first, saying what it costs; Go back returns; Remove it answers remove, then the code goes to the same address over the unlink commitment', async () => {
    const s = await onNotice();
    click('member-remove');
    expect(s.page.stage).toBe('member_confirm');
    expect(document.querySelector('h1')?.textContent).toBe('Remove this email from that wallet?');
    expect(document.getElementById('member-confirm-what')?.className).toContain('jp-alert-danger');
    expect(document.getElementById('member-confirm-what')?.textContent).toBe('After you remove it, this email can’t open that wallet any more. Anything in it stays there, and whoever holds that Google account can still open it.');
    expect(document.getElementById('member-confirm-money')?.textContent).toBe('If you added money to that wallet, move it out first. Choose Go back, then Not now, and sign in to move it. You’ll be asked again next time.');
    expect(document.getElementById('member-confirm-next')?.textContent).toBe('If you sign in with this email again afterwards, it opens a new, empty wallet of its own.');
    click('member-remove-back');
    expect(s.page.stage).toBe('member_link');
    click('member-remove');
    const go = document.getElementById('member-remove-confirm') as HTMLButtonElement;
    go.click();
    go.click();
    expect(await s.answerIn(3)).toEqual({ choice: 'remove' });
    expect(s.api.writeRelay.mock.calls.filter((c) => c[0] === followSlot(s.followKey, 3).id)).toHaveLength(1);
    await s.vaultSays(4, { t: 'member_remove', prove: { method: 'email', purpose: 'link_change', commitment } });
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    expect(s.issuer.startLink).toHaveBeenCalledWith(PK, 'ada@example.com', 'link_change', commitment, null);
    typeInto('email-code', '444444');
    submit('email-verify');
    expect(await s.answerIn(5)).toEqual({ idToken: TOKEN, as: 'proof' });
    await s.vaultSays(6, { t: 'member_removed', outcome: 'removed' });
    await vi.waitFor(() => expect(s.page.stage).toBe('member_removed'));
    expect(document.querySelector('h1')?.textContent).toBe('This email was removed');
    expect(document.getElementById('member-removed-what')?.textContent).toBe(
      'This email no longer opens that wallet. Anything in it stays there, with whoever holds that Google account. Anyone signed in to that wallet will be asked to sign in again.',
    );
    expect(document.getElementById('member-removed-next')?.textContent).toBe('If you sign in with this email again, it opens a new, empty wallet of its own.');
    // A remove doesn't mark the link kept: if it failed, the next sign-in asks again.
    expect(window.localStorage.getItem(`hana.ml.${LINK_ID}`)).toBeNull();
    click('member-removed-close');
    expect(s.win.closed).toBe(true);
  });

  for (const [outcome, title, line, code] of [
    ['already_removed', 'This email was already removed', 'There’s nothing more to do.', undefined],
    ['not_removed', 'This email wasn’t removed', 'Nothing changed: this email still opens that wallet.', 'stale_epoch'],
    ['unknown', 'We couldn’t check the removal', 'Journear couldn’t be reached, so we can’t tell whether this email was removed.', 'api_unavailable'],
  ] as const) {
    it(`outcome ${outcome}: “${title}”`, async () => {
      const s = await onNotice();
      click('member-remove');
      click('member-remove-confirm');
      await s.answerIn(3);
      await s.vaultSays(4, { t: 'member_remove', prove: { method: 'email', purpose: 'link_change', commitment } });
      await vi.waitFor(() => expect(s.page.stage).toBe('code'));
      typeInto('email-code', '444444');
      submit('email-verify');
      await s.answerIn(5);
      await s.vaultSays(6, { t: 'member_removed', outcome, ...(code ? { code } : {}) });
      await vi.waitFor(() => expect(s.page.stage).toBe('member_removed'));
      expect(document.querySelector('h1')?.textContent).toBe(title);
      expect(pageText()).toContain(line);
      if (code) expect(pageText()).toContain(`Error code (for support): ${code}`);
    });
  }

  it('a link that may have been made automatically (the same person’s Gmail): words that don’t push removal, Not now first', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'member_link', method: 'google', rootProvider: 'email', sinceMs: SINCE, linkId: LINK_ID, how: 'automatic' });
    await vi.waitFor(() => expect(s.page.stage).toBe('member_link'));
    expect(document.getElementById('member-link-what')?.className).toContain('jp-alert-info');
    expect(document.getElementById('member-link-advice')?.textContent).toBe(
      'This usually happens when that email is your own Gmail or Google Workspace address. If you don’t recognise it, remove this Google account from it.',
    );
    expect([...document.querySelectorAll('.actions button')].map((b) => [b.id, b.textContent, b.className.includes('jp-btn-danger')])).toEqual([
      ['member-not-now', 'Not now', false],
      ['member-remove', 'Remove this Google account', false],
    ]);
  });

  it('a Google member gets the same words for its own method; its proof is a Google sign-in for that account', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'member_link', method: 'google', rootProvider: 'email', sinceMs: SINCE, linkId: LINK_ID, how: 'chosen' });
    await vi.waitFor(() => expect(s.page.stage).toBe('member_link'));
    expect(document.querySelector('h1')?.textContent).toBe('This Google account now also opens another wallet');
    expect(document.getElementById('member-link-what')?.textContent).toContain('this Google account opens a wallet that an email also opens. Whoever holds that email can open it too.');
    click('member-remove');
    expect(document.getElementById('member-confirm-check')?.textContent).toBe('Google will ask you to sign in again to check it’s you.');
    click('member-remove-confirm');
    expect(await s.answerIn(3)).toEqual({ choice: 'remove' });
    await s.vaultSays(4, { t: 'member_remove', prove: { method: 'google', nonce: 'U'.repeat(43), loginHint: SUBJECT } });
    await vi.waitFor(() => expect(s.win.location.assigned).toHaveLength(1));
    const url = new URL(s.win.location.assigned[0]!);
    expect([url.searchParams.get('nonce'), url.searchParams.get('login_hint')]).toEqual(['U'.repeat(43), SUBJECT]);
  });
});

describe('D875: the wallet’s own sign-in sees its older ways to sign in quietly, with Remove, until it presses Done in this browser', () => {
  const DAY = 24 * 3_600_000;
  const nonce = 'R'.repeat(43);
  const older = (since: number, o: Partial<LinkBanner> = {}): LinkBanner => ({ provider: 'email', status: 'active', effectiveAtMs: since, fresh: false, action: { kind: 'unlink', prove: { method: 'google', nonce, loginHint: SUBJECT } }, ...o });
  const seenKeys = (): string[] => Object.keys(window.localStorage).filter((k) => k.startsWith('hana.ol.'));
  const slotWrites = (s: Setup, n: number): number => s.api.writeRelay.mock.calls.filter((c) => c[0] === followSlot(s.followKey, n).id).length;

  async function signedIn(banners: LinkBanner[], o: { serverNow?: number; tickets?: Storage | null; realTimers?: boolean } = {}): Promise<Setup> {
    resetDom();
    const s = setup({ next: 2, ...o });
    await s.vaultSays(2, { t: 'done', banners });
    await vi.waitFor(() => expect(['banners', 'done']).toContain(s.page.stage));
    return s;
  }
  /** Done on the line's screen; the window closes once the keep answer is written. */
  async function pressDone(s: Setup): Promise<void> {
    click('banner-done');
    await vi.waitFor(() => expect(s.win.closed).toBe(true));
  }

  it('8 days and 1 year on: one plain line (no box, no colour), “Don’t recognise it?” and Remove it under it, and the note; Remove asks for the same Google proof and uses nothing up', async () => {
    for (const age of [8 * DAY, 365 * DAY]) {
      window.localStorage.clear();
      const s = await signedIn([older(NOW - age)]);
      expect(s.page.stage, `${age}`).toBe('banners');
      expect(document.querySelector('h1')?.textContent).toBe('Signed in');
      const line = document.querySelector('#link-older .older-link')!;
      // D887: the sentence stays plain; the action is on its own line under it.
      expect(line.querySelector('.older-link-text')?.textContent).toBe(olderLinkText('email', new Date(NOW - age).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
      expect(line.querySelector('.older-link-text')?.textContent).toMatch(/^An email address also opens this wallet, since .+\.$/u);
      expect(line.querySelector('.older-link-text button')).toBeNull();
      expect([...line.querySelectorAll(':scope > p.banner-action > *')].map(seen)).toEqual(['Don’t recognise it?', 'Remove it']);
      expect(document.getElementById('link-older')?.textContent).toContain(OLDER_LINK_NOTE);
      expect(OLDER_LINK_NOTE).toBe('After you press Done, this browser won’t show this again. Passport Home lists the ways to sign in to your wallet.');
      // Quiet: not a banner, no alert box, no icon.
      expect(document.getElementById('link-banners')).toBeNull();
      expect(document.querySelector('#link-older .jp-alert, #link-older [role="alert"], #link-older svg')).toBeNull();
      expect(seen(document.getElementById('banner-unlink-0'))).toBe('Remove it');
      // Drawing the line uses nothing up.
      expect(seenKeys()).toEqual([]);
      click('banner-unlink-0');
      // D881: asked first; Remove it goes on to the proof.
      expect(s.page.stage).toBe('banner_confirm');
      expect(s.win.location.assigned).toHaveLength(0);
      click('banner-remove-confirm');
      await flush();
      const url = new URL(s.win.location.assigned[0]!);
      expect([url.searchParams.get('nonce'), url.searchParams.get('login_hint')]).toEqual([nonce, SUBJECT]);
      expect(url.searchParams.get('state')).toBe(followSlot(s.followKey, 3).id);
      // Nor does Remove: it may still fail or be abandoned.
      expect(seenKeys()).toEqual([]);
    }
  });

  it('a Google account is named by its kind only too', async () => {
    await signedIn([older(NOW - 30 * DAY, { provider: 'google' })]);
    expect(document.querySelector('#link-older .older-link-text')?.textContent).toMatch(/^A Google account also opens this wallet, since .+\.$/u);
    expect(document.getElementById('banner-unlink-0')?.textContent).toBe('Remove it (the Google account)');
    expect(pageText()).not.toContain('@');
  });

  it('Done uses it up in this browser (and answers keep); the next sign-in closes at once, as with no banners, and answers keep too', async () => {
    const first = await signedIn([older(NOW - 30 * DAY)]);
    await pressDone(first);
    expect(await first.answerIn(3)).toEqual({ choice: 'keep' });
    expect(seenKeys()).toHaveLength(1);
    const again = await signedIn([older(NOW - 30 * DAY)]);
    await vi.waitFor(() => expect(again.win.closed).toBe(true));
    expect(again.page.stage).toBe('done');
    expect(pageText()).toContain('Signed in');
    expect(document.getElementById('link-older')).toBeNull();
    expect(await again.answerIn(3)).toEqual({ choice: 'keep' });
    expect(slotWrites(again, 3)).toBe(1);
  });

  it('a window closed without Done (its own close button, or the app closing it): the next sign-in shows the line again', async () => {
    const first = await signedIn([older(NOW - 30 * DAY)]);
    first.win.close();
    expect(seenKeys()).toEqual([]);
    expect(slotWrites(first, 3)).toBe(0);
    const again = await signedIn([older(NOW - 30 * DAY)]);
    expect(again.page.stage).toBe('banners');
    expect(document.getElementById('link-older')).not.toBeNull();
  });

  it('Remove, then the vault stops it (token_invalid): the next sign-in shows the line again', async () => {
    const s = await signedIn([older(NOW - 30 * DAY)]);
    click('banner-unlink-0');
    click('banner-remove-confirm');
    await flush();
    // The window back from Google's proof reads the vault's answer in slot 4: the removal failed (D881: it says so).
    const back = backFromGoogle(s, 4);
    await s.vaultSays(4, { t: 'stop', code: 'token_invalid' });
    await vi.waitFor(() => expect(back.stage).toBe('link_changed'));
    expect(document.getElementById('link-change-result')?.getAttribute('data-outcome')).toBe('not_you');
    click('link-change-close');
    expect(seenKeys()).toEqual([]);
    const again = await signedIn([older(NOW - 30 * DAY)]);
    expect(again.page.stage).toBe('banners');
    expect(seen(document.getElementById('banner-unlink-0'))).toBe('Remove it');
  });

  it('the window waits for the keep write before it closes (Done, and the screen that shows nothing), and never longer than KEEP_WRITE_MS', async () => {
    for (const via of ['done', 'nothing to show'] as const) {
      window.localStorage.clear();
      if (via === 'nothing to show') await pressDone(await signedIn([older(NOW - 30 * DAY)]));
      resetDom();
      const s = setup({ next: 2, realTimers: true });
      let release: () => void = () => undefined;
      s.api.writeRelay.mockImplementation(() => new Promise<void>((r) => (release = r)));
      await s.vaultSays(2, { t: 'done', banners: [older(NOW - 30 * DAY)] });
      await vi.waitFor(() => expect(['banners', 'done']).toContain(s.page.stage));
      if (via === 'done') click('banner-done');
      await vi.waitFor(() => expect(s.api.writeRelay).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 200));
      expect(s.win.closed, via).toBe(false);
      release();
      await vi.waitFor(() => expect(s.win.closed, via).toBe(true));
    }
    // A write that never answers gives way after KEEP_WRITE_MS (real time).
    expect(KEEP_WRITE_MS).toBe(1_500);
    resetDom();
    const hung = setup({ next: 2, realTimers: true });
    hung.api.writeRelay.mockImplementation(() => new Promise(() => undefined));
    await hung.vaultSays(2, { t: 'done', banners: [older(NOW - 30 * DAY)] });
    const start = Date.now();
    await vi.waitFor(() => expect(hung.win.closed).toBe(true), { timeout: 4_000 });
    expect(Date.now() - start).toBeGreaterThanOrEqual(KEEP_WRITE_MS - 100);
  });

  it('within the first 7 days: the full banner (D887: “Don’t recognise it?” and Remove it under its sentence), at every sign-in, nothing remembered', async () => {
    for (const age of [0, DAY, RECENT_LINK_MS - 60_000]) {
      for (let round = 0; round < 2; round++) {
        const s = await signedIn([older(NOW - age)]);
        expect(s.page.stage, `${age} ${round}`).toBe('banners');
        expect(document.querySelector('#link-banners li[data-status="active"] .banner-what')?.textContent).toMatch(/^A sign-in method was added: email on .+\.$/u);
        expect(seen(document.querySelector('#link-banners li[data-status="active"] .banner-action'))).toBe('Don’t recognise it?Remove it');
        expect(document.getElementById('link-older')).toBeNull();
        await pressDone(s);
        expect(seenKeys()).toEqual([]);
      }
    }
  });

  it('a recent banner keeps the window open as before; a dismissed older line is shown with it (no extra wait)', async () => {
    await pressDone(await signedIn([older(NOW - 30 * DAY, { provider: 'google' })]));
    const s = await signedIn([{ provider: 'email', status: 'pending', effectiveAtMs: NOW + DAY, fresh: true, action: { kind: 'cancel', prove: { method: 'google', nonce: 'C'.repeat(43), loginHint: SUBJECT } } }, older(NOW - 30 * DAY, { provider: 'google' })]);
    expect(s.page.stage).toBe('banners');
    expect(document.querySelectorAll('#link-banners li')).toHaveLength(1);
    expect(document.querySelectorAll('#link-older .older-link')).toHaveLength(1);
    // A waiting link this sign-in just made: its Cancel stands alone (the user did add it).
    expect(seen(document.getElementById('banner-cancel-0'))).toBe('Cancel this link');
    expect(seen(document.getElementById('banner-cancel-0')?.closest('.banner-action'))).toBe('Cancel this link');
    expect(seen(document.getElementById('banner-unlink-1'))).toBe('Remove it');
    expect(slotWrites(s, 3)).toBe(0);
  });

  it('judged on the API’s time, as the vault judges it, not the device’s clock', async () => {
    // The device's clock (NOW) says 6 days; the API says 8: an older link.
    const s = await signedIn([older(NOW - 6 * DAY)], { serverNow: NOW + 2 * DAY });
    expect(s.page.stage).toBe('banners');
    expect(document.getElementById('link-older')).not.toBeNull();
    // The device's clock says 8 days; the API says 6: still the full banner.
    await signedIn([older(NOW - 8 * DAY)], { serverNow: NOW - 2 * DAY });
    expect(document.querySelector('#link-banners li')).not.toBeNull();
    expect(document.getElementById('link-older')).toBeNull();
  });

  it('storage that can’t be read or written: shown every time, Done or not (the safe side)', async () => {
    const blocked = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    } as unknown as Storage;
    for (const tickets of [blocked, null]) {
      for (let round = 0; round < 2; round++) {
        const s = await signedIn([older(NOW - 30 * DAY)], { tickets });
        expect(s.page.stage, `${tickets === null ? 'none' : 'blocked'} ${round}`).toBe('banners');
        await pressDone(s);
      }
    }
  });

  it('an older line without an action (none was offered), dismissed: Done and the next sign-in close without writing anything', async () => {
    const first = await signedIn([older(NOW - 30 * DAY, { action: undefined })]);
    click('banner-done');
    expect(first.win.closed).toBe(true);
    expect(slotWrites(first, 3)).toBe(0);
    const s = await signedIn([older(NOW - 30 * DAY, { action: undefined })]);
    await vi.waitFor(() => expect(s.win.closed).toBe(true));
    expect(slotWrites(s, 3)).toBe(0);
  });
});

describe('D881: the screen after a sign-in that added a way to sign in, by case', () => {
  const said = (): string => seen(document.querySelector('#link-banners li[data-fresh="true"]')) ?? '';

  it('case A, Google-hosted (joined at once, nothing to decide): says which wallet, why, and that nothing was lost; where to see them', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'done', banners: [{ provider: 'google', status: 'active', effectiveAtMs: NOW, fresh: true }] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(document.querySelector('h1')?.textContent).toBe('You can now sign in with Google too');
    // The window's title is the screen's, not the page file's "Sign in with email".
    expect(document.title).toBe('You can now sign in with Google too');
    expect(said()).toBe(
      'You already have a wallet here, made when you signed in with your email address. Your Google account uses the same address, so signing in with Google now opens that same wallet. Nothing was moved or lost, and you can sign in either way.',
    );
    expect(document.getElementById('link-fresh-home')?.textContent).toBe('You can see every way to sign in to your wallet in Passport Home, under “Ways to sign in”.');
    // Good news, not a warning: the green tick, no amber or red box.
    const li = document.querySelector('#link-banners li[data-fresh="true"]')!;
    expect(li.className).toBe('banner');
    expect(document.querySelector('.jp-alert-warning, .jp-alert-danger')).toBeNull();
    // No address: this window never held one.
    expect(pageText()).not.toContain('@');
    click('banner-done');
    expect(s.win.closed).toBe(true);
  });

  it('case B, Google-hosted (an email joined a Google wallet at once): words true for that direction; Remove is the wallet’s own sign-in’s', async () => {
    const s = setup({ next: 2 });
    const nonce = 'B'.repeat(43);
    await s.vaultSays(2, { t: 'done', banners: [{ provider: 'email', status: 'active', effectiveAtMs: NOW, fresh: true, action: { kind: 'unlink', prove: { method: 'google', nonce, loginHint: SUBJECT } } }] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(document.querySelector('h1')?.textContent).toBe('You can now sign in with email too');
    expect(said()).toBe(
      'You already have a wallet here, made when you signed in with Google. You chose to link your email address, so signing in with it now opens the same wallet. Nothing was moved or lost, and you can sign in either way.Remove',
    );
    // D887: a way to sign in this sign-in just added: the small button alone on its own line, no “Don’t recognise it?”.
    expect(document.querySelector('#link-banners li[data-fresh="true"] .banner-what')?.textContent).toBe(
      'You already have a wallet here, made when you signed in with Google. You chose to link your email address, so signing in with it now opens the same wallet. Nothing was moved or lost, and you can sign in either way.',
    );
    const remove = document.getElementById('banner-unlink-0')!;
    expect([seen(remove), remove.textContent, seen(remove.parentElement)]).toEqual(['Remove', 'Remove the email address from this wallet', 'Remove']);
    expect(document.getElementById('link-fresh-home')).not.toBeNull();
  });

  it('a waiting link (case B not hosted, linkAccount) keeps its line and the plain “Signed in” heading', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'done', banners: [{ provider: 'email', status: 'pending', effectiveAtMs: NOW + 86_400_000, fresh: true }] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(document.querySelector('h1')?.textContent).toBe('Signed in');
    expect(pageText()).toMatch(/An email will be able to open this wallet from .+\./u);
    expect(document.querySelector('[data-fresh]')).toBeNull();
    expect(document.getElementById('link-fresh-home')).toBeNull();
  });

  it('with older lines shown too, their own note names Passport Home (one pointer, not two)', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, {
      t: 'done',
      banners: [
        { provider: 'google', status: 'active', effectiveAtMs: NOW, fresh: true },
        { provider: 'email', status: 'active', effectiveAtMs: NOW - 30 * 86_400_000, fresh: false },
      ],
    });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    expect(document.getElementById('link-fresh-home')).toBeNull();
    expect(document.getElementById('link-older')?.textContent).toContain(OLDER_LINK_NOTE);
  });

  it('the section it points to is Passport Home’s', () => {
    expect(HOME_SIGN_INS_SECTION).toBe(HOME_SIGN_INS_TITLE);
    expect(FRESH_TEXT.home).toContain(`“${HOME_SIGN_INS_TITLE}”`);
  });

  it('the window’s title follows each screen (the email step, a stop)', async () => {
    document.title = 'Sign in with email';
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'stop', code: 'login_timeout' });
    await vi.waitFor(() => expect(s.page.stage).toBe('stopped'));
    expect(document.title).toBe('Sign-in stopped');
    resetDom();
    setup();
    expect(document.title).toBe('Sign in with email');
  });
});

describe('D881: a banner’s Remove asks first, and a Remove or Cancel ends on what became of it', () => {
  const DAY = 24 * 3_600_000;
  const nonce = 'R'.repeat(43);
  const googleProof = { method: 'google', nonce, loginHint: SUBJECT } as const;
  const emailCommitment = { scopeId: 's1', action: 'unlink', rootIk: 'a'.repeat(64), memberIk: 'b'.repeat(64), epoch: 2, salt: Array.from({ length: 32 }, (_, i) => i) };
  const recent = (o: Partial<LinkBanner> = {}): LinkBanner => ({ provider: 'email', status: 'active', effectiveAtMs: NOW - DAY, fresh: false, action: { kind: 'unlink', prove: googleProof }, ...o });
  const waiting = (o: Partial<LinkBanner> = {}): LinkBanner => ({ provider: 'email', status: 'pending', effectiveAtMs: NOW + DAY, fresh: false, action: { kind: 'cancel', prove: googleProof }, ...o });
  const seenKeys = (): string[] => Object.keys(window.localStorage).filter((k) => k.startsWith('hana.ol.'));
  const slotWrites = (s: Setup, n: number): number => s.api.writeRelay.mock.calls.filter((c) => c[0] === followSlot(s.followKey, n).id).length;
  const result = () => document.getElementById('link-change-result');
  const text = (id: string) => document.getElementById(id)?.textContent ?? null;

  async function withBanners(banners: LinkBanner[]): Promise<Setup> {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'done', banners });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    return s;
  }

  /** An email sign-in typed here (the wallet's own, an email root), then the vault's banners in slot 2. */
  async function emailRootWith(banners: LinkBanner[]): Promise<Setup> {
    const s = setup();
    await toCode('ada@example.com');
    typeInto('email-code', '123456');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('following'));
    await s.vaultSays(2, { t: 'done', banners });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    return s;
  }

  it('the confirmation says what Remove does and costs, in D865’s shape; nothing is sent or written before Remove it', async () => {
    const s = await withBanners([recent()]);
    click('banner-unlink-0');
    expect(s.page.stage).toBe('banner_confirm');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the email address from this wallet?');
    expect(document.title).toBe('Remove the email address from this wallet?');
    const what = document.getElementById('banner-remove-what')!;
    expect(what.className).toContain('jp-alert-danger');
    expect(what.textContent).toBe('After you remove it, the email address can’t open this wallet any more. Your money stays in this wallet.');
    expect(text('banner-remove-next')).toBe('If you sign in with that email address later, it opens a new, empty wallet of its own. It won’t be added back automatically.');
    expect(text('banner-remove-check')).toBe('Google will ask you to sign in again to check it’s you.');
    expect([...document.querySelectorAll('.actions button')].map((b) => [b.id, b.textContent])).toEqual([
      ['banner-remove-confirm', 'Remove it'],
      ['banner-remove-back', 'Go back'],
    ]);
    expect(s.win.location.assigned).toHaveLength(0);
    expect(slotWrites(s, 3)).toBe(0);
    expect(pageText()).not.toContain('@');
  });

  it('Go back: the same banners, nothing written or marked seen; then Done answers keep, once', async () => {
    const s = await withBanners([recent({ provider: 'google' }), recent({ effectiveAtMs: NOW - 30 * DAY })]);
    click('banner-unlink-1');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the email address from this wallet?');
    click('banner-remove-back');
    expect(s.page.stage).toBe('banners');
    expect(seen(document.getElementById('banner-unlink-0'))).toBe('Remove it');
    expect(document.getElementById('link-older')).not.toBeNull();
    expect(seenKeys()).toEqual([]);
    expect(slotWrites(s, 3)).toBe(0);
    // A Google account is named so too.
    click('banner-unlink-0');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the Google account from this wallet?');
    click('banner-remove-back');
    const done = document.getElementById('banner-done') as HTMLButtonElement;
    done.click();
    done.click();
    expect(await s.answerIn(3)).toEqual({ choice: 'keep' });
    await vi.waitFor(() => expect(s.win.closed).toBe(true));
    expect(slotWrites(s, 3)).toBe(1);
    expect(seenKeys()).toHaveLength(1);
  });

  it('Remove it, a Google proof, back through /login/callback: the result shows instead of the window closing', async () => {
    const s = await withBanners([recent()]);
    click('banner-unlink-0');
    // A double press is one press (the buttons are disabled too).
    const go = document.getElementById('banner-remove-confirm') as HTMLButtonElement;
    go.click();
    go.click();
    await flush();
    expect(s.win.location.assigned).toHaveLength(1);
    const url = new URL(s.win.location.assigned[0]!);
    expect([url.searchParams.get('nonce'), url.searchParams.get('login_hint'), url.searchParams.get('state')]).toEqual([nonce, SUBJECT, followSlot(s.followKey, 3).id]);
    // What the window remembers across the round trip: kinds and the slot only.
    expect(readEmailContext(window.sessionStorage, s.relayId, NOW)?.context.bannerAction).toEqual({ kind: 'unlink', provider: 'email', method: 'google', slot: 4, signedIn: true });
    const back = backFromGoogle(s, 4);
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Removing the email address'));
    expect(pageText()).toContain('This takes a few seconds…');
    await s.vaultSays(4, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(back.stage).toBe('link_changed'));
    expect(s.win.closed).toBe(false);
    expect(result()?.getAttribute('data-outcome')).toBe('done');
    expect(document.querySelector('h1')?.textContent).toBe('The email address was removed');
    expect(document.getElementById('link-change-what')?.className).toContain('jp-alert-success');
    expect(text('link-change-what')).toBe('The email address no longer opens this wallet. Removing it didn’t move any money.');
    expect(text('link-change-signin')).toBe('Devices signed in to this wallet, this one too, will be asked to sign in again.');
    expect(text('link-change-next')).toBe('If you sign in with that email address later, it opens a new, empty wallet of its own. It won’t be added back automatically.');
    expect(text('link-change-advice')).toBe('Didn’t add it yourself? Someone else may have used this wallet while it was added. To be safe, move your money to a new wallet. Signing in the same way opens this same wallet, so use a different email address or another wallet app.');
    expect(back.notice).toBe('link_removed');
    // Done with: the context (and what it remembered) is gone.
    expect(readEmailContext(window.sessionStorage, s.relayId, NOW)).toBeNull();
    click('link-change-close');
    expect(s.win.closed).toBe(true);
  });

  it('an email root’s Remove: one more code to the address this window proved, then the result in the same window', async () => {
    const s = await emailRootWith([recent({ provider: 'google', action: { kind: 'unlink', prove: { method: 'email', purpose: 'link_change', commitment: emailCommitment } } })]);
    click('banner-unlink-0');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the Google account from this wallet?');
    expect(text('banner-remove-check')).toBe('We’ll send one more code to your email address to check it’s you.');
    click('banner-remove-confirm');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    expect(s.issuer.startLink).toHaveBeenCalledWith(PK, 'ada@example.com', 'link_change', emailCommitment, null);
    typeInto('email-code', '333333');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'proof' });
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Removing the Google account'));
    await s.vaultSays(4, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_changed'));
    expect(document.querySelector('h1')?.textContent).toBe('The Google account was removed');
    expect(slotWrites(s, 3)).toBe(1);
  });

  it('Remove → fails → Close: each stop says whether anything changed and what to do; nothing is marked seen or written again', async () => {
    const cases: [string, string, string, string | null][] = [
      ['token_invalid', 'not_you', 'Nothing changed. The email address still opens this wallet. We couldn’t check it was you.', 'Close this window, then sign in to Partner App again to try again.'],
      ['link_refused', 'changed', 'Nothing was changed. The ways to sign in to this wallet may have changed after this window opened.', 'Close this window, then sign in to Partner App again to see them as they are now.'],
      ['rate_limited', 'busy', 'Nothing changed. The email address still opens this wallet. Journear couldn’t do this just now.', 'Close this window, then sign in to Partner App again later to try again.'],
      ['links_unavailable', 'busy', 'Nothing changed. The email address still opens this wallet. Journear couldn’t do this just now.', null],
      ['api_unavailable', 'unknown', 'Something went wrong, so we can’t tell whether the email address was removed.', 'Sign in to Partner App again. If the email address still opens this wallet, you’ll see it there with a button to remove it.'],
      ['near_unavailable', 'busy', 'Nothing changed. The email address still opens this wallet. Journear couldn’t do this just now.', null],
      ['link_in_flight', 'unknown', 'Something went wrong, so we can’t tell whether the email address was removed.', null],
    ];
    for (const [code, outcome, what, advice] of cases) {
      window.localStorage.clear();
      resetDom();
      const s = await withBanners([recent({ effectiveAtMs: NOW - 30 * DAY })]);
      click('banner-unlink-0');
      click('banner-remove-confirm');
      await flush();
      const back = backFromGoogle(s, 4);
      await s.vaultSays(4, { t: 'stop', code });
      await vi.waitFor(() => expect(back.stage, code).toBe('link_changed'));
      expect(result()?.getAttribute('data-outcome'), code).toBe(outcome);
      expect(document.querySelector('h1')?.textContent, code).toBe(outcome === 'unknown' ? 'We couldn’t check the removal' : 'The email address wasn’t removed');
      expect(text('link-change-what'), code).toBe(what);
      expect(document.getElementById('link-change-what')?.className, code).toContain('jp-alert-warning');
      if (advice) expect(text('link-change-advice'), code).toBe(advice);
      expect(text('link-change-why'), code).toBe(code === 'token_invalid' ? 'If you picked a different Google account, try again with the one you signed in with.' : null);
      expect(pageText(), code).toContain(`Error code (for support): ${code}`);
      expect(back.notice).toBe(code);
      click('link-change-close');
      expect(s.win.closed, code).toBe(true);
      expect(seenKeys(), code).toEqual([]);
      expect(slotWrites(s, 3), code).toBe(0);
    }
  });

  it('Cancel this link: no confirmation; then “Link cancelled”, or a truthful failure', async () => {
    const s = await withBanners([waiting()]);
    click('banner-cancel-0');
    await flush();
    expect(s.win.location.assigned).toHaveLength(1);
    let back = backFromGoogle(s, 4);
    await vi.waitFor(() => expect(document.querySelector('h1')?.textContent).toBe('Cancelling the link'));
    await s.vaultSays(4, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(back.stage).toBe('link_changed'));
    expect(document.querySelector('h1')?.textContent).toBe('Link cancelled');
    expect(text('link-change-what')).toBe('The email address is no longer being linked to this wallet, so it won’t open it.');
    expect(text('link-change-signin')).toBe('Devices signed in to this wallet, this one too, will be asked to sign in again.');
    expect(back.notice).toBe('link_cancelled');
    click('link-change-close');
    expect(s.win.closed).toBe(true);

    const failures: [string, string, string | null][] = [
      ['token_invalid', 'Nothing changed. The link is still waiting. We couldn’t check it was you.', 'Close this window, then sign in to Partner App again to try again.'],
      ['link_refused', 'Nothing was changed. The ways to sign in to this wallet may have changed after this window opened.', null],
      ['rate_limited', 'Nothing changed. The link is still waiting. Journear couldn’t do this just now.', null],
      ['api_unavailable', 'Something went wrong, so we can’t tell whether the link was cancelled.', 'Sign in to Partner App again. If the link is still waiting, you’ll see Cancel this link again.'],
    ];
    for (const [code, what, advice] of failures) {
      resetDom();
      const f = await withBanners([waiting({ provider: 'google' })]);
      click('banner-cancel-0');
      await flush();
      back = backFromGoogle(f, 4);
      await f.vaultSays(4, { t: 'stop', code });
      await vi.waitFor(() => expect(back.stage, code).toBe('link_changed'));
      expect(document.querySelector('h1')?.textContent, code).toBe(code === 'api_unavailable' ? 'We couldn’t check the link' : 'The link wasn’t cancelled');
      expect(text('link-change-what'), code).toBe(what);
      if (advice) expect(text('link-change-advice'), code).toBe(advice);
    }
  });

  it('an email root’s Cancel: the code to this address, no confirmation; a stop is that cancel’s, not the sign-in’s', async () => {
    const s = await emailRootWith([waiting({ provider: 'google', action: { kind: 'cancel', prove: { method: 'email', purpose: 'link_change', commitment: { ...emailCommitment, action: 'cancel' } } } })]);
    click('banner-cancel-0');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    typeInto('email-code', '444444');
    submit('email-verify');
    expect(await s.answerIn(3)).toEqual({ idToken: TOKEN, as: 'proof' });
    await s.vaultSays(4, { t: 'stop', code: 'token_invalid' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_changed'));
    expect(document.querySelector('h1')?.textContent).toBe('The link wasn’t cancelled');
    // Not Google: no "another Google account" line.
    expect(text('link-change-why')).toBeNull();
  });

  it('a sign-in that stopped (its banners on the stop screen): its result’s Close just closes, even with the sharing sheet asked for', async () => {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'stop', code: 'link_pending', banners: [waiting()] });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    click('banner-cancel-0');
    await flush();
    expect(readEmailContext(window.sessionStorage, s.relayId, NOW)?.context.bannerAction?.signedIn).toBe(false);
    const back = backFromGoogle(s, 4);
    markEmailShare(window.sessionStorage, s.relayId, NOW);
    await s.vaultSays(4, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(back.stage).toBe('link_changed'));
    click('link-change-close');
    expect(s.win.closed).toBe(true);
    expect(s.win.location.assigned).toEqual([]);
  });

  it('a finished sign-in’s result Close goes on to the sharing sheet when the app asks for it (D411)', async () => {
    const s = await withBanners([recent()]);
    click('banner-unlink-0');
    click('banner-remove-confirm');
    await flush();
    const back = backFromGoogle(s, 4);
    markEmailShare(window.sessionStorage, s.relayId, NOW);
    await s.vaultSays(4, { t: 'done', banners: [] });
    await vi.waitFor(() => expect(back.stage).toBe('link_changed'));
    click('link-change-close');
    expect(s.win.location.assigned).toEqual([`${SHARE_PATH}?from=login`]);
    expect(s.win.closed).toBe(false);
  });

  it('an email root’s check left at the code step (Cancel): nothing changed, said plainly, never “Removing…” then “Sign-in cancelled”', async () => {
    const s = await emailRootWith([recent({ provider: 'google', action: { kind: 'unlink', prove: { method: 'email', purpose: 'link_change', commitment: emailCommitment } } })]);
    click('banner-unlink-0');
    click('banner-remove-confirm');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    const seen: string[] = [];
    const watch = new MutationObserver(() => seen.push(document.querySelector('h1')?.textContent ?? ''));
    watch.observe(document.getElementById('app')!, { childList: true, subtree: true });
    click('email-cancel');
    expect(await s.answerIn(3)).toEqual({ error: 'email_cancelled' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_changed'));
    watch.disconnect();
    expect(seen.filter((h) => /Removing|Sign-in cancelled|Signing in/u.test(h))).toEqual([]);
    expect(result()?.getAttribute('data-outcome')).toBe('not_proved');
    expect(document.querySelector('h1')?.textContent).toBe('The Google account wasn’t removed');
    expect(text('link-change-what')).toBe('Nothing changed. The Google account still opens this wallet. The check was cancelled before the code was entered.');
    expect(text('link-change-advice')).toBe('Close this window, then sign in to Partner App again to try again.');
    expect(s.win.closed).toBe(false);
    markEmailShare(window.sessionStorage, s.relayId, NOW);
    click('link-change-close');
    expect(s.win.location.assigned).toEqual([`${SHARE_PATH}?from=login`]);
  });

  it('an email root’s check that can’t send a code (email unavailable): nothing changed, and why', async () => {
    const s = await emailRootWith([waiting({ provider: 'google', action: { kind: 'cancel', prove: { method: 'email', purpose: 'link_change', commitment: { ...emailCommitment, action: 'cancel' } } } })]);
    s.issuer.startLink.mockRejectedValueOnce(new ApiError(403, 'email_not_enabled', 'off', null, null));
    click('banner-cancel-0');
    expect(await s.answerIn(3)).toEqual({ error: 'email_unavailable' });
    await vi.waitFor(() => expect(s.page.stage).toBe('link_changed'));
    expect(document.querySelector('h1')?.textContent).toBe('The link wasn’t cancelled');
    expect(text('link-change-what')).toBe('Nothing changed. The link is still waiting. We couldn’t send a code to check it’s you.');
  });

  it('the vault’s word never comes, or can’t be read: “can’t tell”, never sign-in words', async () => {
    const cases: [string, (s: Setup) => EmailPage | Promise<EmailPage>, string][] = [
      ['the 10-minute limit', (s) => backFromGoogle(s, 4, NOW + FOLLOW_LIMIT_MS), 'login_timeout'],
      [
        'a slot that is gone (410)',
        (s) => {
          s.api.readRelay.mockRejectedValue(new ApiError(410, 'relay_expired', 'gone', null, null));
          return backFromGoogle(s, 4);
        },
        'relay_expired',
      ],
      [
        'a notice that can’t be read',
        async (s) => {
          const page = backFromGoogle(s, 4);
          const { id } = followSlot(s.followKey, 4);
          await s.api.writeRelay(id, await encryptRelayValue(crypto.getRandomValues(new Uint8Array(32)), id, { t: 'done', banners: [] }));
          return page;
        },
        'token_invalid',
      ],
    ];
    for (const [what, back, code] of cases) {
      resetDom();
      const s = await withBanners([recent()]);
      click('banner-unlink-0');
      click('banner-remove-confirm');
      await flush();
      const page = await back(s);
      await vi.waitFor(() => expect(page.stage, what).toBe('link_changed'));
      expect(result()?.getAttribute('data-outcome'), what).toBe('unknown');
      expect(document.querySelector('h1')?.textContent, what).toBe('We couldn’t check the removal');
      expect(pageText(), what).toContain(`Error code (for support): ${code}`);
    }
  });

  it('a proof whose write fails may have reached the vault: “can’t tell”', async () => {
    const s = await emailRootWith([recent({ provider: 'google', action: { kind: 'unlink', prove: { method: 'email', purpose: 'link_change', commitment: emailCommitment } } })]);
    click('banner-unlink-0');
    click('banner-remove-confirm');
    await vi.waitFor(() => expect(s.page.stage).toBe('code'));
    s.api.writeRelay.mockRejectedValueOnce(new Error('network'));
    typeInto('email-code', '333333');
    submit('email-verify');
    await vi.waitFor(() => expect(s.page.stage).toBe('link_changed'));
    expect(result()?.getAttribute('data-outcome')).toBe('unknown');
    expect(text('link-change-what')).toBe('Something went wrong, so we can’t tell whether the Google account was removed.');
  });

  it('what each stop code means (the API answers before sending anything, or may have sent it)', () => {
    expect(changeFailure('token_invalid')).toBe('not_you');
    expect(changeFailure('link_refused')).toBe('changed');
    // Refused before anything was relayed (apps/api links.ts), a relay that certainly didn't run, or a reverted refusal.
    for (const c of ['rate_limited', 'rate_limiter_unavailable', 'links_unavailable', 'link_pending', 'bad_request', 'nonce_mismatch', 'token_expired', 'near_unavailable', 'near_rejected', 'relayer_busy', 'relayer_unconfigured', 'method_not_allowed']) expect(changeFailure(c), c).toBe('busy');
    for (const c of ['api_unavailable', 'relayer_unavailable', 'link_in_flight', 'timeout', 'outcome_unknown', 'something_new']) expect(changeFailure(c), c).toBe('unknown');
    expect([kindName('google'), kindName('email')]).toEqual(['Google account', 'email address']);
    expect(CHANGE_TEXT.removeButton).toBe('Remove it');
  });
});

describe('D887: a banner’s Remove or Cancel is findable: “Don’t recognise it?” and a small outlined button on its own line, still quiet', () => {
  const DAY = 24 * 3_600_000;
  const googleProof = { method: 'google', nonce: 'R'.repeat(43), loginHint: SUBJECT } as const;
  const active = (age: number, o: Partial<LinkBanner> = {}): LinkBanner => ({ provider: 'email', status: 'active', effectiveAtMs: NOW - age, fresh: false, action: { kind: 'unlink', prove: googleProof }, ...o });
  const waiting = (o: Partial<LinkBanner> = {}): LinkBanner => ({ provider: 'email', status: 'pending', effectiveAtMs: NOW + DAY, fresh: false, action: { kind: 'cancel', prove: googleProof }, ...o });
  const SMALL = 'jp-btn jp-btn-secondary jp-btn-sm';
  const DONE = 'primary jp-btn jp-btn-primary jp-btn-lg';

  async function screen(banners: LinkBanner[]): Promise<Setup> {
    const s = setup({ next: 2 });
    await s.vaultSays(2, { t: 'done', banners });
    await vi.waitFor(() => expect(s.page.stage).toBe('banners'));
    return s;
  }
  /**
   * Each button on the screen: id, what the eye reads, its accessible name (no aria-label: its text, the visually
   * hidden part included), the sentence that describes it, its class.
   */
  const buttons = () =>
    [...document.querySelectorAll('#app button')].map((b) => {
      const by = b.getAttribute('aria-describedby');
      return [b.id, seen(b), b.getAttribute('aria-label') ?? b.textContent, by ? (document.getElementById(by)?.textContent ?? 'missing') : null, b.className];
    });
  /** Done: the one primary button, last, large; nothing else on the screen is primary or red. */
  function doneIsThePrimary(): void {
    const all = [...document.querySelectorAll('#app button')];
    expect(all.filter((b) => b.className.includes('jp-btn-primary')).map((b) => b.id)).toEqual(['banner-done']);
    expect(all.at(-1)?.id).toBe('banner-done');
    expect(document.getElementById('banner-done')?.className).toBe(DONE);
    expect(document.querySelector('#app .jp-btn-danger, #app button.link')).toBeNull();
  }
  /** WCAG 2.5.3: every button's accessible name starts with the words it shows; the rest is visually hidden only. */
  function namesStartWithTheirWords(): void {
    for (const b of document.querySelectorAll('#app button')) {
      expect(b.getAttribute('aria-label'), b.id).toBeNull();
      const name = b.textContent ?? '';
      expect(name.startsWith(seen(b) ?? '\u0000'), `${b.id}: “${name}”`).toBe(true);
      for (const hidden of b.querySelectorAll('.sr-only')) expect(hidden.parentElement, b.id).toBe(b);
    }
  }

  it('the words in one place', () => {
    expect(BANNER_ACTION_TEXT.lead).toBe('Don’t recognise it?');
    expect([BANNER_ACTION_TEXT.remove, BANNER_ACTION_TEXT.removeFresh, BANNER_ACTION_TEXT.cancel]).toEqual(['Remove it', 'Remove', 'Cancel this link']);
    expect([BANNER_ACTION_TEXT.removeMore('email address'), BANNER_ACTION_TEXT.removeFreshMore('Google account'), BANNER_ACTION_TEXT.cancelMore('email address')]).toEqual([
      ' (the email address)',
      ' the Google account from this wallet',
      ' for the email address',
    ]);
    // The just-added Remove's name is the confirmation's own question (D881), without its question mark.
    expect(`${BANNER_ACTION_TEXT.removeFresh}${BANNER_ACTION_TEXT.removeFreshMore('email address')}?`).toBe(CHANGE_TEXT.confirmTitle('email address'));
  });

  it('one older line: the sentence plain; under it “Don’t recognise it?” and a small outlined “Remove it”, named “Remove it (the email address)” and described by its sentence; no box, colour or icon; Done the one primary', async () => {
    await screen([active(30 * DAY)]);
    const line = document.querySelector('#link-older > .older-link')!;
    expect([...line.children].map((e) => `${e.tagName}.${e.className}`)).toEqual(['P.older-link-text', 'P.banner-action']);
    const action = line.querySelector(':scope > p.banner-action')!;
    expect([...action.children].map((e) => [e.tagName, e.className, seen(e)])).toEqual([
      ['SPAN', 'banner-action-lead', 'Don’t recognise it?'],
      ['BUTTON', SMALL, 'Remove it'],
    ]);
    const sentence = line.querySelector('.older-link-text')!.textContent!;
    expect(sentence).toMatch(/^An email address also opens this wallet, since .+\.$/u);
    expect(buttons()).toEqual([
      ['banner-unlink-0', 'Remove it', 'Remove it (the email address)', sentence, SMALL],
      ['banner-done', 'Done', 'Done', null, DONE],
    ]);
    expect(document.querySelector('#banner-unlink-0 > .sr-only')?.textContent).toBe(' (the email address)');
    expect(document.getElementById('banner-unlink-0')?.getAttribute('type')).toBe('button');
    namesStartWithTheirWords();
    // Still quiet: no banner box, alert, icon or colour class on the line.
    expect(document.getElementById('link-banners')).toBeNull();
    expect(document.querySelector('#link-older .jp-alert, #link-older [role="alert"], #link-older svg, #link-older .banner')).toBeNull();
    // The note, then Done, come after the line (D875's order).
    const order = [...document.querySelectorAll('#app .older-link, #app #link-older > p.muted, #app #banner-done')].map((e) => e.id || e.className);
    expect(order).toEqual(['older-link', 'muted', 'banner-done']);
    expect(document.querySelector('#link-older > p.muted')?.textContent).toBe(OLDER_LINK_NOTE);
    doneIsThePrimary();
  });

  it('two older lines (an email address and a Google account): each its own sentence with its own pair, told apart by name and description; each goes to its own confirmation', async () => {
    const s = await screen([active(30 * DAY), active(90 * DAY, { provider: 'google' })]);
    const lines = [...document.querySelectorAll('#link-older > .older-link')];
    expect(lines.map((l) => [l.getAttribute('data-provider'), l.querySelector('.older-link-text')?.textContent?.split(',')[0], l.querySelector('button')?.id, l.querySelectorAll('button').length])).toEqual([
      ['email', 'An email address also opens this wallet', 'banner-unlink-0', 1],
      ['google', 'A Google account also opens this wallet', 'banner-unlink-1', 1],
    ]);
    expect(buttons().map(([id, label, name, described]) => [id, label, name, String(described).split(',')[0]])).toEqual([
      ['banner-unlink-0', 'Remove it', 'Remove it (the email address)', 'An email address also opens this wallet'],
      ['banner-unlink-1', 'Remove it', 'Remove it (the Google account)', 'A Google account also opens this wallet'],
      ['banner-done', 'Done', 'Done', 'null'],
    ]);
    namesStartWithTheirWords();
    // The note once, under both lines.
    expect(document.querySelectorAll('#link-older > p.muted')).toHaveLength(1);
    doneIsThePrimary();
    click('banner-unlink-1');
    expect(s.page.stage).toBe('banner_confirm');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the Google account from this wallet?');
    click('banner-remove-back');
    click('banner-unlink-0');
    expect(document.querySelector('h1')?.textContent).toBe('Remove the email address from this wallet?');
    // Nothing sent, written or marked seen on the way (only Done marks a line seen, D875).
    expect(s.win.location.assigned).toHaveLength(0);
    expect(Object.keys(window.localStorage).filter((k) => k.startsWith('hana.ol.'))).toEqual([]);
  });

  it('the mixed screen: a recent banner (its pair inside its box, under its sentence) and an older line (its pair under its own); one Done', async () => {
    await screen([active(2 * DAY), active(30 * DAY, { provider: 'google' })]);
    const li = document.querySelector('#link-banners > li.banner[data-status="active"]')!;
    const said = li.querySelector('.banner-what')?.textContent ?? '';
    expect(said).toMatch(/^A sign-in method was added: email on .+\.$/u);
    expect(li.querySelector('.banner-what button')).toBeNull();
    expect([...li.querySelectorAll('.banner-text > p.banner-action > *')].map(seen)).toEqual(['Don’t recognise it?', 'Remove it']);
    expect(li.querySelector('button')?.id).toBe('banner-unlink-0');
    expect(document.querySelector('#link-older .older-link button')?.id).toBe('banner-unlink-1');
    expect(buttons().map((b) => [b[0], b[1], b[2], b[4]])).toEqual([
      ['banner-unlink-0', 'Remove it', 'Remove it (the email address)', SMALL],
      ['banner-unlink-1', 'Remove it', 'Remove it (the Google account)', SMALL],
      ['banner-done', 'Done', 'Done', DONE],
    ]);
    expect(buttons()[0]![3]).toBe(said);
    namesStartWithTheirWords();
    doneIsThePrimary();
  });

  it('the waiting banner: “Don’t recognise it?” and a small outlined “Cancel this link” named for whose link; no confirmation (D881)', async () => {
    for (const provider of ['email', 'google'] as const) {
      resetDom();
      const s = await screen([waiting({ provider })]);
      const li = document.querySelector('#link-banners > li.banner.pending')!;
      const said = li.querySelector('.banner-what')?.textContent ?? '';
      expect(said).toMatch(provider === 'email' ? /^An email will be able to open this wallet from .+\.$/u : /^A Google account will be able to open this wallet from .+\.$/u);
      expect([...li.querySelectorAll('.banner-text > p.banner-action > *')].map(seen)).toEqual(['Don’t recognise it?', 'Cancel this link']);
      expect(buttons()[0]).toEqual(['banner-cancel-0', 'Cancel this link', `Cancel this link for the ${kindName(provider)}`, said, SMALL]);
      namesStartWithTheirWords();
      doneIsThePrimary();
      click('banner-cancel-0');
      expect(s.page.stage).not.toBe('banner_confirm');
    }
  });

  it('a way to sign in this sign-in just added: the small button alone (no question), “Remove” or “Cancel this link”, named for what it changes', async () => {
    await screen([active(0, { fresh: true })]);
    expect([...document.querySelectorAll('.banner-action > *')].map((e) => [e.tagName, seen(e)])).toEqual([['BUTTON', 'Remove']]);
    const [id, label, name, , cls] = buttons()[0]!;
    expect([id, label, name, cls]).toEqual(['banner-unlink-0', 'Remove', 'Remove the email address from this wallet', SMALL]);
    namesStartWithTheirWords();
    resetDom();
    await screen([waiting({ fresh: true })]);
    expect([...document.querySelectorAll('.banner-action > *')].map((e) => [e.tagName, seen(e)])).toEqual([['BUTTON', 'Cancel this link']]);
    expect(buttons()[0]!.slice(0, 3)).toEqual(['banner-cancel-0', 'Cancel this link', 'Cancel this link for the email address']);
    namesStartWithTheirWords();
    expect(pageText()).not.toContain(BANNER_ACTION_TEXT.lead);
  });

  it('a banner without an action has no action line', async () => {
    await screen([active(2 * DAY, { action: undefined }), waiting({ action: undefined })]);
    expect(document.querySelector('.banner-action')).toBeNull();
    expect(pageText()).not.toContain(BANNER_ACTION_TEXT.lead);
  });

  it('what Passport Home tells people to press is the window’s own label, word for word, in quotation marks, after the same question', () => {
    expect(SIGN_IN_TEXT.removeAtSignIn).toBe(`${BANNER_ACTION_TEXT.lead} Sign in to this app the way you signed in here, and choose “${BANNER_ACTION_TEXT.remove}”. If you’re not sure, remove it.`);
    // An automatic same-address Google link: Home's softer, more specific question (D865); the same button.
    expect(SIGN_IN_TEXT.removeAtSignInAuto).toBe(`Don’t recognise this Google account? Sign in to this app the way you signed in here, and choose “${BANNER_ACTION_TEXT.remove}”.`);
    expect(SIGN_IN_TEXT.cancelAtSignIn).toBe(`${BANNER_ACTION_TEXT.lead} Sign in to this app the way you signed in here, and choose “${BANNER_ACTION_TEXT.cancel}”. If you’re not sure, cancel it.`);
    // D898 option A: the same question, and the window's own label in its steps.
    expect(SIGN_IN_TEXT.cancelOpenLead).toBe(`${BANNER_ACTION_TEXT.lead} If you’re not sure, cancel it.`);
    expect(SIGN_IN_TEXT.cancelOpenSteps).toBe(`There, sign in the way you signed in here, and choose “${BANNER_ACTION_TEXT.cancel}”.`);
    expect(SIGN_IN_TEXT.removeAtSignInOnceNotOffered).toBe('Once you press “Done” in the sign-in window, that browser stops offering to remove it. Not offered? Try signing in in a private window.');
    // Every button Home names is in quotation marks, and none is the old bare "Remove".
    for (const t of Object.values(SIGN_IN_TEXT)) {
      expect(t).not.toMatch(/(choose|press) (?!“)/u);
      expect(t).not.toMatch(/Didn’t add it\?/u);
    }
  });
});
