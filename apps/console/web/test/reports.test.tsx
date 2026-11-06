// The partner SPA's report, statement and pending-upgrades screens (C12's and C14's backends, routed by C10), in
// happy-dom with the console's API answered at `fetch`: the tabs for any member (owner, viewer, a frozen org: they are
// reads, with no write control); the usage report with the statement CSV's counts (link actions and identity tokens
// included, D324) and exact NEAR and USD; the statement list, the on-screen statement and the downloads as plain links
// to the console's routes (the ledger at the statement's as_of); the pending-upgrades page's states (nothing pending,
// a published release, "not a published release", the other pending items with countdowns, paused, due, an error);
// and no person's address on any of them (no staff address, no end user).
import { formatNear, formatUsd } from '@hana-id/console-core';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSession } from '../src/api.ts';
import { App } from '../src/App.tsx';
import { countdown } from '../src/lib.tsx';
import { usagePath } from '../src/pages/Usage.tsx';
import { formatUnits, near, usd } from '../src/units.ts';

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
function signedIn(role: 'owner' | 'viewer' = 'owner', status: 'active' | 'frozen' = 'active') {
  routes['/api/me'] = { body: ME };
  routes['/api/orgs/org_a'] = { body: { org: { id: 'org_a', name: 'Acme', status }, role } };
  routes['/api/orgs/org_a/apps'] = { body: { apps: [{ id: 'app_1', name: 'Wallet', scopeId: 's1', environment: 'live', suspendedBy: 0, deleted: false, activeOrigins: 1, pendingChanges: 0, createdAt: 0 }] } };
}
/** No address of any person on the page but the signed-in member's own (the header). */
const noPersonAddress = () => expect(document.body.textContent).not.toMatch(/@(?!partner\.example)/u);
const hrefs = () => screen.getAllByRole('link').map((a) => a.getAttribute('href'));
const writeButtons = () =>
  screen
    .queryAllByRole('button')
    .filter((b) => !b.classList.contains('btn-copy'))
    .map((b) => b.textContent)
    .filter((t) => t !== 'Sign out' && t !== 'Show' && t !== 'Try again' && t !== 'read the chain again');

const today = new Date().toISOString().slice(0, 10);
const DEFAULT_USAGE = usagePath('org_a', { from: `${today.slice(0, 7)}-01`, to: today, by: 'day', apps: [] });

const ROW = {
  orgId: 'org_a',
  appId: 'app_1',
  scopeId: 's1',
  period: '2026-01-02',
  logins: 12,
  derives: 7,
  revokes: 1,
  unlocks: 3,
  ownerActions: 0,
  linkActions: 4,
  identityTokens: 9,
  activeUsers: 5,
  newUsers: 2,
  failuresByCode: { rate_limited: 2, bad_token: 1 },
  tgas: '12.5',
  relayedRejectedTgas: '0.25',
  errorTgas: '0.1',
  burntYocto: '1250000000000000000000',
  relayedRejectedBurntYocto: '25000000000000000000',
  usdMicros: '4375',
  relayedRejectedUsdMicros: '87',
  p50: { login: 820, derive: 1400 },
  p95: { login: 1900 },
  unsettled: 1,
  afterStatement: 0,
};
const OWNER_ROW = { orgId: 'org_a', scopeId: 's1', period: '2026-01-02', logins: 0, derives: 0, revokes: 0, unlocks: 0, ownerActions: 2, newUsers: 0, failuresByCode: {}, tgas: '3', relayedRejectedTgas: '0', errorTgas: '0', burntYocto: '300000000000000000000', p50: {}, p95: {}, unsettled: 0 };

describe('the tabs: reads for any member', () => {
  for (const [role, status] of [
    ['owner', 'active'],
    ['viewer', 'active'],
    ['viewer', 'frozen'],
  ] as const) {
    it(`${role} of an ${status} org sees Usage, Statements and Pending upgrades`, async () => {
      signedIn(role, status);
      at('/orgs/org_a');
      for (const name of ['Usage', 'Statements', 'Pending upgrades']) expect(await screen.findByRole('link', { name })).toBeTruthy();
      expect(hrefs()).toEqual(expect.arrayContaining(['/orgs/org_a/usage', '/orgs/org_a/statements', '/orgs/org_a/upgrades']));
    });
  }
});

