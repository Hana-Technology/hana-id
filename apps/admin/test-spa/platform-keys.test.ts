// D918: the org page's Platform keys panel. Each key's state, fingerprint and registrant; a staff key awaiting
// acceptance offers Approve (with its reason) only to a staff member other than the one who registered it; switching
// the platform on sends the review: every key still working or waiting, named in the confirmation first.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';
import { orgPlatform } from './preview-data.ts';

afterEach(closeWindow);

const ORG = { org: { id: 'org_lumen', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: 1 }, members: [], invites: [], grants: [], securityContacts: ['sec@lumen.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] } };

function api(platform: ReturnType<typeof orgPlatform>, write: (c: Call) => Answer = () => ({ body: { ok: true } })) {
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path === '/api/orgs/org_lumen') return { body: ORG };
    if (c.path === '/api/orgs/org_lumen/changes') return { body: { changes: [] } };
    if (c.path === '/api/orgs/org_lumen/platform') return { body: platform };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
}

describe('the Platform keys panel', () => {
  it('lists each key with its state, fingerprint and registrant; Approve for another staff member’s key, with its reason', async () => {
    const p = orgPlatform('org_lumen');
    const s = boot('/orgs/org_lumen', api(p));
    await vi.waitFor(() => expect(s.text()).toContain('Key sent by email'));
    const panel = s.main().querySelector('#platform')!.closest('section, .panel, div')!;
    expect(panel.textContent).toContain('Awaiting acceptance');
    expect(panel.textContent).toContain('Working');
    expect(panel.textContent).toContain('Stopped');
    expect(panel.textContent).toContain(p.keys[1]!.thumbprint);
    expect(panel.textContent).toContain('Journear staff (ops@journear.example)');
    expect(s.buttons('Approve')).toHaveLength(1);
    const reason = [...s.main().querySelectorAll('form')].find((f) => f.textContent!.includes('Approve'))!;
    (reason.querySelector('[name="reason"]') as unknown as HTMLInputElement).value = 'Read the fingerprint back by phone with their CTO';
    s.submit(reason);
    await vi.waitFor(() => expect(s.api().some((c) => c.method === 'POST' && c.path === '/api/orgs/org_lumen/platform-keys/pkc_Wa9Gh6Tn1sLk2V/approve')).toBe(true));
  });

  it('the registering staffer sees why they can’t approve it', async () => {
    const p = orgPlatform('org_lumen');
    p.keys[0]!.proposedByEmail = 'staff@hana.example';
    const s = boot('/orgs/org_lumen', api(p));
    await vi.waitFor(() => expect(s.text()).toContain('You registered it: a second staff member approves it'));
    expect(s.buttons('Approve').filter((b) => !b.disabled)).toHaveLength(0);
  });

  it('switching on names every key still working or waiting and sends them as the review', async () => {
    const p = orgPlatform('org_lumen');
    p.platform.enabled = false;
    const s = boot('/orgs/org_lumen', api(p));
    await vi.waitFor(() => expect(s.button('Switch platform keys on')).toBeTruthy());
    s.button('Switch platform keys on').click();
    await vi.waitFor(() => expect(s.text()).toContain('you confirm you reviewed every key still working or waiting: Key sent by email (pkc_Wa9Gh6Tn1sLk2V), Production backend (pkc_Wk7Hq2Lm9Xc4Pz)'));
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.api().some((c) => c.method === 'POST' && c.path === '/api/orgs/org_lumen/platform-switch')).toBe(true));
    const call = s.api().find((c) => c.path === '/api/orgs/org_lumen/platform-switch')!;
    expect(call.body).toMatchObject({ enabled: true, reviewedKeys: ['pkc_Wa9Gh6Tn1sLk2V', 'pkc_Wk7Hq2Lm9Xc4Pz'] });
  });
});
