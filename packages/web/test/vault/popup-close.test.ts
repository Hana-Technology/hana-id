// D347: the vault watches the login popup's window from the hello on. A close while the login waits on the popup ends
// it with `login_cancelled` (`data.reason: 'popup_closed'`) after a short grace; a navigation to Google (and an IdP's
// COOP switch on arrival, which makes the handle read closed) never counts; a window that closes itself after relaying
// never counts; a close while the vault works alone lets the login finish. D398: a `closed` inside the COOP window gives
// the popup 90 s to answer (a window open behind the switch); no answer by then is the close it most likely was.
import { type FollowNotice, decryptRelayValue, encryptRelayPayload, followSlot, isFollowNotice } from '@hana-id/core';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { HanaEnv } from '../../src/hana-env.ts';
import { LOGIN_PENDING_MS, POPUP_WATCH, type PopupWatch } from '../../src/vault/login.ts';
import { Browser, EMAIL_ENV, ENV, type EmailIssuer, FakeWindow, type Google, type LoginRun, RPC_FALLBACK, type Tab, apiError, deliverToken, emailIssuer, enableEmail, google, login, popupHello, readyTab } from './harness.ts';

let g: Google;
let issuer: EmailIssuer;
const tabs: Tab[] = [];
beforeAll(async () => {
  [g, issuer] = await Promise.all([google(), emailIssuer()]);
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function tab(browser = new Browser(), env: HanaEnv = EMAIL_ENV, popupWatch: Partial<PopupWatch> = {}): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk, env, options: { popupWatch } });
  tabs.push(t);
  return t;
}

const signal = (t: Tab, run: LoginRun, stage: 'google' | 'back' | 'relayed') => t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage }, origin: ENV.authOrigin, source: run.popup });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('the default watch', () => {
  it('polls every 250 ms, takes a close within 8 s of leaving for Google as a COOP switch, waits 90 s for an answer after one, and allows 1 s of grace', () => {
    expect(POPUP_WATCH).toEqual({ pollMs: 250, severWindowMs: 8_000, earlyCloseDeadlineMs: 90_000, graceMs: 1_000 });
    expect(Object.isFrozen(POPUP_WATCH)).toBe(true);
    // The deadline ends a login well before its own limit.
    expect(POPUP_WATCH.earlyCloseDeadlineMs + POPUP_WATCH.graceMs).toBeLessThan(LOGIN_PENDING_MS);
  });
});

describe('closing the popup ends the login with login_cancelled (D347)', () => {
  for (const [label, env] of [
    ['an app with email login (the chooser)', 'email'],
    ['a record-only login', 'record'],
    ['batch B’s login (no email issuer)', 'plain'],
  ] as const) {
    it(`${label}: closed before any token, the partner hears login_cancelled with reason popup_closed`, async () => {
      const b = new Browser();
      if (env === 'email') enableEmail(b.backend, issuer);
      const t = await tab(b, env === 'plain' ? ENV : EMAIL_ENV);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      run.popup.closed = true;
      expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
      expect(b.backend.count('/v1/login')).toBe(0);
      // A late answer in the slot (a write the window started) is never read: nothing reaches the chain.
      await deliverToken(t, g, run);
      await pause(40);
      expect(b.backend.relay.get(run.params.relayId as string)).not.toBe('consumed');
      expect(b.backend.count('/v1/login')).toBe(0);
    });
  }

  it('closed on Google’s page (past the COOP window): login_cancelled', async () => {
    const t = await tab(new Browser(), EMAIL_ENV, { severWindowMs: 30 });
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    signal(t, run, 'google');
    await pause(60);
    run.popup.closed = true;
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
  });

  it('back from Google with its opener clears the COOP window: a close right after is login_cancelled', async () => {
    const t = await tab(new Browser(), EMAIL_ENV, { severWindowMs: 60_000 });
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    signal(t, run, 'google');
    signal(t, run, 'back');
    run.popup.closed = true;
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
  });

  it('closed on a follow-up screen (D264’s email consent): login_cancelled', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    b.backend.googleMatch = () => apiError(400, 'google_account_mismatch');
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    const { id } = followSlot(run.params.followKey as Uint8Array, 1);
    b.backend.writeRelayRaw(id, await encryptRelayPayload(run.params.relayKey as Uint8Array, id, { accessToken: 'ya29.x' }));
    const token = await g.token({ iss: 'https://accounts.google.com', azp: run.params.clientId, aud: run.params.clientId, sub: '1234567890', iat: Math.floor(t.browser.timers.now / 1000), exp: Math.floor(t.browser.timers.now / 1000) + 3600, nonce: run.params.nonce, jti: 'j' });
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, access: 'follow' });
    // The screen is up (notice 2): the user closes the window instead of answering.
    const n2 = followSlot(run.params.followKey as Uint8Array, 2);
    const notice: FollowNotice = await decryptRelayValue(run.params.relayKey as Uint8Array, n2.id, await b.backend.takeRelay(n2.id), isFollowNotice);
    expect(notice.t).toBe('email_consent');
    run.popup.closed = true;
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });
});

