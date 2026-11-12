// The partner SPA's write paths (batch C10), in happy-dom with the console's API answered at `fetch`: a fresh sign-in
// built on the server, reviewed on `/actions/:id` (an IDN origin flagged, the policy's consent preview as users see it)
// and confirmed with Google; immediate writes behind a second click; a frozen org's controls; the emailed cancel pages
// (the token from the fragment, gone from the address bar, sent only in a POST after a click; a second confirm told
// it's no longer pending); the AddClient PII warning; the email sharing setting (D411) through the settings action; the
// Users tab only when the server has it on, an email only as shared ("Not shared" otherwise), each app's in a detail.
import { validateAutoApprovePolicy } from '@hana-id/core/policy';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { policyJson } from '../../../../packages/core/test/policy-fixtures.ts';
import { nav, resetSession } from '../src/api.ts';
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

/** The app's scope as the scope route answers it; `mine`: the signed-in member is an on-chain owner. */
const scopeAnswer = (mine: boolean, owners: unknown[] = [{ kind: 'member', userId: 'usr_b', email: 'boss@partner.example', orgOwner: true }]) => ({
  scope: { id: 's1', actionNonce: 1, allowShared: true, clients: [], owners: mine ? [{ kind: 'member', userId: 'usr_a', email: 'me@partner.example', orgOwner: true }, ...owners] : owners, pending: [] },
  drift: { hasDrift: !mine, missingOnChain: mine ? [] : [{ userId: 'usr_a', email: 'me@partner.example' }], notOrgOwners: [], unknownOnChain: 0 },
  youAreOnChainOwner: mine,
});

function signedIn(role = 'owner', status = 'active', onChain = true) {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: org(role, status) };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: APP } };
  routes['/api/orgs/org_a/scopes/s1'] = { body: scopeAnswer(onChain) };
}

