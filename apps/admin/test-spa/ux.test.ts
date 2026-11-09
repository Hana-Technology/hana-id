// The staff SPA's UI rules (apps/admin/README.md "UI principles"), run as the browser runs public/app.js (boot.ts): an
// action that can't work isn't offered (Legacy apps has no members: no invite, no freeze; its scopes are moved from its
// own page, with the on-chain owner rule said in words; an organisation without a security contact gets no "Create an
// app"; a statement with blockers can't
// be issued), every API error is said in plain words with the code kept small, and destructive or guarded actions are
// confirmed in the page, never with a browser dialog. The request each action sends is the one the routes take
// (docs/api.md "Admin Worker").
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, SRC, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const T = Date.UTC(2026, 10, 1, 12, 0, 0);
const DAY = 86_400_000;
const org = (id: string, name: string, extra: Record<string, unknown> = {}) => ({ id, name, kind: 'partner', status: 'active', createdAt: T - 9 * DAY, ...extra });
const ORGS = [org('org_legacy', 'Legacy apps', { kind: 'internal' }), org('org_lumen', 'Lumen Pay'), org('org_kestrel', 'Kestrel Wallet')];
const app = (id: string, scopeId: string, extra: Record<string, unknown> = {}) => ({ id, name: `App ${id}`, scopeId, environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 1, pendingChanges: 0, ...extra });
const member = (userId: string, email: string, role: string) => ({ userId, sub: `sub-${userId}`, email, role, roleSince: T - DAY, disabled: false });
const detail = (o: ReturnType<typeof org>, extra: Record<string, unknown> = {}) => ({ org: o, members: [], invites: [], grants: [], securityContacts: ['sec@lumen.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] }, ...extra });
const LEGACY = detail(ORGS[0]!, { securityContacts: ['security@hana.example'], apps: [app('app_wend', 's_wend'), app('app_wendlive', 's_wend', { environment: 'live' }), app('app_tide', 's_tide', { deleted: true })] });
const LUMEN = detail(ORGS[1]!, { members: [member('usr_ann', 'ann@lumen.example', 'owner'), member('usr_bob', 'bob@lumen.example', 'viewer')], apps: [app('app_pay', 's_pay')] });

/** The org screens' API: the list, the details, the changes; `write` answers every non-GET. */
function orgsApi(write: (c: Call) => Answer = () => ({ body: { ok: true } }), details: Record<string, unknown> = {}) {
  const all: Record<string, unknown> = { org_legacy: LEGACY, org_lumen: LUMEN, ...details };
  return (c: Call): Answer => {
    if (c.method !== 'GET') return write(c);
    if (c.path === '/api/orgs') return { body: { orgs: ORGS } };
    const m = /^\/api\/orgs\/([^/]+)(\/changes)?$/u.exec(c.path);
    if (m && m[2]) return { body: { changes: [] } };
    if (m && all[m[1]!]) return { body: all[m[1]!] };
    return { status: 404, body: { error: { code: 'not_found', message: 'No such org' } } };
  };
}
const writes = (s: ReturnType<typeof boot>) => s.api().filter((c) => c.method !== 'GET');

describe('Legacy apps (org_legacy): only what can work there', () => {
  it('offers no invite, member, owner-grant, freeze or app form, and says why with the way to onboard instead', async () => {
    const s = boot('/orgs/org_legacy', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('Scopes waiting for an organisation'));
    const t = s.text();
    expect(t).toContain('Nobody can be invited to Legacy apps, and it can’t be frozen');
    expect(t).toContain('To onboard a partner whose app is here: invite their first owner to a new organisation, then use “Move to an organisation” on the scope. If the scope has Google-account owners on chain, each must be an owner of that organisation first, or the move is refused (scope_conflict).');
    expect(SRC).not.toMatch(/scope:register|owners-from-org/u);
    for (const absent of ['Send invite', 'Invite someone', 'Freeze', 'Unfreeze', 'Make owner', 'Create an app', 'Move a legacy scope here']) expect(s.buttons(absent), absent).toHaveLength(0);
    for (const absent of ['Members', 'Invites', 'Pending owner grants']) expect([...s.main().querySelectorAll('h2')].map((x) => x.textContent), absent).not.toContain(absent);
    expect(s.main().querySelector('input[name=email]')).toBeNull();
    // Each scope once, with its apps; contacts, the change log and the suspension switch stay.
    expect(s.buttons('Move to an organisation')).toHaveLength(2);
    for (const want of ['s_wend', 's_tide', 'App app_wend', 'App app_wendlive', 'Security contacts', 'Recent app changes', 'Suspend every app']) expect(t, want).toContain(want);
    expect(s.dialogs).toEqual([]);
  });

  it('moves a scope to an organisation from its row: the targets without org_legacy, confirmed in the page, then the assign route', async () => {
    const s = boot('/orgs/org_legacy', orgsApi());
    await vi.waitFor(() => expect(s.buttons('Move to an organisation')).toHaveLength(2));
    s.buttons('Move to an organisation')[0]!.click();
    await vi.waitFor(() => expect(s.main().querySelector('select[name=orgId]')).toBeTruthy());
    const select = s.main().querySelector('select[name=orgId]') as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.value)).toEqual(['org_kestrel', 'org_lumen']);
    select.value = 'org_lumen';
    s.submit(select.closest('form') as unknown as HTMLFormElement);
    // The confirmation names the scope, its live apps and the target; nothing is sent before "Move scope".
    await vi.waitFor(() => expect(s.main().querySelector('.confirm')).toBeTruthy());
    expect(s.main().querySelector('.confirm')!.textContent).toContain('Move scope s_wend (2 apps) to Lumen Pay (org_lumen)? If the scope has Google-account owners on chain, each must be an owner of that organisation first, or the move is refused (scope_conflict).');
    expect(writes(s)).toEqual([]);
    s.button('Cancel').click();
    expect(s.main().querySelector('.confirm')).toBeNull();
    expect(writes(s)).toEqual([]);
    s.submit(select.closest('form') as unknown as HTMLFormElement);
    await vi.waitFor(() => expect(s.main().querySelector('.confirm')).toBeTruthy());
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.text()).toContain('Scope s_wend now belongs to Lumen Pay (org_lumen)'));
    expect(writes(s)).toEqual([{ method: 'POST', path: '/api/scopes/s_wend/assign', headers: expect.objectContaining({ 'x-hana-admin': '1' }), body: { orgId: 'org_lumen' } }]);
    expect(s.dialogs).toEqual([]);
  });

  it('"Invite a new partner" opens the organisations page with the new-organisation invite ready', async () => {
    const s = boot('/orgs/org_legacy', orgsApi());
    await vi.waitFor(() => expect(s.button('Invite a new partner')).toBeTruthy());
    s.button('Invite a new partner').click();
    await vi.waitFor(() => expect(s.w.location.pathname).toBe('/orgs'));
    await vi.waitFor(() => expect(s.main().querySelector('input[name=newOrgName]')).toBeTruthy());
    const box = s.main().querySelector('input[name=newOrgName]')!.closest('[hidden]');
    expect(box).toBeNull();
    s.field('newOrgName').value = 'Tidepool';
    s.field('email').value = 'owner@tidepool.example';
    s.submit();
    await vi.waitFor(() => expect(writes(s)).toHaveLength(1));
    expect(writes(s)[0]!.body).toEqual({ email: 'owner@tidepool.example', role: 'owner', newOrgName: 'Tidepool', kind: 'partner' });
    await vi.waitFor(() => expect(s.text()).toContain('Invite sent to owner@tidepool.example for the new organisation “Tidepool”'));
  });

  it('lists Legacy apps last on the organisations page, with what it is for', async () => {
    const s = boot('/orgs', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('3 organisations'));
    const rows = [...s.main().querySelectorAll('tbody tr')].map((r) => r.querySelector('a')!.textContent);
    expect(rows).toEqual(['Lumen Pay', 'Kestrel Wallet', 'Legacy apps']);
    expect(s.text()).toContain('Scopes from before organisations, waiting to be moved to their partner');
    // The invite form is behind the page's one primary action, closed until asked for.
    expect(s.main().querySelector('input[name=newOrgName]')!.closest('[hidden]')).not.toBeNull();
  });
});

