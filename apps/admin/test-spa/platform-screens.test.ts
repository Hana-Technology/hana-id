// D930 (docs/partner-platform-spec.md A11, piece P5): the staff portal's platform screens. The org page's Platform keys
// panel shows the org's limits, each key's last use and the Activity (each call: what, the app, the key, the result,
// the caller's network, the request id; Older pages back); the Platform queue lists every waiting web address and key
// across orgs, soonest first, with an internationalised address flagged; an app the platform created says so, names
// who holds its partner suspension, and its mainnet demo switch asks staff to confirm the shared wallet's risk (H3).
// The route words are the same as console-core's (platform-words.ts).
import { readFileSync } from 'node:fs';
import { PLATFORM_ROUTE_WORDS } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';
import { appDetail, orgPlatform, platformCalls, platformQueue } from './preview-data.ts';

/** The preview's platform key id (a public id: `pkc_` and base58). */
const PREVIEW_KEY_ID = ['pkc', 'Wk7Hq2Lm9Xc4Pz'].join('_');

afterEach(closeWindow);

const ORG = { org: { id: 'org_lumen', name: 'Lumen Pay', kind: 'partner', status: 'active', createdAt: 1 }, members: [], invites: [], grants: [], securityContacts: ['sec@lumen.example'], apps: [], flags: { noSecurityContacts: false, ownersNotContacts: [] } };
const notFound: Answer = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };

describe('the org page', () => {
  it('shows the limits, each key’s last use and the activity, and pages back with Older', async () => {
    const calls = platformCalls();
    const answer = (c: Call): Answer => {
      if (c.path === '/api/orgs/org_lumen') return { body: ORG };
      if (c.path === '/api/orgs/org_lumen/changes') return { body: { changes: [] } };
      if (c.path === '/api/orgs/org_lumen/platform') return { body: orgPlatform('org_lumen') };
      if (c.path === '/api/orgs/org_lumen/platform-calls') return { body: { ...calls, next: 408 } };
      if (c.path === '/api/orgs/org_lumen/platform-calls?before=408') return { body: { calls: [{ ...calls.calls[4]!, seq: 300 }] } };
      return notFound;
    };
    const s = boot('/orgs/org_lumen', answer);
    await vi.waitFor(() => expect(s.text()).toContain('Activity'));
    expect(s.text()).toContain('Limits: at most 10 apps made by its keys, 5 new apps a day, 30 web addresses asked for a day.');
    expect(s.text()).toMatch(/last used \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/u);
    const activity = s.main().querySelector('.platform-activity')!;
    for (const words of ['Suspend or resume an app', 'Read an app', 'Create an app', 'Read its own key', 'Limit reached', 'rate_limited', '203.0.113.0/24', 'pf_preview412fakerequest']) expect(activity.textContent, words).toContain(words);
    expect(activity.querySelectorAll('tbody tr')).toHaveLength(5);
    s.button('Older').click();
    await vi.waitFor(() => expect(s.api().some((c) => c.path === '/api/orgs/org_lumen/platform-calls?before=408')).toBe(true));
    await vi.waitFor(() => expect(s.main().querySelector('.platform-activity')!.querySelectorAll('tbody tr')).toHaveLength(1));
  });
});

