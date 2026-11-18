// @vitest-environment happy-dom
// The support pages (D866; auth/support-page.ts): /email/unlock and /email/confirm. Each shows one button and does
// nothing until it is pressed (no request on load: link scanners and mail previews open links), sends one request per
// press (a double click is one), and says every answer in plain words (D853). The unlock keeps its token for
// /login/email, which sends it with `start` and drops it after a sign-in with its address.
import { jargonIn } from '@hana-id/brand/plain-words';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UNLOCK_TOKEN_KEY, dropUnlockTokenFor, liveUnlockToken, saveUnlockToken } from '../../src/auth/email-storage.ts';
import { emailApi } from '../../src/auth/email-api.ts';
import { type PressAnswer, SUPPORT_TEXT, type SupportKind, startSupportPage, supportApi } from '../../src/auth/support-page.ts';
import { FakeWindow, flush, pageText, resetDom } from './helpers.ts';

const UG = `ug1.${'A'.repeat(43)}`;
const UC = `uc1.${'B'.repeat(43)}`;
const NOW = Date.UTC(2027, 3, 1, 9);
const UNTIL = NOW + 24 * 3_600_000 - 1000;

let storage: Storage;
beforeEach(() => {
  resetDom();
  window.localStorage.clear();
  storage = window.localStorage;
});

const button = () => document.querySelector<HTMLButtonElement>('#support-press');
const press = () => button()?.dispatchEvent(new MouseEvent('click', { bubbles: true }));

function open(kind: SupportKind, hash: string, answer: () => Promise<PressAnswer>) {
  const win = new FakeWindow(kind === 'unlock' ? '/email/unlock' : '/email/confirm', '', hash);
  const api = { press: vi.fn(async (_k: SupportKind, _t: string) => answer()) };
  const page = startSupportPage({ win, kind, api, storage, now: () => NOW });
  return { api, page };
}

describe('/email/unlock', () => {
  it('nothing happens on load: one button, the plain reason, the safe default', async () => {
    const { api, page } = open('unlock', `#${UG}`, async () => ({ kind: 'done', email: 'ada@example.com', untilMs: UNTIL }));
    await flush();
    expect(api.press).not.toHaveBeenCalled();
    expect(page.state).toBe('ready');
    expect(document.querySelector('h1')?.textContent).toBe(SUPPORT_TEXT.unlock.title);
    expect(pageText()).toContain(SUPPORT_TEXT.unlock.lead);
    expect(pageText()).toContain(SUPPORT_TEXT.ignore);
    expect(document.querySelectorAll('button')).toHaveLength(1);
    expect(button()?.textContent).toBe('Unlock my email');
    expect(storage.getItem(UNLOCK_TOKEN_KEY)).toBeNull();
  });

  it('the press: one request with the fragment’s token, then the address and the end time; the token kept for sign-in', async () => {
    let resolve!: (a: PressAnswer) => void;
    const { api, page } = open('unlock', `#${UG}`, () => new Promise((r) => (resolve = r)));
    press();
    // A double click (or Enter then a click) while the first is in flight: still one request.
    press();
    press();
    expect(api.press).toHaveBeenCalledTimes(1);
    expect(api.press).toHaveBeenCalledWith('unlock', UG);
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe(SUPPORT_TEXT.unlock.busy);
    resolve({ kind: 'done', email: 'ada@example.com', untilMs: UNTIL });
    expect(await page.settled()).toBe('done');
    expect(document.querySelector('h1')?.textContent).toBe(SUPPORT_TEXT.unlock.doneTitle);
    expect(pageText()).toContain('Your email is unlocked. You can sign in again.');
    expect(document.querySelector('.support-email')?.textContent).toBe('Email: ada@example.com');
    expect(pageText()).toContain('Go back to the app and sign in with this email in this browser. Do it before ');
    expect(pageText()).toContain(SUPPORT_TEXT.close);
    // Nothing else to do here: no button, no sign-in.
    expect(document.querySelectorAll('button, a, input')).toHaveLength(0);
    expect(liveUnlockToken(storage, NOW)).toBe(UG);
  });

  it('says each other answer in its own words; a limit or an unreachable service offers the one button again', async () => {
    const cases: [PressAnswer, string, string][] = [
      [{ kind: 'used' }, 'used', SUPPORT_TEXT.unlock.used],
      [{ kind: 'expired' }, 'expired', 'This link has expired. Ask the app’s support to send a new email.'],
      [{ kind: 'invalid' }, 'invalid', SUPPORT_TEXT.invalid],
      [{ kind: 'failed', code: 'bad_request' }, 'failed', SUPPORT_TEXT.failed],
    ];
    for (const [answer, state, text] of cases) {
      resetDom();
      const { page } = open('unlock', `#${UG}`, async () => answer);
      press();
      expect(await page.settled()).toBe(state);
      expect(pageText()).toContain(text);
      expect(document.querySelectorAll('button')).toHaveLength(0);
      if (answer.kind === 'failed') expect(pageText()).toContain('Error code (for support): bad_request');
      expect(storage.getItem(UNLOCK_TOKEN_KEY)).toBeNull();
    }
    for (const [kind, text] of [['unreachable', SUPPORT_TEXT.unreachable], ['limited', SUPPORT_TEXT.limited]] as const) {
      resetDom();
      let n = 0;
      const { api, page } = open('unlock', `#${UG}`, async () => (n++ === 0 ? { kind } : { kind: 'done', email: 'ada@example.com', untilMs: UNTIL }));
      press();
      expect(await page.settled()).toBe(kind);
      expect(pageText()).toContain(text);
      expect(button()?.textContent).toBe(SUPPORT_TEXT.retry);
      // Trying again is a press too.
      await flush();
      expect(api.press).toHaveBeenCalledTimes(1);
      press();
      expect(await page.settled()).toBe('done');
      expect(api.press).toHaveBeenCalledTimes(2);
    }
  });

  it('a missing, malformed or other action’s token: not valid at once, no request, nothing from the URL on the page', async () => {
    for (const hash of ['', '#', `#${UC}`, `#${UG}x`, '#ug1.<b>bold</b>', `#${UG.slice(0, -1)}`]) {
      resetDom();
      const { api, page } = open('unlock', hash, async () => ({ kind: 'done', email: 'x@example.com', untilMs: UNTIL }));
      expect(page.state).toBe('invalid');
      expect(pageText()).toContain(SUPPORT_TEXT.invalid);
      expect(api.press).not.toHaveBeenCalled();
      expect(document.querySelector('b')).toBeNull();
      if (hash.length > 1) expect(pageText()).not.toContain(hash.slice(1));
    }
  });

  it('refuses to run in a frame', () => {
    const win = new FakeWindow('/email/unlock', '', `#${UG}`);
    win.top = {};
    const api = { press: vi.fn() };
    const page = startSupportPage({ win, kind: 'unlock', api, storage });
    expect(page.state).toBe('invalid');
    expect(pageText()).toContain(SUPPORT_TEXT.framed);
  });

  it('storage blocked: says the unlock won’t work in this browser, and what to do', async () => {
    const blocked = { setItem: () => { throw new Error('quota'); }, getItem: () => null, removeItem: () => {} } as unknown as Storage;
    const win = new FakeWindow('/email/unlock', '', `#${UG}`);
    const page = startSupportPage({ win, kind: 'unlock', api: { press: async () => ({ kind: 'done', email: 'ada@example.com', untilMs: UNTIL }) }, storage: blocked, now: () => NOW });
    press();
    expect(await page.settled()).toBe('failed');
    expect(pageText()).toContain(SUPPORT_TEXT.unlock.notSaved);
  });
});