describe('errors in plain words', () => {
  const refuse = (status: number, code: string, message: string) => () => ({ status, body: { error: { code, message } } });

  it('an org_legacy refusal names Legacy apps and the way to onboard; the code stays small', async () => {
    const s = boot('/orgs/org_lumen', orgsApi(refuse(403, 'forbidden', 'org_legacy has no members')));
    await vi.waitFor(() => expect(s.main().querySelector('#members input[name=email]')).toBeTruthy());
    const invite = s.main().querySelector('#members form') as unknown as HTMLFormElement;
    (invite.querySelector('[name=email]') as unknown as HTMLInputElement).value = 'x@lumen.example';
    s.submit(invite);
    await vi.waitFor(() => expect(s.main().querySelector('.alert.error')).toBeTruthy());
    const box = s.main().querySelector('.alert.error')!;
    expect(box.querySelector('strong')!.textContent).toBe('Legacy apps has no members');
    expect(box.textContent).toContain('invite their first owner to a new organisation');
    expect(box.querySelector('.code')!.textContent).toBe('Error code forbidden (HTTP 403)');
    expect(box.textContent).not.toMatch(/^forbidden:/u);
  });

  it.each([
    [409, 'version_conflict', 'expectedVersion is 6', 'Someone changed this first', 'Reload the page'],
    [409, 'no_security_contact', 'The org has no security contact: set them first', 'This organisation has no security contact', 'Add at least one security contact'],
    [503, 'upstream_unavailable', 'A Hana service did not answer; try again shortly', 'A Hana service didn’t answer', 'Nothing was changed'],
    [418, 'teapot', 'short and stout', 'The server refused the request (HTTP 418)', 'Read the details'],
  ])('HTTP %i %s: a title, the detail, what to do and the code', async (status, code, message, title, next) => {
    const s = boot('/orgs/org_lumen', orgsApi(refuse(status, code, message)));
    await vi.waitFor(() => expect(s.button('Make owner')).toBeTruthy());
    s.button('Make owner').click();
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.main().querySelector('.alert.error')).toBeTruthy());
    const box = s.main().querySelector('.alert.error')!;
    expect(box.querySelector('strong')!.textContent).toBe(title);
    expect(box.querySelector('.detail')!.textContent).toBe(message);
    expect(box.textContent).toContain(next);
    expect(box.querySelector('.code')!.textContent).toBe(`Error code ${code} (HTTP ${status})`);
    // The button is usable again after a failure.
    expect(s.button('Make owner').disabled).toBe(false);
  });

  it('a dropped connection says the console can’t be reached', async () => {
    const s = boot('/orgs/org_lumen', orgsApi(() => ({ network: true })));
    await vi.waitFor(() => expect(s.button('Make viewer')).toBeTruthy());
    s.button('Make viewer').click();
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.text()).toContain('Can’t reach the admin console'));
    expect(s.text()).toContain('reload the page to sign in again');
  });

  it('a page that can’t load says so in the same words', async () => {
    const s = boot('/orgs/org_gone', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('Not found'));
    expect(s.text()).toContain('Go back and reload the list');
    expect(s.main().querySelector('.code')!.textContent).toBe('Error code not_found (HTTP 404)');
  });
});

