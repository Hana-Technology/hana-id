// The organisation page's "Register a scope for this organisation" panel (D651, D656–D658), run as the browser runs
// public/app.js (boot.ts): it gathers the owners' Google accounts itself (owners who have accepted; anyone else listed
// with why not), ticks nobody (on-chain ownership outlives the organisation, and the panel says so), checks the choices
// as the contract and "Create an app" will (1–5 owners, each an owner of the organisation, digits-only Google ids),
// always registers with Hana's shared login (never an unproven partner client id), and shows the exact commands for the
// env's owner, a dry run and the one that sends (a dev council: both votes in one command; another council: the member
// chosen with a radio button; an account owner signs). Each Copy reads the members again and refuses a stale choice. It
// sends nothing and never puts a Google account id in a URL. Also: the staff "Propose origins" help says the origin
// rules and what a staff proposal doesn't get.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

const T = Date.UTC(2026, 10, 10, 12, 0, 0);
const DAY = 86_400_000;
const [A, B, C] = ['hana-id-council-a-dev1.testnet', 'hana-id-council-b-dev1.testnet', 'hana-id-council-c-dev1.testnet'];
const SHARED = '875896396522-sharedclient.apps.googleusercontent.com';
const DEV_COUNCIL = { ownerKind: 'sputnik', owner: 'hana-id-council-dev1.sputnikv2.testnet', councilMembers: [A, B, C], devCouncilKeys: true, sharedClientIds: [SHARED] };
const PREFIX = 'pnpm --filter @hana-id/scripts run admin sandbox-dev scope:register --allow-shared';
const SUB1 = '11024849592123898641';
const SUB2 = '11024849592123898642';