describe('a fresh sign-in, end to end in the SPA', () => {
  it('adding an origin: built on the server, reviewed with its IDN flag, confirmed with Google', async () => {
    signedIn();
    const assign = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    const decoded = { appId: 'app_1', appName: 'Wallet', add: [{ origin: 'https://xn--bcher-kva.example', display: 'https://bücher.example', idn: true }], remove: [] };
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_1', kind: 'origin.add', decoded, expiresAt: Date.now() + 300_000 } };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'origin.add', status: 'pending', decoded, expiresAt: Date.now() + 300_000 } };
    routes['/api/actions/act_1/google'] = { body: { startUrl: 'https://console-auth.test/start?f=xyz' } };
    at('/orgs/org_a/apps/app_1/origins');
    fireEvent.change(await screen.findByPlaceholderText('https://app.example.com'), { target: { value: 'https://bücher.example' } });
    fireEvent.click(screen.getAllByRole('button', { name: 'Review and confirm with Google' })[0]!);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_1'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'origin.add', params: { appId: 'app_1', add: ['https://bücher.example'] }, returnTo: { page: 'origins', appId: 'app_1' } });
    expect(headerOf('/api/orgs/org_a/actions', 'x-hana-console')).toBe('1');
    expect(await screen.findByText('Add origins')).toBeTruthy();
    expect(screen.getByText('IDN')).toBeTruthy();
    expect(screen.getByText('https://xn--bcher-kva.example')).toBeTruthy();
    expect(screen.getByText(/internationalised \(punycode\) name/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirm with Google' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://console-auth.test/start?f=xyz'));
  });

  it('email sharing (D411): shown as off when the API omits it; the choice cards send identityEmail in the settings action, and only when changed', async () => {
    signedIn();
    vi.spyOn(nav, 'assign').mockImplementation(() => {});
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_5', kind: 'app.settings', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/apps/app_1/sessions');
    const group = await screen.findByRole('group', { name: 'Email sharing' });
    const radios = within(group).getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([
      ['off', true],
      ['on_request', false],
      ['at_login', false],
    ]);
    // Each choice says what it does.
    expect(within(group).getByText(/when your app calls requestEmailSharing\(\)/u)).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Unsaved changes' })).toBeNull(); // nothing changed yet
    fireEvent.click(within(group).getByRole('radio', { name: /^At first login/u }));
    const submit = within(screen.getByRole('region', { name: 'Unsaved changes' })).getByRole('button', { name: 'Review and confirm with Google' });
    fireEvent.click(submit);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_5'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'app.settings', params: { appId: 'app_1', identityEmail: 'at_login' }, returnTo: { page: 'sessions', appId: 'app_1' } });
  });

  it('email sharing: the current value comes from settings.identityEmail; the review page names the change', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, settings: { ...APP.settings, identityEmail: 'on_request' } } } };
    at('/orgs/org_a/apps/app_1/sessions');
    const group = await screen.findByRole('group', { name: 'Email sharing' });
    expect((within(group).getByRole('radio', { name: /^When the app asks/u }) as HTMLInputElement).checked).toBe(true);
    cleanup();
    routes['/api/actions/act_6'] = { body: { id: 'act_6', kind: 'app.settings', status: 'pending', decoded: { appId: 'app_1', appName: 'Wallet', from: { identityEmail: 'on_request' }, changes: { identityEmail: 'off' } }, expiresAt: Date.now() + 300_000 } };
    at('/actions/act_6');
    expect(await screen.findByRole('cell', { name: 'Email sharing' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'off' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: 'when the app asks' })).toBeTruthy();
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
    at('/orgs/org_a/apps/app_1/signing');
    fireEvent.change(await screen.findByLabelText(/Policy \(JSON/u), { target: { value: JSON.stringify(policyJson()) } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and preview' }));
    expect(await screen.findByText('Allow automatic signing?')).toBeTruthy();
    expect(screen.getByText('“Swaps on Example”')).toBeTruthy();
    expect(bodyOf('/api/orgs/org_a/apps/app_1/policy/check')).toEqual({ policy: policyJson() });
    fireEvent.click(screen.getByRole('button', { name: /Propose this policy/u }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_3'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'policy.set', params: { appId: 'app_1', policy }, returnTo: { page: 'signing', appId: 'app_1' } });
  });

  it('an invalid policy shows the validator’s problems and no preview', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/policy/check'] = { status: 400, body: { error: { code: 'policy_invalid', message: 'label: required; v: must be 1' }, problems: ['label: required', 'v: must be 1'] } };
    at('/orgs/org_a/apps/app_1/signing');
    fireEvent.change(await screen.findByLabelText(/Policy \(JSON/u), { target: { value: '{"v":2}' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and preview' }));
    const alert = await screen.findByRole('alert');
    // Plain words, each problem on its own line, and the code for support.
    expect(alert.textContent).toContain('The policy has problems');
    expect(within(alert).getAllByRole('listitem').map((li) => li.textContent)).toEqual(['label: required', 'v: must be 1']);
    expect(alert.textContent).toContain('policy_invalid');
    expect(screen.queryByText('Allow automatic signing?')).toBeNull();
  });
});

describe('immediate writes', () => {
  it('a key revoke needs a second click, then posts with the CSRF header', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/keys/key_1/revoke'] = { body: {} };
    at('/orgs/org_a/apps/app_1/keys');
    fireEvent.click(await screen.findByRole('button', { name: 'Revoke' }));
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: /Revoke the last key/u }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/apps/app_1/keys/key_1/revoke')).toBe(true));
    expect(headerOf('/api/orgs/org_a/apps/app_1/keys/key_1/revoke', 'x-hana-console')).toBe('1');
  });

  it('the logo goes as a raw octet-stream body at the settings version', async () => {
    signedIn();
    routes['/api/orgs/org_a/apps/app_1/logo?expectedVersion=5'] = { body: { logoUrl: 'https://files.test/logos/app_1/x.png', version: 6 } };
    at('/orgs/org_a/apps/app_1/branding');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'logo.png', { type: 'image/png' });
    fireEvent.change(await screen.findByLabelText('Logo file'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Upload the logo' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/apps/app_1/logo?expectedVersion=5')).toBe(true));
    expect(headerOf('/api/orgs/org_a/apps/app_1/logo?expectedVersion=5', 'content-type')).toBe('application/octet-stream');
    expect(headerOf('/api/orgs/org_a/apps/app_1/logo?expectedVersion=5', 'x-hana-console')).toBe('1');
  });

  it('a frozen org: only the kill switches are offered (revoke, suspend, remove an origin), no add, no create', async () => {
    signedIn('owner', 'frozen');
    const names: (string | null)[] = [];
    for (const section of ['', '/origins', '/keys', '/sessions', '/signing', '/branding', '/suspend']) {
      at(`/orgs/org_a/apps/app_1${section}`);
      await screen.findAllByText('pk_live_abc');
      names.push(...screen.getAllByRole('button').map((b) => b.textContent));
      cleanup();
    }
    expect(names).toEqual(expect.arrayContaining(['Revoke', 'Suspend the app', 'Remove']));
    for (const n of ['Create a key', 'Rotate', 'Review and confirm with Google', 'Check and preview', 'Save the name', 'Upload the logo']) expect(names, n).not.toContain(n);
  });
});

