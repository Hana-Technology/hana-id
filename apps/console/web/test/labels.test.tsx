// D899: the Request labels tab in happy-dom, with the console's API answered at `fetch`. The list's states (live, waiting
// with its time, held for Journear's review, blocked with Journear's note, lapsed, removed, switched off), Cancel of a
// waiting change, the editor (core's own problems beside their fields as the partner types, the advanced text that
// round-trips with the form, the approval window's own preview with its three examples in light and dark), Review (the
// `labels.set` action with the document the form wrote), the refusals in plain words, "not switched on here", a viewer,
// the confirmation page's review, and partner text always as text.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseLabelDocument } from '@hana-id/core/partner-labels';
import { nav, resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { NOT_SHOWN_YET, SUGGEST_FEE, WARN_ADDRESS_BOOK, WARN_MUXED, WARN_PAYMENT_RED } from '../src/labels/Editor.tsx';
import { LABELS_WAIT, LABELS_WAIT_REVIEW } from '../src/pages/Action.tsx';
import { ENTRY_OFF, NOT_ENABLED, NOT_ENABLED_PROPOSE, ORG_OFF, REVIEW_ON } from '../src/pages/app/Labels.tsx';

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

const PASSPHRASE = 'Test SDF Network ; September 2015';
const TILL = 'GBBQI276ICJLH2KJSTVNUFO4YIGYVKQHWZMP2OKU5OHA564L3SS55TZP';
const NOW = Date.now();
const ME = { user: { id: 'usr_a', email: 'me@partner.example' }, memberships: [{ orgId: 'org_a', orgName: 'Acme', status: 'active', role: 'owner' }], features: { users: false } };
const APP = {
  id: 'app_1', name: 'Coffee Club', scopeId: 's1', environment: 'test', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 0, orgId: 'org_a', originsVersion: 3, settingsVersion: 5,
  origins: [], settings: { persistence: 'session', sessionTtlMs: 43_200_000, idleTtlMs: 1_800_000, googleWebClientId: null, rawSign: 'off', policy: null }, changes: [], keys: [],
};
const paymentDoc = (object = 'order') =>
  JSON.stringify({
    schema: 'journear-labels/1',
    context: { stellar: { networkPassphrase: PASSPHRASE } },
    metadata: { addressBook: [{ account: TILL, name: 'Coffee Club till' }] },
    display: { formats: { payment: { call: { memo: 'text', feeAtMost: '100000' }, intent: { verb: 'pay', object }, sentence: ['verb', { word: 'for' }, 'object', { field: 'memo' }], fields: [{ path: 'memo', label: 'Order', format: 'orderNumber' }] } } },
  });

const version = (o: Record<string, unknown>) => ({
  id: 'lc_x', labelId: 'pl_1', orgId: 'org_a', scopeId: 's1', environment: 'test', apps: [{ id: 'app_1', name: 'Coffee Club' }], schema: 'journear-labels/1', sha256: 'a'.repeat(64), bytes: 300,
  state: 'in_force', proposedAt: NOW - 3 * 86_400_000, notifiedAt: NOW - 2 * 86_400_000, activeFrom: NOW - 86_400_000, lapsesAt: null, reviewRequired: false, allowedAt: null, blockedAt: null, endedAt: null, endReason: null, previousId: null, off: null, served: true,
  ...o,
});
const entry = (o: Record<string, unknown>) => ({ id: 'pl_1', current: null, waiting: null, off: null, removedAt: null, recent: [], ...o });
const listOf = (entries: unknown[], o: Record<string, unknown> = {}) => ({ labelsVersion: 4, entries, enabled: true, orgOff: null, reviewRequired: false, now: NOW, ...o });

function signedIn(o: { role?: string; list?: unknown; onChain?: boolean } = {}) {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status: 'active' }, role: o.role ?? 'owner' } };
  routes['/api/orgs/org_a/apps/app_1'] = { body: { app: APP, now: NOW } };
  routes['/api/orgs/org_a/apps'] = { body: { apps: [APP, { ...APP, id: 'app_2', name: 'Coffee Club Beta' }, { ...APP, id: 'app_9', name: 'Elsewhere', scopeId: 's2' }] } };
  routes['/api/orgs/org_a/members'] = { body: { members: [], invites: [], grants: [] } };
  routes['/api/orgs/org_a/scopes/s1'] = {
    body: { scope: { id: 's1', actionNonce: 1, allowShared: true, clients: [], owners: [{ kind: 'member', userId: 'usr_a', email: 'me@partner.example', orgOwner: true }], pending: [] }, drift: { hasDrift: false, missingOnChain: [], notOrgOwners: [], unknownOnChain: 0 }, youAreOnChainOwner: o.onChain ?? true },
  };
  routes['/api/orgs/org_a/scopes/s1/labels'] = { body: o.list ?? listOf([]) };
}