describe('exact amounts', () => {
  it('the SPA’s formatter agrees with console-core’s on NEAR and USD', () => {
    for (const v of ['0', '1', '10', '1000000', '1250000000000000000000', '1000000000000000000000000', '123456789012345678901234567', '4375', '87']) {
      expect(formatUnits(v, 24)).toBe(formatNear(v));
      expect(formatUnits(v, 6)).toBe(formatUsd(v));
    }
    expect(near(undefined)).toBe('—');
    expect(usd(undefined)).toBe('—');
    expect(formatUnits('-1', 6)).toBeNull();
    expect(formatUnits('1.5', 6)).toBeNull();
  });

  it('countdowns on the reader’s clock', () => {
    expect(countdown(1_000 + 2 * 86_400_000 + 3 * 3_600_000, 1_000)).toBe('in 2 d 3 h');
    expect(countdown(5 * 3_600_000 + 7 * 60_000, 0)).toBe('in 5 h 7 min');
    expect(countdown(30_000, 0)).toBe('in less than a minute');
    expect(countdown(0, 10 * 60_000)).toBe('due for 10 min');
  });
});

describe('usage', () => {
  it('this UTC month by day; every count the statement CSV has, exact NEAR and USD, app names', async () => {
    signedIn('viewer');
    routes[DEFAULT_USAGE] = { body: { rows: [ROW, OWNER_ROW] } };
    at('/orgs/org_a/usage');
    expect(await screen.findByText('app_1')).toBeTruthy();
    for (const h of ['Logins', 'Derives', 'Revokes', 'Unlocks', 'Owner actions', 'Link actions', 'Identity tokens', 'Active users', 'New users', 'Failures by code', 'Tgas', 'Relayed-then-rejected Tgas', 'Error Tgas', 'NEAR', 'USD', 'Unsettled'])
      expect(screen.getByRole('columnheader', { name: h })).toBeTruthy();
    const row = screen.getByText('app_1').closest('tr')!;
    const cells = within(row).getAllByRole('cell').map((c) => c.textContent);
    expect(cells).toEqual(['2026-01-02', 'Walletapp_1', '12', '7', '1', '3', '0', '4', '9', '5', '2', 'bad_token=1; rate_limited=2', '12.5', '0.25', '0.1', '0.00125', '0.000025', '0.004375', '0.000087', '820 / 1900', '1400 / —', '1']);
    const owner = screen.getByText('Owner actions, scope s1').closest('tr')!;
    expect(within(owner).getAllByRole('cell').map((c) => c.textContent).slice(6, 9)).toEqual(['2', '0', '0']);
    // No rate yet: USD is "—", never 0.
    expect(within(owner).getAllByRole('cell')[17]!.textContent).toBe('—');
    expect(screen.queryByRole('columnheader', { name: 'After the statement' })).toBeNull();
    expect(writeButtons()).toEqual([]);
    noPersonAddress();
  });

  it('the form: by month, filtered by app (the apps parameter), and late events shown when there are any', async () => {
    signedIn();
    routes[DEFAULT_USAGE] = { body: { rows: [] } };
    const filtered = usagePath('org_a', { from: '2026-01-01', to: '2026-03-31', by: 'month', apps: ['app_1'] });
    routes[filtered] = { body: { rows: [{ ...ROW, period: '2026-01', afterStatement: 3 }] } };
    at('/orgs/org_a/usage');
    expect(await screen.findByText('No usage in this period.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-03-31' } });
    fireEvent.change(screen.getByLabelText('By'), { target: { value: 'month' } });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Wallet' }));
    fireEvent.click(screen.getByRole('button', { name: 'Show' }));
    expect(await screen.findByRole('columnheader', { name: 'After the statement' })).toBeTruthy();
    expect(calls.map((c) => c.url)).toContain('/api/orgs/org_a/usage?from=2026-01-01&to=2026-03-31&by=month&apps=app_1');
    expect(screen.getByText(/owner actions \(which belong to a scope, not an app\) are left out/u)).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Month' })).toBeTruthy();
  });

  it('a start after the end is not sent', async () => {
    signedIn();
    routes[DEFAULT_USAGE] = { body: { rows: [] } };
    at('/orgs/org_a/usage');
    await screen.findByText('No usage in this period.');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '2026-05-02' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '2026-05-01' } });
    expect(screen.getByRole('button', { name: 'Show' })).toHaveProperty('disabled', true);
    expect(screen.getByText(/start day on or before the end day/u)).toBeTruthy();
  });

  it('an error from the server is shown (rate limited, range refused)', async () => {
    signedIn();
    routes[DEFAULT_USAGE] = { status: 429, body: { error: { code: 'rate_limited', message: 'Too many requests; try again in a minute' } } };
    at('/orgs/org_a/usage');
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('Wait a minute, then try again');
    expect(alert.textContent).toContain('rate_limited');
  });

  it('a frozen org still shows its usage, under the frozen note', async () => {
    signedIn('owner', 'frozen');
    routes[DEFAULT_USAGE] = { body: { rows: [ROW] } };
    at('/orgs/org_a/usage');
    expect(await screen.findByText('app_1')).toBeTruthy();
    expect(screen.getByText(/Hana has frozen this organisation/u)).toBeTruthy();
  });
});

