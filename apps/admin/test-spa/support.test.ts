// The staff SPA's Support ID lookup screen (C15's screen, D399) and its two ways in from the Users screen (C8b), run
// as the browser runs public/app.js: a fresh happy-dom window per test, the page's body from public/index.html, and the
// admin Worker's API answered at `fetch` (the routes themselves: test/support.test.ts, test/users.test.ts). What is
// checked: the ticket asked before any read, the body the screen sends, every part of SupportLookupView rendered
// (ledger unavailable said plainly, errors of request IDs, collisions with `truncated`), data put in as text only, and
// nothing in the URL. Also the Users screen itself (D410): the ticket for a search that names one user, and an opened
// user kept in memory at a fixed path (back and forward between them, nobody after a reload).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;

afterEach(closeWindow);

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
    // The sub links to the Users detail by the fixed path only (D410); nothing went into the URL.
    const subLink = [...s.main().querySelectorAll('a')].find((a) => a.textContent === '1001')!;
    expect(subLink.getAttribute('href')).toBe('/users/open');
    for (const a of s.main().querySelectorAll('a')) expect(a.getAttribute('href') ?? '').not.toContain('1001');
    expect([s.w.location.pathname, s.w.location.search, s.w.location.hash]).toEqual(['/support', '', '']);
    // Clicking it opens that identity from memory: the path stays fixed, the history entry holds a number only.
    subLink.click();
    await vi.waitFor(() => expect(s.text()).toContain('Google 1001'));
    expect([s.w.location.pathname, s.w.location.search, s.w.location.hash]).toEqual(['/users/open', '', '']);
    expect(JSON.stringify(s.w.history.state)).toMatch(/^\{"user":\d+\}$/u);
    expect(s.api().map((c) => c.path)).toEqual(['/api/support/lookup']);
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

  it('lists the user’s key exports and mainnet demo signatures (D428, D430), as text', async () => {
    const view = unboundView();
    const user = view.matches[0]!.user as Record<string, unknown>;
    user.events = [
      { kind: 'mainnet_signature', appId: 'app_1', chain: 'evm', network: '8453', address: '0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826', usdMicros: 8_000_001, at: T - 1000 },
      { kind: 'key_exported', appId: 'app_1', chain: 'stellar', network: null, address: null, usdMicros: null, at: T - 2000 },
      { kind: 'key_exported', appId: 'app_1', chain: null, network: null, address: null, usdMicros: null, at: T - 3000 },
    ];
    const s = boot('/support', () => ({ body: view }));
    await vi.waitFor(() => expect(s.text()).toContain('Support ID lookup'));
    s.field('query').value = 'HANA-2750-G5HM';
    s.field('ticket').value = 'ZD-1234';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Key exports and mainnet demo signatures'));
    const t = s.text();
    expect(t).toContain('Key exported');
    expect(t).toContain('Mainnet demo signature');
    expect(t).toContain('EVM chain 8453, about $8.01 from 0xCD2a3d9F938E13CD947Ec05AbC7FE734Df8DD826 reported by the vault');
    expect(t).toContain('Mainnet demo signature (reported by the vault)');
    expect(t).toContain('unknown (older export window)');
  });

  it('shows the route’s refusal and keeps the form', async () => {
    const s = boot('/support', () => ({ status: 400, body: { error: { code: 'bad_request', message: 'ticket: a support reference' } } }));
    await vi.waitFor(() => expect(s.form()).toBeTruthy());
    s.field('query').value = 'HANA-0000-0000';
    s.field('ticket').value = 'T-1';
    s.submit();
    // The refusal in plain words, the server's own detail, what to do, and the code (small) for support.
    await vi.waitFor(() => expect(s.text()).toContain('Check what you entered'));
    const box = s.main().querySelector('.alert.error')!;
    expect(box.getAttribute('role')).toBe('alert');
    expect(box.textContent).toContain('ticket: a support reference');
    expect(box.textContent).toContain('Fix it and try again');
    expect(box.querySelector('.code')!.textContent).toBe('Error code bad_request (HTTP 400)');
    expect(s.field('query').value).toBe('HANA-0000-0000');
  });

  it('"Wallet directory only" asks /api/users/find with the ticket (audited there, D410), and no lookup', async () => {
    const s = boot('/support', () => ({ body: { users: [staffUser(3)] } }));
    await vi.waitFor(() => expect(s.form()).toBeTruthy());
    s.field('query').value = 'HANA-2750-G5HM';
    s.field('ticket').value = 'ZD-3';
    s.button('Wallet directory only').click();
    await vi.waitFor(() => expect(s.text()).toContain('u1_AAAAAAAAAAAAAAAAAAAA3A'));
    expect(s.api().map((c) => [c.path, c.body])).toEqual([['/api/users/find', { query: 'HANA-2750-G5HM', ticket: 'ZD-3' }]]);
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

  it('a User ID still goes to /api/users/find, with the ticket (D410); its block links to the lookup by User ID with the ticket carried over, run only on "Look up"', async () => {
    const s = boot('/users', usersAnswer);
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'u1_AAAAAAAAAAAAAAAAAAAA4A';
    s.field('ticket').value = 'ZD-78';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallet directory'));
    expect(s.api().map((c) => [c.path, c.body])).toEqual([['/api/users/find', { query: 'u1_AAAAAAAAAAAAAAAAAAAA4A', ticket: 'ZD-78' }]]);
    s.button('Support ID lookup').click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/support'));
    await vi.waitFor(() => expect(s.field('query').value).toBe('u1_AAAAAAAAAAAAAAAAAAAA4A'));
    expect(s.field('ticket').value).toBe('ZD-78');
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/find']);
    s.submit();
    await vi.waitFor(() => expect(s.api().map((c) => c.path)).toEqual(['/api/users/find', '/api/support/lookup']));
    expect(s.api()[1]!.body).toEqual({ query: 'u1_AAAAAAAAAAAAAAAAAAAA4A', ticket: 'ZD-78' });
  });

  it('the detail page (opened with a ticket) offers the lookup for its wallet-directory user, the ticket filled in', async () => {
    const detail = { provider: 'google', sub: '1004', user: null, apps: [], walletUsers: [staffUser(4)], chain: [] };
    const s = boot('/users', (c) => (c.path === '/api/users/get' ? { body: detail } : usersAnswer(c)));
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'u1_AAAAAAAAAAAAAAAAAAAA4A';
    s.field('ticket').value = 'ZD-89';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallet directory'));
    [...s.main().querySelectorAll('a')].find((a) => a.textContent === '1004')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Google 1004'));
    await vi.waitFor(() => expect(s.field('ticket')).toBeTruthy());
    expect(s.field('ticket').value).toBe('ZD-89');
    s.field('ticket').value = 'ZD-90';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallets and ids'));
    s.button('Support ID lookup').click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/support'));
    await vi.waitFor(() => expect(s.field('ticket').value).toBe('ZD-90'));
    expect(s.field('query').value).toBe('u1_AAAAAAAAAAAAAAAAAAAA4A');
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/find', '/api/users/get']);
  });
});

