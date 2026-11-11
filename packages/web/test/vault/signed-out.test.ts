// D695: a session that ends because its share was revoked tells the partner page so: `disconnectReason {signed_out}`
// just before its `disconnect`, and the requests it refuses carry `data.reason: 'signed_out'` (code still 4900). Every
// other end (this tab's logout, another tab's logout, a share that expired or that the API doesn't know, an identity
// mint refused for any other reason) says nothing more, so a page never tells the user "signed out" on a guess. The
// share check's own paths (the minute's read, the check before a signature or a cached identity token) are in
// share-check.test.ts; the stale tab's touch in persistence.test.ts.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { TOUCH_EVERY_MS } from '../../src/vault/vault.ts';
import { APP_ID, Browser, type Google, type Tab, answer, apiError, disconnectedWith, google, login, openApproval, readyTab, shareBroadcasts, sleepReal, waitLauncher } from './harness.ts';

let g: Google;
const tabs: Tab[] = [];
beforeAll(async () => {
  g = await google();
});
afterEach(() => {
  for (const t of tabs.splice(0)) {
    t.close();
    t.browser.timers.dispose();
  }
});

async function tab(browser: Browser): Promise<Tab> {
  const t = await readyTab(browser, { googleJwk: g.jwk });
  tabs.push(t);
  return t;
}

/** Two tabs of the app in one browser on one session (the second unlocked it from the record). */
async function twoTabs(): Promise<{ browser: Browser; a: Tab; b: Tab; shareId: Uint8Array }> {
  const browser = new Browser();
  browser.backend.serverNow = () => browser.timers.now;
  const a = await tab(browser);
  await login(a, g);
  await until(() => shareOf(a) !== undefined, 'the share made');
  const b = await tab(browser);
  expect(((await b.ready()) as { status: string }).status).toBe('logged_in');
  return { browser, a, b, shareId: Uint8Array.from(shareOf(a)!) };
}

const shareOf = (t: Tab): Uint8Array | undefined => (t.vault as unknown as { session: { share: { shareId: Uint8Array } | null } | null }).session?.share?.shareId;
const statusOf = async (t: Tab): Promise<string> => ((await t.request('hana_status')).result as { status: string }).status;
const backendShare = (browser: Browser, shareId: Uint8Array) => [...browser.backend.shares.values()].find((s) => s.shareId.every((v, i) => v === shareId[i]))!;

