// The staff Users screen's Hana Home names (D714), run as the browser runs public/app.js: the directory list's Name
// column (`/api/users/search` attaches each row's `name`, or `namesError` when the names couldn't be read), the opened
// identity's Name fact (`/api/users/get`'s `name` / `nameError`, with or without a directory row), and the wallet
// directory's account name and per-identity names (`StaffUser.name`, `StaffIdentity.name`), in the Users screen's
// block and the Support ID lookup's. Staff see a name whatever the user shared; it is put in the page as text only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const MARKUP = '<img src=x onerror=alert(1)>';

afterEach(closeWindow);

type Name = { givenName: string | null; familyName: string | null } | null;
const row = (provider: string, sub: string, email: string, name?: Name) => ({
  provider,
  sub,
  email,
  emailVerified: true,
  hosted: false,
  unverifiedClaim: false,
  firstSeenMs: T - DAY,
  lastSeenMs: T,
  appCount: 1,
  ...(name === undefined ? {} : { name }),
});
const identity = (provider: string, sub: string | null, role: string, name: Name) => ({
  provider,
  sub,
  identityKey: 'ab'.repeat(32),
  role,
  status: 'active',
  effectiveAt: role === 'root' ? null : T - DAY,
  firstSeenAt: T - 9 * DAY,
  observedAt: T,
  directoryKey: sub === null ? null : { provider, sub },
  name,
});
const walletUser = (name: Name, identities: ReturnType<typeof identity>[]) => ({
  userId: 'u1_AAAAAAAAAAAAAAAAAAAA4A',
  supportId: 'HANA-2750-G5HM',
  internalId: `hu_${'0'.repeat(26)}`,
  scopeId: 's_scope1',
  orgId: 'org_1',
  createdAt: T - 9 * DAY,
  lastSeenAt: T,
  identities,
  name,
  wallets: [],
});

/** The page's main element, as happy-dom types it. */
type Root = ReturnType<ReturnType<typeof boot>['main']>;

/** The cells of the column headed `header` in the first table of `root` that has one. */
function column(root: Root, header: string): string[] {
  for (const t of root.querySelectorAll('table')) {
    const heads = [...t.querySelectorAll('thead th')].map((th) => th.textContent);
    const k = heads.indexOf(header);
    if (k >= 0) return [...t.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[k]?.textContent ?? '');
  }
  throw new Error(`No table has a ${header} column`);
}
/** The value of the fact `label` (a `kv` table row) in `root`. */
const fact = (root: Root, label: string): string | undefined => [...root.querySelectorAll('table.kv tr')].find((tr) => tr.querySelector('th')?.textContent === label)?.querySelector('td')?.textContent ?? undefined;

async function search(answer: (c: Call) => Answer) {
  const s = boot('/users', answer);
  await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
  s.field('q').value = 'acme';
  s.submit();
  await vi.waitFor(() => expect(s.text()).toContain('ann@acme.example'));
  return s;
}

describe('the directory list: a Name column', () => {
  it('each row’s name, a one-part name with which part it is, "not set" for none; text only', async () => {
    const users = [
      row('google', '2001', 'ann@acme.example', { givenName: 'Ann', familyName: 'Lee' }),
      row('email', 'e1.bob', 'bob@acme.example', { givenName: null, familyName: MARKUP }),
      row('google', '2003', 'cy@acme.example', { givenName: 'Cy', familyName: null }),
      row('google', '2004', 'di@acme.example', null),
    ];
    const s = await search(() => ({ body: { users, unverifiedWarning: 'x' } }));
    expect(column(s.main(), 'Name')).toEqual(['Ann Lee', `${MARKUP}last name only`, 'Cyfirst name only', 'not set']);
    expect(s.main().querySelector('img')).toBeNull();
    expect(s.text()).not.toContain('Names unavailable');
  });

  it('names unavailable (`namesError`): the list stands, said plainly, each name "unknown"', async () => {
    const users = [row('google', '2001', 'ann@acme.example'), row('email', 'e1.bob', 'bob@acme.example')];
    const s = await search(() => ({ body: { users, unverifiedWarning: 'x', namesError: 'upstream_unavailable' } }));
    expect(s.text()).toContain('Names unavailable');
    expect(s.text()).toContain('The Hana Home names couldn’t be read (upstream_unavailable)');
    expect(column(s.main(), 'Name')).toEqual(['unknown', 'unknown']);
    expect(column(s.main(), 'Email')).toEqual(['ann@acme.example', 'bob@acme.example']);
  });
});

