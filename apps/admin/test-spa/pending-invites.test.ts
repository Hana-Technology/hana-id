// The Organisations page's "Pending invites" (D696): the invites to organisations that don't exist yet (the first
// owner's acceptance creates them), read from GET /api/invites/new-orgs beside the list. Shown only with a row and right
// after "Invite a new partner" sends one (the page re-reads it, no reload); each row's state in plain words; Revoke on
// open rows only, confirmed in the page, then the existing revoke route. A failed read is said in the panel and leaves
// the list.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const NOW = Date.now();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ORGS = [{ id: 'org_lumen', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: NOW - 9 * DAY }];
/** An invite as GET /api/invites/new-orgs answers it (console-core `InviteView`). */
interface Inv {
  id: string;
  email: string;
  expiresAt: number;
  notifiedAt?: number;
  acceptedAt?: number;
  revokedAt?: number;
  [k: string]: unknown;
}
const invite = (id: string, newOrgName: string, email: string, created: number, extra: Record<string, unknown> = {}): Inv => ({
  id,
  email,
  newOrgName,
  newOrgKind: 'partner',
  role: 'owner',
  createdByKind: 'hana',
  createdBy: 'access-sub-1',
  createdAt: NOW - created,
  expiresAt: NOW - created + 7 * DAY,
  ...extra,
});
const UNSENT = invite('inv_tide', 'Tidepool', 'mira@tidepool.example', 2 * 60_000);
const SENT = invite('inv_qa', 'Hana QA', 'qa@hana.example', 3 * HOUR, { newOrgKind: 'internal', notifiedAt: NOW - 3 * HOUR + 240_000 });
const ACCEPTED = invite('inv_corvid', 'Corvid Pay', 'kai@corvid.example', 2 * DAY, { notifiedAt: NOW - 2 * DAY + 60_000, acceptedAt: NOW - DAY, acceptedUserId: 'usr_kai' });
const REVOKED = invite('inv_heron', 'Heron Labs', 'sam@heron.example', 6 * DAY, { notifiedAt: NOW - 6 * DAY + 60_000, revokedAt: NOW - 5 * DAY });
const EXPIRED = invite('inv_quill', 'Quill Wallet', 'ana@quill.example', 12 * DAY, { notifiedAt: NOW - 12 * DAY + 60_000 });

/** The organisations page's API; `pending` answers each read of the pending invites, `write` every non-GET. */
function pageApi(pending: () => Answer, write: (c: Call) => Answer = () => ({ body: { ok: true } })) {
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path === '/api/orgs') return { body: { orgs: ORGS } };
    if (c.path === '/api/invites/new-orgs') return pending();
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}
const list = (...invites: unknown[]) => () => ({ body: { invites, truncated: false } });
const panelOf = (s: ReturnType<typeof boot>) => [...s.main().querySelectorAll('section.panel')].find((p) => p.querySelector('h2')?.textContent === 'Pending invites');
const rows = (s: ReturnType<typeof boot>) => [...panelOf(s)!.querySelectorAll('tbody tr')].map((r) => [...r.querySelectorAll('td')].map((td) => td.textContent ?? ''));
const writes = (s: ReturnType<typeof boot>) => s.api().filter((c) => c.method !== 'GET');