const tab = async () => screen.findByText(/Request labels are your own words for your app’s requests/u);

describe('the list', () => {
  it('each state, what users see now, and Journear’s note as text', async () => {
    signedIn({
      list: listOf([
        entry({ id: 'pl_1', current: version({ id: 'lc_live', text: paymentDoc() }), waiting: version({ id: 'lc_wait', state: 'announced', activeFrom: NOW + 5 * 3_600_000, text: paymentDoc('the order') }), recent: [version({ id: 'lc_b', state: 'blocked', blockedAt: NOW - 3_600_000, blockNote: '<b>Misleading</b> about the fare' }), version({ id: 'lc_l', state: 'lapsed', endReason: 'not_reviewed', endedAt: NOW - 7_200_000 })] }),
        entry({ id: 'pl_2', waiting: version({ id: 'lc_held', labelId: 'pl_2', state: 'waiting_review', reviewRequired: true, lapsesAt: NOW + 86_400_000, text: paymentDoc() }) }),
        entry({ id: 'pl_3', off: 'entry', current: version({ id: 'lc_off', labelId: 'pl_3', served: false, text: paymentDoc() }) }),
        entry({ id: 'pl_4', removedAt: NOW - 86_400_000, recent: [version({ id: 'lc_r', labelId: 'pl_4', state: 'removed', endedAt: NOW - 86_400_000 })] }),
      ]),
    });
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    const e1 = document.querySelector('[data-entry="pl_1"]') as HTMLElement;
    await waitFor(() => expect(within(e1).getByText('Live')).toBeTruthy());
    expect(within(e1).getByText('Coffee Club says: pay for order “1042”')).toBeTruthy();
    expect(within(e1).getByText(/^Goes live /u)).toBeTruthy();
    expect(within(e1).getByText(/goes live in 4 h|goes live in 5 h/u)).toBeTruthy();
    expect(within(e1).getByText('Coffee Club says: pay for the order “1042”')).toBeTruthy();
    expect(within(e1).getByText('Blocked by Journear')).toBeTruthy();
    // Journear's note is text, never markup.
    expect(e1.textContent).toContain('Journear’s note: “<b>Misleading</b> about the fare”');
    expect(e1.querySelector('b')).toBeNull();
    expect(within(e1).getByText(/Journear didn’t allow it within 7 days/u)).toBeTruthy();
    const e2 = document.querySelector('[data-entry="pl_2"]') as HTMLElement;
    expect(within(e2).getAllByText('Held for Journear’s review').length).toBeGreaterThan(0);
    const e3 = document.querySelector('[data-entry="pl_3"]') as HTMLElement;
    expect(within(e3).getByText('Switched off by Journear')).toBeTruthy();
    expect(within(e3).getByText(ENTRY_OFF)).toBeTruthy();
    expect(screen.getByText('Removed in the last 14 days')).toBeTruthy();
    // A waiting change can't be changed again until it's cancelled.
    expect(within(e1).queryByText('Change these labels')).toBeNull();
    expect(within(e1).getByText('A change is already waiting: cancel it to propose another.')).toBeTruthy();
  });

  it('Cancel a waiting change: a second click, then at once, and the list read again', async () => {
    signedIn({ list: listOf([entry({ waiting: version({ id: 'lc_wait', state: 'announced', activeFrom: NOW + 3_600_000, text: paymentDoc() }) })]) });
    routes['/api/orgs/org_a/changes/lc_wait/cancel'] = { body: { id: 'lc_wait', state: 'cancelled' } };
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel this change' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel it now' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/changes/lc_wait/cancel' && c.init?.method === 'POST')).toBe(true));
    await waitFor(() => expect(calls.filter((c) => c.url === '/api/orgs/org_a/scopes/s1/labels').length).toBeGreaterThan(1));
  });

  it('not switched on here: said plainly; preparing and previewing stay open, proposing doesn’t', async () => {
    signedIn({ list: listOf([], { enabled: false }) });
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    expect(screen.getByText(NOT_ENABLED)).toBeTruthy();
    expect(screen.getByText(NOT_ENABLED_PROPOSE)).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'New request labels' }));
    await screen.findByText('New request labels', { selector: 'h2' });
    expect(screen.queryByRole('button', { name: 'Review the change' })).toBeNull();
    expect(screen.getAllByText(new RegExp(NOT_ENABLED_PROPOSE.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u')).length).toBeGreaterThan(0);
  });

  it('Journear’s switch and review, a viewer, and an owner who isn’t an on-chain owner', async () => {
    signedIn({ list: listOf([], { orgOff: 'org', reviewRequired: true }) });
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    expect(screen.getByText(ORG_OFF.org)).toBeTruthy();
    expect(screen.getByText(REVIEW_ON)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New request labels' })).toBeNull();
    cleanup();
    signedIn({ role: 'viewer', list: listOf([entry({ waiting: version({ id: 'lc_wait', state: 'announced', activeFrom: NOW + 3_600_000, text: paymentDoc() }) })]) });
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    expect(screen.getByText('You’re a viewer: only owners can propose, cancel or remove request labels.')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Cancel this change' })).toBeNull();
    cleanup();
    signedIn({ onChain: false });
    at('/orgs/org_a/apps/app_1/labels');
    await tab();
    expect(await screen.findByText(/Proposing or removing request labels needs an on-chain owner/u)).toBeTruthy();
  });
});

const phrase = () => screen.getByLabelText(/Your phrase/u) as HTMLInputElement;

async function newEditor() {
  at('/orgs/org_a/apps/app_1/labels/new');
  await screen.findByText('New request labels', { selector: 'h2' });
}

/** Fills the payment form: an account, a phrase, a memo. */
function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Add an account' }));
  fireEvent.change(screen.getByLabelText('Account 1'), { target: { value: TILL } });
  fireEvent.change(screen.getByLabelText(/Its name for users/u), { target: { value: 'Coffee Club till' } });
  fireEvent.change(phrase(), { target: { value: 'order' } });
  fireEvent.change(screen.getByLabelText(/^The memo/u), { target: { value: 'text' } });
}

describe('the editor', () => {
  it('a payment from the form: the warnings where they apply, core’s problems beside their fields as typed, the window’s own preview', async () => {
    signedIn();
    await newEditor();
    expect(screen.getByText(WARN_PAYMENT_RED)).toBeTruthy();
    expect(screen.getAllByText(WARN_ADDRESS_BOOK).length).toBeGreaterThan(0);
    expect(screen.getByText(WARN_MUXED)).toBeTruthy();
    expect(screen.getByText(SUGGEST_FEE)).toBeTruthy();
    // An empty payment: the parser's problem about the list of accounts, and no preview yet.
    expect(screen.getByRole('status').textContent).toMatch(/problems? to fix/u);
    fill();
    // The sentence: "for" added, then moved before the phrase by keyboard-reachable buttons.
    fireEvent.change(screen.getByLabelText('Joining word'), { target: { value: 'for' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add the word' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move “for” earlier' }));
    fireEvent.click(screen.getByRole('button', { name: 'Move “for” earlier' }));
    expect([...document.querySelectorAll('.sentence-part .part-text')].map((n) => n.textContent)).toEqual(['pay', 'for', 'order', 'the memo']);
    fireEvent.click(screen.getByRole('button', { name: 'Use 0.01 XLM' }));
    expect(screen.queryByText(SUGGEST_FEE)).toBeNull();
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No problems: ready to review.'));
    // The window's own box, with the example's memo.
    const box = await waitFor(() => {
      const b = document.querySelector('.window-preview div.partner-label');
      expect(b).not.toBeNull();
      return b as HTMLElement;
    });
    expect(box.querySelector('p.partner-says')?.textContent).toBe('Coffee Club says: pay for order 1042');
    expect(box.getAttribute('aria-label')).toBe('What Coffee Club says');
    // A claim word: core's refusal beside the phrase, the field marked, Review off, the preview gone.
    fireEvent.change(phrase(), { target: { value: 'free order' } });
    await waitFor(() => expect(phrase().getAttribute('aria-invalid')).toBe('true'));
    const described = (phrase().getAttribute('aria-describedby') ?? '').split(' ').map((id) => document.getElementById(id)?.textContent ?? '');
    expect(described.join(' ')).toMatch(/free|claim|Journear/iu);
    expect((screen.getByRole('button', { name: 'Review the change' }) as HTMLButtonElement).disabled).toBe(true);
    expect(document.querySelector('.window-preview div.partner-label')).toBeNull();
    fireEvent.change(phrase(), { target: { value: 'order' } });
    await waitFor(() => expect(phrase().getAttribute('aria-invalid')).toBeNull());
  });

  it('the preview’s examples: the amber line for a payment that doesn’t match, the red line for an unlisted account, in light and dark', async () => {
    signedIn();
    await newEditor();
    fill();
    await waitFor(() => expect(document.querySelector('.window-preview div.partner-label')).not.toBeNull());
    fireEvent.click(screen.getByLabelText('A payment that doesn’t match'));
    await waitFor(() => expect(document.querySelector('.window-preview .partner-mismatch')).not.toBeNull());
    expect(document.querySelector('.window-preview div.partner-label')).toBeNull();
    fireEvent.click(screen.getByLabelText('A payment to an account not in your list'));
    await waitFor(() => expect(document.querySelector('.window-preview .partner-not-listed')?.textContent).toContain('This isn’t one of the accounts Coffee Club has listed for payments.'));
    expect(document.querySelector('.window-frame')?.classList.contains('jp-light')).toBe(true);
    fireEvent.click(screen.getByLabelText('Dark'));
    expect(document.querySelector('.window-frame')?.classList.contains('jp-dark')).toBe(true);
  });

  it('the advanced text round-trips with the form; a text the form can’t show is said', async () => {
    signedIn();
    await newEditor();
    fill();
    fireEvent.click(screen.getByText('Advanced: the document’s text'));
    const area = screen.getByLabelText('The document (journear-labels/1)') as HTMLTextAreaElement;
    const parsed = parseLabelDocument(area.value);
    expect(parsed.ok).toBe(true);
    fireEvent.change(area, { target: { value: area.value.replace('"order"', '"booking"') } });
    expect(phrase().value).toBe('booking');
    fireEvent.change(area, { target: { value: area.value.replace('"memo": "text"', '"memo": "text", "visible": "never"') } });
    expect(screen.getByText('The form can’t show this text')).toBeTruthy();
    expect(screen.queryByLabelText(/Your phrase/u)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Start again from the form' }));
    expect(phrase().value).toBe('booking');
  });

  it('Review: the labels.set action with exactly the document the form wrote, its apps, and the tab to come back to', async () => {
    signedIn();
    routes['/api/orgs/org_a/actions'] = { body: { id: 'act_1', kind: 'labels.set', decoded: {}, expiresAt: NOW + 300_000 } };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'labels.set', status: 'pending', decoded: { apps: [{ id: 'app_1', name: 'Coffee Club' }], diff: [], preview: { formats: [] }, reviewRequired: false }, expiresAt: NOW + 300_000 } };
    await newEditor();
    fill();
    fireEvent.click(screen.getByLabelText(/Coffee Club Beta/u));
    const area = (screen.getByLabelText('The document (journear-labels/1)') as HTMLTextAreaElement).value;
    fireEvent.click(await screen.findByRole('button', { name: 'Review the change' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/api/orgs/org_a/actions')).toBe(true));
    const body = JSON.parse(String(calls.find((c) => c.url === '/api/orgs/org_a/actions')!.init!.body)) as { kind: string; params: { scopeId: string; document: string; appIds: string[] }; returnTo: unknown };
    expect(body).toEqual({ kind: 'labels.set', params: { scopeId: 's1', document: area, appIds: ['app_1', 'app_2'] }, returnTo: { page: 'labels', appId: 'app_1' } });
    await screen.findByText('Propose request labels');
  });

  it('the API’s refusals in plain words: switched off, a version conflict (Reload), the parser’s problems as a list', async () => {
    signedIn();
    const refuse = (status: number, code: string, message: string) => (routes['/api/orgs/org_a/actions'] = { status, body: { error: { code, message } } });
    await newEditor();
    fill();
    refuse(403, 'forbidden', 'Journear has switched request labels off for your organisation: ask Journear security before proposing new ones');
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }));
    expect(await screen.findByText('Journear has switched request labels off for your organisation: ask Journear security before proposing new ones.')).toBeTruthy();
    refuse(409, 'version_conflict', 'stale');
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }));
    expect(await screen.findByText(/Your request labels changed while you were working/u)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    refuse(400, 'label_invalid', 'wrong_environment at context.stellar.networkPassphrase: These apps are test apps: describe calls on the Stellar test network.; text_claim at display.formats.payment.intent.object: <i>No</i> claims.');
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }));
    const alert = await screen.findByText('Journear can’t take these labels yet:');
    const box = alert.closest('.jp-alert') as HTMLElement;
    expect(within(box).getByText('These apps are test apps: describe calls on the Stellar test network.')).toBeTruthy();
    expect(within(box).getByText('<i>No</i> claims.')).toBeTruthy();
    expect(box.querySelector('i')).toBeNull();
    refuse(409, 'conflict', 'A change of these request labels is already waiting (lc_1): cancel it first');
    fireEvent.click(screen.getByRole('button', { name: 'Review the change' }));
    expect(await screen.findByText('A change of these request labels is already waiting (lc_1): cancel it first.')).toBeTruthy();
  });

  it('a NEAR program: marked not shown to users yet, its sentences from core’s preview', async () => {
    signedIn();
    await newEditor();
    fireEvent.click(screen.getByLabelText(/A NEAR program/u));
    expect(screen.getAllByText(NOT_SHOWN_YET).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Its account'), { target: { value: 'stamp-rally.testnet' } });
    fireEvent.change(screen.getByLabelText(/Its code hash/u), { target: { value: 'GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Describe a request' }));
    fireEvent.change(screen.getByLabelText('The method’s exact name'), { target: { value: 'join' } });
    fireEvent.change(screen.getByLabelText(/^The verb/u), { target: { value: 'join' } });
    fireEvent.change(phrase(), { target: { value: 'the club' } });
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('No problems: ready to review.'));
    expect(screen.getAllByText('Coffee Club says: join the club')).toHaveLength(2); // the form's line and the preview's
    // A "no value moves" verb is refused on a request that attaches NEAR: offered as not for this request.
    fireEvent.change(screen.getByLabelText(/^The NEAR it attaches/u), { target: { value: 'atMost' } });
    fireEvent.change(screen.getByLabelText('Amount'), { target: { value: '1' } });
    // The deposit can move NEAR, so it must be shown: core says so beside the values.
    await waitFor(() => expect(document.body.textContent).toContain('The deposit can be above 0: show it as a field'));
    fireEvent.click(screen.getByRole('button', { name: 'Add a value' }));
    fireEvent.change(screen.getAllByLabelText(/Its label for users/u).at(-1)!, { target: { value: 'Fare' } });
    await waitFor(() => expect((screen.getByRole('option', { name: /^collect \(says nothing moves/u }) as HTMLOptionElement).disabled).toBe(true));
  });
});

