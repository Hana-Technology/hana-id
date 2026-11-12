// The System status page (D425; apps/admin/README.md "System status"), run as the browser runs public/app.js
// (boot.ts), over the answers the Worker's own `buildStatus` gives for the preview scenarios (test-spa/preview-status.ts):
// the landing page and its nav item, the verdict, the issues critical first with what each affects, since when and
// where to go, one tile per component, unknown never shown as green, text only (a hostile string stays text), links
// only to the console's own paths, read only (its one button reads again), and an error said in plain words.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { type Answer, type Call, boot, closeWindow } from './boot.ts';

afterEach(closeWindow);

type Scenario = 'green' | 'warnings' | 'critical' | 'mixed-build' | 'watchdog-down';
// Loaded by a specifier TypeScript doesn't follow (its module needs the Workers types; test-ops/ typechecks it).
const MODULE = './preview-status.ts';
const answers = {} as Record<Scenario, Record<string, unknown>>;
beforeAll(async () => {
  const { previewStatus } = (await import(MODULE)) as { previewStatus: (s: Scenario) => Promise<Record<string, unknown>> };
  for (const s of ['green', 'warnings', 'critical', 'mixed-build', 'watchdog-down'] as const) answers[s] = await previewStatus(s);
});

const statusApi = (body: unknown) => (c: Call): Answer => (c.path === '/api/status' ? { body } : { status: 404, body: { error: { code: 'not_found', message: 'Not found' } } });
const open = async (body: unknown, path = '/') => {
  const s = boot(path, statusApi(body));
  await vi.waitFor(() => expect(s.main().querySelector('.verdict')).not.toBeNull());
  return s;
};
const tiles = (s: Awaited<ReturnType<typeof open>>) => [...s.main().querySelectorAll('.tile')].map((t) => ({ cls: t.className, chip: t.querySelector('.state-chip')!.textContent, name: t.querySelector('h3')!.textContent }));

describe('the landing page', () => {
  it('is the System status page at /, with Status first in the nav and marked current', async () => {
    const s = await open(answers.green);
    expect(s.main().querySelector('h1')!.textContent).toBe('System status');
    expect(s.doc.querySelector('#nav .nav-group h2')!.textContent).toBe('Overview');
    expect([...s.doc.querySelectorAll('#nav a[aria-current=page]')].map((a) => a.textContent)).toEqual(['Status']);
    expect(s.api().map((c) => `${c.method} ${c.path}`)).toEqual(['GET /api/status']);
  });

  it('/status is the same page', async () => {
    const s = await open(answers.green, '/status');
    expect(s.main().querySelector('h1')!.textContent).toBe('System status');
  });
});

describe('the stats strip (the design system’s, under the verdict)', () => {
  it('counts the checks by state, the same counts as the tiles', async () => {
    const s = await open(answers.warnings);
    const strip = s.main().querySelector('.verdict + .jp-stats')!;
    expect(strip).not.toBeNull();
    const cells = [...strip.querySelectorAll('.jp-statcell')].map((c) => [c.querySelector('.k')!.textContent, c.querySelector('.v')!.textContent]);
    const t = tiles(s);
    const n = (chip: string) => String(t.filter((x) => x.chip === chip).length);
    expect(cells).toEqual([
      ['Checks passed', `${n('OK')} of ${t.length - Number(n('Not measured'))}`],
      ['Critical', n('Critical')],
      ['Warnings', n('Warning')],
      ['Unknown', n('Unknown')],
      ['Not measured', n('Not measured')],
    ]);
    expect(Number(n('Warning'))).toBeGreaterThan(0);
  });
});