const SHA_CSV = 'a'.repeat(64);
const SHA_PDF = 'b'.repeat(64);
const JAN = { orgId: 'org_a', month: '2026-01', asOf: Date.UTC(2026, 1, 3, 9), csvSha256: SHA_CSV, pdfSha256: SHA_PDF, issuedBy: 'hana', issuedAt: Date.UTC(2026, 1, 3, 9) };
const FEB = { orgId: 'org_a', month: '2026-02', asOf: Date.UTC(2026, 2, 3, 9), csvSha256: 'c'.repeat(64), issuedBy: 'staff@hana.example', issuedAt: Date.UTC(2026, 2, 3, 9) };

describe('statements', () => {
  it('the list, newest first, with the hash and plain download links (CSV, PDF when there is one, the ledger at the statement’s as_of)', async () => {
    signedIn('viewer');
    routes['/api/orgs/org_a/statements'] = { body: { statements: [JAN, FEB] } };
    at('/orgs/org_a/statements');
    expect(await screen.findByRole('link', { name: '2026-02' })).toBeTruthy();
    const months = screen.getAllByRole('row').slice(1).map((r) => within(r).getAllByRole('cell')[0]!.textContent);
    expect(months).toEqual(['2026-02', '2026-01']);
    expect(screen.getByText(SHA_CSV)).toBeTruthy();
    const downloads = screen.getAllByRole('link').filter((a) => a.hasAttribute('download')).map((a) => a.getAttribute('href'));
    expect(downloads).toEqual(
      expect.arrayContaining([
        '/api/orgs/org_a/statements/2026-01.csv',
        '/api/orgs/org_a/statements/2026-01.pdf',
        `/api/orgs/org_a/ledger/2026-01.csv?asOf=${JAN.asOf}`,
        '/api/orgs/org_a/statements/2026-02.csv',
        `/api/orgs/org_a/ledger/2026-02.csv?asOf=${FEB.asOf}`,
      ]),
    );
    // February has no PDF: no link to one.
    expect(downloads).not.toContain('/api/orgs/org_a/statements/2026-02.pdf');
    // Nothing was fetched for the downloads: the browser follows the links, it builds no file.
    expect(calls.map((c) => c.url).filter((u) => /\.(csv|pdf)/u.test(u))).toEqual([]);
    // Issued "by Hana", never a staff address even if one were sent.
    expect(screen.getAllByText(/by Hana/u).length).toBe(2);
    noPersonAddress();
    expect(writeButtons()).toEqual([]);
  });

  it('the ledger CSV of any month: as of now, or as of the statement for an issued month', async () => {
    signedIn();
    routes['/api/orgs/org_a/statements'] = { body: { statements: [JAN] } };
    at('/orgs/org_a/statements');
    await screen.findByRole('link', { name: '2026-01' });
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-03' } });
    expect(screen.getByRole('link', { name: 'Download the 2026-03 ledger CSV' }).getAttribute('href')).toBe('/api/orgs/org_a/ledger/2026-03.csv');
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '2026-01' } });
    expect(screen.getByRole('link', { name: 'Download the 2026-01 ledger CSV (as of its statement)' }).getAttribute('href')).toBe(`/api/orgs/org_a/ledger/2026-01.csv?asOf=${JAN.asOf}`);
    fireEvent.change(screen.getByLabelText('Month'), { target: { value: '' } });
    expect(screen.getByText('Pick a month.')).toBeTruthy();
  });

  it('empty, and an error', async () => {
    signedIn();
    routes['/api/orgs/org_a/statements'] = { body: { statements: [] } };
    at('/orgs/org_a/statements');
    expect(await screen.findByText('No statements yet.')).toBeTruthy();
    cleanup();
    routes['/api/orgs/org_a/statements'] = { status: 500, body: { error: { code: 'internal', message: 'The usage service did not answer; try again shortly' } } };
    at('/orgs/org_a/statements');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('The usage service did not answer; try again shortly'));
  });

  const VIEW = {
    title: 'Hana ID usage statement 2026-01',
    header: [
      ['Organisation', 'Acme (org_a)'],
      ['Month', '2026-01'],
      ['Network', 'testnet'],
      ['Covers events received up to', new Date(JAN.asOf).toISOString()],
      ['Statement hash (SHA-256 of the CSV)', SHA_CSV],
    ],
    tableColumns: ['Logins', 'Derives', 'Owner actions', 'MAU', 'New users', 'Tgas', 'NEAR', 'USD', 'Unsettled'],
    table: [{ label: 'Wallet (app_1)', cells: ['12', '7', '0', '5', '2', '12.5', '0.00125', '0.004375', '1'] }],
    summary: [
      ['Logins', '12'],
      ['Link actions', '4'],
      ['Identity tokens', '9'],
      ['Billed (USD)', '0.004288'],
      ['Relayed-then-rejected, not billed (USD)', '0.000087'],
    ],
    notes: ['Testnet usage, valued at the mainnet NEAR/USD price (D93).', 'Relayed-then-rejected gas is not billed by default (D91); it is shown on its own line.'],
  };

  it('the on-screen statement: the server’s view (same labels and values as the PDF), both hashes, the downloads', async () => {
    signedIn('viewer', 'frozen');
    routes['/api/orgs/org_a/statements/2026-01'] = { body: { statement: { ...JAN, totals: {} }, view: VIEW } };
    at('/orgs/org_a/statements/2026-01');
    expect(await screen.findByRole('heading', { name: 'Hana ID usage statement 2026-01' })).toBeTruthy();
    expect(screen.getByText('Acme (org_a)')).toBeTruthy();
    expect(screen.getAllByText(SHA_CSV).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(SHA_PDF)).toBeTruthy();
    expect(screen.getByText('Wallet (app_1)')).toBeTruthy();
    expect(screen.getByText('Identity tokens')).toBeTruthy();
    expect(screen.getByText('Billed (USD)').className).toContain('strong');
    expect(screen.getByText(/Testnet usage, valued at the mainnet/u)).toBeTruthy();
    const downloads = screen.getAllByRole('link').filter((a) => a.hasAttribute('download')).map((a) => a.getAttribute('href'));
    expect(downloads).toEqual(['/api/orgs/org_a/statements/2026-01.csv', '/api/orgs/org_a/statements/2026-01.pdf', `/api/orgs/org_a/ledger/2026-01.csv?asOf=${JAN.asOf}`]);
    expect(screen.getByText(/frozen this organisation/u)).toBeTruthy();
    noPersonAddress();
  });

  it('a month without a statement, a statement with no usage, and a malformed month (nothing fetched)', async () => {
    signedIn();
    at('/orgs/org_a/statements/2026-04');
    expect(await screen.findByText(/No statement for 2026-04/u)).toBeTruthy();
    cleanup();
    routes['/api/orgs/org_a/statements/2026-01'] = { body: { statement: { ...JAN, totals: {} }, view: { ...VIEW, table: [] } } };
    at('/orgs/org_a/statements/2026-01');
    expect(await screen.findByText('No usage this month.')).toBeTruthy();
    cleanup();
    calls = [];
    at('/orgs/org_a/statements/2026-13');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('isn’t a month'));
    expect(calls.some((c) => c.url.includes('/statements/2026-13'))).toBe(false);
  });
});

