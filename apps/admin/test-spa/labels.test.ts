// "Partner labels" (D894) as the browser runs public/app.js (boot.ts), over the Worker's own answers for the preview
// set (test-spa/preview-labels.ts runs src/partner-labels.ts): the nav item, the feed (waiting first, each change's
// state in words, the organisation and apps, what users would see and the diff), the partner's words as text only, the
// detail page's Block and Allow (a note required, the confirmation naming the consequence, the exact request with the
// page's token and what it saw, the answer at the top after a fresh read), a blocked change, the switches, Feed and
// notices' count, and the System status tile with a switch off (test-spa/preview-status.ts `labels-off`).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

type Fake = { status: number; body: unknown };
type Labels = {
  previewLabels: () => Promise<Fake>;
  previewLabel: (id: string) => Promise<Fake>;
  previewLabelAct: (id: string, body: Record<string, unknown>) => Promise<Fake>;
  previewLabelControl: (body: Record<string, unknown>) => Promise<Fake>;
  resetPreviewLabels: () => void;
};
/** Harbour Pay's tills in the preview set (preview-labels.ts, not imported here: it is the Worker's code). */
const HARBOUR_TILL = 'GDGXQACKG7AOXXIO4JFXPVAOUHWB2VBNI62EQ6HHYWWVCRDQX3OEH5GS';
const HARBOUR_KIOSK = 'GCVFJJYF75734IR7PQB2IOI3C3RDQ66D6OMVMJG2DRO4VBN66ODCE76B';
const MODULE = './preview-labels.ts';
const STATUS = './preview-status.ts';
let feed: Fake;
const detail: Record<string, Fake> = {};
const after: Record<string, Fake> = {};
const acts: Record<string, Fake> = {};
let status: Record<string, unknown>;
const NOTE = 'The words hide that the call moves money';

beforeAll(async () => {
  const m = (await import(MODULE)) as Labels;
  m.resetPreviewLabels();
  feed = await m.previewLabels();
  for (const id of ['lc_previewannounced', 'lc_previewreview', 'lc_previewblocked', 'lc_previewlive']) detail[id] = await m.previewLabel(id);
  const page = (id: string) => detail[id]!.body as { token: string; item: { labelsVersion: number; change: { state: string } } };
  const seen = (id: string) => ({ labelsVersion: page(id).item.labelsVersion, state: page(id).item.change.state });
  acts.block = await m.previewLabelAct('lc_previewannounced', { token: page('lc_previewannounced').token, tool: 'block', note: NOTE, seen: seen('lc_previewannounced') });
  after.block = await m.previewLabel('lc_previewannounced');
  // The same page again: the change moved.
  acts.stale = await m.previewLabelAct('lc_previewannounced', { token: page('lc_previewannounced').token, tool: 'block', note: NOTE, seen: seen('lc_previewannounced') });
  acts.allow = await m.previewLabelAct('lc_previewreview', { token: page('lc_previewreview').token, tool: 'allow', note: 'Read the line: it says what the call does', seen: seen('lc_previewreview') });
  after.allow = await m.previewLabel('lc_previewreview');
  acts.off = await m.previewLabelControl({ token: (feed.body as { token: string }).token, target: { kind: 'all' }, what: 'off', note: 'A partner’s words mislead users', seenVersion: 0 });
  m.resetPreviewLabels();
  const s = (await import(STATUS)) as { previewStatus: (s: string) => Promise<Record<string, unknown>> };
  status = await s.previewStatus('labels-off');
});

const api = (more: (c: Call) => Answer | null = () => null) => (c: Call): Answer => {
  const m = more(c);
  if (m) return m;
  if (c.method === 'GET' && c.path === '/api/labels') return { status: feed.status, body: feed.body };
  const d = /^\/api\/labels\/(lc_[A-Za-z0-9]+)$/u.exec(c.path);
  if (c.method === 'GET' && d && detail[d[1]!]) return { status: detail[d[1]!]!.status, body: detail[d[1]!]!.body };
  return { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } };
};
const ready = (p: ReturnType<typeof boot>, text: string) => vi.waitFor(() => expect(p.text()).toContain(text));
const itemOf = (p: ReturnType<typeof boot>, id: string) => p.main().querySelector(`.label-item[data-change="${id}"]`)!;
const toolOf = (p: ReturnType<typeof boot>, name: string) => [...p.main().querySelectorAll('.tool')].find((t) => t.querySelector('h3')!.textContent === name)!;

