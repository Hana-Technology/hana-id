// D918: the Platform keys screens in happy-dom, the console's API answered at `fetch`. The list (each state in words;
// a viewer sees no Register form or Stop); registering builds a `platform.key_add` action and goes to its review, and a
// pasted private key is refused before anything is sent; one key's page shows Confirm only when the server says this
// member may, and the reason otherwise (four eyes: the registrant reads "another owner must confirm it"); the email's
// Confirm link only opens the page (GETs, no POST); the emailed cancel and stop pages send the token only after a click.
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

function at(url: string) {
  window.history.replaceState(null, '', url);
  return render(
    <BrowserRouter>
      <App />
    </BrowserRouter>,
  );
}

const NOW = Date.now();
const H = 3_600_000;
const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const T = 'AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE';
const KEY = (o: Record<string, unknown> = {}) => ({ id: 'pkc_Kq2Lm9Xc4PzWb7', orgId: 'org_a', label: 'Production backend', thumbprint: T, scopes: ['s1'], status: 'pending', state: 'waiting', fourEyes: false, proposedByKind: 'member', proposedBy: 'usr_a', proposedAt: NOW - H, notifiedAt: NOW - H + 60_000, activeFrom: NOW + 23 * H, ...o });

function signedIn(role: 'owner' | 'viewer' = 'owner') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role } };
}
const posts = () => calls.filter((c) => c.init?.method === 'POST');

