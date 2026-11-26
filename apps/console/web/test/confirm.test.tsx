// D931: an owner's confirmation of web addresses, in happy-dom with the console's API answered at `fetch`. The email's
// Confirm link only opens the page (GETs; a signed-out visitor is told to sign in and open the link again); the page
// shows the app, who asked and when, each web address with its state, the shared wallet's other apps and the IDN
// warning; its tick boxes start unticked, there is no "confirm all", Confirm stays off until one is ticked and builds
// the `origin.confirm` action for exactly the ticked ones; a viewer, an owner who isn't an owner of the wallet's
// settings, and the staff member who added the address read the reason and get no Confirm; the action page's words
// and outcomes; the removal link's page (preview, the button, done, its refusals; opening it never removes); the Web
// addresses tab's new lines and its "Check and confirm" entry point. The SPA's copy of the words equals console-core's.
import { CONFIRM_WORDS as CORE_WORDS } from '@hana-id/console-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { CONFIRM_WORDS, appNames, confirmedLine } from '../src/confirm-words.ts';

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
const posts = () => calls.filter((c) => c.init?.method === 'POST');
const bodyOf = (c: { init?: RequestInit }) => JSON.parse(String(c.init!.body)) as Record<string, unknown>;

function signedIn(role: 'owner' | 'viewer' = 'owner') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role } };
}