const org = { id: 'org_corvid', name: 'Corvid Pay', kind: 'partner', status: 'active', createdAt: T - DAY };
const member = (n: number, extra: Record<string, unknown> = {}) => ({ userId: `usr_${n}`, sub: `1102484959212389864${n}`, email: `p${n}@corvid.example`, role: 'owner', roleSince: T - DAY, disabled: false, ...extra });
const detail = (extra: Record<string, unknown> = {}) => ({ org, members: [member(1)], invites: [], grants: [], securityContacts: ['sec@corvid.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] }, ...extra });

/** The org page; `state.d` is what GET /api/orgs/org_corvid answers now (a test changes it to see a Copy re-read). */
function page(d: Record<string, unknown>, scopeRegistration: unknown = DEV_COUNCIL, env = 'sandbox-dev') {
  const state = { d };
  const answer = (c: Call): Answer => {
    if (c.method !== 'GET') return { status: 500, body: { error: { code: 'internal', message: 'no write expected' } } };
    if (c.path === '/api/orgs/org_corvid') return { body: state.d };
    if (c.path === '/api/orgs/org_corvid/changes') return { body: { changes: [] } };
    return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
  };
  return Object.assign(boot('/orgs/org_corvid', answer, { me: () => ({ body: { email: 'staff@hana.example', env, ...(scopeRegistration ? { scopeRegistration } : {}) } }) }), { state });
}

async function ready(s: ReturnType<typeof boot>) {
  await vi.waitFor(() => expect(s.text()).toContain('Register a scope for this organisation'));
  return s.main().querySelector('#register-scope') as unknown as HTMLElement;
}
const commandsOf = (p: HTMLElement) => [...p.querySelectorAll('.command code')].map((c) => c.textContent);
const owners = (p: HTMLElement) => [...p.querySelectorAll('input[name=scopeOwner]')] as unknown as HTMLInputElement[];
function tick(s: ReturnType<typeof boot>, input: HTMLInputElement, on = true) {
  input.checked = on;
  input.dispatchEvent(new s.w.Event('change') as unknown as Event);
}
const commands = (owner: string, tail: string) => [`${PREFIX} ${owner} ${tail}`, `${PREFIX} ${owner} ${tail} --yes`];
const DEV_TAIL = `--member ${A} --approve-with ${B}`;

describe('Register a scope for this organisation', () => {
  it('nobody ticked at first, with why; ticked: a dry run and the command that sends, shared login, both votes, what next', async () => {
    const s = page(detail());
    const p = await ready(s);
    expect(owners(p).map((b) => b.checked)).toEqual([false]);
    expect(commandsOf(p)).toEqual([]);
    expect(p.textContent).toContain('Tick at least one owner');
    expect(p.textContent).toContain('An on-chain owner stays one after leaving this organisation or being disabled here: removing them takes an on-chain owner’s “set the on-chain owners” proposal and the scope’s timelock.');
    tick(s, owners(p)[0]!);
    expect(commandsOf(p)).toEqual(commands(`--owner-google ${SUB1}`, DEV_TAIL));
    const t = p.textContent ?? '';
    expect(t).toContain('1. Check what it will send (prints the call, sends nothing)');
    expect(t).toContain('2. Send it (the same command with --yes)');
    expect(t).toContain(`casts both votes (${A} and ${B})`);
    expect(t).toContain('Registered scope: s…');
    expect(t).toContain('“Create an app” under Apps with the scope id the command printed');
    // Prepares only: no write, and the Google account id is in no request's URL.
    expect(s.api().filter((c) => c.method !== 'GET')).toEqual([]);
    for (const c of s.calls) expect(c.path).not.toContain(SUB1);
  });

  it('no partner client id: shared login always, and the partner adds their own client with its proof from their console', async () => {
    const s = page(detail());
    const p = await ready(s);
    tick(s, owners(p)[0]!);
    expect(p.querySelector('input[name=client], input[name=allowShared]')).toBeNull();
    for (const c of commandsOf(p)) {
      expect(c).toContain('--allow-shared');
      expect(c).not.toContain('--client');
    }
    expect(p.textContent).toContain('A partner who wants their own Google client adds it from their console’s scope page once the scope exists');
    expect(p.textContent).toContain('Journear never registers a client id a partner sends');
  });

  it('two owners in member order; untick all is refused; at most five, none ticked by default', async () => {
    const s = page(detail({ members: [member(1), member(2), { ...member(9), role: 'viewer' }] }));
    const p = await ready(s);
    expect(owners(p)).toHaveLength(2);
    expect(p.textContent).not.toContain('p9@corvid.example');
    for (const b of owners(p)) tick(s, b);
    expect(commandsOf(p)).toEqual(commands(`--owner-google ${SUB1} --owner-google ${SUB2}`, DEV_TAIL));
    for (const b of owners(p)) tick(s, b, false);
    expect(commandsOf(p)).toEqual([]);
    await closeWindow();

    const six = page(detail({ members: [1, 2, 3, 4, 5, 6].map((n) => member(n)) }));
    const q = await ready(six);
    expect(owners(q).map((b) => b.checked)).toEqual([false, false, false, false, false, false]);
    for (const b of owners(q).slice(0, 5)) tick(six, b);
    expect(commandsOf(q)[0]?.match(/--owner-google/gu)).toHaveLength(5);
    tick(six, owners(q)[5]!);
    expect(commandsOf(q)).toEqual([]);
    expect(q.textContent).toContain('A scope has at most 5 owners on chain');
  });

  it('only digit Google ids are offered: an owner with any other id is listed as not included', async () => {
    const s = page(detail({ members: [member(1), { ...member(2), sub: 'e1.abc;x' }] }));
    const p = await ready(s);
    expect(owners(p)).toHaveLength(1);
    expect(p.textContent).toContain('p2@corvid.example');
    expect(p.textContent).toContain('no Google account recorded for this member');
    expect(p.textContent).not.toContain('e1.abc;x');
  });

  it('an owner who hasn’t accepted (or is still in the grant period, or disabled) is listed with why, not offered', async () => {
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
    expect(owners(p)).toHaveLength(1);
    const t = p.textContent ?? '';
    for (const want of ['Not included', 'kai@corvid.example', 'hasn’t accepted yet', 'p2@corvid.example', 'the owner-grant period', 'p3@corvid.example', 'disabled']) expect(t, want).toContain(want);
    for (const absent of ['gone@corvid.example', 'viewer@corvid.example']) expect(t).not.toContain(absent);
    await closeWindow();

    // Nobody has accepted: no form and no command, only what to wait for.
    const w = page(detail({ members: [], invites: [{ id: 'inv_1', email: 'kai@corvid.example', role: 'owner', createdAt: T, expiresAt: Date.now() + DAY, acceptedAt: null, revokedAt: null }] }));
    const q = await ready(w);
    expect(q.textContent).toContain('Waiting for the partner');
    expect(q.textContent).toContain('kai@corvid.example');
    expect(commandsOf(q)).toEqual([]);
    expect(q.querySelector('input')).toBeNull();
  });

  it('Copy reads the members again: a ticked owner disabled since the page was read is refused, nothing copied', async () => {
    const s = page(detail({ members: [member(1), member(2)] }));
    const p = await ready(s);
    tick(s, owners(p)[1]!);
    const copied: string[] = [];
    Object.defineProperty(s.w.navigator, 'clipboard', { value: { writeText: async (t: string) => void copied.push(t) }, configurable: true });
    const copyButtons = () => [...p.querySelectorAll('.command button')] as unknown as HTMLButtonElement[];
    const reads = () => s.calls.filter((c) => c.path === '/api/orgs/org_corvid').length;
    const before = reads();
    copyButtons()[1]!.click();
    await vi.waitFor(() => expect(copied).toEqual([commands(`--owner-google ${SUB2}`, DEV_TAIL)[1]]));
    expect(reads()).toBe(before + 1);
    s.state.d = detail({ members: [member(1), { ...member(2), disabled: true }] });
    copyButtons()[0]!.click();
    await vi.waitFor(() => expect(p.textContent).toContain('Not copied: an owner you ticked is no longer an owner of this organisation'));
    expect(copied).toHaveLength(1);
    expect(p.textContent).toContain('Owners as read at');
  });

  it('an organisation with no security contact: the commands still, with the warning that "Create an app" needs one', async () => {
    const s = page(detail({ securityContacts: [], flags: { noSecurityContacts: true, ownersNotContacts: ['p1@corvid.example'] } }));
    const p = await ready(s);
    tick(s, owners(p)[0]!);
    expect(commandsOf(p)).toEqual(commands(`--owner-google ${SUB1}`, DEV_TAIL));
    expect(p.textContent).toContain('registering doesn’t need one, but “Create an app” does');
    expect(p.textContent).toContain('Add a security contact (below), then use “Create an app”');
  });

  it('another council env: a radio button per member chooses who proposes (no placeholder); an account owner signs alone; no config: no command', async () => {
    const s = page(detail(), { ...DEV_COUNCIL, devCouncilKeys: false }, 'staging');
    const p = await ready(s);
    tick(s, owners(p)[0]!);
    const radios = [...p.querySelectorAll('input[name=scopeMember]')] as unknown as HTMLInputElement[];
    expect(radios.map((r) => [r.value, r.checked])).toEqual([[A, false], [B, false], [C, false]]);
    expect(commandsOf(p)).toEqual([]);
    expect(p.textContent).toContain('Choose the council member who runs it');
    tick(s, radios[2]!);
    const base = 'pnpm --filter @hana-id/scripts run admin staging scope:register --allow-shared';
    expect(commandsOf(p)).toEqual([`${base} --owner-google ${SUB1} --member ${C}`, `${base} --owner-google ${SUB1} --member ${C} --yes`]);
    for (const c of commandsOf(p)) expect(c).not.toMatch(/[<>|;&$`]/u);
    expect(p.textContent).toContain('ask that member for it');
    await closeWindow();

    const acct = page(detail(), { ownerKind: 'account', owner: 'hana-id-admin-local.testnet', councilMembers: [], devCouncilKeys: false, sharedClientIds: [] }, 'local');
    const q = await ready(acct);
    expect(q.querySelector('input[name=scopeMember]')).toBeNull();
    tick(acct, owners(q)[0]!);
    expect(commandsOf(q)).toEqual([`pnpm --filter @hana-id/scripts run admin local scope:register --allow-shared --owner-google ${SUB1}`, `pnpm --filter @hana-id/scripts run admin local scope:register --allow-shared --owner-google ${SUB1} --yes`]);
    expect(q.textContent).toContain('hana-id-admin-local.testnet, the contract owner, signs');
    expect(q.textContent).toContain('This env has no shared Google client yet');
    await closeWindow();

    const none = page(detail(), null);
    const r = await ready(none);
    tick(none, owners(r)[0]!);
    expect(commandsOf(r)).toEqual([]);
    expect(r.textContent).toContain('its Worker has no SCOPE_REGISTRATION setting');
  });

  it('an organisation that already has an app keeps the form behind one button', async () => {
    const s = page(detail({ apps: [{ id: 'app_1', name: 'Corvid checkout', scopeId: 's7', environment: 'test', deleted: false, suspendedBy: 0, activeOrigins: 1, pendingChanges: 0 }] }));
    const p = await ready(s);
    expect(s.buttons('Prepare a scope:register command')).toHaveLength(1);
    expect((p.querySelector('input[name=scopeOwner]') as unknown as HTMLElement).closest('[hidden]')).not.toBeNull();
    s.button('Prepare a scope:register command').click();
    expect((p.querySelector('input[name=scopeOwner]') as unknown as HTMLElement).closest('[hidden]')).toBeNull();
  });
});

describe('the staff "Propose origins" help', () => {
  const appPage = (environment: string, env: string) => {
    const app = { id: 'app_1', orgId: 'org_corvid', name: 'Corvid checkout', scopeId: 's7', environment, suspendedBy: 0, deleted: false, originsVersion: 1, settingsVersion: 1, origins: [], changes: [], settings: { rawSign: 'off', persistence: 'session', policy: null }, keys: [] };
    return boot('/orgs/org_corvid/apps/app_1', (c) => (c.path.startsWith('/api/apps/app_1') ? { body: { app } } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } }), { me: () => ({ body: { email: 'staff@hana.example', env } }) });
  };
  const help = async (s: ReturnType<typeof boot>) => {
    await vi.waitFor(() => expect(s.text()).toContain('Propose origins'));
    return s.main().querySelector('textarea[name=add], input[name=add]')!.closest('.jp-field')!.querySelector('.jp-hint')!.textContent ?? '';
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
