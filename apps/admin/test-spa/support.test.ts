// The staff SPA's Support ID lookup screen (C15's screen, D399) and its two ways in from the Users screen (C8b), run
// as the browser runs public/app.js: a fresh happy-dom window per test, the page's body from public/index.html, and the
// admin Worker's API answered at `fetch` (the routes themselves: test/support.test.ts, test/users.test.ts). What is
// checked: the ticket asked before any read, the body the screen sends, every part of SupportLookupView rendered
// (ledger unavailable said plainly, errors of request IDs, collisions with `truncated`), data put in as text only, and
// nothing in the URL.
import { readFileSync } from 'node:fs';
import { Window } from 'happy-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SRC = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const BODY = /<body>([\s\S]*)<\/body>/u.exec(readFileSync(new URL('../public/index.html', import.meta.url), 'utf8'))![1]!;
const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;

interface Call {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
}
type Answer = { status?: number; body: unknown };

let win: Window | null = null;
afterEach(async () => {
  await win?.happyDOM.close();
  win = null;
});

/** The SPA at `path`, answering each API call with `answer` (GET /api/me is answered here). */
function boot(path: string, answer: (c: Call) => Answer) {
  const w = new Window({ url: `https://admin.test${path}` });
  win = w;
  w.document.body.innerHTML = BODY.replace(/<script[^>]*><\/script>/gu, '');
  const calls: Call[] = [];
  const fetch = async (p: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const c: Call = { method: init.method, path: p, headers: init.headers, ...(init.body !== undefined ? { body: JSON.parse(init.body) as Record<string, unknown> } : {}) };
    calls.push(c);
    const a = p === '/api/me' ? { body: { email: 'staff@hana.example', env: 'sandbox-dev' } } : answer(c);
    return new Response(JSON.stringify(a.body), { status: a.status ?? 200, headers: { 'content-type': 'application/json' } });
  };
  // The page's globals, from this window (the script is the same text the browser runs).
  const globals = { window: w, document: w.document, history: w.history, location: w.location, navigator: w.navigator, Node: w.Node, fetch, URL: w.URL, URLSearchParams: w.URLSearchParams, Event: w.Event };
  new Function(...Object.keys(globals), SRC)(...Object.values(globals));
  const doc = w.document;
  const main = () => doc.getElementById('app')!;
  const text = () => main().textContent ?? '';
  const form = () => main().querySelector('form')!;
  const field = (name: string) => form().querySelector(`[name="${name}"]`) as unknown as HTMLInputElement;
  const submit = () => form().dispatchEvent(new w.Event('submit', { cancelable: true }));
  const button = (label: string) => [...main().querySelectorAll('button')].find((b) => (b.textContent ?? '').startsWith(label)) as unknown as HTMLButtonElement;
  const api = () => calls.filter((c) => c.path !== '/api/me');
  return { w, doc, calls, api, main, text, form, field, submit, button };
}

const identity = (provider: string, sub: string | null, role = 'root') => ({
  provider,
  sub,
  identityKey: 'ab'.repeat(32),
  role,
  status: 'active',
  effectiveAt: role === 'root' ? null : T - DAY,
  firstSeenAt: T - 9 * DAY,
  observedAt: T,
  directoryKey: sub === null ? null : { provider, sub },
});
const staffUser = (n: number, identities = [identity('google', `100${n}`)]) => ({
  userId: `u1_${String(n).padStart(21, 'A')}A`,
  supportId: 'HANA-2750-G5HM',
  internalId: `hu_${String(n).padStart(26, '0')}`,
  scopeId: `s_scope${n}`,
  orgId: `org_${n}`,
  createdAt: T - 9 * DAY,
  lastSeenAt: T - n * 1000,
  identities,
  wallets: [{ chain: 'stellar', address: `G${'A'.repeat(55)}`, keyIndex: 0, firstSeenAt: T - 9 * DAY, lastUsedAt: T }],
});
const match = (n: number, identities?: ReturnType<typeof identity>[]) => ({
  user: staffUser(n, identities),
  apps: [{ appId: `app_${n}`, name: `Wallet App ${n}`, orgId: `org_${n}`, environment: 'test', persistence: 'session', deletedAt: null }],
  shares: [{ appId: `app_${n}`, keyIndex: 0, createdAt: T - DAY, idleUntil: T + DAY, absExpiresAt: T + 7 * DAY, revokedAt: null, live: true }],
  changes: [{ seq: 7, at: T - 2 * DAY, orgId: `org_${n}`, appId: `app_${n}`, kind: 'origins_changed', detail: { added: 1 }, actorKind: 'member', actorId: 'mem_1', requestId: 'req_change01' }],
});
const SCRIPT_EMAIL = '<img src=x onerror=alert(1)>@example.com';