describe('the confirmation page: the review of the change', () => {
  const decoded = (o: Record<string, unknown> = {}) => ({
    scopeId: 's1',
    apps: [{ id: 'app_1', name: 'Coffee Club' }],
    diff: [
      { key: '(contract)', change: 'same', before: 'Stellar test network, payments', after: 'Stellar test network, payments' },
      { key: 'payment', change: 'changed', before: 'Coffee Club says: pay for order “1042” · Order: 1042', after: 'Coffee Club says: pay for <script>alert(1)</script> “1042”' },
    ],
    preview: { formats: [{ key: 'payment', line: 'Coffee Club says: pay for the order “1042”', fields: [] }] },
    reviewRequired: false,
    ...o,
  });
  it('what changes against what users see now (as text), and when it goes live', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_1'] = { body: { id: 'act_1', kind: 'labels.set', status: 'pending', decoded: decoded(), expiresAt: NOW + 300_000, returnTo: '/orgs/org_a/apps/app_1/labels' } };
    vi.spyOn(nav, 'assign').mockImplementation(() => {});
    at('/actions/act_1');
    await screen.findByText('Propose request labels');
    expect(screen.getByText('Changed')).toBeTruthy();
    expect(document.body.textContent).toContain('pay for <script>alert(1)</script>');
    expect(document.querySelector('.labels-diff script')).toBeNull();
    expect(screen.getByText(LABELS_WAIT)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Not now' }).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/labels');
  });
  it('with Journear’s review on: the true sentence', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_2'] = { body: { id: 'act_2', kind: 'labels.set', status: 'pending', decoded: decoded({ reviewRequired: true }), expiresAt: NOW + 300_000 } };
    at('/actions/act_2');
    await screen.findByText('Propose request labels');
    expect(screen.getByText(LABELS_WAIT_REVIEW)).toBeTruthy();
  });
  it('a removal: at once and final; its outcome', async () => {
    routes['/api/me'] = { body: ME };
    routes['/api/actions/act_3'] = { body: { id: 'act_3', kind: 'labels.remove', status: 'ok', decoded: { apps: [{ id: 'app_1', name: 'Coffee Club' }], waiting: 'lc_1' }, expiresAt: NOW + 300_000, outcome: { status: 'ok' } } };
    at('/actions/act_3');
    await screen.findByText('Remove request labels');
    expect(document.body.textContent).toContain('The change waiting to go live is cancelled too.');
    expect(document.body.textContent).toContain('Removed: your users see the plain approval window for these requests.');
  });
});
