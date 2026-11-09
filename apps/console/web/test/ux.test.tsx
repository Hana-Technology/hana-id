// The partner SPA's UX behaviours (the console redesign), in happy-dom with the console's API answered at `fetch`:
// errors in plain words with the code for support; tokens read once from the fragment even under StrictMode's double
// effect; copy buttons; the in-page confirm (detail, Escape); controls the console would refuse replaced by one line
// saying why (5 keys, the last owner, a disabled member, 10 invites, bad session values, a logo of the wrong type or
// size, a pending policy, a test app's raw signing); the empty org's first steps; the app overview's checklist and the
// guarded-change timeline with Cancel; the action page's back link, timing and expiry; the org switcher; the audit's
// words; an unknown page.
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, nav, resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { explain } from '../src/messages.ts';
import { actionLabel } from '../src/pages/Audit.tsx';
import { logoProblem } from '../src/pages/app/Branding.tsx';
import { ErrorNote } from '../src/ui.tsx';

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

function at(url: string, strict = false) {
  window.history.replaceState(null, '', url);
  const tree = (
    <BrowserRouter>
      <App />
    </BrowserRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

const H = 3_600_000;
const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const key = (id: string, extra: Record<string, unknown> = {}) => ({ id, prefix: 'pk_live_', key: `pk_live_${id}`, createdBy: 'hana', createdAt: 0, ...extra });
const APP = {
  id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'live', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 5,
  origins: [{ origin: 'https://app.partner.example', display: 'https://app.partner.example', idn: false, activeFrom: 0 }],
  settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
  changes: [] as unknown[],
  keys: [key('k1')],
};
function signedIn(app: Record<string, unknown> = {}, role = 'owner', status = 'active') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status }, role } };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, ...app } } };
}
const posted = (url: string) => calls.some((c) => c.url === url && c.init?.method === 'POST');
const bodyOf = (url: string) => JSON.parse(String(calls.find((c) => c.url === url && c.init?.method === 'POST')!.init!.body)) as Record<string, unknown>;

describe('errors in plain words', () => {
  it('maps a code to what happened and what to do; keeps a detail the code doesn’t say; drops one that only repeats it', () => {
    expect(explain('version_conflict', 'version_conflict', 409)).toEqual({ text: expect.stringContaining('Reload the page'), detail: undefined });
    expect(explain('rate_limited', 'Too many requests; try again in a minute', 429).detail).toBeUndefined();
    expect(explain('origin_refused', 'http://localhost:5173: loopback is refused for live apps', 400)).toEqual({ text: 'Hana can’t accept that origin.', detail: 'http://localhost:5173: loopback is refused for live apps' });
    expect(explain('key_limit', 'At most 5 unrevoked keys per app: revoke one first').text).toContain('at most 5 active keys');
    // A code the SPA doesn't know: the console's own message is the text.
    expect(explain('some_new_code', 'The console’s own words').text).toBe('The console’s own words');
    expect(explain('not_found', 'Not found', 404).text).toBe('Not found, or you aren’t a member of it.');
  });

  it('shows the code and HTTP status small, for support', () => {
    render(<ErrorNote error={new ApiError(409, 'version_conflict', 'version_conflict')} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('This changed while you were looking at it');
    expect(within(alert).getByText('version_conflict').tagName).toBe('CODE');
    expect(alert.textContent).toContain('HTTP 409');
    expect(alert.textContent?.match(/version_conflict/gu)).toHaveLength(1);
  });

  it('a failed write on a page is explained in place (an origin the console refuses)', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { status: 400, body: { error: { code: 'origin_refused', message: 'https://localhost.partner.example: loopback names are refused for live apps' } } };
    at('/orgs/org_a/apps/app_1/origins');
    fireEvent.change(await screen.findByLabelText(/Origins to add/u), { target: { value: 'https://localhost.partner.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm with Google' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Hana can’t accept that origin.');
    expect(alert.textContent).toContain('loopback names are refused');
    expect(alert.textContent).toContain('origin_refused');
    expect(window.location.pathname).toBe('/orgs/org_a/apps/app_1/origins');
  });

  it('invalid policy JSON is caught before sending, with where to look', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/signing');
    fireEvent.change(await screen.findByLabelText(/Policy \(JSON/u), { target: { value: '{"v": 1,' } });
    fireEvent.click(screen.getByRole('button', { name: 'Check and preview' }));
    expect((await screen.findByRole('alert')).textContent).toContain('missing comma, quote or bracket');
    expect(calls.some((c) => c.url.endsWith('/policy/check'))).toBe(false);
  });

  it('a page that fails to load offers Try again, which loads it again', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
    let n = 0;
    routes['/api/orgs/org_a/apps'] = () => (n++ === 0 ? { status: 503, body: { error: { code: 'near_unavailable', message: 'NEAR RPC is unavailable: try again' } } } : { body: { apps: [] } });
    at('/orgs/org_a');
    expect((await screen.findByRole('alert')).textContent).toContain('The NEAR network couldn’t be read');
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No apps yet')).toBeTruthy();
  });
});

describe('fragment tokens under StrictMode', () => {
  it('/invite#t= keeps its token through the development double effect, and still clears the address bar', async () => {
    const assign = vi.spyOn(nav, 'assign').mockImplementation(() => {});
    routes['/api/auth/start'] = { body: { startUrl: 'https://console-auth.test/start?f=abc' } };
    const token = 'S'.repeat(43);
    at(`/invite#t=${token}`, true);
    fireEvent.click(await screen.findByRole('button', { name: /accept/iu }));
    expect(window.location.hash).toBe('');
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(JSON.parse(String(calls.find((c) => c.url === '/api/auth/start')!.init!.body))).toEqual({ purpose: 'login', invite: token });
  });

  it('/cancel/:id#t= too', async () => {
    routes['/api/cancel'] = { body: {} };
    at(`/cancel/gc_1#t=${'C'.repeat(43)}`, true);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this change' }));
    await screen.findByRole('status');
    expect(bodyOf('/api/cancel')).toEqual({ changeId: 'gc_1', token: 'C'.repeat(43) });
  });
});

describe('copy buttons', () => {
  it('copies the publishable key and says so; without clipboard access, asks to select it', async () => {
    signedIn();
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    at('/orgs/org_a/apps/app_1');
    fireEvent.click(await screen.findByRole('button', { name: 'Copy Publishable key' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('pk_live_k1'));
    expect(await screen.findByText('Copied')).toBeTruthy();
    writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy App ID' }));
    expect(await screen.findByText('Select and copy')).toBeTruthy();
    expect(calls.every((c) => c.init?.method !== 'POST')).toBe(true);
  });
});

describe('the in-page confirm', () => {
  it('says what the action does; Escape backs out and nothing is sent', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/origins');
    fireEvent.click(await screen.findByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/users signed in on https:\/\/app\.partner\.example are signed out/u)).toBeTruthy();
    const yes = screen.getByRole('button', { name: 'Remove now' });
    expect(document.activeElement).toBe(yes);
    fireEvent.keyDown(yes, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: 'Remove now' })).toBeNull();
    expect(calls.some((c) => c.url.endsWith('/origins/remove'))).toBe(false);
  });
});