describe('the Platform keys list', () => {
  it('names each state in plain words and offers Register and Stop to an owner', async () => {
    signedIn();
    routes['/api/orgs/org_a/platform-keys'] = {
      body: {
        keys: [KEY({ id: 'pkc_Kq2Lm9Xc4PzWb1', label: 'Working key', status: 'active', state: 'in_force', activeFrom: NOW - H, expiresAt: NOW + 300 * 24 * H }), KEY(), KEY({ id: 'pkc_Kq2Lm9Xc4PzWb2', label: 'Sent to Journear', status: 'awaiting_acceptance', state: 'awaiting_acceptance', proposedByKind: 'hana', proposedBy: 'hana', notifiedAt: undefined, activeFrom: undefined })],
        platform: { enabled: false, frozen: false },
        scopes: ['s1', 's2'],
        people: { usr_a: 'me@partner.example' },
        role: 'owner',
        now: NOW,
      },
    };
    at('/orgs/org_a/platform-keys');
    expect(await screen.findByText('Working key')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Waiting')).toBeTruthy();
    expect(screen.getByText('Waiting for your acceptance')).toBeTruthy();
    expect(screen.getByText('Journear staff')).toBeTruthy();
    expect(screen.getByText(/hasn’t switched platform keys on/u)).toBeTruthy();
    // Two counted keys already? No: three, so the form says why it's not offered.
    expect(screen.getByText(/already has 2 keys working or waiting/u)).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Stop' })).toHaveLength(3);
  });

  it('a viewer sees the keys, no Register form and no Stop', async () => {
    signedIn('viewer');
    routes['/api/orgs/org_a/platform-keys'] = { body: { keys: [KEY()], platform: { enabled: true, frozen: false }, scopes: ['s1'], people: {}, role: 'viewer', now: NOW } };
    at('/orgs/org_a/platform-keys');
    expect(await screen.findByText('Production backend')).toBeTruthy();
    expect(screen.getByText(/only an owner can register a key/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Stop' })).toBeNull();
    expect(screen.queryByLabelText('Public key')).toBeNull();
  });

  it('registering builds the platform.key_add action and goes to its review; a pasted private key is refused before anything is sent', async () => {
    signedIn();
    routes['/api/orgs/org_a/platform-keys'] = { body: { keys: [], platform: { enabled: true, frozen: false }, scopes: ['s1'], people: {}, role: 'owner', now: NOW } };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_x', kind: 'platform.key_add', decoded: {}, expiresAt: NOW + 300_000, returnTo: '/orgs/org_a/platform-keys' } };
    routes['/api/actions/act_x'] = { body: { id: 'act_x', kind: 'platform.key_add', status: 'pending', decoded: { scopeIds: ['s1'], label: 'Prod', thumbprint: T, fourEyes: false }, expiresAt: NOW + 300_000, returnTo: '/orgs/org_a/platform-keys' } };
    at('/orgs/org_a/platform-keys');
    fireEvent.change(await screen.findByLabelText(/^Label/u), { target: { value: 'Prod' } });
    fireEvent.click(screen.getByRole('checkbox'));
    fireEvent.change(screen.getByLabelText(/^Public key/u), { target: { value: '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"secret"}' } });
    expect(await screen.findByText(/This looks like a private key/u)).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Review and confirm with Google' }) as HTMLButtonElement).disabled).toBe(true);
    expect(posts()).toHaveLength(0);
    fireEvent.change(screen.getByLabelText(/^Public key/u), { target: { value: '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm with Google' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ kind: 'platform.key_add', params: { scopeIds: ['s1'], label: 'Prod', publicKey: '-----BEGIN PUBLIC KEY-----\nMFkw\n-----END PUBLIC KEY-----' }, returnTo: { page: 'platform-keys' } });
    expect(await screen.findByText('Register a platform key')).toBeTruthy();
    expect(screen.getByText(T)).toBeTruthy();
  });
});

describe('one key’s page', () => {
  it('offers Confirm only when the server says this member may', async () => {
    signedIn();
    routes['/api/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7'] = { body: { key: KEY({ proposedBy: 'usr_b' }), people: { usr_b: 'boss@partner.example' }, role: 'owner', accept: { allowed: false, reason: 'x' }, confirm: { allowed: true }, now: NOW } };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_c', kind: 'platform.key_confirm', decoded: {}, expiresAt: NOW + 300_000 } };
    at('/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7');
    expect(await screen.findByText(T)).toBeTruthy();
    expect(screen.getByText(/Starts working on .* if nobody confirms it/u)).toBeTruthy();
    expect(screen.getByText(/boss@partner\.example/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm with Google' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]!.init!.body))).toMatchObject({ kind: 'platform.key_confirm', params: { keyId: 'pkc_Kq2Lm9Xc4PzWb7' } });
  });

  it('four eyes: the registrant reads that another owner must confirm it, and has no Confirm button', async () => {
    signedIn();
    routes['/api/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7'] = {
      body: { key: KEY({ fourEyes: true }), people: { usr_a: 'me@partner.example' }, role: 'owner', accept: { allowed: false, reason: 'x' }, confirm: { allowed: false, reason: 'You registered this key, so another owner must confirm it. If nobody does, it starts working when its wait ends.' }, now: NOW },
    };
    at('/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7');
    expect(await screen.findByText(/another owner must confirm it/u)).toBeTruthy();
    expect(screen.getByText('Waiting for another owner')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm with Google' })).toBeNull();
    expect(posts()).toHaveLength(0);
  });

  it('the email’s Confirm link only opens the key’s page: GETs, no POST', async () => {
    signedIn();
    routes['/api/platform-keys/pkc_Kq2Lm9Xc4PzWb7/org'] = { body: { orgId: 'org_a' } };
    routes['/api/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7'] = { body: { key: KEY(), people: {}, role: 'owner', accept: { allowed: false, reason: 'x' }, confirm: { allowed: true }, now: NOW } };
    at('/confirm-platform-key/pkc_Kq2Lm9Xc4PzWb7');
    expect(await screen.findByRole('button', { name: 'Confirm with Google' })).toBeTruthy();
    expect(window.location.pathname).toBe('/orgs/org_a/platform-keys/pkc_Kq2Lm9Xc4PzWb7');
    expect(posts()).toHaveLength(0);
  });
});

describe('the emailed links’ pages', () => {
  it('cancel and stop send the token only after the click, and the token leaves the address bar at once', async () => {
    const token = 'A'.repeat(43);
    routes['/api/platform-keys/revoke'] = { body: { id: 'pkc_Kq2Lm9Xc4PzWb7', label: 'x', state: 'revoked' } };
    at(`/revoke-platform-key/pkc_Kq2Lm9Xc4PzWb7#t=${token}`);
    const button = await screen.findByRole('button', { name: 'Stop this platform key' });
    expect(window.location.hash).toBe('');
    expect(posts()).toHaveLength(0);
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(JSON.parse(String(posts()[0]!.init!.body))).toEqual({ keyId: 'pkc_Kq2Lm9Xc4PzWb7', token });
    expect(await screen.findByText('Stopped.')).toBeTruthy();
    cleanup();
    calls = [];
    routes['/api/platform-keys/cancel'] = { status: 409, body: { error: { code: 'not_pending', message: 'x' } } };
    at(`/cancel-platform-key/pkc_Kq2Lm9Xc4PzWb7#t=${token}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this platform key' }));
    expect(await screen.findByText(/already works/u)).toBeTruthy();
  });
});