describe('pending upgrades', () => {
  const URL_ = '/api/orgs/org_a/governance/pending-upgrades';
  const BASE = {
    signer: 'hana-signer.test.near',
    env: 'sandbox-dev',
    readAtMs: Date.now(),
    paused: false,
    governanceDelayMs: 86_400_000,
    upgrade: null,
    ownerTransfer: null,
    withdrawal: null,
    delayDecreases: [],
    consoleAudienceAdditions: [],
    anyPending: false,
  };
  const HASH = '8Tf3Bq1sUk5XTzW1LbbpVBfX4qYyTDZwM5FCFBrCovLp';
  const RELEASE = { version: '1.4.0', commit: '1'.repeat(40), buildCommand: 'cd contracts/hana-signer && cargo near build reproducible-wasm', previousCommit: '0'.repeat(40), diffCommand: `git diff ${'0'.repeat(40)}..${'1'.repeat(40)} -- contracts/hana-signer` };

  it('nothing pending', async () => {
    signedIn('viewer');
    routes[URL_] = { body: { pendingUpgrades: BASE } };
    at('/orgs/org_a/upgrades');
    expect(await screen.findByText('Nothing is pending.')).toBeTruthy();
    expect(screen.getByText('hana-signer.test.near')).toBeTruthy();
    expect(screen.getByText(/governance delay \(1 d\)/u)).toBeTruthy();
    expect(writeButtons()).toEqual([]);
  });

  it('an upgrade of a published release: hash, version, commit, build and diff commands, the countdown', async () => {
    signedIn();
    const executableAtMs = Date.now() + 2 * 86_400_000 + 3 * 3_600_000 + 30_000;
    routes[URL_] = { body: { pendingUpgrades: { ...BASE, anyPending: true, upgrade: { codeHash: HASH, proposedAtMs: Date.now() - 1000, executableAtMs, due: false, release: RELEASE } } } };
    at('/orgs/org_a/upgrades');
    expect(await screen.findByText(HASH)).toBeTruthy();
    expect(screen.getByText('1.4.0')).toBeTruthy();
    expect(screen.getByText('1'.repeat(40))).toBeTruthy();
    expect(screen.getByText(RELEASE.buildCommand)).toBeTruthy();
    expect(screen.getByText(RELEASE.diffCommand)).toBeTruthy();
    expect(screen.getByText('Can be executed in 2 d 3 h')).toBeTruthy();
    expect(screen.queryByText(/Not a published release/u)).toBeNull();
    cleanup();
    routes[URL_] = { body: { pendingUpgrades: { ...BASE, anyPending: true, upgrade: { codeHash: HASH, proposedAtMs: 0, executableAtMs, due: false, release: { ...RELEASE, previousCommit: null, diffCommand: null } } } } };
    at('/orgs/org_a/upgrades');
    expect(await screen.findByText(/The first published release/u)).toBeTruthy();
  });

  it('a hash that is not a published release is a warning', async () => {
    signedIn();
    routes[URL_] = { body: { pendingUpgrades: { ...BASE, anyPending: true, upgrade: { codeHash: HASH, proposedAtMs: 0, executableAtMs: Date.now() + 3_600_000, due: false, release: null } } } };
    at('/orgs/org_a/upgrades');
    const warn = await screen.findByRole('alert');
    expect(warn.textContent).toMatch(/^Not a published release\. No source commit or reproducible-build command is on record/u);
    expect(screen.queryByText(/cargo near build/u)).toBeNull();
  });

  it('owner transfer, withdrawal (exact NEAR), shorter delays and console audiences; a due item; paused', async () => {
    signedIn('viewer', 'frozen');
    const soon = Date.now() + 5 * 3_600_000 + 7 * 60_000 + 30_000;
    routes[URL_] = {
      body: {
        pendingUpgrades: {
          ...BASE,
          paused: true,
          anyPending: true,
          ownerTransfer: { owner: 'council.sputnik-dao.near', acceptableAtMs: Date.now() - 600_000, due: true },
          withdrawal: { receiver: 'treasury.near', amountYocto: '2500000000000000000000000', executableAtMs: soon, due: false },
          delayDecreases: [{ delay: 'governance', currentMs: 86_400_000, valueMs: 3_600_000, effectiveAtMs: soon }],
          consoleAudienceAdditions: [{ provider: 'google', aud: '123-new.apps.googleusercontent.com', effectiveAtMs: soon }],
        },
      },
    };
    at('/orgs/org_a/upgrades');
    expect(await screen.findByText('council.sputnik-dao.near')).toBeTruthy();
    expect(screen.getByText('Due: it can be accepted now')).toBeTruthy();
    expect(screen.getByText('2.5')).toBeTruthy();
    expect(screen.getByText('Can be executed in 5 h 7 min')).toBeTruthy();
    const delay = screen.getByText('Governance (upgrades, owner, withdrawals)').closest('tr')!;
    expect(within(delay).getAllByRole('cell').map((c) => c.textContent?.replace(/\d{1,2}:\d{2}.*$/u, ''))).toEqual(['Governance (upgrades, owner, withdrawals)', '1 d', '1 h', expect.stringMatching(/^Can apply in 5 h 7 min/u)]);
    expect(screen.getByText('123-new.apps.googleusercontent.com')).toBeTruthy();
    expect(screen.getByText(/The contract is paused/u)).toBeTruthy();
    expect(screen.queryByText('Nothing is pending.')).toBeNull();
    noPersonAddress();
  });

  it('an error (the chain unreadable) offers a retry that reads again', async () => {
    signedIn();
    let n = 0;
    routes[URL_] = () => (n++ === 0 ? { status: 503, body: { error: { code: 'near_unavailable', message: 'The governance state could not be read; try again shortly' } } } : { body: { pendingUpgrades: BASE } });
    at('/orgs/org_a/upgrades');
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', expect.stringContaining('The governance state could not be read; try again shortly'));
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is pending.')).toBeTruthy();
    await waitFor(() => expect(calls.filter((c) => c.url === URL_).length).toBe(2));
  });
});