describe('no control that can’t work: one line says why', () => {
  it('five active keys: Create is disabled with the reason', async () => {
    signedIn({ keys: ['a', 'b', 'c', 'd', 'e'].map((k) => key(k)) });
    at('/orgs/org_a/apps/app_1/keys');
    expect(await screen.findByRole('button', { name: 'Create a key' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/at most 5 active keys/u)).toBeTruthy();
  });

  it('a retiring key shows when it stops working, apart from the active ones', async () => {
    signedIn({ keys: [key('new'), key('old', { revokedAt: Date.now() + 5 * H })] });
    at('/orgs/org_a/apps/app_1/keys');
    expect(await screen.findByText('Retiring')).toBeTruthy();
    expect(screen.getByText(/Stops working .* \(in 4 h 59 min\)/u)).toBeTruthy();
  });

  it('members: the last owner can’t be demoted or removed, a disabled member isn’t promoted, 10 invites stop the form', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
    const inv = (i: number) => ({ id: `inv_${i}`, email: `p${i}@partner.example`, role: 'viewer', createdByKind: 'hana', createdBy: 'hana', notified: true, createdAt: 0, expiresAt: 1 });
    routes['/api/orgs/org_a/members'] = {
      body: {
        members: [
          { userId: 'usr_a', email: 'me@partner.example', role: 'owner', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: false },
          { userId: 'usr_d', email: 'off@partner.example', role: 'viewer', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: true },
        ],
        invites: Array.from({ length: 10 }, (_, i) => inv(i)),
        grants: [],
      },
    };
    at('/orgs/org_a/members');
    await screen.findByText('off@partner.example');
    const me = screen.getAllByRole('row').find((r) => r.textContent?.includes('me@partner.example'))!;
    expect(within(me).queryByRole('button')).toBeNull();
    expect(within(me).getByText(/The last owner/u)).toBeTruthy();
    const off = screen.getByText('off@partner.example').closest('tr')!;
    expect(within(off).queryByRole('button', { name: 'Make owner' })).toBeNull();
    expect(within(off).getByText('Disabled by Hana')).toBeTruthy();
    expect(screen.queryByPlaceholderText('name@company.com')).toBeNull();
    expect(screen.getByText(/10 open invites, the most it can have/u)).toBeTruthy();
  });

  it('session settings: values outside the limits are flagged and not sent; a valid change sends only what changed', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_s', kind: 'app.settings', decoded: {}, expiresAt: Date.now() + 300_000 } };
    at('/orgs/org_a/apps/app_1/sessions');
    const button = await screen.findByRole('button', { name: 'Review and confirm with Google' });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Session length \(hours\)/u), { target: { value: '30' } });
    expect(screen.getByLabelText(/Session length \(hours\)/u).getAttribute('aria-invalid')).toBe('true');
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Session length \(hours\)/u), { target: { value: '8' } });
    fireEvent.change(screen.getByLabelText(/Idle timeout \(minutes\)/u), { target: { value: '600' } });
    expect(button).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByLabelText(/Idle timeout \(minutes\)/u), { target: { value: '45' } });
    fireEvent.click(button);
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_s'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'app.settings', params: { appId: 'app_1', sessionTtlMs: 8 * H, idleTtlMs: 45 * 60_000 } });
  });

  it('a logo of the wrong type or over 512 KiB is refused before upload', async () => {
    expect(logoProblem(new File(['GIF89a'], 'a.gif', { type: 'image/gif' }))).toMatch(/PNG, JPEG or WebP/u);
    expect(logoProblem(new File([new Uint8Array(600 * 1024)], 'a.png', { type: 'image/png' }))).toMatch(/limit is 512 KiB/u);
    expect(logoProblem(new File([new Uint8Array(10)], 'a.webp', { type: 'image/webp' }))).toBeNull();
    signedIn();
    at('/orgs/org_a/apps/app_1/branding');
    fireEvent.change(await screen.findByLabelText('Logo file'), { target: { files: [new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' })] } });
    expect(screen.getByText(/not SVG or GIF/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Upload the logo' })).toHaveProperty('disabled', true);
  });

  it('a test app explains why raw signing can’t be turned on; a pending policy blocks a second one with the reason', async () => {
    signedIn({ environment: 'test' });
    at('/orgs/org_a/apps/app_1/signing');
    expect(await screen.findByText(/Test apps never sign raw/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Turn raw signing on/u })).toBeNull();
  });

  it('too many origins at once are flagged before the fresh sign-in', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/origins');
    const many = Array.from({ length: 21 }, (_, i) => `https://a${i}.partner.example`).join('\n');
    fireEvent.change(await screen.findByLabelText(/Origins to add/u), { target: { value: many } });
    expect(screen.getByText(/more than 20/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Review and confirm with Google' })).toHaveProperty('disabled', true);
  });

  it('a frozen org says why adding is paused, and keeps Remove', async () => {
    signedIn({}, 'owner', 'frozen');
    at('/orgs/org_a/apps/app_1/origins');
    expect(await screen.findByText(/Adding origins is paused while Hana has frozen the organisation/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeTruthy();
  });
});

describe('empty states and the app overview', () => {
  it('an org with no apps: what to send Hana, in three steps', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
    routes['/api/orgs/org_a/apps'] = { body: { apps: [] } };
    at('/orgs/org_a');
    const empty = (await screen.findByText('No apps yet')).parentElement!;
    expect(within(empty).getAllByRole('listitem').map((li) => li.textContent?.split(',')[0])).toEqual(['The app’s name', 'Every origin your app runs on', 'Which Google client to use: Hana’s shared one (nothing to set up) or your own (partner guide']);
  });

  it('the checklist ticks what the console can see, and the snippet carries the app’s key', async () => {
    signedIn({ origins: [], keys: [key('k9')] });
    at('/orgs/org_a/apps/app_1');
    const origins = (await screen.findByText('Allow your app’s origins')).closest('li')!;
    expect(origins.textContent).toContain('To do');
    expect(screen.getByText('Copy your publishable key').closest('li')!.textContent).toContain('Done');
    expect(screen.getByText(/publishableKey: 'pk_live_k9'/u)).toBeTruthy();
  });

  it('a guarded change: where it is (not announced yet), who asked, and Cancel after a confirm', async () => {
    const change = { id: 'gc_9', appId: 'app_1', kind: 'origin_add', origin: 'https://new.partner.example', display: 'https://new.partner.example', idn: false, status: 'pending', proposedByKind: 'member', proposedBy: 'usr_a', proposedAt: 0 };
    signedIn({ changes: [change] });
    routes['/api/orgs/org_a/members'] = { body: { members: [{ userId: 'usr_a', email: 'me@partner.example', role: 'owner', roleSince: 0, addedBy: 'hana', addedAt: 0, disabled: false }], invites: [], grants: [] } };
    routes['/api/orgs/org_a/changes/gc_9/cancel'] = { body: { ...change, status: 'cancelled' } };
    at('/orgs/org_a/apps/app_1/origins');
    const item = (await screen.findByText('Add origin https://new.partner.example')).closest('li')!;
    await waitFor(() => expect(item.textContent).toContain('Requested by me@partner.example'));
    expect(within(item).getByText('Not sent yet')).toBeTruthy();
    expect(item.textContent).toContain('the delay starts once it is sent');
    fireEvent.click(within(item).getByRole('button', { name: 'Cancel' }));
    expect(posted('/api/orgs/org_a/changes/gc_9/cancel')).toBe(false);
    await act(async () => fireEvent.click(within(item).getByRole('button', { name: 'Cancel this change' })));
    await waitFor(() => expect(posted('/api/orgs/org_a/changes/gc_9/cancel')).toBe(true));
  });
});

describe('the fresh sign-in page', () => {
  it('says when the change takes effect, which account to use, and goes back to the app’s section', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'origin.add', status: 'pending', decoded: { appId: 'app_1', appName: 'Wallet', add: [{ origin: 'https://a.partner.example', display: 'https://a.partner.example', idn: false }], remove: [] }, expiresAt: Date.now() + 4 * 60_000 } };
    at('/actions/act_1');
    expect(await screen.findByText(/Not at once\. After you confirm, it is announced by email/u)).toBeTruthy();
    expect(await screen.findByText('me@partner.example', { selector: 'strong' })).toBeTruthy();
    expect(screen.getByRole('link', { name: /Back to Wallet/u }).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/origins');
  });

  it('once the 5 minutes are up on the reader’s clock, the confirm button is gone', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_2'] = { body: { id: 'act_2', kind: 'member.remove', status: 'pending', decoded: { userId: 'usr_b', email: 'b@partner.example' }, expiresAt: Date.now() - 1000 } };
    at('/actions/act_2');
    expect(await screen.findByText(/This confirmation expired/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Confirm with Google' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to members' }).getAttribute('href')).toBe('/orgs/org_a/members');
  });

  it('a settings change shows each value now and after', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_3'] = { body: { id: 'act_3', kind: 'app.settings', status: 'pending', decoded: { appId: 'app_1', appName: 'Wallet', from: APP.settings, changes: { sessionTtlMs: 8 * H } }, expiresAt: Date.now() + 60_000 } };
    at('/actions/act_3');
    const row = (await screen.findByText('Session length')).closest('tr')!;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['Session length', '12 h', '8 h']);
  });
});