describe('what never counts as a close', () => {
  it('a navigation to Google whose COOP makes the handle read closed: the login waits, and the token then signs in', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    signal(t, run, 'google');
    run.popup.closed = true;
    await pause(60);
    // Still pending: the watch took it for the browsing context switch and stopped.
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await pause(20);
    expect(settled).toBe(false);
    await deliverToken(t, g, run);
    expect((await pending).error).toBeUndefined();
  });

  it('a window that relayed its answer and closes itself (the callback, the email step)', async () => {
    for (const announced of [true, false]) {
      const t = await tab(new Browser(), ENV);
      const pending = t.request('hana_login');
      const run = await popupHello(t);
      await deliverToken(t, g, run);
      // With the announcement the close is ignored outright; without it the grace lets the written answer win.
      if (announced) signal(t, run, 'relayed');
      run.popup.closed = true;
      expect((await pending).error, String(announced)).toBeUndefined();
    }
  });

  it('a close while the vault works alone (the chain step): the login finishes', async () => {
    const b = new Browser();
    let release: () => void = () => {};
    b.backend.overrides.set('/v1/login', () => new Promise<undefined>((r) => (release = () => r(undefined))));
    const t = await tab(b, ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    await deliverToken(t, g, run);
    await t.waitUntil(() => b.backend.calls.some((c) => c.path === '/v1/login'), '/v1/login');
    run.popup.closed = true;
    await pause(40);
    release();
    expect((await pending).error).toBeUndefined();
  });

  it('a merely slow popup (open, no answer for minutes): pending until its answer, within the 5-minute limit', async () => {
    const t = await tab(new Browser(), ENV);
    let settled = false;
    const pending = t.request('hana_login').finally(() => {
      settled = true;
    });
    const run = await popupHello(t);
    const at = Math.floor(t.browser.timers.now / 1000);
    t.browser.timers.advance(4 * 60_000);
    await pause(60);
    expect(settled).toBe(false);
    await deliverToken(t, g, run, { iat: at, exp: at + 3600 });
    expect((await pending).error).toBeUndefined();
  });

  it('a signal from another window does nothing (the sender is checked)', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    // Another window says "relayed": the vault ignores it, so the real popup's close still cancels.
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'relayed' }, origin: ENV.authOrigin, source: {} });
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'relayed' }, origin: 'https://evil.test', source: run.popup });
    run.popup.closed = true;
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
  });
});

/** The popup leaves for Google and its handle reads closed at once (a COOP switch, or a user's quick close). */
async function closedOnArrival(t: Tab, run: LoginRun): Promise<number> {
  signal(t, run, 'google');
  const at = t.browser.timers.now;
  run.popup.closed = true;
  // The watch's next read (a real tick) arms the deadline.
  await t.waitUntil(() => t.browser.timers.dueAt().includes(at + POPUP_WATCH.earlyCloseDeadlineMs), 'the early-close deadline');
  return at + POPUP_WATCH.earlyCloseDeadlineMs;
}

function settledFlag(p: Promise<unknown>): () => boolean {
  let settled = false;
  void p.finally(() => {
    settled = true;
  });
  return () => settled;
}

