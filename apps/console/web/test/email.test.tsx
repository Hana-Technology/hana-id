// The app's Email login page (build plan batch 9, D444, D447) in the SPA, in happy-dom with the API answered at `fetch`:
// each state's controls, the turning-on steps as server actions, the in-page confirmation for turning it off, and every
// control that can't work replaced by a line saying why (a viewer, a frozen org, not an on-chain owner, no issuer).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';

type Answer = { status?: number; body: unknown };
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
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const at = (url: string) => {
  window.history.replaceState(null, '', url);
  return render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
};

const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }] };
const APP = {
  id: 'app_1',
  name: 'Wallet',
  scopeId: 's1',
  environment: 'live',
  suspendedBy: 0,
  deleted: false,
  activeOrigins: 1,
  pendingChanges: 0,
  createdAt: 0,
  orgId: 'org_a',
  originsVersion: 1,
  settingsVersion: 7,
  origins: [],
  settings: { persistence: 'session', sessionTtlMs: 43_200_000, idleTtlMs: 1_800_000, googleWebClientId: null, rawSign: 'off', policy: null, loginMethods: 'google' },
  changes: [],
  keys: [{ id: 'key_1', prefix: 'pk_live_', key: 'pk_live_abc', createdBy: 'hana', createdAt: 0 }],
};
const PAGE = '/orgs/org_a/apps/app_1/email';
const API = '/api/orgs/org_a/apps/app_1/email';

function signedIn(answer: unknown, role = 'owner', status = 'active') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status }, role } };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: APP } };
  routes['/api/orgs/org_a/members'] = { body: { members: [], invites: [], grants: [] } };
  routes[API] = { body: answer };
  routes['/api/orgs/org_a/actions'] = { body: { id: 'act_9', kind: 'x', decoded: {}, expiresAt: Date.now() + 60_000 } };
}

const base = { scopeId: 's1', available: true, otherAppsEmailOn: 0, deliverability: { days: [{ day: '2026-11-08', sent: 40, bounced: 2, complained: 1, refused: 3 }] } };
const owner = { clientOnChain: false, pending: null, youAreOnChainOwner: true };
const bodyOf = (url: string) => JSON.parse(String(calls.find((c) => c.url === url && c.init?.method === 'POST')!.init!.body)) as Record<string, unknown>;

