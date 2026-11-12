// The console session's end mid-task (apps/console/README.md "UI principles", "When the session ends"): a 401 after
// this page has had a session is "Your session has ended", not an error under the button and not a jump to /signin;
// the request waits, what was typed stays, "Sign in again" opens sign-in in a new tab and "Try again" sends exactly
// the same request. GET /api/me's `sessionExpiresAt` (the 12 h absolute end) drives a warning 5 minutes before. A
// visitor who never had a session still goes to /signin; a real network failure keeps its own words.
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';

type Answer = { status?: number; body?: unknown; network?: true };
let routes: Record<string, Answer | ((init?: RequestInit) => Answer)>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  resetSession();
  routes = {};
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, '');
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes[url];
    const a = typeof r === 'function' ? r(init) : (r ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
    if (a.network) throw new TypeError('Failed to fetch');
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function at(url: string) {
  window.history.replaceState(null, '', url);
  return render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

const ENDED = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in again' } } };
const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const MEMBERS = { members: [{ userId: 'usr_a', email: 'me@partner.example', role: 'owner', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: false }], invites: [], grants: [] };
function signedIn(me: Record<string, unknown> = ME) {
  routes['/api/me'] = { body: me };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
  routes['/api/orgs/org_a/members'] = { body: MEMBERS };
}
/** The invite form's own submit (the page has another "Review and confirm" form, the Workspace domain). */
const submitInvite = () => fireEvent.click(within(screen.getByPlaceholderText('name@company.com').closest('form')!).getByRole('button', { name: 'Review and confirm with Google' }));
const posts = (url: string) => calls.filter((c) => c.url === url && c.init?.method === 'POST');
const banner = () => document.querySelector('.session-banner');

async function typeInvite() {
  at('/orgs/org_a/members');
  const input = await screen.findByPlaceholderText('name@company.com');
  fireEvent.change(input, { target: { value: 'new@partner.example' } });
  fireEvent.click(within(input.closest('form')!).getByRole('radio', { name: /^Owner/u }));
  return input as HTMLInputElement;
}

describe('the session ends mid-task', () => {
  it('a write answered 401: "Your session has ended", the page and its input stay, nothing sent or claimed', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = ENDED;
    const input = await typeInvite();
    submitInvite();
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Your session has ended');
    expect(alert.textContent).toContain('Nothing was sent, and what you typed is still here.');
    expect(window.location.pathname).toBe('/orgs/org_a/members');
    expect(input.value).toBe('new@partner.example');
    expect((within(input.closest('form')!).getByRole('radio', { name: /^Owner/u }) as HTMLInputElement).checked).toBe(true);
    const link = screen.getByRole('link', { name: 'Sign in again' });
    expect([link.getAttribute('href'), link.getAttribute('target'), link.getAttribute('rel')]).toEqual(['/signin', '_blank', 'noopener']);
    expect(document.body.textContent).not.toContain('couldn’t be reached');
    expect(posts('/api/orgs/org_a/actions')).toHaveLength(1);
  });

  it('Try again sends exactly the same request; its success carries on as usual and the banner goes', async () => {
    signedIn();
    let n = 0;
    routes['/api/orgs/org_a/actions'] = () => ((n += 1) === 1 ? ENDED : { body: { id: 'act_inv', kind: 'member.invite', decoded: {}, expiresAt: Date.now() + 300_000 } });
    await typeInvite();
    submitInvite();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_inv'));
    const [first, second] = posts('/api/orgs/org_a/actions');
    expect(second!.init!.body).toBe(first!.init!.body);
    expect(JSON.parse(String(second!.init!.body))).toEqual({ kind: 'member.invite', params: { email: 'new@partner.example', role: 'owner' }, returnTo: { page: 'members' } });
    expect(new Headers(second!.init!.headers).get('x-hana-console')).toBe('1');
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('a Try again before signing in says so, keeps waiting, and sends nothing new', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = ENDED;
    const input = await typeInvite();
    submitInvite();
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(banner()!.textContent).toContain('Still signed out: finish signing in in the other tab'));
    expect(posts('/api/orgs/org_a/actions')).toHaveLength(2);
    expect(input.value).toBe('new@partner.example');
  });

  it('back on this tab after signing in elsewhere: "You’re signed in again"; Try again sends what waited', async () => {
    signedIn();
    let ended = true;
    routes['/api/orgs/org_a/actions'] = () => (ended ? ENDED : { body: { id: 'act_inv', kind: 'member.invite', decoded: {}, expiresAt: Date.now() + 300_000 } });
    await typeInvite();
    submitInvite();
    await screen.findByRole('alert');
    ended = false;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(banner()!.textContent).toContain('You’re signed in again'));
    expect(banner()!.getAttribute('role')).toBe('status');
    expect(posts('/api/orgs/org_a/actions')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_inv'));
  });

  it('a page whose read is answered 401 waits under the banner instead of jumping to /signin', async () => {
    signedIn();
    at('/orgs/org_a');
    await screen.findByText('Acme');
    // The session ends: every request answers 401.
    for (const k of ['/api/me', '/api/orgs/org_a', '/api/orgs/org_a/members']) routes[k] = ENDED;
    fireEvent.click(screen.getByRole('link', { name: 'Members' }));
    expect((await screen.findByRole('alert')).textContent).toContain('Your session has ended');
    expect(window.location.pathname).toBe('/orgs/org_a/members');
    signedIn();
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByPlaceholderText('name@company.com')).toBeTruthy();
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('a visitor who never had a session still goes to sign-in', async () => {
    routes['/api/me'] = ENDED;
    at('/');
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    expect(window.location.pathname).toBe('/signin');
  });

  it('a real network failure keeps its own words, and no session banner', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { network: true };
    await typeInvite();
    submitInvite();
    expect((await screen.findByRole('alert')).textContent).toContain('The console couldn’t be reached. Check your connection, then try again.');
    expect(banner()).toBeNull();
  });
});

describe('the warning before the 12 h absolute end (GET /api/me sessionExpiresAt)', () => {
  it('nothing until 5 minutes before; then "ends in N min" with Sign in again; at the end, the ended banner', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    const T = Date.UTC(2026, 10, 6, 9, 0, 0);
    vi.setSystemTime(T);
    signedIn({ ...ME, sessionExpiresAt: T + 20 * 60_000 });
    at('/orgs/org_a/members');
    await screen.findByPlaceholderText('name@company.com');
    expect(banner()).toBeNull();
    await act(async () => {
      vi.setSystemTime(T + 15 * 60_000 + 30_000);
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(banner()!.textContent).toContain('Your session ends in 4 min'));
    expect(banner()!.getAttribute('role')).toBe('status');
    expect(banner()!.textContent).toContain('12 hours after you signed in');
    expect(screen.getByRole('link', { name: 'Sign in again' }).getAttribute('target')).toBe('_blank');
    routes['/api/me'] = ENDED;
    await act(async () => {
      vi.setSystemTime(T + 20 * 60_000 + 1000);
      vi.advanceTimersByTime(15_000);
    });
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Your session has ended'));
    expect(screen.getByPlaceholderText('name@company.com')).toBeTruthy();
  });

  it('a new sign-in in another tab: back here, the new end is read and the warning goes', async () => {
    signedIn({ ...ME, sessionExpiresAt: Date.now() + 3 * 60_000 + 30_000 });
    at('/orgs/org_a/members');
    await waitFor(() => expect(banner()!.textContent).toContain('Your session ends in 3 min'));
    routes['/api/me'] = { body: { ...ME, sessionExpiresAt: Date.now() + 12 * 3_600_000 } };
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(banner()).toBeNull());
  });

  it('the fresh sign-in page says when the session ends inside the confirmation’s 5 minutes', async () => {
    signedIn({ ...ME, sessionExpiresAt: Date.now() + 2 * 60_000 });
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'member.remove', status: 'pending', decoded: { userId: 'usr_b', email: 'b@partner.example' }, expiresAt: Date.now() + 5 * 60_000 } };
    at('/actions/act_1');
    expect(await screen.findByText(/Your console session ends in 1 min|Your console session ends in 2 min/u)).toBeTruthy();
    expect(screen.getByText(/a confirmation counts only with the session that started it/u)).toBeTruthy();
  });

  it('no such line when the session outlives the confirmation', async () => {
    signedIn({ ...ME, sessionExpiresAt: Date.now() + 3_600_000 });
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'member.remove', status: 'pending', decoded: { userId: 'usr_b', email: 'b@partner.example' }, expiresAt: Date.now() + 5 * 60_000 } };
    at('/actions/act_1');
    await screen.findByRole('button', { name: /Confirm with Google/u });
    expect(screen.queryByText(/a confirmation counts only with the session that started it/u)).toBeNull();
  });
});
