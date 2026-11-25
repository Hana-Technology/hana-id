// D930 (docs/partner-platform-spec.md A11, piece P5): the staff portal's platform screens. The org page's Platform keys
// panel shows the org's limits, each key's last use and the Activity (each call: what, the app, the key, the result,
// the caller's network, the request id; Older pages back); the Platform queue lists every waiting web address and key
// across orgs, soonest first, with an internationalised address flagged; an app the platform created says so, names
// who holds its partner suspension, and its mainnet demo switch asks staff to confirm the shared wallet's risk (H3).
// The route words are the same as console-core's (platform-words.ts).
import { readFileSync } from 'node:fs';
import { platformRouteWords } from '@hana-id/console-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';
import { appDetail, orgPlatform, platformCalls, platformQueue } from './preview-data.ts';

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
    const s = boot('/platform-queue', (c) => (c.path === '/api/platform-queue' ? { body: { origins: [], keys: [] } } : notFound));
    await vi.waitFor(() => expect(s.text()).toContain('No web address waiting.'));
    expect(s.text()).toContain('No platform key waiting.');
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
  });
});

describe('the route words', () => {
  it('are console-core’s, word for word', () => {
    const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
    const block = /const ROUTE_WORDS = \{([\s\S]*?)\n\};/u.exec(source)![1]!;
    const pairs = [...block.matchAll(/^\s*'([A-Z]+) ([^']+)': '([^']+)',$/gmu)].map((m) => [m[1]!, m[2]!, m[3]!] as const);
    expect(pairs).toHaveLength(block.trim().split('\n').length);
    expect(pairs.length).toBe(11);
    for (const [method, route, words] of pairs) expect(words, `${method} ${route}`).toBe(platformRouteWords(method, route));
  });
});