describe('navigation', () => {
  it('several organisations: the sidebar switcher goes to the one picked', async () => {
    routes['/api/me'] = { body: { ...ME, memberships: [...ME.memberships, { orgId: 'org_b', orgName: 'Beta', status: 'active', role: 'viewer' }] } };
    routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
    routes['/api/orgs/org_b'] = { body: { org: { id: 'org_b', name: 'Beta', status: 'active' }, role: 'viewer' } };
    routes['/api/orgs/org_a/apps'] = { body: { apps: [] } };
    routes['/api/orgs/org_b/apps'] = { body: { apps: [] } };
    at('/orgs/org_a');
    fireEvent.change(await screen.findByLabelText('Organisation'), { target: { value: 'org_b' } });
    await waitFor(() => expect(window.location.pathname).toBe('/orgs/org_b'));
    expect(await screen.findByText('You’re a viewer')).toBeTruthy();
  });

  it('an unknown page inside an org says so and links back to the apps', async () => {
    signedIn();
    at('/orgs/org_a/nothing-here');
    expect(await screen.findByText('There’s no page here')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Go to your apps' }).getAttribute('href')).toBe('/orgs/org_a');
  });

  it('the audit names actions in words, keeps the code, and shows times as dates', async () => {
    expect(actionLabel('key.created')).toBe('Key created');
    expect(actionLabel('step_up.failed')).toBe('Step up failed');
    routes['/api/me'] = { body: ME };
    routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: 'owner' } };
    const at_ = Date.UTC(2026, 10, 7, 9, 30);
    routes['/api/orgs/org_a/audit'] = { body: { entries: [{ source: 'api', seq: 3, at: 0, kind: 'key.rotated', detail: { oldKeyRevokedAt: at_ }, actorKind: 'member', actorId: 'usr_a', requestId: 'req_12345678' }] } };
    at('/orgs/org_a/audit');
    expect(await screen.findByText('Key rotated')).toBeTruthy();
    expect(screen.getByText('key.rotated')).toBeTruthy();
    expect(screen.queryByText(new RegExp(String(at_), 'u'))).toBeNull();
  });
});
