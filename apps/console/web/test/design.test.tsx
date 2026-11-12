// The Journear Passport design system's patterns in the console (D765): toasts for a write's success (at most 3, gone
// after 5 s unless hovered, a danger one stays), the save bar on saved settings (up at the first change, counts,
// Discard, Save), fields checked once they are left (validate on blur), the optional fields marked, choice cards, the
// stats strip, the lockup drawn from the brand's own files, and the new names.
import { LOCKUP, MARK_BRACKET, MARK_CARD } from '@hana-id/brand';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { TOAST_MAX, TOAST_MS, ToastProvider, useToast } from '../src/toast.tsx';
import { Lockup } from '../src/ui.tsx';

type Answer = { status?: number; body: unknown };
let routes: Record<string, Answer>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  resetSession();
  routes = {};
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, '');
    calls.push({ url, ...(init ? { init } : {}) });
    const a = routes[url] ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
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

const H = 3_600_000;
const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const APP = {
  id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'live', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 5,
  origins: [{ origin: 'https://app.partner.example', display: 'https://app.partner.example', idn: false, activeFrom: 0 }],
  settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
  changes: [] as unknown[],
  keys: [{ id: 'k1', prefix: 'pk_live_', key: 'pk_live_k1', createdBy: 'hana', createdAt: 0 }],
};
function signedIn(app: Record<string, unknown> = {}) {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, ...app } } };
  routes['/api/orgs/org_a/members'] = { body: { members: [{ userId: 'usr_a', email: 'me@partner.example', role: 'owner', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: false }], invites: [], grants: [] } };
}
const posted = (url: string) => calls.filter((c) => c.url === url && c.init?.method === 'POST');
const bar = () => screen.queryByRole('region', { name: 'Unsaved changes' });

function Pusher({ tone }: { tone?: 'danger' }) {
  const toast = useToast();
  let n = 0;
  return (
    <button type="button" onClick={() => toast({ title: `Toast ${++n}`, ...(tone ? { tone } : {}) })}>
      push
    </button>
  );
}

describe('toasts', () => {
  const region = () => screen.getByRole('region', { name: 'Notifications' });

  it('a write’s success is a toast in the notifications region, not an inline line', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/keys'] = { body: {} };
    at('/orgs/org_a/apps/app_1/keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Create a key' }));
    await waitFor(() => expect(within(region()).getByText('Key created. Copy it into your page.')).toBeTruthy());
    expect(region().querySelector('.jp-toast.jp-toast-success')).not.toBeNull();
    expect(within(region()).getByRole('button', { name: 'Dismiss' })).toBeTruthy();
  });

  it('at most three at once (the oldest goes), each gone after 5 s, sooner when dismissed', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    for (let i = 0; i < 4; i++) fireEvent.click(screen.getByRole('button', { name: 'push' }));
    const shown = () => [...region().querySelectorAll('.jp-toast b')].map((b) => b.textContent);
    expect(shown()).toEqual(['Toast 2', 'Toast 3', 'Toast 4']);
    expect(shown()).toHaveLength(TOAST_MAX);
    fireEvent.click(within(region()).getAllByRole('button', { name: 'Dismiss' })[0]!);
    expect(shown()).toEqual(['Toast 3', 'Toast 4']);
    act(() => vi.advanceTimersByTime(TOAST_MS - 10));
    expect(shown()).toHaveLength(2);
    act(() => vi.advanceTimersByTime(20));
    expect(shown()).toEqual([]);
  });

  it('a hovered toast stays until the pointer leaves; a danger toast stays until dismissed, as an alert', () => {
    vi.useFakeTimers();
    render(
      <ToastProvider>
        <Pusher />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'push' }));
    const t = region().querySelector('.jp-toast')!;
    act(() => vi.advanceTimersByTime(2_000));
    fireEvent.mouseEnter(t);
    act(() => vi.advanceTimersByTime(10_000));
    expect(region().querySelector('.jp-toast')).not.toBeNull();
    fireEvent.mouseLeave(t);
    act(() => vi.advanceTimersByTime(TOAST_MS - 2_000 + 10));
    expect(region().querySelector('.jp-toast')).toBeNull();
    cleanup();
    render(
      <ToastProvider>
        <Pusher tone="danger" />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'push' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(within(region()).getByRole('alert').textContent).toContain('Toast 1');
    fireEvent.click(within(region()).getByRole('button', { name: 'Dismiss' }));
    expect(within(region()).queryByRole('alert')).toBeNull();
  });
});