describe('the Platform queue', () => {
  it('lists waiting web addresses (not emailed first, an internationalised one flagged) and waiting keys, from the nav', async () => {
    const s = boot('/platform-queue', (c) => (c.path === '/api/platform-queue' ? { body: platformQueue() } : notFound));
    await vi.waitFor(() => expect(s.text()).toContain('Web addresses waiting'));
    expect([...s.main().querySelectorAll('h1')].map((x) => x.textContent)).toEqual(['Platform queue']);
    const nav = s.doc.getElementById('nav')!;
    expect(nav.querySelector('a[aria-current="page"]')!.textContent).toBe('Platform queue');
    const text = s.text();
    for (const words of ['Coffee Club', 'https://widget.lumenpay.example', 'Email not sent yet', 'Production backend', 'pkc_Wk7Hq2Lm9Xc4Pz', 'https://tilèshop.example', 'IDN', 'https://xn--tilshop-yya.example', 'Platform keys waiting', 'Key sent by email', 'Awaiting acceptance']) expect(text, words).toContain(words);
    expect(text).toMatch(/in \d+ h/u);
  });

  it('says so when nothing waits', async () => {
    const s = boot('/platform-queue', (c) => (c.path === '/api/platform-queue' ? { body: { origins: [], keys: [], secondPerson: [], confirmed: [] } } : notFound));
    await vi.waitFor(() => expect(s.text()).toContain('No web address waiting.'));
    expect(s.text()).toContain('No platform key waiting.');
    expect(s.text()).toContain('Nothing is waiting for a second person.');
    expect(s.text()).toContain('Nothing was confirmed in the last 7 days.');
  });
});