describe('changes that need an on-chain owner of the scope (Origins, Signing)', () => {
  const sections = async (path: string) => {
    at(`/orgs/org_a/apps/app_1${path}`);
    await screen.findAllByText('pk_live_abc');
  };
  const scopeReads = () => calls.filter((c) => c.url === '/api/orgs/org_a/scopes/s1').length;

  it('an on-chain owner gets the add form, the policy editor and the raw signing switch', async () => {
    signedIn();
    await sections('/origins');
    expect(await screen.findByPlaceholderText('https://app.example.com')).toBeTruthy();
    expect(screen.queryByText(/needs an on-chain owner/u)).toBeNull();
    cleanup();
    await sections('/signing');
    expect(await screen.findByLabelText(/Policy \(JSON/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Turn raw signing on/u })).toBeTruthy();
    // One scope read for the page, shared by both panels.
    expect(scopeReads()).toBe(2);
  });

  it('an organisation owner who isn’t an on-chain owner: one line each, naming the on-chain owners and the scope page; the kill switches stay', async () => {
    signedIn('owner', 'active', false);
    routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, settings: { ...APP.settings, policy: { policyId: 'p'.repeat(64), label: 'Swaps', json: {} } } } } };
    await sections('/origins');
    const why = await screen.findByText(/Adding origins needs an on-chain owner of this app’s scope/u);
    expect(why.textContent).toContain('your Google account isn’t one (its on-chain owner is boss@partner.example)');
    expect(why.textContent).toContain('An on-chain owner can add you on the scope page');
    expect(screen.getByRole('link', { name: 'scope page' }).getAttribute('href')).toBe('/orgs/org_a/scopes/s1');
    expect(screen.queryByPlaceholderText('https://app.example.com')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Review and confirm with Google' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
    expect(screen.getByText(/An on-chain owner of the app’s scope adds|Allowed origins/u)).toBeTruthy();
    cleanup();
    await sections('/signing');
    expect(await screen.findByText(/Setting a policy needs an on-chain owner/u)).toBeTruthy();
    expect(screen.getByText(/Turning raw signing on needs an on-chain owner/u)).toBeTruthy();
    for (const absent of ['Check and preview', 'Turn raw signing on (confirm with Google)']) expect(screen.queryByRole('button', { name: absent })).toBeNull();
    expect(screen.queryByLabelText(/Policy \(JSON/u)).toBeNull();
    expect(screen.getByRole('button', { name: 'Remove the policy' })).toBeTruthy();
    // Nothing was built or sent.
    expect(calls.some((c) => c.init?.method === 'POST')).toBe(false);
  });

  it('a scope owned only by accounts outside the organisation: ask Journear', async () => {
    signedIn('owner', 'active', false);
    routes['/api/orgs/org_a/scopes/s1'] = { body: scopeAnswer(false, [{ kind: 'near', accountId: 'hana-smoke.testnet' }, { kind: 'other_google' }]) };
    await sections('/origins');
    const why = await screen.findByText(/Adding origins needs an on-chain owner/u);
    expect(why.textContent).toContain('its on-chain owners are the NEAR account hana-smoke.testnet, a Google account outside your organisation');
    expect(why.textContent).toContain('ask Journear to add you');
  });

  it('a viewer reads no scope and gets the viewer line; NEAR down shows the error with a retry, never the form', async () => {
    signedIn('viewer');
    await sections('/origins');
    expect(screen.getByText('Only owners can add or remove origins.')).toBeTruthy();
    cleanup();
    await sections('/signing');
    expect(screen.getByText('Only owners can set or remove the policy.')).toBeTruthy();
    expect(scopeReads()).toBe(0);
    cleanup();
    signedIn();
    routes['/api/orgs/org_a/scopes/s1'] = { status: 503, body: { error: { code: 'near_unavailable', message: 'NEAR RPC is unavailable: try again' } } };
    await sections('/origins');
    expect(await screen.findByRole('button', { name: /Try again|Retry/u })).toBeTruthy();
    expect(screen.queryByPlaceholderText('https://app.example.com')).toBeNull();
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
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'propose_change', change: { kind: 'AddClient', aud: '123-abc.apps.googleusercontent.com', clientProof: 'a.b.c', piiWarningAccepted: true } }, returnTo: { page: 'scope' } });
  });

  it('a waiting change: one re-read when it unlocks on the server’s clock (the reader’s 3 h slow), then Execute (D713)', async () => {
    const real = Date.now.bind(Date);
    const unlockAt = real() + 300;
    let reads = 0;
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: org() };
    routes['/api/orgs/org_a/scopes/s1'] = () => {
      reads++;
      return { body: { ...SCOPE, scope: { ...SCOPE.scope, pending: [{ id: 5, change: { kind: 'SetAllowShared', allow: true }, unlockAt, executable: real() >= unlockAt }] }, now: real() } };
    };
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 3 * 3_600_000);
    at('/orgs/org_a/scopes/s1');
    expect(await screen.findByText('Turn shared login on')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Execute' })).toBeNull();
    expect(await screen.findByRole('button', { name: 'Execute' }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Unlocked: any owner can execute it')).toBeTruthy();
    expect(reads).toBe(2);
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

  it('the list sits in the card wrapper; a wallet is shortened on screen, read out whole and copied whole', async () => {
    usersOn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const address = USER.wallets[0]!.address;
    routes['/api/orgs/org_a/users'] = { body: { users: [USER] } };
    routes['/api/orgs/org_a/users/u1_AbCdEfGhIjKlMnOpQrStUv'] = { body: { user: { ...USER, emails: [] } } };
    at('/orgs/org_a/users');
    const table = (await screen.findByRole('columnheader', { name: 'Wallets' })).closest('table')!;
    expect(table.parentElement!.classList.contains('jp-table-wrap')).toBe(true);
    const short = within(table).getByText('0x5290…9EE7');
    expect(short.getAttribute('aria-hidden')).toBe('true');
    const whole = within(table).getByText(address);
    expect(whole.className).toBe('visually-hidden');
    expect(whole.closest('code')!.getAttribute('title')).toBe(address);
    fireEvent.click(within(table).getByRole('button', { name: 'Copy EVM address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(address));
    fireEvent.click(within(table).getByRole('button', { name: 'Copy User ID' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('u1_AbCdEfGhIjKlMnOpQrStUv'));
    // The detail shows the address in full, with its own copy button.
    fireEvent.click(screen.getByRole('button', { name: 'Open u1_AbCdEfGhIjKlMnOpQrStUv' }));
    const detail = (await screen.findByRole('heading', { name: 'User' })).closest('section')!;
    await waitFor(() => expect(within(detail).getByText(address).tagName).toBe('CODE'));
    fireEvent.click(within(detail).getByRole('button', { name: 'Copy EVM address' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith(address));
    fireEvent.click(within(detail).getByRole('button', { name: 'Copy User ID' }));
    await waitFor(() => expect(writeText).toHaveBeenLastCalledWith('u1_AbCdEfGhIjKlMnOpQrStUv'));
  });

  it('a NEAR account is listed and copied like the others; a user without one says "No NEAR account yet" in the detail (D755)', async () => {
    usersOn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    const near = 'a8f3c2d17e4b9056c1d2e3f40718293a4b5c6d7e8f9012a3b4c5d6e7f8091a2b';
    const withNear = { ...USER, wallets: [...USER.wallets, { chain: 'near', address: near, firstSeenAt: 0, lastUsedAt: 0 }] };
    const other = { ...USER, userId: 'u1_ZyXwVuTsRqPoNmLkJiHgFA', supportId: 'HANA-ZZZZ-ZZZZ' };
    routes['/api/orgs/org_a/users'] = { body: { users: [withNear, other] } };
    routes['/api/orgs/org_a/users/u1_AbCdEfGhIjKlMnOpQrStUv'] = { body: { user: { ...withNear, emails: [] } } };
    routes['/api/orgs/org_a/users/u1_ZyXwVuTsRqPoNmLkJiHgFA'] = { body: { user: { ...other, emails: [] } } };
    at('/orgs/org_a/users');
    const table = (await screen.findByRole('columnheader', { name: 'Wallets' })).closest('table')!;
    expect(within(table).getByText('a8f3c2…1a2b')).toBeTruthy();
    expect(within(table).getAllByText('NEAR')).toHaveLength(1);
    // The list says nothing for the user without one (no empty NEAR row in a table cell).
    expect(within(table).queryByText('No NEAR account yet')).toBeNull();
    fireEvent.click(within(table).getByRole('button', { name: 'Copy NEAR address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(near));
    fireEvent.click(screen.getByRole('button', { name: 'Open u1_AbCdEfGhIjKlMnOpQrStUv' }));
    const detail = (await screen.findByRole('heading', { name: 'User' })).closest('section')!;
    await waitFor(() => expect(within(detail).getByText(near).tagName).toBe('CODE'));
    expect(within(detail).queryByText('No NEAR account yet')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Open u1_ZyXwVuTsRqPoNmLkJiHgFA' }));
    expect(await screen.findByText('No NEAR account yet')).toBeTruthy();
    // The search hint names a NEAR account.
    expect((screen.getByRole('searchbox') as HTMLInputElement).placeholder).toMatch(/NEAR account/u);
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