describe('destructive and guarded actions are confirmed in the page', () => {
  it('a member’s removal: the strip says what happens, Cancel and Escape send nothing, the confirm sends the route’s body once', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.buttons('Remove')).toHaveLength(2));
    s.buttons('Remove')[1]!.click();
    const strip = s.main().querySelector('.confirm')!;
    expect(strip.textContent).toContain('Remove bob@lumen.example from Lumen Pay? They lose access to it at once.');
    // The trigger hides while its confirmation is open: one button per decision.
    expect(s.buttons('Remove')).toHaveLength(2);
    expect(s.doc.activeElement?.textContent).toBe('Remove');
    s.button('Cancel').click();
    expect(s.main().querySelector('.confirm')).toBeNull();
    s.buttons('Remove')[1]!.click();
    s.main().querySelector('.confirm')!.dispatchEvent(new s.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(s.main().querySelector('.confirm')).toBeNull();
    expect(writes(s)).toEqual([]);
    s.buttons('Remove')[1]!.click();
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.text()).toContain('bob@lumen.example was removed.'));
    expect(writes(s)).toEqual([{ method: 'POST', path: '/api/orgs/org_lumen/members/usr_bob', headers: expect.objectContaining({ 'x-hana-admin': '1' }), body: { role: null } }]);
    expect(s.dialogs).toEqual([]);
  });

  it('a guarded form (the security contacts) confirms with the values it will send', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.main().querySelector('#contacts form')).toBeTruthy());
    const f = s.main().querySelector('#contacts form') as unknown as HTMLFormElement;
    (f.querySelector('[name=emails]') as unknown as HTMLInputElement).value = 'a@lumen.example b@lumen.example';
    s.submit(f);
    expect(s.main().querySelector('#contacts .confirm')!.textContent).toContain('Replace the security contacts with a@lumen.example, b@lumen.example?');
    expect(writes(s)).toEqual([]);
    (s.main().querySelector('#contacts .confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writes(s)).toHaveLength(1));
    expect(writes(s)[0]).toMatchObject({ method: 'PUT', path: '/api/orgs/org_lumen/security-contacts', body: { emails: ['a@lumen.example', 'b@lumen.example'] } });
    await vi.waitFor(() => expect(s.text()).toContain('Security contacts replaced.'));
  });

  it('the source opens no browser dialog', async () => {
    expect(SRC).not.toMatch(/(?<![.\w])(?:confirm|alert|prompt)\(|window\.(?:confirm|alert|prompt)\b/u);
  });
});