describe('an opened identity: a Name fact', () => {
  async function open(detail: (c: Call) => Record<string, unknown>) {
    const rows = [row('google', '2001', 'ann@acme.example', { givenName: 'Ann', familyName: 'Lee' })];
    const s = await search((c) => (c.path === '/api/users/get' ? { body: detail(c) } : { body: { users: rows, unverifiedWarning: 'x' } }));
    [...s.main().querySelectorAll('a')].find((a) => a.textContent === 'Open')!.click();
    await vi.waitFor(() => expect(s.text()).toContain('Google 2001'));
    s.field('ticket').value = 'ZD-1';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Wallets and ids'));
    return s;
  }
  const base = (c: Call) => ({ provider: c.body!.provider, sub: c.body!.sub, user: row('google', '2001', 'ann@acme.example'), apps: [], walletUsers: [], chain: [] });

  it('the identity’s name beside its directory row; "not set" for none', async () => {
    let s = await open((c) => ({ ...base(c), name: { givenName: 'Ann', familyName: MARKUP } }));
    expect(fact(s.main(), 'Name')).toBe(`Ann ${MARKUP}`);
    expect(s.main().querySelector('img')).toBeNull();
    await closeWindow();
    s = await open((c) => ({ ...base(c), name: null }));
    expect(fact(s.main(), 'Name')).toBe('not set');
  });

  it('without a directory row, the name still shows (it is the API’s); none, no Name fact', async () => {
    let s = await open((c) => ({ ...base(c), user: null, name: { givenName: 'Ann', familyName: null } }));
    expect(s.text()).toContain('No directory row');
    expect(fact(s.main(), 'Name')).toBe('Annfirst name only');
    await closeWindow();
    s = await open((c) => ({ ...base(c), user: null, name: null }));
    expect(fact(s.main(), 'Name')).toBeUndefined();
  });

  it('name unavailable (`nameError`): said plainly, the rest of the page stands, the name "unknown"', async () => {
    const s = await open((c) => ({ ...base(c), nameError: 'not_read' }));
    expect(s.text()).toContain('Name unavailable');
    expect(s.text()).toContain('The Hana Home name couldn’t be read (not_read)');
    expect(fact(s.main(), 'Name')).toBe('unknown');
    expect(fact(s.main(), 'Email')).toBe('ann@acme.example');
  });
});

describe('the wallet directory’s user: the account name and each identity’s', () => {
  const user = walletUser({ givenName: 'Ann', familyName: 'Lee' }, [identity('google', '2001', 'root', { givenName: 'Ann', familyName: 'Lee' }), identity('email', 'e1.ann', 'member', null), identity('google', null, 'member', null)]);

  it('in the Users screen’s block (a find)', async () => {
    const s = boot('/users', (c) => (c.path === '/api/users/find' ? { body: { users: [user] } } : { body: { users: [], unverifiedWarning: 'x' } }));
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'u1_AAAAAAAAAAAAAAAAAAAA4A';
    s.field('ticket').value = 'ZD-2';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Sign-in identities'));
    expect(fact(s.main(), 'Name')).toBe('Ann Lee');
    expect(column(s.main(), 'Name')).toEqual(['Ann Lee', 'not set', 'not set']);
  });

  it('an API without names (no `name` fields): "unknown", never "not set"', async () => {
    const { name: _, ...older } = user;
    const ids = older.identities.map(({ name: __, ...i }) => i);
    const s = boot('/users', (c) => (c.path === '/api/users/find' ? { body: { users: [{ ...older, identities: ids }] } } : { body: { users: [], unverifiedWarning: 'x' } }));
    await vi.waitFor(() => expect(s.field('q')).toBeTruthy());
    s.field('q').value = 'u1_AAAAAAAAAAAAAAAAAAAA4A';
    s.field('ticket').value = 'ZD-3';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Sign-in identities'));
    expect(fact(s.main(), 'Name')).toBe('unknown');
    expect(column(s.main(), 'Name')).toEqual(['unknown', 'unknown', 'unknown']);
  });

  it('in the Support ID lookup’s match', async () => {
    const view = {
      query: { kind: 'supportId', code: '2750G5HM' },
      since: T - 7 * DAY,
      days: 7,
      matches: [{ user: { ...user, name: { givenName: null, familyName: MARKUP } }, apps: [], shares: [], changes: [] }],
      truncated: false,
      ledger: { available: false, reason: 'ledger unavailable' },
      activity: [null],
      requests: null,
      requestsNotFound: [],
      emails: [],
      unverifiedWarning: 'x',
    };
    const s = boot('/support', () => ({ body: view }));
    await vi.waitFor(() => expect(s.text()).toContain('Support ID lookup'));
    s.field('query').value = 'HANA-2750-G5HM';
    s.field('ticket').value = 'ZD-4';
    s.submit();
    await vi.waitFor(() => expect(s.text()).toContain('Sign-in identities'));
    expect(fact(s.main(), 'Name')).toBe(`${MARKUP}last name only`);
    expect(column(s.main(), 'Name')).toEqual(['Ann Lee', 'not set', 'not set']);
    expect(s.main().querySelector('img')).toBeNull();
  });
});