describe('the save bar', () => {
  it('Branding: up at the first change to the name, Discard puts it back, Save writes it at once', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/profile'] = { body: {} };
    at('/orgs/org_a/apps/app_1/branding');
    const name = (await screen.findByLabelText(/^App name/u)) as HTMLInputElement;
    expect(bar()).toBeNull();
    fireEvent.change(name, { target: { value: 'Wallet Pro' } });
    expect(within(bar()!).getByText('1 unsaved change')).toBeTruthy();
    expect(bar()!.className).toContain('jp-savebar');
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Discard' }));
    expect(name.value).toBe('Wallet');
    expect(bar()).toBeNull();
    fireEvent.change(name, { target: { value: 'Wallet Pro' } });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(posted('/api/orgs/org_a/apps/app_1/profile')).toHaveLength(1));
    expect(JSON.parse(String(posted('/api/orgs/org_a/apps/app_1/profile')[0]!.init!.body))).toEqual({ name: 'Wallet Pro', expectedVersion: 5 });
    expect(await screen.findByText('Renamed.')).toBeTruthy();
  });

  it('Branding: an emptied name is flagged once left, and Save stays off', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/branding');
    const name = await screen.findByLabelText(/^App name/u);
    fireEvent.change(name, { target: { value: '  ' } });
    expect(screen.queryByText('Enter a name.')).toBeNull();
    fireEvent.blur(name);
    expect(screen.getByText('Enter a name.')).toBeTruthy();
    expect(within(bar()!).getByRole('button', { name: 'Save changes' })).toHaveProperty('disabled', true);
    expect(within(bar()!).getByText(/Fix the highlighted field/u)).toBeTruthy();
  });

  it('Login & sessions: the switch, the optional client and Discard; Save keeps the fresh sign-in', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_x', kind: 'app.settings', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/apps/app_1/sessions');
    const keep = (await screen.findByRole('switch', { name: /Stay signed in across reloads/u })) as HTMLInputElement;
    expect(keep.checked).toBe(true);
    // The optional field says so; required is the default.
    expect(screen.getByText('Google web client').querySelector('.opt')?.textContent).toBe('Optional');
    fireEvent.click(keep);
    fireEvent.change(screen.getByLabelText(/^Google web client/u), { target: { value: '1-a.apps.googleusercontent.com' } });
    expect(within(bar()!).getByText('2 unsaved changes')).toBeTruthy();
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Discard' }));
    expect(keep.checked).toBe(true);
    expect((screen.getByLabelText(/^Google web client/u) as HTMLInputElement).value).toBe('');
    expect(bar()).toBeNull();
    fireEvent.click(keep);
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Review and confirm with Google' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_x'));
    expect(JSON.parse(String(posted('/api/orgs/org_a/actions')[0]!.init!.body))).toEqual({ kind: 'app.settings', params: { appId: 'app_1', persistence: 'none' }, returnTo: { page: 'sessions', appId: 'app_1' } });
  });
});

