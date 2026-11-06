// The partner SPA's write paths (batch C10), in happy-dom with the console's API answered at `fetch`: a fresh sign-in
// built on the server, reviewed on `/actions/:id` (an IDN origin flagged, the policy's consent preview as users see it)
// and confirmed with Google; immediate writes behind a second click; a frozen org's controls; the emailed cancel pages
// (the token from the fragment, gone from the address bar, sent only in a POST after a click; a second confirm told
// it's no longer pending); the AddClient PII warning; the email sharing setting (D411) through the settings action; the
// Users tab only when the server has it on, an email only as shared ("Not shared" otherwise), each app's in a detail.
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policyJson } from '../../../../packages/core/test/policy-fixtures.ts';
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

const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const org = (role = 'owner', status = 'active') => ({ org: { id: 'org_a', name: 'Acme', status }, role });
const APP = {
  id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'live', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 5,
  origins: [{ origin: 'https://app.partner.example', display: 'https://app.partner.example', idn: false, activeFrom: 0 }],
  settings: { persistence: 'session', sessionTtlMs: 43_200_000, idleTtlMs: 1_800_000, googleWebClientId: null, rawSign: 'off', policy: null },
  changes: [],
  keys: [{ id: 'key_1', prefix: 'pk_live_', key: 'pk_live_abc', createdBy: 'hana', createdAt: 0 }],
};
const bodyOf = (url: string) => JSON.parse(String(calls.find((c) => c.url === url && c.init?.method === 'POST')!.init!.body)) as Record<string, unknown>;
const headerOf = (url: string, h: string) => new Headers(calls.find((c) => c.url === url && c.init?.method === 'POST')!.init!.headers).get(h);

function signedIn(role = 'owner', status = 'active') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: org(role, status) };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: APP } };
}