/** A one-match answer with the ledger unbound (sandbox-dev today) and the email join's three outcomes. */
function unboundView() {
  return {
    query: { kind: 'supportId', code: '2750G5HM' },
    since: T - 7 * DAY,
    days: 7,
    matches: [match(1, [identity('google', '1001'), identity('email', 'e1.member', 'member'), identity('google', null, 'member')])],
    truncated: false,
    ledger: { available: false, reason: 'ledger unavailable: USAGE_DB is not bound in this environment (usage capture is off)' },
    activity: [null],
    requests: null,
    requestsNotFound: [],
    emails: [
      { provider: 'google', sub: '1001', found: true, email: SCRIPT_EMAIL, emailVerified: false, hosted: false, unverifiedClaim: true, firstSeenMs: T - DAY, lastSeenMs: T },
      { provider: 'email', sub: 'e1.member', found: false, reason: 'not_found' },
    ],
    unverifiedWarning: 'UNVERIFIED: this Google account claims the address but Google hasn’t verified it; don’t treat it as the owner',
  };
}

describe('the Support ID lookup screen', () => {
  it('asks for the support reference and reads nothing until "Look up"; then posts the body and renders every part, the ledger’s absence said plainly', async () => {
    const s = boot('/support', () => ({ body: unboundView() }));
    await vi.waitFor(() => expect(s.text()).toContain('Support ID lookup'));
    expect(s.api()).toEqual([]);
    const ticket = s.field('ticket');
    expect([ticket.required, ticket.getAttribute('pattern'), ticket.getAttribute('maxlength')]).toEqual([true, '[A-Za-z0-9._#:\\-]{1,64}', '64']);
    expect(s.field('query').required).toBe(true);
    s.field('query').value = ' HANA-2750-G5HM ';
    ticket.value = 'ZD-1234';
    s.field('days').value = '7';
    (s.form().querySelector('textarea') as unknown as HTMLTextAreaElement).value = 'req_aaaaaaaa\nreq_bbbbbbbb, req_cccccccc';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Vault shares'));
    expect(s.api()).toEqual([
      { method: 'POST', path: '/api/support/lookup', headers: expect.objectContaining({ 'x-hana-admin': '1', 'content-type': 'application/json' }), body: { query: 'HANA-2750-G5HM', ticket: 'ZD-1234', requestIds: ['req_aaaaaaaa', 'req_bbbbbbbb', 'req_cccccccc'], days: 7 } },
    ]);
    const t = s.text();
    // The ids, the identities with the directory's addresses (or why not), wallets, apps, shares and changes.
    for (const want of ['u1_AAAAAAAAAAAAAAAAAAAA1A', 'HANA-2750-G5HM', 'hu_00000000000000000000000001', 's_scope1', 'Wallet App 1', 'session', 'live', 'origins_changed', `G${'A'.repeat(55)}`]) expect(t, want).toContain(want);
    expect(t).toContain('UNVERIFIED claim');
    expect(t).toContain('UNVERIFIED: this Google account claims the address');
    expect(t).toContain('not in the directory');
    expect(t).toContain('no sub: seen on chain only');
    // The ledger's absence: once at the top with its reason, and in the activity and request-ID parts.
    expect(t).toContain('Ledger unavailable: ledger unavailable: USAGE_DB is not bound in this environment (usage capture is off). Ledger events and request-ID events are not shown');
    expect(t).toContain('Request IDs');
    expect(t.match(/Not shown: ledger unavailable: USAGE_DB/gu)).toHaveLength(2);
    // Data is text, never markup: the address shows as typed, and no element came from it.
    expect(t).toContain(SCRIPT_EMAIL);
    expect(s.main().querySelector('img')).toBeNull();
    // The sub links to the Users detail; nothing went into the URL.
    expect([...s.main().querySelectorAll('a[data-link]')].map((a) => a.getAttribute('href'))).toContain('/users/google/1001');
    expect([s.w.location.pathname, s.w.location.search, s.w.location.hash]).toEqual(['/support', '', '']);
  });

  it('with the ledger: each match’s events, the request IDs’ events with their errors, the IDs with none; a collision lists every match and the truncated flag', async () => {
    const view = {
      ...unboundView(),
      days: 30,
      matches: [match(1), match(2)],
      truncated: true,
      ledger: { available: true },
      activity: [[{ requestId: 'req_login001', at: T - 3000, appId: 'app_1', endpoint: 'login', status: 200, latencyMs: 812, relayed: true, nearTx: 'TxHash111' }], []],
      requests: [
        { requestId: 'req_failed01', at: T - 1000, orgId: 'org_1', appId: 'app_1', scopeId: 's_scope1', endpoint: 'derive', outcome: 'error', code: 'mpc_timeout', status: 503, latencyMs: 30000, relayed: false, nearTx: null, byMatch: false },
        { requestId: 'req_login001', at: T - 3000, orgId: 'org_1', appId: 'app_1', scopeId: 's_scope1', endpoint: 'login', outcome: 'ok', code: null, status: 200, latencyMs: 812, relayed: true, nearTx: 'TxHash111', byMatch: true },
      ],
      requestsNotFound: ['req_missing1', 'req_missing2'],
      emails: [],
      unverifiedWarning: undefined,
    };
    const s = boot('/support', () => ({ body: view }));
    await vi.waitFor(() => expect(s.form()).toBeTruthy());
    s.field('query').value = 'hana2750g5hm';
    s.field('ticket').value = 'T-1';
    (s.form().querySelector('textarea') as unknown as HTMLTextAreaElement).value = 'req_failed01 req_login001 req_missing1';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Matches'));
    // `days` is left out at its default.
    expect(s.api()[0]!.body).toEqual({ query: 'hana2750g5hm', ticket: 'T-1', requestIds: ['req_failed01', 'req_login001', 'req_missing1'] });
    const t = s.text();
    expect(t).toContain('2+ users share this Support ID');
    expect(t).toContain('Truncated: more users share this Support ID than are listed; only the 2 most recently seen are shown');
    expect(t).toContain('Match 1 of 2');
    expect(t).toContain('Match 2 of 2');
    expect(t).not.toContain('Ledger unavailable');
    expect(t).toContain('req_login001');
    expect(t).toContain('TxHash111');
    expect(t).toContain('mpc_timeout');
    expect(t).toContain('no user id on the event');
    expect(t).toContain('No ledger event for: req_missing1, req_missing2 (an unknown id');
    // An error outcome is badged as one.
    const badges = [...s.main().querySelectorAll('.badge.critical')].map((b) => b.textContent);
    expect(badges).toEqual(['error']);
  });

  it('shows the route’s refusal and keeps the form', async () => {
    const s = boot('/support', () => ({ status: 400, body: { error: { code: 'bad_request', message: 'ticket: a support reference' } } }));
    await vi.waitFor(() => expect(s.form()).toBeTruthy());
    s.field('query').value = 'HANA-0000-0000';
    s.field('ticket').value = 'T-1';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('bad_request: ticket: a support reference'));
    expect(s.field('query').value).toBe('HANA-0000-0000');
  });

  it('"Wallet directory only" asks /api/users/find, with no ticket and no lookup', async () => {
    const s = boot('/support', () => ({ body: { users: [staffUser(3)] } }));
    await vi.waitFor(() => expect(s.form()).toBeTruthy());
    s.field('query').value = 'HANA-2750-G5HM';
    s.button('Wallet directory only').click();
    await vi.waitFor(() => expect(s.text()).toContain('u1_AAAAAAAAAAAAAAAAAAAA3A'));
    expect(s.api().map((c) => [c.path, c.body])).toEqual([['/api/users/find', { query: 'HANA-2750-G5HM' }]]);
  });
});

