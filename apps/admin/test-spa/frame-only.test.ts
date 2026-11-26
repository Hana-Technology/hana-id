// D934 (piece P12): web addresses an app may use only inside its other web addresses (a network's widget). On an app's
// page each frame-only address carries the badge; any other (but the localhost wildcard) offers "Make it frame-only",
// a tightening at once behind a confirmation that says so and how to undo it; the staff add form's tick box marks every
// address of that request; the guarded changes and the Platform queue mark frame-only ones; an address without the
// field reads as usable anywhere, as before.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';
import { appDetail, platformQueue } from './preview-data.ts';

afterEach(closeWindow);

const BADGE = 'Only inside the app’s other web addresses';
const notFound: Answer = { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
const APP = '/orgs/org_lumen/apps/app_01jdplatcoffee';

function appPage(detail = appDetail('org_lumen', 'app_01jdplatcoffee'), post: (c: Call) => Answer = () => ({ body: { version: 4 } })) {
  return boot(APP, (c) => (c.method === 'GET' && c.path.startsWith('/api/apps/app_01jdplatcoffee') ? { body: detail } : c.method === 'POST' ? post(c) : notFound));
}
const originRow = (s: ReturnType<typeof boot>, origin: string) => [...s.main().querySelectorAll('tbody tr')].find((tr) => tr.querySelector('td')?.textContent?.startsWith(origin)) as unknown as HTMLElement;

describe('an app’s web addresses', () => {
  it('a frame-only one carries the badge, and no "Make it frame-only"; the others offer it, never the badge', async () => {
    const s = appPage();
    await vi.waitFor(() => expect(s.text()).toContain('Allowed origins'));
    const widget = originRow(s, 'https://widget.lumenpay.example');
    expect(widget.textContent).toContain(BADGE);
    expect([...widget.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Remove']);
    const page = originRow(s, 'https://coffeeclub.example');
    expect(page.textContent).not.toContain(BADGE);
    expect([...page.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Remove', 'Make it frame-only']);
    // The guarded change of the widget's address says so too; the others don't.
    const changes = [...s.main().querySelectorAll('tbody tr')].filter((tr) => tr.textContent?.includes('Add an origin'));
    expect(changes.filter((tr) => tr.textContent?.includes(BADGE)).map((tr) => tr.textContent?.includes('https://widget.lumenpay.example'))).toEqual([true]);
  });

  it('"Make it frame-only" asks first, says it is at once and how to undo it, then sends the one address with the version', async () => {
    const s = appPage();
    await vi.waitFor(() => expect(s.text()).toContain('Allowed origins'));
    const page = originRow(s, 'https://coffeeclub.example');
    ([...page.querySelectorAll('button')].find((b) => b.textContent === 'Make it frame-only') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(page.textContent).toContain('It takes effect at once'));
    expect(page.textContent).toContain('Make https://coffeeclub.example work only inside this app’s other web addresses? It takes effect at once: a page that opens it on its own can’t use the wallet any more. To undo it, remove it and add it again, which waits as any new web address does.');
    expect(s.api().filter((c) => c.method === 'POST')).toEqual([]);
    ([...page.querySelectorAll('.confirm button')].find((b) => b.textContent === 'Make it frame-only') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.api().some((c) => c.method === 'POST')).toBe(true));
    const post = s.api().find((c) => c.method === 'POST')!;
    expect(post.path).toBe('/api/apps/app_01jdplatcoffee/origins/frame-only');
    expect(post.body).toEqual({ orgId: 'org_lumen', origins: ['https://coffeeclub.example'], expectedVersion: 3 });
  });

  it('never for the localhost wildcard (a pattern, not a page); an address without the field reads as usable anywhere', async () => {
    const d = appDetail('org_lumen', 'app_01jdplatcoffee');
    d.app.origins = [
      { origin: 'http://localhost:*', display: 'http://localhost:*', idn: false, activeFrom: 1 },
      { origin: 'https://old.coffeeclub.example', display: 'https://old.coffeeclub.example', idn: false, activeFrom: 1 },
    ] as typeof d.app.origins;
    const s = appPage(d);
    await vi.waitFor(() => expect(s.text()).toContain('Allowed origins'));
    expect([...originRow(s, 'http://localhost:*').querySelectorAll('button')].map((b) => b.textContent)).toEqual(['Remove']);
    expect(originRow(s, 'https://old.coffeeclub.example').textContent).not.toContain(BADGE);
  });

  it('the add form’s tick box marks every address of the request; unticked, the request is the one it was', async () => {
    const s = appPage(undefined, () => ({ body: { version: 4, changes: [] } }));
    await vi.waitFor(() => expect(s.text()).toContain('Propose origins'));
    const f = [...s.main().querySelectorAll('form')].find((x) => x.querySelector('[name="add"]'))!;
    expect(f.textContent).toContain('Only inside the app’s other web addresses (a widget)');
    const add = f.querySelector('[name="add"]') as unknown as HTMLInputElement;
    const tick = f.querySelector('[name="frameOnly"]') as unknown as HTMLInputElement;
    expect(tick.type).toBe('checkbox');
    expect(tick.checked).toBe(false);
    const send = async () => {
      s.submit(f);
      await vi.waitFor(() => expect(f.querySelector('.confirm')).toBeTruthy());
      (f.querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    };
    add.value = 'https://widget2.lumenpay.example https://w3.lumenpay.example';
    tick.checked = true;
    await send();
    await vi.waitFor(() => expect(s.api().filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(s.api().find((c) => c.method === 'POST')!.body).toEqual({ orgId: 'org_lumen', add: ['https://widget2.lumenpay.example', 'https://w3.lumenpay.example'], frameOnly: ['https://widget2.lumenpay.example', 'https://w3.lumenpay.example'], expectedVersion: 3 });
  });

  it('unticked: no frameOnly field at all', async () => {
    const s = appPage(undefined, () => ({ body: { version: 4, changes: [] } }));
    await vi.waitFor(() => expect(s.text()).toContain('Propose origins'));
    const f = [...s.main().querySelectorAll('form')].find((x) => x.querySelector('[name="add"]'))!;
    (f.querySelector('[name="add"]') as unknown as HTMLInputElement).value = 'https://shop.coffeeclub.example';
    s.submit(f);
    await vi.waitFor(() => expect(f.querySelector('.confirm')).toBeTruthy());
    (f.querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(s.api().filter((c) => c.method === 'POST')).toHaveLength(1));
    expect(s.api().find((c) => c.method === 'POST')!.body).toEqual({ orgId: 'org_lumen', add: ['https://shop.coffeeclub.example'], expectedVersion: 3 });
  });
});

describe('the Platform queue', () => {
  it('marks a frame-only web address waiting, and in the second-person and confirmed lists when the row says so', async () => {
    const q = platformQueue();
    const body = { ...q, secondPerson: q.secondPerson.map((o, i) => (i === 0 ? { ...o, frameOnly: true } : o)) };
    const s = boot('/platform-queue', (c) => (c.path === '/api/platform-queue' ? { body } : notFound));
    await vi.waitFor(() => expect(s.text()).toContain('Web addresses waiting'));
    const rows = [...s.main().querySelectorAll('tbody tr')];
    const marked = rows.filter((tr) => tr.textContent?.includes(BADGE));
    expect(marked.map((tr) => (tr.textContent?.includes('https://widget.lumenpay.example') ? 'widget' : tr.textContent?.includes('https://menu.coffeeclub.example') ? 'menu' : 'other'))).toEqual(['widget', 'menu']);
    expect(rows.find((tr) => tr.textContent?.includes('https://order.coffeeclub.example'))!.textContent).not.toContain(BADGE);
  });
});