describe('a fresh sign-in, end to end in the SPA', () => {
  it('adding an origin: built on the server, reviewed with its IDN flag, confirmed with Google', async () => {
    signedIn();
    const assign = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    const decoded = { appId: 'app_1', appName: 'Wallet', add: [{ origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', idn: true }], remove: [] };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_1', kind: 'origin.add', decoded, expiresAt: Date.now() + 300_000 } };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'origin.add', status: 'pending', decoded, expiresAt: Date.now() + 300_000 } };
    routes['/api/actions/act_1/google'] = { body: { startUrl: 'https://console-auth.test/start?f=xyz' } };
    at('/orgs/org_a/apps/app_1');
    fireEvent.change(await screen.findByPlaceholderText('https://app.example.com'), { target: { value: 'https://bücher.example' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Review and confirm with Google' })[0]!);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_1'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'origin.add', params: { appId: 'app_1', add: ['https://bücher.example'] } });
    expect(headerOf('/api/orgs/org_a/actions', 'x-hana-console')).toBe('1');
    expect(await screen.findByText('Add origins')).toBeTruthy();
    expect(screen.getByText('IDN')).toBeTruthy();
    expect(screen.getByText('https://xn--bcher-kva.example')).toBeTruthy();
    expect(screen.getByText(/internationalised \(punycode\) name/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://console-auth.test/start?f=xyz'));
  });

  it('email sharing (D411): shown as off when the API omits it; the select sends identityEmail in the settings action, and only when changed', async () => {
    signedIn();
    vi.spyOn(nav, 'assign').mockImplementation(() => {});
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_5', kind: 'app.settings', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/apps/app_1');
    const select = (await screen.findByLabelText(/^Email sharing/u)) as HTMLSelectElement;
    expect(select.value).toBe('off');
    expect([...select.options].map((o) => [o.value, o.textContent])).toEqual([
      ['off', 'Off: never asked (default)'],
      ['on_request', 'When the app asks: requestEmailSharing()'],
      ['at_login', 'At first login'],
    ]);
    const submit = screen.getAllByRole('button', { name: 'Review and confirm with Google' }).at(-1)! as HTMLButtonElement;
    expect(submit.disabled).toBe(true); // nothing changed yet
    fireEvent.change(select, { target: { value: 'at_login' } });
    fireEvent.click(submit);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_5'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'app.settings', params: { appId: 'app_1', identityEmail: 'at_login' } });
  });

  it('email sharing: the current value comes from settings.identityEmail; the review page names the change', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, settings: { ...APP.settings, identityEmail: 'on_request' } } } };
    at('/orgs/org_a/apps/app_1');
    expect(((await screen.findByLabelText(/^Email sharing/u)) as HTMLSelectElement).value).toBe('on_request');
    expect(screen.getByText('When the app asks')).toBeTruthy();
    cleanup();
    routes['/api/actions/act_6'] = { body: { id: 'act_6', kind: 'app.settings', status: 'pending', decoded: { appId: 'app_1', appName: 'Wallet', changes: { identityEmail: 'off' } }, expiresAt: Date.now() + 300_000 } };
    at('/actions/act_6');
    expect(await screen.findByText('Email sharing: off')).toBeTruthy();
  });

  it('the outcome page: a refused confirmation says why, and no confirm button is left', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_2'] = { body: { id: 'act_2', kind: 'member.remove', status: 'failed', decoded: { userId: 'usr_b', email: 'b@partner.example' }, expiresAt: 0, outcome: { status: 'failed', code: 'sub_mismatch' } } };
    at('/actions/act_2');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('another Google account'));
    expect(screen.queryByRole('button', { name: 'Confirm with Google' })).toBeNull();
  });

  it('the policy editor checks the policy, shows the consent screen as users see it, then proposes it', async () => {
    signedIn();
    const v = validateAutoApprovePolicy(policyJson());
    if (!v.ok) throw new Error('fixture');
    const policy = JSON.parse(JSON.stringify(v.policy)) as unknown;
    routes['/api/orgs/org_a/apps/app_1/policy/check'] = { body: { policyId: 'a'.repeat(64), label: 'Swaps on Example', policy } };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_3', kind: 'policy.set', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/apps/app_1');
    fireEvent.change(await screen.findByLabelText(/Policy \(JSON/u), { target: { value: JSON.stringify(policyJson()) } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and preview' }));
    expect(await screen.findByText('Allow automatic signing?')).toBeTruthy();
    expect(screen.getByText('“Swaps on Example”')).toBeTruthy();
    expect(bodyOf('/api/orgs/org_a/apps/app_1/policy/check')).toEqual({ policy: policyJson() });
    fireEvent.click(screen.getByRole('button', { name: /Propose this policy/u }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_3'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'policy.set', params: { appId: 'app_1', policy } });
  });

  it('an invalid policy shows the validator’s problems and no preview', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/policy/check'] = { status: 400, body: { error: { code: 'policy_invalid', message: 'label: required' } } };
    at('/orgs/org_a/apps/app_1');
    fireEvent.change(await screen.findByLabelText(/Policy \(JSON/u), { target: { value: '{"v":1}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and preview' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', 'label: required');
    expect(screen.queryByText('Allow automatic signing?')).toBeNull();
  });
});

describe('immediate writes', () => {
  it('a key revoke needs a second click, then posts with the CSRF header', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/keys/key_1/revoke'] = { body: {} };
    at('/orgs/org_a/apps/app_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Revoke the last key/u }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/apps/app_1/keys/key_1/revoke')).toBe(true));
    expect(headerOf('/api/orgs/org_a/apps/app_1/keys/key_1/revoke', 'x-hana-console')).toBe('1');
  });

  it('the logo goes as a raw octet-stream body at the settings version', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/logo?expectedVersion=5'] = { body: { logoUrl: 'https://files.test/logos/app_1/x.png', version: 6 } };
    at('/orgs/org_a/apps/app_1');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('Logo file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload the logo' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/apps/app_1/logo?expectedVersion=5')).toBe(true));
    expect(headerOf('/api/orgs/org_a/apps/app_1/logo?expectedVersion=5', 'content-type')).toBe('application/octet-stream');
    expect(headerOf('/api/orgs/org_a/apps/app_1/logo?expectedVersion=5', 'x-hana-console')).toBe('1');
  });

  it('a frozen org: only the kill switches are offered (revoke, suspend, remove an origin), no add, no create', async () => {
    signedIn('owner', 'frozen');
    at('/orgs/org_a/apps/app_1');
    await screen.findByText('pk_live_abc');
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual(expect.arrayContaining(['Revoke', 'Suspend the app', 'Remove']));
    for (const n of ['Create a key', 'Rotate', 'Review and confirm with Google', 'Check and preview', 'Save the name', 'Upload the logo']) expect(names, n).not.toContain(n);
  });
});

describe('the emailed cancel pages', () => {
  it('/cancel/:id#t=: the token leaves the address bar, nothing is sent until the click, then only in the POST body', async () => {
    const token = 'K'.repeat(43);
    routes['/api/cancel'] = { body: { id: 'gc_1', status: 'cancelled' } };
    at(`/cancel/gc_1#t=${token}`);
    const button = await screen.findByRole('button', { name: 'Cancel this change' });
    expect(window.location.hash).toBe('');
    expect(calls).toEqual([]);
    fireEvent.click(button);
    expect(await screen.findByRole('status')).toHaveProperty('textContent', expect.stringContaining('Cancelled'));
    expect(bodyOf('/api/cancel')).toEqual({ changeId: 'gc_1', token });
    expect(headerOf('/api/cancel', 'x-hana-console')).toBe('1');
    expect(calls.every((c) => !c.url.includes(token))).toBe(true);
  });

  it('a used link (single use) or a wrong one says so', async () => {
    routes['/api/cancel'] = { status: 409, body: { error: { code: 'not_pending', message: 'x' } } };
    at(`/cancel/gc_1#t=${'K'.repeat(43)}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this change' }));
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('Nothing to cancel any more'));
  });

  it('/cancel-owner/:grantId#t= posts the grant cancel; a link without a token sends nothing', async () => {
    const token = 'G'.repeat(43);
    routes['/api/owner-grants/cancel'] = { body: {} };
    at(`/cancel-owner/og_1#t=${token}`);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this new owner' }));
    await screen.findByRole('status');
    expect(bodyOf('/api/owner-grants/cancel')).toEqual({ grantId: 'og_1', token });
    cleanup();
    calls = [];
    at('/cancel-owner/og_1');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('incomplete'));
    expect(screen.queryByRole('button')).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('the scope page', () => {
  const SCOPE = {
    scope: { id: 's1', actionNonce: 4, allowShared: true, clients: [], owners: [{ kind: 'member', userId: 'usr_a', email: 'me@partner.example', orgOwner: true }, { kind: 'other_google' }], pending: [] },
    drift: { hasDrift: true, missingOnChain: [], notOrgOwners: [], unknownOnChain: 1 },
    youAreOnChainOwner: true,
  };

  it('AddClient: the helper is a download link; the proof is sent only after the PII warning is accepted', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: org() };
    routes['/api/orgs/org_a/scopes/s1'] = { body: SCOPE };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_9', kind: 'owner_action', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/scopes/s1');
    expect(await screen.findByText('A Google account that isn’t a member of this organisation')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('123-abc.apps.googleusercontent.com'), { target: { value: '123-abc.apps.googleusercontent.com' } });
    const link = screen.getByRole('link', { name: 'Download the client-proof helper' });
    expect(link.getAttribute('href')).toBe('/api/orgs/org_a/scopes/s1/client-proof-helper?clientId=123-abc.apps.googleusercontent.com');
    expect(link.hasAttribute('download')).toBe(true);
    fireEvent.change(screen.getByLabelText(/Paste the token/u), { target: { value: 'a.b.c' } });
    const propose = screen.getByRole('button', { name: /Propose adding the client/u });
    expect(propose).toHaveProperty('disabled', true);
    expect(screen.getByRole('note').textContent).toMatch(/public on the NEAR blockchain/u);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(propose).toHaveProperty('disabled', false);
    fireEvent.click(propose);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_9'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'propose_change', change: { kind: 'AddClient', aud: '123-abc.apps.googleusercontent.com', clientProof: 'a.b.c', piiWarningAccepted: true } } });
  });

  it('owner drift offers the SetOwners proposal', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: org() };
    routes['/api/orgs/org_a/scopes/s1'] = { body: SCOPE };
    at('/orgs/org_a/scopes/s1');
    expect(await screen.findByText(/aren’t members of this organisation/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /set the on-chain owners/u })).toBeTruthy();
  });
});