describe('apps and scopes on an organisation: only what the API takes', () => {
  it('without a security contact: no "Create an app" (createApp refuses it), the reason said; moving a legacy scope stays (it needs none)', async () => {
    const noContact = detail(ORGS[2]!, { members: [member('usr_jo', 'jo@kestrel.example', 'owner')], securityContacts: [], flags: { noSecurityContacts: true, ownersNotContacts: ['jo@kestrel.example'] } });
    const s = boot('/orgs/org_kestrel', orgsApi(undefined, { org_kestrel: noContact }));
    await vi.waitFor(() => expect(s.text()).toContain('Apps'));
    expect(s.buttons('Create an app')).toHaveLength(0);
    expect(s.buttons('Move a legacy scope here')).toHaveLength(1);
    expect(s.text()).toContain('Add a security contact before creating an app: an organisation without one can’t get new apps.');
  });

  it('without an owner, both stay offered: a scope owned only by a NEAR account moves (and gets apps) without one', async () => {
    const noOwner = detail(ORGS[2]!, { members: [member('usr_vi', 'vi@kestrel.example', 'viewer')] });
    const t = boot('/orgs/org_kestrel', orgsApi(undefined, { org_kestrel: noOwner }));
    await vi.waitFor(() => expect(t.button('Create an app')).toBeTruthy());
    expect(t.buttons('Move a legacy scope here')).toHaveLength(1);
  });

  it('a refused move (scope_conflict) says the on-chain owner rule in words', async () => {
    const s = boot('/orgs/org_legacy', orgsApi(() => ({ status: 409, body: { error: { code: 'scope_conflict', message: 'The scope has 1 on-chain OIDC owner(s) who are not owners of this org' } } })));
    await vi.waitFor(() => expect(s.buttons('Move to an organisation')).toHaveLength(2));
    s.buttons('Move to an organisation')[0]!.click();
    await vi.waitFor(() => expect(s.main().querySelector('select[name=orgId]')).toBeTruthy());
    s.submit(s.main().querySelector('select[name=orgId]')!.closest('form'));
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.main().querySelector('.alert.error')).toBeTruthy());
    const box = s.main().querySelector('.alert.error')!;
    expect(box.querySelector('strong')!.textContent).toBe('The scope doesn’t fit this organisation');
    expect(box.textContent).toContain('If the scope has Google-account owners on chain, each must be an owner of that organisation first (scopes owned only by a NEAR account move freely).');
    expect(box.querySelector('.detail')!.textContent).toBe('The scope has 1 on-chain OIDC owner(s) who are not owners of this org');
    expect(box.querySelector('.code')!.textContent).toBe('Error code scope_conflict (HTTP 409)');
  });

  it('with both, "Move a legacy scope here" lists the legacy scopes and sends this organisation as the target', async () => {
    const s = boot('/orgs/org_lumen', orgsApi());
    await vi.waitFor(() => expect(s.button('Move a legacy scope here')).toBeTruthy());
    expect(s.api().map((c) => c.path)).not.toContain('/api/orgs/org_legacy');
    s.button('Move a legacy scope here').click();
    await vi.waitFor(() => expect(s.main().querySelector('select[name=scopeId]')).toBeTruthy());
    const select = s.main().querySelector('select[name=scopeId]') as unknown as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['s_wend: App app_wend (test), App app_wendlive (live)', 's_tide: deleted apps only']);
    s.submit(select.closest('form') as unknown as HTMLFormElement);
    (s.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(writes(s)).toHaveLength(1));
    expect(writes(s)[0]).toMatchObject({ method: 'POST', path: '/api/scopes/s_wend/assign', body: { orgId: 'org_lumen' } });
  });
});

