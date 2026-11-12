// Fixes from the onboarding dry run of 2026-11-11 (D696's branch): "Create an app" refreshes the Apps table in place and
// keeps its confirmation (the publishable key) on screen; the per-organisation Invites panel offers Revoke on open
// invites only; `passkeys_required` names the real cause (D242's one-partner gate), not a passkey to add.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const NOW = Date.now();
const DAY = 86_400_000;
const ORG = { id: 'org_lumen', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: NOW - 9 * DAY };
const owner = { userId: 'usr_ann', sub: '1234567890', email: 'ann@lumen.example', role: 'owner', roleSince: NOW - DAY, disabled: false };
const APP = { id: 'app_new1', name: 'Lumen checkout', scopeId: 's9', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 0, pendingChanges: 0 };
const detail = (extra: Record<string, unknown> = {}) => ({ org: ORG, members: [owner], invites: [], grants: [], securityContacts: ['sec@lumen.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] }, ...extra });

function orgApi(details: () => Answer, write: (c: Call) => Answer) {
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path === '/api/orgs/org_lumen') return details();
    if (c.path === '/api/orgs/org_lumen/changes') return { body: { changes: [] } };
    if (c.path === '/api/orgs') return { body: { orgs: [ORG] } };
    if (c.path === '/api/invites/new-orgs') return { body: { invites: [], truncated: false } };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}
const appsPanel = (s: ReturnType<typeof boot>) => [...s.main().querySelectorAll('section.panel')].find((p) => p.querySelector('h2')?.textContent === 'Apps')!;

describe('"Create an app" on the organisation page', () => {
  async function createApp(s: ReturnType<typeof boot>) {
    await vi.waitFor(() => expect(s.button('Create an app')).toBeTruthy());
    s.button('Create an app').click();
    const f = appsPanel(s).querySelector('form')!;
    const set = (n: string, v: string) => ((f.querySelector(`[name=${n}]`) as unknown as HTMLInputElement).value = v);
    set('scopeId', 's9');
    set('name', 'Lumen checkout');
    s.submit(f);
  }

  it('lists the new app in the table at once, and keeps the confirmation with the publishable key', async () => {
    let created = false;
    const s = boot(
      '/orgs/org_lumen',
      orgApi(
        () => ({ body: detail({ apps: created ? [APP] : [] }) }),
        (c) => {
          expect(c.path).toBe('/api/apps');
          created = true;
          return { body: { app: { id: 'app_new1' }, publishableKey: 'pk_test_fakePreviewKeyAbc12345' } };
        },
      ),
    );
    await vi.waitFor(() => expect(appsPanel(s).textContent).toContain('No app yet.'));
    await createApp(s);
    await vi.waitFor(() => expect(appsPanel(s).querySelector('tbody')!.textContent).toContain('Lumen checkout'));
    expect(appsPanel(s).querySelector('tbody')!.textContent).not.toContain('No app yet.');
    const ok = appsPanel(s).querySelector('.jp-alert-success')!;
    expect(ok.textContent).toContain('Created app_new1');
    expect(ok.querySelector('code')!.textContent).toBe('pk_test_fakePreviewKeyAbc12345');
    // The table came from a second read of the organisation; the page itself wasn't re-rendered.
    expect(s.api().filter((c) => c.path === '/api/orgs/org_lumen')).toHaveLength(2);
  });

  it('when the refresh fails, the confirmation stays and says to reload', async () => {
    let reads = 0;
    const s = boot(
      '/orgs/org_lumen',
      orgApi(
        () => ((reads += 1) === 1 ? { body: detail() } : { status: 503, body: { error: { code: 'upstream_unavailable', message: 'down' } } }),
        () => ({ body: { app: { id: 'app_new1' }, publishableKey: 'pk_test_fakePreviewKeyAbc12345' } }),
      ),
    );
    await createApp(s);
    await vi.waitFor(() => expect(appsPanel(s).textContent).toContain('The app list above couldn’t be refreshed: reload the page to see the new app in it.'));
    expect(appsPanel(s).querySelector('.jp-alert-success code')!.textContent).toBe('pk_test_fakePreviewKeyAbc12345');
  });
});

describe('the organisation page\'s Invites panel', () => {
  it('offers Revoke on open invites only: never on an accepted, revoked or expired one', async () => {
    const inv = (id: string, extra: Record<string, unknown>) => ({ id, email: `${id}@lumen.example`, orgId: 'org_lumen', role: 'viewer', createdByKind: 'hana', createdBy: 'x', createdAt: NOW - 8 * DAY, expiresAt: NOW + DAY, ...extra });
    const invites = [
      inv('open', { notifiedAt: NOW - DAY }),
      inv('unsent', {}),
      inv('accepted', { acceptedAt: NOW - DAY }),
      inv('revoked', { revokedAt: NOW - DAY }),
      inv('expired', { expiresAt: NOW - DAY }),
    ];
    const s = boot('/orgs/org_lumen', orgApi(() => ({ body: detail({ invites }) }), () => ({ body: { ok: true } })));
    const panel = () => [...s.main().querySelectorAll('section.panel')].find((p) => p.querySelector('h2')?.textContent === 'Invites')!;
    await vi.waitFor(() => expect(panel()).toBeTruthy());
    const rows = [...panel().querySelectorAll('tbody tr')].map((r) => [r.querySelector('td')!.textContent!.split('@')[0], [...r.querySelectorAll('button')].some((b) => b.textContent === 'Revoke')]);
    expect(rows).toEqual([
      ['open', true],
      ['unsent', true],
      ['accepted', false],
      ['revoked', false],
      ['expired', false],
    ]);
  });
});

describe('passkeys_required (D242: one partner organisation until passkeys ship)', () => {
  it('says the real cause and the two ways on, not a passkey to add', async () => {
    const s = boot('/orgs', orgApi(() => ({ body: detail() }), () => ({ status: 403, body: { error: { code: 'passkeys_required', message: 'A second partner org needs member passkeys first' } } })));
    await vi.waitFor(() => expect(s.button('Invite a new partner')).toBeTruthy());
    s.button('Invite a new partner').click();
    s.field('newOrgName').value = 'Second Partner';
    s.field('email').value = 'owner@second.example';
    s.submit();
    await vi.waitFor(() => expect(s.main().querySelector('.jp-alert-danger')).toBeTruthy());
    const box = s.main().querySelector('.jp-alert-danger')!;
    expect(box.querySelector('b')!.textContent).toBe('Only one partner organisation for now');
    expect(box.textContent).toContain('Until partner passkeys ship, only one partner organisation can exist on this network (testnet has no such limit), and another partner organisation, or an open invite to create one, already exists. Revoke that invite under Pending invites if it was a mistake, or choose type Internal.');
    expect(box.textContent).not.toMatch(/add a passkey/iu);
    expect(box.textContent).toContain('Error code passkeys_required (HTTP 403)');
  });
});
