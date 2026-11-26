// D934 (piece P12): a web address the app may use only inside its other web addresses (a widget's), in happy-dom with
// the console's API answered at `fetch`. The "Web addresses (origins)" tab keeps its name; a frame-only address shows
// its badge and the way back (remove it and add it again); an owner sets one usable anywhere to frame-only at once
// (`POST …/origins/frame-only`, after the in-page confirm, which says what it does); a viewer gets no such button; the
// add form's tick box, off by default, marks every address of its request; the waiting list, the fresh sign-in's
// review and the confirmation page say which addresses are frame-only.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { FRAME_WORDS } from '../src/frame-words.ts';

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

const H = 3_600_000;
const NOW = Date.now();
const ME = { user: { id: 'usr_a', email: 'me@coffeeclub.example' }, memberships: [{ orgId: 'org_a', orgName: 'Lumen Pay', status: 'active', role: 'owner' }], features: { users: false } };
const PAGE = 'https://coffeeclub.example';
const WIDGET = 'https://widget.lumenpay.example';
const o = (origin: string, x: Record<string, unknown> = {}) => ({ origin, display: origin, idn: false, activeFrom: 0, ...x });
const APP = {
  id: 'app_1', name: 'Coffee Club', scopeId: 's1', environment: 'test', suspendedBy: 0, deleted: false, activeOrigins: 2, pendingChanges: 0, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 5,
  origins: [o(PAGE), o(WIDGET, { frameOnly: true })],
  settings: { persistence: 'session', sessionTtlMs: 12 * H, idleTtlMs: 2 * H, googleWebClientId: null, rawSign: 'off', policy: null },
  changes: [] as unknown[],
  keys: [{ id: 'k1', prefix: 'pk_test_', key: 'pk_test_k1', createdBy: 'hana', createdAt: 0 }],
};
function signedIn(app: Record<string, unknown> = {}, role = 'owner') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Lumen Pay', status: 'active' }, role } };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: { ...APP, ...app } } };
  routes['/api/orgs/org_a/scopes/s1'] = { body: { scope: { id: 's1', actionNonce: 1, allowShared: true, clients: [], owners: [{ kind: 'member', userId: 'usr_a', email: 'me@coffeeclub.example', orgOwner: true }], pending: [] }, drift: { hasDrift: false, missingOnChain: [], notOrgOwners: [], unknownOnChain: 0 }, youAreOnChainOwner: true } };
}
const bodyOf = (url: string) => JSON.parse(String(calls.find((c) => c.url === url && c.init?.method === 'POST')!.init!.body)) as Record<string, unknown>;
const rowOf = async (text: string) => (await screen.findAllByText(text)).map((e) => e.closest('tr')).find(Boolean)!;

describe('the Web addresses (origins) tab', () => {
  it('a frame-only address: its badge and the way back, no button to set it again; the tab and heading keep their name', async () => {
    signedIn();
    at('/orgs/org_a/apps/app_1/origins');
    expect(await screen.findByRole('heading', { name: 'Web addresses (origins)' })).toBeTruthy();
    const row = await rowOf(WIDGET);
    expect(within(row).getByText(FRAME_WORDS.badge)).toBeTruthy();
    expect(within(row).getByText(FRAME_WORDS.wayBack)).toBeTruthy();
    expect(within(row).queryByRole('button', { name: FRAME_WORDS.tighten })).toBeNull();
    const plain = await rowOf(PAGE);
    expect(within(plain).queryByText(FRAME_WORDS.badge)).toBeNull();
    expect(within(plain).getByRole('button', { name: FRAME_WORDS.tighten })).toBeTruthy();
  });

  it('an owner sets an address to frame-only after the in-page confirm, which says what it does; Keep sends nothing', async () => {
    signedIn({ origins: [o(PAGE), o(WIDGET)] });
    routes['/api/orgs/org_a/apps/app_1/origins/frame-only'] = { body: { version: 4 } };
    at('/orgs/org_a/apps/app_1/origins');
    const row = await rowOf(WIDGET);
    fireEvent.click(within(row).getByRole('button', { name: FRAME_WORDS.tighten }));
    expect(within(row).getByText(FRAME_WORDS.tightenDetail(WIDGET))).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'Keep' }));
    expect(calls.some((c) => c.url.endsWith('/origins/frame-only'))).toBe(false);
    fireEvent.click(within(row).getByRole('button', { name: FRAME_WORDS.tighten }));
    fireEvent.click(within(row).getByRole('button', { name: FRAME_WORDS.tightenConfirm }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/apps/app_1/origins/frame-only')).toBe(true));
    expect(bodyOf('/api/orgs/org_a/apps/app_1/origins/frame-only')).toEqual({ origins: [WIDGET], expectedVersion: 3 });
    expect(await screen.findByText(FRAME_WORDS.tightenDone(WIDGET))).toBeTruthy();
  });

  it('never on the localhost pattern; a viewer gets no button at all', async () => {
    signedIn({ origins: [o('http://localhost:*'), o(PAGE)] });
    at('/orgs/org_a/apps/app_1/origins');
    expect(within(await rowOf('http://localhost:*')).queryByRole('button', { name: FRAME_WORDS.tighten })).toBeNull();
    cleanup();
    signedIn({}, 'viewer');
    at('/orgs/org_a/apps/app_1/origins');
    await rowOf(PAGE);
    expect(screen.queryByRole('button', { name: FRAME_WORDS.tighten })).toBeNull();
    expect(screen.getByText(FRAME_WORDS.badge)).toBeTruthy();
  });

  it('the add form: the tick box is off by default; ticked, every address of the request is sent as frame-only', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_1', kind: 'origin.add', decoded: {}, expiresAt: NOW + 300_000 } };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'origin.add', status: 'pending', decoded: { appId: 'app_1', appName: 'Coffee Club', add: [], remove: [] }, expiresAt: NOW + 300_000 } };
    at('/orgs/org_a/apps/app_1/origins');
    const box = (await screen.findByLabelText(FRAME_WORDS.tick)) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(screen.getByText(FRAME_WORDS.tickHint)).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText('https://app.example.com'), { target: { value: 'https://w2.lumenpay.example' } });
    fireEvent.click(box);
    expect(screen.getByText(`${FRAME_WORDS.tickHint} ${FRAME_WORDS.tickAll}`)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm with Google' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_1'));
    expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'origin.add', params: { appId: 'app_1', add: ['https://w2.lumenpay.example'], frameOnly: ['https://w2.lumenpay.example'] }, returnTo: { page: 'origins', appId: 'app_1' } });
  });

  it('the add form unticked sends no frame-only mark (the older action)', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_2', kind: 'origin.add', decoded: {}, expiresAt: NOW + 300_000 } };
    routes['/api/actions/act_2'] = { body: { id: 'act_2', kind: 'origin.add', status: 'pending', decoded: { appId: 'app_1', appName: 'Coffee Club', add: [], remove: [] }, expiresAt: NOW + 300_000 } };
    at('/orgs/org_a/apps/app_1/origins');
    fireEvent.change(await screen.findByPlaceholderText('https://app.example.com'), { target: { value: 'https://tea.example' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review and confirm with Google' }));
    await waitFor(() => expect(window.location.pathname).toBe('/actions/act_2'));
    expect(bodyOf('/api/orgs/org_a/actions').params).toEqual({ appId: 'app_1', add: ['https://tea.example'] });
  });

  it('the waiting list marks a frame-only add', async () => {
    const pending = { id: 'gc_8', appId: 'app_1', kind: 'origin_add', origin: 'https://w3.lumenpay.example', display: 'https://w3.lumenpay.example', idn: false, status: 'pending', proposedByKind: 'hana', proposedBy: 'hana', proposedAt: NOW - H, notifiedAt: NOW - H, activeFrom: NOW + 20 * H, frameOnly: true };
    signedIn({ origins: [...APP.origins, o('https://w3.lumenpay.example', { activeFrom: NOW + 20 * H, changeId: 'gc_8', frameOnly: true })], changes: [pending] });
    at('/orgs/org_a/apps/app_1/origins');
    const item = (await screen.findByText(/Add web address https:\/\/w3\.lumenpay\.example/u)).closest('li')!;
    expect(within(item).getByText(FRAME_WORDS.badge)).toBeTruthy();
  });
});