describe('statements: "Issue statement" only when it can work', () => {
  const statementsApi = (view: unknown) => (c: Call): Answer => {
    if (c.path === '/api/orgs') return { body: { orgs: ORGS } };
    if (c.path.startsWith('/api/statements?')) return { body: { statements: [] } };
    if (c.method === 'POST') return { body: { ok: true } };
    return { body: view };
  };

  it('disabled with the blockers listed, enabled and confirmed in the page once they are clear', async () => {
    const blocked = { statement: null, issuableFrom: T - DAY, blockers: { pending: 3, missingRateDays: ['2026-10-14'] } };
    const s = boot('/statements?org=org_lumen&month=2026-10', statementsApi(blocked));
    await vi.waitFor(() => expect(s.button('Issue statement')).toBeTruthy());
    expect(s.button('Issue statement').disabled).toBe(true);
    expect(s.text()).toContain('3 event(s) left; settlement runs every 15 minutes');
    expect(s.text()).toContain('2026-10-14');
    expect(s.text()).toContain('Available once every item above is done.');
    const ready = { statement: null, issuableFrom: T - DAY, blockers: { pending: 0, missingRateDays: [] } };
    const t = boot('/statements?org=org_lumen&month=2026-10', statementsApi(ready));
    await vi.waitFor(() => expect(t.button('Issue statement')).toBeTruthy());
    expect(t.button('Issue statement').disabled).toBe(false);
    t.button('Issue statement').click();
    expect(t.main().querySelector('.confirm')!.textContent).toContain('Issue the 2026-10 statement for org_lumen? It is frozen once issued');
    (t.main().querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(t.api().filter((c) => c.method === 'POST').map((c) => c.path)).toEqual(['/api/statements/org_lumen/2026-10/issue']));
  });
});

describe('navigation', () => {
  it('groups the screens by task and marks the current page', async () => {
    const s = boot('/security/playbooks', () => ({ body: { notes: [], lastVerified: '2026-11-04', playbooks: [] } }));
    await vi.waitFor(() => expect(s.text()).toContain('No playbook matches'));
    const groups = [...s.doc.querySelectorAll('#nav .nav-group')].map((g) => [g.querySelector('h2')!.textContent, [...g.querySelectorAll('a')].map((a) => a.textContent)]);
    expect(groups).toEqual([
      ['Overview', ['Status']],
      ['Partners', ['Organisations']],
      ['Support', ['Users', 'Support ID lookup']],
      ['Security', ['Security & monitoring', 'Feed and notices', 'Pending upgrades', 'Playbooks', 'Audit log']],
      ['Email login', ['Email issuer', 'Account links']],
      ['Money', ['Reports', 'Statements', 'Rates']],
      ['System', ['Retention']],
    ]);
    expect([...s.doc.querySelectorAll('#nav a[aria-current=page]')].map((a) => a.textContent)).toEqual(['Playbooks']);
    expect(s.doc.getElementById('env')!.textContent).toBe('sandbox-dev');
  });

  it('moves focus to the new page’s heading after a nav click', async () => {
    const s = boot('/orgs', orgsApi());
    await vi.waitFor(() => expect(s.text()).toContain('3 organisations'));
    (s.doc.querySelector('#nav a[href="/users"]') as unknown as HTMLAnchorElement).click();
    await vi.waitFor(() => expect(s.doc.activeElement?.tagName).toBe('H1'));
    expect(s.doc.activeElement?.textContent).toBe('Users');
  });
});

describe('the Retention screen (C13; readiness 7.17)', () => {
  it('names the user events period and labels their rows in a run', async () => {
    const t = Date.UTC(2026, 10, 1, 1);
    const body = {
      warning: null,
      month: '2026-11',
      state: 'done',
      dueAt: t,
      nextRunAt: Date.UTC(2026, 11, 1, 1),
      due: { statements: 0, rates: 0, rateOverrides: 0, oldestStatement: null },
      runs: [{ id: 3, month: '2026-11', startedAt: t, finishedAt: t + 30_000, status: 'ok', rows: { calls: 5, userEventsExpired: 12, userEventsDeadScopes: 2 }, error: null }],
      erasures: [],
    };
    const s = boot('/retention', () => ({ body }));
    await vi.waitFor(() => expect(s.text()).toContain('Rows deleted'));
    const text = s.text();
    expect(text).toContain('key exports and mainnet demo signatures 24 months');
    expect(text).toContain('key exports and mainnet demo signatures (24 months): 12');
    expect(text).toContain('key exports and mainnet demo signatures of scopes left without apps: 2');
  });
});