describe('/email/confirm', () => {
  it('one button; the press confirms and says codes will come again, with the spam advice; nothing else to do', async () => {
    const { api, page } = open('confirm', `#${UC}`, async () => ({ kind: 'done', email: 'ada@example.com', untilMs: null }));
    await flush();
    expect(api.press).not.toHaveBeenCalled();
    expect(pageText()).toContain(SUPPORT_TEXT.confirm.lead);
    expect(pageText()).toContain(SUPPORT_TEXT.confirm.ask);
    expect(button()?.textContent).toBe('Yes, this is my email');
    press();
    press();
    expect(await page.settled()).toBe('done');
    expect(api.press).toHaveBeenCalledTimes(1);
    expect(api.press).toHaveBeenCalledWith('confirm', UC);
    expect(pageText()).toContain('Thanks: this email is confirmed. We’ll send sign-in codes to it again.');
    expect(pageText()).toContain(SUPPORT_TEXT.confirm.spam);
    expect(document.querySelector('.support-email')?.textContent).toBe('Email: ada@example.com');
    expect(document.querySelectorAll('button, a, input')).toHaveLength(0);
    // The confirm page stores nothing.
    expect(storage.length).toBe(0);
  });

  it('already used, expired, not valid', async () => {
    for (const [answer, text] of [
      [{ kind: 'used' }, SUPPORT_TEXT.confirm.used],
      [{ kind: 'expired' }, SUPPORT_TEXT.expired],
      [{ kind: 'invalid' }, SUPPORT_TEXT.invalid],
    ] as [PressAnswer, string][]) {
      resetDom();
      const { page } = open('confirm', `#${UC}`, async () => answer);
      press();
      await page.settled();
      expect(pageText()).toContain(text);
    }
    resetDom();
    expect(open('confirm', `#${UG}`, async () => ({ kind: 'used' })).page.state).toBe('invalid');
  });
});