describe('a close inside the COOP window: the popup has 90 s to answer (D398)', () => {
  it('no answer: login_cancelled (popup_closed) at the deadline, and a late answer is never read', async () => {
    const b = new Browser();
    const t = await tab(b, ENV);
    const pending = t.request('hana_login');
    const settled = settledFlag(pending);
    const run = await popupHello(t);
    const deadline = await closedOnArrival(t, run);
    // Well past the watch's seconds, and just short of the deadline: still waiting.
    await pause(60);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs - 1_000);
    await pause(40);
    expect(settled()).toBe(false);
    t.browser.timers.advance(1_000);
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
    // Nothing left behind: the deadline and the login's 5-minute limit are both gone.
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
    expect(t.browser.timers.dueAt()).toEqual([]);
    await deliverToken(t, g, run);
    await pause(40);
    expect(b.backend.relay.get(run.params.relayId as string)).not.toBe('consumed');
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('the answer at 60 s (the window was open behind the switch): the login signs in, the deadline cleared', async () => {
    const b = new Browser();
    const t = await tab(b, ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const iat = Math.floor(t.browser.timers.now / 1000);
    const deadline = await closedOnArrival(t, run);
    t.browser.timers.advance(60_000);
    await deliverToken(t, g, run, { iat, exp: iat + 3600 });
    expect((await pending).error).toBeUndefined();
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
    // Past where the deadline was: the wallet stays open.
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    await pause(40);
    expect((await t.request('hana_status')).result).toMatchObject({ status: 'logged_in' });
    expect(b.backend.count('/v1/login')).toBe(1);
  });

  it('an answer in the grace after the deadline still wins (as after any close)', async () => {
    // A grace the test's clock holds (the harness runs short timers on the next real tick).
    const t = await tab(new Browser(), ENV, { graceMs: 10_000 });
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    // Google's clock: the token was issued when the user picked the account.
    const iat = Math.floor(t.browser.timers.now / 1000);
    await closedOnArrival(t, run);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    await deliverToken(t, g, run, { iat, exp: iat + 3600 });
    expect((await pending).error).toBeUndefined();
  });

  it('hana_cancelLogin before the deadline: login_cancelled at once, the deadline cleared', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const deadline = await closedOnArrival(t, run);
    t.browser.timers.advance(30_000);
    expect((await t.request('hana_cancelLogin')).result).toBeNull();
    const reply = await pending;
    expect(reply.error?.code).toBe('login_cancelled');
    expect(reply.error?.data).not.toMatchObject({ reason: 'popup_closed' });
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
  });

  it('a newer login ends the old one and its deadline: the new login is not cancelled at the old deadline', async () => {
    const t = await tab(new Browser(), ENV);
    const first = t.request('hana_login');
    const run1 = await popupHello(t);
    const deadline = await closedOnArrival(t, run1);
    const second = t.request('hana_login');
    expect((await first).error?.code).toBe('login_cancelled');
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
    const run2 = await popupHello(t, new FakeWindow('p2', 'p2', '', t.parent));
    const iat = Math.floor(t.browser.timers.now / 1000);
    const settled = settledFlag(second);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs + POPUP_WATCH.graceMs);
    await pause(40);
    expect(settled()).toBe(false);
    await deliverToken(t, g, run2, { iat, exp: iat + 3600 });
    expect((await second).error).toBeUndefined();
  });

  it('a close late in the login: the 5-minute limit comes first (login_timeout), and the deadline goes with it', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    t.browser.timers.advance(4 * 60_000);
    const deadline = await closedOnArrival(t, run);
    t.browser.timers.advance(60_000);
    expect((await pending).error).toMatchObject({ code: 'login_timeout', data: { stage: 'pending' } });
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
  });

  it('a close early in the login: the deadline comes long before the 5-minute limit, which goes with the login', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    const deadline = await closedOnArrival(t, run);
    expect(t.browser.timers.dueAt().at(-1)).toBeGreaterThan(deadline);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
    expect(t.browser.timers.dueAt()).toEqual([]);
  });

  it('a later trip to Google (token_first’s second trip, D273’s retry): the same deadline', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const run = await popupHello(t);
    // The first trip came back with its opener; the callback sends the popup to Google again.
    signal(t, run, 'google');
    signal(t, run, 'back');
    await closedOnArrival(t, run);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
  });

  it('a follow-up screen whose “Google again” closes at once: login_cancelled at the deadline', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    b.backend.googleMatch = () => apiError(400, 'google_account_mismatch');
    const t = await tab(b);
    const pending = t.request('hana_login', { method: 'google' });
    const run = await popupHello(t);
    const { id } = followSlot(run.params.followKey as Uint8Array, 1);
    b.backend.writeRelayRaw(id, await encryptRelayPayload(run.params.relayKey as Uint8Array, id, { accessToken: 'ya29.x' }));
    const token = await g.token({ iss: 'https://accounts.google.com', azp: run.params.clientId, aud: run.params.clientId, sub: '1234567890', iat: Math.floor(t.browser.timers.now / 1000), exp: Math.floor(t.browser.timers.now / 1000) + 3600, nonce: run.params.nonce, jti: 'j' });
    await b.backend.writeRelay(run.params.relayId as string, run.params.relayKey as Uint8Array, { idToken: token, access: 'follow' });
    const n2 = followSlot(run.params.followKey as Uint8Array, 2);
    const notice: FollowNotice = await decryptRelayValue(run.params.relayKey as Uint8Array, n2.id, await b.backend.takeRelay(n2.id), isFollowNotice);
    expect(notice.t).toBe('email_consent');
    await closedOnArrival(t, run);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
    expect(b.backend.count('/v1/login')).toBe(0);
  });

  it('a link task (hana_linkAccount) closed on arrival at Google: login_cancelled at the deadline', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    const t = await tab(b, { ...EMAIL_ENV, rpcFallback: RPC_FALLBACK });
    await login(t, g);
    const pending = t.request('hana_linkAccount', { method: 'email' });
    const settled = settledFlag(pending);
    const run = await popupHello(t);
    const deadline = await closedOnArrival(t, run);
    await pause(60);
    expect(settled()).toBe(false);
    t.browser.timers.advance(POPUP_WATCH.earlyCloseDeadlineMs);
    expect((await pending).error).toMatchObject({ code: 'login_cancelled', data: { reason: 'popup_closed' } });
    expect(t.browser.timers.dueAt()).not.toContain(deadline);
  });
});