describe('the Users screen’s ways into the lookup', () => {
  const usersAnswer = (c: Call): Answer => (c.path === '/api/support/lookup' ? { body: unboundView() } : c.path === '/api/users/find' ? { body: { users: [staffUser(4)] } } : { body: { users: [], unverifiedWarning: 'x' } });

  it('a Support ID searched with a support reference runs the lookup on its screen; without one it waits for it', async () => {
    const s = boot('/users', usersAnswer);
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'HANA-2750-G5HM';
    s.field('ticket').value = 'ZD-77';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Vault shares'));
    expect(s.w.location.pathname).toBe('/support');
    expect(s.w.location.search).toBe('');
    expect(s.api().map((c) => [c.path, c.body])).toEqual([['/api/support/lookup', { query: 'HANA-2750-G5HM', ticket: 'ZD-77' }]]);

    const t = boot('/users', usersAnswer);
    await vi.waitFor(() => expect(t.field('q')).toBeTruthy());
    t.field('q').value = 'hana-2750-g5hm';
    t.submit();
    await vi.waitFor(() => expect(t.text()).toContain('Support ID lookup'));
    expect(t.w.location.pathname).toBe('/support');
    expect(t.field('query').value).toBe('hana-2750-g5hm');
    expect(t.field('ticket').value).toBe('');
    expect(t.api()).toEqual([]);
  });

  it('a User ID still goes to /api/users/find; its block links to the lookup by User ID with the ticket carried over, run only on "Look up"', async () => {
    const s = boot('/users', usersAnswer);
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'u1_AAAAAAAAAAAAAAAAAAAA4A';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallet directory'));
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/find']);
    s.button('Support ID lookup').click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/support'));
    await vi.waitFor(() => expect(s.field('query').value).toBe('u1_AAAAAAAAAAAAAAAAAAAA4A'));
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/find']);
    s.field('ticket').value = 'ZD-78';
    s.submit();
    await vi.waitFor(() => expect(s.api().map((c) => c.path)).toEqual(['/api/users/find', '/api/support/lookup']));
    expect(s.api()[1]!.body).toEqual({ query: 'u1_AAAAAAAAAAAAAAAAAAAA4A', ticket: 'ZD-78' });
  });

  it('the detail page (opened with a ticket) offers the lookup for its wallet-directory user, the ticket filled in', async () => {
    const detail = { provider: 'google', sub: '1004', user: null, apps: [], walletUsers: [staffUser(4)], chain: [] };
    const s = boot('/users/google/1004', (c) => (c.path === '/api/users/get' ? { body: detail } : usersAnswer(c)));
    await vi.waitFor(() => expect(s.field('ticket')).toBeTruthy());
    s.field('ticket').value = 'ZD-90';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallets and ids'));
    s.button('Support ID lookup').click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/support'));
    await vi.waitFor(() => expect(s.field('ticket').value).toBe('ZD-90'));
    expect(s.field('query').value).toBe('u1_AAAAAAAAAAAAAAAAAAAA4A');
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/get']);
  });
});