const change = (id: string, o: Record<string, unknown> = {}) => ({ changeId: id, origin: `https://${id}.partner.example`, display: `https://${id}.partner.example`, idn: false, state: 'waiting', activeFrom: NOW + 23 * H, confirmable: true, ...o });
const VIEW = (o: Record<string, unknown> = {}) => ({
  app: { id: 'app_1', name: 'Coffee Club', scopeId: 's1', environment: 'test', sharedScope: true, otherApps: ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'], otherAppsTotal: 8 },
  requestId: 'pf_r1',
  proposedByKind: 'platform',
  keyId: 'pkc_Kq2Lm9Xc4PzWb7',
  keyLabel: 'Production backend',
  proposedAt: NOW - H,
  changes: [
    change('gc_1'),
    change('gc_2', { origin: 'https://xn--caf-8la.partner.example', display: 'https://café.partner.example', idn: true }),
    change('gc_3', { state: 'in_force', activeFrom: NOW - 10 * 60_000, confirmedAt: NOW - 10 * 60_000, confirmable: false }),
    change('gc_4', { state: 'cancelled', activeFrom: null, confirmable: false }),
  ],
  ...o,
});
const PAGE = '/api/orgs/org_a/confirmations/gc_1';
const page = (ability: unknown, view: unknown = VIEW(), role = 'owner') => ({ body: { confirmation: view, ability, role, now: NOW } });

describe('the words', () => {
  it('the SPA’s copy equals console-core’s, word for word', () => {
    for (const [k, v] of Object.entries(CORE_WORDS)) {
      const mine = (CONFIRM_WORDS as Record<string, unknown>)[k];
      if (typeof v === 'function') expect((mine as (s: string) => string)('X'), k).toBe((v as (s: string) => string)('X'));
      else expect(mine, k).toBe(v);
    }
    expect(Object.keys(CONFIRM_WORDS).sort()).toEqual(Object.keys(CORE_WORDS).sort());
  });

  it('names the other apps, and how many more; the success line counts the web addresses', () => {
    expect(appNames(['A'], 1)).toBe('A');
    expect(appNames(['A', 'B', 'C'], 3)).toBe('A, B and C');
    expect(appNames(['A', 'B', 'C', 'D', 'E'], 8)).toBe('A, B, C, D, E and 3 more');
    expect(confirmedLine(1, 'Coffee Club')).toBe('Done: 1 web address works for Coffee Club now.');
    expect(confirmedLine(3, 'Coffee Club')).toBe('Done: 3 web addresses work for Coffee Club now.');
  });
});

describe('the email’s Confirm link', () => {
  it('only opens the page: it finds the organisation, then reads the page (GETs, no POST)', async () => {
    signedIn();
    routes['/api/confirmations/gc_1/org'] = { body: { orgId: 'org_a', appId: 'app_1' } };
    routes[PAGE] = page({ allowed: true });
    at('/confirm/gc_1');
    expect(await screen.findByRole('button', { name: 'Confirm' })).toBeTruthy();
    expect(window.location.pathname).toBe('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(posts()).toHaveLength(0);
  });

  it('a signed-out visitor is asked to sign in, then to open the link again', async () => {
    routes['/api/confirmations/gc_1/org'] = { status: 401, body: { error: { code: 'unauthenticated', message: 'Sign in again' } } };
    at('/confirm/gc_1');
    expect(await screen.findByRole('button', { name: 'Sign in with Google' })).toBeTruthy();
    expect(screen.getByText(/open the Confirm link in the email again/u)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('a change in none of the member’s organisations says so', async () => {
    signedIn();
    routes['/api/confirmations/gc_9/org'] = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
    at('/confirm/gc_9');
    expect(await screen.findByText(/couldn’t find these web addresses in your organisations/u)).toBeTruthy();
  });

  it('a malformed link is incomplete, and nothing is fetched for it', async () => {
    at('/confirm/not-a-change');
    expect(await screen.findByText(/This link is incomplete/u)).toBeTruthy();
    expect(calls.filter((c) => c.url.startsWith('/api/confirmations'))).toHaveLength(0);
  });
});

describe('the confirmation page', () => {
  it('shows the app, who asked and when, each web address with its state, the shared wallet and the IDN warning', async () => {
    signedIn();
    routes[PAGE] = page({ allowed: true });
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText(CONFIRM_WORDS.intro('Coffee Club'))).toBeTruthy();
    expect(screen.getByText('Your backend (platform key “Production backend”)')).toBeTruthy();
    expect(screen.getByText('This wallet is also used on Alpha, Beta, Gamma, Delta, Epsilon and 3 more.')).toBeTruthy();
    expect(screen.getAllByText(/^Starts working on .* if nobody confirms it\.$/u)).toHaveLength(2);
    expect(screen.getByText('https://café.partner.example')).toBeTruthy();
    expect(screen.getByText('https://xn--caf-8la.partner.example')).toBeTruthy();
    expect(screen.getByText(/A web address above uses international letters/u)).toBeTruthy();
    expect(screen.getByText(/^Confirmed on /u)).toBeTruthy();
    expect(screen.getByText('Cancelled')).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });

  it('one tick box per waiting web address, none ticked; no “confirm all”; Confirm off until one is ticked, then only the ticked ones are sent', async () => {
    signedIn();
    routes[PAGE] = page({ allowed: true });
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_c', kind: 'origin.confirm', decoded: {}, expiresAt: NOW + 300_000 } };
    routes['/api/actions/act_c'] = { body: { id: 'act_c', kind: 'origin.confirm', status: 'pending', decoded: { appId: 'app_1', appName: 'Coffee Club', proposedByKind: 'platform', keyLabel: 'Production backend', changes: [change('gc_2', { origin: 'https://xn--caf-8la.partner.example', display: 'https://café.partner.example', idn: true })] }, expiresAt: NOW + 300_000 } };
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    const confirm = (await screen.findByRole('button', { name: 'Confirm' })) as HTMLButtonElement;
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => !b.checked)).toBe(true);
    expect(screen.queryByText(/all/iu, { selector: 'button, label' })).toBeNull();
    expect(confirm.disabled).toBe(true);
    expect(screen.getByText(CONFIRM_WORDS.noneTicked)).toBeTruthy();
    fireEvent.click(confirm);
    expect(posts()).toHaveLength(0);
    fireEvent.click(boxes[1]!);
    expect(confirm.disabled).toBe(false);
    fireEvent.click(confirm);
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(bodyOf(posts()[0]!)).toEqual({ kind: 'origin.confirm', params: { appId: 'app_1', changeIds: ['gc_2'] }, returnTo: { page: 'origins', appId: 'app_1' } });
    expect(await screen.findByRole('heading', { name: 'Confirm web addresses' })).toBeTruthy();
    expect(window.location.pathname).toBe('/actions/act_c');
  });

  it('a viewer sees the page with the reason: no tick boxes, no Confirm, no Cancel', async () => {
    signedIn('viewer');
    routes[PAGE] = page({ allowed: false, code: 'forbidden', reason: 'Only an owner of your organisation can confirm.' }, VIEW(), 'viewer');
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText('Only an owner of your organisation can confirm.')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
    expect(screen.getByText('https://gc_1.partner.example')).toBeTruthy();
  });

  it('an owner who isn’t an owner of the wallet’s settings reads why, has no Confirm, and can still cancel', async () => {
    signedIn();
    routes[PAGE] = page({ allowed: false, code: 'not_owner', reason: CONFIRM_WORDS.onlyOwner });
    routes['/api/orgs/org_a/changes/gc_1/cancel'] = { body: { ok: true } };
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText(CONFIRM_WORDS.onlyOwner)).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
    // "Not yours? Cancel it." beside each waiting one: the Web addresses (origins) tab's cancel, a second click to do it.
    expect(screen.getAllByText(CONFIRM_WORDS.notYours)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', { name: 'Cancel' })[0]!);
    expect(posts()).toHaveLength(0);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel this web address' }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]!.url).toBe('/api/orgs/org_a/changes/gc_1/cancel');
  });

  it('a request whose email hasn’t gone out: its state and no tick box', async () => {
    signedIn();
    routes[PAGE] = page({ allowed: false, code: 'not_pending', reason: CONFIRM_WORDS.notAnnounced }, VIEW({ changes: [change('gc_1', { state: 'waiting_announcement', activeFrom: null, confirmable: false })] }));
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText('Not emailed yet')).toBeTruthy();
    expect(screen.getAllByText(CONFIRM_WORDS.notAnnounced).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });

  it('after confirming: each says so, nothing to tick; a removed one says it doesn’t work', async () => {
    signedIn();
    routes[PAGE] = page({ allowed: false, code: 'not_pending', reason: 'Nothing here is waiting to be confirmed.' }, VIEW({ changes: [change('gc_1', { state: 'in_force', confirmedAt: NOW - H, activeFrom: NOW - H, confirmable: false }), change('gc_2', { state: 'ended', confirmable: false })] }));
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText('Nothing here is waiting to be confirmed.')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText(/^Confirmed on /u)).toBeTruthy();
    expect(screen.getByText('Removed')).toBeTruthy();
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0);
  });

  it('a staff web address: asked for by Journear staff; the staff member who added it reads that a second person must confirm', async () => {
    signedIn();
    const staff = VIEW({ proposedByKind: 'hana', keyId: undefined, keyLabel: undefined, sameAsProposer: true, app: { id: 'app_1', name: 'Rewards', scopeId: 's1', environment: 'test', sharedScope: false, otherApps: [], otherAppsTotal: 0 }, changes: [change('gc_1', { confirmable: false })] });
    routes[PAGE] = page({ allowed: false, code: 'forbidden', reason: CONFIRM_WORDS.sameAsProposer }, staff);
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    expect(await screen.findByText(CONFIRM_WORDS.sameAsProposer)).toBeTruthy();
    expect(screen.getByText('Journear staff')).toBeTruthy();
    expect(screen.queryByText(/This wallet is also used on/u)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Confirm' })).toBeNull();
  });
});

describe('the action page for origin.confirm', () => {
  const decoded = { appId: 'app_1', appName: 'Coffee Club', scopeId: 's1', proposedByKind: 'platform', keyLabel: 'Production backend', changes: [change('gc_1'), change('gc_2', { origin: 'https://xn--caf-8la.partner.example', display: 'https://café.partner.example', idn: true })] };
  const action = (o: Record<string, unknown>) => ({ body: { id: 'act_c', kind: 'origin.confirm', decoded, expiresAt: NOW + 300_000, returnTo: '/orgs/org_a/apps/app_1/origins', ...o } });

  it('says what is confirmed (the app, each web address in full and decoded), and when it takes effect', async () => {
    signedIn();
    routes['/api/actions/act_c'] = action({ status: 'pending' });
    at('/actions/act_c');
    expect(await screen.findByRole('heading', { name: 'Confirm web addresses' })).toBeTruthy();
    expect(screen.getByText('Coffee Club')).toBeTruthy();
    expect(screen.getByText(/Asked for by your backend \(platform key “Production backend”\)/u)).toBeTruthy();
    expect(screen.getByText('https://gc_1.partner.example')).toBeTruthy();
    expect(screen.getByText('https://café.partner.example')).toBeTruthy();
    expect(screen.getByText('https://xn--caf-8la.partner.example')).toBeTruthy();
    expect(screen.getByText(/A web address above uses international letters/u)).toBeTruthy();
    expect(screen.getByText(/they start working as soon as you confirm/u)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Confirm with Google/u })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Not now' }).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/origins');
  });

  it('after the sign-in: “Done: 2 web addresses work for Coffee Club now.”; a refusal in plain words', async () => {
    signedIn();
    routes['/api/actions/act_c'] = action({ status: 'ok', outcome: { status: 'ok', confirmedAt: NOW, confirmed: 2 } });
    at('/actions/act_c');
    expect(await screen.findByText('Done: 2 web addresses work for Coffee Club now.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Back to Web addresses (origins)' })[0]!.getAttribute('href')).toBe('/orgs/org_a/apps/app_1/origins');
    cleanup();
    routes['/api/actions/act_c'] = action({ status: 'failed', outcome: { status: 'failed', code: 'not_owner' } });
    at('/actions/act_c');
    expect(await screen.findByText(/Only an owner of this wallet’s settings can confirm\. Nothing was confirmed\./u)).toBeTruthy();
  });
});