async function until(cond: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (await cond()) return;
    await sleepReal(5);
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** A stellar_signMessage left waiting in the approval popup; returns its (pending) reply. */
async function waitingSign(t: Tab): Promise<{ reply: ReturnType<Tab['request']> }> {
  const reply = t.request('stellar_signMessage', { message: 'waiting' });
  await waitLauncher(t, 'Review in Hana');
  const popup = openApproval(t);
  await popup.next('hana:approve-request');
  return { reply };
}

/** Sends `messages` on the app's channel as another tab would (one of an older build sends `revoked` alone). */
function fromAnotherTab(browser: Browser, messages: unknown[]): void {
  const c = browser.bus.channel(`hana-vault:${APP_ID}`);
  for (const m of messages) c.postMessage(m);
  c.close();
}

describe('D695: a session Hana signed out says so', () => {
  it('a touch’s 410 share_revoked: signed out here, and the other tabs are told so', async () => {
    const { browser, a, b, shareId } = await twoTabs();
    backendShare(browser, shareId).revoked = true;
    // The status reads still say live (one sent just before the revoke), so the touch after the signature learns it.
    browser.backend.shareAnswer = () => 'live';
    browser.timers.advance(TOUCH_EVERY_MS);
    const reply = a.request('stellar_signMessage', { message: 'hello' });
    await waitLauncher(a, 'Review in Hana');
    const popup = openApproval(a);
    answer(a, popup, await popup.next('hana:approve-request'), true);
    expect((await reply).error).toBeUndefined();
    await a.waitEvent('disconnect');
    expect(disconnectedWith(a)).toEqual(['signed_out']);
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual(['signed_out']);
    expect(shareBroadcasts(browser, shareId)).toEqual(['signedOut', 'revoked']);
    expect(await statusOf(b)).toBe('logged_out');
  });

  it('another tab’s signedOut ends this one signed out and refuses its open request with the reason', async () => {
    const { browser, b, shareId } = await twoTabs();
    const { reply } = await waitingSign(b);
    fromAnotherTab(browser, [
      { v: 1, t: 'signedOut', shareId },
      { v: 1, t: 'revoked', shareId },
    ]);
    expect((await reply).error).toEqual({ code: 4900, message: 'This session was signed out', data: { reason: 'signed_out' } });
    await b.waitEvent('disconnect');
    // One disconnect: the `revoked` after it finds nothing left to end.
    await sleepReal(20);
    expect(disconnectedWith(b)).toEqual(['signed_out']);
    expect(await statusOf(b)).toBe('logged_out');
  });

  it('a newer sign-in in another tab signs this tab out', async () => {
    const { browser, a, b, shareId } = await twoTabs();
    await login(b, g, { sub: '220000000000000000001' });
    await until(async () => (await statusOf(a)) === 'logged_out', 'A to drop the replaced session');
    expect(disconnectedWith(a)).toEqual(['signed_out']);
    expect(shareBroadcasts(browser, shareId)).toEqual(['signedOut', 'revoked']);
    // B is on its new session, untouched.
    expect(await statusOf(b)).toBe('logged_in');
    expect(b.events.some((e) => e.event === 'disconnect')).toBe(false);
  });

  it('a tab loaded after the sign-out: its unlock’s 410 share_revoked tells the open tabs they were signed out', async () => {
    const browser = new Browser();
    const a = await tab(browser);
    await login(a, g);
    await until(() => shareOf(a) !== undefined, 'the share made');
    const shareId = Uint8Array.from(shareOf(a)!);
    backendShare(browser, shareId).revoked = true;
    const c = await tab(browser);
    expect(((await c.ready()) as { status: string }).status).toBe('logged_out');
    await a.waitEvent('disconnect');
    expect(disconnectedWith(a)).toEqual(['signed_out']);
    expect(shareBroadcasts(browser, shareId)).toEqual(['signedOut', 'revoked']);
  });

  it('an identity mint refused for a revoked share: session_ended with signed_out; this tab still gets sessionExpired; the others are told signed out', async () => {
    const { browser, a, b, shareId } = await twoTabs();
    browser.backend.overrides.set('/v1/identity/token', () => apiError(410, 'session_ended', { reason: 'share_revoked' }));
    expect((await a.request('hana_identityToken')).error).toEqual({ code: 'session_ended', message: 'The Hana session has ended', data: { reason: 'signed_out' } });
    expect(await a.waitEvent('sessionExpired')).toBeNull();
    expect(disconnectedWith(a)).toEqual([]);
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual(['signed_out']);
    expect(shareBroadcasts(browser, shareId)).toEqual(['signedOut', 'revoked']);
  });

  it('an export waiting for its window fails 4900 signed_out when the device is signed out', async () => {
    const { browser, b, shareId } = await twoTabs();
    const reply = b.request('hana_export', { chain: 'evm' });
    await waitLauncher(b, 'Export key in Hana');
    b.launcher.click();
    fromAnotherTab(browser, [
      { v: 1, t: 'signedOut', shareId },
      { v: 1, t: 'revoked', shareId },
    ]);
    expect((await reply).error).toMatchObject({ code: 4900, data: { reason: 'signed_out' } });
  });
});

describe('D695: a session that ended any other way says nothing more', () => {
  it.each([
    ['410 share_expired', () => apiError(410, 'share_expired')],
    ['404 unknown_share', () => apiError(404, 'unknown_share')],
  ] as const)('a touch’s %s: the session ends with no reason, and the other tabs get revoked alone', async (_name, refusal) => {
    const { browser, a, b, shareId } = await twoTabs();
    browser.backend.overrides.set('/v1/vault/touch', refusal);
    browser.timers.advance(TOUCH_EVERY_MS);
    const reply = a.request('stellar_signMessage', { message: 'hello' });
    await waitLauncher(a, 'Review in Hana');
    const popup = openApproval(a);
    answer(a, popup, await popup.next('hana:approve-request'), true);
    expect((await reply).error).toBeUndefined();
    await a.waitEvent('disconnect');
    expect(disconnectedWith(a)).toEqual([null]);
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual([null]);
    expect(shareBroadcasts(browser, shareId)).toEqual(['revoked']);
  });

  it('another tab of an older build sends revoked alone: this tab ends as before, with no reason on the event or the request', async () => {
    const { browser, b, shareId } = await twoTabs();
    const { reply } = await waitingSign(b);
    fromAnotherTab(browser, [{ v: 1, t: 'revoked', shareId }]);
    expect((await reply).error).toEqual({ code: 4900, message: 'The vault is disconnected' });
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual([null]);
  });

  it('a logout here: no disconnect, and an open request is refused with no reason; the other tabs disconnect with no reason', async () => {
    const { a, b } = await twoTabs();
    const { reply } = await waitingSign(a);
    expect((await a.request('hana_logout')).result).toBeNull();
    expect((await reply).error).toEqual({ code: 4900, message: 'The vault is disconnected' });
    expect(a.events.some((e) => e.event === 'disconnect' || e.event === 'disconnectReason')).toBe(false);
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual([null]);
  });

  it('an identity mint refused for any other reason (no_session): session_ended with no reason, the other tabs get revoked alone', async () => {
    const { browser, a, b, shareId } = await twoTabs();
    browser.backend.overrides.set('/v1/identity/token', () => apiError(410, 'session_ended', { reason: 'no_session' }));
    expect((await a.request('hana_identityToken')).error).toEqual({ code: 'session_ended', message: 'The Hana session has ended' });
    await b.waitEvent('disconnect');
    expect(disconnectedWith(b)).toEqual([null]);
    expect(shareBroadcasts(browser, shareId)).toEqual(['revoked']);
  });

  it('a tab loaded after the share expired: its unlock’s 410 share_expired tells the open tabs revoked alone', async () => {
    const browser = new Browser();
    const a = await tab(browser);
    await login(a, g);
    await until(() => shareOf(a) !== undefined, 'the share made');
    const shareId = Uint8Array.from(shareOf(a)!);
    browser.backend.overrides.set('/v1/vault/unlock', () => apiError(410, 'share_expired'));
    const c = await tab(browser);
    expect(((await c.ready()) as { status: string }).status).toBe('logged_out');
    await a.waitEvent('disconnect');
    expect(disconnectedWith(a)).toEqual([null]);
    expect(shareBroadcasts(browser, shareId)).toEqual(['revoked']);
  });
});
