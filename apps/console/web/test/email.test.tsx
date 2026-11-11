// The app's Email login page (build plan batch 9, D444, D447) in the SPA, in happy-dom with the API answered at `fetch`:
// each state's controls, the turning-on steps as server actions, the in-page confirmation for turning it off, and every
// control that can't work replaced by a line saying why (a viewer, a frozen org, not an on-chain owner, no issuer); the
// one re-read at the unlock time on the server's clock (D713); each fresh sign-in's way back to the page that started
// it, and a hostile return value ignored (D711).
import { cleanup, fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { clockTime } from '../src/lib.tsx';
import { useReloadAt } from '../src/pages/Apps.tsx';

const H = 3_600_000;

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
    // The scope's id is not a fact row of this page; step 2 names it once, saying what it is, and links the scope.
    expect(screen.queryByText('Scope')).toBeNull();
    const step2 = screen.getByText('Add the scope’s email client on chain').closest('li')!;
    expect(step2.textContent).toContain('as the client email:s1 (s1 is your scope’s ID)');
    expect(step2.textContent).toContain('(the apps that share each user’s wallet)');
    expect(within(step2).getByRole('link', { name: 'scope' }).getAttribute('href')).toBe('/orgs/org_a/scopes/s1');
    expect(within(step2).getByText('Do step 1 first.')).toBeTruthy();
    expect(screen.getByRole('cell', { name: '40' })).toBeTruthy();
    expect(screen.getByText('5.0%')).toBeTruthy();
    fireEvent.click(screen.getAllByRole('button', { name: /Review and confirm with Google/u })[0]!);
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'app.settings', params: { appId: 'app_1', loginMethods: 'google,email' }, returnTo: { page: 'email', appId: 'app_1' } }));
  });

  it('email on, no client yet: an on-chain owner proposes it; someone else is told why', async () => {
    signedIn({ ...base, emailOn: true, scope: owner });
    at(PAGE);
    await screen.findByText('One step left');
    fireEvent.click(await screen.findByRole('button', { name: /Review and confirm with Google/u }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'propose_change', change: { kind: 'AddEmailClient' } }, returnTo: { page: 'email', appId: 'app_1' } }));
    cleanup();
    signedIn({ ...base, emailOn: true, scope: { ...owner, youAreOnChainOwner: false } });
    at(PAGE);
    await screen.findByText(/Only an on-chain owner of the scope can propose this, and your Google account isn’t one/u);
    expect(screen.queryByRole('button', { name: /Review and confirm/u })).toBeNull();
  });

  it('a pending change says from when it can be executed; once executable an owner executes it', async () => {
    const unlockAt = Date.now() + 3 * 3_600_000;
    signedIn({ ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt, executable: false } } });
    at(PAGE);
    await screen.findByText('Waiting for the chain');
    expect(await screen.findByText(`You can execute this from ${clockTime(unlockAt, Date.now())}.`)).toBeTruthy();
    expect(clockTime(unlockAt, Date.now())).toMatch(/^\d{2}:\d{2}( on .+)?$/u);
    expect(screen.queryByRole('button', { name: /Execute the change/u })).toBeNull();
    cleanup();
    routes['/api/orgs/org_a/scopes/s1/execute'] = { body: { status: 'ok', nearTx: 'abc' } };
    signedIn({ ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt: Date.now() - 1000, executable: true } } });
    at(PAGE);
    expect(await screen.findByText('Ready to execute')).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: /Execute the change/u }));
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/scopes/s1/execute')).toEqual({ changeId: 12 }));
    cleanup();
    // A viewer is told why there is no button.
    signedIn({ ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt: Date.now() - 1000, executable: true } } }, 'viewer');
    at(PAGE);
    expect(await screen.findByText('Only owners can execute the change.')).toBeTruthy();
  });

  it('waiting: one re-read at the unlock time on the server’s clock (the reader’s 3 h slow), then Execute; no polling', async () => {
    const real = Date.now.bind(Date);
    const serverT = real();
    const unlockAt = serverT + 300;
    let reads = 0;
    signedIn({});
    routes[API] = () => {
      reads++;
      return { body: { ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt, executable: real() >= unlockAt } }, now: real() } };
    };
    vi.spyOn(Date, 'now').mockImplementation(() => real() - 3 * H);
    at(PAGE);
    expect(await screen.findByText('Waiting for the chain')).toBeTruthy();
    // The time is the unlock instant (the reader's clock being off doesn't move it), and "today" is the server's.
    expect(screen.getByText(`You can execute this from ${clockTime(unlockAt, serverT)}.`)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Execute the change' })).toBeNull();
    // On the reader's clock the unlock is 3 h away; on the server's it is 0.3 s: re-read once about 1 s after it.
    expect(await screen.findByRole('button', { name: 'Execute the change' }, { timeout: 4000 })).toBeTruthy();
    expect(screen.getByText('Ready to execute')).toBeTruthy();
    expect(reads).toBe(1 + 1);
    await new Promise((r) => setTimeout(r, 1500));
    expect(reads).toBe(2);
  });

  it('Execute only on the server’s word: an unlock time already past with `executable: false` offers nothing, and sets no re-read loop', async () => {
    let reads = 0;
    signedIn({});
    routes[API] = () => {
      reads++;
      return { body: { ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt: Date.now() - 60_000, executable: false } }, now: Date.now() } };
    };
    at(PAGE);
    expect(await screen.findByText('Waiting for the chain')).toBeTruthy();
    expect(screen.queryByText('Ready to execute')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Execute the change' })).toBeNull();
    await new Promise((r) => setTimeout(r, 1500));
    expect(reads).toBe(1);
    expect(screen.queryByRole('button', { name: 'Execute the change' })).toBeNull();
  });

  it('after Execute, the line says what changed: this app’s users when its email login is on, else the scope only and step 1 still to do', async () => {
    routes['/api/orgs/org_a/scopes/s1/execute'] = { body: { status: 'ok', nearTx: 'abc' } };
    const ready = { ...owner, pending: { changeId: 12, unlockAt: Date.now() - 1000, executable: true } };
    signedIn({ ...base, emailOn: true, scope: ready });
    at(PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Execute the change' }));
    expect(await screen.findByText('Executed: users of this app can now sign in with email.')).toBeTruthy();
    cleanup();
    // Another app of the scope proposed it, or this app turned email off while it waited.
    signedIn({ ...base, emailOn: false, scope: ready });
    at(PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Execute the change' }));
    expect(await screen.findByText('Executed: the scope now accepts email sign-in. This app still needs step 1 before its users are offered email.')).toBeTruthy();
    expect(screen.queryByText(/users of this app can now sign in/u)).toBeNull();
  });

  it('the unlock timer and the visibility listener go with the page: nothing re-reads after unmount', () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    try {
      const reload = vi.fn();
      const added = vi.spyOn(document, 'addEventListener');
      const removed = vi.spyOn(document, 'removeEventListener');
      const at0 = Date.now() + 60_000;
      const h = renderHook(() => useReloadAt(at0, reload, 0));
      const listener = added.mock.calls.find((c) => c[0] === 'visibilitychange')![1];
      h.unmount();
      expect(removed.mock.calls.some((c) => c[0] === 'visibilitychange' && c[1] === listener)).toBe(true);
      vi.advanceTimersByTime(2 * 60_000);
      document.dispatchEvent(new Event('visibilitychange'));
      expect(reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('back on a hidden tab after the unlock time, the page re-reads at once (a sleeping laptop’s timer fires late)', async () => {
    const real = Date.now.bind(Date);
    let shift = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + shift);
    const unlockAt = Date.now() + 60 * 60_000;
    let reads = 0;
    signedIn({});
    routes[API] = () => {
      reads++;
      return { body: { ...base, emailOn: true, scope: { ...owner, pending: { changeId: 12, unlockAt, executable: Date.now() >= unlockAt } }, now: Date.now() } };
    };
    at(PAGE);
    expect(await screen.findByText('Waiting for the chain')).toBeTruthy();
    // Visible again before the time: nothing is read.
    document.dispatchEvent(new Event('visibilitychange'));
    await new Promise((r) => setTimeout(r, 50));
    expect(reads).toBe(1);
    // The clock jumps past the unlock (the timer hasn't fired): visible again, read once, Execute appears.
    shift = 61 * 60_000;
    document.dispatchEvent(new Event('visibilitychange'));
    expect(await screen.findByRole('button', { name: 'Execute the change' })).toBeTruthy();
    expect(reads).toBe(2);
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
    await waitFor(() => expect(bodyOf('/api/orgs/org_a/actions')).toEqual({ kind: 'owner_action', params: { scopeId: 's1', method: 'remove_client', aud: 'email:s1' }, returnTo: { page: 'email', appId: 'app_1' } }));
    cleanup();
    signedIn({ ...base, otherAppsEmailOn: 2, emailOn: false, scope: { ...owner, clientOnChain: true } });
    at(PAGE);
    expect(await screen.findByText(/stays on the scope while another app/u)).toBeTruthy();
  });

  it('empty and unavailable numbers, an unreadable chain, a missing issuer, and an error say so', async () => {
    signedIn({ ...base, deliverability: { days: [] }, emailOn: false, scope: { unavailable: true } });
    at(PAGE);
    expect(await screen.findByText('No mail sent yet')).toBeTruthy();
    expect(screen.getByText(/couldn’t read your scope’s settings from the NEAR blockchain/u)).toBeTruthy();
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

describe('the fresh sign-in page goes back to the page that started the action (D711)', () => {
  const action = (id: string, kind: string, decoded: Record<string, unknown>, returnTo: unknown, status = 'ok') => {
    routes['/api/me'] = { body: ME };
    routes[`/api/actions/${id}`] = { body: { id, kind, status, decoded, expiresAt: Date.now() + 60_000, ...(status === 'ok' ? { outcome: { status: 'ok' } } : {}), ...(returnTo === undefined ? {} : { returnTo }) } };
    return at(`/actions/${id}`);
  };
  const backLinks = () => screen.getAllByRole('link', { name: /Back to /u }).map((l) => [l.textContent?.replace(/^\W+/u, ''), l.getAttribute('href')]);

  it('each kind to its own page; both Email login steps to the Email login tab', async () => {
    const app = { appId: 'app_1', appName: 'Wallet' };
    const cases: [string, Record<string, unknown>, string, string][] = [
      ['app.settings', app, '/orgs/org_a/apps/app_1/email', 'Back to Email login'],
      ['owner_action', { scopeId: 's1', method: 'propose_change', change: { kind: 'AddClient', provider: 'email', aud: 'email:s1' } }, '/orgs/org_a/apps/app_1/email', 'Back to Email login'],
      ['app.settings', app, '/orgs/org_a/apps/app_1/sessions', 'Back to Login & sessions'],
      ['origin.add', { ...app, add: [], remove: [] }, '/orgs/org_a/apps/app_1/origins', 'Back to Origins'],
      ['raw_sign.on', app, '/orgs/org_a/apps/app_1/signing', 'Back to Signing'],
      ['app.resume', app, '/orgs/org_a/apps/app_1/suspend', 'Back to Suspend'],
      ['owner_action', { scopeId: 's1', method: 'disable_shared_login', immediate: true }, '/orgs/org_a/scopes/s1', 'Back to the scope'],
      ['member.invite', { email: 'b@partner.example', role: 'viewer' }, '/orgs/org_a/members', 'Back to members'],
      ['org.policy', { requiredHd: null }, '/orgs/org_a/members', 'Back to members'],
    ];
    for (const [i, [kind, decoded, path, label]] of cases.entries()) {
      action(`act_r${i}`, kind, decoded, path);
      expect(await screen.findByText(/^Done\./u)).toBeTruthy();
      // The header's back link and the one under the outcome.
      expect(backLinks(), `${kind} ${path}`).toEqual([
        [label, path],
        [label, path],
      ]);
      cleanup();
    }
    // While pending, "Not now" goes there too.
    action('act_rp', 'app.settings', { ...app, from: {}, changes: { loginMethods: 'google,email' } }, '/orgs/org_a/apps/app_1/email', 'pending');
    expect((await screen.findByRole('link', { name: 'Not now' })).getAttribute('href')).toBe('/orgs/org_a/apps/app_1/email');
  });

  it('a hostile returnTo is never a link: another origin, a protocol-relative URL, a script, a path out of the console; the kind’s own page instead', async () => {
    const hostile: unknown[] = ['https://evil.example/phish', '//evil.example/x', 'javascript:alert(1)', '/orgs/org_a/../../evil', '/orgs/org_a/apps/app_1/email?next=//evil.example', '/orgs/org_a/apps/app_1/email#evil', '/orgs/org_a/apps/app_1/billing', '/\\evil.example', ' /orgs/org_a/members', 42, null];
    for (const [i, v] of hostile.entries()) {
      action(`act_h${i}`, 'app.settings', { appId: 'app_1', appName: 'Wallet' }, v);
      expect(await screen.findByText(/^Done\./u)).toBeTruthy();
      for (const l of screen.getAllByRole('link')) expect(l.getAttribute('href'), String(v)).not.toMatch(/evil|javascript|billing|\.\.|^ /u);
      expect(backLinks()[0], String(v)).toEqual(['Back to Wallet', '/orgs/org_a/apps/app_1/sessions']);
      cleanup();
    }
  });
});