describe('Pending invites on the Organisations page', () => {
  it('is absent when there is no invite to a new organisation', async () => {
    const s = boot('/orgs', pageApi(list()));
    await vi.waitFor(() => expect(s.text()).toContain('1 organisation'));
    expect(panelOf(s)).toBeUndefined();
    expect(s.api().map((c) => c.path)).toEqual(expect.arrayContaining(['/api/orgs', '/api/invites/new-orgs']));
  });

  it('lists each invite: organisation, type, invited email, the state in plain words, sent and expires times; Revoke on open ones only', async () => {
    const s = boot('/orgs', pageApi(list(UNSENT, SENT, ACCEPTED, REVOKED, EXPIRED)));
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    const head = [...panelOf(s)!.querySelectorAll('thead th')].map((th) => th.textContent);
    expect(head).toEqual(['Organisation', 'Type', 'Invited', 'State', 'Sent', 'Expires', '']);
    const r = rows(s);
    expect(r.map((x) => x.slice(0, 3))).toEqual([
      ['Tidepoolinv_tide', 'Partner', 'mira@tidepool.example'],
      ['Hana QAinv_qa', 'Internal', 'qa@hana.example'],
      ['Corvid Payinv_corvid', 'Partner', 'kai@corvid.example'],
      ['Heron Labsinv_heron', 'Partner', 'sam@heron.example'],
      ['Quill Walletinv_quill', 'Partner', 'ana@quill.example'],
    ]);
    const states = [...panelOf(s)!.querySelectorAll('tbody tr')].map((tr) => tr.querySelectorAll('td')[3]!.querySelector('.jp-badge')!.textContent);
    expect(states).toEqual(['Waiting for the email to go out', 'Email sent, waiting for them to accept', 'Accepted', 'Revoked', 'Expired']);
    // An ended invite says when it ended, under its state.
    const time = (ms: number) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
    expect(r[2]![3]).toContain(time(ACCEPTED.acceptedAt!));
    expect(r[3]![3]).toContain(time(REVOKED.revokedAt!));
    expect(r[4]![3]).toContain(time(EXPIRED.expiresAt));
    // Sent: not yet until the email went out; then its time.
    expect(r[0]![4]).toBe('not yet');
    expect(r[1]![4]).toContain(time(SENT.notifiedAt!));
    // Expires: for open and expired invites; an accepted or revoked one no longer expires.
    expect(r[0]![5]).toContain(time(UNSENT.expiresAt));
    expect(r[1]![5]).toContain(time(SENT.expiresAt));
    expect(r[2]![5]).toBe('');
    expect(r[3]![5]).toBe('');
    expect(r[4]![5]).toContain(time(EXPIRED.expiresAt));
    // Revoke: the two open rows only.
    const revokes = [...panelOf(s)!.querySelectorAll('tbody tr')].map((tr) => [...tr.querySelectorAll('button')].filter((b) => b.textContent === 'Revoke').length);
    expect(revokes).toEqual([1, 1, 0, 0, 0]);
    // Plain words, no em or en dash anywhere in the panel.
    expect(panelOf(s)!.textContent).not.toMatch(/[–—]/u);
    expect(panelOf(s)!.textContent).toContain('Invites to organisations that don’t exist yet');
    expect(s.text()).toContain('1 organisation');
  });

  it('revokes an open invite after an in-page confirmation, through the revoke route, then re-reads the list', async () => {
    let current = [UNSENT, SENT];
    const s = boot(
      '/orgs',
      pageApi(
        () => ({ body: { invites: current, truncated: false } }),
        (c) => {
          if (c.path === '/api/invites/inv_qa/revoke') current = [UNSENT, { ...SENT, revokedAt: Date.now() }];
          return { body: { ok: true } };
        },
      ),
    );
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    const row = () => [...panelOf(s)!.querySelectorAll('tbody tr')].find((tr) => tr.textContent!.includes('qa@hana.example'))!;
    const revoke = () => [...row().querySelectorAll('button')].find((b) => b.textContent === 'Revoke' && !b.hidden) as unknown as HTMLButtonElement;
    revoke().click();
    const confirm = row().querySelector('.confirm')!;
    expect(confirm.textContent).toContain('Revoke the invite for qa@hana.example to the new organisation “Hana QA”? Its link stops working, and the organisation isn’t created.');
    expect(writes(s)).toEqual([]);
    // Cancel sends nothing and brings the button back.
    ([...confirm.querySelectorAll('button')].find((b) => b.textContent === 'Cancel') as unknown as HTMLButtonElement).click();
    expect(row().querySelector('.confirm')).toBeNull();
    expect(writes(s)).toEqual([]);
    revoke().click();
    ([...row().querySelector('.confirm')!.querySelectorAll('button')].find((b) => b.textContent === 'Revoke') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.toasts()).toContain('The invite for qa@hana.example was revoked.'));
    expect(writes(s)).toEqual([{ method: 'POST', path: '/api/invites/inv_qa/revoke', headers: expect.objectContaining({ 'x-hana-admin': '1' }), body: {} }]);
    await vi.waitFor(() => expect(rows(s)[1]![3]).toContain('Revoked'));
    expect(s.api().filter((c) => c.path === '/api/invites/new-orgs')).toHaveLength(2);
    expect(rows(s).map((r) => r[6])).toEqual(['Revoke', '']);
    expect(s.dialogs).toEqual([]);
  });

  it('a refused revoke is said in plain words in the row, and nothing re-renders', async () => {
    const s = boot('/orgs', pageApi(list(SENT), () => ({ status: 409, body: { error: { code: 'not_pending', message: 'The invite was already accepted, revoked or expired' } } })));
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    s.button('Revoke').click();
    ([...panelOf(s)!.querySelectorAll('.confirm button')].find((b) => b.textContent === 'Revoke') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(panelOf(s)!.querySelector('.jp-alert-danger')).toBeTruthy());
    expect(panelOf(s)!.querySelector('.jp-alert-danger')!.textContent).toContain('not_pending');
  });

  it('appears right after "Invite a new partner" sends one, without a reload, with the email not gone out yet', async () => {
    let sent = false;
    const s = boot(
      '/orgs',
      pageApi(
        () => ({ body: { invites: sent ? [invite('inv_new', 'Tidepool', 'owner@tidepool.example', 0)] : [], truncated: false } }),
        (c) => {
          if (c.path === '/api/invites') sent = true;
          return { body: { invite: { id: 'inv_new' } } };
        },
      ),
    );
    await vi.waitFor(() => expect(s.button('Invite a new partner')).toBeTruthy());
    expect(panelOf(s)).toBeUndefined();
    s.button('Invite a new partner').click();
    s.field('newOrgName').value = 'Tidepool';
    s.field('email').value = 'owner@tidepool.example';
    s.submit();
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    expect(s.toasts()).toContain('Invite sent to owner@tidepool.example for the new organisation “Tidepool”. The email goes out within 5 minutes; follow it under Pending invites. The organisation is listed here once they accept.');
    expect(rows(s)).toHaveLength(1);
    expect(rows(s)[0]![3]).toBe('Waiting for the email to go out');
    expect(s.w.location.pathname).toBe('/orgs');
  });

  it('a failed read is said in its panel; the organisations are still listed', async () => {
    const s = boot('/orgs', pageApi(() => ({ status: 503, body: { error: { code: 'upstream_unavailable', message: 'The console did not answer' } } })));
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    expect(panelOf(s)!.querySelector('.jp-alert-danger')!.textContent).toContain('upstream_unavailable');
    expect(s.text()).toContain('1 organisation');
    expect(s.text()).toContain('Lumen Pay');
  });

  it('an organisation name or address that looks like HTML is shown as text, never as markup', async () => {
    const hostile = invite('inv_x', '<img src=x onerror=alert(1)>', 'a<b>@x.example', 60_000);
    const s = boot('/orgs', pageApi(list(hostile)));
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    expect(panelOf(s)!.querySelector('img, b')).toBeNull();
    expect(rows(s)[0]![0]).toContain('<img src=x onerror=alert(1)>');
    expect(rows(s)[0]![2]).toBe('a<b>@x.example');
    s.button('Revoke').click();
    expect(panelOf(s)!.querySelector('.confirm')!.textContent).toContain('to the new organisation “<img src=x onerror=alert(1)>”?');
    expect(panelOf(s)!.querySelector('img')).toBeNull();
    expect(s.dialogs).toEqual([]);
  });

  it('says when the list was cut at 100', async () => {
    const s = boot('/orgs', pageApi(() => ({ body: { invites: [UNSENT], truncated: true } })));
    await vi.waitFor(() => expect(panelOf(s)).toBeTruthy());
    expect(panelOf(s)!.textContent).toContain('Showing the first 100: open invites first, then the newest.');
  });
});