describe('the Partner labels screen', () => {
  it('is in the Security group, after Feed and notices, and marked current', async () => {
    const p = boot('/labels', api());
    await ready(p, 'Waiting');
    const security = [...p.doc.querySelectorAll('#nav .nav-group')].find((g) => g.querySelector('h2')!.textContent === 'Security')!;
    expect([...security.querySelectorAll('a')].map((a) => [a.textContent, a.getAttribute('href')])).toContainEqual(['Partner labels', '/labels']);
    expect([...p.doc.querySelectorAll('#nav a[aria-current=page]')].map((a) => a.textContent)).toEqual(['Partner labels']);
    expect(p.main().querySelector('h1')!.textContent).toBe('Partner labels');
  });

  it('the feed: waiting first (soonest live first), each state in words, then what was decided', async () => {
    const p = boot('/labels', api());
    await ready(p, 'Decided in the last 14 days');
    const [waiting, decided] = [...p.main().querySelectorAll('.label-feed')];
    const states = (ol: (typeof waiting)) => [...ol!.querySelectorAll('.label-item')].map((li) => [li.getAttribute('data-change'), li.querySelector('.label-item-head .jp-badge')!.textContent]);
    const w = states(waiting);
    expect(w.map((x) => x[0])).toEqual(['lc_previewreview', 'lc_previewannounced', 'lc_previewproposed']);
    expect(w[0]![1]).toMatch(/^Waiting for a staff Allow \(lapses \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC\)$/u);
    expect(w[1]![1]).toMatch(/^Goes live \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(in (19|20) h \d+ min\)$/u);
    expect(w[2]![1]).toMatch(/^Waiting for the notice email/u);
    expect(states(decided)).toEqual([
      ['lc_previewblocked', 'Blocked by staff'],
      ['lc_previewcancelled', 'Cancelled by the partner'],
      ['lc_previewlive', 'Live'],
    ]);
  });

  it('each change: the organisation by name, the apps, what users would see (example values) and the diff against what users see now, and its page', async () => {
    const p = boot('/labels', api());
    await ready(p, 'Waiting');
    const li = itemOf(p, 'lc_previewproposed');
    expect(li.querySelector('.jp-kv')!.textContent).toContain('OrganisationLumen Labsorg_01jdzlumen');
    expect(li.querySelector('.jp-kv')!.textContent).toContain('AppsStamps Clubapp_01jdzstamps');
    expect([...li.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['What users would see (example values)', 'Compared with what users see now']);
    expect([...li.querySelectorAll('.label-line')].map((x) => x.textContent)).toEqual(['Stamps Club says: claim the stamp “Fare paid”', 'Stamps Club says: redeem 3 stamps for a free coffee']);
    expect([...li.querySelectorAll('.label-rows')].map((dl) => dl.textContent)).toEqual(['Stamp“Fare paid”', 'Stamps3RewardFree coffee']);
    expect(li.querySelector('.label-preview .hint')!.textContent).toBe('NEAR test network, stamps-club.testnet. The values are made-up examples.');
    const diff = [...li.querySelectorAll('.label-diff li')].map((x) => x.textContent);
    expect(diff).toEqual([
      'Unchanged NEAR test network, stamps-club.testnet',
      'Changed Before: Stamps Club says: collect the stamp “Fare paid” · Stamp: “Fare paid”Now: Stamps Club says: claim the stamp “Fare paid” · Stamp: “Fare paid”',
      'Unchanged Stamps Club says: redeem 3 stamps for a free coffee · Stamps: 3 · Reward: Free coffee',
    ]);
    expect(li.querySelector('a[href="/labels/lc_previewproposed"]')!.textContent).toBe('Open lc_previewproposed');
  });

  it('a payment: the line with the till’s name, every account with its name and whole address, and a renamed account as a change (PR 135’s review)', async () => {
    const p = boot('/labels', api());
    await ready(p, 'Waiting');
    const li = itemOf(p, 'lc_previewreview');
    expect([...li.querySelectorAll('.label-line')].map((x) => x.textContent)).toEqual([`Harbour Pay says: pay for order “1042” to “Harbour till” (${HARBOUR_TILL})`]);
    expect([...li.querySelectorAll('.label-accounts li')].map((x) => x.textContent)).toEqual([`Account “Harbour till” (${HARBOUR_TILL})`, `Account “Harbour stall” (${HARBOUR_KIOSK})`]);
    const diff = [...li.querySelectorAll('.label-diff li')].map((x) => x.textContent);
    expect(diff).toContain(`Changed Before: Account “Harbour kiosk” (${HARBOUR_KIOSK})Now: Account “Harbour stall” (${HARBOUR_KIOSK})`);
    expect(diff).toContain(`Unchanged Account “Harbour till” (${HARBOUR_TILL})`);
  });

  it('the partner’s words are text, never markup', async () => {
    const body = structuredClone(feed.body) as { items: { change: { id: string }; preview: { formats: { line: string; fields: { label: string; value: string }[] }[] }; diff: { after: string | null }[] }[] };
    const it0 = body.items.find((i) => i.change.id === 'lc_previewannounced')!;
    it0.preview.formats[0]!.line = 'Stamps Club says: <img src=x onerror="alert(1)"> collect';
    it0.preview.formats[0]!.fields[0]!.label = '<b>Stamp</b>';
    it0.diff[1]!.after = '<script>alert(2)</script>';
    const p = boot('/labels', api((c) => (c.method === 'GET' && c.path === '/api/labels' ? { body } : null)));
    await ready(p, 'Waiting');
    const li = itemOf(p, 'lc_previewannounced');
    expect(li.querySelector('img, b, script')).toBeNull();
    expect(li.textContent).toContain('Stamps Club says: <img src=x onerror="alert(1)"> collect');
    expect(li.textContent).toContain('<script>alert(2)</script>');
    expect(p.dialogs).toEqual([]);
  });

  it('the switches: every partner label, review for everyone, the organisations with a switch, the sets switched off', async () => {
    const p = boot('/labels', api());
    await ready(p, 'Switches');
    expect(toolOf(p, 'Every partner label').textContent).toContain('On Partners’ words show in the approval window once each change passes its wait.');
    expect(toolOf(p, 'Staff review for everyone').textContent).toContain('Off Changes go live at their time unless staff block them.');
    const tables = [...p.main().querySelectorAll('table')].map((t) => t.textContent);
    expect(tables.some((t) => t!.includes('Harbour Pay Ltd') && t!.includes('Required') && t!.includes('New partner: every change reviewed for the first month'))).toBe(true);
    expect(tables.some((t) => t!.includes('pl_01jdzstamps4') && t!.includes('Reported by a user as confusing'))).toBe(true);
    expect(p.buttons('Turn back on…')).toHaveLength(1);
    expect(p.buttons('Review off…')).toHaveLength(1);
  });

  it('Switch every partner label off: a note, the consequence confirmed, the exact request (the page’s token, the version it read)', async () => {
    const sent: Call[] = [];
    const p = boot('/labels', api((c) => (c.method === 'POST' ? (sent.push(c), { body: acts.off!.body }) : null)));
    await ready(p, 'Switches');
    const tool = toolOf(p, 'Every partner label');
    p.submit(tool.querySelector('form'));
    expect(sent).toEqual([]);
    expect(tool.querySelector('.jp-field.is-invalid')).not.toBeNull();
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'A partner’s words mislead users';
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('Switch every partner label off? Users of every partner’s apps see the plain approval window, without the partner’s words, until staff turn them back on.');
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!).toMatchObject({ path: '/api/labels/controls', body: { token: (feed.body as { token: string }).token, target: { kind: 'all' }, what: 'off', note: 'A partner’s words mislead users', seenVersion: 0 } });
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(p.main().querySelector('.act-result')!.textContent).toContain('Switched offUsers of every partner’s apps now see the plain approval window, without the partner’s words.');
  });
});

