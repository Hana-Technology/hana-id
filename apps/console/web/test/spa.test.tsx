// The partner SPA (web/src), rendered in happy-dom with the console's API answered at `fetch`: the invite token read from
// the fragment, dropped from the address bar and sent only in the POST body with the CSRF header; sign-in errors from
// `/signin#error=`; a 401 sending the browser to sign-in; the read-only screens (apps, an app's origins, changes, keys and
// settings, members, the audit's pages).
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nav } from '../src/api.ts';
import { App } from '../src/App.tsx';

type Answer = { status?: number; body: unknown };
let routes: Record<string, Answer | ((init?: RequestInit) => Answer)>;
let calls: { url: string; init?: RequestInit }[];

beforeEach(() => {
  routes = {};
  calls = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/u, '');
    calls.push({ url, ...(init ? { init } : {}) });
    const r = routes[url];
    const a = typeof r === 'function' ? r(init) : (r ?? { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
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

const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }] };
const ORG = { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' };

describe('sign-in pages', () => {
  it('/signin#error=not_invited explains it and clears the fragment', async () => {
    at('/signin#error=not_invited');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('isn’t a member of any organisation'));
    expect(window.location.hash).toBe('');
  });

  it('an unknown error code reads as a generic failure', async () => {
    at('/signin#error=<script>');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Something went wrong'));
  });

  it('/invite#t=: the token leaves the address bar at once and goes only in the POST body, with the CSRF header', async () => {
    const token = 'T'.repeat(43);
    const assign = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    routes['/api/auth/start'] = { body: { startUrl: 'https://console-auth.test/start?f=abc' } };
    at(`/invite#t=${token}`);
    const button = await screen.findByRole('button', { name: /accept/iu });
    expect(window.location.hash).toBe('');
    expect(window.location.href).not.toContain(token);
    fireEvent.click(button);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://console-auth.test/start?f=abc'));
    const post = calls.find((c) => c.url === '/api/auth/start')!;
    expect(post.init!.method).toBe('POST');
    expect(JSON.parse(String(post.init!.body))).toEqual({ purpose: 'login', invite: token });
    expect(new Headers(post.init!.headers).get('x-hana-console')).toBe('1');
    expect(new Headers(post.init!.headers).get('content-type')).toBe('application/json');
    expect(calls.every((c) => !c.url.includes(token))).toBe(true);
  });

  it('an invite the backend refuses says so, and no navigation happens', async () => {
    const assign = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    routes['/api/auth/start'] = { status: 403, body: { error: { code: 'invite_invalid', message: 'x' } } };
    at(`/invite#t=${'T'.repeat(43)}`);
    fireEvent.click(await screen.findByRole('button', { name: /accept/iu }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('can’t be used'));
    expect(assign).not.toHaveBeenCalled();
  });

  it('a malformed invite link sends nothing', async () => {
    at('/invite#t=short');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('incomplete'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('signed in', () => {
  it('no session (401) goes to sign-in', async () => {
    routes['/api/me'] = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in again' } } };
    at('/');
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    expect(window.location.pathname).toBe('/signin');
  });

  it("one org: straight to its apps; an app's origins (IDN flagged), pending change, keys and settings", async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: ORG };
    routes['/api/orgs/org_a/apps'] = { body: { apps: [{ id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'test', suspendedBy: 0, deleted: false, activeOrigins: 2, pendingChanges: 1, createdAt: 0 }] } };
    routes['/api/orgs/org_a/apps/app_1'] = {
      body: {
        app: {
          id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'test', suspendedBy: 4, deleted: false, activeOrigins: 2, pendingChanges: 1, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 1,
          origins: [
            { origin: 'https://app.partner.example', display: 'https://app.partner.example', idn: false, activeFrom: 0 },
            { origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', idn: true, activeFrom: null, changeId: 'gc_1' },
          ],
          settings: { persistence: 'session', sessionTtlMs: 7_200_000, idleTtlMs: 1_800_000, googleWebClientId: null, rawSign: 'off', policy: null },
          changes: [{ id: 'gc_1', appId: 'app_1', kind: 'origin_add', origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', idn: true, status: 'pending', proposedByKind: 'hana', proposedBy: 'hana', proposedAt: 0, notifiedAt: 1, activeFrom: 86_400_000 }],
          keys: [{ id: 'key_1', prefix: 'pk_test_', key: 'pk_test_abc', createdBy: 'hana', createdAt: 0 }],
        },
      },
    };
    routes['/api/orgs/org_a'] = { body: { ...ORG, role: 'viewer' } };
    at('/');
    expect(await screen.findByText('Wallet')).toBeTruthy();
    expect(window.location.pathname).toBe('/orgs/org_a');
    fireEvent.click(screen.getByText('Wallet'));
    // The overview: the copyable App ID and key, the suspension, the change waiting, the settings summary.
    expect(await screen.findByText('pk_test_abc', { selector: 'code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy App ID' })).toBeTruthy();
    expect(screen.getAllByText(/Suspended by your organisation/u).length).toBeGreaterThan(0);
    expect(screen.getByText(/Pending: active from/u)).toBeTruthy();
    expect(screen.getByText('2 h')).toBeTruthy();
    expect(screen.getByText('30 min')).toBeTruthy();
    expect(screen.getByText(/You’re a viewer: you can see this app’s setup/u)).toBeTruthy();
    // A viewer: no write control on any section (sign out and the copy buttons are the only buttons).
    const writes = () =>
      screen
        .getAllByRole('button')
        .filter((b) => !b.classList.contains('btn-copy'))
        .map((b) => b.textContent);
    expect(writes()).toEqual(['Sign out']);
    fireEvent.click(screen.getByRole('link', { name: /^Origins/u }));
    expect(await screen.findByText('https://bücher.example', { selector: 'span' })).toBeTruthy();
    expect(screen.getAllByText('IDN').length).toBeGreaterThan(0);
    expect(screen.getByText('Only owners can add or remove origins.')).toBeTruthy();
    expect(writes()).toEqual(['Sign out']);
    for (const [name, heading] of [['Keys', 'Publishable keys'], ['Login & sessions', 'Change these settings'], ['Signing', 'Raw signing'], ['Branding', 'Logo'], ['Suspend', 'Suspend the app']] as const) {
      fireEvent.click(screen.getByRole('link', { name: new RegExp(`^${name}`, 'u') }));
      await screen.findByRole('heading', { name: heading });
      expect(writes(), name).toEqual(['Sign out']);
    }
  });

  it('members: roles, a pending owner, open invites with Hana as inviter', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: ORG };
    routes['/api/orgs/org_a/members'] = {
      body: {
        members: [
          { userId: 'usr_a', email: 'me@partner.example', role: 'owner', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: false },
          { userId: 'usr_b', email: 'new@partner.example', role: 'viewer', roleSince: 0, addedBy: 'usr_a', addedAt: 0, disabled: false, pendingOwnerFrom: 86_400_000 },
        ],
        invites: [{ id: 'inv_1', email: 'next@partner.example', role: 'viewer', createdByKind: 'hana', createdBy: 'hana', notified: false, createdAt: 0, expiresAt: 1 }],
        grants: [{ id: 'og_1', userId: 'usr_b', grantedByKind: 'member', createdAt: 0, notifiedAt: 1, ownerFrom: 86_400_000 }],
      },
    };
    at('/orgs/org_a/members');
    expect(await screen.findByText('next@partner.example')).toBeTruthy();
    expect(screen.getByText(/doesn’t work yet/u)).toBeTruthy();
    expect(screen.getByText('Pending owners')).toBeTruthy();
    expect(screen.getAllByText('new@partner.example').length).toBe(2);
  });

  it('the audit: a page, then the next with the cursor', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: ORG };
    const row = (seq: number, source: 'console' | 'api') =>
      source === 'console'
        ? { source, seq, at: seq, actorKind: 'hana', actorId: 'hana', action: 'invite.issued', details: { role: 'viewer' }, requestId: `req_${seq}`, outcome: 'ok' }
        : { source, seq, at: seq, kind: 'key.created', detail: {}, actorKind: 'member', actorId: 'usr_a', requestId: `req_api_${seq}` };
    routes['/api/orgs/org_a/audit'] = { body: { entries: [row(9, 'console'), row(8, 'api')], next: '9.8' } };
    routes['/api/orgs/org_a/audit?cursor=9.8'] = { body: { entries: [row(1, 'console')] } };
    at('/orgs/org_a/audit');
    expect(await screen.findByText('key.created')).toBeTruthy();
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Load more' })));
    await waitFor(() => expect(screen.getAllByText('invite.issued')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });

  it('sign out posts the logout with the CSRF header and goes to sign-in', async () => {
    routes['/api/me'] = { body: { ...ME, memberships: [] } };
    routes['/api/auth/logout'] = { body: {} };
    at('/');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(window.location.pathname).toBe('/signin'));
    const post = calls.find((c) => c.url === '/api/auth/logout')!;
    expect(new Headers(post.init!.headers).get('x-hana-console')).toBe('1');
  });
});