describe('the vault acks each signal it takes (D400)', () => {
  const acks = (run: LoginRun) => run.popup.posted.filter((p) => p.message.t === 'hana:auth-progress-ack').map((p) => [p.message, p.targetOrigin]);

  it('to the popup it answered, with authOrigin as the target: `google`, `back`, `email_code`, `relayed`, each time', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    const t = await tab(b);
    void t.request('hana_login');
    const run = await popupHello(t);
    for (const stage of ['google', 'back', 'google', 'email_code', 'relayed'] as const) t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage }, origin: ENV.authOrigin, source: run.popup });
    expect(acks(run)).toEqual(['google', 'back', 'google', 'email_code', 'relayed'].map((stage) => [{ v: 1, t: 'hana:auth-progress-ack', stage }, ENV.authOrigin]));
  });

  it('never for a signal it doesn’t take: another window, another origin, before the hello, after the login ended', async () => {
    const t = await tab(new Browser(), ENV);
    const pending = t.request('hana_login');
    const other = new FakeWindow(`${ENV.authOrigin}/login`);
    // Before the hello was answered.
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'google' }, origin: ENV.authOrigin, source: other });
    const run = await popupHello(t);
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'google' }, origin: ENV.authOrigin, source: other });
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'google' }, origin: 'https://evil.test', source: run.popup });
    // Chromium's null source on a message posted just before a navigation: nothing to ack, nothing taken.
    t.dispatch({ data: { v: 1, t: 'hana:auth-progress', stage: 'google' }, origin: ENV.authOrigin, source: null });
    expect(other.posted.filter((p) => p.message.t === 'hana:auth-progress-ack')).toEqual([]);
    expect(acks(run)).toEqual([]);
    expect((await t.request('hana_cancelLogin')).result).toBeNull();
    expect((await pending).error).toMatchObject({ code: 'login_cancelled' });
    signal(t, run, 'relayed');
    expect(acks(run)).toEqual([]);
  });

  it('a link task’s popup too', async () => {
    const b = new Browser();
    enableEmail(b.backend, issuer);
    const t = await tab(b, { ...EMAIL_ENV, rpcFallback: RPC_FALLBACK });
    await login(t, g);
    void t.request('hana_linkAccount', { method: 'email' });
    const run = await popupHello(t);
    signal(t, run, 'google');
    expect(acks(run)).toEqual([[{ v: 1, t: 'hana:auth-progress-ack', stage: 'google' }, ENV.authOrigin]]);
  });

  it('a popup that can’t be posted to any more is no error: the signal still counts', async () => {
    const t = await tab(new Browser(), EMAIL_ENV, { severWindowMs: 60_000, pollMs: 10, graceMs: 20 });
    const pending = t.request('hana_login');
    const settled = settledFlag(pending);
    const run = await popupHello(t);
    run.popup.postMessage = () => {
      throw new DOMException('gone');
    };
    signal(t, run, 'google');
    // Taken: a close right after is the COOP window's, not a plain close.
    run.popup.closed = true;
    await pause(200);
    expect(settled()).toBe(false);
    expect((await t.request('hana_cancelLogin')).result).toBeNull();
  });
});

describe('after the cancel', () => {
  it('a newer login works; the watch of the old one is over', async () => {
    const b = new Browser();
    const t = await tab(b, ENV);
    const first = t.request('hana_login');
    const run1 = await popupHello(t);
    run1.popup.closed = true;
    expect((await first).error?.code).toBe('login_cancelled');
    const second = t.request('hana_login');
    const run2 = await popupHello(t, new FakeWindow('p2', 'p2', '', t.parent));
    await deliverToken(t, g, run2);
    expect((await second).error).toBeUndefined();
    expect(b.backend.count('/v1/login')).toBe(1);
  });
});