// D931 (piece P10): staff web addresses on a shared wallet waiting for a second person, confirmed here by another staff
// member with a reason (the API refuses the one who added them; its words are shown); what was confirmed in 7 days.
describe('the Platform queue’s second person (D931)', () => {
  const ME = { email: 'second@hana.example', sub: '22222222-3333-4444-8555-666666666666', env: 'sandbox-dev' };
  const queue = (c: Call, post: (c: Call) => Answer = () => ({ body: { confirmedAt: 1, changes: [] } })): Answer =>
    c.method === 'GET' && c.path === '/api/platform-queue' ? { body: platformQueue() } : c.method === 'POST' && c.path === '/api/platform/confirm-staff-origins' ? post(c) : notFound;
  const section = (s: ReturnType<typeof boot>, title: string) => [...s.main().querySelectorAll('section, .panel, .jp-card')].find((p) => p.querySelector('h2')?.textContent === title) as unknown as HTMLElement;

  it('lists each request on its app once: its web addresses (an internationalised one flagged), who added them, when its email went out, when it starts working', async () => {
    const s = boot('/platform-queue', (c) => queue(c), { me: () => ({ body: ME }) });
    await vi.waitFor(() => expect(s.text()).toContain('Waiting for a second person'));
    const p = section(s, 'Waiting for a second person');
    expect(p, 'the section').toBeTruthy();
    const rows = p.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(2);
    const first = rows[0]!.textContent ?? '';
    for (const words of ['https://menu.coffeeclub.example', 'https://café.example', 'IDN', 'https://xn--caf-dma.example', 'Coffee Club', 'Journear staff', '7335d417-61da-459d-899c-0a01c76a2b94', 'Confirm…']) expect(first, words).toContain(words);
    expect(first).toMatch(/in \d+ h/u);
    // Not emailed yet: it can't be confirmed yet, so no button.
    const second = rows[1]!.textContent ?? '';
    expect(second).toContain('Email not sent yet');
    expect(second).toContain('can’t be confirmed yet');
    expect(rows[1]!.querySelector('button')).toBeNull();
    expect(p.textContent).toContain('another staff member here, or an owner in the partner portal');
  });

  it('Confirm asks for a reason of at least 20 characters, then sends the request’s web addresses with it', async () => {
    const s = boot('/platform-queue', (c) => queue(c), { me: () => ({ body: ME }) });
    await vi.waitFor(() => expect(s.button('Confirm…')).toBeTruthy());
    s.button('Confirm…').click();
    const p = section(s, 'Waiting for a second person');
    const f = p.querySelector('form')!;
    const reason = f.querySelector('[name="reason"]') as unknown as HTMLTextAreaElement;
    // After PR 159's second review: the reason is shown to the organisation (its activity log), and the field says so.
    expect(f.textContent).toContain('The organisation’s members can read it in their activity log, so write nothing private.');
    reason.value = 'too short';
    s.submit(f);
    await vi.waitFor(() => expect(p.textContent).toContain('At least 20 characters (now 9).'));
    expect(s.api().filter((c) => c.method === 'POST')).toEqual([]);
    reason.value = 'Checked with Aisyah (owner) on a call to her listed number';
    s.submit(f);
    await vi.waitFor(() => expect(p.textContent).toContain('They start working at once.'));
    expect(p.textContent).toContain('Confirm these 2 web addresses for Coffee Club?');
    ([...p.querySelectorAll('.confirm button')].find((b) => b.textContent === 'Confirm') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.api().some((c) => c.method === 'POST')).toBe(true));
    const post = s.api().find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/platform/confirm-staff-origins');
    expect(post.body).toEqual({ orgId: 'org_01jc8lumenpay', appId: 'app_01jdplatcoffee', changeIds: ['gc_01jdstaff1', 'gc_01jdstaff2'], reason: 'Checked with Aisyah (owner) on a call to her listed number' });
    expect(post.headers['x-hana-admin']).toBe('1');
  });

  it('shows the API’s refusal in its own words (the staff member who added it can’t confirm it)', async () => {
    const words = 'The staff member who added this web address can’t confirm it: a second staff member, or an owner of the organisation, must';
    const s = boot('/platform-queue', (c) => queue(c, () => ({ status: 403, body: { error: { code: 'forbidden', message: words } } })), { me: () => ({ body: { ...ME, sub: '7335d417-61da-459d-899c-0a01c76a2b94' } }) });
    await vi.waitFor(() => expect(s.button('Confirm…')).toBeTruthy());
    const p = section(s, 'Waiting for a second person');
    expect(p.querySelector('tbody tr')!.textContent).toContain('(you)');
    s.button('Confirm…').click();
    const f = p.querySelector('form')!;
    (f.querySelector('[name="reason"]') as unknown as HTMLTextAreaElement).value = 'Confirming my own web addresses, which must fail';
    s.submit(f);
    await vi.waitFor(() => expect(p.querySelector('.confirm')).toBeTruthy());
    ([...p.querySelectorAll('.confirm button')].find((b) => b.textContent === 'Confirm') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.textContent).toContain(words));
  });

  it('lists what a second person confirmed in the last 7 days: who asked, who confirmed and when, removed since', async () => {
    const s = boot('/platform-queue', (c) => queue(c), { me: () => ({ body: ME }) });
    await vi.waitFor(() => expect(s.text()).toContain('Confirmed in the last 7 days'));
    const p = section(s, 'Confirmed in the last 7 days');
    const rows = p.querySelectorAll('tbody tr');
    expect(rows).toHaveLength(3);
    for (const words of ['https://pay.coffeeclub.example', 'Coffee Club', 'An owner', 'usr_01jcaisyah', 'Working']) expect(rows[0]!.textContent, words).toContain(words);
    // After PR 159's second review: whether the organisation was told (sent, retrying n, not told).
    expect(rows[0]!.textContent).toContain('Email retrying failed 2 times so far');
    expect(rows[1]!.textContent).toContain('Organisation told');
    expect(rows[2]!.textContent).toContain('Not told the email failed 170 times');
    expect(p.textContent).toContain('“Not told” means the email to the organisation kept failing for 7 days');
    // Who asked: the platform key, by its label and id (a public id, not a secret).
    expect(rows[0]!.textContent).toContain('Platform key');
    expect(rows[0]!.textContent).toContain(PREVIEW_KEY_ID);
    expect(rows[0]!.textContent).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/u);
    for (const words of ['https://old.tileshop.example', 'Journear staff', '22222222-3333-4444-8555-666666666666', '(you)', 'Removed since']) expect(rows[1]!.textContent, words).toContain(words);
    // Each row leads to its app, where staff suspend it or remove the web address.
    expect(rows[0]!.querySelector('a[href="/orgs/org_01jc8lumenpay/apps/app_01jdplatcoffee"]')).toBeTruthy();
    expect(p.textContent).toContain('open its app to suspend the app or remove the web address');
  });
});