describe('EmailLogin', () => {
  it('off: an owner turns it on through a fresh sign-in; the numbers show as a table', async () => {
    signedIn({ ...base, emailOn: false, scope: owner });
    at(PAGE);
    await screen.findByRole('heading', { name: 'Email login' });
    expect(screen.getByText('Off')).toBeTruthy();
    // The scope's internal id is not shown as a fact of this page (the scope's own page is one link away).
    expect(screen.queryByText('Scope')).toBeNull();
    expect(screen.queryByText('s1')).toBeNull();
    expect(screen.getByRole('cell', { name: '40' })).toBeTruthy();
    expect(screen.getByText('5.0%')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Review and confirm with Google/u })[0]!);
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'app.settings', params: { appId: 'app_1', loginMethods: 'google,email' } }));
  });

  it('email on, no client yet: an on-chain owner proposes it; someone else is told why', async () => {
    signedIn({ ...base, emailOn: true, scope: owner });
    at(PAGE);
    await screen.findByText('One step left');
    fireEvent.click(await screen.findByRole('button', { name: /Review and confirm with Google/u }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'propose_change', change: { kind: 'AddEmailClient' } } }));
    cleanup();
    signedIn({ ...base, emailOn: true, scope: { ...owner, youAreOnChainOwner: false } });
    at(PAGE);
    await screen.findByText(/isn’t an on-chain owner/u);
    expect(screen.queryByRole('button', { name: /Review and confirm/u })).toBeNull();
  });

  it('a pending change shows when it unlocks; once executable an owner executes it', async () => {
    signedIn({ ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt: Date.now() + 3 * 3_600_000, executable: false } } });
    at(PAGE);
    await screen.findByText('Waiting for the chain');
    await screen.findByText(/it unlocks/u);
    expect(screen.queryByRole('button', { name: /Execute the change/u })).toBeNull();
    cleanup();
    routes['/api/orgs/org_a/scopes/s1/execute'] = { body: { status: 'ok', nearTx: 'abc' } };
    signedIn({ ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt: Date.now() - 1000, executable: true } } });
    at(PAGE);
    fireEvent.click(await screen.findByRole('button', { name: /Execute the change/u }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/scopes/s1/execute')).toEqual({ changeId: 12 }));
  });

  it('on: turned off in the page with a second click, not a browser dialog; the version is the app’s', async () => {
    signedIn({ ...base, emailOn: true, scope: { ...owner, clientOnChain: true } });
    routes['/api/orgs/org_a/apps/app_1/off'] = { body: { version: 8 } };
    at(PAGE);
    await screen.findByText('On');
    fireEvent.click(await screen.findByRole('button', { name: 'Turn email login off for this app' }));
    expect(screen.getByText(/stop being offered email at once/u)).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/off'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Turn off' }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/apps/app_1/off')).toEqual({ what: 'email', expectedVersion: 7 }));
  });

  it('a viewer sees the state and numbers with no controls', async () => {
    signedIn({ ...base, emailOn: true, scope: { ...owner, clientOnChain: true } }, 'viewer');
    at(PAGE);
    await screen.findByText('On');
    expect(screen.queryByRole('button', { name: 'Turn email login off for this app' })).toBeNull();
    expect(await screen.findByText(/Only owners can turn email login off/u)).toBeTruthy();
    expect(screen.getByRole('cell', { name: '40' })).toBeTruthy();
  });

  it('a frozen org can’t turn it on, says why', async () => {
    signedIn({ ...base, emailOn: false, scope: owner }, 'owner', 'frozen');
    at(PAGE);
    expect(await screen.findByText(/can’t be turned on while Hana has frozen/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Review and confirm/u })).toBeNull();
  });

  it('the email client can be removed only when no other app uses it and the caller is an on-chain owner', async () => {
    signedIn({ ...base, emailOn: false, scope: { ...owner, clientOnChain: true } });
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_2', kind: 'owner_action', decoded: {}, expiresAt: Date.now() + 60_000 } };
    at(PAGE);
    fireEvent.click(await screen.findByRole('button', { name: /Remove the scope’s email client/u }));
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'remove_client', aud: 'email:s1' } }));
    cleanup();
    signedIn({ ...base, otherAppsEmailOn: 2, emailOn: false, scope: { ...owner, clientOnChain: true } });
    at(PAGE);
    expect(await screen.findByText(/stays while another app/u)).toBeTruthy();
  });

  it('empty and unavailable numbers, an unreadable chain, a missing issuer, and an error say so', async () => {
    signedIn({ ...base, deliverability: { days: [] }, emailOn: false, scope: { unavailable: true } });
    at(PAGE);
    expect(await screen.findByText('No mail sent yet')).toBeTruthy();
    expect(screen.getByText(/can’t be read right now/u)).toBeTruthy();
    cleanup();
    signedIn({ ...base, deliverability: { unavailable: true }, emailOn: false, scope: owner });
    at(PAGE);
    expect(await screen.findByText(/numbers are unavailable/u)).toBeTruthy();
    cleanup();
    signedIn({ ...base, available: false, emailOn: false, scope: owner });
    at(PAGE);
    expect(await screen.findByText(/isn’t offered in this environment/u)).toBeTruthy();
    cleanup();
    signedIn({});
    routes[API] = { status: 503, body: { error: { code: 'near_unavailable', message: 'NEAR RPC is unavailable: try again' } } };
    at(PAGE);
    expect(await screen.findByText(/NEAR|try again/u)).toBeTruthy();
  });
});