describe('the Users screen: the ticket for a search naming one user, nobody in the URL (D410)', () => {
  const row = (provider: string, sub: string, email: string) => ({ provider, sub, email, emailVerified: true, hosted: false, unverifiedClaim: false, firstSeenMs: T - DAY, lastSeenMs: T, appCount: 1 });
  const rows = [row('google', '2001', 'ann@acme.example'), row('email', 'e1.bob', 'bob@acme.example')];
  const detailOf = (c: Call) => ({ provider: c.body!.provider, sub: c.body!.sub, user: rows.find((r) => r.sub === c.body!.sub) ?? null, apps: [], walletUsers: [staffUser(5, [identity(String(c.body!.provider), String(c.body!.sub)), identity('email', 'e1.bob', 'member')])], chain: [] });
  const answer = (c: Call): Answer => (c.path === '/api/users/get' ? { body: detailOf(c) } : { body: { users: rows, unverifiedWarning: 'x' } });

  it('a full address, a sub, an id or a wallet without a support reference reads nothing and says why; browsing needs none', async () => {
    const s = boot('/users', answer);
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    for (const [q, sub] of [['ann@acme.example', ''], ['', '2001'], ['u1_AAAAAAAAAAAAAAAAAAAA4A', ''], [`G${'A'.repeat(55)}`, ''], ['hu_00000000000000000000000001', '']]) {
      s.field('q').value = q!;
      s.field('sub').value = sub!;
      s.submit();
      await vi.waitFor(() => expect(s.text()).toContain('A support reference is required to search by User ID, internal id, wallet, sub or a full address'));
    }
    expect(s.api()).toEqual([]);
    // A part of an address browses without one; the same address in full goes with the reference.
    s.field('q').value = 'acme';
    s.field('sub').value = '';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('ann@acme.example'));
    s.field('q').value = 'ann@acme.example';
    s.field('ticket').value = 'ZD-11';
    s.submit();
    await vi.waitFor(() => expect(s.api()).toHaveLength(2));
    expect(s.api().map((c) => c.body)).toEqual([{ limit: 50, q: 'acme' }, { limit: 50, q: 'ann@acme.example', ticket: 'ZD-11' }]);
  });

  it('opens a user at the fixed path from memory; back and forward move between the users opened; the ticket asked first', async () => {
    const s = boot('/users', answer);
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'acme';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('ann@acme.example'));
    const opens = [...s.main().querySelectorAll('a')].filter((a) => a.textContent === 'Open');
    expect(opens.map((a) => a.getAttribute('href'))).toEqual(['/users/open', '/users/open']);
    opens[0]!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Google 2001'));
    expect([s.w.location.pathname, s.w.location.search, s.w.location.hash]).toEqual(['/users/open', '', '']);
    expect(JSON.stringify(s.w.history.state)).not.toMatch(/2001|google|acme/u);
    // Nothing is read until the support reference is given.
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/search']);
    s.field('ticket').value = 'ZD-12';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallets and ids'));
    expect(s.api()[1]).toMatchObject({ path: '/api/users/get', body: { provider: 'google', sub: '2001', ticket: 'ZD-12' } });
    // A member's link opens the second user, still at the fixed path.
    [...s.main().querySelectorAll('a')].find((a) => a.textContent === 'e1.bob')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Email e1.bob'));
    expect(s.w.location.pathname).toBe('/users/open');
    expect(s.field('ticket').value).toBe('ZD-12');
    // Back: the first user again (its page, unread until opened again); forward: the second.
    s.w.history.back();
    await vi.waitFor(() => expect(s.text()).toContain('Google 2001'));
    s.w.history.forward();
    await vi.waitFor(() => expect(s.text()).toContain('Email e1.bob'));
    // Back twice: the search.
    s.w.history.back();
    await vi.waitFor(() => expect(s.text()).toContain('Google 2001'));
    s.w.history.back();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/users'));
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    expect(s.api().map((c) => c.path)).toEqual(['/api/users/search', '/api/users/get']);
  });

  it('a reload of the fixed path opens nobody; the old /users/<provider>/<sub> path is rewritten to the search, nothing read', async () => {
    const s = boot('/users/open', answer);
    await vi.waitFor(() => expect(s.text()).toContain('No user open'));
    expect(s.api()).toEqual([]);
    const t = boot('/users/google/1004', answer);
    await vi.waitFor(() => expect(t.field('q')).toBeTruthy());
    expect([t.w.location.pathname, t.w.location.search]).toEqual(['/users', '']);
    expect(t.text()).not.toContain('1004');
    expect(t.api()).toEqual([]);
  });
});