describe('the fresh sign-in’s review and the confirmation page', () => {
  it('the review says which adds are frame-only, and what that means', async () => {
    signedIn();
    routes['/api/actions/act_3'] = {
      body: { id: 'act_3', kind: 'origin.add', status: 'pending', decoded: { appId: 'app_1', appName: 'Coffee Club', add: [{ ...o('https://tea.example'), activeFrom: undefined }, { origin: WIDGET, display: WIDGET, idn: false, frameOnly: true }], remove: [] }, expiresAt: NOW + 300_000 },
    };
    at('/actions/act_3');
    const item = (await screen.findByText(WIDGET)).closest('li')!;
    expect(item.textContent).toBe(`Add ${WIDGET}${FRAME_WORDS.review}`);
    expect((screen.getByText('https://tea.example').closest('li')!).textContent).toBe('Add https://tea.example');
    expect(screen.getByText(FRAME_WORDS.reviewNote)).toBeTruthy();
  });

  it('a review with no frame-only add has no such note', async () => {
    signedIn();
    routes['/api/actions/act_4'] = { body: { id: 'act_4', kind: 'origin.add', status: 'pending', decoded: { appId: 'app_1', appName: 'Coffee Club', add: [{ origin: PAGE, display: PAGE, idn: false }], remove: [] }, expiresAt: NOW + 300_000 } };
    at('/actions/act_4');
    await screen.findByText(PAGE);
    expect(screen.queryByText(FRAME_WORDS.reviewNote)).toBeNull();
  });

  it('the confirmation page: a frame-only address says so, so an owner knows what they confirm', async () => {
    signedIn();
    const change = (id: string, x: Record<string, unknown> = {}) => ({ changeId: id, origin: `https://${id}.lumenpay.example`, display: `https://${id}.lumenpay.example`, idn: false, state: 'waiting', activeFrom: NOW + 23 * H, confirmable: true, ...x });
    routes['/api/orgs/org_a/confirmations/gc_1'] = {
      body: {
        confirmation: { app: { id: 'app_1', name: 'Coffee Club', scopeId: 's1', environment: 'test', sharedScope: true, otherApps: [], otherAppsTotal: 0 }, requestId: 'pf_r1', proposedByKind: 'platform', keyId: 'pkc_Kq2Lm9Xc4PzWb7', keyLabel: 'Production backend', proposedAt: NOW - H, changes: [change('gc_1', { frameOnly: true }), change('gc_2')] },
        ability: { allowed: true },
        role: 'owner',
        now: NOW,
      },
    };
    at('/orgs/org_a/apps/app_1/confirm/gc_1');
    const framed = (await screen.findByText('https://gc_1.lumenpay.example')).closest('li')!;
    expect(within(framed).getByText(FRAME_WORDS.confirm)).toBeTruthy();
    expect(within(framed).getByText(FRAME_WORDS.badge)).toBeTruthy();
    const plain = screen.getByText('https://gc_2.lumenpay.example').closest('li')!;
    expect(within(plain).queryByText(FRAME_WORDS.confirm)).toBeNull();
  });
});
