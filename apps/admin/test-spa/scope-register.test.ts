// The organisation page's "Register a scope for this organisation" panel (D651), run as the browser runs public/app.js
// (boot.ts): it gathers the owners' Google accounts itself (owners who have accepted; anyone else listed with why not),
// checks the choices as the contract and "Create an app" will (1–5 owners, each an owner of the organisation; shared
// login and/or the partner's own client, never Hana's shared client as one), and shows the exact `scope:register`
// command for the env's owner (a dev council: both votes in one command; another council: one member proposes; an
// account owner signs). It sends nothing and never puts a Google account id in a URL. Also: the staff "Propose origins"
// help says the origin rules and what a staff proposal doesn't get.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const T = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86_400_000;
const [A, B, C] = ['hana-id-council-a-dev1.testnet', 'hana-id-council-b-dev1.testnet', 'hana-id-council-c-dev1.testnet'];
const SHARED = '875896396522-sharedclient.apps.googleusercontent.com';
const CLIENT = '123456789012-partnerclient01.apps.googleusercontent.com';
const DEV_COUNCIL = { ownerKind: 'sputnik', owner: 'hana-id-council-dev1.sputnikv2.testnet', councilMembers: [A, B, C], devCouncilKeys: true, sharedClientIds: [SHARED] };
const PREFIX = 'pnpm --filter @hana-id/scripts run admin sandbox-dev scope:register';

