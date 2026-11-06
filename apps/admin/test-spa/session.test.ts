// The Access sign-in's end (apps/admin/README.md "UI principles", "Sign-in expiry"): an `/api/*` request redirected
// to Access's login (seen as an `opaqueredirect`, `redirect: 'manual'`) or answered 401 is "your sign-in has expired",
// never "can't reach the console"; the request waits, the form keeps every value, "Try again" sends exactly the same
// request again and nothing claims success before it is answered. GET /api/me's `accessExp` drives a warning 5 minutes
// before the end, with Renew, and the expired banner at the end. A real network failure keeps its own wording.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(async () => {
  vi.useRealTimers();
  await closeWindow();
});

const ORGS = [{ id: 'org_lumen', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: Date.UTC(2026, 9, 1) }];
const meWith = (accessExp?: number) => ({ body: { email: 'staff@hana.example', env: 'sandbox-dev', ...(accessExp !== undefined ? { accessExp } : {}) } });

/** The organisations page; each invite is answered by `invite` (in order of calls). */
function orgsApi(invite: (c: Call, n: number) => Answer) {
  let n = 0;
  return (c: Call): Answer => {
    if (c.method === 'GET' && c.path === '/api/orgs') return { body: { orgs: ORGS } };
    if (c.method === 'POST' && c.path === '/api/invites') return invite(c, (n += 1));
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}

const banner = (s: ReturnType<typeof boot>) => s.doc.getElementById('session')!;
const bannerButton = (s: ReturnType<typeof boot>, label: string) => [...banner(s).querySelectorAll('a, button')].find((b) => b.textContent === label) as unknown as HTMLElement | undefined;
const invites = (s: ReturnType<typeof boot>) => s.api().filter((c) => c.path === '/api/invites');

async function fillInvite(s: ReturnType<typeof boot>) {
  await vi.waitFor(() => expect(s.button('Invite a new partner')).toBeTruthy());
  s.button('Invite a new partner').click();
  s.field('newOrgName').value = 'Tidepool';
  s.field('email').value = 'owner@tidepool.example';
  (s.field('kind') as unknown as HTMLSelectElement).value = 'internal';
}

describe('an Access redirect is an expired sign-in, not a network error', () => {
  it('sends every /api/* request with redirect: manual', async () => {
    const s = boot('/orgs', orgsApi(() => ({ body: {} })));
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    expect(s.calls.length).toBeGreaterThan(0);
    for (const c of s.calls) expect(c.redirect, c.path).toBe('manual');
  });

  it('Send invite redirected to Access: the expired banner, the form untouched, nothing sent and no success claimed', async () => {
    const s = boot('/orgs', orgsApi(() => ({ redirect: true })));
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(banner(s).querySelector('[role=alert]')).toBeTruthy());
    const alert = banner(s).querySelector('[role=alert]')!;
    expect(alert.textContent).toContain('Your sign-in has expired');
    expect(alert.textContent).toContain('Nothing was sent, and everything you typed is still here.');
    // "Sign in again" opens the console in a new tab (Access signs in there; the cookie is shared); "Try again" is here.
    const signIn = bannerButton(s, 'Sign in again') as unknown as HTMLAnchorElement;
    expect(signIn.tagName).toBe('A');
    expect(signIn.getAttribute('href')).toBe('/signed-in');
    expect(signIn.getAttribute('target')).toBe('_blank');
    expect(signIn.getAttribute('rel')).toBe('noopener');
    expect(bannerButton(s, 'Try again')).toBeTruthy();
    // Not the network wording, no success line, and every typed value still in its field.
    expect(s.doc.body.textContent).not.toContain('Can’t reach the admin console');
    expect(s.text()).not.toContain('Invite sent');
    expect(s.field('newOrgName').value).toBe('Tidepool');
    expect(s.field('email').value).toBe('owner@tidepool.example');
    expect(s.field('kind').value).toBe('internal');
    expect(invites(s)).toHaveLength(1);
    expect(s.dialogs).toEqual([]);
  });

  it('Try again sends exactly the request that failed; on success the banner goes and the page says what happened', async () => {
    const s = boot('/orgs', orgsApi((_c, n) => (n === 1 ? { redirect: true } : { body: { ok: true } })));
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(bannerButton(s, 'Try again')).toBeTruthy());
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Invite sent to owner@tidepool.example for the new organisation “Tidepool”'));
    const [first, second] = invites(s);
    expect(second).toEqual(first);
    expect(second!.raw).toBe(first!.raw);
    expect(second!.body).toEqual({ email: 'owner@tidepool.example', role: 'owner', newOrgName: 'Tidepool', kind: 'internal' });
    expect(second!.headers).toEqual(expect.objectContaining({ 'x-hana-admin': '1', 'content-type': 'application/json' }));
    expect(invites(s)).toHaveLength(2);
    await vi.waitFor(() => expect(banner(s).textContent).toBe(''));
  });

  it('a Try again before signing in keeps everything and says it is still signed out', async () => {
    const s = boot('/orgs', orgsApi((_c, n) => (n <= 2 ? { redirect: true } : { body: { ok: true } })));
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(bannerButton(s, 'Try again')).toBeTruthy());
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Still signed out: finish signing in in the other tab'));
    expect(invites(s)).toHaveLength(2);
    expect(s.field('email').value).toBe('owner@tidepool.example');
    expect(s.text()).not.toContain('Invite sent');
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Invite sent to owner@tidepool.example'));
    expect(invites(s)).toHaveLength(3);
    expect(new Set(invites(s).map((c) => c.raw)).size).toBe(1);
  });

  it('back on this tab after signing in elsewhere: "You’re signed in again", and still nothing sent until Try again', async () => {
    let signedOut = false;
    const s = boot('/orgs', orgsApi(() => (signedOut ? { redirect: true } : { body: { ok: true } })), { me: () => (signedOut ? { redirect: true } : meWith()) });
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    signedOut = true;
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in has expired'));
    signedOut = false;
    s.w.dispatchEvent(new s.w.Event('focus'));
    await vi.waitFor(() => expect(banner(s).textContent).toContain('You’re signed in again'));
    expect(banner(s).querySelector('[role=status]')).toBeTruthy();
    expect(invites(s)).toHaveLength(1);
    expect(s.text()).not.toContain('Invite sent');
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Invite sent to owner@tidepool.example'));
    expect(invites(s)).toHaveLength(2);
    expect(banner(s).textContent).toBe('');
  });

  it('the Worker’s own 401 (an Access token it finds expired) is the same expired banner', async () => {
    const s = boot('/orgs', orgsApi(() => ({ status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in through Cloudflare Access' } } })));
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in has expired'));
    expect(s.doc.body.textContent).not.toContain('Error code');
  });

  it('a page load redirected to Access waits too, and loads on Try again', async () => {
    let redirect = true;
    const s = boot('/orgs', (c) => (redirect ? { redirect: true } : c.path === '/api/orgs' ? { body: { orgs: ORGS } } : { status: 404, body: {} }));
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in has expired'));
    redirect = false;
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    expect(banner(s).textContent).toBe('');
  });

  it('leaving the page drops what was waiting there: it is never sent later', async () => {
    let n = 0;
    const s = boot('/orgs', (c) => {
      if (c.method === 'POST') return (n += 1) === 1 ? { redirect: true } : { body: { ok: true } };
      if (c.path === '/api/orgs') return { body: { orgs: ORGS } };
      return { body: { orgs: [], entries: [], next: null, changes: [], rows: [] } };
    });
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(bannerButton(s, 'Try again')).toBeTruthy());
    (s.doc.querySelector('a[href="/audit"]') as unknown as HTMLElement).click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/audit'));
    bannerButton(s, 'Try again')!.click();
    await vi.waitFor(() => expect(banner(s).textContent).toBe(''));
    expect(invites(s)).toHaveLength(1);
  });

  it('a genuine network failure keeps its own wording, and no sign-in banner', async () => {
    const s = boot('/orgs', orgsApi(() => ({ network: true })));
    await fillInvite(s);
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Can’t reach the admin console'));
    expect(s.text()).toContain('Check your connection and try again. If your Access session expired, reload the page to sign in again.');
    expect(s.main().querySelector('.code')!.textContent).toBe('Error code network');
    expect(banner(s).textContent).toBe('');
    expect(s.field('email').value).toBe('owner@tidepool.example');
  });
});

describe('the warning before the sign-in ends (GET /api/me accessExp)', () => {
  const T = Date.UTC(2026, 10, 6, 9, 0, 0);

  it('nothing until 5 minutes before; then "ends in N min" with Renew; at exp the expired banner', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T);
    const exp = T / 1000 + 20 * 60;
    let ended = false;
    const s = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => (ended ? { redirect: true } : meWith(exp)) });
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    expect(banner(s).textContent).toBe('');
    vi.setSystemTime(T + 15 * 60_000 + 30_000);
    vi.advanceTimersByTime(15_000);
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in ends in 5 min'));
    const box = banner(s).querySelector('.session-banner')!;
    expect(box.getAttribute('role')).toBe('status');
    expect(box.textContent).toContain('At 2026-11-06 09:20 UTC.');
    const renew = bannerButton(s, 'Renew') as unknown as HTMLAnchorElement;
    // Without renewUrl (an older Worker) Renew falls back to /signed-in.
    expect([renew.tagName, renew.getAttribute('href'), renew.getAttribute('target')]).toEqual(['A', '/signed-in', '_blank']);
    vi.setSystemTime(T + 18 * 60_000 + 10_000);
    vi.advanceTimersByTime(15_000);
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in ends in 2 min'));
    // At exp the Worker is asked (this clock may be off); Access redirects: the expired banner, not the warning.
    ended = true;
    vi.setSystemTime(T + 20 * 60_000 + 1000);
    vi.advanceTimersByTime(15_000);
    await vi.waitFor(() => expect(banner(s).querySelector('[role=alert]')?.textContent).toContain('Your sign-in has expired'));
    expect(banner(s).textContent).not.toContain('ends in');
  });

  it('Renew opens the sign-in tab, then re-reads exp when this tab is back: a new exp clears the warning', async () => {
    const now = Math.floor(Date.now() / 1000);
    let exp = now + 4 * 60;
    const s = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => meWith(exp) });
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in ends in 4 min'));
    const meCalls = () => s.calls.filter((c) => c.path === '/api/me').length;
    const before = meCalls();
    bannerButton(s, 'Renew')!.click();
    exp = now + 3600;
    s.w.dispatchEvent(new s.w.Event('focus'));
    await vi.waitFor(() => expect(banner(s).textContent).toBe(''));
    expect(meCalls()).toBe(before + 1);
  });

  it('a Renew that Access didn’t extend says so plainly (Access renews a sign-in only once it has ended)', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3 * 60;
    const s = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => meWith(exp) });
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in ends in 3 min'));
    bannerButton(s, 'Renew')!.click();
    s.w.dispatchEvent(new s.w.Event('focus'));
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Cloudflare Access kept your current sign-in'));
    expect(banner(s).textContent).toContain('nothing you typed is lost');
  });

  it('without accessExp (an older Worker) there is no warning and no timer', async () => {
    const s = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => meWith() });
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    expect(banner(s).textContent).toBe('');
  });

  it('the sign-in tab’s page says to go back and press Try again', async () => {
    const s = boot('/signed-in', () => ({ body: {} }));
    await vi.waitFor(() => expect(s.text()).toContain('You’re signed in'));
    expect(s.text()).toContain('Go back to the tab you were working in and press Try again there');
  });
});

describe('Renew through the Access team login (GET /api/me renewUrl)', () => {
  it('points Renew at renewUrl when the Worker gives one, and ignores a URL that is not an Access login', async () => {
    const T = Date.UTC(2026, 10, 6, 9, 0, 0);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T);
    const exp = T / 1000 + 4 * 60;
    const url = 'https://team.cloudflareaccess.com/cdn-cgi/access/login/admin.example?kid=' + 'e'.repeat(64) + '&redirect_url=%2Fsigned-in';
    const s = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => ({ body: { ...meWith(exp).body, renewUrl: url } }) });
    await vi.waitFor(() => expect(banner(s).textContent).toContain('Your sign-in ends in'));
    expect((bannerButton(s, 'Renew') as unknown as HTMLAnchorElement).getAttribute('href')).toBe(url);
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(T);
    const evil = boot('/orgs', orgsApi(() => ({ body: {} })), { me: () => ({ body: { ...meWith(exp).body, renewUrl: 'https://evil.example/login' } }) });
    await vi.waitFor(() => expect(banner(evil).textContent).toContain('Your sign-in ends in'));
    expect((bannerButton(evil, 'Renew') as unknown as HTMLAnchorElement).getAttribute('href')).toBe('/signed-in');
  });
});