describe('the verdict', () => {
  it('all green: “All systems operational” in green, no issues panel, every tile OK or not measured', async () => {
    const s = await open(answers.green);
    const v = s.main().querySelector('.verdict')!;
    expect(v.className).toBe('verdict ok');
    expect(v.getAttribute('role')).toBe('status');
    expect(v.querySelector('h2')!.textContent).toBe('All systems operational');
    expect(v.textContent).toMatch(/Checked \d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC · \d+ s ago · 36 of 36 checks passed/u);
    expect(s.text()).not.toContain('Issues');
    for (const t of tiles(s)) expect(['OK', 'Not measured'], t.name!).toContain(t.chip);
    expect(s.text()).toContain('Not measured yet');
  });

  it('warnings only: amber, “N issues”, each issue a warning', async () => {
    const s = await open(answers.warnings);
    const v = s.main().querySelector('.verdict')!;
    expect(v.className).toBe('verdict warning');
    const n = s.main().querySelectorAll('.issue').length;
    expect(n).toBeGreaterThanOrEqual(3);
    expect(v.querySelector('h2')!.textContent).toBe(`${n} issues`);
    expect([...s.main().querySelectorAll('.issue')].every((i) => i.className === 'issue warning')).toBe(true);
  });

  it('an outage: red, critical issues first, each with what it affects, since when, where and what to do', async () => {
    const s = await open(answers.critical);
    expect(s.main().querySelector('.verdict')!.className).toBe('verdict critical');
    const items = [...s.main().querySelectorAll('.issue')];
    const sev = items.map((i) => i.className.replace('issue ', ''));
    expect(sev).toEqual([...sev].sort((a, b) => (a === b ? 0 : a === 'critical' ? -1 : 1)));
    expect(sev[0]).toBe('critical');
    const api = items.find((i) => i.textContent!.includes('API is down'))!;
    expect(api.querySelector('.jp-badge')!.textContent).toBe('Critical');
    expect(api.textContent).toContain('AffectsEvery login, wallet and partner app');
    expect(api.textContent).toMatch(/First seen\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC/u);
    expect(api.querySelector('.issue-action')!.textContent).toContain('wrangler rollback');
    // An alert's issue: since its source time, with the screen and the playbook.
    const alert = items.find((i) => i.textContent!.includes('Watchdog alert #14'))!;
    expect(alert.textContent).toMatch(/Since\d{4}-/u);
    const hrefs = [...alert.querySelectorAll('a')].map((a) => a.getAttribute('href'));
    expect(hrefs).toEqual(['/security/monitoring', expect.stringMatching(/^\/security\/playbooks\//u)]);
  });

  it('a mixed-build deploy names the pieces on the other build', async () => {
    const s = await open(answers['mixed-build']);
    expect(s.text()).toMatch(/Mixed builds: Vault Worker, Vault bundle \(vault\.js\), Auth Worker, Auth pages on 22a4d7f90b1e; the rest on 8a797fe1c2d3/u);
    const t = tiles(s).find((x) => x.name === 'Same build everywhere')!;
    expect(t.chip).toBe('Warning');
  });
});

describe('unknown is never green', () => {
  it('the watchdog unreachable: its tile red, what it reports Unknown (grey, never the OK style), the verdict red', async () => {
    const s = await open(answers['watchdog-down']);
    expect(s.main().querySelector('.verdict')!.className).toBe('verdict critical');
    const unknown = tiles(s).filter((t) => t.chip === 'Unknown');
    expect(unknown.map((t) => t.name)).toEqual(expect.arrayContaining(['Watchdog checks', 'Relayer balance', 'Session pool keys', 'Owner pool keys', 'Watchdog every 5 min']));
    for (const t of unknown) {
      expect(t.cls).toBe('tile unknown');
      expect(t.cls).not.toContain('ok');
    }
    expect(tiles(s).find((t) => t.name === 'Watchdog')!.chip).toBe('Critical');
  });

  it('a tile the answer marks unknown keeps the verdict from saying operational, whatever the counts say', async () => {
    const a = structuredClone(answers.green) as { verdict: Record<string, unknown>; groups: { tiles: { state: string }[] }[] };
    a.groups[0]!.tiles[0]!.state = 'unknown';
    const s = await open(a);
    expect(s.main().querySelector('.tile')!.className).toBe('tile unknown');
    expect(s.main().querySelector('.tile .state-chip')!.textContent).toBe('Unknown');
    // An unrecognised state is shown as unknown too, never as OK.
    a.groups[0]!.tiles[0]!.state = 'fine';
    await closeWindow();
    const t = await open(a);
    expect(t.main().querySelector('.tile')!.className).toBe('tile unknown');
  });
});

describe('NEAR RPC tile', () => {
  it('one line per endpoint, each with its state; the critical scenario says every endpoint is down', async () => {
    const s = await open(answers.critical);
    const tile = [...s.main().querySelectorAll('.tile')].find((t) => t.querySelector('h3')!.textContent === 'NEAR RPC')!;
    expect(tile.querySelector('.state-chip')!.textContent).toBe('Critical');
    const rows = [...tile.querySelectorAll('.tile-lines li')].map((li) => [...li.children].map((x) => x.textContent));
    expect(rows.map((r) => r.slice(0, 2))).toEqual([['Critical', 'Primary'], ['Critical', 'Backup 1'], ['Critical', 'Backup 2']]);
    expect(rows[0]![2]).toMatch(/^Down: it /u);
  });

  it('a tile without lines renders none (every other tile)', async () => {
    const s = await open(answers.green);
    const lists = [...s.main().querySelectorAll('.tile-lines')];
    expect(lists).toHaveLength(1);
    expect(lists[0]!.closest('.tile')!.querySelector('h3')!.textContent).toBe('NEAR RPC');
  });
});

describe('safety', () => {
  it('text only: a hostile title stays text; a link that isn’t the console’s own path isn’t a link', async () => {
    const a = structuredClone(answers.warnings) as { issues: { title: string; link: unknown }[] };
    a.issues[0]!.title = '<img src=x onerror=alert(1)> <b>bold</b>';
    a.issues[0]!.link = { path: 'javascript:alert(1)', label: 'click' };
    a.issues[1]!.link = { path: 'https://evil.example/', label: 'away' };
    const s = await open(a);
    expect(s.main().querySelector('img, b')).toBeNull();
    expect(s.text()).toContain('<img src=x onerror=alert(1)>');
    for (const el of s.main().querySelectorAll('a')) expect(el.getAttribute('href')!.startsWith('/')).toBe(true);
    expect(s.text()).not.toContain('click');
  });

  it('read only: its one button reads again (a GET), nothing is written, no dialog', async () => {
    const s = await open(answers.green);
    expect(s.main().querySelectorAll('button').length).toBe(1);
    s.button('Check again').click();
    await vi.waitFor(() => expect(s.api().length).toBe(2));
    expect(s.api().every((c) => c.method === 'GET' && c.path === '/api/status')).toBe(true);
    expect(s.dialogs).toEqual([]);
  });

  it('a read from the cache says how old it is', async () => {
    const s = await open({ ...answers.green, cached: true, ageMs: 12_000, checkedAt: Date.now() - 12_000 });
    expect(s.text()).toMatch(/This is the read from 1\d s ago/u);
  });

  it('a failed read is said in plain words with its code', async () => {
    const s = boot('/', () => ({ status: 503, body: { error: { code: 'upstream_unavailable', message: 'A Hana service did not answer' } } }));
    await vi.waitFor(() => expect(s.text()).toContain('A Journear service didn’t answer'));
    expect(s.text()).toContain('upstream_unavailable');
  });
});