describe('forms', () => {
  it('the invite: the address is checked when left, the role is a choice card that says what an owner can do', async () => {
    signedIn();
    at('/orgs/org_a/members');
    const email = await screen.findByPlaceholderText('name@company.com');
    fireEvent.change(email, { target: { value: 'not-an-address' } });
    expect(screen.queryByText(/Enter an email address/u)).toBeNull();
    fireEvent.blur(email);
    expect(screen.getByText(/Enter an email address/u)).toBeTruthy();
    expect(email.getAttribute('aria-invalid')).toBe('true');
    const roles = screen.getByRole('group', { name: 'Role' });
    expect((within(roles).getByRole('radio', { name: /^Viewer/u }) as HTMLInputElement).checked).toBe(true);
    expect(within(roles).getByText(/Changes apps, keys and members/u)).toBeTruthy();
    fireEvent.change(email, { target: { value: 'new@partner.example' } });
    expect(screen.queryByText(/Enter an email address/u)).toBeNull();
  });

  it('the Workspace domain is a setting row with the save bar, and Save starts the fresh sign-in', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_d', kind: 'org.policy', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/members');
    const domain = await screen.findByLabelText(/^Required domain/u);
    expect(bar()).toBeNull();
    fireEvent.change(domain, { target: { value: 'partner.example' } });
    fireEvent.click(within(bar()!).getByRole('button', { name: 'Review and confirm with Google' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_d'));
    expect(JSON.parse(String(posted('/api/orgs/org_a/actions')[0]!.init!.body))).toMatchObject({ kind: 'org.policy', params: { requiredHd: 'partner.example' } });
  });
});

describe('the look', () => {
  it('the lockup is the brand’s (D789): the mark, the outlined wordmark and PASSPORT, laid out as the file, named Journear Passport', () => {
    render(<Lockup />);
    const svg = screen.getByRole('img', { name: 'Journear Passport' });
    expect(svg.getAttribute('viewBox')).toBe(LOCKUP.viewBox);
    expect(svg.querySelector('g')!.getAttribute('transform')).toBe(LOCKUP.mark);
    expect(svg.querySelector('.lk-card')!.getAttribute('d')).toBe(MARK_CARD);
    expect(svg.querySelector('.lk-bracket')!.getAttribute('d')).toBe(MARK_BRACKET);
    for (const [cls, part] of [['.lk-word', LOCKUP.word], ['.lk-sub', LOCKUP.sub]] as const) {
      expect(svg.querySelector(cls)!.getAttribute('d')).toBe(part.d);
      expect(svg.querySelector(cls)!.getAttribute('transform')).toBe(part.transform);
    }
    // Outlined: no live text to fall back to another face.
    expect(svg.querySelector('text')).toBeNull();
    // Never below the 120 px minimum, in the lockup's own proportions.
    expect(Number(svg.getAttribute('width'))).toBeGreaterThanOrEqual(120);
    expect(Number(svg.getAttribute('height'))).toBe(Math.round((176 * LOCKUP.height) / LOCKUP.width));
  });

  it('the sidebar names the product and the console; the overview opens on the stats strip', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1');
    const brand = await screen.findByRole('link', { name: /Journear Passport/u });
    expect(brand.textContent).toContain('Partner console');
    const strip = await screen.findByRole('group', { name: 'This app at a glance' });
    expect(strip.className).toBe('jp-stats');
    expect([...strip.querySelectorAll('.jp-stat')].map((s) => [s.querySelector('.k')!.textContent, s.querySelector('.v')!.textContent])).toEqual([
      ['Active origins', '1'],
      ['Working keys', '1'],
      ['Pending changes', '0'],
    ]);
    expect(document.body.textContent).not.toMatch(/\bHana\b/u);
  });

  it('a danger action sits behind a confirm: the second button is the danger one', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/suspend');
    const first = await screen.findByRole('button', { name: 'Suspend the app' });
    expect(first.className).not.toContain('jp-btn-danger');
    fireEvent.click(first);
    expect(screen.getByRole('button', { name: /Suspend now/u }).className).toContain('jp-btn-danger');
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('a table has the system’s wrapper, and its numbers are right-aligned', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/email'] = {
      body: { appId: 'app_1', scopeId: 's1', available: true, emailOn: true, otherAppsEmailOn: 0, scope: { clientOnChain: true, pending: null, youAreOnChainOwner: true }, deliverability: { days: [{ day: '2026-11-11', sent: 40, bounced: 2, complained: 0, refused: 1 }] } },
    };
    at('/orgs/org_a/apps/app_1/email');
    const table = (await screen.findByRole('columnheader', { name: 'Sent' })).closest('table')!;
    expect(table.className).toContain('jp-table');
    expect(table.parentElement!.className).toContain('jp-table-wrap');
    expect(screen.getByRole('columnheader', { name: 'Sent' }).className).toBe('num');
    expect(screen.getByRole('group', { name: 'The last 14 days' }).textContent).toContain('5.0%');
  });
});