describe('the Users screen (D310, D346)', () => {
  it('the tab is shown only when the server has the screen on', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: org() };
    routes['/api/orgs/org_a/apps'] = { body: { apps: [] } };
    at('/orgs/org_a');
    await screen.findByText(/No apps yet/u);
    expect(screen.queryByRole('link', { name: 'Users' })).toBeNull();
    cleanup();
    routes['/api/me'] = { body: { ...ME, features: { users: true } } };
    at('/orgs/org_a');
    expect(await screen.findByRole('link', { name: 'Users' })).toBeTruthy();
  });

  const USER = { userId: 'u1_AbCdEfGhIjKlMnOpQrStUv', supportId: 'HANA-ABCD-EFGH', scopeId: 's1', createdAt: 0, lastSeenAt: 0, accounts: [{ kind: 'google', status: 'active' }, { kind: 'email', status: 'pending' }], wallets: [{ chain: 'evm', address: '0x52908400098527886E0F7030069857D2E4169EE7', firstSeenAt: 0, lastUsedAt: 0 }], email: null };
  const usersOn = () => {
    routes['/api/me'] = { body: { ...ME, features: { users: true } } };
    routes['/api/orgs/org_a'] = { body: org('viewer') };
  };

  it('shows the User ID, the Support ID, account kinds and wallets; an unshared email as "Not shared"; nothing else', async () => {
    usersOn();
    routes['/api/orgs/org_a/users'] = { body: { users: [USER] } };
    at('/orgs/org_a/users');
    expect(await screen.findByText('u1_AbCdEfGhIjKlMnOpQrStUv')).toBeTruthy();
    expect(screen.getByText('HANA-ABCD-EFGH')).toBeTruthy();
    expect(screen.getByText('Google, Email (pending)')).toBeTruthy();
    expect(screen.getByText(/0x52908400098527886E0F7030069857D2E4169EE7/u)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Email' })).toBeTruthy();
    expect(screen.getByText('Not shared')).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/@(?!partner\.example)/u);
  });

  it('a shared address in the Email column; the search hint names a full email address (exact match among shared ones)', async () => {
    usersOn();
    routes['/api/orgs/org_a/users'] = { body: { users: [{ ...USER, email: 'ada@user.example' }] } };
    routes['/api/orgs/org_a/users?search=ada%40user.example'] = { body: { users: [{ ...USER, email: 'ada@user.example' }] } };
    at('/orgs/org_a/users');
    expect(await screen.findByText('ada@user.example')).toBeTruthy();
    expect(screen.queryByText('Not shared')).toBeNull();
    const box = screen.getByLabelText(/full email address/u);
    expect(screen.getByText(/matches exactly, and only among the addresses users shared with your apps/u)).toBeTruthy();
    fireEvent.change(box, { target: { value: ' ada@user.example ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/users?search=ada%40user.example')).toBe(true));
  });

  it('a user’s detail lists each app’s shared address with its date, or "Not shared"', async () => {
    usersOn();
    const sharedAt = Date.UTC(2026, 10, 2, 12);
    routes['/api/orgs/org_a/users'] = { body: { users: [{ ...USER, email: 'ada@user.example' }, { ...USER, userId: 'u1_ZyXwVuTsRqPoNmLkJiHgFA', supportId: 'HANA-ZZZZ-ZZZZ' }] } };
    routes['/api/orgs/org_a/users/u1_AbCdEfGhIjKlMnOpQrStUv'] = {
      body: { user: { ...USER, email: 'ada@user.example', emails: [{ appId: 'app_1', appName: 'Wallet', email: 'ada@user.example', sharedAt }, { appId: 'app_2', appName: 'Shop', email: 'ada@work.example', sharedAt }] } },
    };
    routes['/api/orgs/org_a/users/u1_ZyXwVuTsRqPoNmLkJiHgFA'] = { body: { user: { ...USER, userId: 'u1_ZyXwVuTsRqPoNmLkJiHgFA', supportId: 'HANA-ZZZZ-ZZZZ', emails: [] } } };
    at('/orgs/org_a/users');
    fireEvent.click(await screen.findByRole('button', { name: 'Open u1_AbCdEfGhIjKlMnOpQrStUv' }));
    const day = new Date(sharedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
    expect(await screen.findByText(`Shared with Wallet on ${day}`)).toBeTruthy();
    expect(screen.getByText(`Shared with Shop on ${day}`)).toBeTruthy();
    expect(screen.getByText('ada@work.example')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open u1_ZyXwVuTsRqPoNmLkJiHgFA' }));
    await waitFor(() => expect(screen.queryByText(/Shared with Wallet/u)).toBeNull());
    await waitFor(() => expect(screen.getAllByText('Not shared')).toHaveLength(2)); // the list row and the detail
  });
});