const org = { id: 'org_corvid', name: 'Corvid Pay', kind: 'partner', status: 'active', createdAt: T - DAY };
const member = (n: number, extra: Record<string, unknown> = {}) => ({ userId: `usr_${n}`, sub: `1102484959212389864${n}`, email: `p${n}@corvid.example`, role: 'owner', roleSince: T - DAY, disabled: false, ...extra });
const detail = (extra: Record<string, unknown> = {}) => ({ org, members: [member(1)], invites: [], grants: [], securityContacts: ['sec@corvid.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] }, ...extra });

function page(d: Record<string, unknown>, scopeRegistration: unknown = DEV_COUNCIL, env = 'sandbox-dev') {
  const answer = (c: Call): Answer => {
    if (c.method !== 'GET') return { status: 500, body: { error: { code: 'internal', message: 'no write expected' } } };
    if (c.path === '/api/orgs/org_corvid') return { body: d };
    if (c.path === '/api/orgs/org_corvid/changes') return { body: { changes: [] } };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
  return boot('/orgs/org_corvid', answer, { me: () => ({ body: { email: 'staff@hana.example', env, ...(scopeRegistration ? { scopeRegistration } : {}) } }) });
}

async function ready(s: ReturnType<typeof boot>) {
  await vi.waitFor(() => expect(s.text()).toContain('Register a scope for this organisation'));
  return s.main().querySelector('#register-scope') as unknown as HTMLElement;
}
const commandOf = (p: HTMLElement) => p.querySelector('.command code')?.textContent ?? null;
const box = (p: HTMLElement, sel: string) => p.querySelector(sel) as unknown as HTMLInputElement;
function set(s: ReturnType<typeof boot>, input: HTMLInputElement, value: string | boolean) {
  if (typeof value === 'boolean') {
    input.checked = value;
    input.dispatchEvent(new s.w.Event('change') as unknown as Event);
  } else {
    input.value = value;
    input.dispatchEvent(new s.w.Event('input') as unknown as Event);
  }
}

describe('Register a scope for this organisation', () => {
  it('shared login only (the default): one owner, both council votes in one command, and what to do next', async () => {
    const s = page(detail());
    const p = await ready(s);
    expect(commandOf(p)).toBe(`${PREFIX} --allow-shared --owner-google 11024849592123898641 --member ${A} --approve-with ${B} --yes`);
    const t = p.textContent ?? '';
    expect(t).toContain('p1@corvid.example');
    expect(t).toContain(`casts both votes (${A} and ${B})`);
    expect(t).toContain('Registered scope: s…');
    expect(t).toContain('“Create an app” under Apps with the scope id the command printed');
    expect(t).toContain('Order matters: the partner accepts their invite first');
    // Prepares only: no write, and the Google account id is in no request's URL.
    expect(s.api().filter((c) => c.method !== 'GET')).toEqual([]);
    for (const c of s.calls) expect(c.path).not.toContain('11024849592123898641');
  });

  it('the partner’s own client: --client instead of (or with) shared login; a bad or shared id is refused with why', async () => {
    const s = page(detail());
    const p = await ready(s);
    set(s, box(p, 'input[name=allowShared]'), false);
    set(s, box(p, 'input[name=client]'), CLIENT);
    expect(commandOf(p)).toBe(`${PREFIX} --client ${CLIENT} --owner-google 11024849592123898641 --member ${A} --approve-with ${B} --yes`);
    set(s, box(p, 'input[name=allowShared]'), true);
    expect(commandOf(p)).toBe(`${PREFIX} --allow-shared --client ${CLIENT} --owner-google 11024849592123898641 --member ${A} --approve-with ${B} --yes`);
    set(s, box(p, 'input[name=client]'), 'my client; echo hi');
    expect(commandOf(p)).toBeNull();
    expect(p.textContent).toContain('isn’t a Google web client id');
    set(s, box(p, 'input[name=client]'), SHARED);
    expect(commandOf(p)).toBeNull();
    expect(p.textContent).toContain('That is Hana’s shared Google client');
    set(s, box(p, 'input[name=client]'), '');
    set(s, box(p, 'input[name=allowShared]'), false);
    expect(commandOf(p)).toBeNull();
    expect(p.textContent).toContain('Choose how users sign in');
  });

  it('two owners: both in the command in member order; none is refused; at most five', async () => {
    const s = page(detail({ members: [member(1), member(2), { ...member(9), role: 'viewer' }] }));
    const p = await ready(s);
    expect(commandOf(p)).toBe(`${PREFIX} --allow-shared --owner-google 11024849592123898641 --owner-google 11024849592123898642 --member ${A} --approve-with ${B} --yes`);
    // A viewer is never offered: "Create an app" would refuse a scope owned by someone who isn't an owner.
    expect(p.querySelectorAll('input[name=scopeOwner]')).toHaveLength(2);
    expect(p.textContent).not.toContain('p9@corvid.example');
    const owners = [...p.querySelectorAll('input[name=scopeOwner]')] as unknown as HTMLInputElement[];
    for (const o of owners) set(s, o, false);
    expect(commandOf(p)).toBeNull();
    expect(p.textContent).toContain('Choose at least one owner');

    await closeWindow();
    const six = page(detail({ members: [1, 2, 3, 4, 5, 6].map((n) => member(n)) }));
    const q = await ready(six);
    const boxes = [...q.querySelectorAll('input[name=scopeOwner]')] as unknown as HTMLInputElement[];
    expect(boxes.map((b) => b.checked)).toEqual([true, true, true, true, true, false]);
    expect(commandOf(q)?.match(/--owner-google/gu)).toHaveLength(5);
    set(six, boxes[5]!, true);
    expect(commandOf(q)).toBeNull();
    expect(q.textContent).toContain('A scope has at most 5 owners on chain');
  });

  it('an owner who hasn’t accepted (or is still in the grant period, or disabled) is listed with why, not put in the command', async () => {
    const s = page(
      detail({
        members: [member(1), { ...member(2), role: 'viewer', pendingOwnerFrom: T + DAY }, { ...member(3), disabled: true }],
        invites: [
          { id: 'inv_1', email: 'kai@corvid.example', role: 'owner', createdAt: T, expiresAt: Date.now() + DAY, acceptedAt: null, revokedAt: null },
          { id: 'inv_2', email: 'gone@corvid.example', role: 'owner', createdAt: T, expiresAt: Date.now() + DAY, acceptedAt: null, revokedAt: T },
          { id: 'inv_3', email: 'viewer@corvid.example', role: 'viewer', createdAt: T, expiresAt: Date.now() + DAY, acceptedAt: null, revokedAt: null },
        ],
      }),
    );
    const p = await ready(s);
    expect(commandOf(p)).toBe(`${PREFIX} --allow-shared --owner-google 11024849592123898641 --member ${A} --approve-with ${B} --yes`);
    const t = p.textContent ?? '';
    expect(t).toContain('Not included');
    expect(t).toContain('kai@corvid.example');
    expect(t).toContain('hasn’t accepted yet');
    expect(t).toContain('p2@corvid.example');
    expect(t).toContain('the owner-grant period');
    expect(t).toContain('p3@corvid.example');
    expect(t).toContain('disabled');
    for (const absent of ['gone@corvid.example', 'viewer@corvid.example']) expect(t).not.toContain(absent);

    await closeWindow();
    // Nobody has accepted: no form and no command, only what to wait for.
    const w = page(detail({ members: [], invites: [{ id: 'inv_1', email: 'kai@corvid.example', role: 'owner', createdAt: T, expiresAt: Date.now() + DAY, acceptedAt: null, revokedAt: null }] }));
    const q = await ready(w);
    expect(q.textContent).toContain('Waiting for the partner');
    expect(q.textContent).toContain('kai@corvid.example');
    expect(commandOf(q)).toBeNull();
    expect(q.querySelector('input')).toBeNull();
  });

  it('an organisation with no security contact: the command still, with the warning that "Create an app" needs one', async () => {
    const s = page(detail({ securityContacts: [], flags: { noSecurityContacts: true, ownersNotContacts: ['p1@corvid.example'] } }));
    const p = await ready(s);
    expect(commandOf(p)).toBe(`${PREFIX} --allow-shared --owner-google 11024849592123898641 --member ${A} --approve-with ${B} --yes`);
    expect(p.textContent).toContain('registering doesn’t need one, but “Create an app” does');
    expect(p.textContent).toContain('Add a security contact (below), then use “Create an app”');
  });

  it('another council env: one member proposes and the votes are printed; an account owner signs alone; no config: no command', async () => {
    const s = page(detail(), { ...DEV_COUNCIL, devCouncilKeys: false }, 'staging');
    const p = await ready(s);
    expect(commandOf(p)).toBe('pnpm --filter @hana-id/scripts run admin staging scope:register --allow-shared --owner-google 11024849592123898641 --member <your council account> --yes');
    expect(p.textContent).toContain(`Run it as one council member (${A}, ${B}, ${C})`);
    expect(p.textContent).toContain('ask that member for it');
    await closeWindow();

    const acct = page(detail(), { ownerKind: 'account', owner: 'hana-id-admin-local.testnet', councilMembers: [], devCouncilKeys: false, sharedClientIds: [] }, 'local');
    const q = await ready(acct);
    expect(commandOf(q)).toBe('pnpm --filter @hana-id/scripts run admin local scope:register --allow-shared --owner-google 11024849592123898641 --yes');
    expect(q.textContent).toContain('hana-id-admin-local.testnet, the contract owner, signs');
    expect(q.textContent).toContain('This env has no shared Google client yet');
    await closeWindow();

    const none = page(detail(), null);
    const r = await ready(none);
    expect(commandOf(r)).toBeNull();
    expect(r.textContent).toContain('its Worker has no SCOPE_REGISTRATION setting');
  });

  it('an organisation that already has an app keeps the form behind one button', async () => {
    const s = page(detail({ apps: [{ id: 'app_1', name: 'Corvid checkout', scopeId: 's7', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 1, pendingChanges: 0 }] }));
    const p = await ready(s);
    expect(s.buttons('Prepare a scope:register command')).toHaveLength(1);
    expect(commandOf(p)).not.toBeNull();
    expect((p.querySelector('.command') as unknown as HTMLElement).closest('[hidden]')).not.toBeNull();
    s.button('Prepare a scope:register command').click();
    expect((p.querySelector('.command') as unknown as HTMLElement).closest('[hidden]')).toBeNull();
  });
});

describe('the staff "Propose origins" help', () => {
  const appPage = (environment: string, env: string) => {
    const app = { id: 'app_1', orgId: 'org_corvid', name: 'Corvid checkout', scopeId: 's7', environment, suspendedBy: 0, deleted: false, originsVersion: 1, settingsVersion: 1, origins: [], changes: [], settings: { rawSign: 'off', persistence: 'session', policy: null }, keys: [] };
    return boot('/orgs/org_corvid/apps/app_1', (c) => (c.path.startsWith('/api/apps/app_1') ? { body: { app } } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }), { me: () => ({ body: { email: 'staff@hana.example', env } }) });
  };
  const help = async (s: ReturnType<typeof boot>) => {
    await vi.waitFor(() => expect(s.text()).toContain('Propose origins'));
    return s.main().querySelector('textarea[name=add], input[name=add]')!.closest('label')!.querySelector('.help')!.textContent ?? '';
  };

  it('a test app in a dev env: localhost allowed, but a staff proposal waits the full period; never "Full https:// origins"', async () => {
    const t = await help(appPage('test', 'sandbox-dev'));
    expect(t).toContain('https with a real host name');
    expect(t).toContain('http://localhost:<port>');
    expect(t).toContain('A staff proposal always waits the full period after its email');
    expect(t).toContain('only the partner’s own proposal of a localhost origin takes effect at once');
    expect(t).toContain('refused for one waiting period after the scope moved to this organisation');
    expect(t).not.toContain('Full https:// origins');
  });

  it('a live app (or any app outside a dev env): no localhost', async () => {
    for (const [environment, env] of [['live', 'sandbox-dev'], ['test', 'staging']] as const) {
      const t = await help(appPage(environment, env));
      expect(t, `${environment} ${env}`).not.toContain('localhost');
      expect(t).toContain('A staff proposal always waits the full period after its email.'.slice(0, -1));
      await closeWindow();
    }
  });
});