describe('an app the platform created', () => {
  const answer = (detail: ReturnType<typeof appDetail>) => (c: Call): Answer => (c.method === 'GET' && c.path.startsWith('/api/apps/app_01jdplatcoffee') ? { body: detail } : c.method === 'GET' ? notFound : { body: { ok: true } });

  it('says it was created by the platform, names the key, and who holds the partner suspension', async () => {
    const s = boot('/orgs/org_lumen/apps/app_01jdplatcoffee', answer(appDetail('org_lumen', 'app_01jdplatcoffee')));
    await vi.waitFor(() => expect(s.text()).toContain('Created by the platform'));
    expect(s.text()).toContain('Made by the platform');
    expect(s.text()).toContain('pkc_Wk7Hq2Lm9Xc4Pz');
    expect(s.text()).toContain('held by the organisation’s backend (its platform key), which may lift it');
  });

  it('the mainnet demo switch on a shared wallet asks staff to confirm the shared wallet’s risk too', async () => {
    const s = boot('/orgs/org_lumen/apps/app_01jdplatcoffee', answer(appDetail('org_lumen', 'app_01jdplatcoffee')));
    await vi.waitFor(() => expect(s.button('Turn the mainnet demo on')).toBeTruthy());
    expect(s.text()).toContain('This app shares one wallet with other apps: turning it on asks you to confirm that too.');
    s.button('Turn the mainnet demo on').click();
    await vi.waitFor(() => expect(s.text()).toContain('This app shares one wallet with every app on its scope. Real money signed here comes from the same wallet as on the network’s other sites.'));
  });

  it('D931: adding web addresses says they wait 24 hours unless a second person confirms them', async () => {
    const s = boot('/orgs/org_lumen/apps/app_01jdplatcoffee', answer(appDetail('org_lumen', 'app_01jdplatcoffee')));
    await vi.waitFor(() => expect(s.text()).toContain('Propose origins'));
    expect(s.text()).toContain('On this app a web address you add waits 24 hours after its email unless a second person confirms it: another staff member in the Platform queue, or an owner in the partner portal. You can’t confirm your own.');
    const f = [...s.main().querySelectorAll('form')].find((x) => x.querySelector('[name="add"]'))!;
    (f.querySelector('[name="add"]') as unknown as HTMLInputElement).value = 'https://new.coffeeclub.example';
    s.submit(f);
    await vi.waitFor(() => expect(f.parentElement!.textContent).toContain('The security contacts and owners are emailed. On this app a web address you add waits 24 hours'));
  });

  it('an app on no shared wallet keeps the plain confirmation', async () => {
    const d = appDetail('org_lumen', 'app_01jdplatcoffee');
    d.app.sharedWallet = false;
    d.app.sharedScope = false;
    d.app.createdByKind = 'hana';
    const s = boot('/orgs/org_lumen/apps/app_01jdplatcoffee', answer(d));
    await vi.waitFor(() => expect(s.button('Turn the mainnet demo on')).toBeTruthy());
    s.button('Turn the mainnet demo on').click();
    await vi.waitFor(() => expect(s.text()).toContain('Turn the mainnet demo on? This test app’s users'));
    expect(s.text()).not.toContain('shares one wallet');
    expect(s.text()).not.toContain('Created by the platform');
    expect(s.text()).not.toContain('unless a second person confirms it');
  });
});

describe('the route words', () => {
  it('are console-core’s, word for word', () => {
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const block = /const ROUTE_WORDS = \{([\s\S]*?)\n\};/u.exec(source)![1]!;
    const pairs = [...block.matchAll(/^\s*'([A-Z]+) ([^']+)': '([^']+)',$/gmu)].map((m) => [m[1]!, m[2]!, m[3]!] as const);
    // Every line of the block was read, and the two maps hold the same routes (both directions) with the same words.
    expect(pairs).toHaveLength(block.trim().split('\n').length);
    const admin = Object.fromEntries(pairs.map(([method, route, words]) => [`${method} ${route}`, words]));
    expect(Object.keys(admin).sort()).toEqual(Object.keys(PLATFORM_ROUTE_WORDS).sort());
    for (const [k, words] of Object.entries(PLATFORM_ROUTE_WORDS)) expect(admin[k], k).toBe(words);
  });
});