describe('supportApi: the press is a POST to the issuer with the token in the body, and its answers', () => {
  const ISSUER = 'https://issuer.example/ignored/path';
  const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('posts JSON, no cookies, no referrer, to the action’s own endpoint', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return url.endsWith('/unlock') ? reply(200, { unlocked: true, email: 'ada@example.com', expiresAtMs: UNTIL }) : reply(200, { confirmed: 'unsuppress', email: 'ada@example.com' });
    }) as unknown as typeof fetch;
    const api = supportApi(ISSUER, f);
    expect(await api.press('unlock', UG)).toEqual({ kind: 'done', email: 'ada@example.com', untilMs: UNTIL });
    expect(await api.press('confirm', UC)).toEqual({ kind: 'done', email: 'ada@example.com', untilMs: null });
    expect(seen.map((s) => s.url)).toEqual(['https://issuer.example/v1/email/unlock', 'https://issuer.example/v1/email/confirm']);
    for (const s of seen) {
      expect(s.init).toMatchObject({ method: 'POST', credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store' });
      expect(JSON.parse(s.init.body as string)).toHaveProperty('token');
    }
  });

  it('maps the issuer’s codes; a network error or a 5xx is "can’t be reached"; a strange answer is a failure', async () => {
    const cases: [Response | Error, PressAnswer][] = [
      [reply(410, { code: 'link_used', error: 'x' }), { kind: 'used' }],
      [reply(410, { code: 'link_expired', error: 'x' }), { kind: 'expired' }],
      [reply(400, { code: 'link_invalid', error: 'x' }), { kind: 'invalid' }],
      [reply(429, { code: 'rate_limited', error: 'x' }), { kind: 'limited' }],
      [reply(503, { code: 'issuer_unavailable', error: 'x' }), { kind: 'unreachable' }],
      [new Response('<html>', { status: 502 }), { kind: 'unreachable' }],
      [new TypeError('Failed to fetch'), { kind: 'unreachable' }],
      [reply(403, { code: 'origin_not_allowed', error: 'x' }), { kind: 'failed', code: 'origin_not_allowed' }],
      [reply(200, { unlocked: true, email: '<b>x</b>', expiresAtMs: UNTIL }), { kind: 'failed', code: 'bad_response' }],
      [reply(200, { unlocked: true, email: 'ada@example.com' }), { kind: 'failed', code: 'bad_response' }],
    ];
    for (const [r, want] of cases) {
      const f = (async () => {
        if (r instanceof Error) throw r;
        return r;
      }) as unknown as typeof fetch;
      expect(await supportApi(ISSUER, f).press('unlock', UG)).toEqual(want);
    }
    expect(await supportApi(undefined).press('unlock', UG)).toEqual({ kind: 'failed', code: 'email_unavailable' });
  });
});

describe('the unlock kept for /login/email (email-storage.ts)', () => {
  it('kept until it lapses; sent with start while it lasts; dropped after a sign-in with its address only', async () => {
    expect(saveUnlockToken(storage, UG, 'ada@example.com', UNTIL, NOW)).toBe(true);
    expect(liveUnlockToken(storage, NOW)).toBe(UG);
    dropUnlockTokenFor(storage, 'other@example.com');
    expect(liveUnlockToken(storage, NOW)).toBe(UG);
    dropUnlockTokenFor(storage, ' Ada@Example.com ');
    expect(liveUnlockToken(storage, NOW)).toBeNull();
    // Lapsed: dropped when read. More than 24 h ahead, or another form: never stored.
    saveUnlockToken(storage, UG, 'ada@example.com', UNTIL, NOW);
    expect(liveUnlockToken(storage, UNTIL + 1)).toBeNull();
    expect(storage.getItem(UNLOCK_TOKEN_KEY)).toBeNull();
    expect(saveUnlockToken(storage, UG, 'ada@example.com', NOW + 3 * 86_400_000, NOW)).toBe(false);
    expect(saveUnlockToken(storage, UC, 'ada@example.com', UNTIL, NOW)).toBe(false);
    expect(liveUnlockToken(null, NOW)).toBeNull();
  });

  it('emailApi.start carries unlockToken (and a device ticket) only when well formed', async () => {
    const bodies: Record<string, unknown>[] = [];
    const f = (async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(init.body as string) as Record<string, unknown>);
      return new Response(JSON.stringify({ challengeId: 'C'.repeat(43), expiresAtMs: 1, resendAfterMs: 1 }), { status: 202 });
    }) as unknown as typeof fetch;
    const api = emailApi('https://issuer.example', f);
    const c = { scopeId: 's', sessionPublicKey: new Uint8Array(32), expiresAtMs: 1, keyIndex: 0, maxUses: 1, salt: new Uint8Array(16) };
    await api.start('pk', 'a@example.com', c, null, UG);
    await api.start('pk', 'a@example.com', c, null, 'ug1.bad');
    await api.startLink('pk', 'a@example.com', 'link_new', {}, null, UG);
    expect(bodies[0]?.unlockToken).toBe(UG);
    expect(bodies[1]).not.toHaveProperty('unlockToken');
    expect(bodies[2]?.unlockToken).toBe(UG);
  });
});

describe('plain words (D853)', () => {
  it('no word of the support pages is banned, and none says the old name', () => {
    // The module's every sentence is checked with the other sign-in pages' (plain-words.test.ts FILES); here the
    // rendered words, the time-filled one included.
    const all = JSON.stringify(SUPPORT_TEXT) + SUPPORT_TEXT.unlock.next('1 Apr 2027, 10:00');
    expect(jargonIn(all)).toEqual([]);
    expect(all).not.toMatch(/Hana/u);
  });
});