describe('the removal link’s page', () => {
  const token = 'B'.repeat(43);
  const PREVIEW = { changeId: 'gc_1', appName: 'Coffee Club', origin: 'https://xn--caf-8la.partner.example', display: 'https://café.partner.example', idn: true, confirmedAt: NOW - H, confirmedByKind: 'member', confirmedBy: 'boss@partner.example', until: NOW + 6 * 24 * H, removable: true };

  it('shows what it removes, removes only on the button, and then says so', async () => {
    routes['/api/remove/preview'] = { body: PREVIEW };
    routes['/api/remove'] = { body: { changeId: 'gc_1', appName: 'Coffee Club', origin: PREVIEW.origin, display: PREVIEW.display, idn: true } };
    at(`/remove/gc_1#t=${token}`);
    const button = await screen.findByRole('button', { name: CONFIRM_WORDS.removeButton });
    expect(window.location.hash).toBe('');
    expect(screen.getByText('Coffee Club')).toBeTruthy();
    expect(screen.getByText('https://café.partner.example')).toBeTruthy();
    expect(screen.getByText(/This web address uses international letters/u)).toBeTruthy();
    expect(screen.getByText(/boss@partner\.example/u)).toBeTruthy();
    expect(screen.getByText('This link works until')).toBeTruthy();
    // Opening the page only read the preview.
    expect(posts().map((c) => c.url)).toEqual(['/api/remove/preview']);
    expect(bodyOf(posts()[0]!)).toEqual({ changeId: 'gc_1', token });
    fireEvent.click(button);
    await waitFor(() => expect(posts()).toHaveLength(2));
    expect(posts()[1]!.url).toBe('/api/remove');
    expect(bodyOf(posts()[1]!)).toEqual({ changeId: 'gc_1', token });
    expect(await screen.findByText(CONFIRM_WORDS.removed)).toBeTruthy();
  });

  it('staff as the confirmer; one already removed says so, with no button', async () => {
    routes['/api/remove/preview'] = { body: { ...PREVIEW, confirmedByKind: 'hana', confirmedBy: 'Journear staff', removable: false } };
    at(`/remove/gc_1#t=${token}`);
    expect(await screen.findByText(/already removed/u)).toBeTruthy();
    expect(screen.getByText(/Journear staff/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONFIRM_WORDS.removeButton })).toBeNull();
  });

  it('a former member as the confirmer', async () => {
    routes['/api/remove/preview'] = { body: { ...PREVIEW, confirmedBy: null } };
    at(`/remove/gc_1#t=${token}`);
    expect(await screen.findByText(/a former member of your organisation/u)).toBeTruthy();
  });

  it('a link not valid or expired: an owner can remove it in the partner portal', async () => {
    routes['/api/remove/preview'] = { status: 403, body: { error: { code: 'forbidden', message: 'This link has expired' } } };
    at(`/remove/gc_1#t=${token}`);
    expect(await screen.findByText(/An owner can remove the web address in the partner portal/u)).toBeTruthy();
    expect(screen.queryByRole('button', { name: CONFIRM_WORDS.removeButton })).toBeNull();
  });

  it('removed meanwhile: the button’s refusal in plain words', async () => {
    routes['/api/remove/preview'] = { body: PREVIEW };
    routes['/api/remove'] = { status: 409, body: { error: { code: 'not_pending', message: 'x' } } };
    at(`/remove/gc_1#t=${token}`);
    fireEvent.click(await screen.findByRole('button', { name: CONFIRM_WORDS.removeButton }));
    expect(await screen.findByText(/already removed: it doesn’t work any more/u)).toBeTruthy();
  });

  it('an incomplete link sends nothing', async () => {
    at('/remove/gc_1');
    expect(await screen.findByText(/This link is incomplete/u)).toBeTruthy();
    expect(posts()).toHaveLength(0);
  });
});