describe('one change’s page', () => {
  it('Block: the note is required, the confirmation says users never see it and the partner is told, the request carries the token and what the page saw', async () => {
    const sent: Call[] = [];
    let blocked = false;
    const p = boot('/labels/lc_previewannounced', api((c) => {
      if (c.method === 'POST') return sent.push(c), (blocked = true), { body: acts.block!.body };
      if (blocked && c.path === '/api/labels/lc_previewannounced') return { body: after.block!.body };
      return null;
    }));
    await ready(p, 'Staff tools');
    expect(p.main().querySelector('h1')!.textContent).toBe('Partner label change');
    const tool = toolOf(p, 'Block this change');
    expect(toolOf(p, 'Allow')).toBeUndefined();
    const label = tool.querySelector('label')!.textContent;
    expect(label).toBe('Why (everyone in the partner’s organisation can read this note; it is kept in the audit log)');
    // D899: the note is visible to every member of the partner's organisation, on the console, for 14 days.
    expect(tool.textContent).toContain('everyone in their organisation on the console’s Request labels tab for 14 days');
    const input = tool.querySelector('input[name=note]') as unknown as HTMLInputElement;
    expect([input.getAttribute('minlength'), input.getAttribute('maxlength'), input.hasAttribute('required')]).toEqual(['10', '300', true]);
    input.value = 'too short';
    p.submit(tool.querySelector('form'));
    expect(sent).toEqual([]);
    expect(tool.querySelector('.confirm')).toBeNull();
    input.value = NOTE;
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('Block this change? Users will never see it, and the partner is told Journear blocked it.');
    expect(sent).toEqual([]);
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const d = detail.lc_previewannounced!.body as { token: string; item: { labelsVersion: number } };
    expect(d.token).toMatch(/^lblact_[A-Za-z0-9_-]{22}$/u);
    expect(sent[0]!).toMatchObject({ path: '/api/labels/lc_previewannounced/act', body: { token: d.token, tool: 'block', note: NOTE, seen: { labelsVersion: d.item.labelsVersion, state: 'announced' } } });
    expect(sent[0]!.headers['x-hana-admin']).toBe('1');
    // The page is read again: the answer on top, the change now blocked, no tool left.
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(p.main().querySelector('.act-result')!.textContent).toBe('BlockedUsers will never see this change. The partner’s security contacts are emailed within about 5 minutes, with your note.');
    expect(p.text()).toContain('Blocked by staff');
    expect(toolOf(p, 'Block this change')).toBeUndefined();
    expect(p.dialogs).toEqual([]);
  });

  it('a change in force: Block says users stop seeing it at once', async () => {
    const p = boot('/labels/lc_previewlive', api());
    await ready(p, 'Staff tools');
    const tool = toolOf(p, 'Block this change');
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = NOTE;
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('Block this change? Users stop seeing it at once, and the partner is told Journear blocked it.');
    expect(p.text()).toContain('Shown to users nowYes');
  });

  it('one set of labels’ own switch on its change’s page: off with a note, the entry’s switch version, the controls route', async () => {
    const sent: Call[] = [];
    const p = boot('/labels/lc_previewlive', api((c) => (c.method === 'POST' ? (sent.push(c), { body: { result: { changed: true }, words: { tone: 'ok', title: 'Switched off', text: '' } } }) : null)));
    await ready(p, 'Staff tools');
    const tool = toolOf(p, 'Switch these labels off');
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = NOTE;
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('Switch these labels off? Users of these apps see the plain approval window, without the partner’s words, until staff turn them back on.');
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const d = detail.lc_previewlive!.body as { token: string; item: { entryVersion: number; change: { labelId: string } } };
    expect(sent[0]!.path).toBe('/api/labels/controls');
    expect(sent[0]!.body).toEqual({ token: d.token, target: { kind: 'entry', labelId: d.item.change.labelId }, what: 'off', note: NOTE, seenVersion: d.item.entryVersion });
  });

  it('Allow, while review is required: a note, the confirmation, the request; it is the page’s one primary action', async () => {
    const sent: Call[] = [];
    let allowed = false;
    const p = boot('/labels/lc_previewreview', api((c) => {
      if (c.method === 'POST') return sent.push(c), (allowed = true), { body: acts.allow!.body };
      if (allowed && c.path === '/api/labels/lc_previewreview') return { body: after.allow!.body };
      return null;
    }));
    await ready(p, 'Staff tools');
    const tool = toolOf(p, 'Allow');
    expect([...p.main().querySelectorAll('.jp-btn-primary')].map((b) => b.textContent)).toEqual(['Allow']);
    p.submit(tool.querySelector('form'));
    expect(sent).toEqual([]);
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'Read the line: it says what the call does';
    p.submit(tool.querySelector('form'));
    expect(tool.querySelector('.confirm')!.textContent).toContain('Allow this change? It goes live at its time, or at once if its time has passed.');
    (tool.querySelector('.confirm button') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    const d = detail.lc_previewreview!.body as { token: string; item: { labelsVersion: number } };
    expect(sent[0]!.body).toEqual({ token: d.token, tool: 'allow', note: 'Read the line: it says what the call does', seen: { labelsVersion: d.item.labelsVersion, state: 'waiting_review' } });
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(p.main().querySelector('.act-result')!.textContent).toBe('AllowedIts time had already passed, so it is live now.');
    expect(p.text()).toContain('Live');
  });

  it('a page that moved: the plain words on top, the page read again, nothing sent again', async () => {
    let n = 0;
    const p = boot('/labels/lc_previewannounced', api((c) => (c.method === 'POST' ? (n++, { status: acts.stale!.status, body: acts.stale!.body }) : null)));
    await ready(p, 'Staff tools');
    const reads = () => p.calls.filter((c) => c.method === 'GET' && c.path === '/api/labels/lc_previewannounced').length;
    const tool = toolOf(p, 'Block this change');
    (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = NOTE;
    p.submit(tool.querySelector('form'));
    (tool.querySelector('.confirm .jp-btn-danger') as unknown as HTMLButtonElement).click();
    await vi.waitFor(() => expect(p.main().querySelector('.act-result')).not.toBeNull());
    expect(acts.stale!.status).toBe(409);
    expect(p.main().querySelector('.act-result')!.textContent).toContain('Block this change: Someone changed this first');
    expect(p.main().querySelector('.act-result')!.textContent).toContain('This change moved since you opened the page (someone may have acted, or it went live). Nothing was done. Reload the page and look again. The page has been read again.');
    expect(reads()).toBe(2);
    expect(n).toBe(1);
  });

  it('a blocked change: its note, no tool, nothing to do', async () => {
    const p = boot('/labels/lc_previewblocked', api());
    await ready(p, 'Staff tools');
    expect(p.text()).toContain('Blocked by staff');
    expect(p.text()).toContain('“The line says “collect a stamp” but the call sends 5 NEAR”');
    expect(p.main().querySelectorAll('.tool')).toHaveLength(0);
    expect(p.text()).toContain('Nothing to do: this change is blocked by staff.');
    expect(p.main().querySelectorAll('form')).toHaveLength(0);
  });
});

describe('plain staff words (D853, D879)', () => {
  /** evm-relay.test.ts's rule, and no code or protocol word in a staff sentence (ids are data, not sentences). */
  const STAFF_JARGON = /\bnonce\b|\bRPC\b|\bmempool\b|\bEVM\b|halted|EIP|delegate|_|\bschema\b|\bJSON\b/iu;
  it('the screen’s and the page’s own sentences: headings, hints, tool texts, field labels, states and confirmations', async () => {
    const said: string[] = [];
    const collect = (p: ReturnType<typeof boot>) => {
      for (const el of p.main().querySelectorAll('h1, h2, h3, .subtitle, .panel > .hint, .tool > p, .jp-label, .jp-hint, .jp-empty, .label-item-head .jp-badge, .label-diff .jp-badge')) said.push(el.textContent ?? '');
    };
    let p = boot('/labels', api());
    await ready(p, 'Switches');
    collect(p);
    for (const name of ['Every partner label', 'Staff review for everyone']) {
      const tool = toolOf(p, name);
      (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'A note long enough';
      p.submit(tool.querySelector('form'));
      said.push(tool.querySelector('.confirm')!.textContent ?? '');
    }
    await closeWindow();
    for (const id of ['lc_previewlive', 'lc_previewreview', 'lc_previewblocked']) {
      p = boot(`/labels/${id}`, api());
      await ready(p, 'Staff tools');
      collect(p);
      for (const tool of p.main().querySelectorAll('.tool')) {
        (tool.querySelector('input[name=note]') as unknown as HTMLInputElement).value = 'A note long enough';
        p.submit(tool.querySelector('form'));
        said.push(tool.querySelector('.confirm')!.textContent ?? '');
      }
      await closeWindow();
    }
    expect(said.length).toBeGreaterThan(40);
    for (const t of said.filter((x) => !/^Open lc|^Labels$/u.test(x))) expect(t, t).not.toMatch(STAFF_JARGON);
  });
});

describe('elsewhere', () => {
  it('Feed and notices: how many changes wait, and the link', async () => {
    const security = { notices: { changes: [], members: [] }, labels: { waiting: 3, awaitingAllow: 1, notAnnounced: 1, nextLiveAt: null }, unnotifiedEvents: [], feed: null, watcher: null, lastRun: null, opsError: null, ledger: { error: 'off' } };
    const p = boot('/security', (c) => (c.path === '/api/security' ? { body: security } : { status: 404, body: {} }));
    await ready(p, 'Partner label changes waiting');
    const panel = [...p.main().querySelectorAll('section.panel')].find((s) => s.querySelector('h2')!.textContent === 'Partner label changes waiting')!;
    expect(panel.querySelector('p:not(.hint)')!.textContent).toBe('3 waiting, 1 of them for a staff Allow, 1 not yet emailed to the partner. Open Partner labels');
    expect(panel.querySelector('a')!.getAttribute('href')).toBe('/labels');
  });

  it('System status: the Partner labels tile with a switch off, who and when, and its issue pointing to the screen', async () => {
    const p = boot('/', (c) => (c.path === '/api/status' ? { body: status } : { status: 404, body: {} }));
    await vi.waitFor(() => expect(p.main().querySelector('.verdict')).not.toBeNull());
    const tile = [...p.main().querySelectorAll('.tile')].find((t) => t.querySelector('h3')!.textContent === 'Partner labels')!;
    expect([tile.className, tile.querySelector('.state-chip')!.textContent, tile.querySelector('.tile-detail')!.textContent]).toEqual(['tile warning', 'Warning', 'Switched off for 1 organisation · 1 set switched off']);
    const lines = [...tile.querySelectorAll('.tile-lines li')].map((li) => [li.querySelector('.state-chip')!.textContent, li.querySelector('.tile-line-label')!.textContent, li.lastElementChild!.textContent]);
    expect(lines[0]).toEqual(['Off', 'Organisation org_01jdzharbour', expect.stringMatching(/^Switched off by tze@hana\.example, \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC \(50 min ago\)$/u)]);
    expect(lines[1]![1]).toBe('Labels pl_01jdzstamps4 (organisation org_01jdzlumen)');
    expect(tile.querySelector('a')!.getAttribute('href')).toBe('/labels');
    const issue = [...p.main().querySelectorAll('.issue')].find((i) => i.textContent!.includes('Partner labels are switched off'))!;
    expect(issue.querySelector('strong')!.textContent).toBe('Partner labels are switched off for 1 organisation; 1 set of partner labels is switched off');
    expect(issue.querySelector('.issue-action')!.textContent).toBe('Users of those apps see the plain approval window, without the partner’s words. To turn a switch back on, open Partner labels.');
    expect(issue.querySelector('.issue-links a')!.getAttribute('href')).toBe('/labels');
  });
});