describe('the Web addresses (origins) tab', () => {
  const base = { appId: 'app_1', kind: 'origin_add', idn: false, status: 'pending', proposedAt: NOW - H };
  const APP = {
    id: 'app_1', name: 'Coffee Club', scopeId: 's1', environment: 'test', suspendedBy: 0, deleted: false, activeOrigins: 2, pendingChanges: 3, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 0,
    origins: [
      { origin: 'https://menu.partner.example', display: 'https://menu.partner.example', idn: false, activeFrom: NOW - H, changeId: 'gc_m' },
      { origin: 'https://beta.partner.example', display: 'https://beta.partner.example', idn: false, activeFrom: NOW - H, changeId: 'gc_b' },
      { origin: 'https://order.partner.example', display: 'https://order.partner.example', idn: false, activeFrom: NOW + 23 * H, changeId: 'gc_o' },
      { origin: 'https://staff.partner.example', display: 'https://staff.partner.example', idn: false, activeFrom: NOW + 23 * H, changeId: 'gc_s' },
      { origin: 'https://gift.partner.example', display: 'https://gift.partner.example', idn: false, activeFrom: null, changeId: 'gc_g' },
    ],
    settings: { persistence: 'session', sessionTtlMs: 43_200_000, idleTtlMs: 1_800_000, googleWebClientId: null, rawSign: 'off', policy: null },
    changes: [
      { ...base, id: 'gc_o', origin: 'https://order.partner.example', display: 'https://order.partner.example', proposedByKind: 'platform', proposedBy: 'pkc_Kq2Lm9Xc4PzWb7', notifiedAt: NOW - H + 60_000, activeFrom: NOW + 23 * H, requestId: 'pf_1' },
      { ...base, id: 'gc_s', origin: 'https://staff.partner.example', display: 'https://staff.partner.example', proposedByKind: 'hana', proposedBy: 'hana', notifiedAt: NOW - H + 60_000, activeFrom: NOW + 23 * H, requestId: 'rq_s', secondPerson: true },
      { ...base, id: 'gc_g', origin: 'https://gift.partner.example', display: 'https://gift.partner.example', proposedByKind: 'platform', proposedBy: 'pkc_Kq2Lm9Xc4PzWb7', requestId: 'pf_2' },
      { ...base, id: 'gc_m', origin: 'https://menu.partner.example', display: 'https://menu.partner.example', status: 'active', proposedByKind: 'platform', proposedBy: 'pkc_Kq2Lm9Xc4PzWb7', notifiedAt: NOW - 2 * H, activeFrom: NOW - H, confirmedAt: NOW - H, confirmedByKind: 'member' },
      { ...base, id: 'gc_b', origin: 'https://beta.partner.example', display: 'https://beta.partner.example', status: 'active', proposedByKind: 'hana', proposedBy: 'hana', notifiedAt: NOW - 2 * H, activeFrom: NOW - H, secondPerson: true, confirmedAt: NOW - H, confirmedByKind: 'hana' },
    ],
    keys: [{ id: 'key_1', prefix: 'pk_test_', key: 'pk_test_abc', createdBy: 'hana', createdAt: 0 }],
  };

  function tab(role: 'owner' | 'viewer') {
    signedIn(role);
    routes['/api/orgs/org_a/apps/app_1'] = { body: { app: APP, now: NOW, keyLabels: { pkc_Kq2Lm9Xc4PzWb7: 'Production backend' } } };
    routes['/api/orgs/org_a/scopes/s1'] = { body: { scope: { id: 's1', actionNonce: 1, allowShared: true, clients: [], owners: [], pending: [] }, drift: { hasDrift: false, missingOnChain: [], notOrgOwners: [], unknownOnChain: 0 }, youAreOnChainOwner: true } };
    at('/orgs/org_a/apps/app_1/origins');
  }
  const item = (origin: string) => screen.getByText(`Add web address ${origin}`).closest('li')!;

  it('a waiting one says who it waits for, with “Check and confirm”; a confirmed one says when and by whom; Cancel stays', async () => {
    tab('owner');
    expect(await screen.findByText('Web addresses waiting to take effect')).toBeTruthy();
    const order = item('https://order.partner.example');
    expect(within(order).getByText(/Waiting for an owner to confirm, or starts working on /u)).toBeTruthy();
    expect(within(order).getByRole('link', { name: 'Check and confirm' }).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/confirm/gc_o');
    expect(within(order).getByRole('button', { name: 'Cancel' })).toBeTruthy();
    const staff = item('https://staff.partner.example');
    expect(within(staff).getByText(/Waiting for a second person to confirm, or starts working on /u)).toBeTruthy();
    expect(within(staff).getByRole('link', { name: 'Check and confirm' }).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/confirm/gc_s');
    // Not emailed yet: nothing to confirm, so no entry point.
    const gift = item('https://gift.partner.example');
    expect(within(gift).getByText(/Waiting for the announcement email/u)).toBeTruthy();
    expect(within(gift).queryByRole('link', { name: 'Check and confirm' })).toBeNull();
    expect(screen.getByText(/^Confirmed on .* by an owner$/u)).toBeTruthy();
    expect(screen.getByText(/^Confirmed on .* by Journear staff$/u)).toBeTruthy();
    expect(screen.queryByText(/nothing makes them start sooner/u)).toBeNull();
    expect(screen.getByText('Only confirm a web address you know belongs to this app. If one isn’t yours, cancel it.')).toBeTruthy();
  });

  it('a viewer gets “Check and confirm” too (the page says who can confirm), and no Cancel', async () => {
    tab('viewer');
    expect(await screen.findByText('Web addresses waiting to take effect')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Check and confirm' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull();
  });
});
